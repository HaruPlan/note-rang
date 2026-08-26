// 버튼 위치는 전역 "툴바 배치"(설정)가 정하고, 여기 position은 미배치 시의 기본값(폴백)이다.
//
// 사용자 노출 문자열(버튼 타이틀·명령 이름·토스트)은 이 플러그인 자기 사전에서 고른다(축 2).
// 활성 로케일은 memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽는다. 진단 채널
// (memo.runtime.log)로 가는 문구는 저작자용이라 대상 밖이다 — 단 하나, 창을 못 찾았을 때의
// noWindow만은 사용자가 「최근 오류」에서 읽고 행동해야 하는 안내라 사전에 넣는다.
var STRINGS = {
  ko: {
    // 버튼은 이모지(📋)뿐이라 title(툴팁)이 유일한 글자 힌트다 — "복사하기"는 무엇이 다른지
    // 안 알려줘 베타 피드백("용도를 모르겠다")을 낳았다. 명령 이름과 같은 문구로 통일해
    // "정해 둔 문구 틀에 넣어 복사한다"는 것을 툴팁만 봐도 알 수 있게 한다.
    buttonTitle: "문구 템플릿으로 복사",
    commandTitle: "문구 템플릿으로 복사",
    copied: "복사됨",
    failed: function (code) {
      return "복사하지 못했습니다 (" + code + ")";
    },
    noWindow:
      "복사할 메모 창을 찾지 못했습니다 — 메모 창에서 다시 눌러 주세요",
  },
  en: {
    buttonTitle: "Copy using template",
    commandTitle: "Copy using template",
    copied: "Copied",
    failed: function (code) {
      return "Couldn't copy (" + code + ")";
    },
    noWindow:
      "Couldn't find a note window to copy from — try again from a note window",
  },
};
var S = STRINGS.ko;

function fill(tmpl, note) {
  return tmpl
    .split("{path}").join(note.path || "")
    .split("{content}").join(note.content || "");
}
// 복사 본문 하나 — 툴바 버튼과 단축키(명령)가 **같은 코드**를 탄다.
// 인자 memo는 호출한 쪽이 준 것이다: 그 클릭/실행에 바인딩된 memo라 창-스코프 호출이 그 창으로
// 간다. 둘 다 메모 창에서 시작하므로 결과는 토스트로 그 자리에서 보인다.
function copyNow(memo) {
  return Promise.all([
    memo.notes.current(),
    memo.settings.get({ key: "template" }),
  ])
    .then(function (r) {
      var note = r[0];
      if (!note || !note.path) {
        // 대상 창이 없다(설정 화면에서 눌렀는데 최근에 쓴 메모 창이 없는 경우). 토스트도 창-스코프
        // 호출이라 같은 이유로 못 뜨므로, 남는 유일한 창구인 진단 채널에 이유를 남긴다.
        return memo.runtime.log({ message: S.noWindow });
      }
      var tmpl = typeof r[1] === "string" && r[1] !== "" ? r[1] : "{path}";
      return memo.clipboard.write({ text: fill(tmpl, note) }).then(function () {
        return memo.ui.toast({ title: S.copied });
      });
    })
    .catch(function (e) {
      memo.ui.toast({ title: S.failed(e.code) }).catch(function (t) {
        memo.runtime.log({ message: "toast 실패: " + t.code });
      });
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}
function activeLocale() {
  return memo.i18n && typeof memo.i18n.locale === "function"
    ? memo.i18n.locale()
    : Promise.resolve("ko");
}
activeLocale()
  .then(function (loc) {
    S = STRINGS[loc] || STRINGS.ko;
    return memo.ui.addToolbarButton({
      id: "copy-ai-prompt",
      label: "📋",
      title: S.buttonTitle,
      position: "bottom-left",
      // onClick은 **이 클릭에 바인딩된 memo**를 인자로 받아 전역을 가린다(이름이 같아 본문은 그대로).
      // 왜: 위 Promise.all은 브리지 thenable을 네이티브 프라미스로 흡수해 전역 컨텍스트 전파를
      // 끊는다 — 그러면 클립보드·토스트가 "마지막 클릭 창"으로 새어 창 A에서 누른 복사가 창 B에서
      // 뜬다. 인자로 받은 memo는 토큰을 클로저로 물고 있어 어떤 비동기 경계도 안전하다.
      onClick: function (memo) {
        copyNow(memo);
      }
    });
  })
  .then(function () {
    // 설정 › 단축키의 「플러그인 동작」에 나타나 사용자가 조합을 배정할 수 있다 — 툴바
    // 버튼을 안 쓰는 사람의 진입점이다. 매니페스트 액션 버튼은 걸지 않는다: 설정 창에는
    // 노트가 없어 "마지막으로 쓴 메모 창"으로 폴백해야 하는데, 그 컨텍스트는 메모 창에서 이
    // 플러그인을 한 번 써야 생긴다 — 즉 시험용 버튼이 시험하려는 일을 먼저 해야 동작하는
    // 자기모순이라 설정 화면에서는 「복사 문구」 미리보기로 답한다.
    return memo.commands.register({
      id: "copy-now",
      title: S.commandTitle,
      run: function (memo) {
        copyNow(memo);
      }
    });
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
