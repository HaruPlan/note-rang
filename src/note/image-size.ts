/**
 * 이미지 마크다운 alt 텍스트에 실린 크기 지정(`w=`/`h=`)을 파싱한다.
 *
 * 문법: `![w=300&h=200](url)`처럼 alt 자리에 `w=<px>`·`h=<px>` 토큰을 공백 또는 `&`로
 * 구분해 섞어 쓴다(둘 중 하나만, 순서 무관, 일반 설명 텍스트와도 혼용 가능 — 예:
 * `![설명 w=300](url)`). 둘 다 있으면 그 크기로, 하나만 있으면 나머지는 auto(원본 비율
 * 유지) — CSS에서 `aspect-ratio`/`auto`로 표현한다(`live-preview.ts`의 `ImageWidget` 참고).
 *
 * 왜 별도 파일인가: alt 파싱과 `![]() ` 자체 파싱(`parseImageMarkdown`)은 서로 다른
 * 관심사다 — 이쪽은 alt 문자열 하나만 입력받는 순수 함수라 GUI/에디터 없이 경계값
 * (0·음수·거대값·비정수·중복 토큰·w·h 순서·일반 텍스트 혼합)을 단위 테스트로 못박기 쉽다.
 */

/** 허용하는 픽셀 크기의 하한·상한(둘 다 포함) — 이 밖의 값은 "무효 토큰"으로 취급한다. */
export const MIN_IMAGE_SIZE = 16;
export const MAX_IMAGE_SIZE = 4096;

/** alt를 나눈 토큰 하나가 `w=<정수>`/`h=<정수>` 형식과 정확히 같은지(대소문자 무관). */
const SIZE_TOKEN_RE = /^([wh])=(\d+)$/i;

/**
 * [`parseImageAltSize`]의 결과 — 크기 토큰을 뗀 나머지 alt와 지정된 폭/높이(px, 없으면 null).
 *
 * 모듈 밖에서 쓰이지 않는다(반환값은 항상 곧바로 구조분해된다) — 그래서 export하지 않는다
 * (knip: unused exported type). 타입 자체는 [`parseImageAltSize`]의 반환형 문서화를 위해
 * 로컬로 유지한다.
 */
interface ParsedImageAltSize {
  alt: string;
  width: number | null;
  height: number | null;
}

/**
 * alt 원문에서 `w=`/`h=` 크기 토큰을 뽑아내고, 그것들을 뺀 나머지를 실제 alt로 돌려준다(순수).
 *
 * 규칙:
 * - 토큰 구분자는 공백 또는 `&`(둘 다 쿼리스트링처럼 섞어 써도 된다).
 * - 각 토큰은 `w=<정수>` 또는 `h=<정수>`와 **정확히** 일치해야 인식한다 — 부호(`w=-5`),
 *   소수(`w=1.5`), 접미사(`w=300px`)가 붙으면 그 토큰은 크기 지정이 아니라 그냥 alt
 *   글자로 남는다(항상 그대로 보존).
 * - 정수라도 [16, 4096] 범위를 벗어나면(`w=0`, `w=99999`) "무효 토큰"이라 형식이 다른
 *   토큰과 똑같이 취급한다 — **절대 제거하지 않고** alt 글자로 그대로 남긴다(리사이즈
 *   모드에서도 마찬가지). 그래야 규칙이 하나뿐이다: 유효(형식+범위 모두 만족)한 토큰만
 *   제거 대상이고, 그 밖은 뭐가 됐든(형식이 다르든 범위를 벗어나든) 항상 그대로 보존된다
 *   — 사용자가 뭐가 잘못됐는지(`w=0`, `h=99999` 등) 결과물에서 바로 보게 하는 효과도 있다.
 * - **유효 토큰이 하나도 없으면**(크기 토큰이 아예 없거나 전부 무효) 원본 alt를 한 글자도
 *   건드리지 않고 그대로 돌려준다(width/height 둘 다 null) — 기존 동작과 완전히 동일.
 * - 유효 토큰이 하나라도 있으면(리사이즈 모드) 그때는 **유효한** w/h 토큰만 alt에서
 *   제거하고 나머지 단어(무효 토큰 포함)는 공백 하나로 이어 붙여 alt로 돌려준다.
 * - 같은 키가 중복되면(`w=300 w=500`) 먼저 나온 값을 쓴다(쿼리스트링의 `get()` 관례) —
 *   단 중복된 유효 토큰들은 전부 alt에서 제거한다(찌꺼기 텍스트를 남기지 않기 위해).
 */
export function parseImageAltSize(rawAlt: string): ParsedImageAltSize {
  const tokens = rawAlt.split(/[\s&]+/).filter((token) => token.length > 0);

  let width: number | null = null;
  let height: number | null = null;
  const consumed = new Set<number>();

  tokens.forEach((token, index) => {
    const match = SIZE_TOKEN_RE.exec(token);
    if (!match) return; // 형식 자체가 다르면 alt 글자다(항상 보존).
    const value = Number(match[2]);
    if (value < MIN_IMAGE_SIZE || value > MAX_IMAGE_SIZE) return; // 범위 밖 = 무효 토큰.
    const key = match[1].toLowerCase();
    if (key === "w") {
      if (width === null) width = value;
    } else if (height === null) {
      height = value;
    }
    consumed.add(index); // 값 채택 여부와 무관하게(중복이어도) 유효 토큰은 제거 대상.
  });

  if (width === null && height === null) {
    return { alt: rawAlt, width: null, height: null }; // 기존 동작 그대로(원문 무변경).
  }

  const alt = tokens.filter((_, index) => !consumed.has(index)).join(" ");
  return { alt, width, height };
}

/** 크기 값 하나가 "지정"으로 인정되는지 — [16, 4096] 범위의 정수(파싱 규칙과 같은 잣대). */
function isValidSize(value: number | null): value is number {
  return (
    value !== null &&
    Number.isInteger(value) &&
    value >= MIN_IMAGE_SIZE &&
    value <= MAX_IMAGE_SIZE
  );
}

/**
 * [`parseImageAltSize`]의 역연산 — alt 원문에서 기존 크기 토큰을 떼고 새 w/h 토큰을 합성한다(순수).
 *
 * 우클릭 크기 조정 레이어가 문서에 되쓰는 유일한 경로다. 규칙:
 * - 기존 **유효** 토큰은 항상 제거된다(파싱과 같은 규칙이므로 `parseImageAltSize`의 결과 alt를
 *   그대로 쓴다) — 무효 토큰(`w=0`·`w=1.5` 등)은 파싱과 마찬가지로 **손대지 않는다**. 사용자가
 *   직접 적은 글자를 크기 조정이 몰래 지우지 않는다는 규칙 하나로 양방향이 일치한다.
 * - `width`/`height`가 null이거나 범위/정수 조건을 어기면 그 축의 토큰을 아예 쓰지 않는다
 *   (= auto). 둘 다 그러면 토큰 없이 alt만 남는다 — 「원본 크기로」가 이 경우다.
 * - 토큰은 alt **뒤**에 `w=…&h=…` 순으로 붙인다(문서화된 쿼리식 표기와 같은 모양).
 * - 크기 토큰을 하나도 붙이지 않고 기존 유효 토큰도 없었다면 원문 alt를 한 글자도 건드리지
 *   않고 그대로 돌려준다(파싱의 "무변경" 규칙과 대칭 — 공백까지 보존).
 *
 * 왕복 보장: `parseImageAltSize(serializeImageAltSize(alt, w, h))`는 유효한 w/h를 그대로 돌려주고,
 * alt 텍스트(무효 토큰 포함)도 보존한다.
 */
export function serializeImageAltSize(
  rawAlt: string,
  width: number | null,
  height: number | null,
): string {
  const { alt } = parseImageAltSize(rawAlt);
  const tokens: string[] = [];
  if (isValidSize(width)) tokens.push(`w=${width}`);
  if (isValidSize(height)) tokens.push(`h=${height}`);
  if (tokens.length === 0) return alt;
  // 토큰을 붙일 때만 양끝 공백을 다듬는다 — 안 그러면 `![ 설명 ](…)`이 `![ 설명  w=300](…)`이 된다.
  const base = alt.trim();
  const size = tokens.join("&");
  return base ? `${base} ${size}` : size;
}

/**
 * 크기 조정 다이얼로그의 입력 한 칸을 값으로 해석한다(순수) — 빈 값·무효 입력은 null(=auto).
 *
 * 빈 값과 무효 입력을 굳이 구분하지 않는 이유: 다이얼로그가 [`isValidImageSizeInput`]으로
 * 확인 버튼을 막고 있어 무효 입력은 애초에 여기까지 오지 않는다. 만약 온다면 "지정 없음"이
 * 가장 덜 파괴적인 해석이다(잘못된 크기를 문서에 박아 넣지 않는다).
 */
export function parseImageSizeInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // 빈 값·부호·소수점·단위 접미사 전부 여기서 걸린다.
  const value = Number(trimmed);
  return isValidSize(value) ? value : null;
}

/**
 * 크기 조정 다이얼로그의 입력 한 칸을 받아들일지 판정한다(순수) — **빈 값은 허용**(auto).
 *
 * 왜 빈 값이 유효한가: 한 축만 지정하면 나머지는 원본 비율로 계산된다는 것이 이 문법의 핵심이라,
 * "비움"은 실수가 아니라 뜻이 있는 입력이다. 그 밖에는 [16, 4096] 정수만 통과한다.
 */
export function isValidImageSizeInput(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === "" || parseImageSizeInput(trimmed) !== null;
}
