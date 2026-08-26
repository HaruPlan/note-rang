# 예제: 네트워크 요청 (`memo.network.fetch`)

툴바 버튼 하나(🌐)를 등록한다. 누르면 `https://api.github.com/zen`에 GET 요청을 보내(호스트가
대신 전송), 받은 한 줄을 지금 노트의 커서 위치에 삽입한다.

## 이 예제가 보여 주는 것

- **네트워크는 도메인별 권한이다.** `network:api.github.com`을 선언·부여받아야 그 호스트로만
  나갈 수 있다 — URL의 호스트가 곧 필요한 권한이다. 선언 밖 호스트로는 못 나간다.
- **샌드박스는 네트워크에 직접 닿지 못한다.** 호스트(Rust)가 대신 fetch하고 응답을 돌려준다.
  그래서 모든 방어를 호스트가 소유한다:
  - **https 전용** — http·file 등은 `NETWORK_SCHEME`으로 거부.
  - **SSRF 차단** — 사설/내부 IP·링크로컬·클라우드 메타데이터로 해석되면 `NETWORK_BLOCKED`.
  - **리다이렉트 미추적** — 3xx는 그대로 반환(따라가면 검사를 우회하므로). 새 URL로 다시
    부르면 그 URL도 도메인 승인·SSRF 검사를 다시 받는다.
  - **자격증명 미전달** — 앱 쿠키·인증 헤더를 싣지 않는다. 요청 헤더의 Host·Cookie·
    Authorization 등은 호스트가 떼어낸다.
  - **상한** — 응답 5MiB(`NETWORK_TOO_LARGE`)·요청 30초(`NETWORK_TIMEOUT`).
- **응답은 `{ status, headers, body }`.** `status`는 3xx도 그대로(리다이렉트 미추적)이니 직접
  확인한다. `headers`는 `{ name, value }` 배열(중복 보존), `body`는 문자열(최대 5MiB).
- **실패는 code로 분기한다** — `NETWORK_BLOCKED`·`NETWORK_TIMEOUT`·`NETWORK_TOO_LARGE`·
  `NETWORK_DNS`·`NETWORK_METHOD` 등. 한국어 문구(`err.message`)를 매칭하지 마라.

## 요청 형태

```js
memo.network.fetch({
  url: "https://api.example.com/v1/x", // https만. 이 호스트의 network:<호스트> 권한 필요
  method: "POST", // 생략하면 GET. GET·POST·PUT·PATCH·DELETE·HEAD만
  headers: [{ name: "Accept", value: "application/json" }], // 응답과 같은 배열 형태
  body: JSON.stringify({ a: 1 }), // 문자열만(객체는 직접 stringify)
});
```

앱에 설치해 확인하려면 「설정 › 플러그인 › 로컬 폴더」로 이 폴더를 설치하고, 승인 화면에서
"api.github.com 네트워크"를 승인한다.
