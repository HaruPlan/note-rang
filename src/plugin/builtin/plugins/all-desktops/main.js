// 모든 데스크탑 플러그인 — 노트 툴바에 "모든 데스크탑에 표시" 토글을 제공한다.
// 능력만 선언하고(데이터), 실제 Space 표시 설정은 네이티브 노트 창이 수행한다.
memo.window.register({ controls: ["all-desktops"] })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "능력 등록 실패: " + e.call + " → " + e.code });
  });
