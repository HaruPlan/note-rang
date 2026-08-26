// 형광펜 플러그인 — ==텍스트==를 형광펜 스타일 인라인 패턴으로 등록한다.
memo.editor
  .registerInlinePattern({
    id: "highlight",
    open: "==",
    close: "==",
    style: {
      backgroundColor: "rgba(250, 204, 21, 0.35)",
      borderRadius: "2px",
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
