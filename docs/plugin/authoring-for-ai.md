# 플러그인 저작 — AI 에이전트용 압축 가이드

**이 파일 하나를 컨텍스트에 통째로 넣고 시작하라.** 사람이 읽는 전체 설명은
[`authoring.md`](./authoring.md), 기계가독 전체 계약(호출별 인자·반환·권한·
오류코드·매니페스트 JSON Schema)은 [`api-reference.json`](./api-reference.json)이다. 여기 적힌
값 어휘·명령은 전부 실행해서 확인한 것이고, 셋이 어긋나면 `api-reference.json`이 정본이다
(코드에서 생성되므로 거짓말할 수 없다).

## 최소 워크플로

아래 명령은 이 저장소에서 그대로 실행해 검증했다.

```bash
# 1. 뼈대 생성 — template: inline-pattern | toolbar-button | settings-driven | command
npm run plugin -- scaffold my-plugin --template=toolbar-button --dir=./my-plugin
# → manifest.json · main.js · README.md · plugin-api.d.ts(자동완성용) · plugin-manifest.schema.json

# 2. 코드를 쓴다(아래 "자주 틀리는 함정"을 먼저 훑어라)

# 3. 타입 동봉을 최신으로(자동완성 오타 검출)
npm run plugin -- types ./my-plugin

# 4. 앱 없이 로드해 등록 결과를 확인
npm run plugin -- run ./my-plugin
# 클릭/명령/이벤트/메뉴/트레이/선택 액션 하나를 발화시켜 그 호출 시퀀스만 본다
npm run plugin -- test ./my-plugin --click=<buttonId>
npm run plugin -- test ./my-plugin --command=<commandId>
npm run plugin -- test ./my-plugin --event=note:saved --payload='{"path":"x.md"}'
npm run plugin -- test ./my-plugin --menu=<menuItemId>   # 컨텍스트 메뉴 항목 run (선택 텍스트는 --payload='{"selectedText":"..."}')
npm run plugin -- test ./my-plugin --tray=<trayItemId>   # 메뉴바 트레이 항목 run (창 컨텍스트·payload 없음)
npm run plugin -- test ./my-plugin --selection=<actionId> --payload='{"selectedText":"1+1"}'  # 선택 액션 run (match가 맞아야 실행된다 — 앱과 같은 판정)
# 창-스코프 호출 응답을 채우려면 --stub=<파일 경로>(인라인 JSON이 아니라 JSON 파일):
#   --stub=./stubs.json   ← 파일 내용 예: {"notes.current": {"id":"n1", "path":"/a.md"}}

# 5. 정적 검사로 마무리
npm run plugin -- validate ./my-plugin   # 매니페스트 구조만
npm run plugin -- lint ./my-plugin       # 존재하지 않는 호출·미선언 권한·kind 게이트·when 키·이벤트 이름 등

# 기계가 결과를 파싱할 때는 --json + --silent(안 붙이면 npm 배너가 JSON 앞에 섞여 깨진다)
npm run plugin --silent -- lint ./my-plugin --json
```

마지막은 앱의 「설정 › 플러그인 › 로컬 폴더」로 그 폴더를 설치해 실제로 확인한다.
`validate`/`lint`는 정적 검사만 한다 — 등록 마감 타이밍 같은 실행 의미론은 `run`/`test`가,
iframe/postMessage 격리는 e2e가 지킨다(범위 밖).

## 자주 틀리는 함정

이번 오버홀의 코드 리뷰가 실제로 잡아낸(또는 잡도록 설계된) 실수들이다. 번호는 심각도순이
아니다.

1. **예약 호출을 쓰면 안 된다.** 이름·권한이 있어도 실행 경로가 없는 호출은 `RESERVED_CALL`로
   거부된다: `editor.registerWidget` · `clipboard.read` · `vault.read` · `vault.write` ·
   `windows.open`. `api-reference.json`의 `calls[].reserved === true`로 전수
   확인 가능(이 목록이 정본 — `ui.addMenuItem`·`notes.write`·`network.fetch`는 이번 오버홀에서
   예약이 풀려 정상 동작하는 호출이니 여기 없다). `lint`가 이 호출을 정적으로 잡는다.
2. **`kind`로 능력/액션을 구분한다.** `theme.register`·`background.register`·`font.register`·
   `window.register`(능력 등록)를 부르려면 매니페스트에 `"kind": "capability"`가 필요하다.
   기본값(`"action"`, 생략 시)에서 부르면 권한 검사보다 **먼저** `WRONG_PLUGIN_KIND`로 거부된다
   — 권한을 선언해도 통과하지 않는다.
3. **인자는 언제나 객체 하나.** `memo.ns.method({ ... })`만 유효하다. 인자를 2개 이상 주거나
   객체가 아닌 값을 주면 **동기 `TypeError`**가 나서 플러그인 로드 자체가 실패한다(등록이
   하나도 안 남는다 — 조용한 무시가 아니다). 예외는 하나뿐: `memo.runtime.log("메시지")`.
   `memo.settings.get`도 **객체 인자만** 받는다 — 문자열 축약형 `get("key")`은 `INVALID_ARGS`로
   거부된다(`{ key: "key" }`로 써라).
4. **창-스코프 호출은 클릭/이벤트 콜백의 첫 인자 `memo`로 하라.** 전역 `window.memo`로
   `Promise.all`/`Promise.race`/`setTimeout`/비-브리지 `await`(예: `await fetch(...)`) 뒤에
   호출하면 창 토큰이 새어 "마지막으로 클릭된 창"으로 폴백한다 — 창이 둘 이상이면 A의 결과가
   B에 나타난다. `.then()`/`.catch()`/`.finally()` 체인과 브리지 호출 직접 `await`까지는
   토큰이 유지된다. 대상 호출: `ui.toast`·`ui.pickList`·`ui.prompt`·`editor.getFontDelta`·
   `editor.setFontDelta`·`editor.insertText`·`clipboard.write`·`notes.current`·
   `notes.duplicate`·`notes.resetOptions`. 컨텍스트가 없으면 오류가 아니라 **`null`**로
   끝난다(성공과 구분 안 됨) — 반드시 확인하거나 `requireWindow: true`로 오류화하라. 바인딩된
   토큰도 **유휴 5분**이 지나면 민감 권한 호출은 `CONTEXT_UNAVAILABLE`로 거부된다(저위험 호출은
   무관).
5. **`when`은 닫힌 키만.** `note.isEmpty` · `platform.macos`/`platform.windows`/
   `platform.linux` · `plugin.<id>.enabled` · `settings.<자기 매니페스트에 선언한 키>` 넷뿐이다.
   `&&`/`||`/괄호/정규식 없음 — 배열이 AND고 `!`부정만 접두로 붙는다. 목록 밖 키는 등록 시점
   `INVALID_ARGS`로 거부된다(지어낸 키가 조용히 무시되지 않는다). `note.hasSelection`은
   존재하지 않는다.
6. **오류는 `err.code`로 분기하고 `err.message`(한국어 문구)를 매칭하지 마라.** 문구는
   다듬어지지만 코드는 안정적이다. 전체 코드 표는 `authoring.md`의 "실패는 조용하다"
   절 또는 `api-reference.json`의 `errorCodes` 필드에 있다.
7. **이벤트 이름은 6종으로 닫혀 있다.** `note:opened`·`note:saved`·`note:focused`·
   `note:blurred`·`note:closed`·`settings:changed`. 목록 밖 이름은 `events.on` 등록 시점
   `INVALID_ARGS`. `off`(구독 해제)는 없다 — 설정 변경마다 샌드박스가 통째로 재빌드되고
   구독도 그때 전부 새로 만들어진다.
8. **고빈도 텍스트 이벤트는 없고 앞으로도 없다.** 키 입력마다 나는 "본문 변경" 류 이벤트를
   가정하지 마라(상주 샌드박스 1개가 모든 창을 공유해 브로드캐스트 비용이 창×플러그인으로
   곱해지기 때문에 의도적으로 뺐다).
9. **셀렉터·정규식·raw DOM은 못 쓴다.** 플러그인은 불투명 origin iframe에서 돌아 앱/CodeMirror
   DOM에 못 닿는다. 인라인 패턴은 구분자(`open`/`close`) **리터럴** 매칭만 가능하고(호스트가
   정규식 특수문자를 이스케이프한다), `style`/`styleHover`는 camelCase 속성 화이트리스트 +
   안전 리터럴/의미 토큰(`accent`·`danger`·`contrast`·`contrast-border`·`contrast-fill`)만
   받는다. CSS 셀렉터·raw CSS 문자열·`url()`·`var()`·`expression`은 조용히 버려진다.
10. **`.catch`를 안 걸면 실패가 흔적 없이 사라진다.** `lint`가 최상위 호출(등록 호출 포함)의
    `MISSING_CATCH`를 경고로 잡아 준다 — 이 가이드를 검증하며 확인했다. 실패는 「설정 ›
    플러그인 › 최근 오류」 또는 `run`/`test`가 덤프하는 `진단`에 남는다.
11. **등록 마감은 `memo.runtime.ready()`를 부른 시점**(또는 미해결 호출 0 + 한 틱, 절대 상한
    3초의 조용-대기 폴백) 중 먼저 오는 쪽이다. 폴백은 계약이 아니라 편의다 — 비동기 초기화
    (예: `settings.getAll()` 뒤에 등록)가 있으면 그 체인 끝에서 `memo.runtime.ready()`를
    명시적으로 불러라.
12. **`list`형 설정은 배열로 온다.** `memo.settings.get({ key })`는 `{ name, body }[]`를
    준다(저장 블롭 문자열이 아니다). `raw` 탈출구는 없다 — `{ key, raw: true }`를 줘도 `raw`는
    무시되고 언제나 구조화 배열이 온다. 문자열 축약형 `settings.get("key")`은 `INVALID_ARGS`로
    거부된다(객체 인자만).
13. **설정 폼 기본값을 `main.js`에 다시 적지 마라.** 저장된 값이 없으면 호스트가 매니페스트의
    `default`를 자동 병합한다 — 매니페스트가 정본이다.
14. **명령/버튼 `id`를 재사용하면 덧붙는 게 아니라 치환(upsert)된다.** 복사-붙여넣기로 예제의
    `id`를 안 바꾸면 두 번째 등록이 첫 번째를 대체한다(「최근 오류」에 «중복 등록»으로 남는다).
15. **툴바 버튼은 자동으로 컨텍스트 메뉴에도 이름으로 오른다.** `addToolbarButton`으로 등록한
    동작을 `ui.addMenuItem`으로 또 등록하지 마라 — 같은 동작이 메뉴에 두 번 뜬다.
    `ui.addMenuItem`은 툴바·단축키에 자리가 없는 **메뉴 전용** 동작에만 쓴다.
16. **선택 단위 동작은 `ui.addSelectionAction`이다.** 본문을 선택하면(마우스 드래그·키보드
    선택 모두) 뜨는 선택 툴바 끝에 버튼이 붙고 단축키도 배정할 수 있다. `match`는 **정규식이
    아니라 닫힌 어휘**다(`charClasses`·`singleLine`·`maxLength` — 부류 이름을 지어내면 등록이
    `INVALID_ARGS`로 거부된다). `payload.selectedText`는 `notes:read`가 있을 때만 채워지고, 되쓰기는 새 경로가
    아니라 `memo.editor.insertText`(`notes:write`)를 그대로 쓴다.
17. **`note:opened` 핸들러는 여러 번 불린다.** 설정 저장·플러그인 토글마다 샌드박스가 통째로
    재빌드되는데, 열려 있는 노트 창은 이제 리로드되지 않고 제자리에서 따라온다 — 그래서 새
    샌드박스 인스턴스에 "이 노트가 열려 있다"를 알리려고 창이 `note:opened`를 **재발신**한다
    (`note:closed`는 나지 않는다 — 창이 닫힌 적이 없다). 같은 노트에 대해 **멱등**하게 써라
    (상태 아이템의 첫 값 채우기가 정확히 이 계약 위에 서 있다).

## 권한 — 방향 감각만 (정본은 `api-reference.json`/`authoring.md`)

| 등급                       | 권한                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 저위험(선언만으로 통과)    | `ui` · `editor` · `settings` · `storage` · `commands` · `theme` · `background` · `font` · `window-control`                            |
| 민감(승인 필요, 지금 동작) | `notes:read` · `notes:all-read` · `notes:write` · `clipboard` · `windows`(호출은 예약) · `network:<도메인>` · `invoke:<대상>`(실험적) |
| 민감, 지금 전부 예약       | `vault:read` · `vault:write`(승인해도 대응 호출이 전부 `RESERVED_CALL`)                                                               |
| 렌더 시점 게이트           | `embed:<도메인>` — 호출이 아니라 블록 임베드가 그 도메인을 렌더할 때만 확인된다                                                       |

`storage`는 플러그인 **자신의** 데이터 전용이고 노트는 못 읽는다(`notes:*`와 무관). 지금 쓰지
않을 권한은 선언하지 마라 — 승인 화면만 무겁게 만든다.

**네트워크(`network:<도메인>`).** `memo.network.fetch`는 호스트가 대신 https 요청을 보내
준다(샌드박스는 네트워크에 직접 못 닿는다). 승인 단위가 **도메인**이라 URL의 호스트마다
`network:<호스트>`를 따로 선언·부여해야 한다(예 `network:api.github.com`) — 선언 밖 호스트로는
못 나간다. https 전용이고, 호스트가 사설/내부 IP·클라우드 메타데이터를 차단하며(`NETWORK_BLOCKED`)
리다이렉트를 따라가지 않고 쿠키·인증 헤더를 싣지 않는다. 실패는 `err.code`로 분기하라
(`NETWORK_BLOCKED`·`NETWORK_TIMEOUT`·`NETWORK_TOO_LARGE`·`NETWORK_SCHEME`·`NETWORK_DNS`·
`NETWORK_METHOD`). 요청 헤더·응답 헤더는 둘 다 `{ name, value }[]` 배열이고, 요청 body는
문자열만(객체는 직접 `JSON.stringify`). 정본 예제: [`example-network-fetch`](./examples/example-network-fetch/).

**플러그인 간 호출(`invoke:<대상>` — 실험적).** `memo.commands.invoke({ pluginId, commandId, args })`는
다른 플러그인이 **공개한** 명령을 부른다. 양쪽 동의로만 된다: 대상은 매니페스트 `exposes`에 명령
id를 적어 공개하고(기본 비공개), 호출측은 `invoke:<대상 id>`를 선언·부여받는다(도메인 승인과 같은
접두 권한). 두 플러그인은 직접 통신하지 않고 호스트가 중계하며, 대상의 `when`·`destructive`가 그대로
걸린다. **반환값은 없다(항상 `null`)** — 명령 `run`은 반환이 없으므로 결과는 대상이 낸 효과로 본다;
`args`는 대상 `run`의 둘째 인자로 간다. 실패는 `err.code`로 분기: 대상 미실행·미등록은
`INVOKE_NO_TARGET`, 미공개는 `INVOKE_NOT_EXPOSED`, 자격 없음은 `PERMISSION_UNDECLARED`/
`PERMISSION_UNGRANTED`, 순환은 `INVOKE_CYCLE`. **실험적이라 실행 시 「최근 오류」에 경고가 남고 계약이
바뀔 수 있다.** 전 구간 예제는 `authoring.md`의 「플러그인 간 호출」 절.

**메뉴바 트레이 항목(`ui`).** `memo.ui.addTrayItem({ id, label, run })`은 노트 창이 아니라
네이티브 메뉴바(시스템 트레이) 메뉴에 항목을 등록한다(앱 전역 동작용). 클릭에 **창 컨텍스트가
없다** — `run`의 `memo`로 하는 창-스코프 호출은 마지막으로 쓴 메모 창 폴백 또는
`CONTEXT_UNAVAILABLE`이다. `run`·`label` 둘 다 필수(없으면 `INVALID_ARGS`). 갱신은 같은 `id`로
재등록(upsert)하는 것뿐 — 별도의 `updateTrayItem`은 없다. 앱 없이 그 `run`을 발화시켜 확인하려면
`npm run plugin -- test ./my-plugin --tray=<id>`(창 컨텍스트·payload 없이 역호출). 전 구간 예제는
`authoring.md`의 「메뉴바 트레이 항목」 절.

**선택 액션(`ui`).** `memo.ui.addSelectionAction({ id, label, title, match, run })`은 본문을
선택하면(마우스 드래그든 `Shift`+화살표·`Mod-A` 같은 키보드 선택이든) 뜨는 **선택 툴바 맨 끝**에
버튼을 얹고, 같은 등록이 「설정 › 단축키 › 플러그인 동작」에도 합류한다(표면 둘, 등록 하나).
`run`·`label` 둘 다 필수(없으면 `INVALID_ARGS`).
`match`(선택)는 **정규식이 아니라 닫힌 어휘**다: `charClasses`(`digit`·`operator`·`space`·
`latin`·`hangul`·`punctuation`) · `singleLine` · `maxLength`. 판정은 선택이 확정된 순간(드래그는
버튼을 놓을 때, 키보드는 손이 멈춘 뒤) **창 안에서 로컬로** 1회 — 왕복도 방송도 없다(고빈도
이벤트 금지 원칙을 깨지 않는다). 어휘 밖 값·빈 `charClasses`·0 이하 `maxLength`는 등록 시점에
거부된다. `payload.selectedText`는
`ui.addMenuItem`과 같은 `notes:read` payload 게이트를 타고, 되쓰기는 새 경로가 아니라
`memo.editor.insertText`(`notes:write`)다. 앱 없이 확인하려면
`npm run plugin -- test ./my-plugin --selection=<id> --payload='{"selectedText":"..."}'`
(하니스가 앱과 같은 `match` 판정을 태운다 — 안 맞으면 실패로 드러난다). 전 구간 예제는
`authoring.md`의 「선택 액션」 절.

## 정본 예제 — 여기서 복사하라

[`docs/plugin/examples/`](./examples/)는 실제로 설치 가능하고 가드 테스트가 매 커밋
확인하는 완본이다. **번들 플러그인(`src/plugin/builtin/plugins/*`)은 베끼지 마라** —
`.catch()`가 0개고 API가 개선되기 전 패턴이 남아 있다.

| 예제                                                             | 무엇을 보여주나                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`example-starter`](./examples/example-starter/)                 | 최소 완본 — 등록 → `runtime.ready()` → `.catch` 3단 골격                |
| [`example-toolbar-button`](./examples/example-toolbar-button/)   | 툴바 버튼 + 바인딩 `memo` + 설정 기본값 + 실패를 사용자에게 보이기      |
| [`example-window-calls`](./examples/example-window-calls/)       | 여러 창-스코프 호출을 안전하게 순차 실행(함정 #4의 정답)                |
| [`example-settings-button`](./examples/example-settings-button/) | 설정 폼 액션 버튼(`type:"button"` → `commands.register`) + 창 없는 실행 |
| [`example-note-picker`](./examples/example-note-picker/)         | `notes:all-read`(`notes.list`/`notes.read`) 정본 사용례                 |
| [`example-note-append`](./examples/example-note-append/)         | `notes.write`(append 비파괴) — 현재 노트에 이어쓰기                     |
| [`example-network-fetch`](./examples/example-network-fetch/)     | `network.fetch`(`network:<도메인>`) — 호스트가 대신 받은 응답을 삽입    |
| [`example-status-menu`](./examples/example-status-menu/)         | `ui.addStatusItem`·`ui.updateStatusItem`·`ui.addMenuItem`(ui 권한만)    |
| [`example-headless-test`](./examples/example-headless-test/)     | 버튼+설정+이벤트 구독을 앱 없이 `run`/`test`로 검증하는 법              |
| [`example-scaffold-output`](./examples/example-scaffold-output/) | `scaffold`가 그대로 낸 산출물 — `types` 동봉 워크플로 안내              |

## 하지 마라

- `err.message`(한국어 문구) 문자열 매칭 — `err.code`를 써라(함정 #6).
- 번들 플러그인을 few-shot 예제로 삼기 — 위 정본 예제만 참고하라.
- 아직 표시 화면이 없는 매니페스트 필드(`purpose`·`llmContext`·`permissionReasons`)에 기대어
  동작을 만들기 — 형식 검증만 되고 지금은 어디에도 노출되지 않는다.
- `memo.window.register`(단수, 창 컨트롤 능력 선언)와 `memo.windows.open`(복수, 예약 호출)을
  혼동하기 — 이름이 한 글자 차이지만 완전히 다른 API다.
