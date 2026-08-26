# 예제: 스타터

`==강조==`로 감싼 텍스트를 노란 형광펜 스타일로 그립니다.

## 무엇을 보여주나

memo 플러그인의 뼈대 3단입니다.

1. **등록** — `memo.editor.registerInlinePattern({ id, open, close, style })`
2. **마감 선언** — `memo.runtime.ready()`
3. **실패 기록** — `.catch`에서 `memo.runtime.log`

## 왜 이 3단인가

- **등록은 부팅 시점에만 유효하다.** 등록은 `memo.runtime.ready()`를 부른 시점, 또는 부트스트랩의 조용-대기 폴백(미해결 호출이 0이 되고 한 틱 더, 상한 3초) 중 **먼저 오는 쪽**에 닫힌다. 폴백에 기대면 나중에 비동기 초기화(`settings.getAll().then(...)`)를 넣었을 때 조용히 등록이 누락될 수 있다.
- **`.catch`가 없으면 실패가 사라진다.** 플러그인은 불투명 origin iframe에서 도는 blob 스크립트라 devtools를 붙일 수 없다. reject된 Promise를 붙잡지 않으면 콘솔에도 아무것도 안 남는다. (호스트가 브리지 거부를 별도로 기록해 「설정 › 플러그인 › 최근 오류」에 보여 주지만, 원인을 좁히는 것은 결국 저작자의 메시지다.)
- **스타일은 구조화 값이다.** 문자열 CSS도 셀렉터도 줄 수 없다. 호스트가 값을 검증하고 `.cm-x-<plugin>-<pattern>` 규칙으로 주입한다.

## 다음 단계

- 버튼과 창-스코프 호출: [`../example-toolbar-button/`](../example-toolbar-button/)
- 여러 창-스코프 호출을 안전하게 잇기: [`../example-window-calls/`](../example-window-calls/)
