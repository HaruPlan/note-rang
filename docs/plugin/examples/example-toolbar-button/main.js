/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 툴바 버튼 — 지금 메모의 경로를 클립보드로.
//
// 역할: 노트 툴바에 버튼 하나를 달고, 클릭하면 현재 노트의 경로를 설정 문구와 함께
// 클립보드에 복사한 뒤 토스트로 알린다.
// 왜: 이 예제 하나가 저작에서 가장 자주 틀리는 세 가지를 전부 덮는다 —
// (1) 창-스코프 호출을 **바인딩된 memo**로 하기, (2) `null`이 올 수 있음을 인정하기,
// (3) 실패를 사용자와 기록 **양쪽에** 남기기.

memo.ui
  .addToolbarButton({
    id: "copy-path",
    label: "📋",
    title: "이 메모의 경로 복사",
    // position은 이 버튼을 **배치가 한 번도 본 적 없을 때만** 쓰이는 자동 배치 존이다.
    // 실제 위치는 사용자가 「설정 › 외형 › 툴바 배치」에서 정한다.
    position: "bottom-right",

    // ★ 첫 인자로 **이 클릭에 바인딩된 memo**가 온다. 이름을 `memo`로 받아 전역을 가리는
    //   것이 정본이다 — 토큰이 클로저에 있어 Promise.all·setTimeout·비-브리지 await 등
    //   어떤 비동기 경계를 넘어도 "클릭한 그 창"으로 정확히 라우팅된다.
    //   전역 memo를 쓰면 `.then` 체인과 브리지 호출 await까지만 맞고, 그 밖에서는 "마지막으로
    //   클릭한 창"으로 폴백해 창이 둘 이상일 때 A에서 누른 결과가 B에 나타날 수 있다.
    onClick: function (memo) {
      // 설정은 창과 무관하므로 전역으로도 안전하지만, 바인딩된 memo로 통일해 두면
      // "이 핸들러 안에서는 전역을 쓰지 않는다"는 규칙이 단순해진다.
      memo.settings
        .getAll()
        .then(function (cfg) {
          // 기본값은 매니페스트가 정본이다 — 저장된 값이 없으면 호스트가 default를
          // 병합해 주므로 여기서 `|| ""` 같은 폴백을 다시 쓰지 않는다.
          return memo.notes.current().then(function (note) {
            // 창-스코프 호출은 창 컨텍스트를 못 찾으면 **오류가 아니라 null**로 끝난다.
            // 성공과 구분되지 않으므로 반드시 확인한다.
            if (note === null) {
              return memo.ui.toast({ title: "이 창의 메모를 찾지 못했습니다" });
            }
            return memo.clipboard
              .write({ text: cfg.prefix + note.path })
              .then(function () {
                return memo.ui.toast({ title: "경로를 복사했습니다" });
              });
          });
        })
        .catch(function (e) {
          // 실패는 **두 곳에** 남긴다. 사용자에게는 무슨 일이 났는지, 기록에는 진단할 근거를.
          // 실패 처리 중에 부르는 호출도 실패할 수 있다(창 컨텍스트 없음 등) — 토스트에도
          // .catch를 걸어야 그 실패까지 기록에 남는다. 진단 로그(memo.runtime.*)는 권한도
          // 창도 필요 없어서 이 자리의 마지막 흔적이 된다.
          memo.ui
            .toast({ title: "복사하지 못했습니다 (" + e.code + ")" })
            .catch(function (t) {
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
