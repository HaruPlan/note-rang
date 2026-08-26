// 투명도 플러그인 — 노트 툴바에 창 투명도 슬라이더를 제공한다.
// 능력만 선언하고(데이터), 실제 창 알파 적용은 네이티브 노트 창이 수행한다(배경 플러그인과 같은 결).
memo.window.register({ controls: ["transparency"] })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "능력 등록 실패: " + e.call + " → " + e.code });
  });
