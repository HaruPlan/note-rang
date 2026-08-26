/**
 * 프론트엔드 진입점 — URL에 따라 노트창·패널·설정·플러그인 중앙 호스트 창을 마운트한다.
 *
 * 역할: `?note=<id>`면 노트창(본문·옵션·배경·에디터·자동저장·드래그)을, `?panel`이면 노트
 * 목록·검색 패널을, `?settings`면 설정·플러그인 매니저 창을, `?plugin-host`면 숨김 상주
 * 창의 플러그인 중앙 호스트(샌드박스 1회 실행·소유)를 띄운다.
 *
 * 왜 전부 동적 `import()`인가(이슈 #26): 이 파일은 네 창 종류 **전부**가 공유하는 유일한
 * 정적 진입점이다 — 여기서 `mountNoteWindow`(CodeMirror)·`mountSettings`(5000줄대)·
 * `mountPanel`·`mountPluginHost`(central-host, 3000줄대)를 정적으로 import하면, 노트 창
 * 하나만 열어도 그 넷을 전부 파싱·실행하게 된다(실측: 단일 번들 ~667KB). 각 창 종류의
 * 부트스트랩을 `src/bootstrap/<kind>.ts`로 쪼개고 여기서는 URL을 보고 필요한 조각 하나만
 * `import()`하므로, Vite가 창 종류별로 청크를 나눠 그 창이 실제 쓰는 코드만 내려간다.
 * `src/styles.css`는 `index.html`의 `<link>`로 로드되어(JS import가 아니다) 이 분기와
 * 무관하게 모든 창에서 항상 적용된다.
 */
const root = document.querySelector<HTMLElement>("#app");
const params = new URLSearchParams(window.location.search);

if (root) {
  if (params.has("settings")) {
    void import("./bootstrap/settings").then(({ bootstrapSettings }) =>
      bootstrapSettings(root),
    );
  } else if (params.has("panel")) {
    void import("./bootstrap/panel").then(({ bootstrapPanel }) =>
      bootstrapPanel(root),
    );
  } else if (params.has("plugin-host")) {
    void import("./bootstrap/plugin-host").then(({ bootstrapPluginHost }) =>
      bootstrapPluginHost(),
    );
  } else {
    // `?note=<id>` 파싱 — `note/note-window.ts`의 `parseNoteId`와 동일 규칙이지만, 그 모듈은
    // CodeMirror를 정적으로 묶고 있어(위 설명) 라우팅만을 위해 여기서 import하지 않는다.
    const noteId = params.get("note");
    if (noteId) {
      void import("./bootstrap/note").then(({ bootstrapNote }) =>
        bootstrapNote(root, noteId),
      );
    }
  }
}
