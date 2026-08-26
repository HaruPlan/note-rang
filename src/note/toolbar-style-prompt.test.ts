import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS } from "./toolbar-layout";

// shared/tauri.ts 전체를 목으로 바꾼다 — toolbar-style-prompt.ts가 직접 부르는 유일한 외부
// 경계다. 각 테스트가 반환값을 따로 제어할 수 있게 여기서는 빈 vi.fn()만 선언하고,
// 테스트마다 mockResolvedValue 등으로 채운다.
const getSharedSettings = vi.fn();
const saveSharedSettings = vi.fn();
const getPlatform = vi.fn();
const emitNotesReload = vi.fn();

vi.mock("../shared/tauri", () => ({
  getSharedSettings: (...args: unknown[]) => getSharedSettings(...args),
  saveSharedSettings: (...args: unknown[]) => saveSharedSettings(...args),
  getPlatform: (...args: unknown[]) => getPlatform(...args),
  emitNotesReload: (...args: unknown[]) => emitNotesReload(...args),
}));

/** 최소 SharedSettings 픽스처(테스트에 필요한 필드만). */
function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    theme: "sj_d",
    defaults: {},
    ...overrides,
  };
}

/**
 * `attempted`(모듈 안 "이미 시도함" 플래그)는 모듈 인스턴스에 갇혀 있다 — 실제 앱에서는 창마다
 * 새 페이지 로드라 자연히 리셋되지만, 테스트에서 "한 번만 시도" 자체를 검증하려면 모듈을
 * 새로 임포트해야 한다. 그래서 매 테스트 `vi.resetModules()` 후 동적 import로 새 인스턴스를
 * 받는다(테스트 간 완전한 격리).
 */
async function freshModule() {
  vi.resetModules();
  return import("./toolbar-style-prompt");
}

describe("maybeShowToolbarStylePrompt", () => {
  beforeEach(() => {
    getSharedSettings.mockReset();
    saveSharedSettings.mockReset().mockResolvedValue(undefined);
    getPlatform.mockReset();
    emitNotesReload.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("조회 실패는 조용히 넘어간다(오버레이 없음, throw 없음)", async () => {
    getSharedSettings.mockRejectedValue(new Error("boom"));
    const { maybeShowToolbarStylePrompt } = await freshModule();
    expect(() => maybeShowToolbarStylePrompt()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".toolbar-style-prompt")).toBeNull();
  });

  it("이미 스타일을 고른 적 있으면(toolbar_style) 다시 묻지 않는다", async () => {
    getSharedSettings.mockResolvedValue(baseSettings({ toolbar_style: "mac" }));
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".toolbar-style-prompt")).toBeNull();
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("이미 배치를 커스터마이즈해 둔 사용자(toolbar_layout)는 존중하고 묻지 않는다", async () => {
    getSharedSettings.mockResolvedValue(
      baseSettings({ toolbar_layout: { top: {}, bottom: {} } }),
    );
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".toolbar-style-prompt")).toBeNull();
  });

  it("미선택 + 미커스터마이즈면 프롬프트를 띄운다(macOS 추천)", async () => {
    getSharedSettings.mockResolvedValue(baseSettings());
    getPlatform.mockResolvedValue("macos");
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const overlay = document.querySelector(".toolbar-style-prompt");
    expect(overlay).not.toBeNull();
    const recommended = overlay!.querySelector(
      ".toolbar-style-prompt-choice--recommended",
    ) as HTMLButtonElement;
    expect(recommended.dataset.style).toBe("mac");
  });

  it("미선택 + 미커스터마이즈면 프롬프트를 띄운다(비macOS는 windows 추천)", async () => {
    getSharedSettings.mockResolvedValue(baseSettings());
    getPlatform.mockResolvedValue("windows");
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const overlay = document.querySelector(".toolbar-style-prompt")!;
    const recommended = overlay.querySelector(
      ".toolbar-style-prompt-choice--recommended",
    ) as HTMLButtonElement;
    expect(recommended.dataset.style).toBe("windows");
  });

  it("getPlatform 실패는 windows로 폴백한다", async () => {
    getSharedSettings.mockResolvedValue(baseSettings());
    getPlatform.mockRejectedValue(new Error("no platform"));
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const overlay = document.querySelector(".toolbar-style-prompt")!;
    const recommended = overlay.querySelector(
      ".toolbar-style-prompt-choice--recommended",
    ) as HTMLButtonElement;
    expect(recommended.dataset.style).toBe("windows");
  });

  it("Mac 스타일을 고르면 DEFAULT_LAYOUT_MAC + toolbar_style을 저장하고 즉시 반영(reload) 신호를 보낸다", async () => {
    const settings = baseSettings();
    getSharedSettings.mockResolvedValue(settings);
    getPlatform.mockResolvedValue("macos");
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const macBtn = document.querySelector<HTMLButtonElement>(
      '.toolbar-style-prompt-choice[data-style="mac"]',
    )!;
    macBtn.click();
    // 오버레이는 클릭 즉시(동기) 제거된다.
    expect(document.querySelector(".toolbar-style-prompt")).toBeNull();

    await Promise.resolve();
    await Promise.resolve();
    expect(saveSharedSettings).toHaveBeenCalledWith({
      ...settings,
      toolbar_style: "mac",
      toolbar_layout: DEFAULT_LAYOUT_MAC,
    });
    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });

  it("Windows 스타일을 고르면 DEFAULT_LAYOUT_WINDOWS를 저장한다", async () => {
    const settings = baseSettings();
    getSharedSettings.mockResolvedValue(settings);
    getPlatform.mockResolvedValue("windows");
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const winBtn = document.querySelector<HTMLButtonElement>(
      '.toolbar-style-prompt-choice[data-style="windows"]',
    )!;
    winBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(saveSharedSettings).toHaveBeenCalledWith({
      ...settings,
      toolbar_style: "windows",
      toolbar_layout: DEFAULT_LAYOUT_WINDOWS,
    });
  });

  /**
   * 가드(이슈 #21 — 오버레이 겹침 방지): 뒤이을 1회성 안내가 순서를 잡을 수 있도록,
   * 이 프롬프트는 "끝났는가 / 실제로 떴는가"를 신호로 내보낸다.
   *
   * true는 "떠서 답을 받았다" = **이 창이 곧 리로드된다**는 뜻이다(선택 → 공유 설정 저장 →
   * 호스트 재빌드 방송 → 노트 창 리로드). 그래서 뒤 안내는 true면 이번 페이지를 양보한다.
   */
  it("아직 시도 전이면 기다리지 않고 즉시 false다(툴바 없는 창·마운트 실패 폴백)", async () => {
    const { whenToolbarStylePromptSettled } = await freshModule();
    expect(await whenToolbarStylePromptSettled()).toBe(false);
  });

  it("띄울 필요가 없었으면 false로 끝난다", async () => {
    getSharedSettings.mockResolvedValue(baseSettings({ toolbar_style: "mac" }));
    const { maybeShowToolbarStylePrompt, whenToolbarStylePromptSettled } =
      await freshModule();
    maybeShowToolbarStylePrompt();
    expect(await whenToolbarStylePromptSettled()).toBe(false);
  });

  it("조회에 실패해도 false로 끝난다(뒤 순서를 영영 막지 않는다)", async () => {
    getSharedSettings.mockRejectedValue(new Error("boom"));
    const { maybeShowToolbarStylePrompt, whenToolbarStylePromptSettled } =
      await freshModule();
    maybeShowToolbarStylePrompt();
    expect(await whenToolbarStylePromptSettled()).toBe(false);
  });

  it("실제로 떠서 사용자가 고르면 true로 끝난다(뒤 안내는 리로드 후로 미룬다)", async () => {
    getSharedSettings.mockResolvedValue(baseSettings());
    getPlatform.mockResolvedValue("windows");
    const { maybeShowToolbarStylePrompt, whenToolbarStylePromptSettled } =
      await freshModule();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 아직 고르기 전에는 해소되지 않는다(오버레이 두 개가 겹치는 것을 막는 것이 이 신호의 목적).
    let settledWith: boolean | "pending" = "pending";
    void whenToolbarStylePromptSettled().then((v) => (settledWith = v));
    await Promise.resolve();
    await Promise.resolve();
    expect(settledWith).toBe("pending");

    document
      .querySelector<HTMLButtonElement>(
        '.toolbar-style-prompt-choice[data-style="windows"]',
      )!
      .click();
    expect(await whenToolbarStylePromptSettled()).toBe(true);
  });

  it("같은 모듈 인스턴스에서는 두 번째 호출을 무시한다(창당 한 번)", async () => {
    getSharedSettings.mockResolvedValue(baseSettings());
    getPlatform.mockResolvedValue("windows");
    const { maybeShowToolbarStylePrompt } = await freshModule();
    maybeShowToolbarStylePrompt();
    maybeShowToolbarStylePrompt();
    maybeShowToolbarStylePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getSharedSettings).toHaveBeenCalledTimes(1);
  });
});
