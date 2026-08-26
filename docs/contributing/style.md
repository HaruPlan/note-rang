# 코드 스타일 / 규약

공통 스타일은 도구로 강제한다(편차 제거): Rust `rustfmt`+`clippy`, TS
`prettier`+`eslint`(+`typescript-eslint`), `.editorconfig`. 아래는 도구가
잡지 못하는 사람 규약.

## 모듈 구조

- **단일 책임 소형 모듈**. 한 파일이 한 가지 관심사.
- 경계: **Rust 커맨드(`src-tauri/src/commands.rs`) ↔ 프론트 IPC 래퍼
  (`src/shared/`)**. 프론트는 래퍼만 통해 백엔드를 호출한다.
- 공통 로직은 `src/shared/`(TS) / 적절한 Rust 모듈로 추출, 중복 금지.

## 네이밍

- Rust: 타입 `UpperCamel`, 함수/변수 `snake_case`, 상수 `SCREAMING_SNAKE`.
- TS: 타입 `UpperCamel`, 함수/변수 `lowerCamel`, 파일 `kebab` 또는 도메인명.
- 의미 있는 이름. 약어 지양.

## 함수 doc 주석 (필수)

모든 함수에 **역할·목적**을 적는다(무엇을 하는가 / 왜 존재하는가). 테스트
함수에는 무엇을 고정(guard)하는지 한 줄로.

## 에러 처리

- Rust: 복구 가능 경로는 `Result`(`?`)로 전파, `unwrap`/`expect`는 불변식이
  보장된 곳에만(메시지로 이유 명시). 패닉으로 흐름 제어 금지.
- TS: 실패 가능한 IPC는 명시적으로 처리, 조용한 삼킴 금지.

## 테스트

- 순수 로직(파일 IO·디스플레이 매핑·override 병합·권한 판정·라이브 프리뷰
  데코레이션)은 **유닛 테스트로 가드**. 실패 모드를 함께 검증.
- 테스트 초점은 회귀 방지: 의도된 동작을 고정한다.
- 각 기능 완료 시 **별도 agent**로 테스트를 독립 검증한다.

## 죽은 코드 / 미사용 금지

- knip(미사용 파일·export·의존성), cargo-machete(미사용 크레이트),
  clippy `dead_code`로 강제. 누적 금지.
- 정적분석 오탐(공개 IPC 핸들러, `@memo/plugin-api` 공개 표면, 플러그인
  진입점)은 allowlist/예외로 등록하고 사유를 남긴다.
