//! vault 동기화 플러그인 참조 목록(`<vault>/.memo/installed-plugins.json`) + 재조정 diff.
//!
//! 역할: 설치/제거 시 `{id, name, version, source}`만 담는 참조용 목록을 원자적으로
//! upsert/삭제하고, vault 목록 vs 로컬 설치를 비교해 "이 기기에 코드가 없는" 항목을 계산한다.
//! 왜: 목록은 동기화되지만 **enable·권한 부여(granted)는 절대 싣지 않는다** — 동기화 파일을
//! 변조해도 특권이 새지 않도록 신뢰 경계를 로컬(`plugins-state.json`)에 둔다. 이 파일은
//! "어떤 플러그인을 쓰는지"의 참조일 뿐이며, 새 기기에서는 재설치 + 재승인이 필요하다.

use crate::io::{read_to_string, write_atomic};
use crate::plugins::PluginSource;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// vault 목록 파일의 읽기-수정-쓰기를 직렬화하는 잠금.
///
/// 왜 필요한가: [`upsert_entry`]·[`remove_entry`]는 **load → 수정 → save**의 3단계인데, 이를
/// 부르는 커맨드(`plugin_commands::remove_plugin`·`plugin_install::confirm_install`·백업 복원의
/// `record_vault_entries`)는 전부 `#[tauri::command(async)]`라 서로 다른 스레드에서 진짜로
/// 병행 실행된다. 잠금이 없으면 두 쓰기가 서로의 load 결과를 덮어써 **먼저 쓴 변경이 조용히
/// 사라진다**(lost update): 플러그인 A·B를 잇달아 제거하면 하나가 목록에 남아 다른 기기의
/// 재조정 안내가 방금 지운 것을 다시 설치하라고 권하고, 설치와 제거가 겹치면 반대로 방금
/// 설치한 항목이 목록에서 통째로 빠진다. `write_atomic`은 rename으로 갈아 끼워 **부분 손상**만
/// 막을 뿐 이 lost update는 막지 못한다.
///
/// 파일 단위가 아니라 모듈 단위 잠금인 이유는 [`crate::plugins`]의 `STATE_LOCK`·
/// [`crate::plugin_storage`]의 `STORAGE_LOCK`과 같다 — 목록 파일은 하나뿐이고 작아 경합
/// 비용이 무의미하다. 잠금이 함수 **안**에 있으므로 호출부는 아무것도 하지 않아도 보호된다.
static VAULT_LIST_LOCK: Mutex<()> = Mutex::new(());

/// [`VAULT_LIST_LOCK`]을 잡고 읽기-수정-쓰기 하나를 수행한다.
///
/// 읽기 전용 경로([`load_vault_list`])는 잠그지 않는다: `write_atomic`이 rename으로 갈아
/// 끼우므로 읽는 쪽은 **옛 파일 아니면 새 파일**을 보고 중간 상태를 보지 않는다.
///
/// 중독된 잠금도 그대로 이어 쓴다 — 각 쓰기가 파일 전체를 원자적으로 갈아 끼우므로
/// "반쯤 쓰다 만 상태"가 남지 않는다(`plugins::with_state_lock`과 같은 근거).
fn with_list_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = VAULT_LIST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// vault 목록 스키마 버전(형식이 바뀌면 올린다).
const VAULT_LIST_SCHEMA_VERSION: u32 = 1;

/// serde 기본값 헬퍼 — schema_version이 없는 파일도 현재 버전으로 읽는다.
fn default_schema_version() -> u32 {
    VAULT_LIST_SCHEMA_VERSION
}

/// vault 목록 한 항목 — 참조용 메타만(활성·부여 없음: 동기화로 특권이 오지 않게).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultPluginEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: PluginSource,
}

/// vault 목록 파일 전체(`installed-plugins.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultPluginList {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub plugins: Vec<VaultPluginEntry>,
}

impl Default for VaultPluginList {
    /// 빈 목록을 현재 스키마 버전으로 만든다(파일 없음/깨짐 폴백).
    fn default() -> Self {
        VaultPluginList {
            schema_version: VAULT_LIST_SCHEMA_VERSION,
            plugins: Vec::new(),
        }
    }
}

/// vault 목록 파일 경로(`<vault>/.memo/installed-plugins.json`).
fn vault_list_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".memo").join("installed-plugins.json")
}

/// vault 목록을 읽는다. 파일이 없거나 깨졌으면 빈 목록(동기화 파일은 신뢰하지 않고 관용 파싱).
pub fn load_vault_list(vault_root: &Path) -> VaultPluginList {
    read_to_string(&vault_list_path(vault_root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// vault 목록을 id 정렬로 원자적으로 쓴다(동기화 diff가 안정적이도록 결정적 직렬화).
fn save_vault_list(vault_root: &Path, list: &mut VaultPluginList) -> io::Result<()> {
    list.plugins.sort_by(|a, b| a.id.cmp(&b.id));
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    write_atomic(&vault_list_path(vault_root), &json)
}

/// 목록에 항목을 추가하거나(같은 id면) 교체한다 — 설치/업데이트 확정 시 호출.
///
/// load→save 전체가 [`with_list_lock`] 안에서 일어난다(병행 호출이 서로를 덮어쓰지 않게).
pub fn upsert_entry(vault_root: &Path, entry: VaultPluginEntry) -> io::Result<()> {
    with_list_lock(|| {
        let mut list = load_vault_list(vault_root);
        list.plugins.retain(|p| p.id != entry.id);
        list.plugins.push(entry);
        save_vault_list(vault_root, &mut list)
    })
}

/// 목록에서 id 항목을 삭제한다 — 제거 시 호출. 항목이 없으면 파일을 만들지도 쓰지도 않는다.
///
/// load→save 전체가 [`with_list_lock`] 안에서 일어난다([`upsert_entry`]와 같은 이유).
pub fn remove_entry(vault_root: &Path, id: &str) -> io::Result<()> {
    with_list_lock(|| {
        let mut list = load_vault_list(vault_root);
        let before = list.plugins.len();
        list.plugins.retain(|p| p.id != id);
        if list.plugins.len() == before {
            return Ok(());
        }
        save_vault_list(vault_root, &mut list)
    })
}

/// 재조정 diff — vault 목록에는 있는데 이 기기에 설치돼 있지 않고, 무시하지도 않은 항목.
///
/// 역할: 설정 창의 비차단 안내([설치]/[제거]/[무시]) 대상 계산. 순수 함수로 분리해 테스트한다.
pub fn missing_entries(
    list: &VaultPluginList,
    installed_ids: &[String],
    dismissed: &[String],
) -> Vec<VaultPluginEntry> {
    list.plugins
        .iter()
        .filter(|p| !installed_ids.contains(&p.id) && !dismissed.contains(&p.id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트용 항목을 만든다.
    fn entry(id: &str, version: &str) -> VaultPluginEntry {
        VaultPluginEntry {
            id: id.to_string(),
            name: format!("{id} 이름"),
            version: version.to_string(),
            source: PluginSource::Url {
                url: format!("https://example.com/{id}.zip"),
            },
        }
    }

    /// 가드: upsert가 새 항목을 추가하고 같은 id는 교체하며, id 정렬을 유지한다(왕복).
    #[test]
    fn upsert_adds_replaces_and_sorts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        upsert_entry(vault, entry("zeta", "1.0.0")).unwrap();
        upsert_entry(vault, entry("alpha", "1.0.0")).unwrap();
        upsert_entry(vault, entry("zeta", "2.0.0")).unwrap(); // 교체(중복 금지).

        let list = load_vault_list(vault);
        assert_eq!(list.schema_version, 1);
        assert_eq!(list.plugins.len(), 2);
        assert_eq!(list.plugins[0].id, "alpha");
        assert_eq!(list.plugins[1].id, "zeta");
        assert_eq!(list.plugins[1].version, "2.0.0");
    }

    /// 가드: 원자적 쓰기 — 저장 후 임시 파일(.tmp)이 남지 않는다.
    #[test]
    fn save_leaves_no_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        upsert_entry(vault, entry("p", "1.0.0")).unwrap();
        let memo_dir = vault.join(".memo");
        let leftovers: Vec<_> = std::fs::read_dir(&memo_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .collect();
        assert!(leftovers.is_empty(), "임시 파일이 남으면 안 된다");
    }

    /// 가드: remove가 항목을 지우고, 없는 id는 파일을 건드리지 않는다(파일 생성도 없음).
    #[test]
    fn remove_deletes_entry_and_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        // 파일이 없을 때 없는 id 제거 → 파일이 생기지 않는다.
        remove_entry(vault, "ghost").unwrap();
        assert!(!vault_list_path(vault).exists());

        upsert_entry(vault, entry("p", "1.0.0")).unwrap();
        remove_entry(vault, "p").unwrap();
        assert!(load_vault_list(vault).plugins.is_empty());
    }

    /// 가드: 파일이 없거나 깨졌으면 빈 목록으로 폴백한다(동기화 파일 관용 파싱).
    #[test]
    fn load_falls_back_on_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(load_vault_list(vault).plugins.is_empty());

        write_atomic(&vault_list_path(vault), "{ not json").unwrap();
        assert!(load_vault_list(vault).plugins.is_empty());
    }

    /// 가드: 목록 항목에는 부여(granted)·활성(enabled)이 직렬화되지 않는다 —
    /// 동기화 파일로 특권이 이동하지 않아야 한다는 신뢰 모델을 형태로 고정.
    #[test]
    fn serialized_entry_has_no_grant_or_enable() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        upsert_entry(vault, entry("p", "1.0.0")).unwrap();
        let raw = read_to_string(&vault_list_path(vault)).unwrap();
        assert!(!raw.contains("granted"));
        assert!(!raw.contains("enabled"));
        assert!(raw.contains("\"source\""));
    }

    /// 가드: 여러 스레드가 동시에 upsert해도 **하나도 유실되지 않는다**(lost update 방어).
    ///
    /// 잠금이 없으면 각 스레드가 같은 목록을 읽고 자기 항목만 더해 쓰므로 마지막 쓰기만
    /// 살아남는다 — 병행 커맨드(`confirm_install`·`remove_plugin`·백업 복원)가 실제로 만드는
    /// 상황이다.
    #[test]
    fn concurrent_upserts_keep_every_entry() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        const THREADS: usize = 4;
        const PER_THREAD: usize = 10;
        std::thread::scope(|scope| {
            for t in 0..THREADS {
                scope.spawn(move || {
                    for i in 0..PER_THREAD {
                        upsert_entry(vault, entry(&format!("p{t}-{i}"), "1.0.0"))
                            .expect("동시 upsert가 실패하면 안 된다");
                    }
                });
            }
        });

        let list = load_vault_list(vault);
        assert_eq!(
            list.plugins.len(),
            THREADS * PER_THREAD,
            "유실된 항목이 있다"
        );
    }

    /// 가드: 동시에 추가·삭제해도 목록 파일이 깨지지 않고, 삭제 대상만 정확히 빠진다.
    #[test]
    fn concurrent_upsert_and_remove_never_corrupt_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        upsert_entry(vault, entry("keep", "1.0.0")).unwrap();

        std::thread::scope(|scope| {
            scope.spawn(|| {
                for i in 0..30 {
                    upsert_entry(vault, entry("churn", &format!("1.0.{i}"))).unwrap();
                }
            });
            scope.spawn(|| {
                for _ in 0..30 {
                    remove_entry(vault, "churn").unwrap();
                }
            });
        });

        let list = load_vault_list(vault);
        assert!(
            list.plugins.iter().any(|p| p.id == "keep"),
            "경합과 무관한 항목이 사라지면 안 된다"
        );
        assert!(list.plugins.len() <= 2, "목록이 깨지거나 중복되면 안 된다");
    }

    /// 가드: 재조정 diff — 설치된 id와 무시한 id는 빠지고 나머지만 남는다.
    #[test]
    fn missing_entries_filters_installed_and_dismissed() {
        let list = VaultPluginList {
            schema_version: 1,
            plugins: vec![entry("a", "1"), entry("b", "1"), entry("c", "1")],
        };
        let installed = ["a".to_string()]; // a는 설치됨.
        let dismissed = ["c".to_string()]; // c는 무시함.
        let missing = missing_entries(&list, &installed, &dismissed);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, "b");
    }
}
