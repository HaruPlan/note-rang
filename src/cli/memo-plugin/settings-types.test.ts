/**
 * settings-types.ts 단위 테스트 — `PluginSettingField[]` → `settings.d.ts` 텍스트 유도가
 * 어휘 7종(text/textarea/toggle/select/list/number/button) 전수를 계약대로 매핑하는지
 * 확인한다. host.ts `settings.get`의 정규화 규칙(api-index.ts 690행 부근)과 1:1이어야 한다:
 * list→`{name,body}[]`, select→**value** 리터럴 유니온(라벨이 아니다), number→number,
 * toggle→boolean, text/textarea→string, button→값 없음(제외).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginSettingField } from "../../shared/tauri";
import {
  generateSettingsDts,
  hasTypedSettingsFields,
  SETTINGS_USAGE_SNIPPET,
} from "./settings-types";

function field(overrides: Partial<PluginSettingField>): PluginSettingField {
  return {
    key: "k",
    label: "라벨",
    type: "text",
    options: [],
    ...overrides,
  } as PluginSettingField;
}

describe("hasTypedSettingsFields", () => {
  it("빈 배열은 false", () => {
    expect(hasTypedSettingsFields([])).toBe(false);
  });

  it("button만 있으면 false(값을 저장하지 않는다)", () => {
    expect(
      hasTypedSettingsFields([field({ type: "button", command: "x" })]),
    ).toBe(false);
  });

  it("text가 하나라도 있으면 true", () => {
    expect(
      hasTypedSettingsFields([
        field({ type: "button", command: "x" }),
        field({ key: "t", type: "text" }),
      ]),
    ).toBe(true);
  });
});

describe("generateSettingsDts — 타입 매핑(7종)", () => {
  it("text/textarea → string", () => {
    const dts = generateSettingsDts([
      field({ key: "a", type: "text" }),
      field({ key: "b", type: "textarea" }),
    ]);
    expect(dts).toContain("a: string;");
    expect(dts).toContain("b: string;");
  });

  it("toggle → boolean", () => {
    const dts = generateSettingsDts([field({ key: "on", type: "toggle" })]);
    expect(dts).toContain("on: boolean;");
  });

  it("number → number", () => {
    const dts = generateSettingsDts([field({ key: "n", type: "number" })]);
    expect(dts).toContain("n: number;");
  });

  it("list → { name: string; body: string }[]", () => {
    const dts = generateSettingsDts([field({ key: "items", type: "list" })]);
    expect(dts).toContain("items: { name: string; body: string }[];");
  });

  it("select → value 리터럴 유니온(라벨이 아니다)", () => {
    const dts = generateSettingsDts([
      field({
        key: "mode",
        type: "select",
        options: [
          { value: "a", label: "에이" },
          { value: "b", label: "비" },
        ],
      }),
    ]);
    expect(dts).toContain('mode: "a" | "b";');
    expect(dts).not.toContain("에이");
  });

  it("select 문자열 축약형 옵션도 value로 취급한다(재해석 규칙)", () => {
    const dts = generateSettingsDts([
      field({ key: "mode", type: "select", options: ["x", "y"] }),
    ]);
    expect(dts).toContain('mode: "x" | "y";');
  });

  it("select에 options가 없으면(비정상 매니페스트라도) string으로 폴백한다", () => {
    const dts = generateSettingsDts([
      field({ key: "mode", type: "select", options: [] }),
    ]);
    expect(dts).toContain("mode: string;");
  });

  it("button은 인터페이스에서 완전히 빠진다", () => {
    const dts = generateSettingsDts([
      field({ key: "text", type: "text" }),
      field({ key: "act", type: "button", command: "cmd" }),
    ]);
    expect(dts).toContain("text: string;");
    expect(dts).not.toContain("act");
  });
});

describe("generateSettingsDts — 안전성·문서 코멘트", () => {
  it("라벨에 코멘트 닫힘 기호(별표+슬래시)가 섞이면 이스케이프해 코멘트를 조기 종료시키지 않는다", () => {
    const dts = generateSettingsDts([
      field({
        key: "x",
        label: "이상한 라벨 */ 여기부터 코드처럼 보이면 안 됨",
      }),
    ]);
    // 원문 그대로의 "*/"가 doc 코멘트 본문 안에 살아남으면 그 자리에서 JSDoc이 끊기고
    // 뒤 텍스트가 코드로 해석된다 — 이스케이프된 형태("*\/")만 있어야 한다.
    expect(dts).not.toContain("이상한 라벨 */ 여기부터");
    expect(dts).toContain("이상한 라벨 *\\/ 여기부터");
  });

  it("설명은 라벨 뒤에 붙는다", () => {
    const dts = generateSettingsDts([
      field({ key: "x", label: "라벨", description: "설명입니다" }),
    ]);
    expect(dts).toMatch(/\/\*\* 라벨 — 설명입니다 \*\//);
  });

  it("number의 min/max는 범위로 doc에 실린다", () => {
    const dts = generateSettingsDts([
      field({ key: "n", type: "number", min: 1, max: 10 }),
    ]);
    expect(dts).toContain("(1~10)");
  });

  it("PluginSettingKey는 필드 키의 닫힌 유니온을 keyof로 낸다", () => {
    const dts = generateSettingsDts([
      field({ key: "a" }),
      field({ key: "b", type: "toggle" }),
    ]);
    expect(dts).toContain(
      "export type PluginSettingKey = keyof PluginSettings;",
    );
  });

  it("생성물은 module(export가 있다) — 앰비언트 전역과 충돌하지 않는다", () => {
    const dts = generateSettingsDts([field({ key: "a" })]);
    expect(dts).toContain("export interface PluginSettings");
  });
});

/**
 * 자기검증(회귀 방지) — 생성된 `settings.d.ts` 헤더가 저작자에게 베끼라고 싣는
 * 참조 스니펫(`SETTINGS_USAGE_SNIPPET`)이 **실제 계약 `.d.ts`와 함께 checkJs로 컴파일된다**.
 *
 * 왜: getAll()이 `Record<string, unknown>`을 돌려주므로 대입·단일 캐스트는 TS2739/TS2352로
 * 실패한다 — 헤더 예시가 컴파일 에러를 내면 저작자는 주석을 지우고 좁히기(오타 검출)를 잃는다.
 * 이 테스트는 그 예시가 (a) 오류 없이 컴파일되고 (b) 실제로 좁혀져 오타를 잡는지 둘 다 못박아,
 * "생성물이 자기 사용례에서 고장 나는" 재발을 막는다(scaffold가 lint로 자기검증하듯).
 */
describe("SETTINGS_USAGE_SNIPPET 자기검증(생성 헤더 예시가 실제로 컴파일된다)", () => {
  const ts = createRequire(import.meta.url)(
    "typescript",
  ) as typeof import("typescript");
  const API_DTS = path.resolve("docs/plugin/api-reference.d.ts");

  /** greeting(text) + style(select)로 settings.d.ts를 낸 뒤, 준 main.js 본문과 함께 컴파일한다. */
  function compileSnippet(mainBody: string): string[] {
    const dts = generateSettingsDts([
      { key: "greeting", label: "인사말", type: "text" } as PluginSettingField,
      {
        key: "style",
        label: "말투",
        type: "select",
        options: [{ value: "formal" }, { value: "casual" }],
      } as PluginSettingField,
    ]);
    const dir = mkdtempSync(path.join(tmpdir(), "memo-settings-dts-"));
    try {
      writeFileSync(path.join(dir, "settings.d.ts"), dts);
      writeFileSync(
        path.join(dir, "main.js"),
        `/* global memo */\n${mainBody}`,
      );
      const program = ts.createProgram([API_DTS, path.join(dir, "main.js")], {
        noEmit: true,
        strict: true,
        allowJs: true,
        checkJs: true,
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

  it("헤더가 싣는 스니펫 그대로가 오류 없이 컴파일된다", () => {
    // 스니펫이 var s를 선언만 하므로, 좁혀진 뒤 실제로 키를 읽어 계약을 확인한다.
    const body = `${SETTINGS_USAGE_SNIPPET.replace(
      "});",
      '  console.log(s.greeting, s.style === "casual");\n});',
    )}`;
    expect(compileSnippet(body)).toEqual([]);
  });

  it("좁혀진 뒤 키 오타·select 리터럴 오타를 tsc가 잡는다(얻으려던 것)", () => {
    const body = `${SETTINGS_USAGE_SNIPPET.replace(
      "});",
      '  console.log(s.greetng, s.style === "casaul");\n});',
    )}`;
    const errors = compileSnippet(body);
    expect(errors.some((e) => e.includes("greetng"))).toBe(true);
    expect(errors.some((e) => e.includes("casaul"))).toBe(true);
  });
});
