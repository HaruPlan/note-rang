# 예제: 현재 노트에 추가 (example-note-append)

`notes.write`(mode:`append`)의 정본 사용례. 툴바 버튼을 누르면 지금 열려 있는 노트 끝에
타임스탬프 한 줄을 **비파괴로** 이어붙인다.

## 무엇을 보여주나

- **`notes.write` append** — 본문 끝에 이어붙인다. 데이터를 잃지 않는 저마찰 기본 모드다.
  (`overwrite`는 통째로 덮되 Rust가 덮기 전에 이전 본문을 복구 슬롯에 스냅샷한다. 이 예제는
  안전한 append만 쓴다.)
- **호스트 스코프 × 창 스코프 잇기** — 대상 노트 id는 창-스코프 호출(`notes.current`)에서
  얻고, 쓰기(`notes.write`, 호스트 스코프)는 그 id로 한다. 둘을 한 `onClick` 안에서 잇는다.
- **바인딩된 `memo`** — `onClick(memo)`의 첫 인자를 써서 "클릭한 그 창"의 노트를 가리킨다.
- **열린 노트 안전** — 이 쓰기가 열려 있는 노트를 바꾸면 호스트가 그 창을 디스크에서 다시
  읽어 반영한다(낡은 버퍼가 다음 자동저장에서 이 추가분을 덮지 않게).

## 권한

| 권한          | 왜                                    |
| ------------- | ------------------------------------- |
| `ui`          | 툴바 버튼과 결과 토스트               |
| `notes:read`  | 덧붙일 대상인 지금 노트의 id를 읽는다 |
| `notes:write` | 지금 노트 끝에 한 줄을 이어붙인다     |

## 앱 없이 시험

```
npm run plugin -- run   docs/plugin/examples/example-note-append
npm run plugin -- test  docs/plugin/examples/example-note-append --click=append-stamp \
  --stub=<{"notes.current": {"id":"n1","path":"/notes/n1.md","content":""}} 파일>
```
