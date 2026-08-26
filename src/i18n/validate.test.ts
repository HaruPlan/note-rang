import { describe, expect, it } from "vitest";
import { validateLocaleEntries } from "./validate";

const base = {
  "panel.list.empty": "노트 없음",
  "note.restore.done": "{title} 노트를 복원했습니다",
  "panel.search.placeholder": "검색",
};

describe("validateLocaleEntries", () => {
  /** 가드: base의 모든 키가 있고 플레이스홀더 집합이 일치하면 전부 수용된다(커버리지 1). */
  it("accepts every key when placeholders match exactly", () => {
    const { accepted, coverage } = validateLocaleEntries(
      {
        "panel.list.empty": "No notes",
        "note.restore.done": "Restored {title}",
        "panel.search.placeholder": "Search",
      },
      base,
    );
    expect(accepted).toEqual({
      "panel.list.empty": "No notes",
      "note.restore.done": "Restored {title}",
      "panel.search.placeholder": "Search",
    });
    expect(coverage).toBe(1);
  });

  /** 가드(핵심): 플레이스홀더 집합이 base와 다른 키는 **그 키만** 거부한다(전체 거부 아님). */
  it("rejects only the key whose placeholder set differs from base", () => {
    const { accepted, coverage } = validateLocaleEntries(
      {
        "panel.list.empty": "No notes",
        // {title} 플레이스홀더가 빠졌다 — 이 키만 거부돼야 한다.
        "note.restore.done": "Restored",
        "panel.search.placeholder": "Search",
      },
      base,
    );
    expect(accepted).toEqual({
      "panel.list.empty": "No notes",
      "panel.search.placeholder": "Search",
    });
    expect(coverage).toBeCloseTo(2 / 3);
  });

  /** 가드: 플레이스홀더 이름이 다르면(존재하되 이름이 어긋나면) 그 키도 거부한다. */
  it("rejects a key whose placeholder name differs even if a placeholder exists", () => {
    const { accepted } = validateLocaleEntries(
      { "note.restore.done": "Restored {name}" },
      base,
    );
    expect(accepted).toEqual({});
  });

  /** 가드: base에 없는 미지 키는 무시(버림) — 수용 맵에 절대 나타나지 않는다. */
  it("ignores keys unknown to base", () => {
    const { accepted, coverage } = validateLocaleEntries(
      {
        "panel.list.empty": "No notes",
        "note.restore.done": "Restored {title}",
        "panel.search.placeholder": "Search",
        "made.up.key": "should not appear",
      },
      base,
    );
    expect(accepted).not.toHaveProperty("made.up.key");
    expect(coverage).toBe(1);
  });

  /** 가드: base에 없는 키만 준 언어팩은 커버리지 0, 수용 맵은 빈 객체. */
  it("returns zero coverage when entries covers nothing in base", () => {
    const { accepted, coverage } = validateLocaleEntries(
      { "made.up.key": "x" },
      base,
    );
    expect(accepted).toEqual({});
    expect(coverage).toBe(0);
  });

  /** 가드(방어): entries가 객체가 아니면(배열·문자열·null 등) 빈 사전으로 취급한다. */
  it("treats a non-object entries as empty", () => {
    for (const bad of [null, undefined, "string", ["a", "b"], 42]) {
      const { accepted, coverage } = validateLocaleEntries(bad, base);
      expect(accepted).toEqual({});
      expect(coverage).toBe(0);
    }
  });

  /** 가드(방어): 값이 문자열이 아닌 항목은 own-property라도 거부한다(타입 안전). */
  it("rejects a key whose value is not a string", () => {
    const { accepted } = validateLocaleEntries(
      { "panel.list.empty": 123 },
      base,
    );
    expect(accepted).toEqual({});
  });

  /** 가드(방어): base가 Object.prototype 속성명을 키로 가져도, entries에 그 이름의
   * own-property가 없으면 상속된 함수(예: Function.prototype.toString)를 값으로 집어
   * 오지 않는다(own-property 확인이 프로토타입 체인을 막는다). */
  it("does not leak an inherited Object.prototype value when entries lacks the own key", () => {
    const { accepted } = validateLocaleEntries({}, { toString: "원문" });
    expect(accepted).toEqual({});
  });

  /** 가드: base가 빈 사전이면 커버리지는 1(분모 0 방어). */
  it("returns coverage 1 when base is empty", () => {
    const { accepted, coverage } = validateLocaleEntries({ x: "y" }, {});
    expect(accepted).toEqual({});
    expect(coverage).toBe(1);
  });
});
