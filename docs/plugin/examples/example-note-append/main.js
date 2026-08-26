/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 현재 노트에 추가 — 지금 노트 끝에 타임스탬프 한 줄을 비파괴로 덧붙인다.
//
// 역할: `notes.write`(mode:"append")의 정본 사용례. 열려 있는 노트의 id를 `notes.current`로
// 얻어, 그 노트 끝에 한 줄을 이어붙인다.
// 왜: 이 예제가 보여 주는 계약 세 가지 —
// (1) `notes.write`는 **호스트 스코프**다(창 컨텍스트가 필요 없다) — 하지만 대상 id는
//     보통 창-스코프 호출(`notes.current`)에서 얻으므로, 둘을 한 onClick 안에서 잇는다.
// (2) `append`는 **비파괴**다(데이터를 잃지 않는다). `overwrite`는 통째로 덮되 Rust가 덮기
//     전에 이전 본문을 복구 슬롯에 스냅샷한다 — 이 예제는 안전한 append만 쓴다.
// (3) 이 쓰기가 **열려 있는 그 노트**를 바꾸면 호스트가 그 창을 디스크에서 다시 읽어
//     반영한다(낡은 에디터 버퍼가 다음 자동저장에서 이 추가분을 덮지 않게).

memo.ui
  .addToolbarButton({
    id: "append-stamp",
    label: "➕",
    title: "지금 노트에 타임스탬프 추가",
    position: "bottom-right",

    // ★ 첫 인자로 이 클릭에 바인딩된 memo가 온다 — notes.current(창-스코프)가 "클릭한 그 창"의
    //   노트를 정확히 가리키게 한다. notes.write는 호스트 스코프라 창과 무관하지만 같은 memo로
    //   통일해 "이 핸들러 안에서는 전역을 쓰지 않는다"는 규칙을 단순하게 지킨다.
    onClick: function (memo) {
      memo.notes
        .current()
        .then(function (note) {
          // 창-스코프 호출은 창 컨텍스트를 못 찾으면 오류가 아니라 null이다 — 성공과 구분되지
          // 않으므로 반드시 확인한다.
          if (note === null) {
            return memo.ui.toast({ title: "이 창의 노트를 찾지 못했습니다" });
          }
          var line = "\n- 확인함 " + new Date().toISOString();
          // append는 본문 끝에 이어붙인다(비파괴). 성공 시 수행부는 null을 돌려준다.
          return memo.notes
            .write({ id: note.id, content: line, mode: "append" })
            .then(function () {
              return memo.ui.toast({ title: "노트에 한 줄 추가했습니다" });
            });
        })
        .catch(function (e) {
          // 실패는 두 곳에 남긴다: 사용자에게 토스트, 기록에 진단. 노트가 방금 지워졌으면
          // e.code === "NOTE_NOT_FOUND"다 — 문구가 아니라 코드로 분기한다.
          var text =
            e.code === "NOTE_NOT_FOUND"
              ? "그 노트가 방금 사라졌습니다"
              : "추가하지 못했습니다 (" + e.code + ")";
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
