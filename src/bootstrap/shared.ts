/**
 * 부트스트랩 공통 유틸 — 창 종류와 무관하게 필요한 최소 조각만 모은다.
 *
 * 왜 별도 파일인가: `main.ts`는 모든 창이 공유하는 유일한 정적 진입점이라, 여기서 무거운
 * 모듈(예: 노트 에디터의 CodeMirror, 설정·패널·플러그인호스트 화면 전체)을 끌어오면 그
 * 창을 안 여는 창까지 그 비용을 치른다(이슈 #26). 각 창 종류의 부트스트랩은
 * `src/bootstrap/<kind>.ts`로 나뉘어 `main.ts`에서 동적 `import()`로만 로드되고, 이 파일은
 * 그 네 갈래 전부가 공통으로 필요로 하는 가벼운 조각(이벤트 브리지·대기 상한)만 담는다 —
 * `shared/tauri.ts`·`plugin/host-protocol.ts` 둘 다 CodeMirror나 다른 창 화면 코드를
 * 끌어오지 않으므로, 이 파일을 모든 부트스트랩 청크가 나눠 가져도 무겁지 않다.
 */
import type { HostEventBus } from "../plugin/host-protocol";
import { emitAppEvent, onAppEvent } from "../shared/tauri";

/** Tauri 전역 이벤트를 플러그인 호스트 프로토콜의 버스로 감싼다(전송 계층 어댑터). */
export function tauriBus(): HostEventBus {
  return {
    emit: (event, payload) => void emitAppEvent(event, payload),
    listen: (event, handler) => onAppEvent(event, handler),
  };
}

/**
 * 테마 확정용 스냅샷 대기 상한(ms) — 정상 경로(호스트 즉시 응답)에는 영향이 없고,
 * 호스트 이상(창은 있으나 웹뷰 무응답) 시에도 노트 열림이 이 시간 이상 막히지 않는다.
 */
export const THEME_WAIT_MS = 1000;
