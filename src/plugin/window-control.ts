/**
 * 창 컨트롤 능력(capability) 모델 — 플러그인이 제공하는 네이티브 창 컨트롤 선언 + 정규화.
 *
 * 역할: 투명도·항상 위·모든 데스크탑 같은 "창 옵션"을 각각 토글형 번들 플러그인으로 분리하기
 * 위한 능력 디스크립터다. 플러그인은 `memo.window.register({ controls: [...] })`로 자신이
 * 제공하는 컨트롤을 **선언만** 하고(데이터), 실제 특권 동작(투명도 적용 등)은 네이티브 노트
 * 창이 수행한다 — 배경 플러그인이 스와치만 주고 피커/대비는 네이티브가 하는 것과 같은 결.
 * 왜: 창 기능을 켜고 끌 수 있는 능력 번들로 만들어(끄면 그 컨트롤이 툴바에서 사라짐), 임의
 * 플러그인에 창 제어권을 직접 주지 않으면서도 플러그인 경계로 기능을 분리한다.
 */
import { isSupportedOnPlatform } from "./platform";

/** 인식하는 창 컨트롤 id(툴바가 렌더하는 네이티브 컨트롤과 1:1). */
export const KNOWN_WINDOW_CONTROLS = [
  "transparency", // 투명도 슬라이더
  "always-on-top", // 항상 위(핀) 토글
  "all-desktops", // 모든 데스크탑(모든 Space) 토글
] as const;

/** 인식하는 창 컨트롤 id 타입. */
export type WindowControlId = (typeof KNOWN_WINDOW_CONTROLS)[number];

/**
 * 플러그인 호스트 스냅샷 **없이** "지금 실제로 실행 중인 창 컨트롤"을 낸다(순수).
 *
 * 판정 입력은 중앙 호스트가 번들 플러그인을 실행할지 거를 때 쓰는 것과 **완전히 같다**:
 * 활성 맵(`states`, 기록 없음 = 켜짐)과 플랫폼 지원([`isSupportedOnPlatform`]). 그래서 샌드박스가
 * 아직 안 떴어도 스냅샷과 같은 답이 나온다 — 노트 창이 마운트 때 이걸 쓰면 "스냅샷이 늦으니
 * 켜져 있겠거니" 추정할 필요가 없다.
 *
 * 왜 추정을 금지하나: 추정은 **사용자가 꺼둔 플러그인의 컨트롤을 그리는 것**과 같다. 창 컨트롤의
 * 특권 동작은 네이티브가 수행하므로 그 자체로 권한 상승은 아니지만, 화면이 "이 플러그인이 살아
 * 있다"고 말하는 셈이라 사용자가 끈 것을 껐다고 신뢰할 수 없게 된다(악성 플러그인을 끈 직후가
 * 정확히 그 상황이다). 모르면 그리지 않는 쪽이 언제나 옳다 — 스냅샷이 도착하면 정확한 값이 된다.
 *
 * 번들이 제공하지 않는 컨트롤(서드파티가 `memo.window.register`로 선언)은 여기서 알 수 없으므로
 * 빠진다(보수적) — 그 경로는 스냅샷이 유일한 진실이다.
 */
export function enabledBuiltinWindowControls(
  builtins: readonly { id: string; platforms?: string[] }[],
  states: Readonly<Record<string, boolean>>,
  platform: string,
): WindowControlId[] {
  return KNOWN_WINDOW_CONTROLS.filter((control) => {
    const plugin = builtins.find((p) => p.id === control);
    return (
      !!plugin &&
      (states[plugin.id] ?? true) &&
      isSupportedOnPlatform(plugin.platforms, platform)
    );
  });
}

/** 플러그인이 `memo.window.register(...)`로 등록한(정규화된) 창 컨트롤 능력(모듈 내부 형). */
interface WindowControlDescriptor {
  /** 이 플러그인이 제공하는 컨트롤 id 목록(알려진 것만, 중복 제거). */
  controls: WindowControlId[];
}

/**
 * 플러그인이 준 알 수 없는 입력을 안전한 [`WindowControlDescriptor`]로 정규화한다(순수, 테스트용).
 *
 * 역할: `controls`(배열)에서 [`KNOWN_WINDOW_CONTROLS`]에 속한 문자열만 취하고 중복을 없앤다.
 * 그 외(미지의 id·비문자열)는 버린다.
 * 왜: 신뢰할 수 없는 플러그인 데이터가 툴바 렌더 조건에 새지 않게 등록 시점에 형태를 못박는다.
 */
export function normalizeWindowControlArgs(
  args: unknown,
): WindowControlDescriptor {
  const o =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const raw = Array.isArray(o.controls) ? (o.controls as unknown[]) : [];
  const known = new Set<string>(KNOWN_WINDOW_CONTROLS);
  const controls: WindowControlId[] = [];
  for (const c of raw) {
    if (
      typeof c === "string" &&
      known.has(c) &&
      !controls.includes(c as WindowControlId)
    ) {
      controls.push(c as WindowControlId);
    }
  }
  return { controls };
}
