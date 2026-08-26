//! 플러그인 매니저용 Tauri 커맨드 — 설치 목록·코드 읽기·활성/권한·설치(스테이징)·제거·재조정.
//!
//! 역할: 설정 창의 플러그인 매니저가 호출하는 IPC 경계. 앱데이터/vault 경로를 구해 순수
//! 로직([`crate::plugins`]·[`crate::plugin_install`]·[`crate::plugin_sync`])에 위임하는
//! 얇은 래퍼다.
//! 왜: 스캔/병합/검증/설치는 모듈에서 tempfile로 테스트하고, 여기서는 경로 해석 + 오류
//! 문자열 변환만 둔다(테스트하기 어려운 Tauri 의존을 최소화).
//!
//! ## 「디스크에 닿는 커맨드는 `#[tauri::command(async)]`」 (이슈 #22)
//!
//! 이 파일의 커맨드는 **설정 창에서 뭘 하나 바꿀 때마다 한꺼번에** 불린다: 저장 → `notes-reload`
//! → 중앙 호스트 재빌드가 `list_installed_plugins`·`read_plugin_code`(플러그인 수만큼)·
//! `list_builtin_states`·`list_builtin_settings`를 줄줄이 부르고, 그 끝의 `EV_HOST_UPDATED`가
//! **열린 모든 노트 창을 리로드**시켜 각 창이 다시 자기 몫의 커맨드를 부른다. 이것들이 전부
//! 동기 커맨드였을 때는 그 전부가 메인 스레드 한 줄에 늘어서, 노트가 몇 개만 열려 있어도
//! 설정 토글 한 번에 앱이 "응답 없음"이 됐다(베타 테스터 보고의 후반부).
//!
//! 그래서 디스크에 닿는 커맨드는 전부 `(async)`이고, 경로만 조립하는 [`get_plugins_dir`]만
//! 동기로 남는다. 병행 실행이 되면서 생긴 `plugins-state.json`의 lost-update 위험은
//! [`crate::plugins::with_state_lock`]이 막는다(같은 문제를 먼저 겪은
//! [`crate::plugin_storage`]의 `STORAGE_LOCK`과 같은 처방).
//!
//! `(async)`만으로는 절반이다 — `commands.rs` 머리말이 설명하듯 그 본문은 여전히 코어 수만큼
//! 고정된 async 워커 풀(IPC 응답 전달과 공유)에서 돈다. 위에서 말한 팬아웃 넷
//! (`list_installed_plugins`·`read_plugin_code`·`list_builtin_states`·`list_builtin_settings`)과
//! 같은 이유로 자주 불리는 `list_rejected_plugins`·`read_plugin_readme`·`list_missing_plugins`도
//! [`tauri::async_runtime::spawn_blocking`]으로 전용 blocking 풀에 옮겼다(`commands.rs`의
//! `blocking` 헬퍼와 같은 관용구 — 이 파일은 그 헬퍼 대신 원조인
//! [`fetch_plugin_for_install`]과 같은 인라인 `spawn_blocking` 호출을 그대로 따른다).
//! 이 파일의 읽기 함수(`load_state`·`scan_installed`·`read_plugin_code`·`load_vault_list`)는
//! 전부 잠금을 잡지 않는 순수 IO라(각 모듈 문서 참고) `with_state_lock`·`VAULT_LIST_LOCK`과
//! 얽힐 잠금 순서 문제가 없다.

use crate::plugin_i18n;
use crate::plugin_install::{self, InstallPreview, DEFAULT_LIMITS};
use crate::plugin_storage::{self, StorageMap};
use crate::plugin_sync::{self, VaultPluginEntry};
use crate::plugins::{self, InstalledPlugin};
use crate::state::AppState;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// 현재 실행 중인 OS 식별자 — 매니페스트 `platforms` 판정에 쓴다.
///
/// [`crate::commands::get_platform`]이 프론트로 내보내는 것과 **같은 값**(`std::env::consts::OS`)
/// 이어야 한다: 언어팩 수집 게이트([`crate::plugin_i18n`])가 프론트 `isSupportedOnPlatform`과
/// 같은 답을 내려면 두 판정의 OS 입력이 같아야 하기 때문이다.
const CURRENT_OS: &str = std::env::consts::OS;

/// 앱데이터 디렉터리를 구한다(없으면 오류 문자열).
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// vault 루트 경로를 구한다(로컬 설정 — 잠금 실패는 오류 문자열).
fn vault_root(state: &tauri::State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(state.lock_config().vault_path.clone())
}

/// 설치된 플러그인 루트 디렉터리(`<app_data>/plugins`)의 절대경로를 돌려준다.
///
/// 역할: 설정 창이 설치 플러그인 README의 **로컬 이미지**를 `convertFileSrc`로 asset URL로
/// 만들 때 기준 경로로 쓴다(`<plugins>/<id>/<상대경로>`). 외부 URL은 렌더하지 않는다(로컬만).
#[tauri::command]
pub fn get_plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app_data_dir(&app)?;
    Ok(plugins::plugins_dir(&app_data)
        .to_string_lossy()
        .into_owned())
}

/// 네이티브 폴더 선택 창을 띄우고 고른 폴더의 절대경로를 돌려준다(취소하면 None).
///
/// 역할: 설정 창 "폴더에서 설치"가 경로를 손으로 입력하는 대신 OS 파일 선택기로 폴더를 고르게
/// 한다 — 고른 경로는 그대로 `local` 설치 스펙의 위치가 된다(검증은 이후 스테이징이 한다).
/// 왜 `(async)`: `blocking_pick_folder`는 다이얼로그를 **메인 스레드**에 띄우고 그 결과를 기다리며
/// **호출 스레드를 블록**한다. Tauri는 동기 커맨드를 메인 스레드에서 실행하므로, 그대로 두면
/// "메인 스레드가 자기가 띄울 다이얼로그를 기다리는" 교착이 되어 앱이 멈춘다. `(async)`로 커맨드를
/// 메인 밖(async 런타임)에서 돌려야 메인 스레드가 다이얼로그를 처리할 수 있다.
#[tauri::command(async)]
pub fn pick_plugin_dir(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("플러그인 폴더 선택")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// 설치된 플러그인 목록을 돌려준다(매니페스트 + 로컬 활성/부여 병합).
///
/// `async` + [`tauri::async_runtime::spawn_blocking`]인 이유: 이 파일 머리말의 「디스크에
/// 닿는 커맨드는 `#[tauri::command(async)]`」 절이 설명하듯 `(async)`만으로는 절반이다 — 그
/// 본문은 여전히 코어 수만큼 고정된 async 워커 풀(IPC 응답 전달과 공유)에서 돈다. 이 커맨드는
/// 설정 저장 한 번마다(재빌드 체인에서) 플러그인 수와 무관하게 디렉터리 전체를 스캔하는,
/// 이 파일에서 가장 잦은 팬아웃 지점이라 전용 blocking 풀로 옮긴다(`commands.rs`의
/// `blocking` 헬퍼·`fetch_plugin_for_install`과 같은 관용구). 잠금은 쥐지 않는다 —
/// `load_state`·`scan_installed`는 읽기 전용 경로라 `plugins::STATE_LOCK`을 잡지 않는다
/// (모듈 문서 참고) — 교착 위험이 없다.
#[tauri::command]
pub async fn list_installed_plugins(app: tauri::AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = plugins::load_state(&app_data);
        Ok(plugins::scan_installed(&app_data, &state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 스캔에서 탈락한 플러그인 폴더를 사유와 함께 돌려준다.
///
/// 역할: `plugins/` 아래 있지만 매니페스트가 깨졌거나·id가 폴더명과 다르거나·entry 파일이
/// 없어 [`list_installed_plugins`]에서 조용히 사라지는 폴더를, 설정 창이 "불러오지 못한
/// 폴더" 안내로 보여줄 수 있게 사유와 함께 노출한다.
/// 왜 별도 커맨드인가(덜 침습적인 선택): `list_installed_plugins`는 이미 `InstalledPlugin[]`
/// (평평한 배열)을 기대하는 호출부가 있다 — 그 응답을 `{ plugins, rejected }` 같은 객체로
/// 바꾸면 기존 호출부를 전부 함께 고쳐야 한다. 별도 커맨드는 기존 계약을 전혀 건드리지
/// 않는다. 스캔(디렉터리 읽기 + 매니페스트 파싱)을 두 번 하게 되지만, 플러그인 개수 규모
/// (수십 개)에서는 비용이 무시할 수준이라 침습성보다 싸다.
#[tauri::command]
pub async fn list_rejected_plugins(
    app: tauri::AppHandle,
) -> Result<Vec<plugins::RejectedPlugin>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = plugins::load_state(&app_data);
        Ok(plugins::scan_installed_report(&app_data, &state).rejected)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 플러그인의 entry 코드(보통 `main.js`)를 읽어 돌려준다(샌드박스 실행용).
///
/// blocking 풀에서 도는 이유는 [`list_installed_plugins`]와 같다 — 재빌드 체인이 설치된
/// 플러그인 수만큼 이 커맨드를 줄줄이 부른다(모듈 머리말 참고).
#[tauri::command]
pub async fn read_plugin_code(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || plugins::read_plugin_code(&app_data, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// 플러그인의 README(사용법 마크다운)를 읽어 돌려준다(설정창 상세 뷰용).
/// `locale`(선택, 축 2)이 있고 형식이 유효하면 `README.<locale>.md`를 먼저 찾고, 없으면
/// `README.md`로 폴백한다. 부재·64KB 초과·비UTF-8·심링크·형식 위반 id는 None — 프론트는
/// "설명 없음"으로 표시한다.
#[tauri::command]
pub async fn read_plugin_readme(
    app: tauri::AppHandle,
    id: String,
    locale: Option<String>,
) -> Result<Option<String>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(plugins::read_plugin_readme(
            &app_data,
            &id,
            locale.as_deref(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 플러그인 활성 여부를 설정한다(로컬 상태 영속화).
#[tauri::command(async)]
pub fn set_plugin_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_enabled(&app_data, &id, enabled)
}

/// 플러그인의 로컬 권한 부여 집합을 설정한다(선언 ∩ 요청으로 좁혀 영속화).
#[tauri::command(async)]
pub fn set_plugin_granted(
    app: tauri::AppHandle,
    id: String,
    granted: Vec<String>,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_granted(&app_data, &id, &granted)
}

/// "선언은 했지만 예약(미구현)이라 아직 부여하지 못한" 민감 권한 집합을 저장한다.
///
/// 역할: 설치/업데이트 승인 직후 프론트(`install-flow.ts`의 `pendingReservedForApproval`)가
/// 계산한 예약-보류 권한을 로컬 상태에 기억시킨다 — 이 커맨드가 없으면 예약이 나중에
/// 풀려도(`PERMISSION_RESERVED`에서 빠짐) 아무도 그 사실을 기억하지 못해 재승인 배너가
/// 뜰 수 없다(기존 설치가 새 권한을 영영 못 씀). 조회는 별도 커맨드가 필요 없다 —
/// [`list_installed_plugins`]가 각 항목의 `pendingReserved` 필드로 이미 함께 돌려준다.
#[tauri::command(async)]
pub fn set_plugin_pending_reserved(
    app: tauri::AppHandle,
    id: String,
    pending: Vec<String>,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_pending_reserved(&app_data, &id, &pending)
}

/// 설치(서드파티) 언어팩 카탈로그를 돌려준다 — 설정 창 언어 드롭다운의 후보.
///
/// 역할: 설치 플러그인의 `contributes.translations`를 **코어가 직접 읽어**(중앙 호스트
/// 샌드박스 왕복 없이) `{code,label,pluginId}` 목록으로 준다. 수집 자격과 항목 검증은
/// [`crate::plugin_i18n`]이 소유한다(브리지 게이트와 동형 — 그 모듈 문서 참고).
///
/// blocking 풀에서 도는 이유는 [`list_installed_plugins`]와 같고 더 강하다: 이 커맨드는
/// **부트스트랩 핫패스**(창이 첫 페인트 전에 기다리는 지점)에서 불린다 — 같은 스캔을 하므로
/// 같은 풀·같은 잠금 설계를 그대로 따른다(이슈 #22 회귀 방지). `load_state`·`scan_installed`는
/// 잠금을 잡지 않는 읽기 전용 경로다.
#[tauri::command]
pub async fn list_language_packs(
    app: tauri::AppHandle,
) -> Result<Vec<plugin_i18n::LanguagePackEntry>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = plugins::load_state(&app_data);
        let scanned = plugins::scan_installed(&app_data, &state);
        Ok(plugin_i18n::list_language_packs(&scanned, CURRENT_OS))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 로케일 하나의 사전을 돌려준다(설치 언어팩들의 병합 결과 — 없으면 빈 맵).
///
/// 역할: 각 창 부트스트랩이 **자기가 그릴 언어 하나**를 첫 페인트 전에 IPC 한 번으로 받는
/// 지점이다. 여러 팩이 같은 코드를 공급하면 뒤가 앞을 덮는다(LastWins —
/// [`crate::plugin_i18n::read_locale_entries`]).
///
/// `locale`은 신뢰하지 않는다 — 경로 조립에 쓰이지 않고(매니페스트 안의 값과 **비교만**
/// 한다) 형식 검증도 그쪽 순수 로직이 각 항목에 대해 수행한다.
///
/// blocking 풀에서 도는 이유는 [`list_language_packs`]와 같다(같은 핫패스·같은 스캔).
#[tauri::command]
pub async fn read_locale_entries(
    app: tauri::AppHandle,
    locale: String,
) -> Result<BTreeMap<String, String>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = plugins::load_state(&app_data);
        let scanned = plugins::scan_installed(&app_data, &state);
        Ok(plugin_i18n::read_locale_entries(
            &scanned, &locale, CURRENT_OS,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 빌트인(번들) 플러그인 활성 상태 맵을 돌려준다(id→enabled; 기록 없으면 프론트가 켜짐으로 해석).
///
/// blocking 풀에서 도는 이유는 [`list_installed_plugins`]와 같다 — 재빌드 체인이 매번 부른다.
#[tauri::command]
pub async fn list_builtin_states(app: tauri::AppHandle) -> Result<BTreeMap<String, bool>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(plugins::load_state(&app_data).builtins))
        .await
        .map_err(|e| e.to_string())?
}

/// 빌트인(번들) 플러그인 활성 여부를 설정한다(로컬 상태 영속화).
#[tauri::command(async)]
pub fn set_builtin_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_builtin_enabled(&app_data, &id, enabled)
}

/// 빌트인(번들) 플러그인 설정 값 맵을 돌려준다(id → key → value). 프론트가 스키마 기본값과
/// 합쳐 폼·런타임에 쓴다.
#[tauri::command]
pub async fn list_builtin_settings(
    app: tauri::AppHandle,
) -> Result<BTreeMap<String, BTreeMap<String, serde_json::Value>>, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(
        move || Ok(plugins::load_state(&app_data).builtin_settings),
    )
    .await
    .map_err(|e| e.to_string())?
}

/// 빌트인(번들) 플러그인 설정 값 하나를 저장한다(키 형식 검증 후 영속화).
#[tauri::command(async)]
pub fn set_builtin_setting(
    app: tauri::AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_builtin_setting(&app_data, &id, &key, value)
}

/// 플러그인 설정 값 하나를 저장한다(선언된 스키마 키만 허용 후 영속화).
#[tauri::command(async)]
pub fn set_plugin_setting(
    app: tauri::AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::set_setting(&app_data, &id, &key, value)
}

/// 플러그인을 제거한다(디렉터리 + 로컬 상태 레코드 + 저장소 파일 + vault 참조 목록 항목).
///
/// 역할: 로컬 설치와 동기화 목록을 함께 정리한다. 로컬에 코드가 없는(재조정 안내의)
/// 항목에도 그대로 쓰인다 — 그 경우 vault 목록에서만 지워진다.
/// `plugin_storage::remove_all`도 함께 호출해 `memo.storage.local.*` 파일이
/// 제거 후에도 고아로 남지 않게 한다(권한·설정과 같은 생애주기 — 저장소만 빠지면 재설치
/// 시 이전 플러그인의 내부 상태가 새 설치에 그대로 이어지는 것이 오히려 더 이상하다).
#[tauri::command(async)]
pub fn remove_plugin(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::remove(&app_data, &id)?;
    plugin_storage::remove_all(&app_data, &id)?;
    plugin_sync::remove_entry(&vault_root(&state)?, &id)
        .map_err(|e| format!("vault 목록 갱신 실패: {e}"))
}

/// 설치 요청(프론트 → fetch 커맨드): 출처 종류(url/git/local) + 위치(+ git ref).
#[derive(Debug, Deserialize)]
pub struct InstallSpec {
    /// "url"(https zip) | "git"(https 저장소) | "local"(폴더 경로).
    pub kind: String,
    /// URL 또는 로컬 폴더 경로.
    pub location: String,
    /// git 전용 — 브랜치/태그/커밋(버전 핀). 없으면 HEAD.
    #[serde(default)]
    pub git_ref: Option<String>,
}

/// 설치 후보를 가져와 스테이징하고 미리보기(매니페스트·권한·기존 설치 상태)를 돌려준다.
///
/// 역할: 승인 프롬프트 앞 단계 — 다운로드/클론/복사와 검증만 하고 **설치하지 않는다**.
/// 네트워크·git이 느릴 수 있어 blocking 풀에서 돌린다(UI 스레드/런타임 비차단).
#[tauri::command]
pub async fn fetch_plugin_for_install(
    app: tauri::AppHandle,
    spec: InstallSpec,
) -> Result<InstallPreview, String> {
    let app_data = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || match spec.kind.as_str() {
        "url" => plugin_install::stage_from_url(&app_data, &spec.location, &DEFAULT_LIMITS),
        "git" => plugin_install::stage_from_git(
            &app_data,
            &spec.location,
            spec.git_ref.as_deref(),
            &DEFAULT_LIMITS,
        ),
        "local" => {
            plugin_install::stage_from_local_dir(&app_data, std::path::Path::new(&spec.location))
        }
        other => Err(format!("알 수 없는 설치 출처 종류: {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 승인된 스테이징을 확정 설치한다(granted는 선언∩요청으로 클램프). 설치된 id 반환.
#[tauri::command(async)]
pub fn confirm_plugin_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    staging: String,
    granted: Vec<String>,
) -> Result<String, String> {
    let app_data = app_data_dir(&app)?;
    plugin_install::confirm_install(&app_data, &vault_root(&state)?, &staging, &granted)
}

/// 스테이징을 폐기한다(승인 프롬프트에서 취소/거부 — 잔여물 제거).
#[tauri::command(async)]
pub fn cancel_plugin_install(app: tauri::AppHandle, staging: String) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugin_install::cancel_install(&app_data, &staging)
}

/// 재조정 — vault 목록에는 있는데 이 기기에 없는(무시하지 않은) 플러그인 항목을 돌려준다.
///
/// 역할: 설정 창이 열릴 때 비차단 안내([설치]/[제거]/[무시])의 데이터 소스.
///
/// blocking 풀에서 도는 이유는 [`list_installed_plugins`]와 같다(설치 스캔 + vault 목록
/// 읽기를 겸한다). `state`(`tauri::State`)는 커맨드 호출 동안만 유효한 빌림이라 `'static`
/// 클로저로 넘길 수 없으므로, 잠금을 짧게 잡아 vault 경로만 복제해 꺼낸 뒤 놓는다
/// (`commands.rs`의 「clone what you need under lock」 관용구). `load_vault_list`는 읽기
/// 전용이라 `plugin_sync::VAULT_LIST_LOCK`을 잡지 않고, `load_state`·`scan_installed`도
/// `plugins::STATE_LOCK`을 잡지 않으므로(둘 다 모듈 문서 참고) 잠금 순서 문제가 없다.
#[tauri::command]
pub async fn list_missing_plugins(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VaultPluginEntry>, String> {
    let app_data = app_data_dir(&app)?;
    let vault_root = vault_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let local_state = plugins::load_state(&app_data);
        let installed_ids: Vec<String> = plugins::scan_installed(&app_data, &local_state)
            .into_iter()
            .map(|p| p.id)
            .collect();
        let list = plugin_sync::load_vault_list(&vault_root);
        Ok(plugin_sync::missing_entries(
            &list,
            &installed_ids,
            &local_state.dismissed_missing,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 재조정 안내 항목을 "무시"로 기록한다(이 기기에서 다시 보이지 않음 — 로컬 영속).
#[tauri::command(async)]
pub fn dismiss_missing_plugin(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugins::dismiss_missing(&app_data, &id)
}

// ── 개발 모드 — 단일 플러그인 핫리로드 ──────────────────────────────────────
//
// 저작자가 개발 중인 플러그인 폴더 하나를 감시해, 소스가 바뀌면 그 플러그인 **하나만** 다시
// 실행하도록 중앙 호스트에 신호를 보낸다(central-host.ts의 rebuildPlugin). 전체 재빌드/전체
// 노트 창 리로드를 피해 "고치고 → 확인" 루프를 빠르게 만든다.

/// 방송 이벤트 이름 — 프론트의 `EV_PLUGIN_DEV_RELOAD`(host-protocol.ts)와 **같은 문자열**.
const DEV_RELOAD_EVENT: &str = "plugin-host:dev-reload";

/// 개발 모드 파일 감시자 핸들 — **세션 한정**(프로세스 메모리, 어디에도 영속하지 않음).
///
/// 왜 static인가: notify 감시자는 살아 있는 동안만 감시하므로 커맨드가 반환해도 어딘가
/// 붙들려 있어야 한다. `AppState`가 아니라 이 모듈에 가둔 이유는 (1) 개발 모드가 세션 한정이라
/// 앱을 재시작하면 자동으로 꺼져 **프로덕션 실행에 절대 남지 않고**, (2) 다른 앱 상태와
/// 생애주기가 완전히 다르며(사용자 데이터가 아니다), (3) 소유 경계를 이 커맨드 파일 안으로
/// 좁히기 위함이다. 새 감시를 시작하면 이전 감시자를 drop해(교체) 하나만 산다.
fn dev_watcher() -> &'static Mutex<Option<RecommendedWatcher>> {
    static W: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

/// 변경 경로가 플러그인 소스(.js/.json/.css)인가 — 무관한 변경(.DS_Store·에디터 스왑 파일
/// 등)에 헛되이 리로드하지 않게 거른다(watcher.rs의 `is_relevant`와 같은 관례).
fn is_plugin_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js") | Some("json") | Some("css")
    )
}

/// 개발 모드 — 플러그인 하나의 폴더를 감시해 변경 시 단일 핫리로드를 방송한다.
///
/// 역할: `id`가 `Some`이면 `<plugins>/<id>` 폴더를 재귀 감시하고, 소스 파일이 바뀔 때마다
/// [`DEV_RELOAD_EVENT`]를 `{ pluginId }`와 함께 방송한다 — 중앙 호스트가 그 플러그인 하나만
/// 다시 실행한다. `id`가 `None`이면 감시를 해제한다(개발 모드 종료).
///
/// **세션 한정 / 프로덕션 안전**: 감시자는 프로세스 메모리([`dev_watcher`])에만 있고 어디에도
/// 영속되지 않는다 — 앱을 재시작하면 감시가 자동으로 꺼진다. 리로드는 설치 플러그인 읽기
/// 경로를 그대로 타므로(프론트 `devSource`) 게이트키퍼·권한이 정식 로드와 똑같이 적용된다
/// (개발 모드는 편의지 보안 우회가 아니다).
///
/// 왜 `(async)`: 감시자 생성이 파일시스템에 닿는다 — 동기 커맨드에 두면 메인 스레드를 잡을 수
/// 있다(이 리포의 다이얼로그 교착 교훈 — `pick_plugin_dir` 문서 참고).
#[tauri::command(async)]
pub fn set_dev_plugin(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    // 기존 감시 중단(drop) — 대상 변경(id=Some 재호출)·종료(id=None) 양쪽에서 먼저 끈다.
    let mut guard = dev_watcher()
        .lock()
        .map_err(|_| "내부 상태 잠금 오류".to_string())?;
    *guard = None;
    let Some(id) = id else {
        return Ok(());
    };

    // 경로 인젝션 차단(심층 방어) — id는 곧 폴더 경로에 조립된다. 진짜 게이트는 프론트
    // `devSource`가 설치 목록의 id와만 매칭하는 것이지만(모르는 id면 전체 재빌드 폴백),
    // 임의 폴더를 감시하지 않도록 여기서 먼저 거른다.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("개발 모드: 잘못된 플러그인 id: {id}"));
    }
    let app_data = app_data_dir(&app)?;
    let dir = plugins::plugins_dir(&app_data).join(&id);
    if !dir.is_dir() {
        return Err(format!("개발 모드: 플러그인 폴더가 없습니다: {id}"));
    }

    let handle = app.clone();
    let plugin_id = id.clone();
    // 디바운스 — notify는 저장 한 번에 여러 이벤트를 낸다(rename+write 등). 마지막 방송 후
    // 짧은 간격 안의 연속 변경은 한 번으로 접는다. 중앙 호스트가 rebuildChain으로 한 번 더
    // 직렬화하지만, 방송 자체를 줄여야 재실행이 폭주하지 않는다.
    let last = Mutex::new(Instant::now() - Duration::from_millis(500));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        if !event.paths.iter().any(|p| is_plugin_source(p)) {
            return;
        }
        if let Ok(mut last) = last.lock() {
            if last.elapsed() < Duration::from_millis(150) {
                return;
            }
            *last = Instant::now();
        }
        let _ = handle.emit(
            DEV_RELOAD_EVENT,
            serde_json::json!({ "pluginId": plugin_id }),
        );
    })
    .map_err(|e| format!("개발 모드 감시자 생성 실패: {e}"))?;
    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| format!("개발 모드 감시 시작 실패: {e}"))?;
    *guard = Some(watcher);
    Ok(())
}

// ── `memo.storage.*` — 영속(local) 스코프 백엔드 ───────────────────────────
//
// 역할: `memo.storage.local.*`의 디스크 IO 경계. `session`(프로세스 메모리)·`window`
// (창 컨텍스트 토큰 스코프)는 파일시스템에 닿지 않으므로 Tauri 커맨드가 필요 없다 — 그
// 두 스코프는 중앙 호스트(`central-host.ts`, 다음 단계)가 메모리에서 직접 관리한다.
// 왜 전부 `(async)`인가: 디스크 IO를 동기 커맨드에 두면 메인 스레드가 블록된다(이 리포에
// 다이얼로그로 앱이 얼었던 전례가 있다 — `pick_plugin_dir` 문서 참고). 저장소 파일은
// 작지만 원칙을 일관되게 지킨다.

/// 설치(사이드로드) 플러그인 저장소 값 하나를 읽는다(없으면 `null`).
#[tauri::command(async)]
pub fn get_plugin_storage(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::get(&app_data, &id, &key)
}

/// 설치(사이드로드) 플러그인 저장소 값 하나를 저장한다(용량 상한 초과 시 거부).
#[tauri::command(async)]
pub fn set_plugin_storage(
    app: tauri::AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::set(&app_data, &id, &key, value)
}

/// 설치(사이드로드) 플러그인 저장소 값 하나를 지운다(없어도 오류 아님).
#[tauri::command(async)]
pub fn remove_plugin_storage(app: tauri::AppHandle, id: String, key: String) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::remove(&app_data, &id, &key)
}

/// 설치(사이드로드) 플러그인 저장소 전체 스냅샷을 읽는다.
#[tauri::command(async)]
pub fn get_all_plugin_storage(app: tauri::AppHandle, id: String) -> Result<StorageMap, String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::get_all(&app_data, &id)
}

/// 빌트인(번들) 플러그인 저장소 값 하나를 읽는다(없으면 `null`).
#[tauri::command(async)]
pub fn get_builtin_storage(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::get_builtin(&app_data, &id, &key)
}

/// 빌트인(번들) 플러그인 저장소 값 하나를 저장한다(용량 상한 초과 시 거부).
#[tauri::command(async)]
pub fn set_builtin_storage(
    app: tauri::AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::set_builtin(&app_data, &id, &key, value)
}

/// 빌트인(번들) 플러그인 저장소 값 하나를 지운다(없어도 오류 아님).
#[tauri::command(async)]
pub fn remove_builtin_storage(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<(), String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::remove_builtin(&app_data, &id, &key)
}

/// 빌트인(번들) 플러그인 저장소 전체 스냅샷을 읽는다.
#[tauri::command(async)]
pub fn get_all_builtin_storage(app: tauri::AppHandle, id: String) -> Result<StorageMap, String> {
    let app_data = app_data_dir(&app)?;
    plugin_storage::get_all_builtin(&app_data, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: .js/.json/.css만 플러그인 소스로 보고 그 외(.DS_Store·스왑 파일)는 무시한다.
    /// (실제 감시 이벤트 전달은 타이밍 의존이라 수동/통합으로 검증 — watcher.rs와 같은 관례.)
    #[test]
    fn plugin_source_by_extension() {
        assert!(is_plugin_source(Path::new("main.js")));
        assert!(is_plugin_source(Path::new("manifest.json")));
        assert!(is_plugin_source(Path::new("styles.css")));
        assert!(!is_plugin_source(Path::new(".DS_Store")));
        assert!(!is_plugin_source(Path::new("main.js.swp")));
        assert!(!is_plugin_source(Path::new("README.md")));
    }
}
