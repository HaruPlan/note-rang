// SJ_D 테마 — 차분한 딥블루 톤의 기본 테마 색 토큰을 등록한다(능력 등록).
memo.theme.register({
  tokens: {
    accent: "#37506a",
    danger: "#c0392b",
    warning: "#b7791f",
    surface: "#fbfbf8",
    "surface-dark": "#1f1f1f",
    card: "#ffffff",
    "card-dark": "#2b2b2b",
    border: "#dcdcd6",
    "border-dark": "#454545",
    text: "#1f2328",
    "text-dark": "#ededed",
  },
})
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "테마 등록 실패: " + e.call + " → " + e.code });
  });
