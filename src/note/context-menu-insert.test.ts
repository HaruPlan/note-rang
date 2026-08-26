import { describe, it, expect } from "vitest";
import { parser, GFM } from "@lezer/markdown";
import {
  escapeLinkLabel,
  escapeMarkdownUrl,
  imageInsertMarkdown,
  isValidHttpUrl,
  linkInsertMarkdown,
  unescapeLinkLabel,
  youtubeInsertMarkdown,
} from "./context-menu-insert";

/**
 * live-preview.ts와 같은 파서(GFM 확장 @lezer/markdown)로 실제로 파싱해, 문서 전체가
 * 하나의 온전한 Link/Image 노드로 인식되는지(구조가 안 깨졌는지)와 그 URL 노드가 무엇을
 * 캡처했는지를 함께 돌려준다 — 이스케이프 전략을 "파서가 실제로 그렇게 해석하는지"로
 * 증명하기 위한 헬퍼(#16 회귀 검증).
 */
const mdParser = parser.configure(GFM);
function parseAsMarkdown(doc: string): {
  structOk: boolean;
  url: string | null;
} {
  const tree = mdParser.parse(doc);
  let span: [number, number] | null = null;
  let url: string | null = null;
  const cursor = tree.cursor();
  do {
    if ((cursor.name === "Link" || cursor.name === "Image") && span === null) {
      span = [cursor.from, cursor.to];
    }
    if (cursor.name === "URL") url = doc.slice(cursor.from, cursor.to);
  } while (cursor.next());
  return {
    structOk: span !== null && span[0] === 0 && span[1] === doc.length,
    url,
  };
}

describe("imageInsertMarkdown", () => {
  /** 가드: `![](url)` 형태로 만든다(alt는 비운다). */
  it("wraps the url in an empty-alt image markdown", () => {
    expect(imageInsertMarkdown("https://example.com/a.png")).toBe(
      "![](https://example.com/a.png)",
    );
  });

  /** 회귀(#16): 짝이 안 맞는 `)`가 섞인 URL도 문서 구조를 깨지 않고 하나의 Image로 파싱된다. */
  it("wraps an unbalanced-paren url in angle brackets so the document stays one Image node", () => {
    const url = "https://en.wikipedia.org/wiki/Foo)bar";
    const md = imageInsertMarkdown(url);
    expect(md).toBe(`![](<${url}>)`);
    const parsed = parseAsMarkdown(md);
    expect(parsed.structOk).toBe(true);
  });

  /** 가드: 괄호가 균형 잡혀 있으면(가장 흔한 경우) 굳이 꺾쇠로 감싸지 않는다. */
  it("leaves a balanced-paren url bare", () => {
    const url = "https://en.wikipedia.org/wiki/Example_(disambiguation)";
    const md = imageInsertMarkdown(url);
    expect(md).toBe(`![](${url})`);
    const parsed = parseAsMarkdown(md);
    expect(parsed.structOk).toBe(true);
    expect(parsed.url).toBe(url);
  });

  // ── 크기 지정(너비·높이) — 이미지 추가 다이얼로그의 3번째 인자(#28 2단계) ──────────────────
  describe("with width/height", () => {
    const url = "https://example.com/a.png";

    /** 가드: 둘 다 주면 alt에 `w=…&h=…` 순으로 함께 실린다(크기 조정 레이어와 같은 문법). */
    it("puts both tokens in the alt as w=…&h=…", () => {
      expect(imageInsertMarkdown(url, 300, 200)).toBe(`![w=300&h=200](${url})`);
    });

    /** 가드: 너비만 주면 높이는 alt에서 빠진다(=auto). */
    it("puts only the width token when height is omitted", () => {
      expect(imageInsertMarkdown(url, 300, null)).toBe(`![w=300](${url})`);
    });

    /** 가드: 높이만 주면 너비는 alt에서 빠진다(=auto). */
    it("puts only the height token when width is omitted", () => {
      expect(imageInsertMarkdown(url, null, 200)).toBe(`![h=200](${url})`);
    });

    /** 가드(하위호환): 둘 다 없으면(생략 또는 null) 기존과 똑같이 alt가 빈 채로 나간다. */
    it("keeps the empty-alt shape when both are null", () => {
      expect(imageInsertMarkdown(url, null, null)).toBe(`![](${url})`);
      expect(imageInsertMarkdown(url)).toBe(`![](${url})`);
    });
  });
});

describe("youtubeInsertMarkdown", () => {
  /** 가드: youtube-embed 플러그인이 인식하는 코드펜스로 감싼다. */
  it("wraps the url in a ```youtube fence", () => {
    expect(youtubeInsertMarkdown("https://youtu.be/abc123")).toBe(
      "```youtube\nhttps://youtu.be/abc123\n```",
    );
  });

  /** 가드: 펜스 본문은 URL 한 줄이어야 한다(extractEmbedId가 내부 공백을 거부) — trim한다. */
  it("trims surrounding whitespace so the fence body stays a single line", () => {
    expect(youtubeInsertMarkdown("  https://youtu.be/abc123  ")).toBe(
      "```youtube\nhttps://youtu.be/abc123\n```",
    );
  });
});

describe("linkInsertMarkdown", () => {
  /** 가드: 선택 텍스트가 있으면 링크 텍스트로 쓴다. */
  it("uses the selected text as the link text when present", () => {
    expect(linkInsertMarkdown("https://example.com", "여기")).toBe(
      "[여기](https://example.com)",
    );
  });

  /** 가드: 선택이 없으면 URL 자체를 링크 텍스트로 쓴다. */
  it("falls back to the url itself when there is no selection", () => {
    expect(linkInsertMarkdown("https://example.com", "")).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  /** 가드: 공백뿐인 선택은 "선택 없음"과 같게 다룬다. */
  it("treats whitespace-only selection as no selection", () => {
    expect(linkInsertMarkdown("https://example.com", "   ")).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  /**
   * 회귀(#16 재현 1 — 라벨 파괴): 선택 텍스트에 `]`가 섞이면(예: "[TODO] item"의 일부처럼)
   * 이스케이프 없이는 링크 텍스트가 조기 종료돼 뒤 문자열이 원문 그대로 새어나온다.
   * 이스케이프 후 실제 파서로 검증: 문서 전체가 하나의 Link로 인식돼야 한다.
   */
  it("escapes `]` in the selected text so the link text does not terminate early", () => {
    const md = linkInsertMarkdown("https://example.com", "a]b");
    expect(md).toBe("[a\\]b](https://example.com)");
    const parsed = parseAsMarkdown(md);
    expect(parsed.structOk).toBe(true);
    expect(parsed.url).toBe("https://example.com");
  });

  /** 회귀(#16): 선택 텍스트에 `[`가 섞여도(예: "[TODO] item" 전체 선택) 구조가 깨지지 않는다. */
  it("escapes `[` in the selected text so it is not mistaken for a nested link start", () => {
    const md = linkInsertMarkdown("https://example.com", "[TODO] item");
    expect(md).toBe("[\\[TODO\\] item](https://example.com)");
    expect(parseAsMarkdown(md).structOk).toBe(true);
  });

  /**
   * 회귀(#16 재현 2 — URL 절단): 짝이 안 맞는 `)`가 섞인(하지만 `new URL()`로는 유효한) URL도
   * 목적지가 잘리지 않고 사용자가 입력한 URL 전체가 그대로 저장된다.
   */
  it("wraps an unbalanced-paren url in angle brackets so the destination is not truncated", () => {
    const url = "https://en.wikipedia.org/wiki/Example_(disambiguation))extra";
    const md = linkInsertMarkdown(url, "");
    const parsed = parseAsMarkdown(md);
    expect(parsed.structOk).toBe(true);
    // 캡처된 URL 노드는 꺾쇠를 포함한다 — live-preview.ts의 bareUrl()이 이를 벗겨 원래
    // URL을 그대로 복원한다(이 함수는 순수 변환이라 벗기는 책임까지 지지 않는다).
    expect(parsed.url).toBe(`<${url}>`);
  });

  /** 가드: 라벨·URL 둘 다 특수문자가 없으면 이스케이프로 인한 불필요한 변형이 없다. */
  it("does not alter safe labels or urls", () => {
    expect(linkInsertMarkdown("https://example.com", "여기")).toBe(
      "[여기](https://example.com)",
    );
  });
});

describe("escapeLinkLabel / unescapeLinkLabel", () => {
  /** 가드: `\`·`[`·`]`를 각각 백슬래시 이스케이프한다. */
  it("escapes backslash, and both brackets", () => {
    expect(escapeLinkLabel("a]b")).toBe("a\\]b");
    expect(escapeLinkLabel("[TODO] item")).toBe("\\[TODO\\] item");
    expect(escapeLinkLabel("a\\b")).toBe("a\\\\b");
  });

  /** 가드: 이스케이프한 라벨을 되돌리면 원문으로 정확히 복원된다(라운드트립). */
  it("round-trips through escape/unescape", () => {
    for (const text of ["a]b", "[TODO] item", "a\\b", "plain", ""]) {
      expect(unescapeLinkLabel(escapeLinkLabel(text))).toBe(text);
    }
  });
});

describe("escapeMarkdownUrl", () => {
  /** 가드: 괄호가 균형 잡혀 있으면(흔한 경우) 그대로 둔다. */
  it("leaves urls with balanced parens untouched", () => {
    const url = "https://en.wikipedia.org/wiki/Example_(disambiguation)";
    expect(escapeMarkdownUrl(url)).toBe(url);
  });

  /** 가드: 괄호가 하나도 없으면 그대로 둔다. */
  it("leaves plain urls untouched", () => {
    expect(escapeMarkdownUrl("https://example.com/a/b")).toBe(
      "https://example.com/a/b",
    );
  });

  /** 가드: 짝이 안 맞는 `)`가 있으면 꺾쇠 목적지 형식으로 감싼다. */
  it("wraps unbalanced-paren urls in angle brackets", () => {
    expect(escapeMarkdownUrl("https://example.com/Foo)bar")).toBe(
      "<https://example.com/Foo)bar>",
    );
  });

  /** 가드: 공백이 섞이면 감싼다. */
  it("wraps urls containing whitespace in angle brackets", () => {
    expect(escapeMarkdownUrl("https://example.com/a b")).toBe(
      "<https://example.com/a b>",
    );
  });

  /** 가드: 꺾쇠 안에서는 `<`·`>`·`\`를 이스케이프한다(꺾쇠 목적지 자체가 깨지지 않게). */
  it("escapes angle brackets and backslashes inside the wrapper", () => {
    expect(escapeMarkdownUrl("https://example.com/a<b>c)")).toBe(
      "<https://example.com/a\\<b\\>c)>",
    );
  });
});

describe("isValidHttpUrl", () => {
  /** 가드: http/https는 통과한다. */
  it("accepts http and https URLs", () => {
    expect(isValidHttpUrl("https://example.com")).toBe(true);
    expect(isValidHttpUrl("http://example.com/path?x=1")).toBe(true);
  });

  /** 가드: 빈 값·공백뿐·비-http(s) 스킴·구문 오류는 전부 거부한다. */
  it("rejects empty, whitespace-only, and non-http(s) input", () => {
    expect(isValidHttpUrl("")).toBe(false);
    expect(isValidHttpUrl("   ")).toBe(false);
    expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isValidHttpUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
  });

  /** 가드: 앞뒤 공백은 판정 전에 trim한다. */
  it("trims surrounding whitespace before validating", () => {
    expect(isValidHttpUrl("  https://example.com  ")).toBe(true);
  });
});
