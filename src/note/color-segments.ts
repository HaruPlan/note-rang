/**
 * 한 줄의 글자 색(`{{글자|#hex}}`)을 **평탄한 세그먼트 목록**으로 다루는 순수 모델 —
 * 선택 툴바의 색 적용·해제(`selection-toolbar.ts`)가 쓰는 유일한 계산 파이프라인이다.
 *
 * 왜 세그먼트 모델인가: 색 감싸기는 **중첩될 수 없다**. 호스트는 `open`…`prefix`+색+`close`를
 * lazy 정규식으로 한 겹만 잡으므로(`plugin/editor-api.ts`의 `findPatternMatches`),
 * `{{앞{{뒤|#00f}}|#f00}}` 같은 중첩은 **안쪽 한 겹만** 색이 되고 바깥 구분자는 원문 그대로
 * 화면에 노출된다.
 * 그런데 "이미 색이 칠해진 구간과 부분만 겹치는 선택에 다른 색 주기"(빨간 줄 중간부터 다음
 * 줄까지 드래그해 파랑 누르기, 칠해진 줄의 가운데 일부만 다른 색으로 바꾸기)는 아주 흔한
 * 조작이다. 예전 계산은 "선택 하나 = 감싸기 하나"라는 단일 경로여서 그런 선택에서 중첩을
 * 만들어 냈다.
 *
 * 그래서 줄을 통째로 `[{글자, 색}]`의 평탄한 목록으로 파싱하고([`parseColorSegments`]),
 * 칠할 범위에 걸친 세그먼트를 **쪼개** 색을 갈아 끼운 뒤([`paintRange`]), 다시 원문으로
 * 직렬화한다([`serializeColorSegments`]). 이 파이프라인은 구조상 중첩·교차를 만들 수 없다 —
 * 중간 표현이 언제나 평탄한 나열이기 때문이다.
 *
 * 이 모듈의 핵심 난점은 **좌표계가 둘**이라는 것이다: 원문(문서)에는 구분자가 섞여 있고
 * 세그먼트 좌표(평문)에는 없다. 드래그가 준 것은 원문 오프셋이므로 칠하기 전에 평문
 * 오프셋으로 옮겨야 하고, 결과를 되쓸 때는 다시 원문 범위로 돌아와야 한다 —
 * [`computeLineColorEdit`]가 그 왕복을 한 곳에서 책임진다(호출부는 오프셋 변환을 몰라도 된다).
 *
 * 문법(`open`/`close`/`prefix`)은 하드코딩하지 않고 인자로 받는다 — 지금 에디터에 살아 있는
 * 인라인 패턴 등록에서 온 값이다(`colorPatternSyntax` facet). 구분자로 정규식을 조립하지
 * 않고 문자열 연산만 쓰는 것도 같은 이유다(이스케이프 실수 하나가 곧 오작동이다).
 *
 * 한 가지 예외적인 경계가 있다: 줄 머리의 **마크다운 구조 문법**(불릿·체크박스·헤딩·인용)은
 * 감싸기 안에 들어가면 안 된다 — 그 판정은 서식 감싸기와 **같은 함수**를 쓴다
 * ([`structuralPrefixLength`], `md-shortcuts.ts`).
 */
import {
  patternBodyResyncOffset,
  type ColorPatternSyntax,
} from "../plugin/editor-api";
import { structuralPrefixLength } from "./md-shortcuts";

/** 평탄 세그먼트 하나 — 글자와 그 글자에 칠해진 색(없으면 null = 평문). */
export interface ColorSegment {
  /** 구분자를 뺀 글자(사용자가 화면에서 보는 그대로). */
  text: string;
  /** 칠해진 색(`#rgb`/`#rrggbb` 원문 그대로), 없으면 null. */
  color: string | null;
}

/**
 * [`parseColorSpans`]가 돌려주는 세그먼트 — 세그먼트 값에 **원문 위치**를 붙인 내부 표현.
 * 평문↔원문 오프셋 변환과 "갈아 끼울 원문 범위" 계산이 이 위치들로 이루어진다.
 */
interface ColorSpan extends ColorSegment {
  /** 줄 안에서 이 세그먼트가 차지하는 원문 범위의 시작(색이 있으면 `open`부터). */
  from: number;
  /** 원문 범위의 끝(색이 있으면 `close` 뒤까지). */
  to: number;
  /** 글자(text)만의 원문 범위 시작 — 색이 없으면 `from`과 같다. */
  innerFrom: number;
  /** 글자(text)만의 원문 범위 끝 — 색이 없으면 `to`와 같다. */
  innerTo: number;
  /** 평문 좌표(구분자를 뺀 글자만 이어 붙인 좌표계)에서 이 세그먼트가 시작하는 위치. */
  plainFrom: number;
}

/** `text[start]`부터 `len`글자가 전부 hex 숫자인지(경계를 벗어나면 false). */
function isHexRun(text: string, start: number, len: number): boolean {
  if (start + len > text.length) return false;
  for (let i = start; i < start + len; i++) {
    const c = text[i];
    const hex =
      (c >= "0" && c <= "9") ||
      (c >= "a" && c <= "f") ||
      (c >= "A" && c <= "F");
    if (!hex) return false;
  }
  return true;
}

/** 호스트 `hex-color` 형식이 시도하는 자릿수와 그 순서(6자리를 먼저 본다 — inline-style.ts). */
const HEX_LENGTHS: readonly number[] = [6, 3];

/**
 * [`matchColorAt`]의 결과 — 감싸기 하나(범위와 색), 매치 없음(null), 또는 **되짚기 지시**.
 *
 * 되짚기(`resyncAt`)는 "여기서 시작하는 후보는 남의 구분자 짝을 가로질러 버렸으니, 이 자리부터
 * 다시 보라"는 뜻이다 — 호스트 매처가 같은 상황에서 앵커를 옮기는 그 자리와 같다.
 */
type ColorMatchAt =
  | { to: number; innerFrom: number; innerTo: number; color: string }
  | { resyncAt: number }
  | null;

/**
 * `line[index]`에서 색 감싸기 하나가 시작하는지 보고, 맞으면 그 범위를 돌려준다(순수).
 *
 * 호스트 매처(`findPatternMatches`가 만드는
 * `open(.+?)prefix(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))close`)와 **같은 판정**을 문자열 연산으로
 * 옮긴 것이다: 본문은 최소 1글자이고 lazy이므로 `prefix` 후보를 **왼쪽부터** 훑어 가장 먼저
 * 성립하는 자리가 이긴다. 색 자릿수도 호스트와 같은 순서(6→3)로 시도한다. 툴바가 호스트와
 * 다르게 파싱하면 "화면에는 색이 있는데 툴바는 없다고 본다"는 어긋남이 생긴다.
 *
 * 채택 조건과 **버릴 때의 되짚기**도 호스트와 같다: 그렇게 찾은 lazy 매치의 안쪽 전체가
 * 구분자 짝을 가로지르면([`patternBodyResyncOffset`]) 호스트가 그 후보를 버리고 그 함수가
 * 짚어 준 자리부터 다시 보므로, 여기서도 매치 대신 `resyncAt`을 돌려준다 — 그러지 않으면
 * `{{Cmd+C}} {{복사|#e33}}`의 키캡 `{{`가 색 감싸기 안으로 빨려 들어가고, 이어지는 색 해제가
 * 그 `{{`를 문서에서 **지워 버린다**(실제로 있었던 텍스트 손실이다).
 */
function matchColorAt(
  line: string,
  index: number,
  syntax: ColorPatternSyntax,
): ColorMatchAt {
  const { open, close, prefix } = syntax;
  if (open === "" || close === "" || prefix === "") return null;
  if (!line.startsWith(open, index)) return null;

  const innerFrom = index + open.length;
  for (let cut = innerFrom + 1; cut + prefix.length <= line.length; cut++) {
    // 본문(`.+?`)은 줄바꿈을 먹지 않는다 — 한 줄짜리 입력이 원칙이지만, 여러 줄이 들어와도
    // 줄을 넘는 감싸기를 만들지 않도록 여기서 끊는다(호스트 `.`과 같은 규칙).
    const last = line[cut - 1];
    if (last === "\n" || last === "\r") break;
    if (!line.startsWith(prefix, cut)) continue;
    const valueFrom = cut + prefix.length;
    if (line[valueFrom] !== "#") continue;
    for (const len of HEX_LENGTHS) {
      if (!isHexRun(line, valueFrom + 1, len)) continue;
      const closeFrom = valueFrom + 1 + len;
      if (!line.startsWith(close, closeFrom)) continue;
      // 호스트의 lazy 매치와 정확히 같은 자리다 — 안쪽이 남의 구분자 짝을 가로지르면 호스트도
      // 이 후보를 버린다(더 긴 본문을 다시 찾지 않는다). 판정 대상은 `open` 뒤부터 `close`
      // 앞까지 전체(꼬리 `prefix`+색 포함)로, 호스트가 보는 그 문자열과 같다.
      const resync = patternBodyResyncOffset(
        line.slice(innerFrom, closeFrom),
        open,
        close,
      );
      if (resync !== null) return { resyncAt: innerFrom + resync };
      return {
        to: closeFrom + close.length,
        innerFrom,
        innerTo: cut,
        color: line.slice(valueFrom, closeFrom),
      };
    }
  }
  return null;
}

/** 한 줄을 원문 위치가 붙은 평탄 세그먼트로 파싱한다(순수) — 줄 전체를 빈틈없이 덮는다. */
function parseColorSpans(
  line: string,
  syntax: ColorPatternSyntax,
): ColorSpan[] {
  const spans: ColorSpan[] = [];
  let plain = 0; // 다음 세그먼트가 시작할 평문 좌표.
  let cursor = 0; // 아직 세그먼트로 만들지 않은 평문 구간의 시작(원문 좌표).

  const pushPlain = (from: number, to: number): void => {
    if (to <= from) return;
    const text = line.slice(from, to);
    spans.push({
      text,
      color: null,
      from,
      to,
      innerFrom: from,
      innerTo: to,
      plainFrom: plain,
    });
    plain += text.length;
  };

  let i = 0;
  while (i < line.length) {
    const hit = matchColorAt(line, i, syntax);
    if (hit === null) {
      i++;
      continue;
    }
    // 후보가 남의 구분자 짝을 가로질러 버려졌다 — 호스트와 같은 자리부터 다시 본다(그 자리는
    // 언제나 `i`보다 뒤라 전진이 보장된다).
    if ("resyncAt" in hit) {
      i = hit.resyncAt;
      continue;
    }
    pushPlain(cursor, i);
    const text = line.slice(hit.innerFrom, hit.innerTo);
    spans.push({
      text,
      color: hit.color,
      from: i,
      to: hit.to,
      innerFrom: hit.innerFrom,
      innerTo: hit.innerTo,
      plainFrom: plain,
    });
    plain += text.length;
    i = hit.to;
    cursor = hit.to;
  }
  pushPlain(cursor, line.length);
  return spans;
}

/**
 * 그 줄에서 **화면에 보이는 글자**만 이어 붙인다(구분자·색 표기를 뺀 평문, 순수).
 *
 * 색을 칠하거나 벗기는 일은 이 값을 단 한 글자도 바꾸지 않는다 — [`computeLineColorEdit`]가
 * 자기 결과를 검산하는 기준이 그것이다.
 */
function plainTextOf(line: string, syntax: ColorPatternSyntax): string {
  return parseColorSpans(line, syntax)
    .map((span) => span.text)
    .join("");
}

/**
 * 한 줄을 평탄 세그먼트 목록으로 파싱한다(순수, 테스트용) — 색 감싸기로 인정되지 않는 본문
 * (자릿수가 틀린 hex, 짝이 안 맞는 구분자 등)은 전부 평문 세그먼트로 남는다(호스트도 그런
 * 본문을 매치하지 않고 원문 그대로 보여 준다).
 */
export function parseColorSegments(
  line: string,
  syntax: ColorPatternSyntax,
): ColorSegment[] {
  return parseColorSpans(line, syntax).map(({ text, color }) => ({
    text,
    color,
  }));
}

/** 두 색을 같은 색으로 볼지(대소문자 무시 — `#F00`과 `#f00`은 같은 색이다). */
function sameColor(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 빈 세그먼트를 버리고 인접한 같은 색을 하나로 합친다(순수) — 색 문자열은 **왼쪽 것**을
 * 남긴다(사용자가 손으로 적어 둔 표기를 함부로 바꾸지 않는다).
 *
 * 빈 세그먼트를 버리는 것이 왜 중요한가: 글자가 빈 감싸기(`{{|#f00}}`)는 호스트 본문
 * (`.+?`)에 걸리지 않아 원문이 그대로 노출된다 — 쪼개기의 부산물로도 만들면 안 된다.
 */
function normalizeSegments(segments: readonly ColorSegment[]): ColorSegment[] {
  const out: ColorSegment[] = [];
  for (const seg of segments) {
    if (seg.text === "") continue;
    const last = out[out.length - 1];
    if (last !== undefined && sameColor(last.color, seg.color)) {
      out[out.length - 1] = { text: last.text + seg.text, color: last.color };
      continue;
    }
    out.push({ text: seg.text, color: seg.color });
  }
  return out;
}

/**
 * 평문 좌표 `[from, to)`에 색을 칠한다(`color`가 null이면 벗긴다) — 순수, 테스트용.
 *
 * 경계에 걸친 세그먼트는 **쪼갠다**: 바깥쪽 조각은 원래 색을 유지하고 안쪽 조각만 새 색이
 * 된다. 그래서 "칠해진 구간의 일부만" 다른 색으로 바꿔도 중첩이 생기지 않고 평탄한 나열이
 * 유지된다(이 모듈이 존재하는 이유 그 자체다).
 */
export function paintRange(
  segments: readonly ColorSegment[],
  from: number,
  to: number,
  color: string | null,
): ColorSegment[] {
  if (to <= from) return normalizeSegments(segments);
  const out: ColorSegment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segFrom = pos;
    const segTo = pos + seg.text.length;
    pos = segTo;
    if (segTo <= from || segFrom >= to) {
      out.push(seg);
      continue;
    }
    const cutFrom = Math.max(from, segFrom);
    const cutTo = Math.min(to, segTo);
    if (cutFrom > segFrom) {
      out.push({
        text: seg.text.slice(0, cutFrom - segFrom),
        color: seg.color,
      });
    }
    out.push({
      text: seg.text.slice(cutFrom - segFrom, cutTo - segFrom),
      color,
    });
    if (cutTo < segTo) {
      out.push({ text: seg.text.slice(cutTo - segFrom), color: seg.color });
    }
  }
  return normalizeSegments(out);
}

/** 평문 좌표 `[from, to)`에 걸치는 부분만 잘라 낸다(순수) — 색은 그대로 이어받는다. */
function sliceSegments(
  segments: readonly ColorSegment[],
  from: number,
  to: number,
): ColorSegment[] {
  const out: ColorSegment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segFrom = pos;
    const segTo = pos + seg.text.length;
    pos = segTo;
    const cutFrom = Math.max(from, segFrom);
    const cutTo = Math.min(to, segTo);
    if (cutTo <= cutFrom) continue;
    out.push({
      text: seg.text.slice(cutFrom - segFrom, cutTo - segFrom),
      color: seg.color,
    });
  }
  return out;
}

/**
 * 세그먼트 목록을 원문으로 되돌린다(순수, 테스트용) — 인접 동일 색 병합·빈 세그먼트 제거를
 * 먼저 하므로 `{{a|#f00}}{{b|#f00}}` 같은 쪼개진 잔해나 빈 감싸기가 나오지 않는다.
 */
export function serializeColorSegments(
  segments: readonly ColorSegment[],
  syntax: ColorPatternSyntax,
): string {
  const { open, close, prefix } = syntax;
  return normalizeSegments(segments)
    .map((seg) =>
      seg.color === null
        ? seg.text
        : `${open}${seg.text}${prefix}${seg.color}${close}`,
    )
    .join("");
}

/**
 * 원문 오프셋을 평문 오프셋으로 옮긴다(순수).
 *
 * 구분자 안쪽(예: `{{`의 한가운데, `|#e33}}` 꼬리 위)에 떨어진 오프셋은 **그 세그먼트의
 * 글자 경계로 붙인다** — 여는 구분자 쪽이면 글자 시작으로, 꼬리 쪽이면 글자 끝으로. 왜:
 * 색이 칠해진 줄에서는 구분자가 화면에서 숨겨져(라이브 프리뷰) 드래그가 자연히 그 경계
 * 바깥에서 멎는다. 붙이지 않으면 "보이는 글자를 전부 드래그했는데 끝 글자만 색이 안 바뀐다"
 * 같은 어긋남이 생긴다.
 */
function toPlainOffset(spans: readonly ColorSpan[], offset: number): number {
  for (const span of spans) {
    if (offset >= span.to) continue;
    if (offset <= span.innerFrom) return span.plainFrom;
    if (offset >= span.innerTo) return span.plainFrom + span.text.length;
    return span.plainFrom + (offset - span.innerFrom);
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 0 : last.plainFrom + last.text.length;
}

/** [`computeLineColorEdit`]의 결과 — 줄 기준 원문 범위와 거기 넣을 새 원문. */
interface LineColorEdit {
  /** 갈아 끼울 범위의 시작(줄 기준 — 선택 밖의 구분자까지 포함할 수 있다). */
  from: number;
  /** 갈아 끼울 범위의 끝. */
  to: number;
  /** 그 범위에 넣을 새 원문. */
  insert: string;
  /** 칠하기 전 그 구간에 색이 하나라도 있었는지(해제할 게 있는지 판정하는 데 쓴다). */
  hadColor: boolean;
}

/**
 * 한 줄의 원문 범위 `[from, to)`에 색을 칠하거나(`color`) 벗긴(`null`) 결과를 계산한다
 * (순수, 테스트용) — 파싱 → 오프셋 변환 → 칠하기 → 직렬화 → **검산**의 전 과정을 한 번에 돈다.
 * 바뀔 것이 없으면(선택이 글자를 하나도 덮지 않으면), 또는 되쓴 결과가 검산을 통과하지
 * 못하면(아래) null이다 — 호출부는 null을 "이 줄은 건드리지 않는다"로 읽는다.
 *
 * 갈아 끼울 범위를 어떻게 좁히는가: 줄 전체를 다시 쓰면 계산은 쉽지만 되쓰기 범위가 쓸데없이
 * 넓어져(적용 후 선택이 줄 전체로 번지고, 되돌리기 단위도 커진다) 좋지 않다. 그래서 칠할
 * 범위에 **실제로 걸치는 세그먼트**만 다시 쓴다:
 * - 색이 있는 세그먼트는 구분자가 통째로 바뀌므로 언제나 통째로 다시 쓴다.
 * - 평문 세그먼트는 걸치는 부분만 다시 쓴다(나머지 평문은 원문과 같으니 건드릴 이유가 없다).
 * - 새로 칠할 색이 바로 옆 세그먼트의 색과 같으면 그 이웃까지 범위를 넓힌다 — 그래야 둘이
 *   하나로 병합돼 `{{a|#f00}}{{b|#f00}}` 같은 쪼개진 잔해가 남지 않는다(평문끼리는 구분자가
 *   없어 저절로 이어지므로 넓히지 않는다).
 *
 * 줄 머리의 구조 문법(`- `·`# `·`> `·`- [ ] ` — [`structuralPrefixLength`])은 칠하기 대상에서
 * **언제나 빠진다**: 선택이 그 앞이나 중간에서 시작했어도 칠하기는 접두 뒤부터 시작하고,
 * 접두를 이미 물고 있는 감싸기(예전 규칙으로 칠해 둔 깨진 데이터)는 이 참에 벗겨 밖으로
 * 꺼낸다 — 다시 칠하거나 해제하는 것만으로 목록·헤딩 구조가 복구된다. 판정은 **평문 좌표**
 * 에서 한다(구분자를 뺀 글자 기준이라 `{{- 항목|#3a5}}`의 접두도 그대로 찾아낸다).
 */
export function computeLineColorEdit(
  line: string,
  from: number,
  to: number,
  color: string | null,
  syntax: ColorPatternSyntax,
): LineColorEdit | null {
  const spans = parseColorSpans(line, syntax);
  if (spans.length === 0) return null;

  const prefix = structuralPrefixLength(
    spans.map((span) => span.text).join(""),
  );
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(line.length, Math.max(from, to));
  const p0 = Math.max(toPlainOffset(spans, lo), prefix);
  const p1 = toPlainOffset(spans, hi);
  // 선택이 글자를 하나도 덮지 않는다(구분자만 걸쳤거나, 구조 접두 안에서만 놀았다).
  if (p1 <= p0) return null;

  const plainTo = (span: ColorSpan): number =>
    span.plainFrom + span.text.length;

  // 접두가 감싸기 안에 들어 있으면 줄 머리부터 다시 써서 그 감싸기를 벗긴다(정규화).
  const stripPrefix =
    prefix > 0 &&
    spans.some((span) => span.color !== null && span.plainFrom < prefix);

  let head = stripPrefix ? 0 : spans.findIndex((span) => plainTo(span) > p0);
  let tail = spans.length - 1;
  while (tail > head && spans[tail].plainFrom >= p1) tail--;

  // 새로 칠한 색이 바깥 이웃과 같으면 병합되도록 범위를 넓힌다(색이 있을 때만 — 평문은
  // 구분자가 없어 넓히지 않아도 그대로 이어진다).
  const headColor = p0 > spans[head].plainFrom ? spans[head].color : color;
  if (headColor !== null) {
    while (head > 0 && sameColor(spans[head - 1].color, headColor)) head--;
  }
  const tailColor = p1 < plainTo(spans[tail]) ? spans[tail].color : color;
  if (tailColor !== null) {
    while (
      tail < spans.length - 1 &&
      sameColor(spans[tail + 1].color, tailColor)
    ) {
      tail++;
    }
  }

  // 평문 세그먼트는 걸치는 부분만, 색이 있는 세그먼트는 통째로 다시 쓴다(접두를 벗겨야 하는
  // 줄은 그 감싸기가 어디서 시작하든 줄 머리부터 통째로 다시 쓴다).
  const headPartial =
    !stripPrefix && spans[head].color === null && p0 > spans[head].plainFrom;
  const tailPartial = spans[tail].color === null && p1 < plainTo(spans[tail]);
  const q0 = headPartial ? p0 : spans[head].plainFrom;
  const q1 = tailPartial ? p1 : plainTo(spans[tail]);
  const editFrom = headPartial
    ? spans[head].innerFrom + (p0 - spans[head].plainFrom)
    : spans[head].from;
  const editTo = tailPartial
    ? spans[tail].innerFrom + (p1 - spans[tail].plainFrom)
    : spans[tail].to;

  const base = sliceSegments(spans, q0, q1);
  // 접두를 먼저 평문으로 되돌린 뒤(q0는 이때 언제나 0이다) 그 뒤에 새 색을 칠한다.
  const scope = stripPrefix ? paintRange(base, 0, prefix - q0, null) : base;
  const insert = serializeColorSegments(
    paintRange(scope, p0 - q0, p1 - q0, color),
    syntax,
  );
  // 접두를 물고 있는 감싸기도 "이 줄에 지울 색이 있다"에 든다 — 그러지 않으면 해제가 그
  // 줄을 통째로 건너뛰어(`computeColorRemove`의 필터) 깨진 접두가 그대로 남는다.
  const hadColor =
    stripPrefix ||
    spans.some(
      (span) =>
        span.color !== null && span.plainFrom < p1 && plainTo(span) > p0,
    );
  // 검산(최후 방어): 되쓴 줄을 **같은 파서로** 다시 읽어 보이는 글자가 그대로인지 본다.
  // 여기까지의 계산은 "줄에 있는 구분자는 전부 이 파이프라인이 만든 것"을 전제하는데, 그
  // 전제는 사용자가 본문에 직접 적을 수 있는 리터럴(`a|#f00}}b` 같은 꼬리) 앞에서 깨진다 —
  // 새 감싸기의 꼬리가 그 리터럴과 결합해 경계가 어긋나고, 그 상태를 저장하면 다음 해제가
  // 남의 글자를 지운다(텍스트 손실). 글자가 하나라도 달라지면 아무것도 하지 않는다:
  // "칠하려 했는데 안 칠해졌다"는 눈에 보이고 되돌릴 수 있지만, 조용한 손실은 그렇지 않다.
  const next = line.slice(0, editFrom) + insert + line.slice(editTo);
  if (plainTextOf(next, syntax) !== plainTextOf(line, syntax)) return null;
  return { from: editFrom, to: editTo, insert, hadColor };
}
