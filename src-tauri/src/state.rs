//! 앱 전역 상태 + 초기화.
//!
//! 역할: 시작 시 로컬 설정(앱데이터)·공유 설정(vault)·노트 저장소를 로드하고,
//! 시작 재조정을 수행한 뒤 Tauri managed 상태로 등록한다.
//! 왜: 모든 노트/설정 접근이 한 지점(AppState)을 거치게 해 일관성을 보장한다.

use crate::model::SharedSettings;
use crate::notes::{is_blank, Vault};
use crate::reconcile;
use crate::settings::{self, LocalConfig};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tauri::Manager;

/// 환영 노트가 안내하는 전역 새-노트 단축키의 **이 OS에서의 표기**.
///
/// 프론트 `formatAccelLabel`과 같은 관례다 — mac은 글리프를 이어 붙이고(`⌘⇧N`), 그 외는 `+`로
/// 잇는다(`Ctrl+Shift+N`). 예전엔 본문에 `⌘⇧N`이 박혀 있어 Windows 사용자에게 없는 키를
/// 안내했다.
///
/// 기본 가속기(`CmdOrCtrl+Shift+N`)의 표기를 그대로 적는 이유: 이 노트는 `welcomed=false`일
/// 때만 만들어지고, 그 시점의 `config.json`은 항상 갓 만들어진 것이라 단축키도 항상 기본값이다.
/// 가속기 파서를 Rust에 또 만들면 `accel.ts`와 갈라질 위험만 는다.
const WELCOME_SHORTCUT: &str = if cfg!(target_os = "macos") {
    "⌘⇧N"
} else {
    "Ctrl+Shift+N"
};

/// 첫 환영 노트에 넣는 note-rang 캐릭터 원본. 앱에 컴파일해 두고 첫 실행 때 각 vault의
/// 첨부 폴더에 넣어, 노트가 동기화되어도 그림과 본문이 함께 움직이게 한다.
const WELCOME_LOGO: &[u8] = include_bytes!("../../logo.png");

/// 환영 노트에 넣을 캐릭터 그림의 표시 폭(px). 원본이 2048px 정사각형이라 그대로 두면 첫
/// 노트가 그림으로만 가득 차므로, alt 크기 문법(`w=`, `src/note/image-size.ts`)으로 줄여 넣는다.
const WELCOME_LOGO_WIDTH: u32 = 300;

/// 시작 시 빈 노트를 정리하고, 첫 실행이면 환영 노트를 만든다.
///
/// 빈(공백뿐) 노트는 이전 세션에서 입력 없이 닫힌 흔적이라 정리한다. 이후 노트가 하나도
/// 없고 아직 환영한 적 없으면(welcomed=false) 환영 노트를 만들고 플래그를 저장한다.
///
/// 본문은 `language`(공유 설정)에 맞는 내장 테이블에서 고르고([`crate::i18n`]), 단축키
/// 자리는 이 OS의 표기로 채운다 — 이 노트는 Rust 산출물이라 자바스크립트 언어팩이 닿지 못한다.
fn cleanup_and_welcome(
    vault: &Vault,
    config: &mut LocalConfig,
    config_path: &Path,
    language: Option<&str>,
) {
    if let Ok(ids) = vault.list_note_ids() {
        for id in ids {
            let blank = vault
                .read_content(&id)
                .map(|c| is_blank(&c))
                .unwrap_or(false);
            if blank {
                let _ = vault.delete_note(&id);
            }
        }
    }
    let empty = vault.list_note_ids().map(|v| v.is_empty()).unwrap_or(false);
    if !config.welcomed && empty {
        let template = crate::i18n::strings(language)
            .welcome_note
            .replace("{shortcut}", WELCOME_SHORTCUT);
        if let Ok(id) = vault.create_note("") {
            let logo = crate::attachments::save_attachment(vault.root(), &id, WELCOME_LOGO, "png")
                .map(|path| format!("![note-rang w={WELCOME_LOGO_WIDTH}]({path})"))
                .unwrap_or_default();
            let body = template.replace("{logo}", &logo);
            if vault.write_content(&id, &body).is_ok() {
                config.welcomed = true;
                let _ = settings::save_local_config(config_path, config);
            }
        }
    }
}

/// 노트 쓰기가 봉인된 동안 쓰기 커맨드가 돌려주는 오류 문자열.
///
/// `"<코드> <설명>"` 관례를 따른다(`VAULT_*`·`NET_*`와 같다) — 프론트는 첫 토큰으로 분류한다.
pub const ERR_WRITES_SEALED: &str = "VAULT_BUSY 저장소를 정리하는 중이라 저장하지 않았습니다";

/// Tauri managed 전역 상태 — 노트/설정 접근의 단일 지점.
pub struct AppState {
    /// 노트 저장소 핸들.
    ///
    /// `Arc`인 이유: 디스크 IO를 blocking 풀([`tauri::async_runtime::spawn_blocking`])로
    /// 넘기려면 클로저가 `'static` 핸들을 쥐어야 하는데 `State<AppState>`는 커맨드 호출
    /// 동안만 유효한 빌림이라 넘길 수 없다. **사본이 아니라 잠금 자체**를 공유해야
    /// "저장 폴더 이전 중에는 노트 쓰기가 기다린다"는 직렬화가 유지된다
    /// ([`VaultHandle`] 참고). `Arc<Mutex<_>>`라 기존 `state.vault.lock()` 호출부는 그대로다.
    pub vault: Arc<Mutex<Vault>>,
    pub shared: Mutex<SharedSettings>,
    pub config: Mutex<LocalConfig>,
    /// 노트 쓰기 봉인 깊이 — 0보다 크면 노트를 만들거나 고치는 커맨드가 거부된다
    /// ([`AppState::seal_note_writes`]).
    seal: Arc<AtomicUsize>,
}

/// 중독(poisoned)된 잠금도 복구해 잠근다 — 커맨드 하나의 패닉이 앱 전체를 마비시키지 않게.
///
/// 왜 이 함수가 필요한가(이슈 #24 "하나가 죽으면 다 죽는다"의 백엔드 절반): `std::sync::Mutex`는
/// 임계구역에서 패닉이 나면 **영구히** poisoned로 표시되고, 이후 모든 `lock()`이 `Err`가 된다.
/// 예전에는 모든 커맨드가 `state.vault.lock().map_err(...)?`였으므로, 어떤 커맨드 하나가
/// (직렬화 실패·인덱싱 실수·플러그인이 넣은 이상한 입력 등으로) 한 번 패닉하면 그 뒤로는
/// **모든 노트 창의 읽기·저장·삭제가 전부** "내부 상태 잠금 오류"가 됐다 — 노트 하나의 사고가
/// 앱 전체의 사망으로 번지는 정확한 구조였다.
///
/// 여기서 지키는 상태는 전부 "다시 읽으면 되는" 것이다: [`Vault`]는 경로만 들고 있는 핸들이라
/// 내부 불변식이 없고, 설정 두 벌은 통째로 교체되는 값이다. 반쯤 갱신된 채로 남을 수 있는
/// 자료구조가 아니므로, 중독을 이유로 접근을 영구 차단하는 것보다 이어 쓰는 쪽이 안전하다
/// (`plugin_storage::with_storage_lock`이 같은 근거로 이미 쓰던 관용구다).
fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppState {
    /// 로드된 세 조각으로 상태를 조립한다(잠금·봉인 초기화는 여기 한 곳에서만 한다).
    pub fn new(vault: Vault, shared: SharedSettings, config: LocalConfig) -> Self {
        Self {
            vault: Arc::new(Mutex::new(vault)),
            shared: Mutex::new(shared),
            config: Mutex::new(config),
            seal: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// 노트 저장소를 잠근다(중독 복구 — [`lock_recover`] 참고).
    pub fn lock_vault(&self) -> MutexGuard<'_, Vault> {
        lock_recover(&self.vault)
    }

    /// 노트를 **만들거나 고치는** 목적으로 잠근다 — 봉인 중이면 잠그지 않고 오류를 낸다.
    /// 순서 근거는 [`VaultHandle::lock_for_write`] 참고.
    pub fn lock_vault_for_write(&self) -> Result<MutexGuard<'_, Vault>, String> {
        let guard = self.lock_vault();
        if sealed(&self.seal) {
            return Err(ERR_WRITES_SEALED.to_string());
        }
        Ok(guard)
    }

    /// 공유 설정을 잠근다(중독 복구).
    pub fn lock_shared(&self) -> MutexGuard<'_, SharedSettings> {
        lock_recover(&self.shared)
    }

    /// 로컬 설정을 잠근다(중독 복구).
    pub fn lock_config(&self) -> MutexGuard<'_, LocalConfig> {
        lock_recover(&self.config)
    }

    /// blocking 풀 클로저로 넘길 수 있는 저장소 핸들을 만든다(잠금·봉인을 공유한다).
    pub fn vault_handle(&self) -> VaultHandle {
        VaultHandle {
            vault: Arc::clone(&self.vault),
            seal: Arc::clone(&self.seal),
        }
    }

    /// 노트 쓰기를 봉인한다 — 가드가 살아 있는 동안 쓰기 커맨드가
    /// [`ERR_WRITES_SEALED`]로 거부된다(가드를 놓으면 자동으로 풀린다).
    ///
    /// 쓰임: "모든 데이터 삭제"([`crate::commands::wipe_all_data`])처럼 **지운 직후 도착한
    /// 저장이 지운 것을 되살리는** 구간. 창을 닫는 행위 자체가 웹뷰의 `pagehide`를 깨워
    /// 대기 중이던 자동저장을 flush하므로, 창을 먼저 닫는 것만으로는 그 flush가 삭제
    /// **뒤에** 도착하는 경로가 남는다.
    pub fn seal_note_writes(&self) -> WriteSeal {
        self.seal.fetch_add(1, Ordering::AcqRel);
        WriteSeal(Arc::clone(&self.seal))
    }

    /// 지금 노트 쓰기가 봉인돼 있는지(가드 테스트 전용 — 실행 경로는 잠금 시도로 판정한다).
    #[cfg(test)]
    pub fn writes_sealed(&self) -> bool {
        sealed(&self.seal)
    }
}

/// 봉인 깊이가 0보다 큰지 — 봉인은 중첩될 수 있으므로 카운터로 센다.
fn sealed(seal: &AtomicUsize) -> bool {
    seal.load(Ordering::Acquire) > 0
}

/// 노트 쓰기 봉인 가드(RAII). 놓으면 봉인이 한 겹 풀린다.
pub struct WriteSeal(Arc<AtomicUsize>);

impl Drop for WriteSeal {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 워커(blocking 풀)로 넘길 수 있는 노트 저장소 핸들 — 잠금과 봉인을 [`AppState`]와 **공유**한다.
///
/// 왜 `Vault` 사본이 아닌가: 사본을 넘기면 그 순간의 경로가 클로저에 박혀, 저장 폴더 이전이
/// 진행 중이어도 옛 폴더에 그대로 쓴다(이동 도중 자동저장이 새는 결함의 원인). 잠금을 함께
/// 넘기면 이동 구간이 잠금을 쥐고 있는 동안 쓰기가 **기다렸다가** 교체된 새 경로로 쓴다.
#[derive(Clone)]
pub struct VaultHandle {
    vault: Arc<Mutex<Vault>>,
    seal: Arc<AtomicUsize>,
}

impl VaultHandle {
    /// 읽기용 잠금(봉인과 무관 — 읽기는 아무것도 되살리지 않는다).
    pub fn lock(&self) -> MutexGuard<'_, Vault> {
        lock_recover(&self.vault)
    }

    /// 쓰기용 잠금 — 봉인 중이면 잠금을 돌려주지 않는다.
    ///
    /// **잠근 뒤에** 봉인을 확인하는 순서가 핵심이다. 봉인자는 봉인을 세운 **뒤** 잠금을
    /// 잡으므로, 이 순서라면 (1) 봉인 전에 잠금을 얻은 쓰기는 봉인자가 기다려 주고,
    /// (2) 봉인 후에 잠금을 얻은 쓰기는 반드시 봉인을 본다 — 확인과 쓰기 사이에 봉인이
    /// 끼어들 틈이 없다(먼저 확인하고 나중에 잠그면 정확히 그 틈이 생긴다).
    pub fn lock_for_write(&self) -> Result<MutexGuard<'_, Vault>, String> {
        let guard = self.lock();
        if sealed(&self.seal) {
            return Err(ERR_WRITES_SEALED.to_string());
        }
        Ok(guard)
    }

    /// 저장소 핸들만 복제하고 잠금을 즉시 놓는다 — O(전체 노트) **읽기** 전용
    /// (`note_list`·`note_search`가 잠금을 오래 쥐지 않으려고 쓰는 관용구).
    pub fn snapshot(&self) -> Vault {
        self.lock().clone()
    }
}

/// 시작 시 설정·vault를 로드하고 재조정 후 상태를 등록한다.
///
/// 로컬 설정은 앱데이터의 `config.json`(기기 고유), 공유 설정은 vault의 `.memo/`에서
/// 읽는다. vault 경로가 로컬 설정에만 있으므로 순환이 생기지 않는다.
pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let app_data = app.path().app_data_dir()?;
    let documents = app.path().document_dir()?;
    let config_path = app_data.join("config.json");
    let mut config = settings::load_local_config(&config_path, &documents);
    let shared = settings::load_shared_settings(&config.vault_path);
    let vault = Vault::new(&config.vault_path);

    match reconcile::reconcile(&vault.notes_dir()) {
        Ok(report) if !report.conflicts.is_empty() => {
            eprintln!("[memo] 동기화 충돌본 감지: {:?}", report.conflicts);
        }
        Ok(_) => {}
        Err(e) => eprintln!("[memo] 시작 재조정 실패: {e}"),
    }

    cleanup_and_welcome(
        &vault,
        &mut config,
        &config_path,
        shared.language.as_deref(),
    );

    app.manage(AppState::new(vault, shared, config));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 빈 노트는 정리되고 내용 있는 노트는 남는다.
    #[test]
    fn cleanup_removes_blank_keeps_content() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let blank = vault.create_note("   \n\t").unwrap();
        let kept = vault.create_note("# 내용").unwrap();
        let mut config = LocalConfig::with_defaults(dir.path());
        config.welcomed = true; // 환영 생성은 끄고 정리만 확인
        cleanup_and_welcome(&vault, &mut config, &dir.path().join("config.json"), None);
        let ids = vault.list_note_ids().unwrap();
        assert!(!ids.contains(&blank));
        assert!(ids.contains(&kept));
    }

    /// 가드: 첫 실행(노트 없음·welcomed=false)에 환영 노트가 생기고 플래그가 켜진다.
    /// 둘째 실행에선 중복 생성하지 않는다.
    #[test]
    fn first_run_seeds_welcome_once() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let config_path = dir.path().join("config.json");
        let mut config = LocalConfig::with_defaults(dir.path());
        assert!(!config.welcomed);

        cleanup_and_welcome(&vault, &mut config, &config_path, None);
        assert_eq!(vault.list_note_ids().unwrap().len(), 1);
        assert!(config.welcomed);

        cleanup_and_welcome(&vault, &mut config, &config_path, None);
        assert_eq!(vault.list_note_ids().unwrap().len(), 1);
    }

    /// 가드: 환영 노트가 활성 언어를 따르고, 단축키 자리가 이 OS 표기로 채워진다.
    ///
    /// 예전엔 본문이 ko로 하드코딩됐고 `⌘⇧N`이 박혀 있어, Windows 사용자에게 있지도 않은 키를
    /// 안내했다. `{shortcut}`가 남아 있으면 치환을 빠뜨린 것이므로 그것도 함께 막는다.
    #[test]
    fn welcome_follows_language_and_os_shortcut() {
        let read_welcome = |language: Option<&str>| {
            let dir = tempfile::tempdir().unwrap();
            let vault = Vault::new(dir.path());
            let mut config = LocalConfig::with_defaults(dir.path());
            cleanup_and_welcome(
                &vault,
                &mut config,
                &dir.path().join("config.json"),
                language,
            );
            let id = vault.list_note_ids().unwrap().pop().unwrap();
            vault.read_content(&id).unwrap()
        };

        // 그림은 alt에 표시 폭을 실어 넣는다 — 원본(2048px)이 그대로 펼쳐지면 첫 노트가 그림만 남는다.
        let logo_md = format!("![note-rang w={WELCOME_LOGO_WIDTH}](attachments/");
        let ko = read_welcome(Some("ko"));
        assert!(ko.contains("안녕, 나는 note-rang"));
        assert!(ko.contains(&logo_md));
        let en = read_welcome(Some("en"));
        assert!(en.contains("Welcome to note-rang"));
        assert!(en.contains(&logo_md));
        assert!(!en.contains("메모에 오신"));

        // 치환이 끝났고, 이 OS의 표기가 들어간다(mac은 글리프, 그 외는 Ctrl+Shift+N).
        for body in [&ko, &en] {
            assert!(!body.contains("{shortcut}"), "치환되지 않은 자리: {body}");
            assert!(body.contains(WELCOME_SHORTCUT));
            #[cfg(not(target_os = "macos"))]
            assert!(!body.contains('⌘'), "맥 전용 글리프가 남았다: {body}");
        }
    }

    /// 가드(#24): 임계구역에서 패닉이 나 잠금이 중독돼도 이후 접근이 계속 성공한다.
    ///
    /// 예전 구조(`lock().map_err(..)?`)에서는 이 시점부터 모든 노트 커맨드가 영구히
    /// "내부 상태 잠금 오류"가 됐다 — 노트 하나의 사고가 앱 전체를 죽이던 경로다.
    #[test]
    fn poisoned_lock_recovers_instead_of_cascading() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            Vault::new(dir.path()),
            SharedSettings::default(),
            LocalConfig::with_defaults(dir.path()),
        );

        // 잠금을 쥔 채 패닉시켜 중독시킨다(다른 커맨드의 패닉을 흉내).
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.vault.lock().unwrap();
            panic!("임계구역 패닉");
        }));
        assert!(poisoned.is_err());
        assert!(
            state.vault.is_poisoned(),
            "중독되지 않으면 이 가드가 무의미하다"
        );

        // 중독 뒤에도 정상 동작해야 한다 — 잠기고, 실제 저장소 조작까지 성공한다.
        let id = state.lock_vault().create_note("복구 확인").unwrap();
        assert_eq!(state.lock_vault().read_content(&id).unwrap(), "복구 확인");
        // 다른 두 잠금도 같은 규칙을 따른다.
        let _ = state.lock_shared().language.clone();
        let _ = state.lock_config().global_hotkey.clone();
    }

    /// 상태 조립 헬퍼 — 테스트가 tempdir 하나로 AppState를 만든다.
    fn state_for(dir: &Path) -> AppState {
        AppState::new(
            Vault::new(dir),
            SharedSettings::default(),
            LocalConfig::with_defaults(dir),
        )
    }

    /// 가드: 봉인 중에는 쓰기 잠금이 거부되고, 가드를 놓으면 곧바로 다시 열린다.
    /// 읽기 잠금은 봉인과 무관하게 계속 된다(읽기는 아무것도 되살리지 않는다).
    #[test]
    fn seal_blocks_writes_until_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_for(dir.path());
        let handle = state.vault_handle();

        assert!(!state.writes_sealed());
        assert!(handle.lock_for_write().is_ok());

        let seal = state.seal_note_writes();
        assert!(state.writes_sealed());
        let denied = handle
            .lock_for_write()
            .err()
            .expect("봉인 중엔 거부돼야 한다");
        assert!(denied.starts_with("VAULT_BUSY"), "오류 코드: {denied}");
        assert!(state.lock_vault_for_write().is_err());
        // 읽기는 막지 않는다.
        assert!(handle.lock().list_note_ids().is_ok());

        drop(seal);
        assert!(!state.writes_sealed());
        assert!(handle.lock_for_write().is_ok());
    }

    /// 가드: 봉인은 중첩된다 — 안쪽 가드를 놓아도 바깥 가드가 살아 있으면 여전히 봉인이다.
    #[test]
    fn seal_nests() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_for(dir.path());
        let outer = state.seal_note_writes();
        {
            let _inner = state.seal_note_writes();
            assert!(state.writes_sealed());
        }
        assert!(state.writes_sealed(), "바깥 봉인이 남아 있어야 한다");
        drop(outer);
        assert!(!state.writes_sealed());
    }

    /// 가드: [`VaultHandle`]은 사본이 아니라 **같은 잠금**을 공유한다 — 핸들을 워커로
    /// 넘겨도 저장 폴더 이전이 교체한 새 경로를 즉시 본다(사본이면 옛 경로에 계속 쓴다).
    #[test]
    fn vault_handle_shares_the_lock_not_a_copy() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let state = state_for(old.path());
        let handle = state.vault_handle();
        assert_eq!(handle.lock().root(), &old.path().to_path_buf());

        *state.lock_vault() = Vault::new(new.path());
        assert_eq!(
            handle.lock().root(),
            &new.path().to_path_buf(),
            "핸들이 교체된 경로를 봐야 한다"
        );

        // 잠금을 쥐고 있으면 핸들 쪽 쓰기는 기다린다(이동 구간의 직렬화 근거).
        let guard = state.lock_vault();
        let waiting = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let flag = std::sync::Arc::clone(&waiting);
        let worker = std::thread::spawn(move || {
            let _v = handle.lock();
            flag.store(1, Ordering::Release);
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(waiting.load(Ordering::Acquire), 0, "잠금 중엔 못 들어온다");
        drop(guard);
        worker.join().unwrap();
        assert_eq!(waiting.load(Ordering::Acquire), 1);
    }

    /// 가드: 이미 환영했으면(welcomed=true) 빈 vault라도 환영 노트를 만들지 않는다.
    #[test]
    fn no_welcome_when_already_welcomed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let mut config = LocalConfig::with_defaults(dir.path());
        config.welcomed = true;
        cleanup_and_welcome(&vault, &mut config, &dir.path().join("config.json"), None);
        assert!(vault.list_note_ids().unwrap().is_empty());
    }
}
