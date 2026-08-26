/**
 * 설정 반영 리로드의 "깜빡임" 제거 — 첫 페인트 **전에** 직전 화면의 색을 되살린다.
 *
 * 역할: 노트 창(`?note=<id>`)이 중앙 호스트 재빌드(EV_HOST_UPDATED)로 스스로 리로드할 때,
 * 리로드 직전에 남긴 스냅샷(`sessionStorage`)을 읽어 (1) `<html>`의 인라인 테마 토큰과
 * (2) `#app`의 노트 배경색·접힘 클래스를 복원하고, (3) 가운데에 "설정 적용 중…" 문구를
 * 띄운다. 마운트가 끝나면 `src/bootstrap/reload-overlay.ts`의 `dismissReloadOverlay()`가
 * 문구를 걷는다.
 *
 * 왜 여기(=`public/`의 클래식 스크립트)인가: 리로드된 문서는 스타일시트만 적용된 상태로
 * 한 번 그려진 뒤(`#app{background:#fdf6e3}` — 기본 크림색), 번들이 로드되고 IPC 몇 번을
 * 왕복한 뒤에야 실제 테마색이 얹힌다. 사용자에게는 "빈 문서 → 크림색 → 진짜 색"의 두 단계
 * 점프로 보인다. 이 스크립트는 `index.html`의 `#app` 바로 뒤에 **동기(render-blocking)**
 * 클래식 스크립트로 놓여 첫 페인트보다 먼저 실행되므로, 그 중간 단계가 아예 생기지 않는다.
 * 모듈 스크립트(`/src/main.ts`)는 defer 의미론이라 언제나 이보다 늦다.
 * 외부 파일인 이유: 앱 CSP가 `script-src 'self'`라 인라인 스크립트는 실행되지 않는다
 * (해시를 박으면 내용이 바뀔 때마다 `tauri.conf.json`을 같이 고쳐야 한다 — 그 결합을 피한다).
 * 번들되지 않는 `public/`에 두는 이유: Vite가 이 파일을 모듈로 변환하지 않고 `dist/`에
 * 그대로 복사해, 첫 페인트 전 실행이라는 성질이 빌드 후에도 유지된다.
 *
 * **첫 로드(스냅샷 없음)에서는 아무것도 하지 않는다** — 스냅샷이 있을 때만 개입한다.
 *
 * 계약(양쪽이 같이 움직여야 한다): 키·필드 이름은 `src/bootstrap/reload-overlay.ts`의
 * `RELOAD_SNAPSHOT_KEY`/`ReloadSnapshot`과, 오버레이의 id·표시 규칙(200ms 지연 페이드)은
 * `src/styles.css`의 `#memo-reload-overlay` 규칙과 정확히 일치해야 한다.
 */
(function () {
  "use strict";

  /** `ReloadSnapshot`이 담기는 sessionStorage 키(reload-overlay.ts의 RELOAD_SNAPSHOT_KEY). */
  var KEY = "memo:reload-snapshot";
  /** 오버레이 요소 id — reload-overlay.ts가 이 id로 찾아 지운다(전역 함수를 노출하지 않는다). */
  var OVERLAY_ID = "memo-reload-overlay";
  /**
   * 스냅샷 유효 시간. 리로드는 즉시 일어나므로 정상 경로에서는 수십 ms다. 이보다 오래된
   * 스냅샷은 "리로드가 아니라 나중에 사용자가 이 창을 직접 다시 연 것"이므로 무시한다
   * (지난 세션의 색을 새 창에 입히지 않는다).
   */
  var MAX_AGE_MS = 10000;
  /**
   * 마운트가 끝나지 않아도 문구를 걷는 상한. 부트스트랩이 죽으면 `dismissReloadOverlay()`가
   * 영영 안 불릴 수 있는데, 그때 문구가 남아 오류 오버레이 위를 덮으면 사용자는 "설정 적용
   * 중"에 걸린 것으로 오해한다.
   */
  var SAFETY_MS = 10000;

  /** 오버레이를 지운다(id로만 찾는다 — 이 스크립트는 전역에 아무 것도 남기지 않는다). */
  function dismiss() {
    try {
      var el = document.getElementById(OVERLAY_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch {
      /* 지우기 실패는 무해하다(어차피 상한 타이머가 한 번 더 시도한다). */
    }
  }

  try {
    // 노트 창에서만 동작한다. 설정·패널·플러그인호스트 창은 이 스냅샷을 쓰지 않는다
    // (판별 규칙은 `src/main.ts`의 라우팅과 같다 — `?note=<id>`가 있고 비어 있지 않을 것).
    if (!new URLSearchParams(window.location.search).get("note")) return;

    // 읽는 즉시 지운다(1회 소비): 이 스냅샷은 "직전 리로드"에만 유효하다. 남겨 두면 다음
    // 리로드가 아닌 다른 이유로 이 문서가 다시 평가될 때 옛 색이 되살아난다.
    var raw = null;
    try {
      raw = window.sessionStorage.getItem(KEY);
      if (raw !== null) window.sessionStorage.removeItem(KEY);
    } catch {
      return; // sessionStorage 자체가 막혀 있으면(프라이버시 모드 등) 아무 일도 하지 않는다.
    }
    if (!raw) return; // 첫 로드 — 지금까지와 완전히 같은 경로로 흘려보낸다.

    var snap;
    try {
      snap = JSON.parse(raw);
    } catch {
      return; // 깨진 값 — 이미 지웠으니 다음 로드는 깨끗하다.
    }

    // 신뢰 경계는 아니지만(우리가 쓴 값) 버전·필드가 어긋나면 조용히 포기한다 — 반쯤 복원된
    // 화면(테마는 새 값, 배경은 옛 값)이 깜빡임보다 나쁘다.
    if (
      !snap ||
      typeof snap !== "object" ||
      snap.v !== 1 ||
      typeof snap.at !== "number" ||
      typeof snap.themeCss !== "string" ||
      typeof snap.appBg !== "string" ||
      typeof snap.textColor !== "string" ||
      typeof snap.collapsed !== "boolean" ||
      typeof snap.message !== "string" ||
      Date.now() - snap.at > MAX_AGE_MS
    ) {
      return;
    }

    // (1) 테마 토큰 — `applyTheme`가 `<html>`에 인라인 CSS 변수로 쓴 그 문자열을 그대로
    // 되돌린다. 마운트가 끝나면 `applyTheme`가 같은 자리에 최신 값을 다시 쓰므로 충돌이 없다.
    document.documentElement.style.cssText = snap.themeCss;

    // (2) 노트 배경 — 스타일시트의 기본 크림색(#fdf6e3)을 덮는다. 접힘 상태도 같이 복원해야
    // 헤더 높이(36px)에 맞춘 규칙이 첫 프레임부터 적용된다.
    var app = document.getElementById("app");
    if (app) {
      app.style.background = snap.appBg;
      if (snap.collapsed) app.classList.add("note-collapsed");
    }

    // (3) 안내 문구. 접힌 창(헤더 36px)에는 띄우지 않는다 — 들어갈 자리가 없고, 잘린 조각만
    // 보이면 오히려 고장으로 읽힌다(배경색 복원만으로 깜빡임은 이미 사라진다).
    if (!snap.collapsed && document.body) {
      var overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("aria-live", "polite");
      var label = document.createElement("span");
      // 신뢰 경계 밖 문자열이 아니지만(우리 i18n 사전) 마크업으로 해석될 여지를 두지 않는다.
      label.textContent = snap.message;
      label.style.color = snap.textColor;
      overlay.appendChild(label);
      document.body.appendChild(overlay);
      // 표시 타이밍(200ms 지연 후 120ms 페이드인)은 CSS가 정한다 — 빠른 리로드에서는 문구가
      // 아예 보이지 않고 배경색만 유지된다(정지 화면). `src/styles.css` 참고.
      window.setTimeout(dismiss, SAFETY_MS);
    }
  } catch {
    // 어떤 예외도 `/src/main.ts`(진짜 앱)의 실행을 막아서는 안 된다 — 이 스크립트는 순전히
    // 미관을 위한 장치이고, 실패해도 예전과 같은 깜빡임으로 저하될 뿐이다.
    dismiss();
  }
})();
