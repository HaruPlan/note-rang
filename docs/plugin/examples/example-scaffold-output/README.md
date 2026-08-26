# 예제: `memo-plugin scaffold` 산출물

이 폴더는 손으로 쓴 예제가 아니라 실제 명령이 그대로 낸 결과물입니다(도그푸딩):

```
npm run plugin -- scaffold example-scaffold-output --template=settings-driven --no-types
```

설정(인사말·말투)을 읽어 버튼을 누르면 토스트로 보여주는 최소 골격입니다 — `settings-driven` 템플릿의 목적은 기능이 아니라 **매니페스트 `settings[]`를 손으로 맞추는 실수를 없애는 법**을 보여주는 것입니다.

## 설정

| 키         | 타입     | 뜻                                          |
| ---------- | -------- | ------------------------------------------- |
| `greeting` | `text`   | 버튼을 누르면 보여줄 문구(기본: 안녕하세요) |
| `style`    | `select` | `formal`(높임) / `casual`(반말)             |

## 무엇을 보여주나

### 1. scaffold는 생성 직후 스스로 검사한다

`npm run plugin -- scaffold`는 파일을 쓰고 끝나지 않습니다 — 마지막 단계로 **실물 `lint`를 자기 산출물에 돌려** 결과를 함께 보고합니다. 템플릿에 버그가 있으면(존재하지 않는 호출, 미선언 권한, `.catch` 누락 등) 그 자리에서 오류로 드러납니다. 이 폴더가 저장소에 있다는 사실 자체가 "이 템플릿은 지금 lint를 통과한다"는 증거입니다(`src/plugin/examples.test.ts`가 매 커밋 다시 확인합니다).

### 2. `memo-plugin types`로 타입을 동봉한다

이 폴더는 `--no-types`로 만들어 다른 정본 예제와 같은 3파일(`manifest.json`·`main.js`·`README.md`) 구성을 유지합니다. 편집기 자동완성을 받으려면 저장소 루트에서:

```
npm run plugin -- types docs/plugin/examples/example-scaffold-output
```

를 돌리면 그 자리에 두 가지가 생깁니다:

- **`settings.d.ts`** — `manifest.json`의 `settings[]`에서 유도한 타입. `greeting: string`, `style: "formal" | "casual"`(옵션의 **value** 리터럴 유니온 — 라벨이 아닙니다). `getAll()`은 `Record<string, unknown>`을 돌려주므로 `main.js`에서 `unknown`을 한 번 거쳐 이 타입으로 좁혀 씁니다 — 생성된 `settings.d.ts` 헤더에 그대로 베낄 스니펫(`var s = /** @type {…PluginSettings} */ (/** @type {unknown} */ (cfg));`)이 들어 있고, 그러면 오타·타입 착각이 편집기에서 바로 잡힙니다.
- **`plugin-api.d.ts`** — 저장소의 `docs/plugin/api-reference.d.ts`(생성물) 그대로 복사본. `main.js` 첫 줄에 `/// <reference path="./plugin-api.d.ts" />`가 자동으로 붙습니다.

이 폴더에 그 두 파일을 커밋해 두지 않는 이유: `plugin-api.d.ts`는 저장소가 진화할 때마다(다른 웨이브가 API를 늘릴 때마다) 함께 바뀌는 **움직이는 목표**라, 여기 박아 두면 언젠가 반드시 낡습니다(그 낡음을 `memo-plugin validate`가 `PLUGIN_API_DTS_STALE` 경고로 잡습니다 — 직접 겪어 보려면 위 명령으로 생성한 뒤 `docs/plugin/api-reference.d.ts`가 다음에 바뀔 때 `npm run plugin -- validate`를 돌려 보세요).

### 3. 다른 템플릿

같은 명령으로 템플릿 3개를 더 받을 수 있습니다:

```
npm run plugin -- scaffold my-plugin --template=inline-pattern    # 가장 작은 완본(등록 하나)
npm run plugin -- scaffold my-plugin --template=toolbar-button    # 툴바 버튼 + 바인딩된 memo
npm run plugin -- scaffold my-plugin --template=command           # 버튼 없는 명령(단축키 전용)
```

`--dir`을 생략하면 현재 폴더 아래 `./<id>`에 만듭니다. 전체 옵션은 `npm run plugin -- --help`.
