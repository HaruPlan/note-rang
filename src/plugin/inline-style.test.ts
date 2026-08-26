/**
 * 인라인 스타일 보안 가드 — 의미 토큰 해석, 속성/값 화이트리스트, 클래스 네임스페이스,
 * CSS 렌더. 신뢰 못 할 플러그인 스타일이 인젝션·셀렉터 하이재킹으로 새지 않음을 고정한다.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeInlineStyle,
  patternParamRegexSource,
  pluginPatternClass,
  renderInlineStyleCss,
  renderParamStyleDeclaration,
  PATTERN_PARAM_APPLY_PROPS,
  PATTERN_PARAM_FORMATS,
} from "./inline-style";

describe("normalizeInlineStyle", () => {
  /** 가드: 색 의미 토큰이 앱 CSS 변수 레시피로 해석된다(테마·대비 연동). */
  it("resolves semantic color tokens to app CSS variables", () => {
    expect(normalizeInlineStyle({ color: "accent" })).toEqual({
      color: "var(--memo-accent, #37506a)",
    });
    expect(
      normalizeInlineStyle({
        borderColor: "contrast-border",
        backgroundColor: "contrast-fill",
      }),
    ).toEqual({
      "border-color": "rgba(var(--tb-on, 0, 0, 0), 0.3)",
      "background-color": "rgba(var(--tb-on, 0, 0, 0), 0.08)",
    });
  });

  /** 가드: 안전한 리터럴 색(hex·숫자 rgba)은 통과한다. */
  it("accepts safe literal colors", () => {
    expect(
      normalizeInlineStyle({ backgroundColor: "rgba(250, 204, 21, 0.35)" }),
    ).toEqual({ "background-color": "rgba(250, 204, 21, 0.35)" });
    expect(normalizeInlineStyle({ color: "#abc" })).toEqual({ color: "#abc" });
  });

  /** 가드: camelCase 키 → kebab CSS 속성, 형식 통과 리터럴은 유지. */
  it("maps camelCase keys to kebab CSS and keeps validated literals", () => {
    expect(
      normalizeInlineStyle({
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        verticalAlign: "super",
        fontSize: "0.8em",
        padding: "1px 5px",
        borderStyle: "solid",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }),
    ).toEqual({
      "text-decoration": "underline",
      "text-underline-offset": "2px",
      "vertical-align": "super",
      "font-size": "0.8em",
      padding: "1px 5px",
      "border-style": "solid",
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
  });

  /** 가드: filter는 none·blur()만 허용하고 다른 함수(SVG url 등)는 거부한다. */
  it("allows only none and blur() for filter", () => {
    expect(normalizeInlineStyle({ filter: "blur(4px)" })).toEqual({
      filter: "blur(4px)",
    });
    expect(normalizeInlineStyle({ filter: "none" })).toEqual({
      filter: "none",
    });
    expect(
      normalizeInlineStyle({ filter: "drop-shadow(0 0 2px #000)" }),
    ).toBeNull();
    expect(normalizeInlineStyle({ filter: "url(#evil)" })).toBeNull();
  });

  /** 가드(보안 핵심): 인젝션 벡터·원문 var()·미지 토큰·화이트리스트 밖 속성은 거부·제거된다. */
  it("rejects injection vectors, raw var(), and unknown properties", () => {
    expect(normalizeInlineStyle({ color: "url(http://evil)" })).toBeNull();
    expect(
      normalizeInlineStyle({ backgroundColor: "red; } body {" }),
    ).toBeNull();
    // 원문 var()는 토큰 allowlist 밖 → 거부(변수 인젝션 차단).
    expect(normalizeInlineStyle({ color: "var(--x)" })).toBeNull();
    expect(normalizeInlineStyle({ color: "notatoken" })).toBeNull();
    // 레이아웃/유출 벡터 속성은 화이트리스트에 없어 버려진다.
    expect(
      normalizeInlineStyle({ position: "fixed", content: "'x'" }),
    ).toBeNull();
    // 잘못된 값은 그 속성만 버리고 유효한 건 남긴다.
    expect(normalizeInlineStyle({ color: "bogus", fontSize: "0.8em" })).toEqual(
      {
        "font-size": "0.8em",
      },
    );
  });

  /** 가드: 비객체 입력·예약 키는 결과에 새지 않는다(화이트리스트 순회). */
  it("ignores non-object input and reserved keys", () => {
    expect(normalizeInlineStyle(null)).toBeNull();
    expect(normalizeInlineStyle("color:red")).toBeNull();
    const withProto = JSON.parse(
      '{"__proto__":{"polluted":true},"color":"accent"}',
    ) as unknown;
    expect(normalizeInlineStyle(withProto)).toEqual({
      color: "var(--memo-accent, #37506a)",
    });
  });
});

describe("pluginPatternClass", () => {
  /** 가드: plugin+pattern으로 네임스페이스한다(교차 플러그인 클래스 충돌 방지). */
  it("namespaces by plugin and pattern", () => {
    expect(pluginPatternClass("wikilink", "wikilink")).toBe(
      "cm-x-wikilink-wikilink",
    );
    expect(pluginPatternClass("copy-ai-prompt", "kbd")).toBe(
      "cm-x-copy-ai-prompt-kbd",
    );
  });

  /** 가드(보안 핵심): 영숫자 외 문자를 치환해 임의 셀렉터를 못 짜게 한다. */
  it("sanitizes unsafe chars so plugins cannot craft arbitrary selectors", () => {
    expect(pluginPatternClass("a.b_c", "x y")).toBe("cm-x-a-b-c-x-y");
    expect(pluginPatternClass("cursor{}", "*")).toBe("cm-x-cursor-");
  });
});

describe("renderInlineStyleCss", () => {
  /** 가드: 네임스페이스 클래스에 base + :hover 규칙을 렌더한다. */
  it("renders base and hover rules under the namespaced class", () => {
    const css = renderInlineStyleCss(
      "cm-x-spoiler-spoiler",
      { filter: "blur(4px)", "border-radius": "2px" },
      { filter: "none" },
    );
    expect(css).toContain(
      ".cm-x-spoiler-spoiler { filter: blur(4px); border-radius: 2px; }",
    );
    expect(css).toContain(".cm-x-spoiler-spoiler:hover { filter: none; }");
  });

  /** 가드: 스타일이 비었거나 없으면 아무것도 내지 않는다. */
  it("emits nothing for empty or absent styles", () => {
    expect(renderInlineStyleCss("c", null, null)).toBe("");
    expect(renderInlineStyleCss("c", {}, undefined)).toBe("");
  });
});

describe("패턴 파라미터 형식(PARAM_FORMATS)", () => {
  /** 가드: 형식 어휘는 닫혀 있고, 모르는 이름은 정규식을 내주지 않는다(→ 매치 없음). */
  it("exposes a closed format vocabulary", () => {
    expect(PATTERN_PARAM_FORMATS).toEqual(["hex-color"]);
    expect(patternParamRegexSource("hex-color")).toBeTypeOf("string");
    expect(patternParamRegexSource("css-color")).toBeNull();
    // 프로토타입 체인의 키를 형식 이름으로 위장해도 새지 않는다.
    expect(patternParamRegexSource("constructor")).toBeNull();
    expect(patternParamRegexSource("__proto__")).toBeNull();
  });

  /** 가드: `hex-color`의 정규식이 3자리·6자리만 **정확히** 받는다(자리수 초과/미만 거부). */
  it("matches exactly 3- or 6-digit hex, anchored", () => {
    const re = new RegExp(`^(?:${patternParamRegexSource("hex-color")})$`);
    for (const ok of ["#abc", "#ABC", "#a1b2c3", "#FFFFFF", "#000"]) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "abc",
      "#ab",
      "#abcd",
      "#abcde",
      "#abcdefa",
      "#abcdeg",
      "red",
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  /** 가드: 반영 가능한 속성은 **색 값을 받는 것**뿐이다(화이트리스트에서 유도 — 손으로 안 베낀다). */
  it("only allows color-valued style props as the apply target", () => {
    expect(PATTERN_PARAM_APPLY_PROPS).toEqual([
      "color",
      "backgroundColor",
      "borderColor",
    ]);
  });
});

describe("renderParamStyleDeclaration", () => {
  /** 가드: 검증을 통과한 값만 CSS 선언 한 줄이 되고, 속성은 kebab으로 나간다. */
  it("renders a validated declaration with the kebab CSS property", () => {
    expect(renderParamStyleDeclaration("color", "hex-color", "#f36")).toBe(
      "color: #f36",
    );
    expect(renderParamStyleDeclaration("color", "hex-color", "#FF3366")).toBe(
      "color: #FF3366",
    );
    expect(
      renderParamStyleDeclaration("backgroundColor", "hex-color", "#000000"),
    ).toBe("background-color: #000000");
  });

  /** 가드(보안 핵심): 값 검증을 **다시** 한다 — 매칭 정규식이 형식을 강제하더라도, 이 함수가
   * 본문 → CSS로 가는 유일한 통로이므로 형식 밖 값은 여기서 확실히 끊긴다(임의 CSS 주입 차단). */
  it("refuses anything that is not a well-formed hex", () => {
    for (const bad of [
      "red",
      "#ab",
      "#abcd",
      "#f36; background: url(https://evil.example)",
      "var(--memo-accent)",
      "url(x)",
      "rgba(0,0,0,0.5)", // rgb 리터럴은 style 프로퍼티로는 되지만 파라미터 형식은 hex뿐이다.
      "accent", // 의미 토큰도 파라미터 자리에서는 안 된다(본문에서 온 값이다).
      "expression(alert(1))",
      "#".repeat(200),
      "",
    ]) {
      expect(
        renderParamStyleDeclaration("color", "hex-color", bad),
        bad,
      ).toBeNull();
    }
  });

  /** 가드: 속성·형식이 어휘 밖이면 아무것도 내지 않는다(조용히 스타일을 안 붙인다). */
  it("refuses unknown apply props and unknown formats", () => {
    expect(
      renderParamStyleDeclaration("fontSize", "hex-color", "#f36"),
    ).toBeNull();
    expect(
      renderParamStyleDeclaration("content", "hex-color", "#f36"),
    ).toBeNull();
    expect(
      renderParamStyleDeclaration("__proto__", "hex-color", "#f36"),
    ).toBeNull();
    expect(
      renderParamStyleDeclaration("color", "css-color", "#f36"),
    ).toBeNull();
    expect(
      renderParamStyleDeclaration("color", "constructor", "#f36"),
    ).toBeNull();
  });
});
