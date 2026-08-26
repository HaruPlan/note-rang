/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 스타터 — memo 플러그인의 가장 작은 완본.
//
// 역할: `==강조==` 표기를 형광펜 스타일로 그린다(인라인 패턴 등록 하나).
// 왜: 새 플러그인을 시작할 때 복사할 최소 골격이다. memo 플러그인의 뼈대는 늘 이 3단이다 —
// **등록 → 마감 선언 → 실패 기록**.
//
// main.js는 격리 iframe에서 최상위 동기로 실행된다. DOM·CSS 셀렉터·정규식·네트워크에는
// 닿을 수 없고, `memo.*` 구조화 호출로만 앱을 확장한다. 모든 호출은 인자 객체 하나를 받고
// Promise를 돌려준다.

memo.editor
  .registerInlinePattern({
    id: "highlight",
    open: "==",
    close: "==",
    // 스타일은 **구조화 화이트리스트**다 — raw CSS 문자열도, 셀렉터도 줄 수 없다.
    // 허용 속성과 색 의미 토큰(accent·danger·contrast…)은 authoring.md의
    // "인라인 패턴 스타일" 절 참고. 화이트리스트 밖 속성은 조용히 버려진다.
    style: {
      backgroundColor: "rgba(250, 204, 21, 0.35)",
      borderRadius: "2px",
    },
  })
  .then(function () {
    // 등록 마감을 명시한다. 이 호출이 없어도 부트스트랩이 "조용해지면" 알아서 마감하지만,
    // 그 폴백은 계약이 아니라 편의다 — 명시해 두면 나중에 비동기 초기화를 넣어도 안 깨진다.
    return memo.runtime.ready();
  })
  .catch(function (e) {
    // .catch를 걸지 않으면 실패의 흔적이 **아무 데도** 남지 않는다(불투명 origin이라
    // devtools도 못 붙는다). e.code는 기계용 안정 코드, e.call은 호출명이다 —
    // 한국어 문구(e.message)를 매칭하지 마라.
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
