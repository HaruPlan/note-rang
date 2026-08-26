import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  headingLevel,
  imageSourceAt,
  isOpenableUrl,
  isStandaloneImage,
  parseImageMarkdown,
  parseTable,
} from "./live-preview";

describe("headingLevel", () => {
  /** 가드: ATXHeading1~6 노드 이름에서 정확한 레벨을 뽑는다. */
  it("extracts the level from ATXHeading node names", () => {
    expect(headingLevel("ATXHeading1")).toBe(1);
    expect(headingLevel("ATXHeading6")).toBe(6);
  });

  /** 가드: 헤딩이 아닌 노드 이름은 null(데코레이션 미적용). */
  it("returns null for non-heading node names", () => {
    expect(headingLevel("StrongEmphasis")).toBeNull();
    expect(headingLevel("ATXHeading7")).toBeNull();
    expect(headingLevel("Paragraph")).toBeNull();
  });
});

describe("parseTable", () => {
  const SOURCE = [
    "| 이름 | 나이 |",
    "| :--- | ---: |",
    "| 가 | 1 |",
    "| 나 | 2 |",
  ].join("\n");

  /** 가드: 헤더·본문 셀을 가장자리 파이프 제거 + trim으로 파싱한다. */
  it("parses header and body cells", () => {
    const t = parseTable(SOURCE);
    expect(t.headers).toEqual(["이름", "나이"]);
    expect(t.rows).toEqual([
      ["가", "1"],
      ["나", "2"],
    ]);
  });

  /** 가드: 구분자(:---, ---:, :--:)에서 열 정렬을 읽는다. */
  it("reads column alignment from the delimiter row", () => {
    const t = parseTable(SOURCE);
    expect(t.align).toEqual(["left", "right"]);
    expect(parseTable("|a|b|c|\n|:-:|---|--:|\n|1|2|3|").align).toEqual([
      "center",
      null,
      "right",
    ]);
  });
});

describe("parseImageMarkdown", () => {
  /** 가드: alt와 경로를 정확히 뽑는다(alt 빈 값 포함). */
  it("extracts alt text and path", () => {
    expect(parseImageMarkdown("![](attachments/n/a.png)")).toEqual({
      alt: "",
      path: "attachments/n/a.png",
    });
    expect(parseImageMarkdown("![logo](b.jpg)")).toEqual({
      alt: "logo",
      path: "b.jpg",
    });
  });

  /** 가드: 괄호 안 양끝 공백은 다듬되 경로 자체는 보존한다. */
  it("trims surrounding whitespace around the path", () => {
    expect(parseImageMarkdown("![]( a.png )")?.path).toBe("a.png");
    expect(parseImageMarkdown("  ![x](a.png)  ")?.path).toBe("a.png");
  });

  /** 가드: 이미지 마크다운이 아니면 null(링크·일반텍스트·미완성). */
  it("returns null for non-image markdown", () => {
    expect(parseImageMarkdown("[link](a.png)")).toBeNull();
    expect(parseImageMarkdown("![](.)just text")).toBeNull();
    expect(parseImageMarkdown("![alt](")).toBeNull();
    expect(parseImageMarkdown("plain")).toBeNull();
  });
});

describe("isOpenableUrl", () => {
  /** 가드: 탐색 스킴 셋(https·http·mailto)은 링크로 렌더한다 — 백엔드 allowlist와 같은 집합. */
  it("accepts the navigation schemes the backend allows", () => {
    expect(isOpenableUrl("https://example.com")).toBe(true);
    expect(isOpenableUrl("http://192.168.0.1/admin")).toBe(true);
    expect(isOpenableUrl("mailto:a@b.com")).toBe(true);
    expect(isOpenableUrl("HTTPS://Example.com")).toBe(true);
  });

  /** 가드: 실행 경로가 되는 스킴·스킴 없는 문자열은 링크가 되지 않는다(원문 노출). */
  it("rejects schemes that would not open in a browser", () => {
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("data:text/html,x")).toBe(false);
    expect(isOpenableUrl("example.com")).toBe(false);
    expect(isOpenableUrl("./relative/note.md")).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });

  /** 가드: 스킴만 있고 대상이 없으면 거부한다(`open`이 인자를 파일로 해석하는 길 차단). */
  it("rejects a scheme with no target", () => {
    expect(isOpenableUrl("https://")).toBe(false);
    expect(isOpenableUrl("mailto:")).toBe(false);
  });

  /** 가드: 공백·제어문자가 섞인 URL은 거부한다. */
  it("rejects whitespace and control characters", () => {
    expect(isOpenableUrl("https://exa mple.com")).toBe(false);
    expect(isOpenableUrl("https://exam\nple.com")).toBe(false);
    expect(isOpenableUrl("https://example.com/" + String.fromCharCode(7))).toBe(
      false,
    );
    expect(
      isOpenableUrl("https://example.com/" + String.fromCharCode(127)),
    ).toBe(false);
  });

  /** 가드: 하이픈·경로·질의문자열이 든 평범한 URL은 통과한다(문자 클래스 오작동 회귀 방지). */
  it("accepts ordinary URLs with hyphens, paths, and queries", () => {
    expect(isOpenableUrl("https://my-site.example.com/a/b?c=1&d=2#e")).toBe(
      true,
    );
  });

  /** 가드: 마크다운 꺾쇠 형식(`<https://x>`)은 벗겨서 판정한다. */
  it("unwraps angle-bracket URLs", () => {
    expect(isOpenableUrl("<https://example.com>")).toBe(true);
    expect(isOpenableUrl("  https://example.com  ")).toBe(true);
  });
});

describe("imageSourceAt", () => {
  /**
   * 에디터 없이 문서 상태만 만든다 — `editor.ts`가 쓰는 것과 같은 마크다운 파서(GFM 확장 포함)를
   * 얹어야 syntax tree의 Image 노드 경계가 실제 렌더와 같아진다.
   */
  const stateOf = (doc: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: GFM })],
    });

  /** 해석된 alt 범위가 문서 오프셋과 정확히 맞는지(되쓰기가 URL을 침범하지 않는 근거). */
  const altSlice = (doc: string, pos: number): string | null => {
    const state = stateOf(doc);
    const span = imageSourceAt(state, pos);
    return span ? state.sliceDoc(span.altFrom, span.altTo) : null;
  };

  /** 가드(핵심): 단독(블록) 이미지 — 위젯 위치(=노드 시작)에서 전체·alt 범위를 모두 확정한다. */
  it("resolves the full span and the alt range of a standalone image", () => {
    const doc = "머리말\n\n![로고 w=300](a.png)\n\n꼬리말";
    const at = doc.indexOf("![");
    expect(imageSourceAt(stateOf(doc), at)).toEqual({
      from: at,
      to: at + "![로고 w=300](a.png)".length,
      source: "![로고 w=300](a.png)",
      altFrom: at + 2,
      altTo: at + 2 + "로고 w=300".length,
      alt: "로고 w=300",
    });
    expect(altSlice(doc, at)).toBe("로고 w=300");
  });

  /** 가드: 한 줄에 이미지가 여럿이면 우클릭한 그 이미지만 해석한다(앞뒤 글자에 흔들리지 않는다). */
  it("picks the clicked image when a line holds several", () => {
    const doc = "앞 ![가](x.png) 가운데 ![나 h=200](y.png) 뒤";
    expect(imageSourceAt(stateOf(doc), doc.indexOf("![가"))?.alt).toBe("가");
    expect(imageSourceAt(stateOf(doc), doc.indexOf("![나"))?.alt).toBe(
      "나 h=200",
    );
    expect(altSlice(doc, doc.indexOf("![나"))).toBe("나 h=200");
  });

  /**
   * 가드(핵심): 이미지가 공백 없이 붙어 있어도 **뒤쪽**(side=1)을 봐서 두 번째를 고른다 —
   * 앞쪽을 보면 두 번째의 시작이 첫 번째의 끝으로 해석돼 엉뚱한 이미지를 되쓴다.
   */
  it("resolves the second image when two are adjacent", () => {
    const doc = "![가](x.png)![나](y.png)";
    expect(imageSourceAt(stateOf(doc), 0)?.alt).toBe("가");
    const second = doc.indexOf("![나");
    expect(imageSourceAt(stateOf(doc), second)).toMatchObject({
      from: second,
      to: doc.length,
      alt: "나",
    });
  });

  /** 가드: 이미지가 아닌 자리(일반 텍스트·링크)는 null — 이미지 메뉴가 뜨지 않는 근거. */
  it("returns null where there is no image", () => {
    expect(imageSourceAt(stateOf("그냥 본문"), 2)).toBeNull();
    const link = "[라벨](https://example.com)";
    expect(imageSourceAt(stateOf(link), 0)).toBeNull();
  });

  /**
   * 가드(핵심): 편집으로 이미지가 사라진 직후 같은 위치를 물어도 null이다 — 위젯 DOM에 위치를
   * 박아두는 대신 매번 다시 해석하는 이유가 이것이다(stale 위치로 엉뚱한 자리를 덮지 않는다).
   */
  it("returns null once the image is gone from that position", () => {
    const before = "![가](x.png) 뒤";
    const at = 0;
    expect(imageSourceAt(stateOf(before), at)).not.toBeNull();
    expect(imageSourceAt(stateOf("이미지를 지웠다 뒤"), at)).toBeNull();
  });

  /** 가드: 문서 밖 위치를 받아도 던지지 않는다(음수·길이 초과는 문서 경계로 접는다). */
  it("clamps positions outside the document instead of throwing", () => {
    const state = stateOf("![가](x.png)");
    expect(imageSourceAt(state, -10)?.alt).toBe("가");
    expect(() => imageSourceAt(state, 9999)).not.toThrow();
  });

  /** 가드: 참조식 이미지(`![alt][ref]`)는 크기 토큰을 실을 자리가 아니라 null이다. */
  it("returns null for a reference-style image", () => {
    const doc = "![가][ref]\n\n[ref]: x.png";
    expect(imageSourceAt(stateOf(doc), 0)).toBeNull();
  });

  /** 가드: 빈 alt(`![](…)`)도 alt 범위가 빈 구간으로 정확히 잡힌다(크기 토큰을 새로 넣는 자리). */
  it("resolves an empty alt as an empty range right after the bang-bracket", () => {
    const span = imageSourceAt(stateOf("![](x.png)"), 0);
    expect(span).toMatchObject({ alt: "", altFrom: 2, altTo: 2 });
  });
});

describe("isStandaloneImage", () => {
  /** 가드: 부모 문단 범위가 이미지와 정확히 같으면 단독(블록 렌더 대상). */
  it("is true when the image fills its whole paragraph", () => {
    expect(
      isStandaloneImage(0, 10, { name: "Paragraph", from: 0, to: 10 }),
    ).toBe(true);
  });

  /** 가드: 문단에 다른 텍스트가 섞이면(범위 불일치) 단독 아님(인라인 렌더). */
  it("is false when the paragraph has other content", () => {
    expect(
      isStandaloneImage(5, 15, { name: "Paragraph", from: 0, to: 20 }),
    ).toBe(false);
  });

  /** 가드: 부모가 문단이 아니거나 없으면 단독 아님. */
  it("is false when the parent is not a paragraph or is missing", () => {
    expect(isStandaloneImage(0, 10, { name: "Table", from: 0, to: 10 })).toBe(
      false,
    );
    expect(isStandaloneImage(0, 10, null)).toBe(false);
  });
});
