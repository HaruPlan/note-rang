// 위키링크 플러그인 — [[제목]]을 눌러 그 제목의 노트로 넘나드는 인라인 패턴 + 자동완성을 등록한다.
memo.editor
  .registerInlinePattern({
    id: "wikilink",
    open: "[[",
    close: "]]",
    style: {
      color: "accent",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "pointer",
    },
  })
  .then(function () {
    // id는 등록의 키다 — 같은 id로 다시 등록하면 치환(upsert)된다. trigger는 리터럴 문자열로
    // 매칭되므로 "[[" 말고 "@" 같은 다른 트리거도 그대로 동작한다.
    return memo.editor.registerCompletion({
      id: "wikilink",
      trigger: "[[",
      wrap: "[[%]]",
      source: "note-titles",
    });
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
