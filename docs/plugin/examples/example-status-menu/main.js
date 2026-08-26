/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 상태 아이템 + 컨텍스트 메뉴 — 툴바에 상태 아이템 하나, 우클릭 메뉴로 그 값을 갱신.
//
// 역할: `ui.addStatusItem`(상태 표시) · `ui.updateStatusItem`(라이브 갱신) · `ui.addMenuItem`
// (우클릭 메뉴)의 정본 사용례. 메뉴 항목을 누를 때마다 카운터를 올려 상태 아이템에 반영한다.
// 왜: 이 예제가 보여 주는 계약 세 가지 —
// (1) **상태 아이템 등록은 호스트 스코프**(스냅샷에 모여 모든 창의 툴바에 뜬다)지만,
//     **텍스트 갱신(`updateStatusItem`)은 창-스코프**다 — 값이 창마다 다를 수 있어, 갱신은
//     그 갱신을 낳은 창으로 위임된다. 그래서 run이 받은 **바인딩된 memo**로 부른다.
// (2) **메뉴 항목의 `run`**은 첫 인자로 바인딩된 memo, 둘째 인자로 `payload`를 받는다
//     (이 예제는 선택 텍스트를 안 쓰므로 payload를 보지 않는다 → `notes:read` 불필요).
// (3) 메뉴 항목에 `when`이 없으면 항상 표시된다(창 상태 두 키 `note.isEmpty`·`note.hasSelection`
//     으로 좁힐 수 있다 — 이 예제는 조건 없이 항상 띄운다).

// 카운터는 등록 클로저에 둔다(상태는 창이 아니라 이 샌드박스에 산다 — 데모용 단순 카운터).
var count = 0;

memo.ui
  .addStatusItem({
    id: "menu-count",
    text: "0회",
    title: "메뉴 실행 횟수",
    position: "bottom-right",
  })
  .then(function () {
    // 컨텍스트 메뉴 항목: 누를 때마다 카운터를 올려 상태 텍스트를 갱신한다.
    return memo.ui.addMenuItem({
      id: "bump",
      label: "카운터 올리기",
      // when 생략 = 항상 표시. run은 필수다(없으면 INVALID_ARGS).
      run: function (memo) {
        count = count + 1;
        // ★ run이 받은 바인딩된 memo로 갱신한다 — updateStatusItem은 창-스코프라
        //   "이 우클릭이 일어난 창"의 상태 아이템을 정확히 갱신한다.
        memo.ui
          .updateStatusItem({ id: "menu-count", text: count + "회" })
          .catch(function (e) {
            memo.runtime.log({ message: "상태 갱신 실패: " + e.code });
          });
      },
    });
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
