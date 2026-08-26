import { describe, it, expect } from "vitest";
import { EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildPluginEditorExtension,
  findPatternMatches,
  matchCompletionTrigger,
  patternBodyResyncOffset,
  parseInlinePatternShape,
  type CompletionDescriptor,
  type InlinePatternDescriptor,
  type InlinePatternParam,
} from "./editor-api";
import type { BlockEmbedDescriptor } from "./embed";

/** 매치의 한 토막을 원문에서 잘라 낸다(범위 → 문자열). */
const part = (text: string, span: { from: number; to: number }): string =>
  text.slice(span.from, span.to);

describe("findPatternMatches", () => {
  /** 가드: open/close 구분자 사이 대상과 위치를 정확히 찾는다. */
  it("finds delimiter targets with positions", () => {
    const text = "see [[Alpha]] and [[Beta]] end";
    const matches = findPatternMatches(text, "[[", "]]");
    expect(matches).toHaveLength(2);
    expect(part(text, matches[0].first)).toBe("Alpha");
    expect(part(text, matches[1].first)).toBe("Beta");
    expect(text.slice(matches[0].from, matches[0].to)).toBe("[[Alpha]]");
    // 두 토막 패턴에는 둘째 캡처가 없다.
    expect(matches[0].second).toBeUndefined();
  });

  /** 가드: 매치가 없으면 빈 배열. */
  it("returns nothing when there is no match", () => {
    expect(findPatternMatches("plain text", "[[", "]]")).toEqual([]);
  });

  /** 가드: 구분자는 리터럴로 이스케이프된다(정규식 메타문자도 안전). */
  it("treats delimiters as literals", () => {
    const matches = findPatternMatches("a (x) b", "(", ")");
    expect(matches).toHaveLength(1);
    expect(part("a (x) b", matches[0].first)).toBe("x");
  });

  /** 가드: 빈 구분자는 매치 없음(잘못된 패턴 방어). */
  it("returns nothing for empty delimiters", () => {
    expect(findPatternMatches("anything", "", "]]")).toEqual([]);
  });
});

describe("findPatternMatches (세 토막 — mid)", () => {
  /** 가드: `[텍스트](url)` 모양에서 두 토막을 각각 정확히 잡는다. */
  it("captures both parts of a three-part pattern", () => {
    const text = "see [구글](https://g.example) end";
    const matches = findPatternMatches(text, "[", ")", "](");
    expect(matches).toHaveLength(1);
    expect(part(text, matches[0].first)).toBe("구글");
    expect(part(text, matches[0].second!)).toBe("https://g.example");
    expect(text.slice(matches[0].from, matches[0].to)).toBe(
      "[구글](https://g.example)",
    );
  });

  /** 가드: 한 줄에 여러 개가 있어도 각각 독립적으로 잡는다(lazy 매칭이 둘을 삼키지 않는다). */
  it("keeps consecutive matches separate", () => {
    const text = "[a](u1) 그리고 [b](u2)";
    const matches = findPatternMatches(text, "[", ")", "](");
    expect(matches).toHaveLength(2);
    expect(part(text, matches[0].second!)).toBe("u1");
    expect(part(text, matches[1].second!)).toBe("u2");
  });

  /** 가드: 토막 하나가 비면(`[]()`) 매치되지 않는다 — `.+?`는 최소 한 글자를 요구한다. */
  it("does not match when a part is empty", () => {
    expect(findPatternMatches("[]()", "[", ")", "](")).toEqual([]);
    expect(findPatternMatches("[a]()", "[", ")", "](")).toEqual([]);
    expect(findPatternMatches("[](u)", "[", ")", "](")).toEqual([]);
  });

  /** 가드: 빈 mid는 매치 없음(두 토막으로 조용히 되돌아가지 않는다). */
  it("returns nothing for an empty mid", () => {
    expect(findPatternMatches("[a](b)", "[", ")", "")).toEqual([]);
  });
});

describe("findPatternMatches (파라미터화 꼬리 — param)", () => {
  const HEX: InlinePatternParam = {
    prefix: "|",
    format: "hex-color",
    apply: "color",
  };

  /** 가드(핵심): `close` 앞의 값이 별도 캡처로 잡히고, 3자리·6자리를 모두 받는다 — 등록
   * 하나로 임의 색을 표현한다는 이 기능의 존재 이유다. */
  it("captures a 3- or 6-digit hex tail as its own span", () => {
    for (const [text, inner, hex] of [
      ["{{할일|#f36}}", "할일", "#f36"],
      ["{{할일|#ff3366}}", "할일", "#ff3366"],
      ["{{a|#ABCDEF}}", "a", "#ABCDEF"],
    ] as const) {
      const [m] = findPatternMatches(text, "{{", "}}", undefined, HEX);
      expect(m, text).toBeDefined();
      expect(text.slice(m.from, m.to)).toBe(text);
      expect(part(text, m.first)).toBe(inner);
      expect(part(text, m.param!)).toBe(hex);
    }
  });

  /** 가드: 값이 형식에 안 맞으면 그 구간은 **아예 매치되지 않는다** — 잘못된 값이 스타일로
   * 새는 대신 원문이 그대로 남는다. */
  it("does not match when the tail value breaks the format", () => {
    for (const text of [
      "{{할일|#ff}}",
      "{{할일|#ffff}}",
      "{{할일|#fffffff}}",
      "{{할일|red}}",
      "{{할일|#12345g}}",
      "{{할일}}", // 꼬리 자체가 없다
    ]) {
      expect(
        findPatternMatches(text, "{{", "}}", undefined, HEX),
        text,
      ).toEqual([]);
    }
  });

  /** 가드: 한 줄에 값이 다른 매치가 여럿이면 각각 독립적으로 잡힌다(lazy 매칭이 삼키지 않는다). */
  it("keeps consecutive parameterized matches separate", () => {
    const text = "{{a|#111}} 그리고 {{b|#222222}}";
    const matches = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(matches).toHaveLength(2);
    expect(part(text, matches[0].param!)).toBe("#111");
    expect(part(text, matches[1].param!)).toBe("#222222");
  });

  /** 가드: 세 토막(mid)과도 조합된다 — 파라미터는 언제나 `close` 바로 앞이고 캡처는 마지막이다. */
  it("combines with a three-part pattern, capturing the tail last", () => {
    const text = "[구글](https://g.example|#0a0)";
    const [m] = findPatternMatches(text, "[", ")", "](", HEX);
    expect(part(text, m.first)).toBe("구글");
    expect(part(text, m.second!)).toBe("https://g.example");
    expect(part(text, m.param!)).toBe("#0a0");
  });

  /** 가드(방어): 모르는 형식·빈 prefix는 매치 없음이다 — 등록 시점에 이미 거부되지만
   * 매니페스트·스냅샷 경로로 들어온 값까지 믿지 않는다(`findPatternMatches`가 마지막 관문). */
  it("returns nothing for an unknown format or an empty prefix", () => {
    expect(
      findPatternMatches("{{a|#f36}}", "{{", "}}", undefined, {
        prefix: "|",
        format: "css-color",
      }),
    ).toEqual([]);
    expect(
      findPatternMatches("{{a|#f36}}", "{{", "}}", undefined, {
        prefix: "",
        format: "hex-color",
      }),
    ).toEqual([]);
  });

  /** 가드(하위호환): `param`을 주지 않으면 예전과 완전히 같은 결과다. */
  it("is byte-for-byte the old behaviour without a param", () => {
    const text = "see [[Alpha]] and [[Beta]] end";
    expect(findPatternMatches(text, "[[", "]]", undefined, undefined)).toEqual(
      findPatternMatches(text, "[[", "]]"),
    );
    expect(findPatternMatches(text, "[[", "]]")[0].param).toBeUndefined();
  });
});

describe("patternBodyResyncOffset", () => {
  /** 가드: 본문 안에서 스스로 여닫는 중첩은 통과한다(진짜 중첩을 죽이지 않는다). */
  it("accepts a body whose delimiters close themselves", () => {
    expect(
      patternBodyResyncOffset("보라 {{Ctrl+C}}|#3a5", "{{", "}}"),
    ).toBeNull();
    expect(patternBodyResyncOffset("그냥 글자", "{{", "}}")).toBeNull();
    expect(patternBodyResyncOffset("", "{{", "}}")).toBeNull();
    expect(patternBodyResyncOffset("{{a}}{{b}}", "{{", "}}")).toBeNull();
  });

  /**
   * 가드(핵심): 짝 없는 닫기는 이 후보가 **앞선 매치를 삼키고 있다**는 증거다 — 되짚기 자리는
   * 그 닫기 자리다(그보다 앞에서 시작하는 후보도 같은 닫기를 같은 이유로 문다).
   */
  it("resyncs at an unmatched close", () => {
    expect(patternBodyResyncOffset("Cmd+C}} {{할일|#e33", "{{", "}}")).toBe(5);
    expect(patternBodyResyncOffset("a}}", "{{", "}}")).toBe(1);
  });

  /** 가드: 닫히지 않은 열기가 남으면 **가장 안쪽 열기**가 진짜 매치의 시작이다. */
  it("resyncs at the innermost dangling open", () => {
    expect(patternBodyResyncOffset(" 그리고 {{a|#f00", "{{", "}}")).toBe(5);
    // 열기가 여럿 남으면 가장 안쪽(마지막)이다 — 바깥 것들은 어차피 같은 이유로 죽는다.
    expect(patternBodyResyncOffset("{{ {{ x", "{{", "}}")).toBe(3);
  });

  /** 가드: 여닫이가 같은 문법은 깊이를 셀 수 없어 규칙에서 빠진다(lazy가 첫 닫기에서 멎는다). */
  it("does not apply to patterns whose delimiters are identical", () => {
    expect(patternBodyResyncOffset("a==b", "==", "==")).toBeNull();
    expect(patternBodyResyncOffset("a", "", "")).toBeNull();
  });
});

/**
 * **구분자 균형** — lazy 본문이 `close`를 넘어 앞선 매치를 삼키던 결함의 가드.
 *
 * 왜 이 결함이 눈에 띄지 않았나: 「글자 색」처럼 `close` 앞에 꼬리를 요구하는 패턴에서만
 * 본문이 `close`를 넘을 수 있고, 그것도 **색이 뒤에 오는 순서**에서만 터졌다. 기존 가드는
 * 전부 색을 앞에 둔 순서(`{{할일|#e33}} {{Cmd+C}}`)만 봤다 — 그 순서에서는 lazy 매칭이 첫
 * `|#hex}}`에서 정확히 멎어 통과한다.
 */
describe("findPatternMatches (구분자 균형 — 앞선 매치 삼킴 방지)", () => {
  const HEX: InlinePatternParam = {
    prefix: "|",
    format: "hex-color",
    apply: "color",
  };

  /** 가드(핵심 회귀): 앞에 놓인 `{{…}}`를 색 매치가 삼키지 않는다 — 색은 자기 감싸기만 잡는다. */
  it("does not swallow an earlier {{…}} that has no color tail", () => {
    const text = "{{Cmd+C}} {{할일|#e33}}";
    const matches = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].from, matches[0].to)).toBe("{{할일|#e33}}");
    expect(part(text, matches[0].first)).toBe("할일");
    // 그 줄의 키캡(꼬리 없는 같은 구분자)은 예전 그대로 온전히 잡힌다.
    expect(
      findPatternMatches(text, "{{", "}}").map((m) => part(text, m.first)),
    ).toEqual(["Cmd+C", "할일|#e33"]);
  });

  /** 가드: 사이에 글자가 끼어도 같다(삼킴은 거리와 무관했다). */
  it("does not swallow across intervening text", () => {
    const text = "{{Cmd+C}} 를 눌러 {{할일|#e33}} 확인";
    const matches = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(matches).toHaveLength(1);
    expect(part(text, matches[0].first)).toBe("할일");
  });

  /** 가드: 앞쪽 감싸기가 hex 오타로 매치에 실패한 경우도 뒤쪽만 잡힌다. */
  it("does not swallow an earlier wrap whose hex is malformed", () => {
    const text = "{{a|#gg}} {{b|#f00}}";
    const matches = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(matches).toHaveLength(1);
    expect(part(text, matches[0].first)).toBe("b");
  });

  /** 가드(무회귀 — 진짜 중첩): 본문 안에서 스스로 닫히는 중첩은 계속 바깥이 이긴다. */
  it("keeps a genuinely nested body as one outer match", () => {
    const text = "{{보라 {{Ctrl+C}}|#3a5}}";
    const [m] = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(text.slice(m.from, m.to)).toBe(text);
    expect(part(text, m.first)).toBe("보라 {{Ctrl+C}}");
  });

  /** 가드(무회귀): 색이 앞에 오는 순서는 예전과 한 글자도 다르지 않다. */
  it("is unchanged when the colored wrap comes first", () => {
    const text = "{{할일|#e33}} {{Cmd+C}}";
    const matches = findPatternMatches(text, "{{", "}}", undefined, HEX);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].from, matches[0].to)).toBe("{{할일|#e33}}");
  });

  /**
   * 가드: 꼬리가 없는 패턴에도 같은 규칙이 산다 — 닫히지 않은 열기로 시작하는 후보는 버리고
   * **안쪽**을 잡는다(`{{outer {{inner}}`의 키캡은 `inner`다).
   */
  it("prefers the inner match when an outer body leaves an open dangling", () => {
    const text = "{{outer {{inner}}";
    const matches = findPatternMatches(text, "{{", "}}");
    expect(matches).toHaveLength(1);
    expect(part(text, matches[0].first)).toBe("inner");
  });

  /** 가드: 세 토막 패턴도 같다 — 위키링크 두 개를 마크다운 링크가 삼키지 않는다. */
  it("applies to three-part patterns as well", () => {
    const text = "[[Alpha]] and [b](u)";
    const matches = findPatternMatches(text, "[", ")", "](");
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].from, matches[0].to)).toBe("[b](u)");
  });

  /** 가드: 여닫이가 같은 문법(`==`)은 규칙에서 빠져 예전 그대로 동작한다. */
  it("leaves identical-delimiter patterns untouched", () => {
    const text = "이건 ==중요== 하고 ==저건== 아니다";
    expect(
      findPatternMatches(text, "==", "==").map((m) => part(text, m.first)),
    ).toEqual(["중요", "저건"]);
  });
});

describe("parseInlinePatternShape", () => {
  /** 가드: 두 토막 등록의 기본값 — label·target은 첫 토막, 동작은 노트 열기. */
  it("defaults a two-part pattern to the first part and open-note", () => {
    const r = parseInlinePatternShape({ open: "==", close: "==" });
    expect(r.ok && r.shape).toEqual({
      open: "==",
      close: "==",
      label: "first",
      target: "first",
      action: "open-note",
    });
  });

  /** 가드: 세 토막이면 target 기본값이 둘째 토막으로 바뀐다(마크다운 링크 모양). */
  it("defaults a three-part pattern's target to the second part", () => {
    const r = parseInlinePatternShape({ open: "[", mid: "](", close: ")" });
    expect(r.ok && r.shape.label).toBe("first");
    expect(r.ok && r.shape.target).toBe("second");
  });

  /** 가드: 예전의 무음 실패를 거부한다 — 구분자는 비어있지 않은 문자열이어야 한다. */
  it("rejects missing or non-string delimiters", () => {
    for (const args of [
      {},
      { open: "[", close: "" },
      { open: "", close: ")" },
      { open: 3, close: ")" },
      { open: "[", close: {} },
    ]) {
      const r = parseInlinePatternShape(args as Record<string, unknown>);
      expect(r.ok, JSON.stringify(args)).toBe(false);
    }
  });

  /** 가드: 지나치게 긴 구분자·줄바꿈 구분자는 거부한다(구분자 자리에 본문을 넣은 경우). */
  it("rejects delimiters that are too long or contain newlines", () => {
    expect(parseInlinePatternShape({ open: "=========", close: "=" }).ok).toBe(
      false,
    );
    expect(parseInlinePatternShape({ open: "=", close: "\n" }).ok).toBe(false);
  });

  /** 가드: 없는 토막(`"second"` without `mid`)을 가리키면 거부한다 — 조용히 안 뜨지 않는다. */
  it("rejects second-part references without a mid", () => {
    const r = parseInlinePatternShape({
      open: "[",
      close: "]",
      label: "second",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe("label");
  });

  /** 가드: 동작·토막 어휘 밖 값은 기본값으로 흡수되지 않고 거부된다(무음 실패 방지). */
  it("rejects unknown action and part values", () => {
    expect(
      parseInlinePatternShape({ open: "[", close: "]", action: "open-link" })
        .ok,
    ).toBe(false);
    expect(
      parseInlinePatternShape({ open: "[", close: "]", target: "third" }).ok,
    ).toBe(false);
  });

  /** 가드(하위호환): `param`을 주지 않은 기존 등록은 결과 shape에 그 키가 아예 없다 —
   * 스냅샷 직렬화·비교(`toEqual`)에 새 필드가 조용히 끼어들지 않는다. */
  it("omits param entirely when it is not given", () => {
    const r = parseInlinePatternShape({ open: "==", close: "==" });
    expect(r.ok && "param" in r.shape).toBe(false);
  });

  /** 가드(핵심): 파라미터화 등록이 통과하고, 정규화된 그대로 shape에 실린다. */
  it("accepts a parameterized tail and carries it through", () => {
    const r = parseInlinePatternShape({
      open: "{{",
      close: "}}",
      param: { prefix: "|", format: "hex-color", apply: "color" },
      action: "none",
    });
    expect(r.ok && r.shape).toEqual({
      open: "{{",
      close: "}}",
      param: { prefix: "|", format: "hex-color", apply: "color" },
      label: "first",
      target: "first",
      action: "none",
    });
  });

  /** 가드: `apply`는 선택이다 — 없으면 값은 매칭만 좁히고 스타일에는 관여하지 않는다. */
  it("allows a param without apply", () => {
    const r = parseInlinePatternShape({
      open: "{{",
      close: "}}",
      param: { prefix: "|", format: "hex-color" },
    });
    expect(r.ok && r.shape.param).toEqual({
      prefix: "|",
      format: "hex-color",
    });
  });

  /** 가드(보안·무음 실패 방지): 형식·반영 속성은 **닫힌 어휘**다. 어휘 밖 값을 조용히
   * 무시하면 "등록은 됐는데 아무것도 안 칠해진다"가 되고, 자유 정규식·자유 CSS 속성을
   * 받아 주면 ReDoS·임의 CSS 주입 표면이 생긴다 — 둘 다 등록 시점에 거부한다. */
  it("rejects a param with an unknown format, a non-color apply, or a raw regex", () => {
    const bad: [string, unknown][] = [
      ["param.format", { prefix: "|", format: "css-color", apply: "color" }],
      ["param.format", { prefix: "|", format: "#(.+)", apply: "color" }],
      ["param.format", { prefix: "|", apply: "color" }],
      // 색 값을 받지 않는 속성 — 형식이 hex뿐이라 언제나 무음 실패가 된다.
      ["param.apply", { prefix: "|", format: "hex-color", apply: "fontSize" }],
      // 화이트리스트 밖 CSS 속성(임의 CSS 주입 시도).
      ["param.apply", { prefix: "|", format: "hex-color", apply: "content" }],
      ["param.apply", { prefix: "|", format: "hex-color", apply: 3 }],
      // 구분자 규칙은 open/close와 같다.
      ["param.prefix", { prefix: "", format: "hex-color" }],
      ["param.prefix", { prefix: "|||||||||", format: "hex-color" }],
      ["param.prefix", { prefix: "\n", format: "hex-color" }],
      ["param.prefix", { format: "hex-color" }],
    ];
    for (const [field, param] of bad) {
      const r = parseInlinePatternShape({ open: "{{", close: "}}", param });
      expect(r.ok, JSON.stringify(param)).toBe(false);
      expect(!r.ok && r.field, JSON.stringify(param)).toBe(field);
    }
    // param 자체가 객체가 아니어도 거부한다.
    for (const param of ["hex", 3, [], null]) {
      const r = parseInlinePatternShape({ open: "{{", close: "}}", param });
      expect(r.ok, JSON.stringify(param)).toBe(false);
    }
  });

  /** 가드: 마크다운 링크 모양 전체가 통과한다(이 기능의 목적지). */
  it("accepts a full markdown-link shape", () => {
    const r = parseInlinePatternShape({
      open: "[",
      mid: "](",
      close: ")",
      label: "first",
      target: "second",
      action: "open-url",
    });
    expect(r.ok && r.shape).toEqual({
      open: "[",
      mid: "](",
      close: ")",
      label: "first",
      target: "second",
      action: "open-url",
    });
  });
});

describe("matchCompletionTrigger (트리거 일반화)", () => {
  const completion = (
    id: string,
    trigger: string,
    wrap: string,
  ): CompletionDescriptor => ({ id, trigger, wrap, source: "note-titles" });

  const WIKILINK = completion("wl", "[[", "[[%]]");

  /** 가드(회귀 없음): 유일한 기존 사용처(wikilink 번들)의 동작이 그대로 보존된다. */
  it("keeps the wikilink behaviour that used to be hard-coded", () => {
    const hit = matchCompletionTrigger("보라 [[Al", [WIKILINK]);
    expect(hit).toMatchObject({ from: 3, query: "Al" });
    expect(hit?.completion.id).toBe("wl");
  });

  /** 가드(핵심 결함): `[[`가 아닌 트리거도 실제로 매칭된다 — 예전에는 팝업만 뜨고 후보가
   *  영원히 0개인, 오류도 안 나는 무음 실패였다(AI 저작이 가장 확실하게 실패하던 지점). */
  it("matches a non-bracket trigger such as @", () => {
    const hit = matchCompletionTrigger("안녕 @동", [
      completion("m", "@", "@%"),
    ]);
    expect(hit).toMatchObject({ from: 3, query: "동" });
  });

  /** 가드: 이미 닫힌 패턴 안에서는 다시 열리지 않는다(`wrap`의 `%` 뒤 문자열로 판정) —
   *  예전 하드코딩 정규식 `\[\[[^\]]*$`가 우연히 하던 일의 일반화다. */
  it("does not reopen inside an already-closed pattern", () => {
    expect(matchCompletionTrigger("보라 [[Alpha]] 끝", [WIKILINK])).toBeNull();
  });

  /** 가드: 커서에서 가장 가까운(마지막) 트리거를 쓴다. */
  it("uses the trigger nearest the cursor", () => {
    const hit = matchCompletionTrigger("[[A]] 그리고 [[B", [WIKILINK]);
    expect(hit?.query).toBe("B");
  });

  /** 가드(충돌 규칙): 더 긴 trigger가 이긴다 — `[`와 `[[`가 함께 등록돼도 `[[`가 잡는다. */
  it("prefers the longer trigger on a conflict", () => {
    const short = completion("s", "[", "[%]");
    const hit = matchCompletionTrigger("x [[Al", [short, WIKILINK]);
    expect(hit?.completion.id).toBe("wl");
  });

  /**
   * 가드(파괴적 회귀): 서로 다른 트리거가 한 줄에 있으면 **커서에 가까운 쪽**이 이긴다.
   *
   * 왜: 승자를 trigger 길이·등록 순서로만 고르던 때는 `@alice #ta`에서 `#`을 친 사용자에게
   * 줄 앞쪽 `@`의 후보가 떴고, 하나를 고르면 치환 시작점이 승자의 `from`(=0)이라
   * `@alice #ta` 전체가 남의 `wrap`으로 갈아치워졌다 — 오류도 진단도 남지 않았다.
   */
  it("prefers the trigger nearest the cursor over a longer/earlier one", () => {
    const mention = completion("m", "@", "@%");
    const tag = completion("t", "#", "#%");
    const hit = matchCompletionTrigger("@alice #ta", [mention, tag]);
    expect(hit).toMatchObject({ from: 7, query: "ta" });
    expect(hit?.completion.id).toBe("t");
    // 등록 순서를 뒤집어도 결과가 같다(순서에 좌우되지 않는다).
    expect(
      matchCompletionTrigger("@alice #ta", [tag, mention])?.completion.id,
    ).toBe("t");
  });

  /** 가드: 더 긴 trigger(번들 `[[`)라도 커서에서 멀면 지지 않는다 — 닫히지 않은 `[[`가
   *  줄 앞에 남아 있어도 방금 연 `@`가 이긴다. */
  it("does not let a stale unclosed [[ swallow a fresh @ trigger", () => {
    const mention = completion("m", "@", "@%");
    const hit = matchCompletionTrigger("[[unclosed then @ali", [
      mention,
      WIKILINK,
    ]);
    expect(hit?.completion.id).toBe("m");
    expect(hit?.query).toBe("ali");
  });

  /** 가드(충돌 규칙): 길이가 같으면 먼저 등록한 쪽이 이긴다(결정적 순서). */
  it("prefers the earlier registration when triggers tie", () => {
    const first = completion("first", "@", "@%");
    const second = completion("second", "@", "<%>");
    expect(matchCompletionTrigger("@a", [first, second])?.completion.id).toBe(
      "first",
    );
  });

  /** 가드(방어): 트리거 뒤 쿼리가 상한(120자)을 넘으면 매칭하지 않는다 — 짧은 트리거가
   *  줄 앞쪽의 우연한 한 글자까지 잡아 커서에서 먼 곳부터 통째로 치환하는 사고를 막는다. */
  it("gives up when the query grows past the cap", () => {
    expect(
      matchCompletionTrigger(`@${"가".repeat(121)}`, [
        completion("m", "@", "@%"),
      ]),
    ).toBeNull();
  });

  /** 가드: 빈 트리거 등록은 무시된다(모든 위치에 매칭되는 사고 방지). */
  it("ignores empty triggers", () => {
    expect(
      matchCompletionTrigger("아무거나", [completion("x", "", "%")]),
    ).toBeNull();
  });

  /** 가드(버그 수정): 매칭된 **그 등록의** wrap이 쓰이고, `%`가 여러 개면 전부 치환된다 —
   *  예전엔 항상 첫 등록의 wrap이었고 `%`는 첫 하나만 바뀌었다. */
  it("resolves the matched registration's wrap with every % substituted", () => {
    const mention = completion("m", "@", "@%(%)");
    const hit = matchCompletionTrigger("x [[A", [mention, WIKILINK]);
    expect(hit?.completion.wrap).toBe("[[%]]");
    expect(mention.wrap.split("%").join("동")).toBe("@동(동)");
  });
});

describe("buildPluginEditorExtension (블록 임베드 분기)", () => {
  const services = {
    noteTitles: async () => [],
    openByTitle: () => {},
    openUrl: () => {},
    allowEmbedDomain: () => true,
  };
  const DESCRIPTOR: BlockEmbedDescriptor = {
    id: "vid",
    fence: "vid",
    sources: [{ host: "watch.example", queryParam: "v" }],
    embedTemplate: "https://embed.example/e/{id}",
  };

  /** 확장 배열의 임베드 자리(세 번째 요소)를 꺼낸다. */
  const embedSlot = (embeds: BlockEmbedDescriptor[]): unknown =>
    (
      buildPluginEditorExtension([], [], embeds, services) as readonly unknown[]
    )[2];

  /** 가드: 임베드 0건이면 StateField를 아예 만들지 않는다(선택 변경마다 도는 스캔 방지). */
  it("creates no embed field when no embeds are registered", () => {
    expect(embedSlot([])).toEqual([]);
  });

  /** 가드: 임베드가 있으면 블록 임베드 StateField가 생성된다. */
  it("creates the embed StateField when embeds exist", () => {
    expect(embedSlot([DESCRIPTOR])).toBeInstanceOf(StateField);
  });

  /** 가드(의도 고정): 확장 생성 "후"의 늦은 등록은 무시된다 — 로더가 sandbox.ready를
   * 기다린 뒤 확장을 만들므로, 그 이후의 비동기 등록은 지원하지 않는 게 계약이다. */
  it("ignores embeds registered after the extension is built", () => {
    const embeds: BlockEmbedDescriptor[] = [];
    const slot = embedSlot(embeds);
    embeds.push(DESCRIPTOR); // 늦은 등록 시뮬레이션(이미 빈 분기로 확정된 뒤).
    expect(slot).toEqual([]);
  });
});

describe("인라인 패턴 데코레이션(파라미터 스타일이 실제 DOM에 닿는가)", () => {
  const services = {
    noteTitles: async () => [],
    openByTitle: () => {},
    openUrl: () => {},
    allowEmbedDomain: () => true,
  };

  /** 문서를 실제 CM 뷰로 그리고(커서는 마지막 줄 — 첫 줄은 라이브 프리뷰가 적용된다)
   * 패턴 클래스가 붙은 요소의 글자와 **실제 계산된 색**을 돌려준다(style 속성이 아예 없으면
   * 빈 문자열 — 브라우저가 hex를 rgb로 정규화하므로 원문 비교 대신 색 자체를 본다). */
  const render = (
    doc: string,
    patterns: InlinePatternDescriptor[],
  ): { text: string; color: string }[] => {
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 }, // 마지막(빈) 줄에 커서 — 첫 줄은 렌더된다.
        extensions: [buildPluginEditorExtension(patterns, [], [], services)],
      }),
      parent: document.body,
    });
    const out = [
      ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-x-p-p"),
    ].map((el) => ({ text: el.textContent ?? "", color: el.style.color }));
    view.destroy();
    return out;
  };

  const TEXT_COLOR: InlinePatternDescriptor = {
    id: "p",
    open: "{{",
    close: "}}",
    param: { prefix: "|", format: "hex-color", apply: "color" },
    className: "cm-x-p-p",
    action: "none",
  };

  /** 가드(핵심 — 이 기능의 목적지): 본문에 적힌 색이 그 매치에만 붙는 인라인 스타일로
   * 실제 DOM에 닿고, 구분자·색 코드는 화면에서 사라진다. 3자리·6자리·임의 색 모두. */
  it("paints each match with the hex written in the document", () => {
    expect(render("{{할일|#f36}} 그리고 {{끝|#123456}}", [TEXT_COLOR])).toEqual(
      [
        { text: "할일", color: "rgb(255, 51, 102)" }, // 3자리
        { text: "끝", color: "rgb(18, 52, 86)" }, // 6자리 — 예전에는 표현 불가였다.
      ],
    );
  });

  /** 가드(보안): 색 자리에 CSS를 밀어 넣으려는 본문은 **매치되지 않아** 원문 그대로 남는다 —
   * 데코레이션도, style 속성도 생기지 않는다. */
  it("renders nothing for a body that tries to smuggle CSS into the color slot", () => {
    expect(
      render("{{x|#f36;background:url(https://evil.example)}}", [TEXT_COLOR]),
    ).toEqual([]);
    expect(render("{{x|red}}", [TEXT_COLOR])).toEqual([]);
  });

  /** 가드(하위호환): `param` 없는 기존 등록은 style 속성 없이 클래스만 붙는다(스타일은
   * `.className` 규칙으로 따로 주입된다 — 예전과 같은 경로). */
  it("adds no style attribute for a plain (non-parameterized) pattern", () => {
    const doc = "보라 ==중요== 끝";
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 },
        extensions: [
          buildPluginEditorExtension(
            [
              {
                id: "p",
                open: "==",
                close: "==",
                className: "cm-x-p-p",
                action: "none",
              },
            ],
            [],
            [],
            services,
          ),
        ],
      }),
      parent: document.body,
    });
    const el = view.contentDOM.querySelector(".cm-x-p-p")!;
    expect(el.textContent).toBe("중요");
    expect(el.hasAttribute("style")).toBe(false);
    view.destroy();
  });

  /**
   * 가드(중첩 — 규칙 그 자체): 채택된 매치의 **라벨 안에 완전히 들어가는** 매치는 버려지지
   * 않고 함께 그려진다. 바깥 mark와 안쪽 mark가 CM에서 자연히 겹쳐, 안쪽 요소가 자기 클래스와
   * 링크 표식을 그대로 갖는다(번들 조합에 기대지 않는 최소 재현).
   */
  it("renders a match nested inside another match's label", () => {
    const outer: InlinePatternDescriptor = {
      id: "o",
      open: "<<",
      close: ">>",
      className: "cm-x-o-o",
      action: "none",
    };
    const inner: InlinePatternDescriptor = {
      id: "i",
      open: "[[",
      close: "]]",
      className: "cm-x-i-i",
      action: "open-note",
    };
    const doc = "<<앞 [[속]] 뒤>>";
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 },
        extensions: [
          buildPluginEditorExtension([outer, inner], [], [], services),
        ],
      }),
      parent: document.body,
    });
    const wrap = view.contentDOM.querySelector<HTMLElement>(".cm-x-o-o")!;
    expect(wrap.textContent).toBe("앞 속 뒤"); // 안쪽 구분자도 함께 숨는다.
    const nested = wrap.querySelector<HTMLElement>(".cm-x-i-i")!;
    expect(nested.textContent).toBe("속");
    expect(nested.dataset.linkTarget).toBe("속");
    view.destroy();
  });

  /**
   * 가드(중첩 상한): 재귀는 톱레벨 아래로 **두 겹까지만** 판다. 네 겹으로 적은 본문은 셋째
   * 겹까지 그려지고 그 안쪽은 원문으로 남는다 — 상한이 실제로 발화하는지를 고정한다(상한이
   * 없어도 재귀는 끝나지만, 비용을 유계로 두는 것이 이 값의 목적이다).
   */
  it("stops nesting past the depth cap", () => {
    const level = (n: number): InlinePatternDescriptor => ({
      id: `p${n}`,
      open: `[${n}`,
      close: `${n}]`,
      className: `cm-x-p-${n}`,
      action: "none",
    });
    const doc = "[1a[2b[3c[4d4]3]2]1]";
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 },
        extensions: [
          buildPluginEditorExtension(
            [level(1), level(2), level(3), level(4)],
            [],
            [],
            services,
          ),
        ],
      }),
      parent: document.body,
    });
    const seen = [
      ...view.contentDOM.querySelectorAll<HTMLElement>('[class*="cm-x-p-"]'),
    ].map((el) => el.className);
    expect(seen).toEqual(["cm-x-p-1", "cm-x-p-2", "cm-x-p-3"]);
    // 넷째 겹은 매치되지 않아 구분자가 원문으로 남는다.
    expect(view.contentDOM.textContent).toContain("[4d4]");
    view.destroy();
  });

  /**
   * 가드(중첩의 경계): 재스캔은 **화면에 남는 토막**(라벨) 안만 훑는다. 라벨이 아닌 토막
   * (여기서는 클릭 대상인 `second`)은 구분자와 함께 숨으므로, 그 안의 매치를 그리면 보이지도
   * 않는 데코가 생긴다 — 훑지 않는 것이 맞다.
   */
  it("does not nest into a part that is hidden anyway", () => {
    const link: InlinePatternDescriptor = {
      id: "l",
      open: "[",
      mid: "](",
      close: ")",
      className: "cm-x-l-l",
      label: "first",
      target: "second",
      action: "open-url",
    };
    const inner: InlinePatternDescriptor = {
      id: "i",
      open: "<<",
      close: ">>",
      className: "cm-x-i-i",
      action: "none",
    };
    const doc = "[보기](https://e.example/<<x>>)";
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 },
        extensions: [
          buildPluginEditorExtension([link, inner], [], [], services),
        ],
      }),
      parent: document.body,
    });
    expect(view.contentDOM.querySelector(".cm-x-l-l")?.textContent).toBe(
      "보기",
    );
    expect(view.contentDOM.querySelector(".cm-x-i-i")).toBeNull();
    view.destroy();
  });

  /** 가드: 링크 동작이 있는 패턴이면 파라미터 스타일과 링크 표식이 **함께** 붙는다
   * (둘이 배타적이지 않다 — 속성 조립이 한 곳이라 어긋날 수 없다). */
  it("combines the param style with link attributes", () => {
    const doc = "[구글](https://g.example|#0a0)";
    const view = new EditorView({
      state: EditorState.create({
        doc: `${doc}\n`,
        selection: { anchor: doc.length + 1 },
        extensions: [
          buildPluginEditorExtension(
            [
              {
                id: "p",
                open: "[",
                mid: "](",
                close: ")",
                param: { prefix: "|", format: "hex-color", apply: "color" },
                className: "cm-x-p-p",
                label: "first",
                target: "second",
                action: "open-url",
              },
            ],
            [],
            [],
            services,
          ),
        ],
      }),
      parent: document.body,
    });
    const el = view.contentDOM.querySelector<HTMLElement>(".cm-x-p-p")!;
    expect(el.textContent).toBe("구글");
    expect(el.style.color).toBe("rgb(0, 170, 0)");
    expect(el.getAttribute("data-link-target")).toBe("https://g.example");
    expect(el.classList.contains("cm-plugin-link")).toBe(true);
    view.destroy();
  });
});
