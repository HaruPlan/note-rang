/**
 * 하이브리드 라이브 프리뷰 확장 (GFM 본격판).
 *
 * 역할: 마크다운을 렌더 스타일로 보여주되, 편집 중인 곳만 원문을 노출한다.
 * - 인라인/문단(굵게·기울임·인라인코드·취소선·헤딩): **라인 단위** — 커서가 놓인
 *   줄만 원문.
 * - 코드펜스: **블록 단위** — 커서가 그 블록 안에 있을 때만 펜스(```)를 원문 노출.
 * - GFM 표: **블록 위젯**(StateField) — 커서가 표 밖이면 렌더된 `<table>`, 안이면 원문.
 * - 작업목록 `[ ]`/`[x]`: 클릭 토글 **체크박스 위젯**.
 * 왜: 이 앱의 시그니처 기능. 인라인/라인은 ViewPlugin이, 블록(여러 줄→한 위젯)은 StateField가
 * 맡는 하이브리드(블록 데코레이션은 ViewPlugin으로 불가).
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { parseImageAltSize } from "./image-size";

/** 마크다운 마커를 화면에서 숨긴다(원문 보존, 표시만 제거). */
const hide = Decoration.replace({});
const strong = Decoration.mark({ class: "cm-strong" });
const emphasis = Decoration.mark({ class: "cm-em" });
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const strike = Decoration.mark({ class: "cm-strike" });

/** 본문 경로를 웹뷰가 로드할 수 있는 URL로 바꾸는 함수(주입). */
type ResolveImageSrc = (path: string) => string;

/**
 * 링크를 시스템 기본 브라우저로 넘기는 함수(주입 — 웹뷰 안에서는 절대 탐색하지 않는다).
 *
 * 반환값은 무시해도 되지만(대부분의 주입 구현이 내부에서 이미 실패를 삼킨다), Promise를
 * 돌려주면 mousedown 핸들러가 그 실패를 콘솔에라도 남긴다 — 백엔드 호출이 조용히 죽어
 * "눌러도 반응 없음"으로만 보이는 걸 막기 위함(#23).
 */
type OpenExternalUrl = (url: string) => void | Promise<void>;

/**
 * 라이브 프리뷰 옵션 — 이미지 경로 해석기, 링크 열기 핸들러(둘 다 없으면 그 기능만 꺼진다).
 */
interface LivePreviewOptions {
  resolveImageSrc?: ResolveImageSrc;
  openExternalUrl?: OpenExternalUrl;
}

/**
 * 링크로 렌더할 수 있는 스킴 전수 — 백엔드 `open_external_url`의 allowlist와 같은 집합.
 *
 * 여기서 거른 것은 **표시 여부**일 뿐이고 실제 판정은 백엔드가 다시 한다. 프론트에서도 거르는
 * 이유는, 열리지도 않을 주소를 링크 모양으로 보여 주면 클릭이 조용히 죽기 때문이다 — 못 여는
 * 링크는 아예 원문(`[텍스트](스킴:...)`)으로 남겨 사용자가 무엇이 문제인지 보게 한다.
 */
const OPENABLE_SCHEMES = ["https://", "http://", "mailto:"] as const;

/**
 * 이 URL을 링크로 렌더하고 클릭 시 브라우저로 넘겨도 되는지 판정한다(순수, 테스트용).
 *
 * 꺾쇠 형식(`<https://x>`)은 마크다운이 허용하므로 벗겨서 본다. 공백·제어문자가 섞였거나
 * 스킴 뒤 대상이 비면 거부한다(백엔드와 같은 규칙).
 */
export function isOpenableUrl(url: string): boolean {
  const bare = bareUrl(url);
  if (/\s/.test(bare) || [...bare].some(isControlChar)) return false;
  const scheme = OPENABLE_SCHEMES.find((s) => bare.toLowerCase().startsWith(s));
  return scheme !== undefined && bare.length > scheme.length;
}

/** C0/DEL 제어문자 하나인지 — 정규식에 제어문자 리터럴을 박지 않으려고 코드포인트로 본다. */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** URL 원문에서 바깥 공백과 마크다운 꺾쇠(`<...>`)를 벗긴다 — 판정과 전달이 같은 문자열을 본다. */
function bareUrl(url: string): string {
  return url.trim().replace(/^<(.*)>$/, "$1");
}

/**
 * 링크 텍스트에 얹는 마크 — 스타일(`cm-md-link`)·클릭 훅(`data-md-link-url`)·hover 시
 * 대상 주소를 보여주는 `title` 툴팁을 함께 단다(어디로 열리는지 클릭 전에 알 수 있게).
 */
function linkMark(url: string): Decoration {
  const href = bareUrl(url);
  return Decoration.mark({
    class: "cm-md-link",
    attributes: { "data-md-link-url": href, title: href },
  });
}

/** 이미지 마크다운 파싱 결과(대체텍스트 + 경로). */
interface ParsedImage {
  alt: string;
  path: string;
}

/**
 * `![alt](path)` 한 토막을 alt·path로 파싱한다(순수, 테스트용). 형식이 아니면 null.
 *
 * 역할: 위젯이 노드 원문에서 alt/경로를 꺼내는 규칙을 한 곳에 고정한다.
 * 왜: 경로 추출 로직을 GUI 없이 단위 테스트로 못박기 위함. 경로는 trim만 하고(공백 제거)
 * 그 외 가공은 하지 않는다 — 해석(웹뷰 URL화)은 호출 측 resolver가 맡는다.
 */
export function parseImageMarkdown(source: string): ParsedImage | null {
  const match = /^!\[([^\]]*)\]\(\s*(\S+?)\s*\)$/.exec(source.trim());
  if (!match) return null;
  return { alt: match[1], path: match[2] };
}

/**
 * `syntaxTree` 노드에서 부모 사슬을 타는 데 필요한 최소 구조(@lezer/common 직접 의존 회피 —
 * `plugin/embed.ts`와 같은 관례. 그 패키지는 CodeMirror의 전이 의존이라 직접 import하지 않는다).
 */
interface ImageNodeChain {
  name: string;
  from: number;
  to: number;
  parent: ImageNodeChain | null;
}

/**
 * 문서 위치 하나로 해석한 이미지 마크다운의 범위 — [`imageSourceAt`]의 결과.
 *
 * `from`/`to`는 `![alt](url)` **전체** 범위, `altFrom`/`altTo`는 그중 alt 글자만의 범위다.
 * 크기 조정은 alt만 바꾸므로 되쓰기는 후자에만 일어난다(URL은 한 글자도 건드리지 않는다).
 * `source`는 클릭 시점의 전체 원문이라, 다이얼로그가 열려 있는 사이 본문이 바뀌었는지
 * 적용 직전에 대조하는 데 쓴다.
 */
export interface ImageSourceSpan {
  from: number;
  to: number;
  source: string;
  altFrom: number;
  altTo: number;
  alt: string;
}

/**
 * 문서 위치 `pos`에 있는 이미지 마크다운의 소스 범위를 해석한다(순수, 테스트용). 없으면 null.
 *
 * 역할: 렌더된 `<img>`(위젯)를 우클릭했을 때 "이 그림이 본문 어디에서 왔는가"를 확정한다.
 * 호출 측은 `view.posAtDOM(img)`로 얻은 위치(= 위젯을 만든 replace 데코레이션의 시작 = 이미지
 * 노드의 `from`)를 그대로 넘긴다.
 *
 * 왜 위젯 DOM에 위치를 박아두지 않고 클릭 시점에 다시 해석하나: 위젯은 `eq()`가 같으면 문서가
 * 앞에서 편집돼 위치가 밀려도 **재생성되지 않는다**. 미리 박아둔 숫자는 그 순간 stale해지고,
 * 그것으로 되쓰면 엉뚱한 자리를 덮어쓴다. 반면 syntax tree는 항상 현재 문서의 것이다.
 *
 * 왜 `resolveInner(pos, 1)`인가: 앞쪽(side=-1)이 아니라 **뒤쪽**을 보게 해야 `![a](x)![b](y)`처럼
 * 이미지가 딱 붙어 있을 때 두 번째 이미지의 시작 위치가 첫 번째 이미지의 끝으로 해석되지 않는다.
 * 위젯이 사라진 직후(그 자리가 더는 이미지가 아님)에는 부모 사슬에 Image가 없어 null이 된다.
 */
export function imageSourceAt(
  state: EditorState,
  pos: number,
): ImageSourceSpan | null {
  const at = Math.max(0, Math.min(pos, state.doc.length));
  let node: ImageNodeChain | null = syntaxTree(state).resolveInner(at, 1);
  while (node && node.name !== "Image") node = node.parent;
  if (!node) return null;
  const source = state.sliceDoc(node.from, node.to);
  // alt 범위는 원문에서 직접 잰다(trim하지 않는다) — 문서 오프셋과 한 글자도 어긋나면 안 된다.
  // `](`를 요구해 참조식 이미지(`![alt][ref]`)는 제외한다: 그쪽은 크기 토큰을 실을 자리가 아니다.
  const match = /^!\[([^\]]*)\]\(/.exec(source);
  if (!match) return null;
  const alt = match[1];
  const altFrom = node.from + 2; // `![` 다음.
  return {
    from: node.from,
    to: node.to,
    source,
    altFrom,
    altTo: altFrom + alt.length,
    alt,
  };
}

/**
 * alt에서 뽑은 크기 지정을 `<img>`에 인라인 스타일로 건다(순수 DOM 조작, 클래스의
 * `max-width:100%; height:auto`와 공존하도록 설계 — `image-size.ts` 문서 참고).
 *
 * - 둘 다 있으면: `width`를 고정하고 `aspect-ratio`만 얹는다(`height`는 지정하지 않음) —
 *   그래야 좁은 창에서 `max-width`가 폭을 줄여도 클래스의 `height:auto`가 aspect-ratio로
 *   높이를 다시 계산해 비율이 유지된다. 여기서 직접 `height`를 고정해버리면 폭만 줄어들고
 *   높이는 그대로라 이미지가 찌그러진다.
 * - 하나만 있으면: 그 축만 고정한다. 반대 축은 스타일을 안 건드려 브라우저 기본 동작
 *   (`auto`)이 이미지 원본 비율로 계산하게 둔다.
 */
function applyImageSize(
  img: HTMLImageElement,
  width: number | null,
  height: number | null,
): void {
  if (width !== null) img.style.width = `${width}px`;
  if (width !== null && height !== null) {
    img.style.aspectRatio = `${width} / ${height}`;
  } else if (height !== null) {
    img.style.height = `${height}px`;
  }
}

/** `![...](...)` 이미지를 `<img>`로 렌더하는 위젯(인라인·블록 공용). */
class ImageWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly resolveSrc: ResolveImageSrc,
    private readonly block: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.source === this.source && other.block === this.block;
  }

  toDOM(): HTMLElement {
    const parsed = parseImageMarkdown(this.source);
    const img = document.createElement("img");
    img.className = this.block
      ? "cm-md-image cm-md-image-block"
      : "cm-md-image";
    if (parsed) {
      img.src = this.resolveSrc(parsed.path);
      const { alt, width, height } = parseImageAltSize(parsed.alt);
      img.alt = alt;
      applyImageSize(img, width, height);
    }
    return img;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * ATX 헤딩 노드 이름에서 레벨(1~6)을 뽑는다. 헤딩이 아니면 null.
 *
 * 역할: 노드 이름 파싱을 순수 함수로 분리해 단위 테스트로 고정한다.
 */
export function headingLevel(nodeName: string): number | null {
  const match = /^ATXHeading([1-6])$/.exec(nodeName);
  return match ? Number(match[1]) : null;
}

/** 작업목록 체크박스 위젯 — 클릭 시 `[ ]`↔`[x]`를 토글한다. */
class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly markPos: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.markPos === this.markPos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-checkbox";
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        changes: {
          from: this.markPos,
          to: this.markPos + 1,
          insert: this.checked ? " " : "x",
        },
      });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 수평 구분선(`---`)을 렌더하는 위젯 — 커서가 그 줄 밖일 때 `---`를 선으로 바꾼다. */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 부모 노드의 식별 정보(이름·범위) — 단독 이미지 판정 입력. */
interface ParentSpan {
  name: string;
  from: number;
  to: number;
}

/**
 * 이미지 노드가 문단 전체를 차지하는 "단독 이미지"인지 판정한다(순수, 테스트용).
 *
 * 역할: 단독 이미지는 블록 위젯(StateField)이, 글 사이 인라인 이미지는 ViewPlugin이 맡도록
 * 경계를 한 규칙으로 고정한다 — 둘이 같은 노드를 동시에 렌더해 겹치는 것을 막는다.
 * 왜: 블록/인라인 데코레이션은 서로 다른 메커니즘(StateField/ViewPlugin)이라 중복 방지가 필요.
 * 부모가 문단이고 그 문단의 범위가 이미지 범위와 정확히 같으면(앞뒤로 다른 텍스트가 없으면) 단독.
 */
export function isStandaloneImage(
  imageFrom: number,
  imageTo: number,
  parent: ParentSpan | null | undefined,
): boolean {
  return (
    parent?.name === "Paragraph" &&
    parent.from === imageFrom &&
    parent.to === imageTo
  );
}

/** 현재 뷰 상태로부터 라이브 프리뷰 데코레이션 집합을 만든다. */
function buildDecorations(
  view: EditorView,
  resolveImageSrc?: ResolveImageSrc,
): DecorationSet {
  const { state } = view;
  const head = state.selection.main.head;
  const cursorLine = state.doc.lineAt(head).number;
  const ranges: Range<Decoration>[] = [];

  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const name = node.name;

        // 인라인 이미지: 글 사이(단독 아님) 이미지를 `<img>`로. 단독 이미지는 블록 필드가 맡고,
        // 커서가 이미지 줄에 있으면 원문(`![]()`)을 그대로 노출(편집용).
        if (name === "Image") {
          if (
            resolveImageSrc &&
            !isStandaloneImage(node.from, node.to, node.node.parent) &&
            state.doc.lineAt(node.from).number !== cursorLine
          ) {
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(
                  state.sliceDoc(node.from, node.to),
                  resolveImageSrc,
                  false,
                ),
              }).range(node.from, node.to),
            );
          }
          return false; // 이미지 내부(LinkMark/URL)는 더 내려가지 않는다.
        }

        // 작업목록 체크박스: 항상 위젯(클릭 토글). 마커 가운데 글자 위치를 넘긴다.
        if (name === "TaskMarker") {
          const checked = /x/i.test(state.sliceDoc(node.from, node.to));
          ranges.push(
            Decoration.replace({
              widget: new CheckboxWidget(checked, node.from + 1),
            }).range(node.from, node.to),
          );
          return;
        }

        // 코드 마커(펜스 ``` 또는 인라인 `): 블록/라인 단위로 숨김 판정.
        if (name === "CodeMark" || name === "CodeInfo") {
          const parent = node.node.parent;
          if (parent?.name === "FencedCode") {
            const inBlock = head >= parent.from && head <= parent.to;
            if (!inBlock) ranges.push(hide.range(node.from, node.to));
          } else if (parent?.name === "InlineCode") {
            if (state.doc.lineAt(node.from).number !== cursorLine) {
              ranges.push(hide.range(node.from, node.to));
            }
          }
          return;
        }

        // 여기서부터는 라인 단위: 커서가 있는 줄은 원문 그대로.
        if (state.doc.lineAt(node.from).number === cursorLine) return;

        const level = headingLevel(name);
        if (level !== null) {
          ranges.push(
            Decoration.line({ class: `cm-h${level}` }).range(
              state.doc.lineAt(node.from).from,
            ),
          );
          return;
        }

        // 수평 구분선 `---`(HorizontalRule): 커서 없는 줄이면 선 위젯으로 치환(원문 보존).
        if (name === "HorizontalRule") {
          ranges.push(
            Decoration.replace({ widget: new HrWidget() }).range(
              node.from,
              node.to,
            ),
          );
          return false;
        }

        // 마크다운 링크 `[텍스트](url)`와 꺾쇠 자동링크 `<url>`: 마커를 숨기고 텍스트만
        // 클릭 가능한 링크로 남긴다.
        // 왜 URL 자식을 요구하나: lezer는 `[[위키링크]]`·`[각주]`도 Link로 파싱한다(URL 자식
        // 없음). 그것까지 여기서 숨기면 위키링크 플러그인이 같은 자리에 내는 replace
        // 데코레이션과 부분적으로 겹친다 — URL 유무로 게이트해 아예 만나지 않게 한다.
        if (name === "Link" || name === "Autolink") {
          const target = node.node.getChild("URL");
          if (!target) return false;
          const url = state.sliceDoc(target.from, target.to);
          if (!isOpenableUrl(url)) return false; // 못 여는 스킴은 원문 그대로 둔다.
          const marks = node.node.getChildren("LinkMark");
          if (marks.length < 2) return false;
          // 인라인 링크는 마커가 4개(`[` `]` `(` `)`)라 표시할 글자는 앞 두 마커 사이,
          // 꺾쇠 자동링크는 2개(`<` `>`)라 URL 자체가 표시할 글자다.
          const inline = marks.length >= 4;
          const textFrom = inline ? marks[0].to : target.from;
          const textTo = inline ? marks[1].from : target.to;
          if (textFrom >= textTo) return false; // 보여 줄 글자가 없다(`[]()` 등).
          ranges.push(hide.range(marks[0].from, textFrom));
          ranges.push(linkMark(url).range(textFrom, textTo));
          ranges.push(hide.range(textTo, marks[marks.length - 1].to));
          // 자식으로 계속 내려간다 — 링크 텍스트 안의 굵게·기울임이 그대로 살아야 한다.
          return;
        }

        // GFM 자동링크: 본문에 그냥 쓴 `https://…`도 클릭 가능하게(마커가 없어 숨길 것도 없다).
        // Link·Image·Autolink 안의 URL은 그 부모가 이미 처리했으므로 제외한다.
        if (name === "URL") {
          const parent = node.node.parent?.name;
          if (
            parent !== "Link" &&
            parent !== "Image" &&
            parent !== "Autolink"
          ) {
            const url = state.sliceDoc(node.from, node.to);
            if (isOpenableUrl(url)) {
              ranges.push(linkMark(url).range(node.from, node.to));
            }
          }
          return false;
        }

        switch (name) {
          case "HeaderMark": {
            // '#' 마커 + 뒤따르는 공백까지 숨긴다: 소스의 `# `는 유지(헤딩 인식)하되
            // 렌더 시 왼쪽에 남는 잔여 공백(들여쓰기처럼 보임)을 없앤다.
            let to = node.to;
            const lineEnd = state.doc.lineAt(node.from).to;
            while (to < lineEnd && state.sliceDoc(to, to + 1) === " ") to++;
            ranges.push(hide.range(node.from, to));
            break;
          }
          case "StrongEmphasis":
            ranges.push(strong.range(node.from, node.to));
            break;
          case "Emphasis":
            ranges.push(emphasis.range(node.from, node.to));
            break;
          case "InlineCode":
            ranges.push(inlineCode.range(node.from, node.to));
            break;
          case "Strikethrough":
            ranges.push(strike.range(node.from, node.to));
            break;
          case "EmphasisMark": {
            const p = node.node.parent?.name;
            if (p === "StrongEmphasis" || p === "Emphasis") {
              ranges.push(hide.range(node.from, node.to));
            }
            break;
          }
          case "StrikethroughMark":
            ranges.push(hide.range(node.from, node.to));
            break;
          default:
            break;
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

/**
 * 인라인/라인 단위 데코레이션(굵게·헤딩·코드펜스·체크박스·인라인 이미지·링크) ViewPlugin.
 *
 * 클릭은 여기서 받는다. 이 확장은 플러그인 에디터 확장(`editor.ts`의 `pluginC`)보다 **앞서**
 * 등록되므로 mousedown도 먼저 본다 — 내 링크가 아니면 반드시 `preventDefault` 없이 false를
 * 돌려줘야 위키링크 같은 플러그인 패턴의 클릭이 계속 살아 있다.
 */
function inlinePreviewPlugin(options: LivePreviewOptions) {
  const { resolveImageSrc, openExternalUrl } = options;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolveImageSrc);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = buildDecorations(update.view, resolveImageSrc);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown: (event) => {
          if (!openExternalUrl) return false;
          const el = event.target as HTMLElement;
          const url = el.closest<HTMLElement>(".cm-md-link")?.dataset.mdLinkUrl;
          if (!url) return false;
          // 동기 throw와 비동기 실패(Promise reject) 둘 다 최소한 콘솔에는 남긴다 — 주입된
          // 구현이 내부에서 이미 오류를 삼키고 있어도(main.ts의 관례) 클릭이 "왜 안 열리는지"
          // 추적할 단서 하나는 남아야 한다.
          try {
            void Promise.resolve(openExternalUrl(url)).catch((err) => {
              console.error("[memo] 링크 열기 실패:", url, err);
            });
          } catch (err) {
            console.error("[memo] 링크 열기 실패:", url, err);
          }
          event.preventDefault();
          return true;
        },
      },
    },
  );
}

/** GFM 표 마크다운의 파싱 결과(헤더·열 정렬·본문 행). */
interface ParsedTable {
  headers: string[];
  align: ("left" | "center" | "right" | null)[];
  rows: string[][];
}

/** GFM 표 마크다운을 헤더·정렬·행으로 파싱한다(순수, 테스트용). */
export function parseTable(source: string): ParsedTable {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cells = (line: string): string[] => {
    let s = line;
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };
  const headers = lines.length > 0 ? cells(lines[0]) : [];
  const align =
    lines.length > 1
      ? cells(lines[1]).map((spec) => {
          const left = spec.startsWith(":");
          const right = spec.endsWith(":");
          if (left && right) return "center" as const;
          if (right) return "right" as const;
          if (left) return "left" as const;
          return null;
        })
      : [];
  const rows = lines.slice(2).map(cells);
  return { headers, align, rows };
}

/** 표 소스를 렌더된 HTML `<table>`로 보여주는 블록 위젯. */
class TableWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const { headers, align, rows } = parseTable(this.source);
    const table = document.createElement("table");
    table.className = "cm-md-table";

    const head = document.createElement("tr");
    headers.forEach((text, i) => {
      const th = document.createElement("th");
      th.textContent = text;
      if (align[i]) th.style.textAlign = align[i] as string;
      head.append(th);
    });
    const thead = document.createElement("thead");
    thead.append(head);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      row.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (align[i]) td.style.textAlign = align[i] as string;
        tr.append(td);
      });
      tbody.append(tr);
    }

    table.append(thead, tbody);
    return table;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** 표·단독 이미지를 블록 단위로 렌더한다(커서가 블록 밖이면 위젯, 안이면 원문). */
function buildBlockDecorations(
  state: EditorState,
  resolveImageSrc?: ResolveImageSrc,
): DecorationSet {
  const head = state.selection.main.head;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      // 끝 경계는 배타(`< to`): 문서 끝이 블록인 노트도 기본 커서(문서 끝)에서 렌더되도록.
      const inside = head >= node.from && head < node.to;
      if (node.name === "Table") {
        if (!inside) {
          ranges.push(
            Decoration.replace({
              widget: new TableWidget(state.sliceDoc(node.from, node.to)),
              block: true,
            }).range(node.from, node.to),
          );
        }
        return false; // 표 내부 노드는 더 내려가지 않는다.
      }
      // 단독 이미지 문단(`![](path)`만 있는 줄)은 블록 위젯으로. 인라인 이미지는 ViewPlugin이 맡는다.
      if (
        node.name === "Image" &&
        resolveImageSrc &&
        isStandaloneImage(node.from, node.to, node.node.parent)
      ) {
        if (!inside) {
          ranges.push(
            Decoration.replace({
              widget: new ImageWidget(
                state.sliceDoc(node.from, node.to),
                resolveImageSrc,
                true,
              ),
              block: true,
            }).range(node.from, node.to),
          );
        }
        return false;
      }
      return undefined;
    },
  });
  return Decoration.set(ranges, true);
}

/**
 * 블록 데코레이션(표·단독 이미지)을 제공하는 StateField 팩토리.
 *
 * 왜: 여러 줄을 한 위젯으로 치환하는 블록 데코레이션은 ViewPlugin이 아니라 StateField로만
 * 가능하다. 인라인은 ViewPlugin이 맡고, 블록(표·단독 이미지)은 이 필드가 맡는다.
 */
function blockPreviewField(resolveImageSrc?: ResolveImageSrc) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildBlockDecorations(state, resolveImageSrc);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection)
        return buildBlockDecorations(tr.state, resolveImageSrc);
      return deco.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** 하이브리드 라이브 프리뷰: 인라인(ViewPlugin) + 블록 표·이미지(StateField). */
export function livePreview(options: LivePreviewOptions = {}) {
  return [
    inlinePreviewPlugin(options),
    blockPreviewField(options.resolveImageSrc),
  ];
}
