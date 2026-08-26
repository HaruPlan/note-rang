/**
 * 노트 창의 **국소 설정 반영기** — `settings-changed-local`이 실어 온 "바뀐 키"를 창을
 * 리로드하지 않고 제자리에서 적용하는 순수 매핑.
 *
 * 왜 별도 모듈인가: 배선(`bootstrap/note.ts`)은 Tauri 이벤트·IPC와 얽혀 단위 테스트가 어렵다.
 * "어떤 키가 무엇을 바꾸는가"라는 규칙만 여기로 떼어 내면, 리스너는 조회·위임만 남고 규칙은
 * DOM 없이 검증된다. 마운트 시점의 해석(`themeOverrides`·`baseFontPx`를 설정에서 뽑는 규칙)도
 * 여기서 공유한다 — 두 경로가 갈리면 "새로 연 창과 열려 있던 창의 색이 다르다"가 된다.
 *
 * 화이트리스트는 `settings-diff.ts`의 `LOCAL_APPLY_KEYS`가 정본이고, 이 모듈의 적용기 맵은
 * 그것과 **같은 키 집합**이어야 한다(테스트가 못박는다). 보내는 쪽·받는 쪽이 어긋나면 통지가
 * 조용히 버려지거나(받는 쪽에 없음) 반쯤만 반영된다.
 */

import { savedFontFamily } from "../theme/font";

/**
 * 국소 반영이 읽는 공유 설정의 최소 표면(`SharedSettings`가 구조적으로 대입된다).
 * export하지 않는다 — 호출부는 구조적으로 검사되므로 이름이 필요 없다(knip 미사용 export 방지).
 */
interface LocalApplySettings {
  theme?: string;
  theme_overrides?: Record<string, Record<string, string>>;
  defaults?: unknown;
}

/** 적용 대상 — 노트 창 핸들(`NoteWindowHandle`)이 구조적으로 만족한다. */
interface LocalApplyTarget {
  applyThemeOverrides(overrides: Record<string, string> | null): void;
  applyBaseFontPx(px: number): void;
  applyFontFamily(saved: string | null): void;
}

/**
 * 활성 테마에 해당하는 사용자 색 오버라이드를 고른다(없으면 빈 맵).
 *
 * 마운트(`bootstrap/note.ts`가 `mountNoteWindow`에 넘기는 `themeOverrides`)와 국소 반영이
 * **같은 함수**를 써야 한다 — 규칙이 두 벌이면 한쪽만 커스텀 테마 접미(`<custom>`) 같은
 * 세부를 놓쳤을 때 조용히 갈린다.
 */
export function activeThemeOverrides(
  settings: LocalApplySettings | null | undefined,
): Record<string, string> {
  return (settings?.theme_overrides ?? {})[settings?.theme ?? ""] ?? {};
}

/** 전역 기본 글자 크기(px)를 설정에서 읽는다(없거나 형식이 다르면 14 — 설정 창과 같은 폴백). */
export function defaultFontPx(
  settings: LocalApplySettings | null | undefined,
): number {
  const px = (settings?.defaults as { font_size?: unknown } | null | undefined)
    ?.font_size;
  return typeof px === "number" ? px : 14;
}

/**
 * 키 → 적용기. 여기 **없는 키는 국소 반영할 수 없다**는 뜻이다(호출부가 통째로 무시한다).
 *
 * `toolbar_style`이 no-op인 이유: 열려 있는 노트 창에는 이 값을 읽는 렌더 소비처가 없다
 * (최초 실행 프롬프트의 "이미 물어봤다" 플래그 겸 설정 창의 기본 배치 기준일 뿐이다).
 * 그래도 맵에 넣어 두는 쪽이 맞다 — 빼면 이 값만 바뀐 저장이 화이트리스트 밖으로 떨어져
 * 애먼 전체 리로드를 부른다.
 *
 * `Map`인 이유: 평범한 객체에 `in`/인덱스 조회를 쓰면 `"toString"` 같은 프로토타입 키가
 * "아는 키"로 통과한다.
 */
const APPLIERS = new Map<
  string,
  (settings: LocalApplySettings, target: LocalApplyTarget) => void
>([
  [
    "theme_overrides",
    (settings, target) =>
      target.applyThemeOverrides(activeThemeOverrides(settings)),
  ],
  [
    "defaults.font_size",
    (settings, target) => target.applyBaseFontPx(defaultFontPx(settings)),
  ],
  [
    // 값(저장된 스택)만 넘긴다 — 폰트 플러그인이 켜져 있는지(능력 게이트)는 창이 들고 있는
    // 사실이지 설정에 적힌 값이 아니다(`theme/font.ts`의 `resolveFontFamily`가 정본).
    "defaults.font_family",
    (settings, target) => target.applyFontFamily(savedFontFamily(settings)),
  ],
  ["toolbar_style", () => {}],
]);

/**
 * 이 키 묶음을 전부 국소 반영할 수 있는가 — 하나라도 모르는 키가 있으면 false.
 *
 * 호출부는 이 판정을 **설정 재조회보다 먼저** 한다: 어차피 무시할 통지에 IPC 왕복을 쓰지
 * 않기 위해서다. 빈 목록도 false다(적용할 것이 없다).
 */
export function canApplyLocally(changedKeys: readonly string[]): boolean {
  return changedKeys.length > 0 && changedKeys.every((k) => APPLIERS.has(k));
}

/**
 * 바뀐 키를 순서대로 적용한다. 모르는 키가 섞여 있으면 **하나도** 적용하지 않는다 —
 * 반쯤 반영된 상태(색은 새 값, 글자 크기는 옛 값)를 만들지 않기 위한 방어다.
 */
export function applyLocalSettingChanges(
  changedKeys: readonly string[],
  settings: LocalApplySettings,
  target: LocalApplyTarget,
): void {
  if (!canApplyLocally(changedKeys)) return;
  for (const key of changedKeys) APPLIERS.get(key)?.(settings, target);
}

/** 적용기가 아는 키 전부(드리프트 가드 테스트가 화이트리스트와 대조한다). */
export function localApplyKeys(): string[] {
  return [...APPLIERS.keys()];
}

/**
 * 프라미스에 시간 상한을 씌우고, 넘기면 예외 대신 `null`로 접는다.
 *
 * 왜 필요한가: `getSharedSettings`·`getVaultPath`(`shared/tauri.ts`)는 순수 `invoke`라
 * 자체 상한이 없다. `applyHostUpdate`의 재조회처럼 `fetchHostSnapshot`(자체 상한 있음)과
 * 함께 `Promise.all`로 묶이면, 이 둘 중 하나가 영영 응답하지 않을 때 스냅샷이 먼저
 * 끝나도 묶음 전체가 절대 해소되지 않는다 — "모르면 리로드" 판정기까지 입력이 도달하지
 * 못해 창이 옛 상태로 조용히 남는다(무음 실패). 값 대신 예외를 던지지 않는 이유는 호출부
 * (`Promise.all(...).then(...)`)가 이미 개별 실패를 `null`로 접는 관례(`.catch(() => null)`)를
 * 따르고 있어, 타임아웃도 같은 모양으로 맞춰야 한쪽만 reject를 신경 쓰는 비대칭이 안 생긴다.
 * 원본 프라미스가 나중에 실제로 정착해도(성공이든 거부든) 이미 상한을 넘겨 해소된 뒤라
 * 결과를 조용히 버린다(중복 해소 없음).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * 통지를 **최신 우선**으로 처리하는 큐를 만든다 — 통지마다 최신 상태를 재조회하고, 가장
 * 나중에 들어온 통지의 응답만 적용한다.
 *
 * 소비처는 노트 창의 두 리스너다(`bootstrap/note.ts`):
 * - `EV_SETTINGS_CHANGED_LOCAL` — 항목은 바뀐 설정 키, 재조회는 공유 설정.
 * - `EV_HOST_UPDATED` — 항목은 재빌드 사유, 재조회는 설정 + 스냅샷 + vault 경로 묶음.
 *
 * 패널 창(`bootstrap/panel.ts`)도 색 오버라이드 반영에 같은 큐를 쓴다(`activeThemeOverrides`와
 * 함께) — 규칙이 두 벌이면 두 창의 색이 갈린다는 이 파일의 전제가 그쪽에도 그대로 적용된다.
 *
 * 왜 필요한가: 통지마다 독립적으로 재조회를 걸면, 두 통지의 응답이 역순으로 도착할 때
 * 낡은 스냅샷이 최신을 덮을 수 있다. 여기서는 통지마다 단조 증가 시퀀스 번호를 매겨
 * **가장 나중에 들어온 통지의 응답만** 실제로 적용하고, 그 사이 도착한 통지들의 항목은
 * 버리지 않고 **누적**해 그 최신 응답에 함께 실어 보낸다 — 최신 응답은 디스크·호스트의
 * 최신 상태이므로 쌓인 항목을 합집합으로 적용해도 올바르다(먼저 온 통지가 유실되지 않는다).
 *
 * 재조회가 실패하면(reject 또는 null) 이번 통지는 조용히 버린다. 그것을 "무시"로 볼지
 * "리로드"로 볼지는 **호출부가 정한다** — 국소 반영은 무시해도 다음 저장이 다시 나르지만,
 * 재빌드 반영은 무시하면 창이 낡은 채 남으므로, 그쪽 호출부는 실패를 값으로(예: null이 섞인
 * 묶음) 받아 스스로 리로드로 떨어진다.
 */
export function createLocalApplyQueue<S>(
  fetchLatest: () => Promise<S | null>,
  apply: (items: readonly string[], latest: S) => void,
): (items: readonly string[]) => void {
  let seq = 0;
  const pendingItems = new Set<string>();
  return (items: readonly string[]) => {
    for (const item of items) pendingItems.add(item);
    const mySeq = ++seq;
    void fetchLatest()
      .catch(() => null)
      .then((fresh) => {
        // 이 응답이 도착한 시점에 이미 더 최근 통지가 나가 있으면(seq가 앞서 있으면) 낡은
        // 응답이므로 버린다 — pendingItems는 그 최신 통지가 이어받아 합집합으로 적용한다.
        if (mySeq !== seq) return;
        if (!fresh) return;
        const drained = [...pendingItems];
        pendingItems.clear();
        apply(drained, fresh);
      });
  };
}
