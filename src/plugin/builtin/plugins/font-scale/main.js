// 글자 크기 플러그인 — 지금 보는 메모의 글자 크기만 A−/A+로 조절하는 툴바 버튼을 등록한다.
// 버튼 위치는 전역 "툴바 배치"(설정)가 정하고, 여기 position은 미배치 시의 기본값(폴백)이다.
//
// 사용자 노출 문자열(버튼 타이틀·토스트)은 이 플러그인 자기 사전에서 고른다(축 2). 활성
// 로케일은 memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽고 두 버튼을 함께 등록한다
// (Promise.all — 순서 의존이 없고, 각 addToolbarButton 호출 자체는 동기로 실행돼 등록이
// 지연되지 않는다).
var STEP = 10;
var STRINGS = {
  ko: {
    minusTitle: "글자 작게",
    plusTitle: "글자 크게",
    toast: function (sign, n) {
      return "글자 " + sign + n + "%";
    },
  },
  en: {
    minusTitle: "Smaller text",
    plusTitle: "Larger text",
    toast: function (sign, n) {
      return "Font " + sign + n + "%";
    },
  },
};
var S = STRINGS.ko;
// memo는 이 클릭에 바인딩된 인스턴스를 받는다 — getFontDelta→setFontDelta→toast 세 창-스코프
// 호출이 전부 같은 창으로 가야 하므로 전역 memo 대신 인자로 받은 것을 그대로 물고 간다.
function bump(memo, dir) {
  memo.editor.getFontDelta().then(function (cur) {
      var next = (typeof cur === "number" ? cur : 0) + dir * STEP;
      // 호스트가 실효 px 범위로 클램프해 실제 적용된 델타를 돌려준다 — 한계(최대/최소)에
      // 닿으면 그 값이 더 바뀌지 않으므로 토스트도 그대로 고정된다(가짜 % 증가 없음).
      return memo.editor.setFontDelta({ value: next }).then(function (applied) {
        var shown = typeof applied === "number" ? applied : next;
        return memo.ui.toast({ title: S.toast(shown > 0 ? "+" : "", shown) });
      });
    })
    .catch(function (e) {
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
    return Promise.all([
      memo.ui.addToolbarButton({
        id: "font-minus",
        label: "A−",
        title: S.minusTitle,
        position: "top-left",
        onClick: function (memo) {
          bump(memo, -1);
        },
      }),
      memo.ui.addToolbarButton({
        id: "font-plus",
        label: "A+",
        title: S.plusTitle,
        position: "top-left",
        onClick: function (memo) {
          bump(memo, 1);
        },
      }),
    ]);
  })
  .catch(function (e) {
    // memo.runtime은 항상 있는 무권한 네임스페이스이지만, 이 코드를 실행하는 일부 테스트
    // 하니스가 흉내 내지 않는다 — 방어적으로 감싼다(실제 호스트에서는 늘 있다).
    if (memo.runtime && typeof memo.runtime.log === "function") {
      memo.runtime.log({ message: "버튼 등록 실패: " + e.call + " → " + e.code });
    }
  });
