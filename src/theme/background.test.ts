import { describe, it, expect } from "vitest";
import {
  contrastVars,
  hasBackgroundPicker,
  isLightColor,
  normalizeBackgroundArgs,
  resolveBackgroundColor,
} from "./background";

describe("normalizeBackgroundArgs", () => {
  /** 가드: 온전한 입력을 정규화한다(스와치 hex만·autoTextContrast 불리언). */
  it("normalizes a well-formed background registration", () => {
    const d = normalizeBackgroundArgs({
      swatches: ["#e5dbc3", "#fdf6e3"],
      autoTextContrast: false,
    });
    expect(d.swatches).toEqual(["#e5dbc3", "#fdf6e3"]);
    expect(d.autoTextContrast).toBe(false);
  });

  /** 가드(보안): hex 아닌 스와치는 버린다(스타일 인젝션 차단). */
  it("drops non-hex swatches", () => {
    const d = normalizeBackgroundArgs({
      swatches: ["#abc", "javascript:alert(1)", "notacolor", "#123456"],
    });
    expect(d.swatches).toEqual(["#abc", "#123456"]);
  });

  /** 가드: autoTextContrast 미지정/비불리언이면 기본 true(기존 동작 유지). */
  it("defaults autoTextContrast to true when missing or not boolean", () => {
    expect(normalizeBackgroundArgs({}).autoTextContrast).toBe(true);
    expect(
      normalizeBackgroundArgs({ autoTextContrast: "yes" }).autoTextContrast,
    ).toBe(true);
  });

  /** 가드: 완전히 잘못된 입력(비객체)도 안전한 빈 디스크립터로 정규화된다. */
  it("returns a safe empty descriptor for junk input", () => {
    const d = normalizeBackgroundArgs(null);
    expect(d.swatches).toEqual([]);
    expect(d.autoTextContrast).toBe(true);
  });
});

describe("hasBackgroundPicker", () => {
  /** 가드: 스와치가 있으면 배경 피커 노출, 없으면(빈 팔레트·플러그인 off) 숨김. */
  it("shows the picker only when there are swatches", () => {
    expect(hasBackgroundPicker(["#fff"])).toBe(true);
    expect(hasBackgroundPicker([])).toBe(false);
  });
});

describe("isLightColor", () => {
  /** 가드: 밝은/어두운 배경 분류(툴바 틴트 대비 결정에 사용). */
  it("classifies light vs dark colors", () => {
    expect(isLightColor("#ffffff")).toBe(true);
    expect(isLightColor("#e5dbc3")).toBe(true); // 베이지 스와치
    expect(isLightColor("#fff")).toBe(true); // 단축 표기
    expect(isLightColor("#000000")).toBe(false);
    expect(isLightColor("#37506a")).toBe(false); // 딥블루
  });

  /** 가드: 파싱 불가 입력은 밝음으로 간주(안전 폴백). */
  it("defaults to light for unparseable input", () => {
    expect(isLightColor("nope")).toBe(true);
  });
});

describe("contrastVars", () => {
  /** 가드: autoTextContrast=true면 배경 밝기에 따라 대비 값이 뒤집힌다. */
  it("auto-adapts to background lightness when enabled", () => {
    expect(contrastVars("#fdf6e3", true)).toEqual({
      tbOn: "0, 0, 0",
      noteText: "#1f2328",
    });
    expect(contrastVars("#37506a", true)).toEqual({
      tbOn: "255, 255, 255",
      noteText: "#f1f1ee",
    });
  });

  /** 가드(핵심): autoTextContrast=false면 배경과 무관하게 고정 기본값(밝은 배경 기준). */
  it("uses fixed defaults regardless of background when disabled", () => {
    const fixed = { tbOn: "0, 0, 0", noteText: "#1f2328" };
    expect(contrastVars("#fdf6e3", false)).toEqual(fixed);
    expect(contrastVars("#000000", false)).toEqual(fixed);
  });
});

describe("resolveBackgroundColor", () => {
  /** 가드: color 배경은 그 값을, 그 외(null/image/형식오류)는 fallback. */
  it("returns the color value for a color background", () => {
    expect(
      resolveBackgroundColor({ type: "color", value: "#abc" }, "#fff"),
    ).toBe("#abc");
  });

  it("falls back for null, image, or malformed background", () => {
    expect(resolveBackgroundColor(null, "#fff")).toBe("#fff");
    expect(
      resolveBackgroundColor(
        { type: "image", value: "x", fit: "fill", opacity: 100 },
        "#fff",
      ),
    ).toBe("#fff");
    expect(resolveBackgroundColor({}, "#fff")).toBe("#fff");
  });

  /**
   * 가드: color인데 값이 hex가 아니면 fallback이다. 그대로 통과시키면
   * `style.background = "default"`처럼 CSS가 조용히 무시하는 값이 되어 "배경이 안 바뀐다"가
   * 되고, 대비 계산도 파싱 실패로 밝음에 고정된다(옛 사이드카·수기 편집·미래 형식).
   */
  it("falls back when a color background carries a non-hex value", () => {
    for (const value of [
      "default",
      "red",
      "rgb(1,2,3)",
      "var(--x)",
      "#12",
      "",
      42,
      null,
    ]) {
      expect(resolveBackgroundColor({ type: "color", value }, "#fff")).toBe(
        "#fff",
      );
    }
    // 공백만 있는 정상 hex는 계속 통과한다(등록 경로와 같은 정규화).
    expect(
      resolveBackgroundColor({ type: "color", value: " #abc " }, "#fff"),
    ).toBe("#abc");
  });
});
