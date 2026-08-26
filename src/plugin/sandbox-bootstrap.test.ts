/**
 * 부트스트랩 가드 — (1) 원문의 SHA-256이 코드 상수와 tauri.conf.json의 CSP `script-src`
 * 해시와 모두 일치하는지, (2) 실제 동작(ready 시점 계약 + 호출 컨텍스트 전파)이 맞는지.
 *
 * 왜: 좁힌 CSP는 인라인 부트스트랩을 `'sha256-...'` 하나로만 허용한다. 부트스트랩을 한 글자라도
 * 바꾸면 해시 테스트가 실패해 "해시(코드 상수 + CSP)를 함께 갱신하라"를 강제한다 — 실제 앱에서
 * 조용히 CSP 위반으로 샌드박스가 깨지는 것을 테스트 시점에 잡는다. 동작 가드는 jsdom이 blob
 * 스크립트를 실행하지 못하므로 부트스트랩을 가짜 window/parent/document 위에서 직접 돌리고,
 * "플러그인 코드가 하는 일"은 테스트가 `memo` 브리지를 직접 호출해 대신한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  SANDBOX_BOOTSTRAP,
  SANDBOX_BOOTSTRAP_CSP_HASH,
} from "./sandbox-bootstrap";

/** 부트스트랩 원문(인라인 스크립트 내용)의 실제 SHA-256을 CSP 소스 토큰(따옴표 포함)으로 만든다. */
function computeHash(): string {
  const digest = createHash("sha256")
    .update(SANDBOX_BOOTSTRAP, "utf8")
    .digest("base64");
  return `'sha256-${digest}'`;
}

describe("sandbox bootstrap CSP hash", () => {
  /** 가드: 코드 상수가 실제 부트스트랩 원문의 해시와 일치한다(상수 드리프트 차단). */
  it("matches the exported constant", () => {
    expect(SANDBOX_BOOTSTRAP_CSP_HASH).toBe(computeHash());
  });

  /** 가드: tauri.conf.json의 CSP script-src에 이 해시가 실제로 들어 있다(정책 드리프트 차단). */
  it("is present in the tauri.conf.json CSP", () => {
    const conf = readFileSync("src-tauri/tauri.conf.json", "utf8");
    expect(conf).toContain(SANDBOX_BOOTSTRAP_CSP_HASH);
  });

  /** 가드: 부트스트랩은 eval 호출을 쓰지 않는다(플러그인 코드는 blob 스크립트로 로드 — 'unsafe-eval' 불요). */
  it("does not call eval (plugin code runs as a blob script)", () => {
    expect(SANDBOX_BOOTSTRAP).not.toMatch(/\beval\s*\(/); // eval(...) 호출 없음
    expect(SANDBOX_BOOTSTRAP).toContain("createObjectURL");
  });
});

/** 부트스트랩이 부모로 보내는 메시지(테스트가 읽는 만큼만). */
interface Posted {
  type: string;
  id?: number;
  call?: string;
  ctx?: string;
  args?: Record<string, unknown>;
  error?: string;
  kind?: string;
  message?: string;
  code?: string;
}

/** 부트스트랩이 노출하는 `memo` 브리지(테스트가 플러그인 코드 대신 호출한다). */
type MemoBridge = Record<
  string,
  Record<string, (args?: unknown, ...rest: unknown[]) => PromiseLike<unknown>>
>;

/**
 * 부트스트랩을 가짜 realm(window/parent/document/URL/Blob) 위에서 실행한다.
 *
 * 역할: `run` 메시지 → blob 스크립트 주입까지의 실제 흐름을 그대로 태우되, jsdom이 실행하지
 * 못하는 "플러그인 코드"만 테스트가 `memo` 브리지 직접 호출로 대신한다. 부모로 나간 메시지를
 * 순서대로 모아 두고, 응답·invoke를 주입할 수 있게 해 ready 시점과 ctx 전파를 관측한다.
 */
function runBootstrap() {
  const posted: Posted[] = [];
  const listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
  const fakeWindow = {
    addEventListener(type: string, fn: (e: { data: unknown }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  } as { addEventListener: unknown; memo: MemoBridge };
  const fakeParent = {
    postMessage: (msg: Posted) => void posted.push(msg),
  };
  let script: { onload?: () => void; onerror?: () => void; src?: string } = {};
  const fakeDocument = {
    createElement: () => (script = {}),
    head: { appendChild: () => {} },
  };
  const fakeUrl = {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => {},
  };
  const FakeBlob = function FakeBlob() {} as unknown as typeof Blob;

  new Function(
    "window",
    "parent",
    "document",
    "URL",
    "Blob",
    SANDBOX_BOOTSTRAP,
  )(fakeWindow, fakeParent, fakeDocument, fakeUrl, FakeBlob);

  /** 호스트 → 샌드박스 메시지 주입(response·invoke·run). */
  const deliver = (data: Record<string, unknown>) => {
    for (const fn of listeners.get("message") ?? []) {
      fn({ data: { __memo: true, ...data } });
    }
  };
  /** 최상위 예외(window error) 발생을 흉내 낸다. */
  const raiseError = () => {
    for (const fn of listeners.get("error") ?? []) {
      (fn as unknown as () => void)();
    }
  };
  /** 아무도 .catch를 걸지 않은 프라미스 거부(unhandledrejection)를 흉내 낸다. */
  const raiseUnhandledRejection = (reason: unknown) => {
    for (const fn of listeners.get("unhandledrejection") ?? []) {
      (fn as unknown as (e: { reason: unknown }) => void)({ reason });
    }
  };
  /** 아직 응답하지 않은 브리지 호출 전부에 성공 회신한다. */
  const answered = new Set<number>();
  const respondAll = (result: unknown = null) => {
    for (const m of posted) {
      if (m.type !== "call" || m.id === undefined || answered.has(m.id))
        continue;
      answered.add(m.id);
      deliver({ type: "response", id: m.id, ok: true, result });
    }
  };
  /** 특정 호출 1건에만 회신한다(대기 중인 팝업을 골라 풀 때). */
  const respondTo = (call: string, result: unknown = null) => {
    const m = posted.find(
      (x) => x.type === "call" && x.call === call && !answered.has(x.id ?? -1),
    );
    if (!m || m.id === undefined)
      throw new Error(`대기 중인 호출 없음: ${call}`);
    answered.add(m.id);
    deliver({ type: "response", id: m.id, ok: true, result });
  };

  return {
    posted,
    memo: fakeWindow.memo,
    deliver,
    raiseError,
    raiseUnhandledRejection,
    respondAll,
    respondTo,
    /** `run` → 스크립트 주입 → 로드 완료(s.onload)까지 진행한다. */
    finishLoad: () => {
      deliver({ type: "run", code: "// plugin" });
      script.onload?.();
    },
    /** 부모로 나간 순서를 "호출 이름 / ready"로 납작하게 본다(순서 단언용). */
    order: () => posted.map((m) => (m.type === "call" ? m.call : m.type)),
    /** 부모로 나간 ready 메시지(아직 없으면 undefined). */
    ready: () => posted.find((m) => m.type === "ready"),
  };
}

/** macrotask를 n번 흘려 보낸다(부트스트랩의 조용함 감시 틱을 진행시킨다). */
async function tick(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("sandbox bootstrap — ready 시점 계약", () => {
  afterEach(() => vi.useRealTimers());

  /** 가드(회귀): 등록이 `settings.get(...).then(→ 등록)`으로 늦게 도착해도 ready는 그 등록
   * **뒤에** 나간다 — 번들 4개가 이 형태라, 스크립트 load 시점에 ready를 보내면 그 등록이
   * 조용히 유실된다(스냅샷에 버튼 0개). */
  it("delays ready until late registrations from a .then chain have arrived", async () => {
    const h = runBootstrap();
    // 플러그인 코드 대역: 최상위에서 설정을 읽고, 응답을 받은 뒤에 버튼을 등록한다.
    void h.memo.settings
      .get({ key: "mode" })
      .then(() => h.memo.ui.addToolbarButton({ id: "late", label: "L" }));
    h.finishLoad();

    await tick(2);
    expect(h.ready()).toBeUndefined(); // 미해결 호출이 있는 동안은 ready 없음

    h.respondAll();
    await tick();
    h.respondAll();
    await tick();

    const order = h.order();
    expect(order).toContain("ui.addToolbarButton");
    expect(order.indexOf("ui.addToolbarButton")).toBeLessThan(
      order.indexOf("ready"),
    );
    expect(h.ready()?.error).toBeUndefined();
  });

  /** 가드: 아무 호출도 하지 않는 플러그인은 로드 직후 곧바로 ready 된다(지연은 필요한
   * 만큼만 — 조용한 플러그인이 부팅 상한을 잡아먹지 않는다). */
  it("sends ready promptly when the plugin makes no bridge calls", async () => {
    const h = runBootstrap();
    h.finishLoad();
    await tick(2);
    expect(h.ready()).toEqual({ __memo: true, type: "ready" });
  });

  /** 가드: 응답이 영영 오지 않아도 절대 상한(3초)에서 사유를 달아 ready 한다 —
   * 호스트가 부팅을 영원히 기다리지 않는다. */
  it("gives up after the absolute cap and reports the reason", async () => {
    vi.useFakeTimers();
    const h = runBootstrap();
    void h.memo.settings.get({ key: "mode" }); // 응답자 없음
    h.finishLoad();
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.ready()).toMatchObject({ error: "등록 대기 시간 초과" });
  });

  /** 가드: 최상위 예외(window error)는 조용함을 기다리지 않고 **즉시** 실패 사유와 함께
   * ready 한다(기존 동작 보존 — 깨진 플러그인이 부팅 상한까지 붙잡고 있지 않게). */
  it("reports a top-level error immediately", () => {
    const h = runBootstrap();
    void h.memo.settings.get({ key: "mode" }); // 미해결 호출이 남아 있어도
    h.deliver({ type: "run", code: "// plugin" });
    h.raiseError();
    expect(h.ready()).toMatchObject({ error: "스크립트 실행 오류" });
  });
});

describe("sandbox bootstrap — 진단 채널(샌드박스 내부 실패)", () => {
  /**
   * 가드(회귀): 툴바 버튼 onClick이 던지면 진단 메시지가 부모로 나간다.
   *
   * 왜: 예전에는 invoke 처리부가 `catch (err) {}`로 통째로 삼켰다. 샌드박스는 불투명
   * origin이라 devtools도 못 붙으므로, 이 메시지가 없으면 "버튼을 눌러도 아무 일이
   * 안 일어난다"의 원인을 볼 수 있는 창구가 앱 안팎 어디에도 없다.
   */
  it("reports a throwing onClick handler as a diagnostic", async () => {
    const h = runBootstrap();
    void h.memo.ui.addToolbarButton({
      id: "b",
      label: "B",
      onClick: () => {
        throw new TypeError("의도적 폭발");
      },
    });
    h.finishLoad();
    const registered = h.posted.find((m) => m.call === "ui.addToolbarButton");
    const buttonId = String(registered?.args?.buttonId ?? "");
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "inv-A" });

    expect(h.posted.filter((m) => m.type === "diagnostic")).toEqual([
      {
        __memo: true,
        type: "diagnostic",
        kind: "onclick-throw",
        message: "의도적 폭발",
      },
    ]);
  });

  /** 가드: 핸들러가 죽어도 샌드박스는 계속 산다(다음 클릭이 정상 동작한다). */
  it("keeps serving invokes after a handler throws", async () => {
    const h = runBootstrap();
    let calls = 0;
    void h.memo.ui.addToolbarButton({
      id: "b",
      label: "B",
      onClick: (memo: MemoBridge) => {
        calls += 1;
        if (calls === 1) throw new Error("첫 클릭 실패");
        void memo.ui.toast({ message: "두 번째" });
      },
    });
    h.finishLoad();
    const buttonId = String(
      h.posted.find((m) => m.call === "ui.addToolbarButton")?.args?.buttonId ??
        "",
    );
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "t" });
    h.deliver({ type: "invoke", buttonId, token: "t" });
    expect(h.posted.some((m) => m.call === "ui.toast")).toBe(true);
  });

  /**
   * 가드(회귀): 아무도 `.catch`를 걸지 않은 거부도 진단으로 나간다 — 브리지 오류면 호출명·
   * 안정 코드까지 실어 「최근 오류」에서 원인이 바로 보이게 한다.
   */
  it("reports unhandled rejections, carrying call and code when present", () => {
    const h = runBootstrap();
    const err = Object.assign(new Error("권한이 선언되지 않았습니다"), {
      code: "PERMISSION_UNDECLARED",
      call: "notes.current",
    });
    h.raiseUnhandledRejection(err);
    h.raiseUnhandledRejection(new Error("비-브리지 실패"));

    expect(h.posted.filter((m) => m.type === "diagnostic")).toEqual([
      {
        __memo: true,
        type: "diagnostic",
        kind: "unhandled-rejection",
        message: "권한이 선언되지 않았습니다",
        call: "notes.current",
        code: "PERMISSION_UNDECLARED",
      },
      {
        __memo: true,
        type: "diagnostic",
        kind: "unhandled-rejection",
        message: "비-브리지 실패",
      },
    ]);
  });

  /** 가드: 진단에는 **인자를 절대 싣지 않는다**(노트 본문 유출 차단 — 기존 원칙 유지). */
  it("never carries args in diagnostics", () => {
    const h = runBootstrap();
    h.raiseUnhandledRejection(new Error("실패"));
    for (const m of h.posted.filter((x) => x.type === "diagnostic")) {
      expect(m.args).toBeUndefined();
    }
  });
});

describe("sandbox bootstrap — 호출 컨텍스트(ctx) 전파", () => {
  /**
   * 가드(데이터 손상 회귀): 창 A의 클릭에서 시작된 체인은 창 B가 같은 버튼을 눌러도
   * 끝까지 A의 토큰을 물고 간다. 실증된 유실 시퀀스(A.pickList 대기 중 B.pickList →
   * A의 응답으로 notes.current → editor.insertText)를 그대로 재현한다.
   */
  it("carries the invoking token through the whole derived promise chain", async () => {
    const h = runBootstrap();
    // 플러그인 코드 대역: onClick이 pickList → notes.current → insertText 체인을 만든다.
    void h.memo.ui.addToolbarButton({
      id: "t",
      label: "T",
      onClick: () => {
        void h.memo.ui
          .pickList({ title: "템플릿" })
          .then(() => h.memo.notes.current())
          .then(() => h.memo.editor.insertText({ text: "TEMPLATE#0" }));
      },
    });
    h.finishLoad();
    const registered = h.posted.find((m) => m.call === "ui.addToolbarButton");
    const buttonId = String(registered?.args?.buttonId ?? "");
    h.respondAll();
    await tick();

    // 창 A 클릭 → pickList(응답 대기). 이어서 창 B 클릭 → 또 pickList(응답 대기).
    h.deliver({ type: "invoke", buttonId, token: "inv-A" });
    h.deliver({ type: "invoke", buttonId, token: "inv-B" });
    const picks = h.posted.filter((m) => m.call === "ui.pickList");
    expect(picks.map((m) => m.ctx)).toEqual(["inv-A", "inv-B"]);

    // A의 선택만 회신 → A의 체인이 이어진다.
    h.respondTo("ui.pickList", "0");
    await tick(2);
    h.respondTo("notes.current", { id: "a" });
    await tick(2);

    const chain = h.posted
      .filter(
        (m) => m.call === "notes.current" || m.call === "editor.insertText",
      )
      .map((m) => [m.call, m.ctx]);
    // 핵심: 나중 클릭(B)이 있어도 A의 체인은 전부 A 토큰이다.
    expect(chain).toEqual([
      ["notes.current", "inv-A"],
      ["editor.insertText", "inv-A"],
    ]);
  });

  /**
   * 가드(회귀): `async/await`로 브리지 호출을 이어 붙인 핸들러도 첫 await 뒤까지 토큰을
   * 물고 간다. 예전 구현은 invoke의 동기 구간이 끝나는 즉시 토큰을 복원해, await 재개
   * 시점(별도 마이크로태스크)에는 ctx가 통째로 빠진 채 호출이 나갔다 — 호스트가
   * "마지막 클릭 창"으로 폴백해 A에서 고른 내용이 B 본문에 꽂히는 데이터 손상이었다.
   */
  it("carries the token across native await between bridge calls", async () => {
    const h = runBootstrap();
    void h.memo.ui.addToolbarButton({
      id: "t",
      label: "T",
      onClick: async () => {
        await h.memo.ui.pickList({ title: "템플릿" });
        await h.memo.notes.current();
        await h.memo.editor.insertText({ text: "TEMPLATE#0" });
      },
    });
    h.finishLoad();
    const buttonId = String(
      h.posted.find((m) => m.call === "ui.addToolbarButton")?.args?.buttonId ??
        "",
    );
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "inv-A" });
    h.deliver({ type: "invoke", buttonId, token: "inv-B" });
    h.respondTo("ui.pickList", "0"); // A의 선택만 회신
    await tick(2);
    h.respondTo("notes.current", { id: "a" });
    await tick(2);

    expect(
      h.posted
        .filter(
          (m) => m.call === "notes.current" || m.call === "editor.insertText",
        )
        .map((m) => [m.call, m.ctx]),
    ).toEqual([
      ["notes.current", "inv-A"],
      ["editor.insertText", "inv-A"],
    ]);
  });

  /**
   * 가드: 핸들러는 **이 클릭에 고정 바인딩된 memo**를 첫 인자로 받는다. 전역 `memo`와 달리
   * 임의의 비동기 경계(Promise.all·setTimeout·비-브리지 await)를 넘어도 토큰이 유지된다 —
   * 번들 `copy-ai-prompt`가 쓰는 `Promise.all([...]).then(...)` 형태가 정확히 이 경우다.
   */
  it("passes a per-invocation memo that survives Promise.all", async () => {
    const h = runBootstrap();
    void h.memo.ui.addToolbarButton({
      id: "t",
      label: "T",
      onClick: (memo: MemoBridge) => {
        void Promise.all([
          memo.notes.current(),
          memo.settings.get({ key: "template" }),
        ]).then(() =>
          memo.clipboard
            .write({ text: "x" })
            .then(() => memo.ui.toast({ title: "복사됨" })),
        );
      },
    });
    h.finishLoad();
    const buttonId = String(
      h.posted.find((m) => m.call === "ui.addToolbarButton")?.args?.buttonId ??
        "",
    );
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "inv-A" });
    h.deliver({ type: "invoke", buttonId, token: "inv-B" });
    h.respondAll(); // 두 창의 Promise.all 입력을 모두 회신
    await tick(2);
    h.respondAll(); // clipboard.write 회신
    await tick(2);

    expect(
      h.posted.filter((m) => m.call === "clipboard.write").map((m) => m.ctx),
    ).toEqual(["inv-A", "inv-B"]);
    expect(
      h.posted.filter((m) => m.call === "ui.toast").map((m) => m.ctx),
    ).toEqual(["inv-A", "inv-B"]);
  });

  /** 가드: 바인딩된 memo는 브리지가 아닌 프라미스(setTimeout 등)를 await 한 뒤에도 유효하다 —
   * 전역 `memo`로는 복원할 수 없는 경계다(문서에 명시된 차이). */
  it("keeps the bound memo valid after awaiting a non-bridge promise", async () => {
    const h = runBootstrap();
    void h.memo.ui.addToolbarButton({
      id: "t",
      label: "T",
      onClick: async (memo: MemoBridge) => {
        await new Promise((r) => setTimeout(r, 0));
        await memo.ui.toast({ title: "늦은 토스트" });
      },
    });
    h.finishLoad();
    const buttonId = String(
      h.posted.find((m) => m.call === "ui.addToolbarButton")?.args?.buttonId ??
        "",
    );
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "inv-A" });
    await tick(2);
    expect(h.posted.find((m) => m.call === "ui.toast")?.ctx).toBe("inv-A");
  });

  /**
   * 가드(계약): `memo.*` 호출의 반환값은 **진짜 Promise**다 — 파생 체인(.then/.catch/.finally)의
   * 결과까지 전부.
   *
   * 왜: 저작용 타입 선언(docs/plugin/api-reference.d.ts)과 저작 문서가 반환값을 `Promise`로 단언한다.
   * 예전 구현은 `{then, catch, finally}`만 가진 맨 객체 리터럴을 돌려줬다 — `await`은 됐지만
   * `instanceof Promise`가 거짓이고 `Promise.prototype.then.call(v, ...)`이나 진짜 Promise를
   * 요구하는 서드파티 유틸에 넘기면 TypeError로 죽었다. tsc는 선언이 Promise라 아무 경고도
   * 주지 않아 런타임에서만 드러났다.
   */
  it("returns a real Promise from every bridge call and derived chain", async () => {
    const h = runBootstrap();
    const call = h.memo.ui.toast({ title: "x" });
    const derived = call.then(() => 1);
    h.finishLoad();
    h.respondAll();
    await tick();

    for (const [label, value] of [
      ["호출", call],
      ["파생", derived],
    ] as const) {
      expect(
        value,
        `${label} 반환값이 Promise 인스턴스가 아니다`,
      ).toBeInstanceOf(Promise);
      expect(Object.prototype.toString.call(value)).toBe("[object Promise]");
      // 진짜 Promise만 통과하는 경로(내부 슬롯 필요) — thenable이면 여기서 TypeError.
      await expect(Promise.prototype.then.call(value, (v: unknown) => v))
        .resolves.not.toThrow;
    }
  });

  /**
   * 가드(오배달 회귀): 서로 다른 토큰의 체인 둘이 **같은 마이크로태스크 드레인**에서 풀린 뒤,
   * 클릭과 무관한 전역 호출에 ctx가 붙지 않는다.
   *
   * 왜: 예전 구현은 지연 복원이 진입 시점의 `prev`를 되설치했다 — 같은 드레인에서 A→B 순으로
   * 돌면 B가 캡처한 prev는 null이 아니라 A라, 두 체인이 끝난 뒤 전역 컨텍스트가 A에 **영구
   * 고정**됐다. 그 뒤의 모든 폴백 호출("컨텍스트를 잃으면 마지막 클릭 창")이 "낡은 A 창으로
   * 확정 배달"로 바뀌어, 창 C에서 누른 결과가 창 A에 뜨거나(A가 닫혔으면) 타임아웃까지 매달렸다.
   */
  it("does not pin the global context to a stale token after two chains settle together", async () => {
    const h = runBootstrap();
    // 전역 memo만 쓰는 핸들러(바인딩 인자를 받지 않는다 — 최선 노력 경로).
    void h.memo.ui.addToolbarButton({
      id: "t",
      label: "T",
      onClick: () => {
        void h.memo.ui
          .pickList({ title: "템플릿" })
          .then(() => h.memo.notes.current());
      },
    });
    h.finishLoad();
    const buttonId = String(
      h.posted.find((m) => m.call === "ui.addToolbarButton")?.args?.buttonId ??
        "",
    );
    h.respondAll();
    await tick();

    h.deliver({ type: "invoke", buttonId, token: "inv-A" });
    h.deliver({ type: "invoke", buttonId, token: "inv-B" });
    h.respondAll(); // 두 창의 pickList 응답을 **한 태스크에서** 함께 푼다
    await tick(2);

    // 파생 체인 자체는 각자의 토큰을 그대로 물고 나간다(기존 계약).
    expect(
      h.posted.filter((m) => m.call === "notes.current").map((m) => m.ctx),
    ).toEqual(["inv-A", "inv-B"]);

    // 핵심: 두 체인이 모두 끝난 뒤의 전역 호출은 토큰 없이 나가야 한다.
    void h.memo.ui.toast({ title: "클릭과 무관" });
    expect(h.posted.find((m) => m.call === "ui.toast")?.ctx).toBeUndefined();
  });

  /** 가드: 클릭에서 파생되지 않은 호출(로드 시점 등)에는 ctx가 붙지 않는다 —
   * 호스트가 "토큰 없음"으로 보고 폴백 경로를 쓰게 한다. */
  it("omits ctx for calls that do not come from an invocation", async () => {
    const h = runBootstrap();
    void h.memo.ui.toast({ title: "안녕" });
    h.finishLoad();
    h.respondAll();
    await tick();
    expect(h.posted.find((m) => m.call === "ui.toast")?.ctx).toBeUndefined();
  });
});

describe("sandbox bootstrap — 오류 복원", () => {
  /**
   * 가드: 거부 응답의 안정 코드가 `Error.code`로, 호출 이름이 `Error.call`로 복원된다.
   * 사람용 `.message`는 호스트가 준 문구 그대로다(기존 코드 100% 하위호환).
   */
  it("restores the stable code and call name on a rejected call", async () => {
    const h = runBootstrap();
    const p = h.memo.ui.toast({ title: "x" });
    h.finishLoad();
    const id = h.posted.find((m) => m.call === "ui.toast")?.id;
    h.deliver({
      type: "response",
      id,
      ok: false,
      code: "PERMISSION_UNDECLARED",
      error: "미선언 권한: ui",
    });
    await expect(p).rejects.toMatchObject({
      code: "PERMISSION_UNDECLARED",
      call: "ui.toast",
      message: "미선언 권한: ui",
    });
  });

  /** 가드(계약): 코드가 실려 오지 않은 거부도 `err.code`는 항상 문자열이다 —
   *  저작자가 "code가 있나 없나"를 다시 분기하지 않게 "UNKNOWN"으로 채운다. */
  it("fills UNKNOWN when the host sent no code", async () => {
    const h = runBootstrap();
    const p = h.memo.ui.toast({ title: "x" });
    h.finishLoad();
    const id = h.posted.find((m) => m.call === "ui.toast")?.id;
    h.deliver({ type: "response", id, ok: false, error: "boom" });
    await expect(p).rejects.toMatchObject({ code: "UNKNOWN", message: "boom" });
  });
});

describe("sandbox bootstrap — 인자 정본", () => {
  /**
   * 가드(무음 손상 회귀): 인자를 2개 이상 주면 **동기 TypeError**로 즉시 죽는다.
   *
   * 왜: 예전 Proxy는 `function (args)`로 첫 인자만 받아 두 번째가 조용히 버려졌다 —
   * `memo.settings.set("k", v)`가 `String(undefined)` 키로 저장을 시도하고 아무 오류도
   * 나지 않았다. AI가 가장 흔히 저지르는 실수가 정확히 이것이다.
   */
  it("throws synchronously when given more than one argument", () => {
    const h = runBootstrap();
    expect(() => h.memo.settings.set("k", "v")).toThrow(TypeError);
    // 죽었으므로 브리지로 나간 것이 없어야 한다(반쪽 저장 금지).
    expect(h.posted.filter((m) => m.type === "call")).toHaveLength(0);
  });

  /** 가드: 원시값 하나만 줘도 던진다 — settings.get도 더는 예외가 아니다(축약형 특례 제거). */
  it("throws on a primitive argument (settings.get is no longer special)", () => {
    const h = runBootstrap();
    expect(() => h.memo.ui.toast("복사됨")).toThrow(TypeError);
    expect(() => h.memo.settings.get("template")).toThrow(TypeError);
    h.finishLoad();
    // 특례가 사라졌으므로 브리지로 나간 settings.get 호출이 없어야 한다.
    expect(h.posted.find((m) => m.call === "settings.get")).toBeUndefined();
  });

  /**
   * 가드(무음 손상 회귀): `memo.runtime.*`도 원시값 검사를 건너뛰지 않는다.
   *
   * 왜: 예전에는 `if (ns === "runtime")` 분기가 검사보다 **앞**에 있어 원시 인자가 그대로
   * 브리지로 나갔다. 호스트는 `args.message`를 읽으므로 진단 「최근 오류」에는 내용 없는
   * 빈 줄만 쌓였고(성공 응답까지 돌아온다), 불투명 origin이라 devtools도 못 붙는 저작자는
   * 유일한 피드백 채널에서 메시지를 통째로 잃었다.
   */
  it("normalizes runtime.log(string) instead of dropping the message", async () => {
    const h = runBootstrap();
    void h.memo.runtime.log("부팅 실패: PERMISSION_DENIED");
    h.finishLoad();
    expect(h.posted.find((m) => m.call === "runtime.log")?.args).toEqual({
      message: "부팅 실패: PERMISSION_DENIED",
    });
    h.respondAll();
    await tick();
  });

  /** 가드: 정규화하는 것은 `runtime.log` 하나뿐 — 다른 runtime 호출의 원시 인자는 던진다. */
  it("throws on a primitive argument to other runtime calls", () => {
    const h = runBootstrap();
    expect(() => h.memo.runtime.info("왜")).toThrow(TypeError);
    expect(h.posted.filter((m) => m.type === "call")).toHaveLength(0);
  });

  /** 가드: 인자를 아예 안 주는 호출은 빈 객체로 나간다(기존 계약 유지). */
  it("sends an empty object when no argument is given", async () => {
    const h = runBootstrap();
    void h.memo.notes.current();
    h.finishLoad();
    h.respondAll();
    await tick();
    expect(h.posted.find((m) => m.call === "notes.current")?.args).toEqual({});
  });
});

describe("sandbox bootstrap — 범용 핸들러 프리미티브", () => {
  /**
   * 가드: 호출 이름과 무관하게 인자 안의 **모든 함수 값**이 `<키>$id`로 치환된다.
   * 왜: 콜백을 받는 신규 API(이벤트·커맨드·메뉴·폼)가 각자 부트스트랩 특례를 만들지 않게
   * 하는 바닥이다 — 없으면 그 API들이 CSP 해시를 여섯 번 갱신하게 만든다.
   */
  it("swaps every function argument for a handler id, whatever the call is", () => {
    const h = runBootstrap();
    void h.memo.commands.register({
      id: "c1",
      run: () => {},
      onDone: () => {},
      title: "커맨드",
    });
    h.finishLoad();
    const args = h.posted.find((m) => m.call === "commands.register")?.args;
    expect(args).toMatchObject({ id: "c1", title: "커맨드" });
    expect(typeof args?.run$id).toBe("string");
    expect(typeof args?.onDone$id).toBe("string");
    // 함수 자체는 절대 실려 나가지 않는다(postMessage가 직렬화할 수 없다).
    expect(args).not.toHaveProperty("run");
    expect(args).not.toHaveProperty("onDone");
  });

  /** 가드(하위호환): 툴바 버튼의 `buttonId`는 `onClick$id`와 **같은 문자열**이다 —
   *  스냅샷·노트 창·중앙 호스트가 계속 그 이름으로 역호출한다. */
  it("keeps buttonId as an alias of onClick$id", () => {
    const h = runBootstrap();
    void h.memo.ui.addToolbarButton({ id: "t", label: "T", onClick: () => {} });
    h.finishLoad();
    const args = h.posted.find((m) => m.call === "ui.addToolbarButton")?.args;
    expect(args?.buttonId).toBe(args?.onClick$id);
  });

  /** 가드: 호스트는 `handlerId` + `payload`로 임의의 핸들러를 역호출하고, 핸들러는
   *  (바인딩된 memo, payload) 두 인자를 받는다. */
  it("invokes an arbitrary handler by handlerId with a payload", () => {
    const h = runBootstrap();
    const seen: unknown[] = [];
    void h.memo.events.on({
      name: "note:opened",
      handler: (_memo: MemoBridge, payload: unknown) => seen.push(payload),
    });
    h.finishLoad();
    const hid = String(
      h.posted.find((m) => m.call === "events.on")?.args?.handler$id ?? "",
    );
    expect(hid).not.toBe("");
    h.deliver({
      type: "invoke",
      handlerId: hid,
      token: "inv-A",
      payload: { id: "n1" },
    });
    expect(seen).toEqual([{ id: "n1" }]);
  });

  /** 가드: 역호출된 핸들러의 payload 파생 호출도 그 클릭의 토큰을 물고 나간다. */
  it("binds the invocation token inside a payload handler", async () => {
    const h = runBootstrap();
    void h.memo.events.on({
      name: "note:opened",
      handler: (memo: MemoBridge) => void memo.ui.toast({ title: "왔다" }),
    });
    h.finishLoad();
    const hid = String(
      h.posted.find((m) => m.call === "events.on")?.args?.handler$id ?? "",
    );
    h.deliver({ type: "invoke", handlerId: hid, token: "inv-Z" });
    await tick(1);
    expect(h.posted.find((m) => m.call === "ui.toast")?.ctx).toBe("inv-Z");
  });
});

describe("sandbox bootstrap — memo.runtime.*", () => {
  /**
   * 가드(계약): `memo.runtime.ready()`가 등록 마감을 **즉시** 확정한다 — 미해결 브리지
   * 호출이 남아 있어도 더 기다리지 않는다.
   *
   * 왜: 지금까지 마감 시점은 `waitQuiet` 휴리스틱에만 있어 저작자가 관측할 방법이 없었다.
   * 사람은 시행착오로 배우지만 AI는 배울 근거가 아예 없다.
   */
  it("closes registration immediately on runtime.ready()", async () => {
    const h = runBootstrap();
    void h.memo.settings.get({ key: "mode" }); // 응답자 없음 — 폴백이라면 3초를 기다린다.
    h.finishLoad();
    expect(h.ready()).toBeUndefined();
    void h.memo.runtime.ready();
    expect(h.ready()).toEqual({ __memo: true, type: "ready" });
  });

  /** 가드: ready()는 브리지 왕복이 아니다 — 그 호출 자체가 미해결로 잡혀 자기 마감을
   *  미루면 계약이 성립하지 않는다. */
  it("does not send runtime.ready over the bridge", async () => {
    const h = runBootstrap();
    h.finishLoad();
    await h.memo.runtime.ready();
    expect(h.order()).not.toContain("runtime.ready");
  });

  /** 가드: 반환값은 다른 호출과 같은 **진짜 Promise**다(정본이 예외를 갖지 않게). */
  it("returns a real Promise from runtime.ready()", async () => {
    const h = runBootstrap();
    h.finishLoad();
    const p = h.memo.runtime.ready();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeNull();
  });

  /** 가드: ready 외의 runtime 호출은 평범한 브리지 호출로 나간다(호스트가 응답한다). */
  it("sends runtime.info and runtime.log over the bridge", async () => {
    const h = runBootstrap();
    void h.memo.runtime.info();
    void h.memo.runtime.log({ message: "부팅" });
    h.finishLoad();
    expect(h.order()).toEqual(
      expect.arrayContaining(["runtime.info", "runtime.log"]),
    );
    h.respondAll();
    await tick();
  });

  /** 가드: 마감 후 다시 불러도 ready는 한 번만 나간다(멱등). */
  it("is idempotent when called twice", async () => {
    const h = runBootstrap();
    h.finishLoad();
    await h.memo.runtime.ready();
    await h.memo.runtime.ready();
    expect(h.posted.filter((m) => m.type === "ready")).toHaveLength(1);
  });
});

describe("sandbox bootstrap — runtime.onDispose", () => {
  /** 가드: 정리 콜백 등록은 **브리지로 나가지 않는다**(ready와 같은 로컬 가로채기).
   * 나가면 호스트가 파괴 직전에 또 한 번 왕복해야 하고, 그 시점엔 이미 파괴 대기 중이다. */
  it("registers the handler locally without a bridge call", async () => {
    const h = runBootstrap();
    const p = h.memo.runtime.onDispose({ handler: () => {} });
    h.finishLoad();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeNull();
    expect(h.order()).not.toContain("runtime.onDispose");
  });

  /** 가드(핵심): 호스트의 dispose 통지가 등록 순서대로 핸들러를 돌리고 ack를 회신한다 —
   * ack가 없으면 호스트는 상한(300ms)만큼 헛기다린 뒤 파괴한다. */
  it("runs handlers in order and acknowledges with 'disposed'", async () => {
    const h = runBootstrap();
    const ran: string[] = [];
    void h.memo.runtime.onDispose({ handler: () => ran.push("a") });
    void h.memo.runtime.onDispose({ handler: () => ran.push("b") });
    h.finishLoad();

    h.deliver({ type: "dispose" });
    await tick(1);
    expect(ran).toEqual(["a", "b"]);
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(1);
  });

  /** 가드: 핸들러가 하나도 없어도 **반드시** ack한다 — 안 하면 번들 20개가 매 재빌드마다
   * 상한을 다 쓰고 죽어 설정 변경 한 번이 그만큼 느려진다. */
  it("acknowledges immediately when nothing registered a handler", async () => {
    const h = runBootstrap();
    h.finishLoad();
    h.deliver({ type: "dispose" });
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(1);
  });

  /** 가드: 핸들러가 프라미스를 돌려주면 그것이 정착한 **뒤에** ack한다(그 전에 ack하면
   * 호스트가 곧바로 파괴해 마지막 flush가 통째로 사라진다). */
  it("waits for a returned promise before acknowledging", async () => {
    const h = runBootstrap();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    void h.memo.runtime.onDispose({ handler: () => gate });
    h.finishLoad();

    h.deliver({ type: "dispose" });
    await tick(1);
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(0);
    release();
    await tick(1);
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(1);
  });

  /** 가드: 던지는 핸들러 하나가 나머지 정리와 ack를 막지 않는다 — 대신 진단으로 남는다
   * (불투명 origin이라 이 기록이 저작자가 볼 수 있는 유일한 흔적이다). */
  it("survives a throwing handler: diagnostic recorded, ack still sent", async () => {
    const h = runBootstrap();
    const ran: string[] = [];
    void h.memo.runtime.onDispose({
      handler: () => {
        throw new Error("정리 실패");
      },
    });
    void h.memo.runtime.onDispose({ handler: () => ran.push("b") });
    h.finishLoad();

    h.deliver({ type: "dispose" });
    await tick(1);
    expect(ran).toEqual(["b"]);
    const diag = h.posted.find((m) => m.type === "diagnostic");
    expect(diag?.kind).toBe("onclick-throw");
    expect(diag?.message).toBe("정리 실패");
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(1);
  });

  /** 가드: 통지가 두 번 와도 핸들러는 한 번만 돈다(재빌드 경합에서 이중 flush 방지). */
  it("runs dispose handlers at most once", async () => {
    const h = runBootstrap();
    let calls = 0;
    void h.memo.runtime.onDispose({ handler: () => void (calls += 1) });
    h.finishLoad();

    h.deliver({ type: "dispose" });
    h.deliver({ type: "dispose" });
    await tick(1);
    expect(calls).toBe(1);
    expect(h.posted.filter((m) => m.type === "disposed")).toHaveLength(1);
  });

  /** 가드: 정리 핸들러도 첫 인자로 memo를 받는다(다른 역호출과 같은 규약) — 그 memo로
   * 마지막 저장을 걸 수 있어야 onDispose가 의미를 갖는다. */
  it("passes a memo bridge as the first argument", async () => {
    const h = runBootstrap();
    void h.memo.runtime.onDispose({
      handler: (bound: MemoBridge) =>
        bound.settings.set({ key: "draft", value: "x" }),
    });
    h.finishLoad();
    h.deliver({ type: "dispose" });
    await tick(1);
    expect(h.order()).toContain("settings.set");
  });
});

describe("sandbox bootstrap — events.on 핸들러 전달", () => {
  /** 가드: 구독 핸들러도 범용 프리미티브로 치환되고, 호스트가 읽는 별칭(handlerId)이
   * 함께 실린다 — 별칭이 없으면 호스트는 이 구독을 역호출할 키를 모른다. */
  it("swaps handler to an id and adds the handlerId alias", () => {
    const h = runBootstrap();
    void h.memo.events.on({ name: "note:saved", handler: () => {} });
    h.finishLoad();
    const call = h.posted.find((m) => m.call === "events.on");
    expect(call?.args?.handler).toBeUndefined(); // 함수는 직렬화되지 않는다
    expect(typeof call?.args?.["handler$id"]).toBe("string");
    expect(call?.args?.handlerId).toBe(call?.args?.["handler$id"]);
  });

  /** 가드(핵심): 이벤트 역호출은 버튼 클릭과 **같은 경로**를 탄다 — 첫 인자의 바인딩된
   * memo가 그 이벤트의 창 토큰을 물고, 페이로드가 둘째 인자로 온다. 이게 깨지면 A 창의
   * 저장 알림이 B 창에 뜬다(버튼에서 이미 겪은 데이터 손상과 같은 유형). */
  it("invokes the handler with a window-bound memo and the payload", async () => {
    const h = runBootstrap();
    let seen: unknown = null;
    void h.memo.events.on({
      name: "note:saved",
      handler: (bound: MemoBridge, payload: unknown) => {
        seen = payload;
        return bound.ui.toast({ title: "저장됨" });
      },
    });
    h.finishLoad();
    const hid = h.posted.find((m) => m.call === "events.on")?.args?.handlerId;

    // 호스트가 그 이벤트의 창 토큰·페이로드를 실어 되부른다.
    h.deliver({
      type: "invoke",
      handlerId: hid,
      token: "inv-9",
      payload: { name: "note:saved", noteId: "n1" },
    });
    await tick(1);
    expect(seen).toEqual({ name: "note:saved", noteId: "n1" });
    const toast = h.posted.find((m) => m.call === "ui.toast");
    expect(toast?.ctx).toBe("inv-9");
  });
});
