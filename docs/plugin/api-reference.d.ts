// memo 플러그인 저작용 앰비언트 타입 선언 — `window.memo`가 노출하는 `memo.*` 브리지 API.
//
// **생성물이다. 손으로 고치지 마라.** 정본은 src/plugin/api-index.ts이고, 갱신은
//   MEMO_GEN_PLUGIN_API=1 npx vitest run src/plugin/api-index.test.ts
// 로 한다(생성물과 커밋본이 다르면 CI의 드리프트 가드가 실패한다).
//
// 역할: 외부 저작자가 자기 플러그인 폴더에 이 파일을 복사해 두고 `main.js` 맨 위에
// `/// <reference path="./plugin-api.d.ts" />`를 추가하면(TS 언어 서버가 붙는 편집기에서)
// `memo.*` 자동완성과 오타 검출을 받는다. 사용법은 docs/plugin/authoring.md의 "타입 선언" 절 참고.
//
// 왜: 샌드박스 부트스트랩의 `window.memo`는 이중 Proxy라 `memo.아무거나.아무거나(...)`가 전부
// 함수를 반환한다 — 존재하지 않는 호출(오타 등)도 그냥 호출되고, 브리지가 거부하면 조용히
// reject되는 Promise가 될 뿐이다(.catch가 없으면 로그조차 없다). 이 파일은 실제로 배선된
// 호출만 닫힌 타입으로 선언해, 오타를 런타임이 아니라 편집기가 즉시 잡게 한다.
//
// 이 파일은 이 저장소의 앱 빌드·정적분석에 편입되지 않는다(tsconfig.json은 "src"만 include,
// knip.json 프로젝트 글롭은 src/e2e만 본다) — docs/ 아래 저작자용 참고 자료다. 대신
// api-index.test.ts가 이 파일을 실제로 컴파일해 유효한 TypeScript임을 매 커밋 확인한다.
//
// 예약 호출(아직 실행 경로가 없는 것)은 **의도적으로 빠져 있다** — 넣으면 편집기가 "쓸 수 있는
// API"처럼 자동완성해 저작자를 오도한다. 전수 목록과 사유는 docs/plugin/api-reference.json을 보라.

/** `memo.ui.pickList`에 넘기는 선택지 하나. */
interface MemoPickListItem {
  id: string;
  label: string;
  /** 라벨 아래 회색 보조 정보(경로·요약 등). 텍스트로만 그려진다. */
  sublabel?: string;
  /** 이 항목에 붙는 액션들(삽입·복사·삭제 등). 생략하면 항목 자체가 액션
   *  `"select"` 하나다. **하나라도 선언하면 `pickList`의 반환이 객체로 넓어진다.**
   */
  actions?: MemoPickAction[];
}

/** `MemoPickListItem`에 붙는 액션 하나.
 *  **`id`가 빈 문자열이면 그 액션은 버려진다** — 빈 id를 돌려주면 플러그인의 분기가
 *  어느 액션인지 구분하지 못하고 조용히 첫 가지로 떨어진다.
 */
interface MemoPickAction {
  id: string;
  label: string;
  /** `destructive`면 빨간 강조(되돌릴 수 없는 동작). */
  style?: "default" | "destructive";
}

/** 액션을 쓴 `memo.ui.pickList`의 반환 — 어느 항목의 어느 액션을 골랐는가.
 *  액션을 선언하지 않은 항목을 고르면 `actionId`는 `"select"`다.
 */
interface MemoPickResult {
  itemId: string;
  actionId: string;
}

/** 토스트가 전하는 상태. `progress`만 자동으로 사라지지 않는다.
 *  **모르는 값은 오류가 아니라 `success`로 접힌다** — 상태를 지어내도 토스트는 뜬다.
 */
type MemoToastStyle = "success" | "failure" | "progress";

/** `memo.ui.toast`가 돌려주는 핸들 — 이 `id`를 다시 실어 부르면 같은 토스트를 갱신·닫는다.
 *  핸들이 함수가 아니라 문자열인 이유: 브리지는 postMessage라 함수를 나를 수 없다.
 */
interface MemoToast {
  id: string;
}

/** `memo.ui.updateStatusItem`가 돌려주는 핸들 — 갱신한 상태 아이템의 `id`.
 *  버튼과 달리 상태 아이템은 값이 바뀌므로(단어 수 등) 갱신 호출이 따로 있고, 그 반환이 이것이다.
 */
interface MemoStatusItem {
  id: string;
}

/** `memo.ui.prompt`의 폼 필드 타입 — 매니페스트 `settings`의 타입에서 `list`만 뺀 것이다
 *  (폼은 한 번의 입력이라 항목을 늘렸다 줄이는 위젯이 들어갈 자리가 아니다).
 */
type MemoFormFieldType = "text" | "textarea" | "toggle" | "select" | "number";

/** `memo.ui.prompt`의 `fields` 항목 — 매니페스트 `settings` 필드와 **같은 어휘**다
 *  (`list`만 폼에 없다). 호스트가 그리므로 선언만 하면 되고 DOM은 만지지 않는다.
 */
interface MemoFormField {
  /** 결과 맵의 키. **비어 있으면 그 필드는 버려진다.** */
  id: string;
  label: string;
  /** **목록 밖 타입은 조용히 접히지 않고 그 필드가 통째로 버려진다.** */
  type: MemoFormFieldType;
  placeholder?: string;
  /** 초기값(타입에 맞는 값 — toggle은 boolean, number는 수). */
  default?: unknown;
  /** `select` 전용. 문자열 축약형은 `{ value: s, label: s }`로 읽는다. */
  options?: MemoSelectOption[];
  min?: number;
  max?: number;
  step?: number;
}

/** `select` 선택지 하나 — 문자열 축약형은 `{ value: s, label: s }`의 줄임이다.
 *  매니페스트 `settings`의 `options`와 **같은 규칙**을 쓴다(어휘를 두 벌로 만들지 않는다).
 */
type MemoSelectOption = string | { value: string; label?: string };

/** 지금 에디터가 잡고 있는 선택 영역 — `memo.notes.current()`에 함께 실려 온다.
 *  **전용 호출을 따로 두지 않은 이유**: 선택 텍스트는 본문의 일부라 `notes.current`와
 *  같은 `notes:read` 게이트가 정확히 맞고, 같은 데이터에 권한 경로를 둘로 만들 이유가 없다.
 *  되쓰기는 `memo.editor.insertText({ text })`(기본 `mode: "cursor"`)로 한다 —
 *  오프셋을 받는 쓰기 API는 없다(그 사이 사용자가 타이핑한 경합을 호스트가 흡수한다).
 */
interface MemoSelection {
  /** 주 선택의 텍스트(빈 선택이면 `""`). */
  text: string;
  /** 주 선택의 시작 문서 문자 오프셋. */
  from: number;
  /** 주 선택의 끝 오프셋(빈 선택이면 `from`과 같다 = 커서 위치). */
  to: number;
  /** 빈 선택(커서만 있음)인지. */
  empty: boolean;
  /** 선택 범위 개수(다중 커서면 2 이상 — `text`/`from`/`to`는 **주 선택 하나**뿐이다).
   *  **0이면 선택을 읽지 못했다는 뜻**이고 나머지 필드는 기본값이다.
   */
  ranges: number;
  /** IME 조합(한글·일본어 등) 중인지. true일 때 되쓰면 조합이 깨지므로 미루는 편이 안전하다. */
  composing: boolean;
}

/** 등록 계열 호출의 반환 — 호스트가 확정한 등록 id(같은 id로 재등록하면 치환된다). */
interface MemoRegistration {
  id: string;
}

/** 인라인 패턴이 캡처한 토막의 이름 — 두 토막(`open`…`close`) 패턴에는 `"first"`뿐이고,
 *  `mid`를 준 세 토막 패턴에만 `"second"`가 생긴다. 없는 토막을 가리키면 `INVALID_ARGS`다.
 */
type MemoPatternPart = "first" | "second";

/** 인라인 패턴 클릭 동작. `"open-note"`는 대상 토막을 제목으로 하는 노트를 열고
 *  (`notes:read` + `windows`), `"open-url"`은 시스템 기본 브라우저로 열며(`browser:open`),
 *  `"none"`은 클릭하지 않는 장식용이다. 목록 밖 값은 `INVALID_ARGS`이고, **권한이 없는
 *  동작은 렌더 시점에 `"none"`으로 낮춰진다**(등록은 성공한다).
 */
type MemoPatternAction = "open-note" | "open-url" | "none";

/** 인라인 패턴 파라미터 값의 형식 이름(닫힌 어휘 — 정규식을 직접 줄 수는 없다).
 *  `"hex-color"`는 `#rgb`(3자리)와 `#rrggbb`(6자리)를 모두 받는다(대소문자 무관).
 *  형식에 맞지 않는 값은 그 구간이 **매치되지 않아** 원문 그대로 남는다(잘못 칠해지지 않는다).
 *  목록 밖 이름은 `INVALID_ARGS`다.
 */
type MemoPatternParamFormat = "hex-color";

/** 파라미터 캡처값을 반영할 스타일 속성(`MemoInlineStyleProp` 중 **색 값을 받는 것**만).
 *  지금 형식 어휘가 색 하나뿐이라 다른 속성은 언제나 값이 안 맞아 무음 실패가 되므로,
 *  등록 시점에 `INVALID_ARGS`로 거부한다.
 */
type MemoPatternParamApply = "color" | "backgroundColor" | "borderColor";

/** `memo.editor.registerInlinePattern`의 `param` — `close` 앞에 오는 값 하나의 기술.
 *  매칭 모양은 `open`…[`mid`…]`prefix`<값>`close`이고, 값은 캡처만 되고 화면에는 남지
 *  않는다(구분자와 함께 숨는다 — 화면에 남는 토막은 `label`이 고른다).
 */
interface MemoPatternParam {
  /** 값 앞의 리터럴 구분자(예: `"|"`). 구분자와 같은 규칙 — 비어있지 않은 8자 이하,
   *  줄바꿈 불가.
   */
  prefix: string;
  /** 값 형식. 호스트가 이 형식의 정규식으로 매칭하고 같은 형식으로 다시 검증한다. */
  format: MemoPatternParamFormat;
  /** 캡처값을 반영할 스타일 속성. 생략하면 값은 매칭을 좁히기만 하고 스타일에는
   *  관여하지 않는다. `style`의 같은 속성보다 이쪽이 우선한다(매치별 값이다).
   */
  apply?: MemoPatternParamApply;
}

/** `MemoInlineStyle`이 허용하는 CSS 속성 이름(camelCase) 전수.
 *  화이트리스트 밖 속성은 **오류가 아니라 조용히 버려진다** — 그래서 이름을 추측하면
 *  무음 실패가 된다(등록은 성공하고 스타일만 안 붙는다).
 */
type MemoInlineStyleProp =
  | "color"
  | "backgroundColor"
  | "borderColor"
  | "borderWidth"
  | "borderStyle"
  | "borderRadius"
  | "padding"
  | "textDecoration"
  | "textUnderlineOffset"
  | "verticalAlign"
  | "fontSize"
  | "fontWeight"
  | "fontStyle"
  | "fontFamily"
  | "filter"
  | "transition"
  | "cursor"
  | "opacity";

/** `memo.editor.registerInlinePattern`의 `style`/`styleHover` — 허용 속성만 담는 구조화
 *  화이트리스트다(raw CSS 문자열이 아니다). 색 값 자리에는 hex·`rgb()` 리터럴 외에
 *  의미 토큰 `accent`·`danger`·`contrast`·`contrast-border`·`contrast-fill`을 쓸 수 있다
 *  (호스트가 앱 변수로 해석한다). 값 형식이 안 맞는 속성도 조용히 버려진다.
 */
type MemoInlineStyle = Partial<Record<MemoInlineStyleProp, string>>;

/** `memo.editor.registerBlockEmbed`의 소스 URL 인식 규칙 — queryParam과 pathPrefix는 택일.
 *  **정확히 하나**를 줘야 한다(둘 다 주거나 둘 다 안 주면 등록 전체가 `INVALID_ARGS`).
 */
interface MemoEmbedSourceRule {
  /** 소스 URL의 호스트(정확 일치, 소문자 — 서브도메인도 다르면 안 맞는다).
   *  스킴·경로·포트는 넣을 수 없다(`https://` 접두사를 붙이면 거부된다).
   */
  host: string;
  /** id가 담긴 쿼리 파라미터 이름(예: watch?v= → "v"). pathPrefix와 택일.
   *  빈 문자열은 거부된다.
   */
  queryParam?: string;
  /** id가 뒤따르는 경로 접두사(예: "/shorts/"). queryParam과 택일.
   *  `/`로 시작해야 한다.
   */
  pathPrefix?: string;
}

/** `memo.notes.current`가 돌려주는 현재 노트. */
interface MemoCurrentNote {
  id: string;
  path: string;
  content: string;
  /** 지금 그 창의 에디터가 잡고 있는 선택 영역 — 본문과 같은 왕복으로 온다. */
  selection: MemoSelection;
}

/** `memo.notes.list`의 항목 — **메타만** 있다(본문은 `notes.read`로 따로 읽는다).
 *  `id`는 불투명 식별자다(경로가 아니다 — 해석은 호스트가 독점한다).
 */
interface MemoNoteSummary {
  /** `notes.read`에 그대로 넘기는 노트 id. */
  id: string;
  /** 본문 첫 줄에서 파생된 제목 — 첫 줄이 비면(빈 노트 포함) 항상 문자열
   *  `"제목 없음"`이다. **빈 문자열이 되는 경우는 없다**(빈 노트 판정을
   *  `title === ""`로 하지 마라).
   */
  title: string;
  /** 사용자가 숨긴 노트인지. 목록에는 **포함돼 온다** — 숨김 의도를 존중하려면 이
   *  플래그로 걸러라.
   */
  hidden: boolean;
  /** 생성 시각(에폭 ms). */
  createdAt: number;
}

/** `memo.notes.read`의 반환 — id와 본문뿐이다(창 위치·투명도 같은 노트 메타는 실리지
 *  않는다: 권한 문구가 약속한 범위만 나간다).
 */
interface MemoNoteContent {
  id: string;
  /** 노트 본문 전체. */
  content: string;
}

/** `memo.network.fetch`의 헤더 한 쌍 — 요청·응답이 같은 모양이다. 배열이라 같은 이름이
 *  여러 번 올 수 있다(응답의 Set-Cookie 등 — 중복 보존).
 */
interface MemoNetworkHeader {
  name: string;
  value: string;
}

/** `memo.network.fetch`의 반환 — 호스트가 대신 받은 https 응답.
 *  리다이렉트는 **따라가지 않는다**: 3xx면 `status`가 3xx이고 `Location`이 헤더에 실려
 *  온다(새 URL로 다시 부르면 그 URL도 도메인 승인·SSRF 검사를 다시 받는다).
 */
interface MemoNetworkResponse {
  /** HTTP 상태 코드(3xx 포함 — 리다이렉트를 따라가지 않으므로 그대로 본다). */
  status: number;
  /** 응답 헤더(중복 보존 배열). */
  headers: MemoNetworkHeader[];
  /** 응답 본문(UTF-8, 최대 5MiB — 초과하면 `code: "NETWORK_TOO_LARGE"`로 거부된다).
   *  바이너리는 지원하지 않는다(AI·텍스트 API 대상 — 비-UTF8 바이트는 손실 대체된다).
   */
  body: string;
}

/** `memo.settings.get`이 `type: "list"` 키에 대해 돌려주는 항목(쓸 때도 같은 모양).
 *  `list` 키는 언제나 이 구조화 배열로 온다(저장 블롭 문자열을 그대로 받는 방법은 없다).
 */
interface MemoSettingListItem {
  name: string;
  body: string;
}

/** `memo.font.register`의 패밀리 항목 — `system`·`korean`·`alias`는 호스트 전용 필드라
 *  플러그인이 채워도 등록 시점에 떼어낸다(넣을 이유가 없다).
 */
interface MemoFontFamily {
  /** 표시명. */
  label: string;
  /** CSS 폰트 스택. 등록 시점에 CSS 이탈 문자(`;{}<>\``)를 걸러낸다. */
  stack: string;
}

/** 창 컨트롤 능력 id — 각각 토글형 번들 플러그인이 제공한다.
 *  **모르는 id는 오류 없이 버려진다** — 전부 버려지면 `controls: []`로 등록에 성공하고
 *  툴바에는 아무것도 생기지 않는다(무음 실패).
 */
type MemoWindowControlId = "transparency" | "always-on-top" | "all-desktops";

/** `memo.theme.register`의 `tokens` 키 전수 — 의미색(accent·danger·warning)은 라이트/다크
 *  공통 단일 값이라 `-dark`가 **없고**, 표면색(surface·card·border·text·panel·panel-text)만
 *  `<key>`(라이트)와 `<key>-dark`(다크)를 따로 갖는다. `panel`·`panel-text`는 노트 목록·검색
 *  패널 창 전용 배경/글자색이다(설정 창 등 나머지 크롬은 `surface`·`text`).
 *  **화이트리스트 밖 키는 오류 없이 버려진다** — 등록은 `{ id }`로 성공하고 그 색만 안 붙는다
 *  (진단에도 안 남는다: 거부가 아니라 폐기라서 `call-reject`가 기록되지 않는다).
 */
type MemoThemeToken =
  | "accent"
  | "danger"
  | "warning"
  | "surface"
  | "card"
  | "border"
  | "text"
  | "panel"
  | "panel-text"
  | "surface-dark"
  | "card-dark"
  | "border-dark"
  | "text-dark"
  | "panel-dark"
  | "panel-text-dark";

/** 툴바 버튼이 놓일 존(사용자가 「설정 › 외형 › 툴바 배치」로 재배치할 수 있는 자동 배치 폴백).
 *  **모르는 값은 오류 없이 `top-left`로** 정규화된다 — 오타를 편집기가 잡게 하라.
 */
type MemoToolbarPosition =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** `when` 조건이 쓸 수 있는 **닫힌 컨텍스트 키**. 전부 참이어야 한다(AND).
 *  앞에 `!`를 붙이면 부정이다(`"!note.isEmpty"`). **표현식은 없다** — `&&`·`||`·괄호·정규식은
 *  쓸 수 없고, 목록 밖 키는 등록 시점에 `INVALID_ARGS`로 거부된다(지어낸 키가 조용히
 *  무시되지 않는다).
 *  `plugin.<id>.enabled`의 `<id>`는 아무 플러그인 id, `settings.<key>`의 `<key>`는
 *  **자기 매니페스트에 선언한** 설정 키만 쓸 수 있다(남의 설정을 읽는 통로가 아니다).
 *  설정 값의 참/거짓은 JS 진릿값이되 빈 문자열은 거짓이다.
 *  `note.hasSelection`은 **명령의 `when`에는 없다** — 명령의 `when`은 실행 시점에 호스트가
 *  판정하는데 그 판정부가 선택 영역을 보지 않아 넣으면 언제나 참이 되기 때문이다(무음 실패).
 *  선택 조건이 필요하면 `ui.addMenuItem`(메뉴 항목)의 `when`을 쓴다(그쪽은 렌더 시점의 노트
 *  창이 선택을 그 자리에서 보므로 `note.hasSelection`을 정직하게 판정한다 — `MemoMenuWhenKey` 참고).
 *  판정은 호스트에서만 일어나고 **결과는 플러그인에게 돌려주지 않는다**: 조건이 거짓이면
 *  명령이 그냥 실행되지 않고 그 사실만 진단에 남는다.
 */
type MemoWhenKey =
  | "note.isEmpty"
  | "!note.isEmpty"
  | "platform.macos"
  | "!platform.macos"
  | "platform.windows"
  | "!platform.windows"
  | "platform.linux"
  | "!platform.linux"
  | `plugin.${string}.enabled`
  | `!plugin.${string}.enabled`
  | `settings.${string}`
  | `!settings.${string}`;

/** `ui.addMenuItem`의 `when`이 쓸 수 있는 **창 상태 키** — `MemoWhenKey`보다 좁다.
 *  메뉴 항목의 표시 여부는 **우클릭한 그 순간 그 노트 창**이 렌더 직전에 판정하는데, 노트 창이
 *  정직하게 아는 것은 라이브 에디터 상태(선택 영역·본문)뿐이라 두 키로 좁혔다:
 *  `note.isEmpty`(본문이 공백만 빼고 비었는가) · `note.hasSelection`(선택 영역이 있는가).
 *  정적 키(`platform.*`·`plugin.<id>.enabled`·`settings.<key>`)는 렌더 시점의 노트 창이 볼 수
 *  없어 **거부된다**(그런 조건은 `run` 안에서 판단하라). 전부 참이어야 보이고(AND), `!`로
 *  부정할 수 있으며, 조건이 거짓인 항목은 회색이 아니라 **메뉴에서 빠진다**.
 */
type MemoMenuWhenKey =
  "note.isEmpty" | "!note.isEmpty" | "note.hasSelection" | "!note.hasSelection";

/** `ui.addSelectionAction`의 `match.charClasses`가 쓸 수 있는 **문자 부류 전수**(닫힌 열거).
 *  판정은 「선택의 **모든** 글자가 고른 부류 중 **적어도 하나**에 속하는가」다 — 그래서
 *  부류들은 서로 배타적이지 **않고**(예: `.`는 `operator`이자 `punctuation`이다) 겹침은 무해하다.
 *
 *  | 부류 | 문자 |
 *  | --- | --- |
 *  | `digit` | `0`–`9`(ASCII만 — 아라비아-인도 숫자 등은 포함하지 않는다) |
 *  | `operator` | `+ - * / % ^ = < > ( ) . ,`(괄호·소수점·자릿수 쉼표까지 — 산술식 한 줄이 그대로 통과하게) |
 *  | `space` | 모든 공백(탭·줄바꿈 포함 — 「한 줄인가」는 `singleLine`이 따로 보는 축이다) |
 *  | `latin` | `A`–`Z`·`a`–`z` |
 *  | `hangul` | 음절(가–힣)·자모·호환 자모 |
 *  | `punctuation` | 유니코드 문장부호(`\p{P}`) — `「」`·`—`·`…` 같은 비ASCII도 포함 |
 *
 *  **목록 밖 이름은 조용히 버려지지 않고 `INVALID_ARGS`로 거부된다** — 버리면 조건이 넓어진
 *  (=아무 선택에서나 뜨는) 버튼이 되어 오타를 알려주지 않는 무음 실패가 된다.
 */
type MemoCharClass =
  "digit" | "operator" | "space" | "latin" | "hangul" | "punctuation";

/** `ui.addSelectionAction`의 표시·실행 조건 — **정규식이 아니라 닫힌 어휘**다.
 *  세 축은 전부 AND이고, 주지 않은 축은 검사하지 않는다. 셋 다 생략하면(또는 `match` 자체를
 *  생략하면) 선택이 비어 있지 않을 때 언제나 참이다.
 *  판정은 **선택이 만들어진 순간 그 노트 창이** 로컬로 한다(샌드박스 왕복 0·방송 0) — 어휘가
 *  닫혀 있어 판정에 필요한 것이 전부 직렬화되기 때문에 가능한 설계다.
 */
interface MemoSelectionMatch {
  /** 선택의 **모든** 글자가 이 부류 중 하나 이상에 속해야 한다.
   *  빈 배열은 거부된다(검사를 끄려면 아예 생략하라 — 빈 배열이 「아무 글자도 허용하지
   *  않음」인지 「검사 없음」인지 읽는 사람마다 달라진다).
   */
  charClasses?: MemoCharClass[];
  /** 참이면 줄바꿈이 든 선택에서는 보이지 않는다. */
  singleLine?: boolean;
  /** 선택 글자 수 상한(코드 포인트 기준 — 이모지가 두 글자로 세어지지 않는다).
   *  1 이상의 정수여야 한다(0 이하는 어떤 선택도 통과할 수 없어 거부된다).
   */
  maxLength?: number;
}

/** `memo.storage.*`의 서랍 — **수명이 다르다**. 생략하면 `local`.
 *
 *  | 스코프 | 사는 곳 | 사라지는 때 | 설정 폼 노출 |
 *  | --- | --- | --- | --- |
 *  | `settings`(비교용) | 디스크 | 사용자가 지울 때까지 | **예**(매니페스트 스키마) |
 *  | `local` | 디스크(플러그인별 파일) | 사용자가 지울 때까지 — 재빌드에도 생존 | 아니오 |
 *  | `session` | 호스트 프로세스 메모리 | 앱을 끌 때(재빌드에는 생존) | 아니오 |
 *  | `window` | 창 토큰으로 격리된 메모리 | 그 창을 다시 안 볼 때 | 아니오 |
 *
 *  고르는 법: **사용자가 폼에서 고칠 값이면 `settings`**, 다음 실행에도 있어야 하면 `local`,
 *  다시 계산할 수 있는 캐시면 `session`, 이 창에서만 뜻이 있는 상태면 `window`.
 *  `window`의 폐기 시점은 정확히 「창이 닫힐 때」가 아니다 — 호스트가 창 닫힘을 통지받는
 *  경로가 없어, 실제로는 오래 안 쓴 창의 서랍부터 상한에 걸려 버려진다. 창이 닫히면 반드시
 *  지워져야 하는 값을 여기 두지 마라.
 */
type MemoStorageScope = "local" | "session" | "window";

/** `memo.events.on`으로 구독할 수 있는 이벤트 이름 전수(닫힌 열거).
 *  **목록 밖 이름은 조용히 무시되지 않고 `INVALID_ARGS`로 거부된다** — 구독은 됐는데 영영
 *  안 불리는 무음 실패를 만들지 않으려는 것이다. 키 입력마다 나는 텍스트 변경 이벤트는
 *  여기 **없고**, 앞으로도 이 목록에 없는 이름을 추측하지 마라.
 */
type MemoEventName =
  | "note:opened"
  | "note:saved"
  | "note:focused"
  | "note:blurred"
  | "note:closed"
  | "settings:changed";

/** 이벤트 핸들러의 **둘째** 인자(첫 인자는 그 이벤트의 창에 바인딩된 `memo`다).
 *  필드는 이벤트 종류에 따라 채워진다 — `note:*`는 창·노트 메타를, `settings:changed`는
 *  바뀐 키와 값을 싣는다. **노트 본문은 어떤 이벤트에도 실리지 않는다.**
 */
interface MemoEventPayload {
  /** 난 이벤트(핸들러 하나를 여러 이름에 재사용할 때 분기 축). */
  name: MemoEventName;
  /** 이벤트 발생 시각(에폭 ms). */
  at: number;
  /** `note:*` — 이벤트가 난 노트 창의 불투명 식별자.
   *  이 값으로 창을 타깃하지 마라(방법도 없다) — 라우팅은 첫 인자의 바인딩된 memo가 한다.
   */
  windowId?: string;
  /** `note:*` — 그 창이 열고 있는 노트 id. */
  noteId?: string;
  /** `note:*` — 노트 본문 파일의 절대경로(알 수 없으면 null). */
  path?: string | null;
  /** `settings:changed` — 바뀐 설정 키(자기 플러그인의 키만 온다). */
  key?: string;
  /** `settings:changed` — 직전 값. */
  oldValue?: unknown;
  /** `settings:changed` — 방금 저장된 값.
   *  **이 값을 써라.** 폼에서 바뀐 경우 뒤따르는 재빌드 전까지 `settings.get`은 아직 옛
   *  값을 줄 수 있다(이번 계약은 통지만 하고 재빌드가 값의 정본이다).
   */
  newValue?: unknown;
  /** `settings:changed` — `form`은 사용자가 설정 화면에서, `plugin`은 코드가
   *  `settings.set`으로 바꾼 것이다.
   *  **자기가 쓴 값에도 이벤트가 온다** — 핸들러에서 다시 쓰면 무한 루프가 된다. 필요하면
   *  이 필드로 걸러라.
   */
  origin?: "form" | "plugin";
}

/** `memo.runtime.info()`가 돌려주는 실행 환경 스냅샷. */
interface MemoRuntimeInfo {
  pluginId: string;
  /** 앱 버전(예 `"0.1.0"`) — 진단·경고용이지 기능 분기용이 아니다.
   *  **읽지 못하면 빈 문자열**이다(지어낸 값을 주지 않는다) — 빈 문자열을 "구버전"으로
   *  해석하지 마라.
   */
  hostVersion: string;
  /** OS 식별자("macos"·"windows"·"linux"). 알 수 없으면 빈 문자열. */
  os: string;
  /** 이 실행이 시작된 사유 — **값은 `"reload"` 하나뿐이다.**
   *  설치·갱신도 결국 호스트에는 재빌드 신호 하나로 도착해서, 호스트가 그 셋을 구분할
   *  근거를 갖지 못한다. 관측되지 않는 값을 타입으로 약속하지 않으려고 유니온을 좁혀 두었다
   *  — 사유를 나르는 경로가 생기면 그때 넓힌다(넓히기는 하위호환이다).
   */
  reason: "reload";
  /** 매니페스트가 선언한 권한. */
  declared: string[];
  /** 사용자가 실제로 부여한 권한(민감 권한은 여기 없을 수 있다). */
  granted: string[];
}

/**
 * `memo.*` 브리지 전체 — 전역 `memo`와 `onClick`의 첫 인자가 같은 이 모양이다.
 */
interface MemoApi {
  editor: {
    /** 인라인 패턴 등록 — open/close 구분자 사이 텍스트를 스타일링(+ 선택적 클릭 동작).
     *  정규식이 아니라 **구분자 리터럴**만 준다(ReDoS 차단). 스타일은 구조화 화이트리스트라
     *  raw CSS 문자열·셀렉터를 줄 수 없고, 호스트가 `.cm-x-<plugin>-<pattern>` 규칙으로 주입한다.
     *
     *  `mid`를 주면 **세 토막**(`open`…`mid`…`close`)이 되어 캡처가 둘 생긴다 — `[텍스트](url)`
     *  처럼 보여 줄 글자와 클릭 대상이 다른 토막에 있는 모양을 이렇게 표현한다. 어느 토막을
     *  화면에 남길지는 `label`, 어느 토막을 클릭 대상으로 쓸지는 `target`이 정한다.
     *
     *  `param`을 주면 `close` **바로 앞**에 값 하나가 더 붙는다(`open`…[`mid`…]`prefix`<값>`close`).
     *  등록 하나당 스타일은 고정 하나지만, `param.apply`로 지정한 색 속성만은 **매치마다 다른**
     *  값을 쓴다 — `{{글자|#f36}}`처럼 본문에 적힌 색으로 칠하는 모양이 이걸로 표현된다(값마다
     *  등록을 하나씩 만들 필요가 없다). 값 형식은 저작자가 정규식으로 기술하지 않고 닫힌 이름
     *  (`MemoPatternParamFormat`)으로 고르며, 호스트가 그 형식으로 다시 검증한 값만 스타일이
     *  된다 — 형식을 벗어난 값은 그 구간이 아예 매치되지 않아 원문 그대로 남는다.
     *
     *  `action`이 클릭 동작을 고른다. `"open-note"`(기본)는 대상 토막을 제목으로 하는 노트를
     *  열고 `notes:read` + `windows`가 필요하다(위키링크 동작). `"open-url"`은 대상 토막을
     *  시스템 기본 브라우저로 열고 `browser:open`이 필요하다. `"none"`은 클릭하지 않는
     *  장식용이다. **권한이 없으면 그 패턴의 동작은 `"none"`으로 낮춰진다** — 눌러도 아무 일이
     *  없는 가짜 링크를 만들지 않기 위함이다(등록 자체는 성공한다).
     *
     *  구분자는 비어있지 않은 8자 이하 문자열이어야 하고 줄바꿈을 담을 수 없다. 어기면
     *  `INVALID_ARGS`로 거부한다 — 예전에는 무엇을 주든 등록에 성공한 뒤 조용히 엉뚱한 구간을
     *  잡았다.
     *  필요 권한: `editor`.
     */
    registerInlinePattern(args: {
      /** 생략하면 호스트가 `<pluginId>:<call>:<seq>`로 만들어 돌려준다. 같은 id로 다시 등록하면 치환(upsert)이다. */
      id?: string;
      /** 여는 구분자(예 `==`). */
      open: string;
      /** 중간 구분자(예 `](`). 주면 세 토막 패턴이 되어 캡처가 둘이 된다. */
      mid?: string;
      /** 닫는 구분자(예 `==`). */
      close: string;
      /** `close` 앞에 붙는 형식 검증된 값 하나(예 `{{글자|#f36}}`의 `#f36`) — 그 값으로 색을 칠한다. */
      param?: MemoPatternParam;
      /** 화면에 남길 토막(기본 `"first"`). `"second"`는 `mid`를 줄 때만 쓸 수 있다. */
      label?: MemoPatternPart;
      /** 클릭 대상으로 쓸 토막(기본: `mid`가 있으면 `"second"`, 없으면 `"first"`). */
      target?: MemoPatternPart;
      /** 클릭 동작(기본 `"open-note"`). 권한이 없으면 `"none"`으로 낮춰진다. */
      action?: MemoPatternAction;
      style?: MemoInlineStyle;
      /** :hover 상태(선택). */
      styleHover?: MemoInlineStyle;
    }): Promise<MemoRegistration>;
    /** 자동완성 등록 — trigger 입력 시 노트 제목을 제안하고, 고르면 wrap의 `%`가 제목으로 치환된다.
     *  `trigger`는 임의 문자열이다(`[[`·`@`·`#` 등). 호스트가 정규식을 만들지 않고 리터럴 비교로
     *  매칭하며, 트리거가 겹치면 **커서에 가장 가까운 트리거 우선**이다(같은 자리에서 시작하면
     *  더 긴 trigger, 그마저 같으면 먼저 등록한 쪽). 줄 앞쪽의 남의 트리거가 이겨서 방금 친
     *  텍스트를 통째로 치환하는 일은 없다.
     *  `wrap`의 `%`는 전부 치환된다. 후보 원천은 노트 제목 하나뿐이고(닫힌 열거형), 후보를 실제로
     *  받으려면 `notes:read`도 선언·부여돼야 한다 — 없으면 팝업은 뜨지만 후보가 0개다.
     *  필요 권한: `editor`.
     */
    registerCompletion(args: {
      /** 생략하면 자동 생성. 같은 id 재등록은 치환(upsert). */
      id?: string;
      /** 이 문자열을 입력하면 팝업이 열리고, 그 뒤부터 커서까지가 검색어가 된다. */
      trigger: string;
      /** 고른 제목으로 치환할 틀 — `%`가 제목 자리다(예 `[[%]]`). */
      wrap: string;
    }): Promise<MemoRegistration>;
    /** 블록 임베드 등록 — ```<fence> 코드펜스 안의 소스 URL을 위젯으로 바꾼다.
     *  최종 임베드 URL의 도메인은 `embed:<도메인>` 권한으로 **따로** 게이트된다 — 그 권한이
     *  부여되지 않으면 등록은 성공해도 렌더되지 않는다.
     *  아래 제약을 하나라도 어기면 등록 **전체**가 `INVALID_ARGS`로 거부된다(오류 문구가
     *  어느 필드가 왜 걸렸는지를 밝힌다 — 「최근 오류」에서 그대로 읽어라).
     *  필요 권한: `editor`.
     */
    registerBlockEmbed(args: {
      /** 필수(자동 생성 없음). 형식 `^[a-z0-9][a-z0-9._-]*$`. */
      id: string;
      /** 코드펜스 언어 태그. **`id`와 같은 형식** `^[a-z0-9][a-z0-9._-]*$` — 대문자(예 `"YouTube"`)는 거부된다. */
      fence: string;
      /** 1개 이상 32개 이하. 빈 배열도 거부된다. */
      sources: MemoEmbedSourceRule[];
      /** `{id}`를 포함해야 하고, 치환 결과가 https URL이어야 한다. */
      embedTemplate: string;
    }): Promise<MemoRegistration>;
    /** 이 메모의 글자 델타(%)를 읽는다.
     *  실효 크기는 전역 크기 + 델타를 호스트가 적용한다.
     *  필요 권한: `editor`.
     *  반환: 창 컨텍스트가 없으면 null.
     */
    getFontDelta(args?: {
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<number | null>;
    /** 이 메모의 글자 델타(%)를 설정한다.
     *  반환값은 한계로 클램프된 **실제 적용된** 델타다 — 토스트에 그대로 쓰면 정직해진다.
     *  필요 권한: `editor`.
     *  반환: 적용된 델타(%). 창 컨텍스트가 없으면 null.
     */
    setFontDelta(args: {
      value: number;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<number | null>;
    /** 커서 위치에 텍스트를 삽입한다 — **선택이 있으면 그 선택을 대체한다**(기본 `cursor`).
     *  본문을 실제로 쓰므로 `editor`가 아니라 `notes:write`(민감) 게이트다.
     *  **선택 교체가 이 호출의 기본 동작이다.** `mode: "cursor"`(기본)는 커서가 잡고 있는
     *  범위(`notes.current().selection`의 `from`~`to`)를 통째로 지우고 그 자리에 넣는다 —
     *  「선택한 걸 대문자로」·「선택을 `**`로 감싸기」는 전부 이 조합으로 쓴다:
     *  `notes.current()`로 선택을 읽고, 변환한 문자열을 `insertText({ text })`로 되쓴다.
     *  **오프셋을 받는 쓰기 API는 일부러 주지 않는다** — 읽은 뒤 사용자가 타이핑해 오프셋이
     *  어긋나도 호스트가 CodeMirror 트랜잭션으로 그 경합을 흡수하게 하기 위함이다.
     *  필요 권한: `notes:write`(민감 — 사용자 승인 필요).
     *  반환: 창 컨텍스트가 없어도 null이다 — 성공과 구분되지 않는다.
     */
    insertText(args: {
      text: string;
      /** 기본 `cursor`(선택 대체). `append`=문서 끝에 덧붙임. **`replace`는 문서 전체를 덮어쓴다** — "선택 교체"가 필요하면 `replace`가 아니라 `cursor`다(자주 틀리는 지점). */
      mode?: "cursor" | "append" | "replace";
      /** 삽입된 본문 안에서의 최종 커서 오프셋(생략하면 삽입 끝). */
      caret?: number;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
  };
  ui: {
    /** 노트 툴바에 버튼을 등록한다.
     *  `onClick`은 postMessage로 직렬화되지 않고 샌드박스 로컬에 남아, 호스트가 핸들러 id로
     *  역호출할 때 실행된다. 첫 인자로 **이 클릭에 바인딩된 `memo`**가 오므로
     *  `function (memo) { ... }`로 받아 전역을 가리는 것이 정본이다(창 컨텍스트 절 참고).
     *  `onClick`은 **필수**다 — 없으면 `INVALID_ARGS`로 거부된다(누를 수 없는 버튼을 조용히
     *  띄우지 않는다). `id`는 등록 수집기와 같은 계약이다: 생략하면 호스트가
     *  `<pluginId>:ui.addToolbarButton:<seq>`로 만들어 주고, **같은 id로 다시 등록하면 추가가
     *  아니라 치환**이다(진단에 「중복 등록」으로 남는다). id는 사용자의 툴바 배치·단축키가
     *  붙는 영속 키라, 버튼마다 서로 다른 값을 직접 주는 것이 좋다.
     *  필요 권한: `ui`.
     *  반환: 등록 id를 돌려주지 않는다(다른 등록 호출과 달리 `{ id }`가 아니다).
     */
    addToolbarButton(args: {
      /** 이 버튼의 안정 식별자(툴바 배치·단축키 키). 생략하면 호스트가 만든다. */
      id?: string;
      /** 버튼에 보이는 글자/이모지. */
      label: string;
      /** 툴팁. */
      title?: string;
      /** 배치가 이 버튼을 **한 번도 본 적 없을 때만** 쓰이는 자동 배치 존(폴백). 실제 위치는 사용자가 「설정 › 외형 › 툴바 배치」로 정한다. */
      position: MemoToolbarPosition;
      /** 클릭 핸들러. 첫 인자의 바인딩된 memo는 어떤 비동기 경계를 넘어도 클릭한 창으로 라우팅된다. */
      onClick: (memo: MemoApi) => void;
    }): Promise<null>;
    /** 노트 툴바에 **텍스트·카운트를 보여주는** 상태 아이템을 등록한다(기본은 클릭 버튼이 아니다).
     *  버튼(`addToolbarButton`)과 **같은 툴바 배치 시스템**을 탄다 — 사용자가 「설정 › 외형 ›
     *  툴바 배치」에서 버튼과 동급으로 끌어 옮기고 숨길 수 있다. 다른 것은 렌더뿐이다: 누르는
     *  버튼이 아니라 텍스트를 보여준다(단어 수·글자 수 같은 라이브 카운트).
     *  `text`는 **초기값**이다. 등록 뒤 값이 바뀌면(예: 타이핑) `memo.ui.updateStatusItem`으로
     *  그 창의 텍스트를 갱신한다 — 값은 **창마다 다를 수 있어**(각 노트의 단어 수는 다르다) 이
     *  등록이 아니라 창-스코프 갱신이 나른다. 첫 값을 채우려면 `note:opened`(그리고 저장마다
     *  다시 세려면 `note:saved`) 이벤트 핸들러에서 `updateStatusItem`을 부르는 것이 정본이다.
     *  `id`는 등록 수집기와 같은 계약이다: 생략하면 호스트가 만들어 주고(그러면 갱신 대상
     *  id를 알 수 없으니 **직접 주는 것이 좋다**), 같은 id로 다시 등록하면 추가가 아니라 치환이다.
     *  함수(핸들)를 돌려주지 않는 이유는 버튼과 같다 — 브리지가 postMessage라 함수를 나를 수
     *  없고, 안정 문자열 `id`가 그 자리를 대신한다.
     *  `onClick`(선택)을 주면 이 아이템이 **클릭 가능**해진다 — 렌더는 여전히 텍스트지만(버튼
     *  박스로 바뀌지 않는다) 커서·hover가 붙고 클릭하면 `addToolbarButton`과 똑같은 절차로 그
     *  클릭에 바인딩된 `memo`가 온다(예: 지금 보이는 텍스트를 클립보드에 복사). 안 주면(기본)
     *  지금까지와 동일한 순수 텍스트다 — 클릭해도 아무 일도 일어나지 않는다.
     *  필요 권한: `ui`.
     *  반환: 등록 id를 돌려주지 않는다(버튼과 같다) — 갱신하려면 등록에 준 `id`를 그대로 쓴다.
     */
    addStatusItem(args: {
      /** 이 상태 아이템의 안정 식별자(툴바 배치·갱신 키). 생략하면 호스트가 만든다 — 갱신하려면 직접 주라. */
      id?: string;
      /** 처음 그려질 텍스트/카운트. 이후 `ui.updateStatusItem`으로 갱신한다(빈 문자열도 허용 — 핸들러가 첫 값을 채우는 패턴). */
      text: string;
      /** 툴팁. */
      title?: string;
      /** 배치가 이 아이템을 **한 번도 본 적 없을 때만** 쓰이는 자동 배치 존(폴백). 실제 위치는 사용자가 「툴바 배치」로 정한다. */
      position: MemoToolbarPosition;
      /** 클릭 핸들러(선택 — 주면 이 아이템이 클릭 가능해진다). 첫 인자의 바인딩된 memo는 어떤 비동기 경계를 넘어도 클릭한 창으로 라우팅된다(`addToolbarButton`의 onClick과 동일 규약). */
      onClick?: (memo: MemoApi) => void;
    }): Promise<null>;
    /** 이미 등록한 상태 아이템의 **이 창** 표시 텍스트/툴팁을 갱신한다.
     *  `ui.addStatusItem`으로 등록한 아이템의 텍스트를 그 창에서 바꾼다 — 단어 수처럼 창마다·
     *  시점마다 다른 값을 그리는 수단이다. **창-스코프 호출**이라 갱신은 **그 호출을 낳은 창**에만
     *  닿는다: `note:opened`·`note:saved` 같은 이벤트 핸들러의 첫 인자로 오는 바인딩된 `memo`로
     *  부르면 그 이벤트가 난 창의 상태 아이템이 갱신된다(전역 `memo`로 부르면 창 컨텍스트가 없어
     *  조용한 null이다).
     *  **부분 갱신이다**: `text`만 주면 텍스트만, `title`만 주면 툴팁만 바뀐다(안 준 필드는
     *  그대로). 등록 전에 부르거나 이 창에 없는 id를 가리키면 무음 무시가 아니라 `INVALID_ARGS`로
     *  거부된다 — 등록은 `addStatusItem`으로 `runtime.ready()` 전에 하라.
     *  필요 권한: `ui`.
     *  반환: 갱신한 아이템의 id. 창 컨텍스트가 없으면 아무 일도 일어나지 않고 null이다.
     */
    updateStatusItem(args: {
      /** 갱신할 상태 아이템 id(`addStatusItem`에 준 값). 없으면 `INVALID_ARGS`. */
      id: string;
      /** 새 텍스트/카운트(생략하면 현재 텍스트 유지). */
      text?: string;
      /** 새 툴팁(생략하면 현재 툴팁 유지). */
      title?: string;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<MemoStatusItem | null>;
    /** 토스트 알림을 띄우거나(id 없음) 이미 띄운 토스트를 갱신·닫는다(id 있음).
     *  **하나의 호출로 띄우기·갱신·닫기를 한다.** id 없이 부르면 새로 띄우고 `{ id }`를
     *  돌려준다. 그 id를 다시 실어 부르면 같은 토스트가 제자리에서 바뀌고,
     *  `dismiss: true`면 사라진다. 함수(핸들)를 돌려주지 않는 이유는 브리지가 postMessage라
     *  함수를 나를 수 없기 때문이다 — 문자열 id가 그 자리를 대신한다.
     *  비동기 작업은 `style: "progress"`로 시작해 끝날 때 같은 id로 `success`/`failure`로
     *  바꾸는 것이 정본 사용법이다. **실패를 사용자에게 알리는 표준 수단이 이것이다** —
     *  `.catch`에서 `failure` 토스트를 띄우면 「조용히 아무 일도 안 일어나는」 플러그인이 되지 않는다.
     *  **같은 클릭 컨텍스트 안에서만 갱신할 수 있다**: id는 그 창의 것이고, 창 컨텍스트를 잃은
     *  뒤(전역 `memo`로 부르면) 그 id는 그 창에서 찾을 수 없어 `INVALID_ARGS`가 된다.
     *  이미 사라진 id로 갱신하면 무음 무시가 아니라 `INVALID_ARGS`로 거부된다.
     *  **갱신은 부분 갱신이다**: 주지 않은 필드(`title`·`message`·`style`)는 그 토스트의 현재
     *  값을 그대로 유지한다. 그래서 `{ id, style: "success" }` 한 번으로 진행 토스트를 완료로
     *  바꿀 수 있고, 그때 문구가 사라지지 않는다.
     *  필요 권한: `ui`.
     *  반환: 그 토스트의 id. 창 컨텍스트가 없으면 아무 일도 일어나지 않고 null이다.
     */
    toast(args?: {
      /** 한 줄 제목(본문). 새로 띄울 때 필수다(없으면 `INVALID_ARGS` — 빈 알림을 띄우지 않는다). 닫기·부분 갱신에서는 안 줘도 되고, 안 주면 기존 문구가 유지된다. */
      title?: string;
      /** 제목 아래 보조 설명(있으면 토스트가 여러 줄로 넓어진다). */
      message?: string;
      /** 새 토스트의 기본은 `success`. `progress`는 자동으로 사라지지 않는다(호스트가 30초 뒤 강제 소멸시켜 유령 토스트를 막는다). 모르는 값은 `success`로 접힌다. 갱신에서 생략하면 **현재 상태가 유지된다**(진행 토스트가 제멋대로 자동 소멸하지 않는다). */
      style?: MemoToastStyle;
      /** 갱신·닫기 대상. 이전 호출이 돌려준 값만 유효하다. */
      id?: string;
      /** `id`와 함께 주면 그 토스트를 즉시 닫는다(`id` 없이 주면 `INVALID_ARGS`). */
      dismiss?: boolean;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<MemoToast | null>;
    /** 목록에서 하나 고르게 한다(사용자 응답까지 대기). 항목마다 부제·여러 액션을 붙일 수 있다.
     *  항목에 `actions`를 주지 않으면 **반환이 고른 항목의 id 문자열**이다(옛 계약 그대로).
     *  항목 중 **하나라도** `actions`를 선언하면 반환이 `{ itemId, actionId }` 객체로 넓어진다 —
     *  액션을 안 쓰는 호출이 이 API의 부분집합이 되게 한 것이라, 기존 플러그인은 무변경으로 산다.
     *  `actions`를 생략한 항목은 액션 `"select"` 하나를 가진 것으로 취급한다.
     *  라벨·부제는 **텍스트로만** 그려진다(마크업·HTML은 그대로 글자로 보인다) — 길이 상한도 있다.
     *  섹션 분할·퍼지 검색은 없다: 대량 목록이 실제로 필요해질 때 같은 API를 넓힌다.
     *  필요 권한: `ui`.
     *  반환: 액션을 안 쓰면 고른 항목 id(문자열), 쓰면 `{ itemId, actionId }`. 취소하거나 창 컨텍스트가 없으면 null.
     */
    pickList(args: {
      title: string;
      /** 제목 아래 안내 한 줄(검색창이 아니다 — 호스트 검색은 제공하지 않는다). */
      placeholder?: string;
      items: MemoPickListItem[];
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<string | MemoPickResult | null>;
    /** 사용자에게 입력을 받는다 — `fields` 없으면 한 줄 입력, 있으면 다중 필드 폼(사용자 응답까지 대기).
     *  **폼은 별도 호출이 아니라 이 호출의 확장이다.** 「사용자에게 물어본다」가 하나의 개념이라
     *  `prompt`·`form`이 서로 다른 규약(취소 값·상한·창 컨텍스트)을 갖지 않게 한 결정이다.
     *  `fields`를 주면 반환이 `Record<필드 id, 값>`이고, 값의 타입은 필드 타입이 정한다
     *  (`toggle`→boolean, `number`→number, 나머지→string).
     *  **필드 타입 어휘는 매니페스트 `settings`와 같은 것**이다(`list`만 폼에 없다) — 저작자가
     *  두 벌을 배우지 않게 하려는 것이고, `select`의 `options`도 같은 축약형(문자열 = value+label)을 쓴다.
     *  모르는 타입·id 없는 필드는 **조용히 text로 접지 않고 버린다**: 접으면 폼이 떠서 성공한 것처럼
     *  보이는데 값의 종류만 다르다(관측 불가능한 실패). 버리면 그 필드가 없다는 것이 바로 보인다.
     *  그렇게 버리다 **필드가 하나도 남지 않으면 `INVALID_ARGS`로 거부**한다 — 한 줄 입력으로
     *  폴백하면 계약과 다른 UI가 뜨고 반환형까지 문자열로 달라진다(진단에도 남는다).
     *  제출값 검증을 호스트에 왕복시키는 흐름은 **없다** — 필요하면 결과를 받아 스스로 판단하고
     *  `ui.toast({ style: "failure" })`로 알린 뒤 다시 `ui.prompt`를 부르면 된다.
     *  필요 권한: `ui`.
     *  반환: `fields` 없으면 입력 문자열, 있으면 필드 id → 값 맵. 취소하거나 창 컨텍스트가 없으면 null.
     */
    prompt(args: {
      title: string;
      /** 한 줄 입력이면 입력창 placeholder, 폼이면 제목 아래 안내 한 줄. */
      placeholder?: string;
      /** 한 줄 입력의 초기값(폼에서는 필드마다 `default`를 준다). */
      default?: string;
      /** 확인 버튼 문구(기본 "확인"). */
      submitLabel?: string;
      /** 주면 폼이 된다(빈 배열은 「안 준 것」과 같다 — 필드 0개짜리 카드는 사용자에게 의미가 없다). */
      fields?: MemoFormField[];
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<string | Record<string, string | number | boolean> | null>;
    /** 에디터 우클릭 컨텍스트 메뉴에만 나타나는 항목을 등록한다(툴바·단축키에는 자리를 잡지 않는다).
     *  툴바 버튼·명령과 다른 점은 **어디에 그리느냐**뿐이다: 이 항목은 툴바에도 단축키 화면에도
     *  없고 **에디터 우클릭 메뉴에만** 나타난다. 「선택한 텍스트를 감싸기」처럼 우클릭·선택 단위
     *  동작에 쓴다. `run`의 첫 인자는 **그 클릭한 창에 바인딩된 `memo`**(버튼 `onClick`과 같은
     *  규약)이고, **둘째 인자 `payload.selectedText`**는 우클릭 순간의 선택 텍스트다 —
     *  다만 그 필드는 매니페스트에 **`notes:read`를 선언·부여받았을 때만** 채워진다(선택 텍스트는
     *  노트 본문의 일부라 `ui` 저위험 권한만으로는 넘기지 않는 payload 단위 게이트다). 권한이 없으면
     *  `selectedText`는 언제나 `undefined`다(호출 자체는 `ui` 권한으로 동작한다).
     *  `when`은 **창 상태 두 키**(`note.isEmpty`·`note.hasSelection`)만 쓴다 — 명령의 `when`과 달리
     *  정적 키(`platform`·`settings`)는 쓸 수 없다(표시 여부를 판정하는 주체가 렌더 시점의 노트 창
     *  이라, 노트 창이 정직하게 아는 것은 라이브 에디터 상태뿐이다). 조건이 거짓인 항목은 회색이
     *  아니라 **메뉴에서 빠진다**. `id`는 등록 수집기와 같은 계약: 생략하면 자동 생성, 같은
     *  id는 치환(진단 「중복 등록」). `run`은 **필수**다(없으면 `INVALID_ARGS` — 눌러도 아무 일도
     *  일어나지 않는 항목을 만들지 않는다). 등록은 다른 등록과 같은 마감(`runtime.ready()`)에 닫힌다.
     *  필요 권한: `ui`.
     */
    addMenuItem(args: {
      /** 이 항목의 안정 식별자. 생략하면 호스트가 만든다(같은 id 재등록은 치환). */
      id?: string;
      /** 컨텍스트 메뉴에 보일 이름(필수 — 비면 INVALID_ARGS). */
      label: string;
      /** 전부 참일 때만 메뉴에 보인다(AND). 창 상태 두 키만 — 목록 밖 키는 INVALID_ARGS. */
      when?: MemoMenuWhenKey[];
      /** 실행 본문. 첫 인자는 클릭한 창에 바인딩된 memo, 둘째의 selectedText는 notes:read가 있을 때만 채워진다. */
      run: (memo: MemoApi, payload: { selectedText?: string }) => void;
    }): Promise<MemoRegistration>;
    /** 본문 텍스트를 선택하면 뜨는 **선택 툴바**에 액션 버튼을 등록한다(단축키로도 실행된다).
     *  표면은 둘, 등록은 하나다. (1) **선택 툴바** — 드래그든 키보드든 선택을 만들면 선택 근처에
     *  뜨는 플로팅 바의 **맨 끝**(색 버튼 다음)에 버튼이 나타나고, 누르면 `run`이 돈다.
     *  (2) **「설정 › 단축키 › 플러그인 동작」** — 사용자가 키를 배정하면 선택이 비어 있지 않고
     *  `match`가 맞을 때만 `run`이 돈다(조건이 안 맞으면 조용히 아무 일도 일어나지 않는다).
     *  `match`를 생략하면 **선택이 있을 때 언제나** 보인다. 주면 호스트가 **창 안에서 로컬로**
     *  판정한다 — 선택이 만들어진 순간 그 창에서 1회, 샌드박스 왕복도 방송도 없다(고빈도 이벤트를
     *  열지 않으면서 조건부 표시를 주는 방법이 이것이다).
     *  **`match`는 정규식이 아니라 닫힌 어휘다**: 문자 부류(`charClasses`)·한 줄 여부
     *  (`singleLine`)·길이 상한(`maxLength`)뿐이다. 인라인 패턴의 구분자가 리터럴만 받는 것과
     *  같은 이유다(플러그인이 준 정규식을 사용자 텍스트에 돌리면 ReDoS가 열리고, 판정 주체는
     *  어차피 호스트다). 어휘 밖 값은 조용히 무시되지 않고 등록 시점에 `INVALID_ARGS`다.
     *  `run`의 첫 인자는 **버튼을 누른 그 창에 바인딩된 `memo`**(`addToolbarButton`의 `onClick`과
     *  같은 규약)이고, 둘째 인자 `payload.selectedText`는 그 순간의 선택 텍스트다 — 다만 그
     *  필드는 매니페스트에 **`notes:read`를 선언·부여받았을 때만** 채워진다(`ui.addMenuItem`과
     *  **글자 그대로 같은 계약** — 선택 텍스트는 노트 본문의 일부라 `ui` 저위험 권한만으로는
     *  넘기지 않는 payload 단위 게이트다). 권한이 없으면 언제나 `undefined`다.
     *  **되쓰기 경로는 새로 열지 않는다**: 결과를 본문에 넣으려면 `run` 안에서
     *  `memo.editor.insertText`(`notes:write`)를 그대로 쓴다(선택이 있으면 그 선택을 대체한다).
     *  `label`은 좁은 플로팅 바에 보일 **유일한** 문자열이라 필수다(빈 값은 `INVALID_ARGS`).
     *  `run`도 필수다(없으면 눌러도 아무 일도 일어나지 않는 버튼이 된다). `id`는 등록 수집기와
     *  같은 계약: 생략하면 자동 생성, 같은 id는 치환(진단 「중복 등록」). id는 사용자의 단축키가
     *  붙는 영속 키라 직접 주는 것이 좋다. 등록은 다른 등록과 같은 마감(`runtime.ready()`)에 닫힌다.
     *  바가 한 번에 그리는 버튼 수에는 상한이 있다(지금 5개) — 넘친 액션은 **그려지지 않을 뿐**
     *  단축키로는 그대로 실행된다.
     *  필요 권한: `ui`.
     */
    addSelectionAction(args: {
      /** 이 액션의 안정 식별자(단축키가 붙는 키). 생략하면 호스트가 만든다 — 직접 주라. */
      id?: string;
      /** 버튼에 보일 글자/이모지(필수 — 비면 INVALID_ARGS). 마크업이 아니라 평문으로 그려진다. */
      label: string;
      /** 툴팁이자 단축키 화면에 보일 이름(없으면 label을 쓴다). */
      title?: string;
      /** 표시·실행 조건(생략하면 선택이 있을 때 언제나). 어휘 밖 값은 INVALID_ARGS. */
      match?: MemoSelectionMatch;
      /** 실행 본문. 첫 인자는 그 창에 바인딩된 memo, 둘째의 selectedText는 notes:read가 있을 때만 채워진다. */
      run: (memo: MemoApi, payload: { selectedText?: string }) => void;
    }): Promise<MemoRegistration>;
    /** 메뉴바(시스템 트레이) 메뉴에 항목을 등록한다 — 클릭하면 `run`이 실행된다(툴바·단축키에는 자리를 잡지 않는다).
     *  툴바 버튼·명령·메뉴 항목과 다른 점은 **어디에 그리느냐**뿐이다: 이 항목은 노트 창이
     *  아니라 **네이티브 메뉴바(트레이) 메뉴**에 나타난다(macOS는 상단 메뉴바 아이콘). 앱 전역
     *  동작(모든 노트에 무언가 하기·전역 토글·설정 열기 대체)에 쓴다.
     *  **호스트 스코프라 클릭에는 창 컨텍스트가 없다**: 트레이는 특정 노트 창과 무관한 앱 전역
     *  자원이라, `run`의 첫 인자로 오는 `memo`의 창-스코프 호출(`ui.toast`·`editor.insertText`·
     *  `notes.current`)은 **마지막으로 쓴 메모 창**으로 폴백하거나, 그마저 없으면
     *  `CONTEXT_UNAVAILABLE` + 진단으로 끝난다(설정 화면 액션 버튼과 같은 계약). 특정 창에
     *  확실히 닿아야 하는 동작이면 트레이보다 툴바 버튼(`ui.addToolbarButton`)이 맞다.
     *  `run`은 **필수**다(없으면 `INVALID_ARGS` — 눌러도 아무 일도 일어나지 않는 항목을 만들지
     *  않는다). `label`도 **필수**다(빈 값은 `INVALID_ARGS` — 트레이에 보일 유일한 문자열이라
     *  글리프 폴백이 없다). `id`는 등록 수집기와 같은 계약: 생략하면 자동 생성, 같은 id는
     *  치환(진단 「중복 등록」). 등록은 다른 등록과 같은 마감(`runtime.ready()`)에 닫힌다 — 그
     *  뒤에 등록하면 이번 실행의 트레이에 나타나지 않고 진단에만 남는다.
     *  트레이는 네이티브가 그리므로 라벨은 **평문 텍스트**로만 나간다(마크업·스타일 없음).
     *  필요 권한: `ui`.
     */
    addTrayItem(args: {
      /** 이 항목의 안정 식별자. 생략하면 호스트가 만든다(같은 id 재등록은 치환). */
      id?: string;
      /** 트레이 메뉴에 보일 이름(필수 — 비면 INVALID_ARGS). */
      label: string;
      /** 클릭 실행 본문. 첫 인자 memo의 창-스코프 호출은 창 컨텍스트가 없어 폴백 계약을 탄다(위 설명 참고). */
      run: (memo: MemoApi) => void;
    }): Promise<MemoRegistration>;
  };
  settings: {
    /** 매니페스트 `settings` 스키마의 키 하나를 읽는다.
     *  저장된 값이 없으면 매니페스트 `default`가 병합돼 온다 — `main.js`에 기본값을 다시 적지 마라.
     *  **객체 인자 `{ key }`만 받는다.** `type: "list"`는 `{ name, body }[]` 배열로,
     *  `select`는 선언된 `value`로, `number`는 수로 정규화돼 온다. `list`는 언제나 구조화
     *  배열로 오며 저장 블롭을 그대로 받는 방법은 없다(문자열 축약형·`raw` 탈출구는 제거됐다).
     *  필요 권한: `settings`.
     *  반환: 선언되지 않은 키는 null.
     */
    get(args: { key: string }): Promise<unknown>;
    /** 선언된 모든 설정 키를 기본값이 병합된 스냅샷 하나로 읽는다.
     *  키 이름을 하나씩 정확히 맞춰야 하는 부담이 사라진다. `list`는 `settings.get`과 같이
     *  언제나 `{ name, body }[]` 구조화 배열로 온다(저장 블롭 그대로 받는 방법은 없다).
     *  필요 권한: `settings`.
     */
    getAll(): Promise<Record<string, unknown>>;
    /** 설정 키 하나에 값을 쓴다.
     *  `list` 키에는 `{ name, body }[]` 배열을 그대로 넘긴다 — 직렬화도 이름 살균도 호스트가 한다.
     *  매니페스트에 선언되지 않은 키는 백엔드가 버린다(브리지는 성공을 돌려주지만 진단에 남는다).
     *  필요 권한: `settings`.
     */
    set(args: { key: string; value: unknown }): Promise<null>;
  };
  events: {
    /** 노트·설정 생명주기 이벤트를 구독한다(핸들러는 이벤트가 난 창에 바인딩된 memo를 받는다).
     *  **해제(`off`)는 없다.** memo는 설정이 바뀔 때마다 모든 샌드박스를 파괴하고 다시 실행하므로,
     *  리스너 수명이 이미 「재빌드 1회」로 닫혀 있다 — VS Code의 Disposable 패턴을 흉내 내지 마라.
     *  재실행될 때마다 다시 구독하는 것이 계약이다(부팅 시 등록 = 매번 새로 등록).
     *  `handler`의 **첫 인자는 그 이벤트가 난 창에 바인딩된 `memo`**다(`onClick`과 같은 규약) —
     *  `note:saved` 핸들러에서 토스트를 띄우면 저장이 일어난 그 창에 뜬다. 전역 `memo`를 쓰면
     *  「마지막으로 클릭된 창」 폴백을 타 다른 창에 뜰 수 있다.
     *  **payload는 메타데이터뿐이다** — 본문은 절대 실리지 않는다. 본문이 필요하면 핸들러가 받은
     *  memo로 `notes.current()`를 따로 불러라(그래야 `notes:read` 경계가 유지된다).
     *  이름별 추가 권한: `note:opened` → `notes:read` · `note:saved` → `notes:read` · `note:focused` → `notes:read` · `note:blurred` → `notes:read` · `note:closed` → `notes:read` · `settings:changed` → 추가 권한 없음 (모두 `settings` 선언 위에 얹힌다).
     *  고빈도 이벤트(키 입력마다 나는 텍스트 변경)는 **의도적으로 없다** — 상주 샌드박스 하나가
     *  모든 창을 공유해 트래픽이 창 수 × 플러그인 수로 곱해진다. 여기 없는 이름은 지어내지 마라
     *  (모르는 이름은 `INVALID_ARGS`로 거부된다).
     *  필요 권한: `settings`.
     */
    on(args: {
      /** 생략하면 자동 생성. 같은 id로 다시 구독하면 추가가 아니라 치환(upsert)이다. */
      id?: string;
      /** 구독할 이벤트(닫힌 열거 — 목록 밖 값은 INVALID_ARGS). */
      name: MemoEventName;
      /** 이벤트마다 불린다. 첫 인자의 바인딩된 memo가 그 이벤트의 창을 가리킨다. */
      handler: (memo: MemoApi, payload: MemoEventPayload) => void;
    }): Promise<MemoRegistration>;
  };
  commands: {
    /** 툴바 버튼 없이 **단축키로만** 실행되는 명령을 등록한다(설정 › 단축키 › 「플러그인 동작」에 나타난다).
     *  버튼과 명령을 가르는 기준은 하나다 — **툴바에 자리를 차지해야 하는가.** 자주 쓰는 것은
     *  버튼(`ui.addToolbarButton`), 가끔 쓰거나 손이 키보드에 있을 때 쓰는 것은 명령이다.
     *  **기본 단축키는 줄 수 없다.** 등록하면 단축키 화면에 이름만 나타나고, 조합은 사용자가
     *  직접 배정한다(배정 전에는 실행할 방법이 없다 — 그것이 이 API의 계약이다). 플러그인이
     *  고른 조합을 몰래 심으면 사용자가 이미 쓰던 조합을 빼앗는다.
     *  `run`의 **첫 인자는 그 단축키를 누른 창에 바인딩된 `memo`**다(버튼 `onClick`과 같은 규약).
     *  전역 `memo`를 쓰면 「마지막으로 클릭된 창」 폴백을 타 다른 창에 결과가 간다.
     *  명령은 권한 우회로가 아니다: `run` 안에서 부르는 호출들이 각자 자기 권한 게이트를 그대로
     *  탄다(`commands` 권한이 여는 것은 「이름을 단축키 화면에 올리는 것」뿐이다).
     *  등록은 다른 등록과 같은 마감(`runtime.ready()`)에 닫힌다 — 그 뒤에 등록하면 이번 실행의
     *  단축키 목록에 나타나지 않고 진단에만 남는다.
     *  **설정 화면 액션 버튼도 여기 등록한 명령을 실행한다**: 매니페스트에
     *  `{ "type": "button", "label": "캐시 지우기", "command": "<이 id>" }`를 선언하면 설정 폼에
     *  버튼이 생기고, 누르면 이 `run`이 돈다(별도 콜백 API는 없다 — 경로가 한 벌이다).
     *  다만 **설정 창에는 메모가 없다**: 그 경로로 들어온 실행에는 창 컨텍스트가 없어
     *  `run` 안의 창-스코프 호출(`ui.toast`·`editor.insertText`·`notes.current`)은 폴백
     *  계약을 탄다(마지막으로 쓴 메모 창이 있으면 거기로, 없으면 `CONTEXT_UNAVAILABLE`).
     *  `when`의 정적 키(`platform.*`·`plugin.<id>.enabled`·`settings.<key>`)는 설정 버튼에서도
     *  **그대로 판정된다** — 보류되는 것은 메모 창의 상태를 봐야 하는 `note.isEmpty`뿐이다.
     *  그 키가 하나라도 있거나 `destructive: true`면(확인 팝업을 띄울 메모 창이 없다) 설정
     *  버튼으로는 실행되지 않고, 버튼 아래 상태 줄에 이유가 보인다 — 확인이 필요하면 매니페스트
     *  필드의 `confirm`을 쓰고, 설정 버튼용 명령에는 `note.isEmpty`를 걸지 마라.
     *  필요 권한: `commands`.
     */
    register(args: {
      /** 생략하면 자동 생성. **사용자의 단축키 배정이 이 id에 붙어 영속되므로** 직접 주고 바꾸지 마라(바꾸면 배정이 초기화된다). */
      id?: string;
      /** 단축키 화면에 보일 이름(필수 — 비면 INVALID_ARGS). 사용자가 이 문자열만 보고 무엇인지 알 수 있어야 한다. */
      title: string;
      /** 전부 참일 때만 실행된다(AND). 닫힌 키 목록 밖 값은 INVALID_ARGS — 조건 판정 결과는 플러그인에게 알려주지 않는다. */
      when?: MemoWhenKey[];
      /** true면 호스트가 실행 **전에** 그 창에 확인 팝업을 띄우고, 취소하면 `run`을 부르지 않는다(되돌릴 수 없는 동작에 쓴다). */
      destructive?: boolean;
      /** 실행 본문. 첫 인자의 바인딩된 memo가 그 단축키를 누른 창을 가리킨다. */
      run: (memo: MemoApi) => void;
    }): Promise<MemoRegistration>;
    /** 다른 플러그인이 **공개한**(exposes) 명령을 실행한다 — 플러그인 간 호출(중앙 호스트가 중계).
     *  호출은 **양쪽 동의**로만 성립한다: (1) 호출측은 `invoke:<대상 id>` 권한을 선언하고 사용자
     *  승인을 받는다(민감 — `network:<도메인>`과 같은 접두 권한, 대상마다 따로), (2) 대상은 그
     *  명령 id를 매니페스트 `exposes`에 넣어 공개한다(기본 비공개). 어느 한쪽이 없으면 거부된다
     *  (자격 없으면 `PERMISSION_UNDECLARED`/`PERMISSION_UNGRANTED`, 공개 안 됐으면 `INVOKE_NOT_EXPOSED`).
     *  두 샌드박스는 **절대 직접 통신하지 않는다** — 중앙 호스트가 대상의 등록된 명령 핸들러를
     *  역호출한다(명령 실행 경로 그대로: 대상의 `when`·`destructive` 선언이 그대로 걸린다).
     *  `args`는 대상 `run`의 **둘째 인자**로 전달된다(`function (memo, args) { … }`) — JSON 호환
     *  값만 건너온다(함수·창 컨텍스트는 못 넘긴다).
     *  **반환값은 없다(항상 null).** 명령의 `run`은 `(memo) => void`라 돌려줄 결과 자체가
     *  없다 — invoke는 대상 명령을 **디스패치**하고 곧바로 null로 끝난다. 대상이 한 일은 대상이
     *  자기 권한으로 부른 호출(toast·노트 쓰기 등)의 관측 가능한 효과로 확인한다.
     *  순환(A→B→A)은 호스트가 릴레이 깊이 상한으로 끊는다(`INVOKE_CYCLE`) — 대상을 부를 때는
     *  받은 바인딩된 `memo`를 쓰라(깊이 추적이 그 토큰을 따라간다).
     *  이 API는 **실험적(experimental)**이다: 실행되면 진단 채널(「최근 오류」)에 경고가 남고,
     *  다음 버전에서 인자·반환·의미가 바뀔 수 있다.
     *  필요 권한: `invoke:<pluginId>`(민감 — 사용자 승인 필요).
     *  **실험적(experimental)** — 실행되면 진단 채널에 경고가 남고, 다음 버전에서 인자·반환·의미가 바뀔 수 있다.
     *  반환: 대상 명령을 디스패치하면 즉시 null(대상의 반환값은 돌려주지 않는다 — 위 doc 참고).
     */
    invoke(args: {
      /** 부를 대상 플러그인 id(필수 — 비면 INVALID_ARGS). 이 id로 `invoke:<id>`를 선언·승인받아야 한다. */
      pluginId: string;
      /** 대상이 `exposes`로 공개한 명령 id(필수). 공개 안 된 명령은 INVOKE_NOT_EXPOSED, 공개했지만 등록 안 된 명령은 INVOKE_NO_TARGET. */
      commandId: string;
      /** 대상 명령 `run`의 둘째 인자로 전달되는 데이터(JSON 호환). 생략하면 대상은 undefined를 받는다. */
      args?: unknown;
    }): Promise<null>;
  };
  storage: {
    /** 플러그인 전용 저장소에서 값 하나를 읽는다(없으면 null).
     *  **`settings`와 무엇이 다른가:** `settings`는 매니페스트에 선언한 **사용자 대면** 스키마에
     *  묶여 있고 저장하면 전 플러그인이 재빌드된다. `storage`는 사용자에게 보이지 않는 내부
     *  상태의 자리이고 **재빌드를 유발하지 않는다**. 「사용자가 폼에서 고칠 값인가?」 하나로 갈린다.
     *  수명은 `scope`가 정한다(`MemoStorageScope` 참고) — 기본은 `local`(영속).
     *  JSON으로 직렬화되는 값만 담긴다(함수·클래스 인스턴스는 건너오지 못한다).
     *  `scope: "window"`는 **그 호출을 낳은 클릭·명령의 창**으로 간다. 창 컨텍스트가 없으면
     *  다른 창-스코프 호출과 같은 계약이다 — 조용한 null(`getAll`이면 `{}`) + 진단이고,
     *  `requireWindow: true`를 주면 `CONTEXT_UNAVAILABLE`로 거부된다.
     *  창 식별자는 플러그인에게 노출되지 않는다: 호스트가 이미 소유한 불투명 토큰을 키 네임스페이스로
     *  쓰므로, 창 관리 코드를 짤 필요도 남의 창 상태를 가리킬 방법도 없다.
     *  필요 권한: `storage`.
     */
    get(args: {
      /** 값의 이름(필수 — 비면 INVALID_ARGS). 서로 다른 저장이 같은 칸에 겹치지 않게 한다. */
      key: string;
      /** 생략하면 `"local"`. 목록 밖 값은 기본값으로 흡수되지 않고 INVALID_ARGS다(다른 서랍에 저장되는 무음 손상을 막는다). */
      scope?: MemoStorageScope;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<unknown>;
    /** 플러그인 전용 저장소에 값 하나를 저장한다(**재빌드를 유발하지 않는다**).
     *  **`settings`와 무엇이 다른가:** `settings`는 매니페스트에 선언한 **사용자 대면** 스키마에
     *  묶여 있고 저장하면 전 플러그인이 재빌드된다. `storage`는 사용자에게 보이지 않는 내부
     *  상태의 자리이고 **재빌드를 유발하지 않는다**. 「사용자가 폼에서 고칠 값인가?」 하나로 갈린다.
     *  수명은 `scope`가 정한다(`MemoStorageScope` 참고) — 기본은 `local`(영속).
     *  JSON으로 직렬화되는 값만 담긴다(함수·클래스 인스턴스는 건너오지 못한다).
     *  `scope: "window"`는 **그 호출을 낳은 클릭·명령의 창**으로 간다. 창 컨텍스트가 없으면
     *  다른 창-스코프 호출과 같은 계약이다 — 조용한 null(`getAll`이면 `{}`) + 진단이고,
     *  `requireWindow: true`를 주면 `CONTEXT_UNAVAILABLE`로 거부된다.
     *  창 식별자는 플러그인에게 노출되지 않는다: 호스트가 이미 소유한 불투명 토큰을 키 네임스페이스로
     *  쓰므로, 창 관리 코드를 짤 필요도 남의 창 상태를 가리킬 방법도 없다.
     *  필요 권한: `storage`.
     */
    set(args: {
      /** 값의 이름(필수 — 비면 INVALID_ARGS). 서로 다른 저장이 같은 칸에 겹치지 않게 한다. */
      key: string;
      /** 저장할 JSON 호환 값. 서랍 하나에 담기는 총량은 **스코프와 무관하게** 256KB이고, 넘치면 `code: "QUOTA_EXCEEDED"`로 거부된다(조용한 잘림이 아니다 — 그 값은 저장되지 않는다). */
      value: unknown;
      /** 생략하면 `"local"`. 목록 밖 값은 기본값으로 흡수되지 않고 INVALID_ARGS다(다른 서랍에 저장되는 무음 손상을 막는다). */
      scope?: MemoStorageScope;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
    /** 플러그인 전용 저장소에서 값 하나를 지운다(없어도 오류가 아니다).
     *  **`settings`와 무엇이 다른가:** `settings`는 매니페스트에 선언한 **사용자 대면** 스키마에
     *  묶여 있고 저장하면 전 플러그인이 재빌드된다. `storage`는 사용자에게 보이지 않는 내부
     *  상태의 자리이고 **재빌드를 유발하지 않는다**. 「사용자가 폼에서 고칠 값인가?」 하나로 갈린다.
     *  수명은 `scope`가 정한다(`MemoStorageScope` 참고) — 기본은 `local`(영속).
     *  JSON으로 직렬화되는 값만 담긴다(함수·클래스 인스턴스는 건너오지 못한다).
     *  `scope: "window"`는 **그 호출을 낳은 클릭·명령의 창**으로 간다. 창 컨텍스트가 없으면
     *  다른 창-스코프 호출과 같은 계약이다 — 조용한 null(`getAll`이면 `{}`) + 진단이고,
     *  `requireWindow: true`를 주면 `CONTEXT_UNAVAILABLE`로 거부된다.
     *  창 식별자는 플러그인에게 노출되지 않는다: 호스트가 이미 소유한 불투명 토큰을 키 네임스페이스로
     *  쓰므로, 창 관리 코드를 짤 필요도 남의 창 상태를 가리킬 방법도 없다.
     *  필요 권한: `storage`.
     */
    remove(args: {
      /** 값의 이름(필수 — 비면 INVALID_ARGS). 서로 다른 저장이 같은 칸에 겹치지 않게 한다. */
      key: string;
      /** 생략하면 `"local"`. 목록 밖 값은 기본값으로 흡수되지 않고 INVALID_ARGS다(다른 서랍에 저장되는 무음 손상을 막는다). */
      scope?: MemoStorageScope;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
    /** 그 스코프에 있는 값 전부를 객체 하나로 읽는다.
     *  **`settings`와 무엇이 다른가:** `settings`는 매니페스트에 선언한 **사용자 대면** 스키마에
     *  묶여 있고 저장하면 전 플러그인이 재빌드된다. `storage`는 사용자에게 보이지 않는 내부
     *  상태의 자리이고 **재빌드를 유발하지 않는다**. 「사용자가 폼에서 고칠 값인가?」 하나로 갈린다.
     *  수명은 `scope`가 정한다(`MemoStorageScope` 참고) — 기본은 `local`(영속).
     *  JSON으로 직렬화되는 값만 담긴다(함수·클래스 인스턴스는 건너오지 못한다).
     *  `scope: "window"`는 **그 호출을 낳은 클릭·명령의 창**으로 간다. 창 컨텍스트가 없으면
     *  다른 창-스코프 호출과 같은 계약이다 — 조용한 null(`getAll`이면 `{}`) + 진단이고,
     *  `requireWindow: true`를 주면 `CONTEXT_UNAVAILABLE`로 거부된다.
     *  창 식별자는 플러그인에게 노출되지 않는다: 호스트가 이미 소유한 불투명 토큰을 키 네임스페이스로
     *  쓰므로, 창 관리 코드를 짤 필요도 남의 창 상태를 가리킬 방법도 없다.
     *  필요 권한: `storage`.
     */
    getAll(args?: {
      /** 생략하면 `"local"`. 목록 밖 값은 기본값으로 흡수되지 않고 INVALID_ARGS다(다른 서랍에 저장되는 무음 손상을 막는다). */
      scope?: MemoStorageScope;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<Record<string, unknown>>;
  };
  notes: {
    /** 지금 열려 있는 노트의 id·절대경로·라이브 본문 + **선택 영역**을 읽는다.
     *  선택 영역(`selection`)이 여기 함께 오는 것이 「선택한 걸 ~해줘」류 플러그인의 정본
     *  경로다: 이 호출로 `selection.text`를 읽고, 변환한 문자열을
     *  `memo.editor.insertText({ text })`로 되쓰면 그 선택이 대체된다.
     *  **`insertText({ mode: "replace" })`를 쓰지 마라** — 그쪽은 문서 전체를 덮어쓴다.
     *  필요 권한: `notes:read`(민감 — 사용자 승인 필요).
     *  반환: 노트가 없거나 창 컨텍스트가 없으면 null.
     */
    current(args?: {
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<MemoCurrentNote | null>;
    /** 현재 노트를 복제(내용·옵션 동일)해 새 노트 창을 연다.
     *  필요 권한: `notes:write`(민감 — 사용자 승인 필요).
     */
    duplicate(args?: {
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
    /** 이 메모만의 옵션(배경·글자 크기·투명도·핀 등)을 전역 기본값으로 되돌린다.
     *  확인 다이얼로그와 실제 초기화는 네이티브 노트 창이 수행한다.
     *  필요 권한: `notes:write`(민감 — 사용자 승인 필요).
     */
    resetOptions(args?: {
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
    /** 모든 노트의 메타(id·제목·생성시각·숨김)를 읽는다 — **본문은 싣지 않는다**(그건 `notes.read`의 몫).
     *  창-스코프가 아니라 **호스트 스코프**다: 전역 데이터라 창 컨텍스트 없이(부팅 시점에도)
     *  동작하고, 바인딩된 memo가 필요 없다.
     *  **숨긴(hidden) 노트도 포함된다** — 이 권한의 존재 이유(전체 검색·백링크·통계)가 컬렉션
     *  전체를 봐야 성립하기 때문이고, 승인 문구도 그렇게 말한다. 사용자의 숨김 의도를 존중하려면
     *  `hidden` 플래그로 걸러라.
     *  `limit` 기본 500 · 상한 1000(넘긴 값은 1000으로 클램프) — 더 큰 컬렉션은 `offset`으로
     *  페이지를 넘긴다. 항목 순서는 호스트의 노트 나열 순서 그대로다(정렬 보장은 계약이 아니다).
     *  호스트는 결과를 약 1초 재사용할 수 있다(호출 폭주가 전체 노트 파일 IO로 이어지지 않게) —
     *  그 안의 반복 호출에는 방금 저장된 변경이 아직 안 보일 수 있다(최신성 보장은 계약이 아니다).
     *  필요 권한: `notes:all-read`(민감 — 사용자 승인 필요).
     */
    list(args?: {
      /** 최대 항목 수(기본 500, 상한 1000 — 초과는 1000으로 클램프). 1 미만·수가 아니면 INVALID_ARGS. */
      limit?: number;
      /** 건너뛸 항목 수(기본 0). 음수·수가 아니면 INVALID_ARGS. */
      offset?: number;
    }): Promise<MemoNoteSummary[]>;
    /** id로 노트 하나의 본문을 읽는다.
     *  id는 `notes.list`가 돌려준 **불투명 식별자**다 — 경로가 아니고, 경로 해석은 호스트가
     *  독점한다. 경로 형태(구분자·`..`·`:`)가 섞인 id는 호스트와 백엔드 **양쪽 경계**에서
     *  `INVALID_ARGS`로 거부된다(경로 인젝션 표면 차단). 반환에는 본문만 실린다(창 위치·투명도
     *  같은 노트 메타는 나가지 않는다 — 권한 문구가 약속한 것만 나간다).
     *  `notes.list`처럼 호스트 스코프다(창 컨텍스트 불필요).
     *  존재하지 않는 id는 조용한 null이 아니라 `code: "NOTE_NOT_FOUND"`로 거부된다.
     *  필요 권한: `notes:all-read`(민감 — 사용자 승인 필요).
     */
    read(args: {
      /** `notes.list`가 돌려준 노트 id(필수 — 비거나 경로 형태면 INVALID_ARGS). */
      id: string;
    }): Promise<MemoNoteContent>;
    /** **지금 열려 있지 않아도** 되는 임의 노트 하나의 본문을 쓴다(id로 지목 — 호스트 스코프).
     *  `editor.insertText`가 **열려 있는** 노트의 커서에 쓰는 것과 달리, 이건 `notes.list`로 찾은
     *  임의 id의 노트를 직접 쓴다(창 컨텍스트가 필요 없다 — `notes.list`/`notes.read`와 같은 결).
     *  `mode`를 생략하면 **비파괴 `append`**다(본문 끝에 이어붙여 기존 내용을 잃지 않는다 — 저마찰
     *  기본값). `mode: "overwrite"`는 본문을 통째로 덮지만, 호스트가 덮기 **전에** 이전 본문을
     *  복구 슬롯에 스냅샷하므로 되돌릴 수 있다(memo에는 undo도 휴지통도 없어 이 스냅샷이 유일한
     *  안전망이다). 권한은 `editor.insertText`와 **같은 `notes:write`**를 쓴다 — 별도 권한을 새로
     *  만들지 않았다(overwrite가 복구 가능해져 더 강한 게이트가 필요 없다).
     *  `id`는 `notes.list`가 준 **불투명 식별자**여야 한다 — 경로 형태(구분자·`..`·`:`)면
     *  `INVALID_ARGS`로 거부된다(경로 해석은 호스트 독점, vault 밖 접근 차단). 없는 id는
     *  `NOTE_NOT_FOUND`. `content`는 문자열이어야 한다.
     *  필요 권한: `notes:write`(민감 — 사용자 승인 필요).
     */
    write(args: {
      /** `notes.list`가 돌려준 노트 id(필수 — 비거나 경로 형태면 INVALID_ARGS). */
      id: string;
      /** 쓸 본문(문자열만). append면 이어붙일 내용, overwrite면 새 전체 본문. */
      content: string;
      /** 생략하면 `append`(비파괴). `overwrite`는 통째로 덮되 덮기 전 스냅샷을 남긴다(복구 가능). */
      mode?: "append" | "overwrite";
    }): Promise<null>;
  };
  clipboard: {
    /** 클립보드에 텍스트를 쓴다.
     *  클릭 등 사용자 제스처 문맥(버튼 onClick)에서 호출하라.
     *  필요 권한: `clipboard`(민감 — 사용자 승인 필요).
     */
    write(args: {
      text: string;
      /** true면 창 컨텍스트가 없을 때 조용한 null 대신 `code: "CONTEXT_UNAVAILABLE"`로 거부한다(기본 false). */
      requireWindow?: boolean;
    }): Promise<null>;
  };
  theme: {
    /** 테마 색 토큰을 등록한다(hex만).
     *  의미색(accent·danger·warning)은 라이트/다크 공통 단일 값, 표면색(surface·card·border·text)은
     *  `<key>`(라이트)와 `<key>-dark`(다크)를 따로 준다. 안 준 토큰은 CSS 폴백을 쓴다.
     *  **테마로 선택된 플러그인은 이 호출만 쓸 수 있다** — 그 실행 경로에서는 `background.register`·
     *  `font.register`·`editor.*`도 거부된다(테마 샌드박스는 등록을 수집한 즉시 폐기된다).
     *  여러 플러그인이 등록하면 마지막 등록이 이긴다(LastWins).
     *  능력 등록 — 매니페스트 `kind: "capability"`가 필요하다(`"action"`·미선언이면 `WRONG_PLUGIN_KIND`로 거부). 겹칠 때의 병합 규칙: `LastWins`.
     *  필요 권한: `theme`.
     */
    register(args: {
      tokens: Partial<Record<MemoThemeToken, string>>;
    }): Promise<MemoRegistration>;
  };
  background: {
    /** 노트 배경 스와치·자동 대비를 등록한다.
     *  `swatches`가 빈 배열이면 배경 선택 UI를 숨긴다. 여러 플러그인이 등록하면 첫 등록이 이긴다(FirstWins).
     *  능력 등록 — 매니페스트 `kind: "capability"`가 필요하다(`"action"`·미선언이면 `WRONG_PLUGIN_KIND`로 거부). 겹칠 때의 병합 규칙: `FirstWins`.
     *  필요 권한: `background`.
     */
    register(args: {
      swatches: string[];
      /** 배경 밝기에 맞춰 글자/버튼 틴트를 자동 대비할지(기본 true). */
      autoTextContrast?: boolean;
    }): Promise<MemoRegistration>;
  };
  font: {
    /** 설정 폰트 피커에 노출할 폰트 패밀리를 등록한다.
     *  여러 플러그인이 등록하면 순서를 보존한 합집합이고(Union), 같은 stack은 먼저 등록한 쪽만 남는다.
     *  `includeSystem`은 **목록이 아니라 스위치**다 — OS 글꼴 열거와 출처 표시는 호스트가 한다.
     *  능력 등록 — 매니페스트 `kind: "capability"`가 필요하다(`"action"`·미선언이면 `WRONG_PLUGIN_KIND`로 거부). 겹칠 때의 병합 규칙: `Union`.
     *  필요 권한: `font`.
     */
    register(args: {
      families: MemoFontFamily[];
      /** OS에 설치된 글꼴도 후보에 넣을지. */
      includeSystem?: boolean;
    }): Promise<MemoRegistration>;
  };
  window: {
    /** 노트 툴바의 창 컨트롤(투명도·항상 위·모든 데스크탑)을 제공한다는 능력 선언.
     *  컨트롤 id만 선언하고 실제 창 제어는 네이티브 노트 창이 수행한다. 여러 플러그인의 선언은
     *  합집합이다(Union). **`windows.open`(복수, 예약·민감)과 혼동하지 마라** — 한 글자 차이로
     *  권한 등급이 갈린다.
     *  능력 등록 — 매니페스트 `kind: "capability"`가 필요하다(`"action"`·미선언이면 `WRONG_PLUGIN_KIND`로 거부). 겹칠 때의 병합 규칙: `Union`.
     *  필요 권한: `window-control`.
     */
    register(args: {
      controls: MemoWindowControlId[];
    }): Promise<MemoRegistration>;
  };
  i18n: {
    /** 현재 활성 로케일 코드를 읽는다(권한 불필요).
     *  `runtime.info()`의 `os`와 같은 성격의 실행 환경 introspection이라 권한이 필요 없다 —
     *  값 자체가 민감하지 않다(설정 창 언어 드롭다운에 이미 노출돼 있다). **언어팩을 제공하는
     *  것과는 전혀 다른 호출이다**: 언어팩은 런타임 API가 아니라 매니페스트 선언
     *  (`contributes.translations` + 저위험 `i18n` 권한 + kind:"capability")이고, 이 호출은
     *  그 권한을 요구하지 않는다 — 요구하면 "지금 로케일이 뭔지 알고 싶을 뿐인" 평범한 action
     *  플러그인(예: 날짜 형식을 로케일에 맞게 고르는 위젯)이 언어팩 전용 권한을 선언해야 한다.
     *  **캐시된 값이다.** 중앙 호스트가 build()/단일 핫리로드마다 갱신해 이번 실행에 주입한다 —
     *  **이번 빌드가 시작된 시점**의 값으로 고정되고, 실행 중 언어를 바꿔도 다음 재빌드 전까지는
     *  바뀌지 않는다(`hostVersion`·`os`와 같은 캐싱 결).
     *  매니페스트 `nls`(`%키%` 자리표시자)가 활성 로케일 사전을 고를 때 참고하는 것과 같은
     *  코드 체계(BCP47 소문자 단순형, 예: `ko`·`en`·`en-us`)다.
     *  반환: 활성 로케일 코드(예: "ko"). 알 수 없으면 "ko".
     */
    locale(): Promise<string>;
  };
  runtime: {
    /** 등록 마감을 명시적으로 선언한다.
     *  **계약: 등록은 `runtime.ready()` 호출 시점 또는 부트스트랩의 조용-대기 폴백 중 먼저 오는
     *  쪽에 닫힌다.** 폴백(미해결 호출 0 + 한 틱, 상한 3초)은 계약이 아니라 편의다 — 비동기
     *  초기화가 있으면 등록을 마친 뒤 이 호출로 명시하라.
     *  브리지 왕복이 아니라 부트스트랩 로컬 신호다(등록 예산을 쓰지 않는다).
     */
    ready(): Promise<null>;
    /** 샌드박스가 파괴되기 직전에 불릴 정리 콜백을 등록한다(권한 불필요).
     *  설정을 하나만 바꿔도 **모든 플러그인 샌드박스가 파괴되고 다시 실행된다** — 런타임 상태는
     *  그때 통째로 사라진다. 이 호출이 그 순간을 알 수 있는 유일한 창구다.
     *  **보장의 한계(정직하게):** 호스트는 300ms만 기다리고 그 뒤 샌드박스를 파괴한다. 동기적으로
     *  끝나는 정리만 사실상 보장되고, 반환한 프라미스가 그 안에 정착하지 않으면 **완료되지 않는다**.
     *  그리고 **앱 종료 시점은 보장하지 않는다** — 웹뷰가 그냥 사라지므로 통지를 보낼 자리가 없다.
     *  오래 걸리는 일을 여기 넣지 말고, 지켜야 할 값은 그때그때 저장하고 여기서는 마지막 flush만 해라.
     *  브리지 왕복이 아니라 부트스트랩 로컬 등록이다(등록 예산을 쓰지 않는다). 여러 번 부르면
     *  핸들러가 **쌓인다**(치환이 아니다).
     */
    onDispose(args: {
      /** 파괴 직전에 불린다. 프라미스를 돌려주면 300ms 상한 안에서만 기다려 준다. */
      handler: (memo: MemoApi) => unknown;
    }): Promise<null>;
    /** 실행 환경 스냅샷을 읽는다(권한 불필요).
     *  `granted`는 **자기 자신의** 부여 집합이다 — 사용자가 민감 권한을 껐는지 확인해 조용히
     *  반쯤 죽는 대신 명시적으로 축소 동작할 수 있다. `hostVersion`은 진단·경고용이지 기능
     *  분기용이 아니다.
     */
    info(): Promise<MemoRuntimeInfo>;
    /** 진단 기록에 한 줄 남긴다(권한 불필요).
     *  플러그인은 불투명 origin iframe에서 도는 blob 스크립트라 devtools를 붙일 수 없다 — 이
     *  호출과 호스트가 자동 기록하는 거부가 저작자가 볼 수 있는 유일한 흔적이다.
     *  메시지는 2000자에서 잘리고 메모리에만 남는다(디스크 미기록).
     *  문자열 축약형 `memo.runtime.log("메시지")`도 받는다 — `{ message: "메시지" }`로 정규화된다
     *  (이 호출만의 예외다. 로그를 문자열로 부르는 것이 자연스러워 메시지를 버리지 않는다).
     */
    log(args: string | { message: string }): Promise<null>;
  };
  network: {
    /** 외부 서버에 https 요청을 보낸다 — 호스트가 대신 fetch하고 응답을 그대로 돌려준다.
     *  **샌드박스는 네트워크에 직접 닿지 못한다** — 이 호출은 호스트(Rust)에게 대신 요청하게
     *  시킨다. 그래서 승인 단위가 도메인이다: `network:<호스트>` 권한을 **URL 호스트마다** 선언·
     *  부여해야 하고(예 `network:api.example.com`), 선언 밖 호스트로는 나가지 못한다.
     *  https 전용이다(http·file 등은 `code: "NETWORK_SCHEME"`로 거부).
     *  호스트는 **사설/내부 IP·클라우드 메타데이터로 해석되는 주소를 차단**하고(SSRF 방어 —
     *  `code: "NETWORK_BLOCKED"`), **리다이렉트를 따라가지 않으며**(3xx를 그대로 반환), 쿠키·
     *  인증 헤더를 싣지 않는다(자격증명 미전달). 응답 본문은 5MiB·요청은 30초 상한이다.
     *  요청 헤더 중 Host·Cookie·Authorization 등 자격증명·전송 계층 헤더는 호스트가 떼어낸다.
     *  필요 권한: `network:<도메인>`(민감 — 사용자 승인 필요).
     */
    fetch(args: {
      /** 요청 URL(https만). 이 URL의 호스트가 곧 필요한 `network:<호스트>` 권한이다. */
      url: string;
      /** HTTP 메서드(생략하면 GET). GET·POST·PUT·PATCH·DELETE·HEAD만 허용(그 외는 NETWORK_METHOD). */
      method?: string;
      /** 요청 헤더 `[{ name, value }]`(응답과 같은 모양). Host·Cookie·Authorization 등은 호스트가 무시한다(자격증명 주입 차단). */
      headers?: MemoNetworkHeader[];
      /** 요청 본문 문자열. 객체는 `JSON.stringify` 후 넘긴다(호스트가 자동 직렬화하지 않는다). */
      body?: string;
    }): Promise<MemoNetworkResponse>;
  };
  browser: {
    /** 링크를 시스템 기본 브라우저로 연다(앱 밖 탐색).
     *  웹뷰 안에서는 절대 탐색하지 않는다 — URL을 네이티브로 넘겨 사용자의 기본 브라우저가
     *  연다. 스킴은 `http`·`https`·`mailto`만 통과하고, 그 밖(`file:`·`javascript:`·앱 핸들러를
     *  깨우는 커스텀 스킴)은 백엔드가 거부한다(`INVALID_ARGS`).
     *
     *  도메인별로 쪼갠 `network:<도메인>`과 달리 권한이 `browser:open` 하나인 이유: 여는 주소가
     *  대개 **노트 본문**에서 오므로 승인 시점에 목록화할 수 없다. 그래서 승인은 「이 플러그인이
     *  링크를 브라우저로 열 수 있다」 한 줄이고, 실제 방어는 스킴 제한이다.
     *
     *  인라인 패턴의 `action: "open-url"`도 같은 권한·같은 경로를 쓴다(클릭은 이 호출을 거치지
     *  않고 호스트가 직접 배선한다 — 마크다운 링크형 패턴을 만들 때 이 호출이 따로 필요하지 않다).
     *  필요 권한: `browser:open`(민감 — 사용자 승인 필요).
     */
    open(args: {
      /** 열 주소(`http`·`https`·`mailto`). 비었거나 다른 스킴이면 INVALID_ARGS다. */
      url: string;
    }): Promise<null>;
  };
}

/**
 * 전역 브리지. 등록 호출·`settings.*`는 이걸로 충분하지만, **창-스코프 호출**은
 * `onClick`이 넘겨주는 인자를 쓰는 게 정본이다 — 전역은 `.then` 체인과 브리지 호출 `await`까지만
 * 클릭한 창을 정확히 되짚는다(authoring.md "창 컨텍스트" 절).
 */
declare const memo: MemoApi;
