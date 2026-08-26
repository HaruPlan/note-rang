/**
 * 로케일 저장소 — 등록된 언어(ko 내장 + 번들 언어팩·서드파티 언어팩이 더한 것)와 활성
 * 로케일 코드를 관리한다.
 *
 * 역할: `ko.json`을 코드 `"ko"`로 항상 등록해 두고, 창이 부트스트랩 때 고른 활성 로케일
 * 코드를 보관한다. `t()`(`src/i18n/t.ts`)가 조회할 폴백 체인(활성 로케일 → ko → 키)의 사전
 * 소스를 여기서 공급한다.
 * 왜: "코드 → 로케일(사전 포함)" 맵 구조로 짜 두면 어떤 경로로 로케일이 더해지든 이 파일의
 * 저장 구조·`t.ts`의 조회 로직을 다시 만질 필요가 없다 — 등록 경로만 두 개 얹혀 있다.
 *
 * **두 경로 모두 창 부트스트랩이 첫 페인트 전에 동기적으로 끝낸다.** 언어팩은 코드 실행이
 * 필요 없는 데이터 선언이라, 어느 쪽도 플러그인 샌드박스·호스트 스냅샷을 거치지 않는다 —
 * 이 파일에 "늦게 도착한 사전" 개념이 없는 이유이자, 그 지연을 리로드로 수습하던 장치
 * (`shouldReloadForLateLocale`)가 사라진 이유다.
 *
 * ## 왜 ko만 코어에 남는가
 *
 * ko는 **기준 언어**다: `t()` 폴백 체인의 최종 사전이자, 언어팩 콘텐츠를 대조하는 검증
 * base(`validateLocaleEntries`)다. 즉 ko가 없으면 다른 언어의 정합성을 판정할 근거 자체가
 * 사라진다 — 그래서 ko만은 어떤 데이터 선언으로도 대체할 수 없는 코어 자산이고, 나머지
 * 언어는 전부 "언어팩이 선언한 데이터"다(C안 — VS Code의 구조와 같은 결).
 *
 * ## 등록 경로 두 가지
 *
 * 1. **번들 언어팩**([`registerBundledLocale`]) — `src/plugin/builtin/language-packs/*`의
 *    폴더가 매니페스트로 로케일을 선언하고, 각 창 부트스트랩이 활성 로케일 하나를 **로컬
 *    에서 직접**(동적 import, `src/i18n/packs.ts`) 읽어 등록한다. 호스트 스냅샷 왕복이
 *    없으므로 **첫 페인트 전에 이미 등록돼 있다.**
 * 2. **서드파티 언어팩**([`registerLocale`]) — 설치 플러그인이 매니페스트에 선언한
 *    (`contributes.translations`) 사전을 **코어(Rust `plugin_i18n.rs`)가 직접 스캔**해 주고
 *    (`readLocaleEntries`/`listLanguagePacks` IPC), 각 창 부트스트랩이 그것을 자기 저장소에
 *    등록한다(이 모듈의 인스턴스는 창=JS 런타임마다 별개다). 가벼운 로컬 IPC 하나라 (1)과
 *    나란히 달리고, 역시 **첫 페인트 전에** 끝난다.
 *
 * **왜 en이 (1)로 옮겨졌나(이슈 #30 → C안)**: 예전엔 en도 `en.json`을 이 파일이 직접 import
 * 하는 정적 시드였다. 이유는 오직 하나 — (2)의 비동기 지연을 en이 겪게 할 수 없다는 것
 * (영어 OS 사용자가 앱을 켤 때마다 리로드 깜빡임을 볼 수는 없다). (1)이 생기면서 그 이유가
 * 사라졌다: 번들 팩은 부트스트랩이 **직접** 읽으므로 시드와 똑같이 첫 페인트 전에 등록된다.
 * 대신 en 사전이 코어 청크에서 빠져(비-eager 글로브) ko 사용자는 영어 바이트를 한 번도
 * 받지 않고, en은 다른 언어팩과 **같은 폴더 형태**가 되어 외부 저작자에게 살아 있는 예제가
 * 된다(도그푸딩). 단일 진실 원천은
 * `src/plugin/builtin/language-packs/language-pack-en/manifest.json` 하나다.
 */
import ko from "./ko.json";
import { validateLocaleEntries } from "./validate";

/** 평탄한 키→문장 사전(로케일 하나 분량). */
type Dictionary = Record<string, string>;

/** 등록된 로케일 하나 — 코드·표시 라벨(선택 UI용)·사전. */
interface Locale {
  code: string;
  label: string;
  entries: Dictionary;
}

/** ko는 코어에 내장된 기준 로케일 — 제거 불가, 항상 맵의 첫 항목(등록 순서 = Map 삽입 순서). */
const KO_CODE = "ko";

/**
 * 서드파티 언어팩이 [`registerLocale`]로 **절대 덮어쓸 수 없는** 코드들. 초기값은 ko 하나고,
 * [`registerBundledLocale`]로 등록된 번들 팩의 코드가 여기 더해진다.
 *
 * 왜 이 규칙이 en이 팩으로 옮겨간 뒤에도 유지되는가(이슈 #30): 보호의 근거는 "정적 시드라서"
 * 가 아니라 **"앱과 함께 배포·검증된 번역이라서"**였다. 번들 팩도 같은 저장소에서 같은
 * 커버리지 가드(`packs.test.ts`)를 통과해 함께 배포되므로 그 근거가 그대로 남는다 — 같은
 * 코드를 쓰는 서드파티 언어팩 하나의 실수(또는 의도적 대체)로 앱 내장 번역이 조용히 바뀌면
 * 안 된다. 등록되지 않은 번들 팩의 코드는 보호되지 않는다(그 언어는 이 창에 아예 없으므로
 * 서드파티가 공급해도 무방하다).
 */
const PROTECTED_CODES = new Set([KO_CODE]);

/** 등록된 로케일 맵(코드 → Locale). ko를 시드로 항상 포함한다. */
const locales = new Map<string, Locale>([
  [KO_CODE, { code: KO_CODE, label: "한국어", entries: ko as Dictionary }],
]);

/** 현재 활성 로케일 코드. 기본값 ko(등록되지 않은 코드로는 절대 바뀌지 않는다). */
let active: string = KO_CODE;

/**
 * 활성 로케일을 바꾼다.
 *
 * 역할: `code`가 등록된 로케일이면 활성으로 전환한다. 등록되지 않은 코드(오타·아직 설치되지
 * 않은 언어팩 등)면 조용히 무시하고 기존 활성 로케일을 유지한다 — 알 수 없는 로케일로 넘어가
 * 화면 전체가 키 폴백으로 깨지는 상황을 막기 위한 방어다.
 */
export function setActiveLocale(code: string): void {
  if (locales.has(code)) active = code;
}

/** 현재 활성 로케일 코드를 돌려준다(기본 ko). */
export function activeLocale(): string {
  return active;
}

/** 등록된 로케일 목록을 [{code,label}]로 돌려준다(설정 언어 드롭다운용) — ko가 항상 첫
 * 항목이고 그 뒤는 등록 순서(= Map 삽입 순서: 번들 팩 → 설치 팩). */
export function availableLocales(): { code: string; label: string }[] {
  return [...locales.values()].map(({ code, label }) => ({ code, label }));
}

/** 코드로 로케일 사전을 조회한다. 등록되지 않은 코드면 `undefined`(호출부가 폴백 처리). */
export function localeDictionary(code: string): Dictionary | undefined {
  return locales.get(code)?.entries;
}

/**
 * **번들** 언어팩 로케일 하나를 등록한다(각 창 부트스트랩이 첫 페인트 전에 부른다 —
 * `src/i18n/packs.ts`가 폴더 매니페스트를 읽어 넘긴다).
 *
 * 역할: `code`가 `"ko"`면 **무시한다**(ko는 기준 언어 — 번들 팩으로도 못 덮는다. 파일 상단
 * "왜 ko만 코어에 남는가" 참고). `entries`는 [`registerLocale`]과 **똑같이**
 * [`validateLocaleEntries`]로 ko 사전과 대조해 통과분만 저장한다 — 번들이라고 검증을
 * 건너뛰지 않는다: ko.json이 팩보다 먼저 바뀌어 둘이 어긋나는 순간에도(리뷰를 놓친 커밋 등)
 * 깨진 플레이스홀더가 화면에 나가는 대신 그 키만 조용히 빠지고 나머지는 정상 동작한다.
 * 드리프트 자체는 `packs.test.ts`의 커버리지 가드가 100%를 요구해 잡는다(이 검증은 그
 * 가드가 뚫렸을 때의 마지막 안전망).
 *
 * 등록한 `code`는 [`PROTECTED_CODES`]에 더해진다 — 이후 서드파티 [`registerLocale`]이 같은
 * 코드로 등록해도 무시된다(이슈 #30의 "악의적·실수 언어팩이 내장 언어를 조용히 대체하지
 * 못한다"가 팩 구조에서도 그대로 성립한다).
 *
 * **반복 호출은 무해하다(멱등).** `Map.set` upsert + `Set.add`라 같은 팩을 몇 번을 등록해도
 * 결과가 같고, upsert는 Map의 삽입 순서도 바꾸지 않는다(언어 드롭다운 순서 안정). 중앙 호스트
 * 창은 리로드가 없어 **재빌드마다** 이 경로를 다시 타므로(`bootstrap/plugin-host.ts`의
 * `resolveHostLocale`), 이 성질에 실제로 의존한다 — "이미 등록했으면 건너뛰기" 같은 최적화를
 * 넣더라도 이 멱등성은 깨뜨리지 마라.
 */
export function registerBundledLocale(
  code: string,
  label: string,
  entries: unknown,
): void {
  if (typeof code !== "string" || code === "" || code === KO_CODE) return;
  const { accepted } = validateLocaleEntries(entries, ko as Dictionary);
  locales.set(code, {
    code,
    label: typeof label === "string" ? label : "",
    entries: accepted,
  });
  PROTECTED_CODES.add(code);
}

/**
 * **서드파티(설치)** 언어팩 로케일 하나를 등록한다 — 코어가 설치 매니페스트를 스캔해 준
 * 사전(`readLocaleEntries` IPC)을 각 창이 이 함수로 반영한다.
 *
 * 역할: `code`가 보호 코드([`PROTECTED_CODES`] — ko + 이 창에 이미 등록된 번들 팩의 코드)면
 * **무시한다**(언어팩이 실수로(또는 의도적으로) `locale: "ko"`/`"en"`을 등록해도 앱 내장
 * 사전은 안전하다, 이슈 #30). `entries`는 [`validateLocaleEntries`]로 ko 사전과 대조해
 * 통과분만 저장한다(플레이스홀더 불일치·미지 키는 조용히 버려진다 — 언어팩 하나의 실수가
 * 등록 자체를 막지 않는다).
 * **같은 code로 다시 등록하면 마지막 등록이 이긴다(LastWins)** — `theme.register`와 같은
 * 규칙이고, 코어의 사전 병합(`read_locale_entries`의 id 사전순 LastWins)과도 같은 규칙이라
 * 두 경로가 같은 입력에서 같은 사전을 낸다.
 */
export function registerLocale(
  code: string,
  label: string,
  entries: unknown,
): void {
  if (typeof code !== "string" || code === "" || PROTECTED_CODES.has(code))
    return;
  const { accepted } = validateLocaleEntries(entries, ko as Dictionary);
  locales.set(code, {
    code,
    label: typeof label === "string" ? label : "",
    entries: accepted,
  });
}
