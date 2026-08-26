/**
 * 패널 창(`?panel`) 부트스트랩의 이벤트 구독과 색 적용 — 중앙 호스트 재빌드(언어 등)를 이
 * 창도 리로드로 받는지, 그리고 패널 전용 색 토큰(`panel`·`panel-text`)이 마운트 시점과
 * 국소 설정 변경(`EV_SETTINGS_CHANGED_LOCAL`)에 맞춰 CSS 변수로 얹히는지 검증한다.
 *
 * 이 갭이 있던 이유: 패널은 그동안 EV_NOTES_LIST_CHANGED만 구독해, 노트 창(note.ts:417-421)이
 * EV_HOST_UPDATED에 걸어 둔 전체 reload() 패턴이 패널에는 없었다 — 언어를 바꿔도 이미 열려
 * 있던 패널은 예전 언어로 남았다.
 *
 * `mountPanel`(패널 화면 전체 렌더)과 `./shared`의 `tauriBus`는 목으로 갈아 끼운다 — 이 파일이
 * 볼 것은 화면 렌더가 아니라 "EV_HOST_UPDATED를 구독하는가·구독 시 reload()하는가" 그
 * 자체이기 때문이다. 가짜 버스는 `listen(event, handler)`가 호출될 때 이벤트 이름별로
 * 핸들러를 기억해 뒀다가, 테스트가 그 핸들러를 직접 불러 노트 창 쪽 규약(bus.listen 콜백 →
 * reload)과 동일한 것을 확인한다.
 *
 * `vi.mock`이 참조하는 스파이는 이 리포의 관례(`note/vault-folder-prompt.test.ts`와 동일)를
 * 따라 최상단 `const`로 선언하고, 대상 모듈은 매 테스트 동적 import로 새로 불러온다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 이벤트 이름 → 마지막으로 등록된 핸들러(가짜 버스가 채운다). */
const listeners = new Map<string, (payload: unknown) => void>();
const busListen = vi.fn(
  (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => {};
  },
);
const busEmit = vi.fn();

const getSharedSettings = vi.fn(async () => ({}) as Record<string, unknown>);
const listBuiltinStates = vi.fn(async () => ({}) as Record<string, boolean>);
const readLocaleEntries = vi.fn(async () => ({}) as Record<string, string>);
const mountPanel = vi.fn(async () => {});
const ensureGuideNote = vi.fn(async () => null as string | null);

vi.mock("./shared", () => ({
  tauriBus: () => ({ listen: busListen, emit: busEmit }),
}));

// 「시작 가이드」 배선은 목이다 — 이 파일이 볼 것은 판정이 아니라 **부르는가**뿐이고, 판정
// 자체는 `guide-note.test.ts`가 IO를 주입해 따로 지킨다.
vi.mock("./guide-note", () => ({
  ensureGuideNote: (...args: unknown[]) =>
    (ensureGuideNote as (...a: unknown[]) => Promise<string | null>)(...args),
  tauriGuideNoteIO: () => ({}),
}));

vi.mock("../panel/panel", () => ({
  mountPanel: (...args: unknown[]) =>
    (mountPanel as (...a: unknown[]) => Promise<void>)(...args),
}));

// bootstrapPanel이 마운트 전에 직접 부르는 조회들만 골라 감싼다(나머지는 mountPanel의 deps
// 클로저로만 쓰여 이 파일에서는 실제로 호출되지 않는다).
vi.mock("../shared/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/tauri")>();
  return {
    ...actual,
    getSharedSettings: (...args: unknown[]) =>
      (getSharedSettings as (...a: unknown[]) => Promise<unknown>)(...args),
    listBuiltinStates: (...args: unknown[]) =>
      (listBuiltinStates as (...a: unknown[]) => Promise<unknown>)(...args),
    readLocaleEntries: (...args: unknown[]) =>
      (readLocaleEntries as (...a: unknown[]) => Promise<unknown>)(...args),
  };
});

/** 한 창을 새로 연 것과 같은 효과 — 매번 새 모듈 인스턴스로 `bootstrapPanel`을 부른다. */
async function freshBootstrap(): Promise<
  typeof import("./panel").bootstrapPanel
> {
  vi.resetModules();
  const { bootstrapPanel } = await import("./panel");
  return bootstrapPanel;
}

beforeEach(() => {
  // 언어 판정이 OS 로케일로 새지 않게 고정한다(다른 부트스트랩 테스트·plugin-host.test.ts와
  // 같은 이유) — language==="ko"로 고정해 readLocaleEntries 분기까지 신경 쓸 필요를 없앤다.
  Object.defineProperty(navigator, "language", {
    value: "ko-KR",
    configurable: true,
  });
  listeners.clear();
  busListen.mockClear();
  busEmit.mockClear();
  getSharedSettings.mockClear().mockResolvedValue({});
  listBuiltinStates.mockClear().mockResolvedValue({});
  readLocaleEntries.mockClear().mockResolvedValue({});
  mountPanel.mockClear().mockResolvedValue(undefined);
  ensureGuideNote.mockClear().mockResolvedValue(null);
  // 색은 <html>의 인라인 변수로 얹힌다 — jsdom의 document는 파일 전체가 공유하므로 앞
  // 테스트가 칠한 값이 남지 않게 지운다(테스트 간 순서 의존 방지).
  document.documentElement.removeAttribute("style");
});

/** 오버라이드 재적용은 설정 재조회(프라미스)를 거친다 — 그 큐가 비도록 마이크로태스크를 턴다. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootstrapPanel — 시작 가이드", () => {
  /**
   * 가드(배선): 패널은 마운트를 마친 뒤 「시작 가이드」 생성을 시도하고, 만들었으면 그 창까지
   * 연다(`summon: true`).
   *
   * 왜 패널인가: 시작 흐름은 자동시작·점프리스트가 아닌 한 이 창을 **항상** 열므로
   * (`lib.rs`의 `startup_plan` D1) 진짜 첫 실행이 반드시 지나는 길이다. 이 호출이 빠지면
   * 첫 실행에 가이드가 아예 만들어지지 않는데, 아무 테스트도 깨지지 않는다.
   *
   * 마운트 **뒤**여야 하는 이유: 이 부가 IPC가 목록의 첫 페인트를 늦춰서는 안 된다.
   */
  it("ensures the guide note after mounting, with summon", async () => {
    const bootstrapPanel = await freshBootstrap();
    const order: string[] = [];
    mountPanel.mockImplementation(async () => {
      order.push("mount");
    });
    ensureGuideNote.mockImplementation(async () => {
      order.push("guide");
      return null;
    });

    await bootstrapPanel(document.createElement("div"));
    expect(ensureGuideNote).toHaveBeenCalledWith(expect.anything(), {
      summon: true,
    });
    expect(order).toEqual(["mount", "guide"]);
  });
});

describe("bootstrapPanel — EV_HOST_UPDATED 구독", () => {
  /** 가드(핵심 회귀): 패널도 노트 창과 같은 패턴으로 EV_HOST_UPDATED를 구독해 리로드한다 —
   * 언어·테마 등 중앙 호스트 재빌드 결과가 이미 열려 있는 패널에도 반영되는 유일한 경로다. */
  it("reloads this window when EV_HOST_UPDATED fires", async () => {
    const bootstrapPanel = await freshBootstrap();
    const host = document.createElement("div");
    const reloadFn = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadFn },
    });
    try {
      await bootstrapPanel(host);
      expect(busListen).toHaveBeenCalledWith(
        "plugin-host:updated",
        expect.any(Function),
      );

      const handler = listeners.get("plugin-host:updated");
      expect(handler).toBeDefined();
      expect(reloadFn).not.toHaveBeenCalled();
      handler!(null);
      expect(reloadFn).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});

describe("bootstrapPanel — 패널 색 토큰 적용", () => {
  /** 활성 테마 `t`에 패널 오버라이드가 걸린 공유 설정. */
  const settingsWithPanelColors = (): Record<string, unknown> => ({
    theme: "t",
    theme_overrides: {
      t: { panel: "#101010", "panel-text-dark": "#00ff00" },
    },
  });

  /** 가드(핵심): 마운트 시점에 활성 테마의 색 오버라이드가 CSS 변수로 얹힌다 — 설정 읽기에
   * 얹혀 오므로 추가 IPC 없이 첫 페인트 전에 적용된다. */
  it("applies the active theme's color overrides on mount", async () => {
    getSharedSettings.mockResolvedValue(settingsWithPanelColors());
    const bootstrapPanel = await freshBootstrap();
    await bootstrapPanel(document.createElement("div"));

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--memo-panel-light")).toBe("#101010");
    expect(style.getPropertyValue("--memo-panel-text-dark")).toBe("#00ff00");
    // 오버라이드가 없는 토큰은 베이스 팔레트(SJ_D) 값으로 채워진다.
    expect(style.getPropertyValue("--memo-panel-dark")).toBe("#1f1f1f");
    expect(style.getPropertyValue("--memo-accent")).toBe("#37506a");
  });

  /** 가드: 다른 테마의 오버라이드는 활성 테마에 새지 않는다(테마별 키잉). */
  it("ignores overrides keyed to a non-active theme", async () => {
    getSharedSettings.mockResolvedValue({
      theme: "t",
      theme_overrides: { other: { panel: "#101010" } },
    });
    const bootstrapPanel = await freshBootstrap();
    await bootstrapPanel(document.createElement("div"));
    expect(
      document.documentElement.style.getPropertyValue("--memo-panel-light"),
    ).toBe("#fbfbf8"); // SJ_D 기본값 그대로
  });

  /** 가드(핵심 회귀): 색만 바뀐 저장은 재빌드(EV_HOST_UPDATED)를 내지 않고 국소 채널로만
   * 온다 — 이 구독이 없으면 다른 창은 다 바뀌는데 패널만 옛 색으로 남는다. */
  it("re-applies colors when EV_SETTINGS_CHANGED_LOCAL carries theme_overrides", async () => {
    const bootstrapPanel = await freshBootstrap();
    await bootstrapPanel(document.createElement("div"));
    expect(
      document.documentElement.style.getPropertyValue("--memo-panel-light"),
    ).toBe("#fbfbf8");

    getSharedSettings.mockResolvedValue(settingsWithPanelColors());
    listeners.get("settings-changed-local")!({
      changedKeys: ["theme_overrides"],
    });
    await flush();
    expect(
      document.documentElement.style.getPropertyValue("--memo-panel-light"),
    ).toBe("#101010");
  });

  /** 가드: 패널에 소비처가 없는 키만 온 통지는 설정 재조회조차 하지 않는다(불필요한 IPC 왕복
   * 제거 — 노트 창의 `canApplyLocally`가 같은 이유로 하는 판정과 같은 원칙). */
  it("ignores local changes that do not touch theme_overrides", async () => {
    const bootstrapPanel = await freshBootstrap();
    await bootstrapPanel(document.createElement("div"));
    getSharedSettings.mockClear().mockResolvedValue(settingsWithPanelColors());

    listeners.get("settings-changed-local")!({
      changedKeys: ["defaults.font_size"],
    });
    await flush();
    expect(getSharedSettings).not.toHaveBeenCalled();
    expect(
      document.documentElement.style.getPropertyValue("--memo-panel-light"),
    ).toBe("#fbfbf8");
  });
});
