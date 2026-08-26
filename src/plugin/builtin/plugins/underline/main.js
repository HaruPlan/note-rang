// 밑줄 플러그인 — ++텍스트++에 밑줄을 긋는 인라인 패턴을 등록한다.
memo.editor
  .registerInlinePattern({
    id: "underline",
    open: "++",
    close: "++",
    style: { textDecoration: "underline", textUnderlineOffset: "2px" },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
