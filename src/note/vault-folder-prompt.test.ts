import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shared/tauri.ts와 toolbar-style-prompt.ts가 이 모듈이 닿는 외부 경계 전부다. 테스트마다
// 반환값을 따로 제어할 수 있게 여기서는 빈 vi.fn()만 선언한다(toolbar-style-prompt.test.ts와
// 같은 관례).
const getVaultInfo = vi.fn();
const markVaultPrompted = vi.fn();
const openSettings = vi.fn();
const whenToolbarStylePromptSettled = vi.fn();

vi.mock("../shared/tauri", () => ({
  getVaultInfo: (...args: unknown[]) => getVaultInfo(...args),
  markVaultPrompted: (...args: unknown[]) => markVaultPrompted(...args),
  openSettings: (...args: unknown[]) => openSettings(...args),
}));

vi.mock("./toolbar-style-prompt", () => ({
  whenToolbarStylePromptSettled: (...args: unknown[]) =>
    whenToolbarStylePromptSettled(...args),
}));

/** 최소 VaultInfo 픽스처(이 모듈이 보는 필드만 의미가 있다). */
function info(overrides: Record<string, unknown> = {}) {
  return {
    path: "C:\\Users\\me\\Documents\\note-rang",
    has_contents: false,
    note_count: 0,
    file_count: 0,
    prompted: false,
    ...overrides,
  };
}

/**
 * `attempted`(모듈 안 "이미 시도함" 플래그)는 모듈 인스턴스에 갇혀 있다 — 실제 앱에서는 창마다
 * 새 페이지 로드라 자연히 리셋되지만, 테스트에서는 매번 새 인스턴스가 필요하다
 * (toolbar-style-prompt.test.ts와 같은 이유).
 */
async function freshModule() {
  vi.resetModules();
  return import("./vault-folder-prompt");
}

/** 마이크로태스크를 넉넉히 흘려 비동기 판정이 끝나게 한다. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("maybeShowVaultFolderPrompt", () => {
  beforeEach(() => {
    getVaultInfo.mockReset();
    markVaultPrompted.mockReset().mockResolvedValue(undefined);
    openSettings.mockReset().mockResolvedValue(undefined);
    whenToolbarStylePromptSettled.mockReset().mockResolvedValue(false);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("조회 실패는 조용히 넘어간다(오버레이 없음, throw 없음)", async () => {
    getVaultInfo.mockRejectedValue(new Error("boom"));
    const { maybeShowVaultFolderPrompt } = await freshModule();
    expect(() => maybeShowVaultFolderPrompt()).not.toThrow();
    await flush();
    expect(document.querySelector(".vault-folder-prompt")).toBeNull();
    expect(markVaultPrompted).not.toHaveBeenCalled();
  });

  it("이미 안내한 적 있으면(prompted) 묻지 않는다", async () => {
    getVaultInfo.mockResolvedValue(info({ prompted: true }));
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    await flush();
    expect(document.querySelector(".vault-folder-prompt")).toBeNull();
    expect(markVaultPrompted).not.toHaveBeenCalled();
  });

  /**
   * 가드(오버레이 겹침 방지): 툴바 스타일 프롬프트가 실제로 떠서 답을 받았다면 이 창은 곧
   * 리로드된다 — 여기서 띄우면 보이지도 않은 채 지워지고 "이미 봤음"으로 기록된다.
   */
  it("스타일 프롬프트가 떠서 답을 받았으면 이번 페이지에서는 뜨지 않는다", async () => {
    getVaultInfo.mockResolvedValue(info());
    whenToolbarStylePromptSettled.mockResolvedValue(true);
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    await flush();
    expect(document.querySelector(".vault-folder-prompt")).toBeNull();
    expect(markVaultPrompted).not.toHaveBeenCalled();
  });

  it("첫 실행이면 현재 경로와 함께 안내를 띄우고, 띄우는 즉시 안내함으로 기록한다", async () => {
    getVaultInfo.mockResolvedValue(info());
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    await flush();

    const overlay = document.querySelector(".vault-folder-prompt");
    expect(overlay).not.toBeNull();
    expect(
      overlay!.querySelector(".vault-folder-prompt-path")!.textContent,
    ).toBe("C:\\Users\\me\\Documents\\note-rang");
    // 닫을 때가 아니라 띄우는 즉시 기록한다(답하지 않고 앱을 꺼도 다시 묻지 않게).
    expect(markVaultPrompted).toHaveBeenCalledTimes(1);
  });

  it("‘이 폴더 사용’은 아무것도 바꾸지 않고 닫기만 한다", async () => {
    getVaultInfo.mockResolvedValue(info());
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    await flush();

    document
      .querySelector<HTMLButtonElement>(".vault-folder-prompt-keep")!
      .click();
    expect(document.querySelector(".vault-folder-prompt")).toBeNull();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("‘설정에서 변경’은 설정 창을 연다(폴더 이전은 설정 페이지의 몫)", async () => {
    getVaultInfo.mockResolvedValue(info());
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    await flush();

    document
      .querySelector<HTMLButtonElement>(".vault-folder-prompt-change")!
      .click();
    expect(document.querySelector(".vault-folder-prompt")).toBeNull();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("같은 모듈 인스턴스에서는 두 번째 호출을 무시한다(창당 한 번)", async () => {
    getVaultInfo.mockResolvedValue(info());
    const { maybeShowVaultFolderPrompt } = await freshModule();
    maybeShowVaultFolderPrompt();
    maybeShowVaultFolderPrompt();
    maybeShowVaultFolderPrompt();
    await flush();
    expect(getVaultInfo).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".vault-folder-prompt")).toHaveLength(1);
  });
});
