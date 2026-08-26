/**
 * 최초 실행 저장 폴더 안내 — 이슈 #21 §4.
 *
 * 역할: 새로 설치한 사용자에게 "메모가 어느 폴더에 저장되는지"를 한 번 알려 주고, 그대로
 * 쓸지(기본값 = 지금 경로) 설정에서 바꿀지 고르게 한다. 판정 근거는 백엔드의
 * `LocalConfig.vault_prompted`이며([`getVaultInfo`]의 `prompted`), **띄우는 즉시**
 * [`markVaultPrompted`]로 표시한다 — 답하지 않고 앱을 끈 사용자에게 매번 다시 묻는 것보다
 * 한 번 보여 준 것으로 끝내는 편이 낫다.
 *
 * 이 안내는 폴더를 **바꾸지 않는다**. "이 폴더 사용"은 그저 닫기고(기본값이 이미 적용돼 있다),
 * "설정에서 변경"은 설정 창을 열어 「관리 › 저장 폴더」로 안내한다 — 폴더 선택·권한 확인·파일
 * 이동은 전부 그 페이지의 몫이다. 안내가 폴더 이전까지 떠안으면, 앱을 처음 켠 사람이 가장
 * 모르는 순간에 되돌리기 어려운 결정을 강요하게 된다.
 *
 * ## 왜 툴바 스타일 프롬프트를 기다리나
 *
 * 최초 실행에는 [`maybeShowToolbarStylePrompt`]와 이 안내가 **같은 순간에** 뜰 조건이 된다.
 * 둘 다 전체 화면 오버레이라 겹치면 하나가 다른 하나를 덮어, 사용자는 있는 줄도 몰랐던 질문에
 * 답하게 된다. 그래서 [`whenToolbarStylePromptSettled`]를 기다리고, 그쪽이 **실제로 떠서
 * 답을 받았으면 이번 페이지에서는 뜨지 않는다** — 그 선택은 곧 이 창의 리로드로 이어지므로
 * (설정 저장 → 호스트 재빌드 방송), 여기서 띄워 봐야 지워질 뿐이다. 리로드된 새 페이지에서는
 * 스타일 프롬프트가 즉시 지나가고 이 안내가 온전한 화면에서 뜬다.
 *
 * 조회·저장 실패는 조용히 넘어간다(스타일 프롬프트와 같은 원칙 — 안내 하나 때문에 노트 창
 * 부팅을 막을 이유가 없다).
 */
import { t } from "../i18n/t";
import { getVaultInfo, markVaultPrompted, openSettings } from "../shared/tauri";
import { whenToolbarStylePromptSettled } from "./toolbar-style-prompt";

/** 이 모듈(=이 창) 안에서 한 번만 시도한다 — 창마다 별도 페이지 로드라 자연히 창 단위가 된다. */
let attempted = false;

/**
 * 필요하면(아직 안내한 적 없음) 저장 폴더 안내를 띄운다. 동기 함수다 — 내부에서 비동기로
 * 조회하고, 실패·불필요 판정은 조용히 종료한다(호출부가 기다릴 것이 없다).
 */
export function maybeShowVaultFolderPrompt(): void {
  if (attempted) return;
  attempted = true;
  void run().catch(() => {});
}

async function run(): Promise<void> {
  const info = await getVaultInfo();
  if (info.prompted) return; // 이미 안내했거나, 이 기능 이전부터 쓰던 설치다.
  // 스타일 프롬프트가 떠 있었다면 그 선택 뒤 이 창이 리로드된다 — 이번엔 양보한다(모듈 문서).
  if (await whenToolbarStylePromptSettled()) return;
  // 띄우기 **직전**에 표시한다(닫을 때가 아니라 — 모듈 문서 참고).
  void markVaultPrompted().catch(() => {});
  showOverlay(info.path);
}

/** 오버레이를 만들어 `document.body`에 붙인다(확인 다이얼로그의 `.confirm-*` 룩을 재사용). */
function showOverlay(path: string): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay vault-folder-prompt";

  const box = document.createElement("div");
  box.className = "confirm-box vault-folder-prompt-box";

  const title = document.createElement("h2");
  title.className = "vault-folder-prompt-title";
  title.textContent = t("note.vault-prompt.title");

  const desc = document.createElement("p");
  desc.className = "vault-folder-prompt-desc";
  desc.textContent = t("note.vault-prompt.description");

  const pathEl = document.createElement("p");
  pathEl.className = "vault-folder-prompt-path";
  // 경로는 사용자가 복사해 파일 탐색기에 붙여넣을 수 있어야 한다.
  pathEl.style.userSelect = "text";
  pathEl.textContent = path;

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const close = (): void => overlay.remove();

  const change = document.createElement("button");
  change.type = "button";
  change.className = "confirm-cancel vault-folder-prompt-change";
  change.textContent = t("note.vault-prompt.change");
  change.addEventListener("click", () => {
    close();
    // 설정 창 열기 실패는 조용히 무시한다(노트 창의 다른 openSettings 호출부와 같은 관례).
    void openSettings().catch(() => {});
  });

  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "confirm-choice vault-folder-prompt-keep";
  keep.textContent = t("note.vault-prompt.keep");
  keep.addEventListener("click", close);

  actions.append(change, keep);
  box.append(title, desc, pathEl, actions);
  overlay.append(box);
  document.body.append(overlay);
  // 기본 선택은 "이 폴더 사용"이다 — 이 안내의 기본값은 **지금 적용된 폴더**이고(이슈 #21 §4),
  // 그 쪽은 아무것도 바꾸지 않는 안전한 선택이다.
  keep.focus();
}
