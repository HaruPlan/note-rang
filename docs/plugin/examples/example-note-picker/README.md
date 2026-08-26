# 예제: 노트 골라 삽입

노트 툴바에 📚 버튼을 답니다. 누르면 전체 노트 제목이 팝업으로 뜨고, 하나 고르면 그 노트의 본문이 지금 메모의 커서 위치에 삽입됩니다.

## 무엇을 보여주나

### 1. `notes:all-read` — 전체 노트 컬렉션 읽기(민감 권한)

```js
memo.notes.list().then(function (notes) {
  // notes: [{ id, title, hidden, createdAt }] — 본문은 없다
});
memo.notes.read({ id: pickedId }).then(function (note) {
  // note: { id, content }
});
```

`notes:read`(지금 열린 메모 + 제목 목록)와 별개 권한입니다. 승인 문구 그대로 **숨긴 메모를 포함한 모든 메모**를 읽으므로, 사용자의 숨김 의도를 존중하려면 `hidden` 플래그로 거르세요(이 예제가 그렇게 합니다).

### 2. 목록은 메타만, 본문은 id로 한 건씩

`notes.list`는 본문을 싣지 않습니다(기본 500건, 상한 1000건 — 더 크면 `offset`으로 페이지). 본문이 필요한 노트만 `notes.read`로 읽습니다. 고른 사이 노트가 지워졌으면 `e.code === "NOTE_NOT_FOUND"`로 거부됩니다 — 문구가 아니라 코드로 분기하세요.

### 3. 호스트 스코프 vs 창 스코프

`notes.list`/`notes.read`는 **호스트 스코프**라 창 컨텍스트가 필요 없습니다. 반면 `ui.pickList`·`editor.insertText`는 창-스코프이므로, 반드시 `onClick`의 첫 인자로 오는 **바인딩된 memo**로 부릅니다 — 그래야 팝업과 삽입이 "클릭한 그 창"으로 갑니다.

### 4. 취소는 오류가 아니다

`ui.pickList`는 취소(Esc·바깥 클릭) 시 `null`을 돌려줍니다. 오류 처리(`catch`)가 아니라 정상 분기로 조용히 끝냅니다.
