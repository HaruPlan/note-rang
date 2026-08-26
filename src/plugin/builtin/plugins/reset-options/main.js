// 옵션 초기화 플러그인 — 지금 보는 메모만의 옵션(배경·글자 크기·투명도·핀 등)을 전역 기본값으로
// 되돌리는 툴바 버튼을 등록한다. 실제 초기화(override 비우기·재적용·툴바 재동기화·영속화 + 확인
// 게이트)는 네이티브 노트 창이 수행한다(memo.notes.resetOptions 브리지) — 확인 문구 자체는
// 호스트가 t()로 이미 로케일화해서 보여준다(`note.window.reset-confirm`), 이 파일이 다시
// 갖고 있을 필요가 없다.
// 버튼 위치는 전역 "툴바 배치"(설정)가 정하고, 여기 position은 미배치 시의 기본값(폴백)이다.
//
// 버튼 타이틀(툴팁)은 이 플러그인 자기 사전에서 고른다(축 2). 활성 로케일은
// memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽는다.
var STRINGS = {
  ko: { buttonTitle: "옵션 초기화" },
  en: { buttonTitle: "Reset options" },
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
      id: "reset",
      label: "↺",
      title: S.buttonTitle,
      position: "bottom-right",
      onClick: function (memo) {
        // notes.resetOptions가 정본이자 유일한 이름이다(단수 note.resetOptions는 게이트에 없어
        // UNKNOWN_CALL). 바인딩된 memo로 불러 실패를 놓치지 않는다.
        memo.notes.resetOptions().catch(function (e) {
          memo.runtime.log({ message: e.call + " → " + e.code });
        });
      },
    });
  })
  .catch(function (e) {
    // memo.runtime은 항상 있는 무권한 네임스페이스이지만, 이 코드를 실행하는 일부 테스트
    // 하니스가 흉내 내지 않는다 — 방어적으로 감싼다(실제 호스트에서는 늘 있다).
    if (memo.runtime && typeof memo.runtime.log === "function") {
      memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
    }
  });
