// 단어 수 플러그인 — 지금 메모의 단어·글자 수를 툴바에 **두 개의 클릭 가능한 상태 아이템**
// (+ 상태 아이템 onClick)으로 보여준다. 노트가 열리거나 저장될 때(자동저장 포함) 그 창의
// 텍스트를 갱신하고, 세그먼트를 누르면 그 순간 표시된 텍스트("123 단어"처럼 로케일 표기
// 그대로)를 클립보드에 복사하고 토스트로 확인한다.
//
// 왜 상태 아이템 둘인가(하나가 아니라): "N 단어"와 "M 자"를 각각 클릭해 그 숫자만 복사하고
// 싶다는 요청 — 상태 아이템 하나 안에 "부분 클릭 영역"을 두는 API는 없으므로(클릭은 아이템
// 단위), 세그먼트마다 별도 등록이 가장 작은 변경이다. 부수 효과로 사용자가 「툴바 배치」에서
// 둘을 따로 옮기거나 하나만 숨길 수 있다.
//
// 상태 아이템 문구는 이 플러그인 자기 사전에서 고른다(축 2). 활성 로케일은
// memo.i18n.locale()(무권한, 캐시된 값)로 한 번만 읽고, 그 뒤 모든 갱신(refresh)이 같은
// 사전을 재사용한다(상주 샌드박스 1개가 모든 노트 창을 공유 — font-scale의 S와 같은 결).
var STRINGS = {
  ko: {
    wordsTitle: "단어 수 — 눌러서 복사",
    charsTitle: "글자 수 — 눌러서 복사",
    words: function (n) {
      return n + " 단어";
    },
    chars: function (n) {
      return n + " 자";
    },
    copied: "복사됨",
    copyFailed: "복사하지 못했어요",
  },
  en: {
    wordsTitle: "Word count — click to copy",
    charsTitle: "Character count — click to copy",
    words: function (n) {
      return n + " words";
    },
    chars: function (n) {
      return n + " chars";
    },
    copied: "Copied",
    copyFailed: "Couldn't copy",
  },
};
var S = STRINGS.ko;

/** 본문 텍스트 하나에서 단어·글자 수를 센다(refresh·copySegment가 공유). */
function counts(text) {
  return {
    words: (text.trim().match(/\S+/g) || []).length,
    chars: text.length,
  };
}

// 이벤트 핸들러가 받은 **바인딩된 memo**로 그 창의 두 상태 아이템을 갱신한다(창마다 값이 다르다).
function refresh(memo) {
  return memo.notes
    .current()
    .then(function (note) {
      var c = counts((note && note.content) || "");
      return Promise.all([
        memo.ui.updateStatusItem({
          id: "word-count-words",
          text: S.words(c.words),
        }),
        memo.ui.updateStatusItem({
          id: "word-count-chars",
          text: S.chars(c.chars),
        }),
      ]);
    })
    .catch(function (e) {
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}

// 세그먼트 클릭 → 지금 표시된 그 텍스트를 클립보드에 복사한다. 값을 따로 캐시해 두지 않고
// 클릭 시점에 다시 센다: 이 샌드박스는 모든 노트 창이 공유하는 상주 인스턴스라(창마다 캐시
// 슬롯을 또 둬야 한다) memo.notes.current()가 이미 **이 클릭이 난 창**으로 바인딩돼 있어
// (onClick의 첫 인자) refresh와 완전히 같은 소스로 같은 값을 얻는다 — 클릭 직전 내용이
// 바뀌지 않았다면(보통 그렇다) 화면에 보이는 것과 정확히 같은 문구가 복사된다.
function copySegment(memo, format) {
  return memo.notes
    .current()
    .then(function (note) {
      var c = counts((note && note.content) || "");
      return memo.clipboard.write({ text: format(c) }).then(function () {
        return memo.ui.toast({ title: S.copied });
      });
    })
    .catch(function (e) {
      // 실패를 **눈에 보이게** 알린다. 예전에는 로그만 남겨서, 클립보드가 거절될 때
      // (Windows 웹뷰 등) 눌러도 아무 일도 없는 것처럼 보였다 — 어디가 고장인지 알 수 없었다.
      memo.runtime.log({ message: e.call + " → " + e.code });
      return memo.ui.toast({ title: S.copyFailed, style: "failure" });
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
      memo.ui.addStatusItem({
        id: "word-count-words",
        text: S.words(0),
        title: S.wordsTitle,
        position: "bottom-right",
        // onClick은 **이 클릭에 바인딩된 memo**를 인자로 받아 전역을 가린다(font-scale의
        // onClick과 같은 이유 — 클립보드·토스트가 클릭한 창이 아니라 "마지막 클릭 창"으로
        // 새는 것을 막는다).
        onClick: function (memo) {
          copySegment(memo, function (c) {
            return S.words(c.words);
          });
        },
      }),
      memo.ui.addStatusItem({
        id: "word-count-chars",
        text: S.chars(0),
        title: S.charsTitle,
        position: "bottom-right",
        onClick: function (memo) {
          copySegment(memo, function (c) {
            return S.chars(c.chars);
          });
        },
      }),
    ]);
  })
  .then(function () {
    // note:opened로 첫 값을, note:saved(자동저장 디바운스 뒤)로 이후 값을 채운다.
    // 두 구독 모두 notes:read가 필요하고(이름별 게이트), events.on 자체는 settings 권한을 탄다.
    memo.events.on({ name: "note:opened", handler: refresh });
    memo.events.on({ name: "note:saved", handler: refresh });
    return memo.runtime.ready();
  })
  .catch(function (e) {
    memo.runtime.log({
      message: "상태 아이템 등록 실패: " + e.call + " → " + e.code,
    });
  });
