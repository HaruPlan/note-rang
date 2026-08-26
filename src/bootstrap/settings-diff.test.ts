/**
 * 공유 설정 diff(`settings-diff.ts`)의 판정 규칙 가드.
 *
 * 이 판정이 곧 "창을 리로드할 것이냐 말 것이냐"의 분기점이다 — 너무 관대하면(변경을 놓치면)
 * 사용자가 바꾼 값이 열린 창에 반영되지 않고, 너무 엄격하면(멀쩡한 값을 바뀜으로 보면)
 * 없애려던 전체 리로드가 그대로 돌아온다. 그래서 키별 판정과 화이트리스트를 못박는다.
 */
import { describe, expect, it } from "vitest";
import {
  diffSettingsKeys,
  isLocalOnlyChange,
  LOCAL_APPLY_KEYS,
  type DiffableSettings,
} from "./settings-diff";
import type { ToolbarLayout } from "../note/toolbar-layout";

/** 최소 설정 스냅샷 — 테스트가 관심 있는 키만 덮어쓴다. */
function base(overrides: Partial<DiffableSettings> = {}): DiffableSettings {
  return {
    schema_version: 1,
    theme: "sj-d",
    defaults: { font_size: 14 },
    ...overrides,
  } as DiffableSettings;
}

/** 상/하 바가 있는 최소 배치(존 내용만 바꿔 가며 쓴다). */
function layout(top: string[], seen: string[]): ToolbarLayout {
  return {
    top: { align: "left", zones: [top] },
    bottom: { align: "left", zones: [[]] },
    seen,
  };
}

describe("diffSettingsKeys", () => {
  /** 가드: 완전히 같은 스냅샷이면 빈 배열 — 호출부가 아무 이벤트도 내지 않는 근거다. */
  it("returns an empty list when nothing changed", () => {
    expect(diffSettingsKeys(base(), base())).toEqual([]);
  });

  /** 가드: 원시 키는 값이 다르면 그 키 하나만 잡힌다. */
  it("detects primitive top-level changes", () => {
    expect(diffSettingsKeys(base(), base({ theme: "sj-l" }))).toEqual([
      "theme",
    ]);
    expect(diffSettingsKeys(base(), base({ language: "en" }))).toEqual([
      "language",
    ]);
    expect(diffSettingsKeys(base(), base({ schema_version: 2 }))).toEqual([
      "schema_version",
    ]);
    expect(diffSettingsKeys(base(), base({ toolbar_style: "mac" }))).toEqual([
      "toolbar_style",
    ]);
  });

  /** 가드: 한쪽에만 있는 키는 변경, 양쪽 모두 없는 키는 애초에 등장하지 않는다. */
  it("treats a key present on only one side as changed", () => {
    expect(diffSettingsKeys(base(), base({ language: "ko" }))).toEqual([
      "language",
    ]);
    expect(diffSettingsKeys(base({ language: "ko" }), base())).toEqual([
      "language",
    ]);
    expect(diffSettingsKeys(base(), base())).not.toContain("keybindings");
  });

  /** 가드(핵심): 중첩 객체는 키 순서가 아니라 내용으로 비교한다 — 순서 차이로 리로드가 돌면 안 된다. */
  it("compares nested objects by content, not key order", () => {
    const a = base({
      theme_overrides: { "sj-d": { accent: "#111", text: "#222" } },
    });
    const b = base({
      theme_overrides: { "sj-d": { text: "#222", accent: "#111" } },
    });
    expect(diffSettingsKeys(a, b)).toEqual([]);
    const c = base({
      theme_overrides: { "sj-d": { accent: "#333", text: "#222" } },
    });
    expect(diffSettingsKeys(a, c)).toEqual(["theme_overrides"]);
  });

  /** 가드: keybindings도 같은 규칙(키 순서 무관, 값이 바뀌어야 변경). */
  it("compares keybindings by content", () => {
    const a = base({
      keybindings: { "font.up": "Alt+=", "font.down": "Alt+-" },
    });
    const b = base({
      keybindings: { "font.down": "Alt+-", "font.up": "Alt+=" },
    });
    expect(diffSettingsKeys(a, b)).toEqual([]);
    const c = base({
      keybindings: { "font.up": "Alt+]", "font.down": "Alt+-" },
    });
    expect(diffSettingsKeys(a, c)).toEqual(["keybindings"]);
  });

  /** 가드(핵심): 배치는 `sameLayout`이 정본 — `seen` 순서가 달라도 같은 배치다. */
  it("uses the layout model comparison (seen order does not matter)", () => {
    const a = base({
      toolbar_layout: layout(["core:pin"], ["core:pin", "core:fold"]),
    });
    const b = base({
      toolbar_layout: layout(["core:pin"], ["core:fold", "core:pin"]),
    });
    expect(diffSettingsKeys(a, b)).toEqual([]);
    const c = base({
      toolbar_layout: layout(["core:fold"], ["core:pin", "core:fold"]),
    });
    expect(diffSettingsKeys(a, c)).toEqual(["toolbar_layout"]);
  });

  /** 가드: 배치가 한쪽에만 있으면(구버전 → 커스터마이즈) 변경이다. */
  it("flags toolbar_layout when present on only one side", () => {
    const a = base();
    const b = base({ toolbar_layout: layout([], []) });
    expect(diffSettingsKeys(a, b)).toEqual(["toolbar_layout"]);
  });

  /** 가드(핵심): defaults는 서브키 단위로 쪼개진다 — 글자 크기만 바꿔도 통째로 잡히면 안 된다. */
  it("splits defaults into dotted sub-keys", () => {
    const a = base({ defaults: { font_size: 14, font_family: "Serif" } });
    const b = base({ defaults: { font_size: 18, font_family: "Serif" } });
    expect(diffSettingsKeys(a, b)).toEqual(["defaults.font_size"]);
    const c = base({ defaults: { font_size: 14, font_family: "Mono" } });
    expect(diffSettingsKeys(a, c)).toEqual(["defaults.font_family"]);
    const d = base({ defaults: { font_size: 18, font_family: "Mono" } });
    expect(diffSettingsKeys(a, d)).toEqual([
      "defaults.font_family",
      "defaults.font_size",
    ]);
  });

  /** 가드: defaults에 서브키가 한쪽에만 있어도 그 서브키의 변경으로 잡힌다. */
  it("flags a defaults sub-key present on only one side", () => {
    const a = base({ defaults: { font_size: 14 } });
    const b = base({ defaults: { font_size: 14, line_height: 1.6 } });
    expect(diffSettingsKeys(a, b)).toEqual(["defaults.line_height"]);
  });

  /** 가드: defaults가 객체가 아니면(구버전·null) 쪼개지 않고 통째로 변경 — 모르면 무거운 쪽. */
  it("falls back to a whole-defaults change when either side is not an object", () => {
    expect(diffSettingsKeys(base({ defaults: null }), base())).toEqual([
      "defaults",
    ]);
    expect(
      diffSettingsKeys(base({ defaults: 3 }), base({ defaults: 4 })),
    ).toEqual(["defaults"]);
    expect(
      diffSettingsKeys(base({ defaults: null }), base({ defaults: null })),
    ).toEqual([]);
  });

  /** 가드: 이 모듈이 모르는 새 키도 자동으로 잡힌다(고정 필드 목록을 박아 두지 않는 이유). */
  it("detects keys it has no special knowledge of", () => {
    const a = base();
    const b = { ...base(), some_future_key: true } as DiffableSettings;
    expect(diffSettingsKeys(a, b)).toEqual(["some_future_key"]);
  });
});

describe("isLocalOnlyChange", () => {
  /** 가드: 화이트리스트 안의 키만 있으면 국소 반영 가능. */
  it("accepts changes made only of whitelisted keys", () => {
    expect(isLocalOnlyChange(["theme_overrides"])).toBe(true);
    expect(isLocalOnlyChange(["defaults.font_size", "toolbar_style"])).toBe(
      true,
    );
    expect(isLocalOnlyChange(["defaults.font_family"])).toBe(true);
    expect(isLocalOnlyChange([...LOCAL_APPLY_KEYS])).toBe(true);
  });

  /** 가드(핵심): 화이트리스트 밖 키가 하나라도 섞이면 false — 블랙리스트가 아니라는 증거. */
  it("rejects any change that includes a non-whitelisted key", () => {
    expect(isLocalOnlyChange(["theme"])).toBe(false);
    expect(isLocalOnlyChange(["theme_overrides", "language"])).toBe(false);
    // 쪼개지지 않은 `defaults` 통짜 변경은 무엇이 바뀌었는지 모른다는 뜻이라 리로드로 간다
    // (서브키로 쪼개진 `defaults.font_size`·`defaults.font_family`와 다르다).
    expect(isLocalOnlyChange(["defaults"])).toBe(false);
    // 화이트리스트에 없는 defaults 서브키도 예외가 아니다 — 모르는 키는 리로드로 간다.
    expect(isLocalOnlyChange(["defaults.line_height"])).toBe(false);
    expect(isLocalOnlyChange(["some_future_key"])).toBe(false);
  });

  /** 가드: 빈 목록은 false — "바뀐 게 없다"는 국소 반영 대상이 아니다. */
  it("rejects an empty change list", () => {
    expect(isLocalOnlyChange([])).toBe(false);
  });
});
