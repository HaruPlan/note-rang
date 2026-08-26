/**
 * 플러그인 설정 경계 규칙 테스트 — 기본값 병합·구조화 변환·마이그레이션을 고정한다.
 *
 * 특히 **마이그레이션**을 집중적으로 못박는다: 이미 디스크에 저장된 값(list 블롭 문자열,
 * select의 옛 "저장값=라벨")이 새 계약에서도 살아남아야 한다 — 사용자가 만든 템플릿이
 * 사라지면 그건 데이터 손실이다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { PluginSettingField } from "./tauri";
import {
  fromPluginSettingValue,
  mergeSettingDefaults,
  normalizeSettingValue,
  parseListBlob,
  sanitizeListName,
  serializeListBlob,
  settingDefault,
  settingOptions,
  toPluginSettingValue,
} from "./plugin-settings";

/** 스키마 필드 하나를 짧게 만든다(테스트 가독성). */
const field = (over: Partial<PluginSettingField>): PluginSettingField => ({
  key: "k",
  label: "L",
  type: "text",
  options: [],
  ...over,
});

describe("settingOptions — string[] 축약형과 객체형", () => {
  /** 가드: 문자열 축약형은 `{value: s, label: s}`로 재해석된다(기존 매니페스트 무변경). */
  it("expands string shorthand to value=label", () => {
    expect(settingOptions({ options: ["a", "b"] })).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  /** 가드: 객체형은 value/label/description을 그대로 쓰고, label이 없으면 value로 채운다. */
  it("keeps value/label/description and falls back label to value", () => {
    expect(
      settingOptions({
        options: [
          { value: "cursor", label: "커서 위치", description: "지금 자리" },
          { value: "append" },
        ],
      }),
    ).toEqual([
      { value: "cursor", label: "커서 위치", description: "지금 자리" },
      { value: "append", label: "append" },
    ]);
  });
});

describe("list 블롭 ↔ 항목 배열", () => {
  /** 가드: 왕복(parse→serialize→parse)이 안정적이다. */
  it("round-trips", () => {
    const items = [
      { name: "A", body: "본문A\n둘째" },
      { name: "B", body: "본문B" },
    ];
    expect(parseListBlob(serializeListBlob(items))).toEqual(items);
  });

  /** 가드(마이그레이션): 헤더 없는 옛 블롭은 통째로 한 항목이 된다(내용을 잃지 않는다). */
  it("treats a header-less blob as a single item", () => {
    expect(parseListBlob("그냥 본문\n둘째 줄")).toEqual([
      { name: "템플릿", body: "그냥 본문\n둘째 줄" },
    ]);
  });

  /** 가드: 이름의 `=`는 호스트가 지운다(헤더 문법 충돌 방어는 플러그인 몫이 아니다). */
  it("strips '=' from names on serialize", () => {
    expect(serializeListBlob([{ name: "a=b=c", body: "x" }])).toBe(
      "=== abc ===\nx",
    );
    expect(sanitizeListName("   ")).toBe("템플릿");
  });

  /** 가드: 빈/비문자 입력은 빈 목록(플러그인이 방어 코드를 쓸 필요가 없다). */
  it("returns an empty list for empty or non-string input", () => {
    expect(parseListBlob("")).toEqual([]);
    expect(parseListBlob(null)).toEqual([]);
    expect(parseListBlob(42)).toEqual([]);
  });
});

describe("settingDefault / normalizeSettingValue", () => {
  /** 가드: 타입별 기본값(선언 default가 있으면 그것을 정규화해서). */
  it("derives defaults per type", () => {
    expect(settingDefault(field({ type: "toggle" }))).toBe(false);
    expect(settingDefault(field({ type: "text" }))).toBe("");
    expect(settingDefault(field({ type: "list" }))).toBe("");
    expect(settingDefault(field({ type: "number", min: 5 }))).toBe(5);
    expect(settingDefault(field({ type: "number" }))).toBe(0);
    expect(
      settingDefault(
        field({ type: "select", options: [{ value: "a", label: "가" }, "b"] }),
      ),
    ).toBe("a");
    // default 선언은 정규화를 거친다(예: number에 문자열을 적어도 수로 온다).
    expect(settingDefault(field({ type: "number", default: "12" }))).toBe(12);
  });

  /** 가드(엄격): select는 저장된 값을 **그대로** 둔다 — 라벨→값 마이그레이션은 제거됐다.
   *  옵션 밖 값이라도 버리지 않고 그대로 둔다(사용자 선택을 임의로 폐기하지 않음 — 데이터 보호). */
  it("keeps a stored select value as-is (no label migration)", () => {
    const f = field({
      type: "select",
      options: [
        { value: "cursor", label: "커서 위치" },
        { value: "append", label: "문서 끝에 추가" },
      ],
    });
    expect(normalizeSettingValue(f, "cursor")).toBe("cursor"); // 값이면 그대로
    expect(normalizeSettingValue(f, "append")).toBe("append");
    // 라벨은 더 이상 값으로 되돌리지 않는다(마이그레이션 제거) — 문자열 그대로.
    expect(normalizeSettingValue(f, "커서 위치")).toBe("커서 위치");
    // 옵션 밖 값도 버리지 않고 그대로 둔다(데이터 보호).
    expect(normalizeSettingValue(f, "옛날값")).toBe("옛날값");
  });

  /** 가드: number는 언제나 유한수 + min/max 클램프(플러그인이 NaN을 받지 않는다). */
  it("coerces and clamps numbers", () => {
    const f = field({ type: "number", min: 5, max: 50, default: 10 });
    expect(normalizeSettingValue(f, "20")).toBe(20);
    expect(normalizeSettingValue(f, 1)).toBe(5);
    expect(normalizeSettingValue(f, 999)).toBe(50);
    expect(normalizeSettingValue(f, "숫자아님")).toBe(10); // default로 복귀
  });

  /** 가드: toggle은 엄격 boolean, list는 언제나 저장 블롭 문자열로 굳는다. */
  it("normalizes toggle and list to their storage shapes", () => {
    expect(normalizeSettingValue(field({ type: "toggle" }), "true")).toBe(
      false,
    );
    expect(normalizeSettingValue(field({ type: "toggle" }), true)).toBe(true);
    expect(
      normalizeSettingValue(field({ type: "list" }), [
        { name: "A", body: "x" },
      ]),
    ).toBe("=== A ===\nx");
  });
});

describe("mergeSettingDefaults", () => {
  const schema = [
    field({ key: "tone", type: "text", default: "soft" }),
    field({ key: "on", type: "toggle", default: true }),
    field({ key: "n", type: "number", default: 3 }),
  ];

  /** 가드: 저장된 값이 없어도 매니페스트 default가 실제로 도달한다(번들 경로의 결함). */
  it("fills declared keys from manifest defaults", () => {
    expect(mergeSettingDefaults(schema, {})).toEqual({
      tone: "soft",
      on: true,
      n: 3,
    });
    expect(mergeSettingDefaults(schema, null).tone).toBe("soft");
  });

  /** 가드: 저장된 값이 이기되 정규화를 거친다. */
  it("keeps saved values but normalizes them", () => {
    expect(mergeSettingDefaults(schema, { tone: "loud", n: "7" })).toEqual({
      tone: "loud",
      on: true,
      n: 7,
    });
  });

  /** 가드(데이터 보존): 스키마에 없는 저장 키는 **버리지 않는다** — 번들 경로는 백엔드가 키
   * 형식만 검사하므로, 여기서 좁히면 매니페스트에 아직 안 올라온 값을 소리 없이 잃는다. */
  it("preserves saved keys that are not declared", () => {
    expect(mergeSettingDefaults(schema, { legacy: "값" }).legacy).toBe("값");
  });

  /**
   * 가드: `button` 필드는 **값을 만들지 않는다**(Rust `resolve_settings`와 같은 규칙).
   *
   * 여기서 빈 문자열을 채우면 (a) 아무도 안 읽는 키가 상태 파일에 쌓이고 (b)
   * `settings.get({ key: "clearCache" })`가 null이 아니라 ""를 돌려줘 저작자가 "값이 있는 설정"으로
   * 착각한다. 저장된 키가 있어도 마찬가지다 — 스키마가 button이면 값이 아니다.
   */
  it("never materializes a value for a button field", () => {
    const withButton = [
      ...schema,
      field({ key: "clearCache", type: "button", command: "clear-cache" }),
    ];
    expect(mergeSettingDefaults(withButton, {})).not.toHaveProperty(
      "clearCache",
    );
    // 옛 저장 값이 남아 있어도 병합 결과가 만들어 내지는 않는다(그 값은 미선언 키로 보존된다).
    expect(mergeSettingDefaults(withButton, { clearCache: "쓰레기" })).toEqual({
      tone: "soft",
      on: true,
      n: 3,
      clearCache: "쓰레기",
    });
  });

  /** 가드(보안): `__proto__` 키는 병합 결과로 새지 않는다(프로토타입 오염 방어 심층화). */
  it("never carries a __proto__ key through", () => {
    const merged = mergeSettingDefaults(
      schema,
      JSON.parse('{"__proto__":{"polluted":1},"tone":"x"}') as Record<
        string,
        unknown
      >,
    );
    expect(Object.keys(merged)).not.toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("경계 변환 — 플러그인이 보는 값 ↔ 저장 값", () => {
  const list = field({ key: "templates", type: "list" });

  /** 가드: list는 언제나 배열로 나간다(저장 블롭 그대로 받는 raw 탈출구는 제거됨 — 엄격). */
  it("hands list settings to plugins as an array", () => {
    const blob = "=== A ===\naaa\n\n=== B ===\nbbb";
    expect(toPluginSettingValue(list, blob)).toEqual([
      { name: "A", body: "aaa" },
      { name: "B", body: "bbb" },
    ]);
  });

  /** 가드: list가 아닌 타입·스키마에 없는 키는 변환하지 않는다. */
  it("passes through non-list and unknown keys", () => {
    expect(toPluginSettingValue(field({ type: "text" }), "x")).toBe("x");
    expect(toPluginSettingValue(undefined, "x")).toBe("x");
  });

  /** 가드: 플러그인이 배열을 주면 호스트가 직렬화하고, 문자열을 주면 블롭 그대로 받는다. */
  it("serializes arrays back to the storage blob and accepts raw strings", () => {
    expect(fromPluginSettingValue(list, [{ name: "A", body: "x" }])).toBe(
      "=== A ===\nx",
    );
    expect(fromPluginSettingValue(list, "=== A ===\nx")).toBe("=== A ===\nx");
    // 항목 모양이 아닌 원소는 버린다(쓰레기가 디스크에 남지 않게).
    expect(fromPluginSettingValue(list, [1, null, { name: "A" }])).toBe(
      "=== A ===\n",
    );
  });
});

describe("드리프트 가드 — Rust plugins.rs와 같은 규칙", () => {
  const rust = readFileSync("src-tauri/src/plugins.rs", "utf8");
  const manifestTs = readFileSync("src/plugin/manifest.ts", "utf8");

  /** Rust `parse_settings_schema`의 `matches!(kind.as_str(), ...)`에서 허용 타입을 뽑는다. */
  const rustTypes = (): string[] => {
    const m = /matches!\(\s*kind\.as_str\(\),([\s\S]*?)\)\s*\{/.exec(rust);
    if (!m) throw new Error("plugins.rs의 허용 타입 matches!를 찾지 못함");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };

  /** 가드: 허용 위젯 타입 집합이 Rust · TS 매니페스트 검증기에서 같다(비대칭 재발 방지). */
  it("accepts the same widget types on both sides", () => {
    const ts = /const VALID_SETTING_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(
      manifestTs,
    );
    if (!ts) throw new Error("manifest.ts의 VALID_SETTING_TYPES를 찾지 못함");
    const tsTypes = [...ts[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(tsTypes)).toEqual(new Set(rustTypes()));
    expect(new Set(tsTypes)).toContain("number"); // 나중에 추가된 타입
  });

  /** 가드: 모든 허용 타입에 대해 TS `settingDefault`가 값을 준다(새 타입을 Rust에만 추가하고
   * 프론트 기본값 규칙을 빼먹으면 여기서 걸린다 — 그 경우 플러그인이 undefined를 받는다). */
  it("derives a default for every accepted widget type", () => {
    for (const type of rustTypes()) {
      const f = field({
        type: type as PluginSettingField["type"],
        options: ["a"],
      });
      expect(settingDefault(f), type).toBeDefined();
    }
  });

  /** 가드: select 기본값이 양쪽 모두 "첫 선택지의 **value**"다(라벨이 아니다). */
  it("defaults a select to the first option value on both sides", () => {
    expect(rust).toContain(".map(|o| o.value().to_string())");
    expect(
      settingDefault(
        field({ type: "select", options: [{ value: "v1", label: "라벨" }] }),
      ),
    ).toBe("v1");
  });
});
