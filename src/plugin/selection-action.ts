/**
 * 선택 액션(`ui.addSelectionAction`)의 **닫힌 어휘와 로컬 판정** — 순수 계산 + 창 로컬 등록부.
 *
 * 역할: 세 가지를 한 곳에 둔다.
 * 1. `match`(표시 조건)의 **어휘**([`SELECTION_CHAR_CLASSES`])와 그 문자 집합(순수 함수).
 * 2. 신뢰할 수 없는 등록 인자에서 `match`를 검증해 뽑는 파서([`parseSelectionMatch`]) —
 *    중앙 호스트가 등록 시점에 쓴다.
 * 3. 그 판정을 **창 안에서 로컬로** 수행하는 술어([`selectionMatches`])와, 이 창에 살아 있는
 *    선택 액션 목록의 등록부([`setSelectionActions`]/[`liveSelectionActions`]).
 *
 * 왜 정규식이 아니라 닫힌 어휘인가: 인라인 패턴의 구분자가 리터럴만 받는 것과 같은 이유다 —
 * 플러그인이 준 정규식을 호스트가 사용자 텍스트에 돌리면 ReDoS가 열리고, 저작자가 지어낸
 * 패턴이 아무것도 매치하지 못하는 무음 실패도 생긴다. 어휘 밖 값은 등록 시점에 `INVALID_ARGS`다.
 *
 * 왜 창 안에서 판정하나: 표시 조건은 **선택이 만들어진 순간**(드래그는 mouseup, 키보드는
 * 디바운스가 끝난 뒤) 필요하다. 그때마다
 * 샌드박스로 왕복하거나 방송을 내면 고빈도 이벤트를 여는 것과 같아진다(`authoring-for-ai.md`의
 * 「고빈도 이벤트 금지」). 어휘가 닫혀 있으므로 판정에 필요한 것은 전부 스냅샷에 실려 오고,
 * 창은 왕복 0·방송 0으로 스스로 답한다.
 *
 * 왜 등록부가 facet이 아니라 모듈 변수인가: 플러그인 CM 확장은 **라이브 프리뷰가 꺼지면 통째로
 * 빠진다**(`editor.ts`의 `pluginC.reconfigure(previewOn ? ext : [])`). 선택 액션을 그 확장에
 * 실으면 프리뷰를 끈 사용자에게는 버튼도 단축키도 조용히 사라진다 — 선택 액션은 렌더가 아니라
 * 사용자 동작이라 프리뷰 상태와 무관해야 한다. 창 하나에 에디터 하나라는 사실은 이미
 * `editor.ts`의 `mountedView`가 같은 방식으로 쓰고 있다(같은 선례·같은 이유).
 */

/**
 * `match.charClasses`가 쓸 수 있는 **문자 부류 전수**(닫힌 열거).
 *
 * 부류들은 서로 배타적이지 **않다**(예: `.`는 `operator`이자 `punctuation`이다) — 판정은
 * "선택의 모든 글자가 고른 부류 중 **적어도 하나**에 속하는가"라, 겹침은 무해하고 오히려
 * 저작자가 필요한 만큼만 고르게 한다.
 */
export const SELECTION_CHAR_CLASSES: readonly string[] = [
  "digit",
  "operator",
  "space",
  "latin",
  "hangul",
  "punctuation",
];

/** `operator` 부류의 문자 집합 — 산술식 한 줄을 그대로 통과시키는 기호들. */
const OPERATOR_CHARS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "=",
  "<",
  ">",
  "(",
  ")",
  ".",
  ",",
]);

/** 한글 — 음절(가–힣)·자모(초·중·종성)·호환 자모(ㄱ·ㅏ). */
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏ꥠ-꥿]/;

/** 유니코드 문장부호(`\p{P}`) — 여는·닫는 따옴표, 「」, — 같은 비ASCII도 포함한다. */
const PUNCTUATION_RE = /\p{P}/u;

/**
 * 글자 하나가 부류에 속하는지 판정한다(순수, 테스트용).
 *
 * 각 부류의 문자 집합은 여기 **한 곳에만** 있다 — 문서·검증·판정이 같은 함수를 보게 해
 * "문서엔 있는데 실제로는 안 통과하는" 어긋남을 구조적으로 막는다. 모르는 부류 이름은
 * 거짓이다(파서가 이미 거부하므로 도달하지 않는 방어선).
 */
export function charInClass(charClass: string, ch: string): boolean {
  switch (charClass) {
    case "digit":
      return ch >= "0" && ch <= "9";
    case "operator":
      return OPERATOR_CHARS.has(ch);
    case "space":
      // 줄바꿈도 공백이다 — 「한 줄인가」는 `singleLine`이 따로 보는 축이라 여기서 겹치지 않는다.
      return /\s/.test(ch);
    case "latin":
      return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
    case "hangul":
      return HANGUL_RE.test(ch);
    case "punctuation":
      return PUNCTUATION_RE.test(ch);
    default:
      return false;
  }
}

/** 검증을 통과한 `match` — 스냅샷에 그대로 실려 창의 로컬 판정에 쓰인다. */
export interface SelectionMatch {
  /** 고른 문자 부류들(비었으면 문자 검사를 하지 않는다). */
  charClasses?: string[];
  /** 참이면 줄바꿈이 든 선택에서는 표시하지 않는다. */
  singleLine?: boolean;
  /** 선택 글자 수 상한(넘으면 표시하지 않는다). */
  maxLength?: number;
}

/** [`parseSelectionMatch`]의 결과 — 실패는 **어느 필드가 왜**인지를 담는다. */
type SelectionMatchResult =
  | { ok: true; match: SelectionMatch | undefined }
  | { ok: false; reason: string };

/**
 * 신뢰할 수 없는 등록 인자에서 `match`를 검증해 뽑는다(순수, 테스트용).
 *
 * `undefined`(생략)는 성공이고 값이 없다 — "선택이 있으면 언제나 표시"라는 뜻이다. 그 밖의
 * 모든 어긋남은 조용한 폐기가 아니라 **거부**다: 어휘 밖 부류 이름을 버리면 저작자는 조건이
 * 넓어진(=아무 선택에서나 뜨는) 버튼을 보게 되고, 그것은 오타를 알려주지 않는 무음 실패다.
 */
export function parseSelectionMatch(raw: unknown): SelectionMatchResult {
  if (raw === undefined || raw === null) return { ok: true, match: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "match는 객체여야 합니다" };
  }
  const src = raw as Record<string, unknown>;
  const match: SelectionMatch = {};

  if (src.charClasses !== undefined) {
    if (!Array.isArray(src.charClasses)) {
      return {
        ok: false,
        reason: `match.charClasses는 배열이어야 합니다(가능한 값: ${SELECTION_CHAR_CLASSES.join(", ")})`,
      };
    }
    const classes: string[] = [];
    for (const value of src.charClasses) {
      if (
        typeof value !== "string" ||
        !SELECTION_CHAR_CLASSES.includes(value)
      ) {
        return {
          ok: false,
          reason: `match.charClasses에 모르는 부류가 있습니다: ${String(value)} (가능한 값: ${SELECTION_CHAR_CLASSES.join(", ")})`,
        };
      }
      if (!classes.includes(value)) classes.push(value);
    }
    // 빈 배열은 "아무 글자도 허용하지 않는다"로 읽히기 쉽지만 실제로는 검사를 끄는 값이 된다 —
    // 그 모호함을 남기지 않고 거부한다(생략하면 검사가 없다는 뜻이 이미 있다).
    if (classes.length === 0) {
      return {
        ok: false,
        reason:
          "match.charClasses가 비어 있습니다(문자 검사를 하지 않으려면 아예 생략하세요)",
      };
    }
    match.charClasses = classes;
  }

  if (src.singleLine !== undefined) {
    if (typeof src.singleLine !== "boolean") {
      return { ok: false, reason: "match.singleLine은 boolean이어야 합니다" };
    }
    if (src.singleLine) match.singleLine = true;
  }

  if (src.maxLength !== undefined) {
    if (typeof src.maxLength !== "number" || !Number.isInteger(src.maxLength)) {
      return { ok: false, reason: "match.maxLength는 정수여야 합니다" };
    }
    if (src.maxLength < 1) {
      return {
        ok: false,
        reason:
          "match.maxLength는 1 이상이어야 합니다(0 이하면 어떤 선택도 통과하지 못합니다)",
      };
    }
    match.maxLength = src.maxLength;
  }

  // 아무 조건도 남지 않았으면 `match`를 준 적 없는 것과 같다 — 스냅샷에 빈 객체를 싣지 않는다.
  return {
    ok: true,
    match: Object.keys(match).length > 0 ? match : undefined,
  };
}

/**
 * 이 선택 텍스트가 `match`를 만족하는지 판정한다(순수, 테스트용).
 *
 * 규칙(전부 AND): (1) `maxLength`가 있으면 글자 수가 그 이하, (2) `singleLine`이면 줄바꿈이
 * 없음, (3) `charClasses`가 있으면 **모든 글자**가 그중 한 부류 이상에 속함. `match`가 없으면
 * 언제나 참이다(선택만 있으면 표시).
 *
 * 빈 선택은 언제나 거짓이다 — 두 표면(툴바·단축키)의 공통 전제가 "선택이 있다"라, 그 전제를
 * 호출부마다 다시 적으면 한쪽만 빠뜨리는 어긋남이 생긴다.
 *
 * 길이 검사를 문자 검사보다 **먼저** 하는 이유는 비용이다: 상한이 있는 액션은 긴 선택에서
 * 글자 순회 없이 즉시 거짓이 된다(판정은 선택 한 번마다 한 번 도는 자리다).
 */
export function selectionMatches(
  text: string,
  match: SelectionMatch | undefined,
): boolean {
  if (text === "") return false;
  if (!match) return true;
  // 코드 포인트 기준으로 센다 — 이모지·서로게이트 쌍이 두 글자로 세어져 상한을 조기에 넘기지
  // 않게(문자 순회도 같은 단위라 두 검사의 "글자"가 어긋나지 않는다).
  const chars = [...text];
  if (match.maxLength !== undefined && chars.length > match.maxLength) {
    return false;
  }
  if (match.singleLine === true && /[\n\r]/.test(text)) return false;
  const classes = match.charClasses;
  if (classes && classes.length > 0) {
    for (const ch of chars) {
      if (!classes.some((c) => charInClass(c, ch))) return false;
    }
  }
  return true;
}

/**
 * 이 창에서 실행 가능한 선택 액션 1건 — 스냅샷 조각 + **이미 배선된** 실행 함수.
 *
 * `run`은 호스트 역호출 방송을 낸다(`host-client.ts`가 버튼·메뉴 항목과 같은 채널로 묶어
 * 준다). 선택 텍스트를 실을지 말지는 그 클로저가 등록 시점의 `notes:read` 판정으로 이미
 * 정해 두므로, 두 표면(툴바·단축키)은 **선택 텍스트를 그냥 넘기기만** 하면 된다 — 권한 게이트를
 * 표면마다 다시 적지 않는다(한쪽만 빠뜨리면 그것이 곧 본문 유출이다).
 */
export interface SelectionActionItem {
  /** 이 액션의 소유 플러그인 id. */
  pluginId: string;
  /** 저작자가 준(또는 호스트가 만든) 안정 id — 단축키 바인딩이 붙는 영속 키. */
  id: string;
  /** 버튼에 보일 글자/이모지. */
  label: string;
  /** 툴팁·단축키 목록 이름(없으면 `label`을 쓴다). */
  title?: string;
  /** 표시 조건(없으면 선택이 있을 때 언제나 표시). */
  match?: SelectionMatch;
  /** 실행 — 선택 텍스트를 넘기면 권한이 허락할 때만 `payload.selectedText`로 전달된다. */
  run(payload: { selectedText: string }): void;
}

/**
 * 선택 툴바가 한 번에 그리는 액션 버튼의 상한.
 *
 * 왜 상한이 있나: 플로팅 바는 선택 근처에 뜨는 좁은 줄이고, 서식 버튼 6개가 이미 자리를
 * 쓰고 있다. 상한이 없으면 액션을 많이 등록한 사용자의 바가 화면 폭을 넘어 접힌다.
 * 넘친 액션이 **실행 불가능해지는 것은 아니다** — 단축키 표면은 상한을 보지 않는다.
 */
export const SELECTION_ACTION_RENDER_LIMIT = 5;

/** 이 창(모듈 인스턴스)에 살아 있는 선택 액션 — 스냅샷이 올 때마다 통째로 갈린다. */
let liveActions: readonly SelectionActionItem[] = [];

/**
 * 이 창의 선택 액션 목록을 통째로 갈아 끼운다(노트 창 부트스트랩이 스냅샷마다 부른다).
 *
 * 통째로 가는 이유는 스냅샷의 계약과 같다: 스냅샷은 관측 시점의 **불변 값**이라, 부분 갱신을
 * 허용하면 꺼진 플러그인의 액션이 남는다.
 */
export function setSelectionActions(
  actions: readonly SelectionActionItem[],
): void {
  liveActions = actions;
}

/** 이 창에 살아 있는 선택 액션 전부(스냅샷이 아직 없으면 빈 배열). */
export function liveSelectionActions(): readonly SelectionActionItem[] {
  return liveActions;
}

/**
 * 이 선택 텍스트에서 실제로 표시·실행할 액션만 고른다(순수, 테스트용).
 *
 * `limit`을 주면 앞에서부터 그만큼만 남긴다(툴바는 상한을 주고, 단축키 경로는 주지 않는다 —
 * 바에 자리가 없다는 것과 실행할 수 없다는 것은 다른 이야기다).
 */
export function matchingSelectionActions(
  actions: readonly SelectionActionItem[],
  text: string,
  limit?: number,
): SelectionActionItem[] {
  const hits = actions.filter((a) => selectionMatches(text, a.match));
  return limit === undefined ? hits : hits.slice(0, limit);
}
