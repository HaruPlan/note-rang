/**
 * OS/브라우저 로케일로 "언어 미설정"일 때의 기본 언어를 고른다 — 이슈 #30.
 *
 * 역할: `settings.language`가 아직 없을 때(최초 실행 등) `navigator.language`를 보고 ko/en 중
 * 하나를 고른다. **사용자가 설정에서 명시적으로 고른 언어는 절대 여기를 거치지 않는다** —
 * 호출부(각 창 부트스트랩)가 저장된 값이 있으면 그 값을 그대로 쓰고, `null`/`undefined`일
 * 때만 [`resolveLanguage`]를 부른다(Rust `src-tauri/src/i18n.rs`의 `strings()`가 `Some`/`None`을
 * 가르는 것과 같은 결).
 *
 * 왜 규칙을 Rust와 맞추는가: 트레이·창 타이틀·환영 노트(Rust, #29에서 이미 구현)와 이 UI
 * 문자열(TS)이 같은 머신에서 서로 다른 언어로 뜨면 반쪽짜리 로컬라이즈가 된다 — 두 쪽 다
 * "로케일이 ko로 시작하면(대소문자 무관) ko, 그 외(조회 실패 포함)는 en"이라는 같은 이분법을
 * 쓴다([`src-tauri/src/i18n.rs`]의 `locale_to_builtin_language`와 완전히 동일한 규칙).
 *
 * 왜 `navigator.language`만 보는가(창마다 로케일이 다를 수 있는 `navigator.languages`는 안 봄):
 * 백엔드(Rust)가 `sys_locale::get_locale()`로 보는 것도 "OS의 대표 로케일 하나"이지, 사용자가
 * 브라우저에 설정해 둔 선호 언어 목록 전체가 아니다 — 프론트가 그 대칭을 지키려면 첫 번째
 * 값 하나만 보는 `navigator.language`가 맞는 대응이다.
 */

/**
 * 앱이 **설치 없이** 지원하는 언어 코드(Rust 쪽과 동일하게 ko/en 이분법).
 *
 * 프론트에서 둘의 공급 경로는 다르다 — ko는 코어 내장(`src/i18n/ko.json`), en은 앱과 함께
 * 실리는 번들 언어팩(`src/plugin/builtin/language-packs/language-pack-en/`)이다. 하지만
 * **이 판정에는 그 차이가 보이지 않아야 한다**: 여기가 답하는 질문은 "언어를 한 번도 고른
 * 적 없는 사용자에게 무엇으로 열어 줄까"이고, 두 언어 다 부트스트랩이 첫 페인트 전에
 * 등록하므로 사용자 관점에서는 똑같이 "그냥 있는 언어"다. 번들 en 팩을 꺼 두었다면 그
 * 코드가 등록되지 않아 `setActiveLocale`이 조용히 무시하고 ko로 남는다(store.ts의 방어).
 */
type BuiltinLanguage = "ko" | "en";

/**
 * 로케일 문자열(예: `"ko-KR"`, `"en-US"`) → 내장 언어 코드로 판정하는 순수 규칙(테스트 가능하게
 * OS/브라우저 조회와 분리).
 *
 * 규칙: `locale`이 `"ko"`로 시작하면(대소문자 무관) `"ko"`, 그 외(빈 문자열·`null`·`undefined`
 * 포함)는 전부 `"en"` — `src-tauri/src/i18n.rs`의 `locale_to_builtin_language`와 완전히 같다.
 */
export function localeToLanguage(
  locale: string | null | undefined,
): BuiltinLanguage {
  return typeof locale === "string" && locale.toLowerCase().startsWith("ko")
    ? "ko"
    : "en";
}

/**
 * 이 창의 `navigator.language`로 판정한 기본 언어(부수효과 있음 — OS/브라우저 조회).
 *
 * `navigator`가 없는 실행 환경(방어)이면 `undefined`를 넘겨 [`localeToLanguage`]의 "조회
 * 실패" 분기(en)를 그대로 탄다.
 */
export function systemDefaultLanguage(): BuiltinLanguage {
  return localeToLanguage(
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );
}

/**
 * `settings.language`(저장된 값, 미설정이면 `null`/`undefined`)로 활성화할 언어 코드를
 * 정한다 — 각 창 부트스트랩의 `?? "ko"` 폴백을 대체하는 단일 지점.
 *
 * 저장된 값이 있으면(사용자가 설정에서 명시적으로 고른 언어 — ko/en뿐 아니라 언어팩이 더한
 * 임의 코드도 포함) **그 값을 그대로** 돌려준다(가공하지 않는다 — `setActiveLocale`이 미등록
 * 코드는 스스로 무시하므로 여기서 검증할 필요가 없다). `null`/`undefined`일 때만
 * [`systemDefaultLanguage`]로 판정한다.
 */
export function resolveLanguage(stored: string | null | undefined): string {
  return stored ?? systemDefaultLanguage();
}
