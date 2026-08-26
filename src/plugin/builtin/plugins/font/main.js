// 폰트 플러그인 — 테마 폰트 피커에 제공할 글꼴 후보를 등록한다(능력 등록).
//
// 패밀리 라벨("시스템"/"세리프"/"모노스페이스")은 이 플러그인 자기 사전에서 고른다(축 2) —
// 호스트도 같은 문구를 자기 t()로 낼 수 있지만(`theme/font.ts`의 DEFAULT_FONT는 언어팩
// 설치가 있어야 en을 낸다), 이 플러그인은 언어팩 설치 없이도 스스로 번역한다(자기 로컬라이즈의
// 요점 — `builtin.test.ts`가 ko 동치·en 자체 번역 두 가지를 모두 가드한다). 활성 로케일은
// memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽는다.
var STRINGS = {
  ko: { system: "시스템", serif: "세리프", monospace: "모노스페이스" },
  en: { system: "System", serif: "Serif", monospace: "Monospace" },
};
function activeLocale() {
  return memo.i18n && typeof memo.i18n.locale === "function"
    ? memo.i18n.locale()
    : Promise.resolve("ko");
}
activeLocale()
  .then(function (loc) {
    var S = STRINGS[loc] || STRINGS.ko;
    return memo.font.register({
      families: [
        {
          label: S.system,
          stack:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
        { label: S.serif, stack: "Georgia, 'Times New Roman', serif" },
        {
          label: S.monospace,
          stack: "ui-monospace, SFMono-Regular, Menlo, monospace",
        },
      ],
      includeSystem: true,
    });
  })
  .catch(function (e) {
    // memo.runtime은 항상 있는 무권한 네임스페이스이지만, 이 코드를 실행하는 일부 테스트
    // 하니스가 흉내 내지 않는다 — 방어적으로 감싼다(실제 호스트에서는 늘 있다).
    if (memo.runtime && typeof memo.runtime.log === "function") {
      memo.runtime.log({ message: "능력 등록 실패: " + e.call + " → " + e.code });
    }
  });
