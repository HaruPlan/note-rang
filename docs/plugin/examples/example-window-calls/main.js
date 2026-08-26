/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 창-스코프 호출 잇기 — 입력 → 삽입 → 글자 크기 → 알림.
//
// 역할: 버튼을 누르면 머리말을 물어보고, 커서 위치에 넣고, 글자를 5% 키운 뒤 결과를 알린다.
// 창-스코프 호출 네 개가 **하나의 창**에서 순서대로 일어나야 한다.
// 왜: 창-스코프 호출을 여러 개 이을 때가 저작이 가장 쉽게 깨지는 지점이다. 창이 두 개 이상
// 열려 있으면 "A에서 눌렀는데 B에 삽입되는" 오배달이 나는데, 그 실패는 오류가 아니라
// **그냥 다른 창에서 일어난 성공**으로 보여서 테스트로도 잡히지 않는다.
//
// ── 하면 안 되는 것 ────────────────────────────────────────────────────────
//
//   onClick: function () {
//     // ❌ 전역 memo + Promise.all: 콜백 안에서 토큰이 유실된다.
//     Promise.all([memo.ui.prompt({ title: "머리말" }), memo.editor.getFontDelta()])
//       .then(function (r) {
//         memo.editor.insertText({ text: r[0] }); // "마지막으로 클릭한 창"으로 폴백
//       });
//   }
//
// 토큰이 유실되는 경계: `Promise.all`/`race`/`allSettled`로 감싼 뒤의 콜백, `setTimeout`·
// `requestAnimationFrame`·DOM 이벤트 콜백, 브리지가 아닌 프라미스를 기다린 **뒤**.
// 아래 정본은 (1) 바인딩된 memo를 쓰고 (2) 체인을 순차로 잇는다.

memo.ui
  .addToolbarButton({
    id: "insert-heading",
    label: "H",
    title: "머리말 넣기",
    position: "top-right",
    onClick: function (memo) {
      // ① 사용자 입력을 기다린다(대화형 창-스코프 호출 — 취소하면 null).
      memo.ui
        .prompt({ title: "머리말", placeholder: "예: 오늘의 할 일" })
        .then(function (title) {
          // 취소했거나 창 컨텍스트가 없으면 null이다. 여기서 끊으면 뒤 단계가 안 돈다.
          if (title === null || title === "") return null;

          // ② 커서 위치에 삽입한다. caret은 삽입된 본문 안에서의 최종 커서 오프셋이라,
          //    "머리말 다음 줄"에 커서를 두려면 텍스트 길이를 그대로 준다.
          var text = "# " + title + "\n";
          return memo.editor
            .insertText({ text: text, mode: "cursor", caret: text.length })
            .then(function () {
              // ③ 글자 델타를 읽는다(퍼센트). 창 컨텍스트가 없으면 null이 온다.
              return memo.editor.getFontDelta();
            })
            .then(function (delta) {
              if (delta === null) return null;
              // setFontDelta는 한계로 **클램프된 실제 값**을 돌려준다 — 그 값을 그대로
              // 토스트에 써야 "글자 +N%"가 정직해진다.
              return memo.editor.setFontDelta({ value: delta + 5 });
            })
            .then(function (applied) {
              return memo.ui.toast({
                title:
                  applied === null
                    ? "머리말을 넣었습니다"
                    : "머리말을 넣고 글자를 " + applied + "%로 맞췄습니다",
              });
            });
        })
        .catch(function (e) {
          // 실패 처리 중의 호출도 실패할 수 있다 — 토스트에도 .catch를 걸어 둔다.
          memo.ui
            .toast({ title: "실패했습니다 (" + e.code + ")" })
            .catch(function (t) {
              memo.runtime.log({ message: "toast 실패: " + t.code });
            });
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
