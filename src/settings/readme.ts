/**
 * 플러그인 README 마크다운 렌더러 — 화이트리스트 노드만 DOM으로 직접 생성(XSS 원천 차단).
 *
 * 역할: `@lezer/markdown`(+ GFM 확장)으로 파싱한 트리를 걷어 제목·문단·굵게/기울임·취소선·
 * 인라인코드·코드펜스·목록·작업목록·표·인용·수평선·링크·이미지(칩)만 요소로 만들고, 그 외
 * 노드는 **원문 텍스트로 강등**한다. innerHTML은 쓰지 않으며 텍스트는 전부 textContent/텍스트
 * 노드로만 넣는다. 링크는 https만 앵커가 되고(그 외 스킴은 텍스트로 강등), 클릭 시 웹뷰
 * 탐색을 막고 openLink 콜백(외부 브라우저)으로 위임한다. 이미지는 <img>를 만들지 않고
 * alt 텍스트 칩으로 대체한다(수동 fetch·레이아웃 DoS 차단).
 * 왜: 설치형 README는 신뢰할 수 없는 입력이다 — 파서는 검증된 것을 재사용하되 렌더 표면을
 * 화이트리스트로 못박아 스크립트/속성 주입 여지를 없앤다(D4). 트리는 여전히 createElement/
 * textContent로만 걷으므로, GFM 노드가 늘어도 "요소가 되는 종류"만 늘 뿐 XSS 계약은 그대로다.
 */
import {
  parser as baseParser,
  Strikethrough,
  Table,
  TaskList,
} from "@lezer/markdown";
import { t } from "../i18n/t";

// 표·작업목록·취소선 GFM 확장만 켠다(자동링크는 의도적으로 제외 — "https 명시 링크만 앵커"라는
// 기존 보안 가드를 유지하기 위해 맨 URL을 앵커화하지 않는다). 트리는 여전히 createElement/
// textContent로만 걷으므로, 노드 종류가 늘어도 XSS 계약은 그대로다.
const parser = baseParser.configure([Table, TaskList, Strikethrough]);

/** 마크다운 구문 노드의 최소 구조(lezer `SyntaxNode`와 구조적 호환 — 직접 의존 없이 사용). */
interface MdNode {
  name: string;
  from: number;
  to: number;
  firstChild: MdNode | null;
  nextSibling: MdNode | null;
  getChild(type: string): MdNode | null;
}

/** 제목 노드 → 태그 매핑(ATX `#`·Setext 밑줄 모두 지원). */
const HEADING_TAGS: Record<string, string> = {
  ATXHeading1: "h1",
  ATXHeading2: "h2",
  ATXHeading3: "h3",
  ATXHeading4: "h4",
  ATXHeading5: "h5",
  ATXHeading6: "h6",
  SetextHeading1: "h1",
  SetextHeading2: "h2",
};

/** 내용에 포함하지 않는 문법 마커 노드(구분 기호 — 텍스트로 흘리지 않는다). */
const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "ListMark",
  "URL", // Link/Image의 목적지(getChild로 이미 소비 — 라벨로 흘리지 않음). 자동링크는 미지원.
  "LinkTitle",
  "CodeInfo",
  "TaskMarker", // 작업목록 `[ ]`/`[x]` 리터럴(체크박스로 대체하므로 텍스트로 흘리지 않음)
  "StrikethroughMark", // 취소선 `~~` 구분자
  "QuoteMark", // 인용 `>` 마커
  "TableDelimiter", // 표의 `|` 파이프·정렬 구분줄(심층 방어)
]);

/** 링크가 앵커로 허용되는지 — https만(javascript:/http:/상대경로 등은 텍스트로 강등). */
function isAllowedLink(url: string): boolean {
  return url.startsWith("https://") && url.length > "https://".length;
}

/**
 * 이미지 src가 **플러그인 로컬 파일** 경로인지 — 스킴(http:/data: 등)·프로토콜상대(`//`)·절대경로
 * (`/`)·상위 이동(`..`)을 모두 거부한다(플러그인 폴더 밖으로 새지 않게). 로컬 상대경로만 허용.
 * 왜: 외부 이미지는 렌더하지 않고(추적·CSP 차단) 플러그인 자기 폴더의 파일만 실제로 보여준다.
 */
function isLocalImagePath(src: string): boolean {
  if (!src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false; // http:/https:/data:/javascript: 등 스킴
  if (src.startsWith("//")) return false; // 프로토콜 상대(//host/…)
  if (src.startsWith("/")) return false; // 절대경로
  if (src.split(/[/\\]/).some((seg) => seg === "..")) return false; // 상위 디렉터리 이동
  return true;
}

/**
 * README 이미지 경로 → 로드 가능한 URL 해석기(현재 렌더의 플러그인에 바인딩). 렌더는 동기·단발이라
 * 모듈 스코프에 두고 진입점에서 설정/해제한다(openLink처럼 파라미터로 5+ 함수에 실어 나르지 않게).
 * 로컬 상대경로에 대해서만 호출된다(스킴/절대/상위 이동은 [`isLocalImagePath`]가 이미 거른다).
 */
let imageResolver: ((src: string) => string | null) | null = null;

/**
 * 컨테이너 노드의 인라인 내용을 parent에 렌더한다(자식 노드 사이의 맨 텍스트 포함).
 *
 * 역할: lezer 트리는 스타일 구간만 노드로 표시하므로, 자식 사이 간극을 텍스트 노드로
 * 채우며 걷는다. 마커 노드는 건너뛰고, 마커 직후의 선행 공백은 잘라낸다(`# 제목`의 공백 등).
 */
function renderInlineChildren(
  parent: HTMLElement,
  node: MdNode,
  src: string,
  openLink: (url: string) => void,
): void {
  let pos = node.from;
  let trimNextGap = false;
  const appendGap = (from: number, to: number): void => {
    if (to <= from) return;
    let text = src.slice(from, to);
    if (trimNextGap) {
      text = text.replace(/^[ \t]+/, "");
      trimNextGap = false;
    }
    if (text !== "") parent.append(text);
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    appendGap(pos, child.from);
    if (MARK_NODES.has(child.name)) {
      trimNextGap =
        child.name === "HeaderMark" ||
        child.name === "ListMark" ||
        child.name === "TaskMarker";
    } else {
      appendInline(parent, child, src, openLink);
      trimNextGap = false;
    }
    pos = child.to;
  }
  appendGap(pos, node.to);
}

/**
 * 인라인 노드 하나를 parent에 붙인다(화이트리스트 외는 원문 텍스트로 강등).
 */
function appendInline(
  parent: HTMLElement,
  node: MdNode,
  src: string,
  openLink: (url: string) => void,
): void {
  switch (node.name) {
    case "StrongEmphasis": {
      const el = document.createElement("strong");
      renderInlineChildren(el, node, src, openLink);
      parent.append(el);
      return;
    }
    case "Emphasis": {
      const el = document.createElement("em");
      renderInlineChildren(el, node, src, openLink);
      parent.append(el);
      return;
    }
    case "Strikethrough": {
      const el = document.createElement("del");
      renderInlineChildren(el, node, src, openLink);
      parent.append(el);
      return;
    }
    case "InlineCode": {
      const el = document.createElement("code");
      renderInlineChildren(el, node, src, openLink);
      parent.append(el);
      return;
    }
    case "Link": {
      const urlNode = node.getChild("URL");
      const url = urlNode ? src.slice(urlNode.from, urlNode.to) : "";
      if (!isAllowedLink(url)) {
        // 허용되지 않는 링크(javascript: 등)는 라벨 텍스트만 남긴다(탐색 수단 자체를 제거).
        renderInlineChildren(parent, node, src, openLink);
        return;
      }
      const a = document.createElement("a");
      a.className = "plugin-readme-link";
      a.href = url;
      a.addEventListener("click", (e) => {
        e.preventDefault(); // 웹뷰 내 탐색 금지 — 외부 브라우저로만 연다.
        openLink(url);
      });
      renderInlineChildren(a, node, src, openLink);
      parent.append(a);
      return;
    }
    case "Image": {
      const urlNode = node.getChild("URL");
      const url = urlNode ? src.slice(urlNode.from, urlNode.to) : "";
      // alt 텍스트(이미지 노드의 인라인 내용 — 마커·URL 제외)를 미리 뽑는다.
      const altSpan = document.createElement("span");
      renderInlineChildren(altSpan, node, src, openLink);
      const alt = altSpan.textContent ?? "";

      // 플러그인 로컬 파일이고 해석기가 URL을 주면 실제 <img>로 렌더(지연 로드, 실패 시 칩 폴백).
      // 외부 URL(http/https/data 등)은 로드하지 않는다 — CSP img-src도 asset/self만 허용한다.
      if (isLocalImagePath(url) && imageResolver) {
        const resolved = imageResolver(url);
        if (resolved) {
          const img = document.createElement("img");
          img.className = "plugin-readme-img-file";
          img.src = resolved;
          img.setAttribute("loading", "lazy"); // 지연 로드(속성으로 — 일부 환경은 IDL 미반영).
          img.alt = alt;
          img.addEventListener("error", () => {
            const fb = document.createElement("span");
            fb.className = "plugin-readme-img";
            fb.textContent =
              "🖼 " + (alt || t("settings.readme.image-fallback"));
            img.replaceWith(fb);
          });
          parent.append(img);
          return;
        }
      }

      // 그 외(외부·미해석 로컬)는 <img>를 만들지 않고 alt 칩으로 대체(추적 fetch·레이아웃 DoS 방지).
      // https면 사용자가 눌러 외부 브라우저로 열 수 있게 한다.
      const httpsOk = isAllowedLink(url);
      const chip = document.createElement(httpsOk ? "a" : "span");
      chip.className = "plugin-readme-img";
      chip.append("🖼 ");
      renderInlineChildren(chip, node, src, openLink); // alt 텍스트
      if (httpsOk) {
        (chip as HTMLAnchorElement).href = url;
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          openLink(url);
        });
      }
      parent.append(chip);
      return;
    }
    default:
      // 미지의 인라인(HTMLTag·Escape 등)은 원문 텍스트로 강등 — 요소가 되지 않는다.
      parent.append(src.slice(node.from, node.to));
  }
}

/** 코드펜스의 코드 본문(CodeText 자식들)을 이어 붙인다(펜스 마커·언어 표기는 제외). */
function fencedCodeText(node: MdNode, src: string): string {
  const parts: string[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(src.slice(child.from, child.to));
  }
  return parts.join("");
}

/**
 * 표의 열 정렬을 구분줄(`|---|:-:|--:|`)의 원문에서 파생한다(순수).
 *
 * 정렬은 노드 속성이 아니라 텍스트라, 구분줄을 파싱해 `left|center|right|""`로만 화이트리스트
 * 화한다(그 값만 `style.textAlign`에 대입 — 주입 여지 없음).
 */
function tableAlign(table: MdNode, src: string): string[] {
  let sep: MdNode | null = null;
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") {
      sep = c; // 첫 단독 구분자 = 정렬 구분줄
      break;
    }
  }
  if (!sep) return [];
  return src
    .slice(sep.from, sep.to)
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "") // 바깥 파이프 제거
    .split("|")
    .map((seg) => {
      const s = seg.trim();
      const l = s.startsWith(":");
      const r = s.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
}

/**
 * 블록 노드 하나를 parent에 붙인다(화이트리스트 외는 원문 텍스트 문단으로 강등).
 */
function appendBlock(
  parent: HTMLElement,
  node: MdNode,
  src: string,
  openLink: (url: string) => void,
): void {
  const headingTag = HEADING_TAGS[node.name];
  if (headingTag) {
    const el = document.createElement(headingTag);
    renderInlineChildren(el, node, src, openLink);
    parent.append(el);
    return;
  }
  switch (node.name) {
    case "Paragraph": {
      const el = document.createElement("p");
      renderInlineChildren(el, node, src, openLink);
      parent.append(el);
      return;
    }
    case "FencedCode":
    case "CodeBlock": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent =
        node.name === "FencedCode"
          ? fencedCodeText(node, src)
          : src.slice(node.from, node.to);
      pre.append(code);
      parent.append(pre);
      return;
    }
    case "Blockquote": {
      const el = document.createElement("blockquote");
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "QuoteMark") continue;
        appendBlock(el, child, src, openLink);
      }
      parent.append(el);
      return;
    }
    case "HorizontalRule": {
      parent.append(document.createElement("hr"));
      return;
    }
    case "BulletList":
    case "OrderedList": {
      const el = document.createElement(
        node.name === "BulletList" ? "ul" : "ol",
      );
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "ListItem") continue;
        const li = document.createElement("li");
        // 목록 항목의 자식은 블록(Paragraph·Task·중첩 목록)이다 — 마커는 건너뛴다.
        for (let inner = child.firstChild; inner; inner = inner.nextSibling) {
          if (inner.name === "ListMark") continue;
          appendBlock(li, inner, src, openLink);
        }
        el.append(li);
      }
      parent.append(el);
      return;
    }
    case "Task": {
      // 작업목록 항목 — 비활성 체크박스 + 라벨(읽기 전용, 상호작용/주입 표면 없음).
      const wrap = document.createElement("div");
      wrap.className = "plugin-readme-task";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = true;
      const marker = node.firstChild; // TaskMarker(`[ ]`/`[x]`)
      if (marker && marker.name === "TaskMarker") {
        box.checked = src
          .slice(marker.from, marker.to)
          .toLowerCase()
          .includes("x");
      }
      const label = document.createElement("span");
      renderInlineChildren(label, node, src, openLink); // TaskMarker는 MARK_NODES로 건너뜀
      wrap.append(box, label);
      parent.append(wrap);
      return;
    }
    case "Table": {
      const wrap = document.createElement("div");
      wrap.className = "plugin-readme-tablewrap"; // 가로 스크롤은 여기서 — 페이지가 밀리지 않게
      const table = document.createElement("table");
      const align = tableAlign(node, src);
      let tbody: HTMLElement | null = null;
      for (let row = node.firstChild; row; row = row.nextSibling) {
        const isHeader = row.name === "TableHeader";
        if (!isHeader && row.name !== "TableRow") continue; // 구분줄 TableDelimiter는 건너뜀
        const tr = document.createElement("tr");
        let col = 0;
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
          if (cell.name !== "TableCell") continue; // `|` TableDelimiter 건너뜀
          const td = document.createElement(isHeader ? "th" : "td");
          if (align[col]) td.style.textAlign = align[col]; // 화이트리스트 값만 대입
          renderInlineChildren(td, cell, src, openLink);
          tr.append(td);
          col++;
        }
        if (isHeader) {
          const thead = document.createElement("thead");
          thead.append(tr);
          table.append(thead);
        } else {
          if (!tbody) {
            tbody = document.createElement("tbody");
            table.append(tbody);
          }
          tbody.append(tr);
        }
      }
      wrap.append(table);
      parent.append(wrap);
      return;
    }
    default: {
      // 미지의 블록(HTMLBlock 등)은 원문 텍스트 문단으로 강등 — 마크업이 되지 않는다.
      const el = document.createElement("p");
      el.textContent = src.slice(node.from, node.to);
      parent.append(el);
    }
  }
}

/**
 * README 마크다운을 host에 렌더한다(null/공백이면 "설명 없음").
 *
 * 역할: 상세 뷰의 설명 섹션 단일 진입점 — 번들은 상수 문자열, 설치형은 IPC로 읽은 값을
 * 그대로 받아 화이트리스트 렌더한다. 링크 클릭은 openLink(외부 브라우저)로만 위임된다.
 * `resolveImage`가 주어지면 **플러그인 로컬 파일** 이미지만 실제 URL로 해석해 렌더한다(선택).
 */
export function renderReadmeInto(
  host: HTMLElement,
  markdown: string | null,
  openLink: (url: string) => void,
  resolveImage?: (src: string) => string | null,
): void {
  host.replaceChildren();
  host.classList.add("plugin-readme");
  if (markdown === null || markdown.trim() === "") {
    const empty = document.createElement("div");
    empty.className = "plugin-readme-empty";
    empty.textContent = t("settings.readme.empty");
    host.append(empty);
    return;
  }
  imageResolver = resolveImage ?? null;
  try {
    const root = parser.parse(markdown).topNode as unknown as MdNode;
    for (let child = root.firstChild; child; child = child.nextSibling) {
      appendBlock(host, child, markdown, openLink);
    }
  } finally {
    imageResolver = null; // 렌더가 끝나면 즉시 해제(다음 렌더에 새지 않게).
  }
}
