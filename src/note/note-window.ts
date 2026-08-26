/**
 * 노트 창 컨트롤러 — id로 본문·옵션 로드, 에디터 마운트, 자동저장, 옵션 툴바, 드래그.
 *
 * 역할: 노트 한 건의 창 생명주기를 담당한다. IO(로드/저장/네이티브 적용/삭제/드래그)는
 * 주입받아 Tauri 의존 없이 테스트 가능하게 한다.
 * 왜: 멀티윈도우에서 각 창이 자기 노트만 다루고, 노트별 override를 적용·영속화한다.
 */
import { createEditor } from "./editor";
import { hideSelectionToolbar } from "./selection-toolbar";
import {
  createNoteToolbar,
  type NoteOptionState,
  type NoteToolbarResync,
} from "./note-toolbar";
import {
  resolveLayout,
  pluginItemKey,
  type ToolbarLayout,
} from "./toolbar-layout";
import type { PluginCapabilities } from "../plugin/capabilities";
import { installNoteKeymap } from "../shortcuts/keymap";
import { confirmDialog } from "./confirm-dialog";
import {
  contextMenuPopup,
  ensureOverlayStyles,
  pickListPopup,
  promptPopup,
  type FormValue,
  type MenuItem,
  type PickListSpec,
  type PickResult,
  type PromptSpec,
} from "./plugin-popup";
import { fieldsDialog, inputDialog } from "./input-dialog";
import {
  imageInsertMarkdown,
  isValidHttpUrl,
  linkInsertMarkdown,
  youtubeInsertMarkdown,
} from "./context-menu-insert";
import { imageSourceAt, type ImageSourceSpan } from "./live-preview";
import {
  isValidImageSizeInput,
  parseImageAltSize,
  parseImageSizeInput,
  serializeImageAltSize,
} from "./image-size";
import {
  ALL_TOKEN_KEYS,
  applyTheme,
  isSurfaceToken,
  mergeThemeOverrides,
  type ThemeDescriptor,
} from "../theme/theme";
import {
  contrastVars,
  DEFAULT_BACKGROUND_COLOR,
  resolveBackgroundColor,
  type BackgroundDescriptor,
} from "../theme/background";
import { resolveFontFamily, type FontDescriptor } from "../theme/font";
import type { NoteOverrides } from "../shared/tauri";
import type { PluginWindowItem } from "../plugin/host-client";
import type { WhenTerm } from "../plugin/loader";
import type { Extension } from "@codemirror/state";
import { t } from "../i18n/t";

/** URL 쿼리스트링에서 노트 id를 뽑는다(`?note=<id>`). 없으면 null. */
export function parseNoteId(search: string): string | null {
  return new URLSearchParams(search).get("note");
}

// ── 창 단위 실패 격리(이슈 #24) ─────────────────────────────────────────────
//
// 이 앱은 노트 하나당 창(웹뷰) 하나다. 그런데 창 하나에서 처리되지 않은 예외가 나면 그 창은
// **아무것도 그리지 못한 채** 남았다 — 부트스트랩이 `void bootstrapNote(...)`로 프라미스를
// 버리기 때문에, 마운트 중 실패는 콘솔에만 남고 화면에는 빈 사각형만 남는다. 백엔드의
// 잠금 중독(state.rs 참고)처럼 **모든 창에 동시에** 실패를 일으키는 원인과 만나면, 사용자
// 눈에는 "메모 하나가 죽으니 전부 먹통"으로 보인다.
//
// 그래서 여기서 창 전역 오류를 받아 오버레이로 바꾼다: 무슨 일이 났는지 한 줄로 말하고,
// **이 창만** 닫거나 다시 시도할 수 있게 한다. 다른 창은 각자의 웹뷰라 이 오버레이와 무관하게
// 계속 동작한다 — 격리가 실제로 존재한다는 사실을 사용자가 볼 수 있게 만드는 것이 요점이다.

/** 오버레이 요소의 id — 한 창에 하나만 존재하게 하는 식별자. */
const ERROR_OVERLAY_ID = "memo-note-error";

/** 오버레이가 붙을 자리 — 노트 루트(`#app`)가 없으면 body(마운트 이전 실패). */
function errorOverlayHost(doc: Document): HTMLElement {
  return doc.querySelector<HTMLElement>("#app") ?? doc.body;
}

/** 알 수 없는 값(throw된 무엇이든)에서 사람이 읽을 한 줄을 뽑는다. */
function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === "string") return reason;
  if (reason === null || reason === undefined) return "";
  try {
    return String(reason);
  } catch {
    return "";
  }
}

/**
 * 이 창만 닫는다 — Tauri 창 API를 **동적으로** 부른다(정적 import 금지).
 *
 * 왜 동적인가: 이 모듈은 jsdom 단위 테스트에서 그대로 import되는데, `shared/tauri.ts`는
 * 모듈 최상위에서 `@tauri-apps/api`를 끌어온다. 정적으로 묶으면 테스트가 Tauri 런타임을
 * 흉내 내야 한다. 버튼을 실제로 누를 때만 로드하면 그 부담이 사라지고, 실패하면 표준
 * `window.close()`로 떨어진다(e2e 브라우저 경로).
 */
function closeThisWindow(view: Window): void {
  void import("../shared/tauri")
    .then((m) => m.closeWindow())
    .catch(() => view.close());
}

/**
 * 복구 불가능한 오류를 알리는 전체 화면 오버레이를 띄운다(창당 1회).
 *
 * 이미 떠 있으면 아무것도 하지 않는다 — 첫 오류가 연쇄 오류를 부르는 것이 보통이라,
 * 겹쳐 쌓이면 정작 **첫 번째** 원인이 가려진다.
 *
 * 버튼 두 개가 곧 탈출구다: 「다시 시도」는 이 창만 리로드하고(백엔드가 잠깐 아팠던
 * 경우 그것으로 낫는다), 「창 닫기」는 이 창만 닫는다(노트는 지워지지 않는다 — 창만 사라진다).
 * 반환값은 만든 오버레이 요소이고, 이미 떠 있었으면 그 요소다(가드 테스트용).
 */
export function showNoteErrorOverlay(
  detail: string,
  view: Window = window,
): HTMLElement | null {
  const doc = view.document;
  const existing = doc.getElementById(ERROR_OVERLAY_ID);
  if (existing instanceof HTMLElement) return existing;
  const host = errorOverlayHost(doc);
  if (!host) return null;

  // 스타일은 전부 인라인이다: 이 오버레이가 뜨는 상황에는 전역 시트가 로드되지 않았을
  // 가능성 자체가 원인일 수 있다(빌드 산출물 누락·CSP). 자기 자신에게 의존하지 않게 둔다.
  const overlay = doc.createElement("div");
  overlay.id = ERROR_OVERLAY_ID;
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
    "box-sizing:border-box",
    "text-align:center",
    "background:#1c1c1e",
    "color:#f2f2f7",
    "font:13px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif",
  ].join(";");

  const title = doc.createElement("strong");
  title.textContent = t("note.error.title");
  title.style.cssText = "font-size:14px";

  const body = doc.createElement("p");
  body.textContent = t("note.error.body");
  body.style.cssText = "margin:0;opacity:.8;max-width:30em";

  const row = doc.createElement("div");
  row.style.cssText = "display:flex;gap:8px;margin-top:4px";
  const buttonCss =
    "padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.25);" +
    "background:rgba(255,255,255,.08);color:inherit;font:inherit;cursor:pointer";

  const retry = doc.createElement("button");
  retry.type = "button";
  retry.dataset.action = "note-error-retry";
  retry.textContent = t("note.error.retry");
  retry.style.cssText = buttonCss;
  retry.addEventListener("click", () => view.location.reload());

  const close = doc.createElement("button");
  close.type = "button";
  close.dataset.action = "note-error-close";
  close.textContent = t("note.error.close");
  close.style.cssText = buttonCss;
  close.addEventListener("click", () => closeThisWindow(view));

  row.append(retry, close);
  overlay.append(title, body, row);

  // 원인 문구는 **있을 때만** 덧붙인다 — 빈 줄이 뜨면 "정보가 있는데 안 보인다"로 읽힌다.
  // 신뢰 경계 밖 문자열(플러그인 오류 메시지 등)이 섞일 수 있으므로 textContent로만 넣는다.
  if (detail !== "") {
    const cause = doc.createElement("code");
    cause.textContent = detail;
    cause.style.cssText =
      "max-width:34em;max-height:6em;overflow:auto;opacity:.6;font-size:11px;" +
      "white-space:pre-wrap;word-break:break-word";
    overlay.insertBefore(cause, row);
  }

  host.append(overlay);
  return overlay;
}

/**
 * "ResizeObserver loop completed with undelivered notifications." /
 * "ResizeObserver loop limit exceeded" — 관측 콜백이 같은 프레임 안에서 레이아웃을 다시
 * 바꿀 때 브라우저가 **`window` `error` 이벤트로** 흘려보내는 무해한 경고다(진짜 스크립트
 * 오류가 아니다). 이 코드베이스에서는 `note-toolbar.ts`의 `installZoneOverflow`가 노트 창
 * 리사이즈마다 자기 존을 `ResizeObserver`로 관측하며 넘치는 항목을 `⋯` 패널로 옮기는데,
 * 그 재배치 자체가 다시 리사이즈를 유발할 수 있어(같은 프레임 재진입) 전형적인 발생원이다.
 * 창을 그냥 리사이즈만 해도 이 문구가 뜨는 사용자 보고가 바로 이 경로다.
 *
 * `installNoteErrorOverlay`의 `error` 핸들러에서만 걸러낸다 — 스크립트 예외와 겹칠 일이
 * 없는 고정 문구라 오탐 없이 안전하게 매치할 수 있고, 다른 무해한 오류까지 함께 삼키지
 * 않도록 접두어만 좁게 본다.
 */
function isBenignResizeObserverNotice(message: string): boolean {
  return message.startsWith("ResizeObserver loop");
}

/**
 * 창 전역 오류 핸들러를 단다 — 처리되지 않은 예외/거부를 오버레이로 바꾼다(이슈 #24).
 *
 * 두 이벤트를 모두 듣는 이유: 마운트 실패는 **프라미스 거부**로 오고(부트스트랩이 프라미스를
 * 버린다), 마운트 이후의 사고는 보통 동기 예외로 온다. 한쪽만 들으면 정확히 절반을 놓친다.
 *
 * `error`는 스크립트 오류만 받는다(리소스 로드 실패는 버블링하지 않아 이 자리에 오지 않는다).
 * 그래도 방어적으로 `ErrorEvent`인지 확인한다 — 아닌 이벤트에 오버레이를 띄우면 멀쩡한 창을
 * 사용자가 닫게 만든다. `ResizeObserver` 루프 경고([`isBenignResizeObserverNotice`])도 여기서
 * 걸러 콘솔 debug 로그로만 남긴다 — 리사이즈 한 번으로 창이 죽은 것처럼 보이는 오탐을 막는다.
 *
 * 해제 함수를 돌려준다(테스트가 전역 상태를 되돌릴 수 있게).
 */
export function installNoteErrorOverlay(view: Window = window): () => void {
  const onError = (event: Event): void => {
    if (!(event instanceof ErrorEvent)) return;
    const message = describeError(event.error ?? event.message);
    if (isBenignResizeObserverNotice(message)) {
      console.debug("[note] ignoring benign ResizeObserver notice:", message);
      return;
    }
    showNoteErrorOverlay(message, view);
  };
  const onRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    showNoteErrorOverlay(describeError(reason), view);
  };
  view.addEventListener("error", onError);
  view.addEventListener("unhandledrejection", onRejection);
  return () => {
    view.removeEventListener("error", onError);
    view.removeEventListener("unhandledrejection", onRejection);
  };
}

// 진짜 노트 창(`?note=<id>`)에서만 자동 설치한다. 이 모듈은 단위 테스트에도 그대로
// import되므로, 쿼리로 걸러 테스트 환경의 전역에 리스너가 눌러앉지 않게 한다(테스트는
// `installNoteErrorOverlay`를 직접 부른다). 부트스트랩(`bootstrap/note.ts`)이 이 모듈을
// 정적으로 끌어오므로, 이 줄은 `bootstrapNote`가 첫 await에 닿기도 전에 실행된다 —
// 즉 마운트 도중의 실패도 빠짐없이 잡힌다.
if (
  typeof window !== "undefined" &&
  parseNoteId(window.location?.search ?? "") !== null
) {
  installNoteErrorOverlay(window);
}

/**
 * 노트 본문 로드(IPC)를 기다리는 상한(ms).
 *
 * 왜 상한이 필요한가: `noteRead`는 백엔드 커맨드다. 백엔드가 무응답이면(메인 스레드가 다른
 * 작업에 묶였거나 프로세스가 이상하면) 이 프라미스는 **영원히** 해결되지 않고, 창은 빈 채로
 * 남는다 — 이슈 #24가 보고된 모양 그대로다. 상한을 두면 무한 대기가 오버레이로 바뀌어
 * 사용자에게 「다시 시도」라는 선택지가 생긴다.
 *
 * 8초인 근거: 정상 경로는 밀리초 단위이고, 최악(동기화 폴더에서 큰 노트 + 백신 검사)이라도
 * 몇 초면 끝난다. 넉넉히 잡되 사용자가 "멈췄나?"를 확신하기 전에는 판정이 나야 한다.
 */
const LOAD_TIMEOUT_MS = 8_000;

/** 프라미스에 시간 상한을 씌운다 — 넘기면 `message`로 거부한다(원래 프라미스는 그냥 버린다). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new Error(describeError(error)),
        );
      },
    );
  });
}

/**
 * 디바운스된 함수 — 호출 시그니처에 `flush`(대기 중인 마지막 호출을 즉시 실행)를 더한다.
 * export하지 않는다(호출부는 `debounce()`의 반환값을 타입 추론으로만 쓴다 — knip 미사용 export 방지).
 */
interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /**
   * 대기 중인 타이머가 있으면 취소하고 그 마지막 인자로 즉시 실행한다(없으면 아무 것도 안 함).
   * 왜: 리로드·창 닫힘 직전처럼 ms를 기다릴 수 없는 시점에 유실 없이 확정한다.
   */
  flush(): void;
  /**
   * 대기 중인 타이머와 인자를 **실행 없이** 버린다(이후 flush는 no-op).
   * 왜: 노트를 삭제하는 순간부터 그 노트의 본문 저장은 의미가 없다 — 오히려 삭제 뒤에 실행되면
   * 파일을 되살린다(note_save_content는 write_atomic이라 없는 파일을 새로 만든다).
   */
  cancel(): void;
}

/** 마지막 호출만 ms 뒤 실행되도록 디바운스한다(잦은 자동저장을 합친다). `flush()`로 즉시 확정 가능. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = (args: A): void => {
    timer = undefined;
    pending = undefined;
    fn(...args);
  };
  const debounced = ((...args: A) => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => run(args), ms);
  }) as Debounced<A>;
  debounced.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    const args = pending;
    timer = undefined;
    pending = undefined;
    if (args) fn(...args);
  };
  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return debounced;
}

/**
 * 텍스트를 입력받을 수 있는 요소인지 판정한다(순수, 가드 테스트용).
 *
 * 왜 필요한가: 창이 OS 포커스를 되찾을 때(`window` `focus` 이벤트) 에디터로 포커스를 되돌리되,
 * 검색창·제목 입력처럼 사용자가 지금 타이핑 중인 다른 필드는 건드리면 안 된다 — "에디터가
 * 포커스를 빼앗는다"는 그 자체가 버그가 된다. 판정 기준은 일부러 느슨하다: `HTMLInputElement`는
 * `type`을 따지지 않고 readOnly만 본다(버튼류 input은 실무에서 이 앱에 거의 없고, 있어도
 * 「눌러도 무해」한 요소라 오탐 비용이 낮다) — `select`·`textarea`·`isContentEditable`(CodeMirror
 * `.cm-content` 포함)은 항상 텍스트 입력 요소로 본다.
 */
export function isTextEntryElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !el.readOnly;
  if ((el as HTMLElement).isContentEditable) return true;
  // jsdom(단위 테스트 환경)은 `isContentEditable` 게터를 구현하지 않아 실제 값과 무관하게 항상
  // undefined를 준다(알려진 한계) — CodeMirror의 `.cm-content`를 포함해 판정이 늘 false로
  // 새지 않도록 `contenteditable` 속성값으로 한 번 더 확인한다(실제 브라우저에선 중복 확인이라
  // 무해하다).
  const attr = el.getAttribute("contenteditable");
  return attr === "true" || attr === "";
}

/** override 미설정 시의 노트 기본 옵션값(Rust `NoteDefaults`와 일치). */
const OPTION_DEFAULTS: NoteOptionState = {
  preview: true,
  pinned: false,
  transparency: 100,
  allSpaces: false,
  fontSize: 14,
  collapsed: false,
};

/** 전역 기본(px) + 메모 델타(%)로 실효 글자 크기(px)를 낸다(8~48 클램프, Rust resolve와 동일). */
export function effectiveFontPx(baseFontPx: number, deltaPct: number): number {
  const px = baseFontPx + Math.round((14 * deltaPct) / 100);
  return Math.min(48, Math.max(8, px));
}

/** 메모 글자 확대/축소 단위(%) — font-scale 플러그인의 STEP과 일치해야 스텝이 깔끔하다. */
const FONT_STEP = 10;

/**
 * 메모 글자 델타(%)를 실효 px가 바뀌는 범위 안의 10% 배수로 클램프한다(순수, 가드 테스트용).
 *
 * 역할: effectiveFontPx는 결과 px만 8~48로 자르므로, px가 한계(48/8)에 붙은 뒤에도 델타는
 * 무한히 커질 수 있다(A+가 "되는 척"만 하며 토스트가 가짜 %를 계속 키움). 그래서 델타 자체를,
 * 현재 전역 기본(base)에서 실효 px를 8~48 안에 유지하는 최소/최대 델타로 제한한다 — 한계에선
 * 델타가 더 자라지 않아 피드백이 정직해지고, 반대 방향(A−)에도 "죽은 구간" 없이 즉시 반응한다.
 * 또한 요청값·경계를 모두 FONT_STEP(10%) 배수로 맞춰, 마지막 스텝이 "+104% 뒤 +4%"처럼
 * 어정쩡하게 끝나지 않고 항상 +10/−10으로 떨어진다(예전 빌드가 남긴 비배수 델타도 다음 조작에서
 * 10% 격자로 복원된다).
 * 왜: 클램프에 base가 필요하나 플러그인은 이를 모른다 — 호스트(setFontDelta)가 정본으로 삼아
 * 적용된 델타를 돌려주고, 플러그인은 그 값을 토스트한다.
 */
export function clampFontDelta(baseFontPx: number, deltaPct: number): number {
  // 실효 px = base + Math.round(14·d/100)을 8~48로 유지하는 d의 경계를 역산한다.
  // round(x) ≤ hi ⟺ x < hi+0.5 → 상한 델타, round(x) ≥ lo ⟺ x ≥ lo−0.5 → 하한 델타.
  const maxDelta = Math.ceil(((48 - baseFontPx + 0.5) * 100) / 14) - 1;
  const minDelta = Math.ceil(((8 - baseFontPx - 0.5) * 100) / 14);
  // 요청값은 가장 가까운 10% 배수로, 경계는 범위 안쪽 10% 배수로 스냅한다(px 한계는 그대로 지킴).
  const snapped = Math.round(deltaPct / FONT_STEP) * FONT_STEP;
  const maxStep = Math.floor(maxDelta / FONT_STEP) * FONT_STEP;
  const minStep = Math.ceil(minDelta / FONT_STEP) * FONT_STEP;
  return Math.min(maxStep, Math.max(minStep, snapped));
}

/**
 * raw override(null 가능)를 실제 표시값으로 해석한다.
 *
 * 역할: "override 있으면 그것, 없으면 전역 기본값" 규칙을 한 곳에 고정(순수, 테스트).
 * 글자 크기는 전역 기본(앱 설정 `baseFontPx`) + 메모 델타(`font_delta`%)로 계산한다.
 */
export function resolveOptions(
  overrides: NoteOverrides,
  baseFontPx = 14,
): NoteOptionState {
  return {
    preview: overrides.markdown_preview ?? OPTION_DEFAULTS.preview,
    pinned: overrides.pinned ?? OPTION_DEFAULTS.pinned,
    transparency: overrides.transparency ?? OPTION_DEFAULTS.transparency,
    allSpaces: overrides.all_spaces ?? OPTION_DEFAULTS.allSpaces,
    fontSize: effectiveFontPx(baseFontPx, overrides.font_delta ?? 0),
    collapsed: overrides.collapsed ?? OPTION_DEFAULTS.collapsed,
  };
}

/**
 * 옵션 초기화가 되돌리는 override 항목의 표시 라벨(고정 순서 — 툴바 노출 순서와 결이 맞다).
 *
 * 함수인 이유: `customizedOverrideLabels`가 호출될 때마다(=확인창을 띄우는 시점마다) 다시
 * 평가해 `t()`가 그 순간의 활성 로케일을 읽게 한다. 모듈 상단 `const`로 한 번만 굳히면 이
 * 창이 로드되는 시점(`setActiveLocale()`보다 항상 먼저)의 로케일로 영원히 고정된다(§i18n 규약).
 */
const RESET_OPTION_LABELS = (): readonly [keyof NoteOverrides, string][] => [
  ["transparency", t("note.window.reset-label-transparency")],
  ["background", t("note.window.reset-label-background")],
  ["font_delta", t("note.window.reset-label-font-size")],
  ["markdown_preview", t("note.window.reset-label-preview")],
  ["pinned", t("note.window.reset-label-pin")],
  ["all_spaces", t("note.window.reset-label-all-desktops")],
  ["collapsed", t("note.window.reset-label-collapse")],
];

/**
 * 이 메모가 실제로 커스터마이즈한(override가 설정된) 항목의 표시 라벨 목록을 낸다(순수, 가드 테스트용).
 *
 * 역할: 옵션 초기화 확인창이 "무엇이 사라지는지"를 이 메모에 **실제로 설정된 값만** 골라 명시하게 한다.
 * null/undefined(전역 기본값 상속)는 제외하므로, 빈 목록이면 되돌릴 사용자 설정이 없다는 뜻이다.
 */
export function customizedOverrideLabels(overrides: NoteOverrides): string[] {
  return RESET_OPTION_LABELS()
    .filter(([key]) => overrides[key] != null)
    .map(([, label]) => label);
}

/** 토스트가 전하는 상태 — 실패를 사용자에게 알리는 표준 수단이 여기서 생긴다. */
type NoteToastStyle = "success" | "failure" | "progress";

/**
 * 토스트 1건의 선언 — 새로 띄우기·갱신·닫기를 **한 모양**으로 표현한다.
 *
 * `id`가 없으면 새로 띄우고 호스트가 발급한 id를 돌려준다. `id`가 있으면 그 토스트를
 * 갱신하고, `dismiss: true`면 닫는다. 이미 사라진 id는 조용히 무시하지 않고 실패(null)다 —
 * "갱신했는데 아무 일도 없었다"가 무음 실패의 전형이기 때문.
 *
 * **갱신은 부분 갱신이다**: 주지 않은 필드는 살아 있는 토스트의 값을 그대로 유지한다
 * (`title`이 선택인 이유). `{ id, style: "success" }` 하나로 진행 토스트를 완료로 바꾸는
 * 것이 정본 사용법이라, 안 준 필드를 빈 값으로 덮으면 글자 없는 빈 알림이 뜬다.
 */
interface NoteToastSpec {
  id?: string;
  /** 새로 띄울 때는 필수(호출부가 강제), 갱신에서는 생략하면 기존 문구를 유지한다. */
  title?: string;
  message?: string;
  style?: NoteToastStyle;
  dismiss?: boolean;
}

/**
 * 갱신 spec을 살아 있는 토스트의 마지막 spec 위에 덮는다 — **주지 않은 필드는 유지**한다.
 *
 * 왜 함수인가: 단순 전개(`{ ...prev, ...next }`)는 `title: undefined`가 실린 객체에서
 * 기존 값을 지운다. 부분 갱신의 계약("안 주면 유지")을 한 곳에서 지키게 한다.
 */
function mergeToastSpec(
  prev: NoteToastSpec,
  next: NoteToastSpec,
): NoteToastSpec {
  return {
    ...prev,
    ...(next.title === undefined ? {} : { title: next.title }),
    ...(next.message === undefined ? {} : { message: next.message }),
    ...(next.style === undefined ? {} : { style: next.style }),
  };
}

/** 상태별 자동 소멸 시간(ms). `progress`는 update/hide를 기다리므로 목록에 없다. */
const TOAST_LINGER_MS: Record<"success" | "failure", number> = {
  success: 1200,
  failure: 2600,
};

/**
 * `progress` 토스트의 강제 소멸 상한(ms) — 플러그인이 갱신을 잊어도 유령 토스트가 남지 않게.
 */
const TOAST_PROGRESS_CAP_MS = 30_000;

/** 첫 토스트의 바닥 여백(px) — 전역 시트의 `.note-toast { bottom: 44px }`과 같은 값. */
const TOAST_BOTTOM_PX = 44;

/** 쌓인 토스트 사이의 간격(px). */
const TOAST_GAP_PX = 8;

/** 높이를 실측할 수 없을 때 가정하는 한 줄 토스트 높이(px) — jsdom 폴백. */
const TOAST_ROW_PX = 26;

/**
 * 토스트 발급 id의 창 구분자를 만드는 모듈 전역 순번.
 *
 * 왜 노트 id가 아니라 순번인가: 발급 id는 `ui` 권한만으로 플러그인에게 돌아가는 핸들인데,
 * 노트 id는 notes:read 게이트 뒤의 민감 데이터다(창 라벨 `note-<id>`·파일 경로와 직결).
 * 마운트마다 다른 불투명 순번이면 교차-창 유일성은 그대로고 신원은 새지 않는다.
 */
let toastWindowSeq = 0;

/**
 * 노트창 마운트에 필요한 IO 의존성(테스트 시 주입).
 *
 * export하는 이유: 테스트가 이 형을 `Parameters<typeof mountNoteWindow>[2]`로 되짚어 유도하면,
 * 인자 순서가 바뀌는 순간 조용히 엉뚱한 타입을 집는다. 주입 계약이니 계약을 직접 공개한다.
 */
export interface NoteWindowDeps {
  loadNote(id: string): Promise<{ content: string; overrides: NoteOverrides }>;
  saveContent(id: string, content: string): void;
  saveOverrides(id: string, overrides: NoteOverrides): void;
  applyTransparency(percent: number): void;
  applyPinned(on: boolean): void;
  applyAllSpaces(on: boolean): void;
  /** 헤더 접기(창 높이 조절 + prev_height 보관·복원)를 백엔드에 적용·영속화한다. */
  applyCollapsed(on: boolean): void;
  /**
   * 이 창의 OS 타이틀(본문 첫 줄에서 파생 — 패널·검색과 같은 제목)을 읽는다. 접었을 때 헤더
   * 라벨(`.note-collapsed-title`)로 쓴다: 본문이 사라진 38px 헤더만 보고 "어느 메모인지"
   * 알 유일한 단서다. 미제공이면(구버전 deps·테스트) 라벨을 갱신하지 않는다.
   */
  windowTitle?(): Promise<string>;
  deleteNote(id: string): void;
  archiveNote(id: string): void;
  startDrag(): void;
  /** 이미지 본문 경로(vault 상대) → 웹뷰 URL 해석기(라이브 프리뷰의 `<img>`). */
  resolveImageSrc?(path: string): string;
  /** 붙여넣은 이미지 바이트를 vault에 저장하고 본문 상대경로를 돌려준다. */
  saveImage?(data: Uint8Array, ext: string): Promise<string>;
  /** 본문 링크 클릭 → 시스템 기본 브라우저(웹뷰 안에서는 탐색하지 않는다). */
  openExternalUrl?(url: string): void;
  /**
   * 우클릭 메뉴 복사/잘라내기·붙여넣기가 쓰는 클립보드. 미제공이면 브라우저 API로 떨어진다
   * (jsdom 단위 테스트·e2e의 경로). 부트스트랩은 **네이티브 우선** 구현을 넘긴다 —
   * `navigator.clipboard`는 Windows(WebView2)에서 거절되는 일이 잦다(shared/tauri.ts 참고).
   */
  writeClipboard?(text: string): Promise<void>;
  readClipboard?(): Promise<string>;
  /**
   * 설정 창을 연다 — 컨텍스트 메뉴 "설정 열기"가 부른다(노트 툴바의 "설정 바로가기" 버튼,
   * 이슈 #16, note-toolbar.ts와 같은 기능·같은 배선원 `shared/tauri.ts`의 `openSettings()`).
   * 미제공이면(구버전 deps·테스트) 그 항목은 아무 일도 하지 않는다.
   */
  openSettings?(): Promise<void>;
  /**
   * 노트 목록·검색 패널을 연다 — 컨텍스트 메뉴 "노트 목록·검색 열기"가 부른다(패널의 "+" 버튼과
   * 같은 배선원 `shared/tauri.ts`의 `openNotePanel()`, 베타 피드백 2건). 미제공이면(구버전
   * deps·테스트) 그 항목은 아무 일도 하지 않는다.
   */
  openPanel?(): Promise<void>;
  /**
   * 새 노트를 만들고 그 창을 연다 — 컨텍스트 메뉴 "새 메모"가 부른다(패널의 "+" 버튼과 같은
   * 배선원 `shared/tauri.ts`의 `createAndOpenNote()`, 베타 피드백 1·2건). 미제공이면(구버전
   * deps·테스트) 그 항목은 아무 일도 하지 않는다.
   */
  createNote?(): Promise<void>;
  /** 활성 테마가 공급한 색 토큰 디스크립터. 부트스트랩이 해석해 넘긴다. */
  theme: ThemeDescriptor;
  /** 활성 테마에 대한 사용자 색 오버라이드(토큰 → hex). 부트스트랩이 공유 설정에서 읽어 넘긴다. */
  themeOverrides?: Record<string, string>;
  /** 활성 배경 능력(배경 플러그인이 공급한 스와치·자동 대비). 없으면(플러그인 off) 고정 배경. */
  background?: BackgroundDescriptor | null;
  /** 전역 기본 글자 크기(px, 앱 설정). 메모 델타(font_delta%)가 여기 더해진다. 기본 14. */
  baseFontPx?: number;
  /**
   * 사용자가 고른 전역 폰트 스택 — 공유 설정 `defaults.font_family`의 **원본 값**이다.
   *
   * 해석(=능력 게이트)은 창이 한다: 폰트 능력([`font`])이 없으면 이 값을 **무시하고** 시스템
   * 기본으로 고정한다(배경 능력의 "끄면 고정"과 대칭). 예전엔 호출부가 미리 해석해 넘겼는데,
   * 그러면 같은 규칙이 마운트(호출부)와 재적용(창) 두 벌이 되어 국소 반영·재빌드 조정에서
   * 조용히 갈린다 — 규칙을 [`resolveFontFamily`] 한 곳에 두고 창이 언제나 그것만 본다.
   */
  fontFamily?: string | null;
  /**
   * 활성 폰트 능력(폰트 플러그인이 공급한 디스크립터). 없으면(플러그인 off) 시스템 기본 고정.
   * 창이 이 값을 들고 있어야 저장값만 바뀐 뒤에도 게이트를 다시 판정할 수 있다.
   */
  font?: FontDescriptor | null;
  /**
   * 지금 살아 있는 플러그인 능력(창 컨트롤·youtube-embed) — 조건부 UI의 노출 조건이다.
   *
   * **필수다.** 예전엔 능력마다 옵셔널 플래그였고 미제공이면 "전부 켜짐"으로 봤다 — 그래서
   * 호출부가 하나를 빠뜨리면 사용자가 **꺼둔** 플러그인의 UI가 조용히 그려졌는데도 컴파일이
   * 통과했다(fail-open). 모르면 [`NO_CAPABILITIES`]를 넘겨 "안 그린다"를 명시한다(추정 금지).
   */
  capabilities: PluginCapabilities;
  /** 창 단위 도구 단축키(동작 id → 키 가속기). 공유 설정에서 읽어 넘긴다. 없으면 키맵 미설치. */
  keybindings?: Record<string, string>;
  /** 전역 툴바 배치(설정 창 드래그&드롭). 부트스트랩이 공유 설정에서 읽어 넘긴다. 없으면 기본 배치. */
  toolbarLayout?: ToolbarLayout;
  /** 이 기기가 macOS인지(가속기의 `Mod`=⌘/Ctrl 해석에 사용). 기본 false. */
  isMac?: boolean;
  installPlugins?(ctx: {
    /**
     * 플러그인 CM 확장을 주입한다 — `extension`은 렌더(프리뷰 off면 내려감), `meta`는 색 문법
     * facet 등 **사실 정보**(프리뷰와 무관하게 유지). 선택 액션이 "렌더가 아니라 사용자 동작"
     * 이라 프리뷰와 무관한 것과 같은 이유다(bootstrap/note.ts의 setSelectionActions 참고).
     */
    setPluginExtensions(extension: Extension, meta: Extension): void;
    /**
     * 플러그인이 등록한 항목 **전체**를 이 창에 맞춘다(호스트가 렌더) — 핸들의
     * [`NoteWindowHandle.reconcileToolbarItems`]와 **같은 함수**다. `menuOnly` 항목은 툴바에
     * 자리를 잡지 않고 에디터 컨텍스트 메뉴에만 나타난다(버튼 없는 명령이 그렇다).
     *
     * 왜 핸들 말고 여기에도 있나: 배선(`bootstrap/note.ts`)의 최초 등록은 스냅샷이 도착하는
     * `then` 안에서 일어나는데, 스냅샷이 제때 왔으면 그 콜백이 **`mountNoteWindow`의 await가
     * 풀리기 전에** 실행된다 — 그 시점에 핸들 변수는 아직 TDZ라 건드리면 ReferenceError다
     * (플러그인 버튼이 통째로 사라진다). 그래서 마운트 경로는 이 ctx를 쓰고, 재빌드 후
     * 조정 경로만 핸들을 쓴다.
     */
    reconcileToolbarItems(items: readonly PluginWindowItem[]): void;
    /**
     * 상태 표시형 아이템의 이 창 표시 텍스트/툴팁을 갱신한다 — 갱신한 id, **이 창에 그런
     * 상태 아이템이 없으면 null**(호출부가 `INVALID_ARGS`로 거부한다). `owner`는 호스트가 검증한
     * 호출 주체 플러그인 id다(상태 아이템 키 `plugin:<owner>:<id>`의 네임스페이스).
     */
    updateStatusItem(
      spec: { id: string; text?: string; title?: string },
      owner: string,
    ): string | null;
    /**
     * 토스트를 띄우거나 갱신·닫는다. 새로 띄웠으면 그 id, 갱신·닫기였으면 그 id,
     * **모르는 id였으면 null**(호출부가 `INVALID_ARGS`로 거부한다).
     *
     * `owner`는 호출 주체 플러그인 id(**호스트가 검증한 값** — 생략 시 코어 네임스페이스).
     * 토스트는 (창, 플러그인, id)로 격리된다: 발급 id에 노트 id가 섞여 다른 창의 갱신이
     * 이 창의 무관한 토스트에 꽂히지 않고, 조회 키에 owner가 섞여 다른 플러그인이 순번을
     * 추측해도 남의 토스트를 닫거나 바꿔치지 못한다.
     */
    showToast(spec: NoteToastSpec, owner?: string): string | null;
    /** 폰트 플러그인용: 메모 글자 델타(%) 읽기/쓰기(호스트가 실효 크기 적용·영속화). */
    getFontDelta(): number;
    /** 델타를 실효 px 범위로 클램프해 적용·영속화하고 **실제 적용된** 델타(%)를 돌려준다. */
    setFontDelta(deltaPct: number): number;
    /** 옵션 초기화 플러그인용: 이 메모만의 override를 전역 기본값으로 되돌린다(confirm 게이트 + 재적용·재동기화·영속화·토스트). */
    resetOptions(): void;
    /** 현재 에디터 본문(라이브). 플러그인의 notes.current({content})·복사 문구 치환에 쓴다. */
    getContent(): string;
    /** 커서 위치(또는 문서 끝/전체)에 텍스트 삽입. mode=cursor|append|replace, caret=삽입 본문 내 커서 오프셋. */
    insertText(text: string, mode: string, caret?: number): void;
    /** 목록 팝업으로 항목·액션을 고르게 한다(취소=null). 항목별 부제·다중 액션 지원. */
    pickList(spec: PickListSpec): Promise<PickResult | null>;
    /** 입력 팝업 — 한 줄 입력(문자열) 또는 다중 필드 폼(`Record<id, 값>`). 취소=null. */
    prompt(
      spec: PromptSpec,
    ): Promise<string | Record<string, FormValue> | null>;
  }): void;
  saveDebounceMs?: number;
  /**
   * `loadNote`(IPC)를 기다리는 상한(ms). 기본 [`LOAD_TIMEOUT_MS`], 0 이하면 상한 없음.
   * 백엔드 무응답이 빈 창으로 굳지 않게 하는 안전망이라 테스트에서 짧게 줄여 검증한다.
   */
  loadTimeoutMs?: number;
}

/**
 * mountNoteWindow가 돌려주는 핸들 — 마운트 이후 노트창 바깥(main.ts)에서 부를 수 있는 동작.
 * export하지 않는다(호출부는 `mountNoteWindow()`의 반환값을 타입 추론으로만 쓴다 — knip 미사용
 * export 방지). 필요하면 `Awaited<ReturnType<typeof mountNoteWindow>>`로 이름 붙일 수 있다.
 */
interface NoteWindowHandle {
  /**
   * 대기 중인(디바운스된) 본문 저장을 즉시 확정한다. 왜: 호스트 재빌드 후의 `location.reload()`
   * 등 500ms 디바운스를 기다릴 수 없는 시점에 부르면, 그 직전까지의 타이핑이 유실되지 않는다.
   */
  flushSave(): void;
  /**
   * 본문을 디스크에서 다시 읽어 에디터에 반영한다(스냅샷 복원 등 바깥에서 파일이 바뀐 경우 —
   * finding 4). 낡은 버퍼가 다음 자동저장에서 그 변경을 덮지 않게 한다. 창을 통째로 리로드하지
   * 않아 스크롤·플러그인 상태는 유지된다(콘텐츠만 교체).
   */
  reloadContent(): Promise<void>;
  /**
   * 대기 중인(디바운스된) 본문 저장을 **실행 없이** 버린다. 왜: 이 노트가 백엔드에서 이미
   * 지워졌다는 통지(`note-deleted`, `bootstrap/note.ts`)를 받으면, 뒤이어 창을 닫을 때
   * 나가는 `pagehide` flush가 `note_save_content`를 불러 지운 `.md`를 되살릴 수 있다
   * (`write_atomic`이 부모 디렉터리까지 새로 만든다) — 창 자신의 삭제 버튼 경로
   * (`deleteNote` 핸들러의 `save.cancel()`)와 같은 이유로 닫기 **전에** 먼저 불러야 한다.
   * 이미 취소돼 있어도(중복 호출) 안전하다(`debounce().cancel()`은 멱등).
   */
  cancelSave(): void;
  /**
   * 백엔드가 스스로 뒤집은 접힘 상태를 창 UI에 반영한다(`note-collapsed-changed`,
   * `bootstrap/note.ts`) — 세로 리사이즈로 일어나는 자동 전이가 그 경로다.
   *
   * **표시만** 바꾼다: 창 높이·메타는 백엔드가 이미 확정했으므로 `applyCollapsed`(→
   * `set_note_collapsed`)도 override 저장도 부르지 않는다. 되불렀다면 그 리사이즈가 다시 이
   * 통지를 낳는 왕복이 된다. 이미 같은 상태면 아무 일도 하지 않는다(멱등).
   */
  syncCollapsed(collapsed: boolean): void;
  /**
   * 활성 테마 위에 얹는 **사용자 색 오버라이드만** 바꿔 다시 적용한다(`settings-changed-local`,
   * `bootstrap/note.ts`). 활성 테마 자체는 지금 값 그대로다 — 테마가 함께 바뀌었으면
   * [`applyTheme`]가 둘을 한 번에 처리한다.
   *
   * 왜 리로드 대신 이 길인가: 색 하나 고칠 때마다 모든 노트 창이 `location.reload()`하면
   * 화면이 깜빡이고 스크롤·선택·IME 조합·플러그인 상태가 초기화된다. 여기서는 CSS 변수만
   * 다시 쓴다. 새 오버라이드에 없어진 토큰의 인라인 변수는 지운다 — 안 지우면 방금 지운
   * 사용자 색이 그대로 남아 "되돌리기가 안 되는" 것처럼 보인다(설정 창의 같은 정리와 대칭).
   */
  applyThemeOverrides(overrides: Record<string, string> | null): void;
  /**
   * **활성 테마 자체**를 갈아 끼우고 그 위에 오버라이드를 다시 얹는다(호스트 재빌드 완료
   * 방송의 제자리 조정 — `bootstrap/host-update-plan.ts`).
   *
   * 왜 리로드가 아니어도 되나: [`ThemeDescriptor`]는 색 토큰뿐이고([`applyTheme`]가 CSS 변수를
   * 다시 쓴다), 그 토큰을 읽는 곳은 전부 `var(--memo-*)` 참조다(플러그인 인라인 패턴 CSS·
   * 팝업/토스트 CSS) — 값을 어디에도 구워 두지 않으므로 변수만 바꾸면 따라온다. 노트 배경은
   * 테마가 아니라 배경 능력의 몫이라 무관하다([`applyBackgroundCapability`]가 따로 다룬다).
   *
   * 오버라이드를 **함께** 받는 이유: 테마가 바뀌면 그에 딸린 사용자 색도 다른 엔트리로
   * 바뀐다(`theme_overrides[<테마>]`). 두 번에 나눠 부르면 그 사이에 옛 테마 + 새 색(또는
   * 그 반대)인 한 프레임이 보인다.
   */
  applyTheme(
    theme: ThemeDescriptor,
    overrides: Record<string, string> | null,
  ): void;
  /**
   * 전역 기본 글자 크기(px)를 바꿔 에디터에 다시 적용한다(`settings-changed-local`).
   *
   * 이 메모의 델타(`font_delta`%)는 그대로 유지한다 — 실효 크기는 언제나 "전역 기본 + 델타"라는
   * 기존 해석 규칙(`resolveOptions`)을 그대로 태운다. 폰트 플러그인의 확대/축소가 쓰는 기준
   * 값도 함께 앞으로 감기므로, 이 뒤의 A+/A−도 새 기본값 위에서 계산된다.
   */
  applyBaseFontPx(px: number): void;
  /**
   * 사용자가 고른 전역 폰트 스택(설정 `defaults.font_family` **원본**)을 다시 적용한다
   * (`settings-changed-local`). 능력 게이트는 창이 들고 있는 값으로 판정한다 — 폰트 플러그인이
   * 꺼져 있으면 저장값이 있어도 시스템 기본 그대로다.
   */
  applyFontFamily(saved: string | null): void;
  /**
   * 폰트 **능력**(플러그인 on/off·디스크립터)과 저장값을 함께 앞으로 감아 다시 해석한다
   * (호스트 재빌드 완료 방송의 제자리 조정).
   *
   * 능력과 값을 한 번에 받는 이유는 [`applyTheme`]와 같다: 둘 중 하나만 먼저 반영하면 그 사이에
   * "능력은 새것, 값은 옛것"인 상태로 한 번 그려진다.
   */
  applyFontCapability(font: FontDescriptor | null, saved: string | null): void;
  /**
   * 창 단위 도구 단축키를 통째로 갈아 끼운다(호스트 재빌드 완료 방송의 제자리 조정).
   *
   * 키맵 리스너는 재등록하지 않고 **참조만** 바꾼다(`installNoteKeymap`이 getter를 받는다) —
   * 떼었다 다시 다는 사이에 눌린 키가 유실되지 않는다. 새 맵이 옛 맵을 **대체**하므로, 사용자가
   * 지운 조합은 그 즉시 아무 동작도 하지 않는다(잔존 없음).
   */
  applyKeybindings(bindings: Record<string, string>): void;
  /**
   * 빌트인 유튜브 임베드 플러그인의 활성 여부를 바꿔 컨텍스트 메뉴의 "유튜브 추가" 항목을
   * 켜고 끈다(호스트 재빌드 완료 방송의 제자리 조정 — `bootstrap/host-update-plan.ts`).
   *
   * 메뉴는 우클릭마다 새로 조립되므로 다시 그릴 것이 없다: 다음 우클릭부터 반영된다
   * (툴바 DOM을 건드리는 배경·창 컨트롤과 달리 다시 그릴 것 자체가 없는 표면이다).
   */
  applyYoutubeEmbedEnabled(enabled: boolean): void;
  /**
   * **배경 능력**(배경 플러그인 on/off·팔레트 교체)을 앞으로 감아 다시 해석한다(호스트 재빌드
   * 완료 방송의 제자리 조정 — `bootstrap/host-update-plan.ts`).
   *
   * 세 가지가 한 번에 따라와야 한다: (1) 노트 배경색 자체 — 끄면 저장된 커스텀 색을 무시하고
   * 고정 기본 배경으로, 켜면 override(없으면 새 팔레트의 기본 스와치)로. (2) 그 색에 딸린
   * 대비(글자색·툴바 틴트) — `autoTextContrast`가 능력에서 오므로 함께 뒤집힌다. (3) 툴바의
   * 배경색 항목 — 스와치가 없어지면 지우고 생기면 되살린다.
   *
   * 순서가 중요하다: 새 색을 먼저 계산·적용한 **뒤** 그 값을 툴바에 넘긴다. 반대로 하면
   * 피커의 칩만 새 색이고 노트는 옛 색인 한 프레임이 보인다(`applyTheme`와 같은 이유).
   * override 데이터 자체는 어느 방향으로도 지우지 않는다 — 다시 켜면 그대로 복원된다.
   */
  applyBackgroundCapability(background: BackgroundDescriptor | null): void;
  /**
   * **창 컨트롤 능력**(투명도·항상 위·모든 데스크탑 플러그인 on/off)을 앞으로 감는다(호스트
   * 재빌드 완료 방송의 제자리 조정).
   *
   * 네이티브 창 상태까지 함께 맞춘다는 점이 다른 조정 단계와 다르다: 꺼지면 그 기능을 기본값
   * 으로 되돌리고(마운트의 강제 리셋과 같은 규칙), 켜지면 이 메모의 저장값을 **다시 적용한다**
   * — 백엔드의 `apply_saved_state`는 창 생성 때 한 번뿐이라, 여기서 하지 않으면 툴바만 저장값을
   * 보여 주고 창은 기본값인 어긋난 상태가 된다. 툴바 항목도 그 최신 값으로 되살아난다.
   */
  applyWindowControls(controls: readonly string[]): void;
  /**
   * 플러그인이 등록한 **툴바 버튼·상태 아이템·명령·메뉴 전용 항목**을 새 목록으로 맞춘다
   * (마운트의 최초 등록과 호스트 재빌드 후의 제자리 조정이 같은 경로 —
   * `bootstrap/host-update-plan.ts`의 `toolbar_items` 단계).
   *
   * 키(`plugin:<pluginId>:<id>`)로 diff한다: 없어진 키는 툴바 DOM·상태 아이템 조회·컨텍스트
   * 메뉴에서 통째로 지우고, 직렬화 필드가 달라진 키는 **옛 요소가 있던 자리에서** 다시 그리며,
   * 그대로인 키는 DOM을 건드리지 않는다(포커스·`⋯` 접힘·상태 아이템의 라이브 텍스트 보존).
   * 손대지 않은 항목도 클릭 핸들러만은 새 목록의 것으로 갈아 끼운다 — 재빌드는 샌드박스를
   * 전부 새로 만들어 옛 클로저가 잡고 있는 핸들러 id가 죽기 때문이다(누르면 아무 일도 일어나지
   * 않는 무음 실패).
   *
   * 왜 리로드가 아니어도 되나: 이 네 표면은 전부 스냅샷의 직렬화 값에서 나오고, 그리는 자리
   * (툴바 존·컨텍스트 메뉴)도 키 하나로 되짚을 수 있다 — 마운트 때 굳혀 둘 이유가 없다.
   */
  reconcileToolbarItems(items: readonly PluginWindowItem[]): void;
}

/**
 * 노트창을 host에 마운트한다: 본문·옵션 로드 → 에디터 → 옵션 툴바 → 자동저장/드래그.
 */
export async function mountNoteWindow(
  host: HTMLElement,
  id: string,
  deps: NoteWindowDeps,
): Promise<NoteWindowHandle> {
  const editorHost = document.createElement("div");
  editorHost.id = "editor";
  host.append(editorHost);

  // 본문 로드에 상한을 씌운다 — 백엔드가 응답하지 않으면 빈 창으로 굳는 대신 거부하고,
  // 그 거부가 전역 핸들러를 타고 오류 오버레이가 된다(이슈 #24, [`LOAD_TIMEOUT_MS`] 참고).
  const { content, overrides } = await withTimeout(
    deps.loadNote(id),
    deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS,
    t("note.error.load-timeout"),
  );
  // 가변인 이유: 설정 창에서 전역 기본 글자 크기가 바뀌면 창을 리로드하지 않고
  // `applyBaseFontPx`가 이 값을 앞으로 감는다 — 이후의 델타 계산(setFontDelta·옵션 초기화·
  // 접힘 재동기화)이 전부 새 기본값 위에서 돌아야 한다.
  let baseFontPx = deps.baseFontPx ?? 14;
  const opts = resolveOptions(overrides, baseFontPx);
  const saveImage = deps.saveImage;

  // 가변인 이유: 활성 테마가 바뀌면(설정 창의 테마 선택 → 호스트 재빌드) 창을 리로드하지 않고
  // `applyTheme`가 이 값을 앞으로 감는다 — 이후의 오버라이드 재적용도 새 팔레트 위에서 돈다.
  let activeTheme = deps.theme;
  // 테마가 준 팔레트 위에 사용자 색 오버라이드를 얹어 적용한다(토큰만 영향 — 배경 스와치·
  // 자동 대비는 테마 원본을 그대로 쓴다). 설정 창에서 색만 바뀌면 리로드 없이 이 함수만
  // 다시 돌린다(`applyThemeOverrides`).
  const applyThemeWithOverrides = (
    themeOverrides: Record<string, string> | null | undefined,
  ): void => {
    const merged = mergeThemeOverrides(activeTheme, themeOverrides);
    applyTheme(document.documentElement, merged);
    // 방금 사라진 오버라이드가 인라인 변수로 남지 않게 정리한다(테마가 선언하지 않은 토큰이면
    // applyTheme이 덮어쓰지 못한다) → CSS 폴백이 되살아난다. 변수 이름 규칙은 applyTheme과 동일.
    for (const key of ALL_TOKEN_KEYS) {
      if (key in merged.tokens) continue;
      document.documentElement.style.removeProperty(
        isSurfaceToken(key) ? `--memo-${key}-light` : `--memo-${key}`,
      );
    }
  };
  applyThemeWithOverrides(deps.themeOverrides);
  // 가변인 이유: 배경 플러그인이 켜지거나 꺼지면(호스트 재빌드) 창을 리로드하지 않고
  // `applyBackgroundCapability`가 이 값을 앞으로 감는다 — 스와치·자동 대비·폴백 색이 전부
  // 여기서 파생되므로, 능력을 참조하는 자리를 하나로 모아야 한 곳만 갱신되는 누락이 없다.
  let activeBackground = deps.background ?? null;
  // 배경 스와치·자동 대비는 배경 플러그인이 공급한다(off면 스와치 없음 → 고정 배경·고정 대비).
  let swatches = activeBackground?.swatches ?? [];
  let autoTextContrast = activeBackground?.autoTextContrast ?? false;
  let fallbackBg = swatches[0] ?? DEFAULT_BACKGROUND_COLOR;
  // 노트 배경 + 툴바 버튼 틴트(--tb-on) + 글자색(--note-text)을 함께 적용한다. 대비 값은
  // 배경 능력의 autoTextContrast를 따른다(자동 대비 or 고정 기본값) — 결정 로직은 순수 함수로 분리.
  const applyBg = (color: string) => {
    host.style.background = color;
    const { tbOn, noteText } = contrastVars(color, autoTextContrast);
    host.style.setProperty("--tb-on", tbOn);
    host.style.setProperty("--note-text", noteText);
    host.style.setProperty("--note-bg", color); // ⋯ 오버플로 배지의 잉크 대비색.
  };
  /**
   * 저장된 배경 override를 **지금의 능력**으로 해석한다.
   *
   * 배경 플러그인이 off면(능력 없음) override를 무시하고 고정 기본 배경을 쓴다("끄면 고정
   * 배경" — 저장된 다크 커스텀 색이 고정 대비와 만나 안 읽히는 것도 함께 막는다). on이면
   * override(없으면 스와치 기본)를 해석한다. override 데이터 자체는 보존된다(다시 켜면 복원).
   *
   * 함수인 이유: 같은 해석이 마운트·옵션 초기화·접힘 재동기화·능력 전환 네 곳에서 필요하고,
   * 그중 셋은 능력이 바뀐 **뒤에** 다시 물어야 한다 — 값으로 굳히면 그때마다 갈린다.
   */
  const resolveNoteBg = (background: unknown): string =>
    activeBackground
      ? resolveBackgroundColor(background, fallbackBg)
      : DEFAULT_BACKGROUND_COLOR;
  const noteBg = resolveNoteBg(overrides.background);
  applyBg(noteBg);

  // 저장 대기 중인(=아직 디스크에 안 내려간) 사용자 편집이 있는지 추적한다. onChange마다 참이
  // 되고, 자동저장이 실제로 커밋될 때 거짓이 된다. reloadContent가 이 플래그를 보고, 사용자가
  // 방금 친 미저장 타이핑을 프로그램적 쓰기(플러그인 notes.write·스냅샷 복원)로 조용히 덮지
  // 않게 한다(finding 2·3 — 그 손실은 디스크에도 스냅샷에도 없어 복구조차 불가능하다).
  let unsaved = false;
  // 접힘 헤더 라벨 재조회 슬롯 — 라벨 요소는 툴바가 만들어진 뒤(아래)에야 생기므로, 그보다 먼저
  // 정의되는 저장 콜백이 안전하게 참조할 수 있게 먼저 선언해 둔다(applyCollapsedVisibility와 같은 패턴).
  let updateCollapsedTitle: () => void = () => {};
  const save = debounce((text: string) => {
    // deps.saveContent는 인터페이스상 void 반환이지만, 실제 부트스트랩 구현(bootstrap/note.ts)은
    // 저장 IPC가 끝난 뒤에야 해소되는 프라미스를 돌려준다 — Promise.resolve가 그 프라미스를 그대로
    // 받아써(thenable 채택) "저장이 실제로 끝난 뒤"(백엔드 refresh_window_title 이후)를 관찰한다.
    // 자동저장은 디바운스라 "고치고 곧바로 접기"는 이 재조회가 없으면 옛 제목에 걸린다. void
    // 반환(구버전 deps·테스트)이면 다음 마이크로태스크에 바로 풀려 사실상 즉시 재조회할 뿐이라 무해하다.
    void Promise.resolve(deps.saveContent(id, text)).then(() => {
      if (host.classList.contains("note-collapsed")) updateCollapsedTitle();
    });
    unsaved = false;
  }, deps.saveDebounceMs ?? 500);
  // 에디터 변경을 받아 미저장 플래그를 세운 뒤 디바운스 저장을 무장한다(setContent도 여기를
  // 거치지만, reloadContent가 디스크 동기화 직후 플래그를 되돌린다).
  const onEditorChange = (text: string): void => {
    unsaved = true;
    save(text);
  };
  // 창이 그냥 닫히거나(사용자가 X) 백그라운드로 밀려도 대기 중인 저장이 유실되지 않게 flush한다
  // (호스트 재빌드발 reload는 main.ts가 반환된 flushSave()를 불러 같은 문제를 막는다).
  window.addEventListener("pagehide", () => save.flush());
  // 폰트 능력도 가변이다 — 폰트 플러그인이 꺼지거나 켜지면(호스트 재빌드) 저장값의 게이트가
  // 뒤집힌다. 마운트와 재적용이 **같은 함수**(`resolveFontFamily`)를 보게 해 두 경로가 갈리지
  // 않게 한다(테마 오버라이드·기본 글자 크기와 같은 결).
  let activeFont = deps.font ?? null;
  const editor = createEditor(editorHost, content, {
    onChange: onEditorChange,
    preview: opts.preview,
    fontSize: opts.fontSize,
    fontFamily: resolveFontFamily(activeFont, deps.fontFamily),
    resolveImageSrc: deps.resolveImageSrc,
    openExternalUrl: deps.openExternalUrl,
    saveImage,
  });
  /** 저장값(설정 원본)을 지금의 능력 게이트로 해석해 에디터에 적용한다. */
  const applyFontFamily = (saved: string | null | undefined): void =>
    editor.setFontFamily(resolveFontFamily(activeFont, saved));

  // ── 창 포커스 → 에디터 DOM 포커스 (이슈: 새 창/summon_note로 창이 맨 앞에 와도 타이핑이 안 됨) ──
  //
  // Rust 쪽(window_manager.rs)이 `set_focus`+`raise_window`로 **창**은 맨 앞으로 올리지만, 그
  // 것만으로는 webview 안의 `document.activeElement`가 바뀌지 않는다 — OS 포커스와 DOM 포커스는
  // 별개다. 아무도 DOM 포커스를 옮기지 않으면 activeElement가 body에 머물러 키 입력이 갈 곳이
  // 없다.
  //
  // 마운트 직후 1회: 새 창이 뜨자마자 바로 타이핑할 수 있어야 한다. 다만 이미 무언가(향후 추가될
  // 초기화 등)가 포커스를 잡아 두었을 수 있으므로, activeElement가 아직 아무도 안 잡은 상태
  // (body 또는 null)일 때만 옮긴다 — 덮어쓰지 않는다.
  if (
    document.activeElement === null ||
    document.activeElement === document.body
  ) {
    editor.view.focus();
  }
  // `window` `focus` DOM 이벤트를 쓴다(Tauri `onFocusChanged`가 아니다) — jsdom 단위 테스트에서
  // Tauri 이벤트 채널을 흉내 낼 필요가 없어 이 파일이 계속 Tauri-프리로 테스트 가능하다. 이
  // 창이 다시 OS 포커스를 받을 때마다(다른 창/앱에서 전환) 실행되어, "떠 있기만 하고 타이핑이
  // 안 되는" 창을 다시 만들지 않는다. 검색창·제목 입력 등 사용자가 지금 타이핑 중인 다른 요소가
  // 포커스면 건드리지 않는다([`isTextEntryElement`]).
  window.addEventListener("focus", () => {
    if (isTextEntryElement(document.activeElement)) return;
    editor.view.focus();
  });

  // 활성화된 창 컨트롤(투명도·항상 위·모든 데스크탑) — 각 번들 플러그인이 켜져 있을 때만
  // 툴바에 노출한다. 부트스트랩이 스냅샷 또는 번들 활성 레지스트리로 **이미 확정한** 값이라
  // 이 층에는 폴백이 없다(있으면 그게 곧 추정이다). 가변인 이유는 배경 능력과 같다 — 플러그인이
  // 켜지거나 꺼지면 `applyWindowControls`가 이 값을 앞으로 감는다(리로드 없이).
  let activeWindowControls: readonly string[] =
    deps.capabilities.windowControls;
  /**
   * 네이티브 창 상태를 지금의 컨트롤 능력에 맞춘다.
   *
   * - **꺼진** 컨트롤: 그 기능을 기본값으로 되돌린다(배경 플러그인과 대칭: "끄면 고정 기본값").
   *   저장된 override 데이터는 보존한다 — 다시 켜면 복원된다.
   * - **켜진** 컨트롤: `reapplyEnabled`일 때만 저장값의 실효값을 다시 적용한다. 마운트에는
   *   필요 없다(창을 만들 때 백엔드 `apply_saved_state`가 이미 적용했다) — 런타임에 능력이
   *   켜지는 경로에서만 참이다. 그 경로엔 백엔드가 다시 오지 않으므로, 여기서 재적용하지
   *   않으면 툴바 슬라이더·토글만 저장값을 가리키고 **창은 기본값 그대로** 남는다.
   */
  const syncWindowControlNatives = (
    resolved: NoteOptionState,
    reapplyEnabled: boolean,
  ): void => {
    const on = (id: string): boolean => activeWindowControls.includes(id);
    if (!on("transparency")) deps.applyTransparency(100);
    else if (reapplyEnabled) deps.applyTransparency(resolved.transparency);
    if (!on("always-on-top")) deps.applyPinned(false);
    else if (reapplyEnabled) deps.applyPinned(resolved.pinned);
    if (!on("all-desktops")) deps.applyAllSpaces(false);
    else if (reapplyEnabled) deps.applyAllSpaces(resolved.allSpaces);
  };
  syncWindowControlNatives(opts, false);

  // 변경되는 override를 모아 통째로 저장(창 위치 등은 백엔드가 보존).
  const current: NoteOverrides = { ...overrides };
  const persist = () => deps.saveOverrides(id, current);

  // 하단 바(보관·삭제로 항상 존재)를 setCollapsed가 참조해 접힘 시 에디터와 함께 숨긴다
  // (창이 헤더 높이라 하단 바가 잘려 어색해지지 않게). createNoteToolbar가 만든 뒤 대입한다.
  let bottomBar: HTMLElement | null = null;
  // 접힘 표시 적용 함수 — 바가 만들어진 뒤 대입한다(핸들러 setCollapsed가 클릭 시점에 참조).
  let applyCollapsedVisibility: (on: boolean) => void = () => {};
  // 옵션 초기화 후 툴바 컨트롤 UI를 되맞추는 재동기화 콜백. createNoteToolbar가 만든 뒤 대입한다
  // (resetOptions는 플러그인 버튼 클릭 → 호스트 브리지로 나중에 호출되므로 그때는 이미 세팅돼 있다).
  let resyncToolbar: NoteToolbarResync | null = null;

  const {
    top: toolbar,
    bottom,
    resync,
    placeItem,
    closeMenus: closeToolbarMenus,
    setCollapsedTitle,
    setBackgroundCapability,
    setWindowControls,
  } = createNoteToolbar({
    state: opts,
    handlers: {
      togglePreview: (on) => {
        editor.setPreview(on);
        current.markdown_preview = on;
        persist();
      },
      setPinned: (on) => {
        deps.applyPinned(on);
        current.pinned = on;
        persist();
      },
      setTransparency: (percent) => {
        // 드래그 중엔 적용만 — 영속화는 commit(슬라이더 change)에서 한 번.
        deps.applyTransparency(percent);
        current.transparency = percent;
      },
      setAllSpaces: (on) => {
        deps.applyAllSpaces(on);
        current.all_spaces = on;
        persist();
      },
      setCollapsed: (on) => {
        // 에디터·바 표시만 토글하고, 창 높이 조절·prev_height·collapsed 영속화는 백엔드가 한다.
        applyCollapsedVisibility(on);
        deps.applyCollapsed(on);
        current.collapsed = on; // 다른 override 저장 시 함께 나가도록 로컬 동기화.
      },
      setBackground: (color) => {
        // 색 드래그 중엔 적용만 — 영속화는 commit에서.
        applyBg(color);
        current.background = { type: "color", value: color };
      },
      commit: () => persist(),
      archiveNote: () => {
        // 빈 노트는 보관 대신 정리(삭제), 내용이 있으면 보관.
        if (editor.view.state.doc.toString().trim() === "") {
          // 삭제로 가는 길: 대기 중인 저장을 **버린다**. 이 경로는 삭제 IPC가 끝난 뒤 창이
          // 닫히고 그때 pagehide가 떨어지므로, 남겨두면 flush가 삭제 **이후에** 본문을 써
          // 메타 없는 `.md`를 되살린다(reconcile이 다음 실행에 메타를 만들어 노트가 부활).
          save.cancel();
          deps.deleteNote(id);
        } else {
          // 보관은 본문을 보존한다 → 버리지 않고 **지금 확정**한다(마지막 타이핑 유실 방지).
          // flush가 타이머·대기값을 비우므로 창 닫힘의 pagehide flush는 자동으로 no-op이 된다.
          save.flush();
          deps.archiveNote(id);
        }
      },
      deleteNote: () => {
        void confirmDialog(
          host,
          t("note.window.delete-confirm"),
          t("note.window.delete-confirm-label"),
        ).then((ok) => {
          if (!ok) return;
          save.cancel(); // 삭제 확정 뒤의 본문 저장은 파일을 되살릴 뿐이다.
          deps.deleteNote(id);
        });
      },
    },
    swatches,
    currentBackground: noteBg,
    capabilities: deps.capabilities,
    layout: resolveLayout(deps.toolbarLayout),
  });
  resyncToolbar = resync; // 옵션 초기화 핸들러가 클릭 시점에 참조한다.

  // 툴바 빈 영역(버튼/입력/메뉴가 아닌 곳)을 잡으면 borderless 창을 드래그한다(상·하 바 공용).
  const onToolbarMousedown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 상호작용 컨트롤 위에서는 창 이동을 걸지 않는다 — 걸면 네이티브 드래그 루프가 mouseup을
    // 가져가 클릭이 사라진다(Windows에서 특히 확실하게). `.is-clickable`은 버튼이 아닌
    // 클릭 가능 요소가 다시 생기더라도 같은 규칙을 타게 하는 안전망이다.
    if (target.closest("button, input, .note-toolbar-menu, .is-clickable"))
      return;
    // 네이티브 창 이동(startDragging)과 함께 WebKit이 같은 mousedown을 텍스트 선택 제스처로
    // 잡아 이동 중 커서가 I-beam(선택)으로 바뀌는 걸 막는다. 빈 드래그 영역에서만 실행되고
    // (버튼·입력·메뉴는 위에서 early-return) 포커스는 유지된다.
    event.preventDefault();
    deps.startDrag();
  };
  toolbar.addEventListener("mousedown", onToolbarMousedown);
  bottom.addEventListener("mousedown", onToolbarMousedown);

  bottomBar = bottom;
  host.prepend(toolbar);
  host.append(bottom);

  /**
   * 라벨(접힘 헤더, `core:collapsed-title` 배치 항목 — toolbar-layout.ts·note-toolbar.ts 참고)을
   * 지금 창 타이틀(본문 첫 줄)로 맞춘다. 항목이 배치에 없으면 setCollapsedTitle이 no-op이므로
   * (창 타이틀을 읽어도 갈 곳이 없다) 이 함수도 그대로 안전하다.
   *
   * 왜 두 시점에 다시 읽는가: 타이틀은 본문 저장 때 백엔드가 갱신하는데(`refresh_window_title`),
   * 자동저장은 디바운스라 "고치고 곧바로 접기"는 아직 옛 제목인 순간에 걸린다. 접힘 진입 시
   * 한 번(아래 applyCollapsedVisibility), 저장이 실제로 끝난 뒤 접혀 있으면 한 번 더(위 save
   * 콜백) 읽어야 사용자가 보는 값이 항상 최신이다. 읽지 못했으면(빈 문자열) 이전 값을 그대로
   * 둔다 — 틀린 제목보다 낫다.
   */
  updateCollapsedTitle = (): void => {
    void deps.windowTitle?.().then((title) => {
      if (!title) return;
      setCollapsedTitle(title);
    });
  };

  // 접힘 표시 적용 — 에디터와 하단 바를 숨기고 상단 바만 남긴다(접힘 창은 헤더 38px 한 줄).
  // 접기 버튼은 상단 전용이라(스펙: resolveLayout·편집기가 강제) 항상 상단 바에 있어 다시 펼칠 수
  // 있다. 상단이 0단이면 접기가 배치될 수 없어 UI 접기 자체가 없다(사용자 선택 — 갇힘 없음).
  applyCollapsedVisibility = (on: boolean): void => {
    editorHost.style.display = on ? "none" : "";
    if (bottomBar) bottomBar.style.display = on ? "none" : "";
    // 접힘 시 #app(host)에 클래스를 걸어 상단 바를 창 세로 중앙에 맞춘다(CSS .note-collapsed).
    host.classList.toggle("note-collapsed", on);
    if (on) {
      // 선택 툴바(글자 색 팔레트 등)는 에디터 밖 #app 직속이라 에디터를 숨겨도 그대로 떠
      // 있는다 — 헤더 높이만 남은 창에서는 잘려 "레이어가 아주 작게" 보인다(사용자 보고).
      // CSS(.note-collapsed)가 표시를 막지만, 내부 상태까지 접어 둬야 다시 펼쳤을 때 낡은
      // 좌표에 되살아나지 않는다.
      hideSelectionToolbar(editor.view);
      // 같은 이유로 플러그인 버튼·배경색 피커도 CSS(styles.css)가 트리거를 감추지만, 이미
      // 열려 있던 `⋯`·배경색 패널은 그것만으로 안 닫힌다(hidden 속성은 그대로 false) — 닫아
      // 둬야 다시 펼쳤을 때 뜬금없이 열린 패널이 보이지 않는다.
      closeToolbarMenus();
      updateCollapsedTitle();
    }
    // 펼침 상태의 라벨 숨김은 CSS 게이트(`#app.note-collapsed .note-collapsed-title`)가 맡는다
    // — 여기서 텍스트를 지울 필요가 없다(다음 접힘 때 갱신 전까지 이전 값을 보여줘도 무해하다).
  };
  // 접힘으로 저장됐지만 배치에 접기 컨트롤이 없으면(상단 0단이거나 사용자가 접기를 뺌) 다시 펼칠
  // 방법이 없어 빈 38px 창에 갇힌다 → 마운트에서 펼침으로 되돌린다(창 높이 복원 + 영속화, 안전망).
  if (
    opts.collapsed &&
    !toolbar.querySelector('[data-action="toggle-collapse"]')
  ) {
    deps.applyCollapsed(false);
    current.collapsed = false;
    persist();
    applyCollapsedVisibility(false);
  } else {
    applyCollapsedVisibility(opts.collapsed);
  }

  // 에디터 컨텍스트 메뉴의 플러그인 구역 — 등록 순서를 유지한다(Map은 삽입 순서를 보존한다).
  // 버튼은 툴바에도 있지만 툴바는 글리프만 보이므로(이름은 tooltip) 메뉴가 **이름으로 고르는**
  // 유일한 자리다. 빌트인(번들) 플러그인의 항목은 여기 싣지 않는다 — 빌트인은 툴바 버튼이 이미
  // 있어 이름으로 또 나열하면 중복이다(`mountItem`의 필터 참고). 커뮤니티/사이드로드 플러그인의
  // 항목만 실린다.
  //
  // 키는 아이템 키(`plugin:<pluginId>:<id>`)이고 그것이 곧 `MenuItem.id`다 — 런타임 조정
  // (`reconcileToolbarItems`)이 사라진 항목을 키 하나로 지울 수 있고, 클릭 실행부도 같은 키로
  // 레지스트리를 되짚는다(핸들러 사본을 여기 복사해 두지 않는 이유 — 아래 `registeredItems`).
  const pluginMenuItems = new Map<
    string,
    {
      item: MenuItem;
      /**
       * 메뉴 항목의 표시 조건(창 상태 키) — 우클릭 시점에 라이브 에디터 상태로 판정한다.
       * 툴바 버튼·명령은 없다(항상 보인다).
       */
      menuWhen?: WhenTerm[];
      /** 참이면 실행 시 우클릭 순간의 선택 텍스트를 핸들러에 넘긴다(payload 게이트). */
      needsSelectedText?: boolean;
    }
  >();

  // 플러그인 버튼을 내장 버튼과 같은 스타일로 만들어 배치(layout)가 지정한 존에 놓는다. 배치에
  // 이미 있으면 그 존, 없고 사용자가 명시적으로 뺀 것(seen)도 아니면(=한 번도 알지 못한 신규
  // 버튼 — 서드파티 설치·신규 번들) button.position이 가리키는 존에 자동 배치한다(createNoteToolbar
  // 의 placeItem이 판단). 그래서 설치 직후에도 버튼이 보이고, 사용자가 뺀 버튼은 계속 숨는다.
  // 상태 표시형 아이템의 렌더된 요소를 (owner, id) 키로 들고 있어, 창-스코프
  // ui.updateStatusItem이 라이브 텍스트를 갱신할 수 있게 한다. 키는 버튼과 같은 툴바 배치
  // 시스템을 쓰지만(`plugin:<pluginId>:<id>` 규약 자체는 그대로), host-client의
  // `snapshotToolbarButtons`가 상태 아이템의 id에 `status:`를 접두해 실어 보낸다 — 그래서
  // 실제 키는 `plugin:<pluginId>:status:<id>`가 되어, 같은 id의 버튼과 겹치지 않는다(둘 다
  // 같은 `next` Map에 모이는 `reconcileToolbarItems`에서 서로를 덮지 않는 이유). 아래
  // `updateStatusItem`은 저작자가 준 **원래(무접두) id**로 호출되므로 조회 직전에 같은
  // 접두를 붙인다. 배치에서 숨겨진(사용자가 팔레트로 뺀) 상태 아이템도 여기 등록해 둔다 —
  // 요소는 DOM에 붙지 않지만 갱신은 무해하게 성공하므로, 저작자가 "숨겼다는 이유로 갱신이
  // 조용히 거부되는" 혼란을 겪지 않는다.
  const statusEls = new Map<string, HTMLElement>();

  /**
   * 이 창이 지금 렌더 중인 플러그인 항목 전수 — 키는 [`pluginItemKey`], 값은 등록 원본과
   * 그 항목이 그린 요소다. 툴바 버튼·상태 아이템·명령·메뉴 전용 항목이 **모두** 여기 모인다.
   *
   * 왜 필요한가: 호스트 재빌드는 플러그인 항목을 통째로 다시 발급하는데, 예전에는 등록이
   * 부수효과뿐이라(추가만 있고 제거가 없었다) 무엇이 사라졌는지 알 방법이 없어 창을 리로드했다.
   * 키로 들고 있으면 새 목록과 diff해 없어진 것만 지우고 바뀐 것만 다시 그릴 수 있다
   * (`reconcileToolbarItems`).
   *
   * 클릭 핸들러를 요소에 **굽지 않고** 이 슬롯을 통해 부르는 이유: `onClick`은 재빌드마다
   * 새 클로저이고 그 안에 샌드박스 핸들러 id(`buttonId`)가 잡혀 있다. 직렬화 필드가 그대로라
   * 요소를 다시 그리지 않는 경우에도 **핸들러만은 최신으로 갈아 끼워야** 옛 샌드박스의 죽은
   * id를 역호출하지 않는다(그 실패는 "눌러도 아무 일이 없다"는 무음 실패로만 보인다).
   */
  const registeredItems = new Map<
    string,
    { item: PluginWindowItem; el: HTMLElement | null }
  >();

  /** 이 항목의 클릭/실행 핸들러를 **지금 등록된** 원본에서 찾아 부른다(위 주석의 최신성 규칙). */
  const invokeItem = (
    key: string,
    payload?: { selectedText?: string },
  ): void => {
    registeredItems.get(key)?.item.onClick(payload);
  };

  /**
   * 항목 하나의 **렌더 요소**를 만든다(툴바 버튼 또는 상태 표시형 텍스트). `menuOnly`면
   * 그릴 것이 없어 null이다(메뉴 항목 등록은 호출부 `mountItem`이 이미 마쳤다).
   */
  const createItemEl = (
    key: string,
    button: PluginWindowItem,
  ): HTMLElement | null => {
    // 상태 표시형 아이템은 기본적으로 클릭 버튼이 아니라 텍스트다 — 컨텍스트 메뉴에도
    // 올리지 않는다. 버튼과 같은 배치 키·placeItem 규칙을 타 사용자가 「툴바 배치」 편집기로
    // 버튼과 동급으로 옮길 수 있다(사용자 확정). `clickable`이 참이면(저작자가 onClick을 줬다 —
    // 예: 단어 수 세그먼트를 눌러 복사) 버튼과 같은 클릭 리스너를 붙이고 커서·hover로 그
    // 사실을 드러낸다 — 그 외에는 순수 텍스트로 남는다(기존 동작 그대로).
    if (button.status) {
      // 클릭 가능한 아이템은 **진짜 `<button>`**이어야 한다(순수 텍스트는 span 그대로).
      //
      // 왜: 이 바의 빈 영역 mousedown은 네이티브 창 이동(startDragging)을 건다. 그 핸들러는
      // `button, input, .note-toolbar-menu`만 예외로 두는데, 클릭 가능한 상태 아이템이 span이면
      // 여기 안 걸려 **누르는 순간 창 드래그가 시작된다**. Windows에서는 그 네이티브 드래그
      // 루프가 마우스를 캡처해 이어지는 mouseup을 먹어버리므로 DOM `click`이 끝내 발생하지
      // 않는다 — 단어 수를 눌러도 복사도 토스트도 없던 원인이다(macOS는 같은 상황에서도 클릭이
      // 살아남아 더 늦게 드러났다). 툴바 버튼(font-scale 등)이 두 OS에서 멀쩡한 것도 그것들이
      // 진짜 `<button>`이라 예외 목록에 걸리기 때문이다.
      // 덤: 키보드로 접근·실행할 수 있게 된다(span에는 없던 것).
      const el = document.createElement(button.clickable ? "button" : "span");
      if (el instanceof HTMLButtonElement) el.type = "button"; // 폼 제출 방지(기본값 submit).
      el.className = button.clickable
        ? "note-toolbar-status is-clickable"
        : "note-toolbar-status";
      el.textContent = button.label; // 초기 텍스트(등록 시점 값 — 이후 updateStatusItem이 갱신).
      if (button.title) el.title = button.title;
      if (button.clickable) {
        el.addEventListener("click", () => invokeItem(key));
      }
      return el;
    }
    // 버튼 없는 명령은 툴바에 자리를 차지하지 않는다 — 메뉴에만 남기고 여기서 끝낸다.
    if (button.menuOnly) return null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "note-toolbar-btn";
    // 글리프(아이콘)를 span으로 감싼다 — ⋯ 오버플로 메뉴에서 아이콘 열을 정렬하고, title은 CSS
    // `::after`가 그 옆 설명 레이블로 합성한다(인라인일 땐 아이콘만, 메뉴일 땐 아이콘+레이블).
    const icon = document.createElement("span");
    icon.className = "note-toolbar-btn-icon";
    icon.textContent = button.label;
    btn.append(icon);
    if (button.title) btn.title = button.title;
    // 단축키 디스패치용 안정 식별자 — 키맵이 이 버튼을 click()해 플러그인 onClick을 재사용한다.
    btn.dataset.action = key;
    // 무인자로 부른다 — onClick은 메뉴 항목을 위해 `{ selectedText }`를 받도록 넓혀졌지만
    // 툴바 버튼 클릭에는 선택 텍스트를 얹지 않는다(DOM 클릭이 MouseEvent를 넘기는 것도 막는다).
    btn.addEventListener("click", () => invokeItem(key));
    return btn;
  };

  /**
   * 항목 하나를 이 창에 실제로 등록한다 — 메뉴 자리·렌더 요소·레지스트리를 한 번에 맞춘다.
   *
   * `anchor`가 주어지면(내용만 바뀐 항목의 재마운트) 새 요소를 **옛 요소가 있던 자리**에
   * 그대로 끼운다: 새로 `placeItem`을 태우면 배치가 모르는(폴백) 항목이 존의 맨 뒤로 밀려,
   * 라벨 한 글자 바뀌었을 뿐인데 버튼이 이동한 것처럼 보인다(배치가 아는 키는 어느 쪽이든
   * 같은 자리다). 옛 요소가 `⋯` 패널에 접혀 있었다면 그 패널이 곧 자리다 — 존 컨트롤러의
   * MutationObserver가 이어서 다시 계산한다.
   */
  const mountItem = (
    key: string,
    button: PluginWindowItem,
    anchor: { parent: ParentNode; before: ChildNode | null } | null = null,
  ): void => {
    // 이름으로 고르는 자리(컨텍스트 메뉴)에는 커뮤니티/사이드로드 플러그인의 툴바 버튼도
    // 명령도 모두 올린다 — title(설명 레이블)이 있으면 그것을, 없으면 글리프를 쓴다. 빌트인
    // (번들) 플러그인 출처 항목 중 **툴바에 버튼으로 이미 떠 있는 것**만 뺀다: 그런 항목은
    // 이름으로 또 나열하면 중복이다(저작 가이드의 "툴바로 이미 제공되는 동작은 메뉴에 중복
    // 등록하지 말라"와 같은 결 — 빌트인은 그 규칙을 호스트가 강제로 지켜준다). 반대로
    // `menuOnly`(commands.register·ui.addMenuItem 출처라 애초에 툴바 자리가 없는 항목)는
    // 빌트인이라도 남긴다 — 걸러내면 중복 제거가 아니라 유일한 진입점 소멸이 된다(단축키
    // 배정 UI 말고는 실행할 방법이 사라진다). 상태 아이템은 클릭 동작이 아니라 표시라 제외다.
    if (
      button.status !== true &&
      (button.builtin !== true || button.menuOnly === true)
    ) {
      pluginMenuItems.set(key, {
        item: {
          id: key,
          label: button.title || button.label,
          ...(button.danger === true ? { danger: true } : {}),
        },
        // 메뉴 항목이면 표시 조건·선택 텍스트 게이트가 실려 온다(버튼·명령은 없다).
        ...(button.menuWhen !== undefined ? { menuWhen: button.menuWhen } : {}),
        ...(button.needsSelectedText === true
          ? { needsSelectedText: true }
          : {}),
      });
    }
    const el = createItemEl(key, button);
    registeredItems.set(key, { item: button, el });
    if (!el) return;
    if (button.status) statusEls.set(key, el);
    if (anchor) {
      // 제자리 삽입 — `placeItem`이 하는 일 중 여기서 필요한 것은 키 표식뿐이다.
      el.dataset.itemKey = key;
      anchor.parent.insertBefore(el, anchor.before);
      return;
    }
    placeItem(key, el, button.position);
  };

  /** 이 항목의 모든 흔적(요소·상태 아이템 조회·메뉴 자리·레지스트리)을 지운다. */
  const removeItem = (key: string): void => {
    const entry = registeredItems.get(key);
    if (!entry) return;
    // 요소가 `⋯` 오버플로 패널로 접혀 들어가 있어도 그대로 떨어진다(존 컨트롤러가 곧 재계산).
    entry.el?.remove();
    statusEls.delete(key);
    pluginMenuItems.delete(key);
    registeredItems.delete(key);
  };

  /**
   * 직렬화 필드가 같은가 — 함수(`onClick`)는 `JSON.stringify`가 건너뛰므로 자연히 빠진다.
   * 재빌드마다 새로 만들어지는 클로저 때문에 멀쩡한 항목이 다시 그려지는 일이 없다.
   */
  const sameItemSpec = (a: PluginWindowItem, b: PluginWindowItem): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  /**
   * 플러그인 항목 전체를 새 목록으로 맞춘다(마운트와 재빌드 후 조정이 **같은 경로**).
   *
   * 마운트는 빈 레지스트리에 대한 diff라 결과가 "전부 추가"다 — 두 경로를 하나로 둬야
   * "새로 연 창과 열려 있던 창이 다르게 보이는" 종류의 어긋남이 생기지 않는다.
   */
  const reconcileToolbarItems = (items: readonly PluginWindowItem[]): void => {
    const next = new Map<string, PluginWindowItem>();
    for (const item of items) {
      next.set(pluginItemKey(item.pluginId, item.id), item);
    }
    // (1) 없어진 항목부터 지운다 — 먼저 비워야 남는 항목의 자리 계산이 새 목록 기준이 된다.
    for (const key of [...registeredItems.keys()]) {
      if (!next.has(key)) removeItem(key);
    }
    for (const [key, item] of next) {
      const cur = registeredItems.get(key);
      // (2) 그대로인 항목: DOM을 건드리지 않는다(포커스·`⋯` 접힘·상태 아이템의 라이브 텍스트가
      // 살아남는다). 핸들러만 최신 클로저로 갈아 끼운다(레지스트리 주석 참고).
      if (cur && sameItemSpec(cur.item, item)) {
        cur.item = item;
        continue;
      }
      // (3) 바뀐 항목은 제자리 교체, 새 항목은 배치 규칙대로 삽입. 옛 요소의 자리를 **떼기
      // 전에** 기억해 둔다(떼고 나면 부모를 잃어 어디였는지 알 수 없다).
      const oldEl = cur?.el ?? null;
      const anchor = oldEl?.parentNode
        ? { parent: oldEl.parentNode, before: oldEl.nextSibling }
        : null;
      if (cur) removeItem(key);
      mountItem(key, item, anchor);
    }
    // (4) 메뉴 순서를 새 목록 순서로 되맞춘다. `pluginMenuItems`는 Map(삽입 순서)이라 바뀐
    // 항목만 다시 등록하면 그 항목이 메뉴 맨 아래로 밀린다 — 라벨 한 글자를 고쳤을 뿐인데
    // 메뉴에서 자리를 옮기는 셈이고, 리로드한 창(스냅샷 순서)과도 갈린다.
    const ordered = [...next.keys()]
      .filter((key) => pluginMenuItems.has(key))
      .map((key) => [key, pluginMenuItems.get(key)!] as const);
    pluginMenuItems.clear();
    for (const [key, entry] of ordered) pluginMenuItems.set(key, entry);
  };

  // 상태 아이템의 이 창 표시 텍스트/툴팁을 갱신한다(창-스코프 ui.updateStatusItem 수행부).
  // 키는 (owner, id)로 짓는다 — owner는 호스트가 검증한 호출 주체라, 다른 플러그인이 id를
  // 추측해도 남의 상태 아이템에 닿지 못한다. 부분 갱신(안 준 필드는 그대로)은 host-client가
  // 정규화해 넘긴다. 그 id의 요소가 이 창에 없으면 null(호출부가 INVALID_ARGS로 거부).
  //
  // `spec.id`는 저작자가 `ui.updateStatusItem`에 준 **원래(무접두) id**다 — 등록 쪽
  // (`statusEls`의 키)은 `snapshotToolbarButtons`가 `status:`를 접두해 실었으므로, 여기서도
  // 조회 직전에 같은 접두를 붙여야 같은 id의 버튼과 겹치지 않고 정확히 매칭된다(접두를
  // 빠뜨리면 버튼과 다른 문자열이 되어 항상 null — 갱신이 조용히 거부된다).
  const updateStatusItem = (
    spec: { id: string; text?: string; title?: string },
    owner: string,
  ): string | null => {
    const el = statusEls.get(pluginItemKey(owner, `status:${spec.id}`));
    if (!el) return null;
    if (spec.text !== undefined) el.textContent = spec.text;
    if (spec.title !== undefined) el.title = spec.title;
    return spec.id;
  };

  // 플러그인이 요청하는 토스트를 노트 창 하단 중앙에 띄운다 — 상태(성공·실패·진행)와
  // 갱신/닫기 핸들을 갖는다. 살아 있는 토스트를 (owner, id) 키로 들고 있어야 "진행 중 → 성공"이
  // 가능하다. `spec`을 함께 들고 있는 이유: 갱신은 **부분 갱신**이라 안 준 필드를 채우려면
  // 마지막으로 그린 값이 필요하다(없으면 "진행 중 → 완료"가 글자 없는 빈 알림이 된다).
  const liveToasts = new Map<
    string,
    {
      el: HTMLElement;
      spec: NoteToastSpec;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  let toastSeq = 0;
  const toastWindowTag = `w${++toastWindowSeq}`;

  /**
   * (플러그인, id) → liveToasts 조회 키. owner는 호스트가 검증한 플러그인 id다(코어는 "").
   *
   * 왜: 전 플러그인이 전역 순번 하나를 공유하면 플러그인 B가 순번을 추측해 플러그인 A의
   * 진행·실패 토스트를 조용히 닫거나 문구를 바꿔칠 수 있다 — 조회 키에 owner를 섞으면
   * B가 무슨 문자열을 보내도 B의 네임스페이스 안에서만 해석된다(플러그인 id에는 ":"가
   * 올 수 없어 키가 충돌하지 않는다).
   */
  const toastKey = (owner: string, toastId: string): string =>
    `${owner}:${toastId}`;

  /**
   * 살아 있는 토스트들을 아래에서 위로 다시 쌓는다(전역 시트의 고정 `bottom`을 덮어쓴다).
   *
   * 높이를 **실측해서** 누적한다: 부가 메시지가 붙은 토스트는 두 줄이라, 고정 간격으로
   * 쌓으면 위 토스트가 그 위에 겹쳐 앉는다(실제 렌더에서 확인된 결함). 측정할 수 없는
   * 환경(jsdom — offsetHeight가 0)에서는 한 줄 높이로 가정해 순서만 유지한다.
   */
  const restackToasts = (): void => {
    let offset = TOAST_BOTTOM_PX;
    for (const { el } of liveToasts.values()) {
      el.style.bottom = `${offset}px`;
      offset += (el.offsetHeight || TOAST_ROW_PX) + TOAST_GAP_PX;
    }
  };

  /** 토스트 하나를 사라지게 한다(퇴장 애니메이션 뒤 DOM 제거 + 재배치). key=(owner, id) 조회 키. */
  const closeToast = (key: string): void => {
    const entry = liveToasts.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    liveToasts.delete(key);
    entry.el.classList.remove("note-toast--in");
    window.setTimeout(() => entry.el.remove(), 200);
    restackToasts();
  };

  /** 토스트 본문(제목 + 부가 메시지 + 진행 스피너)을 다시 그린다. */
  const paintToast = (el: HTMLElement, spec: NoteToastSpec): void => {
    const style = spec.style ?? "success";
    el.className = `note-toast note-toast--${style}`;
    if (spec.message) el.classList.add("note-toast--multiline");
    el.replaceChildren();
    if (style === "progress") {
      const spinner = document.createElement("span");
      spinner.className = "note-toast-spinner";
      el.append(spinner);
    }
    const title = document.createElement("span");
    title.className = "note-toast-title";
    title.textContent = spec.title ?? "";
    el.append(title);
    if (spec.message) {
      const msg = document.createElement("span");
      msg.className = "note-toast-message";
      msg.textContent = spec.message;
      el.append(msg);
    }
    // 다시 그린 뒤에도 등장 상태를 유지한다(갱신이 토스트를 사라지게 하면 안 된다).
    el.classList.add("note-toast--in");
  };

  /** 상태에 맞는 자동 소멸 타이머를 다시 건다(progress는 30초 상한만). key=(owner, id) 조회 키. */
  const armToastTimer = (key: string, style: NoteToastStyle): void => {
    const entry = liveToasts.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const ms =
      style === "progress" ? TOAST_PROGRESS_CAP_MS : TOAST_LINGER_MS[style];
    entry.timer = setTimeout(() => closeToast(key), ms);
  };

  const showToast = (spec: NoteToastSpec, owner = ""): string | null => {
    ensureOverlayStyles();
    if (spec.id !== undefined) {
      const key = toastKey(owner, spec.id);
      // 이미 닫힌(또는 없는) id는 무음 무시가 아니라 실패다 — 호출부가 INVALID_ARGS로 바꾼다.
      // 다른 창·다른 플러그인의 id도 여기서 같은 실패로 떨어진다(키가 다르다).
      if (!liveToasts.has(key)) return null;
      if (spec.dismiss === true) {
        closeToast(key);
        return spec.id;
      }
      const entry = liveToasts.get(key);
      if (entry) {
        // 안 준 필드는 유지한다 — `{ id, style: "success" }` 하나로 상태만 바꾸는 것이
        // 정본 사용법이라, 여기서 덮으면 문구가 사라진 빈 알림이 뜬다.
        const merged = mergeToastSpec(entry.spec, spec);
        entry.spec = merged;
        paintToast(entry.el, merged);
        // 갱신으로 줄 수가 바뀌면 위에 쌓인 토스트들이 겹치므로 다시 쌓는다.
        restackToasts();
        // 스타일도 유지 대상이다: 진행 토스트가 부분 갱신 한 번에 success로 접히면
        // 1.2초 뒤 사라져 진행 표시가 중간에 증발한다.
        armToastTimer(key, merged.style ?? "success");
      }
      return spec.id;
    }
    // dismiss는 id가 있어야 의미가 있다(무엇을 닫을지 모르는 요청은 거부).
    if (spec.dismiss === true) return null;
    // 발급 id에 창 순번을 섞어 **창마다 다른 id**를 만든다: 토스트 순번만 쓰면 창 A가 발급한
    // "t1"이 창 B에도 존재해, 폴백 라우팅으로 다른 창에 간 갱신이 그 창의 무관한 토스트에
    // 꽂힌다 — 키가 다르면 그 갱신은 null(INVALID_ARGS)로 정직하게 실패한다. 구분자로 노트
    // id를 쓰지 않는 이유는 [`toastWindowSeq`] 참조(ui 권한만으로 노트 신원이 새면 안 된다).
    const issued = `t${++toastSeq}@${toastWindowTag}`;
    const key = toastKey(owner, issued);
    const el = document.createElement("div");
    el.className = "note-toast";
    host.append(el);
    liveToasts.set(key, { el, spec });
    paintToast(el, spec);
    restackToasts();
    // 등장 전환이 돌게 한 프레임 뒤에 --in을 붙인다(paintToast가 이미 붙였으므로 떼었다 붙인다).
    el.classList.remove("note-toast--in");
    requestAnimationFrame(() => el.classList.add("note-toast--in"));
    armToastTimer(key, spec.style ?? "success");
    return issued;
  };

  // 폰트 플러그인용: 메모 글자 델타(%)를 읽고, 쓰면 실효 크기(전역+델타)를 에디터에 적용·영속화.
  // 델타는 실효 px가 실제로 바뀌는 범위로 클램프해 한계 밖에서 무한히 커지지 않게 하고,
  // 적용된 델타를 돌려줘 플러그인이 진짜 값을 토스트하고 멈추게 한다.
  const getFontDelta = (): number => current.font_delta ?? 0;
  const setFontDelta = (deltaPct: number): number => {
    const applied = clampFontDelta(baseFontPx, deltaPct);
    current.font_delta = applied;
    editor.setFontSize(effectiveFontPx(baseFontPx, applied));
    persist();
    return applied;
  };

  // 옵션 초기화 플러그인용(memo.notes.resetOptions 브리지의 창-스코프 수행부): 이 메모만의
  // 커스터마이즈를 버리는 동작이라 confirm으로 게이트한다. 확인창에는 이 메모에 실제로 설정된
  // 항목만 명시해 "무엇이 사라지는지" 알린다. 확인 시 override를 비워 전역 기본값을 상속하게 하고,
  // 영향 설정을 즉시 재적용 → 툴바 UI 재동기화 → 영속화 → 토스트한다.
  const resetOptions = (): void => {
    const changed = customizedOverrideLabels(current);
    // 되돌릴 사용자 설정이 없으면(모두 전역 기본값 상속) 파괴적 동작 없이 안내만 한다.
    if (changed.length === 0) {
      void confirmDialog(
        host,
        t("note.window.reset-empty"),
        t("note.confirm.ok"),
        {
          alert: true,
        },
      );
      return;
    }
    void confirmDialog(
      host,
      t("note.window.reset-confirm", { changed: changed.join(" · ") }),
      t("note.window.reset-confirm-label"),
    ).then((ok) => {
      if (!ok) return;
      // 모든 override 필드를 비워 전역 기본값을 상속하게 한다(데이터 자체를 지운다).
      for (const key of Object.keys(current) as (keyof NoteOverrides)[])
        delete current[key];
      // 영향받는 설정을 즉시 재적용해 보이는 노트를 바로 갱신한다. 비활성 창 컨트롤도
      // 이미 기본값으로 강제돼 있으니(`syncWindowControlNatives`), 기본값 재적용은 그
      // 컨트롤을 되살리지 않는다(값이 그대로라 무해).
      const reset = resolveOptions(current, baseFontPx);
      deps.applyTransparency(reset.transparency);
      deps.applyPinned(reset.pinned);
      deps.applyAllSpaces(reset.allSpaces);
      deps.applyCollapsed(reset.collapsed);
      applyCollapsedVisibility(reset.collapsed);
      editor.setPreview(reset.preview);
      editor.setFontSize(reset.fontSize);
      // 배경 플러그인이 off면 고정 기본 배경, on이면 스와치 기본으로 되돌린다(override는 비웠다).
      const bg = resolveNoteBg(current.background);
      applyBg(bg);
      // 토글 버튼 내부 상태·투명도 슬라이더·배경 칩을 새 상태로 맞춘다(안 그러면 UI가 어긋난다).
      resyncToolbar?.(reset, bg);
      persist();
      showToast({ title: t("note.window.reset-done") });
    });
  };

  // 창 단위 도구 단축키(키맵): 포커스된 이 노트 창에서 눌린 조합을 대응 툴바 버튼 click으로
  // 디스패치한다 — 확대/축소 포함 모든 동작이 클릭과 동일하게 동작한다(플러그인 토스트 등 재사용).
  //
  // 맵이 아니라 getter를 넘기는 이유: 설정에서 바인딩이 바뀌면(`applyKeybindings`) 이 참조만
  // 갈아 끼우면 되고 리스너는 그대로 산다 — 떼었다 다시 다는 사이에 눌린 키가 유실되지 않는다.
  let liveKeybindings = deps.keybindings ?? {};
  installNoteKeymap(window, () => liveKeybindings, deps.isMac ?? false, host);

  // 커서 위치(또는 문서 끝/전체)에 텍스트를 삽입한다(템플릿 등). CM history가 있어 실수 시
  // ⌘Z로 되돌릴 수 있다. caret이 오면 삽입 후 커서를 삽입 본문 내 그 오프셋에 둔다({cursor} 지원).
  const insertText = (text: string, mode: string, caret?: number): void => {
    const view = editor.view;
    const docLen = view.state.doc.length;
    let from: number;
    let to: number;
    let insert = text;
    if (mode === "replace") {
      from = 0;
      to = docLen;
    } else if (mode === "append") {
      from = docLen;
      to = docLen;
      if (docLen > 0) insert = "\n" + text; // 본문이 있으면 줄바꿈으로 띄운다.
    } else {
      const sel = view.state.selection.main; // cursor(기본): 현재 선택을 대체.
      from = sel.from;
      to = sel.to;
    }
    const lead = insert.length - text.length; // append의 선행 개행 보정(0 또는 1).
    const caretPos = from + lead + (caret ?? text.length);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: caretPos },
    });
    view.focus();
  };

  // 에디터 컨텍스트 메뉴 — 네이티브 메뉴 대신 호스트가 그린다. 네이티브를 막는 이상
  // 기본 편집 동작(잘라내기·복사·붙여넣기·전체 선택)을 **우리가 반드시 제공해야** 하므로,
  // 플러그인 구역은 그 아래 구분선 뒤에 붙인다(기본 항목과 자리 다툼을 하지 않는다).
  // 활성/비활성 판정은 선택 영역 읽기와 **같은 소스**(에디터 state)를 본다.
  // 클립보드 — 부트스트랩이 넘긴 네이티브 우선 구현, 없으면 브라우저 API(테스트·e2e).
  const writeClipboard = (text: string): Promise<void> =>
    deps.writeClipboard
      ? deps.writeClipboard(text)
      : (navigator.clipboard?.writeText(text) ??
        Promise.reject(new Error("no clipboard")));
  const readClipboard = (): Promise<string> =>
    deps.readClipboard
      ? deps.readClipboard()
      : (navigator.clipboard?.readText() ??
        Promise.reject(new Error("no clipboard")));

  /**
   * 우클릭한 이미지의 alt만 새 크기 토큰으로 갈아 끼운다(크기 조정 레이어의 유일한 되쓰기 경로).
   *
   * `span`은 **우클릭 시점**에 syntax tree로 해석한 범위다. 다이얼로그가 떠 있는 동안에도
   * 본문은 바뀔 수 있으므로(플러그인 쓰기·외부 복원) 적용 직전에 그 범위의 원문이 아직
   * 그대로인지 대조하고, 다르면 아무것도 하지 않는다 — 엉뚱한 자리를 덮어쓰느니 조용히
   * 포기하는 쪽이 안전하다(사용자 편집은 한 글자도 잃지 않는다).
   *
   * 선택 영역은 넘기지 않는다: CM이 변경을 통해 자동으로 매핑하므로 커서가 이미지 바깥에
   * 있으면(= 위젯이 렌더된 상태 — 우클릭으로 여기 온 유일한 경로) 제자리에 남고, 라이브
   * 프리뷰가 곧바로 새 크기로 다시 그린다.
   */
  const applyImageSizeEdit = (
    span: ImageSourceSpan,
    width: number | null,
    height: number | null,
  ): void => {
    const view = editor.view;
    if (span.to > view.state.doc.length) return; // 문서가 짧아졌다 — 그 범위는 이제 없다.
    if (view.state.sliceDoc(span.from, span.to) !== span.source) return;
    const nextAlt = serializeImageAltSize(span.alt, width, height);
    if (nextAlt !== span.alt) {
      view.dispatch({
        changes: { from: span.altFrom, to: span.altTo, insert: nextAlt },
      });
    }
    view.focus();
  };

  const runMenuAction = (id: string, image: ImageSourceSpan | null): void => {
    const view = editor.view;
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    // 이미지 그룹 — 우클릭 대상이 렌더된 `<img>`였을 때만 메뉴에 오르므로 span이 반드시 있다
    // (없으면 방어적으로 아무것도 하지 않는다).
    if (id === "image:resize" || id === "image:reset-size") {
      if (!image) return;
      if (id === "image:reset-size") {
        applyImageSizeEdit(image, null, null); // 토큰 제거 = 원본 크기.
        return;
      }
      const { width, height } = parseImageAltSize(image.alt);
      void fieldsDialog(
        host,
        t("note.window.image-size-title"),
        [
          {
            id: "width",
            label: t("note.window.image-size-width"),
            placeholder: t("note.window.image-size-auto"),
            defaultValue: width === null ? "" : String(width),
          },
          {
            id: "height",
            label: t("note.window.image-size-height"),
            placeholder: t("note.window.image-size-auto"),
            defaultValue: height === null ? "" : String(height),
          },
        ],
        {
          hint: t("note.window.image-size-hint"),
          confirmLabel: t("note.window.image-size-confirm-label"),
          // 빈 값은 "그 축은 auto"라는 뜻이라 통과시킨다 — 범위 밖 숫자·비정수만 막는다.
          validate: (values) =>
            isValidImageSizeInput(values.width) &&
            isValidImageSizeInput(values.height),
        },
      ).then((values) => {
        if (!values) return;
        applyImageSizeEdit(
          image,
          parseImageSizeInput(values.width),
          parseImageSizeInput(values.height),
        );
      });
      return;
    }
    if (id === "edit:copy" || id === "edit:cut") {
      void writeClipboard(selected).catch(() => {});
      if (id === "edit:cut" && !sel.empty) {
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
      }
      view.focus();
      return;
    }
    if (id === "edit:paste") {
      void readClipboard()
        .then((text) => {
          if (!text) return;
          const at = view.state.selection.main;
          view.dispatch({
            changes: { from: at.from, to: at.to, insert: text },
            selection: { anchor: at.from + text.length },
          });
          view.focus();
        })
        .catch(() =>
          showToast({ title: t("note.window.paste-failed"), style: "failure" }),
        );
      return;
    }
    if (id === "edit:selectAll") {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
      return;
    }
    // 이미지 추가 — URL 한 칸짜리였던 다이얼로그를 URL·너비·높이 3칸으로 확장한다(크기 조정
    // 레이어와 같은 검증·문법). 너비·높이는 비우면 auto다 — 둘 다 비우면 기존과 똑같은
    // `![](url)`이 나간다(하위호환).
    if (id === "insert:image") {
      void fieldsDialog(
        host,
        t("note.window.insert-image-title"),
        [
          {
            id: "url",
            placeholder: t("note.window.insert-image-placeholder"),
          },
          {
            id: "width",
            label: t("note.window.image-size-width"),
            placeholder: t("note.window.image-size-auto"),
            newRow: true, // URL과 같은 줄이 아니라 너비·높이끼리만 나란히.
          },
          {
            id: "height",
            label: t("note.window.image-size-height"),
            placeholder: t("note.window.image-size-auto"),
          },
        ],
        {
          hint: t("note.window.image-size-hint"),
          confirmLabel: t("note.window.insert-confirm-label"),
          // URL은 기존 규칙, 너비·높이는 크기 조정 레이어와 같은 규칙(빈 값=auto만 통과).
          validate: (values) =>
            isValidHttpUrl(values.url) &&
            isValidImageSizeInput(values.width) &&
            isValidImageSizeInput(values.height),
        },
      ).then((values) => {
        if (!values) return;
        const markdown = imageInsertMarkdown(
          values.url,
          parseImageSizeInput(values.width),
          parseImageSizeInput(values.height),
        );
        insertText(markdown, "cursor");
      });
      return;
    }
    // 유튜브·링크 — URL 한 칸 입력 모달을 띄우고, 확인되면 그 URL을 각 포맷의 마크다운으로
    // 바꿔 커서 위치(또는 선택 영역)에 삽입한다. 링크는 우클릭 시점에 선택된 텍스트가 있으면
    // 그것을 링크 텍스트로 쓴다(위에서 이미 읽어 둔 `selected`).
    if (id === "insert:youtube" || id === "insert:link") {
      const spec =
        id === "insert:youtube"
          ? {
              title: t("note.window.insert-youtube-title"),
              placeholder: t("note.window.insert-youtube-placeholder"),
            }
          : {
              title: t("note.window.insert-link-title"),
              placeholder: t("note.window.insert-link-placeholder"),
            };
      void inputDialog(host, spec.title, {
        placeholder: spec.placeholder,
        confirmLabel: t("note.window.insert-confirm-label"),
        validate: isValidHttpUrl,
      }).then((url) => {
        if (!url) return;
        const markdown =
          id === "insert:youtube"
            ? youtubeInsertMarkdown(url)
            : linkInsertMarkdown(url, selected);
        insertText(markdown, "cursor");
      });
      return;
    }
    if (id === "app:new-note") {
      // 패널의 "+" 버튼과 같은 배선원(`shared/tauri.ts`의 `createAndOpenNote()`)을 deps로
      // 주입받는다. 미제공이거나 거부되면 실패 토스트만 띄우고 창을 깨뜨리지 않는다(app:settings와
      // 같은 관례).
      void deps.createNote?.().catch(() =>
        showToast({
          title: t("note.window.new-note-failed"),
          style: "failure",
        }),
      );
      return;
    }
    if (id === "app:panel") {
      // 패널의 진입점과 같은 배선원(`shared/tauri.ts`의 `openNotePanel()`)을 deps로 주입받는다.
      // 미제공이거나 거부되면 실패 토스트만 띄우고 창을 깨뜨리지 않는다(app:settings와 같은 관례).
      void deps.openPanel?.().catch(() =>
        showToast({
          title: t("note.window.open-panel-failed"),
          style: "failure",
        }),
      );
      return;
    }
    if (id === "app:settings") {
      // 노트 툴바의 "설정 바로가기" 버튼(이슈 #16, note-toolbar.ts)과 같은 배선 —
      // `shared/tauri.ts`의 `openSettings()`(전역 이벤트로 백엔드에 설정 창 열기를 요청)를
      // deps로 주입받는다. 미제공(구버전 deps·테스트)이거나 거부되면 실패 토스트만 띄우고
      // 창을 깨뜨리지 않는다.
      void deps.openSettings?.().catch(() =>
        showToast({
          title: t("note.window.open-settings-failed"),
          style: "failure",
        }),
      );
      return;
    }
    // 메뉴 항목 id가 곧 아이템 키다 — 표시 정보는 메뉴 등록부에서, 실행할 핸들러는 레지스트리
    // 에서 가져온다(핸들러 사본을 두 곳에 두지 않는다 — 재빌드가 클로저를 갈아 끼운다).
    const entry = pluginMenuItems.get(id);
    if (!entry) return;
    // `notes:read`로 굳힌 항목만 선택 텍스트를 받는다 — 우클릭 순간이 아니라 실행 순간의
    // 라이브 선택을 읽지만, 컨텍스트 메뉴가 뜬 동안 에디터 상태는 그대로라 같은 값이다(edit:cut/
    // copy가 여기서 `selected`를 다시 읽는 것과 같은 이유·같은 소스).
    invokeItem(
      id,
      entry.needsSelectedText ? { selectedText: selected } : undefined,
    );
  };

  /**
   * 메뉴 항목의 표시 조건(창 상태 키)을 라이브 에디터 상태로 판정한다 — 조건 없는 항목
   * (버튼·명령)은 항상 보인다. 키는 등록 시점에 [`MENU_WHEN_KEYS`]로 좁혀졌으므로 둘뿐이다.
   */
  const menuItemVisible = (
    when: WhenTerm[] | undefined,
    noteState: { isEmpty: boolean; hasSelection: boolean },
  ): boolean =>
    when === undefined ||
    when.every((term) => {
      const value =
        term.key === "note.isEmpty"
          ? noteState.isEmpty
          : noteState.hasSelection;
      return term.negated ? !value : value;
    });

  // 유튜브 삽입 메뉴 항목의 표시 여부 — 빌트인 youtube-embed 플러그인이 꺼져 있으면 삽입해도
  // 렌더되지 않는 죽은 기능이라 항목 자체를 숨긴다(배경·창 컨트롤과 같은 "끄면 숨김" 규칙).
  //
  // 가변인 이유: 설정 창에서 그 플러그인을 켜고 끄면 호스트 재빌드 완료 방송이 오는데, 그때
  // 창을 리로드하지 않고 이 값만 앞으로 감는다(`applyYoutubeEmbedEnabled`). 메뉴는 우클릭
  // 순간에 조립되므로(`openContextMenu`) 값만 바꿔 두면 다음 우클릭부터 바로 맞는다.
  let youtubeEmbedEnabled = deps.capabilities.youtubeEmbed;

  /**
   * 우클릭 대상이 라이브 프리뷰가 그린 이미지 위젯이면 그 이미지의 소스 범위를 해석한다.
   *
   * 위젯 DOM에는 위치를 박아두지 않는다 — `posAtDOM`으로 지금 이 순간의 문서 위치를 묻고,
   * 그 위치를 `imageSourceAt`(syntax tree)에게 다시 해석시킨다. 편집으로 위치가 밀렸거나
   * 이미지가 사라진 직후라면 여기서 null이 되어 이미지 그룹 자체가 안 뜬다.
   * `posAtDOM`은 뷰 밖 노드에 RangeError를 던지므로 감싼다(우클릭이 창을 깨뜨리지 않게).
   */
  const imageSpanAtEvent = (event: MouseEvent): ImageSourceSpan | null => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    const img = target.closest(".cm-md-image");
    if (!img) return null;
    try {
      return imageSourceAt(editor.view.state, editor.view.posAtDOM(img));
    } catch {
      return null;
    }
  };

  const openContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const docState = editor.view.state;
    const sel = docState.selection.main;
    // 이미지 그룹 — 렌더된 이미지를 직접 우클릭했을 때만 맨 위에 붙는다(일반 텍스트에서는 빈
    // 그룹이라 구분선까지 통째로 생략된다). 크기 토큰이 이미 있을 때만 「원본 크기로」를 함께
    // 보여 준다 — 없는데 눌러도 아무 일이 없는 항목을 띄우지 않기 위함.
    const image = imageSpanAtEvent(event);
    const size = image ? parseImageAltSize(image.alt) : null;
    const sized =
      size !== null && (size.width !== null || size.height !== null);
    const imageGroup: MenuItem[] = image
      ? [
          { id: "image:resize", label: t("note.window.menu-image-resize") },
          ...(sized
            ? [
                {
                  id: "image:reset-size",
                  label: t("note.window.menu-image-reset-size"),
                },
              ]
            : []),
        ]
      : [];
    const editGroup: MenuItem[] = [
      { id: "edit:cut", label: t("note.window.menu-cut"), disabled: sel.empty },
      {
        id: "edit:copy",
        label: t("note.window.menu-copy"),
        disabled: sel.empty,
      },
      { id: "edit:paste", label: t("note.window.menu-paste") },
      {
        id: "edit:selectAll",
        label: t("note.window.menu-select-all"),
        disabled: docState.doc.length === 0,
      },
    ];
    // 삽입 그룹 — 이미지·유튜브·링크를 URL 입력 모달로 커서 위치에 넣는다(runMenuAction).
    // 유튜브는 그 임베드 플러그인이 꺼져 있으면 항목을 아예 숨긴다.
    const insertGroup: MenuItem[] = [
      { id: "insert:image", label: t("note.window.menu-insert-image") },
      ...(youtubeEmbedEnabled
        ? [
            {
              id: "insert:youtube",
              label: t("note.window.menu-insert-youtube"),
            },
          ]
        : []),
      { id: "insert:link", label: t("note.window.menu-insert-link") },
    ];
    // 앱 그룹 — 이 노트를 벗어난 앱 동작(새 메모 → 노트 목록·검색 → 설정, 베타 피드백 2건).
    const appGroup: MenuItem[] = [
      { id: "app:new-note", label: t("note.window.menu-new-note") },
      { id: "app:panel", label: t("note.window.menu-open-panel") },
      { id: "app:settings", label: t("note.window.menu-open-settings") },
    ];
    // 표시 조건 판정의 소스 — edit 항목의 활성/비활성과 **같은 라이브 state**를 본다.
    const noteState = {
      isEmpty: docState.doc.toString().trim() === "",
      hasSelection: !sel.empty,
    };
    // 조건(when)이 거짓인 항목은 메뉴에서 아예 뺀다(회색이 아니라 비표시 — VS Code
    // `editor/context`의 when 절과 같은 결). 버튼·명령은 menuWhen이 없어 항상 보인다. 이
    // 목록은 이미 빌트인 출처 항목이 빠진 채로 모였다(mountItem의 필터 참고) —
    // 여기 남는 것은 커뮤니티/사이드로드 플러그인 항목뿐이다. 우클릭마다 다시 조립하므로
    // 런타임에 지워진 항목(`reconcileToolbarItems`)은 다음 우클릭부터 그대로 사라진다.
    const visiblePluginItems = [...pluginMenuItems.values()].filter((m) =>
      menuItemVisible(m.menuWhen, noteState),
    );
    void contextMenuPopup(host, event.clientX, event.clientY, [
      imageGroup,
      editGroup,
      insertGroup,
      appGroup,
      visiblePluginItems.map((m) => m.item),
    ]).then((id) => {
      if (id) runMenuAction(id, image);
    });
  };
  editorHost.addEventListener("contextmenu", openContextMenu);

  // 활성 플러그인을 로드해 에디터 확장(위키링크 등) 주입 + 툴바 버튼 등록(비동기, 마운트 비차단).
  deps.installPlugins?.({
    setPluginExtensions: (ext, meta) => editor.setPluginExtensions(ext, meta),
    reconcileToolbarItems,
    updateStatusItem,
    showToast,
    getFontDelta,
    setFontDelta,
    resetOptions,
    getContent: () => editor.view.state.doc.toString(),
    insertText,
    pickList: (spec) => pickListPopup(host, spec),
    prompt: (spec) => promptPopup(host, spec),
  });

  return {
    flushSave: () => save.flush(),
    cancelSave: () => save.cancel(),
    applyThemeOverrides: (themeOverrides) =>
      applyThemeWithOverrides(themeOverrides),
    applyTheme: (theme, themeOverrides) => {
      activeTheme = theme;
      applyThemeWithOverrides(themeOverrides);
    },
    applyBaseFontPx: (px) => {
      baseFontPx = px;
      // 이 메모의 델타를 유지한 채 실효 크기만 다시 낸다(해석 규칙은 resolveOptions가 정본).
      editor.setFontSize(resolveOptions(current, baseFontPx).fontSize);
    },
    applyFontFamily: (saved) => applyFontFamily(saved),
    applyFontCapability: (font, saved) => {
      activeFont = font;
      applyFontFamily(saved);
    },
    applyKeybindings: (bindings) => {
      liveKeybindings = bindings;
    },
    applyYoutubeEmbedEnabled: (enabled) => {
      youtubeEmbedEnabled = enabled;
    },
    applyBackgroundCapability: (background) => {
      activeBackground = background;
      // 파생값을 능력에서 한 번에 다시 낸다 — 하나라도 옛 값으로 남으면 색과 대비가 갈린다.
      swatches = activeBackground?.swatches ?? [];
      autoTextContrast = activeBackground?.autoTextContrast ?? false;
      fallbackBg = swatches[0] ?? DEFAULT_BACKGROUND_COLOR;
      // 새 색을 먼저 화면에 얹고(대비 변수까지) 그 값을 툴바에 넘긴다(순서 — 인터페이스 참고).
      const bg = resolveNoteBg(current.background);
      applyBg(bg);
      setBackgroundCapability(swatches, bg);
    },
    reconcileToolbarItems: (items) => reconcileToolbarItems(items),
    applyWindowControls: (controls) => {
      activeWindowControls = controls;
      // 저장값(override)의 실효값 — 켜진 컨트롤은 이 값으로 네이티브·툴바가 함께 복원된다.
      const resolved = resolveOptions(current, baseFontPx);
      syncWindowControlNatives(resolved, true);
      setWindowControls(controls, resolved);
    },
    syncCollapsed: (collapsed) => {
      if ((current.collapsed ?? false) === collapsed) return;
      applyCollapsedVisibility(collapsed);
      current.collapsed = collapsed; // 다른 override 저장이 이 값을 되돌리지 않도록.
      // 접기 토글 버튼의 내부 상태(글리프·aria)를 새 상태로 맞춘다 — 안 그러면 버튼만
      // 반대로 남아, 한 번 더 눌러야 원하는 방향으로 움직이는 것처럼 보인다. 나머지 컨트롤은
      // 값이 그대로라 같은 값으로 되맞춰질 뿐이다(무해).
      resyncToolbar?.(
        resolveOptions(current, baseFontPx),
        resolveNoteBg(current.background),
      );
    },
    reloadContent: async () => {
      const { content: fresh } = await deps.loadNote(id);
      // 버퍼가 이미 디스크와 같으면 할 일이 없다(불필요한 재배치·플리커 방지).
      if (editor.view.state.doc.toString() === fresh) return;
      // 저장 대기 중인 사용자 타이핑이 있으면, 프로그램적 쓰기로 그 위를 덮지 않는다 —
      // 대기 중인 자동저장을 즉시 flush해 사용자 본문을 디스크에 확정하고 버퍼는 그대로 둔다
      // (사용자가 직접 친 텍스트를 플러그인·복원의 프로그램적 쓰기보다 우선 보존한다 — finding 2·3).
      if (unsaved) {
        save.flush();
        return;
      }
      // 미저장 편집이 없으면 디스크(바깥에서 바뀐 복원·플러그인 쓰기)를 버퍼에 반영한다.
      // setContent가 onChange를 불러 unsaved를 세우고 저장을 예약하지만(디스크와 동일 내용),
      // 방금 디스크와 일치시켰으므로 그 예약을 취소하고 플래그를 되돌린다.
      editor.setContent(fresh);
      save.cancel();
      unsaved = false;
    },
  };
}
