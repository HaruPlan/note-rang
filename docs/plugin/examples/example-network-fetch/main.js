/// <reference path="../../api-reference.d.ts" />
/* global memo */ // 전역 `memo`는 호스트가 샌드박스에 주입한다(린터에게 알리는 선언).
// 예제: 네트워크 요청 — 공개 API에 https 요청을 보내 응답 한 줄을 지금 노트에 삽입한다.
//
// 역할: `memo.network.fetch`의 정본 사용례. 샌드박스는 네트워크에 직접 닿지 못하므로
// 호스트(Rust)에게 대신 요청하게 시킨다.
// 왜: 이 예제가 보여 주는 계약 네 가지 —
// (1) 네트워크는 **도메인별 권한**이다 — `network:api.github.com`을 선언·부여받아야 그
//     호스트로만 나갈 수 있다(다른 호스트로는 못 나간다). URL의 호스트가 곧 필요한 권한이다.
// (2) **https 전용**이고, 호스트가 사설/내부 IP·클라우드 메타데이터를 차단하며(SSRF 방어)
//     리다이렉트를 따라가지 않고 쿠키·인증 헤더를 싣지 않는다 — 방어는 전부 호스트가 한다.
// (3) 응답은 `{ status, headers, body }`다. 3xx도 그대로 온다(리다이렉트 미추적) — 상태를
//     직접 확인해야 한다. 본문은 문자열이다(최대 5MiB).
// (4) 실패는 **코드로 분기**한다(NETWORK_BLOCKED·NETWORK_TIMEOUT·NETWORK_TOO_LARGE 등) —
//     한국어 문구를 매칭하지 마라.

memo.ui
  .addToolbarButton({
    id: "fetch-zen",
    label: "🌐",
    title: "GitHub Zen 한 줄을 노트에 삽입",
    position: "bottom-right",

    // ★ 첫 인자로 이 클릭에 바인딩된 memo가 온다 — editor.insertText(창-스코프)가 "클릭한 그
    //   창"의 커서에 정확히 삽입하게 한다. network.fetch는 호스트 스코프지만 같은 memo로
    //   통일해 "이 핸들러 안에서는 전역을 쓰지 않는다"는 규칙을 단순하게 지킨다.
    onClick: function (memo) {
      memo.network
        // 호스트가 대신 GET https://api.github.com/zen를 보낸다(method 생략 = GET).
        .fetch({ url: "https://api.github.com/zen" })
        .then(function (res) {
          // 3xx도 그대로 온다(리다이렉트 미추적) — 2xx만 본문을 신뢰한다.
          if (res.status < 200 || res.status >= 300) {
            return memo.ui.toast({
              title: "요청 실패",
              message: "HTTP " + res.status,
              style: "failure",
            });
          }
          // 응답 본문(문자열)을 커서 위치에 삽입한다(notes:write 게이트).
          return memo.editor
            .insertText({ text: res.body + "\n", mode: "cursor" })
            .then(function () {
              return memo.ui.toast({ title: "한 줄 받아 삽입했습니다" });
            });
        })
        .catch(function (e) {
          // 실패는 두 곳에 남긴다: 사용자에게 토스트, 기록에 진단. 사설대역·타임아웃 등은
          // 문구가 아니라 code로 분기한다(NETWORK_BLOCKED / NETWORK_TIMEOUT / …).
          var text =
            e.code === "NETWORK_BLOCKED"
              ? "차단된 주소입니다"
              : e.code === "NETWORK_TIMEOUT"
                ? "응답이 없습니다(시간 초과)"
                : "요청하지 못했습니다 (" + e.code + ")";
          memo.ui.toast({ title: text, style: "failure" }).catch(function (t) {
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
