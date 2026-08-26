/**
 * 블록 임베드 프리미티브 — ```펜스``` 소스를 격리 iframe 위젯으로 렌더한다(§6).
 *
 * 역할: 플러그인이 등록한 블록 임베드 디스크립터(순수 데이터 — 펜스 이름, 소스 URL 인식
 * 규칙, 임베드 URL 템플릿)를 검증하고, 소스 URL → 최종 임베드 URL 변환과 도메인 게이트를
 * 호스트가 수행한 뒤, StateField 블록 위젯(표 렌더와 같은 메커니즘)으로 표시한다.
 * 본문 .md에는 소스 텍스트만 저장되고 위젯은 표시 전용이다.
 * 왜: 플러그인이 raw 코드/정규식 대신 선언만 하게 해 보안을 실질화하고, 최종 URL의
 * https·도메인 검증을 플러그인이 아니라 호스트 한 지점에서 강제하기 위함.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { t } from "../i18n/t";

/** 소스 URL에서 콘텐츠 id를 뽑는 선언 규칙 — 호스트 정확 일치 + 한 가지 추출 위치. */
export interface EmbedSourceRule {
  /** 소스 URL의 호스트(정확 일치, 소문자). */
  host: string;
  /** id가 담긴 쿼리 파라미터 이름(예: watch?v=→ "v"). pathPrefix와 택일. */
  queryParam?: string;
  /** id가 뒤따르는 경로 접두사(예: "/shorts/"). queryParam과 택일. */
  pathPrefix?: string;
}

/**
 * 블록 임베드 디스크립터 — 플러그인이 구조화 데이터로만 선언한다(코드 전달 금지).
 *
 * ```<fence> 펜스 블록의 내용(URL)을 소스로 삼아, sources 규칙으로 id를 뽑고
 * embedTemplate의 `{id}` 자리에 넣어 임베드 URL을 만든다. 변환·검증은 호스트가 한다.
 */
export interface BlockEmbedDescriptor {
  id: string;
  /** 반응할 코드펜스 정보 문자열(예: "youtube" → ```youtube). */
  fence: string;
  /** 소스 URL 인식 규칙 목록(첫 매치 승). */
  sources: EmbedSourceRule[];
  /** 임베드 URL 템플릿 — `{id}`가 추출한 id(URL 인코딩)로 치환된다. https 필수. */
  embedTemplate: string;
}

/**
 * 디스크립터 id·펜스 허용 형식(소문자·숫자·`._-`; 첫 글자는 영숫자).
 *
 * export하는 이유: 이 형식은 **저작 계약**이다(위반하면 등록 전체가 거부된다). 계약 인덱스
 * (`api-index.ts`)가 이 정규식에서 문구를 파생시켜 `api-reference.json`·`.d.ts`·저작 문서에
 * 싣는다 — 손으로 베끼면 드리프트한다.
 */
export const EMBED_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 호스트명 허용 형식(소문자 도메인 — 스킴/경로/포트 금지). */
const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/;

/** 소스 규칙 최대 개수(방어적 상한 — 계약 인덱스가 이 값을 문서에 싣는다). */
export const MAX_SOURCE_RULES = 32;

/** 펜스 내용(소스 URL) 최대 길이(방어적 상한). */
const MAX_SOURCE_LEN = 2048;

/**
 * [`parseBlockEmbedDescriptor`]의 결과 — 실패는 **어느 필드가 왜**인지를 담는다.
 *
 * 왜 null이 아닌가: 예전에는 어떤 위반이든 `null` 하나였고, 호출부는 그것을 필드 구분 없이
 * `INVALID_ARGS: 잘못된 블록 임베드 디스크립터`로 감쌌다. 저작자에게 남는 단서가 0이라
 * (진단 채널에도 그 문구만 남는다) `fence: "YouTube"`처럼 대문자 하나 때문에 임베드가 통째로
 * 안 뜨는 원인을 끝내 못 찾는다. 실패 필드를 오류 문구에 실으면 진단만으로 원인이 잡힌다.
 */
type BlockEmbedParseResult =
  | { ok: true; descriptor: BlockEmbedDescriptor }
  | { ok: false; field: string; reason: string };

/** 이름 형식 위반 사유 문구(정규식 하나에서 파생 — 규칙과 문구가 어긋날 수 없다). */
const NAME_REASON = `소문자·숫자로 시작하는 ${EMBED_NAME_RE.source} 형식이어야 한다(대문자·공백 불가)`;

/**
 * 신뢰할 수 없는 등록 인자를 검증해 BlockEmbedDescriptor로 만든다.
 *
 * 역할: 브리지로 들어온 플러그인 인자를 구조적으로 검증한다 — id/fence 형식, 규칙마다
 * host 형식 + queryParam/pathPrefix 정확히 하나, 템플릿은 `{id}` 포함 + https URL.
 * 왜: 등록 시점에 형식 오류·http 템플릿을 걸러 렌더 경로의 게이트(도메인 검증)와
 * 이중으로 방어한다(매니페스트 검증과 같은 태도).
 */
export function parseBlockEmbedDescriptor(
  args: Record<string, unknown>,
): BlockEmbedParseResult {
  const fail = (field: string, reason: string): BlockEmbedParseResult => ({
    ok: false,
    field,
    reason,
  });
  const id = args.id;
  const fence = args.fence;
  const template = args.embedTemplate;
  if (typeof id !== "string" || !EMBED_NAME_RE.test(id)) {
    return fail("id", NAME_REASON);
  }
  // fence도 id와 **같은** 형식이다 — 저작 문서가 오래도록 fence를 용의선상에서 빼 놓아
  // (「먼저 id를 확인하라」) 대문자 펜스 태그의 원인을 아무도 못 찾던 자리다.
  if (typeof fence !== "string" || !EMBED_NAME_RE.test(fence)) {
    return fail("fence", NAME_REASON);
  }
  if (typeof template !== "string" || !template.includes("{id}")) {
    return fail("embedTemplate", "`{id}`를 포함해야 한다");
  }
  // 템플릿 자체가 https URL이어야 한다(프로브 id로 치환해 정적 검사).
  const probe = substituteEmbedId(template, "probe");
  let probeUrl: URL;
  try {
    probeUrl = new URL(probe);
  } catch {
    return fail("embedTemplate", "치환 결과가 URL로 파싱돼야 한다");
  }
  if (probeUrl.protocol !== "https:") {
    return fail("embedTemplate", "https URL이어야 한다");
  }

  const rawSources = args.sources;
  if (
    !Array.isArray(rawSources) ||
    rawSources.length === 0 ||
    rawSources.length > MAX_SOURCE_RULES
  ) {
    return fail(
      "sources",
      `1개 이상 ${MAX_SOURCE_RULES}개 이하의 배열이어야 한다(빈 배열 불가)`,
    );
  }
  const sources: EmbedSourceRule[] = [];
  for (const [i, raw] of rawSources.entries()) {
    const at = `sources[${i}]`;
    if (typeof raw !== "object" || raw === null) {
      return fail(at, "객체여야 한다");
    }
    const rule = raw as Record<string, unknown>;
    const host = rule.host;
    if (typeof host !== "string" || !HOST_RE.test(host)) {
      return fail(
        `${at}.host`,
        "소문자 도메인이어야 한다(스킴·경로·포트 불가)",
      );
    }
    const hasQuery = typeof rule.queryParam === "string";
    const hasPath = typeof rule.pathPrefix === "string";
    // 추출 위치는 정확히 하나여야 한다(둘 다/둘 다 아님 → 거부).
    if (hasQuery === hasPath) {
      return fail(at, "queryParam과 pathPrefix 중 정확히 하나만 주어야 한다");
    }
    if (hasQuery) {
      if ((rule.queryParam as string).length === 0) {
        return fail(`${at}.queryParam`, "빈 문자열일 수 없다");
      }
      sources.push({ host, queryParam: rule.queryParam as string });
    } else {
      if (!(rule.pathPrefix as string).startsWith("/")) {
        return fail(`${at}.pathPrefix`, "`/`로 시작해야 한다");
      }
      sources.push({ host, pathPrefix: rule.pathPrefix as string });
    }
  }
  return {
    ok: true,
    descriptor: { id, fence, sources, embedTemplate: template },
  };
}

/**
 * 소스 URL 텍스트에서 규칙(첫 매치 승)으로 콘텐츠 id를 뽑는다(순수, 테스트용).
 *
 * 소스는 https URL이어야 하고 호스트는 규칙과 정확히 일치해야 한다(서브도메인 불일치
 * 거부). queryParam 규칙은 해당 파라미터 값을, pathPrefix 규칙은 접두사 다음 경로
 * 세그먼트를 id로 삼는다. 어떤 규칙에도 안 맞으면 null.
 */
export function extractEmbedId(
  rules: EmbedSourceRule[],
  sourceText: string,
): string | null {
  const trimmed = sourceText.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_LEN) return null;
  // 내부 공백/줄바꿈이 있으면 거부: URL 파서가 개행·탭을 조용히 제거해 여러 줄이
  // 하나로 이어붙는 오동작을 막는다(펜스 내용은 URL 한 줄이어야 한다).
  if (/\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  for (const rule of rules) {
    if (url.hostname !== rule.host) continue;
    if (rule.queryParam !== undefined) {
      const value = url.searchParams.get(rule.queryParam);
      if (value) return value;
    } else if (rule.pathPrefix !== undefined) {
      if (!url.pathname.startsWith(rule.pathPrefix)) continue;
      const rest = url.pathname.slice(rule.pathPrefix.length);
      const id = rest.split("/")[0];
      if (id) return id;
    }
  }
  return null;
}

/** 템플릿의 모든 `{id}`를 URL 인코딩한 id로 치환한다(경로 탈출·쿼리 주입 차단). */
function substituteEmbedId(template: string, id: string): string {
  return template.split("{id}").join(encodeURIComponent(id));
}

/**
 * 소스 텍스트 → 최종 임베드 URL을 만들고 게이트를 통과시킨다(순수, 테스트용).
 *
 * 역할: id 추출 → 템플릿 치환(URL 인코딩) → 최종 URL 파싱 후 **호스트가 강제하는
 * 게이트**: https만 허용 + 최종 hostname이 `allowDomain`(그 플러그인의 granted
 * `embed:<domain>`)을 통과해야 한다. 실패하면 null(→ 위젯 없이 원문 유지).
 * 왜: 템플릿·id가 어떤 값이든(서브도메인 위장, userinfo `@` 트릭, `../` 탈출) 최종
 * 파싱된 hostname 기준으로만 허용하므로 우회가 불가능하다.
 */
export function buildEmbedUrl(
  descriptor: BlockEmbedDescriptor,
  sourceText: string,
  allowDomain: (domain: string) => boolean,
): string | null {
  const id = extractEmbedId(descriptor.sources, sourceText);
  if (id === null) return null;
  let url: URL;
  try {
    url = new URL(substituteEmbedId(descriptor.embedTemplate, id));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!allowDomain(url.hostname)) return null;
  return url.href;
}

/** 위젯 DOM → 관찰 중인 IntersectionObserver(위젯 파괴 시 해제용). */
const observers = new WeakMap<HTMLElement, IntersectionObserver>();

/**
 * 게이트를 통과한 임베드 URL을 격리 iframe으로 보여주는 블록 위젯.
 *
 * 격리: 외부 플레이어는 cross-origin 문서라 앱 DOM에 닿을 수 없고, 추가로 엄격한
 * `sandbox="allow-scripts allow-same-origin"`(팝업·최상위 내비게이션·다운로드·폼 금지)과
 * `referrerpolicy="strict-origin-when-cross-origin"`(전체 URL이 아니라 origin만 전달)을
 * 강제한다. 중첩 srcdoc 래퍼를 쓰지 않는 이유:
 * 디스크립터 모델이라 위젯 안에서 실행할 플러그인 코드가 없고, sandbox 플래그는 중첩
 * 컨텍스트에 동일하게 전파되므로 직접 iframe이 같은 격리를 더 단순하게 준다.
 * 메모리: 뷰포트에 들어올 때만 src를 세팅한다(IntersectionObserver lazy).
 */
class EmbedWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly embedId: string,
  ) {
    super();
  }

  /** 같은 URL·플러그인 id면 같은 위젯 — 커서 이동만으로 iframe이 리로드되지 않게. */
  eq(other: EmbedWidget): boolean {
    return other.url === this.url && other.embedId === this.embedId;
  }

  /** 16:9 위젯의 대략 높이 — 스크롤 위치 추정 안정화용. */
  get estimatedHeight(): number {
    return 180;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-block";
    // 뷰포트에 실제로 보일 때만 외부 iframe을 로드한다(iframe당 메모리 절약).
    if (typeof IntersectionObserver === "undefined") {
      this.mountFrame(wrap); // 관찰 불가 환경(jsdom 등) 방어: 즉시 로드.
      return wrap;
    }
    const placeholder = document.createElement("div");
    placeholder.className = "cm-embed-placeholder";
    placeholder.textContent = t("plugin.embed.placeholder");
    wrap.append(placeholder);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.mountFrame(wrap);
        observer.disconnect();
        observers.delete(wrap);
      }
    });
    observer.observe(wrap);
    observers.set(wrap, observer);
    return wrap;
  }

  /** 엄격한 sandbox/allow/referrer 속성의 외부 iframe을 만들어 위젯에 채운다. */
  private mountFrame(wrap: HTMLElement): void {
    const frame = document.createElement("iframe");
    frame.className = "cm-embed-frame";
    // cross-origin 콘텐츠라 allow-same-origin이 있어도 앱 DOM에는 닿지 못한다 —
    // 플레이어가 자기 origin(스토리지·API)을 쓰기 위한 최소 허용이다.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute(
      "allow",
      "autoplay; encrypted-media; fullscreen; picture-in-picture",
    );
    // origin만 전달(전체 URL·경로는 차단): YouTube Required Minimum Functionality가
    // 임베드 플레이어에 Referer(또는 동등한 클라이언트 식별)를 요구한다 — no-referrer는
    // 식별을 적극 차단해 Error 153("Video unavailable")을 유발했다. 노트 id 등 페이지
    // 정보는 origin에 포함되지 않아 프라이버시 손실 없이 식별 요구만 충족한다.
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute(
      "title",
      t("plugin.embed.frame-title", { embedId: this.embedId }),
    );
    frame.src = this.url;
    wrap.replaceChildren(frame);
  }

  /** 위젯 DOM이 버려질 때 관찰을 해제한다(옵저버 누수 방지). */
  destroy(dom: HTMLElement): void {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }

  /** 위젯 내 상호작용(플레이어 클릭 등)이 에디터 커서를 건드리지 않게 한다. */
  ignoreEvent(): boolean {
    return true;
  }
}

/** syntaxTree 순회 노드가 자식을 내주는 최소 구조(@lezer/common 직접 의존 회피). */
interface FenceNodeRef {
  node: { getChild(type: string): { from: number; to: number } | null };
}

/** 펜스 노드에서 정보 문자열(```뒤 언어명)과 내용(소스 텍스트)을 읽는다. */
function readFence(
  state: EditorState,
  node: FenceNodeRef,
): { info: string; source: string } | null {
  const infoNode = node.node.getChild("CodeInfo");
  const textNode = node.node.getChild("CodeText");
  if (!infoNode || !textNode) return null;
  return {
    info: state.sliceDoc(infoNode.from, infoNode.to).trim(),
    source: state.sliceDoc(textNode.from, textNode.to),
  };
}

/** 등록된 임베드 펜스 블록을 위젯 데코레이션으로 만든다(커서 안이면 원문 유지). */
function buildEmbedDecorations(
  state: EditorState,
  embeds: BlockEmbedDescriptor[],
  allowDomain: (domain: string) => boolean,
): DecorationSet {
  const head = state.selection.main.head;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      // 끝 경계는 배타(`< to`): 문서 끝이 임베드인 노트도 기본 커서(문서 끝)에서 렌더되게
      // — 표 블록 위젯(blockPreviewField)과 같은 커서 규칙.
      const inside = head >= node.from && head < node.to;
      if (!inside) {
        const fence = readFence(state, node);
        const descriptor = fence
          ? embeds.find((e) => e.fence === fence.info)
          : undefined;
        if (descriptor && fence) {
          const url = buildEmbedUrl(descriptor, fence.source, allowDomain);
          // 게이트 실패(형식·미승인 도메인)는 조용한 실패: 위젯 없이 원문 코드펜스 유지.
          if (url !== null) {
            ranges.push(
              Decoration.replace({
                widget: new EmbedWidget(url, descriptor.id),
                block: true,
              }).range(node.from, node.to),
            );
          }
        }
      }
      return false; // 펜스 내부 노드는 더 내려가지 않는다.
    },
  });
  return Decoration.set(ranges, true);
}

/**
 * 블록 임베드 StateField를 만든다 — 커서가 펜스 밖이면 임베드 위젯, 안이면 원문.
 *
 * 왜 별도 필드인가: 표·단독 이미지의 blockPreviewField는 플러그인을 모르는 내장 렌더이고,
 * 플러그인 확장은 비동기 로드 후 별도 Compartment로 주입된다. 서로 다른 노드 타입
 * (FencedCode vs Table/Image)만 다루므로 범위가 겹치지 않아 병렬 필드로 안전하다.
 */
export function blockEmbedField(
  embeds: BlockEmbedDescriptor[],
  allowDomain: (domain: string) => boolean,
): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildEmbedDecorations(state, embeds, allowDomain);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection) {
        return buildEmbedDecorations(tr.state, embeds, allowDomain);
      }
      return deco.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
