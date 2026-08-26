/**
 * 샌드박스 배선 가드 — createPluginSandbox의 메시지 핸들러가 실제로 하는 일을 검증한다.
 *
 * 역할: iframe 브리지의 **호스트 쪽 절반**(boot→run, ready 성공/거부, call→execute(ctx))을
 * 실제 jsdom iframe 위에서 직접 돌려 못박는다. 부트스트랩 원문 동작은 sandbox-bootstrap.test.ts가
 * (가짜 realm에서) 따로 보고, 중앙 호스트 테스트는 가짜 팩토리로 이 파일을 우회하므로 —
 * 이 파일이 없으면 sandbox.ts의 안전장치는 **어떤 테스트도 통과하지 않는 코드**가 된다.
 * 왜: ready 거부 분기를 지우거나 `d.ctx` 필드명을 오타 내도 스위트 전체가 초록으로 남던
 * 사각지대를 없앤다(실행에 실패한 플러그인이 "정상"으로 보이고, 창-스코프 호출이 다시
 * 마지막 클릭 창으로 뒤집히는 회귀가 조용히 통과했다).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createPluginSandbox } from "./sandbox";
import type { BridgeResponse } from "./host";

/** 샌드박스 하나를 실제 jsdom 문서에 띄우고, 그 iframe으로 나가는 메시지를 가로챈다. */
function mountSandbox(code = "// plugin", withDiagnostics = false) {
  // 실제 execute와 같은 시그니처로 둔다 — 인자 타입이 살아 있어야 `mock.calls[i][2]`(ctx)를
  // 타입 안전하게 들여다볼 수 있다(0-인자 목이면 tsc가 인덱스 2를 거부한다).
  const execute = vi.fn(
    async (
      _call: string,
      _args: Record<string, unknown>,
      _ctx?: string,
    ): Promise<BridgeResponse> => ({ ok: true as const, result: null }),
  );
  const onDiagnostic = vi.fn();
  const sandbox = createPluginSandbox(
    document,
    code,
    execute,
    withDiagnostics ? onDiagnostic : undefined,
  );
  const frame = document.querySelector<HTMLIFrameElement>(
    "iframe[data-plugin-sandbox]",
  );
  if (!frame?.contentWindow) throw new Error("샌드박스 iframe이 없다");
  const win = frame.contentWindow;
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(win, "postMessage").mockImplementation((msg: unknown) => {
    posted.push(msg as Record<string, unknown>);
  });

  /** 샌드박스가 부모로 보낸 것처럼 메시지를 주입한다(`source`까지 그 iframe으로). */
  const fromSandbox = (data: Record<string, unknown>) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __memo: true, ...data },
        source: win,
      }),
    );
  };

  return { sandbox, execute, posted, fromSandbox, win, onDiagnostic };
}

describe("createPluginSandbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** 가드: boot 신호를 받으면 플러그인 코드를 `run`으로 되돌려준다(실행 시작 배선). */
  it("sends the plugin code back on boot", () => {
    const { posted, fromSandbox } = mountSandbox("console.log(1)");
    fromSandbox({ type: "boot" });
    expect(posted).toEqual([
      { __memo: true, type: "run", code: "console.log(1)" },
    ]);
  });

  /** 가드(핵심): 부트스트랩이 실은 실패 사유는 `ready`의 **거부**로 이어진다 — 이 분기가
   * 사라지면 실행에 실패한 빈 껍데기 플러그인이 스냅샷에 "정상"으로 실린다. */
  it("rejects ready with the reason the bootstrap reported", async () => {
    const { sandbox, fromSandbox } = mountSandbox();
    fromSandbox({ type: "ready", error: "스크립트 실행 오류" });
    await expect(sandbox.ready).rejects.toThrow("스크립트 실행 오류");
  });

  /** 가드: 사유 없는 ready는 정상 해소다(성공 경로가 거부로 뒤집히지 않는다). */
  it("resolves ready when no error is reported", async () => {
    const { sandbox, fromSandbox } = mountSandbox();
    fromSandbox({ type: "ready" });
    await expect(sandbox.ready).resolves.toBeUndefined();
  });

  /** 가드(핵심): 호출 메시지의 `ctx`(창-스코프 토큰)가 execute의 **세 번째 인자**로 그대로
   * 전달된다 — 이 배선이 끊기면 창-스코프 호출이 다시 "마지막 클릭 창"으로 폴백해
   * A에서 누른 결과가 B에 꽂힌다. */
  it("passes the call ctx token through to execute", () => {
    const { execute, fromSandbox } = mountSandbox();
    fromSandbox({
      type: "call",
      id: 7,
      call: "editor.insertText",
      args: { text: "x" },
      ctx: "inv-1",
    });
    expect(execute).toHaveBeenCalledWith(
      "editor.insertText",
      { text: "x" },
      "inv-1",
    );
  });

  /** 가드: ctx가 없는 호출은 세 번째 인자가 undefined다(호스트가 "토큰 없음"으로 보고
   * 폴백 경로를 쓰게 한다 — 문자열이 아닌 값도 undefined로 정규화된다). */
  it("leaves ctx undefined when the call carries none", () => {
    const { execute, fromSandbox } = mountSandbox();
    fromSandbox({ type: "call", id: 1, call: "ui.toast", args: {} });
    fromSandbox({ type: "call", id: 2, call: "ui.toast", args: {}, ctx: 42 });
    expect(execute.mock.calls.map((c) => c[2])).toEqual([undefined, undefined]);
  });

  /** 가드: 실행 결과가 같은 id의 `response`로 iframe에 돌아간다(요청/응답 짝 맞추기). */
  it("replies to the sandbox with the execute result under the same id", async () => {
    const { posted, fromSandbox } = mountSandbox();
    fromSandbox({ type: "call", id: 9, call: "ui.toast", args: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([
      { __memo: true, type: "response", id: 9, ok: true, result: null },
    ]);
  });

  /** 가드(보안): 이 iframe이 아닌 곳에서 온 메시지는 무시한다 — 다른 창·다른 샌드박스가
   * 남의 브리지로 특권 호출을 밀어 넣지 못하게 하는 `e.source` 검사. */
  it("ignores messages that did not come from its own iframe", () => {
    const { execute } = mountSandbox();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __memo: true, type: "call", id: 1, call: "ui.toast", args: {} },
        source: window,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: dispose가 iframe과 리스너를 모두 걷어낸다(정리 뒤 메시지는 아무 일도 안 한다). */
  it("removes the iframe and stops listening on dispose", () => {
    const { sandbox, execute, fromSandbox } = mountSandbox();
    sandbox.dispose();
    expect(document.querySelector("iframe[data-plugin-sandbox]")).toBeNull();
    fromSandbox({ type: "call", id: 1, call: "ui.toast", args: {} });
    expect(execute).not.toHaveBeenCalled();
  });

  /** 가드: invoke는 역호출할 핸들러 id와 토큰을 함께 실어 보낸다(핸들러가 어느 창의
   * 클릭인지 되짚을 수 있는 유일한 통로). payload가 없으면 그 필드를 싣지 않는다 —
   * 버튼 클릭 경로의 메시지 모양이 예전과 같게 유지된다. */
  it("forwards the invoked handlerId with its invocation token", () => {
    const { sandbox, posted } = mountSandbox();
    sandbox.invoke("btn:3", "inv-9");
    expect(posted).toEqual([
      { __memo: true, type: "invoke", handlerId: "btn:3", token: "inv-9" },
    ]);
  });

  /** 가드: payload를 주면 그대로 실려 나간다 — 콜백에 이벤트 데이터를 넘기는
   * 범용 역호출 경로(이벤트·커맨드·폼)가 이 필드 위에 선다. */
  it("carries an optional payload to the handler", () => {
    const { sandbox, posted } = mountSandbox();
    sandbox.invoke("h:7", "inv-1", { note: "n1" });
    expect(posted).toEqual([
      {
        __memo: true,
        type: "invoke",
        handlerId: "h:7",
        token: "inv-1",
        payload: { note: "n1" },
      },
    ]);
  });

  /**
   * 가드(회귀): 샌드박스가 스스로 올린 내부 실패(`type: "diagnostic"`)가 콜백으로 올라간다 —
   * 이 분기가 없으면 onClick 예외·미처리 rejection이 「최근 오류」에 영영 도달하지 않는다.
   */
  it("forwards sandbox-reported diagnostics to the callback", () => {
    const { onDiagnostic, fromSandbox } = mountSandbox("// plugin", true);
    fromSandbox({
      type: "diagnostic",
      kind: "onclick-throw",
      message: "의도적 폭발",
    });
    fromSandbox({
      type: "diagnostic",
      kind: "unhandled-rejection",
      message: "거부됨",
      call: "notes.current",
      code: "PERMISSION_UNDECLARED",
    });
    expect(onDiagnostic.mock.calls.map((c) => c[0])).toEqual([
      { kind: "onclick-throw", message: "의도적 폭발" },
      {
        kind: "unhandled-rejection",
        message: "거부됨",
        call: "notes.current",
        code: "PERMISSION_UNDECLARED",
      },
    ]);
  });

  /**
   * 가드(보안): 샌드박스는 **호스트가 자기 눈으로 관측한** 종류를 사칭할 수 없다.
   *
   * 왜: `kind`는 불투명 origin iframe이 보낸 문자열이다. 그대로 받으면 플러그인이
   * `call-reject`·`setting-write-rejected` 같은 기록을 지어내 「최근 오류」를 오염시키고,
   * 저작자·사용자가 진짜 거부와 구분할 방법이 없어진다.
   */
  it("drops diagnostics whose kind is not sandbox-reportable", () => {
    const { onDiagnostic, fromSandbox } = mountSandbox("// plugin", true);
    for (const kind of ["call-reject", "log", "made-up", 42]) {
      fromSandbox({ type: "diagnostic", kind, message: "사칭" });
    }
    expect(onDiagnostic).not.toHaveBeenCalled();
  });
});

describe("createPluginSandbox — 파괴 직전 통지", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** 가드: 통지는 샌드박스로 `type: "dispose"` 메시지를 보내고, 회신이 오면 true로 풀린다. */
  it("posts a dispose message and resolves true on the ack", async () => {
    const { sandbox, posted, fromSandbox } = mountSandbox();
    const settled = sandbox.notifyDispose(1000);
    expect(posted[posted.length - 1]).toEqual({
      __memo: true,
      type: "dispose",
    });
    fromSandbox({ type: "disposed" });
    await expect(settled).resolves.toBe(true);
  });

  /** 가드(핵심): 회신이 없으면 상한에서 false로 풀린다 — 여기서 영영 기다리면 설정 변경
   * 한 번이 통째로 멈춘다(호출자가 false를 보고 진단만 남기고 파괴를 강행한다). */
  it("resolves false when the sandbox never acknowledges", async () => {
    vi.useFakeTimers();
    try {
      const { sandbox } = mountSandbox();
      const settled = sandbox.notifyDispose(300);
      let done = false;
      void settled.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(settled).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 늦게 도착한 회신은 아무것도 되돌리지 않는다(이미 false로 끝났고 곧 파괴된다). */
  it("ignores an ack that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { sandbox, fromSandbox } = mountSandbox();
      const settled = sandbox.notifyDispose(50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(settled).resolves.toBe(false);
      expect(() => fromSandbox({ type: "disposed" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 두 번째 통지는 보내지 않고 즉시 false다 — "정리가 끝났다"는 거짓말(true)을
   * 돌려주면 호출자가 flush됐다고 믿고 파괴한다. */
  it("refuses a second notification instead of claiming success", async () => {
    const { sandbox, posted, fromSandbox } = mountSandbox();
    const first = sandbox.notifyDispose(1000);
    fromSandbox({ type: "disposed" });
    await expect(first).resolves.toBe(true);
    const before = posted.filter((m) => m.type === "dispose").length;
    await expect(sandbox.notifyDispose(1000)).resolves.toBe(false);
    expect(posted.filter((m) => m.type === "dispose")).toHaveLength(before);
  });
});
