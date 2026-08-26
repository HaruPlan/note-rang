/**
 * 공유 설정 스냅샷 두 벌을 비교해 **무엇이 바뀌었는지**를 키 목록으로 내는 순수 모듈.
 *
 * 왜 필요한가: 설정 값 하나만 바꿔도 저장 → `notes-reload` → 중앙 호스트 재빌드 →
 * 열린 노트 창 전부 `location.reload()`가 돌았다. 이벤트가 "무엇이 바뀌었는지"를 싣지
 * 않으니 받는 쪽은 전부 다시 그리는 수밖에 없었고, 사용자에게는 색 하나 고칠 때마다
 * 모든 창이 깜빡이는 것으로 보인다. 여기서 바뀐 키를 뽑아내면, 그 키가 **전부** 국소
 * 반영 가능한 것(`LOCAL_APPLY_KEYS`)일 때만 가벼운 경로로 보낼 수 있다.
 *
 * 안전 원칙 — **화이트리스트만 쓴다**. 모르는 키(구버전·신규 필드·서드파티가 끼워 넣은
 * 값)는 언제나 무거운 리로드로 떨어져야 한다. 블랙리스트로 뒤집으면 새 설정 키가 하나
 * 생길 때마다 조용히 국소 경로를 타고 반영이 누락된다.
 *
 * DOM·Tauri 의존 없음(순수) — `note/toolbar-layout.ts`만 참조하며 그 모듈도 순수 데이터다.
 */
import { sameLayout, type ToolbarLayout } from "../note/toolbar-layout";

/**
 * diff가 다루는 공유 설정의 구조적 형태 — `settings.ts`의 `SettingsShape`와
 * `shared/tauri.ts`의 `SharedSettings`(둘 다 비공개)가 그대로 대입되는 최소 표면이다.
 * 알려진 키를 적어 두는 이유는 특별 취급(레이아웃·defaults)이 필요한 키의 타입을 잡기
 * 위해서이고, 비교 자체는 **양쪽 객체의 실제 키 합집합**을 훑는다(아래 참고).
 */
export interface DiffableSettings {
  schema_version?: number;
  theme?: string;
  theme_overrides?: Record<string, Record<string, string>>;
  keybindings?: Record<string, string>;
  toolbar_layout?: ToolbarLayout;
  toolbar_style?: string | null;
  language?: string | null;
  defaults?: unknown;
}

/**
 * 국소 반영이 가능한 변경 키(점 표기 포함) — 이 목록에 있는 키만 노트 창이 리로드 없이
 * 즉시 반영할 수 있다.
 *
 * - `theme_overrides` — 활성 테마 위에 얹는 사용자 색. 노트 창이 CSS 변수만 다시 쓴다.
 * - `defaults.font_size` — 전역 기본 글자 크기. 에디터 폰트만 다시 설정한다(메모 델타 보존).
 * - `defaults.font_family` — 전역 폰트 스택. 에디터의 폰트 패밀리 Compartment만 갈아 끼운다.
 *   이 값을 읽는 다른 창이 없다는 것이 국소 경로의 전제다(설정 창은 저장과 동시에 스스로
 *   미리보기를 갱신하고, 패널은 이 값을 아예 보지 않는다). 노트 창이 값만으로 판정하지
 *   못하는 부분(폰트 플러그인 on/off)은 능력 디스크립터로 게이팅한다 — 꺼져 있으면 저장값이
 *   있어도 시스템 기본이다(`theme/font.ts`의 `resolveFontFamily`).
 * - `toolbar_style` — 열린 창에는 이 값을 읽는 렌더 소비처가 없다("이미 물어봤다" 플래그와
 *   설정 창의 "기본 배치로 초기화" 기준일 뿐이다). 그래서 국소 경로에서 no-op으로 통과시켜,
 *   이 값만 바뀐 저장이 애먼 전체 리로드를 일으키지 않게 한다.
 *
 * `theme`·`keybindings`가 여기 **없는** 이유: 두 키는 값만으로는 반영할 수 없거나(테마는
 * 중앙 호스트가 테마 플러그인을 다시 돌려 새 디스크립터를 뽑아야 한다) 노트 창 밖에도
 * 소비처가 있다. 다만 재빌드 뒤의 제자리 조정은 가능하므로 그쪽 화이트리스트
 * (`host-update-plan.ts`의 `RECONCILE_SETTINGS_KEYS`)에는 들어 있다 — 두 집합은 같지 않다.
 */
export const LOCAL_APPLY_KEYS: readonly string[] = [
  "theme_overrides",
  "defaults.font_size",
  "defaults.font_family",
  "toolbar_style",
];

/**
 * 키 순서·삽입 순서와 무관한 안정적 직렬화(깊은 동등 비교용).
 *
 * 설정은 JSON IPC로 오가므로 값은 원시값·배열·평범한 객체뿐이다(함수·Symbol·순환 없음).
 * `undefined`는 JSON.stringify가 값을 돌려주지 않으므로 먼저 걸러 "없음"을 표현한다 —
 * `{ a: undefined }`와 `{}`가 같게 취급되는 것은 의도한 바다(둘 다 "그 값 없음").
 */
function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

/** 평범한 객체인가(배열·null 제외) — 서브키 단위로 쪼갤 수 있는 값인지의 판정. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `defaults`(타입이 `unknown`인 자유 형식 묶음)의 변경을 **서브키 단위**로 쪼갠다.
 *
 * 왜: 이 묶음에는 글자 크기·글꼴 등 성격이 다른 값이 섞여 있어, 통째로 "바뀜"으로 보면
 * 국소 반영 가능한 `font_size` 하나를 고쳐도 전체 리로드로 떨어진다. 양쪽 다 평범한
 * 객체일 때만 쪼개고, 하나라도 아니면(구버전 파일·null·배열) 통째로 `"defaults"` 변경으로
 * 취급한다 — 모르면 무거운 경로가 안전하다.
 */
function diffDefaults(prev: unknown, next: unknown): string[] {
  if (!isPlainObject(prev) || !isPlainObject(next)) {
    return stableJson(prev) === stableJson(next) ? [] : ["defaults"];
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys]
    .sort()
    .filter((k) => stableJson(prev[k]) !== stableJson(next[k]))
    .map((k) => `defaults.${k}`);
}

/**
 * 두 설정 스냅샷에서 바뀐 최상위 키를 낸다(`defaults`만 `defaults.<서브키>` 점 표기).
 *
 * 판정 규칙:
 * - 훑는 대상은 **양쪽 객체 키의 합집합**이다 — 한쪽에만 있는 키는 변경, 양쪽에 없는 키는
 *   애초에 등장하지 않는다. 알려진 필드 목록을 박아 두지 않는 이유는 새 설정 키가 생겨도
 *   자동으로 "변경"에 잡혀(그리고 화이트리스트 밖이라) 안전한 리로드로 떨어지게 하기 위해서다.
 * - `toolbar_layout`은 배치 모델의 정본 비교(`sameLayout`)를 쓴다 — `seen` 목록의 순서 같은
 *   의미 없는 차이로 "바뀜"이 되지 않는다.
 * - 나머지는 키 정렬 직렬화로 깊은 비교한다(`theme_overrides`·`keybindings`의 키 순서 무관).
 */
export function diffSettingsKeys(
  prev: DiffableSettings,
  next: DiffableSettings,
): string[] {
  // 인터페이스는 인덱스 시그니처를 갖지 않으므로(그러면 `SettingsShape`가 대입되지 않는다)
  // 키 단위 접근만 레코드로 좁혀 본다 — 읽기 전용 조회라 안전하다.
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (key === "defaults") {
      changed.push(...diffDefaults(prev.defaults, next.defaults));
      continue;
    }
    if (key === "toolbar_layout") {
      const layoutA = prev.toolbar_layout;
      const layoutB = next.toolbar_layout;
      // 둘 다 있을 때만 배치 비교로 판정한다(한쪽만 있으면 그 자체가 변경).
      const same =
        layoutA && layoutB ? sameLayout(layoutA, layoutB) : layoutA === layoutB;
      if (!same) changed.push(key);
      continue;
    }
    if (stableJson(a[key]) !== stableJson(b[key])) changed.push(key);
  }
  return changed;
}

/**
 * 이 변경 묶음을 열린 창들이 **리로드 없이** 반영할 수 있는가.
 *
 * 빈 목록은 false다 — "바뀐 게 없다"는 국소 반영 대상이 아니라 아무것도 하지 않을 일이다
 * (호출부가 이벤트 자체를 내지 않는다). 하나라도 화이트리스트 밖이면 false → 기존 리로드.
 */
export function isLocalOnlyChange(changedKeys: readonly string[]): boolean {
  return (
    changedKeys.length > 0 &&
    changedKeys.every((key) => LOCAL_APPLY_KEYS.includes(key))
  );
}
