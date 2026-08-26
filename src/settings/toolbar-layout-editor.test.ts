import { describe, it, expect, vi } from "vitest";
import {
  itemPositionLabel,
  renderToolbarLayoutEditor,
  unplacedItems,
  type LayoutPaletteItem,
} from "./toolbar-layout-editor";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_MAC,
  DEFAULT_LAYOUT_WINDOWS,
  pruneLayout,
  type ToolbarLayout,
} from "../note/toolbar-layout";

const PALETTE: LayoutPaletteItem[] = [
  { key: "core:preview", name: "프리뷰", iconSvg: "<svg></svg>" },
  { key: "core:delete", name: "삭제", iconSvg: "<svg></svg>" },
  { key: "plugin:demo:btn", name: "데모", glyph: "📋" },
  { key: "core:archive", name: "보관", iconSvg: "<svg></svg>" },
  // `position`을 선언한 버튼(= 설치 직후 자동 배치되는 서드파티 버튼)을 픽스처에 상시 둔다 —
  // 이 경로가 빠져 있어서 "초기화 버튼이 항상 뜬다" 결함이 테스트를 통과했다.
  {
    key: "plugin:demo:auto",
    name: "자동배치",
    glyph: "✨",
    position: "bottom-right",
  },
];

function layout(): ToolbarLayout {
  return {
    top: { align: "left", zones: [["core:preview"], ["core:delete"]] },
    bottom: { align: "left", zones: [] },
  };
}

/**
 * 포인터 기반 드래그를 흉내낸다: elementFromPoint를 목적지로 고정하고 source에 mousedown →
 * 문서에 mousemove(문턱 초과) → mouseup을 발생시킨다(x,y는 목적지 포인터 좌표).
 */
function pointerDrag(
  source: HTMLElement,
  target: HTMLElement,
  x = 50,
  y = 0,
): void {
  const orig = document.elementFromPoint;
  document.elementFromPoint = () => target;
  try {
    source.dispatchEvent(
      new MouseEvent("mousedown", {
        button: 0,
        clientX: 0,
        clientY: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: x, clientY: y, bubbles: true }),
    );
  } finally {
    document.elementFromPoint = orig;
  }
}

describe("unplacedItems", () => {
  it("배치되지 않은 아이템만 팔레트 순서대로 돌려준다", () => {
    const un = unplacedItems(layout(), PALETTE);
    expect(un.map((i) => i.key)).toEqual([
      "plugin:demo:btn",
      "core:archive",
      "plugin:demo:auto",
    ]);
  });
});

describe("itemPositionLabel", () => {
  it("배치된 아이템의 바·단·순번을 사람 말로 낸다", () => {
    expect(itemPositionLabel(layout(), "core:preview")).toBe("상단 좌 1번째");
    expect(itemPositionLabel(layout(), "core:delete")).toBe("상단 우 1번째");
  });

  it("3단은 좌·중·우로, 순번은 1부터 센다", () => {
    const three: ToolbarLayout = {
      top: { align: "left", zones: [] },
      bottom: {
        align: "left",
        zones: [[], [], ["core:archive", "core:delete"]],
      },
    };
    expect(itemPositionLabel(three, "core:delete")).toBe("하단 우 2번째");
  });

  it("미배치면 null", () => {
    expect(itemPositionLabel(layout(), "core:archive")).toBeNull();
  });
});

describe("renderToolbarLayoutEditor — 노트 목업", () => {
  it("두 바의 설정을 위에 모으고 그 아래 미리보기·팔레트 순으로 쌓는다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    // 화면 순서 = DOM 순서(그리드로 뒤섞지 않는다 — 읽는 순서도 같아야 한다).
    const order = [...el.children].map((c) => c.className.split(" ")[0]);
    expect(order).toEqual([
      "tb-editor-bars",
      "tb-editor-preview",
      "tb-editor-palette",
    ]);
    // 상단 바 블록이 먼저, 하단 바 블록이 다음.
    const bars = el.querySelectorAll<HTMLElement>(".tb-editor-bars > *");
    expect([...bars].map((b) => b.dataset.bar)).toEqual(["top", "bottom"]);
    // 바 이름은 자기 줄, 단 수·단별 컨트롤은 그 아래 줄(.tb-editor-bar-head).
    expect(bars[0].querySelector(".tb-editor-bar-label")!.textContent).toBe(
      "상단 바",
    );
    expect(
      bars[0].querySelector(".tb-editor-bar-head > .tb-tier-group"),
    ).not.toBeNull();
    // 미리보기의 바 스트립엔 조작 요소가 없다(순수 프리뷰 + 드롭 대상).
    const strips = el.querySelectorAll<HTMLElement>(".tb-editor-zones");
    expect(
      [...strips].flatMap((s) => [
        ...s.querySelectorAll("button, select, input"),
      ]).length,
    ).toBe(0);
  });

  it("노트 모양(테두리·본문)과 상/하 바 스트립을 한 그림에 그린다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const stage = el.querySelector<HTMLElement>(".tb-editor-stage")!;
    expect(stage).not.toBeNull();
    expect(stage.querySelector(".tb-note-frame")).not.toBeNull();
    // 본문 가짜 줄은 장식이라 스크린리더에서 감춘다.
    const body = stage.querySelector<HTMLElement>(".tb-note-body")!;
    expect(body.getAttribute("aria-hidden")).toBe("true");
    expect(body.querySelectorAll(".tb-note-line").length).toBe(4);
    // 스트립은 바별로 하나씩(그리드 행 배치를 CSS가 data-bar로 고른다).
    expect(
      stage.querySelectorAll('.tb-editor-zones[data-bar="top"]').length,
    ).toBe(1);
    expect(
      stage.querySelectorAll('.tb-editor-zones[data-bar="bottom"]').length,
    ).toBe(1);
  });

  it("존의 정렬은 노트 렌더와 같은 규칙(zoneAlignOf)을 따른다 — 칩과 라벨이 함께 따라간다", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        // 상단 2단(좌·우) + 하단 1단 우정렬.
        top: { align: "left", zones: [["core:preview"], ["core:delete"]] },
        bottom: { align: "right", zones: [["core:archive"]] },
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const align = (bar: string, zone: number) =>
      el.querySelector<HTMLElement>(
        `.tb-zone-drop[data-bar="${bar}"][data-zone="${zone}"]`,
      )!.dataset.align;
    expect([align("top", 0), align("top", 1)]).toEqual(["left", "right"]);
    expect(align("bottom", 0)).toBe("right");
  });

  // 목업 위에 호버로 컨트롤을 띄우면 (a) 칩이 포인터를 먼저 가져가고 (b) 컨트롤로 마우스를 옮기는
  // 순간 존 밖이라 사라져 누를 수 없었다. 그래서 조작은 바 컨트롤 줄에 고정하고, 목업 위엔 라벨만.
  it("단별 컨트롤(줄임 우선순위·비우기)은 바 컨트롤 줄에 고정된다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(), // top 2단
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const head = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"] > .tb-editor-bar-head',
    )!;
    const ctls = head.querySelectorAll<HTMLElement>(".tb-zone-ctl");
    expect(ctls.length).toBe(2);
    expect(ctls[0].querySelector(".tb-zone-ctl-label")!.textContent).toBe("좌");
    expect(ctls[0].querySelector(".tb-zone-fold")).not.toBeNull();
    expect(ctls[0].querySelector(".tb-zone-clear")).not.toBeNull();
    // 0단 바에는 단이 없으니 컨트롤도 없다.
    expect(el.querySelectorAll('.tb-zone-ctl[data-bar="bottom"]').length).toBe(
      0,
    );
  });

  // 비울 게 없는 단에서 눌러도 아무 일이 없는 버튼은 자리만 차지한다(초기화 버튼과 같은 기준).
  it("'비우기'는 그 단에 버튼이 있을 때만 뜨고, 라벨만 남는 그룹은 아예 안 그린다", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        // 상단 2단: 좌=채움, 우=빔(우는 줄임 우선순위가 남아 그룹은 유지).
        top: { align: "left", zones: [["core:preview"], []] },
        // 하단 1단 빔: 줄임 우선순위도 없어(1단) 남길 게 라벨뿐 → 그룹 자체를 생략.
        bottom: { align: "left", zones: [[]] },
        // 자동 배치 픽스처(plugin:demo:auto)는 "이미 아는 키"로 둔다 — 그래야 하단이 빈 채로
        // 남아 이 검사(빈 단의 컨트롤 생략)가 원래 겨냥한 상태를 그대로 본다.
        seen: ["plugin:demo:auto"],
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const ctl = (bar: string, zone: number) =>
      el.querySelector<HTMLElement>(
        `.tb-zone-ctl[data-bar="${bar}"][data-zone="${zone}"]`,
      );
    expect(ctl("top", 0)!.querySelector(".tb-zone-clear")).not.toBeNull();
    expect(ctl("top", 1)!.querySelector(".tb-zone-clear")).toBeNull();
    expect(ctl("top", 1)!.querySelector(".tb-zone-fold")).not.toBeNull();
    expect(ctl("bottom", 0)).toBeNull();
    // 그룹이 하나도 없으면 감싸는 줄도 그리지 않는다.
    expect(
      el.querySelector('.tb-editor-bar[data-bar="bottom"] .tb-zone-controls'),
    ).toBeNull();
  });

  it("목업 위 존 헤더에는 라벨만 있고 조작 요소가 없다(호버 이동 중 사라짐 방지)", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const head = el.querySelector<HTMLElement>(
      '.tb-zone-drop[data-bar="top"][data-zone="0"] .tb-zone-drop-head',
    )!;
    expect(head.querySelector(".tb-zone-drop-label")!.textContent).toBe("좌");
    expect(head.querySelectorAll("button, select, input").length).toBe(0);
  });

  it("콜아웃이 떠 있는 동안엔 존 헤더를 눌러 둔다(같은 띠에 둘이 겹치지 않게)", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const chip = el.querySelector<HTMLElement>(
      '.tb-zone-slots [data-item-key="core:preview"]',
    )!;
    expect(el.classList.contains("tb-editor--callout")).toBe(false);
    chip.dispatchEvent(new MouseEvent("mouseenter"));
    expect(el.classList.contains("tb-editor--callout")).toBe(true);
    chip.dispatchEvent(new MouseEvent("mouseleave"));
    expect(el.classList.contains("tb-editor--callout")).toBe(false);
  });

  it("목업 안 칩은 아이콘 전용(tb-chip--placed), 팔레트 칩은 이름까지 보인다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const placed = el.querySelector<HTMLElement>(
      '.tb-zone-slots [data-item-key="core:preview"]',
    )!;
    expect(placed.classList.contains("tb-chip--placed")).toBe(true);
    // 아이콘만 보이더라도 이름·자리는 aria-label로 읽힌다.
    expect(placed.getAttribute("aria-label")).toContain(
      "프리뷰 · 상단 좌 1번째",
    );
    const inPalette = el.querySelector<HTMLElement>(
      '.tb-palette-items [data-item-key="core:archive"]',
    )!;
    expect(inPalette.classList.contains("tb-chip--placed")).toBe(false);
  });

  it("문장 글리프(상태 표시)는 레이블형 칩으로 그린다 — 아이콘 칸에서 줄바꿈돼 깨지지 않게", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["plugin:word-count:wc"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: [
        {
          key: "plugin:word-count:wc",
          name: "단어 수 · 글자 수",
          glyph: "0 단어 · 0 자",
        },
        ...PALETTE,
      ],
      onChange: vi.fn(),
    });
    const placed = el.querySelector<HTMLElement>(
      '.tb-zone-slots [data-item-key="plugin:word-count:wc"]',
    )!;
    expect(placed.classList.contains("tb-chip--label")).toBe(true);
    // 문구 자체는 그대로 둔다(목업이 노트 실물과 같아야 한다) — 폭·말줄임은 CSS가 맡는다.
    expect(placed.querySelector(".tb-chip-icon")!.textContent).toBe(
      "0 단어 · 0 자",
    );
  });

  it("아이콘 글리프(이모지·A−)와 내장 SVG는 레이블형이 아니다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: [
        ...PALETTE,
        { key: "plugin:font-scale:minus", name: "글자 작게", glyph: "A−" },
      ],
      onChange: vi.fn(),
    });
    const cls = (key: string) =>
      el
        .querySelector<HTMLElement>(`[data-item-key="${key}"]`)!
        .classList.contains("tb-chip--label");
    expect(cls("core:preview")).toBe(false); // 내장 SVG
    expect(cls("plugin:demo:btn")).toBe(false); // 이모지 한 글자
    expect(cls("plugin:font-scale:minus")).toBe(false); // 두 글자 텍스트
  });

  it("빈 존은 tb-zone-drop--empty로 표시된다(라벨을 계속 보이게)", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview"], []] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const drops = el.querySelectorAll<HTMLElement>(
      '.tb-zone-drop[data-bar="top"]',
    );
    expect(drops[0].classList.contains("tb-zone-drop--empty")).toBe(false);
    expect(drops[1].classList.contains("tb-zone-drop--empty")).toBe(true);
  });

  it("0단 안내는 상단(드래그 스트립으로 남음)과 하단(사라짐)이 다르다", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const text = (bar: string) =>
      el.querySelector<HTMLElement>(
        `.tb-editor-zones[data-bar="${bar}"] .tb-zone-none`,
      )!.textContent;
    expect(text("top")).toContain("창 이동 스트립");
    expect(text("bottom")).toContain("메모 영역");
  });

  it("배치 칩을 가리키면 이름·자리 콜아웃이 뜨고, 벗어나면 닫힌다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const callout = el.querySelector<HTMLElement>(".tb-callout")!;
    expect(callout.hidden).toBe(true);
    const chip = el.querySelector<HTMLElement>(
      '.tb-zone-slots [data-item-key="core:delete"]',
    )!;
    chip.dispatchEvent(new MouseEvent("mouseenter"));
    expect(callout.hidden).toBe(false);
    expect(callout.textContent).toBe("삭제 · 상단 우 1번째");
    chip.dispatchEvent(new MouseEvent("mouseleave"));
    expect(callout.hidden).toBe(true);
  });

  it("팔레트 칩은 콜아웃을 띄우지 않는다(자리가 없다)", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const callout = el.querySelector<HTMLElement>(".tb-callout")!;
    el.querySelector<HTMLElement>(
      '.tb-palette-items [data-item-key="core:archive"]',
    )!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(callout.hidden).toBe(true);
  });
});

describe("renderToolbarLayoutEditor — 렌더", () => {
  it("상/하 바와 단 버튼(0~3), 존 드롭영역, 팔레트를 그린다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    // 바 설정 블록 두 개(목업 위에 모여 있고, 스트립은 목업 안이라 data-bar로 짝짓는다).
    expect(el.querySelectorAll(".tb-editor-bar").length).toBe(2);
    // 각 바에 0·1·2·3단 버튼 4개.
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    expect(top.querySelectorAll(".tb-tier-btn").length).toBe(4);
    // 상단은 2단 → 존 드롭영역 2개, 라벨 좌/우.
    const drops = el.querySelectorAll<HTMLElement>(
      '.tb-zone-drop[data-bar="top"]',
    );
    expect(drops.length).toBe(2);
    expect(drops[0].querySelector(".tb-zone-drop-label")!.textContent).toBe(
      "좌",
    );
    expect(drops[1].querySelector(".tb-zone-drop-label")!.textContent).toBe(
      "우",
    );
    // 배치된 칩은 존 안에, 미배치는 팔레트에.
    expect(
      drops[0].querySelector('[data-item-key="core:preview"]'),
    ).not.toBeNull();
    const palette = el.querySelector<HTMLElement>(".tb-palette-items")!;
    expect(
      palette.querySelector('[data-item-key="plugin:demo:btn"]'),
    ).not.toBeNull();
  });

  it("하단 0단이면 '바 없음' 안내를 보인다", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const strip = el.querySelector<HTMLElement>(
      '.tb-editor-zones[data-bar="bottom"]',
    )!;
    expect(strip.querySelector(".tb-zone-none")).not.toBeNull();
    expect(strip.querySelector(".tb-zone-drop")).toBeNull();
  });

  it("1단일 때만 정렬(좌/우) 토글이 뜬다", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "right", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    expect(top.querySelector(".tb-align-group")).not.toBeNull();
    // 현재 정렬(우)이 눌린 상태.
    const right = top.querySelector<HTMLElement>(
      '.tb-align-btn[data-align="right"]',
    )!;
    expect(right.getAttribute("aria-pressed")).toBe("true");
    // 하단(0단)엔 정렬 토글 없음.
    const bottom = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="bottom"]',
    )!;
    expect(bottom.querySelector(".tb-align-group")).toBeNull();
  });

  it("빈 팔레트면 안내 문구를 보인다", () => {
    const full: ToolbarLayout = {
      top: {
        align: "left",
        zones: [
          [
            "core:preview",
            "core:delete",
            "plugin:demo:btn",
            "core:archive",
            "plugin:demo:auto",
          ],
        ],
      },
      bottom: { align: "left", zones: [] },
    };
    const el = renderToolbarLayoutEditor({
      layout: full,
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    expect(el.querySelector(".tb-palette-empty")).not.toBeNull();
  });

  it("플러그인 글리프·이름은 textContent로만 렌더한다(XSS 안전)", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["plugin:x:evil"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: [
        { key: "plugin:x:evil", name: "<img src=x>", glyph: "<b>g</b>" },
      ],
      onChange: vi.fn(),
    });
    const chip = el.querySelector<HTMLElement>(
      '[data-item-key="plugin:x:evil"]',
    )!;
    // 이름/글리프에 마크업이 주입되지 않는다.
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.querySelector("b")).toBeNull();
    expect(chip.querySelector(".tb-chip-name")!.textContent).toBe(
      "<img src=x>",
    );
  });
});

describe("renderToolbarLayoutEditor — 상호작용", () => {
  it("단 버튼 클릭이 setTier를 적용하고 onChange를 부른다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange,
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    top
      .querySelector<HTMLButtonElement>('.tb-tier-btn[data-tier="1"]')!
      .click();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.top.zones.length).toBe(1); // 2단 → 1단
    // core:delete(사라진 존)는 미배치가 되어 팔레트로.
    const palette = el.querySelector<HTMLElement>(".tb-palette-items")!;
    expect(
      palette.querySelector('[data-item-key="core:delete"]'),
    ).not.toBeNull();
  });

  it("1단 정렬 버튼 클릭이 setAlign을 적용한다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange,
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    top
      .querySelector<HTMLButtonElement>('.tb-align-btn[data-align="right"]')!
      .click();
    expect((onChange.mock.calls[0][0] as ToolbarLayout).top.align).toBe(
      "right",
    );
  });

  it("포인터로 팔레트 칩을 존에 끌어다 놓으면 그 존으로 옮겨진다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange,
    });
    const demo = el.querySelector<HTMLElement>(
      '[data-item-key="plugin:demo:btn"]',
    )!;
    const slots = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="top"][data-zone="0"]',
    )!;
    pointerDrag(demo, slots);
    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0] as ToolbarLayout;
    expect(next.top.zones[0]).toContain("plugin:demo:btn");
  });

  it("포인터로 칩을 팔레트에 끌어다 놓으면 미배치가 된다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange,
    });
    const preview = el.querySelector<HTMLElement>(
      '[data-item-key="core:preview"]',
    )!;
    const pItems = el.querySelector<HTMLElement>(".tb-palette-items")!;
    pointerDrag(preview, pItems);
    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0] as ToolbarLayout;
    expect(next.top.zones[0]).not.toContain("core:preview");
  });

  it("문턱 미만 이동(클릭)은 아무 것도 바꾸지 않는다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange,
    });
    const preview = el.querySelector<HTMLElement>(
      '[data-item-key="core:preview"]',
    )!;
    const slots = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="top"][data-zone="1"]',
    )!;
    pointerDrag(preview, slots, 2, 0); // 2px < 문턱 → 클릭
    expect(onChange).not.toHaveBeenCalled();
  });

  it("'기본 배치로 초기화'는 미리보기 안에 뜨고 DEFAULT_LAYOUT을 적용한다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange,
    });
    const reset = el.querySelector<HTMLButtonElement>(
      ".tb-editor-stage > .tb-reset-btn",
    )!;
    expect(reset).not.toBeNull();
    reset.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.top.zones.length).toBeGreaterThan(0);
    expect(next.bottom.zones.length).toBeGreaterThan(0);
  });

  /**
   * 가드(회귀): resetToDefault는 옛 단일 DEFAULT_LAYOUT(Windows 별칭)에 고정돼 있었다 —
   * opts.defaultLayout이 주어지면 그 값(예: 사용자가 고른 toolbar_style에 맞는
   * DEFAULT_LAYOUT_MAC)을 적용해야 한다. 안 그러면 Mac 스타일 사용자가 "기본 배치로 초기화"를
   * 누를 때 조용히 Windows 배치(닫기 버튼이 반대쪽)로 되돌아간다.
   */
  it("defaultLayout을 주면 초기화가 DEFAULT_LAYOUT이 아니라 그 값을 적용한다(Mac 스타일 보존)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      defaultLayout: DEFAULT_LAYOUT_MAC,
      onChange,
    });
    el.querySelector<HTMLButtonElement>(
      ".tb-editor-stage > .tb-reset-btn",
    )!.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    // Mac 배치: 닫기(core:archive)가 상단 좌측 존의 맨 앞.
    expect(next.top.zones[0][0]).toBe("core:archive");
  });

  /** 가드: defaultLayout을 생략하면 옛 동작(Windows 별칭 DEFAULT_LAYOUT)을 그대로 유지한다. */
  it("defaultLayout을 생략하면 DEFAULT_LAYOUT(Windows)으로 초기화한다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange,
    });
    el.querySelector<HTMLButtonElement>(
      ".tb-editor-stage > .tb-reset-btn",
    )!.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    // Windows 배치: 닫기(core:archive)가 상단 우측 존의 맨 끝.
    const winZone = DEFAULT_LAYOUT_WINDOWS.top.zones[1];
    const nextZone = next.top.zones[1];
    expect(nextZone[nextZone.length - 1]).toBe("core:archive");
    expect(winZone[winZone.length - 1]).toBe("core:archive");
  });

  /**
   * 가드(회귀): `position`을 선언한 플러그인 버튼이 팔레트에 있으면 편집기는 마운트 시 그것을
   * 자동 배치(materializeFallbacks)한 값을 들고 있다. 판정을 생짜 DEFAULT_LAYOUT과 비교하면
   * 그 차이 때문에 **아무것도 안 만졌는데** 초기화 버튼이 항상 떴다(서드파티 플러그인 설치만
   * 으로 재현). 기준은 "눌러도 배치가 그대로인가"이므로 자동 배치를 적용한 기본 배치와 비교한다.
   */
  it("자동 배치(position)된 버튼이 있어도 기본 배치면 초기화 버튼을 안 그린다", () => {
    const el = renderToolbarLayoutEditor({
      layout: structuredClone(DEFAULT_LAYOUT),
      paletteItems: PALETTE, // plugin:demo:auto가 position으로 하단 우에 자동 배치된다
      onChange: vi.fn(),
    });
    // 목업에는 자동 배치된 칩이 실제로 놓여 있다(실물과 같은 자리).
    expect(
      el.querySelector(
        '.tb-zone-slots[data-bar="bottom"] [data-item-key="plugin:demo:auto"]',
      ),
    ).not.toBeNull();
    // 그래도 "되돌릴 것"은 없다.
    expect(el.querySelector(".tb-reset-btn")).toBeNull();
  });

  // 기본 배치 그대로면 눌러도 아무 일이 없다 — 자리만 차지하므로 아예 렌더하지 않는다.
  it("기본 배치와 같으면 초기화 버튼을 렌더하지 않는다(되돌리면 다시 사라진다)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: structuredClone(DEFAULT_LAYOUT),
      paletteItems: PALETTE,
      onChange,
    });
    expect(el.querySelector(".tb-reset-btn")).toBeNull();
    // 하나를 미배치로 빼면 버튼이 나타나고, 초기화로 되돌리면 다시 사라진다.
    el.querySelector<HTMLElement>(
      '.tb-zone-slots [data-item-key="core:preview"]',
    )!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    const reset = el.querySelector<HTMLButtonElement>(".tb-reset-btn")!;
    expect(reset).not.toBeNull();
    reset.click();
    expect(el.querySelector(".tb-reset-btn")).toBeNull();
  });

  /**
   * 가드(회귀): 기본 배치 상수에는 조건부 내장 컨트롤(core:transparency 등)과 번들 플러그인
   * 버튼 키가 **하드코딩**돼 있다. 초기화가 그것을 그대로 복사하면, 대응 플러그인이 꺼져 있어도
   * 배치에 되살아나 목업에 정체 모를 칩("• core:transparency")으로 그려지고 저장까지 된다
   * (노트 창은 렌더 때 다시 pruneLayout하므로 툴바엔 안 나온다 — "미리보기에만 있는 유령").
   */
  it("초기화는 지금 쓸 수 없는 아이템(꺼진 플러그인·미가용 내장)을 되살리지 않는다", () => {
    const known = new Set(PALETTE.map((it) => it.key));
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      defaultLayout: DEFAULT_LAYOUT_WINDOWS,
      isAvailable: (key) => known.has(key),
      onChange,
    });
    el.querySelector<HTMLButtonElement>(".tb-reset-btn")!.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    const placed = [...next.top.zones, ...next.bottom.zones].flat();
    // 팔레트에 없는 키(투명도·핀·번들 버튼 등)는 하나도 들어오지 않는다.
    expect(placed.filter((k) => !known.has(k))).toEqual([]);
    expect(placed).toContain("core:preview"); // 가용한 기본 아이템은 그대로 온다.
    // 목업에도 유령 칩이 없다(메타 없는 키는 원본 키가 그대로 라벨로 노출됐다).
    expect(
      [...el.querySelectorAll<HTMLElement>(".tb-chip--placed")].map(
        (c) => c.dataset.itemKey,
      ),
    ).toEqual(placed);
  });

  /**
   * 가드(회귀): 위와 같은 뿌리 — 기준선도 필터를 거쳐야 한다. 조건부 컨트롤을 끈 사용자의
   * 배치는 이미 정리된(pruned) 상태라, 필터 안 된 기본 상수와 비교하면 **아무것도 안 만졌는데**
   * 초기화 버튼이 영구히 떠 있었다.
   */
  it("가용 아이템만 남은 기본 배치는 기본으로 보고 초기화 버튼을 안 그린다", () => {
    const known = new Set(PALETTE.map((it) => it.key));
    const el = renderToolbarLayoutEditor({
      layout: pruneLayout(structuredClone(DEFAULT_LAYOUT_WINDOWS), (k) =>
        known.has(k),
      ),
      paletteItems: PALETTE,
      defaultLayout: DEFAULT_LAYOUT_WINDOWS,
      isAvailable: (key) => known.has(key),
      onChange: vi.fn(),
    });
    expect(el.querySelector(".tb-reset-btn")).toBeNull();
  });

  it("0단 버튼은 잠기지 않는다(양쪽 0단 허용 — 드래그 스트립이 창 이동을 보장)", () => {
    const el = renderToolbarLayoutEditor({
      layout: layout(),
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    expect(
      top.querySelector<HTMLButtonElement>('.tb-tier-btn[data-tier="0"]')!
        .disabled,
    ).toBe(false);
  });

  it("2단 이상 존에 줄임 우선순위 select가 뜨고, 바꾸면 반영된다(1단엔 없음)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(), // top 2단, bottom 0단
      paletteItems: PALETTE,
      onChange,
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    const folds = top.querySelectorAll<HTMLSelectElement>(".tb-zone-fold");
    expect(folds.length).toBe(2); // 2단 → 존마다 하나
    // 첫 존을 '먼저 줄임'(0)으로.
    folds[0].value = "0";
    folds[0].dispatchEvent(new Event("change"));
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.top.foldRank?.[0]).toBe(0);
  });

  it("1단 바에는 줄임 우선순위 select가 없다", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange: vi.fn(),
    });
    expect(el.querySelector(".tb-zone-fold")).toBeNull();
  });

  it("단의 '비우기' 버튼이 그 단의 아이템을 전부 팔레트로 보낸다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview", "core:delete"]] },
        bottom: { align: "left", zones: [["core:archive"]] },
        // 자동 배치 픽스처는 "이미 아는 키"로 둔다 — 하단 존을 손대지 않아야 "비운 단만 비고
        // 나머지 단은 그대로"를 정확히 검사한다.
        seen: ["plugin:demo:auto"],
      },
      paletteItems: PALETTE,
      onChange,
    });
    const ctl = el.querySelector<HTMLElement>(
      '.tb-zone-ctl[data-bar="top"][data-zone="0"]',
    )!;
    ctl.querySelector<HTMLButtonElement>(".tb-zone-clear")!.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.top.zones[0]).toEqual([]);
    // 하단 존은 그대로.
    expect(next.bottom.zones[0]).toEqual(["core:archive"]);
  });

  it("접기(core:collapse)를 하단 존에 드롭하면 거부된다(상단 전용)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:collapse"]] },
        bottom: { align: "left", zones: [["core:archive"]] },
      },
      paletteItems: [
        { key: "core:collapse", name: "접기", iconSvg: "<svg></svg>" },
        ...PALETTE,
      ],
      onChange,
    });
    const collapse = el.querySelector<HTMLElement>(
      '[data-item-key="core:collapse"]',
    )!;
    const bottomSlots = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="bottom"][data-zone="0"]',
    )!;
    pointerDrag(collapse, bottomSlots);
    expect(onChange).not.toHaveBeenCalled(); // 하단 거부 → 무동작
  });

  it("배치된 칩에서 방향키가 존 안 순서를 바꾸고, Delete가 팔레트로 보낸다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview", "core:archive"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange,
    });
    const preview = () =>
      el.querySelector<HTMLElement>('[data-item-key="core:preview"]')!;
    preview().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    const c1 = onChange.mock.calls;
    let next = c1[c1.length - 1][0] as ToolbarLayout;
    expect(next.top.zones[0]).toEqual(["core:archive", "core:preview"]);
    // Delete → 팔레트(미배치).
    preview().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    next = onChange.mock.calls[
      onChange.mock.calls.length - 1
    ][0] as ToolbarLayout;
    expect(next.top.zones[0]).not.toContain("core:preview");
  });

  it("같은 존에서 오른쪽으로 드롭해도 한 칸 넘치지 않는다(드래그 칩 제외 off-by-one)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: {
          align: "left",
          zones: [["core:preview", "core:archive", "core:delete"]],
        },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: PALETTE,
      onChange,
    });
    const slots = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="top"][data-zone="0"]',
    )!;
    // 칩 위치를 흉내낸다: preview[0..20] archive[20..40] delete[40..60] (mid=10/30/50).
    const rect = (left: number, width: number) =>
      ({
        left,
        width,
        right: left + width,
        top: 0,
        bottom: 0,
        height: 0,
        x: left,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const byKey = (k: string) =>
      el.querySelector<HTMLElement>(`[data-item-key="${k}"]`)!;
    byKey("core:preview").getBoundingClientRect = () => rect(0, 20);
    byKey("core:archive").getBoundingClientRect = () => rect(20, 20);
    byKey("core:delete").getBoundingClientRect = () => rect(40, 20);
    // preview를 잡아 archive와 delete 사이(x=35)에 드롭 → [archive, preview, delete] 기대.
    pointerDrag(byKey("core:preview"), slots, 35, 0);
    const c = onChange.mock.calls;
    const next = c[c.length - 1][0] as ToolbarLayout;
    expect(next.top.zones[0]).toEqual([
      "core:archive",
      "core:preview",
      "core:delete",
    ]);
  });

  /** 가드: 상태 표시형 아이템도 버튼과 **같은 팔레트·같은 키 네임스페이스**라, 배치
   * 편집기에서 버튼과 동급으로 끌어 배치할 수 있다(사용자 확정). 편집기는 키가 버튼인지 상태
   * 아이템인지 구분하지 않는다 — main.ts가 statusItems를 palette로 흘리면 그대로 동작한다. */
  it("상태 아이템 키도 팔레트에서 존으로 드래그해 배치된다(버튼과 동급)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(), // 상단 2단(preview / delete), 상태 아이템은 미배치(팔레트)
      paletteItems: [
        ...PALETTE,
        // 상태 아이템 팔레트 항목: glyph=초기 텍스트, position=자동 배치 존.
        {
          key: "plugin:word-count:word-count",
          name: "단어 수",
          glyph: "0 단어",
        },
      ],
      onChange,
    });
    // 팔레트에 상태 아이템 칩이 떠 있다.
    const palChip = el.querySelector<HTMLElement>(
      '.tb-palette-items [data-item-key="plugin:word-count:word-count"]',
    )!;
    expect(palChip).not.toBeNull();
    // 상단 첫 존으로 끌어 놓으면 배치가 그 키를 포함한다.
    const slots = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="top"][data-zone="0"]',
    )!;
    pointerDrag(palChip, slots, 50, 0);
    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0] as ToolbarLayout;
    expect(next.top.zones[0]).toContain("plugin:word-count:word-count");
  });

  it("메타 없는 배치 키는 사람이 읽을 수 있게 표시한다(호스트 부재·비활성 플러그인)", () => {
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["plugin:word-count:word-count"]] },
        bottom: { align: "left", zones: [] },
      },
      paletteItems: [], // 팔레트 메타 없음
      onChange: vi.fn(),
    });
    const chip = el.querySelector<HTMLElement>(
      '[data-item-key="plugin:word-count:word-count"]',
    )!;
    expect(chip.querySelector(".tb-chip-name")!.textContent).toBe(
      "word-count · word-count",
    );
  });

  /** 가드: 커밋(저장)은 **이번 배치에 놓인 키 + 이번 편집으로 빠진 키**만 seen에 넣는다 —
   * 그래야 사용자가 방금 뺀 버튼은 다음 로드에서 폴백으로 되살아나지 않고, 손대지 않은
   * 미배치 버튼은 계속 "미확인"으로 남는다. */
  it("커밋은 배치된 키와 이번에 빠진 키만 seen에 넣는다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: layout(), // seen 없음(구버전 데이터 취급)
      paletteItems: PALETTE,
      onChange,
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    // 단 수를 1로 → 둘째 존(core:delete)이 팔레트로 빠진다.
    top
      .querySelector<HTMLButtonElement>('.tb-tier-btn[data-tier="1"]')!
      .click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(new Set(next.seen)).toEqual(
      new Set(["core:preview", "core:delete"]),
    );
  });

  /**
   * 가드(회귀): 사용자가 **손대지 않은** 미배치 버튼(설치 직후 position 폴백으로 노트에
   * 자동 노출 중인 서드파티 버튼)은 무관한 편집을 저장해도 seen에 들어가지 않는다 —
   * 예전엔 커밋마다 팔레트 전체를 seen으로 확정해, 툴바 배치를 한 번 만지기만 해도 방금
   * 설치한 버튼이 아무 안내 없이 영구히 사라졌다.
   */
  it("손대지 않은 미배치 버튼은 무관한 편집을 저장해도 seen에 안 들어간다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: { ...layout(), seen: ["core:preview", "core:delete"] },
      // plugin:third:btn = 방금 설치된 신규 버튼(배치에 없고 seen에도 없음).
      paletteItems: [...PALETTE, { key: "plugin:third:btn", name: "서드파티" }],
      onChange,
    });
    el.querySelector<HTMLElement>('.tb-editor-bar[data-bar="top"]')!
      .querySelector<HTMLButtonElement>('.tb-tier-btn[data-tier="1"]')!
      .click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.seen).not.toContain("plugin:third:btn");
  });

  /** 가드: 기존 seen 항목(지금 팔레트엔 없는 키 포함)은 좁혀지지 않고 합집합으로 유지된다. */
  it("기존 seen 항목은 팔레트에 없어도 유지된다(합집합)", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: { ...layout(), seen: ["core:preview", "legacy:removed"] },
      paletteItems: PALETTE,
      onChange,
    });
    const top = el.querySelector<HTMLElement>(
      '.tb-editor-bar[data-bar="top"]',
    )!;
    top
      .querySelector<HTMLButtonElement>('.tb-tier-btn[data-tier="1"]')!
      .click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.seen).toContain("legacy:removed"); // 팔레트에 없는 옛 키도 유지
    expect(next.seen).toContain("core:delete"); // 이번에 존에서 빠진 키
    expect(next.seen).not.toContain("core:archive"); // 손대지 않은 미배치 키
  });

  /**
   * 가드: 배치가 모르는(seen 밖) 버튼이 `position`을 선언했으면 편집기 목업의 그 존에 미리
   * 놓인다 — 노트 창의 런타임 폴백과 같은 자리라야 목업이 실물과 어긋나지 않고, 사용자가
   * 그 버튼을 팔레트로 빼내 "치울" 수 있다(빼내는 순간 seen에 기록된다).
   */
  it("미확인 버튼을 position 폴백 존에 미리 놓아 보여준다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: {
        top: { align: "left", zones: [["core:preview"], ["core:delete"]] },
        bottom: { align: "left", zones: [["core:archive"]] },
        seen: ["core:preview", "core:delete", "core:archive"],
      },
      paletteItems: [
        ...PALETTE,
        { key: "plugin:third:btn", name: "서드파티", position: "bottom-left" },
      ],
      onChange,
    });
    const chip = el.querySelector<HTMLElement>(
      '.tb-zone-slots[data-bar="bottom"][data-zone="0"] [data-item-key="plugin:third:btn"]',
    );
    expect(chip).not.toBeNull();
    // 팔레트에는 더 이상 없다(자리를 얻었으므로).
    expect(
      el.querySelector('.tb-palette-items [data-item-key="plugin:third:btn"]'),
    ).toBeNull();
  });

  /** 가드: 「기본 배치로 초기화」는 seen까지 비운다 — 자동 배치 규칙이 처음처럼 다시 적용돼
   * 설치된 서드파티 버튼이 기본 자리로 돌아온다(그 뒤 사용자가 다시 치울 수 있다). */
  it("기본 배치로 초기화하면 seen을 비우고 폴백을 다시 적용한다", () => {
    const onChange = vi.fn();
    const el = renderToolbarLayoutEditor({
      layout: { ...layout(), seen: ["core:preview", "plugin:third:btn"] },
      paletteItems: [
        ...PALETTE,
        { key: "plugin:third:btn", name: "서드파티", position: "bottom-left" },
      ],
      onChange,
    });
    el.querySelector<HTMLButtonElement>(".tb-reset-btn")!.click();
    const next = onChange.mock.calls[0][0] as ToolbarLayout;
    expect(next.seen).toEqual([]);
    expect(next.bottom.zones[0]).toContain("plugin:third:btn");
  });
});
