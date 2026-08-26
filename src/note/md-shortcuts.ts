/**
 * 마크다운 편집 단축키 (⌘B 굵게 · ⌘I 기울임 · ⌘K 링크 · Tab/⇧Tab 들여쓰기).
 *
 * 역할: 선택 영역을 마크다운 마커로 감싸는 키 바인딩 + 줄 들여쓰기/내어쓰기를 제공한다.
 * 왜: 본문이 순수 마크다운이므로 서식은 마커 삽입으로 처리하며, 감싸기 로직을
 * 순수 함수로 분리해 테스트 가능하게 한다. 들여쓰기는 CM 표준 `indentWithTab`(줄 단위
 * indentMore/Less)을 그대로 써 리스트 중첩·일반 들여쓰기를 일관 처리한다(들여쓰기 폭은
 * editor.ts의 `indentUnit` 설정을 따른다).
 *
 * 다중 라인 선택: `**`·`*`·`` ` ``·`~~`·`==` 같은 마크다운 인라인 마커는 줄을 넘어 매치되지
 * 않는다(라이브 프리뷰도, 렌더러도 그렇게 파싱한다). 그래서 선택이 여러 줄에 걸치면
 * [`wrapRange`]가 한 덩어리로 감싸는 대신 [`nonBlankLines`]로 줄별 조각을 뽑아 조각마다
 * 따로 감싼다(빈 줄/공백만 있는 줄은 건드리지 않는다) — `selection-toolbar.ts`의
 * `computeToggleWrap`·색 적용도 같은 [`nonBlankLines`]를 절대 위치 버전으로 써서 이 규칙을
 * 공유한다.
 *
 * 그 줄 조각은 **줄 머리의 구조 문법 뒤에서** 시작한다([`structuralPrefixLength`]) — 불릿·
 * 체크박스·헤딩·인용을 인라인 마커나 색 감싸기 안에 넣으면 그 줄의 **블록 구조가 사라지기**
 * 때문이다. 색 칠하기(`color-segments.ts`)도 같은 함수를 써서 칠할 범위의 시작을 접두 뒤로
 * 민다 — 두 경로가 한 규칙을 공유한다.
 *
 * 다만 그 규칙은 **진짜 줄 머리에서만** 적용한다. 다중 라인 선택의 첫 조각은 줄 중간에서
 * 시작할 수 있는데([`nonBlankLines`]의 `firstLineAtLineStart`), 그 자리가 우연히 `- `·`> `
 * 같은 구조 마커 모양이어도(`가격은 100원 - 200원`에서 `- 200원`부터 드래그) 그건 줄 머리가
 * 아니라 본문 글자이므로 접두로 오판하면 안 된다 — 호출부(`wrapCommand`)가 CM의
 * `doc.lineAt(from).from === from`으로 그 여부를 판정해 넘긴다.
 */
import { indentWithTab } from "@codemirror/commands";
import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";

/** 텍스트가 둘 이상의 줄에 걸쳐 있는지(줄바꿈 `\n`·`\r\n`·`\r`을 포함하는지). */
export function isMultilineText(text: string): boolean {
  return /\r\n|\r|\n/.test(text);
}

/**
 * [`nonBlankLines`]가 뽑아낸 한 줄 조각 — 원본 텍스트 기준 상대 오프셋으로 표현한다.
 *
 * 모듈 밖에서 쓰이지 않는다(`selection-toolbar.ts`는 `nonBlankLines` 함수만 절대 위치
 * 버전으로 다시 구현해 쓰고 이 타입은 가져오지 않는다) — 그래서 export하지 않는다(knip:
 * unused exported type). 타입 자체는 [`nonBlankLines`]의 반환형 문서화를 위해 로컬로 유지한다.
 */
interface NonBlankLine {
  /**
   * 조각을 담은 원본 텍스트에서 이 줄의 core가 시작하는 오프셋 — 앞쪽 공백과 줄 머리의
   * 구조 문법([`structuralPrefixLength`])을 건너뛴 위치다.
   */
  offset: number;
  /** 구조 접두와 앞뒤 공백을 뺀 그 줄의 내용. */
  core: string;
}

/** 인용 `>`(뒤따르는 공백까지) — 중첩(`> > `)은 반복해서 먹는다. */
const QUOTE_MARKER = /^>[ \t]*/;
/** 불릿·순서 목록 + 뒤따르는 태스크 체크박스(`- [ ] `는 통짜로 하나의 접두다). */
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
/** ATX 헤딩 `#`~`######` + 공백. */
const HEADING_MARKER = /^#{1,6}[ \t]+/;

/**
 * 줄 머리의 **마크다운 구조 문법**(들여쓰기 + 인용·불릿·번호·체크박스·헤딩)이 차지하는
 * 길이를 잰다(순수) — 줄 단위 감싸기·칠하기가 **절대 안으로 삼키면 안 되는** 머리다.
 *
 * 왜 필요한가(실사용 회귀): 여러 줄을 드래그해 색을 칠했더니 줄이 통째로 조각이 되어
 * `{{- 항목|#3a5}}`처럼 **불릿까지 감싸기 안에** 들어갔다. 그러면 줄이 `{{`로 시작하므로
 * 마크다운이 그 줄을 목록으로 보지 않는다 — 인라인 서식을 주려다 **블록 구조를 잃는다**
 * (헤딩·인용도 같다). 인라인 문법은 줄 안에서만 의미가 있으니 접두 **뒤**부터 감싸는 것이
 * 언제나 옳고, 선택이 접두 중간에서 시작했더라도 마찬가지다.
 *
 * 규칙: 선행 들여쓰기(공백·탭 — 4칸이 코드 블록을 만드는 등 그 자체가 구조다)를 먼저 건너뛰고,
 * 인용·목록 마커는 조합·중첩(`> - [ ] `)이 실제로 있으므로 **반복해서** 먹는다. 헤딩은 한 번만
 * 먹고 멈춘다(`# # 제목`의 두 번째 `#`는 본문 글자다). 마커 뒤의 공백까지 함께 먹는다 —
 * 감싸기가 공백에서 시작하면 마커로 인정하지 않는 렌더러가 있다.
 */
export function structuralPrefixLength(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  for (;;) {
    const rest = line.slice(i);
    const heading = HEADING_MARKER.exec(rest);
    if (heading !== null) return i + heading[0].length;
    const marker = QUOTE_MARKER.exec(rest) ?? LIST_MARKER.exec(rest);
    if (marker === null) return i;
    i += marker[0].length;
  }
}

/**
 * **단일 라인** 선택에서 감싸기가 시작할 위치를 고른다(순수) — 선택이 줄 머리의 구조 문법을
 * 물고 시작하면 그 뒤로 민다. `lineFrom`/`lineText`는 `from`이 놓인 줄이다.
 *
 * 왜 "판정을 고치지 않고 범위만 좁히나": 마커가 이미 있는지 보는 단일 라인 판정
 * (`selection-toolbar.ts`의 통짜/바깥 두 분기와 `markerBoundaryMatches`)은 `*`와 `**`를
 * 혼동하지 않으려고 경계의 연속 길이까지 세는 섬세한 코드이고, 그 미세 조정마다 회귀가 났던
 * 자리다. 접두 예외를 그 안에 끼워 넣는 대신 **들어가기 전에 범위를 좁혀** 넘기면, 판정은 손대지
 * 않은 채로 "접두 뒤 조각"에 대해 그대로 돈다 — 다중 라인이 [`nonBlankLines`]로 조각을 좁혀
 * 넘기는 것과 정확히 같은 방식이다(그래서 두 갈래의 결과가 어긋나지 않는다).
 *
 * 빈 선택(`to <= from`)은 그대로 둔다 — 커서 자리에 마커만 넣는 기존 동작이다. 선택이 접두
 * 안에서만 놀았으면 `to`가 나오고(감쌀 글자가 없다), 호출부는 그걸 무변경으로 읽는다.
 */
export function contentStart(
  from: number,
  to: number,
  lineFrom: number,
  lineText: string,
): number {
  if (to <= from) return from;
  const prefixEnd = lineFrom + structuralPrefixLength(lineText);
  return Math.min(Math.max(from, prefixEnd), to);
}

/**
 * 텍스트를 줄바꿈 기준으로 쪼개, 감쌀 내용이 있는(=빈 줄도, 공백·구조 문법만 있는 줄도 아닌)
 * 조각만 상대 오프셋과 함께 돌려준다(순수).
 *
 * 조각은 줄 머리의 **구조 문법 뒤**(들여쓰기·불릿·체크박스·헤딩·인용 —
 * [`structuralPrefixLength`])에서 시작하고 뒤쪽 공백도 뺀다: 마커를 공백 안쪽에만 씌워야
 * 렌더가 깨지지 않고(`**abc **`처럼 마커 안에 공백이 걸치면 일부 렌더러가 마커로 인정하지
 * 않는다), 구조 문법을 안으로 삼키면 그 줄의 블록 구조 자체가 사라지기 때문이다.
 * 남는 내용이 없는 줄(빈 줄·공백만·`- `만 있는 줄)은 결과에서 아예 빠진다 — 호출부가 그 줄을
 * 건드리지 않고 그대로 두면 `****` 같은 마커만 남는 줄이 생기지 않는다.
 *
 * `firstLineAtLineStart`(기본 `true`)는 **첫 조각만** 다르게 다룬다: `text`가 다중 라인
 * 선택에서 뽑은 부분 문자열일 때, 그 선택이 줄 중간에서 시작했다면 첫 조각은 실제 줄 머리가
 * 아니다(두 번째 조각부터는 줄바꿈 뒤이므로 언제나 진짜 줄 머리다 — 이 인자가 필요 없다).
 *
 * 왜 필요한가(회귀): 첫 조각이 줄 중간에서 시작했는데도 우연히 `- `·`> `·`# ` 같은 구조
 * 마커 모양으로 시작하면(예: `가격은 100원 - 200원`에서 `- 200원`부터 드래그), 그 글자가
 * 실제로는 본문(마이너스 기호)인데 [`structuralPrefixLength`]가 줄 머리 마커로 오판해
 * 감싸기/색칠 대상에서 빼먹는다. 그래서 첫 조각이 진짜 줄 머리가 **아닐 때는**
 * `structuralPrefixLength`를 아예 적용하지 않고 앞뒤 공백만 다듬는다 — 두 번째 줄부터는
 * 언제나 `\n` 직후이므로 이 예외가 미치지 않는다.
 */
export function nonBlankLines(
  text: string,
  firstLineAtLineStart = true,
): NonBlankLine[] {
  const result: NonBlankLine[] = [];
  let offset = 0;
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      // 첫 조각(i===0)이 아니면 언제나 줄바꿈 직후라 진짜 줄 머리다. 첫 조각은 호출부가 준
      // firstLineAtLineStart를 따른다 — 줄 중간에서 시작했다면 구조 접두를 아예 보지 않는다.
      const atLineStart = i === 0 ? firstLineAtLineStart : true;
      const prefixLen = atLineStart ? structuralPrefixLength(part) : 0;
      // 접두를 먼저 떼고(공백·탭·구조 마커), 남은 부분의 앞뒤 공백은 예전처럼 다시 다듬는다
      // — 접두 판정이 보지 않는 공백(예: NBSP)도 마커 안에 걸치지 않게 하기 위함이다.
      const rest = part.slice(prefixLen);
      const core = rest.trim();
      if (core !== "") {
        const skip =
          part.length - rest.length + (rest.length - rest.trimStart().length);
        result.push({ offset: offset + skip, core });
      }
    }
    offset += part.length;
  }
  return result;
}

/** 한 선택 범위를 `before`/`after`로 감쌌을 때의 변경 + 새 선택을 계산한다(순수).
 *
 * 선택이 한 줄이면 통짜로 감싸고(기존 동작 그대로), 여러 줄에 걸치면 [`nonBlankLines`]로 줄별
 * 조각을 뽑아 조각마다 따로 감싼다 — 인라인 마커는 줄을 넘어 매치되지 않으므로 통짜로 감싸면
 * 렌더되지 않는다. 다중 라인 결과의 선택은 감싼 전체 블록을 자연스럽게 커버한다(단일 라인처럼
 * "안쪽 텍스트만" 선택하지 않는다 — 조각이 여러 개라 하나의 "안쪽"이 없다).
 *
 * `firstLineAtLineStart`(기본 `true`)는 그대로 [`nonBlankLines`]에 전달된다 — `inner`의 첫
 * 줄이 문서에서 진짜 줄 머리가 아니면(선택이 줄 중간에서 시작한 다중 라인 드래그의 첫 조각)
 * 호출부가 `false`를 넘겨, 그 조각의 머리를 구조 마커로 오판하지 않게 한다.
 */
export function wrapRange(
  from: number,
  to: number,
  inner: string,
  before: string,
  after: string,
  firstLineAtLineStart = true,
): { changes: ChangeSpec; anchor: number; head: number } {
  if (!isMultilineText(inner)) {
    const insert = `${before}${inner}${after}`;
    return {
      changes: { from, to, insert },
      anchor: from + before.length,
      head: from + before.length + inner.length,
    };
  }

  let insert = "";
  let cursor = 0;
  for (const line of nonBlankLines(inner, firstLineAtLineStart)) {
    insert += inner.slice(cursor, line.offset);
    insert += `${before}${line.core}${after}`;
    cursor = line.offset + line.core.length;
  }
  insert += inner.slice(cursor);

  return {
    changes: { from, to, insert },
    anchor: from,
    head: from + insert.length,
  };
}

/**
 * 선택 영역을 마커로 감싸는 에디터 커맨드를 만든다.
 *
 * `selection-toolbar.ts`(선택 영역 플로팅 툴바)는 같은 감싸기 계산을 이 함수가 아니라
 * [`wrapRange`]를 직접 불러 공유한다(툴바는 여기에 토글-해제를 얹어 쓴다) — 이 함수 자체는
 * `markdownShortcuts` 키 바인딩 조립에만 쓰여 모듈 밖으로 내보내지 않는다.
 *
 * `skipMultiline`(기본 false)은 링크(⌘K) 전용 예외다 — `[여러\n줄](url)`은 링크로 파싱되지
 * 않으므로(라벨에 줄바꿈을 못 담는다), 다중 라인 선택 범위에서는 아무 것도 하지 않고 그 선택을
 * 그대로 둔다(선택 툴바의 링크 버튼을 다중 라인에서 숨기는 것과 같은 예외 처리).
 *
 * 단일 라인 선택은 [`contentStart`]로 시작 위치를 한 번 좁혀 넘긴다 — 줄 전체를 잡아 ⌘B를
 * 눌러도(트리플 클릭) 불릿·헤딩·인용은 마커 밖에 남는다. 여러 줄 선택은 [`wrapRange`]가
 * 줄 조각마다 같은 규칙을 이미 적용하므로 그대로 넘긴다.
 */
function wrapCommand(before: string, after: string, skipMultiline = false) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      if (skipMultiline && isMultilineText(selected)) {
        return { range };
      }
      const line = state.doc.lineAt(range.from);
      const from = isMultilineText(selected)
        ? range.from
        : contentStart(range.from, range.to, line.from, line.text);
      // 선택이 구조 접두 안에서만 놀았다 — 감쌀 글자가 없으므로 그대로 둔다.
      if (range.to > range.from && from >= range.to) return { range };
      // 다중 라인일 때만 의미가 있다(단일 라인은 이미 contentStart로 접두 뒤로 좁혀 왔다) —
      // 그 줄이 진짜 줄 머리에서 시작하는지를 nonBlankLines의 첫 조각 판정에 넘긴다.
      const { changes, anchor, head } = wrapRange(
        from,
        range.to,
        state.sliceDoc(from, range.to),
        before,
        after,
        line.from === from,
      );
      return { changes, range: EditorSelection.range(anchor, head) };
    });
    view.dispatch(
      state.update(tr, { scrollIntoView: true, userEvent: "input" }),
    );
    return true;
  };
}

/** ⌘B/⌘I/⌘K 편집 단축키 + Tab/⇧Tab 줄 들여쓰기·내어쓰기. */
export const markdownShortcuts: readonly KeyBinding[] = [
  { key: "Mod-b", run: wrapCommand("**", "**") },
  { key: "Mod-i", run: wrapCommand("*", "*") },
  { key: "Mod-k", run: wrapCommand("[", "](url)", true) },
  // Tab=indentMore, Shift-Tab=indentLess (CM 표준). 리스트 라인에선 중첩 증가/감소로 동작.
  indentWithTab,
];
