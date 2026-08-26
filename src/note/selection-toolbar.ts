/**
 * 선택 영역 플로팅 서식 툴바 — 마우스로 텍스트를 드래그해 선택하면 선택 영역 근처에 뜬다.
 *
 * 역할: 굵게(**)·기울임(*)·취소선(~~)·인라인 코드(`)·형광펜(==)은 눌러서 바로 토글 적용/해제하고,
 * 링크는 버튼을 누르면 바 안이 URL 입력창으로 바뀌어(별도 모달 없이) `[선택텍스트](url)`을 만든다.
 * 왜: 베타 피드백 — 마크다운 마커를 손으로 타이핑하지 않고도 드래그한 자리에서 바로 서식을 줄 수
 * 있어야 한다. `Mod-B`/`Mod-I`/`Mod-K` 단축키(`md-shortcuts.ts`)와 같은 감싸기 계산([`wrapRange`])을
 * 재사용해 두 경로의 결과가 어긋나지 않게 한다.
 *
 * 다중 라인 선택: 인라인 마커(`**`·`~~`·`` ` ``·색 감싸기)는 줄을 넘어 매치되지 않으므로, 선택이
 * 여러 줄에 걸치면 [`wrapRange`]와 마찬가지로 [`nonBlankLines`](md-shortcuts.ts)로 줄별 조각을
 * 뽑아 조각마다 따로 감싸거나 벗긴다(빈 줄/공백만 있는 줄은 건드리지 않는다). 링크는 예외 —
 * `[여러\n줄](url)`은 유효한 링크가 아니므로 링크 버튼은 다중 라인 선택에서 숨는다.
 *
 * 글자 색만은 조각을 그대로 감싸지 않고 [`color-segments`]의 **평탄 세그먼트 모델**에 넘긴다 —
 * 색 감싸기는 중첩될 수 없는데(호스트가 한 겹만 매치한다) 선택은 기존 감싸기와 부분만 겹칠 수
 * 있어, 그럴 때 감싸기를 쪼개 다시 써야 하기 때문이다.
 *
 * 표시 조건: **선택이 어떻게 만들어졌든** 비어 있지 않으면 뜬다 — 마우스 드래그(mouseup)도,
 * Shift+화살표·Shift+Home/End·`Mod-A`·Shift+클릭 같은 키보드 선택도 같다. 키보드 경로만
 * 짧은 디바운스를 거친다([`SELECTION_SHOW_DEBOUNCE_MS`]): Shift+→를 연타하는 동안 매 글자마다
 * 바가 다시 뜨면 그 자체가 깜빡임이므로, 손이 멈춘 뒤 **한 번만** 판정한다. 편집 시작·선택
 * 해제·스크롤 중 하나라도 일어나면 즉시 숨긴다(단, 선택이 스스로 끌고 간 스크롤은 예외 —
 * [`isSelectionDrivenScroll`]).
 * IME 조합 중에도 뜨지 않지만, 그때는 **버리지 않고** 조합 종료(`compositionend`) 한 번을
 * 예약해 같은 판정을 다시 돌린다 — 조합 종료가 `mouseup`보다 늦게 도착하는 웹뷰에서 멀쩡한
 * 선택이 조용히 사라지지 않게([`shouldRetryAfterComposition`]).
 *
 * 이번 범위에 없는 것: 키보드로 바 **안에** 진입하는 접근성 동선(tabindex·roving focus)과
 * 단축키 호출. 버튼은 지금도 마우스로 누른다.
 *
 * 위치 계산은 CodeMirror의 `showTooltip` 대신 직접 DOM으로 한다: 링크 모드에서 바 안에 `<input>`을
 * 넣어 포커스를 받아야 하는데, `showTooltip`은 매 업데이트마다 뷰를 재생성할 수 있어 입력 중인
 * `<input>`의 포커스·커서 위치가 끊길 위험이 있다. 대신 `plugin-popup.ts`가 쓰는 것과 같은
 * "DOM에 붙인 뒤 실측해 배치"(measure-then-position) 방식을 그대로 따른다.
 */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  EditorSelection,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import {
  contentStart,
  isMultilineText,
  nonBlankLines,
  wrapRange,
} from "./md-shortcuts";
import { computeLineColorEdit } from "./color-segments";
import { t } from "../i18n/t";
import {
  escapeLinkLabel,
  escapeMarkdownUrl,
  unescapeLinkLabel,
} from "./context-menu-insert";
import {
  colorPatternSyntax,
  type ColorPatternSyntax,
} from "../plugin/editor-api";
import {
  liveSelectionActions,
  matchingSelectionActions,
  SELECTION_ACTION_RENDER_LIMIT,
} from "../plugin/selection-action";

/** 감싸기/해제 계산 결과 — 적용할 변경 + 적용 후 새 선택(anchor/head). */
interface WrapResult {
  changes: ChangeSpec;
  anchor: number;
  head: number;
}

/** marker가 어떤 문자 하나만 반복해서 이루어졌으면 그 문자를, 아니면 null을 돌려준다. */
function homogeneousChar(marker: string): string | null {
  if (marker.length === 0) return null;
  const ch = marker[0];
  return [...marker].every((c) => c === ch) ? ch : null;
}

/** text[pos]에서 dir(±1) 방향으로 문자 ch가 몇 번 연속되는지 센다(경계를 벗어나면 멈춘다). */
function runLength(text: string, pos: number, ch: string, dir: 1 | -1): number {
  let count = 0;
  for (let i = pos; i >= 0 && i < text.length && text[i] === ch; i += dir) {
    count++;
  }
  return count;
}

/**
 * `boundaryPos`에서 `dir` 방향으로 `marker` 하나가 정확히(다른 마커의 일부가 아니게) 놓여
 * 있는지 판정한다.
 *
 * `*`(기울임, 길이1)와 `**`(굵게, 길이2)는 같은 문자를 반복해 서로 다른 길이를 만드는 이 앱의
 * 유일한 쌍이다 — 단순 `startsWith`/`endsWith`만으로는 `**abc**`(연속 별표 2개)가 기울임
 * 마커("*", 길이1)의 접두사와도 우연히 일치해 버려 실제로는 없는 기울임 마커를 있다고
 * 오판한다(그 결과 굵게가 기울임으로 깨진다). 그래서 경계의 실제 연속 길이(run)까지 함께
 * 본다: run이 marker.length와 정확히 같으면(단독 마커) 물론 인정하고, `***text***`(연속
 * 3개 = 굵게+기울임 조합)처럼 run이 정확히 3일 때도 그 중 어느 쪽 버튼을 누르든 그 길이만큼만
 * 벗겨내는 것을 인정한다(나머지 문자는 반대쪽 마커로 그대로 남아야 하므로). 그 외의 길이
 * (예: 연속 2개인데 길이1 마커를 누름)는 "다른 마커의 일부"로 보고 거부해 wrapRange의
 * 감싸기(추가) 경로로 넘긴다. 반복 문자가 아닌 마커는 기존처럼 리터럴 비교만 한다.
 */
function markerBoundaryMatches(
  text: string,
  boundaryPos: number,
  marker: string,
  dir: 1 | -1,
): boolean {
  if (marker.length === 0) return true;
  const ch = homogeneousChar(marker);
  if (!ch) {
    const start = dir === 1 ? boundaryPos : boundaryPos - marker.length + 1;
    return text.slice(start, start + marker.length) === marker;
  }
  const run = runLength(text, boundaryPos, ch, dir);
  return run === marker.length || (ch === "*" && run === 3);
}

/** [`resolveMarkerTarget`]의 판정 결과 — 갈아 끼울 절대 범위, 마커를 뺀 안쪽 글자, 이미
 * 마커가 있었는지. */
interface MarkerTarget {
  from: number;
  to: number;
  inner: string;
  wrapped: boolean;
}

/**
 * 문서 절대 위치 `[from, to)`(이미 공백을 뺀 한 조각) 하나에 마커가 이미 있는지 판정한다(순수).
 *
 * [`computeToggleWrap`]의 단일 라인 두 갈래(통짜로 물고 있음 / 바로 바깥에 붙어 있음)를 절대
 * 위치 버전으로 옮기고, 거기에 **한쪽만** 바깥에 있는 세 번째 모양을 더한다.
 *
 * 왜 세 번째 모양이 필요한가: 라이브 프리뷰는 **커서가 있는 줄만** 마커를 원문 그대로 보여주고
 * 나머지 줄은 숨긴다(`live-preview.ts`). 여러 줄을 드래그해 선택하면, 그 선택은 하나의 연속
 * 구간이라 중간을 지나는 줄은 항상 통짜로 딸려 들어오지만, 선택의 **첫 줄·마지막 줄**은
 * 선택이 그 줄 중간에서 시작/끝날 수 있다 — 그 줄이 숨은 줄이면 드래그가 자연히 숨은 마커
 * 바로 바깥(경계)에서 멎으므로, 마커 한쪽(반대쪽 줄로 이어지는 쪽)은 선택에 딸려 들어오고
 * 다른 한쪽(그 줄이 끝나는 쪽)만 선택 밖에 남는다. 이 모양을 통짜/양쪽-바깥 둘로만 판정하면
 * 그 줄은 "마커가 없다"로 오판되어, 토글 시 남은 마커 글자가 그대로 다시 감싸져 깨진 채
 * 남는다(예: `abc**`를 또 `**`로 감싸 `**abc***`가 된다).
 */
function resolveMarkerTarget(
  doc: string,
  from: number,
  to: number,
  before: string,
  after: string,
): MarkerTarget {
  const core = doc.slice(from, to);

  const beforeInside =
    core.length >= before.length &&
    core.startsWith(before) &&
    markerBoundaryMatches(core, 0, before, 1);
  const afterInside =
    core.length >= after.length &&
    core.endsWith(after) &&
    markerBoundaryMatches(core, core.length - 1, after, -1);
  const beforeOutside =
    before.length > 0 &&
    from >= before.length &&
    doc.slice(from - before.length, from) === before &&
    markerBoundaryMatches(doc, from - 1, before, -1);
  const afterOutside =
    after.length > 0 &&
    to + after.length <= doc.length &&
    doc.slice(to, to + after.length) === after &&
    markerBoundaryMatches(doc, to, after, 1);

  // 통짜(둘 다 안쪽)는 길이 겹침 사고를 막기 위해 core가 두 마커를 합친 길이 이상일 때만 인정
  // 한다(예: core가 딱 "**"뿐이면 시작·끝 판정이 같은 두 글자를 가리켜 안쪽 글자가 음수가 된다).
  const wholeOk = before.length + after.length <= core.length;
  const beforeFound = (beforeInside && wholeOk) || beforeOutside;
  const afterFound = (afterInside && wholeOk) || afterOutside;
  const useBeforeInside = beforeInside && wholeOk;
  const useAfterInside = afterInside && wholeOk;

  if (beforeFound && afterFound) {
    return {
      from: useBeforeInside ? from : from - before.length,
      to: useAfterInside ? to : to + after.length,
      inner: doc.slice(
        useBeforeInside ? from + before.length : from,
        useAfterInside ? to - after.length : to,
      ),
      wrapped: true,
    };
  }

  return { from, to, inner: core, wrapped: false };
}

/**
 * `targets`(절대 위치, 문서 순서대로 겹치지 않음) 각각을 `render`로 바꿔치기해 다시 짠다(순수)
 * — 타깃 사이·바깥 구간은 원문 그대로 통과시킨다. 다중 라인 마커 토글·색 적용/해제가 공유하는
 * "줄별 조각 갈아 끼우기" 공용 조립 로직이다.
 *
 * 갈아 끼울 실제 범위는 `[from, to)`가 아니라 **타깃들을 전부 덮는 범위**다 — 선택의 첫/마지막
 * 조각이 바로 바깥의 마커까지 같이 지워야 할 때([`resolveMarkerTarget`]의 "한쪽만 바깥" 모양)
 * 그 마커가 원래 선택 밖에 있을 수 있기 때문이다(단일 라인의 "바로 바깥" 토글이 선택 밖의
 * 마커까지 지우는 것과 같은 원리 — 그 결과 선택도 지운 전체를 덮게 넓어진다).
 */
function spliceTargets<T extends { from: number; to: number }>(
  doc: string,
  from: number,
  to: number,
  targets: readonly T[],
  render: (target: T) => string,
): WrapResult {
  const effFrom = targets.length > 0 ? Math.min(from, targets[0].from) : from;
  const effTo =
    targets.length > 0 ? Math.max(to, targets[targets.length - 1].to) : to;
  let insert = "";
  let cursor = effFrom;
  for (const target of targets) {
    insert += doc.slice(cursor, target.from) + render(target);
    cursor = target.to;
  }
  insert += doc.slice(cursor, effTo);
  return {
    changes: { from: effFrom, to: effTo, insert },
    anchor: effFrom,
    head: effFrom + insert.length,
  };
}

/**
 * 다중 라인 선택의 마커 토글(순수) — [`computeToggleWrap`]이 선택에 줄바꿈이 있으면 여기로
 * 넘긴다.
 *
 * 규칙: 공백을 뺀 줄 조각 전부(1개 이상)가 이미 마커로 감싸져 있으면 **전부 벗긴다**. 일부만
 * 감싸져 있으면(하나도 없는 경우 포함) 감싸지지 않은 조각만 새로 감싸고, 이미 감싸진 조각은
 * 손대지 않는다 — 즉 "부분 상태"를 항상 "전부 감싼 상태"로 통일한다. 조각이 하나도 없으면
 * (선택이 빈 줄/공백뿐이면) `null` — 감쌀 글자가 없으므로 무변경이다(호출부는 dispatch 자체를
 * 생략한다. "같은 글자로 치환"하는 트랜잭션도 CodeMirror 기준으로는 `docChanged`라 노트가
 * dirty로 표시되고 되돌리기 스텝이 쌓이기 때문).
 *
 * `nonBlankLines`에는 **이 선택의 첫 조각이 진짜 줄 머리에서 시작하는지**를 함께 넘긴다 —
 * `from`이 줄 중간이면(드래그가 그 줄의 두 번째 단어부터 시작) 첫 조각의 머리가 우연히
 * `- `·`> ` 같은 구조 마커 모양이어도 그건 본문 글자이지 줄 머리 마커가 아니다.
 */
function computeMultilineToggleWrap(
  doc: string,
  from: number,
  to: number,
  before: string,
  after: string,
): WrapResult | null {
  const firstLineAtLineStart = lineBoundsAt(doc, from).start === from;
  const targets = nonBlankLines(doc.slice(from, to), firstLineAtLineStart).map(
    (line) =>
      resolveMarkerTarget(
        doc,
        from + line.offset,
        from + line.offset + line.core.length,
        before,
        after,
      ),
  );
  if (targets.length === 0) return null;
  const allWrapped = targets.every((t) => t.wrapped);

  return spliceTargets(doc, from, to, targets, (t) =>
    allWrapped
      ? t.inner
      : t.wrapped
        ? doc.slice(t.from, t.to)
        : `${before}${t.inner}${after}`,
  );
}

/**
 * 선택 영역에 `before`/`after` 마커를 적용하거나(없으면) 제거한다(있으면) — 토글(순수, 테스트용).
 *
 * 두 가지 "이미 마커가 있다" 모양을 인식한다:
 * 1) 선택 영역 자체가 마커를 통째로 물고 있음(예: `**abc**` 전체를 드래그) → 안쪽 텍스트만 남긴다.
 * 2) 선택 영역 바로 바깥에 마커가 붙어 있음(예: `**[abc]**`에서 `abc`만 드래그) → 바깥 마커를 지운다.
 * 둘 다 아니면 [`wrapRange`](md-shortcuts.ts — `Mod-B`/`Mod-I`/`Mod-K`와 같은 계산)로 감싼다.
 *
 * 두 판정 모두 [`markerBoundaryMatches`]로 "그 경계가 정확히 이 marker인지(더 긴 동종 마커의
 * 일부가 아닌지)"까지 확인한다 — 그렇지 않으면 `**bold**`에 기울임을 누르는 것처럼 서로 다른
 * 길이의 동종 마커(`*`/`**`)를 혼동해 서식을 손상시킨다.
 *
 * 선택이 여러 줄에 걸치면(줄바꿈을 포함하면) 위 판정을 통째로 [`computeMultilineToggleWrap`]에
 * 넘긴다 — 인라인 마커는 줄을 넘어 매치되지 않으므로 줄 조각별로 따로 감싸거나 벗겨야 한다.
 *
 * 단일 라인에서도 줄 머리의 구조 문법(`- `·`# `·`> `·`- [ ] `)은 마커 밖에 남는다: 판정 안에
 * 예외를 끼워 넣는 대신 **들어오기 전에 범위를 좁힌다**([`contentStart`]) — 그래야 위 두 판정
 * (특히 `*`/`**` 혼동을 막는 [`markerBoundaryMatches`])을 한 글자도 바꾸지 않고, 줄 전체를 잡아
 * 굵게를 눌러도(트리플 클릭) `**- 항목**`이 아니라 `- **항목**`이 되고 그 상태에서 다시 누르면
 * 정확히 해제된다(좁힌 범위가 `**항목**`이라 "통짜" 분기가 그대로 성립한다).
 *
 * 감쌀 글자가 없으면(선택이 구조 접두 안에서만 놀았거나, 다중 라인 선택에 non-blank 줄이
 * 하나도 없으면) `null`을 돌려준다 — 호출부([`dispatchWrap`])는 이때 dispatch 자체를
 * 생략한다. "같은 글자로 치환"하는 트랜잭션을 그대로 dispatch하면 CodeMirror는 그것도
 * `docChanged`로 보므로(삽입 문자열을 원문과 비교하지 않는다) 노트가 dirty로 표시되고
 * 되돌리기 스택에 아무 일도 안 하는 단계가 쌓인다.
 */
export function computeToggleWrap(
  doc: string,
  from: number,
  to: number,
  before: string,
  after: string,
): WrapResult | null {
  if (isMultilineText(doc.slice(from, to))) {
    return computeMultilineToggleWrap(doc, from, to, before, after);
  }

  const line = lineBoundsAt(doc, from);
  const start = contentStart(
    from,
    to,
    line.start,
    doc.slice(line.start, line.end),
  );
  if (start >= to && to > from) {
    // 선택이 구조 접두 안에서만 놀았다 — 감쌀 글자가 없으므로 무변경(null).
    return null;
  }
  const selected = doc.slice(start, to);

  if (
    before.length + after.length <= selected.length &&
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    markerBoundaryMatches(selected, 0, before, 1) &&
    markerBoundaryMatches(selected, selected.length - 1, after, -1)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return {
      changes: { from: start, to, insert: inner },
      anchor: start,
      head: start + inner.length,
    };
  }

  const outerFrom = Math.max(0, start - before.length);
  const outerTo = Math.min(doc.length, to + after.length);
  if (
    before.length > 0 &&
    doc.slice(outerFrom, start) === before &&
    doc.slice(to, outerTo) === after &&
    markerBoundaryMatches(doc, start - 1, before, -1) &&
    markerBoundaryMatches(doc, to, after, 1)
  ) {
    return {
      changes: [
        { from: outerFrom, to: start, insert: "" },
        { from: to, to: outerTo, insert: "" },
      ],
      anchor: outerFrom,
      head: outerFrom + selected.length,
    };
  }

  return wrapRange(start, to, selected, before, after);
}

/**
 * 선택 텍스트가 완전한 마크다운 링크(`[라벨](url)`)이면 라벨/url을 뽑는다(순수, 테스트용).
 *
 * 라벨 그룹은 백슬래시-이스케이프 쌍(`\]`·`\[`·`\\`)을 하나의 단위로 먹고, 이스케이프 안 된
 * `]`에서만 멈춘다 — [`escapeLinkLabel`]로 만든 라벨(예: "a\]b")을 다시 선택했을 때도 라벨이
 * 조기 절단되지 않고 온전히 인식되게 하기 위해서다. 뽑아낸 라벨은 [`unescapeLinkLabel`]로
 * 원문으로 되돌려 돌려준다(호출부는 항상 "사용자가 보는" 평문을 받는다).
 */
export function parseLinkSelection(
  selected: string,
): { label: string; url: string } | null {
  const match = /^\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)$/.exec(selected);
  return match ? { label: unescapeLinkLabel(match[1]), url: match[2] } : null;
}

/**
 * 선택 영역을 링크로 바꾼다(순수, 테스트용) — 이미 링크였다면 그 라벨을 이어받고 url만 바꾼다.
 * 적용 후 커서는 삽입된 링크 뒤(collapsed)로 옮긴다 — 이어서 타이핑을 계속할 수 있게.
 *
 * 라벨은 [`escapeLinkLabel`], URL은 [`escapeMarkdownUrl`]로 이스케이프한다 — 선택 텍스트에
 * `]`/`[`가 섞이거나 URL에 짝 안 맞는 `)`가 섞여도 링크 구조가 깨지지 않는다
 * (`context-menu-insert.ts`의 `linkInsertMarkdown`과 같은 이스케이프 규칙을 공유한다).
 */
export function computeLinkApply(
  doc: string,
  from: number,
  to: number,
  url: string,
): WrapResult {
  const selected = doc.slice(from, to);
  const existing = parseLinkSelection(selected);
  const label = existing ? existing.label : selected;
  const insert = `[${escapeLinkLabel(label)}](${escapeMarkdownUrl(url)})`;
  return {
    changes: { from, to, insert },
    anchor: from + insert.length,
    head: from + insert.length,
  };
}

/**
 * 선택 영역이 이미 완전한 링크면 라벨만 남기고 벗겨낸다(토글-오프, 순수, 테스트용).
 * 링크가 아니면 null — 호출부는 이때 URL 입력 모드로 전환해야 한다는 뜻이다.
 */
export function computeLinkToggleOff(
  doc: string,
  from: number,
  to: number,
): WrapResult | null {
  const selected = doc.slice(from, to);
  const existing = parseLinkSelection(selected);
  if (!existing) return null;
  return {
    changes: { from, to, insert: existing.label },
    anchor: from,
    head: from + existing.label.length,
  };
}

// ── 글자 색(`{{글자|#hex}}`) ────────────────────────────────────────────────
//
// 여기 있는 계산은 **문법을 하드코딩하지 않는다** — 구분자(`open`/`close`/`prefix`)는 지금
// 에디터에 살아 있는 인라인 패턴 등록에서 온다([`colorPatternSyntax`] facet, 「글자 색」
// 번들이 등록한 그 값). 그래서 플러그인이 꺼지면 버튼이 사라지고, 문법이 바뀌면 버튼도 따라
// 바뀐다(두 곳에 같은 문자열을 적어 두고 갈라지는 일이 없다).
//
// 색 계산 자체(파싱·칠하기·직렬화)는 [`color-segments`]가 한다 — 이쪽은 "어느 줄의 어느
// 범위를 칠할까"만 정해 넘긴다. 왜 나눴나: 색 감싸기는 중첩될 수 없는데(호스트가 한 겹만
// 매치한다) 선택은 얼마든지 감싸기와 **부분만** 겹칠 수 있어, 그 겹침을 평탄한 세그먼트로
// 다시 쓰는 계산이 툴바 DOM 코드와 섞이면 손댈 수 없게 된다.

/**
 * 선택 툴바가 그리는 기본 팔레트(9색).
 *
 * 왜 여기 있나: 팔레트는 **노트 창 UI의 소유**다 — 플로팅 바에 들어갈 수 있는 스와치 수가
 * UI 제약이고, 색을 칠하는 플러그인은 문법만 제공한다(임의 hex는 손으로 적으면 그대로
 * 칠해지므로 이 9색이 표현력의 상한이 아니다). 값은 「글자 색」 번들이 예전에 설정
 * 기본값으로 싣고 있던 것과 같다(같은 색을 계속 쓰게 하려는 것).
 */
export const SELECTION_COLOR_PALETTE: readonly string[] = [
  "#e33",
  "#f70",
  "#fc3",
  "#3a5",
  "#17c",
  "#93b",
  "#850",
  "#000",
  "#fff",
];

/** 색을 갈아 끼울 대상 한 줄 — [`computeLineColorEdit`]의 결과를 문서 절대 위치로 옮긴 것. */
interface ColorEditTarget {
  /** 갈아 끼울 범위의 시작(선택 밖의 구분자까지 포함할 수 있다). */
  from: number;
  /** 갈아 끼울 범위의 끝. */
  to: number;
  /** 그 범위에 넣을 새 원문. */
  insert: string;
  /** 칠하기 전 그 구간에 색이 있었는지(해제할 게 있는지 판정하는 데 쓴다). */
  hadColor: boolean;
}

/** `pos`가 놓인 줄의 시작·끝(줄바꿈 문자는 뺀다 — `\r\n`·`\r`·`\n` 모두 경계로 본다). */
function lineBoundsAt(
  doc: string,
  pos: number,
): { start: number; end: number } {
  const isBreak = (ch: string | undefined): boolean =>
    ch === "\n" || ch === "\r";
  let start = pos;
  while (start > 0 && !isBreak(doc[start - 1])) start--;
  let end = pos;
  while (end < doc.length && !isBreak(doc[end])) end++;
  return { start, end };
}

/**
 * 선택을 줄별 색 편집 대상으로 바꾼다(순수) — 색 계산 자체는 [`computeLineColorEdit`]가 한다.
 *
 * 왜 줄 단위인가: 색 감싸기(`{{...|#hex}}`)는 다른 인라인 마커와 마찬가지로 줄을 넘어
 * 매치되지 않는다. 그래서 여러 줄 선택은 [`nonBlankLines`]로 줄별 조각을 뽑아 조각마다 따로
 * 처리한다(빈 줄/공백만 있는 줄은 건드리지 않는다). 단일 라인 선택은 조각이 하나뿐인
 * 같은 규칙이다(다만 앞뒤 공백을 다듬지 않는다 — 드래그한 그대로 칠한다).
 *
 * 줄 머리의 구조 문법(`- `·`# `·`> `·`- [ ] `)은 어느 경로로도 감싸기 안에 들어가지 않는다:
 * 다중 라인 조각은 [`nonBlankLines`]가 이미 접두 뒤에서 시작하고, 단일 라인은
 * [`computeLineColorEdit`]가 같은 판정([`structuralPrefixLength`])으로 칠할 범위를 접두 뒤로
 * 민다 — 서식 감싸기와 색 칠하기가 한 규칙을 공유한다.
 *
 * **조각이 아니라 줄 전체를 파싱해 넘긴다**: 색이 칠해진 줄에서는 `{{`·`|#hex}}`가 화면에서
 * 숨겨져(라이브 프리뷰) 드래그가 그 경계 바로 바깥에서 자연히 멎으므로, 선택 밖에 남은
 * 구분자까지 봐야 "이 글자에는 이미 색이 있다"를 옳게 판정할 수 있다. 줄 전체를 파싱하면
 * 그 판정이 오프셋 변환의 부산물로 저절로 따라온다(예전처럼 "한쪽 구분자만 선택 밖" 같은
 * 특수 모양을 따로 다룰 필요가 없다).
 *
 * 다중 라인 조각도 [`computeMultilineToggleWrap`]과 같은 이유로 `nonBlankLines`에 "첫 조각이
 * 진짜 줄 머리에서 시작하는가"를 넘긴다 — 그렇지 않으면 줄 중간에서 시작한 드래그의 첫 조각이
 * 우연히 구조 마커 모양이어도(`- `·`> ` 등) 그 글자를 접두로 오판해 색칠 대상에서 빼먹는다.
 */
function colorEditTargets(
  doc: string,
  from: number,
  to: number,
  color: string | null,
  syntax: ColorPatternSyntax,
): ColorEditTarget[] {
  const selected = doc.slice(from, to);
  const firstLineAtLineStart = lineBoundsAt(doc, from).start === from;
  const fragments = isMultilineText(selected)
    ? nonBlankLines(selected, firstLineAtLineStart).map((line) => ({
        from: from + line.offset,
        to: from + line.offset + line.core.length,
      }))
    : [{ from, to }];

  const targets: ColorEditTarget[] = [];
  for (const fragment of fragments) {
    const { start, end } = lineBoundsAt(doc, fragment.from);
    const edit = computeLineColorEdit(
      doc.slice(start, end),
      fragment.from - start,
      fragment.to - start,
      color,
      syntax,
    );
    if (edit === null) continue;
    targets.push({
      from: start + edit.from,
      to: start + edit.to,
      insert: edit.insert,
      hadColor: edit.hadColor,
    });
  }
  return targets;
}

/**
 * 선택 영역을 고른 색으로 칠한다(순수, 테스트용) — 새로 감싸거나, 이미 칠해져 있으면 그
 * 부분만 갈아 끼운다. 적용 후에는 다시 쓴 전체를 선택 상태로 남긴다(이어서 다른 색을 고를
 * 수 있게).
 *
 * 감싸기는 **절대 중첩되지 않는다**: 선택이 기존 감싸기와 부분만 겹치면 그 감싸기를 쪼개
 * `{{앞|#f00}}{{뒤|#00f}}`처럼 평탄하게 다시 쓴다([`color-segments`]) — 중첩된 본문은 호스트가
 * 매치하지 못해 원문이 그대로 노출되기 때문이다.
 *
 * 칠할 대상이 하나도 없으면(예: 빈 줄·공백만 있는 여러 줄을 드래그) `null` — [`computeToggleWrap`]
 * 과 같은 이유로 무변경이다. 호출부는 이때 dispatch 자체를 생략한다("같은 글자로 치환"하는
 * 트랜잭션도 CodeMirror 기준으로는 docChanged라 노트가 dirty로 표시되고 되돌리기 스텝이 쌓인다).
 */
export function computeColorApply(
  doc: string,
  from: number,
  to: number,
  color: string,
  syntax: ColorPatternSyntax,
): WrapResult | null {
  const targets = colorEditTargets(doc, from, to, color, syntax);
  if (targets.length === 0) return null;
  return spliceTargets(doc, from, to, targets, (t) => t.insert);
}

/**
 * 색 감싸기를 벗겨 평문만 남긴다(순수, 테스트용). 지금 선택에 색이 없으면 null —
 * 호출부는 이때 아무것도 하지 않는다(지울 게 없다).
 *
 * 선택이 감싸기의 **일부만** 덮으면 그 부분만 벗기고 나머지는 원래 색으로 남긴다
 * (`{{앞|#f00}}가운데{{뒤|#f00}}`). 다중 라인에서는 색이 있는 줄만 벗기고 색이 없는 줄은
 * 그대로 둔다 — 벗길 색이 있는 줄이 하나도 없으면 단일 라인과 마찬가지로 null.
 */
export function computeColorRemove(
  doc: string,
  from: number,
  to: number,
  syntax: ColorPatternSyntax,
): WrapResult | null {
  const targets = colorEditTargets(doc, from, to, null, syntax).filter(
    (t) => t.hadColor,
  );
  if (targets.length === 0) return null;
  return spliceTargets(doc, from, to, targets, (t) => t.insert);
}

/** 표시 여부 판단에 필요한 최소 상태(순수, 테스트용). */
interface SelectionGesture {
  /** 주 선택이 비어 있지 않은지(커서만 있으면 false). */
  hasSelection: boolean;
  /** IME 조합 중인지 — 조합 중엔 뜨지 않는다(다른 편집 UI와 같은 관례). */
  composing: boolean;
}

/**
 * 이 제스처에서 플로팅 툴바를 보여줘도 되는지 판단한다(순수, 테스트용).
 *
 * 두 조건이면 된다: 선택이 비어 있지 않고, IME 조합 중이 아니어야 한다.
 *
 * **선택을 만든 수단은 보지 않는다.** 예전에는 "마우스로 만든 선택"이라는 조건이 하나 더
 * 있었지만 그건 기술적 제약이 아니라 관례였고, 그 탓에 Shift+화살표·Shift+Home/End·
 * `Mod-A`·Shift+클릭으로 고른 글자에는 서식 바가 영영 뜨지 않았다(키보드만 쓰는 사용자에게는
 * 이 기능이 통째로 없는 것과 같다). 수단을 묻지 않는 대신 **키보드 경로는 호출부가 짧은
 * 디바운스를 걸어** 연타 중 깜빡임을 막는다([`SELECTION_SHOW_DEBOUNCE_MS`]).
 */
export function shouldShowSelectionToolbar(gesture: SelectionGesture): boolean {
  return gesture.hasSelection && !gesture.composing;
}

/**
 * 이번 제스처를 **조합이 끝나면 한 번 더** 판정해야 하는지 정한다(순수, 테스트용).
 *
 * 왜 필요한가: [`shouldShowSelectionToolbar`]의 두 조건 중 `composing`만은 **곧 스스로
 * 풀리는** 일시 상태다. 한글 IME는 조합이 열린 채로 다음 동작이 시작될 수 있고, 조합 종료
 * (`compositionend`)가 `mouseup`보다 **늦게** 도착하는 웹뷰가 있다 — 그러면 드래그가 만든
 * 멀쩡한 선택인데도 표시 판정이 "조합 중"에 걸려 조용히 버려진다(오류도 로그도 없이 바가
 * 영영 안 뜨는 모양). 조합 중에 Shift+화살표로 고른 선택도 같은 처지이므로 함께 구제한다.
 * 나머지 조건은 다시 봐도 답이 같으므로(선택이 비었으면 비었다) 재판정 대상이 아니다.
 *
 * 참이면 호출부는 **조합 종료 이벤트 1회**를 기다렸다가 같은 판정을 다시 돌린다 — 폴링이
 * 아니라 이벤트 1회다(고빈도 재평가 금지). 그때 선택이 이미 풀렸거나 다른 제스처가
 * 시작됐으면 기존 숨김 규칙이 그대로 이긴다(재판정은 표시를 **추가로 허락**하지 않는다).
 */
export function shouldRetryAfterComposition(
  gesture: SelectionGesture,
): boolean {
  return (
    !shouldShowSelectionToolbar(gesture) &&
    gesture.hasSelection &&
    gesture.composing
  );
}

/**
 * 키보드로 만든 선택의 표시 판정을 이만큼(ms) 미룬다 — **디바운스**다(매 변경마다 다시 잰다).
 *
 * 왜 마우스에는 없고 키보드에만 있나: 드래그는 `mouseup` 하나로 "다 골랐다"는 신호가 오지만,
 * 키보드에는 그런 종료 신호가 없다 — Shift+→를 열 번 누르면 선택 변경 트랜잭션이 열 번 온다.
 * 그때마다 바를 다시 그리고 다시 배치하면 글자마다 바가 튀는 깜빡임이 되고, 매 키 입력이
 * 레이아웃 측정을 한 번씩 부르는 비용도 진다. 손이 멈춘 뒤 한 번만 판정한다.
 *
 * 값의 근거: 사람이 방향키를 이어 누르는 간격(보통 30~150ms)보다는 확실히 길고, "골랐는데
 * 바가 안 뜬다"고 느끼기 시작하는 지연(대략 300ms 이상)보다는 짧게 잡는다.
 */
export const SELECTION_SHOW_DEBOUNCE_MS = 250;

/**
 * 이 스크롤이 **선택이 스스로 끌고 간 것**인지 판단한다(순수, 테스트용) — 참이면 숨기지 않는다.
 *
 * 왜 필요한가: 스크롤은 원래 즉시 숨김 사유다(바는 `position: fixed`라 본문과 함께 움직이지
 * 않는다 — 놔두면 엉뚱한 글자 위에 남는다). 그런데 Shift+↓로 화면 경계를 넘기면 CodeMirror가
 * 새 선택 끝을 보이게 하려고 `scrollIntoView`로 **스스로** 스크롤한다. 그 스크롤까지 숨김으로
 * 치면 화면 끝에서 아래로 선택을 늘리는 내내 바가 떴다 사라졌다 하는 깜빡임이 된다.
 *
 * 판정 근거는 둘의 AND다: (1) 지금 키보드 선택 표시가 예약돼 있다 — 이 예약은 선택 변경
 * 트랜잭션에서만 걸리므로, 걸려 있다는 것 자체가 "방금 선택이 움직였다"는 뜻이다. (2) 그
 * 선택 변경을 본 지 [`SELECTION_SHOW_DEBOUNCE_MS`]가 안 지났다. 자동 스크롤은 그 트랜잭션과
 * 같은 프레임에 일어나므로 이 창을 넉넉히 통과한다.
 *
 * **한계(의도적)**: 예약이 살아 있는 그 짧은 창 안에 사용자가 **직접** 휠을 굴리면 그것도
 * 선택 유발로 오인한다. 브라우저는 프로그램 스크롤과 사용자 스크롤을 구분해 주지 않아
 * (`Event.isTrusted`는 둘 다 참이다) 시간·인과 말고는 근거가 없다. 오인의 대가는 "바가 한
 * 박자 늦게 따라간다"뿐이고, 반대로 틀리면 "키보드로 선택을 늘리는 내내 바가 깜빡인다"라
 * 이쪽으로 기운다. 창 밖의 스크롤은 예전처럼 전부 즉시 숨김이다.
 */
export function isSelectionDrivenScroll(
  pendingSelectionShow: boolean,
  now: number,
  lastSelectionSetAt: number,
  windowMs: number = SELECTION_SHOW_DEBOUNCE_MS,
): boolean {
  return (
    pendingSelectionShow &&
    lastSelectionSetAt !== 0 &&
    now - lastSelectionSetAt < windowMs
  );
}

/**
 * 조합 활동이 이만큼(ms) 끊기면 `EditorView.composing`을 더 이상 믿지 않는다.
 *
 * 근거는 CodeMirror의 상태 기계다: `inputState.composing`을 "조합 아님"(-1)으로 되돌리는
 * 경로는 **`compositionend` 하나뿐**이다(포커스 변화도, 타임아웃도, blur도 되돌리지 않는다 —
 * `@codemirror/view` 소스 확인). 즉 웹뷰가 그 이벤트를 한 번이라도 흘리면 `composing`은
 * **영원히** 참으로 남고, 그 값을 단독으로 믿는 게이트는 그 순간부터 모든 드래그를 조용히
 * 버린다(복구 경로 없음). 사람이 조합 중이라면 키 입력이 계속 이어지므로 1초 이상 아무 조합
 * 이벤트가 없다는 것은 "조합이 실제로 끝났는데 통지를 못 받았다"에 훨씬 가깝다.
 */
export const COMPOSITION_STALE_MS = 1000;

/**
 * 폴백 재판정 타이머를 [`COMPOSITION_STALE_MS`] 경계보다 이만큼(ms) 뒤로 미는 여유.
 * 경계에 딱 맞추면 타이머 해상도 오차로 "아직 1ms 모자람" 판정이 나 한 번 더 예약된다.
 */
const STALE_CHECK_SLACK_MS = 50;

/**
 * 지금 보고 있는 `composing`이 **낡은 값**인지 판단한다(순수, 테스트용) — 마지막 조합
 * 이벤트(`compositionstart`/`compositionupdate`)로부터 [`COMPOSITION_STALE_MS`] 이상
 * 지났으면 참이다. 조합 이벤트를 한 번도 못 봤으면(`lastActivityAt === 0`) 역시 참이다 —
 * 이 창이 조합을 목격한 적이 없는데 `composing`만 참인 상태는 그 자체로 신뢰할 수 없다.
 */
export function isCompositionStale(
  now: number,
  lastActivityAt: number,
  staleMs: number = COMPOSITION_STALE_MS,
): boolean {
  return lastActivityAt === 0 || now - lastActivityAt >= staleMs;
}

/**
 * window `mouseup` 이벤트를 "선택 완료"로 취급해도 되는지 판단한다(순수, 테스트용) —
 * 좌클릭(`button === 0`)만 통과시킨다.
 *
 * 왜: 선택 영역 안에서 우클릭하면 브라우저가 mousedown→mouseup→contextmenu 순으로 이벤트를
 * 낸다. 이 판정 없이 모든 버튼의 mouseup을 처리하면, 우클릭의 mouseup이 재표시를
 * queueMicrotask로 걸어 뒤이은 contextmenu(컨텍스트 메뉴 오픈)보다 먼저 실행돼 선택
 * 툴바가 다시 뜬다 — 컨텍스트 메뉴 오버레이가 투명이라 둘이 겹쳐 보인다. 좌클릭만
 * 통과시켜 이 경합을 원천 차단한다.
 */
export function shouldHandleSelectionMouseUp(button: number): boolean {
  return button === 0;
}

/** 위치 계산 입력 — 화면(뷰포트) 좌표계의 선택 영역 바운딩 박스. */
interface SelectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 바 크기와 뷰포트 여백(px) — 어느 쪽으로도 화면 밖에 걸리지 않는다. */
const TOOLBAR_MARGIN = 6;

/**
 * 선택 영역·바 크기·뷰포트 크기로 바를 놓을 좌표를 계산한다(순수, 테스트용).
 *
 * 기본은 선택 영역 위, 위쪽 여백이 모자라면 아래로 뒤집는다. 가로는 선택 영역 중심에 맞추되
 * 좌우 여백 밖으로 나가지 않게 접어 넣는다(창 가장자리 클램프).
 */
export function computeToolbarPosition(
  selection: SelectionRect,
  barSize: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = TOOLBAR_MARGIN,
): { left: number; top: number } {
  const centerX = (selection.left + selection.right) / 2;
  const maxLeft = Math.max(margin, viewport.width - barSize.width - margin);
  const left = Math.max(margin, Math.min(centerX - barSize.width / 2, maxLeft));

  const above = selection.top - barSize.height - margin;
  const below = selection.bottom + margin;
  const maxTop = Math.max(margin, viewport.height - barSize.height - margin);
  const top = above >= margin ? above : Math.min(below, maxTop);

  return { left, top: Math.max(margin, top) };
}

/**
 * 바를 걸 기준 위치 후보를 **선호 순서대로** 돌려준다(순수, 테스트용).
 *
 * 왜 필요한가: CodeMirror는 화면에 가까운 구간만 실제로 그리므로, 렌더 범위 밖 위치에 대한
 * `coordsAtPos`는 `null`이다. 예전에는 선택 **양끝**의 좌표를 둘 다 요구했기 때문에 한쪽만
 * 범위를 벗어나도 놓을 자리를 못 구해 바를 통째로 접었다 — 긴 노트에서 `Mod-A`를 누르면
 * `from = 0`이 화면 밖이라 바가 아예 안 뜨고, 마우스로 화면 밖까지 끌어 놓아도 같았다.
 *
 * 순서의 근거: 첫 후보는 `head`다 — 키보드 선택에서 **지금 움직이고 있는 끝**이자 사용자의
 * 눈이 따라가는 지점이고, `scrollIntoView`가 화면 안에 붙들어 두는 쪽도 여기다. 그 다음이
 * 고정단인 `anchor`, 마지막이 둘을 렌더 범위 안으로 접어 넣은 값이다(양끝이 다 화면 밖인
 * 아주 긴 선택 — 그때는 "선택 어딘가"보다 "보이는 자리"가 낫다). 중복은 걷어낸다.
 */
export function selectionAnchorCandidates(
  selection: { anchor: number; head: number },
  viewport: { from: number; to: number },
): number[] {
  const clamp = (pos: number): number =>
    Math.min(Math.max(pos, viewport.from), viewport.to);
  const ordered = [
    selection.head,
    selection.anchor,
    clamp(selection.head),
    clamp(selection.anchor),
  ];
  return ordered.filter((pos, i) => ordered.indexOf(pos) === i);
}

/** 내부 전용 아이콘 SVG(currentColor 라인 아이콘 — note-toolbar.ts와 같은 결). */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  bold: svg(
    '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  ),
  italic: svg(
    '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  ),
  strike: svg(
    '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  ),
  code: svg(
    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  ),
  link: svg(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  highlight: svg(
    '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  ),
  // 팔레트(글자 색) — 「글자 색」 플러그인이 켜져 있을 때만 뜬다.
  palette: svg(
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  ),
  // 색 지우기 — 팔레트 줄 끝의 해제 버튼(원에 사선).
  colorClear: svg(
    '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="18.4" x2="18.4" y2="5.6"/>',
  ),
} as const;

/** 마커 토글 버튼 하나의 선언(굵게/기울임/취소선/코드/형광펜 — 링크는 모드 전환이라 따로 다룬다). */
interface MarkerButtonSpec {
  icon: string;
  before: string;
  after: string;
  labelKey: string;
}

const MARKER_BUTTONS: readonly MarkerButtonSpec[] = [
  {
    icon: ICON.bold,
    before: "**",
    after: "**",
    labelKey: "note.selection-toolbar.bold",
  },
  {
    icon: ICON.italic,
    before: "*",
    after: "*",
    labelKey: "note.selection-toolbar.italic",
  },
  {
    icon: ICON.strike,
    before: "~~",
    after: "~~",
    labelKey: "note.selection-toolbar.strikethrough",
  },
  {
    icon: ICON.code,
    before: "`",
    after: "`",
    labelKey: "note.selection-toolbar.code",
  },
  {
    icon: ICON.highlight,
    before: "==",
    after: "==",
    labelKey: "note.selection-toolbar.highlight",
  },
];

/** 바를 이루는 DOM 요소 묶음 — 생성 시점에 한 번 만들고 이후로는 표시 여부만 토글한다. */
interface ToolbarDom {
  root: HTMLElement;
  buttonsRow: HTMLElement;
  linkRow: HTMLElement;
  linkInput: HTMLInputElement;
  /**
   * 버튼 줄로 들어가는 링크 버튼 — `[여러\n줄](url)`은 유효한 링크가 아니므로 선택이 다중
   * 라인이면 숨는다(그 판정은 표시 시점에, colorButton과 같은 방식).
   */
  linkButton: HTMLButtonElement;
  /**
   * 색 팔레트 줄(스와치들 + 해제 버튼) — 링크 입력 줄과 **같은 방식**의 모드 전환이다
   * (바 내용만 갈아 끼우고 별도 모달을 띄우지 않는다).
   */
  colorRow: HTMLElement;
  /** 팔레트 줄로 들어가는 버튼 — 색 문법이 살아 있을 때만 보인다(그 판정은 표시 시점에). */
  colorButton: HTMLButtonElement;
  /**
   * 플러그인 선택 액션(`ui.addSelectionAction`) 버튼들이 들어가는 자리 — **색 버튼 다음**
   * (줄 맨 끝)이다. 내용은 표시할 때마다 통째로 다시 만든다: 어느 액션이 보이는가는 그때의
   * 선택 텍스트에 달렸고(`match`), 등록 자체도 플러그인을 켜고 끄면 런타임에 바뀐다.
   */
  actionsSlot: HTMLElement;
}

/** 플로팅 바 DOM을 만든다(이벤트 배선은 호출부가 한다 — 이 함수는 순수 조립만). */
function buildToolbarDom(): ToolbarDom {
  const root = document.createElement("div");
  root.className = "selection-toolbar";
  root.hidden = true;

  const buttonsRow = document.createElement("div");
  buttonsRow.className = "selection-toolbar-buttons";
  root.append(buttonsRow);

  const linkRow = document.createElement("div");
  linkRow.className = "selection-toolbar-link";
  linkRow.hidden = true;
  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.className = "selection-toolbar-link-input";
  linkInput.placeholder = t("note.selection-toolbar.link-placeholder");
  linkRow.append(linkInput);
  root.append(linkRow);

  const colorRow = document.createElement("div");
  colorRow.className = "selection-toolbar-color";
  colorRow.hidden = true;
  root.append(colorRow);

  const linkButton = makeButton(
    ICON.link,
    t("note.selection-toolbar.link"),
    () => {},
  );
  linkButton.classList.add("selection-toolbar-link-btn"); // 테스트·스타일링 훅(colorButton과 같은 관례).
  // 표시 조건(다중 라인 여부)은 매번 표시 직전에 다시 판정한다 — colorButton과 같은 방식.

  const colorButton = makeButton(
    ICON.palette,
    t("note.selection-toolbar.color"),
    () => {},
  );
  colorButton.classList.add("selection-toolbar-color-btn");
  colorButton.hidden = true; // 표시 조건은 매번 표시 직전에 다시 판정한다.

  const actionsSlot = document.createElement("span");
  actionsSlot.className = "selection-toolbar-actions";

  return {
    root,
    buttonsRow,
    linkRow,
    linkInput,
    linkButton,
    colorRow,
    colorButton,
    actionsSlot,
  };
}

/**
 * 플러그인 선택 액션 버튼 하나를 만든다 — 아이콘 SVG가 아니라 저작자가 준 **글자/이모지**를
 * 그대로 그린다(`label`). 툴팁은 `title`이 있으면 그것, 없으면 `label`이다.
 *
 * 왜 [`makeButton`]을 그대로 쓰지 않나: 그 함수는 `innerHTML`로 내부 SVG를 넣는다. 저작자
 * 문자열을 그 경로에 흘리면 그것이 곧 마크업 주입이다 — 여기서는 `textContent`로만 넣는다.
 */
function makeActionButton(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "selection-toolbar-btn selection-toolbar-action-btn";
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", onClick);
  return btn;
}

/** 팔레트 스와치 버튼 하나를 만든다(색은 인라인 배경, 테두리는 CSS가 대비를 준다). */
function makeSwatch(color: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "selection-toolbar-swatch";
  btn.style.background = color;
  btn.title = color;
  btn.setAttribute("aria-label", color);
  btn.dataset.color = color;
  btn.addEventListener("click", onClick);
  return btn;
}

/** 버튼 하나를 만든다(아이콘 + title/aria-label). 링크 입력 줄의 확인/취소 버튼도 이걸로 만든다. */
function makeButton(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "selection-toolbar-btn";
  btn.innerHTML = icon;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 선택 영역 플로팅 서식 툴바 ViewPlugin.
 *
 * 비어 있지 않은 선택이면 수단을 가리지 않고 뜬다. 신호가 둘이라 경로도 둘이다:
 * **마우스**는 mousedown이 에디터 안에서 시작했는지를 추적해 두었다가 window `mouseup`에서
 * (드래그가 에디터 밖에서 끝나도 놓치지 않도록 window에 건다) 즉시 판정하고, **키보드**는
 * 종료 신호가 없으므로 [`update`]가 선택 변경마다 디바운스를 다시 재 손이 멈춘 뒤 한 번만
 * 판정한다. 문서 변경·선택 해제·스크롤 중 하나라도 일어나면 즉시 숨긴다 — 다만 선택이 스스로
 * 끌고 간 스크롤(CM의 `scrollIntoView`)만은 숨기지 않고 따라간다([`isSelectionDrivenScroll`]).
 *
 * 그 판정이 **조합(IME) 때문에만** 막혔다면 `compositionend` 1회를 예약해 다시 돌린다
 * ([`onCompositionEnd`]) — 폴링이 아니라 이벤트 하나이고, 재판정은 처음부터 같은 규칙을
 * 다시 보므로 그 사이 선택이 풀렸거나 새 제스처가 시작됐으면 그대로 뜨지 않는다.
 */
class SelectionToolbarPlugin {
  private readonly view: EditorView;
  private readonly dom: ToolbarDom;
  private visible = false;
  private mouseDownInEditor = false;
  /**
   * 조합(IME) 때문에 표시를 건너뛴 제스처가 있는지 — 참이면 다음 `compositionend` **한 번**이
   * 같은 판정을 다시 돌린다([`shouldRetryAfterComposition`]). 새 제스처가 시작되면 풀린다.
   */
  private retryAfterComposition = false;
  /** 마지막 조합 이벤트 시각(ms) — 0이면 이 창에서 조합을 본 적이 없다. */
  private lastCompositionAt = 0;
  /** 조합 차단당 **딱 하나** 걸리는 폴백 타이머(이벤트 유실 대비 — 폴링이 아니다). */
  private compositionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 키보드 선택 표시를 미뤄 둔 디바운스 타이머 — 항상 **하나뿐**이고, 새 선택 변경이 오면
   * 다시 잰다([`armSelectionShow`]). 조합 폴백 타이머와 같은 규율을 따른다: 숨김 경로·새
   * 마우스 제스처·`destroy`가 반드시 풀어 준다(안 풀면 사라진 선택 자리에 바가 되살아난다).
   */
  private selectionShowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 마지막으로 **선택 변경 트랜잭션**을 본 시각(ms) — [`isSelectionDrivenScroll`]의 입력. */
  private lastSelectionSetAt = 0;

  constructor(view: EditorView) {
    this.view = view;
    this.dom = buildToolbarDom();

    // 버튼(입력창 제외) 클릭이 에디터 포커스를 뺏지 않게 한다 — mousedown 기본 동작만 막고
    // click은 그대로 흘러가 버튼 핸들러가 정상 실행된다.
    this.dom.root.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).tagName !== "INPUT")
        event.preventDefault();
    });

    for (const spec of MARKER_BUTTONS) {
      this.dom.buttonsRow.append(
        makeButton(spec.icon, t(spec.labelKey), () =>
          this.applyMarkerToggle(spec.before, spec.after),
        ),
      );
    }
    this.dom.linkButton.addEventListener("click", () =>
      this.onLinkButtonClick(),
    );
    this.dom.buttonsRow.append(this.dom.linkButton);
    // 글자 색 버튼은 링크 다음(줄 맨 끝) — 「글자 색」 플러그인이 켜져 있을 때만 보인다.
    this.dom.colorButton.addEventListener("click", () =>
      this.onColorButtonClick(),
    );
    this.dom.buttonsRow.append(this.dom.colorButton);
    // 플러그인 선택 액션은 **색 버튼 다음**(줄 맨 끝)이다 — 코어 서식이 늘 같은 자리에 있고,
    // 서드파티가 그 뒤에 붙는다(설치·해제로 코어 버튼의 위치가 흔들리지 않는다).
    this.dom.buttonsRow.append(this.dom.actionsSlot);

    for (const color of SELECTION_COLOR_PALETTE) {
      this.dom.colorRow.append(makeSwatch(color, () => this.applyColor(color)));
    }
    this.dom.colorRow.append(
      makeButton(ICON.colorClear, t("note.selection-toolbar.color-clear"), () =>
        this.clearColor(),
      ),
    );

    this.dom.linkRow.append(
      makeButton("✓", t("note.selection-toolbar.link-apply"), () =>
        this.applyLink(),
      ),
      makeButton("✕", t("note.selection-toolbar.link-cancel"), () =>
        this.cancelLink(),
      ),
    );
    this.dom.linkInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.applyLink();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelLink();
      }
    });

    const ownerDoc = view.dom.ownerDocument;
    const host = ownerDoc.querySelector<HTMLElement>("#app") ?? ownerDoc.body;
    host.append(this.dom.root);

    view.dom.addEventListener("mousedown", this.onEditorMouseDown);
    window.addEventListener("mouseup", this.onWindowMouseUp);
    window.addEventListener("resize", this.onWindowResize);
    view.scrollDOM.addEventListener("scroll", this.onScroll);
    // 조합 종료는 **`view.dom`**(contentDOM의 부모)에서 듣는다 — CM은 자기 관측자를
    // contentDOM에 걸어 `inputState.composing`을 여기서 되돌리므로, 버블 순서상 우리가 뒤에
    // 돌아 이미 갱신된 `view.composing`을 읽게 된다(같은 이벤트에서 낡은 값을 보지 않는다).
    view.dom.addEventListener("compositionend", this.onCompositionEnd);
    // 조합 "활동"의 시각만 따로 찍는다 — 종료 통지가 유실돼도 `composing`을 언제부터
    // 믿지 않을지 판단할 수 있게([`isCompositionStale`]).
    view.dom.addEventListener("compositionstart", this.onCompositionActivity);
    view.dom.addEventListener("compositionupdate", this.onCompositionActivity);
  }

  /**
   * 트랜잭션 반영 — **레이아웃을 읽지 않는다**.
   *
   * 왜 이 제약이 절대적인가(실사용 회귀): 예전에는 여기서 [`reposition`]을 곧바로 불렀는데,
   * 그 안의 `coordsAtPos`는 업데이트 사이클 중 호출되면 CM이 던지도록 되어 있다
   * ("Reading the editor layout isn't allowed during an update"). 그리고 `ViewPlugin`의
   * `update`가 던지면 CM은 그 플러그인을 **영구 비활성화**한다(`destroy` 호출 후 인스턴스
   * 폐기 — 다시 만들지 않는다). 그래서 바가 떠 있는 동안 트랜잭션 하나(포커스 변경·플러그인
   * 확장 재구성·글자 크기 변경 등 문서도 선택도 안 바꾸는 것)만 들어와도 툴바가 그 자리에서
   * 죽고, 그 뒤로는 아무리 드래그해도 영영 뜨지 않았다("몇 번 쓰다 보면 안 뜬다"의 정체).
   *
   * 그래서 여기서는 숨김 판정(레이아웃이 필요 없다)만 하고, 재배치는 CM이 허락하는 measure
   * 단계로 예약한다([`repositionMeasure`]).
   *
   * **표시 트리거도 여기 있다** — 키보드 선택(Shift+화살표·`Mod-A` 등)에는 `mouseup` 같은
   * 종료 신호가 없어서, 선택 변경 트랜잭션이 유일한 신호다. 그래도 이 자리에서 하는 일은
   * **타이머 등록 하나**뿐이고(레이아웃을 읽지 않는다) 실제 판정은 디바운스가 끝난 뒤
   * 사이클 밖에서 돈다([`armSelectionShow`] → [`queueShow`] → [`maybeShow`]).
   *
   * try/catch는 그 위의 이중 방어다: 원인이 무엇이든 이 메서드에서 예외가 새면 툴바가
   * **영구히** 죽으므로, 어떤 실패도 CM에 넘기지 않고 이번 표시만 접는다(원인은 콘솔에 남긴다).
   */
  update(update: ViewUpdate): void {
    try {
      if (update.docChanged) {
        this.hide();
        return;
      }
      if (update.selectionSet) {
        if (update.state.selection.main.empty) {
          this.hide();
          return;
        }
        this.lastSelectionSetAt = Date.now();
        // 드래그 도중(mousedown이 아직 안 풀렸다)에는 걸지 않는다 — 마우스는 `mouseup`이
        // 정확한 종료 신호를 주므로 기존 경로가 처리한다. 여기서 함께 걸면 같은 제스처를
        // 두 경로가 각각 띄우려 든다.
        if (!this.mouseDownInEditor) this.armSelectionShow(true);
      }
      if (this.visible) this.view.requestMeasure(this.repositionMeasure);
    } catch (error) {
      console.error("[memo] 선택 툴바 갱신 실패", error);
      // 예약까지 함께 푼다 — 여기서 접어 놓고 타이머만 살려 두면, 잠시 뒤 그 타이머가 방금
      // 실패한 판정을 다시 돌려 바를 되살린다(조합 폴백 타이머의 회귀와 같은 모양).
      this.armSelectionShow(false);
      this.visible = false;
      this.dom.root.hidden = true;
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener("mousedown", this.onEditorMouseDown);
    window.removeEventListener("mouseup", this.onWindowMouseUp);
    window.removeEventListener("resize", this.onWindowResize);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("compositionend", this.onCompositionEnd);
    this.view.dom.removeEventListener(
      "compositionstart",
      this.onCompositionActivity,
    );
    this.view.dom.removeEventListener(
      "compositionupdate",
      this.onCompositionActivity,
    );
    this.armCompositionRetry(false);
    this.armSelectionShow(false);
    this.dom.root.remove();
  }

  /**
   * 에디터에서 새 제스처가 시작됐다 — **여기가 안전망이다.**
   *
   * 표시 경로가 어떤 이유로 막혔든(조합 예약이 걸린 채로 남았든, 재배치 예약이 떠 있든)
   * 새 드래그는 그 잔재를 물려받지 않아야 한다. 한 번 꼬인 상태가 다음 제스처까지 이어지면
   * 그것이 곧 "이제 아무리 드래그해도 안 뜬다"이므로, 1회성 상태는 전부 여기서 되돌린다.
   */
  private readonly onEditorMouseDown = (): void => {
    this.mouseDownInEditor = true;
    this.armCompositionRetry(false);
    // 키보드 선택 예약도 여기서 버린다 — 새 드래그가 시작된 이상 그 선택은 이미 과거다.
    // (남겨 두면 드래그 도중에 타이머가 터져 아직 만들어지는 중인 선택 위에 바가 뜬다.)
    this.armSelectionShow(false);
    this.hide();
  };

  private readonly onWindowMouseUp = (event: MouseEvent): void => {
    if (!this.mouseDownInEditor) return;
    this.mouseDownInEditor = false;
    // mouseDownInEditor는 버튼 종류와 무관하게 항상 초기화한다 — 그래야 우클릭 뒤에 오는
    // 다음 좌클릭 제스처가 이 낡은 플래그로 오작동하지 않는다. 재표시 자체는 좌클릭일 때만.
    if (!shouldHandleSelectionMouseUp(event.button)) return;
    // mouseup 직후 큐에 걸어, CM이 이 클릭으로 만든 선택을 state에 반영한 다음에 읽는다.
    this.queueShow();
  };

  /**
   * IME 조합이 끝났다 — 조합 때문에 표시를 건너뛴 제스처가 있으면 **딱 한 번** 다시 판정한다.
   *
   * 예약은 여기서 먼저 푼다(재판정 결과와 무관하게 소모된다): 그러지 않으면 조합을 여닫을
   * 때마다 같은 낡은 제스처가 계속 되살아난다. 판정 자체는 [`maybeShow`]가 그때의 상태로
   * 처음부터 다시 하므로, 선택이 이미 풀렸거나 스크롤·편집으로 숨김 규칙이 걸린 뒤라면
   * 그대로 뜨지 않는다.
   */
  private readonly onCompositionEnd = (): void => {
    if (!this.retryAfterComposition) return;
    this.armCompositionRetry(false);
    this.queueShow();
  };

  /** 조합 활동 시각을 찍는다 — [`isCompositionStale`]의 유일한 입력. */
  private readonly onCompositionActivity = (): void => {
    this.lastCompositionAt = Date.now();
  };

  /**
   * 조합 재판정 예약을 켜거나 끈다 — **켤 때는 타이머 폴백을 함께 건다.**
   *
   * 왜 이벤트만으로 부족한가: 되살아나는 유일한 신호가 `compositionend`인데, 그 이벤트가
   * 유실되는 것이 바로 이 방어가 겨냥하는 사고다(그 경우 CM의 `composing`도 영원히 참으로
   * 남는다 — 되돌리는 다른 경로가 없다). 그래서 이벤트와 **무관하게** 한 번 더 보는 타이머를
   * 함께 건다.
   *
   * 타이머 시각은 [`COMPOSITION_STALE_MS`]가 **반드시 지난 뒤**로 잡는다(마지막 조합 활동
   * 기준). 그래야 그때의 재판정이 `composing`을 낡은 값으로 판정해 확실히 표시로 끝난다 —
   * 더 이르게 잡으면 같은 이유로 또 막히고 또 예약되는 사실상의 폴링이 된다. 조합이 정말로
   * 살아 있다면 그 사이에 새 조합 이벤트가 시각을 갱신하므로, 그때는 한 번 더 미뤄지는 것이
   * 옳은 동작이다(사용자가 타이핑을 멈추면 반드시 끝난다).
   */
  private armCompositionRetry(on: boolean): void {
    if (this.compositionRetryTimer !== null) {
      clearTimeout(this.compositionRetryTimer);
      this.compositionRetryTimer = null;
    }
    this.retryAfterComposition = on;
    if (!on) return;
    const elapsed = Date.now() - this.lastCompositionAt;
    const delay =
      Math.max(0, COMPOSITION_STALE_MS - elapsed) + STALE_CHECK_SLACK_MS;
    this.compositionRetryTimer = setTimeout(() => {
      this.compositionRetryTimer = null;
      if (!this.retryAfterComposition) return;
      this.retryAfterComposition = false;
      this.queueShow();
    }, delay);
  }

  /**
   * 키보드 선택 표시 예약을 걸거나(디바운스: 이미 걸려 있으면 **다시 잰다**) 푼다.
   *
   * 왜 다시 재나: Shift+→ 연타는 선택 변경을 연달아 만든다. 매번 새로 재면 손이 멈춘 뒤
   * 딱 한 번만 판정이 돌아 바가 글자마다 튀지 않는다(예약이 쌓이지도 않는다 — 언제나 하나).
   *
   * 푸는 쪽이 더 중요하다: 이 타이머가 살아남은 채 선택이 사라지면([`hide`]가 도는 모든 경로)
   * 잠시 뒤 아무 근거 없는 자리에 바가 되살아난다 — 조합 폴백 타이머에서 한 번 겪은 회귀다.
   * 그래서 [`hide`]·[`onEditorMouseDown`]·[`destroy`]·[`maybeShow`]가 모두 여기를 거친다.
   */
  private armSelectionShow(on: boolean): void {
    if (this.selectionShowTimer !== null) {
      clearTimeout(this.selectionShowTimer);
      this.selectionShowTimer = null;
    }
    if (!on) return;
    this.selectionShowTimer = setTimeout(() => {
      this.selectionShowTimer = null;
      this.queueShow();
    }, SELECTION_SHOW_DEBOUNCE_MS);
  }

  /**
   * 표시 판정을 마이크로태스크로 미뤄 한 번 돌린다 — 이벤트 핸들러가 읽는 시점에는 CM이 이
   * 이벤트로 만든 트랜잭션(선택·조합 종료 반영)이 아직 state에 없을 수 있기 때문이다.
   */
  private queueShow(): void {
    queueMicrotask(() => {
      try {
        this.maybeShow();
      } catch (error) {
        // 이 마이크로태스크에서 새는 예외는 리스너가 아니라 **창 전역**으로 나간다 —
        // `note-window.ts`의 `installNoteErrorOverlay`가 그것을 받아 전체 화면 오류
        // 오버레이를 띄우므로, 서식 바 하나 때문에 멀쩡한 노트가 사고 화면으로 바뀐다.
        // 게다가 원인이 결정적이면(예: 스냅샷으로 들어온 이상한 등록) 그 다음 드래그도
        // 같은 자리에서 다시 죽는다. 여기서 붙잡아 **이번 표시만** 포기하고 바 상태를
        // 되돌린다 — 삼켜 숨기는 것이 아니라(console.error로 원인을 남긴다) 다음 제스처가
        // 살아 있게 하는 격리다.
        console.error("[memo] 선택 툴바 표시 실패", error);
        this.armCompositionRetry(false);
        this.armSelectionShow(false);
        this.visible = false;
        this.dom.root.hidden = true;
      }
    });
  }

  private readonly onWindowResize = (): void => {
    if (this.visible) this.reposition();
  };

  /**
   * 스크롤 — 기본은 즉시 숨김이지만, **선택이 스스로 끌고 간 스크롤**은 예외다
   * ([`isSelectionDrivenScroll`]에 근거와 한계).
   *
   * 예외 경로에서 하는 일은 두 가지다: 예약을 살려 두고(디바운스가 끝나면 그때의 좌표로
   * 판정한다), 이미 떠 있는 바는 지금 자리에 다시 붙인다. 스크롤 핸들러는 업데이트 사이클
   * 밖이라 여기서 바로 측정해도 CM의 계약을 어기지 않는다.
   */
  private readonly onScroll = (): void => {
    if (
      isSelectionDrivenScroll(
        this.selectionShowTimer !== null,
        Date.now(),
        this.lastSelectionSetAt,
      )
    ) {
      if (this.visible) this.reposition();
      return;
    }
    this.hide();
  };

  private maybeShow(): void {
    const sel = this.view.state.selection.main;
    // `view.composing`을 단독으로 믿지 않는다: 그 값을 되돌리는 경로가 `compositionend`
    // 하나뿐이라, 웹뷰가 그 이벤트를 흘리면 영영 참으로 남아 모든 드래그를 삼킨다
    // ([`isCompositionStale`]).
    const composing =
      this.view.composing &&
      !isCompositionStale(Date.now(), this.lastCompositionAt);
    const gesture: SelectionGesture = { hasSelection: !sel.empty, composing };
    if (!shouldShowSelectionToolbar(gesture)) {
      // 조합만이 걸림돌이면 조용히 버리지 않고 재판정을 예약한다 — 조합 종료 이벤트가
      // 오면 그때, 안 오면 타이머가([`armCompositionRetry`]). 한글 IME에서
      // `compositionend`가 `mouseup`보다 늦게 오거나 아예 오지 않는 웹뷰에서, 이 예약이
      // 없으면 멀쩡한 드래그가 아무 흔적 없이 사라진다.
      this.armCompositionRetry(shouldRetryAfterComposition(gesture));
      return;
    }
    this.armCompositionRetry(false);
    // 미뤄 둔 키보드 예약도 소모된 것으로 친다 — 이 판정이 그 예약이 하려던 일을 방금 했다.
    this.armSelectionShow(false);
    this.dom.buttonsRow.hidden = false;
    this.dom.linkRow.hidden = true;
    this.dom.colorRow.hidden = true;
    this.dom.linkInput.value = "";
    // 링크 버튼의 표시 여부도 **매번 여기서** 다시 판정한다 — `[여러\n줄](url)`은 유효한
    // 링크가 아니므로 선택이 다중 라인이면 숨긴다.
    this.dom.linkButton.hidden = isMultilineText(
      this.view.state.sliceDoc(sel.from, sel.to),
    );
    // 색 버튼의 표시 여부는 **매번 여기서** 다시 판정한다 — 플러그인은 런타임에 켜고 끌 수
    // 있고(스냅샷이 오면 확장이 통째로 갈아 끼워진다), 바 DOM은 한 번만 만들기 때문이다.
    this.dom.colorButton.hidden = this.colorSyntax() === null;
    this.renderSelectionActions();
    this.dom.root.hidden = false;
    this.visible = true;
    this.reposition();
  }

  /** 지금 이 에디터에 살아 있는 색 문법(「글자 색」 플러그인 등록에서 온다 — 없으면 null). */
  private colorSyntax(): ColorPatternSyntax | null {
    return this.view.state.facet(colorPatternSyntax);
  }

  /**
   * 플러그인 선택 액션 버튼들을 다시 그린다 — **표시 직전 1회**, 지금의 선택 텍스트로 판정한다.
   *
   * 판정은 창 안에서 끝난다(순수 함수 [`matchingSelectionActions`]): 샌드박스 왕복도 방송도
   * 없고, 드래그 한 번에 한 번만 돈다. 상한을 넘긴 액션은 그려지지 않지만 실행 불가능해지는
   * 것은 아니다 — 단축키 표면(「설정 › 단축키 › 플러그인 동작」)은 상한을 보지 않는다.
   *
   * 되쓰기는 여기서 하지 않는다: 액션이 본문을 바꾸려면 자기 `run` 안에서
   * `memo.editor.insertText`(notes:write)를 부른다 — 이 표면은 새 쓰기 경로를 열지 않는다.
   *
   * **코어 서식 버튼과 운명을 함께하지 않는다**: 등록부의 내용은 호스트 스냅샷을 타고 오는
   * 신뢰 경계 밖 데이터라(플러그인이 준 `label`·`match`), 그 하나가 이상해서 여기서 던지면
   * 굵게·기울임까지 통째로 사라진다 — 드래그해도 바가 안 뜨는 무음 실패가 된다. 실패는
   * 액션 자리만 비우고 콘솔에 남긴다.
   */
  private renderSelectionActions(): void {
    this.dom.actionsSlot.textContent = "";
    try {
      const { state } = this.view;
      const sel = state.selection.main;
      const text = state.sliceDoc(sel.from, sel.to);
      for (const action of matchingSelectionActions(
        liveSelectionActions(),
        text,
        SELECTION_ACTION_RENDER_LIMIT,
      )) {
        this.dom.actionsSlot.append(
          makeActionButton(action.label, action.title ?? action.label, () => {
            // 실행 시점의 선택을 다시 읽는다 — 버튼을 만든 뒤 상태가 바뀌었을 수 있고(다른
            // 경로의 트랜잭션), 그때 보내야 하는 것은 "지금" 선택된 글자다.
            const now = this.view.state.selection.main;
            try {
              action.run({
                selectedText: this.view.state.sliceDoc(now.from, now.to),
              });
            } catch (error) {
              // `run`은 플러그인 소유 코드다 — 여기서 던지면 아래 정리(바 닫기·포커스
              // 되돌리기)가 통째로 건너뛰어져 바가 선택 위에 눌러앉는다.
              console.error(
                `[memo] 선택 액션 실행 실패: ${action.pluginId}/${action.id}`,
                error,
              );
            }
            this.hide();
            this.view.focus();
          }),
        );
      }
    } catch (error) {
      console.error(
        "[memo] 선택 액션 렌더 실패 — 코어 서식 버튼만 표시합니다",
        error,
      );
      this.dom.actionsSlot.textContent = "";
    }
  }

  /**
   * 바깥(노트 창)이 접기처럼 **에디터와 무관한 이유**로 바를 접게 하는 통로 —
   * [`hideSelectionToolbar`] 참고. 내부 `hide`와 같은 정리를 한다.
   */
  forceHide(): void {
    this.hide();
  }

  private hide(): void {
    // 조합 폴백 타이머는 **visible 가드보다 앞에서** 해제한다 — 조합 차단으로 표시를 건너뛴
    // 제스처는 바가 한 번도 뜬 적이 없어(visible===false) 아래 가드에서 바로 반환되는데, 그때
    // 스크롤·문서변경 같은 숨김 경로가 이 예약을 풀지 않으면 약 1초 뒤 타이머가 혼자
    // queueShow()를 돌려, 선택과 무관한 자리에 바가 되살아난다(회귀: hide()가 no-op이라
    // armCompositionRetry(false)를 못 불러 예약이 살아남는 경우).
    this.armCompositionRetry(false);
    // 키보드 선택 디바운스도 **같은 이유로 같은 자리에서** 푼다: 아직 한 번도 뜬 적 없는
    // (visible === false) 예약이 숨김 경로를 그대로 통과해 살아남으면 결과가 똑같다.
    this.armSelectionShow(false);
    if (!this.visible) return;
    this.visible = false;
    this.dom.root.hidden = true;
  }

  /**
   * 바를 놓을 자리를 **읽기만** 한다(좌표 측정) — 놓을 데가 없으면 null.
   *
   * 읽기와 쓰기를 굳이 나눈 이유는 CodeMirror의 계약 때문이다: `coordsAtPos`는
   * `readMeasured()`를 거치는데, 그 함수는 **업데이트 사이클 중(`updateState === Updating`)
   * 호출되면 던진다**("Reading the editor layout isn't allowed during an update").
   * 그래서 측정은 CM이 허락하는 자리(`requestMeasure`의 `read`, 또는 사이클 밖의 이벤트
   * 핸들러)에서만 돌아야 하고, DOM 쓰기는 그와 분리돼야 한다([`repositionMeasure`]).
   */
  private measurePlacement(): { left: number; top: number } | null {
    const rect = this.measureSelectionRect();
    if (!rect) return null;
    const barRect = this.dom.root.getBoundingClientRect();
    return computeToolbarPosition(
      rect,
      { width: barRect.width, height: barRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
  }

  /**
   * 선택을 감쌀 화면 사각형을 잰다 — **양끝이 다 보이면** 둘을 합쳐 선택 위 한가운데에 걸고,
   * 아니면 한쪽 끝에만 건다([`selectionAnchorCandidates`]).
   *
   * 양끝을 둘 다 요구하지 않는 것이 핵심이다: CM은 화면 근처만 그리므로 긴 선택
   * (`Mod-A`·화면 밖까지 끈 드래그)에서는 한쪽 `coordsAtPos`가 `null`이고, 예전 코드는 그때
   * 놓을 자리가 없다고 보고 바를 접었다 — 사용자에게는 "전체 선택하면 서식 바가 안 뜬다"였다.
   * 후보 하나라도 좌표를 주면 그 자리에 건다(그것도 없을 때만 `null` = 접기).
   */
  private measureSelectionRect(): SelectionRect | null {
    const sel = this.view.state.selection.main;
    const from = this.view.coordsAtPos(sel.from);
    const to = this.view.coordsAtPos(sel.to);
    if (from && to) {
      return {
        left: Math.min(from.left, to.left),
        right: Math.max(from.right, to.right),
        top: Math.min(from.top, to.top),
        bottom: Math.max(from.bottom, to.bottom),
      };
    }
    for (const pos of selectionAnchorCandidates(sel, this.view.viewport)) {
      const coords = this.view.coordsAtPos(pos);
      if (coords) {
        return {
          left: coords.left,
          right: coords.right,
          top: coords.top,
          bottom: coords.bottom,
        };
      }
    }
    return null;
  }

  /**
   * 지금 바로 측정해 자리를 잡는다 — **업데이트 사이클 밖에서만** 부를 수 있다
   * (mouseup 마이크로태스크·resize·버튼 클릭 같은 사이클 밖 경로). 사이클 안에서는
   * [`repositionMeasure`]를 CM에 예약해야 한다.
   */
  private reposition(): void {
    const placement = this.measurePlacement();
    if (!placement) {
      this.hide();
      return;
    }
    this.dom.root.style.left = `${placement.left}px`;
    this.dom.root.style.top = `${placement.top}px`;
  }

  /**
   * 업데이트 사이클 안에서 쓰는 재배치 요청 — CM의 measure 단계에 얹는다.
   *
   * `read`는 `updateState === Measuring`에서 돌아 레이아웃 읽기가 허용되고, `write`는 그
   * 뒤(다시 Updating)에서 도므로 **읽기를 절대 넣지 않는다**(넣으면 같은 예외로 되돌아간다).
   * 객체를 한 번만 만들어 재사용하는 이유는 CM이 `measureRequests.indexOf(request)`로 중복
   * 예약을 걸러 주기 때문이다 — 한 프레임에 여러 트랜잭션이 와도 측정은 한 번이다.
   */
  private readonly repositionMeasure = {
    read: (): { left: number; top: number } | null => this.measurePlacement(),
    write: (placement: { left: number; top: number } | null): void => {
      if (!this.visible) return;
      if (!placement) {
        this.hide();
        return;
      }
      this.dom.root.style.left = `${placement.left}px`;
      this.dom.root.style.top = `${placement.top}px`;
    },
  };

  /**
   * 감싸기/해제 결과를 트랜잭션으로 반영하고 포커스를 에디터로 되돌린다.
   *
   * `result`가 `null`이면 무변경이다([`computeToggleWrap`]/[`computeColorApply`]가 감쌀
   * 글자가 없을 때 돌려준다) — 이때는 **dispatch 자체를 생략**한다. CodeMirror는 삽입
   * 문자열을 원문과 비교하지 않으므로, "같은 글자로 치환"하는 트랜잭션도 그대로 보내면
   * `docChanged`가 참이 되어 노트가 dirty로 표시되고(자동저장이 돈다) 되돌리기 스택에
   * 아무 일도 안 하는 단계가 쌓인다. 포커스만 에디터로 되돌려 사용자가 계속 타이핑할 수
   * 있게 한다.
   */
  private dispatchWrap(result: WrapResult | null): void {
    if (result === null) {
      this.view.focus();
      return;
    }
    const { state } = this.view;
    this.view.dispatch(
      state.update(
        {
          changes: result.changes,
          selection: EditorSelection.single(result.anchor, result.head),
        },
        { scrollIntoView: true, userEvent: "input" },
      ),
    );
    this.view.focus();
  }

  private applyMarkerToggle(before: string, after: string): void {
    const { state } = this.view;
    const { from, to } = state.selection.main;
    this.dispatchWrap(
      computeToggleWrap(state.doc.toString(), from, to, before, after),
    );
  }

  private onLinkButtonClick(): void {
    const { state } = this.view;
    const { from, to } = state.selection.main;
    // 버튼은 다중 라인 선택에서 숨어 있지만, 방어적으로 한 번 더 막는다 — 유효하지 않은
    // `[여러\n줄](url)`을 만들지 않는다(버튼이 숨겨졌는데도 클릭이 들어오는 경로가 생기면).
    if (isMultilineText(state.sliceDoc(from, to))) return;
    const toggledOff = computeLinkToggleOff(state.doc.toString(), from, to);
    if (toggledOff) {
      this.dispatchWrap(toggledOff);
      return;
    }
    this.dom.buttonsRow.hidden = true;
    this.dom.linkRow.hidden = false;
    this.dom.linkInput.value = "";
    this.reposition();
    this.dom.linkInput.focus();
  }

  private applyLink(): void {
    const url = this.dom.linkInput.value.trim();
    if (!url) {
      this.cancelLink();
      return;
    }
    const { state } = this.view;
    const { from, to } = state.selection.main;
    this.dispatchWrap(computeLinkApply(state.doc.toString(), from, to, url));
  }

  private cancelLink(): void {
    this.dom.buttonsRow.hidden = false;
    this.dom.linkRow.hidden = true;
    this.view.focus();
    if (this.visible) this.reposition();
  }

  /**
   * 팔레트 버튼 — 링크 버튼과 **같은 방식**으로 바 내용을 팔레트 줄로 갈아 끼운다(모달 없음).
   *
   * 링크와 다른 점: 링크는 "이미 링크면 벗기기"를 버튼 한 번으로 하지만, 색은 "지금 색"과
   * "다른 색"이 둘 다 흔한 선택이라 언제나 팔레트를 연다(벗기기는 그 줄의 해제 버튼이다).
   */
  private onColorButtonClick(): void {
    if (this.colorSyntax() === null) return; // 문법이 없으면 열 것도 없다(버튼도 숨어 있다).
    this.dom.buttonsRow.hidden = true;
    this.dom.linkRow.hidden = true;
    this.dom.colorRow.hidden = false;
    this.reposition();
  }

  private applyColor(color: string): void {
    const syntax = this.colorSyntax();
    if (syntax === null) return;
    const { state } = this.view;
    const { from, to } = state.selection.main;
    this.dispatchWrap(
      computeColorApply(state.doc.toString(), from, to, color, syntax),
    );
  }

  /** 해제 — 지금 선택에 색이 없으면 되쓰지 않고 버튼 줄로만 돌아간다(지울 게 없다). */
  private clearColor(): void {
    const syntax = this.colorSyntax();
    const { state } = this.view;
    const { from, to } = state.selection.main;
    const removed =
      syntax === null
        ? null
        : computeColorRemove(state.doc.toString(), from, to, syntax);
    if (removed) {
      this.dispatchWrap(removed);
      return;
    }
    this.dom.buttonsRow.hidden = false;
    this.dom.colorRow.hidden = true;
    this.view.focus();
    if (this.visible) this.reposition();
  }
}

/**
 * 선택 영역 플로팅 서식 툴바 확장의 **단일 인스턴스 스펙**.
 *
 * 모듈 전역에 한 번만 만들어 두는 이유: [`hideSelectionToolbar`]가 `view.plugin(...)`으로
 * 그 창의 인스턴스를 되짚으려면 **같은 스펙 객체**를 키로 넘겨야 한다(CodeMirror의 조회
 * 규약). `selectionToolbar()`가 호출마다 새 스펙을 만들면 키가 달라져 언제나 null이다.
 */
const selectionToolbarPlugin = ViewPlugin.fromClass(SelectionToolbarPlugin);

/** 선택 영역 플로팅 서식 툴바 확장 — `editor.ts`의 확장 목록에 그대로 추가한다. */
export function selectionToolbar(): Extension {
  return selectionToolbarPlugin;
}

/**
 * 이 에디터의 선택 툴바를 지금 접는다 — 선택·문서와 무관한 **바깥 사정**으로 바가 떠 있으면
 * 안 될 때 쓴다(노트 창 접기: 창이 헤더 높이만 남아 플로팅 레이어가 잘려 보인다).
 *
 * 바는 `position: fixed`에 #app 직속이라 에디터를 `display:none`으로 숨겨도 그대로 남고,
 * 툴바 클릭은 에디터 선택을 바꾸지 않아 자체 숨김 규칙(문서 변경·선택 해제·스크롤·에디터
 * mousedown) 중 어느 것도 걸리지 않는다. 확장이 안 얹혔거나(테스트) 이미 접혀 있으면 무해한
 * no-op이다.
 */
export function hideSelectionToolbar(view: EditorView): void {
  view.plugin(selectionToolbarPlugin)?.forceHide();
}
