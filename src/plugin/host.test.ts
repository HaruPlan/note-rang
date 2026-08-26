import { describe, it, expect, vi } from "vitest";
import {
  CALL_PERMISSIONS,
  CAPABILITY_CALLS,
  NO_PERMISSION_CALLS,
  PERMISSION_RESERVED,
  RESERVED_CALLS,
  bridgeError,
  contextUnavailableError,
  handleBridgeRequest,
  isExperimentalCall,
  isKnownCall,
  isReservedCall,
  invokeTargetOf,
  networkTargetOf,
  removedCallHint,
  requiredPermissionFor,
  requiresWindowContext,
  type BridgeRequest,
  type MemoCallError,
  type PluginRuntimeEnv,
} from "./host";
import {
  checkPermission,
  isKnownPermission,
  type PluginGrant,
} from "./permissions";
import { makeRegistrar } from "./loader";
import { executeWindowCall } from "./host-client";

const grant = (declared: string[], granted: string[] = []): PluginGrant => ({
  declared,
  granted,
});

describe("requiredPermissionFor", () => {
  /** 가드: 알려진 호출·미지의 호출 매핑. */
  it("maps known calls and rejects unknown calls", () => {
    expect(requiredPermissionFor("ui.addToolbarButton")).toBe("ui");
    expect(requiredPermissionFor("ui.toast")).toBe("ui");
    expect(requiredPermissionFor("ui.pickList")).toBe("ui");
    expect(requiredPermissionFor("ui.prompt")).toBe("ui");
    expect(requiredPermissionFor("theme.register")).toBe("theme");
    expect(requiredPermissionFor("notes.write")).toBe("notes:write");
    expect(requiredPermissionFor("notes.duplicate")).toBe("notes:write");
    // 옵션 초기화는 노트 사이드카 override를 다시 쓰므로 notes:write(민감) 게이트(복제와 동급).
    expect(requiredPermissionFor("notes.resetOptions")).toBe("notes:write");
    expect(requiredPermissionFor("notes.current")).toBe("notes:read");
    // 블록 임베드 "등록"은 editor 저위험 — 렌더는 embed:<domain> 게이트가 따로 막는다.
    expect(requiredPermissionFor("editor.registerBlockEmbed")).toBe("editor");
    expect(requiredPermissionFor("editor.getFontDelta")).toBe("editor");
    expect(requiredPermissionFor("editor.setFontDelta")).toBe("editor");
    // 커서 삽입은 본문을 쓰므로 editor 저위험이 아니라 notes:write(민감) 게이트.
    expect(requiredPermissionFor("editor.insertText")).toBe("notes:write");
    expect(requiredPermissionFor("clipboard.write")).toBe("clipboard");
    // embed.render 브리지 호출은 제거됨(호출자 0 — 렌더 게이트는 blockEmbedField가 수행).
    // 미지의 호출로 취급되어 fail-closed다.
    expect(requiredPermissionFor("embed.render")).toBeNull();
    expect(requiredPermissionFor("system.exec")).toBeNull();
  });
});

describe("handleBridgeRequest (게이트키퍼 강제)", () => {
  /** 가드: 허용된 호출만 executor로 라우팅되고 결과가 감싸진다. */
  it("routes an allowed call to the executor", async () => {
    const execute = vi.fn(async () => "ok");
    const req: BridgeRequest = {
      call: "ui.addToolbarButton",
      args: { label: "x" },
    };
    const res = await handleBridgeRequest(grant(["ui"]), req, execute);
    expect(res.ok).toBe(true);
    expect(res.result).toBe("ok");
    expect(execute).toHaveBeenCalledWith("ui.addToolbarButton", { label: "x" });
  });

  /** 가드(보안 핵심): 미선언 호출은 executor를 절대 호출하지 않는다. */
  it("NEVER calls the executor for an undeclared call", async () => {
    const execute = vi.fn(async () => "leaked");
    const res = await handleBridgeRequest(
      grant([]),
      { call: "notes.write", args: {} },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: 민감 권한이 선언만 되고 미부여면 실행 없이 거부. */
  it("denies a sensitive declared-but-not-granted call without executing", async () => {
    const execute = vi.fn();
    const res = await handleBridgeRequest(
      grant(["notes:read"]),
      { call: "notes.read" },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: 알 수 없는 호출은 실행 없이 거부. */
  it("denies an unknown call", async () => {
    const execute = vi.fn();
    const res = await handleBridgeRequest(
      grant(["ui"]),
      { call: "system.exec" },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("알 수 없는 호출");
    expect(execute).not.toHaveBeenCalled();
  });

  /** 이 실행이 능력 플러그인임을 알리는 env(theme.register가 kind 게이트를 통과하도록). */
  const capabilityEnv: PluginRuntimeEnv = {
    pluginId: "p",
    hostVersion: "0.1.0",
    os: "macos",
    reason: "reload",
    kind: "capability",
  };

  /** 가드: theme 선언 시 theme.register가 executor로 라우팅된다(kind는 capability). */
  it("routes theme.register when theme is declared", async () => {
    const execute = vi.fn(async () => null);
    const res = await handleBridgeRequest(
      grant(["theme"]),
      { call: "theme.register", args: { tokens: { accent: "#111111" } } },
      execute,
      capabilityEnv,
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("theme.register", {
      tokens: { accent: "#111111" },
    });
  });

  /** 가드(보안 핵심): theme 미선언이면 theme.register가 executor에 닿지 않는다
   *  (kind는 capability로 두어 kind 게이트가 아니라 권한 게이트가 막는 것을 본다). */
  it("NEVER calls the executor for theme.register when theme is undeclared", async () => {
    const execute = vi.fn(async () => "leaked");
    const res = await handleBridgeRequest(
      grant([]),
      { call: "theme.register", args: {} },
      execute,
      capabilityEnv,
    );
    expect(res.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: notes.current는 notes:read 부여 시 라우팅되고, 미부여면 실행 없이 거부. */
  it("gates notes.current behind notes:read", async () => {
    const execute = vi.fn(async () => ({ id: "n", path: "/v/notes/n.md" }));
    const ok = await handleBridgeRequest(
      grant(["notes:read"], ["notes:read"]),
      { call: "notes.current" },
      execute,
    );
    expect(ok.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("notes.current", {});

    const denied = await handleBridgeRequest(
      grant(["notes:read"]), // 선언만, 미부여
      { call: "notes.current" },
      vi.fn(async () => "leaked"),
    );
    expect(denied.ok).toBe(false);
  });

  /** 가드: editor.insertText는 notes:write 부여 시 라우팅되고, 선언만/미선언이면 실행 없이 거부. */
  it("gates editor.insertText behind notes:write", async () => {
    const execute = vi.fn(async () => null);
    const ok = await handleBridgeRequest(
      grant(["notes:write"], ["notes:write"]),
      { call: "editor.insertText", args: { text: "안녕", mode: "cursor" } },
      execute,
    );
    expect(ok.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("editor.insertText", {
      text: "안녕",
      mode: "cursor",
    });

    // 선언만 하고 미부여 → 거부(실행 없음).
    const denied = await handleBridgeRequest(
      grant(["notes:write"]),
      { call: "editor.insertText", args: { text: "x" } },
      vi.fn(async () => "leaked"),
    );
    expect(denied.ok).toBe(false);

    // editor만 선언해도 insertText엔 닿지 못한다(저위험 우회 차단).
    const wrongPerm = await handleBridgeRequest(
      grant(["editor"], ["editor"]),
      { call: "editor.insertText", args: { text: "x" } },
      vi.fn(async () => "leaked"),
    );
    expect(wrongPerm.ok).toBe(false);
  });

  /** 가드: clipboard.write는 clipboard 부여 시 텍스트를 executor로 넘긴다. */
  it("routes clipboard.write when clipboard is granted", async () => {
    const execute = vi.fn(async () => null);
    const res = await handleBridgeRequest(
      grant(["clipboard"], ["clipboard"]),
      { call: "clipboard.write", args: { text: "hi" } },
      execute,
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("clipboard.write", { text: "hi" });
  });

  /** 가드: executor가 던지면 오류 응답으로 감싼다(예외가 새지 않음).
   *  예시 호출은 ui.addMenuItem에서 ui.toast로 바꿨다 — ui.addMenuItem은 이제
   *  RESERVED_CALLS라 executor에 닿기 전에 거부돼 이 가드(오류 래핑)를 검증할 수 없다. */
  it("wraps executor errors as a failed response", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await handleBridgeRequest(
      grant(["ui"]),
      { call: "ui.toast" },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });
});

describe("브리지 오류의 안정 code", () => {
  /** 가드: 예약 호출과 알 수 없는 호출이 **문구가 아니라 코드로** 구분된다. */
  it("distinguishes reserved from unknown calls by code", async () => {
    const reserved = await handleBridgeRequest(
      grant(["vault:write"], ["vault:write"]),
      { call: "vault.write" }, // notes.write는 예약이 풀렸다 — 여전히 예약인 볼트 쓰기로 검증
      vi.fn(),
    );
    expect(reserved.code).toBe("RESERVED_CALL");

    const unknown = await handleBridgeRequest(
      grant(["ui"]),
      { call: "system.exec" },
      vi.fn(),
    );
    expect(unknown.code).toBe("UNKNOWN_CALL");
  });

  /** 가드: 권한 거부가 선언 누락/부여 누락으로 나뉜다(둘 다 예전엔 한국어 문구뿐이었다). */
  it("splits permission denials into undeclared and ungranted", async () => {
    const undeclared = await handleBridgeRequest(
      grant([]),
      { call: "ui.toast" },
      vi.fn(),
    );
    expect(undeclared.code).toBe("PERMISSION_UNDECLARED");

    const ungranted = await handleBridgeRequest(
      grant(["clipboard"]), // 선언만, 미부여
      { call: "clipboard.write" },
      vi.fn(),
    );
    expect(ungranted.code).toBe("PERMISSION_UNGRANTED");
  });

  /**
   * 가드: **없어진 호출**은 일반 오타와 다른 문구로 마이그레이션 방법을 알려 준다
   * (`RESERVED_CALLS` 가드와 대칭 — 그쪽이 "아직 없다", 이쪽이 "이제 없다").
   *
   * 왜 code는 그대로 `UNKNOWN_CALL`인가: 저작자가 분기할 대상이 아니라 **읽을 안내**다.
   * 새 `MemoErrorCode`를 만들면 생성물(api-reference의 오류 표)까지 늘어나는데, 런타임 처리는
   * 어차피 "그 호출은 없다"로 같다 — 달라져야 하는 것은 문구뿐이다. 도구 쪽에서 이 둘을
   * 갈라야 하는 CLI는 `removedCallHint`로 직접 판정한다(lint의 `REMOVED_CALL`).
   *
   * 이 테스트가 없으면 `REMOVED_CALLS` 표가 통째로 지워져도 어떤 가드도 울지 않는다 —
   * 남는 것은 `알 수 없는 호출: i18n.register` 한 줄이고, 저작자는 옮길 곳을 알 방법이 없다.
   */
  it("tells an author where a removed call went instead of calling it a typo", async () => {
    const execute = vi.fn(async () => "leaked");
    const res = await handleBridgeRequest(
      grant([]),
      { call: "i18n.register" },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("UNKNOWN_CALL");
    expect(res.error).toContain("없어진 호출");
    // 마이그레이션 대상을 **이름으로** 짚어 준다(이것이 안내의 전부다).
    expect(res.error).toContain("contributes.translations");
    expect(res.error).not.toContain("알 수 없는 호출");
    // 게이트 앞에서 끝난다 — 없는 호출이 수행부에 닿지 않는다(예약 호출과 같은 규칙).
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드(어휘 회귀): 없어진 이름이 "아는 호출"로 되살아나지 않는다 — 되살아나면 위
   * 안내가 조용히 사라지고 그 이름이 다시 게이트를 타게 된다. */
  it("keeps a removed call out of the known-call vocabulary", () => {
    expect(isKnownCall("i18n.register")).toBe(false);
    expect(isKnownCall("i18n.locale")).toBe(true); // 남아 있는 쪽은 그대로다.
  });

  /**
   * 가드: `removedCallHint`가 **CLI가 받는 계약 그대로** 동작한다(`isReservedCall`과 같은 결의
   * 조회 헬퍼).
   *
   * 왜 브리지 응답과 따로 보는가: `memo-plugin lint`는 `handleBridgeRequest`를 타지 않고 이
   * 함수만 받아 정적 스캔에서 판정한다(`host-bridge.ts`의 contract). 그래서 이 함수가
   * 조용히 망가지면 **런타임 안내는 멀쩡한데 lint만** 옛 이름을 오타로 오인하는, 표면마다
   * 다른 말을 하는 상태가 된다 — 브리지 어서션만으로는 그 갈라짐을 못 잡는다.
   */
  it("exposes the migration hint as a lookup the CLI can reuse", () => {
    expect(removedCallHint("i18n.register")).toContain(
      "contributes.translations",
    );
    // 살아 있는 호출·예약 호출·오타에는 안내가 없다(있으면 동작하는 API에 "없어졌다"고 말한다).
    expect(removedCallHint("ui.toast")).toBeUndefined();
    expect(removedCallHint("vault.write")).toBeUndefined();
    expect(removedCallHint("ui.toats")).toBeUndefined();
  });

  /**
   * 가드(드리프트): 코드 판정이 [`checkPermission`]의 사람용 문구와 **같은 결론**을 낸다.
   *
   * 왜: `checkPermission`은 이 담당의 소유가 아니라 반환형에 code를 넣지 못했다 — host.ts가
   * 같은 규칙을 다시 평가한다. 두 판정이 갈라지면(권한 모델이 바뀌었는데 한쪽만 따라감)
   * 여기서 잡는다. 문자열 매칭은 이 가드 **한 곳**에만 있고 프로덕션 코드에는 없다.
   */
  it("agrees with checkPermission's human-readable reason", async () => {
    const cases: { call: string; grant: PluginGrant }[] = [
      { call: "ui.toast", grant: grant([]) },
      { call: "clipboard.write", grant: grant(["clipboard"]) },
      { call: "editor.insertText", grant: grant(["editor"], ["editor"]) },
      { call: "notes.current", grant: grant(["notes:read"]) },
    ];
    for (const { call, grant: g } of cases) {
      const required = requiredPermissionFor(call);
      expect(required, call).not.toBeNull();
      const decision = checkPermission(g, required as string);
      expect(decision.allowed, call).toBe(false);
      const res = await handleBridgeRequest(g, { call }, vi.fn());
      const expected = decision.reason?.startsWith("알 수 없는 권한")
        ? "PERMISSION_UNKNOWN"
        : decision.reason?.startsWith("미선언 권한")
          ? "PERMISSION_UNDECLARED"
          : "PERMISSION_UNGRANTED";
      expect(res.code, `${call} → ${decision.reason}`).toBe(expected);
      // 사람용 문구는 그대로다 — 문구를 보던 UI·테스트가 깨지지 않는다(100% 하위호환).
      expect(res.error).toBe(decision.reason);
    }
  });

  /**
   * 가드: `PERMISSION_UNKNOWN`이 지금 도달 불가능한 이유를 못박는다 — 매핑표의 모든 값이
   * 아는 권한이기 때문이다. 표에 오타 권한이 들어오는 순간 이 가드가 먼저 깨진다.
   */
  it("keeps every CALL_PERMISSIONS value a known permission", () => {
    const unknown = Object.entries(CALL_PERMISSIONS).filter(
      ([, permission]) => !isKnownPermission(permission),
    );
    expect(unknown).toEqual([]);
  });

  /** 가드: 실행부가 던진 코드는 응답에 그대로 실리고, 코드 없는 예외는 code를 아예 안 싣는다
   *  ("호스트가 분류한 오류"와 "아직 분류 안 된 오류"를 응답 수준에서 구분). */
  it("carries an executor's code and omits it when there is none", async () => {
    const coded = await handleBridgeRequest(
      grant(["editor"]),
      { call: "editor.registerBlockEmbed" },
      async () => {
        throw bridgeError("INVALID_ARGS", "잘못됨");
      },
    );
    expect(coded).toEqual({ ok: false, code: "INVALID_ARGS", error: "잘못됨" });

    const bare = await handleBridgeRequest(
      grant(["ui"]),
      { call: "ui.toast" },
      async () => {
        throw new Error("boom");
      },
    );
    expect(bare).toEqual({ ok: false, error: "boom" });
  });
});

describe("무권한 네임스페이스 memo.runtime.*", () => {
  /** 가드(핵심): runtime.info는 **아무 권한도 선언하지 않은** 플러그인에게도 응답한다 —
   *  권한을 얻기 전에는 자기 환경도 못 묻는 순환을 만들지 않기 위함. */
  it("answers runtime.info without any declared permission", async () => {
    const execute = vi.fn();
    const res = await handleBridgeRequest(
      grant([]),
      { call: "runtime.info" },
      execute,
    );
    expect(res.ok).toBe(true);
    // 게이트 앞에서 호스트가 직접 처리한다 — executor에 닿지 않는다.
    expect(execute).not.toHaveBeenCalled();
    expect(res.result).toMatchObject({
      declared: [],
      granted: [],
    });
  });

  /** 가드: 자기 자신의 선언·부여 집합을 그대로 돌려준다(다른 플러그인의 부여는 실리지 않는다). */
  it("reports the plugin's own declared and granted sets", async () => {
    const res = await handleBridgeRequest(
      grant(["ui", "clipboard"], ["clipboard"]),
      { call: "runtime.info" },
      vi.fn(),
    );
    expect(res.result).toMatchObject({
      declared: ["ui", "clipboard"],
      granted: ["clipboard"],
    });
  });

  /** 가드: 호스트가 주입한 실행 환경(플러그인 id·앱 버전·OS·사유)이 그대로 실린다. */
  it("passes the injected runtime environment through", async () => {
    const env: PluginRuntimeEnv = {
      pluginId: "template",
      hostVersion: "0.1.0",
      os: "macos",
      reason: "install",
    };
    const res = await handleBridgeRequest(
      grant(["ui"]),
      { call: "runtime.info" },
      vi.fn(),
      env,
    );
    expect(res.result).toMatchObject({
      pluginId: "template",
      hostVersion: "0.1.0",
      os: "macos",
      reason: "install",
    });
  });

  /** 가드: runtime.log는 권한 없이 통과하고 메시지를 상한(2KB)으로 자른다 —
   *  노트 본문이 통째로 진단 채널에 실려 나가지 않게. */
  it("accepts runtime.log without permission and caps the message", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await handleBridgeRequest(
      grant([]),
      { call: "runtime.log", args: { message: "가".repeat(5000) } },
      vi.fn(),
    );
    expect(res).toEqual({ ok: true, result: null });
    expect(String(info.mock.calls[0]?.[2] ?? "")).toHaveLength(2000);
    info.mockRestore();
  });

  /** 가드: runtime.ready가 호스트에 도달해도(부트스트랩이 가로채는 게 정상) 오류가 아니다. */
  it("treats a stray runtime.ready as a harmless no-op", async () => {
    const res = await handleBridgeRequest(
      grant([]),
      { call: "runtime.ready" },
      vi.fn(),
    );
    expect(res).toEqual({ ok: true, result: null });
  });

  /** 가드: 무권한 호출은 권한 매핑표에 들어가지 않는다(그 표의 드리프트 가드 의미를 흐리지
   *  않기 위함). 대신 `isKnownCall`이 두 어휘를 합쳐 "아는 이름"의 단일 출처가 된다. */
  it("keeps runtime calls out of CALL_PERMISSIONS but inside isKnownCall", () => {
    for (const call of NO_PERMISSION_CALLS) {
      expect(call in CALL_PERMISSIONS, call).toBe(false);
      expect(requiredPermissionFor(call), call).toBeNull();
      expect(isKnownCall(call), call).toBe(true);
    }
    expect(isKnownCall("ui.toast")).toBe(true);
    expect(isKnownCall("system.exec")).toBe(false);
  });
});

describe("축 2 — memo.i18n.locale(무권한)", () => {
  /** 가드(핵심): i18n.locale은 **아무 권한도 선언하지 않은** 플러그인에게도 응답하고,
   *  runtime.info와 같은 자리(게이트 앞)에서 처리돼 executor에 닿지 않는다. */
  it("answers with the injected locale without any declared permission", async () => {
    const execute = vi.fn();
    const env: PluginRuntimeEnv = {
      pluginId: "template",
      hostVersion: "0.1.0",
      os: "macos",
      reason: "reload",
      locale: "en",
    };
    const res = await handleBridgeRequest(
      grant([]),
      { call: "i18n.locale" },
      execute,
      env,
    );
    expect(res).toEqual({ ok: true, result: "en" });
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: env가 없거나 env.locale이 없으면 "ko"로 폴백한다(값을 지어내지 않되, 미제공을
   *  빈 문자열/undefined로 흘리지 않는다 — 문서화된 기본값). */
  it("falls back to ko when env or env.locale is missing", async () => {
    const withoutEnv = await handleBridgeRequest(
      grant([]),
      { call: "i18n.locale" },
      vi.fn(),
    );
    expect(withoutEnv).toEqual({ ok: true, result: "ko" });

    const withoutLocale = await handleBridgeRequest(
      grant([]),
      { call: "i18n.locale" },
      vi.fn(),
      { pluginId: "x", hostVersion: "", os: "", reason: "reload" },
    );
    expect(withoutLocale).toEqual({ ok: true, result: "ko" });
  });

  /** 가드: i18n.locale도 다른 무권한 호출과 같은 어휘 관례를 따른다(CALL_PERMISSIONS 밖,
   *  isKnownCall 안) — 무권한 네임스페이스 가드와 같은 불변식.*/
  it("is a NO_PERMISSION_CALLS member", () => {
    expect(NO_PERMISSION_CALLS.has("i18n.locale")).toBe(true);
    expect("i18n.locale" in CALL_PERMISSIONS).toBe(false);
    expect(requiredPermissionFor("i18n.locale")).toBeNull();
  });
});

describe("requireWindow(창 컨텍스트 필수 선언)", () => {
  /** 가드: 옵트인 플래그는 `true`일 때만 켜진다(문자열·누락은 기존 폴백 그대로). */
  it("opts in only on an explicit true", () => {
    expect(requiresWindowContext({ requireWindow: true })).toBe(true);
    expect(requiresWindowContext({ requireWindow: "true" })).toBe(false);
    expect(requiresWindowContext({})).toBe(false);
  });

  /** 가드: 컨텍스트 부재 거부는 안정 코드를 달고 호출 이름을 문구에 남긴다 —
   *  지금까지 성공(ok:true, result:null)과 구분되지 않던 무음 실패의 대체물이다. */
  it("builds a coded CONTEXT_UNAVAILABLE rejection", () => {
    const err: MemoCallError = contextUnavailableError("ui.toast");
    expect(err).toBeInstanceOf(Error); // 기존 오류 처리 경로가 그대로 먹는다.
    expect(err.code).toBe("CONTEXT_UNAVAILABLE");
    expect(err.message).toContain("ui.toast");
  });
});

describe("notes.resetOptions", () => {
  /** 가드: 복수형 정본만 존재하고 notes:write 게이트를 탄다(단수 별칭은 제거됨). */
  it("maps notes.resetOptions to notes:write", () => {
    expect(requiredPermissionFor("notes.resetOptions")).toBe("notes:write");
    expect(requiredPermissionFor("note.resetOptions")).toBeNull();
  });
});

describe("kind 게이트(능력 등록은 capability 플러그인만)", () => {
  /** 이 실행의 정체(게이트 입력) — 종류만 바꿔 가며 쓴다. */
  const env = (over: Partial<PluginRuntimeEnv> = {}): PluginRuntimeEnv => ({
    pluginId: "p",
    hostVersion: "0.1.0",
    os: "macos",
    reason: "reload",
    ...over,
  });

  /** 가드(핵심): 액션 플러그인의 능력 등록은 executor에 **닿지 않는다** — 예전엔 게이트도
   *  registrar도 통과한 뒤 조립 단계에서 결과만 버려져, 저작자는 성공 응답을 받고 아무 일도
   *  일어나지 않았다(이 잡으려던 무음 실패). */
  it.each([...CAPABILITY_CALLS])(
    "rejects %s from an action plugin before the executor",
    async (call) => {
      const execute = vi.fn(async () => "leaked");
      const res = await handleBridgeRequest(
        grant([CALL_PERMISSIONS[call]], [CALL_PERMISSIONS[call]]),
        { call },
        execute,
        env({ kind: "action" }),
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe("WRONG_PLUGIN_KIND");
      expect(res.error).toContain(call);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  /** 가드: capability로 선언한 플러그인은 통과한다. */
  it("lets a capability plugin register a capability", async () => {
    const execute = vi.fn(async () => ({ id: "x" }));
    const res = await handleBridgeRequest(
      grant(["theme"], ["theme"]),
      { call: "theme.register", args: { tokens: {} } },
      execute,
      env({ kind: "capability" }),
    );
    expect(res).toEqual({ ok: true, result: { id: "x" } });
  });

  /** 가드(엄격): `kind`를 선언하지 않으면(또는 env 자체가 없으면) 능력 등록은 거부된다 —
   *  미선언 관용을 없앴다. 능력 등록에는 `kind: "capability"`가 필수다. */
  it("rejects capability registration when kind is undeclared", async () => {
    const execute = vi.fn(async () => ({ id: "x" }));
    for (const e of [undefined, env()]) {
      const res = await handleBridgeRequest(
        grant(["font"], ["font"]),
        { call: "font.register", args: { families: [] } },
        execute,
        e,
      );
      expect(res.ok, String(e)).toBe(false);
      expect(res.code, String(e)).toBe("WRONG_PLUGIN_KIND");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드(순서): kind 판정이 권한 판정보다 **먼저**다. 뒤에 두면 권한을 안 적은 액션
   *  플러그인이 PERMISSION_UNDECLARED를 받고, 권한을 채워 넣은 뒤에야 진짜 원인을 만난다. */
  it("reports the kind mismatch instead of a missing permission", async () => {
    const res = await handleBridgeRequest(
      grant([]), // theme 권한을 선언조차 하지 않았다.
      { call: "theme.register", args: { tokens: {} } },
      vi.fn(),
      env({ kind: "action" }),
    );
    expect(res.code).toBe("WRONG_PLUGIN_KIND");
  });

  /** 가드: 능력이 아닌 호출은 액션 플러그인이 그대로 쓴다(게이트가 넓게 물지 않는다). */
  it("does not gate non-capability calls", async () => {
    const execute = vi.fn(async () => null);
    const res = await handleBridgeRequest(
      grant(["ui"], ["ui"]),
      { call: "ui.toast", args: { title: "hi" } },
      execute,
      env({ kind: "action" }),
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  /** 가드: 능력 호출 어휘가 권한 표 안에 있고 예약이 아니다(게이트가 죽은 이름을 막는
   *  헛수고가 되지 않게). */
  it("keeps every capability call live in the permission table", () => {
    for (const call of CAPABILITY_CALLS) {
      expect(requiredPermissionFor(call), call).not.toBeNull();
      expect(isReservedCall(call), call).toBe(false);
    }
  });
});

describe("RESERVED_CALLS / PERMISSION_RESERVED (미구현 표시)", () => {
  /** 가드(보안 핵심): 예약 호출은 executor에 닿지 않고, "미구현"과 "알 수 없는 호출"이
   *  다른 오류 문구로 구분된다(권한은 선언+부여돼 있어도 예약이면 거부). */
  it("rejects a reserved call before it reaches the executor, with a distinct message", async () => {
    const execute = vi.fn(async () => "leaked");
    const res = await handleBridgeRequest(
      { declared: ["vault:write"], granted: ["vault:write"] },
      { call: "vault.write" }, // 권한은 선언+부여됐지만 호출 자체가 예약(미구현)
      execute,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("예약 호출");
    expect(res.error).not.toContain("알 수 없는 호출");
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: isReservedCall과 RESERVED_CALLS 멤버십이 일치한다. */
  it("isReservedCall matches RESERVED_CALLS membership", () => {
    expect(isReservedCall("vault.write")).toBe(true);
    expect(isReservedCall("notes.write")).toBe(false); // 예약 해제
    expect(isReservedCall("ui.addMenuItem")).toBe(false); // 예약 해제
    expect(isReservedCall("notes.current")).toBe(false);
    for (const call of RESERVED_CALLS) {
      expect(isReservedCall(call)).toBe(true);
    }
  });

  /**
   * 가드: 완전히 죽은 권한이 정확히 export된다(설치 승인 UI의 "(예약)" 배지용).
   *
   * `commands`는 여기서 빠졌다 — 이 집합에서 빠지는 순간이 pendingReserved의
   * 재승인 방아쇠이므로, 목록을 줄일 때는 그 연쇄가 의도된 것인지 확인하고 줄여야 한다.
   */
  it("exposes exactly the fully-dead permissions", () => {
    expect(new Set(PERMISSION_RESERVED)).toEqual(
      new Set(["vault:read", "vault:write"]),
    );
  });
});

describe("network.fetch 게이트(network:<호스트> 접두 권한)", () => {
  /** 가드: networkTargetOf가 https URL의 호스트를 소문자로 뽑아 network:<호스트> 권한을 만든다. */
  it("networkTargetOf가 호스트에서 권한을 파생한다(https·소문자·IPv6)", () => {
    expect(networkTargetOf("https://API.Example.com/v1/x")).toEqual({
      ok: true,
      host: "api.example.com",
      permission: "network:api.example.com",
    });
    // 포트가 있어도 호스트만 본다(권한은 호스트 단위).
    expect(networkTargetOf("https://api.example.com:8443/x")).toMatchObject({
      ok: true,
      host: "api.example.com",
    });
    // IPv6 리터럴은 대괄호째 호스트다(백엔드가 사설대역을 다시 막는다).
    expect(networkTargetOf("https://[2606:4700::1111]/x")).toMatchObject({
      ok: true,
      host: "[2606:4700::1111]",
    });
  });

  /** 가드: https가 아니거나 파싱 불가·비문자열은 권한 판정 전에 코드 붙은 거부다. */
  it("networkTargetOf가 스킴·형식 위반을 코드로 거부한다", () => {
    expect(networkTargetOf("http://api.example.com/")).toMatchObject({
      ok: false,
      code: "NETWORK_SCHEME",
    });
    expect(networkTargetOf("ftp://api.example.com/")).toMatchObject({
      ok: false,
      code: "NETWORK_SCHEME",
    });
    expect(networkTargetOf("not a url")).toMatchObject({
      ok: false,
      code: "NETWORK_INVALID_URL",
    });
    expect(networkTargetOf(undefined)).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
    expect(networkTargetOf("")).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
  });

  /** 가드: 더 이상 예약이 아니고, 대표 권한이 민감(network: 접두)이다. */
  it("network.fetch는 예약이 아니고 민감 권한을 요구한다", () => {
    expect(isReservedCall("network.fetch")).toBe(false);
    expect(isKnownCall("network.fetch")).toBe(true);
    expect(requiredPermissionFor("network.fetch")).toBe("network:<도메인>");
    expect(PERMISSION_RESERVED.has("network")).toBe(false);
  });
});

describe("commands.invoke 게이트(invoke:<대상> 유도 권한)", () => {
  const grant = (declared: string[], granted: string[] = []): PluginGrant => ({
    declared,
    granted,
  });

  /** 가드: invokeTargetOf가 pluginId·commandId에서 invoke:<대상> 권한을 파생한다. */
  it("invokeTargetOf가 인자에서 권한을 파생한다", () => {
    expect(invokeTargetOf({ pluginId: "b", commandId: "cmd1" })).toEqual({
      ok: true,
      targetId: "b",
      commandId: "cmd1",
      permission: "invoke:b",
    });
  });

  /** 가드: pluginId·commandId 누락은 권한 판정 전에 INVALID_ARGS로 거부다. */
  it("invokeTargetOf가 형식 위반을 코드로 거부한다", () => {
    expect(invokeTargetOf({ commandId: "x" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
    expect(invokeTargetOf({ pluginId: "b" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
    expect(invokeTargetOf({ pluginId: "", commandId: "x" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
  });

  /** 가드: 대표 권한이 민감(invoke: 접두)이고 예약이 아니다. */
  it("commands.invoke는 예약이 아니고 민감 유도 권한을 요구한다", () => {
    expect(isReservedCall("commands.invoke")).toBe(false);
    expect(isKnownCall("commands.invoke")).toBe(true);
    expect(requiredPermissionFor("commands.invoke")).toBe("invoke:<pluginId>");
  });

  /** 가드(핵심): 게이트키퍼가 인자 pluginId에서 invoke:<대상>을 파생해 검사한다 —
   * 미선언은 PERMISSION_UNDECLARED, 선언·미부여는 PERMISSION_UNGRANTED, 통과는 executor로. */
  it("게이트키퍼가 invoke:<대상>으로 선언∩부여를 강제한다", async () => {
    const execute = vi.fn(async () => null);
    // 미선언: 다른 대상을 부르면 그 대상 권한이 없다.
    const undeclared = await handleBridgeRequest(
      grant(["invoke:b"], ["invoke:b"]),
      { call: "commands.invoke", args: { pluginId: "other", commandId: "x" } },
      execute,
    );
    expect(undeclared).toMatchObject({
      ok: false,
      code: "PERMISSION_UNDECLARED",
    });
    // 선언했지만 미부여(민감).
    const ungranted = await handleBridgeRequest(
      grant(["invoke:b"], []),
      { call: "commands.invoke", args: { pluginId: "b", commandId: "x" } },
      execute,
    );
    expect(ungranted).toMatchObject({
      ok: false,
      code: "PERMISSION_UNGRANTED",
    });
    // 형식 오류는 권한 판정 전에 INVALID_ARGS(executor를 부르지 않는다).
    const bad = await handleBridgeRequest(
      grant(["invoke:b"], ["invoke:b"]),
      { call: "commands.invoke", args: { pluginId: "b" } },
      execute,
    );
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(execute).not.toHaveBeenCalled();
    // 선언∩부여 통과 → executor로 넘어간다.
    const ok = await handleBridgeRequest(
      grant(["invoke:b"], ["invoke:b"]),
      { call: "commands.invoke", args: { pluginId: "b", commandId: "x" } },
      execute,
    );
    expect(ok.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("commands.invoke", {
      pluginId: "b",
      commandId: "x",
    });
  });

  /** 가드: commands.invoke는 실험적으로 표식돼 있다(실행 시 진단 경고의 어휘 원천). */
  it("commands.invoke는 experimental로 표식된다", () => {
    expect(isExperimentalCall("commands.invoke")).toBe(true);
    expect(isExperimentalCall("commands.register")).toBe(false);
    expect(isExperimentalCall("ui.toast")).toBe(false);
  });

  /** 가드(핵심): 선언+부여된 정확 호스트에만 통과하고 executor에 넘어간다. */
  it("선언·부여된 호스트로만 통과한다", async () => {
    const execute = vi.fn(async () => ({ status: 200, headers: [], body: "" }));
    const res = await handleBridgeRequest(
      grant(["network:api.example.com"], ["network:api.example.com"]),
      { call: "network.fetch", args: { url: "https://api.example.com/v1" } },
      execute,
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  /** 가드(보안 핵심): 다른 호스트를 선언·부여해도 URL 호스트가 다르면 미선언으로 거부되고
   * executor에 닿지 않는다(도메인 승인이 호스트 단위임을 강제). */
  it("선언한 호스트와 URL 호스트가 다르면 거부한다(executor 미도달)", async () => {
    const execute = vi.fn(async () => ({ status: 200, headers: [], body: "" }));
    const res = await handleBridgeRequest(
      grant(["network:other.com"], ["network:other.com"]),
      { call: "network.fetch", args: { url: "https://api.example.com/v1" } },
      execute,
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNDECLARED");
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: 선언은 했지만 미부여면 UNGRANTED, executor 미도달. */
  it("선언했지만 미부여면 UNGRANTED다", async () => {
    const execute = vi.fn(async () => ({ status: 200, headers: [], body: "" }));
    const res = await handleBridgeRequest(
      grant(["network:api.example.com"], []),
      { call: "network.fetch", args: { url: "https://api.example.com/v1" } },
      execute,
    );
    expect(res.code).toBe("PERMISSION_UNGRANTED");
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드(심층 방어): https가 아닌 URL은 **권한을 갖췄어도** 게이트키퍼가 먼저 스킴으로 막고
   * executor에 넘기지 않는다(백엔드가 또 막지만 프론트가 1차 관문). */
  it("https가 아니면 권한과 무관하게 스킴으로 거부한다", async () => {
    const execute = vi.fn(async () => ({ status: 200, headers: [], body: "" }));
    const res = await handleBridgeRequest(
      grant(["network:api.example.com"], ["network:api.example.com"]),
      { call: "network.fetch", args: { url: "http://api.example.com/v1" } },
      execute,
    );
    expect(res.code).toBe("NETWORK_SCHEME");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("CALL_PERMISSIONS 분할 가드 — 구현됨 ∪ RESERVED_CALLS", () => {
  // central-host.ts(비소유 파일)가 직접 처리하는 호출 — settings.get/set은 로컬
  // 스냅샷/영속화로, ui.addToolbarButton은 버튼 직렬화 수집으로 makeHostExecutor에서
  // 바로 처리되고 registrar나 executeWindowCall에는 도달하지 않는다. 이 세 이름은
  // 여기서 하드코딩한다 — central-host.ts가 바뀌어 이 목록과 실제 처리 호출이
  // 어긋나도(드리프트) 이 테스트는 잡아내지 못한다(그 파일은 이 담당의 소유가 아니라
  // 읽기만 했다).
  const CENTRAL_HOST_DIRECT_CALLS = new Set([
    "settings.get",
    "settings.getAll",
    "settings.set",
    "ui.addToolbarButton",
    // 상태 아이템 등록도 makeHostExecutor가 버튼처럼 직접 수집한다(statusItems 맵) —
    // registrar나 executeWindowCall에는 도달하지 않는다. 갱신(ui.updateStatusItem)은 반대로
    // 창-스코프라 executeWindowCall이 인식하므로 여기 두지 않는다(windowCallImplements가 덮는다).
    "ui.addStatusItem",
    // events.on도 makeHostExecutor가 직접 처리한다(구독 맵에 수집). registrar나
    // executeWindowCall에는 도달하지 않는다.
    "events.on",
    // commands.register도 같은 자리에서 명령 맵에 수집된다 — 실행은 스냅샷을 본
    // 노트 창 키맵이 되쏘는 역호출이라 registrar·창-스코프 어느 쪽도 아니다.
    "commands.register",
    // 저장소 4종은 makeHostExecutor가 스코프별로 직접 처리한다: local은 Rust IPC
    // 백엔드로, session·window는 호스트 프로세스 메모리로 간다.
    "storage.get",
    "storage.set",
    "storage.remove",
    "storage.getAll",
    // 전체 노트 읽기도 makeHostExecutor가 직접 처리한다 — 호스트 스코프(Rust
    // `note_list`/`note_read` IPC 재사용). registrar·창-스코프 어느 쪽도 아니다.
    "notes.list",
    "notes.read",
    // 임의 노트 직접 쓰기(과 함께 예약 해제)도 makeHostExecutor가 직접 처리한다 —
    // 호스트 스코프(Rust `note_write` IPC). registrar·창-스코프 어느 쪽도 아니다.
    "notes.write",
    // 메뉴 전용 항목 등록도 makeHostExecutor가 직접 수집한다(명령·버튼과 같은 자리) —
    // 실행은 스냅샷을 본 노트 창이 되쏘는 역호출이라 registrar·창-스코프 어느 쪽도 아니다.
    "ui.addMenuItem",
    // 선택 액션 등록도 makeHostExecutor가 직접 수집한다(selectionActions 맵) — 실행은
    // 스냅샷을 본 노트 창(선택 툴바·단축키)이 되쏘는 역호출이라 registrar·창-스코프 어느
    // 쪽도 아니다(메뉴 항목과 같은 자리·같은 이유).
    "ui.addSelectionAction",
    // 메뉴바 트레이 항목 등록도 makeHostExecutor가 직접 수집한다(trayItems 맵) — 실제
    // 트레이는 네이티브(Rust)가 그리고, 클릭은 EV_TRAY_INVOKE로 호스트에 되쏘는 역호출이라
    // registrar·창-스코프 어느 쪽도 아니다(호스트 스코프 — 창 컨텍스트 없음).
    "ui.addTrayItem",
    // 네트워크 중계도 makeHostExecutor가 직접 처리한다 — 호스트 스코프(Rust `net_fetch`
    // IPC). registrar·창-스코프 어느 쪽도 아니다.
    "network.fetch",
    // 플러그인 간 명령 호출도 makeHostExecutor가 직접 처리한다 — 중앙 호스트가 대상의
    // 등록된 명령을 역호출하는 릴레이라 registrar·창-스코프 어느 쪽도 아니다.
    "commands.invoke",
    // 브라우저 열기도 makeHostExecutor가 직접 처리한다 — 호스트 스코프(Rust
    // `open_external_url` IPC). 앱 밖 탐색이라 창 컨텍스트가 필요 없다.
    "browser.open",
  ]);

  /** registrar(makeRegistrar().execute)가 인식하면 true — "지원하지 않는 호출" 접두
   *  오류만 미구현 신호로 보고, 그 외 오류(예: 잘못된 인자 형식)는 구현됨으로 본다. */
  async function registrarImplements(call: string): Promise<boolean> {
    const registrar = makeRegistrar("guard");
    try {
      await registrar.execute(call, {});
      return true;
    } catch (e) {
      return !(
        e instanceof Error && e.message.startsWith("지원하지 않는 호출")
      );
    }
  }

  /** executeWindowCall이 인식하면 true — "지원하지 않는 창-스코프 호출" 접두 오류만
   *  미구현 신호로 본다. */
  async function windowCallImplements(call: string): Promise<boolean> {
    const services = {
      // 토스트 서비스는 발급된 id를 돌려준다 — null은 "모르는 id"라는 실패 신호다.
      showToast: () => "t1",
      // 상태 아이템 갱신도 발급된 id를 돌려준다 — null은 "이 창에 없는 id" 실패 신호다.
      updateStatusItem: () => "s1",
      getFontDelta: () => 0,
      setFontDelta: () => 0,
      insertText: () => {},
      writeClipboard: async () => {},
      currentNote: () => null,
      duplicateNote: async () => {},
      resetOptions: () => {},
      pickList: async () => null,
      prompt: async () => null,
    };
    try {
      await executeWindowCall(services, call, {});
      return true;
    } catch (e) {
      return !(
        e instanceof Error &&
        e.message.startsWith("지원하지 않는 창-스코프 호출")
      );
    }
  }

  /** 가드(핵심): CALL_PERMISSIONS의 각 키는 예약이거나 (셋 중 하나의) 실행기가 인식하는
   *  구현됨이어야 하며, 둘 다이거나 둘 다 아니면 드리프트다(신규 호출을 추가하고 예약/구현
   *  어느 쪽에도 반영하지 않은 경우를 잡는다). it.each로 실패 시 어떤 호출인지 바로 보인다. */
  it.each(Object.keys(CALL_PERMISSIONS))(
    "%s is exactly reserved xor implemented",
    async (call) => {
      const reserved = isReservedCall(call);
      const implemented =
        CENTRAL_HOST_DIRECT_CALLS.has(call) ||
        (await registrarImplements(call)) ||
        (await windowCallImplements(call));
      expect(reserved).not.toBe(implemented);
    },
  );

  /** 가드: 표의 키 개수가 예약 집합과 정확히 겹치지 않고 합집합으로 표를 덮는다(전체 카운트
   *  체크 — 위 it.each가 개별로 이미 보장하지만, 합집합 크기로 한 번 더 교차 검증한다). */
  it("RESERVED_CALLS ∪ implemented-call-set covers CALL_PERMISSIONS with no overlap", async () => {
    const keys = Object.keys(CALL_PERMISSIONS);
    const reservedKeys = keys.filter((c) => isReservedCall(c));
    const implementedKeys = keys.filter((c) => !isReservedCall(c));
    for (const call of implementedKeys) {
      const implemented =
        CENTRAL_HOST_DIRECT_CALLS.has(call) ||
        (await registrarImplements(call)) ||
        (await windowCallImplements(call));
      expect(implemented).toBe(true);
    }
    expect(reservedKeys.length + implementedKeys.length).toBe(keys.length);
    expect(new Set(reservedKeys)).toEqual(new Set([...RESERVED_CALLS]));
  });
});

describe("commands·storage 게이트", () => {
  /**
   * 가드(재승인 연쇄): `commands.register`가 예약에서 풀렸다.
   *
   * 이 두 사실(호출이 예약 아님 + 권한이 완전 사망 아님)이 함께 성립해야 재승인 흐름이
   * 켜진다 — `PERMISSION_RESERVED`에서 빠진 권한만 재승인 목록에 오르기 때문이다.
   */
  it("commands.register는 더 이상 예약이 아니다", async () => {
    expect(isReservedCall("commands.register")).toBe(false);
    expect(PERMISSION_RESERVED.has("commands")).toBe(false);
    const execute = vi.fn(async () => ({ id: "c" }));
    const res = await handleBridgeRequest(
      { declared: ["commands"], granted: [] },
      { call: "commands.register", args: { title: "T" } },
      execute,
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  /** 가드: 명령은 저위험 `commands` 하나로 통과하고, 미선언이면 실행부에 닿지 않는다. */
  it("commands 권한을 선언하지 않으면 실행부에 닿지 않는다", async () => {
    const execute = vi.fn(async () => null);
    const res = await handleBridgeRequest(
      { declared: [], granted: [] },
      { call: "commands.register", args: { title: "T" } },
      execute,
    );
    expect(res.code).toBe("PERMISSION_UNDECLARED");
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: 저장소 4종이 전부 저위험 `storage` 하나로 게이트된다(스코프별로 갈리지 않는다) —
   * 스코프가 나누는 축은 권한이 아니라 수명이다. */
  it("저장소 4종은 전부 저위험 storage 권한으로 게이트된다", async () => {
    for (const call of [
      "storage.get",
      "storage.set",
      "storage.remove",
      "storage.getAll",
    ]) {
      expect(requiredPermissionFor(call)).toBe("storage");
      const execute = vi.fn(async () => null);
      // 저위험이라 **선언만으로** 통과한다(사용자 부여를 요구하지 않는다).
      const ok = await handleBridgeRequest(
        { declared: ["storage"], granted: [] },
        { call, args: {} },
        execute,
      );
      expect(ok.ok, call).toBe(true);
      const denied = await handleBridgeRequest(
        { declared: [], granted: [] },
        { call, args: {} },
        vi.fn(async () => null),
      );
      expect(denied.code, call).toBe("PERMISSION_UNDECLARED");
    }
  });
});

describe("notes:all-read 게이트", () => {
  /**
   * 가드(재승인 연쇄): `notes.list`/`notes.read`가 예약에서 풀렸고, 그 권한은 기존
   * `notes:read`가 아니라 **신설 민감 권한** `notes:all-read`다.
   *
   * 재승인 경로의 실제 범위도 여기서 못박는다: 이 해제는 재승인을 **태우지 않는 것이
   * 정상이다** — `notes:all-read`는 태어날 때부터 `PERMISSION_RESERVED`에 없어서(승인 즉시
   * 부여 가능), 예약 시절에 이 권한을 pendingReserved로 보류해 둔 설치가 존재할 수 없다
   * (구버전 앱은 미지 권한으로 설치 자체를 거부했다). 재승인이 도는 쪽은 install-flow.test.ts의
   * grantsForApproval/pendingReservedForApproval 가드가 확인한다.
   */
  it("notes.list/notes.read는 더 이상 예약이 아니고 notes:all-read로 게이트된다", async () => {
    for (const call of ["notes.list", "notes.read"]) {
      expect(isReservedCall(call), call).toBe(false);
      expect(requiredPermissionFor(call), call).toBe("notes:all-read");
    }
    expect(PERMISSION_RESERVED.has("notes:all-read")).toBe(false);
    const execute = vi.fn(async () => []);
    const res = await handleBridgeRequest(
      grant(["notes:all-read"], ["notes:all-read"]),
      { call: "notes.list", args: {} },
      execute,
    );
    expect(res.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("notes.list", {});
  });

  /** 가드(보안 핵심): 기존 `notes:read` 승인의 의미를 소급 확대하지 않는다 — 그 권한만으로는
   *  전체 읽기에 닿지 못한다(decisions 문서 채택안 (b)의 요점). */
  it("notes:read만으로는 notes.list/notes.read에 닿지 못한다", async () => {
    for (const call of ["notes.list", "notes.read"]) {
      const execute = vi.fn(async () => null);
      const res = await handleBridgeRequest(
        grant(["notes:read"], ["notes:read"]),
        { call, args: {} },
        execute,
      );
      expect(res.code, call).toBe("PERMISSION_UNDECLARED");
      expect(execute).not.toHaveBeenCalled();
    }
  });

  /** 가드: 민감 권한이라 선언만으로는 부족하다(선언 + 사용자 부여). */
  it("선언했지만 미부여면 PERMISSION_UNGRANTED로 거부된다", async () => {
    const execute = vi.fn(async () => null);
    const res = await handleBridgeRequest(
      grant(["notes:all-read"]), // 선언만, 미부여
      { call: "notes.read", args: { id: "n1" } },
      execute,
    );
    expect(res.code).toBe("PERMISSION_UNGRANTED");
    expect(execute).not.toHaveBeenCalled();
  });
});
