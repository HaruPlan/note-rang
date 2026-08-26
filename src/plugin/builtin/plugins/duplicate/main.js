// 복제 플러그인 — 현재 메모를 내용·설정이 똑같은 새 메모로 복제하는 툴바 버튼을 등록한다.
// 실제 복제(본문+override 복사)와 새 창 열기는 네이티브가 수행한다(memo.notes.duplicate 브리지).
// 버튼 위치는 전역 "툴바 배치"(설정)가 정하고, 여기 position은 미배치 시의 기본값(폴백)이다.
//
// 사용자 노출 문자열(버튼 타이틀·토스트)은 이 플러그인 자기 사전에서 고른다(축 2 — manifest
// nls와 같은 결이지만 런타임 문자열이라 main.js 안에 둔다). 활성 로케일은 memo.i18n.locale()
// (무권한, 캐시된 값)로 한 번만 읽고서 등록을 이어간다 — memo.i18n이 없는 구버전 테스트
// 하니스에서도 ko로 안전하게 동작한다(다른 번들의 memo.runtime 방어와 같은 결).
var STRINGS = {
  ko: {
    buttonTitle: "메모 복제 — 내용과 설정이 같은 새 메모",
    duplicated: "복제됨",
    failed: function (code) {
      return "복제하지 못했습니다 (" + code + ")";
    },
  },
  en: {
    buttonTitle: "Duplicate note — a new note with the same content and settings",
    duplicated: "Duplicated",
    failed: function (code) {
      return "Couldn't duplicate (" + code + ")";
    },
  },
};
function activeLocale() {
  return memo.i18n && typeof memo.i18n.locale === "function"
    ? memo.i18n.locale()
    : Promise.resolve("ko");
}
activeLocale()
  .then(function (loc) {
    var S = STRINGS[loc] || STRINGS.ko;
    return memo.ui.addToolbarButton({
      id: "duplicate-note",
      label: "⧉",
      title: S.buttonTitle,
      position: "bottom-left",
      // 바인딩된 memo로 받아 이어지는 두 창-스코프 호출(duplicate·toast)이 같은 창으로 간다.
      onClick: function (memo) {
        memo.notes
          .duplicate()
          .then(function () {
            return memo.ui.toast({ title: S.duplicated });
          })
          .catch(function (e) {
            memo.ui
              .toast({ title: S.failed(e.code) })
              .catch(function (t) {
                memo.runtime.log({ message: "toast 실패: " + t.code });
              });
            memo.runtime.log({ message: e.call + " → " + e.code });
          });
      },
    });
  })
  .then(function () {
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
  });
