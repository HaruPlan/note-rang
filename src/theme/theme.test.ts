import { describe, it, expect } from "vitest";
import {
  ALL_TOKEN_KEYS,
  applyTheme,
  isSurfaceToken,
  mergeThemeOverrides,
  normalizeThemeArgs,
  SJ_D,
  THEME_TOKEN_DEFAULTS,
  THEME_TOKENS,
} from "./theme";

describe("SJ_D 기본 테마(색 토큰만)", () => {
  /** 가드: 기본 테마가 의미색(강조·삭제·주의) + 표면(배경·카드·테두리·글자 라이트/다크) 토큰을
   * 모두 공급한다(노트 종이색은 별도 배경 플러그인이 담당). */
  it("supplies the semantic and surface (light/dark) color tokens", () => {
    expect(SJ_D.tokens).toEqual({
      accent: "#37506a",
      danger: "#c0392b",
      warning: "#b7791f",
      surface: "#fbfbf8",
      "surface-dark": "#1f1f1f",
      card: "#ffffff",
      "card-dark": "#2b2b2b",
      border: "#dcdcd6",
      "border-dark": "#454545",
      text: "#1f2328",
      "text-dark": "#ededed",
      panel: "#fbfbf8",
      "panel-dark": "#1f1f1f",
      "panel-text": "#1f2328",
      "panel-text-dark": "#ededed",
    });
  });

  /** 가드(회귀): 패널 토큰의 기본값이 표면(surface/text)과 **같은 색**이어야 한다 — 갈라지면
   * 아무것도 안 바꾼 사용자의 패널 색이 이 변경만으로 달라진다. */
  it("defaults the panel tokens to the same colors as surface/text", () => {
    expect(SJ_D.tokens.panel).toBe(SJ_D.tokens.surface);
    expect(SJ_D.tokens["panel-dark"]).toBe(SJ_D.tokens["surface-dark"]);
    expect(SJ_D.tokens["panel-text"]).toBe(SJ_D.tokens.text);
    expect(SJ_D.tokens["panel-text-dark"]).toBe(SJ_D.tokens["text-dark"]);
    for (const key of ["panel", "panel-dark", "panel-text", "panel-text-dark"])
      expect(THEME_TOKEN_DEFAULTS[key]).toBe(SJ_D.tokens[key]);
  });

  /** 가드: 패널 토큰이 화이트리스트·표면 판정에 들어 있다(등록 살균·병합·편집기가 공유). */
  it("registers the panel tokens as surface tokens", () => {
    expect(ALL_TOKEN_KEYS).toEqual(
      expect.arrayContaining([
        "panel",
        "panel-dark",
        "panel-text",
        "panel-text-dark",
      ]),
    );
    expect(isSurfaceToken("panel")).toBe(true);
    expect(isSurfaceToken("panel-text")).toBe(true);
    // `-dark`는 표면 토큰 자체가 아니라 그 다크 짝이다(applyTheme의 분기 규칙).
    expect(isSurfaceToken("panel-dark")).toBe(false);
    expect(isSurfaceToken("panel-text-dark")).toBe(false);
  });

  /** 가드: 이름에 `-` 두 개가 든 `panel-text-dark`도 다크 소스 변수로 정확히 갈린다
   * (applyTheme의 `slice(0, -5)` 규칙이 `panel-text`를 되찾아야 한다). */
  it("maps panel-text-dark to its own dark source var", () => {
    const el = document.createElement("div");
    applyTheme(el, SJ_D);
    expect(el.style.getPropertyValue("--memo-panel-light")).toBe("#fbfbf8");
    expect(el.style.getPropertyValue("--memo-panel-dark")).toBe("#1f1f1f");
    expect(el.style.getPropertyValue("--memo-panel-text-light")).toBe(
      "#1f2328",
    );
    expect(el.style.getPropertyValue("--memo-panel-text-dark")).toBe("#ededed");
  });
});

describe("normalizeThemeArgs", () => {
  /** 가드: 온전한 tokens 입력을 그대로(정규화해) 디스크립터로 만든다. */
  it("normalizes a well-formed theme registration", () => {
    const d = normalizeThemeArgs({
      tokens: { accent: "#111111", danger: "#222" },
    });
    expect(d.tokens).toEqual({ accent: "#111111", danger: "#222" });
  });

  /** 가드(보안): hex 아닌 토큰·인젝션·화이트리스트 밖 키는 버린다. */
  it("drops non-hex, injection, and non-whitelisted keys", () => {
    const d = normalizeThemeArgs({
      tokens: {
        accent: "red; background:url(x)",
        danger: "#0a0a0a",
        secondary: "#123123",
      },
    });
    expect(d.tokens).toEqual({ danger: "#0a0a0a" });
  });

  /** 가드: 배경 관련 필드(구 스키마)는 무시된다 — 테마는 색 토큰만 다룬다. */
  it("ignores background fields (theme is colors-only)", () => {
    const d = normalizeThemeArgs({
      tokens: { accent: "#111" },
      backgroundSwatches: ["#fff"],
      autoTextContrast: false,
    });
    expect(d).toEqual({ tokens: { accent: "#111" } });
  });

  /** 가드: 완전히 잘못된 입력(비객체)도 안전한 빈 디스크립터로 정규화된다. */
  it("returns a safe empty descriptor for junk input", () => {
    expect(normalizeThemeArgs(null)).toEqual({ tokens: {} });
  });

  /** 가드: 표면 토큰의 라이트(`surface`)와 다크(`surface-dark`) 키를 모두 인정한다. */
  it("accepts surface tokens and their -dark variants", () => {
    const d = normalizeThemeArgs({
      tokens: {
        surface: "#fefefe",
        "surface-dark": "#101010",
        "card-dark": "#202020",
        "bogus-dark": "#333333", // 화이트리스트 밖 -dark 키는 버린다
      },
    });
    expect(d.tokens).toEqual({
      surface: "#fefefe",
      "surface-dark": "#101010",
      "card-dark": "#202020",
    });
  });
});

describe("applyTheme", () => {
  /** 가드: 의미색은 `--memo-<k>`, 표면은 모드별 소스(`--memo-<k>-light`/`--memo-<k>-dark`)로 적용한다. */
  it("maps semantic to --memo-<k> and surface to -light/-dark source vars", () => {
    const el = document.createElement("div");
    applyTheme(el, SJ_D);
    // 의미색 — 두 모드 공통.
    expect(el.style.getPropertyValue("--memo-accent")).toBe("#37506a");
    expect(el.style.getPropertyValue("--memo-danger")).toBe("#c0392b");
    // 표면 — 라이트/다크 소스 변수로 분리(스타일시트가 모드에 맞게 --memo-surface를 고른다).
    expect(el.style.getPropertyValue("--memo-surface-light")).toBe("#fbfbf8");
    expect(el.style.getPropertyValue("--memo-surface-dark")).toBe("#1f1f1f");
    expect(el.style.getPropertyValue("--memo-text-light")).toBe("#1f2328");
    // 표면 최종 변수(--memo-surface)는 인라인으로 두지 않는다(스타일시트가 고른다).
    expect(el.style.getPropertyValue("--memo-surface")).toBe("");
  });
});

describe("mergeThemeOverrides", () => {
  const base = { tokens: { accent: "#37506a", danger: "#c0392b" } };

  /** 가드: 유효한 hex는 해당 토큰만 덮고 나머지 토큰은 보존한다. */
  it("overrides a token with a valid hex, leaving others intact", () => {
    const m = mergeThemeOverrides(base, { accent: "#112233" });
    expect(m.tokens).toEqual({ accent: "#112233", danger: "#c0392b" });
  });

  /** 가드(보안): 잘못된 hex·화이트리스트 밖 키는 무시한다(살균은 병합에서도 유지). */
  it("ignores invalid hex and non-whitelisted keys", () => {
    const m = mergeThemeOverrides(base, {
      accent: "notacolor",
      danger: "#0f0",
      secondary: "#010101",
    });
    expect(m.tokens).toEqual({ accent: "#37506a", danger: "#0f0" });
  });

  /** 가드: 적용할 게 없으면 새 객체를 만들지 않고 원본을 그대로 돌려준다. */
  it("returns the same descriptor when nothing applies", () => {
    expect(mergeThemeOverrides(base, undefined)).toBe(base);
    expect(mergeThemeOverrides(base, {})).toBe(base);
    expect(mergeThemeOverrides(base, { accent: "bad" })).toBe(base);
  });

  /** 가드: 표면 토큰의 라이트/다크 오버라이드를 각각 덮는다(모드별 커스텀). */
  it("overrides surface light and dark values independently", () => {
    const m = mergeThemeOverrides(
      { tokens: { surface: "#fbfbf8", "surface-dark": "#1f1f1f" } },
      { "surface-dark": "#0b0b0b" },
    );
    expect(m.tokens).toEqual({ surface: "#fbfbf8", "surface-dark": "#0b0b0b" });
  });

  /** 가드: 패널 토큰(이름에 `-`가 둘인 `panel-text-dark` 포함)도 화이트리스트를 통과한다 —
   * 설정 창이 저장한 오버라이드가 여기서 걸러지면 색을 바꿔도 아무 일이 없다. */
  it("passes panel token overrides through, including panel-text-dark", () => {
    const m = mergeThemeOverrides(SJ_D, {
      panel: "#101010",
      "panel-text-dark": "#00ff00",
    });
    expect(m.tokens.panel).toBe("#101010");
    expect(m.tokens["panel-text-dark"]).toBe("#00ff00");
    // 짝 토큰은 그대로다(라이트/다크가 독립).
    expect(m.tokens["panel-dark"]).toBe("#1f1f1f");
    expect(m.tokens["panel-text"]).toBe("#1f2328");
  });

  /** 가드: 입력 디스크립터를 변형하지 않는다(순수). */
  it("does not mutate the input descriptor", () => {
    const before = JSON.parse(JSON.stringify(base));
    mergeThemeOverrides(base, { accent: "#000000" });
    expect(base).toEqual(before);
  });
});

describe("THEME_TOKEN_DEFAULTS", () => {
  /** 가드: 모든 토큰 키에 대한 기본값(hex)이 정의돼 있다(편집기 baseline·CSS 폴백 정합). */
  it("defines a hex default for every THEME_TOKENS key", () => {
    for (const key of THEME_TOKENS) {
      expect(THEME_TOKEN_DEFAULTS[key]).toMatch(
        /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,
      );
    }
  });
});
