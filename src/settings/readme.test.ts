import { describe, it, expect, vi } from "vitest";
import { renderReadmeInto } from "./readme";

/** 렌더 결과 호스트를 만든다. */
const render = (
  md: string | null,
  openLink = vi.fn(),
  resolveImage?: (src: string) => string | null,
) => {
  const host = document.createElement("div");
  renderReadmeInto(host, md, openLink, resolveImage);
  return { host, openLink };
};

describe("renderReadmeInto (README 화이트리스트 렌더)", () => {
  /** 가드: 제목·문단·굵게/기울임·인라인코드·목록·코드펜스가 올바른 요소로 렌더된다. */
  it("renders whitelisted markdown structures", () => {
    const { host } = render(
      [
        "# 위키링크",
        "",
        "본문 **굵게** 그리고 *기울임* 과 `코드` 조각.",
        "",
        "## 사용법",
        "- 첫 항목",
        "- 둘째 항목",
        "",
        "```js",
        "memo.editor.registerCompletion({});",
        "```",
      ].join("\n"),
    );
    expect(host.querySelector("h1")!.textContent).toBe("위키링크");
    expect(host.querySelector("h2")!.textContent).toBe("사용법");
    expect(host.querySelector("p strong")!.textContent).toBe("굵게");
    expect(host.querySelector("p em")!.textContent).toBe("기울임");
    expect(host.querySelector("p code")!.textContent).toBe("코드");
    const items = host.querySelectorAll("ul li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("첫 항목");
    // 코드펜스: 마커·언어 표기는 빠지고 코드 본문만.
    const pre = host.querySelector("pre code")!;
    expect(pre.textContent).toContain("registerCompletion");
    expect(pre.textContent).not.toContain("```");
    expect(pre.textContent).not.toContain("js\n");
  });

  /** 가드(XSS): raw HTML(script·onerror 속성)은 텍스트로 강등되고, 마크다운 이미지는 <img>가
   * 아니라 칩이 된다 — 어떤 위험 요소도 생성되지 않는다. */
  it("degrades raw HTML to plain text and never creates <img>", () => {
    const { host } = render(
      [
        '<script>alert("x")</script>',
        "",
        '문단 안 <img src="x" onerror="alert(1)"> 조각.',
        "",
        "![alt](https://example.com/i.png)",
      ].join("\n"),
    );
    // 어떤 위험 요소도 생성되지 않는다.
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[onerror]")).toBeNull();
    // 원문은 텍스트로 보인다(강등 — 사라지지 않음).
    expect(host.textContent).toContain('<script>alert("x")</script>');
    expect(host.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  /** 가드(XSS): 마크다운 안 HTML 마크업이 textContent로만 들어간다(innerHTML 미사용 증명). */
  it("keeps HTML-looking text inside emphasis as literal text", () => {
    const { host } = render("**<b>진하게?</b>**");
    const strong = host.querySelector("strong")!;
    expect(strong.textContent).toBe("<b>진하게?</b>");
    expect(host.querySelector("b")).toBeNull();
  });

  /** 가드(링크 정책): https 링크만 앵커가 되고, 클릭은 기본 탐색을 막고 openLink로 위임된다. */
  it("renders https links as anchors that delegate to openLink", () => {
    const { host, openLink } = render("[문서](https://example.com/docs)");
    const a = host.querySelector<HTMLAnchorElement>("a.plugin-readme-link")!;
    expect(a.textContent).toBe("문서");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); // 웹뷰 내 탐색 금지.
    expect(openLink).toHaveBeenCalledWith("https://example.com/docs");
  });

  /** 가드(링크 정책): javascript:·http:·상대경로 링크는 앵커가 되지 않는다(라벨만 남음). */
  it("drops non-https links to plain text", () => {
    const { host, openLink } = render(
      [
        "[나쁜](javascript:alert(1))",
        "[평문](http://example.com)",
        "[상대](./x)",
      ].join(" "),
    );
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("나쁜");
    expect(host.textContent).toContain("평문");
    expect(host.textContent).toContain("상대");
    expect(openLink).not.toHaveBeenCalled();
  });

  /** 가드(링크 정책, 회귀): CommonMark autolink `<javascript:>`·`<https:>`와 data: 마크다운
   * 링크도 앵커가 되지 않는다 — 파서 업그레이드로 autolink 처리가 바뀌어도 "https 링크만
   * 앵커" 화이트리스트가 유지되는지를 고정한다(검증자 프로브를 커밋 가드로 승격). */
  it("drops autolinks and data: links to inert text", () => {
    const { host, openLink } = render(
      [
        "<javascript:alert(1)>",
        "[데이터](data:text/html;base64,PHNjcmlwdD4=)",
        "<https://example.com/auto>",
      ].join("\n\n"),
    );
    expect(host.querySelector("a")).toBeNull(); // https autolink조차 앵커화하지 않음
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("javascript:alert(1)");
    expect(host.textContent).toContain("데이터"); // data: 링크는 라벨 텍스트만 남는다
    expect(openLink).not.toHaveBeenCalled();
  });

  /** 가드(GFM): 인용·수평선·취소선이 시맨틱 요소로 렌더된다. */
  it("renders blockquote, hr and strikethrough", () => {
    const { host } = render(
      ["> 인용문", "", "---", "", "본문 ~~취소~~ 조각."].join("\n"),
    );
    const quote = host.querySelector("blockquote")!;
    expect(quote).not.toBeNull();
    expect(quote.textContent).toContain("인용문");
    expect(quote.textContent).not.toContain(">"); // QuoteMark는 흘리지 않는다
    expect(host.querySelector("hr")).not.toBeNull();
    expect(host.querySelector("del")!.textContent).toBe("취소");
    expect(host.textContent).not.toContain("~~");
  });

  /** 가드(GFM): 표가 thead/tbody/셀 구조로 렌더되고 정렬이 화이트리스트 값으로만 반영된다. */
  it("renders a GFM table with header, rows and column alignment", () => {
    const { host } = render(
      [
        "| 이름 | 값 | 비고 |",
        "| :--- | :-: | ---: |",
        "| a | `x` | 1 |",
        "| b | y | 2 |",
      ].join("\n"),
    );
    const ths = host.querySelectorAll("table thead th");
    expect(ths).toHaveLength(3);
    expect(ths[0].textContent).toContain("이름");
    const rows = host.querySelectorAll("table tbody tr");
    expect(rows).toHaveLength(2);
    // 셀 안 인라인 코드가 살아있다(요소 재사용 증거).
    expect(host.querySelector("table tbody td code")!.textContent).toBe("x");
    // 정렬은 구분줄에서 파생: 1열 left, 2열 center, 3열 right.
    const firstRow = rows[0].querySelectorAll("td");
    expect(firstRow[0].style.textAlign).toBe("left");
    expect(firstRow[1].style.textAlign).toBe("center");
    expect(firstRow[2].style.textAlign).toBe("right");
    // 파이프·구분줄이 텍스트로 새지 않는다.
    expect(host.textContent).not.toContain("|");
    expect(host.textContent).not.toContain(":---");
  });

  /** 가드(XSS): 표 셀 안 raw HTML도 요소가 아니라 텍스트로만 남는다(innerHTML 미사용). */
  it("keeps raw HTML inside a table cell as literal text", () => {
    const { host } = render(
      ["| h |", "| --- |", "| <img src=x onerror=alert(1)> |"].join("\n"),
    );
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[onerror]")).toBeNull();
    expect(host.querySelector("td")!.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
  });

  /** 가드(GFM): 작업목록이 비활성 체크박스로 렌더되고 [x]는 체크된다(리터럴 텍스트는 안 남음). */
  it("renders task lists as disabled checkboxes", () => {
    const { host } = render(["- [ ] 할 일", "- [x] 완료"].join("\n"));
    const boxes = host.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect(host.textContent).not.toContain("[x]");
    expect(host.textContent).not.toContain("[ ]");
    expect(host.textContent).toContain("완료");
  });

  /** 가드: 중첩 목록은 ul 안 ul로 렌더된다. */
  it("renders nested lists", () => {
    const { host } = render(["- 상위", "  - 하위 1", "  - 하위 2"].join("\n"));
    expect(host.querySelector("ul ul")).not.toBeNull();
    expect(host.querySelectorAll("ul ul li")).toHaveLength(2);
  });

  /** 가드(이미지 정책): 해석기가 있으면 **플러그인 로컬 파일** 이미지만 실제 <img>로 렌더하고,
   * 외부·상위이동·절대경로는 여전히 칩으로 강등된다(로컬만 허용). */
  it("renders only local plugin-file images as <img> when a resolver is given", () => {
    const resolve = (src: string) => `asset://plugins/samp/${src}`;
    const { host } = render(
      [
        "![다이어그램](diagram.png)", // 로컬 → <img>
        "",
        "![외부](https://x.example/a.png)", // 외부 → 칩
        "",
        "![상위](../secret.png)", // 상위 이동 → 칩(해석 안 함)
      ].join("\n"),
      vi.fn(),
      resolve,
    );
    const imgs = host.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(
      "asset://plugins/samp/diagram.png",
    );
    expect(imgs[0].getAttribute("loading")).toBe("lazy");
    expect(imgs[0].getAttribute("alt")).toBe("다이어그램");
    // 외부·상위이동은 <img>가 되지 않고 칩으로 남는다.
    const chips = host.querySelectorAll(".plugin-readme-img");
    expect(chips.length).toBe(2);
  });

  /** 가드: 해석기가 없으면(번들에 이미지 없음 등) 로컬 경로도 칩으로 강등된다(안전 기본값). */
  it("degrades local images to chips when no resolver is provided", () => {
    const { host } = render("![그림](pic.png)");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".plugin-readme-img")).not.toBeNull();
  });

  /** 가드(이미지 정책): 마크다운 이미지는 <img>가 아니라 칩으로 대체된다(https면 클릭 가능). */
  it("renders markdown images as chips, never <img>", () => {
    const { host, openLink } = render(
      ["![다이어그램](https://example.com/a.png)", "", "![로컬](./b.png)"].join(
        "\n",
      ),
    );
    expect(host.querySelector("img")).toBeNull();
    const chips = host.querySelectorAll(".plugin-readme-img");
    expect(chips).toHaveLength(2);
    // https 이미지 칩은 앵커(클릭 → openLink), 비-https는 span(비활성).
    const httpsChip = host.querySelector<HTMLAnchorElement>(
      "a.plugin-readme-img",
    )!;
    expect(httpsChip.textContent).toContain("다이어그램");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    httpsChip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledWith("https://example.com/a.png");
    expect(host.querySelector("span.plugin-readme-img")).not.toBeNull(); // ./b.png
  });

  /** 가드: null/공백 README는 "설명 없음" 안내를 보인다. */
  it("shows the empty note for null or blank input", () => {
    expect(render(null).host.textContent).toBe("설명 없음");
    expect(render("   \n ").host.textContent).toBe("설명 없음");
    expect(
      render(null).host.querySelector(".plugin-readme-empty"),
    ).not.toBeNull();
  });
});
