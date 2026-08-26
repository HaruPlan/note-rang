//! 설정 영속화 — 로컬(앱데이터, 비동기화) vs 공유(vault, 동기화) 분리.
//!
//! 역할: 기기 고유 설정(vault 경로·자동실행·단축키)은 앱데이터에, 전역 기본값/테마는
//! vault에 저장하고 각각 로드/세이브한다.
//! 왜: vault 경로를 vault 안에 두면 순환(닭-달걀)이 생기고, 동기화로 기기 고유값이
//! 섞이면 안 되므로 저장 위치를 구조적으로 분리한다.

use crate::io::{read_to_string, write_atomic};
use crate::model::{SharedSettings, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// 로컬(비동기화) 설정 — 앱데이터에 저장하는 기기 고유 값.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalConfig {
    pub schema_version: u32,
    pub vault_path: PathBuf,
    pub launch_at_login: bool,
    pub global_hotkey: String,
    /// 첫 실행 환영 노트를 이미 생성했는지(중복 생성 방지). 구버전 설정엔 없을 수 있어 기본 false.
    #[serde(default)]
    pub welcomed: bool,
    /// 첫 실행 "저장 폴더 안내"(이슈 #21)를 이미 띄웠는지.
    ///
    /// 기본값이 [`welcomed`](Self::welcomed)와 **반대로 true**인 데는 이유가 있다: 이 필드가
    /// 없는 `config.json`은 곧 **이 기능이 생기기 전부터 쓰던 설치**라는 뜻이다. 그 사용자에게
    /// "메모가 어디 저장되는지" 안내를 새삼 띄우는 것은 첫 실행 안내가 아니라 광고에 가깝다
    /// (그들은 이미 자기 폴더를 알고, 바꾸고 싶으면 설정에 페이지가 있다). 반대로 진짜 새
    /// 설치는 `config.json` 자체가 없어 [`LocalConfig::with_defaults`]를 타고, 거기서는
    /// `false`로 시작해 안내를 한 번 받는다 — 즉 "파일에 없음"과 "새로 만듦"을 구분한다.
    #[serde(default = "vault_prompted_default")]
    pub vault_prompted: bool,
    /// 시작할 때 **활성 노트(hidden=false)가 하나도 없으면** 무엇을 띄울지 —
    /// [`STARTUP_NO_ACTIVE_PANEL`] | [`STARTUP_NO_ACTIVE_NEW_NOTE`]. 부팅 자동시작
    /// (로그인 항목)에는 적용되지 않는다(그때는 조용히 뜬다).
    ///
    /// 어휘 밖의 값은 읽는 쪽이 기본값(`"panel"`)으로 해석한다 — 손으로 고친 `config.json`이나
    /// 더 새 버전이 쓴 값 하나 때문에 파싱 전체가 깨지면 안 되기 때문이다(아래 참고).
    ///
    /// **`#[serde(default)]`가 필수**인 이유: [`load_local_config`]는 파싱이 실패하면 파일을
    /// 통째로 버리고 [`LocalConfig::with_defaults`]로 떨어진다 — 이 필드 하나가 없는 구버전
    /// `config.json`에서 파싱이 깨지면 **`vault_path`까지 기본값으로 리셋**돼 사용자의 노트가
    /// 통째로 "사라진 것처럼" 보인다. 타입이 enum이 아니라 `String`인 이유도 같다.
    #[serde(default = "startup_no_active_action_default")]
    pub startup_no_active_action: String,
    /// 패널 목록의 정렬 모드(예 `"created-desc"`). 백엔드는 **의미를 모르고 왕복만 한다** —
    /// 어휘와 비교 규칙의 주인은 프론트(`src/panel/`)다(`SharedSettings::toolbar_style`과 같은
    /// 관례). 알 수 없는 값은 프론트가 기본 모드로 해석한다.
    ///
    /// `SharedSettings`가 아니라 여기(로컬)에 두는 이유: 목록을 어떤 순서로 볼지는 **보는
    /// 사람·기기의 취향**이지 vault에 담긴 데이터가 아니다. 동기화하면 다른 기기에서 바꾼
    /// 정렬이 이쪽 패널을 갑자기 다시 정렬하고, 패널의 정렬 저장이 설정 창의 동시 변경을
    /// 되돌리는 클로버(공유 설정은 통째로 쓰인다)도 생긴다.
    ///
    /// `#[serde(default)]`가 필수인 이유는 위 `startup_no_active_action` 참고.
    #[serde(default = "panel_sort_default")]
    pub panel_sort: String,
}

/// 구버전 `config.json`(필드 없음)의 `vault_prompted` 기본값 — 문서는 필드 주석 참고.
fn vault_prompted_default() -> bool {
    true
}

/// [`LocalConfig::startup_no_active_action`] 어휘 — 메모 목록(패널)만 띄운다(기본값).
pub const STARTUP_NO_ACTIVE_PANEL: &str = "panel";
/// [`LocalConfig::startup_no_active_action`] 어휘 — 새 메모를 만들어 띄운다(패널도 함께 뜬다).
pub const STARTUP_NO_ACTIVE_NEW_NOTE: &str = "new-note";

/// 패널 정렬 모드의 기본값 — 프론트 `parsePanelSort`의 폴백과 **같은 문자열**이어야 한다
/// (백엔드는 이 값의 의미를 모르고, "아직 고른 적 없음"을 표현하는 데만 쓴다).
pub const PANEL_SORT_DEFAULT: &str = "created-desc";

/// 아는 `startup_no_active_action` 값인지 — 커맨드의 어휘 검증 관문.
///
/// 왜 검증이 필요한가: 이 값은 시작 흐름의 분기라 오타 하나가 "앱을 켰는데 아무것도 안 뜬다"로
/// 보인다. 저장 시점에 거부해 두면 읽는 쪽은 기본값 폴백만 신경 쓰면 된다.
pub fn is_startup_no_active_action(raw: &str) -> bool {
    raw == STARTUP_NO_ACTIVE_PANEL || raw == STARTUP_NO_ACTIVE_NEW_NOTE
}

/// 구버전 `config.json`(필드 없음)의 `startup_no_active_action` 기본값.
pub fn startup_no_active_action_default() -> String {
    STARTUP_NO_ACTIVE_PANEL.to_string()
}

/// 구버전 `config.json`(필드 없음)의 `panel_sort` 기본값.
pub fn panel_sort_default() -> String {
    PANEL_SORT_DEFAULT.to_string()
}

impl LocalConfig {
    /// documents 디렉터리를 기준으로 기본 로컬 설정을 만든다.
    pub fn with_defaults(documents_dir: &Path) -> Self {
        LocalConfig {
            schema_version: SCHEMA_VERSION,
            vault_path: default_vault_path(documents_dir),
            launch_at_login: true,
            global_hotkey: "CmdOrCtrl+Shift+N".to_string(),
            welcomed: false,
            // 새 설치만 이 경로를 탄다 — 첫 실행 저장 폴더 안내를 한 번 받는다.
            vault_prompted: false,
            startup_no_active_action: startup_no_active_action_default(),
            panel_sort: panel_sort_default(),
        }
    }
}

/// serde 직렬화 실패를 io 오류로 변환한다.
fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// 기본 vault 경로(`<documents>/note-rang`).
pub fn default_vault_path(documents_dir: &Path) -> PathBuf {
    documents_dir.join("note-rang")
}

/// 로컬 설정을 읽는다. 파일이 없거나 깨졌으면 documents 기준 기본값을 만든다.
pub fn load_local_config(config_path: &Path, documents_dir: &Path) -> LocalConfig {
    read_to_string(config_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| LocalConfig::with_defaults(documents_dir))
}

/// 로컬 설정을 원자적으로 쓴다.
pub fn save_local_config(config_path: &Path, config: &LocalConfig) -> io::Result<()> {
    let json = serde_json::to_string_pretty(config).map_err(to_io)?;
    write_atomic(config_path, &json)
}

/// 공유 설정 파일 경로(`<vault>/.memo/shared-settings.json`).
pub fn shared_settings_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".memo").join("shared-settings.json")
}

/// 공유 설정을 읽는다. 파일이 없거나 깨졌으면 기본값(sj_d 테마 등).
pub fn load_shared_settings(vault_root: &Path) -> SharedSettings {
    read_to_string(&shared_settings_path(vault_root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 공유 설정을 원자적으로 쓴다.
pub fn save_shared_settings(vault_root: &Path, settings: &SharedSettings) -> io::Result<()> {
    let json = serde_json::to_string_pretty(settings).map_err(to_io)?;
    write_atomic(&shared_settings_path(vault_root), &json)
}

/// vault가 사용 가능한지(부모 디렉터리가 존재/접근 가능) 판정한다.
///
/// 역할: iCloud 미다운로드·외장 분리·권한 회수 등으로 vault에 접근 불가일 때를 감지해
/// graceful 처리(재지정 안내·쓰기 차단)하기 위함. 부모 존재로 근사한다.
pub fn is_vault_available(vault_root: &Path) -> bool {
    vault_root.parent().is_some_and(Path::exists)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 기본 vault 경로는 `<documents>/note-rang`.
    #[test]
    fn default_vault_is_documents_note_rang() {
        let docs = PathBuf::from("/Users/x/Documents");
        assert_eq!(default_vault_path(&docs), docs.join("note-rang"));
    }

    /// 가드: 로컬 설정이 JSON 왕복에 안정적이다.
    #[test]
    fn local_config_roundtrip() {
        let cfg = LocalConfig::with_defaults(Path::new("/docs"));
        let json = serde_json::to_string(&cfg).unwrap();
        let back: LocalConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg, back);
        assert!(cfg.launch_at_login);
    }

    /// 가드: 로컬 설정 파일이 없으면 documents 기준 기본값으로 폴백한다.
    #[test]
    fn load_local_config_falls_back_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = load_local_config(&dir.path().join("nope.json"), Path::new("/docs"));
        assert_eq!(cfg.vault_path, PathBuf::from("/docs/note-rang"));
        assert!(
            !cfg.vault_prompted,
            "새 설치는 저장 폴더 안내를 한 번 받는다"
        );
    }

    /// 가드(이슈 #21): `vault_prompted`가 없는 **구버전** 설정 파일은 "이미 안내했다"로 읽는다 —
    /// 기존 사용자에게 첫 실행 안내를 새삼 띄우지 않기 위함(필드 주석 참고). 반면 파일 자체가
    /// 없으면(진짜 새 설치) 위 테스트대로 false다.
    #[test]
    fn legacy_config_counts_as_already_prompted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"vault_path":"/docs/note-rang",
                "launch_at_login":true,"global_hotkey":"CmdOrCtrl+Shift+N","welcomed":true}"#,
        )
        .unwrap();
        let cfg = load_local_config(&path, Path::new("/docs"));
        assert!(cfg.vault_prompted);
        assert!(cfg.welcomed);
    }

    /// 가드(치명 회귀): 시작 흐름·정렬 필드가 **없던 구버전** `config.json`도 통째로 읽히고,
    /// 두 필드만 기본값이 된다 — 특히 **`vault_path`가 보존**되어야 한다.
    ///
    /// 왜 이 테스트가 필요한가: [`load_local_config`]는 파싱 실패를 `unwrap_or_else`로 삼켜
    /// `with_defaults`로 떨어진다. 새 필드에 `#[serde(default)]`를 빠뜨리면 기존 사용자의
    /// `config.json`이 통째로 버려지고 `vault_path`가 `<documents>/note-rang`으로 리셋된다 —
    /// 사용자 눈에는 "노트가 전부 사라졌다"로 보인다(실제로는 옛 폴더에 그대로 있다).
    #[test]
    fn legacy_config_keeps_vault_path_and_defaults_new_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"vault_path":"/custom/vault",
                "launch_at_login":true,"global_hotkey":"CmdOrCtrl+Shift+N",
                "welcomed":true,"vault_prompted":true}"#,
        )
        .unwrap();
        let cfg = load_local_config(&path, Path::new("/docs"));
        assert_eq!(
            cfg.vault_path,
            PathBuf::from("/custom/vault"),
            "새 필드 때문에 파싱이 깨지면 vault_path가 리셋된다 — 절대 금지"
        );
        assert_eq!(cfg.startup_no_active_action, STARTUP_NO_ACTIVE_PANEL);
        assert_eq!(cfg.panel_sort, PANEL_SORT_DEFAULT);
    }

    /// 가드: 디스크의 **JSON 키 이름**이 계약대로다 — 손으로 쓴 `config.json`의 두 값이
    /// 그대로 읽힌다. (왕복 테스트만으로는 필드를 양쪽 다 rename해도 통과하지만, 그러면
    /// 기존 사용자의 파일이 조용히 기본값으로 읽힌다.)
    #[test]
    fn config_json_keys_are_read_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"vault_path":"/custom/vault",
                "launch_at_login":true,"global_hotkey":"CmdOrCtrl+Shift+N",
                "welcomed":true,"vault_prompted":true,
                "startup_no_active_action":"new-note","panel_sort":"title-asc"}"#,
        )
        .unwrap();
        let cfg = load_local_config(&path, Path::new("/docs"));
        assert_eq!(cfg.startup_no_active_action, STARTUP_NO_ACTIVE_NEW_NOTE);
        assert_eq!(cfg.panel_sort, "title-asc");
    }

    /// 가드: 어휘 검증은 아는 두 값만 통과시킨다(빈 값·오타·대문자 거부).
    #[test]
    fn startup_no_active_action_vocabulary() {
        assert!(is_startup_no_active_action(STARTUP_NO_ACTIVE_PANEL));
        assert!(is_startup_no_active_action(STARTUP_NO_ACTIVE_NEW_NOTE));
        for bad in ["", " panel", "Panel", "new_note", "newnote", "none"] {
            assert!(!is_startup_no_active_action(bad), "거부해야 한다: {bad:?}");
        }
    }

    /// 가드: 저장한 로컬 설정을 다시 읽으면 동일하다.
    ///
    /// 모든 항목을 **기본값이 아닌 값**으로 바꿔 두는 것이 요점이다: 기본값만 왕복시키면
    /// 필드에 `#[serde(skip)]`이나 rename 오타가 생겨도 저장값과 읽은 값이 둘 다 기본값이라
    /// `assert_eq!`가 계속 통과한다 — "사용자가 고른 「이름순」이 재시작마다 조용히
    /// 「추가순」으로 되돌아가는" 회귀를 테스트가 못 잡는다.
    #[test]
    fn save_then_load_local_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let defaults = LocalConfig::with_defaults(Path::new("/docs"));
        let cfg = LocalConfig {
            vault_path: PathBuf::from("/custom/vault"),
            launch_at_login: !defaults.launch_at_login,
            global_hotkey: "CmdOrCtrl+Alt+M".to_string(),
            welcomed: true,
            vault_prompted: true,
            startup_no_active_action: STARTUP_NO_ACTIVE_NEW_NOTE.to_string(),
            panel_sort: "title-asc".to_string(),
            ..defaults
        };
        // 기본값과 실제로 다른 값인지 스스로 확인한다(어느 하나라도 기본값이면 가드가 무력해진다).
        let baseline = LocalConfig::with_defaults(Path::new("/docs"));
        assert_ne!(
            cfg.startup_no_active_action,
            baseline.startup_no_active_action
        );
        assert_ne!(cfg.panel_sort, baseline.panel_sort);

        save_local_config(&path, &cfg).unwrap();
        let back = load_local_config(&path, Path::new("/docs"));
        assert_eq!(back, cfg);
        assert_eq!(back.startup_no_active_action, STARTUP_NO_ACTIVE_NEW_NOTE);
        assert_eq!(back.panel_sort, "title-asc");
    }

    /// 가드: 공유 설정이 없으면 기본값(sj_d), 저장 후엔 그 값을 읽는다.
    #[test]
    fn shared_settings_default_then_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert_eq!(load_shared_settings(vault).theme, "sj_d");

        let s = SharedSettings {
            theme: "custom".to_string(),
            ..SharedSettings::default()
        };
        save_shared_settings(vault, &s).unwrap();
        assert_eq!(load_shared_settings(vault), s);
    }

    /// 가드: 부모가 존재하면 vault 사용 가능, 없으면 불가.
    #[test]
    fn vault_availability_by_parent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_vault_available(&dir.path().join("note-rang")));
        assert!(!is_vault_available(&PathBuf::from(
            "/no/such/parent/here/note-rang"
        )));
    }
}
