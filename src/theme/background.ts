/**
 * 노트 배경 능력 — 스와치 팔레트 + 자동 대비(테마와 분리된 별도 플러그인이 공급).
 *
 * 역할: "노트 종이색"을 고르는 능력을 정의한다. 배경 플러그인이
 * `memo.background.register(...)`로 제공하는 디스크립터([`BackgroundDescriptor`])와, 그 배경
 * 밝기에 맞춰 글자/툴바 대비를 정하는 순수 함수들을 담는다.
 * 왜: 배경(종이색)을 테마(색 토큰, [`./theme`])에서 떼어내 선택형 번들 플러그인으로 만든다 —
 * 테마는 색 지정만, 배경은 켜고 끌 수 있는 능력. 배경 플러그인을 끄면 스와치가 사라져(🎨
 * 숨김) 노트는 고정 배경을 쓴다.
 */
import { normalizeHexColor } from "./theme";

/**
 * 배경 플러그인이 `memo.background.register(...)`로 제공하는(정규화된) 디스크립터.
 *
 * 역할: 노트 배경으로 고를 수 있는 스와치 팔레트 + 배경 밝기에 따른 글자/버튼 자동 대비 여부.
 * 왜: 배경 선택 UI(🎨)와 대비 규칙을 테마가 아니라 이 능력이 결정하게 한다(플러그인 off면
 * 스와치 없음 → 🎨 사라지고 고정 배경).
 */
export interface BackgroundDescriptor {
  /** 노트 배경으로 제안할 색 스와치. 빈 배열이면 배경 선택 UI를 노출하지 않는다. */
  swatches: string[];
  /** 노트 배경 밝기에 맞춰 글자/버튼 틴트를 자동 대비할지. false면 고정 기본값. */
  autoTextContrast: boolean;
}

/** 배경 능력이 없을 때(플러그인 off)의 폴백 배경색 — 기존 기본 스티키 크림. */
export const DEFAULT_BACKGROUND_COLOR = "#fdf6e3";

/**
 * 기본 배경 능력(스와치·자동 대비) — 기본 활성 「배경색」 번들 플러그인이 등록하는 것과
 * 동일한 팔레트. 호스트 스냅샷이 아직 없을 때(early=null) 노트 창이 낙관적으로 쓰는 폴백이며,
 * 배경 플러그인 코드도 이 상수를 그대로 등록한다(단일 출처). 스냅샷이 도착하면(early!=null)
 * 그 값(플러그인 off면 null)을 존중한다.
 */
export const DEFAULT_BACKGROUND: BackgroundDescriptor = {
  swatches: ["#e5dbc3", "#e3ebd6", "#f4f4ef", "#fdf6e3"],
  autoTextContrast: true,
};

/**
 * 배경 플러그인이 준 알 수 없는 입력을 안전한 [`BackgroundDescriptor`]로 정규화한다
 * (순수, 테스트용).
 *
 * 역할: swatches(hex만 통과), autoTextContrast(불리언, 미지정/비불리언이면 기본 true)를
 * 검증·정규화한다. 인식 못 한 필드는 버린다.
 * 왜: 신뢰할 수 없는 플러그인 데이터로 CSS 인젝션·형식 오류가 새지 않게 등록 시점에 형태를
 * 못박는다(테마 정규화와 같은 규칙).
 */
export function normalizeBackgroundArgs(args: unknown): BackgroundDescriptor {
  const o =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const swatches = Array.isArray(o.swatches)
    ? o.swatches.map(normalizeHexColor).filter((c): c is string => c !== null)
    : [];
  // autoTextContrast는 명시적 불리언만 존중하고, 미지정/비불리언이면 기본 true(기존 동작).
  const autoTextContrast =
    typeof o.autoTextContrast === "boolean" ? o.autoTextContrast : true;
  return { swatches, autoTextContrast };
}

/**
 * 배경 스와치 유무로 배경 선택 UI(🎨 피커)를 노출할지 판정한다(순수, 테스트용).
 *
 * 역할: "스와치가 하나라도 있으면 배경 피커를 보인다"는 규칙을 한 곳에 고정한다.
 * 왜: 배경 능력이 없을 수 있음(플러그인 off·빈 팔레트)을 UI 경계에서 명시적으로 다룬다.
 */
export function hasBackgroundPicker(swatches: string[]): boolean {
  return swatches.length > 0;
}

/** `#rgb`·`#rrggbb` 색의 상대 밝기를 0~1로 구한다(파싱 실패 시 1=밝음). */
function relativeLuminance(color: string): number {
  const hex = color.trim().replace(/^#/, "");
  let r: number, g: number, b: number;
  if (hex.length === 3) {
    [r, g, b] = [hex[0], hex[1], hex[2]].map((c) => parseInt(c + c, 16));
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return 1;
  }
  if ([r, g, b].some(Number.isNaN)) return 1;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255; // WCAG 근사 밝기
}

/** 색이 밝은지 판정한다(툴바 틴트가 어두운 쪽이 어울리는지). 파싱 실패 시 밝음으로 간주. */
export function isLightColor(color: string): boolean {
  return relativeLuminance(color) > 0.55;
}

/** 노트 대비용 CSS 변수 값(툴바 버튼 틴트 rgb + 글자색). */
interface ContrastVars {
  /** `--tb-on`: 툴바 버튼 틴트의 rgb 성분("0, 0, 0" 또는 "255, 255, 255"). */
  tbOn: string;
  /** `--note-text`: 노트 글자색. */
  noteText: string;
}

/**
 * 노트 배경색과 배경 능력의 autoTextContrast에 따라 대비용 CSS 변수 값을 정한다
 * (순수, 테스트용).
 *
 * 역할: autoTextContrast면 배경 밝기에 맞춰(밝으면 어두운 틴트/글자, 어두우면 밝은 틴트/글자)
 * 자동 대비하고, false면 배경과 무관하게 고정 기본값(밝은 배경 기준: 어두운 틴트/글자)을 준다.
 * 왜: "배경이 대비를 자동 조정할지"를 한 곳에 고정하고, 샌드박스/DOM 없이 단위 테스트한다.
 */
export function contrastVars(
  color: string,
  autoTextContrast: boolean,
): ContrastVars {
  if (!autoTextContrast) {
    // 고정 기본값(밝은 배경 기준) — 배경이 대비를 스스로 책임지지 않겠다고 선언한 경우.
    return { tbOn: "0, 0, 0", noteText: "#1f2328" };
  }
  const light = isLightColor(color);
  return {
    tbOn: light ? "0, 0, 0" : "255, 255, 255",
    noteText: light ? "#1f2328" : "#f1f1ee",
  };
}

/**
 * 노트 배경 override 값을 실제 색으로 해석한다(없거나 이미지면 fallback 스와치/기본색).
 *
 * **값의 형식까지 검증한다**([`normalizeHexColor`] — 등록 경로와 같은 규칙). 여기서 나온
 * 문자열은 곧장 `style.background`로 들어가므로, 색이 아닌 값(옛 사이드카의 리터럴,
 * 손으로 고친 JSON, 다른 기기가 쓴 미래 형식 등)은 CSS가 **조용히 무시**한다 — 배경이 안
 * 바뀌는 것은 물론이고 대비 계산([`contrastVars`])도 파싱 실패로 "밝음"에 고정돼, 어두운
 * 색을 넣으면 글자가 안 읽히는 조합까지 나온다. 못 읽는 값은 fallback으로 떨어뜨리는 편이
 * 언제나 낫다(무음 실패 대신 알려진 색).
 */
export function resolveBackgroundColor(
  background: unknown,
  fallback: string,
): string {
  if (
    background &&
    typeof background === "object" &&
    "type" in background &&
    (background as { type: string }).type === "color" &&
    "value" in background
  ) {
    return (
      normalizeHexColor((background as { value: unknown }).value) ?? fallback
    );
  }
  return fallback;
}
