/**
 * 선택 액션의 닫힌 어휘·로컬 판정 테스트(`selection-action.ts`).
 *
 * 무엇을 지키나: (1) `match`가 **정규식이 아니라 닫힌 어휘**라는 계약 — 어휘 밖 값은 조용히
 * 버려지지 않고 거부된다, (2) 판정 술어가 세 축(문자 부류·한 줄·길이)을 AND로 보고 경계에서
 * 흔들리지 않는다, (3) 두 표면(툴바·단축키)이 같은 술어를 보므로 조건이 갈릴 수 없다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  charInClass,
  liveSelectionActions,
  matchingSelectionActions,
  parseSelectionMatch,
  SELECTION_ACTION_RENDER_LIMIT,
  SELECTION_CHAR_CLASSES,
  selectionMatches,
  setSelectionActions,
  type SelectionActionItem,
} from "./selection-action";

/** 테스트용 액션 하나(실행은 호출 기록만 남긴다). */
function action(
  id: string,
  match?: SelectionActionItem["match"],
  calls: string[] = [],
): SelectionActionItem {
  return {
    pluginId: "p",
    id,
    label: id,
    ...(match ? { match } : {}),
    run: (payload) => calls.push(`${id}:${payload.selectedText}`),
  };
}

describe("문자 부류 어휘(charInClass)", () => {
  it("digit은 ASCII 숫자만 — 다른 자릿수 체계는 포함하지 않는다", () => {
    expect(charInClass("digit", "0")).toBe(true);
    expect(charInClass("digit", "9")).toBe(true);
    expect(charInClass("digit", "٣")).toBe(false); // 아라비아-인도 숫자
    expect(charInClass("digit", "a")).toBe(false);
  });

  it("operator는 산술식 기호 — 괄호·소수점·자릿수 쉼표까지 포함한다", () => {
    for (const ch of "+-*/%^=<>().,") {
      expect(charInClass("operator", ch), `operator: ${ch}`).toBe(true);
    }
    expect(charInClass("operator", "?")).toBe(false);
    expect(charInClass("operator", "가")).toBe(false);
  });

  it("space는 줄바꿈을 포함한다 — 「한 줄인가」는 singleLine이 따로 보는 축이다", () => {
    expect(charInClass("space", " ")).toBe(true);
    expect(charInClass("space", "\t")).toBe(true);
    expect(charInClass("space", "\n")).toBe(true);
  });

  it("latin은 ASCII 알파벳, hangul은 음절·자모를 덮는다", () => {
    expect(charInClass("latin", "a")).toBe(true);
    expect(charInClass("latin", "Z")).toBe(true);
    expect(charInClass("latin", "가")).toBe(false);
    expect(charInClass("hangul", "가")).toBe(true);
    expect(charInClass("hangul", "힣")).toBe(true);
    expect(charInClass("hangul", "ㄱ")).toBe(true); // 호환 자모
    expect(charInClass("hangul", "a")).toBe(false);
  });

  it("punctuation은 유니코드 문장부호 — 비ASCII 따옴표·줄표도 잡는다", () => {
    expect(charInClass("punctuation", ".")).toBe(true);
    expect(charInClass("punctuation", "「")).toBe(true);
    expect(charInClass("punctuation", "—")).toBe(true);
    expect(charInClass("punctuation", "a")).toBe(false);
  });

  it("부류는 서로 배타적이지 않다 — 겹침은 계약이다(판정이 「하나 이상」이라)", () => {
    expect(charInClass("operator", ".")).toBe(true);
    expect(charInClass("punctuation", ".")).toBe(true);
  });

  it("모르는 부류 이름은 거짓이다(파서가 이미 거부하지만 방어선을 둔다)", () => {
    expect(charInClass("emoji", "🙂")).toBe(false);
  });
});

describe("match 검증(parseSelectionMatch)", () => {
  it("생략하면 성공이고 값이 없다 — 「선택이 있으면 언제나」의 표현", () => {
    expect(parseSelectionMatch(undefined)).toEqual({
      ok: true,
      match: undefined,
    });
  });

  it("어휘 밖 부류 이름은 조용히 버려지지 않고 거부된다", () => {
    const parsed = parseSelectionMatch({ charClasses: ["digit", "emoji"] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("emoji");
      // 사용자가 무엇을 쓸 수 있는지 오류 문구가 그 자리에서 말해 준다.
      expect(parsed.reason).toContain("digit");
    }
  });

  it("어휘 전수는 그대로 통과하고 중복은 접힌다", () => {
    const parsed = parseSelectionMatch({
      charClasses: [...SELECTION_CHAR_CLASSES, "digit"],
    });
    expect(parsed).toEqual({
      ok: true,
      match: { charClasses: [...SELECTION_CHAR_CLASSES] },
    });
  });

  it("빈 charClasses는 거부된다 — 「검사 없음」과 모호해지지 않게", () => {
    const parsed = parseSelectionMatch({ charClasses: [] });
    expect(parsed.ok).toBe(false);
  });

  it("charClasses가 배열이 아니면 거부된다", () => {
    expect(parseSelectionMatch({ charClasses: "digit" }).ok).toBe(false);
  });

  it("maxLength는 1 이상의 정수만 받는다", () => {
    expect(parseSelectionMatch({ maxLength: 200 })).toEqual({
      ok: true,
      match: { maxLength: 200 },
    });
    expect(parseSelectionMatch({ maxLength: 0 }).ok).toBe(false);
    expect(parseSelectionMatch({ maxLength: -1 }).ok).toBe(false);
    expect(parseSelectionMatch({ maxLength: 1.5 }).ok).toBe(false);
    expect(parseSelectionMatch({ maxLength: "200" }).ok).toBe(false);
  });

  it("singleLine은 boolean만 받고, 거짓이면 스냅샷에 싣지 않는다", () => {
    expect(parseSelectionMatch({ singleLine: true })).toEqual({
      ok: true,
      match: { singleLine: true },
    });
    // false는 "검사 안 함"과 같아 빈 match가 되고, 빈 match는 undefined로 접힌다.
    expect(parseSelectionMatch({ singleLine: false })).toEqual({
      ok: true,
      match: undefined,
    });
    expect(parseSelectionMatch({ singleLine: "yes" }).ok).toBe(false);
  });

  it("객체가 아니면 거부된다(배열·문자열 포함)", () => {
    expect(parseSelectionMatch("digit").ok).toBe(false);
    expect(parseSelectionMatch(["digit"]).ok).toBe(false);
  });

  it("모르는 키만 준 match는 조건 없음으로 접힌다(빈 객체를 스냅샷에 싣지 않는다)", () => {
    expect(parseSelectionMatch({ regex: "^\\d+$" })).toEqual({
      ok: true,
      match: undefined,
    });
  });
});

describe("로컬 판정(selectionMatches)", () => {
  it("빈 선택은 언제나 거짓 — 두 표면의 공통 전제를 술어가 들고 있다", () => {
    expect(selectionMatches("", undefined)).toBe(false);
    expect(selectionMatches("", { maxLength: 10 })).toBe(false);
  });

  it("match가 없으면 선택이 있을 때 언제나 참", () => {
    expect(selectionMatches("아무거나\n여러 줄", undefined)).toBe(true);
  });

  it("charClasses는 모든 글자를 본다 — 하나라도 벗어나면 거짓", () => {
    const calc = { charClasses: ["digit", "operator", "space"] };
    expect(selectionMatches("12 + 34 * (5.6)", calc)).toBe(true);
    expect(selectionMatches("12 + a", calc)).toBe(false);
  });

  it("singleLine은 줄바꿈이 있으면 거짓(\\r도 본다)", () => {
    expect(selectionMatches("1+1", { singleLine: true })).toBe(true);
    expect(selectionMatches("1+1\n2", { singleLine: true })).toBe(false);
    expect(selectionMatches("1+1\r2", { singleLine: true })).toBe(false);
    // singleLine이 없으면 줄바꿈은 통과한다(space 부류가 줄바꿈을 덮는다).
    expect(selectionMatches("1\n2", { charClasses: ["digit", "space"] })).toBe(
      true,
    );
  });

  it("maxLength는 경계 포함(이하)이고 코드 포인트로 센다", () => {
    expect(selectionMatches("abc", { maxLength: 3 })).toBe(true);
    expect(selectionMatches("abcd", { maxLength: 3 })).toBe(false);
    // 이모지는 UTF-16으로 2단위지만 한 글자로 센다(상한이 조기에 걸리지 않게).
    expect(selectionMatches("🙂🙂", { maxLength: 2 })).toBe(true);
  });

  it("세 축은 AND다 — 하나만 어긋나도 거짓", () => {
    const match = {
      charClasses: ["digit", "operator", "space"],
      singleLine: true,
      maxLength: 10,
    };
    expect(selectionMatches("1 + 2", match)).toBe(true);
    expect(selectionMatches("1 + 2\n3", match)).toBe(false); // 줄바꿈
    expect(selectionMatches("1 + 2 + 3 + 4", match)).toBe(false); // 길이
    expect(selectionMatches("1 + b", match)).toBe(false); // 문자 부류
  });
});

describe("표시 대상 고르기(matchingSelectionActions)", () => {
  it("조건이 맞는 액션만 등록 순서대로 남는다", () => {
    const actions = [
      action("always"),
      action("digits", { charClasses: ["digit"] }),
      action("short", { maxLength: 2 }),
    ];
    expect(matchingSelectionActions(actions, "123").map((a) => a.id)).toEqual([
      "always",
      "digits",
    ]);
  });

  it("limit을 주면 앞에서부터 그만큼만(툴바), 안 주면 전부(단축키)", () => {
    const many = Array.from({ length: 8 }, (_, i) => action(`a${i}`));
    expect(matchingSelectionActions(many, "x", 3)).toHaveLength(3);
    expect(matchingSelectionActions(many, "x")).toHaveLength(8);
    // 상한을 넘긴 액션도 목록에는 남는다 — 자리 부족과 실행 불가는 다른 이야기다.
    expect(
      matchingSelectionActions(many, "x", SELECTION_ACTION_RENDER_LIMIT),
    ).toHaveLength(SELECTION_ACTION_RENDER_LIMIT);
  });
});

describe("창 로컬 등록부", () => {
  beforeEach(() => setSelectionActions([]));

  it("스냅샷이 오기 전에는 비어 있다", () => {
    expect(liveSelectionActions()).toEqual([]);
  });

  it("통째로 갈린다 — 꺼진 플러그인의 액션이 남지 않는다", () => {
    setSelectionActions([action("a"), action("b")]);
    expect(liveSelectionActions().map((a) => a.id)).toEqual(["a", "b"]);
    setSelectionActions([action("c")]);
    expect(liveSelectionActions().map((a) => a.id)).toEqual(["c"]);
  });
});
