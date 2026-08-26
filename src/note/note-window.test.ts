import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  parseNoteId,
  debounce,
  effectiveFontPx,
  clampFontDelta,
  resolveOptions,
  customizedOverrideLabels,
  mountNoteWindow,
  installNoteErrorOverlay,
  showNoteErrorOverlay,
  isTextEntryElement,
  type NoteWindowDeps,
} from "./note-window";
import { readNoteSelection } from "./editor";
import type { PluginWindowItem } from "../plugin/host-client";
import { registerLocale, setActiveLocale } from "../i18n/store";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../plugin/capabilities";
import type { NoteOverrides } from "../shared/tauri";
import {
  DEFAULT_BACKGROUND,
  DEFAULT_BACKGROUND_COLOR,
} from "../theme/background";

/** override가 모두 null인 NoteOverrides — 여러 deps 팩토리가 이 "커스터마이즈 없음" 상태를 기본으로 쓴다. */
const NO_OVERRIDES: NoteOverrides = {
  transparency: null,
  background: null,
  font_delta: null,
  markdown_preview: null,
  pinned: null,
  all_spaces: null,
  collapsed: null,
};

/**
 * 노트 창 deps 기본값 — 테스트가 **관심 있는 것만** 덮어쓴다.
 * 능력 기본값이 ALL_CAPABILITIES인 것은 "이 테스트는 능력 게이팅에 관심 없다"는 뜻이다
 * (프로덕션은 반대로 모르면 안 그린다 — capabilities.ts 참고).
 */
function baseNoteDeps<
  T extends Partial<NoteWindowDeps> = Record<string, never>,
>(overrides = {} as T) {
  return {
    loadNote: vi.fn(async () => ({ content: "", overrides: NO_OVERRIDES })),
    saveContent: vi.fn(),
    saveOverrides: vi.fn(),
    applyTransparency: vi.fn(),
    applyPinned: vi.fn(),
    applyAllSpaces: vi.fn(),
    applyCollapsed: vi.fn(),
    deleteNote: vi.fn(),
    archiveNote: vi.fn(),
    startDrag: vi.fn(),
    theme: { tokens: {} },
    baseFontPx: 14,
    capabilities: ALL_CAPABILITIES,
    ...overrides,
  } satisfies NoteWindowDeps;
}

describe("parseNoteId", () => {
  /** 가드: ?note=<id>에서 id를 뽑는다. */
  it("extracts the id from ?note=", () => {
    expect(parseNoteId("?note=abc-123")).toBe("abc-123");
  });

  /** 가드: note 파라미터가 없으면 null(노트창이 아님). */
  it("returns null without a note param", () => {
    expect(parseNoteId("")).toBeNull();
    expect(parseNoteId("?other=1")).toBeNull();
  });
});

describe("debounce", () => {
  /** 가드: 연속 호출 중 마지막 한 번만, 지정 ms 후 실행한다. */
  it("runs only the last call after the delay", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d("a");
      d("b");
      d("c");
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("c");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 가드(핵심): flush()가 대기 중인 마지막 호출을 ms를 기다리지 않고 즉시 실행하고, 타이머를
   * 취소해 나중에 중복 실행되지 않는다 — 리로드 직전 유실 방지의 핵심 계약.
   */
  it("flush() runs the pending call immediately and cancels the timer", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 500);
      d("a");
      d("b");
      d.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("b");
      // 타이머가 취소됐으니 원래 지연이 지나도 다시 실행되지 않는다.
      vi.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 대기 중인 호출이 없을 때 flush()는 아무 것도 하지 않는다(안전한 no-op). */
  it("flush() is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  /** 가드(핵심): cancel()은 대기 중인 호출을 **실행 없이** 버리고, 이후 flush()도 no-op이 된다 —
   * 노트를 지운 뒤에 남은 자동저장이 파일을 되살리지 못하게 하는 계약. */
  it("cancel() drops the pending call and makes a later flush() a no-op", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 500);
      d("a");
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(fn).not.toHaveBeenCalled();
      d.flush();
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("effectiveFontPx", () => {
  /** 가드: 전역 기본 + 델타(%)를 14px 기준으로 더하고 8~48로 클램프한다(Rust resolve와 동일). */
  it("adds base + delta% around 14px and clamps to 8..48", () => {
    expect(effectiveFontPx(14, 0)).toBe(14); // 델타 0 → 전역 그대로
    expect(effectiveFontPx(14, 50)).toBe(21); // 14 + round(14×0.5)=7
    expect(effectiveFontPx(14, -50)).toBe(8); // 14 - 7 = 7 → 하한 8
    expect(effectiveFontPx(40, 100)).toBe(48); // 40 + 14 = 54 → 상한 48
    // 반올림이라 정수 나눗셈(트렁케이트)과 갈리는 지점 — Rust resolve와 결과가 같아야 한다.
    expect(effectiveFontPx(14, 20)).toBe(17); // round(2.8)=3 (트렁케이트면 16)
    expect(effectiveFontPx(14, -20)).toBe(11); // round(-2.8)=-3 (트렁케이트면 12)
  });
});

describe("clampFontDelta", () => {
  const FONT_STEP_TEST = 10; // 확대/축소 단위(%) — clampFontDelta의 FONT_STEP과 일치.

  /**
   * 가드(핵심): px가 한계(48/8)에 붙으면 델타를 더 키워도(A+ 반복) 적용 델타가 자라지 않고
   * 실효 px도 고정된다 — "되는 척"하며 가짜 %가 무한히 커지던 버그의 회귀 방지.
   */
  it("pins the delta at the px limit so repeated bumps stop growing", () => {
    const base = 14;
    // 상한: 아무리 크게 요청해도 적용 델타는 한 값에 고정되고 px는 48을 넘지 않는다.
    const a = clampFontDelta(base, 250);
    const b = clampFontDelta(base, a + 10); // "한 번 더 A+"
    const c = clampFontDelta(base, b + 10);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(effectiveFontPx(base, a)).toBe(48);
    expect(clampFontDelta(base, 10_000)).toBe(a); // 극단값도 같은 상한
    // 하한도 대칭 — A− 반복이 무한히 작아지지 않는다.
    const lo = clampFontDelta(base, -250);
    expect(clampFontDelta(base, lo - 10)).toBe(lo);
    expect(effectiveFontPx(base, lo)).toBe(8);
  });

  /** 가드: 실효 px가 바뀌는 범위 안의 10% 배수 델타는 그대로 통과한다(정상 조작을 막지 않음). */
  it("leaves in-range deltas untouched", () => {
    expect(clampFontDelta(14, 0)).toBe(0);
    expect(clampFontDelta(14, 50)).toBe(50);
    expect(clampFontDelta(14, -30)).toBe(-30);
  });

  /**
   * 가드(핵심): 확대/축소는 항상 10% 단위로 떨어진다 — 상·하한이 10% 배수라 마지막 스텝이
   * "+100% 뒤 +104%"처럼 +4%로 끝나지 않는다. 예전 빌드가 남긴 비-10%-배수 델타도 다음
   * 조작에서 10% 격자로 복원된다(사용자 리포트: 최대에서 104%/4%로 끊기던 회귀 방지).
   */
  it("keeps every step on a clean 10% grid up to the limit", () => {
    const base = 14;
    // 경계가 10% 배수(240/−40)로 스냅되고 px 한계는 그대로 지킨다.
    expect(clampFontDelta(base, 250) % FONT_STEP_TEST).toBe(0);
    expect(clampFontDelta(base, 250)).toBe(240);
    expect(effectiveFontPx(base, 240)).toBe(48);
    expect(clampFontDelta(base, -250)).toBe(-40);
    expect(effectiveFontPx(base, -40)).toBe(8);
    // 0에서 +10씩 올려도 적용값은 항상 10% 배수이고 240에서 멈춘다(104%/4% 꼬리 없음).
    let d = 0;
    for (let i = 0; i < 40; i++) {
      d = clampFontDelta(base, d + FONT_STEP_TEST);
      expect(d % FONT_STEP_TEST).toBe(0);
    }
    expect(d).toBe(240);
    // 비배수 델타(예전 빌드 잔재)도 다음 조작에서 10% 격자로 복원된다.
    expect(clampFontDelta(base, 104 - FONT_STEP_TEST) % FONT_STEP_TEST).toBe(0);
    expect(clampFontDelta(base, 104 + FONT_STEP_TEST) % FONT_STEP_TEST).toBe(0);
  });

  /** 가드: 전역 기본(base)이 다르면 클램프 경계도 그에 맞춰 달라진다(base=40 → 상한 델타가 작다). */
  it("adapts the bound to the current base px", () => {
    const hi = clampFontDelta(40, 999);
    expect(effectiveFontPx(40, hi)).toBe(48); // 40 기준이라 작은 델타로 상한 도달
    expect(clampFontDelta(40, hi + 10)).toBe(hi);
  });
});

describe("resolveOptions", () => {
  /** 가드: override가 모두 null이면 전역 기본값(델타 0 → 전역 기본 글자 크기). */
  it("falls back to defaults when overrides are null", () => {
    expect(
      resolveOptions({
        transparency: null,
        background: null,
        font_delta: null,
        markdown_preview: null,
        pinned: null,
        all_spaces: null,
        collapsed: null,
      }),
    ).toEqual({
      preview: true,
      pinned: false,
      transparency: 100,
      allSpaces: false,
      fontSize: 14,
      collapsed: false,
    });
  });

  /** 가드: override가 있으면 그 값을 쓰고, 글자 크기는 전역 기본 + 메모 델타(%). */
  it("uses overrides when present (font = base + delta%)", () => {
    expect(
      resolveOptions(
        {
          transparency: 50,
          background: null,
          font_delta: 50,
          markdown_preview: false,
          pinned: true,
          all_spaces: true,
          collapsed: true,
        },
        14, // 전역 기본 14px(=100%) + 델타 50% → 14 + round(14×0.5)=21
      ),
    ).toEqual({
      preview: false,
      pinned: true,
      transparency: 50,
      allSpaces: true,
      fontSize: 21,
      collapsed: true,
    });
  });

  /** 가드: 전역 기본(baseFontPx, 앱 설정)이 실효 글자 크기의 기준이 된다(델타 0). */
  it("shifts font size by the global base when delta is zero", () => {
    const overrides = {
      transparency: null,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: null,
      all_spaces: null,
      collapsed: null,
    };
    expect(resolveOptions(overrides, 20).fontSize).toBe(20);
    expect(resolveOptions(overrides, 12).fontSize).toBe(12);
  });
});

describe("customizedOverrideLabels", () => {
  // registerLocale이 더한 로케일(store.ts locales Map)은 되돌릴 export가 없다(store.test.ts와
  // 같은 관례) — active만 테스트마다 ko로 되돌려 이 블록의 다른(ko를 가정하는) 테스트로 새지
  // 않게 한다.
  afterEach(() => setActiveLocale("ko"));

  const NONE: NoteOverrides = {
    transparency: null,
    background: null,
    font_delta: null,
    markdown_preview: null,
    pinned: null,
    all_spaces: null,
    collapsed: null,
  };

  /** 가드: 설정된(null 아님) 항목만 고정 순서로 나열한다 — 확인창의 "무엇이 사라지는지" 명시용. */
  it("lists only the set overrides, in a fixed order", () => {
    expect(
      customizedOverrideLabels({
        ...NONE,
        pinned: true,
        transparency: 50,
        background: { type: "color", value: "#fff" },
      }),
    ).toEqual(["투명도", "배경색", "항상 위"]); // 라벨 순서는 필드 값 순서와 무관
  });

  /** 가드: 아무 것도 설정 안 됐으면(모두 전역 기본값 상속) 빈 목록 → 되돌릴 게 없음을 뜻한다. */
  it("returns an empty list when nothing is customized", () => {
    expect(customizedOverrideLabels(NONE)).toEqual([]);
  });

  /** 가드: font_delta 0·collapsed false 같은 '설정됨' 값도 포함한다(null만 제외 — 저장된 override는 되돌림 대상). */
  it("includes falsy-but-set values (0/false), excludes only null", () => {
    expect(
      customizedOverrideLabels({ ...NONE, font_delta: 0, collapsed: false }),
    ).toEqual(["글자 크기", "헤더 접기"]);
  });

  /** 가드: 한 항목만 설정되면 그 하나만 나온다(확인창이 정확히 그 항목만 명시하도록). */
  it("lists exactly the single field that is set", () => {
    expect(
      customizedOverrideLabels({ ...NONE, markdown_preview: false }),
    ).toEqual(["마크다운 프리뷰"]);
  });

  /**
   * 회귀 가드: RESET_OPTION_LABELS가 모듈 최상위 `const`로 `t()`를 import 시점에 즉시
   * 평가하던 버그(활성 로케일이 무엇이든 이 창이 로드되는 순간의 로케일 — 늘 ko — 로
   * 영원히 굳는다)의 재발을 막는다 — 호출될 때마다(=확인창을 띄우는 시점마다) 그 순간의
   * 활성 로케일을 읽어야 한다. `registerLocale`은 되돌릴 export가 없으므로(store.test.ts와
   * 같은 관례) 이 파일에서 유일한 코드("xx")를 쓴다.
   */
  it("labels follow the active locale at call time (not the locale at module load)", () => {
    registerLocale("xx", "Test", {
      "note.window.reset-label-transparency": "XX Transparency",
    });

    setActiveLocale("xx");
    expect(customizedOverrideLabels({ ...NONE, transparency: 50 })).toEqual([
      "XX Transparency",
    ]);

    setActiveLocale("ko");
    expect(customizedOverrideLabels({ ...NONE, transparency: 50 })).toEqual([
      "투명도",
    ]);
  });
});

describe("mountNoteWindow — 옵션 초기화", () => {
  /** 다음 마이크로태스크·타이머 사이클을 비운다(confirmDialog then 소진). */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** mountNoteWindow 의존성(모두 스파이) — 지정 override로 노트를 로드한다. */
  function deps(overrides: NoteOverrides) {
    return baseNoteDeps({
      loadNote: vi.fn(async () => ({ content: "본문", overrides })),
    });
  }

  /** installPlugins ctx를 붙잡아 옵션 초기화 호스트 서비스(resetOptions)를 직접 부를 수 있게 한다.
   * 옵션 초기화는 이제 내장 버튼이 아니라 「옵션 초기화」 플러그인이 memo.notes.resetOptions 브리지로
   * 호출하고, 그 창-스코프 수행부가 바로 이 ctx.resetOptions다. */
  function captureReset(host: HTMLElement, d: ReturnType<typeof deps>) {
    let reset: (() => void) | null = null;
    return mountNoteWindow(host, "n1", {
      ...d,
      installPlugins: (ctx) => {
        reset = ctx.resetOptions;
      },
    }).then(() => {
      if (!reset)
        throw new Error("installPlugins가 resetOptions를 제공하지 않음");
      return reset;
    });
  }

  /**
   * 가드(핵심): 옵션 초기화 호스트 서비스가 override를 전역 기본값으로 비우고, 영향 설정을 deps로
   * 재적용하며, 한 번 영속화하고, 토글 UI(항상 위 aria-pressed)까지 기본값으로 되맞춘다.
   */
  it("resetOptions service clears overrides, re-applies via deps, persists, and resyncs toggle UI", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: 50,
      background: null,
      font_delta: 40,
      markdown_preview: false,
      pinned: true,
      all_spaces: true,
      collapsed: null,
    });
    const resetOptions = await captureReset(host, d);

    const pin = [
      ...host.querySelectorAll<HTMLButtonElement>(".note-toolbar-btn"),
    ].find((b) => b.title === "항상 위")!;
    expect(pin.getAttribute("aria-pressed")).toBe("true"); // 초기 커스텀 상태

    // 호스트 서비스 호출(= 플러그인 브리지의 창-스코프 수행부) → confirm 확인.
    resetOptions();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    // override가 전역 기본값(빈 객체)으로 비워져 저장된다.
    const calls = d.saveOverrides.mock.calls;
    const saved = calls[calls.length - 1][1];
    expect(saved).toEqual({});
    // 영향 설정을 기본값으로 재적용.
    expect(d.applyTransparency).toHaveBeenLastCalledWith(100);
    expect(d.applyPinned).toHaveBeenLastCalledWith(false);
    expect(d.applyAllSpaces).toHaveBeenLastCalledWith(false);
    // 토글 UI가 기본값으로 동기화(내부 상태 어긋남 방지).
    expect(pin.getAttribute("aria-pressed")).toBe("false");
  });

  /** 가드: 접힘으로 저장된 노트는 #app에 note-collapsed를 걸어 상단 바를 창 세로 중앙에 맞춘다. */
  it("adds note-collapsed class to host for a collapsed note", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: null,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: null,
      all_spaces: null,
      collapsed: true,
    });
    await mountNoteWindow(host, "n1", { ...d }); // 기본 배치 → 접기가 상단에 있어 접힘 유지
    expect(host.classList.contains("note-collapsed")).toBe(true);
  });

  /**
   * 가드(핵심): 백엔드가 세로 리사이즈로 스스로 뒤집은 접힘 상태(`note-collapsed-changed`)를
   * `syncCollapsed`가 **표시만** 반영한다 — 접기 버튼 내부 상태까지 되맞추되, 백엔드를 되부르지도
   * (applyCollapsed) override를 다시 쓰지도 않는다(되부르면 리사이즈→통지 왕복이 된다).
   */
  it("syncCollapsed reflects a backend-driven transition without calling back", async () => {
    const host = document.createElement("div");
    const d = deps({ ...NO_OVERRIDES, collapsed: true });
    const note = await mountNoteWindow(host, "n1", { ...d });
    const button = host.querySelector<HTMLButtonElement>(
      '[data-action="toggle-collapse"]',
    )!;
    expect(host.classList.contains("note-collapsed")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const applied = d.applyCollapsed.mock.calls.length;
    const persisted = d.saveOverrides.mock.calls.length;

    note.syncCollapsed(false);
    expect(host.classList.contains("note-collapsed")).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(d.applyCollapsed.mock.calls.length).toBe(applied);
    expect(d.saveOverrides.mock.calls.length).toBe(persisted);

    // 멱등: 같은 상태가 다시 와도(중복 통지) 아무 일도 하지 않는다.
    note.syncCollapsed(false);
    expect(host.classList.contains("note-collapsed")).toBe(false);
    expect(d.saveOverrides.mock.calls.length).toBe(persisted);
  });

  /**
   * 가드: 접힌 헤더는 창 타이틀(본문 첫 줄 — 패널·검색과 같은 제목)을 배치된 자리의 라벨로
   * 보여준다. 접힌 창은 본문이 보이지 않아 "어느 메모인가"를 알 단서가 헤더뿐이다. 기본 배치는
   * 좌측 존 끝에 core:collapsed-title을 두므로, 라벨은 그 존의 `.tb-zone-inner` 안 마지막
   * 항목으로 렌더된다(배치 순서 그대로 — note-toolbar.ts).
   */
  it("shows the note title as a label placed where the layout puts it", async () => {
    const host = document.createElement("div");
    const d = deps({ ...NO_OVERRIDES, collapsed: true });
    const windowTitle = vi.fn(async () => "첫 줄 제목");
    await mountNoteWindow(host, "n1", { ...d, windowTitle });
    await flush();

    const label = host.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label.textContent).toBe("첫 줄 제목");
    expect(label.title).toBe("첫 줄 제목"); // 말줄임됐을 때를 위한 전체 텍스트.

    // 기본 배치(좌측 존 끝)대로 좌측 존 안, 그 존의 마지막 항목이다.
    const zone = label.closest<HTMLElement>(".tb-zone")!;
    expect(zone.dataset.align).toBe("left");
    const inner = label.closest<HTMLElement>(".tb-zone-inner")!;
    expect(inner.lastElementChild).toBe(label);
  });

  /**
   * 가드(핵심): 자동저장이 디바운스 대기 중일 때 접으면, 그 순간엔 아직 옛 제목을 보여주더라도
   * 저장이 **실제로 끝난 뒤**(백엔드 refresh_window_title 이후) 라벨이 최신 제목으로 다시
   * 갱신된다 — "고치고 곧바로 접기"가 옛 제목에 영영 걸리는 회귀를 막는다.
   */
  it("refreshes the collapsed label once a save that was pending at collapse-time completes", async () => {
    const host = document.createElement("div");
    const d = deps({ ...NO_OVERRIDES, collapsed: false });
    const titles = ["옛 제목", "새 제목"];
    const windowTitle = vi.fn(async () => titles.shift() ?? "새 제목");
    let resolveSave: () => void = () => {};
    const saveContent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    // `null as …` 형태: 리터럴 `= null` 초기화는 TS가 콜백 안 대입을 못 보고 `null`로 좁혀
    // 아래 호출 지점이 `never`가 된다(빌드 차단 TS2349).
    let insertText = null as ((text: string, mode: string) => void) | null;
    const note = await mountNoteWindow(host, "n1", {
      ...d,
      saveContent,
      windowTitle,
      installPlugins: (ctx) => {
        insertText = ctx.insertText;
      },
    });
    if (!insertText)
      throw new Error("installPlugins가 insertText를 제공하지 않음");

    insertText("고친 내용", "append"); // 디바운스 대기 중(아직 저장 전).
    note.flushSave(); // "곧바로 접기" 흉내 — saveContent는 불렸지만 아직 완료 전(프라미스 대기).
    host
      .querySelector<HTMLButtonElement>('[data-action="toggle-collapse"]')!
      .click();
    await flush();

    const label = host.querySelector<HTMLElement>(".note-collapsed-title")!;
    expect(label.textContent).toBe("옛 제목"); // 접는 순간 읽은 값 — 저장은 아직 진행 중.

    resolveSave(); // 백엔드 저장(및 refresh_window_title)이 이제 끝났다.
    await flush();
    expect(label.textContent).toBe("새 제목"); // 저장 완료 후 재조회로 최신 반영.
  });

  /**
   * 가드(핵심): 접는 순간 이미 열려 있던 배경색 스와치 패널(플로팅 레이어)을 닫는다. CSS가
   * 트리거를 감춰도 패널 자체의 hidden 상태는 별개라, 닫지 않으면 다시 펼쳤을 때 뜬금없이 열린
   * 패널이 남는다(hideSelectionToolbar와 같은 이유 — note-window.ts 주석 참고).
   */
  it("collapsing closes an already-open background swatch panel", async () => {
    const host = document.createElement("div");
    const d = deps({ ...NO_OVERRIDES, collapsed: false });
    await mountNoteWindow(host, "n1", { ...d, background: DEFAULT_BACKGROUND });

    const bgTrigger =
      host.querySelector<HTMLButtonElement>(".note-bg-trigger")!;
    const bgPanel = bgTrigger
      .closest<HTMLElement>(".note-toolbar-more")!
      .querySelector<HTMLElement>(".note-toolbar-swatches")!;
    bgTrigger.click();
    expect(bgPanel.hidden).toBe(false);

    host
      .querySelector<HTMLButtonElement>('[data-action="toggle-collapse"]')!
      .click();
    expect(host.classList.contains("note-collapsed")).toBe(true);
    expect(bgPanel.hidden).toBe(true);
  });

  /** 가드: 접기 컨트롤이 배치에 없는데 접힘으로 저장된 노트는 마운트 시 펼침으로 되돌린다(갇힘 방지). */
  it("auto-expands a collapsed note whose layout has no collapse control", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: null,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: null,
      all_spaces: null,
      collapsed: true,
    });
    await mountNoteWindow(host, "n1", {
      ...d,
      // 상단 0단·하단에 삭제만 → 접기 컨트롤이 배치에 없다.
      toolbarLayout: {
        top: { align: "left", zones: [] },
        bottom: { align: "left", zones: [["core:delete"]] },
      },
    });
    expect(d.applyCollapsed).toHaveBeenLastCalledWith(false); // 창 높이 복원
    const calls = d.saveOverrides.mock.calls;
    const saved = calls[calls.length - 1][1] as NoteOverrides;
    expect(saved.collapsed).toBe(false); // 펼침 상태로 영속화
  });

  /**
   * 가드(핵심): 확인창 메시지가 이 메모에 실제로 설정된 항목만 이름으로 명시한다(무엇이 사라지는지).
   * 투명도·항상 위만 설정 → 메시지에 그 둘만 들고, 안 바꾼 항목(배경색·글자 크기)은 빠진다.
   * 또한 뭔가 커스터마이즈됐으니 alert가 아닌 취소 버튼 있는 파괴적 확인창이어야 한다.
   */
  it("resetOptions confirm names exactly the customized settings", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: 50,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: true,
      all_spaces: null,
      collapsed: null,
    });
    const resetOptions = await captureReset(host, d);

    resetOptions();
    const msg = host.querySelector(".confirm-msg")!.textContent!;
    expect(msg).toContain("투명도");
    expect(msg).toContain("항상 위");
    expect(msg).not.toContain("배경색");
    expect(msg).not.toContain("글자 크기");
    // 커스터마이즈가 있으니 alert가 아니라 취소 버튼이 있는 파괴적 확인창이다.
    expect(host.querySelector(".confirm-cancel")).not.toBeNull();
  });

  /**
   * 가드: 커스터마이즈가 없으면(모든 override null) 되돌릴 게 없다는 안내만 뜬다 — 취소 버튼 없는
   * alert(확인만)이고, 확인해도 override를 비우거나 저장하지 않는다(파괴적 동작 없음).
   */
  it("resetOptions service only informs (no clearing) when nothing is customized", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: null,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: null,
      all_spaces: null,
      collapsed: null,
    });
    const resetOptions = await captureReset(host, d);
    d.saveOverrides.mockClear();

    resetOptions();
    // alert 모드: 확인 버튼만 있고 취소 버튼은 없다.
    expect(host.querySelector(".confirm-cancel")).toBeNull();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    expect(d.saveOverrides).not.toHaveBeenCalled();
    expect(d.applyPinned).not.toHaveBeenCalled();
  });

  /** 가드: confirm을 취소하면 아무것도 바뀌지 않는다(파괴적 동작 게이트). */
  it("resetOptions service does nothing when the confirm is cancelled", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: 50,
      background: null,
      font_delta: 40,
      markdown_preview: false,
      pinned: true,
      all_spaces: true,
      collapsed: null,
    });
    const resetOptions = await captureReset(host, d);
    d.applyPinned.mockClear();
    d.saveOverrides.mockClear();

    resetOptions();
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();

    expect(d.applyPinned).not.toHaveBeenCalled();
    expect(d.saveOverrides).not.toHaveBeenCalled();
  });

  /**
   * 가드: 툴바 빈 영역을 좌클릭하면 창 드래그(startDrag)를 시작하되 mousedown 기본동작을 막는다
   * — 네이티브 창 이동과 겹쳐 WebKit이 텍스트 선택 제스처를 걸어 이동 중 커서가 I-beam으로 바뀌던
   * 문제 방지. 버튼 위에서는 드래그를 시작하지도, 기본동작을 막지도 않는다(클릭·포커스 보존).
   */
  it("empty toolbar mousedown starts window drag and prevents the default (no text-select cursor)", async () => {
    const host = document.createElement("div");
    const d = deps({
      transparency: null,
      background: null,
      font_delta: null,
      markdown_preview: null,
      pinned: null,
      all_spaces: null,
      collapsed: null,
    });
    await mountNoteWindow(host, "n1", { ...d });

    const bar = host.querySelector<HTMLElement>(
      ".note-toolbar:not(.note-toolbar--bottom)",
    )!;
    const onBar = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    bar.dispatchEvent(onBar);
    expect(d.startDrag).toHaveBeenCalledTimes(1);
    expect(onBar.defaultPrevented).toBe(true);

    // 버튼 위 mousedown은 early-return: 드래그도 없고 기본동작도 막지 않는다.
    const btn = host.querySelector<HTMLElement>(".note-toolbar-btn")!;
    const onBtn = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    btn.dispatchEvent(onBtn);
    expect(d.startDrag).toHaveBeenCalledTimes(1);
    expect(onBtn.defaultPrevented).toBe(false);
  });
});

describe("mountNoteWindow — 저장 flush(리로드·창 닫힘 전 유실 방지)", () => {
  /** flush 테스트용 최소 의존성(모두 스파이) — 본문은 빈 문자열로 시작(baseNoteDeps 기본과 동일). */
  function baseDeps() {
    return baseNoteDeps();
  }

  /**
   * installPlugins ctx의 insertText를 붙잡아 에디터에 실제 변경을 일으킨다(onChange→디바운스
   * save 무장). mountNoteWindow가 반환하는 핸들도 함께 돌려준다.
   */
  function mountAndCaptureInsert(
    host: HTMLElement,
    d: ReturnType<typeof baseDeps>,
  ) {
    // `null as …` 형태: 리터럴 `= null` 초기화는 TS가 콜백 안 대입을 못 보고 `null`로 좁혀
    // 아래 호출 지점이 `never`가 된다(빌드 차단 TS2349).
    let insertText = null as ((text: string, mode: string) => void) | null;
    return mountNoteWindow(host, "n1", {
      ...d,
      installPlugins: (ctx) => {
        insertText = ctx.insertText;
      },
    }).then((handle) => {
      if (!insertText)
        throw new Error("installPlugins가 insertText를 제공하지 않음");
      return { handle, insertText };
    });
  }

  /** 가드(핵심): flushSave()가 디바운스 대기 중인 본문 저장을 ms를 기다리지 않고 즉시 확정한다. */
  it("flushSave() commits a pending debounced save immediately", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      const { handle, insertText } = await mountAndCaptureInsert(host, d);

      insertText("추가된 내용", "append");
      expect(d.saveContent).not.toHaveBeenCalled(); // 아직 500ms(기본 디바운스)가 안 지남

      handle.flushSave();
      expect(d.saveContent).toHaveBeenCalledTimes(1);
      expect(d.saveContent).toHaveBeenCalledWith("n1", "추가된 내용");

      // 이미 확정됐으니(타이머 취소) 원래 지연이 지나도 다시 불리지 않는다.
      vi.advanceTimersByTime(500);
      expect(d.saveContent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드(데이터 안전, finding 4): reloadContent()가 본문을 디스크에서 다시 읽어 에디터 버퍼를
   * 교체한다 — 스냅샷 복원으로 파일이 바깥에서 바뀌었을 때, 낡은 버퍼가 그 복원을 덮지 않게
   * 그 노트의 열린 창이 디스크를 다시 읽는다. */
  it("reloadContent() re-reads the note from disk and replaces the editor buffer", async () => {
    const host = document.createElement("div");
    const d = baseDeps();
    let call = 0;
    d.loadNote = vi.fn(async () => ({
      content: call++ === 0 ? "낡은 버퍼" : "복원된 본문",
      overrides: {
        transparency: null,
        background: null,
        font_delta: null,
        markdown_preview: null,
        pinned: null,
        all_spaces: null,
        collapsed: null,
      },
    }));
    const handle = await mountNoteWindow(host, "n1", { ...d });
    // 초기 버퍼는 첫 loadNote 결과.
    expect(host.querySelector(".cm-content")!.textContent).toContain(
      "낡은 버퍼",
    );
    await handle.reloadContent();
    expect(d.loadNote).toHaveBeenCalledTimes(2); // 디스크를 다시 읽었다.
    expect(host.querySelector(".cm-content")!.textContent).toContain(
      "복원된 본문",
    );
    expect(host.querySelector(".cm-content")!.textContent).not.toContain(
      "낡은 버퍼",
    );
  });

  /** 가드(데이터 안전, finding 2·3): reloadContent()는 저장 대기 중인 사용자 타이핑을 프로그램적
   * 쓰기(플러그인 notes.write·스냅샷 복원)로 덮지 않는다. 사용자가 방금 친(아직 디스크에 안 내려간)
   * 본문은 보존하고, 대기 중인 자동저장을 flush해 디스크에 확정한다. 예전 코드는 무조건 디스크를
   * 다시 읽어 setContent로 버퍼를 통째로 교체해 그 타이핑을 조용히 잃었다. */
  it("reloadContent() preserves unsaved local edits instead of clobbering them", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      let call = 0;
      d.loadNote = vi.fn(async () => ({
        content: call++ === 0 ? "" : "플러그인이 쓴 본문",
        overrides: {
          transparency: null,
          background: null,
          font_delta: null,
          markdown_preview: null,
          pinned: null,
          all_spaces: null,
          collapsed: null,
        },
      }));
      const { handle, insertText } = await mountAndCaptureInsert(host, d);
      // 사용자가 타이핑 중 — onChange가 미저장 플래그를 세우고 자동저장은 아직 디바운스 대기.
      insertText("사용자가 지금 치는 중", "append");
      expect(d.saveContent).not.toHaveBeenCalled();

      // 그 순간 플러그인이 이 노트에 써서 EV_NOTE_RESTORED → reloadContent가 떨어진다.
      await handle.reloadContent();

      // 사용자 타이핑이 유실되지 않는다(프로그램적 쓰기로 덮지 않음).
      const shown = host.querySelector(".cm-content")!.textContent ?? "";
      expect(shown).toContain("사용자가 지금 치는 중");
      expect(shown).not.toContain("플러그인이 쓴 본문");
      // 대기 중이던 사용자 편집은 flush로 디스크에 확정된다.
      expect(d.saveContent).toHaveBeenCalledWith("n1", "사용자가 지금 치는 중");
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: flushSave()는 대기 중인 변경이 없으면 아무 것도 저장하지 않는다(안전한 no-op). */
  it("flushSave() is a no-op when nothing is pending", async () => {
    const host = document.createElement("div");
    const d = baseDeps();
    const handle = await mountNoteWindow(host, "n1", { ...d });
    handle.flushSave();
    expect(d.saveContent).not.toHaveBeenCalled();
  });

  /**
   * 가드(데이터 부활 회귀 — 패널 삭제 경로): `cancelSave()`가 대기 중인 본문 저장을 버리면,
   * 뒤이은 `pagehide`(창을 닫을 때) flush는 아무것도 저장하지 않는다.
   *
   * 왜: 이 창의 노트가 다른 창(패널)에서 지워지면 백엔드가 `note-deleted`를 방송하고,
   * `bootstrap/note.ts`의 리스너가 이 메서드를 부른 뒤 창을 닫는다. 취소 없이 닫히면
   * `note_save_content`가 `write_atomic`으로 방금 지운 `.md`를 되살릴 수 있다 — 이 창 자신의
   * 삭제 버튼(`deleteNote` 핸들러의 `save.cancel()`)이 이미 같은 이유로 지키는 계약을,
   * 바깥에서 받은 삭제 통지도 똑같이 지켜야 한다.
   */
  it("cancelSave() drops the pending save so a later pagehide does not resurrect the note", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      const { handle, insertText } = await mountAndCaptureInsert(host, d);

      insertText("다른 창에서 삭제됨", "append");
      expect(d.saveContent).not.toHaveBeenCalled();

      handle.cancelSave();
      window.dispatchEvent(new Event("pagehide"));
      vi.advanceTimersByTime(1000);
      expect(d.saveContent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: cancelSave()를 여러 번 불러도(중복 통지·자기 삭제 경로와 겹침) 안전하다 —
   * 대기 중인 저장이 없을 때도 예외 없이 no-op이다. */
  it("cancelSave() is idempotent when called multiple times or with nothing pending", async () => {
    const host = document.createElement("div");
    const d = baseDeps();
    const handle = await mountNoteWindow(host, "n1", { ...d });
    expect(() => {
      handle.cancelSave();
      handle.cancelSave();
    }).not.toThrow();
    expect(d.saveContent).not.toHaveBeenCalled();
  });

  /** 가드(핵심): 창을 그냥 닫아도(pagehide) 대기 중인 저장이 유실되지 않는다. */
  it("pagehide flushes a pending debounced save", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      const { insertText } = await mountAndCaptureInsert(host, d);

      insertText("유실 방지 테스트", "append");
      expect(d.saveContent).not.toHaveBeenCalled();

      window.dispatchEvent(new Event("pagehide"));
      expect(d.saveContent).toHaveBeenCalledTimes(1);
      expect(d.saveContent).toHaveBeenCalledWith("n1", "유실 방지 테스트");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 가드(데이터 부활 회귀): 삭제를 시작하면 대기 중인 본문 저장은 **취소**된다 — 삭제 후에
   * 떨어지는 pagehide flush가 `saveContent`를 부르면 안 된다.
   *
   * 왜: 삭제 경로는 `deleteNote(id)` → IPC 삭제 → 창 닫기 → pagehide다. flush가 그 뒤에
   * `note_save_content`를 부르면 `write_atomic`이 `<id>.md`를 **새로 만들어** 메타 없는 본문이
   * 남고, 다음 실행의 reconcile이 메타를 만들어 "영구 삭제한 노트"가 목록에 되살아난다.
   * 본문을 비운 뒤 「보관」을 누르는 경로는 확인 다이얼로그도 없어 특히 쉽게 닿는다.
   */
  it("cancels the pending save when the note is deleted (no resurrection on pagehide)", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      d.loadNote = vi.fn(async () => ({
        content: "지울 내용",
        overrides: {
          transparency: null,
          background: null,
          font_delta: null,
          markdown_preview: null,
          pinned: null,
          all_spaces: null,
          collapsed: null,
        },
      }));
      const { insertText } = await mountAndCaptureInsert(host, d);

      insertText("", "replace"); // 전체 선택 후 Delete와 같은 효과 → 디바운스 저장 무장
      expect(d.saveContent).not.toHaveBeenCalled();

      // 본문이 비었으므로 「보관」은 archive가 아니라 delete로 간다(빈 노트 자동 정리).
      host.querySelector<HTMLElement>('[data-action="archive-note"]')?.click();
      expect(d.deleteNote).toHaveBeenCalledWith("n1");

      window.dispatchEvent(new Event("pagehide")); // 창 닫힘
      vi.advanceTimersByTime(1000); // 남은 타이머도 흘려 보낸다
      expect(d.saveContent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 확인 다이얼로그를 거치는 명시적 「삭제」도 같다 — 확인 직후 대기 저장이 취소돼
   * 이어지는 pagehide flush가 노트를 되살리지 않는다. */
  it("cancels the pending save when deleting via the toolbar delete button", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      const { insertText } = await mountAndCaptureInsert(host, d);

      insertText("곧 지울 내용", "append");
      host.querySelector<HTMLElement>('[data-action="delete-note"]')?.click();
      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await Promise.resolve(); // confirmDialog의 .then(마이크로태스크)이 돌게 한다

      expect(d.deleteNote).toHaveBeenCalledWith("n1");
      window.dispatchEvent(new Event("pagehide"));
      vi.advanceTimersByTime(1000);
      expect(d.saveContent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 가드: 보관은 본문을 보존하므로 버리지 않고 **보관 전에 확정**한다 — 마지막 타이핑이
   * 유실되지 않으면서, 확정으로 대기열이 비어 창 닫힘의 pagehide flush는 중복 저장을 내지
   * 않는다(정확히 1회).
   */
  it("flushes once before archiving and does not save again on pagehide", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      const d = baseDeps();
      const { insertText } = await mountAndCaptureInsert(host, d);

      insertText("보관 직전 입력", "append");
      host.querySelector<HTMLElement>('[data-action="archive-note"]')?.click();
      expect(d.saveContent).toHaveBeenCalledTimes(1);
      expect(d.saveContent).toHaveBeenCalledWith("n1", "보관 직전 입력");
      expect(d.archiveNote).toHaveBeenCalledWith("n1");

      window.dispatchEvent(new Event("pagehide"));
      vi.advanceTimersByTime(1000);
      expect(d.saveContent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountNoteWindow — 서드파티 툴바 버튼 자동 배치(배치도 seen도 모르는 신규)", () => {
  /** 배치·seen 없는(=기본 배치) 노트에서 플러그인 버튼을 등록하는 최소 의존성. */
  function deps() {
    return baseNoteDeps();
  }

  /**
   * 가드(핵심): 배치가 한 번도 알지 못하는(기본 배치·저장된 배치 어디에도 없는) 신규 서드파티
   * 버튼도 설치 직후 렌더된다 — position 폴백 덕분에 설정에서 미리 배치해 두지 않아도 보인다.
   * data-action도 붙어 있어 키맵(shortcuts/keymap.ts)이 querySelector로 이 버튼을 찾아 클릭할 수
   * 있다(단축키 no-op 회귀 방지).
   */
  it("renders a brand-new third-party toolbar button via its declared position", async () => {
    const host = document.createElement("div");
    const onClick = vi.fn();
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctx.reconcileToolbarItems([
          {
            id: "hello",
            pluginId: "demo-plugin",
            label: "H",
            title: "안녕",
            position: "bottom-right",
            onClick,
          },
        ]);
      },
    });

    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:demo-plugin:hello"]',
    );
    expect(btn).not.toBeNull();
    // 하단 우측 존(bottom-right 폴백)에 실제로 append됐는지 — host 하위 DOM 트리에 붙었는지로 확인.
    expect(host.contains(btn)).toBe(true);
    btn!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(핵심): 상태 표시형 아이템은 **버튼이 아니라 텍스트**로 렌더되고(클릭 없음), 버튼과
   * 같은 position 폴백으로 배치되며, 창-스코프 `updateStatusItem`이 그 창의 텍스트를 라이브로
   * 갱신한다. 등록 전에 부르거나 없는 id면 null(호출부가 INVALID_ARGS로 거부).
   */
  it("renders a status item as text and updates it live via updateStatusItem", async () => {
    const host = document.createElement("div");
    let ctxRef!: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctxRef = ctx;
        ctx.reconcileToolbarItems([
          {
            // 실제 host-client(snapshotToolbarButtons)가 상태 아이템에 붙이는 `status:`
            // 접두를 그대로 흉내낸다 — 등록 키는 접두된 채로, updateStatusItem 호출은
            // (아래) 저작자 관점의 원래(무접두) id로 한다.
            id: "status:word-count",
            pluginId: "wc-plugin",
            label: "0 단어",
            title: "단어 수",
            position: "bottom-right",
            status: true,
            onClick: () => {},
          },
        ]);
      },
    });

    const el = host.querySelector<HTMLElement>(
      '.note-toolbar-status[data-item-key="plugin:wc-plugin:status:word-count"]',
    );
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe("SPAN"); // 버튼이 아니라 텍스트 요소
    expect(el!.textContent).toBe("0 단어");
    expect(host.contains(el)).toBe(true);
    // 버튼 목록에 섞이지 않는다(클릭 대상이 아니다) — data-action 버튼이 만들어지지 않았다.
    expect(
      host.querySelector('[data-action="plugin:wc-plugin:status:word-count"]'),
    ).toBeNull();

    // 라이브 갱신: 부분 갱신(text만) → 텍스트만 바뀌고 툴팁은 유지된다.
    expect(
      ctxRef.updateStatusItem(
        { id: "word-count", text: "3 단어" },
        "wc-plugin",
      ),
    ).toBe("word-count");
    expect(el!.textContent).toBe("3 단어");
    expect(el!.title).toBe("단어 수");

    // 없는 id·다른 owner는 null(호출부가 INVALID_ARGS로 거부하는 신호).
    expect(ctxRef.updateStatusItem({ id: "nope" }, "wc-plugin")).toBeNull();
    expect(ctxRef.updateStatusItem({ id: "word-count" }, "other")).toBeNull();
  });

  /**
   * 가드(클릭 확장): `clickable: true`인 상태 아이템(저작자가 onClick을 준 경우, 예:
   * 단어 수 세그먼트 클릭 복사)은 `is-clickable` 클래스가 붙고 클릭이 실제로 onClick을
   * 역호출한다 — 위 테스트(`clickable` 없음)와 대칭: 커서·리스너는 이 플래그로만 갈린다.
   */
  it("attaches a click listener to a status item marked clickable", async () => {
    const host = document.createElement("div");
    const onClick = vi.fn();
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctx.reconcileToolbarItems([
          {
            // host-client가 붙이는 `status:` 접두를 흉내낸다(위 테스트와 같은 이유).
            id: "status:word-count-words",
            pluginId: "wc-plugin",
            label: "3 단어",
            title: "단어 수 — 눌러서 복사",
            position: "bottom-right",
            status: true,
            clickable: true,
            onClick,
          },
        ]);
      },
    });

    const el = host.querySelector<HTMLElement>(
      '.note-toolbar-status[data-item-key="plugin:wc-plugin:status:word-count-words"]',
    );
    expect(el).not.toBeNull();
    expect(el!.classList.contains("is-clickable")).toBe(true);
    el!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(회귀, Windows): 클릭 가능한 상태 아이템 위 mousedown은 **창 드래그를 걸지 않는다**.
   *
   * 걸면 네이티브 드래그 루프가 마우스를 캡처해 이어지는 mouseup을 먹고, DOM click이 끝내
   * 발생하지 않는다 — Windows에서 단어 수를 눌러도 복사도 토스트도 없던 원인이다(macOS에서는
   * 같은 코드로도 클릭이 살아남아 오래 안 보였다). 그래서 클릭 가능한 아이템은 `<button>`으로
   * 그리고, 드래그 핸들러의 예외 목록이 그것을 걸러낸다.
   */
  it("mousedown on a clickable status item never starts a window drag", async () => {
    const host = document.createElement("div");
    const onClick = vi.fn();
    const d = deps();
    await mountNoteWindow(host, "n1", {
      ...d,
      installPlugins: (ctx) => {
        ctx.reconcileToolbarItems([
          {
            // host-client가 붙이는 `status:` 접두를 흉내낸다(위 테스트들과 같은 이유).
            id: "status:word-count-words",
            pluginId: "wc-plugin",
            label: "3 단어",
            position: "bottom-right",
            status: true,
            clickable: true,
            onClick,
          },
          // 순수 텍스트 아이템은 드래그 영역으로 남는다(창을 잡아 옮길 수 있어야 한다).
          {
            id: "status:plain",
            pluginId: "wc-plugin",
            label: "3 자",
            position: "bottom-right",
            status: true,
            onClick: vi.fn(),
          },
        ]);
      },
    });

    const clickable = host.querySelector<HTMLElement>(
      '.note-toolbar-status[data-item-key="plugin:wc-plugin:status:word-count-words"]',
    )!;
    // 진짜 버튼이어야 한다 — 드래그 예외 목록(`button`)과 키보드 접근이 여기서 나온다.
    expect(clickable.tagName).toBe("BUTTON");
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    clickable.dispatchEvent(down);
    expect(d.startDrag).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(false); // 기본동작을 막지 않아야 클릭·포커스가 산다.
    clickable.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    // 클릭 불가 상태 아이템은 예전 그대로 텍스트 = 드래그 영역이다.
    const plain = host.querySelector<HTMLElement>(
      '.note-toolbar-status[data-item-key="plugin:wc-plugin:status:plain"]',
    )!;
    expect(plain.tagName).toBe("SPAN");
    plain.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    expect(d.startDrag).toHaveBeenCalledTimes(1);
  });
});

/**
 * 플러그인 항목의 **런타임 추가·삭제·변경** — 호스트 재빌드 뒤 창을 리로드하지 않고 툴바·상태
 * 아이템·컨텍스트 메뉴를 제자리에서 맞추는 경로(`NoteWindowHandle.reconcileToolbarItems`,
 * `bootstrap/host-update-plan.ts`의 `toolbar_items` 단계).
 *
 * 왜 mountNoteWindow를 통째로 띄우나: 계약이 "실제 창에서 무엇이 남고 무엇이 사라지는가"라
 * DOM·메뉴·상태 조회를 함께 봐야 한다. 순수 diff만 검증하면 배선이 빠져도 통과한다.
 */
describe("mountNoteWindow — 플러그인 항목 런타임 조정", () => {
  /** 배치·seen 없는(=기본 배치) 노트. 본문이 있어야 컨텍스트 메뉴 항목 판정이 자연스럽다. */
  function deps() {
    return baseNoteDeps({
      loadNote: vi.fn(async () => ({
        content: "본문 내용",
        overrides: NO_OVERRIDES,
      })),
    });
  }

  /** 툴바 버튼 항목 하나(필요한 필드만 덮어쓴다 — 기본은 하단 우측 폴백 버튼). */
  function item(
    over: Partial<PluginWindowItem> &
      Pick<PluginWindowItem, "id" | "pluginId" | "onClick">,
  ): PluginWindowItem {
    return { label: "B", position: "bottom-right", ...over };
  }

  /** 우클릭으로 컨텍스트 메뉴를 열고 플러그인 구역의 라벨을 읽는다. */
  function menuLabels(host: HTMLElement): (string | null)[] {
    host
      .querySelector<HTMLElement>(".cm-editor")!
      .dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    return [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].map((b) => b.textContent);
  }

  /** 열려 있는 메뉴를 Esc로 닫는다(popup이 document 캡처 단계에서 듣는다). */
  function closeMenu(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }

  /**
   * 가드(핵심): 마운트 뒤에 등장한 항목이 리로드 없이 툴바 버튼·상태 아이템·컨텍스트 메뉴에
   * 모두 나타난다 — 플러그인 설치·활성화가 창을 깜빡이지 않는 경로의 종단 확인.
   */
  it("adds a button, a status item and a menu item at runtime", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const note = await mountNoteWindow(host, "n1", deps());
    expect(host.querySelector('[data-action="plugin:demo:b"]')).toBeNull();

    const onClick = vi.fn();
    note.reconcileToolbarItems([
      item({ id: "b", pluginId: "demo", label: "📄", title: "버튼", onClick }),
      item({
        // host-client가 붙이는 `status:` 접두를 흉내낸다(같은 규약을 note-window.test.ts
        // 전체가 공유 — host-client.test.ts의 "namespaces a status item's id" 참고).
        id: "status:s",
        pluginId: "demo",
        label: "0 단어",
        title: "단어 수",
        status: true,
        onClick: vi.fn(),
      }),
      item({
        id: "menu:only",
        pluginId: "demo",
        label: "메뉴만",
        title: "메뉴만",
        menuOnly: true,
        onClick: vi.fn(),
      }),
    ]);

    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:demo:b"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector(
        '.note-toolbar-status[data-item-key="plugin:demo:status:s"]',
      )?.textContent,
    ).toBe("0 단어");
    // 메뉴에는 버튼·메뉴전용 항목이 이름으로 오르고, 상태 아이템은 오르지 않는다(표시일 뿐).
    const labels = menuLabels(host);
    expect(labels).toContain("버튼");
    expect(labels).toContain("메뉴만");
    expect(labels).not.toContain("단어 수");
    closeMenu();
  });

  /**
   * 가드(핵심): 목록에서 빠진 항목은 툴바 DOM·상태 아이템 조회·컨텍스트 메뉴에서 **전부**
   * 사라진다 — 한 곳이라도 남으면 죽은 샌드박스를 역호출하는 유령 항목이 된다.
   */
  it("removes a vanished item from the toolbar, statusEls and the context menu", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let ctxRef!: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
    const note = await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctxRef = ctx;
      },
    });
    note.reconcileToolbarItems([
      item({
        id: "b",
        pluginId: "demo",
        label: "📄",
        title: "버튼",
        onClick: vi.fn(),
      }),
      item({
        id: "status:s",
        pluginId: "demo",
        label: "0 단어",
        status: true,
        onClick: vi.fn(),
      }),
    ]);
    expect(ctxRef.updateStatusItem({ id: "s", text: "1" }, "demo")).toBe("s");

    note.reconcileToolbarItems([]);

    expect(host.querySelector('[data-action="plugin:demo:b"]')).toBeNull();
    expect(
      host.querySelector('[data-item-key="plugin:demo:status:s"]'),
    ).toBeNull();
    // 상태 아이템 조회에서도 빠진다 → 호출부가 INVALID_ARGS로 거부할 수 있다(조용한 성공 금지).
    expect(ctxRef.updateStatusItem({ id: "s", text: "2" }, "demo")).toBeNull();
    expect(menuLabels(host)).not.toContain("버튼");
    closeMenu();
  });

  /**
   * 가드(핵심): 라벨만 바뀐 항목은 **같은 자리**에 새 라벨로 다시 그려진다 — 요소가 교체되는
   * 것은 괜찮지만, 존의 맨 뒤로 밀려나면 "글자 하나 고쳤는데 버튼이 이사한" 모양이 된다.
   */
  it("re-renders a changed item in place (same slot, new label)", async () => {
    const host = document.createElement("div");
    const note = await mountNoteWindow(host, "n1", deps());
    const first = item({
      id: "a",
      pluginId: "demo",
      label: "A",
      onClick: vi.fn(),
    });
    const second = item({
      id: "z",
      pluginId: "demo",
      label: "Z",
      onClick: vi.fn(),
    });
    note.reconcileToolbarItems([first, second]);
    const zone = host.querySelector<HTMLElement>(
      '[data-action="plugin:demo:a"]',
    )!.parentElement!;
    const keysBefore = [...zone.children].map(
      (c) => (c as HTMLElement).dataset.itemKey,
    );

    const onClick2 = vi.fn();
    note.reconcileToolbarItems([
      { ...first, label: "A2", onClick: onClick2 },
      second,
    ]);

    expect(
      [...zone.children].map((c) => (c as HTMLElement).dataset.itemKey),
    ).toEqual(keysBefore);
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:demo:a"]',
    )!;
    expect(btn.textContent).toBe("A2");
    btn.click();
    expect(onClick2).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(핵심): 같은 목록을 다시 적용하면 아무것도 다시 그리지 않는다(DOM 노드 동일성 유지) —
   * 그래야 포커스·`⋯` 접힘·상태 아이템의 라이브 텍스트가 재빌드마다 초기화되지 않는다.
   * 리스너도 늘지 않는다(클릭 1회 = invoke 1회).
   */
  it("is a no-op for an unchanged list (same nodes, no duplicate listeners)", async () => {
    const host = document.createElement("div");
    let ctxRef!: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
    const note = await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctxRef = ctx;
      },
    });
    const onClick = vi.fn();
    const list = [
      item({ id: "b", pluginId: "demo", label: "📄", onClick }),
      item({
        id: "status:s",
        pluginId: "demo",
        label: "0 단어",
        status: true,
        onClick: vi.fn(),
      }),
    ];
    note.reconcileToolbarItems(list);
    const btn = host.querySelector('[data-action="plugin:demo:b"]');
    const statusEl = host.querySelector(
      '[data-item-key="plugin:demo:status:s"]',
    );
    // 라이브 갱신값 — 재적용이 이것을 등록 시점 텍스트로 되돌리면 안 된다.
    ctxRef.updateStatusItem({ id: "s", text: "42 단어" }, "demo");

    // 클로저는 재빌드마다 새것이지만 직렬화 필드는 같다 → 다시 그릴 이유가 없다.
    note.reconcileToolbarItems(list.map((i) => ({ ...i })));

    expect(host.querySelector('[data-action="plugin:demo:b"]')).toBe(btn);
    expect(host.querySelector('[data-item-key="plugin:demo:status:s"]')).toBe(
      statusEl,
    );
    expect(statusEl!.textContent).toBe("42 단어");
    (btn as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(무음 실패 방지): 직렬화 필드가 같아 요소를 그대로 둔 항목도 **핸들러만은** 새 목록의
   * 것을 부른다. 재빌드는 모든 샌드박스를 새 인스턴스로 갈아 끼우므로, 옛 클로저가 잡고 있는
   * 핸들러 id는 죽어 있다 — 누르면 아무 일도 일어나지 않는 종류의 실패다.
   */
  it("swaps in the fresh onClick even when nothing else changed", async () => {
    const host = document.createElement("div");
    const note = await mountNoteWindow(host, "n1", deps());
    const stale = vi.fn();
    const fresh = vi.fn();
    const base = item({
      id: "b",
      pluginId: "demo",
      label: "📄",
      onClick: stale,
    });
    note.reconcileToolbarItems([base]);
    note.reconcileToolbarItems([{ ...base, onClick: fresh }]);

    host
      .querySelector<HTMLButtonElement>('[data-action="plugin:demo:b"]')!
      .click();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드: 메뉴 전용 항목도 최신 핸들러로 실행된다 — 실행 경로가 레지스트리를 되짚기 때문에
   * 메뉴 등록부에 핸들러 사본이 남아 갈리는 일이 없다.
   */
  it("runs the fresh handler for a menu-only item after a reconcile", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const note = await mountNoteWindow(host, "n1", deps());
    const stale = vi.fn();
    const fresh = vi.fn();
    const base = item({
      id: "cmd:run",
      pluginId: "demo",
      label: "실행",
      title: "실행",
      menuOnly: true,
      onClick: stale,
    });
    note.reconcileToolbarItems([base]);
    note.reconcileToolbarItems([{ ...base, onClick: fresh }]);

    expect(menuLabels(host)).toContain("실행");
    [...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item")]
      .find((b) => b.textContent === "실행")!
      .click();
    await Promise.resolve();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드: 항목 하나가 바뀌어도 컨텍스트 메뉴는 **새 목록 순서** 그대로다 — 바뀐 것만 다시
   * 등록하면 그 항목이 메뉴 맨 아래로 밀려, 라벨 한 글자를 고쳤을 뿐인데 자리가 옮겨지고
   * 리로드한 창(스냅샷 순서)과도 갈린다.
   */
  it("keeps the context menu in the new list order after one item changed", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const note = await mountNoteWindow(host, "n1", deps());
    const menuItem = (id: string, label: string): PluginWindowItem =>
      item({
        id: `menu:${id}`,
        pluginId: "demo",
        label,
        title: label,
        menuOnly: true,
        onClick: vi.fn(),
      });
    note.reconcileToolbarItems([
      menuItem("a", "A"),
      menuItem("b", "B"),
      menuItem("c", "C"),
    ]);
    note.reconcileToolbarItems([
      menuItem("a", "A"),
      menuItem("b", "B2"),
      menuItem("c", "C"),
    ]);

    const labels = menuLabels(host);
    expect(labels.indexOf("A")).toBeLessThan(labels.indexOf("B2"));
    expect(labels.indexOf("B2")).toBeLessThan(labels.indexOf("C"));
    closeMenu();
  });

  /**
   * 가드: 재마운트(변경)된 상태 아이템도 `updateStatusItem`이 계속 찾아낸다 — 조회 맵이
   * 옛 요소를 가리킨 채 남으면 갱신이 화면에 안 보이는 요소로 새어 나간다.
   */
  it("keeps updateStatusItem working after a status item was re-rendered", async () => {
    const host = document.createElement("div");
    let ctxRef!: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
    const note = await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctxRef = ctx;
      },
    });
    const base = item({
      id: "status:s",
      pluginId: "demo",
      label: "0 단어",
      status: true,
      onClick: vi.fn(),
    });
    note.reconcileToolbarItems([base]);
    note.reconcileToolbarItems([{ ...base, label: "새 초기값" }]);

    const el = host.querySelector<HTMLElement>(
      '[data-item-key="plugin:demo:status:s"]',
    )!;
    expect(el.textContent).toBe("새 초기값");
    expect(ctxRef.updateStatusItem({ id: "s", text: "7 단어" }, "demo")).toBe(
      "s",
    );
    expect(el.textContent).toBe("7 단어");
  });

  /**
   * 가드: 한 목록에 같은 키가 두 번 들어와도 요소는 하나다(뒤엣것이 이긴다) — 예전처럼
   * 더하기만 하는 등록이면 요소가 늘고 클릭이 여러 번 난다.
   */
  it("collapses duplicate keys within one list (last one wins)", async () => {
    const host = document.createElement("div");
    const onClick = vi.fn();
    const note = await mountNoteWindow(host, "n1", deps());
    note.reconcileToolbarItems([
      item({ id: "b", pluginId: "demo", label: "A", onClick: vi.fn() }),
      item({ id: "b", pluginId: "demo", label: "B", onClick }),
    ]);

    const found = host.querySelectorAll('[data-action="plugin:demo:b"]');
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toBe("B");
    (found[0] as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(회귀, TDZ): 마운트 경로는 **ctx**로도 같은 조정을 부를 수 있어야 한다 —
   * `bootstrap/note.ts`의 최초 등록은 핸들이 아직 초기화되기 전에 실행되므로 ctx가 유일하게
   * 안전한 통로다(핸들을 쓰면 ReferenceError로 플러그인 항목이 통째로 사라진다).
   */
  it("registers items through the installPlugins ctx at mount time", async () => {
    const host = document.createElement("div");
    const onClick = vi.fn();
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctx.reconcileToolbarItems([
          item({ id: "b", pluginId: "demo", label: "📄", onClick }),
        ]);
      },
    });

    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:demo:b"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(회귀 — 버튼·상태아이템 id 교차 충돌): 한 플러그인이 같은 id로 버튼
   * (`ui.addToolbarButton({id:"x"})`)과 상태 아이템(`ui.addStatusItem({id:"x"})`)을 함께
   * 등록해도 둘 다 마운트되고 서로 다른 요소로 남는다 — 상태 아이템의 등록 키는 `status:`
   * 네임스페이스로 갈려(`snapshotToolbarButtons`가 상태 아이템 id에 `status:`를 접두한다 —
   * host-client.test.ts의 "namespaces a status item's id" 참고) 같은 id의 버튼과
   * `reconcileToolbarItems`의 `next` Map에서 충돌하지 않는다. 접두가 없던 예전에는 나중에
   * 도는 상태 아이템이 버튼을 무음으로 덮었다(이전 코드는 둘 다 그렸다). 각자 갱신·삭제도
   * 독립적이어야 한다.
   */
  it("mounts a same-id button and status item independently (kind-namespaced keys)", async () => {
    const host = document.createElement("div");
    let ctxRef!: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
    const onButtonClick = vi.fn();
    const note = await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctxRef = ctx;
      },
    });
    note.reconcileToolbarItems([
      item({
        id: "x",
        pluginId: "demo",
        label: "📄",
        title: "버튼",
        onClick: onButtonClick,
      }),
      item({
        // host-client가 실제로 만드는 모양(같은 원래 id "x"에 `status:` 접두)을 흉내낸다.
        id: "status:x",
        pluginId: "demo",
        label: "0 단어",
        title: "상태",
        status: true,
        onClick: vi.fn(),
      }),
    ]);

    // 둘 다 실제로 마운트된다 — 하나가 다른 하나를 덮지 않는다.
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:demo:x"]',
    );
    const statusEl = host.querySelector<HTMLElement>(
      '[data-item-key="plugin:demo:status:x"]',
    );
    expect(btn).not.toBeNull();
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toBe("0 단어");

    // 각자 갱신: updateStatusItem(플러그인 관점의 원래 id "x")은 상태 아이템만 건드린다.
    expect(ctxRef.updateStatusItem({ id: "x", text: "3 단어" }, "demo")).toBe(
      "x",
    );
    expect(statusEl!.textContent).toBe("3 단어");
    expect(btn!.textContent).toBe("📄");
    btn!.click();
    expect(onButtonClick).toHaveBeenCalledTimes(1);

    // 각자 삭제: 버튼만 목록에서 빼면 상태 아이템은 살아남는다.
    note.reconcileToolbarItems([
      item({
        id: "status:x",
        pluginId: "demo",
        label: "0 단어",
        status: true,
        onClick: vi.fn(),
      }),
    ]);
    expect(host.querySelector('[data-action="plugin:demo:x"]')).toBeNull();
    expect(
      host.querySelector('[data-item-key="plugin:demo:status:x"]'),
    ).not.toBeNull();
  });
});

/**
 * 토스트 상태/갱신 핸들, 에디터 컨텍스트 메뉴, 선택 영역 읽기.
 *
 * 왜 mountNoteWindow를 통째로 띄우나: 이 셋은 전부 "실제 노트 창에서 무엇이 달라지는가"가
 * 계약이다(핵심 함수만 단위 테스트하면 배선이 빠져도 통과한다 — 이 저장소가 11번 겪은 모양).
 */
describe("mountNoteWindow — 토스트·컨텍스트 메뉴·선택 영역", () => {
  /** 최소 의존성(옵션 override 없음). */
  function deps() {
    return baseNoteDeps({
      loadNote: vi.fn(async () => ({
        content: "본문 내용",
        overrides: NO_OVERRIDES,
      })),
    });
  }

  /**
   * 에디터 영역에서 우클릭을 낸다(CodeMirror 루트에서 올려 보내 editorHost 리스너에 닿게).
   *
   * 왜 `#editor`를 셀렉터로 찾지 않나: jsdom의 id 셀렉터는 문서 전역 getElementById로
   * 최적화되어, 앞선 테스트가 남긴 같은 id를 먼저 잡고 "내 host 안에 없다"며 null을 준다.
   */
  function rightClickEditor(host: HTMLElement): void {
    host
      .querySelector<HTMLElement>(".cm-editor")!
      .dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
  }

  /** installPlugins ctx를 붙잡아 창-스코프 서비스를 직접 부를 수 있게 한다(noteId로 창 구분). */
  async function mountWithCtx(noteId = "n1"): Promise<{
    host: HTMLElement;
    ctx: Parameters<
      NonNullable<Parameters<typeof mountNoteWindow>[2]["installPlugins"]>
    >[0];
  }> {
    const host = document.createElement("div");
    document.body.append(host);
    let captured: unknown;
    await mountNoteWindow(host, noteId, {
      ...deps(),
      installPlugins: (ctx) => {
        captured = ctx;
      },
    });
    if (!captured) throw new Error("installPlugins ctx를 받지 못함");
    return {
      host,
      ctx: captured as Awaited<ReturnType<typeof mountWithCtx>>["ctx"],
    };
  }

  /** 열려 있는 컨텍스트 메뉴의 플러그인 항목 라벨들. */
  function pluginMenuLabels(host: HTMLElement): (string | null)[] {
    return [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].map((b) => b.textContent);
  }

  /** 열려 있는 메뉴에서 라벨로 항목을 눌러 실행한다(누르면 메뉴가 닫힌다). */
  function clickPluginMenuItem(host: HTMLElement, label: string): void {
    [...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item")]
      .find((b) => b.textContent === label)!
      .click();
  }

  /** 열려 있는 메뉴의 「전체 선택」을 눌러 선택을 만든다(다음 우클릭의 note.hasSelection용). */
  function selectAll(host: HTMLElement): void {
    clickPluginMenuItem(host, "전체 선택");
  }

  /** 열려 있는 메뉴를 Esc로 닫는다(openPopup이 document 캡처 단계에서 듣는다). */
  function closeMenu(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }

  /**
   * 메뉴 전용 항목 하나를 등록한 노트 창을 띄운다 — `menuWhen`/`needsSelectedText`를 그대로
   * 실어(`reconcileToolbarItems`가 그 필드를 컨텍스트 메뉴 항목으로 나른다) 우클릭 렌더를 검증한다.
   * `pluginId`를 커뮤니티 플러그인처럼 두므로(`builtin` 미지정) 메뉴에 실제로 나타난다.
   */
  async function mountWithCtxMenuItem(opts: {
    menuWhen?: { negated: boolean; key: string }[];
    needsSelectedText?: boolean;
  }): Promise<{ host: HTMLElement; onClick: ReturnType<typeof vi.fn> }> {
    const host = document.createElement("div");
    document.body.append(host);
    const onClick = vi.fn();
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        ctx.reconcileToolbarItems([
          {
            id: "menu:sel",
            pluginId: "case",
            label: "선택 처리",
            position: "top-left",
            menuOnly: true,
            ...(opts.menuWhen ? { menuWhen: opts.menuWhen } : {}),
            ...(opts.needsSelectedText ? { needsSelectedText: true } : {}),
            onClick,
          },
        ]);
      },
    });
    return { host, onClick };
  }

  /** 가드: 상태 클래스가 붙고, 받은 id로 제자리 갱신된다(새 토스트가 생기지 않는다). */
  it("updates a toast in place with the returned handle", async () => {
    const { host, ctx } = await mountWithCtx();
    const id = ctx.showToast({ title: "변환 중", style: "progress" });
    expect(id).not.toBeNull();
    let toasts = host.querySelectorAll(".note-toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].className).toContain("note-toast--progress");
    expect(toasts[0].querySelector(".note-toast-spinner")).not.toBeNull();

    expect(ctx.showToast({ id: id!, title: "완료", style: "success" })).toBe(
      id,
    );
    toasts = host.querySelectorAll(".note-toast");
    expect(toasts).toHaveLength(1); // 새로 생기지 않았다
    expect(toasts[0].className).toContain("note-toast--success");
    expect(toasts[0].textContent).toBe("완료");
  });

  /**
   * 가드(회귀): **부분 갱신은 안 준 필드를 유지한다.**
   *
   * 왜: 「진행 중 → 완료」 전환이 이 API가 존재하는 이유인데, 계약이 허용하는
   * `{ id, style: "success" }` 한 번에 제목이 빈 문자열로 덮이면 사용자에게는 글자가 하나도
   * 없는 빈 알림 알약이 뜬다(성공 경로라 진단에도 흔적이 없다).
   */
  it("keeps the untouched fields on a partial toast update", async () => {
    const { host, ctx } = await mountWithCtx();
    const id = ctx.showToast({
      title: "내보내는 중",
      message: "0%",
      style: "progress",
    })!;
    // 상태만 바꾼다 — 문구는 그대로여야 한다.
    expect(ctx.showToast({ id, style: "success" })).toBe(id);
    let el = host.querySelector<HTMLElement>(".note-toast")!;
    expect(el.className).toContain("note-toast--success");
    expect(el.querySelector(".note-toast-title")!.textContent).toBe(
      "내보내는 중",
    );
    expect(el.querySelector(".note-toast-message")!.textContent).toBe("0%");
    // 부가 메시지만 바꾼다 — 제목·상태는 그대로다.
    expect(ctx.showToast({ id, message: "80%" })).toBe(id);
    el = host.querySelector<HTMLElement>(".note-toast")!;
    expect(el.className).toContain("note-toast--success");
    expect(el.querySelector(".note-toast-title")!.textContent).toBe(
      "내보내는 중",
    );
    expect(el.querySelector(".note-toast-message")!.textContent).toBe("80%");
  });

  /**
   * 가드(회귀): 진행 토스트에 부분 갱신을 걸어도 **진행 상태가 유지된다**.
   *
   * 왜: style을 기본값(success)으로 접어 채우면 1.2초 자동 소멸 타이머가 걸려, 아직 끝나지
   * 않은 작업의 진행 표시가 중간에 증발한다.
   */
  it("does not turn a progress toast into a self-dismissing one on a partial update", async () => {
    vi.useFakeTimers();
    try {
      const { host, ctx } = await mountWithCtx();
      const id = ctx.showToast({ title: "변환 중", style: "progress" })!;
      ctx.showToast({ id, message: "3개 중 1개" });
      await vi.advanceTimersByTimeAsync(3000);
      const el = host.querySelector<HTMLElement>(".note-toast");
      expect(el).not.toBeNull();
      expect(el!.className).toContain("note-toast--progress");
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 모르는/이미 닫힌 id는 무음 무시가 아니라 null(호출부가 INVALID_ARGS로 바꾼다). */
  it("returns null for an unknown or already-dismissed toast id", async () => {
    const { ctx } = await mountWithCtx();
    expect(ctx.showToast({ id: "없는id", title: "x" })).toBeNull();
    const id = ctx.showToast({ title: "임시" })!;
    expect(ctx.showToast({ id, title: "", dismiss: true })).toBe(id);
    expect(ctx.showToast({ id, title: "다시" })).toBeNull();
    // id 없는 dismiss는 무엇을 닫을지 모르는 요청이라 실패다.
    expect(ctx.showToast({ title: "", dismiss: true })).toBeNull();
  });

  /**
   * 가드(회귀): 토스트 조회는 **플러그인별 네임스페이스**다 — 다른 플러그인이 순번을
   * 추측해 A의 진행·실패 토스트를 조용히 닫거나 문구를 바꿔칠 수 없다(owner는 호스트가
   * 검증한 플러그인 id로, 창 쪽이 페이로드에서 받는다).
   */
  it("isolates toast handles per plugin so another plugin cannot touch them", async () => {
    const { host, ctx } = await mountWithCtx();
    const id = ctx.showToast({ title: "진행", style: "progress" }, "plug-a")!;
    // B가 A의 id를 그대로 넣어도 B의 네임스페이스에서 해석돼 실패(null)다.
    expect(ctx.showToast({ id, dismiss: true }, "plug-b")).toBeNull();
    expect(ctx.showToast({ id, title: "바꿔치기" }, "plug-b")).toBeNull();
    expect(host.querySelector(".note-toast-title")!.textContent).toBe("진행");
    // 주인(A)은 같은 id로 갱신·닫기 모두 된다.
    expect(ctx.showToast({ id, style: "success" }, "plug-a")).toBe(id);
  });

  /**
   * 가드(회귀): 발급 id는 **창마다 다르다**(불투명 창 순번이 섞인다) — 토스트 순번만
   * 쓰면 창 A의 "t1"이 창 B에도 존재해, 폴백 라우팅으로 다른 창에 간 갱신이 그 창의 무관한
   * 토스트에 꽂혔다. 키가 다르면 그 갱신은 null(INVALID_ARGS)로 정직하게 실패한다.
   * 동시에 발급 id에 **노트 id가 포함되면 안 된다**: 발급 id는 `ui` 권한만으로 플러그인에게
   * 돌아가는 핸들이라, 노트 id(notes:read 게이트 뒤의 신원)를 실으면 권한 우회 유출이다.
   */
  it("issues window-unique toast ids so a cross-window update fails honestly", async () => {
    const a = await mountWithCtx("note-a");
    const b = await mountWithCtx("note-b");
    const idA = a.ctx.showToast({ title: "A" }, "plug")!;
    const idB = b.ctx.showToast({ title: "B" }, "plug")!;
    expect(idA).not.toBe(idB); // 같은 순번이어도 창마다 다른 id
    expect(idA).not.toContain("note-a"); // 노트 id(민감 데이터)는 실리지 않는다
    expect(idB).not.toContain("note-b");
    expect(b.ctx.showToast({ id: idA, title: "가로채기" }, "plug")).toBeNull();
    expect(b.host.querySelector(".note-toast-title")!.textContent).toBe("B");
  });

  /** 가드: 여러 토스트가 겹치지 않도록 위로 쌓인다. */
  it("stacks multiple live toasts instead of overlapping them", async () => {
    const { host, ctx } = await mountWithCtx();
    ctx.showToast({ title: "1", style: "progress" });
    ctx.showToast({ title: "2", style: "progress" });
    const bottoms = [...host.querySelectorAll<HTMLElement>(".note-toast")].map(
      (el) => el.style.bottom,
    );
    expect(new Set(bottoms).size).toBe(2);
  });

  /**
   * 가드: 우클릭이 호스트 렌더 메뉴를 띄우고, 편집(선택 유무로 게이트) → 삽입 → 앱 순서의
   * 그룹으로 구성된다(이슈 #19 — 툴바와 중복되던 메뉴를 의미 있는 그룹으로 재구성). 앱
   * 그룹은 새 메모 → 노트 목록·검색 → 설정 순이다(베타 피드백 2건). 이 창은 플러그인을
   * 하나도 설치하지 않았으므로 앱 그룹 아래 플러그인 구역은 비어 생략된다(#28 — 커뮤니티
   * 플러그인이 있으면 그 뒤에 다섯 번째 그룹으로 실린다. 아래 "lists community plugin..."
   * 테스트 참고).
   */
  it("opens a host-rendered context menu grouped as edit → insert → app", async () => {
    const { host } = await mountWithCtx();
    rightClickEditor(host);
    const items = [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ];
    expect(items.map((b) => b.textContent)).toEqual([
      "잘라내기",
      "복사",
      "붙여넣기",
      "전체 선택",
      "이미지 추가…",
      "유튜브 추가…",
      "링크 추가…",
      "새 메모",
      "노트 목록·검색 열기",
      "설정 열기",
    ]);
    // 마운트 직후 커서는 문서 끝의 빈 선택이라 잘라내기·복사는 비활성이다.
    expect(items[0].disabled).toBe(true);
    expect(items[1].disabled).toBe(true);
    expect(items[3].disabled).toBe(false); // 본문이 있으므로 전체 선택은 가능
    // 그룹 사이에만 구분선이 있다(edit|insert|app, 플러그인 그룹은 비어 생략) — 2개.
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(2);
  });

  /** 가드: capabilities.youtubeEmbed가 false면 "유튜브 추가" 항목이 메뉴에서 아예 빠진다. */
  it("hides the youtube insert item when capabilities.youtubeEmbed is false", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await mountNoteWindow(host, "n1", {
      ...deps(),
      capabilities: { ...ALL_CAPABILITIES, youtubeEmbed: false },
    });
    rightClickEditor(host);
    const labels = [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].map((b) => b.textContent);
    expect(labels).not.toContain("유튜브 추가…");
    expect(labels).toContain("이미지 추가…");
    expect(labels).toContain("링크 추가…");
  });

  /**
   * 가드: `applyYoutubeEmbedEnabled`가 창을 리로드하지 않고 그 항목을 켜고 끈다 — 설정
   * 창에서 그 번들을 토글했을 때 호스트 재빌드 완료 방송이 타는 제자리 조정 경로다
   * (`bootstrap/host-update-plan.ts`). 메뉴는 우클릭마다 새로 조립되므로 **다음 우클릭부터**
   * 반영된다.
   */
  it("toggles the youtube insert item in place via applyYoutubeEmbedEnabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const note = await mountNoteWindow(host, "n1", {
      ...deps(),
      capabilities: { ...ALL_CAPABILITIES, youtubeEmbed: false },
    });
    // 우클릭마다 메뉴가 새로 붙으므로(앞의 것은 바깥 클릭으로만 걷힌다) **마지막** 메뉴만 읽는다.
    const menuLabels = (): (string | null)[] => {
      rightClickEditor(host);
      const menus = host.querySelectorAll<HTMLElement>(".plugin-context-menu");
      return [
        ...menus[menus.length - 1].querySelectorAll<HTMLButtonElement>(
          ".plugin-context-menu-item",
        ),
      ].map((b) => b.textContent);
    };
    expect(menuLabels()).not.toContain("유튜브 추가…");

    note.applyYoutubeEmbedEnabled(true);
    expect(menuLabels()).toContain("유튜브 추가…");

    note.applyYoutubeEmbedEnabled(false);
    expect(menuLabels()).not.toContain("유튜브 추가…");
  });

  /**
   * 가드(#28): 커뮤니티(사이드로드) 플러그인의 툴바 버튼·menuOnly 명령은 컨텍스트 메뉴에도
   * **이름으로** 오른다 — 툴바는 글리프만 보이므로(이름은 tooltip) 메뉴가 이름으로 고르는
   * 유일한 자리다. 빌트인(번들) 플러그인 출처 항목 중 **툴바에 버튼으로 이미 떠 있는 것**만
   * 같은 자리에서 빠진다 — 그런 항목은 이름으로 또 나열하면 중복이라, 호스트가 `builtin`
   * 플래그로 걸러낸다(걸러지는 건 메뉴 자리뿐 — 빌트인 버튼도 툴바에는 그대로 뜬다). 반대로
   * 빌트인 `menuOnly` 항목(`commands.register`·`ui.addMenuItem` 출처라 애초에 툴바 버튼이
   * 없는 것)은 중복될 버튼이 없으므로 메뉴에 남아야 한다 — 아니면 그 항목은 단축키를 미리
   * 배정해 두지 않는 한 실행할 방법이 아예 사라진다.
   */
  it("lists community plugin toolbar buttons/commands by name in the context menu, but filters out builtin-origin items", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onButtonClick = vi.fn();
    const runCommand = vi.fn();
    const builtinOnClick = vi.fn();
    const builtinMenuOnlyOnClick = vi.fn();
    await mountNoteWindow(host, "n1", {
      ...deps(),
      installPlugins: (ctx) => {
        // 커뮤니티 툴바 버튼.
        ctx.reconcileToolbarItems([
          {
            id: "tpl",
            pluginId: "template",
            label: "📄",
            title: "템플릿 삽입",
            position: "top-right",
            onClick: onButtonClick,
          },
          // 커뮤니티 menuOnly 명령.
          {
            id: "cmd:upper",
            pluginId: "case",
            label: "선택 대문자로",
            title: "선택 대문자로",
            position: "top-left",
            menuOnly: true,
            onClick: runCommand,
          },
          // 빌트인 툴바 버튼 — 툴바에는 뜨지만 메뉴에는 오르지 않아야 한다(중복이므로).
          {
            id: "copy-ai-prompt",
            pluginId: "copy-ai-prompt",
            label: "📋",
            title: "AI 프롬프트 복사",
            position: "bottom-left",
            builtin: true,
            onClick: builtinOnClick,
          },
          // 빌트인 menuOnly 명령 — 대응하는 툴바 버튼이 없다(copy-ai-prompt의 "copy-now" 같은
          // 형태). 중복될 버튼이 없으므로 메뉴에 남아야 한다.
          {
            id: "cmd:copy-now",
            pluginId: "copy-ai-prompt",
            label: "문구 템플릿으로 복사",
            title: "문구 템플릿으로 복사",
            position: "top-left",
            menuOnly: true,
            builtin: true,
            onClick: builtinMenuOnlyOnClick,
          },
        ]);
      },
    });
    // 버튼은 여전히 툴바에 자리를 잡고 클릭도 된다(회귀 확인).
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:template:tpl"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    // 명령은 여전히 툴바에 자리를 잡지 않는다(그것이 「버튼 없는 명령」의 존재 이유).
    expect(
      host.querySelector('[data-action="plugin:case:cmd:upper"]'),
    ).toBeNull();
    // 빌트인 버튼은 툴바에는 그대로 뜬다 — 걸러지는 건 메뉴 자리뿐이다.
    const builtinBtn = host.querySelector<HTMLButtonElement>(
      '[data-action="plugin:copy-ai-prompt:copy-ai-prompt"]',
    );
    expect(builtinBtn).not.toBeNull();
    // 빌트인 menuOnly 명령도 툴바에는 자리를 잡지 않는다.
    expect(
      host.querySelector('[data-action="plugin:copy-ai-prompt:cmd:copy-now"]'),
    ).toBeNull();

    rightClickEditor(host);
    const labels = pluginMenuLabels(host);
    // 글리프("📄")가 아니라 이름으로 보인다 — 메뉴가 이름으로 고르는 자리인 이유.
    expect(labels).toContain("템플릿 삽입");
    expect(labels).toContain("선택 대문자로");
    // 빌트인 툴바 버튼 출처 항목은 이름으로도 나오지 않는다(중복 제거).
    expect(labels).not.toContain("AI 프롬프트 복사");
    // 빌트인이라도 menuOnly(대응 버튼 없음)면 메뉴에 남는다 — 유일한 이름 진입점이므로.
    expect(labels).toContain("문구 템플릿으로 복사");
    // 편집·삽입·앱·플러그인 4그룹이 채워진다 — 그 사이 구분선 3개.
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(3);

    clickPluginMenuItem(host, "선택 대문자로");
    await Promise.resolve();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(builtinOnClick).not.toHaveBeenCalled();
    expect(builtinMenuOnlyOnClick).not.toHaveBeenCalled();

    // 클릭이 메뉴를 닫으므로(clickPluginMenuItem 주석 참고) 다시 우클릭해 연다.
    rightClickEditor(host);
    clickPluginMenuItem(host, "문구 템플릿으로 복사");
    await Promise.resolve();
    expect(builtinMenuOnlyOnClick).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(핵심): 메뉴 전용 항목의 `menuWhen`이 **우클릭 시점의 라이브 선택**으로 판정된다 —
   * 선택이 없으면 메뉴에서 빠지고, 있으면 나타난다. 회색(disabled)이 아니라 **비표시**여야 한다
   * (VS Code editor/context의 when 절과 같은 결).
   */
  it("filters a menuWhen(note.hasSelection) item by the live selection", async () => {
    const { host } = await mountWithCtxMenuItem({
      menuWhen: [{ negated: false, key: "note.hasSelection" }],
    });

    // 선택이 없는 상태(마운트 직후 커서는 빈 선택) — 항목이 메뉴에 없다.
    rightClickEditor(host);
    expect(pluginMenuLabels(host)).not.toContain("선택 처리");
    closeMenu();

    // 전체 선택으로 선택을 만든 뒤 다시 우클릭 — 항목이 나타난다.
    rightClickEditor(host);
    selectAll(host);
    await Promise.resolve();
    rightClickEditor(host);
    expect(pluginMenuLabels(host)).toContain("선택 처리");
  });

  /**
   * 가드(payload 게이트): `needsSelectedText`면 실행 시 라이브 선택 텍스트가 onClick에
   * `{ selectedText }`로 넘어가고, 아니면 넘어가지 않는다(인자 없음).
   */
  it("passes selectedText to the handler only when needsSelectedText is set", async () => {
    const withGate = await mountWithCtxMenuItem({ needsSelectedText: true });
    rightClickEditor(withGate.host);
    selectAll(withGate.host);
    await Promise.resolve();
    rightClickEditor(withGate.host);
    clickPluginMenuItem(withGate.host, "선택 처리");
    await Promise.resolve();
    expect(withGate.onClick).toHaveBeenCalledWith({
      selectedText: "본문 내용",
    });

    const noGate = await mountWithCtxMenuItem({});
    rightClickEditor(noGate.host);
    selectAll(noGate.host);
    await Promise.resolve();
    rightClickEditor(noGate.host);
    clickPluginMenuItem(noGate.host, "선택 처리");
    await Promise.resolve();
    expect(noGate.onClick).toHaveBeenCalledWith(undefined);
  });

  /** 가드: 전체 선택 뒤 선택 영역이 실제로 읽히고, insertText(cursor)가 그 선택을 대체한다. */
  it("reads the live selection and replaces it via insertText(cursor)", async () => {
    const { host, ctx } = await mountWithCtx();
    rightClickEditor(host);
    const selectAll = [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].find((b) => b.textContent === "전체 선택")!;
    selectAll.click();
    await Promise.resolve();

    const sel = readNoteSelection();
    expect(sel).toEqual({
      text: "본문 내용",
      from: 0,
      to: "본문 내용".length,
      empty: false,
      ranges: 1,
      composing: false,
    });

    // 되쓰기 경로: 오프셋을 받는 API 없이 mode:"cursor"가 그 선택을 대체한다.
    ctx.insertText("바뀐 내용", "cursor");
    expect(ctx.getContent()).toBe("바뀐 내용");
    expect(readNoteSelection().empty).toBe(true);
  });

  /**
   * 메뉴 항목 라벨로 삽입 메뉴 항목을 눌러 URL 입력 다이얼로그를 연다.
   *
   * 클릭은 컨텍스트 메뉴의 close()→resolve()만 동기로 하고, runMenuAction은 그 프라미스의
   * .then 콜백(다음 마이크로태스크)에서 돈다 — 그래서 다이얼로그가 실제로 DOM에 붙기 전에
   * 한 틱을 기다려야 한다.
   */
  async function openInsertDialog(
    host: HTMLElement,
    label: string,
  ): Promise<void> {
    rightClickEditor(host);
    const item = [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].find((b) => b.textContent === label)!;
    item.click();
    await Promise.resolve();
  }

  /** 열려 있는 입력 다이얼로그에 URL을 채우고 확인을 누른다. */
  function confirmInsertDialog(host: HTMLElement, url: string): void {
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    input.value = url;
    input.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
  }

  /** "이미지 추가…" 다이얼로그의 URL·너비·높이 3칸 — DOM 순서가 곧 그 순서다. */
  function imageInsertInputs(host: HTMLElement): HTMLInputElement[] {
    return [
      ...host.querySelectorAll<HTMLInputElement>(
        ".confirm-overlay .plugin-popup-input",
      ),
    ];
  }

  /** 가드: "이미지 추가…"가 URL만 채운 채 확인해도(너비·높이 비움=auto) 기존과 같은 `![](url)`이 들어간다. */
  it("inserts plain image markdown at the cursor when width/height are left empty", async () => {
    const { host, ctx } = await mountWithCtx();
    await openInsertDialog(host, "이미지 추가…");
    const [url] = imageInsertInputs(host);
    expect(imageInsertInputs(host)).toHaveLength(3); // URL·너비·높이 3칸.
    url.value = "https://example.com/a.png";
    url.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();
    expect(ctx.getContent()).toBe("본문 내용![](https://example.com/a.png)");
    expect(host.querySelector(".confirm-overlay")).toBeNull(); // 다이얼로그가 닫혔다.
  });

  /** 가드: 너비·높이까지 채우면 크기 조정 레이어와 같은 alt 토큰(`w=…&h=…`)이 함께 삽입된다. */
  it("inserts image markdown with size tokens when width/height are filled in", async () => {
    const { host, ctx } = await mountWithCtx();
    await openInsertDialog(host, "이미지 추가…");
    const [url, width, height] = imageInsertInputs(host);
    url.value = "https://example.com/a.png";
    url.dispatchEvent(new Event("input"));
    width.value = "300";
    width.dispatchEvent(new Event("input"));
    height.value = "200";
    height.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();
    expect(ctx.getContent()).toBe(
      "본문 내용![w=300&h=200](https://example.com/a.png)",
    );
  });

  /** 가드: URL이 유효해도 너비·높이가 범위 밖이면 확인 버튼이 막힌다(크기 조정 레이어와 같은 검증). */
  it("blocks confirm when the url is valid but width/height fail validation", async () => {
    const { host, ctx } = await mountWithCtx();
    await openInsertDialog(host, "이미지 추가…");
    const [url, width] = imageInsertInputs(host);
    url.value = "https://example.com/a.png";
    url.dispatchEvent(new Event("input"));
    width.value = "99999"; // 상한(4096) 초과.
    width.dispatchEvent(new Event("input"));
    const ok = host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!;
    expect(ok.disabled).toBe(true);
    expect(ctx.getContent()).toBe("본문 내용"); // 아무것도 삽입되지 않았다.
  });

  /** 가드: "유튜브 추가…"가 youtube-embed 플러그인이 인식하는 코드펜스를 삽입한다. */
  it("inserts a ```youtube fence at the cursor via the insert dialog", async () => {
    const { host, ctx } = await mountWithCtx();
    await openInsertDialog(host, "유튜브 추가…");
    confirmInsertDialog(host, "https://youtu.be/abc123");
    await Promise.resolve();
    expect(ctx.getContent()).toBe(
      "본문 내용```youtube\nhttps://youtu.be/abc123\n```",
    );
  });

  /** 가드: "링크 추가…"는 우클릭 시점의 선택 텍스트를 링크 텍스트로 써서 그 선택을 대체한다. */
  it("inserts link markdown using the selected text and replaces the selection", async () => {
    const { host, ctx } = await mountWithCtx();
    // 전체 선택으로 선택 텍스트("본문 내용")를 만든다.
    rightClickEditor(host);
    [...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item")]
      .find((b) => b.textContent === "전체 선택")!
      .click();
    await Promise.resolve();

    await openInsertDialog(host, "링크 추가…");
    confirmInsertDialog(host, "https://example.com");
    await Promise.resolve();
    expect(ctx.getContent()).toBe("[본문 내용](https://example.com)");
  });

  /** 가드: 빈 값/무효 URL로는 확인 버튼이 막혀 아무것도 삽입되지 않는다(다이얼로그의 validate). */
  it("does not insert anything while the url fails validation", async () => {
    const { host, ctx } = await mountWithCtx();
    await openInsertDialog(host, "링크 추가…");
    const ok = host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!;
    expect(ok.disabled).toBe(true); // 빈 입력.
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    input.value = "not a url";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(true);
    expect(ctx.getContent()).toBe("본문 내용"); // 아무것도 삽입되지 않았다.
  });

  // ── 이미지 크기 조정(렌더된 이미지 우클릭) ────────────────────────────────
  //
  // 왜 실제 에디터로 도나: 이 기능의 계약은 "**렌더된** `<img>`를 우클릭했을 때"다. 위젯이
  // 실제로 그려지고(라이브 프리뷰), 그 DOM에서 문서 위치가 되짚어지고(posAtDOM→syntax tree),
  // 그 위치가 다시 문서로 되쓰이는 세 단계가 전부 맞아야 동작한다 — 순수 함수만 봐서는
  // 어느 한 단계가 빠져도 통과한다.

  /**
   * 본문에 이미지가 든 노트 창을 띄운다(프리뷰가 `<img>`를 그리도록 경로 해석기를 준다).
   *
   * 본문 확인은 플러그인 ctx의 `getContent()`로 한다 — 저장 디바운스를 기다리지 않고 **지금
   * 에디터 버퍼**를 읽는 유일한 경로다(다른 컨텍스트 메뉴 테스트가 쓰는 것과 같은 손잡이).
   */
  async function mountWithImage(content: string): Promise<{
    host: HTMLElement;
    read: () => string;
  }> {
    const host = document.createElement("div");
    document.body.append(host);
    const base = deps();
    let captured: { getContent: () => string } | null = null;
    await mountNoteWindow(host, "n1", {
      ...base,
      loadNote: vi.fn(async () => ({ ...(await base.loadNote()), content })),
      resolveImageSrc: (path: string) => `asset://${path}`,
      installPlugins: (ctx) => {
        captured = ctx;
      },
    });
    const ctx = captured as { getContent: () => string } | null;
    if (!ctx) throw new Error("installPlugins ctx를 받지 못함");
    return { host, read: () => ctx.getContent() };
  }

  /** 렌더된 이미지 위젯에서 우클릭을 낸다(index로 한 줄에 여럿인 경우를 고른다). */
  function rightClickImage(host: HTMLElement, index = 0): void {
    const img = host.querySelectorAll<HTMLElement>(".cm-md-image")[index];
    expect(img).toBeDefined(); // 위젯이 안 그려졌으면 이 테스트는 의미가 없다.
    img.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  }

  /** 열려 있는 컨텍스트 메뉴의 항목 라벨 전부. */
  function menuLabels(host: HTMLElement): (string | null)[] {
    return [
      ...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item"),
    ].map((b) => b.textContent);
  }

  /** 컨텍스트 메뉴 항목을 라벨로 누르고 후속 동작(다이얼로그 열기 등)까지 한 틱 기다린다. */
  async function clickMenuItem(
    host: HTMLElement,
    label: string,
  ): Promise<void> {
    [...host.querySelectorAll<HTMLButtonElement>(".plugin-context-menu-item")]
      .find((b) => b.textContent === label)!
      .click();
    await Promise.resolve();
  }

  /** 크기 조정 다이얼로그의 두 칸(너비·높이) — DOM 순서가 곧 그 순서다. */
  function sizeInputs(host: HTMLElement): HTMLInputElement[] {
    return [
      ...host.querySelectorAll<HTMLInputElement>(
        ".confirm-overlay .plugin-popup-input",
      ),
    ];
  }

  /** 두 칸을 채운다(빈 문자열이면 그 축은 auto). */
  function fillSize(host: HTMLElement, width: string, height: string): void {
    const [w, h] = sizeInputs(host);
    w.value = width;
    w.dispatchEvent(new Event("input"));
    h.value = height;
    h.dispatchEvent(new Event("input"));
  }

  /** 렌더된 첫 이미지의 인라인 크기 스타일(재렌더 확인용). */
  function renderedSize(host: HTMLElement): { width: string; height: string } {
    const img = host.querySelector<HTMLImageElement>(".cm-md-image")!;
    return { width: img.style.width, height: img.style.height };
  }

  /**
   * 가드(핵심): 렌더된 이미지를 우클릭하면 이미지 그룹이 **맨 위**에 붙고, 기존 편집·삽입·앱
   * 그룹은 그대로 남는다. 크기 토큰이 없으면 「원본 크기로」는 뜨지 않는다(눌러도 아무 일이
   * 없는 항목을 만들지 않는다).
   */
  it("puts an image group on top when the right-click target is a rendered image", async () => {
    const { host } = await mountWithImage("머리말\n\n![](a.png)\n\n꼬리말");
    rightClickImage(host);
    expect(menuLabels(host)).toEqual([
      "이미지 크기 조정…",
      "잘라내기",
      "복사",
      "붙여넣기",
      "전체 선택",
      "이미지 추가…",
      "유튜브 추가…",
      "링크 추가…",
      "새 메모",
      "노트 목록·검색 열기",
      "설정 열기",
    ]);
    // 그룹이 하나 늘었으니 구분선도 하나 는다(image|edit|insert|app).
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(3);
  });

  /** 가드: 이미 크기 토큰이 있으면 「원본 크기로」가 함께 뜬다. */
  it("offers the reset item only when the alt already carries a size token", async () => {
    const { host } = await mountWithImage(
      "머리말\n\n![w=300](a.png)\n\n꼬리말",
    );
    rightClickImage(host);
    expect(menuLabels(host).slice(0, 2)).toEqual([
      "이미지 크기 조정…",
      "원본 크기로",
    ]);
  });

  /**
   * 가드(핵심): 같은 노트라도 **일반 텍스트**에서 우클릭하면 이미지 그룹이 통째로 빠진다 —
   * 빈 그룹이라 구분선도 늘지 않는다(메뉴가 예전 모습 그대로다).
   */
  it("leaves the image group out when the right-click target is plain text", async () => {
    const { host } = await mountWithImage(
      "머리말\n\n![w=300](a.png)\n\n꼬리말",
    );
    rightClickEditor(host);
    const labels = menuLabels(host);
    expect(labels).not.toContain("이미지 크기 조정…");
    expect(labels).not.toContain("원본 크기로");
    expect(labels[0]).toBe("잘라내기");
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(2);
  });

  /**
   * 가드(핵심): 다이얼로그가 현재 토큰으로 프리필되고, 적용하면 **alt만** 새 토큰으로 바뀐다
   * (URL·주변 본문은 한 글자도 안 바뀐다). 그리고 라이브 프리뷰가 곧바로 새 크기로 다시 그린다.
   */
  it("prefills the current size and rewrites only the alt on apply", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![로고 w=300](a.png)\n\n꼬리말",
    );
    expect(renderedSize(host).width).toBe("300px");

    rightClickImage(host);
    await clickMenuItem(host, "이미지 크기 조정…");
    expect(sizeInputs(host).map((i) => i.value)).toEqual(["300", ""]); // 폭만 지정돼 있었다.

    fillSize(host, "500", "400");
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();

    expect(read()).toBe("머리말\n\n![로고 w=500&h=400](a.png)\n\n꼬리말");
    expect(host.querySelector(".confirm-overlay")).toBeNull(); // 다이얼로그가 닫혔다.
    // 프리뷰가 새 크기로 다시 그려졌다(폭 고정 + 비율은 aspect-ratio가 맡는다 — live-preview.ts).
    expect(renderedSize(host).width).toBe("500px");
  });

  /** 가드: 한 축을 비우면 그 축은 auto — 토큰도 남은 축만 남는다. */
  it("writes only the axis that was filled in", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![로고 w=300](a.png)\n\n꼬리말",
    );
    rightClickImage(host);
    await clickMenuItem(host, "이미지 크기 조정…");
    fillSize(host, "", "250");
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();
    expect(read()).toBe("머리말\n\n![로고 h=250](a.png)\n\n꼬리말");
    expect(renderedSize(host)).toEqual({ width: "", height: "250px" });
  });

  /** 가드: 「원본 크기로」는 토큰만 지우고 alt 설명은 남긴다(= 크기 지정 해제). */
  it("strips the size tokens via the reset item while keeping the alt text", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![로고 w=300&h=200](a.png)\n\n꼬리말",
    );
    rightClickImage(host);
    await clickMenuItem(host, "원본 크기로");
    expect(read()).toBe("머리말\n\n![로고](a.png)\n\n꼬리말");
    expect(renderedSize(host)).toEqual({ width: "", height: "" });
  });

  /**
   * 가드(핵심): 범위 밖·비수치 입력은 확인 버튼이 막아 문서에 닿지 않는다. 반대로 **빈 값**은
   * 뜻이 있는 입력(auto)이라 통과한다.
   */
  it("blocks invalid sizes at the dialog but accepts empty fields", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![](a.png)\n\n꼬리말",
    );
    rightClickImage(host);
    await clickMenuItem(host, "이미지 크기 조정…");
    const ok = host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!;
    expect(ok.disabled).toBe(false); // 둘 다 빈 값 = auto/auto.

    fillSize(host, "5", "");
    expect(ok.disabled).toBe(true); // 하한(16) 미만.
    fillSize(host, "300", "99999");
    expect(ok.disabled).toBe(true); // 상한(4096) 초과.
    fillSize(host, "300", "abc");
    expect(ok.disabled).toBe(true);
    fillSize(host, "300", "");
    expect(ok.disabled).toBe(false);
    expect(read()).toBe("머리말\n\n![](a.png)\n\n꼬리말"); // 아직 아무것도 안 바뀌었다.
  });

  /** 가드: Esc로 닫으면 문서는 그대로다(취소가 되쓰기로 새지 않는다). */
  it("does not touch the document when the dialog is cancelled", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![w=300](a.png)\n\n꼬리말",
    );
    rightClickImage(host);
    await clickMenuItem(host, "이미지 크기 조정…");
    fillSize(host, "500", "");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await Promise.resolve();
    expect(read()).toBe("머리말\n\n![w=300](a.png)\n\n꼬리말");
  });

  /**
   * 가드(핵심): 한 줄에 이미지가 여럿이어도 **우클릭한 그 이미지만** 바뀐다 — 위치 해석이
   * 클릭 대상 DOM에서 시작하기 때문이다(앞 이미지에 토큰이 새지 않는다).
   */
  it("resizes only the image that was right-clicked", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n앞 ![가](x.png) ![나](y.png) 뒤\n\n꼬리말",
    );
    expect(host.querySelectorAll(".cm-md-image")).toHaveLength(2);
    rightClickImage(host, 1);
    await clickMenuItem(host, "이미지 크기 조정…");
    fillSize(host, "320", "");
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();
    expect(read()).toBe(
      "머리말\n\n앞 ![가](x.png) ![나 w=320](y.png) 뒤\n\n꼬리말",
    );
  });

  /**
   * 가드: 적용 뒤에도 커서는 원래 자리(문서 끝)에 그대로 남는다 — 변경분만큼 매핑돼 따라
   * 움직이므로 이미지 줄로 끌려 들어가지 않는다(끌려가면 그 줄이 원문으로 펼쳐져 버린다).
   */
  it("keeps the caret where it was so the preview stays rendered", async () => {
    const { host, read } = await mountWithImage(
      "머리말\n\n![](a.png)\n\n꼬리말",
    );
    expect(readNoteSelection()).toMatchObject({ empty: true });
    const before = readNoteSelection().from;
    rightClickImage(host);
    await clickMenuItem(host, "이미지 크기 조정…");
    fillSize(host, "300", "");
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await Promise.resolve();
    const after = readNoteSelection();
    expect(after.empty).toBe(true);
    expect(after.from).toBe(before + "w=300".length); // 삽입분만큼만 밀렸다(= 문서 끝 유지).
    expect(after.from).toBe(read().length);
    expect(host.querySelector<HTMLImageElement>(".cm-md-image")).not.toBeNull(); // 여전히 렌더 상태.
  });

  /**
   * "설정 열기"·"새 메모"·"노트 목록·검색 열기" 세 메뉴 항목은 전부 같은 패턴이다 — 주입된
   * deps 브리지를 부르고(배선원은 각각 노트 툴바 버튼·패널 "+" 버튼·패널 진입점과 같다), 거부되면
   * 창을 깨뜨리지 않고 실패 토스트만 띄우며, 구버전 deps(브리지 미제공)에도 크래시하지 않는다.
   * 셋 다 같은 계약이라 표만 다르게 해 병합한다(케이스 이름은 각 브리지별로 남는다).
   */
  const MENU_BRIDGE_CASES = [
    {
      dep: "openSettings",
      label: "설정 열기",
      failTitle: "설정 창을 열지 못했어요",
    },
    {
      dep: "createNote",
      label: "새 메모",
      failTitle: "새 메모를 만들지 못했어요",
    },
    {
      dep: "openPanel",
      label: "노트 목록·검색 열기",
      failTitle: "노트 목록·검색을 열지 못했어요",
    },
  ] as const;

  /** 가드: 메뉴 항목을 누르면 주입된 브리지 deps가 불린다. */
  it.each(MENU_BRIDGE_CASES)(
    "calls deps.$dep when its menu item is clicked",
    async ({ dep, label }) => {
      const host = document.createElement("div");
      document.body.append(host);
      const fn = vi.fn(async () => {});
      await mountNoteWindow(host, "n1", { ...deps(), [dep]: fn });
      rightClickEditor(host);
      await clickMenuItem(host, label);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  /** 가드: 브리지 deps가 거부되면 창을 깨뜨리지 않고 실패 토스트만 띄운다. */
  it.each(MENU_BRIDGE_CASES)(
    "shows a failure toast when deps.$dep rejects",
    async ({ dep, label, failTitle }) => {
      const host = document.createElement("div");
      document.body.append(host);
      const fn = vi.fn(async () => {
        throw new Error("no runtime");
      });
      await mountNoteWindow(host, "n1", { ...deps(), [dep]: fn });
      rightClickEditor(host);
      await clickMenuItem(host, label);
      await vi.waitFor(() => {
        expect(host.querySelector(".note-toast")).not.toBeNull();
      });
      expect(host.querySelector(".note-toast")!.className).toContain(
        "note-toast--failure",
      );
      expect(host.querySelector(".note-toast-title")!.textContent).toBe(
        failTitle,
      );
    },
  );

  /** 가드: 브리지 deps가 없어도(구버전 deps) 클릭 시 크래시하지 않는다. */
  it.each(MENU_BRIDGE_CASES)(
    "does not crash when deps.$dep is not provided",
    async ({ label }) => {
      const { host } = await mountWithCtx();
      rightClickEditor(host);
      const item = [
        ...host.querySelectorAll<HTMLButtonElement>(
          ".plugin-context-menu-item",
        ),
      ].find((b) => b.textContent === label)!;
      expect(() => item.click()).not.toThrow();
    },
  );
});

describe("isTextEntryElement", () => {
  /** 가드: null·body·버튼·li 등 비-입력 요소는 false. */
  it("returns false for null and non-text-entry elements", () => {
    expect(isTextEntryElement(null)).toBe(false);
    expect(isTextEntryElement(document.body)).toBe(false);
    expect(isTextEntryElement(document.createElement("button"))).toBe(false);
    expect(isTextEntryElement(document.createElement("li"))).toBe(false);
    expect(isTextEntryElement(document.createElement("div"))).toBe(false);
  });

  /** 가드: input은 readOnly가 아닐 때만 true(type은 따지지 않는다 — 판정 단순화). */
  it("returns true for a non-readonly input, false when readOnly", () => {
    const input = document.createElement("input");
    expect(isTextEntryElement(input)).toBe(true);
    input.readOnly = true;
    expect(isTextEntryElement(input)).toBe(false);
  });

  /** 가드: textarea·select는 항상 true. */
  it("returns true for textarea and select", () => {
    expect(isTextEntryElement(document.createElement("textarea"))).toBe(true);
    expect(isTextEntryElement(document.createElement("select"))).toBe(true);
  });

  /**
   * 가드: contenteditable 요소는 true — CodeMirror `.cm-content`가 이 경로로 걸린다.
   * jsdom은 `isContentEditable` 게터를 구현하지 않아(항상 undefined) `contenteditable`
   * 속성 폴백을 함께 검증한다(구현 주석 참고).
   */
  it("returns true for a contenteditable element", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isTextEntryElement(div)).toBe(true);
  });
});

describe("mountNoteWindow — 창 포커스 → 에디터 DOM 포커스", () => {
  /** 최소 의존성(옵션 override 없음). */
  function deps() {
    return baseNoteDeps({
      loadNote: vi.fn(async () => ({
        content: "본문",
        overrides: NO_OVERRIDES,
      })),
    });
  }

  // 이전(다른 describe 블록) 테스트가 남긴 host가 document.body에 그대로 쌓여 있을 수 있고,
  // 그 host의 에디터가 이 파일 전역 document의 activeElement를 여전히 쥐고 있을 수 있다(마운트가
  // 포커스를 주므로) — 남은 요소를 지워 매 테스트를 "아무도 포커스를 안 잡은" 상태에서 시작하게
  // 한다(요소가 DOM에서 빠지면 jsdom이 activeElement를 body로 되돌린다).
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** 가드(핵심): 마운트 직후 activeElement가 에디터 contentDOM으로 옮겨져 바로 타이핑할 수 있다. */
  it("focuses the editor content DOM right after mount", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await mountNoteWindow(host, "n1", { ...deps() });
    expect(document.activeElement).toBe(host.querySelector(".cm-content"));
  });

  /**
   * 가드(핵심): 창이 다시 OS 포커스를 받으면(`window` `focus`) activeElement가 아무도 안 잡은
   * 상태(body)일 때 에디터로 되돌아간다 — summon_note/새 창이 맨 앞에 와도 바로 타이핑되게 하는
   * 핵심 계약.
   */
  it("returns focus to the editor on window focus when nothing else holds it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await mountNoteWindow(host, "n1", { ...deps() });
    // 마운트가 이미 에디터에 포커스를 줬으니, 우선 body로 되돌려 "아무도 안 잡은" 상태를 재현한다.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    window.dispatchEvent(new FocusEvent("focus"));

    expect(document.activeElement).toBe(host.querySelector(".cm-content"));
  });

  /**
   * 가드(핵심): 검색창·제목 입력 등 다른 텍스트 입력 요소가 포커스 중이면 `window` `focus`가
   * 와도 에디터가 그 포커스를 빼앗지 않는다.
   */
  it("does not steal focus from another text-entry element on window focus", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await mountNoteWindow(host, "n1", { ...deps() });

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    window.dispatchEvent(new FocusEvent("focus"));

    expect(document.activeElement).toBe(input);
  });
});

describe("창 단위 실패 격리 — 오류 오버레이(이슈 #24)", () => {
  /** 오버레이가 다음 테스트로 새지 않게 DOM을 비운다. */
  afterEach(() => {
    document.getElementById("memo-note-error")?.remove();
    document.body.replaceChildren();
  });

  /** 오버레이의 두 버튼을 액션 이름으로 찾는다(구현 상세인 클래스명에 묶지 않는다). */
  const buttons = () => ({
    retry: document.querySelector<HTMLButtonElement>(
      '[data-action="note-error-retry"]',
    ),
    close: document.querySelector<HTMLButtonElement>(
      '[data-action="note-error-close"]',
    ),
  });

  /**
   * 가드(핵심): 처리되지 않은 프라미스 거부가 하얀 창 대신 오버레이가 된다.
   *
   * 마운트 실패는 거부로 온다 — 부트스트랩이 `void bootstrapNote(...)`로 프라미스를 버리기
   * 때문에, 이 핸들러가 없으면 콘솔에만 남고 화면에는 아무것도 그려지지 않는다.
   */
  it("turns an unhandled rejection into an overlay with both escape hatches", () => {
    const uninstall = installNoteErrorOverlay(window);
    try {
      const event = new Event("unhandledrejection") as Event & {
        reason?: unknown;
      };
      event.reason = new Error("백엔드가 응답하지 않음");
      window.dispatchEvent(event);

      const overlay = document.getElementById("memo-note-error");
      expect(overlay).not.toBeNull();
      // 사유가 사용자에게 그대로 노출된다(무슨 일인지 알 수 있어야 한다).
      expect(overlay?.textContent).toContain("백엔드가 응답하지 않음");
      // 탈출구 둘 — 이 창만 다시 시도하거나, 이 창만 닫는다.
      expect(buttons().retry).not.toBeNull();
      expect(buttons().close).not.toBeNull();
    } finally {
      uninstall();
    }
  });

  /** 가드: 첫 오류가 부르는 연쇄 오류로 오버레이가 겹쳐 쌓이지 않는다(첫 원인이 가려지면 안 된다). */
  it("shows at most one overlay per window", () => {
    const uninstall = installNoteErrorOverlay(window);
    try {
      showNoteErrorOverlay("첫 번째 원인", window);
      showNoteErrorOverlay("두 번째 원인", window);
      expect(document.querySelectorAll("#memo-note-error")).toHaveLength(1);
      expect(document.getElementById("memo-note-error")?.textContent).toContain(
        "첫 번째 원인",
      );
    } finally {
      uninstall();
    }
  });

  /** 가드: 해제하면 더 이상 오버레이를 만들지 않는다(전역 리스너가 남지 않는다). */
  it("stops reacting after uninstall", () => {
    installNoteErrorOverlay(window)();
    const event = new Event("unhandledrejection") as Event & {
      reason?: unknown;
    };
    event.reason = new Error("해제 후");
    window.dispatchEvent(event);
    expect(document.getElementById("memo-note-error")).toBeNull();
  });

  /**
   * 재현(핵심 — 사용자 실사용 오탐): 진짜 스크립트 오류는 여전히 오버레이를 띄운다.
   * 리사이즈 오탐을 막는 필터가 진짜 크래시까지 함께 삼키지 않는지 확인하는 가드다.
   */
  it("still shows the overlay for a genuine script error", () => {
    const uninstall = installNoteErrorOverlay(window);
    try {
      const event = new ErrorEvent("error", {
        error: new Error("널 참조"),
        message: "널 참조",
      });
      window.dispatchEvent(event);
      const overlay = document.getElementById("memo-note-error");
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toContain("널 참조");
    } finally {
      uninstall();
    }
  });

  /**
   * 재현(핵심 — 사용자 실사용 오탐): 노트 창을 리사이즈만 해도 브라우저가 발생시키는
   * "ResizeObserver loop completed with undelivered notifications." 류의 무해한 경고가
   * `window` `error` 이벤트로 온다(스크립트 크래시가 아니다). 이 필터가 없으면 리사이즈
   * 한 번으로 노트 창이 죽은 것처럼 보이는 전체화면 오버레이가 뜬다 — 사용자가 보고한
   * 증상 그대로다.
   */
  it("ignores the benign ResizeObserver loop notice instead of showing the overlay", () => {
    const uninstall = installNoteErrorOverlay(window);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const event = new ErrorEvent("error", {
        message:
          "ResizeObserver loop completed with undelivered notifications.",
      });
      window.dispatchEvent(event);
      expect(document.getElementById("memo-note-error")).toBeNull();
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      uninstall();
      debugSpy.mockRestore();
    }
  });

  /** 가드: 다른 변형 문구("ResizeObserver loop limit exceeded")도 같이 걸러진다. */
  it("ignores the ResizeObserver loop limit variant too", () => {
    const uninstall = installNoteErrorOverlay(window);
    try {
      const event = new ErrorEvent("error", {
        message: "ResizeObserver loop limit exceeded",
      });
      window.dispatchEvent(event);
      expect(document.getElementById("memo-note-error")).toBeNull();
    } finally {
      uninstall();
    }
  });

  /**
   * 가드(핵심): 백엔드가 응답하지 않아도 마운트가 **영원히 매달리지 않는다** — 상한을 넘기면
   * 거부한다. 그 거부가 전역 핸들러를 타고 오버레이가 되는 것이 #24 격리의 완성이다.
   */
  it("rejects instead of hanging forever when loadNote never settles", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pending = new Promise<never>(() => {}); // 영원히 해결되지 않는다.
    await expect(
      mountNoteWindow(
        host,
        "n1",
        baseNoteDeps({ loadNote: () => pending, loadTimeoutMs: 5 }),
      ),
    ).rejects.toThrow();
  });
});

/**
 * 설정 창이 "국소 반영 가능한 키만" 바꿨을 때 창을 리로드하지 않고 제자리에서 반영하는 두
 * 핸들(`settings-changed-local` 경로의 말단). 예전에는 색 하나·글자 크기 하나를 바꿔도 열린
 * 노트 창이 전부 `location.reload()`해서 화면이 깜빡이고 스크롤·선택·IME 조합이 초기화됐다.
 */
describe("mountNoteWindow — 국소 설정 반영(리로드 없이)", () => {
  /** 이 스위트가 `documentElement`에 남긴 인라인 토큰 변수를 다음 테스트로 흘리지 않는다. */
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  /**
   * 가드(핵심): applyThemeOverrides가 CSS 변수를 새 색으로 다시 쓰고, **사라진 오버라이드의
   * 변수는 지운다**. 지우지 않으면 방금 되돌린 사용자 색이 그대로 남아 "초기화가 안 되는"
   * 것처럼 보인다(테마가 선언하지 않은 토큰은 applyTheme이 덮어쓸 수 없다).
   */
  it("applyThemeOverrides() rewrites the CSS variables and clears removed ones", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      theme: { tokens: { accent: "#010101" } },
      themeOverrides: { accent: "#ff0000", card: "#123456" },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--memo-accent")).toBe("#ff0000");
    expect(root.getPropertyValue("--memo-card-light")).toBe("#123456");

    handle.applyThemeOverrides({ accent: "#00ff00" });
    expect(root.getPropertyValue("--memo-accent")).toBe("#00ff00");
    expect(root.getPropertyValue("--memo-card-light")).toBe("");
  });

  /** 가드: 오버라이드를 전부 비우면 테마 원본 값으로 돌아간다(리로드 없이). */
  it("applyThemeOverrides(null) falls back to the theme's own palette", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      theme: { tokens: { accent: "#010101" } },
      themeOverrides: { accent: "#ff0000" },
    });
    handle.applyThemeOverrides(null);
    expect(
      document.documentElement.style.getPropertyValue("--memo-accent"),
    ).toBe("#010101");
  });

  /**
   * 가드(핵심): applyBaseFontPx가 전역 기본만 앞으로 감고 **이 메모의 델타는 유지한다** —
   * 실효 크기는 언제나 "전역 기본 + 델타"다(14+10% → 15px, 20+10% → 21px).
   */
  it("applyBaseFontPx() re-applies the editor font while preserving the note delta", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const handle = await mountNoteWindow(host, "n1", {
        ...baseNoteDeps(),
        loadNote: vi.fn(async () => ({
          content: "",
          overrides: { ...NO_OVERRIDES, font_delta: 10 },
        })),
        baseFontPx: 14,
      });
      const editorEl = host.querySelector(".cm-editor") as HTMLElement;
      expect(getComputedStyle(editorEl).fontSize).toBe("15px");

      handle.applyBaseFontPx(20);
      expect(getComputedStyle(editorEl).fontSize).toBe("21px");
    } finally {
      host.remove();
    }
  });
});

/**
 * 재빌드 완료 방송의 **제자리 조정**이 부르는 핸들들(`bootstrap/host-update-plan.ts`의
 * `ReconcileTarget` 말단). 셋 다 예전에는 창 전체 리로드로만 반영되던 표면이라, 여기서
 * 못박는 것은 하나다 — 리로드 없이도 화면이 **마운트했을 때와 같은 상태**가 되는가.
 */
describe("mountNoteWindow — 재빌드 후 제자리 조정", () => {
  /**
   * "폰트 지정 없음"(=시스템 기본)의 관측값. jsdom은 지정되지 않은 font-family의 계산값으로
   * CSS 초기값 그대로 `"depends on user agent"`를 돌려준다 — 빈 문자열이 아니다.
   */
  const NO_FONT_FAMILY = "depends on user agent";

  /** 이 스위트가 `documentElement`에 남긴 인라인 토큰 변수를 다음 테스트로 흘리지 않는다. */
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  /**
   * 가드(핵심): applyTheme가 **활성 팔레트 자체**를 갈아 끼우고 그 위에 오버라이드를 다시
   * 얹는다. 표면 토큰(라이트/다크 두 값)도 마운트와 **같은 변수 이름**으로 나가야 한다 —
   * 여기서 갈리면 다크 모드에서만 옛 색이 남는, 눈에 잘 안 띄는 실패가 된다.
   */
  it("applyTheme() swaps the active palette and re-lays the overrides on top", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      theme: {
        tokens: {
          accent: "#010101",
          surface: "#f0f0f0",
          "surface-dark": "#101010",
        },
      },
      themeOverrides: { accent: "#ff0000" },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--memo-accent")).toBe("#ff0000");
    expect(root.getPropertyValue("--memo-surface-light")).toBe("#f0f0f0");
    expect(root.getPropertyValue("--memo-surface-dark")).toBe("#101010");

    handle.applyTheme(
      {
        tokens: {
          accent: "#020202",
          surface: "#fafafa",
          "surface-dark": "#202020",
        },
      },
      { surface: "#123456" },
    );
    // 새 테마의 값이 들어오고(다크 포함), 사라진 오버라이드(accent)는 **새 테마 원본**으로
    // 되돌아간다(옛 테마 값도 옛 오버라이드도 아니다).
    expect(root.getPropertyValue("--memo-accent")).toBe("#020202");
    expect(root.getPropertyValue("--memo-surface-light")).toBe("#123456");
    expect(root.getPropertyValue("--memo-surface-dark")).toBe("#202020");
  });

  /**
   * 가드(핵심): 새 테마가 **선언하지 않은** 토큰의 인라인 변수는 지운다 → CSS 폴백이 되살아난다.
   * 안 지우면 테마를 바꿔도 옛 테마의 색이 그대로 남는다(리로드였다면 절대 안 났을 실패).
   */
  it("applyTheme() clears tokens the new theme does not declare", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      theme: { tokens: { accent: "#010101", card: "#020202" } },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--memo-accent")).toBe("#010101");

    handle.applyTheme({ tokens: {} }, null);
    expect(root.getPropertyValue("--memo-accent")).toBe("");
    expect(root.getPropertyValue("--memo-card-light")).toBe("");
  });

  /** 가드: applyFontFamily가 에디터 폰트 패밀리만 제자리에서 갈아 끼운다(리로드 없이). */
  it("applyFontFamily() swaps the editor font family in place", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const handle = await mountNoteWindow(host, "n1", {
        ...baseNoteDeps(),
        font: { families: [{ label: "Serif", stack: "Georgia, serif" }] },
        fontFamily: "Georgia, serif",
      });
      const editorEl = host.querySelector(".cm-editor") as HTMLElement;
      expect(getComputedStyle(editorEl).fontFamily).toBe("Georgia, serif");

      handle.applyFontFamily("ui-monospace, monospace");
      expect(getComputedStyle(editorEl).fontFamily).toBe(
        "ui-monospace, monospace",
      );
      // 저장값을 비우면(피커의 "시스템 기본") 지정이 사라진다.
      handle.applyFontFamily(null);
      expect(getComputedStyle(editorEl).fontFamily).toBe(NO_FONT_FAMILY);
    } finally {
      host.remove();
    }
  });

  /**
   * 가드(핵심): 폰트 플러그인이 **꺼져 있으면** 저장값이 있어도 시스템 기본이다(배경 능력의
   * "끄면 고정"과 대칭). 게이트가 새면 플러그인을 껐는데 글꼴만 그대로 남는다.
   */
  it("ignores the saved stack while the font capability is off", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const handle = await mountNoteWindow(host, "n1", {
        ...baseNoteDeps(),
        font: null,
        fontFamily: "Georgia, serif",
      });
      const editorEl = host.querySelector(".cm-editor") as HTMLElement;
      expect(getComputedStyle(editorEl).fontFamily).toBe(NO_FONT_FAMILY);

      // 능력이 없는 동안은 값이 새로 와도 무시한다.
      handle.applyFontFamily("ui-monospace, monospace");
      expect(getComputedStyle(editorEl).fontFamily).toBe(NO_FONT_FAMILY);

      // 플러그인이 켜지면(능력 도착) 같은 값이 그제서야 적용되고, 다시 끄면 되돌아간다.
      handle.applyFontCapability(
        { families: [{ label: "Mono", stack: "ui-monospace, monospace" }] },
        "ui-monospace, monospace",
      );
      expect(getComputedStyle(editorEl).fontFamily).toBe(
        "ui-monospace, monospace",
      );
      handle.applyFontCapability(null, "ui-monospace, monospace");
      expect(getComputedStyle(editorEl).fontFamily).toBe(NO_FONT_FAMILY);
    } finally {
      host.remove();
    }
  });

  /**
   * 가드(핵심): applyKeybindings가 맵을 **대체**한다 — 새 조합이 곧바로 먹고 옛 조합은 죽는다.
   * 리스너는 다시 달지 않으므로(getter) 교체 순간에 눌린 키가 유실될 창도 없다.
   */
  it("applyKeybindings() replaces the live bindings with no stale leftovers", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const counts = { a: 0, b: 0 };
    const button = (action: string, key: "a" | "b"): HTMLButtonElement => {
      const el = document.createElement("button");
      el.dataset.action = action;
      el.addEventListener("click", () => (counts[key] += 1));
      return el;
    };
    const press = (): void => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Equal", altKey: true }),
      );
    };
    try {
      const handle = await mountNoteWindow(host, "n1", {
        ...baseNoteDeps(),
        // 툴바가 그리지 않는 id를 써 이 테스트의 버튼만 후보가 되게 한다.
        keybindings: { "plugin:t:a": "Alt+Equal" },
        isMac: true,
      });
      host.append(button("plugin:t:a", "a"), button("plugin:t:b", "b"));
      press();
      expect(counts).toEqual({ a: 1, b: 0 });

      handle.applyKeybindings({ "plugin:t:b": "Alt+Equal" });
      press();
      expect(counts).toEqual({ a: 1, b: 1 });

      // 전부 지우면 그 조합은 아무 동작도 부르지 않는다(옛 바인딩 잔존 없음).
      handle.applyKeybindings({});
      press();
      expect(counts).toEqual({ a: 1, b: 1 });
    } finally {
      host.remove();
    }
  });

  /** 다음 마이크로태스크·타이머 사이클을 비운다(confirmDialog then 소진). */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /**
   * 가드(핵심): applyBackgroundCapability가 **배경색·대비·툴바 항목**을 한 번에 앞으로 감는다.
   * 능력이 없어지면 저장된 커스텀 색을 무시하고 고정 기본 배경 + 고정 대비로, 다시 생기면 새
   * 팔레트로 돌아온다. 하나라도 옛 값으로 남으면 "어두운 종이에 검은 글자" 같은 조합이 난다.
   */
  it("applyBackgroundCapability() swaps the paper color, its contrast and the toolbar picker", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      background: DEFAULT_BACKGROUND,
    });
    expect(host.style.getPropertyValue("--note-bg")).toBe(
      DEFAULT_BACKGROUND.swatches[0],
    );
    expect(host.querySelector(".note-bg-trigger")).not.toBeNull();

    handle.applyBackgroundCapability(null); // 배경 플러그인 off
    expect(host.style.getPropertyValue("--note-bg")).toBe(
      DEFAULT_BACKGROUND_COLOR,
    );
    expect(host.style.getPropertyValue("--note-text")).toBe("#1f2328"); // 고정 대비
    expect(host.querySelector(".note-bg-trigger")).toBeNull();

    // 어두운 팔레트 + 자동 대비로 다시 켠다 → 글자색·툴바 틴트가 함께 뒤집힌다.
    handle.applyBackgroundCapability({
      swatches: ["#101010"],
      autoTextContrast: true,
    });
    expect(host.style.getPropertyValue("--note-bg")).toBe("#101010");
    expect(host.style.getPropertyValue("--note-text")).toBe("#f1f1ee");
    expect(host.style.getPropertyValue("--tb-on")).toBe("255, 255, 255");
    const trigger = host.querySelector<HTMLElement>(".note-bg-trigger")!;
    expect(trigger.style.getPropertyValue("--note-chip")).toBe("#101010");
  });

  /** 가드: 능력이 꺼져 있는 동안에도 노트별 배경 override **데이터는 보존**된다(다시 켜면 복원). */
  it("keeps the saved note background across a capability off/on cycle", async () => {
    const host = document.createElement("div");
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      loadNote: vi.fn(async () => ({
        content: "",
        overrides: {
          ...NO_OVERRIDES,
          background: { type: "color", value: "#abcdef" },
        },
      })),
      background: DEFAULT_BACKGROUND,
    });
    expect(host.style.getPropertyValue("--note-bg")).toBe("#abcdef");

    handle.applyBackgroundCapability(null);
    expect(host.style.getPropertyValue("--note-bg")).toBe(
      DEFAULT_BACKGROUND_COLOR,
    );
    handle.applyBackgroundCapability(DEFAULT_BACKGROUND);
    expect(host.style.getPropertyValue("--note-bg")).toBe("#abcdef");
  });

  /**
   * 가드(핵심): 능력을 앞으로 감은 뒤에는 **옵션 초기화도 그 새 능력**을 본다. 마운트 시점의
   * `deps.background`를 계속 보고 있으면(승격 누락) 초기화가 노트를 고정 기본 배경으로 되돌려,
   * 방금 켠 배경 플러그인의 팔레트가 무시된다.
   */
  it("routes reset back through the live background capability", async () => {
    const host = document.createElement("div");
    const captured: { reset?: () => void } = {};
    const handle = await mountNoteWindow(host, "n1", {
      ...baseNoteDeps(),
      background: null, // 마운트 때는 배경 플러그인 off
      installPlugins: (ctx) => {
        captured.reset = ctx.resetOptions;
      },
    });
    handle.applyBackgroundCapability({
      swatches: ["#102030"],
      autoTextContrast: true,
    });
    expect(host.style.getPropertyValue("--note-bg")).toBe("#102030");

    captured.reset?.();
    host.querySelector<HTMLButtonElement>(".confirm-ok")?.click();
    await flush();
    expect(host.style.getPropertyValue("--note-bg")).toBe("#102030");
  });

  /**
   * 가드(핵심): applyWindowControls가 **네이티브 창 상태까지** 맞춘다. 켜지면 이 메모의 저장값을
   * 다시 적용하고(백엔드 `apply_saved_state`는 창 생성 때 한 번뿐이라 여기서 안 하면 툴바만
   * 저장값을 가리키고 창은 기본값으로 남는다), 꺼지면 기본값으로 되돌린다.
   */
  it("applyWindowControls() re-applies the saved values natively and rebuilds the controls", async () => {
    const host = document.createElement("div");
    const d = baseNoteDeps({
      loadNote: vi.fn(async () => ({
        content: "",
        overrides: { ...NO_OVERRIDES, transparency: 60, pinned: true },
      })),
      capabilities: NO_CAPABILITIES, // 세 플러그인이 모두 꺼진 채로 마운트
    });
    const handle = await mountNoteWindow(host, "n1", d);
    expect(d.applyTransparency).toHaveBeenLastCalledWith(100);
    expect(d.applyPinned).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('input[type="range"]')).toBeNull();

    handle.applyWindowControls(["transparency"]);
    expect(d.applyTransparency).toHaveBeenLastCalledWith(60); // 저장값 복원
    expect(
      host.querySelector<HTMLInputElement>('input[type="range"]')!.value,
    ).toBe("60");
    // 켜지지 않은 컨트롤은 계속 기본값 강제 + 미노출(저장값 true는 데이터로만 남는다).
    expect(d.applyPinned).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('[data-action="toggle-pin"]')).toBeNull();

    handle.applyWindowControls([]);
    expect(d.applyTransparency).toHaveBeenLastCalledWith(100);
    expect(host.querySelector('input[type="range"]')).toBeNull();
  });
});
