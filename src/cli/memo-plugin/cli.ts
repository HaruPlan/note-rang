/**
 * memo-plugin CLI(1단계 + 2단계) — `validate`/`lint`/`run`/`test`/`scaffold`/`types`
 * 진입점.
 *
 * 역할: 플러그인 폴더를 받아 매니페스트·코드를 검증하거나(validate/lint), 헤드리스로 실행해
 * 등록·호출을 단언하거나(run/test), 새 뼈대를 만들거나(scaffold), 타입 선언을 동봉한다(types).
 * 사람용 텍스트 또는 `--json`(기계용) 결과를 낸다. AI 에이전트가 자기 산출물을 앱을 띄우지
 * 않고 스스로 검증·실행·생성하는 유일한 창구다.
 *
 * 실행: `npm run plugin -- validate ./my-plugin`
 *       `npm run plugin -- lint ./my-plugin`
 *       `npm run plugin -- run ./my-plugin`
 *       `npm run plugin -- test ./my-plugin --click my-btn`
 *       `npm run plugin -- scaffold my-plugin --template=toolbar-button`
 *       `npm run plugin -- types ./my-plugin`
 * **`--json`을 쓸 때는 `npm run plugin --silent -- …`** — npm이 표준출력에 실행 배너
 * (`> memo@0.1.0 plugin` 두 줄)를 먼저 찍어서, 그것 없이는 stdout 전체가 유효한 JSON이
 * 아니다(`JSON.parse`가 `Unexpected token '>'`로 죽는다). 배너를 아예 피하려면
 * `node src/cli/memo-plugin/cli.ts lint ./my-plugin --json`으로 직접 실행한다.
 * (= `node src/cli/memo-plugin/cli.ts …`. Node 22의 내장 TS 타입 스트리핑으로 별도 빌드 없이
 * 직접 실행된다. 단 이 폴더 안의 상대 import는 **확장자를 명시해야 한다** — Node의 ESM
 * 해석기는 저장소의 확장자 없는 import를 못 찾는다. tsconfig의 `allowImportingTsExtensions`
 * 덕에 `.ts`를 붙여도 타입 검사는 그대로 통과한다. `src/plugin/*`은 Vite의 SSR 로더로
 * 불러오므로 그쪽은 무관하다 — host-bridge.ts 참고.)
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadHostContract } from "./host-bridge.ts";
import { runValidate } from "./validate.ts";
import { runLint } from "./lint.ts";
import { runTypes } from "./types-cmd.ts";
import {
  runRunCommand,
  runTestCommand,
  formatRunDumpLines,
  formatActionLines,
} from "./run-cmd.ts";
import {
  runScaffold,
  SCAFFOLD_TEMPLATES,
  isScaffoldTemplate,
} from "./scaffold.ts";
import { formatJson, formatText, exitCodeFor } from "./report.ts";

const DEFAULT_TEMPLATE = "toolbar-button";

const HELP_TEXT = `memo-plugin — memo 플러그인 저작 CLI

사용법:
  memo-plugin validate <dir> [--json]              매니페스트 구조 검증
  memo-plugin lint <dir> [--json]                  정적 저작 실수 검사(존재하지 않는 호출·미선언 권한 등)
  memo-plugin run <dir> [옵션]                      앱 없이 플러그인을 로드해 등록 결과를 덤프
  memo-plugin test <dir> --click|--command|--event|--menu|--tray|--selection <값> [옵션]
                                                    로드 후 클릭/명령/이벤트/메뉴/트레이/선택 액션 하나를 발화시켜 호출 시퀀스를 덤프
  memo-plugin scaffold <id> [옵션]                  동작하는 플러그인 뼈대를 새로 만든다
  memo-plugin types <dir> [--json]                 plugin-api.d.ts·settings.d.ts를 동봉/갱신한다
  memo-plugin --help                               이 도움말

run/test 옵션:
  --settings=<경로>   저장된(디스크) 설정 값 JSON 파일(생략하면 매니페스트 기본값만 씀)
  --granted=<a,b>     승인 권한 재정의(생략하면 매니페스트 선언 권한 전부 승인)
  --stub=<경로>       창-스코프·호스트 호출 응답 JSON 파일(예: {"notes.current": {"id":"n1"}})
  --payload=<JSON>    test 전용 — 역호출에 실어 보낼 payload(JSON 문자열)
  --json              기계가 파싱할 JSON

test 전용(정확히 하나):
  --click=<id>        툴바 버튼 클릭을 시뮬레이션(onClick 발화)
  --command=<id>       명령 실행을 시뮬레이션(run 발화)
  --event=<이름>       이벤트 발화를 시뮬레이션(그 이름의 모든 구독 handler 발화)
  --menu=<id>          컨텍스트 메뉴 항목 선택을 시뮬레이션(run 발화; 선택 텍스트는 --payload로: {"selectedText":"..."})
  --tray=<id>          메뉴바 트레이 항목 클릭을 시뮬레이션(run 발화; 창 컨텍스트·payload 없음)
  --selection=<id>     선택 액션 실행을 시뮬레이션(run 발화; 선택 텍스트는 --payload로: {"selectedText":"..."})

scaffold 옵션:
  --template=<이름>   ${SCAFFOLD_TEMPLATES.join(" | ")} 중 하나(기본 ${DEFAULT_TEMPLATE})
  --name=<이름>       manifest.json의 표시 이름(생략하면 id를 그대로 씀 — 나중에 손으로 바꿔라)
  --dir=<경로>        출력 폴더(생략하면 현재 폴더 아래 ./<id>)
  --force             출력 폴더가 이미 있고 비어 있지 않아도 덮어쓴다
  --no-types          plugin-api.d.ts·settings.d.ts 동봉과 main.js 참조 주석을 건너뛴다(기본은 동봉)
  --json              기계가 파싱할 JSON

옵션(공통):
  --json   사람용 텍스트 대신 기계가 파싱할 JSON을 표준출력에 낸다.
           npm 경유로 파싱할 때는 --silent가 필요하다(npm 실행 배너가 JSON 앞에 섞인다):
             npm run plugin --silent -- lint <dir> --json
           또는 배너 없이 직접: node src/cli/memo-plugin/cli.ts lint <dir> --json

범위: validate/lint는 정적 검사만 한다 — 등록 마감 타이밍·창 컨텍스트 전파 같은 실행
의미론은 재현하지 않는다("위험" 절 참고). run/test는 그
실행 의미론을 헤드리스 하니스(test-host.ts)로 재현하지만 iframe·postMessage·CSP 격리
자체와 다중 창 토큰 라우팅은 범위 밖이다 — 그건 e2e가 지킨다. scaffold는 생성 직후 스스로
lint를 돌려 결과를 함께 보고한다 — 오류가 있으면 그건 템플릿의 버그다.`;

interface ParsedArgs {
  command?: string;
  /** command 다음에 오는 위치 인자 전체(플래그 제외). validate/lint/run/test/types는 [0]이
   * dir, scaffold는 [0]이 id다. */
  positionals: string[];
  json: boolean;
  help: boolean;
  force: boolean;
  /** scaffold 전용, 기본 true. `--no-types`를 주면 false. */
  withTypes: boolean;
  template?: string;
  name?: string;
  dir?: string;
  /** run/test 전용(--settings) — 저장된 설정 값 JSON 파일 경로. */
  settings?: string;
  /** run/test 전용(--granted=a,b) — 승인 권한 재정의. */
  granted?: string[];
  /** run/test 전용(--stub) — 창-스코프·호스트 호출 응답 JSON 파일 경로. */
  stub?: string;
  /** test 전용(--payload) — 역호출 payload(JSON 문자열, 아직 파싱 전). */
  payload?: string;
  /** test 전용, 넷 중 최대 하나만 채워진다(cli.ts가 "정확히 하나"를 강제). */
  click?: string;
  testCommand?: string;
  event?: string;
  /** test 전용(--menu) — 컨텍스트 메뉴 항목 선택 시뮬레이션(run 발화). */
  menu?: string;
  /** test 전용(--tray) — 메뉴바 트레이 항목 클릭 시뮬레이션(run 발화, payload 없음). */
  tray?: string;
  /** test 전용(--selection) — 선택 액션 실행 시뮬레이션(run 발화; 선택 텍스트는 --payload로). */
  selection?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const positionals: string[] = [];
  let json = false;
  let help = false;
  let force = false;
  let withTypes = true;
  let template: string | undefined;
  let name: string | undefined;
  let dir: string | undefined;
  let settings: string | undefined;
  let granted: string[] | undefined;
  let stub: string | undefined;
  let payload: string | undefined;
  let click: string | undefined;
  let testCommand: string | undefined;
  let event: string | undefined;
  let menu: string | undefined;
  let tray: string | undefined;
  let selection: string | undefined;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--force") force = true;
    else if (a === "--no-types") withTypes = false;
    else if (a.startsWith("--template="))
      template = a.slice("--template=".length);
    else if (a.startsWith("--name=")) name = a.slice("--name=".length);
    else if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--settings="))
      settings = a.slice("--settings=".length);
    else if (a.startsWith("--granted="))
      granted = a
        .slice("--granted=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    else if (a.startsWith("--stub=")) stub = a.slice("--stub=".length);
    else if (a.startsWith("--payload=")) payload = a.slice("--payload=".length);
    else if (a.startsWith("--click=")) click = a.slice("--click=".length);
    else if (a.startsWith("--command="))
      testCommand = a.slice("--command=".length);
    else if (a.startsWith("--event=")) event = a.slice("--event=".length);
    else if (a.startsWith("--menu=")) menu = a.slice("--menu=".length);
    else if (a.startsWith("--tray=")) tray = a.slice("--tray=".length);
    else if (a.startsWith("--selection="))
      selection = a.slice("--selection=".length);
    else if (command === undefined) command = a;
    else positionals.push(a);
  }
  return {
    command,
    positionals,
    json,
    help,
    force,
    withTypes,
    template,
    name,
    dir,
    settings,
    granted,
    stub,
    payload,
    click,
    testCommand,
    event,
    menu,
    tray,
    selection,
  };
}

interface CliRun {
  exitCode: number;
  output: string;
}

const KNOWN_COMMANDS = [
  "validate",
  "lint",
  "run",
  "test",
  "scaffold",
  "types",
] as const;

/** CLI 로직 본체 — argv(명령 이름 제외, `process.argv.slice(2)`)를 받아 결과를 돌려준다.
 * 표준출력에 직접 쓰지 않는다(테스트가 부수효과 없이 호출할 수 있도록). */
export async function runCli(argv: string[]): Promise<CliRun> {
  const parsed = parseArgs(argv);
  const { command, json, help } = parsed;

  if (help || command === undefined) {
    return { exitCode: help ? 0 : 1, output: HELP_TEXT };
  }
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    return {
      exitCode: 1,
      output: `알 수 없는 명령: ${command}\n\n${HELP_TEXT}`,
    };
  }

  if (command === "scaffold") {
    return runScaffoldCommand(parsed);
  }

  if (command === "test") {
    const targets = [
      parsed.click,
      parsed.testCommand,
      parsed.event,
      parsed.menu,
      parsed.tray,
      parsed.selection,
    ].filter((v) => v !== undefined);
    if (targets.length !== 1) {
      return {
        exitCode: 1,
        output: `test에는 --click|--command|--event|--menu|--tray|--selection 중 정확히 하나가 필요합니다(받은 개수: ${targets.length}): memo-plugin test <dir> --click <id>`,
      };
    }
  }

  const dir = parsed.positionals[0];
  if (dir === undefined) {
    return {
      exitCode: 1,
      output: `플러그인 디렉터리 경로가 필요합니다: memo-plugin ${command} <dir>`,
    };
  }
  const resolvedDir = path.resolve(process.cwd(), dir);
  if (!existsSync(resolvedDir)) {
    return { exitCode: 1, output: `디렉터리를 찾을 수 없음: ${resolvedDir}` };
  }

  const { contract, close } = await loadHostContract();
  try {
    if (command === "types") {
      const result = await runTypes(resolvedDir, contract);
      const extraLines =
        result.wrote.length > 0
          ? ["갱신됨:", ...result.wrote.map((f) => `  - ${f}`)]
          : ["(바뀐 것 없음 — 이미 최신)"];
      const output = json
        ? formatJson(command, resolvedDir, result.findings, {
            wrote: result.wrote,
          })
        : formatText(command, resolvedDir, result.findings, extraLines);
      return { exitCode: exitCodeFor(result.findings), output };
    }
    if (command === "run" || command === "test") {
      const runOpts = {
        settingsPath:
          parsed.settings !== undefined
            ? path.resolve(process.cwd(), parsed.settings)
            : undefined,
        granted: parsed.granted,
        stubPath:
          parsed.stub !== undefined
            ? path.resolve(process.cwd(), parsed.stub)
            : undefined,
      };
      if (command === "run") {
        const result = await runRunCommand(resolvedDir, contract, runOpts);
        const output = json
          ? formatJson(command, resolvedDir, result.findings, {
              dump: result.dump,
            })
          : formatText(
              command,
              resolvedDir,
              result.findings,
              result.dump ? formatRunDumpLines(result.dump) : undefined,
            );
        return { exitCode: exitCodeFor(result.findings), output };
      }
      let payload: unknown;
      if (parsed.payload !== undefined) {
        try {
          payload = JSON.parse(parsed.payload);
        } catch (e) {
          return {
            exitCode: 1,
            output: `--payload가 유효한 JSON이 아님: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      const result = await runTestCommand(resolvedDir, contract, {
        ...runOpts,
        click: parsed.click,
        command: parsed.testCommand,
        event: parsed.event,
        menu: parsed.menu,
        tray: parsed.tray,
        selection: parsed.selection,
        payload,
      });
      const output = json
        ? formatJson(command, resolvedDir, result.findings, {
            dump: result.dump,
            action: result.action,
          })
        : formatText(
            command,
            resolvedDir,
            result.findings,
            result.dump
              ? [
                  ...formatRunDumpLines(result.dump),
                  ...formatActionLines(result.action),
                ]
              : undefined,
          );
      return { exitCode: exitCodeFor(result.findings), output };
    }
    const findings =
      command === "validate"
        ? (await runValidate(resolvedDir, contract)).findings
        : await runLint(resolvedDir, contract);
    const output = json
      ? formatJson(command, resolvedDir, findings)
      : formatText(command, resolvedDir, findings);
    return { exitCode: exitCodeFor(findings), output };
  } finally {
    await close();
  }
}

async function runScaffoldCommand(parsed: ParsedArgs): Promise<CliRun> {
  const id = parsed.positionals[0];
  if (id === undefined) {
    return {
      exitCode: 1,
      output:
        "플러그인 id가 필요합니다: memo-plugin scaffold <id> [--template=...]",
    };
  }
  const templateName = parsed.template ?? DEFAULT_TEMPLATE;
  if (!isScaffoldTemplate(templateName)) {
    return {
      exitCode: 1,
      output: `모르는 템플릿: '${templateName}' — 가능한 값: ${SCAFFOLD_TEMPLATES.join(", ")}`,
    };
  }
  const outDir =
    parsed.dir !== undefined
      ? path.resolve(process.cwd(), parsed.dir)
      : path.resolve(process.cwd(), id);

  const { contract, close } = await loadHostContract();
  try {
    const result = await runScaffold(
      id,
      {
        template: templateName,
        name: parsed.name,
        outDir,
        force: parsed.force,
        withTypes: parsed.withTypes,
      },
      contract,
    );
    const extraLines =
      result.wrote.length > 0
        ? [`생성됨(${result.outDir}):`, ...result.wrote.map((f) => `  - ${f}`)]
        : [];
    const output = parsed.json
      ? formatJson("scaffold", result.outDir, result.findings, {
          wrote: result.wrote,
          template: templateName,
        })
      : formatText("scaffold", result.outDir, result.findings, extraLines);
    return { exitCode: exitCodeFor(result.findings), output };
  } finally {
    await close();
  }
}

// 직접 실행됐을 때만 부수효과(표준출력·process.exit)를 낸다 — 다른 모듈이 import할 때는
// 실행되지 않는다(테스트가 `runCli`만 순수하게 호출할 수 있게).
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { exitCode, output } = await runCli(process.argv.slice(2));
  console.log(output);
  process.exit(exitCode);
}
