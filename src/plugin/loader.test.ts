import { describe, it, expect, vi } from "vitest";
import {
  bindPluginSettings,
  evaluateStaticWhen,
  installedSourceFromRecord,
  makeRegistrar,
  normalizeToolbarPosition,
  parseWhenClause,
  prepareInstalledPlugin,
} from "./loader";
import type { InstalledPlugin } from "../shared/tauri";
import { findPatternMatches } from "./editor-api";
import { checkPermission } from "./permissions";

describe("makeRegistrar", () => {
  /** 가드: 인라인 패턴·자동완성 등록이 수집되고, 클래스는 호스트가 pluginId로 네임스페이스하며
   *  스타일은 의미 토큰이 앱 변수로 해석된다(플러그인 지정 className/raw CSS 아님). */
  it("collects inline-pattern (host-namespaced class + resolved style) and completion", async () => {
    const r = makeRegistrar("wl-plugin");
    await r.execute("editor.registerInlinePattern", {
      id: "wl",
      open: "[[",
      close: "]]",
      // 플러그인이 className을 줘도 무시된다 — 호스트가 파생한다.
      className: "cm-cursor",
      style: { color: "accent", textDecoration: "underline" },
    });
    await r.execute("editor.registerCompletion", {
      trigger: "[[",
      wrap: "[[%]]",
    });

    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0].open).toBe("[[");
    // 클래스는 cm-x-<plugin>-<pattern> — 플러그인이 준 cm-cursor는 반영되지 않는다.
    expect(r.patterns[0].className).toBe("cm-x-wl-plugin-wl");
    expect(r.patterns[0].style).toEqual({
      color: "var(--memo-accent, #37506a)",
      "text-decoration": "underline",
    });
    expect(r.completions[0].wrap).toBe("[[%]]");

    // 수집된 구분자가 실제로 위키링크를 매치하는지.
    const m = findPatternMatches(
      "x [[Note]] y",
      r.patterns[0].open,
      r.patterns[0].close,
    );
    expect(m[0] && "x [[Note]] y".slice(m[0].first.from, m[0].first.to)).toBe(
      "Note",
    );
  });

  /**
   * 가드(파라미터화 등록): `param`이 등록 인자에서 디스크립터까지 그대로 실려 매칭에 쓰인다 —
   * 등록 **하나**로 본문에 적힌 임의 hex(3·6자리)를 색으로 쓰는 경로다.
   */
  it("carries a param descriptor through registration into matching", async () => {
    const r = makeRegistrar("tc-plugin");
    await r.execute("editor.registerInlinePattern", {
      id: "tc",
      open: "{{",
      close: "}}",
      param: { prefix: "|", format: "hex-color", apply: "color" },
      action: "none",
    });
    expect(r.patterns[0].param).toEqual({
      prefix: "|",
      format: "hex-color",
      apply: "color",
    });
    const line = "{{할일|#ff3366}}";
    const [m] = findPatternMatches(
      line,
      r.patterns[0].open,
      r.patterns[0].close,
      r.patterns[0].mid,
      r.patterns[0].param,
    );
    expect(line.slice(m.first.from, m.first.to)).toBe("할일");
    expect(line.slice(m.param!.from, m.param!.to)).toBe("#ff3366");
  });

  /** 가드(하위호환): `param` 없는 기존 등록에는 그 키가 아예 붙지 않는다 — 스냅샷에 새 필드가
   * 조용히 끼어들지 않고, 매칭도 예전 그대로다. */
  it("leaves param absent for registrations that do not use it", async () => {
    const r = makeRegistrar("wl-plugin");
    await r.execute("editor.registerInlinePattern", {
      id: "wl",
      open: "[[",
      close: "]]",
    });
    expect("param" in r.patterns[0]).toBe(false);
  });

  /** 가드: 어휘 밖 형식·색이 아닌 반영 속성은 등록 자체를 거부한다(무음 실패 대신 진단). */
  it("rejects a param with an unknown format or a non-color apply", async () => {
    const r = makeRegistrar("bad");
    for (const param of [
      { prefix: "|", format: "css-color", apply: "color" },
      { prefix: "|", format: "hex-color", apply: "fontSize" },
      { prefix: "", format: "hex-color" },
    ]) {
      await expect(
        r.execute("editor.registerInlinePattern", {
          open: "{{",
          close: "}}",
          param,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    }
    expect(r.patterns).toHaveLength(0);
  });

  /** 가드: theme.register 호출이 정규화된 색 토큰 디스크립터로 수집된다. */
  it("collects a normalized theme descriptor from theme.register", async () => {
    const r = makeRegistrar();
    expect(r.theme).toBeNull(); // 등록 전에는 null
    await r.execute("theme.register", {
      tokens: { accent: "#111111", danger: "#222222" },
    });
    expect(r.theme).not.toBeNull();
    expect(r.theme!.tokens).toEqual({ accent: "#111111", danger: "#222222" });
  });

  /** 가드: background.register가 정규화된 배경 디스크립터로 수집된다(스와치·자동대비). */
  it("collects a normalized background descriptor from background.register", async () => {
    const r = makeRegistrar();
    expect(r.background).toBeNull();
    await r.execute("background.register", {
      swatches: ["#e5dbc3", "notacolor", "#fdf6e3"],
      autoTextContrast: false,
    });
    expect(r.background).not.toBeNull();
    // 비-hex 스와치는 정규화 과정에서 버려진다.
    expect(r.background!.swatches).toEqual(["#e5dbc3", "#fdf6e3"]);
    expect(r.background!.autoTextContrast).toBe(false);
  });

  /** 가드: 마지막 background.register가 유효(배경은 단일). */
  it("keeps only the last background registration", async () => {
    const r = makeRegistrar();
    await r.execute("background.register", { swatches: ["#111111"] });
    await r.execute("background.register", { swatches: [] });
    expect(r.background!.swatches).toEqual([]);
  });

  /** 가드: font.register가 정규화된 폰트 디스크립터로 수집된다(위험 스택은 버림). */
  it("collects a normalized font descriptor from font.register", async () => {
    const r = makeRegistrar();
    expect(r.font).toBeNull();
    await r.execute("font.register", {
      families: [
        { label: "세리프", stack: "Georgia, serif" },
        { label: "위험", stack: "x} body{color:red" },
      ],
    });
    expect(r.font).not.toBeNull();
    // CSS 이탈 문자가 든 스택은 정규화에서 버려진다.
    expect(r.font!.families).toEqual([
      { label: "세리프", stack: "Georgia, serif" },
    ]);
  });

  /** 가드: 블록 임베드 등록 호출이 검증을 거쳐 디스크립터로 수집된다. */
  it("collects a validated block-embed descriptor", async () => {
    const r = makeRegistrar();
    await r.execute("editor.registerBlockEmbed", {
      id: "vid",
      fence: "vid",
      sources: [{ host: "watch.example", queryParam: "v" }],
      embedTemplate: "https://embed.example/e/{id}",
    });
    expect(r.embeds).toHaveLength(1);
    expect(r.embeds[0].fence).toBe("vid");
  });

  /** 가드: 형식이 틀린 블록 임베드 등록은 던진다(수집되지 않음). */
  it("rejects a malformed block-embed registration", async () => {
    const r = makeRegistrar();
    await expect(
      r.execute("editor.registerBlockEmbed", {
        id: "vid",
        fence: "vid",
        sources: [{ host: "watch.example", queryParam: "v" }],
        embedTemplate: "https://embed.example/no-id-slot",
      }),
    ).rejects.toThrow();
    expect(r.embeds).toHaveLength(0);
  });

  /**
   * 가드(회귀): 거부 문구가 **걸린 필드**를 밝힌다 — 진단 채널에 남는 그 한 줄이 저작자의
   * 유일한 단서다. 예전엔 어떤 위반이든 「잘못된 블록 임베드 디스크립터」 하나뿐이라
   * `fence: "YouTube"`처럼 대문자 하나로 임베드가 통째로 안 뜨는 원인에 도달할 길이 없었다
   * (저작 문서는 한술 더 떠 "먼저 `id`를 확인하라"고 안내했다).
   */
  it("names the offending field in the rejection message", async () => {
    const r = makeRegistrar();
    const valid = {
      id: "vid",
      sources: [{ host: "watch.example", queryParam: "v" }],
      embedTemplate: "https://embed.example/e/{id}",
    };
    await expect(
      r.execute("editor.registerBlockEmbed", { ...valid, fence: "YouTube" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: expect.stringContaining("fence"),
    });
    await expect(
      r.execute("editor.registerBlockEmbed", {
        ...valid,
        fence: "vid",
        sources: [],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: expect.stringContaining("sources"),
    });
  });

  /** 가드: 지원하지 않는 호출은 던진다(게이트키퍼가 거부로 감싸게). */
  it("rejects unsupported calls", async () => {
    const r = makeRegistrar();
    await expect(r.execute("notes.write", {})).rejects.toThrow();
  });

  /** 가드: 실행부의 거부도 게이트키퍼의 거부와 같은 어휘의 안정 코드를 단다 —
   *  저작자가 "어디서 거부됐는지"와 무관하게 err.code 하나만 보면 되게. */
  it("tags its own rejections with stable codes", async () => {
    const r = makeRegistrar("p");
    await expect(r.execute("notes.write", {})).rejects.toMatchObject({
      code: "UNKNOWN_CALL",
    });
    await expect(
      r.execute("editor.registerBlockEmbed", { id: "v", fence: "v" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });
});

describe("makeRegistrar — 등록 id와 upsert ", () => {
  /** 가드: 모든 등록 호출이 `{ id }`를 돌려준다 — 예전엔 전부 null이라 "등록됐다"는
   *  확인조차 없었다(진단·헤드리스 검증이 붙을 자리가 없었다). */
  it("returns the registration id from every register call", async () => {
    const r = makeRegistrar("p");
    expect(
      await r.execute("editor.registerInlinePattern", {
        id: "hl",
        open: "==",
        close: "==",
      }),
    ).toEqual({ id: "hl" });
    expect(
      await r.execute("editor.registerCompletion", {
        id: "wl",
        trigger: "[[",
        wrap: "[[%]]",
      }),
    ).toEqual({ id: "wl" });
    expect(
      await r.execute("editor.registerBlockEmbed", {
        id: "vid",
        fence: "vid",
        sources: [{ host: "watch.example", queryParam: "v" }],
        embedTemplate: "https://embed.example/e/{id}",
      }),
    ).toEqual({ id: "vid" });
    // 슬롯이 하나뿐인 능력 등록은 seq 없는 안정 id를 돌려준다.
    expect(await r.execute("theme.register", { tokens: {} })).toEqual({
      id: "p:theme.register",
    });
    expect(await r.execute("window.register", { controls: [] })).toEqual({
      id: "p:window.register",
    });
  });

  /**
   * 가드(문서 대조): id 규칙은 등록마다 다르다 — 저작 문서가 이 셋을 하나로 뭉뚱그리면
   * 저작자가 틀린 형태로 부른다.
   *
   * (a) `registerBlockEmbed`의 id는 **필수**다(자동 생성 없음 — 없으면 INVALID_ARGS).
   *     문서가 "생략하면 만들어 준다"고 적었을 때, 그대로 따라 쓴 저작자는 "잘못된 블록
   *     임베드 디스크립터"만 보고 sources·embedTemplate·도메인 권한을 의심하며 시간을 태웠다.
   * (b) 능력 등록은 id 인자를 **받지 않는다** — 줘도 무시하고 `<pluginId>:<call>`을 돌려준다.
   */
  it("requires an id for block embeds and ignores one given to capability registers", async () => {
    const r = makeRegistrar("p");
    await expect(
      r.execute("editor.registerBlockEmbed", {
        fence: "vid",
        sources: [{ host: "watch.example", queryParam: "v" }],
        embedTemplate: "https://embed.example/e/{id}",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(r.embeds).toHaveLength(0);
    expect(
      await r.execute("theme.register", { id: "내가-준-id", tokens: {} }),
    ).toEqual({ id: "p:theme.register" });
  });

  /** 가드(버그 수정): 빈 id로 등록하면 호스트가 `<pluginId>:<call>:<seq>`를 만들어 준다 —
   *  예전에는 빈 문자열 id로 여러 요소가 같은 키에 조용히 쌓였다. */
  it("generates an id when the plugin gives none", async () => {
    const r = makeRegistrar("p");
    const a = (await r.execute("editor.registerCompletion", {
      trigger: "@",
      wrap: "@%",
    })) as { id: string };
    const b = (await r.execute("editor.registerCompletion", {
      trigger: "#",
      wrap: "#%",
    })) as { id: string };
    expect(a.id).toBe("p:editor.registerCompletion:1");
    expect(b.id).toBe("p:editor.registerCompletion:2");
    // 자동 생성 id는 서로 달라야 하므로 둘 다 남는다(치환이 아니다).
    expect(r.completions).toHaveLength(2);
  });

  /** 가드(핵심): 같은 id로 다시 등록하면 append가 아니라 **치환**이고, 원래 자리를 지킨다. */
  it("upserts by id and keeps the original position", async () => {
    const r = makeRegistrar("p");
    await r.execute("editor.registerInlinePattern", {
      id: "a",
      open: "<",
      close: ">",
    });
    await r.execute("editor.registerInlinePattern", {
      id: "b",
      open: "{",
      close: "}",
    });
    await r.execute("editor.registerInlinePattern", {
      id: "a",
      open: "==",
      close: "==",
    });
    expect(r.patterns.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.patterns[0].open).toBe("=="); // 치환됨
  });

  /**
   * 가드: 치환은 조용히 일어나지 않는다 — `onDuplicate`로 호출자(중앙 호스트)에게 올라가
   * 진단이 된다.
   *
   * 왜: upsert 자체는 옳지만, 복사-붙여넣기로 id를 안 바꾼 저작자에게는 "등록이 하나
   * 사라졌다"로 보인다. 이유가 어디에도 남지 않으면 자기 코드가 아니라 호스트를 의심한다.
   */
  it("reports replaced registrations through onDuplicate", async () => {
    const replaced: string[] = [];
    const r = makeRegistrar("p", (call, id) => replaced.push(`${call}:${id}`));
    await r.execute("editor.registerInlinePattern", {
      id: "a",
      open: "<",
      close: ">",
    });
    await r.execute("editor.registerInlinePattern", {
      id: "a",
      open: "==",
      close: "==",
    });
    // 자동 생성 id는 서로 다르므로 치환이 아니다(오탐이 나면 안 된다).
    await r.execute("editor.registerCompletion", { trigger: "@", wrap: "@%" });
    await r.execute("editor.registerCompletion", { trigger: "#", wrap: "#%" });
    expect(replaced).toEqual(["editor.registerInlinePattern:a"]);
  });

  /** 가드: 자동완성도 같은 규칙으로 치환된다(같은 트리거가 두 번 쌓여 첫 등록만 먹던 버그). */
  it("upserts completions by id", async () => {
    const r = makeRegistrar("p");
    await r.execute("editor.registerCompletion", {
      id: "wl",
      trigger: "[[",
      wrap: "[[%]]",
    });
    await r.execute("editor.registerCompletion", {
      id: "wl",
      trigger: "[[",
      wrap: "((%))",
    });
    expect(r.completions).toHaveLength(1);
    expect(r.completions[0].wrap).toBe("((%))");
  });

  /** 가드(의존): 수집된 자동완성 디스크립터는 id와 닫힌 열거형 source를 갖는다 —
   *  매칭기가 "어느 등록의 wrap인가"를 되짚을 수 있는 근거다. */
  it("stamps every completion with an id and a closed source", async () => {
    const r = makeRegistrar("wl");
    await r.execute("editor.registerCompletion", {
      id: "wl",
      trigger: "[[",
      wrap: "[[%]]",
      source: "notes-of-other-users", // 모르는 값은 닫힌 열거형으로 정규화된다.
    });
    expect(r.completions[0]).toEqual({
      id: "wl",
      trigger: "[[",
      wrap: "[[%]]",
      source: "note-titles",
    });
  });
});

// 브리지 호출 수행부(executor)의 가드는 실행 주체를 따라 이동했다: 호스트 측(설정·버튼
// 수집·창-스코프 위임)은 central-host.test.ts, 노트 창 측(toast·글자 델타 NaN 방어·현재
// 노트·클립보드)은 host-client.test.ts가 고정한다.

// 샌드박스 iframe 실행은 jsdom에서 동작하지 않으므로(스크립트 미실행), 여기서는 설치
// 플러그인의 **검증 + 부여 병합** 순수 로직만 가드한다. 실제 위젯 렌더는 e2e가 검증한다.
const source = (
  permissions: string[],
  granted: string[],
  overrides: Record<string, unknown> = {},
) => ({
  manifest: {
    id: "p",
    name: "P",
    version: "1.0.0",
    entry: "main.js",
    permissions,
    ...overrides,
  },
  code: "memo.editor.registerCompletion({});",
  granted,
});

describe("prepareInstalledPlugin", () => {
  /** 검증을 통과했다고 보고 준비 결과를 꺼낸다(실패면 테스트가 그 자리에서 죽는다). */
  const prepared = (src: ReturnType<typeof source>) => {
    const result = prepareInstalledPlugin(src);
    if (!result.ok) throw new Error(`준비 실패: ${result.error}`);
    return result.plugin;
  };

  /** 가드: 유효 매니페스트는 선언/부여로 grant를 만든다(코드도 통과). */
  it("builds a grant from a valid manifest", () => {
    const p = prepared(source(["editor", "notes:read"], ["notes:read"]));
    expect(p.id).toBe("p"); // 설정 서비스 바인딩에 쓰는 매니페스트 id
    expect(p.grant.declared).toEqual(["editor", "notes:read"]);
    expect(p.grant.granted).toEqual(["notes:read"]);
    expect(p.code).toContain("registerCompletion");
  });

  /** 가드(보안 핵심): 선언 안 한 권한은 부여돼 있어도 grant에서 제거된다. */
  it("drops granted permissions that are not declared", () => {
    const p = prepared(source(["editor"], ["notes:read", "windows"]));
    // 선언이 editor뿐 → notes:read·windows 부여는 무효.
    expect(p.grant.granted).toEqual([]);
    // 게이트키퍼도 막아야 한다(이중 보장).
    expect(checkPermission(p.grant, "notes:read").allowed).toBe(false);
  });

  /** 가드: 선언+부여가 맞으면 민감 권한이 게이트키퍼를 통과한다. */
  it("allows a sensitive permission only when declared AND granted", () => {
    const p = prepared(
      source(["editor", "notes:read", "windows"], ["notes:read", "windows"]),
    );
    expect(checkPermission(p.grant, "notes:read").allowed).toBe(true);
    expect(checkPermission(p.grant, "windows").allowed).toBe(true);
    // 선언했지만 부여 안 한 민감 권한은 거부.
    const partial = prepared(source(["editor", "notes:read"], []));
    expect(checkPermission(partial.grant, "notes:read").allowed).toBe(false);
  });

  /**
   * 가드: 매니페스트 검증 실패는 **사유와 함께** 실패로 온다(→ 호출부가 스냅샷 failures에
   * 싣는다). 예전엔 null이라 호출부가 조용히 건너뛸 수밖에 없었고, 그 플러그인은 ⚠ 배지도
   * 진단도 없이 사라졌다.
   */
  it("reports an invalid manifest with a reason instead of vanishing", () => {
    const unknownPerm = prepareInstalledPlugin(source(["filesystem"], []));
    expect(unknownPerm.ok).toBe(false);
    if (unknownPerm.ok) return;
    expect(unknownPerm.id).toBe("p"); // 표시용 id는 원문에서 최선으로 건진다
    expect(unknownPerm.error).toContain("filesystem");

    const badId = prepareInstalledPlugin(source([], [], { id: "Bad Id!" }));
    expect(badId.ok).toBe(false);
    if (badId.ok) return;
    expect(badId.id).toBe("Bad Id!");
    expect(badId.error).toContain("id");
  });

  /**
   * 가드: 매니페스트의 계약 필드(`kind`)가 로드 입력에 실려 나온다.
   *
   * 왜: 이 값이 여기서 끊기면 중앙 호스트가 `PluginRuntimeEnv`를 채울 수 없고, 능력 게이트가
   * 설치 플러그인에 **영원히 닿지 못한다**(선언만 되고 아무도 안 읽는 상태의 재발). 미선언은
   * undefined 그대로 — 기본값을 여기서 만들지 않는다(게이트가 "미선언"과 "action 선언"을
   * 구분해야 하위호환이 유지된다).
   */
  it("carries the manifest kind through", () => {
    const declared = prepared(
      source(["font"], ["font"], { kind: "capability" }),
    );
    expect(declared.kind).toBe("capability");

    const silent = prepared(source(["font"], ["font"]));
    expect(silent.kind).toBeUndefined();
  });

  /**
   * 가드: 설정 스키마도 이 검증 지점에서 함께 나온다 — 소비처가 매니페스트를
   * 다시 파싱하지 않는다(검증과 소비가 갈라지면 한쪽만 낡는다).
   */
  it("carries the declared settings schema through", () => {
    const withSchema = prepared(
      source(["settings"], [], {
        settings: [{ key: "prefix", label: "접두", type: "text" }],
      }),
    );
    expect(withSchema.settings.map((f) => f.key)).toEqual(["prefix"]);
    expect(prepared(source(["editor"], [])).settings).toEqual([]);
  });

  /** 가드: editor만 선언한 플러그인은 어떤 데이터 서비스 권한도 못 얻는다. */
  it("an editor-only plugin gets no notes/windows access", () => {
    const p = prepared(source(["editor"], []));
    expect(checkPermission(p.grant, "editor").allowed).toBe(true);
    expect(checkPermission(p.grant, "notes:read").allowed).toBe(false);
    expect(checkPermission(p.grant, "windows").allowed).toBe(false);
  });
});

describe("installedSourceFromRecord", () => {
  const record = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
    id: "third",
    name: "서드파티",
    version: "1.0.0",
    permissions: ["settings", "ui"],
    enabled: true,
    granted: [],
    settings_schema: [
      { key: "prefix", label: "접두", type: "text", options: [] },
      { key: "tpls", label: "템플릿", type: "list", options: [] },
    ],
    settings: { prefix: "»" },
    ...over,
  });

  /**
   * 가드(배선 완결): 백엔드 레코드 → 재구성 매니페스트 → `prepareInstalledPlugin` 왕복에서
   * **매니페스트에서 온 사실이 하나도 빠지지 않는다.**
   *
   * 왜 이 가드인가: 이 재구성이 필드를 빠뜨리면 그 기능이 설치(서드파티) 플러그인에서만
   * 통째로 죽고 번들에서는 멀쩡해 보인다 — 실제로 `settings_schema`가 빠져 설치 플러그인의
   * `settings.getAll()`이 영구히 `{}`였고(list 배열 변환·기본값 병합·미선언 키 판정이 전부
   * 죽었다), 그전에는 `kind`가 같은 방식으로 누락됐다. 필드가 늘 때 여기에
   * 한 줄 더하는 것을 잊으면 이 가드가 실패한다.
   */
  it("carries every manifest-derived field through to the load input", () => {
    const result = prepareInstalledPlugin(
      installedSourceFromRecord(
        record({
          platforms: ["macos"],
          kind: "capability",
          granted: ["settings"],
        }),
        "memo.runtime.ready();",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.id).toBe("third");
    expect(result.plugin.code).toContain("runtime.ready");
    expect(result.plugin.grant.declared).toEqual(["settings", "ui"]);
    expect(result.plugin.platforms).toEqual(["macos"]);
    expect(result.plugin.kind).toBe("capability");
    // 설정 스키마 — 여기가 끊기면 설치 플러그인의 settings.* 계약이 통째로 거짓이 된다.
    expect(result.plugin.settings.map((f) => f.key)).toEqual([
      "prefix",
      "tpls",
    ]);
  });

  /** 가드: 저장된 설정 값과 부여도 그대로 실린다(런타임 `settings.get`의 초기 스냅샷). */
  it("keeps saved settings values and grants", () => {
    const source = installedSourceFromRecord(
      record({ granted: ["settings"] }),
      "//",
    );
    expect(source.settings).toEqual({ prefix: "»" });
    expect(source.granted).toEqual(["settings"]);
  });

  /**
   * 가드: 어휘 밖 `kind`는 **누락**으로 접는다(하위호환 경로) — 실패로 만들면
   * 형태가 어긋난 IPC 응답 하나에 그 플러그인이 통째로 사라진다.
   */
  it("drops unknown kind instead of poisoning the manifest", () => {
    const source = installedSourceFromRecord(
      record({
        kind: "widget" as InstalledPlugin["kind"],
      }),
      "//",
    );
    const manifest = source.manifest as Record<string, unknown>;
    expect(manifest.kind).toBeUndefined();
    expect(prepareInstalledPlugin(source).ok).toBe(true);
  });
});

describe("normalizeToolbarPosition", () => {
  /** 가드: 4방향 존은 그대로, 그 외(오타·주입·비문자열)는 기본 top-left로 막는다. */
  it("keeps the four zones and defaults unknown input to top-left", () => {
    for (const p of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      expect(normalizeToolbarPosition(p)).toBe(p);
    }
    expect(normalizeToolbarPosition("middle")).toBe("top-left");
    expect(normalizeToolbarPosition(undefined)).toBe("top-left");
    expect(normalizeToolbarPosition(42)).toBe("top-left");
  });
});

describe("bindPluginSettings", () => {
  /** 가드: 초기 스냅샷에서 읽고, set은 스냅샷 갱신 + 영속화(persist)를 부른다. */
  it("reads the snapshot and persists on set", () => {
    const persist = vi.fn();
    const svc = bindPluginSettings({ tone: "soft" }, persist);

    expect(svc.get("tone")).toBe("soft");
    expect(svc.get("missing")).toBeUndefined();

    svc.set("tone", "loud");
    expect(svc.get("tone")).toBe("loud"); // 같은 세션 내 즉시 반영
    expect(persist).toHaveBeenCalledWith("tone", "loud"); // 영속화 호출
  });

  /** 가드: 초기값을 복사하므로 set이 원본 객체를 변형하지 않는다. */
  it("does not mutate the caller's initial object", () => {
    const initial = { a: 1 };
    const svc = bindPluginSettings(initial, () => {});
    svc.set("a", 2);
    expect(initial.a).toBe(1);
  });

  /** 가드(보안): __proto__ 키로 set해도 전역 프로토타입이 오염되지 않는다(프로토타입 없는 맵). */
  it("is immune to __proto__ prototype pollution", () => {
    const svc = bindPluginSettings({}, () => {});
    svc.set("__proto__", { polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // 전역 미오염
    expect(svc.get("__proto__")).toEqual({ polluted: true }); // 자기 값으로만 저장
  });
});

// "꺼진 번들은 샌드박스를 만들지 않는다" 가드는 실행 주체가 중앙 호스트로 이동하면서
// central-host.test.ts(비활성 번들 → 팩토리 미호출)로 옮겨 고정한다.

describe("parseWhenClause — 닫힌 컨텍스트 키", () => {
  const keys = ["theme", "compact"];

  it("어휘 안의 키와 `!` 부정만 받는다", () => {
    const r = parseWhenClause(
      [
        "note.isEmpty",
        "!platform.macos",
        "plugin.font-scale.enabled",
        "settings.compact",
      ],
      keys,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terms).toEqual([
      { negated: false, key: "note.isEmpty" },
      { negated: true, key: "platform.macos" },
      { negated: false, key: "plugin.font-scale.enabled" },
      { negated: false, key: "settings.compact" },
    ]);
  });

  it("생략·빈 배열은 조건 없음이다(기존 등록 무변경)", () => {
    expect(parseWhenClause(undefined, keys)).toEqual({ ok: true, terms: [] });
    expect(parseWhenClause([], keys)).toEqual({ ok: true, terms: [] });
  });

  /** 표현식 언어를 열지 않는다 — `&&`·괄호·정규식은 전부 "모르는 키"로 떨어진다.
   * 이것이 파서를 만들지 않기로 한 결정의 관측 가능한 형태다. */
  it("표현식·정규식은 어휘 밖이라 거부된다", () => {
    for (const bad of [
      ["note.isEmpty && platform.macos"],
      ["/note\\..*/"],
      ["(note.isEmpty)"],
      ["window.hasFocus"],
    ]) {
      expect(parseWhenClause(bad, keys).ok).toBe(false);
    }
    expect(parseWhenClause("note.isEmpty", keys).ok).toBe(false);
  });

  /** 남의 설정도, 오타 난 자기 설정도 안 된다 — 후자를 통과시키면 그 조건이 언제나 거짓이
   * 되어 기여가 조용히 사라진다. */
  it("settings.<key>는 자기 매니페스트에 선언된 키만 허용한다", () => {
    expect(parseWhenClause(["settings.theme"], keys).ok).toBe(true);
    const bad = parseWhenClause(["settings.missing"], keys);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain("선언되지 않은 키");
  });

  /** note.hasSelection은 명령(commands)의 when에는 없다 — 명령 판정부가 선택을 보지 않아
   * 언제나 참이 되기 때문. 문구가 "대신 메뉴 항목(ui.addMenuItem)의 when을 쓰라"고 가리켜야
   * 저작자가 "오타인가?"로 헤매지 않고 올바른 API로 이동한다(로 그 경로가 생겼다). */
  it("명령 when의 note.hasSelection은 메뉴 항목을 쓰라고 안내한다", () => {
    const r = parseWhenClause(["note.hasSelection"], keys);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("ui.addMenuItem");
  });
});

describe("parseWhenClause — 메뉴 항목 어휘(opts.menu)", () => {
  const keys = ["myFlag"];

  /** 메뉴 항목의 when은 창 상태 두 키만 받는다(명령과 달리 note.hasSelection이 정직하다). */
  it("메뉴 항목은 note.hasSelection·note.isEmpty를 받는다(부정 포함)", () => {
    const r = parseWhenClause(["note.hasSelection", "!note.isEmpty"], keys, {
      menu: true,
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.terms).toEqual([
      { negated: false, key: "note.hasSelection" },
      { negated: true, key: "note.isEmpty" },
    ]);
  });

  /** 메뉴 항목의 when은 정적 키(platform·settings·plugin.enabled)를 거부한다 — 렌더 시점의
   * 노트 창이 볼 수 없기 때문(그런 조건은 run 안에서 판단하라고 문구가 가리킨다). */
  it("메뉴 항목은 정적 키(platform.macos)를 거부한다", () => {
    const r = parseWhenClause(["platform.macos"], keys, { menu: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("메뉴 항목");
  });

  it("메뉴 항목은 settings.<key>도 거부한다(자기 선언 키여도)", () => {
    const r = parseWhenClause(["settings.myFlag"], keys, { menu: true });
    expect(r.ok).toBe(false);
  });
});

describe("evaluateStaticWhen — 호스트가 즉시 판정하는 항목", () => {
  const ctx = {
    platform: "macos",
    enabledPlugins: new Set(["font-scale"]),
    setting: (key: string) =>
      ({ on: true, off: false, empty: "", text: "값" })[key],
  };
  const terms = (raw: string[]) => {
    const r = parseWhenClause(raw, ["on", "off", "empty", "text"]);
    if (!r.ok) throw new Error(r.error);
    return r.terms;
  };

  it("platform·plugin·settings를 AND로 판정한다", () => {
    expect(
      evaluateStaticWhen(
        terms(["platform.macos", "plugin.font-scale.enabled", "settings.on"]),
        ctx,
      ).value,
    ).toBe(true);
    expect(evaluateStaticWhen(terms(["platform.linux"]), ctx).value).toBe(
      false,
    );
    expect(
      evaluateStaticWhen(terms(["plugin.absent.enabled"]), ctx).value,
    ).toBe(false);
    expect(evaluateStaticWhen(terms(["!settings.off"]), ctx).value).toBe(true);
    // 빈 문자열은 "꺼짐"이다(텍스트 설정을 조건으로 쓰는 자연스러운 해석).
    expect(evaluateStaticWhen(terms(["settings.empty"]), ctx).value).toBe(
      false,
    );
    expect(evaluateStaticWhen(terms(["settings.text"]), ctx).value).toBe(true);
  });

  /** note.isEmpty는 그 창의 지금 본문을 봐야 알므로 호스트가 미룬다 — 다만 정적 항목이
   * 이미 거짓이면 창에 물어볼 것도 없다(창이 없어도 정답이 나온다). */
  it("note.isEmpty는 pending으로 미루고, 정적 거짓이면 미루지도 않는다", () => {
    const later = evaluateStaticWhen(
      terms(["platform.macos", "note.isEmpty"]),
      ctx,
    );
    expect(later.value).toBe(true);
    expect(later.pending).toEqual([{ negated: false, key: "note.isEmpty" }]);
    const short = evaluateStaticWhen(
      terms(["platform.linux", "note.isEmpty"]),
      ctx,
    );
    expect(short.value).toBe(false);
    expect(short.pending).toEqual([]);
  });
});

describe("prepareInstalledPlugin — contributes 통과", () => {
  /** 이 파일의 docstring이 경고하는 사고("재구성이 빠뜨린 필드는 기능 하나가 죽는다")를
   * contributes에 대해 못박는다 — 백엔드 레코드 → 매니페스트 재구성 → 로드 입력까지 왕복. */
  it("백엔드 레코드의 contributes가 로드 입력까지 살아 남는다", () => {
    const record = {
      id: "p",
      name: "P",
      version: "1.0.0",
      permissions: ["editor"],
      enabled: true,
      granted: [],
      settings_schema: [],
      settings: {},
      contributes: {
        completions: [{ id: "c", trigger: "[[" }],
      },
    } as unknown as InstalledPlugin;
    const source = installedSourceFromRecord(record, "code");
    const prepared = prepareInstalledPlugin(source);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.plugin.contributes?.completions).toHaveLength(1);
  });
});
