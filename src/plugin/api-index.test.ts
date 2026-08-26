/**
 * API 인덱스 드리프트 가드 **겸 생성기**.
 *
 * 역할: 두 가지를 한 파일에서 한다.
 * 1. `src/plugin/api-index.ts`의 설명이 **코드의 어휘**(host.ts의 `CALL_PERMISSIONS`·
 *    `RESERVED_CALLS`·`NO_PERMISSION_CALLS`·`MemoErrorCode`, permissions.ts의 권한 목록,
 *    central-host.ts의 창-스코프 집합, install-flow.ts의 권한 문구)와 정확히 일치하는지 검사한다.
 * 2. 그 인덱스에서 생성한 `docs/plugin/api-reference.json`·`docs/plugin/api-reference.d.ts`·
 *    `docs/plugin/authoring.md`의 표들이 커밋본과 같은지 검사한다.
 *
 * 생성물 갱신(이 파일이 그대로 생성기다):
 *   MEMO_GEN_PLUGIN_API=1 npx vitest run src/plugin/api-index.test.ts
 *
 * 왜 생성기를 테스트 파일에 두는가: 이 저장소는 TS 실행기(tsx·ts-node)를 의존성으로 갖지
 * 않고, src의 모듈들은 확장자 없는 import를 쓰므로 `node scripts/*.ts`로는 불러올 수 없다.
 * 러너를 새로 들이는 대신 이미 있는 vitest를 쓰면, **가드와 생성기가 물리적으로 같은 코드
 * 경로**를 타게 되어 "생성기는 A를 만드는데 가드는 B를 기대한다"는 어긋남 자체가 불가능해진다.
 * 왜 소스를 정규식으로 읽는가: `WINDOW_SCOPED_CALLS`처럼 export되지
 * 않은 값은 import할 수 없다(그 파일들은 이 담당의 소유가 아니라 export를 늘리지 않았다) —
 * `drift-guards.test.ts`·`csp-policy.test.ts`가 쓰는 것과 같은 기법이다.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { format, resolveConfig } from "prettier";
import {
  CALL_PERMISSIONS,
  CAPABILITY_CALLS,
  NO_PERMISSION_CALLS,
  PERMISSION_RESERVED,
  RESERVED_CALLS,
} from "./host";
import { CORE_CONTRIBUTION_PERMISSIONS } from "./manifest";
import { permissionInfo } from "../settings/install-flow";
import { SANDBOX_BOOTSTRAP } from "./sandbox-bootstrap";
import {
  generatePluginApiArtifacts,
  hostCallNames,
  indexedCallNames,
  readGeneratedBlock,
  replaceGeneratedBlock,
  PLUGIN_API_CALLS,
  type PluginApiArtifacts,
} from "./api-index";

const JSON_PATH = "docs/plugin/api-reference.json";
const SCHEMA_PATH = "docs/plugin/manifest.schema.json";
const DTS_PATH = "docs/plugin/api-reference.d.ts";
const DOC_PATH = "docs/plugin/authoring.md";

/**
 * conventions 문장에서 **원시값 축약형을 보증한 호출**을 뽑는 패턴.
 *
 * 백틱 안의 `ns.method("문자열")` 표기 하나가 곧 그 보증이다("이렇게 불러도 된다") — 목록을
 * 손으로 복제하지 않고 문장에서 뽑아, 축약형을 새로 문서화하면 가드가 따라오게 한다.
 */
const SHORTHAND_RE = /`([a-z]+\.[a-zA-Z]+)\("[^"]*"\)`/g;

const hostSrc = readFileSync("src/plugin/host.ts", "utf8");
const permissionsSrc = readFileSync("src/plugin/permissions.ts", "utf8");
const centralHostSrc = readFileSync("src/plugin/central-host.ts", "utf8");

/**
 * `//` 줄 주석을 제거한다 — 주석 안의 따옴표가 리터럴로 잡히면 어휘가 오염된다
 * (예: `permissions.ts`의 `// 창 컨트롤 "능력" 등록`).
 *
 * CRLF로 체크아웃된 소스(Windows의 `core.autocrlf=true`)도 다뤄야 한다 — 줄 끝에 `\r`가
 * 남으면 `.`가 그 문자를 건너뛰지 못해 `/\/\/.*$/`의 `$`가 절대 매칭되지 않고, 주석 제거가
 * 통째로 무동작이 된다(주석 속 따옴표 문자열이 그대로 리터럴로 새어 나간다).
 */
function stripLineComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** 소스의 `const NAME = [...]`/`new Set([...])`에서 문자열 리터럴만 뽑는다. */
function extractStringLiterals(raw: string, marker: string): string[] {
  const src = stripLineComments(raw);
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`선언을 찾을 수 없음: ${marker}`);
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  if (open === -1 || close === -1) {
    throw new Error(`배열 경계를 찾을 수 없음: ${marker}`);
  }
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `permissions.ts`가 소유하는 권한 어휘(저위험 → 민감 순 = 문서 표의 순서). */
const KNOWN_PERMISSIONS = [
  ...extractStringLiterals(permissionsSrc, "const LOW_RISK_PERMISSIONS"),
  ...extractStringLiterals(permissionsSrc, "const SENSITIVE_EXACT"),
];

/** `host.ts`의 `MemoErrorCode` 유니온에 실린 코드 상수 전수. */
function extractErrorCodes(): string[] {
  const start = hostSrc.indexOf("export type MemoErrorCode =");
  if (start === -1) throw new Error("MemoErrorCode 선언을 찾을 수 없음");
  const end = hostSrc.indexOf("(string & {});", start);
  if (end === -1) throw new Error("MemoErrorCode 유니온의 끝을 찾을 수 없음");
  return [...hostSrc.slice(start, end).matchAll(/\|\s*"([A-Z_]+)"/g)].map(
    (m) => m[1],
  );
}

/** `central-host.ts`의 창-스코프 호출 집합. */
const WINDOW_SCOPED = extractStringLiterals(
  centralHostSrc,
  "const WINDOW_SCOPED_CALLS",
);

let artifacts: PluginApiArtifacts;
let expected: { json: string; dts: string; doc: string };

/** 프리티어 설정을 그대로 적용한다 — `npm run format:check`가 생성물에서 실패하지 않게. */
async function pretty(source: string, filepath: string): Promise<string> {
  const config = await resolveConfig(filepath);
  return format(source, { ...config, filepath });
}

beforeAll(async () => {
  artifacts = generatePluginApiArtifacts({
    describePermission: permissionInfo,
    knownPermissions: KNOWN_PERMISSIONS,
    // 매니페스트 계약(의 정본)을 인덱스에 통째로 싣는다 — 파일 읽기는 생성기를 돌리는
    // 이쪽의 일이다(api-index.ts는 순수하게 유지한다).
    manifestSchema: JSON.parse(readFileSync(SCHEMA_PATH, "utf8")),
  });
  let doc = readFileSync(DOC_PATH, "utf8");
  for (const [name, body] of Object.entries(artifacts.blocks)) {
    doc = replaceGeneratedBlock(doc, name, body);
  }
  expected = {
    json: await pretty(artifacts.json, JSON_PATH),
    dts: await pretty(artifacts.dts, DTS_PATH),
    doc: await pretty(doc, DOC_PATH),
  };
  if (process.env.MEMO_GEN_PLUGIN_API === "1") {
    writeFileSync(JSON_PATH, expected.json);
    writeFileSync(DTS_PATH, expected.dts);
    writeFileSync(DOC_PATH, expected.doc);
  }
});

describe("API 인덱스 ↔ 코드 어휘", () => {
  /** 가드(핵심): 호출을 추가하고 인덱스에 안 적으면(혹은 그 반대면) 여기서 잡힌다. */
  it("인덱스가 호스트가 아는 모든 호출을 정확히 덮는다", () => {
    expect([...indexedCallNames()].sort()).toEqual([...hostCallNames()].sort());
  });

  it("호출별 권한이 CALL_PERMISSIONS와 같다", () => {
    const index = artifacts.index;
    for (const call of index.calls) {
      expect(call.permission, `권한 불일치: ${call.call}`).toBe(
        CALL_PERMISSIONS[call.call] ?? null,
      );
    }
    // 무권한 어휘가 통째로 빠지는 회귀 방지.
    const noPerm = index.calls
      .filter((c) => c.permission === null)
      .map((c) => c.call);
    expect(noPerm.sort()).toEqual([...NO_PERMISSION_CALLS].sort());
  });

  it("예약 표시가 RESERVED_CALLS와 같다", () => {
    const reserved = artifacts.index.calls
      .filter((c) => c.reserved)
      .map((c) => c.call);
    expect(reserved.sort()).toEqual([...RESERVED_CALLS].sort());
  });

  /** 가드: 창-스코프 여부는 저작자가 "바인딩된 memo가 필요한가"를 판단하는 축이다. */
  it("창-스코프 표시가 central-host의 WINDOW_SCOPED_CALLS와 같다", () => {
    const scoped = artifacts.index.calls
      .filter((c) => c.windowScoped)
      .map((c) => c.call);
    expect(WINDOW_SCOPED.length).toBeGreaterThan(0);
    expect(scoped.sort()).toEqual([...WINDOW_SCOPED].sort());
  });

  /**
   * 가드: `CONTEXT_UNAVAILABLE`로 실패할 수 있는 호출은 전부 `requireWindow`를
   * **인자로 선언**한다.
   *
   * 왜 오류 목록에서 유도하나: 창 의존은 `site: "window"`와 같은 뜻이 아니다 —
   * `storage.*`는 site가 `host`이면서 `scope: "window"`일 때만 창에 의존하는데, 런타임은
   * 이미 `args.requireWindow`를 읽는다. 계약에만 빠지면 `.d.ts`가 그 인자를 타입 오류로
   * 막아 "구현은 됐는데 아무도 못 쓰는 인자"가 된다(실제로 그 상태였다). 오류 목록은
   * 그 의존을 이미 정확히 말하고 있으므로 그것을 정본으로 삼는다.
   */
  it("CONTEXT_UNAVAILABLE로 실패할 수 있는 호출은 requireWindow를 선언한다", () => {
    const missing = artifacts.index.calls
      .filter(
        (c) =>
          !c.reserved &&
          c.errors.includes("CONTEXT_UNAVAILABLE") &&
          !c.args.some((a) => a.name === "requireWindow"),
      )
      .map((c) => c.call);
    expect(missing).toEqual([]);
  });

  /** 가드: 창-스코프 호출은 컨텍스트가 없으면 조용한 null이다 — 타입이 그걸 말해야 한다. */
  it("창-스코프 호출의 반환은 전부 nullable로 선언돼 있다", () => {
    const lying = artifacts.index.calls.filter(
      (c) => c.windowScoped && !c.returns.nullable,
    );
    expect(lying.map((c) => c.call)).toEqual([]);
  });

  /**
   * 가드: 능력 등록 표시가 게이트의 어휘와 같다.
   *
   * 왜: 이 표시가 틀리면 문서·`.d.ts`는 "그냥 부르면 된다"고 하는데 게이트는
   * `WRONG_PLUGIN_KIND`로 막는다 — 저작자가 원인을 찾을 방법이 없는 종류의 어긋남이다.
   */
  it("능력 등록 표시가 host.ts의 CAPABILITY_CALLS와 같다", () => {
    const marked = artifacts.index.calls
      .filter((c) => c.requiresKind === "capability")
      .map((c) => c.call);
    expect(CAPABILITY_CALLS.size).toBeGreaterThan(0);
    expect(marked.sort()).toEqual([...CAPABILITY_CALLS].sort());
  });

  /** 가드: 능력 호출에는 병합 규칙 이름이 반드시 있고, 능력이 아닌 호출에는 없다. */
  it("병합 규칙은 능력 등록 호출에만, 그리고 전부에 붙어 있다", () => {
    for (const call of artifacts.index.calls) {
      expect(
        call.merge === undefined,
        `병합 규칙 표시 오류: ${call.call}`,
      ).toBe(call.requiresKind === undefined);
    }
  });

  it("오류 코드 목록이 host.ts의 MemoErrorCode와 같다", () => {
    const codes = artifacts.index.errorCodes.map((e) => e.code);
    expect(codes.sort()).toEqual([...extractErrorCodes()].sort());
  });

  /**
   * 가드: 호출이 약속한 오류 코드는 전부 코드 목록(=`MemoErrorCode` + 설명)에 있다.
   *
   * 왜: `QUOTA_EXCEEDED`가 정확히 이 구멍으로 샜다 — 호출의 `errors`에는 실려 나가는데
   * 유니온에도 설명에도 없어서, 저작자는 문서를 믿고 그 코드로 분기하지만 실제로는
   * `UNKNOWN`이 도착하고 뜻을 찾아볼 자리조차 없었다. 여기서 막으면 "계약에만 있는 코드"가
   * 다시 생기지 않는다.
   */
  it("호출이 약속한 오류 코드가 전부 코드 목록에 있다", () => {
    const known = new Set(artifacts.index.errorCodes.map((e) => e.code));
    const dangling = artifacts.index.calls.flatMap((c) =>
      c.errors.filter((e) => !known.has(e)).map((e) => `${c.call}: ${e}`),
    );
    expect(dangling).toEqual([]);
  });

  it("권한 목록·문구·예약 표시가 코드와 같다", () => {
    const perms = artifacts.index.permissions;
    expect(perms.map((p) => p.id)).toEqual(KNOWN_PERMISSIONS);
    for (const p of perms) {
      const info = permissionInfo(p.id);
      expect(p.label, `라벨 불일치: ${p.id}`).toBe(info.label);
      expect(p.desc, `설명 불일치: ${p.id}`).toBe(info.desc);
      expect(p.reserved, `예약 표시 불일치: ${p.id}`).toBe(
        PERMISSION_RESERVED.has(p.id),
      );
    }
  });

  /**
   * 가드: 권한→호출 역인덱스가 비면 승인 화면이 "무엇을 할 수 있는지"를 못 보여준다.
   *
   * 예외는 **선언형 전용 기여를 게이트하는 권한**뿐이다(지금은 `i18n` 하나 — 언어팩은
   * 런타임 호출이 아니라 `contributes.translations` 선언이라 대응하는 호출이 애초에 없다).
   * 어휘를 여기 손으로 적지 않고 `manifest.ts`의 표에서 끌어오는 이유: 그런 기여가 하나 더
   * 생기면 이 가드가 저절로 따라오고, 반대로 표에 없는 권한이 호출을 잃으면 그건 진짜
   * 드리프트라 여전히 실패한다.
   */
  it("예약이 아닌 권한에는 그 권한이 게이트하는 호출이 하나 이상 있다", () => {
    const declarativeOnly = new Set(
      Object.values(CORE_CONTRIBUTION_PERMISSIONS),
    );
    const empty = artifacts.index.permissions
      .filter(
        (p) =>
          !p.reserved && p.calls.length === 0 && !declarativeOnly.has(p.id),
      )
      .map((p) => p.id);
    expect(empty).toEqual([]);
  });

  /** 가드: 예시가 없으면 AI가 형태를 지어낸다 — 전 호출에 한 줄 예시를 강제한다. */
  it("모든 호출에 요약과 예시가 있다", () => {
    for (const spec of PLUGIN_API_CALLS) {
      expect(spec.summary.length, `요약 누락: ${spec.call}`).toBeGreaterThan(0);
      expect(spec.example.length, `예시 누락: ${spec.call}`).toBeGreaterThan(0);
    }
  });
});

describe("인덱스 하나로 플러그인을 만들 수 있는가(자족성)", () => {
  /**
   * 가드: 인자·반환이 참조하는 `Memo*` 타입이 전부 `types`에 **정의**돼 있다.
   *
   * 왜: 문서는 이 JSON 하나를 "계약 전체"라고 안내한다. 그런데 예전 인덱스에는 타입 **이름만**
   * 등장하고 정의가 없어서(정의는 `.d.ts`에만 있었다), 그 이름의 값 어휘를 모르는 AI가
   * `{ controls: ["pin"] }` 같은 값을 지어냈다 — 미지 값은 오류가 아니라 정규화기에서 조용히
   * 버려지므로(창 컨트롤 폐기·툴바 존 `top-left` 폴백·스타일 속성 폐기) 그대로 무음 실패다.
   */
  it("참조된 Memo* 타입이 전부 types에 정의돼 있다", () => {
    const defined = new Set(artifacts.index.types.map((t) => t.name));
    const referenced = new Set<string>();
    for (const call of artifacts.index.calls) {
      for (const source of [
        ...call.args.map((a) => a.type),
        call.returns.type,
      ]) {
        for (const m of source.matchAll(/\bMemo\w+/g)) referenced.add(m[0]);
      }
    }
    // `MemoApi`는 인터페이스 전체(호출 목록 그 자체)라 types의 대상이 아니다.
    referenced.delete("MemoApi");
    expect(referenced.size, "타입 참조 추출 실패 의심").toBeGreaterThan(3);
    expect([...referenced].filter((n) => !defined.has(n))).toEqual([]);
  });

  /**
   * 가드(구멍 막기): 인자 타입에 **열린 `Record<string, …>`**를 쓰지 않는다.
   *
   * 왜: 위의 「참조된 Memo* 타입이 전부 types에 정의돼 있다」는 이름이 `Memo*`인 것만 본다.
   * 그래서 값 어휘가 코드 화이트리스트인 인자를 `Record<string, string>` 같은 **인라인 타입**으로
   * 적으면 그 가드를 통째로 피해 간다 — 실제로 `theme.register`의 `tokens`가 그 상태였고,
   * `api-reference.json` 전문에 `surface-dark`라는 문자열이 **한 번도 등장하지 않았다**.
   * 모르는 토큰 키는 오류가 아니라 정규화기에서 조용히 폐기되므로, 그대로 무음 실패다.
   * 키 어휘를 `Memo*` 유니온으로 표현하면 산출물이 그 어휘를 저절로 싣는다.
   */
  it("인자 타입은 열린 Record<string, …>를 쓰지 않는다", () => {
    const open: string[] = [];
    for (const call of artifacts.index.calls) {
      for (const arg of call.args) {
        if (/Record<\s*string\s*,/.test(arg.type)) {
          open.push(`${call.call}.${arg.name}: ${arg.type}`);
        }
      }
    }
    expect(
      open,
      "값 어휘가 코드 화이트리스트인 인자는 Memo* 유니온을 키로 쓴 Record로 표현하라",
    ).toEqual([]);
  });

  /** 가드: 값 어휘가 있는 타입은 그 정본(코드 위치)을 함께 밝힌다 — 추적 가능해야 한다. */
  it("값 어휘를 가진 타입은 정본 출처를 밝힌다", () => {
    const orphans = artifacts.index.types
      .filter((t) => t.values && !t.source)
      .map((t) => t.name);
    expect(orphans).toEqual([]);
  });

  /**
   * 가드: 매니페스트 계약(JSON Schema 정본)이 인덱스에 통째로 실린다.
   *
   * 왜: 호출 계약만 주면 AI는 매니페스트 필수 필드·설정 스키마 형태를 지어내고, 그 플러그인은
   * **설치 자체가 되지 않는다**(검증 거부). 경로만 가리키는 것으로는 그 파일이 컨텍스트에
   * 없는 상황에서 아무 도움이 안 된다.
   */
  it("manifest.json의 JSON Schema가 인덱스에 그대로 실린다", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      required: string[];
    };
    expect(artifacts.index.manifest).toEqual(schema);
    expect(schema.required).toEqual(["id", "name", "version", "entry"]);
    expect(artifacts.index.sources).toContain(SCHEMA_PATH);
  });
});

// ── 인덱스의 **인자 어휘** ↔ 실행부 ────────────────────────────────────────
//
// 위의 가드들은 호출 **이름**·권한·예약·창스코프·kind·병합·오류코드만 대조한다. 정작
// 계약의 전부로 만든 **인자 이름**은 인덱스의 순수 산문이라, 한 단어만 바꿔도 세 산출물
// (json·d.ts·문서 표)이 **일제히 같은 거짓말**을 하고 전부 green이 된다("생성물 ↔ 커밋본"
// 가드는 생성기 자신의 출력과만 비교하므로 이 드리프트를 원리적으로 못 본다).
//
// 실증된 시나리오: 인덱스의 `ui.prompt` 인자 `default`를 다른 이름으로 바꾸고 생성기를 돌리면
// `.d.ts`·`api-reference.json`·문서 표가 전부 새 이름을 권하는데, 런타임은 여전히
// `host-client.ts`의 `args.default`만 읽는다 — 그 이름으로 부른 플러그인은 오류 없이 빈
// 문자열을 받는다(무음 실패). 아래 두 가드가 인자 축의 그 구멍을 막는다.

/** 실행부에서 `if (call === "x") { ... }` 분기의 본문(중괄호 대응)을 잘라 낸다. */
function branchBody(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i);
    }
  }
  return src.slice(open);
}

/**
 * 소스 조각에서 `<루트>.<키>` 형태의 **속성 읽기**를 뽑는다(타입 단언을 거친 읽기 포함).
 *
 * 왜 단언 형태까지 보나: 실행부는 `(raw as { key?: unknown }).key`처럼 단언을 끼워 읽는다 —
 * 이 모양을 놓치면 `settings.get`처럼 별칭으로 받는 분기가 통째로 무검증이 된다.
 */
function propReads(body: string, roots: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const root of roots) {
    for (const m of body.matchAll(new RegExp(`\\b${root}\\.(\\w+)`, "g"))) {
      keys.add(m[1]);
    }
    for (const m of body.matchAll(
      new RegExp(`\\b${root}\\s+as\\s*\\{\\s*(\\w+)\\??\\s*:`, "g"),
    )) {
      keys.add(m[1]);
    }
  }
  return keys;
}

/** `export function <이름>(...)`의 본문을 통째로 잘라낸다(정규화기 스캔용). */
function functionBody(src: string, fn: string): string {
  const at = src.indexOf(`function ${fn}(`);
  if (at === -1) return "";
  return branchBody(src, at + fn.length);
}

/**
 * 인자를 통째로 넘겨받는 **정규화·파서 함수**의 위치표(호출 → 그 인자를 읽는 함수와 루트 이름).
 *
 * 왜 표가 필요한가: 실행부의 분기 본문이 `normalizeThemeArgs(args)` 한 줄이면 `args.<키>`가
 * 하나도 없어 그 호출의 인자 어휘가 **통째로 무검증**이 된다. 실제로 능력 등록 4종과
 * 블록 임베드가 그 상태였고, 인덱스에서 `swatches`를 `palette`로 바꿔도 아무 가드도 울지
 * 않았다(문서·`.d.ts`·타입 검사는 전부 새 이름을 권하는데 정규화기는 옛 이름만 읽어
 * 배경 피커가 소리 없이 사라진다).
 *
 * 표를 손으로 유지하는 대신 아래 「인자 어휘가 대조되지 않는 호출」 가드가 구멍이 늘어나는
 * 것을 막는다 — 새 호출을 정규화기 뒤에 숨기면 그 가드가 실패한다.
 */
/**
 * 저장소 호출의 인자별 읽기 함수 — 호출마다 **실제로 읽는 것만** 조합한다.
 *
 * `getAll`은 key도 value도 읽지 않으므로 여기서 빠진다. 하나의 큰 파서로 묶었다면 이 가드가
 * "getAll이 value를 읽는다"고 판정해, 계약에 없는 인자를 인덱스에 억지로 넣어야 했다.
 */
const STORAGE_SCOPE_READER = {
  file: "src/plugin/central-host.ts",
  fn: "readStorageScope",
  root: "args",
};
const STORAGE_KEY_READER = {
  file: "src/plugin/central-host.ts",
  fn: "readStorageKey",
  root: "args",
};
const STORAGE_VALUE_READER = {
  file: "src/plugin/central-host.ts",
  fn: "readStorageValue",
  root: "args",
};

const CALL_ARG_READERS: Record<
  string,
  { file: string; fn: string; root: string }[]
> = {
  "editor.registerBlockEmbed": [
    {
      file: "src/plugin/embed.ts",
      fn: "parseBlockEmbedDescriptor",
      root: "args",
    },
  ],
  "theme.register": [
    { file: "src/theme/theme.ts", fn: "normalizeThemeArgs", root: "o" },
  ],
  "background.register": [
    {
      file: "src/theme/background.ts",
      fn: "normalizeBackgroundArgs",
      root: "o",
    },
  ],
  "font.register": [
    { file: "src/theme/font.ts", fn: "normalizeFontArgs", root: "o" },
  ],
  "window.register": [
    {
      file: "src/plugin/window-control.ts",
      fn: "normalizeWindowControlArgs",
      root: "o",
    },
  ],
  // settings.get의 key·raw 판정은 중앙 호스트·하니스가 공유하는 순수 함수로 빠졌다 —
  // 분기 본문에는 `args.<키>`가 없으므로 그 함수를 가리켜야 인자 어휘가 검증된다.
  "settings.get": [
    {
      file: "src/plugin/host-executor-validators.ts",
      fn: "resolveSettingsGetArg",
      root: "rawArg",
    },
  ],
  // 저장소 넷은 같은 인자 어휘(scope·key·value)를 공유해 한 함수가 읽는다 — 분기
  // 본문에는 `args.<키>`가 없으므로 그 함수를 가리키지 않으면 인자 어휘가 통째로 무검증이 된다.
  "storage.get": [STORAGE_SCOPE_READER, STORAGE_KEY_READER],
  "storage.set": [
    STORAGE_SCOPE_READER,
    STORAGE_KEY_READER,
    STORAGE_VALUE_READER,
  ],
  "storage.remove": [STORAGE_SCOPE_READER, STORAGE_KEY_READER],
  "storage.getAll": [STORAGE_SCOPE_READER],
};

/**
 * 실행부 소스에서 **호출별로 실제 읽는 인자 키**를 뽑는다.
 *
 * 세 경로를 본다: (1) 분기 본문의 `args.<키>`, (2) 분기가 `const raw = args`처럼 별칭으로
 * 받은 뒤 읽는 키(단언 형태 포함), (3) [`CALL_ARG_READERS`]가 가리키는 정규화·파서 함수 본문.
 * 부분집합 검사라 못 잡는 키가 있어도 거짓 실패는 없다 — 잡히는 키가 인덱스에 없으면
 * 그것만으로 드리프트가 확정된다.
 */
function executorArgReads(src: string): Map<string, Set<string>> {
  const cleaned = stripLineComments(src);
  const out = new Map<string, Set<string>>();
  for (const m of cleaned.matchAll(/call === "([\w.]+)"/g)) {
    const call = m[1];
    const body = branchBody(cleaned, m.index + m[0].length);
    // 별칭으로 받은 뒤 읽는 분기(`const raw = args as unknown`)까지 같은 어휘로 본다.
    const roots = [
      "args",
      ...[...body.matchAll(/const (\w+) = args\b/g)].map((a) => a[1]),
    ];
    const keys = propReads(body, roots);
    for (const reader of CALL_ARG_READERS[call] ?? []) {
      const readerSrc = stripLineComments(readFileSync(reader.file, "utf8"));
      for (const k of propReads(functionBody(readerSrc, reader.fn), [
        reader.root,
      ])) {
        keys.add(k);
      }
    }
    const prev = out.get(call);
    if (prev) for (const k of keys) prev.add(k);
    else out.set(call, keys);
  }
  return out;
}

/**
 * 부트스트랩이 **핸들러 인자 이름을 그대로 박아 둔** 자리(`out["onClick$id"]`)에서 그 이름을 뽑는다.
 *
 * 왜: 함수 인자는 `<키>$id`로 치환돼 호스트에 도착하고, 툴바 버튼은 그 값을 `buttonId`
 * 별칭으로 읽는다 — 그래서 실행부 어디에도 `onClick`이라는 이름이 없다. 인덱스에서 그 이름을
 * 바꿔도 아무 가드가 울지 않던 구멍이라, 이름을 아는 유일한 곳(부트스트랩)과 대조한다.
 */
function bootstrapHandlerArgs(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/call === "([\w.]+)" && out\["(\w+)\$id"\]/g)) {
    const prev = out.get(m[1]) ?? new Set<string>();
    prev.add(m[2]);
    out.set(m[1], prev);
  }
  return out;
}

/**
 * 실행부는 읽지만 인덱스가 **일부러** 싣지 않는 키(호스트 내부 값 — 저작자가 주는 인자가
 * 아니다). 늘리려면 그게 정말 저작자에게 감출 값인지 먼저 따져라.
 */
const HOST_INTERNAL_ARGS: Record<string, string[]> = {
  // 부트스트랩이 onClick 함수를 핸들러 id로 바꿔 실어 보내는 내부 필드(저작자는 onClick을 준다).
  "ui.addToolbarButton": ["buttonId"],
  // 상태 아이템의 onClick도 같은 규칙이지만 별칭 한 줄(`buttonId`처럼)을 더 두지 않았다 —
  // `commands.register`/`ui.addMenuItem`의 `run$id`와 같은 이유(SANDBOX_BOOTSTRAP을 건드리면
  // CSP 해시 세 곳이 함께 움직인다). 수행부(central-host)가 범용 치환 결과 `onClick$id`를
  // 그대로 읽는다.
  "ui.addStatusItem": ["onClick$id"],
  // 같은 규칙 — 저작자는 handler 함수를 주고, 부트스트랩이 handlerId로 바꿔 보낸다.
  "events.on": ["handlerId"],
  // 명령의 `run` 함수는 부트스트랩의 **범용** 치환(`<키>$id`)만 거친다 — 버튼·이벤트처럼
  // 별칭 한 줄을 더 두지 않은 이유는 `SANDBOX_BOOTSTRAP`을 건드리면 CSP 해시 세 곳이 함께
  // 움직이기 때문이다(수행부가 `run$id`를 그대로 읽는 것으로 충분하다).
  "commands.register": ["run$id"],
  // 메뉴 항목의 `run`도 명령과 똑같이 범용 치환만 거친다 — 수행부(central-host)가
  // `args["run$id"]`를 그대로 읽는다. 저작자는 `run` 함수를 준다.
  "ui.addMenuItem": ["run$id"],
  // 선택 액션의 `run`도 같은 범용 치환만 거친다(메뉴 항목과 같은 이유).
  "ui.addSelectionAction": ["run$id"],
};

/**
 * 부트스트랩이 **로컬에서 가로채는** `runtime.*` 분기(`method === "x"`)가 읽는 인자 이름을 뽑는다.
 *
 * 왜 따로 필요한가: `runtime.ready`·`runtime.onDispose`는 브리지로 나가지 않으므로 실행부
 * (loader·host-client·central-host) 어디에도 `call === "runtime.onDispose"` 분기가 없다.
 * 그러면 「인자를 선언한 호출은 전부 어떤 실행부와 대조된다」 가드가 이 호출을 통째로 놓쳐,
 * 인덱스에서 `handler`를 다른 이름으로 바꿔도 아무도 울지 않는다(그 이름으로 부른 저작자의
 * 정리 콜백은 조용히 등록되지 않는다 — 정확히 이 가드가 막으려는 무음 실패다).
 */
function bootstrapRuntimeArgs(src: string): Map<string, Set<string>> {
  const cleaned = stripLineComments(src);
  const out = new Map<string, Set<string>>();
  for (const m of cleaned.matchAll(/method === "(\w+)"/g)) {
    const body = branchBody(cleaned, m.index + m[0].length);
    out.set(`runtime.${m[1]}`, propReads(body, ["args"]));
  }
  return out;
}

describe("API 인덱스 ↔ 실행부(인자 어휘)", () => {
  const executorSources = [
    "src/plugin/loader.ts",
    "src/plugin/host-client.ts",
    "src/plugin/central-host.ts",
  ];

  /**
   * 모든 **창-스코프 호출**이 공유하는 인자(`requireWindow`)를 읽는 곳 — 호출마다 분기가
   * 따로 없고 공통 헬퍼 하나가 읽으므로, 호출별 분기 스캔으로는 잡히지 않는다.
   */
  const SHARED_WINDOW_READER = {
    file: "src/plugin/host.ts",
    fn: "requiresWindowContext",
    root: "args",
  };

  /** 출처(파일·부트스트랩) → 호출별 인자 읽기. 두 가드가 같은 추출을 쓴다. */
  function readsBySource(): {
    source: string;
    reads: Map<string, Set<string>>;
  }[] {
    const sharedWindowKeys = propReads(
      functionBody(
        readFileSync(SHARED_WINDOW_READER.file, "utf8"),
        SHARED_WINDOW_READER.fn,
      ),
      [SHARED_WINDOW_READER.root],
    );
    const windowReads = new Map<string, Set<string>>();
    for (const call of artifacts.index.calls) {
      if (call.site === "window") windowReads.set(call.call, sharedWindowKeys);
    }
    return [
      {
        source: "sandbox-bootstrap",
        reads: bootstrapHandlerArgs(SANDBOX_BOOTSTRAP),
      },
      {
        source: "sandbox-bootstrap:runtimeCall",
        reads: bootstrapRuntimeArgs(SANDBOX_BOOTSTRAP),
      },
      {
        source: `${SHARED_WINDOW_READER.file}:${SHARED_WINDOW_READER.fn}`,
        reads: windowReads,
      },
      ...executorSources.map((path) => ({
        source: path,
        reads: executorArgReads(readFileSync(path, "utf8")),
      })),
    ];
  }

  /**
   * 가드(핵심): 실행부가 읽는 인자 이름이 전부 인덱스에 선언돼 있다.
   *
   * 위반이면 둘 중 하나다 — 인덱스가 인자 이름을 틀리게 적었거나(저작자가 그 이름으로 부르면
   * 값이 조용히 사라진다), 실행부가 계약에 없는 인자를 몰래 읽는다.
   */
  it("실행부가 읽는 args 키가 전부 인덱스에 선언돼 있다", () => {
    const declared = new Map(
      artifacts.index.calls.map((c) => [
        c.call,
        new Set(c.args.map((a) => a.name)),
      ]),
    );
    const missing: string[] = [];
    let scanned = 0;
    for (const { source, reads } of readsBySource()) {
      for (const [call, keys] of reads) {
        const known = declared.get(call);
        if (!known) continue; // 호출 이름 자체의 대조는 위의 가드가 한다.
        scanned += 1;
        const allowed = new Set([
          ...known,
          ...(HOST_INTERNAL_ARGS[call] ?? []),
        ]);
        for (const key of keys) {
          if (!allowed.has(key)) missing.push(`${source}: ${call}.${key}`);
        }
      }
    }
    // 추출이 통째로 실패하면(소스 구조가 바뀌면) 이 가드가 조용히 무의미해진다.
    expect(scanned, "실행부 분기 추출 실패 의심(빈 결과)").toBeGreaterThan(15);
    expect(
      missing,
      "실행부가 읽는 인자가 인덱스에 없다 — 인덱스(단일 출처)를 고치고 생성물을 갱신하라",
    ).toEqual([]);
  });

  /**
   * 가드(구멍이 늘지 않게): 인자를 선언한 호출은 **하나도 빠짐없이** 어떤 실행부와 대조된다.
   *
   * 왜: 위 가드는 부분집합 검사라, 어떤 호출의 인자 읽기를 한 건도 못 뽑으면 그 호출은
   * 이름을 마음대로 바꿔도 통과한다(그러면 문서·`.d.ts`는 새 이름을, 실행부는 옛 이름을
   * 읽어 인자가 조용히 사라진다). 실제로 능력 등록 4종·블록 임베드·툴바 버튼의 `onClick`이
   * 그 상태였다. 새 호출을 정규화기 뒤에 숨기면 여기서 실패하게 해, 구멍이 조용히 늘어나는
   * 것을 막는다 — [`CALL_ARG_READERS`]에 읽는 함수를 등록하는 것이 해결책이다.
   */
  it("인자를 선언한 호출은 전부 어떤 실행부와 대조된다", () => {
    const covered = new Set<string>();
    for (const { reads } of readsBySource()) {
      for (const [call, keys] of reads) if (keys.size > 0) covered.add(call);
    }
    const uncovered = artifacts.index.calls
      .filter((c) => c.args.length > 0 && !c.reserved && !covered.has(c.call))
      .map((c) => c.call);
    expect(
      uncovered,
      "이 호출의 인자 이름은 어떤 실행부와도 대조되지 않는다 — CALL_ARG_READERS에 읽는 함수를 등록하라",
    ).toEqual([]);
  });

  /**
   * 가드: 각 호출의 `example`을 **실제로 실행**해, 부르는 호출명과 인자 키가 계약과 맞는지
   * 본다(AI는 이 한 줄을 그대로 베낀다 — 여기가 틀리면 그 오류가 그대로 복제된다).
   */
  it("모든 예시가 실행되고 선언된 인자만 준다", async () => {
    const seen: { call: string; args: Record<string, unknown> }[] = [];
    // 부트스트랩과 같은 이중 Proxy — 무엇을 불러도 프라미스를 돌려준다(체인 예시가 이어지게).
    const memo = new Proxy({} as Record<string, Record<string, unknown>>, {
      get: (_t, ns: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) => (args?: unknown) => {
              seen.push({
                call: `${ns}.${method}`,
                args: (args ?? {}) as Record<string, unknown>,
              });
              return Promise.resolve({});
            },
          },
        ),
    });
    const problems: string[] = [];
    for (const spec of PLUGIN_API_CALLS) {
      if (RESERVED_CALLS.has(spec.call)) continue; // 예약 예시는 주석 한 줄이다.
      seen.length = 0;
      new Function("memo", spec.example)(memo);
      await new Promise((r) => setTimeout(r, 0)); // `.then` 체인 예시까지 정착시킨다.
      const hit = seen.find((s) => s.call === spec.call);
      if (!hit) {
        problems.push(`${spec.call}: 예시가 그 호출을 부르지 않는다`);
        continue;
      }
      const declared = new Map(
        artifacts.index.calls
          .find((c) => c.call === spec.call)!
          .args.map((a) => [a.name, a]),
      );
      for (const key of Object.keys(hit.args)) {
        if (!declared.has(key)) {
          problems.push(`${spec.call}: 예시가 모르는 인자 '${key}'를 준다`);
        }
      }
      for (const [name, arg] of declared) {
        if (!arg.optional && !(name in hit.args)) {
          problems.push(`${spec.call}: 예시에 필수 인자 '${name}'가 없다`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

/**
 * 저작자가 쓸 코드 한 조각을 **커밋본 `.d.ts`와 함께** 컴파일해 오류 문구를 돌려준다.
 *
 * 왜 임시 파일인가: `.d.ts`는 `declare const memo`를 전역에 놓으므로, 같은 프로그램에 든
 * 평범한 `.ts` 파일 하나면 저작자의 편집기와 같은 조건이 된다(저장소 안에는 만들지 않는다).
 */
function compileAgainstDts(source: string): string[] {
  const ts = createRequire(import.meta.url)(
    "typescript",
  ) as typeof import("typescript");
  const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-dts-"));
  const usagePath = path.join(dir, "usage.ts");
  try {
    writeFileSync(usagePath, source);
    const program = ts.createProgram([DTS_PATH, usagePath], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) =>
        [
          path.basename(d.file?.fileName ?? ""),
          ts.flattenDiagnosticMessageText(d.messageText, " "),
        ].join(": "),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("생성된 .d.ts가 유효한 TypeScript다", () => {
  /**
   * 가드: `docs/plugin/api-reference.d.ts`를 실제로 컴파일한다.
   *
   * 왜: 이 파일은 앱 빌드에 편입되지 않는다(tsconfig는 `src`만 include, knip 글롭도 src/e2e만
   * 본다) — 인덱스의 `type` 문자열에 오타가 나면 저작자 편집기의 타입 검사가 통째로 죽어도
   * 커밋본 대조 가드는 그대로 통과한다(생성물과 커밋본은 여전히 같으니까).
   */
  it("tsc가 오류 없이 읽는다", () => {
    // vite의 변환·소스맵 로딩을 타지 않게 node의 require로 직접 가져온다(경고 소음 방지).
    const ts = createRequire(import.meta.url)(
      "typescript",
    ) as typeof import("typescript");
    const program = ts.createProgram([DTS_PATH], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map((d) =>
        [
          d.file?.fileName,
          ts.flattenDiagnosticMessageText(d.messageText, " "),
        ].join(": "),
      );
    expect(messages).toEqual([]);
  });

  /**
   * 가드: **conventions가 원시값 축약형을 보증한 호출**은 커밋본 `.d.ts`에서도 그 축약형이
   * 컴파일된다.
   *
   * 왜: 축약형은 인자 모델(`args`)로 표현할 수 없어 `signatureOverride` 없이는 객체형
   * 시그니처 하나만 생성된다 — 그러면 같은 파일의 JSDoc이 "문자열로도 부를 수 있다"고
   * 보증하는데 바로 그 줄이 타입 오류를 내는 자기모순이 된다(실제로 `runtime.log`가 그
   * 상태였다). 대조 목록을 손으로 적지 않고 conventions 문장에서 뽑아, 축약형을 새로
   * 문서화하면 override 없이는 여기서 반드시 걸리게 한다.
   */
  it("conventions가 약속한 문자열 축약형이 실제로 컴파일된다", () => {
    // conventions의 `ns.method("...")` 표기 = "이 호출은 원시값 축약형을 받는다"는 보증.
    const shorthandCalls = [
      ...new Set(
        [...artifacts.index.conventions.join("\n").matchAll(SHORTHAND_RE)].map(
          (m) => m[1],
        ),
      ),
    ];
    // 추출이 통째로 실패하면(문구가 바뀌면) 이 가드가 조용히 무의미해진다.
    expect(
      shorthandCalls,
      "conventions에서 축약형 호출을 못 뽑았다",
    ).not.toEqual([]);
    const usage = shorthandCalls
      .map((call) => `memo.${call}("축약형");`)
      .join("\n");
    expect(compileAgainstDts(usage)).toEqual([]);
  });

  /**
   * 가드(회귀): **런타임이 받아 주는 `when` 값은 `.d.ts`도 받아 준다.**
   *
   * 왜: `WHEN_KEYS`의 `plugin.<id>.enabled`·`settings.<key>`는 사람이 읽는 **형식**이고,
   * 실제 파서(`parseWhenClause`)는 정규식으로 임의의 id·키를 받는다. 자리표시자를 그대로
   * 리터럴로 내면 `.d.ts`가 저 두 문자열만 허용해, 문서의 예시(`settings.advanced`)와 부정형
   * (`!note.isEmpty`)이 저작자의 `tsc --strict`에서 전부 오류가 난다 — 생성물이 계약보다
   * 엄격하면 저작자는 캐스트로 타입을 끄는 수밖에 없다(타입 선언을 두는 이유가 사라진다).
   */
  it("문서가 예시로 드는 when 값이 실제로 컴파일된다", () => {
    const usage = `
memo.commands.register({
  id: "x",
  title: "예시",
  when: ["!note.isEmpty", "platform.macos", "settings.advanced", "plugin.other-plugin.enabled"],
  run: function () {},
});
`;
    expect(compileAgainstDts(usage)).toEqual([]);
  });

  /** 가드: 넓히기가 "아무 문자열이나 통과"로 새지 않는다(닫힌 어휘라는 계약은 그대로다). */
  it("when 어휘 밖 문자열은 여전히 타입 오류다", () => {
    const usage = `
memo.commands.register({
  id: "x",
  title: "예시",
  when: ["note.hasSelection"],
  run: function () {},
});
`;
    expect(compileAgainstDts(usage).length).toBeGreaterThan(0);
  });
});

describe("생성물 ↔ 커밋본", () => {
  const hint =
    "생성물이 낡았다 — MEMO_GEN_PLUGIN_API=1 npx vitest run src/plugin/api-index.test.ts 로 갱신하라";

  it("docs/plugin/api-reference.json이 최신이다", () => {
    expect(readFileSync(JSON_PATH, "utf8"), hint).toBe(expected.json);
  });

  it("docs/plugin/api-reference.d.ts가 최신이다", () => {
    expect(readFileSync(DTS_PATH, "utf8"), hint).toBe(expected.dts);
  });

  it("docs/plugin/authoring.md의 생성 블록이 최신이다", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    for (const name of Object.keys(artifacts.blocks)) {
      expect(readGeneratedBlock(doc, name), `${hint} (블록: ${name})`).toBe(
        readGeneratedBlock(expected.doc, name),
      );
    }
  });

  /**
   * 가드: `.d.ts`가 선언하는 호출 집합 = 예약이 아닌 호출 전수.
   *
   * 예약이 새면 편집기가 "쓸 수 있는 API"로 자동완성해 저작자를 속이고, 반대로 동작하는
   * 호출이 빠지면 정직한 코드가 타입 오류로 보인다 — 양방향으로 잡는다.
   */
  it("생성된 .d.ts의 호출 집합이 예약 아닌 호출 전수와 같다", () => {
    const declared: string[] = [];
    let ns = "";
    for (const line of artifacts.dts.split("\n")) {
      const nsMatch = /^ {2}(\w+): \{$/.exec(line);
      if (nsMatch) {
        ns = nsMatch[1];
        continue;
      }
      const methodMatch = /^ {4}(\w+)\(/.exec(line);
      if (methodMatch && ns !== "") declared.push(`${ns}.${methodMatch[1]}`);
    }
    const live = indexedCallNames().filter((c) => !RESERVED_CALLS.has(c));
    expect(declared.sort()).toEqual(live.sort());
  });
});
