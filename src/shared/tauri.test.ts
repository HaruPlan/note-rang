/**
 * IPC 래퍼 가드 — 새 플러그인 설치/재조정 래퍼가 올바른 커맨드 이름·인자 형태로
 * invoke를 부르는지 고정한다(백엔드 커맨드 시그니처와의 계약).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri 런타임 없는 테스트 환경 — invoke만 스파이로 대체한다(응답 타입은 케이스별 주입).
const invoke = vi.fn(async (): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
// 앱 버전은 invoke가 아니라 전용 플러그인 API로 온다 — 응답을 케이스별로 주입한다.
const version = vi.fn(async (): Promise<unknown> => "1.2.3");
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => version() }));

import {
  cancelPluginInstall,
  confirmPluginInstall,
  dismissMissingPlugin,
  ensurePluginHost,
  fetchPluginForInstall,
  getAllBuiltinStorage,
  getAllPluginStorage,
  getAppVersion,
  getBuiltinStorage,
  getPanelSort,
  getPluginStorage,
  getStartupNoActiveAction,
  listLanguagePacks,
  listMissingPlugins,
  listRejectedPlugins,
  noteSetFavorite,
  readLocaleEntries,
  readPluginReadme,
  removeBuiltinStorage,
  removePlugin,
  removePluginStorage,
  saveWindowGeometry,
  setBuiltinStorage,
  setDevPlugin,
  setNoteCollapsed,
  setPanelSort,
  setPluginPendingReserved,
  setPluginStorage,
  setStartupNoActiveAction,
  summonNote,
  type RejectedPlugin,
} from "./tauri";

beforeEach(() => invoke.mockClear());

describe("plugin install IPC wrappers", () => {
  /** 가드: fetch가 스펙 객체를 spec 인자로 그대로 넘긴다(백엔드 InstallSpec 계약). */
  it("fetchPluginForInstall sends the spec as-is", async () => {
    await fetchPluginForInstall({
      kind: "git",
      location: "https://x/r.git",
      git_ref: "v1",
    });
    expect(invoke).toHaveBeenCalledWith("fetch_plugin_for_install", {
      spec: { kind: "git", location: "https://x/r.git", git_ref: "v1" },
    });
  });

  /** 가드(축 2): locale을 주면 그대로, 생략하면 null로 넘긴다(백엔드 `Option<String>` 계약 —
   *  `undefined`는 IPC 경계에서 필드 자체가 사라질 수 있어 `null`로 명시한다). */
  it("readPluginReadme forwards the optional locale as null when omitted", async () => {
    await readPluginReadme("x");
    expect(invoke).toHaveBeenCalledWith("read_plugin_readme", {
      id: "x",
      locale: null,
    });
    await readPluginReadme("x", "en");
    expect(invoke).toHaveBeenCalledWith("read_plugin_readme", {
      id: "x",
      locale: "en",
    });
  });

  /** 가드: confirm/cancel이 스테이징 토큰(+부여 목록)을 넘긴다. */
  it("confirm and cancel pass the staging token", async () => {
    await confirmPluginInstall("tok", ["notes:read"]);
    expect(invoke).toHaveBeenCalledWith("confirm_plugin_install", {
      staging: "tok",
      granted: ["notes:read"],
    });
    await cancelPluginInstall("tok");
    expect(invoke).toHaveBeenCalledWith("cancel_plugin_install", {
      staging: "tok",
    });
  });

  /** 가드: 재조정 목록/무시/제거 래퍼의 커맨드 이름·인자 형태를 고정한다. */
  it("reconcile wrappers use the right commands", async () => {
    await listMissingPlugins();
    expect(invoke).toHaveBeenCalledWith("list_missing_plugins");
    await dismissMissingPlugin("ghost");
    expect(invoke).toHaveBeenCalledWith("dismiss_missing_plugin", {
      id: "ghost",
    });
    await removePlugin("p");
    expect(invoke).toHaveBeenCalledWith("remove_plugin", { id: "p" });
  });

  /** 가드: 호스트 보장 래퍼 — ensure_plugin_host를 부르고, 비-true 응답(테스트 목의
   * null 등)을 false로 좁힌다(호출자가 즉시 폴백하도록). */
  it("ensurePluginHost calls the command and coerces non-true to false", async () => {
    invoke.mockResolvedValueOnce(null); // Tauri 밖(목) 환경의 기본 응답
    await expect(ensurePluginHost()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("ensure_plugin_host");

    invoke.mockResolvedValueOnce(true);
    await expect(ensurePluginHost()).resolves.toBe(true);
  });

  /** 가드: 개발자 모드 토글이 id를 그대로 넘기고, 끌 때는 null을 보낸다(백엔드
   * `Option<String>` 계약 — 감시 해제 신호). */
  it("setDevPlugin sends the plugin id, and null to turn it off", async () => {
    await setDevPlugin("my-plugin");
    expect(invoke).toHaveBeenCalledWith("set_dev_plugin", { id: "my-plugin" });
    await setDevPlugin(null);
    expect(invoke).toHaveBeenCalledWith("set_dev_plugin", { id: null });
  });
});

describe("scan-reject and pending-reserved IPC wrappers ", () => {
  /** 가드: 정상 배열 응답은 그대로 통과한다. */
  it("listRejectedPlugins passes through a well-formed array", async () => {
    const rejected: RejectedPlugin[] = [
      { dir_name: "broken", reason: "manifest.json을 읽을 수 없음" },
    ];
    invoke.mockResolvedValueOnce(rejected);
    await expect(listRejectedPlugins()).resolves.toEqual(rejected);
    expect(invoke).toHaveBeenCalledWith("list_rejected_plugins");
  });

  /** 가드(경계 정규화): 배열이 아닌 응답은 빈 배열로, 배열 안의 형태가 어긋난 항목(필드
   * 누락·타입 오류)은 개별적으로 걸러진다 — 형태가 어긋난 IPC 응답에 호스트가 죽지 않게. */
  it("listRejectedPlugins normalizes malformed responses", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(listRejectedPlugins()).resolves.toEqual([]);

    invoke.mockResolvedValueOnce([
      { dir_name: "ok", reason: "매니페스트 검증 실패: ..." },
      { dir_name: "no-reason" }, // reason 누락
      { reason: "id 누락" }, // dir_name 누락
      "just a string",
      null,
      42,
    ]);
    await expect(listRejectedPlugins()).resolves.toEqual([
      { dir_name: "ok", reason: "매니페스트 검증 실패: ..." },
    ]);
  });

  /**
   * 가드: 설치 언어팩 카탈로그 래퍼가 커맨드를 인자 없이 부르고 정상 배열을 그대로 통과시킨다.
   */
  it("listLanguagePacks passes through a well-formed catalog", async () => {
    const catalog = [
      { code: "xx", label: "Test Language", pluginId: "language-pack-xx" },
    ];
    invoke.mockResolvedValueOnce(catalog);
    await expect(listLanguagePacks()).resolves.toEqual(catalog);
    expect(invoke).toHaveBeenCalledWith("list_language_packs");
  });

  /**
   * 가드(경계 정규화 — 실제로 잡힌 결함): 이 두 래퍼는 **창 부트스트랩의 첫 페인트 전
   * 경로**에 있어서, 형태가 어긋난 응답이 그대로 새면 창이 통째로 뜨지 않는다
   * (`null.map(...)` / `Object.keys(null)`은 둘 다 던진다). 구버전 백엔드·목이 `null`을
   * 흘려도 "언어 하나가 빠질" 뿐이어야 한다.
   */
  it("language-pack wrappers normalize malformed responses", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(listLanguagePacks()).resolves.toEqual([]);

    invoke.mockResolvedValueOnce([
      { code: "xx", label: "Good", pluginId: "p" },
      { code: "yy", label: "no plugin id" }, // pluginId 누락
      { code: 7, label: "L", pluginId: "p" }, // code 타입 오류
      "just a string",
      null,
    ]);
    await expect(listLanguagePacks()).resolves.toEqual([
      { code: "xx", label: "Good", pluginId: "p" },
    ]);

    invoke.mockResolvedValueOnce(null);
    await expect(readLocaleEntries("xx")).resolves.toEqual({});
    invoke.mockResolvedValueOnce(["not", "a", "map"]);
    await expect(readLocaleEntries("xx")).resolves.toEqual({});
    // 값이 문자열이 아닌 키는 그 키만 버린다(사전 전체를 버리지 않는다).
    invoke.mockResolvedValueOnce({ keep: "ok", drop: 1, nested: {} });
    await expect(readLocaleEntries("xx")).resolves.toEqual({ keep: "ok" });
    expect(invoke).toHaveBeenCalledWith("read_locale_entries", {
      locale: "xx",
    });
  });

  /** 가드: pending-reserved 저장 래퍼가 id·권한 배열을 그대로 넘긴다. */
  it("setPluginPendingReserved sends id and pending as-is", async () => {
    await setPluginPendingReserved("p", ["network", "vault:read"]);
    expect(invoke).toHaveBeenCalledWith("set_plugin_pending_reserved", {
      id: "p",
      pending: ["network", "vault:read"],
    });
  });
});

/**
 * `memo.storage.local.*` IPC 바인딩 — 설치(사이드로드)/빌트인(번들) 양쪽이 커맨드
 * 이름·인자 형태로 분리돼 있는지 고정한다(백엔드가 두 네임스페이스를 별도 파일로
 * 격리하므로, 프론트도 반드시 대응하는 커맨드 짝을 정확히 불러야 격리가 실제로 성립한다).
 */
describe("plugin storage IPC wrappers", () => {
  it("installed-plugin wrappers call the *_plugin_storage commands", async () => {
    invoke.mockResolvedValueOnce(42);
    await expect(getPluginStorage("p", "k")).resolves.toBe(42);
    expect(invoke).toHaveBeenCalledWith("get_plugin_storage", {
      id: "p",
      key: "k",
    });

    await setPluginStorage("p", "k", { n: 1 });
    expect(invoke).toHaveBeenCalledWith("set_plugin_storage", {
      id: "p",
      key: "k",
      value: { n: 1 },
    });

    await removePluginStorage("p", "k");
    expect(invoke).toHaveBeenCalledWith("remove_plugin_storage", {
      id: "p",
      key: "k",
    });

    invoke.mockResolvedValueOnce({ a: 1 });
    await expect(getAllPluginStorage("p")).resolves.toEqual({ a: 1 });
    expect(invoke).toHaveBeenCalledWith("get_all_plugin_storage", {
      id: "p",
    });
  });

  it("builtin-plugin wrappers call the *_builtin_storage commands (separate from installed)", async () => {
    invoke.mockResolvedValueOnce("x");
    await expect(getBuiltinStorage("wikilink", "k")).resolves.toBe("x");
    expect(invoke).toHaveBeenCalledWith("get_builtin_storage", {
      id: "wikilink",
      key: "k",
    });

    await setBuiltinStorage("wikilink", "k", [1, 2]);
    expect(invoke).toHaveBeenCalledWith("set_builtin_storage", {
      id: "wikilink",
      key: "k",
      value: [1, 2],
    });

    await removeBuiltinStorage("wikilink", "k");
    expect(invoke).toHaveBeenCalledWith("remove_builtin_storage", {
      id: "wikilink",
      key: "k",
    });

    invoke.mockResolvedValueOnce({});
    await expect(getAllBuiltinStorage("wikilink")).resolves.toEqual({});
    expect(invoke).toHaveBeenCalledWith("get_all_builtin_storage", {
      id: "wikilink",
    });
  });
});

/**
 * 리사이즈 경로(창 이동/리사이즈·접기)가 fire-and-forget(`void`)으로 부르는 지오메트리 IPC —
 * 거부해도 처리되지 않은 프라미스 거부가 되지 않는지 고정한다. 흡수하지 않으면 노트가 삭제·
 * 보관되는 중이거나 파일이 잠깐 잠긴 경우의 거부가 노트창 전역 오류 오버레이
 * (`note-window.ts`의 `installNoteErrorOverlay`)를 리사이즈 한 번만으로 띄운다(실사용 오탐).
 */
describe("resize-path geometry IPC wrappers absorb rejections", () => {
  /** 가드(핵심): saveWindowGeometry는 백엔드 거부를 콘솔 경고로 남기고 resolve한다. */
  it("saveWindowGeometry logs and resolves instead of rejecting", async () => {
    invoke.mockRejectedValueOnce(new Error("메타 없음"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(saveWindowGeometry("n1")).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith("save_window_geometry", { id: "n1" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /** 가드(핵심): setNoteCollapsed도 같은 이유로 거부를 흡수한다. */
  it("setNoteCollapsed logs and resolves instead of rejecting", async () => {
    invoke.mockRejectedValueOnce(new Error("잠금 실패"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(setNoteCollapsed("n1", true)).resolves.toBeUndefined();
      expect(invoke).toHaveBeenCalledWith("set_note_collapsed", {
        id: "n1",
        collapsed: true,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /** 가드: 성공 경로는 그대로 조용히 resolve한다(경고를 남기지 않는다). */
  it("does not warn on the success path", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(saveWindowGeometry("n1")).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 앱 버전은 두 소비처가 함께 읽는다 — `memo.runtime.info().hostVersion`(플러그인 계약)과
 * 매니페스트 `minHostVersion` 경고. 둘 다 "모른다"를 빈 문자열로 약속하므로, 정규화가
 * 이 한 곳에서 끝나야 한다(각 호출부가 따로 방어하면 한쪽만 빠진다).
 */
describe("getAppVersion ", () => {
  /** 가드: 정상 응답은 그대로 통과한다. */
  it("passes a string version through", async () => {
    version.mockResolvedValueOnce("0.1.0");
    await expect(getAppVersion()).resolves.toBe("0.1.0");
  });

  /** 가드: 이 커맨드를 모르는 런타임(구버전 백엔드·e2e 목)은 null을 준다 — 빈 문자열로
   * 좁힌다. 그대로 흘리면 `runtime.info().hostVersion`이 선언 타입과 어긋난다. */
  it("normalizes a non-string response to an empty string", async () => {
    version.mockResolvedValueOnce(null);
    await expect(getAppVersion()).resolves.toBe("");
  });

  /** 가드: 거부도 빈 문자열이다(지어낸 버전을 주지 않는다 — "모른다"가 정답). */
  it("falls back to an empty string when the call rejects", async () => {
    version.mockRejectedValueOnce(new Error("nope"));
    await expect(getAppVersion()).resolves.toBe("");
  });
});

/**
 * 즐겨찾기·정렬 IPC 래퍼 — 커맨드 이름과 인자 형태(camelCase)를 백엔드 시그니처에 못 박는다.
 * 프론트와 Rust를 서로 다른 작업 단위가 동시에 구현하는 계약이라, 이름 하나만 어긋나도
 * 런타임에서야 "커맨드 없음"으로 터진다.
 */
describe("즐겨찾기·패널 정렬 IPC 래퍼", () => {
  /** 가드: id·favorite을 그대로 넘긴다. */
  it("noteSetFavorite sends the id and the new flag", async () => {
    await noteSetFavorite("n1", true);
    expect(invoke).toHaveBeenCalledWith("note_set_favorite", {
      id: "n1",
      favorite: true,
    });
  });

  /**
   * 가드(핵심): 즐겨찾기 성공은 `notes-list-changed`를 **프론트에서** 방송한다 —
   * `noteArchive`와 같은 관례이고, 백엔드 `note_set_favorite`은 emit하지 않는다.
   * 양쪽이 다 내면 같은 신호가 중복 방송돼 패널·트레이가 목록을 두 번씩 다시 읽는다.
   */
  it("noteSetFavorite broadcasts notes-list-changed from the front on success", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    (emit as unknown as { mockClear: () => void }).mockClear();
    await noteSetFavorite("n1", false);
    expect(emit).toHaveBeenCalledWith("notes-list-changed");
  });

  /** 가드: 실패면 신호를 내지 않는다(목록이 실제로 안 바뀌었으니 헛수고로 다시 읽을 이유가 없다). */
  it("noteSetFavorite does not broadcast when the call rejects", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    (emit as unknown as { mockClear: () => void }).mockClear();
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(noteSetFavorite("n1", true)).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  /** 가드: 정렬 조회는 인자가 없고, 저장은 `sort` 한 개다(백엔드는 의미를 모르고 왕복만 한다). */
  it("panel sort wrappers use the right commands and argument shape", async () => {
    await getPanelSort();
    expect(invoke).toHaveBeenCalledWith("get_panel_sort");
    await setPanelSort("title-asc");
    expect(invoke).toHaveBeenCalledWith("set_panel_sort", {
      sort: "title-asc",
    });
  });

  /**
   * 가드: 활성 노트 0개 시작 동작 조회는 인자가 없고, 저장은 `action` 한 개다. 백엔드가
   * 어휘("panel"/"new-note")를 검증하므로 프론트는 값을 그대로 실어 나른다.
   */
  it("startup no-active-action wrappers use the right commands and argument shape", async () => {
    await getStartupNoActiveAction();
    expect(invoke).toHaveBeenCalledWith("get_startup_no_active_action");
    await setStartupNoActiveAction("new-note");
    expect(invoke).toHaveBeenCalledWith("set_startup_no_active_action", {
      action: "new-note",
    });
  });
});

/**
 * 소환(`summon_note`)은 백엔드에서 `opened_at`을 갱신한다(D10) — 즉 **목록 정렬이 바뀌는
 * 변경**이다. 백엔드가 내는 신호는 새 창을 만들 때(그것도 Windows 한정)뿐이라, 이미 열려
 * 있는 노트를 다시 소환하면 패널의 「최근 연 순」이 그 자리에서 갱신되지 않았다.
 */
describe("summonNote — opened_at 변경을 목록 신호로 알린다", () => {
  /** 가드: 커맨드 이름·인자는 그대로다(기존 계약). */
  it("sends the note id", async () => {
    await summonNote("n1");
    expect(invoke).toHaveBeenCalledWith("summon_note", { id: "n1" });
  });

  /** 가드(핵심): 성공하면 notes-list-changed를 방송한다 — 「최근 연 순」이 클릭 직후 반영된다. */
  it("broadcasts notes-list-changed on success", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    (emit as unknown as { mockClear: () => void }).mockClear();
    await summonNote("n1");
    expect(emit).toHaveBeenCalledWith("notes-list-changed");
  });

  /** 가드: 실패면 방송하지 않는다(열리지 않았으니 opened_at도 안 바뀌었다). */
  it("does not broadcast when the call rejects", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    (emit as unknown as { mockClear: () => void }).mockClear();
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(summonNote("n1")).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
