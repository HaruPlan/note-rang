<p align="center">
<img src="logo.png" alt="note-rang 로고" width="180" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows" />
</p>

<p align="center">
<b>노트랑 - 떠다니는 마크다운 스티키 메모</b>
</p>

<p align="center">
<img src="https://img.shields.io/badge/멀티%20플로팅%20윈도우-449300?style=flat-square" alt="멀티 플로팅 윈도우" />
<img src="https://img.shields.io/badge/멀티%20포인터-449300?style=flat-square" alt="멀티 포인터" />
<img src="https://img.shields.io/badge/마크%20다운-449300?style=flat-square" alt="마크 다운" />
<img src="https://img.shields.io/badge/플러그인-449300?style=flat-square" alt="플러그인" />
</p>

<p align="center">
  <sub><a href="./docs/README.en.md">English</a></sub>
</p>

## 주요 기능

- **떠 있는 노트 창** — 메모 하나가 창 하나다(테두리 없는 창). 세로로 줄이면 제목 줄만 남기고
  접힌다.
- **마크다운 라이브 프리뷰** — 원문을 그대로 둔 채 서식만 입힌다.
- **선택 서식 바** — 본문을 선택하면 굵게·기울임·취소선·코드·형광펜·링크·색 버튼이 선택 근처에
  뜬다. 마우스 드래그든 `Shift`+화살표·`Mod-A` 같은 키보드 선택이든 가리지 않는다.
- **노트 목록·검색 패널** — 즐겨찾기한 메모를 맨 위에 고정하고, 추가순·수정순·이름순·글자수
  순·최근 연 순으로 정렬한다(정렬 선택은 기기별로 저장된다).
- **툴바 배치** — 노트 창 위·아래 바의 네 존에 버튼을 끌어다 놓고, 안 쓰는 것은 치운다.
  플러그인 버튼도 같은 자리에서 다룬다.
- **테마와 색** — 테마를 고르고 색 토큰을 직접 편집한다. 노트 목록·검색 창의 배경·글자색은
  따로 지정할 수 있다.
- **시작 동작** — 앱을 직접 실행하면 메모 목록이 뜬다(로그인 항목 자동 실행에는 적용하지
  않는다). 열린 메모가 하나도 없을 때 목록을 띄울지 새 메모를 띄울지 고른다.
- **시작 가이드 메모** — 첫 실행 시 시작 가이드 메모가 자동으로 생긴다(설정 › 도움말에서
  다시 볼 수 있다).
- **단축키와 트레이** — 새 노트 같은 동작에 OS 전역 단축키를 배정하고, 메뉴바(트레이)에서
  앱을 부린다.
- **저장 폴더·백업·복구** — 메모는 고른 폴더에 순수 마크다운으로 쌓인다. 설정·플러그인은
  백업 파일로 내보내고 되돌릴 수 있고, 덮어쓰기로 저장된 노트는 지난 본문에서 복구한다.
- **플러그인** — 기능 상당수가 플러그인이고, 직접 만들어 설치할 수 있다(아래 표 ·
  [저작 가이드](docs/plugin/authoring.md)).

## 번들 플러그인

| 분류          | 플러그인                                                      | 기능                                             |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| 창·표시       | [항상 위](src/plugin/builtin/plugins/always-on-top)           | 메모 창을 다른 창 위에 고정                      |
| 창·표시       | [모든 데스크탑](src/plugin/builtin/plugins/all-desktops)      | 모든 macOS Space에서 메모 표시                   |
| 창·표시       | [투명도](src/plugin/builtin/plugins/transparency)             | 메모 창 투명도 조절(macOS)                       |
| 창·표시       | [배경](src/plugin/builtin/plugins/background)                 | 메모별 배경색과 읽기 좋은 글자색 적용            |
| 창·표시       | [글자 크기](src/plugin/builtin/plugins/font-scale)            | 메모별 글자 크기 조절                            |
| 창·표시       | [글꼴](src/plugin/builtin/plugins/font)                       | 시스템·설치 글꼴 선택                            |
| 창·표시       | [옵션 초기화](src/plugin/builtin/plugins/reset-options)       | 메모별 표시 옵션을 전역 기본값으로 복원          |
| 편집          | [템플릿](src/plugin/builtin/plugins/template)                 | 템플릿 저장·삽입 및 날짜·커서 변수 치환          |
| 편집          | [메모 복제](src/plugin/builtin/plugins/duplicate)             | 본문과 메모별 설정을 새 메모로 복제              |
| 편집          | [AI 프롬프트 복사](src/plugin/builtin/plugins/copy-ai-prompt) | 사용자 문구와 메모 내용을 조합해 클립보드로 복사 |
| 편집          | [단어 수](src/plugin/builtin/plugins/word-count)              | 실시간 단어·글자 수 표시 및 복사                 |
| 마크다운 확장 | [하이라이트](src/plugin/builtin/plugins/highlight)            | `==텍스트==` 강조                                |
| 마크다운 확장 | [글자 색](src/plugin/builtin/plugins/text-color)              | `{{텍스트\|#f36}}` 글자 색 지정                  |
| 마크다운 확장 | [스포일러](src/plugin/builtin/plugins/spoiler)                | `\|\|텍스트\|\|` 숨김 처리                       |
| 마크다운 확장 | [밑줄](src/plugin/builtin/plugins/underline)                  | `++텍스트++` 밑줄                                |
| 마크다운 확장 | [위첨자](src/plugin/builtin/plugins/superscript)              | `^텍스트^` 위첨자                                |
| 마크다운 확장 | [키보드 표기](src/plugin/builtin/plugins/kbd)                 | `{{Cmd+C}}` 키캡 표기                            |
| 연결·임베드   | [위키링크](src/plugin/builtin/plugins/wikilink)               | `[[제목]]`으로 다른 메모 연결·자동완성           |
| 연결·임베드   | [YouTube 임베드](src/plugin/builtin/plugins/youtube-embed)    | `youtube` 코드 블록의 링크를 플레이어로 표시     |

### 언어

한국어와 영어를 기본 내장한다(설치 과정 없음, OS 언어에 따라 자동 선택). 「설정 › 외형 ›
테마」의 언어 드롭다운에서 언제든 바꿀 수 있고, 다른 언어는 [언어팩
플러그인](docs/plugin/examples/language-pack-en/) 템플릿으로 직접 만들어 추가할 수 있다.

## 설치

### Mac OS

```bash
brew install --cask haruplan/tap/note-rang
```

이 tap을 신뢰할 수 있을 때만 설치한다.

### Windows

릴리스에 Windows 설치 파일(`.exe`)도 함께 올라간다.

> 서명되지 않은 빌드에서는 SmartScreen이 경고할 수 있으며, 이 경우 「추가 정보 → 실행」을 선택하면 설치할 수 있다.

## 기여

개발 환경, 품질 게이트, 빌드·배포, 아키텍처와 데이터 레이아웃은
[CONTRIBUTING.md](CONTRIBUTING.md)에서 안내한다. 스타일 규약은
[docs/contributing/style.md](docs/contributing/style.md), 전체 문서 색인은
[docs/README.md](docs/README.md)를 참고한다.
