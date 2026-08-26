import { afterEach, describe, expect, it } from "vitest";
import {
  localeToLanguage,
  resolveLanguage,
  systemDefaultLanguage,
} from "./detect";

/** 이 파일 안에서만 `navigator.language`를 바꾼다 — 다음 테스트로 새지 않게 매번 복원한다. */
function stubNavigatorLanguage(value: string): void {
  Object.defineProperty(navigator, "language", {
    value,
    configurable: true,
  });
}
const ORIGINAL_LANGUAGE = navigator.language;
afterEach(() => stubNavigatorLanguage(ORIGINAL_LANGUAGE));

describe("localeToLanguage", () => {
  /** 가드(핵심): "ko"로 시작하면(대소문자 무관) ko — Rust locale_to_builtin_language와 동일. */
  it("returns ko for locales starting with ko, case-insensitively", () => {
    expect(localeToLanguage("ko-KR")).toBe("ko");
    expect(localeToLanguage("ko")).toBe("ko");
    expect(localeToLanguage("KO-kr")).toBe("ko");
  });

  /** 가드: 그 외 로케일은 전부 en. */
  it("returns en for any other locale", () => {
    expect(localeToLanguage("en-US")).toBe("en");
    expect(localeToLanguage("fr-FR")).toBe("en");
    expect(localeToLanguage("ja")).toBe("en");
  });

  /** 가드: 빈 문자열·null·undefined(조회 실패)도 en으로 떨어진다. */
  it("falls back to en for empty or missing locale", () => {
    expect(localeToLanguage("")).toBe("en");
    expect(localeToLanguage(null)).toBe("en");
    expect(localeToLanguage(undefined)).toBe("en");
  });
});

describe("systemDefaultLanguage", () => {
  it("reads navigator.language and applies the same ko/en split", () => {
    stubNavigatorLanguage("ko-KR");
    expect(systemDefaultLanguage()).toBe("ko");

    stubNavigatorLanguage("en-US");
    expect(systemDefaultLanguage()).toBe("en");

    stubNavigatorLanguage("fr-FR");
    expect(systemDefaultLanguage()).toBe("en");
  });
});

describe("resolveLanguage", () => {
  /** 가드(핵심): 저장된 값이 있으면(ko/en뿐 아니라 언어팩이 더한 임의 코드도) 시스템 로케일과
   * 무관하게 그 값을 그대로 쓴다 — 사용자의 명시적 선택이 항상 이긴다. */
  it("always returns the stored value when one exists, ignoring the system locale", () => {
    stubNavigatorLanguage("en-US");
    expect(resolveLanguage("ko")).toBe("ko");
    stubNavigatorLanguage("ko-KR");
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("fr")).toBe("fr"); // 언어팩이 등록했을 수 있는 임의 코드도 그대로.
  });

  /** 가드(핵심): 미설정(null/undefined)일 때만 시스템 로케일로 판정한다. */
  it("falls back to the system locale only when unset", () => {
    stubNavigatorLanguage("ko-KR");
    expect(resolveLanguage(null)).toBe("ko");
    expect(resolveLanguage(undefined)).toBe("ko");

    stubNavigatorLanguage("en-US");
    expect(resolveLanguage(null)).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");

    stubNavigatorLanguage("fr-FR");
    expect(resolveLanguage(undefined)).toBe("en");
  });
});
