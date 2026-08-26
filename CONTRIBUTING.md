# 기여 가이드

플로팅 마크다운 메모앱(macOS·Windows, Tauri v2 + CodeMirror 6). 상세 코드 규약은
[docs/contributing/style.md](docs/contributing/style.md)를 참고한다.

## 개발 환경

- Node 24+(Active LTS), Rust stable, 각 OS의 Tauri 네이티브 빌드 도구(Xcode 또는 Microsoft C++ Build Tools).
- 설치: `npm install` (프론트 + Tauri CLI). Rust 의존성은 첫 빌드 시 받음.
- 실행: `npm run tauri dev`.

## 품질 게이트 (필수)

모든 변경은 아래를 통과해야 한다. 프리커밋 훅(`lint-staged`)이 일부를
자동 적용하고, CI가 전체를 강제한다.

| 영역   | 명령                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 프론트 | `npm run check` (format·lint·knip·test)                                                                                                                                                                                  |
| E2E    | `npm run test:e2e` (Playwright WebKit)                                                                                                                                                                                   |
| Rust   | `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo machete src-tauri` |

- **테스트**: 모든 기능은 **회귀/가드 테스트**와 함께 머지한다. 테스트는 의도된
  동작을 고정해, 이후 수정이 기능을 잘못된 방향으로 바꾸면 즉시 실패하게 한다.
- **미사용 금지**: 죽은 코드·미사용 파일/의존성 0 (knip, cargo-machete, clippy).
- **함수 doc 주석**: 모든 함수에 역할·목적(무엇을·왜)을 명시한다.
- **GUI 동작**(투명도·always-on-top·IME·임베드)은 유닛이 불가하므로 수동
  체크리스트/스크린샷으로 검증한다.

## 커밋

- 한 커밋 = 한 논리적 변경. 메시지는 명령형 현재시제(`add tray menu routing`).
- 게이트가 초록이 아닌 코드는 머지하지 않는다.

## 빌드 / 배포

```bash
npm run tauri build                 # src-tauri/target/release/bundle/ 에 .app + .dmg
```

배포는 Homebrew tap으로 한다. `v*` 태그를 밀면 [Release 워크플로](.github/workflows/release.yml)가
유니버설 DMG와 updater 아티팩트를 만들어 릴리스 초안에 올린다. 절차와 키 관리는
[릴리스 가이드](docs/contributing/release.md)를 참고한다.

## 아키텍처

- **노트 1개 = WebviewWindow 1개**(borderless·transparent). `?note=<id>`로 노트창,
  `?panel=1`로 목록·검색 패널을 마운트한다(`src/main.ts`).
- **Rust(`src-tauri/src/`)**는 단일 진실원천이다. 노트 CRUD·원자적 파일 IO·사이드카/설정·
  디스플레이 위치·검색·트레이·전역 단축키·자동실행을 담당하며, 프론트는
  `src/shared/tauri.ts` IPC 래퍼만 통해 접근한다.
- **프론트(`src/`)**는 TypeScript + CodeMirror 6으로 구성된다. `note/`(에디터·툴바·창),
  `panel/`, `theme/`, `plugin/`(샌드박스·브리지·권한·에디터 API), `shared/`로 나뉜다.
- **플러그인 보안**은 격리 realm(iframe `sandbox=allow-scripts`) + 브리지 + 매니페스트
  선언 권한 게이트로 구성한다. 저위험(ui/editor/commands/settings)은 선언만으로,
  민감(notes/vault/network/clipboard/windows/`embed:<domain>`)은 선언과 로컬 부여가 모두
  있어야 허용한다.
- **설정 변경 반영**은 바뀐 것에 따라 세 갈래다 — 창이 값만 다시 읽는 국소 반영, 중앙 호스트
  재빌드 뒤의 제자리 조정(reconcile), 그리고 리로드. 판정 규칙·화이트리스트 위치와 새 설정
  키·표면을 더할 때의 체크리스트는 [docs/contributing/architecture.md](docs/contributing/architecture.md)에 있다.

## 데이터 레이아웃

```
<vault>/  (기본 ~/Documents/note-rang, 설정에서 변경 가능)
  notes/<uuid>.md        # 본문(순수 마크다운)
  notes/<uuid>.json      # 노트별 메타(창 위치·override·hidden 등, 원자적 쓰기)
  .memo/shared-settings.json   # 동기화 설정(테마·기본값)
```

기기 고유 설정(vault 경로·자동실행·전역 단축키·플러그인 권한 부여)은 앱데이터
(`~/Library/Application Support/com.haruplan.note-rang/`)에 따로 둔다. vault 경로의 순환을
막고, 동기화한 권한 값을 신뢰하지 않기 위해서다.
