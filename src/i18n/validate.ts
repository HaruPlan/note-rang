/**
 * 언어팩 콘텐츠 검증 — 로케일 사전을 등록하기 전에 base(ko) 사전과 대조한다.
 *
 * 역할: 언어팩이 준 항목(`entries`)을 base 사전(지금은 항상 ko)과 대조해 (1) base에 있는
 * 키만 살아남고(ko에 없는 미지 키는 순회 대상에서 애초에 빠져 조용히 버려진다), (2) 살아남은
 * 키도 base 문장의 `{플레이스홀더}` 집합과 값의 집합이 **정확히** 같을 때만 통과한다(하나라도
 * 다르면 그 키만 거부 — 언어팩 전체를 막지 않는다). 통과분 맵과 커버리지 비율(통과 키 수 /
 * base 키 수)을 돌려준다.
 * 왜: 언어팩은 신뢰 경계 밖(플러그인)에서 온다. `{name}` 같은 플레이스홀더가 빠지거나 이름이
 * 다르면 `t()`의 치환이 그 자리를 원형 그대로 남기거나(t.ts의 의도된 폴백이지만 번역은
 * 깨진 채 보인다) 렌더 시점까지 발견되지 않는다 — 등록 시점에 걸러 두면 "이 언어팩은 이
 * 키를 못 믿는다"가 결정론적으로 고정된다. 이 함수는 순수하다(store.ts의 `registerLocale`이
 * 부작용을 책임진다) — 콘텐츠 규칙만 여기서 가드 테스트로 고정한다.
 */

/** 평탄한 키→문장 사전. */
type Dictionary = Record<string, string>;

/** 언어팩 검증 결과 — 수용된 항목 + 커버리지(통과 키 수 / base 키 수, base가 비면 1). */
interface LocaleValidationResult {
  accepted: Dictionary;
  coverage: number;
}

/** 문장에서 `{이름}` 플레이스홀더 이름 집합을 뽑는다(t.ts의 치환 정규식과 같은 패턴). */
function placeholdersOf(sentence: string): Set<string> {
  const names = new Set<string>();
  for (const m of sentence.matchAll(/\{([^{}]+)\}/g)) names.add(m[1]);
  return names;
}

/** 두 플레이스홀더 집합이 원소로서 정확히 같은가(순서 무관). */
function samePlaceholders(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

/** own-property 확인 후 문자열 값만 꺼낸다(Object.prototype 오염 방지 — t.ts의 ownEntry와
 * 같은 이유. 값이 문자열이 아니면(신뢰 경계 밖 입력) undefined로 취급해 그 키를 버린다). */
function ownString(
  o: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return undefined;
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * 언어팩 항목(신뢰 경계 밖 입력)을 base 사전과 대조해 수용 가능한 항목만 남긴다.
 *
 * base에 있는 키만 검사 대상이다(ko에 없는 미지 키는 순회에서 애초에 빠져 조용히 버려진다).
 * base 키마다: `entries`에 같은 키의 **문자열** 값이 있고, 그 값의 `{플레이스홀더}` 집합이
 * base 문장의 집합과 정확히 같아야 수용된다 — 하나라도 다르면 그 키만 거부하고 나머지는
 * 계속 검사한다(전체 거부 없음, 언어팩 하나의 실수가 로드를 막지 않는다는 규약).
 */
export function validateLocaleEntries(
  entries: unknown,
  base: Dictionary,
): LocaleValidationResult {
  const raw =
    typeof entries === "object" && entries !== null && !Array.isArray(entries)
      ? (entries as Record<string, unknown>)
      : {};
  const accepted: Dictionary = {};
  const baseKeys = Object.keys(base);
  for (const key of baseKeys) {
    const value = ownString(raw, key);
    if (value === undefined) continue; // 언어팩이 이 키를 안 줬다 — 커버리지만 낮아진다.
    const baseSentence = ownString(base, key);
    if (baseSentence === undefined) continue; // 방어(원칙적으로 base는 항상 문자열 값).
    if (
      !samePlaceholders(placeholdersOf(baseSentence), placeholdersOf(value))
    ) {
      continue; // 플레이스홀더 집합 불일치 — 이 키만 거부.
    }
    accepted[key] = value;
  }
  const coverage =
    baseKeys.length === 0 ? 1 : Object.keys(accepted).length / baseKeys.length;
  return { accepted, coverage };
}
