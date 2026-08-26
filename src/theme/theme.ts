/**
 * 테마 토큰 시스템 + 빌트인 SJ_D 팔레트.
 *
 * 역할: 테마를 색 토큰 세트(CSS 변수)로 정의하고 문서에 적용한다 — 테마는 "색 지정"만
 * 담당한다(노트 배경 스와치·자동 대비는 별도 배경 플러그인, [`./background`]). 테마는 코드
 * 플러그인이 `memo.theme.register(...)`로 등록하는 디스크립터([`ThemeDescriptor`])로 표현되며,
 * 이 파일은 그 디스크립터를 정규화·적용하고 사용자 오버라이드를 병합하는 순수 로직을 담는다.
 * 왜: 외형(색)을 토큰으로 분리해 테마 교체·부분 커스터마이즈를 가능하게 한다.
 */

/**
 * 테마 플러그인이 `memo.theme.register(...)`로 제공하는(그리고 정규화된) 디스크립터.
 *
 * 역할: 활성 테마 하나가 공급하는 크롬 색 토큰(CSS 변수)을 담는다. 테마는 색만 지정하며,
 * 노트 배경(종이색)·자동 대비는 별도 배경 플러그인이 담당한다([`./background`]).
 */
export interface ThemeDescriptor {
  /** CSS 변수로 적용될 크롬 토큰(key → 색). 표면 토큰은 `<key>`(라이트) + `<key>-dark`(다크). */
  tokens: Record<string, string>;
}

/**
 * 의미색 토큰 — 라이트/다크 공통 단일 값(채도 높은 색이라 두 모드에서 다 통한다).
 * 이 토큰들에서 UI 전반의 틴트가 파생된다(색 편집기·color-mix).
 */
const SEMANTIC_TOKENS = ["accent", "danger", "warning"] as const;

/**
 * 표면 토큰 — 크롬(설정 창·패널·카드·다이얼로그)의 배경/테두리/글자색. 라이트와 다크 값을
 * **따로** 갖는다(`<key>`=라이트, `<key>-dark`=다크). 크롬은 시스템 외관을 따르므로 단일 값으론
 * 두 모드를 못 맞춘다 — 그래서 모드별 값을 둔다.
 *
 * `panel`/`panel-text`가 `surface`/`text`와 따로 있는 이유: 노트 목록·검색 패널 창은 늘 떠 있는
 * 좁은 창이라 설정 창과 같은 색을 강요받을 이유가 없다(사용자가 이 창만 어둡게 두는 식으로
 * 쓴다). 기본값은 `surface`/`text`와 같은 색이라 아무것도 안 바꾸면 지금과 똑같이 보인다.
 */
const SURFACE_TOKENS = [
  "surface",
  "card",
  "border",
  "text",
  "panel",
  "panel-text",
] as const;

/**
 * 커스터마이즈 가능한 테마 색 토큰(편집기가 순회하는 기본 키). 표면 토큰은 라이트/다크 두
 * 스와치로 편집된다. 토큰을 늘리려면 여기 한 곳만 고친다(등록 살균·병합·편집기가 공유).
 */
export const THEME_TOKENS = [...SEMANTIC_TOKENS, ...SURFACE_TOKENS] as const;

/** 표면(모드별) 토큰인가 — 라이트/다크 두 값을 갖는지. */
export function isSurfaceToken(key: string): boolean {
  return (SURFACE_TOKENS as readonly string[]).includes(key);
}

/**
 * 등록·병합이 인식하는 모든 토큰 키(의미색 + 표면 라이트 + 표면 `-dark`). 순수 화이트리스트.
 */
export const ALL_TOKEN_KEYS: readonly string[] = [
  ...SEMANTIC_TOKENS,
  ...SURFACE_TOKENS,
  ...SURFACE_TOKENS.map((k) => `${k}-dark`),
];

/**
 * 각 색 토큰의 기본값(테마·오버라이드가 없을 때의 폴백) — CSS `var(--memo-*, 폴백)`과 일치.
 * 표면 토큰은 라이트(`<key>`)와 다크(`<key>-dark`)를 모두 정의한다.
 */
export const THEME_TOKEN_DEFAULTS: Record<string, string> = {
  accent: "#37506a",
  danger: "#c0392b",
  warning: "#b7791f",
  surface: "#fbfbf8",
  "surface-dark": "#1f1f1f",
  card: "#ffffff",
  "card-dark": "#2b2b2b",
  border: "#dcdcd6",
  "border-dark": "#454545",
  text: "#1f2328",
  "text-dark": "#ededed",
  // 패널(노트 목록·검색 창)은 기본적으로 크롬 표면·글자와 같은 색이다 — 사용자가 이 창만
  // 따로 칠하고 싶을 때 갈라진다(기본값이 같으므로 미설정 상태에선 지금과 동일한 화면).
  panel: "#fbfbf8",
  "panel-dark": "#1f1f1f",
  "panel-text": "#1f2328",
  "panel-text-dark": "#ededed",
};

/**
 * 사용자가 테마 색을 편집하면 그 테마의 파생 변형을 "{테마}<custom>"으로 임시 저장한다.
 * 이 접미가 변형 표식 — 로드 시엔 벗겨 베이스 테마 코드로 해석하고(active-theme), 색
 * 오버라이드는 변형 이름으로 키잉해 적용 말단에서 얹는다.
 */
export const CUSTOM_THEME_SUFFIX = "<custom>";

/** 테마 이름에서 "<custom>" 접미를 벗겨 베이스 테마 이름을 얻는다(없으면 그대로). */
export function baseThemeName(name: string): string {
  return name.endsWith(CUSTOM_THEME_SUFFIX)
    ? name.slice(0, -CUSTOM_THEME_SUFFIX.length)
    : name;
}

/** 빌트인 "SJ_D" 테마 디스크립터(차분한 딥블루 강조) — 안전 폴백 겸 기본 테마. */
export const SJ_D: ThemeDescriptor = {
  tokens: {
    accent: "#37506a",
    danger: "#c0392b",
    warning: "#b7791f",
    surface: "#fbfbf8",
    "surface-dark": "#1f1f1f",
    card: "#ffffff",
    "card-dark": "#2b2b2b",
    border: "#dcdcd6",
    "border-dark": "#454545",
    text: "#1f2328",
    "text-dark": "#ededed",
    panel: "#fbfbf8",
    "panel-dark": "#1f1f1f",
    "panel-text": "#1f2328",
    "panel-text-dark": "#ededed",
  },
};

/**
 * 알 수 없는 색 값을 `#rgb`/`#rrggbb` 형식 문자열로만 정규화한다(그 외는 버림).
 *
 * 왜: 플러그인이 준 토큰·스와치에 스크립트·잘못된 CSS가 섞이지 않게 형식을 강제한다
 * (스타일 인젝션 방지). 테마([`normalizeThemeArgs`])·배경([`./background`]) 정규화가 공유한다.
 */
export function normalizeHexColor(value: unknown): string | null {
  return typeof value === "string" &&
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
    ? value.trim()
    : null;
}

/**
 * 테마 플러그인이 `memo.theme.register(args)`로 준 알 수 없는 입력을 안전한
 * [`ThemeDescriptor`]로 정규화한다(순수, 테스트용).
 *
 * 역할: tokens([`THEME_TOKENS`] 키만, hex 형식만)만 인정한다. 인식 못 한 필드는 버린다.
 * 왜: 신뢰할 수 없는 플러그인 데이터로 CSS 인젝션·형식 오류가 새지 않게 등록 시점에 형태를
 * 못박는다. 샌드박스 iframe과 분리해 이 로직만 단위 테스트할 수 있게 한다.
 */
export function normalizeThemeArgs(args: unknown): ThemeDescriptor {
  const o =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};

  const tokens: Record<string, string> = {};
  const rawTokens =
    typeof o.tokens === "object" && o.tokens !== null
      ? (o.tokens as Record<string, unknown>)
      : {};
  for (const key of ALL_TOKEN_KEYS) {
    const color = normalizeHexColor(rawTokens[key]);
    if (color !== null) tokens[key] = color;
  }

  return { tokens };
}

/**
 * 테마 토큰을 CSS 변수로 root에 적용한다.
 *
 * 의미색(accent 등)은 `--memo-<key>`로 두 모드 공통. 표면 토큰은 모드별 소스 변수로 얹는다:
 * 라이트 값 `<key>` → `--memo-<key>-light`, 다크 값 `<key>-dark` → `--memo-<key>-dark`. 실제
 * `--memo-<key>`는 스타일시트가 `-light`/`-dark`에서 모드에 맞게 고른다(인라인이 @media를
 * 덮어써 다크가 안 먹는 문제를 피하려고, 인라인엔 소스 변수만 두고 최종 선택은 스타일시트가 한다).
 */
export function applyTheme(root: HTMLElement, theme: ThemeDescriptor): void {
  for (const [key, value] of Object.entries(theme.tokens)) {
    if (isSurfaceToken(key)) {
      root.style.setProperty(`--memo-${key}-light`, value);
    } else if (key.endsWith("-dark") && isSurfaceToken(key.slice(0, -5))) {
      root.style.setProperty(`--memo-${key}`, value); // --memo-<k>-dark
    } else {
      root.style.setProperty(`--memo-${key}`, value); // 의미색(공통)
    }
  }
}

/**
 * 테마 디스크립터에 사용자 색 오버라이드를 얹어 새 디스크립터를 만든다(순수, 테스트용).
 *
 * 역할: 테마가 공급한 기본 팔레트(tokens) 위에, 사용자가 테마별로 지정한 색을 덮어쓴다
 * (VSCode의 colorCustomizations와 같은 개념 — 테마 산출물이 아니라 사용자 소유 레이어).
 * [`THEME_TOKENS`]에 속한 키만, [`normalizeHexColor`]를 통과한 값만 반영한다.
 * 왜: 오버라이드를 테마 코드와 분리해 신뢰 경계(적용 말단)에서 안전하게 합치고, 샌드박스
 * 없이 단위 테스트한다. 입력 디스크립터는 변형하지 않는다(변경 없으면 원본 그대로 반환).
 */
export function mergeThemeOverrides(
  theme: ThemeDescriptor,
  overrides: Record<string, string> | null | undefined,
): ThemeDescriptor {
  if (!overrides) return theme;
  const tokens = { ...theme.tokens };
  let changed = false;
  for (const key of ALL_TOKEN_KEYS) {
    const color = normalizeHexColor(overrides[key]);
    if (color !== null) {
      tokens[key] = color;
      changed = true;
    }
  }
  return changed ? { ...theme, tokens } : theme;
}
