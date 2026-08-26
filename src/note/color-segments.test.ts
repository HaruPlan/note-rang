/**
 * 평탄 세그먼트 색 모델 가드 — 파싱·칠하기·직렬화와, 그 셋을 원문 오프셋으로 잇는
 * [`computeLineColorEdit`]를 본다.
 *
 * 이 모듈이 지켜야 하는 불변식은 둘이다.
 * 1. **색 감싸기는 절대 중첩·교차되지 않는다** — 호스트는 `{{글자|#hex}}`를 lazy로 한 겹만
 *    매치하므로(`plugin/editor-api.ts`), 중첩된 본문은 그대로 렌더되지 않고 원문 구분자가
 *    화면에 노출된다. 아래 가드는 대부분 그 불변식이 어떤 선택 모양에서도 깨지지 않는지를 본다.
 * 2. **칠하기·해제는 보이는 글자를 바꾸지 않는다** — 줄에 이 파이프라인이 만들지 않은 구분자
 *    (다른 플러그인의 `{{…}}`, 사용자가 적은 `|#e33}}`)가 섞여 있어도 그렇다. 이 불변식이
 *    깨졌을 때 실제로 벌어진 일은 "색 해제가 남의 `{{`를 문서에서 지운다"였다 — 자동저장이
 *    곧바로 .md에 기록하는 조용한 손실이라, 파일 끝의 퍼즈 가드로 못박아 둔다.
 */
import { describe, it, expect } from "vitest";
import {
  computeLineColorEdit,
  paintRange,
  parseColorSegments,
  serializeColorSegments,
  type ColorSegment,
} from "./color-segments";
import {
  findPatternMatches,
  type InlinePatternParam,
} from "../plugin/editor-api";

/** 「글자 색」 번들이 실제로 등록하는 것과 같은 문법(앱에서는 facet이 나른다). */
const SYNTAX = { open: "{{", close: "}}", prefix: "|" } as const;

/** 같은 문법의 호스트 등록 모양(파라미터 꼬리) — 교차 정합 검사가 이걸로 호스트를 돌린다. */
const PARAM: InlinePatternParam = {
  prefix: SYNTAX.prefix,
  format: "hex-color",
  apply: "color",
};

/** 읽기 좋게 줄인 조립자 — `["a", null]`처럼 적는다. */
const seg = (text: string, color: string | null): ColorSegment => ({
  text,
  color,
});

/** 계산된 편집을 줄에 실제로 적용한다(호출부가 CodeMirror에 넘기는 그 치환과 같다). */
const applyEdit = (
  line: string,
  edit: { from: number; to: number; insert: string },
): string => line.slice(0, edit.from) + edit.insert + line.slice(edit.to);

describe("parseColorSegments", () => {
  /** 가드: 감싸기 앞뒤의 평문까지 빠짐없이 평탄한 목록으로 덮는다. */
  it("covers the whole line with flat segments", () => {
    expect(parseColorSegments("앞 {{할일|#e33}} 뒤", SYNTAX)).toEqual([
      seg("앞 ", null),
      seg("할일", "#e33"),
      seg(" 뒤", null),
    ]);
  });

  /** 가드: 3자리·6자리를 모두 인정하고 표기는 원문 그대로 실어 나른다. */
  it("keeps 3- and 6-digit colors verbatim", () => {
    expect(parseColorSegments("{{a|#e33}}{{b|#112233}}", SYNTAX)).toEqual([
      seg("a", "#e33"),
      seg("b", "#112233"),
    ]);
  });

  /**
   * 가드(핵심): 색 자리가 형식에 안 맞거나(자릿수·색 이름) 안쪽 글자가 비면 감싸기로
   * 인정하지 않고 **평문**으로 남긴다 — 호스트가 그런 본문을 매치조차 하지 않으므로
   * (화면에 원문이 그대로 보인다) 툴바도 같은 판정을 해야 어긋나지 않는다.
   */
  it("treats malformed wraps as plain text", () => {
    for (const line of [
      "{{할일|#ff}}",
      "{{할일|#ffff}}",
      "{{할일|red}}",
      "{{할일|#ggg}}",
      "{{할일}}",
      "{{|#e33}}", // 안쪽 글자가 비었다(호스트 본문은 `.+?`).
      "{{}}",
      "할일|#e33}}", // 여는 구분자가 없다.
    ]) {
      expect(parseColorSegments(line, SYNTAX), line).toEqual([seg(line, null)]);
    }
  });

  /** 가드: 안쪽 글자에 구분자가 섞여 있어도 색 경계를 옳게 찾는다(호스트 lazy 매칭과 같다). */
  it("allows the separator inside the inner text", () => {
    expect(parseColorSegments("{{a|b|#e33}}", SYNTAX)).toEqual([
      seg("a|b", "#e33"),
    ]);
  });

  /** 가드: 안쪽 글자의 다른 마커(`**굵게**`)는 손대지 않고 그대로 보존한다. */
  it("preserves other inline markers inside the wrap", () => {
    expect(parseColorSegments("{{**굵게**|#e33}}", SYNTAX)).toEqual([
      seg("**굵게**", "#e33"),
    ]);
  });

  /**
   * 가드(호스트 일치): 중첩처럼 보이는 본문은 호스트와 **같은 자리**에서 끊긴다 — 바깥
   * `{{`에서 시작하는 후보는 안쪽 `{{`가 닫히지 않아 버려지고(구분자 규칙,
   * `editor-api`의 `patternBodyResyncOffset`), **가장 안쪽 `{{`**부터 잡히는 한 겹만 색이
   * 된다. 이 모듈이 그런 본문을 절대 만들지 않는 이유이기도 하다.
   */
  it("parses a nested-looking body exactly like the host does", () => {
    expect(parseColorSegments("{{{{앞|#00f}}뒤|#f00}}", SYNTAX)).toEqual([
      seg("{{", null),
      seg("앞", "#00f"),
      seg("뒤|#f00}}", null),
    ]);
  });

  /**
   * 가드(핵심 회귀 — 텍스트 손실의 뿌리): 줄 앞쪽에 색으로 매치되지 않는 `{{…}}`(키캡 등)가
   * 있어도 그 여는 구분자가 **뒤쪽 색 감싸기 안으로 빨려 들어가지 않는다**.
   *
   * 예전에는 lazy 본문이 `}}`를 그냥 통과해 `{{Cmd+C}} {{복사|#e33}}` 전체가 색 하나로
   * 파싱됐고(글자 = `Cmd+C}} {{복사`), 그 상태에서 색을 해제하면 키캡의 `{{`가 문서에서
   * 지워졌다 — 되돌리기 말고는 복구할 수 없는 손실이다.
   */
  it("never lets a stray opening delimiter get swallowed by a later wrap", () => {
    expect(parseColorSegments("{{Cmd+C}} {{복사|#e33}}", SYNTAX)).toEqual([
      seg("{{Cmd+C}} ", null),
      seg("복사", "#e33"),
    ]);
    // 앞쪽 감싸기가 hex 오타로 매치에 실패한 경우도 같다(그 줄도 평문으로 남는다).
    expect(parseColorSegments("{{a|#gg}} {{b|#f00}}", SYNTAX)).toEqual([
      seg("{{a|#gg}} ", null),
      seg("b", "#f00"),
    ]);
  });
});

describe("paintRange", () => {
  /** 가드(핵심): 경계에 걸친 세그먼트는 쪼개고 안쪽 조각만 새 색이 된다. */
  it("splits segments that straddle the range", () => {
    const before = [seg("abcde", "#f00")];
    expect(paintRange(before, 1, 4, "#00f")).toEqual([
      seg("a", "#f00"),
      seg("bcd", "#00f"),
      seg("e", "#f00"),
    ]);
  });

  /** 가드: null은 해제 — 걸친 부분만 평문이 되고 나머지 색은 남는다. */
  it("clears color when the new color is null", () => {
    expect(paintRange([seg("abc", "#f00")], 1, 2, null)).toEqual([
      seg("a", "#f00"),
      seg("b", null),
      seg("c", "#f00"),
    ]);
  });

  /** 가드: 여러 세그먼트를 통째로 덮으면 하나로 병합된다(같은 색이 이어지므로). */
  it("merges everything it covers into one segment", () => {
    const before = [seg("a", "#f00"), seg(" b ", null), seg("c", "#00f")];
    expect(paintRange(before, 0, 5, "#3a5")).toEqual([seg("a b c", "#3a5")]);
  });

  /** 가드: 빈 범위는 아무것도 바꾸지 않는다(빈 세그먼트도 만들지 않는다). */
  it("leaves the list untouched for an empty range", () => {
    const before = [seg("abc", "#f00")];
    expect(paintRange(before, 2, 2, "#00f")).toEqual(before);
  });

  /** 가드: 같은 색을 다시 칠해도 세그먼트가 늘어나지 않는다(다시 합쳐진다). */
  it("re-merges when the same color is painted again", () => {
    expect(paintRange([seg("abc", "#f00")], 1, 2, "#f00")).toEqual([
      seg("abc", "#f00"),
    ]);
  });

  /** 가드: 대소문자만 다른 같은 색도 하나로 합친다(표기는 왼쪽 것을 남긴다). */
  it("merges colors that differ only in case", () => {
    expect(paintRange([seg("ab", "#F00")], 1, 2, "#f00")).toEqual([
      seg("ab", "#F00"),
    ]);
  });
});

describe("serializeColorSegments", () => {
  /** 가드: 색이 있는 세그먼트만 감싸고 평문은 그대로 이어 붙인다. */
  it("wraps only colored segments", () => {
    expect(
      serializeColorSegments(
        [seg("앞 ", null), seg("할일", "#e33"), seg(" 뒤", null)],
        SYNTAX,
      ),
    ).toBe("앞 {{할일|#e33}} 뒤");
  });

  /** 가드: 빈 세그먼트는 버린다 — `{{|#e33}}`는 호스트가 매치하지 못해 원문이 노출된다. */
  it("drops empty segments instead of emitting an empty wrap", () => {
    expect(
      serializeColorSegments([seg("", "#e33"), seg("a", null)], SYNTAX),
    ).toBe("a");
  });

  /** 가드: 인접한 같은 색은 하나로 합쳐 쪼개진 잔해(`{{a|#e33}}{{b|#e33}}`)를 남기지 않는다. */
  it("merges adjacent segments of the same color", () => {
    expect(
      serializeColorSegments([seg("a", "#e33"), seg("b", "#e33")], SYNTAX),
    ).toBe("{{ab|#e33}}");
  });

  /** 가드(왕복): 파싱 → 직렬화는 원문을 그대로 되돌린다. */
  it("round-trips a parsed line", () => {
    const line = "앞 {{할일|#e33}} 사이 {{다음|#112233}} 뒤";
    expect(
      serializeColorSegments(parseColorSegments(line, SYNTAX), SYNTAX),
    ).toBe(line);
  });
});

describe("computeLineColorEdit", () => {
  /** 가드: 평문에 색을 주면 그 범위만 감싼다(줄 전체를 다시 쓰지 않는다). */
  it("wraps just the selected part of plain text", () => {
    expect(computeLineColorEdit("할일 끝", 0, 2, "#3a5", SYNTAX)).toEqual({
      from: 0,
      to: 2,
      insert: "{{할일|#3a5}}",
      hadColor: false,
    });
  });

  /**
   * 가드(핵심 — 오프셋 변환): 색이 칠해진 줄에서는 `{{`·`|#hex}}`가 화면에서 숨겨져
   * 드래그가 **안쪽 글자만** 잡는다. 그 원문 오프셋을 평문 오프셋으로 옮겨야 "이 글자에는
   * 이미 색이 있다"를 알 수 있고, 되쓸 때는 선택 밖의 구분자까지 함께 갈아 끼워야 한다.
   */
  it("maps inner-only offsets onto the wrap and rewrites its delimiters", () => {
    const line = "앞 {{할일|#e33}} 뒤";
    const from = line.indexOf("할일");
    expect(computeLineColorEdit(line, from, from + 2, "#17c", SYNTAX)).toEqual({
      from: from - 2,
      to: from + 2 + "|#e33}}".length,
      insert: "{{할일|#17c}}",
      hadColor: true,
    });
  });

  /** 가드: 구분자 한가운데서 시작/끝난 선택은 글자 경계로 붙인다(숨은 마커를 드래그로
   * 정확히 피할 수 없기 때문이다). */
  it("snaps offsets that land inside the delimiters to the text boundary", () => {
    const line = "{{할일|#e33}}";
    // 여는 "{{"의 한가운데(1)에서 시작해 꼬리 한가운데(9)에서 끝난 선택.
    expect(computeLineColorEdit(line, 1, 9, "#17c", SYNTAX)).toEqual({
      from: 0,
      to: line.length,
      insert: "{{할일|#17c}}",
      hadColor: true,
    });
  });

  /** 가드: 글자를 하나도 덮지 않는 선택(구분자만 걸침·빈 선택)은 null — 되쓸 게 없다. */
  it("returns null when the range covers no text", () => {
    expect(
      computeLineColorEdit("{{할일|#e33}}", 0, 2, "#17c", SYNTAX),
    ).toBeNull();
    expect(computeLineColorEdit("할일", 1, 1, "#17c", SYNTAX)).toBeNull();
  });

  /** 가드(핵심 회귀): 감싸기의 가운데만 다른 색으로 바꾸면 셋으로 쪼개진다(중첩 금지). */
  it("splits a wrap when only its middle is repainted", () => {
    const line = "{{abcde|#f00}}";
    const from = line.indexOf("bcd");
    expect(computeLineColorEdit(line, from, from + 3, "#00f", SYNTAX)).toEqual({
      from: 0,
      to: line.length,
      insert: "{{a|#f00}}{{bcd|#00f}}{{e|#f00}}",
      hadColor: true,
    });
  });

  /** 가드: 감싸기 안에서 시작해 바깥 평문으로 이어지는 선택도 경계에서 쪼갠다 — 뒤쪽
   * 평문은 걸친 만큼만 다시 쓴다(건드릴 이유가 없는 글자는 그대로 둔다). */
  it("splits at the wrap boundary and rewrites only the touched plain text", () => {
    const line = "{{ab|#f00}}cd";
    const from = line.indexOf("b");
    const to = line.indexOf("c") + 1;
    expect(computeLineColorEdit(line, from, to, "#00f", SYNTAX)).toEqual({
      from: 0,
      to,
      insert: "{{a|#f00}}{{bc|#00f}}",
      hadColor: true,
    });
  });

  /** 가드: 새 색이 바로 옆 감싸기와 같으면 그 이웃까지 범위를 넓혀 하나로 병합한다. */
  it("merges with a neighbouring wrap of the same color", () => {
    const line = "{{a|#f00}}{{b|#00f}}";
    const from = line.indexOf("b");
    expect(computeLineColorEdit(line, from, from + 1, "#f00", SYNTAX)).toEqual({
      from: 0,
      to: line.length,
      insert: "{{ab|#f00}}",
      hadColor: true,
    });
  });

  /** 가드: 해제(null)는 걸친 부분만 평문으로 만들고 나머지 색은 남긴다. */
  it("clears only the selected part of a wrap", () => {
    const line = "{{abc|#f00}}";
    const from = line.indexOf("b");
    expect(computeLineColorEdit(line, from, from + 1, null, SYNTAX)).toEqual({
      from: 0,
      to: line.length,
      insert: "{{a|#f00}}b{{c|#f00}}",
      hadColor: true,
    });
  });

  /** 가드: 색이 없는 구간의 해제는 `hadColor: false` — 호출부는 이걸 보고 아무것도 하지
   * 않는다(본문을 건드리지 않는다). */
  it("reports hadColor false when the range has no color", () => {
    expect(computeLineColorEdit("할일 끝", 0, 2, null, SYNTAX)).toEqual({
      from: 0,
      to: 2,
      insert: "할일",
      hadColor: false,
    });
  });

  // ── 줄 머리의 구조 문법(불릿·헤딩·인용·태스크) ─────────────────────────────
  //
  // 회귀(실사용 신고): 여러 줄을 드래그해 색을 칠했더니 줄이 `{{- 항목|#3a5}}`가 되어 불릿이
  // 감싸기 안으로 들어갔다 — 그러면 줄이 `{{`로 시작하므로 마크다운이 목록으로 보지 않는다.
  // 규칙은 하나다: 칠하기는 언제나 [`structuralPrefixLength`](md-shortcuts.ts) **뒤**부터.

  /** 가드(핵심): 줄 전체를 덮는 선택이라도 불릿은 감싸기 밖에 남는다. */
  it("never paints the list bullet, even for a whole-line selection", () => {
    const line = "- 항목";
    expect(computeLineColorEdit(line, 0, line.length, "#3a5", SYNTAX)).toEqual({
      from: 2,
      to: line.length,
      insert: "{{항목|#3a5}}",
      hadColor: false,
    });
  });

  /** 가드: 선택이 접두 **중간**(불릿과 공백 사이)에서 시작해도 칠하기는 접두 뒤부터다. */
  it("clamps a drag that starts inside the prefix", () => {
    const line = "- 항목";
    expect(computeLineColorEdit(line, 1, line.length, "#3a5", SYNTAX)).toEqual({
      from: 2,
      to: line.length,
      insert: "{{항목|#3a5}}",
      hadColor: false,
    });
  });

  /** 가드: 태스크·헤딩·인용·들여쓴 불릿 각각의 접두도 그대로 밖에 남는다. */
  it("keeps task, heading, quote and indented prefixes outside the wrap", () => {
    for (const [line, expected] of [
      ["- [ ] 할 일", "- [ ] {{할 일|#3a5}}"],
      ["## 제목", "## {{제목|#3a5}}"],
      ["> 인용", "> {{인용|#3a5}}"],
      ["  - 들여쓴 항목", "  - {{들여쓴 항목|#3a5}}"],
      ["1. 첫째", "1. {{첫째|#3a5}}"],
    ] as const) {
      const edit = computeLineColorEdit(line, 0, line.length, "#3a5", SYNTAX)!;
      expect(
        line.slice(0, edit.from) + edit.insert + line.slice(edit.to),
        line,
      ).toBe(expected);
    }
  });

  /** 가드: 선택이 접두 안에서만 놀면 칠할 글자가 없다(null — 본문을 건드리지 않는다). */
  it("returns null when the selection covers only the prefix", () => {
    expect(computeLineColorEdit("- 항목", 0, 2, "#3a5", SYNTAX)).toBeNull();
    expect(computeLineColorEdit("- ", 0, 2, "#3a5", SYNTAX)).toBeNull();
  });

  /**
   * 가드(기존 데이터 정규화): 접두를 이미 물고 있는 감싸기(예전 규칙으로 칠해 둔 줄)에 다른
   * 색을 주면 접두가 **밖으로 나온다** — 다시 칠하는 것만으로 목록 구조가 복구된다.
   */
  it("pulls a swallowed prefix back out when the line is repainted", () => {
    const line = "{{- 항목|#3a5}}";
    const edit = computeLineColorEdit(line, 0, line.length, "#17c", SYNTAX)!;
    expect(edit).toEqual({
      from: 0,
      to: line.length,
      insert: "- {{항목|#17c}}",
      hadColor: true,
    });
  });

  /** 가드: 해제도 같은 규칙으로 원문(`- 항목`)을 정확히 복원한다. */
  it("restores the original line when a swallowed prefix is cleared", () => {
    const line = "{{- 항목|#3a5}}";
    expect(computeLineColorEdit(line, 0, line.length, null, SYNTAX)).toEqual({
      from: 0,
      to: line.length,
      insert: "- 항목",
      hadColor: true,
    });
  });

  /**
   * 가드: 깨진 줄의 **일부만** 다시 칠해도 접두는 밖으로 나온다 — 접두를 물고 있는 감싸기는
   * 어차피 통째로 다시 써야 하므로(구분자가 바뀐다) 그 참에 정규화한다.
   */
  it("normalizes the prefix even when only part of a broken line is repainted", () => {
    const line = "{{- 하나 둘|#3a5}}";
    const from = line.indexOf("둘");
    const edit = computeLineColorEdit(line, from, from + 1, "#17c", SYNTAX)!;
    expect(line.slice(0, edit.from) + edit.insert + line.slice(edit.to)).toBe(
      "- {{하나 |#3a5}}{{둘|#17c}}",
    );
  });

  /** 가드: 결과가 어떤 모양이든 다시 파싱하면 평탄한 세그먼트로 돌아온다(중첩 없음). */
  it("always produces a body the parser reads back flat", () => {
    const line = "{{abcde|#f00}}";
    const edit = computeLineColorEdit(line, 4, 6, "#00f", SYNTAX)!;
    const next = line.slice(0, edit.from) + edit.insert + line.slice(edit.to);
    expect(next).toBe("{{ab|#f00}}{{cd|#00f}}{{e|#f00}}");
    expect(parseColorSegments(next, SYNTAX)).toEqual([
      seg("ab", "#f00"),
      seg("cd", "#00f"),
      seg("e", "#f00"),
    ]);
  });

  /**
   * 가드(핵심 회귀 — 실사용 재현): 「키 표시」로 렌더되는 키캡이 있는 줄에서 **다른 단어**에
   * 색을 줘도 키캡이 살아 있고, 그 색을 다시 해제하면 원문이 **정확히** 돌아온다.
   *
   * 예전에는 3번에서 키캡의 여는 `{{`가 색 감싸기 안으로 흡수돼 화면에서 키캡이 사라졌고,
   * 4번의 해제가 그 `{{`를 문서에서 지웠다(자동저장이 곧바로 .md에 기록한다).
   */
  it("keeps a keycap intact through a paint/clear round trip", () => {
    const line = "{{Ctrl}} 키를 누르세요";
    const from = line.indexOf("키를");
    const painted = applyEdit(
      line,
      computeLineColorEdit(line, from, from + 2, "#e33", SYNTAX)!,
    );
    expect(painted).toBe("{{Ctrl}} {{키를|#e33}} 누르세요");
    // 키캡은 그대로 평문(= 「키 표시」가 잡을 수 있는 상태), 색은 선택한 글자에만 붙는다.
    expect(parseColorSegments(painted, SYNTAX)).toEqual([
      seg("{{Ctrl}} ", null),
      seg("키를", "#e33"),
      seg(" 누르세요", null),
    ]);
    // 해제는 원문을 한 글자도 잃지 않고 되돌린다.
    const cleared = applyEdit(
      painted,
      computeLineColorEdit(painted, 0, painted.length, null, SYNTAX)!,
    );
    expect(cleared).toBe(line);
  });

  /**
   * 가드(검산): 되쓴 결과가 보이는 글자를 바꿔 버리는 줄은 **아무것도 하지 않는다**(null).
   *
   * 사용자가 본문에 `|#f00}}` 같은 꼬리를 직접 적어 두면 새 감싸기가 그 리터럴과 결합해
   * 경계가 어긋난다(`{{a|#f00}}b|#00f}}` → 화면은 `ab|#00f}}`). 그 상태를 저장하면 다음
   * 해제가 남의 글자를 지우므로, 칠하지 않는 편이 낫다 — 안 칠해진 것은 눈에 보인다.
   */
  it("refuses an edit that would change the visible characters", () => {
    const line = "a|#f00}}b";
    expect(
      computeLineColorEdit(line, 0, line.length, "#00f", SYNTAX),
    ).toBeNull();
    // 그 꼬리를 건드리지 않는 선택은 정상적으로 칠해진다(거부는 최소 범위다).
    expect(computeLineColorEdit("abc|#f00}}", 0, 3, "#00f", SYNTAX)).toEqual({
      from: 0,
      to: 3,
      insert: "{{abc|#00f}}",
      hadColor: false,
    });
  });
});

/**
 * **호스트 매처와의 교차 정합** — 같은 줄을 [`parseColorSegments`](툴바)와
 * `findPatternMatches`(호스트 렌더러)에 각각 넣어 **같은 매치**가 나오는지 본다.
 *
 * 왜 이 가드가 필요한가: 두 구현은 목적이 달라(하나는 되쓰기 좌표, 하나는 데코레이션 범위)
 * 코드를 합칠 수 없고, 실제로 규칙 하나(구분자 균형)를 한쪽에만 고치면 "화면엔 색이 있는데
 * 툴바는 없다고 본다" 또는 그 반대가 생긴다 — 색 해제가 남의 글자를 지우는 사고가 정확히
 * 그 어긋남에서 나왔다. 공유하는 규칙 조각([`isPatternBodyBalanced`])만으로는 나머지 절차
 * (앵커 전진·lazy 순서·hex 자릿수)가 같다는 보장이 없으므로, 결과로 묶어 둔다.
 */
describe("호스트 매처와의 교차 정합", () => {
  /** 호스트가 그 줄에서 잡는 색 감싸기 — (원문 범위, 글자, 색). */
  const hostWraps = (
    line: string,
  ): { from: number; to: number; text: string; color: string }[] =>
    findPatternMatches(line, SYNTAX.open, SYNTAX.close, undefined, PARAM).map(
      (m) => ({
        from: m.from,
        to: m.to,
        text: line.slice(m.first.from, m.first.to),
        color: line.slice(m.param!.from, m.param!.to),
      }),
    );

  /** 툴바가 그 줄에서 보는 색 감싸기 — 세그먼트를 같은 모양(원문 범위)으로 환산한다. */
  const toolbarWraps = (
    line: string,
  ): { from: number; to: number; text: string; color: string }[] => {
    const out: { from: number; to: number; text: string; color: string }[] = [];
    let pos = 0;
    for (const s of parseColorSegments(line, SYNTAX)) {
      const raw =
        s.color === null
          ? s.text
          : `${SYNTAX.open}${s.text}${SYNTAX.prefix}${s.color}${SYNTAX.close}`;
      if (s.color !== null) {
        out.push({
          from: pos,
          to: pos + raw.length,
          text: s.text,
          color: s.color,
        });
      }
      pos += raw.length;
    }
    return out;
  };

  /** 어긋나기 쉬운 모양을 손으로 모은 표(퍼즈가 만들기 어려운 조합까지 못박는다). */
  const LINES = [
    "",
    "그냥 글자",
    "{{할일|#e33}}",
    "앞 {{할일|#e33}} 뒤",
    "{{a|#111}}{{b|#222222}}",
    "{{Cmd+C}} {{할일|#e33}}", // 키캡 → 색(삼킴이 있던 순서)
    "{{할일|#e33}} {{Cmd+C}}", // 색 → 키캡(예전에도 통과하던 순서)
    "{{Cmd+C}} 를 눌러 {{할일|#e33}} 확인",
    "{{a|#gg}} {{b|#f00}}", // 앞쪽 hex 오타
    "{{보라 {{Ctrl+C}}|#3a5}}", // 진짜 중첩(균형이 맞는다)
    "{{{{앞|#00f}}뒤|#f00}}",
    "{{a|b|#e33}}",
    "{{할일|#ff}}",
    "할일|#e33}}",
    "{{ 그리고 {{a|#f00}}",
    "}}{{a|#f00}}",
    "{{a|#f00}}}}",
    "- {{항목|#3a5}}",
  ];

  it.each(LINES)("agrees with the host on %j", (line) => {
    expect(toolbarWraps(line)).toEqual(hostWraps(line));
  });
});

/**
 * **왕복 불변식(퍼즈)** — 칠하기·해제는 화면에 보이는 글자를 단 한 글자도 바꾸지 않는다.
 *
 * 이 파이프라인이 지켜야 하는 것은 "예쁘게 칠한다"가 아니라 **글자를 잃지 않는다**이다.
 * 사용자는 본문에 구분자 리터럴(`{{`·`}}`·`|#e33}}`)을 얼마든지 적을 수 있고, 다른 플러그인
 * (「키 표시」)도 같은 `{{…}}`를 쓴다. 그런 줄을 재료로 무작위 선택에 색을 주고 다시 벗겨
 * 보면서, 어떤 순서로도 원문 글자가 사라지지 않는지를 본다 — 실제 손실 사고가 전부 이
 * 조합에서 나왔다.
 */
describe("왕복 불변식(퍼즈) — 색 적용·해제는 원문 글자를 잃지 않는다", () => {
  /** 재현 가능한 난수(mulberry32) — 실패하면 같은 시드로 정확히 같은 입력이 나온다. */
  const rng = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** 조각들 — 구분자 리터럴·키캡·이미 칠해진 감싸기·구조 접두를 섞는다. */
  const PIECES = [
    "{{",
    "}}",
    "|",
    "#e33",
    "|#e33}}",
    "{{a|#f00}}",
    "{{Ctrl}}",
    "{{a|#gg}}",
    "가나",
    "abc",
    " ",
    "- ",
    "[[링크]]",
  ];

  /** 그 줄에서 화면에 보이는 글자(구분자·색 표기를 뺀 평문). */
  const plainOf = (line: string): string =>
    parseColorSegments(line, SYNTAX)
      .map((s) => s.text)
      .join("");

  it("never changes the visible characters, whatever is painted or cleared", () => {
    const rand = rng(20260816);
    let painted = 0; // 실제로 무언가 칠해진 횟수(퍼즈가 헛돌지 않았는지 확인용).
    for (let i = 0; i < 400; i++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(rand() * 5);
      for (let k = 0; k < n; k++) {
        parts.push(PIECES[Math.floor(rand() * PIECES.length)]);
      }
      const line = parts.join("");
      const from = Math.floor(rand() * (line.length + 1));
      const to = Math.floor(rand() * (line.length + 1));
      const color = rand() < 0.5 ? "#17c" : null;
      const edit = computeLineColorEdit(line, from, to, color, SYNTAX);
      if (edit === null) continue;
      const next = applyEdit(line, edit);
      // (1) 보이는 글자는 그대로다 — 이 파이프라인의 유일한 안전 보증.
      expect(plainOf(next), `${line} [${from},${to}) ← ${color}`).toBe(
        plainOf(line),
      );
      if (color === null) continue;
      painted++;
      // (2) 칠하기 전에 색이 없던 줄은 **해제로 원문이 정확히 복원**된다.
      if (parseColorSegments(line, SYNTAX).every((s) => s.color === null)) {
        const back = computeLineColorEdit(next, 0, next.length, null, SYNTAX);
        expect(back, `${line} [${from},${to})`).not.toBeNull();
        expect(applyEdit(next, back!), `${line} [${from},${to})`).toBe(line);
      }
    }
    expect(painted).toBeGreaterThan(50);
  });
});
