import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  type DecorationSet,
  type WidgetType,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { livePreview } from "../note/live-preview";
import {
  blockEmbedField,
  buildEmbedUrl,
  extractEmbedId,
  parseBlockEmbedDescriptor,
  type BlockEmbedDescriptor,
} from "./embed";

/** 테스트용 임베드 디스크립터(유튜브 모양의 일반 규칙). */
const DESCRIPTOR: BlockEmbedDescriptor = {
  id: "vid",
  fence: "vid",
  sources: [
    { host: "watch.example", queryParam: "v" },
    { host: "short.example", pathPrefix: "/" },
    { host: "watch.example", pathPrefix: "/clips/" },
  ],
  embedTemplate: "https://embed.example/e/{id}",
};

/** embed.example만 허용하는 도메인 게이트(정확 일치). */
const allowEmbedExample = (domain: string): boolean =>
  domain === "embed.example";

describe("extractEmbedId", () => {
  /** 가드: 쿼리 파라미터 규칙이 다른 파라미터가 섞여도 id를 뽑는다. */
  it("extracts the id from a query parameter", () => {
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://watch.example/w?v=abc&t=42"),
    ).toBe("abc");
  });

  /** 가드: 경로 접두 규칙은 접두사 다음 첫 세그먼트만 id로 삼는다. */
  it("extracts the first path segment after the prefix", () => {
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://short.example/xyz"),
    ).toBe("xyz");
    expect(
      extractEmbedId(
        DESCRIPTOR.sources,
        "https://watch.example/clips/c1/extra",
      ),
    ).toBe("c1");
  });

  /** 가드: 소스 앞뒤 공백은 허용하되 내부 공백/줄바꿈은 거부한다(URL 파서의 개행 제거 방어). */
  it("trims the source but rejects internal whitespace", () => {
    expect(
      extractEmbedId(DESCRIPTOR.sources, "  https://short.example/xyz \n"),
    ).toBe("xyz");
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://short.example/xyz\ngarbage"),
    ).toBeNull();
  });

  /** 가드(보안): 호스트는 정확 일치 — 서브도메인 위장·접미 위장은 거부한다. */
  it("rejects lookalike hosts (subdomain and suffix tricks)", () => {
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://evil.watch.example/w?v=abc"),
    ).toBeNull();
    expect(
      extractEmbedId(
        DESCRIPTOR.sources,
        "https://watch.example.evil.com/w?v=a",
      ),
    ).toBeNull();
  });

  /** 가드(보안): https가 아닌 소스는 거부한다. */
  it("rejects non-https sources", () => {
    expect(
      extractEmbedId(DESCRIPTOR.sources, "http://watch.example/w?v=abc"),
    ).toBeNull();
  });

  /** 가드: URL이 아니거나 비었거나 규칙에 안 맞으면 null(조용한 실패). */
  it("returns null for non-URL, empty, or unmatched sources", () => {
    expect(extractEmbedId(DESCRIPTOR.sources, "그냥 텍스트")).toBeNull();
    expect(extractEmbedId(DESCRIPTOR.sources, "")).toBeNull();
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://other.example/w?v=abc"),
    ).toBeNull();
    expect(
      extractEmbedId(DESCRIPTOR.sources, "https://watch.example/w?other=1"),
    ).toBeNull();
  });

  /** 가드: 과도하게 긴 소스는 방어적으로 거부한다. */
  it("rejects oversized sources", () => {
    const long = `https://short.example/${"a".repeat(3000)}`;
    expect(extractEmbedId(DESCRIPTOR.sources, long)).toBeNull();
  });
});

describe("buildEmbedUrl (도메인 게이트)", () => {
  /** 가드: 승인된 도메인이면 템플릿 치환된 최종 https URL을 돌려준다. */
  it("builds the final URL for a granted domain", () => {
    expect(
      buildEmbedUrl(
        DESCRIPTOR,
        "https://watch.example/w?v=abc",
        allowEmbedExample,
      ),
    ).toBe("https://embed.example/e/abc");
  });

  /** 가드(보안 핵심): 미승인 도메인 템플릿은 id가 유효해도 렌더가 거부된다. */
  it("refuses when the final domain is not granted", () => {
    const evil: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "https://evil.example/e/{id}",
    };
    expect(
      buildEmbedUrl(evil, "https://watch.example/w?v=abc", allowEmbedExample),
    ).toBeNull();
  });

  /** 가드(보안): userinfo `@` 트릭 템플릿은 최종 hostname(evil) 기준으로 판정된다. */
  it("judges by the parsed hostname, defeating userinfo tricks", () => {
    const seen: string[] = [];
    const tricky: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "https://embed.example@evil.example/e/{id}",
    };
    const result = buildEmbedUrl(
      tricky,
      "https://watch.example/w?v=abc",
      (domain) => {
        seen.push(domain);
        return domain === "embed.example";
      },
    );
    expect(result).toBeNull();
    expect(seen).toEqual(["evil.example"]); // 위장 문자열이 아니라 실제 호스트로 검사됐다.
  });

  /** 가드(보안): id는 URL 인코딩되어 경로 탈출·호스트 변조가 불가능하다. */
  it("URL-encodes the id so it cannot escape the template path", () => {
    const url = buildEmbedUrl(
      DESCRIPTOR,
      "https://watch.example/w?v=..%2F..%2Fetc",
      allowEmbedExample,
    );
    // 쿼리 파라미터 값 "../..%2Fetc"류가 와도 최종 URL의 호스트·경로 접두는 유지된다.
    expect(url).not.toBeNull();
    expect(url!.startsWith("https://embed.example/e/")).toBe(true);
    expect(new URL(url!).hostname).toBe("embed.example");

    const at = buildEmbedUrl(
      DESCRIPTOR,
      "https://watch.example/w?v=x@evil.example",
      allowEmbedExample,
    );
    expect(new URL(at!).hostname).toBe("embed.example");
  });

  /** 가드(보안): 최종 URL이 https가 아니면 도메인과 무관하게 거부한다. */
  it("refuses non-https final URLs", () => {
    const http: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "http://embed.example/e/{id}",
    };
    expect(
      buildEmbedUrl(http, "https://watch.example/w?v=abc", () => true),
    ).toBeNull();
  });

  /** 가드: 소스에서 id를 못 뽑으면 게이트 전에 null(게이트 호출 없음). */
  it("returns null without consulting the gate when no id is found", () => {
    const gate = vi.fn(() => true);
    expect(buildEmbedUrl(DESCRIPTOR, "not a url", gate)).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });

  /** 가드(보안 회귀): IDN 퓨니코드·후행 점 위장은 차단되고, 포트 붙임은 수용된다. */
  it("pins IDN punycode, trailing-dot, and port edge vectors", () => {
    // 키릴 'е'가 섞인 유사 도메인: URL 파서가 퓨니코드(xn--)로 정규화하므로
    // 게이트는 위장 문자열이 아니라 정규화된 호스트로 비교해 정확 일치에 실패한다.
    const seen: string[] = [];
    const idn: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "https://embed.еxample/e/{id}",
    };
    expect(
      buildEmbedUrl(idn, "https://watch.example/w?v=abc", (domain) => {
        seen.push(domain);
        return domain === "embed.example";
      }),
    ).toBeNull();
    expect(seen[0]).toContain("xn--"); // 퓨니코드로 정규화된 호스트로 검사됐다.

    // 후행 점(FQDN 표기)은 hostname에 그대로 보존돼 별개 문자열로 취급된다 → 차단.
    const dotted: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "https://embed.example./e/{id}",
    };
    expect(
      buildEmbedUrl(dotted, "https://watch.example/w?v=abc", allowEmbedExample),
    ).toBeNull();

    // 포트 붙임: URL.hostname은 포트를 제외하므로 게이트를 통과한다 — 다른 포트라도
    // 같은 granted 도메인 소유자의 콘텐츠라 수용하는 것이 현 설계 의도다.
    const port: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate: "https://embed.example:8443/e/{id}",
    };
    expect(
      buildEmbedUrl(port, "https://watch.example/w?v=abc", allowEmbedExample),
    ).toBe("https://embed.example:8443/e/abc");
  });

  /** 가드(보안): 템플릿의 쿼리 파라미터(RMF 식별 등)는 id 주입으로 덮어쓸 수 없다. */
  it("keeps template query parameters immune to id injection", () => {
    const withParams: BlockEmbedDescriptor = {
      ...DESCRIPTOR,
      embedTemplate:
        "https://embed.example/e/{id}?origin=https%3A%2F%2Fapp.example",
    };
    // 소스의 v 값 "x&origin=evil.example"(디코드 후)이 id로 들어와도, id는 경로에
    // 인코딩되어 삽입되므로 쿼리를 추가·변조하지 못한다.
    const url = buildEmbedUrl(
      withParams,
      "https://watch.example/w?v=x%26origin%3Devil.example",
      allowEmbedExample,
    );
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.getAll("origin")).toEqual([
      "https://app.example",
    ]);
    expect(parsed.pathname.startsWith("/e/x%26origin%3D")).toBe(true);
  });
});

describe("parseBlockEmbedDescriptor", () => {
  const VALID: Record<string, unknown> = {
    id: "vid",
    fence: "vid",
    sources: [{ host: "watch.example", queryParam: "v" }],
    embedTemplate: "https://embed.example/e/{id}",
  };

  /** 거부된 필드 이름만 뽑는다(성공이면 null — 실패 단언을 한 줄로 쓰기 위함). */
  const rejectedField = (over: Record<string, unknown>): string | null => {
    const r = parseBlockEmbedDescriptor({ ...VALID, ...over });
    return r.ok ? null : r.field;
  };

  /** 가드: 유효한 디스크립터는 필드 그대로 통과한다. */
  it("accepts a valid descriptor", () => {
    const r = parseBlockEmbedDescriptor(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.descriptor.fence).toBe("vid");
    expect(r.descriptor.sources).toEqual([
      { host: "watch.example", queryParam: "v" },
    ]);
  });

  /**
   * 가드(핵심): 형식 위반은 거부하되 **어느 필드인지**를 함께 돌려준다.
   *
   * 왜: 예전에는 전부 `null` 하나였고 호출부가 필드 구분 없이 「잘못된 블록 임베드
   * 디스크립터」로 감쌌다 — 저작 문서까지 "먼저 `id`를 확인하라"고 안내해 `fence`는
   * 용의선상에도 없었다. 대문자 펜스 태그 하나로 임베드가 통째로 안 뜨는 원인을 저작자가
   * 끝내 못 찾던 자리다.
   */
  it("names the field it rejected", () => {
    expect(rejectedField({ id: "Bad Id!" })).toBe("id");
    expect(rejectedField({ fence: "```" })).toBe("fence");
    // 대문자 펜스 — id와 **같은** 형식 규칙이다.
    expect(rejectedField({ fence: "YouTube" })).toBe("fence");
    expect(rejectedField({ embedTemplate: "https://embed.example/e/" })).toBe(
      "embedTemplate",
    );
    expect(
      rejectedField({ embedTemplate: "http://embed.example/e/{id}" }),
    ).toBe("embedTemplate");
    expect(rejectedField({ sources: [] })).toBe("sources");
    expect(rejectedField({ sources: "x" })).toBe("sources");
    expect(rejectedField({ sources: new Array(33).fill(VALID.sources) })).toBe(
      "sources",
    );
  });

  /** 가드: 사유 문구는 정규식·상한 상수에서 파생된다(규칙과 문구가 어긋날 수 없다). */
  it("explains why, deriving the wording from the rule itself", () => {
    const r = parseBlockEmbedDescriptor({ ...VALID, fence: "YouTube" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("[a-z0-9]");
    const s = parseBlockEmbedDescriptor({ ...VALID, sources: [] });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.reason).toContain("32");
  });

  /** 가드: 규칙은 host 형식 + queryParam/pathPrefix 정확히 하나여야 한다(위치까지 지목한다). */
  it("rejects rules without exactly one extractor or with a bad host", () => {
    const withSources = (sources: unknown) => rejectedField({ sources });
    expect(withSources([{ host: "watch.example" }])).toBe("sources[0]");
    expect(
      withSources([
        { host: "watch.example", queryParam: "v", pathPrefix: "/" },
      ]),
    ).toBe("sources[0]");
    expect(
      withSources([{ host: "https://watch.example", queryParam: "v" }]),
    ).toBe("sources[0].host");
    expect(withSources([{ host: "watch.example", pathPrefix: "clips/" }])).toBe(
      "sources[0].pathPrefix",
    );
    expect(withSources([{ host: "watch.example", queryParam: "" }])).toBe(
      "sources[0].queryParam",
    );
    expect(withSources([null])).toBe("sources[0]");
    // 위치 색인이 실제 인덱스를 가리킨다(첫 규칙이 유효할 때 두 번째를 지목한다).
    expect(
      withSources([{ host: "watch.example", queryParam: "v" }, null]),
    ).toBe("sources[1]");
  });
});

// --- StateField 배치·커서 reveal (헤드리스 EditorState — 표 블록 위젯과 같은 규칙) ---

/** 임베드 펜스가 든 테스트 문서. */
const DOC = "제목\n\n```vid\nhttps://watch.example/w?v=abc\n```\n\n끝";

/** 문서·커서 위치·게이트로 상태를 만들고 임베드 데코레이션 집합을 돌려준다. */
function embedDecorations(
  doc: string,
  anchor: number,
  allowDomain: (domain: string) => boolean = allowEmbedExample,
): DecorationSet {
  const field = blockEmbedField([DESCRIPTOR], allowDomain);
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage, extensions: GFM }), field],
  });
  return state.field(field);
}

describe("blockEmbedField", () => {
  /** 가드: 커서가 블록 밖이면 펜스 전체가 블록 위젯 하나로 치환된다. */
  it("replaces the whole fence with one block widget when the cursor is outside", () => {
    const deco = embedDecorations(DOC, DOC.length);
    expect(deco.size).toBe(1);
    const iter = deco.iter();
    expect(iter.from).toBe(DOC.indexOf("```"));
    expect(iter.to).toBe(DOC.lastIndexOf("```") + 3);
  });

  /** 가드: 커서가 블록 안이면 원문이 보인다(위젯 없음 — 편집용 reveal). */
  it("reveals the source when the cursor is inside the fence", () => {
    const deco = embedDecorations(DOC, DOC.indexOf("watch.example"));
    expect(deco.size).toBe(0);
  });

  /** 가드: 문서 끝이 임베드인 노트도 기본 커서(문서 끝)에서 위젯으로 렌더된다(끝 경계 배타). */
  it("renders a fence at end-of-document with the default cursor", () => {
    const doc = "```vid\nhttps://watch.example/w?v=abc\n```";
    expect(embedDecorations(doc, doc.length).size).toBe(1);
  });

  /** 가드: 등록되지 않은 펜스(일반 코드블록)는 건드리지 않는다. */
  it("ignores unregistered fences", () => {
    const doc = "```js\nconst x = 1;\n```\n\n끝";
    expect(embedDecorations(doc, doc.length).size).toBe(0);
  });

  /** 가드(보안): 도메인 게이트가 거부하면 위젯 없이 원문이 유지된다. */
  it("keeps the source untouched when the domain gate refuses", () => {
    expect(embedDecorations(DOC, DOC.length, () => false).size).toBe(0);
  });

  /** 가드: 승인된 임베드 펜스가 여러 개면 각각 블록 위젯으로 렌더된다. */
  it("renders multiple granted embeds in one document", () => {
    const doc = [
      "```vid",
      "https://watch.example/w?v=one",
      "```",
      "",
      "중간 문단",
      "",
      "```vid",
      "https://short.example/two",
      "```",
      "",
      "끝",
    ].join("\n");
    expect(embedDecorations(doc, doc.length).size).toBe(2);
  });

  /** 가드: 내용 없는 펜스(빈/공백뿐 — CodeText 부재 포함)는 위젯 없이 원문 유지. */
  it("leaves empty or whitespace-only fences as source", () => {
    const empty = "```vid\n```\n\n끝";
    expect(embedDecorations(empty, empty.length).size).toBe(0);
    const blank = "```vid\n\n```\n\n끝";
    expect(embedDecorations(blank, blank.length).size).toBe(0);
  });
});

// --- 기존 블록 위젯(표 — note/live-preview)과의 공존 ---

describe("blockPreviewField와의 공존", () => {
  /** 가드: 같은 문서에서 표(내장 필드)와 임베드(플러그인 필드)가 겹침 없이 동시 렌더된다. */
  it("renders a table and an embed side by side without overlap", () => {
    const doc = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```vid",
      "https://watch.example/w?v=abc",
      "```",
      "",
      "끝",
    ].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: GFM }),
        livePreview(),
        blockEmbedField([DESCRIPTOR], allowEmbedExample),
      ],
    });
    // 두 StateField가 제공한 블록 데코레이션을 전부 모은다(ViewPlugin 항목은 함수라 제외).
    const ranges: [number, number][] = [];
    for (const provided of state.facet(EditorView.decorations)) {
      if (typeof provided === "function") continue;
      for (const iter = provided.iter(); iter.value !== null; iter.next()) {
        ranges.push([iter.from, iter.to]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const tableEnd = doc.indexOf("| 1 | 2 |") + "| 1 | 2 |".length;
    const fenceFrom = doc.indexOf("```vid");
    const fenceTo = doc.lastIndexOf("```") + 3;
    // 표 전체 + 펜스 전체가 각각 한 위젯 — 범위가 서로 겹치지 않는다.
    expect(ranges).toEqual([
      [0, tableEnd],
      [fenceFrom, fenceTo],
    ]);
  });
});

// --- 위젯 DOM(격리 iframe + lazy 로드) ---

/** 위젯 인스턴스가 실제로 노출하는 DOM·동등성 계약(테스트에서 쓰는 최소 표면). */
interface EmbedWidgetLike {
  toDOM(): HTMLElement;
  destroy(dom: HTMLElement): void;
  eq(other: EmbedWidgetLike): boolean;
}

/** 문서 끝 커서 상태에서 임베드 위젯 인스턴스를 꺼낸다(기본 문서는 DOC). */
function embedWidget(doc: string = DOC): EmbedWidgetLike {
  const deco = embedDecorations(doc, doc.length);
  const spec = deco.iter().value!.spec as { widget: WidgetType };
  return spec.widget as unknown as EmbedWidgetLike;
}

/** IntersectionObserver 대역 — 콜백을 수동으로 쏠 수 있게 노출한다. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** 대역 옵저버에게 "보인다" 신호를 보낸다. */
function intersect(fake: FakeIntersectionObserver): void {
  fake.callback(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    fake as unknown as IntersectionObserver,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeIntersectionObserver.instances = [];
});

describe("EmbedWidget DOM", () => {
  /** 가드(격리): iframe은 엄격한 sandbox/allow/referrerpolicy 속성으로 렌더된다. */
  it("renders the iframe with strict isolation attributes", () => {
    // jsdom에는 IntersectionObserver가 없어 즉시 마운트 경로를 탄다(방어 폴백).
    const dom = embedWidget().toDOM();
    const frame = dom.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.src).toBe("https://embed.example/e/abc");
    expect(frame!.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(frame!.getAttribute("allow")).toBe(
      "autoplay; encrypted-media; fullscreen; picture-in-picture",
    );
    // RMF 클라이언트 식별: origin만 전달(no-referrer는 Error 153을 유발했다).
    expect(frame!.getAttribute("referrerpolicy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  /** 가드(lazy): 뷰포트에 들어오기 전에는 플레이스홀더만, 교차 후에 iframe src가 세팅된다. */
  it("defers the iframe until the widget intersects the viewport", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const dom = embedWidget().toDOM();

    expect(dom.querySelector("iframe")).toBeNull();
    expect(dom.querySelector(".cm-embed-placeholder")).not.toBeNull();

    const fake = FakeIntersectionObserver.instances[0];
    expect(fake.observed).toEqual([dom]);
    intersect(fake);

    expect(dom.querySelector(".cm-embed-placeholder")).toBeNull();
    expect(dom.querySelector("iframe")!.src).toBe(
      "https://embed.example/e/abc",
    );
    expect(fake.disconnected).toBe(true); // 1회 로드 후 관찰 해제.
  });

  /** 가드: 교차 전에 위젯이 파괴되면 옵저버를 해제한다(누수 방지). */
  it("disconnects the observer when destroyed before intersecting", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const widget = embedWidget();
    const dom = widget.toDOM();
    const fake = FakeIntersectionObserver.instances[0];
    widget.destroy(dom);
    expect(fake.disconnected).toBe(true);
  });

  /** 가드(성능 계약): 같은 url·플러그인의 위젯은 eq — 무관한 커서 이동이 iframe을 리로드하지 않는다. */
  it("treats widgets with the same url and plugin as equal", () => {
    expect(embedWidget().eq(embedWidget())).toBe(true);
  });

  /** 가드: 최종 url이 다르면 eq가 아니다(위젯 교체 → 새 iframe이 맞다). */
  it("treats widgets with different urls as not equal", () => {
    const other = embedWidget(DOC.replace("v=abc", "v=zzz"));
    expect(embedWidget().eq(other)).toBe(false);
  });
});
