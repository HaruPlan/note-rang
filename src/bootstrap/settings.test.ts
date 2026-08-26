/**
 * 설정 창 부트스트랩의 notes-reload 리로드 배선(`flushNotesReload`) — 저장 직후 이 창
 * 자신이 self-reload하기 전에 400ms 디바운스 타이머가 잘리지 않고 반드시 발화하게 하는
 * 안전장치를 검증한다(언어 변경·언어팩 설치/토글/제거가 겪던 경합의 수복).
 *
 * `mountSettings`(설정 화면 전체 렌더)는 목으로 갈아 끼우고 그 인자로 받은 deps만 캡처한다 —
 * 이 파일이 볼 것은 화면 동작(settings.test.ts가 이미 촘촘히 덮는다)이 아니라
 * `bootstrapSettings` 자신이 배선한 reload 타이밍이다. `saveSharedSettings`·`emitNotesReload`도
 * 실제 Tauri IPC 대신 스파이로 갈아 끼운다 — 이 테스트 환경엔 Tauri 런타임이 없어 실제
 * 호출은 거부되고, 그러면 `reloadAfter`의 성공 후속 처리(타이머 예약)가 전혀 돌지 않아
 * 검증할 대상 자체가 없어진다.
 *
 * `vi.mock`이 참조하는 스파이는 이 리포의 관례(`note/vault-folder-prompt.test.ts`와 동일)를
 * 따라 최상단 `const`로 선언하고, 대상 모듈은 매 테스트 `vi.resetModules()` 후 동적 import로
 * 새로 불러온다 — 정적 import를 쓰면 팩토리가 그 const들보다 먼저 평가될 위험이 있다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitNotesReload = vi.fn(async () => {});
const emitAppEvent = vi.fn(async () => {});
const saveSharedSettings = vi.fn(async () => {});
const getPluginsDir = vi.fn(async () => "/plugins");
const setPluginEnabled = vi.fn(async () => {});
const setPluginSetting = vi.fn(async () => {});
const setBuiltinEnabled = vi.fn(async () => {});
/** 마운트가 읽는 최초 설정(= diff 기준의 시드). 테스트마다 필요한 값으로 갈아 끼운다. */
const getSharedSettings = vi.fn(async () => ({}) as Record<string, unknown>);

/**
 * 이벤트 이름 → 마지막으로 등록된 핸들러(가짜 `onAppEvent`가 채운다) — `panel.test.ts`와
 * 같은 패턴이다. `bootstrapSettings`는 `tauriBus()`(`./shared`)를 통해 `../shared/tauri`의
 * `onAppEvent`/`emitAppEvent`로 IPC를 감싸므로, 이 둘만 가짜로 갈아 끼우면 `bus.listen`이
 * 실제 Tauri 런타임 없이도 결정적으로 동작한다.
 */
const listeners = new Map<string, (payload: unknown) => void>();
const onAppEvent = vi.fn(
  (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => {};
  },
);

/** `mountSettings`에 실제로 넘어간 deps — 이 파일이 검증하는 메서드만 있으면 된다. */
let capturedDeps: {
  getSettings: () => Promise<unknown>;
  saveSettings: (settings: unknown) => Promise<void>;
  flushNotesReload: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  setSetting: (id: string, key: string, value: unknown) => Promise<void>;
  setBuiltinEnabled: (id: string, enabled: boolean) => Promise<void>;
  onThemeUpdated: (handler: () => void) => void;
} | null = null;

vi.mock("../settings/settings", () => ({
  mountSettings: (
    _host: HTMLElement,
    deps: NonNullable<typeof capturedDeps>,
  ) => {
    capturedDeps = deps;
    return Promise.resolve();
  },
}));

// bootstrapSettings가 배선하는 나머지 shared/tauri 함수(테마·플러그인 목록 등)는 전부 deps의
// 지연 클로저로만 쓰여 이 파일에서는 실제로 호출되지 않는다 — 실제 구현으로 감싸 둔다
// (settings.test.ts의 vi.mock("../shared/tauri", ...)과 같은 관례).
vi.mock("../shared/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/tauri")>();
  return {
    ...actual,
    emitNotesReload: (...args: unknown[]) =>
      (emitNotesReload as (...a: unknown[]) => Promise<void>)(...args),
    emitAppEvent: (...args: unknown[]) =>
      (emitAppEvent as (...a: unknown[]) => Promise<void>)(...args),
    // `bus.listen`(tauriBus → onAppEvent)이 이 가짜로 갈아 끼워져, EV_HOST_PLUGIN_UPDATED
    // 구독 가드(아래)가 실제 Tauri `listen()` 없이 핸들러를 직접 불러 확인할 수 있다.
    onAppEvent: (...args: unknown[]) =>
      (onAppEvent as (...a: unknown[]) => () => void)(...args),
    getSharedSettings: (...args: unknown[]) =>
      (getSharedSettings as (...a: unknown[]) => Promise<unknown>)(...args),
    saveSharedSettings: (...args: unknown[]) =>
      (saveSharedSettings as (...a: unknown[]) => Promise<void>)(...args),
    getPluginsDir: (...args: unknown[]) =>
      (getPluginsDir as (...a: unknown[]) => Promise<string>)(...args),
    // 아래 셋은 재빌드 사유(reasons)를 검증하려면 **성공해야** 한다 — 실제 구현은 Tauri
    // 런타임이 없는 이 환경에서 거부되고, 그러면 reloadAfter의 후속 처리가 아예 돌지 않는다.
    setPluginEnabled: (...args: unknown[]) =>
      (setPluginEnabled as (...a: unknown[]) => Promise<void>)(...args),
    setPluginSetting: (...args: unknown[]) =>
      (setPluginSetting as (...a: unknown[]) => Promise<void>)(...args),
    setBuiltinEnabled: (...args: unknown[]) =>
      (setBuiltinEnabled as (...a: unknown[]) => Promise<void>)(...args),
  };
});

/** 한 창을 새로 연 것과 같은 효과 — 매번 새 모듈 인스턴스로 `bootstrapSettings`를 부른다. */
async function freshBootstrap(): Promise<
  typeof import("./settings").bootstrapSettings
> {
  vi.resetModules();
  const { bootstrapSettings } = await import("./settings");
  return bootstrapSettings;
}

/** diff 기준이 되는 최초 설정 스냅샷 — 테스트는 여기서 한 키씩만 바꿔 저장한다. */
const BASE_SETTINGS = {
  schema_version: 1,
  theme: "sj-d",
  theme_overrides: { "sj-d": { accent: "#111" } },
  defaults: { font_size: 14, font_family: "Serif" },
};

beforeEach(() => {
  vi.useFakeTimers();
  emitNotesReload.mockClear();
  emitAppEvent.mockClear();
  saveSharedSettings.mockClear().mockResolvedValue(undefined);
  getPluginsDir.mockClear().mockResolvedValue("/plugins");
  setPluginEnabled.mockClear().mockResolvedValue(undefined);
  setPluginSetting.mockClear().mockResolvedValue(undefined);
  setBuiltinEnabled.mockClear().mockResolvedValue(undefined);
  getSharedSettings.mockClear().mockResolvedValue(BASE_SETTINGS);
  listeners.clear();
  onAppEvent.mockClear();
  capturedDeps = null;
});

/**
 * 마운트가 최초 설정을 읽은 상태(= diff 기준이 시드된 상태)의 deps를 만든다. 이 시드가
 * 없으면(기준 미상) 저장은 무조건 기존 리로드 경로로 떨어진다 — 그쪽은 위 describe가 덮는다.
 */
async function seededDeps(): Promise<NonNullable<typeof capturedDeps>> {
  const bootstrapSettings = await freshBootstrap();
  await bootstrapSettings(document.createElement("div"));
  const deps = capturedDeps!;
  await deps.getSettings();
  return deps;
}

/** 국소 변경 통지로 실제로 나간 changedKeys(이벤트가 없으면 null). */
function localChangedKeys(): string[] | null {
  const call = emitAppEvent.mock.calls.find(
    (c) => (c as unknown[])[0] === "settings-changed-local",
  ) as unknown[] | undefined;
  return call
    ? ((call[1] as { changedKeys: string[] }).changedKeys ?? null)
    : null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bootstrapSettings — notes-reload 리로드 배선", () => {
  /** 가드(핵심 회귀): 저장 뒤 400ms 디바운스가 아직 발화하지 않았어도 flushNotesReload가
   * 타이머를 취소하고 즉시 emit한다 — self-reload가 그 타이머를 파기하기 전에 신호가 이미
   * 나갔는지를 이 순서로 확인한다. 취소된 타이머가 나중에 또 쏘면 안 된다(이중 emit 금지). */
  it("flushes the pending timer immediately instead of waiting 400ms, without double-emitting", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    const deps = capturedDeps!;

    await deps.saveSettings({});
    expect(emitNotesReload).not.toHaveBeenCalled();

    await deps.flushNotesReload();
    expect(emitNotesReload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });

  /** 가드: flushNotesReload를 부르지 않으면 기존 그대로 400ms 뒤 정확히 한 번만 발화한다 —
   * 잦은 저장을 하나로 합치는 디바운스 자체는 이번 변경으로 건드리지 않았다. */
  it("still debounces repeated saves to a single emit 400ms later when never flushed", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    const deps = capturedDeps!;

    await deps.saveSettings({});
    await deps.saveSettings({});
    expect(emitNotesReload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });

  /** 가드: 아직 아무 저장도 없어(타이머가 없어) flushNotesReload를 불러도 notes-reload는
   * 여전히 (딱 한 번) 나간다 — cancel()이 no-op이어도 emit 자체는 빠지지 않는다. */
  it("still emits once when flushed with no pending timer", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    const deps = capturedDeps!;

    await deps.flushNotesReload();
    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });
});

/**
 * 값 하나를 바꿀 때마다 모든 창이 깜빡이던 문제의 수복 — 저장 라우터가 바뀐 키를 보고
 * "국소 통지"와 "기존 전체 리로드" 중 하나만 고르는지 검증한다.
 *
 * 여기서 못박는 계약은 셋이다: (1) 화이트리스트 안의 변경은 재빌드 신호를 **내지 않는다**,
 * (2) 하나라도 밖이면 예전과 **똑같이** 리로드한다(그때 대기 중인 국소 통지는 버린다),
 * (3) 바뀐 게 없으면 어느 쪽도 내지 않는다.
 */
describe("bootstrapSettings — 변경 키 라우팅", () => {
  /** 가드(핵심): 색 오버라이드만 바뀌면 재빌드 신호 없이 국소 통지 한 번만 나간다. */
  it("emits only the local notice for a whitelisted change", async () => {
    const deps = await seededDeps();

    await deps.saveSettings({
      ...BASE_SETTINGS,
      theme_overrides: { "sj-d": { accent: "#222" } },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(emitNotesReload).not.toHaveBeenCalled();
    expect(localChangedKeys()).toEqual(["theme_overrides"]);
    expect(
      emitAppEvent.mock.calls.filter(
        (c) => (c as unknown[])[0] === "settings-changed-local",
      ),
    ).toHaveLength(1);
  });

  /** 가드: 전역 글자 크기도 국소 반영 대상이다(같은 defaults 안의 글꼴은 아니다 — 아래 참고). */
  it("routes defaults.font_size locally", async () => {
    const deps = await seededDeps();

    await deps.saveSettings({
      ...BASE_SETTINGS,
      defaults: { ...BASE_SETTINGS.defaults, font_size: 18 },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(emitNotesReload).not.toHaveBeenCalled();
    expect(localChangedKeys()).toEqual(["defaults.font_size"]);
  });

  /**
   * 가드(핵심): 화이트리스트 밖 키(테마 선택·언어·툴바 배치)는 예전 그대로 400ms 뒤 재빌드로
   * 간다. 테마가 여기 있는 이유: 새 팔레트는 중앙 호스트가 테마 플러그인을 다시 돌려야 나온다 —
   * 국소 통지만 내면 노트 창이 옛 테마 위에 새 오버라이드만 얹은 채 남는다.
   */
  it("keeps the reload path for non-whitelisted keys", async () => {
    for (const patch of [
      { theme: "sj-l" },
      { language: "en" },
      { toolbar_layout: { seen: [], left: [], right: [] } },
    ]) {
      const deps = await seededDeps();
      emitNotesReload.mockClear();
      emitAppEvent.mockClear();

      await deps.saveSettings({ ...BASE_SETTINGS, ...patch });
      expect(emitNotesReload).not.toHaveBeenCalled(); // 아직 디바운스 중
      await vi.advanceTimersByTimeAsync(400);

      expect(emitNotesReload).toHaveBeenCalledTimes(1);
      expect(localChangedKeys()).toBeNull();
    }
  });

  /** 가드: 연속된 국소 변경은 하나로 합쳐지고 changedKeys는 그 합집합이다. */
  it("coalesces consecutive local changes into one notice with the union of keys", async () => {
    const deps = await seededDeps();

    await deps.saveSettings({
      ...BASE_SETTINGS,
      theme_overrides: { "sj-d": { accent: "#222" } },
    });
    await deps.saveSettings({
      ...BASE_SETTINGS,
      theme_overrides: { "sj-d": { accent: "#222" } },
      defaults: { ...BASE_SETTINGS.defaults, font_size: 20 },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(emitNotesReload).not.toHaveBeenCalled();
    expect(
      emitAppEvent.mock.calls.filter(
        (c) => (c as unknown[])[0] === "settings-changed-local",
      ),
    ).toHaveLength(1);
    expect([...(localChangedKeys() ?? [])].sort()).toEqual([
      "defaults.font_size",
      "theme_overrides",
    ]);
  });

  /**
   * 가드(핵심): 국소 통지가 아직 대기 중일 때 리로드 키가 바뀌면, 그 통지는 **버려지고**
   * 리로드만 나간다 — 리로드가 최종 상태를 전부 담으므로 같은 변경을 두 경로로 두 번
   * 반영할 이유가 없다(국소 적용 직후 곧바로 리로드되는 이중 깜빡임도 막는다).
   */
  it("drops a pending local notice when a reload-triggering key changes", async () => {
    const deps = await seededDeps();

    await deps.saveSettings({
      ...BASE_SETTINGS,
      theme_overrides: { "sj-d": { accent: "#222" } },
    });
    await deps.saveSettings({
      ...BASE_SETTINGS,
      theme_overrides: { "sj-d": { accent: "#222" } },
      theme: "sj-l",
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(localChangedKeys()).toBeNull();
    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });

  /** 가드: 값이 실제로 달라지지 않은 저장(같은 값 재저장)은 어느 신호도 내지 않는다. */
  it("emits nothing when the saved settings are unchanged", async () => {
    const deps = await seededDeps();

    await deps.saveSettings({ ...BASE_SETTINGS });
    await vi.advanceTimersByTimeAsync(500);

    expect(saveSharedSettings).toHaveBeenCalled();
    expect(emitNotesReload).not.toHaveBeenCalled();
    expect(localChangedKeys()).toBeNull();
  });

  /** 가드: 저장이 실패하면 국소 통지도 나가지 않는다(디스크에 없는 값을 반영하지 않는다). */
  it("does not notify when the save itself fails", async () => {
    const deps = await seededDeps();
    saveSharedSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      deps.saveSettings({
        ...BASE_SETTINGS,
        theme_overrides: { "sj-d": { accent: "#222" } },
      }),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);

    expect(localChangedKeys()).toBeNull();
    expect(emitNotesReload).not.toHaveBeenCalled();
  });

  /**
   * 가드: 실패한 저장은 diff 기준을 앞으로 감지 않는다 — 기준이 밀리면 그 다음 저장이
   * "이미 반영됐다"고 착각해 실제 변경(여기서는 테마)을 통째로 놓친다.
   */
  it("rewinds the diff baseline when a save fails", async () => {
    const deps = await seededDeps();
    saveSharedSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      deps.saveSettings({ ...BASE_SETTINGS, theme: "sj-l" }),
    ).rejects.toThrow();
    // 실패한 저장과 **같은 값**을 다시 저장한다 — 기준이 되돌려졌다면 여전히 변경이다.
    await deps.saveSettings({ ...BASE_SETTINGS, theme: "sj-l" });
    await vi.advanceTimersByTimeAsync(400);

    expect(emitNotesReload).toHaveBeenCalledTimes(1);
  });

  /**
   * 가드(핵심 회귀): 먼저 시작한 저장(call1, next=A)이 지연 끝에 실패해도, 그 사이 더
   * 나중에 시작해 먼저 성공한 저장(call2, next=B)의 스냅샷을 diff 기준에서 되돌리지
   * 않는다. 무조건 롤백하면 lastSettings가 B보다 뒤처진 A의 이전 값(S0)으로 밀려, 다음
   * 저장이 이미 반영된 변경(B)을 다시 "변경"으로 착각한다.
   */
  it("does not roll back the baseline past a save that already succeeded", async () => {
    const deps = await seededDeps();

    const A = { ...BASE_SETTINGS, theme: "sj-l" };
    const B = { ...A, theme_overrides: { "sj-d": { accent: "#222" } } };

    saveSharedSettings
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("slow-fail")), 50);
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(undefined));

    const p1 = deps.saveSettings(A);
    const rejected = expect(p1).rejects.toThrow();
    await deps.saveSettings(B); // 즉시 성공 — lastSettings가 B로 앞서 감긴다.
    await vi.advanceTimersByTimeAsync(50); // call1의 지연 실패가 발화한다.
    await rejected;

    // call1 실패·call2 성공이 각자 낸 신호는 이번 검증 대상이 아니므로 걷어낸다.
    await vi.advanceTimersByTimeAsync(500);
    emitNotesReload.mockClear();
    emitAppEvent.mockClear();

    // 셋째 저장 — B와 완전히 같은 값. 기준이 정말 B라면 diff가 없어 아무 신호도 안 나간다
    // (기준이 잘못 S0로 되돌아갔다면 theme_overrides 변경으로 오판해 국소 통지가 나간다).
    await deps.saveSettings(B);
    await vi.advanceTimersByTimeAsync(500);

    expect(emitNotesReload).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(localChangedKeys()).toBeNull();
  });
});

/**
 * 재빌드 방송에 실리는 **사유**(`RebuildReason`) — 노트 창은 이 값 하나로 "리로드 vs 제자리
 * 조정"을 가르므로, 발신 쪽이 사유를 잘못(또는 빠뜨리고) 실으면 열려 있는 창이 낡은 채 남는다.
 * 여기서 못박는 것은 어느 동작이 어느 사유를 붙이는가와, 디바운스로 합쳐질 때 **합집합**이
 * 되는가다.
 */
describe("bootstrapSettings — 재빌드 사유", () => {
  /** 마지막 notes-reload에 실린 사유(없으면 null). */
  const lastReasons = (): string[] | null => {
    const calls = emitNotesReload.mock.calls;
    if (calls.length === 0) return null;
    return [...((calls[calls.length - 1] as unknown[])[0] as string[])].sort();
  };

  /** 가드: 화이트리스트 밖 설정 저장은 `settings`다. */
  it("labels a plain settings save as settings", async () => {
    const deps = await seededDeps();
    await deps.saveSettings({ ...BASE_SETTINGS, theme: "sj-l" });
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["settings"]);
  });

  /** 가드(핵심): 언어를 바꾼 저장은 `locale`이다 — 받는 창이 언제나 리로드해야 하는 축이다. */
  it("labels a language change as locale", async () => {
    const deps = await seededDeps();
    await deps.saveSettings({ ...BASE_SETTINGS, language: "en" });
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["locale"]);
  });

  /** 가드: 기준 스냅샷이 없어 무엇이 바뀐지 모르는 저장은 `unknown`이다(모르면 리로드). */
  it("labels a save without a diff baseline as unknown", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    await capturedDeps!.saveSettings({ ...BASE_SETTINGS, theme: "sj-l" });
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["unknown"]);
  });

  /** 가드: 플러그인 활성 토글은 `plugins`, 플러그인 설정 저장은 `plugin-setting`이다. */
  it("labels plugin toggles and plugin settings distinctly", async () => {
    const deps = await seededDeps();
    await deps.setEnabled("p1", false);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["plugins"]);

    emitNotesReload.mockClear();
    await deps.setSetting("p1", "k", 1);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["plugin-setting"]);
  });

  /**
   * 가드(핵심): 번들 **언어팩** 토글은 `plugins`가 아니라 `locale`이다.
   *
   * 언어팩은 중앙 호스트가 실행하지 않아 재빌드 전후 스냅샷이 완전히 같다 — 사유가 `plugins`로
   * 나가면 받는 창이 "바뀐 게 없네"라며 조정으로 넘어가 옛 언어 그대로 남는다.
   */
  it("labels a bundled language pack toggle as locale", async () => {
    const deps = await seededDeps();
    await deps.setBuiltinEnabled("language-pack-en", true);
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["locale"]);

    emitNotesReload.mockClear();
    await deps.setBuiltinEnabled("word-count", false); // 보통 번들은 그대로 plugins
    await vi.advanceTimersByTimeAsync(400);
    expect(lastReasons()).toEqual(["plugins"]);
  });

  /** 가드(핵심): 디바운스 창 안에서 합쳐진 요청의 사유는 **합집합**이다(하나도 버리지 않는다). */
  it("sends the union of reasons coalesced within the debounce window", async () => {
    const deps = await seededDeps();
    await deps.setEnabled("p1", false);
    await deps.saveSettings({ ...BASE_SETTINGS, theme: "sj-l" });
    await vi.advanceTimersByTimeAsync(400);

    expect(emitNotesReload).toHaveBeenCalledTimes(1);
    expect(lastReasons()).toEqual(["plugins", "settings"]);
  });

  /**
   * 가드(핵심): `flushNotesReload`는 언제나 `locale`을 더한다 — 이 함수의 호출 지점은 전부
   * 언어가 실제로 바뀌는 자리이고(언어 피커·언어팩 설치/토글/제거), 언어팩은 스냅샷에 아무
   * 흔적도 남기지 않아 이 사유가 유일한 근거다.
   */
  it("always adds locale when flushed", async () => {
    const deps = await seededDeps();
    await deps.setEnabled("lang-pack", false); // 설치 언어팩 토글 경로
    await deps.flushNotesReload();

    expect(emitNotesReload).toHaveBeenCalledTimes(1);
    expect(lastReasons()).toEqual(["locale", "plugins"]);
  });
});

/**
 * `onThemeUpdated`의 EV_HOST_PLUGIN_UPDATED 구독 — canPartial 완화(central-host.ts) 이후
 * 버튼·상태 아이템만 바뀐 dev 단일 핫리로드는 EV_HOST_UPDATED 없이 이 이벤트만 나간다.
 * 이 채널이 없으면 설정 창의 「단축키」·「툴바 배치」 페이지(refreshShortcuts·refreshUiLayout,
 * settings.ts의 afterChromeTokens)가 낡은 목록으로 남는다.
 */
describe("bootstrapSettings — onThemeUpdated의 EV_HOST_PLUGIN_UPDATED 구독", () => {
  /** 가드(핵심 회귀): EV_HOST_UPDATED·EV_SETTINGS_CHANGED_LOCAL뿐 아니라
   * EV_HOST_PLUGIN_UPDATED가 와도 onThemeUpdated에 등록한 핸들러가 불린다. */
  it("invokes the onThemeUpdated handler when EV_HOST_PLUGIN_UPDATED fires", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    const deps = capturedDeps!;
    const handler = vi.fn();
    deps.onThemeUpdated(handler);

    expect(onAppEvent).toHaveBeenCalledWith(
      "plugin-host:plugin-updated",
      expect.any(Function),
    );
    const pluginUpdatedHandler = listeners.get("plugin-host:plugin-updated");
    expect(pluginUpdatedHandler).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
    pluginUpdatedHandler!(null);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /** 가드: 기존 두 채널(EV_HOST_UPDATED·EV_SETTINGS_CHANGED_LOCAL)도 여전히 같은 핸들러로
   * 간다 — 이번 추가가 기존 구독을 대체한 것이 아니라 하나 더한 것임을 확인한다. */
  it("still invokes the handler for EV_HOST_UPDATED and EV_SETTINGS_CHANGED_LOCAL", async () => {
    const bootstrapSettings = await freshBootstrap();
    await bootstrapSettings(document.createElement("div"));
    const deps = capturedDeps!;
    const handler = vi.fn();
    deps.onThemeUpdated(handler);

    listeners.get("plugin-host:updated")!(null);
    listeners.get("settings-changed-local")!(null);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
