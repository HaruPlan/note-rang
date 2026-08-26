// 위첨자 플러그인 — ^텍스트^를 위첨자 인라인 패턴으로 등록한다.
memo.editor
  .registerInlinePattern({
    id: "superscript",
    open: "^",
    close: "^",
    style: { verticalAlign: "super", fontSize: "0.8em" },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
