# 예제: 상태 아이템 + 컨텍스트 메뉴 (example-status-menu)

`ui.addStatusItem` · `ui.updateStatusItem` · `ui.addMenuItem`의 정본 사용례. 툴바에 상태
아이템 하나를 띄우고, 우클릭 메뉴 항목을 누를 때마다 카운터를 올려 그 값을 갱신한다.
권한은 `ui` 하나뿐이다.

이 예제를 사이드로드(「설정 › 플러그인 › 로컬 폴더」)로 설치하면 커뮤니티 플러그인으로
실행되므로, `bump` 메뉴 항목이 노트 우클릭 메뉴에 실제로 나열되고 눌러진다(`authoring.md`의
「에디터 컨텍스트 메뉴」 참고 — 빌트인 번들만 그 자리에서 빠진다).

## 무엇을 보여주나

- **`ui.addStatusItem`** — 툴바에 라이브 텍스트 아이템을 등록한다(호스트 스코프 — 스냅샷에
  모여 모든 창의 툴바에 뜬다).
- **`ui.updateStatusItem`** — 그 아이템의 텍스트를 갱신한다. **창-스코프**다: 값이 창마다
  다를 수 있어 갱신은 그 갱신을 낳은 창으로 위임된다 → run이 받은 **바인딩된 memo**로 부른다.
- **`ui.addMenuItem`** — 우클릭(컨텍스트) 메뉴 항목. `run`은 필수이고, 첫 인자는 바인딩된
  memo, 둘째 인자는 `payload`다. `when`을 생략하면 항상 표시된다(창 상태 두 키
  `note.isEmpty`·`note.hasSelection`으로 좁힐 수 있다).

## 권한

| 권한 | 왜                                                      |
| ---- | ------------------------------------------------------- |
| `ui` | 상태 아이템·메뉴 항목을 등록하고 상태 텍스트를 갱신한다 |

`payload.selectedText`(선택 텍스트)는 이 예제가 쓰지 않으므로 `notes:read`를 선언하지 않는다 —
선택 텍스트를 쓰려면 `notes:read`를 선언·부여받아야 그 필드가 채워진다.

## 앱 없이 시험

```
npm run plugin -- run   docs/plugin/examples/example-status-menu
npm run plugin -- test  docs/plugin/examples/example-status-menu --menu=bump
```

`--menu=bump`은 메뉴 항목의 run을 앱 없이 발화시킨다 — `ui.updateStatusItem` 호출이 덤프에
찍히는지 확인한다.
