/**
 * 플러그인 능력(capability) 값 — "지금 이 앱에서 무엇이 살아 있는가"를 화면에 넘기는 단일 형.
 *
 * 역할: 조건부 UI(창 컨트롤·컨텍스트 메뉴 항목 등)를 그릴지 말지 판정하는 **유일한 입력**을 한
 * 값으로 묶는다. 능력을 따로따로 옵셔널 필드로 흘리면 호출부가 하나를 빠뜨렸을 때 조용히
 * "켜짐"으로 굳는다(fail-open) — 이 모듈의 존재 이유가 그 실수를 타입으로 막는 것이다.
 *
 * 규약(사용자 확정): **어떤 화면도 플러그인이 로드됐다고 추정하지 않는다.** 아직 모르면
 * 그리지 않는다([`NO_CAPABILITIES`]) — 사용자가 끈 플러그인의 UI가 잠깐이라도 뜨면 "껐다"를
 * 신뢰할 수 없게 되기 때문이다(악성 플러그인을 끈 직후가 정확히 그 상황이다).
 *
 * 판정 근거는 두 갈래이고 **둘 다 이 형으로 수렴한다**: 플러그인 호스트 스냅샷(샌드박스 실행
 * 결과 — 서드파티까지 포함한 완전한 답)과, 스냅샷 없이도 즉시 알 수 있는 번들 활성 레지스트리
 * (`listBuiltinStates` + [`enabledBuiltinWindowControls`]). 후자는 중앙 호스트가 번들을 실행할지
 * 거를 때 쓰는 조건과 입력이 같아, 스냅샷을 기다리지 않고도 번들 범위에서는 같은 답을 낸다.
 */

import { KNOWN_WINDOW_CONTROLS } from "./window-control";

/** 화면이 조건부 UI를 그릴지 판정할 때 쓰는 능력 묶음(모든 필드 필수 — 옵셔널 금지). */
export interface PluginCapabilities {
  /**
   * 지금 활성인 창 컨트롤 id(투명도·항상 위·모든 데스크탑). 대응 플러그인이 꺼졌거나 이 OS에서
   * 미지원이면 빠진다. 여기 없는 컨트롤은 툴바에 **그리지 않는다**.
   */
  windowControls: readonly string[];
  /**
   * 빌트인 `youtube-embed`가 활성인지 — 컨텍스트 메뉴 "유튜브 추가" 항목의 노출 조건.
   * 꺼져 있으면 삽입해도 렌더되지 않는 죽은 기능이라 항목 자체를 숨긴다.
   */
  youtubeEmbed: boolean;
}

/**
 * 설정 창의 툴바 배치 편집기가 팔레트를 거를 때 쓰는 능력 — 노트 툴바가 컨트롤을 실제로 만들 때
 * 보는 것과 **같은 판정 입력**이다([`availableBuiltinItems`]의 인자 그대로).
 *
 * [`PluginCapabilities`]와 갈라져 있는 이유: 노트 창은 배경 스와치 목록을 이미 따로 받아
 * (`hasBackgroundPicker(swatches)`로 스스로 판정하므로) `hasBackground`가 중복이 되고, 설정 창은
 * 반대로 스와치 목록이 필요 없다. 같은 사실을 두 번 나르면 어긋날 수 있어 각자 필요한 형만 받는다.
 *
 * **호스트 스냅샷을 못 읽으면 `null`**로 표현한다 — "모른다"이지 "없다"가 아니다. 설정 창은 이
 * 값이 null이면 팔레트를 거르지도, 배치를 정리하지도 않는다(호스트가 잠깐 죽은 사이에 사용자
 * 배치를 지워버리지 않기 위해). 노트 창의 "모르면 안 그린다"와 방향이 반대로 보이지만 원칙은
 * 같다: **추정하지 않는다** — 그리는 쪽은 안 그리고, 지우는 쪽은 안 지운다.
 */
export interface ToolbarPaletteCapabilities {
  /** 지금 활성인 창 컨트롤 id. */
  windowControls: string[];
  /** 활성 테마가 배경 스와치를 제공하는지(배경색 피커 노출 조건). */
  hasBackground: boolean;
}

/**
 * 아무 능력도 확인하지 못한 상태(호스트 스냅샷도, 활성 레지스트리 조회도 실패). 조건부 UI를
 * 하나도 그리지 않는다 — "모른다"를 "켜짐"으로 읽지 않기 위한 보수적 바닥값이다.
 *
 * 테스트·폴백에서 "능력 없음"을 명시할 때도 이 값을 쓴다(빈 리터럴을 흩뿌리면 의도가 안 보인다).
 */
export const NO_CAPABILITIES: PluginCapabilities = {
  windowControls: [],
  youtubeEmbed: false,
};

/** 모든 능력이 켜진 상태 — 테스트에서 "능력 제한 없음"을 명시할 때만 쓴다(프로덕션 금지). */
export const ALL_CAPABILITIES: PluginCapabilities = {
  windowControls: [...KNOWN_WINDOW_CONTROLS],
  youtubeEmbed: true,
};
