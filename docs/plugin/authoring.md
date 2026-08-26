# 플러그인 저작 가이드

memo의 기능은 **격리 샌드박스에서 도는 플러그인**으로 확장한다. 플러그인은 raw DOM/CSS/네트워크에 직접 닿지 못하고, 호스트가 검증하는 **구조화 API(`memo.*`)** 로만 앱을 확장한다. 권한은 매니페스트로 선언하고, 민감 권한은 사용자가 기기에서 승인해야 실제로 행사된다.

이 문서는 외부 플러그인 저작자를 위한 레퍼런스다. **AI 에이전트로 플러그인을 만든다면** 먼저
[`docs/plugin/authoring-for-ai.md`](./authoring-for-ai.md)(압축 워크플로 + 자주 틀리는 함정)를
읽어라 — 앱 없이 만들고 검사하는 폐루프를 짧게 정리한 판이다.

## 어디서 시작하나

**[`docs/plugin/examples/`](./examples/)의 정본 예제를 복사해서 시작하라.** 각 예제는 `manifest.json` + `main.js` + `README.md` 완본이고, 가드 테스트가 매니페스트 검증·권한 선언·실제 등록 동작까지 매 커밋 확인한다(썩은 예제가 남지 않는다).

| 예제                                                           | 무엇을 보여주나                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`example-starter`](./examples/example-starter/)               | 가장 작은 완본 — 인라인 패턴 하나 + `.catch` + `runtime.ready()`           |
| [`example-toolbar-button`](./examples/example-toolbar-button/) | 툴바 버튼 + 바인딩된 `memo` + 실패를 사용자에게 보이기                     |
| [`example-window-calls`](./examples/example-window-calls/)     | 여러 창-스코프 호출을 안전하게 순차 실행(왜 `Promise.all`+전역이 위험한지) |
| [`example-note-append`](./examples/example-note-append/)       | `notes.write`(append 비파괴)로 현재 노트에 이어쓰기                        |
| [`example-status-menu`](./examples/example-status-menu/)       | `ui.addStatusItem`·`ui.updateStatusItem`·`ui.addMenuItem`(ui 권한만)       |

> 위 예제는 API 하나씩만 보여주는 **최소 데모**다(+ CLI/하니스 테스트 픽스처 — `src/plugin/examples.test.ts`가 매 커밋 검증). **실제 기능이 어떻게 조합되는지 보려면 번들 플러그인(`src/plugin/builtin/plugins/*`, 19개)을 봐라** — 도그푸딩되고 테스트·드리프트 가드로 최신 유지되는 **살아있는 실사용 예**다. 이 문서 곳곳에서 해당 절마다 실례를 링크해 뒀다: 인라인 패턴 → [`wikilink`](../../src/plugin/builtin/plugins/wikilink/)·[`kbd`](../../src/plugin/builtin/plugins/kbd/), 툴바 버튼+설정 → [`template`](../../src/plugin/builtin/plugins/template/)·[`copy-ai-prompt`](../../src/plugin/builtin/plugins/copy-ai-prompt/), 창 컨트롤 → [`transparency`](../../src/plugin/builtin/plugins/transparency/), 블록 임베드 → [`youtube-embed`](../../src/plugin/builtin/plugins/youtube-embed/), 상태 아이템 → [`word-count`](../../src/plugin/builtin/plugins/word-count/).

기계가 읽을 계약 전체는 [`docs/plugin/api-reference.json`](./api-reference.json) 한 파일에 있다 — 호출별 인자·반환·권한·창 스코프·오류 코드·예시(`calls`)에 더해, 인자가 참조하는 **`Memo*` 타입 정의와 그 값 어휘**(`types`)와 **manifest.json의 JSON Schema 정본**(`manifest`)까지 통째로 들어 있다. 전부 코드에서 생성되므로 문서가 거짓말할 여지가 없다. AI 에이전트에게 이 파일을 통째로 넣어 주면 된다.

> 값 어휘를 **추측하지 마라.** 창 컨트롤 id·툴바 존·인라인 스타일 속성처럼 호스트가 화이트리스트로 거르는 값은 틀려도 오류가 나지 않고 **조용히 버려지거나 기본값으로 대체된다**(등록은 "성공"한다). `types`에 그 전수가 실려 있다.

**예제를 손으로 복사하는 대신 CLI로 뼈대를 뽑을 수도 있다** — `npm run plugin -- scaffold my-plugin --template=toolbar-button`이 같은 정신으로 쓴 템플릿에서 완본을 낸다. 전체 워크플로(scaffold → 코드 작성 → 하니스 테스트 → 개발자 모드 실앱 확인 → validate/lint → 설치)는 이 문서 끝의 "도구 — CLI 워크플로" 절에 있다.

---

## 폴더 구조

플러그인 하나는 파일 세 개짜리 폴더다:

```
my-plugin/
├── manifest.json   메타데이터 + 선언 권한 (+ 선택: 설정 스키마)
├── main.js         샌드박스에서 실행되는 코드 (memo.* 호출)
└── README.md       사용법 문서 (설정창 상세 뷰에 마크다운으로 표시)
```

`README.md`는 GitHub 스타일 마크다운을 지원한다 — 제목(h1~h6)·문단·굵게/기울임/취소선(`~~`)·인라인/블록 코드·목록·**중첩 목록**·**작업목록(`- [ ]`/`- [x]`)**·**표**·인용(`>`)·수평선(`---`)·링크·이미지. 안전을 위해: 링크는 `https://`만 앵커가 되고(그 외는 텍스트), raw HTML·`<script>`는 텍스트로 강등된다. 이미지(`![]()`)는 **플러그인 폴더 안의 로컬 파일만** 실제로 렌더한다 — 상대경로(예: `![데모](demo.png)`, `![](images/x.png)`)로 폴더 안 파일을 가리키면 보여주고, 외부 URL(`http`/`https`/`data:`)·상위 이동(`..`)·절대경로는 불러오지 않고 alt 텍스트 칩으로 대체한다(추적·CSP 차단). README와 같은 폴더에 이미지 파일을 함께 두면 된다.

**README도 로케일 변형을 둘 수 있다(축 2, 선택).** `README.<locale>.md`(BCP47 소문자 단순형 — 예: `README.en.md`, `README.pt-br.md`)를 같은 폴더에 두면, 설정 창이 사용자의 활성 로케일과 일치하는 파일을 **우선** 찾는다 — 없으면 조용히 기본 `README.md`로 폴백한다(오류가 아니다). 로케일 하나만 번역해도 되고, 전부 번역할 필요는 없다.

---

## manifest.json

```jsonc
{
  "id": "my-plugin", // 소문자·숫자·._- (첫 글자 영숫자). 전역 고유
  "name": "내 플러그인", // 표시 이름
  "version": "1.0.0",
  "entry": "main.js", // 코드 파일명(항상 main.js)
  "permissions": ["editor"], // 아래 "권한" 표 참고
  "settings": [
    // 선택 — 있으면 설정창에 ⚙ 폼 노출
    {
      "key": "greeting",
      "label": "인사말",
      "type": "text",
      "default": "안녕",
      "options": [],
    },
  ],
}
```

매니페스트는 로드 시 검증된다 — 필수 필드 누락, id 형식 오류, **알 수 없는 권한**은 거부된다. 필드 전수의 정본은 [`docs/plugin/manifest.schema.json`](./manifest.schema.json)(JSON Schema 2020-12)이다. 매니페스트 맨 위에 `"$schema"` 한 줄로 그 파일의 (도달 가능한) 경로를 가리키면 편집기가 자동완성·실시간 검증을 해 준다. **모르는 필드는 거부가 아니라 무시**한다(구버전 호스트 + 신버전 매니페스트의 전방 호환).

### 그 밖의 필드(전부 선택)

| 필드                  | 뜻                                                                                                        | 지금 하는 일                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `summary`             | 플러그인 목록의 한 줄 부제                                                                                | 목록 행 부제 + 상세 뷰 부제                       |
| `settingsCategory`    | 설정 트리에서 이 플러그인을 묶을 카테고리 이름                                                            | 트리 그룹                                         |
| `settingsDescription` | 설정 페이지 상단 소개 문구                                                                                | 설정 페이지에 표시                                |
| `kind`                | `"capability"`(테마·배경·폰트·창 컨트롤 능력을 등록) 또는 `"action"`(그 외, 기본값)                       | **능력 게이트** — `action`의 능력 등록은 거부된다 |
| `minHostVersion`      | 요구하는 최소 memo 앱 버전(semver)                                                                        | **설치 시 경고**(차단은 아님)                     |
| `purpose`             | 이 플러그인이 하는 일 한 줄(80자 이내). 자기신고라 검증이 아니다                                          | 형식 검증만(표시하는 화면이 아직 없다)            |
| `llmContext`          | 노출 능력·설정 키·예시 호출을 요약한 마크다운(2KB 이내). README와 달리 **항상 함께 설치되는** 유일한 파일 | 형식 검증만(표시·노출하는 경로가 아직 없다)       |
| `permissionReasons`   | `{ "clipboard": "복사 버튼에 씁니다" }` — 권한별 사유(값 200자 이내)                                      | 형식 검증만(승인 화면에 아직 병기되지 않는다)     |
| `nls`                 | 로케일 코드(+`"default"`) → {키→문장} — 아래 「자기 로컬라이즈」 절 참고                                  | 파싱 직후 한 번 `%키%`를 해석해 화면에 반영       |

> 「형식 검증만」은 **형식이 틀리면 설치가 거부되지만 아직 동작을 바꾸지는 않는다**는 뜻이다. 아래 세 필드가 지금 그렇다: `purpose`·`llmContext`·`permissionReasons`는 **적어도 읽는 화면이 없어 그대로 버려진다.** 지금 채워 두면 그 동작이 붙을 때 그대로 쓰이고, 사람·AI가 매니페스트만 보고 플러그인을 이해하는 데는 지금도 쓸모가 있다 — 다만 **아직 없는 동작에 기대어 코드를 짜지 마라.**

`version`은 semver(`주.부.수`)를 쓰라 — 업데이트/다운그레이드 판정이 이 형식에 의존한다.

### 플러그인 자기 로컬라이즈(`nls`) — 선택

플러그인 이름·설정 라벨처럼 **저작자가 매니페스트에 직접 쓰는** 문자열을 사용자 로케일에 맞게 바꾸고 싶다면 `nls`를 쓴다. `contributes.translations`(언어팩 — 앱 내장 UI 문자열을 **다른** 플러그인이 번역해 주는 것)와는 다른 기능이다: `nls`는 **이 플러그인 자신의** 문자열만, 이 매니페스트 안에서 끝난다.

```jsonc
// manifest.json
{
  "id": "my-plugin",
  "name": "%plugin.name%",
  "settingsDescription": "%plugin.desc%",
  "nls": {
    // "default"는 nls를 쓰면 필수 — %키%가 활성 로케일에 없을 때의 기본값이다.
    "default": { "plugin.name": "내 플러그인", "plugin.desc": "설명" },
    "en": { "plugin.name": "My Plugin", "plugin.desc": "Description" },
  },
}
```

- **대상 필드**(실제로 화면에 렌더되는 것만): `name`·`summary`·`settingsCategory`(커스텀 카테고리에만 실질 영향 — 호스트가 아는 9종 식별자는 그 자리에서 다시 자기 언어로 덮인다)·`settingsDescription`·설정 필드의 `label`·`description`·`placeholder`·`itemLabel`·`itemNamePlaceholder`·`itemBodyPlaceholder`·`confirm`·`hints[].label`·`options[]`의 **객체형**(`{value,label,description}`)만의 `label`·`description`. `purpose`·`llmContext`·`permissionReasons`는 위 표대로 아직 어느 화면에도 안 보이므로 대상이 아니다.
- **`options`의 문자열 축약형은 대상이 아니다.** `["빨강", "파랑"]`처럼 값과 라벨이 같은 축약형을 해석하면 저장된 사용자 선택값 자체가 로케일마다 달라져 깨진다 — 로케일화하려면 `{ "value": "red", "label": "%color.red%" }` 정본형을 써라(`value`는 절대 해석되지 않는다).
- **해석 규칙**: 문자열이 정확히 `%키%` 형태(시작·끝이 `%`)일 때만 대상이다. 활성 로케일 사전 → `default` 사전 → 원문(`%키%` 그대로 노출 — 누락 가시화) 순으로 찾는다. `%`로 감싸지 않은 일반 문자열, 그리고 `nls` 필드 자체가 없는 매니페스트는 100% 무변화다(하위호환).
- **해석 시점**: 설치(사이드로드) 플러그인은 목록·상세 뷰가 IPC로 매니페스트를 받아온 직후 한 번 해석한다(`resolveInstalledPluginNls`). 번들(내장) 플러그인도 같은 규칙으로 해석되지만 소비 지점이 다르다 — `settings/settings.ts`의 번들 목록·설정 페이지가 호출 시점의 활성 로케일로 해석한다(`resolveBuiltinPluginNls`/`resolveBuiltinThemeNls`, `src/plugin/builtin/index.ts`). `README.<locale>.md`도 번들에서 동작한다(`import.meta.glob`이 변형까지 모은다).
- 지금 로케일을 코드에서 알고 싶으면(예: `%키%`로 표현하기 어려운 조건 분기) `memo.i18n.locale()`을 써라(권한 불필요) — 아래 호출 표 참고.

### 지원 OS(`platforms`) — 선택

플러그인이 특정 OS에서만 동작한다면 `"platforms": ["macos"]`처럼 지원 OS를 선언한다(값: `macos`·`windows`·`linux`). **없으면 전 플랫폼 지원**으로 간주한다. 현재 OS가 목록에 없으면 그 플러그인은 **자동 비활성화**된다 — 중앙 호스트가 실행하지 않고(스냅샷에서 제외), 설정 목록에는 "🍎 macOS 전용 · 이 기기에서 사용 불가" 배지와 함께 토글이 잠긴 채로 보인다(저장된 활성 상태는 보존 — 지원 OS로 옮기면 복원). 예: 창 투명도·모든 데스크탑 표시처럼 macOS `NSWindow`에 의존하는 기능.

### 설정 필드(`settings[]`)

| 필드          | 설명                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `key`         | 값 저장 키(`memo.settings.get(key)`로 읽음)                                                          |
| `label`       | UI 라벨                                                                                              |
| `type`        | `"text"` · `"textarea"` · `"toggle"` · `"select"` · `"list"` · `"number"` · `"button"`(아래 표 참고) |
| `default`     | 기본값(text/textarea/list→문자열, toggle→불리언, number→수, select→`options`의 `value`)              |
| `options`     | select 선택지(그 외 타입은 `[]`) — `string[]` 또는 `{ value, label?, description? }[]`               |
| `description` | 입력 아래 도움말(선택)                                                                               |

타입별 부가 필드(그 타입에서만 의미 있음 — 다른 타입에 줘도 무시된다):

| 필드                  | 쓰이는 타입   | 설명                                                                                                              |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `placeholder`         | text·textarea | 입력 placeholder(선택)                                                                                            |
| `itemLabel`           | list          | 항목 하나의 단수 명칭 — "＋ {itemLabel} 추가" 버튼·빈 상태 문구에 씀(선택, 기본 "항목")                           |
| `itemNamePlaceholder` | list          | 항목 이름 입력의 placeholder(선택)                                                                                |
| `itemBodyPlaceholder` | list          | 항목 본문 textarea의 placeholder(선택)                                                                            |
| `hints`               | list          | `{ token, label? }[]` — 본문에 삽입 가능한 키워드 칩(클릭 시 커서 위치에 `token` 삽입, 선택)                      |
| `min` `max` `step`    | number        | 하한·상한·증감 폭(선택). 값은 `min`/`max`로 클램프되고, `default`가 없으면 `min`이 기본값이다                     |
| `command`             | button        | **필수** — 누르면 실행할 명령 id(`memo.commands.register({ id })`가 등록한 것). 없거나 비면 매니페스트가 거부된다 |
| `confirm`             | button        | 실행 전에 설정 창이 띄울 확인 문구(선택). 되돌릴 수 없는 동작에 쓴다                                              |

> **치환 미리보기(선언 불필요).** `text`·`textarea` 값에 `{path}`·`{content}`가 들어 있으면 설정
> 폼이 입력 바로 아래에 **임시 값으로 치환한 줄**을 타이핑마다 그려 준다(`{path} 입니다.` →
> `미리보기: /Users/me/Memo/notes/메모.md 입니다.`). 이 두 토큰은 플러그인이 발명한 말이 아니라
> 앱의 개념(노트 경로·본문)이라 호스트가 뜻을 알고 있고, 그래서 매니페스트에 아무것도 적지
> 않아도 된다. **모르는 토큰은 건드리지 않는다** — 아는 토큰이 하나도 없으면 미리보기 줄 자체가
> 뜨지 않으므로, `{foo}`를 다른 뜻으로 쓰는 필드가 지어낸 값을 보여 줄 일은 없다. 값은 진짜
> 노트가 아니라 예시다(설정 창에는 노트가 없다) — 확인하려는 것이 "변수를 맞게 썼는가, 줄바꿈이
> 어떻게 되는가"라 예시로 충분하다.

`button`은 **값이 없는 유일한 필드 타입**이다. 설정 폼에 버튼 하나를 놓고, 누르면 `command`가
가리키는 명령이 돈다 — 버튼 전용 콜백 API는 없다. 설정 버튼과 단축키가 같은 명령을 실행하므로
핸들러·권한 게이트·진단이 한 벌이고, `memo.settings.get`으로 읽을 값도 없다(상태 파일에 그 키가
생기지 않는다).

```jsonc
// manifest.json — settings[]
{
  "key": "clearCache",
  "type": "button",
  "label": "캐시 지우기",
  "command": "clear-cache",
  "confirm": "정말 지울까요?",
}
```

```js
// main.js
memo.commands.register({ id: "clear-cache", title: "캐시 지우기", run: function (memo) { … } });
```

> **설정 창에는 메모가 없다.** 이 경로로 실행된 명령에는 창 컨텍스트가 없어서 창-스코프
> 호출(`ui.toast`·`notes.current`·`editor.*`·`clipboard.*`)은 폴백 계약을 탄다 — 마지막으로 쓴
> 메모 창이 있으면 거기로 가고, 없으면 오류가 아니라 `null`이다. 그 폴백에도 유휴 만료가
> 있다(아래 「창 컨텍스트」 절): 마지막 활동 후 5분이 지났으면 **민감 권한 호출**은
> `CONTEXT_UNAVAILABLE`로 거부된다("고치고 바로 눌러 본다"는 흐름은 그 안에 든다). 그래서
> 설정 버튼에는 **창이 필요 없는 동작**(캐시 비우기·값 다시 계산·외부 상태 초기화)이 가장 잘
> 맞는다.
>
> **결과는 `memo.runtime.log`로 알려라 — 그것이 설정 버튼의 사용자 피드백 채널이다.** 설정 창은
> 클릭 직후 그 플러그인이 남긴 진단을 최대 2초까지 지켜보다가, 도착하면 **버튼 아래 상태 줄**에
> 그 문장을 그대로 그린다(아무것도 안 남기면 "결과를 남기지 않았다"로 끝난다). 토스트는 이
> 경로에서 누른 사람에게 닿지 못한다 — 폴백 메모 창이 있으면 **그쪽에** 뜨고 없으면 아무 데도
> 안 뜬다. 그러니 이 줄은 저작자용 메모가 아니라 **사람이 읽을 한 문장**으로 적고(성공이면
> 무엇을 했는지, 실패면 무엇을 하면 되는지), 로케일이 있으면 번역 대상에 넣어라. 노트 본문처럼
> 큰 값은 그대로 싣지 말고 길이·요약으로 줄여라(진단 채널은 본문이 흘러드는 자리가 아니다).
>
> `when`의 정적 키(`platform.*`·`plugin.<id>.enabled`·`settings.<key>`)는 설정 버튼에서도
> **그대로 판정된다** — 보류되는 것은 메모 창의 상태를 봐야 하는 `note.isEmpty`뿐이다.
> `note.isEmpty`가 하나라도 있거나 `destructive: true`면(확인 팝업을 띄울 메모 창이 없다)
> 설정 버튼으로는 실행되지 않고 이유가 진단에 남는다 — 확인이 필요하면 필드의 `confirm`을
> 쓰고, 설정 버튼용 명령에는 `note.isEmpty`를 걸지 마라.
> 정본 예제: [`example-settings-button`](./examples/example-settings-button/).

`list`는 여러 "항목(이름+본문)"을 사용자가 카드 UI로 추가·편집·삭제하게 한다(설정 창이 그려주는
전용 편집기). 플러그인이 받는 값은 **`{ name, body }[]` 배열**이다 — 직렬화 포맷은 호스트가
소유하고 경계에서 파싱해 준다. 쓸 때도 같은 배열을 그대로 넘기면 되고(`memo.settings.set({ key,
value: [{ name, body }] })`), 이름에 `=`가 섞여도 호스트가 정리하므로 플러그인이 헤더 문법 충돌을
방어할 이유가 없다. 번들 [`template`](../../src/plugin/builtin/plugins/template/main.js)이 실례다.

> 디스크에는 여전히 `=== 이름 ===\n본문`을 빈 줄로 이어 붙인 블롭 하나로 저장된다(그래서
> `default`는 그 블롭 형식의 문자열로 적는다) — 다만 그 직렬화는 호스트만의 것이고, 플러그인은
> 언제나 구조화된 `{ name, body }[]`만 본다.
>
> **인자는 객체 하나뿐이다(엄격).** `memo.settings.get({ key: "..." })`만 유효하다. 문자열
> 축약형 `settings.get("key")`은 `INVALID_ARGS`로 거부되고, 저장 블롭을 그대로 받던
> `{ key, raw: true }` 탈출구도 사라졌다(`raw`는 무시되고 언제나 구조화 배열이 온다). 자기
> 파서가 있던 플러그인도 이제 호스트가 파싱해 주는 `{ name, body }[]`를 받는다.

`select`의 저장 값은 **언제나 `options`의 `value`**이고 사용자에게 보이는 것은 `label`이다.
`"options": ["A", "B"]` 축약형은 `{ value: "A", label: "A" }`의 줄임으로 해석되므로 기존
매니페스트는 그대로 유효하다. 라벨과 값을 나누면(예 `{ value: "cursor", label: "커서 위치" }`)
표시 문구를 나중에 다듬어도 저장된 값이 고아가 되지 않는다. 저장된 값이 옵션 목록 밖이어도
호스트는 버리지 않고 그대로 유지한다(개발 중 스키마가 잠시 어긋나도 사용자 선택이 초기화되지
않게 — 데이터 보호). 라벨→값 자동 마이그레이션은 없다(출시 전 엄격화에서 제거 — 저장값이 곧
라벨이던 옛 데이터가 존재하지 않는다).

**기본값은 매니페스트가 정본이다.** 저장된 값이 없으면 호스트가 `default`를 병합해 주므로
`main.js`에 기본값을 다시 적지 말 것. 여러 키를 한 번에 읽으려면 `memo.settings.getAll()`이
선언된 모든 키가 채워진 스냅샷 하나를 돌려준다.

설정 값은 **기기 로컬**에 영속화된다. 값이 바뀌면 호스트가 플러그인을 재빌드하고 노트 창이 갱신된다.

설정 UI는 설정 창 **좌측 트리**에 이 플러그인의 페이지로 뜬다(상세 뷰엔 "설정 열기" 링크만). 매니페스트에
`"settingsCategory": "도구"`처럼 카테고리를 선언하면 트리에서 그 이름으로 자동 그룹된다(없으면 "플러그인"
그룹). 플러그인은 DOM에 못 닿고 스키마/카테고리만 선언하며, 호스트가 트리와 폼을 대신 그린다.

---

## 권한

권한은 **저위험**(선언만으로 허용)과 **민감**(선언 + 사용자 승인 필요)으로 나뉜다. 매니페스트에 선언하지 않은 권한의 호출은 게이트키퍼가 차단한다.

아래 표는 코드에서 생성된다(`src/plugin/permissions.ts`의 권한 어휘 + `src/settings/install-flow.ts`의 승인 화면 문구 + `src/plugin/host.ts`의 호출 매핑) — 문서만 낡는 일이 구조적으로 없다.

<!-- BEGIN GENERATED: permissions -->

| 권한               | 등급   | 무엇을 여는가                                                                                                    | 게이트하는 호출                                                                                                                                                               |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`         | 저위험 | 앱 명령을 추가할 수 있어요                                                                                       | `commands.register`                                                                                                                                                           |
| `ui`               | 저위험 | 화면에 UI 요소를 추가할 수 있어요                                                                                | `ui.addToolbarButton` · `ui.addStatusItem` · `ui.updateStatusItem` · `ui.toast` · `ui.pickList` · `ui.prompt` · `ui.addMenuItem` · `ui.addSelectionAction` · `ui.addTrayItem` |
| `editor`           | 저위험 | 에디터 동작(패턴·자동완성)을 확장해요                                                                            | `editor.registerInlinePattern` · `editor.registerCompletion` · `editor.registerBlockEmbed` · `editor.getFontDelta` · `editor.setFontDelta` · `editor.registerWidget`†         |
| `settings`         | 저위험 | 플러그인 설정 항목을 추가할 수 있어요                                                                            | `settings.get` · `settings.getAll` · `settings.set` · `events.on`                                                                                                             |
| `storage`          | 저위험 | 이 플러그인 자신의 데이터를 기기에 저장할 수 있어요(노트는 읽지 못해요)                                          | `storage.get` · `storage.set` · `storage.remove` · `storage.getAll`                                                                                                           |
| `theme`            | 저위험 | 테마 색을 정할 수 있어요                                                                                         | `theme.register`                                                                                                                                                              |
| `background`       | 저위험 | 노트 배경색을 제공해요                                                                                           | `background.register`                                                                                                                                                         |
| `font`             | 저위험 | 글꼴 후보를 제공해요                                                                                             | `font.register`                                                                                                                                                               |
| `window-control`   | 저위험 | 투명도·항상 위 같은 노트 창 옵션을 제공해요                                                                      | `window.register`                                                                                                                                                             |
| `i18n`             | 저위험 | 다른 언어의 화면 문구를 제공해요                                                                                 | —                                                                                                                                                                             |
| `notes:read`       | 민감   | 지금 열려 있는 메모의 내용과 전체 노트 제목 목록을 읽을 수 있어요                                                | `notes.current`                                                                                                                                                               |
| `notes:all-read`   | 민감   | 숨긴 메모를 포함한 모든 메모의 제목과 내용을 읽을 수 있어요                                                      | `notes.list` · `notes.read`                                                                                                                                                   |
| `notes:write`      | 민감   | 지금 열려 있지 않은 메모를 포함해 노트 내용을 덮어쓸 수 있어요(덮어쓴 내용은 「메모 복구」에서 되돌릴 수 있어요) | `editor.insertText` · `notes.duplicate` · `notes.resetOptions` · `notes.write`                                                                                                |
| `vault:read`       | 민감   | 저장 폴더의 파일을 읽을 수 있어요 **(예약)**                                                                     | `vault.read`†                                                                                                                                                                 |
| `vault:write`      | 민감   | 저장 폴더에 파일을 쓸 수 있어요 **(예약)**                                                                       | `vault.write`†                                                                                                                                                                |
| `clipboard`        | 민감   | 클립보드에 쓸 수 있어요                                                                                          | `clipboard.write` · `clipboard.read`†                                                                                                                                         |
| `windows`          | 민감   | 위키링크를 눌렀을 때 그 노트 창을 열 수 있어요                                                                   | `windows.open`†                                                                                                                                                               |
| `browser:open`     | 민감   | 링크를 시스템 기본 브라우저로 열 수 있어요                                                                       | `browser.open`                                                                                                                                                                |
| `embed:<도메인>`   | 민감   | 그 도메인의 블록 임베드만 렌더 허용(호출이 아니라 렌더 시점 게이트)                                              | —                                                                                                                                                                             |
| `network:<도메인>` | 민감   | 그 호스트로만 `network.fetch` 허용(호스트가 대신 요청 — URL 호스트마다 선언·부여)                                | `network.fetch`                                                                                                                                                               |
| `invoke:<대상 id>` | 민감   | 그 플러그인이 공개한(exposes) 명령만 `commands.invoke`로 실행 허용(대상마다 선언·부여)                           | `commands.invoke`                                                                                                                                                             |

† 아직 실행 경로가 없는 예약 호출. **(예약)** 권한은 그 권한의 호출이 전부 예약이라 승인해도 지금은 아무 효과가 없다.

<!-- END GENERATED: permissions -->

> **(예약)** 은 권한 모델은 인식하지만 아직 브리지 호출이 배선되지 않은 것 — 지금 선언해도 대응 호출은 동작하지 않는다. 예약 권한은 승인 시점에 "선언됐지만 부여 보류"로 기록되지만, **살아나는 순간 자동으로 부여되지는 않는다**(사용자가 다시 승인해야 한다). 그러니 지금 쓰지 않을 권한은 선언하지 마라 — 승인 화면만 무겁게 만든다.

민감 권한은 설치·업데이트 시 승인 프롬프트로 노출되고, 사용자가 끈 권한은 존중된다. **최종 강제는 항상 호스트**(선언 ∩ 부여)가 한다. 사용자가 어떤 권한을 껐는지는 `memo.runtime.info().granted`로 확인할 수 있다 — 조용히 반쯤 죽는 대신 축소 동작하라.

---

## 호출 표 (전수)

`memo.*` 호출 전수와 각각의 권한·스코프·반환·상태다. **스코프 「창」** 은 그 호출을 낳은 클릭의 노트 창으로 위임된다는 뜻이고(아래 "창 컨텍스트" 절), **상태 「예약」** 은 이름과 권한만 있고 실행 경로가 없다는 뜻이다(호출하면 `RESERVED_CALL`로 거부된다).

<!-- BEGIN GENERATED: calls -->

| 호출                                | 권한                | 스코프 | 반환                                                            | 상태         |
| ----------------------------------- | ------------------- | ------ | --------------------------------------------------------------- | ------------ |
| `memo.editor.registerInlinePattern` | `editor`            | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.editor.registerCompletion`    | `editor`            | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.editor.registerBlockEmbed`    | `editor`            | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.editor.getFontDelta`          | `editor`            | 창     | `number \| null`                                                | 동작         |
| `memo.editor.setFontDelta`          | `editor`            | 창     | `number \| null`                                                | 동작         |
| `memo.editor.insertText`            | `notes:write`       | 창     | `null`                                                          | 동작         |
| `memo.editor.registerWidget`        | `editor`            | 전역   | —                                                               | 예약(미구현) |
| `memo.ui.addToolbarButton`          | `ui`                | 전역   | `null`                                                          | 동작         |
| `memo.ui.addStatusItem`             | `ui`                | 전역   | `null`                                                          | 동작         |
| `memo.ui.updateStatusItem`          | `ui`                | 창     | `MemoStatusItem \| null`                                        | 동작         |
| `memo.ui.toast`                     | `ui`                | 창     | `MemoToast \| null`                                             | 동작         |
| `memo.ui.pickList`                  | `ui`                | 창     | `string \| MemoPickResult \| null`                              | 동작         |
| `memo.ui.prompt`                    | `ui`                | 창     | `string \| Record<string, string \| number \| boolean> \| null` | 동작         |
| `memo.ui.addMenuItem`               | `ui`                | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.ui.addSelectionAction`        | `ui`                | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.ui.addTrayItem`               | `ui`                | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.settings.get`                 | `settings`          | 전역   | `unknown`                                                       | 동작         |
| `memo.settings.getAll`              | `settings`          | 전역   | `Record<string, unknown>`                                       | 동작         |
| `memo.settings.set`                 | `settings`          | 전역   | `null`                                                          | 동작         |
| `memo.events.on`                    | `settings`          | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.commands.register`            | `commands`          | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.commands.invoke`              | `invoke:<pluginId>` | 전역   | `null`                                                          | 동작(실험적) |
| `memo.storage.get`                  | `storage`           | 전역   | `unknown`                                                       | 동작         |
| `memo.storage.set`                  | `storage`           | 전역   | `null`                                                          | 동작         |
| `memo.storage.remove`               | `storage`           | 전역   | `null`                                                          | 동작         |
| `memo.storage.getAll`               | `storage`           | 전역   | `Record<string, unknown>`                                       | 동작         |
| `memo.notes.current`                | `notes:read`        | 창     | `MemoCurrentNote \| null`                                       | 동작         |
| `memo.notes.duplicate`              | `notes:write`       | 창     | `null`                                                          | 동작         |
| `memo.notes.resetOptions`           | `notes:write`       | 창     | `null`                                                          | 동작         |
| `memo.notes.list`                   | `notes:all-read`    | 전역   | `MemoNoteSummary[]`                                             | 동작         |
| `memo.notes.read`                   | `notes:all-read`    | 전역   | `MemoNoteContent`                                               | 동작         |
| `memo.notes.write`                  | `notes:write`       | 전역   | `null`                                                          | 동작         |
| `memo.clipboard.write`              | `clipboard`         | 창     | `null`                                                          | 동작         |
| `memo.clipboard.read`               | `clipboard`         | 전역   | —                                                               | 예약(미구현) |
| `memo.theme.register`               | `theme`             | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.background.register`          | `background`        | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.font.register`                | `font`              | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.window.register`              | `window-control`    | 전역   | `MemoRegistration`                                              | 동작         |
| `memo.i18n.locale`                  | —(무권한)           | 전역   | `string`                                                        | 동작         |
| `memo.runtime.ready`                | —(무권한)           | 전역   | `null`                                                          | 동작         |
| `memo.runtime.onDispose`            | —(무권한)           | 전역   | `null`                                                          | 동작         |
| `memo.runtime.info`                 | —(무권한)           | 전역   | `MemoRuntimeInfo`                                               | 동작         |
| `memo.runtime.log`                  | —(무권한)           | 전역   | `null`                                                          | 동작         |
| `memo.network.fetch`                | `network:<도메인>`  | 전역   | `MemoNetworkResponse`                                           | 동작         |
| `memo.vault.read`                   | `vault:read`        | 전역   | —                                                               | 예약(미구현) |
| `memo.vault.write`                  | `vault:write`       | 전역   | —                                                               | 예약(미구현) |
| `memo.browser.open`                 | `browser:open`      | 전역   | `null`                                                          | 동작         |
| `memo.windows.open`                 | `windows`           | 전역   | —                                                               | 예약(미구현) |

<!-- END GENERATED: calls -->

---

## main.js — `memo.*` API

`main.js`는 격리 iframe에서 로드되어 최상위에서 동기로 실행된다. 등록 호출(패턴·버튼 등)은 이때 이뤄지고, 이벤트 핸들러(`onClick`)는 나중에 호출된다. `memo.*`는 전부 비동기(Promise 반환)다.

각 호출은 대응 권한이 **선언(+ 민감이면 부여)** 돼 있어야 통과한다.

### 인자는 언제나 객체 하나

```js
memo.settings.set({ key: "greeting", value: "안녕" }); // ✅ 정본
memo.settings.set("greeting", "안녕"); // ❌ 동기 TypeError로 즉시 죽는다
```

모든 호출은 `memo.<ns>.<method>(객체 1개)` 형태다. 인자를 2개 이상 주거나 객체가 아닌 값을 주면 **동기 `TypeError`** 가 난다. 예전에는 두 번째 인자가 조용히 버려져 `String(undefined)` 키로 저장을 시도했다 — 지금은 즉시 발견된다. 원시값을 받는 예외는 `memo.runtime.log("메시지")` 하나뿐이다 — 로그는 문자열로 부르는 것이 자연스럽고 진단 채널이 저작자의 유일한 피드백 루프라, 던져서 메시지를 버리는 대신 `{ message: "메시지" }`로 정규화한다. `memo.settings.get`은 예외가 아니다 — 문자열 축약형은 `INVALID_ARGS`로 거부되고 `{ key: "..." }`만 받는다.

### 등록 마감 — `memo.runtime.ready()`

등록은 **`memo.runtime.ready()`를 부른 시점**, 또는 부트스트랩의 조용-대기 폴백(미해결 브리지 호출이 0이 되고 한 틱 더 지나면 마감, 절대 상한 3초) 중 **먼저 오는 쪽**에 닫힌다. 폴백은 계약이 아니라 편의다 — 비동기 초기화가 있으면 명시하라.

```js
memo.settings
  .getAll()
  .then(function (cfg) {
    memo.editor.registerInlinePattern({
      id: "hl",
      open: cfg.mark,
      close: cfg.mark,
    });
    return memo.runtime.ready(); // 여기서 등록이 확정된다
  })
  .catch(function (e) {
    memo.runtime.log({ message: "부팅 실패: " + e.code });
  });
```

`memo.runtime.*`은 **권한이 필요 없다**(어떤 특권도 행사하지 않는다). `memo.runtime.info()`는 실행 환경 스냅샷 — `pluginId`·`hostVersion`·`os`·`reason`과 **자기 자신의** `declared`/`granted` 권한 — 을 돌려준다. 사용자가 민감 권한을 껐는지 확인하고 조용히 반쯤 죽는 대신 명시적으로 축소 동작하는 데 쓴다.

- `hostVersion`은 앱 버전이고, **읽지 못하면 빈 문자열**이다 — 빈 문자열을 "구버전"으로 해석하지 마라(진단·경고용이지 기능 분기용이 아니다).
- `reason`은 **`"reload"` 하나뿐이다.** 설치·갱신도 호스트에는 재빌드 신호 하나로 도착해 셋을 구분할 근거가 없다 — 그래서 관측되지 않는 값을 계약에 넣지 않았다(`api-reference.d.ts`의 유니온도 `"reload"` 하나다). 이 필드로 분기하지 마라.

### 실패는 조용하다 — `.catch`를 걸어라

`window.memo`는 이중 `Proxy`라 `memo.아무거나.아무거나(...)`가 전부 함수를 반환한다 — 존재하지 않는 호출(`memo.notes.currnet()` 같은 오타)도 문법적으로는 그냥 호출되고, 브리지가 거부하면 **reject되는 Promise**가 될 뿐이다. 플러그인은 불투명 origin iframe에서 도는 blob 스크립트라 devtools도 붙일 수 없다.

reject된 `Error`에는 **기계용 안정 코드**가 실려 있다. 한국어 문구(`err.message`)를 매칭하지 마라 — 문구는 다듬어지지만 코드는 안 바뀐다.

```js
memo.clipboard.write({ text: "안녕" }).catch(function (e) {
  // e.code: 안정 코드 · e.call: 호출명("clipboard.write") · e.message: 사람용 문구
  if (e.code === "PERMISSION_UNGRANTED") {
    memo.ui.toast({ title: "설정에서 클립보드 권한을 켜 주세요" });
  }
  memo.runtime.log({ message: e.call + " → " + e.code });
});
```

<!-- BEGIN GENERATED: errors -->

| `err.code`                  | 뜻                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_CALL`              | 그런 이름의 호출이 없다(오타이거나 존재하지 않는 API). 유효한 이름은 호출 표(=`api-reference.json`의 `calls`)에 있는 것뿐이다.                                                                                                                                                                                                                                                                                                                        |
| `RESERVED_CALL`             | 이름은 있지만 아직 실행 경로가 없다(예약). 권한을 선언하고 승인까지 받아도 거부된다.                                                                                                                                                                                                                                                                                                                                                                  |
| `WRONG_PLUGIN_KIND`         | 능력 등록(theme·background·font·window.register)을 `kind: "capability"`가 아닌 플러그인이 호출했다. 능력을 등록하려면 매니페스트에 `kind: "capability"`를 명시적으로 선언한다 — `kind: "action"`이거나 kind를 아예 안 적으면 권한(`theme` 등)을 채워도 통과하지 않는다.                                                                                                                                                                               |
| `PERMISSION_UNKNOWN`        | 호출이 요구하는 권한 이름을 호스트가 모른다(매핑표 자체의 오류 — 저작자 쪽 원인이 아니다).                                                                                                                                                                                                                                                                                                                                                            |
| `PERMISSION_UNDECLARED`     | manifest.json의 permissions에 그 권한을 적지 않았다. 호출 표의 「권한」 열(=`calls[].permission`)을 보고 채운다.                                                                                                                                                                                                                                                                                                                                      |
| `PERMISSION_UNGRANTED`      | 선언은 했지만 사용자가 승인하지 않았다(민감 권한). 축소 동작으로 폴백하고, 사용자에게 승인을 안내한다.                                                                                                                                                                                                                                                                                                                                                |
| `CONTEXT_UNAVAILABLE`       | 창-스코프 호출인데 대상 창 컨텍스트가 없고 인자에 `requireWindow: true`를 준 경우(옵트인 — 안 주면 오류 없이 null로 끝난다), **또는 민감 권한 호출의 창 컨텍스트가 유휴 만료됐다**(마지막 활동 후 5분 초과 — 이쪽은 옵트인과 무관하게 항상 난다. 바인딩된 memo의 토큰이든, 토큰 없는 호출이 타는 「마지막 클릭 창」 폴백이든 같은 규칙이다). 어느 쪽이든 호스트 진단에 남고, 교정은 같다: 새 클릭·이벤트 핸들러가 받은 바인딩된 memo로 다시 호출하라. |
| `NOTE_NOT_FOUND`            | `notes.read`에 준 id의 노트가 존재하지 않는다. id는 `notes.list`가 돌려준 값만 유효하다(노트가 그 사이 지워졌을 수도 있다 — 목록을 다시 읽어라).                                                                                                                                                                                                                                                                                                      |
| `INVALID_ARGS`              | 인자의 구조가 잘못됐다(예: editor.registerBlockEmbed의 sources/embedTemplate 검증 실패).                                                                                                                                                                                                                                                                                                                                                              |
| `QUOTA_EXCEEDED`            | `storage.set`이 그 서랍의 용량 상한(스코프 불문 256KB)을 넘겼다. 값은 저장되지 않았다(조용한 잘림이 아니다) — 오래된 키를 지우고 다시 시도하는 자리다.                                                                                                                                                                                                                                                                                                |
| `NETWORK_SCHEME`            | `network.fetch`의 url이 https가 아니다(http·file 등). https URL만 허용된다.                                                                                                                                                                                                                                                                                                                                                                           |
| `NETWORK_INVALID_URL`       | `network.fetch`의 url을 URL로 해석할 수 없다(형식 오류·호스트 없음).                                                                                                                                                                                                                                                                                                                                                                                  |
| `NETWORK_BLOCKED`           | 대상이 사설/내부/링크로컬 또는 클라우드 메타데이터 대역으로 해석됐다 — SSRF 방어로 차단된다(공개 인터넷 주소만 허용).                                                                                                                                                                                                                                                                                                                                 |
| `NETWORK_DNS`               | `network.fetch`의 호스트를 어떤 IP로도 해석하지 못했다(DNS 실패).                                                                                                                                                                                                                                                                                                                                                                                     |
| `NETWORK_METHOD`            | 허용 목록 밖 HTTP 메서드다 — GET·POST·PUT·PATCH·DELETE·HEAD만 쓸 수 있다.                                                                                                                                                                                                                                                                                                                                                                             |
| `NETWORK_TOO_LARGE`         | 응답이 크기 상한(5MiB)을 넘겼다. 본문은 돌려주지 않는다(부분 반환이 아니다).                                                                                                                                                                                                                                                                                                                                                                          |
| `NETWORK_TIMEOUT`           | 연결/전송이 시간 안에 끝나지 않았다(요청 30초·연결 10초 상한).                                                                                                                                                                                                                                                                                                                                                                                        |
| `NETWORK_FAILED`            | 그 외 전송 실패(연결 거부·TLS 오류 등). 사설대역·타임아웃·크기와 구분되는 나머지 전송 오류다.                                                                                                                                                                                                                                                                                                                                                         |
| `NETWORK_TOO_MANY_REQUESTS` | 동시 network.fetch 호출이 상한을 초과했다(플러그인당·전역). 큐잉하지 않고 즉시 거부하니, 진행 중 요청이 끝난 뒤 다시 호출한다.                                                                                                                                                                                                                                                                                                                        |
| `INVOKE_NO_TARGET`          | `commands.invoke`의 대상 플러그인이 지금 실행 중이 아니거나(꺼짐·미설치), 대상이 공개는 했지만 그 명령을 `commands.register`로 등록하지 않았다. 대상이 켜져 있는지·그 id를 실제로 등록하는지 확인하라.                                                                                                                                                                                                                                                |
| `INVOKE_NOT_EXPOSED`        | `commands.invoke`의 대상 플러그인이 그 commandId를 매니페스트 `exposes`로 **공개하지 않았다**(기본 비공개). 호출측이 `invoke:<대상>` 권한을 가졌어도, 대상이 명시적으로 열지 않은 명령은 부를 수 없다.                                                                                                                                                                                                                                                |
| `INVOKE_CYCLE`              | `commands.invoke`가 릴레이 깊이 상한을 넘었다(A→B→A… 순환·폭주 방어). 대상 명령이 다시 호출측을 부르는 구조가 아닌지 확인하라 — 깊이 추적은 핸들러가 받은 바인딩된 memo를 따라간다.                                                                                                                                                                                                                                                                   |
| `UNKNOWN`                   | 위 어디에도 분류되지 않은 실행부 예외. 부트스트랩이 code 없는 거부를 이 값으로 채우므로 err.code는 언제나 문자열이다.                                                                                                                                                                                                                                                                                                                                 |

<!-- END GENERATED: errors -->

호스트는 **플러그인이 `.catch`를 걸었든 아니든** 모든 브리지 거부를 플러그인별로 기록한다. 「설정 › 플러그인 › (해당 플러그인) › 최근 오류」에서 볼 수 있고, `memo.runtime.log({ message })`로 남긴 줄도 같은 자리에 모인다. 인자는 절대 기록되지 않으므로(노트 본문 유출 차단) 필요한 값은 메시지에 직접 넣어라.

**브리지 밖에서 난 실패도 같은 자리에 모인다.** 콜백(툴바 버튼 `onClick` 등) 안에서 던진 예외는 「핸들러 예외」로, 아무도 `.catch`를 걸지 않은 프라미스 거부는 「처리되지 않은 거부」로 기록된다. 플러그인은 불투명 origin iframe에서 돌아 devtools를 붙일 수 없으므로, **버튼을 눌러도 아무 일이 일어나지 않을 때 가장 먼저 볼 곳이 여기다**.

> **타입 선언**: 이 저장소에 [`api-reference.d.ts`](./api-reference.d.ts)를 뒀다 — 실제로 배선된
> `memo.*` 호출만 담은 앰비언트 타입 선언이다(예약 호출은 일부러 뺐다 — 넣으면 동작하는
> API처럼 자동완성된다). 플러그인 폴더에 복사해 `main.js` 맨 위에
> `/// <reference path="./plugin-api.d.ts" />` 한 줄을 추가하면(VS Code 등 TS 언어 서버가
> 붙는 편집기에서) `memo.*` 자동완성·오타 검출을 받는다. `main.js`를 그대로 실행하는 데는
> 영향이 없다 — 참조 주석은 타입 전용이라 런타임에서 무시된다. 이 파일과 `api-reference.json`은
> 둘 다 코드에서 생성되므로 구현과 어긋날 수 없다.

### editor (`editor`)

```js
// 인라인 패턴 — open/close 구분자 사이 텍스트를 스타일링(+ 선택적 클릭 동작)
memo.editor.registerInlinePattern({
  id: "hl",
  open: "==",
  close: "==",
  style: { backgroundColor: "rgba(250,204,21,0.35)", borderRadius: "2px" },
  styleHover: {/* :hover 상태(선택) */},
});

// 세 토막 패턴 — `mid`를 주면 캡처가 둘 생긴다. 보여 줄 토막은 `label`,
// 클릭 대상은 `target`이 고른다(`{{구글|https://google.com}}` → "구글"만 보이고 URL이 열린다)
memo.editor.registerInlinePattern({
  id: "link",
  open: "{{",
  mid: "|",
  close: "}}",
  label: "first",
  target: "second",
  action: "open-url", // browser:open 필요
  style: { color: "accent", textDecoration: "underline", cursor: "pointer" },
});

// 자동완성 — trigger 입력 시 노트 제목 제안, 고르면 wrap의 %가 (전부) 제목으로 치환.
// trigger는 임의 문자열이다("[["·"@"·"#" …). 호스트가 정규식을 만들지 않고 리터럴로 매칭한다.
memo.editor.registerCompletion({ id: "wiki", trigger: "[[", wrap: "[[%]]" }); // + notes:read

// 블록 임베드 — 코드펜스 안 URL을 위젯으로(구조·도메인 검증은 호스트가 수행)
memo.editor.registerBlockEmbed({
  id: "yt",
  fence: "youtube",
  sources: [{ host: "www.youtube.com", queryParam: "v" }],
  embedTemplate: "https://www.youtube-nocookie.com/embed/{id}",
}); // + embed:www.youtube-nocookie.com

// 메모별 글자 델타(%) 읽기/쓰기 — 실효 크기(전역+델타)는 호스트가 적용·영속화.
// 창-스코프라 컨텍스트가 없으면 null이 온다(아래 "창 컨텍스트" 절).
const cur = await memo.editor.getFontDelta();
if (cur !== null) await memo.editor.setFontDelta({ value: cur + 10 });

// 커서 위치(또는 문서 끝/전체)에 텍스트 삽입 — 템플릿 등. mode=cursor|append|replace,
// caret=삽입된 본문 내 최종 커서 오프셋(선택). 본문을 쓰므로 notes:write 게이트.
await memo.editor.insertText({ text: "삽입할 내용", mode: "cursor", caret: 3 }); // + notes:write
```

인라인 패턴에 **`notes:read` + `windows`** 를 함께 선언하면, 그 패턴을 클릭했을 때 안쪽 텍스트를 제목으로 하는 노트가 열린다(위키링크 동작). 별도 호출 없이 호스트가 배선한다. 이 동작이 곧 번들 [`wikilink`](../../src/plugin/builtin/plugins/wikilink/)의 실제 구현이고, 클릭 없는 단순 스타일링은 번들 [`kbd`](../../src/plugin/builtin/plugins/kbd/)를 봐라(도그푸딩). 블록 임베드의 실사용 예는 번들 [`youtube-embed`](../../src/plugin/builtin/plugins/youtube-embed/)다.

에디터·능력 등록은 `{ id }`를 돌려주지만 **id 규칙은 셋으로 갈린다**(`ui.addToolbarButton`만 예외로 `null`을 돌려준다 — 위 호출 표의 「반환」 열이 정본이다):

- `registerInlinePattern`·`registerCompletion`·`ui.addToolbarButton` — `id`는 **선택**이다. 생략하면 호스트가 `<pluginId>:<call>:<seq>`로 만들어 주고, **같은 id로 다시 등록하면 덧붙이는 게 아니라 치환(upsert)** 한다(치환은 「최근 오류」에 «중복 등록»으로 남는다 — 복사-붙여넣기로 id를 안 바꾸면 버튼이 하나만 남는 이유가 거기 적힌다). 툴바 버튼만 반환이 `null`이라 만들어진 id를 돌려받을 수 없고, 그 id에 사용자의 툴바 배치·단축키가 붙으므로 버튼마다 직접 다른 값을 주는 편이 낫다.
- `registerBlockEmbed` — `id`는 **필수**다. 생략하거나 형식(소문자 영숫자로 시작, 이후 소문자·숫자·`.`·`-`·`_`)에 안 맞으면 디스크립터 검증에서 걸려 등록이 통째로 `INVALID_ARGS`로 거부된다. **`fence`도 `id`와 완전히 같은 형식이다** — `fence: "YouTube"`처럼 대문자를 쓰면 같은 이유로 등록 전체가 거부되니 `id`와 `fence`를 함께 확인하라. `sources`는 **1개 이상 32개 이하**여야 하고 빈 배열도 거부다. 오류 문구가 걸린 필드와 사유를 밝히므로(`잘못된 블록 임베드 디스크립터: fence — …`) 「최근 오류」에서 그대로 읽으면 된다. 같은 id 재등록은 치환이다.
- 능력 등록(`theme`·`background`·`font`·`window.register`) — `id` 인자를 **받지 않는다**(줘도 무시된다). 반환은 `<pluginId>:<call>` 형태의 안정 id이고, 다시 등록하면 능력별 병합 규칙을 따른다: theme=마지막 등록이 이김, background=처음 등록이 이김, font·window=합집합.

자동완성 후보를 실제로 받으려면 `notes:read`도 선언·부여돼야 한다 — 없으면 팝업은 뜨는데 후보가 영원히 0개다.

### ui (`ui`)

```js
memo.ui.addToolbarButton({
  id: "my-btn",
  label: "📋",
  title: "복사",
  // 실제 위치는 전역 「설정 › 외형 › 툴바 배치」가 정한다(사용자가 드래그&드롭으로 각 버튼을
  // 상/하 바의 존에 배치). position은 이 버튼을 **배치가 한 번도 본 적 없을 때**(설치 직후 등
  // 신규 버튼)만 쓰이는 자동 배치 존이다 — 배치가 그 버튼을 처음 보는 순간 이 존에 자동으로
  // 채워 넣는다. 사용자가 이미 자리를 잡아 준 버튼(옮겼든 그대로 두든)은 그 배치를 따르고,
  // 사용자가 팔레트로 빼내 미배치로 만든 버튼은 계속 숨는다("설치하면 이 존에 뜬다" 정도로
  // 이해하되, 사용자가 옮기거나 치우면 그 뒤로는 이 값을 다시 보지 않는다).
  position: "bottom-left", // top-left | top-right | bottom-left | bottom-right
  // onClick은 **필수**다(없으면 INVALID_ARGS로 거부돼 버튼이 등록되지 않는다 — 눌러도 아무
  // 일도 없는 버튼이 조용히 뜨지 않게). 첫 인자로 **이 클릭에 바인딩된 memo**를 받는다 —
  // 이름을 `memo`로 받아 전역을 가리는 것을 권장한다(아래 "창 컨텍스트" 절 참고).
  onClick: function (memo) {
    memo.ui.toast({ title: "안녕" });
  },
});

// 목록에서 하나 고르기 — 선택 id를 돌려준다(취소 시 null). 사용자 응답까지 대기.
const pick = await memo.ui.pickList({
  title: "템플릿 선택",
  items: [
    { id: "a", label: "주간회의" },
    { id: "b", label: "데일리" },
  ],
});

// 한 줄 입력 받기 — 입력값을 돌려준다(취소 시 null)
const name = await memo.ui.prompt({
  title: "이름",
  placeholder: "예: 주간회의",
});
```

툴바 버튼 + 설정을 실제로 조합한 실사용 예는 번들 [`template`](../../src/plugin/builtin/plugins/template/)·[`copy-ai-prompt`](../../src/plugin/builtin/plugins/copy-ai-prompt/)를 봐라(도그푸딩).

#### 토스트의 상태와 갱신 — `style` · `id`

`ui.toast`는 **띄우기·갱신·닫기를 한 호출로** 한다. `id` 없이 부르면 새로 띄우고 `{ id }`를
돌려주며, 그 id를 다시 실어 부르면 같은 토스트가 제자리에서 바뀐다(`dismiss: true`면 닫힌다).
함수 핸들이 아니라 문자열 id인 이유는 브리지가 postMessage라 함수를 나를 수 없어서다.

```js
// 오래 걸리는 작업의 정본 패턴: progress로 시작 → 같은 id로 success/failure로 바꾼다.
const t = await memo.ui.toast({ title: "변환 중", style: "progress" });
try {
  await doWork();
  await memo.ui.toast({ id: t.id, title: "완료", style: "success" });
} catch (e) {
  // 실패를 사용자에게 알리는 표준 수단이 이것이다.
  await memo.ui.toast({
    id: t.id,
    title: "변환 실패",
    message: e.code,
    style: "failure",
  });
}
```

| 값                  | 동작                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `style: "success"`  | 기본값. 잠시 뒤 자동으로 사라진다                                        |
| `style: "failure"`  | 자동으로 사라지되 더 오래 머문다                                         |
| `style: "progress"` | **자동으로 사라지지 않는다**(호스트가 30초 뒤 강제 소멸시켜 유령을 막음) |
| `message`           | 제목 아래 보조 설명(있으면 여러 줄로 넓어진다)                           |

**갱신은 부분 갱신이다** — 주지 않은 필드(`title`·`message`·`style`)는 그 토스트의 현재 값을
그대로 유지한다. 그래서 상태만 바꾸는 `memo.ui.toast({ id: t.id, style: "success" })` 한 번으로
충분하고, 그때 문구가 사라지지 않는다(진행 토스트에 `message`만 갱신해도 `progress` 상태와
자동 소멸 규칙이 그대로다).

`id`는 **그 창의 것**이다. 창 컨텍스트를 잃은 뒤(전역 `memo`로) 갱신하거나 이미 사라진 id로
갱신하면 무음 무시가 아니라 `INVALID_ARGS`로 거부된다. 모르는 `style`은 오류가 아니라
`success`로 접힌다. 반대로 **새** 토스트를 `title`(또는 `text`) 없이 띄우려 하면
`INVALID_ARGS`다 — 글자 없는 빈 알림은 사용자에게 아무것도 알리지 못한다.

#### 항목마다 여러 액션 — `pickList`의 `actions` · `sublabel`

항목에 `actions`를 **하나라도** 선언하면 `pickList`의 반환이 `{ itemId, actionId }`로 넓어진다.
안 쓰면 예전 그대로 문자열 id다 — 기존 플러그인은 무변경으로 산다.

```js
const r = await memo.ui.pickList({
  title: "템플릿",
  items: [
    {
      id: "a",
      label: "주간회의",
      sublabel: "3줄 · 마지막 사용 어제", // 라벨 아래 회색 보조 정보(텍스트만)
      actions: [
        { id: "insert", label: "삽입" },
        { id: "del", label: "삭제", style: "destructive" }, // 빨간 강조
      ],
    },
    { id: "b", label: "데일리" }, // actions 없음 → actionId는 "select"
  ],
});
if (r !== null && r.actionId === "del") {
  /* … */
}
```

라벨·부제는 **텍스트로만** 그려진다(마크업은 글자로 보인다). 액션 `id`가 빈 문자열이면 그
액션은 버려진다 — 빈 id를 돌려주면 어느 액션인지 구분할 수 없기 때문이다. 섹션 분할·퍼지
검색은 없다.

#### 여러 값을 한 번에 — `prompt`의 `fields`

`fields`를 주면 한 줄 입력이 **다중 필드 폼**이 되고, 반환이 `필드 id → 값` 맵으로 바뀐다
(취소하면 `null`). 별도의 `ui.form` 호출은 없다 — 같은 호출을 넓혔다.

```js
const v = await memo.ui.prompt({
  title: "새 템플릿",
  submitLabel: "만들기",
  fields: [
    { id: "name", label: "이름", type: "text", placeholder: "주간회의" },
    { id: "body", label: "본문", type: "textarea" },
    {
      id: "count",
      label: "줄 수",
      type: "number",
      default: 3,
      min: 1,
      max: 20,
    },
    { id: "pin", label: "고정", type: "toggle", default: false },
    {
      id: "kind",
      label: "종류",
      type: "select",
      options: [
        { value: "week", label: "주간" },
        { value: "day", label: "일간" },
      ],
    },
  ],
});
// v === { name: "…", body: "…", count: 3, pin: false, kind: "week" } | null
```

필드 타입은 매니페스트 `settings`의 어휘에서 `list`만 뺀 것이다(`text`·`textarea`·`toggle`·
`select`·`number`). **목록 밖 타입이나 빈 `id`는 조용히 접히지 않고 그 필드가 통째로 버려진다.**
그렇게 버리다 **필드가 하나도 남지 않으면(전부 오타·id 없음) 한 줄 입력으로 폴백하지 않고
`INVALID_ARGS`로 호출 자체가 거부된다** — 폴백하면 계약과 다른 UI가 뜨고 반환형까지 문자열로
달라지기 때문이다(거부 사유는 진단에도 남는다).
제출값 검증을 위한 호스트↔플러그인 왕복은 **일부러 없다** — 값을 받아 스스로 판단하고
`ui.toast({ style: "failure" })`로 알린 뒤 다시 `ui.prompt`를 부르는 것이 정본이다.

#### 상태 아이템 — 툴바에 라이브 텍스트 (`ui`)

`ui.addStatusItem`은 툴바에 **기본적으로 클릭 버튼이 아니라 텍스트·카운트를 보여주는** 아이템을
등록한다(단어 수·글자 수 같은 라이브 표시). 버튼과 **같은 툴바 배치 시스템**을 타므로 사용자가
「설정 › 외형 › 툴바 배치」에서 버튼과 동급으로 끌어 옮기고 숨길 수 있다.

> **배치가 기억하는 키에는 `status:` 접두가 붙는다** — 상태 아이템은
> `plugin:<pluginId>:status:<itemId>`, 툴바 버튼은 `plugin:<pluginId>:<buttonId>`다(명령의
> `cmd:`·메뉴의 `menu:`와 같은 방식). 한 플러그인이 버튼과 상태 아이템에 **같은 `id`를 써도**
> 배치에서 충돌하지 않는다는 뜻이고, 그것이 접두를 붙인 이유다. 저작자가 직접 다룰 값은
> 아니지만, `id`를 바꾸면 사용자가 잡아 둔 자리가 초기화된다는 점은 버튼과 같다.

`text`는 **초기값**일 뿐이다. 값은 **창마다 다를 수 있어**(각 노트의 단어 수가 다르다) 등록이
아니라 **창-스코프** `ui.updateStatusItem`이 나른다 — `note:opened`(첫 값)·`note:saved`(이후 값)
이벤트 핸들러의 첫 인자로 오는 **바인딩된 `memo`**로 부르면 그 창의 아이템만 갱신된다. 갱신하려면
`id`를 직접 줘라(생략하면 호스트가 만들어 갱신 대상 id를 알 수 없다). 등록은 다른 등록과 같은
마감(`runtime.ready()`) 전에 한다.

```js
// 등록(호스트 스코프) — 초기값·자동 배치 존만 준다.
memo.ui
  .addStatusItem({
    id: "word-count",
    text: "0 단어",
    title: "단어 수",
    position: "bottom-right",
  })
  .then(function () {
    // 열릴 때·저장될 때 그 창의 값을 갱신(핸들러의 memo가 그 창에 바인딩돼 있다).
    memo.events.on({ name: "note:opened", handler: refresh });
    memo.events.on({ name: "note:saved", handler: refresh });
    return memo.runtime.ready();
  });

function refresh(memo) {
  return memo.notes.current().then(function (note) {
    var words = (((note && note.content) || "").match(/\S+/g) || []).length;
    return memo.ui.updateStatusItem({
      id: "word-count",
      text: words + " 단어",
    });
  });
}
```

이 패턴이 번들 [`word-count`](../../src/plugin/builtin/plugins/word-count/)의 실제 구현의 뼈대다(도그푸딩) — 실물은 "N 단어"·"M 자" 두
아이템을 각각 등록하고 아래처럼 `onClick`을 얹어 클릭 시 그 문구를 클립보드에 복사한다.
`updateStatusItem`을 등록 전에 부르거나 이 창에 없는 id로 부르면 무음 무시가 아니라
`INVALID_ARGS`로 거부된다.

`onClick`(선택)을 주면 이 아이템이 **클릭 가능**해진다 — 렌더는 여전히 텍스트지만(버튼 박스로
바뀌지 않는다) 커서·hover가 붙고, 클릭하면 `addToolbarButton`의 `onClick`과 **완전히 같은 규약**
으로 그 클릭에 바인딩된 `memo`가 온다:

```js
memo.ui.addStatusItem({
  id: "word-count-words",
  text: "0 단어",
  position: "bottom-right",
  onClick: function (memo) {
    memo.clipboard
      .write({ text: "3 단어" }) // 지금 표시된 그 문구를 그대로
      .then(function () {
        return memo.ui.toast({ title: "복사됨" });
      });
  },
});
```

> **주의 — `events.on`은 `settings` 권한을 요구한다.** 위 예제처럼 `.then` 안에서 `events.on`을
> 부르려면 매니페스트 `permissions`에 `"settings"`를 넣어야 한다(없으면 `PERMISSION_UNDECLARED`).
> 그리고 예제의 두 `events.on`은 반환·`.catch` 없이 흘려보내는 형태라, 권한을 빠뜨리면 그 거부
> 프라미스가 미처리로 새어 나간다. 마감을 잇는 체인 끝(`runtime.ready()` 앞)에서 `.catch`로 감싸
> 실패를 「최근 오류」/`run` 진단으로 보이게 하라(함정 #10).

#### 에디터 컨텍스트 메뉴

노트 본문에서 우클릭하면 호스트가 메뉴를 그린다 — 기본 편집 항목(잘라내기·복사·붙여넣기·전체
선택) → 삽입(이미지·유튜브·링크) → 앱(새 메모·노트 목록/검색 열기·설정 열기) 아래에 **커뮤니티/
사이드로드 플러그인이 이 창에 배달한 버튼·명령·메뉴 항목이 이름으로** 나열된다. 툴바는 글리프만
보이므로(이름은 tooltip) 메뉴가 이름으로 고르는 유일한 자리다. 항목이 창 높이보다 길어지면
메뉴가 창 안으로 접히고 **안에서 스크롤**된다 — 낮은 스티키 창에 항목을 여럿 얹어도 잘려
나가지 않는다.

**빌트인(번들) 플러그인의 항목은 이 구역에 나열되지 않는다** — 빌트인은 이미 툴바 버튼을 갖고
있어서, 같은 동작을 이름으로 또 나열하면 중복이었다(호스트가 플러그인 출처로 자동 필터한다 —
저작자가 할 일은 없다). 커뮤니티/사이드로드 플러그인의 버튼·명령·메뉴 항목은 저작자가 할 일이
없다 — `ui.addToolbarButton`이나 `commands.register`로 등록만 하면 자동으로 올라간다(버튼은
`title`, 없으면 `label`; 명령은 `title`).

> **툴바에 이미 있는 동작을 컨텍스트 메뉴에 중복 등록하지 마세요.** 툴바 버튼(`addToolbarButton`)
> 은 자동으로 메뉴에도 이름으로 오르므로, 같은 동작을 `ui.addMenuItem`으로 따로 또 등록하면
> 사용자에게 똑같은 항목이 둘로 보인다. `ui.addMenuItem`은 **메뉴에만 있는 별도 항목**(툴바·
> 단축키에는 자리를 잡지 않는 동작)을 위한 것이다 — 「선택 텍스트 감싸기」처럼 선택 단위
> 동작에 맞는다.

**메뉴에만 있는 별도 항목**은 `memo.ui.addMenuItem`으로 등록한다(툴바·단축키에는 자리를 잡지
않고 우클릭 메뉴에만 뜬다). `run`의 첫 인자는 그 창에 바인딩된 `memo`이고, **둘째 인자
`payload.selectedText`**는 우클릭 순간의 선택 텍스트다 — 다만 그 필드는 매니페스트에
`notes:read`를 선언·부여받았을 때만 채워진다(선택 텍스트는 노트 본문의 일부라 `ui` 권한만으로는
넘기지 않는 payload 단위 게이트다). `when`은 **창 상태 두 키**(`note.isEmpty`·
`note.hasSelection`)만 쓴다(명령의 `when`과 달리 정적 키는 못 쓴다 — 판정 주체가 렌더 시점의
노트 창이라). 조건이 거짓인 항목은 회색이 아니라 메뉴에서 빠진다. `run`은 필수다(없으면
`INVALID_ARGS`).

```js
memo.ui.addMenuItem({
  id: "upper",
  label: "선택 대문자로",
  when: ["note.hasSelection"], // 선택이 있을 때만 메뉴에 뜬다
  run: function (memo, payload) {
    // selectedText는 notes:read를 선언·부여받았을 때만 채워진다.
    if (payload.selectedText)
      memo.editor.insertText({ text: payload.selectedText.toUpperCase() });
  },
});
```

#### 선택 액션 — `ui.addSelectionAction`

본문을 **선택**하면 선택 근처에 서식 플로팅 바(굵게·기울임·취소선·코드·형광펜·링크·색)가
뜬다 — 마우스 드래그든 Shift+화살표·`Mod-A` 같은 키보드 선택이든 가리지 않는다.
`memo.ui.addSelectionAction`은 그 바의 **맨 끝**(색 버튼 다음)에 버튼 하나를 얹는다. 「선택한 식을 계산해 결과로 바꾸기」·「선택 대문자로」처럼 **선택이 있어야 뜻이
있는 동작**에 쓴다.

**표면은 둘, 등록은 하나다.**

1. **선택 툴바** — 선택이 만들어진 순간(드래그는 버튼을 놓을 때, 키보드는 손이 멈춘 뒤)
   `match`가 맞으면 버튼이 나타나고, 누르면 `run`이 돈다.
2. **「설정 › 단축키 › 플러그인 동작」** — 사용자가 키를 배정할 수 있다. 누르면 선택이 비어
   있지 않고 `match`가 맞을 때만 `run`이 돈다(조건이 안 맞으면 조용히 아무 일도 없다 — 조건부
   동작의 단축키는 조건이 안 맞을 때 눌리는 것이 정상이라 오류로 다루지 않는다).

바가 한 번에 그리는 액션 버튼에는 상한이 있다(지금 5개 — 좁은 플로팅 바에 서식 버튼이 이미
자리를 쓴다). 넘친 액션은 **그려지지 않을 뿐 실행 불가능해지지 않는다**: 단축키 표면은 상한을
보지 않는다.

`ui.addMenuItem`과의 구분: 저 쪽은 **우클릭 메뉴** 전용이고 커뮤니티 플러그인만 나열된다.
선택 액션은 **선택 제스처**에 붙고 빌트인/커뮤니티를 가리지 않는다. 같은 동작을 둘 다에
등록하면 사용자는 같은 것을 두 자리에서 본다 — 선택 단위 동작이면 선택 액션 하나면 된다.

##### `match` — 정규식이 아니라 닫힌 어휘

`match`를 생략하면 **선택이 있을 때 언제나** 뜬다. 주면 호스트가 **창 안에서 로컬로** 판정한다 —
선택이 확정된 순간(드래그는 버튼을 놓을 때, 키보드는 손이 멈춘 뒤) 한 번, 샌드박스 왕복도
방송도 없다. 그래서 고빈도 이벤트를 열지 않고도 조건부 표시를 줄 수 있다(플러그인은 타이핑마다
도는 이벤트를 구독할 수 없다 — 그 원칙을 여기서도 깨지 않는다).

세 축뿐이고 전부 AND다. 주지 않은 축은 검사하지 않는다.

| 축            | 뜻                                                              |
| ------------- | --------------------------------------------------------------- |
| `charClasses` | 선택의 **모든** 글자가 이 부류 중 하나 이상에 속해야 한다       |
| `singleLine`  | 참이면 줄바꿈이 든 선택에서는 뜨지 않는다                       |
| `maxLength`   | 선택 글자 수 상한(코드 포인트 기준 — 이모지가 둘로 세지 않는다) |

문자 부류는 닫힌 열거다(`digit`·`operator`·`space`·`latin`·`hangul`·`punctuation` — 각 부류의
문자 집합은 `api-reference.json`의 `MemoCharClass`에 표로 실려 있다). 부류들은 **서로 배타적이지
않다**(예: `.`는 `operator`이자 `punctuation`이다) — 판정이 "모든 글자가 고른 부류 중 하나
이상에 속하는가"라 겹침은 무해하다.

왜 정규식을 받지 않나: 인라인 패턴의 구분자가 리터럴만 받는 것과 **같은 이유**다. 플러그인이
준 정규식을 호스트가 사용자 텍스트에 돌리면 ReDoS가 열리고, 판정 주체는 어차피 호스트(창)다.
어휘 밖 값(모르는 부류 이름·빈 `charClasses`·0 이하 `maxLength`)은 조용히 무시되지 않고 등록
시점에 `INVALID_ARGS`로 거부된다 — 버리면 조건이 넓어진(=아무 선택에서나 뜨는) 버튼이 되어
오타를 알려주지 않는 무음 실패가 된다.

##### 권한 — 읽기는 게이트, 쓰기는 기존 경로

등록·렌더 자체는 저위험 `ui`다. **`payload.selectedText`는 `notes:read`를 선언·부여받았을 때만
채워진다** — `ui.addMenuItem`과 글자 그대로 같은 계약이다(선택 텍스트는 노트 본문의 일부라
`ui`만으로는 넘기지 않는 payload 단위 게이트). 권한이 없으면 호출은 그대로 동작하고
`payload.selectedText`만 언제나 `undefined`다.

되쓰기 경로는 **새로 열지 않는다**: 결과를 본문에 넣으려면 `run` 안에서
`memo.editor.insertText`(`notes:write`)를 그대로 쓴다. 선택이 있으면 그 선택을 대체하므로,
"읽고 → 바꾸고 → 되쓰기"가 기존 호출 둘로 완결된다.

```js
memo.ui.addSelectionAction({
  id: "upper",
  label: "A", // 좁은 바에 보일 글자/이모지(필수 — 마크업이 아니라 평문으로 그려진다)
  title: "선택 대문자로", // 툴팁이자 단축키 화면에 보일 이름
  // 생략하면 선택이 있을 때 언제나 뜬다. 주면 호스트가 창 안에서 로컬로 판정한다.
  match: { charClasses: ["latin", "space"], singleLine: true, maxLength: 200 },
  run: function (memo, payload) {
    // selectedText는 notes:read를 선언·부여받았을 때만 채워진다(addMenuItem과 같은 계약).
    if (!payload.selectedText) return;
    // 되쓰기는 기존 경로 그대로 — insertText는 선택이 있으면 그 선택을 대체한다(notes:write).
    memo.editor.insertText({ text: payload.selectedText.toUpperCase() });
  },
});
```

`id`는 사용자의 **단축키 배정이 붙는 영속 키**다 — 생략하면 호스트가 만들어 주지만(그러면
재설치·재빌드마다 흔들릴 수 있다) 직접 주는 편이 좋다. 같은 `id`로 다시 등록하면 추가가 아니라
치환(upsert)이고 진단에 「중복 등록」으로 남는다(다른 등록과 같은 계약). 등록은 다른 등록과 같은
마감(`runtime.ready()`)에 닫힌다.

#### 메뉴바 트레이 항목 — `ui.addTrayItem`

`memo.ui.addTrayItem`은 노트 창이 아니라 **네이티브 메뉴바(시스템 트레이) 메뉴**에 항목을
등록한다 — 모든 노트에 걸친 앱 전역 동작(전역 토글·설정 열기 대체 등)에 쓴다. 다른 등록과 같은
마감(`runtime.ready()`)에 닫히고, 같은 `id`로 다시 부르면 치환(upsert)된다 — 라벨이 바뀌어야
하면 같은 `id`로 다시 등록하면 된다(별도의 갱신 호출은 없다).

**호스트 스코프라 클릭에 창 컨텍스트가 없다.** 트레이는 특정 노트 창과 무관한 앱 전역 자원이라,
`run`의 첫 인자로 오는 `memo`의 창-스코프 호출(`ui.toast`·`editor.insertText`·`notes.current`
등)은 **마지막으로 쓴 메모 창**으로 폴백하거나, 그마저 없으면 `CONTEXT_UNAVAILABLE` + 진단으로
끝난다(설정 화면 액션 버튼과 같은 계약). 특정 창에 확실히 닿아야 하는 동작이면 트레이보다 툴바
버튼(`ui.addToolbarButton`)이 맞다. `run`·`label`은 둘 다 필수다(없으면 `INVALID_ARGS`). 트레이는
네이티브가 그리므로 라벨은 평문 텍스트로만 나간다(마크업·스타일 없음).

```js
memo.ui.addTrayItem({
  id: "hide-all",
  label: "메모 모두 숨기기",
  run: function (memo) {
    // 이 memo의 창-스코프 호출은 마지막으로 쓴 메모 창으로 폴백한다(위 설명 참고).
    memo.ui.toast({ title: "숨겼어요" });
  },
});
```

#### 창 컨텍스트 — `onClick(memo)` 인자를 써라

노트 창은 여러 개가 동시에 열린다. 그래서 **창-스코프 호출**(위 호출 표에서 스코프가 「창」인
것들 — `ui.toast`·`ui.pickList`·`ui.prompt`·`editor.getFontDelta`·`editor.setFontDelta`·
`editor.insertText`·`clipboard.write`·`notes.current`·`notes.duplicate`·`notes.resetOptions`)은
"어느 창의 클릭에서 나왔는가"를 호스트가 알아야 한다. 호스트는 클릭마다 불투명 토큰을 발급하고,
샌드박스가 그 토큰을 호출에 실어 보낸다. 등록 호출(`editor.register*`·능력 등록)과
`settings.*`·`runtime.*`은 창과 무관하다.

토큰을 잃지 않는 **정본 방법은 `onClick`의 첫 인자로 오는 `memo`를 쓰는 것**이다. 이 인자는 그
클릭에 고정 바인딩된 브리지라, 토큰이 클로저에 들어 있어 어떤 비동기 경계(`Promise.all`,
`setTimeout`, 비-브리지 `await`, 이벤트 콜백)를 넘어도 유지된다.

```js
// 권장: 인자로 받은 memo가 전역을 가린다(본문 코드는 그대로 두면 된다).
onClick: function (memo) {
  Promise.all([memo.notes.current(), memo.settings.get({ key: "template" })])
    .then(function (r) {
      var note = r[0];
      if (note === null) return null; // 창 컨텍스트가 없으면 null이 온다 — 반드시 확인한다.
      return memo.clipboard.write({ text: note.path }).then(function () {
        return memo.ui.toast({ title: "복사됨" }); // 반드시 클릭한 그 창에서 뜬다
      });
    })
    .catch(function (e) {
      memo.runtime.log({ message: e.call + " → " + e.code });
    });
}
```

전역 `window.memo`도 최선 노력으로 토큰을 전파한다 — **`.then()`/`.catch()`/`.finally()` 체인과
브리지 호출을 직접 `await`하는 경우**(`await memo.ui.pickList(...)` → 다음 줄)까지는 정확하다.
그 밖의 경계에서는 **토큰이 유실**되고, 호스트는 "그 플러그인을 마지막으로 클릭한 창"으로
폴백한다 — 창이 두 개 이상이면 A에서 누른 결과가 B에 나타날 수 있다. 이 폴백도 아래의
**유휴 만료 규칙을 그대로 탄다**(토큰을 빼는 것이 만료 우회가 되지 않게). 토큰이 유실되는
경우:

- `Promise.all`/`Promise.race`/`Promise.allSettled`/`Promise.resolve(브리지호출)` 로 감싼 뒤의 콜백
- `setTimeout`·`requestAnimationFrame`·DOM 이벤트 콜백 안의 호출
- 브리지가 아닌 프라미스(`await new Promise(...)`, `await fetch(...)`)를 기다린 **뒤**의 호출

바인딩된 `memo`의 토큰은 그 클릭이 끝난 뒤에도 계속 그 창을 가리키지만, **유휴 만료가 있다**:
마지막 활동(그 토큰을 실은 호출, 창 응답 대기의 완료, 그 창으로의 이벤트 배달) 후 **5분**이
지난 토큰으로 **민감 권한 호출**(`editor.insertText`·`clipboard.write`·`notes.current` 등 —
호출 표에서 권한 등급이 민감인 것)을 부르면 조용한 `null`이 아니라
`code: "CONTEXT_UNAVAILABLE"`로 reject된다(진단에도 남는다). **토큰 없는 호출의 「마지막
클릭 창」 폴백도 같은 규칙이다** — 마지막 클릭·사용 후 5분이 지난 폴백으로의 민감 호출은
똑같이 거부된다. 저위험 호출(`ui.toast` 등)은 어느 경로든 만료와 무관하게 현행대로 동작한다.

정당한 지연 사용은 만료에 걸리지 않는다 — 오래 걸리는 작업 **중에도 호출이 이어지는** 체인
(진행 토스트 갱신 등)은 활동으로 집계되고, 대화형 팝업(`pickList`/`prompt`, 최대 10분 대기)은
응답 대기 중 만료되지 않으며 응답 완료가 곧 활동이라 **후속 삽입도 안전하다**. 만료가 막는
것은 "클릭과 인과관계가 없는 지연 호출"(바인딩 memo를 오래 들고만 있다가 예전 창들을 나중에
타깃하는 것)이다 — 그런 패턴은 애초에 이 토큰에 기대지 마라.

#### 언제 `null`이 오는가

창 컨텍스트를 찾지 못한 창-스코프 호출은 **오류가 아니라 `null`** 로 끝난다 — 성공과 구분되지
않는다. 그래서 창-스코프 호출의 반환 타입은 전부 nullable이고(위 호출 표), 값을 쓰기 전에
확인해야 한다.

| 상황                                        | 결과                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 토큰 없음(부팅 시점 호출)                   | `null` — 아직 아무 창도 이 플러그인을 클릭한 적이 없다                                                                  |
| 모르는 토큰(호스트 재빌드)                  | `null` — 설정 변경 등으로 이전 빌드의 컨텍스트가 통째로 무효가 됐다                                                     |
| 남의 토큰                                   | `null` — 임의 창을 타깃으로 삼는 것을 막는다(폴백하지 않는다)                                                           |
| 유휴 만료된 컨텍스트(토큰·폴백) + 민감 호출 | reject(`CONTEXT_UNAVAILABLE`) — 마지막 활동 후 5분 초과. 새 클릭·이벤트의 memo로 다시 호출한다(저위험 호출은 계속 동작) |
| 창이 닫힘/무응답                            | reject(`창 응답 없음`) — 5초(대화형 팝업은 10분) 안에 회신이 없으면 실패                                                |

`null`로 무력화된 호출은 **호스트가 진단으로 기록한다** — 「설정 › 플러그인 › 최근 오류」에
"창 컨텍스트가 없어 아무 일도 일어나지 않았습니다"로 남으므로, 사용자가 그 텍스트를 그대로
붙여넣어 줄 수 있다.

#### null 대신 오류로 받기 — `requireWindow: true`

무음 실패를 **테스트 가능한 실패**로 바꾸고 싶으면 창-스코프 호출에 `requireWindow: true`를
준다. 컨텍스트가 없을 때 `null`이 아니라 `code: "CONTEXT_UNAVAILABLE"`로 reject된다(위 세
행에만 해당한다 — 창 무응답은 원래도 reject다).

```js
try {
  const note = await memo.notes.current({ requireWindow: true });
  await memo.clipboard.write({ text: note.path, requireWindow: true });
} catch (e) {
  if (e.code === "CONTEXT_UNAVAILABLE") {
    // 이 호출은 클릭에서 파생되지 않았다 — onClick(memo)의 인자를 쓰지 않은 것이다.
  }
}
```

기본값은 `false`다(옵트인 — 컨텍스트가 없을 때 던지지 않고 조용한 `null`로 끝나는 쪽이 기본
동작이다). 새로 쓰는 코드에서 값이 실제로 필요한 호출이라면 켜 두는 쪽을 권한다.

한 줄 요약: **창-스코프 호출은 `onClick(memo)` 인자를 통해 하라.** 등록 호출(패턴·버튼·테마 등)과
`settings.*`·`runtime.*`은 창과 무관해서 전역 `memo`로도 안전하다.

### settings (`settings`) · notes (`notes:read`) · clipboard (`clipboard`)

```js
const tmpl = await memo.settings.get({ key: "template" }); // 매니페스트 settings 키
await memo.settings.set({ key: "template", value: "{path}" });

// 선언된 모든 키를 한 번에(기본값 병합된 스냅샷) — 키 이름을 하나씩 맞출 필요가 없다.
const cfg = await memo.settings.getAll(); // { template: "{path}", ... }
// list 타입은 배열로 온다. 쓸 때도 배열 그대로 — 직렬화는 호스트가 한다.
const items = await memo.settings.get({ key: "templates" }); // [{ name, body }, ...]
await memo.settings.set({
  key: "templates",
  value: items.concat([{ name: "새것", body: "본문" }]),
});

const note = await memo.notes.current(); // { id, path, content } | null   + notes:read
if (note !== null) await memo.clipboard.write({ text: note.path }); // + clipboard

// 현재 노트를 복제(내용·설정 override 동일)해 새 노트 창을 연다 — 복제/열기는 네이티브가 수행.
await memo.notes.duplicate(); // + notes:write   (복제 플러그인 참고)

// 이 메모만의 옵션(배경·글자 크기·투명도·핀 등)을 전역 기본값으로 되돌린다 — 실제 초기화
// (override 비우기·재적용·툴바 재동기화·영속화 + 확인 다이얼로그)는 네이티브가 수행한다.
// **이름은 복수형** `memo.notes.resetOptions()` 하나뿐이다(단수 `memo.note.resetOptions()`는
// 게이트에 없어 UNKNOWN_CALL — 옵션 초기화 플러그인 참고).
await memo.notes.resetOptions(); // + notes:write
```

### 전체 노트 읽기 (`notes:all-read`)

`notes:read`가 여는 것은 「지금 열린 메모 + 전체 제목 목록」까지다. **컬렉션 전체**(전체 검색·
백링크·통계·데일리 노트류)가 필요하면 별도 민감 권한 `notes:all-read`를 선언한다 — 승인 문구
그대로 "숨긴 메모를 포함한 모든 메모의 제목과 내용"이 열리므로, 정말 필요한 플러그인만
요구해라.

```js
// 1) 목록 — 메타만 온다(본문 없음). 호스트 스코프라 창 컨텍스트가 필요 없다.
const notes = await memo.notes.list(); // [{ id, title, hidden, createdAt }]
// 숨긴 노트도 포함돼 온다 — 사용자의 숨김 의도를 존중하려면 걸러라.
const visible = notes.filter(function (n) {
  return !n.hidden;
});

// 2) 본문 — id 하나로 한 건씩 읽는다(컬렉션 전체 본문을 한 번에 나르는 API는 없다).
const note = await memo.notes.read({ id: visible[0].id }); // { id, content }
```

- `list`는 기본 500건, 상한 1000건이다(초과 요청은 1000으로 클램프). 더 큰 컬렉션은
  `offset`으로 페이지를 넘긴다: `memo.notes.list({ limit: 1000, offset: 1000 })`.
- `read`의 id는 `list`가 돌려준 **불투명 식별자**다 — 경로가 아니고, 존재하지 않는 id는
  `code: "NOTE_NOT_FOUND"`로 reject된다(고른 사이 노트가 지워진 경우 — 목록을 다시 읽어라).
  동작하는 전체 예제: [`docs/plugin/examples/example-note-picker`](examples/example-note-picker) —
  목록에서 골라 그 본문을 커서에 삽입한다.

#### notes.write — 열려 있지 않은 노트에 쓰기 (`notes:write`)

`editor.insertText`가 **열린 창의 커서**에 쓰는 것과 달리, `memo.notes.write`는 `notes.list`로 찾은
**임의 id의 노트**를 직접 쓴다(창 컨텍스트가 필요 없는 호스트 스코프 — `notes.list`/`notes.read`와
같은 결). 권한은 `editor.insertText`와 **같은 `notes:write`**다(별도 권한을 새로 만들지 않았다).

`mode`가 파괴성을 가른다:

- **`append`(생략 시 기본)** — 본문 끝에 이어붙인다. 비파괴 · 저마찰.
- **`overwrite`** — 본문을 통째로 덮는다. 파괴적이지만, 호스트가 덮기 **전에** 이전 본문을 앱
  소유 **복구 슬롯에 스냅샷**하므로 되돌릴 수 있다(memo에는 undo도 휴지통도 없어 이 스냅샷이
  유일한 안전망이다 — 복구는 앱이 소유하고, 플러그인에 스냅샷 접근 API는 열지 않았다).

`id`는 `notes.list`가 준 **불투명 식별자**여야 한다 — 경로 형태(구분자·`..`·`:`)면 `INVALID_ARGS`로
거부된다(경로 해석은 호스트 독점, vault 밖 접근 차단). 없는 id는 `NOTE_NOT_FOUND`.

```js
// 열려 있지 않은 노트 끝에 한 줄 덧붙인다(비파괴).
await memo.notes.write({
  id: "노트id",
  content: "\n덧붙일 줄",
  mode: "append",
});

// 통째로 덮어쓴다 — 덮기 전 이전 본문이 복구 슬롯에 스냅샷된다.
await memo.notes.write({
  id: "노트id",
  content: "새 전체 본문",
  mode: "overwrite",
});
```

### 네트워크 (`network:<도메인>`) — 호스트가 대신 보내는 https 요청

`memo.network.fetch`는 외부 서버에 https 요청을 보낸다. **샌드박스는 네트워크에 직접 닿지
못하므로 호스트(Rust)가 대신 요청하고 응답을 돌려준다.** 그래서 승인 단위가 **도메인**이다:
URL의 호스트마다 `network:<호스트>`를 따로 선언·부여해야 하고(예 `network:api.github.com`),
선언 밖 호스트로는 나갈 수 없다.

```js
const res = await memo.network.fetch({
  url: "https://api.github.com/zen", // https만. 이 호스트의 network:<호스트> 권한 필요
  method: "POST", // 생략하면 GET. GET·POST·PUT·PATCH·DELETE·HEAD만
  headers: [{ name: "Accept", value: "application/json" }], // 요청·응답 모두 { name, value }[]
  body: JSON.stringify({ a: 1 }), // 문자열만(객체는 직접 stringify)
});
// res = { status, headers: [{ name, value }], body }
// 리다이렉트는 따라가지 않는다 — 3xx면 status가 3xx이고 Location이 headers에 온다.
if (res.status >= 200 && res.status < 300) {
  // res.body는 문자열(최대 5MiB)
}
```

호스트가 강제하는 것(플러그인이 우회할 수 없다):

- **https 전용**(`NETWORK_SCHEME`) · **허용 메서드 6종**(`NETWORK_METHOD`).
- **SSRF 차단** — 사설/내부 IP·링크로컬·클라우드 메타데이터(169.254.169.254 등)로 해석되는
  주소는 `NETWORK_BLOCKED`으로 거부한다. DNS로 해석한 IP를 핀해 리바인딩도 막는다.
- **리다이렉트 미추적** — 3xx를 그대로 반환한다(따라가면 검사를 우회하므로). 새 URL로 다시
  부르면 그 URL도 도메인 승인·SSRF 검사를 처음부터 다시 받는다.
- **자격증명 미전달** — 앱 쿠키·인증 없이 새 요청으로 나간다. 요청 헤더의 `Host`·`Cookie`·
  `Authorization` 등은 호스트가 떼어낸다(자격증명 주입·핀 우회 차단).
- **상한** — 응답 5MiB(`NETWORK_TOO_LARGE`) · 요청 30초(`NETWORK_TIMEOUT`).

실패는 항상 `err.code`로 분기하라(한국어 문구가 아니라). 동작하는 전체 예제:
[`docs/plugin/examples/example-network-fetch`](examples/example-network-fetch) — 공개 API의
응답 한 줄을 커서에 삽입한다.

### theme (`theme`) · background (`background`) · font (`font`)

```js
memo.theme.register({
  // hex만. 의미색(accent·danger·warning)은 라이트/다크 공통 단일 값.
  // 표면색(surface·card·border·text·panel·panel-text)은 라이트(`<key>`)와 다크(`<key>-dark`)를
  // 따로 준다(크롬이 시스템 외관을 따르므로). 안 준 토큰은 CSS 폴백을 쓴다.
  // panel·panel-text는 노트 목록·검색 패널 창 전용 배경/글자색이다(설정 창은 surface·text).
  tokens: {
    accent: "#37506a",
    danger: "#c0392b",
    warning: "#b7791f",
    surface: "#fbfbf8",
    "surface-dark": "#1f1f1f",
    card: "#ffffff",
    "card-dark": "#2b2b2b",
    border: "#dcdcd6",
    "border-dark": "#454545",
    text: "#1f2328",
    "text-dark": "#ededed",
    panel: "#fbfbf8",
    "panel-dark": "#1f1f1f",
    "panel-text": "#1f2328",
    "panel-text-dark": "#ededed",
  },
});
memo.background.register({
  swatches: ["#e5dbc3", "#fdf6e3"],
  autoTextContrast: true,
});
memo.font.register({
  families: [
    { label: "세리프", stack: "Georgia, 'Times New Roman', serif" }, // stack은 CSS 폰트 스택
  ],
  includeSystem: true, // OS에 설치된 글꼴도 후보에 넣는다(목록은 호스트가 열거)
});
```

> **테마 샌드박스 제약**: 활성 테마로 선택된 플러그인은 다른 코드 플러그인과 다른(더 좁은)
> 실행 경로를 탄다 — 그 경로에서 실행되는 호출은 **`theme.register` 하나뿐**이다. 그 밖의
> 호출은 매니페스트에 권한을 선언해 게이트를 통과시켜도
> `테마 플러그인은 theme.register만 사용할 수 있습니다: <호출명>` 오류로 **거부된다**
> (`background.register`·`font.register`·`editor.*`·`window.register` 같은 순수 등록 호출도
> 예외가 아니다 — 테마 샌드박스는 등록을 수집한 즉시 폐기되므로 상주 능력을 실을 자리가 없다).
> 권한 문제가 아니라 테마 실행 경로의 구조적 제약이니, 테마는 색 토큰만 등록하는 순수 선언
> 코드로 작성하라.
>
> 배경·폰트 능력을 함께 내고 싶으면 **별도 플러그인으로 나눠** 「플러그인」 목록에서 켜라 —
> 위 `background.register`/`font.register` 예제는 (테마가 아닌) 일반 코드 플러그인의 실행
> 경로에서 동작하는 호출이다.

테마는 `theme` 권한만 선언하는 저위험 코드 플러그인이다([`SJ_D`](../../src/plugin/builtin/themes/SJ_D/) 참고).
배경([`background`](../../src/plugin/builtin/plugins/background/))·폰트([`font`](../../src/plugin/builtin/plugins/font/))도 같은 결의 선택형 능력 번들이다 — 각각 노트 배경 스와치와 설정 폰트 피커 후보를 공급하고, 플러그인을 끄면 그 능력이 사라진다(고정 배경·시스템 폰트). `font`의 `stack`은 등록 시점에 CSS 이탈 문자(`;{}<>\`)를 걸러 스타일 인젝션을 막는다.

배경·창 컨트롤과 달리 **폰트는 여러 플러그인이 함께 공급한다** — 후보는 등록 순서를 보존한 합집합이고, 같은 `stack`은 먼저 등록한 쪽만 남는다. 빌트인 「폰트」를 끄지 않아도 외부 폰트 플러그인의 후보가 그대로 붙는다.

`includeSystem: true`는 **목록이 아니라 스위치**다 — OS에 설치된 글꼴을 훑는 일과 그 출처 표시(설치 글꼴인지·한글을 담았는지·지역화 이름이 무엇인지)는 호스트가 한다. 그래야 설정 피커가 「기본」·「한글」·「설치된 글꼴」 구역을 믿고 나눌 수 있고, 수백 벌짜리 목록이 샌드박스 경계를 왕복하지 않는다. 같은 이유로 항목에 `system`·`korean`·`alias`를 직접 넣어도 등록 시점에 **떼어낸다**(호스트 소유 필드).

설치 글꼴의 이름은 폰트 파일의 영문 이름을 쓴다(CSS가 매칭하는 정규 이름). 지역화 이름은 `alias`로 따로 들고 있다가 **검색에만** 쓴다 — 그래야 "NanumGothic"으로 보이는 줄이 "나눔"으로도 걸린다.

### window (`window-control`)

```js
// 노트 툴바의 창 컨트롤(투명도 슬라이더·항상 위 토글·모든 데스크탑 토글)을 "제공"하는 능력 선언.
// 컨트롤 id만 선언하고, 실제 창 제어(투명도 적용 등)는 네이티브 노트 창이 수행한다.
memo.window.register({ controls: ["transparency"] }); // transparency | always-on-top | all-desktops
```

> **혼동 주의**: `memo.window.register`(단수 `window`)와 `memo.windows.open`(복수 `windows`)은
> 이름이 한 글자 차이지만 완전히 다른 API다. `window.register`는 "이 창 컨트롤을 제공한다"는
> 저위험(`window-control`) 선언이고, `windows.open`은 "임의 창을 연다"는 민감(`windows`) 권한이며
> 아직 브리지에 배선되지 않은 예약 호출이다(위 호출 표의 「상태」 열 참고). 오타·자동완성으로
> 서로 바꿔 쓰면 의도와 다른 권한 검사 경로를 타거나 조용히 거부되니 철자를 확인하라.

투명도·항상 위·모든 데스크탑은 각각 **토글 가능한 능력 번들**이다([`transparency`](../../src/plugin/builtin/plugins/transparency/)·[`always-on-top`](../../src/plugin/builtin/plugins/always-on-top/)·[`all-desktops`](../../src/plugin/builtin/plugins/all-desktops/)) — 켜면 그 컨트롤이 노트 툴바에 나타나고, 끄면 사라지며 기능이 기본값으로 되돌아간다(배경·폰트와 같은 결). 투명도·모든 데스크탑은 macOS `NSWindow`에 의존하므로 `platforms: ["macos"]`로 선언한다(다른 OS에서 자동 비활성).

### events (`settings`) — 생명주기 구독

```js
memo.events.on({
  name: "note:saved", // 닫힌 열거 — 목록 밖 이름은 INVALID_ARGS로 거부된다
  // 첫 인자는 **그 이벤트가 난 창에 바인딩된 memo**다(onClick과 같은 계약).
  // 둘째 인자가 페이로드 — 노트 본문은 어떤 이벤트에도 실리지 않는다.
  handler: function (memo, e) {
    memo.ui.toast({ title: "저장됨", message: e.path }).catch(function () {});
  },
});
```

| 이름               | 언제                                              | 추가 권한    |
| ------------------ | ------------------------------------------------- | ------------ |
| `note:opened`      | 그 창의 플러그인 스냅샷이 붙어 관측이 가능해질 때 | `notes:read` |
| `note:saved`       | 본문이 **파일에 실제로 들어간 뒤**                | `notes:read` |
| `note:focused`     | 창이 포커스를 얻을 때                             | `notes:read` |
| `note:blurred`     | 창이 포커스를 잃을 때                             | `notes:read` |
| `note:closed`      | 창이 닫힐 때(재빌드 리로드는 제외)                | `notes:read` |
| `settings:changed` | 이 플러그인의 설정 값 1건이 저장될 때             | 없음         |

`events.on`의 바닥 권한은 `settings`(저위험)이고, `note:*`는 그 위에 `notes:read`(민감)를 **더**
요구한다 — 자기 설정 변경만 듣고 싶은 플러그인이 노트 읽기 승인을 요구하지 않게 한 것이다.

- **구독 해제(`off`)는 없다.** 샌드박스는 설정 변경 재빌드마다 통째로 다시 서고 구독도 그때
  전부 새로 만들어진다 — 해제할 대상이 남지 않는다. 조건부로 무시하고 싶으면 핸들러 안에서
  걸러라.
- **키 입력마다 나는 텍스트 변경 이벤트는 없고 앞으로도 없다.** 목록에 없는 이름을 추측하지 마라.
- `settings:changed`는 `key`·`oldValue`·`newValue`·`origin`(`"form"`=사용자, `"plugin"`=코드)을
  싣는다. **자기가 쓴 값에도 이벤트가 온다** — 핸들러에서 다시 쓰면 무한 루프이므로 `origin`으로
  걸러라. 값은 `newValue`를 써라: 폼에서 바뀐 경우 뒤따르는 재빌드 전까지 `settings.get`은 아직
  옛 값을 줄 수 있다.

> 이 이벤트는 **통지일 뿐 재빌드를 대체하지 않는다.** 설정이 바뀌면 지금도 전체 재빌드가
> 일어난다 — `settings:changed`는 그 전에 정리할 시간을 주는 신호다. 재빌드가 노트 창에
> 무엇을 하는지는 바로 아래 절.

#### 재빌드 — 저작자가 기대할 수 있는 것

설정 값 저장·플러그인 토글·설치·제거는 전부 **중앙 호스트 재빌드**로 수렴한다. 재빌드는
모든 샌드박스를 `dispose`하고 처음부터 다시 실행한다 — 플러그인 런타임 상태는 언제나
초기값으로 돌아가고, 등록·구독도 그때 전부 새로 만들어진다(그래서 `events.off`가 없다).
`memo.storage`의 `local`·`session`은 재빌드를 넘어 살아남는다(위 「storage」 절의 표).

**열려 있는 노트 창은 더 이상 함께 리로드되지 않는 것이 기본이다.** 창은 새 스냅샷을 예전
것과 비교해 바뀐 표면만 제자리에서 맞춘다:

- 툴바 버튼·상태 아이템·명령·컨텍스트 메뉴 항목 (키 단위 증분 패치)
- CM 확장 — 인라인 패턴·자동완성·블록 임베드·선택 액션과 플러그인 CSS
- 능력 — 테마·배경·폰트·창 컨트롤
- 사용자 설정 — 색 오버라이드·기본 글자 크기·글꼴·키맵

저작자 입장에서 이것이 바꿔 놓는 것 하나: **`note:opened`가 재빌드마다 다시 온다.** 창이
계속 열려 있어도 저쪽 샌드박스는 새 인스턴스이므로, 창이 그 인스턴스에 "이 노트가 열려
있다"를 다시 알려 주는 것이다(`note:closed`는 나지 않는다 — 창이 닫힌 적이 없다). 상태
아이템의 첫 값 채우기가 정확히 이 계약에 기대고 있다. 핸들러는 **여러 번 불릴 수 있다**는
전제로 쓰라(같은 노트에 대해 멱등하게).

노트 창이 여전히 통째로 리로드되는 경우는 남아 있다: 언어·언어팩 변경, 「설정 › 외형 › 툴바
배치」 변경, 저장 폴더 이동, 백업 복원·설정 초기화·전체 삭제, 그리고 **아무 표면도 등록하지
않는 플러그인**(언어팩이 그 모양이다)의 설치·삭제. 리로드되면 그 창의 스크롤·선택·IME 조합이
사라진다. 판정 규칙 자체는 앱 쪽 문서
([`docs/contributing/architecture.md`](../contributing/architecture.md))에 있다.

### commands (`commands`) — 버튼 없는 명령

툴바 자리를 차지하지 않는 동작이다. **노출 지점은 「설정 › 단축키 › 플러그인 동작」**(사용자가
키를 배정한다) · 에디터 우클릭 메뉴(커뮤니티/사이드로드 플러그인만 — 빌트인은 툴바 버튼과
중복이라 빠진다) · 매니페스트 설정 버튼(`type: "button"`) 셋이다.

```js
memo.commands.register({
  id: "upper", // 생략하면 호스트가 만든다. 같은 id로 다시 등록하면 치환(upsert)
  title: "선택 대문자로", // 단축키 화면에 보일 이름 — 필수
  when: ["!note.isEmpty"], // 선택 — 아래 `when` 절
  destructive: true, // 선택 — 실행 **전에** 그 창에 확인 팝업을 띄운다
  // 첫 인자는 이 실행에 바인딩된 memo(창-스코프 호출은 이것으로 하라).
  run: function (memo) {
    memo.ui.toast({ title: "실행" }).catch(function () {});
  },
});
```

- `title`·`run`이 없으면 `INVALID_ARGS`로 **거부**된다(단축키 화면에도 나타나지 않는다).
- 명령은 권한 우회로가 아니다 — 등록만 `commands`(저위험)이고, `run` 안에서 부르는 호출은 각자
  자기 권한 게이트를 그대로 탄다.
- 명령 팔레트(⌘K)는 아직 없다. 지금은 단축키·메뉴·설정 버튼이 전부다.

### 플러그인 간 호출 (`invoke:<대상>`) — `commands.invoke` (**실험적**)

한 플러그인이 **다른 플러그인이 공개한 명령**을 부른다. 호출은 **양쪽 동의**로만 성립한다:

1. **대상**은 매니페스트 `exposes`에 공개할 명령 id를 적는다(기본은 비공개 — 여기 없으면 못 부른다).
2. **호출측**은 `invoke:<대상 id>` 권한을 선언하고(민감 — `network:<도메인>`과 같은 접두 권한)
   사용자 승인을 받는다.

```json
// 대상(copy-ai-prompt)의 manifest.json
{ "permissions": ["commands"], "exposes": ["copy"] }
```

```js
// 대상: 공개한 id로 명령을 등록한다. run의 둘째 인자로 호출측이 보낸 args가 온다.
memo.commands.register({
  id: "copy",
  title: "AI 프롬프트 복사",
  run: function (memo, args) {
    memo.ui
      .toast({ title: "복사: " + (args && args.note) })
      .catch(function () {});
  },
});
```

```js
// 호출측의 manifest.json: { "permissions": ["invoke:copy-ai-prompt"] }
// 호출측 코드:
memo.commands
  .invoke({
    pluginId: "copy-ai-prompt",
    commandId: "copy",
    args: { note: "id-1" },
  })
  .catch(function () {});
```

- 두 플러그인은 **직접 통신하지 않는다** — 중앙 호스트가 중계한다. 대상의 `when`·`destructive`
  선언이 그대로 걸린다(단축키로 실행할 때와 같은 경로).
- **반환값은 없다(항상 `null`).** 명령의 `run`은 반환이 없으므로 돌려줄 결과 자체가 없다 —
  invoke는 대상 명령을 **디스패치**하고 끝난다. 대상이 한 일은 대상이 낸 효과(토스트·노트 쓰기
  등)로 확인한다.
- 실패는 각각 구분되는 코드로 온다: 대상 미실행·미등록 명령은 `INVOKE_NO_TARGET`, 공개 안 된
  명령은 `INVOKE_NOT_EXPOSED`, 자격 없음은 `PERMISSION_UNDECLARED`/`PERMISSION_UNGRANTED`,
  순환(A→B→A)은 `INVOKE_CYCLE`.
- 대상을 부를 때는 받은 **바인딩된 memo**를 쓰라 — 순환 방어의 깊이 추적이 그 토큰을 따라간다.
- **실험적 API다.** 실행하면 「설정 › 플러그인 › 최근 오류」에 경고가 남고, 다음 버전에서
  인자·반환·의미가 바뀔 수 있다.

### storage (`storage`) — 플러그인 전용 저장소

설정 폼에 노출되지 않는, **그 플러그인 자신의 데이터**를 담는다.

```js
await memo.storage.set({ key: "draft", value: { at: Date.now() } }); // 기본 scope: "local"
const v = await memo.storage.get({ key: "draft" }); // 없으면 null
await memo.storage.remove({ key: "draft" });
const all = await memo.storage.getAll({ scope: "session" }); // { key: value, … }
```

| `scope`       | 사는 곳                   | 사라지는 때                                |
| ------------- | ------------------------- | ------------------------------------------ |
| `local`(기본) | 디스크(플러그인별 파일)   | 사용자가 지울 때까지 — **재빌드에도 생존** |
| `session`     | 호스트 프로세스 메모리    | 앱을 끌 때(재빌드에는 생존)                |
| `window`      | 창 토큰으로 격리된 메모리 | 그 창을 다시 안 볼 때                      |

고르는 법: **사용자가 폼에서 고칠 값이면 `settings`**(매니페스트 스키마), 다음 실행에도 있어야
하면 `local`, 다시 계산할 수 있는 캐시면 `session`, 이 창에서만 뜻이 있는 상태면 `window`.

- `window` 스코프는 **창 컨텍스트가 필요하다** — 없으면 오류가 아니라 조용한 `null`
  (`getAll`이면 `{}`)이고 진단에 이유가 남는다. 다른 창-스코프 호출과 같은 계약이다.
- `window`의 폐기 시점은 정확히 「창이 닫힐 때」가 **아니다**(호스트가 창 닫힘을 통지받는 경로가
  없다). 실제로는 오래 안 쓴 창의 서랍부터 상한에 걸려 버려진다 — 닫히면 반드시 지워져야 하는
  값을 여기 두지 마라.
- 번들 플러그인과 설치 플러그인은 같은 id를 써도 파일이 겹치지 않는다.
- 플러그인을 제거하면 그 `local` 저장소도 함께 지워진다.

### `memo.runtime.onDispose` — 죽기 직전의 정리

설정 변경 한 번에 전 샌드박스가 파괴되고 런타임 상태가 통째로 사라진다. 그 순간을 알려 준다.

```js
memo.runtime.onDispose({
  handler: function (memo) {
    // 반환한 Promise를 호스트가 기다린다 — 다만 상한이 **300ms**다.
    return memo.storage.set({ key: "draft", value: draft });
  },
});
```

- 권한이 필요 없고 브리지로 나가지도 않는다(핸들러는 샌드박스 로컬에 남는다).
- **동기적으로 끝나는 정리만 사실상 보장된다.** 300ms를 넘기면 호스트는 진단만 남기고 파괴를
  강행한다. 지켜야 할 값은 그때그때 저장하고 마지막 flush만 여기 넣어라.
- **앱 종료 시점은 보장하지 않는다**(재빌드 경로에서만 확실히 불린다).

### `when` — 조건부 명령

`commands.register`의 `when`은 **닫힌 키 배열의 AND**다. 표현식 언어가 아니다 — `&&`·`||`·괄호·
정규식은 쓸 수 없고, 앞에 `!`를 붙인 부정만 추가로 허용한다. **목록 밖 키는 등록 시점에
`INVALID_ARGS`로 거부된다**(지어낸 키가 조용히 무시되지 않는다).

| 키                    | 참일 때                                                        |
| --------------------- | -------------------------------------------------------------- |
| `note.isEmpty`        | 대상 노트 본문이 비어 있다(공백만 있어도 빈 것)                |
| `platform.macos`      | 지금 OS가 macOS(`platform.windows`·`platform.linux`도 같은 꼴) |
| `plugin.<id>.enabled` | 그 id의 플러그인이 이번 빌드에서 켜져 있다                     |
| `settings.<key>`      | **자기 매니페스트에 선언한** 설정 키가 참(빈 문자열은 거짓)    |

```js
when: ["!note.isEmpty", "platform.macos", "settings.advanced"];
```

- 판정은 호스트에서만 일어나고 **결과는 플러그인에게 돌려주지 않는다** — 조건이 거짓이면 명령이
  그냥 실행되지 않고 그 사실만 진단에 남는다.
- `note.isEmpty`는 **메모 창에 물어봐야** 판정된다. 그래서 설정 화면 액션 버튼으로 들어온 실행
  (창 컨텍스트 없음)은 `note.isEmpty`가 붙어 있을 때만 거부되고 이유가 진단에 남는다 — 정적
  키(`platform.*`·`plugin.<id>.enabled`·`settings.<key>`)만 있는 `when`은 설정 버튼에서도
  그대로 판정된다.
- `note.hasSelection`은 **아직 없다** — 선택 영역을 읽는 경로는 있지만(`notes.current`의
  `selection`) `when` 판정부가 아직 그 값을 보지 않아, 키만 열면 언제나 참이 된다.

### 선택 영역 읽기

`memo.notes.current()`가 본문과 **같은 왕복으로** 지금 선택 영역을 함께 준다(`notes:read`).
전용 호출(`editor.getSelection`)은 만들지 않았다 — 같은 데이터에 권한 경로를 둘로 만들지 않기
위해서다.

```js
const note = await memo.notes.current();
if (note !== null && !note.selection.empty) {
  // mode 기본값이 "cursor"이고, 그것이 곧 "선택 영역 치환"이다 (+ notes:write).
  await memo.editor.insertText({ text: note.selection.text.toUpperCase() });
}
// note.selection === { text, from, to, empty, ranges, composing }
```

| 필드        | 뜻                                                                        |
| ----------- | ------------------------------------------------------------------------- |
| `text`      | 주 선택의 텍스트(빈 선택이면 `""`)                                        |
| `from` `to` | 주 선택의 문서 문자 오프셋(빈 선택이면 같다 = 커서 위치)                  |
| `empty`     | 커서만 있는지                                                             |
| `ranges`    | 선택 범위 개수(다중 커서면 2 이상). **0이면 선택을 읽지 못했다는 뜻**이다 |
| `composing` | IME 조합(한글 등) 중인지 — true일 때 되쓰면 조합이 깨진다                 |

**되쓰기에 오프셋 API는 없다.** `from`/`to`는 참고값이고, 실제 치환은
`editor.insertText({ mode: "cursor" })` 하나로만 간다 — 오프셋 경합은 CodeMirror 트랜잭션이
흡수한다. 비동기 작업 뒤에 `from`/`to`를 다시 써서 편집하려 들면 그 사이 사용자의 타이핑과
어긋난다. (`mode: "replace"`는 **문서 전체**를 덮어쓴다 — 선택 교체가 아니다.)

---

## 매니페스트 선언형 기여 — `contributes`

JS 없이 **매니페스트만으로** 하는 등록이다.

```jsonc
{
  "id": "my-plugin",
  "entry": "main.js",
  "permissions": ["editor"], // 선언형이어도 권한은 그대로 필요하다
  "contributes": {
    "inlinePatterns": [
      {
        "id": "hl",
        "open": "==",
        "close": "==",
        "style": { "fontWeight": "700" },
      },
    ],
    "completions": [{ "id": "wiki", "trigger": "[[", "wrap": "[[%]]" }],
    "blockEmbeds": [/* editor.registerBlockEmbed의 인자와 동일 */],
    "windowControls": ["transparency"], // window.register({controls}) — window-control + kind:"capability"
  },
}
```

| 종류             | 대응 호출                      | 필요 권한                               |
| ---------------- | ------------------------------ | --------------------------------------- |
| `inlinePatterns` | `editor.registerInlinePattern` | `editor`                                |
| `completions`    | `editor.registerCompletion`    | `editor`                                |
| `blockEmbeds`    | `editor.registerBlockEmbed`    | `editor`(+ 렌더 시 `embed:<도메인>`)    |
| `windowControls` | `window.register`의 `controls` | `window-control` + `kind: "capability"` |
| `translations`   | **없음**(코어가 직접 읽는다)   | `i18n` + `kind: "capability"`           |

위 넷은 **대응 호출의 인자와 필드가 완전히 같다**. `translations`만 성격이 다르므로 아래에서
따로 설명한다.

- 호스트는 `main.js` 실행이 끝난 뒤 **같은 게이트키퍼·같은 검증기**로 이 데이터를 등록한다.
  권한이 없으면 선언형도 똑같이 거부된다.
- 같은 id가 매니페스트와 `main.js` 양쪽에 있으면 **매니페스트가 이긴다**(정적 검증을 통과한 쪽이
  정본). 대체된 사실은 진단 채널에 남는다.
- 기여가 전부 여기 있고 `entry` 파일이 비어 있으면 호스트는 **샌드박스를 아예 띄우지 않는다**
  (부팅 비용 0 · JS 타이밍 실패 모드 0).
- 모르는 종류(오타 포함)는 매니페스트를 거부하지 않고 무시하되 진단과
  `npm run plugin -- validate <폴더>`가 표면화한다.
- **제외된 것과 이유**: `background`(FirstWins)·`font`(스택 선착순)는 병합이 등록 **순서**에
  의존하고, 툴바 버튼·명령은 핸들러 함수가 필요해 JSON으로 표현할 수 없다.

### 언어팩 — `contributes.translations`

앱 화면 문구(`src/i18n/ko.json`의 키)를 다른 언어로 제공한다. **선언이 유일한 계약이다 —
대응하는 런타임 등록 API는 없다.** 언어팩의 실체는 코드가 아니라 사전 데이터라, 코어가
설치 매니페스트를 직접 읽어 각 창에 공급한다(플러그인 샌드박스도 호스트도 경로에 없다 —
그래서 첫 화면이 그려지기 전에 이미 그 언어로 뜬다).

```jsonc
{
  "id": "language-pack-fr",
  "entry": "main.js", // 비워 두라 — 실행할 코드가 없다
  "kind": "capability",
  "permissions": ["i18n"],
  "contributes": {
    "translations": [
      {
        "locale": "fr", // BCP47 소문자 단순형(fr · pt-br). 대문자·언더스코어는 거부
        "label": "Français", // 언어 드롭다운에 그대로 보일 이름
        "entries": { "panel.search.placeholder": "Rechercher" },
      },
    ],
  },
}
```

- **수집 조건은 넷이다**(하나라도 어긋나면 **오류 없이 그냥 수집되지 않는다** — 반드시
  `npm run plugin -- lint <폴더>`로 미리 확인하라): 플러그인이 켜져 있을 것 · 현재 OS를
  지원할 것(`platforms`) · `kind: "capability"` · `i18n` 권한 선언.
- `entries`는 키→문장 평탄 맵, 직렬화 **256KB** 이내. 값이 문자열이 아닌 키는 그 키만 버려진다.
- **콘텐츠 검증은 소비 시점**이다: 각 창이 기준 언어(ko) 사전과 대조해, ko에 없는 키와
  `{플레이스홀더}` 집합이 다른 문장은 **그 키만** 조용히 버린다 — 한 문장의 실수가 팩 전체를
  죽이지 않는다. 항목(`translations[]`의 한 원소) 하나가 형식을 어겨도 그 항목만 건너뛴다.
- **덮어쓸 수 없는 코드**: `ko`(기준 언어)와, 앱에 내장돼 **켜져 있는** 언어팩의 코드(예: `en`).
  사용자가 내장 팩을 끄면 그 코드는 풀리므로 커뮤니티 팩이 대신 채울 수 있다.
- 같은 코드를 여러 팩이 공급하면 플러그인 id 사전순으로 **뒤가 앞을 키 단위로 덮는다**(LastWins).
- 키 목록의 정본은 앱 저장소의 `src/i18n/ko.json`이고, 살아 있는 예제는
  `docs/plugin/examples/language-pack-en/`이다.

---

## 인라인 패턴 — 모양과 클릭 동작

패턴은 **두 토막**(`open`…`close`)이 기본이고, `mid`를 주면 **세 토막**(`open`…`mid`…`close`)이 되어 캡처가 둘 생긴다. `[텍스트](url)`처럼 **보여 줄 글자와 클릭 대상이 다른 토막에 있는** 모양이 이렇게 표현된다.

| 필드     | 뜻                                                                  |
| -------- | ------------------------------------------------------------------- |
| `mid`    | 중간 구분자(선택). 주면 세 토막이 된다.                             |
| `label`  | 화면에 남길 토막(`"first"` 기본). 나머지는 구분자와 함께 숨는다.    |
| `target` | 클릭 대상 토막(세 토막이면 `"second"` 기본, 두 토막이면 `"first"`). |
| `action` | 클릭 동작(`"open-note"` 기본 · `"open-url"` · `"none"`).            |

**동작마다 권한이 다르다.** `"open-note"`는 `notes:read` + `windows`(대상 토막을 제목으로 하는 노트를 연다 — 위키링크), `"open-url"`은 `browser:open`(시스템 기본 브라우저로 연다), `"none"`은 권한 없이 스타일만 입힌다.

> **권한이 없으면 그 패턴의 동작은 조용히 `"none"`이 된다** — 등록은 성공하고 스타일도 붙지만, 링크 표식(손 모양 커서·클릭)이 달리지 않는다. 눌러도 아무 일이 없는 가짜 링크를 만들지 않기 위해서다. 「스타일은 나오는데 클릭이 안 된다」면 먼저 권한 부여를 확인하라.

구분자는 **비어있지 않은 8자 이하** 문자열이고 줄바꿈을 담을 수 없다. 어기면 `INVALID_ARGS`로 등록이 거부된다 — 어느 필드가 왜인지가 오류 문구와 진단에 남는다. `label`/`target`에 `"second"`를 쓰면서 `mid`를 주지 않는 것도 같은 거부 대상이다.

**패턴 안의 패턴도 그려진다(중첩).** 채택된 매치가 화면에 남기는 토막(`label`) 안에 **완전히 들어가는** 다른 매치는 버려지지 않고 함께 렌더된다 — `{{[[제목]]을 보라\|#3a5}}`의 위키링크는 색을 입은 채로 클릭도 된다(안쪽 구분자도 함께 숨는다). 겹침 해소 규칙 자체는 그대로다: 같은 자리에서 시작하면 더 구체적인 패턴이 이기고, **부분만 겹치는**(안에서 시작해 밖에서 닫히는) 매치는 여전히 버려진다. 중첩은 톱레벨 아래로 두 겹까지 판다.

> `open: "["`, `mid: "]("`, `close: ")"`로 마크다운 링크 모양을 그대로 등록할 수도 있지만, **본문 마크다운 링크는 코어 라이브 프리뷰가 이미 렌더한다**(구문 트리 기반이라 코드펜스 안·`[[위키링크]]`를 정확히 가려낸다). 같은 구간을 둘이 함께 꾸미면 어느 쪽이 클릭을 받는지 예측하기 어려우니, 플러그인은 자기만의 구분자를 쓰는 편이 낫다.

---

## 인라인 패턴 스타일

`registerInlinePattern`의 `style`/`styleHover`는 **구조화 화이트리스트**다 — raw CSS 문자열이나 셀렉터를 주지 못한다. 호스트가 값을 검증하고 `.cm-x-<plugin>-<pattern>` 규칙으로 노트 창에 주입한다.

**색-값 속성**(`color`·`backgroundColor`·`borderColor`)은 안전한 리터럴(hex, 숫자 `rgb()/rgba()`) 또는 **의미 토큰**을 받는다. 토큰은 호스트가 앱 변수로 해석해, 테마·배경 대비를 따라가게 한다:

| 토큰                                | 해석                       |
| ----------------------------------- | -------------------------- |
| `accent` / `danger`                 | 활성 테마 강조/삭제색      |
| `contrast`                          | 배경 밝기 대비색(불투명)   |
| `contrast-border` / `contrast-fill` | 대비색 저투명(테두리/채움) |

**허용 속성**(camelCase): `color` · `backgroundColor` · `borderColor` · `borderWidth` · `borderStyle` · `borderRadius` · `padding` · `textDecoration` · `textUnderlineOffset` · `verticalAlign` · `fontSize` · `fontWeight` · `fontStyle` · `fontFamily` · `filter`(`none`·`blur()`) · `transition` · `cursor` · `opacity`.

화이트리스트 밖 속성, `url()`·`expression`·원문 `var()` 등은 조용히 버려진다. 예제는 [`kbd`](../../src/plugin/builtin/plugins/kbd/main.js)(대비 토큰) · [`wikilink`](../../src/plugin/builtin/plugins/wikilink/main.js)(테마 강조색).

---

## 보안 모델 — 못 하는 것

- **앱에 직접 못 닿음** — 불투명 origin iframe이라 노트 DOM·앱 데이터·파일에 접근할 수 없다. 앱 확장은 `memo.*` 구조화 호출로만.
- **셀렉터를 못 정함** — 스타일은 자기 데코레이션에만 적용(앱/CodeMirror 클래스 하이재킹 불가).
- **미선언·미부여 호출 차단** — 게이트키퍼가 모든 호출을 검사, 통과할 때만 실행.
- **정규식을 못 줌** — 인라인 패턴은 구분자(open/close)만, 호스트가 리터럴로 이스케이프(ReDoS 차단).
- **임베드 도메인 게이트** — 블록 임베드는 최종 URL 도메인이 `embed:<도메인>` 부여와 일치할 때만 렌더.

자세한 근거는 [`README.md`](../README.md)의 "플러그인 보안" 절 참고.

---

## 도구 — CLI 워크플로(scaffold·types·하니스·개발자 모드)

`memo-plugin` CLI(`src/cli/memo-plugin/`)는 앱을 띄우지 않고 플러그인을 만들고·타입을 붙이고·실행해 보고·검사하는 명령 6개를 묶는다. 전부 저장소 안의 실제 검증기·실행기를 그대로 재사용한다(CLI가 규칙을 따로 베끼지 않는다) — 그래서 여기를 통과하면 앱에서도 같은 결과가 나온다는 보장이 있다.

```
memo-plugin scaffold <id> [옵션]   동작하는 뼈대를 새로 만든다
memo-plugin types <dir>            plugin-api.d.ts·settings.d.ts를 동봉/갱신한다
memo-plugin run <dir> [옵션]        앱 없이 로드해 등록 결과를 덤프한다
memo-plugin test <dir> --click|--command|--event <값> [옵션]
                                    로드 후 클릭/명령/이벤트 하나를 발화시켜 호출 시퀀스를 덤프한다
memo-plugin validate <dir>         매니페스트 구조 검증
memo-plugin lint <dir>             정적 저작 실수 검사(존재하지 않는 호출·미선언 권한 등)
```

`--json`을 쓰면 사람용 텍스트 대신 기계가 파싱할 JSON을 낸다(AI 에이전트·CI용). `npm run` 경유로 파싱할 때는 npm의 실행 배너가 stdout 앞에 섞이므로 `npm run plugin --silent -- …`를 쓰거나, 배너 자체를 피하려면 `node src/cli/memo-plugin/cli.ts …`로 직접 실행한다. 전체 옵션은 `npm run plugin -- --help`.

아래는 저작자의 실제 작업 순서다.

### 1. `scaffold` — 뼈대로 시작한다

```
$ npm run plugin -- scaffold demo-plugin --template=settings-driven
✓ scaffold ./demo-plugin — 문제 없음
생성됨(./demo-plugin):
  - manifest.json
  - main.js
  - README.md
  - plugin-api.d.ts
  - plugin-manifest.schema.json
  - settings.d.ts
  - main.js(참조 주석 추가)
```

템플릿은 4종(`inline-pattern`·`toolbar-button`·`settings-driven`·`command`) — 위 "어디서 시작하나" 절의 정본 예제와 같은 골격을 낸다(등록 → `runtime.ready()` → `.catch`). `$schema`·`kind`를 자동으로 채우고, 기본으로 타입까지 동봉한다(`--no-types`로 끌 수 있음). 설정 스키마가 있는 `settings-driven` 템플릿은 위처럼 `settings.d.ts`도 함께 낸다(다른 템플릿은 설정이 없어 내지 않는다). `minHostVersion`은 **채우지 않는다** — 출시 전이라 사용자 대면 버전 정책이 아직 없고, 참조할 기준(앱 버전)이 흔들리기 때문이다. **생성 직후 스스로 `lint`를 돌려 결과를 함께 보고한다** — 방금 본 "문제 없음"이 그 자기검증의 결과다. 오류가 나면 그건 템플릿 자체의 버그다(저작자 코드가 아직 없으니까).

### 2. 코드를 쓴다 — `types`로 자동완성을 받는다

`scaffold`가 이미 `plugin-api.d.ts`(전체 `memo.*` 계약)와 `main.js` 첫 줄의 `/// <reference path="./plugin-api.d.ts" />`를 넣어 뒀으므로, VS Code 등 TS 언어 서버가 붙는 편집기라면 이 시점부터 `memo.` 뒤에서 자동완성·오타 검출이 된다.

`settings-driven` 템플릿은 설정 스키마(`manifest.json`의 `settings[]`)가 있으므로 `scaffold`가 `settings.d.ts`도 함께 냈다(위 생성 목록). 매니페스트의 `greeting`(text)·`style`(select)에서 유도한 타입이다:

```ts
// settings.d.ts (생성됨 — 손으로 고치지 마라)
export interface PluginSettings {
  /** 인사말 — 버튼을 누르면 이 문구를 보여줍니다. */
  greeting: string;
  /** 말투 */
  style: "formal" | "casual";
}
export type PluginSettingKey = keyof PluginSettings;
```

타입 유도 규칙: `text`/`textarea` → `string`, `toggle` → `boolean`, `number` → `number`, `list` → `{ name, body }[]`, `select` → `options[].value`의 유니온 리터럴(라벨이 아니다). `memo.settings.getAll()`은 모든 플러그인 공통이라 `Record<string, unknown>`을 돌려준다 — `unknown`을 한 번 거쳐 이 플러그인의 설정 타입으로 좁힌다(생성된 `settings.d.ts` 헤더에 그대로 베낄 스니펫이 들어 있다):

```js
memo.settings.getAll().then(function (cfg) {
  // getAll()은 Record<string, unknown>을 주므로 unknown을 거쳐 이 플러그인 설정 타입으로 좁힌다.
  var s = /** @type {import("./settings.d.ts").PluginSettings} */ (
    /** @type {unknown} */ (cfg)
  );
  // 이제 s.greeting·s.style은 타입이 잡혀 편집기가 오타(cfg.greetng)·리터럴 오타("casaul")를 잡는다.
});
```

`Record<string, unknown>`은 좁힌 타입에 그냥 대입되지 않으므로(`unknown`을 거치는 이중 캐스트가 필요하다 — tsc도 그렇게 안내한다) 위 형태가 checkJs에서 실제로 컴파일되는 유일한 형태다. **매니페스트와 코드 두 파일의 설정 키를 손으로 맞추지 않아도 된다** — 오타는 여기서 편집기가 잡는다(전에는 런타임에서 조용히 `null`이 왔다).

매니페스트 설정 스키마를 바꾼 뒤에는 `types`를 다시 돌려 `settings.d.ts`를 갱신한다. 까먹어도 `validate`가 "생성물이 지금 스키마와 다르다"를 `SETTINGS_DTS_STALE` 경고로 알려준다(2번째 항목 참고).

### 3. 하니스로 테스트한다 — 앱 없이 `run`/`test`

`run`은 매니페스트+코드를 헤드리스 하니스(`src/plugin/test-host.ts`)로 로드해 실제 권한 게이트키퍼·등록 수집기를 태운 뒤 결과를 덤프한다 — **신규 실행 엔진이 아니라 1st-party 테스트가 쓰는 것과 같은 코드**를 CLI 표면으로 노출한 것이다.

```
$ npm run plugin -- run ./demo-plugin
✓ run ./demo-plugin — 문제 없음
등록: 버튼 1개 · 패턴 0개 · 자동완성 0개 · 임베드 0개 · 명령 0개 · 구독 0개
능력: 테마 없음 · 배경 없음 · 폰트 없음 · 창 컨트롤 0개
runtime.ready 호출됨: 예
호출 2건 · 거부 0건 · 진단 0건 · 예외 0건
```

`test`는 여기에 더해 클릭/명령/이벤트를 발화시켜 그 호출 시퀀스를 보여준다:

```
$ npm run plugin -- test ./demo-plugin --click=show-path
발화: click(show-path)
  이 발화가 낸 호출 2건:
    - notes.current 성공
    - ui.toast 성공
```

옵션:

| 플래그                          | 뜻                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--settings=<경로>`             | 저장된(디스크) 설정 값 JSON 파일(생략하면 매니페스트 기본값)                                                                 |
| `--granted=<a,b>`               | 승인 권한 재정의(생략하면 매니페스트 선언 권한 전부 승인) — 권한 거부 경로를 일부러 테스트할 때 씀                           |
| `--stub=<경로>`                 | 창-스코프·호스트 호출 응답 JSON(예: `{"notes.current": {"id":"n1","path":"/a.md"}}`) — 실제 노트 창이 없으니 응답을 주입한다 |
| `--payload=<JSON>`              | `test` 전용 — 역호출에 실어 보낼 payload                                                                                     |
| `--click`/`--command`/`--event` | `test` 전용, 셋 중 정확히 하나 — 각각 버튼 클릭·명령 실행·이벤트 발화를 시뮬레이션                                           |

`--granted`를 좁히면 실행 의미론이 그대로 재현된다 — 예를 들어 이벤트 구독에 필요한 권한을 빼면 그 등록이 거부되고 `runtime.ready 호출됨: 아니오`까지 정확히 나온다(`.then` 체인이 그 지점에서 `.catch`로 빠지므로). **무엇을 검사 못 하나(정직한 경계)**: 하니스는 단일 창 컨텍스트를 모델링한다 — iframe·postMessage·CSP 격리 자체와 "A 창에서 눌렀는데 B 창에 삽입" 같은 다중 창 토큰 라우팅은 범위 밖이다(그건 e2e가 지킨다).

### 4. 개발자 모드로 실앱에서 확인한다

하니스가 못 잡는 것(실제 렌더, 다른 플러그인과의 상호작용)은 결국 앱에서 봐야 한다. 그런데 코드 변경은 **전체 재빌드**를 태운다 — 번들·설치 플러그인의 샌드박스가 전부 다시 실행된다. **개발자 모드**는 이 비용을 없앤다: 지금 편집 중인 플러그인 **하나만** 다시 실행한다.

1. 플러그인을 **로컬 폴더로** 사이드로드한다(설정 › 플러그인 › 추가 › 폴더에서 설치). 개발자 모드는 원본 폴더가 이 기기에 있는 로컬 사이드로드에만 적용된다(URL/Git 설치는 원본이 없다).
2. 설정 › 플러그인에서 그 플러그인 상세를 열면 "개발자 모드" 섹션에 **폴더에서 로드(핫리로드)** 토글이 있다. 켠다.
3. `main.js`/`manifest.json`/스타일을 저장할 때마다 **이 플러그인의 샌드박스 하나만** 다시 실행되고, 열려 있는 노트 창들은 이 플러그인의 CM 확장과 툴바 항목(버튼·상태 아이템·명령·메뉴 항목)만 제자리에서 다시 맞춘다(전체 `location.reload()` 없음 — 스크롤·선택·IME 조합·다른 플러그인 상태가 그대로 유지된다).
4. 구독 집합이 바뀌거나 테마/배경/폰트/창 컨트롤처럼 **등록 순서에 의존하는 병합**이 걸리면 단일 핫리로드 경로를 쓸 수 없어, 호스트가 일반 재빌드 방송으로 폴백한다(설정 › 플러그인 › 「최근 오류」에 사유가 남는다). 그때도 노트 창은 새 스냅샷을 보고 리로드할지 제자리에서 조정할지 스스로 가르므로, 폴백이 곧 리로드는 아니다(위 「재빌드」 절). 버튼·명령·상태 아이템·메뉴 항목을 고치는 것은 애초에 폴백 사유가 아니다 — 노트 창이 그 넷을 키로 diff해 제자리에서 맞춘다.
5. 개발자 모드는 **세션 한정**이다 — 앱을 재시작하면 자동으로 꺼진다(프로덕션에 남지 않는다). 한 번에 하나의 플러그인만 감시할 수 있고, 다른 플러그인으로 켜면 이전 감시가 자동으로 대체된다.

### 5. `validate`/`lint`로 마무리 확인

```
$ npm run plugin -- validate ./demo-plugin
✓ validate ./demo-plugin — 문제 없음
$ npm run plugin -- lint ./demo-plugin
✓ lint ./demo-plugin — 문제 없음
```

`validate`는 매니페스트 구조(JSON Schema와 동형)·entry 실존·id/폴더명 일치, 그리고 **생성물 신선도**(`settings.d.ts`·`plugin-api.d.ts`가 지금의 매니페스트/저장소 계약과 다르면 `SETTINGS_DTS_STALE`/`PLUGIN_API_DTS_STALE` 경고)를 검사한다. `lint`는 존재하지 않는 호출·미선언 권한·`.catch` 누락·중복 등록 id 같은 정적 저작 실수를 잡는다 — 둘 다 실행 의미론(등록 마감 타이밍·창 컨텍스트 전파)은 재현하지 않는다(그건 3단계의 `run`/`test`가 한다).

### 6. 설치

여기까지 통과했으면 다음 절 "설치"로 사이드로드하거나 배포한다.

---

## 설치

설정 창의 "플러그인" 탭에서 설치한다:

- **URL/Git** — `https://` 저장소 URL. `#태그` 또는 `#커밋`으로 버전을 핀할 수 있다.
- **Zip** — `.zip`으로 끝나는 `https://` URL.
- **로컬** — 로컬 폴더 선택.

민감 권한을 선언한 플러그인은 승인 프롬프트를 거친다. 업데이트로 새 민감 권한이 추가되면 재승인을 요구한다.
