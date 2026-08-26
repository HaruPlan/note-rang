import { describe, expect, it } from "vitest";
import {
  describePlatforms,
  isSupportedOnPlatform,
  platformLabel,
} from "./platform";

describe("isSupportedOnPlatform", () => {
  it("미선언/빈 배열이면 모든 OS 지원", () => {
    expect(isSupportedOnPlatform(undefined, "windows")).toBe(true);
    expect(isSupportedOnPlatform(null, "macos")).toBe(true);
    expect(isSupportedOnPlatform([], "linux")).toBe(true);
  });

  it("선언된 OS 목록에 현재 OS가 있어야 지원", () => {
    expect(isSupportedOnPlatform(["macos"], "macos")).toBe(true);
    expect(isSupportedOnPlatform(["macos"], "windows")).toBe(false);
    expect(isSupportedOnPlatform(["macos", "windows"], "windows")).toBe(true);
    expect(isSupportedOnPlatform(["macos", "windows"], "linux")).toBe(false);
  });

  it("현재 OS를 알 수 없으면(빈 문자열) 제한하지 않는다(안전 폴백)", () => {
    expect(isSupportedOnPlatform(["macos"], "")).toBe(true);
  });
});

describe("platformLabel", () => {
  it("알려진 OS는 아이콘+이름", () => {
    expect(platformLabel("macos")).toBe("🍎 macOS");
    expect(platformLabel("windows")).toBe("⊞ Windows");
    expect(platformLabel("linux")).toBe("🐧 Linux");
  });

  it("미상 OS는 그대로 표기", () => {
    expect(platformLabel("freebsd")).toBe("freebsd");
  });
});

describe("describePlatforms", () => {
  it("미선언/빈 배열은 배지 불필요(null)", () => {
    expect(describePlatforms(undefined)).toBeNull();
    expect(describePlatforms([])).toBeNull();
  });

  it("하나면 '전용', 여럿이면 라벨을 · 로 잇는다", () => {
    expect(describePlatforms(["macos"])).toBe("🍎 macOS 전용");
    expect(describePlatforms(["macos", "windows"])).toBe(
      "🍎 macOS · ⊞ Windows",
    );
  });
});
