/**
 * 구조화 에디터 확장 API — 디스크립터를 CM6 확장으로 인스턴스화한다.
 *
 * 역할: 플러그인이 (브리지로) 등록한 "인라인 링크 패턴"·"자동완성" 디스크립터를 받아
 * CodeMirror 확장(데코레이션 + 클릭 + 자동완성)으로 만든다. 데이터 접근(노트 제목·소환)은
 * 플러그인이 아니라 호스트 서비스가 수행한다(권한은 호스트가 이미 검사).
 * 왜: 에디터에 raw JS를 주입하지 않고 직렬화 디스크립터로만 확장해 보안을 실질화한다.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { Facet, type Extension, type Range } from "@codemirror/state";
import {
  autocompletion,
  startCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { blockEmbedField, type BlockEmbedDescriptor } from "./embed";
import {
  patternParamRegexSource,
  renderParamStyleDeclaration,
  PATTERN_PARAM_APPLY_PROPS,
  PATTERN_PARAM_FORMATS,
  type InlineStyle,
} from "./inline-style";

/**
 * 인라인 링크 패턴 디스크립터(예: 위키링크 `[[제목]]`).
 *
 * 플러그인은 raw 정규식이 아니라 구조화된 구분자(open[/mid]/close)만 준다 — 호스트가 구분자를
 * 리터럴로 이스케이프해 안전한 매처를 만든다(ReDoS·잘못된 정규식 원천 차단). `className`은
 * 플러그인이 아니라 호스트가 `cm-x-<plugin>-<pattern>`으로 파생한다([`./inline-style`]) —
 * 스타일도 여기서 온다(구조화 화이트리스트, 셀렉터 하이재킹 불가).
 */
export interface InlinePatternDescriptor {
  id: string;
  open: string;
  /**
   * 중간 구분자(선택) — 주면 **세 토막** 패턴이 된다: `open`…`mid`…`close`, 캡처 둘.
   *
   * 왜 필요한가: `[텍스트](url)`처럼 "보여 줄 글자"와 "클릭 대상"이 **다른 토막**에 있는
   * 모양은 두 토막(open…close)으로 표현할 수 없다. 여기서도 플러그인은 정규식이 아니라
   * 리터럴만 주고 호스트가 이스케이프해 조립하므로 ReDoS 표면은 그대로 없다.
   */
  mid?: string;
  close: string;
  /**
   * 파라미터화 꼬리(선택) — `close` **바로 앞**에 `prefix` + 형식이 정해진 값 하나를 더 둔다.
   *
   * 왜 필요한가: 등록 하나당 스타일이 고정 하나라, "값에 따라 달라지는 스타일"(`{{글자|#f36}}`의
   * 글자 색)은 **값마다 등록을 하나씩** 만드는 수밖에 없었다 — 그래서 임의의 색은 표현할 수
   * 없었고(팔레트에 있는 색만), 6자리 hex는 구분자 8자 상한(`|#rrggbb}}`=10자)에도 걸렸다.
   * 값을 구분자가 아니라 **캡처**로 빼면 등록 하나로 임의 값이 열린다.
   *
   * 값은 문서 본문에서 오는 신뢰 못 할 문자열이므로 저작자는 정규식이 아니라 **형식 이름**만
   * 고르고(호스트가 정규식·검증기를 소유 — [`./inline-style`]의 `PARAM_FORMATS`), 반영 대상도
   * 색 속성 화이트리스트로 좁힌다. 임의 CSS 주입·ReDoS 표면이 둘 다 없다.
   */
  param?: InlinePatternParam;
  /** 호스트 파생 네임스페이스 클래스(데코레이션 + 주입 CSS 공유). */
  className: string;
  /** 화면에 남길 토막(기본 `"first"`). `"second"`는 `mid`가 있을 때만 뜻이 있다. */
  label?: PatternPart;
  /** 클릭 대상으로 쓸 토막(기본: `mid`가 있으면 `"second"`, 없으면 `"first"`). */
  target?: PatternPart;
  /**
   * 클릭 동작(기본 `"open-note"` — 이 API의 원래 동작).
   *
   * `"none"`이면 링크 표식(`cm-plugin-link`·`data-*`)을 아예 달지 않는다. 권한이 없어
   * 수행할 수 없는 동작은 노트 창이 스냅샷을 소비할 때 `"none"`으로 낮춘다
   * ([`../plugin/host-client`]) — 눌러도 아무 일이 없는 가짜 링크를 만들지 않기 위함이다.
   */
  action?: PatternAction;
  /** 검증된 인라인 스타일(선택 — 노트 창이 `.className` 규칙으로 주입). */
  style?: InlineStyle;
  /** 검증된 호버 스타일(선택 — `.className:hover` 규칙으로 주입). */
  styleHover?: InlineStyle;
}

/**
 * 인라인 패턴의 파라미터화 꼬리 — `close` 앞의 `prefix` + 형식 검증된 값 하나.
 *
 * 매칭 모양: `open` … [`mid` …] `prefix` <값> `close`. 값은 캡처만 되고 화면에는 남지 않는다
 * (구분자와 함께 숨는다) — 화면에 남는 토막은 지금처럼 `label`이 고른다.
 */
export interface InlinePatternParam {
  /** 값 앞에 오는 리터럴 구분자(예: `"|"`) — open/close와 같은 규칙(1~8자, 줄바꿈 불가). */
  prefix: string;
  /** 값 형식(닫힌 어휘 — [`./inline-style`]의 `PATTERN_PARAM_FORMATS`). */
  format: string;
  /**
   * 캡처값을 반영할 스타일 속성(선택, camelCase — 색 속성만). 생략하면 값은 매칭을 좁히기만
   * 하고 스타일에는 관여하지 않는다.
   */
  apply?: string;
}

/** 패턴에서 캡처된 토막의 이름 — 두 토막이면 `"first"` 하나뿐이다. */
export type PatternPart = "first" | "second";

/** 인라인 패턴 클릭 동작의 닫힌 어휘. */
export type PatternAction = "open-note" | "open-url" | "none";

/** 클릭 동작 어휘(런타임 검증·계약 생성이 함께 쓰는 단일 출처). */
export const PATTERN_ACTIONS: readonly PatternAction[] = [
  "open-note",
  "open-url",
  "none",
];

/** 토막 이름 어휘(같은 이유로 export). */
export const PATTERN_PARTS: readonly PatternPart[] = ["first", "second"];

/**
 * 구분자 한 토막의 길이 상한.
 *
 * 왜 상한이 있나: 구분자는 문장부호 몇 글자다(`==`·`[[`·`](`). 이보다 길면 저작자가 구분자
 * 자리에 본문이나 정규식을 넣은 것이고, 그대로 두면 "등록은 됐는데 아무것도 매칭되지 않는"
 * 무음 실패가 된다 — 등록 시점에 거부해 진단으로 보이게 한다.
 */
const MAX_DELIMITER_LEN = 8;

/** 패턴 모양 검증 결과 — 실패는 **어느 필드가 왜**인지를 담는다(블록 임베드 파서와 같은 결). */
type InlinePatternShapeResult =
  | {
      ok: true;
      shape: {
        open: string;
        mid?: string;
        close: string;
        param?: InlinePatternParam;
        label: PatternPart;
        target: PatternPart;
        action: PatternAction;
      };
    }
  | { ok: false; field: string; reason: string };

/**
 * 신뢰할 수 없는 등록 인자에서 패턴의 **모양·동작**을 검증해 뽑는다(순수, 테스트용).
 *
 * 역할: 구분자 셋과 토막 선택·클릭 동작의 규칙을 한 곳에 고정한다. 스타일·id·className은
 * 호출 측(loader)이 이미 자기 규칙으로 처리하므로 여기서 보지 않는다.
 * 왜 이 함수가 생겼나: 예전에는 검증이 `String(args.open ?? "")` 하나뿐이라 `open: "["`,
 * `close: ")"` 같은 등록이 **성공한 뒤** `[텍스트](url)`에서 `텍스트](url`을 캡처해, 그런
 * 제목의 노트를 찾다 실패하고 끝났다 — 오류도 경고도 없는 무음 실패였다. 세 토막을 표현할
 * 수 있게 열면서 그 구멍도 함께 막는다.
 */
export function parseInlinePatternShape(
  args: Record<string, unknown>,
): InlinePatternShapeResult {
  const fail = (field: string, reason: string): InlinePatternShapeResult => ({
    ok: false,
    field,
    reason,
  });
  const delimiter = (
    value: unknown,
    field: string,
  ): { ok: true; value: string } | { ok: false; reason: string } => {
    if (typeof value !== "string" || value === "") {
      return {
        ok: false,
        reason: `비어있지 않은 문자열이어야 한다 (${field})`,
      };
    }
    if (value.length > MAX_DELIMITER_LEN) {
      return {
        ok: false,
        reason: `${MAX_DELIMITER_LEN}자를 넘을 수 없다(구분자는 문장부호 몇 글자다)`,
      };
    }
    if (/[\n\r]/.test(value)) {
      return {
        ok: false,
        reason: "줄바꿈을 담을 수 없다(매칭은 한 줄 안에서 한다)",
      };
    }
    return { ok: true, value };
  };

  const open = delimiter(args.open, "open");
  if (!open.ok) return fail("open", open.reason);
  const close = delimiter(args.close, "close");
  if (!close.ok) return fail("close", close.reason);

  let mid: string | undefined;
  if (args.mid !== undefined) {
    const parsed = delimiter(args.mid, "mid");
    if (!parsed.ok) return fail("mid", parsed.reason);
    mid = parsed.value;
  }

  // 파라미터화 꼬리(선택). 여기서도 저작자가 주는 것은 **리터럴 구분자와 닫힌 어휘 이름**뿐이다 —
  // 정규식·CSS 문자열은 경계를 넘지 못한다. 어휘 밖 이름을 조용히 무시하면 "등록은 됐는데
  // 아무것도 안 칠해진다"는 무음 실패가 되므로 거부한다(구분자 검증과 같은 이유).
  let param: InlinePatternParam | undefined;
  if (args.param !== undefined) {
    const raw = args.param;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail("param", "객체여야 한다");
    }
    const p = raw as Record<string, unknown>;
    const prefix = delimiter(p.prefix, "param.prefix");
    if (!prefix.ok) return fail("param.prefix", prefix.reason);
    if (
      typeof p.format !== "string" ||
      !PATTERN_PARAM_FORMATS.includes(p.format)
    ) {
      return fail(
        "param.format",
        `${PATTERN_PARAM_FORMATS.map((f) => `"${f}"`).join(" | ")} 중 하나여야 한다`,
      );
    }
    let apply: string | undefined;
    if (p.apply !== undefined) {
      if (
        typeof p.apply !== "string" ||
        !PATTERN_PARAM_APPLY_PROPS.includes(p.apply)
      ) {
        return fail(
          "param.apply",
          `${PATTERN_PARAM_APPLY_PROPS.map((a) => `"${a}"`).join(" | ")} 중 하나여야 한다(색 값을 받는 속성만)`,
        );
      }
      apply = p.apply;
    }
    param = {
      prefix: prefix.value,
      format: p.format,
      ...(apply === undefined ? {} : { apply }),
    };
  }

  const part = (
    value: unknown,
    fallback: PatternPart,
    field: string,
  ): { ok: true; value: PatternPart } | { ok: false; reason: string } => {
    if (value === undefined) return { ok: true, value: fallback };
    if (!(PATTERN_PARTS as readonly unknown[]).includes(value)) {
      return {
        ok: false,
        reason: `${PATTERN_PARTS.map((p) => `"${p}"`).join(" | ")} 중 하나여야 한다 (${field})`,
      };
    }
    // 둘째 토막은 `mid`가 있어야 존재한다 — 없는 토막을 가리키면 아무것도 렌더되지 않는다.
    if (value === "second" && mid === undefined) {
      return {
        ok: false,
        reason: '"second"는 `mid`를 함께 줄 때만 쓸 수 있다',
      };
    }
    return { ok: true, value: value as PatternPart };
  };

  const label = part(args.label, "first", "label");
  if (!label.ok) return fail("label", label.reason);
  const target = part(
    args.target,
    mid === undefined ? "first" : "second",
    "target",
  );
  if (!target.ok) return fail("target", target.reason);

  let action: PatternAction = "open-note";
  if (args.action !== undefined) {
    if (!(PATTERN_ACTIONS as readonly unknown[]).includes(args.action)) {
      return fail(
        "action",
        `${PATTERN_ACTIONS.map((a) => `"${a}"`).join(" | ")} 중 하나여야 한다`,
      );
    }
    action = args.action as PatternAction;
  }

  return {
    ok: true,
    shape: {
      open: open.value,
      ...(mid === undefined ? {} : { mid }),
      close: close.value,
      ...(param === undefined ? {} : { param }),
      label: label.value,
      target: target.value,
      action,
    },
  };
}

/** 패턴 매칭을 적용할 한 줄 최대 길이(방어적 상한). */
const MAX_LINE_LEN = 20000;

/**
 * 자동완성 디스크립터: `trigger` 입력 시 `source`의 후보를 `wrap`(`%` 치환)으로 제안.
 *
 * `trigger`는 **리터럴 문자열**이다 — 호스트는 이 값으로 정규식을 만들지 않고 문자열 비교로
 * 매칭기를 조립한다(플러그인 값에서 정규식을 만들면 ReDoS·잘못된 패턴이 보안 모델을 뚫는다).
 */
export interface CompletionDescriptor {
  /** 등록 id(호스트가 upsert 키로 쓴다). */
  id: string;
  trigger: string;
  wrap: string;
  /**
   * 후보 원천. 지금은 노트 제목 하나뿐인 **닫힌 열거형**이다 — 새 원천은 보안 경계를
   * 움직이므로 열거를 넓힐 때 별도 검토가 필요하다.
   */
  source: "note-titles";
}

/**
 * 자동완성 쿼리(트리거 뒤 ~ 커서)의 최대 길이. 넘으면 그 트리거는 매칭하지 않는다.
 *
 * 왜: `trigger`가 짧으면(`@` 등) 줄 앞쪽의 우연한 한 글자까지 트리거로 잡혀, 커서에서 아주
 * 먼 곳부터 통째로 치환되는 사고가 난다. 정규식 없이 매칭하므로 이 상한이 그 방어다.
 */
const MAX_COMPLETION_QUERY = 120;

/**
 * `wrap`의 `%` 뒤 부분(닫는 문자열)을 뽑는다 — `"[[%]]"` → `"]]"`. 없으면 빈 문자열.
 *
 * 왜: 이미 닫힌 패턴(`[[제목]]` 뒤에 커서) 안에서 자동완성이 다시 뜨지 않게 하려면 "쿼리에
 * 닫는 문자열이 이미 들어 있는가"를 봐야 한다. 예전의 `[[` 하드코딩 정규식(`\[\[[^\]]*$`)이
 * 우연히 하던 일을 등록값에서 파생해 일반화한 것이다.
 */
function completionCloser(wrap: string): string {
  const idx = wrap.indexOf("%");
  return idx === -1 ? "" : wrap.slice(idx + 1);
}

/**
 * 커서 앞 텍스트에서 어느 등록의 트리거가 열려 있는지 찾는다(순수, 테스트용).
 *
 * 역할: 각 등록의 `trigger`를 **리터럴로** 커서 앞에서 뒤부터 찾고, 그 뒤 ~ 커서 사이를
 * 쿼리로 삼는다. 충돌하면 **커서에 가장 가까운(쿼리가 늦게 시작하는) 트리거가 이기고**,
 * 같은 자리에서 시작하면 더 긴 trigger가, 그마저 같으면 먼저 등록한 쪽이 남는다.
 * 왜: 예전 구현은 `trigger`를 팝업을 여는 조건에만 쓰고 실제 매칭은 `[[` 하드코딩이었다 —
 * `trigger: "@"`로 등록하면 팝업은 뜨는데 후보가 영원히 0개인, 오류도 안 나는 무음 실패였다.
 * 그 뒤로도 승자를 trigger 길이·등록 순서로만 골라, `@alice #ta`에서 `#`을 친 사용자에게
 * 줄 앞쪽 `@`의 후보가 뜨고 선택하면 `@alice #ta` **전체가** 그 플러그인의 `wrap`으로
 * 치환됐다(치환 시작점은 승자의 `from`이다). 위치를 1순위로 두는 이유가 그것이다.
 */
export function matchCompletionTrigger(
  beforeCursor: string,
  completions: CompletionDescriptor[],
): { completion: CompletionDescriptor; from: number; query: string } | null {
  let best: {
    completion: CompletionDescriptor;
    from: number;
    query: string;
  } | null = null;
  for (const completion of completions) {
    const { trigger } = completion;
    if (trigger === "") continue;
    const from = beforeCursor.lastIndexOf(trigger);
    if (from === -1) continue;
    const query = beforeCursor.slice(from + trigger.length);
    if (query.length > MAX_COMPLETION_QUERY) continue;
    const closer = completionCloser(completion.wrap);
    if (closer !== "" && query.includes(closer)) continue; // 이미 닫힌 패턴
    // 1순위는 **쿼리 시작점**(= 커서에 가까운 쪽). 겹치는 접두 트리거(`[` vs `[[`)는 시작점이
    // 같아지므로 2순위인 trigger 길이가 갈라 준다(`[[abc`는 `[[`가 이긴다). 셋 다 같으면
    // `>`가 거짓이라 먼저 등록한 쪽이 남는다.
    const start = from + trigger.length;
    const bestStart =
      best === null ? -1 : best.from + best.completion.trigger.length;
    if (
      best === null ||
      start > bestStart ||
      (start === bestStart && trigger.length > best.completion.trigger.length)
    ) {
      best = { completion, from, query };
    }
  }
  return best;
}

/** 호스트가 플러그인 대신 수행하는 데이터 서비스(권한 검사 후). */
interface PluginEditorServices {
  noteTitles(): Promise<string[]>;
  openByTitle(title: string): void;
  /**
   * 링크를 시스템 기본 브라우저로 넘긴다(`action: "open-url"`).
   *
   * 권한(`browser:open`)이 없는 플러그인의 패턴은 노트 창이 스냅샷을 소비할 때 동작을
   * `"none"`으로 낮추므로, 여기까지 오는 것은 승인된 플러그인의 클릭뿐이다. 스킴 판정은
   * 백엔드(`open_external_url`)가 다시 한다 — 이 경로를 믿지 않는다.
   */
  openUrl(url: string): void;
  /** 임베드 최종 URL의 도메인이 이 플러그인의 granted `embed:<domain>`인지 판정. */
  allowEmbedDomain(domain: string): boolean;
}

/** 정규식 메타문자를 이스케이프한다(구분자를 리터럴로 쓰기 위함). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 한 매치에서 캡처된 토막의 문서 내 범위. */
interface PatternSpan {
  from: number;
  to: number;
}

/** 한 줄에서 찾은 패턴 매치 — 전체 범위와 캡처 토막들의 범위. */
interface PatternMatch {
  from: number;
  to: number;
  first: PatternSpan;
  /** 세 토막 패턴일 때만 있다. */
  second?: PatternSpan;
  /** 파라미터화 패턴일 때만 있다 — `close` 앞에서 캡처한 값의 범위. */
  param?: PatternSpan;
}

/**
 * 매치 본문(구분자 **안쪽** 전체 = `open` 뒤부터 `close` 앞까지)이 이 패턴의 구분자 짝을
 * 가로지르는지 보고, 가로지르면 **다시 볼 자리**를 돌려준다(순수, 테스트용) —
 * 균형이 맞아 그대로 채택해도 되면 `null`이다. [`findPatternMatches`]의 채택 조건이자,
 * 툴바 쪽 같은 규칙(`note/color-segments.ts`의 `matchColorAt`)이 공유하는 판정이다.
 *
 * 왜 필요한가: 본문은 lazy(`.+?`)라 `close`를 그냥 통과한다. 그래서 `close` 앞에 꼬리를
 * **요구하는** 패턴(「글자 색」의 `|#hex`)은 줄 앞쪽에 있는 남의 매치를 통째로 삼킬 수 있었다 —
 * `{{Cmd+C}} {{할일|#e33}}`의 색 매치가 index 0에서 시작해 키캡을 먹어 치우고, 화면에는
 * `Cmd+C}} {{할일`가 한 덩어리로 칠해졌다(키캡 소멸 + 원문 `}}`·`{{` 노출).
 *
 * 규칙: 본문을 왼쪽부터 훑어 `open`이면 쌓고 `close`면 하나 덜어 낸다.
 * - 쌓인 것이 없는데 `close`가 나오면 **짝 없는 닫기** = 이 후보가 앞선 매치를 삼키고 있다는
 *   증거다. 그 `close` 자리를 돌려준다 — 그보다 앞에서 시작하는 후보는 전부 같은 `close`를
 *   같은 이유로 물게 되므로(lazy라 매치 끝은 시작이 늦을수록 뒤로만 간다) 볼 필요가 없다.
 * - 끝났는데 `open`이 남으면 본문 안의 열기가 닫히지 않은 것이다 — **가장 안쪽의 남은 `open`**
 *   에서 시작하는 매치가 진짜다(`{{ 그리고 {{a|#f00}}`에서는 뒤쪽 감싸기가 이긴다). 그 자리를
 *   돌려준다.
 * 둘 다 아니면(= 균형) `null`이다. 그래서 **진짜 중첩**(`{{보라 {{Ctrl+C}}|#3a5}}`)은 계속
 * 살아남는다 — 안쪽 `{{`…`}}`가 본문 안에서 스스로 닫히기 때문이다.
 *
 * "다시 볼 자리"를 함께 주는 이유는 성능이다: 버릴 때마다 바로 다음 `open`으로 한 칸씩
 * 물러나면 `{{ `가 수천 번 반복되는 줄(한 줄 상한 20000자)에서 후보 하나하나가 줄 끝까지
 * 훑어 제곱이 된다(실측 0.6초). 이 규칙은 그런 줄을 두어 번의 훑기로 끝낸다.
 *
 * 여닫이가 **같은 문법**(`==`·`||`·`^`)은 예외다: 같은 글자에 여닫이 구분이 없어 깊이를 셀 수
 * 없다(무엇을 세도 `==a==b==` 같은 본문의 판정이 자의적이다). 그런 패턴은 lazy 매칭이 첫
 * `close`에서 반드시 멈추므로 애초에 남의 매치를 삼킬 수 없다 — 규칙을 적용하지 않는다.
 *
 * @returns 균형이면 null, 아니면 **본문 안 오프셋**(호출부가 본문 시작을 더해 절대 위치로 쓴다).
 */
export function patternBodyResyncOffset(
  body: string,
  open: string,
  close: string,
): number | null {
  if (open === "" || close === "" || open === close) return null;
  const opens: number[] = []; // 아직 닫히지 않은 `open`들의 자리(스택).
  let i = 0;
  while (i < body.length) {
    if (body.startsWith(open, i)) {
      opens.push(i);
      i += open.length;
    } else if (body.startsWith(close, i)) {
      if (opens.length === 0) return i; // 짝 없는 닫기 = 앞선 매치를 삼키는 중이다.
      opens.pop();
      i += close.length;
    } else {
      i++;
    }
  }
  return opens.length === 0 ? null : opens[opens.length - 1];
}

/**
 * 한 줄에서 패턴 매치와 각 캡처 토막의 범위를 찾는다(순수, 테스트용).
 *
 * `mid`를 주면 `open`…`mid`…`close`(캡처 둘), 없으면 `open`…`close`(캡처 하나)를 찾는다.
 * `param`을 주면 `close` **바로 앞**에 `prefix` + 형식 정규식 캡처가 하나 더 붙는다
 * (`open`…[`mid`…]`prefix`<값>`close`). 구분자는 리터럴로 이스케이프하고 본문은 lazy(`.+?`),
 * 파라미터 정규식은 호스트 소유의 고정 조각(길이가 유계인 문자 클래스)이라 파국적
 * 백트래킹(ReDoS)이 없다. 플러그인이 raw 정규식을 주지 않으므로 잘못된 정규식으로 던질 일도 없다.
 *
 * 훑는 방식: 전역(`g`) 스캔 대신 **`open`이 나오는 자리마다 앵커**(sticky `y`)해 본다. 매치는
 * 어차피 `open`에서만 시작하므로 찾아지는 후보 자체는 같지만, 후보가
 * [`patternBodyResyncOffset`]에 걸려 버려졌을 때 **그 함수가 짚어 준 자리부터 다시** 볼 수
 * 있다는 점이 다르다(전역 스캔은 버린 후보의 끝으로 건너뛰어 그 안의 진짜 매치를 놓친다).
 * 채택된 매치 뒤는 예전 그대로 겹치지 않게 이어서 훑는다.
 *
 * 범위를 돌려주는 이유(예전에는 캡처 **문자열**만 돌려줬다): 세 토막에서는 "보여 줄 토막"과
 * "클릭 대상 토막"이 다를 수 있어, 호출 측이 구분자 길이를 더해 위치를 되짚는 방식으로는
 * 표현되지 않는다.
 */
export function findPatternMatches(
  text: string,
  open: string,
  close: string,
  mid?: string,
  param?: InlinePatternParam,
): PatternMatch[] {
  if (!open || !close) return [];
  if (mid !== undefined && mid === "") return [];
  // 모르는 형식·빈 prefix는 "매치 없음"이다(등록 시점에 이미 거부되지만, 매니페스트·스냅샷
  // 경로로 들어온 값까지 믿지 않는다 — 빈 문자열을 쓰면 값이 본문과 붙어 경계가 사라진다).
  const paramSource =
    param === undefined ? null : patternParamRegexSource(param.format);
  if (param !== undefined && (paramSource === null || param.prefix === "")) {
    return [];
  }
  const body = mid === undefined ? "(.+?)" : `(.+?)${escapeRegExp(mid)}(.+?)`;
  const tail =
    param === undefined
      ? ""
      : `${escapeRegExp(param.prefix)}(${paramSource as string})`;
  const re = new RegExp(
    `${escapeRegExp(open)}${body}${tail}${escapeRegExp(close)}`,
    "y",
  );
  const out: PatternMatch[] = [];
  let anchor = text.indexOf(open);
  while (anchor !== -1) {
    re.lastIndex = anchor;
    const m = re.exec(text);
    // 이 자리에서 시작하는 매치가 없으면 다음 `open`을 본다.
    if (m === null) {
      anchor = text.indexOf(open, anchor + 1);
      continue;
    }
    // 있어도 남의 구분자 짝을 가로지르면 버리고, 규칙이 짚어 준 자리부터 다시 본다(버린
    // 후보 안쪽에 진짜 매치가 들어 있는 경우가 이 규칙의 전부다).
    const bodyFrom = anchor + open.length;
    const resync = patternBodyResyncOffset(
      text.slice(bodyFrom, anchor + m[0].length - close.length),
      open,
      close,
    );
    if (resync !== null) {
      // `bodyFrom + resync > anchor`가 언제나 성립하므로(본문은 `open` 뒤에서 시작한다)
      // 무한 루프가 없다.
      anchor = text.indexOf(open, bodyFrom + resync);
      continue;
    }
    const firstFrom = m.index + open.length;
    const firstTo = firstFrom + (m[1] ?? "").length;
    const match: PatternMatch = {
      from: m.index,
      to: m.index + m[0].length,
      first: { from: firstFrom, to: firstTo },
    };
    if (mid !== undefined) {
      const secondFrom = firstTo + mid.length;
      match.second = { from: secondFrom, to: secondFrom + (m[2] ?? "").length };
    }
    if (param !== undefined) {
      // 파라미터는 마지막 토막 뒤 `prefix` 다음에 온다 — 캡처 번호도 마지막이다.
      const prev = match.second ?? match.first;
      const paramFrom = prev.to + param.prefix.length;
      const value = m[mid === undefined ? 2 : 3] ?? "";
      match.param = { from: paramFrom, to: paramFrom + value.length };
    }
    out.push(match);
    // 채택한 매치와 겹치지 않게 그 끝부터 다음 `open`을 찾는다(본문은 최소 1글자라 반드시 전진).
    anchor = text.indexOf(open, match.to);
  }
  return out;
}

/** 패턴이 고른 토막의 범위를 꺼낸다 — `"second"`인데 두 토막이면 없다(null). */
function spanOf(match: PatternMatch, part: PatternPart): PatternSpan | null {
  return part === "second" ? (match.second ?? null) : match.first;
}

/**
 * 겹치는 매치 중 **어느 쪽이 더 구체적인가**를 재는 점수(순수, 테스트용).
 *
 * 왜 필요한가: 서로 다른 플러그인이 같은 바깥 구분자를 쓰면 **같은 구간**을 동시에 잡는다 —
 * 「키 표시」의 포괄적 `{{…}}`와 「글자 색」의 `{{…|#hex}}`가 그 실례다(`{{할일|#f36}}`을
 * 둘 다 0~13으로 잡는다). 예전에는 승자를 **등록 순서**로만 갈랐는데, 등록 순서는 목록에서
 * 한 줄 옮기면 뒤집히는 우연한 값이라 "왜 이게 이겼는지"를 설명하지 못했다(그리고 실제로는
 * 플러그인마다 확장이 따로 만들어져 순서 규칙이 발화조차 하지 않았다 — 아래
 * [`buildInlinePatternExtension`] 주석 참고).
 *
 * 점수 = 리터럴 구분자 길이의 합 + 파라미터 꼬리(`prefix` + 값 자리 1). 구분자를 더 많이
 * 요구하는 패턴일수록 **아무 본문에나 걸리지 않는다** = 더 구체적이다. 파라미터 꼬리는
 * 그 자체로 형식 검증된 값 하나를 더 요구하므로 반드시 가산된다 — 그래서 `{{…|#hex}}`가
 * `{{…}}`를 언제나 이긴다(목록 순서와 무관하게).
 */
export function patternSpecificity(pattern: InlinePatternDescriptor): number {
  return (
    pattern.open.length +
    pattern.close.length +
    (pattern.mid?.length ?? 0) +
    (pattern.param === undefined ? 0 : pattern.param.prefix.length + 1)
  );
}

/**
 * 지금 이 에디터에 살아 있는 **색 파라미터 패턴**의 문법(선택 툴바 색 버튼이 읽는 통로).
 *
 * 역할: 노트 창 UI(플러그인이 아니다)가 "본문에 색을 적는 문법이 지금 켜져 있는가, 켜져 있다면
 * 어떤 구분자인가"를 물을 수 있게 한다 — [`selection-toolbar`](../note/selection-toolbar)의
 * 색 버튼은 이 값이 있을 때만 뜨고, 감쌀 때도 하드코딩이 아니라 **여기 실린 구분자**를 쓴다.
 * 왜 facet인가: 플러그인 확장은 스냅샷이 도착한 뒤 Compartment로 갈아 끼워지므로(에디터 생성
 * 시점에는 아직 없다), UI가 생성 시점에 주입받는 옵션으로는 표현할 수 없다. facet은 재구성
 * 즉시 반영되고, 플러그인이 꺼지면 값이 사라진다(버튼도 함께 사라진다).
 */
export interface ColorPatternSyntax {
  /** 여는 구분자(예 `{{`). */
  open: string;
  /** 닫는 구분자(예 `}}`). */
  close: string;
  /** 색 값 앞의 구분자(예 `|`). */
  prefix: string;
}

/** 색 파라미터 패턴 문법 facet — 여럿이면 먼저 등록된 것 하나만 쓴다(없으면 null). */
export const colorPatternSyntax = Facet.define<
  ColorPatternSyntax,
  ColorPatternSyntax | null
>({ combine: (values) => values[0] ?? null });

/**
 * 패턴 목록에서 선택 툴바가 쓸 수 있는 색 문법을 고른다(순수).
 *
 * 조건: 두 토막(`mid` 없음)이고, 파라미터 꼬리가 색(`apply: "color"`)을 칠하는 패턴 — 그런
 * 패턴만 "선택 텍스트를 `open`+글자+`prefix`+색+`close`로 감싼다"는 되쓰기가 정확히 성립한다
 * (세 토막은 어느 토막에 무엇을 넣을지 UI가 알 수 없다). 없으면 null.
 *
 * 이 판정의 결과는 [`colorPatternSyntax`] facet으로만 밖에 나간다(그래서 이 함수 자체는
 * 내부용이다) — 종단 확인은 `inline-pattern-pipeline.test.ts`가 facet 값으로 한다.
 */
function pickColorPatternSyntax(
  patterns: InlinePatternDescriptor[],
): ColorPatternSyntax | null {
  for (const p of patterns) {
    if (p.mid !== undefined) continue;
    if (p.param === undefined || p.param.apply !== "color") continue;
    if (p.param.prefix === "") continue;
    return { open: p.open, close: p.close, prefix: p.param.prefix };
  }
  return null;
}

/** 인라인 패턴 구분자(open/close)를 화면에서 숨긴다 — 원문은 보존, 표시만 제거(라이브 프리뷰와 동일). */
const hidePatternMark = Decoration.replace({});

/**
 * 중첩 재스캔의 깊이 상한 — 톱레벨(0) 아래로 이만큼 더 들어간다.
 *
 * 재귀는 이 상한이 없어도 **반드시 끝난다**: 재스캔 대상은 채택된 매치의 라벨 토막인데, 그
 * 토막은 구분자(비어있지 않다)를 뺀 진부분 문자열이라 길이가 매번 최소 2 줄어든다. 그러므로
 * 이 값은 정지 조건이 아니라 **비용 상한**이다 — 색 안의 위키링크·키캡(1단계)과 그 안의 한
 * 겹(2단계)까지가 실제로 쓰이는 전부라, 더 깊이 파는 비용을 지불하지 않는다.
 */
const MAX_PATTERN_NEST_DEPTH = 2;

/**
 * 중첩 재스캔을 시도할 라벨 토막의 최소 길이.
 *
 * 어떤 패턴이든 `open`(≥1) + 본문(`.+?`, ≥1) + `close`(≥1)이라 3글자보다 짧은 토막에서는
 * 매치가 나올 수 없다 — 재스캔 자체를 건너뛴다(짧은 라벨이 대다수다).
 */
const MIN_NESTABLE_LEN = 3;

/**
 * 한 줄에서 채택된 매치 하나 — 문서 절대 위치(줄 시작 + 상대 오프셋).
 *
 * `specificity`는 채택이 끝나면 쓸 일이 없어 여기 남기지 않는다(정렬 단계의 지역 값이다).
 */
interface PatternHit {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  className: string;
  action: PatternAction;
  target: string;
  /** 파라미터 캡처값에서 만든 CSS 선언 한 줄(없거나 검증 실패면 null). */
  paramStyle: string | null;
}

/**
 * 한 조각(줄 전체 또는 채택된 매치의 라벨 토막)에서 겹침을 해소하고, **채택된 매치의 라벨
 * 안쪽을 재귀적으로 다시 훑어** 중첩 매치까지 모은다(순수).
 *
 * 겹침 해소(이 층 안에서): 시작 위치 오름차순 → 같은 자리면 더 구체적인 패턴이 이기고
 * ([`patternSpecificity`]) 점수까지 같으면 안정 정렬이라 먼저 등록된 쪽이 남는다. 채택된
 * 매치와 **부분만 겹치는** 뒤 매치는 예전 그대로 버린다.
 *
 * 중첩(이 함수가 새로 하는 일): 예전에는 채택된 매치 구간에 걸치는 매치를 **전부** 버려서,
 * 색 감싸기 `{{…|#3a5}}` 안의 `[[위키링크]]`가 통째로 삼켜져 대괄호째 색 글자로 남았다
 * (클릭 불가). 지금은 채택된 매치가 **화면에 남기는 토막**(라벨) 안을 다시 훑는다 —
 * 구분자·파라미터는 숨겨지므로 그 안의 매치는 어차피 보이지 않고, 라벨 안에 완전히 들어가는
 * 매치만 중첩으로 채택된다. CM의 mark 데코는 겹침을 허용하므로 바깥 색 mark와 안쪽 링크
 * mark가 자연스럽게 합성된다(바깥 span이 안쪽 span을 감싼다).
 *
 * **줄 전체가 아니라 부분 문자열을 다시 훑는 것**이 핵심이다: 줄 전체 스캔에서
 * `{{보라 {{Ctrl+C}}|#3a5}}`의 kbd 매치는 줄 머리 `{{`에서 시작해 색 매치와 부분만 겹치지만,
 * 라벨(`보라 {{Ctrl+C}}`)만 다시 훑으면 안쪽 키캡이 온전한 매치로 잡힌다. 이미 찾아 둔
 * 매치를 걸러 쓰는 방식으로는 이 케이스가 살아나지 않는다.
 *
 * @param text 훑을 조각
 * @param base `text[0]`의 문서 절대 위치
 * @param depth 현재 중첩 깊이(톱레벨 0)
 */
function collectPatternHits(
  text: string,
  base: number,
  patterns: InlinePatternDescriptor[],
  depth: number,
): PatternHit[] {
  const candidates = patterns.flatMap((pattern) => {
    const specificity = patternSpecificity(pattern);
    const label = pattern.label ?? "first";
    const target = pattern.target ?? (pattern.mid ? "second" : "first");
    const action = pattern.action ?? "open-note";
    return findPatternMatches(
      text,
      pattern.open,
      pattern.close,
      pattern.mid,
      pattern.param,
    ).flatMap((m) => {
      const labelSpan = spanOf(m, label);
      const targetSpan = spanOf(m, target);
      // 없는 토막을 가리키는 등록은 등록 시점에 거부되지만, 매니페스트 경로로 들어온
      // 값까지 믿지는 않는다 — 여기서도 조용히 건너뛴다(잘못 잘린 렌더보다 낫다).
      if (!labelSpan || !targetSpan) return [];
      return [
        {
          from: m.from,
          to: m.to,
          labelFrom: labelSpan.from,
          labelTo: labelSpan.to,
          className: pattern.className,
          // 같은 자리에서 시작하는 겹침을 가르는 값 — 큰 쪽(더 구체적인 패턴)이 이긴다.
          specificity,
          action,
          target: text.slice(targetSpan.from, targetSpan.to),
          // 파라미터 캡처값 → 검증된 CSS 선언 한 줄(형식·속성이 안 맞으면 null).
          // 이 매치에만 붙는 값이라 클래스 규칙(정적 CSS)이 아니라 style 속성으로 간다.
          paramStyle:
            pattern.param?.apply === undefined || m.param === undefined
              ? null
              : renderParamStyleDeclaration(
                  pattern.param.apply,
                  pattern.param.format,
                  text.slice(m.param.from, m.param.to),
                ),
        },
      ];
    });
  });
  candidates.sort((a, b) => a.from - b.from || b.specificity - a.specificity);

  const hits: PatternHit[] = [];
  let lastTo = 0;
  for (const c of candidates) {
    if (c.from < lastTo) continue; // 이 층에서 이미 잡힌 구간과 겹치면 버린다.
    if (c.labelFrom >= c.labelTo) continue; // 보여 줄 글자가 없으면 스킵.
    hits.push({
      from: base + c.from,
      to: base + c.to,
      labelFrom: base + c.labelFrom,
      labelTo: base + c.labelTo,
      className: c.className,
      action: c.action,
      target: c.target,
      paramStyle: c.paramStyle,
    });
    lastTo = c.to;
    // 화면에 남는 토막 안쪽만 다시 훑는다(숨겨질 구분자·파라미터는 볼 이유가 없다).
    if (
      depth < MAX_PATTERN_NEST_DEPTH &&
      c.labelTo - c.labelFrom >= MIN_NESTABLE_LEN
    ) {
      hits.push(
        ...collectPatternHits(
          text.slice(c.labelFrom, c.labelTo),
          base + c.labelFrom,
          patterns,
          depth + 1,
        ),
      );
    }
  }
  return hits;
}

/**
 * 가시 영역의 각 줄에서 패턴을 찾아 데코레이션을 만든다.
 *
 * 커서가 놓인 줄은 원문 그대로 두고(편집용), 그 외 줄은 **구분자(`==`·`[[` 등)를 숨기고
 * 안쪽 텍스트만** 스타일(+ 클릭)한다 — 헤딩·굵게 등 라이브 프리뷰([`./live-preview`])와 같은
 * 관례. 왜: "구분자가 보이면서 효과도 적용"되는 어색함을 없애, 읽을 땐 효과만·편집할 땐 원문.
 * 커서 줄 판정은 줄 단위이므로 중첩된 안쪽 매치도 자동으로 같은 규칙을 따른다.
 *
 * 왜 `RangeSetBuilder`가 아니라 범위를 모아 [`Decoration.set`]에 넘기는가: 중첩을 허용한
 * 뒤로는 만들어지는 범위가 **더 이상 시작 위치 오름차순이 아니다**(바깥 매치의 닫는 구분자
 * 숨김은 안쪽 매치의 범위들보다 뒤에서 시작한다). `Decoration.set(…, true)`는 정렬과 겹침
 * 레이어링을 함께 해 주므로, 호출 측이 방출 순서를 억지로 맞출 필요가 없다.
 */
function buildDecorations(
  view: EditorView,
  patterns: InlinePatternDescriptor[],
): DecorationSet {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      // 커서 줄은 원문 노출(편집). 그 외 줄만 구분자 숨김 + 안쪽 스타일.
      if (line.text.length <= MAX_LINE_LEN && line.number !== cursorLine) {
        for (const hit of collectPatternHits(
          line.text,
          line.from,
          patterns,
          0,
        )) {
          // 클릭 동작이 없으면 링크 표식을 달지 않는다 — 눌러도 아무 일이 없는 가짜
          // 링크(손 모양 커서·링크 색)를 만들지 않기 위함이다. 파라미터 스타일은 그와
          // 무관하게(장식용 패턴이 주 용례다) 있으면 붙인다.
          const attributes: Record<string, string> = {};
          if (hit.action !== "none") {
            attributes["data-link-target"] = hit.target;
            attributes["data-link-action"] = hit.action;
          }
          if (hit.paramStyle !== null) attributes.style = hit.paramStyle;
          // 화면에는 고른 토막만 남긴다: 그 앞(open[+first+mid])과 뒤([mid+second+]close)를 숨긴다.
          if (hit.from < hit.labelFrom) {
            ranges.push(hidePatternMark.range(hit.from, hit.labelFrom));
          }
          ranges.push(
            Decoration.mark({
              class:
                hit.action === "none"
                  ? hit.className
                  : `${hit.className} cm-plugin-link`,
              attributes,
            }).range(hit.labelFrom, hit.labelTo),
          );
          if (hit.labelTo < hit.to) {
            ranges.push(hidePatternMark.range(hit.labelTo, hit.to));
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** 인라인 패턴 데코레이션 + 클릭(동작별 분기) ViewPlugin. */
function inlinePatternPlugin(
  patterns: InlinePatternDescriptor[],
  services: Pick<PluginEditorServices, "openByTitle" | "openUrl">,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, patterns);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = buildDecorations(update.view, patterns);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown: (event) => {
          const el = (event.target as HTMLElement).closest<HTMLElement>(
            ".cm-plugin-link",
          );
          const target = el?.dataset.linkTarget;
          const action = el?.dataset.linkAction;
          if (!target) return false;
          if (action === "open-url") services.openUrl(target);
          else if (action === "open-note") services.openByTitle(target);
          // 모르는 동작이면 아무것도 하지 않고 이벤트를 다음 핸들러에 넘긴다.
          else return false;
          event.preventDefault();
          return true;
        },
      },
    },
  );
}

/**
 * 인라인 패턴에서 **메타데이터만** 뽑는다(렌더 아님) — 지금은 색 문법 facet 하나다.
 *
 * 왜 렌더와 갈라놓나: 노트 창은 프리뷰(렌더 모드)를 끄면 플러그인 **렌더** 확장을 통째로
 * 내린다(원문을 그대로 보여주는 게 맞다 — editor.ts의 pluginC). 그런데 색 문법은 그리는
 * 것이 아니라 "색을 넣을 때 어떤 구분자로 감싸는가"라는 **사실**이고, 선택 툴바의 색 버튼은
 * 이 facet의 유무만 보고 뜬다. 한 덩어리로 묶여 있던 탓에 프리뷰를 끄면 색 버튼이 함께
 * 사라져, 원문 모드에서는 색을 넣을 방법이 아예 없었다(실사용 재현: "어떤 메모에선 팔레트가
 * 뜨고 어떤 메모에선 안 뜬다" = 그 창의 프리뷰 상태 차이).
 */
export function buildInlinePatternMeta(
  patterns: InlinePatternDescriptor[],
): Extension {
  const colorSyntax = pickColorPatternSyntax(patterns);
  return colorSyntax === null ? [] : colorPatternSyntax.of(colorSyntax);
}

/**
 * 인라인 패턴 렌더 확장 하나(데코레이션 + 클릭) — **여러 플러그인의 패턴을 한 목록으로 받는다**.
 * 색 문법 facet은 여기 들어가지 않는다([`buildInlinePatternMeta`] — 프리뷰와 무관하게 살아야 한다).
 *
 * 왜 "한 목록"이 계약인가: [`buildDecorations`]의 겹침 해소(먼저 잡은 구간을 나중 매치가
 * 건너뛴다)는 **한 데코레이션 집합 안에서만** 성립한다. 예전에는 노트 창이 플러그인마다
 * 이 확장을 따로 만들어(`snapshot.plugins.map(...)`) CM에 N개의 독립 데코레이션 집합이
 * 얹혔고, 그래서 서로 다른 플러그인의 겹치는 매치는 **둘 다 그려졌다** — `{{할일|#f36}}`이
 * 「글자 색」의 색과 「키 표시」의 키캡 상자를 동시에 뒤집어쓰는 실제 버그가 그것이다.
 * 등록 순서로 승자를 가린다는 주석·가드는 그 구조에서 발화조차 하지 않는 죽은 규칙이었다.
 * 패턴을 한 목록으로 모으면 그 해소가 비로소 실제로 돌고, 승자는
 * [`patternSpecificity`]가 설명 가능하게 정한다. **중첩**([`collectPatternHits`])도 같은
 * 이유로 한 목록을 요구한다 — 색 감싸기 안의 위키링크는 두 플러그인의 패턴이 같은 해소를
 * 함께 통과해야 성립한다.
 *
 * 패턴이 하나도 없으면 아무 확장도 만들지 않는다(업데이트마다 도는 빈 스캔 절약).
 */
export function buildInlinePatternExtension(
  patterns: InlinePatternDescriptor[],
  services: Pick<PluginEditorServices, "openByTitle" | "openUrl">,
): Extension {
  if (patterns.length === 0) return [];
  return inlinePatternPlugin(patterns, services);
}

/** trigger 입력 시 노트 제목을 제안하는 자동완성 확장. */
function completionExtension(
  completions: CompletionDescriptor[],
  noteTitles: () => Promise<string[]>,
): Extension {
  if (completions.length === 0) return [];
  const triggers = completions.map((c) => c.trigger);
  const source: CompletionSource = async (ctx) => {
    // 매칭은 커서가 있는 **한 줄 안**에서만 한다(줄을 넘는 트리거는 없다).
    const line = ctx.state.doc.lineAt(ctx.pos);
    const hit = matchCompletionTrigger(
      line.text.slice(0, ctx.pos - line.from),
      completions,
    );
    if (!hit) return null;
    const typed = hit.query.toLowerCase();
    const titles = await noteTitles();
    const options = titles
      .filter((t) => t.toLowerCase().includes(typed))
      // 치환은 **매칭된 그 등록의** wrap으로 한다(예전엔 항상 첫 등록의 wrap을 썼다).
      // `%`는 split/join으로 전부 치환한다(예전엔 첫 하나만).
      .map((t) => ({
        label: t,
        apply: hit.completion.wrap.split("%").join(t),
      }));
    // filter:false — 쿼리 텍스트가 트리거를 포함해서(`[[…`) CM6 기본 필터가 후보를 거른다.
    // 위에서 직접 필터했다.
    return options.length
      ? { from: line.from + hit.from, options, filter: false }
      : null;
  };
  // 트리거 문자열은 단어 문자가 아닐 수 있어(`[[`) 기본 자동완성이 안 열린다 → 직접 연다.
  const autoOpen = EditorView.updateListener.of((update) => {
    if (
      !update.docChanged ||
      !update.transactions.some((t) => t.isUserEvent("input.type"))
    ) {
      return;
    }
    const head = update.state.selection.main.head;
    const opensTrigger = triggers.some(
      (trigger) =>
        update.state.sliceDoc(Math.max(0, head - trigger.length), head) ===
        trigger,
    );
    // 업데이트 진행 중에는 dispatch가 금지되므로 다음 틱에 자동완성을 연다.
    if (opensTrigger) {
      const view = update.view;
      setTimeout(() => startCompletion(view), 0);
    }
  });
  return [autocompletion({ override: [source] }), autoOpen];
}

/**
 * 디스크립터 + 호스트 서비스로 플러그인 에디터 확장(데코레이션·클릭·자동완성·블록
 * 임베드)을 만든다. 임베드 도메인 게이트(`allowEmbedDomain`)는 호스트가 grant를 바인딩해
 * 넘긴다 — 플러그인 선언만으로는 어떤 도메인도 렌더되지 않는다.
 *
 * 자동완성·임베드는 플러그인마다 **다른 서비스 배선**(권한별 무력화·per-plugin 도메인 게이트)을
 * 받으므로 이 함수를 플러그인당 한 번 부르는 것이 자연스럽다. 반면 **인라인 패턴은 그렇지
 * 않다** — 겹침 해소가 한 목록 안에서만 돌기 때문이다([`buildInlinePatternExtension`]).
 * 그래서 노트 창(`host-client.ts`)은 패턴만 전 플러그인에서 모아 따로 한 번 만들고, 이
 * 함수에는 빈 패턴 목록을 넘긴다.
 */
export function buildPluginEditorExtension(
  patterns: InlinePatternDescriptor[],
  completions: CompletionDescriptor[],
  embeds: BlockEmbedDescriptor[],
  services: PluginEditorServices,
): Extension {
  return [
    buildInlinePatternExtension(patterns, services),
    completionExtension(completions, services.noteTitles),
    // 등록된 임베드가 없으면 필드 자체를 만들지 않는다(선택 변경마다 도는 스캔 절약).
    embeds.length > 0 ? blockEmbedField(embeds, services.allowEmbedDomain) : [],
  ];
}
