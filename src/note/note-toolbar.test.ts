import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createNoteToolbar,
  reflowOverflow,
  type NoteOptionState,
  type NoteToolbarOptions,
} from "./note-toolbar";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../plugin/capabilities";
import {
  availableBuiltinItems,
  DEFAULT_LAYOUT,
  materializeFallbacks,
  pruneLayout,
  type ToolbarLayout,
} from "./toolbar-layout";
import { createAndOpenNote, openSettings } from "../shared/tauri";
import { maybeShowToolbarStylePrompt } from "./toolbar-style-prompt";

// core:settings(설정 바로가기)·core:new-note(새 메모, 베타 피드백 1건)는 NoteToolbarHandlers를
// 거치지 않고 shared/tauri.ts를 직접 부른다(note-toolbar.ts 주석 참고) — 실제 구현은 그대로 두고
// 두 함수만 스파이로 바꾼다.
vi.mock("../shared/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/tauri")>();
  return {
    ...actual,
    openSettings: vi.fn(() => Promise.resolve()),
    createAndOpenNote: vi.fn(() => Promise.resolve()),
  };
});

// 최초 실행 스타일 프롬프트 훅(이슈 #16 §4)도 기본 인자로 실제 구현을 부르므로, 이 파일의
// 다른 테스트에 부작용(백그라운드 invoke 시도)이 새지 않도록 스파이로 바꾼다.
vi.mock("./toolbar-style-prompt", () => ({
  maybeShowToolbarStylePrompt: vi.fn(),
}));

const STATE: NoteOptionState = {
  preview: true,
  pinned: false,
  transparency: 100,
  allSpaces: false,
  fontSize: 14,
  collapsed: false,
};

const SWATCHES = ["#aaaaaa", "#bbbbbb"];

/** 마이크로태스크 큐를 비운다(비동기 .catch 처리 대기용). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// openSettings/maybeShowToolbarStylePrompt는 모듈 목(위)이라 호출 이력이 테스트 간 누적된다 —
// 매 테스트 전에 비워 "이번 호출"만 본다.
beforeEach(() => {
  vi.clearAllMocks();
});

function spies() {
  return {
    togglePreview: vi.fn(),
    setPinned: vi.fn(),
    setTransparency: vi.fn(),
    setAllSpaces: vi.fn(),
    setCollapsed: vi.fn(),
    setBackground: vi.fn(),
    commit: vi.fn(),
    archiveNote: vi.fn(),
    deleteNote: vi.fn(),
  };
}

/**
 * 툴바를 만든다 — 테스트가 **관심 있는 것만** 덮어쓰고 나머지는 기본값을 쓴다.
 * 능력 기본값이 ALL_CAPABILITIES인 것은 "이 테스트는 능력 게이팅에 관심 없다"는 뜻이다
 * (프로덕션 기본값은 반대로 fail-closed다 — capabilities.ts 참고).
 */
function toolbar(overrides: Partial<NoteToolbarOptions> = {}) {
  return createNoteToolbar({
    state: STATE,
    handlers: spies(),
    swatches: SWATCHES,
    currentBackground: "#ffffff",
    capabilities: ALL_CAPABILITIES,
    layout: DEFAULT_LAYOUT,
    ...overrides,
  });
}

describe("createNoteToolbar", () => {
  /** 가드: 프리뷰 토글·핀·투명도·삭제가 올바른 인자로 핸들러를 호출한다. */
  it("wires preview/pin/transparency/delete", () => {
    const h = spies();
    const { top: bar, bottom } = toolbar({ handlers: h });
    const [preview, pin] = [
      ...bar.querySelectorAll<HTMLButtonElement>(".note-toolbar-btn"),
    ];
    preview.click();
    expect(h.togglePreview).toHaveBeenCalledWith(false); // true→false 토글
    pin.click();
    expect(h.setPinned).toHaveBeenCalledWith(true);

    const alpha = bar.querySelector<HTMLInputElement>('input[type="range"]')!;
    alpha.value = "50";
    alpha.dispatchEvent(new Event("input"));
    expect(h.setTransparency).toHaveBeenCalledWith(50);
    // 드래그를 놓을 때(change)만 영속화(commit)한다.
    expect(h.commit).not.toHaveBeenCalled();
    alpha.dispatchEvent(new Event("change"));
    expect(h.commit).toHaveBeenCalledTimes(1);

    // 삭제는 이제 하단 바에 있다(아이콘 SVG라 title로 찾는다).
    const del = bottom.querySelector<HTMLButtonElement>(
      '.note-toolbar-btn[title="삭제"]',
    )!;
    del.click();
    expect(h.deleteNote).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(이슈 #16): 설정 바로가기 버튼은 기본 배치(top)에 있고, 클릭하면 shared/tauri.ts의
   * openSettings()를 직접 부른다(NoteToolbarHandlers를 거치지 않는다 — note-toolbar.ts 주석 참고).
   */
  it("wires the settings shortcut button to openSettings()", () => {
    const { top } = toolbar();
    const settingsBtn = top.querySelector<HTMLButtonElement>(
      '[data-action="open-settings"]',
    )!;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn.title).toBe("설정 열기");
    settingsBtn.click();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(회귀): openSettings()가 거부돼도 note-toolbar.ts가 흡수해야 한다 — 안 그러면
   * note-window.ts가 `?note=<id>` 창에 무조건 설치하는 전역 unhandledrejection 핸들러가 이
   * 거부를 그대로 잡아 노트 창 전체를 크래시 오버레이로 덮는다. 처리되지 않은 거부가 새면
   * 이 테스트 자체도(환경에 따라) 실패하므로, 흡수 실패를 이중으로 잡아낸다.
   */
  it("swallows an openSettings() rejection instead of leaving it unhandled", async () => {
    vi.mocked(openSettings).mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { top } = toolbar();
    const settingsBtn = top.querySelector<HTMLButtonElement>(
      '[data-action="open-settings"]',
    )!;

    settingsBtn.click();
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  /**
   * 가드(베타 피드백 1건): 새 메모 버튼은 기본 배치(top, 우측 존 맨 앞)에 있고, 클릭하면
   * shared/tauri.ts의 createAndOpenNote()를 직접 부른다(core:settings와 같은 배선 — 위 주석 참고).
   */
  it("wires the new-note button to createAndOpenNote()", () => {
    const { top } = toolbar();
    const newNoteBtn = top.querySelector<HTMLButtonElement>(
      '[data-action="new-note"]',
    )!;
    expect(newNoteBtn).not.toBeNull();
    expect(newNoteBtn.title).toBe("새 메모 만들기");
    newNoteBtn.click();
    expect(createAndOpenNote).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(회귀): createAndOpenNote()가 거부돼도 note-toolbar.ts가 흡수해야 한다 — openSettings와
   * 같은 이유(note-window.ts의 전역 unhandledrejection 크래시 오버레이 방지).
   */
  it("swallows a createAndOpenNote() rejection instead of leaving it unhandled", async () => {
    vi.mocked(createAndOpenNote).mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { top } = toolbar();
    const newNoteBtn = top.querySelector<HTMLButtonElement>(
      '[data-action="new-note"]',
    )!;

    newNoteBtn.click();
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  /**
   * 가드(이슈 #16 §4): createNoteToolbar는 호출될 때마다(=note-window.ts가 몰라도) 최초 실행
   * 스타일 프롬프트 훅을 부른다 — note-window.ts를 고치지 않고도 실제 배선이 끝난다는 계약.
   */
  it("calls the toolbar-style-prompt hook by default", () => {
    toolbar();
    expect(maybeShowToolbarStylePrompt).toHaveBeenCalled();
  });

  /** 가드: showStylePrompt로 훅을 주입하면(테스트 주입점) 그 함수가 대신 불린다. */
  it("calls an injected style-prompt hook instead of the default", () => {
    const injected = vi.fn();
    toolbar({ showStylePrompt: injected });
    expect(injected).toHaveBeenCalledTimes(1);
    expect(maybeShowToolbarStylePrompt).not.toHaveBeenCalled();
  });

  /** 가드: 접기 버튼 클릭이 setCollapsed(true)를 부른다(초기 펼침 → 접힘). */
  it("wires the collapse toggle", () => {
    const h = spies();
    const { top: bar } = toolbar({ handlers: h });
    const collapse = bar.querySelector<HTMLButtonElement>(
      '.note-toolbar-btn[title="헤더만 접기(높이 조절)"]',
    )!;
    const iconBefore = collapse.innerHTML;
    collapse.click();
    expect(h.setCollapsed).toHaveBeenCalledWith(true);
    // 펼침(접기 아이콘) → 접힘(펼치기 아이콘)으로 아이콘이 바뀐다.
    expect(collapse.innerHTML).not.toBe(iconBefore);
  });

  /** 가드: 배경 스와치 클릭이 setBackground를 그 색으로 호출한다. */
  it("wires background swatches", () => {
    const h = spies();
    const { top: bar } = toolbar({ handlers: h });
    const swatch = bar.querySelector<HTMLButtonElement>(".note-swatch")!;
    swatch.click();
    expect(h.setBackground).toHaveBeenCalledWith(SWATCHES[0]);
    expect(h.commit).toHaveBeenCalled(); // 스와치는 이산 선택 → 즉시 저장
  });

  /** 가드: 스와치가 있으면 🎨 배경 피커(트리거)가 툴바에 나타난다. */
  it("renders the background picker when swatches exist", () => {
    const { top: bar } = toolbar();
    expect(bar.querySelector(".note-bg-trigger")).not.toBeNull();
  });

  /**
   * 가드(회귀): 트리거는 **현재 색으로 칠한 면만** 두지 않는다. 그 색은 정의상 노트 배경과
   * 같아서(자기가 놓인 면과 같은 색) 버튼이 통째로 안 보였다 — 이제는 `currentColor` 윤곽선
   * 글리프가 있고, 현재 색은 그 안쪽 채움(--note-chip)으로만 들어간다.
   */
  it("draws an outlined glyph so the trigger stays visible on any background", () => {
    const { top: bar } = toolbar({ currentBackground: "#fdf6e3" });
    const trigger = bar.querySelector<HTMLElement>(".note-bg-trigger")!;
    // 윤곽선: currentColor로 그리는 SVG가 있어야 한다(배경색과 무관하게 보인다).
    const glyph = trigger.querySelector("svg")!;
    expect(glyph.getAttribute("stroke")).toBe("currentColor");
    // 현재 색은 인라인 배경이 아니라 채움 변수로만 전달된다.
    expect(trigger.style.getPropertyValue("--note-chip")).toBe("#fdf6e3");
    expect(trigger.querySelector(".note-bg-fill")).not.toBeNull();
  });

  /** 가드: 색을 고르면 채움 변수가 그 색으로 즉시 바뀐다(칩이 현재 색을 계속 알린다). */
  it("repaints the glyph fill when a swatch is picked", () => {
    const { top: bar } = toolbar();
    bar.querySelector<HTMLButtonElement>(".note-swatch")!.click();
    expect(
      bar
        .querySelector<HTMLElement>(".note-bg-trigger")!
        .style.getPropertyValue("--note-chip"),
    ).toBe(SWATCHES[0]);
  });

  /** 가드(핵심): 스와치가 없으면 배경 피커 자체가 툴바에 없다(테마가 배경 선택 미제공). */
  it("omits the background picker entirely when there are no swatches", () => {
    const { top: bar } = toolbar({ swatches: [] });
    expect(bar.querySelector(".note-bg-trigger")).toBeNull();
    expect(bar.querySelector(".note-swatch")).toBeNull();
    // 다른 컨트롤(프리뷰·핀·옵션 메뉴)은 그대로 있다.
    expect(bar.querySelector(".note-toolbar-more")).not.toBeNull();
  });

  /** 가드: 모든-데스크탑 토글이 필수 그룹의 아이콘 버튼이고(툴팁으로 의미 보강) 클릭 시 동작한다. */
  it("wires the all-desktops icon toggle with an explanatory tooltip", () => {
    const h = spies();
    const { top: bar } = toolbar({ handlers: h });
    const btn = bar.querySelector<HTMLButtonElement>(
      '.note-toolbar-btn[title^="모든 데스크탑"]',
    )!;
    // 아이콘만으론 뜻이 애매하니 툴팁으로 데스크탑(Space) 전환 추종을 설명한다.
    expect(btn.title).toContain("데스크탑");
    expect(btn.getAttribute("aria-pressed")).toBe("false"); // 초기 off
    btn.click();
    expect(h.setAllSpaces).toHaveBeenCalledWith(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true"); // 토글 반영
  });

  /** 가드: 기본 배치의 상단 좌측 존 순서 = 투명도 → 프리뷰 → 항상 위 → 모든 데스크탑(→ 배경). */
  it("orders the essential controls: opacity, preview, pin, all-desktops", () => {
    const { top: bar } = toolbar();
    // 상단 좌측 존(zone 0)의 첫 자식은 투명도 슬라이더(range), 그다음 아이콘 토글 순서.
    const leftZone = bar.querySelector<HTMLElement>(
      '.tb-zone-inner[data-zone="0"]',
    )!;
    expect(
      (leftZone.firstElementChild as HTMLElement).getAttribute("type"),
    ).toBe("range"); // 투명도
    const titles = [
      ...leftZone.querySelectorAll<HTMLButtonElement>(".note-toolbar-btn"),
    ]
      .slice(0, 3)
      .map((b) => b.title);
    expect(titles[0]).toBe("마크다운 프리뷰");
    expect(titles[1]).toBe("항상 위");
    expect(titles[2]).toContain("모든 데스크탑");
  });

  /** 가드: 옵션 초기화는 이제 별도 번들 플러그인(reset-options)이 자기 버튼으로 제공하므로,
   * 내장 툴바에는 옵션 초기화 버튼이 없다(하단 바에는 삭제만 남는다). */
  it("no longer renders a builtin option-reset button (moved to a plugin)", () => {
    const { top, bottom } = toolbar();
    expect(
      bottom.querySelector('.note-toolbar-btn[title="옵션 초기화"]'),
    ).toBeNull();
    expect(bottom.querySelector('[data-action="reset-options"]')).toBeNull();
    // 닫기(구 보관)는 이슈 #16으로 상단으로 옮겼다 — 하단엔 삭제만 남는다.
    expect(
      top.querySelector('.note-toolbar-btn[title="닫기(보관)"]'),
    ).not.toBeNull();
    expect(
      bottom.querySelector('.note-toolbar-btn[title="삭제"]'),
    ).not.toBeNull();
  });

  /** 가드(핵심): resync가 토글 버튼 내부 상태·투명도 슬라이더를 새 상태로 되맞춘다(옵션 초기화 UI 동기화). */
  it("resync brings toggle buttons and the slider back in sync", () => {
    const custom: NoteOptionState = {
      preview: false,
      pinned: true,
      transparency: 50,
      allSpaces: true,
      fontSize: 20,
      collapsed: false,
    };
    const h = spies();
    const { top, resync } = toolbar({ state: custom, handlers: h });
    const byTitle = (t: string) =>
      [...top.querySelectorAll<HTMLButtonElement>(".note-toolbar-btn")].find(
        (b) => b.title === t,
      )!;
    const preview = byTitle("마크다운 프리뷰");
    const pin = byTitle("항상 위");
    const alpha = top.querySelector<HTMLInputElement>('input[type="range"]')!;
    // 초기(커스텀) 상태 반영.
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(alpha.value).toBe("50");

    // 전역 기본값(STATE)으로 되맞춘다.
    resync(STATE, "#ffffff");
    expect(preview.getAttribute("aria-pressed")).toBe("true");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(alpha.value).toBe("100");

    // 내부 on 상태까지 동기화됐는지 — resync 후 클릭이 기본값에서 토글된다(가짜 무변화 없음).
    pin.click();
    expect(h.setPinned).toHaveBeenLastCalledWith(true); // false→true
  });

  /** 가드: 접기(collapse)는 배치 가능한 위젯이고, 기본 배치에선 상단 바(우측 존)에 렌더된다. */
  it("renders the collapse toggle in the top bar by default", () => {
    const { top: bar } = toolbar();
    const collapse = bar.querySelector<HTMLButtonElement>(
      '[data-action="toggle-collapse"]',
    )!;
    expect(collapse).not.toBeNull();
    expect(collapse.title).toBe("헤더만 접기(높이 조절)");
    // 각 존의 ⋯ 오버플로 래퍼는 넘치는 게 없으면 숨어 있다(jsdom은 측정이 0이라 항상 숨김).
    for (const more of bar.querySelectorAll<HTMLElement>(
      ".note-toolbar-overflow",
    ))
      expect(more.hidden).toBe(true);
  });

  /** 가드: 0단 바(빈 zones)는 비어 있고 --empty로 표시돼 자리를 차지하지 않는다. */
  it("renders a 0-tier bar as empty (no zones)", () => {
    const { bottom } = toolbar({
      layout: {
        top: { align: "left", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
    });
    expect(bottom.classList.contains("note-toolbar--empty")).toBe(true);
    expect(bottom.querySelector(".tb-zone")).toBeNull();
  });

  /** 가드: 1단 바의 정렬(align)이 존의 data-align으로 반영된다. */
  it("applies the align of a single-tier bar to the zone", () => {
    const { top } = toolbar({
      layout: {
        top: { align: "right", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] },
      },
    });
    expect(top.querySelector<HTMLElement>(".tb-zone")!.dataset.align).toBe(
      "right",
    );
  });

  /** 가드(핵심): placeItem은 배치(layout)에 있는 키만 해당 존에 넣는다. 없는 키는 두 갈래로
   * 갈린다 — seen에 있으면(사용자가 명시적으로 뺀 것) 계속 숨기고, seen에도 없으면(한 번도
   * 알지 못한 신규 버튼) position 폴백 존에 자동 배치한다. position이 없거나 그 존이 없으면
   * (0단 바) 안전하게 건너뛴다. */
  it("placeItem renders a placed key, hides an explicitly-removed (seen) key, and auto-places a never-seen key by position", () => {
    const { top, placeItem } = toolbar({
      layout: {
        top: { align: "left", zones: [["plugin:demo:known"], []] }, // 2단: 좌·우
        bottom: { align: "left", zones: [["core:archive"]] },
        seen: ["plugin:demo:known", "plugin:demo:removed", "core:archive"],
      },
    });
    const known = document.createElement("button");
    placeItem("plugin:demo:known", known);
    expect(top.querySelector('[data-item-key="plugin:demo:known"]')).toBe(
      known,
    );

    // 배치엔 없지만 seen에 있는 키(사용자가 팔레트로 뺀 것) → position이 있어도 계속 숨김.
    const removed = document.createElement("button");
    placeItem("plugin:demo:removed", removed, "top-left");
    expect(removed.isConnected).toBe(false);

    // 배치에도 seen에도 없는 신규 키 + position → 그 정렬쪽 존에 자동 배치된다.
    const fresh = document.createElement("button");
    placeItem("plugin:demo:fresh", fresh, "top-right");
    expect(
      top.querySelector(
        '.tb-zone-inner[data-zone="1"] [data-item-key="plugin:demo:fresh"]',
      ),
    ).toBe(fresh);

    // 신규 키인데 position이 없으면(호출부가 안 넘김) 자동 배치할 근거가 없어 렌더하지 않는다.
    const noPosition = document.createElement("button");
    placeItem("plugin:demo:no-position", noPosition);
    expect(noPosition.isConnected).toBe(false);
  });

  /** 가드: 신규 키의 폴백 존이 존재하지 않으면(예: 대상 바가 0단) 안전하게 건너뛴다(에러 없음). */
  it("placeItem safely skips a never-seen key whose fallback bar has no zones", () => {
    const { bottom, placeItem } = toolbar({
      layout: {
        top: { align: "left", zones: [["core:preview"]] },
        bottom: { align: "left", zones: [] }, // 0단 — 존 없음
        seen: ["core:preview"],
      },
    });
    const el = document.createElement("button");
    expect(() =>
      placeItem("plugin:demo:fresh", el, "bottom-left"),
    ).not.toThrow();
    expect(el.isConnected).toBe(false);
    expect(bottom.querySelector(".tb-zone")).toBeNull();
  });
});

/**
 * 접힘 헤더 제목 라벨(core:collapsed-title) — 다른 배치 항목과 똑같이 자기 존의
 * `.tb-zone-inner` 안에, 배치 순서 그대로 렌더된다. 배치의 실제 자리(어느 존의 몇 번째)가 곧
 * 렌더 위치다 — 좌측 존에 두면 좌측 정렬로, 우측 존에 두면 우측 정렬로 그려진다(호버 없이 항상
 * 보이는 것·⋯로 접히지 않는 것은 styles.css·reflowOverflow가 항목 단위로 예외 처리한다).
 */
describe("createNoteToolbar — 접힘 제목(core:collapsed-title)", () => {
  it("기본 배치에서 라벨이 자기 존(좌측)의 tb-zone-inner 안, 배치 순서 그대로 렌더된다", () => {
    const { top } = toolbar(); // DEFAULT_LAYOUT — 상단 좌측 존 끝에 core:collapsed-title.
    const label = top.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label).not.toBeNull();

    const zone = label.closest<HTMLElement>(".tb-zone")!;
    expect(zone).not.toBeNull();
    expect(zone.dataset.align).toBe("left"); // DEFAULT_LAYOUT의 좌측 존.
    const inner = label.closest<HTMLElement>(".tb-zone-inner")!;
    expect(inner).not.toBeNull();
    // 배치 순서(core:background 다음 마지막)대로 그 존의 마지막 항목이다.
    expect(inner.lastElementChild).toBe(label);
  });

  it("우측 존에 두면 그 존 안(우측 정렬)에 렌더된다", () => {
    const { top } = toolbar({
      layout: {
        top: {
          align: "left",
          zones: [["core:preview"], ["core:collapse", "core:collapsed-title"]],
        },
        bottom: { align: "left", zones: [] },
        // 나머지 가용 내장 컨트롤을 명시적으로 빼(seen) position 폴백으로 자동 배치되지 않게
        // 한다 — 안 그러면 이 테스트가 관심 없는 항목(설정·닫기·새 메모 등)이 같은 우측 존에
        // 끼어들어 "바로 뒤" 단언이 흔들린다.
        seen: [
          "core:preview",
          "core:collapse",
          "core:collapsed-title",
          "core:transparency",
          "core:pin",
          "core:all-desktops",
          "core:background",
          "core:new-note",
          "core:settings",
          "core:archive",
          "core:delete",
        ],
      },
    });
    const label = top.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label).not.toBeNull();

    const zone = label.closest<HTMLElement>(".tb-zone")!;
    expect(zone.dataset.align).toBe("right");
    const inner = label.closest<HTMLElement>(".tb-zone-inner")!;
    // 배치 순서대로 core:collapse 버튼 바로 뒤(그 존의 두 번째이자 마지막)에 온다.
    expect(Array.from(inner.children).indexOf(label)).toBe(1);
    expect(inner.lastElementChild).toBe(label);
  });

  it("⋯ 오버플로 접기 후보에서 빠지도록 no-fold 마커가 붙는다", () => {
    const { top } = toolbar();
    const label = top.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label.dataset.noFold).toBe("true");
  });

  it("setCollapsedTitle이 텍스트와 툴팁을 함께 채운다", () => {
    const { top, setCollapsedTitle } = toolbar();
    const label = top.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label.textContent).toBe(""); // 초기값은 비어 있다(note-window가 접힘 때 채운다).

    setCollapsedTitle("첫 줄 제목");
    expect(label.textContent).toBe("첫 줄 제목");
    expect(label.title).toBe("첫 줄 제목"); // 말줄임됐을 때를 위한 전체 텍스트.
  });

  it("배치에서 항목을 빼면 라벨이 렌더되지 않고, setCollapsedTitle은 안전한 no-op이다", () => {
    const { top, setCollapsedTitle } = toolbar({
      layout: {
        top: { align: "left", zones: [["core:preview"], ["core:collapse"]] },
        bottom: { align: "left", zones: [] },
        seen: ["core:preview", "core:collapse", "core:collapsed-title"], // 명시적으로 뺌.
      },
    });
    expect(top.querySelector(".note-collapsed-title")).toBeNull();
    expect(() => setCollapsedTitle("아무 값")).not.toThrow();
  });
});

describe("reflowOverflow", () => {
  /** 3개 항목을 담은 primary + 빈 패널 + ⋯ 래퍼를 만든다(오라클로 넘침을 흉내). */
  function harness() {
    const primary = document.createElement("div");
    for (const id of ["a", "b", "c"]) {
      const el = document.createElement("button");
      el.dataset.id = id;
      primary.append(el);
    }
    const panel = document.createElement("div");
    const more = document.createElement("div");
    more.hidden = true;
    const ids = (host: HTMLElement) =>
      [...host.children].map((c) => (c as HTMLElement).dataset.id);
    return { primary, panel, more, ids };
  }

  /** 가드: 넘치지 않으면 전부 인라인 유지 + ⋯ 숨김. */
  it("keeps everything inline and hides ⋯ when nothing overflows", () => {
    const { primary, panel, more, ids } = harness();
    reflowOverflow(primary, panel, more, () => false);
    expect(ids(primary)).toEqual(["a", "b", "c"]);
    expect(panel.childElementCount).toBe(0);
    expect(more.hidden).toBe(true);
  });

  /** 가드: 넘치면 앞쪽부터 패널 끝으로 접고(순서 보존) ⋯를 보인다. */
  it("folds leading items into the panel in order and shows ⋯", () => {
    const { primary, panel, more, ids } = harness();
    // primary에 2개 넘게 남아 있으면 계속 넘친다고 흉내 → a,b가 접히고 c만 남는다.
    reflowOverflow(primary, panel, more, () => primary.childElementCount > 1);
    expect(ids(primary)).toEqual(["c"]);
    expect(ids(panel)).toEqual(["a", "b"]); // 원래 순서 보존
    expect(more.hidden).toBe(false);
  });

  /** 가드: 다시 넉넉해지면 패널 항목을 원래 순서·자리로 되돌리고 ⋯를 숨긴다. */
  it("restores panel items to their original order when space returns", () => {
    const { primary, panel, more, ids } = harness();
    reflowOverflow(primary, panel, more, () => primary.childElementCount > 1);
    expect(ids(panel)).toEqual(["a", "b"]);
    reflowOverflow(primary, panel, more, () => false); // 넉넉
    expect(ids(primary)).toEqual(["a", "b", "c"]);
    expect(panel.childElementCount).toBe(0);
    expect(more.hidden).toBe(true);
  });

  /** 가드: 계속 넘치면 오버플로 항목 전부를 ⋯로 접는다(필수 항목은 primary 밖이라 무관). */
  it("folds every overflow item into the panel when it keeps overflowing", () => {
    const { primary, panel, more, ids } = harness();
    reflowOverflow(primary, panel, more, () => true); // 항상 넘침
    expect(primary.childElementCount).toBe(0);
    expect(ids(panel)).toEqual(["a", "b", "c"]); // 전부 접힘(순서 보존)
    expect(more.hidden).toBe(false);
  });

  /**
   * 가드(접힘 제목 라벨): `dataset.noFold === "true"`가 붙은 항목은 아무리 좁아도(계속 넘쳐도)
   * ⋯로 접히지 않는다 — 접힘 헤더에서 "어느 메모인가"의 유일한 단서가 사라지면 안 된다.
   */
  it("never folds an item marked data-no-fold, even though it keeps overflowing", () => {
    const { primary, panel, more, ids } = harness();
    const c = primary.lastElementChild as HTMLElement;
    c.dataset.noFold = "true";
    reflowOverflow(primary, panel, more, () => true); // 항상 넘침
    expect(ids(primary)).toEqual(["c"]); // no-fold 항목만 남고 멈춘다(무한 루프 방지).
    expect(ids(panel)).toEqual(["a", "b"]);
    expect(more.hidden).toBe(false);
  });

  /** 가드: 우측 정렬(foldFromEnd=false → 앞부터 접음)에서도 no-fold 항목은 건너뛴다. */
  it("skips a no-fold item when folding from the start (right-aligned zones)", () => {
    const { primary, panel, more, ids } = harness();
    const a = primary.firstElementChild as HTMLElement;
    a.dataset.noFold = "true";
    reflowOverflow(primary, panel, more, () => true, false); // 항상 넘침, 앞부터 접기
    expect(ids(primary)).toEqual(["a"]); // no-fold 항목만 남는다.
    expect(ids(panel)).toEqual(["b", "c"]);
    expect(more.hidden).toBe(false);
  });

  /** 가드: 접을 게 없으면(패널이 비면) ⋯를 숨긴다 — 빈 ⋯가 뜨지 않게. */
  it("hides ⋯ when there is nothing to fold even though it overflows", () => {
    const { panel, more } = harness();
    const empty = document.createElement("div"); // primary에 오버플로 항목이 없음
    reflowOverflow(empty, panel, more, () => true);
    expect(panel.childElementCount).toBe(0);
    expect(more.hidden).toBe(true);
  });

  /** 가드(좌/가운데 정렬): foldFromEnd면 뒤(오른쪽 끝)부터 접어 앞 항목을 남기고, 순서를 보존한다. */
  it("folds trailing items first when foldFromEnd (left/center zones)", () => {
    const { primary, panel, more, ids } = harness(); // [a,b,c]
    // 1개 넘게 남으면 계속 넘침 → 뒤에서부터 c,b가 접히고 a만 남는다.
    reflowOverflow(
      primary,
      panel,
      more,
      () => primary.childElementCount > 1,
      true,
    );
    expect(ids(primary)).toEqual(["a"]);
    expect(ids(panel)).toEqual(["b", "c"]); // 원래 순서 보존(뒤에서 접어도)
    expect(more.hidden).toBe(false);
    // 넉넉해지면 원래 순서·자리로 복원.
    reflowOverflow(primary, panel, more, () => false, true);
    expect(ids(primary)).toEqual(["a", "b", "c"]);
    expect(panel.childElementCount).toBe(0);
  });
});

describe("createNoteToolbar — 창 컨트롤 조건부 노출(번들 플러그인)", () => {
  const ALL_DESKTOPS_TITLE =
    "모든 데스크탑에 표시 — 데스크탑(Space)을 전환해도 이 메모가 보입니다";
  const alphaOf = (bar: HTMLElement) =>
    bar.querySelector<HTMLInputElement>('input[type="range"]');
  const byTitle = (bar: HTMLElement, title: string) =>
    [...bar.querySelectorAll<HTMLButtonElement>(".note-toolbar-btn")].find(
      (b) => b.title === title,
    );

  /** 가드: 창 컨트롤이 모두 켜지면 투명도·핀·모든 데스크탑이 모두 노출된다(기본값). */
  it("shows all window controls when all are enabled", () => {
    const { top } = toolbar({ capabilities: ALL_CAPABILITIES });
    expect(alphaOf(top)).not.toBeNull();
    expect(byTitle(top, "항상 위")).toBeDefined();
    expect(byTitle(top, ALL_DESKTOPS_TITLE)).toBeDefined();
  });

  /** 가드: 창 컨트롤이 모두 꺼지면 투명도·핀·모든 데스크탑이 사라진다(프리뷰는 유지). */
  it("hides window controls that are disabled but keeps preview", () => {
    const { top } = toolbar({ capabilities: NO_CAPABILITIES });
    expect(alphaOf(top)).toBeNull();
    expect(byTitle(top, "항상 위")).toBeUndefined();
    expect(byTitle(top, ALL_DESKTOPS_TITLE)).toBeUndefined();
    // 프리뷰는 창 컨트롤이 아니라 항상 노출된다.
    expect(byTitle(top, "마크다운 프리뷰")).toBeDefined();
  });

  /** 가드: 일부만 켜면 그 컨트롤만 노출된다(투명도만 켬 → 슬라이더만, 핀 없음). */
  it("shows only the enabled subset of window controls", () => {
    const { top } = toolbar({
      capabilities: { windowControls: ["transparency"], youtubeEmbed: true },
    });
    expect(alphaOf(top)).not.toBeNull();
    expect(byTitle(top, "항상 위")).toBeUndefined();
  });
});

/**
 * 회귀 가드(이슈 #13): 좁은 창에서 레이어형 컨트롤(배경 스와치)이 `⋯` 오버플로 패널 속으로
 * 접혀 들어간 상태에서 트리거를 클릭해도 레이어가 즉시 나타나야 한다. jsdom은 레이아웃을
 * 실측하지 않아 `installZoneOverflow`가 자동으로 접지 않으므로, 실제 좁은 창에서
 * `reflowOverflow`가 하는 일(항목 전체를 `⋯` 패널 속으로 옮기고 엶)을 그대로 흉내 낸다.
 */
describe("createNoteToolbar — 오버플로 안에 접힌 레이어(배경 스와치)", () => {
  it("트리거 클릭 시 스와치 패널이 열리고, 담고 있던 ⋯ 패널도 함께 닫히지 않는다", () => {
    const { top } = toolbar();

    // 배경 피커가 사는 첫 존(top-left, 기본 배치)의 ⋯ 래퍼·패널.
    const overflowWrap = top.querySelector<HTMLElement>(
      ".note-toolbar-overflow",
    )!;
    const overflowPanel =
      overflowWrap.querySelector<HTMLElement>(".note-toolbar-menu")!;

    const bgTrigger = top.querySelector<HTMLButtonElement>(".note-bg-trigger")!;
    const bgWrap = bgTrigger.closest<HTMLElement>(".note-toolbar-more")!;
    const swatchPanel = bgWrap.querySelector<HTMLElement>(
      ".note-toolbar-swatches",
    )!;

    // 좁은 창에서 실제로 일어나는 일: 배경 피커 전체(트리거+패널)가 ⋯ 패널 속으로 옮겨지고,
    // 사용자가 그 안의 트리거를 보려면 ⋯가 먼저 열려 있어야 한다.
    overflowPanel.append(bgWrap);
    overflowWrap.hidden = false;
    overflowPanel.hidden = false;
    expect(swatchPanel.hidden).toBe(true); // 클릭 전엔 닫힘.

    bgTrigger.click();

    // 핵심 회귀 가드: 스와치 패널이 열리고, 그 조상인 ⋯ 패널은 함께 닫히지 않는다(닫히면
    // display:none이 걸려 자식이 hidden=false여도 화면엔 아무것도 안 그려진다).
    expect(swatchPanel.hidden).toBe(false);
    expect(overflowPanel.hidden).toBe(false);
    // 뷰포트 기준 고정 배치 — 조상의 overflow 클립을 받지 않는다.
    expect(swatchPanel.style.position).toBe("fixed");

    // 다시 클릭하면 스와치 패널만 닫히고, 조상 ⋯ 패널은 계속 열려 있다(무관한 상태를 건드리지
    // 않는다 — 사용자는 여전히 ⋯ 메뉴 안에 있다).
    bgTrigger.click();
    expect(swatchPanel.hidden).toBe(true);
    expect(overflowPanel.hidden).toBe(false);
  });
});

describe("createNoteToolbar — closeMenus (접힘 전환 시 열린 패널 정리)", () => {
  /**
   * 가드(핵심): note-window가 접힘 전환 시 부르는 closeMenus는 상/하 바에서 각각 열려 있던
   * 패널(배경 스와치·⋯ 오버플로)을 모두 닫는다 — CSS가 트리거를 감춰도 패널 자신의 hidden
   * 상태는 별개라, 접은 채로 그대로 두면 다시 펼쳤을 때 뜬금없이 열린 패널이 남는다.
   */
  it("closes an open background swatch panel and an open bottom-bar ⋯ panel at once", () => {
    const { top, bottom, closeMenus } = toolbar();

    const bgTrigger = top.querySelector<HTMLButtonElement>(".note-bg-trigger")!;
    const bgPanel = bgTrigger
      .closest<HTMLElement>(".note-toolbar-more")!
      .querySelector<HTMLElement>(".note-toolbar-swatches")!;
    bgTrigger.click();
    expect(bgPanel.hidden).toBe(false);

    const bottomMoreTrigger = bottom.querySelector<HTMLButtonElement>(
      ".note-toolbar-overflow [aria-haspopup]",
    )!;
    const bottomMorePanel = bottomMoreTrigger
      .closest(".note-toolbar-overflow")!
      .querySelector<HTMLElement>(".note-toolbar-menu")!;
    bottomMoreTrigger.click();
    expect(bottomMorePanel.hidden).toBe(false);

    closeMenus();

    expect(bgPanel.hidden).toBe(true);
    expect(bottomMorePanel.hidden).toBe(true);
  });
});

describe("createNoteToolbar — ⋯ 오버플로 메뉴 a11y", () => {
  /** 가드: ⋯ 트리거는 aria-haspopup/aria-controls를 갖고, 열고 닫을 때 aria-expanded가 동기화된다. */
  it("syncs aria-expanded on the ⋯ trigger", () => {
    const { top } = toolbar({ capabilities: NO_CAPABILITIES });
    const trigger = top.querySelector<HTMLButtonElement>(
      ".note-toolbar-overflow [aria-haspopup]",
    )!;
    const panel = top.querySelector<HTMLElement>(
      ".note-toolbar-overflow .note-toolbar-menu",
    )!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.hidden).toBe(true);

    trigger.click();
    expect(panel.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // Esc가 열린 메뉴를 닫는다.
    top.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

/**
 * 스펙(사용자 확정): 비활성 플러그인의 컨트롤은 배치에서 아예 사라지고, 다시 켜지면 **이전
 * 위치가 아니라 기본 위치**로 돌아온다. 노트 툴바는 그 두 단계를 마운트 때 함께 수행한다 —
 * 미가용 내장 키는 지우고(seen 포함), 배치가 모르는 가용 내장 키는 폴백 자리에 놓는다.
 */
describe("createNoteToolbar — 미가용 내장 컨트롤 정리·복귀", () => {
  const bare = (): ToolbarLayout => ({
    top: { align: "left", zones: [["core:preview"], []] },
    bottom: { align: "left", zones: [[], []] },
    seen: ["core:preview"],
  });

  /** 가드: 배치에 남아 있어도 대응 플러그인이 꺼졌으면 렌더되지 않는다(유령 버튼 방지). */
  it("배치에 있어도 창 컨트롤이 꺼졌으면 그리지 않는다", () => {
    const { top } = toolbar({
      capabilities: NO_CAPABILITIES,
      layout: {
        top: { align: "left", zones: [["core:transparency", "core:preview"]] },
        bottom: { align: "left", zones: [] },
        seen: ["core:transparency", "core:preview"],
      },
    });
    expect(top.querySelector('input[type="range"]')).toBeNull();
    expect(top.querySelector('[data-item-key="core:preview"]')).not.toBeNull();
  });

  /** 가드(핵심): 배치가 모르는 가용 컨트롤은 선언된 기본 자리(top-left)에 나타난다. */
  it("배치에 없던 가용 컨트롤을 기본 자리에 되살린다", () => {
    const { top } = toolbar({ layout: bare() });
    const zone0 = top.querySelector<HTMLElement>(
      '.tb-zone-inner[data-zone="0"]',
    )!;
    // top-left 폴백 = 상단 0번 존. 투명도·핀·모든 데스크탑·배경이 모두 여기로 돌아온다.
    expect(zone0.querySelector('input[type="range"]')).not.toBeNull();
    expect(zone0.querySelector('[data-action="toggle-pin"]')).not.toBeNull();
    expect(zone0.querySelector(".note-bg-trigger")).not.toBeNull();
    // 접기는 top-right(1번 존), 보관·삭제는 bottom-right로 간다.
    const zone1 = top.querySelector<HTMLElement>(
      '.tb-zone-inner[data-zone="1"]',
    )!;
    expect(
      zone1.querySelector('[data-action="toggle-collapse"]'),
    ).not.toBeNull();
  });

  /** 가드: 사용자가 명시적으로 뺀 컨트롤(seen에 있고 미배치)은 되살아나지 않는다. */
  it("사용자가 뺀 컨트롤은 복귀시키지 않는다", () => {
    const layout = bare();
    const { top } = toolbar({
      layout: { ...layout, seen: [...(layout.seen ?? []), "core:pin"] },
    });
    expect(top.querySelector('[data-action="toggle-pin"]')).toBeNull();
    // 같은 배치의 다른 미확인 컨트롤은 정상 복귀한다(가드가 과잉이 아님을 보인다).
    expect(top.querySelector('input[type="range"]')).not.toBeNull();
  });
});

/**
 * 런타임 능력 전환 — 배경·창 컨트롤 플러그인을 켜고 끌 때 **창을 리로드하지 않고** 툴바
 * DOM만 증분 패치한다(`bootstrap/host-update-plan.ts`의 `background`·`window_controls` 단계).
 *
 * 위의 "미가용 내장 컨트롤 정리·복귀"·"창 컨트롤 조건부 노출"이 마운트 시점만 다루는 데 반해,
 * 여기서 못박는 것은 **이미 그려진 툴바가 어떻게 달라지는가**다: 항목이 제자리로 돌아오는가,
 * 값이 최신인가, 살아남은 컨트롤에 리스너·콜백이 겹치지 않는가.
 */
describe("createNoteToolbar — 런타임 능력 전환", () => {
  /** 존 inner에 지금 놓인 아이템 키를 순서대로(관심 있는 키만) 읽는다. */
  const keysIn = (bar: HTMLElement, zone: number, only: string[]): string[] =>
    [
      ...bar.querySelectorAll<HTMLElement>(
        `.tb-zone-inner[data-zone="${zone}"] [data-item-key]`,
      ),
    ]
      .map((el) => el.dataset.itemKey ?? "")
      .filter((key) => only.includes(key));

  /** 배경색 항목이 다른 두 항목 사이에 있는 배치(순서 보존을 관측하기 위한 최소 배치). */
  const sandwich = (): ToolbarLayout => ({
    top: {
      align: "left",
      zones: [["core:transparency", "core:background", "core:preview"]],
    },
    bottom: { align: "left", zones: [[]] },
    seen: ["core:transparency", "core:background", "core:preview"],
  });

  /**
   * 가드(핵심): 스와치가 사라지면 배경색 항목이 DOM에서 빠지고, 다시 생기면 **원래 존·원래
   * 순서**로 돌아온다. 배치가 아는 자리로 돌아오지 않으면 사용자가 정렬해 둔 툴바가 플러그인을
   * 껐다 켤 때마다 흐트러진다.
   */
  it("배경 스와치가 사라지면 피커를 지우고, 돌아오면 제자리에 되살린다", () => {
    const { top, setBackgroundCapability } = toolbar({ layout: sandwich() });
    const ORDER = ["core:transparency", "core:background", "core:preview"];
    expect(keysIn(top, 0, ORDER)).toEqual(ORDER);

    setBackgroundCapability([], "#fdf6e3"); // 배경 플러그인 off
    expect(top.querySelector(".note-bg-trigger")).toBeNull();
    expect(keysIn(top, 0, ORDER)).toEqual([
      "core:transparency",
      "core:preview",
    ]);

    setBackgroundCapability(["#123456"], "#123456"); // 다시 on
    const trigger = top.querySelector<HTMLElement>(".note-bg-trigger");
    expect(trigger).not.toBeNull();
    expect(keysIn(top, 0, ORDER)).toEqual(ORDER); // 가운데 자리 그대로.
    // 되살아난 피커는 **넘겨받은 현재 색**을 칠한다(마운트 때 색이 아니다).
    expect(trigger!.style.getPropertyValue("--note-chip")).toBe("#123456");
  });

  /**
   * 가드(핵심): 팔레트만 바뀌면 피커를 다시 만들지 않고 **스와치 노드만** 갈아 끼운다 —
   * 트리거·커스텀 입력의 리스너가 겹치지 않는다(클릭 한 번에 핸들러 한 번).
   */
  it("팔레트 교체는 스와치 노드만 바꾸고 리스너를 겹치지 않는다", () => {
    const h = spies();
    const { top, setBackgroundCapability } = toolbar({ handlers: h });
    const trigger = top.querySelector<HTMLButtonElement>(".note-bg-trigger")!;
    const panel = trigger
      .closest<HTMLElement>(".note-toolbar-more")!
      .querySelector<HTMLElement>(".note-toolbar-swatches")!;

    setBackgroundCapability(["#111111", "#222222", "#333333"], "#111111");
    // 트리거 요소는 **그대로**(다시 만들지 않았다) — 새 노드였다면 아래 참조가 죽는다.
    expect(top.querySelector(".note-bg-trigger")).toBe(trigger);
    expect(
      [...panel.querySelectorAll<HTMLElement>(".note-swatch")].map(
        (s) => s.title,
      ),
    ).toEqual(["#111111", "#222222", "#333333"]);
    // 커스텀 색 입력은 언제나 팔레트 뒤에 하나만 남는다.
    expect(panel.querySelectorAll(".note-swatch-custom")).toHaveLength(1);

    // 리스너 중복 없음: 클릭 한 번에 열리고, 한 번 더 누르면 닫힌다(두 번 붙었으면 제자리).
    trigger.click();
    expect(panel.hidden).toBe(false);
    trigger.click();
    expect(panel.hidden).toBe(true);
    // 스와치 클릭도 정확히 한 번씩만 전달된다.
    panel.querySelector<HTMLButtonElement>(".note-swatch")!.click();
    expect(h.setBackground).toHaveBeenCalledTimes(1);
    expect(h.setBackground).toHaveBeenCalledWith("#111111");
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(핵심): 창 컨트롤이 켜지면 그 컨트롤이 **넘겨받은 최신 상태**로 만들어진다 —
   * 마운트 때 굳은 초기값으로 만들면 슬라이더가 옛 투명도를 가리킨다(창은 이미 다른 값인데).
   */
  it("창 컨트롤이 켜지면 최신 상태값으로 만들어진다", () => {
    const { top, setWindowControls } = toolbar({
      capabilities: NO_CAPABILITIES,
    });
    expect(top.querySelector('input[type="range"]')).toBeNull();

    setWindowControls(["transparency", "always-on-top"], {
      ...STATE,
      transparency: 42,
      pinned: true,
    });
    const alpha = top.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(alpha.value).toBe("42");
    const pin = top.querySelector<HTMLButtonElement>(
      '[data-action="toggle-pin"]',
    )!;
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    // 켜지 않은 컨트롤은 그대로 없다(능력 집합이 곧 노출 조건).
    expect(top.querySelector('[data-action="toggle-all-desktops"]')).toBeNull();
  });

  /**
   * 가드(핵심): 꺼진 컨트롤의 재동기화 콜백(resyncers)까지 함께 지운다. 남겨두면 옵션
   * 초기화가 이미 DOM에서 뗀 요소를 계속 만지고, 그 컨트롤이 되살아났을 때 옛 콜백과 새
   * 콜백이 겹쳐 돈다.
   */
  it("꺼진 컨트롤의 resync 콜백을 함께 정리한다", () => {
    const { top, resync, setWindowControls } = toolbar();
    const alpha = top.querySelector<HTMLInputElement>('input[type="range"]')!;
    resync({ ...STATE, transparency: 70 }, "#ffffff");
    expect(alpha.value).toBe("70"); // 아직 살아 있을 땐 따라온다.

    setWindowControls([], STATE); // 투명도 플러그인 off
    expect(top.querySelector('input[type="range"]')).toBeNull();
    resync({ ...STATE, transparency: 55 }, "#ffffff");
    // 떼어낸 요소는 더 이상 갱신되지 않는다(콜백이 남아 있었다면 "55"가 됐다).
    expect(alpha.value).toBe("70");
  });

  /**
   * 가드(핵심): 마운트 때 미가용이던 내장 컨트롤을 **별개 호출로 순차** 켜면, DOM 순서는
   * 호출 순서(all-desktops 먼저 → pin 나중)가 아니라 카탈로그(`BUILTIN_ITEMS`) 순서로
   * 확정된다(core:pin이 core:all-desktops보다 카탈로그상 앞이므로 pin이 앞에 온다) —
   * `insertByLayoutOrder`가 keys에 없는 항목끼리 카탈로그 순서로 삽입점을 찾아야 한다는
   * 회귀 가드다.
   */
  it("마운트 후 순차로 켜진 폴백 컨트롤은 호출 순서가 아니라 카탈로그 순서로 자리 잡는다", () => {
    const { top, setWindowControls } = toolbar({
      capabilities: NO_CAPABILITIES,
    });
    const ORDER = [
      "core:preview",
      "core:background",
      "core:collapsed-title",
      "core:pin",
      "core:all-desktops",
    ];
    // 마운트 시 pin·all-desktops는 미가용이라 아직 없다(둘 다 배치의 dataset.keys에서도 빠졌다).
    expect(keysIn(top, 0, ORDER)).toEqual([
      "core:preview",
      "core:background",
      "core:collapsed-title",
    ]);

    setWindowControls(["all-desktops"], STATE); // all-desktops를 먼저 켠다(호출 순서상 먼저).
    setWindowControls(["all-desktops", "always-on-top"], STATE); // pin은 나중에.

    // 호출 순서(all-desktops → pin)와 무관하게 카탈로그 순서(pin이 all-desktops 앞)로 꽂힌다.
    expect(keysIn(top, 0, ORDER)).toEqual(ORDER);
  });

  /**
   * 가드(핵심): 배경·창 컨트롤을 **별개 호출**로(순서 무관) 켜도, 폴백 항목끼리는 리로드가
   * 만드는 것(`materializeFallbacks`)과 같은 순서로 자리 잡는다. 마운트 때 아무 내장 컨트롤도
   * 몰랐던(=배치의 dataset.keys가 완전히 빈) 존에서, 이후 늘어나는 순서만 다르게 켜 봐도
   * 최종 DOM 순서는 카탈로그 순서 하나로 수렴해야 한다.
   */
  it("배경+창 컨트롤을 별개 호출로 켜도 리로드(materializeFallbacks)와 같은 순서가 된다", () => {
    // 이 존이 아는 것은 아무것도 없다(unconditional 내장 컨트롤까지 전부 "이미 뺀 것"으로
    // seen에 미리 넣어 둔다) — 그래야 마운트 시 order(dataset.keys)가 완전히 비어, 이후
    // 켜지는 conditional 항목(투명도·핀·모든 데스크탑·배경)끼리의 카탈로그 순서만 남는다.
    const EMPTY: ToolbarLayout = {
      top: { align: "left", zones: [[]] },
      bottom: { align: "left", zones: [[]] },
      seen: [
        "core:preview",
        "core:new-note",
        "core:collapse",
        "core:collapsed-title",
        "core:settings",
        "core:archive",
        "core:delete",
      ],
    };
    const { top, setWindowControls, setBackgroundCapability } = toolbar({
      layout: EMPTY,
      capabilities: NO_CAPABILITIES,
      swatches: [],
    });
    const CONDITIONAL = [
      "core:transparency",
      "core:pin",
      "core:all-desktops",
      "core:background",
    ];
    expect(keysIn(top, 0, CONDITIONAL)).toEqual([]);

    // 배경 → all-desktops → (투명도+핀) 순서로, 서로 다른 API 호출에 걸쳐 하나씩 켠다.
    setBackgroundCapability(["#123456"], "#123456");
    setWindowControls(["all-desktops"], STATE);
    setWindowControls(["all-desktops", "transparency", "always-on-top"], STATE);

    // 리로드했다면(같은 최종 능력으로 처음부터 다시 마운트) materializeFallbacks가 냈을 순서.
    const reloaded = materializeFallbacks(
      pruneLayout(EMPTY, () => true),
      availableBuiltinItems(
        ["all-desktops", "transparency", "always-on-top"],
        true,
      ),
    );
    const reloadedOrder = reloaded.top.zones[0].filter((k) =>
      CONDITIONAL.includes(k),
    );

    expect(keysIn(top, 0, CONDITIONAL)).toEqual(reloadedOrder);
    // 구체적으로도 카탈로그 순서(BUILTIN_ITEMS: transparency·pin·all-desktops·background)와 같다.
    expect(reloadedOrder).toEqual([
      "core:transparency",
      "core:pin",
      "core:all-desktops",
      "core:background",
    ]);
  });
});
