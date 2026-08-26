/**
 * 중앙 호스트 가드 — 샌드박스 1회 실행(창 수와 무관), 게이트키퍼 강제, 스냅샷 수집,
 * 창-스코프 호출 위임, notes-reload 재빌드.
 *
 * jsdom에서는 iframe 스크립트가 실행되지 않으므로 샌드박스 팩토리를 가짜로 주입한다 —
 * 팩토리 호출 수가 곧 "샌드박스 생성 수"다(실제 iframe 개수는 e2e가 검증).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mountPluginHost } from "./central-host";
import {
  EV_BUTTON_INVOKE,
  EV_HOST_PLUGIN_UPDATED,
  EV_HOST_UPDATED,
  EV_NOTE_RESTORED,
  EV_NOTES_RELOAD,
  EV_PLUGIN_DEV_RELOAD,
  EV_PLUGIN_EVENT,
  EV_PLUGIN_SETTING_CHANGED,
  EV_SNAPSHOT,
  EV_SNAPSHOT_GET,
  EV_TRAY_INVOKE,
  EV_WINDOW_CALL,
  EV_WINDOW_RESULT,
  type HostEventBus,
  type HostPluginUpdatedPayload,
  type HostUpdatedPayload,
  type HostSnapshot,
  type SnapshotPayload,
  type TrayItemDescriptor,
  type WindowCallPayload,
} from "./host-protocol";
import {
  installedSourceFromRecord,
  type InstalledPluginSource,
} from "./loader";
import type { BridgeResponse } from "./host";
import {
  EV_DIAGNOSTICS,
  EV_DIAGNOSTICS_GET,
  type DiagnosticsPayload,
  type PluginDiagnostic,
} from "./diagnostics";
import type { SandboxDiagnostic } from "./sandbox";
import type { InstalledPlugin, PluginSettingField } from "../shared/tauri";
import { SJ_D } from "../theme/theme";

/** 로컬 이벤트 버스(동기 배달) — Tauri 전역 이벤트의 테스트 대역. */
function makeLocalBus(): HostEventBus {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  return {
    emit: (event, payload) => {
      for (const h of [...(listeners.get(event) ?? [])]) h(payload);
    },
    listen: (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
  };
}

/** 게이트키퍼로 감싼 브리지 실행기 형태(팩토리가 받는 execute).
 * 응답 형태는 손으로 베끼지 않고 게이트키퍼의 [`BridgeResponse`]를 그대로 쓴다 — 예전엔
 * 복사본이라 `code` 필드가 빠져 테스트가 그 필드를 못 보고 지나쳤다. */
type BridgeExec = (
  call: string,
  args: Record<string, unknown>,
  ctx?: string,
) => Promise<BridgeResponse>;

/** 가짜 샌드박스 스크립트가 받는 실행 환경(브리지 호출 + 이 샌드박스의 ready 제어). */
interface FakeScriptApi {
  execute: BridgeExec;
  /**
   * 자동 ready 회신을 끈다(스크립트가 직접 [`sendReady`]를 부를 때까지 보류) — 부트스트랩이
   * "등록이 조용해질 때까지" ready를 미루는 실제 동작의 대역.
   */
  holdReady(): void;
  /** 이 샌드박스의 ready를 지금 회신한다(성공). 실제 부트스트랩의 sendReady() 대역. */
  sendReady(): void;
  /** 이 샌드박스의 ready를 실패로 회신한다(문법 오류·로드 실패 등). */
  failReady(error: string): void;
  /**
   * 샌드박스 **안에서** 난 실패를 호스트로 올린다(부트스트랩의 `type: "diagnostic"` 대역) —
   * 실제로는 onClick 예외·미처리 rejection이 이 길로 올라온다.
   */
  reportDiagnostic(entry: SandboxDiagnostic): void;
  /**
   * 파괴 직전 통지에 **회신하지 않게** 만든다 — 실제 부트스트랩에서 `onDispose` 핸들러가
   * 돌려준 프라미스가 상한 안에 정착하지 못한 경우의 대역.
   */
  holdDispose(): void;
}

/**
 * 가짜 샌드박스 팩토리 — 생성/정리/역호출을 기록하고, `scripts[code]`가 있으면 실행해
 * 플러그인 코드가 하는 브리지 호출을 흉내 낸다. execute 핸들을 code별로 보관해 테스트가
 * "런타임 브리지 호출"(버튼 onClick 등)을 직접 흉내 낼 수 있게 한다.
 *
 * ready 계약은 **실제 부트스트랩과 같은 순서**다: 스크립트 함수가 돌아왔다고 ready가 되는
 * 게 아니라, 스크립트가 `sendReady()`를 부를 때(기본값: 스크립트가 반환·해소된 직후)
 * 비로소 해소된다. 그래야 "등록이 ready보다 늦게 도착"하는 실제 유실 시나리오를 테스트가
 * 표현할 수 있다(스크립트가 직접 sendReady를 부르면 자동 회신은 하지 않는다).
 */
function makeFakeFactory(
  scripts: Record<string, (api: FakeScriptApi) => Promise<void> | void> = {},
) {
  const created: string[] = [];
  const disposed: string[] = [];
  /** 파괴 직전 통지를 받은 순서 — 실제 파괴(`disposed`)보다 먼저 와야 한다. */
  const disposeNotices: string[] = [];
  const invoked: {
    code: string;
    buttonId: string;
    token: string;
    payload?: unknown;
  }[] = [];
  const executes: Record<string, BridgeExec> = {};
  const factory = ((
    _doc: Document,
    code: string,
    execute: BridgeExec,
    onDiagnostic?: (entry: SandboxDiagnostic) => void,
  ) => {
    created.push(code);
    executes[code] = execute;
    let settle: () => void = () => {};
    let fail: (e: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let manual = false;
    let holdsDispose = false;
    const api: FakeScriptApi = {
      execute,
      holdDispose: () => {
        holdsDispose = true;
      },
      holdReady: () => {
        manual = true;
      },
      sendReady: () => {
        manual = true;
        settle();
      },
      failReady: (error: string) => {
        manual = true;
        fail(new Error(error));
      },
      reportDiagnostic: (entry: SandboxDiagnostic) => onDiagnostic?.(entry),
    };
    const script = scripts[code];
    // ready를 직접 관리하지 않는 스크립트는 즉시 등록만 하는 단순 플러그인 — 그 등록이
    // 끝난 시점에 자동으로 회신한다(부트스트랩의 "조용해지면 ready"에 해당).
    void Promise.resolve(script ? script(api) : undefined).then(
      () => {
        if (!manual) settle();
      },
      (e: unknown) => {
        if (!manual) fail(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return {
      ready,
      invoke: (buttonId: string, token: string, payload?: unknown) =>
        invoked.push({ code, buttonId, token, payload }),
      notifyDispose: (timeoutMs: number) => {
        disposeNotices.push(code);
        // 회신을 붙잡은 샌드박스는 상한이 끝나야 false로 풀린다(실제 부트스트랩과 같은 계약).
        if (!holdsDispose) return Promise.resolve(true);
        return new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), timeoutMs),
        );
      },
      dispose: () => disposed.push(code),
    };
  }) as never;
  return { factory, created, disposed, disposeNotices, invoked, executes };
}

/** 설치 소스 헬퍼(매니페스트 + 마커 코드 + 부여). */
/** 능력 등록 권한(이걸 선언하면 능력 플러그인이라 kind: "capability"가 필요하다 — 엄격). */
const CAPABILITY_PERMS = [
  "theme",
  "background",
  "font",
  "window-control",
  "i18n",
];

const src = (
  id: string,
  permissions: string[],
  granted: string[],
  code: string,
  settings?: Record<string, unknown>,
  /** 매니페스트 설정 스키마(기본값 병합·구조화 변환의 기준). */
  schema?: PluginSettingField[],
): InstalledPluginSource => ({
  manifest: {
    id,
    name: id,
    version: "1.0.0",
    entry: "main.js",
    permissions,
    // 능력 권한을 선언한 픽스처는 능력 플러그인이다 — kind 게이트(엄격)를 통과하도록
    // kind: "capability"를 함께 싣는다(실제 번들 테마·배경·폰트 매니페스트와 같다).
    ...(permissions.some((p) => CAPABILITY_PERMS.includes(p))
      ? { kind: "capability" as const }
      : {}),
    ...(schema ? { settings: schema } : {}),
  },
  code,
  granted,
  settings,
});

/** 진단 기록을 버스로 조회한다(설정 창이 하는 것과 같은 요청/응답). */
function requestDiagnostics(
  bus: HostEventBus,
  requestId = "d1",
): PluginDiagnostic[] {
  let got: PluginDiagnostic[] | null = null;
  const unlisten = bus.listen(EV_DIAGNOSTICS, (p) => {
    const payload = p as DiagnosticsPayload;
    if (payload.requestId === requestId) got = payload.diagnostics;
  });
  bus.emit(EV_DIAGNOSTICS_GET, { requestId });
  unlisten();
  if (!got) throw new Error("진단 응답 없음");
  return got;
}

/** mountPluginHost 기본 의존성(테마 미발견 → 테마 샌드박스 0개, 번들 없음). */
function makeDeps(
  over: Partial<Parameters<typeof mountPluginHost>[0]> = {},
): Parameters<typeof mountPluginHost>[0] {
  return {
    doc: document,
    bus: makeLocalBus(),
    builtinStates: async () => ({}),
    builtinSettings: async () => ({}),
    enabledInstalledSources: async () => [],
    allInstalledSources: async () => [],
    activeThemeName: async () => "그런-테마-없음",
    persistBuiltinSetting: vi.fn(),
    persistPluginSetting: vi.fn(),
    // 트레이 배달 기본은 no-op — 테스트가 Tauri `set_plugin_tray_items` 커맨드를 타지 않게
    // 한다(배달을 검사하는 테스트는 `over`로 캡처 함수를 주입한다).
    setTrayItems: () => {},
    builtins: [],
    ...over,
  };
}

/** 현재 스냅샷을 요청해 받아온다(동기 버스라 즉시 응답). */
function requestSnapshot(bus: HostEventBus, requestId = "t1"): HostSnapshot {
  let got: HostSnapshot | null = null;
  const unlisten = bus.listen(EV_SNAPSHOT, (p) => {
    const payload = p as SnapshotPayload;
    if (payload.requestId === requestId) got = payload.snapshot;
  });
  bus.emit(EV_SNAPSHOT_GET, { requestId });
  unlisten();
  if (!got) throw new Error("스냅샷 응답 없음");
  return got;
}

describe("mountPluginHost — 샌드박스 수(성능 계약)", () => {
  /** 가드(핵심): 플러그인 M개 → 샌드박스 정확히 M개. 스냅샷 요청(=노트 창 열림)이 아무리
   * 반복돼도 샌드박스는 새로 생성되지 않는다. */
  it("creates one sandbox per plugin and none per snapshot request", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["editor"], [], "P1"),
        src("p2", ["editor"], [], "P2"),
        src("p3", ["editor"], [], "P3"),
      ],
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["P1", "P2", "P3"]); // M=3 → 3개

    // 노트 창 5개가 열리는 상황 = 스냅샷 요청 5회 — 생성 수는 그대로다.
    for (let i = 0; i < 5; i++) requestSnapshot(deps.bus, `w${i}`);
    expect(fake.created).toHaveLength(3);
    expect(fake.disposed).toHaveLength(0); // 상주 소유(정리도 없음)
  });

  /** 가드: 활성 테마가 해석되면 테마 샌드박스는 1회 실행 후 즉시 정리된다(상주 아님). */
  it("runs the active theme once and disposes it", async () => {
    const fake = makeFakeFactory({
      THEME: async ({ execute }) => {
        await execute("theme.register", { tokens: { accent: "#111111" } });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      allInstalledSources: async () => [
        src("my-theme", ["theme"], ["theme"], "THEME"),
      ],
      activeThemeName: async () => "my-theme",
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["THEME"]);
    expect(fake.disposed).toEqual(["THEME"]); // 일시 실행 — 소유 목록에 남지 않는다.
    expect(requestSnapshot(deps.bus).theme.tokens).toEqual({
      accent: "#111111",
    });
  });

  /** 가드: 꺼진 번들은 샌드박스를 만들지 않는다(loadBuiltinPlugins 시절 가드 계승). */
  it("does not create sandboxes for disabled builtins", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "wikilink",
          name: "위키링크",
          version: "1.0.0",
          permissions: ["editor"],
          code: "B1",
          readme: "테스트용 합성 번들",
        },
      ],
      builtinStates: async () => ({ wikilink: false }),
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual([]); // 비활성 번들 미실행
  });

  /** 가드: 현재 OS 미지원 번들은 실행하지 않는다(자동 비활성화 — 스냅샷에서 제외). */
  it("does not create sandboxes for builtins unsupported on the current OS", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "transparency",
          name: "투명도",
          version: "1.0.0",
          permissions: ["ui"],
          platforms: ["macos"],
          code: "B1",
          readme: "macOS 전용 합성 번들",
        },
      ],
      platform: async () => "windows",
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual([]); // 미지원 OS 번들 미실행
  });

  /** 가드: 지원 OS이면 platforms 선언 번들도 정상 실행된다. */
  it("runs a platform-restricted builtin on its supported OS", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "transparency",
          name: "투명도",
          version: "1.0.0",
          permissions: ["ui"],
          platforms: ["macos"],
          code: "B1",
          readme: "macOS 전용 합성 번들",
        },
      ],
      platform: async () => "macos",
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["B1"]); // 지원 OS에서 실행
  });
});

describe("mountPluginHost — 스냅샷 수집·게이트", () => {
  /** 가드: 등록 디스크립터(패턴·버튼)가 플러그인별 스냅샷으로 수집되고 grant는
   * 선언∩부여로 좁혀진 채 실린다(노트 창의 임베드·데이터 서비스 게이트 재료). */
  it("collects descriptors per plugin with narrowed grants", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("editor.registerInlinePattern", {
          id: "wl",
          open: "[[",
          close: "]]",
          className: "cm-wikilink",
        });
        await execute("ui.addToolbarButton", {
          id: "b",
          label: "B",
          position: "bottom-left",
          buttonId: "cb1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        // notes:read는 선언+부여, windows는 부여했지만 미선언(→ 제거돼야 함).
        src(
          "p1",
          ["editor", "ui", "notes:read"],
          ["notes:read", "windows"],
          "P1",
        ),
      ],
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    expect(snap.plugins).toHaveLength(1);
    const p = snap.plugins[0];
    expect(p.pluginId).toBe("p1");
    expect(p.patterns[0]?.open).toBe("[[");
    expect(p.buttons[0]).toEqual({
      id: "b",
      label: "B",
      title: undefined,
      position: "bottom-left",
      buttonId: "cb1",
    });
    expect(p.grant.granted).toEqual(["notes:read"]); // 미선언 windows 부여 제거
  });

  /** 가드: 상태 표시형 아이템(ui.addStatusItem)이 버튼과 **별도 배열**(statusItems)로
   * 수집된다 — 버튼(buttons)에 섞이지 않아야 노트 툴바가 유령 버튼을 그리지 않는다. 초기
   * 텍스트만 실리고(창별 라이브 값은 창-스코프 갱신이 나른다), 같은 id 재등록은 치환이다. */
  it("collects status items separately and upserts by id ", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addStatusItem", {
          id: "wc",
          text: "0 단어",
          title: "단어 수",
          position: "bottom-right",
        });
        // 같은 id 재등록 = 치환(추가 아님 — 항목 전체를 새로 쓴다, 버튼 upsert와 같은 계약).
        await execute("ui.addStatusItem", {
          id: "wc",
          text: "치환됨",
          position: "bottom-right",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    const p = requestSnapshot(deps.bus).plugins[0];
    // 상태 아이템은 버튼 배열에 섞이지 않는다.
    expect(p.buttons).toEqual([]);
    expect(p.statusItems).toEqual([
      { id: "wc", text: "치환됨", title: undefined, position: "bottom-right" },
    ]);
  });

  /** 가드(클릭 확장): onClick 없이 등록한 상태 아이템은 buttonId가 스냅샷에 없다(기존
   * 동작 그대로 — 순수 텍스트). onClick$id를 준 상태 아이템은 buttonId로 실리고, 버튼과
   * 완전히 같은 EV_BUTTON_INVOKE 경로로 그 샌드박스의 핸들러가 역호출된다(word-count의
   * "N 단어" 클릭 복사가 타는 경로). */
  it("wires onClick for status items through the same invoke path as buttons ", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        // onClick 없음 — buttonId가 실리지 않는다(순수 텍스트 상태 아이템, 기존 동작).
        await execute("ui.addStatusItem", {
          id: "plain",
          text: "0 단어",
          position: "bottom-right",
        });
        // onClick 있음 — 부트스트랩이 이미 onClick$id로 바꿔 보낸 것을 흉내낸다(하니스는
        // 부트스트랩을 거치지 않으므로 직접 그 필드로 execute한다).
        await execute("ui.addStatusItem", {
          id: "clickable",
          text: "3 단어",
          position: "bottom-right",
          onClick$id: "h:wc1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    const p = requestSnapshot(deps.bus).plugins[0];
    const plain = p.statusItems?.find((s) => s.id === "plain");
    const clickable = p.statusItems?.find((s) => s.id === "clickable");
    expect(plain?.buttonId).toBeUndefined();
    expect(clickable?.buttonId).toBe("h:wc1");

    // 노트 창에서 이 상태 아이템을 클릭하면(버튼과 같은 채널) 그 샌드박스의 핸들러가
    // buttonId로 역호출된다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "h:wc1",
      windowLabel: "note-a",
    });
    expect(fake.invoked).toMatchObject([{ code: "P1", buttonId: "h:wc1" }]);
  });

  /** 가드: 메뉴바 트레이 항목(ui.addTrayItem)이 스냅샷의 **별도 배열**(trayItems)로
   * 수집되고 버튼에 섞이지 않는다(id·label만 실림 — handlerId는 실리지 않는다). 같은 id
   * 재등록은 치환이다(버튼·명령과 같은 계약). */
  it("collects tray items separately and upserts by id ", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "hide",
          label: "모두 숨기기",
          run$id: "h:1",
        });
        // 같은 id 재등록 = 치환(추가 아님).
        await execute("ui.addTrayItem", {
          id: "hide",
          label: "치환됨",
          run$id: "h:1b",
        });
        await execute("ui.addTrayItem", {
          id: "show",
          label: "모두 보기",
          run$id: "h:2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    const p = requestSnapshot(deps.bus).plugins[0];
    expect(p.buttons).toEqual([]);
    expect(p.trayItems).toEqual([
      { id: "hide", label: "치환됨" },
      { id: "show", label: "모두 보기" },
    ]);
  });

  /** 가드: run 없는(=핸들러 없는) 트레이 등록은 INVALID_ARGS로 거부돼 수집되지 않는다 —
   * 눌러도 아무 일이 안 일어나는 유령 항목을 만들지 않는다. 여기서는 run$id를 비워(부트스트랩이
   * run 함수를 못 받은 상태) 거부를 확인한다. */
  it("rejects tray items without a run handler ", async () => {
    let res: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        // run$id 없음 = run 함수 없음(게이트키퍼가 BridgeResponse로 거부를 회신한다).
        res = (await execute("ui.addTrayItem", {
          label: "라벨만",
        })) as BridgeResponse;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(res).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(requestSnapshot(deps.bus).plugins[0].trayItems).toEqual([]);
  });

  /** 가드: 빈 label은 INVALID_ARGS(트레이에 보일 유일한 문자열이라 폴백이 없다). */
  it("rejects tray items with an empty label ", async () => {
    let res: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        res = (await execute("ui.addTrayItem", {
          run$id: "h:1",
          label: "   ",
        })) as BridgeResponse;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(res).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(requestSnapshot(deps.bus).plugins[0].trayItems).toEqual([]);
  });

  /** 가드: 트레이 항목을 등록하려면 `ui` 권한이 필요하다 — 미선언이면 게이트키퍼가
   * PERMISSION_UNDECLARED로 거부하고 수집되지 않는다(저위험이지만 선언은 요구한다). */
  it("gates tray item registration behind the ui permission ", async () => {
    let res: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        res = (await execute("ui.addTrayItem", {
          run$id: "h:1",
          label: "무권한",
        })) as BridgeResponse;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      // ui 권한 미선언(빈 권한).
      enabledInstalledSources: async () => [src("p1", [], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(res).toMatchObject({ ok: false, code: "PERMISSION_UNDECLARED" });
    expect(requestSnapshot(deps.bus).plugins[0].trayItems).toEqual([]);
  });

  /** 가드: 빌드마다 전 플러그인의 트레이 항목을 **평탄화(pluginId 포함)**해 네이티브로
   * 배달한다 — 수집 순서(스냅샷 plugins 순서)를 그대로 유지한다. 이 목록이 네이티브 트레이의
   * 「플러그인」 섹션이 된다. */
  it("delivers a flattened tray list to native on build ", async () => {
    const deliveries: TrayItemDescriptor[][] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "a",
          label: "P1-A",
          run$id: "h:a",
        });
      },
      P2: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "b",
          label: "P2-B",
          run$id: "h:b",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui"], [], "P1"),
        src("p2", ["ui"], [], "P2"),
      ],
      setTrayItems: (items) => {
        deliveries.push(items);
      },
    });
    await mountPluginHost(deps);
    // 초기 빌드 1회 배달 — 두 플러그인의 항목이 pluginId와 함께 수집 순서대로 평탄화된다.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual([
      { pluginId: "p1", id: "a", label: "P1-A" },
      { pluginId: "p2", id: "b", label: "P2-B" },
    ]);
  });

  /** 가드: 트레이 항목이 하나도 없어도 **빈 목록을 배달**한다 — 플러그인을 끄면 그 항목이
   * 트레이에서 사라져야 하는데, 그 신호는 "이번 빌드의 전체 목록"뿐이라 빈 목록도 보내야 한다. */
  it("delivers an empty tray list when no plugin registers one ", async () => {
    const deliveries: TrayItemDescriptor[][] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addToolbarButton", {
          label: "b",
          position: "top-left",
          buttonId: "cb1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
      setTrayItems: (items) => {
        deliveries.push(items);
      },
    });
    await mountPluginHost(deps);
    expect(deliveries).toEqual([[]]);
  });

  /** 가드: 네이티브 트레이 클릭(EV_TRAY_INVOKE)이 그 플러그인의 트레이 `run` 핸들러를
   * **창 컨텍스트 없이**(빈 토큰) 역호출한다 — 트레이는 앱 전역 자원이라 창이 없다(설정 화면
   * 액션 버튼과 같은 계약). 모르는 id·pluginId는 조용히 무시된다. */
  it("routes a native tray click to the plugin's run handler with no window token ", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        // 부트스트랩이 run 함수를 run$id로 바꿔 실어 보낸 상태를 흉내낸다.
        await execute("ui.addTrayItem", {
          id: "hide",
          label: "숨기기",
          run$id: "h:tray",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);

    // 모르는 항목 클릭은 무시(역호출 0건).
    deps.bus.emit(EV_TRAY_INVOKE, { pluginId: "p1", trayItemId: "nope" });
    expect(fake.invoked).toHaveLength(0);

    // 실제 항목 클릭 → 그 핸들러를 빈 토큰(창 컨텍스트 없음)으로 역호출.
    deps.bus.emit(EV_TRAY_INVOKE, { pluginId: "p1", trayItemId: "hide" });
    expect(fake.invoked).toMatchObject([
      { code: "P1", buttonId: "h:tray", token: "", payload: {} },
    ]);
  });

  /** 가드: 배경 플러그인의 background.register가 스냅샷 상위 background로 집계된다. */
  it("aggregates a bundled plugin's background into the snapshot", async () => {
    const fake = makeFakeFactory({
      BG: async ({ execute }) => {
        await execute("background.register", {
          swatches: ["#111111", "#222222"],
          autoTextContrast: false,
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "background",
          name: "배경색",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["background"],
          code: "BG",
          readme: "테스트용 합성 배경 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).background).toEqual({
      swatches: ["#111111", "#222222"],
      autoTextContrast: false,
    });
  });

  /** 가드: 폰트 플러그인의 font.register가 스냅샷 상위 font로 집계된다(색·배경과 별개 능력). */
  it("aggregates a bundled plugin's font into the snapshot", async () => {
    const fake = makeFakeFactory({
      FONT: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "font",
          name: "폰트",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "FONT",
          readme: "테스트용 합성 폰트 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).font).toEqual({
      families: [{ label: "세리프", stack: "Georgia, serif" }],
    });
  });

  /** 가드: 폰트 플러그인이 여럿이면 후보를 합친다 — 빌트인을 끄지 않아도 외부 폰트가 붙는다. */
  it("merges font families from multiple font plugins", async () => {
    const fake = makeFakeFactory({
      FONT: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
      EXTRA: async ({ execute }) => {
        await execute("font.register", {
          families: [
            { label: "중복", stack: "Georgia, serif" },
            { label: "프리텐다드", stack: "Pretendard, sans-serif" },
          ],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "font",
          name: "폰트",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "FONT",
          readme: "테스트용 합성 폰트 번들",
        },
        {
          id: "font-extra",
          name: "폰트 더보기",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "EXTRA",
          readme: "테스트용 합성 추가 폰트 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    // 같은 스택(Georgia)은 먼저 등록한 쪽만 남고, 새 스택은 뒤에 붙는다.
    expect(requestSnapshot(deps.bus).font).toEqual({
      families: [
        { label: "세리프", stack: "Georgia, serif" },
        { label: "프리텐다드", stack: "Pretendard, sans-serif" },
      ],
    });
  });

  /** 가드: includeSystem을 켠 폰트 플러그인이 있으면 호스트가 설치 글꼴을 열거해 뒤에 붙인다. */
  it("appends enumerated system fonts when a plugin opts in", async () => {
    const fake = makeFakeFactory({
      FONT: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
          includeSystem: true,
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      systemFonts: () =>
        Promise.resolve([{ family: "Pretendard", korean: true }]),
      builtins: [
        {
          id: "font",
          name: "폰트",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "FONT",
          readme: "테스트용 합성 폰트 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    // 출처 표시(system·korean)는 호스트가 붙인다 — 피커가 구역을 나누는 근거.
    expect(requestSnapshot(deps.bus).font).toEqual({
      families: [
        { label: "세리프", stack: "Georgia, serif" },
        {
          label: "Pretendard",
          stack: '"Pretendard", sans-serif',
          korean: true,
          system: true,
        },
      ],
    });
  });

  /** 가드: includeSystem을 켠 플러그인이 없으면 열거를 아예 하지 않는다(불필요한 파일 IO 차단). */
  it("does not enumerate system fonts unless a plugin opts in", async () => {
    let calls = 0;
    const fake = makeFakeFactory({
      FONT: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      systemFonts: () => {
        calls += 1;
        return Promise.resolve([{ family: "Pretendard", korean: true }]);
      },
      builtins: [
        {
          id: "font",
          name: "폰트",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "FONT",
          readme: "테스트용 합성 폰트 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(calls).toBe(0);
    expect(requestSnapshot(deps.bus).font).toEqual({
      families: [{ label: "세리프", stack: "Georgia, serif" }],
    });
  });

  /** 가드: 열거가 실패해도 플러그인 공급 후보는 그대로 살아남는다(피커가 통째로 죽지 않게). */
  it("keeps plugin-supplied families when system enumeration fails", async () => {
    const fake = makeFakeFactory({
      FONT: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
          includeSystem: true,
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      systemFonts: () => Promise.reject(new Error("열거 실패")),
      builtins: [
        {
          id: "font",
          name: "폰트",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["font"],
          code: "FONT",
          readme: "테스트용 합성 폰트 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).font).toEqual({
      families: [{ label: "세리프", stack: "Georgia, serif" }],
    });
  });

  /** 가드: 창 기능 플러그인들의 window.register가 스냅샷 windowControls로 합쳐진다(합집합). */
  it("aggregates window controls from window-feature plugins (union)", async () => {
    const fake = makeFakeFactory({
      T: async ({ execute }) => {
        await execute("window.register", { controls: ["transparency"] });
      },
      A: async ({ execute }) => {
        await execute("window.register", { controls: ["always-on-top"] });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "transparency",
          name: "투명도",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["window-control"],
          code: "T",
          readme: "합성 번들",
        },
        {
          id: "always-on-top",
          name: "항상 위",
          version: "1.0.0",
          kind: "capability" as const,
          permissions: ["window-control"],
          code: "A",
          readme: "합성 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).windowControls.sort()).toEqual([
      "always-on-top",
      "transparency",
    ]);
  });

  /** 가드: 창 기능 플러그인이 없으면 windowControls는 빈 배열(툴바 창 컨트롤 없음). */
  it("leaves windowControls empty when no window-feature plugin is active", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({ createSandbox: fake.factory, builtins: [] });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).windowControls).toEqual([]);
  });

  /** 가드: 폰트 능력을 등록하는 플러그인이 없으면 스냅샷 font는 null(시스템 기본 폰트). */
  it("leaves snapshot font null when no plugin registers one", async () => {
    const fake = makeFakeFactory({
      P: async ({ execute }) => {
        await execute("editor.registerInlinePattern", {
          id: "x",
          open: "[[",
          close: "]]",
          className: "c",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "wikilink",
          name: "위키링크",
          version: "1.0.0",
          permissions: ["editor"],
          code: "P",
          readme: "합성 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).font).toBeNull();
  });

  /** 가드: 배경 능력을 등록하는 플러그인이 없으면 스냅샷 background는 null(🎨 없음). */
  it("leaves snapshot background null when no plugin registers one", async () => {
    const fake = makeFakeFactory({
      P: async ({ execute }) => {
        await execute("editor.registerInlinePattern", {
          id: "x",
          open: "[[",
          close: "]]",
          className: "c",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "wikilink",
          name: "위키링크",
          version: "1.0.0",
          permissions: ["editor"],
          code: "P",
          readme: "합성 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).background).toBeNull();
  });

  /** 가드(보안): 게이트키퍼가 호스트에서 강제된다 — 미선언 권한 호출은 거부되고
   * 스냅샷에 아무것도 남기지 않는다. */
  it("rejects undeclared bridge calls at the host gatekeeper", async () => {
    const responses: { ok: boolean }[] = [];
    const fake = makeFakeFactory({
      EVIL: async ({ execute }) => {
        responses.push(await execute("theme.register", { tokens: {} }));
        responses.push(await execute("ui.addToolbarButton", { buttonId: "x" }));
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("evil", ["editor"], [], "EVIL"), // theme·ui 미선언
      ],
    });
    await mountPluginHost(deps);
    expect(responses.every((r) => r.ok === false)).toBe(true);
    const snap = requestSnapshot(deps.bus);
    expect(snap.theme).toEqual(SJ_D); // 미선언 theme.register는 수집되지 않음
    expect(snap.plugins[0].buttons).toEqual([]);
  });

  /** 가드: settings.get/set은 호스트가 소유한 스냅샷에서 처리되고 set은 영속화를 부른다. */
  it("serves plugin settings host-locally and persists sets", async () => {
    const persistPluginSetting = vi.fn();
    const got: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        got.push((await execute("settings.get", { key: "tone" })).result);
        await execute("settings.set", { key: "tone", value: "loud" });
        got.push((await execute("settings.get", { key: "tone" })).result);
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      persistPluginSetting,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", { tone: "soft" }),
      ],
    });
    await mountPluginHost(deps);
    expect(got).toEqual(["soft", "loud"]); // set→get 일관성(호스트 로컬)
    expect(persistPluginSetting).toHaveBeenCalledWith("p1", "tone", "loud");
  });

  /**
   * 가드(배선 완결): **프로덕션이 만드는 것과 같은 소스**(백엔드 레코드 재구성)로 띄워도
   * 설치 플러그인의 설정 계약이 살아 있다.
   *
   * 왜 재구성을 거치나: 다른 테스트들은 스키마를 손으로 매니페스트에 주입해서, 재구성이
   * 스키마를 빠뜨린 배선 구멍을 통째로 지나쳤다 — 실제로 `settings.getAll()`이 설치
   * 플러그인에서만 영구히 `{}`였고 list 배열 변환도 죽어 있었다(번들은 멀쩡했다).
   */
  it("keeps the settings contract alive through the production reconstruction", async () => {
    const got: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        got.push((await execute("settings.getAll", {})).result);
        got.push((await execute("settings.get", { key: "tpls" })).result);
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        installedSourceFromRecord(
          {
            id: "third",
            name: "서드파티",
            version: "1.0.0",
            permissions: ["settings"],
            enabled: true,
            granted: [],
            settings_schema: [
              {
                key: "prefix",
                label: "접두",
                type: "text",
                options: [],
                default: "»",
              },
              { key: "tpls", label: "템플릿", type: "list", options: [] },
            ],
            settings: { tpls: "=== A ===\n본문" },
          },
          "P1",
        ),
      ],
    });
    await mountPluginHost(deps);
    // 선언 키가 전부 담기고 매니페스트 기본값이 런타임에 도달한다.
    expect(got[0]).toEqual({
      prefix: "»",
      tpls: [{ name: "A", body: "본문" }],
    });
    // list는 객체 인자 호출에서 구조화 배열로 온다.
    expect(got[1]).toEqual([{ name: "A", body: "본문" }]);
  });

  /** 가드: `list` 키는 객체 인자 `{ key }`로 읽으면 언제나 `{ name, body }[]` 구조화 배열로
   * 온다(문자열 축약형·`raw` 탈출구는 제거됐다 — 엄격). */
  it("reads list settings as a structured array via the object arg", async () => {
    const got: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        got.push((await execute("settings.get", { key: "tpls" })).result);
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", { tpls: "=== A ===\n본문" }, [
          { key: "tpls", label: "템플릿", type: "list", options: [] },
        ]),
      ],
    });
    await mountPluginHost(deps);
    expect(got[0]).toEqual([{ name: "A", body: "본문" }]);
  });
});

describe("mountPluginHost — 콜백 라우팅(창-스코프 위임)", () => {
  /** 가드: 버튼 클릭(EV_BUTTON_INVOKE)은 해당 샌드박스 onClick을 역호출하고, 이후의
   * 창-스코프 호출은 그 창으로 위임돼 결과가 샌드박스 응답으로 돌아온다. */
  it("routes window-scoped calls to the last invoking window", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "editor"], [], "P1"),
      ],
    });
    await mountPluginHost(deps);

    // 노트 창 역할: 자기 라벨의 창-스코프 호출을 받아 응답한다.
    const received: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      received.push(call);
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: 30,
      });
    });

    // note-a 창에서 버튼 클릭 → 컨텍스트 기록 + 샌드박스 역호출.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "cb1",
      windowLabel: "note-a",
    });
    expect(fake.invoked).toMatchObject([{ code: "P1", buttonId: "cb1" }]);

    // 샌드박스가 이어서 하는 창-스코프 호출은 note-a로 위임된다.
    const res = await fake.executes.P1("editor.getFontDelta", {});
    expect(res).toEqual({ ok: true, result: 30 });
    expect(received[0].windowLabel).toBe("note-a");
    expect(received[0].call).toBe("editor.getFontDelta");
  });

  /** 가드: 어떤 창도 이 플러그인을 호출한 적 없으면(컨텍스트 부재) 창-스코프 호출은
   * 위임 없이 무력 응답(null)한다 — 시작 시점 toast 등이 조용히 무시된다. */
  it("answers window-scoped calls with null when no window context exists", async () => {
    const fake = makeFakeFactory();
    const forwarded: unknown[] = [];
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.listen(EV_WINDOW_CALL, (p) => forwarded.push(p));
    const res = await fake.executes.P1("ui.toast", { title: "hi" });
    expect(res).toEqual({ ok: true, result: null });
    expect(forwarded).toEqual([]); // 어느 창으로도 위임되지 않음
  });

  /**
   * 가드(데이터 손상 회귀): 창 A의 팝업이 떠 있는 동안 창 B가 같은 버튼을 눌러도, A에서
   * 시작된 체인의 후속 호출은 전부 A로 간다. 실증된 유실 시퀀스(wc-1 A.pickList →
   * wc-2 B.pickList → wc-3 notes.current → wc-4 editor.insertText)를 그대로 재현한다 —
   * 예전엔 "마지막 클릭 창" 단일 슬롯이 B로 뒤집혀 A가 고른 템플릿이 B 본문에 삽입됐다.
   */
  it("keeps a chain started in window A on A even after B invokes the same button", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src(
          "template",
          ["ui", "notes:read", "notes:write"],
          ["notes:read", "notes:write"],
          "T",
        ),
      ],
    });
    await mountPluginHost(deps);

    // 노트 창 대역: pickList는 사용자 응답 대기(보류), 나머지는 즉시 회신.
    const seen: WindowCallPayload[] = [];
    const picks: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      seen.push(call);
      if (call.call === "ui.pickList") {
        picks.push(call);
        return;
      }
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: null,
      });
    });

    // wc-1: 창 A에서 클릭 → 토큰 A로 pickList(응답 대기).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "template",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const tokenA = fake.invoked[0].token;
    const pickA = fake.executes.T("ui.pickList", { title: "템플릿" }, tokenA);

    // wc-2: 창 B에서 같은 버튼 클릭 → 폴백 슬롯(마지막 클릭 창)은 B로 뒤집힌다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "template",
      buttonId: "b",
      windowLabel: "note-b",
    });
    const tokenB = fake.invoked[1].token;
    expect(tokenB).not.toBe(tokenA);
    void fake.executes.T("ui.pickList", { title: "템플릿" }, tokenB);

    // A의 선택이 회신되고, A의 체인(같은 토큰)이 이어진다: notes.current → insertText.
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: picks[0].requestId,
      ok: true,
      result: "0",
    });
    await pickA;
    await fake.executes.T("notes.current", {}, tokenA);
    await fake.executes.T("editor.insertText", { text: "TEMPLATE#0" }, tokenA);

    expect(picks.map((c) => c.windowLabel)).toEqual(["note-a", "note-b"]);
    expect(seen.find((c) => c.call === "notes.current")?.windowLabel).toBe(
      "note-a",
    );
    // 핵심: A가 고른 템플릿은 A의 본문에 들어간다(B로 새지 않는다).
    expect(seen.find((c) => c.call === "editor.insertText")?.windowLabel).toBe(
      "note-a",
    );
  });

  /**
   * 가드(회귀): 대화형 호출(pickList — 최대 10분 대기)이 떠 있는 동안 다른 창·다른
   * 플러그인에서 클릭이 상한(200) 넘게 쏟아져도 그 체인의 토큰은 폐기되지 않는다.
   *
   * 왜: 예전엔 전역 FIFO라 오래된 토큰부터 무조건 버렸다 — 사용자가 팝업을 띄워 놓고
   * 고민하는 사이 상한을 넘기면, 응답 후 이어지는 notes.current·editor.insertText가
   * "모르는 토큰"으로 무력화(null)돼 삽입이 아무 메시지 없이 사라졌다.
   */
  it("keeps an interactive chain's token alive past the invocation cap", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("t", ["ui", "notes:read", "notes:write"], ["notes:read"], "T"),
        src("other", ["ui"], [], "O"),
      ],
    });
    await mountPluginHost(deps);

    const seen: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      seen.push(call);
      if (call.call === "ui.pickList") return; // 사용자 응답 대기(보류)
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: null,
      });
    });

    // 창 A에서 클릭 → 그 토큰으로 pickList를 띄우고 응답을 기다린다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "t",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const tokenA = fake.invoked[0].token;
    const pickA = fake.executes.T("ui.pickList", { title: "템플릿" }, tokenA);

    // 그 사이 다른 창·다른 플러그인에서 클릭이 상한을 훌쩍 넘게 발생한다.
    for (let i = 0; i < 250; i++) {
      deps.bus.emit(EV_BUTTON_INVOKE, {
        pluginId: "other",
        buttonId: "x",
        windowLabel: "note-b",
      });
    }

    // 이제 사용자가 응답 → A의 체인이 이어진다(토큰이 살아 있어야 A로 간다).
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: seen[0].requestId,
      ok: true,
      result: "0",
    });
    await pickA;
    await fake.executes.T("notes.current", {}, tokenA);

    const current = seen.find((c) => c.call === "notes.current");
    expect(current?.windowLabel).toBe("note-a");
  });

  /** 가드(보안): 호스트가 발급하지 않은 컨텍스트 토큰은 폴백하지 않고 거부한다 —
   * 악성 플러그인이 토큰을 지어내 임의의 창을 타깃할 수 없다. */
  it("rejects window-scoped calls carrying an unknown context token", async () => {
    const fake = makeFakeFactory();
    const forwarded: unknown[] = [];
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    // 폴백 컨텍스트는 존재한다(창 A가 클릭한 적 있음) — 그래도 모르는 토큰은 거부다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    deps.bus.listen(EV_WINDOW_CALL, (p) => forwarded.push(p));

    const res = await fake.executes.P1("ui.toast", { title: "x" }, "inv-9999");
    expect(res).toEqual({ ok: true, result: null });
    expect(forwarded).toEqual([]); // 어느 창으로도 위임되지 않음(폴백조차 안 한다)
  });

  /** 가드(보안): 다른 플러그인에게 발급된 토큰도 거부한다(토큰 순번을 찍어 맞혀도 무효). */
  it("rejects a context token issued to another plugin", async () => {
    const fake = makeFakeFactory();
    const forwarded: unknown[] = [];
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui"], [], "P1"),
        src("p2", ["ui"], [], "P2"),
      ],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const tokenOfP1 = fake.invoked[0].token;
    deps.bus.listen(EV_WINDOW_CALL, (p) => forwarded.push(p));

    const res = await fake.executes.P2("ui.toast", { title: "x" }, tokenOfP1);
    expect(res).toEqual({ ok: true, result: null });
    expect(forwarded).toEqual([]);
  });

  /**
   * 가드(계약의 **실제 범위**): 클릭이 끝나도 토큰은 유휴 상한
   * (`INVOCATION_IDLE_TTL_MS`, 5분) 안에서는 계속 그 창을 가리킨다 — 저작 계약이 권장하는
   * 지연 사용(비동기 경계 뒤의 후속 호출)은 만료의 대상이 아니다. 창이 여러 개면 예전
   * 클릭들의 토큰을 각각 골라 쓸 수 있다는 사실도 그대로다(만료가 막는 것은 "유휴 상한을
   * 넘긴" 재사용뿐 — 아래 절의 테스트가 그 경계를 못박는다).
   */
  it("keeps issued tokens usable after their click ended (within idle TTL)", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "clipboard"], ["clipboard"], "P1"),
      ],
    });
    await mountPluginHost(deps);

    const seen: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      seen.push(call);
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: null,
      });
    });

    // 창 A·B에서 각각 한 번씩 클릭하고, 두 클릭 모두 그 자리에서 끝난다(응답 완료).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const tokenA = fake.invoked[0].token;
    await fake.executes.P1("ui.toast", { title: "a" }, tokenA);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-b",
    });
    const tokenB = fake.invoked[1].token;
    await fake.executes.P1("ui.toast", { title: "b" }, tokenB);

    // 클릭이 끝난 한참 뒤(아무 클릭도 진행 중이 아님) 두 토큰으로 각각 쓰기를 시도한다.
    seen.length = 0;
    await fake.executes.P1("clipboard.write", { text: "later-a" }, tokenA);
    await fake.executes.P1("clipboard.write", { text: "later-b" }, tokenB);
    expect(
      seen.map((c) => [c.windowLabel, (c.args as { text: string }).text]),
    ).toEqual([
      ["note-a", "later-a"],
      ["note-b", "later-b"],
    ]);
  });
});

describe("mountPluginHost — ready 계약·실패 노출", () => {
  afterEach(() => vi.restoreAllMocks());

  /** 가드: 등록이 스크립트 반환보다 늦게(비동기 체인에서) 도착해도, ready 전이면 스냅샷에
   * 실린다 — 번들 4개가 `settings.get(...).then(→ 등록)` 형태라 실제로 늦게 온다. */
  it("collects registrations that arrive after the script returns but before ready", async () => {
    const fake = makeFakeFactory({
      LATE: ({ execute, holdReady, sendReady }) => {
        holdReady();
        // 스크립트 함수는 즉시 반환하고, 등록은 몇 macrotask 뒤에 도착한다.
        void (async () => {
          await execute("settings.get", { key: "mode" });
          await new Promise((r) => setTimeout(r, 0));
          await execute("ui.addToolbarButton", {
            id: "late",
            label: "L",
            position: "bottom-left",
            buttonId: "cb-late",
          });
          sendReady();
        })();
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "settings"], [], "LATE"),
      ],
    });
    await mountPluginHost(deps);
    expect(
      requestSnapshot(deps.bus).plugins[0].buttons.map((b) => b.id),
    ).toEqual(["late"]);
  });

  /**
   * 가드: 같은 id로 두 번 등록하면 **append가 아니라 치환**이고, 그 사실이 진단에 남는다.
   *
   * 왜: 예전에는 두 건이 그대로 실렸다 — 노트 툴바에는 버튼 두 개가 뜨는데 배치 키
   * (`plugin:<id>:<버튼id>`)는 하나뿐이라, 「툴바 배치」에서는 한 항목으로만 잡혀 함께
   * 옮겨지고 함께 숨겨지며 단축키는 첫 버튼만 눌렀다(오류·진단·린트 경고 0건).
   */
  it("upserts toolbar buttons registered twice with the same id", async () => {
    const fake = makeFakeFactory({
      DUP: async ({ execute }) => {
        await execute("ui.addToolbarButton", {
          id: "b",
          label: "1",
          position: "bottom-left",
          buttonId: "h:1",
        });
        await execute("ui.addToolbarButton", {
          id: "other",
          label: "O",
          position: "bottom-left",
          buttonId: "h:2",
        });
        await execute("ui.addToolbarButton", {
          id: "b",
          label: "2",
          position: "top-right",
          buttonId: "h:3",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "DUP")],
    });
    await mountPluginHost(deps);
    const buttons = requestSnapshot(deps.bus).plugins[0].buttons;
    // 치환이지 append가 아니고, 치환은 **자리를 지킨다**(사용자 배치가 흔들리지 않게).
    expect(buttons.map((b) => `${b.id}:${b.label}:${b.buttonId}`)).toEqual([
      "b:2:h:3",
      "other:O:h:2",
    ]);
    const duplicates = requestDiagnostics(deps.bus).filter(
      (d) => d.kind === "duplicate-registration",
    );
    expect(duplicates.map((d) => d.call)).toEqual(["ui.addToolbarButton"]);
    expect(duplicates[0].message).toContain("b");
  });

  /** 가드: id를 생략해도 등록은 살고 호스트가 안정 id를 붙인다 — 예전에는 빈 문자열
   * id가 실려, 두 개를 그렇게 등록하면 배치 키가 통째로 겹쳤다. */
  it("assigns a generated id when the author omits it", async () => {
    const fake = makeFakeFactory({
      NOID: async ({ execute }) => {
        await execute("ui.addToolbarButton", {
          label: "A",
          position: "bottom-left",
          buttonId: "h:1",
        });
        await execute("ui.addToolbarButton", {
          label: "B",
          position: "bottom-left",
          buttonId: "h:2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "NOID")],
    });
    await mountPluginHost(deps);
    expect(
      requestSnapshot(deps.bus).plugins[0].buttons.map((b) => b.id),
    ).toEqual(["p1:ui.addToolbarButton:1", "p1:ui.addToolbarButton:2"]);
  });

  /**
   * 가드: `onClick`이 없는 버튼 등록은 거부된다(진단에 남는다).
   *
   * 왜: 부트스트랩은 `onClick` 함수를 핸들러 id(`buttonId`)로 바꿔 보낸다 — 없으면 빈
   * 문자열이 실려 버튼은 멀쩡히 렌더되는데 클릭이 샌드박스의 `handlers.get("")`에서
   * 조용히 끝난다(「최근 오류」에도 아무것도 안 남았다).
   */
  it("rejects a toolbar button without an onClick handler", async () => {
    const responses: { ok: boolean; code?: string }[] = [];
    const fake = makeFakeFactory({
      NOCLICK: async ({ execute }) => {
        responses.push(
          await execute("ui.addToolbarButton", {
            id: "dead",
            label: "X",
            position: "bottom-left",
          }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "NOCLICK")],
    });
    await mountPluginHost(deps);
    expect(responses[0].ok).toBe(false);
    expect(responses[0].code).toBe("INVALID_ARGS");
    expect(requestSnapshot(deps.bus).plugins[0].buttons).toEqual([]);
    expect(
      requestDiagnostics(deps.bus).map((d) => `${d.kind}:${d.code}`),
    ).toContain("call-reject:INVALID_ARGS");
  });

  /** 가드: 스냅샷은 ready 시점에 굳는다 — ready 이후 도착한 등록이 이미 배달된 스냅샷을
   * 몰래 바꾸지 못한다(관측된 스냅샷은 불변 값). */
  it("freezes collected buttons at ready", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    expect(snap.plugins[0].buttons).toEqual([]);

    await fake.executes.P1("ui.addToolbarButton", {
      id: "sneaky",
      label: "S",
      position: "bottom-left",
      buttonId: "cb-x",
    });
    expect(snap.plugins[0].buttons).toEqual([]); // 배달된 스냅샷은 그대로
  });

  /** 가드: 실행에 실패한 플러그인은 빈 껍데기로 plugins에 실리지 않고 failures에 사유와
   * 함께 남는다(+ 콘솔 오류) — 문법 오류가 조용히 "정상 0개"로 통과하지 않는다. */
  it("records a failed plugin in failures instead of plugins", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeFactory({
      BROKEN: ({ failReady }) => failReady("스크립트 실행 오류"),
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("broken", ["editor"], [], "BROKEN"),
        src("ok", ["editor"], [], "OK"),
      ],
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    expect(snap.plugins.map((p) => p.pluginId)).toEqual(["ok"]); // 빈 껍데기 없음
    expect(snap.failures).toEqual([
      { pluginId: "broken", error: "스크립트 실행 오류" },
    ]);
    expect(errors).toHaveBeenCalledWith(
      "[memo] 플러그인 로드 실패:",
      "broken",
      "스크립트 실행 오류",
    );
  });

  /**
   * 가드(침묵 제거): **매니페스트 검증에서** 탈락한 설치 플러그인도 failures에 사유와 함께
   * 남는다 — 샌드박스를 만들지도 않고 통째로 사라지던 경로다.
   *
   * 왜: 예전엔 `prepareInstalledPlugin`이 null이면 `continue`뿐이었다. 그래서 Rust 검증은
   * 통과해 **설치까지 된** 매니페스트가 TS 검증에서만 거부되면(두 검증기의 규칙이 어긋난
   * 경우) 그 플러그인의 툴바 버튼·패턴이 전부 사라지는데 ⚠ 배지도 「최근 오류」도 없었다 —
   * 사용자·저작자 모두 원인을 찾을 근거가 0이다. Rust 스캔 탈락에서 없앤 침묵과
   * 같은 종류다.
   */
  it("records a manifest-rejected plugin in failures instead of skipping it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("bad", ["그런권한없음"], [], "BAD"),
        src("ok", ["editor"], [], "OK"),
      ],
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    expect(fake.created).toEqual(["OK"]); // 검증 탈락은 실행되지 않는다
    expect(snap.plugins.map((p) => p.pluginId)).toEqual(["ok"]);
    expect(snap.failures).toHaveLength(1);
    expect(snap.failures[0].pluginId).toBe("bad");
    expect(snap.failures[0].error).toContain("매니페스트 검증 실패");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  /** 가드: 전부 성공하면 failures는 빈 배열(항상 배열 — 소비자가 분기 없이 읽는다). */
  it("leaves failures empty when every plugin loads", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["editor"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).failures).toEqual([]);
  });

  /** 가드: ready를 영영 보내지 않는 샌드박스는 빌드를 막지 않는다 — 상한 초과로 실패
   * 처리하고 나머지 플러그인은 정상 수집된다(스냅샷이 null로 굳지 않는다). */
  it("does not let a sandbox that never sends ready block the build", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeFactory({
      HANG: () => new Promise<void>(() => {}), // ready도 실패도 영영 없음
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("hang", ["editor"], [], "HANG"),
        src("ok", ["editor"], [], "OK"),
      ],
    });
    const mounted = mountPluginHost(deps);
    await vi.advanceTimersByTimeAsync(5000); // 부팅 상한까지 전진
    await mounted;
    vi.useRealTimers();

    const snap = requestSnapshot(deps.bus);
    expect(snap.plugins.map((p) => p.pluginId)).toEqual(["ok"]);
    expect(snap.failures).toEqual([
      { pluginId: "hang", error: "부팅 시간 초과" },
    ]);
    expect(fake.disposed).toContain("HANG"); // 실패 샌드박스는 정리
  });

  /** 가드: 테마 샌드박스에서는 theme.register 외의 호출이 명확한 오류로 거부된다 —
   * 즉시 dispose되는 경로라 버튼·설정을 수집해 봐야 버려지므로 조용히 삼키지 않는다. */
  it("rejects non-theme calls from the theme sandbox with a clear error", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results: { ok: boolean; error?: string }[] = [];
    const fake = makeFakeFactory({
      THEME: async ({ execute }) => {
        results.push(
          await execute("ui.addToolbarButton", { id: "x", label: "X" }),
        );
        results.push(
          await execute("theme.register", { tokens: { accent: "#222222" } }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      allInstalledSources: async () => [
        src("my-theme", ["theme", "ui"], ["theme"], "THEME"),
      ],
      activeThemeName: async () => "my-theme",
    });
    await mountPluginHost(deps);

    expect(results[0]).toEqual({
      ok: false,
      error:
        "테마 플러그인은 theme.register만 사용할 수 있습니다: ui.addToolbarButton",
    });
    expect(results[1].ok).toBe(true); // 테마 등록 자체는 정상
    expect(warns).toHaveBeenCalled();
    expect(requestSnapshot(deps.bus).theme.tokens).toEqual({
      accent: "#222222",
    });
  });

  /** 가드: 테마 로드 실패도 failures에 남는다(테마 id로) — 기본 테마로 폴백하되 조용하지 않다. */
  it("records a failed theme load in failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeFactory({
      THEME: ({ failReady }) => failReady("스크립트 로드 실패"),
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      allInstalledSources: async () => [
        src("my-theme", ["theme"], ["theme"], "THEME"),
      ],
      activeThemeName: async () => "my-theme",
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    expect(snap.theme).toEqual(SJ_D); // 기본 테마 폴백
    expect(snap.failures).toEqual([
      { pluginId: "my-theme", error: "스크립트 로드 실패" },
    ]);
  });

  /**
   * 가드(회귀): 테마 색을 편집하면 `settings.theme`가 `<베이스><custom>` 파생 이름이 된다 —
   * 실패 기록의 pluginId는 그 접미를 벗긴 **베이스 id**여야 한다. 설정 매니저는 플러그인
   * id(`my-theme`)로 실패를 조회하므로, 접미가 붙은 채면 ⚠ 배지도 사유 줄도 안 뜨고
   * 화면만 조용히 기본 테마로 돌아간다.
   */
  it("records a failed custom-color theme under its base id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = makeFakeFactory({
      THEME: ({ failReady }) => failReady("스크립트 로드 실패"),
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      allInstalledSources: async () => [
        src("my-theme", ["theme"], ["theme"], "THEME"),
      ],
      activeThemeName: async () => "my-theme<custom>",
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).failures).toEqual([
      { pluginId: "my-theme", error: "스크립트 로드 실패" },
    ]);
  });
});

describe("mountPluginHost — 수명주기(notes-reload 재빌드)", () => {
  /** 가드: notes-reload가 오면 기존 샌드박스를 전부 정리하고 재실행한 뒤 갱신을 방송한다.
   * 재빌드 후 스냅샷은 새 소스(설정 변경 반영)와 올라간 revision을 담는다. */
  it("rebuilds sandboxes and broadcasts EV_HOST_UPDATED on notes-reload", async () => {
    const fake = makeFakeFactory();
    let sources = [src("p1", ["editor"], [], "P1")];
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => sources,
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["P1"]);

    const updated = new Promise<void>((resolve) => {
      deps.bus.listen(EV_HOST_UPDATED, () => resolve());
    });
    sources = [src("p2", ["editor"], [], "P2")]; // 설정 창에서 플러그인 구성 변경
    deps.bus.emit(EV_NOTES_RELOAD, null);
    await updated;

    expect(fake.disposed).toContain("P1"); // 구 샌드박스 정리
    expect(fake.created).toEqual(["P1", "P2"]); // 재실행은 새 구성으로
    const snap = requestSnapshot(deps.bus);
    expect(snap.revision).toBe(2);
    expect(snap.plugins.map((p) => p.pluginId)).toEqual(["p2"]);
  });

  /** 가드: 빌드가 끝나기 전 도착한 스냅샷 요청은 큐에 쌓였다가 빌드 완료 후 응답받는다
   * (노트 창이 호스트보다 먼저 떠도 오래된/빈 스냅샷을 받지 않는다). */
  it("queues snapshot requests that arrive during the initial build", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["editor"], [], "P1")],
    });
    const answers: SnapshotPayload[] = [];
    deps.bus.listen(EV_SNAPSHOT, (p) => answers.push(p as SnapshotPayload));

    const mounted = mountPluginHost(deps); // 리스너는 동기 등록, 빌드는 비동기
    deps.bus.emit(EV_SNAPSHOT_GET, { requestId: "early" });
    expect(answers).toEqual([]); // 빌드 중 — 아직 응답 없음
    await mounted;

    expect(answers).toHaveLength(1);
    expect(answers[0].requestId).toBe("early");
    expect(answers[0].snapshot.plugins[0].pluginId).toBe("p1");
  });

  /**
   * 가드(핵심): 재빌드 요청의 **사유**를 완료 방송에 그대로 옮겨 싣는다 — 노트 창은 이 값
   * 하나로 "리로드 vs 제자리 조정"을 가르므로, 여기서 사유가 새면 조정으로 잘못 떨어진다.
   */
  it("carries the requested reasons through to EV_HOST_UPDATED", async () => {
    const deps = makeDeps({ createSandbox: makeFakeFactory().factory });
    await mountPluginHost(deps);

    const updated = new Promise<HostUpdatedPayload>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, (p) => resolve(p as HostUpdatedPayload)),
    );
    deps.bus.emit(EV_NOTES_RELOAD, { reasons: ["plugin-setting"] });
    expect((await updated).reasons).toEqual(["plugin-setting"]);
  });

  /** 가드: 사유가 없는(구버전) 요청은 `unknown`으로 접힌다 — 받는 창은 언제나 리로드한다. */
  it("falls back to unknown when the request carries no reason", async () => {
    const deps = makeDeps({ createSandbox: makeFakeFactory().factory });
    await mountPluginHost(deps);

    const updated = new Promise<HostUpdatedPayload>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, (p) => resolve(p as HostUpdatedPayload)),
    );
    deps.bus.emit(EV_NOTES_RELOAD, null);
    expect((await updated).reasons).toEqual(["unknown"]);
  });

  /**
   * 가드(핵심): 재빌드가 도는 동안 온 요청은 하나로 접히지만 **사유는 버리지 않는다** —
   * 접힌 요청이 낳는 두 번째 방송이 그 사유를 싣는다. 여기서 유실되면 그 사이의 언어팩 토글
   * 같은 변경이 조용히 조정 경로로 새어 반영되지 않는다.
   */
  it("keeps the reasons of requests folded into the queued rebuild", async () => {
    const deps = makeDeps({ createSandbox: makeFakeFactory().factory });
    await mountPluginHost(deps);

    const seen: HostUpdatedPayload[] = [];
    const twice = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, (p) => {
        seen.push(p as HostUpdatedPayload);
        if (seen.length === 2) resolve();
      }),
    );
    // 첫 요청이 도는 사이에 두 번째가 도착한다(같은 tick — 첫 build는 비동기다).
    deps.bus.emit(EV_NOTES_RELOAD, { reasons: ["settings"] });
    deps.bus.emit(EV_NOTES_RELOAD, { reasons: ["locale"] });
    await twice;

    expect(seen[0].reasons).toEqual(["settings"]);
    expect(seen[1].reasons).toEqual(["locale"]);
  });
});

describe("mountPluginHost — 개발 모드 단일 핫리로드", () => {
  /**
   * 가드(핵심 — "종단 확인"): 개발 소스가 바뀌면 그 플러그인 **하나만** dispose·재실행하고,
   * 나머지 샌드박스는 그대로 살아 있으며(창 상태 보존), 노트 창에는 전체 리로드가 아니라
   * 부분 갱신(EV_HOST_PLUGIN_UPDATED)만 방송한다.
   */
  it("re-runs only the changed plugin and preserves the other sandboxes", async () => {
    const fake = makeFakeFactory();
    let p2Code = "P2";
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["editor"], [], "P1"),
        src("p2", ["editor"], [], "P2"),
        src("p3", ["editor"], [], "P3"),
      ],
      devSource: async (id) =>
        id === "p2" ? src("p2", ["editor"], [], p2Code) : null,
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["P1", "P2", "P3"]);

    let fullReload = false;
    deps.bus.listen(EV_HOST_UPDATED, () => {
      fullReload = true;
    });
    const partial = new Promise<HostPluginUpdatedPayload>((resolve) =>
      deps.bus.listen(EV_HOST_PLUGIN_UPDATED, (p) =>
        resolve(p as HostPluginUpdatedPayload),
      ),
    );

    p2Code = "P2b"; // 저작자가 p2 코드를 저장했다
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    const evt = await partial;

    // p2만 정리·재실행 — p1·p3 샌드박스는 dispose되지 않는다(상태 보존).
    expect(fake.disposed).toEqual(["P2"]);
    expect(fake.created).toEqual(["P1", "P2", "P3", "P2b"]);
    expect(fullReload).toBe(false); // 전체 리로드 아님
    // 스냅샷은 p2 슬롯만 교체되고 순서·revision은 그대로 이어진다.
    expect(evt.pluginId).toBe("p2");
    expect(evt.snapshot.revision).toBe(2);
    expect(evt.snapshot.plugins.map((p) => p.pluginId)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(requestSnapshot(deps.bus).revision).toBe(2);
  });

  /** 가드(축 2 — 신선도 경로): 단일 핫리로드도 build()와 같은 이유로 로케일 캐시를
   * 플러그인 재실행보다 먼저 갱신한다 — 언어를 막 바꾼 뒤 플러그인 하나만 고쳐도 그 재실행이
   * 새 로케일을 즉시 본다(전체 재빌드를 기다릴 필요가 없다). */
  it("also sees a just-changed locale in the single hot-reload path", async () => {
    let locale: unknown = null;
    const scripts: Record<string, (api: FakeScriptApi) => Promise<void>> = {
      P1: async () => {},
      P2: async () => {},
    };
    const fake = makeFakeFactory(scripts);
    let p2Code = "P2";
    let currentLocale = "ko";
    const deps = makeDeps({
      createSandbox: fake.factory,
      activeLocale: async () => currentLocale,
      enabledInstalledSources: async () => [
        src("p1", [], [], "P1"),
        src("p2", [], [], "P2"),
      ],
      devSource: async (id) => (id === "p2" ? src("p2", [], [], p2Code) : null),
    });
    await mountPluginHost(deps);

    currentLocale = "en";
    p2Code = "P2b";
    scripts.P2b = async ({ execute }) => {
      locale = (await execute("i18n.locale", {})).result;
    };
    const partial = new Promise((resolve) =>
      deps.bus.listen(EV_HOST_PLUGIN_UPDATED, resolve),
    );
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    await partial;
    expect(locale).toBe("en");
  });

  /**
   * 가드(핵심, 이번 배치): 버튼이 늘거나 줄어도 **부분 갱신을 유지한다** — 노트 창이 그
   * 스냅샷으로 툴바 항목을 키 diff해 제자리에서 맞추기 때문이다(`NoteWindowHandle.
   * reconcileToolbarItems`). 예전에는 여기서 전체 리로드로 폴백해 개발 중 창 상태가 날아갔다.
   */
  it("keeps the partial update when the plugin's buttons change", async () => {
    let p2Code = "P2";
    const fake = makeFakeFactory({
      P2: async ({ execute }) => {
        await execute("ui.addToolbarButton", {
          id: "b",
          label: "x",
          buttonId: "onClick$1",
        });
      },
      P2b: async ({ execute }) => {
        await execute("ui.addToolbarButton", {
          id: "b",
          label: "x",
          buttonId: "onClick$1",
        });
        await execute("ui.addToolbarButton", {
          id: "c",
          label: "y",
          buttonId: "onClick$2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["editor"], [], "P1"),
        src("p2", ["ui"], ["ui"], "P2"),
      ],
      devSource: async (id) =>
        id === "p2" ? src("p2", ["ui"], ["ui"], p2Code) : null,
    });
    await mountPluginHost(deps);

    let full = false;
    deps.bus.listen(EV_HOST_UPDATED, () => {
      full = true;
    });
    const partial = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_PLUGIN_UPDATED, () => resolve()),
    );

    p2Code = "P2b"; // 버튼 하나가 늘었다 → 그래도 부분 갱신이다
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    await partial;

    // 재실행은 p2 하나뿐이고(p1 샌드박스 보존), 신호도 부분 갱신이다.
    expect(fake.disposed).toEqual(["P2"]);
    expect(fake.created).toEqual(["P1", "P2", "P2b"]);
    expect(full).toBe(false);
    const snap = requestSnapshot(deps.bus);
    expect(snap.plugins.find((p) => p.pluginId === "p2")?.buttons).toHaveLength(
      2,
    );
  });

  /**
   * 가드(경계): 능력(배경·폰트·창 컨트롤)이 걸려 있으면 여전히 전체 리로드로 폴백한다 —
   * 그것은 등록 순서 의존 병합이라 슬롯 하나만 갈아 끼워 재현할 수 없다. 재실행은 그래도
   * 그 플러그인 하나뿐이다(다른 샌드박스 보존).
   */
  it("still falls back to a full reload when the plugin registers a capability", async () => {
    let p2Code = "P2";
    const fake = makeFakeFactory({
      P2: async ({ execute }) => {
        await execute("window.register", { controls: ["transparency"] });
      },
      P2b: async ({ execute }) => {
        await execute("window.register", { controls: ["transparency"] });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["editor"], [], "P1"),
        src("p2", ["window-control"], ["window-control"], "P2"),
      ],
      devSource: async (id) =>
        id === "p2"
          ? src("p2", ["window-control"], ["window-control"], p2Code)
          : null,
    });
    await mountPluginHost(deps);

    let partial = false;
    deps.bus.listen(EV_HOST_PLUGIN_UPDATED, () => {
      partial = true;
    });
    const full = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, () => resolve()),
    );

    p2Code = "P2b";
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    await full;

    expect(fake.disposed).toEqual(["P2"]);
    expect(fake.created).toEqual(["P1", "P2", "P2b"]);
    expect(partial).toBe(false);
  });

  /**
   * 가드: 개발 소스를 못 읽으면(폴더 삭제 등) 전체 재빌드로 폴백한다 — 무엇을 실행할지
   * 모르는 채로 부분 교체를 하지 않는다.
   */
  it("falls back to a full rebuild when the dev source is gone", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["editor"], [], "P1"),
        src("p2", ["editor"], [], "P2"),
      ],
      devSource: async () => null, // 폴더가 사라졌다(읽기 실패)
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual(["P1", "P2"]);

    const full = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, () => resolve()),
    );
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    await full;

    // 전체 재빌드 폴백 — 모든 샌드박스가 정리·재실행된다.
    expect(fake.disposed.sort()).toEqual(["P1", "P2"]);
    expect(fake.created).toEqual(["P1", "P2", "P1", "P2"]);
    expect(requestSnapshot(deps.bus).revision).toBe(2);
  });

  /**
   * 가드(보존의 실증): 부분 핫리로드 뒤에도 **리로드되지 않은** 플러그인의 이벤트 구독은
   * 그대로 살아 이벤트를 받는다 — 다른 플러그인의 라이브 상태가 보존됐다는 직접 관측.
   */
  it("keeps another plugin's event subscription live after a partial hot reload", async () => {
    let p2Code = "P2";
    const fake = makeFakeFactory({
      P1: (api) => {
        void api.execute("events.on", { name: "note:saved", handlerId: "h1" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings", "notes:read"], ["notes:read"], "P1"),
        src("p2", ["editor"], [], "P2"),
      ],
      devSource: async (id) =>
        id === "p2" ? src("p2", ["editor"], [], p2Code) : null,
    });
    await mountPluginHost(deps);

    const partial = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_PLUGIN_UPDATED, () => resolve()),
    );
    p2Code = "P2b";
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p2" });
    await partial;

    // p1은 리로드되지 않았다 — 그 구독은 그대로 살아 note:saved를 받는다.
    deps.bus.emit(EV_PLUGIN_EVENT, {
      name: "note:saved",
      windowLabel: "note-a",
      noteId: "n1",
      path: "/v/notes/n1.md",
      at: 1,
    });
    const p1Invokes = fake.invoked.filter((i) => i.code === "P1");
    expect(p1Invokes).toHaveLength(1);
    expect(p1Invokes[0].buttonId).toBe("h1");
  });

  /**
   * 가드(무음 실패 봉쇄): 개발 중 트레이 항목만 바뀌면(다른 표면은 그대로라)
   * 부분 갱신 경로를 타는데, 그때도 네이티브 트레이가 새 값으로 **재배달**돼야 한다. 부분
   * 갱신(EV_HOST_PLUGIN_UPDATED)은 노트 창의 CM 확장만 재구성할 뿐 네이티브 메뉴바를
   * 건드리지 않으므로, 재배달이 없으면 라벨을 바꿔도 메뉴바는 마지막 build() 시점의 옛 값으로
   * 멈춘 채 어떤 진단도 남기지 않는 완전한 무음 실패가 된다(위반). build()·rebuildPlugin이
   * 같은 배달 헬퍼를 공유해야 이 갭이 닫힌다.
   */
  it("redelivers tray items to native on a partial dev hot-reload ", async () => {
    const deliveries: TrayItemDescriptor[][] = [];
    let code = "P1";
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "t",
          label: "old-label",
          run$id: "h:1",
        });
      },
      P1b: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "t",
          label: "new-label",
          run$id: "h:1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
      devSource: async (id) =>
        id === "p1" ? src("p1", ["ui"], [], code) : null,
      setTrayItems: (items) => {
        deliveries.push([...items]);
      },
    });
    await mountPluginHost(deps);
    expect(deliveries).toEqual([
      [{ pluginId: "p1", id: "t", label: "old-label" }],
    ]);

    // 트레이만 바뀌므로 부분 갱신 경로를 탄다(버튼·명령·능력·구독 불변).
    let partial = false;
    deps.bus.listen(EV_HOST_PLUGIN_UPDATED, () => {
      partial = true;
    });
    code = "P1b";
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(partial).toBe(true); // 부분 갱신 경로임을 확인.
    // 그런데도 네이티브 트레이는 새 라벨로 재배달됐다(전엔 old-label로 멈춰 있었다).
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual([
      { pluginId: "p1", id: "t", label: "new-label" },
    ]);
  });

  /**
   * 가드: 개발 핫리로드가 로드 실패(잘못된 코드 등)로 슬롯이 빠지면, 그 플러그인의
   * 트레이 항목이 네이티브에서도 **사라져야** 한다 — 폐기된 샌드박스를 가리키는 죽은 handlerId가
   * 메뉴바에 남아 눌러도 무반응인 유령이 되지 않게. 전체 교체 배달(빈 목록)로 걷어내고,
   * `trayItemsOf`에서도 지워 트레이 클릭이 아무것도 역호출하지 않는다.
   */
  it("removes a dead tray item from native when a dev hot-reload fails to load ", async () => {
    const deliveries: TrayItemDescriptor[][] = [];
    let code = "P1";
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("ui.addTrayItem", {
          id: "t",
          label: "살아있음",
          run$id: "h:1",
        });
      },
      BROKEN: async ({ failReady }) => {
        failReady("로드 실패");
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
      devSource: async (id) =>
        id === "p1" ? src("p1", ["ui"], [], code) : null,
      setTrayItems: (items) => {
        deliveries.push([...items]);
      },
    });
    await mountPluginHost(deps);
    expect(deliveries).toEqual([
      [{ pluginId: "p1", id: "t", label: "살아있음" }],
    ]);

    const full = new Promise<void>((resolve) =>
      deps.bus.listen(EV_HOST_UPDATED, () => resolve()),
    );
    code = "BROKEN"; // 재실행이 ready 실패로 끝난다 → 슬롯이 스냅샷에서 빠진다.
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "p1" });
    await full;

    // 트레이가 전체 교체로 비워졌다(죽은 항목이 메뉴바에서 사라졌다).
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual([]);
    // 트레이 클릭도 더는 아무것도 역호출하지 않는다(trayItemsOf에서 지워졌다).
    fake.invoked.length = 0;
    deps.bus.emit(EV_TRAY_INVOKE, { pluginId: "p1", trayItemId: "t" });
    expect(fake.invoked).toHaveLength(0);
  });

  /** 가드: 빈/누락 pluginId payload는 무시한다(크래시 없음, 재실행 없음). */
  it("ignores dev-reload payloads without a pluginId", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["editor"], [], "P1")],
      devSource: async () => null,
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, {});
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, { pluginId: "" });
    deps.bus.emit(EV_PLUGIN_DEV_RELOAD, null);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.disposed).toEqual([]);
    expect(fake.created).toEqual(["P1"]);
  });
});

describe("mountPluginHost — callWindow 타임아웃·정리(가짜 타이머)", () => {
  afterEach(() => vi.useRealTimers());

  /** 타임아웃 시나리오 공통 준비: ui 플러그인 1개 + note-a 클릭 컨텍스트까지 만든다. */
  async function mountWithContext() {
    vi.useFakeTimers();
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    return { fake, deps };
  }

  /** 가드: 창이 응답하지 않으면 5초 타임아웃으로 오류 응답한다(샌드박스 promise가
   * 영원히 걸리지 않는다). */
  it("times out an unanswered window call after 5s", async () => {
    const { fake } = await mountWithContext();
    const pending = fake.executes.P1("ui.toast", { title: "x" }); // 응답자 없음
    await vi.advanceTimersByTimeAsync(5000); // 타임아웃 마감까지 전진
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "창 응답 없음: ui.toast",
    });
  });

  /** 가드: 타임아웃 뒤 늦게 도착한 응답은 무시된다(이중 해소·오염 없음) — 같은 채널의
   * 다음 호출은 정상 왕복한다. */
  it("ignores a late window result after the timeout", async () => {
    const { fake, deps } = await mountWithContext();
    let lastRequestId = "";
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      lastRequestId = (p as WindowCallPayload).requestId;
    });

    const timedOut = fake.executes.P1("ui.toast", { title: "x" });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(timedOut).resolves.toMatchObject({ ok: false });

    // 늦은 응답: 이미 정리된 requestId — 아무 효과도 없어야 한다(예외·상태 오염 없음).
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: lastRequestId,
      ok: true,
      result: "늦음",
    });

    // 다음 호출은 정상적으로 응답자와 왕복한다.
    const answered = deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: "정상",
      });
    });
    await expect(fake.executes.P1("ui.toast", { title: "y" })).resolves.toEqual(
      {
        ok: true,
        result: "정상",
      },
    );
    answered();
  });

  /** 가드: 대화형 호출(pickList)은 5초에 타임아웃하지 않는다 — 5초 뒤 도착한 선택 응답도
   * 정상 반영된다(사용자가 천천히 골라도 된다). */
  it("does not time out interactive calls (pickList) at 5s", async () => {
    const { fake, deps } = await mountWithContext();
    let reqId = "";
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      reqId = (p as WindowCallPayload).requestId;
    });
    const pending = fake.executes.P1("ui.pickList", { title: "t", items: [] });
    await vi.advanceTimersByTimeAsync(5000); // 일반 호출이라면 여기서 타임아웃
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: reqId,
      ok: true,
      result: "0",
    });
    await expect(pending).resolves.toEqual({ ok: true, result: "0" });
  });

  /** 가드: 대화형 호출도 긴 상한(10분)에는 타임아웃한다(죽은 창 누수 방지). */
  it("still times out interactive calls at the long bound", async () => {
    const { fake } = await mountWithContext();
    const pending = fake.executes.P1("ui.prompt", { title: "t" }); // 응답자 없음
    await vi.advanceTimersByTimeAsync(600000);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  /** 가드: 재빌드는 진행 중 창-스코프 호출을 즉시 취소한다 — 5초 타임아웃을 기다리지
   * 않고, 무효가 된 샌드박스·컨텍스트로의 응답 대기를 남기지 않는다. */
  it("cancels pending window calls immediately on rebuild", async () => {
    const { fake, deps } = await mountWithContext();
    const pending = fake.executes.P1("ui.toast", { title: "x" }); // 응답자 없음

    const updated = new Promise<void>((resolve) => {
      deps.bus.listen(EV_HOST_UPDATED, () => resolve());
    });
    deps.bus.emit(EV_NOTES_RELOAD, null);
    await updated; // 시간 전진 없이(타이머 5s 미경과) 재빌드 완료만 기다린다.

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "호스트 재빌드로 취소됨",
    });
  });
});

describe("설정 계약 — 기본값 병합·구조화 값", () => {
  /** templates(list) + insertMode(select, value≠label)를 선언한 합성 스키마. */
  const schema: PluginSettingField[] = [
    { key: "templates", label: "템플릿", type: "list", options: [] },
    {
      key: "mode",
      label: "방식",
      type: "select",
      default: "cursor",
      options: [
        { value: "cursor", label: "커서 위치" },
        { value: "append", label: "문서 끝에 추가" },
      ],
    },
    {
      key: "step",
      label: "폭",
      type: "number",
      default: 10,
      min: 5,
      options: [],
    },
  ];

  /** 가드(번들 경로의 결함): 저장된 값이 하나도 없어도 매니페스트 default가 런타임에
   * 도달한다. 예전엔 저장 값만 바인딩해 `settings.get`이 null이었고, 그래서 번들들이 기본값을
   * main.js에 다시 하드코딩했다. */
  it("delivers manifest defaults to bundled plugins with no saved values", async () => {
    let all: Record<string, unknown> | null = null;
    const fake = makeFakeFactory({
      B: async ({ execute }) => {
        all = (await execute("settings.getAll", {})).result as Record<
          string,
          unknown
        >;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtinSettings: async () => ({}), // 사용자가 설정 폼을 한 번도 안 연 상태
      builtins: [
        {
          id: "b",
          name: "B",
          version: "1.0.0",
          permissions: ["settings"],
          code: "B",
          readme: "",
          settings: schema,
        },
      ],
    });
    await mountPluginHost(deps);
    expect(all).toEqual({ templates: [], mode: "cursor", step: 10 });
  });

  /** 가드: list는 `settings.get`·`settings.getAll` 어느 쪽이든 언제나 `{name, body}[]`
   * 배열로 온다(저장 블롭을 그대로 받는 `raw` 탈출구는 제거됐다 — 엄격). */
  it("hands list settings over as a structured array", async () => {
    const got: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        got.push((await execute("settings.get", { key: "templates" })).result);
        got.push(
          (
            (await execute("settings.getAll", {})).result as Record<
              string,
              unknown
            >
          ).templates,
        );
      },
    });
    const blob = "=== A ===\naaa\n\n=== B ===\nbbb";
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", { templates: blob }, schema),
      ],
    });
    await mountPluginHost(deps);
    expect(got[0]).toEqual([
      { name: "A", body: "aaa" },
      { name: "B", body: "bbb" },
    ]);
    expect(got[1]).toEqual(got[0]);
  });

  /** 가드: 플러그인이 배열로 저장하면 **호스트가** 블롭으로 직렬화해 영속화한다
   * (이름의 `=`도 호스트가 지운다 — 플러그인이 헤더 문법을 방어할 이유가 없다). */
  it("serializes plugin-provided list arrays before persisting", async () => {
    const persistPluginSetting = vi.fn();
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("settings.set", {
          key: "templates",
          value: [{ name: "A=B", body: "본문" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      persistPluginSetting,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", {}, schema),
      ],
    });
    await mountPluginHost(deps);
    expect(persistPluginSetting).toHaveBeenCalledWith(
      "p1",
      "templates",
      "=== AB ===\n본문",
    );
  });
});

describe("진단 채널 — 무음 실패의 표면화", () => {
  /**
   * 가드(회귀): 샌드박스 **내부** 실패(onClick 예외·미처리 rejection)가 링버퍼에 도달한다.
   *
   * 왜: 호스트가 관측할 수 있는 것은 브리지 거부뿐이다. 이 배선이 없으면 저작자는
   * "브리지 실패는 「최근 오류」에 보이는데 내 코드가 죽은 것만 안 보인다"는 최악의 조합을
   * 만난다 — 버튼은 눌리고, 오류는 없고, 아무 일도 일어나지 않는다.
   */
  it("records failures the sandbox reports about its own code", async () => {
    const fake = makeFakeFactory({
      BOOM: ({ reportDiagnostic }) => {
        reportDiagnostic({ kind: "onclick-throw", message: "의도적 폭발" });
        reportDiagnostic({
          kind: "unhandled-rejection",
          message: "거부됨",
          call: "notes.current",
          code: "PERMISSION_UNDECLARED",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("boom", ["ui"], ["ui"], "BOOM"),
      ],
    });
    await mountPluginHost(deps);
    expect(
      requestDiagnostics(deps.bus).filter((d) => d.pluginId === "boom"),
    ).toMatchObject([
      { kind: "onclick-throw", message: "의도적 폭발" },
      {
        kind: "unhandled-rejection",
        message: "거부됨",
        call: "notes.current",
        code: "PERMISSION_UNDECLARED",
      },
    ]);
  });

  /** 가드(핵심): 거부된 브리지 호출은 플러그인이 `.catch`를 걸지 않아도 기록된다 — 번들 18개
   * 중 `.catch()`를 건 것이 0개라 지금까지 흔적이 전혀 없었다. (여기선 kind 미선언 액션
   * 플러그인의 능력 등록이라 kind 게이트가 먼저 거부한다 — 권한 판정보다 앞이다.) */
  it("records rejected bridge calls even with no .catch on the plugin side", async () => {
    const fake = makeFakeFactory({
      EVIL: async ({ execute }) => {
        void execute("theme.register", { tokens: {} }); // kind 미선언 → 능력 등록 거부
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("evil", ["editor"], [], "EVIL"),
      ],
    });
    await mountPluginHost(deps);
    const found = requestDiagnostics(deps.bus).filter(
      (d) => d.pluginId === "evil",
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("call-reject");
    expect(found[0].call).toBe("theme.register");
    // 기계용 코드가 그대로 실린다 — 저작자·AI가 한국어 문구를 매칭하지 않아도 된다.
    expect(found[0].code).toBe("WRONG_PLUGIN_KIND");
  });

  /** 가드: 창 컨텍스트가 없어 **조용히 null**이 되는 창-스코프 호출도 기록한다(성공과 구분
   * 되지 않는 응답이라 저작자가 볼 수 있는 유일한 흔적이다). */
  it("records window-scoped calls that silently no-op for lack of context", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        // 로드 시점 호출 — 아직 아무 창도 이 플러그인을 클릭하지 않았다.
        expect((await execute("ui.toast", { title: "안녕" })).ok).toBe(true);
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    const found = requestDiagnostics(deps.bus);
    expect(found.map((d) => d.kind)).toContain("no-window-context");
    expect(found.find((d) => d.kind === "no-window-context")?.call).toBe(
      "ui.toast",
    );
  });

  /** 가드: `requireWindow: true`를 준 호출은 조용한 null이 아니라 코드가 붙은 거부다.
   * 무음 실패를 저작자·AI가 **테스트 가능한 실패**로 바꾸는 유일한 옵트인이라, 이 배선이
   * 끊기면 옵션이 문서에만 있고 아무 일도 안 하게 된다. */
  it("rejects with CONTEXT_UNAVAILABLE when requireWindow is opted in", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        // 옵트인 없음 → 조용한 null(성공 응답).
        expect((await execute("ui.toast", { title: "안녕" })).ok).toBe(true);
        // 옵트인 → 거부 + 안정 코드.
        const denied = await execute("ui.toast", {
          title: "안녕",
          requireWindow: true,
        });
        expect(denied.ok).toBe(false);
        expect(denied.code).toBe("CONTEXT_UNAVAILABLE");
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    // 옵트인한 쪽도 진단에 남는다 — 두 경로가 「최근 오류」의 같은 자리로 모인다.
    const found = requestDiagnostics(deps.bus).filter(
      (d) => d.kind === "no-window-context",
    );
    expect(found).toHaveLength(2);
    expect(found.map((d) => d.code)).toContain("CONTEXT_UNAVAILABLE");
  });

  /** 가드: 창 쪽 수행부가 코드를 실어 보낸 거부는 그 코드 그대로 샌드박스에 도달한다.
   * (창 응답 → `waiter.reject` → 게이트키퍼 → 브리지 응답의 전 구간 배선.) */
  it("carries a window-side error code through to the bridge response", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "clipboard"], ["clipboard"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: false,
        code: "UNKNOWN_CALL",
        error: "창 수행부가 모르는 호출",
      });
    });
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const token = fake.invoked[0].token;
    const response = await fake.executes.P1(
      "clipboard.write",
      { text: "x" },
      token,
    );
    expect(response).toMatchObject({ ok: false, code: "UNKNOWN_CALL" });
    // 진단에도 같은 코드로 남는다(↔ 브리지 응답 규약이 같은 어휘를 쓴다).
    const rejected = requestDiagnostics(deps.bus).find(
      (d) => d.kind === "call-reject" && d.call === "clipboard.write",
    );
    expect(rejected?.code).toBe("UNKNOWN_CALL");
  });

  /** 가드: 플러그인이 남긴 `runtime.log`도 같은 기록으로 모인다(호스트 콘솔은 저작자에게
   * 보이지 않는다 — 샌드박스가 불투명 origin이라 devtools도 못 붙는다). */
  it("collects memo.runtime.log lines", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("runtime.log", { message: "여기까지 왔다" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", [], [], "P1")],
    });
    await mountPluginHost(deps);
    const logs = requestDiagnostics(deps.bus).filter((d) => d.kind === "log");
    expect(logs.map((d) => d.message)).toEqual(["여기까지 왔다"]);
  });

  /** 가드: 저장이 백엔드에서 거부되면 기록한다 — 브리지 응답은 `ok:true`인데 실제 저장이
   * 실패하는 구멍(예전엔 프라미스를 통째로 버려 흔적이 0이었다). */
  it("records setting writes rejected by the backend", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("settings.set", { key: "tone", value: "loud" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      persistPluginSetting: () =>
        Promise.reject(new Error("선언되지 않은 설정 키")),
      enabledInstalledSources: async () => [src("p1", ["settings"], [], "P1")],
    });
    await mountPluginHost(deps);
    await Promise.resolve(); // 거부 전파(마이크로태스크 1틱)
    const found = requestDiagnostics(deps.bus).filter(
      (d) => d.kind === "setting-write-rejected",
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("선언되지 않은 설정 키");
  });

  /** 가드: 매니페스트에 선언되지 않은 키에 쓰면 기록한다(백엔드가 버리는 쓰기 — "저장했는데
   * 다음 실행에 없다"의 원인). 거부하지는 않는다(번들 경로 하위호환). */
  it("records writes to keys the manifest never declared", async () => {
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        await execute("settings.set", { key: "없는키", value: 1 });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", {}, [
          { key: "tone", label: "톤", type: "text", options: [] },
        ]),
      ],
    });
    await mountPluginHost(deps);
    const found = requestDiagnostics(deps.bus).filter(
      (d) => d.kind === "setting-key-undeclared",
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("없는키");
  });

  /** 가드: 진단은 **재빌드에도 지워지지 않는다** — 설정을 한 번 바꿀 때마다 재빌드가 도는데
   * 비우면 저작자가 방금 만든 증거가 그 자리에서 사라진다. */
  it("keeps diagnostics across host rebuilds", async () => {
    const fake = makeFakeFactory({
      EVIL: async ({ execute }) => {
        void execute("theme.register", { tokens: {} });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("evil", ["editor"], [], "EVIL"),
      ],
    });
    await mountPluginHost(deps);
    const before = requestDiagnostics(deps.bus).length;
    deps.bus.emit(EV_NOTES_RELOAD, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(requestDiagnostics(deps.bus, "d2").length).toBeGreaterThan(before);
  });

  /** 가드(완성): 앱 버전이 실제로 주입된다 — 예전엔 두 호출부가 `hostVersion: ""`를
   * 하드코딩해 저작자가 보는 값이 언제나 빈 문자열이었다. */
  it("injects the real app version into runtime.info", async () => {
    let info: Record<string, unknown> | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        info = (await execute("runtime.info", {})).result as Record<
          string,
          unknown
        >;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      hostVersion: async () => "1.2.3",
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(info).toMatchObject({ hostVersion: "1.2.3" });
  });

  /** 가드: 버전을 못 읽으면 **빈 문자열**로 둔다(지어내지 않는다) — 그리고 그 실패가 다른
   * 플러그인 로드를 막지 않는다. */
  it("falls back to an empty host version instead of inventing one", async () => {
    let info: Record<string, unknown> | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        info = (await execute("runtime.info", {})).result as Record<
          string,
          unknown
        >;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      hostVersion: async () => {
        throw new Error("버전을 읽지 못함");
      },
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(info).toMatchObject({ hostVersion: "" });
  });

  /** 가드(계약 못박기): 사유는 **언제나 `"reload"`**다 — 설치 직후든 설정 변경 재빌드든
   * 호스트에는 같은 신호 하나로 도착하므로 구분할 근거가 없다. 저작자 계약(`.d.ts`)이
   * `"reload"` 하나로 좁혀져 있는 근거가 이 가드다. */
  it("always reports reload as the run reason", async () => {
    const seen: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        const info = (await execute("runtime.info", {})).result as {
          reason: string;
        };
        seen.push(info.reason);
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_NOTES_RELOAD, {}); // 재빌드도 같은 사유다.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["reload", "reload"]);
  });

  /** 가드(완성): `runtime.info()`가 빈 껍데기가 아니라 실제 실행 환경을 돌려준다 —
   * 중앙 호스트가 pluginId·OS를 주입한다. */
  it("fills runtime.info with the real plugin id and os", async () => {
    let info: Record<string, unknown> | null = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        info = (await execute("runtime.info", {})).result as Record<
          string,
          unknown
        >;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      platform: async () => "macos",
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(info).toMatchObject({
      pluginId: "p1",
      os: "macos",
      declared: ["ui"],
    });
  });

  /** 가드(축 2): `memo.i18n.locale()`이 실제 활성 로케일을 돌려준다(`runtime.info`의
   * hostVersion/os와 같은 주입 경로). */
  it("injects the active locale into i18n.locale", async () => {
    let locale: unknown = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        locale = (await execute("i18n.locale", {})).result;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      activeLocale: async () => "en",
      enabledInstalledSources: async () => [src("p1", [], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(locale).toBe("en");
  });

  /** 가드(축 2): `deps.activeLocale`을 안 주면 "ko" 기본값(다른 무권한 introspection 필드와
   * 같은 "지어내지 않는다" 원칙 — hostVersion의 빈 문자열 폴백과 짝). */
  it("defaults i18n.locale to ko when deps.activeLocale is not provided", async () => {
    let locale: unknown = null;
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        locale = (await execute("i18n.locale", {})).result;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", [], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(locale).toBe("ko");
  });

  /**
   * 가드(축 2 — 신선도): 언어 설정이 바뀐 **바로 그 재빌드**에서도 플러그인이 새 로케일을
   * 즉시 본다(한 세대 지연 없음).
   *
   * **이 테스트가 고정하는 것은 순서다**: `build()`·`rebuildPlugin()`은 플러그인 루프
   * **전에** `deps.activeLocale()`을 await해 `localeValue`를 굳혀야 한다. 그 콜백이
   * `bootstrap/plugin-host.ts`의 `resolveHostLocale`이고, 사전 등록과 `setActiveLocale`의
   * 단일 소유자다.
   *
   * 반사실: fetch-and-assign이 루프 **뒤로** 밀리면(또는 `runtimeEnv()`가 캐시 대신 이 창의
   * `activeLocale()` getter를 직접 읽으면), 언어를 막 바꾼 바로 그 재빌드에서 도는 플러그인이
   * 전부 **직전 재빌드**의 로케일("ko")을 보고 새 값은 다음 재빌드에야 보인다 — 눈에 잘 안
   * 띄는 한 세대 지연이다. 아래 어서션의 두 번째 값이 정확히 그 지점이다.
   */
  it("sees a just-changed locale within the same rebuild, not one generation late", async () => {
    const seen: unknown[] = [];
    const fake = makeFakeFactory({
      P1: async ({ execute }) => {
        seen.push((await execute("i18n.locale", {})).result);
      },
    });
    let currentLocale = "ko";
    const deps = makeDeps({
      createSandbox: fake.factory,
      activeLocale: async () => currentLocale,
      enabledInstalledSources: async () => [src("p1", [], [], "P1")],
    });
    await mountPluginHost(deps);
    currentLocale = "en"; // 언어 설정 변경(설정 창에서 바꾼 상황을 흉내).
    deps.bus.emit(EV_NOTES_RELOAD, {}); // 그 변경이 트리거하는 재빌드.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["ko", "en"]); // 두 번째 값이 즉시 "en" — 지연 없음.
  });
});

describe("매니페스트 계약이 런타임에 강제된다", () => {
  /**
   * 계약 필드를 실은 설치 소스(`src` 헬퍼는 매니페스트 확장을 받지 않는다).
   *
   * 왜 매니페스트에 싣는가: 게이트의 입력은 **검증된 매니페스트**여야 한다 — 호스트가 별도
   * 채널로 kind를 받으면 매니페스트와 어긋난 값이 게이트를 통과할 여지가 생긴다.
   */
  const contract = (
    id: string,
    permissions: string[],
    code: string,
    extras: Record<string, unknown>,
    settings?: PluginSettingField[],
  ): InstalledPluginSource => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "main.js",
      permissions,
      ...(settings ? { settings } : {}),
      ...extras,
    },
    code,
    granted: permissions,
  });

  /**
   * 가드(핵심, : `kind: "action"` 플러그인의 능력 등록은 **스냅샷에 닿지 못한다**.
   *
   * 예전에는 게이트도 registrar도 통과한 뒤 조립 단계(`plugins.find(p => p.font)`)에서
   * 결과만 조용히 버려졌다 — 저작자는 성공 응답을 받고 폰트 피커에는 아무것도 안 나왔다.
   * 이제 거부가 진단에도 남아 「최근 오류」에서 원인이 보인다.
   */
  it("keeps an action plugin's capability out of the snapshot, with a diagnostic", async () => {
    let response: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      ACT: async ({ execute }) => {
        response = await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        contract("act", ["font"], "ACT", { kind: "action" }),
      ],
    });
    await mountPluginHost(deps);

    expect(response).toMatchObject({ ok: false, code: "WRONG_PLUGIN_KIND" });
    expect(requestSnapshot(deps.bus).font).toBeNull();
    const rejected = requestDiagnostics(deps.bus).filter(
      (d) => d.code === "WRONG_PLUGIN_KIND",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].call).toBe("font.register");
  });

  /** 가드: 같은 코드라도 `kind: "capability"`로 선언하면 등록이 스냅샷에 실린다. */
  it("accepts the same registration from a capability plugin", async () => {
    const fake = makeFakeFactory({
      CAP: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        contract("cap", ["font"], "CAP", { kind: "capability" }),
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).font?.families).toHaveLength(1);
  });

  /**
   * 가드(번들 경로): 게이트는 **설치 플러그인에만** 걸리지 않는다 — 번들 매니페스트의
   * `kind`도 실행까지 실려 간다.
   *
   * 왜 이 가드가 필요한가: 번들 20개가 전부 `kind`를 적어 두고 로드 경로(`builtin/index.ts`)가
   * 그 필드를 떨어뜨리면, 외부 플러그인은 막히는데 도그푸딩 경로만 통과하는 비대칭이 생긴다
   * (이 저장소가 없애려는 "선언은 됐는데 아무도 안 읽는다"의 정확한 형태).
   */
  it("applies the kind gate to bundled plugins too", async () => {
    let response: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      BACT: async ({ execute }) => {
        response = await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "b-act",
          name: "합성 액션 번들",
          version: "1.0.0",
          kind: "action",
          permissions: ["font"],
          code: "BACT",
          readme: "테스트용 합성 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(response).toMatchObject({ ok: false, code: "WRONG_PLUGIN_KIND" });
    expect(requestSnapshot(deps.bus).font).toBeNull();
  });

  /** 가드: 번들이 `kind: "capability"`면 같은 등록이 스냅샷에 실린다(게이트가 과잉 차단하지 않음). */
  it("accepts a bundled capability registration", async () => {
    const fake = makeFakeFactory({
      BCAP: async ({ execute }) => {
        await execute("font.register", {
          families: [{ label: "세리프", stack: "Georgia, serif" }],
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      builtins: [
        {
          id: "b-cap",
          name: "합성 능력 번들",
          version: "1.0.0",
          kind: "capability",
          permissions: ["font"],
          code: "BCAP",
          readme: "테스트용 합성 번들",
        },
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).font?.families).toHaveLength(1);
  });

  /** 가드: `settings.get`의 문자열 축약형은 언제나 거부된다(객체 인자만 — 엄격). */
  it("rejects the settings.get string shorthand (object arg only)", async () => {
    const results: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P: async ({ execute }) => {
        results.push(await execute("settings.get", "tone" as never));
        results.push(await execute("settings.get", { key: "tone" }));
      },
    });
    const schema: PluginSettingField[] = [
      { key: "tone", label: "톤", type: "text", options: [], default: "soft" },
    ];
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        contract("p", ["settings"], "P", {}, schema),
      ],
    });
    await mountPluginHost(deps);
    expect(results[0]).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(results[1]).toEqual({ ok: true, result: "soft" }); // 객체형은 그대로 동작
  });

  /**
   * 가드: 창 컨텍스트가 없을 때 `requireWindow: true`를 준 호출은 **조용한 null이 아니라
   * 거부**다. 옵트인하지 않으면 예전처럼 null이라 성공과 구분되지 않는다(그 자체가 옵트인이
   * 존재하는 이유다).
   */
  it("rejects instead of a silent null only when requireWindow is opted in", async () => {
    const seen: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      OPT: async ({ execute }) => {
        seen.push(
          await execute("ui.toast", { title: "hi", requireWindow: true }),
        );
      },
      PLAIN: async ({ execute }) => {
        seen.push(await execute("ui.toast", { title: "hi" }));
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        contract("opt", ["ui"], "OPT", {}),
        contract("plain", ["ui"], "PLAIN", {}),
      ],
    });
    await mountPluginHost(deps);
    expect(seen[0]).toMatchObject({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(seen[1]).toEqual({ ok: true, result: null });
  });
});

/**
 * 이벤트 구독·배달 — 상주 샌드박스 1개가 모든 창을 공유한다는 제약 위에서, 이벤트가
 * **구독자에게만** 가고 **그 이벤트가 난 창**으로 라우팅되는지를 못박는다.
 */
describe("이벤트 구독 — memo.events.on", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** 노트 창이 방송하는 것과 같은 모양의 이벤트를 쏜다. */
  const fireNote = (
    bus: HostEventBus,
    name: string,
    windowLabel = "note-a",
    noteId = "n1",
  ) =>
    bus.emit(EV_PLUGIN_EVENT, {
      name,
      windowLabel,
      noteId,
      path: `/v/notes/${noteId}.md`,
      at: 111,
    });

  /** 구독 1건을 등록한 플러그인 하나를 띄운다(권한은 인자로 조절). */
  async function mountSubscriber(
    name: string,
    permissions = ["settings", "notes:read", "ui"],
    granted = ["notes:read"],
  ) {
    const fake = makeFakeFactory({
      P1: (api) => {
        void api.execute("events.on", { name, handlerId: "h:1" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", permissions, granted, "P1"),
      ],
    });
    await mountPluginHost(deps);
    return { fake, deps };
  }

  /** 가드(핵심): 구독한 이름의 이벤트만, 구독한 플러그인의 샌드박스에만 역호출된다. */
  it("invokes only the subscribing sandbox, only for the subscribed name", async () => {
    const fake = makeFakeFactory({
      P1: (api) => {
        void api.execute("events.on", {
          name: "note:saved",
          handlerId: "h:saved",
        });
      },
      // P2는 구독하지 않는다 — 어떤 이벤트도 받아선 안 된다(브로드캐스트 금지).
      P2: () => {},
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings", "notes:read"], ["notes:read"], "P1"),
        src("p2", ["settings", "notes:read"], ["notes:read"], "P2"),
      ],
    });
    await mountPluginHost(deps);

    fireNote(deps.bus, "note:opened"); // 구독하지 않은 이름
    expect(fake.invoked).toHaveLength(0);

    fireNote(deps.bus, "note:saved");
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].code).toBe("P1");
    expect(fake.invoked[0].buttonId).toBe("h:saved");
    expect(fake.invoked[0].payload).toEqual({
      name: "note:saved",
      windowId: "note-a",
      noteId: "n1",
      path: "/v/notes/n1.md",
      at: 111,
    });
  });

  /**
   * 가드(핵심 — 데이터 손상 방지): 이벤트 핸들러 안에서 한 창-스코프 호출은 **그 이벤트가
   * 난 창**으로 간다. 토큰이 없으면 「마지막 클릭 창」 폴백을 타 A 창의 저장 알림이 B 창에
   * 뜬다(버튼 클릭에서 실제로 겪은 유형).
   */
  it("routes a call made inside the handler to the window the event came from", async () => {
    const { fake, deps } = await mountSubscriber("note:saved");
    // 다른 창에서 버튼을 눌러 폴백 컨텍스트를 note-b로 만들어 둔다(함정 세팅).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-b",
    });
    const targets: string[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) =>
      targets.push((p as WindowCallPayload).windowLabel),
    );

    fireNote(deps.bus, "note:saved", "note-a");
    const token = fake.invoked[fake.invoked.length - 1]?.token ?? "";
    expect(token).not.toBe("");
    // 핸들러가 그 토큰을 물고 한 호출(바인딩된 memo)이 note-a로 가야 한다.
    void fake.executes.P1("ui.toast", { title: "저장됨" }, token);
    expect(targets).toEqual(["note-a"]);
  });

  /** 가드: 같은 (플러그인, 창)에는 같은 토큰을 재사용한다 — 이벤트마다 새로 발급하면
   * 토큰 상한(200, LRU)이 이벤트 빈도로 회전해 팝업이 떠 있는 클릭 체인을 밀어낸다. */
  it("reuses one context token per (plugin, window) and separates windows", async () => {
    const { fake, deps } = await mountSubscriber("note:saved");
    fireNote(deps.bus, "note:saved", "note-a");
    fireNote(deps.bus, "note:saved", "note-a");
    fireNote(deps.bus, "note:saved", "note-b");
    const [t1, t2, t3] = fake.invoked.map((i) => i.token);
    expect(t1).toBe(t2);
    expect(t3).not.toBe(t1);
  });

  /** 가드: 모르는 이벤트 이름은 조용히 등록되지 않고 INVALID_ARGS로 거부된다 — 받아 두면
   * "구독은 됐는데 영영 안 불린다"가 되어 저작자가 원인을 찾을 방법이 없다. */
  it("rejects an unknown event name with INVALID_ARGS", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["settings"], [], "P1")],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.P1("events.on", {
      name: "note:changed",
      handlerId: "h:1",
    });
    expect(res).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(String(res.error)).toContain("note:saved");
  });

  /** 가드: handler 없는 구독은 거부된다(등록해 봐야 부를 것이 없다 — 툴바 버튼과 같은 규칙). */
  it("rejects a subscription without a handler", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["settings"], [], "P1")],
    });
    await mountPluginHost(deps);
    await expect(
      fake.executes.P1("events.on", { name: "note:saved" }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  /**
   * 가드(권한): 노트 이벤트는 `notes:read`를 **추가로** 요구한다. 게이트키퍼는 호출 1개당
   * 권한 1개만 볼 수 있어 바닥(settings)까지만 판정하므로, 이 검사가 없으면 노트 메타가
   * 저위험 권한만으로 새어 나간다.
   */
  it("requires notes:read for note events (declared and granted)", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1"), // notes:read 미선언
        src("p2", ["settings", "notes:read"], [], "P2"), // 선언했지만 미승인
      ],
    });
    await mountPluginHost(deps);
    await expect(
      fake.executes.P1("events.on", { name: "note:saved", handlerId: "h" }),
    ).resolves.toMatchObject({ ok: false, code: "PERMISSION_UNDECLARED" });
    await expect(
      fake.executes.P2("events.on", { name: "note:saved", handlerId: "h" }),
    ).resolves.toMatchObject({ ok: false, code: "PERMISSION_UNGRANTED" });
    // 같은 플러그인이라도 settings:changed는 추가 권한 없이 통과한다.
    await expect(
      fake.executes.P1("events.on", {
        name: "settings:changed",
        handlerId: "h",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  /** 가드: 구독도 등록 계약이다 — id를 생략하면 호스트가 만들어 돌려주고, 같은 id로
   * 다시 구독하면 추가가 아니라 치환이다(진단에 「중복 등록」으로 남는다). */
  it("returns a registration id and upserts on the same id", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings", "notes:read"], ["notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    const first = await fake.executes.P1("events.on", {
      name: "note:saved",
      handlerId: "h:1",
    });
    expect((first.result as { id: string }).id).toContain("events.on");
    await fake.executes.P1("events.on", {
      id: "dup",
      name: "note:saved",
      handlerId: "h:2",
    });
    await fake.executes.P1("events.on", {
      id: "dup",
      name: "note:saved",
      handlerId: "h:3",
    });
    expect(
      requestDiagnostics(deps.bus).some(
        (d) => d.kind === "duplicate-registration" && d.call === "events.on",
      ),
    ).toBe(true);
    fireNote(deps.bus, "note:saved");
    // 치환됐으므로 남은 것은 자동 id의 h:1과 dup의 h:3 둘뿐(h:2는 사라졌다).
    expect(fake.invoked.map((i) => i.buttonId)).toEqual(["h:1", "h:3"]);
  });

  /**
   * 가드(무음 실패 표면화): 등록 마감 뒤에 도착한 구독은 이번 실행에서 발화하지 않는다 —
   * 노트 창의 발신 게이트가 빌드 시점에 굳기 때문이다. "안 불린다"는 정상과 구분되지 않으므로
   * 반드시 진단으로 남는다(다른 등록의 늦은 도착과 같은 계약이지만 증상이 더 조용하다).
   */
  it("records a diagnostic when a subscription arrives after registration closed", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings", "notes:read"], ["notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    await fake.executes.P1("events.on", {
      name: "note:saved",
      handlerId: "h:late",
    });
    const late = requestDiagnostics(deps.bus).filter(
      (d) => d.call === "events.on" && d.message.includes("등록 마감"),
    );
    expect(late).toHaveLength(1);
    // 그리고 실제로 발화하지 않는다(게이트가 굳었다) — 진단이 사실과 맞는지까지 본다.
    expect(requestSnapshot(deps.bus, "s4").subscribedEvents).toEqual([]);
  });

  /** 가드: 스냅샷의 구독 목록이 노트 창의 발신 게이트다 — 아무도 구독하지 않으면 비어야
   * 하고(그러면 노트 창은 IPC를 아예 쏘지 않는다), 구독하면 그 이름이 실려야 한다. */
  it("publishes the union of subscribed names in the snapshot", async () => {
    const quiet = makeDeps({
      createSandbox: makeFakeFactory().factory,
      enabledInstalledSources: async () => [src("p1", ["settings"], [], "P1")],
    });
    await mountPluginHost(quiet);
    expect(requestSnapshot(quiet.bus).subscribedEvents).toEqual([]);

    const { deps } = await mountSubscriber("note:focused");
    expect(requestSnapshot(deps.bus, "s2").subscribedEvents).toEqual([
      "note:focused",
    ]);
  });

  /** 가드(핵심): 재빌드는 구독을 전부 버린다 — 이것이 `off`를 주지 않은 근거다. 남으면
   * 재빌드마다 리스너가 쌓여 이벤트가 N배로 발화한다. */
  it("drops all subscriptions on rebuild (no accumulation, no double fire)", async () => {
    let subscribe = true;
    const fake = makeFakeFactory({
      P1: (api) => {
        if (subscribe) {
          void api.execute("events.on", {
            name: "note:saved",
            handlerId: "h:1",
          });
        }
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings", "notes:read"], ["notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    fireNote(deps.bus, "note:saved");
    expect(fake.invoked).toHaveLength(1);

    // 이번 실행에서는 구독하지 않는다 → 이전 빌드의 구독이 살아 있으면 여기서 드러난다.
    subscribe = false;
    deps.bus.emit(EV_NOTES_RELOAD, {});
    await new Promise((r) => setTimeout(r, 0));
    fireNote(deps.bus, "note:saved");
    expect(fake.invoked).toHaveLength(1);
    expect(requestSnapshot(deps.bus, "s3").subscribedEvents).toEqual([]);
  });
});

/** 설정 변경 통지 — 재빌드는 그대로 두고 "내 설정이 바뀐 걸 모른다"만 없앤다. */
describe("설정 변경 통지 — settings:changed", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const schema: PluginSettingField[] = [
    { key: "mode", type: "text", label: "모드", default: "a", options: [] },
  ];

  /** settings:changed를 구독한 플러그인 하나(설정 스키마 포함)를 띄운다. */
  async function mountSettingsSubscriber() {
    const fake = makeFakeFactory({
      P1: (api) => {
        void api.execute("events.on", {
          name: "settings:changed",
          handlerId: "h:cfg",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", { mode: "a" }, schema),
      ],
    });
    await mountPluginHost(deps);
    return { fake, deps };
  }

  /** 가드: 플러그인이 스스로 쓴 값도 통지된다(Chrome storage.onChanged와 같은 이디엄) —
   * 같은 플러그인의 다른 창이 갱신될 유일한 경로다. old/new가 실제로 달라야 쓸모가 있다. */
  it("notifies the plugin about its own settings.set with old and new values", async () => {
    const { fake } = await mountSettingsSubscriber();
    await fake.executes.P1("settings.set", { key: "mode", value: "b" });
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].buttonId).toBe("h:cfg");
    expect(fake.invoked[0].payload).toMatchObject({
      name: "settings:changed",
      key: "mode",
      oldValue: "a",
      newValue: "b",
      origin: "plugin",
    });
  });

  /** 가드(핵심 — 설정 변경 즉시 통지가 겨냥한 결핍): 설정 **화면**에서 바뀐 값도 재빌드를 기다리지 않고
   * 통지된다. 재빌드는 400ms 디바운스라, 이 통지가 없으면 살아 있는 샌드박스는 자기 설정이
   * 바뀐 줄 모른 채 죽는다. */
  it("notifies about a form change before the rebuild, with origin form", async () => {
    const { fake, deps } = await mountSettingsSubscriber();
    deps.bus.emit(EV_PLUGIN_SETTING_CHANGED, {
      pluginId: "p1",
      key: "mode",
      value: "c",
    });
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].payload).toMatchObject({
      key: "mode",
      oldValue: "a",
      newValue: "c",
      origin: "form",
    });
  });

  /** 가드(격리): 남의 플러그인 설정이 바뀐 것은 통지하지 않는다 — 통지 대상은 **자기 키**뿐이다
   * (남의 설정 값이 이 경로로 새면 저위험 settings 권한이 정보 채널이 된다). */
  it("never notifies a plugin about another plugin's setting", async () => {
    const { fake, deps } = await mountSettingsSubscriber();
    deps.bus.emit(EV_PLUGIN_SETTING_CHANGED, {
      pluginId: "다른-플러그인",
      key: "mode",
      value: "c",
    });
    expect(fake.invoked).toHaveLength(0);
  });

  /** 가드: 구독하지 않은 플러그인에는 아무 일도 일어나지 않는다(설정 저장은 그대로 성공). */
  it("stays silent for plugins that never subscribed", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", { mode: "a" }, schema),
      ],
    });
    await mountPluginHost(deps);
    await expect(
      fake.executes.P1("settings.set", { key: "mode", value: "b" }),
    ).resolves.toMatchObject({ ok: true });
    expect(fake.invoked).toHaveLength(0);
  });
});

/** 파괴 직전 정리 — 재빌드가 런타임 상태를 지우기 전에 마지막 기회를 준다. */
describe("파괴 직전 정리 — runtime.onDispose", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** 가드(핵심): 재빌드는 **파괴 전에** 통지하고 기다린다 — 순서가 뒤집히면 onDispose가
   * 이미 죽은 샌드박스에 가서 아무 의미가 없다. */
  it("notifies every sandbox before destroying it on rebuild", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui"], [], "P1"),
        src("p2", ["ui"], [], "P2"),
      ],
    });
    await mountPluginHost(deps);
    expect(fake.disposeNotices).toEqual([]);

    deps.bus.emit(EV_NOTES_RELOAD, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.disposeNotices).toEqual(["P1", "P2"]);
    expect(fake.disposed).toEqual(["P1", "P2"]);
  });

  /** 가드: 정리 중에 부른 설정 저장은 **아직 유효하다**(그것이 flush의 전부다) — 컨텍스트·
   * 대기표 정리가 통지보다 앞서면 이 마지막 저장이 조용히 사라진다. */
  it("still accepts a settings write made during the dispose window", async () => {
    const persistPluginSetting = vi.fn();
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      persistPluginSetting,
      enabledInstalledSources: async () => [
        src("p1", ["settings"], [], "P1", {}, [
          {
            key: "draft",
            type: "text",
            label: "임시",
            default: "",
            options: [],
          },
        ]),
      ],
    });
    await mountPluginHost(deps);
    await fake.executes.P1("settings.set", { key: "draft", value: "마지막" });
    expect(persistPluginSetting).toHaveBeenCalledWith("p1", "draft", "마지막");
  });

  /** 가드: 상한을 넘긴 정리는 파괴를 막지 못하고 진단으로 남는다 — 여기서 무한정 기다리면
   * 설정 변경 한 번에 앱이 멈춘다(그리고 저작자는 왜 잘렸는지 알 근거가 필요하다). */
  it("destroys anyway after the timeout and records a diagnostic", async () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory({
      P1: (api) => api.holdDispose(),
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);

    deps.bus.emit(EV_NOTES_RELOAD, {});
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.disposed).toContain("P1");
    const timeouts = requestDiagnostics(deps.bus).filter(
      (d) => d.code === "DISPOSE_TIMEOUT",
    );
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].call).toBe("runtime.onDispose");
  });
});

/** 매니페스트에 `contributes`·`kind`까지 실을 수 있는 설치 소스(기본 `src`의 확장판). */
function srcWith(
  id: string,
  permissions: string[],
  code: string,
  extra: Record<string, unknown>,
): InstalledPluginSource {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "main.js",
      permissions,
      ...extra,
    },
    code,
    granted: permissions,
  };
}

describe("commands.register — 버튼 없는 명령", () => {
  /**
   * 가드(종단): 등록한 명령이 **스냅샷에 실린다**. 이 배열이 곧 설정 › 단축키 화면의
   * 「플러그인 동작」 행이 되므로, 여기 없으면 사용자는 명령에 키를 배정할 방법이 없다.
   */
  it("puts registered commands into the snapshot", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "upper",
          title: "대문자로",
          run$id: "h:1",
        });
        await api.execute("commands.register", {
          title: "위험한 것",
          destructive: true,
          run$id: "h:2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    const commands = requestSnapshot(deps.bus).plugins[0].commands ?? [];
    expect(commands.map((c) => c.title)).toEqual(["대문자로", "위험한 것"]);
    expect(commands[0].id).toBe("upper");
    // id를 생략하면 호스트가 안정 id를 만들어 준다 — 그 id에 사용자의 배정이 붙는다.
    expect(commands[1].id).toBe("p1:commands.register:1");
    expect(commands[0].destructive).toBeUndefined();
    expect(commands[1].destructive).toBe(true);
    // 핸들러 id는 스냅샷에 실리지 않는다(역호출은 호스트만 한다).
    expect(JSON.stringify(commands)).not.toContain("h:1");
  });

  /**
   * 가드: 창의 상태를 봐야만 판정되는 when 키(note.isEmpty)는 스냅샷의
   * `whenPendingKeys`로 실린다 — 설정 화면 액션 버튼이 창 없는 실행을 요청하기 **전에**
   * "왜 안 되는지"를 말할 유일한 근거다. 정적 키만 있으면 필드 자체가 없다(설정 버튼에서도
   * 그대로 판정되므로 막을 이유가 없다).
   */
  it("surfaces window-dependent when keys as whenPendingKeys in the snapshot", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "sel",
          title: "빈 노트에서만",
          when: ["!note.isEmpty", "platform.macos"],
          run$id: "h:1",
        });
        await api.execute("commands.register", {
          id: "st",
          title: "정적 조건만",
          when: ["platform.macos"],
          run$id: "h:2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    const commands = requestSnapshot(deps.bus).plugins[0].commands ?? [];
    expect(commands[0].whenPendingKeys).toEqual(["note.isEmpty"]);
    expect(commands[1].whenPendingKeys).toBeUndefined();
  });

  /** 가드: `run`(=run$id)·`title`이 없으면 등록 자체가 거부된다 — 눌러도 아무 일도 없는
   * 명령이 단축키 화면에 뜨는 것을 막는다(툴바 버튼의 onClick 계약과 같은 규칙). */
  it("rejects a command without run or title", async () => {
    const responses: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        responses.push(
          await api.execute("commands.register", { title: "핸들러 없음" }),
        );
        responses.push(
          await api.execute("commands.register", { run$id: "h:1" }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(responses.map((r) => r.code)).toEqual([
      "INVALID_ARGS",
      "INVALID_ARGS",
    ]);
    expect(requestSnapshot(deps.bus).plugins[0].commands).toEqual([]);
  });

  /**
   * 가드(종단, 핵심): 노트 창이 `commandId`를 실어 보내면 그 명령의 `run`이 **그 창의**
   * 컨텍스트 토큰과 함께 역호출된다. 이것이 단축키 → 실행의 전 구간이다.
   */
  it("invokes the command handler with the invoking window's context token", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "go",
          title: "가자",
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "go",
      windowLabel: "note-b",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].buttonId).toBe("h:run");
    expect(fake.invoked[0].token).not.toBe("");
    // 모르는 명령 id는 조용히 무시된다(죽은 샌드박스를 역호출하지 않는다).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "없음",
      windowLabel: "note-b",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
  });

  /** 가드: 정적 `when`이 거짓이면 실행하지 않고 **이유를 진단에 남긴다**(사용자에게는
   * "단축키가 먹통"으로만 보이므로 저작자가 볼 흔적이 반드시 있어야 한다). */
  it("skips the command when a static when key is false, and records why", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "mac-only",
          title: "맥 전용",
          when: ["platform.windows"],
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      platform: async () => "macos",
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "mac-only",
      windowLabel: "note-a",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(0);
    const skipped = requestDiagnostics(deps.bus).filter((d) =>
      d.message.includes("when 조건이 맞지 않아"),
    );
    expect(skipped).toHaveLength(1);
  });

  /** 가드: 어휘 밖 키는 등록 시점에 거부된다 — 통과시키면 그 조건이 영원히 평가되지
   * 않는데도 저작자는 성공 응답을 받는다(무음 실패). */
  it("rejects an unknown when key at registration", async () => {
    let response: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        response = await api.execute("commands.register", {
          title: "조건",
          when: ["note.hasSelection"],
          run$id: "h:1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(response!.code).toBe("INVALID_ARGS");
    expect(response!.error).toContain("note.hasSelection");
  });

  /**
   * 가드: `note.isEmpty`는 호스트가 **그 창에 물어봐서** 판정한다 — 정적 키와 달리
   * 빌드 시점에는 알 수 없는 값이라, 창 왕복이 실제로 일어나야 조건이 뜻을 갖는다.
   */
  it("asks the invoking window to evaluate note.isEmpty", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "fill",
          title: "채우기",
          when: ["note.isEmpty"],
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    let content = "이미 쓴 글";
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: { id: "n", path: "/v/n.md", content },
      });
    });
    const fire = async (): Promise<void> => {
      deps.bus.emit(EV_BUTTON_INVOKE, {
        pluginId: "p1",
        commandId: "fill",
        windowLabel: "note-a",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    await fire();
    expect(fake.invoked).toHaveLength(0); // 본문이 있으니 조건 거짓 → 실행 안 함.
    content = "   \n  ";
    await fire();
    expect(fake.invoked).toHaveLength(1); // 공백뿐이면 빈 노트로 본다.
  });

  /** 가드: `destructive` 명령은 그 창에 확인을 물어보고, 취소하면 `run`을 부르지 않는다. */
  it("asks the window for confirmation before a destructive command", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "wipe",
          title: "전부 지우기",
          destructive: true,
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    const asked: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      asked.push(call);
      // 취소(Esc)의 대역 — 팝업이 null을 돌려준다.
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: null,
      });
    });
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "wipe",
      windowLabel: "note-a",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toHaveLength(1);
    expect(asked[0].call).toBe("ui.pickList");
    expect(String(asked[0].args.title)).toContain("전부 지우기");
    expect(fake.invoked).toHaveLength(0);
  });

  /**
   * 가드(회귀): destructive 확인 팝업에는 **보이는 취소 버튼**이 있고, 그것이 첫 액션
   * (=팝업의 기본 포커스)이며, 명시적 「실행」 액션에만 `run`이 불린다.
   *
   * 예전엔 「실행」 하나뿐인 목록이라 취소가 Esc를 아는 사용자에게만 존재했고, 자동 포커스된
   * 「실행」에 Enter/Space가 그대로 먹혀 확인 팝업의 존재 이유(실수 방지)를 스스로 무효화했다.
   */
  it("puts a visible cancel first and runs only on the explicit run action", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "wipe",
          title: "전부 지우기",
          destructive: true,
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    const asked: WindowCallPayload[] = [];
    let answer: unknown = { itemId: "confirm", actionId: "cancel" };
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      asked.push(call);
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: answer,
      });
    });
    const fire = async (): Promise<void> => {
      deps.bus.emit(EV_BUTTON_INVOKE, {
        pluginId: "p1",
        commandId: "wipe",
        windowLabel: "note-a",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    await fire();
    const items = asked[0].args.items as {
      actions?: { id: string; style?: string }[];
    }[];
    // 취소가 첫 액션(기본 포커스), 「실행」은 destructive 스타일(빨강)로 성격을 드러낸다.
    expect(items[0].actions?.map((a) => a.id)).toEqual(["cancel", "run"]);
    expect(items[0].actions?.[1].style).toBe("destructive");
    // 호스트가 검증한 호출 주체가 페이로드에 실린다(창 쪽 플러그인 네임스페이스의 근거).
    expect(asked[0].pluginId).toBe("p1");
    expect(fake.invoked).toHaveLength(0); // 취소 액션 → 실행하지 않는다.
    answer = { itemId: "confirm", actionId: "run" };
    await fire();
    expect(fake.invoked).toHaveLength(1); // 명시적 「실행」에만 실행된다.
  });

  /**
   * 가드(종단): 설정 화면 액션 버튼은 `windowLabel: ""`(창 컨텍스트 없음)으로 온다 —
   * 명령은 **토큰 없이** 실행되고, "마지막 클릭 창"은 오염되지 않는다.
   *
   * 왜 오염이 핵심인가: 빈 라벨을 마지막 클릭 창으로 기억하면 그 뒤 그 플러그인의 모든
   * 폴백 창-스코프 호출이 아무도 없는 창을 향해 타임아웃한다. 설정 버튼 한 번이 그 플러그인의
   * 노트 창 동작을 통째로 망가뜨리는 셈이라, 창 라우팅 사고의 새 입구가 된다.
   */
  it("runs a settings-button command without a window context and keeps the fallback clean", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addToolbarButton", {
          id: "b1",
          label: "B",
          onClick$id: "h:click",
        });
        await api.execute("commands.register", {
          id: "clear",
          title: "캐시 지우기",
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["commands", "ui"], [], "P1"),
      ],
    });
    await mountPluginHost(deps);
    // 먼저 노트 창에서 버튼을 눌러 "마지막 클릭 창"을 note-a로 만든다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "h:click",
      windowLabel: "note-a",
    });
    await Promise.resolve();
    // 그 다음 설정 화면 버튼(창 없음)으로 명령을 실행한다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "clear",
      windowLabel: "",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(2);
    expect(fake.invoked[1].buttonId).toBe("h:run");
    // 토큰이 없다 = 창-스코프 호출은 폴백 계약을 탄다(호스트가 창을 임의로 정하지 않는다).
    expect(fake.invoked[1].token).toBe("");
    // 마지막 클릭 창은 여전히 note-a다 — 토큰 없는 창-스코프 호출이 그리로 간다.
    const asked: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => asked.push(p as WindowCallPayload));
    void fake.executes.P1!("ui.toast", { title: "안녕" }, undefined);
    expect(asked.map((a) => a.windowLabel)).toEqual(["note-a"]);
  });

  /**
   * 가드(회귀): **재빌드가 폴백 창을 지우지 않는다.**
   *
   * 왜 이것이 핵심 흐름인가: 설정 폼에서 값을 하나 저장하면 그 저장 자체가 400ms 뒤 재빌드를
   * 돌린다. 재빌드가 "마지막으로 쓴 창"까지 비우면, 바로 그 폼의 액션 버튼이 쓸 폴백 창이
   * 방금 사라져 창-스코프 호출이 한 건도 나가지 않는다 — 「설정을 고치고 바로 시험해 본다」가
   * 이 버튼의 유일한 자연스러운 사용 흐름이라 사실상 항상 실패했다. 무효가 되는 것은 그
   * 클릭에 발급한 토큰뿐이고, 창 라벨은 리로드를 넘어 유효하다.
   */
  it("keeps the fallback window across a rebuild so the settings button still reaches a note window", async () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addToolbarButton", {
          id: "b1",
          label: "B",
          onClick$id: "h:click",
        });
        await api.execute("commands.register", {
          id: "copy-now",
          title: "지금 복사해 보기",
          run$id: "h:run",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["commands", "ui"], [], "P1"),
      ],
    });
    await mountPluginHost(deps);
    // 노트 창에서 버튼을 눌러 폴백 창(note-a)을 만든다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "h:click",
      windowLabel: "note-a",
    });
    await Promise.resolve();
    // 설정 폼에서 값을 저장한 것과 같은 신호(재빌드).
    deps.bus.emit(EV_NOTES_RELOAD, {});
    await vi.advanceTimersByTimeAsync(400);
    const asked: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => asked.push(p as WindowCallPayload));
    // 그 폼 바로 아래의 액션 버튼(창 컨텍스트 없음)으로 명령을 실행한다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      commandId: "copy-now",
      windowLabel: "",
    });
    await Promise.resolve();
    expect(fake.invoked[fake.invoked.length - 1].buttonId).toBe("h:run");
    // 명령 본문의 창-스코프 호출은 재빌드 뒤에도 그 노트 창으로 배달된다.
    void fake.executes.P1!("ui.toast", { title: "복사했어요" }, undefined);
    expect(asked.map((a) => a.windowLabel)).toEqual(["note-a"]);
    vi.useRealTimers();
  });

  /**
   * 가드: 창이 필요한 두 단계(`when` 판정 · `destructive` 확인)는 설정 버튼 경로에서
   * **실행 전에 거부되고 이유가 진단에 남는다**.
   *
   * 거부 자체보다 중요한 것은 흔적이다 — 없으면 저작자는 "설정 버튼이 먹통"만 보고 원인을
   * 찾을 곳이 없다(불투명 origin이라 devtools도 못 붙는다).
   */
  it("refuses a when/destructive command from the settings screen with a diagnostic", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("commands.register", {
          id: "cond",
          title: "빈 메모에서만",
          when: ["note.isEmpty"],
          run$id: "h:cond",
        });
        await api.execute("commands.register", {
          id: "wipe",
          title: "전부 지우기",
          destructive: true,
          run$id: "h:wipe",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["commands"], [], "P1")],
    });
    await mountPluginHost(deps);
    const asked: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => asked.push(p as WindowCallPayload));
    for (const commandId of ["cond", "wipe"]) {
      deps.bus.emit(EV_BUTTON_INVOKE, {
        pluginId: "p1",
        commandId,
        windowLabel: "",
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(0);
    // 응답할 창이 없는데 물어보지도 않는다(타임아웃만큼 매달리지 않는다).
    expect(asked).toEqual([]);
    const messages = requestDiagnostics(deps.bus)
      .filter((d) => d.message.includes("설정 화면에서"))
      .map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toContain("메모 창의 상태를 봐야");
    expect(messages.join("\n")).toContain("confirm");
  });
});

describe("memo.storage.* — 플러그인 전용 저장소", () => {
  /** 가드: `local`은 백엔드(디스크)로 가고, 번들/설치가 서로 다른 네임스페이스로 갈린다. */
  it("routes the local scope to the disk backend with the builtin flag", async () => {
    const calls: { id: string; key: string; builtin: boolean }[] = [];
    const storage = {
      get: async (id: string, key: string, builtin: boolean) => {
        calls.push({ id, key, builtin });
        return "저장된 값";
      },
      set: async () => {},
      remove: async () => {},
      getAll: async () => ({}),
    };
    let got: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        got = await api.execute("storage.get", { key: "draft" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      storage,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(got!.result).toBe("저장된 값");
    expect(calls).toEqual([{ id: "p1", key: "draft", builtin: false }]);
  });

  /** 가드: `session`은 디스크에 닿지 않고, **재빌드에도 살아남는다**(수명 계약). */
  it("keeps session values in memory across a rebuild", async () => {
    vi.useFakeTimers();
    const storage = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      getAll: vi.fn(async () => ({})),
    };
    let readBack: unknown = "미실행";
    let run = 0;
    const fake = makeFakeFactory({
      P1: async (api) => {
        run += 1;
        if (run === 1) {
          await api.execute("storage.set", {
            key: "cache",
            value: 7,
            scope: "session",
          });
        } else {
          const r = await api.execute("storage.get", {
            key: "cache",
            scope: "session",
          });
          readBack = r.result;
        }
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_NOTES_RELOAD, {});
    await vi.advanceTimersByTimeAsync(400);
    expect(readBack).toBe(7);
    expect(storage.set).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  /** 가드: `window` 스코프는 **그 호출을 낳은 창**으로 격리된다 — A 창에 쓴 값이 B 창에서
   * 보이면 상주 샌드박스 하나가 모든 창을 공유하는 구조에서 상태가 섞인다. */
  it("isolates the window scope per invoking window", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addToolbarButton", {
          id: "b",
          label: "B",
          buttonId: "h:1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "storage"], [], "P1"),
      ],
    });
    await mountPluginHost(deps);
    const exec = fake.executes.P1;
    const tokenFor = (windowLabel: string): string => {
      deps.bus.emit(EV_BUTTON_INVOKE, {
        pluginId: "p1",
        buttonId: "h:1",
        windowLabel,
      });
      return fake.invoked[fake.invoked.length - 1].token;
    };
    const a = tokenFor("note-a");
    const b = tokenFor("note-b");
    await exec("storage.set", { key: "k", value: "A", scope: "window" }, a);
    await exec("storage.set", { key: "k", value: "B", scope: "window" }, b);
    expect(
      (await exec("storage.get", { key: "k", scope: "window" }, a)).result,
    ).toBe("A");
    expect(
      (await exec("storage.getAll", { scope: "window" }, b)).result,
    ).toEqual({ k: "B" });
  });

  /** 가드: 창 컨텍스트가 없으면 창-스코프 호출과 **같은 계약**(조용한 null + 진단)이고,
   * `requireWindow: true`면 코드가 붙은 거부다. */
  it("follows the window-context contract when no window is known", async () => {
    const results: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        results.push(
          await api.execute("storage.get", { key: "k", scope: "window" }),
        );
        results.push(
          await api.execute("storage.get", {
            key: "k",
            scope: "window",
            requireWindow: true,
          }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(results[0]).toEqual({ ok: true, result: null });
    expect(results[1].code).toBe("CONTEXT_UNAVAILABLE");
    expect(
      requestDiagnostics(deps.bus).filter(
        (d) => d.kind === "no-window-context",
      ),
    ).toHaveLength(2);
  });

  /** 가드: 모르는 스코프는 기본값으로 흡수되지 않는다(다른 서랍에 쓰는 무음 손상 차단). */
  it("rejects an unknown scope instead of falling back to local", async () => {
    let got: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        got = await api.execute("storage.set", {
          key: "k",
          value: 1,
          scope: "global",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(got!.code).toBe("INVALID_ARGS");
  });

  /**
   * 가드(계약): 디스크 백엔드가 상한 초과로 거부하면 **`QUOTA_EXCEEDED`가 도착한다**.
   *
   * 왜: Rust는 `Result<T, String>`이라 code 없는 문자열로 거부한다 — 그대로 흘리면
   * 부트스트랩이 `UNKNOWN`으로 채워, 계약(`api-reference.json`)을 믿고 짠
   * `if (e.code === "QUOTA_EXCEEDED") purgeOldest()`가 영원히 안 도는 죽은 코드가 된다.
   */
  it("classifies the disk backend's over-quota rejection as QUOTA_EXCEEDED", async () => {
    let got: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        got = await api.execute("storage.set", {
          key: "cache",
          value: "큰 값",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      storage: {
        get: async () => null,
        // Rust `plugin_storage::save`가 실제로 돌려주는 문구 그대로(code 없는 거부).
        set: async () => {
          throw new Error("저장소 용량 초과: 300000바이트(상한 262144바이트)");
        },
        remove: async () => {},
        getAll: async () => ({}),
      },
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(got!.ok).toBe(false);
    expect(got!.code).toBe("QUOTA_EXCEEDED");
  });

  /** 가드: 상한과 무관한 백엔드 거부는 그대로 둔다(모든 실패를 용량 탓으로 만들지 않는다). */
  it("leaves other backend rejections unclassified", async () => {
    let got: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        got = await api.execute("storage.set", { key: "k", value: 1 });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      storage: {
        get: async () => null,
        set: async () => {
          throw new Error("설치되지 않은 플러그인: p1");
        },
        remove: async () => {},
        getAll: async () => ({}),
      },
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(got!.ok).toBe(false);
    expect(got!.code).toBeUndefined();
  });

  /**
   * 가드(가용성): 메모리 스코프에도 상한이 있다 — 없으면 저위험 권한 하나로 **모든 창이
   * 공유하는 상주 호스트**를 메모리로 죽일 수 있다(그 순간 다른 모든 플러그인도 죽는다).
   */
  it("rejects an over-quota session write and keeps the previous value", async () => {
    const results: BridgeResponse[] = [];
    let readBack: unknown = "미실행";
    const fake = makeFakeFactory({
      P1: async (api) => {
        results.push(
          await api.execute("storage.set", {
            key: "small",
            value: "작은 값",
            scope: "session",
          }),
        );
        results.push(
          await api.execute("storage.set", {
            key: "huge",
            value: "x".repeat(300_000),
            scope: "session",
          }),
        );
        const r = await api.execute("storage.getAll", { scope: "session" });
        readBack = r.result;
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(results[0]).toEqual({ ok: true, result: null });
    expect(results[1].ok).toBe(false);
    expect(results[1].code).toBe("QUOTA_EXCEEDED");
    // 거부는 **거부다**: 넘친 값은 담기지 않고, 이미 있던 값은 그대로다(부분 손상 없음).
    expect(readBack).toEqual({ small: "작은 값" });
  });

  /** 가드: 같은 키를 반복해 덮어써도 서랍 크기는 자라지 않는다(옛 값 자리를 회수한다). */
  it("counts only the current value when a key is overwritten", async () => {
    const results: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        for (let i = 0; i < 5; i += 1) {
          results.push(
            await api.execute("storage.set", {
              key: "cache",
              value: "y".repeat(200_000),
              scope: "session",
            }),
          );
        }
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
  });

  /** 가드: 지운 키의 자리는 돌려받는다(remove 뒤 같은 크기 쓰기가 다시 통과한다). */
  it("frees the removed key's budget", async () => {
    const results: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        const big = { key: "a", value: "z".repeat(200_000), scope: "session" };
        results.push(await api.execute("storage.set", big));
        results.push(await api.execute("storage.set", { ...big, key: "b" }));
        await api.execute("storage.remove", { key: "a", scope: "session" });
        results.push(await api.execute("storage.set", { ...big, key: "c" }));
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["storage"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(results[0].ok).toBe(true);
    expect(results[1].code).toBe("QUOTA_EXCEEDED");
    expect(results[2].ok).toBe(true);
  });

  /** 가드(보안): `storage` 권한을 선언하지 않으면 게이트키퍼가 막는다. */
  it("is gated by the storage permission", async () => {
    let got: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        got = await api.execute("storage.get", { key: "k" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], [], "P1")],
    });
    await mountPluginHost(deps);
    expect(got!.code).toBe("PERMISSION_UNDECLARED");
  });
});

describe("매니페스트 선언형 기여 contributes", () => {
  /**
   * 가드(종단, 핵심): `main.js`가 **비어 있어도** 매니페스트만으로 등록이 이뤄지고,
   * 그때 샌드박스는 **아예 만들어지지 않는다**(이 약속한 부팅 절감).
   */
  it("registers from the manifest alone and skips the sandbox for an empty main.js", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("p1", ["editor"], "   \n", {
          contributes: {
            inlinePatterns: [{ id: "hl", open: "==", close: "==" }],
            completions: [{ id: "c", trigger: "[[" }],
          },
        }),
      ],
    });
    await mountPluginHost(deps);
    expect(fake.created).toEqual([]);
    const plugin = requestSnapshot(deps.bus).plugins[0];
    expect(plugin.patterns.map((p) => p.id)).toEqual(["hl"]);
    expect(plugin.completions.map((c) => c.id)).toEqual(["c"]);
  });

  /** 가드(보안): 선언형이라고 게이트를 건너뛰지 않는다 — 권한을 선언하지 않으면 등록되지
   * 않고 그 사실이 진단에 남는다(JSON이 권한 우회로가 되면 게이트키퍼가 한 곳이라는 모델이
   * 무너진다). */
  it("runs contributions through the same permission gate", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("p1", [], "", {
          contributes: {
            inlinePatterns: [{ id: "hl", open: "==", close: "==" }],
          },
        }),
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).plugins[0].patterns).toEqual([]);
    expect(
      requestDiagnostics(deps.bus).filter(
        (d) => d.code === "PERMISSION_UNDECLARED",
      ),
    ).toHaveLength(1);
  });

  /** 가드: 능력 기여(`windowControls`)도 kind 게이트를 탄다. */
  it("applies the kind gate to windowControls contributions", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("cap", ["window-control"], "", {
          kind: "capability",
          contributes: { windowControls: ["transparency"] },
        }),
        srcWith("act", ["window-control"], "", {
          kind: "action",
          contributes: { windowControls: ["always-on-top"] },
        }),
      ],
    });
    await mountPluginHost(deps);
    expect(requestSnapshot(deps.bus).windowControls).toEqual(["transparency"]);
    expect(
      requestDiagnostics(deps.bus, "d2").filter(
        (d) => d.code === "WRONG_PLUGIN_KIND",
      ),
    ).toHaveLength(1);
  });

  /**
   * 가드: 언어팩 기여(`translations`)는 **아는 종류이되 이 호스트가 나르지 않는다**.
   *
   * 두 가지를 한 번에 못박는다:
   * 1. 진단이 조용하다 — `CONTRIBUTION_KINDS`가 아는 종류라 "모르는 기여 종류" 오탐이 없고,
   *    브리지 호출로 되돌리지 않으므로 게이트 거부(`WRONG_PLUGIN_KIND`)도 나지 않는다.
   *    이 둘 중 하나라도 나면 정상 언어팩이 설치될 때마다 「최근 오류」에 잡음이 쌓인다.
   * 2. 스냅샷에 아무 흔적이 없다 — 언어팩 사전은 각 창과 코어가 직접 읽는다.
   *
   * **kind 게이트 자체가 사라진 것이 아니다.** `kind: "capability"`·`i18n` 권한·활성·플랫폼의
   * 네 조건은 이제 실제로 이 데이터를 읽는 코어가 강제하고(`src-tauri/src/plugin_i18n.rs`의
   * `may_contribute_translations`), 그 커버리지는 같은 파일의 Rust 테스트가 갖는다
   * (`excludes_a_plugin_whose_kind_is_not_capability` 등) — 여기서 검증하던 것을 그쪽이
   * 이어받았다.
   */
  it("treats translations as a known contribution the host neither routes nor carries", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("cap", ["i18n"], "", {
          kind: "capability",
          contributes: {
            translations: [{ locale: "en", label: "English", entries: {} }],
          },
        }),
        srcWith("act", ["i18n"], "", {
          kind: "action",
          contributes: {
            translations: [{ locale: "fr", label: "Français", entries: {} }],
          },
        }),
      ],
    });
    await mountPluginHost(deps);
    const snap = requestSnapshot(deps.bus);
    // 스냅샷 어디에도 로케일 조각이 없다(플러그인 슬롯도 전역도).
    expect(snap.plugins.map((p) => p.pluginId)).toEqual(["cap", "act"]);
    expect(JSON.stringify(snap)).not.toContain("English");
    // 진단은 조용하다 — 오탐(모르는 종류)도, 게이트 거부도 없다.
    expect(
      requestDiagnostics(deps.bus, "d2").filter(
        (d) => d.code === "WRONG_PLUGIN_KIND" || d.code === "INVALID_ARGS",
      ),
    ).toEqual([]);
  });

  /** 가드(우선순위 규칙): 같은 id가 양쪽에 있으면 **매니페스트가 이기고**, 그 사실이
   * 진단에 남는다 — 규칙만 문서에 적고 흔적을 안 남기면 "왜 내 JS 등록이 무시되지"가 된다. */
  it("lets the manifest win over main.js for the same id, and says so", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("editor.registerInlinePattern", {
          id: "dup",
          open: "JS",
          close: "JS",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("p1", ["editor"], "P1", {
          contributes: {
            inlinePatterns: [{ id: "dup", open: "MF", close: "MF" }],
          },
        }),
      ],
    });
    await mountPluginHost(deps);
    const patterns = requestSnapshot(deps.bus).plugins[0].patterns;
    expect(patterns).toHaveLength(1);
    expect(patterns[0].open).toBe("MF");
    expect(
      requestDiagnostics(deps.bus).filter((d) =>
        d.message.includes("선언형이 우선"),
      ),
    ).toHaveLength(1);
  });

  /** 가드: 모르는 기여 종류(오타)는 매니페스트를 거부하지 않되 **침묵하지도 않는다**. */
  it("surfaces an unknown contribution kind as a diagnostic", async () => {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        srcWith("p1", ["editor"], "", {
          contributes: { inlinePattern: [{ id: "x" }] },
        }),
      ],
    });
    await mountPluginHost(deps);
    expect(
      requestDiagnostics(deps.bus).filter((d) =>
        d.message.includes("모르는 기여 종류"),
      ),
    ).toHaveLength(1);
  });
});

describe("컨텍스트 토큰 유휴 만료", () => {
  afterEach(() => vi.useRealTimers());

  /** 이 절 공용 하니스: 창 A·B에서 한 번씩 클릭해 토큰 둘을 받아 둔다. */
  async function mountWithTwoClicks(permissions: string[], granted: string[]) {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", permissions, granted, "P1"),
      ],
    });
    await mountPluginHost(deps);
    const seen: WindowCallPayload[] = [];
    const held: WindowCallPayload[] = [];
    deps.bus.listen(EV_WINDOW_CALL, (p) => {
      const call = p as WindowCallPayload;
      seen.push(call);
      if (call.call === "ui.pickList") {
        held.push(call); // 사용자 응답 대기(보류)
        return;
      }
      deps.bus.emit(EV_WINDOW_RESULT, {
        requestId: call.requestId,
        ok: true,
        result: null,
      });
    });
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const tokenA = fake.invoked[0].token;
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "note-b",
    });
    const tokenB = fake.invoked[1].token;
    return { fake, deps, seen, held, tokenA, tokenB };
  }

  /**
   * 가드(핵심): 마지막 활동 후 유휴 상한(5분)을 넘긴 토큰으로 **민감 권한** 호출을 하면
   * 조용한 null이 아니라 `CONTEXT_UNAVAILABLE`로 거부되고, 어느 창으로도 위임되지 않으며,
   * 진단 채널에 교정 힌트가 남는다.
   */
  it("rejects sensitive calls on an idle-expired token with CONTEXT_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen, tokenA } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    // 만료 전에는 정상 동작한다(경계 확인).
    const before = await fake.executes.P1(
      "clipboard.write",
      { text: "fresh" },
      tokenA,
    );
    expect(before.ok).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    seen.length = 0;
    const res = await fake.executes.P1(
      "clipboard.write",
      { text: "stale" },
      tokenA,
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CONTEXT_UNAVAILABLE");
    expect(seen).toEqual([]); // 폴백도 위임도 없다(조용한 유실이 아니라 시끄러운 거부).
    const diag = requestDiagnostics(deps.bus).filter(
      (d) => d.pluginId === "p1" && d.code === "CONTEXT_UNAVAILABLE",
    );
    expect(diag.length).toBeGreaterThan(0);
    expect(diag[0].message).toContain("만료");
  });

  /** 가드(하위호환 — 제안 원안 3항): 저위험 호출(`ui.toast`)은 만료된 토큰으로도 현행처럼
   *  동작한다. 그리고 그 사용이 활동으로 집계돼 토큰이 되살아난다(유휴 기준의 정의 —
   *  keep-alive는 보장하지 않는 것이 아니라 **의도된 범위 밖**임을 계약으로 못박는다). */
  it("keeps low-risk calls working on an expired token (and use refreshes idle)", async () => {
    vi.useFakeTimers();
    const { fake, seen, tokenA } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    vi.advanceTimersByTime(5 * 60_000 + 1);
    seen.length = 0;
    const toast = await fake.executes.P1("ui.toast", { title: "x" }, tokenA);
    expect(toast.ok).toBe(true);
    expect(seen.map((c) => [c.call, c.windowLabel])).toEqual([
      ["ui.toast", "note-a"],
    ]);
    // 방금의 저위험 사용이 활동이다 — 이어지는 민감 호출은 다시 통과한다.
    const write = await fake.executes.P1(
      "clipboard.write",
      { text: "y" },
      tokenA,
    );
    expect(write.ok).toBe(true);
    expect(seen[seen.length - 1]?.windowLabel).toBe("note-a");
  });

  /**
   * 가드(회귀 — 과거에 실제로 터진 유형): 대화형 팝업(pickList, 최대 10분 대기)이 유휴
   * 상한(5분)보다 **오래** 떠 있다가 응답이 돌아와도, 같은 토큰의 후속 삽입(insertText —
   * 민감)은 만료로 잘리지 않고 그 창에 들어간다. 진행 중(inflight) 보호 + 완료 시
   * `lastUsed` 갱신(unpin)이 함께 있어야 통과한다 — 하나라도 빠지면 "팝업을 오래 열어 둔
   * 사용자의 삽입이 소리 없이(또는 오류로) 사라지는" 회귀다.
   */
  it("does not expire the token of a long-lived interactive popup chain", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen, held, tokenA } = await mountWithTwoClicks(
      ["ui", "notes:write"],
      ["notes:write"],
    );
    const pickA = fake.executes.P1("ui.pickList", { title: "고르기" }, tokenA);
    // 사용자가 8분 고민한다 — 유휴 상한(5분)은 넘겼지만 대화형 상한(10분)은 안 넘겼다.
    vi.advanceTimersByTime(8 * 60_000);
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: held[0].requestId,
      ok: true,
      result: "choice-1",
    });
    const picked = await pickA;
    expect(picked.ok).toBe(true);
    expect(picked.result).toBe("choice-1");
    // 응답 직후의 후속 민감 호출 — 완료가 활동으로 집계됐으므로 만료되지 않는다.
    seen.length = 0;
    const inserted = await fake.executes.P1(
      "editor.insertText",
      { text: "choice-1" },
      tokenA,
    );
    expect(inserted.ok).toBe(true);
    expect(seen.map((c) => [c.call, c.windowLabel])).toEqual([
      ["editor.insertText", "note-a"],
    ]);
  });

  /**
   * 가드(우회 봉쇄 — 실증된 구멍): 토큰을 **아예 싣지 않은** 민감 호출은 "마지막 클릭
   * 창" 폴백을 타는데, 그 폴백에도 같은 유휴 상한이 적용돼야 한다. 안 그러면 만료를 피하는
   * 방법이 "토큰을 빼는 것"이 되고, 그것은 `setTimeout`·`Promise.all` 뒤의 지연 호출에서
   * **기본 동작**이다(부트스트랩이 토큰을 싣지 못한다) — 유휴 만료가 막으려던 "예전 클릭 창을
   * 나중에 타깃"이 폴백 경로로 그대로 남는다.
   */
  it("expires the tokenless fallback for sensitive calls after the idle TTL", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    // 만료 전에는 폴백(마지막 클릭 창 note-b)으로 정상 동작한다(경계 확인).
    const fresh = await fake.executes.P1("clipboard.write", { text: "fresh" });
    expect(fresh.ok).toBe(true);
    expect(seen[seen.length - 1]?.windowLabel).toBe("note-b");

    vi.advanceTimersByTime(5 * 60_000 + 1);
    seen.length = 0;
    const res = await fake.executes.P1("clipboard.write", { text: "stale" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CONTEXT_UNAVAILABLE");
    expect(seen).toEqual([]); // 어느 창으로도 위임되지 않는다(토큰 경로와 같은 시끄러운 거부).
    const diag = requestDiagnostics(deps.bus).filter(
      (d) => d.pluginId === "p1" && d.code === "CONTEXT_UNAVAILABLE",
    );
    expect(diag.length).toBeGreaterThan(0);
    expect(diag[0].message).toContain("만료");
  });

  /** 가드(하위호환 — 토큰 경로와 같은 규칙): 저위험 호출은 만료된 폴백으로도 동작하고,
   *  그 사용이 활동으로 집계돼 폴백이 되살아난다(유휴 기준의 정의 그대로). */
  it("keeps low-risk tokenless calls working after the TTL (use refreshes the fallback)", async () => {
    vi.useFakeTimers();
    const { fake, seen } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    vi.advanceTimersByTime(5 * 60_000 + 1);
    seen.length = 0;
    const toast = await fake.executes.P1("ui.toast", { title: "x" });
    expect(toast.ok).toBe(true);
    expect(seen.map((c) => [c.call, c.windowLabel])).toEqual([
      ["ui.toast", "note-b"],
    ]);
    // 방금의 저위험 사용이 활동이다 — 이어지는 민감 호출은 다시 통과한다.
    const write = await fake.executes.P1("clipboard.write", { text: "y" });
    expect(write.ok).toBe(true);
    expect(seen[seen.length - 1]?.windowLabel).toBe("note-b");
  });

  /**
   * 가드(회귀 — 토큰 경로와 대칭): 토큰 없는 대화형 팝업 체인도 유휴 상한(5분)보다 오래
   * 떠 있다가 응답이 돌아오면, 완료가 활동으로 집계돼 후속 민감 호출이 만료로 잘리지
   * 않는다(unpin의 `lastUsed` 갱신과 같은 계약을 폴백에도 적용).
   */
  it("does not expire the fallback of a long-lived interactive popup chain", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen, held } = await mountWithTwoClicks(
      ["ui", "notes:write"],
      ["notes:write"],
    );
    const pick = fake.executes.P1("ui.pickList", { title: "고르기" });
    vi.advanceTimersByTime(8 * 60_000); // 유휴 상한(5분)은 넘겼지만 대화형 상한(10분)은 아니다.
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: held[0].requestId,
      ok: true,
      result: "choice-1",
    });
    const picked = await pick;
    expect(picked.ok).toBe(true);
    seen.length = 0;
    const inserted = await fake.executes.P1("editor.insertText", {
      text: "choice-1",
    });
    expect(inserted.ok).toBe(true);
    expect(seen.map((c) => [c.call, c.windowLabel])).toEqual([
      ["editor.insertText", "note-b"],
    ]);
  });

  /**
   * 가드(회귀 — 폴백에도 inflight 대칭): 토큰 없는 대화형 팝업이 유휴 상한(5분)을 넘겨
   * **아직 응답 전으로 열려 있는 동안** 같은 플러그인의 다른 민감 폴백 호출이 도착하면,
   * '유휴'로 오판돼 거부되면 안 된다. 진행 중(inflight) 폴백은 만료 대상이 아니다(토큰 경로의
   * `owner.inflight === 0`과 같은 규칙) — 팝업이 응답하기 전이라 완료(unpin)의 `lastUsed`
   * 갱신은 아직 없으므로, inflight 보호만이 이 곁가지 호출을 살린다. (이 가드가 없으면
   * 토큰 경로로는 성공하는 똑같은 코드가 폴백 경로에서만 조용히 거부된다.)
   */
  it("does not expire the fallback while a tokenless popup is still pending", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen, held } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    const pick = fake.executes.P1("ui.pickList", { title: "고르기" }); // 폴백·보류.
    vi.advanceTimersByTime(6 * 60_000); // 유휴 상한(5분) 초과 — 팝업은 아직 응답 전이다.
    seen.length = 0;
    // 팝업이 열린 채 도착한 곁가지 민감 폴백 호출 — inflight 보호로 만료되지 않는다.
    const write = await fake.executes.P1("clipboard.write", { text: "side" });
    expect(write.ok).toBe(true);
    expect(seen.map((c) => [c.call, c.windowLabel])).toEqual([
      ["clipboard.write", "note-b"],
    ]);
    // 정리: 팝업 응답을 흘려보낸다(매달린 프라미스 방지).
    deps.bus.emit(EV_WINDOW_RESULT, {
      requestId: held[0].requestId,
      ok: true,
      result: null,
    });
    await pick;
  });

  /**
   * 가드(회귀): 설정 화면 액션 버튼(`windowLabel: ""`)을 '지금' 눌러 파생된 민감 폴백
   * 호출은, 마지막 노트-창 클릭이 유휴 상한(5분)보다 오래됐어도 통과해야 한다. 버튼 클릭
   * 자체가 '이 플러그인에 대한 지금의 사용자 활동'이므로 폴백의 유휴를 갱신한다(창 라벨은
   * 바꾸지 않는다 — ""를 창으로 기억하면 폴백이 아무도 없는 창으로 타임아웃한다). 안 그러면
   * '고치고 바로 눌러 본다'는 이 버튼의 유일한 자연스러운 흐름이 5분 창으로 좁혀지고, 진단이
   * 처방하는 '새 노트-창 클릭'은 설정 화면에 그 표면이 없어 실행 불가능한 처방이 된다.
   */
  it("refreshes the fallback idle on an empty-label action-button click ", async () => {
    vi.useFakeTimers();
    const { fake, deps, seen } = await mountWithTwoClicks(
      ["ui", "clipboard"],
      ["clipboard"],
    );
    vi.advanceTimersByTime(5 * 60_000 + 1); // 마지막 노트-창 클릭(note-b)이 5분보다 오래됐다.
    // 설정 화면 액션 버튼을 '지금' 누른다 — 창 라벨은 비어 있다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      buttonId: "b",
      windowLabel: "",
    });
    seen.length = 0;
    // 버튼 핸들러가 하는 민감 폴백 호출은 '방금 누른' 활동 기준으로 통과한다.
    const res = await fake.executes.P1("clipboard.write", { text: "now" });
    expect(res.ok).toBe(true);
    expect(seen[seen.length - 1]?.windowLabel).toBe("note-b"); // 창 라벨은 그대로 폴백.
  });
});

describe("notes.list / notes.read (notes:all-read)", () => {
  afterEach(() => vi.useRealTimers());

  /** 이 절 공용 노트 백엔드 대역 — Rust `note_list`/`note_read`의 형태 그대로. */
  const notesFake = {
    list: async () => [
      { id: "n1", title: "첫 노트", hidden: false, created_at: 100 },
      { id: "n2", title: "숨긴 노트", hidden: true, created_at: 200 },
      { id: "n3", title: "셋째", hidden: false, created_at: 300 },
    ],
    read: async (id: string) => {
      if (id === "n1") return { content: "첫 노트\n본문" };
      throw new Error("그런 노트 없음");
    },
    write: async () => {},
  };

  async function mount(
    granted: string[],
    notes: {
      list: () => Promise<
        { id: string; title: string; hidden: boolean; created_at: number }[]
      >;
      read: (id: string) => Promise<{ content: string }>;
      // 이 절의 기존 테스트들은 write를 넣지 않는다 — 아래 mount가 기본 no-op을 채운다.
      write?: (id: string, content: string, mode: string) => Promise<void>;
    } = notesFake,
  ) {
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      notes: { write: async () => {}, ...notes },
      enabledInstalledSources: async () => [
        src("p1", ["notes:all-read"], granted, "P1"),
      ],
    });
    await mountPluginHost(deps);
    return { fake, deps };
  }

  /** 가드(핵심): 창 컨텍스트 없이(호스트 스코프) 전체 메타가 온다 — 숨긴 노트 포함,
   *  본문 없음, 필드는 계약의 camelCase(createdAt)다. */
  it("lists all notes (hidden included, no content) without window context", async () => {
    const { fake } = await mount(["notes:all-read"]);
    const res = await fake.executes.P1("notes.list", {});
    expect(res.ok).toBe(true);
    expect(res.result).toEqual([
      { id: "n1", title: "첫 노트", hidden: false, createdAt: 100 },
      { id: "n2", title: "숨긴 노트", hidden: true, createdAt: 200 },
      { id: "n3", title: "셋째", hidden: false, createdAt: 300 },
    ]);
  });

  /** 가드: limit/offset이 실제로 페이지를 가른다. */
  it("applies limit and offset", async () => {
    const { fake } = await mount(["notes:all-read"]);
    const res = await fake.executes.P1("notes.list", { limit: 1, offset: 1 });
    expect(res.ok).toBe(true);
    expect((res.result as { id: string }[]).map((n) => n.id)).toEqual(["n2"]);
  });

  /** 가드(계약의 상한): limit은 1000으로 클램프된다 — 거부가 아니라 실제 적용치로 접는다. */
  it("clamps limit to the contract maximum (1000)", async () => {
    const many = Array.from({ length: 1005 }, (_, i) => ({
      id: `n${i}`,
      title: `t${i}`,
      hidden: false,
      created_at: i,
    }));
    const { fake } = await mount(["notes:all-read"], {
      list: async () => many,
      read: notesFake.read,
    });
    const res = await fake.executes.P1("notes.list", { limit: 5000 });
    expect(res.ok).toBe(true);
    expect(res.result).toHaveLength(1000);
  });

  /** 가드: 수가 아닌 limit·음수 offset은 기본값으로 흡수하지 않고 INVALID_ARGS다. */
  it("rejects non-numeric limit/offset with INVALID_ARGS", async () => {
    const { fake } = await mount(["notes:all-read"]);
    for (const args of [{ limit: "많이" }, { offset: -1 }, { limit: 0 }]) {
      const res = await fake.executes.P1(
        "notes.list",
        args as Record<string, unknown>,
      );
      expect(res.ok, JSON.stringify(args)).toBe(false);
      expect(res.code, JSON.stringify(args)).toBe("INVALID_ARGS");
    }
  });

  /** 가드: read는 본문만 준다(사이드카 메타 없음 — 페이로드 최소화). */
  it("reads one note's content by id (content only)", async () => {
    const { fake } = await mount(["notes:all-read"]);
    const res = await fake.executes.P1("notes.read", { id: "n1" });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ id: "n1", content: "첫 노트\n본문" });
  });

  /** 가드(지시): 존재하지 않는 id는 조용한 null이 아니라 명확한 코드다. */
  it("rejects an unknown id with NOTE_NOT_FOUND (and empty id with INVALID_ARGS)", async () => {
    const { fake } = await mount(["notes:all-read"]);
    const missing = await fake.executes.P1("notes.read", { id: "ghost" });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("NOTE_NOT_FOUND");
    const empty = await fake.executes.P1("notes.read", {});
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("INVALID_ARGS");
  });

  /**
   * 가드(보안 — 실증된 구멍): 계약은 id를 **불투명 식별자**로 약속한다("경로가 아니고,
   * 경로 해석은 호스트가 독점한다"). 그런데 검증 없이 넘기면 Rust가 `notes/<id>.md`로
   * 이어붙일 때 `../`·절대경로가 vault **밖**의 임의 .md를 가리킨다(경로 인젝션 — 프로브로
   * 재현됨). 경로 형태의 id는 백엔드에 닿기 전에 `INVALID_ARGS`로 거부돼야 한다.
   */
  it("rejects path-shaped ids with INVALID_ARGS before touching the backend", async () => {
    const readSpy = vi.fn(notesFake.read);
    const { fake } = await mount(["notes:all-read"], {
      list: notesFake.list,
      read: readSpy,
    });
    for (const id of [
      "../../../../Users/dong/.ssh/id_rsa",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "..",
      "a..b",
      "C:evil",
    ]) {
      const res = await fake.executes.P1("notes.read", { id });
      expect(res.ok, id).toBe(false);
      expect(res.code, id).toBe("INVALID_ARGS");
    }
    expect(readSpy).not.toHaveBeenCalled();
  });

  /**
   * 가드(IO 비용 상한): `note_list`는 모든 노트의 .md·.json을 읽는 O(전체 노트) 커맨드다 —
   * 플러그인 루프가 브리지로 이것을 무제한 두드리면 호출마다 전체 vault IO가 돈다. 짧은
   * 캐시가 그 비용을 "TTL당 1회"로 접어야 한다(같은 데이터라 결과는 동일).
   */
  it("caches notes.list briefly so call storms cannot multiply full-vault reads", async () => {
    vi.useFakeTimers();
    const listSpy = vi.fn(notesFake.list);
    const { fake } = await mount(["notes:all-read"], {
      list: listSpy,
      read: notesFake.read,
    });
    const first = await fake.executes.P1("notes.list", {});
    expect(first.ok).toBe(true);
    const second = await fake.executes.P1("notes.list", { limit: 1 });
    expect(second.ok).toBe(true);
    expect((second.result as { id: string }[]).map((n) => n.id)).toEqual([
      "n1",
    ]); // limit/offset은 캐시 위에서 여전히 호출별로 적용된다.
    expect(listSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000 + 1); // TTL 경과 → 다음 호출은 새로 읽는다.
    const third = await fake.executes.P1("notes.list", {});
    expect(third.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  /** 가드: 실패한 목록 읽기는 캐시되지 않는다 — 일시 오류가 TTL 동안 눌러앉으면 안 된다. */
  it("does not cache a failed notes.list", async () => {
    let calls = 0;
    const { fake } = await mount(["notes:all-read"], {
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error("일시 오류");
        return notesFake.list();
      },
      read: notesFake.read,
    });
    const failed = await fake.executes.P1("notes.list", {});
    expect(failed.ok).toBe(false);
    const retried = await fake.executes.P1("notes.list", {});
    expect(retried.ok).toBe(true);
    expect(calls).toBe(2);
  });

  /** 가드(양 게이트의 앞쪽): 선언했지만 미부여면 백엔드에 닿기 전에 거부된다 — 민감 권한의
   *  「선언∩부여」가 이 호출에도 그대로 작동함을 통합 경로로 확인한다. */
  it("never reaches the notes backend without the user grant", async () => {
    const listSpy = vi.fn(notesFake.list);
    const { fake } = await mount([], {
      list: listSpy,
      read: notesFake.read,
    });
    const res = await fake.executes.P1("notes.list", {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNGRANTED");
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe("ui.addMenuItem — 메뉴 전용 항목", () => {
  /**
   * 가드(종단): 등록한 메뉴 항목이 **스냅샷에 실린다**(id·label·when·needsSelectedText). 이
   * 배열이 곧 노트 창 우클릭 메뉴의 「플러그인」 구역이 되므로, 여기 없으면 사용자에게 안 보인다.
   * `needsSelectedText`는 등록 시점의 `notes:read` 부여로 굳는다(payload 게이트).
   */
  it("collects menu items into the snapshot; needsSelectedText follows notes:read", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addMenuItem", {
          id: "wrap",
          label: "선택 감싸기",
          when: ["note.hasSelection"],
          run$id: "h:wrap",
        });
        await api.execute("ui.addMenuItem", { label: "항상", run$id: "h:any" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "notes:read"], ["ui", "notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    const menu = requestSnapshot(deps.bus).plugins[0].menuItems ?? [];
    expect(menu.map((m) => m.label)).toEqual(["선택 감싸기", "항상"]);
    expect(menu[0].id).toBe("wrap");
    expect(menu[0].when).toEqual([
      { negated: false, key: "note.hasSelection" },
    ]);
    expect(menu[0].needsSelectedText).toBe(true); // notes:read 부여됨
    // id를 생략하면 호스트가 안정 id를 만든다 — 명령·버튼과 같은 계약.
    expect(menu[1].id).toBe("p1:ui.addMenuItem:1");
    expect(menu[1].when).toBeUndefined();
    // 핸들러 id는 스냅샷에 실리지 않는다(역호출은 호스트만 한다).
    expect(JSON.stringify(menu)).not.toContain("h:wrap");
  });

  /** 가드(payload 게이트): notes:read가 없으면 needsSelectedText가 굳지 않는다(스냅샷 필드 없음). */
  it("does not set needsSelectedText without notes:read", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addMenuItem", { label: "x", run$id: "h:1" });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    const menu = requestSnapshot(deps.bus).plugins[0].menuItems ?? [];
    expect(menu[0].needsSelectedText).toBeUndefined();
  });

  /** 가드: run(=run$id)·label이 없으면 거부된다(눌러도 아무 일 없는 빈 메뉴 줄을 막는다). */
  it("rejects a menu item without run or label", async () => {
    const responses: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        responses.push(
          await api.execute("ui.addMenuItem", { label: "핸들러없음" }),
        );
        responses.push(await api.execute("ui.addMenuItem", { run$id: "h:1" }));
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    expect(responses.map((r) => r.code)).toEqual([
      "INVALID_ARGS",
      "INVALID_ARGS",
    ]);
    expect(requestSnapshot(deps.bus).plugins[0].menuItems).toEqual([]);
  });

  /** 가드(when 어휘): 메뉴 항목의 when은 창 상태 두 키만 — 정적 키는 등록 시점 거부. */
  it("rejects a static when key on a menu item", async () => {
    let response: BridgeResponse | null = null;
    const fake = makeFakeFactory({
      P1: async (api) => {
        response = await api.execute("ui.addMenuItem", {
          label: "맥전용",
          when: ["platform.macos"],
          run$id: "h:1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    expect(response!.code).toBe("INVALID_ARGS");
  });

  /**
   * 가드(종단, 핵심): 노트 창이 `menuItemId`를 실어 보내면 그 항목의 `run`이 **그 창의**
   * 컨텍스트 토큰과 함께 역호출되고, 선택 텍스트는 `notes:read`가 부여됐을 때만 payload에 실린다.
   * 이 분기가 없으면 클릭이 빈 handlerId 폴백으로 떨어져 아무 일도 일어나지 않는다.
   */
  it("invokes the run handler with the window token and gated selectedText", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addMenuItem", {
          id: "wrap",
          label: "감싸기",
          run$id: "h:wrap",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "notes:read"], ["ui", "notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      menuItemId: "wrap",
      windowLabel: "note-b",
      selectedText: "고른 것",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].buttonId).toBe("h:wrap");
    expect(fake.invoked[0].token).not.toBe("");
    expect(fake.invoked[0].payload).toEqual({ selectedText: "고른 것" });
    // 모르는 항목 id는 조용히 무시된다(죽은 샌드박스를 역호출하지 않는다).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      menuItemId: "없음",
      windowLabel: "note-b",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
  });

  /** 가드(payload 게이트, 심층 방어): notes:read가 없으면 창이 선택 텍스트를 실어 보내도 뺀다. */
  it("drops selectedText on invoke when notes:read is not granted", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addMenuItem", {
          id: "wrap",
          label: "감싸기",
          run$id: "h:wrap",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      menuItemId: "wrap",
      windowLabel: "note-b",
      selectedText: "새면 안 되는 본문",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].payload).toEqual({});
  });
});

describe("ui.addSelectionAction — 선택 액션", () => {
  /**
   * 가드(종단): 등록한 선택 액션이 **스냅샷에 실린다**(id·label·title·match·needsSelectedText).
   * 이 배열이 곧 선택 툴바의 액션 버튼이자 단축키 화면의 「플러그인 동작」 행이 되므로, 여기
   * 없으면 두 표면 어디에서도 보이지 않는다. `match`는 창이 **로컬로** 판정할 수 있게 그대로
   * 실려야 한다(그러지 않으면 판정마다 샌드박스로 왕복하게 된다).
   */
  it("collects selection actions into the snapshot with the normalized match", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addSelectionAction", {
          id: "calc",
          label: "=",
          title: "선택 계산",
          match: {
            charClasses: ["digit", "operator", "space"],
            singleLine: true,
            maxLength: 200,
          },
          run$id: "h:calc",
        });
        await api.execute("ui.addSelectionAction", {
          label: "언제나",
          run$id: "h:any",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "notes:read"], ["ui", "notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    const actions = requestSnapshot(deps.bus).plugins[0].selectionActions ?? [];
    expect(actions.map((a) => a.label)).toEqual(["=", "언제나"]);
    expect(actions[0].id).toBe("calc");
    expect(actions[0].title).toBe("선택 계산");
    expect(actions[0].match).toEqual({
      charClasses: ["digit", "operator", "space"],
      singleLine: true,
      maxLength: 200,
    });
    expect(actions[0].needsSelectedText).toBe(true); // notes:read 부여됨
    // id·match·title을 생략하면 호스트가 id만 만들어 준다(버튼·명령과 같은 계약).
    expect(actions[1].id).toBe("p1:ui.addSelectionAction:1");
    expect(actions[1].match).toBeUndefined();
    expect(actions[1].title).toBeUndefined();
    // 핸들러 id는 스냅샷에 실리지 않는다(역호출은 호스트만 한다).
    expect(JSON.stringify(actions)).not.toContain("h:calc");
  });

  /** 가드(payload 게이트): notes:read가 없으면 needsSelectedText가 굳지 않는다(메뉴 항목과 같다). */
  it("does not set needsSelectedText without notes:read", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addSelectionAction", {
          label: "=",
          run$id: "h:1",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    const actions = requestSnapshot(deps.bus).plugins[0].selectionActions ?? [];
    expect(actions[0].needsSelectedText).toBeUndefined();
  });

  /** 가드: run(=run$id)·label이 없으면 거부된다(눌러도 아무 일 없는 빈 버튼을 막는다). */
  it("rejects a selection action without run or label", async () => {
    const responses: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        responses.push(
          await api.execute("ui.addSelectionAction", { label: "핸들러없음" }),
        );
        responses.push(
          await api.execute("ui.addSelectionAction", { run$id: "h:1" }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    expect(responses.map((r) => r.code)).toEqual([
      "INVALID_ARGS",
      "INVALID_ARGS",
    ]);
    expect(requestSnapshot(deps.bus).plugins[0].selectionActions).toEqual([]);
  });

  /**
   * 가드(어휘): `match`는 정규식이 아니라 닫힌 어휘라, 어휘 밖 값은 **등록 시점에** 거부된다.
   * 조용히 버리면 조건이 넓어진(=아무 선택에서나 뜨는) 버튼이 되어 오타가 드러나지 않는다.
   */
  it("rejects a match outside the closed vocabulary", async () => {
    const responses: BridgeResponse[] = [];
    const fake = makeFakeFactory({
      P1: async (api) => {
        responses.push(
          await api.execute("ui.addSelectionAction", {
            label: "=",
            match: { charClasses: ["emoji"] },
            run$id: "h:1",
          }),
        );
        responses.push(
          await api.execute("ui.addSelectionAction", {
            label: "=",
            match: { maxLength: 0 },
            run$id: "h:2",
          }),
        );
        responses.push(
          await api.execute("ui.addSelectionAction", {
            label: "=",
            match: { charClasses: [] },
            run$id: "h:3",
          }),
        );
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    expect(responses.map((r) => r.code)).toEqual([
      "INVALID_ARGS",
      "INVALID_ARGS",
      "INVALID_ARGS",
    ]);
    expect(requestSnapshot(deps.bus).plugins[0].selectionActions).toEqual([]);
  });

  /** 가드(등록 계약): 같은 id 재등록은 추가가 아니라 치환이고, 진단에 「중복 등록」이 남는다. */
  it("upserts on a repeated id and records a duplicate-registration diagnostic", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addSelectionAction", {
          id: "calc",
          label: "=",
          run$id: "h:1",
        });
        await api.execute("ui.addSelectionAction", {
          id: "calc",
          label: "≡",
          run$id: "h:2",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    const actions = requestSnapshot(deps.bus).plugins[0].selectionActions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe("≡");
    const duplicates = requestDiagnostics(deps.bus).filter(
      (d) => d.kind === "duplicate-registration",
    );
    expect(duplicates.map((d) => d.call)).toEqual(["ui.addSelectionAction"]);
    expect(duplicates[0].message).toContain("calc");
  });

  /**
   * 가드(종단, 핵심): 창이 `selectionActionId`를 실어 보내면 그 액션의 `run`이 **그 창의**
   * 컨텍스트 토큰과 함께 역호출되고, 선택 텍스트는 `notes:read`가 부여됐을 때만 payload에
   * 실린다. 이 분기가 없으면 실행이 빈 handlerId 폴백으로 떨어져 아무 일도 일어나지 않는다.
   */
  it("invokes the run handler with the window token and gated selectedText", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addSelectionAction", {
          id: "calc",
          label: "=",
          run$id: "h:calc",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        src("p1", ["ui", "notes:read"], ["ui", "notes:read"], "P1"),
      ],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      selectionActionId: "calc",
      windowLabel: "note-b",
      selectedText: "1+1",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].buttonId).toBe("h:calc");
    expect(fake.invoked[0].token).not.toBe("");
    expect(fake.invoked[0].payload).toEqual({ selectedText: "1+1" });
    // 모르는 액션 id는 조용히 무시된다(죽은 샌드박스를 역호출하지 않는다).
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      selectionActionId: "없음",
      windowLabel: "note-b",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
  });

  /** 가드(payload 게이트, 심층 방어): notes:read가 없으면 창이 실어 보내도 호스트가 뺀다. */
  it("drops selectedText on invoke when notes:read is not granted", async () => {
    const fake = makeFakeFactory({
      P1: async (api) => {
        await api.execute("ui.addSelectionAction", {
          id: "calc",
          label: "=",
          run$id: "h:calc",
        });
      },
    });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [src("p1", ["ui"], ["ui"], "P1")],
    });
    await mountPluginHost(deps);
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "p1",
      selectionActionId: "calc",
      windowLabel: "note-b",
      selectedText: "새면 안 되는 본문",
    });
    await Promise.resolve();
    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].payload).toEqual({});
  });
});

describe("notes.write — 임의 노트 직접 쓰기", () => {
  function mountWrite(
    granted: string[],
    writeImpl?: (id: string, content: string, mode: string) => Promise<void>,
  ) {
    const writeSpy = vi.fn(writeImpl ?? (async () => {}));
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      notes: {
        list: async () => [],
        read: async () => ({ content: "" }),
        write: writeSpy,
      },
      enabledInstalledSources: async () => [
        src("p1", ["notes:write"], granted, "P1"),
      ],
    });
    return { fake, deps, writeSpy };
  }

  /** 가드(종단): append/overwrite가 백엔드로 전달된다. mode 생략은 비파괴 append다. */
  it("forwards append/overwrite to the backend; default mode is append", async () => {
    const { fake, deps, writeSpy } = mountWrite(["notes:write"]);
    await mountPluginHost(deps);
    expect(
      (await fake.executes.P1("notes.write", { id: "n1", content: "덧붙임" }))
        .ok,
    ).toBe(true);
    expect(writeSpy).toHaveBeenLastCalledWith("n1", "덧붙임", "append");
    await fake.executes.P1("notes.write", {
      id: "n1",
      content: "전체",
      mode: "overwrite",
    });
    expect(writeSpy).toHaveBeenLastCalledWith("n1", "전체", "overwrite");
  });

  /**
   * 가드(데이터 안전): 쓰기가 성공하면 그 노트 id로 EV_NOTE_RESTORED를 방송한다 — 열려 있는
   * 노트 창이 낡은 버퍼를 디스크에서 다시 읽어(main.ts 리스너), 그 창의 다음 자동저장이
   * 방금 플러그인이 쓴 본문을 조용히·복구 불가로 덮지 않게 한다. 백엔드 거부 시에는 방송하지
   * 않는다(쓴 것이 없으므로).
   */
  it("broadcasts EV_NOTE_RESTORED for the written note id on success", async () => {
    const { fake, deps, writeSpy } = mountWrite(["notes:write"]);
    const restored: unknown[] = [];
    deps.bus.listen(EV_NOTE_RESTORED, (p) => restored.push(p));
    await mountPluginHost(deps);
    expect(
      (await fake.executes.P1("notes.write", { id: "n1", content: "덧붙임" }))
        .ok,
    ).toBe(true);
    expect(restored).toEqual([{ id: "n1" }]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  /** 가드: 백엔드 거부 시에는 EV_NOTE_RESTORED를 방송하지 않는다(쓴 것이 없다). */
  it("does not broadcast EV_NOTE_RESTORED when the backend rejects", async () => {
    const { fake, deps } = mountWrite(["notes:write"], async () => {
      throw new Error("그런 노트 없음");
    });
    const restored: unknown[] = [];
    deps.bus.listen(EV_NOTE_RESTORED, (p) => restored.push(p));
    await mountPluginHost(deps);
    await fake.executes.P1("notes.write", { id: "n1", content: "x" });
    expect(restored).toEqual([]);
  });

  /** 가드(경계): 빈 id·경로 형태 id·비문자 content·모르는 mode는 백엔드에 닿기 전에 거부된다. */
  it("rejects bad id/content/mode before touching the backend", async () => {
    const { fake, deps, writeSpy } = mountWrite(["notes:write"]);
    await mountPluginHost(deps);
    const cases: Record<string, unknown>[] = [
      { id: "", content: "x" }, // 빈 id
      { id: "../evil", content: "x" }, // 경로 상위 이동
      { id: "a/b", content: "x" }, // 구분자
      { id: "n1", content: 123 }, // 비문자 content
      { id: "n1", content: "x", mode: "delete" }, // 모르는 mode
    ];
    for (const args of cases) {
      const res = await fake.executes.P1("notes.write", args);
      expect(res.ok, JSON.stringify(args)).toBe(false);
      expect(res.code, JSON.stringify(args)).toBe("INVALID_ARGS");
    }
    expect(writeSpy).not.toHaveBeenCalled();
  });

  /** 가드: 백엔드 거부(없는 노트 등)는 NOTE_NOT_FOUND로 분류된다(notes.read와 같은 관례). */
  it("maps a backend rejection to NOTE_NOT_FOUND", async () => {
    const { fake, deps } = mountWrite(["notes:write"], async () => {
      throw new Error("그런 노트 없음");
    });
    await mountPluginHost(deps);
    const res = await fake.executes.P1("notes.write", {
      id: "n1",
      content: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("NOTE_NOT_FOUND");
  });

  /**
   * 가드(데이터 안전 — 용량): 1MiB를 넘는 content는 백엔드에 닿기 전에 INVALID_ARGS로 거부된다.
   * overwrite는 이전 본문 전체를 스냅샷하므로 상한이 없으면 대용량 반복 쓰기가 노트당 스냅샷
   * 사본을 통째로 키운다(개수 상한은 사본 수만 묶고 크기는 못 묶는다). 상한 이하는 통과한다.
   */
  it("rejects content larger than the byte cap before touching the backend", async () => {
    const { fake, deps, writeSpy } = mountWrite(["notes:write"]);
    await mountPluginHost(deps);
    const tooBig = "a".repeat(1024 * 1024 + 1); // 1MiB + 1바이트(ASCII → 바이트=문자 수)
    const res = await fake.executes.P1("notes.write", {
      id: "n1",
      content: tooBig,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_ARGS");
    expect(writeSpy).not.toHaveBeenCalled();
    // 상한 이하(정확히 1MiB)는 통과한다(경계 포함).
    const atCap = "a".repeat(1024 * 1024);
    expect(
      (await fake.executes.P1("notes.write", { id: "n1", content: atCap })).ok,
    ).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  /** 가드(권한): notes:write를 선언만 하고 부여받지 못하면 게이트가 막고 백엔드는 안 불린다. */
  it("requires the notes:write grant", async () => {
    const { fake, deps, writeSpy } = mountWrite([]);
    await mountPluginHost(deps);
    const res = await fake.executes.P1("notes.write", {
      id: "n1",
      content: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNGRANTED");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("network.fetch — 호스트 중계", () => {
  type NetSpy = ReturnType<
    typeof vi.fn<
      (
        url: string,
        method: string,
        headers: { name: string; value: string }[],
        body: string | null,
      ) => Promise<{
        status: number;
        headers: { name: string; value: string }[];
        body: string;
      }>
    >
  >;

  function mountNet(
    granted: string[],
    fetchImpl?: (
      url: string,
      method: string,
      headers: { name: string; value: string }[],
      body: string | null,
    ) => Promise<{
      status: number;
      headers: { name: string; value: string }[];
      body: string;
    }>,
  ) {
    const fetchSpy: NetSpy = vi.fn(
      fetchImpl ?? (async () => ({ status: 200, headers: [], body: "ok" })),
    );
    const fake = makeFakeFactory();
    const deps = makeDeps({
      createSandbox: fake.factory,
      network: { fetch: fetchSpy },
      enabledInstalledSources: async () => [
        src("p1", ["network:api.example.com"], granted, "P1"),
      ],
    });
    return { fake, deps, fetchSpy };
  }

  /** 가드(종단): 승인된 호스트로 URL·메서드·헤더·본문이 백엔드로 그대로 전달된다. */
  it("forwards url/method/headers/body to the backend", async () => {
    const { fake, deps, fetchSpy } = mountNet(["network:api.example.com"]);
    await mountPluginHost(deps);
    const res = await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/v1/x",
      method: "post",
      headers: [{ name: "Accept", value: "application/json" }],
      body: '{"a":1}',
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ status: 200, headers: [], body: "ok" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/v1/x",
      "post",
      [{ name: "Accept", value: "application/json" }],
      '{"a":1}',
    );
  });

  /** 가드: method 생략은 GET, body 생략은 null, headers 생략은 빈 배열로 백엔드에 간다. */
  it("defaults method to GET, body to null, headers to []", async () => {
    const { fake, deps, fetchSpy } = mountNet(["network:api.example.com"]);
    await mountPluginHost(deps);
    await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/ping",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/ping",
      "GET",
      [],
      null,
    );
  });

  /** 가드: name·value가 문자열이 아닌 헤더 항목은 버리고, 배열이 아닌 headers는 거부한다. */
  it("drops malformed header entries and rejects non-array headers", async () => {
    const { fake, deps, fetchSpy } = mountNet(["network:api.example.com"]);
    await mountPluginHost(deps);
    await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/x",
      headers: [
        { name: "Accept", value: "text/plain" },
        { name: "Bad", value: 123 },
        { nope: "x" },
      ],
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://api.example.com/x",
      "GET",
      [{ name: "Accept", value: "text/plain" }],
      null,
    );
    const bad = await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/x",
      headers: { Accept: "text/plain" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("INVALID_ARGS");
  });

  /** 가드: 비문자 body는 백엔드에 닿기 전에 INVALID_ARGS로 거부된다(구조화 값은 못 보낸다). */
  it("rejects a non-string body before touching the backend", async () => {
    const { fake, deps, fetchSpy } = mountNet(["network:api.example.com"]);
    await mountPluginHost(deps);
    const res = await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/x",
      body: { a: 1 },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_ARGS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** 가드(핵심): 백엔드의 NET_* 토큰이 각각 구분되는 MemoErrorCode로 맵된다. */
  it("maps backend NET_* tokens to distinct MemoErrorCodes", async () => {
    const cases: [string, string][] = [
      ["NET_BLOCKED_ADDRESS: 사설대역", "NETWORK_BLOCKED"],
      ["NET_SCHEME: https만", "NETWORK_SCHEME"],
      ["NET_TIMEOUT: 시간 초과", "NETWORK_TIMEOUT"],
      ["NET_TOO_LARGE: 너무 큼", "NETWORK_TOO_LARGE"],
      ["NET_DNS: 해석 실패", "NETWORK_DNS"],
      ["NET_METHOD: 안 됨", "NETWORK_METHOD"],
      ["NET_INVALID_URL: 형식", "NETWORK_INVALID_URL"],
      ["NET_REQUEST: 연결 거부", "NETWORK_FAILED"],
      ["NET_TOO_MANY_REQUESTS: 동시 DNS 상한", "NETWORK_TOO_MANY_REQUESTS"],
      ["뭔가 다른 오류", "NETWORK_FAILED"],
    ];
    for (const [message, expected] of cases) {
      const { fake, deps } = mountNet(["network:api.example.com"], async () => {
        throw new Error(message);
      });
      await mountPluginHost(deps);
      const res = await fake.executes.P1("network.fetch", {
        url: "https://api.example.com/x",
      });
      expect(res.ok, message).toBe(false);
      expect(res.code, message).toBe(expected);
    }
  });

  /** 가드(권한): 호스트를 승인받지 못하면 게이트가 막고 백엔드는 안 불린다. */
  it("requires the network:<host> grant for the URL host", async () => {
    const { fake, deps, fetchSpy } = mountNet([]); // 선언만, 미부여
    await mountPluginHost(deps);
    const res = await fake.executes.P1("network.fetch", {
      url: "https://api.example.com/x",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNGRANTED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * 가드(스레드풀 고갈 방지): 진행 중 fetch가 플러그인당 상한(6)에 차면 다음 호출은 큐잉 없이
   * 즉시 `NETWORK_TOO_MANY_REQUESTS`로 거부되고 백엔드는 안 불린다. 하나가 끝나 슬롯이
   * 반납되면 다음 호출이 다시 백엔드까지 간다(슬롯 누수 없음).
   */
  it("caps concurrent fetches per plugin and releases slots on completion", async () => {
    // 백엔드를 pending 상태로 붙잡아 in-flight를 인위로 유지한다(gate로 하나씩 완료).
    const gate: Array<() => void> = [];
    const { fake, deps, fetchSpy } = mountNet(
      ["network:api.example.com"],
      () =>
        new Promise((resolve) => {
          gate.push(() => resolve({ status: 200, headers: [], body: "ok" }));
        }),
    );
    await mountPluginHost(deps);
    const call = () =>
      fake.executes.P1("network.fetch", { url: "https://api.example.com/x" });

    // 상한(6)까지 채운다 — 전부 백엔드로 들어가 pending 상태로 남는다.
    const inflight = Array.from({ length: 6 }, () => call());
    await new Promise((r) => setTimeout(r, 0)); // 마이크로태스크 배출.
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // 7번째는 큐잉 없이 즉시 거부(백엔드 호출 수는 그대로 6).
    const overflow = await call();
    expect(overflow.ok).toBe(false);
    expect(overflow.code).toBe("NETWORK_TOO_MANY_REQUESTS");
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // 하나를 끝내면 슬롯이 반납돼 다음 호출이 백엔드까지 간다(백엔드 호출 수가 7로 는다).
    // `after`는 여기서 await하지 않는다 — 그 백엔드도 pending이라 지금 기다리면 교착한다.
    gate[0]();
    await inflight[0];
    const after = call();
    await new Promise((r) => setTimeout(r, 0)); // 마이크로태스크 배출.
    expect(fetchSpy).toHaveBeenCalledTimes(7);

    // 정리: 남은 pending을 전부 풀어 테스트가 매달리지 않게 한다.
    for (const release of gate) release();
    await Promise.all([...inflight, after]);
  });
});

describe("commands.invoke — 플러그인 간 호출", () => {
  afterEach(() => vi.useRealTimers());
  /** 대상 B(명령 두 개 등록: cmd1 공개·cmd2 비공개, 그리고 exposes에만 있는 ghost는 미등록). */
  const bScript = async (api: FakeScriptApi) => {
    await api.execute("commands.register", {
      id: "cmd1",
      title: "B의 공개 명령",
      run$id: "hb1",
    });
    await api.execute("commands.register", {
      id: "cmd2",
      title: "B의 비공개 명령",
      run$id: "hb2",
    });
  };
  /** B 소스(명령 cmd1·ghost를 공개) — src()는 exposes를 모르므로 매니페스트를 직접 얹는다. */
  const bSource: InstalledPluginSource = {
    manifest: {
      id: "b",
      name: "b",
      version: "1.0.0",
      entry: "main.js",
      permissions: ["commands"],
      exposes: ["cmd1", "ghost"],
    },
    code: "B",
    granted: [],
  };
  /** 호출측 소스 헬퍼: invoke:<대상> 권한을 선언·부여(민감이라 granted에도 넣어야 통과). */
  const caller = (
    id: string,
    declared: string[],
    granted: string[],
  ): InstalledPluginSource => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "main.js",
      permissions: declared,
    },
    code: id.toUpperCase(),
    granted,
  });

  /**
   * 가드(종단, 핵심): A가 B의 **공개** 명령을 부르면 중앙 호스트가 B의 등록된 핸들러를 그
   * 명령의 handlerId·A가 보낸 args와 함께 역호출하고, A에는 null을 돌려준다. 두 샌드박스는
   * 직접 통신하지 않는다 — 릴레이는 오직 중앙 호스트를 거친다. 이것이 플러그인 간 호출의 전 구간이다.
   */
  it("relays A→(host)→B: dispatches B's exposed command with A's args, returns null", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      // B를 먼저 실어 A가 부를 때 살아있게 한다(배열 순서 = 로드 순서).
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.A("commands.invoke", {
      pluginId: "b",
      commandId: "cmd1",
      args: { x: 1 },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
    // B의 cmd1 핸들러(hb1)가 A가 보낸 페이로드와 함께 역호출됐다.
    const dispatched = fake.invoked.filter(
      (i) => i.code === "B" && i.buttonId === "hb1",
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].payload).toEqual({ x: 1 });
  });

  /** 가드: experimental 호출이 실제로 실행되면 진단 채널에 경고가 남는다(관측 가능) —
   * 조용한 표식이 아니다. 거부가 아니라 경고이므로 성공 경로에서 난다. */
  it("records an experimental-call diagnostic when commands.invoke runs", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    await fake.executes.A("commands.invoke", {
      pluginId: "b",
      commandId: "cmd1",
    });
    const warns = requestDiagnostics(deps.bus).filter(
      (d) => d.pluginId === "a" && d.kind === "experimental-call",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].call).toBe("commands.invoke");
  });

  /** 가드(보안): 대상이 공개하지 않은 명령은 자격(invoke:b)이 있어도 거부된다 — 공개는
   * 대상의 명시적 동의라, 등록됐다는 사실만으로는 부를 수 없다. */
  it("rejects a registered-but-not-exposed command with INVOKE_NOT_EXPOSED", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.A("commands.invoke", {
      pluginId: "b",
      commandId: "cmd2", // 등록은 됐지만 exposes에 없다.
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVOKE_NOT_EXPOSED");
    // 어떤 핸들러도 역호출되지 않았다.
    expect(fake.invoked.filter((i) => i.code === "B")).toHaveLength(0);
  });

  /** 가드: 공개는 됐지만 런타임에 등록되지 않은 명령(ghost)은 미공개와 구분되는 코드로
   * 거부된다 — "부를 것이 없다"와 "부를 자격이 없다"는 다른 실패다. */
  it("rejects an exposed-but-unregistered command with INVOKE_NO_TARGET", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.A("commands.invoke", {
      pluginId: "b",
      commandId: "ghost", // exposes엔 있지만 commands.register를 안 했다.
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVOKE_NO_TARGET");
  });

  /** 가드(보안): 자격(invoke:<대상>)을 선언하지 않은 대상은 부를 수 없다 — 게이트키퍼가
   * 유도 권한으로 막는다(network.fetch가 URL 호스트로 막는 것과 같은 결). */
  it("rejects invoking a target the caller did not declare invoke:<target> for", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    // A는 invoke:b만 선언했다 — 다른 대상은 미선언이다.
    const res = await fake.executes.A("commands.invoke", {
      pluginId: "other",
      commandId: "cmd1",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNDECLARED");
  });

  /** 가드(보안): 선언했지만 사용자가 부여하지 않은 자격은 통과하지 못한다(민감 권한). */
  it("rejects invoking when invoke:<target> is declared but not granted", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("d", ["invoke:b"], []), // 선언은 있고 부여는 없다.
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.D("commands.invoke", {
      pluginId: "b",
      commandId: "cmd1",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PERMISSION_UNGRANTED");
  });

  /** 가드: 형식 오류(commandId 누락)는 권한·릴레이 판정 전에 INVALID_ARGS로 끝난다. */
  it("rejects missing commandId with INVALID_ARGS before touching the target", async () => {
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.A("commands.invoke", { pluginId: "b" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_ARGS");
  });

  /**
   * 가드(보안 — 세탁 봉쇄): commands.invoke는 민감 호출(게이트가 민감 접두 `invoke:<대상>`)
   * 이므로 호출측 창 컨텍스트가 유휴 상한(5분)을 넘기면 `CONTEXT_UNAVAILABLE`로 거부돼야 한다.
   * 대상이 실제로 행동할 창은 호출측의 이 토큰에서 파생되므로, 만료된(오래된 클릭의) 창 권한이
   * 플러그인 경계를 넘어 세탁되면 A는 5분 뒤에도 B를 A의 옛 창으로 부려 그 창의 노트를 읽거나
   * 쓸 수 있다 — 유휴 만료가 막으려던 바로 그 "예전 클릭 창을 노린 지연 호출"의 크로스-플러그인 변종.
   * 만료 뒤에는 대상 B의 핸들러가 역호출되지 않고, 진단에 교정 힌트가 남는다.
   */
  it("rejects invoke on an idle-expired caller context with CONTEXT_UNAVAILABLE ", async () => {
    vi.useFakeTimers();
    const fake = makeFakeFactory({ B: bScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        bSource,
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    // A가 note-a 창에서 클릭해 컨텍스트 토큰을 받는다.
    deps.bus.emit(EV_BUTTON_INVOKE, {
      pluginId: "a",
      buttonId: "b",
      windowLabel: "note-a",
    });
    const token = fake.invoked.find((i) => i.code === "A")?.token ?? "";
    expect(token).not.toBe("");

    // 만료 전에는 정상 릴레이된다(경계 확인) — B의 cmd1 핸들러가 역호출된다.
    const before = await fake.executes.A(
      "commands.invoke",
      { pluginId: "b", commandId: "cmd1" },
      token,
    );
    expect(before.ok).toBe(true);
    expect(
      fake.invoked.filter((i) => i.code === "B" && i.buttonId === "hb1"),
    ).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const res = await fake.executes.A(
      "commands.invoke",
      { pluginId: "b", commandId: "cmd1" },
      token,
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CONTEXT_UNAVAILABLE");
    // 대상 B의 핸들러는 더 이상 역호출되지 않는다(만료된 창 권한이 세탁되지 않았다).
    expect(
      fake.invoked.filter((i) => i.code === "B" && i.buttonId === "hb1"),
    ).toHaveLength(1);
    const diag = requestDiagnostics(deps.bus).filter(
      (d) => d.pluginId === "a" && d.code === "CONTEXT_UNAVAILABLE",
    );
    expect(diag.length).toBeGreaterThan(0);
    expect(diag[0].message).toContain("만료");
  });

  /**
   * 가드(회귀 — 사이드로드 배선): 설치(사이드로드) 경로의 `exposes`가 IPC 레코드 경계
   * (`installedSourceFromRecord`)를 넘어 살아 흐른다 — 이 경로로 만든 대상 B의 공개 명령을
   * A가 실제로 부를 수 있다. 이전엔 Rust `InstalledPlugin`에 `exposes` 필드 자체가 없어
   * 레코드에 값이 실리지 못했고(백엔드가 항상 생략) 설치 플러그인의 공개가 항상
   * `INVOKE_NOT_EXPOSED`로 죽었다(번들만 멀쩡한 비대칭). 이 절의 다른 테스트는 매니페스트를
   * 직접 주입해 이 레코드 경계를 우회하므로 그 결함을 잡지 못했다 — 이 테스트가 그 경계를 탄다.
   */
  it("carries exposes through the sideload record boundary (installedSourceFromRecord)", async () => {
    const fake = makeFakeFactory({ B: bScript });
    // 백엔드 스캔(`scan_installed_report`)이 이제 실어 보내는 레코드 형태를 그대로 흉내낸다.
    const bRecord: InstalledPlugin = {
      id: "b",
      name: "b",
      version: "1.0.0",
      permissions: ["commands"],
      enabled: true,
      granted: [],
      settings_schema: [],
      settings: {},
      exposes: ["cmd1", "ghost"],
    };
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [
        installedSourceFromRecord(bRecord, "B"),
        caller("a", ["invoke:b"], ["invoke:b"]),
      ],
    });
    await mountPluginHost(deps);
    const res = await fake.executes.A("commands.invoke", {
      pluginId: "b",
      commandId: "cmd1",
      args: { x: 2 },
    });
    expect(res.ok).toBe(true);
    const dispatched = fake.invoked.filter(
      (i) => i.code === "B" && i.buttonId === "hb1",
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].payload).toEqual({ x: 2 });
  });

  /**
   * 가드(보안 회귀 — 창 없는 순환 방어): 릴레이 깊이(relayDepth)가 **창 컨텍스트가 한 번도
   * 확립되지 않은** 호출 체인에서도 홉마다 누적돼 상한(MAX_INVOKE_DEPTH=8)에서 끊겨야 한다.
   * 트레이 항목(invokeTrayItem이 `""` 토큰을 하드코딩)·설정 화면 액션 버튼처럼
   * 창이 없는 진입점에서 시작된 A→A(또는 A→B→A) 순환은, 예전엔 대상 토큰이 windowLabel==""
   * 이라 발급조차 되지 않아(targetToken="") 다음 홉의 깊이가 매번 0으로 리셋됐다 — 상한이
   * 결코 걸리지 않아 두 무해한 플러그인의 트레이 클릭 하나가 앱을 무한 async 핑퐁으로 몰 수
   * 있었다. 여기서는 빈 토큰으로 릴레이를 시작해 홉마다 발급되는 깊이 반송 전용 토큰을 잇고,
   * 8홉까지만 성공한 뒤 9홉째가 INVOKE_CYCLE로 끊기며 그 홉은 핸들러를 역호출하지 않음을 확인한다.
   */
  it("caps a windowless (empty-token) invoke cycle at MAX_INVOKE_DEPTH (tray-style, 회귀)", async () => {
    const MAX_INVOKE_DEPTH = 8; // central-host.ts의 상한과 같은 값(비수출 상수).
    // A는 자기 명령 loop를 공개하고 자신을 invoke할 자격을 가진다(자기 순환 = 최소 재현).
    const aScript = async (api: FakeScriptApi) => {
      await api.execute("commands.register", {
        id: "loop",
        title: "loop",
        run$id: "ha",
      });
    };
    const aSource: InstalledPluginSource = {
      manifest: {
        id: "a",
        name: "a",
        version: "1.0.0",
        entry: "main.js",
        permissions: ["commands", "invoke:a"],
        exposes: ["loop"],
      },
      code: "A",
      granted: ["invoke:a"],
    };
    const fake = makeFakeFactory({ A: aScript });
    const deps = makeDeps({
      createSandbox: fake.factory,
      enabledInstalledSources: async () => [aSource],
    });
    await mountPluginHost(deps);

    const handlerInvokes = () =>
      fake.invoked.filter((i) => i.code === "A" && i.buttonId === "ha");

    // invokeTrayItem이 하드코딩하는 것과 같은 빈 토큰(창 컨텍스트 없음)으로 릴레이를 시작한다.
    let token = "";
    for (let hop = 1; hop <= MAX_INVOKE_DEPTH; hop++) {
      const res = await fake.executes.A(
        "commands.invoke",
        { pluginId: "a", commandId: "loop" },
        token,
      );
      expect(res.ok).toBe(true);
      const inv = handlerInvokes();
      expect(inv).toHaveLength(hop);
      // 빈 창이어도 깊이 반송용 토큰이 발급돼 다음 홉으로 깊이가 이어진다(핵심 회귀 지점).
      token = inv[inv.length - 1].token;
      expect(token).not.toBe("");
    }
    // 상한만큼 성공한 뒤, 다음 홉은 창 없는 체인에서도 순환 방어로 끊긴다.
    const capped = await fake.executes.A(
      "commands.invoke",
      { pluginId: "a", commandId: "loop" },
      token,
    );
    expect(capped.ok).toBe(false);
    expect(capped.code).toBe("INVOKE_CYCLE");
    // 끊긴 홉은 핸들러를 역호출하지 않았다 — 무한 핑퐁이 실제로 멈췄다.
    expect(handlerInvokes()).toHaveLength(MAX_INVOKE_DEPTH);
  });
});
