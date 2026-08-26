/**
 * 컨텍스트 메뉴 삽입 액션(이미지·유튜브·링크)의 순수 변환 함수 — URL → 커서에 넣을 마크다운.
 *
 * 역할: `note-window.ts`의 `runMenuAction`이 입력 다이얼로그에서 받은 URL을 이 함수들로
 * 마크다운 텍스트로 바꾼 뒤 `insertText(text, "cursor")`에 넘긴다. DOM·에디터·i18n 의존이
 * 없어 유닛 테스트로 입력→출력만 고정할 수 있다(이슈 #19).
 */
import { serializeImageAltSize } from "./image-size";

/**
 * 링크 텍스트(라벨)에서 마크다운이 구조 문자로 해석하는 `[`·`]`·`\`를 백슬래시로 이스케이프한다.
 *
 * 왜 `]`뿐 아니라 `[`도 이스케이프해야 하는지: CommonMark는 링크 텍스트를 대괄호 균형으로
 * 닫는다 — `[TODO`(라벨 안의 이스케이프 안 된 `[`)가 있으면 파서가 그 지점에서 별도 링크
 * 시작으로 오인해 링크 구조 전체가 깨진다(실제 @lezer/markdown으로 확인: `[a[b](url)`는
 * `structOk=false`). `]`는 더 명백히 링크 텍스트를 조기 종료시킨다. 백슬래시 자체도 먼저
 * 이스케이프해야 `\[`·`\]`가 우리가 의도한 이스케이프로만 해석된다.
 */
export function escapeLinkLabel(text: string): string {
  return text.replace(/[\\[\]]/g, (ch) => `\\${ch}`);
}

/** [`escapeLinkLabel`]의 역연산 — 기존 링크를 다시 편집할 때 라벨을 원문으로 되돌린다. */
export function unescapeLinkLabel(text: string): string {
  return text.replace(/\\([\\[\]])/g, "$1");
}

/** 괄호가 열렸다 안 닫히거나(또는 반대로) 끝까지 안 닫힌 채 남는지 — 얕은 스캔(중첩 무시). */
function hasUnbalancedParens(url: string): boolean {
  let depth = 0;
  for (const ch of url) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

/** C0/DEL 제어문자 하나인지 — 정규식에 제어문자 리터럴을 박지 않으려고 코드포인트로 본다. */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** 마크다운 "꺾쇠 없는" 링크 목적지 형식이 거부하는 문자(공백·제어문자·꺾쇠·백슬래시)인지. */
function hasUnsafeBareUrlChars(url: string): boolean {
  if (/[\s<>\\]/.test(url)) return true;
  return [...url].some(isControlChar);
}

/**
 * 마크다운 링크 목적지(URL)를 안전한 형태로 만든다.
 *
 * CommonMark의 "꺾쇠 없는" 목적지 형식은 괄호를 균형 잡힌 쌍으로만 허용한다 — 짝이 안 맞는
 * `)`가 하나라도 있으면(예: `.../Foo)bar`) 그 지점에서 목적지가 조기 종료돼 뒤 문자열이
 * 문서에 그대로 새어나온다. 이런 경우에만 CommonMark 꺾쇠 목적지 형식(`<...>`)으로 감싼다 —
 * 이 형식은 괄호 균형과 무관하게 항상 유효하고, 내부에 이스케이프 안 된 `<`·`>`·개행만 없으면
 * 된다(공백은 허용). 괄호가 균형 잡혀 있으면(가장 흔한 경우, 예: 위키백과 URL) 굳이 감싸지
 * 않고 원문 그대로 둔다 — @lezer/markdown으로 직접 확인: 두 경우 모두 문서 구조를 깨지 않고
 * URL 전체가 하나의 URL 노드로 파싱된다.
 */
export function escapeMarkdownUrl(url: string): string {
  if (!hasUnsafeBareUrlChars(url) && !hasUnbalancedParens(url)) return url;
  const escaped = url.replace(/[\\<>]/g, (ch) => `\\${ch}`);
  return `<${escaped}>`;
}

/**
 * 이미지 삽입 마크다운(`![](url)`) — alt 텍스트는 비워 사용자가 나중에 채우게 한다.
 *
 * `width`/`height`(px)를 주면 크기 조정 레이어와 같은 alt 토큰 문법(`w=…&h=…`,
 * [`serializeImageAltSize`] 참고)으로 alt에 실어 넣는다 — 하나만 주면 나머지는 auto.
 * 기존 호출부(width/height 없이 URL만 넘기는)는 alt가 계속 빈 문자열이라 출력이 그대로다.
 */
export function imageInsertMarkdown(
  url: string,
  width: number | null = null,
  height: number | null = null,
): string {
  const alt = serializeImageAltSize("", width, height);
  return `![${alt}](${escapeMarkdownUrl(url)})`;
}

/**
 * 유튜브 블록 임베드 마크다운 — 빌트인 `youtube-embed` 플러그인이 인식하는 코드펜스
 * (```youtube\n<url>\n``` — `src/plugin/builtin/plugins/youtube-embed/main.js`가 등록하는
 * `fence: "youtube"`). 펜스 본문은 URL 한 줄이어야 하므로(`src/plugin/embed.ts`의
 * `extractEmbedId`가 내부 공백/개행이 있으면 거부한다) trim해 넣는다.
 */
export function youtubeInsertMarkdown(url: string): string {
  return "```youtube\n" + url.trim() + "\n```";
}

/**
 * 링크 삽입 마크다운(`[텍스트](url)`) — 우클릭 시점에 선택된 텍스트가 있으면 그것을 링크
 * 텍스트로 쓰고, 없으면(또는 공백뿐이면) URL 자체를 텍스트로 쓴다.
 *
 * 라벨은 [`escapeLinkLabel`], URL은 [`escapeMarkdownUrl`]로 각각 이스케이프한다 — 선택
 * 텍스트에 `]`/`[`가 섞이거나(예: "[TODO] item") URL에 짝 안 맞는 `)`가 섞여도(예:
 * 위키백과류 URL 뒤에 다른 문자가 더 붙은 경우) 링크 구조나 목적지가 조기 종료돼 문서가
 * 깨지지 않는다.
 */
export function linkInsertMarkdown(url: string, selectedText: string): string {
  const text = selectedText.trim() || url;
  return `[${escapeLinkLabel(text)}](${escapeMarkdownUrl(url)})`;
}

/**
 * http/https URL인지 최소 검증한다(trim 후 판단, 빈 문자열은 거부). 입력 다이얼로그의 기본
 * 검증 규칙 — 상대경로·`javascript:`·`data:` 등 다른 스킴은 전부 거부한다.
 */
export function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
