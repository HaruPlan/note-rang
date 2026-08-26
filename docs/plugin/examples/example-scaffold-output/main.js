/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// memo-plugin scaffold --template=settings-driven 산출물.
//
// 역할: 설정(인사말·말투)을 읽어 버튼을 누르면 토스트로 보여준다.
// 다음: manifest.json의 settings[]에 필드를 더하고 `npm run plugin -- types <이 폴더>`를
// 다시 돌려 settings.d.ts를 갱신해라(오타·타입 어긋남을 편집기가 바로 잡아 준다).

memo.ui
  .addToolbarButton({
    id: "show-greeting",
    label: "👋",
    title: "설정한 인사말 보여주기",
    position: "bottom-right",
    onClick: function (memo) {
      memo.settings
        .getAll()
        .then(function (cfg) {
          // 기본값은 매니페스트가 정본이다 — 저장된 값이 없으면 호스트가 default를 병합해
          // 주므로 여기서 폴백을 다시 쓰지 않는다.
          var text =
            cfg.style === "casual" ? cfg.greeting + "!" : cfg.greeting + ".";
          return memo.ui.toast({ title: "인사말", message: text });
        })
        .catch(function (e) {
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
  });
