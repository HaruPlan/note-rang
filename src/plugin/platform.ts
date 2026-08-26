/**
 * 플러그인 OS(플랫폼) 지원 모델 — 매니페스트 `platforms` 판정 + 표시 라벨.
 *
 * 역할: 플러그인이 지원하는 OS 목록(`platforms`)과 현재 OS를 대조해 "이 기기에서 쓸 수
 * 있는가"를 한 곳에서 판정한다. 중앙 호스트(미지원 플러그인 미실행)·설정 목록(OS 배지·
 * 자동 비활성 회색 처리)이 모두 이 로직을 공유한다.
 * 왜: 멀티플랫폼 준비 — 창 기능처럼 OS별 지원이 갈리는 플러그인을 미지원 OS에서 자동
 * 비활성화하려면 "지원 여부" 판정을 흩뿌리지 않고 한 곳에 못박아 누락을 막는다.
 */
import { t } from "../i18n/t";

/**
 * 플러그인이 현재 OS에서 지원되는지 판정한다(순수, 테스트용).
 *
 * 규칙: `platforms` 미선언/빈 배열 → 모든 OS 지원(true). 선언돼 있으면 현재 OS가 목록에
 * 있어야 한다. **현재 OS를 알 수 없으면(빈 문자열 등) 제한하지 않는다(true)** — Tauri 밖
 * (e2e·비정상)에서 플러그인이 통째로 사라지지 않게 하는 안전 폴백.
 */
export function isSupportedOnPlatform(
  platforms: readonly string[] | null | undefined,
  os: string,
): boolean {
  if (!platforms || platforms.length === 0) return true;
  if (!os) return true; // OS 미상 → 제한하지 않음(안전 폴백).
  return platforms.includes(os);
}

/** OS 식별자 → 짧은 배지 라벨(아이콘 + 이름). 미상 OS는 그대로 표기. */
export function platformLabel(os: string): string {
  switch (os) {
    case "macos":
      return "🍎 macOS";
    case "windows":
      return "⊞ Windows";
    case "linux":
      return "🐧 Linux";
    default:
      return os;
  }
}

/**
 * `platforms` 목록을 사람이 읽는 "지원 OS" 문구로 만든다(설정 배지용).
 *
 * 미선언/빈 배열 → null(모든 OS 지원이라 배지 불필요). 하나면 "🍎 macOS 전용",
 * 여럿이면 라벨을 `·`로 잇는다.
 */
export function describePlatforms(
  platforms: readonly string[] | null | undefined,
): string | null {
  if (!platforms || platforms.length === 0) return null;
  if (platforms.length === 1)
    return t("plugin.platform.exclusive", {
      label: platformLabel(platforms[0]),
    });
  return platforms.map(platformLabel).join(" · ");
}
