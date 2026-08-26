//! 설정·플러그인 백업 내보내기/가져오기(이슈 #28 1단계).
//!
//! 역할: "이 기기를 이 앱답게 만드는 것"(공유 설정 + 이식 가능한 로컬 환경설정 + 설치한
//! 플러그인의 코드·상태·저장소)을 **파일 하나**에 담고 다시 되돌린다. 클라우드 연동은 없다 —
//! 사용자가 그 파일을 깃/드라이브/NAS 어디에 두든 자유다.
//!
//! 왜 이 경계인가: 메모 본문 자체는 이미 vault 폴더를 동기화 폴더로 지정하면 따라 움직인다
//! (이슈 #21의 저장 폴더 변경). 그럼에도 새 기기에서 앱이 낯선 이유는 메모가 아니라 **설정과
//! 플러그인**이 앱데이터(비동기화 영역)에 남아 있기 때문이다. 그래서 1단계는 그 비동기화
//! 절반만 옮긴다 — 메모 저장/복원은 2단계의 몫이다.
//!
//! ## 포맷: zip 한 덩이
//!
//! 새 크레이트를 들이지 않는다 — `zip`은 플러그인 zip 설치(`plugin_install.rs`)와 업데이터가
//! 이미 쓰는 의존성이라 빌드 크기가 늘지 않는다. 폴더 백업 대신 단일 파일을 고른 이유는
//! 사용자가 이 산출물로 하려는 일(드라이브에 올리기·메신저로 보내기·USB에 담기)이 전부
//! "파일 하나"를 전제하기 때문이고, 압축을 풀면 그냥 JSON과 플러그인 소스라 **손으로도 읽고
//! 고칠 수 있다**(불투명한 바이너리 포맷을 만들지 않는다).
//!
//! ```text
//! note-rang-backup-2026-08-15.zip
//! ├─ backup.json                    앱 버전·생성 시각·스키마 버전·플러그인 목록(표시용 메타)
//! ├─ settings/shared-settings.json  vault 공유 설정 전체(테마·색·키맵·툴바 배치·언어·노트 기본값)
//! ├─ settings/local-prefs.json      로컬 설정 중 **이식 가능한 것만**(자동 실행·전역 단축키·
//! │                                 활성 노트 없을 때의 시작 동작·패널 정렬 모드)
//! └─ plugins/
//!    ├─ plugins-state.json          활성 여부·설정 값·빌트인 토글(부여 권한은 제거됨 — 아래)
//!    ├─ code/<id>/…                 설치된 커뮤니티 플러그인 코드 전체
//!    └─ storage/…                   플러그인별 저장소(`memo.storage.local.*`)
//! ```
//!
//! ## 무엇이 빠지는가(그리고 왜)
//!
//! - **`vault_path`**: 기기 종속이다. 다른 기기(다른 OS·다른 드라이브 문자)에서 그 경로는
//!   존재하지 않거나 남의 폴더다. 저장 폴더는 설정 창의 「저장 폴더」 페이지에서 고르는 것이지
//!   백업이 결정할 것이 아니다.
//! - **`welcomed`·`vault_prompted`**: "이미 안내했다"는 1회성 흔적이지 사용자가 고른 설정이
//!   아니다. 이것까지 옮기면 새 기기가 첫 실행 안내를 건너뛴다.
//! - **부여된 민감 권한(`granted`)·`pendingReserved`**: 보안 정책 — 아래 절 참고.
//! - **메모·첨부·복구 저장본**: 2단계의 범위다. vault를 동기화 폴더에 두면 이미 따라 움직인다.
//!
//! ## 권한은 복원하지 않는다
//!
//! `plugin_sync.rs`가 vault 동기화 목록에 대해 세운 신뢰 모델을 그대로 따른다: *"목록은
//! 동기화되지만 enable·권한 부여(granted)는 절대 싣지 않는다 — 새 기기에서는 재설치 +
//! 재승인이 필요하다."* 백업 파일도 **기기 밖을 도는 데이터**라는 점에서 동기화 파일과 성질이
//! 같다(메신저로 받은 백업, 깃에서 클론한 백업, 남이 만든 백업). 그래서 부여는
//! **내보낼 때 이미 비우고, 가져올 때 또 한 번 비운다** — 파일을 손으로 고쳐 `granted`를
//! 채워 넣어도 특권은 새지 않는다.
//!
//! 반면 `enabled`(활성 여부)는 복원한다. 이 앱에서 특권의 경계는 "선언 + 로컬 부여"이지
//! 활성 여부가 아니다 — 부여가 빈 플러그인은 켜져 있어도 민감하지 않은 호출만 할 수 있고,
//! 이는 사용자가 승인 화면에서 권한을 전부 거절한 채 설치한 플러그인과 정확히 같은 상태다
//! (`plugin_install::confirm_install`이 신규 설치를 `enabled = true`로 두는 것과 같은 결).
//! 활성까지 끄면 "복원했는데 아무것도 안 켜져 있다"가 되어 기능의 존재 이유가 사라지는 반면,
//! 얻는 안전은 (부여가 이미 비었으므로) 크지 않다.
//!
//! ## 복원은 더하기만 한다
//!
//! 백업에 없는 로컬 플러그인을 지우지 않는다. "복원"이라는 말이 사용자에게 약속하는 것은
//! "그때의 것을 되돌려 준다"이지 "지금 것을 지운다"가 아니다 — 지우기를 원하면 매니저에서
//! 개별 제거하거나 「초기화」 페이지가 있다. 대신 되돌릴 수 있게, 가져오기는 **현재 상태를
//! 같은 포맷으로 vault의 `.memo/backups/`에 자동 스냅샷한 뒤**에만 시작한다.

use crate::io::write_atomic_bytes;
use crate::model::SharedSettings;
use crate::plugin_install::{self, InstallLimits};
use crate::plugin_storage;
use crate::plugin_sync::{self, VaultPluginEntry};
use crate::plugins::{self, PluginRecord, PluginSource, PluginsState};
use crate::settings;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 백업 포맷 스키마 버전. 구조가 바뀌면 올린다 — 가져오기는 **이 값보다 큰** 백업을 거부한다
/// (미래 버전이 담았을지 모르는 항목을 조용히 버리느니 "더 새 버전에서 만든 백업"이라고 말한다).
pub const SCHEMA_VERSION: u32 = 1;

// 오류는 `"<코드> <설명>"` 문자열이다(`vault_move`의 `VAULT_*`·`net.rs`의 `NET_*`와 같은 관례) —
// 프론트는 첫 토큰으로 분류해 번역된 안내를 고르므로 백엔드 문구를 다듬어도 UI가 깨지지 않는다.

/// 백업 파일을 쓰지 못했다(권한·디스크 공간).
pub const ERR_WRITE_FAILED: &str = "BACKUP_WRITE_FAILED";
/// 백업 파일을 읽지 못했다(없음·권한).
pub const ERR_READ_FAILED: &str = "BACKUP_READ_FAILED";
/// 파일이 상한보다 크다(백업으로 보기 어려움 — 압축 폭탄 방어의 첫 관문).
pub const ERR_TOO_LARGE: &str = "BACKUP_TOO_LARGE";
/// zip이 아니거나 `backup.json`이 없다 — note-rang 백업이 아니다.
pub const ERR_NOT_A_BACKUP: &str = "BACKUP_NOT_A_BACKUP";
/// 이 앱이 모르는 더 새로운 스키마 버전이다.
pub const ERR_UNSUPPORTED: &str = "BACKUP_UNSUPPORTED_VERSION";
/// 내용이 손상됐다(엔트리 해제 실패·경로 탈출·필수 파일 파싱 실패).
pub const ERR_CORRUPT: &str = "BACKUP_CORRUPT";
/// 복원 대상이 하나도 선택되지 않았다.
pub const ERR_NOTHING_SELECTED: &str = "BACKUP_NOTHING_SELECTED";
/// 복원 직전 안전 스냅샷을 만들지 못했다 — 되돌릴 수 없는 복원은 시작하지 않는다.
pub const ERR_SNAPSHOT_FAILED: &str = "BACKUP_SNAPSHOT_FAILED";
/// 복원 중 실패했다(설정 쓰기 등).
pub const ERR_RESTORE_FAILED: &str = "BACKUP_RESTORE_FAILED";

/// 메타 엔트리 이름 — 이 파일의 존재가 "note-rang 백업"의 정의다.
const META_ENTRY: &str = "backup.json";
/// 공유 설정 엔트리.
const SHARED_ENTRY: &str = "settings/shared-settings.json";
/// 이식 가능한 로컬 환경설정 엔트리.
const PREFS_ENTRY: &str = "settings/local-prefs.json";
/// 플러그인 로컬 상태 엔트리.
const STATE_ENTRY: &str = "plugins/plugins-state.json";
/// 플러그인 코드 디렉터리 접두어(`plugins/code/<id>/<파일>`).
const CODE_PREFIX: &str = "plugins/code/";
/// 플러그인 저장소 접두어(`plugins/storage/<id>.json`·`plugins/storage/builtin/<id>.json`).
const STORAGE_PREFIX: &str = "plugins/storage/";

/// 읽어들일 백업 파일의 최대 바이트(설정 + 플러그인 소스 정도라면 한참 남는다).
const MAX_BACKUP_BYTES: u64 = 64 * 1024 * 1024;
/// 플러그인 파일 하나의 최대 바이트(에셋 이미지 상한과 같은 크기).
const MAX_PLUGIN_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 플러그인 하나에서 담을 최대 파일 수(manifest + entry + README + 에셋 여유).
const MAX_PLUGIN_FILES: usize = 32;

/// 백업 스냅샷을 보관할 최대 개수 — vault(동기화될 수 있는 폴더)에 무한히 쌓이지 않게 한다.
const MAX_SNAPSHOTS: usize = 5;

/// 압축 해제 상한 — [`plugin_install::extract_zip`]이 쓰는 것과 같은 형태로, 백업 크기에 맞춰
/// 넉넉하게 잡는다. 이 상한을 재사용하는 덕분에 zip-slip·심링크·폭탄 방어가 **한 군데**에만
/// 존재한다(plugin_install.rs의 그 함수 문서 참고).
const EXTRACT_LIMITS: InstallLimits = InstallLimits {
    max_archive_bytes: MAX_BACKUP_BYTES,
    max_unpacked_bytes: 128 * 1024 * 1024,
    max_entries: 4096,
};

/// 백업이 담은 플러그인 한 건의 표시용 메타(복원 미리보기의 목록).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// `backup.json`의 내용 — 무엇을 언제 어떤 앱 버전에서 담았는지.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupMeta {
    pub schema_version: u32,
    /// 백업을 만든 앱 버전(`tauri.conf.json`의 version).
    #[serde(default)]
    pub app_version: String,
    /// 생성 시각(에폭 ms) — 표시용. 프론트가 사용자 로케일로 포맷한다.
    #[serde(default)]
    pub created_at: i64,
    /// 만든 기기의 OS(`std::env::consts::OS`) — 표시용(경고가 아니라 정보).
    #[serde(default)]
    pub platform: String,
    /// 담긴 플러그인 목록(표시용). 복원은 이 목록이 아니라 **실제 엔트리**를 근거로 한다.
    #[serde(default)]
    pub plugins: Vec<BackupPluginInfo>,
}

/// 로컬 설정 중 **기기를 옮겨도 뜻이 유지되는** 값만 담는 이식 조각.
///
/// `LocalConfig` 전체를 담지 않는 이유는 모듈 문서의 「무엇이 빠지는가」 참고 — `vault_path`는
/// 기기 종속이고 `welcomed`/`vault_prompted`는 1회성 흔적이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortablePrefs {
    pub launch_at_login: bool,
    pub global_hotkey: String,
    /// 활성 노트가 하나도 없을 때의 시작 동작
    /// ([`crate::settings::LocalConfig::startup_no_active_action`]).
    ///
    /// **`#[serde(default)]`가 필수**다: 이 필드가 없던 **구버전 백업**의
    /// `settings/local-prefs.json`을 읽을 때 default가 없으면 파싱이 실패하고,
    /// [`import_backup_file`]이 그것을 [`ERR_CORRUPT`]로 승격시켜 **복원 전체가 중단**된다
    /// (설정도 플러그인도 하나도 들어오지 않는다). 아래 `panel_sort`도 같은 이유다.
    #[serde(default = "crate::settings::startup_no_active_action_default")]
    pub startup_no_active_action: String,
    /// 패널 목록 정렬 모드([`crate::settings::LocalConfig::panel_sort`] — 백엔드는 의미를
    /// 모르는 불투명 문자열). `#[serde(default)]`가 필수인 이유는 위 필드 참고.
    #[serde(default = "crate::settings::panel_sort_default")]
    pub panel_sort: String,
}

/// 백업 파일 하나의 요약 — 가져오기 전 미리보기(그리고 내보내기 결과 안내)에 쓴다.
///
/// **메타를 그대로 믿지 않는다**: `has_settings`·`plugins`·`storage_count`는 아카이브에 실제로
/// 존재하는 엔트리에서 센 값이다(메타는 이름·버전 같은 표시용 정보만 제공). 손으로 고친
/// 백업이 "설정이 들어 있다"고 주장해도 미리보기가 거짓말하지 않는다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackupSummary {
    /// 파일 절대경로(표시용).
    pub path: String,
    pub schema_version: u32,
    pub app_version: String,
    pub created_at: i64,
    pub platform: String,
    /// 이 앱이 복원할 수 있는 버전인지(스키마 버전이 현재 이하).
    pub supported: bool,
    /// 공유 설정이 들어 있는지.
    pub has_settings: bool,
    /// 이식 가능한 로컬 환경설정(자동 실행·전역 단축키·시작 동작·패널 정렬 모드)이 들어 있는지.
    pub has_prefs: bool,
    /// 코드가 담긴 플러그인 목록(id 정렬).
    pub plugins: Vec<BackupPluginInfo>,
    /// 플러그인 저장소 파일 수.
    pub storage_count: usize,
    /// 파일 바이트 수(표시용).
    pub size_bytes: u64,
}

/// 무엇을 복원할지 — 프론트 체크박스와 1:1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct RestoreSelection {
    pub settings: bool,
    pub plugins: bool,
}

/// 복원 결과 요약(프론트 안내 문구용).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportReport {
    pub settings_restored: bool,
    pub prefs_restored: bool,
    /// 코드·상태를 복원한 플러그인 수.
    pub plugins_restored: usize,
    /// 복원하지 못한 플러그인 id(매니페스트가 깨졌거나 설치가 실패한 것).
    pub plugins_failed: Vec<String>,
    /// 복원한 저장소 파일 수.
    pub storage_restored: usize,
    /// 복원 직전 만든 안전 스냅샷의 절대경로(되돌릴 때 이 파일을 가져오면 된다).
    pub snapshot_path: String,
}

/// [`import_backup_file`]의 산출 — 프론트로 갈 보고서와, 호출부(커맨드)가 앱 상태에 반영해야
/// 하는 값들.
///
/// 왜 나누는가: 이 모듈은 파일시스템만 다루고 Tauri를 모른다(그래서 tempdir로 테스트된다).
/// 메모리 상태 교체·자동 실행 반영·전역 단축키 재등록·트레이 갱신은 `AppHandle`이 필요한
/// 일이라 커맨드의 몫으로 남긴다.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportOutcome {
    pub report: ImportReport,
    /// 복원된 공유 설정(복원하지 않았으면 None) — 커맨드가 `AppState`의 사본을 교체한다.
    pub shared: Option<SharedSettings>,
    /// 복원된 이식 환경설정(복원하지 않았으면 None) — 커맨드가 `LocalConfig`에 반영한다.
    pub prefs: Option<PortablePrefs>,
}

/// 아카이브 조립 실패를 설명 문자열로 바꾼다.
///
/// **코드 접두어를 붙이지 않는다**: 같은 조립이 내보내기(`BACKUP_WRITE_FAILED`)와 안전
/// 스냅샷(`BACKUP_SNAPSHOT_FAILED`) 양쪽에서 쓰이므로, 어느 쪽 실패인지는 호출부가 정한다
/// (코드가 두 번 겹친 문자열이 나오지 않게).
fn zip_err<E: std::fmt::Display>(e: E) -> String {
    format!("백업 데이터를 만들지 못했습니다: {e}")
}

// ── 내보내기 ────────────────────────────────────────────────────────────────

/// zip 한 덩이를 메모리에 만든다 — 파일로 쓰기 전의 순수한 산출물(테스트가 이 바이트를 직접 연다).
fn build_archive(
    app_data: &Path,
    vault_root: &Path,
    prefs: &PortablePrefs,
    app_version: &str,
    created_at: i64,
) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();

    let collected = collect_plugins(app_data);
    let meta = BackupMeta {
        schema_version: SCHEMA_VERSION,
        app_version: app_version.to_string(),
        created_at,
        platform: std::env::consts::OS.to_string(),
        plugins: collected.iter().map(|p| p.info.clone()).collect(),
    };

    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, opts).map_err(zip_err)?;
        zip.write_all(bytes).map_err(zip_err)
    };

    add(
        META_ENTRY,
        serde_json::to_string_pretty(&meta)
            .map_err(zip_err)?
            .as_bytes(),
    )?;

    // 공유 설정: 파일이 없으면 기본값이 담긴다(`load_shared_settings`의 폴백) — 백업이 "설정이
    // 비었다"가 아니라 "기본 설정이다"를 뜻하게 되어 복원 결과가 예측 가능하다.
    let shared = settings::load_shared_settings(vault_root);
    add(
        SHARED_ENTRY,
        serde_json::to_string_pretty(&shared)
            .map_err(zip_err)?
            .as_bytes(),
    )?;
    add(
        PREFS_ENTRY,
        serde_json::to_string_pretty(prefs)
            .map_err(zip_err)?
            .as_bytes(),
    )?;

    // 플러그인 상태에서 부여 권한을 **덜어내고** 담는다(모듈 문서 「권한은 복원하지 않는다」).
    let state = portable_state(&plugins::load_state(app_data));
    add(
        STATE_ENTRY,
        serde_json::to_string_pretty(&state)
            .map_err(zip_err)?
            .as_bytes(),
    )?;

    for plugin in &collected {
        for (name, bytes) in &plugin.files {
            add(&format!("{CODE_PREFIX}{}/{name}", plugin.info.id), bytes)?;
        }
    }
    for (rel, bytes) in collect_storage(app_data) {
        add(&format!("{STORAGE_PREFIX}{rel}"), &bytes)?;
    }

    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// 부여 권한(`granted`)과 예약 권한 메모(`pendingReserved`)를 비운 상태 사본을 만든다.
///
/// 내보내기 시점에 이미 비우는 이유: 백업 파일이 기기 밖을 도는 데이터이기 때문이다. 가져오기도
/// 같은 정리를 한 번 더 하지만(손으로 고친 파일 방어), 애초에 **내 부여 목록이 파일에 적히지
/// 않는 편**이 사용자에게도 정직하다.
fn portable_state(state: &PluginsState) -> PluginsState {
    let mut out = state.clone();
    for record in out.plugins.values_mut() {
        record.granted.clear();
        record.pending_reserved.clear();
    }
    out
}

/// 백업에 담을 플러그인 하나(표시용 메타 + 파일 바이트).
struct CollectedPlugin {
    info: BackupPluginInfo,
    /// (파일명, 바이트) — 설치 디렉터리 **1단계**만 담는다(설치가 만드는 구조가 그렇다).
    files: Vec<(String, Vec<u8>)>,
}

/// 설치된 커뮤니티 플러그인을 모은다 — 매니페스트가 유효하고 폴더명이 id와 일치하며,
/// 복원에 필요한 파일(manifest + entry)이 실제로 담긴 것만.
///
/// 깨진 폴더를 건너뛰는 이유: 어차피 복원 쪽 관문([`plugins::install_from_dir`])이 같은 검증을
/// 하므로 담아 봐야 복원되지 않는다. 담지 않는 편이 백업 크기와 미리보기 목록 모두 정직하다.
fn collect_plugins(app_data: &Path) -> Vec<CollectedPlugin> {
    let root = plugins::plugins_dir(app_data);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out: Vec<CollectedPlugin> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&dir) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(dir.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = plugins::parse_manifest(&raw) else {
            continue;
        };
        if manifest.id != dir_name {
            continue; // 스캔이 탈락시키는 폴더(`scan_installed_report`)와 같은 규칙.
        }
        let files = collect_plugin_files(&dir);
        // 복원에 **반드시 필요한 두 파일**(manifest + entry)이 다 담겼을 때만 목록에 넣는다.
        // 왜: `collect_plugin_files`는 상한(2MB)을 넘는 파일을 조용히 건너뛰므로, entry가
        // 큰 플러그인은 manifest + README만 담긴 채 "정상 항목"으로 백업·미리보기에 올라간다.
        // 그러면 복원 관문([`plugins::install_from_dir`])이 `entry 파일 없음`으로 반드시
        // 실패한다 — 담지 않는 편이 목록도 정직하고 복원도 헛돌지 않는다.
        let has = |name: &str| files.iter().any(|(n, _)| n == name);
        if !has("manifest.json") || !has(&manifest.entry) {
            continue;
        }
        out.push(CollectedPlugin {
            info: BackupPluginInfo {
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
            },
            files,
        });
    }
    out.sort_by(|a, b| a.info.id.cmp(&b.info.id)); // 결정적 순서(같은 상태 → 같은 아카이브 구조).
    out
}

/// 플러그인 폴더 1단계의 일반 파일을 읽는다(심링크·과대 파일·개수 초과는 건너뛴다).
fn collect_plugin_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in entries.flatten() {
        if files.len() >= MAX_PLUGIN_FILES {
            break;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_PLUGIN_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        files.push((name.to_string(), bytes));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

/// 플러그인 저장소 파일을 모은다 — `<id>.json`과 `builtin/<id>.json` 두 층만(그 외는 무시).
fn collect_storage(app_data: &Path) -> Vec<(String, Vec<u8>)> {
    let root = plugin_storage::storage_dir(app_data);
    let mut out = read_storage_files(&root, "");
    out.extend(read_storage_files(&root.join("builtin"), "builtin/"));
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// 한 층의 `<id>.json`을 읽어 `(상대경로, 바이트)`로 만든다(id 형식·상한 검사 포함).
fn read_storage_files(dir: &Path, prefix: &str) -> Vec<(String, Vec<u8>)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink()
            || !meta.is_file()
            || meta.len() > plugin_storage::MAX_STORAGE_BYTES as u64
        {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !is_valid_plugin_id(id) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if serde_json::from_slice::<serde_json::Value>(&bytes).is_err() {
            continue; // 깨진 저장소는 담지 않는다(복원해 봐야 빈 맵으로 읽힌다).
        }
        out.push((format!("{prefix}{name}"), bytes));
    }
    out
}

/// 플러그인 id 형식 검증 — `plugin_storage::is_valid_plugin_id`와 **같은 규칙**의 복제다.
///
/// 왜 복제인가: 원본은 그 모듈의 비공개 함수이고, 규칙 자체(소문자·숫자·`._-`, 첫 글자 영숫자)는
/// `plugins.rs`가 정본이다. 여기서 필요한 이유는 하나다 — 백업이 준 이름을 **경로로 만들기 전에**
/// `..`·`/`·`\`를 걸러내는 것(경로 탈출은 zip 해제 단계에서도 막지만, 이름을 그대로 파일 경로에
/// 이어 붙이는 곳마다 한 겹씩 더 두는 편이 안전하다).
fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// 백업을 만들어 `dest`에 쓰고 요약을 돌려준다.
///
/// 원자적으로 쓴다([`write_atomic_bytes`] — 같은 폴더 임시 파일 + rename): 쓰다 만 백업이
/// "있는 것처럼 보이는" 상태를 만들지 않는다.
pub fn write_backup(
    app_data: &Path,
    vault_root: &Path,
    prefs: &PortablePrefs,
    app_version: &str,
    created_at: i64,
    dest: &Path,
) -> Result<BackupSummary, String> {
    let bytes = build_archive(app_data, vault_root, prefs, app_version, created_at)
        .map_err(|e| format!("{ERR_WRITE_FAILED} {e}"))?;
    write_atomic_bytes(dest, &bytes)
        .map_err(|e| format!("{ERR_WRITE_FAILED} 백업 파일을 쓰지 못했습니다: {e}"))?;
    let mut summary = summarize(&bytes)?;
    summary.path = dest.to_string_lossy().into_owned();
    Ok(summary)
}

/// 기본 파일 이름(`note-rang-backup-YYYY-MM-DD.zip`) — 저장 다이얼로그의 초기값.
///
/// 날짜는 **UTC 기준**이다(std만으로는 지역 시간대를 알 수 없다). 파일 이름의 하루 차이는
/// 무해하고, 정확한 시각은 메타(`created_at`, 에폭 ms)에 남아 미리보기가 사용자 로케일로
/// 표시한다.
pub fn default_file_name(created_at: i64) -> String {
    let (y, m, d, _, _, _) = utc_parts(created_at);
    format!("note-rang-backup-{y:04}-{m:02}-{d:02}.zip")
}

/// 에폭 ms를 UTC 연·월·일·시·분·초로 나눈다.
///
/// 왜 직접 계산하나: 날짜 크레이트를 하나 더 들이는 것보다, 파일 이름 하나를 위해 잘 알려진
/// civil-from-days 변환(Howard Hinnant)을 20줄 적는 편이 의존성 그래프에 정직하다.
fn utc_parts(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );
    // days: 1970-01-01 기준 → 0000-03-01 기준 era 계산으로 옮긴다.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day, hour, minute, second)
}

/// 스냅샷 파일 이름(`before-import-YYYYMMDD-HHMMSS.zip`) — 사전순 정렬이 곧 시간순이다.
fn snapshot_file_name(created_at: i64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(created_at);
    format!("before-import-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.zip")
}

/// 자동 스냅샷 보관 폴더(`<vault>/.memo/backups`).
pub fn snapshot_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(".memo").join("backups")
}

/// 복원 직전의 현재 상태를 같은 포맷으로 vault에 저장하고 그 경로를 돌려준다.
///
/// vault 안(`.memo/backups/`)에 두는 이유: 되돌리기가 필요한 시점은 "방금 가져온 백업이 마음에
/// 안 든다"인데, 그때 사용자가 파일을 **찾을 수 있어야** 한다. 앱데이터는 OS마다 숨은 경로라
/// 찾기 어렵고, vault는 사용자가 이미 아는 폴더다(설정 창이 경로를 그대로 보여 준다). 덤으로
/// vault가 동기화 폴더면 스냅샷도 함께 동기화된다.
pub fn write_snapshot(
    app_data: &Path,
    vault_root: &Path,
    prefs: &PortablePrefs,
    app_version: &str,
    created_at: i64,
) -> Result<PathBuf, String> {
    let dir = snapshot_dir(vault_root);
    let dest = unused_snapshot_path(&dir, created_at);
    let bytes = build_archive(app_data, vault_root, prefs, app_version, created_at)
        .map_err(|e| format!("{ERR_SNAPSHOT_FAILED} {e}"))?;
    write_atomic_bytes(&dest, &bytes)
        .map_err(|e| format!("{ERR_SNAPSHOT_FAILED} 안전 스냅샷을 만들지 못했습니다: {e}"))?;
    prune_snapshots(&dir, &dest);
    Ok(dest)
}

/// 아직 쓰이지 않은 스냅샷 경로를 고른다(같은 이름이 있으면 `-2`, `-3`… 순번을 덧붙인다).
///
/// 왜: 이름의 해상도가 **초**라 같은 초에 두 번 가져오면 이름이 겹치고, `write_atomic_bytes`는
/// rename으로 조용히 덮어쓴다 — 되돌릴 수 있었던 스냅샷이 소리 없이 하나 사라진다.
/// 접두어(`before-import-`)와 확장자는 그대로 두어 [`prune_snapshots`]의 필터가 계속 인식한다.
fn unused_snapshot_path(dir: &Path, created_at: i64) -> PathBuf {
    let base = snapshot_file_name(created_at);
    let first = dir.join(&base);
    if !first.exists() {
        return first;
    }
    let stem = base.strip_suffix(".zip").unwrap_or(base.as_str());
    for n in 2..100 {
        let candidate = dir.join(format!("{stem}-{n}.zip"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first // 같은 초에 99번 — 현실적으로 도달하지 않는다(도달하면 덮어쓰는 옛 동작 그대로).
}

/// 오래된 스냅샷을 [`MAX_SNAPSHOTS`]개만 남기고 지운다. `keep`(방금 쓴 것)은 **절대 지우지
/// 않는다**.
///
/// 왜 `keep`이 필요한가: "이름 사전순 = 시간순"은 시계가 단조 증가할 때만 성립하는데,
/// 스냅샷 이름의 시각은 `notes::now_ms()`(벽시계)라 그 보장이 없다. NTP 보정·수동 시계 조정,
/// 혹은 vault가 동기화 폴더라 시계가 앞선 다른 기기의 스냅샷이 섞여 들어오면 방금 쓴 파일이
/// 사전순 맨 앞이 되어 **자기 자신이 먼저 삭제**된다. 그러면 [`ImportReport::snapshot_path`]가
/// 존재하지 않는 파일을 가리키고 UI는 "이 파일로 되돌릴 수 있다"고 말한다 — 되돌릴 길이
/// 조용히 사라진 채로.
///
/// 정렬 기준도 이름이 아니라 **수정 시각**이다(시계 역행에 덜 취약하고, 순번이 붙은 이름과도
/// 어긋나지 않는다). 실패는 무시한다 — 스냅샷 정리는 위생이지 복원의 성공 조건이 아니다.
fn prune_snapshots(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("before-import-") && n.ends_with(".zip"))
                && p.file_name() != keep.file_name()
        })
        .map(|p| {
            let modified = p
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, p)
        })
        .collect();
    // 방금 쓴 스냅샷도 보관 한도의 한 자리를 차지한다(정리 후 총 MAX_SNAPSHOTS개가 남는다).
    let limit = MAX_SNAPSHOTS.saturating_sub(1);
    if found.len() <= limit {
        return;
    }
    found.sort(); // (수정 시각, 경로) 오름차순 — 오래된 것이 앞.
    let excess = found.len() - limit;
    for (_, path) in found.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

// ── 읽기·미리보기 ───────────────────────────────────────────────────────────

/// 파일을 상한 안에서 읽는다(상한을 넘으면 읽지 않고 거부 — 메모리를 먼저 지키고 판단한다).
fn read_backup_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("{ERR_READ_FAILED} 백업 파일을 열지 못했습니다: {e}"))?;
    if !meta.is_file() {
        return Err(format!(
            "{ERR_NOT_A_BACKUP} 파일이 아닙니다: {}",
            path.display()
        ));
    }
    if meta.len() > MAX_BACKUP_BYTES {
        return Err(format!(
            "{ERR_TOO_LARGE} 백업으로 보기에 너무 큽니다({}바이트)",
            meta.len()
        ));
    }
    std::fs::read(path).map_err(|e| format!("{ERR_READ_FAILED} 백업 파일을 읽지 못했습니다: {e}"))
}

/// 아카이브 바이트를 훑어 요약을 만든다 — 해제하지 않고 목록만 읽는다(미리보기는 싸야 한다).
fn summarize(bytes: &[u8]) -> Result<BackupSummary, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| format!("{ERR_NOT_A_BACKUP} zip 파일이 아닙니다"))?;
    if archive.len() > EXTRACT_LIMITS.max_entries {
        return Err(format!(
            "{ERR_CORRUPT} 엔트리가 너무 많습니다({}개)",
            archive.len()
        ));
    }

    let meta: BackupMeta = {
        let mut entry = archive
            .by_name(META_ENTRY)
            .map_err(|_| format!("{ERR_NOT_A_BACKUP} note-rang 백업이 아닙니다"))?;
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut entry, &mut raw)
            .map_err(|e| format!("{ERR_CORRUPT} 메타를 읽지 못했습니다: {e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("{ERR_CORRUPT} 메타가 깨졌습니다: {e}"))?
    };

    // 이름 목록은 **실제 내용**의 근거다(메타의 주장이 아니라). 표시용 이름만 메타에서 빌린다.
    let names: Vec<String> = archive.file_names().map(|n| n.to_string()).collect();
    let has_settings = names.iter().any(|n| n == SHARED_ENTRY);
    let has_prefs = names.iter().any(|n| n == PREFS_ENTRY);
    let storage_count = names
        .iter()
        .filter(|n| n.starts_with(STORAGE_PREFIX) && n.ends_with(".json"))
        .count();

    let mut ids: Vec<String> = names
        .iter()
        .filter_map(|n| n.strip_prefix(CODE_PREFIX))
        .filter_map(|rest| rest.split('/').next())
        .filter(|id| is_valid_plugin_id(id))
        .map(|id| id.to_string())
        .collect();
    ids.sort();
    ids.dedup();
    let plugins = ids
        .into_iter()
        .map(|id| {
            meta.plugins
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .unwrap_or(BackupPluginInfo {
                    name: id.clone(),
                    version: String::new(),
                    id,
                })
        })
        .collect();

    Ok(BackupSummary {
        path: String::new(), // 호출부가 채운다(바이트만으로는 경로를 알 수 없다).
        schema_version: meta.schema_version,
        app_version: meta.app_version,
        created_at: meta.created_at,
        platform: meta.platform,
        supported: meta.schema_version <= SCHEMA_VERSION,
        has_settings,
        has_prefs,
        plugins,
        storage_count,
        size_bytes: bytes.len() as u64,
    })
}

/// 백업 파일의 요약을 읽는다(가져오기 전 미리보기). 열 수 없거나 백업이 아니면 오류.
///
/// 더 새로운 스키마 버전도 **여기서는 막지 않는다** — 미리보기가 "이건 더 새 버전에서 만든
/// 백업이다"라고 설명할 수 있어야 하기 때문이다(`supported: false`). 거부는 실제 복원
/// ([`import_backup_file`])의 몫이다.
pub fn inspect_backup_file(path: &Path) -> Result<BackupSummary, String> {
    let bytes = read_backup_bytes(path)?;
    let mut summary = summarize(&bytes)?;
    summary.path = path.to_string_lossy().into_owned();
    Ok(summary)
}

// ── 가져오기(복원) ──────────────────────────────────────────────────────────

/// 백업에서 복원한다 — 스냅샷 → 해제 → 선택한 대상만 반영.
///
/// 순서 근거: **되돌릴 길을 먼저 만든다.** 스냅샷이 실패하면 복원을 시작조차 하지 않는다
/// (`ERR_SNAPSHOT_FAILED`) — vault에 쓸 수 없는 상태라면 어차피 설정 복원도 실패한다.
///
/// 플러그인 하나의 실패는 전체를 되돌리지 않고 `plugins_failed`로 보고한다: 다섯 개 중 하나가
/// 깨졌다고 나머지 넷을 포기하는 것보다, 넷을 복원하고 하나를 이름으로 알려 주는 편이 낫다
/// (스냅샷이 있으므로 사용자는 언제든 통째로 되돌릴 수 있다).
pub fn import_backup_file(
    app_data: &Path,
    vault_root: &Path,
    current_prefs: &PortablePrefs,
    app_version: &str,
    now_ms: i64,
    path: &Path,
    select: RestoreSelection,
) -> Result<ImportOutcome, String> {
    if !select.settings && !select.plugins {
        return Err(format!(
            "{ERR_NOTHING_SELECTED} 복원할 항목을 하나 이상 선택해 주세요"
        ));
    }
    let bytes = read_backup_bytes(path)?;
    let summary = summarize(&bytes)?;
    if !summary.supported {
        return Err(format!(
            "{ERR_UNSUPPORTED} 더 새로운 버전에서 만든 백업입니다(스키마 {} > {SCHEMA_VERSION})",
            summary.schema_version
        ));
    }

    let snapshot = write_snapshot(app_data, vault_root, current_prefs, app_version, now_ms)?;

    let staging_root = app_data.join("backup-staging");
    let _ = std::fs::remove_dir_all(&staging_root); // 이전 실행 잔여물 정리(설치 스테이징과 같은 관례).
    let staging = staging_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("{ERR_RESTORE_FAILED} 임시 폴더를 만들지 못했습니다: {e}"))?;
    // zip-slip·심링크·폭탄 방어는 설치 경로와 **같은 함수**가 맡는다(방어가 한 군데에만 있게).
    let extracted = plugin_install::extract_zip(&bytes, &staging, &EXTRACT_LIMITS);
    if let Err(e) = extracted {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Err(format!("{ERR_CORRUPT} 백업을 풀지 못했습니다: {e}"));
    }

    let result = apply_restore(app_data, vault_root, &staging, select, &snapshot);
    let _ = std::fs::remove_dir_all(&staging_root);
    result
}

/// 해제된 스테이징에서 실제 복원을 수행한다(스테이징 정리는 호출부가 한다).
fn apply_restore(
    app_data: &Path,
    vault_root: &Path,
    staging: &Path,
    select: RestoreSelection,
    snapshot: &Path,
) -> Result<ImportOutcome, String> {
    let mut report = ImportReport {
        settings_restored: false,
        prefs_restored: false,
        plugins_restored: 0,
        plugins_failed: Vec::new(),
        storage_restored: 0,
        snapshot_path: snapshot.to_string_lossy().into_owned(),
    };
    let mut shared_out = None;
    let mut prefs_out = None;

    if select.settings {
        // **검증이 부작용보다 먼저다**: 두 조각을 모두 파싱해 둔 뒤에야 디스크에 쓴다.
        // 순서를 뒤집으면(옛 코드) prefs가 깨진 백업에서 `shared-settings.json`만 새 값으로
        // 덮인 채 이 함수가 Err로 끝나고, 커맨드는 그 Err을 그대로 전파해 메모리 사본을
        // 갱신하지 않는다 — 사용자는 "복원 실패"를 보지만 vault 파일은 이미 바뀌어 앱
        // 메모리와 갈라진다(다음 설정 저장에서 어느 쪽이 이길지 예측할 수 없다).
        let shared: Option<SharedSettings> = match read_staged(staging, SHARED_ENTRY) {
            Some(raw) => Some(
                serde_json::from_str(&raw)
                    .map_err(|e| format!("{ERR_CORRUPT} 설정이 깨졌습니다: {e}"))?,
            ),
            None => None,
        };
        let prefs: Option<PortablePrefs> = match read_staged(staging, PREFS_ENTRY) {
            Some(raw) => Some(
                serde_json::from_str(&raw)
                    .map_err(|e| format!("{ERR_CORRUPT} 환경설정이 깨졌습니다: {e}"))?,
            ),
            None => None,
        };

        if let Some(shared) = shared {
            settings::save_shared_settings(vault_root, &shared)
                .map_err(|e| format!("{ERR_RESTORE_FAILED} 설정을 저장하지 못했습니다: {e}"))?;
            report.settings_restored = true;
            shared_out = Some(shared);
        }
        if let Some(prefs) = prefs {
            // 빈 단축키는 등록할 수 없다 — 그 항목만 무시하지 않고 조각 전체를 건너뛴다
            // (한쪽만 적용된 애매한 상태보다 "이 조각은 복원하지 않았다"가 설명하기 쉽다).
            if !prefs.global_hotkey.trim().is_empty() {
                report.prefs_restored = true;
                prefs_out = Some(prefs);
            }
        }
    }

    if select.plugins {
        // 상태 파일이 **없는** 백업(손으로 만든 것)과 "빈 상태를 담은" 백업을 구분한다 —
        // 없음은 "되돌릴 상태가 없다"이지 "지금 상태를 지우라"가 아니다(`None`이면 빌트인
        // 토글·무시 목록을 그대로 둔다).
        let state: Option<PluginsState> =
            read_staged(staging, STATE_ENTRY).and_then(|raw| serde_json::from_str(&raw).ok());
        let restored = restore_plugin_code(app_data, staging, &mut report);
        let failed_code = report.plugins_failed.clone();
        // 상태 저장 실패는 **Err로 중단하지 않는다**: 여기까지 왔다면 설정은 이미 디스크에
        // 쓰였고 플러그인 코드도 제자리에 있다. Err을 내면 커맨드가 성공 경로를 타지 못해
        // 메모리 사본이 디스크와 갈라진다 — 그보다 "이 플러그인들은 완전히 복원하지 못했다"고
        // 보고서에 담는 편이 정직하고 안전하다(스냅샷으로 통째 되돌릴 길도 그대로 남는다).
        match merge_plugin_state(app_data, state.as_ref(), &restored, &failed_code) {
            Ok(()) => report.plugins_restored = restored.len(),
            Err(e) => {
                eprintln!("[memo] 백업 복원: {e}");
                // 코드는 들어왔지만 활성·설정 값을 기록하지 못했다 — 성공으로 세지 않는다.
                report.plugins_failed.extend(restored.iter().cloned());
                report.plugins_restored = 0;
            }
        }
        record_vault_entries(app_data, vault_root, state.as_ref(), &restored);
        report.storage_restored = restore_storage(app_data, staging);
        report.plugins_failed.sort();
        report.plugins_failed.dedup();
    }

    Ok(ImportOutcome {
        report,
        shared: shared_out,
        prefs: prefs_out,
    })
}

/// 스테이징 안의 엔트리를 문자열로 읽는다(없으면 None — 부분 백업도 그대로 받아들인다).
fn read_staged(staging: &Path, entry: &str) -> Option<String> {
    let mut path = staging.to_path_buf();
    for part in entry.split('/') {
        path.push(part);
    }
    std::fs::read_to_string(path).ok()
}

/// `plugins/code/<id>/`를 실제 설치 위치로 옮긴다 — 복원된 id 목록(정렬)을 돌려준다.
///
/// 설치와 **같은 관문**([`plugins::install_from_dir`])을 통과시킨다: 매니페스트를 다시 검증하고
/// manifest + entry + README + 이미지 에셋만 복사한다. 그래서 손으로 고친 백업이 `plugins/`에
/// 임의 파일을 떨어뜨릴 수 없다(실행 표면은 언제나 entry 하나뿐이다).
///
/// 같은 id의 기존 설치는 통째로 갈아 끼운다([`plugin_install::confirm_install`]의 클린 교체와
/// 같은 이유 — entry 파일명이 바뀌면 옛 파일이 남는다). 단 **설치가 성공한 뒤에만** 치운다:
/// 먼저 지우고 설치를 시도하면(옛 코드) 백업이 조금이라도 손상됐거나(예: entry 파일이 빠진
/// 백업) 디스크가 가득 차거나 백신이 잠근 순간, 멀쩡히 돌아가던 플러그인이 코드 없이
/// 사라진다 — "복원"이 파괴가 되는 유일한 경로였다.
fn restore_plugin_code(app_data: &Path, staging: &Path, report: &mut ImportReport) -> Vec<String> {
    let code_root = staging.join("plugins").join("code");
    let Ok(entries) = std::fs::read_dir(&code_root) else {
        return Vec::new();
    };
    let mut restored = Vec::new();
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    // 설치 관문을 **임시 앱데이터 루트**에 통과시킨다 — 성공한 것만 제자리로 옮긴다.
    // 스테이징 안에 두는 이유: 실제 플러그인 폴더와 같은 볼륨(앱데이터)이라 교체가 rename
    // 한 번이고, 잔여물 정리는 호출부([`import_backup_file`])가 이미 한다.
    let sandbox = staging.join("install");
    for (n, dir) in dirs.into_iter().enumerate() {
        let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        if !is_valid_plugin_id(&dir_name) {
            report.plugins_failed.push(dir_name);
            continue;
        }
        let scratch = sandbox.join(n.to_string());
        let id = match plugins::install_from_dir(&scratch, &dir) {
            Ok(id) => id,
            Err(e) => {
                // 여기서 실패해도 기존 설치는 손대지 않은 채 그대로다.
                eprintln!("[memo] 백업 복원: 플러그인 설치 실패({dir_name}): {e}");
                report.plugins_failed.push(dir_name);
                continue;
            }
        };
        if id != dir_name {
            // 폴더명과 매니페스트 id가 어긋난 백업 — 설치는 매니페스트 id로 들어간다
            // (교체 대상도 그 id의 설치본이다: 엉뚱한 폴더를 지우지 않는다).
            eprintln!("[memo] 백업 복원: 폴더명({dir_name})과 id({id})가 다릅니다");
        }
        let installed = plugins::plugins_dir(&scratch).join(&id);
        let target = plugins::plugins_dir(app_data).join(&id);
        match swap_in_place(&installed, &target, &sandbox.join(format!("old-{n}"))) {
            Ok(()) => restored.push(id),
            Err(e) => {
                eprintln!("[memo] 백업 복원: 플러그인 교체 실패({id}): {e}");
                report.plugins_failed.push(id);
            }
        }
    }
    restored.sort();
    restored
}

/// 새로 설치한 디렉터리를 제자리(`target`)로 갈아 끼운다 — 기존 설치는 성공한 **뒤에** 사라진다.
///
/// 순서: 기존 설치를 `aside`로 rename → 새 설치를 `target`으로 rename → 성공이면 `aside`를
/// 지우고, 실패면 `aside`를 되돌린다. 어느 단계에서 실패하든 "코드가 없는 플러그인"이 남지
/// 않는 것이 이 함수의 유일한 계약이다. 세 경로가 모두 같은 볼륨(앱데이터)이라 rename은
/// 복사 없이 끝난다.
fn swap_in_place(installed: &Path, target: &Path, aside: &Path) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let had_previous = target.exists();
    if had_previous {
        if let Some(parent) = aside.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _ = std::fs::remove_dir_all(aside); // 이전 실행 잔여물(있을 리 없지만 rename 전제).
        std::fs::rename(target, aside)?;
    }
    match std::fs::rename(installed, target) {
        Ok(()) => {
            if had_previous {
                let _ = std::fs::remove_dir_all(aside);
            }
            Ok(())
        }
        Err(e) => {
            if had_previous {
                let _ = std::fs::rename(aside, target); // 기존 설치를 원래 자리로 되돌린다.
            }
            Err(e)
        }
    }
}

/// 백업의 플러그인 상태를 현재 상태에 병합한다(부여는 **비운 채로**).
///
/// 병합 규칙:
/// - 방금 코드가 복원된 id만 레코드를 가져온다(코드 없는 유령 레코드를 만들지 않는다).
/// - 백업에 레코드가 없는 id는 `enabled = true`로 새로 만든다 — 신규 설치와 같은 기본값
///   ([`plugin_install::confirm_install`]).
/// - 빌트인 토글·빌트인 설정 값·"무시한 재조정 항목"은 통째로 교체한다(전부 로컬 선호 값이고,
///   부분 병합은 "복원했는데 반만 돌아왔다"는 설명하기 어려운 상태를 만든다). 단 **상태 파일
///   자체가 없는 백업**(`backup: None`)이면 아무것도 교체하지 않는다 — "담기지 않았다"는
///   "지우라"가 아니다.
/// - 복원에 **실패**한 id는 이 기기에 코드가 남아 있는지 보고 판단한다: 코드가 있으면(설치를
///   먼저 하고 교체하므로 보통 그렇다) 기존 부여가 여전히 유효하니 그대로 두고, 코드가 없으면
///   부여만 비운다 — 코드 없는 레코드에 `granted`가 남아 있으면 나중에 같은 id를 설치할 때
///   승인 화면을 거치지 않고 특권이 되살아난다(유령 레코드). 설정 값·활성은 남겨 재설치 시
///   사용자 선호는 지킨다.
/// - 그 밖의 로컬 플러그인 레코드는 **건드리지 않는다**(복원은 더하기만 한다 — 모듈 문서 참고).
fn merge_plugin_state(
    app_data: &Path,
    backup: Option<&PluginsState>,
    restored: &[String],
    failed: &[String],
) -> Result<(), String> {
    plugins::with_state_lock(|| {
        let mut state = plugins::load_state(app_data);
        for id in failed {
            if plugins::plugins_dir(app_data).join(id).is_dir() {
                continue; // 코드가 제자리에 있다 — 그 부여는 사용자가 승인한 그대로 유효하다.
            }
            if let Some(record) = state.plugins.get_mut(id) {
                record.granted.clear();
                record.pending_reserved.clear();
            }
        }
        for id in restored {
            // 백업에 레코드가 없으면 신규 설치와 같은 기본값(켜짐)으로 만든다.
            let mut record = backup
                .and_then(|b| b.plugins.get(id))
                .cloned()
                .unwrap_or_else(|| PluginRecord {
                    enabled: true,
                    ..PluginRecord::default()
                });
            // 파일을 손으로 고쳐 부여를 채워 넣어도 여기서 다시 비운다(내보내기와 이중 방어).
            record.granted.clear();
            record.pending_reserved.clear();
            state.plugins.insert(id.clone(), record);
        }
        if let Some(backup) = backup {
            state.builtins = backup.builtins.clone();
            state.builtin_settings = backup.builtin_settings.clone();
            state.dismissed_missing = backup.dismissed_missing.clone();
        }
        plugins::save_state(app_data, &state)
            .map_err(|e| format!("{ERR_RESTORE_FAILED} 플러그인 상태를 저장하지 못했습니다: {e}"))
    })
}

/// 복원한 플러그인을 vault 참조 목록(`installed-plugins.json`)에도 반영한다.
///
/// 설치가 하는 일([`plugin_install::confirm_install`])을 그대로 따라 "이 기기에 설치된 것은
/// vault 목록에도 있다"는 불변식을 유지한다 — 안 하면 다른 기기의 재조정 안내가 방금 복원한
/// 플러그인을 모른다. 실패는 로깅만 한다(코드는 이미 제자리에 있고, 목록은 참조일 뿐이다).
fn record_vault_entries(
    app_data: &Path,
    vault_root: &Path,
    backup: Option<&PluginsState>,
    restored: &[String],
) {
    for id in restored {
        let record = backup.and_then(|b| b.plugins.get(id));
        // 이름·버전의 정본은 방금 설치된 매니페스트다(백업 레코드의 version은 참조용 사본일 뿐).
        let manifest = std::fs::read_to_string(
            plugins::plugins_dir(app_data)
                .join(id)
                .join("manifest.json"),
        )
        .ok()
        .and_then(|raw| plugins::parse_manifest(&raw).ok());
        let (name, version) = manifest.map(|m| (m.name, m.version)).unwrap_or_else(|| {
            (
                id.clone(),
                record
                    .and_then(|r| r.version.clone())
                    .unwrap_or_else(|| "0.0.0".to_string()),
            )
        });
        let entry = VaultPluginEntry {
            id: id.clone(),
            name,
            version,
            source: record
                .and_then(|r| r.source.clone())
                .unwrap_or(PluginSource::Local),
        };
        if let Err(e) = plugin_sync::upsert_entry(vault_root, entry) {
            eprintln!("[memo] 백업 복원: vault 목록 기록 실패({id}): {e}");
        }
    }
}

/// 저장소 파일을 복원한다 — 복원한 파일 수를 돌려준다.
///
/// 설치 플러그인 저장소는 **그 플러그인이 실제로 있을 때만** 되돌린다(`plugin_storage`가
/// `require_installed`로 지키는 규칙 — 오탈자 id의 고아 파일을 만들지 않는다). 빌트인 저장소는
/// id 목록이 프론트(번들 코드)에 있어 Rust가 판정할 수 없으므로 형식·상한 검사만 하고 받는다.
fn restore_storage(app_data: &Path, staging: &Path) -> usize {
    let src = staging.join("plugins").join("storage");
    let dest = plugin_storage::storage_dir(app_data);
    let installed = |id: &str| plugins::plugins_dir(app_data).join(id).is_dir();
    let mut count = copy_storage_layer(&src, &dest, installed);
    count += copy_storage_layer(&src.join("builtin"), &dest.join("builtin"), |_| true);
    count
}

/// 저장소 한 층을 복사한다(형식·상한·JSON 검사 + 호출부가 준 id 조건).
fn copy_storage_layer(src: &Path, dest: &Path, accept: impl Fn(&str) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(src) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !is_valid_plugin_id(id) || !accept(id) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.len() > plugin_storage::MAX_STORAGE_BYTES
            || serde_json::from_slice::<serde_json::Value>(&bytes).is_err()
        {
            continue;
        }
        if write_atomic_bytes(&dest.join(name), &bytes).is_ok() {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// 테스트용 이식 환경설정.
    fn prefs() -> PortablePrefs {
        PortablePrefs {
            launch_at_login: false,
            global_hotkey: "CmdOrCtrl+Alt+M".to_string(),
            startup_no_active_action: settings::STARTUP_NO_ACTIVE_NEW_NOTE.to_string(),
            panel_sort: "title-asc".to_string(),
        }
    }

    /// 테스트용 설치 플러그인 하나를 만든다(manifest + entry + README).
    fn make_plugin(app_data: &Path, id: &str) {
        let dir = plugins::plugins_dir(app_data).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{"id":"{id}","name":"{id} 이름","version":"1.2.0","entry":"main.js","permissions":["notes:read"]}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join("main.js"), format!("// {id} 코드")).unwrap();
        std::fs::write(dir.join("README.md"), format!("# {id}")).unwrap();
    }

    /// 테스트용 상태 파일(활성 + 부여 + 설정 값 + 빌트인 토글)을 쓴다.
    fn write_state(app_data: &Path, id: &str) {
        let mut state = PluginsState::default();
        let record = state.plugins.entry(id.to_string()).or_default();
        record.enabled = true;
        record.granted = vec!["notes:read".to_string()];
        record.pending_reserved = vec!["reserved:x".to_string()];
        record.version = Some("1.2.0".to_string());
        record.source = Some(PluginSource::Url {
            url: "https://example.com/p.zip".to_string(),
        });
        record
            .settings
            .insert("k".to_string(), serde_json::json!("v"));
        state.builtins.insert("word-count".to_string(), false);
        let mut bs = BTreeMap::new();
        bs.insert("size".to_string(), serde_json::json!(3));
        state.builtin_settings.insert("template".to_string(), bs);
        state.dismissed_missing = vec!["ghost".to_string()];
        plugins::save_state(app_data, &state).unwrap();
    }

    /// 테스트용 저장소 파일(설치 + 빌트인)을 쓴다.
    fn write_storage(app_data: &Path, id: &str) {
        let root = plugin_storage::storage_dir(app_data);
        std::fs::create_dir_all(root.join("builtin")).unwrap();
        std::fs::write(root.join(format!("{id}.json")), r#"{"cache":1}"#).unwrap();
        std::fs::write(root.join("builtin").join("clock.json"), r#"{"tz":"KST"}"#).unwrap();
    }

    /// 테스트용 기기 하나를 통째로 만든다(app_data + vault) — 반환: (app_data, vault).
    fn make_device(root: &Path, id: &str) -> (PathBuf, PathBuf) {
        let app_data = root.join("app_data");
        let vault = root.join("vault");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&vault).unwrap();
        make_plugin(&app_data, id);
        write_state(&app_data, id);
        write_storage(&app_data, id);
        let shared = SharedSettings {
            theme: "내-테마".to_string(),
            language: Some("en".to_string()),
            ..SharedSettings::default()
        };
        settings::save_shared_settings(&vault, &shared).unwrap();
        (app_data, vault)
    }

    /// 백업 zip을 다시 조립한다 — `edit`이 `None`을 주면 그 엔트리를 뺀다(손상된 백업 흉내).
    fn rewrite_archive(src: &Path, dest: &Path, edit: impl Fn(&str, Vec<u8>) -> Option<Vec<u8>>) {
        let original = std::fs::read(src).unwrap();
        let mut zin = zip::ZipArchive::new(std::io::Cursor::new(original)).unwrap();
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        let names: Vec<String> = zin.file_names().map(|s| s.to_string()).collect();
        for name in names {
            let mut entry = zin.by_name(&name).unwrap();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            let Some(buf) = edit(&name, buf) else {
                continue;
            };
            out.start_file(&name, opts).unwrap();
            out.write_all(&buf).unwrap();
        }
        std::fs::write(dest, out.finish().unwrap().into_inner()).unwrap();
    }

    /// 가드(핵심): 내보내고 → 상태를 지운 뒤 → 가져오면 설정·플러그인·저장소가 되돌아온다.
    #[test]
    fn round_trip_restores_settings_plugins_and_storage() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("out").join("backup.zip");

        let summary = write_backup(
            &app_data,
            &vault,
            &prefs(),
            "9.9.9",
            1_760_000_000_000,
            &dest,
        )
        .expect("내보내기 성공");
        assert!(dest.is_file());
        assert!(summary.has_settings && summary.has_prefs);
        assert_eq!(summary.plugins.len(), 1);
        assert_eq!(summary.plugins[0].name, "alpha 이름");
        assert_eq!(summary.storage_count, 2);

        // 기기를 "새 기기"처럼 비운다(플러그인 코드·상태·저장소 삭제 + 다른 설정).
        std::fs::remove_dir_all(plugins::plugins_dir(&app_data)).unwrap();
        std::fs::remove_dir_all(plugin_storage::storage_dir(&app_data)).unwrap();
        std::fs::remove_file(plugins::state_path(&app_data)).unwrap();
        settings::save_shared_settings(&vault, &SharedSettings::default()).unwrap();

        let outcome = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "9.9.9",
            1_760_000_100_000,
            &dest,
            RestoreSelection {
                settings: true,
                plugins: true,
            },
        )
        .expect("가져오기 성공");

        assert!(outcome.report.settings_restored);
        assert!(outcome.report.prefs_restored);
        assert_eq!(outcome.report.plugins_restored, 1);
        assert!(outcome.report.plugins_failed.is_empty());
        assert_eq!(outcome.report.storage_restored, 2);

        // 공유 설정이 디스크와 반환값 양쪽에서 되돌아왔다.
        assert_eq!(settings::load_shared_settings(&vault).theme, "내-테마");
        assert_eq!(
            outcome.shared.as_ref().and_then(|s| s.language.clone()),
            Some("en".to_string())
        );
        let restored_prefs = outcome.prefs.as_ref().unwrap();
        assert_eq!(restored_prefs.global_hotkey, "CmdOrCtrl+Alt+M");
        // 시작 흐름·정렬 취향도 함께 이식된다(넣지 않으면 이 둘만 조용히 기본값이 된다).
        assert_eq!(
            restored_prefs.startup_no_active_action,
            settings::STARTUP_NO_ACTIVE_NEW_NOTE
        );
        assert_eq!(restored_prefs.panel_sort, "title-asc");

        // 플러그인 코드가 설치 위치로 돌아왔다(README도 함께).
        let dir = plugins::plugins_dir(&app_data).join("alpha");
        assert!(dir.join("manifest.json").is_file());
        assert_eq!(
            std::fs::read_to_string(dir.join("main.js")).unwrap(),
            "// alpha 코드"
        );
        assert!(dir.join("README.md").is_file());

        // 상태: 활성·설정 값·빌트인 토글은 돌아오고 **부여는 비어 있다**.
        let state = plugins::load_state(&app_data);
        let record = state.plugins.get("alpha").expect("레코드 복원");
        assert!(record.enabled);
        assert_eq!(record.settings.get("k"), Some(&serde_json::json!("v")));
        assert_eq!(record.version.as_deref(), Some("1.2.0"));
        assert!(record.granted.is_empty(), "권한은 재승인 대상이다");
        assert!(record.pending_reserved.is_empty());
        assert_eq!(state.builtins.get("word-count"), Some(&false));
        assert_eq!(state.dismissed_missing, vec!["ghost".to_string()]);

        // 저장소 두 층이 모두 돌아왔다.
        let storage = plugin_storage::storage_dir(&app_data);
        assert!(storage.join("alpha.json").is_file());
        assert!(storage.join("builtin").join("clock.json").is_file());

        // vault 참조 목록에도 기록됐다(설치와 같은 불변식).
        let list = plugin_sync::load_vault_list(&vault);
        assert_eq!(list.plugins.len(), 1);
        assert_eq!(list.plugins[0].id, "alpha");

        // 스테이징 잔여물이 남지 않는다.
        assert!(!app_data.join("backup-staging").exists());
    }

    /// 가드: 부여 권한은 **아카이브 안에도** 담기지 않는다(파일이 새어도 특권이 새지 않는다).
    #[test]
    fn archive_never_carries_grants() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let bytes = build_archive(&app_data, &vault, &prefs(), "1.0.0", 0).unwrap();

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(STATE_ENTRY).unwrap(), &mut raw)
            .unwrap();
        let state: PluginsState = serde_json::from_str(&raw).unwrap();
        assert!(state.plugins["alpha"].granted.is_empty());
        assert!(state.plugins["alpha"].pending_reserved.is_empty());
        assert!(!raw.contains("notes:read"));
        assert!(state.plugins["alpha"].enabled, "활성은 복원 대상이다");
    }

    /// 가드: 손으로 고쳐 부여를 채운 백업을 가져와도 부여는 비어 있다(가져오기 쪽 이중 방어).
    #[test]
    fn tampered_grants_are_dropped_on_import() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        // 아카이브를 다시 만들어 상태 엔트리에 부여를 심는다(악의적 백업 흉내).
        let original = std::fs::read(&dest).unwrap();
        let mut src = zip::ZipArchive::new(std::io::Cursor::new(original)).unwrap();
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        let names: Vec<String> = src.file_names().map(|s| s.to_string()).collect();
        for name in names {
            let mut entry = src.by_name(&name).unwrap();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            if name == STATE_ENTRY {
                let mut state: PluginsState = serde_json::from_slice(&buf).unwrap();
                state
                    .plugins
                    .get_mut("alpha")
                    .unwrap()
                    .granted
                    .push("notes:read".to_string());
                buf = serde_json::to_vec(&state).unwrap();
            }
            out.start_file(&name, opts).unwrap();
            out.write_all(&buf).unwrap();
        }
        let tampered = tmp.path().join("tampered.zip");
        std::fs::write(&tampered, out.finish().unwrap().into_inner()).unwrap();

        import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &tampered,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();
        assert!(plugins::load_state(&app_data).plugins["alpha"]
            .granted
            .is_empty());
    }

    /// 가드: 선택이 지켜진다 — 설정만 고르면 플러그인은 그대로, 플러그인만 고르면 설정은 그대로.
    #[test]
    fn selection_limits_what_is_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        std::fs::remove_dir_all(plugins::plugins_dir(&app_data)).unwrap();
        settings::save_shared_settings(&vault, &SharedSettings::default()).unwrap();

        // 설정만 복원 — 플러그인 코드는 돌아오지 않는다.
        let only_settings = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &dest,
            RestoreSelection {
                settings: true,
                plugins: false,
            },
        )
        .unwrap();
        assert!(only_settings.report.settings_restored);
        assert_eq!(only_settings.report.plugins_restored, 0);
        assert_eq!(settings::load_shared_settings(&vault).theme, "내-테마");
        assert!(!plugins::plugins_dir(&app_data).join("alpha").exists());

        // 플러그인만 복원 — 설정은 건드리지 않는다.
        settings::save_shared_settings(&vault, &SharedSettings::default()).unwrap();
        let only_plugins = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &dest,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();
        assert!(!only_plugins.report.settings_restored);
        assert!(only_plugins.shared.is_none());
        assert_eq!(only_plugins.report.plugins_restored, 1);
        assert_eq!(settings::load_shared_settings(&vault).theme, "sj_d");
    }

    /// 가드: 아무것도 고르지 않으면 거부한다(파일을 열지도 않는다).
    #[test]
    fn nothing_selected_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let err = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &tmp.path().join("없는파일.zip"),
            RestoreSelection {
                settings: false,
                plugins: false,
            },
        )
        .unwrap_err();
        assert!(err.starts_with(ERR_NOTHING_SELECTED));
    }

    /// 가드: 상태 파일이 **없는** 백업은 빌트인 토글·무시 목록을 지우지 않는다 —
    /// "백업에 담기지 않았다"는 "지금 것을 지우라"가 아니다(복원은 더하기만 한다).
    #[test]
    fn backup_without_state_file_keeps_local_builtin_prefs() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        // 상태 엔트리만 뺀 백업을 다시 만든다(손으로 만든 부분 백업 흉내).
        let original = std::fs::read(&dest).unwrap();
        let mut src = zip::ZipArchive::new(std::io::Cursor::new(original)).unwrap();
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        let names: Vec<String> = src.file_names().map(|s| s.to_string()).collect();
        for name in names {
            if name == STATE_ENTRY {
                continue;
            }
            let mut entry = src.by_name(&name).unwrap();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            out.start_file(&name, opts).unwrap();
            out.write_all(&buf).unwrap();
        }
        let partial = tmp.path().join("partial.zip");
        std::fs::write(&partial, out.finish().unwrap().into_inner()).unwrap();

        import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &partial,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();

        let state = plugins::load_state(&app_data);
        assert_eq!(
            state.builtins.get("word-count"),
            Some(&false),
            "빌트인 토글이 지워지면 안 된다"
        );
        assert_eq!(state.dismissed_missing, vec!["ghost".to_string()]);
        // 코드가 복원된 플러그인은 신규 설치와 같은 기본값(켜짐)으로 들어온다.
        assert!(state.plugins["alpha"].enabled);
        assert!(state.plugins["alpha"].granted.is_empty());
    }

    /// 가드: 백업이 아닌 파일(그냥 zip·그냥 텍스트)은 코드로 구분되는 오류로 거부된다.
    #[test]
    fn non_backup_files_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");

        let text = tmp.path().join("메모.txt");
        std::fs::write(&text, "백업 아님").unwrap();
        assert!(inspect_backup_file(&text)
            .unwrap_err()
            .starts_with(ERR_NOT_A_BACKUP));

        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zw.start_file("hello.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"hi").unwrap();
        let plain = tmp.path().join("plain.zip");
        std::fs::write(&plain, zw.finish().unwrap().into_inner()).unwrap();
        assert!(inspect_backup_file(&plain)
            .unwrap_err()
            .starts_with(ERR_NOT_A_BACKUP));

        // 없는 파일은 읽기 실패로 구분된다.
        assert!(inspect_backup_file(&tmp.path().join("ghost.zip"))
            .unwrap_err()
            .starts_with(ERR_READ_FAILED));

        // 복원 경로도 같은 판단을 한다(그리고 스냅샷을 만들지 않는다 — 시작조차 하지 않는다).
        let err = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &plain,
            RestoreSelection {
                settings: true,
                plugins: true,
            },
        )
        .unwrap_err();
        assert!(err.starts_with(ERR_NOT_A_BACKUP));
        assert!(!snapshot_dir(&vault).exists());
    }

    /// 가드: 더 새로운 스키마는 미리보기에선 `supported: false`, 복원에선 거부된다.
    #[test]
    fn future_schema_is_previewable_but_not_restorable() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zw.start_file(META_ENTRY, zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(
            serde_json::to_vec(&BackupMeta {
                schema_version: SCHEMA_VERSION + 7,
                app_version: "99.0.0".to_string(),
                created_at: 1_700_000_000_000,
                platform: "macos".to_string(),
                plugins: Vec::new(),
            })
            .unwrap()
            .as_slice(),
        )
        .unwrap();
        let future = tmp.path().join("future.zip");
        std::fs::write(&future, zw.finish().unwrap().into_inner()).unwrap();

        let summary = inspect_backup_file(&future).expect("미리보기는 된다");
        assert!(!summary.supported);
        assert_eq!(summary.app_version, "99.0.0");

        let err = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &future,
            RestoreSelection {
                settings: true,
                plugins: true,
            },
        )
        .unwrap_err();
        assert!(err.starts_with(ERR_UNSUPPORTED));
    }

    /// 가드: 경로를 탈출하려는 엔트리(`../`)는 해제 단계에서 막힌다 —
    /// 설치 경로와 같은 방어 함수를 쓴다는 사실을 고정한다.
    #[test]
    fn path_traversal_entry_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file(META_ENTRY, opts).unwrap();
        zw.write_all(
            serde_json::to_vec(&BackupMeta {
                schema_version: SCHEMA_VERSION,
                app_version: "1.0.0".to_string(),
                created_at: 0,
                platform: "windows".to_string(),
                plugins: Vec::new(),
            })
            .unwrap()
            .as_slice(),
        )
        .unwrap();
        zw.start_file("../탈출.txt", opts).unwrap();
        zw.write_all(b"evil").unwrap();
        let evil = tmp.path().join("evil.zip");
        std::fs::write(&evil, zw.finish().unwrap().into_inner()).unwrap();

        let err = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &evil,
            RestoreSelection {
                settings: true,
                plugins: true,
            },
        )
        .unwrap_err();
        assert!(err.starts_with(ERR_CORRUPT), "실제 오류: {err}");
        assert!(!tmp.path().join("탈출.txt").exists());
        assert!(!app_data.join("backup-staging").exists());
    }

    /// 가드: 복원 전에 현재 상태가 vault에 스냅샷되고, 그 스냅샷으로 되돌릴 수 있다.
    #[test]
    fn snapshot_before_import_can_undo_the_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        // 백업을 만든 뒤 테마를 바꾼다 — 이것이 "복원 직전의 현재 상태"다.
        let current = SharedSettings {
            theme: "지금-테마".to_string(),
            ..SharedSettings::default()
        };
        settings::save_shared_settings(&vault, &current).unwrap();

        let outcome = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            1_700_000_000_000,
            &dest,
            RestoreSelection {
                settings: true,
                plugins: false,
            },
        )
        .unwrap();
        assert_eq!(settings::load_shared_settings(&vault).theme, "내-테마");

        // 스냅샷을 다시 가져오면 복원 직전 상태로 돌아온다.
        let snapshot = PathBuf::from(&outcome.report.snapshot_path);
        assert!(snapshot.is_file());
        import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            1_700_000_001_000,
            &snapshot,
            RestoreSelection {
                settings: true,
                plugins: false,
            },
        )
        .unwrap();
        assert_eq!(settings::load_shared_settings(&vault).theme, "지금-테마");
    }

    /// 가드: 스냅샷은 최근 것 [`MAX_SNAPSHOTS`]개만 남는다(동기화 폴더에 무한히 쌓이지 않게).
    #[test]
    fn snapshots_are_pruned_to_the_recent_few() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        for i in 0..(MAX_SNAPSHOTS + 3) {
            write_snapshot(
                &app_data,
                &vault,
                &prefs(),
                "1.0.0",
                1_700_000_000_000 + (i as i64) * 60_000,
            )
            .unwrap();
        }
        let kept: Vec<_> = std::fs::read_dir(snapshot_dir(&vault))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(kept.len(), MAX_SNAPSHOTS);
    }

    /// 가드: 복원은 더하기만 한다 — 백업에 없는 로컬 플러그인은 그대로 남는다.
    #[test]
    fn restore_never_removes_unrelated_local_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        make_plugin(&app_data, "bravo"); // 백업 이후에 설치한 다른 플러그인.
        import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &dest,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();
        assert!(
            plugins::plugins_dir(&app_data).join("bravo").is_dir(),
            "백업에 없던 플러그인을 지우면 안 된다"
        );
        assert!(plugins::plugins_dir(&app_data).join("alpha").is_dir());
    }

    /// 가드: 깨진 플러그인 폴더는 백업에 담기지 않고(정직한 목록), 복원도 나머지를 막지 않는다.
    #[test]
    fn broken_plugin_dir_is_skipped_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let broken = plugins::plugins_dir(&app_data).join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("manifest.json"), "{ 깨진 JSON").unwrap();

        let dest = tmp.path().join("b.zip");
        let summary = write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();
        assert_eq!(summary.plugins.len(), 1);
        assert_eq!(summary.plugins[0].id, "alpha");
    }

    /// 가드: 기본 파일 이름과 스냅샷 이름이 UTC 날짜로 만들어진다(에폭 0과 실제 날짜 둘 다).
    #[test]
    fn file_names_use_utc_date() {
        assert_eq!(default_file_name(0), "note-rang-backup-1970-01-01.zip");
        assert_eq!(utc_parts(0), (1970, 1, 1, 0, 0, 0));

        let ms = 1_786_755_723_000; // 2026-08-15T01:02:03Z
        assert_eq!(utc_parts(ms), (2026, 8, 15, 1, 2, 3));
        assert_eq!(default_file_name(ms), "note-rang-backup-2026-08-15.zip");
        assert_eq!(snapshot_file_name(ms), "before-import-20260815-010203.zip");
    }

    /// 가드: 백업의 플러그인 코드가 불완전해 설치가 실패해도 **기존 설치본이 사라지지 않는다**.
    ///
    /// 옛 순서(지우고 → 설치)는 entry가 빠진 백업 하나로 멀쩡히 돌아가던 플러그인을 잃었다.
    #[test]
    fn failed_plugin_restore_keeps_the_existing_install() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        // entry 파일이 빠진 백업(내보내기 상한에 걸린 큰 플러그인·손으로 자른 zip과 같은 모양).
        let broken = tmp.path().join("broken.zip");
        rewrite_archive(&dest, &broken, |name, buf| {
            (name != "plugins/code/alpha/main.js").then_some(buf)
        });

        // 그 사이 사용자가 쓰던 코드 — 복원이 지우면 안 되는 것.
        let installed = plugins::plugins_dir(&app_data).join("alpha");
        std::fs::write(installed.join("main.js"), "// 지금 쓰는 코드").unwrap();

        let outcome = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &broken,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();

        assert_eq!(outcome.report.plugins_failed, vec!["alpha".to_string()]);
        assert_eq!(outcome.report.plugins_restored, 0);
        assert_eq!(
            std::fs::read_to_string(installed.join("main.js")).unwrap(),
            "// 지금 쓰는 코드",
            "설치 실패가 기존 코드를 지우면 안 된다"
        );
        // 코드가 멀쩡하니 부여도 그대로 유효하다(유령 레코드가 아니다).
        assert_eq!(
            plugins::load_state(&app_data).plugins["alpha"].granted,
            vec!["notes:read".to_string()]
        );
    }

    /// 가드: 복원에 실패했고 **이 기기에 코드도 없는** id는 부여를 잃는다 —
    /// 코드 없는 레코드에 부여가 남으면 나중 설치가 승인 화면 없이 특권을 되살린다.
    #[test]
    fn failed_plugin_without_code_loses_its_grants() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();
        let broken = tmp.path().join("broken.zip");
        rewrite_archive(&dest, &broken, |name, buf| {
            (name != "plugins/code/alpha/main.js").then_some(buf)
        });

        // 코드만 사라지고 레코드는 남은 상태(유령 레코드).
        std::fs::remove_dir_all(plugins::plugins_dir(&app_data).join("alpha")).unwrap();

        import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &broken,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();

        let record = &plugins::load_state(&app_data).plugins["alpha"];
        assert!(
            record.granted.is_empty(),
            "코드 없는 레코드에 부여가 남았다"
        );
        assert!(record.pending_reserved.is_empty());
        assert!(
            record.settings.contains_key("k"),
            "설정 값까지 지울 이유는 없다(재설치 시 선호를 지킨다)"
        );
    }

    /// 가드: 환경설정 조각이 깨진 백업은 **디스크를 건드리기 전에** 거부된다 —
    /// 실패했다고 안내하면서 공유 설정만 몰래 바뀌어 앱 메모리와 갈라지면 안 된다.
    #[test]
    fn corrupt_prefs_aborts_before_writing_shared_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();
        let broken = tmp.path().join("broken.zip");
        rewrite_archive(&dest, &broken, |name, buf| {
            Some(if name == PREFS_ENTRY {
                "{ 깨진 JSON".as_bytes().to_vec()
            } else {
                buf
            })
        });

        // 복원 직전의 현재 설정(그대로 남아야 한다).
        let current = SharedSettings {
            theme: "지금-테마".to_string(),
            ..SharedSettings::default()
        };
        settings::save_shared_settings(&vault, &current).unwrap();

        let err = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &broken,
            RestoreSelection {
                settings: true,
                plugins: false,
            },
        )
        .unwrap_err();
        assert!(err.starts_with(ERR_CORRUPT), "실제 오류: {err}");
        assert_eq!(
            settings::load_shared_settings(&vault).theme,
            "지금-테마",
            "실패한 복원이 디스크를 바꾸면 안 된다"
        );
    }

    /// 가드(치명 회귀): 시작 흐름·정렬 필드가 **없던 구버전 백업**도 그대로 복원된다 —
    /// 두 필드만 기본값이 되고 나머지는 정상적으로 들어온다.
    ///
    /// 왜 이 테스트가 필요한가: [`import_backup_file`]은 `local-prefs.json` 파싱 실패를
    /// [`ERR_CORRUPT`]로 승격시켜 **복원 전체를 중단**한다. `PortablePrefs`의 새 필드에
    /// `#[serde(default)]`를 빠뜨리면 이 앱으로 올리기 전에 만든 백업이 전부 "깨진 백업"이
    /// 되어, 설정도 플러그인도 하나도 되돌릴 수 없게 된다.
    #[test]
    fn legacy_prefs_without_new_fields_still_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();
        // 구버전이 쓰던 모양 그대로 — 자동 실행·전역 단축키 두 필드뿐.
        let legacy = tmp.path().join("legacy.zip");
        rewrite_archive(&dest, &legacy, |name, buf| {
            Some(if name == PREFS_ENTRY {
                br#"{"launch_at_login":true,"global_hotkey":"CmdOrCtrl+Alt+M"}"#.to_vec()
            } else {
                buf
            })
        });

        let outcome = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &legacy,
            RestoreSelection {
                settings: true,
                plugins: false,
            },
        )
        .expect("구버전 백업도 복원돼야 한다");

        let restored = outcome.prefs.expect("환경설정 조각이 복원돼야 한다");
        assert!(restored.launch_at_login);
        assert_eq!(
            restored.startup_no_active_action,
            settings::STARTUP_NO_ACTIVE_PANEL,
            "없던 필드는 기본값으로"
        );
        assert_eq!(restored.panel_sort, settings::PANEL_SORT_DEFAULT);
    }

    /// 가드: 시계가 뒤로 가도 **방금 쓴 스냅샷**은 자기 정리에 지워지지 않는다 —
    /// `ImportReport.snapshot_path`가 없는 파일을 가리키면 되돌릴 길이 사라진 것과 같다.
    #[test]
    fn snapshot_pruning_never_deletes_the_one_just_written() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        for i in 0..MAX_SNAPSHOTS {
            write_snapshot(
                &app_data,
                &vault,
                &prefs(),
                "1.0.0",
                1_700_000_000_000 + (i as i64) * 60_000,
            )
            .unwrap();
        }
        // 시계가 크게 뒤로 간다(NTP 보정·수동 조정·시계가 앞선 다른 기기의 스냅샷 혼입).
        let dest = write_snapshot(&app_data, &vault, &prefs(), "1.0.0", 1_600_000_000_000).unwrap();
        assert!(dest.is_file(), "방금 쓴 스냅샷이 지워지면 안 된다");
        let kept = std::fs::read_dir(snapshot_dir(&vault)).unwrap().count();
        assert_eq!(kept, MAX_SNAPSHOTS);
    }

    /// 가드: 같은 초에 두 번 스냅샷해도 앞의 것을 덮어쓰지 않는다(이름 해상도가 초라서).
    #[test]
    fn snapshots_in_the_same_second_do_not_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        let first =
            write_snapshot(&app_data, &vault, &prefs(), "1.0.0", 1_700_000_000_000).unwrap();
        let second =
            write_snapshot(&app_data, &vault, &prefs(), "1.0.0", 1_700_000_000_000).unwrap();
        assert_ne!(first, second);
        assert!(first.is_file() && second.is_file());
    }

    /// 가드: entry 파일을 담지 못한 플러그인은 백업 목록에서 빠진다 —
    /// 복원 관문이 반드시 거부할 항목을 "포함"이라고 보고하지 않는다.
    #[test]
    fn plugin_without_entry_file_is_left_out_of_the_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        // entry가 상한(2MB)에 걸려 담기지 않은 상황과 같은 모양.
        std::fs::remove_file(
            plugins::plugins_dir(&app_data)
                .join("alpha")
                .join("main.js"),
        )
        .unwrap();

        let dest = tmp.path().join("b.zip");
        let summary = write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();
        assert!(
            summary.plugins.is_empty(),
            "복원할 수 없는 플러그인을 목록에 담으면 안 된다"
        );
    }

    /// 가드: 저장소 파일은 형식·상한·설치 여부를 통과한 것만 복원된다(고아 파일 방지).
    #[test]
    fn storage_restore_skips_uninstalled_and_oversized() {
        let tmp = tempfile::tempdir().unwrap();
        let (app_data, vault) = make_device(tmp.path(), "alpha");
        // 설치되지 않은 id의 저장소 파일을 심는다 — 백업에는 담기지만 복원되지 않아야 한다.
        std::fs::write(
            plugin_storage::storage_dir(&app_data).join("ghost.json"),
            r#"{"x":1}"#,
        )
        .unwrap();
        let dest = tmp.path().join("b.zip");
        write_backup(&app_data, &vault, &prefs(), "1.0.0", 0, &dest).unwrap();

        std::fs::remove_dir_all(plugin_storage::storage_dir(&app_data)).unwrap();
        let outcome = import_backup_file(
            &app_data,
            &vault,
            &prefs(),
            "1.0.0",
            0,
            &dest,
            RestoreSelection {
                settings: false,
                plugins: true,
            },
        )
        .unwrap();
        let storage = plugin_storage::storage_dir(&app_data);
        assert!(storage.join("alpha.json").is_file());
        assert!(!storage.join("ghost.json").exists(), "설치되지 않은 id");
        assert_eq!(outcome.report.storage_restored, 2); // alpha + builtin/clock
    }
}
