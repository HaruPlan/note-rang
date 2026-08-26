// plain 테마 — 무채색 슬레이트 톤의 미니멀 테마 색 토큰을 등록한다(능력 등록).
memo.theme.register({
  tokens: {
    accent: "#5f6672",
    danger: "#c0392b",
    warning: "#b7791f",
    surface: "#f6f6f5",
    "surface-dark": "#1c1c1c",
    card: "#ffffff",
    "card-dark": "#2a2a2a",
    border: "#dadad6",
    "border-dark": "#444444",
    text: "#1f1f1f",
    "text-dark": "#ededed",
  },
})
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "테마 등록 실패: " + e.call + " → " + e.code });
  });
