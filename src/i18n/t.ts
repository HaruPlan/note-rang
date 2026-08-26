/**
 * i18n 문자열 조회 + {이름} 플레이스홀더 치환.
 *
 * 역할: 활성 로케일 사전에서 키를 찾아 문장을 돌려주고, params로 넘긴 값을 문장 속 {이름}
 * 자리에 채운다. 폴백 체인은 **활성 로케일 사전 → ko 사전 → 키 문자열**이다 — 활성 로케일에
 * 없는 키는 ko로, ko에도 없으면 키 문자열 그대로 반환한다(누락이 화면에 바로 드러나게 하려는
 * 의도적 폴백, docs/contributing/i18n.md).
 * 왜: 사용자 노출 문자열을 코드 리터럴에서 떼어내 사전 한 곳(로케일별 ko.json 상당)에 모으는
 * 이관의 코어 함수. 사전 조회 자체는 `src/i18n/store.ts`(로케일 저장소)에 위임해, 이 파일은
 * 폴백 순서·플레이스홀더 치환만 책임진다.
 */
import { activeLocale, localeDictionary } from "./store";

/** 로케일 사전의 형태: 평탄한 키→문장 맵(중첩 없음). */
type Dictionary = Record<string, string>;

/**
 * own-property 확인 후 사전에서 값을 꺼낸다.
 *
 * 왜: 확인 없이 인덱싱하면 "toString" 같은 키가 Object.prototype을 타고 함수 객체를 돌려줘
 * 폴백 규약(없는 키 → 키 반환)이 깨진다.
 */
function ownEntry(dictionary: Dictionary, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(dictionary, key)
    ? dictionary[key]
    : undefined;
}

/**
 * 폴백 체인을 따라 키의 문장을 찾는다: 활성 로케일 사전 → ko 사전.
 *
 * 활성 로케일이 ko 자신이면 같은 사전을 두 번 보는 셈이라 실질적으로 한 번만 찾는다.
 * ko는 store.ts가 항상 등록해 두므로 `localeDictionary("ko")`는 실제로는 항상 값이 있지만,
 * 반환 타입(옵셔널)에 맞춰 방어적으로 빈 사전을 최종 폴백으로 둔다.
 */
function lookup(key: string): string | undefined {
  const active = localeDictionary(activeLocale());
  const fromActive = active ? ownEntry(active, key) : undefined;
  if (fromActive !== undefined) return fromActive;
  const ko = localeDictionary("ko") ?? {};
  return ownEntry(ko, key);
}

/**
 * 키로 문장을 조회하고 {이름} 플레이스홀더를 params 값으로 치환한다.
 *
 * 역할: 폴백 체인(활성 로케일 → ko)에서 키를 찾으면 그 문장에서 {이름}을 params[이름]으로
 * 바꾼다(같은 이름이 여러 번 나와도 전부 치환). params에 없는 이름의 자리는 원형 그대로
 * 남긴다(누락이 눈에 띄게). 어느 사전에도 키가 없으면 키 문자열 자체를 반환한다(폴백).
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = lookup(key);
  if (template === undefined) return key;
  if (params === undefined) return template;
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : placeholder,
  );
}
