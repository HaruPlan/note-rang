# 예제: 창-스코프 호출 잇기

툴바의 **H** 버튼을 누르면 머리말을 물어보고, 커서 위치에 `# 머리말`을 넣고, 글자를 5% 키운 뒤 결과를 알립니다.

## 무엇을 보여주나

창-스코프 호출 **네 개**(`ui.prompt` → `editor.insertText` → `editor.getFontDelta`/`setFontDelta` → `ui.toast`)를 한 창에서 순서대로 잇는 정본 형태입니다.

## 왜 이게 어려운가

노트 창은 여러 개가 동시에 열립니다. 호스트는 클릭마다 불투명 토큰을 발급해 "이 호출이 어느 창에서 나왔는가"를 되짚는데, **전역 `memo`** 는 그 토큰을 최선 노력으로만 전파합니다. 다음 경계에서는 토큰이 유실되고 호스트는 "그 플러그인을 마지막으로 클릭한 창"으로 폴백합니다.

- `Promise.all` / `Promise.race` / `Promise.allSettled` / `Promise.resolve(브리지호출)` 로 감싼 뒤의 콜백
- `setTimeout` · `requestAnimationFrame` · DOM 이벤트 콜백 안의 호출
- 브리지가 아닌 프라미스(`await new Promise(...)`)를 기다린 **뒤**의 호출

창이 하나뿐이면 폴백이 우연히 맞아떨어져서 **버그가 보이지 않습니다.** 창을 두 개 열고 A에서 눌렀을 때 B에 삽입되는 것을 보고서야 알게 됩니다.

### 하면 안 되는 것

```js
onClick: function () {
  // ❌ 전역 memo + Promise.all — 콜백 안에서 토큰이 유실된다
  Promise.all([memo.ui.prompt({ title: "머리말" }), memo.editor.getFontDelta()])
    .then(function (r) {
      memo.editor.insertText({ text: r[0] }); // 다른 창에 들어갈 수 있다
    });
}
```

### 정본

```js
onClick: function (memo) {   // ← 인자가 전역을 가린다
  memo.ui.prompt({ title: "머리말" })
    .then(function (title) {
      if (title === null) return null;        // 취소·컨텍스트 부재
      return memo.editor.insertText({ text: title });
    })
    .catch(function (e) { memo.runtime.log({ message: e.call + " → " + e.code }); });
}
```

바인딩된 `memo`는 토큰을 클로저에 물고 있어 **어떤** 비동기 경계를 넘어도 유지됩니다. `Promise.all`을 써도 되지만(이 인자를 쓰는 한 안전합니다), 위 예제는 **순차**로 이었습니다 — 뒤 단계가 앞 단계의 결과(입력값·현재 델타)에 의존하기 때문입니다.

## 그 밖에

- **`null` 확인이 단계마다 필요합니다.** `ui.prompt`는 취소 시 `null`, 창 컨텍스트가 없어도 `null`입니다. `getFontDelta`도 마찬가지입니다.
- **`setFontDelta`는 클램프된 실제 값을 돌려줍니다.** 요청한 값이 아니라 그 반환값을 토스트에 써야 표시가 정직해집니다.
- **`caret`은 삽입된 본문 안에서의 오프셋입니다.** 텍스트 길이를 그대로 주면 삽입 끝(다음 줄 머리)에 커서가 놓입니다.
