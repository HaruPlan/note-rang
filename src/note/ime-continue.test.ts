import { describe, it, expect } from "vitest";
import { isImeContinueEnter, type KeydownLike } from "./ime-continue";

/** 기본값(비조합 일반 키)에서 필요한 필드만 덮어써 keydown 유사 객체를 만든다. */
function key(over: Partial<KeydownLike>): KeydownLike {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...over,
  };
}

describe("isImeContinueEnter", () => {
  /** 가드: 조합 중(isComposing) Enter는 보정 대상 — CM이 건너뛰므로 우리가 이어쓴다. */
  it("matches an Enter pressed while composing", () => {
    expect(isImeContinueEnter(key({ isComposing: true }))).toBe(true);
  });

  /** 가드: IME 합성 keyCode(229)로 온 Enter도 보정 대상. */
  it("matches an Enter delivered as IME keyCode 229", () => {
    expect(isImeContinueEnter(key({ isComposing: false, keyCode: 229 }))).toBe(
      true,
    );
  });

  /** 가드: 일반 Enter(비조합, keyCode 13)는 제외 — CM이 이미 처리(이중 실행 방지). */
  it("ignores a normal (non-composing) Enter", () => {
    expect(isImeContinueEnter(key({ isComposing: false, keyCode: 13 }))).toBe(
      false,
    );
  });

  /** 가드: Shift+Enter는 단순 줄바꿈 의도라 제외. */
  it("ignores Shift+Enter even while composing", () => {
    expect(isImeContinueEnter(key({ isComposing: true, shiftKey: true }))).toBe(
      false,
    );
  });

  /** 가드: Enter가 아닌 키는 조합 중이어도 제외. */
  it("ignores non-Enter keys", () => {
    expect(
      isImeContinueEnter(key({ key: "a", isComposing: true, keyCode: 229 })),
    ).toBe(false);
  });
});
