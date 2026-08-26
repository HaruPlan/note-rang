//! 플러그인 영속 저장소(`memo.storage.local.*`) — 매니페스트 설정 스키마와 무관한 자유 KV.
//!
//! 역할: 지금 플러그인이 값을 저장하는 유일한 길은 `settings.set`인데, 그건
//! 매니페스트에 선언한 스키마 키만 허용하고 설정 화면에 폼으로 노출되는 **사용자 대면** 값이다.
//! 캐시·마지막 사용 시각·세션 토큰 같은 **내부 상태**를 둘 곳이 없었다. Obsidian
//! `loadData`/`saveData`, Figma `clientStorage`, Raycast `LocalStorage`가 하는 역할을 준다.
//!
//! 스코프 3종 중 이 모듈이 다루는 것은
//! **`local`(영속) 하나뿐이다**: `session`(중앙 호스트 프로세스 메모리 수명)과
//! `window`(창 컨텍스트 토큰 수명)은 디스크에 닿을 이유가 없어 프론트 중앙 호스트가 메모리
//! Map으로 직접 관리한다(다음 단계 — 브리지 배선 담당). 이 모듈은 그 셋 중 파일시스템을
//! 요구하는 경우만 구현한다.
//!
//! 격리: 플러그인 A가 플러그인 B의 저장소를 읽지 못하도록 **플러그인마다 별도 파일**로
//! 나누고(한 파일에 몰아넣지 않는다 — 그러면 무관한 플러그인끼리 파일 하나를 두고 쓰기
//! 경합한다), 사이드로드(설치)와 번들(빌트인)은 **같은 id를 쓸 수 있으므로**(`plugins.rs`의
//! `PluginsState`가 `plugins`/`builtins`를 별도 맵으로 나누는 것과 같은 이유) 하위 폴더로
//! 네임스페이스를 분리한다.
//!
//! 저장 위치 판단: `<app_data>/plugin-storage/`(vault가 아니라 앱데이터) — `plugins-state.json`
//! (활성·권한·설정값)과 같은 원칙이다. 이 값은 "그 기기의 그 플러그인 설치"에 속한 내부
//! 상태이지 노트 콘텐츠가 아니므로 vault 동기화 대상이 아니다(동기화하면 다른 기기의 같은
//! 플러그인이 캐시·세션 토큰을 서로 덮어써 오히려 해롭다).
//!
//! 동기 커맨드 금지: 디스크 IO를 감싸는 Tauri 커맨드는 전부 `#[tauri::command(async)]`로
//! 등록한다(`plugin_commands.rs`) — 이 리포에 동기 커맨드가 메인 스레드를 막아 앱이 얼었던
//! 전례가 있다(다이얼로그 사례, `plugin_commands::pick_plugin_dir`의 문서 참고).

use crate::io::{read_to_string, write_atomic};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 플러그인 하나의 저장소를 표현하는 맵(키 → 임의 JSON 값).
pub type StorageMap = BTreeMap<String, serde_json::Value>;

/// 파일당 저장소 용량 상한(바이트, 압축 JSON 기준) — 초과 시 조용한 truncate 대신 오류로
/// 거부한다. 무한히 쓸 수 있으면 악의적이거나 버그가 있는 플러그인 하나가 디스크를 채운다.
pub const MAX_STORAGE_BYTES: usize = 256 * 1024;

/// 용량 초과 오류 문자열의 정본 접두어.
///
/// 왜: 이 크레이트의 Tauri 커맨드는 전부 `Result<T, String>`이라 브리지 실행기(다음 단계 —
/// `central-host.ts`)가 오류를 `code: "QUOTA_EXCEEDED"`로 분류하려면 문자열을 봐야 한다.
/// `plugins.rs`가 "선언되지 않은 설정 키: "를 정본 접두어로 쓰고 `central-host.ts`가 그
/// 문자열로 `setting-key-undeclared` 진단을 분기하는 것과 같은 관례를 여기서도 따른다.
pub const QUOTA_EXCEEDED_PREFIX: &str = "저장소 용량 초과";

/// 저장소 루트(`<app_data>/plugin-storage`).
pub fn storage_dir(app_data: &Path) -> PathBuf {
    app_data.join("plugin-storage")
}

/// 설치(사이드로드) 플러그인 저장소 파일 경로.
fn installed_path(app_data: &Path, id: &str) -> PathBuf {
    storage_dir(app_data).join(format!("{id}.json"))
}

/// 빌트인(번들) 플러그인 저장소 파일 경로 — 설치 플러그인과 id 네임스페이스가 겹치지 않게
/// 하위 폴더로 분리한다(모듈 문서의 "격리" 절 참고).
fn builtin_path(app_data: &Path, id: &str) -> PathBuf {
    storage_dir(app_data)
        .join("builtin")
        .join(format!("{id}.json"))
}

/// 플러그인 id 형식 검증 — `plugins::is_valid_id`(소문자·숫자·`._-`, 첫 글자 영숫자)와
/// **동일 규칙**을 복제한 것이다.
///
/// 왜 복제인가: 원본이 `plugins.rs`의 비공개 함수이고 그 파일은 이 작업의 소유 밖이다
/// (다른 에이전트가 동시에 수정할 수 있다 — 절대 규칙 1). `pub`으로 바꿔 달라고 요청하는
/// 대신, 검증 "규칙"만 그대로 복제해 소유 경계를 지킨다. 경로 조합 직전에 이 검증을 거치므로
/// `..`·`/`·`\` 등 경로 탈출 문자를 가진 id는 파일 경로에 닿기 전에 걸러진다.
fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// 저장소 키 형식 검증 — 비어있지 않고, 200 코드포인트 이내이며, JS 예약 키를 거부한다.
///
/// 왜: 값은 결국 `Object.create(null)`이 아니라 **일반 JS 객체**(`memo.storage.local.get`이
/// 플러그인 코드에 돌려주는 순수 데이터)로 소비될 수 있으므로 `__proto__`/`constructor`/
/// `prototype`는 그 경계를 넘어오기 전에 막는다(`plugins::is_valid_setting_key`와 같은
/// 방어 목적, 다만 저장소 키는 사용자 대면 폼이 아니라 플러그인 내부 키라 문자 집합을
/// camelCase로 좁힐 이유가 없어 형식 자체는 더 자유롭게 둔다). 길이 상한은 키 자체로
/// 용량을 낭비하는 것을 막는다(값 상한과 별개).
fn is_valid_storage_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= 200
        && !matches!(key, "__proto__" | "constructor" | "prototype")
}

/// 저장소 파일을 읽는다. 없거나 깨졌으면(비UTF-8·JSON 파싱 실패 등) 빈 맵으로 취급한다 —
/// `plugins::load_state`와 같은 관용구(손상된 로컬 캐시가 앱을 막지 않게).
fn load(path: &Path) -> StorageMap {
    read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 저장소 맵을 원자적으로 쓴다 — 쓰기 전 직렬화 크기를 검사해 상한 초과분은 디스크에
/// 닿지 않는다(부분 기록·조용한 truncate 둘 다 없음).
fn save(path: &Path, map: &StorageMap) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    if json.len() > MAX_STORAGE_BYTES {
        return Err(format!(
            "{QUOTA_EXCEEDED_PREFIX}: {}바이트(상한 {MAX_STORAGE_BYTES}바이트)",
            json.len()
        ));
    }
    write_atomic(path, &json).map_err(|e| e.to_string())
}

/// 쓰기(읽기-수정-쓰기)를 직렬화하는 잠금.
///
/// 왜 필요한가: 이 모듈의 쓰기는 전부 **load → 맵 한 칸 수정 → save**의 3단계다. 이것을
/// 감싸는 Tauri 커맨드는 전부 `#[tauri::command(async)]`라(모듈 문서의 "동기 커맨드 금지")
/// 서로 다른 스레드에서 진짜로 병행 실행된다 — 기존 `plugins::set_setting`이 동기 커맨드라
/// 메인 스레드에서 자동 직렬화되던 보호가 여기에는 없다. 잠금이 없으면 두 쓰기가 서로의
/// load 결과를 덮어써 **먼저 쓴 키가 조용히 사라지고**(lost update), 임시 파일명이
/// `<path>.tmp` 고정값이라 rename이 ENOENT로 실패하기도 한다(2 스레드 × 50키 테스트에서
/// 100% 재현). 파일 단위가 아니라 모듈 단위 잠금인 이유: 저장소 쓰기는 드물고 파일이 작아
/// 경합 비용이 무의미한 반면, id별 잠금 맵은 그 맵 자체의 수명·정리 문제를 새로 만든다.
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

/// [`STORAGE_LOCK`]을 잡고 읽기-수정-쓰기 하나를 수행한다.
///
/// 읽기 전용 경로(`get`·`get_all`)는 잠그지 않는다: `write_atomic`이 rename으로 갈아 끼우므로
/// 읽는 쪽은 **옛 파일 아니면 새 파일**을 보고 중간 상태를 보지 않는다.
fn with_storage_lock<T>(f: impl FnOnce() -> T) -> T {
    // 중독된 잠금(임계구역에서 다른 스레드가 패닉)도 그대로 이어 쓴다 — 각 쓰기가 파일
    // 전체를 원자적으로 갈아 끼우므로 "반쯤 쓰다 만 상태"가 남지 않는다.
    let _guard = STORAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// 설치된 플러그인인지 확인한다(디렉터리 존재 — `plugins.rs`의 `set_setting`과 같은 관용구).
///
/// 왜: 저장소는 설정과 달리 매니페스트 스키마를 읽지 않지만(자유 KV), 설치된 적 없는 임의
/// id로 파일이 계속 만들어지는 것은 막는다 — 오탈자 id로 영원히 남는 고아 파일을 방지한다.
fn require_installed(app_data: &Path, id: &str) -> Result<(), String> {
    if !plugin_dir_exists(app_data, id) {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    Ok(())
}

fn plugin_dir_exists(app_data: &Path, id: &str) -> bool {
    app_data.join("plugins").join(id).is_dir()
}

// ── 설치(사이드로드) 플러그인 저장소 ─────────────────────────────────────────────

/// 값 하나를 읽는다(없으면 `Ok(None)`).
pub fn get(app_data: &Path, id: &str, key: &str) -> Result<Option<serde_json::Value>, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    require_installed(app_data, id)?;
    Ok(load(&installed_path(app_data, id)).get(key).cloned())
}

/// 값 하나를 저장한다(JSON 직렬화 가능 값만 — `serde_json::Value`가 그 계약을 타입으로 강제).
pub fn set(app_data: &Path, id: &str, key: &str, value: serde_json::Value) -> Result<(), String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    require_installed(app_data, id)?;
    let path = installed_path(app_data, id);
    with_storage_lock(|| {
        let mut map = load(&path);
        map.insert(key.to_string(), value);
        save(&path, &map)
    })
}

/// 값 하나를 지운다(없어도 오류 아님 — 멱등).
pub fn remove(app_data: &Path, id: &str, key: &str) -> Result<(), String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    require_installed(app_data, id)?;
    let path = installed_path(app_data, id);
    with_storage_lock(|| {
        let mut map = load(&path);
        if map.remove(key).is_some() {
            save(&path, &map)?;
        }
        Ok(())
    })
}

/// 저장소 전체 스냅샷을 읽는다(없으면 빈 맵).
pub fn get_all(app_data: &Path, id: &str) -> Result<StorageMap, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    require_installed(app_data, id)?;
    Ok(load(&installed_path(app_data, id)))
}

/// 플러그인 제거 시 저장소 파일도 함께 지운다(있으면). 없어도 오류 아님.
///
/// 왜 이 모듈에 두는가: `plugin_commands::remove_plugin`이 `plugins::remove` 다음에 이
/// 함수를 호출해 잔여 저장소가 고아로 남지 않게 한다(권한·설정과 같은 생애주기).
pub fn remove_all(app_data: &Path, id: &str) -> Result<(), String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    let path = installed_path(app_data, id);
    // 파일을 통째로 지우는 것도 쓰기다 — 진행 중인 set의 load↔save 사이에 끼어들면 방금
    // 지운 저장소가 그 set의 save로 되살아난다.
    with_storage_lock(|| {
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

// ── 빌트인(번들) 플러그인 저장소 ─────────────────────────────────────────────────
//
// 번들은 앱에 코드가 내장돼 디렉터리가 없다(`plugins::set_builtin_setting`과 같은 이유로
// `require_installed` 검사를 하지 않는다) — id 형식과 키 형식만 검증한다.

/// 값 하나를 읽는다(없으면 `Ok(None)`).
pub fn get_builtin(
    app_data: &Path,
    id: &str,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    Ok(load(&builtin_path(app_data, id)).get(key).cloned())
}

/// 값 하나를 저장한다.
pub fn set_builtin(
    app_data: &Path,
    id: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    let path = builtin_path(app_data, id);
    with_storage_lock(|| {
        let mut map = load(&path);
        map.insert(key.to_string(), value);
        save(&path, &map)
    })
}

/// 값 하나를 지운다(없어도 오류 아님 — 멱등).
pub fn remove_builtin(app_data: &Path, id: &str, key: &str) -> Result<(), String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    if !is_valid_storage_key(key) {
        return Err(format!("저장소 키 형식 오류: {key}"));
    }
    let path = builtin_path(app_data, id);
    with_storage_lock(|| {
        let mut map = load(&path);
        if map.remove(key).is_some() {
            save(&path, &map)?;
        }
        Ok(())
    })
}

/// 저장소 전체 스냅샷을 읽는다(없으면 빈 맵).
pub fn get_all_builtin(app_data: &Path, id: &str) -> Result<StorageMap, String> {
    if !is_valid_plugin_id(id) {
        return Err(format!("id 형식 오류: {id}"));
    }
    Ok(load(&builtin_path(app_data, id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// 설치된 것으로 취급되려면 `<app_data>/plugins/<id>/`가 실제 디렉터리여야 한다.
    fn mark_installed(app_data: &Path, id: &str) {
        std::fs::create_dir_all(app_data.join("plugins").join(id)).unwrap();
    }

    #[test]
    fn get_set_remove_roundtrip_for_installed_plugin() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");

        assert_eq!(get(app_data, "alpha", "k").unwrap(), None);

        set(app_data, "alpha", "k", serde_json::json!({"n": 1})).unwrap();
        assert_eq!(
            get(app_data, "alpha", "k").unwrap(),
            Some(serde_json::json!({"n": 1}))
        );

        remove(app_data, "alpha", "k").unwrap();
        assert_eq!(get(app_data, "alpha", "k").unwrap(), None);
    }

    #[test]
    fn get_all_returns_full_snapshot() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");

        set(app_data, "alpha", "a", serde_json::json!(1)).unwrap();
        set(app_data, "alpha", "b", serde_json::json!("x")).unwrap();

        let all = get_all(app_data, "alpha").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all.get("a"), Some(&serde_json::json!(1)));
        assert_eq!(all.get("b"), Some(&serde_json::json!("x")));
    }

    #[test]
    fn get_all_empty_for_never_written_plugin() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        assert!(get_all(app_data, "alpha").unwrap().is_empty());
    }

    #[test]
    fn rejects_uninstalled_plugin() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        // 설치 표시(mark_installed)를 하지 않았다.
        assert!(get(app_data, "ghost", "k").is_err());
        assert!(set(app_data, "ghost", "k", serde_json::json!(1)).is_err());
        assert!(remove(app_data, "ghost", "k").is_err());
        assert!(get_all(app_data, "ghost").is_err());
    }

    #[test]
    fn rejects_malformed_plugin_id() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        assert!(get(app_data, "../etc", "k").is_err());
        assert!(get(app_data, "UPPER", "k").is_err());
        assert!(get(app_data, "", "k").is_err());
    }

    #[test]
    fn rejects_prototype_polluting_keys() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        for bad in ["__proto__", "constructor", "prototype"] {
            assert!(
                set(app_data, "alpha", bad, serde_json::json!(1)).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_empty_and_overlong_keys() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        assert!(set(app_data, "alpha", "", serde_json::json!(1)).is_err());
        let long_key = "k".repeat(201);
        assert!(set(app_data, "alpha", &long_key, serde_json::json!(1)).is_err());
        let ok_key = "k".repeat(200);
        assert!(set(app_data, "alpha", &ok_key, serde_json::json!(1)).is_ok());
    }

    #[test]
    fn rejects_write_exceeding_quota_without_partial_write() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");

        // 상한(256KB)을 넘는 값 하나 — 거부되고, 거부 후에도 기존 상태(빈 맵)가 유지된다.
        let huge = "x".repeat(MAX_STORAGE_BYTES + 1024);
        let err = set(app_data, "alpha", "big", serde_json::json!(huge)).unwrap_err();
        assert!(err.starts_with(QUOTA_EXCEEDED_PREFIX), "got: {err}");
        assert_eq!(get(app_data, "alpha", "big").unwrap(), None);
    }

    #[test]
    fn isolates_two_plugins_from_each_other() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        mark_installed(app_data, "beta");

        set(app_data, "alpha", "secret", serde_json::json!("a-only")).unwrap();
        assert_eq!(get(app_data, "beta", "secret").unwrap(), None);
        assert!(get_all(app_data, "beta").unwrap().is_empty());
    }

    #[test]
    fn installed_and_builtin_storage_do_not_collide_on_same_id() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "shared-id");

        set(app_data, "shared-id", "k", serde_json::json!("installed")).unwrap();
        set_builtin(app_data, "shared-id", "k", serde_json::json!("builtin")).unwrap();

        assert_eq!(
            get(app_data, "shared-id", "k").unwrap(),
            Some(serde_json::json!("installed"))
        );
        assert_eq!(
            get_builtin(app_data, "shared-id", "k").unwrap(),
            Some(serde_json::json!("builtin"))
        );
    }

    #[test]
    fn builtin_storage_roundtrip_without_directory() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        // 빌트인은 `plugins/<id>/` 디렉터리가 없어도(never mark_installed) 동작해야 한다.
        assert_eq!(get_builtin(app_data, "wikilink", "k").unwrap(), None);
        set_builtin(app_data, "wikilink", "k", serde_json::json!(true)).unwrap();
        assert_eq!(
            get_builtin(app_data, "wikilink", "k").unwrap(),
            Some(serde_json::json!(true))
        );
        remove_builtin(app_data, "wikilink", "k").unwrap();
        assert_eq!(get_builtin(app_data, "wikilink", "k").unwrap(), None);
    }

    #[test]
    fn remove_all_deletes_file_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        set(app_data, "alpha", "k", serde_json::json!(1)).unwrap();
        assert!(installed_path(app_data, "alpha").is_file());

        remove_all(app_data, "alpha").unwrap();
        assert!(!installed_path(app_data, "alpha").is_file());
        // 파일이 없어도 다시 호출하면 오류가 아니다(멱등).
        remove_all(app_data, "alpha").unwrap();
    }

    #[test]
    fn remove_nonexistent_key_is_noop_not_error() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        remove(app_data, "alpha", "never-set").unwrap();
    }

    /// 가드(유실 회귀): 같은 플러그인 저장소에 **동시에** 쓴 키가 하나도 사라지지 않는다.
    ///
    /// 왜: 이 모듈의 쓰기는 load→수정→save의 read-modify-write이고, 이것을 감싸는 커맨드는
    /// 전부 `#[tauri::command(async)]`라 서로 다른 스레드에서 병행 실행된다. 잠금이 없으면
    /// 두 쓰기가 서로의 load 결과를 덮어써 키가 조용히 사라지거나(lost update), 고정
    /// 임시 파일명(`<path>.tmp`) 경합으로 rename이 ENOENT로 실패한다 — 여러 노트 창이
    /// `note:saved`에 반응해 거의 동시에 저장하는 것만으로 재현된다.
    #[test]
    fn concurrent_writes_keep_every_key() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");

        const THREADS: usize = 4;
        const PER_THREAD: usize = 25;
        std::thread::scope(|scope| {
            for t in 0..THREADS {
                scope.spawn(move || {
                    for i in 0..PER_THREAD {
                        set(
                            app_data,
                            "alpha",
                            &format!("k{t}-{i}"),
                            serde_json::json!(i),
                        )
                        .expect("동시 쓰기가 실패하면 안 된다");
                    }
                });
            }
        });

        let all = get_all(app_data, "alpha").unwrap();
        assert_eq!(all.len(), THREADS * PER_THREAD, "유실된 키가 있다");
    }

    /// 가드: 동시에 쓰고 지워도 저장소 파일이 깨지지 않는다(읽기가 항상 유효한 JSON을 본다).
    #[test]
    fn concurrent_writes_and_removes_never_corrupt_the_file() {
        let dir = tempdir().unwrap();
        let app_data = dir.path();
        mark_installed(app_data, "alpha");
        set(app_data, "alpha", "keep", serde_json::json!("v")).unwrap();

        std::thread::scope(|scope| {
            scope.spawn(|| {
                for i in 0..50 {
                    set(app_data, "alpha", "churn", serde_json::json!(i)).unwrap();
                }
            });
            scope.spawn(|| {
                for _ in 0..50 {
                    remove(app_data, "alpha", "churn").unwrap();
                }
            });
        });

        // 남아 있어야 하는 키는 어느 쪽 경합에서도 살아남는다.
        assert_eq!(
            get(app_data, "alpha", "keep").unwrap(),
            Some(serde_json::json!("v"))
        );
    }
}
