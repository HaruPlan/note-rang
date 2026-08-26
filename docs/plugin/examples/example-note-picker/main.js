/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 노트 골라 삽입 — 전체 노트에서 하나 골라 그 본문을 커서에 넣는다.
//
// 역할: `notes:all-read`(민감 권한)의 정본 사용례. `notes.list`(메타만) →
// `ui.pickList`(사용자 선택) → `notes.read`(그 노트의 본문) → `editor.insertText`(커서 삽입)
// 네 호출을 잇는다.
// 왜: 이 예제가 보여 주는 계약 두 가지 —
// (1) `notes.list`/`notes.read`는 **호스트 스코프**다: 창 컨텍스트가 필요 없어 어느 창에서
//     불러도 같은 전체 컬렉션을 본다(그래도 삽입은 창-스코프이므로 바인딩된 memo로 부른다).
// (2) 목록에는 본문이 **없다**: 제목으로 고르게 하고, 본문은 고른 뒤 id 하나로만 읽는다 —
//     컬렉션 전체 본문을 한 번에 나르는 API는 일부러 없다.

memo.ui
  .addToolbarButton({
    id: "pick-note",
    label: "📚",
    title: "다른 노트의 본문을 커서에 삽입",
    position: "bottom-right",

    // ★ 첫 인자로 이 클릭에 바인딩된 memo가 온다 — 창-스코프 호출(pickList·insertText)이
    //   "클릭한 그 창"으로 정확히 가게 하는 정본 패턴이다(전역 memo를 가린다).
    onClick: function (memo) {
      memo.notes
        .list()
        .then(function (notes) {
          // 숨긴 노트도 목록에 **포함돼 온다**(계약) — 사용자의 숨김 의도를 존중해 거른다.
          var visible = notes.filter(function (n) {
            return !n.hidden;
          });
          if (visible.length === 0) {
            return memo.ui.toast({ title: "삽입할 노트가 없습니다" });
          }
          return memo.ui
            .pickList({
              title: "본문을 삽입할 노트",
              items: visible.map(function (n) {
                // title은 항상 비지 않는다 — 빈 노트면 계약이 "제목 없음"을 준다(빈 문자열
                // 아님). 그러니 그대로 라벨로 쓴다.
                return { id: n.id, label: n.title };
              }),
            })
            .then(function (pickedId) {
              // 취소(Esc·바깥 클릭)나 창 컨텍스트 없음은 오류가 아니라 null이다.
              if (pickedId === null) return null;
              return memo.notes.read({ id: pickedId }).then(function (note) {
                return memo.editor
                  .insertText({ text: note.content, mode: "cursor" })
                  .then(function () {
                    return memo.ui.toast({ title: "삽입했습니다" });
                  });
              });
            });
        })
        .catch(function (e) {
          // 실패는 두 곳에 남긴다: 사용자에게 토스트, 기록에 진단. 고른 사이 노트가 지워졌으면
          // e.code === "NOTE_NOT_FOUND"다 — 문구(e.message)가 아니라 코드로 분기한다.
          var text =
            e.code === "NOTE_NOT_FOUND"
              ? "그 노트가 방금 지워졌습니다 — 다시 골라 주세요"
              : "삽입하지 못했습니다 (" + e.code + ")";
          memo.ui.toast({ title: text }).catch(function (t) {
            memo.runtime.log({ message: "toast 실패: " + t.code });
          });
          memo.runtime.log({
            message: e.call + " → " + e.code + " / " + e.message,
          });
        });
    },
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
  });
