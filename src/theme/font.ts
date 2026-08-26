/**
 * 폰트 능력 — 선택 가능한 폰트 패밀리(플러그인이 공급, 테마·배경과 분리된 별도 능력).
 *
 * 역할: "글자 폰트"를 고르는 능력을 정의한다. 폰트 플러그인이 `memo.font.register(...)`로
 * 제공하는 디스크립터([`FontDescriptor`])와 그 살균 로직을 담는다. 사용자가 고른 패밀리는
 * 전역 설정(`NoteDefaults.font_family`)에 저장되고 노트 에디터에 적용된다.
 * 왜: 폰트를 테마(색)·배경(종이색)에서 떼어내 선택형 번들 플러그인으로 만든다 — 색이 있으니
 * 글자(폰트)도, 플러그인으로 확장 가능하게. 플러그인이 패밀리 목록을 넓히면 피커가 따라 넓어진다.
 */
import { t } from "../i18n/t";

/**
 * 고를 수 있는 폰트 패밀리 한 줄(피커의 1행).
 *
 * `korean`·`system`은 **호스트가 채우는** 출처 표시다 — 플러그인이 등록 때 넣어도
 * [`normalizeFontArgs`]가 떼어낸다. 피커의 구역 나누기가 플러그인 말이 아니라 호스트가 아는
 * 사실(OS 열거 결과)만 따르게 하기 위함이다.
 */
export interface FontFamily {
  /** 표시명. */
  label: string;
  /** CSS 폰트 스택. */
  stack: string;
  /** 한글 글리프를 담은 글꼴 — 피커가 「한글」 구역으로 올린다(시스템 열거만 채운다). */
  korean?: boolean;
  /** OS에 설치된 글꼴에서 온 항목 — 피커가 플러그인 공급분과 구역을 나눈다. */
  system?: boolean;
  /**
   * 지역화 이름 — **표시가 아니라 검색어로만** 쓴다(시스템 열거만 채운다).
   *
   * 왜: 스택에 넣는 정규 이름은 영문("NanumGothic")이라, 한글로 "나눔"을 친 사용자가
   * 아무것도 못 찾는다. 보이는 이름은 영문 하나로 두되 검색에는 둘 다 걸리게 한다.
   */
  alias?: string;
}

/**
 * 폰트 플러그인이 `memo.font.register(...)`로 제공하는(정규화된) 디스크립터.
 *
 * 역할: 설정 폰트 피커에 노출할 폰트 패밀리 목록(라벨 + CSS 폰트 스택)을 담는다.
 * 왜: "어떤 폰트를 고를 수 있나"를 테마가 아니라 이 능력이 결정하게 한다(플러그인 off면
 * 패밀리 없음 → 피커 숨김, 시스템 기본 폰트).
 */
export interface FontDescriptor {
  /** 고를 수 있는 폰트 패밀리 — 라벨(표시명)과 CSS 폰트 스택. 빈 배열이면 피커를 숨긴다. */
  families: FontFamily[];
  /**
   * OS에 설치된 글꼴도 후보에 넣을지 — 목록은 플러그인이 아니라 **호스트가 열거해** 붙인다.
   *
   * 왜 목록이 아니라 플래그인가: 열거 결과의 출처(시스템/한글 여부)를 호스트가 쥐고 있어야
   * 피커가 구역을 믿고 나눌 수 있고, 수백 벌짜리 목록이 샌드박스 경계를 왕복하지 않는다.
   */
  includeSystem?: boolean;
}

/**
 * 폰트 능력을 등록하는 기본 「폰트」 번들 플러그인이 제공하는 패밀리(단일 출처).
 *
 * 함수인 이유: `plugin/builtin.test.ts`의 가드가 이 값을 번들 `font` 플러그인의 실제
 * `main.js` 등록값과 동치 비교해 "단일 출처"를 못박는다(둘이 조용히 갈라지는 걸 막는다).
 * 라벨에 `t()`를 쓰므로, 모듈 상단 `const`로 한 번만 구우면 창 로드 시점(`setActiveLocale()`
 * 보다 항상 먼저)의 로케일로 영원히 고정된다(§i18n 규약) — 호출 시점 평가로 그 함정을 없앤다.
 * 가드 자체는 두 값 모두 앱 기본 로케일(ko)에서 비교하므로 이 변경으로 결과가 달라지지 않는다.
 */
export const DEFAULT_FONT = (): FontDescriptor => ({
  families: [
    {
      label: t("theme.font.system"),
      stack:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    },
    {
      label: t("theme.font.serif"),
      stack: "Georgia, 'Times New Roman', serif",
    },
    {
      label: t("theme.font.monospace"),
      stack: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  ],
  includeSystem: true,
});

/**
 * CSS 폰트-패밀리 스택을 안전한 값으로만 정규화한다(그 외는 버림).
 *
 * 왜: 스택은 결국 스타일 속성 값(에디터 `EditorView.theme`)에 들어가므로, CSS 이탈 문자
 * (`;`·`{`·`}`·`<`·`>`·`\`)가 있으면 스타일 인젝션이 될 수 있다 — 등록 시점에 거른다. 한글 등
 * 유니코드 폰트명은 허용하되(블랙리스트 방식), 위험 문자만 차단한다.
 */
function normalizeFontStack(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s.length === 0 || s.length > 200) return null;
  return /[;{}<>\\]/.test(s) ? null : s;
}

/**
 * 폰트 플러그인이 준 알 수 없는 입력을 안전한 [`FontDescriptor`]로 정규화한다(순수, 테스트용).
 *
 * 역할: families 배열의 각 항목에서 label(비어있지 않은 문자열)·stack(안전한 폰트 스택)만
 * 통과시킨다. 형식이 안 맞는 항목은 버린다. 출처 표시(korean·system)는 호스트가 채우는
 * 값이라 플러그인이 넣어도 **떼어낸다**.
 * 왜: 신뢰할 수 없는 플러그인 데이터로 스타일 인젝션·형식 오류가 새지 않게 등록 시점에 형태를
 * 못박는다(테마·배경 정규화와 같은 규칙). 출처를 호스트가 쥐어야 피커의 구역 나누기가
 * 플러그인 말이 아니라 실제 OS 열거 결과를 따른다.
 */
export function normalizeFontArgs(args: unknown): FontDescriptor {
  const o =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const families = Array.isArray(o.families)
    ? o.families
        .map((f) => {
          if (typeof f !== "object" || f === null) return null;
          const label = (f as Record<string, unknown>).label;
          const stack = normalizeFontStack(
            (f as Record<string, unknown>).stack,
          );
          if (
            typeof label !== "string" ||
            label.trim() === "" ||
            stack === null
          )
            return null;
          return { label: label.trim(), stack };
        })
        .filter((f): f is FontFamily => f !== null)
    : [];
  return o.includeSystem === true
    ? { families, includeSystem: true }
    : { families };
}

/**
 * 공유 설정에서 사용자가 고른 폰트 스택을 읽는다(없거나 빈 문자열이면 null = 시스템 기본).
 *
 * 왜 여기 있나: 이 값을 읽는 곳이 셋이다 — 노트 창 마운트(`bootstrap/note.ts`), 국소 설정
 * 반영(`bootstrap/note-local-apply.ts`), 재빌드 후 제자리 조정(`bootstrap/host-update-plan.ts`).
 * 규칙이 세 벌이면 "새로 연 창과 열려 있던 창의 글꼴이 다르다"가 된다(`defaultFontPx`와 같은 결).
 */
export function savedFontFamily(
  settings: { defaults?: unknown } | null | undefined,
): string | null {
  const stack = (
    settings?.defaults as { font_family?: unknown } | null | undefined
  )?.font_family;
  return typeof stack === "string" && stack.length > 0 ? stack : null;
}

/**
 * 이 창에 실제로 적용할 폰트 스택을 낸다 — **능력(`font`)이 없으면 저장값을 무시한다**.
 *
 * 왜 게이트가 필요한가: 폰트 능력은 플러그인이 공급한다(끄면 피커도 사라진다). 꺼 둔 사용자의
 * 창에 예전 저장값이 새어 들어가면 "플러그인을 껐는데 글꼴이 그대로"가 된다 — 배경 능력의
 * "끄면 고정 배경"과 대칭이다. `undefined`(=지정 없음)는 에디터가 시스템 기본으로 해석한다.
 */
export function resolveFontFamily(
  font: FontDescriptor | null | undefined,
  saved: string | null | undefined,
): string | undefined {
  return font && typeof saved === "string" && saved.length > 0
    ? saved
    : undefined;
}

/**
 * 백엔드가 열거한 시스템 글꼴을 피커 후보 행으로 정규화한다(순수, 테스트용).
 *
 * 스택은 `"<패밀리>", sans-serif` — 설치된 글꼴이라 첫 항목이 잡히고, 뒤의 폴백은 그 글꼴에
 * 없는 글리프(예: 라틴 전용 글꼴의 한글)를 대신 그리는 몫이다.
 *
 * 입력이 `unknown`인 이유: 이 값은 IPC 응답이다. 형태가 어긋나면(백엔드 부재·목·구버전)
 * 조용히 빈 목록이 돼야 한다 — 던지면 호스트 빌드가 통째로 죽어 플러그인이 전부 사라진다.
 * 이름을 따옴표로 감싸므로 **따옴표가 든 이름은 여기서 버린다**(백엔드도 거부하지만, 이
 * 함수만 보고도 스택이 깨질 수 없어야 한다). 나머지 CSS 이탈 문자는 스택 정규화가 잡는다.
 */
export function systemFontFamilies(fonts: unknown): FontFamily[] {
  if (!Array.isArray(fonts)) return [];
  return fonts.flatMap((entry): FontFamily[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { family, korean, alias } = entry as Record<string, unknown>;
    if (typeof family !== "string" || /["']/.test(family)) return [];
    const stack = normalizeFontStack(`"${family}", sans-serif`);
    if (stack === null) return [];
    return [
      {
        label: family,
        stack,
        korean: korean === true,
        system: true,
        ...(typeof alias === "string" && alias !== "" ? { alias } : {}),
      },
    ];
  });
}

/**
 * 여러 폰트 플러그인이 등록한 패밀리 목록을 하나로 합친다(순수, 테스트용).
 *
 * 역할: 등록 순서를 보존하며 이어 붙이고, 같은 스택이 두 번 나오면 먼저 온 것만 남긴다
 * (라벨이 달라도 스택이 같으면 고르는 결과가 같으므로 중복 행이다).
 * 왜: 폰트는 창 컨트롤처럼 여러 플러그인이 각자 후보를 공급할 수 있는 능력이다 — 첫 등록만
 * 채택하면 빌트인 「폰트」를 끄지 않는 한 외부 폰트 플러그인이 통째로 무시된다.
 */
export function mergeFontFamilies(
  lists: FontDescriptor["families"][],
): FontDescriptor["families"] {
  const seen = new Set<string>();
  const merged: FontDescriptor["families"] = [];
  for (const list of lists) {
    for (const family of list) {
      if (seen.has(family.stack)) continue;
      seen.add(family.stack);
      merged.push(family);
    }
  }
  return merged;
}

/**
 * 피커에 실제로 그려지는 한 행 — 패밀리에 "시스템 기본"(`stack: null`) 같은 특수 행을 더한 것.
 *
 * 왜 별도 타입인가: "시스템 기본"과 "사용자 지정"은 플러그인이 공급한 패밀리가 아니라 피커가
 * 만들어 내는 행이라 스택이 없을 수 있다. 구역 나누기·끌어올리기를 이 타입 위에서 하면
 * 특수 행도 같은 규칙을 탄다.
 */
export interface FontRow extends Omit<FontFamily, "stack"> {
  /** CSS 폰트 스택. `null`이면 "시스템 기본"(폰트 미지정). */
  stack: string | null;
}

/** 글꼴 피커의 한 구역(머리글 + 그 아래 행들). */
interface FontGroup {
  /** 구역 머리글. */
  title: string;
  rows: FontRow[];
}

/**
 * 이 행 수를 넘으면 "긴 목록"으로 본다 — 검색칸 노출과 선택 행 끌어올리기가 같이 켜진다.
 *
 * 왜 한 값인가: 둘 다 "한 화면에 다 안 보인다"는 같은 조건에 달려 있다. 따로 두면 검색은
 * 떠 있는데 고른 글꼴은 저 아래 묻혀 있는 어중간한 구간이 생긴다.
 */
export const FONT_LIST_LONG_ROWS = 6;

/**
 * 피커 후보를 구역으로 나눈다(순수, 테스트용) — 「지금 글꼴」 · 「기본」 · 「한글」 · 「설치된 글꼴」.
 *
 * 왜: 설치 글꼴을 붙이면 목록이 300행을 넘는다. 평평하게 쏟으면 매일 쓰는 몇 개가 묻히고,
 * 한글 메모에 쓸 수 없는 라틴 전용 글꼴이 대부분을 차지한다. 자주 쓰는 것부터 위로 올린다.
 * 비어 있는 구역은 내보내지 않으므로, 설치 글꼴이 없으면(능력 off·비macOS) 구역이 하나만
 * 남는다 — 호출부는 그때 머리글을 그리지 않아 지금과 똑같은 목록이 된다.
 *
 * 목록이 길면([`FONT_LIST_LONG_ROWS`] 초과) 지금 고른 행을 맨 위 「지금 글꼴」로 **옮긴다**
 * (복제가 아니다 — 같은 글꼴이 두 줄로 체크돼 있으면 어느 쪽이 진짜인지 헷갈리고, 구역
 * 개수도 거짓이 된다). 짧은 목록은 어차피 한눈에 다 보이므로 그대로 둔다 — 없어도 되는
 * 머리글을 만들지 않기 위함이다.
 */
export function groupFontRows(
  rows: FontRow[],
  selected: string | null,
): FontGroup[] {
  const hoisted =
    rows.length > FONT_LIST_LONG_ROWS
      ? rows.find((row) => row.stack === selected)
      : undefined;
  const rest = rows.filter((row) => row !== hoisted);
  return [
    ...(hoisted
      ? [{ title: t("theme.font.group-current"), rows: [hoisted] }]
      : []),
    {
      title: t("theme.font.group-bundled"),
      rows: rest.filter((r) => !r.system),
    },
    {
      title: t("theme.font.group-korean"),
      rows: rest.filter((r) => r.system && r.korean),
    },
    {
      title: t("theme.font.group-installed"),
      rows: rest.filter((r) => r.system && !r.korean),
    },
  ].filter((group) => group.rows.length > 0);
}

/** 폰트 패밀리 유무로 폰트 피커를 노출할지 판정한다(순수, 테스트용). */
export function hasFontPicker(
  families: { label: string; stack: string }[],
): boolean {
  return families.length > 0;
}
