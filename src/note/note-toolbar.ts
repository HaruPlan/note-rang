/**
 * 노트별 옵션 미니 툴바 (평소 숨김, 호버 시 표시) — 전역 배치(layout)대로 상/하 바를 존(단)으로
 * 나눠 그리고, 존마다 너비 반응형 `⋯` 오버플로 메뉴를 붙인다.
 *
 * 역할: 내장 컨트롤(투명도·프리뷰·핀·모든 데스크탑·배경색·접기·보관·삭제)을 키로 생성하고,
 * 배치가 지정한 바·존·순서에 놓는다. 플러그인이 등록하는 버튼은 note-window가 `placeItem`으로
 * 같은 존 규칙에 따라 채운다 — 배치에 없어도 이 배치가 **한 번도 알지 못한**(seen에 없는) 키면
 * 등록 시 넘어온 position으로 자동 배치하고, 사용자가 **명시적으로 뺀**(seen엔 있지만 어느 존에도
 * 없는) 키는 계속 숨긴다. 좁아지면 각 존이 독립으로 `⋯`로 접힌다.
 * 동작은 핸들러로 주입받아 Tauri 의존 없이 테스트한다.
 * 왜: 버튼 위치를 플러그인별 설정에서 전역 배치로 옮겨(설정 창 드래그&드롭) 한 곳에서 정한다.
 *
 * 내장 컨트롤의 **가용 판정은 마운트 때 배치에 한 번 반영한다**(`availableBuiltinItems` +
 * `pruneLayout` + `materializeFallbacks`): 대응 플러그인이 꺼졌거나(투명도·항상 위·모든 데스크탑)
 * 배경 스와치가 없으면 그 키를 배치에서 지우고, 반대로 가용한데 배치가 모르는 키는 선언된 기본
 * 자리에 놓는다. 케이스마다 `if (controls.includes(...))`로 걸러 내지 않는 이유: 설정 창 팔레트와
 * **같은 순수 함수**를 공유해야 "팔레트엔 있는데 노트엔 안 나오는" 유령 아이템이 안 생긴다.
 *
 * 그 판정은 **마운트 뒤에도 갱신된다**: 배경·창 컨트롤 플러그인을 켜고 끄면 호스트 재빌드가
 * 창을 리로드하는 대신 `setBackgroundCapability`·`setWindowControls`로 해당 항목만 DOM에서
 * 빼고 넣는다(`bootstrap/host-update-plan.ts`). 같은 `availableBuiltinItems`를 다시 돌리는
 * 것이 전부라 마운트와 런타임이 언제나 같은 답을 낸다.
 */
import { hasBackgroundPicker } from "../theme/background";
import type { PluginCapabilities } from "../plugin/capabilities";
import { t } from "../i18n/t";
import { createAndOpenNote, openSettings } from "../shared/tauri";
import { maybeShowToolbarStylePrompt } from "./toolbar-style-prompt";
import {
  availableBuiltinItems,
  compareZoneItemRank,
  fallbackZoneFor,
  foldRankOf,
  isBuiltinItemKey,
  materializeFallbacks,
  pruneLayout,
  zoneAlignOf,
  zoneItemRank,
  type BarId,
  type BarLayout,
  type FallbackPosition,
  type ToolbarLayout,
} from "./toolbar-layout";

/** 툴바가 표시·조절하는 노트별 옵션 상태. */
export interface NoteOptionState {
  preview: boolean;
  pinned: boolean;
  transparency: number;
  allSpaces: boolean;
  fontSize: number;
  collapsed: boolean;
}

/** 툴바 동작 핸들러(각 변경을 적용·영속화하는 쪽에서 구현). */
interface NoteToolbarHandlers {
  togglePreview(on: boolean): void;
  setPinned(on: boolean): void;
  setTransparency(percent: number): void;
  setAllSpaces(on: boolean): void;
  /** 헤더만 남기고 접기(숨김이 아니라 창 높이 조절) 토글. */
  setCollapsed(on: boolean): void;
  setBackground(color: string): void;
  /** 연속 입력(투명도·색 드래그)을 놓을 때 1회 영속화한다(매-틱 저장 방지). */
  commit(): void;
  archiveNote(): void;
  deleteNote(): void;
}

/**
 * 옵션 초기화 후 툴바 컨트롤 UI를 새 상태로 되맞추는 함수. 토글 버튼의 내부 on 상태·슬라이더
 * 값·배경 칩 색을 함께 동기화해, `current`만 비웠을 때 남는 UI 불일치(aria-pressed·아이콘 어긋남)를 막는다.
 */
export type NoteToolbarResync = (
  state: NoteOptionState,
  background: string,
) => void;

/** 투명도 하한(%) — 백엔드 클램프와 일치. */
const TRANSPARENCY_MIN = 30;

/** 내부 전용 아이콘 SVG 빌더(currentColor 라인 아이콘 — 노트 글자색을 따라 대비). */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/**
 * 내장 버튼 아이콘(모듈 내부 전용 신뢰 마크업 — Lucide 계열 라인 아이콘).
 * 제각각인 컬러 이모지 대신 통일된 단색 라인 아이콘으로 가시성/일관성을 높인다.
 */
const ICON = {
  preview: svg(
    '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  ),
  pin: svg(
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/>',
  ),
  collapse: svg('<path d="m18 15-6-6-6 6"/>'),
  expand: svg('<path d="m6 9 6 6 6-6"/>'),
  // 모든 데스크탑(여러 Space) — Mission Control처럼 화면 여러 개를 격자로 표현.
  allDesktops: svg(
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  ),
  options: svg(
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  ),
  // "닫기"(이슈 #16 — 구 "보관", 키·동작은 core:archive/archiveNote 그대로: 창을 숨길 뿐 데이터는
  // 보존한다). 예전엔 상자 아이콘(보관함)을 썼지만, 라벨이 "닫기" 개념으로 바뀌면서 사용자가
  // 곧바로 읽을 수 있는 X(닫기) 글리프로 바꾼다 — 옆의 삭제(trash)와도 뚜렷이 구분된다.
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  trash: svg(
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  ),
  // 설정 바로가기(이슈 #16) — 표준 톱니바퀴 글리프.
  settings: svg(
    '<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  // 새 메모(베타 피드백 1건) — 문서 윤곽(모서리 접힘) + 안쪽 "+"로 "새 문서 만들기"를 한눈에
  // 드러낸다. "+" 강조가 핵심이라, 점선·스탬프 느낌으로 바꾼 템플릿 아이콘(template 플러그인
  // main.js)과 나란히 놓아도 헷갈리지 않는다(베타 피드백 2건과 짝).
  newNote: svg(
    '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>',
  ),
  // 접힘 제목(사용자 요구 1건) — 설정 창 배치 편집기 팔레트에서 이 항목을 대표하는 글리프.
  // 실제 노트 헤더에선 아이콘이 아니라 텍스트 라벨 자체가 보이므로(buildBuiltin 참고), 이건
  // 팔레트 전용 근사치다: 텍스트 줄이 든 태그 모양으로 "제목 표시"를 직관화한다.
  collapsedTitle: svg(
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 8h10"/><path d="M7 12.5h6"/>',
  ),
} as const;

/**
 * 배경색 트리거·팔레트 글리프 — 물방울 **윤곽선**(다른 아이콘과 같은 `currentColor` 라인)에
 * 현재 배경색을 채워 넣는다. 채움은 CSS 변수 `--note-chip`으로 들어온다(`styles.css`의
 * `.note-bg-fill`).
 *
 * 왜 윤곽선이 필요한가: 예전엔 트리거가 "현재 배경색으로 칠한 사각 칩" 하나뿐이었는데, 그 칩은
 * **정의상 언제나 노트 배경과 같은 색**이라(자기가 놓인 면과 같은 색) 사실상 안 보였다 — 툴바에
 * 빈 사각형이 하나 있는 것처럼 보여 "배경색 버튼이 없다"고 읽혔다. 윤곽선을 `--tb-on`(배경 밝기의
 * 반대 톤)으로 그리면 어떤 배경에서도 버튼이 보이고, 안쪽 채움은 현재 색 정보를 그대로 남긴다.
 */
const BG_GLYPH_BODY =
  '<path class="note-bg-fill" d="M12 3.2 7.4 8.4a6.6 6.6 0 1 0 9.2 0Z"/>';

/** 설정 창 배치 편집기 팔레트가 쓰는 정적 버전(채움 없이 윤곽선만 — 거기엔 현재 색이 없다). */
const BG_GLYPH_BODY_SVG = svg(BG_GLYPH_BODY);

/**
 * 내장 아이템 키(core:*)의 대표 아이콘 SVG를 돌려준다(설정 창 배치 편집기 팔레트용 — 노트 툴바와
 * 아이콘을 한 소스에서 공유). 투명도·배경색은 슬라이더·칩이라 대표 글리프로 근사한다. 모르면 빈 문자열.
 */
export function builtinItemIconSvg(key: string): string {
  switch (key) {
    case "core:transparency":
      // 반쯤 채운 원 — 불투명↔투명.
      return svg(
        '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
      );
    case "core:preview":
      return ICON.preview;
    case "core:pin":
      return ICON.pin;
    case "core:all-desktops":
      return ICON.allDesktops;
    case "core:background":
      return BG_GLYPH_BODY_SVG;
    case "core:collapse":
      return ICON.collapse;
    case "core:collapsed-title":
      return ICON.collapsedTitle;
    case "core:archive":
      return ICON.close;
    case "core:delete":
      return ICON.trash;
    case "core:settings":
      return ICON.settings;
    case "core:new-note":
      return ICON.newNote;
    default:
      return "";
  }
}

/** 토글 버튼 핸들 — 요소 + 외부에서 on 상태를 강제 동기화하는 setter(옵션 초기화용). */
interface ToggleButton {
  el: HTMLButtonElement;
  /** 내부 on·aria-pressed·아이콘을 함께 맞춘다(onToggle은 호출하지 않는다 — UI만 재동기화). */
  set(on: boolean): void;
}

/**
 * 토글 상태를 aria-pressed로 반영하는 버튼을 만든다. `icon`은 모듈 내부 전용 신뢰 마크업
 * (SVG/텍스트)이라 innerHTML로 설정한다(플러그인 버튼은 이 헬퍼를 쓰지 않는다 — note-window에서
 * textContent로 렌더). `set`으로 외부(옵션 초기화)에서 내부 상태를 되돌릴 수 있다.
 */
function toggleButton(
  iconOff: string,
  initial: boolean,
  onToggle: (on: boolean) => void,
  iconOn: string = iconOff,
  /** 단축키 디스패치용 안정 식별자(`data-action`) — 키맵이 이 버튼을 click()해 재사용한다. */
  action?: string,
): ToggleButton {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "note-toolbar-btn";
  if (action) btn.dataset.action = action;
  let on = initial;
  // aria-pressed + 아이콘을 상태에 맞춰 갱신 — on/off 아이콘이 다르면 토글마다 아이콘이 바뀐다.
  const reflect = () => {
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = on ? iconOn : iconOff;
  };
  reflect();
  btn.addEventListener("click", () => {
    on = !on;
    reflect();
    onToggle(on);
  });
  return {
    el: btn,
    set: (next) => {
      on = next;
      reflect();
    },
  };
}

/** 단순 아이콘 버튼(`icon`은 모듈 내부 전용 신뢰 마크업 — innerHTML). */
function iconButton(
  icon: string,
  onClick: () => void,
  /** 단축키 디스패치용 안정 식별자(`data-action`). */
  action?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerHTML = icon;
  btn.className = "note-toolbar-btn";
  if (action) btn.dataset.action = action;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 패널 open 상태를 hidden + 트리거 aria-expanded로 동기화한다(둘의 단일 소스는 여전히 hidden).
 * 왜: 스크린리더가 "펼침/접힘"을 알 수 있게 하되, 표시 로직은 hidden 하나로 유지(테스트 불변).
 */
function setMenuOpen(panel: HTMLElement, open: boolean): void {
  panel.hidden = !open;
  panel
    .closest(".note-toolbar-more")
    ?.querySelector<HTMLElement>("[aria-haspopup]")
    ?.setAttribute("aria-expanded", String(open));
}

/**
 * 같은 툴바의 모든 드롭다운 메뉴를 닫는다(한 번에 하나만 열리도록).
 *
 * `keepOpen`을 주면 그 요소이거나 그 요소를 담고 있는(조상) 메뉴는 건드리지 않는다 — 좁은 창에서
 * 배경 스와치 같은 레이어가 `⋯` 오버플로 패널 안으로 접혀 들어가면, 레이어 자신도 조상 `⋯` 패널도
 * 둘 다 `.note-toolbar-menu`다. `keepOpen` 없이 "모두 닫기"를 돌리면 조상까지 닫혀(hidden→
 * display:none) 그 안의 자식 레이어가 곧바로 다시 열려도(hidden=false) 화면엔 아무것도 그려지지
 * 않는다(조상이 안 보이면 자식의 hidden 상태는 무의미) — 이게 "오버플로 안에서 레이어 버튼을
 * 눌러도 반응이 없던" 원인이다.
 */
function closeAllMenus(within: HTMLElement, keepOpen?: HTMLElement): void {
  within
    .closest(".note-toolbar")
    ?.querySelectorAll<HTMLElement>(".note-toolbar-menu")
    .forEach((menu) => {
      if (keepOpen && menu.contains(keepOpen)) return; // 자기 자신·조상은 그대로 둔다.
      setMenuOpen(menu, false);
    });
}

/**
 * 드롭다운 트리거 클릭: 다른(무관한) 메뉴는 닫고 자기 패널만 토글한다(상호 배타).
 *
 * 자신을 담고 있는 조상 메뉴(오버플로에 접혀 들어간 경우)는 `keepOpen`으로 보호해 함께 닫히지
 * 않게 한다 — 안 그러면 조상이 열려 있어야만 보이는 자식 레이어가 스스로를 열자마자 조상과 함께
 * 안 보이게 된다(closeAllMenus 주석 참고).
 */
function toggleMenu(panel: HTMLElement): void {
  const willOpen = panel.hidden;
  closeAllMenus(panel, panel);
  setMenuOpen(panel, willOpen);
}

/**
 * `⋯` 패널을 트리거 우측에 붙여 왼쪽으로 펼치되, 좁은 창에서 왼쪽 밖으로 나가면 창 여백에 고정한다.
 *
 * 순수 함수(`reflowOverflow`) 밖의 실측 로직 — jsdom에선 rect가 0이라 사실상 no-op(테스트 무영향).
 * CSS가 기본으로 right:0(우측 정렬)이므로, 그 상태에서 왼쪽 끝이 창 여백을 넘으면 left로 전환한다.
 */
function anchorOverflowMenu(panel: HTMLElement): void {
  const M = 8; // 콘텐츠 좌우 여백(8px)과 일치.
  panel.style.left = "auto";
  panel.style.right = "0"; // CSS 기본값으로 리셋 후 측정.
  const wrap = panel.parentElement; // .note-toolbar-overflow(포함 블록)
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  if (rect.left < M) {
    panel.style.right = "auto";
    panel.style.left = `${M - wrapRect.left}px`; // 뷰포트 M을 wrap 로컬 좌표로 변환.
  }
}

/**
 * 트리거가 여는 레이어(팝업 패널)를 트리거 아래(공간이 없으면 위)에 **뷰포트 좌표로 고정**한다.
 * 배경 스와치 패널이 처음 이 함수를 필요로 했지만, 이름 그대로 **레이어를 여는 모든 툴바 항목**이
 * 공유하는 범용 배치 로직이다(새 레이어형 컨트롤을 추가할 때도 이 함수를 재사용한다).
 *
 * 왜 fixed인가 — 이것이 "🎨를 눌러도 아무것도 안 뜨던" 원인이었다: 레이어 트리거는 존의 측정
 * 영역(`.tb-zone-inner`) 안에 산다. 그 컨테이너는 접힘 판정(`scrollWidth > clientWidth`)을
 * 하려면 반드시 `overflow: hidden`이어야 하고, 그래서 그 안의 absolute 패널은 아이콘 한 줄
 * 높이(21px) 스트립으로 **잘려 나간다** — DOM엔 스와치 4개가 멀쩡히 있고 계산된 스타일도
 * 보임(opacity 1)인데 화면에는 아무것도 그려지지 않고 클릭도 안 먹는다.
 * `⋯` 패널이 멀쩡한 이유는 그 래퍼가 존 **직속**(측정 영역 밖)이기 때문이다. 레이어 트리거는
 * 사용자가 배치·정렬하는 아이템이라 존 **안**에 있어야 하므로, 래퍼는 그대로 두고 패널만
 * fixed로 빼내 뷰포트에 직접 놓는다(fixed는 조상의 overflow 클립을 받지 않는다).
 *
 * **좁은 창에서 트리거 자체가 `⋯` 오버플로 패널 속으로 접혀 들어간 경우도 그대로 동작한다** —
 * fixed는 조상의 `overflow: hidden`뿐 아니라 `⋯` 패널의 위치 기준(포함 블록)과도 무관하게
 * 뷰포트 좌표로 앉기 때문이다. 다만 조상인 `⋯` 패널 자신이 `hidden`(display:none)이면 그 안의
 * 무엇도 그려지지 않으므로, 이 함수를 부르는 트리거의 클릭 핸들러는 `toggleMenu`의 `keepOpen`
 * 보호를 통해 조상 `⋯` 패널이 함께 닫히지 않도록 해야 한다(toggleMenu 주석 참고).
 *
 * 세로 방향은 기존 CSS 규칙과 같은 결이다 — 아래 공간이 모자라면 위로 펼친다(하단 바의
 * `bottom: calc(100% + 6px)` 규칙이 하던 일을, 좌표를 JS가 정하므로 여기서 함께 판단한다).
 */
function anchorFloatingPanel(trigger: HTMLElement, panel: HTMLElement): void {
  const M = 8; // 창 가장자리 여백(콘텐츠 좌우 여백과 일치).
  const GAP = 6; // 트리거와 패널 사이 간격(CSS의 calc(100% + 6px)와 동일).
  panel.style.position = "fixed";
  panel.style.bottom = "auto"; // 하단 바 CSS(bottom 기준)와 다투지 않게 좌표계를 top으로 통일.
  panel.style.left = "0";
  panel.style.top = "0"; // 측정 전 리셋 — 이전 위치가 크기 측정에 섞이지 않게.
  const t = trigger.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const left = Math.max(M, Math.min(t.left, window.innerWidth - p.width - M));
  const below = t.bottom + GAP;
  const top =
    below + p.height + M > window.innerHeight ? t.top - p.height - GAP : below;
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(M, top)}px`;
}

/**
 * `⋯` 오버플로 메뉴(트리거 + 빈 패널). 패널은 너비가 좁을 때 오버플로 컨트롤러가
 * 넘치는 컨트롤을 여기로 옮기는 대상이다(넓으면 비어서 트리거가 숨는다).
 */
function overflowMenu(): { wrap: HTMLElement; panel: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "note-toolbar-more note-toolbar-overflow";
  wrap.hidden = true; // 넘치는 게 없으면 숨김(넓을 때 ⋯ 사라짐).

  const panel = document.createElement("div");
  panel.className = "note-toolbar-menu";
  panel.id = `tb-overflow-${Math.random().toString(36).slice(2, 8)}`;
  panel.setAttribute("role", "menu");
  panel.hidden = true;

  const trigger = iconButton(ICON.options, () => {
    toggleMenu(panel);
    if (!panel.hidden) anchorOverflowMenu(panel);
  });
  trigger.title = t("note.toolbar.more");
  trigger.setAttribute("aria-label", t("note.toolbar.more"));
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", panel.id);

  wrap.append(trigger, panel);
  return { wrap, panel };
}

/**
 * 오버플로 재배치(순수 DOM — 레이아웃 측정을 `overflows` 오라클로 분리해 테스트 가능).
 *
 * 넘치면 안 넘칠 때까지 항목을 ⋯ 패널로 옮기고 ⋯를 보인다. 안 넘치면 전부 인라인 복귀 + ⋯ 숨김.
 * **접는 방향은 정렬을 따른다**(`foldFromEnd`): 우측 정렬 존은 앞(왼쪽 끝)부터, 좌/가운데 정렬 존은
 * 뒤(오른쪽 끝)부터 접는다 — ⋯가 항상 존의 오른쪽에 있으니, 사용자가 먼저 읽는 쪽(정렬 기준 끝)의
 * 중요한 항목을 남기고 반대쪽부터 감춘다. 순서는 접기·복원 양쪽에서 보존한다. 접을 게 없어 패널이
 * 비면 ⋯도 숨긴다(빈 ⋯ 방지).
 *
 * `dataset.noFold === "true"`가 붙은 항목(접힘 제목 라벨)은 접기 후보에서 제외한다 — 그 항목까지
 * 밀려나면 접힘 헤더에서 "어느 메모인가"를 알 유일한 단서가 사라진다. 남은 후보가 모두 no-fold뿐이면
 * (더 접을 게 없으면) 계속 넘치는 채로 루프를 끝낸다(무한 루프 방지) — no-fold 항목은 스스로
 * min-width:0+overflow:hidden으로 줄어들어 넘침에 기여하지 않으므로 실전에서 이 상태가 오래
 * 지속되지 않는다.
 */
export function reflowOverflow(
  primary: HTMLElement,
  panel: HTMLElement,
  more: HTMLElement,
  overflows: () => boolean,
  foldFromEnd = false,
): void {
  // 1) 전부 인라인 복귀(순서 보존) 후 ⋯ 숨김. 접은 방향과 대칭으로 되돌린다.
  if (foldFromEnd) {
    while (panel.firstElementChild) primary.append(panel.firstElementChild);
  } else {
    while (panel.lastElementChild)
      primary.insertBefore(panel.lastElementChild, primary.firstChild);
  }
  more.hidden = true;
  if (!overflows()) return;
  // 2) 넘치면 ⋯ 노출 후, 안 넘칠 때까지 항목을 패널로 옮긴다. 좌/가운데는 뒤(오른쪽 끝)부터,
  // 우측은 앞(왼쪽 끝)부터 접어, 정렬 기준 끝의 항목을 오래 남긴다. no-fold 항목은 후보에서 뺀다.
  more.hidden = false;
  const nextFoldable = (): Element | null => {
    const kids = Array.from(primary.children) as HTMLElement[];
    const ordered = foldFromEnd ? kids.reverse() : kids;
    return ordered.find((el) => el.dataset.noFold !== "true") ?? null;
  };
  while (overflows()) {
    const candidate = nextFoldable();
    if (!candidate) break; // 더 접을 게 없다(남은 건 no-fold뿐) — 계속 넘치더라도 멈춘다.
    if (foldFromEnd) {
      panel.insertBefore(candidate, panel.firstChild);
    } else {
      panel.append(candidate);
    }
  }
  // 접을 게 없어 패널이 비면 ⋯ 자체를 숨긴다(빈 ⋯ 방지).
  more.hidden = panel.childElementCount === 0;
}

/** inner의 dataset.keys(JSON 배열)을 안전 파싱한다(깨졌으면 빈 배열). */
function parseZoneKeys(inner: HTMLElement): string[] {
  try {
    const raw = JSON.parse(inner.dataset.keys ?? "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 존 inner의 자식을 배치 순서(dataset.keys)대로 안정 정렬한다. 플러그인 버튼이 스냅샷 순서로
 * 나중에 append돼도 제자리로 돌린다. 순서에 없는(폴백) 항목끼리는 [`zoneItemRank`]가 매기는
 * 카탈로그(`BUILTIN_ITEMS`) 순서로 갈리고, 카탈로그에도 없는 플러그인 폴백 버튼은 끝에서
 * 원래 순서를 보존한다(동점을 아래 `i` 타이브레이크로 안정 정렬).
 */
function reorderZoneItems(inner: HTMLElement): void {
  const order = parseZoneKeys(inner);
  const kids = Array.from(inner.children) as HTMLElement[];
  const ranked = kids.map((el, i) => ({
    el,
    i,
    r: zoneItemRank(order, el.dataset.itemKey ?? ""),
  }));
  ranked.sort((a, b) => compareZoneItemRank(a.r, b.r) || a.i - b.i);
  for (const { el } of ranked) inner.append(el);
}

/**
 * 존 inner에 항목 하나를 **배치 순서(dataset.keys) + 카탈로그 순서**대로 끼워 넣는다.
 *
 * 왜 append가 아닌가: 컨트롤러(`installZoneOverflow`)의 MutationObserver가 곧 재정렬하긴
 * 하지만 그건 비동기(마이크로태스크)라, 그 사이에 한 프레임 어긋난 순서가 보인다 — 특히
 * 런타임에 능력이 켜져 항목이 되살아나는 경로(`setBackgroundCapability`·`setWindowControls`)는
 * "원래 있던 자리"로 돌아오는 것이 곧 사용자가 기대하는 동작이다.
 *
 * 배치가 모르는(폴백) 키끼리는 [`zoneItemRank`]가 [`BUILTIN_ITEMS`] 카탈로그 순서로 갈라
 * 삽입점을 찾는다 — 마운트 때 미가용이던 내장 컨트롤(`core:pin`·`core:all-desktops` 등)을
 * 별개 호출로 순차 켜도(`setWindowControls`를 여러 번 부르는 등) DOM 순서가 호출 순서가
 * 아니라 카탈로그 순서가 되어, 리로드했을 때 `materializeFallbacks`가 만드는 순서와
 * 어긋나지 않는다. 카탈로그에도 없는 키(플러그인 폴백 버튼)는 기존처럼 가장 뒤에, 이미
 * DOM에 있는(먼저 삽입된) 폴백 항목들 뒤로 붙는다(동점이면 `find`가 첫 매치를 찾지
 * 못해 `insertBefore(el, null)` → append와 같은 효과 — 안정 순서 유지).
 */
function insertByLayoutOrder(
  inner: HTMLElement,
  el: HTMLElement,
  key: string,
): void {
  const order = parseZoneKeys(inner);
  const rank = zoneItemRank(order, key);
  const next = (Array.from(inner.children) as HTMLElement[]).find(
    (child) =>
      compareZoneItemRank(
        zoneItemRank(order, child.dataset.itemKey ?? ""),
        rank,
      ) > 0,
  );
  inner.insertBefore(el, next ?? null);
}

/**
 * 한 존에 오버플로 컨트롤러를 붙인다: 너비 변화(ResizeObserver)·항목 추가(MutationObserver,
 * 플러그인 버튼)마다 (1) 패널 항목 복원 → (2) 배치 순서대로 재정렬 → (3) 넘치면 앞에서부터 ⋯로 접기.
 * 재배치 중 자기 변경으로 루프가 돌지 않도록 MutationObserver를 잠시 끊는다. 측정은 inner의 내용이
 * 배정 폭을 넘는지(scrollWidth>clientWidth)로 한다(inner는 flex:0 1 auto+overflow:hidden).
 */
function installZoneOverflow(
  zone: HTMLElement,
  inner: HTMLElement,
  panel: HTMLElement,
  more: HTMLElement,
): void {
  const overflows = (): boolean => inner.scrollWidth > inner.clientWidth + 0.5;
  // 우측 정렬 존만 앞에서부터, 그 외(좌·가운데)는 뒤에서부터 접는다(중요 항목을 오래 남긴다).
  const foldFromEnd = zone.dataset.align !== "right";
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    mo.disconnect(); // 자기 재배치가 MutationObserver를 다시 부르지 않게.
    // 정렬 전에 패널 항목을 inner로 모은다(순서 보존 — 앞에서 꺼내 끝에 붙인다). 그 뒤 재정렬로 확정.
    while (panel.firstElementChild) inner.append(panel.firstElementChild);
    reorderZoneItems(inner);
    reflowOverflow(inner, panel, more, overflows, foldFromEnd);
    // 배지 개수·툴팁은 컨트롤러가 얹는다(순수 reflowOverflow는 건드리지 않는다).
    const n = panel.childElementCount;
    more.dataset.count = String(n);
    const trigger = more.querySelector<HTMLElement>("[aria-haspopup]");
    if (trigger) {
      const label = n
        ? t("note.toolbar.more-hidden", { n })
        : t("note.toolbar.more");
      trigger.title = label;
      trigger.setAttribute("aria-label", label);
    }
    // 항목이 하나도 없는 존(모든 키가 현재 미가용)은 폭을 차지하지 않게 접는다(형제 존에 폭 양보).
    zone.classList.toggle(
      "tb-zone--empty",
      inner.childElementCount === 0 && panel.childElementCount === 0,
    );
    // 열린 채로 리플로우되면(항목 추가·리사이즈) 위치를 다시 맞춘다.
    if (!panel.hidden) anchorOverflowMenu(panel);
    observe();
    running = false;
  };
  const mo = new MutationObserver(run);
  // 인라인 영역(inner)과 `⋯` 패널을 **둘 다** 본다: 좁은 창에서는 항목이 패널로 접혀 들어가
  // 있어서, 런타임에 지워지거나 교체되는 플러그인 항목(`reconcileToolbarItems`)의 변화가
  // inner에는 아무 흔적을 남기지 않는다 — 그러면 ⋯ 배지 개수가 낡고, 마지막 항목이 지워진
  // 뒤에도 빈 ⋯ 트리거가 남는다. 재배치 중 자기 변경으로 루프가 돌지 않게 run()이 먼저
  // disconnect하고 끝에서 둘을 다시 등록한다.
  const observe = (): void => {
    mo.observe(inner, { childList: true });
    mo.observe(panel, { childList: true });
  };
  // ResizeObserver는 실제 웹뷰에만 있다(jsdom엔 없음 — 단위 테스트에선 측정이 0이라 no-op).
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(run).observe(zone);
  }
  observe();
  run();
}

/** 배경색 피커 핸들 — 요소 + 외부에서 트리거 칩 색을 맞추는 setter(옵션 초기화용). */
interface BackgroundPicker {
  el: HTMLElement;
  /** 트리거 칩을 이 색으로 칠한다(옵션 초기화로 배경이 기본값으로 돌아갈 때 UI 동기화). */
  setColor(color: string): void;
  /** 열려 있으면 패널 좌표를 다시 맞춘다(창 크기 변경 — fixed라 스스로 따라오지 않는다). */
  reanchor(): void;
  /**
   * 팔레트(스와치 노드)만 통째로 갈아 끼운다 — 배경 플러그인이 런타임에 다른 팔레트를
   * 등록했을 때 피커를 **다시 만들지 않기** 위한 통로(`setBackgroundCapability`).
   */
  setSwatches(swatches: string[]): void;
}

/** 배경색 피커: 트리거를 현재 배경색을 칠한 칩으로 둬 "배경색"임을 직관화한다. */
function backgroundPicker(
  swatches: string[],
  current: string,
  onPick: (color: string) => void,
  onCommit: () => void,
): BackgroundPicker {
  const wrap = document.createElement("div");
  wrap.className = "note-toolbar-more";

  const panel = document.createElement("div");
  panel.className = "note-toolbar-menu note-toolbar-swatches";
  panel.hidden = true;

  // 트리거 = 물방울 윤곽선(항상 보인다) + 현재 노트 배경색으로 채운 안쪽(무슨 버튼인지 +
  // 현재 색이 무엇인지 한눈에). 채움만 있던 옛 칩은 노트 배경과 같은 색이라 안 보였다
  // (`BG_GLYPH_BODY` 주석 참고).
  const chip = document.createElement("span");
  chip.className = "note-bg-chip";
  chip.innerHTML = BG_GLYPH_BODY_SVG; // 모듈 내부 상수(신뢰 마크업) — 외부 입력 없음.
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "note-toolbar-btn note-bg-trigger";
  trigger.title = t("note.toolbar.background");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.append(chip);
  // 열 때마다 좌표를 다시 잡는다 — 패널은 fixed(뷰포트 기준)라 트리거가 접힘·재배치로
  // 옮겨 다녀도 따라오려면 여는 시점에 실측해야 한다(anchorFloatingPanel 주석 참고).
  const reanchor = () => {
    if (!panel.hidden) anchorFloatingPanel(trigger, panel);
  };
  trigger.addEventListener("click", () => {
    toggleMenu(panel);
    reanchor();
  });

  const custom = document.createElement("input");
  custom.type = "color";
  custom.className = "note-swatch-custom";
  custom.setAttribute("aria-label", t("note.toolbar.background-custom"));

  /**
   * 현재 색을 트리거 글리프의 안쪽 채움과 커스텀 색 입력에 함께 반영한다.
   *
   * 커스텀 입력까지 맞추는 이유: `<input type="color">`의 기본값은 `#000000`이라, 그냥 두면
   * 파스텔 스와치 옆에 **검은 칩**이 하나 더 있는 것처럼 보인다("검정 배경 선택"으로 읽힌다).
   * 현재 색을 담고 있으면 "여기서 직접 고른다"는 뜻이 그대로 드러나고, 색 고르개도 지금 색에서
   * 시작한다.
   */
  const paint = (color: string) => {
    trigger.style.setProperty("--note-chip", color);
    custom.value = color; // hex가 아니면 브라우저가 무시한다(호출부가 이미 정규화된 색을 준다).
  };
  paint(current);

  const pick = (color: string) => {
    onPick(color);
    paint(color); // 선택한 색을 즉시 반영
  };

  const makeSwatch = (color: string): HTMLButtonElement => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "note-swatch";
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener("click", () => {
      pick(color);
      onCommit(); // 스와치는 이산 선택 → 즉시 영속화.
      panel.hidden = true;
    });
    return swatch;
  };

  custom.addEventListener("input", () => pick(custom.value)); // 드래그 중 적용만
  custom.addEventListener("change", () => onCommit()); // 놓을 때 1회 저장
  panel.append(custom);

  /**
   * 스와치 노드만 갈아 끼운다 — 트리거·패널·커스텀 색 입력과 **거기 붙은 리스너는 그대로**
   * 둔다. 피커를 통째로 다시 만들면 같은 동작에 리스너가 겹쳐 붙고(클릭 한 번에 두 번 저장)
   * 열려 있던 패널·좌표도 함께 사라진다. 커스텀 입력은 언제나 팔레트 뒤에 남는다.
   */
  const setSwatches = (next: string[]): void => {
    for (const el of [...panel.querySelectorAll(".note-swatch")]) el.remove();
    for (const color of next) panel.insertBefore(makeSwatch(color), custom);
  };
  setSwatches(swatches);

  wrap.append(trigger, panel);
  return { el: wrap, setColor: paint, reanchor, setSwatches };
}

/**
 * 플러그인 버튼을 배치(layout)가 지정한 존에 놓는 함수. note-window가 만든 버튼 요소와, 그
 * 버튼이 선언한 폴백 `position`(있으면)을 받는다. 존은 컨트롤러가 dataset.keys 순서로
 * 재정렬하므로 append만 하면 제자리로 간다.
 *
 * 우선순위: (1) key가 배치의 어느 존에 있으면 그 존 — 사용자 배치가 항상 유일한 진실.
 * (2) 없고 `layout.seen`에 있으면(=사용자가 명시적으로 팔레트로 뺀 버튼) 렌더하지 않는다
 * ("미배치=숨김"). (3) 없고 seen에도 없으면(=이 배치가 한 번도 알지 못한 신규 버튼) position이
 * 가리키는 존에 자동 배치한다 — 그 존이 없으면(0단 바 등) 안전하게 건너뛴다.
 */
type PlaceToolbarItem = (
  key: string,
  el: HTMLElement,
  position?: FallbackPosition,
) => void;

/**
 * [`createNoteToolbar`] 입력 — 위치 인자가 아니라 이름 있는 옵션이다.
 *
 * 왜 객체인가: 예전엔 7개 위치 인자였고 뒤쪽 셋(컨트롤·배치·프롬프트)에 기본값이 있었다. 그
 * 기본값이 "알려진 창 컨트롤 전부 켜짐"이었던 탓에, 인자를 빠뜨린 호출부는
 * **꺼둔 플러그인의 컨트롤까지 그리는데도 컴파일이 통과**했다(fail-open). 능력은 이제 필수
 * 필드이고, "모름"은 [`NO_CAPABILITIES`]로 **명시**해야 한다.
 */
export interface NoteToolbarOptions {
  /** 지금 노트 옵션 상태(투명도·핀 등) — 컨트롤 초기값. */
  state: NoteOptionState;
  /** 컨트롤 조작을 받는 핸들러 묶음. */
  handlers: NoteToolbarHandlers;
  /** 배경 스와치(빈 배열 = 배경 플러그인 off → 피커를 그리지 않는다). */
  swatches: string[];
  /** 지금 노트 배경색(피커 초기 선택). */
  currentBackground: string;
  /**
   * 지금 살아 있는 플러그인 능력 — 조건부 컨트롤(투명도·항상 위·모든 데스크탑)의 노출 조건.
   * 필수다: 모르면 [`NO_CAPABILITIES`]를 넘겨 "안 그린다"를 명시한다(추정 금지).
   */
  capabilities: PluginCapabilities;
  /** 전역 툴바 배치(상/하 바 × 존). */
  layout: ToolbarLayout;
  /**
   * 최초 실행 툴바 스타일(Mac/Windows) 선택 프롬프트 훅 — **테스트 주입점**이라 유일하게
   * 옵셔널이다(기본은 실전 구현 `maybeShowToolbarStylePrompt`). 능력 플래그와 달리 빠뜨려도
   * 위험하지 않다: 기본값이 곧 실제 앱이 쓰는 배선이다(이슈 #16 §4).
   */
  showStylePrompt?: () => void;
}

/**
 * 노트 옵션 툴바 DOM을 배치(layout)대로 만들어 반환하고 입력을 핸들러에 연결한다.
 *
 * 역할: 상/하 바를 0·1·2·3단으로 구성해 각 단(존)에 아이템을 순서대로 놓고, 존별 ⋯ 오버플로를
 * 붙인다. 내장 컨트롤은 여기서 생성(조건부는 생략), 플러그인 버튼은 note-window가 `placeItem`으로
 * 채운다. 컨트롤 생성·이벤트 배선을 한 곳에 모아 테스트 가능하게 한다.
 */
export function createNoteToolbar({
  state,
  handlers,
  swatches,
  currentBackground,
  capabilities,
  layout,
  showStylePrompt = maybeShowToolbarStylePrompt,
}: NoteToolbarOptions): {
  top: HTMLElement;
  bottom: HTMLElement;
  resync: NoteToolbarResync;
  placeItem: PlaceToolbarItem;
  closeMenus: () => void;
  /** 접힘 헤더 가운데 제목 라벨의 텍스트를 맞춘다. 배치에 core:collapsed-title이 없으면 no-op. */
  setCollapsedTitle: (text: string) => void;
  /**
   * 배경 **능력**이 런타임에 바뀌었다(배경 플러그인 on/off·다른 팔레트 등록). 스와치가
   * 없어지면 배경색 항목을 지우고, 생기면 그 자리에 되살린다. 남아 있으면 팔레트·현재 색만
   * 갈아 끼운다. 호출부(note-window)가 **이미 새 색을 화면에 적용한 뒤** 그 값을 넘긴다.
   */
  setBackgroundCapability: (swatches: string[], currentBg: string) => void;
  /**
   * 창 컨트롤 **능력**이 런타임에 바뀌었다(투명도·항상 위·모든 데스크탑 플러그인 on/off).
   * 꺼진 컨트롤은 지우고, 켜진 컨트롤은 **넘겨받은 최신 상태값으로** 만들어 되살린다
   * (마운트 때 굳은 초기값으로 만들면 슬라이더가 옛 투명도를 가리킨다).
   */
  setWindowControls: (
    controls: readonly string[],
    state: NoteOptionState,
  ) => void;
} {
  // 가변인 이유: 능력·상태는 런타임에 바뀐다(아래 setWindowControls·setBackgroundCapability).
  // 내장 컨트롤을 **다시 만들 때** 그 시점의 최신 값을 봐야 옛 값으로 굳은 UI가 되살아나지
  // 않는다(note-window의 activeTheme·activeFont와 같은 결).
  let liveControls = capabilities.windowControls;
  let liveState = state;
  let liveSwatches = swatches;
  let liveBackground = currentBackground;
  // 사용자가 아직 툴바 스타일(닫기 버튼 좌/우)을 고른 적 없으면 한 번 물어본다(무해 — 조회·
  // 저장 실패는 조용히 넘어간다). 창마다(=모듈 재로드마다) 한 번만 시도한다.
  showStylePrompt();

  // 옵션 초기화 시 컨트롤 UI(토글 내부 상태·슬라이더·배경 칩)를 새 상태로 되맞추는 콜백들.
  // 존재하는 컨트롤만 담기므로(조건부 창 컨트롤·배경 피커) 없는 건 자동으로 건너뛴다.
  //
  // 배열이 아니라 **아이템 키 맵**인 이유: 컨트롤이 런타임에 사라질 수 있게 되면서
  // (`setWindowControls`) 그 콜백도 함께 지워야 한다 — 남겨두면 이미 DOM에서 뗀 요소를
  // 계속 만지고(무해하지만 누수), 같은 컨트롤이 되살아났을 때 옛 콜백과 새 콜백이 겹친다.
  const resyncers = new Map<string, NoteToolbarResync>();
  // 열려 있는 배경 스와치 패널의 좌표를 다시 잡는 콜백(패널이 fixed라 창 크기 변경을 따라가려면
  // 다시 실측해야 한다 — ⋯ 패널의 anchorOverflowMenu와 같은 자리에서 함께 돈다). 맵인 이유는
  // resyncers와 같다(항목이 사라지면 함께 지운다).
  const swatchReanchors = new Map<string, () => void>();
  // 지금 DOM에 살아 있는 내장 컨트롤(키 → 요소) — 런타임 능력 전환이 무엇을 지우고 무엇을
  // 새로 만들지 판정하는 근거다. `⋯` 패널로 접혀 들어가도 요소 참조는 그대로라(remove()는
  // 어디에 있든 동작한다) 접힘 상태를 따로 추적할 필요가 없다.
  const builtinEls = new Map<string, HTMLElement>();
  // 배경 피커 핸들(살아 있을 때만) — 스와치·현재 색만 갈아 끼우는 통로.
  let bgPicker: BackgroundPicker | null = null;

  // 이 창에서 실제로 쓸 수 있는 내장 컨트롤(대응 번들 플러그인이 켜져 있고, 배경 피커는 스와치가
  // 있을 때). 조건 판정은 설정 창 팔레트와 **같은 순수 함수**를 쓴다 — 두 곳이 갈라지면
  // "팔레트엔 있는데 노트엔 안 나오는" 유령 아이템이 생긴다.
  const builtins = availableBuiltinItems(
    liveControls,
    hasBackgroundPicker(liveSwatches),
  );
  const availableBuiltin = new Set<string>(builtins.map((i) => i.key));
  // 배치를 이 환경에 맞춰 확정한다:
  //  (1) 못 쓰는 내장 컨트롤은 배치에서 지운다(seen까지 — 다시 켰을 때 "사용자가 뺀 것"으로
  //      오인돼 영영 안 나오는 것을 막는다). 플러그인 키는 여기서 판정하지 않고 그대로 둔다
  //      — 이 창은 어떤 플러그인이 살아 있는지 모르고(버튼은 나중에 placeItem으로 들어온다),
  //      모르는 것을 "없음"으로 지우면 사용자 배치가 날아간다.
  //  (2) 배치가 아직 모르는 가용 내장 컨트롤은 `position`이 가리키는 기본 자리에 놓는다 —
  //      플러그인 버튼의 폴백과 완전히 같은 규칙(설정 편집기의 목업도 같은 함수를 쓴다).
  const effective = materializeFallbacks(
    pruneLayout(
      layout,
      (key) => !isBuiltinItemKey(key) || availableBuiltin.has(key),
    ),
    builtins,
  );

  // 내장 컨트롤을 키로 생성한다(가용 판정은 위 `effective`가 이미 끝냈다). resync 등록도 여기서 한다.
  const buildBuiltin = (key: string): HTMLElement | null => {
    switch (key) {
      case "core:transparency": {
        const alpha = document.createElement("input");
        alpha.type = "range";
        alpha.min = String(TRANSPARENCY_MIN);
        alpha.max = "100";
        alpha.value = String(liveState.transparency);
        alpha.className = "note-toolbar-alpha";
        alpha.setAttribute("aria-label", t("note.toolbar.transparency"));
        alpha.addEventListener("input", () =>
          handlers.setTransparency(Number(alpha.value)),
        );
        alpha.addEventListener("change", () => handlers.commit());
        resyncers.set(key, (s) => {
          alpha.value = String(s.transparency);
        });
        return alpha;
      }
      case "core:preview": {
        const preview = toggleButton(
          ICON.preview,
          liveState.preview,
          handlers.togglePreview,
          ICON.preview,
          "toggle-preview",
        );
        preview.el.title = t("note.toolbar.preview");
        resyncers.set(key, (s) => preview.set(s.preview));
        return preview.el;
      }
      case "core:pin": {
        const pin = toggleButton(
          ICON.pin,
          liveState.pinned,
          handlers.setPinned,
          ICON.pin,
          "toggle-pin",
        );
        pin.el.title = t("note.toolbar.pin");
        resyncers.set(key, (s) => pin.set(s.pinned));
        return pin.el;
      }
      case "core:all-desktops": {
        const allDesktops = toggleButton(
          ICON.allDesktops,
          liveState.allSpaces,
          handlers.setAllSpaces,
          ICON.allDesktops,
          "toggle-all-desktops",
        );
        allDesktops.el.title = t("note.toolbar.all-desktops");
        resyncers.set(key, (s) => allDesktops.set(s.allSpaces));
        return allDesktops.el;
      }
      case "core:background": {
        const picker = backgroundPicker(
          liveSwatches,
          liveBackground,
          handlers.setBackground,
          handlers.commit,
        );
        bgPicker = picker;
        resyncers.set(key, (_s, background) => picker.setColor(background));
        swatchReanchors.set(key, picker.reanchor);
        return picker.el;
      }
      case "core:collapse": {
        // 펼침 상태엔 접기(∧), 접힘 상태엔 펼치기(∨) 아이콘을 보여준다.
        const collapse = toggleButton(
          ICON.collapse,
          liveState.collapsed,
          handlers.setCollapsed,
          ICON.expand,
          "toggle-collapse",
        );
        collapse.el.title = t("note.toolbar.collapse");
        resyncers.set(key, (s) => collapse.set(s.collapsed));
        return collapse.el;
      }
      case "core:collapsed-title": {
        // 텍스트는 버튼이 아니라 note-window가 setCollapsedTitle(반환값)로 채운다(접힘 진입 +
        // 저장 완료 후 — note-window.ts 주석 참고). 여기선 빈 채로 만들기만 한다: 첫 렌더
        // 시점엔 아직 창 타이틀을 몰라도 무방하다(펼친 상태엔 CSS가 어차피 숨긴다).
        const label = document.createElement("span");
        label.className = "note-collapsed-title";
        // 다른 항목과 똑같이 자기 존의 inner에 섞여 들어가지만, 접힘 중 "어느 메모인가"의
        // 유일한 단서라 아무리 좁아져도 ⋯로 접히면 안 된다 — reflowOverflow(순수 함수)가 이
        // 마커로 접기 후보에서 제외한다(styles.css의 호버 게이트 예외와는 별개로, 여긴 DOM
        // 이동 자체를 막는다).
        label.dataset.noFold = "true";
        collapsedTitleEl = label;
        return label;
      }
      case "core:archive": {
        // 라벨은 "닫기"(이슈 #16)로 바뀌었지만 키·핸들러(archiveNote)·data-action은 그대로다
        // — 동작은 여전히 창을 숨기는 보관(hidden=true)이라, 이름만 사용자가 이해하는 "닫기"에
        // 맞춘다(단축키 설정·기존 저장 배치와의 호환을 깨지 않기 위해 키 자체는 유지).
        const close = iconButton(
          ICON.close,
          handlers.archiveNote,
          "archive-note",
        );
        close.title = t("note.toolbar.archive");
        return close;
      }
      case "core:delete": {
        const del = iconButton(ICON.trash, handlers.deleteNote, "delete-note");
        del.title = t("note.toolbar.delete");
        return del;
      }
      case "core:settings": {
        // 설정 창 열기(이슈 #16) — NoteToolbarHandlers를 거치지 않고 직접 배선한다: 이 버튼은
        // 노트별 상태와 무관한 고정 전역 동작이라 note-window.ts의 핸들러 객체를 넓힐 필요가
        // 없다(그 파일은 다른 작업으로 잠겨 있어 애초에 넓힐 수도 없다). `openSettings`는 새
        // Tauri 커맨드 등록 없이(lib.rs 동시 작업 중) 기존 전역 이벤트 채널로 백엔드(tray.rs)에
        // "설정 창 열기"를 요청한다.
        const openBtn = iconButton(
          ICON.settings,
          () =>
            void openSettings().catch((err) => {
              // note-window.ts는 `?note=<id>` 창에 전역 unhandledrejection 핸들러
              // (installNoteErrorOverlay)를 무조건 설치해 잡히지 않은 거부를 전체화면 크래시
              // 오버레이로 바꾼다 — 설정 창 열기 실패라는 사소한 일로 노트 창 전체가 죽는 과잉
              // 반응을 막기 위해 여기서 흡수한다. note-window.ts의 "app:settings" 컨텍스트 메뉴
              // 핸들러는 같은 실패를 showToast로 안내하지만, 이 모듈은 그 로컬 클로저에 접근할
              // 수 없어(note-window.ts는 다른 작업으로 잠겨 있어 토스트 훅을 새로 낼 수 없음)
              // 최소 방어로 콘솔 로그만 남기고 무시한다.
              console.error("[note-toolbar] openSettings failed", err);
            }),
          "open-settings",
        );
        openBtn.title = t("note.toolbar.settings");
        return openBtn;
      }
      case "core:new-note": {
        // 새 메모 만들기(베타 피드백 1건) — core:settings와 같은 이유로 NoteToolbarHandlers를
        // 거치지 않고 직접 배선한다: 노트별 상태가 아니라 앱 전역 동작이고, note-window.ts는
        // 다른 작업으로 잠겨 있어 핸들러 객체를 넓힐 수 없다. `createAndOpenNote()`
        // (shared/tauri.ts)는 패널의 "+" 버튼·컨텍스트 메뉴 "새 메모"와 같은 커맨드
        // (`note_create_and_open`)를 공유한다 — 새 노트를 만들고 그 창을 곧바로 연다.
        const newNoteBtn = iconButton(
          ICON.newNote,
          () =>
            void createAndOpenNote().catch((err) => {
              // openSettings 실패 흡수(위)와 같은 이유 — 사소한 실패로 노트 창 전체가
              // unhandledrejection 크래시 오버레이로 죽는 과잉 반응을 막는다.
              console.error("[note-toolbar] createAndOpenNote failed", err);
            }),
          "new-note",
        );
        newNoteBtn.title = t("note.toolbar.new-note");
        return newNoteBtn;
      }
      default:
        return null;
    }
  };

  // 아이템 키 → 그 키가 속한 존 inner 요소(플러그인 버튼 배치 조회용).
  const keyToInner = new Map<string, HTMLElement>();
  // `${bar}:${zoneIndex}` → 그 존의 inner 요소(내용물과 무관하게 전 존을 담는다 — position
  // 폴백이 "이 바·이 정렬쪽에 실존하는 존"을 찾을 때 쓴다).
  const zoneInner = new Map<string, HTMLElement>();
  const overflowPanels: HTMLElement[] = [];
  // 접힘 제목 라벨(core:collapsed-title, 배치에 있을 때만) — buildBar가 만들면서 채운다.
  // setCollapsedTitle 노출용 클로저 변수라 buildBar 밖에서도 살아 있어야 한다.
  let collapsedTitleEl: HTMLElement | null = null;

  /**
   * 내장 컨트롤 하나를 만들어 존에 넣고 "살아 있는 항목"으로 등록한다 — 마운트(`buildBar`)와
   * 런타임 복귀(`syncBuiltinAvailability`)가 **같은 자리**를 쓰게 해 두 경로가 갈리지 않게 한다
   * (한쪽만 dataset.itemKey를 빠뜨리면 배치·오버플로가 그 항목을 못 알아본다).
   */
  const mountBuiltin = (key: string, inner: HTMLElement): void => {
    const el = buildBuiltin(key);
    if (!el) return;
    el.dataset.itemKey = key;
    builtinEls.set(key, el);
    // 접힘 제목(core:collapsed-title)도 다른 항목과 똑같이 자기 존의 inner에, 배치 순서
    // 그대로 들어간다 — 배치의 실제 자리(어느 존의 몇 번째)가 곧 렌더 위치다. 접힘 중에도
    // 호버 없이 항상 보이는 것(호버 게이트를 존 단위에서 항목 단위로 내리기)과 ⋯로 접히지
    // 않는 것(dataset.noFold)은 styles.css·reflowOverflow가 맡는다 — 존 밖으로 빼는 특수
    // 처리는 더 이상 없다.
    insertByLayoutOrder(inner, el, key);
  };

  // 한 바를 배치대로 만든다(0단이면 빈 바 — CSS로 상단은 드래그 스트립, 하단은 숨긴다).
  const buildBar = (barId: BarId, barLayout: BarLayout): HTMLElement => {
    const bar = document.createElement("div");
    bar.className =
      barId === "top" ? "note-toolbar" : "note-toolbar note-toolbar--bottom";
    const zones = barLayout.zones;
    if (zones.length === 0) {
      bar.classList.add("note-toolbar--empty");
      return bar;
    }
    zones.forEach((zoneKeys, zi) => {
      const zone = document.createElement("div");
      zone.className = "tb-zone";
      zone.dataset.zone = String(zi);
      zone.dataset.align = zoneAlignOf(barLayout, zi);
      // 줄임 우선순위(0 먼저·1 보통·2 유지) → CSS가 flex-shrink 가중치로 접힘 순서를 정한다.
      zone.dataset.fold = String(foldRankOf(barLayout, zi));

      const inner = document.createElement("div");
      inner.className = "tb-zone-inner";
      inner.dataset.bar = barId;
      inner.dataset.zone = String(zi);
      inner.dataset.keys = JSON.stringify(zoneKeys);
      zoneInner.set(`${barId}:${zi}`, inner);

      for (const key of zoneKeys) {
        keyToInner.set(key, inner);
        // 내장 컨트롤만 지금 생성한다(플러그인 키는 note-window가 placeItem으로 채운다).
        if (isBuiltinItemKey(key)) mountBuiltin(key, inner);
      }

      const overflow = overflowMenu();
      overflowPanels.push(overflow.panel);
      zone.append(inner, overflow.wrap);
      bar.append(zone);
      installZoneOverflow(zone, inner, overflow.panel, overflow.wrap);
    });
    return bar;
  };

  const top = buildBar("top", effective.top);
  const bottom = buildBar("bottom", effective.bottom);
  // 상단 바에 표시할 버튼이 없어도(0단·모두 미배치) 아이콘 행 높이의 드래그 스트립으로 남겨
  // 테두리 없는 창을 상단에서 잡아 옮길 수 있게 하는 처리는 CSS(`:has`)가 담당한다(styles.css).

  /**
   * 이 키를 지금 어느 존에 넣어야 하는가 — 배치에 있으면 그 존, 배치가 모르면 `position`이
   * 가리키는 폴백 존, 사용자가 명시적으로 뺐으면(seen) null(=그리지 않는다).
   *
   * 플러그인 버튼(`placeItem`)과 런타임에 되살아나는 내장 컨트롤이 **같은 규칙**을 쓴다:
   * 조회 한 곳이 두 벌이 되면 "팔레트에서 뺐는데 되살아나는" 유령 항목이 생긴다.
   */
  const zoneFor = (
    key: string,
    position: FallbackPosition | undefined,
  ): HTMLElement | null => {
    const explicit = keyToInner.get(key);
    if (explicit) return explicit;
    if (effective.seen?.includes(key)) return null;
    if (!position) return null;
    const target = fallbackZoneFor(effective, position);
    if (!target) return null;
    return zoneInner.get(`${target.bar}:${target.zone}`) ?? null;
  };

  // 플러그인 버튼을 배치한다 — 우선순위는 PlaceToolbarItem 문서 참고.
  const placeItem: PlaceToolbarItem = (key, el, position) => {
    el.dataset.itemKey = key;
    const inner = zoneFor(key, position);
    if (inner) insertByLayoutOrder(inner, el, key);
  };

  // 드롭다운 래퍼 밖을 누르면 두 바의 열린 메뉴를 닫는다(에디터 클릭 등). 노트창 전용 document.
  document.addEventListener("mousedown", (event) => {
    if (!(event.target as HTMLElement).closest(".note-toolbar-more")) {
      closeAllMenus(top);
      closeAllMenus(bottom);
    }
  });

  // Esc로 열린 메뉴를 닫고 트리거로 포커스를 되돌린다(body로 떨어져 툴바가 다시 숨는 것 방지 — 가역).
  const onEsc = (bar: HTMLElement) => (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const open = bar.querySelector<HTMLElement>(
      ".note-toolbar-menu:not([hidden])",
    );
    if (!open) return;
    const trigger = open
      .closest(".note-toolbar-more")
      ?.querySelector<HTMLElement>("[aria-haspopup]");
    closeAllMenus(bar);
    trigger?.focus();
    event.stopPropagation();
  };
  top.addEventListener("keydown", onEsc(top));
  bottom.addEventListener("keydown", onEsc(bottom));

  // 창 크기가 바뀌면 열려 있는 패널 위치를 다시 맞춘다(좁아지면 창 밖으로 나가지 않게).
  window.addEventListener("resize", () => {
    for (const panel of overflowPanels)
      if (!panel.hidden) anchorOverflowMenu(panel);
    for (const reanchor of swatchReanchors.values()) reanchor();
  });

  // 옵션 초기화 후 note-window가 부르는 UI 재동기화 — 존재하는 컨트롤 콜백만 모아 한 번에 돌린다.
  const resync: NoteToolbarResync = (nextState, background) => {
    for (const r of resyncers.values()) r(nextState, background);
  };

  // 접힘 전환 시 note-window가 부른다: 열려 있던 `⋯`·배경색 패널을 닫아 CSS로 트리거를 감춘
  // 뒤에도 "패널만 열린 채 숨은" 내부 상태가 남지 않게 한다(다시 펼쳤을 때 뜬금없이 열린 패널이
  // 보이는 것을 막는다 — hideSelectionToolbar와 같은 이유).
  const closeMenus = (): void => {
    closeAllMenus(top);
    closeAllMenus(bottom);
  };

  // 접힘 라벨 텍스트를 note-window가 갱신하는 통로. 사용자가 배치에서 core:collapsed-title을
  // 빼면 buildBuiltin이 그 키로 불리지 않아 collapsedTitleEl이 null로 남는다 — 그때는 no-op이라
  // (창 타이틀을 읽어도 갈 곳이 없다) note-window는 "항목이 있는지"를 따로 몰라도 된다.
  const setCollapsedTitle = (text: string): void => {
    if (!collapsedTitleEl) return;
    collapsedTitleEl.textContent = text;
    collapsedTitleEl.title = text; // 말줄임됐을 때를 위한 전체 텍스트 툴팁.
  };

  /**
   * 지금 가용한 내장 컨트롤 집합에 DOM을 맞춘다(런타임 능력 전환의 공통 수행부).
   *
   * 가용 판정은 마운트와 **같은 순수 함수**(`availableBuiltinItems`)다 — 두 경로가 갈리면
   * "켰는데 안 나오는" 유령 항목이 생긴다. 사라진 항목은 요소를 떼고 딸린 콜백까지 지우며,
   * 새로 가용해진 항목은 지금 값(`liveState`·`liveSwatches`)으로 만들어 원래 자리에 되돌린다.
   *
   * 마운트 때 없던 컨트롤은 배치가 그 키를 모르므로(`pruneLayout`이 seen까지 지웠다) 폴백
   * 자리(존 끝)로 간다 — 마운트가 `materializeFallbacks`로 하는 일과 같은 규칙이다. 반대로
   * 마운트 때 있었다가 껐다 켜는 경우엔 배치가 그 자리를 기억하고 있어 **제자리로** 돌아온다.
   */
  const syncBuiltinAvailability = (): void => {
    const next = availableBuiltinItems(
      liveControls,
      hasBackgroundPicker(liveSwatches),
    );
    const nextKeys = new Set<string>(next.map((i) => i.key));
    for (const [key, el] of [...builtinEls]) {
      if (nextKeys.has(key)) continue;
      el.remove(); // ⋯ 패널로 접혀 들어가 있어도 그대로 떨어진다.
      builtinEls.delete(key);
      resyncers.delete(key);
      swatchReanchors.delete(key);
      if (key === "core:background") bgPicker = null;
    }
    for (const item of next) {
      if (builtinEls.has(item.key)) continue;
      const inner = zoneFor(item.key, item.position);
      if (inner) mountBuiltin(item.key, inner);
    }
  };

  const setBackgroundCapability = (
    nextSwatches: string[],
    currentBg: string,
  ): void => {
    liveSwatches = nextSwatches;
    liveBackground = currentBg;
    syncBuiltinAvailability(); // 스와치 유무가 뒤집혔으면 항목을 지우거나 되살린다.
    // 계속 살아 있던 피커는 다시 만들지 않고 팔레트·현재 색만 갈아 끼운다(리스너 중복 방지).
    // 방금 새로 만들어진 피커라면 이미 같은 값이라 무해하다(멱등).
    bgPicker?.setSwatches(liveSwatches);
    bgPicker?.setColor(liveBackground);
  };

  const setWindowControls = (
    nextControls: readonly string[],
    nextState: NoteOptionState,
  ): void => {
    liveControls = nextControls;
    liveState = nextState; // 되살아나는 컨트롤이 옛 초기값이 아니라 이 값으로 만들어진다.
    syncBuiltinAvailability();
  };

  return {
    top,
    bottom,
    resync,
    placeItem,
    closeMenus,
    setCollapsedTitle,
    setBackgroundCapability,
    setWindowControls,
  };
}
