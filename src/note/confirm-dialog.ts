import { t } from "../i18n/t";

/**
 * 모달 확인 다이얼로그.
 *
 * 역할: 되돌릴 수 없는 동작(영구 삭제) 전에 사용자 확인을 받는다. host에 오버레이를 띄우고
 * 선택(확인=true / 취소=false)을 Promise로 돌려준 뒤 DOM을 정리한다.
 * 왜: 실수로 인한 영구 삭제를 막는다. 네이티브 다이얼로그 의존 없이 테스트 가능.
 *
 * `alert` 모드면 취소 버튼 없이 확인만 두는 단순 안내 다이얼로그가 된다(예: "되돌릴 설정이 없어요").
 */
export function confirmDialog(
  host: HTMLElement,
  message: string,
  confirmLabel = t("note.confirm.ok"),
  options: { alert?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const box = document.createElement("div");
    box.className = "confirm-box";

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = message;

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirm-cancel";
    cancel.textContent = t("note.confirm.cancel");

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "confirm-ok";
    ok.textContent = confirmLabel;

    const close = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    // 바깥(오버레이) 클릭은 취소로 처리.
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(false);
    });

    // alert(단순 안내)면 확인만, 아니면 취소+확인.
    if (options.alert) actions.append(ok);
    else actions.append(cancel, ok);
    box.append(msg, actions);
    overlay.append(box);
    host.append(overlay);
    // 기본 포커스는 안전한 쪽이다: 확인 모드에서 실행(파괴) 버튼을 자동 포커스하면 반사적
    // Enter/Space가 숙고 없이 파괴를 확정해, 확인 팝업의 존재 이유를 스스로 무효화한다.
    // 취소 버튼이 없는 alert 모드만 확인이 포커스를 받는다.
    if (options.alert) ok.focus();
    else cancel.focus();
  });
}

/**
 * [`choiceDialog`]가 제시하는 선택지 하나.
 *
 * export하지 않는 이유: 호출부는 객체 리터럴을 그대로 넘기면 되고(구조적 타이핑), 이름을
 * 내보내면 아무도 import하지 않는 공개 표면만 늘어난다(knip이 "쓰이지 않는 export 타입"으로
 * 잡는 바로 그 모양).
 */
interface DialogChoice<T> {
  /** 버튼에 보일 문구. */
  label: string;
  /** 고르면 resolve될 값. */
  value: T;
  /** 되돌리기 어려운 쪽이면 true — 확인 버튼과 같은 경고색으로 그린다. */
  danger?: boolean;
}

/**
 * 선택지가 **셋 이상**인 모달 다이얼로그([`confirmDialog`]의 2지선다 확장).
 *
 * 역할: "예/아니오"로 접히지 않는 갈림길에 쓴다 — 저장 폴더 이전(이슈 #21)의
 * "파일을 함께 이동 / 이동하지 않고 전환 / 취소"가 그 예다. 이런 질문을 확인 팝업 두 번으로
 * 쪼개면 사용자가 두 번째 질문의 맥락(첫 답이 무엇이었는지)을 잃는다.
 *
 * 취소(버튼·오버레이 바깥 클릭)는 `null`로 resolve한다 — 선택 값과 취소가 타입으로 구분된다.
 * 오버레이·카드는 [`confirmDialog`]와 **같은 CSS 클래스**를 쓴다(룩이 갈라지지 않게).
 */
export function choiceDialog<T>(
  host: HTMLElement,
  message: string,
  choices: readonly DialogChoice<T>[],
  cancelLabel: string = t("note.confirm.cancel"),
): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const box = document.createElement("div");
    box.className = "confirm-box";

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = message;

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const close = (result: T | null) => {
      overlay.remove();
      resolve(result);
    };

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirm-cancel";
    cancel.textContent = cancelLabel;
    cancel.addEventListener("click", () => close(null));
    actions.append(cancel);

    for (const choice of choices) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = choice.danger ? "confirm-ok" : "confirm-choice";
      btn.textContent = choice.label;
      btn.addEventListener("click", () => close(choice.value));
      actions.append(btn);
    }

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(null);
    });

    box.append(msg, actions);
    overlay.append(box);
    host.append(overlay);
    // confirmDialog와 같은 근거로 취소에 기본 포커스를 준다 — 반사적 Enter가 되돌리기 어려운
    // 쪽을 확정하지 않게.
    cancel.focus();
  });
}
