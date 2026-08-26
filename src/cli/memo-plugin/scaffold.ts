/**
 * memo-plugin CLI(1단계) — `scaffold <id>`: 동작하는 플러그인 뼈대를 새로 만든다.
 *
 * 역할: `docs/plugin/examples/`의 정본 예제와 같은 정신으로 쓴 템플릿 4종 중 하나를 골라
 * `manifest.json`·`main.js`·`README.md`를 새 폴더에 낸다. 손으로 옮겨 적은 사본이 아니라
 * 이 파일 안의 템플릿 함수가 **유일한 출처**다(정본 예제와 템플릿이 서로 다른 곳에서 각자
 * 관리되면 둘 중 하나는 반드시 썩는다 — 이 저장소가 반복해서 겪은 패턴).
 *
 * "생성물은 즉시 validate/lint를 통과하고 실제로 로드돼야 한다"(지시)를 지키는 방법은
 * 검사 규칙을 믿는 것이 아니라 **생성 직후 실물 lint를 스스로 돌려 확인하는 것**이다 — 그래서
 * `runScaffold`의 마지막 단계는 항상 `runLint`이고, 그 결과가 findings에 그대로 실린다.
 * 템플릿에 버그가 생기면(예: 인자 실수) 이 자기검증이 그 자리에서 실패로 표면화한다 —
 * 저작자가 나중에 `lint`를 따로 돌려서야 발견하게 두지 않는다.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HostContract } from "./host-bridge.ts";
import type { Finding } from "./types.ts";
import { runLint } from "./lint.ts";
import { runTypes } from "./types-cmd.ts";

export const SCAFFOLD_TEMPLATES = [
  "inline-pattern",
  "toolbar-button",
  "settings-driven",
  "command",
] as const;
export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number];

export function isScaffoldTemplate(v: string): v is ScaffoldTemplate {
  return (SCAFFOLD_TEMPLATES as readonly string[]).includes(v);
}

interface TemplateOutput {
  /** manifest.json에 병합할 필드. `$schema`·id·name·version·entry·kind는
   * `runScaffold`가 공통으로 채우므로 여기서 다시 안 쓴다. */
  manifestExtra: Record<string, unknown>;
  mainJs: string;
  readmeBody: string;
}

/** 템플릿 1 — 인라인 패턴(가장 작은 완본). `docs/plugin/examples/example-starter`와 같은 3단
 * 골격(등록 → 마감 선언 → 실패 기록)을 그대로 쓴다. */
function inlinePatternTemplate(): TemplateOutput {
  return {
    manifestExtra: {
      summary: "인라인 패턴 하나 — ==강조== 표기를 형광펜으로",
      purpose: "==강조== 표기를 형광펜 스타일로 그린다",
      permissions: ["editor"],
      permissionReasons: {
        editor: "본문에 인라인 패턴(형광펜) 하나를 등록합니다",
      },
    },
    mainJs: `/* global memo */ // 전역 \`memo\`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// memo-plugin scaffold --template=inline-pattern 산출물.
//
// 역할: \`==강조==\` 표기를 형광펜 스타일로 그린다(인라인 패턴 등록 하나).
// 다음: id·open·close·style을 바꾸거나, registerCompletion/registerBlockEmbed를 더 등록해라.

memo.editor
  .registerInlinePattern({
    id: "highlight",
    open: "==",
    close: "==",
    // 스타일은 구조화 화이트리스트다 — raw CSS 문자열·셀렉터는 줄 수 없다. 허용 속성·색
    // 의미 토큰은 docs/plugin/authoring.md의 "인라인 패턴 스타일" 절 참고.
    style: {
      backgroundColor: "rgba(250, 204, 21, 0.35)",
      borderRadius: "2px",
    },
  })
  .then(function () {
    // 등록 마감을 명시한다 — 없어도 부트스트랩이 "조용해지면" 알아서 마감하지만, 명시해
    // 두면 나중에 비동기 초기화를 넣어도 안 깨진다.
    return memo.runtime.ready();
  })
  .catch(function (e) {
    // .catch가 없으면 실패의 흔적이 아무 데도 안 남는다(불투명 origin이라 devtools도 못
    // 붙는다). e.code는 기계용 안정 코드, e.call은 호출명이다.
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
`,
    readmeBody:
      "인라인 패턴 하나를 등록하는 최소 골격입니다. `main.js`의 `open`/`close`/`style`을 바꿔 새 패턴을 만드세요.",
  };
}

/** 템플릿 2 — 툴바 버튼. 바인딩된 `memo`로 창-스코프 호출을 안전하게 잇는 패턴을 보여준다. */
function toolbarButtonTemplate(): TemplateOutput {
  return {
    manifestExtra: {
      summary: "노트 툴바에 버튼 하나 — 누르면 토스트로 알림",
      purpose: "툴바 버튼을 누르면 지금 메모의 경로를 토스트로 보여준다",
      permissions: ["ui", "notes:read"],
      permissionReasons: {
        ui: "툴바 버튼과 결과 토스트를 띄웁니다",
        "notes:read": "지금 열린 메모의 경로를 읽습니다",
      },
    },
    mainJs: `/* global memo */ // 전역 \`memo\`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// memo-plugin scaffold --template=toolbar-button 산출물.
//
// 역할: 노트 툴바에 버튼 하나를 달고, 클릭하면 현재 노트의 경로를 토스트로 보여준다.
// 다음: onClick 안에서 원하는 memo.* 호출을 이어라. 창-스코프 호출은 항상 onClick의 첫
// 인자로 오는 **바인딩된 memo**로 해라(전역 memo는 Promise.all·setTimeout을 넘으면 다른
// 창으로 샐 수 있다 — docs/plugin/examples/example-window-calls 참고).

memo.ui
  .addToolbarButton({
    id: "show-path",
    label: "📍",
    title: "이 메모의 경로 보기",
    // position은 배치를 한 번도 본 적 없을 때만 쓰이는 자동 배치 존이다 — 실제 위치는
    // 사용자가 설정 › 외형 › 툴바 배치에서 정한다.
    position: "bottom-right",

    onClick: function (memo) {
      memo.notes
        .current()
        .then(function (note) {
          // 바인딩된 memo라 창 컨텍스트 자체는 항상 있다 — 그런데도 null이 올 수 있다:
          // 그 창이 아직 노트를 다 불러오지 못한 순간(부팅 직후 등)에는 노트가 없다.
          // 성공과 구분되지 않으므로 반드시 확인한다.
          if (note === null) {
            return memo.ui.toast({ title: "이 창의 메모를 찾지 못했습니다" });
          }
          return memo.ui.toast({ title: "지금 메모", message: note.path });
        })
        .catch(function (e) {
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
  });
`,
    readmeBody:
      "노트 툴바에 버튼 하나를 다는 골격입니다. `onClick` 안에서 memo.* 호출을 이어 원하는 동작을 붙이세요.",
  };
}

/** 템플릿 3 — 설정 있는 플러그인. `settings-types.ts`가 이 매니페스트의 `settings[]`에서
 * `settings.d.ts`를 만들 수 있도록 `text`·`select` 두 타입을 섞어 둔다(둘 다 button이
 * 아니라 실제로 값을 저장하는 타입 — settings.d.ts가 빈 인터페이스가 되지 않게). */
function settingsDrivenTemplate(): TemplateOutput {
  return {
    manifestExtra: {
      summary:
        "설정 두 개(문구·말투) + 버튼 하나 — memo-plugin types의 정본 사용례",
      purpose: "설정에서 인사말과 말투를 읽어 버튼을 누르면 토스트로 보여준다",
      permissions: ["ui", "settings"],
      permissionReasons: {
        ui: "결과를 토스트로 보여줍니다",
        settings: "인사말·말투 설정을 읽습니다",
      },
      settings: [
        {
          key: "greeting",
          label: "인사말",
          type: "text",
          default: "안녕하세요",
          placeholder: "예: 안녕하세요",
          description: "버튼을 누르면 이 문구를 보여줍니다.",
        },
        {
          key: "style",
          label: "말투",
          type: "select",
          default: "formal",
          options: [
            { value: "formal", label: "높임" },
            { value: "casual", label: "반말" },
          ],
        },
      ],
    },
    mainJs: `/* global memo */ // 전역 \`memo\`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// memo-plugin scaffold --template=settings-driven 산출물.
//
// 역할: 설정(인사말·말투)을 읽어 버튼을 누르면 토스트로 보여준다.
// 다음: manifest.json의 settings[]에 필드를 더하고 \`npm run plugin -- types <이 폴더>\`를
// 다시 돌려 settings.d.ts를 갱신해라(오타·타입 어긋남을 편집기가 바로 잡아 준다).

memo.ui
  .addToolbarButton({
    id: "show-greeting",
    label: "👋",
    title: "설정한 인사말 보여주기",
    position: "bottom-right",
    onClick: function (memo) {
      memo.settings
        .getAll()
        .then(function (cfg) {
          // 기본값은 매니페스트가 정본이다 — 저장된 값이 없으면 호스트가 default를 병합해
          // 주므로 여기서 폴백을 다시 쓰지 않는다.
          var text =
            cfg.style === "casual" ? cfg.greeting + "!" : cfg.greeting + ".";
          return memo.ui.toast({ title: "인사말", message: text });
        })
        .catch(function (e) {
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
  });
`,
    readmeBody:
      "설정(문구·말투)을 읽어 버튼 클릭에 반영하는 골격입니다. `manifest.json`의 `settings[]`를 고친 뒤 `npm run plugin -- types <폴더>`로 `settings.d.ts`를 다시 내세요.",
  };
}

/** 템플릿 4 — 버튼 없는 명령. 단축키 화면·설정 액션 버튼이 가리킬 수 있는 순수 명령. */
function commandTemplate(): TemplateOutput {
  return {
    manifestExtra: {
      summary: "명령 하나 — 단축키 화면 「플러그인 동작」에 등록",
      purpose: "단축키로 실행하면 토스트를 보여준다",
      permissions: ["commands", "ui"],
      permissionReasons: {
        commands: "단축키로 실행할 명령 하나를 등록합니다",
        ui: "실행 결과를 토스트로 보여줍니다",
      },
    },
    mainJs: `/* global memo */ // 전역 \`memo\`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// memo-plugin scaffold --template=command 산출물.
//
// 역할: 버튼 없이 명령만 하나 등록한다 — 설정 › 단축키 › 「플러그인 동작」에서 키를 배정할
// 수 있고, 매니페스트 settings[]에 { type: "button", command: "say-hello" }를 더하면 설정
// 화면의 버튼으로도 실행된다(docs/plugin/examples/example-settings-button 참고).

memo.commands
  .register({
    id: "say-hello",
    title: "인사 명령",
    run: function (memo) {
      // 설정 버튼 경로로 실행되면 창 컨텍스트가 없을 수 있다 — 여기서는 창-스코프 호출을
      // 안 쓰므로 신경 쓸 필요가 없다(toast는 ui 권한만 있으면 되는 저위험 호출).
      memo.ui
        .toast({ title: "안녕", message: "명령이 실행됐습니다" })
        .catch(function (e) {
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "명령 등록 실패: " + e.call + " → " + e.code });
  });
`,
    readmeBody:
      "버튼 없이 명령 하나만 등록하는 골격입니다. 설정 › 단축키 › 「플러그인 동작」에서 키를 배정할 수 있습니다.",
  };
}

const TEMPLATES: Record<ScaffoldTemplate, () => TemplateOutput> = {
  "inline-pattern": inlinePatternTemplate,
  "toolbar-button": toolbarButtonTemplate,
  "settings-driven": settingsDrivenTemplate,
  command: commandTemplate,
};

function buildReadme(id: string, name: string, body: string): string {
  return `# ${name}

\`memo-plugin scaffold\`가 만든 뼈대입니다.

${body}

## 다음 할 일

1. \`manifest.json\`의 \`id\`·\`name\`·\`summary\`·\`purpose\`를 자기 것으로 바꾸세요. \`id\`는 전역 고유해야 하고 **폴더 이름과 같아야** 합니다.
2. 저장소 루트에서 자기 산출물을 검사하세요:
   \`\`\`
   npm run plugin -- lint ${id}
   \`\`\`
3. 설정 창 「플러그인 → 로컬 폴더」로 이 폴더를 설치해 확인하세요.

계약 전체(호출별 인자·반환·권한·오류 코드)는 저장소의 \`docs/plugin/api-reference.json\`에, 사람이 읽는 설명은 \`docs/plugin/authoring.md\`에 있습니다.
`;
}

interface ScaffoldOptions {
  template: ScaffoldTemplate;
  /** manifest.json의 name(선택 — 생략하면 id를 그대로 쓴다, 저작자가 나중에 바꾸는 것을
   * 전제한다. 기존 정본 예제도 같은 방식으로 "복사 후 이름을 바꿔라"를 안내한다). */
  name?: string;
  outDir: string;
  /** outDir가 이미 있고 비어 있지 않아도 덮어쓴다. */
  force?: boolean;
  /** plugin-api.d.ts·settings.d.ts 동봉 + main.js 참조 주석을 건너뛴다.
   * 기본은 켬(지시: scaffold와 types가 함께 이 일을 한다). */
  withTypes?: boolean;
}

interface ScaffoldResult {
  findings: Finding[];
  /** 새로 쓴 파일(outDir 기준 상대 경로). */
  wrote: string[];
  outDir: string;
}

export async function runScaffold(
  id: string,
  opts: ScaffoldOptions,
  contract: HostContract,
): Promise<ScaffoldResult> {
  const template = TEMPLATES[opts.template];
  if (template === undefined) {
    return {
      findings: [
        {
          severity: "error",
          code: "UNKNOWN_TEMPLATE",
          message: `모르는 템플릿: '${opts.template}' — 가능한 값: ${SCAFFOLD_TEMPLATES.join(", ")}`,
        },
      ],
      wrote: [],
      outDir: opts.outDir,
    };
  }
  const { manifestExtra, mainJs, readmeBody } = template();
  const name = opts.name ?? id;
  // `minHostVersion`은 **일부러 넣지 않는다**: 자동 계산의 근거인 인덱스의 `since` 메타가
  // 아직 없고(부분 구현), 출시 전이라 사용자 대면 버전 정책도 정해지지 않았다 — 지어낸
  // 기준으로 채우면 설치 게이트가 잘못된 값 위에서 돌게 된다. 문서(스펙·authoring)도
  // 이 결정에 맞춰 "비워 둔다"로 적혀 있고, scaffold.test.ts가 이 부재를 회귀로 못박는다.
  // `since` 메타가 들어오면 그때 여기서 계산해 채운다.
  const manifestObj: Record<string, unknown> = {
    $schema: "./plugin-manifest.schema.json",
    id,
    name,
    version: "1.0.0",
    entry: "main.js",
    kind: "action",
    ...manifestExtra,
  };

  // 디스크에 아무것도 쓰기 전에 실물 검증기로 먼저 확인한다(id 형식 오류 등) — 문제가
  // 있으면 흔적을 남기지 않고 여기서 끝낸다. host-bridge의 `parseManifest`를 그대로 쓰므로
  // id 정규식(`^[a-z0-9][a-z0-9._-]*$` 등)을 이 파일에 다시 옮겨 적지 않는다.
  const parsed = contract.parseManifest(manifestObj);
  if (!parsed.ok) {
    return {
      findings: [
        { severity: "error", code: "MANIFEST_INVALID", message: parsed.error },
      ],
      wrote: [],
      outDir: opts.outDir,
    };
  }

  if (existsSync(opts.outDir)) {
    if (readdirSync(opts.outDir).length > 0 && !opts.force) {
      return {
        findings: [
          {
            severity: "error",
            code: "OUTPUT_DIR_NOT_EMPTY",
            message: `${opts.outDir}가 이미 있고 비어 있지 않음 — 다른 경로를 쓰거나 --force로 덮어써라`,
          },
        ],
        wrote: [],
        outDir: opts.outDir,
      };
    }
  } else {
    mkdirSync(opts.outDir, { recursive: true });
  }

  const wrote: string[] = [];
  writeFileSync(
    path.join(opts.outDir, "manifest.json"),
    `${JSON.stringify(manifestObj, null, 2)}\n`,
    "utf8",
  );
  wrote.push("manifest.json");
  writeFileSync(path.join(opts.outDir, "main.js"), mainJs, "utf8");
  wrote.push("main.js");
  writeFileSync(
    path.join(opts.outDir, "README.md"),
    buildReadme(id, name, readmeBody),
    "utf8",
  );
  wrote.push("README.md");

  const findings: Finding[] = [];
  if (opts.withTypes !== false) {
    const typesResult = await runTypes(opts.outDir, contract);
    findings.push(...typesResult.findings);
    wrote.push(...typesResult.wrote);
  }

  // ★ 생성 직후 스스로 확인한다(지시) — `runLint`는 `runValidate`를 내부에서 다시 돌려
  // 매니페스트 구조부터 권한·인자·catch까지 전부 실물 규칙으로 검사한다. 여기서 오류가
  // 나오면 그건 이 파일의 템플릿 버그이지 저작자의 잘못이 아니다 — 조용히 삼키지 않는다.
  const lintFindings = await runLint(opts.outDir, contract);
  findings.push(...lintFindings);

  return { findings: dedupeFindings(findings), wrote, outDir: opts.outDir };
}

/** `runTypes`와 `runLint`가 **둘 다** 내부에서 `runValidate`를 다시 돌리므로(각자 독립
 * 호출로도 쓰이기 때문에 지울 수 없다), 같은 구조적 결함(예: ID_DIR_MISMATCH)이 findings에
 * 두 번 실릴 수 있다. 여기서만(다른 명령은 이 두 경로를 안 겹쳐 쓴다) 중복을 접는다. */
function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
