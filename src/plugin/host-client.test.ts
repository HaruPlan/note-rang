/**
 * 호스트 클라이언트 가드 — 스냅샷 요청/폴백, per-plugin 임베드 게이트 유지, 창-스코프
 * 호출 수행부(NaN 방어 포함), 버튼 위임 배선.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  attachWindowCallHandler,
  buildExtensionsFromSnapshot,
  collectPluginStyleCss,
  embedGateFor,
  gatePatternActions,
  executeWindowCall,
  fetchHostSnapshot,
  raceSnapshot,
  noteEventEmitter,
  snapshotSelectionActions,
  snapshotToolbarButtons,
} from "./host-client";
import {
  EV_BUTTON_INVOKE,
  EV_PLUGIN_EVENT,
  EV_SNAPSHOT,
  EV_SNAPSHOT_GET,
  EV_WINDOW_CALL,
  EV_WINDOW_RESULT,
  type HostEventBus,
  type HostSnapshot,
  type SnapshotGetPayload,
  type WindowResultPayload,
} from "./host-protocol";
import { pluginCommandActionId } from "../shortcuts/actions";
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

/** 스냅샷 헬퍼(테마 SJ_D + 주어진 플러그인들).
 *  failures: []는 다른 담당(호스트 실패 추적)이 host-protocol.ts에 추가한 필드를 채우는
 *  최소 값 — 이 테스트 스위트는 실패 목록 자체를 검사하지 않는다. */
const snap = (plugins: HostSnapshot["plugins"]): HostSnapshot => ({
  revision: 1,
  theme: SJ_D,
  background: null,
  font: null,
  windowControls: [],
  plugins,
  failures: [],
});

afterEach(() => vi.useRealTimers());

describe("fetchHostSnapshot", () => {
  /** 가드: 호스트 창이 없으면 이벤트를 기다리지 않고 즉시 null(폴백)한다. */
  it("returns null immediately when the host window is absent", async () => {
    const bus = makeLocalBus();
    const emitted: unknown[] = [];
    bus.listen(EV_SNAPSHOT_GET, (p) => emitted.push(p));
    const r = await fetchHostSnapshot({ bus, hostAlive: async () => false });
    expect(r).toBeNull();
    expect(emitted).toEqual([]); // 요청 방송조차 하지 않는다
  });

  /** 가드: 호스트가 살아있고 응답하면 스냅샷을 받는다(요청 id 상관). */
  it("resolves with the snapshot answered for its requestId", async () => {
    const bus = makeLocalBus();
    bus.listen(EV_SNAPSHOT_GET, (p) => {
      const req = p as SnapshotGetPayload;
      // 다른 요청 id의 응답은 무시돼야 한다.
      bus.emit(EV_SNAPSHOT, { requestId: "다른요청", snapshot: snap([]) });
      bus.emit(EV_SNAPSHOT, {
        requestId: req.requestId,
        snapshot: snap([
          {
            pluginId: "p1",
            grant: { declared: [], granted: [] },
            patterns: [],
            completions: [],
            embeds: [],
            buttons: [],
          },
        ]),
      });
    });
    const r = await fetchHostSnapshot({ bus, hostAlive: async () => true });
    expect(r?.plugins[0].pluginId).toBe("p1");
  });

  /** 가드: 호스트가 늦으면 같은 requestId로 재방송해 결국 받아낸다(빌드 중 큐잉 대비). */
  it("re-emits the request until the host answers", async () => {
    vi.useFakeTimers();
    const bus = makeLocalBus();
    const seen: string[] = [];
    bus.listen(EV_SNAPSHOT_GET, (p) => {
      const req = p as SnapshotGetPayload;
      seen.push(req.requestId);
      if (seen.length === 3) {
        bus.emit(EV_SNAPSHOT, { requestId: req.requestId, snapshot: snap([]) });
      }
    });
    const pending = fetchHostSnapshot({
      bus,
      hostAlive: async () => true,
      retryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250); // 재시도 2회 경과 → 3번째 시도에 응답
    const r = await pending;
    expect(r).not.toBeNull();
    expect(new Set(seen).size).toBe(1); // 재시도는 같은 requestId
    expect(seen.length).toBe(3);
  });

  /** 가드: 상한(budget)까지 응답이 없으면 null로 폴백한다(호스트 웹뷰 이상 등). */
  it("gives up with null after the budget elapses", async () => {
    vi.useFakeTimers();
    const bus = makeLocalBus();
    const pending = fetchHostSnapshot({
      bus,
      hostAlive: async () => true,
      retryMs: 100,
      budgetMs: 500,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toBeNull();
  });
});

describe("raceSnapshot — 논블로킹 마운트", () => {
  /** 가드: 상한 안에 스냅샷이 오면 그대로 쓴다(정상 경로 — 테마 즉시 확정). */
  it("resolves with the snapshot when it arrives within the wait", async () => {
    vi.useFakeTimers();
    let deliver: (s: HostSnapshot | null) => void = () => {};
    const pending = new Promise<HostSnapshot | null>((r) => (deliver = r));
    const raced = raceSnapshot(pending, 1000);
    deliver(snap([]));
    await expect(raced).resolves.toEqual(snap([]));
  });

  /** 가드(핵심): 스냅샷이 늦으면 상한에서 null — 노트 마운트가 스냅샷 예산(10s)에
   * 묶이지 않는다(호스트 웹뷰 무응답 최악 경로에서도 노트는 뜬다). */
  it("resolves null at the deadline while the snapshot is still pending", async () => {
    vi.useFakeTimers();
    const raced = raceSnapshot(
      new Promise<HostSnapshot | null>(() => {}), // 영원히 미해소(무응답 호스트)
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(raced).resolves.toBeNull();
  });
});

describe("gatePatternActions — 권한 없는 클릭 동작은 none으로 낮춘다", () => {
  const pattern = (action?: "open-note" | "open-url" | "none") => [
    {
      id: "p",
      open: "[",
      mid: "](",
      close: ")",
      className: "cm-x-a-p",
      ...(action ? { action } : {}),
    },
  ];

  /** 가드(보안): browser:open이 없으면 open-url은 none이 된다 — 눌러도 아무 일이 없는
   * 가짜 링크를 만들지 않고, 링크 표식 자체를 떼는 근거가 이 값이다. */
  it("downgrades open-url without browser:open", () => {
    const gated = gatePatternActions(pattern("open-url"), {
      declared: ["editor", "browser:open"],
      granted: ["editor"], // 선언만, 미부여
    });
    expect(gated[0].action).toBe("none");
  });

  /** 가드: 선언+부여가 모두 있으면 open-url이 살아남는다. */
  it("keeps open-url when browser:open is declared and granted", () => {
    const gated = gatePatternActions(pattern("open-url"), {
      declared: ["editor", "browser:open"],
      granted: ["editor", "browser:open"],
    });
    expect(gated[0].action).toBe("open-url");
  });

  /** 가드: 기본 동작(open-note)도 notes:read + windows가 둘 다 있어야 살아남는다 —
   * 형광펜·kbd처럼 권한 없는 장식 패턴이 링크 표식을 달던 자리를 이 게이트가 없앤다. */
  it("downgrades the default open-note without notes:read and windows", () => {
    const bare = { declared: ["editor"], granted: ["editor"] };
    expect(gatePatternActions(pattern(), bare)[0].action).toBe("none");
    expect(
      gatePatternActions(pattern(), {
        declared: ["editor", "notes:read", "windows"],
        granted: ["editor", "notes:read", "windows"],
      })[0].action,
    ).toBe("open-note");
  });

  /** 가드: 한 권한만 있으면(windows 없이 notes:read) 여전히 못 연다. */
  it("requires both notes:read and windows for open-note", () => {
    expect(
      gatePatternActions(pattern("open-note"), {
        declared: ["editor", "notes:read"],
        granted: ["editor", "notes:read"],
      })[0].action,
    ).toBe("none");
  });

  /** 가드: 권한이 아무리 많아도 명시적 none은 none이다(장식용 선언을 뒤집지 않는다). */
  it("never promotes an explicit none", () => {
    expect(
      gatePatternActions(pattern("none"), {
        declared: ["editor", "notes:read", "windows", "browser:open"],
        granted: ["editor", "notes:read", "windows", "browser:open"],
      })[0].action,
    ).toBe("none");
  });
});

describe("embedGateFor — per-plugin 임베드 도메인 게이트 유지", () => {
  /** 가드(보안 핵심): 디스크립터가 직렬화돼 와도 게이트는 그 플러그인의 grant 기준이다 —
   * 선언+부여된 도메인만 통과, 선언만 된 도메인·무관 도메인은 거부. */
  it("allows only domains declared AND granted for that plugin", () => {
    const gate = embedGateFor({
      declared: ["editor", "embed:ok.example", "embed:declared-only.example"],
      granted: ["editor", "embed:ok.example"],
    });
    expect(gate("ok.example")).toBe(true);
    expect(gate("declared-only.example")).toBe(false); // 미부여
    expect(gate("evil.example")).toBe(false); // 미선언
  });
});

describe("buildExtensionsFromSnapshot", () => {
  /**
   * 가드(구조 계약): 확장은 **인라인 패턴 하나(전 플러그인 합본) + 플러그인당 하나**로
   * 조립된다.
   *
   * 왜 이 모양이 계약인가: 겹치는 매치의 승자를 가리는 규칙은 **한 데코레이션 집합 안에서만**
   * 돈다. 예전에는 플러그인마다 패턴 확장을 따로 만들어서, 같은 구간을 잡은 두 플러그인의
   * 패턴이 서로를 건너뛰지 못하고 **둘 다** 그려졌다(「글자 색」 `{{글자|#hex}}`이 「키 표시」
   * 키캡 상자를 함께 뒤집어쓰던 버그). 패턴만 앞으로 빼 하나로 합치는 이 모양이 그 수정이다 —
   * 종단 렌더 확인은 `inline-pattern-pipeline.test.ts`가 한다.
   */
  it("merges every plugin's inline patterns into one extension, plus one entry per plugin", () => {
    const ext = buildExtensionsFromSnapshot(
      snap([
        {
          pluginId: "a",
          grant: { declared: ["editor"], granted: [] },
          patterns: [{ id: "x", open: "[[", close: "]]", className: "c" }],
          completions: [],
          embeds: [],
          buttons: [],
        },
        {
          pluginId: "b",
          grant: { declared: ["editor"], granted: [] },
          patterns: [],
          completions: [
            { id: "wl", trigger: "[[", wrap: "[[%]]", source: "note-titles" },
          ],
          embeds: [],
          buttons: [],
        },
      ]),
      {
        noteTitles: async () => [],
        resolveTitleToId: async () => null,
        summon: () => {},
        openUrl: () => {},
      },
    );
    expect(Array.isArray(ext.render)).toBe(true);
    expect((ext.render as unknown[]).length).toBe(3); // 합본 패턴 1 + 플러그인 2
  });

  /** 가드: 등록된 패턴이 하나도 없으면 합본 자리는 빈 확장이다(업데이트마다 도는 빈 스캔 방지). */
  it("creates no pattern extension when no plugin registered one", () => {
    const ext = buildExtensionsFromSnapshot(
      snap([
        {
          pluginId: "a",
          grant: { declared: ["editor"], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [],
        },
      ]),
      {
        noteTitles: async () => [],
        resolveTitleToId: async () => null,
        summon: () => {},
        openUrl: () => {},
      },
    );
    expect((ext.render as unknown[])[0]).toEqual([]);
    // 패턴이 없으면 색 문법도 없다 — 메타 자리도 빈 확장이다.
    expect(ext.meta).toEqual([]);
  });

  /** 가드(보안): notes:read 권한이 없는 플러그인의 자동완성은 노트 제목에 닿지 못한다
   * (무력 서비스 연결 — 기존 per-window 로더와 같은 규칙). */
  it("does not wire noteTitles for plugins without notes:read", async () => {
    const noteTitles = vi.fn(async () => ["비밀 노트"]);
    // 확장 자체는 만들어지지만, 서비스 배선이 무력인지가 계약이다. buildPluginEditorExtension
    // 내부까지 뜯지 않고, 게이트 판정 로직(선언∩부여)이 같은 checkPermission을 쓰는지를
    // embedGateFor와 동일 grant로 재확인한다.
    const gate = embedGateFor({ declared: ["editor"], granted: [] });
    expect(gate("any.example")).toBe(false);
    buildExtensionsFromSnapshot(
      snap([
        {
          pluginId: "a",
          grant: { declared: ["editor"], granted: [] }, // notes:read 없음
          patterns: [],
          completions: [
            { id: "wl", trigger: "[[", wrap: "[[%]]", source: "note-titles" },
          ],
          embeds: [],
          buttons: [],
        },
      ]),
      {
        noteTitles,
        resolveTitleToId: async () => null,
        summon: () => {},
        openUrl: () => {},
      },
    );
    expect(noteTitles).not.toHaveBeenCalled(); // 배선 시점에 호출되지 않음(무력 연결)
  });
});

describe("collectPluginStyleCss", () => {
  /** 가드: 각 패턴의 검증된 style/styleHover가 네임스페이스 클래스 규칙으로 렌더된다. */
  it("renders namespaced base + hover rules for pattern styles", () => {
    const css = collectPluginStyleCss(
      snap([
        {
          pluginId: "spoiler",
          grant: { declared: ["editor"], granted: [] },
          patterns: [
            {
              id: "spoiler",
              open: "||",
              close: "||",
              className: "cm-x-spoiler-spoiler",
              style: { filter: "blur(4px)" },
              styleHover: { filter: "none" },
            },
          ],
          completions: [],
          embeds: [],
          buttons: [],
        },
      ]),
    );
    expect(css).toContain(".cm-x-spoiler-spoiler { filter: blur(4px); }");
    expect(css).toContain(".cm-x-spoiler-spoiler:hover { filter: none; }");
  });

  /** 가드: 스타일 없는 패턴은 CSS를 내지 않는다(동작 전용 패턴). */
  it("emits nothing for patterns without style", () => {
    const css = collectPluginStyleCss(
      snap([
        {
          pluginId: "a",
          grant: { declared: ["editor"], granted: [] },
          patterns: [{ id: "x", open: "[", close: "]", className: "c" }],
          completions: [],
          embeds: [],
          buttons: [],
        },
      ]),
    );
    expect(css).toBe("");
  });
});

describe("snapshotToolbarButtons", () => {
  /** 가드: 버튼 클릭이 플러그인 id·버튼 키·창 라벨을 담아 호스트로 위임된다. */
  it("emits EV_BUTTON_INVOKE with plugin/button/window identity on click", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const buttons = snapshotToolbarButtons(
      snap([
        {
          pluginId: "copy",
          grant: { declared: [], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [
            {
              id: "copy-btn",
              label: "📋",
              title: "복사하기",
              position: "bottom-left",
              buttonId: "cb7",
            },
          ],
        },
      ]),
      "note-abc",
      bus,
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0].position).toBe("bottom-left");
    buttons[0].onClick();
    expect(invokes).toEqual([
      { pluginId: "copy", buttonId: "cb7", windowLabel: "note-abc" },
    ]);
  });

  /**
   * 가드(클릭 확장): onClick을 준 상태 아이템(`buttonId`가 실린 것)은 `clickable: true`로
   * 오고 클릭이 버튼과 완전히 같은 EV_BUTTON_INVOKE(pluginId/buttonId/windowLabel)를 방송한다.
   * onClick이 없는(기존) 상태 아이템은 `clickable`이 없고 클릭이 no-op이다(아무것도 방송하지
   * 않는다) — 순수 텍스트 상태 아이템의 기존 동작을 깨지 않는다.
   */
  it("wires onClick for status items that have a buttonId, and stays a no-op otherwise", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const items = snapshotToolbarButtons(
      snap([
        {
          pluginId: "wc",
          grant: { declared: [], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [],
          statusItems: [
            {
              id: "wc-words",
              text: "3 단어",
              position: "bottom-right",
              buttonId: "h:wc1",
            },
            { id: "wc-chars", text: "12 자", position: "bottom-right" },
          ],
        },
      ]),
      "note-abc",
      bus,
    );
    expect(items).toHaveLength(2);
    // 상태 아이템의 id는 `status:`가 접두된다(아래 "namespaces a status item's id" 가드
    // 참고) — 원래 id는 그대로 남지 않는다.
    const clickable = items.find((i) => i.id === "status:wc-words")!;
    const plain = items.find((i) => i.id === "status:wc-chars")!;
    expect(clickable.status).toBe(true);
    expect(clickable.clickable).toBe(true);
    expect(plain.clickable).toBe(false);

    clickable.onClick();
    expect(invokes).toEqual([
      { pluginId: "wc", buttonId: "h:wc1", windowLabel: "note-abc" },
    ]);

    plain.onClick(); // no-op — 아무것도 방송하지 않는다.
    expect(invokes).toHaveLength(1);
  });

  /**
   * 가드(회귀 — kind 네임스페이스): 한 플러그인이 버튼과 상태 아이템에 **같은 id**를 써도
   * (`ui.addToolbarButton({id:"dup"})` + `ui.addStatusItem({id:"dup"})`) 결과 항목의 id가
   * 갈린다 — 버튼은 원래 id 그대로(그 키가 사용자의 저장된 toolbar_layout 배치와 맞물려
   * 있어 절대 못 바꾼다), 상태 아이템만 `status:`가 접두된다(명령의 `cmd:`, 메뉴의 `menu:`와
   * 같은 방식). 노트 창은 `plugin:<pluginId>:<id>`로 키를 짓기 때문에(그 자체는 안 바뀐다),
   * 이 접두가 없으면 버튼과 상태 아이템이 같은 키로 접혀 `reconcileToolbarItems`의 `next`
   * Map에서 나중에 도는 쪽(상태 아이템)이 버튼을 무음으로 덮는다 — 마운트 결과까지 보는
   * 회귀 가드는 note-window.test.ts 참고.
   */
  it("namespaces a status item's id apart from a same-id button (no cross-kind key collision)", () => {
    const bus = makeLocalBus();
    const items = snapshotToolbarButtons(
      snap([
        {
          pluginId: "dup-plugin",
          grant: { declared: [], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [
            {
              id: "dup",
              label: "📄",
              title: "버튼",
              position: "bottom-right",
              buttonId: "b1",
            },
          ],
          statusItems: [
            { id: "dup", text: "0 단어", position: "bottom-right" },
          ],
        },
      ]),
      "note-abc",
      bus,
    );
    expect(items).toHaveLength(2);
    const button = items.find((i) => i.status !== true)!;
    const status = items.find((i) => i.status === true)!;
    expect(button.id).toBe("dup"); // 버튼 id는 그대로 — 저장된 toolbar_layout 키 불변.
    expect(status.id).toBe("status:dup"); // 상태 아이템만 접두된다.
    expect(button.id).not.toBe(status.id);
  });

  /**
   * 가드: 버튼 없는 명령도 같은 배달에 실려 창까지 온다(menuOnly) — 노트 창이
   * 만드는 `data-action`이 단축키 경로의 `pluginCommandActionId()`와 **글자 그대로** 같아야
   * 두 실행 경로가 갈라지지 않는다.
   */
  it("carries buttonless commands as menu-only items with the shortcut action id", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const items = snapshotToolbarButtons(
      snap([
        {
          pluginId: "case",
          grant: { declared: [], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [],
          commands: [
            { id: "upper", title: "선택 대문자로" },
            { id: "wipe", title: "본문 비우기", destructive: true },
          ],
        },
      ]),
      "note-abc",
      bus,
    );
    expect(items).toHaveLength(2);
    expect(items[0].menuOnly).toBe(true);
    expect(items[0].label).toBe("선택 대문자로");
    expect(items[0].danger).toBeUndefined();
    // destructive 명령은 메뉴에서 빨갛게 보인다(실행 차단은 호스트의 확인 팝업이 한다).
    expect(items[1].danger).toBe(true);
    // 노트 창은 `plugin:<pluginId>:<id>`로 data-action을 만든다 — 그 결과가 단축키 id와 같다.
    expect(`plugin:${items[0].pluginId}:${items[0].id}`).toBe(
      pluginCommandActionId("case", "upper"),
    );
    items[0].onClick();
    expect(invokes).toEqual([
      { pluginId: "case", commandId: "upper", windowLabel: "note-abc" },
    ]);
  });

  /**
   * 가드: 메뉴 전용 항목도 같은 배달(menuOnly)에 실려 창까지 오고, 클릭은 `menuItemId`로
   * 방송된다(버튼의 `buttonId`·명령의 `commandId`와 구분되는 세 번째 페이로드). 표시 조건
   * (`menuWhen`)과 선택 텍스트 게이트(`needsSelectedText`)가 함께 실려야 노트 창이 우클릭 시점에
   * 필터하고 선택 텍스트를 얹을 수 있다.
   */
  it("carries menu items with menuWhen/needsSelectedText and emits menuItemId + gated selectedText", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const items = snapshotToolbarButtons(
      snap([
        {
          pluginId: "wrap",
          grant: { declared: [], granted: [] },
          patterns: [],
          completions: [],
          embeds: [],
          buttons: [],
          menuItems: [
            {
              id: "up",
              label: "선택 대문자로",
              when: [{ negated: false, key: "note.hasSelection" }],
              needsSelectedText: true,
            },
            { id: "plain", label: "그냥 항목" },
          ],
        },
      ]),
      "note-x",
      bus,
    );
    expect(items).toHaveLength(2);
    expect(items[0].menuOnly).toBe(true);
    expect(items[0].label).toBe("선택 대문자로");
    expect(items[0].menuWhen).toEqual([
      { negated: false, key: "note.hasSelection" },
    ]);
    expect(items[0].needsSelectedText).toBe(true);
    // 조건·게이트가 없는 항목은 필드도 없다(구버전 스냅샷·항상 표시 항목과 같은 폴백).
    expect(items[1].menuWhen).toBeUndefined();
    expect(items[1].needsSelectedText).toBeUndefined();
    // 부여된 항목은 선택 텍스트를 실어 클릭하면 방송에 menuItemId + selectedText가 함께 실린다.
    items[0].onClick({ selectedText: "고른 것" });
    expect(invokes).toEqual([
      {
        pluginId: "wrap",
        menuItemId: "up",
        windowLabel: "note-x",
        selectedText: "고른 것",
      },
    ]);
    // needsSelectedText가 없는 항목은 선택 텍스트를 실어도 방송에서 뺀다(payload 게이트).
    invokes.length = 0;
    items[1].onClick({ selectedText: "무시됨" });
    expect(invokes).toEqual([
      { pluginId: "wrap", menuItemId: "plain", windowLabel: "note-x" },
    ]);
  });
});

describe("executeWindowCall — 창-스코프 수행부", () => {
  const services = () => ({
    showToast: vi.fn((): string | null => "t1"),
    updateStatusItem: vi.fn((): string | null => "s1"),
    getFontDelta: vi.fn(() => 20),
    setFontDelta: vi.fn(),
    insertText: vi.fn(),
    writeClipboard: vi.fn(async () => {}),
    currentNote: vi.fn(() => ({
      id: "n1",
      path: "/v/notes/n1.md",
      content: "본문 내용",
    })),
    duplicateNote: vi.fn(async () => {}),
    resetOptions: vi.fn(),
    pickList: vi.fn(async () => ({ itemId: "picked", actionId: "select" })),
    prompt: vi.fn(
      async (): Promise<string | Record<string, string | number | boolean>> =>
        "typed",
    ),
  });

  /** 가드: notes.duplicate가 로컬 duplicateNote 서비스로 위임된다(복제 플러그인). */
  it("routes notes.duplicate to the local duplicateNote service", async () => {
    const s = services();
    await expect(
      executeWindowCall(s, "notes.duplicate", {}),
    ).resolves.toBeNull();
    expect(s.duplicateNote).toHaveBeenCalledTimes(1);
  });

  /** 가드: notes.resetOptions(정본이자 유일한 이름)가 로컬 resetOptions 서비스로 위임된다 —
   *  단수 note.resetOptions는 중앙 게이트에 없어 UNKNOWN_CALL로 먼저 거부되므로 수행부까지
   *  오는 이름은 복수형뿐이다(옵션 초기화 플러그인). */
  it("routes notes.resetOptions to the local resetOptions service", async () => {
    const s = services();
    await expect(
      executeWindowCall(s, "notes.resetOptions", {}),
    ).resolves.toBeNull();
    expect(s.resetOptions).toHaveBeenCalledTimes(1);
  });

  /** 가드: toast·글자 델타·클립보드·현재 노트가 로컬 서비스로 수행된다. */
  it("routes each window-scoped call to the local service", async () => {
    const s = services();
    await executeWindowCall(s, "ui.toast", { title: "복사됨" });
    // 안 준 필드(style)는 싣지 않는다 — 채워 보내면 갱신 경로에서 기존 상태를 덮는다.
    expect(s.showToast).toHaveBeenCalledWith({ title: "복사됨" }, "");

    await expect(executeWindowCall(s, "editor.getFontDelta", {})).resolves.toBe(
      20,
    );

    await executeWindowCall(s, "clipboard.write", { text: "hi" });
    expect(s.writeClipboard).toHaveBeenCalledWith("hi");

    // 선택 영역은 notes.current에 함께 실린다 — 에디터가 없으면 ranges: 0.
    await expect(executeWindowCall(s, "notes.current", {})).resolves.toEqual({
      id: "n1",
      path: "/v/notes/n1.md",
      content: "본문 내용",
      selection: {
        text: "",
        from: 0,
        to: 0,
        empty: true,
        ranges: 0,
        composing: false,
      },
    });
  });

  /** 가드: 노트가 없으면 selection을 붙이지 않고 그대로 null이다. */
  it("keeps notes.current null when there is no note", async () => {
    const s = services();
    s.currentNote.mockReturnValue(null as never);
    await expect(executeWindowCall(s, "notes.current", {})).resolves.toBeNull();
  });

  /** 가드: 상태·부가 메시지가 서비스로 그대로 넘어가고 발급 id가 반환된다. */
  it("passes toast style/message through and returns the issued id", async () => {
    const s = services();
    await expect(
      executeWindowCall(s, "ui.toast", {
        title: "변환 중",
        message: "3개 중 1개",
        style: "progress",
      }),
    ).resolves.toEqual({ id: "t1" });
    expect(s.showToast).toHaveBeenCalledWith(
      {
        title: "변환 중",
        message: "3개 중 1개",
        style: "progress",
      },
      "",
    );
    // 모르는 style은 오류가 아니라 success로 접는다(진행/실패는 명시할 때만).
    await executeWindowCall(s, "ui.toast", { title: "x", style: "우주" });
    expect(s.showToast).toHaveBeenLastCalledWith(
      {
        title: "x",
        style: "success",
      },
      "",
    );
  });

  /** 가드: 갱신·닫기는 id를 싣고, 모르는 id는 무음 무시가 아니라 INVALID_ARGS다. */
  it("rejects a toast update for an unknown id with INVALID_ARGS", async () => {
    const s = services();
    await executeWindowCall(s, "ui.toast", {
      id: "t1",
      title: "완료",
      style: "success",
    });
    expect(s.showToast).toHaveBeenLastCalledWith(
      {
        id: "t1",
        title: "완료",
        style: "success",
      },
      "",
    );
    await executeWindowCall(s, "ui.toast", {
      id: "t1",
      title: "",
      dismiss: true,
    });
    expect(s.showToast).toHaveBeenLastCalledWith(
      {
        id: "t1",
        title: "",
        dismiss: true,
      },
      "",
    );

    s.showToast.mockReturnValue(null);
    await expect(
      executeWindowCall(s, "ui.toast", { id: "죽은id", title: "완료" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    // id 없는 dismiss도 같은 코드로 거부된다(무엇을 닫을지 모르는 요청).
    await expect(
      executeWindowCall(s, "ui.toast", { title: "", dismiss: true }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  /**
   * 가드(회귀): **부분 갱신은 안 준 필드를 싣지 않는다.**
   *
   * 왜: 계약(`ui.toast`의 title 인자)이 "닫기·부분 갱신에서는 안 줘도 된다"고 약속한다.
   * 빈 문자열·기본 style을 채워 보내면 창 쪽 `paintToast`가 그대로 덮어써, 「진행 중 →
   * 완료」 전환에서 글자 없는 빈 알림이 뜨고 진행 토스트가 1.2초 뒤 사라진다.
   */
  it("omits fields the caller did not give on a partial update", async () => {
    const s = services();
    await executeWindowCall(s, "ui.toast", { id: "t1", style: "success" });
    expect(s.showToast).toHaveBeenLastCalledWith(
      {
        id: "t1",
        style: "success",
      },
      "",
    );
    await executeWindowCall(s, "ui.toast", { id: "t1", message: "80%" });
    expect(s.showToast).toHaveBeenLastCalledWith(
      { id: "t1", message: "80%" },
      "",
    );
  });

  /** 가드: 문구 없는 **새** 토스트는 거부다 — 갱신과 달리 유지할 이전 값이 없어 빈 알약이 뜬다. */
  it("rejects a new toast with no title", async () => {
    const s = services();
    await expect(
      executeWindowCall(s, "ui.toast", { style: "success" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(s.showToast).not.toHaveBeenCalled();
  });

  /** 가드: setFontDelta 값이 없거나 비수치(문자열·객체)면 NaN이 아니라 0으로 정규화된다
   * (기존 per-window 수행부의 방어 계승 — NaN이 글자 크기·영속화로 새지 않게). */
  it("coerces a missing/non-numeric setFontDelta value to 0 (never NaN)", async () => {
    const s = services();
    await executeWindowCall(s, "editor.setFontDelta", {}); // 값 없음
    await executeWindowCall(s, "editor.setFontDelta", { value: "abc" });
    await executeWindowCall(s, "editor.setFontDelta", { value: {} });
    for (const call of s.setFontDelta.mock.calls) {
      expect(call[0]).toBe(0);
    }
    expect(s.setFontDelta).toHaveBeenCalledTimes(3);
    await executeWindowCall(s, "editor.setFontDelta", { value: -30 });
    expect(s.setFontDelta).toHaveBeenLastCalledWith(-30); // 정상 수치는 그대로
  });

  /** 가드(핵심): setFontDelta는 실제 적용된(클램프된) 델타를 회신한다 — 플러그인이 이 값으로
   * 토스트해, 한계에서 가짜 % 증가가 사라진다. */
  it("returns the applied (clamped) delta from setFontDelta", async () => {
    const s = services();
    s.setFontDelta.mockImplementation((d: number) => Math.min(240, d)); // 상한 흉내
    await expect(
      executeWindowCall(s, "editor.setFontDelta", { value: 1000 }),
    ).resolves.toBe(240);
  });

  /** 가드: editor.insertText가 text·mode·caret을 파싱해 로컬 서비스로 전달된다. */
  it("routes editor.insertText with parsed text, mode and caret", async () => {
    const s = services();
    await executeWindowCall(s, "editor.insertText", {
      text: "안녕",
      mode: "append",
      caret: 1,
    });
    expect(s.insertText).toHaveBeenCalledWith("안녕", "append", 1);

    // mode 없으면 cursor 기본, caret 없음/비수치/음수는 undefined.
    await executeWindowCall(s, "editor.insertText", { text: "끝" });
    expect(s.insertText).toHaveBeenLastCalledWith("끝", "cursor", undefined);
    await executeWindowCall(s, "editor.insertText", { text: "x", caret: "no" });
    expect(s.insertText).toHaveBeenLastCalledWith("x", "cursor", undefined);
    await executeWindowCall(s, "editor.insertText", { text: "z", caret: -1 });
    expect(s.insertText).toHaveBeenLastCalledWith("z", "cursor", undefined);

    // caret 0은 유효(삽입 본문 맨 앞)이라 그대로 전달된다.
    await executeWindowCall(s, "editor.insertText", { text: "y", caret: 0 });
    expect(s.insertText).toHaveBeenLastCalledWith("y", "cursor", 0);
  });

  /** 가드: ui.pickList가 title·items를 정규화해 서비스로 넘기고 선택 id를 돌려준다.
   *  액션을 안 쓴 호출은 **문자열 id**를 그대로 받는다(현행 호출이 부분집합). */
  it("routes ui.pickList with normalized items and returns the choice", async () => {
    const s = services();
    const r = await executeWindowCall(s, "ui.pickList", {
      title: "고르기",
      items: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        null, // 방어: 잘못된 항목도 빈 {id,label}로 정규화된다
      ],
    });
    expect(s.pickList).toHaveBeenCalledWith({
      title: "고르기",
      items: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "", label: "" },
      ],
    });
    expect(r).toBe("picked");
  });

  /** 가드: 액션을 쓴 호출은 (항목, 액션) 객체를 받는다. id 없는 액션은 버린다. */
  it("returns an {itemId, actionId} object once any item declares actions", async () => {
    const s = services();
    s.pickList.mockResolvedValue({ itemId: "a", actionId: "copy" });
    const r = await executeWindowCall(s, "ui.pickList", {
      title: "고르기",
      placeholder: "안내",
      items: [
        {
          id: "a",
          label: "A",
          sublabel: "부제",
          actions: [
            { id: "copy", label: "복사" },
            { label: "id 없음" },
            { id: "del", label: "삭제", style: "destructive" },
          ],
        },
      ],
    });
    expect(s.pickList).toHaveBeenCalledWith({
      title: "고르기",
      placeholder: "안내",
      items: [
        {
          id: "a",
          label: "A",
          sublabel: "부제",
          actions: [
            { id: "copy", label: "복사" },
            { id: "del", label: "삭제", style: "destructive" },
          ],
        },
      ],
    });
    expect(r).toEqual({ itemId: "a", actionId: "copy" });
  });

  /** 가드: 취소(null)는 액션 유무와 무관하게 null 그대로다. */
  it("keeps a cancelled pickList as null", async () => {
    const s = services();
    s.pickList.mockResolvedValue(null as never);
    await expect(
      executeWindowCall(s, "ui.pickList", {
        title: "t",
        items: [{ id: "a", label: "A", actions: [{ id: "x", label: "X" }] }],
      }),
    ).resolves.toBeNull();
  });

  /** 가드: ui.prompt가 title·placeholder·default를 넘기고 입력값을 돌려준다. */
  it("routes ui.prompt and returns the typed value", async () => {
    const s = services();
    const r = await executeWindowCall(s, "ui.prompt", {
      title: "이름",
      placeholder: "예: 주간회의",
      default: "기본",
    });
    expect(s.prompt).toHaveBeenCalledWith({
      title: "이름",
      placeholder: "예: 주간회의",
      default: "기본",
    });
    expect(r).toBe("typed");
  });

  /** 가드: fields를 주면 폼으로 넘어가고 값 맵이 그대로 돌아온다. 모르는 타입·빈 id는 버린다. */
  it("routes ui.prompt fields as a form and drops unknown field types", async () => {
    const s = services();
    s.prompt.mockResolvedValue({ name: "주간회의", pin: true });
    const r = await executeWindowCall(s, "ui.prompt", {
      title: "새 템플릿",
      submitLabel: "만들기",
      fields: [
        { id: "name", label: "이름", type: "text", default: "x" },
        { id: "pin", label: "고정", type: "toggle" },
        { id: "bad", label: "목록", type: "list" }, // 폼에 없는 타입 → 버린다
        { label: "id 없음", type: "text" },
      ],
    });
    expect(s.prompt).toHaveBeenCalledWith({
      title: "새 템플릿",
      placeholder: "",
      default: "",
      submitLabel: "만들기",
      fields: [
        { id: "name", label: "이름", type: "text", default: "x" },
        { id: "pin", label: "고정", type: "toggle" },
      ],
    });
    expect(r).toEqual({ name: "주간회의", pin: true });
  });

  /**
   * 가드(회귀): `fields`를 줬는데 **전부** 걸러지면(타입 오타·id 없음) 한 줄 입력으로
   * 폴백하지 않고 INVALID_ARGS로 거부한다.
   *
   * 왜: 폴백하면 계약과 다른 UI(한 줄 입력)가 뜨고 반환형까지 문자열로 달라진다 — 저작자는
   * `Record`를 기대하는 코드로 문자열을 받아 조용히 오작동한다(예: `type: "checkbox"` 오타).
   */
  it("rejects ui.prompt with INVALID_ARGS when every field is filtered out", async () => {
    const s = services();
    await expect(
      executeWindowCall(s, "ui.prompt", {
        title: "설정",
        fields: [
          { id: "on", label: "켜기", type: "checkbox" }, // toggle의 오타
          { label: "id 없음", type: "text" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    // 배열이 아닌 truthy fields(객체 map·문자열)도 같은 거부다 — []로 접혀 가드를 우회해
    // 한 줄 입력으로 조용히 폴백하면 안 된다.
    await expect(
      executeWindowCall(s, "ui.prompt", {
        title: "설정",
        fields: { id: "on", label: "켜기", type: "toggle" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(
      executeWindowCall(s, "ui.prompt", { title: "설정", fields: "on" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(s.prompt).not.toHaveBeenCalled();
    // 빈 배열은 「안 준 것」과 같다(기존 계약) — 거부가 아니라 한 줄 입력이다.
    await executeWindowCall(s, "ui.prompt", { title: "이름", fields: [] });
    expect(s.prompt).toHaveBeenCalledWith({
      title: "이름",
      placeholder: "",
      default: "",
    });
  });

  /**
   * 가드(회귀): `ui.toast`는 페이로드의 pluginId(호스트 검증 값)를 토스트 네임스페이스로
   * 넘긴다 — 이 값이 빠지면 전 플러그인이 한 네임스페이스를 공유해, 플러그인 B가 순번을
   * 추측해 플러그인 A의 토스트를 닫거나 바꿔칠 수 있다.
   */
  it("forwards the host-verified pluginId as the toast namespace", async () => {
    const s = services();
    await executeWindowCall(s, "ui.toast", { title: "x" }, "plug-a");
    expect(s.showToast).toHaveBeenCalledWith({ title: "x" }, "plug-a");
  });

  /** 가드: 창-스코프 목록 밖의 호출은 던진다(호스트가 오류 응답으로 회신하게). */
  it("throws for calls outside the window-scoped set", async () => {
    await expect(
      executeWindowCall(services(), "vault.read", {}),
    ).rejects.toThrow();
  });
});

describe("attachWindowCallHandler", () => {
  /** 가드: 내 라벨의 호출만 수행·회신하고, 다른 창의 호출은 무시한다. */
  it("answers only calls addressed to this window label", async () => {
    const bus = makeLocalBus();
    const results: WindowResultPayload[] = [];
    bus.listen(EV_WINDOW_RESULT, (p) => results.push(p as WindowResultPayload));
    const showToast = vi.fn(() => "t1");
    attachWindowCallHandler(bus, "note-a", {
      showToast,
      updateStatusItem: () => "s1",
      getFontDelta: () => 0,
      setFontDelta: () => 0,
      insertText: () => {},
      writeClipboard: async () => {},
      currentNote: () => null,
      duplicateNote: async () => {},
      resetOptions: () => {},
      pickList: async () => null,
      prompt: async () => null,
    });

    bus.emit(EV_WINDOW_CALL, {
      requestId: "r1",
      windowLabel: "note-b", // 다른 창의 몫
      pluginId: "p1",
      call: "ui.toast",
      args: { title: "x" },
    });
    bus.emit(EV_WINDOW_CALL, {
      requestId: "r2",
      windowLabel: "note-a",
      pluginId: "p1",
      call: "ui.toast",
      args: { title: "복사됨" },
    });
    await new Promise((r) => setTimeout(r, 0)); // 수행부(async) 완료 대기
    expect(showToast).toHaveBeenCalledTimes(1);
    // 페이로드의 pluginId(호스트 검증 값)가 토스트 네임스페이스로 그대로 전달된다.
    expect(showToast).toHaveBeenCalledWith({ title: "복사됨" }, "p1");
    expect(results).toEqual([
      { requestId: "r2", ok: true, result: { id: "t1" } },
    ]);
  });

  /** 가드: 수행부가 던지면 ok:false + 오류 메시지로 회신한다(호스트가 샌드박스에 전달). */
  it("replies ok:false when the local execution throws", async () => {
    const bus = makeLocalBus();
    const results: WindowResultPayload[] = [];
    bus.listen(EV_WINDOW_RESULT, (p) => results.push(p as WindowResultPayload));
    attachWindowCallHandler(bus, "note-a", {
      showToast: () => "t1",
      updateStatusItem: () => "s1",
      getFontDelta: () => 0,
      setFontDelta: () => 0,
      insertText: () => {},
      writeClipboard: async () => {
        throw new Error("클립보드 불가");
      },
      currentNote: () => null,
      duplicateNote: async () => {},
      resetOptions: () => {},
      pickList: async () => null,
      prompt: async () => null,
    });
    bus.emit(EV_WINDOW_CALL, {
      requestId: "r1",
      windowLabel: "note-a",
      call: "clipboard.write",
      args: { text: "x" },
    });
    await new Promise((r) => setTimeout(r, 0)); // 수행부(async) 완료 대기
    expect(results).toEqual([
      { requestId: "r1", ok: false, error: "클립보드 불가" },
    ]);
  });

  /** 가드: 안정 코드가 붙은 거부는 그 코드를 회신에 함께 싣는다 — 창 쪽에서 난
   *  실패도 게이트키퍼의 실패와 같은 어휘로 샌드박스에 도달하게 하는 첫 구간이다.
   *  (중앙 호스트가 이 필드를 브리지 응답으로 이어 실어야 최종 도달한다 — 요청사항.) */
  it("carries a stable code on a coded rejection", async () => {
    const bus = makeLocalBus();
    const results: WindowResultPayload[] = [];
    bus.listen(EV_WINDOW_RESULT, (p) => results.push(p as WindowResultPayload));
    attachWindowCallHandler(bus, "note-a", {
      showToast: () => "t1",
      updateStatusItem: () => "s1",
      getFontDelta: () => 0,
      setFontDelta: () => 0,
      insertText: () => {},
      writeClipboard: async () => {},
      currentNote: () => null,
      duplicateNote: async () => {},
      resetOptions: () => {},
      pickList: async () => null,
      prompt: async () => null,
    });
    bus.emit(EV_WINDOW_CALL, {
      requestId: "r1",
      windowLabel: "note-a",
      call: "vault.read", // 창 수행부가 모르는 호출
      args: {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(results[0]).toMatchObject({ ok: false, code: "UNKNOWN_CALL" });
  });
});

describe("snapshotSelectionActions", () => {
  /** 선택 액션 하나를 실은 최소 플러그인 스냅샷 조각. */
  const withActions = (
    actions: NonNullable<HostSnapshot["plugins"][number]["selectionActions"]>,
  ): HostSnapshot =>
    snap([
      {
        pluginId: "calc",
        grant: { declared: [], granted: [] },
        patterns: [],
        completions: [],
        embeds: [],
        buttons: [],
        selectionActions: actions,
      },
    ]);

  /** 가드: 스냅샷 조각이 그대로 항목이 되고, `match`가 창까지 온전히 실려 온다(로컬 판정의 재료). */
  it("carries id/label/title/match through to the window item", () => {
    const actions = snapshotSelectionActions(
      withActions([
        {
          id: "calc",
          label: "=",
          title: "선택 계산",
          match: { charClasses: ["digit"], singleLine: true, maxLength: 200 },
        },
      ]),
      "note-a",
      makeLocalBus(),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].pluginId).toBe("calc");
    expect(actions[0].id).toBe("calc");
    expect(actions[0].label).toBe("=");
    expect(actions[0].title).toBe("선택 계산");
    expect(actions[0].match).toEqual({
      charClasses: ["digit"],
      singleLine: true,
      maxLength: 200,
    });
  });

  /** 가드: 실행이 `selectionActionId`로 방송된다 — 버튼·명령과 같은 채널, 다른 페이로드. */
  it("emits EV_BUTTON_INVOKE with selectionActionId and the window label", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const [action] = snapshotSelectionActions(
      withActions([{ id: "calc", label: "=", needsSelectedText: true }]),
      "note-a",
      bus,
    );
    action.run({ selectedText: "1+1" });
    expect(invokes[0]).toEqual({
      pluginId: "calc",
      selectionActionId: "calc",
      windowLabel: "note-a",
      selectedText: "1+1",
    });
  });

  /**
   * 가드(권한 게이트, 핵심): `needsSelectedText`가 없으면(=`notes:read` 미부여) 선택 텍스트는
   * **방송에 실리지 않는다**. 두 표면(선택 툴바·단축키)이 선택 텍스트를 그냥 넘기기만 하도록
   * 이 판정을 여기 한 곳에 뒀으므로, 여기서 새면 `ui` 권한만으로 본문이 새는 것과 같다.
   */
  it("omits selectedText when notes:read was not granted at registration", () => {
    const bus = makeLocalBus();
    const invokes: unknown[] = [];
    bus.listen(EV_BUTTON_INVOKE, (p) => invokes.push(p));
    const [action] = snapshotSelectionActions(
      withActions([{ id: "calc", label: "=" }]),
      "note-a",
      bus,
    );
    action.run({ selectedText: "새면 안 되는 본문" });
    expect(invokes[0]).toEqual({
      pluginId: "calc",
      selectionActionId: "calc",
      windowLabel: "note-a",
    });
    expect(JSON.stringify(invokes)).not.toContain("새면 안 되는 본문");
  });

  /** 가드: 구버전 스냅샷(필드 자체가 없음)은 "액션 없음"으로 읽힌다(다른 선택 필드와 같은 폴백). */
  it("treats a snapshot without the field as no actions", () => {
    expect(
      snapshotSelectionActions(
        snap([
          {
            pluginId: "p",
            grant: { declared: [], granted: [] },
            patterns: [],
            completions: [],
            embeds: [],
            buttons: [],
          },
        ]),
        "note-a",
        makeLocalBus(),
      ),
    ).toEqual([]);
  });
});

/**
 * 노트 창의 이벤트 발신 게이트 — "누가 듣고 있는가"를 노트 창은 모르므로 스냅샷이
 * 알려 준다. 게이트가 없으면 이벤트를 쓰는 플러그인이 하나도 없는 사용자까지 자동저장마다
 * IPC 비용을 문다.
 */
describe("noteEventEmitter", () => {
  const withEvents = (
    names: HostSnapshot["subscribedEvents"],
  ): HostSnapshot => ({
    ...snap([]),
    subscribedEvents: names,
  });

  /** 가드(핵심): 구독자가 없는 이름은 **아예 방송하지 않는다**(호스트가 버리는 게 아니라
   * 트래픽 자체가 없다). */
  it("emits nothing when no plugin subscribed", () => {
    const bus = makeLocalBus();
    const seen: unknown[] = [];
    bus.listen(EV_PLUGIN_EVENT, (p) => seen.push(p));
    const emit = noteEventEmitter(withEvents([]), "note-a", bus);
    emit("note:saved", { id: "n1", path: "/v/n1.md" });
    emit("note:opened", { id: "n1", path: "/v/n1.md" });
    expect(seen).toEqual([]);
  });

  /** 가드: 구독된 이름만 나가고, 페이로드는 창·노트 메타뿐이다(본문은 어디에도 없다). */
  it("emits only subscribed names, with metadata only", () => {
    const bus = makeLocalBus();
    const seen: Record<string, unknown>[] = [];
    bus.listen(EV_PLUGIN_EVENT, (p) => seen.push(p as Record<string, unknown>));
    const emit = noteEventEmitter(withEvents(["note:saved"]), "note-a", bus);
    emit("note:opened", { id: "n1", path: "/v/n1.md" });
    emit("note:saved", { id: "n1", path: "/v/n1.md" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "note:saved",
      windowLabel: "note-a",
      noteId: "n1",
      path: "/v/n1.md",
    });
    expect(typeof seen[0].at).toBe("number");
    expect(Object.keys(seen[0]).sort()).toEqual([
      "at",
      "name",
      "noteId",
      "path",
      "windowLabel",
    ]);
  });

  /** 가드(하위호환): 구독 목록 필드가 없는 구버전 스냅샷은 "구독자 없음"으로 읽는다 —
   * undefined를 "전부 허용"으로 읽으면 게이트가 통째로 무력해진다. */
  it("treats a snapshot without the field as nobody subscribing", () => {
    const bus = makeLocalBus();
    const seen: unknown[] = [];
    bus.listen(EV_PLUGIN_EVENT, (p) => seen.push(p));
    noteEventEmitter(
      snap([]),
      "note-a",
      bus,
    )("note:saved", {
      id: "n1",
      path: null,
    });
    expect(seen).toEqual([]);
  });
});
