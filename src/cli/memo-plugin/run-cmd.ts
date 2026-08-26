/**
 * memo-plugin CLI — `run <dir>` / `test <dir>`: 앱 없이 플러그인을 실행·단언한다.
 *
 * 역할: 헤드리스 하니스(`src/plugin/test-host.ts`, host-bridge.ts가 노출한 `loadPluginFromDir`/
 * `loadPluginForTest`)를 CLI 표면으로 얹는다. `run`은 로드만 하고 등록 결과(버튼·패턴·명령·
 * 구독·능력)를 덤프하며, `test`는 거기에 더해 클릭/명령/이벤트 **하나**를 발화시켜 그 호출
 * 시퀀스까지 보여준다.
 *
 * 왜 재구현하지 않나("위험" 절): 하니스가 실제 호스트와 벌어지면 "CLI는 통과했는데 앱에서는
 * 실패"가 생긴다. 그래서 이 파일은 판정 로직을 갖지 않는다 — `loadPluginFromDir`가 실제
 * `handleBridgeRequest`(host.ts)·`makeRegistrar`(loader.ts)를 그대로 태운 실행 결과를 받아
 * **직렬화만** 한다.
 */
import { existsSync, readFileSync } from "node:fs";
import type { HostContract } from "./host-bridge.ts";
import type { Finding } from "./types.ts";

/** run/test 공통 실행 옵션 — 전부 파일·CLI 플래그에서 온다(하니스 자체는 순수 함수 인자).
 * export하지 않는다(knip) — cli.ts는 이름을 대지 않고 리터럴 객체로 넘긴다(구조적 타이핑). */
interface RunOptions {
  /** 저장된(디스크) 설정 값 JSON 파일 경로(--settings). 없으면 매니페스트 기본값만 쓴다. */
  settingsPath?: string;
  /** 승인 권한 재정의(--granted=a,b) — 생략하면 매니페스트가 선언한 권한 전부 승인. */
  granted?: string[];
  /** 창-스코프·호스트 호출 스텁 JSON 파일 경로(--stub). 값은 정적이어야 한다(CLI 인자라
   * 함수를 실을 수 없다 — 함수 스텁이 필요하면 test-host.ts를 직접 import하는 vitest를 써라). */
  stubPath?: string;
}

/** `test` 전용 — 클릭/명령/이벤트/메뉴/트레이/선택 액션 중 정확히 하나를 지정해야 한다(cli.ts가 강제). */
interface TestOptions extends RunOptions {
  click?: string;
  command?: string;
  event?: string;
  /** 컨텍스트 메뉴 항목 선택 시뮬레이션(--menu=<id>) — run 본문을 발화시킨다. */
  menu?: string;
  /** 메뉴바 트레이 항목 클릭 시뮬레이션(--tray=<id>) — run 본문을 발화시킨다(payload 없음). */
  tray?: string;
  /** 선택 액션 실행 시뮬레이션(--selection=<id>) — run 본문을 발화시킨다(선택 텍스트는 payload로). */
  selection?: string;
  /** 역호출에 실어 보낼 payload(--payload, JSON 문자열을 미리 파싱해 넘긴다). */
  payload?: unknown;
}

/** 하니스 결과를 JSON-safe 형태로 옮긴 스냅샷 — `run`/`test` 둘 다 이 모양을 낸다. */
interface HarnessDump {
  id: string;
  ready: boolean;
  buttons: unknown[];
  patterns: unknown[];
  completions: unknown[];
  embeds: unknown[];
  commands: unknown[];
  subscriptions: unknown[];
  menuItems: unknown[];
  selectionActions: unknown[];
  statusItems: unknown[];
  trayItems: unknown[];
  theme: unknown;
  background: unknown;
  font: unknown;
  windowControls: unknown[];
  /** 로드(등록) 동안 난 호출 전부 — `runtime.ready` 포함. */
  calls: unknown[];
  rejections: unknown[];
  diagnostics: unknown[];
  errors: string[];
  /** `memo.runtime.log`로 보낸 메시지만 뽑아 낸 목록(calls에서 파생 — 별도 관측이 아니다).
   * 왜 따로 두나: host.ts `handleRuntimeCall`이 runtime.log를 **직접 `console.info`로도**
   * 찍는다(개발 중 실시간 확인용). CLI가 그 console.info를 그대로 흘리면 `--json` 모드
   * stdout이 플러그인 로그와 섞여 `JSON.parse`가 깨진다(loadOverrides 근처 참고) — 그래서
   * 로드·액션 구간에서 console.info를 잠그고(withSilencedRuntimeLog) 같은 정보를 여기로만
   * 낸다. 정보 손실이 없다: 메시지는 이미 calls에 `{ call: "runtime.log", args: { message } }`
   * 로 실려 있다. */
  logs: string[];
}

/** calls에서 `runtime.log` 메시지만 뽑는다(logs 필드의 유일한 출처 — dumpPlugin에서 쓴다). */
function extractLogs(calls: unknown[]): string[] {
  return (calls as { call?: unknown; args?: { message?: unknown } }[])
    .filter((c) => c.call === "runtime.log")
    .map((c) => String(c.args?.message ?? ""));
}

/** `handleRuntimeCall`(host.ts)의 `console.info("[memo:plugin]", ...)`을 구간 동안 잠근다 —
 * 정보 자체는 잃지 않는다(runtime.log 호출은 하니스의 `calls`에 그대로 기록된다, 위 `logs`
 * 참고). CLI 프로세스가 플러그인 하나를 순차 실행하는 단발 배치이므로 전역 콘솔을 잠깐
 * 바꿔도 동시 실행과 부딪히지 않는다. */
async function withSilencedRuntimeLog<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.info;
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.info = original;
  }
}

/**
 * run/test가 플러그인을 로드·발화하는 구간에서 **새어 나온 미처리 거부**(unhandledRejection)를
 * 붙잡아 돌려준다 — 프로세스를 죽이지 않게 한다.
 *
 * 왜 필요한가: 정본 `addStatusItem` 예제 패턴처럼 `events.on(...)`을 return도 `.catch`도 않은
 * 채 흘리고(흔한 실수) 그 호출이 거부되면(예: `settings` 권한 선언 누락 → PERMISSION_UNDECLARED),
 * 반환되지 않은 그 거부 프라미스가 Node의 `unhandledRejection`으로 프로세스를 통째로 죽인다 —
 * `--json` 계약(JSON만 출력)을 깨고 원시 스택 트레이스만 남긴다. 이 창 동안 기존 리스너를 잠시
 * 걷어내(vitest 등 외부 핸들러가 대신 죽이지 못하게) 우리 핸들러만 거부를 모으고, 끝나면 원복한다.
 */
async function withUnhandledRejectionCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const prior = process.listeners("unhandledRejection");
  for (const l of prior) process.removeListener("unhandledRejection", l);
  const handler = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    const result = await fn();
    // 미처리 거부는 다음 매크로태스크 경계에서 감지된다 — 한 틱 더 흘려 확실히 붙잡는다.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { result, unhandled };
  } finally {
    process.removeListener("unhandledRejection", handler);
    for (const l of prior) {
      process.on("unhandledRejection", l as (reason: unknown) => void);
    }
  }
}

/** 붙잡은 미처리 거부를 findings로 옮긴다 — 거부·진단과 같이 warn이다(의도된 권한 축소
 * 테스트일 수 있어 통과를 막지 않되, 저작자에게 "여기서 .catch/return을 빠뜨렸다"를 알린다).
 * 이 흡수가 없으면 이 거부는 finding이 아니라 프로세스 크래시로 나타난다(위 헬퍼 참고). */
function unhandledRejectionFindings(unhandled: unknown[]): Finding[] {
  return unhandled.map((reason) => {
    const err = reason as { code?: unknown; call?: unknown } | null;
    const call = typeof err?.call === "string" ? err.call : undefined;
    const code = typeof err?.code === "string" ? err.code : undefined;
    const msg = reason instanceof Error ? reason.message : String(reason);
    const where = call ? `(${call}${code ? `, ${code}` : ""})` : "";
    return {
      severity: "warn",
      code: "UNHANDLED_REJECTION",
      message: `반환·처리되지 않은 거부 프라미스가 새어 나왔습니다${where}: ${msg} — 체인을 return 하거나 .catch를 거세요(함정 #10)`,
    };
  });
}

/** JSON 파일을 읽는다. 없으면 undefined, 파싱 실패면 findings에 error를 남기고 undefined. */
function readJsonFile(
  filePath: string | undefined,
  flag: string,
  findings: Finding[],
): unknown {
  if (filePath === undefined) return undefined;
  if (!existsSync(filePath)) {
    findings.push({
      severity: "error",
      code: "OPTION_FILE_MISSING",
      message: `${flag} 파일을 찾을 수 없음: ${filePath}`,
    });
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    findings.push({
      severity: "error",
      code: "OPTION_FILE_INVALID_JSON",
      message: `${flag} 파일이 유효한 JSON이 아님(${filePath}): ${e instanceof Error ? e.message : String(e)}`,
    });
    return undefined;
  }
}

/** `HeadlessPlugin`(test-host.ts)을 JSON 직렬화 가능한 덤프로 옮긴다(함수 필드 없음 — 등록
 * 시점에 이미 함수 값은 `[Function]`으로 치환돼 있다, sanitizeArgs 참고). */
function dumpPlugin(plugin: {
  id: string;
  ready: boolean;
  buttons: unknown[];
  patterns: unknown[];
  completions: unknown[];
  embeds: unknown[];
  commands: unknown[];
  subscriptions: unknown[];
  menuItems: unknown[];
  selectionActions: unknown[];
  statusItems: unknown[];
  trayItems: unknown[];
  theme: unknown;
  background: unknown;
  font: unknown;
  windowControls: unknown[];
  calls: unknown[];
  rejections: unknown[];
  diagnostics: unknown[];
  errors: Error[];
}): HarnessDump {
  return {
    id: plugin.id,
    ready: plugin.ready,
    buttons: plugin.buttons,
    patterns: plugin.patterns,
    completions: plugin.completions,
    embeds: plugin.embeds,
    commands: plugin.commands,
    subscriptions: plugin.subscriptions,
    menuItems: plugin.menuItems,
    selectionActions: plugin.selectionActions,
    statusItems: plugin.statusItems,
    trayItems: plugin.trayItems,
    theme: plugin.theme,
    background: plugin.background,
    font: plugin.font,
    windowControls: plugin.windowControls,
    calls: plugin.calls,
    rejections: plugin.rejections,
    diagnostics: plugin.diagnostics,
    errors: plugin.errors.map((e) => e.message),
    logs: extractLogs(plugin.calls),
  };
}

/** 하니스 관측(동기 throw·거부된 호출·진단)을 findings로 옮긴다 — 등록 형식 오류(validate/
 * lint)와 값 공간이 다르므로 code는 이 파일 전용 어휘다. throw만 error다: 저작자가 일부러
 * 권한을 좁혀 거부 경로를 테스트할 수 있으므로(LoadPluginOptions.granted) 거부·진단은 통과를
 * 막지 않는다(warn) — lint의 "확신이 덜한 규칙은 warn" 정책과 같다. */
function observationFindings(dump: HarnessDump): Finding[] {
  const findings: Finding[] = [];
  for (const msg of dump.errors) {
    findings.push({
      severity: "error",
      code: "RUNTIME_THROW",
      message: `역호출(onClick/run/handler) 또는 최상위 코드가 동기적으로 예외를 던짐: ${msg}`,
    });
  }
  for (const rej of dump.rejections as { call?: unknown; code?: unknown }[]) {
    findings.push({
      severity: "warn",
      code: "CALL_REJECTED",
      message: `${String(rej.call)} 호출이 거부됨(${String(rej.code ?? "UNKNOWN")}) — 권한 미부여이거나 잘못된 인자일 수 있다`,
    });
  }
  for (const diag of dump.diagnostics as {
    kind?: unknown;
    message?: unknown;
  }[]) {
    findings.push({
      severity: "warn",
      code: String(diag.kind ?? "DIAGNOSTIC"),
      message: String(diag.message ?? ""),
    });
  }
  return findings;
}

/** 공통: 옵션 파일을 읽어 하니스 로드 오버라이드를 만든다. 파일 오류는 findings에 쌓이고
 * undefined로 취급한다(로드 자체는 계속 시도 — 나머지 옵션이라도 유효할 수 있다). */
function loadOverrides(
  opts: RunOptions,
  findings: Finding[],
): {
  settings?: Record<string, unknown>;
  granted?: string[];
  stubs?: Record<string, unknown>;
} {
  const settings = readJsonFile(opts.settingsPath, "--settings", findings) as
    Record<string, unknown> | undefined;
  const stubs = readJsonFile(opts.stubPath, "--stub", findings) as
    Record<string, unknown> | undefined;
  return { settings, granted: opts.granted, stubs };
}

interface RunResult {
  findings: Finding[];
  dump?: HarnessDump;
}

/** `memo-plugin run <dir>` — 로드만 하고 등록 결과를 덤프한다(액션 발화 없음). */
export async function runRunCommand(
  pluginDir: string,
  contract: HostContract,
  opts: RunOptions,
): Promise<RunResult> {
  const findings: Finding[] = [];
  const overrides = loadOverrides(opts, findings);
  let plugin: Awaited<ReturnType<HostContract["loadPluginFromDir"]>>;
  let unhandled: unknown[] = [];
  try {
    const captured = await withUnhandledRejectionCapture(() =>
      withSilencedRuntimeLog(() =>
        contract.loadPluginFromDir(pluginDir, overrides),
      ),
    );
    plugin = captured.result;
    unhandled = captured.unhandled;
  } catch (e) {
    findings.push({
      severity: "error",
      code: "LOAD_FAILED",
      message: e instanceof Error ? e.message : String(e),
    });
    return { findings };
  }
  const dump = dumpPlugin(plugin);
  findings.push(...observationFindings(dump));
  findings.push(...unhandledRejectionFindings(unhandled));
  return { findings, dump };
}

interface TestResult extends RunResult {
  /** 발화시킨 액션과 그 액션이 낸 호출만 골라낸 것(로드 시점 호출은 제외 — dump.calls에
   * 전체가 있다). */
  action?: {
    kind: "click" | "command" | "event" | "menu" | "tray" | "selection";
    target: string;
    payload: unknown;
    calls: unknown[];
  };
}

/** `memo-plugin test <dir> --click|--command|--event|--menu|--tray|--selection <값>` — 로드 후
 * 액션 하나를 발화시켜 그 호출 시퀀스를 덤프에 더한다. cli.ts가 여섯 플래그 중 정확히 하나만
 * 오도록 강제한다. */
export async function runTestCommand(
  pluginDir: string,
  contract: HostContract,
  opts: TestOptions,
): Promise<TestResult> {
  const findings: Finding[] = [];
  const overrides = loadOverrides(opts, findings);
  let plugin: Awaited<ReturnType<HostContract["loadPluginFromDir"]>>;
  const unhandled: unknown[] = [];
  try {
    const captured = await withUnhandledRejectionCapture(() =>
      withSilencedRuntimeLog(() =>
        contract.loadPluginFromDir(pluginDir, overrides),
      ),
    );
    plugin = captured.result;
    unhandled.push(...captured.unhandled);
  } catch (e) {
    findings.push({
      severity: "error",
      code: "LOAD_FAILED",
      message: e instanceof Error ? e.message : String(e),
    });
    return { findings };
  }

  const before = plugin.calls.length;
  // 미리 확정한다(try 안에서 대입하면 TS의 definite-assignment 분석이 catch 블록에서
  // "할당 전 사용"으로 본다 — kind/target은 발화 전에 이미 정해져 있어야 하는 값이라 try
  // 진입 전에 고정하는 편이 더 정직하기도 하다).
  const kind: "click" | "command" | "event" | "menu" | "tray" | "selection" =
    opts.click !== undefined
      ? "click"
      : opts.command !== undefined
        ? "command"
        : opts.menu !== undefined
          ? "menu"
          : opts.tray !== undefined
            ? "tray"
            : opts.selection !== undefined
              ? "selection"
              : "event";
  const target =
    opts.click ??
    opts.command ??
    opts.menu ??
    opts.tray ??
    opts.selection ??
    opts.event ??
    "";
  try {
    const captured = await withUnhandledRejectionCapture(() =>
      withSilencedRuntimeLog(async () => {
        if (kind === "click") await plugin.clickButton(target, opts.payload);
        else if (kind === "command")
          await plugin.runCommand(target, opts.payload);
        else if (kind === "menu")
          // 메뉴 항목 역호출: 하니스가 중앙 호스트와 같은 payload.selectedText 게이트를 재현한다
          // (needsSelectedText일 때만 selectedText를 싣는다). --payload로 selectedText를 흘린다.
          await plugin.invokeMenuItem(
            target,
            opts.payload as { selectedText?: string } | undefined,
          );
        else if (kind === "tray")
          // 트레이 항목 역호출: 창 컨텍스트도 payload도 없다(중앙 호스트 invokeTrayItem과
          // 동일) — --payload는 무시된다(트레이 run은 빈 객체만 받는다).
          await plugin.invokeTrayItem(target);
        else if (kind === "selection")
          // 선택 액션 역호출: 하니스가 앱과 같은 `match` 판정 + payload.selectedText 게이트를
          // 재현한다(조건이 안 맞으면 던져 ACTION_FAILED로 보인다 — 앱에서 눌리지도 않을
          // 액션이 여기서만 통과하는 거짓 그린을 막는다). --payload로 selectedText를 흘린다.
          await plugin.invokeSelectionAction(
            target,
            opts.payload as { selectedText?: string } | undefined,
          );
        else
          await plugin.emitEvent(
            target as Parameters<typeof plugin.emitEvent>[0],
            opts.payload,
          );
      }),
    );
    unhandled.push(...captured.unhandled);
  } catch (e) {
    findings.push({
      severity: "error",
      code: "ACTION_FAILED",
      message: `${kind}(${target}) 발화 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
    const dump = dumpPlugin(plugin);
    findings.push(...observationFindings(dump));
    findings.push(...unhandledRejectionFindings(unhandled));
    return { findings, dump };
  }

  const dump = dumpPlugin(plugin);
  findings.push(...observationFindings(dump));
  findings.push(...unhandledRejectionFindings(unhandled));
  return {
    findings,
    dump,
    action: {
      kind,
      target,
      payload: opts.payload,
      calls: dump.calls.slice(before),
    },
  };
}

/** `run` 결과를 사람이 읽는 텍스트 줄로 요약한다(`--json`이 아닐 때 cli.ts가 extraLines로
 * 붙인다). JSON 모드는 `dump` 자체를 그대로 낸다 — 이 함수를 거치지 않는다. */
export function formatRunDumpLines(dump: HarnessDump): string[] {
  const lines = [
    `등록: 버튼 ${dump.buttons.length}개 · 패턴 ${dump.patterns.length}개 · 자동완성 ${dump.completions.length}개 · 임베드 ${dump.embeds.length}개 · 명령 ${dump.commands.length}개 · 구독 ${dump.subscriptions.length}개 · 메뉴 ${dump.menuItems.length}개 · 선택 액션 ${dump.selectionActions.length}개 · 상태 ${dump.statusItems.length}개 · 트레이 ${dump.trayItems.length}개`,
    `능력: 테마 ${dump.theme ? "있음" : "없음"} · 배경 ${dump.background ? "있음" : "없음"} · 폰트 ${dump.font ? "있음" : "없음"} · 창 컨트롤 ${dump.windowControls.length}개`,
    `runtime.ready 호출됨: ${dump.ready ? "예" : "아니오"}`,
    `호출 ${dump.calls.length}건 · 거부 ${dump.rejections.length}건 · 진단 ${dump.diagnostics.length}건 · 예외 ${dump.errors.length}건`,
  ];
  if (dump.logs.length > 0) {
    lines.push(`memo.runtime.log 메시지 ${dump.logs.length}건:`);
    for (const msg of dump.logs) lines.push(`  - ${msg}`);
  }
  return lines;
}

/** `test`의 발화 결과를 텍스트 줄로 요약한다(`formatRunDumpLines` 뒤에 이어 붙인다). */
export function formatActionLines(action: TestResult["action"]): string[] {
  if (!action) return [];
  const lines = [
    "",
    `발화: ${action.kind}(${action.target})${action.payload !== undefined ? ` payload=${JSON.stringify(action.payload)}` : ""}`,
  ];
  if (action.calls.length === 0) {
    lines.push("  이 발화가 낸 호출 없음");
  } else {
    lines.push(`  이 발화가 낸 호출 ${action.calls.length}건:`);
    for (const c of action.calls as {
      call: string;
      ok: boolean;
      code?: string;
    }[]) {
      lines.push(`    - ${c.call} ${c.ok ? "성공" : `거부(${c.code ?? "?"})`}`);
    }
  }
  return lines;
}
