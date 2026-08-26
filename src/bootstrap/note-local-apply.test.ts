/**
 * 노트 창 국소 설정 반영기(`note-local-apply.ts`)의 규칙 가드.
 *
 * 배선(`bootstrap/note.ts`)은 Tauri 이벤트·IPC와 얽혀 있어, "어떤 키가 무엇을 바꾸는가"라는
 * 규칙만 여기서 DOM 없이 못박는다. 특히 **모르는 키가 섞이면 하나도 적용하지 않는다**는
 * 방어를 지킨다 — 반쯤 반영된 창(색은 새 값, 글자 크기는 옛 값)이 가장 나쁜 결과다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  activeThemeOverrides,
  applyLocalSettingChanges,
  canApplyLocally,
  createLocalApplyQueue,
  defaultFontPx,
  localApplyKeys,
  withTimeout,
} from "./note-local-apply";
import { LOCAL_APPLY_KEYS } from "./settings-diff";

/** 적용 호출을 관찰하는 노트 창 핸들 스텁(핸들의 두 메서드만 있으면 된다). */
function target() {
  return {
    applyThemeOverrides: vi.fn(),
    applyBaseFontPx: vi.fn(),
    applyFontFamily: vi.fn(),
  };
}

const SETTINGS = {
  theme: "sj-d",
  theme_overrides: { "sj-d": { accent: "#111" }, "sj-l": { accent: "#eee" } },
  defaults: { font_size: 18, font_family: "Georgia, serif" },
};

describe("activeThemeOverrides", () => {
  /** 가드: 활성 테마 이름에 해당하는 엔트리만 고른다(다른 테마의 색이 새지 않는다). */
  it("picks the entry for the active theme", () => {
    expect(activeThemeOverrides(SETTINGS)).toEqual({ accent: "#111" });
  });

  /** 가드: 엔트리가 없거나 설정 자체를 못 읽었으면 빈 맵(오버라이드 없음). */
  it("falls back to an empty map", () => {
    expect(
      activeThemeOverrides({ theme: "other", theme_overrides: {} }),
    ).toEqual({});
    expect(activeThemeOverrides({})).toEqual({});
    expect(activeThemeOverrides(null)).toEqual({});
  });
});

describe("defaultFontPx", () => {
  /** 가드: defaults.font_size를 읽고, 숫자가 아니거나 없으면 14로 폴백한다(설정 창과 같은 값). */
  it("reads defaults.font_size with a 14px fallback", () => {
    expect(defaultFontPx(SETTINGS)).toBe(18);
    expect(defaultFontPx({ defaults: {} })).toBe(14);
    expect(defaultFontPx({ defaults: { font_size: "18" } })).toBe(14);
    expect(defaultFontPx(null)).toBe(14);
  });
});

describe("canApplyLocally", () => {
  /** 가드: 적용기가 아는 키만 통과한다. 빈 목록은 적용할 것이 없으므로 false. */
  it("accepts only keys the applier map knows", () => {
    expect(canApplyLocally(["theme_overrides"])).toBe(true);
    expect(canApplyLocally(["defaults.font_size", "toolbar_style"])).toBe(true);
    expect(canApplyLocally(["theme"])).toBe(false);
    expect(canApplyLocally(["theme_overrides", "language"])).toBe(false);
    expect(canApplyLocally([])).toBe(false);
  });

  /** 가드: 프로토타입 키가 "아는 키"로 새지 않는다(맵을 쓰는 이유). */
  it("does not treat prototype keys as known", () => {
    expect(canApplyLocally(["toString"])).toBe(false);
    expect(canApplyLocally(["constructor"])).toBe(false);
  });
});

describe("applyLocalSettingChanges", () => {
  /** 가드: theme_overrides는 활성 테마 엔트리로 색만 다시 적용한다(폰트는 건드리지 않는다). */
  it("applies theme overrides for the active theme only", () => {
    const t = target();
    applyLocalSettingChanges(["theme_overrides"], SETTINGS, t);
    expect(t.applyThemeOverrides).toHaveBeenCalledWith({ accent: "#111" });
    expect(t.applyBaseFontPx).not.toHaveBeenCalled();
  });

  /** 가드: defaults.font_size는 기본 글자 크기만 다시 적용한다(색은 건드리지 않는다). */
  it("applies the base font size only", () => {
    const t = target();
    applyLocalSettingChanges(["defaults.font_size"], SETTINGS, t);
    expect(t.applyBaseFontPx).toHaveBeenCalledWith(18);
    expect(t.applyThemeOverrides).not.toHaveBeenCalled();
  });

  /**
   * 가드: defaults.font_family는 **저장된 스택 원본만** 넘긴다 — 폰트 플러그인이 켜져 있는지는
   * 설정에 적힌 값이 아니라 창이 들고 있는 사실이라, 게이팅은 창(`resolveFontFamily`)이 한다.
   */
  it("applies the saved font stack as-is (the window gates on the capability)", () => {
    const t = target();
    applyLocalSettingChanges(["defaults.font_family"], SETTINGS, t);
    expect(t.applyFontFamily).toHaveBeenCalledWith("Georgia, serif");
    expect(t.applyBaseFontPx).not.toHaveBeenCalled();
    expect(t.applyThemeOverrides).not.toHaveBeenCalled();
  });

  /** 가드: 값이 비었거나 없으면 null(=시스템 기본)로 접어 넘긴다 — 빈 문자열이 새지 않는다. */
  it("folds an empty or missing font stack to null", () => {
    const t = target();
    applyLocalSettingChanges(
      ["defaults.font_family"],
      { defaults: { font_family: "" } },
      t,
    );
    applyLocalSettingChanges(["defaults.font_family"], { defaults: {} }, t);
    expect(t.applyFontFamily.mock.calls).toEqual([[null], [null]]);
  });

  /** 가드: toolbar_style은 열린 창에 소비처가 없어 통과하되 아무것도 하지 않는다(no-op). */
  it("passes toolbar_style through as a no-op", () => {
    const t = target();
    applyLocalSettingChanges(["toolbar_style"], SETTINGS, t);
    expect(t.applyThemeOverrides).not.toHaveBeenCalled();
    expect(t.applyBaseFontPx).not.toHaveBeenCalled();
    expect(t.applyFontFamily).not.toHaveBeenCalled();
  });

  /** 가드: 여러 키가 함께 오면 전부 적용한다(합집합 통지 경로). */
  it("applies every known key in the batch", () => {
    const t = target();
    applyLocalSettingChanges(
      ["theme_overrides", "defaults.font_size"],
      SETTINGS,
      t,
    );
    expect(t.applyThemeOverrides).toHaveBeenCalledTimes(1);
    expect(t.applyBaseFontPx).toHaveBeenCalledTimes(1);
  });

  /** 가드(핵심): 모르는 키가 하나라도 섞이면 **아무것도** 적용하지 않는다(반쯤 반영 금지). */
  it("applies nothing when the batch contains an unknown key", () => {
    const t = target();
    applyLocalSettingChanges(["theme_overrides", "theme"], SETTINGS, t);
    expect(t.applyThemeOverrides).not.toHaveBeenCalled();
    expect(t.applyBaseFontPx).not.toHaveBeenCalled();
  });
});

describe("드리프트 가드", () => {
  /**
   * 가드(핵심): 보내는 쪽 화이트리스트(`LOCAL_APPLY_KEYS`)와 받는 쪽 적용기 맵의 키 집합이
   * 정확히 같아야 한다. 갈리면 통지가 조용히 버려지거나(받는 쪽에 없음), 반영할 방법이 없는
   * 키가 국소 경로로 새어 나간다(보내는 쪽에만 있음).
   */
  it("keeps the applier map in sync with LOCAL_APPLY_KEYS", () => {
    expect([...localApplyKeys()].sort()).toEqual([...LOCAL_APPLY_KEYS].sort());
  });
});

describe("withTimeout", () => {
  /** 가드(핵심): 원본 프라미스가 상한 안에 정착하면 그 값을 그대로 돌려준다. */
  it("resolves with the value when the promise settles in time", async () => {
    vi.useFakeTimers();
    try {
      const result = withTimeout(Promise.resolve("value"), 1_000);
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toBe("value");
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드(핵심): 상한을 넘기면 원본이 영영 정착하지 않아도(리졸버를 아예 안 부름) null로 접는다. */
  it("resolves with null once the deadline passes without a settlement", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => {});
      const result = withTimeout(never, 1_000);
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 아직 정착되지 않은 프라미스 — 테스트가 resolve/reject 시점을 직접 통제한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLocalApplyQueue", () => {
  /**
   * 가드(핵심): 두 통지의 fetch가 역순으로 응답해도(나중 통지의 fetch가 먼저 옴), 최신
   * 통지의 스냅샷을 기준으로 두 통지의 changedKeys 합집합이 **한 번만** 적용되고, 뒤늦게
   * 도착한 첫 통지의 낡은 스냅샷은 버려진다(추가 적용이 없다).
   */
  it("applies the union of keys from the latest snapshot when responses arrive out of order", async () => {
    const first = deferred<{ tag: string }>();
    const second = deferred<{ tag: string }>();
    const fetchSettings = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const apply = vi.fn();
    const notify = createLocalApplyQueue(fetchSettings, apply);

    notify(["theme_overrides"]);
    notify(["defaults.font_size"]);

    // 나중에 나간 통지(2차)의 fetch가 먼저 응답한다 — 역순 도착.
    second.resolve({ tag: "fresh" });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toEqual({ tag: "fresh" });
    expect([...(apply.mock.calls[0]?.[0] ?? [])].sort()).toEqual([
      "defaults.font_size",
      "theme_overrides",
    ]);

    // 먼저 나간 통지(1차)가 뒤늦게 응답해도 낡은 스냅샷은 버려진다(추가 적용 없음).
    first.resolve({ tag: "stale" });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  /** 가드: fetch가 실패하면 이번 통지는 조용히 버려지고(적용 없음), 다음 통지는 정상 처리된다. */
  it("applies nothing when the fetch fails, and recovers on the next notice", async () => {
    const apply = vi.fn();
    const fetchSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ tag: "ok" });
    const notify = createLocalApplyQueue(fetchSettings, apply);

    notify(["theme_overrides"]);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    notify(["defaults.font_size"]);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(apply).toHaveBeenCalledTimes(1);
    // 실패한 1차 통지의 키는 유실되지 않는다 — pendingKeys는 적용에 성공했을 때만 비워지므로
    // (fetch 실패는 clear()를 지나지 않는다), 1차의 theme_overrides가 2차의 성공 응답에
    // 실려 함께 적용된다(누적 방식). 이번 통지가 다음 통지를 막지 않는다는 점도 함께 못박는다.
    expect([...(apply.mock.calls[0]?.[0] ?? [])].sort()).toEqual([
      "defaults.font_size",
      "theme_overrides",
    ]);
    expect(apply.mock.calls[0]?.[1]).toEqual({ tag: "ok" });
  });
});
