/**
 * 최초 실행 툴바 스타일(Mac/Windows) 선택 프롬프트 — 이슈 #16 §4.
 *
 * 역할: 사용자가 아직 "닫기 버튼을 어느 쪽에 둘지"(맥 스타일=좌측, 윈도우 스타일=우측)를 고른
 * 적 없으면, 노트 창에 작은 선택 오버레이를 한 번 띄운다. 고르면 그 스타일의 기본 배치
 * ([`DEFAULT_LAYOUT_MAC`]/[`DEFAULT_LAYOUT_WINDOWS`])를 공유 설정의 `toolbar_layout`에 저장하고
 * `toolbar_style` 플래그를 남겨 다시 묻지 않는다. 이미 배치를 커스터마이즈해 둔 사용자(구버전부터
 * 쓰던 사용자 등, `toolbar_layout`이 이미 있음)는 존중하고 묻지 않는다.
 *
 * 왜 note-window.ts가 아니라 여기서, 그리고 `createNoteToolbar`가 자동으로 부르나: 이 기능을
 * 만들 당시 note-window.ts는 다른 작업으로 잠겨 있어 그 파일에 새 배선을 더할 수 없었다.
 * `note-toolbar.ts`의 `createNoteToolbar`가 이 모듈의 [`maybeShowToolbarStylePrompt`]를
 * **기본 인자**로 받으므로(생략하면 자동 적용), note-window.ts를 한 글자도 고치지 않고도
 * 실제 앱 배선이 끝난다 — 함수 기본 인자는 호출부가 그 인자를 몰라도(넘기지 않아도) 적용된다.
 *
 * 조회·저장 실패는 조용히 넘어간다(이 프롬프트는 있으면 좋은 편의 기능이지, 실패했다고 노트
 * 창 부팅을 막을 이유가 없다).
 */
import { t } from "../i18n/t";
import {
  emitNotesReload,
  getPlatform,
  getSharedSettings,
  saveSharedSettings,
} from "../shared/tauri";
import { DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS } from "./toolbar-layout";

export type ToolbarStyle = "mac" | "windows";

/** 이 모듈(=이 창) 안에서 한 번만 시도한다 — 창마다 별도 페이지 로드라 자연히 창 단위가 된다. */
let attempted = false;

/**
 * 이 프롬프트가 **끝났음**(안 띄우기로 판정했거나, 띄웠다가 사용자가 골랐거나, 조회가 실패했거나)을
 * 알리는 신호. 뒤이어 뜰 다른 1회성 안내가 이 창을 가로채지 않도록 순서를 잡는 데 쓴다.
 *
 * 왜 필요한가(이슈 #21): 최초 실행에는 이 프롬프트와 저장 폴더 안내가 **같은 순간에** 뜰 조건이
 * 된다. 둘 다 전체 화면 오버레이라 겹치면 하나가 다른 하나를 덮어, 사용자는 있는 줄도 몰랐던
 * 질문에 답하게 된다. 그래서 저장 폴더 안내는 이 신호를 기다렸다가 뜬다
 * ([`../note/vault-folder-prompt`]).
 */
let settle: (shown: boolean) => void = () => {};
const settled = new Promise<boolean>((resolve) => {
  settle = resolve;
});

/**
 * 툴바 스타일 프롬프트가 끝날 때까지 기다린다(위 [`settled`] 참고).
 *
 * resolve 값은 "이 창에서 실제로 프롬프트를 띄웠고 사용자가 골랐는가"다. **true면 이 창은 곧
 * 리로드된다** — 스타일 선택은 공유 설정을 저장하고 `emitNotesReload`로 호스트 재빌드를
 * 부르며, 노트 창은 그 방송을 받고 스스로 리로드한다(`bootstrap/note.ts`). 그래서 뒤이을
 * 안내는 이번 페이지에서 뜨면 안 된다(뜨자마자 리로드에 지워져, 본 적도 없는 안내가 "이미
 * 봤음"으로 기록된다). 리로드 뒤 새 페이지에서는 스타일이 이미 정해져 있어 false로 즉시
 * 끝나고, 그때 온전한 화면에서 뜬다.
 *
 * [`maybeShowToolbarStylePrompt`]가 **아직 한 번도 불리지 않았으면 즉시** false로 끝난 것으로
 * 본다 — 툴바가 없는 창이나 마운트 실패에서, 오지 않을 신호를 영원히 기다리며 뒤 안내를
 * 통째로 잃는 것보다 낫다. 실제 노트 창에서는 `createNoteToolbar`(마운트 중)가 이미 불러 둔
 * 뒤에야 이 함수가 호출되므로 그 폴백이 정상 경로를 앞지르지 않는다.
 *
 * 프롬프트가 떠 있는데 사용자가 아직 고르지 않았다면 이 약속은 **의도적으로 계속 대기**한다 —
 * 오버레이 두 개가 겹치는 것이 이 신호가 막으려는 바로 그 상황이다.
 */
export function whenToolbarStylePromptSettled(): Promise<boolean> {
  return attempted ? settled : Promise.resolve(false);
}

/**
 * 필요하면(스타일 미선택 + 미커스터마이즈) 프롬프트를 띄운다. 동기 함수다 — 내부에서 비동기로
 * 조회하고, 실패·불필요 판정은 조용히 종료한다(호출부가 기다릴 것이 없다).
 */
export function maybeShowToolbarStylePrompt(): void {
  if (attempted) return;
  attempted = true;
  // 조회 실패(설정을 못 읽음)도 "안 띄웠다"로 매듭짓는다 — 실패했다고 뒤 순서를 영영 막지 않는다.
  void run().catch(() => settle(false));
}

async function run(): Promise<void> {
  const settings = await getSharedSettings();
  // 이미 스타일을 고른 적 있거나(재질문 방지), 이미 배치를 커스터마이즈해 둔 사용자라면
  // (구버전부터 쓰던 사용자 등) 묻지 않고 기존 배치를 존중한다.
  if (settings.toolbar_style != null || settings.toolbar_layout != null) {
    settle(false);
    return;
  }
  const platform = await getPlatform().catch(() => "");
  const recommended: ToolbarStyle = platform === "macos" ? "mac" : "windows";

  showOverlay(recommended, (style) => {
    // 골랐다 = 저장 → 호스트 재빌드 → 이 창 리로드가 이어진다
    // ([`whenToolbarStylePromptSettled`] 문서 참고).
    settle(true);
    const layout =
      style === "mac" ? DEFAULT_LAYOUT_MAC : DEFAULT_LAYOUT_WINDOWS;
    void saveSharedSettings({
      ...settings,
      toolbar_style: style,
      toolbar_layout: layout,
    })
      // 사유 `settings` — 공유 설정 저장이다(툴바 배치가 함께 바뀌므로 받는 창의 판정은
      // 결국 리로드로 떨어진다: `toolbar_layout`은 제자리 조정 대상이 아니다).
      .then(() => emitNotesReload(["settings"]))
      .catch(() => {});
  });
}

/** 오버레이를 만들어 `document.body`에 붙인다(전용 CSS는 styles.css의 `.confirm-*` 재사용). */
function showOverlay(
  recommended: ToolbarStyle,
  onChoose: (style: ToolbarStyle) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay toolbar-style-prompt";

  const box = document.createElement("div");
  box.className = "confirm-box toolbar-style-prompt-box";

  const title = document.createElement("h2");
  title.className = "toolbar-style-prompt-title";
  title.textContent = t("note.style-prompt.title");

  const desc = document.createElement("p");
  desc.className = "toolbar-style-prompt-desc";
  desc.textContent = t("note.style-prompt.description");

  const choices = document.createElement("div");
  choices.className = "toolbar-style-prompt-choices";

  const close = (style: ToolbarStyle) => {
    overlay.remove();
    onChoose(style);
  };

  const makeChoice = (style: ToolbarStyle): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-style-prompt-choice";
    btn.dataset.style = style;
    const label = document.createElement("span");
    label.textContent =
      style === "mac"
        ? t("note.style-prompt.mac")
        : t("note.style-prompt.windows");
    btn.append(label);
    if (style === recommended) {
      btn.classList.add("toolbar-style-prompt-choice--recommended");
      const badge = document.createElement("span");
      badge.className = "toolbar-style-prompt-badge";
      badge.textContent = t("note.style-prompt.recommended");
      btn.append(badge);
    }
    btn.addEventListener("click", () => close(style));
    return btn;
  };

  // 추천이 먼저 오게(윈도우 우선 나열 관례) 하지 않고, 현재 OS 추천 쪽을 항상 왼쪽에 둔다 —
  // 사용자가 스캔하기 가장 쉬운 자리에 기본 선택지를 배치한다.
  const ordered: ToolbarStyle[] =
    recommended === "windows" ? ["windows", "mac"] : ["mac", "windows"];
  choices.append(...ordered.map(makeChoice));

  box.append(title, desc, choices);
  overlay.append(box);
  document.body.append(overlay);
}
