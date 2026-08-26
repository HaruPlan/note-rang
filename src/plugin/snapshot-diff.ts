/**
 * 스냅샷 슬라이스 **비교**만 담은 순수 모듈 — "이 변화를 부분 갱신으로 따라갈 수 있는가"를
 * 묻는 두 판정기가 공유한다.
 *
 * 소비처는 둘이다:
 * - 중앙 호스트의 개발 모드 단일 핫리로드(`central-host.ts`의 `canPartial`) — 그 플러그인
 *   하나만 다시 실행했을 때 노트 창이 제자리에서 따라갈 수 있는지(지금은 능력·구독 집합만
 *   본다: 툴바 항목 넷은 노트 창이 스스로 diff한다).
 * - 노트 창의 재빌드 완료 판정(`bootstrap/host-update-plan.ts`) — 어느 조정 단계를 켜야
 *   하는지(툴바 항목 넷은 `toolbar_items` 단계의 근거다).
 *
 * 왜 별도 모듈인가: 두 판정이 **같은 기준**으로 비교해야 하는데, 원래 이 헬퍼들은
 * `central-host.ts`(플러그인 호스트 창 전용 거대 모듈) 안에 있었다. 노트 창 청크가 그 모듈을
 * import하면 호스트 전체가 노트 창 번들에 끌려 들어온다 — 그래서 비교 규칙만 여기로 떼어
 * 내고 양쪽이 이 모듈을 참조한다.
 *
 * 왜 JSON 비교인가: 이 값들은 전부 직렬화 스냅샷이라(함수 없음) 구조 동등이 곧 렌더 동등이다.
 * 순서까지 바뀌면 소비처의 렌더가 달라지므로 "다름"으로 본다(보수적 — 모르면 무거운 경로).
 */
import type {
  PluginSnapshot,
  SnapshotCommand,
  SnapshotMenuItem,
  SnapshotStatusItem,
  SnapshotToolbarButton,
} from "./host-protocol";

/** 툴바 버튼 목록이 같은가(순서 포함). */
export function buttonsEqual(
  a: SnapshotToolbarButton[],
  b: SnapshotToolbarButton[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 버튼 없는 명령 목록이 같은가(생략 = 빈 목록). */
export function commandsEqual(
  a: SnapshotCommand[] | undefined,
  b: SnapshotCommand[] | undefined,
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * 컨텍스트 메뉴 전용 항목 목록이 같은가(생략 = 빈 목록).
 *
 * 왜 버튼·명령과 같은 급으로 보는가: 넷 다 같은 배달 경로(`snapshotToolbarButtons` →
 * `NoteWindowHandle.reconcileToolbarItems`)로 노트 창에 실리고, 하나라도 달라지면 그 경로를
 * 한 번 더 태워야 한다(`toolbar_items` 단계).
 */
export function menuItemsEqual(
  a: SnapshotMenuItem[] | undefined,
  b: SnapshotMenuItem[] | undefined,
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 상태 표시형 아이템 목록이 같은가(생략 = 빈 목록 — 버튼과 같은 배달 경로·같은 급). */
export function statusItemsEqual(
  a: SnapshotStatusItem[] | undefined,
  b: SnapshotStatusItem[] | undefined,
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * 이 플러그인 슬롯이 **등록 순서 의존 병합** 능력(배경·폰트·창 컨트롤)을 하나라도
 * 등록했는가. 이런 능력이 있으면 부분 재구성이 병합 규칙을 어긋나게 재현할 수 있어 무거운
 * 경로(전체 리로드)로 폴백한다.
 *
 * 언어팩이 여기 없는 이유: 언어팩은 이 호스트를 거치지 않는다(데이터 선언을 각 창과 코어가
 * 직접 읽는다 — `HostSnapshot` 참고). 이 호스트가 실행하는 어떤 플러그인도 로케일을 등록하지
 * 못하므로 판정 입력 자체가 존재하지 않는다. 그래서 **언어 변화는 스냅샷 비교로 알 수 없고**,
 * 오직 [`RebuildReason`]의 `"locale"`만이 그 근거다.
 */
export function sliceHasCapabilities(s: PluginSnapshot): boolean {
  return (
    s.background != null ||
    s.font != null ||
    (s.windowControls?.length ?? 0) > 0
  );
}

/** 두 이름 집합이 원소로서 같은가(순서 무관 — 구독 집합·창 컨트롤 비교용). */
export function sameNameSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
