# 최소 예제

각 폴더는 `memo.*` API를 하나씩(많아야 두셋) 보여주는 **최소 단일-API 데모**다 — 동시에 CLI/하니스의
테스트 픽스처이기도 하다(`src/cli/memo-plugin/cli.test.ts`·`scaffold.test.ts`·`run-cmd.test.ts`가
특정 예제를 하드코딩해 부르고, `src/plugin/examples.test.ts`는 매 커밋 전수를 검증한다):

- `manifest.json`이 실제 검증기(`parseManifest`)를 통과한다
- `main.js`가 부르는 모든 `memo.*` 호출이 **존재하고**(예약이 아니고) 그 권한이 매니페스트에 선언돼 있다
- 선언했는데 한 번도 안 쓰는 권한이 없다
- `main.js`를 **실제 권한 게이트키퍼와 등록 수집기에 통과시켜 실행**했을 때 기대한 등록·호출이 일어난다

즉 이 예제들은 "예전에는 동작했던 코드"가 아니라 **지금 동작하는 것이 증명된 코드**다 — 다만 하나의
`memo.*` 호출을 어떻게 부르는지 보여줄 뿐, 실제 기능이 여러 호출·설정·권한을 어떻게 엮는지는
보여주지 않는다. **그건 번들 플러그인(`src/plugin/builtin/plugins/`, 19개)이 실사용 예다** —
아래 "실제 기능은 번들 플러그인을 보라" 참고.

| 예제(= 폴더 이름 = 매니페스트 `id`)                     | 무엇을 보여주나                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`example-starter`](./example-starter/)                 | 가장 작은 완본 — 등록 → `runtime.ready()` → `.catch`의 3단 골격                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`example-toolbar-button`](./example-toolbar-button/)   | 툴바 버튼 + 바인딩된 `memo` + 설정 기본값 + 실패를 사용자에게 보이기                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`example-window-calls`](./example-window-calls/)       | 여러 창-스코프 호출을 안전하게 순차 실행(왜 `Promise.all`+전역이 위험한지)                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`example-settings-button`](./example-settings-button/) | 설정 폼의 액션 버튼(`type: "button"` → `commands.register`)과 창 없는 실행의 계약                                                                                                                                                                                                                                                                                                                                                                                               |
| [`example-note-picker`](./example-note-picker/)         | `notes:all-read`(전체 노트 목록·읽기) 최소 사용례                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`example-headless-test`](./example-headless-test/)     | 버튼 + 설정 + 이벤트 구독 — 헤드리스 하니스(`memo-plugin run`/`test`)로 앱 없이 테스트하는 법                                                                                                                                                                                                                                                                                                                                                                                   |
| [`example-scaffold-output`](./example-scaffold-output/) | `memo-plugin scaffold`가 그대로 낸 산출물 — `memo-plugin types`로 타입 동봉 워크플로 안내                                                                                                                                                                                                                                                                                                                                                                                       |
| [`example-network-fetch`](./example-network-fetch/)     | `memo.network.fetch` 최소 사용례 — 도메인별 권한, https 전용·SSRF 차단·자격증명 미전달 등 호스트 방어, 실패 code 분기                                                                                                                                                                                                                                                                                                                                                           |
| [`example-note-append`](./example-note-append/)         | `notes.write`(mode:`append`) 최소 사용례 — 비파괴 이어붙이기, 호스트 스코프 × 창 스코프 잇기, 바인딩된 `memo`                                                                                                                                                                                                                                                                                                                                                                   |
| [`example-status-menu`](./example-status-menu/)         | `ui.addStatusItem`/`ui.updateStatusItem`/`ui.addMenuItem` 최소 사용례 — 호스트 스코프 등록 vs 창-스코프 갱신, 컨텍스트 메뉴 `when` 조건                                                                                                                                                                                                                                                                                                                                         |
| [`language-pack-en`](./language-pack-en/)               | `contributes.translations` 최소 사용례 — 언어팩에는 런타임 등록 API가 없어, `main.js` 없이(공백뿐) 매니페스트만으로 로케일 하나를 선언한다. `id`에 `example-` 접두를 안 붙인 유일한 예제(실제 언어팩 플러그인 id처럼 보이는 이름이 목적). **문서 전용 템플릿**이라 어떤 테스트도 픽스처로 쓰지 않는다. en 자체는 번들 언어팩 `src/plugin/builtin/language-packs/language-pack-en/`이 공급하고(같은 폴더 형태의 완성형), 이 예제는 en 이외의 언어를 만들 때 쓰는 축약 템플릿이다 |

## 쓰는 법

1. 폴더를 통째로 복사한다.
2. `manifest.json`의 `id`·`name`·`summary`·`purpose`를 자기 것으로 바꾸고 **폴더 이름도 `id`와 같게** 맞춘다(설치된 플러그인은 `id` 이름의 폴더에 놓이고, 스캔이 폴더명≠id를 탈락시킨다). `id`는 전역 고유여야 한다.
3. **테마·배경·폰트·창 컨트롤 능력을 등록한다면 `kind`를 `"capability"`로 바꾼다.** 예제 3개는 전부 `kind: "action"`이라, 그대로 두고 능력을 등록하면 런타임에서 전부 `WRONG_PLUGIN_KIND`로 거부된다(`lint`가 이것을 잡는다).
4. 편집기 자동완성: 각 예제의 `manifest.json`·`main.js`는 이 저장소 안에 있는 동안만 유효한 **상대경로**로 정본 스펙을 가리킨다(`"$schema": "../../manifest.schema.json"`, `/// <reference path="../../api-reference.d.ts" />`). 폴더를 저장소 밖으로 복사하면 그 경로가 깨지므로, 복사한 폴더에서 저장소 루트 기준으로 `npm run plugin -- types <복사한 폴더>`를 돌려라 — `docs/plugin/api-reference.d.ts`·`docs/plugin/manifest.schema.json`을 그 폴더에 실제로 복사하고 참조를 로컬 경로(`./plugin-api.d.ts`)로 갈아 끼운다(런타임에는 영향 없음).
5. 설정 창 「플러그인 → 로컬 폴더」로 그 폴더를 설치한다.
6. 저장소 루트에서 `npm run plugin -- lint <폴더>`로 자기 산출물을 검사한다(존재하지 않는 호출·미선언 권한·인자 개수·`kind` 게이트·**렌더 시점 게이트 권한** 등). `validate`는 매니페스트만 본다.
   - 기계가 파싱할 때(AI 에이전트·CI)는 **`npm run plugin --silent -- lint <폴더> --json`** — `--silent`가 없으면 npm 실행 배너(`> memo@0.1.0 plugin` 두 줄)가 JSON 앞에 붙어 `JSON.parse`가 죽는다. 배너를 아예 피하려면 `node src/cli/memo-plugin/cli.ts lint <폴더> --json`으로 직접 부른다.

계약 전체(호출별 인자·반환·권한·오류 코드)는 [`../api-reference.json`](../api-reference.json)에, 사람이 읽는 설명은 [`../authoring.md`](../authoring.md)에 있다.

## 실제 기능은 번들 플러그인을 보라

여기 예제는 API 하나씩만 최소로 보여준다. **여러 호출·설정·권한이 실제로 어떻게 엮이는지는
[`src/plugin/builtin/plugins/`](../../../src/plugin/builtin/plugins/)의 번들 19개를 봐라** —
도그푸딩되고(memo 앱 자체가 이 플러그인들로 돈다) 테스트·드리프트 가드로 매 커밋 최신 유지되는
**살아있는 실사용 예**다: 인라인 패턴은 `wikilink`·`kbd`, 툴바 버튼+설정은 `template`·
`copy-ai-prompt`, 창 컨트롤은 `transparency`, 블록 임베드는 `youtube-embed`, 상태 아이템은
`word-count`. 능력별 안내와 실제 코드 링크는 [`../authoring.md`](../authoring.md)의 해당 절에 있다.

번들은 예제와 목적이 달라 그대로 복사하기엔 잡음이 섞여 있다 — 플랫폼 게이트·능력 선언 같은 앱
전용 배선이 들어 있고, `.catch()`를 건 것이 하나도 없어 실패가 조용하다. **복사해서 시작할
골격은 위 최소 예제, 실제로 어떻게 짜는지 읽을 참고는 번들** — 이 둘을 나눠 써라.
