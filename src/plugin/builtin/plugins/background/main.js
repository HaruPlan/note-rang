// 배경색 플러그인 — 노트 배경으로 고를 수 있는 색상 견본을 제공한다(능력 등록).
memo.background.register({
  swatches: ["#e5dbc3", "#e3ebd6", "#f4f4ef", "#fdf6e3"],
  autoTextContrast: true,
})
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "능력 등록 실패: " + e.call + " → " + e.code });
  });
