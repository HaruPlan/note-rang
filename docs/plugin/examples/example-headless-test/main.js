/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 헤드리스 테스트 대상 — 버튼 하나 + 이벤트 구독 하나.
//
// 역할: 툴바 버튼을 누르면 설정 도장(`stamp`)을 앞에 붙여 현재 노트 경로를 클립보드에 복사하고,
// `note:saved` 이벤트가 나면 토스트로 알린다.
// 왜: 이 플러그인은 **헤드리스 하니스(test-host)로 테스트하는 법**을 보이기 위한 대상이다 —
// 버튼 클릭·설정 주입·창-스코프 호출·이벤트 발화를 앱 없이 단언하는 예제(README 참고).

memo.ui
  .addToolbarButton({
    id: "stamp-path",
    label: "📌",
    title: "도장 + 경로 복사",
    position: "bottom-right",

    // ★ 첫 인자로 이 클릭에 바인딩된 memo가 온다 — 창-스코프 호출이 "클릭한 그 창"으로
    //   정확히 가게 하는 정본 패턴이다(전역 memo를 가린다).
    onClick: function (memo) {
      memo.settings
        .get({ key: "stamp" })
        .then(function (stamp) {
          return memo.notes.current().then(function (note) {
            // 창-스코프 호출은 컨텍스트가 없으면 오류가 아니라 null이다 — 반드시 확인한다.
            if (note === null) {
              return memo.ui.toast({ title: "이 창의 메모를 찾지 못했습니다" });
            }
            return memo.clipboard
              .write({ text: String(stamp) + note.path })
              .then(function () {
                return memo.ui.toast({ title: "도장과 경로를 복사했습니다" });
              });
          });
        })
        .catch(function (e) {
          // 실패는 두 곳에 남긴다: 사용자에게 토스트, 기록에 진단. 실패 처리 중의 토스트도
          // 창-스코프라 실패할 수 있으므로 .catch를 건다(그 실패까지 기록에 남긴다).
          memo.ui
            .toast({ title: "복사하지 못했습니다 (" + e.code + ")" })
            .catch(function (t) {
              memo.runtime.log({ message: "toast 실패: " + t.code });
            });
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
    },
  })
  .then(function () {
    // note:saved 구독은 `notes:read` 권한을 요구한다(이름별 추가 권한). handler의 첫
    // 인자도 onClick과 같은 규약: 그 이벤트가 난 창에 바인딩된 memo다.
    return memo.events.on({
      name: "note:saved",
      handler: function (memo) {
        memo.ui.toast({ title: "저장됨" }).catch(function (t) {
          memo.runtime.log({ message: "toast 실패: " + t.code });
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
