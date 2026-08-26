import { t } from "../i18n/t";

/**
 * 모달 입력 다이얼로그(URL 등 한 줄 텍스트) + 그 일반형인 다중 필드 다이얼로그.
 *
 * 역할: [confirm-dialog](./confirm-dialog)와 같은 카드 오버레이 구조로 텍스트 입력을 받는다.
 * host에 오버레이를 띄우고 확인(trim된 입력값) / 취소(null)를 Promise로 돌려준 뒤 DOM을
 * 정리한다. 컨텍스트 메뉴의 삽입 3종(이미지·유튜브·링크)이 URL 검증 규칙 하나만 다르고 나머지
 * 구조(카드·버튼·키보드)는 완전히 같아, confirm-dialog와 같은 자리에 재사용 컴포넌트로 둔다.
 * 왜: 되돌릴 수 없는 삽입(잘못된 URL이 그대로 본문에 박히는 사고)을 막으려면 확인 이전에
 * 검증이 끝나 있어야 한다 — validate가 거짓이면 확인 버튼이 비활성화되고 Enter도 무시된다.
 *
 * 이미지 크기 조정(너비·높이 두 칸)이 들어오면서 칸 개수만 다른 두 번째 다이얼로그가 필요해졌다.
 * 오버레이·Esc·바깥 클릭·정리 로직을 복사하지 않으려고 한 벌짜리 구현([`openFieldsDialog`])을
 * 정본으로 두고, [`inputDialog`]는 "칸이 하나뿐인" 얼굴로 남긴다 — 기존 호출부(삽입 3종)의
 * 시그니처·DOM 클래스는 물론 **resolve 시점(클릭과 같은 틱)**까지 그대로다.
 */
interface InputDialogOptions {
  /** input의 placeholder(선택). */
  placeholder?: string;
  /** input의 초기값(선택). */
  defaultValue?: string;
  /** 확인 버튼 문구(기본 note.popup.ok "확인"). */
  confirmLabel?: string;
  /**
   * trim된 입력값을 받아들일지 판정한다(기본: 비어 있지 않으면 통과). 거짓이면 확인 버튼이
   * 비활성화되고 Enter도 무시된다 — 값은 항상 trim되어 넘어온다.
   */
  validate?: (value: string) => boolean;
}

/**
 * [`fieldsDialog`]의 입력 칸 하나 — id는 결과 맵의 키다.
 *
 * export하지 않는다: 호출부는 객체 리터럴을 그대로 넘기므로 이름이 필요 없고, 내보내면
 * "쓰이지 않는 export"로만 남는다(knip 기준).
 */
interface DialogField {
  id: string;
  /** 칸 위에 붙는 라벨(없으면 라벨 없이 input만 — 기존 단일 입력과 같은 모양). */
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /**
   * 이 칸부터 새 가로 줄을 연다(첫 칸은 항상 새 줄 — 생략해도 무방). 생략하면 바로 앞
   * 칸과 같은 줄에 놓인다(기존 동작: 필드가 둘 이상이면 전부 한 줄에 나란히).
   *
   * 왜: URL처럼 폭 전체를 쓰는 칸과 너비·높이처럼 짝을 이루는 칸이 한 다이얼로그에
   * 섞일 때(이미지 추가 3필드), 짝인 칸끼리만 가로로 나란히 놓고 나머지는 제 줄을 쓰게
   * 한다. 기존 호출부(폭·높이 두 칸)는 아무 칸에도 `newRow`를 안 줘 여전히 한 줄이다.
   */
  newRow?: boolean;
}

/** [`fieldsDialog`]의 옵션 — 확인 문구·안내 한 줄·전체 값 검증. */
interface FieldsDialogOptions {
  /** 확인 버튼 문구(기본 note.popup.ok "확인"). */
  confirmLabel?: string;
  /** 메시지 아래 회색 안내 한 줄(선택) — 허용 범위·빈 값의 뜻 같은 규칙을 미리 알린다. */
  hint?: string;
  /**
   * trim된 값 맵 전체를 받아 받아들일지 판정한다(기본: 항상 통과). 거짓이면 확인 버튼이
   * 비활성화되고 Enter도 무시된다.
   */
  validate?: (values: Record<string, string>) => boolean;
}

/** [`inputDialog`]가 내부적으로 쓰는 단일 칸의 id(호출부에는 드러나지 않는다). */
const SINGLE_FIELD = "value";

/**
 * 모달 입력 다이얼로그를 띄운다.
 *
 * 확인(버튼 클릭 또는 유효한 값에서 Enter)이면 trim된 입력값, 취소(취소 버튼/Esc/바깥 클릭)면
 * null로 resolve한다.
 */
export function inputDialog(
  host: HTMLElement,
  message: string,
  options: InputDialogOptions = {},
): Promise<string | null> {
  const validate = options.validate ?? ((value: string) => value.length > 0);
  return openFieldsDialog(
    host,
    message,
    [
      {
        id: SINGLE_FIELD,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
      },
    ],
    {
      confirmLabel: options.confirmLabel,
      validate: (values) => validate(values[SINGLE_FIELD]),
    },
    (values) => values[SINGLE_FIELD],
  );
}

/**
 * 여러 칸을 한 카드에서 받는 모달 다이얼로그를 띄운다.
 *
 * 확인(버튼 클릭 또는 유효한 값에서 Enter)이면 `{ 필드id: trim된 값 }` 맵, 취소(취소 버튼/Esc/
 * 바깥 클릭)면 null로 resolve한다. 칸이 둘 이상이면 가로로 나란히 놓는다(너비·높이처럼 짝을
 * 이루는 값이 한눈에 비교되도록).
 */
export function fieldsDialog(
  host: HTMLElement,
  message: string,
  fields: readonly DialogField[],
  options: FieldsDialogOptions = {},
): Promise<Record<string, string> | null> {
  return openFieldsDialog(host, message, fields, options, (values) => values);
}

/**
 * 두 얼굴([`inputDialog`]·[`fieldsDialog`])이 공유하는 실제 구현.
 *
 * `map`으로 결과 모양만 갈아 끼운다 — 이 층에서 값을 바로 변환해 resolve하므로, 단일 입력
 * 호출부가 보던 "확인 클릭과 같은 틱에 resolve된다"는 타이밍이 유지된다(`.then` 한 겹을 더
 * 얹으면 마이크로태스크가 하나 늘어 기존 호출·테스트의 대기 횟수가 어긋난다).
 */
function openFieldsDialog<T>(
  host: HTMLElement,
  message: string,
  fields: readonly DialogField[],
  options: FieldsDialogOptions,
  map: (values: Record<string, string>) => T,
): Promise<T | null> {
  const validate = options.validate ?? (() => true);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const box = document.createElement("div");
    box.className = "confirm-box";

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = message;
    box.append(msg);

    if (options.hint) {
      const hint = document.createElement("p");
      hint.className = "confirm-hint";
      hint.textContent = options.hint;
      box.append(hint);
    }

    // 칸을 가로 줄 단위로 묶는다 — `newRow`가 없으면 바로 앞 칸과 같은 줄(첫 칸은 항상 새
    // 줄). 기존 호출부(폭·높이처럼 아무 칸도 newRow를 안 주는 경우)는 모든 칸이 줄 하나에
    // 묶여 기존과 동일하게 렌더된다.
    const fieldRows: DialogField[][] = [];
    for (const field of fields) {
      if (field.newRow || fieldRows.length === 0) fieldRows.push([field]);
      else fieldRows[fieldRows.length - 1].push(field);
    }

    const inputs = fieldRows.flatMap((rowFields) => {
      const row = document.createElement("div");
      row.className =
        rowFields.length > 1
          ? "confirm-fields confirm-fields--row"
          : "confirm-fields";
      const rowInputs = rowFields.map((field) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "plugin-popup-input";
        input.placeholder = field.placeholder ?? "";
        input.value = field.defaultValue ?? "";
        if (field.label === undefined) {
          row.append(input);
        } else {
          // label로 감싼다 — 라벨 글자를 눌러도 그 칸으로 포커스가 간다(for/id 배선 없이).
          const wrap = document.createElement("label");
          wrap.className = "confirm-field";
          const text = document.createElement("span");
          text.className = "confirm-field-label";
          text.textContent = field.label;
          wrap.append(text, input);
          row.append(wrap);
        }
        return [field.id, input] as const;
      });
      box.append(row);
      return rowInputs;
    });

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "confirm-cancel";
    cancel.textContent = t("note.confirm.cancel");

    const ok = document.createElement("button");
    ok.type = "button";
    // confirm-ok(빨간 위험색)이 아니라 plugin-popup-ok(강조색)를 쓴다 — 삽입·크기 조정은
    // 삭제 같은 파괴적 동작이 아니다.
    ok.className = "plugin-popup-ok";
    ok.textContent = options.confirmLabel ?? t("note.popup.ok");

    const values = (): Record<string, string> =>
      Object.fromEntries(inputs.map(([id, input]) => [id, input.value.trim()]));

    let done = false;
    const close = (result: T | null): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };

    const submit = (): void => {
      const current = values();
      if (!validate(current)) return;
      close(map(current));
    };

    const syncOkState = (): void => {
      ok.disabled = !validate(values());
    };
    syncOkState();

    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", submit);
    for (const [, input] of inputs) {
      input.addEventListener("input", syncOkState);
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submit();
      });
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    // 바깥(오버레이) 클릭은 취소로 처리.
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(null);
    });

    actions.append(cancel, ok);
    box.append(actions);
    overlay.append(box);
    host.append(overlay);
    queueMicrotask(() => inputs[0]?.[1].focus());
  });
}
