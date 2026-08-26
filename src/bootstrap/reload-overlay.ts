/**
 * 설정 반영 리로드의 화면 연속성 — 리로드 직전 스냅샷을 남기고, 마운트가 끝나면 걷는다.
 *
 * 역할: 노트 창이 중앙 호스트 재빌드(`EV_HOST_UPDATED`)를 **리로드로 반영하기로 정했을 때**
 * (판정은 `host-update-plan.ts` — 제자리 조정으로 끝나는 재빌드는 이 경로 자체가 없다)
 * `window.location.reload()`를 부르기 **직전에** 화면의 색(테마 인라인 변수 + 노트 배경 +
 * 글자색)과 접힘 상태를
 * `sessionStorage`에 적어 두고([`writeReloadSnapshot`]), 마운트가 끝나면 새 문서에 떠 있던
 * 안내 오버레이를 지운다([`dismissReloadOverlay`]).
 *
 * 왜: 리로드된 문서는 스타일시트만 적용된 채 한 번 그려진다 — `#app`의 기본 크림색
 * (`#fdf6e3`, `src/styles.css`)이다. 실제 테마·배경은 번들 로드와 IPC 왕복(`loadNote`) 뒤에야
 * 얹히므로, 사용자에게는 "빈 문서 → 크림색 → 진짜 색"으로 두 번 점프하는 깜빡임이 보인다.
 * 색을 첫 페인트 전에 되돌려 놓으면 그 중간 단계가 사라지고, 리로드는 "잠깐 멈춘 화면"이 된다.
 *
 * 이 모듈은 **쓰는 쪽과 지우는 쪽**만 담당한다. 실제 복원은 첫 페인트보다 먼저 돌아야 해서
 * 번들 밖의 동기 클래식 스크립트 [`public/reload-boot.js`]가 한다 — 키·필드 이름·오버레이 id가
 * 그 파일과 **정확히** 일치해야 하므로 양쪽 주석에 서로를 적어 둔다. 표시 타이밍(200ms 지연
 * 페이드인)은 `src/styles.css`의 `#memo-reload-overlay` 규칙이 정본이다.
 */

/**
 * 스냅샷이 담기는 `sessionStorage` 키. `public/reload-boot.js`의 `KEY`와 같아야 한다.
 *
 * `sessionStorage`인 이유: 수명이 정확히 "이 창(탭)의 이 세션"이다. 창을 닫으면 사라지므로
 * 다음에 같은 노트를 열 때 지난 색이 되살아나지 않고, 리로드는 같은 세션이라 살아남는다.
 */
export const RELOAD_SNAPSHOT_KEY = "memo:reload-snapshot";

/** 안내 오버레이의 DOM id — `public/reload-boot.js`가 이 id로 만들고, 여기서 이 id로 지운다. */
const RELOAD_OVERLAY_ID = "memo-reload-overlay";

/**
 * 리로드 직전 화면 상태 — `public/reload-boot.js`가 첫 페인트 전에 그대로 되돌려 놓는다.
 *
 * `v`는 포맷 버전이다: 필드가 바뀐 채 남아 있던 옛 스냅샷을 새 부트 스크립트가 반쯤 적용하는
 * 사고를 막는다(불일치면 그냥 버린다). `reason`은 지금 한 가지뿐이지만, 문구를 원인별로
 * 가르고 싶어질 때 스냅샷 포맷을 다시 손대지 않도록 미리 자리를 잡아 둔다 —
 * `EV_HOST_UPDATED`는 설정 저장 외에 플러그인 토글·설치·제거, 언어팩, vault 이동, 백업
 * 복원에서도 오기 때문이다.
 */
export interface ReloadSnapshot {
  v: 1;
  /** `Date.now()` — 부트 스크립트가 너무 오래된 스냅샷(≥10초)을 버리는 기준. */
  at: number;
  reason: "host-updated";
  /** `<html>`의 인라인 스타일 전문 — `applyTheme`가 쓴 `--memo-*` 토큰이 여기 들어 있다. */
  themeCss: string;
  /** `#app`의 노트 배경색(`applyBg`가 `host.style.background`에 직접 대입한 값). */
  appBg: string;
  /** 안내 문구 색 — 노트 배경 대비에 맞춘 `#app`의 계산된 글자색. */
  textColor: string;
  /** 접힘 상태(`#app.note-collapsed`). 접힌 창에는 문구를 띄우지 않는다(자리가 없다). */
  collapsed: boolean;
  /** 이미 활성 로케일로 해석된 안내 문구(부트 스크립트는 i18n을 모른다). */
  message: string;
}

/**
 * 지금 화면 상태를 스냅샷으로 남긴다 — **`window.location.reload()` 직전에** 부른다.
 *
 * 배경색은 인라인 값(`applyBg`가 쓴 것)을 우선하고, 아직 안 쓰였으면 계산값으로 떨어진다
 * (마운트 도중에 리로드가 겹치는 드문 경로 — 그래도 스타일시트 기본색이라도 잇는 편이 낫다).
 * 실패(쿼터 초과·`sessionStorage` 비가용)는 **조용히 무시한다**: 이 기능은 순전히 미관이고,
 * 여기서 던지면 그 뒤의 `reload()`가 실행되지 않아 창이 옛 설정에 굳는다.
 */
export function writeReloadSnapshot(
  host: HTMLElement,
  message: string,
  now: number = Date.now(),
): void {
  try {
    const computed = getComputedStyle(host);
    const snapshot: ReloadSnapshot = {
      v: 1,
      at: now,
      reason: "host-updated",
      themeCss: document.documentElement.style.cssText,
      appBg: host.style.background || computed.backgroundColor || "",
      textColor: computed.color || "",
      collapsed: host.classList.contains("note-collapsed"),
      message,
    };
    sessionStorage.setItem(RELOAD_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* 스냅샷을 못 남기면 예전처럼 깜빡일 뿐이다 — 리로드 자체를 막지 않는다. */
  }
}

/**
 * 안내 오버레이를 걷는다 — 마운트가 끝난(성공·실패 무관) 직후에 부른다.
 *
 * 즉시 제거한다(페이드아웃 없음). 전환을 걸면 `transitionend`가 안 오는 경우
 * (요소가 이미 화면 밖·애니메이션 비활성)를 대비한 타임아웃 폴백이 필요한데, 그 복잡도를
 * 감수할 만큼 얻는 게 없다 — 대부분의 리로드에서는 문구가 뜨기도 전(200ms 지연)에 걷힌다.
 *
 * 오버레이가 없으면(첫 로드·부트 스크립트가 안 뜬 경우) 아무 일도 하지 않는다.
 */
export function dismissReloadOverlay(): void {
  document.getElementById(RELOAD_OVERLAY_ID)?.remove();
}
