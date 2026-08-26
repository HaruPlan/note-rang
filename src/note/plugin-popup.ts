/**
 * 노트 창이 대신 그려 주는 오버레이 UI — 목록 선택(pickList)·입력 폼(prompt)·컨텍스트 메뉴.
 *
 * 역할: 샌드박스 플러그인은 노트 창 DOM에 못 닿으므로, 창-스코프 서비스가 이 팝업들을 띄워
 * 사용자 선택/입력을 Promise로 돌려준다(취소=null). [confirm-dialog](./confirm-dialog)와 같은
 * 오버레이 카드 룩을 쓰고, 정확히 1회만 해소하며 DOM·리스너를 정리한다.
 * 왜: "버튼 → 목록에서 고르기"·"이름 붙여 저장"·"우클릭해서 실행" 같은 상호작용을 호스트가
 * 대신 그려준다(플러그인은 **선언 데이터만** 넘긴다 — 셀렉터도 DOM도 주지 않는다).
 *
 * 라벨·부제·필드 값은 전부 플러그인이 채우는 문자열이므로 **텍스트 노드로만** 넣는다
 * (`textContent`) — 이 파일에 `innerHTML`이 등장하면 안 된다.
 */
import { t } from "../i18n/t";

/** 문자열 필드의 상한(자) — 플러그인이 채우는 값이라 카드가 화면을 먹지 않게 자른다. */
const MAX_LABEL_LEN = 200;

/** 한 팝업이 받을 수 있는 항목·필드 수 상한(넘으면 잘라낸다 — 무한 목록 방지). */
const MAX_ITEMS = 200;

/** 문자열을 상한까지 자른다(비문자열은 빈 문자열). */
function clampLabel(raw: unknown): string {
  return String(raw ?? "").slice(0, MAX_LABEL_LEN);
}

/** 목록 항목에 붙는 액션 하나 — 생략하면 호스트가 기본 액션 `select` 하나를 만든다. */
interface PickAction {
  id: string;
  label: string;
  /** `destructive`면 빨간 강조(되돌릴 수 없는 동작). */
  style?: "default" | "destructive";
}

/** 목록 항목 하나(부제와 항목별 다중 액션). */
export interface PickItem {
  id: string;
  label: string;
  /** 라벨 아래 회색 보조 정보(경로·요약 등). */
  sublabel?: string;
  /** 이 항목에 붙는 액션들. 없으면 항목 자체가 하나의 `select` 액션이다. */
  actions?: PickAction[];
}

/** 목록 팝업의 선언(호스트가 그린다). */
export interface PickListSpec {
  title: string;
  /** 제목 아래 안내 한 줄(선택 — 목록이 비었을 때의 문구로도 쓰인다). */
  placeholder?: string;
  items: PickItem[];
}

/** 목록 팝업의 결과 — 어느 항목의 어느 액션을 골랐는가. */
export interface PickResult {
  itemId: string;
  actionId: string;
}

/** 액션이 생략된 항목에 호스트가 붙이는 기본 액션 id(현행 호출이 이 API의 부분집합이 되게 한다). */
export const DEFAULT_PICK_ACTION = "select";

/**
 * 목록 팝업 — 항목/액션 클릭 시 그 쌍으로, Esc/바깥 클릭 시 null로 resolve. 방향키로 이동.
 *
 * 액션이 있는 항목은 라벨 줄 오른쪽에 액션 버튼들이 붙고, 없는 항목은 항목 전체가
 * `select` 버튼이다 — 그래서 액션을 쓰지 않는 기존 호출의 모양·동작이 그대로 유지된다.
 */
export function pickListPopup(
  host: HTMLElement,
  spec: PickListSpec,
): Promise<PickResult | null> {
  return openPopup<PickResult>(host, (box, close) => {
    appendTitle(box, spec.title);
    if (spec.placeholder) appendHint(box, spec.placeholder);
    const list = document.createElement("div");
    list.className = "plugin-popup-list";
    for (const it of spec.items.slice(0, MAX_ITEMS)) {
      list.append(renderPickRow(it, close));
    }
    box.append(list);
    installArrowNav(box, list);
    const first = list.querySelector<HTMLButtonElement>("button");
    if (first) queueMicrotask(() => first.focus());
  });
}

/** 항목 한 줄을 만든다 — 액션이 없으면 줄 전체가 버튼, 있으면 라벨 + 액션 버튼들. */
function renderPickRow(
  item: PickItem,
  close: (result: PickResult | null) => void,
): HTMLElement {
  const actions = item.actions ?? [];
  if (actions.length === 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plugin-popup-item";
    btn.append(labelBlock(item));
    btn.addEventListener("click", () =>
      close({ itemId: item.id, actionId: DEFAULT_PICK_ACTION }),
    );
    return btn;
  }
  const row = document.createElement("div");
  row.className = "plugin-popup-row";
  row.append(labelBlock(item));
  const bar = document.createElement("div");
  bar.className = "plugin-popup-row-actions";
  for (const action of actions.slice(0, MAX_ITEMS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      action.style === "destructive"
        ? "plugin-popup-action plugin-popup-action--danger"
        : "plugin-popup-action";
    btn.textContent = clampLabel(action.label);
    btn.addEventListener("click", () =>
      close({ itemId: item.id, actionId: action.id }),
    );
    bar.append(btn);
  }
  row.append(bar);
  return row;
}

/** 라벨(+부제) 묶음 — 부제는 회색 작은 줄로 아래에 붙는다. */
function labelBlock(item: PickItem): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "plugin-popup-labels";
  const label = document.createElement("span");
  label.className = "plugin-popup-label";
  label.textContent = clampLabel(item.label);
  wrap.append(label);
  if (item.sublabel) {
    const sub = document.createElement("span");
    sub.className = "plugin-popup-sublabel";
    sub.textContent = clampLabel(item.sublabel);
    wrap.append(sub);
  }
  return wrap;
}

/** 선언형 입력 필드 하나 — 타입 어휘는 매니페스트 `settings`와 **같은 것**을 쓴다. */
export interface FormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "toggle" | "select" | "number";
  placeholder?: string;
  default?: unknown;
  /** select 전용 — 문자열 축약형은 `{ value: s, label: s }`로 읽는다(매니페스트와 같은 규칙). */
  options?: (string | { value: string; label?: string })[];
  min?: number;
  max?: number;
  step?: number;
}

/** 입력 팝업의 선언 — `fields`가 있으면 다중 필드 폼, 없으면 한 줄 입력이다. */
export interface PromptSpec {
  title: string;
  placeholder?: string;
  default?: string;
  /** 확인 버튼 문구(기본 "확인"). */
  submitLabel?: string;
  /** 있으면 이 필드들로 폼을 그리고 `Record<id, 값>`을 돌려준다. */
  fields?: FormField[];
}

/** 폼이 돌려주는 값 하나. */
export type FormValue = string | number | boolean;

/**
 * 입력 팝업 — 한 줄 입력(문자열) 또는 다중 필드 폼(`Record<id, 값>`). 취소/Esc/바깥 클릭 = null.
 *
 * 폼에도 한 줄 입력과 **같은 규약**을 쓴다(같은 카드·같은 취소/확인·같은 10분 상한) —
 * `prompt`·`pickList`·폼이 각자 다른 계약을 갖지 않게 하려는 것이 이 설계의 핵심이다.
 */
export function promptPopup(
  host: HTMLElement,
  spec: PromptSpec,
): Promise<string | Record<string, FormValue> | null> {
  const fields = (spec.fields ?? []).slice(0, MAX_ITEMS);
  if (fields.length === 0) return singleLinePrompt(host, spec);
  return openPopup<Record<string, FormValue>>(host, (box, close) => {
    appendTitle(box, spec.title);
    if (spec.placeholder) appendHint(box, spec.placeholder);
    const read: (() => [string, FormValue])[] = [];
    const form = document.createElement("div");
    form.className = "plugin-popup-form";
    for (const field of fields) {
      const [row, reader] = renderField(field);
      form.append(row);
      read.push(reader);
    }
    box.append(form);
    box.append(
      actionBar(spec.submitLabel, close, () =>
        close(Object.fromEntries(read.map((r) => r()))),
      ),
    );
    const first = box.querySelector<HTMLElement>(
      ".plugin-popup-input, .plugin-popup-toggle, select",
    );
    if (first) queueMicrotask(() => first.focus());
  });
}

/** 한 줄 입력(기존 계약) — 확인/Enter 시 입력값 문자열. */
function singleLinePrompt(
  host: HTMLElement,
  spec: PromptSpec,
): Promise<string | null> {
  return openPopup<string>(host, (box, close) => {
    appendTitle(box, spec.title);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "plugin-popup-input";
    input.placeholder = clampLabel(spec.placeholder ?? "");
    input.value = clampLabel(spec.default ?? "");
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      close(input.value);
    });
    box.append(input);
    box.append(actionBar(spec.submitLabel, close, () => close(input.value)));
    queueMicrotask(() => input.focus());
  });
}

/** 취소/확인 버튼 줄을 만든다(취소는 언제나 null로 닫는다). */
function actionBar(
  submitLabel: string | undefined,
  close: (result: null) => void,
  submit: () => void,
): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "plugin-popup-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "plugin-popup-cancel";
  cancel.textContent = t("note.popup.cancel");
  cancel.addEventListener("click", () => close(null));
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "plugin-popup-ok";
  ok.textContent = clampLabel(submitLabel ?? "") || t("note.popup.ok");
  ok.addEventListener("click", submit);
  actions.append(cancel, ok);
  return actions;
}

/**
 * 필드 하나를 그리고 "현재 값을 읽는 함수"를 함께 돌려준다.
 *
 * 값의 타입은 필드 타입이 정한다: toggle=boolean, number=number(비수치는 0), 나머지=string.
 * 왜 읽기 함수를 함께 돌려주나: 제출 시점에 DOM을 다시 셀렉터로 뒤지지 않기 위함이다
 * (셀렉터가 없으면 라벨·id에 어떤 문자가 와도 값 수집이 깨지지 않는다).
 */
function renderField(
  field: FormField,
): [HTMLElement, () => [string, FormValue]] {
  const row = document.createElement("label");
  row.className = "plugin-popup-field";
  const label = document.createElement("span");
  label.className = "plugin-popup-field-label";
  label.textContent = clampLabel(field.label);
  row.append(label);

  if (field.type === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "plugin-popup-toggle";
    input.checked = field.default === true;
    row.classList.add("plugin-popup-field--inline");
    row.append(input);
    return [row, () => [field.id, input.checked]];
  }
  if (field.type === "select") {
    const select = document.createElement("select");
    select.className = "plugin-popup-input";
    for (const raw of field.options ?? []) {
      const opt = typeof raw === "string" ? { value: raw, label: raw } : raw;
      const el = document.createElement("option");
      el.value = clampLabel(opt.value);
      el.textContent = clampLabel(opt.label ?? opt.value);
      select.append(el);
    }
    const def = field.default === undefined ? "" : String(field.default);
    if (def !== "") select.value = def;
    row.append(select);
    return [row, () => [field.id, select.value]];
  }
  if (field.type === "textarea") {
    const area = document.createElement("textarea");
    area.className = "plugin-popup-input plugin-popup-textarea";
    area.placeholder = clampLabel(field.placeholder ?? "");
    area.value = field.default === undefined ? "" : String(field.default);
    row.append(area);
    return [row, () => [field.id, area.value]];
  }
  const input = document.createElement("input");
  input.className = "plugin-popup-input";
  if (field.type === "number") {
    input.type = "number";
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
  } else {
    input.type = "text";
  }
  input.placeholder = clampLabel(field.placeholder ?? "");
  input.value = field.default === undefined ? "" : String(field.default);
  row.append(input);
  return [
    row,
    () => {
      if (field.type !== "number") return [field.id, input.value];
      const n = Number(input.value);
      // 비수치를 NaN으로 흘려보내면 JSON 직렬화에서 null이 되어 "값이 없다"와 구분되지 않는다.
      return [field.id, Number.isFinite(n) ? n : 0];
    },
  ];
}

/** 컨텍스트 메뉴 항목 하나(호스트가 그리는 오버레이 메뉴 — 네이티브 메뉴가 아니다). */
export interface MenuItem {
  id: string;
  label: string;
  /** 회색으로 보이고 눌리지 않는다(예: 선택이 없을 때의 「복사」). */
  disabled?: boolean;
  /** 실행 시 되돌릴 수 없음을 알리는 빨간 강조. */
  danger?: boolean;
}

/**
 * 에디터 컨텍스트 메뉴 — (x, y)에 호스트 렌더 메뉴를 띄우고 고른 항목 id로 resolve한다.
 *
 * `groups`의 각 배열이 한 구역이고 구역 사이에 구분선이 들어간다(빈 구역은 통째로 생략).
 * Esc·바깥 클릭·다른 곳 우클릭은 null이다. 화면 밖으로 나가지 않도록 좌표를 접어 넣는다.
 */
export function contextMenuPopup(
  host: HTMLElement,
  x: number,
  y: number,
  groups: readonly MenuItem[][],
): Promise<string | null> {
  return openPopup<string>(
    host,
    (box, close) => {
      box.className = "plugin-context-menu";
      let firstGroup = true;
      for (const group of groups) {
        if (group.length === 0) continue;
        if (!firstGroup) {
          const hr = document.createElement("div");
          hr.className = "plugin-context-menu-sep";
          box.append(hr);
        }
        firstGroup = false;
        for (const item of group.slice(0, MAX_ITEMS)) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = item.danger
            ? "plugin-context-menu-item plugin-context-menu-item--danger"
            : "plugin-context-menu-item";
          btn.textContent = clampLabel(item.label);
          btn.disabled = item.disabled === true;
          btn.addEventListener("click", () => close(item.id));
          box.append(btn);
        }
      }
      installArrowNav(box, box);
      // 항목을 미리 포커스하지 **않는다** — 네이티브 컨텍스트 메뉴는 열자마자 첫 항목을
      // 강조하지 않고, 그렇게 하면 마우스로 고르는 사람에게 "여기가 눌린다"는 거짓 신호를
      // 준다. 대신 카드 자체를 포커스해 첫 ↓/↑가 첫/마지막 항목으로 들어가게 한다.
      box.tabIndex = -1;
      queueMicrotask(() => box.focus());
    },
    { anchor: { x, y }, transparent: true },
  );
}

/** 카드에 제목을 붙인다(빈 제목이면 생략). */
function appendTitle(box: HTMLElement, title: string): void {
  const text = clampLabel(title);
  if (!text) return;
  const h = document.createElement("p");
  h.className = "plugin-popup-title";
  h.textContent = text;
  box.append(h);
}

/** 제목 아래 안내 한 줄(선택). */
function appendHint(box: HTMLElement, hint: string): void {
  const p = document.createElement("p");
  p.className = "plugin-popup-hint";
  p.textContent = clampLabel(hint);
  box.append(p);
}

/**
 * 위/아래 방향키로 버튼 사이를 순환 이동시킨다(접근성 — 비활성 버튼은 건너뛴다).
 *
 * 아직 아무 버튼도 포커스되지 않은 상태(컨텍스트 메뉴의 첫 키 입력)에서는 ↓가 첫 항목,
 * ↑가 마지막 항목으로 들어간다 — 순환 나머지 연산에 맡기면 ↑가 「끝에서 두 번째」로 가는
 * 어긋남이 생긴다.
 */
function installArrowNav(box: HTMLElement, scope: HTMLElement): void {
  box.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = [
      ...scope.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    ];
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const down = e.key === "ArrowDown";
    const next =
      idx === -1
        ? down
          ? 0
          : btns.length - 1
        : (idx + (down ? 1 : btns.length - 1)) % btns.length;
    btns[next]?.focus();
  });
}

/** [`openPopup`]의 배치 옵션 — 기본은 화면 중앙 카드, anchor를 주면 그 좌표의 메뉴다. */
interface PopupOptions {
  anchor?: { x: number; y: number };
  /** 어두운 막을 깔지 않는다(컨텍스트 메뉴는 본문을 가리면 안 된다). */
  transparent?: boolean;
}

/**
 * 공유 오버레이 셸 — 카드 생성, Esc/바깥 클릭 = null, 정확히 1회 resolve + DOM·리스너 정리.
 *
 * build로 카드 내용을 채우고 close(result)로 닫는다. 창이 리로드/닫히면 페이지와 함께
 * 사라지고, 호스트의 대화형 타임아웃 상한이 미해소 호출을 회수한다(누수 방지).
 */
function openPopup<T>(
  host: HTMLElement,
  build: (box: HTMLElement, close: (result: T | null) => void) => void,
  options: PopupOptions = {},
): Promise<T | null> {
  ensureOverlayStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = options.transparent
      ? "plugin-popup-overlay plugin-popup-overlay--bare"
      : "plugin-popup-overlay";
    const box = document.createElement("div");
    box.className = "plugin-popup-box";

    let done = false;
    const close = (result: T | null): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    // 바깥(오버레이) 클릭은 취소로 처리. 컨텍스트 메뉴는 우클릭으로도 닫힌다.
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.addEventListener("contextmenu", (e) => {
      if (e.target !== overlay) return;
      e.preventDefault();
      close(null);
    });

    build(box, close);
    overlay.append(box);
    host.append(overlay);
    // 배치는 **DOM에 붙인 뒤**에 한다(measure-then-position): 부착 전에는 offsetWidth/Height가
    // 항상 0이라, 실제 브라우저에서도 폴백 추정치(가로)·클램프 생략(세로)으로 떨어져 작은
    // 창의 아래·오른쪽 가장자리에서 메뉴가 창 밖으로 잘렸다. 같은 프레임 안이라 깜빡임은 없다.
    if (options.anchor) placeAtAnchor(box, options.anchor);
  });
}

/** 앵커 메뉴와 창 가장자리 사이의 여백(px). */
const ANCHOR_MARGIN = 4;

/** 부착 후 실측한 메뉴 크기로 좌표를 화면 안으로 접어 넣는다(jsdom에선 크기가 0이라 폴백을 쓴다). */
function placeAtAnchor(box: HTMLElement, at: { x: number; y: number }): void {
  box.style.position = "fixed";
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  // 실측 **전에** 높이 상한을 건다: 스티키 창은 아주 낮을 수 있어 항목이 다 안 들어가는데,
  // 상한이 없으면 넘치는 만큼이 창 밖으로 흘러 그 항목들을 아예 누를 수 없다. 상한이 있으면
  // 브라우저가 그 높이로 배치하고 나머지는 메뉴 안에서 스크롤된다(.plugin-context-menu의 overflow-y).
  if (vh > 0) box.style.maxHeight = `${vh - ANCHOR_MARGIN * 2}px`;
  // 부착 후에도 rect가 0인 환경(jsdom)에서는 보수적으로 최소 크기를 가정한다.
  const w = box.offsetWidth || 180;
  const h = box.offsetHeight || 0;
  const fit = (pos: number, size: number, limit: number): number =>
    Math.max(ANCHOR_MARGIN, Math.min(pos, limit - size - ANCHOR_MARGIN));
  box.style.left = `${vw > 0 ? fit(at.x, w, vw) : at.x}px`;
  box.style.top = `${vh > 0 && h > 0 ? fit(at.y, h, vh) : at.y}px`;
}

/** 주입된 오버레이 스타일 요소의 표식(중복 주입 방지). */
const OVERLAY_STYLE_ID = "memo-note-overlay-styles";

/**
 * 이 파일이 그리는 UI의 스타일을 문서에 한 번만 주입한다.
 *
 * 왜 전역 `styles.css`가 아닌가: 컨텍스트 메뉴·부제·액션 줄·폼 필드·토스트 상태는 전부 이
 * 모듈이 만드는 DOM에만 쓰이는 규칙이라, 만드는 쪽과 같은 파일에 두면 "클래스는 바뀌었는데
 * 스타일이 남아 있는" 어긋남이 생기지 않는다. 기존 `.plugin-popup-*`·`.note-toast` 기본 룩은
 * 전역 시트가 계속 소유하고, 여기서는 **더하기만** 한다(같은 속성을 다시 정의하지 않는다).
 */
export function ensureOverlayStyles(): void {
  if (document.getElementById(OVERLAY_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = OVERLAY_STYLE_ID;
  style.textContent = OVERLAY_CSS;
  document.head.append(style);
}

/** 주입 스타일 본문 — 값은 전역 시트가 쓰는 앱 토큰(`--memo-*`)을 그대로 따른다. */
const OVERLAY_CSS = `
.plugin-popup-overlay--bare { background: transparent; align-items: flex-start; justify-content: flex-start; }
.plugin-popup-hint { margin: -4px 4px 8px; font-size: 11px; opacity: 0.6; }
.plugin-popup-labels { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.plugin-popup-label { font-size: 13px; }
.plugin-popup-sublabel { font-size: 11px; opacity: 0.6; }
.plugin-popup-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 6px 10px; border-radius: 6px; background: rgba(0, 0, 0, 0.05);
}
.plugin-popup-row-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.plugin-popup-action {
  padding: 3px 9px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: var(--memo-accent, #37506a); color: #fff;
}
.plugin-popup-action--danger { background: var(--memo-danger, #b3261e); }
.plugin-popup-action:focus { outline: 2px solid var(--memo-accent, #37506a); outline-offset: 1px; }
.plugin-popup-form { display: flex; flex-direction: column; gap: 10px; }
.plugin-popup-field { display: flex; flex-direction: column; gap: 4px; }
.plugin-popup-field--inline { flex-direction: row; align-items: center; justify-content: space-between; }
.plugin-popup-field-label { font-size: 12px; opacity: 0.75; }
.plugin-popup-textarea { min-height: 72px; resize: vertical; font: inherit; }
.plugin-context-menu {
  min-width: 168px; max-width: 280px; padding: 4px;
  display: flex; flex-direction: column;
  /* 창 높이에 다 안 들어가면 메뉴 안에서 스크롤한다(높이 상한은 placeAtAnchor가 실측 전에 건다).
     box-sizing: 상한을 안쪽 높이로 재면 padding 8px만큼 더 커져 창 밖으로 삐져나간다(실측 확인).
     overscroll-behavior: 메뉴 끝까지 굴렸을 때 그 아래 에디터가 따라 스크롤되지 않게 막는다. */
  box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain;
  background: var(--memo-card, #fff); color: var(--memo-text, #1f2328);
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
}
/* 카드 자체는 화살표 키를 받기 위해 포커스되지만(tabIndex=-1) 테두리는 그리지 않는다 —
   포커스 링이 보이면 "메뉴 전체가 눌린다"처럼 읽힌다(실제 렌더에서 확인). */
.plugin-context-menu:focus { outline: none; }
/* 넘칠 때만 나타나는 얇은 막대 — WKWebView 기본 오버레이 스크롤바는 굴리기 전엔 보이지 않아
   "메뉴가 그냥 잘렸다"로 읽힌다. 아래에 항목이 더 있다는 유일한 신호라 항상 그린다. */
.plugin-context-menu::-webkit-scrollbar { width: 8px; }
/* 막대를 위아래로 조금 들여 둥근 모서리를 파고들지 않게 한다. */
.plugin-context-menu::-webkit-scrollbar-track { margin: 6px 0; }
.plugin-context-menu::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.22); border-radius: 4px;
  border: 2px solid transparent; background-clip: padding-box;
}
.plugin-context-menu-item {
  padding: 6px 10px; border: none; border-radius: 5px; background: transparent;
  color: inherit; font-size: 13px; text-align: left; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  /* 스크롤이 걸린 flex 열에서 항목이 세로로 눌리지 않게 한다(기본 flex-shrink: 1). */
  flex: none;
}
.plugin-context-menu-item:hover:not([disabled]),
.plugin-context-menu-item:focus:not([disabled]) {
  background: var(--memo-accent, #37506a); color: #fff; outline: none;
}
.plugin-context-menu-item[disabled] { opacity: 0.38; cursor: default; }
.plugin-context-menu-item--danger { color: var(--memo-danger, #b3261e); }
.plugin-context-menu-sep { margin: 4px 6px; height: 1px; flex: none; background: rgba(0, 0, 0, 0.12); }
/* 상태 색·여러 줄 배치는 전역 시트의 .note-toast 기본값을 이겨야 한다 — 주입 순서에
   기대지 않도록 클래스를 겹쳐 특정도를 한 단계 올린다(전역 시트가 나중에 와도 안전). */
.note-toast.note-toast--failure { background: var(--memo-danger, #b3261e); }
.note-toast-title { font-weight: 600; }
.note-toast-message { display: block; margin-top: 2px; opacity: 0.85; font-weight: 400; }
.note-toast.note-toast--multiline {
  white-space: normal; max-width: 70%; text-align: center;
  border-radius: 10px; padding: 6px 12px; line-height: 1.4;
}
.note-toast-spinner {
  display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px;
  border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; border-radius: 50%;
  animation: note-toast-spin 0.8s linear infinite;
}
@keyframes note-toast-spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) {
  .plugin-popup-row { background: rgba(255, 255, 255, 0.08); }
  .plugin-context-menu-sep { background: rgba(255, 255, 255, 0.16); }
  .plugin-context-menu::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.28); background-clip: padding-box; }
}
`;
