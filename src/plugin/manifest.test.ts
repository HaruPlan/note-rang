import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  parseManifest,
  resolveInstalledPluginNls,
  resolveNlsString,
  type PluginManifest,
} from "./manifest";
import type { InstalledPlugin, PluginSettingField } from "../shared/tauri";

const VALID = {
  id: "wikilink",
  name: "Wiki Links",
  version: "1.0.0",
  entry: "main.js",
  permissions: ["editor", "notes:read"],
};

describe("parseManifest", () => {
  /** 가드: 유효한 매니페스트는 검증된 필드로 통과한다. */
  it("accepts a valid manifest", () => {
    const result = parseManifest(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const m: PluginManifest = result.manifest;
      expect(m.id).toBe("wikilink");
      expect(m.permissions).toEqual(["editor", "notes:read"]);
    }
  });

  /** 가드: permissions 생략 시 빈 배열로 기본화. */
  it("defaults permissions to empty when omitted", () => {
    const result = parseManifest({
      id: "x",
      name: "X",
      version: "1.0.0",
      entry: "main.js",
    });
    expect(result.ok && result.manifest.permissions).toEqual([]);
  });

  /** 가드: 필수 필드 누락/형식 오류는 거부. */
  it("rejects missing or malformed required fields", () => {
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest({ ...VALID, id: "" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, id: "Bad Id!" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, name: 42 }).ok).toBe(false);
    expect(parseManifest({ ...VALID, entry: undefined }).ok).toBe(false);
  });

  /** 가드: version은 semver 접두 형식만 허용한다("1"·"v1.0"·빈 문자열은 거부).
   * `compareVersions`(install-flow.ts)가 자유 형식 버전을 "비교 불가"로 보고 다운그레이드
   * 판정을 건너뛰므로, 이 강제가 없으면 그 판정이 항상 무효화될 수 있다. */
  it("rejects non-semver version strings", () => {
    expect(parseManifest({ ...VALID, version: "1" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, version: "1.0" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, version: "v1.0.0" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, version: "" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, version: "1.0.0" }).ok).toBe(true);
    expect(parseManifest({ ...VALID, version: "1.0.0-beta.1" }).ok).toBe(true);
  });

  /** 가드: 미지의 권한을 선언하면 거부. */
  it("rejects unknown permissions", () => {
    const result = parseManifest({
      ...VALID,
      permissions: ["editor", "filesystem"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("알 수 없는 권한");
  });

  /** 가드: permissions가 배열이 아니면 거부. */
  it("rejects non-array permissions", () => {
    expect(parseManifest({ ...VALID, permissions: "editor" }).ok).toBe(false);
  });

  /** 가드(보안 핵심): entry의 경로 탈출·빈 문자열을 Rust(`plugins.rs`)와 동일 규칙으로
   *  거부한다 — 설치 경로가 이 검증 하나만 거치는 경우에도 방어가 성립해야 한다. */
  it("rejects an entry that escapes the plugin directory or is empty", () => {
    const bad = ["", "../evil.js", "sub/main.js", "sub\\main.js", ".."];
    for (const entry of bad) {
      const result = parseManifest({ ...VALID, entry });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("entry 경로");
    }
    // 단순 파일명은 그대로 허용.
    expect(parseManifest({ ...VALID, entry: "main.js" }).ok).toBe(true);
  });

  // ── summary/settings/settingsCategory/settingsDescription ──────────────

  /** 가드: summary가 읽히고 검증된다 — 이전엔 Rust만 알고 TS는 몰랐다(번들 경로만
   *  타므로 번들 summary가 어느 검증기도 안 거치는 결함의 원인이었다). */
  it("reads and validates summary", () => {
    const ok = parseManifest({ ...VALID, summary: "한 줄 요약" });
    expect(ok.ok && ok.manifest.summary).toBe("한 줄 요약");
    expect(parseManifest({ ...VALID, summary: 42 }).ok).toBe(false);
  });

  /** 가드: platforms(선택) — 문자열 배열이면 그대로 실어 나르고, 미선언은 필드 자체가 없다
   *  (하위호환: 없으면 전 플랫폼 지원 — 판정은 `platform.ts`). 미지의 OS 이름은 거부하지
   *  않는다(전방 호환). Rust `parse_manifest_reads_platforms`와 짝(대칭 검증). */
  it("reads and validates platforms", () => {
    const noPlatforms = parseManifest(VALID);
    expect(noPlatforms.ok && noPlatforms.manifest.platforms).toBeUndefined();

    const withPlatforms = parseManifest({
      ...VALID,
      platforms: ["macos", "futureos"],
    });
    expect(withPlatforms.ok && withPlatforms.manifest.platforms).toEqual([
      "macos",
      "futureos",
    ]);

    expect(parseManifest({ ...VALID, platforms: "macos" }).ok).toBe(false);
    expect(parseManifest({ ...VALID, platforms: ["macos", 1] }).ok).toBe(false);
  });

  /** 가드: settings 스키마가 Rust `parse_settings_schema`와 동일 규칙으로 검증된다
   *  (key 형식·label·type enum·select의 options 필수·hints). */
  it("validates the settings schema like the Rust parser", () => {
    const ok = parseManifest({
      ...VALID,
      settings: [
        { key: "tone", label: "톤", type: "select", options: ["a", "b"] },
        { key: "showBrackets", label: "괄호", type: "toggle", default: true },
        {
          key: "hint",
          label: "힌트",
          type: "list",
          hints: [{ token: "{path}", label: "경로" }],
        },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.settings?.length).toBe(3);
      expect(ok.manifest.settings?.[0].options).toEqual(["a", "b"]);
      expect(ok.manifest.settings?.[2].hints).toEqual([
        { token: "{path}", label: "경로" },
      ]);
    }

    // settings 생략 → undefined(빈 배열이 아니라 필드 자체가 없음 — 하위호환 형태).
    const noSettings = parseManifest(VALID);
    expect(noSettings.ok && noSettings.manifest.settings).toBeUndefined();
  });

  /** 가드(보안): 예약 키(`__proto__` 등)·형식 오류 key·미지의 type·options 없는
   *  select는 매니페스트 전체를 거부한다(Rust와 동일한 실패 모드). */
  it("rejects malformed settings entries", () => {
    const cases: unknown[] = [
      [{ key: "__proto__", label: "L", type: "text" }],
      [{ key: "bad key", label: "L", type: "text" }],
      [{ key: "k", label: "L", type: "slider" }],
      [{ key: "k", label: "L", type: "select" }], // options 없음
      // button은 실행할 명령 id가 없으면 "눌러도 아무 일이 없는 버튼"이 된다.
      [{ key: "k", label: "L", type: "button" }], // command 없음
      [{ key: "k", label: "L", type: "button", command: "  " }], // 공백뿐
      [{ key: "k", label: "L", type: "button", command: 7 }], // 문자열 아님
      { not: "an array" },
    ];
    for (const settings of cases) {
      expect(parseManifest({ ...VALID, settings }).ok).toBe(false);
    }
  });

  /**
   * 가드: `button` 타입과 `command`·`confirm`이 스키마를 통과해 **소비처까지 실린다**.
   *
   * 검증기가 필드를 받아들이면서 결과 객체에서 떨어뜨리면 설정 화면은 command를 모르는
   * 버튼을 그린다 — 이 저장소가 겪은 "IPC 경계에서 값이 통째로 버려진다"와 같은 모양이라
   * 통과 여부가 아니라 **값이 실렸는지**를 본다.
   */
  it("carries button command/confirm through the settings schema ", () => {
    const parsed = parseManifest({
      ...VALID,
      settings: [
        {
          key: "clearCache",
          label: "캐시 지우기",
          type: "button",
          command: "clear-cache",
          confirm: "정말 지울까요?",
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const field = parsed.manifest.settings?.[0];
    expect(field?.type).toBe("button");
    expect(field?.command).toBe("clear-cache");
    expect(field?.confirm).toBe("정말 지울까요?");
  });

  /** 가드: settingsCategory는 카멜만 읽는다(스네이크 폴백은 제거됨 — 엄격). */
  it("reads settingsCategory (camel only, no snake fallback)", () => {
    const camel = parseManifest({ ...VALID, settingsCategory: "도구" });
    expect(camel.ok && camel.manifest.settingsCategory).toBe("도구");
    // 스네이크 키는 더 이상 읽지 않는다 — settingsCategory는 undefined.
    const snake = parseManifest({ ...VALID, settings_category: "도구" });
    expect(snake.ok && snake.manifest.settingsCategory).toBeUndefined();
  });

  // ── kind ─────────────────────────────────────────────────────────────

  /** 가드: kind는 capability|action만 허용하고, 미선언은 undefined로 남는다
   *  (능력 등록 거부 판정은 게이트키퍼가 env.kind로 한다 — 여기선 파싱만). */
  it("validates kind", () => {
    const capability = parseManifest({ ...VALID, kind: "capability" });
    expect(capability.ok && capability.manifest.kind).toBe("capability");
    expect(parseManifest({ ...VALID, kind: "widget" }).ok).toBe(false);
    const noKind = parseManifest(VALID);
    expect(noKind.ok && noKind.manifest.kind).toBeUndefined();
  });

  // ── minHostVersion ──────────────────────────────────────────────────

  /** 가드: minHostVersion은 semver 접두 형식만 허용한다(다운그레이드 판정과 같은
   *  형식 요구 — install-flow.ts의 compareVersions가 이 형식에 의존한다). */
  it("validates minHostVersion as a semver-prefixed string", () => {
    expect(parseManifest({ ...VALID, minHostVersion: "0.2.0" }).ok).toBe(true);
    expect(parseManifest({ ...VALID, minHostVersion: "v0.2.0" }).ok).toBe(
      false,
    );
    expect(parseManifest({ ...VALID, minHostVersion: "0.2" }).ok).toBe(false);
  });

  // ── purpose / llmContext ────────────────────────────────────────────

  /** 가드: purpose는 80자 이내, llmContext는 2000자 이내 — 초과는 거부. */
  it("bounds purpose and llmContext length", () => {
    expect(parseManifest({ ...VALID, purpose: "짧은 설명" }).ok).toBe(true);
    expect(parseManifest({ ...VALID, purpose: "x".repeat(81) }).ok).toBe(false);
    expect(parseManifest({ ...VALID, llmContext: "x".repeat(2000) }).ok).toBe(
      true,
    );
    expect(parseManifest({ ...VALID, llmContext: "x".repeat(2001) }).ok).toBe(
      false,
    );
  });

  // ── permissionReasons ────────────────────────────────────────────────

  /** 가드: permissionReasons는 문자열 값 맵이고 각 값은 200자 이내여야 한다. */
  it("validates permissionReasons as a bounded string map", () => {
    const ok = parseManifest({
      ...VALID,
      permissionReasons: { "notes:read": "복사할 노트를 읽기 위해 필요해요" },
    });
    expect(ok.ok).toBe(true);
    expect(
      parseManifest({
        ...VALID,
        permissionReasons: { "notes:read": 42 },
      }).ok,
    ).toBe(false);
    expect(
      parseManifest({
        ...VALID,
        permissionReasons: { "notes:read": "x".repeat(201) },
      }).ok,
    ).toBe(false);
  });
});

// ── 대칭 fixture: 이 fixture들은 src-tauri/src/plugins.rs의 동명 테스트에도 동일하게
// 존재한다(TS/Rust가 같은 매니페스트에 같은 합/불합 판정을 내리는지 고정한다.
// 두 런타임을 한 프로세스에서 실행할 수 없으므로 "같은 리터럴 fixture, 같은 기대값"으로
// 대칭을 근사한다 — 한쪽만 바뀌면 사람이 diff에서 알아챌 수 있게 나란히 둔다). ─────
describe("대칭 fixture(plugins.rs의 동명 fixture와 짝) — 이 목록이 바뀌면 Rust도 갱신", () => {
  const SYMMETRIC_VALID = {
    id: "sym",
    name: "Symmetric",
    version: "1.0.0",
    entry: "main.js",
    permissions: ["settings"],
    settings: [
      { key: "tone", label: "톤", type: "select", options: ["a", "b"] },
    ],
    kind: "action",
    minHostVersion: "0.1.0",
    purpose: "대칭 검증용 픽스처",
  };

  /** 가드: 전 필드를 채운 유효 매니페스트는 통과한다(Rust `symmetric_manifest_fixtures_*`
   *  픽스처와 동일 입력 — 같은 결과여야 한다). */
  it("accepts the full-field symmetric fixture", () => {
    expect(parseManifest(SYMMETRIC_VALID).ok).toBe(true);
  });

  /** 가드: select인데 options가 비었으면 거부(Rust 동일 fixture와 짝). */
  it("rejects the symmetric fixture when select has no options", () => {
    const bad = {
      ...SYMMETRIC_VALID,
      settings: [{ key: "tone", label: "톤", type: "select" }],
    };
    expect(parseManifest(bad).ok).toBe(false);
  });

  /**
   * 가드(단위 대칭): 길이 상한은 **코드포인트**로 잰다 — 서로게이트 페어(이모지)가 상한
   * 경계에 걸리는 fixture로 못박는다(Rust `symmetric_manifest_emoji_boundary`와 짝).
   *
   * 왜 이 fixture인가: `"가".repeat(79) + "🎨"`는 코드포인트 80(=상한)이지만 UTF-16
   * `.length`로는 81이다. TS가 `.length`를 쓰던 동안 이 매니페스트는 Rust·JSON Schema를
   * 통과해 **설치되고**, 다음 로드에서 TS 검증만 거부해 그 플러그인이 흔적 없이 사라졌다.
   */
  it("counts length limits in code points, not UTF-16 units", () => {
    const purpose = "가".repeat(79) + "🎨"; // 코드포인트 80, UTF-16 81
    expect(purpose.length).toBe(81);
    expect([...purpose].length).toBe(80);
    expect(parseManifest({ ...SYMMETRIC_VALID, purpose }).ok).toBe(true);
    // 한 자 더 넘기면(코드포인트 81) 거부한다 — 상한 자체는 그대로다.
    expect(
      parseManifest({ ...SYMMETRIC_VALID, purpose: "가" + purpose }).ok,
    ).toBe(false);

    const llmContext = "가".repeat(1999) + "🎨"; // 코드포인트 2000
    expect(parseManifest({ ...SYMMETRIC_VALID, llmContext }).ok).toBe(true);
    expect(
      parseManifest({ ...SYMMETRIC_VALID, llmContext: "가" + llmContext }).ok,
    ).toBe(false);

    const reason = "가".repeat(199) + "🎨"; // 코드포인트 200
    expect(
      parseManifest({
        ...SYMMETRIC_VALID,
        permissionReasons: { settings: reason },
      }).ok,
    ).toBe(true);
    expect(
      parseManifest({
        ...SYMMETRIC_VALID,
        permissionReasons: { settings: "가" + reason },
      }).ok,
    ).toBe(false);
  });
});

// ── 번들 매니페스트가 이제 TS 경로에서도 검증을 통과한다 ───────────────────
//
// 문제였던 것: 번들은 TS 경로만 타는데 이전 parseManifest는 settings/summary를 몰라
// 조용히 무시했다(검증하지 않았다는 뜻과 같다) — 이 테스트는 그 결함이 재발하면 실패한다.
describe("실제 번들 매니페스트가 parseManifest를 통과한다", () => {
  const roots = ["src/plugin/builtin/plugins", "src/plugin/builtin/themes"];

  /** 가드: plugins/·themes/ 아래 모든 manifest.json이 이 파일의 검증을 통과하고,
   *  마이그레이션대로 kind가 능력 등록 플러그인에는 capability, 그 외엔 action이다. */
  it("모든 번들 manifest.json이 유효하고 kind가 능력/액션을 정확히 구분한다", () => {
    const capabilityIds = new Set([
      "all-desktops",
      "always-on-top",
      "background",
      "font",
      "transparency",
      "sj_d",
      "plain",
    ]);
    let checked = 0;
    for (const root of roots) {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const dir of dirs) {
        const raw = JSON.parse(
          readFileSync(`${root}/${dir}/manifest.json`, "utf8"),
        ) as Record<string, unknown>;
        // 빌트인 면제는 없다 — 번들 매니페스트도 사이드로드와 같은 parseManifest(ID_RE 포함)를
        // 그대로 통과해야 한다. id는 원문 그대로 넘긴다(면제 특례로 바꿔치기하지 않는다).
        const result = parseManifest(raw);
        expect(result.ok, `${root}/${dir}: ${!result.ok && result.error}`).toBe(
          true,
        );
        if (!result.ok) continue;
        expect(result.manifest.kind, `${dir}의 kind가 예상과 다름`).toBe(
          capabilityIds.has(dir) ? "capability" : "action",
        );
        checked++;
      }
    }
    expect(checked, "번들 폴더 스캔 실패 의심(빈 결과)").toBeGreaterThan(0);
  });
});

// ── 빌트인 id 면제 없음 ──────────────────────────────────────────────────
//
// 예전엔 번들(1st-party) 매니페스트의 id가 ID_RE(사이드로드 파일시스템 경로 안전 규칙)를
// 지킬 필요가 없다는 특례가 있었다(`SJ_D`가 그 위반 사례). 그 면제를 없앴다 — 이제 번들도
// 사이드로드와 똑같이 parseManifest의 ID_RE 검사를 받는다. 이 가드는 그 계약을 명시적으로
// 지킨다: 다음에 누가 대문자 등 ID_RE 위반 id로 번들을 추가하면 여기서 바로 실패해야 한다
// (위 테스트도 parseManifest 전체를 통과시키므로 간접적으로 잡지만, 이 테스트는 id
// 형식만 콕 집어 이유를 분명히 한다).
describe("번들 id 면제 없음(ID_RE)", () => {
  const roots = ["src/plugin/builtin/plugins", "src/plugin/builtin/themes"];
  const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

  it("모든 번들 manifest.json의 id가 ID_RE(소문자·숫자·._-)를 지킨다", () => {
    let checked = 0;
    for (const root of roots) {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const dir of dirs) {
        const raw = JSON.parse(
          readFileSync(`${root}/${dir}/manifest.json`, "utf8"),
        ) as Record<string, unknown>;
        expect(
          typeof raw.id === "string" && ID_RE.test(raw.id),
          `${root}/${dir}: id "${String(raw.id)}"가 ID_RE를 위반함`,
        ).toBe(true);
        checked++;
      }
    }
    expect(checked, "번들 폴더 스캔 실패 의심(빈 결과)").toBeGreaterThan(0);
  });

  /** 가드(회귀): 이전의 면제 특례가 되살아나지 않는지 — 대문자 id는 parseManifest가
   *  거부해야 한다(번들이든 사이드로드든 예외 없이). */
  it("대문자 id를 가진 매니페스트는 parseManifest가 거부한다(면제 부활 방지)", () => {
    const result = parseManifest({
      id: "SJ_D",
      name: "SJ_D",
      version: "1.0.0",
      entry: "main.js",
      permissions: ["theme"],
    });
    expect(result.ok).toBe(false);
  });
});

// ── JSON Schema(정본) ↔ 이 검증기 ──────────────────────────────────────────
//
// 저작 문서는 `"$schema"` 한 줄을 넣으면 편집기가 "실시간 검증"을 해 준다고 안내한다. 그
// 안내가 참이려면 스키마가 실제 검증기와 **같은 것을 거부**해야 한다 — 스키마만 통과시키는
// 규칙이 있으면 저작자는 편집기의 초록불을 믿고 설치에서 거부당한다("선언됐지만 강제되지
// 않는다"의 또 다른 얼굴).
describe("매니페스트 JSON Schema가 검증기와 같은 것을 강제한다", () => {
  const schema = JSON.parse(
    readFileSync("docs/plugin/manifest.schema.json", "utf8"),
  ) as {
    required: string[];
    properties: Record<string, unknown>;
    $defs: {
      settingField: {
        required: string[];
        allOf?: { if?: unknown; then?: unknown }[];
        properties: Record<string, unknown>;
      };
    };
  };

  /** 가드: select에 options가 없으면 **스키마도** 거부한다(검증기와 같은 판정). */
  it("select에 options가 필요하다는 조건을 스키마가 인코딩한다", () => {
    const conditional = (schema.$defs.settingField.allOf ?? []).find(
      (c) =>
        JSON.stringify(c.if ?? {}).includes('"select"') &&
        JSON.stringify(c.then ?? {}).includes("options"),
    );
    expect(
      conditional,
      "type=select → options 필수 조건이 스키마에 없다 — 편집기는 통과시키는데 앱은 거부한다",
    ).toBeDefined();
    expect(JSON.stringify(conditional!.then)).toContain('"minItems":1');
    // 실제 검증기도 같은 매니페스트를 거부한다(두 판정이 같은지 못박는다).
    expect(
      parseManifest({
        ...VALID,
        settings: [{ key: "tone", label: "톤", type: "select" }],
      }).ok,
    ).toBe(false);
  });

  /**
   * 가드: 이 검증기가 읽는 매니페스트 필드가 전부 스키마에 선언돼 있다.
   *
   * 왜: 필드를 추가하면서 스키마 갱신을 잊으면, 편집기가 그 필드를 모르는 채(자동완성 없음)
   * 저작자는 존재를 알 길이 없다 — 스키마를 "필드 전수의 정본"이라고 문서가 단언하므로
   * 그 단언이 곧 거짓이 된다.
   */
  it("검증기가 읽는 필드가 전부 스키마 properties에 있다", () => {
    const src = readFileSync("src/plugin/manifest.ts", "utf8");
    /** 함수 본문(선언 위치부터 파일 끝까지 — 뒤에 다른 파서가 없을 때만 유효). */
    const body = (marker: string): string => {
      const at = src.indexOf(marker);
      expect(at, `함수를 찾을 수 없음: ${marker}`).toBeGreaterThan(-1);
      return src.slice(at);
    };
    /** 그 본문이 `<obj>.<키>`/`str("키")`/`num("키")`로 읽는 필드 이름 전수. */
    const fieldsRead = (source: string, obj: string): Set<string> =>
      new Set([
        ...[
          ...source.matchAll(new RegExp(`\\b${obj}\\.([A-Za-z_]\\w*)`, "g")),
        ].map((m) => m[1]),
        ...[...source.matchAll(/\b(?:str|num)\("(\w+)"\)/g)].map((m) => m[1]),
      ]);

    // (1) 매니페스트 최상위 — parseManifest는 파일의 마지막 함수라 본문 슬라이스가 안전하다.
    const top = fieldsRead(body("export function parseManifest("), "o");
    expect(top.size, "필드 추출 실패 의심(빈 결과)").toBeGreaterThan(8);
    expect(
      [...top].filter((f) => !(f in schema.properties)),
      "검증기는 읽는데 스키마에 없는 매니페스트 필드",
    ).toEqual([]);

    // (2) 설정 필드 — parseSettingsSchema는 그 위에 있으므로 parseManifest 앞까지만 본다.
    const settingsSrc = body("function parseSettingsSchema(").slice(
      0,
      body("function parseSettingsSchema(").indexOf(
        "export function parseManifest(",
      ),
    );
    const perField = fieldsRead(settingsSrc, "f");
    expect(perField.size, "설정 필드 추출 실패 의심(빈 결과)").toBeGreaterThan(
      8,
    );
    expect(
      [...perField].filter((f) => !(f in schema.$defs.settingField.properties)),
      "검증기는 읽는데 스키마에 없는 설정 필드",
    ).toEqual([]);
  });

  /** 가드: 필수 필드 목록이 검증기와 같다(하나라도 빠지면 스키마가 더 관대해진다). */
  it("필수 필드 목록이 검증기와 같다", () => {
    expect(schema.required).toEqual(["id", "name", "version", "entry"]);
    for (const field of schema.required) {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      expect(parseManifest(partial).ok, `${field} 누락이 통과함`).toBe(false);
    }
    expect(schema.$defs.settingField.required).toEqual([
      "key",
      "label",
      "type",
    ]);
  });
});

describe("contributes — 선언형 기여", () => {
  const base = {
    id: "p",
    name: "P",
    version: "1.0.0",
    entry: "main.js",
    permissions: ["editor"],
  };

  it("아는 종류를 그대로 실어 나른다", () => {
    const r = parseManifest({
      ...base,
      contributes: {
        inlinePatterns: [{ id: "hl", open: "==", close: "==" }],
        windowControls: ["transparency"],
        translations: [{ locale: "en", label: "English", entries: { a: "A" } }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contributes?.inlinePatterns).toHaveLength(1);
    expect(r.manifest.contributes?.windowControls).toEqual(["transparency"]);
    expect(r.manifest.contributes?.translations).toEqual([
      { locale: "en", label: "English", entries: { a: "A" } },
    ]);
    expect(r.manifest.contributes?.unknownKinds).toBeUndefined();
  });

  /** 전방 호환: 모르는 종류는 매니페스트를 거부하지 않되 **버려지지도 않는다**(호스트·CLI가
   * 표면화할 수 있게 이름을 남긴다) — 오타 하나가 완전한 무음 실패가 되는 것을 막는 유일한 길. */
  it("모르는 기여 종류는 거부하지 않고 unknownKinds에 모은다", () => {
    const r = parseManifest({
      ...base,
      contributes: { inlinePattern: [{ id: "x" }], statusBar: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contributes?.unknownKinds).toEqual([
      "inlinePattern",
      "statusBar",
    ]);
  });

  it("형태가 어긋나면 매니페스트를 거부한다", () => {
    expect(parseManifest({ ...base, contributes: [] }).ok).toBe(false);
    expect(
      parseManifest({ ...base, contributes: { completions: {} } }).ok,
    ).toBe(false);
    expect(
      parseManifest({ ...base, contributes: { completions: ["x"] } }).ok,
    ).toBe(false);
    expect(
      parseManifest({ ...base, contributes: { windowControls: [1] } }).ok,
    ).toBe(false);
    expect(
      parseManifest({ ...base, contributes: { translations: "x" } }).ok,
    ).toBe(false);
    expect(
      parseManifest({ ...base, contributes: { translations: ["x"] } }).ok,
    ).toBe(false);
  });

  it("contributes가 없으면 필드 자체가 없다(기존 매니페스트 무변경)", () => {
    const r = parseManifest(base);
    expect(r.ok && r.manifest.contributes).toBeUndefined();
  });
});

describe("exposes — 공개 명령 목록", () => {
  const base = {
    id: "p",
    name: "P",
    version: "1.0.0",
    entry: "main.js",
    permissions: ["commands"],
  };

  it("문자열 배열을 그대로 실어 나른다", () => {
    const r = parseManifest({ ...base, exposes: ["copy", "clear"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.exposes).toEqual(["copy", "clear"]);
  });

  it("없거나 빈 배열이면 필드 자체가 없다(기본 비공개)", () => {
    expect(parseManifest(base).ok && parseManifest(base)).toBeTruthy();
    const none = parseManifest(base);
    expect(none.ok && none.manifest.exposes).toBeUndefined();
    const empty = parseManifest({ ...base, exposes: [] });
    expect(empty.ok && empty.manifest.exposes).toBeUndefined();
  });

  it("배열이 아니거나 빈/비문자열 항목이 섞이면 거부한다", () => {
    expect(parseManifest({ ...base, exposes: "copy" }).ok).toBe(false);
    expect(parseManifest({ ...base, exposes: [1] }).ok).toBe(false);
    expect(parseManifest({ ...base, exposes: [""] }).ok).toBe(false);
    expect(parseManifest({ ...base, exposes: ["ok", null] }).ok).toBe(false);
  });
});

describe("nls — 저작자 자기 로컬라이즈(축 2)", () => {
  const base = {
    id: "p",
    name: "P",
    version: "1.0.0",
    entry: "main.js",
  };

  it("없으면 필드 자체가 없다(하위호환 — nls 없는 기존 매니페스트 무변화)", () => {
    const r = parseManifest(base);
    expect(r.ok && r.manifest.nls).toBeUndefined();
  });

  it("있고 'default' 사전을 포함하면 원문 그대로 실린다(해석은 파싱 책임 밖)", () => {
    const r = parseManifest({
      ...base,
      name: "%p.name%",
      nls: {
        default: { "p.name": "기본 이름" },
        en: { "p.name": "English Name" },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // parseManifest는 해석하지 않는다 — %키%는 원문 그대로 남는다.
    expect(r.manifest.name).toBe("%p.name%");
    expect(r.manifest.nls).toEqual({
      default: { "p.name": "기본 이름" },
      en: { "p.name": "English Name" },
    });
  });

  it("'default' 사전이 없으면 거부한다(%키%가 기댈 곳이 없어 항상 원문으로 샌다)", () => {
    const r = parseManifest({
      ...base,
      nls: { en: { "p.name": "English Name" } },
    });
    expect(r.ok).toBe(false);
  });

  it("객체가 아니거나, 로케일 값이 객체가 아니거나, leaf가 문자열이 아니면 거부한다", () => {
    expect(parseManifest({ ...base, nls: ["a"] }).ok).toBe(false);
    expect(parseManifest({ ...base, nls: "오류" }).ok).toBe(false);
    expect(parseManifest({ ...base, nls: { default: "오류" } }).ok).toBe(false);
    expect(parseManifest({ ...base, nls: { default: { k: 1 } } }).ok).toBe(
      false,
    );
  });
});

describe("resolveNlsString — %키% 해석(축 2)", () => {
  const nls = {
    default: { greeting: "기본 인사", shared: "기본 공유" },
    en: { greeting: "Hello" },
  };

  it("%로 감싼 키를 활성 로케일 사전에서 찾는다", () => {
    expect(resolveNlsString("%greeting%", nls, "en")).toBe("Hello");
  });

  it("활성 로케일에 없으면 default로 폴백한다", () => {
    expect(resolveNlsString("%shared%", nls, "en")).toBe("기본 공유");
  });

  it("어느 사전에도 없으면 %키%를 원문 그대로 노출한다(누락 가시화)", () => {
    expect(resolveNlsString("%missing%", nls, "en")).toBe("%missing%");
  });

  it("%로 감싸지 않은 일반 문자열은 그대로(하위호환)", () => {
    expect(resolveNlsString("그냥 문자열", nls, "en")).toBe("그냥 문자열");
    expect(resolveNlsString("%half", nls, "en")).toBe("%half");
  });

  it("nls 자체가 없으면 %로 감싼 문자열이라도 절대 건드리지 않는다", () => {
    expect(resolveNlsString("%greeting%", undefined, "en")).toBe("%greeting%");
  });

  it("activeLocale이 default와 같아도 정상 동작한다(활성=default 우선)", () => {
    expect(resolveNlsString("%greeting%", nls, "default")).toBe("기본 인사");
  });
});

describe("resolveInstalledPluginNls — InstalledPlugin 파싱 직후 해석(축 2)", () => {
  const settingsField = (
    over: Partial<PluginSettingField> = {},
  ): PluginSettingField => ({
    key: "k",
    label: "%field.label%",
    type: "text",
    options: [],
    ...over,
  });

  const plugin = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
    id: "p",
    name: "%p.name%",
    version: "1.0.0",
    permissions: [],
    enabled: true,
    granted: [],
    settings_schema: [settingsField()],
    settings: {},
    nls: {
      default: {
        "p.name": "기본 이름",
        "field.label": "기본 라벨",
        "field.desc": "기본 설명",
        "opt.label": "기본 옵션",
      },
      en: { "p.name": "English Name", "field.label": "English Label" },
    },
    ...over,
  });

  it("nls가 없으면 입력을 그대로(참조까지) 돌려준다", () => {
    const p = plugin({ nls: undefined });
    expect(resolveInstalledPluginNls(p, "en")).toBe(p);
  });

  it("name·settings_schema[].label을 활성 로케일 → default 순으로 해석한다", () => {
    const p = plugin();
    const en = resolveInstalledPluginNls(p, "en");
    expect(en.name).toBe("English Name");
    expect(en.settings_schema[0]?.label).toBe("English Label");

    // en 사전에 없는 필드는 default로 폴백.
    const fr = resolveInstalledPluginNls(p, "fr");
    expect(fr.name).toBe("기본 이름");
    expect(fr.settings_schema[0]?.label).toBe("기본 라벨");
  });

  it("summary·settings_category·settings_description도 해석 대상이다", () => {
    const p = plugin({
      summary: "%p.name%",
      settings_category: "%p.name%",
      settings_description: "%p.name%",
    });
    const en = resolveInstalledPluginNls(p, "en");
    expect(en.summary).toBe("English Name");
    expect(en.settings_category).toBe("English Name");
    expect(en.settings_description).toBe("English Name");
  });

  it("description·placeholder·itemLabel·confirm·hints[].label을 해석한다", () => {
    const p = plugin({
      settings_schema: [
        settingsField({
          description: "%field.desc%",
          placeholder: "%field.desc%",
          itemLabel: "%field.desc%",
          confirm: "%field.desc%",
          hints: [{ token: "x", label: "%field.desc%" }],
        }),
      ],
    });
    const en = resolveInstalledPluginNls(p, "en"); // en에 field.desc 없음 → default 폴백.
    const f = en.settings_schema[0]!;
    expect(f.description).toBe("기본 설명");
    expect(f.placeholder).toBe("기본 설명");
    expect(f.itemLabel).toBe("기본 설명");
    expect(f.confirm).toBe("기본 설명");
    expect(f.hints?.[0]?.label).toBe("기본 설명");
  });

  it("options의 객체형(label/description)은 해석하지만 value는 절대 건드리지 않는다", () => {
    const p = plugin({
      settings_schema: [
        settingsField({
          type: "select",
          options: [
            { value: "opt1", label: "%opt.label%", description: "%opt.label%" },
          ],
        }),
      ],
    });
    const en = resolveInstalledPluginNls(p, "en"); // en에 opt.label 없음 → default.
    const opt = en.settings_schema[0]!.options?.[0];
    expect(opt).toMatchObject({
      value: "opt1", // 저장 값 정체성 — 절대 로케일에 물들지 않는다.
      label: "기본 옵션",
      description: "기본 옵션",
    });
  });

  it("options의 문자열 축약형은 해석 대상이 아니다(value=label이라 손대면 저장 값이 깨진다)", () => {
    const p = plugin({
      settings_schema: [
        settingsField({
          type: "select",
          options: ["%opt.label%"],
        }),
      ],
    });
    const en = resolveInstalledPluginNls(p, "en");
    // 축약형은 원문 그대로 — 로케일과 무관하게 항상 같은 값(저장 값이 안전하다).
    expect(en.settings_schema[0]!.options?.[0]).toBe("%opt.label%");
  });
});
