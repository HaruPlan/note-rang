// 키 표시 플러그인 — {{Cmd+C}}를 키보드 키 모양 인라인 패턴으로 등록한다.
memo.editor
  .registerInlinePattern({
    id: "kbd",
    open: "{{",
    close: "}}",
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "0.85em",
      padding: "1px 5px",
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: "contrast-border",
      borderRadius: "4px",
      backgroundColor: "contrast-fill",
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
