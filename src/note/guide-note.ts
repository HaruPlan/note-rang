/**
 * 「시작 가이드」 메모 본문 조립 — 첫 실행에 한 장 만들어지는 짧은 체험형 체크리스트.
 *
 * 역할: 활성 로케일의 문장(`note.guide.*`)과 **실제 버튼 이름**(그 버튼이 쓰는 i18n 키)을
 * 모아 마크다운 한 벌을 만든다. 순수 함수라 IO 없이 가드 테스트가 가능하다 — 만들기·소환
 * 배선은 `bootstrap/guide-note.ts`가 맡는다.
 *
 * **마크다운 구조는 코드에, 문장은 사전에** 둔다: 사전 값에 `- [ ]`·`#`를 넣으면 번역자가
 * 그 기호를 옮기다 깨뜨릴 수 있고(체크박스가 평범한 목록이 되어 "눌러 보세요"가 거짓말이
 * 된다), 문장만 담기면 번역이 안전하다. 반대로 버튼 이름은 사전에서 **끌어온다** — 문장
 * 안에 "접기"라고 적어 두면 그 버튼의 라벨이 바뀌는 날 가이드만 옛 이름으로 남는다.
 *
 * 왜 Rust 내장 테이블이 아닌가(첫 실행 환영 노트 `src-tauri/src/state.rs`와 다른 선택):
 * 그 노트는 창이 하나도 없는 부팅 시점에 만들어야 해서 Rust가 만들 수밖에 없고, 그래서
 * ko·en 둘로 굳어 있다(언어팩이 닿지 못한다). 가이드는 창이 뜬 뒤에 만들므로 프론트에서
 * 본문을 조립해 넘길 수 있고, 그러면 서드파티 언어팩이 다른 UI 문자열과 똑같이 번역한다.
 */
import { t } from "../i18n/t";
import { formatAccelLabel } from "../shortcuts/accel";

/**
 * [`buildGuideNoteBody`]의 입력 — 사전에서 못 얻는 값(이 기기의 단축키)만 받는다.
 *
 * export하지 않는 이유: 호출부는 객체 리터럴을 그대로 넘겨 구조적으로 검사받으므로 이름이
 * 필요 없다(미사용 export를 남기지 않는다 — knip).
 */
interface GuideNoteInput {
  /**
   * 전역 「새 메모」 단축키(Tauri 가속기 문자열, 예 `"CmdOrCtrl+Shift+N"`). **빈 문자열이면
   * "모른다"**이고, 그때는 조합 대신 "설정 › 단축키에서 확인" 문장으로 갈아 끼운다 — 지어낸
   * 기본값을 적으면 사용자가 바꿔 둔 조합과 어긋난 안내가 된다.
   */
  newNoteAccel: string;
  /** 이 OS가 macOS인지 — 가속기 표기를 가른다(`⌘⇧N` vs `Ctrl+Shift+N`). */
  isMac: boolean;
}

/** 체크리스트 한 줄(마크다운 작업목록 — 에디터에서 눌러 토글된다). */
function task(sentence: string): string {
  return `- [ ] ${sentence}`;
}

/**
 * 체크박스 없는 한 줄 — **해 보는 것이 아니라 알아 두는 것**에 쓴다.
 *
 * 왜 나누나: 첫 문단이 "해 본 항목은 체크박스를 눌러 표시해 보세요"라고 약속하므로, 눌러서
 * 할 수 있는 일이 아닌 항목까지 체크박스로 만들면 그 약속이 흐려진다.
 */
function fact(sentence: string): string {
  return `- ${sentence}`;
}

/**
 * 가이드 본문(마크다운)을 만든다.
 *
 * 첫 줄이 `# <제목>`인 이유: 백엔드가 본문 첫 줄에서 목록 제목을 뽑는다
 * (`notes::derive_title`) — 제목 줄이 없으면 목록에 첫 문장이 통째로 실린다.
 *
 * 쓰는 문법은 에디터가 실제로 렌더하는 것만이다(`note/live-preview.ts`): 헤딩·굵게·
 * 인라인 코드·작업목록. 링크·이미지·표도 되지만 가이드에는 쓰지 않는다 — 가이드가
 * "이렇게 쓰면 이렇게 보인다"의 예시이기도 하므로 첫 화면이 복잡하지 않아야 한다.
 */
export function buildGuideNoteBody(input: GuideNoteInput): string {
  const accel = formatAccelLabel(input.newNoteAccel, input.isMac);
  const lines = [
    `# ${t("note.guide.title")}`,
    "",
    t("note.guide.intro"),
    "",
    `## ${t("note.guide.section-window")}`,
    "",
    task(t("note.guide.window-drag")),
    task(
      t("note.guide.window-toolbar", {
        fold: t("note.layout.item-collapse"),
        transparency: t("note.layout.item-transparency"),
        pin: t("note.layout.item-pin"),
        allDesktops: t("note.layout.item-all-desktops"),
      }),
    ),
    task(
      t("note.guide.window-archive", {
        archive: t("note.layout.item-archive"),
      }),
    ),
    "",
    `## ${t("note.guide.section-write")}`,
    "",
    task(
      t("note.guide.write-format", {
        bold: t("note.selection-toolbar.bold"),
        color: t("note.selection-toolbar.color"),
      }),
    ),
    task(t("note.guide.write-markdown")),
    task(t("note.guide.write-wikilink")),
    task(
      t("note.guide.write-insert", {
        insertImage: t("note.window.menu-insert-image"),
        insertYoutube: t("note.window.menu-insert-youtube"),
      }),
    ),
    "",
    `## ${t("note.guide.section-find")}`,
    "",
    task(t("note.guide.find-tray")),
    task(
      accel
        ? t("note.guide.find-shortcut", { accel })
        : t("note.guide.find-shortcut-unknown"),
    ),
    task(t("note.guide.find-favorite")),
    task(t("note.guide.find-sort", { sort: t("panel.sort.label") })),
    "",
    `## ${t("note.guide.section-tune")}`,
    "",
    task(t("note.guide.tune-settings")),
    fact(t("note.guide.tune-data")),
    "",
    t("note.guide.outro"),
    "",
  ];
  return lines.join("\n");
}
