/**
 * 진단 링버퍼 테스트 — 상한·폐기 정책·유출 방어(길이 상한)를 고정한다.
 */
import { describe, it, expect } from "vitest";
import {
  createDiagnosticsLog,
  EV_DIAGNOSTICS,
  EV_DIAGNOSTICS_GET,
  fetchPluginDiagnostics,
  MAX_DIAGNOSTICS_PER_PLUGIN,
  MAX_DIAGNOSTIC_CALL_LEN,
  MAX_DIAGNOSTIC_CODE_LEN,
  MAX_DIAGNOSTIC_MESSAGE_LEN,
  type PluginDiagnostic,
} from "./diagnostics";

describe("createDiagnosticsLog", () => {
  /** 가드: 기록한 항목을 플러그인별로 돌려주고, 전체 목록은 시간순이다. */
  it("records per plugin and lists everything in time order", () => {
    let now = 100;
    const log = createDiagnosticsLog(() => now++);
    log.record({ pluginId: "a", kind: "log", message: "첫" });
    log.record({
      pluginId: "b",
      kind: "call-reject",
      call: "ui.toast",
      code: "PERMISSION_UNDECLARED",
      message: "거부",
    });
    log.record({ pluginId: "a", kind: "log", message: "둘" });

    expect(log.forPlugin("a").map((d) => d.message)).toEqual(["첫", "둘"]);
    expect(log.list().map((d) => d.at)).toEqual([100, 101, 102]);
    const rejected = log.forPlugin("b")[0];
    expect(rejected.call).toBe("ui.toast");
    expect(rejected.code).toBe("PERMISSION_UNDECLARED");
  });

  /** 가드: 상한을 넘으면 **가장 오래된 것부터** 버린다(최근이 남는다 — 저작자가 보는 건 방금 난 일). */
  it("drops the oldest entries past the per-plugin cap", () => {
    const log = createDiagnosticsLog(() => 0);
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_PLUGIN + 20; i++) {
      log.record({ pluginId: "a", kind: "log", message: `m${i}` });
    }
    const kept = log.forPlugin("a");
    expect(kept).toHaveLength(MAX_DIAGNOSTICS_PER_PLUGIN);
    expect(kept[0].message).toBe("m20"); // 앞의 20건이 밀려났다
    expect(kept[kept.length - 1].message).toBe(
      `m${MAX_DIAGNOSTICS_PER_PLUGIN + 19}`,
    );
  });

  /** 가드: 한 플러그인의 폭주가 다른 플러그인의 기록을 밀어내지 못한다(상한은 플러그인 **당**). */
  it("isolates buckets per plugin", () => {
    const log = createDiagnosticsLog(() => 0);
    log.record({ pluginId: "quiet", kind: "log", message: "조용" });
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_PLUGIN * 2; i++) {
      log.record({ pluginId: "noisy", kind: "log", message: "시끄" });
    }
    expect(log.forPlugin("quiet")).toHaveLength(1);
  });

  /** 가드(유출 방어): 메시지는 상한에서 잘린다 — throw된 값에 노트 본문이 섞여도 통째로 남지 않게. */
  it("truncates long messages", () => {
    const log = createDiagnosticsLog(() => 0);
    log.record({ pluginId: "a", kind: "log", message: "가".repeat(5000) });
    expect(log.forPlugin("a")[0].message).toHaveLength(
      MAX_DIAGNOSTIC_MESSAGE_LEN,
    );
  });

  /**
   * 가드(메모리 방어): 호출명도 상한에서 잘린다.
   *
   * 왜: `call`은 샌드박스가 보낸 원문이다 — `memo[거대한문자열][또다른것]()`로 부르면
   * `UNKNOWN_CALL` 거부 1건마다 그 원문이 통째로 링버퍼에 남는다(건수 상한은 있어도 건당
   * 크기 상한이 없으면 상주 호스트 메모리가 기가 단위로 자란다).
   */
  it("truncates long call names", () => {
    const log = createDiagnosticsLog(() => 0);
    log.record({
      pluginId: "a",
      kind: "call-reject",
      call: "x".repeat(5_000_000),
      code: "UNKNOWN_CALL",
      message: "거부됨",
    });
    expect(log.forPlugin("a")[0].call).toHaveLength(MAX_DIAGNOSTIC_CALL_LEN);
  });

  /**
   * 가드(메모리 방어): 오류 코드도 상한에서 잘린다.
   *
   * 왜: 샌드박스가 스스로 보고하는 진단(`onclick-throw`·`unhandled-rejection`)의 `code`는
   * **플러그인이 throw한 Error의 `.code`**다 — 호스트 어휘가 아니라 신뢰 경계 밖 문자열이라
   * `call`과 똑같이 상한이 필요하다(없으면 거대한 code 100건이 상주 호스트에 눌러앉고,
   * 「최근 오류」를 여는 순간 통째로 이벤트에 직렬화돼 설정 창이 멈춘다).
   */
  it("truncates long error codes", () => {
    const log = createDiagnosticsLog(() => 0);
    log.record({
      pluginId: "a",
      kind: "onclick-throw",
      call: "ui.addToolbarButton",
      code: "A".repeat(5_000_000),
      message: "핸들러 예외",
    });
    expect(log.forPlugin("a")[0].code).toHaveLength(MAX_DIAGNOSTIC_CODE_LEN);
  });

  /** 가드: 반환은 복사본이라 호출자가 내부 버퍼를 흔들 수 없다. */
  it("returns copies, not the internal buffer", () => {
    const log = createDiagnosticsLog(() => 0);
    log.record({ pluginId: "a", kind: "log", message: "x" });
    log.forPlugin("a").push({
      pluginId: "a",
      at: 0,
      kind: "log",
      message: "몰래",
    });
    expect(log.forPlugin("a")).toHaveLength(1);
  });
});

describe("fetchPluginDiagnostics", () => {
  /** 요청/응답을 동기로 배달하는 로컬 버스(중앙 호스트 대역). */
  const makeBus = (
    respond: (requestId: string) => PluginDiagnostic[] | null,
  ) => {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const bus = {
      emit: (event: string, payload?: unknown) => {
        for (const h of [...(listeners.get(event) ?? [])]) h(payload);
        if (event !== EV_DIAGNOSTICS_GET) return;
        const requestId = (payload as { requestId: string }).requestId;
        const diagnostics = respond(requestId);
        if (diagnostics) bus.emit(EV_DIAGNOSTICS, { requestId, diagnostics });
      },
      listen: (event: string, handler: (p: unknown) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
    };
    return bus;
  };

  /** 가드: 자기 requestId의 응답만 받는다(다른 요청의 응답이 섞이지 않는다). */
  it("resolves with the diagnostics for its own request only", async () => {
    const entry: PluginDiagnostic = {
      pluginId: "a",
      at: 1,
      kind: "log",
      message: "x",
    };
    const bus = makeBus(() => [entry]);
    bus.emit(EV_DIAGNOSTICS, { requestId: "남의것", diagnostics: [] });
    await expect(fetchPluginDiagnostics({ bus })).resolves.toEqual([entry]);
  });

  /** 가드: 호스트가 무응답이면 상한 뒤 빈 목록 — 설정 창이 진단 때문에 멈추지 않는다. */
  it("falls back to an empty list when the host never answers", async () => {
    const bus = makeBus(() => null);
    await expect(fetchPluginDiagnostics({ bus, budgetMs: 1 })).resolves.toEqual(
      [],
    );
  });
});
