# 예제: 툴바 버튼

노트 툴바에 📋 버튼을 답니다. 누르면 지금 메모의 파일 경로를 클립보드에 복사하고 토스트로 알립니다.

## 설정

| 키       | 뜻                                        |
| -------- | ----------------------------------------- |
| `prefix` | 복사할 때 경로 앞에 붙일 문구(기본: 없음) |

## 무엇을 보여주나

### 1. `onClick(memo)` — 바인딩된 브리지

```js
onClick: function (memo) {
  memo.ui.toast({ title: "안녕" }); // ← 이 memo는 "클릭한 그 창"에 고정돼 있다
}
```

노트 창은 여러 개가 동시에 열린다. 그래서 창-스코프 호출(`ui.toast`·`notes.current`·`clipboard.write`·`editor.*` 등)은 "어느 창의 클릭에서 나왔는가"를 호스트가 알아야 한다. 호스트는 클릭마다 불투명 토큰을 발급하고, `onClick`의 **첫 인자로 오는 `memo`** 가 그 토큰을 클로저에 물고 있다. 인자 이름을 `memo`로 두면 전역 `memo`를 가려서, 본문 코드를 그대로 두고도 안전해진다.

전역 `memo`는 최선 노력으로만 토큰을 전파한다 — `.then`/`.catch`/`.finally` 체인과 브리지 호출의 직접 `await`까지는 정확하지만, `Promise.all`·`setTimeout`·비-브리지 `await` 뒤에는 토큰이 유실되고 "마지막으로 클릭한 창"으로 폴백한다.

### 2. `null`을 인정하기

```js
const note = await memo.notes.current();
if (note === null) return; // 창 컨텍스트가 없으면 오류가 아니라 null이다
```

창-스코프 호출은 컨텍스트를 못 찾으면 **오류 없이 `null`** 로 끝난다(임의 창을 타깃으로 삼는 것을 막기 위해 폴백하지 않는다). 성공과 구분되지 않으므로 반환값을 그냥 쓰면 `note.path`에서 죽는다.

### 3. 실패를 두 곳에 남기기

```js
.catch(function (e) {
  memo.ui.toast({ title: "복사하지 못했습니다 (" + e.code + ")" }); // 사용자에게
  memo.runtime.log({ message: e.call + " → " + e.code });          // 기록에
});
```

`e.code`는 기계용 안정 코드(`PERMISSION_UNGRANTED`·`UNKNOWN_CALL` 등)이고 `e.call`은 호출명이다. 한국어 문구(`e.message`)를 매칭하면 문구를 다듬는 순간 조용히 깨진다. 기록은 「설정 › 플러그인 › 이 플러그인 › 최근 오류」에서 볼 수 있다.

### 4. 기본값은 매니페스트가 정본

`settings.getAll()`은 매니페스트 `default`가 병합된 스냅샷을 돌려준다. `main.js`에 기본값을 다시 적으면 두 곳이 벌어진다.
