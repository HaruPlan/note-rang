/**
 * IME(한글 등) 조합 확정 Enter에서 리스트 마커 이어쓰기 보정.
 *
 * 역할: 조합을 확정하는 Enter는 `isComposing=true`(또는 IME 조합 keyCode 229)라 CM이
 * Enter 키바인딩(`insertNewlineContinueMarkup`)을 실행하지 않는다 → 조합 직후 Enter가
 * `- `, `- [ ]`, `1.` 같은 마커를 이어쓰지 못한다("있다가 없다가"의 원인: 조합 확정 Enter는
 * IME가 소비해 개행조차 없고, 한 번 더 눌러야 CM이 이어쓴다). 조합이 끝나면 이어쓰기
 * 커맨드를 한 번 재실행해 단일 Enter로 이어지게 한다.
 *
 * 왜 raw DOM 리스너인가: CM은 조합 중 keydown을 `ignoreDuringComposition`으로 자기 핸들러
 * 디스패치에서 건너뛴다 — Enter 키바인딩뿐 아니라 `EditorView.domEventHandlers`의 keydown도
 * 같은 게이트에 걸린다(@codemirror/view의 InputState.handleEvent). 우리가 노리는 "조합 확정
 * Enter"가 바로 그 케이스라, CM 핸들러 경로로는 관측이 안 된다. 그래서 `view.dom`에 게이트를
 * 우회하는 raw keydown/compositionend 리스너를 직접 달아 그 Enter를 잡는다. 판정 로직은 순수
 * 함수로 분리해 테스트하고, 실제 조합 타이밍은 WKWebView에서 육안 검증한다.
 */
import { EditorView, ViewPlugin, type PluginValue } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";

/** keydown 판정에 필요한 최소 필드(테스트에서 평범한 객체로 주입 가능). */
export interface KeydownLike {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * keydown이 "조합을 확정하는 Enter"인지 판정한다(순수).
 *
 * 조합 중(`isComposing`) 또는 IME 합성 keyCode(229)로 들어온 Enter만 대상으로 한다 —
 * 이 경우 CM이 키바인딩을 건너뛰므로 우리가 보정한다. 일반 Enter(keyCode 13, 비조합)는
 * CM이 처리하므로 대상에서 제외(이중 실행 방지). Shift+Enter도 제외(단순 줄바꿈 의도).
 */
export function isImeContinueEnter(e: KeydownLike): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  return e.isComposing || e.keyCode === 229;
}

/**
 * `view.dom`에 raw 리스너를 달아 조합 확정 Enter를 감지·보정하는 ViewPlugin.
 *
 * keydown·compositionend 어느 순서로 와도(WebKit은 둘의 순서가 엇갈릴 수 있다) 한 번만
 * 실행되도록, 두 이벤트 모두에서 flush를 예약하고 `view.composing`으로 조합 종료를 확인한
 * 뒤 `pending` 플래그로 중복을 막는다.
 */
class ImeContinue implements PluginValue {
  private pending = false;

  constructor(private readonly view: EditorView) {
    // capture=true: CM의 조합 게이트/핸들러와 무관하게 조합 중 keydown도 확실히 받는다.
    view.dom.addEventListener("keydown", this.onKeydown, true);
    view.dom.addEventListener("compositionend", this.onCompositionEnd);
    // 포커스가 빠지면 대기 상태를 정리(엉뚱한 나중 조합에 이어쓰기가 새지 않게).
    view.dom.addEventListener("focusout", this.onFocusOut);
  }

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (isImeContinueEnter(e)) {
      this.pending = true;
      requestAnimationFrame(this.flush);
    } else if (!e.isComposing) {
      this.pending = false; // 일반 키 입력이 들어오면 대기 플래그 해제.
    }
  };

  private readonly onCompositionEnd = (): void => {
    if (this.pending) requestAnimationFrame(this.flush);
  };

  private readonly onFocusOut = (): void => {
    this.pending = false;
  };

  private readonly flush = (): void => {
    // 조합이 아직 진행 중이면 미룬다(다른 이벤트가 예약한 flush가 다시 시도).
    if (!this.pending || this.view.composing) return;
    this.pending = false;
    insertNewlineContinueMarkup(this.view);
  };

  destroy(): void {
    this.view.dom.removeEventListener("keydown", this.onKeydown, true);
    this.view.dom.removeEventListener("compositionend", this.onCompositionEnd);
    this.view.dom.removeEventListener("focusout", this.onFocusOut);
  }
}

/** IME 조합 확정 Enter 보정 확장(위 [`ImeContinue`] ViewPlugin을 설치). */
export function imeListContinue(): Extension {
  return ViewPlugin.define((view) => new ImeContinue(view));
}
