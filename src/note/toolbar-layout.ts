/**
 * 툴바 배치 모델 — 상/하 바를 0·1·2·3단으로 구성하고 각 단(존)에 아이템을 순서대로 담는
 * 전역 레이아웃(순수 데이터 + 순수 변형). DOM·Tauri 의존 없음(설정 창·노트 창이 이걸 소비).
 *
 * 역할: "어떤 버튼이 어느 바·어느 단·몇 번째에 오는가"를 한 곳의 순수 규칙으로 정한다. 렌더는
 * note-toolbar/note-window가, 편집 UI는 settings가 담당하고, 이 모듈은 모델·기본값·정규화·변형만 갖는다.
 * 왜: 배치 규칙을 렌더/DnD에서 떼어내 단위 테스트로 못박고(바이브 코딩 안전망), 저장된 부분
 * 데이터도 안전하게 완전한 레이아웃으로 수렴시킨다.
 */

/** 바 식별자. */
export type BarId = "top" | "bottom";

/** 1단(단일 존)일 때의 정렬 — 좌 또는 우로 붙인다(2·3단은 존별 정렬이 고정이라 무시). */
export type ZoneAlign = "left" | "right";

/** 한 바의 배치 — `zones.length`가 단 수(0..3), 각 존은 정렬된 아이템 키 목록. */
export interface BarLayout {
  /** 1단일 때만 의미: 단일 존을 좌/우 어디에 붙일지. */
  align: ZoneAlign;
  /** 존별 아이템 키(정렬 순서 보존). 길이 0=0단(바 없음), 1=1단, 2=2단, 3=3단. */
  zones: string[][];
  /**
   * 존별 "줄임(⋯) 우선순위"(zones와 평행). 좁아질 때 어느 단이 **먼저** 접히는지 정한다:
   * 0=먼저 줄임, 1=보통(기본), 2=끝까지 유지. 없거나 짧으면 그 존은 1(보통)로 본다.
   * (구현: 존 flex-shrink 가중치 — 큰 값일수록 먼저 좁아져 먼저 ⋯로 접힌다.)
   */
  foldRank?: number[];
}

/** 존의 줄임 우선순위(0·1·2)를 낸다(없으면 보통=1, 범위 밖은 클램프). */
export function foldRankOf(bar: BarLayout, zoneIndex: number): number {
  const r = bar.foldRank?.[zoneIndex];
  return typeof r === "number" ? Math.max(0, Math.min(2, Math.round(r))) : 1;
}

/** 한 존이 바 안에서 아이템을 붙이는 쪽(내부 표현 — 소비자는 zoneAlignOf의 반환값으로 받는다). */
type ZoneJustify = "left" | "center" | "right";

/**
 * 존의 정렬을 낸다 — 1단은 바 정렬(좌/우), 2단은 [좌, 우], 3단은 [좌, 중, 우].
 * 노트 툴바 렌더와 설정 편집기 목업이 **같은 규칙**을 써야 "보이는 대로 배치된다"가 성립하므로
 * 순수 모델에 둔다(둘 중 한쪽에만 있으면 드리프트가 생긴다).
 */
export function zoneAlignOf(bar: BarLayout, zoneIndex: number): ZoneJustify {
  const count = bar.zones.length;
  if (count === 1) return bar.align;
  if (count === 2) return zoneIndex === 0 ? "left" : "right";
  return (["left", "center", "right"] as const)[zoneIndex] ?? "left";
}

/** 상·하 바 배치. */
export interface ToolbarLayout {
  top: BarLayout;
  bottom: BarLayout;
  /**
   * 이 배치가 "이미 아는" 아이템 키 전체(배치돼 있든 팔레트로 빼뒀든). 없는 키는 두 갈래로
   * 갈린다: 여기 있는데 어느 존에도 없으면 사용자가 명시적으로 뺀 것(계속 숨김). 여기에도
   * 없으면 이 배치가 한 번도 알지 못한 새 버튼(서드파티 설치·신규 번들) — position 폴백으로
   * 자동 배치한다. 구버전 데이터(필드 자체가 없음)는 resolveLayout이 마이그레이션한다.
   */
  seen?: string[];
}

/** 바당 최대 단 수. */
export const MAX_TIERS = 3;

/** 배치 가능한 내장 컨트롤 키(플러그인 버튼은 `plugin:<pluginId>:<buttonId>`). */
type BuiltinItemKey =
  | "core:transparency"
  | "core:preview"
  | "core:pin"
  | "core:all-desktops"
  | "core:background"
  | "core:collapse"
  | "core:collapsed-title"
  | "core:archive"
  | "core:delete"
  | "core:settings"
  | "core:new-note";

/** 내장 컨트롤 메타 — 팔레트 표시(이름)·조건부 노출 판정에 쓴다(아이콘 렌더는 note-toolbar). */
interface BuiltinItemMeta {
  key: BuiltinItemKey;
  /**
   * 팔레트·설정에 보일 사람 친화 이름의 i18n 키(문장 자체가 아니다) — 소비 지점(설정 렌더)이
   * `t(nameKey)`로 호출 시점에 해석한다. 이 카탈로그는 모듈 로드 시 한 번만 만들어지는데
   * (파일 상단 `export const`), 그 시점은 `setActiveLocale()`(창 부트스트랩)보다 항상 먼저다
   * — 문장을 여기서 `t()`로 미리 구우면 활성 로케일이 무엇이든 영원히 ko로 굳는다(§i18n 규약).
   */
  nameKey: string;
  /**
   * 이 컨트롤이 켜져 있어야 노출되는 창-컨트롤 id(대응 번들 플러그인 필요). 없으면 항상 가용.
   */
  requiresControl?: "transparency" | "always-on-top" | "all-desktops";
  /** 활성 테마가 배경 스와치를 제공해야 노출되는 컨트롤인지(배경색 피커). */
  requiresBackground?: boolean;
  /**
   * 이 컨트롤이 배치에 없을 때 자동으로 놓일 자리 — 플러그인 버튼의 `position`과 **완전히 같은
   * 역할**이며 [`DEFAULT_LAYOUT`]에서의 자리와 일치시킨다. 미가용(대응 플러그인 off·미지원 OS)이
   * 되면 배치에서 제거되므로([`pruneLayout`]), 다시 가용해졌을 때 돌아올 곳이 필요하다 —
   * "이전 위치를 기억하지 않고 초기값으로 되돌린다"가 스펙(사용자 확정).
   */
  position: FallbackPosition;
}

/** 내장 컨트롤 목록(수집·팔레트 순서). */
export const BUILTIN_ITEMS: readonly BuiltinItemMeta[] = [
  {
    key: "core:transparency",
    nameKey: "note.layout.item-transparency",
    requiresControl: "transparency",
    position: "top-left",
  },
  {
    key: "core:preview",
    nameKey: "note.layout.item-preview",
    position: "top-left",
  },
  {
    key: "core:pin",
    nameKey: "note.layout.item-pin",
    requiresControl: "always-on-top",
    position: "top-left",
  },
  {
    key: "core:all-desktops",
    nameKey: "note.layout.item-all-desktops",
    requiresControl: "all-desktops",
    position: "top-left",
  },
  {
    key: "core:background",
    nameKey: "note.layout.item-background",
    requiresBackground: true,
    position: "top-left",
  },
  {
    // 새 메모(베타 피드백 1건) — 항상 가용(조건부 컨트롤 아님). 도구 버튼(글자 크기·템플릿)과
    // 같은 상단 우측 존에 두되, 그 앞(맨 처음)에 자리한다 — DEFAULT_LAYOUT_MAC/WINDOWS 참고.
    key: "core:new-note",
    nameKey: "note.layout.item-new-note",
    position: "top-right",
  },
  {
    key: "core:collapse",
    nameKey: "note.layout.item-collapse",
    position: "top-right",
  },
  {
    // 접힘 제목(사용자 요구 1건) — 접힘 헤더(38px)에서 노트 제목(본문 첫 줄)을 보여주는 항목.
    // 다른 항목과 똑같이 배치된 존·순서 그대로 렌더되며(note-toolbar.ts), 남는 폭은 이 항목이
    // 가져간다(styles.css). 배치에서 빼면 라벨도 사라진다(note-toolbar의 setCollapsedTitle이
    // no-op). 접기와 같은 이유로 상단 전용(TOP_ONLY_KEYS) — 접히면 하단 바 자체가 숨어 자리가 없다.
    key: "core:collapsed-title",
    nameKey: "note.layout.item-collapsed-title",
    position: "top-left",
  },
  {
    key: "core:settings",
    nameKey: "note.layout.item-settings",
    position: "top-right",
  },
  {
    // "닫기"(구 "보관") — 동작은 그대로 archive(창 숨김, hidden=true)다. 두 기본 배치
    // (DEFAULT_LAYOUT_MAC/WINDOWS) 모두 상단에 두므로(스펙: 닫기는 상단, 삭제는 하단) 폴백
    // 자리도 상단으로 옮긴다 — 예전(bottom-right)에 남겨두면 컨트롤이 껐다 켜질 때 하단으로
    // 되돌아가 스펙을 어긴다. 좌/우 중 하나만 고를 수 있어 windows 기본값(top-right)에 맞춘다.
    key: "core:archive",
    nameKey: "note.layout.item-archive",
    position: "top-right",
  },
  {
    key: "core:delete",
    nameKey: "note.layout.item-delete",
    position: "bottom-right",
  },
] as const;

/**
 * 지금 이 환경에서 **실제로 쓸 수 있는** 내장 컨트롤만 추린다(순수).
 *
 * 판정 근거는 노트 툴바가 컨트롤을 실제로 만들 때 쓰는 것과 같다 — 창 컨트롤 능력 집합
 * (활성 창-기능 플러그인의 합집합)과 배경 스와치 유무. 설정 팔레트와 노트 렌더가 이 한
 * 함수를 공유해야 "팔레트엔 있는데 노트엔 안 나오는" 유령 아이템이 생기지 않는다.
 */
export function availableBuiltinItems(
  controls: readonly string[],
  hasBackground: boolean,
): readonly BuiltinItemMeta[] {
  return BUILTIN_ITEMS.filter(
    (item) =>
      (!item.requiresControl || controls.includes(item.requiresControl)) &&
      (!item.requiresBackground || hasBackground),
  );
}

const BUILTIN_KEY_SET: ReadonlySet<string> = new Set(
  BUILTIN_ITEMS.map((i) => i.key),
);

/** 알려진 내장 키인지. */
export function isBuiltinItemKey(key: string): key is BuiltinItemKey {
  return BUILTIN_KEY_SET.has(key);
}

/** `BUILTIN_ITEMS` 안에서의 카탈로그 순서(0-based). 없으면(플러그인 키) 조회 실패. */
const CATALOG_RANK: ReadonlyMap<string, number> = new Map(
  BUILTIN_ITEMS.map((item, i) => [item.key, i]),
);

/**
 * 존 안에서 한 아이템의 정렬 순위를 (배치 순위, 카탈로그 순위) 2단계 튜플로 낸다 — 노트
 * 툴바가 DOM 순서를 정할 때(`note-toolbar.ts`의 `insertByLayoutOrder`·`reorderZoneItems`)
 * 공유하는 순수 비교 기준이다.
 *
 * `order`(존의 `dataset.keys` — 마운트 때 굳은 배치 순서)에 키가 있으면 그 인덱스가 1단계
 * 순위다(2단계는 동점이 날 수 없어 의미가 없으므로 0). `order`에 없는(마운트 때 미가용이던
 * 내장 컨트롤·설치 직후 자동 배치되는 신규 버튼 같은 **폴백** 항목)은 전부 1단계 순위가
 * `order.length`로 동점이 되고, 2단계인 [`BUILTIN_ITEMS`] 카탈로그 순서로 갈린다 — 마운트
 * 뒤 `core:pin`·`core:all-desktops` 등을 별개 호출로 순차 켜도, 호출 순서가 아니라 카탈로그
 * 순서로 자리를 잡아 리로드 시 `materializeFallbacks`가 만드는 순서와 항상 일치한다.
 * 카탈로그에도 없는 키(플러그인 폴백 버튼)는 2단계가 `Number.MAX_SAFE_INTEGER`로 몰려
 * 언제나 가장 뒤이고, 그 안에서는 이 함수가 동점(같은 튜플)을 낸다 — 호출자가 원래
 * DOM/호출 순서를 안정 정렬로 지켜야 한다([`compareZoneItemRank`] 참고).
 */
export function zoneItemRank(
  order: readonly string[],
  key: string,
): readonly [number, number] {
  const layoutRank = order.indexOf(key);
  if (layoutRank >= 0) return [layoutRank, 0];
  return [order.length, CATALOG_RANK.get(key) ?? Number.MAX_SAFE_INTEGER];
}

/**
 * 두 [`zoneItemRank`] 튜플을 오름차순으로 비교한다. 동점(0)이면 호출자가 안정 정렬(원래
 * 순서 보존)로 깨야 한다 — 이 함수 자체는 원본 인덱스를 모른다.
 */
export function compareZoneItemRank(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** 플러그인 버튼 키(`plugin:<pluginId>:<buttonId>`)인지. */
export function isPluginItemKey(key: string): boolean {
  return key.startsWith("plugin:");
}

/**
 * 플러그인 id·버튼 id로 아이템 키를 만든다(`data-action`과 동일 규약).
 *
 * 이 함수는 **버튼**의 규약(`plugin:<pluginId>:<buttonId>`)만 안다 — 그 키가 사용자의
 * 저장된 `toolbar_layout` 배치와 맞물려 있어 절대 못 바꾼다. 상태 아이템처럼 **다른 종류**의
 * 항목이 같은 (pluginId, id) 쌍을 쓰고도 겹치지 않으려면, 호출자가 넘기는 `buttonId` 자체에
 * 미리 kind 접두를 실어야 한다(명령의 `cmd:`, 메뉴의 `menu:`, 상태 아이템의 `status:`와 같은
 * 방식 — `host-client.ts`의 `snapshotToolbarButtons` 참고). 이 함수 자신은 접두를 붙이거나
 * 벗기지 않는다.
 */
export function pluginItemKey(pluginId: string, buttonId: string): string {
  return `plugin:${pluginId}:${buttonId}`;
}

/**
 * 두 기본 배치가 공유하는 하단 바 — 좌: 복제·복사, 우: 단어수·초기화·삭제. 이슈 #16(스펙):
 * "닫기는 상단, 삭제는 하단" — 삭제(core:delete)는 OS 스타일과 무관하게 항상 여기(하단 우측
 * 끝)에 둔다. 예전엔 보관(archive)도 여기 있었지만, "보관" 개념이 "닫기"로 바뀌면서 상단으로
 * 옮겼다(두 스타일 상수가 각자 자기 위치에 core:archive를 더 붙인다).
 *
 * 함수인 이유: 호출마다 **새 객체**를 낸다 — 두 기본 배치(MAC/WINDOWS)가 같은 리터럴을 참조로
 * 공유하면, 한쪽을 (실수로 clone 없이) 직접 변형했을 때 다른 쪽까지 오염된다. 이 파일의 다른
 * 모든 변형 함수가 `cloneLayout`으로 이 함정을 피하는 것과 같은 이유다.
 */
function sharedBottom(): BarLayout {
  return {
    align: "left",
    zones: [
      // 좌: 복제·복사.
      [
        "plugin:duplicate:duplicate-note",
        "plugin:copy-ai-prompt:copy-ai-prompt",
      ],
      // 우: 단어 수(단어·글자 두 세그먼트, 상태 아이템이라 `status:` 접두 — pluginItemKey
      // 문서 참고)·옵션 초기화 + 삭제.
      [
        "plugin:word-count:status:word-count-words",
        "plugin:word-count:status:word-count-chars",
        "plugin:reset-options:reset",
        "core:delete",
      ],
    ],
  };
}

/**
 * Mac 스타일 기본 배치(이슈 #16) — 창 컨트롤(닫기)이 왼쪽에 몰리는 macOS 트래픽 라이트 관례를
 * 따른다: 닫기(core:archive, 동작은 여전히 archive — 창을 숨길 뿐 데이터는 보존)를 상단 좌측
 * 존의 **맨 앞**(다른 필수 컨트롤보다 먼저, 창 모서리에 가장 가깝게)에 둔다. 나머지 버튼
 * 배치는 옛 단일 DEFAULT_LAYOUT을 그대로 잇는다.
 */
export const DEFAULT_LAYOUT_MAC: ToolbarLayout = {
  top: {
    align: "left",
    zones: [
      // 좌: 닫기 + 내장 필수·조건부 컨트롤 + 배경색 + 접힘 제목(맨 끝 — 배치된 자리 그대로
      // 렌더되므로, 좌측 존 끝에 두면 다른 좌측 버튼들 뒤에서 시작해 남는 폭을 좌측 정렬로
      // 채운다).
      [
        "core:archive",
        "core:transparency",
        "core:preview",
        "core:pin",
        "core:all-desktops",
        "core:background",
        "core:collapsed-title",
      ],
      // 우: 새 메모(베타 피드백 1건) + 도구 버튼(글자 크기·템플릿) + 설정 바로가기 + 접기.
      [
        "core:new-note",
        "plugin:font-scale:font-minus",
        "plugin:font-scale:font-plus",
        "plugin:template:template-insert",
        "plugin:template:template-save",
        "core:settings",
        "core:collapse",
      ],
    ],
  },
  bottom: sharedBottom(),
};

/**
 * Windows 스타일 기본 배치(이슈 #16) — 창 컨트롤(닫기)이 오른쪽에 몰리는 Windows 타이틀바
 * 관례를 따른다: 닫기(core:archive)를 상단 우측 존의 **맨 끝**(창 모서리에 가장 가깝게)에
 * 둔다. 나머지 버튼 배치는 옛 단일 DEFAULT_LAYOUT을 그대로 잇는다.
 */
export const DEFAULT_LAYOUT_WINDOWS: ToolbarLayout = {
  top: {
    align: "left",
    zones: [
      // 좌: 내장 필수·조건부 컨트롤 + 배경색(닫기가 없는 자리라 Mac 배치와 다르다) + 접힘 제목
      // (맨 끝 — DEFAULT_LAYOUT_MAC과 같은 이유: 좌측 정렬로 남는 폭을 채운다).
      [
        "core:transparency",
        "core:preview",
        "core:pin",
        "core:all-desktops",
        "core:background",
        "core:collapsed-title",
      ],
      // 우: 새 메모(베타 피드백 1건) + 도구 버튼(글자 크기·템플릿) + 설정 바로가기 + 접기 +
      // 닫기(맨 끝).
      [
        "core:new-note",
        "plugin:font-scale:font-minus",
        "plugin:font-scale:font-plus",
        "plugin:template:template-insert",
        "plugin:template:template-save",
        "core:settings",
        "core:collapse",
        "core:archive",
      ],
    ],
  },
  bottom: sharedBottom(),
};

/**
 * 스타일을 아직 고르지 않았을 때(최초 실행 프롬프트 전, `resolveLayout`이 저장값 없이 불릴 때)
 * 쓰는 단일 폴백 — Windows 스타일을 기본으로 둔다. 사용자가 스타일을 고르면(toolbar-style-prompt)
 * 그 결과가 shared settings의 `toolbar_layout`에 실제로 저장되므로, 이 상수는 "아직 아무것도
 * 모르는" 짧은 과도기에만 쓰인다.
 *
 * `DEFAULT_LAYOUT_WINDOWS`와 값이 같은 의도적 하위호환 별칭이다(사용처: `resolveLayout`의
 * 무값 폴백, `note-toolbar`의 기본 파라미터, `toolbar-layout-editor`의 스타일 미지정 폴백 —
 * 모두 "아직 스타일을 모른다"는 같은 개념이라 `DEFAULT_LAYOUT_WINDOWS`로 직접 바꾸면 그
 * 의미가 사라진다). `@alias`로 knip의 duplicate-exports 오탐을 막는다(knip이 인정하는
 * 공식 표기 — https://knip.dev/reference/jsdoc-tsdoc-tags 참고).
 * @alias
 */
export const DEFAULT_LAYOUT: ToolbarLayout = DEFAULT_LAYOUT_WINDOWS;

/**
 * 지금 이 환경에서 **실제로 그려질** 기본 배치를 낸다(순수) — 「기본 배치로 초기화」가 만들
 * 결과이자, [`isDefaultLayout`]이 "되돌릴 게 있나"를 잴 기준선이다.
 *
 * 두 단계다: (1) `isAvailable`로 지금 쓸 수 없는 키를 걷어내고([`pruneLayout`]), (2) `items`의
 * `position` 폴백을 실제로 채운다([`materializeFallbacks`]).
 *
 * (1)이 없으면 기본 배치 상수(`DEFAULT_LAYOUT_MAC/WINDOWS`)에 **하드코딩된** 조건부 내장
 * 컨트롤(투명도·항상 위·모든 데스크탑·배경색)과 번들 플러그인 버튼이, 대응 플러그인이 꺼져
 * 있어도 그대로 배치에 꽂힌다 — 팔레트에 없으니 편집기 목업엔 정체 모를 칩("• core:transparency")
 * 으로 그려지고 저장까지 됐다(실증된 결함). 노트 창은 렌더 때 다시 `pruneLayout`하므로 정작
 * 툴바엔 안 나와, "미리보기에만 있는 유령"이 된다.
 *
 * `isAvailable`은 **판정할 수 있을 때만** 넘긴다(호스트 스냅샷을 못 읽었으면 생략) — "모른다"를
 * "없다"로 흘리면 기준선이 통째로 비어 초기화 버튼이 영구히 뜬다(`pruneLayout`과 같은 규약).
 * `seen`은 비운다: 초기화는 폴백 규칙을 처음처럼 다시 적용하는 것이다.
 */
export function defaultLayoutFor(
  def: ToolbarLayout,
  items: readonly { key: string; position?: FallbackPosition }[],
  isAvailable?: (key: string) => boolean,
): ToolbarLayout {
  const base: ToolbarLayout = { ...cloneLayout(def), seen: [] };
  return materializeFallbacks(
    isAvailable ? pruneLayout(base, isAvailable) : base,
    items,
  );
}

/**
 * 지금 배치가 기본 배치와 같은지(순수). "저장된 적 있나"가 아니라 **내용**으로 판단하므로,
 * 사용자가 이리저리 옮겼다 원래대로 되돌려 놔도 같다고 본다(초기화 버튼을 숨기는 기준).
 *
 * 비교 대상은 생짜 [`DEFAULT_LAYOUT`]이 아니라 **같은 `items`로 폴백을 적용한**
 * ([`materializeFallbacks`]) 기본 배치다. 왜: 판정 기준은 "초기화를 눌러도 배치가 그대로인가"인데,
 * 초기화는 `seen`을 비워 `position` 폴백을 처음처럼 다시 적용한다 — 그래서 기본 배치 쪽에도
 * 같은 자동 배치를 태워야 같은 것을 비교하게 된다. 생짜와 비교했을 때는 `position`을 선언한
 * 플러그인이 하나만 설치돼 있어도(번들 대부분과 문서 예제가 선언한다) 영원히 "기본이 아님"이
 * 되어, 사용자가 **아무것도 안 만졌는데** 초기화 버튼이 늘 떠 있었다(실증된 결함).
 *
 * `seen`은 비교하지 않는다 — 눈에 보이는 배치가 같으면 눌러도 달라지는 게 없다.
 *
 * 두 기본 배치(Mac/Windows) 중 **어느 쪽과 같아도** 기본으로 본다 — Mac 스타일을 고른
 * 사용자가 아무것도 안 만졌는데 "초기화" 버튼이 (Windows 기준으로만 비교해) 영구히 떠 있는
 * 것을 막는다(§isDefaultLayout 위 결함과 같은 종류).
 *
 * `isAvailable`(선택)은 기준선에서 지금 못 쓰는 키를 걷어내는 판정이다 —
 * [`defaultLayoutFor`] 참고. 넘기지 않으면(모름) 기본 상수를 그대로 기준선으로 쓴다. 넘겨야
 * 하는 이유: 조건부 컨트롤(투명도 등)을 끈 사용자는 배치가 이미 정리된(pruned) 상태라, 필터
 * 안 된 기본 상수와는 **영원히** 다르게 나와 초기화 버튼이 상시 노출됐다(실증된 결함).
 */
export function isDefaultLayout(
  layout: ToolbarLayout,
  items: readonly { key: string; position?: FallbackPosition }[],
  isAvailable?: (key: string) => boolean,
): boolean {
  return [DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS].some((def) => {
    const base = defaultLayoutFor(def, items, isAvailable);
    return sameBar(layout.top, base.top) && sameBar(layout.bottom, base.bottom);
  });
}

/** 두 바가 눈에 보이는 배치(정렬·존·순서·줄임 우선순위)로 같은지. */
function sameBar(a: BarLayout, b: BarLayout): boolean {
  return (
    a.align === b.align &&
    a.zones.length === b.zones.length &&
    a.zones.every(
      (zone, i) =>
        foldRankOf(a, i) === foldRankOf(b, i) &&
        zone.length === b.zones[i].length &&
        zone.every((key, j) => key === b.zones[i][j]),
    )
  );
}

/**
 * 두 레이아웃이 완전히 같은지(순수) — 보이는 배치 **+ `seen`**까지.
 *
 * [`isDefaultLayout`]과 달리 `seen`을 비교하는 이유: 이 함수의 용도는 "정리([`pruneLayout`])가
 * 실제로 뭔가를 바꿨나 → 저장할 가치가 있나"이고, 정리는 존은 그대로 둔 채 `seen`에서만 키를
 * 빼는 경우가 흔하다(미배치인 채로 비활성화된 버튼). `seen`만 바뀐 것을 "같다"로 읽으면 그
 * 저장이 생략돼 다음 로드에서 죽은 키가 되살아난다.
 */
export function sameLayout(a: ToolbarLayout, b: ToolbarLayout): boolean {
  const seenA = [...(a.seen ?? [])].sort();
  const seenB = [...(b.seen ?? [])].sort();
  return (
    sameBar(a.top, b.top) &&
    sameBar(a.bottom, b.bottom) &&
    seenA.length === seenB.length &&
    seenA.every((k, i) => k === seenB[i])
  );
}

/** 깊은 복제(순수 변형이 원본을 건드리지 않게). 구조가 단순해 구조화 복제로 충분. */
function cloneLayout(layout: ToolbarLayout): ToolbarLayout {
  const cloneBar = (bar: BarLayout): BarLayout => ({
    align: bar.align,
    zones: bar.zones.map((z) => [...z]),
    ...(bar.foldRank ? { foldRank: [...bar.foldRank] } : {}),
  });
  return {
    top: cloneBar(layout.top),
    bottom: cloneBar(layout.bottom),
    ...(layout.seen ? { seen: [...layout.seen] } : {}),
  };
}

/** 정렬 값 정규화(모르면 left). */
function coerceAlign(raw: unknown): ZoneAlign {
  return raw === "right" ? "right" : "left";
}

/**
 * 한 바의 원시 입력을 정규화한다: zones를 최대 MAX_TIERS로 자르고, 각 존을 문자열 키 배열로 강제,
 * 빈 문자열 제거. (중복 키 제거는 레이아웃 전체 스코프에서 별도로 수행.)
 */
function coerceBar(raw: unknown): BarLayout {
  const o = (raw ?? {}) as {
    align?: unknown;
    zones?: unknown;
    foldRank?: unknown;
  };
  const zonesRaw = Array.isArray(o.zones) ? o.zones : [];
  const zones = zonesRaw
    .slice(0, MAX_TIERS)
    .map((zone) =>
      (Array.isArray(zone) ? zone : []).filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      ),
    );
  const bar: BarLayout = { align: coerceAlign(o.align), zones };
  // foldRank: 존과 평행한 0·1·2 배열(비정상은 무시 → 기본 보통). 존 개수만큼만 취한다.
  if (Array.isArray(o.foldRank)) {
    const fr = o.foldRank
      .slice(0, zones.length)
      .map((v) =>
        typeof v === "number" ? Math.max(0, Math.min(2, Math.round(v))) : 1,
      );
    if (fr.some((v) => v !== 1)) bar.foldRank = fr;
  }
  return bar;
}

/**
 * 상단 바에만 둘 수 있는 키. 접기(collapse)는 접힘 시 하단 바를 숨기고 창을 헤더(38px) 높이로
 * 잠그므로, 하단에 두면 자기 자신이 숨어 다시 펼칠 수 없다 → 상단 전용으로 강제한다(스펙).
 * 접힘 제목(collapsed-title)도 같은 이유로 상단 전용이다 — 접히면 하단 바 자체가 통째로 숨어
 * (styles.css) 하단에 둔들 아무도 못 보므로, 애초에 하단행을 허용할 이유가 없다.
 */
const TOP_ONLY_KEYS: ReadonlySet<string> = new Set([
  "core:collapse",
  "core:collapsed-title",
]);

/** 이 키가 상단 바 전용인지(접기 등). */
export function isTopOnlyKey(key: string): boolean {
  return TOP_ONLY_KEYS.has(key);
}

/** `seen` 원시값을 정규화한다(배열 아니면 undefined — 구버전으로 간주해 마이그레이션시킨다). */
function coerceSeen(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<string>();
  for (const v of raw) if (typeof v === "string" && v.length > 0) set.add(v);
  return [...set];
}

/**
 * 저장된(부분/신뢰 못 할) 값을 완전한 ToolbarLayout으로 정규화한다.
 *
 * - null/undefined → 기본 배치 복제(미customize).
 * - 객체 → top/bottom 각각 정규화(단 수 클램프·타입 강제). 한 아이템이 여러 곳에 있으면
 *   처음 것만 남긴다(전체 스코프 중복 제거). 상단 전용 키(접기)가 하단에 있으면 제거한다
 *   (손편집 방어). 알 수 없는 키도 보존한다(플러그인 버튼 키는 런타임에만 알 수 있어
 *   형식만 검증) — 렌더 시 가용하지 않으면 자연히 빠진다.
 * - `seen`(이 배치가 아는 키 전체)도 정규화한다. 저장된 값에 배열이 있으면 그대로(정제해)
 *   쓰고, 없으면(필드 부재 — 엄격) 빈 집합으로 본다. 배치에 이미 놓인 키는 `placedKeys`가
 *   따로 잡으므로(materializeFallbacks·isDefaultLayout이 `seen ∪ placedKeys`로 합쳐 쓴다)
 *   빈 seen이어도 지금 놓인 아이템이 "신규"로 오인되지 않는다 — 진짜 신규(어디에도 없는) 키만
 *   note-toolbar의 position 폴백 대상이 된다.
 */
export function resolveLayout(raw: unknown): ToolbarLayout {
  const hasRaw = raw != null && typeof raw === "object";
  const o = hasRaw
    ? (raw as { top?: unknown; bottom?: unknown; seen?: unknown })
    : {};
  const layout: ToolbarLayout = hasRaw
    ? { top: coerceBar(o.top), bottom: coerceBar(o.bottom) }
    : cloneLayout(DEFAULT_LAYOUT);
  // 하단의 상단 전용 키(접기)를 상단으로 **이관**한다(스펙: 접기는 상단에만). 지우지 않고 옮겨야
  // 구버전 하단-접기 데이터에서 접기가 사라져 접힌 노트가 갇히지 않는다. 상단에 존이 있으면 마지막
  // 존 끝(우측, 기본 배치와 결)에 붙이고, 상단이 0단이면(둘 곳 없음) 부득이 제거한다(미배치 — 노트
  // 창은 접기 컨트롤이 없으면 마운트 시 펼침으로 되돌린다).
  for (const key of TOP_ONLY_KEYS) {
    if (!layout.bottom.zones.some((z) => z.includes(key))) continue;
    layout.bottom.zones = layout.bottom.zones.map((z) =>
      z.filter((k) => k !== key),
    );
    const topZones = layout.top.zones;
    if (topZones.length > 0 && !topZones.some((z) => z.includes(key)))
      topZones[topZones.length - 1].push(key);
  }
  // 전체 스코프 중복 제거: 같은 키는 처음 등장한 존에만 남긴다.
  const dedup = new Set<string>();
  for (const bar of [layout.top, layout.bottom]) {
    bar.zones = bar.zones.map((zone) =>
      zone.filter((k) => (dedup.has(k) ? false : (dedup.add(k), true))),
    );
  }
  layout.seen = coerceSeen(o.seen) ?? [];
  return layout;
}

/**
 * 배치가 아는 아이템 키를 넓힌다(순수, 새 레이아웃 반환). 기존 `seen`과의 합집합만 한다
 * (좁히지 않음 — 이미 알던 키를 다시 "신규"로 만들 이유가 없다).
 *
 * 넘길 키는 **"이번 배치에 실제로 놓인 키 + 이번 편집으로 존에서 빼낸 키"**로 좁혀야 한다.
 * 팔레트 전체를 넘기면 아직 아무도 배치를 만져 준 적 없는 신규 버튼(설치 직후 `position`
 * 폴백으로 자동 노출 중인 서드파티 버튼)까지 "안다"로 승격돼, 미배치 상태 그대로 seen에만
 * 들어가 다음 로드부터 영구히 사라진다(사용자가 뺀 것과 구분 불가).
 */
export function markSeen(layout: ToolbarLayout, keys: string[]): ToolbarLayout {
  const next = cloneLayout(layout);
  next.seen = [...new Set([...(layout.seen ?? []), ...keys])];
  return next;
}

/**
 * 지금 쓸 수 없는 아이템을 배치에서 **완전히 지운다**(순수, 새 레이아웃 반환) — 존에서도,
 * `seen`에서도.
 *
 * 스펙(사용자 확정): 비활성 플러그인은 앱이 아예 모르는 상태여야 한다. 비활성화된 버튼의
 * 키가 배치에 남아 있으면 (a) 설정 편집기 목업이 그 자리에 정체 모를 칩("• pid · bid")을
 * 그리고, (b) 저장 데이터에 죽은 키가 계속 쌓인다. `seen`까지 함께 지우는 것이 핵심이다 —
 * `seen`에 남으면 "사용자가 명시적으로 뺀 것"으로 읽혀 다시 켰을 때 영구히 숨는다.
 * 둘 다 지우면 그 키는 **이 배치가 한 번도 본 적 없는 신규 버튼**으로 되돌아가, 다시 가용해질
 * 때 [`materializeFallbacks`]·note-toolbar의 `placeItem`이 `position`이 가리키는 **기본 자리**에
 * 놓는다(이전 위치는 일부러 기억하지 않는다).
 *
 * `isAvailable`은 **판정할 수 있는 키만** true/false로 답해야 한다. 호출자가 카탈로그를 못
 * 읽었으면(호스트 스냅샷 부재 등) 이 함수를 아예 부르지 말 것 — "모른다"를 false로 흘리면
 * 사용자 배치가 통째로 날아간다.
 */
export function pruneLayout(
  layout: ToolbarLayout,
  isAvailable: (key: string) => boolean,
): ToolbarLayout {
  const next = cloneLayout(layout);
  for (const bar of [next.top, next.bottom])
    bar.zones = bar.zones.map((zone) => zone.filter(isAvailable));
  if (next.seen) next.seen = next.seen.filter(isAvailable);
  return next;
}

/** 한 바의 단 수(존 개수). */
export function tierOf(bar: BarLayout): number {
  return bar.zones.length;
}

/** 레이아웃 어딘가에 이미 배치된 아이템 키 집합. */
export function placedKeys(layout: ToolbarLayout): Set<string> {
  const set = new Set<string>();
  for (const bar of [layout.top, layout.bottom])
    for (const zone of bar.zones) for (const k of zone) set.add(k);
  return set;
}

/** 특정 아이템 키의 현재 위치를 찾는다(없으면 null). */
export function locateItem(
  layout: ToolbarLayout,
  key: string,
): { bar: BarId; zone: number; index: number } | null {
  for (const bar of ["top", "bottom"] as const) {
    const zones = layout[bar].zones;
    for (let z = 0; z < zones.length; z++) {
      const idx = zones[z].indexOf(key);
      if (idx >= 0) return { bar, zone: z, index: idx };
    }
  }
  return null;
}

/**
 * 배치를 한 번도 알지 못한(seen에도 없는) 서드파티 버튼이 폴백으로 쓸 위치 — 상/하 × 좌/우
 * 4방향(plugin/loader의 `ToolbarPosition`과 리터럴 값이 같아, 그 타입 값을 그대로 넘겨도
 * 구조적으로 호환된다). 이 모듈은 플러그인 모듈을 import하지 않는다(순수 유지).
 */
export type FallbackPosition =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * 정렬쪽 존 인덱스를 고른다: 존이 1개뿐이면 그 존(정렬이 어긋나도 유일한 선택지), 2개 이상이면
 * `zoneAlignOf`가 요청한 align과 일치하는 존, 못 찾으면 0번째로 폴백한다(항상 인덱스를 낸다).
 */
function autoZoneIndex(bar: BarLayout, align: ZoneAlign): number {
  if (bar.zones.length <= 1) return 0;
  for (let i = 0; i < bar.zones.length; i++)
    if (zoneAlignOf(bar, i) === align) return i;
  return 0;
}

/**
 * 폴백 위치(top/bottom × left/right)를 실제 (bar, zone)으로 매핑한다. 그 바가 0단(존이
 * 없음)이면 null — 렌더 쪽이 안전하게 건너뛴다(버튼을 억지로 만들어 넣지 않는다).
 */
export function fallbackZoneFor(
  layout: ToolbarLayout,
  position: FallbackPosition,
): { bar: BarId; zone: number } | null {
  const bar: BarId = position.startsWith("top") ? "top" : "bottom";
  if (layout[bar].zones.length === 0) return null;
  const align: ZoneAlign = position.endsWith("left") ? "left" : "right";
  return { bar, zone: autoZoneIndex(layout[bar], align) };
}

/**
 * 배치가 한 번도 알지 못한(seen에도 없는) 아이템을 `position`이 가리키는 존 끝에 **실제로
 * 넣은** 새 레이아웃을 낸다(순수).
 *
 * 역할: 노트 창의 런타임 폴백(note-toolbar의 `placeItem`)과 **같은 자리**를 설정의 배치
 * 편집기에도 보여주기 위한 것이다. 편집기가 이걸 쓰지 않으면 설치 직후 자동 노출된 버튼이
 * 노트에는 보이는데 편집기 목업에는 없고(팔레트에만 있음), 사용자가 그 버튼을 "치우는" 방법이
 * 없어진다(치우려면 존에 있어야 한다 → 빼내야 seen에 기록된다).
 * 왜 순수 함수인가: 노트 창은 여러 개가 동시에 뜨므로 폴백 결과를 저장소에 되쓰지 않는다 —
 * 영속화는 사용자가 편집기에서 실제로 저장할 때 한 번만 일어난다.
 */
export function materializeFallbacks(
  layout: ToolbarLayout,
  items: readonly { key: string; position?: FallbackPosition }[],
): ToolbarLayout {
  const next = cloneLayout(layout);
  const known = new Set([...(layout.seen ?? []), ...placedKeys(layout)]);
  for (const item of items) {
    if (!item.position || known.has(item.key)) continue;
    const target = fallbackZoneFor(next, item.position);
    if (!target) continue;
    next[target.bar].zones[target.zone].push(item.key);
    known.add(item.key);
  }
  return next;
}

/**
 * 바의 단 수를 바꾼다(0..MAX_TIERS). 줄이면 사라지는 존의 아이템은 **버려지지 않고** 팔레트로
 * 간다(미배치). 늘리면 빈 존을 뒤에 추가한다. 결과는 새 레이아웃(원본 불변).
 *
 * 왜 팔레트로 보내나: 존을 줄였다고 사용자 배치를 소리 없이 삭제하면 데이터 손실이므로, 남은
 * 존에 몰아넣기보다 미배치로 빼 사용자가 다시 두게 한다.
 */
export function setTier(
  layout: ToolbarLayout,
  bar: BarId,
  tier: number,
): ToolbarLayout {
  const next = cloneLayout(layout);
  const clamped = Math.max(0, Math.min(MAX_TIERS, Math.floor(tier)));
  const zones = next[bar].zones;
  if (clamped < zones.length) {
    // 사라지는 존은 통째로 제거(그 안의 아이템은 미배치가 됨).
    next[bar].zones = zones.slice(0, clamped);
  } else {
    while (next[bar].zones.length < clamped) next[bar].zones.push([]);
  }
  return next;
}

/** 한 존의 아이템을 모두 미배치로 옮긴다(존은 남기고 비운다). 새 레이아웃 반환(원본 불변). */
export function clearZone(
  layout: ToolbarLayout,
  bar: BarId,
  zoneIndex: number,
): ToolbarLayout {
  const next = cloneLayout(layout);
  if (zoneIndex >= 0 && zoneIndex < next[bar].zones.length)
    next[bar].zones[zoneIndex] = [];
  return next;
}

/** 한 존의 줄임 우선순위(0=먼저·1=보통·2=끝까지 유지)를 바꾼다. 새 레이아웃 반환(원본 불변). */
export function setFoldRank(
  layout: ToolbarLayout,
  bar: BarId,
  zoneIndex: number,
  rank: number,
): ToolbarLayout {
  const next = cloneLayout(layout);
  const b = next[bar];
  if (zoneIndex < 0 || zoneIndex >= b.zones.length) return next;
  // 존 개수만큼 채운 완전한 배열로 만든다(기존 값은 foldRankOf로 읽어 보존).
  const fr = b.zones.map((_z, i) => foldRankOf(b, i));
  fr[zoneIndex] = Math.max(0, Math.min(2, Math.round(rank)));
  b.foldRank = fr.some((v) => v !== 1) ? fr : undefined;
  return next;
}

/** 1단 바의 정렬을 바꾼다(좌/우). 새 레이아웃 반환. */
export function setAlign(
  layout: ToolbarLayout,
  bar: BarId,
  align: ZoneAlign,
): ToolbarLayout {
  const next = cloneLayout(layout);
  next[bar].align = align;
  return next;
}

/**
 * 아이템을 목적지로 옮긴다. `to`가 null이면 팔레트로(어디서든 제거). 이동 전 기존 위치에서
 * 먼저 제거하므로 같은 존 안 재정렬도 정확한 최종 index를 얻는다. 목적지 존이 없으면 무시(원본류지).
 */
export function moveItem(
  layout: ToolbarLayout,
  key: string,
  to: { bar: BarId; zone: number; index: number } | null,
): ToolbarLayout {
  const next = cloneLayout(layout);
  // 목적지가 있는데 존이 없으면 아무 것도 하지 않는다(제거 전에 검증 — 데이터 손실 방지).
  if (to != null && (to.zone < 0 || to.zone >= next[to.bar].zones.length)) {
    return next;
  }
  // 1) 현재 위치에서 제거.
  for (const bar of [next.top, next.bottom])
    for (const zone of bar.zones) {
      const i = zone.indexOf(key);
      if (i >= 0) zone.splice(i, 1);
    }
  if (to == null) return next; // 팔레트로.
  const dest = next[to.bar].zones[to.zone];
  const index = Math.max(0, Math.min(dest.length, to.index));
  dest.splice(index, 0, key);
  return next;
}
