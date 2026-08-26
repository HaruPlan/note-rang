# 배포

**macOS는 Homebrew 개인 tap으로 배포한다.** 설치는 이 한 줄이다.

```bash
brew install --cask haruplan/tap/note-rang
```

이 tap을 신뢰할 수 있을 때만 설치한다.

**Windows는 릴리스의 `.exe`(NSIS) 직접 내려받기다.** 서명하지 않으므로 SmartScreen이 "Windows에서
PC를 보호했습니다"를 띄울 수 있다 — 사용자가 「추가 정보 → 실행」을 누르면 된다.

두 플랫폼 모두 앱 갱신은 [Tauri updater](#업데이트-확인-경로)가 스스로 한다.

## 최초 1회 준비

새 리포(`HaruPlan/note-rang`)에서 처음 릴리스하기 전에 아래 넷을 갖춰야 한다. 하나라도 빠지면
릴리스 워크플로가 **빌드까지는 성공하고 배포에서 조용히 어긋난다**

### 1) updater 서명 키

```bash
npm run tauri signer generate -- -w <개인키를 둘 경로>
```

### 2) GitHub 리포 secret 두 개

`Settings → Secrets and variables → Actions`에 등록한다.

| 이름                        | 값                                                                        | 없으면 벌어지는 일                                                                          |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY` | 생성한 개인키 파일의 **내용 전체**                                        | updater 아티팩트에 서명이 없어 `latest.json` 업로드가 조용히 스킵된다(= 자동 업데이트 없음) |
| `TAP_TOKEN`                 | fine-grained PAT — `HaruPlan/homebrew-tap`의 **Contents: Read and write** | Homebrew tap 갱신 워크플로가 푸시 단계에서 실패한다                                         |

## 릴리스 절차

### Actions에서 버전만 입력한다

`Actions → Release → Run workflow`에서 버전(`0.2.0`, `v` 없이)을 넣고 실행한다. 그러면
[Release 워크플로](../../.github/workflows/release.yml)가 한 실행 안에서:

1. `prepare` — semver 검증 → 태그 중복 확인 → 네 파일(`package.json`·`package-lock.json`·
   `src-tauri/Cargo.toml`+`Cargo.lock`·`src-tauri/tauri.conf.json`) 버전 올리기 → 일치 검증 →
   `chore(release): v0.2.0` 커밋 + 태그 푸시.
2. `release` (macOS → Windows **순차**) — 각자 설치 파일과 updater 아티팩트를 만들어 **같은
   릴리스 초안**에 올린다. macOS는 유니버설 DMG + `.app.tar.gz(.sig)`, Windows는 NSIS `.exe` +
   MSI.
3. 사람이 **초안을 검토하고 게시한다.** 게시해야 `releases/latest`가 움직여 설치 URL과 updater
   엔드포인트가 새 버전을 가리킨다.
4. 게시가 [Homebrew tap 워크플로](../../.github/workflows/homebrew.yml)를 깨워 DMG의 sha256을
   계산하고 tap의 `Casks/note-rang.rb`를 갱신·푸시한다. **여기서부터는 손댈 것이 없다.**

> **왜 버전 입력과 빌드가 한 워크플로에 있나:** `GITHUB_TOKEN`으로 민 태그는 **다른 워크플로를
> 깨우지 않는다**(GitHub의 무한루프 방지). "bump 워크플로가 태그를 밀면 release 워크플로가
> 돈다"는 구성은 조용히 아무 일도 하지 않는다. `needs:`로 같은 실행 안에서 이으면 토큰을 늘리지
> 않고도 확실하다.

### latest.json은 병합된다 — 단, 잡이 순차일 때만

tauri-action은 릴리스에 이미 올라간 `latest.json`을 내려받아 `platforms` 맵을 승계한 뒤 자기
플랫폼 키만 얹는다(draft 릴리스에서도 동작한다 — 태그로는 못 찾으므로 릴리스 목록을 훑어
매칭한다). **덮어쓰기가 아니라 병합이다.** 다만 이것은 읽기-고치기-쓰기라 두 잡이 겹쳐 돌면
나중에 쓴 쪽이 상대 플랫폼 키를 통째로 날린다. 그래서 워크플로에 `max-parallel: 1`이 걸려 있다 —
**지우지 말 것.** 지우면 한쪽 OS의 자동 업데이트가 조용히 끊긴다.

두 번째 함정: tauri-action이 기존 `latest.json`을 찾을 때 릴리스 자산을 `per_page: 50`으로
한 번만 조회한다(페이지네이션 없음). 자산이 50개를 넘으면 병합 없이 덮어쓴다. 지금은 플랫폼당
서너 개라 여유가 있지만, 산출물을 늘릴 때 기억할 것.

릴리스를 낸 뒤 `latest.json`을 열어 **`darwin-*`과 `windows-x86_64`가 모두** 들어 있는지 한 번
확인하면 위 두 함정이 다 걸린다.

### latest.json의 다운로드 주소는 후처리로 갈아끼운다

tauri-action은 `latest.json`의 `url`을 **조건 없이** GitHub API 자산 주소
(`https://api.github.com/repos/.../releases/assets/<id>`)로 쓴다(`src/upload-version-json.ts`).
초안 릴리스의 자산도 집을 수 있어야 해서다. 그런데 이 주소는 **인증 없는 API 호출**이라 출발지
IP당 시간당 60회 제한을 받는다. 사내망처럼 NAT 뒤에서 IP를 공유하는 곳은 그 쿼터가 이미 소진돼
있기 십상이고, 그러면 사용자는 「설치」를 누른 순간 `403`을 본다. **버전 확인은 `github.com`으로
나가 멀쩡히 통과한 뒤라 증상이 헷갈린다** — "새 버전이 있다고는 하는데 설치만 실패"로 보인다.
`api.github.com`만 막는 프록시, User-Agent를 지우는 프록시(이 호스트는 UA가 없으면 무조건 403)도
같은 자리에서 터진다.

그래서 워크플로의 `updater-urls` 잡이 매트릭스가 끝난 뒤 한 번 돌면서 그 주소를
`https://github.com/<소유자>/<리포>/releases/download/<태그>/<파일명>`으로 바꿔 다시 올린다.
익명 CDN 경로라 쿼터도 UA 요구도 없다. 태그와 파일명만으로 결정되므로 초안 시점에 미리 적어 둘 수
있다 — 게시 전에는 404지만, 클라이언트가 이 파일을 읽는 시점은 언제나 게시 후다. 가리키는 바이트가
같은 파일이라 `signature`는 손대지 않는다.

가드가 둘이다. 치환 뒤에도 `api.github.com`이 하나라도 남으면 잡을 실패시킨다(전체가 아니라 일부
플랫폼만 조용히 깨지는 형태라 늦게 발견된다). `latest.json`이 참조하는 자산 id가 이 릴리스에 없으면
— 위 병합 규칙 때문에 다른 릴리스 것을 승계했다는 뜻이다 — 파일명을 추측해 URL을 만드는 대신 끊는다.
잘못 짚으면 서명과 짝이 맞지 않는 파일을 가리키게 된다.

## 아키텍처와 로컬 빌드

릴리스는 macOS를 `--target universal-apple-darwin`으로 빌드한다. 단일 아키텍처 빌드는 다른 쪽
Mac에서 아예 실행되지 않는다(서명과 무관한 별개 문제다). 로컬에서 유니버설을 만들려면 두 타깃이
설치돼 있어야 한다.

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**TLS는 OS 것을 쓴다**(`native-tls` — macOS `Security.framework`, Windows `schannel`). 그래서
빌드에 C 툴체인이 따로 필요 없다. reqwest 0.13에서 `default-tls`가 rustls + aws-lc-rs로 바뀐
탓에 한때 C 암호 라이브러리 둘(`aws-lc-sys`·`ring`)이 함께 링크됐는데 — 서로 다른 의존성이 각자
다른 rustls provider를 골라서다 — 지금은 둘 다 그래프에 없다. 새 의존성을 넣을 때 이 둘이나
`rustls`가 다시 딸려오는지 보면 된다.

```bash
cargo tree -i aws-lc-sys --target x86_64-pc-windows-msvc   # "없음"이어야 정상
```

macOS에서 Windows 타깃 컴파일을 끝까지 검증하지는 못한다 — `tauri-build`가 Windows 리소스
컴파일러(`llvm-rc`/`rc.exe`)를 요구한다. Windows 컴파일 검증은 CI의 `rust (windows-latest)`
잡이 담당한다.

`bundle.createUpdaterArtifacts`는 `tauri.conf.json`이 아니라 **워크플로의 `--config`로만** 켠다.
켜 두면 번들러가 서명 개인키를 요구해, 키가 없는 로컬 `npm run tauri build`가 에러로 끊기기
때문이다.

## 업데이트 확인 경로

[`src-tauri/src/updater.rs`](../../src-tauri/src/updater.rs)에 진입점이 둘이다.

- **시작 시 자동 확인** — 릴리스 빌드에서만, 새 버전이 있을 때만 말을 건다. 개발 빌드가 스스로를
  덮어쓰지 않게 디버그 빌드에서는 아예 돌지 않는다.
- **트레이 「업데이트 확인…」** — 최신이든 실패든 결과를 항상 알린다.

둘 다 아래 같은 경로를 탄다.

1. **조회** — `plugins.updater.endpoints`의 `latest.json`을 `GET`한다(`User-Agent:
tauri-plugin-updater/<버전>`, `Accept: application/json`). 릴리스 빌드는 https만 허용한다.
   응답이 `204`면 "업데이트 없음"으로 즉시 끝난다. 엔드포인트 URL에 `{{target}}`·`{{arch}}`·
   `{{current_version}}` 플레이스홀더를 쓸 수 있지만 이 앱은 정적 URL 하나만 쓴다.
2. **플랫폼 키 선택** — `{os}-{arch}-{installer}`를 먼저 찾고 없으면 `{os}-{arch}`로 떨어진다.
   Windows NSIS 설치본이면 `windows-x86_64-nsis` → `windows-x86_64`, MSI 설치본이면
   `windows-x86_64-msi` → `windows-x86_64` 순이다. 워크플로의 `updaterJsonPreferNsis: true`가
   NSIS를 무접미 키에 앉히므로(기본값 `false`면 MSI가 차지한다) 두 경로 모두 맞는 파일을 집는다.
3. **버전 비교** — 기준이 되는 "현재 버전"은 **`tauri.conf.json`의 `version`**(빌드 시 바이너리에
   박힌다). semver **엄격 초과**일 때만 업데이트로 친다 — 같거나 낮으면 다운그레이드하지 않는다.
   `latest.json`의 `pub_date`는 **RFC 3339가 아니면 응답 파싱 자체가 실패**한다.
4. **다운로드 + 서명 검증** — 설치 파일 바이트를 받아, **압축 해제 전 원본 전체**를 `latest.json`의
   `signature`와 앱에 박힌 `pubkey`로 minisign 검증한다. Apple 서명과는 완전히 별개 체계이고,
   "이 패키지를 만든 게 개발자 본인인가"만 본다.
5. **설치** — 플랫폼마다 다르다.
   - **macOS**: `.app.tar.gz`를 풀어 번들을 교체하고, `download_and_install`이 정상 반환한 뒤
     코드에서 `app.restart()`를 부른다.
   - **Windows**: `installMode: "passive"`이므로 NSIS 인스톨러를 `/P /UPDATE /R /ARGS <현재 실행
인자>`로 띄운다(진행률 바만 보이고 사용자 입력은 없다). 인스톨러가 실행 중인 앱을 죽이고,
     설치 후 `/R`이 앱을 다시 띄운다. **플러그인은 인스톨러를 띄운 직후 `std::process::exit(0)`
     으로 프로세스를 끝내므로 `download_and_install` 뒤의 코드는 Windows에서 실행되지 않는다** —
     종료 직전에 할 일이 생기면 `UpdaterBuilder::on_before_exit` 훅에 걸어야 한다(현재 미사용).

`installMode`를 `basicUi`로 바꾸면 인스톨러가 앱 종료를 사용자에게 묻고 `/R`도 붙지 않아 무인
업데이트가 아니게 된다. 지금 값을 유지하는 이유다.

### 실패는 막다른 길이 아니어야 한다

조회든 다운로드든 실패하면 다이얼로그에 **「릴리스 페이지 열기」** 버튼이 함께 붙는다
(`notify_failure`). 자동 경로가 막힌 사용자가 앱 안에서 할 수 있는 일은 없고, 남는 길은 설치
파일을 직접 받는 것뿐인데, 오류 문자열만 띄우면 그 길이 보이지 않는다. 실제로 사내망 403이 그
모양이었다.

목적지는 `update.download_url`(설치 파일 직링크)이 아니라 `github.com`의 릴리스 페이지
(`RELEASE_PAGE_URL`)다. 이유가 둘이다. 실패 원인의 상당수는 **그 설치 파일을 받는 호스트**가
막혔거나 쿼터를 넘긴 것이라(위 API 주소 이야기) 같은 주소를 다시 권하면 브라우저에서도 같은
자리에서 막힌다. 그리고 조회 단계에서 실패했으면 `Update`가 없어 직링크를 만들 수조차 없다 —
두 실패 경로가 같은 자리를 가리키려면 상수여야 한다. 반대로 릴리스 페이지가 사는 `github.com`은,
적어도 조회가 성공한 뒤라면 이미 통과가 확인된 호스트다.

여는 일은 노트 본문 링크와 같은 경로(`commands::open_external_url`)에 위임한다 — OS별 도구
선택과 스킴 allowlist가 이미 거기 있다. 새 플러그인 의존성은 없다.

## 참고

- **자동 실행(autostart):** 릴리스 빌드에서만 로그인 항목을 동기화한다(디버그 빌드는 사용자의
  로그인 항목을 건드리지 않음 — `src-tauri/src/lib.rs` `sync_autostart`).
- **CSP:** `tauri.conf.json`의 `csp`는 배포 정책으로 이미 좁혀져 있다. updater는 웹뷰 밖
  (Rust)에서 통신하므로 `connect-src`를 넓힐 필요가 없다 — 릴리스를 낼 때 이 값을 넓히지
  않았는지만 확인한다.
