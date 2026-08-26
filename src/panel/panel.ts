/**
 * 노트 목록·검색 패널.
 *
 * 역할: 모든 노트를 제목으로 나열하고, 검색어로 제목·본문·생성일을 필터링하며, 항목 클릭/Enter 시
 * 해당 노트 창을 소환한다. IO(목록·검색·소환)는 주입받아 Tauri 없이 테스트 가능하게 한다.
 * 왜: 메뉴바 앱의 노트 탐색 진입점(트레이 "노트 목록·검색")을 담당한다.
 */
import { t } from "../i18n/t";
import { confirmDialog } from "../note/confirm-dialog";
import type { NoteSortFields, NoteSummary, SearchHit } from "../shared/tauri";

/** 패널이 필요로 하는 IO 의존성(테스트 시 주입). */
interface PanelDeps {
  listNotes(): Promise<NoteSummary[]>;
  searchNotes(query: string): Promise<SearchHit[]>;
  summon(id: string): void;
  /**
   * 소환 직전 노트가 실제로 있는지 확인한다(선택). 생략하면 항상 있다고 가정한다(기존 동작).
   *
   * 왜: 패널의 목록은 스냅샷이라 다른 창에서 방금 삭제한 노트가 [`onNotesChanged`] 신호가
   * 닿기 전(경쟁)에 여전히 목록에 남아 있을 수 있다. 그 항목을 클릭하면 백엔드
   * `summon_note`는 존재 확인 없이 빈 노트 창을 열어버린다(먹통) — 여기서 먼저 확인해
   * 그 창이 아예 뜨지 않게 막는다.
   */
  noteExists?(id: string): Promise<boolean>;
  /**
   * 노트를 영구 삭제한다(선택). 주어지면 각 항목에 호버 시 삭제 버튼을 그리고, 검색창 줄에
   * 다중 선택("선택") 토글 버튼도 그린다(생략하면 삭제 버튼도 다중 선택도 그리지 않는다 —
   * 기존 동작 보존). 다중 선택 모드의 "N개 삭제" 액션 바는 체크된 항목마다 이 함수를
   * 하나씩 호출한다(항목별 호출 — 실패한 항목은 모아서 한 번에 안내한다).
   */
  deleteNote?(id: string): Promise<void>;
  /**
   * 다른 창(노트 창·트레이)의 노트 생성/삭제/보관/저장 신호를 구독한다(선택). 주어지면
   * 패널이 그 신호를 받을 때마다 목록을 다시 읽어 그린다. 해제 함수를 돌려준다(패널은
   * 창 수명 동안 구독을 유지하므로 지금은 호출부가 해제하지 않는다).
   */
  onNotesChanged?(handler: () => void): () => void;
  searchDebounceMs?: number;
  /**
   * 새 노트를 만들고 그 창을 연다(선택). 주어지면 검색창 옆에 "+" 버튼을 그린다(생략하면
   * 버튼 자체를 그리지 않는다 — `deleteNote`와 같은 관례). 목록은 이 호출이 성공하면
   * 백엔드가 직접 내보내는 `notes-list-changed` 신호(`onNotesChanged` 구독)로 자동
   * 갱신된다 — 여기서 따로 다시 읽지 않는다.
   */
  createAndOpenNote?(): Promise<void>;
  /**
   * 설정 창을 연다(선택). 주어지면 검색창 줄에 설정(톱니) 버튼을 그린다(생략하면 버튼 자체를
   * 그리지 않는다 — `createAndOpenNote`와 같은 관례). 실패는 호출부가 흡수한다(콘솔 로그만
   * 남기고 무시 — 노트 툴바의 설정 버튼(`note-toolbar.ts`)과 같은 처리. 이 패널엔 토스트
   * 인프라가 없어 그보다 더 나은 안내를 줄 수 없다).
   */
  openSettings?(): Promise<void>;
  /**
   * 노트의 즐겨찾기를 켜고 끈다(선택). 주어지면 각 항목에 호버 시 드러나는 별 버튼을 그린다
   * (생략하면 버튼 자체를 그리지 않는다 — `deleteNote`와 같은 "IO 없으면 UI 없음" 관례).
   * 성공·실패 모두 목록을 다시 읽는다(성공하면 즐겨찾기 묶음이 즉시 위로 올라오고, 실패하면
   * "안 바뀌었음"이 그대로 반영된다 — `deleteNote`와 같은 결).
   */
  toggleFavorite?(id: string, favorite: boolean): Promise<void>;
  /**
   * 저장돼 있던 정렬 모드 문자열(선택). 생략하거나 어휘에 없는 값이면 기본값(추가순 최신)으로
   * 접는다 — 해석은 [`parsePanelSort`] 한 곳이 한다.
   */
  initialSort?: string;
  /**
   * 정렬 선택을 영속화한다(선택). **이 함수가 있을 때만** 상단 바에 정렬 드롭다운을 그린다
   * (`deleteNote`·`createAndOpenNote`와 같은 관례). 정렬 자체는 드롭다운이 없어도
   * [`initialSort`]대로 늘 적용된다 — 정렬은 순수 함수라 IO가 필요 없기 때문이다.
   * 실패는 호출부가 흡수한다(다음 변경에서 다시 시도된다).
   */
  saveSort?(mode: string): void;
}

/**
 * 정렬 모드 어휘. 값 문자열이 그대로 LocalConfig에 저장되므로(백엔드는 의미를 모르고 왕복만
 * 한다) 한 번 배포된 값은 바꾸지 않는다 — 바꾸면 기존 사용자의 선택이 조용히 기본값으로 접힌다.
 * 드롭다운의 표시 순서도 이 배열 순서다.
 */
const PANEL_SORT_MODES = [
  "created-desc",
  "created-asc",
  "updated-desc",
  "title-asc",
  "chars-desc",
  "opened-desc",
] as const;

/** [`PANEL_SORT_MODES`]의 값 하나. */
type PanelSortMode = (typeof PANEL_SORT_MODES)[number];

/** 기본 정렬 — 백엔드 `LocalConfig.panel_sort`의 기본값과 **같은 문자열**이어야 한다. */
const DEFAULT_PANEL_SORT: PanelSortMode = "created-desc";

/**
 * 저장된 문자열을 정렬 모드로 해석한다(모르는 값·빈 값·null은 기본값).
 *
 * 왜 프론트가 검증하나: 백엔드는 이 문자열의 의미를 모른 채 왕복만 한다(빈 값·과도한 길이만
 * 거부). 구버전에서 쓰던 값이나 손으로 고친 config가 들어와도 화면이 깨지지 않도록 어휘
 * 판정을 여기 한 곳에 모은다.
 */
export function parsePanelSort(raw: string | null | undefined): PanelSortMode {
  return PANEL_SORT_MODES.includes(raw as PanelSortMode)
    ? (raw as PanelSortMode)
    : DEFAULT_PANEL_SORT;
}

/**
 * 삭제 버튼 아이콘(모듈 내부 전용 신뢰 마크업) — 노트 툴바의 휴지통 라인 아이콘과 같은
 * 모양을 독립적으로 둔다(노트 툴바 모듈을 import하지 않음 — 그쪽은 다른 작업이 진행 중).
 */
const TRASH_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

/**
 * "+"(새 노트) 버튼 아이콘(모듈 내부 전용 신뢰 마크업) — 삭제 버튼 아이콘과 같은 결의
 * 독립 SVG(노트 툴바 모듈을 import하지 않는 이유도 같다).
 */
const PLUS_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>';

/**
 * 설정 버튼 아이콘(모듈 내부 전용 신뢰 마크업) — 노트 툴바(`note-toolbar.ts`)의 설정 버튼과
 * 같은 톱니바퀴 글리프를 독립적으로 둔다(그 모듈을 import하지 않는 이유는 삭제·추가 아이콘과
 * 같다: 노트 툴바 모듈은 다른 작업이 진행 중이다).
 */
const SETTINGS_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

/**
 * 다중 선택 모드 토글 버튼 아이콘(모듈 내부 전용 신뢰 마크업) — 체크된 사각형으로 "여러 항목
 * 선택"을 나타낸다. 눌린 상태는 `aria-pressed`로 반영하고(스타일만 바뀜, 아이콘은 고정)
 * `note-toolbar.ts`의 토글 버튼 관례(`[aria-pressed="true"]`)를 그대로 따른다.
 */
const SELECT_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/></svg>';

/**
 * 즐겨찾기 토글 버튼의 별 아이콘(모듈 내부 전용 신뢰 마크업) — 위 아이콘들과 같은 결의
 * 독립 SVG다(`note-toolbar.ts`를 import하지 않는 이유도 같다).
 *
 * **왜 핀이 아니라 별인가**: 노트 툴바에는 이미 핀 글리프가 있고 그건 전혀 다른 개념(창을
 * 항상 위에 두는 `NoteOverrides.pinned`)이다. 같은 앱 안에서 같은 모양이 두 가지를 뜻하면
 * 사용자는 목록의 핀을 "이 창을 항상 위로"로 읽는다 — 즐겨찾기의 관용 글리프인 별로 갈라
 * 그 충돌을 없앤다.
 *
 * 켜진 항목은 [`STAR_FILLED_ICON_SVG`]로 속을 채워 호버 없이도 한눈에 구분되게 한다
 * (외곽선/채움 두 벌은 body가 같고 `fill`만 다르다).
 */
const STAR_ICON_BODY =
  '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';

const STAR_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STAR_ICON_BODY}</svg>`;

const STAR_FILLED_ICON_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STAR_ICON_BODY}</svg>`;

/** [`onNotesChanged`] 신호를 모아 찍는 디바운스(ms) — 여러 창의 자동저장이 몰릴 때 목록을 매번 다시 읽지 않게 한다. */
const NOTES_CHANGED_DEBOUNCE_MS = 300;

/**
 * 목록 항목(제목 + 선택적 미리보기 + 생성 시각 + 정렬용 메타). NoteSummary·SearchHit 둘 다
 * 그대로 수용한다 — 그래서 필드 이름은 IPC와 같은 snake_case다(변환 단계를 두지 않는다).
 */
interface ListEntry extends NoteSortFields {
  id: string;
  title: string;
  snippet?: string;
  /** 생성 시각(에폭 ms). 있으면 제목 옆에 생성일을 작게 표기. */
  created_at?: number;
}

/**
 * 생성 시각 접근자 — 정렬 키 중 유일하게 기본값이 필요하다.
 *
 * 나머지 세 키(`content_updated_at`·`char_count`·`opened_at`)는 타입상 필수라 그대로 읽지만,
 * `created_at`은 [`ListEntry`]에서 여전히 옵셔널이다: `renderList`는 생성일을 모르는 항목도
 * 그릴 수 있어야 한다(그때 날짜만 빼고 그린다). 정렬에서는 "모르면 가장 오래된 것"으로 본다.
 */
const createdOf = (e: ListEntry): number => e.created_at ?? 0;

/** 마지막 tie-break: id 오름차순 — 같은 입력이면 언제나 같은 순서가 되게 못 박는다. */
function byId(a: ListEntry, b: ListEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 생성 시각 내림 → id 오름. 추가순 이외 모드가 공유하는 tie-break. */
function byCreatedThenId(a: ListEntry, b: ListEntry): number {
  return createdOf(b) - createdOf(a) || byId(a, b);
}

/** "최근 연 순"의 주 비교 — 내림차순이되 한 번도 연 적 없는(null) 노트는 언제나 맨 뒤. */
function byOpenedDesc(a: ListEntry, b: ListEntry): number {
  const x = a.opened_at;
  const y = b.opened_at;
  if (x === null || y === null) {
    if (x === y) return 0;
    return x === null ? 1 : -1;
  }
  return y - x;
}

/** 모드별 비교 함수(주 키 → tie-break). 각 함수는 전순서라 정렬 결과가 유일하게 정해진다. */
const SORT_COMPARATORS: Record<
  PanelSortMode,
  (a: ListEntry, b: ListEntry) => number
> = {
  "created-desc": (a, b) => createdOf(b) - createdOf(a) || byId(a, b),
  "created-asc": (a, b) => createdOf(a) - createdOf(b) || byId(a, b),
  "updated-desc": (a, b) =>
    b.content_updated_at - a.content_updated_at || byCreatedThenId(a, b),
  // 이름순은 숫자를 자연스럽게(2 < 10) 읽고 대소문자·악센트 차이를 무시한다 — 사람이 훑는
  // 목록이라 "Note 10"이 "Note 2"보다 뒤에 오는 사전순 결과가 오히려 어긋나 보인다.
  "title-asc": (a, b) =>
    a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || byCreatedThenId(a, b),
  "chars-desc": (a, b) => b.char_count - a.char_count || byCreatedThenId(a, b),
  "opened-desc": (a, b) => byOpenedDesc(a, b) || byCreatedThenId(a, b),
};

/**
 * 목록을 정렬 모드대로 다시 늘어놓는다(순수 함수 — 입력 배열을 건드리지 않는다).
 *
 * 최종 순서는 `[즐겨찾기 묶음] ++ [나머지]`이고, 각 묶음 안에서 모드별 비교가 적용된다.
 * 즐겨찾기는 **현재 화면에 있는 목록 안에서의 순서만** 바꾼다 — 검색 결과를 넓히지도,
 * 필터를 이기지도 않는다. 모르는 모드는 [`parsePanelSort`]가 기본값으로 접는다.
 */
export function sortEntries(
  items: readonly ListEntry[],
  mode: string | null | undefined,
): ListEntry[] {
  const compare = SORT_COMPARATORS[parsePanelSort(mode)];
  const favorites: ListEntry[] = [];
  const rest: ListEntry[] = [];
  for (const item of items) {
    (item.favorite === true ? favorites : rest).push(item);
  }
  // 두 배열 모두 이 함수가 방금 만든 것이라 sort의 제자리 정렬이 입력을 오염시키지 않는다.
  return [...favorites.sort(compare), ...rest.sort(compare)];
}

/**
 * 에폭 ms를 YYYY.MM.DD로 짧게 표기(로컬 시간대 기준).
 *
 * 왜: 앱에 공용 날짜 유틸이 없어(템플릿 플러그인은 샌드박스 내부 전용) 패널이 자체로
 * 가벼운 포매터를 둔다. Intl 대신 수동 포맷으로 앱의 기존 날짜 표기(Y-MM-DD/Y.MM.DD)와 결을 맞춘다.
 */
function formatCreatedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/**
 * 질의어를 "날짜 검색용 조각"으로 정규화한다(아니면 null).
 *
 * 역할: `.`·`-`·`/`·공백으로 나뉜 숫자 그룹만 날짜로 보고, 각 그룹을 2자리 이상으로 맞춰
 * 표시 포맷(YYYY.MM.DD)과 자리수를 정렬한 needle을 만든다. 예: `2026.7`→`2026.07`, `7.23`→`07.23`.
 * 왜: 단독 숫자(`7`,`23`)는 오탐이 많아 날짜로 보지 않는다 — 구분자로 2개 이상이거나 4자리 연도
 * 단독일 때만 날짜 질의로 인정한다.
 */
function toDateNeedle(query: string): string | null {
  const parts = query
    .trim()
    .split(/[.\-/\s]+/)
    .filter((p) => p !== "");
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const isDateLike =
    parts.length >= 2 || (parts.length === 1 && parts[0].length === 4);
  if (!isDateLike) return null;
  return parts.map((p) => p.padStart(2, "0")).join(".");
}

/** 질의어가 날짜 검색으로 볼 만한 형태인지(연/연.월/연.월.일/월.일 등). */
function isDateQuery(query: string): boolean {
  return toDateNeedle(query) !== null;
}

/**
 * 질의어(날짜꼴)가 이 노트의 생성일(로컬)과 맞는지 본다.
 *
 * 역할: 표시용 생성일 문자열(YYYY.MM.DD)에 대해 정규화한 날짜 조각을 substring으로 매칭한다.
 * 왜: "보이는 날짜"와 같은 로컬 포맷을 재사용해 표시·검색을 하루도 어긋나지 않게 한다.
 */
export function matchesDateQuery(query: string, createdAtMs: number): boolean {
  if (createdAtMs <= 0) return false;
  const needle = toDateNeedle(query);
  return needle !== null && formatCreatedAt(createdAtMs).includes(needle);
}

/**
 * 텍스트 검색 결과(Rust)와 생성일 검색 결과를 합쳐 목록 항목을 만든다.
 *
 * 역할: 텍스트 매치를 앞에, 생성일로만 매치된 노트를 뒤에 이어 붙이고 id 중복은 제거한다.
 * 왜: 한 검색창에서 제목·본문·생성일을 함께 찾게 한다(검색에 날짜 검색 추가).
 */
export function mergeSearchResults(
  textHits: SearchHit[],
  allNotes: NoteSummary[],
  query: string,
): ListEntry[] {
  const seen = new Set(textHits.map((h) => h.id));
  const dateHits = allNotes.filter(
    (n) => !seen.has(n.id) && matchesDateQuery(query, n.created_at),
  );
  return [...textHits, ...dateHits];
}

/**
 * 다중 선택 모드에서 [`renderList`]가 각 항목에 체크박스를 그리는 데 필요한 상태·콜백.
 *
 * 주어지면(즉 다중 선택 모드 중이면) 행 클릭/Enter도 소환 대신 체크 토글로 바뀐다 — 선택
 * 모드에서는 실수로 노트를 여는 대신 체크가 먼저다. `onDelete`는 이때 호출부가 `undefined`로
 * 넘겨 개별 삭제 버튼을 함께 그리지 않는다(선택 모드는 일괄 삭제 액션 바가 담당 — 두 삭제
 * 경로가 한 화면에 겹치면 "지금 뭘 지우는 중인가"가 헷갈린다).
 */
interface SelectionState {
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
}

/**
 * 목록 DOM을 항목으로 다시 그린다(클릭/Enter = 소환, 단 `selection`이 있으면 체크 토글).
 * 비면 안내 문구를 보인다.
 *
 * 역할: 렌더를 순수 함수로 분리해 가드 테스트가 가능하게 한다. `onToggleFavorite`을 주면
 * 타이틀 **앞**(체크박스 다음, 행의 맨 앞 쪽)에 즐겨찾기(별) 버튼을 그린다(뒤집힌 값을
 * 넘긴다 — 호출부가 "무엇으로 바꿀지"를 그대로 IPC에 실을 수 있도록) — 오른쪽 끝의 삭제
 * 버튼과 멀리 떨어뜨려 실수로 삭제를 누르는 것을 막는다. `onDelete`를 주면 각 항목 맨
 * 끝(오른쪽)에 호버 시 드러나는 삭제 버튼을 함께 그린다(id·title을 넘긴다 — 호출부가 확인
 * 문구에 제목을 쓸 수 있도록). `selection`을 주면 각 항목 맨 앞에 체크박스를 그린다(다중
 * 선택 모드). 항목 안의 버튼·체크박스 클릭은 `onSummon`/체크 토글(행 클릭)로 번지지 않게
 * 막는다.
 */
export function renderList(
  listEl: HTMLElement,
  items: ListEntry[],
  onSummon: (id: string) => void,
  onDelete?: (id: string, title: string) => void,
  selection?: SelectionState,
  onToggleFavorite?: (id: string, favorite: boolean) => void,
): void {
  listEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent = t("panel.list.empty");
    listEl.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "panel-item";
    li.tabIndex = 0;
    // 어느 노트의 행인지 DOM에 남긴다 — 재렌더로 순서가 바뀌어도 포커스를 "같은 노트"로
    // 되돌릴 수 있는 유일한 단서다(mountPanel의 captureFocusTarget/restoreFocusTarget).
    li.dataset.noteId = item.id;

    // 제목 + 생성일을 한 줄(헤더)에 두어 항목을 컴팩트하게 유지한다(제목 좌·날짜 우).
    const head = document.createElement("div");
    head.className = "panel-item-head";

    // 다중 선택 모드 체크박스(선택) — 맨 앞에 둬 제목보다 먼저 눈에 띄게 한다.
    let checked = false;
    if (selection) {
      checked = selection.selectedIds.has(item.id);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "panel-item-checkbox";
      checkbox.checked = checked;
      checkbox.setAttribute(
        "aria-label",
        t("panel.item.select-label", { title: item.title }),
      );
      checkbox.addEventListener("click", (event) => {
        // 행 클릭(체크 토글)으로 번지지 않게 막고, 토글은 여기서 직접 부른다 — 네이티브
        // change 이벤트에 기대지 않는다(document에 붙지 않은 트리에선 change가 뜨지
        // 않는 환경이 있다 — 테스트가 host를 document에 붙이지 않는 것과 같은 조건이라
        // 삭제 버튼처럼 click에서 직접 호출하는 편이 안전하다).
        event.stopPropagation();
        selection.onToggleSelect(item.id);
      });
      checkbox.addEventListener("keydown", (event) => {
        // 삭제 버튼과 같은 이유: 포커스된 채 Enter/Space를 누르면 keydown이 li까지
        // 버블링해 행의 Enter 핸들러가 먼저 실행되는 것을 막는다.
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
        }
      });
      head.append(checkbox);
    }

    // 즐겨찾기(별) 토글(선택) — 타이틀보다 앞(행의 맨 앞, 다중 선택 체크박스 다음)에 둬
    // 삭제 버튼(오른쪽 액션)과 멀리 떨어뜨린다: 오른쪽 끝에 나란히 있으면 삭제를 누르려다
    // 실수로 별을 누르거나(혹은 그 반대) 하기 쉬웠다. 삭제 버튼과 같은 hover-reveal이지만,
    // 켜진 항목은 CSS가 aria-pressed="true"를 보고 호버 없이도 계속 보여준다("어느 노트가
    // 즐겨찾기인가"는 호버해야 알 수 있는 것이 아니라 목록이 전하는 정보 자체다). 삭제
    // 버튼과 마찬가지로 다중 선택 모드 중엔 호출부가 undefined를 넘겨 그리지 않는다 —
    // 실제로는 selection과 onToggleFavorite가 동시에 주어지지 않으므로(draw() 참고) 이
    // 체크박스와 별이 한 행에 같이 그려질 일은 없다.
    if (onToggleFavorite) {
      const on = item.favorite === true;
      const fav = document.createElement("button");
      fav.type = "button";
      fav.className = "panel-item-favorite";
      const favLabel = t(
        on ? "panel.item.unfavorite-label" : "panel.item.favorite-label",
      );
      fav.title = favLabel;
      fav.setAttribute("aria-label", favLabel);
      fav.setAttribute("aria-pressed", String(on));
      fav.innerHTML = on ? STAR_FILLED_ICON_SVG : STAR_ICON_SVG;
      fav.addEventListener("click", (event) => {
        event.stopPropagation(); // 행 클릭(소환)으로 번지지 않게.
        onToggleFavorite(item.id, !on);
      });
      fav.addEventListener("keydown", (event) => {
        // 삭제 버튼과 같은 이유(포커스된 버튼의 Enter/Space가 행 핸들러까지 버블링해
        // 소환과 토글이 함께 일어나는 이중 동작 방지).
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
        }
      });
      head.append(fav);
    }

    const title = document.createElement("div");
    title.className = "panel-item-title";
    title.textContent = item.title;
    head.append(title);

    // created_at이 유효할 때만(0/누락 메타로 인한 1970 표기 방지) 생성일을 작게 붙인다.
    if (typeof item.created_at === "number" && item.created_at > 0) {
      const date = document.createElement("span");
      date.className = "panel-item-date";
      date.textContent = formatCreatedAt(item.created_at);
      head.append(date);
    }

    // 개별 삭제 버튼(선택) — 평소엔 숨겨져 있다가 항목 호버·포커스 시 CSS로 드러난다.
    // 다중 선택 모드 중엔 호출부가 onDelete를 undefined로 넘겨 그리지 않는다.
    if (onDelete) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "panel-item-delete";
      del.title = t("panel.item.delete-label");
      del.setAttribute("aria-label", t("panel.item.delete-label"));
      del.innerHTML = TRASH_ICON_SVG;
      del.addEventListener("click", (event) => {
        event.stopPropagation(); // 행 클릭(소환)으로 번지지 않게.
        onDelete(item.id, item.title);
      });
      del.addEventListener("keydown", (event) => {
        // 버튼에 포커스된 채 Enter/Space를 누르면 keydown이 li까지 버블링해
        // 행의 Enter 핸들러(summon)가 먼저 실행된 뒤 브라우저 기본 동작으로
        // 버튼의 click(=onDelete)도 실행되는 이중 동작을 막는다.
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
        }
      });
      head.append(del);
    }

    li.append(head);

    if (item.snippet) {
      const snippet = document.createElement("div");
      snippet.className = "panel-item-snippet";
      snippet.textContent = item.snippet;
      li.append(snippet);
    }

    if (selection) {
      li.classList.toggle("panel-item-selected", checked);
      li.setAttribute("aria-selected", String(checked));
    }

    // 다중 선택 모드에서는 행 클릭/Enter가 소환 대신 체크 토글이다(실수로 노트가 열리는
    // 것을 막는다 — 선택 모드의 목적 자체가 "아직 열지 않고 고르기"이므로).
    const activate = selection
      ? () => selection.onToggleSelect(item.id)
      : () => onSummon(item.id);
    li.addEventListener("click", activate);
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter") activate();
    });
    listEl.append(li);
  }
}

/**
 * 패널을 host에 마운트한다: 검색창 + 목록. 초기엔 전체 목록, 입력 시 디바운스 후 검색
 * (빈 검색어면 다시 전체 목록). 검색어가 날짜꼴이면 텍스트 매치에 생성일 매치를 합친다.
 */
export async function mountPanel(
  host: HTMLElement,
  deps: PanelDeps,
): Promise<void> {
  // 현재 정렬 모드 — 마운트당 하나. 드롭다운(saveSort가 있을 때만 그린다)이 없어도 정렬은
  // 늘 이 값으로 적용된다(생략 시 기본값). 저장된 값의 어휘 판정은 parsePanelSort 한 곳.
  let sortMode = parsePanelSort(deps.initialSort);

  // 검색 필드 + "+"(새 노트) 버튼을 한 줄에 두는 바깥 래퍼(베타 피드백 — 패널에서도 노트 추가).
  const topBar = document.createElement("div");
  topBar.className = "panel-top-bar";

  // 검색 input을 아이콘과 함께 필드형 래퍼로 감싼다(맨몸 밑줄 대신 노트 크롬과 어울리는 필드).
  const searchWrap = document.createElement("div");
  searchWrap.className = "panel-search-wrap";

  const searchIcon = document.createElement("span");
  searchIcon.className = "panel-search-icon";
  searchIcon.textContent = "🔍";
  searchIcon.setAttribute("aria-hidden", "true");

  const search = document.createElement("input");
  search.type = "search";
  search.className = "panel-search";
  // 날짜 검색 지원을 살짝 알리는 placeholder(예: 2026.07).
  search.placeholder = t("panel.search.placeholder");

  searchWrap.append(searchIcon, search);
  topBar.append(searchWrap);

  // deps.createAndOpenNote가 없으면 버튼 자체를 그리지 않는다(onDelete와 같은 관례).
  if (deps.createAndOpenNote) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "panel-add-btn";
    addBtn.innerHTML = PLUS_ICON_SVG;
    addBtn.title = t("panel.add.label");
    addBtn.setAttribute("aria-label", t("panel.add.label"));
    addBtn.addEventListener("click", () => {
      addBtn.disabled = true;
      void deps.createAndOpenNote!()
        .catch(() =>
          confirmDialog(host, t("panel.add.failed"), t("note.confirm.ok"), {
            alert: true,
          }),
        )
        .then(() => {
          addBtn.disabled = false;
        });
    });
    topBar.append(addBtn);
  }

  // 다중 선택 모드 토글 버튼(베타 피드백 — 검색에서 여러 노트를 한 번에 지우기).
  // deps.deleteNote가 없으면 그릴 이유가 없다(선택 모드의 유일한 용도가 일괄 삭제라서) —
  // onDelete·addBtn과 같은 "IO 없으면 버튼 없음" 관례.
  let selectToggleBtn: HTMLButtonElement | undefined;
  if (deps.deleteNote) {
    selectToggleBtn = document.createElement("button");
    selectToggleBtn.type = "button";
    selectToggleBtn.className = "panel-select-toggle";
    selectToggleBtn.innerHTML = SELECT_ICON_SVG;
    selectToggleBtn.setAttribute("aria-pressed", "false");
    selectToggleBtn.addEventListener("click", () => {
      setSelectMode(!selectMode);
    });
    topBar.append(selectToggleBtn);
  }

  // 설정 버튼(베타 피드백 — 패널에서 바로 설정 창 열기). deps.openSettings가 없으면 그리지
  // 않는다(createAndOpenNote와 같은 관례).
  if (deps.openSettings) {
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "panel-settings-btn";
    settingsBtn.innerHTML = SETTINGS_ICON_SVG;
    settingsBtn.title = t("panel.settings.label");
    settingsBtn.setAttribute("aria-label", t("panel.settings.label"));
    settingsBtn.addEventListener("click", () => {
      // 노트 툴바의 설정 버튼과 같은 처리: 실패해도 이 패널엔 토스트 인프라가 없어 콘솔
      // 로그만 남기고 흡수한다(창을 못 여는 사소한 실패로 패널 전체를 방해하지 않는다).
      void deps.openSettings!().catch((err: unknown) => {
        console.error("[panel] openSettings failed", err);
      });
    });
    topBar.append(settingsBtn);
  }

  // 정렬 드롭다운 — deps.saveSort가 없으면 그리지 않는다(선택을 어디에도 남길 수 없는
  // 드롭다운은 다음 실행에 사라지는 반쪽 기능이다 — "IO 없으면 UI 없음" 관례).
  //
  // 왜 아이콘 버튼들보다 **뒤**에 두는가: 이 select만 텍스트 폭(가장 긴 라벨 "글자수 많은 순")을
  // 요구한다. 패널 기본 폭은 320px이라 검색창 + 아이콘 3개와 한 줄에 다 넣으면 검색창이
  // 짓눌린다 — 상단 바를 wrap 시키고(styles.css) 마지막 항목인 이 select만 좁을 때 다음
  // 줄로 내려가게 한다. 넓힌 창에서는 예정대로 아이콘 버튼들과 같은 줄·같은 높이(30px)다.
  if (deps.saveSort) {
    const sortSelect = document.createElement("select");
    sortSelect.className = "panel-sort-select";
    const sortLabel = t("panel.sort.label");
    sortSelect.title = sortLabel;
    sortSelect.setAttribute("aria-label", sortLabel);
    for (const mode of PANEL_SORT_MODES) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = t(`panel.sort.${mode}`);
      sortSelect.append(option);
    }
    sortSelect.value = sortMode;
    sortSelect.addEventListener("change", () => {
      sortMode = parsePanelSort(sortSelect.value);
      deps.saveSort!(sortMode);
      // 목록을 다시 읽지 않는다 — 정렬은 순수 함수라 지금 화면에 있는 항목만 다시 늘어놓으면
      // 된다(같은 검색 결과에 IPC 왕복을 한 번 더 걸 이유가 없다).
      currentItems = sortEntries(currentItems, sortMode);
      draw();
    });
    topBar.append(sortSelect);
  }

  // 다중 선택 모드에서 하나 이상 체크되면 나타나는 일괄 삭제 액션 바(top-bar 바로 아래,
  // 스크롤되는 목록 밖에 둬 스크롤해도 계속 보이게 한다).
  const bulkBar = document.createElement("div");
  bulkBar.className = "panel-bulk-bar";
  bulkBar.hidden = true;

  const bulkDeleteBtn = document.createElement("button");
  bulkDeleteBtn.type = "button";
  bulkDeleteBtn.className = "panel-bulk-delete";
  bulkDeleteBtn.addEventListener("click", () => requestBulkDelete());
  bulkBar.append(bulkDeleteBtn);

  const list = document.createElement("ul");
  list.className = "panel-list";

  host.append(topBar, bulkBar, list);

  // deps.deleteNote가 없으면 renderList에 onDelete 자체를 넘기지 않는다 — 버튼을 아예
  // 그리지 않아 기존(삭제 미지원) 동작을 그대로 보존한다.
  const onDelete = deps.deleteNote ? requestDelete : undefined;
  // 즐겨찾기도 같은 관례 — deps.toggleFavorite가 없으면 별 버튼을 그리지 않는다.
  const onToggleFavorite = deps.toggleFavorite
    ? requestToggleFavorite
    : undefined;

  // 다중 선택 모드 상태 — 마운트당 하나(패널 창은 한 번에 하나의 목록만 보여준다).
  // selectedIds는 renderList가 그리는 항목의 id 부분집합이다: 검색·리로드로 화면에서
  // 사라진 항목의 id가 남아 있어도(다른 검색어로 필터링돼 안 보이는 경우) 해가 없다 —
  // 실존 여부는 [`pruneMissingSelections`]가 별도로 정리한다(검색어 변경만으로 선택이
  // 풀리면 "검색해 가며 여러 개 고르기" 워크플로가 깨진다).
  let selectMode = false;
  const selectedIds = new Set<string>();
  let currentItems: ListEntry[] = [];

  /** 선택 모드 on/off를 전환한다. off로 나가면 선택을 비운다(다음 진입은 항상 빈 상태). */
  function setSelectMode(next: boolean): void {
    selectMode = next;
    if (!selectMode) selectedIds.clear();
    if (selectToggleBtn) {
      selectToggleBtn.setAttribute("aria-pressed", String(selectMode));
      const label = t(
        selectMode ? "panel.select.cancel-label" : "panel.select.label",
      );
      selectToggleBtn.title = label;
      selectToggleBtn.setAttribute("aria-label", label);
    }
    draw();
  }

  /** 항목 하나의 체크를 토글한다(체크박스 click·행 클릭/Enter 공용). */
  function toggleSelect(id: string): void {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    draw();
  }

  /** [`captureFocusTarget`]/[`restoreFocusTarget`]이 주고받는, 포커스가 있던 항목의 위치. */
  type FocusTarget = { id: string; part: "checkbox" | "favorite" | "row" };

  /**
   * 재렌더 직전 포커스가 목록 항목(체크박스 또는 행) 안에 있으면 그 항목의 id와 어느 부분이
   * 포커스였는지를 기억한다.
   *
   * 왜: `renderList`는 매번 `listEl.replaceChildren()`으로 모든 `<li>`·체크박스 DOM을 통째로
   * 새로 만드는 순수 함수라(가상 DOM diff 없음), 다중 선택 모드에서 체크박스를 Tab→Space로
   * 토글할 때마다(=`toggleSelect` → `draw`) 포커스된 노드가 매번 통째로 사라진다. 브라우저
   * 표준 동작상 포커스된 노드가 DOM에서 제거되면 포커스는 body로 튄다 — 연속 토글마다 포커스가
   * 날아가 항목 M개를 키보드만으로 고르려면 매번 검색창부터 다시 Tab해야 하는 회귀였다.
   * `renderList` 자체를 diff 렌더러로 바꾸는 대신(순수 함수 계약을 지키고 기존 테스트를
   * 건드리지 않기 위해) 여기서 앞뒤로 감싸 포커스만 복원한다.
   */
  function captureFocusTarget(): FocusTarget | undefined {
    const active = document.activeElement;
    if (!active) return undefined;
    const li = active.closest<HTMLElement>(".panel-item");
    if (!li || !list.contains(li)) return undefined;
    // **DOM 인덱스를 쓰지 않는다.** `load()`는 새로 정렬한 배열을 `currentItems`에 먼저
    // 대입한 뒤 `draw()`를 부르므로, 이 시점의 "옛 DOM 인덱스"를 이미 갱신된 배열에 대보면
    // 엉뚱한 노트가 나온다(즐겨찾기 토글처럼 순서가 바뀌는 재렌더에서 실제로 그랬다 —
    // 포커스가 건드리지 않은 이웃 행으로 옮겨가 그대로 Enter를 누르면 그 노트가 열렸다).
    const id = li.dataset.noteId;
    if (id === undefined) return undefined;
    const part = active.classList.contains("panel-item-checkbox")
      ? "checkbox"
      : active.classList.contains("panel-item-favorite")
        ? "favorite"
        : "row";
    return { id, part };
  }

  /** [`captureFocusTarget`]이 잡아둔 항목이 재렌더 후에도 있으면 같은 부분에 포커스를 되돌린다. */
  function restoreFocusTarget(target: FocusTarget | undefined): void {
    if (!target) return;
    const li = Array.from(list.children).find(
      (el) => el instanceof HTMLElement && el.dataset.noteId === target.id,
    ) as HTMLElement | undefined;
    if (!li) return; // 그 노트가 목록에서 사라졌다(삭제·검색 변경) — 되돌릴 자리가 없다.
    const selector =
      target.part === "checkbox"
        ? ".panel-item-checkbox"
        : ".panel-item-favorite";
    const el =
      target.part === "row" ? li : li.querySelector<HTMLElement>(selector);
    // 그 부분이 이번 렌더에 없으면(선택 모드 진입으로 버튼이 사라지는 등) 행으로 물러선다 —
    // 포커스가 body로 튀어 다음 Tab이 검색창부터 다시 시작하는 것보다 낫다.
    (el ?? li).focus();
  }

  /** 현재 상태(currentItems·selectMode·selectedIds)로 목록·액션 바를 다시 그린다(IO 없음). */
  function draw(): void {
    const focusTarget = captureFocusTarget();
    renderList(
      list,
      currentItems,
      summonSafely,
      selectMode ? undefined : onDelete, // 선택 모드 중엔 개별 삭제 버튼을 감춘다(경로 하나로).
      selectMode ? { selectedIds, onToggleSelect: toggleSelect } : undefined,
      // 선택 모드 중엔 즐겨찾기 버튼도 감춘다 — 그 화면의 유일한 동작은 "고르기"다.
      selectMode ? undefined : onToggleFavorite,
    );
    restoreFocusTarget(focusTarget);
    const count = selectedIds.size;
    bulkBar.hidden = !(selectMode && count > 0);
    if (!bulkBar.hidden) {
      bulkDeleteBtn.textContent = t("panel.bulk.delete-label", { count });
    }
  }

  /**
   * 소환 직전 노트 존재를 확인한다(주어졌으면). 다른 창에서 방금 삭제한 노트를 이 패널이
   * 아직 모르고 있을 때(리로드 신호 도착 전 경쟁) 빈 노트 창이 뜨는 먹통을 막는다 — 없으면
   * 안내 후 목록을 다시 읽어 그 항목을 지운다.
   */
  function summonSafely(id: string): void {
    const exists = deps.noteExists
      ? deps.noteExists(id)
      : Promise.resolve(true);
    void exists.then((ok) => {
      if (ok) {
        deps.summon(id);
        return;
      }
      void confirmDialog(host, t("panel.item.missing"), t("note.confirm.ok"), {
        alert: true,
      }).then(() => load());
    });
  }

  /** 확인 → 삭제 → 목록 갱신(성공·실패 모두 다시 읽는다 — 실패면 "삭제 안 됨"이 반영된다). */
  function requestDelete(id: string, title: string): void {
    void confirmDialog(
      host,
      t("panel.item.delete-confirm", { title }),
      t("panel.item.delete-confirm-label"),
    ).then((ok) => {
      if (!ok) return;
      void deps.deleteNote!(id)
        .catch(() =>
          confirmDialog(
            host,
            t("panel.item.delete-failed"),
            t("note.confirm.ok"),
            {
              alert: true,
            },
          ),
        )
        .then(() => load());
    });
  }

  /**
   * 즐겨찾기를 뒤집고 목록을 다시 읽는다(확인 다이얼로그 없음 — 되돌리기가 같은 버튼 한 번인
   * 무해한 토글이다). 성공·실패 모두 다시 읽는 것은 [`requestDelete`]와 같은 이유다: 성공이면
   * 즐겨찾기 묶음이 즉시 위로 올라오고, 실패면 "안 바뀌었음"이 화면에 그대로 반영된다.
   *
   * 다시 읽기를 [`onNotesChanged`] 신호에 맡기지 않는 이유: 그 경로는 300ms 디바운스를 거쳐
   * 버튼을 누른 손이 체감할 만큼 늦다(삭제도 같은 이유로 여기서 직접 읽는다).
   */
  function requestToggleFavorite(id: string, favorite: boolean): void {
    void deps.toggleFavorite!(id, favorite)
      .catch(() =>
        confirmDialog(
          host,
          t("panel.item.favorite-failed"),
          t("note.confirm.ok"),
          { alert: true },
        ),
      )
      .then(() => load());
  }

  /**
   * 확인 → 체크된 항목 모두 삭제 → 목록 갱신. `deleteNote`를 항목별로 호출하고(순서는
   * 안 따진다 — allSettled로 동시에 보낸다) 성공한 id만 선택에서 뺀다. 실패가 하나라도
   * 있으면 몇 개인지 모아서 한 번에 안내한 뒤(실패한 항목의 개별 사유까지는 보여줄 자리가
   * 없어 개수만 — panel.item.delete-failed의 단건 안내와 같은 결) 목록을 다시 읽는다.
   * 성공한 항목은 [`load`]가 새로 읽어온 목록에 더는 없으니(체크박스 자체가 안 그려진다)
   * 실패한(여전히 존재하는) 항목만 계속 체크된 채로 남는다 — 별도 정리 없이 자연히 맞다.
   */
  function requestBulkDelete(): void {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    void confirmDialog(
      host,
      t("panel.bulk.delete-confirm", { count: ids.length }),
      t("panel.item.delete-confirm-label"),
    ).then((ok) => {
      if (!ok) return;
      void Promise.allSettled(ids.map((id) => deps.deleteNote!(id))).then(
        (results) => {
          ids.forEach((id, i) => {
            if (results[i].status === "fulfilled") selectedIds.delete(id);
          });
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed > 0) {
            return confirmDialog(
              host,
              t("panel.bulk.delete-failed", { count: failed }),
              t("note.confirm.ok"),
              { alert: true },
            ).then(() => load());
          }
          return load();
        },
      );
    });
  }

  /**
   * 선택 모드일 때만, 체크된 id 중 실제로 사라진(다른 창 등에서 삭제된) 것을 골라 뺀다.
   * `load()`는 현재 검색어에 맞는 부분집합만 다시 그리므로(검색 중이면 선택된 항목이 그
   * 검색에 안 걸려 화면에 없을 수 있다 — 그 자체는 삭제가 아니다) 존재 여부는 항상
   * `listNotes()`(필터 없는 전체 목록)로 따로 확인한다.
   */
  async function pruneMissingSelections(): Promise<void> {
    if (!selectMode || selectedIds.size === 0) return;
    const all = await deps.listNotes();
    const present = new Set(all.map((n) => n.id));
    let changed = false;
    for (const id of Array.from(selectedIds)) {
      if (!present.has(id)) {
        selectedIds.delete(id);
        changed = true;
      }
    }
    if (changed) draw();
  }

  /**
   * 검색창 상태에 맞춰 목록을 (다시) 읽어 그린다 — 초기 마운트·입력 디바운스·외부 변경 신호가 공유.
   * 정렬은 읽어온 결과에 **항상** 마지막으로 한 번 적용한다(검색 중에도 같은 규칙이 걸린다).
   */
  async function load(): Promise<void> {
    const query = search.value.trim();
    let entries: ListEntry[];
    if (query === "") {
      entries = await deps.listNotes();
    } else if (isDateQuery(query)) {
      // 날짜 질의: 텍스트 매치(Rust)와 생성일 매치(전체 목록)를 합쳐 보인다.
      const [textHits, allNotes] = await Promise.all([
        deps.searchNotes(query),
        deps.listNotes(),
      ]);
      entries = mergeSearchResults(textHits, allNotes, query);
    } else {
      entries = await deps.searchNotes(query);
    }
    currentItems = sortEntries(entries, sortMode);
    draw();
  }

  await load();

  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void load(), deps.searchDebounceMs ?? 200);
  });

  // 다른 창(노트 창의 삭제/보관/저장, 패널 자신의 삭제)에서 노트 목록이 바뀌면 다시 읽어
  // 그린다. 여러 창의 자동저장이 몰릴 때 매번 다시 읽지 않도록 살짝 디바운스한다. 선택
  // 모드 중이면 체크된 항목의 생존 여부도 함께 정리한다(다른 창에서 지운 노트의 체크 해제).
  let notesChangedTimer: ReturnType<typeof setTimeout> | undefined;
  deps.onNotesChanged?.(() => {
    if (notesChangedTimer !== undefined) clearTimeout(notesChangedTimer);
    notesChangedTimer = setTimeout(() => {
      void load();
      void pruneMissingSelections();
    }, NOTES_CHANGED_DEBOUNCE_MS);
  });
}
