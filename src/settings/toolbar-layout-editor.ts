/**
 * 설정 창 "툴바 배치" 편집기 — **노트 창 모양 목업** 위에서 버튼을 드래그&드롭으로 배치한다.
 *
 * 역할: 전역 ToolbarLayout을 실제 노트(상단 바 · 본문 · 하단 바) 그림으로 그리고, 팔레트(미배치
 * 아이템)와 각 존 사이에 아이템을 끌어다 놓거나 순서를 바꾸게 한다. 단 수(0·1·2·3)·1단 정렬(좌/우)은
 * 각 바의 컨트롤 줄에서 버튼으로 바꾼다. 상태 변형은 순수 함수(toolbar-layout)에 위임하고, 바뀔
 * 때마다 onChange로 상위(설정 저장)에 알린다. 마우스 DnD가 주 상호작용이되, 키보드(방향키 이동·
 * Delete 숨김·Enter 배치)와 aria로 접근성을 준다.
 * 왜: 플러그인별 "버튼 위치" 설정을 없애고 배치를 한 그림에서 사용자가 직접 구성하게 한다. 추상
 * 박스가 아니라 노트 실물 비율로 그려 **보이는 대로 배치된다**를 성립시킨다(존 정렬은 노트 렌더와
 * 같은 zoneAlignOf 규칙을 쓴다). 배치 규칙은 순수 모듈에 있어 테스트로 못박고, 이 모듈은 DOM
 * 렌더·DnD·키보드 글루만 담당한다.
 *
 * 목업 안의 칩은 실제 바 높이(≈30px)에 맞춰 **아이콘 전용**이고(이름은 aria-label·콜아웃·팔레트에
 * 있다), 지금 가리키는/포커스한 칩 하나만 목업 밖으로 이름·위치 콜아웃을 띄운다. 여러 칩에 지시선을
 * 동시에 뻗지 않는 이유: 존은 **순서 있는 가변 목록**이라 방사형 지시선으로는 몇 번째인지 표현할 수 없다.
 *
 * 드래그는 **포인터 기반**이다(HTML5 네이티브 DnD는 WKWebView에서 불안정·시각 피드백 부재 →
 * 마우스 이벤트로 직접 구현: 고스트가 커서를 따라오고, 놓는 위치 아래의 존/팔레트로 이동).
 *
 * 신뢰 경계: 내장 아이템 아이콘(iconSvg)은 우리 소스라 innerHTML로 렌더하고, 플러그인 글리프·
 * 이름(label/title)은 플러그인 저작 문자열이라 textContent로만 렌더한다(XSS 차단).
 */
import {
  DEFAULT_LAYOUT,
  MAX_TIERS,
  clearZone,
  defaultLayoutFor,
  foldRankOf,
  isDefaultLayout,
  isTopOnlyKey,
  locateItem,
  markSeen,
  materializeFallbacks,
  moveItem,
  placedKeys,
  setAlign,
  setFoldRank,
  setTier,
  zoneAlignOf,
  type BarId,
  type FallbackPosition,
  type ToolbarLayout,
} from "../note/toolbar-layout";
import { t } from "../i18n/t";

/** 팔레트/배치에 쓰는 아이템 표시 정보. */
export interface LayoutPaletteItem {
  /** 아이템 키(core:* 또는 plugin:<pluginId>:<buttonId>). */
  key: string;
  /** 표시 이름(사람 친화). */
  name: string;
  /** 내장 아이템의 신뢰 SVG 마크업(있으면 innerHTML). */
  iconSvg?: string;
  /** 플러그인 버튼의 글리프(이모지/텍스트 — textContent로만 렌더). */
  glyph?: string;
  /**
   * 플러그인이 선언한 자동 배치 존 — 배치가 이 키를 한 번도 본 적 없을 때(설치 직후) 노트
   * 창이 여기에 렌더한다. 편집기도 같은 자리에 미리 놓아 목업이 실물과 어긋나지 않게 한다.
   */
  position?: FallbackPosition;
}

/** 편집기 옵션. */
interface ToolbarLayoutEditorOptions {
  /** 초기 배치(정규화된 ToolbarLayout). */
  layout: ToolbarLayout;
  /** 배치 가능한 모든 아이템(내장 + 활성 플러그인 버튼). 미배치 계산은 내부에서 한다. */
  paletteItems: LayoutPaletteItem[];
  /** 배치가 바뀔 때마다 호출(설정 저장 트리거). */
  onChange(next: ToolbarLayout): void;
  /**
   * "기본 배치로 초기화" 버튼이 되돌아갈 기본 배치. 호출부가 사용자의 `toolbar_style`
   * (mac/windows)에 맞는 [`DEFAULT_LAYOUT_MAC`]/[`DEFAULT_LAYOUT_WINDOWS`]를 골라 넘긴다.
   *
   * 생략하면 옛 단일 [`DEFAULT_LAYOUT`](Windows 별칭)로 폴백한다 — 스타일을 아직 확정하지
   * 못한 과도기에만 해당하며, Mac 스타일 사용자를 Windows 배치로 되돌리는 회귀를 피하려면
   * 실제 호출부는 반드시 스타일에 맞는 값을 넘겨야 한다.
   */
  defaultLayout?: ToolbarLayout;
  /**
   * 이 키를 지금 쓸 수 있는지(꺼진 플러그인의 버튼·미가용 내장 컨트롤이면 false). 기본 배치에
   * **하드코딩된** 조건부 아이템이 초기화로 되살아나지 않게 거르는 데 쓴다([`defaultLayoutFor`]).
   *
   * 호출부는 **판정할 수 있을 때만** 넘긴다 — 호스트 스냅샷을 못 읽어 팔레트를 거르지도,
   * 배치를 정리하지도 못한 상태라면 생략해야 한다("모른다"를 "없다"로 읽으면 초기화가 배치를
   * 통째로 비우고 초기화 버튼이 영구히 뜬다). `paletteItems`만으로 대신 판정하지 않는 이유가
   * 이것이다 — 팔레트는 "거르지 못한 전체 목록"일 수도 있어 두 경우를 구분할 수 없다.
   */
  isAvailable?: (key: string) => boolean;
}

/** 드래그 시작으로 인정하는 최소 이동(px) — 이보다 작으면 클릭으로 본다(무동작). */
const DRAG_THRESHOLD = 4;

/**
 * 콜아웃 라벨과 바 스트립 사이 간격(px). CSS의 지시선 길이(--tb-callout-gap)와 같은 값이어야
 * 선이 스트립 경계에 정확히 닿는다.
 */
const CALLOUT_GAP = 26;

/** 바 id의 한글 이름(다른 문장에 {bar}로 끼워 넣는 용도). */
function barLabel(bar: BarId): string {
  return bar === "top"
    ? t("settings.toolbar-layout.bar-top")
    : t("settings.toolbar-layout.bar-bottom");
}

/** 존 index/개수에 따른 한글 정렬 라벨. */
function zoneLabel(align: string, zoneIndex: number, count: number): string {
  const left = t("settings.toolbar-layout.zone-left");
  const right = t("settings.toolbar-layout.zone-right");
  if (count === 1) return align === "right" ? right : left;
  if (count === 2) return zoneIndex === 0 ? left : right;
  return (
    [left, t("settings.toolbar-layout.zone-center"), right][zoneIndex] ?? ""
  );
}

/**
 * 배치된 아이템의 자리를 사람 말로 낸다(예: "상단 우 2번째"). 목업 안 칩은 아이콘 전용이라 지금
 * 가리키는 칩이 정확히 어디 몇 번째인지 콜아웃으로 알려줘야 한다. 미배치면 null.
 */
export function itemPositionLabel(
  layout: ToolbarLayout,
  key: string,
): string | null {
  const loc = locateItem(layout, key);
  if (!loc) return null;
  const bar = layout[loc.bar];
  const zText = zoneLabel(bar.align, loc.zone, bar.zones.length);
  return t("settings.toolbar-layout.item-position", {
    bar: barLabel(loc.bar),
    zone: zText,
    index: loc.index + 1,
  });
}

/**
 * 글리프가 아이콘 하나가 아니라 **텍스트 레이블**인지 본다(상태 표시 "0 단어 · 0 자", 텍스트
 * 버튼 등). 목업 칩은 실제 버튼 크기(아이콘 한 칸)라, 문장을 그 칸에 밀어 넣으면 줄바꿈돼 칩이
 * 깨져 보인다 → 레이블형은 노트 실물처럼 한 줄 텍스트 칩으로 그린다(CSS의 tb-chip--label).
 *
 * 판정은 **코드포인트 2개 이하 = 아이콘**이다(내장 글리프 "⧉"·"A−"·"📋"·"➕"가 모두 여기 든다).
 * ZWJ로 이어 붙인 조합 이모지는 레이블형으로 오분류되지만, 그때도 한 줄 텍스트 칩으로 자연폭에
 * 그려질 뿐이라 해가 없다(Intl.Segmenter는 tsconfig lib(ES2020) 밖이라 쓰지 않는다).
 */
function isLabelGlyph(glyph: string): boolean {
  return [...glyph].length > 2;
}

/** 팔레트 메타가 없는(비활성 플러그인·호스트 부재) 키를 사람이 읽을 수 있게 다듬는다. */
function friendlyKeyLabel(key: string): string {
  if (key.startsWith("plugin:"))
    return key.slice("plugin:".length).replace(":", " · ");
  return key;
}

/**
 * 팔레트에 보일(=아직 배치되지 않은) 아이템을 순수 계산한다. paletteItems 순서를 보존한다.
 */
export function unplacedItems(
  layout: ToolbarLayout,
  paletteItems: LayoutPaletteItem[],
): LayoutPaletteItem[] {
  const placed = placedKeys(layout);
  return paletteItems.filter((it) => !placed.has(it.key));
}

/**
 * 목업 본문(가짜 텍스트 줄) — 상·하 바가 노트에서 어디에 붙는지 감이 오게 실제 비율을 흉내낸다.
 * 순수 장식이라 스크린리더에선 감춘다.
 */
function noteBodyMock(): HTMLElement {
  const body = document.createElement("div");
  body.className = "tb-note-body";
  body.setAttribute("aria-hidden", "true");
  for (const width of [56, 88, 74, 82]) {
    const line = document.createElement("div");
    line.className = "tb-note-line";
    line.style.width = `${width}%`;
    body.append(line);
  }
  return body;
}

/** 드롭 대상(포인터 아래의 존 또는 팔레트). */
type DropTarget =
  | { kind: "zone"; el: HTMLElement; bar: BarId; zone: number }
  | { kind: "palette"; el: HTMLElement };

/**
 * 배치 편집기 DOM을 만들어 반환한다. 내부에 현재 배치를 들고, 변경 시 제자리에서 다시 그리고
 * onChange로 상위에 알린다.
 */
export function renderToolbarLayoutEditor(
  opts: ToolbarLayoutEditorOptions,
): HTMLElement {
  // 아직 배치가 모르는(seen 밖) 신규 버튼은 노트 창이 position 폴백으로 자동 노출한다 —
  // 편집기도 같은 자리에 미리 놓아 목업이 실물과 같아지게 한다(그래야 사용자가 그 버튼을
  // 팔레트로 빼내 "치울" 수 있고, 그 순간 seen에 기록돼 영구히 숨는다).
  let layout = materializeFallbacks(opts.layout, opts.paletteItems);
  const metaByKey = new Map(opts.paletteItems.map((it) => [it.key, it]));

  const root = document.createElement("section");
  root.className = "tb-editor";

  // 변경을 반영·저장·재렌더한다. focusKey가 있으면 재렌더 후 그 칩에 포커스를 되돌린다(키보드 연속 조작).
  // 저장 직전 markSeen에 넘기는 키는 **이번 배치에 실제로 놓인 키 + 이번 편집으로 존에서 빼낸 키**로
  // 좁힌다: 빼낸 키는 "사용자가 명시적으로 치웠다"로 기록돼 다음 로드에서 position 폴백으로 되살아나지
  // 않고, 사용자가 손대지 않은 키는 계속 미확인으로 남는다(팔레트 전체를 넘기면 설치 직후 자동 노출
  // 중인 서드파티 버튼이 무관한 편집 한 번으로 영구히 사라졌다 — 실증된 회귀).
  const commit = (next: ToolbarLayout, focusKey?: string): void => {
    const before = placedKeys(layout);
    const after = placedKeys(next);
    const removed = [...before].filter((k) => !after.has(k));
    layout = markSeen(next, [...after, ...removed]);
    opts.onChange(layout);
    render();
    if (focusKey) {
      [...root.querySelectorAll<HTMLElement>(".tb-chip")]
        .find((c) => c.dataset.itemKey === focusKey)
        ?.focus();
    }
  };

  // 「기본 배치로 초기화」 전용 경로: 존 구성뿐 아니라 `seen`까지 비운다 — 그래야 자동 배치
  // (position 폴백) 규칙이 처음처럼 다시 적용돼 설치된 서드파티 버튼이 기본 자리로 돌아온다
  // (commit을 쓰면 방금 지워진 키들이 "사용자가 빼낸 것"으로 기록돼 전부 숨는다).
  // 기본 배치는 opts.defaultLayout(호출부가 toolbar_style에 맞춰 고른 값)을 쓴다 — 옛 단일
  // DEFAULT_LAYOUT(Windows 별칭)로 고정하면 Mac 스타일 사용자가 초기화를 누를 때 Windows
  // 배치로 뒤바뀌는 회귀가 난다. 기준선은 `defaultLayoutFor`가 만든다 — 기본 상수에 하드코딩된
  // 조건부 아이템(투명도·핀·모든 데스크탑·배경색, 번들 플러그인 버튼)을 지금 가용한 것만 남겨
  // 걸러야, 꺼둔 플러그인의 버튼이 초기화 한 번으로 유령 칩이 되어 되살아나지 않는다.
  const resetToDefault = (): void => {
    layout = defaultLayoutFor(
      opts.defaultLayout ?? DEFAULT_LAYOUT,
      opts.paletteItems,
      opts.isAvailable,
    );
    opts.onChange(layout);
    render();
  };

  // 키 배치의 기본 목적지(키보드 Enter): 첫 배치 가능한 존. 상단 전용 키(접기)는 상단 존만 대상.
  const firstZone = (key: string): { bar: BarId; zone: number } | null => {
    const bars: BarId[] = isTopOnlyKey(key) ? ["top"] : ["top", "bottom"];
    for (const bar of bars)
      if (layout[bar].zones.length > 0) return { bar, zone: 0 };
    return null;
  };

  // 드롭 지점의 삽입 index를 포인터(x,y)로 계산한다 — **읽기 순서(행 우선)**. 존이 여러 줄로
  // 줄바꿈(flex-wrap)돼도 정확하도록 y로 행을 먼저 가르고 같은 행에선 x로 좌/우 절반을 본다.
  // (x만 보면 아랫 줄의 칩이 윗 줄 칩보다 왼쪽이라 index가 앞으로 튀어 드롭이 무동작이 됐다.)
  // 드래그 중인 칩은 제외한다 — moveItem이 제거-후 삽입이라 같은 존 이동의 off-by-one을 막는다.
  const dropIndex = (
    container: HTMLElement,
    x: number,
    y: number,
    excludeKey: string,
  ): number => {
    const chips = [
      ...container.querySelectorAll<HTMLElement>(".tb-chip"),
    ].filter((c) => c.dataset.itemKey !== excludeKey);
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      if (y > r.bottom) continue; // 이 칩은 포인터보다 윗 줄 → 앞(계속).
      if (y < r.top) return i; // 이 칩은 포인터보다 아랫 줄 → 여기(그 앞)에 삽입.
      if (x < r.left + r.width / 2) return i; // 같은 줄, 왼쪽 절반 → 이 칩 앞.
    }
    return chips.length;
  };

  // 포인터(x,y) 아래의 드롭 대상(존/팔레트)을 찾는다. 고스트는 pointer-events:none이라 hit-test에 안 걸린다.
  const targetAt = (x: number, y: number): DropTarget | null => {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const slots = under?.closest<HTMLElement>(".tb-zone-slots");
    if (slots)
      return {
        kind: "zone",
        el: slots,
        bar: slots.dataset.bar as BarId,
        zone: Number(slots.dataset.zone),
      };
    const pal = under?.closest<HTMLElement>(".tb-palette-items");
    if (pal) return { kind: "palette", el: pal };
    return null;
  };

  // 드롭이 허용되는 대상인지(상단 전용 키 접기는 하단 존에 놓을 수 없다).
  const isValidTarget = (t: DropTarget | null, key: string): boolean =>
    !!t && !(t.kind === "zone" && t.bar === "bottom" && isTopOnlyKey(key));

  // 삽입 위치 표시 마커(드래그 중 어디로 들어갈지 세로선으로 보여준다).
  const marker = document.createElement("div");
  marker.className = "tb-drop-marker";
  const clearHints = (): void => {
    root
      .querySelectorAll(".tb-zone-slots--over")
      .forEach((el) => el.classList.remove("tb-zone-slots--over"));
    marker.remove();
  };

  // ── 포인터 드래그 상태 ──
  let drag: {
    key: string;
    source: HTMLElement;
    startX: number;
    startY: number;
    ghost: HTMLElement | null; // 문턱 넘기 전엔 null(클릭 오인 방지)
  } | null = null;

  // ── 콜아웃(칩을 지시선으로 가리키는 이름·위치 라벨) ──
  // 목업 안 칩은 아이콘 전용이라, 지금 가리키는/포커스한 칩 **하나만** 이름과 자리를 라벨로 알린다.
  // 목업(stage) 기준 절대 배치이므로 stage 참조를 들고 있는다(재렌더마다 갱신).
  const callout = document.createElement("div");
  callout.className = "tb-callout";
  callout.hidden = true;
  // 이름·자리는 칩 aria-label에 이미 있으므로 스크린리더엔 중복 낭독하지 않는다.
  callout.setAttribute("aria-hidden", "true");
  let stage: HTMLElement | null = null;

  // 콜아웃이 떠 있는 동안엔 존 헤더(좌/중/우 · 컨트롤)를 눌러 둔다 — 둘 다 본문 위 같은 띠에
  // 뜨므로 겹쳐 어수선해지고, 콜아웃이 이미 "상단 좌 4번째"로 같은 정보를 말한다.
  const setCalloutShown = (shown: boolean): void => {
    callout.hidden = !shown;
    root.classList.toggle("tb-editor--callout", shown);
  };

  const hideCallout = (): void => {
    setCalloutShown(false);
  };

  /**
   * 칩의 이름·자리를 **본문 쪽**(상단 바는 아래로, 하단 바는 위로)에 띄우고 지시선으로 잇는다.
   * 바 바깥은 컨트롤 줄이 차지하고 있어서 안쪽으로 겹친다. 세로 기준은 칩이 아니라 **스트립 경계**다
   * — 칩은 바 안에서 세로 중앙이라 칩 기준으로 재면 라벨이 존 라벨과 겹친다. 드래그 중엔 띄우지 않는다.
   */
  const showCallout = (key: string, chipEl: HTMLElement): void => {
    const loc = locateItem(layout, key);
    const strip = chipEl.closest<HTMLElement>(".tb-editor-zones");
    if (drag || !stage || !loc || !strip) return;
    const meta = metaByKey.get(key);
    const name = meta?.name ?? friendlyKeyLabel(key);
    callout.textContent = `${name} · ${itemPositionLabel(layout, key)}`;
    setCalloutShown(true);
    callout.classList.toggle("tb-callout--below", loc.bar === "bottom");
    // 칩 중심에 맞추되 목업 폭 안으로 클램프하고(양 끝 칩에서 라벨이 잘려 나가지 않게),
    // 지시선은 클램프와 무관하게 칩 중심을 가리키도록 라벨 안 offset으로 넘긴다.
    const s = stage.getBoundingClientRect();
    const c = chipEl.getBoundingClientRect();
    const w = callout.offsetWidth;
    const center = c.left - s.left + c.width / 2;
    const left = Math.max(0, Math.min(s.width - w, center - w / 2));
    callout.style.left = `${left}px`;
    callout.style.setProperty("--tb-tick-x", `${center - left}px`);
    const bar = strip.getBoundingClientRect();
    callout.style.top =
      loc.bar === "top"
        ? `${bar.bottom - s.top + CALLOUT_GAP}px`
        : `${bar.top - s.top - callout.offsetHeight - CALLOUT_GAP}px`;
  };

  // ── 포인터 드래그 핸들러 ──
  const onPointerMove = (e: MouseEvent): void => {
    if (!drag) return;
    if (!drag.ghost) {
      // 문턱을 넘어야 실제 드래그로 인정한다(작은 흔들림은 클릭).
      if (
        Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
      )
        return;
      const ghost = drag.source.cloneNode(true) as HTMLElement;
      ghost.classList.add("tb-chip--ghost");
      document.body.append(ghost);
      drag.source.classList.add("tb-chip--dragging");
      drag.ghost = ghost;
    }
    drag.ghost.style.left = `${e.clientX + 10}px`;
    drag.ghost.style.top = `${e.clientY + 10}px`;
    clearHints();
    const t = targetAt(e.clientX, e.clientY);
    if (!isValidTarget(t, drag.key) || !t) return;
    t.el.classList.add("tb-zone-slots--over");
    if (t.kind === "zone") {
      // 삽입될 자리(제외 후 index)의 칩 앞에 마커를 끼운다(끝이면 맨 뒤).
      const chips = [...t.el.querySelectorAll<HTMLElement>(".tb-chip")].filter(
        (c) => c.dataset.itemKey !== drag!.key,
      );
      const idx = dropIndex(t.el, e.clientX, e.clientY, drag.key);
      t.el.insertBefore(marker, chips[idx] ?? null);
    }
  };

  const onPointerUp = (e: MouseEvent): void => {
    document.removeEventListener("mousemove", onPointerMove);
    document.removeEventListener("mouseup", onPointerUp);
    const d = drag;
    drag = null;
    clearHints();
    if (!d || !d.ghost) return; // 문턱 미달 = 클릭(무동작).
    d.ghost.remove();
    d.source.classList.remove("tb-chip--dragging");
    const t = targetAt(e.clientX, e.clientY);
    if (!isValidTarget(t, d.key) || !t) return; // 밖·허용 안 되는 대상 = 무동작.
    if (t.kind === "palette") {
      commit(moveItem(layout, d.key, null));
    } else {
      commit(
        moveItem(layout, d.key, {
          bar: t.bar,
          zone: t.zone,
          index: dropIndex(t.el, e.clientX, e.clientY, d.key),
        }),
      );
    }
  };

  const startPointerDrag = (
    key: string,
    source: HTMLElement,
    e: MouseEvent,
  ): void => {
    if (e.button !== 0) return;
    e.preventDefault(); // 텍스트 선택 방지.
    hideCallout(); // 끌기 시작 = 고스트가 안내를 대신한다(라벨이 커서를 따라다니지 않게).
    drag = { key, source, startX: e.clientX, startY: e.clientY, ghost: null };
    document.addEventListener("mousemove", onPointerMove);
    document.addEventListener("mouseup", onPointerUp);
  };

  // 한 아이템 칩(포인터 드래그 + 키보드). placed=배치됨(존 안), false=팔레트.
  const chip = (key: string, placed: boolean): HTMLElement => {
    const meta = metaByKey.get(key);
    const name = meta?.name ?? friendlyKeyLabel(key);
    const el = document.createElement("div");
    // 목업 안(placed)은 실제 바 높이에 맞춘 아이콘 전용 칩, 팔레트는 이름까지 보이는 칩.
    // 글리프가 아이콘이 아니라 문장인 레이블형(상태 표시 등)은 아이콘 칸에서 줄바꿈돼 깨지므로
    // 표시를 CSS로 바꾼다 — 목업에선 한 줄 텍스트(말줄임), 팔레트에선 이름만(문장 중복 제거).
    const labelLike = !meta?.iconSvg && isLabelGlyph(meta?.glyph ?? "");
    el.className = `tb-chip${placed ? " tb-chip--placed" : ""}${
      labelLike ? " tb-chip--label" : ""
    }`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.dataset.itemKey = key;
    el.setAttribute(
      "aria-label",
      placed
        ? t("settings.toolbar-layout.chip-aria-placed", {
            name,
            position: itemPositionLabel(layout, key) ?? "",
          })
        : t("settings.toolbar-layout.chip-aria-unplaced", { name }),
    );
    const icon = document.createElement("span");
    icon.className = "tb-chip-icon";
    icon.setAttribute("aria-hidden", "true");
    if (meta?.iconSvg)
      icon.innerHTML = meta.iconSvg; // 내장 = 신뢰 SVG
    else icon.textContent = meta?.glyph ?? "•"; // 플러그인 글리프 = 텍스트만
    const label = document.createElement("span");
    label.className = "tb-chip-name";
    label.textContent = name; // 이름 = 텍스트만
    el.append(icon, label);
    el.addEventListener("mousedown", (e) => startPointerDrag(key, el, e));
    // 배치된 칩은 가리키거나 포커스하면 이름·자리 콜아웃을 띄운다(아이콘만으론 무엇인지 모르므로).
    if (placed) {
      el.addEventListener("mouseenter", () => showCallout(key, el));
      el.addEventListener("focus", () => showCallout(key, el));
      el.addEventListener("mouseleave", hideCallout);
      el.addEventListener("blur", hideCallout);
    }
    // 키보드: 배치된 칩은 ←/→로 존 안 이동, Delete/Backspace로 팔레트. 팔레트 칩은 Enter/Space로 배치.
    el.addEventListener("keydown", (e) => {
      const loc = locateItem(layout, key);
      if (loc) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const index = loc.index + (e.key === "ArrowRight" ? 1 : -1);
          // 존의 양 끝에선 no-op(불필요한 저장·재렌더 방지).
          if (index < 0 || index >= layout[loc.bar].zones[loc.zone].length)
            return;
          commit(
            moveItem(layout, key, { bar: loc.bar, zone: loc.zone, index }),
            key,
          );
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          commit(moveItem(layout, key, null), key);
        } else if (e.key === " ") {
          e.preventDefault(); // 배치된 칩에서 Space는 페이지 스크롤 방지(무동작).
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const target = firstZone(key);
        if (target)
          commit(
            moveItem(layout, key, {
              ...target,
              index: Number.MAX_SAFE_INTEGER,
            }),
            key,
          );
      }
    });
    return el;
  };

  const render = (): void => {
    root.replaceChildren();

    // 두 바의 설정을 **위에 모아** 쌓는다(상단 바 → 하단 바). 바마다 이름이 한 줄, 그 아래 줄에
    // 단 수·정렬·단별 컨트롤. 목업은 순수 미리보기로 남겨 조작 요소가 하나도 얹히지 않게 한다.
    const bars = document.createElement("div");
    bars.className = "tb-editor-bars";
    for (const bar of ["top", "bottom"] as const)
      bars.append(buildBarControls(bar));
    root.append(bars);

    // 노트 창 목업 — 상단 스트립 · 본문 · 하단 스트립. 테두리는 셋을 가로지르는 장식 레이어
    // (tb-note-frame)가 한 겹으로 그린다. DOM 순서 = 화면 순서라 읽는 순서도 그대로다.
    const preview = document.createElement("div");
    preview.className = "tb-editor-preview";
    const vTitle = document.createElement("h4");
    vTitle.className = "tb-preview-title";
    vTitle.textContent = t("settings.toolbar-layout.preview-title");
    stage = document.createElement("div");
    stage.className = "tb-editor-stage";
    const frame = document.createElement("div");
    frame.className = "tb-note-frame";
    frame.setAttribute("aria-hidden", "true");
    stage.append(
      frame,
      buildBarStrip("top"),
      noteBodyMock(),
      buildBarStrip("bottom"),
      callout,
    );
    // 초기화는 **되돌릴 게 있을 때만** 미리보기 한가운데에 띄운다 — 기본 배치 그대로면 눌러도
    // 아무 일이 없어 자리만 차지한다. 판정은 저장 이력이 아니라 내용 비교(isDefaultLayout)라,
    // 이리저리 옮겼다 원래대로 되돌려 놓으면 다시 사라진다. 팔레트를 함께 넘기는 이유: 지금
    // layout은 마운트 때 폴백을 실제로 채운(materializeFallbacks) 값이라, 기본 배치 쪽에도
    // 같은 자동 배치를 태워야 "초기화를 눌러도 그대로인가"를 같은 기준으로 비교한다.
    if (!isDefaultLayout(layout, opts.paletteItems, opts.isAvailable)) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "tb-reset-btn";
      reset.textContent = t("settings.toolbar-layout.reset-button");
      reset.addEventListener("click", resetToDefault);
      stage.append(reset);
    }
    preview.append(vTitle, stage);
    root.append(preview);
    hideCallout(); // 칩이 새로 생겼으니 이전 콜아웃(사라진 칩을 가리키던 라벨)은 닫는다.

    // 팔레트(미배치) — 드롭하면 배치에서 빠진다(포인터 드래그가 targetAt으로 인식).
    const palette = document.createElement("div");
    palette.className = "tb-editor-palette";
    const pTitle = document.createElement("h4");
    pTitle.textContent = t("settings.toolbar-layout.palette-title");
    const pItems = document.createElement("div");
    pItems.className = "tb-palette-items";
    pItems.setAttribute("role", "group");
    pItems.setAttribute(
      "aria-label",
      t("settings.toolbar-layout.palette-aria-label"),
    );
    const unplaced = unplacedItems(layout, opts.paletteItems);
    if (unplaced.length === 0) {
      const empty = document.createElement("span");
      empty.className = "tb-palette-empty";
      empty.textContent = t("settings.toolbar-layout.palette-empty");
      pItems.append(empty);
    } else {
      for (const it of unplaced) pItems.append(chip(it.key, false));
    }
    palette.append(pTitle, pItems);
    root.append(palette);
  };

  /** 한 바의 설정 블록 — 이름 한 줄 + 그 아래 줄에 단 수·정렬·단별 컨트롤(목업 위가 아니라 여기). */
  const buildBarControls = (bar: BarId): HTMLElement => {
    const barLayout = layout[bar];
    const tier = barLayout.zones.length;

    const block = document.createElement("div");
    block.className = "tb-editor-bar";
    block.dataset.bar = bar;

    const label = document.createElement("span");
    label.className = "tb-editor-bar-label";
    label.textContent = t("settings.toolbar-layout.bar-block-label", {
      bar: barLabel(bar),
    });
    const header = document.createElement("div");
    header.className = "tb-editor-bar-head";
    block.append(label, header);

    // 단 선택(0·1·2·3) — 세그먼트 버튼.
    const tierGroup = document.createElement("div");
    tierGroup.className = "tb-tier-group";
    tierGroup.setAttribute("role", "group");
    tierGroup.setAttribute(
      "aria-label",
      t("settings.toolbar-layout.tier-group-label"),
    );
    for (let n = 0; n <= MAX_TIERS; n++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tb-tier-btn";
      b.textContent = t("settings.toolbar-layout.tier-count", { n });
      b.dataset.tier = String(n);
      b.setAttribute("aria-pressed", String(n === tier));
      b.addEventListener("click", () => commit(setTier(layout, bar, n)));
      tierGroup.append(b);
    }
    header.append(tierGroup);

    // 1단 정렬(좌/우) 토글.
    if (tier === 1) {
      const alignGroup = document.createElement("div");
      alignGroup.className = "tb-align-group";
      alignGroup.setAttribute("role", "group");
      alignGroup.setAttribute(
        "aria-label",
        t("settings.toolbar-layout.align-group-label"),
      );
      for (const a of ["left", "right"] as const) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tb-align-btn";
        b.textContent =
          a === "left"
            ? t("settings.toolbar-layout.zone-left")
            : t("settings.toolbar-layout.zone-right");
        b.dataset.align = a;
        b.setAttribute("aria-pressed", String(barLayout.align === a));
        b.addEventListener("click", () => commit(setAlign(layout, bar, a)));
        alignGroup.append(b);
      }
      header.append(alignGroup);
    }

    // 단별 컨트롤(줄임 우선순위 · 비우기) — 목업 위에 띄우지 않고 **바 컨트롤 줄에 고정**한다.
    // 왜: 목업 안에서 호버로 띄웠더니 (a) 칩이 포인터를 먼저 가져가 존의 빈 곳을 노려야 했고,
    // (b) 뜬 컨트롤로 마우스를 옮기는 순간 존 밖이라 사라져 누를 수가 없었다(호버 메뉴의 구조적
    // 결함). 어느 단인지는 목업의 존 라벨이 위치로 알려주므로, 조작은 늘 같은 자리에 있으면 된다.
    if (tier > 0) {
      const zoneCtls = document.createElement("div");
      zoneCtls.className = "tb-zone-controls";
      barLayout.zones.forEach((zoneKeys, zi) => {
        const zText = zoneLabel(barLayout.align, zi, tier);
        const ctl = document.createElement("div");
        ctl.className = "tb-zone-ctl";
        ctl.dataset.bar = bar;
        ctl.dataset.zone = String(zi);
        ctl.setAttribute("role", "group");
        ctl.setAttribute(
          "aria-label",
          t("settings.toolbar-layout.zone-settings-aria-label", {
            bar: barLabel(bar),
            zone: zText,
          }),
        );
        const name = document.createElement("span");
        name.className = "tb-zone-ctl-label";
        name.textContent = zText;
        ctl.append(name);

        // 줄임(⋯) 우선순위 — 2단 이상에서만 의미(어느 단부터 접힐지). 1단은 접힐 형제가 없어 생략.
        if (tier >= 2) {
          const fold = document.createElement("select");
          fold.className = "tb-zone-fold";
          fold.title = t("settings.toolbar-layout.fold-title");
          fold.setAttribute(
            "aria-label",
            t("settings.toolbar-layout.fold-aria-label", { zone: zText }),
          );
          for (const [val, text] of [
            ["0", t("settings.toolbar-layout.fold-first")],
            ["1", t("settings.toolbar-layout.fold-normal")],
            ["2", t("settings.toolbar-layout.fold-last")],
          ] as const) {
            const opt = document.createElement("option");
            opt.value = val;
            opt.textContent = text;
            if (Number(val) === foldRankOf(barLayout, zi)) opt.selected = true;
            fold.append(opt);
          }
          fold.addEventListener("change", () =>
            commit(setFoldRank(layout, bar, zi, Number(fold.value))),
          );
          ctl.append(fold);
        }

        // 이 단의 아이템을 모두 미배치로 보내는 버튼 — **비울 게 있을 때만**. 빈 단에선 눌러도
        // 아무 일이 없어 자리만 차지한다(초기화 버튼과 같은 기준).
        if (zoneKeys.length > 0) {
          const clearBtn = document.createElement("button");
          clearBtn.type = "button";
          clearBtn.className = "tb-zone-clear";
          clearBtn.textContent = t("settings.toolbar-layout.clear-button");
          clearBtn.title = t("settings.toolbar-layout.clear-title", {
            zone: zText,
          });
          clearBtn.setAttribute(
            "aria-label",
            t("settings.toolbar-layout.clear-aria-label", { zone: zText }),
          );
          clearBtn.addEventListener("click", () =>
            commit(clearZone(layout, bar, zi)),
          );
          ctl.append(clearBtn);
        }
        // 라벨만 남은 껍데기(1단 + 빈 단)는 아예 그리지 않는다.
        if (ctl.childElementCount > 1) zoneCtls.append(ctl);
      });
      if (zoneCtls.childElementCount > 0) header.append(zoneCtls);
    }
    return block;
  };

  /** 목업 안의 실제 바 스트립 — 존을 나란히 놓는다(조작 요소 없음, 드롭 대상과 라벨만). */
  const buildBarStrip = (bar: BarId): HTMLElement => {
    const barLayout = layout[bar];
    const tier = barLayout.zones.length;
    const zones = document.createElement("div");
    zones.className = "tb-editor-zones";
    zones.dataset.bar = bar;
    if (tier === 0) {
      const none = document.createElement("div");
      none.className = "tb-zone-none";
      // 상단은 0단이어도 창 이동용 스트립으로 남고(노트 창 스펙), 하단은 통째로 사라진다.
      none.textContent =
        bar === "top"
          ? t("settings.toolbar-layout.zone-none-top")
          : t("settings.toolbar-layout.zone-none-bottom");
      zones.append(none);
    } else {
      barLayout.zones.forEach((zoneKeys, zi) => {
        const drop = document.createElement("div");
        // 빈 존은 라벨(좌/중/우)을 계속 보여준다 — 어디에 떨어뜨릴 수 있는지 알려주는 유일한 단서.
        drop.className =
          zoneKeys.length === 0
            ? "tb-zone-drop tb-zone-drop--empty"
            : "tb-zone-drop";
        drop.dataset.bar = bar;
        drop.dataset.zone = String(zi);
        // 노트 렌더와 **같은** 규칙으로 칩을 좌/중/우에 붙인다 — 보이는 대로 배치되게. 존 라벨도
        // 같은 값을 따라가 그 단의 칩이 붙는 **바로 그 가장자리**에 선다(가운데 떠 있으면 어느
        // 단을 가리키는지 모호하다).
        drop.dataset.align = zoneAlignOf(barLayout, zi);
        const zText = zoneLabel(barLayout.align, zi, tier);
        // 목업 위에 뜨는 것은 **전부 비대화형**이다 — 존 라벨은 빈 단에서만 "여기"라고 알린다
        // (칩이 있으면 위치가 이미 말해주므로 CSS가 감춘다). 조작은 위 컨트롤 줄에 고정.
        const zHead = document.createElement("div");
        zHead.className = "tb-zone-drop-head";
        const zLabel = document.createElement("span");
        zLabel.className = "tb-zone-drop-label";
        zLabel.textContent = zText;
        zHead.append(zLabel);
        const slots = document.createElement("div");
        slots.className = "tb-zone-slots";
        slots.dataset.bar = bar;
        slots.dataset.zone = String(zi);
        slots.setAttribute("role", "group");
        slots.setAttribute(
          "aria-label",
          t("settings.toolbar-layout.zone-group-aria-label", {
            bar: barLabel(bar),
            zone: zText,
          }),
        );
        for (const key of zoneKeys) slots.append(chip(key, true));
        drop.append(zHead, slots);
        zones.append(drop);
      });
    }
    return zones;
  };

  render();
  return root;
}
