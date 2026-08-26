/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 설정 화면 액션 버튼 — 설정 폼에서 플러그인 동작을 바로 실행한다.
//
// 역할: 매니페스트의 `{ "type": "button", "command": "where-am-i" }`가 아래 `commands.register`의
// 같은 id를 가리킨다. 설정 › 도구 › 이 플러그인 페이지에서 버튼을 누르면 이 `run`이 돈다.
// 왜: "설정에 초기화 버튼 하나 넣어 줘"는 가장 흔한 요구인데, 예전에는 툴바 버튼으로 우회하는
// 방법뿐이었다. 이제 매니페스트 필드 하나 + 명령 하나로 끝난다.
//
// **버튼 전용 콜백 API는 없다.** 설정 버튼과 단축키가 같은 명령을 실행하므로 핸들러도, 권한
// 게이트도, 진단도 한 벌이다 — "버튼에서는 되는데 단축키로는 안 된다"가 생길 자리가 없다.

memo.commands
  .register({
    // 이 id가 매니페스트 `settings[].command`와 **글자 그대로** 같아야 한다. 어긋나면 버튼은
    // 뜨는데 눌러도 아무 일이 없다 — `npm run plugin -- lint <폴더>`가 그 어긋남을 잡는다.
    id: "where-am-i",
    // 단축키 화면(설정 › 단축키 › 「플러그인 동작」)에도 이 이름으로 나타난다. 설정 버튼과
    // 단축키는 같은 명령의 두 입구다.
    title: "지금 메모 확인",
    // `when`·`destructive`는 **일부러 쓰지 않는다.** 둘 다 메모 창에 물어봐야 판정·확인이
    // 되는데 설정 창에는 메모가 없어서, 설정 버튼으로 들어온 실행은 호스트가 거부하고 이유만
    // 진단에 남긴다. 확인이 필요하면 매니페스트 필드의 `confirm`을 써라(설정 창이 띄운다).
    run: function (memo) {
      // 설정 버튼 경로에는 **창 컨텍스트가 없다.** 창-스코프 호출은 호스트의 폴백 계약을 탄다:
      // 마지막으로 쓴 메모 창이 있으면 거기로 가고, 없으면 오류가 아니라 null이 온다.
      memo.notes
        .current()
        .then(function (note) {
          if (note === null) {
            // 토스트도 창-스코프라 같은 이유로 못 뜬다 — 남는 유일한 창구가 진단 채널이다.
            // 이 한 줄이 없으면 "눌렀는데 아무 일도 없다"의 원인을 볼 방법이 아무 데도 없다.
            return memo.runtime.log({
              message:
                "대상 메모 창을 찾지 못했습니다 — 메모 창을 한 번 사용한 뒤 다시 눌러 주세요",
            });
          }
          return memo.ui.toast({ title: "지금 메모", message: note.path });
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
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
