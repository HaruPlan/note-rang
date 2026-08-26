//! 프론트엔드용 Tauri 커맨드 — 노트 CRUD + 공유 설정.
//!
//! 역할: 프론트가 노트/설정을 다루는 IPC 경계. 모든 접근은 [`AppState`]를 통한다.
//! 왜: 저장 로직(Vault/settings)은 모듈에서 테스트하고, 여기서는 상태 잠금 + 오류
//! 문자열 변환만 하는 얇은 래퍼로 둔다.
//!
//! ## 「디스크에 닿는 커맨드는 `#[tauri::command(async)]`」 (이슈 #22)
//!
//! Tauri v2에서 **동기 커맨드는 메인 스레드(이벤트 루프)에서 실행된다**. 그래서 파일 하나를
//! 여는 커맨드도 그 IO 동안 모든 창의 그리기·입력·창 조작을 함께 멈춘다 — Windows는 5초쯤
//! 응답이 없으면 창을 "응답 없음"으로 칠하는데, 베타 테스터가 본 것이 정확히 그 상태였다
//! (vault가 OneDrive/Dropbox 폴더이거나 백신 실시간 검사가 켜져 있으면 쓰기 한 번이 쉽게
//! 수백 ms가 된다). 그래서 이 파일에서 디스크에 닿는 커맨드는 전부 `(async)`이고,
//! **메모리만 읽는 커맨드**(`get_shared_settings`·`get_vault_path`·`get_global_hotkey`·
//! `get_startup_no_active_action`·`get_panel_sort`·`get_platform`)만 동기로 남는다
//! (스레드풀 왕복이 오히려 비싸다).
//!
//! 예외 하나는 [`set_global_hotkey`]다 — OS 전역 단축키 등록/해제는 플랫폼별로 특정 스레드에
//! 묶여 있어(Windows는 등록 스레드의 메시지 큐) 메인 스레드에 두는 편이 안전하다. 대신 그
//! 안의 디스크 쓰기는 작은 `config.json` 한 벌이고 사용자가 단축키를 바꿀 때만 일어난다.
//!
//! 병행 실행이 되면서 **같은 파일을 향한 동시 쓰기**가 가능해졌다는 점도 함께 다뤘다:
//! 노트 파일은 `AppState`의 vault 잠금이 직렬화하고, 임시 파일명은 호출마다 달라진다
//! ([`crate::io::write_atomic_bytes`]).
//!
//! ## 「자주·크게 읽고 쓰는 커맨드는 blocking 풀에서」
//!
//! `(async)`만으로는 절반이다 — 그 본문은 `tauri::async_runtime::spawn`(= `tokio::spawn`)로
//! 넘어가 **코어 수만큼 고정된** 워커 풀에서 돌고, IPC 응답 전달도 같은 런타임을 쓴다. 느린
//! vault에서 파일 커맨드가 워커를 전부 붙들면 이미 끝난 커맨드의 응답조차 프론트에 닿지
//! 못한다(창은 그려지는데 모든 IPC가 멎는, #22와 증상만 다른 정지). 그래서 노트 본문·메타·
//! 첨부처럼 **잦거나 큰** 디스크 IO는 [`blocking`]으로 blocking 풀에 넘긴다.
//!
//! ## 「vault를 통째로 바꾸는 동안 노트 쓰기는 기다리거나 거부된다」
//!
//! 저장 폴더 이전([`change_vault_path`])과 전체 삭제([`wipe_all_data`])는 다른 커맨드와
//! 달리 **파일이 있는 자리 자체**를 바꾼다. 그동안 자동저장(타이핑 500ms 디바운스)이 옛
//! 폴더로 새면 이동의 원본 삭제가 그것을 지우고, 삭제 뒤에 도착하면 지운 노트를 되살린다.
//! 두 경로를 각각 이렇게 막는다.
//!
//! - **이전**: `vault` 잠금을 이동 전 구간 + 핸들 교체까지 쥔다([`move_vault_locked`]).
//!   쓰기는 잠금에서 기다렸다가 **교체된 새 경로**에 쓴다 — 한 글자도 잃지 않는다.
//! - **삭제**: 창을 **먼저** 닫고 실제로 사라질 때까지 기다린 뒤 지운다
//!   ([`close_note_windows_and_settle`]) + 그 구간 전체를 쓰기 봉인
//!   ([`AppState::seal_note_writes`])으로 감싼다. 창을 닫는 행위 자체가 웹뷰 `pagehide`를
//!   깨워 자동저장을 flush하기 때문에, 순서만으로는 부족하고 봉인이 함께 필요하다.

use crate::attachments;
use crate::backup;
use crate::fonts;
use crate::model::{NoteMeta, NoteOverrides, SharedSettings};
use crate::notes::{self, derive_title, now_ms, Vault};
use crate::plugin_storage;
use crate::plugins;
use crate::search::{self, SearchHit};
use crate::settings;
use crate::state::{AppState, VaultHandle};
use crate::trash::Snapshot;
use crate::vault_move;
use crate::window_manager;
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// 블로킹 디스크 IO를 blocking 풀로 옮긴다(이 파일 머리말의 「blocking 풀에서」 정책).
///
/// 클로저는 `'static`이어야 하므로 `State`를 그대로 넘길 수 없다 — 잠금 아래에서 필요한
/// 것만 복제해 넘긴다([`AppState::vault_handle`]로 잠금을 공유하거나, 경로만 복제하거나).
/// 이 관용구의 선례는 `plugin_commands::fetch_plugin_for_install`이다.
async fn blocking<T, F>(job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("작업을 마치지 못했습니다: {e}"))?
}

/// 노트 목록 항목(제목은 본문 첫 줄에서 파생).
///
/// 뒤쪽 4개 필드는 패널이 목록을 **정렬**하는 데 쓴다. 정렬 자체는 프론트가 순수 함수로
/// 하고(어휘와 비교 규칙의 주인은 프론트다), 백엔드는 그 재료만 실어 보낸다 — 검색 결과
/// ([`SearchHit`])도 **같은 이름·같은 타입**의 4개를 나른다. 두 모양이 갈리면 검색 중에만
/// 정렬이 다르게 나온다.
#[derive(Serialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub hidden: bool,
    /// 생성 시각(에폭 ms) — 패널 목록의 생성일 표기용.
    pub created_at: i64,
    /// 즐겨찾기 여부([`crate::model::NoteMeta::favorite`]) — 패널이 현재 목록 안에서 맨 위
    /// 묶음으로 올린다. 창 「항상 위」(`NoteOverrides::pinned`)와는 무관하다.
    pub favorite: bool,
    /// 본문(`.md`)이 마지막으로 바뀐 시각(에폭 ms) — 「수정순」 정렬 키. mtime을 못 읽으면
    /// `created_at`으로 대신한다([`crate::notes::Vault::content_modified_at`] 참고: 의미가
    /// 오염된 `NoteMeta::updated_at`을 쓰지 않는 이유도 거기 있다).
    pub content_updated_at: i64,
    /// 마크다운 **원문**의 글자 수(공백 포함) — 「글자수 많은 순」 정렬 키.
    pub char_count: u64,
    /// 사용자가 직접 마지막으로 연 시각(에폭 ms). 기록된 적 없으면 JSON `null`
    /// (생략하면 프론트의 `number | null` 계약이 `undefined`로 깨진다).
    pub opened_at: Option<i64>,
}

/// 노트 한 건의 본문 + 메타.
#[derive(Serialize)]
pub struct NoteData {
    pub content: String,
    pub meta: NoteMeta,
}

/// 패널이 목록을 그리고 정렬하는 데 필요한 노트별 메타 — 사이드카 + `.md` mtime에서 모은 값.
///
/// 왜 struct로 묶나: [`note_list`]와 [`note_search`]가 **같은 재료**를 실어 보내야 한다
/// (패널은 검색 중에도 같은 정렬 함수를 쓴다). 두 커맨드가 각자 사이드카를 읽으면 폴백
/// 규칙 하나만 어긋나도 "검색할 때만 순서가 다르다"가 되는데, 그건 눈으로 잡기 어렵다.
#[derive(Debug)]
struct ListMeta {
    hidden: bool,
    created_at: i64,
    favorite: bool,
    content_updated_at: i64,
    opened_at: Option<i64>,
}

/// 노트 하나의 [`ListMeta`]를 읽는다. 사이드카가 없거나 깨졌으면 전부 기본값으로 본다 —
/// 목록에서 그 노트만 사라지는 것보다 "값을 모르는 항목"으로 보이는 편이 낫다.
///
/// `content_updated_at`은 본문(`.md`) mtime이고, 못 읽으면 `created_at`으로 대신한다 —
/// 「수정순」에서 그 노트만 1970년으로 튀어 맨 뒤로 밀리는 것을 막는다
/// ([`crate::notes::Vault::content_modified_at`] 참고: `NoteMeta::updated_at`을 쓰지 않는
/// 이유도 거기 있다).
fn list_meta(vault: &Vault, id: &str) -> ListMeta {
    let meta = vault.read_meta(id).ok();
    let created_at = meta.as_ref().map(|m| m.created_at).unwrap_or(0);
    ListMeta {
        hidden: meta.as_ref().map(|m| m.hidden).unwrap_or(false),
        created_at,
        favorite: meta.as_ref().map(|m| m.favorite).unwrap_or(false),
        content_updated_at: vault.content_modified_at(id).unwrap_or(created_at),
        opened_at: meta.as_ref().and_then(|m| m.opened_at),
    }
}

/// 노트 하나를 목록 항목 한 줄로 만든다 — [`note_list`]가 노트마다 부르는 알맹이.
///
/// 본문을 못 읽으면 빈 문자열로 본다(제목은 "제목 없음", 글자 수 0) — 사이드카만 남은
/// 노트가 목록에서 **사라지는** 것보다 낫다. `char_count`는 마크다운 원문의 **글자** 수다
/// (바이트가 아니다 — 한글이 3배로 세지면 「글자수 많은 순」이 목록과 검색에서 서로 다른
/// 순서를 낸다). 나머지 정렬 재료는 [`list_meta`]가 검색과 공유한다.
///
/// 커맨드 본문에서 떼어 둔 이유는 [`set_favorite_in_vault`]와 같다 — Tauri `State` 없이
/// 유닛 테스트로 계약(§1.1)을 고정하기 위함이다.
fn summarize_note(vault: &Vault, id: String) -> NoteSummary {
    let content = vault.read_content(&id).unwrap_or_default();
    let meta = list_meta(vault, &id);
    NoteSummary {
        title: derive_title(&content),
        char_count: content.chars().count() as u64,
        id,
        hidden: meta.hidden,
        created_at: meta.created_at,
        favorite: meta.favorite,
        content_updated_at: meta.content_updated_at,
        opened_at: meta.opened_at,
    }
}

/// 전체 노트 목록을 제목과 함께 돌려준다.
///
/// `async`인 이유: 모든 노트의 .md·.json을 읽어 제목을 파생하는 O(전체 노트) 파일 IO다 —
/// 동기 커맨드는 메인 스레드에서 돌아 그동안 앱 전체가 멈춘다(plugin_storage.rs 모듈
/// 문서의 「동기 커맨드 금지」 정책). 이 커맨드는 신뢰 경계 밖(샌드박스 플러그인의
/// `memo.notes.list`)에서도 직접 불리므로, 플러그인 하나의 호출 루프가 모든 노트 창과
/// (그 플러그인을 끌) 설정 창까지 함께 얼리는 길을 여기서 끊는다.
///
/// 잠금을 **붙들고 있지 않는다**: vault 핸들을 복제해 꺼낸 뒤 곧바로 잠금을 놓고 파일을
/// 읽는다. 안 그러면 노트가 수백 개인 vault에서 이 한 번의 호출이 잠금을 오래 쥐어, 다른
/// 창의 자동저장과 (트레이 라벨 갱신처럼) 메인 스레드에서 vault를 읽는 경로까지 함께 멎는다 —
/// 스레드풀로 옮긴 이득을 잠금 경합으로 도로 반납하는 셈이 된다.
#[tauri::command]
pub async fn note_list(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    let vault = state.vault_handle().snapshot();
    blocking(move || {
        let ids = vault.list_note_ids().map_err(|e| e.to_string())?;
        let summaries = ids
            .into_iter()
            .map(|id| summarize_note(&vault, id))
            .collect();
        Ok(summaries)
    })
    .await
}

/// 노트 한 건의 본문과 메타를 읽는다.
///
/// `async`인 이유: `note_list`와 같다 — 디스크 IO를 감싸는 커맨드이고, 플러그인
/// 브리지(`memo.notes.read`)가 직접 부른다(동기면 메인 스레드가 그 IO에 묶인다).
#[tauri::command]
pub async fn note_read(state: State<'_, AppState>, id: String) -> Result<NoteData, String> {
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock();
        let content = vault.read_content(&id).map_err(|e| e.to_string())?;
        let meta = vault.read_meta(&id).map_err(|e| e.to_string())?;
        Ok(NoteData { content, meta })
    })
    .await
}

/// 빈 노트를 새로 만들고 생성된 id를 돌려준다.
///
/// `async`인 이유: 본문·사이드카 두 파일을 원자적으로 쓰는 디스크 IO다(이슈 #22 — Windows에서
/// "새 메모를 넣으면 응답 없음"). 동기 커맨드는 메인 스레드에서 돌아, 그 IO가 느린 동안
/// (동기화 폴더·백신 실시간 검사) 이벤트 루프가 멈춰 OS가 창을 "응답 없음"으로 칠한다.
#[tauri::command]
pub async fn note_create(state: State<'_, AppState>) -> Result<String, String> {
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock_for_write()?;
        vault.create_note("").map_err(|e| e.to_string())
    })
    .await
}

/// 노트를 새로 만들고 그 창을 곧바로 연다 — 패널의 "+" 버튼과 노트 컨텍스트 메뉴 "새 메모"의
/// 백엔드(베타 피드백 2건).
///
/// [`window_manager::create_and_open`]에 그대로 위임한다: 그 함수가 이미 vault 쓰기를
/// blocking 풀로, 창 생성을 메인 스레드로 나눠 처리하고 즉시 반환한다(문서 참고). 그래서 이
/// 커맨드는 `(async)`가 아니다 — 호출 스레드(메인)에서 스폰만 하고 곧바로 돌아오므로 이 파일
/// 머리말의 「디스크에 닿는 커맨드는 `(async)`」 정책에 해당하지 않는다(전역 새 노트
/// 단축키 핸들러도 같은 함수를 메인 스레드에서 직접 부른다 — `lib.rs` 참고).
///
/// 생성 실패는 반환값이 아니라 내부에서 로깅된다(`create_and_open`의 기존 계약을 그대로
/// 물려받는다) — 노트 목록 변경 방송(`notes-list-changed`)은 생성이 실제로 성공했을 때만 그
/// 함수가 직접 emit한다.
#[tauri::command]
pub fn note_create_and_open(app: AppHandle) -> Result<(), String> {
    window_manager::create_and_open(&app)
}

/// 노트를 복제한다 — 본문과 모든 설정(override)이 같은 새 노트를 만들고 새 id를 돌려준다.
/// 프론트(복제 플러그인)가 이 id로 새 노트 창을 소환한다.
#[tauri::command]
pub async fn note_duplicate(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock_for_write()?;
        vault.duplicate_note(&id).map_err(|e| e.to_string())
    })
    .await
}

/// 노트 본문을 저장한다(원자적). 저장 후 노트 창이 열려 있으면 타이틀도 본문에 맞춰
/// 갱신한다(작업 표시줄/미션 컨트롤에서 노트를 구분할 수 있도록 — 제목이 실제로 바뀌었을
/// 때만 `set_title`을 호출한다: [`crate::window_manager::refresh_window_title`]).
///
/// `async`인 이유: **자동저장이 타이핑 중 500ms마다 이 커맨드를 부른다** — 이 리포에서 가장
/// 잦은 디스크 쓰기다. 동기 커맨드였을 때는 그 쓰기가 전부 메인 스레드에서 일어나, 노트가
/// 여럿 열린 채 동기화 폴더에 vault를 둔 Windows 환경에서 타이핑 중 앱 전체가 굳었다(#22).
/// `set_title`은 setter라 어느 스레드에서 불러도 이벤트 루프로 넘겨질 뿐 블록하지 않는다.
///
/// 쓰기 잠금([`crate::state::VaultHandle::lock_for_write`])을 쓰는 이유: 저장 폴더 이전이
/// 진행 중이면 여기서 기다렸다가 **새 폴더**에 쓰고, 전체 삭제 중이면 거부된다 — 창이 닫히며
/// 나가는 마지막 flush가 방금 지운 노트를 되살리지 않도록.
///
/// ## 삭제-후-쓰기 가드(부활 방지)
///
/// 쓰기 전에 [`crate::notes::Vault::note_exists`]로 `.md`가 아직 있는지 확인한다. 없으면
/// (그 노트가 이미 지워졌으면) **조용히 성공 처리하고 아무것도 쓰지 않는다** — 그러지 않으면
/// [`crate::notes::Vault::write_content`](write_atomic)가 부모 디렉터리까지 새로 만들어 지운
/// 노트를 되살린다. `note_delete`가 창을 먼저 정리하므로 정상 경로에서는 이 가드에 거의 닿지
/// 않지만, 창이 제한 시간을 넘겨 강제로 닫힌 경우의 마지막 flush가 여기 걸린다 — 그 경우가
/// 이 가드의 존재 이유다.
///
/// 오류가 아니라 조용한 성공인 이유: 이 커맨드의 프론트 호출부(`bootstrap/note.ts`의
/// `saveContent`)는 반환 프라미스에 `.catch`를 달지 않는다 — 실패로 돌려주면 처리되지 않은
/// 거부가 되어, 이미 닫히는 중인 창에 순간적으로 오류 오버레이를 띄운다
/// (`note-window.ts`의 `installNoteErrorOverlay`). 저장할 노트가 이미 없다는 사실은 사용자
/// 에게 보여줄 오류가 아니다.
#[tauri::command]
pub async fn note_save_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<(), String> {
    let handle = state.vault_handle();
    let saved = blocking(move || {
        let vault = handle.lock_for_write()?;
        if !vault.note_exists(&id) {
            return Ok(None);
        }
        vault
            .write_content(&id, &content)
            .map_err(|e| e.to_string())?;
        Ok(Some((id, content)))
    })
    .await?;
    if let Some((id, content)) = saved {
        window_manager::refresh_window_title(&app, &id, &content);
    }
    Ok(())
}

/// 노트별 override만 저장한다(창 위치 등 다른 메타는 보존 — 동시 저장 충돌 방지).
///
/// 삭제-후-쓰기 가드가 따로 필요 없는 이유(대칭 검토 — [`note_save_content`] 참고): 이미
/// **읽고 나서 쓰는** 순서다 — `read_meta`가 사이드카 `.json`을 먼저 읽는데, 그 파일은
/// [`crate::notes::Vault::delete_note`]가 본문과 함께 지운다. 그래서 삭제된 노트는
/// `read_meta`에서 이미 `NotFound`로 실패하고 `write_meta`(재생성 가능한 쓰기)에 닿지
/// 못한다 — 별도 존재 확인을 추가할 필요가 없다.
#[tauri::command]
pub async fn note_save_overrides(
    state: State<'_, AppState>,
    id: String,
    overrides: NoteOverrides,
) -> Result<(), String> {
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock_for_write()?;
        let mut meta = vault.read_meta(&id).map_err(|e| e.to_string())?;
        meta.overrides = overrides;
        meta.updated_at = now_ms();
        vault.write_meta(&id, &meta).map_err(|e| e.to_string())
    })
    .await
}

/// 노트를 삭제한다(본문·메타·첨부) — 그 노트의 창이 열려 있으면 함께 정리한다.
///
/// ## 창이 열려 있으면 함께 닫는 이유와 순서(부활 함정 방지)
///
/// 노트 창은 `pagehide`에 자동저장 flush를 달아 둔다(`src/note/note-window.ts`) — 창을 그냥
/// 강제로 닫으면 그 flush가 튀어나와 [`crate::notes::Vault::write_content`]가 방금(또는 곧)
/// 지울 `.md`를 되살릴 수 있다(`write_atomic`은 부모 디렉터리까지 새로 만든다). 그래서
/// **파일을 지우기 전에** [`window_manager::notify_and_close_note_window`]로 그 창에 "삭제됨"
/// 이벤트를 먼저 보낸다 — 열려 있는 창은 그 이벤트를 받아 대기 중인 저장을 스스로 취소한 뒤
/// 닫는다(`bootstrap/note.ts`의 리스너). 이 순서에서는 이벤트~닫힘 사이에 도착하는 저장도
/// **아직 존재하는** 노트에 정상적으로 쓰일 뿐이라 해롭지 않다.
///
/// 창이 제한 시간 안에 스스로 닫지 않으면(얼어붙었거나 이벤트를 놓쳤거나) 강제로 닫는다 —
/// 이 경로에서 유발되는 마지막 flush는 [`note_save_content`]의 삭제-후-쓰기 가드가 무해화
/// 한다(그 시점엔 이미 파일이 지워져 있어도 되살아나지 않는다). 즉 두 방어가 겹으로 있다:
/// 정상 경로는 이벤트가 막고, 남는 틈은 저장 커맨드의 가드가 막는다.
///
/// 열린 창이 없으면(패널에서 백그라운드 노트를 지우는 보통 경우) 이 대기는 즉시 끝난다.
///
/// 봉인([`AppState::seal_note_writes`])을 쓰지 않는 이유: 그 장치는 "지운 것이 되살아나는
/// 것"을 전역으로 막는 무거운 도구라, 노트 하나를 지울 때마다 걸면 그동안 무관한 다른 열린
/// 노트들의 자동저장까지 함께 멎는다. 여기서는 창을 **먼저** 정리하고 파일을 **그 다음에**
/// 지우는 순서 자체가 이 노트에 한정된 같은 보장을 주므로, 그 무거운 도구가 필요 없다.
#[tauri::command]
pub async fn note_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let notify_app = app.clone();
    let notify_id = id.clone();
    let settled = blocking(move || {
        Ok(window_manager::notify_and_close_note_window(
            &notify_app,
            &notify_id,
        ))
    })
    .await?;
    if !settled {
        eprintln!("[memo] 노트 삭제: 창이 제때 닫히지 않아 강제로 닫았습니다: {id}");
    }
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock();
        vault.delete_note(&id).map_err(|e| e.to_string())
    })
    .await
}

/// 노트 본문을 쓴다 — `memo.notes.write`의 백엔드(브리지 배선은 다음 단계 다른 에이전트).
///
/// 역할: `mode`로 파괴성을 가른다 — `"append"`는 기존 내용을 보존해 끝에 덧붙이는 **비파괴**
/// 쓰기(저마찰), `"overwrite"`는 본문을 통째로 바꾸는 **파괴적** 쓰기다. overwrite는 쓰기 직전
/// 이전 본문을 앱 소유 복구 슬롯에 스냅샷한다([`crate::trash`]) — memo에는 undo도 휴지통도
/// 없어 이 스냅샷이 유일한 안전망이기 때문이다.
/// 왜 `async`인가: 디스크 IO를 감싸는 커맨드이고 플러그인 브리지가 직접 부른다 —
/// 동기 커맨드는 메인 스레드에서 돌아 그 IO 동안 앱 전체가 멈춘다(이 리포의 전례).
///
/// 오류: 없는 id·경로 형태 id는 `Result::Err`다(브리지가 `NOTE_NOT_FOUND`로 분류 — `note_read`와
/// 같은 관례). 알 수 없는 `mode`는 명확한 오류 문자열이다(브리지는 호출 전에 어휘를
/// 검증하지만, 백엔드도 심층 방어로 거부한다).
///
/// 쓰고 나서 창 타이틀을 갱신하는 이유([`window_manager::refresh_window_title`]): 이 경로도
/// 본문 첫 줄(=제목)을 바꿀 수 있는데, 프론트는 이 쓰기를 받은 뒤 에디터 버퍼만 다시 읽고
/// `save.cancel()`로 자동저장을 **건너뛴다**(note-window.ts의 `reloadContent`). 그래서
/// 여기서 갱신하지 않으면 사용자가 직접 타이핑해 자동저장이 한 번 더 돌기 전까지 작업
/// 표시줄·미션 컨트롤에 옛 제목이 남는다. 갱신에 쓸 본문은 **쓰고 나서 다시 읽는다** —
/// `append`는 인자가 덧붙일 조각일 뿐이라 결과 전문이 아니기 때문이다.
#[tauri::command]
pub async fn note_write(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
    mode: String,
) -> Result<(), String> {
    let handle = state.vault_handle();
    let (id, saved) = blocking(move || {
        let vault = handle.lock_for_write()?;
        match mode.as_str() {
            "append" => vault
                .append_content(&id, &content)
                .map_err(|e| e.to_string()),
            "overwrite" => vault
                .overwrite_content(&id, &content)
                .map_err(|e| e.to_string()),
            other => Err(format!(
                "알 수 없는 쓰기 모드: {other:?} (append|overwrite 중 하나여야 합니다)"
            )),
        }?;
        // 다시 읽지 못하면 타이틀 갱신만 건너뛴다 — 쓰기는 이미 성공했으므로 오류가 아니다.
        let saved = vault.read_content(&id).ok();
        Ok((id, saved))
    })
    .await?;
    if let Some(saved) = saved {
        window_manager::refresh_window_title(&app, &id, &saved);
    }
    Ok(())
}

/// 노트의 복구 슬롯 스냅샷 목록을 최신순으로 읽는다(복구 UI가 되돌릴 버전을 고르는 데 쓴다).
///
/// `async`인 이유: 스냅샷 디렉터리를 훑어 각 본문에서 제목·미리보기를 파생하는 파일 IO다.
#[tauri::command(async)]
pub fn note_list_snapshots(state: State<AppState>, id: String) -> Result<Vec<Snapshot>, String> {
    let vault = state.lock_vault();
    vault.list_snapshots(&id).map_err(|e| e.to_string())
}

/// 복구 슬롯에 스냅샷을 가진 모든 노트 id를 열거한다(삭제된 노트 포함) — 복구 UI가 존재하는
/// 노트뿐 아니라 **삭제된 노트의 스냅샷**도 찾을 수 있게 한다(finding 2).
///
/// `async`인 이유: `.memo/trash` 하위 디렉터리를 훑는 파일 IO다.
#[tauri::command(async)]
pub fn note_list_snapshot_note_ids(state: State<AppState>) -> Result<Vec<String>, String> {
    let vault = state.lock_vault();
    vault.list_snapshot_note_ids().map_err(|e| e.to_string())
}

/// 복구 슬롯 스냅샷 하나의 본문을 읽는다(복구 UI의 미리보기용). 없으면 오류.
#[tauri::command(async)]
pub fn note_read_snapshot(
    state: State<AppState>,
    id: String,
    snapshot_id: String,
) -> Result<String, String> {
    let vault = state.lock_vault();
    vault
        .read_snapshot(&id, &snapshot_id)
        .map_err(|e| e.to_string())
}

/// 노트 본문을 특정 스냅샷으로 되돌린다(삭제한 노트도 되살린다 — 사이드카 메타를 재생성).
/// 되돌리기 직전 현재 본문도 스냅샷되므로 복원 자체를 다시 되돌릴 수 있다.
///
/// 복원 뒤 창 타이틀도 갱신한다 — 이유는 [`note_write`]와 같다(프론트의 복원 경로는
/// 에디터 버퍼만 다시 읽고 자동저장을 건너뛰므로, 여기서 갱신하지 않으면 옛 제목이 남는다).
#[tauri::command]
pub async fn note_restore_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    snapshot_id: String,
) -> Result<(), String> {
    let handle = state.vault_handle();
    let (id, restored) = blocking(move || {
        let vault = handle.lock_for_write()?;
        vault
            .restore_snapshot(&id, &snapshot_id)
            .map_err(|e| e.to_string())?;
        let restored = vault.read_content(&id).ok();
        Ok((id, restored))
    })
    .await?;
    if let Some(restored) = restored {
        window_manager::refresh_window_title(&app, &id, &restored);
    }
    Ok(())
}

/// 노트를 보관한다(hidden=true) — "닫기"가 영구 삭제 대신 보관이 되도록.
#[tauri::command(async)]
pub fn note_archive(state: State<AppState>, id: String) -> Result<(), String> {
    let vault = state.lock_vault_for_write()?;
    let mut meta = vault.read_meta(&id).map_err(|e| e.to_string())?;
    meta.hidden = true;
    meta.updated_at = now_ms();
    vault.write_meta(&id, &meta).map_err(|e| e.to_string())
}

/// 노트의 즐겨찾기를 켜고 끈다 — 패널 목록에서 맨 위 묶음으로 올릴지의 사용자 표시.
///
/// 창 **「항상 위」**(`note_save_overrides`의 `pinned`)와는 아무 관계가 없다 — 이쪽은 사이드카
/// 메타의 `favorite`이고 목록 순서에만 영향을 준다.
///
/// **`updated_at`을 건드리지 않는다**: 즐겨찾기는 본문을 바꾸지 않는데도 그 필드를 갱신하면
/// "수정한 적 없는 노트가 방금 수정된 것으로" 보인다(그 필드의 의미가 이미 오염된 것도
/// 같은 이유였다 — [`crate::notes::Vault::content_modified_at`] 참고). 본문 `.md`도 만지지
/// 않으므로 「수정순」 정렬도 흔들리지 않는다.
///
/// [`window_manager::EV_NOTES_LIST_CHANGED`]를 **여기서 emit하지 않는다**: [`note_archive`]·
/// `note_delete`·`note_duplicate`와 같은 관례로, 목록 변경 방송은 프론트 래퍼
/// (`src/shared/tauri.ts`의 `afterNotesChanged`)가 성공 뒤에 낸다. 백엔드가 함께 emit하면
/// 같은 조작에 신호가 두 번 나가 패널이 목록을 두 번 읽는다(백엔드 emit은 프론트가 없는
/// 경로 — 트레이·전역 단축키로 창을 만들 때만 쓴다).
///
/// `(async)`인 이유는 [`note_archive`]와 같다 — 사이드카 한 벌을 읽고 쓰는 디스크 IO다.
#[tauri::command(async)]
pub fn note_set_favorite(state: State<AppState>, id: String, favorite: bool) -> Result<(), String> {
    let vault = state.lock_vault_for_write()?;
    set_favorite_in_vault(&vault, &id, favorite)
}

/// [`note_set_favorite`]의 알맹이 — 사이드카에서 `favorite`만 갈아 끼운다(다른 필드는 그대로).
///
/// Tauri `State` 없이 부를 수 있게 떼어 둔 이유는 테스트다: "`updated_at`을 건드리지 않는다"와
/// "다른 메타가 살아남는다"는 규칙이 회귀하기 쉬운데, 커맨드 서명 그대로는 유닛 테스트에서
/// 재현할 수 없다.
fn set_favorite_in_vault(vault: &Vault, id: &str, favorite: bool) -> Result<(), String> {
    let mut meta = vault.read_meta(id).map_err(|e| e.to_string())?;
    meta.favorite = favorite;
    vault.write_meta(id, &meta).map_err(|e| e.to_string())
}

/// 「시작 가이드」 메모 자리를 **원자적으로 선점**하고, 얻었으면 그 자리에 메모를 만든다.
///
/// 돌려주는 값이 곧 계약이다: `Some(id)`면 **이번 호출이** 가이드를 만들었다(호출부가 그 창을
/// 소환할 수 있다), `None`이면 이미 누가 만들었으니 아무것도 하지 않았다.
///
/// 왜 커맨드가 필요한가(프론트 플래그로는 안 되는 이유): 앱이 뜰 때 노트 창·패널·설정 창이
/// **동시에** 부트스트랩되고 각 창은 자기 웹뷰에서 따로 판정한다. "설정을 읽어 비었으면
/// 만든다"를 프론트가 하면 세 창이 전부 "비었다"를 보고 가이드를 세 장 만든다. 판정과 기록을
/// 코어의 한 잠금 안에서 끝내면 이긴 창 하나만 `Some`을 받는다.
///
/// 본문(`body`)을 프론트가 넘기는 이유: 가이드 본문은 UI 문자열이라 언어팩(자바스크립트)이
/// 번역할 수 있어야 한다(`src/note/guide-note.ts` + `src/i18n/ko.json`). Rust 내장 테이블에
/// 두면 ko·en 둘로 굳는다 — 첫 실행 환영 노트([`crate::state`])가 그런 경우인데, 그쪽은 창이
/// 하나도 없는 시점에 만들어야 해서 선택의 여지가 없었다. 가이드는 창이 뜬 뒤에 만들므로
/// 프론트에서 본문을 만들어 보낼 수 있다.
///
/// `force`: 「도움말 › 시작 가이드 다시 보기」가 쓴다 — 기존 기록을 무시하고 새로 만들어
/// 기록을 갈아 끼운다(사용자가 지웠거나, 다른 vault에서 온 백업의 id가 남아 있을 때).
///
/// **두 잠금을 겹쳐 쥐지 않는다**: 1단계에서 공유 설정 잠금만 쥐고 id를 예약하고, 2단계에서
/// vault 잠금만 쥐고 그 id로 만든다(`window_manager::read_note_view`와 같은 규칙 — 순서
/// 역전 교착의 여지를 구조적으로 없앤다). 그래서 id를 vault가 아니라 [`notes::new_note_id`]가
/// 발급한다. 2단계가 실패하면 예약을 되돌린다 — 안 그러면 "만들었다고 기록됐지만 노트는
/// 없는" 상태로 굳어 시작 시 가이드가 영영 뜨지 않는다.
///
/// `async`인 이유: 설정 파일 + 노트 두 파일에 닿는 디스크 IO다(이 파일 머리말의 정책).
#[tauri::command(async)]
pub fn claim_guide_note(
    state: State<AppState>,
    body: String,
    force: bool,
) -> Result<Option<String>, String> {
    let vault_path = state.lock_config().vault_path.clone();
    claim_guide_note_in_state(&state, &vault_path, &body, force)
}

/// [`claim_guide_note`]의 알맹이 — Tauri `State` 없이 부를 수 있게 떼어 둔 이유는
/// [`set_favorite_in_vault`]와 같다(선점의 "정확히 한 번"과 실패 시 되돌리기는 회귀하기 쉬운데
/// 커맨드 서명 그대로는 유닛 테스트에서 재현할 수 없다).
fn claim_guide_note_in_state(
    state: &AppState,
    vault_path: &Path,
    body: &str,
    force: bool,
) -> Result<Option<String>, String> {
    // 1단계 — 선점(공유 설정 잠금만). 디스크에 먼저 쓰고 메모리를 갱신하는 순서는
    // [`commit_shared_settings`]와 같다(쓰기가 실패하면 메모리도 그대로 둔다).
    let id = {
        let mut shared = state.lock_shared();
        if shared.guide_note_id.is_some() && !force {
            return Ok(None);
        }
        let id = notes::new_note_id();
        let mut next = shared.clone();
        next.guide_note_id = Some(id.clone());
        settings::save_shared_settings(vault_path, &next).map_err(|e| e.to_string())?;
        *shared = next;
        id
    };

    // 2단계 — 실제 생성(vault 잠금만). 즐겨찾기는 만든 **직후** 켠다: 별도 IPC로 미루면 그
    // 사이에 목록이 한 번 즐겨찾기 없이 그려져 가이드가 맨 위가 아닌 자리에 잠깐 보인다.
    let created = state.lock_vault_for_write().and_then(|vault| {
        vault
            .create_note_with_id(&id, body)
            .map_err(|e| e.to_string())?;
        set_favorite_in_vault(&vault, &id, true)
    });
    if let Err(e) = created {
        release_guide_claim(state, vault_path, &id);
        return Err(e);
    }
    Ok(Some(id))
}

/// 2단계(노트 생성)가 실패했을 때 1단계의 예약을 되돌린다 — **우리 예약이 그대로일 때만**.
///
/// 그 사이에 다른 호출이 `force`로 새 id를 적었다면 그쪽이 최신이므로 건드리지 않는다.
/// 되돌리기 실패는 삼킨다(원래 오류가 호출부에 가야 한다 — 되돌리기 실패로 덮지 않는다).
fn release_guide_claim(state: &AppState, vault_path: &Path, id: &str) {
    let mut shared = state.lock_shared();
    if shared.guide_note_id.as_deref() != Some(id) {
        return;
    }
    let mut next = shared.clone();
    next.guide_note_id = None;
    if settings::save_shared_settings(vault_path, &next).is_ok() {
        *shared = next;
    }
}

/// 모든 노트를 훑어 제목·본문에서 질의어를 검색한다(소환용 결과).
///
/// `async`인 이유: `note_list`와 같은 O(전체 노트) 파일 IO다 — 패널의 검색 입력이 타자마다
/// 이걸 부르므로 동기 커맨드면 검색창에 글자를 칠 때마다 앱 전체가 얼어붙는다.
/// 잠금을 붙들지 않는 이유도 [`note_list`]와 같다.
#[tauri::command]
pub async fn note_search(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let vault = state.vault_handle().snapshot();
    blocking(move || {
        let ids = vault.list_note_ids().map_err(|e| e.to_string())?;
        let entries: Vec<search::SearchEntry> = ids
            .into_iter()
            .filter_map(|id| {
                let content = vault.read_content(&id).ok()?;
                // 정렬 재료는 목록(`note_list`)과 **같은 함수**로 모은다 — 패널이 검색 중에도
                // 같은 정렬을 쓰므로 두 경로가 갈리면 안 된다([`ListMeta`] 문서 참고).
                let meta = list_meta(&vault, &id);
                Some(search::SearchEntry {
                    id,
                    content,
                    created_at: meta.created_at,
                    favorite: meta.favorite,
                    content_updated_at: meta.content_updated_at,
                    opened_at: meta.opened_at,
                })
            })
            .collect();
        Ok(search::search_notes(&entries, &query))
    })
    .await
}

/// 공유 전역 설정을 읽는다.
#[tauri::command]
pub fn get_shared_settings(state: State<AppState>) -> Result<SharedSettings, String> {
    Ok(state.lock_shared().clone())
}

/// 두 언어 값이 실제로 달라졌는지 판정한다(트레이 재구성 트리거 조건).
///
/// 역할: `save_shared_settings`가 트레이를 다시 그릴지 말지를 순수 비교로 판단한다 — GUI
/// 없이 유닛 테스트로 고정할 수 있도록 로직만 떼어 둔다(테마·툴바 배치 등 트레이와 무관한
/// 필드가 바뀌었을 때는 굳이 네이티브 메뉴를 다시 그리지 않는다).
fn language_changed(old: Option<&str>, new: Option<&str>) -> bool {
    old != new
}

/// 공유 설정 메모리 사본을 **하나의 임계구역에서** 교체하고, 언어가 실제로 바뀌었는지 알려준다.
///
/// 왜 헬퍼로 묶나: 예전에는 호출부마다 "잠갔다 놓고(옛 값 읽기) → 다시 잠가서 대입"하는
/// 두 임계구역이었다. 이 커맨드들이 전부 `(async)`가 되며 진짜로 병행 실행되므로, 두 저장이
/// 겹치면 나중에 깨어난 쪽이 **먼저 판정한 옛 값**으로 메모리를 덮어 디스크와 메모리가
/// 갈렸다(디스크는 light인데 화면은 dark, 재시작하면 아무도 안 건드린 테마가 뒤집힌다).
/// 읽기와 대입을 한 가드 아래에 두면 그 인터리빙 자체가 불가능해진다.
fn adopt_shared_settings(state: &AppState, next: SharedSettings) -> bool {
    let mut shared = state.lock_shared();
    let changed = language_changed(shared.language.as_deref(), next.language.as_deref());
    *shared = next;
    changed
}

/// 공유 설정을 vault에 쓰고 메모리 사본까지 **같은 임계구역에서** 갱신한다.
///
/// 잠금을 쥔 채 디스크에 쓰는 이유는 [`adopt_shared_settings`]와 같다 — 쓰기와 대입이
/// 갈라져 있으면 "W1이 dark를 쓰고 → W2가 light를 쓰고 메모리도 light로 → W1이 깨어나
/// 메모리를 dark로" 같은 뒤집힘이 가능하다. 잠금이 디스크 IO만큼(작은 JSON 한 벌) 길어지는
/// 대가로 디스크와 메모리가 항상 같은 값이 된다.
///
/// 쓰기에 실패하면 메모리를 갱신하지 않는다(예전 의미 그대로 — 디스크에 없는 설정을 화면만
/// 반영하지 않는다).
///
/// **코어 소유 필드는 `next`가 무엇을 담고 있든 지금 값으로 되돌린다**: 지금은
/// [`SharedSettings::guide_note_id`] 하나다. 이 값은 [`claim_guide_note`]만 바꾸는데, 저장은
/// 프론트가 **설정 한 벌을 통째로** 보내는 형식이라(부분 갱신이 아니다) 가이드가 만들어지기
/// **전에** 설정을 읽어 둔 창이 나중에 저장하면 그 옛 스냅샷이 방금 기록된 id를 지운다 —
/// 그러면 다음 실행에서 가이드가 하나 더 생긴다. 프론트가 필드를 성실히 왕복시키는지에
/// 기대는 대신 경계에서 못 박는다.
fn commit_shared_settings(
    state: &AppState,
    vault_path: &Path,
    next: SharedSettings,
) -> Result<bool, String> {
    let mut shared = state.lock_shared();
    let mut next = next;
    next.guide_note_id.clone_from(&shared.guide_note_id);
    settings::save_shared_settings(vault_path, &next).map_err(|e| e.to_string())?;
    let changed = language_changed(shared.language.as_deref(), next.language.as_deref());
    *shared = next;
    Ok(changed)
}

/// 공유 전역 설정을 저장한다(vault에 기록 + 메모리 상태 갱신).
///
/// 언어(`language`)가 실제로 바뀌면 트레이 메뉴를 즉시 다시 그린다([`language_changed`] +
/// [`crate::tray::refresh_for_language_change`]) — 트레이는 Rust가 내장 로케일 테이블로
/// 직접 그리는 네이티브 UI라 프론트 언어 전환 이벤트가 닿지 않는다. 재구성 실패는 설정 저장
/// 자체를 막지 않는다(비치명적 — 트레이 라벨만 다음 재시작까지 예전 언어로 남는다).
///
/// `async`인 이유: vault에 설정 파일을 쓰는 디스크 IO다(이슈 #22 — "설정에서 무언가를 바꾸면
/// 응답 없음"). 설정 창의 저장은 곧바로 중앙 호스트 재빌드로 이어져 다른 커맨드가 줄줄이
/// 따라오므로, 이 하나가 메인 스레드를 잡고 있으면 그 뒤가 전부 밀린다.
///
/// 트레이 재구성만 [`tauri::AppHandle::run_on_main_thread`]로 되돌린다: 네이티브 메뉴 조작은
/// 메인 스레드 전용이라(muda/Win32의 규칙) 워커 스레드에서 부르면 조용히 실패하거나 죽는다.
/// 되돌린 뒤에는 기다리지 않는다 — 라벨 갱신은 저장의 성공/실패와 무관한 비치명적 후속이다.
#[tauri::command(async)]
pub fn save_shared_settings(
    app: AppHandle,
    state: State<AppState>,
    new_settings: SharedSettings,
) -> Result<(), String> {
    let vault_path = {
        let config = state.lock_config();
        config.vault_path.clone()
    };
    let changed = commit_shared_settings(&state, &vault_path, new_settings)?;
    if changed {
        let handle = app.clone();
        let dispatched = app.run_on_main_thread(move || {
            if let Err(e) = crate::tray::refresh_for_language_change(&handle) {
                eprintln!("[memo] 트레이 언어 갱신 실패: {e}");
            }
        });
        if let Err(e) = dispatched {
            eprintln!("[memo] 트레이 언어 갱신 디스패치 실패: {e}");
        }
    }
    Ok(())
}

/// **설정만** 기본값으로 되돌린다(이슈 #20) — 노트·첨부·플러그인 데이터는 손대지 않는다.
///
/// 되돌리는 것: 공유 설정([`SharedSettings::default`] 전체 — 테마·색 오버라이드·키맵·툴바
/// 배치·언어·전역 노트 기본값) + 로컬 설정 중 "환경설정"에 해당하는 네 항목(자동 실행·전역
/// 새 노트 단축키·활성 노트가 없을 때의 시작 동작·패널 정렬 모드). 유지하는 것:
/// `vault_path`(데이터가 있는 위치 — 설정이 아니라 데이터 참조), `welcomed`(환영 노트를
/// 만들었는지는 노트 데이터의 부수 상태이지 사용자가 고른 설정이 아니다), `schema_version`.
///
/// **플러그인 활성/권한/설정 값은 건드리지 않는다.** 판단 근거: 플러그인은 설치된 확장이라
/// 그 생애주기(설치·활성·권한 부여)는 "환경설정 되돌리기"보다 "설치 관리"에 가깝다. 여기서
/// 함께 초기화하면 (1) 활성 커뮤니티 테마 플러그인은 그대로 켜진 채 `theme` 필드만 기본으로
/// 돌아가는 것과 달리, 전부 꺼지고 권한도 회수되는 훨씬 큰 파괴가 "설정 초기화"라는 이름의
/// 기대(테마·단축키 등 겉모습 되돌리기)를 크게 넘어서고, (2) 되돌릴 방법이 없다(재승인 절차를
/// 처음부터 다시 밟아야 한다). 플러그인까지 지우는 선택은 더 파괴적인 [`wipe_all_data`]의
/// 몫으로 남긴다 — 두 커맨드가 "설정만" vs "전부"로 뚜렷이 갈린다.
///
/// `async`인 이유: vault·앱데이터 양쪽에 설정 파일을 쓰는 디스크 IO다(이슈 #22 정책). 전역
/// 단축키 재등록만 [`AppHandle::run_on_main_thread`]로 돌린다 — OS 전역 단축키 등록은
/// 플랫폼별로 특정 스레드에 묶여 있어([`set_global_hotkey`] 문서 참고) 워커 스레드에서 직접
/// 부르면 조용히 실패하거나 죽을 수 있다. 실패해도 저장 자체를 막지 않는 비치명적 후속이다
/// (로컬 설정에는 이미 기본값이 저장된 뒤라, 다음 실행의 [`register_global_hotkey`]가 다시
/// 시도한다).
#[tauri::command(async)]
pub fn reset_settings(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // 1) 공유 설정 → 기본값(vault에 기록 + 메모리 갱신). save_shared_settings 커맨드와 같은
    //    언어 변경 감지를 재사용해, 언어가 실제로 바뀌면 트레이도 다시 그린다.
    let vault_path = state.lock_config().vault_path.clone();
    let lang_changed = commit_shared_settings(&state, &vault_path, SharedSettings::default())?;

    // 2) 로컬 설정 중 "환경설정" 항목만 → 기본값(vault_path·welcomed·schema_version 유지).
    let documents = app.path().document_dir().map_err(|e| e.to_string())?;
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");
    let defaults = settings::LocalConfig::with_defaults(&documents);
    let (old_hotkey, new_hotkey, launch_at_login) = {
        let mut config = state.lock_config();
        let old_hotkey = config.global_hotkey.clone();
        config.launch_at_login = defaults.launch_at_login;
        config.global_hotkey = defaults.global_hotkey.clone();
        config
            .startup_no_active_action
            .clone_from(&defaults.startup_no_active_action);
        config.panel_sort.clone_from(&defaults.panel_sort);
        settings::save_local_config(&config_path, &config).map_err(|e| e.to_string())?;
        (
            old_hotkey,
            config.global_hotkey.clone(),
            config.launch_at_login,
        )
    };

    crate::sync_autostart_state(&app, launch_at_login);

    if lang_changed {
        let handle = app.clone();
        let dispatched = app.run_on_main_thread(move || {
            if let Err(e) = crate::tray::refresh_for_language_change(&handle) {
                eprintln!("[memo] 설정 초기화: 트레이 언어 갱신 실패: {e}");
            }
        });
        if let Err(e) = dispatched {
            eprintln!("[memo] 설정 초기화: 트레이 언어 갱신 디스패치 실패: {e}");
        }
    }

    let handle = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        if let Err(e) = reset_global_hotkey(&handle, &old_hotkey, &new_hotkey) {
            eprintln!("[memo] 설정 초기화: 전역 단축키 재등록 실패: {e}");
        }
    });
    if let Err(e) = dispatched {
        eprintln!("[memo] 설정 초기화: 전역 단축키 재등록 디스패치 실패: {e}");
    }

    Ok(())
}

/// [`reset_settings`] 전용 전역 단축키 재등록 — [`set_global_hotkey`]와 같은 순서(새 값을
/// 먼저 등록해 검증하고, 성공하면 이전 값을 해제)이지만 실패해도 로컬 설정 저장 자체를
/// 되돌리지 않는다(호출부가 이미 기본값을 커밋한 뒤라, "설정 초기화"라는 사용자 의도를
/// 단축키 재등록 실패 하나로 막을 이유가 없다 — 로깅만 하고 다음 실행에 재시도된다).
fn reset_global_hotkey(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if old == new {
        return Ok(());
    }
    app.global_shortcut()
        .register(new)
        .map_err(|e| format!("단축키 등록 실패: {e}"))?;
    let _ = app.global_shortcut().unregister(old);
    Ok(())
}

/// vault의 **모든** 데이터와 이 기기의 플러그인 설치/저장 데이터를 영구히 지운다(이슈 #20).
/// 파괴적이고 되돌릴 수 없다 — 프론트가 강한 이중 확인(경고 + 확인 문자열 입력)을 거친 뒤에만
/// 부른다.
///
/// 지우는 것: vault의 `notes/`(본문·메타)·`attachments/`(첨부)·`.memo/`(공유 설정·복구
/// 슬롯·vault 플러그인 참조 목록 — [`crate::notes::Vault::wipe_all`] 참고) 전부, 그리고 이
/// 기기에 설치된 플러그인 코드·활성/권한/설정 로컬 상태([`plugins::wipe_all`])와 플러그인별
/// 저장소([`plugin_storage::storage_dir`]). 남기는 것: vault 폴더 자체(다음 쓰기가 하위
/// 디렉터리를 다시 만든다)와 로컬 설정의 `vault_path`(그래야 다음 실행이 같은 위치를 계속
/// vault로 본다).
///
/// 방어: vault_path가 실제 vault로 보이는지([`crate::notes::Vault::looks_like_vault`] —
/// `notes/` 디렉터리 존재) 확인한 뒤에만 진행한다 — 마이그레이션 중이거나 잘못 지정된
/// 경로에서 엉뚱한 폴더를 지우는 사고를 막는다.
///
/// ## 지운 것이 되살아나지 않게 하는 순서(중요)
///
/// 열린 노트 창은 **지우기 전에** 닫고 실제로 사라질 때까지 기다린다
/// ([`close_note_windows_and_settle`]), 그리고 그 전 구간을 쓰기 봉인
/// ([`AppState::seal_note_writes`])으로 감싼다.
///
/// 예전에는 창 닫기가 **맨 마지막**이었다. 그런데 노트 창은 `pagehide`에 자동저장 flush를
/// 달아 두므로(`src/note/note-window.ts`), 창을 닫는 행위 자체가 대기 중이던 저장을
/// 발사한다 — 그 저장이 이미 지워진 `notes/<id>.md`를 [`crate::io::write_atomic`](부모
/// 디렉터리를 새로 만든다)로 되살리고, 다음 실행의 시작 재조정이 메타까지 만들어 노트를
/// 완전히 부활시켰다("영구 삭제했다"는 안내가 거짓이 되는 경로다).
///
/// 순서만으로는 부족하다: `window.close()`는 메인 스레드로 넘어가는 요청이라 창이 실제로
/// 사라지기 전에 flush가 도착할 수 있다. 그래서 봉인을 함께 건다 — 봉인 중 도착한 저장은
/// [`crate::state::ERR_WRITES_SEALED`]로 거부된다.
///
/// **남는 틈**: 봉인은 이 커맨드가 끝나면 풀린다. 창이 제한 시간 안에 닫히지 않아 살아남고
/// (`settled == false`가 로그로 남는다) 그 창의 IPC가 커맨드 종료 **뒤에** 도착하면 여전히
/// 파일이 되살아날 수 있다. 프론트가 안내하는 재시작이 그 상태를 정리한다. 창 위치 저장
/// (`window_manager::save_window_geometry`)은 이 봉인을 보지 않지만, 그 경로는 이동/리사이즈
/// 에서만 발사되고 창을 닫을 때는 발사되지 않아 이 시나리오에 닿지 않는다.
///
/// 실행 후 신규 설치처럼 보이도록 `welcomed`를 되돌린다(다음 실행이 환영 노트를 다시 만든다).
/// 앱 자체의 재시작은 여기서 하지 않는다 — 이 앱은 싱글 인스턴스 플러그인을 쓰는데, 살아있는 프로세스
/// 곁에 새 프로세스를 스폰하면 그 새 프로세스가 "이미 실행 중"으로 판정돼 인자만 넘기고
/// 즉시 종료해 버려(핸드오프) 재시작이 아니라 조용한 무동작이 된다 — 이 상호작용을 안전하게
/// 풀려면 별도 재시작 플러그인이 필요한데 이번 작업 범위(Cargo.toml)가 아니다. 프론트가
/// "트레이에서 종료 후 다시 열기"를 안내한다.
#[tauri::command]
pub async fn wipe_all_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // 지우는 내내(그리고 창이 사라질 때까지) 노트 쓰기를 봉인한다. 가드는 이 함수가 끝날 때
    // 풀린다 — 위 문서의 「남는 틈」 참고.
    let _seal = state.seal_note_writes();

    // 창을 닫기 **전에** vault인지 먼저 확인한다 — 잘못된 경로였다면 사용자의 창을 괜히
    // 닫지 않고 그대로 거절한다.
    let root = {
        let vault = state.lock_vault();
        if !vault.looks_like_vault() {
            return Err(format!(
                "vault로 보이지 않는 경로입니다: {}",
                vault.root().display()
            ));
        }
        vault.root().clone()
    };

    // 창을 닫고 실제로 사라질 때까지 기다린다(닫힘이 유발하는 flush가 지우기 **전에**
    // 도착하도록). 대기는 blocking 풀에서 — tokio 워커를 재우면 다른 커맨드가 밀린다.
    let waiting = app.clone();
    let settled = blocking(move || Ok(close_note_windows_and_settle(&waiting))).await?;
    if !settled {
        eprintln!(
            "[memo] 모든 데이터 삭제: 노트 창이 제때 닫히지 않았습니다({}ms) — 남은 창의 마지막 저장이 삭제 뒤에 도착할 수 있습니다",
            WINDOW_CLOSE_WAIT.as_millis()
        );
    }

    let handle = state.vault_handle();
    blocking(move || {
        // 봉인을 건 장본인이므로 쓰기 잠금이 아니라 보통 잠금으로 들어간다(봉인은 **다른**
        // 경로의 쓰기를 막는 장치다). 잠금 자체가 진행 중인 저장을 여기서 기다리게 한다.
        let vault = handle.lock();
        // 창을 닫는 사이 저장 폴더가 바뀌었을 수 있으니 지우기 직전에 한 번 더 확인한다.
        if !vault.looks_like_vault() || vault.root() != &root {
            return Err(format!(
                "vault로 보이지 않는 경로입니다: {}",
                vault.root().display()
            ));
        }
        vault.wipe_all().map_err(|e| e.to_string())
    })
    .await?;
    adopt_shared_settings(&state, SharedSettings::default());

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let plugin_root = app_data.clone();
    blocking(move || {
        plugins::wipe_all(&plugin_root)?;
        let storage_dir = plugin_storage::storage_dir(&plugin_root);
        if storage_dir.is_dir() {
            std::fs::remove_dir_all(&storage_dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await?;

    let config_path = app_data.join("config.json");
    {
        let mut config = state.lock_config();
        config.welcomed = false;
        settings::save_local_config(&config_path, &config).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 노트 창이 닫히기를 기다리는 상한 — 넘으면 포기하고 로그만 남긴다(무한정 매달리지 않는다).
const WINDOW_CLOSE_WAIT: Duration = Duration::from_millis(1500);

/// 창이 사라졌는지 확인하는 간격.
const WINDOW_CLOSE_POLL: Duration = Duration::from_millis(20);

/// 열린 노트 창을 모두 닫고, **실제로 사라질 때까지** 기다린다. 제한 시간 안에 다 닫혔으면 true.
///
/// 왜 기다리나: `window.close()`는 메인 스레드(이벤트 루프)로 넘어가는 요청일 뿐이라, 돌아온
/// 시점에 창은 아직 살아 있다. 그리고 창이 닫히는 순간 웹뷰가 `pagehide`를 내보내 대기 중이던
/// 자동저장이 flush된다(`src/note/note-window.ts`) — 즉 "닫아 두었으니 이제 안전하다"가 아니라
/// **닫는 행위가 마지막 저장을 발사한다**. 그 저장이 어디에 떨어지느냐가 두 호출부의 관심사다.
///
/// - [`wipe_all_data`]: 지우기 **전에** 도착해야 한다(지운 뒤면 파일이 되살아난다).
/// - [`change_vault_path`]의 `linked`: vault 핸들을 바꾸기 **전에** 도착해야 한다(바꾼 뒤면
///   옛 노트가 남의 vault에 섞여 들어간다).
///
/// 두 경우 모두 "닫는다 → 사라짐을 확인한다 → 그 다음에 파괴적인 일을 한다" 순서가 되도록
/// 이 함수가 경계를 만든다. 블로킹 대기이므로 **blocking 풀에서** 부른다(이 파일 머리말 참고).
fn close_note_windows_and_settle(app: &AppHandle) -> bool {
    window_manager::close_all_note_windows(app);
    let deadline = Instant::now() + WINDOW_CLOSE_WAIT;
    loop {
        let remaining = app
            .webview_windows()
            .keys()
            .any(|label| label.starts_with("note-"));
        if !remaining {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(WINDOW_CLOSE_POLL);
    }
}

/// 전역 "새 노트" 단축키(기기 고유, `LocalConfig.global_hotkey`)를 읽는다 — 설정 UI 표시용.
#[tauri::command]
pub fn get_global_hotkey(state: State<AppState>) -> Result<String, String> {
    let config = state.lock_config();
    Ok(config.global_hotkey.clone())
}

/// 전역 "새 노트" 단축키를 바꾼다.
///
/// 역할: 새 조합을 **먼저 등록**해 유효성/파싱을 검증하고, 성공하면 이전 조합을 해제한 뒤
/// `LocalConfig`에 영속화한다. 등록 실패면 이전 단축키를 그대로 두고 오류를 돌려준다(창 단위
/// 도구 단축키와 달리 이건 OS 전역이라 런타임 재등록이 필요하다).
/// 왜: 잘못된/충돌 조합으로 앱이 새 노트 단축키를 잃지 않도록 "등록 성공 후 커밋" 순서로 둔다.
#[tauri::command]
pub fn set_global_hotkey(
    app: AppHandle,
    state: State<AppState>,
    accel: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let old = { state.lock_config().global_hotkey.clone() };
    if accel == old {
        return Ok(());
    }
    // 새 조합을 먼저 등록(유효성 검증) — 실패하면 이전 상태를 유지한 채 오류 반환.
    app.global_shortcut()
        .register(accel.as_str())
        .map_err(|e| format!("단축키 등록 실패: {e}"))?;
    // 이전 조합 해제(최선 노력 — 없더라도 무시).
    let _ = app.global_shortcut().unregister(old.as_str());
    // LocalConfig에 영속화(경로 규칙은 [`update_local_config`]가 한 곳에서 안다).
    update_local_config(&app, &state, |config| {
        config.global_hotkey = accel;
    })
}

/// 로컬 설정 한 항목을 바꾸고 곧바로 `config.json`에 영속화한다.
///
/// 역할: "경로 얻기 → 잠그고 대입 → 저장"이라는 세 줄짜리 골격을 한 곳에 둔다(`config.json`
/// 경로는 init·[`set_global_hotkey`]·[`reset_settings`]와 같은 `app_data/config.json`이다).
/// 대입과 저장을 **한 임계구역**에서 하는 이유는 [`commit_shared_settings`]와 같다 — 두
/// `(async)` 커맨드가 겹치면 나중에 깨어난 쪽이 옛 스냅샷을 디스크에 덮어쓸 수 있다.
///
/// [`set_global_hotkey`]도 이 헬퍼를 쓴다(단축키 등록/해제라는 OS 부작용만 자기가 먼저
/// 처리하고, 영속화는 여기로 넘긴다) — 경로 규칙이 두 벌로 갈리면 한쪽만 고쳐졌을 때
/// 단축키가 재시작마다 조용히 사라진다.
fn update_local_config<F>(app: &AppHandle, state: &State<AppState>, apply: F) -> Result<(), String>
where
    F: FnOnce(&mut settings::LocalConfig),
{
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");
    let mut config = state.lock_config();
    apply(&mut config);
    settings::save_local_config(&config_path, &config).map_err(|e| e.to_string())
}

/// 활성 노트가 하나도 없이 시작했을 때 무엇을 띄울지 읽는다(`"panel"` | `"new-note"`).
///
/// 동기 커맨드인 이유: 메모리(`LocalConfig` 사본)만 읽는다 — [`get_global_hotkey`]와 같다.
#[tauri::command]
pub fn get_startup_no_active_action(state: State<AppState>) -> Result<String, String> {
    Ok(state.lock_config().startup_no_active_action.clone())
}

/// 활성 노트가 하나도 없을 때의 시작 동작을 바꾼다.
///
/// **어휘를 검증한다**: 아는 두 값이 아니면 저장하지 않고 오류를 돌려준다
/// ([`settings::is_startup_no_active_action`]). 이 값은 시작 흐름의 분기라 오타 하나가
/// "앱을 켰는데 아무것도 안 뜬다"로 보이므로, 읽는 쪽의 기본값 폴백에만 기대지 않고
/// 들어오는 문 앞에서 막는다.
#[tauri::command(async)]
pub fn set_startup_no_active_action(
    app: AppHandle,
    state: State<AppState>,
    action: String,
) -> Result<(), String> {
    if !settings::is_startup_no_active_action(&action) {
        return Err(format!("알 수 없는 시작 동작입니다: {action:?}"));
    }
    update_local_config(&app, &state, |config| {
        config.startup_no_active_action = action;
    })
}

/// 패널 목록의 정렬 모드를 읽는다(백엔드는 의미를 모르는 불투명 문자열 — 왕복만 한다).
#[tauri::command]
pub fn get_panel_sort(state: State<AppState>) -> Result<String, String> {
    Ok(state.lock_config().panel_sort.clone())
}

/// 패널 목록의 정렬 모드를 저장한다.
///
/// 어휘를 검증하지 **않는** 이유는 `SharedSettings::toolbar_style`과 같다: 정렬 모드의 주인은
/// 프론트(`src/panel/`)이고, 백엔드가 목록을 함께 알면 모드를 하나 늘릴 때마다 Rust도 고쳐야
/// 한다(고치지 않으면 새 모드가 조용히 거부된다). 알 수 없는 값은 읽는 쪽이 기본 모드로
/// 해석하므로 위험도 낮다.
///
/// 대신 **모양만** 막는다 — 빈 문자열(고른 적 없음과 구분되지 않는다)과 터무니없이 긴 값
/// (설정 파일을 부풀리는 사고성 입력)은 거부한다.
#[tauri::command(async)]
pub fn set_panel_sort(app: AppHandle, state: State<AppState>, sort: String) -> Result<(), String> {
    if !is_storable_panel_sort(&sort) {
        return Err(format!("잘못된 정렬 모드입니다: {sort:?}"));
    }
    update_local_config(&app, &state, |config| {
        config.panel_sort = sort;
    })
}

/// 정렬 모드 문자열의 최대 길이(**글자** 수 — 바이트가 아니다). 가장 긴 어휘도 열 몇 자다.
const MAX_PANEL_SORT_CHARS: usize = 64;

/// 정렬 모드 문자열이 저장할 만한 **모양**인지 — [`set_panel_sort`]의 관문.
///
/// 어휘를 보지 않는 이유는 그 커맨드 문서 참고(모드의 주인은 프론트다). 여기서 보는 것은
/// "빈 값이 아닌가"와 "설정 파일을 부풀릴 만큼 길지 않은가" 둘뿐이다.
fn is_storable_panel_sort(sort: &str) -> bool {
    !sort.is_empty() && sort.chars().count() <= MAX_PANEL_SORT_CHARS
}

/// 현재 실행 중인 OS 식별자를 돌려준다(`std::env::consts::OS` — "macos"·"windows"·"linux" 등).
///
/// 역할: 프론트가 플러그인의 OS 지원 여부(매니페스트 `platforms`)를 판정해, 미지원
/// 플러그인을 자동 비활성화·회색 처리하고 OS 배지를 표시하는 데 쓴다.
/// 왜: 컴파일 타깃 OS는 백엔드만 알므로 프론트에 그대로 노출한다(멀티플랫폼 준비).
#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// 시스템에 설치된 글꼴 목록을 돌려준다(설정 글꼴 피커의 「설치된 글꼴」 구역 후보).
///
/// 역할: OS 글꼴 폴더를 훑어 패밀리 이름과 한글 지원 여부를 모은다(파싱은 [`fonts`] 모듈).
/// 왜: 웹뷰에는 로컬 글꼴을 열거하는 API가 없다 — 백엔드만 알 수 있는 정보다.
/// 홈 디렉터리를 못 구하면 사용자 폴더(`~/Library/Fonts`)만 빠지고 나머지는 그대로 훑는다.
///
/// blocking 풀에서 도는 이유: 글꼴 폴더의 파일 **수백 개**를 여는 스캔이다 — 동기 커맨드는
/// 메인 스레드를 잡고, tokio 워커에서 돌리면 고정 크기 워커 풀을 그만큼 붙든다(이 파일
/// 머리말 참고).
///
/// 설정 창에서 뭘 바꾸든 중앙 호스트가 재빌드되며 이 커맨드를 다시 부른다 — 매번 전체
/// 스캔을 돌리지 않도록 [`fonts::list_system_fonts_cached`]가 60초 TTL로 결과를 재사용한다
/// (근거는 그 함수 문서 참고). 캐시가 프로세스 전역이라 홈 디렉터리를 못 구한 호출도 같은
/// 캐시를 공유하지만, 실행 중 홈이 바뀌는 일은 없으므로 문제되지 않는다.
///
/// 반환 타입을 `Result`로 바꾸지 않는 이유: 프론트 계약을 그대로 두려는 것이다(이 커맨드는
/// 원래 실패하지 않는다). 워커가 죽는 극단적인 경우에만 빈 목록이 되고, 그때는 글꼴 피커의
/// 「설치된 글꼴」 구역만 비어 보인다.
#[tauri::command]
pub async fn list_system_fonts(app: AppHandle) -> Vec<fonts::SystemFont> {
    let home = app.path().home_dir().unwrap_or_default();
    blocking(move || Ok(fonts::list_system_fonts_cached(&home)))
        .await
        .unwrap_or_default()
}

/// vault 루트의 절대경로를 돌려준다.
///
/// 역할: 프론트가 `convertFileSrc`로 첨부의 절대경로(웹뷰 URL)를 만들 때, 본문의
/// vault 상대경로(`attachments/...`)와 합칠 기준 경로로 쓴다.
/// 왜: vault 위치는 기기 고유(로컬 설정)라 프론트가 알 수 없으므로 백엔드가 알려준다.
#[tauri::command]
pub fn get_vault_path(state: State<AppState>) -> Result<String, String> {
    let config = state.lock_config();
    Ok(config.vault_path.to_string_lossy().into_owned())
}

// ── 저장 폴더 이전(이슈 #21) ────────────────────────────────────────────────
//
// 역할: "메모가 저장되는 폴더"를 사용자가 바꿀 수 있게 하는 IPC 네 벌. 파일시스템 판정·
// 이동은 전부 [`vault_move`]가 소유하고(그래서 tempdir로 테스트된다), 여기서는 앱 상태
// (설정 영속화 · vault 핸들 교체 · 공유 설정 재로드 · 창 정리)만 다룬다.
//
// 오류는 `"<코드> <설명>"` 문자열이다(`net.rs`의 `NET_*`와 같은 관례) — 프론트는 첫 토큰으로
// 분류해 번역된 안내를 고르므로, 백엔드 문구를 다듬어도 UI 분기가 깨지지 않는다.

/// 현재 저장 폴더의 상태 — 설정 페이지가 경로·내용물 유무를 표시하는 데 쓴다.
#[derive(Serialize)]
pub struct VaultInfo {
    /// vault 루트의 절대경로(표시용).
    pub path: String,
    /// 옮길 내용물(`notes`·`attachments`·`.memo`)이 하나라도 있는지 — UI가 "파일을 함께
    /// 이동" 선택지를 낼지 판단한다(없으면 물어볼 것이 없다).
    pub has_contents: bool,
    /// 노트 수(안내 문구용). 폴더가 없거나 읽지 못하면 0.
    pub note_count: usize,
    /// vault 항목 안의 총 파일 수(안내 문구용).
    pub file_count: usize,
    /// 첫 실행 저장 폴더 안내를 이미 띄웠는지([`settings::LocalConfig::vault_prompted`]).
    /// 노트 창의 1회성 안내가 이 값으로 표시 여부를 정한다.
    pub prompted: bool,
}

/// 고른 폴더가 이전 대상으로 쓸 수 있는지 — 폴더 선택 **직후** 확인해 즉시 안내한다.
#[derive(Serialize)]
pub struct VaultTargetInfo {
    /// 정규화된 절대경로(표시용 — 프론트가 그대로 `change_vault_path`에 되돌려 준다).
    pub path: String,
    /// 이미 vault(`notes/`)가 있는 폴더인지 — 있으면 이동은 거부되고 "연결"만 가능하다.
    pub has_vault: bool,
    /// vault 소유 항목이 하나라도 있는지(`has_vault`가 false여도 `.memo`만 있을 수 있다).
    pub occupied: bool,
    /// 현재 저장 폴더와 같은 곳인지(같으면 바꿀 것이 없다).
    pub same_as_current: bool,
}

/// 저장 폴더 변경 결과 요약.
#[derive(Serialize)]
pub struct VaultChangeResult {
    /// `"moved"`(내용물을 옮김) · `"linked"`(옮기지 않고 그 폴더를 그대로 씀) ·
    /// `"unchanged"`(현재 폴더와 같아 아무것도 하지 않음).
    pub outcome: String,
    /// 적용된 vault 경로(절대).
    pub path: String,
    /// 옮긴 최상위 항목 수(linked/unchanged면 0).
    pub moved_entries: usize,
    /// 옮긴 파일 수(linked/unchanged면 0).
    pub moved_files: usize,
    /// 열려 있던 노트 창을 닫고 새 vault 기준으로 다시 열었는지(linked에서만 true).
    pub windows_reopened: bool,
}

/// 현재 저장 폴더 상태를 읽는다(설정 페이지 표시용).
///
/// `async`인 이유: 노트 수·파일 수를 세느라 디렉터리를 훑는다(이 파일 머리말의 「디스크에
/// 닿는 커맨드는 `(async)`」 정책).
#[tauri::command(async)]
pub fn get_vault_info(state: State<AppState>) -> VaultInfo {
    let (root, prompted) = {
        let config = state.lock_config();
        (config.vault_path.clone(), config.vault_prompted)
    };
    let note_count = Vault::new(&root)
        .list_note_ids()
        .map(|ids| ids.len())
        .unwrap_or(0);
    VaultInfo {
        has_contents: vault_move::has_any_entry(&root),
        note_count,
        file_count: vault_move::count_files(&root),
        prompted,
        path: root.to_string_lossy().into_owned(),
    }
}

/// 첫 실행 저장 폴더 안내를 "띄웠음"으로 표시한다(다시 묻지 않기).
///
/// 노트 창이 안내를 **띄우는 즉시** 부른다(닫을 때가 아니라): 답하지 않고 앱을 끄면 다음 실행에
/// 또 뜨는 편보다, 한 번 보여 준 것으로 끝내는 편이 낫다. 여러 노트 창이 동시에 뜨는 경우에도
/// 먼저 도달한 창이 플래그를 세워 중복 안내를 줄인다.
///
/// 이미 표시돼 있으면 디스크에 쓰지 않는다(부팅 직후 여러 창이 동시에 부를 수 있다).
#[tauri::command(async)]
pub fn mark_vault_prompted(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");
    let mut config = state.lock_config();
    if config.vault_prompted {
        return Ok(());
    }
    config.vault_prompted = true;
    settings::save_local_config(&config_path, &config).map_err(|e| e.to_string())
}

/// 네이티브 폴더 선택 창을 띄우고 고른 폴더의 절대경로를 돌려준다(취소하면 None).
///
/// 메인 스레드 밖에서 돌아야 하는 이유는 [`crate::plugin_commands::pick_plugin_dir`]와 같다:
/// `blocking_pick_folder`는 다이얼로그를 메인 스레드에 띄우고 호출 스레드를 블록하므로,
/// 동기 커맨드(=메인 스레드 실행)에 두면 "메인 스레드가 자기가 띄울 다이얼로그를 기다리는"
/// 교착이 된다.
///
/// tokio 워커가 아니라 **blocking 풀**에서 기다리는 이유: 이 블록은 디스크 IO보다 훨씬 길다
/// (사용자가 폴더를 고를 때까지 — 몇 분일 수도 있다). 고정 크기 워커 풀에서 기다리면 그동안
/// 다른 커맨드가 쓸 워커가 하나 줄어든 채로 남는다.
#[tauri::command]
pub async fn pick_vault_folder(app: AppHandle) -> Option<String> {
    blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        Ok(app
            .dialog()
            .file()
            .set_title("저장 폴더 선택")
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .unwrap_or_default()
}

/// 고른 폴더를 검사한다 — 읽기/쓰기 권한을 **실제로 써 보고** 확인하고, 이미 vault인지 알려준다.
///
/// 왜 변경 커맨드와 따로 있나: 사용자에게 무엇을 물을지가 이 결과로 갈린다. 대상이 비어
/// 있으면 "파일을 함께 옮길까요?"를, 이미 메모가 있으면 "이동 없이 그 폴더를 쓸까요?"를
/// 물어야 한다 — 먼저 바꿔 보고 실패 메시지로 되묻는 것보다 정직하다. 권한 오류도 폴더를
/// 고른 **직후** 알려 준다(내용물을 옮기기 시작한 뒤가 아니라).
///
/// 이 커맨드는 폴더를 만들지 않는다(선택기가 돌려준 폴더는 이미 존재한다). 생성은 실제
/// 변경([`change_vault_path`])의 몫이다.
#[tauri::command(async)]
pub fn inspect_vault_folder(
    state: State<AppState>,
    path: String,
) -> Result<VaultTargetInfo, String> {
    let target = vault_move::normalize_target(&path)?;
    vault_move::probe_access(&target)?;
    let current = state.lock_config().vault_path.clone();
    Ok(VaultTargetInfo {
        has_vault: vault_move::has_vault(&target),
        occupied: vault_move::has_any_entry(&target),
        same_as_current: vault_move::same_dir(&target, &current),
        path: target.to_string_lossy().into_owned(),
    })
}

/// 저장 폴더를 바꾼다 — 이슈 #21의 본체.
///
/// ## 시나리오
///
/// | 대상 상태 | `move_files` | 결과 |
/// | --- | --- | --- |
/// | 현재 폴더와 같음 | 무관 | `unchanged` — 아무것도 하지 않는다 |
/// | 비어 있음(없으면 만든다) | true | `moved` — 내용물을 옮기고 그 폴더를 쓴다 |
/// | 비어 있음 | false | `linked` — 옮기지 않고 그 폴더를 쓴다(빈 vault로 시작) |
/// | 이미 vault(`notes/`) | true | **거부**(`VAULT_TARGET_HAS_VAULT`) — 합치면 어느 쪽이 정본인지 알 수 없다 |
/// | 이미 vault | false | `linked` — 그 vault를 그대로 이어 쓴다(다른 기기의 동기화 폴더를 붙이는 경로) |
/// | vault 항목 일부만 있음 | true | **거부**(`VAULT_TARGET_OCCUPIED`) |
/// | 쓰기/읽기 불가 | 무관 | **거부**(`VAULT_NOT_WRITABLE`/`VAULT_NOT_READABLE`) — 프로브 파일로 실측 |
/// | 현재 vault의 하위 폴더 | true | **거부**(`VAULT_NESTED`) — 자기 안으로 옮길 수 없다 |
///
/// 크로스 드라이브 이동(rename 실패)은 [`vault_move::move_contents`]가 복사+삭제로 폴백하고,
/// **모든 복사가 성공한 뒤에만** 원본을 지운다(중간에 실패하면 원본이 그대로 남는다).
///
/// ## 성공 후 무엇이 갱신되나
///
/// 1. `LocalConfig.vault_path` 갱신 + `config.json` 저장.
/// 2. [`AppState`]의 vault 핸들을 새 경로로 교체(`Vault`는 경로만 든 핸들이라 통째 교체가 정본).
/// 3. 새 vault의 `.memo/shared-settings.json`을 다시 읽어 공유 설정 교체 — 언어가 달라졌으면
///    트레이도 다시 그린다(`save_shared_settings`와 같은 경로 · 실패는 비치명적).
/// 4. `linked`면 열린 노트 창을 **전부 닫고** 새 vault 기준으로 다시 연다. 왜 닫는가:
///    그 창들이 보여주던 노트는 새 vault에 없을 수 있는데, 열어 둔 채로 두면 다음
///    자동저장([`note_save_content`])이 **새 vault에 그 노트를 만들어 낸다** — 남의 vault를
///    붙였더니 내 옛 메모가 섞여 들어가는 사고다(`wipe_all_data`가 같은 이유로 창을 닫는다).
///    `moved`는 노트 id가 그대로라 창 라벨도 유효하므로 닫지 않는다(작업 중인 창을 지킨다).
///
/// ## 이동 중 자동저장과의 경합(데이터 손실 경로)
///
/// `moved`는 창을 닫지 않으므로 이동이 도는 내내 자동저장(타이핑 500ms 디바운스)이 계속
/// 날아온다. 예전에는 이동이 vault 잠금을 전혀 잡지 않고 핸들 교체도 이동 **뒤**에 했기
/// 때문에, 그 저장들이 전부 **옛 폴더**로 들어갔다.
///
/// - 크로스 드라이브(복사+삭제 폴백): 복사가 끝난 뒤 도착한 저장은 옛 `notes/<id>.md`에
///   쓰이고, 곧이어 도는 원본 삭제(`remove_dir_all`)에 함께 지워졌다 — 오류도 로그도 없이
///   사용자 본문이 사라지는 경로다.
/// - 같은 볼륨(rename): rename 뒤 도착한 저장은 [`crate::io::write_atomic`]이 부모
///   디렉터리를 다시 만들어 옛 폴더에 고아 파일을 남겼다(설정은 새 폴더를 가리키므로 그
///   편집은 어디에서도 보이지 않는다).
///
/// 그래서 [`move_vault_locked`]가 **이동 전 구간과 핸들 교체를 하나의 vault 잠금 아래에**
/// 둔다. 이동 전에 이미 잠금을 얻은 저장은 이동 시작을 붙잡아 두었다가 옛 폴더에 쓰고 그대로
/// 함께 옮겨지며, 이동 중에 도착한 저장은 잠금을 얻는 순간 **이미 교체된 새 경로**를 보므로
/// 새 폴더에 쓰인다 — 어느 쪽도 잃지 않는다.
///
/// 대가: 이동이 도는 동안(수천 파일이면 수 초) 노트 읽기·쓰기가 잠금에서 기다린다. 창을
/// 닫아 버리는 대안(`linked`처럼)보다 이쪽을 고른 이유는 (1) 작업 중이던 창과 그 안의 미저장
/// 편집을 지킬 수 있고, (2) 닫기는 `pagehide` flush를 **유발**해 "닫았으니 안전"이 성립하지
/// 않기 때문이다([`close_note_windows_and_settle`] 참고).
///
/// 순서 근거: **옮기고 나서 저장한다**. 반대로 하면 이동이 실패했을 때 설정만 새 폴더(빈 곳)를
/// 가리켜 메모가 통째로 사라진 것처럼 보인다. 저장이 실패하는 드문 경우엔 데이터가 이미 새
/// 위치에 있으므로 메모리 상태는 새 경로로 커밋해 이번 세션이 정상 동작하게 하고, 오류만
/// 돌려준다(`VAULT_CONFIG_SAVE_FAILED` — 프론트가 "다음 실행 때 예전 폴더로 돌아간다"고 안내).
///
/// `async`인 이유: 폴더 수백~수천 개 파일을 옮길 수 있다 — 동기 커맨드였다면 그동안 모든 창이
/// 얼어붙는다(이슈 #22의 정확한 재현 조건).
#[tauri::command]
pub async fn change_vault_path(
    app: AppHandle,
    state: State<'_, AppState>,
    new_path: String,
    move_files: bool,
) -> Result<VaultChangeResult, String> {
    let target = vault_move::normalize_target(&new_path)?;
    let current = state.lock_config().vault_path.clone();

    if vault_move::same_dir(&target, &current) {
        return Ok(VaultChangeResult {
            outcome: "unchanged".to_string(),
            path: current.to_string_lossy().into_owned(),
            moved_entries: 0,
            moved_files: 0,
            windows_reopened: false,
        });
    }

    // 대상 폴더 보장 + 읽기/쓰기 실측(프로브 파일). 내용물을 건드리기 **전**의 유일한 관문이다.
    vault_move::ensure_dir(&target)?;
    vault_move::probe_access(&target)?;

    let (outcome, report) = if move_files {
        if vault_move::has_vault(&target) {
            return Err(format!(
                "{} 옮기려는 폴더에 이미 메모가 있습니다: {}",
                vault_move::ERR_TARGET_HAS_VAULT,
                target.display()
            ));
        }
        if vault_move::has_any_entry(&target) {
            return Err(format!(
                "{} 옮기려는 폴더에 이미 앱 데이터가 있습니다: {}",
                vault_move::ERR_TARGET_OCCUPIED,
                target.display()
            ));
        }
        if vault_move::is_inside(&target, &current) {
            return Err(format!(
                "{} 지금 저장 폴더의 하위 폴더로는 옮길 수 없습니다: {}",
                vault_move::ERR_NESTED,
                target.display()
            ));
        }
        // 이동 + 핸들 교체를 vault 잠금 아래에서, blocking 풀에서 수행한다(위 문서 참고).
        let handle = state.vault_handle();
        let (from, to) = (current.clone(), target.clone());
        let report = blocking(move || move_vault_locked(&handle, &from, &to)).await?;
        ("moved".to_string(), report)
    } else {
        ("linked".to_string(), vault_move::MoveReport::default())
    };

    // 여기부터는 커밋 구간이다 — 데이터는 이미 제자리에 있다.
    let windows_reopened = outcome == "linked";
    // linked 커밋 구간(핸들 교체~설정 저장)에만 걸리는 봉인. 창이 **다 닫힌 뒤에** 건다:
    // 닫는 중에 도착하는 마지막 flush는 아직 옛 vault로 가는 정상 저장이라 막으면 안 되고,
    // 다 닫힌 뒤에도 오는 저장은 제한 시간 안에 닫히지 못한 창의 것이므로 새 vault를
    // 오염시키기 전에 거부해야 한다. 이 가드는 커맨드가 끝날 때 풀린다.
    let _commit_seal;
    if windows_reopened {
        // **vault 핸들을 바꾸기 전에** 닫고, 실제로 사라질 때까지 기다린다. 열려 있던 창들이
        // 보여주던 노트는 새 vault에 없을 수 있는데, 먼저 핸들부터 바꾸면 그 창의 다음
        // 자동저장(타이핑 500ms 디바운스)이 새 vault에 옛 노트를 만들어 낸다 — 남의 vault를
        // 붙였더니 내 옛 메모가 섞이는 사고다. 게다가 닫는 행위 자체가 `pagehide` flush를
        // 발사하므로(close_note_windows_and_settle 문서 참고) "닫았다"만으로는 부족하다.
        // 사라짐을 확인하고 나서 교체하면 그 마지막 flush는 아직 **옛** vault로 간다(정답).
        let waiting = app.clone();
        let settled = blocking(move || Ok(close_note_windows_and_settle(&waiting))).await?;
        if !settled {
            eprintln!(
                "[memo] 저장 폴더 변경: 노트 창이 제때 닫히지 않았습니다({}ms) — 남은 창의 마지막 저장이 새 폴더로 샐 수 있습니다",
                WINDOW_CLOSE_WAIT.as_millis()
            );
        }
        _commit_seal = Some(state.seal_note_writes());
        // `moved`는 [`move_vault_locked`]가 이동과 같은 임계구역에서 이미 교체했다.
        *state.lock_vault() = Vault::new(&target);
    } else {
        _commit_seal = None;
    }

    let lang_changed = adopt_shared_settings(&state, settings::load_shared_settings(&target));

    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");
    {
        let mut config = state.lock_config();
        config.vault_path = target.clone();
        if let Err(e) = settings::save_local_config(&config_path, &config) {
            return Err(format!(
                "VAULT_CONFIG_SAVE_FAILED 폴더는 바뀌었지만 설정을 저장하지 못했습니다: {e}"
            ));
        }
    }

    if windows_reopened {
        // 새 vault의 보관되지 않은 노트를 시작 때와 같은 규칙으로 연다. 닫기 요청이 이벤트
        // 루프에 먼저 쌓인 뒤 열기가 돌도록 메인 스레드로 넘긴다 — 닫히는 중인 창을 같은
        // 라벨로 다시 여는 경합을 피한다(연결한 vault의 노트 id가 우연히 겹칠 수 있다).
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            window_manager::open_startup_windows(&handle);
        }) {
            eprintln!("[memo] 저장 폴더 변경: 노트 창 다시 열기 디스패치 실패: {e}");
        }
    }

    if lang_changed {
        let handle = app.clone();
        let dispatched = app.run_on_main_thread(move || {
            if let Err(e) = crate::tray::refresh_for_language_change(&handle) {
                eprintln!("[memo] 저장 폴더 변경: 트레이 언어 갱신 실패: {e}");
            }
        });
        if let Err(e) = dispatched {
            eprintln!("[memo] 저장 폴더 변경: 트레이 언어 갱신 디스패치 실패: {e}");
        }
    }

    Ok(VaultChangeResult {
        outcome,
        path: target.to_string_lossy().into_owned(),
        moved_entries: report.entries,
        moved_files: report.files,
        windows_reopened,
    })
}

/// vault 잠금을 **쥔 채** 내용물을 옮기고, 같은 임계구역에서 핸들을 새 경로로 바꾼다.
///
/// 이 함수가 [`change_vault_path`]에서 따로 떨어져 나온 이유는 두 가지다. (1) 잠금을 놓는
/// 지점이 곧 이 수정의 전부이므로 한 곳에 모아 두어야 나중에 실수로 벌어지지 않는다.
/// (2) Tauri 없이 테스트할 수 있다 — 실제 스레드로 "이동 중 자동저장"을 재현하는 가드 테스트가
/// 이 함수를 직접 부른다.
///
/// 실패하면 핸들을 바꾸지 않는다(`?`로 빠져나가며 잠금만 풀린다) — 데이터가 그대로 있는
/// 옛 경로를 계속 가리키는 것이 정답이다.
fn move_vault_locked(
    handle: &VaultHandle,
    from: &Path,
    to: &Path,
) -> Result<vault_move::MoveReport, String> {
    let mut vault = handle.lock();
    let report = vault_move::move_contents(from, to)?;
    *vault = Vault::new(to);
    Ok(report)
}

// ── 설정·플러그인 백업(이슈 #28 1단계) ──────────────────────────────────────
//
// 역할: 설정 창 「관리 › 백업」이 쓰는 IPC 네 벌. 포맷·파일시스템·복원 정책은 전부
// [`backup`] 모듈이 소유하고(그래서 tempdir로 테스트된다), 여기서는 (1) 네이티브 다이얼로그,
// (2) 앱 상태 반영(공유 설정 사본 교체·자동 실행·전역 단축키 재등록·트레이 갱신)만 한다 —
// 저장 폴더 이전(`change_vault_path`)이 `vault_move`와 나눈 분업을 그대로 반복한다.
//
// 오류는 `"BACKUP_* 설명"` 문자열이다(`VAULT_*`와 같은 관례) — 프론트는 첫 토큰으로 분기한다.

/// 현재 로컬 설정에서 **이식 가능한 조각**만 뽑는다(자동 실행·전역 단축키·시작 동작·정렬 모드).
///
/// `vault_path`·`welcomed`·`vault_prompted`가 빠지는 이유는 [`backup`] 모듈 문서 참고 —
/// 기기 종속 값과 1회성 흔적은 백업의 몫이 아니다. 반대로 시작 동작과 정렬 모드는 기기를
/// 옮겨도 뜻이 그대로인 **취향**이라 함께 담는다.
fn portable_prefs(state: &State<AppState>) -> (std::path::PathBuf, backup::PortablePrefs) {
    let config = state.lock_config();
    (
        config.vault_path.clone(),
        backup::PortablePrefs {
            launch_at_login: config.launch_at_login,
            global_hotkey: config.global_hotkey.clone(),
            startup_no_active_action: config.startup_no_active_action.clone(),
            panel_sort: config.panel_sort.clone(),
        },
    )
}

/// 복원된 백업의 시작 동작을 어휘 관문에 통과시킨다 — 모르는 값이면 기본값(`"panel"`).
///
/// 백업 파일은 **손으로 고칠 수 있는 외부 입력**이다. [`set_startup_no_active_action`]이
/// 막는 값이 복원이라는 뒷문으로 `config.json`에 들어가면, 설정 창 드롭다운은 그 값을 고를
/// 수 없어 첫 옵션을 보여 주고 사용자는 "바꾸지도 않은 설정이 화면과 다르다"를 겪는다.
fn sanitized_startup_no_active_action(prefs: &backup::PortablePrefs) -> String {
    if settings::is_startup_no_active_action(&prefs.startup_no_active_action) {
        prefs.startup_no_active_action.clone()
    } else {
        settings::startup_no_active_action_default()
    }
}

/// 복원된 백업의 정렬 모드를 모양 관문에 통과시킨다 — 빈 값·과도하게 긴 값이면 기본값.
///
/// 어휘까지 보지 않는 이유는 [`set_panel_sort`]와 같다(모드의 주인은 프론트다) — 여기서도
/// 커맨드와 **정확히 같은 관문**([`is_storable_panel_sort`])만 쓴다.
fn sanitized_panel_sort(prefs: &backup::PortablePrefs) -> String {
    if is_storable_panel_sort(&prefs.panel_sort) {
        prefs.panel_sort.clone()
    } else {
        settings::panel_sort_default()
    }
}

/// 설정 + 플러그인을 파일 하나로 내보낸다. 저장 위치는 네이티브 저장 다이얼로그로 받는다.
///
/// 취소하면 `Ok(None)` — 취소는 오류가 아니므로 프론트가 아무 말도 하지 않는다
/// ([`pick_vault_folder`]가 취소를 `None`으로 돌려주는 것과 같은 관례).
///
/// `(async)`가 **필수**인 이유는 [`pick_vault_folder`]와 같다: `blocking_save_file`은
/// 다이얼로그를 메인 스레드에 띄우고 호출 스레드를 블록하므로, 동기 커맨드(=메인 스레드
/// 실행)에 두면 "메인 스레드가 자기가 띄울 다이얼로그를 기다리는" 교착이 된다. 아카이브를
/// 만드는 디스크 IO(플러그인 코드 전부를 읽는다)도 같은 이유로 메인 밖에 있어야 한다.
#[tauri::command(async)]
pub fn export_backup(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<backup::BackupSummary>, String> {
    use tauri_plugin_dialog::DialogExt;
    let created_at = crate::notes::now_ms();
    let picked = app
        .dialog()
        .file()
        .set_title("백업 저장 위치")
        .set_file_name(backup::default_file_name(created_at))
        .add_filter("note-rang 백업", &["zip"])
        .blocking_save_file()
        .and_then(|path| path.into_path().ok());
    let Some(dest) = picked else {
        return Ok(None); // 취소 — 아무 일도 하지 않는다.
    };
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (vault_root, prefs) = portable_prefs(&state);
    backup::write_backup(
        &app_data,
        &vault_root,
        &prefs,
        &app.package_info().version.to_string(),
        created_at,
        &dest,
    )
    .map(Some)
}

/// 네이티브 파일 선택 창을 띄우고 고른 백업의 절대경로를 돌려준다(취소하면 None).
///
/// 선택과 검사를 나누는 이유는 저장 폴더 이전([`pick_vault_folder`] + [`inspect_vault_folder`])과
/// 같다: 고른 **직후** 내용을 보여 주고 무엇을 복원할지 묻기 위함이다.
#[tauri::command(async)]
pub fn pick_backup_file(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("백업 파일 선택")
        .add_filter("note-rang 백업", &["zip"])
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// 백업 파일의 내용을 요약해 돌려준다(복원 전 미리보기).
///
/// 이 앱이 모르는 더 새로운 스키마도 오류가 아니라 `supported: false`로 돌려준다 — 미리보기가
/// "이건 더 새 버전에서 만든 백업이다"라고 설명할 수 있어야 하기 때문이다(거부는 복원의 몫).
#[tauri::command(async)]
pub fn inspect_backup(path: String) -> Result<backup::BackupSummary, String> {
    backup::inspect_backup_file(std::path::Path::new(&path))
}

/// 백업에서 복원한다(파괴적 — 프론트가 확인 다이얼로그를 거친 뒤에만 부른다).
///
/// [`backup::import_backup_file`]이 복원 직전 현재 상태를 vault의 `.memo/backups/`에 자동
/// 스냅샷하므로, 결과가 마음에 들지 않으면 그 파일을 다시 가져오면 된다(경로는 결과에 담겨
/// 프론트가 안내한다).
///
/// 복원 뒤 이 커맨드가 하는 앱 상태 반영은 [`reset_settings`]와 같은 세 가지다: 공유 설정
/// 메모리 사본 교체(+ 언어가 바뀌었으면 트레이 재구성), 자동 실행 동기화, 전역 단축키
/// 재등록. 셋 다 실패해도 복원 자체를 되돌리지 않는다(디스크에는 이미 반영됐고, 다음 실행이
/// 같은 값으로 다시 시도한다). 열려 있는 창들의 재빌드는 프론트 래퍼가 내는 재로드 신호가
/// 맡는다 — 설정 저장·초기화와 같은 채널이다.
#[tauri::command(async)]
pub fn import_backup(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    restore: backup::RestoreSelection,
) -> Result<backup::ImportReport, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (vault_root, prefs) = portable_prefs(&state);
    let outcome = backup::import_backup_file(
        &app_data,
        &vault_root,
        &prefs,
        &app.package_info().version.to_string(),
        crate::notes::now_ms(),
        std::path::Path::new(&path),
        restore,
    )?;

    if let Some(shared) = outcome.shared {
        // 디스크에는 복원기가 이미 썼다 — 여기서는 메모리 사본만 한 임계구역에서 교체한다.
        let lang_changed = adopt_shared_settings(&state, shared);
        if lang_changed {
            let handle = app.clone();
            let dispatched = app.run_on_main_thread(move || {
                if let Err(e) = crate::tray::refresh_for_language_change(&handle) {
                    eprintln!("[memo] 백업 복원: 트레이 언어 갱신 실패: {e}");
                }
            });
            if let Err(e) = dispatched {
                eprintln!("[memo] 백업 복원: 트레이 언어 갱신 디스패치 실패: {e}");
            }
        }
    }

    if let Some(restored) = outcome.prefs {
        let config_path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("config.json");
        let old_hotkey = {
            let mut config = state.lock_config();
            let old = config.global_hotkey.clone();
            config.launch_at_login = restored.launch_at_login;
            config.global_hotkey = restored.global_hotkey.clone();
            // 구버전 백업에는 이 두 값이 없다 — 그때는 복원기가 채운 기본값이 들어온다
            // (`PortablePrefs`의 serde 기본값 참고: 없다고 복원 전체를 깨뜨리지 않는다).
            // 값이 있더라도 **커맨드와 같은 관문**을 통과시킨다: 백업 파일은 사용자가 손으로
            // 고칠 수 있는 외부 입력이라, `set_*` 커맨드로는 절대 못 들어오는 값이 이 뒷문으로
            // 영속화되면 안 된다(런타임은 폴백으로 안전하지만 설정 창 드롭다운이 저장값과
            // 어긋나 보인다).
            config.startup_no_active_action = sanitized_startup_no_active_action(&restored);
            config.panel_sort = sanitized_panel_sort(&restored);
            if let Err(e) = settings::save_local_config(&config_path, &config) {
                eprintln!("[memo] 백업 복원: 로컬 설정 저장 실패: {e}");
            }
            old
        };
        crate::sync_autostart_state(&app, restored.launch_at_login);
        let handle = app.clone();
        let new_hotkey = restored.global_hotkey.clone();
        let dispatched = app.run_on_main_thread(move || {
            if let Err(e) = reset_global_hotkey(&handle, &old_hotkey, &new_hotkey) {
                eprintln!("[memo] 백업 복원: 전역 단축키 재등록 실패: {e}");
            }
        });
        if let Err(e) = dispatched {
            eprintln!("[memo] 백업 복원: 전역 단축키 재등록 디스패치 실패: {e}");
        }
    }

    Ok(outcome.report)
}

/// 붙여넣은 이미지 바이트를 vault에 저장하고 본문에 넣을 vault 상대경로를 돌려준다.
///
/// 역할: 프론트의 붙여넣기 핸들러가 읽은 바이트를 `attachments/<note_id>/<uuid>.<ext>`로
/// 저장(원자적)하고 그 상대경로를 반환한다. 저장 로직은 [`attachments`] 모듈에서 테스트한다.
///
/// `async`인 이유: 붙여넣은 이미지는 수 MB일 수 있다 — 동기 커맨드면 그 바이트를 디스크에
/// 쏟는 동안 메인 스레드가 통째로 묶인다(붙여넣기 한 번에 앱이 굳는다). 그 IO는 blocking
/// 풀로 넘긴다(이 파일 머리말의 「blocking 풀에서」 정책 — 수 MB 쓰기는 tokio 워커를 붙들기에
/// 가장 나쁜 크기다).
///
/// 저장 위치를 `LocalConfig.vault_path`가 아니라 **vault 핸들**에서 얻는 이유: 첨부도 노트
/// 파일과 같은 폴더에 사는데, 두 출처는 저장 폴더 이전 중에 갈린다(`config.vault_path`는
/// 이동이 끝난 뒤에야 갱신된다). 옛 경로를 쓰면 이동의 원본 삭제가 방금 붙여넣은 이미지를
/// 함께 지운다 — 노트 본문에는 링크만 남고 그림은 없는 상태가 된다. 잠금을 통해 얻으면
/// 노트 저장과 정확히 같은 규칙으로 직렬화된다([`change_vault_path`] 문서 참고).
#[tauri::command]
pub async fn save_attachment(
    state: State<'_, AppState>,
    note_id: String,
    data: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let handle = state.vault_handle();
    blocking(move || {
        let vault = handle.lock_for_write()?;
        attachments::save_attachment(vault.root(), &note_id, &data, &ext).map_err(|e| e.to_string())
    })
    .await
}

/// 브라우저에 넘겨도 되는 외부 탐색 스킴 전수(allowlist) — 이 밖은 전부 거부한다.
///
/// 왜 https 단독이 아닌가: 이 커맨드는 **탐색**이지 코드 반입이 아니다. 공유기 관리 페이지처럼
/// http만 있는 주소와 GFM 자동링크가 만드는 mailto를 못 열면 노트 본문 링크가 조용히 죽는다.
/// 반대로 `javascript:`·`file:`·`ms-*`류는 `open`이 등록된 앱 핸들러를 깨우는 실행 경로라
/// 밖에 둔다. 설치 검증([`crate::plugin_install::validate_https_url`])은 코드가 들어오는
/// 길이라 여전히 https 단독이다 — 두 정책이 다른 것은 의도다.
const EXTERNAL_URL_SCHEMES: [&str; 3] = ["https://", "http://", "mailto:"];

/// 외부 탐색 URL을 검증한다(스킴 allowlist · 빈 대상 · 공백/제어문자 거부).
///
/// 스킴 비교만 소문자로 접는다(스킴은 대소문자 무시가 표준) — 나머지 원문은 그대로 `open`에
/// 넘긴다. 대상이 비면(`https://`뿐) 거부해 `open`이 인자를 파일로 해석하는 길을 막는다.
fn validate_external_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let scheme = EXTERNAL_URL_SCHEMES
        .iter()
        .find(|s| lower.starts_with(**s))
        .ok_or_else(|| format!("열 수 없는 주소입니다: {url}"))?;
    if url.len() == scheme.len() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("URL 형식이 올바르지 않습니다: {url}"));
    }
    Ok(())
}

/// 외부 URL을 사용자 기본 브라우저로 연다 — 노트 본문 링크·README 링크 등 앱 밖 탐색 전용.
///
/// 역할: 웹뷰 안 탐색은 렌더러가 막고(anchor 기본 동작 차단), 열기는 OS별 시스템 도구에
/// 위임한다 — macOS `/usr/bin/open`(기본 탑재), Windows `rundll32 url.dll,FileProtocolHandler`,
/// Linux `xdg-open`. 스킴은 [`EXTERNAL_URL_SCHEMES`] allowlist로 거른다. 실행은 spawn(비차단)
/// 이며 실패만 오류로 돌려준다. 프론트도 같은 집합으로 링크 표시를 게이트하지만(live-preview),
/// 판정 권한은 여기다 — 프론트가 이미 걸렀다고 믿지 않는다.
///
/// Windows에서 `cmd /C start`가 아니라 rundll32를 쓰는 이유: `start`는 cmd.exe 셸을 거쳐
/// URL 안 `&`·`%`·`^` 같은 문자를 명령 구분자·변수 확장으로 오독할 수 있다(쿼리스트링의
/// `&`는 흔하다). rundll32는 셸 파싱 없이 인자를 그대로 받는 별도 프로세스라 이 문제가
/// 없다 — Windows "실행" 대화상자가 URL을 열 때 내부적으로 쓰는 것과 같은 경로다.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("브라우저 열기 실패: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 = CREATE_NO_WINDOW. rundll32 자체는 콘솔을 띄우지 않지만 방어적으로
        // 막아 어떤 경로로도 검은 창이 깜빡이지 않게 한다.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("브라우저 열기 실패: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("브라우저 열기 실패: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// tempdir 하나로 상태를 만든다(테스트 공용).
    fn state_at(root: &Path) -> AppState {
        AppState::new(
            Vault::new(root),
            SharedSettings::default(),
            settings::LocalConfig::with_defaults(root),
        )
    }

    /// "이동 중 자동저장"을 실제 스레드로 재현한다 — 이동이 끝난 것을 본 뒤에도 몇 번 더 쓴다.
    ///
    /// 돌려주는 값: (마지막으로 쓴 본문, 노트 id). 쓰기가 한 번이라도 실패하면 패닉한다 —
    /// 이동 중 저장은 **기다렸다가 성공**해야 하지 거부되면 안 된다(거부는 곧 타이핑 유실이다).
    fn write_across_move(state: &AppState, from: &Path, to: &Path) -> (String, String) {
        let id = state.lock_vault().create_note("처음").unwrap();
        let handle = state.vault_handle();
        let mover = {
            let handle = handle.clone();
            let (from, to) = (from.to_path_buf(), to.to_path_buf());
            std::thread::spawn(move || move_vault_locked(&handle, &from, &to))
        };

        let mut last = String::new();
        let mut after_move = 0;
        loop {
            // 이동 스레드가 끝났는지 **쓰기 전에** 본다 — 끝난 뒤의 쓰기가 새 경로로 가는지
            // 확인하려는 것이므로 순서가 중요하다.
            let finished = mover.is_finished();
            last = format!("편집 {}", last.len());
            {
                let vault = handle
                    .lock_for_write()
                    .expect("이동 중 저장이 거부되면 안 된다");
                vault.write_content(&id, &last).expect("이동 중 저장 실패");
            }
            if finished {
                after_move += 1;
                if after_move >= 3 {
                    break;
                }
            }
        }
        mover.join().unwrap().expect("이동 자체가 실패했다");
        (last, id)
    }

    /// 가드(데이터 손실): 같은 볼륨 이동(rename) 중에 들어온 자동저장이 **옛 폴더에 고아로
    /// 남지 않는다**.
    ///
    /// 예전에는 이동이 vault 잠금을 잡지 않고 핸들 교체도 이동 뒤였기 때문에, rename이 끝난
    /// 뒤 도착한 저장이 `write_atomic`의 부모 디렉터리 재생성을 타고 옛 폴더에 `notes/`를
    /// 다시 만들었다 — 설정은 새 폴더를 가리키므로 그 편집은 어디에서도 보이지 않는 고아가
    /// 되고, 옛 폴더는 `looks_like_vault`까지 다시 true가 됐다.
    #[test]
    fn move_under_lock_leaves_no_orphan_in_old_folder() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let state = state_at(from.path());

        let (last, id) = write_across_move(&state, from.path(), to.path());

        let vault = state.lock_vault();
        assert_eq!(
            vault.root(),
            &to.path().to_path_buf(),
            "핸들이 교체돼야 한다"
        );
        assert_eq!(
            vault.read_content(&id).unwrap(),
            last,
            "마지막 편집이 새 폴더에 있어야 한다"
        );
        assert!(
            !from.path().join("notes").exists(),
            "옛 폴더에 notes/가 되살아나면 그 편집은 아무도 보지 못한다"
        );
    }

    /// 가드(데이터 손실): 복사+삭제 폴백(크로스 드라이브) 중에 들어온 자동저장이 **원본 삭제에
    /// 함께 지워지지 않는다**.
    ///
    /// 대상에 vault 항목이 하나라도 있으면 `move_contents`는 rename 단계를 건너뛰고 복사
    /// 폴백으로 내려간다 — 크로스 드라이브(EXDEV)와 같은 경로다. 그 폴백은 전부 복사한 **뒤**
    /// 원본을 `remove_dir_all`로 지우므로, 복사와 삭제 사이에 옛 폴더로 들어간 저장은 오류도
    /// 로그도 없이 영구히 사라졌다.
    #[test]
    fn move_copy_fallback_does_not_delete_concurrent_saves() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        // 대상에 `.memo`를 미리 만들어 rename 단계를 막고 복사 폴백을 강제한다.
        std::fs::create_dir_all(to.path().join(".memo")).unwrap();
        let state = state_at(from.path());

        let (last, id) = write_across_move(&state, from.path(), to.path());

        let vault = state.lock_vault();
        assert_eq!(vault.root(), &to.path().to_path_buf());
        assert_eq!(
            vault.read_content(&id).unwrap(),
            last,
            "복사 폴백에서도 마지막 편집이 살아 있어야 한다"
        );
        assert!(!from.path().join("notes").exists());
    }

    /// 가드: 이동이 실패하면 핸들을 바꾸지 않는다 — 데이터가 그대로 있는 옛 경로를 계속
    /// 가리켜야 한다(새 폴더를 가리키면 메모가 통째로 사라진 것처럼 보인다).
    #[test]
    fn failed_move_keeps_old_handle() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let state = state_at(from.path());
        let id = state.lock_vault().create_note("본문").unwrap();
        // 대상의 `notes`를 **파일**로 만들어 복사·rename이 모두 실패하게 한다.
        std::fs::write(to.path().join("notes"), b"blocker").unwrap();

        let handle = state.vault_handle();
        assert!(move_vault_locked(&handle, from.path(), to.path()).is_err());
        let vault = state.lock_vault();
        assert_eq!(vault.root(), &from.path().to_path_buf());
        assert_eq!(vault.read_content(&id).unwrap(), "본문");
    }

    /// 가드: 봉인 중 저장은 거부된다 — "모든 데이터 삭제"가 창을 닫을 때 터지는 마지막
    /// `pagehide` flush가 방금 지운 노트를 되살리지 못하게 하는 장치다.
    #[test]
    fn sealed_writes_cannot_resurrect_wiped_notes() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let id = state.lock_vault().create_note("지울 노트").unwrap();

        let seal = state.seal_note_writes();
        state.lock_vault().wipe_all().unwrap();
        // 지운 **뒤** 도착한 저장(=창이 닫히며 나간 flush)은 파일을 만들지 못한다.
        let handle = state.vault_handle();
        assert!(handle.lock_for_write().is_err());
        assert!(!state.lock_vault().md_path(&id).exists());

        // 봉인이 풀리면 정상 사용으로 돌아온다(삭제 뒤 새 노트를 만드는 건 막지 않는다).
        drop(seal);
        assert!(state.lock_vault_for_write().is_ok());
    }

    /// 가드: 공유 설정 저장이 겹쳐도 디스크와 메모리가 갈리지 않는다.
    ///
    /// 예전에는 "디스크에 쓰고 → 잠그고 → 대입"이라 두 저장이 인터리브되면 나중에 깨어난
    /// 쪽이 메모리를 옛 값으로 덮었다(디스크는 light인데 화면은 dark로 남고, 재시작하면
    /// 아무도 건드리지 않은 테마가 뒤집힌다).
    #[test]
    fn concurrent_shared_saves_keep_disk_and_memory_equal() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(state_at(dir.path()));
        let root = dir.path().to_path_buf();

        std::thread::scope(|scope| {
            for n in 0..8 {
                let state = Arc::clone(&state);
                let root = root.clone();
                scope.spawn(move || {
                    for round in 0..25 {
                        let next = SharedSettings {
                            theme: format!("테마-{n}-{round}"),
                            ..Default::default()
                        };
                        commit_shared_settings(&state, &root, next).unwrap();
                    }
                });
            }
        });

        let on_disk = settings::load_shared_settings(&root);
        let in_memory = state.lock_shared().clone();
        assert_eq!(
            in_memory.theme, on_disk.theme,
            "메모리와 디스크가 갈리면 재시작 때 설정이 뒤집힌다"
        );
    }

    /// 가드: 언어 변경 판정도 대입과 같은 임계구역에서 이뤄진다 — 겹쳐 저장해도 "바뀌었다"가
    /// 정확히 실제로 바뀐 횟수만큼만 보고된다(트레이 재구성이 누락되거나 헛돌지 않는다).
    #[test]
    fn language_change_is_reported_once_per_actual_change() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(state_at(dir.path()));
        let changes = Arc::new(AtomicUsize::new(0));

        // 같은 언어로 여러 번 저장 → 변경 보고는 0회.
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let state = Arc::clone(&state);
                let changes = Arc::clone(&changes);
                scope.spawn(move || {
                    for _ in 0..25 {
                        if adopt_shared_settings(&state, SharedSettings::default()) {
                            changes.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                });
            }
        });
        assert_eq!(
            changes.load(Ordering::Acquire),
            0,
            "같은 값은 변경이 아니다"
        );

        let next = SharedSettings {
            language: Some("en".to_string()),
            ..Default::default()
        };
        assert!(adopt_shared_settings(&state, next));
        assert_eq!(state.lock_shared().language.as_deref(), Some("en"));
    }

    /// 가드(중복 생성): 여러 창이 **동시에** 부트스트랩돼도 「시작 가이드」는 정확히 한 장만
    /// 만들어진다 — 이긴 호출만 `Some`을 받고 나머지는 전부 `None`이다.
    ///
    /// 이 가드가 없으면 프론트 판정("설정이 비었으면 만든다")과 다를 바 없어진다: 노트 창·
    /// 패널·설정 창이 같은 순간에 "비었다"를 보고 각자 한 장씩 만든다.
    #[test]
    fn guide_note_is_claimed_exactly_once_under_concurrency() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(state_at(dir.path()));
        let root = dir.path().to_path_buf();
        let claimed = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..8 {
                let state = Arc::clone(&state);
                let root = root.clone();
                let claimed = Arc::clone(&claimed);
                scope.spawn(move || {
                    let got =
                        claim_guide_note_in_state(&state, &root, "# 시작 가이드", false).unwrap();
                    if got.is_some() {
                        claimed.fetch_add(1, Ordering::AcqRel);
                    }
                });
            }
        });

        assert_eq!(claimed.load(Ordering::Acquire), 1, "가이드는 한 장뿐이다");
        let ids = state.lock_vault().list_note_ids().unwrap();
        assert_eq!(ids.len(), 1, "vault에도 한 장만 있어야 한다: {ids:?}");
        assert_eq!(
            state.lock_shared().guide_note_id.as_deref(),
            Some(&ids[0][..])
        );
        // 만든 노트는 본문을 담고, 목록 맨 위로 올라가도록 즐겨찾기가 켜져 있다.
        assert_eq!(
            state.lock_vault().read_content(&ids[0]).unwrap(),
            "# 시작 가이드"
        );
        assert!(state.lock_vault().read_meta(&ids[0]).unwrap().favorite);
        // 디스크에도 기록돼 다음 실행이 다시 만들지 않는다.
        assert_eq!(
            settings::load_shared_settings(&root)
                .guide_note_id
                .as_deref(),
            Some(&ids[0][..])
        );
    }

    /// 가드: 사용자가 가이드를 **지워도** 시작 시 다시 만들지 않는다(기록이 남아 있으면
    /// "이미 안내했다"는 뜻이다 — 본문이 "다 읽었으면 지워도 된다"고 말하는데 다음 실행에서
    /// 되살아나면 그 약속이 깨진다). 「다시 보기」(`force`)만 새로 만들고 기록을 갈아 끼운다.
    #[test]
    fn guide_note_respects_deletion_and_force_recreates() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let root = dir.path().to_path_buf();

        let first = claim_guide_note_in_state(&state, &root, "본문", false)
            .unwrap()
            .expect("첫 호출은 선점한다");
        state.lock_vault().delete_note(&first).unwrap();

        assert_eq!(
            claim_guide_note_in_state(&state, &root, "본문", false).unwrap(),
            None,
            "지운 뒤에도 자동 생성은 하지 않는다"
        );

        let second = claim_guide_note_in_state(&state, &root, "새 본문", true)
            .unwrap()
            .expect("force면 새로 만든다");
        assert_ne!(second, first);
        assert_eq!(
            state.lock_shared().guide_note_id.as_deref(),
            Some(&second[..])
        );
        assert_eq!(state.lock_vault().read_content(&second).unwrap(), "새 본문");
    }

    /// 가드: 노트 생성이 실패하면 선점을 되돌린다 — 안 그러면 "만들었다고 기록됐지만 노트는
    /// 없는" 상태로 굳어 가이드가 영영 뜨지 않는다(쓰기 봉인 중 = 그 실패의 실제 경로).
    #[test]
    fn failed_guide_creation_releases_the_claim() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let root = dir.path().to_path_buf();

        let seal = state.seal_note_writes();
        assert!(claim_guide_note_in_state(&state, &root, "본문", false).is_err());
        assert!(
            state.lock_shared().guide_note_id.is_none(),
            "실패한 선점이 남으면 다음 실행도 만들지 않는다"
        );
        assert!(
            settings::load_shared_settings(&root)
                .guide_note_id
                .is_none(),
            "디스크에도 남으면 안 된다"
        );

        drop(seal);
        assert!(claim_guide_note_in_state(&state, &root, "본문", false)
            .unwrap()
            .is_some());
    }

    /// 가드: 프론트가 보낸 설정 저장은 `guide_note_id`를 **바꾸지 못한다**(코어 소유 필드).
    ///
    /// 실제 경로: 가이드가 만들어지기 전에 설정 창이 설정을 읽어 두고, 그 뒤 사용자가 테마를
    /// 바꾸면 옛 스냅샷이 통째로 저장돼 방금 기록된 id를 지운다 → 다음 실행에 가이드가 한 장 더.
    #[test]
    fn front_saves_cannot_clear_guide_note_id() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let root = dir.path().to_path_buf();

        let id = claim_guide_note_in_state(&state, &root, "본문", false)
            .unwrap()
            .unwrap();
        // 프론트가 이 필드를 모르는(또는 옛 스냅샷을 든) 저장을 보낸다.
        commit_shared_settings(
            &state,
            &root,
            SharedSettings {
                theme: "light".to_string(),
                ..SharedSettings::default()
            },
        )
        .unwrap();

        assert_eq!(state.lock_shared().theme, "light", "다른 필드는 저장된다");
        assert_eq!(state.lock_shared().guide_note_id.as_deref(), Some(&id[..]));
        assert_eq!(
            settings::load_shared_settings(&root)
                .guide_note_id
                .as_deref(),
            Some(&id[..])
        );
    }

    /// 가드: 언어 값이 실제로 달라졌을 때만 트레이 재구성 트리거가 켜진다(같으면 무동작).
    #[test]
    fn language_changed_detects_actual_change() {
        assert!(!language_changed(None, None));
        assert!(!language_changed(Some("ko"), Some("ko")));
        assert!(language_changed(None, Some("en")));
        assert!(language_changed(Some("ko"), Some("en")));
        assert!(language_changed(Some("en"), None));
    }

    /// 가드: allowlist 밖 스킴은 브라우저를 띄우기 전에 거부된다(실행 경로 차단).
    #[test]
    fn open_external_url_rejects_unlisted_schemes() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "ms-msdt:/id",
            "example.com",
            "",
        ] {
            assert!(
                open_external_url(url.to_string()).is_err(),
                "허용되면 안 되는 스킴: {url}"
            );
        }
    }

    /// 가드: 탐색 스킴 셋은 통과한다(http·mailto 포함 — 설치용 https 전용 정책과 다르다).
    ///
    /// 실제로 브라우저가 뜨지 않도록 커맨드가 아니라 검증기만 부른다.
    #[test]
    fn validate_external_url_allows_navigation_schemes() {
        for url in [
            "https://example.com",
            "http://192.168.0.1/admin",
            "mailto:a@b.com?subject=hi",
            "HTTPS://Example.com/Path",
        ] {
            assert!(
                validate_external_url(url).is_ok(),
                "막히면 안 되는 URL: {url}"
            );
        }
    }

    /// 가드: 스킴만 있고 대상이 없거나 공백·제어문자가 섞이면 거부된다.
    #[test]
    fn validate_external_url_rejects_malformed() {
        for url in [
            "https://",
            "mailto:",
            "https://exa mple.com",
            "https://example.com/\n",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "통과하면 안 되는 URL: {url}"
            );
        }
    }

    /// 가드: 즐겨찾기 켜기/끄기가 사이드카에 왕복하고, **`updated_at`은 그대로 남는다**.
    ///
    /// 왜 `updated_at`을 못박나: 즐겨찾기는 본문을 바꾸지 않는다 — 여기서 그 필드를 갱신하면
    /// "수정한 적 없는 노트가 방금 수정된 것"이 된다(그 필드의 의미가 이미 오염된 경로가
    /// 정확히 이런 부수 갱신이었다). 창 「항상 위」 override도 함께 살아남아야 한다.
    #[test]
    fn set_favorite_roundtrips_without_touching_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 노트").unwrap();
        let mut meta = vault.read_meta(&id).unwrap();
        meta.updated_at = 1_234_567;
        meta.overrides.pinned = Some(true); // 창 「항상 위」 — 즐겨찾기와 무관하게 보존돼야 한다
        vault.write_meta(&id, &meta).unwrap();

        set_favorite_in_vault(&vault, &id, true).unwrap();
        let after = vault.read_meta(&id).unwrap();
        assert!(after.favorite);
        assert_eq!(after.updated_at, 1_234_567, "즐겨찾기는 수정 시각이 아니다");
        assert_eq!(
            after.overrides.pinned,
            Some(true),
            "창 「항상 위」는 별개다"
        );

        set_favorite_in_vault(&vault, &id, false).unwrap();
        assert!(!vault.read_meta(&id).unwrap().favorite);
    }

    /// 가드: 없는 노트의 즐겨찾기 설정은 조용히 성공하지 않고 오류다(사이드카를 새로 만들어
    /// 유령 노트를 낳지 않는다).
    #[test]
    fn set_favorite_fails_for_unknown_note() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert!(set_favorite_in_vault(&vault, "없는-노트", true).is_err());
    }

    /// 가드: 목록·검색이 함께 쓰는 정렬 메타가 사이드카와 `.md` mtime에서 제대로 모인다.
    #[test]
    fn list_meta_reads_sidecar_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 노트\n본문").unwrap();
        let mut meta = vault.read_meta(&id).unwrap();
        meta.created_at = 1_700_000_000_000;
        meta.hidden = true;
        meta.favorite = true;
        meta.opened_at = Some(1_800_000_000_000);
        vault.write_meta(&id, &meta).unwrap();

        let got = list_meta(&vault, &id);
        assert!(got.hidden && got.favorite);
        assert_eq!(got.created_at, 1_700_000_000_000);
        assert_eq!(got.opened_at, Some(1_800_000_000_000));
        assert_eq!(
            got.content_updated_at,
            vault.content_modified_at(&id).unwrap(),
            "수정 시각은 본문 .md의 mtime이다(사이드카 updated_at이 아니다)"
        );
    }

    /// 가드: 사이드카가 없는 노트도 목록에서 사라지지 않는다 — 전부 기본값으로 읽히고,
    /// 수정 시각은 `created_at`(=0) 폴백이 아니라 실제 mtime이 잡힌다.
    #[test]
    fn list_meta_falls_back_when_sidecar_missing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("본문").unwrap();
        std::fs::remove_file(vault.meta_path(&id)).unwrap();

        let got = list_meta(&vault, &id);
        assert!(!got.hidden && !got.favorite);
        assert_eq!(got.created_at, 0);
        assert_eq!(got.opened_at, None);
        assert!(got.content_updated_at > 0, "본문 mtime은 여전히 읽힌다");
    }

    /// 가드: 본문이 아예 없으면(mtime도 없음) 수정 시각이 `created_at`으로 떨어진다 —
    /// 「수정순」에서 그 노트만 1970년으로 튀지 않게.
    #[test]
    fn list_meta_uses_created_at_when_md_missing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("본문").unwrap();
        let mut meta = vault.read_meta(&id).unwrap();
        meta.created_at = 1_700_000_000_000;
        vault.write_meta(&id, &meta).unwrap();
        std::fs::remove_file(vault.md_path(&id)).unwrap();

        assert_eq!(list_meta(&vault, &id).content_updated_at, 1_700_000_000_000);
    }

    /// 가드: 정렬 모드는 **모양만** 검사한다 — 아직 없는 어휘도 통과하고(모드의 주인은
    /// 프론트다), 빈 값과 64자 초과만 거부한다. 길이는 바이트가 아니라 글자 수다.
    #[test]
    fn panel_sort_gate_checks_shape_only() {
        assert!(is_storable_panel_sort("created-desc"));
        assert!(is_storable_panel_sort("앞으로-생길-모드"));
        assert!(is_storable_panel_sort(&"가".repeat(MAX_PANEL_SORT_CHARS)));

        assert!(!is_storable_panel_sort(""));
        assert!(!is_storable_panel_sort(
            &"a".repeat(MAX_PANEL_SORT_CHARS + 1)
        ));
        assert!(
            is_storable_panel_sort(&"한".repeat(MAX_PANEL_SORT_CHARS)),
            "한글 64자는 192바이트지만 64글자다 — 바이트로 재면 안 된다"
        );
    }

    /// 가드(IPC 계약 §1.1): 목록 항목의 `char_count`는 마크다운 **원문의 글자 수**다 —
    /// 바이트가 아니고, 제목 파생으로 벗겨낸 마커도 포함한다.
    ///
    /// 왜 목록 쪽에도 가드가 필요한가: 검색(`search.rs`)에만 같은 가드가 있으면 목록 쪽 계산이
    /// `content.len()`(바이트)으로 바뀌어도 테스트가 전부 통과하고, 한글 노트에서 「글자수 많은
    /// 순」이 목록과 검색에서 **서로 다른 순서**를 낸다.
    #[test]
    fn summarize_note_counts_chars_not_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 회의\n메모").unwrap();
        let summary = summarize_note(&vault, id.clone());
        assert_eq!(summary.title, "회의");
        // "# 회의\n메모" = 7자(바이트로 재면 15 — 바이트 계산이면 여기서 걸린다).
        assert_eq!(summary.char_count, 7);
        assert_eq!(summary.id, id);
    }

    /// 가드: 본문을 못 읽는 노트도 목록에서 **사라지지 않는다**(빈 본문으로 본다).
    #[test]
    fn summarize_note_survives_missing_body() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("본문").unwrap();
        std::fs::remove_file(vault.md_path(&id)).unwrap();
        let summary = summarize_note(&vault, id);
        assert_eq!(summary.char_count, 0);
        assert_eq!(summary.title, "제목 없음");
    }

    /// 가드(IPC 계약 §1.1): 목록 항목의 `opened_at`은 값이 없을 때 **JSON `null`**로 나간다.
    ///
    /// `skip_serializing_if`가 붙어 필드 자체가 사라지면 프론트는 `undefined`를 받고
    /// 「최근 연 순」이 조용히 추가순으로 퇴화한다 — 양쪽 언어의 테스트가 모두 통과한 채로.
    /// 검색 결과([`SearchHit`])에도 같은 가드가 있다.
    #[test]
    fn note_summary_serializes_opened_at_as_null() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("본문").unwrap();
        let mut meta = vault.read_meta(&id).unwrap();
        meta.opened_at = None;
        vault.write_meta(&id, &meta).unwrap();

        let json = serde_json::to_string(&summarize_note(&vault, id)).unwrap();
        assert!(json.contains("\"opened_at\":null"), "{json}");
        // 나머지 정렬 필드도 계약대로 실려 나가는지 함께 본다(이름이 바뀌면 여기서 걸린다).
        for key in ["favorite", "content_updated_at", "char_count"] {
            assert!(json.contains(&format!("\"{key}\":")), "{key} 누락: {json}");
        }
    }

    /// 가드: 백업 복원은 **커맨드와 같은 관문**을 통과한 값만 영속화한다 — 손으로 고친
    /// 백업의 임의 문자열이 뒷문으로 `config.json`에 들어가면 안 된다.
    #[test]
    fn restored_prefs_are_sanitized() {
        let bad = backup::PortablePrefs {
            launch_at_login: true,
            global_hotkey: "CmdOrCtrl+Shift+N".to_string(),
            startup_no_active_action: "노트-폭발".to_string(),
            panel_sort: String::new(),
        };
        assert_eq!(
            sanitized_startup_no_active_action(&bad),
            settings::STARTUP_NO_ACTIVE_PANEL
        );
        assert_eq!(sanitized_panel_sort(&bad), settings::PANEL_SORT_DEFAULT);

        // 아는 값·모양이 성한 값은 그대로 통과한다.
        let good = backup::PortablePrefs {
            startup_no_active_action: settings::STARTUP_NO_ACTIVE_NEW_NOTE.to_string(),
            panel_sort: "title-asc".to_string(),
            ..bad
        };
        assert_eq!(
            sanitized_startup_no_active_action(&good),
            settings::STARTUP_NO_ACTIVE_NEW_NOTE
        );
        assert_eq!(sanitized_panel_sort(&good), "title-asc");
    }
}
