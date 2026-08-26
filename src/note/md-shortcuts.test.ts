import { describe, it, expect } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import {
  contentStart,
  isMultilineText,
  markdownShortcuts,
  nonBlankLines,
  structuralPrefixLength,
  wrapRange,
} from "./md-shortcuts";

describe("wrapRange", () => {
  /** 가드: 선택 영역을 마커로 감싸고 새 선택이 안쪽 텍스트를 가리킨다. */
  it("wraps inner text and selects the inner span", () => {
    const r = wrapRange(2, 5, "abc", "**", "**");
    expect(r.changes).toEqual({ from: 2, to: 5, insert: "**abc**" });
    expect(r.anchor).toBe(4); // 2 + "**".length
    expect(r.head).toBe(7); // 4 + "abc".length
  });

  /** 가드: 빈 선택(from==to)도 마커만 삽입하고 커서를 마커 사이에 둔다. */
  it("inserts markers around an empty selection", () => {
    const r = wrapRange(3, 3, "", "*", "*");
    expect(r.changes).toEqual({ from: 3, to: 3, insert: "**" });
    expect(r.anchor).toBe(4);
    expect(r.head).toBe(4);
  });

  // ── 다중 라인 ──────────────────────────────────────────────────────────
  // 마크다운 인라인 마커는 줄을 넘어 매치되지 않으므로, 선택이 여러 줄에 걸치면 통짜로
  // 감싸는 대신 줄별로 따로 감싸야 한다.

  describe("multi-line selections", () => {
    /** 가드(핵심): 2줄 선택은 각 줄을 따로 감싼다(통짜로 감싸지 않는다). */
    it("wraps each line separately for a two-line selection", () => {
      const inner = "line1\nline2";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "**line1**\n**line2**",
      });
      // 다중 라인은 "안쪽만"이 아니라 감싼 전체 블록을 선택한다.
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("**line1**\n**line2**".length);
    });

    /** 가드(핵심): 빈 줄/공백만 있는 줄은 건드리지 않는다(마커만 남는 `****`를 방지). */
    it("skips blank and whitespace-only lines", () => {
      const inner = "a\n\n   \nb";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "**a**\n\n   \n**b**",
      });
    });

    /** 가드: 각 줄 조각의 앞뒤 공백은 마커 밖에 남긴다(마커 안쪽에 공백이 걸치지 않는다). */
    it("keeps leading/trailing whitespace of a line outside the markers", () => {
      const inner = " a \n b ";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: " **a** \n **b** ",
      });
    });

    /** 가드: 3줄 선택 — 모든 비어있지 않은 줄이 각자 감싸진다. */
    it("wraps all non-blank lines in a three-line selection", () => {
      const inner = "one\ntwo\nthree";
      const r = wrapRange(10, 10 + inner.length, inner, "*", "*");
      expect(r.changes).toEqual({
        from: 10,
        to: 10 + inner.length,
        insert: "*one*\n*two*\n*three*",
      });
      expect(r.anchor).toBe(10);
      expect(r.head).toBe(10 + "*one*\n*two*\n*three*".length);
    });

    /** 가드: CRLF 줄바꿈도 구분자를 그대로 보존하며 줄별로 감싼다. */
    it("preserves CRLF separators while wrapping each line", () => {
      const inner = "a\r\nb";
      const r = wrapRange(0, inner.length, inner, "`", "`");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "`a`\r\n`b`",
      });
    });

    /**
     * 가드(핵심 회귀): 줄 머리의 **구조 문법은 마커 밖**에 남는다 — 불릿까지 감싸면
     * (`**- 항목**`) 줄이 `*`로 시작해 마크다운이 그 줄을 목록으로 보지 않는다.
     */
    it("keeps list bullets outside the markers", () => {
      const inner = "- 하나\n- 둘";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "- **하나**\n- **둘**",
      });
    });

    /** 가드: 태스크·헤딩·인용·들여쓴 불릿이 섞인 선택도 접두는 전부 마커 밖에 남는다. */
    it("keeps task, heading, quote and indented prefixes outside the markers", () => {
      const inner = "- [ ] 할 일\n## 제목\n> 인용\n  - 들여쓴 항목";
      const r = wrapRange(0, inner.length, inner, "==", "==");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "- [ ] ==할 일==\n## ==제목==\n> ==인용==\n  - ==들여쓴 항목==",
      });
    });

    /** 가드: 접두만 있고 내용이 없는 줄(`- `)은 건드리지 않는다 — `- ****`를 만들지 않는다. */
    it("skips lines that carry only a structural prefix", () => {
      const inner = "- 하나\n- \n- 둘";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "- **하나**\n- \n- **둘**",
      });
    });

    /**
     * 가드(핵심 회귀): 선택의 첫 줄이 줄 중간에서 시작하면(드래그가 그 줄의 두 번째 단어부터
     * 시작) `firstLineAtLineStart=false`를 넘겨야 한다 — 아니면 우연히 구조 마커 모양인
     * 첫 조각의 머리(`- `)가 접두로 오판돼 마커 밖으로 밀려난다. "가격은 100원 - 200원"에서
     * "- 200원"부터 드래그한 경우를 그대로 재현한다.
     */
    it("does not mistake the first fragment's head for a structural prefix when the selection starts mid-line", () => {
      const inner = "- 200원\n배송비 별도";
      const r = wrapRange(0, inner.length, inner, "**", "**", false);
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "**- 200원**\n**배송비 별도**",
      });
    });

    /** 가드(무회귀): `firstLineAtLineStart`를 생략하면(기본 true) 기존처럼 첫 줄도 진짜 줄
     * 머리로 취급해 접두를 마커 밖에 남긴다 — 시그니처를 넓혀도 기존 호출부는 그대로 산다. */
    it("still treats the first line as a real line start by default", () => {
      const inner = "- 200원\n배송비 별도";
      const r = wrapRange(0, inner.length, inner, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: inner.length,
        insert: "- **200원**\n**배송비 별도**",
      });
    });
  });
});

describe("structuralPrefixLength", () => {
  /** 가드: 불릿·순서 목록·태스크 체크박스는 뒤따르는 공백까지 통째로 접두다. */
  it("measures bullets, ordered markers and task checkboxes", () => {
    expect(structuralPrefixLength("- 항목")).toBe(2);
    expect(structuralPrefixLength("* 항목")).toBe(2);
    expect(structuralPrefixLength("+ 항목")).toBe(2);
    expect(structuralPrefixLength("1. 항목")).toBe(3);
    expect(structuralPrefixLength("12) 항목")).toBe(4);
    expect(structuralPrefixLength("- [ ] 할 일")).toBe(6);
    expect(structuralPrefixLength("- [x] 할 일")).toBe(6);
    expect(structuralPrefixLength("1. [X] 할 일")).toBe(7);
  });

  /** 가드: 헤딩은 `#`~`######` + 공백까지, 인용은 중첩(`> > `)도 전부 접두다. */
  it("measures headings and (nested) quotes", () => {
    expect(structuralPrefixLength("# 제목")).toBe(2);
    expect(structuralPrefixLength("###### 제목")).toBe(7);
    expect(structuralPrefixLength("> 인용")).toBe(2);
    expect(structuralPrefixLength("> > 인용")).toBe(4);
    expect(structuralPrefixLength(">인용")).toBe(1);
  });

  /** 가드: 들여쓰기와 조합(인용+불릿+체크박스)도 순서대로 전부 먹는다. */
  it("measures indentation and combined prefixes in order", () => {
    expect(structuralPrefixLength("  - 항목")).toBe(4);
    expect(structuralPrefixLength("\t- 항목")).toBe(3);
    expect(structuralPrefixLength("> - [ ] 할 일")).toBe(8);
    expect(structuralPrefixLength("  > > 1. 항목")).toBe(9);
    expect(structuralPrefixLength("-   항목")).toBe(4); // 마커 뒤 공백은 전부 접두다.
  });

  /** 가드: 들여쓰기만 있는 줄은 그 들여쓰기가 접두다(4칸이 코드 블록을 만드는 등 구조다). */
  it("counts bare indentation as a prefix", () => {
    expect(structuralPrefixLength("    코드처럼 들여쓴 줄")).toBe(4);
    expect(structuralPrefixLength("평범한 줄")).toBe(0);
  });

  /**
   * 가드(오탐 방지): 구조 문법처럼 **생겼을 뿐인** 인라인 글자는 접두가 아니다 — 뒤에 공백이
   * 없으면(`-abc`·`#제목`) 마크다운도 목록·헤딩으로 보지 않고, `*강조*`는 인라인 마커다.
   */
  it("does not mistake inline markers for structure", () => {
    expect(structuralPrefixLength("-abc")).toBe(0);
    expect(structuralPrefixLength("#제목")).toBe(0);
    expect(structuralPrefixLength("*강조* 뒤")).toBe(0);
    expect(structuralPrefixLength("**굵게**")).toBe(0);
    expect(structuralPrefixLength("`- [ ] 코드`")).toBe(0);
  });

  /** 가드: 헤딩은 한 번만 먹는다 — `# # 제목`의 두 번째 `#`는 본문 글자다. */
  it("stops after one heading marker", () => {
    expect(structuralPrefixLength("# # 제목")).toBe(2);
  });

  /** 가드: 줄이 접두뿐이면 줄 전체가 접두다(감쌀 내용이 없다). */
  it("can cover the whole line when there is nothing after the prefix", () => {
    expect(structuralPrefixLength("- ")).toBe(2);
    expect(structuralPrefixLength("   ")).toBe(3);
    expect(structuralPrefixLength("")).toBe(0);
  });
});

describe("isMultilineText", () => {
  /** 가드: 줄바꿈(\n·\r\n·\r) 포함 여부를 정확히 판정한다. */
  it("detects any of \\n, \\r\\n, \\r as multiline", () => {
    expect(isMultilineText("abc")).toBe(false);
    expect(isMultilineText("a\nb")).toBe(true);
    expect(isMultilineText("a\r\nb")).toBe(true);
    expect(isMultilineText("a\rb")).toBe(true);
  });
});

describe("nonBlankLines", () => {
  /** 가드: 공백을 뺀 내용이 있는 줄만, 오프셋(앞쪽 공백 제외)과 함께 돌려준다. */
  it("returns offset+core for lines with non-whitespace content, skipping blank lines", () => {
    // "a\n\n b \nc" → 인덱스: 0'a' 1'\n' 2'\n' 3' ' 4'b' 5' ' 6'\n' 7'c'
    expect(nonBlankLines("a\n\n b \nc")).toEqual([
      { offset: 0, core: "a" },
      { offset: 4, core: "b" }, // " b " 조각의 앞공백 1칸을 건너뛴 위치(=문서 인덱스 4)
      { offset: 7, core: "c" },
    ]);
  });

  /** 가드: 공백만 있는 텍스트는 빈 배열. */
  it("returns an empty array for whitespace-only text", () => {
    expect(nonBlankLines("  \n\t\n")).toEqual([]);
  });

  /**
   * 가드(핵심): 조각은 줄 머리의 **구조 문법 뒤**에서 시작한다 — 이 한 곳이 서식 감싸기
   * (`wrapRange`·`computeToggleWrap`)와 색 칠하기(`colorEditTargets`)가 공유하는 지점이다.
   */
  it("starts each fragment after the structural prefix", () => {
    // "- 하나\n> 인용" → 인덱스: 0'-' 1' ' 2'하'… 4'\n' 5'>' 6' ' 7'인'
    expect(nonBlankLines("- 하나\n> 인용")).toEqual([
      { offset: 2, core: "하나" },
      { offset: 7, core: "인용" },
    ]);
  });

  /** 가드: 접두만 있는 줄(`- `·`## `)은 감쌀 내용이 없으므로 결과에서 빠진다. */
  it("drops lines that carry only a structural prefix", () => {
    expect(nonBlankLines("- \n## \na")).toEqual([{ offset: 7, core: "a" }]);
  });

  // ── firstLineAtLineStart(회귀) ────────────────────────────────────────────
  // 다중 라인 선택의 첫 조각은 줄 중간에서 시작할 수 있다(드래그가 그 줄의 두 번째 단어부터
  // 시작). 그 조각의 머리가 우연히 구조 마커 모양이어도(`- `·`> ` 등) 그건 줄 머리가 아니라
  // 본문 글자이므로 접두로 오판하면 안 된다.
  describe("firstLineAtLineStart", () => {
    /**
     * 가드(핵심 회귀): `firstLineAtLineStart=false`면 첫 조각의 `- `를 구조 접두로 보지
     * 않는다 — "가격은 100원 - 200원"에서 "- 200원"부터 드래그한 경우를 그대로 재현한다.
     * 두 번째 줄부터는 언제나 줄바꿈 직후이므로 이 인자와 무관하게 접두를 정상 적용한다.
     */
    it("does not treat the first fragment's head as a structural prefix when it is not a real line start", () => {
      // "- 200원\n배송비 별도" → 인덱스: 0'-' 1' ' 2'2'… 6'\n' 7'배'…
      expect(nonBlankLines("- 200원\n배송비 별도", false)).toEqual([
        { offset: 0, core: "- 200원" },
        { offset: 7, core: "배송비 별도" },
      ]);
    });

    /** 가드(무회귀): `firstLineAtLineStart=true`(기본값)는 기존과 동일하게 접두를 벗긴다. */
    it("still strips the structural prefix from the first fragment when it is a real line start (default)", () => {
      expect(nonBlankLines("- 200원\n배송비 별도")).toEqual([
        { offset: 2, core: "200원" },
        { offset: 7, core: "배송비 별도" },
      ]);
      expect(nonBlankLines("- 200원\n배송비 별도", true)).toEqual([
        { offset: 2, core: "200원" },
        { offset: 7, core: "배송비 별도" },
      ]);
    });

    /** 가드: 앞뒤 공백은 `firstLineAtLineStart=false`에서도 여전히 다듬는다(접두만 건너뛴다). */
    it("still trims surrounding whitespace on the first fragment even when not at a line start", () => {
      // " - 200원 \n둘째" → 인덱스: 0' ' 1'-' 2' ' 3'2'…6'원' 7' ' 8'\n' 9'둘'…
      expect(nonBlankLines(" - 200원 \n둘째", false)).toEqual([
        { offset: 1, core: "- 200원" },
        { offset: 9, core: "둘째" },
      ]);
    });
  });
});

describe("contentStart", () => {
  /** 가드: 구조 접두가 없으면 `from`을 그대로 돌려준다(기존 동작 무회귀). */
  it("returns from unchanged when the line has no structural prefix", () => {
    expect(contentStart(0, 4, 0, "항목")).toBe(0);
    expect(contentStart(2, 4, 0, "항목")).toBe(2);
  });

  /** 가드(핵심): 선택이 접두를 물고 시작하면 접두 뒤로 민다. */
  it("clamps to the prefix end when the selection starts inside or before it", () => {
    // "- 항목"의 접두("- ")는 길이 2.
    expect(contentStart(0, 4, 0, "- 항목")).toBe(2);
    // 접두 중간(공백 자리)에서 시작해도 접두 뒤로 민다.
    expect(contentStart(1, 4, 0, "- 항목")).toBe(2);
  });

  /** 가드: 선택이 접두 안에서만 놀면(끝까지 접두 안) `to`를 그대로 돌려준다(감쌀 글자가 없다). */
  it("returns to when the whole selection sits inside the prefix", () => {
    expect(contentStart(0, 2, 0, "- 항목")).toBe(2);
    expect(contentStart(0, 1, 0, "- 항목")).toBe(1);
  });

  /** 가드: 빈 선택(`to <= from`)은 손대지 않는다 — 커서 자리에 마커만 넣는 기존 동작. */
  it("leaves an empty selection untouched", () => {
    expect(contentStart(3, 3, 0, "- 항목")).toBe(3);
  });

  /** 가드: `lineFrom`이 0이 아닌 문서 중간 줄에서도 절대 위치로 옳게 클램프한다. */
  it("clamps using absolute document positions for a non-first line", () => {
    // "prev\n- 항목"에서 두 번째 줄은 lineFrom=5부터 시작한다.
    expect(contentStart(5, 9, 5, "- 항목")).toBe(7);
  });
});

describe("Mod-K link shortcut (multi-line exception)", () => {
  /** ⌘K(링크) 바인딩을 실행해 결과 문서를 얻는다 — Tab 바인딩과 같은 헤드리스 방식. */
  function runLinkShortcut(doc: string, anchor: number, head: number): string {
    const state = EditorState.create({ doc, selection: { anchor, head } });
    let next = state;
    const target = {
      state,
      dispatch: (tr: Transaction) => {
        next = tr.state;
      },
    } as unknown as EditorView;
    const modK = markdownShortcuts.find((b) => b.key === "Mod-k");
    modK!.run!(target);
    return next.doc.toString();
  }

  /** 가드(핵심): `[여러\n줄](url)`은 유효한 링크가 아니므로, 다중 라인 선택에서는 아무 것도
   * 하지 않는다(문서가 그대로 남는다). */
  it("does nothing for a multi-line selection", () => {
    const doc = "line1\nline2";
    expect(runLinkShortcut(doc, 0, doc.length)).toBe(doc);
  });

  /** 가드: 단일 라인 선택은 기존처럼 링크 마커로 감싼다(회귀 방지). */
  it("still wraps a single-line selection into a link marker", () => {
    expect(runLinkShortcut("hello", 0, 5)).toBe("[hello](url)");
  });
});

describe("Mod-b bold shortcut (single-line structural prefix clamp)", () => {
  /** ⌘B(굵게) 바인딩을 실행해 결과 문서를 얻는다 — Mod-K 테스트와 같은 헤드리스 방식. */
  function runBoldShortcut(doc: string, anchor: number, head: number): string {
    const state = EditorState.create({ doc, selection: { anchor, head } });
    let next = state;
    const target = {
      state,
      dispatch: (tr: Transaction) => {
        next = tr.state;
      },
    } as unknown as EditorView;
    const modB = markdownShortcuts.find((b) => b.key === "Mod-b");
    modB!.run!(target);
    return next.doc.toString();
  }

  /**
   * 가드(핵심 — `computeToggleWrap`과 같은 규칙을 [`contentStart`]로 공유): 줄 전체를 선택하고
   * ⌘B를 눌러도(트리플 클릭 + 단축키) 불릿은 마커 밖에 남는다.
   */
  it("keeps a bullet prefix outside the marker on a full-line selection", () => {
    const doc = "- 항목";
    expect(runBoldShortcut(doc, 0, doc.length)).toBe("- **항목**");
  });

  /** 가드: 선택이 접두 중간(공백 자리)에서 시작해도 접두 뒤부터 감싼다. */
  it("clamps to after the prefix when the selection starts inside it", () => {
    const doc = "- 항목";
    expect(runBoldShortcut(doc, 1, doc.length)).toBe("- **항목**");
  });

  /** 가드(무회귀): 구조 접두가 없는 평범한 선택은 이전과 똑같이 통짜로 감싼다. */
  it("still wraps a plain selection with no structural prefix", () => {
    expect(runBoldShortcut("hello", 0, 5)).toBe("**hello**");
  });
});

describe("Mod-b bold shortcut (multi-line selection starting mid-line)", () => {
  /** ⌘B(굵게) 바인딩을 실행해 결과 문서를 얻는다 — 다른 Mod-* 테스트와 같은 헤드리스 방식. */
  function runBoldShortcut(doc: string, anchor: number, head: number): string {
    const state = EditorState.create({ doc, selection: { anchor, head } });
    let next = state;
    const target = {
      state,
      dispatch: (tr: Transaction) => {
        next = tr.state;
      },
    } as unknown as EditorView;
    const modB = markdownShortcuts.find((b) => b.key === "Mod-b");
    modB!.run!(target);
    return next.doc.toString();
  }

  /**
   * 가드(핵심 회귀 — 실사용 재현): "가격은 100원 - 200원"에서 "- 200원"부터 끝까지 드래그해
   * ⌘B를 누르면, 선택한 "- "가 (줄 머리가 아닌데도) 구조 접두로 오판돼 마커 밖으로 밀려나면
   * 안 된다. 같은 선택을 한 줄만 잡으면(`contentStart` 경로) 정상이므로, 두 경로의 결과가
   * 어긋나지 않아야 한다.
   */
  it("keeps a selected mid-line dash inside the marker when the drag starts on the second line's word", () => {
    const doc = "가격은 100원 - 200원\n배송비 별도";
    const from = doc.indexOf("- 200원");
    expect(runBoldShortcut(doc, from, doc.length)).toBe(
      "가격은 100원 **- 200원**\n**배송비 별도**",
    );
  });

  /** 가드(무회귀): 진짜 줄 머리에서 시작하는 다중 라인 선택은 여전히 접두를 마커 밖에 남긴다. */
  it("still keeps a real line-start bullet outside the marker on a multi-line selection", () => {
    const doc = "- 하나\n- 둘";
    expect(runBoldShortcut(doc, 0, doc.length)).toBe("- **하나**\n- **둘**");
  });
});

describe("Tab indentation", () => {
  /**
   * indentUnit(2칸) 상태에서 Tab 바인딩(StateCommand)을 실행해 결과 문서를 얻는다.
   * indentMore/Less는 뷰 DOM 없이 {state, dispatch}만으로 동작하므로 헤드리스로 검증한다.
   */
  function runBinding(
    run: ((view: EditorView) => boolean) | undefined,
    doc: string,
  ): string {
    const state = EditorState.create({
      doc,
      extensions: [indentUnit.of("  ")],
    });
    let next = state;
    const target = {
      state,
      dispatch: (tr: Transaction) => {
        next = tr.state;
      },
    } as unknown as EditorView;
    run?.(target);
    return next.doc.toString();
  }

  /** 가드: Tab은 줄 앞에 2칸 들여쓰기, Shift-Tab은 내어쓰기(2칸 제거). */
  it("indents and dedents a line by two spaces", () => {
    const tab = markdownShortcuts.find((b) => b.key === "Tab");
    expect(tab).toBeDefined();
    expect(runBinding(tab!.run, "hello")).toBe("  hello");
    expect(runBinding(tab!.shift, "  hello")).toBe("hello");
  });
});
