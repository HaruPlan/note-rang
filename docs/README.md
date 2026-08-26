# 문서 색인

**무엇이 있고, 어떤 스펙으로 구성됐고, 어떻게 기여하는가**만 담는다 —
"왜 이렇게 만들었나"(설계 근거)와 시점별 진행 로그는 git 히스토리가 보관한다.

## plugin/ — 플러그인 저작 정본

| 파일                                                  | 무엇                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| [`features.md`](plugin/features.md)                   | 이 API로 무엇을 할 수 있는가 — 기능 한눈에.                            |
| [`authoring.md`](plugin/authoring.md)                 | 플러그인 작성 가이드(정본).                                            |
| [`authoring-for-ai.md`](plugin/authoring-for-ai.md)   | AI 저작자용 압축 워크플로 + 자주 틀리는 함정.                          |
| [`api-reference.json`](plugin/api-reference.json)     | 기계가독 계약 전수(호출·타입·오류 코드·매니페스트 스키마). **생성물.** |
| [`api-reference.d.ts`](plugin/api-reference.d.ts)     | 편집기 자동완성용 앰비언트 타입 선언. **생성물.**                      |
| [`manifest.schema.json`](plugin/manifest.schema.json) | 매니페스트 필드 전수의 JSON Schema 정본. **생성물.**                   |
| [`examples/`](plugin/examples/)                       | 설치 가능한 최소 단일-API 데모(+ CLI/하니스 테스트 픽스처).            |

**생성물은 손으로 고치지 마라.** `api-reference.*`와 `manifest.schema.json`(에 임베드되는 계약)은
`src/plugin/api-index.ts`가 정본이고, 다음으로 재생성한다:

```
MEMO_GEN_PLUGIN_API=1 npx vitest run src/plugin/api-index.test.ts
```

생성물과 커밋본이 다르면 드리프트 가드가 실패한다.

**실사용 레퍼런스는 번들(`src/plugin/builtin/plugins/`), 최소 데모는 `examples/`** — 여러
호출·설정·권한이 실제로 어떻게 엮이는지는 도그푸딩되는 번들 플러그인을, API 하나만 빠르게 확인할
때는 examples를 봐라(`examples/README.md` 참고).

## contributing/ — 기여·릴리스

| 파일                                              | 무엇                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| [`style.md`](contributing/style.md)               | 코드 스타일 규약.                                                |
| [`i18n.md`](contributing/i18n.md)                 | UI 문자열(i18n) 규약.                                            |
| [`architecture.md`](contributing/architecture.md) | 설정 변경이 열려 있는 창에 반영되는 경로(국소 반영·조정·리로드). |
| [`release.md`](contributing/release.md)           | Homebrew tap 배포 절차와 키 관리.                                |

개발 환경·품질 게이트·앱 전체 구조는 [CONTRIBUTING.md](../CONTRIBUTING.md)가 정본이다 —
이 폴더는 그 한 절만으로는 부족한 주제를 하나씩 파고든다.
