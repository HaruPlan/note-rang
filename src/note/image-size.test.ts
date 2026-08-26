import { describe, it, expect } from "vitest";
import {
  MAX_IMAGE_SIZE,
  MIN_IMAGE_SIZE,
  isValidImageSizeInput,
  parseImageAltSize,
  parseImageSizeInput,
  serializeImageAltSize,
} from "./image-size";

describe("parseImageAltSize", () => {
  /** 가드: 크기 토큰이 전혀 없으면 원문을 한 글자도 안 건드린다(기존 동작 그대로). */
  it("returns the alt untouched when there is no size token", () => {
    expect(parseImageAltSize("")).toEqual({
      alt: "",
      width: null,
      height: null,
    });
    expect(parseImageAltSize("로고")).toEqual({
      alt: "로고",
      width: null,
      height: null,
    });
    // 원본 공백까지 정확히 보존(재조립하지 않음)을 확인.
    expect(parseImageAltSize("여러   공백").alt).toBe("여러   공백");
  });

  /** 가드: 둘 다 지정하면 그대로 뽑고, alt에서 토큰을 제거한다. */
  it("extracts both width and height (query-string style with &)", () => {
    expect(parseImageAltSize("w=300&h=200")).toEqual({
      alt: "",
      width: 300,
      height: 200,
    });
  });

  /** 가드: 공백으로도 구분자가 되고, 설명 텍스트와 섞여도 나머지가 alt로 남는다. */
  it("mixes with plain alt text separated by spaces", () => {
    expect(parseImageAltSize("설명 w=300")).toEqual({
      alt: "설명",
      width: 300,
      height: null,
    });
    expect(parseImageAltSize("w=300 설명")).toEqual({
      alt: "설명",
      width: 300,
      height: null,
    });
    expect(parseImageAltSize("앞 h=200 뒤")).toEqual({
      alt: "앞 뒤",
      width: null,
      height: 200,
    });
  });

  /** 가드: w/h 어느 순서로 와도 결과는 같다. */
  it("does not care about w/h token order", () => {
    expect(parseImageAltSize("h=200&w=300")).toEqual({
      alt: "",
      width: 300,
      height: 200,
    });
  });

  /** 가드: 하나만 지정하면 나머지는 auto(null) — 비율 유지는 렌더 쪽(CSS) 책임. */
  it("leaves the other dimension null when only one is given", () => {
    expect(parseImageAltSize("w=300")).toEqual({
      alt: "",
      width: 300,
      height: null,
    });
    expect(parseImageAltSize("h=200")).toEqual({
      alt: "",
      width: null,
      height: 200,
    });
  });

  /** 가드: 대소문자 무관(W=300도 인식) — 파싱 견고성. */
  it("is case-insensitive for the w/h key", () => {
    expect(parseImageAltSize("W=300&H=200")).toEqual({
      alt: "",
      width: 300,
      height: 200,
    });
  });

  /** 가드: 하한(16)·상한(4096) 경계값은 유효, 그 밖은 무효(토큰이 alt에 남고 크기 미적용). */
  it("treats the boundary values as valid and out-of-range as invalid", () => {
    expect(parseImageAltSize(`w=${MIN_IMAGE_SIZE}`)).toEqual({
      alt: "",
      width: MIN_IMAGE_SIZE,
      height: null,
    });
    expect(parseImageAltSize(`w=${MAX_IMAGE_SIZE}`)).toEqual({
      alt: "",
      width: MAX_IMAGE_SIZE,
      height: null,
    });
    // 무효 토큰만 있으면(유효 토큰 0개) 원문 그대로 — w=0 텍스트도 그대로 남는다.
    expect(parseImageAltSize("w=0")).toEqual({
      alt: "w=0",
      width: null,
      height: null,
    });
    expect(parseImageAltSize(`w=${MAX_IMAGE_SIZE + 1}`)).toEqual({
      alt: `w=${MAX_IMAGE_SIZE + 1}`,
      width: null,
      height: null,
    });
  });

  /** 가드: 음수·비정수(소수)·단위 접미사는 애초에 토큰 형식이 아니라 항상 alt 글자로 남는다. */
  it("keeps malformed size-like tokens as plain alt text", () => {
    expect(parseImageAltSize("w=-5")).toEqual({
      alt: "w=-5",
      width: null,
      height: null,
    });
    expect(parseImageAltSize("w=1.5")).toEqual({
      alt: "w=1.5",
      width: null,
      height: null,
    });
    expect(parseImageAltSize("w=300px")).toEqual({
      alt: "w=300px",
      width: null,
      height: null,
    });
    expect(parseImageAltSize("w=")).toEqual({
      alt: "w=",
      width: null,
      height: null,
    });
  });

  /** 가드: 범위 밖 토큰은 유효 토큰과 함께 있어도(리사이즈 모드) 절대 제거되지 않는다 —
   * 형식이 다른 토큰과 동일하게 항상 alt에 그대로 남는다(그 축은 null=auto). */
  it("keeps out-of-range tokens in alt even in resize mode", () => {
    expect(parseImageAltSize("w=300&h=99999")).toEqual({
      alt: "h=99999",
      width: 300,
      height: null,
    });
  });

  /** 가드: 형식 자체가 다른 토큰(음수 등)도 리사이즈 모드에서 alt에 그대로 남는다 —
   * 크기 토큰으로 인식된 적이 없으므로 제거 대상이 아니다. */
  it("keeps non-matching tokens in alt even in resize mode", () => {
    expect(parseImageAltSize("w=300 h=-5 desc")).toEqual({
      alt: "h=-5 desc",
      width: 300,
      height: null,
    });
  });

  /** 가드: 같은 키가 중복되면 먼저 나온 값을 쓰고, 유효한 중복 토큰은 모두 alt에서 지운다. */
  it("uses the first occurrence on duplicate keys and removes all valid duplicates", () => {
    expect(parseImageAltSize("w=300 w=500")).toEqual({
      alt: "",
      width: 300,
      height: null,
    });
    expect(parseImageAltSize("설명 w=300 w=500 끝")).toEqual({
      alt: "설명 끝",
      width: 300,
      height: null,
    });
  });
});

describe("serializeImageAltSize", () => {
  /** 가드(핵심): 파스↔직렬화 왕복 — 직렬화한 alt를 다시 파싱하면 넣은 값과 alt가 그대로 나온다. */
  it("round-trips through parseImageAltSize", () => {
    const cases: [string, number | null, number | null][] = [
      ["", 300, 200],
      ["", 300, null],
      ["", null, 200],
      ["설명", 300, 200],
      ["설명", null, null],
      ["여러 낱말 설명", MIN_IMAGE_SIZE, MAX_IMAGE_SIZE],
    ];
    for (const [alt, width, height] of cases) {
      expect(
        parseImageAltSize(serializeImageAltSize(alt, width, height)),
      ).toEqual({ alt, width, height });
    }
  });

  /** 가드: 둘 다 주면 문서화된 쿼리식 표기(`w=…&h=…`)로 alt 뒤에 붙인다. */
  it("appends the tokens after the alt text in w&h order", () => {
    expect(serializeImageAltSize("", 300, 200)).toBe("w=300&h=200");
    expect(serializeImageAltSize("설명", 300, 200)).toBe("설명 w=300&h=200");
    expect(serializeImageAltSize("설명", null, 200)).toBe("설명 h=200");
  });

  /** 가드: 기존 유효 토큰은 남기지 않고 새 값으로 갈아 끼운다(찌꺼기 `w=300`이 남으면 안 된다). */
  it("replaces the existing valid tokens instead of stacking them", () => {
    expect(serializeImageAltSize("w=300&h=200", 500, null)).toBe("w=500");
    expect(serializeImageAltSize("설명 w=300 h=200", 500, 400)).toBe(
      "설명 w=500&h=400",
    );
  });

  /** 가드(핵심): 둘 다 비면 토큰을 통째로 지운다 — 「원본 크기로」가 이 경로다. */
  it("drops every size token when both values are empty", () => {
    expect(serializeImageAltSize("w=300&h=200", null, null)).toBe("");
    expect(serializeImageAltSize("설명 w=300", null, null)).toBe("설명");
    expect(serializeImageAltSize("앞 h=200 뒤", null, null)).toBe("앞 뒤");
  });

  /** 가드: 크기 토큰이 원래도 없고 새로 붙일 것도 없으면 원문을 한 글자도 안 건드린다(공백까지). */
  it("keeps the raw alt untouched when there is nothing to add or remove", () => {
    expect(serializeImageAltSize("여러   공백", null, null)).toBe(
      "여러   공백",
    );
    expect(serializeImageAltSize("", null, null)).toBe("");
  });

  /** 가드: 범위 밖·비정수 값은 그 축을 아예 안 쓴다(auto) — 무효 크기를 문서에 박지 않는다. */
  it("ignores out-of-range and non-integer values", () => {
    expect(serializeImageAltSize("설명", 0, null)).toBe("설명");
    expect(serializeImageAltSize("설명", MAX_IMAGE_SIZE + 1, null)).toBe(
      "설명",
    );
    expect(serializeImageAltSize("설명", 1.5, null)).toBe("설명");
    expect(serializeImageAltSize("설명", 300, 5000)).toBe("설명 w=300");
  });

  /** 가드: 무효 토큰(`w=0`)은 파싱과 같은 규칙으로 alt 글자 취급 — 크기 조정이 몰래 지우지 않는다. */
  it("never removes the tokens parsing refused to consume", () => {
    expect(serializeImageAltSize("w=0 설명", 300, null)).toBe("w=0 설명 w=300");
    expect(serializeImageAltSize("h=-5 설명", null, null)).toBe("h=-5 설명");
  });
});

describe("parseImageSizeInput / isValidImageSizeInput", () => {
  /** 가드(핵심): 빈 값은 "그 축은 auto"라는 뜻이 있는 입력이라 **유효**하다(값은 null). */
  it("treats an empty field as a valid auto value", () => {
    expect(isValidImageSizeInput("")).toBe(true);
    expect(isValidImageSizeInput("   ")).toBe(true);
    expect(parseImageSizeInput("")).toBeNull();
  });

  /** 가드: 범위 안 정수는 그 값으로, 경계값도 통과한다(양끝 공백은 다듬는다). */
  it("accepts integers inside the range, boundaries included", () => {
    expect(parseImageSizeInput("300")).toBe(300);
    expect(parseImageSizeInput("  300  ")).toBe(300);
    expect(parseImageSizeInput(String(MIN_IMAGE_SIZE))).toBe(MIN_IMAGE_SIZE);
    expect(parseImageSizeInput(String(MAX_IMAGE_SIZE))).toBe(MAX_IMAGE_SIZE);
    expect(isValidImageSizeInput("300")).toBe(true);
  });

  /** 가드: 범위 밖·비정수·비수치는 확인 버튼을 막는다(무효 크기가 문서로 들어가는 길 차단). */
  it("rejects out-of-range, non-integer, and non-numeric input", () => {
    for (const raw of [
      "0",
      String(MIN_IMAGE_SIZE - 1),
      String(MAX_IMAGE_SIZE + 1),
      "1.5",
      "-5",
      "300px",
      "abc",
      "３００",
    ]) {
      expect(isValidImageSizeInput(raw)).toBe(false);
      expect(parseImageSizeInput(raw)).toBeNull();
    }
  });
});
