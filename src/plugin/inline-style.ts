/**
 * 인라인 패턴 스타일 — 구조화 디스크립터 → 검증된 CSS(순수).
 *
 * 역할: 플러그인이 `registerInlinePattern({ style, styleHover })`로 준 신뢰 못 할 스타일
 * 객체를 (1) 속성 화이트리스트로 거르고 (2) 값을 형식 검증하며 (3) 색은 의미 토큰
 * (accent·danger·contrast…)을 앱 CSS 변수로 해석해, 호스트가 노트 창에 주입할 CSS 규칙
 * 텍스트로 조립한다. 셀렉터는 플러그인이 정하지 못하고 호스트가 `cm-x-<plugin>-<pattern>`
 * 으로 네임스페이스한다(앱·CM 내부 클래스 하이재킹 차단).
 * 왜: 테마([`../theme/theme`])·임베드([`./embed`])와 같은 "구조화 디스크립터만 통과, 호스트가
 * 조립" 보안 모델을 스타일에도 적용한다 — raw CSS 문자열·raw 셀렉터는 경계를 넘지 못한다.
 * `url()`·`expression()`·`;{}<>` 등 이스케이프 벡터는 값 검증에서 원천 거부한다.
 *
 * 이 파일은 **패턴 파라미터**(`registerInlinePattern`의 `param` — 본문에서 캡처한 값을
 * 스타일에 반영하는 통로)의 형식 어휘도 소유한다([`PARAM_FORMATS`]). 값이 등록값이 아니라
 * **문서 본문**에서 오므로 검증이 더 중요해질 뿐, 모델은 같다 — 호스트가 정규식과 검증기를
 * 둘 다 소유하고 저작자는 이름으로만 고른다.
 */
import { normalizeHexColor } from "../theme/theme";

/** 검증된 인라인 스타일 — CSS 속성(kebab) → 안전한 값 문자열. */
export type InlineStyle = Record<string, string>;

/**
 * 색 의미 토큰 → 앱 CSS 변수 레시피(단일 출처).
 *
 * 역할: 플러그인이 리터럴 색 대신 이름 토큰을 쓰면 호스트가 자기 변수로 해석한다 — 위키링크
 * 링크색이 테마 강조(`--memo-accent`)를, kbd 상자가 배경 대비(`--tb-on`)를 따라가게 한다.
 * 원문 `var()`는 플러그인이 못 쓰므로(이름 allowlist만) 변수 인젝션 표면이 없다.
 */
const SEMANTIC_COLOR_TOKENS: Record<string, string> = {
  accent: "var(--memo-accent, #37506a)",
  danger: "var(--memo-danger, #c0392b)",
  contrast: "rgb(var(--tb-on, 0, 0, 0))",
  "contrast-border": "rgba(var(--tb-on, 0, 0, 0), 0.3)",
  "contrast-fill": "rgba(var(--tb-on, 0, 0, 0), 0.08)",
};

/** 길이 토큰 하나(부호·소수 허용, 단위 px/em/rem/% 선택). */
const LENGTH = /^-?(\d+(\.\d+)?|\.\d+)(px|em|rem|%)?$/;

/** 리터럴 rgb()/rgba() — 괄호 안은 숫자·쉼표·%·공백만(문자 불가 → `var()`·`url()` 차단). */
const RGB_FUNC = /^rgba?\(\s*[\d.,%\s]+\)$/;

/** `blur(<len>)` 하나만 허용하는 filter 값(그 외 함수·url 차단). */
const BLUR_FUNC = /^blur\(\s*\d+(\.\d+)?(px|em|rem)?\s*\)$/;

/** 공백 구분 길이 1~4개(padding·border-radius 등). `0`은 단위 없이 허용. */
function lengthList(v: string): string | null {
  const parts = v.split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return null;
  return parts.every((p) => p === "0" || LENGTH.test(p)) ? v : null;
}

/** 정확히 이 키워드 집합 중 하나여야 통과(그 외 null). */
function keyword(set: readonly string[]): (v: string) => string | null {
  return (v) => (set.includes(v) ? v : null);
}

/**
 * 색 값 검증 — 의미 토큰(레시피로 해석) 또는 안전한 리터럴(hex·숫자 rgb/rgba)만.
 *
 * 왜: `var(--x)`·`url(...)` 같은 원문은 토큰 allowlist 밖이고 문자 포함 rgb 인자도 거르므로,
 * 색으로 위장한 인젝션이 통과하지 못한다.
 */
function colorValue(v: string): string | null {
  if (Object.prototype.hasOwnProperty.call(SEMANTIC_COLOR_TOKENS, v)) {
    return SEMANTIC_COLOR_TOKENS[v];
  }
  const hex = normalizeHexColor(v);
  if (hex !== null) return hex;
  return RGB_FUNC.test(v) ? v : null;
}

/** filter 값 — `none` 또는 `blur(<len>)`만(SVG url filter 등 차단). */
function filterValue(v: string): string | null {
  return v === "none" || BLUR_FUNC.test(v) ? v : null;
}

/** transition 값 — 속성명·시간·이징만(괄호·url 불가). */
function transitionValue(v: string): string | null {
  return /^[a-z0-9.,%\s-]+$/i.test(v) && !/url|expression/i.test(v) ? v : null;
}

/** font-family 값 — 글자·공백·쉼표·따옴표·하이픈만(괄호·url 불가). */
function fontFamilyValue(v: string): string | null {
  return /^[a-zA-Z0-9\s,'"-]+$/.test(v) ? v : null;
}

/** text-decoration 값 — none 또는 밑줄/취소선/윗줄 키워드 조합. */
function decorationValue(v: string): string | null {
  return /^(none|(underline|line-through|overline)(\s+(underline|line-through|overline))*)$/.test(
    v,
  )
    ? v
    : null;
}

/** vertical-align 값 — 키워드 또는 길이. */
function verticalAlignValue(v: string): string | null {
  return (
    keyword([
      "super",
      "sub",
      "baseline",
      "middle",
      "top",
      "bottom",
      "text-top",
      "text-bottom",
    ])(v) ?? lengthList(v)
  );
}

/** font-size 값 — 키워드 또는 길이. */
function fontSizeValue(v: string): string | null {
  return (
    keyword([
      "smaller",
      "larger",
      "small",
      "medium",
      "large",
      "x-small",
      "x-large",
      "xx-small",
      "xx-large",
    ])(v) ?? lengthList(v)
  );
}

/**
 * 허용 속성 표(입력 camelCase 키 → CSS 속성 + 값 검증기).
 *
 * 역할: "플러그인이 쓸 수 있는 스타일 속성"의 단일 출처. 색-값 속성(color·backgroundColor·
 * borderColor)은 의미 토큰을 받고, 나머지는 형식·키워드로 좁힌다. 표에 없는 속성(position·
 * content 등 레이아웃/유출 벡터)은 조용히 버린다.
 */
const PROPS: Record<
  string,
  { css: string; validate: (v: string) => string | null }
> = {
  color: { css: "color", validate: colorValue },
  backgroundColor: { css: "background-color", validate: colorValue },
  borderColor: { css: "border-color", validate: colorValue },
  borderWidth: { css: "border-width", validate: lengthList },
  borderStyle: {
    css: "border-style",
    validate: keyword(["solid", "dashed", "dotted", "double", "none"]),
  },
  borderRadius: { css: "border-radius", validate: lengthList },
  padding: { css: "padding", validate: lengthList },
  textDecoration: { css: "text-decoration", validate: decorationValue },
  textUnderlineOffset: {
    css: "text-underline-offset",
    validate: lengthList,
  },
  verticalAlign: { css: "vertical-align", validate: verticalAlignValue },
  fontSize: { css: "font-size", validate: fontSizeValue },
  fontWeight: {
    css: "font-weight",
    validate: (v) =>
      /^(normal|bold|bolder|lighter|[1-9]00)$/.test(v) ? v : null,
  },
  fontStyle: {
    css: "font-style",
    validate: keyword(["normal", "italic", "oblique"]),
  },
  fontFamily: { css: "font-family", validate: fontFamilyValue },
  filter: { css: "filter", validate: filterValue },
  transition: { css: "transition", validate: transitionValue },
  cursor: {
    css: "cursor",
    validate: keyword([
      "pointer",
      "default",
      "text",
      "help",
      "not-allowed",
      "grab",
      "grabbing",
      "move",
      "progress",
      "wait",
      "crosshair",
    ]),
  },
  opacity: {
    css: "opacity",
    validate: (v) => (/^(0|1|0?\.\d+)$/.test(v) ? v : null),
  },
};

/**
 * 플러그인이 줄 수 있는 스타일 속성 이름 전수(위 화이트리스트에서 유도 — 손으로 베끼지 않는다).
 *
 * 왜 export하나: 저작 계약의 단일 출처(`api-index.ts`)가 이 어휘를 그대로 실어 `.d.ts`·
 * `api-reference.json`의 `MemoInlineStyle` 타입을 만든다. 화이트리스트 밖 속성은 등록 시점에
 * **조용히 버려지므로**(오류가 아니다), 저작자·AI가 이름을 추측하면 그대로 무음 실패가 된다.
 */
export const INLINE_STYLE_PROPS: readonly string[] = Object.keys(PROPS);

/**
 * 패턴 **파라미터** 값 형식의 닫힌 어휘 — 형식마다 (1) 매칭에 쓸 정규식 조각과 (2) 캡처된
 * 값을 CSS 값으로 확정하는 검증기를 짝지어 소유한다.
 *
 * 왜 호스트가 정규식을 소유하나: 파라미터 값은 **문서 본문에서** 캡처되는 신뢰 못 할 문자열이고
 * 그대로 CSS 선언이 된다. 저작자가 정규식을 자유 기술하게 하면 (a) ReDoS 표면이 생기고 (b)
 * `red;background:url(...)` 같은 값이 통과할 수 있다. 형식을 닫힌 이름으로 고르게 하면 둘 다
 * 구조적으로 불가능하다 — 이 파일의 다른 모든 값 검증과 같은 모델이다.
 *
 * `hex-color`가 6자리를 먼저 시도하는 이유: `#ffffff`에서 3자리 대안이 먼저 맞으면 남은
 * `fff`가 close 리터럴과 어긋나 되짚기(backtrack)로만 6자리에 도달한다 — 결과는 같지만
 * "6자리를 먼저 본다"가 의도이므로 그대로 쓴다.
 */
const PARAM_FORMATS: Record<
  string,
  { source: string; validate: (v: string) => string | null }
> = {
  "hex-color": {
    source: "#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})",
    validate: normalizeHexColor,
  },
};

/** 파라미터 값 형식 이름 전수(등록 검증·계약 생성이 함께 쓰는 단일 출처). */
export const PATTERN_PARAM_FORMATS: readonly string[] =
  Object.keys(PARAM_FORMATS);

/**
 * 파라미터 캡처값을 반영할 수 있는 스타일 속성 전수 — **색 값을 받는 속성만**이다.
 *
 * 화이트리스트에서 유도한다(손으로 베끼지 않는다): `PROPS`에서 검증기가 `colorValue`인 것만
 * 고른다. 왜 색만인가: 지금 형식 어휘가 `hex-color` 하나뿐이라 다른 속성에 넣으면 형식이
 * 안 맞아 언제나 조용히 버려진다 — 등록 시점에 거부해 그 무음 실패를 없앤다.
 */
export const PATTERN_PARAM_APPLY_PROPS: readonly string[] = Object.entries(
  PROPS,
)
  .filter(([, spec]) => spec.validate === colorValue)
  .map(([key]) => key);

/** 형식 이름 → 매칭용 정규식 조각(모르는 이름이면 null — 호출 측이 "매치 없음"으로 처리). */
export function patternParamRegexSource(format: string): string | null {
  return Object.prototype.hasOwnProperty.call(PARAM_FORMATS, format)
    ? PARAM_FORMATS[format].source
    : null;
}

/**
 * 캡처된 파라미터 값을 **인라인 style 속성에 넣을 CSS 선언 한 줄**로 만든다(순수, 테스트용).
 *
 * 역할: (1) `apply`가 색 속성 화이트리스트에 있고 (2) 값이 그 형식 검증을 통과할 때만
 * `"color: #ffffff"` 같은 선언을 돌려준다. 하나라도 어긋나면 null(스타일을 붙이지 않는다).
 * 왜 여기인가: 정규식이 이미 형식을 강제하지만 **다시 검증한다** — 이 함수 하나가 문서 본문
 * → CSS로 가는 유일한 통로이므로, 호출 측(매칭 경로)이 바뀌어도 인젝션이 새지 않는다.
 * 값에 `;{}` 등이 남을 수 없으므로 style 속성 밖으로 탈출할 표면이 없다.
 */
export function renderParamStyleDeclaration(
  apply: string,
  format: string,
  raw: string,
): string | null {
  if (!PATTERN_PARAM_APPLY_PROPS.includes(apply)) return null;
  if (!Object.prototype.hasOwnProperty.call(PARAM_FORMATS, format)) return null;
  const spec = PARAM_FORMATS[format];
  if (typeof raw !== "string" || raw.length > 80) return null;
  const value = spec.validate(raw.trim());
  if (value === null) return null;
  return `${PROPS[apply].css}: ${value}`;
}

/**
 * 색 값 자리에 쓸 수 있는 의미 토큰 전수(그 외에는 hex·rgb() 리터럴).
 *
 * 같은 이유로 export한다 — 계약 산출물이 이 어휘를 그대로 싣는다.
 */
export const INLINE_STYLE_COLOR_TOKENS: readonly string[] = Object.keys(
  SEMANTIC_COLOR_TOKENS,
);

/**
 * 신뢰 못 할 스타일 객체를 검증된 [`InlineStyle`]로 정규화한다(순수, 테스트용).
 *
 * 역할: 허용 속성만, 형식 통과 값만 남긴다. 알 수 없는 속성·형식 오류 값은 조용히 버린다
 * (테마 토큰 정규화와 같은 관례). 하나도 안 남으면 null. 입력 키가 아니라 화이트리스트를
 * 순회하므로 `__proto__` 등 예약 키가 결과에 새지 않는다.
 */
export function normalizeInlineStyle(raw: unknown): InlineStyle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const out: InlineStyle = {};
  for (const [key, spec] of Object.entries(PROPS)) {
    const val = o[key];
    if (typeof val !== "string") continue;
    const s = val.trim();
    if (s === "" || s.length > 80) continue; // 길이 상한(장문 인젝션 방어).
    const ok = spec.validate(s);
    if (ok !== null) out[spec.css] = ok;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 패턴의 데코레이션·주입 CSS가 공유할 네임스페이스 클래스명을 만든다(단일 출처).
 *
 * 역할: 플러그인이 셀렉터/클래스를 정하지 못하게, 호스트가 `cm-x-<plugin>-<pattern>`으로
 * 파생한다. 영숫자 외 문자는 `-`로 치환해 항상 안전한 CSS 클래스 토큰이 되게 한다.
 * 왜: 플러그인이 `cm-cursor`·`cm-content` 같은 앱/CodeMirror 내부 클래스를 스타일로
 * 하이재킹하지 못하게 한다(스타일은 자기 데코레이션에만 적용).
 */
export function pluginPatternClass(
  pluginId: string,
  patternId: string,
): string {
  const safe = (s: string): string =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  return `cm-x-${safe(pluginId)}-${safe(patternId)}`;
}

/**
 * 검증된 스타일을 네임스페이스 CSS 규칙 텍스트로 렌더한다(순수, 테스트용).
 *
 * 역할: `.<class> { ... }` (+ 있으면 `.<class>:hover { ... }`)를 만든다. 값은 이미
 * [`normalizeInlineStyle`]을 통과했으므로 이스케이프 벡터가 없다. 노트 창은 이 텍스트를
 * `<style>` 요소의 textContent로 주입한다(HTML 재파싱 없음 — `</style>` 탈출 불가).
 */
export function renderInlineStyleCss(
  className: string,
  style?: InlineStyle | null,
  styleHover?: InlineStyle | null,
): string {
  const block = (selector: string, s: InlineStyle): string =>
    `.${selector} { ${Object.entries(s)
      .map(([k, v]) => `${k}: ${v};`)
      .join(" ")} }\n`;
  let css = "";
  if (style && Object.keys(style).length > 0) css += block(className, style);
  if (styleHover && Object.keys(styleHover).length > 0) {
    css += block(`${className}:hover`, styleHover);
  }
  return css;
}
