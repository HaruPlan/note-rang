/**
 * 플러그인 샌드박스 — 격리 iframe에서 플러그인 코드를 실행하고 postMessage 브리지로
 * 호스트와 통신한다.
 *
 * 역할: `sandbox="allow-scripts"`(allow-same-origin 없음 → 불투명 origin) iframe을 만들어
 * 플러그인 코드를 그 안에서만 실행한다. 플러그인은 부모 DOM/쿠키/스토리지에 접근할 수
 * 없고, 오직 `memo.*` 브리지(postMessage)로만 특권을 요청한다. 호스트는 들어온 요청을
 * 게이트키퍼(executor)로 검사한 뒤에만 처리한다.
 * 왜: 신뢰할 수 없는 플러그인 코드를 메인 realm에서 격리해 보안을 실질화한다.
 *
 * CSP: 부트스트랩은 인라인 스크립트라 CSP `script-src`의 고정 해시([`SANDBOX_BOOTSTRAP_CSP_HASH`])로
 * 정확히 1개만 허용되고, 플러그인 코드는 `eval`이 아니라 iframe 내부에서 만든 blob 스크립트로
 * 로드된다(script-src `blob:`). 그래서 `'unsafe-inline'`·`'unsafe-eval'` 없이 좁은 CSP에서 동작한다.
 */
import type { BridgeResponse } from "./host";
import { SANDBOX_BOOTSTRAP } from "./sandbox-bootstrap";
import { isSandboxDiagnosticKind, type DiagnosticKind } from "./diagnostics";

/**
 * 샌드박스가 **스스로** 올린 진단 1건(부트스트랩의 `type: "diagnostic"` 메시지).
 *
 * 역할: 호스트가 관측할 수 없는 실패 — 역호출 핸들러의 동기 예외와 미처리 rejection — 을
 * 중앙 호스트의 진단 링버퍼로 올린다. 인자는 실리지 않는다(부트스트랩이 아예 안 보낸다).
 */
export interface SandboxDiagnostic {
  kind: DiagnosticKind;
  message: string;
  /** 브리지 오류가 원인일 때의 호출명(예 `notes.current`). */
  call?: string;
  /** 브리지 오류가 원인일 때의 안정 코드. */
  code?: string;
}

/** 살아있는 샌드박스 인스턴스. */
interface PluginSandbox {
  /**
   * 플러그인 등록이 끝나면 해소된다. 로드/실행에 실패하면 사유를 담아 **거부**한다 —
   * 호출자(중앙 호스트)가 실패를 스냅샷 `failures`로 노출할 수 있게(조용한 유실 금지).
   */
  ready: Promise<void>;
  /**
   * 샌드박스에 보관된 핸들러를 역호출한다(툴바 버튼 클릭 등).
   *
   * `handlerId`는 등록 시 인자 안의 함수 값이 치환된 키다(`onClick$id` — 툴바 버튼 경로에서는
   * 스냅샷의 `buttonId`와 같은 문자열). `token`은 호스트가 발급한 불투명 호출 컨텍스트로,
   * 이 클릭에서 파생된 브리지 호출이 모두 함께 실어 보내 "어느 창의 클릭인가"를 호스트가
   * 되짚게 한다. `payload`는 핸들러의 둘째 인자로 전달된다(이벤트 데이터 등 — 버튼 클릭은
   * 싣지 않는다).
   */
  invoke(handlerId: string, token: string, payload?: unknown): void;
  /**
   * 파괴 직전 통지 — 샌드박스의 `runtime.onDispose` 핸들러를 돌리고 회신을 기다린다.
   *
   * `timeoutMs` 안에 회신하면 `true`, 아니면 `false`(호출자가 진단으로 남긴다). **어느 쪽이든
   * 실제 파괴는 호출자가 따로 [`dispose`]로 한다** — 이 호출은 기다림만 담당한다.
   *
   * 계약의 한계(정직하게): 상한을 넘긴 비동기 작업은 **완료되지 않는다**. 샌드박스가 곧
   * 파괴되므로 호스트가 무한정 기다릴 수 없고, 기다림이 길어지면 설정 변경 한 번이 그만큼
   * 느려진다. 동기적으로 끝나는 정리만 사실상 보장된다.
   */
  notifyDispose(timeoutMs: number): Promise<boolean>;
  /** iframe + 리스너를 정리한다. */
  dispose(): void;
}

/**
 * 격리 iframe 샌드박스를 만들어 플러그인 코드를 실행한다.
 *
 * `execute`는 게이트키퍼로 감싼 실행기 — 브리지 호출을 검사 후 처리하고 응답을 돌려준다.
 * 세 번째 인자 `ctx`는 샌드박스가 실어 보낸 호출 컨텍스트 토큰(없으면 undefined)으로,
 * 값의 해석은 전적으로 호스트 몫이다(샌드박스가 창 라벨을 직접 정하지 못하게 불투명 토큰).
 * 호스트는 이 iframe이 보낸 메시지만 받아들이고(`e.source` 확인), 모든 호출을 검사한다.
 *
 * `onDiagnostic`은 샌드박스가 스스로 올린 내부 실패(핸들러 예외·미처리 rejection)를 받는다 —
 * 주지 않으면 그 메시지는 버려진다(테마 샌드박스처럼 즉시 폐기되는 일시 실행 경로).
 */
export function createPluginSandbox(
  doc: Document,
  code: string,
  execute: (
    call: string,
    args: Record<string, unknown>,
    ctx?: string,
  ) => Promise<BridgeResponse>,
  onDiagnostic?: (entry: SandboxDiagnostic) => void,
): PluginSandbox {
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts"); // allow-same-origin 없음 = 불투명 origin
  frame.setAttribute("aria-hidden", "true");
  // 식별 마커: "샌드박스가 어느 창에 몇 개 살아있는가"를 e2e가 정확히 세도록 한다
  // (임베드 위젯 iframe 등 다른 iframe과 구분).
  frame.setAttribute("data-plugin-sandbox", "true");
  frame.style.display = "none";
  // 인라인 부트스트랩은 CSP `script-src`의 고정 해시로 정확히 1개만 허용된다(정적 문자열).
  // 플러그인 코드는 이 부트스트랩이 blob 스크립트로 로드한다(eval 없음).
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>${SANDBOX_BOOTSTRAP}</script>`;

  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  /** dispose 회신(`type: "disposed"`) 대기자 — 회신이 오면 한 번만 해소된다. */
  let onDisposed: (() => void) | null = null;
  /** 통지를 두 번 보내지 않는다(재빌드 중 중복 호출·앱 종료 경합 방어). */
  let disposeNotified = false;

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return; // 이 iframe의 메시지만
    const d = event.data as { __memo?: boolean; type?: string } & Record<
      string,
      unknown
    >;
    if (!d || d.__memo !== true) return;
    const win = frame.contentWindow;
    if (!win) return;

    if (d.type === "boot") {
      win.postMessage({ __memo: true, type: "run", code }, "*");
    } else if (d.type === "ready") {
      // 부트스트랩이 실은 실패 사유는 반드시 거부로 이어진다 — 빈 껍데기 플러그인이
      // "정상"으로 스냅샷에 실리던 조용한 유실을 막는다.
      const error = typeof d.error === "string" ? d.error : "";
      if (error) rejectReady(new Error(error));
      else resolveReady();
    } else if (d.type === "call") {
      const id = d.id;
      const call = typeof d.call === "string" ? d.call : "";
      const args = (d.args as Record<string, unknown>) ?? {};
      const ctx = typeof d.ctx === "string" ? d.ctx : undefined;
      void execute(call, args, ctx).then((res) => {
        win.postMessage({ __memo: true, type: "response", id, ...res }, "*");
      });
    } else if (d.type === "disposed") {
      // 정리 완료 회신 — 상한 안에 오면 대기가 즉시 풀린다.
      const waiter = onDisposed;
      onDisposed = null;
      waiter?.();
    } else if (d.type === "diagnostic") {
      // 신뢰 경계 밖 값이다: kind는 화이트리스트로 좁히고(호스트 관측 사실의 사칭 차단)
      // 나머지 필드는 문자열일 때만 싣는다(길이 절단은 진단 기록기가 한다).
      if (!isSandboxDiagnosticKind(d.kind)) return;
      onDiagnostic?.({
        kind: d.kind,
        message: typeof d.message === "string" ? d.message : "",
        ...(typeof d.call === "string" ? { call: d.call } : {}),
        ...(typeof d.code === "string" ? { code: d.code } : {}),
      });
    }
  };

  window.addEventListener("message", onMessage);
  doc.body.append(frame);

  return {
    ready,
    invoke: (handlerId: string, token: string, payload?: unknown) => {
      frame.contentWindow?.postMessage(
        // payload는 있을 때만 싣는다 — 버튼 클릭 경로의 메시지 모양을 그대로 유지한다.
        payload === undefined
          ? { __memo: true, type: "invoke", handlerId, token }
          : { __memo: true, type: "invoke", handlerId, token, payload },
        "*",
      );
    },
    notifyDispose: (timeoutMs: number) => {
      const win = frame.contentWindow;
      // 이미 통지했거나 창이 없으면(부팅 실패·이미 파괴) 기다릴 대상이 없다 — 즉시 실패로
      // 접는다. 여기서 true를 돌려주면 "정리가 끝났다"는 거짓말이 된다.
      if (disposeNotified || !win) return Promise.resolve(false);
      disposeNotified = true;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          onDisposed = null;
          resolve(false);
        }, timeoutMs);
        onDisposed = () => {
          clearTimeout(timer);
          resolve(true);
        };
        win.postMessage({ __memo: true, type: "dispose" }, "*");
      });
    },
    dispose: () => {
      window.removeEventListener("message", onMessage);
      frame.remove();
    },
  };
}
