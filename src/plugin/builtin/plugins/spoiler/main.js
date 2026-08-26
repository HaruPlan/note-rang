// 스포일러 플러그인 — ||텍스트||를 가리고 호버로 공개하는 인라인 패턴을 등록한다.
memo.editor
  .registerInlinePattern({
    id: "spoiler",
    open: "||",
    close: "||",
    style: {
      filter: "blur(4px)",
      transition: "filter 0.1s",
      borderRadius: "2px",
    },
    styleHover: { filter: "none" },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "패턴 등록 실패: " + e.call + " → " + e.code });
  });
