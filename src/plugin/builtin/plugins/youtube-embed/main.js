// 유튜브 임베드 플러그인 — youtube 코드펜스 안 URL을 노트 속 플레이어로 렌더한다(블록 임베드).
// Promise.resolve로 감싸 등록 반환값이 이미 프라미스든 아니든 체인이 안전하게 이어진다.
Promise.resolve(
  memo.editor.registerBlockEmbed({
    id: "youtube",
    fence: "youtube",
    sources: [
      { host: "www.youtube.com", queryParam: "v" },
      { host: "youtube.com", queryParam: "v" },
      { host: "m.youtube.com", queryParam: "v" },
      { host: "youtu.be", pathPrefix: "/" },
      { host: "www.youtube.com", pathPrefix: "/shorts/" },
      { host: "youtube.com", pathPrefix: "/shorts/" },
      { host: "m.youtube.com", pathPrefix: "/shorts/" },
    ],
    embedTemplate:
      "https://www.youtube-nocookie.com/embed/{id}?origin=https%3A%2F%2Fgithub.com&widget_referrer=https%3A%2F%2Fgithub.com%2FHaruPlan%2Fnote-rang",
  }),
).catch(function (e) {
  // memo.runtime은 항상 있는 무권한 네임스페이스이지만, 이 코드를 실행하는 일부 테스트
  // 하니스가 흉내 내지 않는다 — 방어적으로 감싼다(실제 호스트에서는 늘 있다).
  if (memo.runtime && typeof memo.runtime.log === "function") {
    memo.runtime.log({
      message: "블록 임베드 등록 실패: " + e.call + " → " + e.code,
    });
  }
});
