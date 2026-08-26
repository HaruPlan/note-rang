/**
 * 플러그인 권한/설정 규칙 드리프트 방지 가드 모음.
 *
 * 역할: 저장소 곳곳에 손으로 복제된 플러그인 권한·설정 스키마 규칙(TS ↔ Rust ↔ 문서 ↔ 승인
 * UI ↔ 브리지 호출 매핑 ↔ 번들 순서 배열)이 서로 어긋나지 않는지 대조한다. 각 대조는 소스
 * 파일을 직접 `readFileSync`로 읽어 정규식으로 값을 뽑아 비교한다(csp-policy.test.ts·
 * sandbox-bootstrap.test.ts와 같은 방식) — 특정 export에 의존하면 그 export가 지워지거나
 * 값이 바뀌는 순간 가드가 조용히 무의미해질 수 있으므로, "복제되어 있다고 알려진 그 소스"를
 * 직접 읽어 집합으로 비교한다.
 * 왜: 권한 규칙이 5곳(TS 권한 목록·Rust 권한 목록·문서 표·승인 UI 라벨·builtin.test.ts의
 * REQUIRES 매핑)에, 번들 설정 스키마 형태가 사실상 무검증으로, 번들 순서 배열이 손으로
 * 흩어져 있다 — 한쪽만 바뀌어도 알아채지 못하던 것을 여기서 붙잡는다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// ── 공용 소스 파싱 헬퍼 ──────────────────────────────────────────────────

/** 한 줄 주석(`// ...`)을 제거한다 — 주석 안의 예시 문자열이 데이터로 오인되지 않게. */
function stripLineComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "");
}

/**
 * `marker` 뒤에 처음 나오는 `[ ... ]` 배열 리터럴에서 따옴표 문자열 토큰만 뽑는다.
 * 배열 안에 중첩 배열이 없다고 가정(현재 대조 대상 전부가 문자열 리터럴 평면 배열).
 */
function extractArrayLiteral(source: string, marker: string): string[] {
  const cleaned = stripLineComments(source);
  const idx = cleaned.indexOf(marker);
  if (idx === -1) {
    throw new Error(
      `마커를 찾을 수 없음(소스 구조가 바뀌었을 수 있음): ${marker}`,
    );
  }
  const rest = cleaned.slice(idx);
  const bracketStart = rest.indexOf("[");
  const bracketEnd = rest.indexOf("]", bracketStart);
  if (bracketStart === -1 || bracketEnd === -1) {
    throw new Error(`${marker} 뒤에서 배열 리터럴을 찾을 수 없음`);
  }
  const body = rest.slice(bracketStart + 1, bracketEnd);
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * Rust `const NAME: [&str; N] = [...]` 형태 전용 추출. 타입 주석 자체에 `[`/`]`가 있어
 * (`[&str; 8]`) 범용 `extractArrayLiteral`을 못 쓰므로, `=` 뒤의 배열만 목표로 정규식을 좁힌다.
 */
function extractRustStrArray(source: string, name: string): string[] {
  const cleaned = stripLineComments(source);
  const re = new RegExp(
    `const ${name}:\\s*\\[&str;\\s*\\d+\\]\\s*=\\s*\\[([\\s\\S]*?)\\]`,
  );
  const m = re.exec(cleaned);
  if (!m) {
    throw new Error(
      `Rust 배열을 찾을 수 없음(소스 구조가 바뀌었을 수 있음): ${name}`,
    );
  }
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/**
 * `marker` 뒤 첫 객체 리터럴(`{ ... };`)의 최상위 키만 뽑는다(중첩 필드는 들여쓰기 2칸을
 * 더 쓰므로 `^ {2}(key):` 정규식으로 구분). PERMISSION_INFO 같은 "키: {필드들}" 구조 전용.
 */
function extractObjectTopLevelKeys(source: string, marker: string): string[] {
  const cleaned = stripLineComments(source);
  const idx = cleaned.indexOf(marker);
  if (idx === -1) {
    throw new Error(
      `마커를 찾을 수 없음(소스 구조가 바뀌었을 수 있음): ${marker}`,
    );
  }
  const rest = cleaned.slice(idx);
  const braceStart = rest.indexOf("{");
  if (braceStart === -1) {
    throw new Error(`${marker} 뒤에서 객체 리터럴을 찾을 수 없음`);
  }
  const afterBrace = rest.slice(braceStart);
  const closeMatch = /\n\};/.exec(afterBrace);
  if (!closeMatch) {
    throw new Error(`${marker} 객체의 최상위 닫는 '};'를 찾을 수 없음`);
  }
  const body = afterBrace.slice(1, closeMatch.index);
  const keys: string[] = [];
  const keyRe = /^ {2}(?:"([^"]+)"|([A-Za-z_][\w-]*)):/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body))) {
    keys.push((m[1] ?? m[2])!);
  }
  return keys;
}

/** 두 문자열 집합의 대칭차를 보고용으로 계산한다. */
function setDiff(a: Set<string>, b: Set<string>) {
  return {
    onlyInA: [...a].filter((x) => !b.has(x)).sort(),
    onlyInB: [...b].filter((x) => !a.has(x)).sort(),
  };
}

// ── 1. 권한 목록: TS ↔ Rust ─────────────────────────────────────────────

describe("권한 목록: permissions.ts ↔ plugins.rs 대조", () => {
  const tsSrc = readFileSync("src/plugin/permissions.ts", "utf8");
  const rustSrc = readFileSync("src-tauri/src/plugins.rs", "utf8");

  const tsLowRisk = new Set(
    extractArrayLiteral(tsSrc, "const LOW_RISK_PERMISSIONS"),
  );
  const tsSensitive = new Set(
    extractArrayLiteral(tsSrc, "const SENSITIVE_EXACT"),
  );
  const rustLowRisk = new Set(extractRustStrArray(rustSrc, "LOW_RISK"));
  const rustSensitive = new Set(extractRustStrArray(rustSrc, "SENSITIVE"));

  /** 가드: 저위험 권한 집합이 TS·Rust에서 정확히 같다(한쪽만 추가/삭제되면 실패). */
  it("저위험 권한 집합이 같다", () => {
    expect(
      tsLowRisk.size,
      "TS LOW_RISK_PERMISSIONS가 비어있음(파싱 실패 의심)",
    ).toBeGreaterThan(0);
    expect(
      setDiff(tsLowRisk, rustLowRisk),
      "TS(permissions.ts)와 Rust(plugins.rs)의 저위험 권한 목록이 어긋남",
    ).toEqual({ onlyInA: [], onlyInB: [] });
  });

  /** 가드: 민감 권한 집합이 TS·Rust에서 정확히 같다. */
  it("민감 권한 집합이 같다", () => {
    expect(
      tsSensitive.size,
      "TS SENSITIVE_EXACT가 비어있음(파싱 실패 의심)",
    ).toBeGreaterThan(0);
    expect(
      setDiff(tsSensitive, rustSensitive),
      "TS(permissions.ts)와 Rust(plugins.rs)의 민감 권한 목록이 어긋남",
    ).toEqual({ onlyInA: [], onlyInB: [] });
  });
});

// ── 2. 승인 UI PERMISSION_INFO ↔ 알려진 권한 ────────────────────────────

describe("승인 UI 라벨: install-flow.ts의 PERMISSION_INFO ↔ 알려진 권한", () => {
  const tsSrc = readFileSync("src/plugin/permissions.ts", "utf8");
  const knownNonEmbed = new Set([
    ...extractArrayLiteral(tsSrc, "const LOW_RISK_PERMISSIONS"),
    ...extractArrayLiteral(tsSrc, "const SENSITIVE_EXACT"),
  ]);
  const installFlowSrc = readFileSync("src/settings/install-flow.ts", "utf8");
  const infoKeys = new Set(
    extractObjectTopLevelKeys(installFlowSrc, "const PERMISSION_INFO"),
  );

  /** 가드: PERMISSION_INFO 키 집합이 embed 제외 알려진 권한 전체와 정확히 일치한다(권한을
   * 추가했는데 라벨이 없으면 승인 화면에 빈 행이 보인다). */
  it("PERMISSION_INFO가 embed 아닌 모든 알려진 권한을 정확히 덮는다", () => {
    expect(
      infoKeys.size,
      "PERMISSION_INFO 키 파싱 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    expect(
      setDiff(knownNonEmbed, infoKeys),
      "알려진 권한과 PERMISSION_INFO 라벨 키 목록이 어긋남(onlyInA=라벨 누락, onlyInB=모르는 권한)",
    ).toEqual({ onlyInA: [], onlyInB: [] });
  });
});

// ── 3. 문서 권한 표 ↔ 코드 ───────────────────────────────────────────────

/** 문서의 "| 권한 | 등급 | ... |" 표에서 첫 열의 백틱 토큰만 뽑는다(설명 열의 백틱은 무시). */
function extractDocPermissionTokens(docSrc: string): Set<string> {
  const lines = docSrc.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim().startsWith("| 권한"));
  if (headerIdx === -1) {
    throw new Error(
      "문서에서 권한 표 머리글을 찾을 수 없음(표 형식이 바뀌었을 수 있음)",
    );
  }
  const tokens = new Set<string>();
  // headerIdx+1은 구분선(---) 행이므로 +2부터 데이터 행.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const firstCol = line.split("|")[1] ?? "";
    for (const m of firstCol.matchAll(/`([^`]+)`/g)) {
      tokens.add(m[1]);
    }
  }
  return tokens;
}

describe("문서 권한 표: docs/plugin/authoring.md ↔ 코드", () => {
  const docsSrc = readFileSync("docs/plugin/authoring.md", "utf8");
  const tsSrc = readFileSync("src/plugin/permissions.ts", "utf8");
  const knownNonEmbed = new Set([
    ...extractArrayLiteral(tsSrc, "const LOW_RISK_PERMISSIONS"),
    ...extractArrayLiteral(tsSrc, "const SENSITIVE_EXACT"),
  ]);
  const rawDocTokens = extractDocPermissionTokens(docsSrc);
  // `embed:<도메인>` 행은 실제 권한 id가 아니라 패턴 설명이므로 플레이스홀더(`<`)를 제외.
  const docTokens = new Set([...rawDocTokens].filter((t) => !t.includes("<")));

  /** 가드(핵심): 문서 표에서 권한이 빠지면 반드시 잡는다. */
  it("문서 표가 embed 제외 모든 권한을 빠짐없이 나열한다", () => {
    expect(
      docTokens.size,
      "문서 권한 표 파싱 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    const missingFromDocs = [...knownNonEmbed].filter((p) => !docTokens.has(p));
    expect(
      missingFromDocs,
      `문서 권한 표에서 빠진 권한: ${missingFromDocs.join(", ")}`,
    ).toEqual([]);
  });

  /** 가드: 문서 표가 코드도 모르는 권한을 싣고 있지 않다(표기 오타·죽은 권한 잔존 방지). */
  it("문서 표에 코드가 모르는 권한이 없다", () => {
    const extraInDocs = [...docTokens].filter((p) => !knownNonEmbed.has(p));
    expect(
      extraInDocs,
      `코드는 모르는데 문서에만 있는 권한: ${extraInDocs.join(", ")}`,
    ).toEqual([]);
  });
});

// ── 4. CALL_PERMISSIONS ↔ builtin.test.ts REQUIRES 커버리지 ─────────────

/** host.ts의 `CALL_PERMISSIONS` 객체 리터럴에서 `"call": "perm"` 키(호출명)만 뽑는다. */
function extractCallPermissionKeys(hostSrc: string): string[] {
  const cleaned = stripLineComments(hostSrc);
  const marker = "export const CALL_PERMISSIONS";
  const start = cleaned.indexOf(marker);
  if (start === -1) {
    throw new Error(
      "CALL_PERMISSIONS 선언을 찾을 수 없음(host.ts 구조가 바뀌었을 수 있음)",
    );
  }
  const braceStart = cleaned.indexOf("{", start);
  const closeIdx = cleaned.indexOf("\n};", braceStart);
  if (braceStart === -1 || closeIdx === -1) {
    throw new Error("CALL_PERMISSIONS 객체의 경계를 찾을 수 없음");
  }
  const body = cleaned.slice(braceStart + 1, closeIdx);
  return [...body.matchAll(/"([a-zA-Z][\w.]*)":\s*"/g)].map((m) => m[1]);
}

/**
 * builtin.test.ts(읽기 전용 — 소유 밖 파일)의 `REQUIRES` 배열에서 각 항목의 `pattern: /.../`
 * 정규식 소스만 뽑아 RegExp로 되살린다. `pattern:`과 `/.../`가 여러 줄에 걸쳐도(들여쓰기 때문에)
 * 잡히도록 `\s*`로 사이 공백/개행을 허용한다.
 */
function extractRequiresPatterns(testSrc: string): RegExp[] {
  const marker = "const REQUIRES";
  const start = testSrc.indexOf(marker);
  if (start === -1) {
    throw new Error(
      "builtin.test.ts에서 REQUIRES 선언을 찾을 수 없음(구조가 바뀌었을 수 있음 — " +
        "소유 밖 파일이라 직접 고치지 말고 요청사항으로 보고할 것)",
    );
  }
  const loopMarker = "for (const plugin of BUILTIN_PLUGINS)";
  const loopIdx = testSrc.indexOf(loopMarker, start);
  const slice =
    loopIdx === -1 ? testSrc.slice(start) : testSrc.slice(start, loopIdx);
  const patterns: RegExp[] = [];
  for (const m of slice.matchAll(/pattern:\s*\/(.+?)\/,/g)) {
    patterns.push(new RegExp(m[1]));
  }
  return patterns;
}

describe("CALL_PERMISSIONS ↔ builtin.test.ts REQUIRES 커버리지", () => {
  const hostSrc = readFileSync("src/plugin/host.ts", "utf8");
  // builtin.test.ts는 이 담당의 소유 파일이 아니다 — 읽기만 한다.
  const builtinTestSrc = readFileSync("src/plugin/builtin.test.ts", "utf8");

  const callKeys = extractCallPermissionKeys(hostSrc);
  const reserved = new Set(
    extractArrayLiteral(hostSrc, "export const RESERVED_CALLS"),
  );
  const requiresPatterns = extractRequiresPatterns(builtinTestSrc);
  // 실행 경로가 없는(RESERVED_CALLS) 호출은 번들 코드가 실제로 쓸 수 없으므로 커버리지
  // 대상에서 제외 — "실행 가능한데 REQUIRES가 못 잡는 호출"만 드리프트로 본다.
  const liveCalls = callKeys.filter((c) => !reserved.has(c));

  /** 가드(회귀): 실행 경로가 있는 모든 브리지 호출이 REQUIRES 패턴 중 하나로 매칭된다.
   * 못 잡으면, 번들이 그 호출을 쓰면서 권한 선언을 빠뜨려도 builtin.test.ts 가드가
   * 조용히 통과한다(커밋 64a900b류 버그 재발 경로). */
  it("실행 가능한 모든 호출이 REQUIRES 패턴으로 커버된다", () => {
    expect(
      callKeys.length,
      "CALL_PERMISSIONS 파싱 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    expect(
      requiresPatterns.length,
      "REQUIRES 패턴 파싱 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    const uncovered = liveCalls.filter(
      (call) => !requiresPatterns.some((re) => re.test(`memo.${call}(`)),
    );
    expect(
      uncovered,
      `builtin.test.ts REQUIRES가 못 잡는 실행 가능 호출: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });
});

// ── 5. 번들 플러그인 settings 스키마 ↔ Rust parse_settings_schema 규칙 ──

/**
 * Rust parse_settings_schema가 인정하는 설정 위젯 타입(plugins.rs 기준 — number·button이
 * 추가돼 7종).
 */
const VALID_SETTING_TYPES = new Set([
  "text",
  "toggle",
  "select",
  "textarea",
  "list",
  "number",
  "button",
]);

/** Rust is_valid_setting_key와 동일 규칙: 비어있지 않고 영숫자·`_`만, JS 예약 키 거부. */
function isValidSettingKey(key: string): boolean {
  return (
    key.length > 0 &&
    /^[A-Za-z0-9_]+$/.test(key) &&
    !["__proto__", "constructor", "prototype"].includes(key)
  );
}

/**
 * Rust `parse_settings_schema`와 동일 규칙으로 raw 설정 필드 하나를 검증한다.
 * 위반이면 사유 문자열, 통과면 null.
 */
function validateSettingField(field: unknown, index: number): string | null {
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    return `설정[${index}]: 항목이 객체가 아님`;
  }
  const f = field as Record<string, unknown>;
  const key = f.key;
  if (typeof key !== "string") return `설정[${index}]: key 누락 또는 형식 오류`;
  if (!isValidSettingKey(key))
    return `설정[${index}] key '${key}': key 형식 오류`;
  if (typeof f.label !== "string") {
    return `설정[${index}] key '${key}': label 누락 또는 형식 오류`;
  }
  const kind = f.type;
  if (typeof kind !== "string" || !VALID_SETTING_TYPES.has(kind)) {
    return `설정[${index}] key '${key}': 알 수 없는 type '${String(kind)}'`;
  }
  // 문자열 축약형 ∪ `{value,label?,description?}` 객체형. 축약형은 value=label의 줄임.
  let options: unknown[] = [];
  if (f.options !== undefined && f.options !== null) {
    if (!Array.isArray(f.options)) {
      return `설정[${index}] key '${key}': options가 배열이 아님`;
    }
    for (const o of f.options) {
      if (typeof o === "string") continue;
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        return `설정[${index}] key '${key}': options 항목이 문자열도 객체도 아님`;
      }
      if (typeof (o as { value?: unknown }).value !== "string") {
        return `설정[${index}] key '${key}': options 항목에 value가 없음`;
      }
    }
    options = f.options as unknown[];
  }
  if (kind === "select" && options.length === 0) {
    return `설정[${index}] key '${key}': select에 options가 필요함`;
  }
  // button은 실행할 명령 id가 없으면 눌러도 아무 일이 없는 버튼이 된다 — Rust·TS 검증기
  // 둘 다 그 매니페스트를 거부하므로 번들도 같은 규칙을 받아야 한다.
  if (
    kind === "button" &&
    (typeof f.command !== "string" || f.command.trim() === "")
  ) {
    return `설정[${index}] key '${key}': button에 command가 필요함`;
  }
  return null;
}

describe("번들 플러그인 settings 스키마 ↔ Rust parse_settings_schema 규칙", () => {
  const pluginsDir = "src/plugin/builtin/plugins";
  const ids = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  /** 가드: 모든 번들 플러그인의 raw manifest.json settings가 Rust 검증 규칙(허용 타입 5종,
   * select의 options 필수, key 형식·예약 key 거부)을 통과한다. 중앙 호스트(TS)도 Rust
   * 서버도 번들 settings를 검증하지 않으므로, 이 가드가 유일한 형태 보증이다. */
  it("모든 번들 플러그인의 settings가 Rust 규칙을 통과한다", () => {
    expect(
      ids.length,
      "번들 플러그인 폴더 스캔 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const id of ids) {
      const manifestPath = `${pluginsDir}/${id}/manifest.json`;
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        settings?: unknown;
      };
      if (raw.settings === undefined || raw.settings === null) continue;
      if (!Array.isArray(raw.settings)) {
        violations.push(`${id}: settings가 배열이 아님`);
        continue;
      }
      raw.settings.forEach((field, i) => {
        const err = validateSettingField(field, i);
        if (err) violations.push(`${id}: ${err}`);
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// ── 6. 번들 순서 배열 ↔ 실제 폴더 커버리지 ──────────────────────────────

describe("번들 순서 배열 ↔ 실제 폴더 커버리지", () => {
  const indexSrc = readFileSync("src/plugin/builtin/index.ts", "utf8");
  const pluginOrder = extractArrayLiteral(indexSrc, "ordered(pluginById");
  const themeOrder = extractArrayLiteral(indexSrc, "ordered(themeById");
  const pluginDirs = readdirSync("src/plugin/builtin/plugins", {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const themeDirs = readdirSync("src/plugin/builtin/themes", {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  /** 가드: BUILTIN_PLUGINS 순서 배열이 plugins/ 폴더 전체를 중복 없이 정확히 덮는다(순서
   * 목록에 없는 새 폴더는 우선순위 최하위로 조용히 강등되므로, 누락을 여기서 잡는다). */
  it("BUILTIN_PLUGINS 순서 배열이 plugins/ 폴더 전체와 정확히 일치한다(중복 없이)", () => {
    expect(
      pluginDirs.length,
      "plugins/ 폴더 스캔 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    expect(new Set(pluginOrder).size, "순서 배열에 중복 id가 있음").toBe(
      pluginOrder.length,
    );
    const orderSet = new Set(pluginOrder);
    const missing = pluginDirs.filter((d) => !orderSet.has(d));
    const stale = pluginOrder.filter((d) => !pluginDirs.includes(d));
    expect(
      { missing, stale },
      "missing=순서 배열에 없는 실제 폴더(우선순위 최하위로 강등됨), " +
        "stale=순서 배열에는 있지만 실제로는 없는 폴더(유령 항목)",
    ).toEqual({ missing: [], stale: [] });
  });

  /** 가드: BUILTIN_THEMES 순서 배열이 themes/ 폴더 전체를 중복 없이 정확히 덮는다. */
  it("BUILTIN_THEMES 순서 배열이 themes/ 폴더 전체와 정확히 일치한다(중복 없이)", () => {
    expect(
      themeDirs.length,
      "themes/ 폴더 스캔 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    expect(new Set(themeOrder).size, "순서 배열에 중복 id가 있음").toBe(
      themeOrder.length,
    );
    const orderSet = new Set(themeOrder);
    const missing = themeDirs.filter((d) => !orderSet.has(d));
    const stale = themeOrder.filter((d) => !themeDirs.includes(d));
    expect(
      { missing, stale },
      "missing=순서 배열에 없는 실제 테마 폴더, stale=순서 배열에는 있지만 실제로는 없는 폴더",
    ).toEqual({ missing: [], stale: [] });
  });
});

// ── 7. 번들 onClick ↔ 호출 컨텍스트 전파 규약 ───────────────────────────

/**
 * 한 `onClick:` 값의 (매개변수 목록, 본문)을 뽑는다. 인라인 함수(`function (a) {...}`·
 * `(a) => {...}`)와 이름 참조(`onClick: onSaveClick`)를 모두 다룬다 — 이름 참조는 같은 파일의
 * `function <이름>(...) {...}` 선언을 찾아 대신 읽는다. 중괄호 균형으로 본문을 자르므로 우리
 * 소스(번들 플러그인)에서는 정확하다(문자열 안 중괄호는 쓰지 않는다).
 */
function onClickHandlers(src: string): { params: string; body: string }[] {
  const out: { params: string; body: string }[] = [];
  /** idx가 `{`인 지점부터 균형이 맞는 닫는 `}`까지의 본문을 낸다. */
  const balanced = (from: number): string => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(from, i + 1);
      }
    }
    return src.slice(from);
  };
  /** `(params) {` 또는 `(params) => {` 형태를 pos부터 읽는다. */
  const readFn = (pos: number): { params: string; body: string } | null => {
    const open = src.indexOf("(", pos);
    if (open === -1) return null;
    const close = src.indexOf(")", open);
    if (close === -1) return null;
    const brace = src.indexOf("{", close);
    if (brace === -1) return null;
    return { params: src.slice(open + 1, close).trim(), body: balanced(brace) };
  };
  for (const m of src.matchAll(/onClick:\s*/g)) {
    const pos = (m.index ?? 0) + m[0].length;
    const rest = src.slice(pos);
    if (/^(function\b|async\b|\()/.test(rest)) {
      const fn = readFn(pos);
      if (fn) out.push(fn);
      continue;
    }
    const named = /^([A-Za-z_$][\w$]*)/.exec(rest);
    if (!named) continue;
    const decl = new RegExp(`function\\s+${named[1]}\\s*\\(`).exec(src);
    if (!decl) continue;
    const fn = readFn(decl.index);
    if (fn) out.push(fn);
  }
  return out;
}

describe("번들 onClick ↔ 호출 컨텍스트 전파 규약", () => {
  /**
   * 가드: 핸들러 본문이 **전역 컨텍스트 전파가 끊기는 경계**(`Promise.all`/`Promise.race`/
   * `setTimeout`/비-브리지 `await`)를 쓰면, 반드시 바인딩된 memo를 인자로 받아야 한다.
   *
   * 왜: 전역 `window.memo`는 `.then` 체인과 브리지 호출 `await`까지만 토큰을 유지한다
   * (sandbox-bootstrap.ts 문서 참고). 그 경계를 넘은 창-스코프 호출은 ctx 없이 나가 호스트가
   * "마지막 클릭 창"으로 폴백하고, 창이 여러 개면 A의 결과가 B에 꽂힌다(실증된 데이터 손상).
   * 범위: 인라인/이름 참조 핸들러 **본문 자체**만 본다(호출하는 헬퍼까지 추적하지 않는다) —
   * 헬퍼는 inCtx 구간 안에서 동기 호출되면 안전하다.
   */
  it("컨텍스트 유실 경계를 쓰는 onClick은 바인딩된 memo를 인자로 받는다", () => {
    const dirs = readdirSync("src/plugin/builtin/plugins", {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(
      dirs.length,
      "plugins/ 폴더 스캔 실패 의심(빈 결과)",
    ).toBeGreaterThan(0);
    const offenders: string[] = [];
    let checked = 0;
    for (const dir of dirs) {
      const src = readFileSync(
        `src/plugin/builtin/plugins/${dir}/main.js`,
        "utf8",
      );
      for (const h of onClickHandlers(src)) {
        checked++;
        const unsafe =
          /\bPromise\s*\.\s*(all|race|allSettled|any)\b|\bsetTimeout\s*\(|\bawait\b/.test(
            stripLineComments(h.body),
          );
        if (unsafe && h.params === "") offenders.push(dir);
      }
    }
    expect(
      checked,
      "onClick 핸들러를 하나도 못 읽음(파서 드리프트)",
    ).toBeGreaterThan(0);
    expect(
      offenders,
      "이 핸들러들은 Promise.all·setTimeout·await를 쓰면서 바인딩된 memo를 안 받는다 → " +
        "onClick: function (memo) { ... } 로 인자를 받아 전역을 가려라",
    ).toEqual([]);
  });
});

// ── 8. 툴바 배치 스키마 소유권: 프론트 단독(Rust는 불투명 저장) ─────────

describe("툴바 배치 스키마: Rust는 형태를 알지 않는다(불투명 저장)", () => {
  const modelSrc = readFileSync("src-tauri/src/model.rs", "utf8");

  /**
   * 가드(유실 회귀): Rust는 툴바 배치를 필드가 선언된 구조체가 아니라 불투명 JSON 값으로
   * 들고 있어야 한다.
   *
   * 왜: serde derive는 역직렬화에서 모르는 필드를 **조용히 버리고** 직렬화에서 선언된 필드만
   * 쓴다. 배치 스키마의 소유자는 프론트(toolbar-layout.ts)인데 Rust가 `{top, bottom}`만 아는
   * 구조체로 받던 시절, 프론트가 새로 도입한 `seen`·`foldRank`가 저장 왕복마다 사라져
   * "사용자가 팔레트로 빼낸 버튼이 재시작마다 되살아나는" 형태로 드러났다. 앞으로 프론트가
   * 필드를 늘려도 Rust를 함께 고칠 필요가 없도록 불투명 저장을 못박는다.
   */
  it("model.rs가 ToolbarLayout을 serde_json::Value로 둔다(구조체 재도입 금지)", () => {
    expect(
      modelSrc,
      "ToolbarLayout이 불투명 별칭이 아니다 — 구조체로 되돌리면 프론트가 더한 배치 필드가 조용히 유실된다",
    ).toMatch(/pub type ToolbarLayout\s*=\s*serde_json::Value\s*;/);
    const structs = [
      ...stripLineComments(modelSrc).matchAll(
        /struct\s+(\w*(?:Toolbar|Bar)Layout)\b/g,
      ),
    ].map((m) => m[1]);
    expect(
      structs,
      "배치 형태를 선언한 Rust 구조체가 다시 생겼다 — 프론트가 스키마 단일 소유자다",
    ).toEqual([]);
  });

  /** 가드: 배치를 실어 나르는 SharedSettings 필드가 여전히 그 불투명 타입을 쓴다(별칭만
   * 남고 필드가 다른 타입으로 갈아 끼워지는 드리프트 차단). */
  it("SharedSettings.toolbar_layout이 그 불투명 타입을 쓴다", () => {
    expect(modelSrc).toMatch(/pub toolbar_layout:\s*Option<ToolbarLayout>\s*,/);
  });
});

// ── 9. IPC 래퍼 ↔ 프로덕션 소비처(선언만 되고 아무도 안 읽는 것 차단) ────

/**
 * 이 저장소가 반복해서 만든 결함 하나: **경로 절반만 배선하고 끝낸다.** Rust 커맨드 →
 * `lib.rs` 등록 → `shared/tauri.ts` 래퍼까지 오고 나서, 그 래퍼를 실제로 부르는 화면 코드가
 * 없다. `position` 폴백(문서·타입·주석에는 있는데 소비처 0곳)이 그랬고, 방금 웨이브에서도
 * `list_rejected_plugins`·`set_plugin_pending_reserved`가 같은 모양으로 멈춰 있었다.
 *
 * knip이 못 잡는 이유: 테스트가 그 export를 부르면 "쓰이는 export"가 된다. 그래서 여기서
 * **테스트를 뺀** 소비처 수를 직접 센다.
 */
describe("IPC 래퍼: shared/tauri.ts의 모든 export에 프로덕션 소비처가 있다", () => {
  const tauriPath = "src/shared/tauri.ts";
  const tauriSrc = readFileSync(tauriPath, "utf8");

  /** `src/` 아래 `.ts` 파일 전수(테스트 파일과 래퍼 자신은 제외 — 소비처 후보만). */
  function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...productionSources(path));
      else if (
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        path !== tauriPath
      ) {
        out.push(path);
      }
    }
    return out;
  }

  const consumers = productionSources("src").map((p) => ({
    path: p,
    src: stripLineComments(readFileSync(p, "utf8")),
  }));

  /**
   * 가드: 래퍼가 export하는 모든 함수를 프로덕션 코드 어딘가가 부른다.
   *
   * 위반이면 둘 중 하나다 — (a) 화면 배선을 빠뜨렸다(고쳐라), (b) 이 래퍼가 정말 필요 없다
   * (지워라). 어느 쪽이든 "선언만 남은 계약"으로 방치하지 않는다.
   */
  it("테스트를 제외한 소비처가 최소 한 곳 있다", () => {
    const exported = [
      ...stripLineComments(tauriSrc).matchAll(
        /^export (?:async )?function (\w+)/gm,
      ),
    ].map((m) => m[1]);
    expect(exported.length, "export 추출 실패 의심(빈 결과)").toBeGreaterThan(
      10,
    );
    const orphans = exported.filter(
      (name) => !consumers.some((c) => new RegExp(`\\b${name}\\b`).test(c.src)),
    );
    expect(
      orphans,
      "IPC 래퍼는 있는데 부르는 화면 코드가 없다 — 배선을 마치거나 래퍼를 지워라",
    ).toEqual([]);
  });
});

// ── 10. 저장소 용량 초과: Rust 문구 ↔ TS 분류기 ────────────────────────

/**
 * `storage.local`의 상한 초과는 Rust가 **문자열**로 거부하고(`Result<T, String>`),
 * `central-host.ts`가 그 문자열을 보고 `code: "QUOTA_EXCEEDED"`로 바꾼다.
 *
 * 왜 가드가 필요한가: 접두어가 한쪽에서만 바뀌면 분류가 조용히 멈춘다 — 브리지는 여전히
 * 거부하지만 code가 `UNKNOWN`이 되어, 계약을 믿고 짠 저작자의 정리·재시도 가지가 죽는다
 * (실패는 여전히 실패로 보이므로 아무도 알아채지 못한다).
 */
describe("저장소 용량 초과 문구: plugin_storage.rs ↔ central-host.ts", () => {
  const rustSrc = readFileSync("src-tauri/src/plugin_storage.rs", "utf8");
  const tsSrc = readFileSync("src/plugin/central-host.ts", "utf8");

  /** 소스에서 `NAME ... = "값"` 형태의 문자열 상수를 뽑는다(TS·Rust 공용). */
  function constString(source: string, name: string): string {
    const m = new RegExp(`${name}[^=\\n]*=\\s*"([^"]*)"`).exec(source);
    if (!m) throw new Error(`문자열 상수를 찾을 수 없음: ${name}`);
    return m[1];
  }

  /** 소스에서 `NAME ... = <식>;`의 우변을 뽑는다(숫자 식을 문자열 그대로 비교). */
  function constExpr(source: string, name: string): string {
    const m = new RegExp(`${name}[^=\\n]*=\\s*([^;\\n]+);`).exec(source);
    if (!m) throw new Error(`상수를 찾을 수 없음: ${name}`);
    return m[1].trim();
  }

  it("용량 초과 접두어가 TS·Rust에서 같다", () => {
    expect(constString(tsSrc, "const QUOTA_EXCEEDED_PREFIX")).toBe(
      constString(rustSrc, "QUOTA_EXCEEDED_PREFIX: &str"),
    );
  });

  /** 가드: 메모리 스코프 상한이 디스크 상한과 같다(계약 문구가 "스코프 불문 256KB"다). */
  it("메모리 스코프 상한이 디스크 상한과 같다", () => {
    expect(constExpr(tsSrc, "const MAX_MEMORY_STORE_BYTES")).toBe(
      constExpr(rustSrc, "MAX_STORAGE_BYTES: usize"),
    );
  });
});

// ── 11. 플러그인 브리지에 노출된 노트 커맨드: 동기 커맨드 금지 정책 ──────

/**
 * `plugin_storage.rs` 모듈 문서의 정책: "디스크 IO를 감싸는 Tauri 커맨드는 전부 async
 * 실행 컨텍스트로 등록한다 — 동기 커맨드가 메인 스레드를 막아 앱이 얼었던 전례가 있다."
 * `note_list`/`note_read`가 신뢰 경계 밖(샌드박스 플러그인)에 처음 직접 노출됐으므로, 이
 * 둘이 동기로 돌아가면 플러그인 하나의 호출 루프가 모든 창(그 플러그인을 끌 설정 창까지)을
 * 함께 얼린다. 특히 `note_list`는 vault 뮤텍스를 잡은 채 모든 노트의 .md·.json을 읽는
 * O(전체 노트) 커맨드다.
 *
 * Tauri는 두 형태 모두 async 실행 컨텍스트로 등록한다(tauri-macros `wrapper.rs`의
 * `ExecutionContext` 판정 — 함수가 `async fn`이면 속성에 `(async)`가 없어도 자동으로
 * Async로 승격된다): 동기 `fn` + 명시적 `#[tauri::command(async)]`, 또는 진짜
 * `async fn` + 간결한 `#[tauri::command]`. `commands.rs`는 `blocking` 헬퍼 도입 이후
 * 후자로 통일했으므로 둘 다 인정한다.
 */
describe("플러그인에 노출된 노트 커맨드는 async다: commands.rs", () => {
  it("note_list·note_read가 async 실행 컨텍스트로 등록된다", () => {
    const src = readFileSync("src-tauri/src/commands.rs", "utf8");
    for (const name of ["note_list", "note_read"]) {
      const asyncFn = new RegExp(
        `#\\[tauri::command\\]\\s*\\npub async fn ${name}\\b`,
      );
      const syncWithAsyncAttr = new RegExp(
        `#\\[tauri::command\\(async\\)\\]\\s*\\npub fn ${name}\\b`,
      );
      expect(
        asyncFn.test(src) || syncWithAsyncAttr.test(src),
        `${name}는 async 실행 컨텍스트로 등록돼야 한다(동기 커맨드는 메인 스레드에서 돌아 앱 전체를 얼린다 — plugin_storage.rs 모듈 문서의 정책): #[tauri::command] + async fn 또는 #[tauri::command(async)] + fn 중 하나여야 한다`,
      ).toBe(true);
    }
  });
});

/**
 * 소스 위생 — `src/**`에 탭·개행 밖의 C0 제어문자(특히 NUL)를 남기지 않는다.
 *
 * 왜 이 가드가 필요한가: 구분자를 만들 때 이스케이프(`\u0000`) 대신 **날 NUL 바이트**를 파일에
 * 넣어도 TypeScript는 정상 컴파일하고 테스트도 전부 통과한다. 그런데 grep·ripgrep 계열 도구는
 * 그 파일을 **바이너리로 판정해 통째로 건너뛴다** — 그 순간 "이 심볼을 쓰는 곳이 있는가"를
 * grep으로 세는 모든 감사가 그 파일에 대해 **조용히 0을 반환**한다. 이 저장소가 11번 겪은
 * 「선언은 됐는데 아무도 안 읽는다」를 잡는 수단이 바로 그 grep 감사이므로, 이 위생이 깨지면
 * 감사 자체가 거짓말을 한다. 실제로 `central-host.ts`가 그 상태였다(웨이브 B 통합에서 교정).
 */
describe("소스 위생: 날 제어문자가 섞이지 않는다", () => {
  // 문자 클래스 자체를 리터럴로 적으면 이 파일이 스스로 위반한다 — 이스케이프로 만든다.
  // eslint-disable-next-line no-control-regex -- 제어문자를 찾는 것이 이 가드의 목적이다.
  const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]");

  function textSources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...textSources(path));
      else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) out.push(path);
    }
    return out;
  }

  it("src/** 의 .ts·.js에 NUL 등 C0 제어문자가 없다", () => {
    const files = textSources("src");
    expect(files.length, "소스 수집 실패 의심(빈 결과)").toBeGreaterThan(50);
    const dirty = files.filter((f) => CONTROL.test(readFileSync(f, "utf8")));
    expect(
      dirty,
      "날 제어문자가 있는 소스 — grep이 바이너리로 보고 건너뛴다. `\\u0000` 같은 이스케이프로 바꿔라",
    ).toEqual([]);
  });
});

// ── 12. 선언형 기여 종류 어휘: TS ↔ Rust ────────────────────────────────

/**
 * TS의 아는 기여 종류는 **두 표의 합집합**이다: 브리지 호출로 되돌아가는 것
 * (`CONTRIBUTION_CALLS`)과 코어가 직접 읽는 것(`CORE_CONTRIBUTION_PERMISSIONS`).
 * `manifest.ts`의 `CONTRIBUTION_KINDS`가 그 합집합을 파생하므로, 여기서는 파생 입력 두 개의
 * 키를 합쳐 Rust와 대조한다(파생 결과를 정규식으로 읽으면 `...Object.keys(...)` 스프레드라
 * 문자열 리터럴이 하나도 안 잡힌다).
 */
function tsContributionKinds(): Set<string> {
  const src = readFileSync("src/plugin/manifest.ts", "utf8");
  return new Set([
    ...extractObjectTopLevelKeys(src, "export const CONTRIBUTION_CALLS"),
    ...extractObjectTopLevelKeys(
      src,
      "export const CORE_CONTRIBUTION_PERMISSIONS",
    ),
  ]);
}

/**
 * 가드: 매니페스트가 선언할 수 있는 기여 종류 어휘가 TS·Rust에서 정확히 같다.
 *
 * 왜 필요한가: 두 파서가 **각자** "모르는 종류는 무시"라는 전방 호환 정책을 갖는데, 무시의
 * 결과가 서로 다르다. Rust만 모르면 매니페스트가 설치 시점에 거부되거나 그 배열이 통째로
 * 안 실리고, TS만 모르면 정상 플러그인이 매번 "모르는 기여 종류" 진단을 받는다 — 어느 쪽도
 * 저작자에게는 "CLI/문서는 된다는데 앱은 안 된다"로만 보인다. 언어팩이 브리지에서 빠지면서
 * TS 쪽 어휘가 `CONTRIBUTION_CALLS` 하나에서 두 표의 합집합으로 갈라졌으므로, 그 합집합을
 * 대조 대상으로 삼는다.
 */
describe("선언형 기여 종류: manifest.ts ↔ plugins.rs 대조", () => {
  it("아는 기여 종류 집합이 같다", () => {
    const ts = tsContributionKinds();
    const rust = new Set(
      extractRustStrArray(
        readFileSync("src-tauri/src/plugins.rs", "utf8"),
        "CONTRIBUTION_KINDS",
      ),
    );
    expect(ts.size, "TS 기여 종류 파싱 실패 의심(빈 결과)").toBeGreaterThan(0);
    expect(
      setDiff(ts, rust),
      "TS(manifest.ts)와 Rust(plugins.rs)의 기여 종류 어휘가 어긋남",
    ).toEqual({ onlyInA: [], onlyInB: [] });
  });

  /** 가드: 코어가 직접 읽는 기여의 권한이 실제로 **알려진 권한**이다(오타·죽은 권한 차단). */
  it("코어 직접 소비 기여가 요구하는 권한이 알려진 권한이다", () => {
    const manifestSrc = readFileSync("src/plugin/manifest.ts", "utf8");
    const permsSrc = readFileSync("src/plugin/permissions.ts", "utf8");
    const known = new Set([
      ...extractArrayLiteral(permsSrc, "const LOW_RISK_PERMISSIONS"),
      ...extractArrayLiteral(permsSrc, "const SENSITIVE_EXACT"),
    ]);
    const marker = "export const CORE_CONTRIBUTION_PERMISSIONS";
    const body = stripLineComments(manifestSrc).slice(
      manifestSrc.indexOf(marker),
    );
    const values = [
      ...body.slice(0, body.indexOf("};")).matchAll(/:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(values.length, "권한 값 파싱 실패 의심(빈 결과)").toBeGreaterThan(0);
    expect(values.filter((p) => !known.has(p))).toEqual([]);
  });
});

// ── 13. REMOVED_CALLS ↔ 살아 있는 호출 어휘(교집합 0) ────────────────────

/**
 * 가드: "없어진 호출" 표의 키가 **살아 있는 어떤 어휘에도 없다**.
 *
 * 왜: 이 표의 유일한 효과는 문구 교체다 — 겹치는 이름이 생기면 실제로는 **동작하는** 호출에
 * "없어졌으니 매니페스트로 옮기세요"라고 안내하게 된다(런타임은 정상 실행하는데 CLI는 error를
 * 내는, 저작자가 절대 못 푸는 모순). 이름을 되살릴 때 이 표에서 지우는 것을 잊는 것이 정확히
 * 그 시나리오라, 되살림과 표 정리를 한 커밋에 묶는 것이 이 가드의 목적이다.
 *
 * 문서(`docs/contributing/i18n.md`의 「API 축소」 절)가 "옛 이름을 부르면 UNKNOWN_CALL로
 * 떨어진다"고 약속하는데, 그 약속이 성립하려면 이 교집합이 비어 있어야 한다.
 */
describe("REMOVED_CALLS: 살아 있는 호출 어휘와 겹치지 않는다", () => {
  it("없어진 호출 이름이 아는 호출·예약 호출 어디에도 없다", async () => {
    const {
      CALL_PERMISSIONS,
      NO_PERMISSION_CALLS,
      RESERVED_CALLS,
      REMOVED_CALLS,
    } = await import("./host");
    const removed = Object.keys(REMOVED_CALLS);
    expect(
      removed.length,
      "REMOVED_CALLS가 비어있음(가드 무의미)",
    ).toBeGreaterThan(0);
    const alive = new Set([
      ...Object.keys(CALL_PERMISSIONS),
      ...NO_PERMISSION_CALLS,
      ...RESERVED_CALLS,
    ]);
    expect(
      removed.filter((c) => alive.has(c)),
      "없어졌다고 안내하는 이름이 살아 있는 어휘에도 있다 — 되살렸다면 REMOVED_CALLS에서 지워라",
    ).toEqual([]);
  });
});
