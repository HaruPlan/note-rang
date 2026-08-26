//! 메모 앱 Tauri 백엔드 진입점.
//!
//! 역할: 앱 부트스트랩 — 시스템 트레이를 구성하고 메뉴 이벤트를 라우팅한다.
//! 창·노트·저장 등 구체 기능은 이후 마일스톤에서 별도 모듈로 추가된다.

mod commands;
mod i18n;
mod jumplist;
mod plugin_commands;
mod state;
mod tray;
mod updater;
mod window_manager;
mod windows;

pub mod attachments;
pub mod backup;
pub mod display;
pub mod fonts;
pub mod io;
pub mod model;
pub mod net;
pub mod notes;
pub mod plugin_i18n;
pub mod plugin_install;
pub mod plugin_storage;
pub mod plugin_sync;
pub mod plugins;
pub mod reconcile;
pub mod search;
pub mod settings;
pub mod trash;
pub mod vault_move;
pub mod watcher;

// D3 새 노트 생성(`setup()`)·`handle_second_instance`의 emit은 이제 `window_manager::
// create_and_open_sync`/`create_and_open` 안으로 옮겨 갔다(그 파일이 이미 `Emitter`를
// 갖는다) — 이 파일에 남은 유일한 사용처는 Windows 전용 `on_note_window_event`뿐이라
// `cfg`로 다시 가린다.
#[cfg(target_os = "windows")]
use tauri::Emitter;
use tauri::Manager;

/// 로컬 설정의 전역 단축키를 등록한다(눌리면 새 노트). 실패는 비치명적으로 로깅만.
fn register_global_hotkey(app: &tauri::App) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let hotkey = app
        .state::<state::AppState>()
        .lock_config()
        .global_hotkey
        .clone();
    if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
        eprintln!("[memo] 전역 단축키 등록 실패({hotkey}): {e}");
    }
}

/// OS 로그인 항목을 `want`에 맞춘다(켜거나 끈다). **디버그(개발) 빌드에서는 건너뛴다** —
/// 개발/테스트가 사용자의 실제 로그인 항목을 건드리지 않게 하기 위함.
///
/// `pub(crate)`인 이유: 부팅 시 1회([`sync_autostart`])뿐 아니라 설정 초기화 커맨드
/// ([`commands::reset_settings`])도 `launch_at_login`을 기본값으로 되돌린 뒤 같은 동기화를
/// 다시 태워야 한다 — 그 시점엔 `&tauri::App`이 없고 `&tauri::AppHandle`만 있으므로, 상태
/// 조회(`want` 계산)를 호출부로 넘기고 이 함수는 순수하게 "반영"만 한다.
pub(crate) fn sync_autostart_state(app: &tauri::AppHandle, want: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if want {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = result {
        eprintln!("[memo] 자동 실행 설정 실패: {e}");
    }
}

/// OS 로그인 항목을 로컬 설정(`launch_at_login`)에 맞춘다(부팅 시 1회).
fn sync_autostart(app: &tauri::App) {
    let want = app.state::<state::AppState>().lock_config().launch_at_login;
    sync_autostart_state(app.handle(), want);
}

/// 부팅 자동시작(로그인 항목)으로 실행됐을 때 [`tauri_plugin_autostart::init`]이 프로세스에
/// 실어 주는 인자(D2 판별 신호) — [`launched_by_autostart`]가 이 리터럴 하나만 찾는다.
///
/// **주의(기존 설치 전제)**: 이 앱을 이미 자동시작으로 등록해 둔 사용자의 로그인 항목은 OS가
/// 예전 실행 커맨드라인(이 인자 없이)을 그대로 들고 있다 — 다음 부팅부터 곧바로 반영되지
/// 않는다. `sync_autostart`가 매 부팅 `launch_at_login`이 true인 한 [`sync_autostart_state`]의
/// `enable()`을 다시 부르고, 그 안에서 플러그인이 로그인 항목의 실행 커맨드라인을 (지금 이
/// `init` 인자를 포함해) 재등록하므로 **그다음** 재부팅부터 이 인자가 실린다. 단
/// [`sync_autostart_state`]는 디버그(개발) 빌드에서 조기 return하므로 이 재등록 자체가
/// **릴리스 빌드에서만** 일어난다 — 개발 빌드를 자동시작으로 등록해 둔 채 반복 실행해도 이
/// 전제는 검증되지 않는다. **수용된 한계(리뷰 지적 m8)**: 그래서 업그레이드 직후 첫 자동시작
/// 1회는(재등록이 그 실행 안에서야 일어나므로) 이 인자를 아직 모른 채 부팅해 D1 경로를 타
/// 패널이 뜰 수 있다 — 그다음 부팅부터는 정상화된다.
const ARG_AUTOSTART: &str = "--autostart";

/// 프로세스 인자에 `--autostart`가 있으면 부팅 자동시작(로그인 항목)으로 실행된 것이다(D2) —
/// 순수 함수라 GUI·OS 없이 테스트 가능. 점프 리스트 인자(`jumplist::ARG_*`)와는 리터럴이
/// 겹치지 않으므로 `jumplist::action_from_args`가 이 인자를 자기 동작으로 오인하지 않는다
/// (그 함수는 `--new-note`/`--panel`/`--settings` 셋만 인식하고 나머지는 무시한다).
fn launched_by_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == ARG_AUTOSTART)
}

/// [`settings::LocalConfig::startup_no_active_action`]을 분기 가능한 형태로 바꾼 것(D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupNoActiveAction {
    /// 노트 목록 패널만 연다(기본값).
    Panel,
    /// 새 노트를 만들어 열고, 패널도 함께 연다(D1).
    NewNote,
}

/// `raw`(`LocalConfig.startup_no_active_action`)를 분기 가능한 열거형으로 읽는다. 알 수 없는
/// 값은 `Panel`로 폴백한다 — 어휘 자체는 [`settings::STARTUP_NO_ACTIVE_PANEL`]·
/// [`settings::STARTUP_NO_ACTIVE_NEW_NOTE`] 상수를 재사용한다(문자열 리터럴을 여기서 다시
/// 쓰면 어휘가 두 곳으로 갈려 하나만 고쳤을 때 조용히 어긋난다).
fn startup_no_active_action(raw: &str) -> StartupNoActiveAction {
    if raw == settings::STARTUP_NO_ACTIVE_NEW_NOTE {
        StartupNoActiveAction::NewNote
    } else {
        StartupNoActiveAction::Panel
    }
}

/// [`startup_plan`]의 결과 — `setup()`과 `handle_second_instance` 둘 다 이 값만 보고
/// 움직인다(둘의 분기 로직이 조용히 갈라지지 않도록 판정 자체를 한 곳에 모은다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartupPlan {
    /// D3: 새 노트를 만들어 열어야 하는가.
    open_new_note: bool,
    /// D1: 패널을 열어야 하는가.
    open_panel: bool,
}

/// D1~D4를 조합한 순수 판정(리뷰 지적 m16 — 조합 자체가 어디서도 테스트되지 않던 문제).
///
/// `autostart`(D2)나 `jumplist_action`(D4의 예외 — 점프 리스트 인자가 이미 이 실행의 유일한
/// 의도)이면 둘 다 하지 않는다. 그 외에는 D1(패널은 활성 노트·설정과 무관하게 항상)과
/// D3(활성 노트가 하나도 없고 설정이 "새 노트"일 때만 새 노트)를 계산한다.
fn startup_plan(
    autostart: bool,
    jumplist_action: bool,
    opened_any: bool,
    action: StartupNoActiveAction,
) -> StartupPlan {
    if autostart || jumplist_action {
        return StartupPlan {
            open_new_note: false,
            open_panel: false,
        };
    }
    StartupPlan {
        open_new_note: !opened_any && action == StartupNoActiveAction::NewNote,
        open_panel: true,
    }
}

/// 두 번째 인스턴스 실행(이슈 #27) 콜백 — 새 프로세스를 띄우는 대신 기존 인스턴스로 넘어온다.
///
/// `argv`에 작업 표시줄 점프 리스트가 넘긴 인자([`jumplist::action_from_args`])가 있으면 **그
/// 동작만** 하고 끝낸다: 사용자가 "새 노트"를 눌렀는데 숨겨 둔 노트가 전부 튀어나오는 편이
/// 더 놀랍기 때문이다. 그 외(맨손 재실행 등)에는 아래 기존 동작을 그대로 탄다.
///
/// 열린 노트 창이 있으면(트레이 "모두 보기"와 같은 경로로) 모두 보이게 하고 맨 앞으로 올린 뒤,
/// 그중 하나에 OS 포커스를 준다. **열린 노트 창이 하나도 없으면**(전부 보관되었거나 시작
/// 전) [`startup_plan`]으로 D3/D4를 그대로 적용한다 — 사용자가 재실행한 의도(앱과
/// 상호작용하려는 것)에 맞는 진입점을 항상 하나는 보장한다. `cwd`는 이 앱에 의미가 없어
/// 쓰지 않는다.
///
/// [`window_manager::create_and_open_sync`]를 쓰는 이유(동기 경로 — 리뷰 지적 m6): 트레이는
/// 이미 살아 있어 `setup()`이 겪는 레이스는 없지만, 대신 **막 새로 뜨는 패널**이 문제다 —
/// 비동기(`create_and_open`) 경로면 패널의 초기 `note_list()`가 아직 안 끝난 워커의(방금 만든
/// 노트가 없는) 스냅샷을 찍어 버리고, 그 뒤 도착하는 `EV_NOTES_LIST_CHANGED`를 리스너 타이밍에
/// 따라 놓칠 수 있다(vault가 느리면 패널이 방금 만든 노트 없이 남는다) — 그 함수 문서 참고.
///
/// **포커스 순서(오케스트레이터 발견)**: 새 노트를 **패널보다 먼저** 열지 않는다 — 나중에
/// 여는 창이 마지막 포커스를 가져가므로, 사용자가 "새 메모 띄우기"를 골랐다면 새 노트가
/// 마지막 포커스를 가져야 한다(패널이 나중에 뜨면 패널이 그 포커스를 가로챈다). 그래서
/// 아래 순서는 **패널 먼저, 새 노트 나중**이다 — `setup()`도 같은 순서를 따른다.
fn handle_second_instance(app: &tauri::AppHandle, argv: &[String]) {
    if let Some(action) = jumplist::action_from_args(argv) {
        jumplist::dispatch(app, action);
        return;
    }

    // "모두 보기"와 같은 조립(show + raise)을 그대로 재사용한다 — 두 진입점이 갈라지지 않게.
    let _ = window_manager::set_all_notes_visible(app.clone(), true);

    let note_windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("note-"))
        .collect();

    if note_windows.is_empty() {
        // 노트 창이 하나도 없다(D3/D4의 "활성 노트 0개") — autostart/jumplist는 이미 위에서
        // 걸러졌으므로(jumplist는 이 함수 맨 위에서 return, autostart는 애초에 재실행 시
        // 일어나지 않는다) 둘 다 false로 넘긴다.
        let action = app
            .try_state::<state::AppState>()
            .map(|state| {
                let raw = state.lock_config().startup_no_active_action.clone();
                startup_no_active_action(&raw)
            })
            .unwrap_or(StartupNoActiveAction::Panel);
        let plan = startup_plan(false, false, false, action);

        // 패널을 먼저 연다(포커스 순서 — 위 문서 참고).
        if plan.open_panel {
            if let Err(e) = window_manager::open_panel(app) {
                eprintln!("[memo] 두 번째 인스턴스: 패널 열기 실패: {e}");
            }
        }
        if plan.open_new_note {
            if let Err(e) = window_manager::create_and_open_sync(app) {
                eprintln!("[memo] 두 번째 인스턴스: 새 노트 생성 실패: {e}");
            }
        }
    } else {
        // show()/raise만으로는 Windows에서 OS 포커스까지 옮겨오지 않을 수 있어 명시적으로 요청한다.
        for (_, window) in note_windows {
            let _ = window.set_focus();
        }
    }
}

/// 모든 창의 이벤트를 받는 전역 훅(`Builder::on_window_event`) — 노트 창이 파괴될 때 트레이
/// 「열린 노트」 갱신 신호를 낸다(Windows 전용).
///
/// **왜 필요한가(찾은 결함 수정 — 트레이 「열린 노트」가 창 열림/닫힘을 반영하지 않던 문제)**:
/// `window_manager::open_note_window_impl`이 창 **생성** 성공 시 이미
/// [`window_manager::EV_NOTES_LIST_CHANGED`]를 낸다(그 함수 문서 참고) — 그 짝인 창 **파괴**
/// 쪽은 사용자가 창의 X 버튼을 누르는 등 OS가 직접 트리거하므로 `window_manager` 안의 어떤
/// 함수도 그 경로를 가로챌 수 없다. 이 훅은 `tauri::Builder`에만 등록 가능하고(`App`이 만들어진
/// 뒤인 `tray::setup_tray`의 `.setup()` 안에서는 이미 늦다), `tray.rs`는 `Builder`에 접근하지
/// 못하므로 이 함수가 `lib.rs`에 있다 — `window_manager::EV_NOTES_LIST_CHANGED`를
/// `pub(crate)`로 열어 가져다 쓴다(그 상수 문서 참고).
///
/// 노트 창이 아닌 다른 창(패널·설정·플러그인 호스트)이나 `Destroyed` 외의 이벤트는 무시한다 —
/// 「열린 노트」 목록은 `note-` 접두 창의 존재 여부로만 정의된다(`tray::open_notes_for_menu`와
/// 같은 기준). macOS는 이 문제 자체가 없던 플랫폼이라(`tray.rs` 모듈 문서) 아무 일도 하지
/// 않는다 — 프론트 패널의 불필요한 재조회를 막기 위해 이벤트 자체를 내지 않는다.
fn on_note_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "windows")]
    {
        if matches!(event, tauri::WindowEvent::Destroyed) && window.label().starts_with("note-") {
            let _ = window
                .app_handle()
                .emit(window_manager::EV_NOTES_LIST_CHANGED, ());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, event);
    }
}

/// Tauri 앱을 구성하고 실행한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 싱글 인스턴스(이슈 #27) — 공식 권장대로 다른 플러그인보다 먼저 등록한다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_second_instance(app, &argv);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    // 등록된 단축키(전역 새 노트)가 눌릴 때만 동작.
                    if event.state() == ShortcutState::Pressed {
                        if let Err(e) = window_manager::create_and_open(app) {
                            eprintln!("[memo] 단축키 새 노트 실패: {e}");
                        }
                    }
                })
                .build(),
        )
        // 두 번째 인자(`args`)는 OS가 로그인 항목으로 이 앱을 실행할 때 프로세스에 실어 주는
        // 인자다 — `ARG_AUTOSTART`/`launched_by_autostart` 문서 참고(D2 판별 신호, 기존
        // 설치의 로그인 항목은 다음 재부팅 재등록 전까지 이 인자를 모른다는 전제 포함).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![ARG_AUTOSTART]),
        ))
        .plugin(tauri_plugin_dialog::init())
        // 클립보드는 웹뷰가 아니라 OS에 직접 쓴다 — Windows(WebView2)에서 `navigator.clipboard`가
        // 조용히 거절되던 경로의 정본 대체다(프론트는 이 실패 시에만 웹 API로 떨어진다).
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 트레이 「열린 노트」가 창 닫힘도 반영하도록 — `on_note_window_event` 문서 참고.
        // 창 생성이 아니라 이 훅에서만 등록 가능한 이유(늦으면 안 되는 이유)도 그 문서에 있다.
        .on_window_event(on_note_window_event)
        .setup(|app| {
            // state::init을 트레이보다 먼저 호출한다 — 트레이 초기 라벨이 저장된
            // SharedSettings.language를 즉시 반영하려면(i18n::resolve) AppState가 이미
            // managed 상태여야 한다(tray.rs::setup_tray 문서 참고).
            state::init(app)?;
            // 플러그인 중앙 호스트(숨김 상주 창)를 노트 창들보다 먼저 띄운다 — 노트 창은
            // 이 창의 디스크립터 스냅샷을 기다린다(부재 시 폴백). 실패는 비치명적(로깅만).
            if let Err(e) = window_manager::open_plugin_host(app.handle()) {
                eprintln!("[memo] 플러그인 호스트 창 생성 실패: {e}");
            }
            let opened_any = window_manager::open_startup_windows(app.handle());
            // D1~D4(시작 흐름) — 트레이를 만들기 **전에** 끝낸다(아래에서 이어 설명).
            // [`startup_plan`]이 조합 판정을 맡는다(리뷰 지적 m16 — `handle_second_instance`와
            // 같은 함수를 써서 두 분기가 조용히 갈라지지 않게 한다).
            let action = {
                let state = app.state::<state::AppState>();
                let raw = state.lock_config().startup_no_active_action.clone();
                startup_no_active_action(&raw)
            };
            let plan = startup_plan(
                launched_by_autostart(std::env::args()),
                jumplist::action_from_args(std::env::args()).is_some(),
                opened_any,
                action,
            );
            // 패널을 새 노트보다 **먼저** 연다(오케스트레이터 발견 — 포커스 순서): 나중에
            // 여는 창이 마지막 OS 포커스를 가져간다. 사용자가 "새 메모 띄우기"를 골랐다면
            // 그 새 노트가 마지막 포커스를 가져야 하므로, 패널을 먼저 띄운 뒤 새 노트를
            // 그 위에 덧띄운다 — 순서가 반대면 패널이 새 노트의 포커스를 가로챈다.
            if plan.open_panel {
                if let Err(e) = window_manager::open_panel(app.handle()) {
                    eprintln!("[memo] 시작 시 패널 열기 실패: {e}");
                }
            }
            if plan.open_new_note {
                // **동기 경로**([`window_manager::create_and_open_sync`]) — `create_and_open`은
                // 실제 생성을 `spawn_blocking` 워커로 미루고 즉시 반환하므로, 그 워커가 끝나기
                // 전에 이 클로저가 먼저 `tray::setup_tray`로 넘어가 버려 트레이 초기 「열린
                // 노트」 스냅샷이 방금 만든 창을 놓치는 레이스가 생긴다(비평 피드백으로 확인 —
                // macOS는 애초에 그 섹션을 이벤트로 갱신하지 않으므로 다음 언어 변경/설정
                // 재적용 때까지 아예 안 보이게 된다). 동기로 끝내면 `tray::setup_tray`가 돌 때
                // 이미 새 창이 있어 그 레이스 자체가 없다.
                if let Err(e) = window_manager::create_and_open_sync(app.handle()) {
                    eprintln!("[memo] 시작 시 새 노트 생성 실패: {e}");
                }
            }
            // 트레이는 시작 복원(`open_startup_windows`)과 위 D1~D4 처리 **뒤에** 만든다
            // (찾은 결함 수정 — 예전엔 이 순서가 반대라 초기 「열린 노트」 섹션이 항상 빈
            // 목록이었다: 트레이가 먼저 만들어질 때는 아직 복원된 노트 창이 하나도 없기
            // 때문이다. 창 복원과 위에서 만들 수 있는 새 노트 모두 이 시점엔 트레이의
            // `notes-list-changed` 리스너가 아직 없어 emit만으로는 반영되지 않으므로, 순서
            // 자체로 정확성을 보장하는 편이 이벤트 타이밍에 의존하는 것보다 단순하고
            // 확실하다). `tray.rs::setup_tray` 문서 참고.
            tray::setup_tray(app)?;
            register_global_hotkey(app);
            sync_autostart(app);
            // 작업 표시줄 우클릭 메뉴(점프 리스트)의 Tasks 등록 — Windows 전용, 그 외 no-op.
            // 언어가 바뀌면 트레이와 같은 지점에서 다시 등록된다(tray::refresh_for_language_change).
            jumplist::refresh(app.handle());
            // **최초 실행**이 점프 리스트 항목에서 시작된 경우 — 이 프로세스가 첫 인스턴스라
            // `handle_second_instance`가 불리지 않으므로, 같은 인자를 여기서 똑같이 푼다.
            // 창 복원(`open_startup_windows`) **뒤에** 두어 요청한 창이 맨 위에 오게 한다.
            if let Some(action) = jumplist::action_from_args(std::env::args()) {
                jumplist::dispatch(app.handle(), action);
            }
            // 릴리스 빌드에서만, 새 버전이 있을 때만 말을 건다(updater.rs). 네트워크 왕복은
            // 별도 태스크로 빠지므로 부팅을 붙잡지 않는다.
            updater::check_on_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            windows::set_window_alpha,
            windows::set_always_on_top,
            windows::set_visible_on_all_spaces,
            commands::note_list,
            commands::note_read,
            commands::note_create,
            commands::note_create_and_open,
            commands::note_duplicate,
            commands::note_save_content,
            commands::note_save_overrides,
            commands::note_delete,
            commands::note_write,
            commands::note_list_snapshots,
            commands::note_list_snapshot_note_ids,
            commands::note_read_snapshot,
            commands::note_restore_snapshot,
            commands::note_archive,
            commands::note_set_favorite,
            commands::claim_guide_note,
            commands::note_search,
            commands::get_shared_settings,
            commands::save_shared_settings,
            commands::reset_settings,
            commands::wipe_all_data,
            commands::get_global_hotkey,
            commands::set_global_hotkey,
            commands::get_startup_no_active_action,
            commands::set_startup_no_active_action,
            commands::get_panel_sort,
            commands::set_panel_sort,
            commands::get_platform,
            commands::list_system_fonts,
            commands::get_vault_path,
            commands::get_vault_info,
            commands::mark_vault_prompted,
            commands::pick_vault_folder,
            commands::inspect_vault_folder,
            commands::change_vault_path,
            commands::export_backup,
            commands::pick_backup_file,
            commands::inspect_backup,
            commands::import_backup,
            commands::save_attachment,
            commands::open_external_url,
            net::net_fetch,
            plugin_commands::get_plugins_dir,
            plugin_commands::pick_plugin_dir,
            plugin_commands::list_installed_plugins,
            plugin_commands::list_rejected_plugins,
            plugin_commands::read_plugin_code,
            plugin_commands::read_plugin_readme,
            plugin_commands::set_plugin_enabled,
            plugin_commands::set_plugin_granted,
            plugin_commands::set_plugin_pending_reserved,
            plugin_commands::set_plugin_setting,
            plugin_commands::list_language_packs,
            plugin_commands::read_locale_entries,
            plugin_commands::list_builtin_states,
            plugin_commands::set_builtin_enabled,
            plugin_commands::list_builtin_settings,
            plugin_commands::set_builtin_setting,
            plugin_commands::remove_plugin,
            plugin_commands::fetch_plugin_for_install,
            plugin_commands::confirm_plugin_install,
            plugin_commands::cancel_plugin_install,
            plugin_commands::list_missing_plugins,
            plugin_commands::dismiss_missing_plugin,
            plugin_commands::set_dev_plugin,
            plugin_commands::get_plugin_storage,
            plugin_commands::set_plugin_storage,
            plugin_commands::remove_plugin_storage,
            plugin_commands::get_all_plugin_storage,
            plugin_commands::get_builtin_storage,
            plugin_commands::set_builtin_storage,
            plugin_commands::remove_builtin_storage,
            plugin_commands::get_all_builtin_storage,
            window_manager::save_window_geometry,
            window_manager::set_note_collapsed,
            window_manager::ensure_plugin_host,
            window_manager::gather_windows,
            window_manager::summon_note,
            window_manager::open_note_panel,
            window_manager::set_all_notes_visible,
            tray::set_plugin_tray_items,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드(D2): `--autostart` 인자가 있을 때만(있는 자리·다른 인자와 섞여 있어도) 자동시작
    /// 실행으로 판정한다. 없으면(빈 인자·무관한 인자만) false.
    #[test]
    fn launched_by_autostart_detects_the_flag() {
        assert!(launched_by_autostart(["--autostart"]));
        assert!(launched_by_autostart(["note-rang.exe", "--autostart"]));
        assert!(!launched_by_autostart(Vec::<&str>::new()));
        assert!(!launched_by_autostart(["--panel"]));
        assert!(!launched_by_autostart(["--new-note", "--settings"]));
    }

    /// 가드(D2/주의 확인): 점프 리스트 어휘(`--new-note`/`--panel`/`--settings`)는
    /// `--autostart`와 리터럴이 겹치지 않으므로 `jumplist::action_from_args`가 이 인자를
    /// 자기 동작으로 오인하지 않는다.
    #[test]
    fn autostart_arg_is_not_a_jumplist_action() {
        assert_eq!(jumplist::action_from_args(["--autostart"]), None);
    }

    /// 가드(D3): 두 어휘 값 각각의 분기, 그리고 알 수 없는 값·빈 문자열의 Panel 폴백.
    #[test]
    fn startup_no_active_action_parses_known_values_and_falls_back() {
        assert_eq!(
            startup_no_active_action(settings::STARTUP_NO_ACTIVE_PANEL),
            StartupNoActiveAction::Panel
        );
        assert_eq!(
            startup_no_active_action(settings::STARTUP_NO_ACTIVE_NEW_NOTE),
            StartupNoActiveAction::NewNote
        );
        assert_eq!(startup_no_active_action(""), StartupNoActiveAction::Panel);
        assert_eq!(
            startup_no_active_action("bogus-value"),
            StartupNoActiveAction::Panel
        );
    }

    /// 가드(D1~D4 조합, 리뷰 지적 m16): `startup_plan`의 전체 진리표. `setup()`과
    /// `handle_second_instance`가 `&&`를 `||`로 잘못 바꾸거나 jumplist 가드를 빠뜨리는
    /// 회귀는(이 함수를 공유하는 한) 여기 하나만 고치면 두 호출부 모두에서 잡힌다.
    #[test]
    fn startup_plan_truth_table() {
        use StartupNoActiveAction::{NewNote, Panel};

        // 자동시작(D2)이면 나머지 값과 무관하게 항상 아무 것도 하지 않는다.
        for jumplist_action in [false, true] {
            for opened_any in [false, true] {
                for action in [Panel, NewNote] {
                    let plan = startup_plan(true, jumplist_action, opened_any, action);
                    assert_eq!(
                        plan,
                        StartupPlan {
                            open_new_note: false,
                            open_panel: false
                        },
                        "autostart=true, jumplist={jumplist_action}, opened_any={opened_any}, action={action:?}"
                    );
                }
            }
        }

        // 점프 리스트 인자(D4의 예외)면 autostart=false여도 역시 아무 것도 하지 않는다.
        for opened_any in [false, true] {
            for action in [Panel, NewNote] {
                let plan = startup_plan(false, true, opened_any, action);
                assert_eq!(
                    plan,
                    StartupPlan {
                        open_new_note: false,
                        open_panel: false
                    },
                    "jumplist=true, opened_any={opened_any}, action={action:?}"
                );
            }
        }

        // 정상 경로(자동시작도 점프 리스트도 아님) — D1: 패널은 항상. D3: 활성 노트가 없고
        // 설정이 NewNote일 때만 새 노트.
        assert_eq!(
            startup_plan(false, false, true, Panel),
            StartupPlan {
                open_new_note: false,
                open_panel: true
            }
        );
        assert_eq!(
            startup_plan(false, false, true, NewNote),
            StartupPlan {
                open_new_note: false,
                open_panel: true
            },
            "활성 노트가 이미 있으면 설정이 새 노트여도 또 만들지 않는다"
        );
        assert_eq!(
            startup_plan(false, false, false, Panel),
            StartupPlan {
                open_new_note: false,
                open_panel: true
            }
        );
        assert_eq!(
            startup_plan(false, false, false, NewNote),
            StartupPlan {
                open_new_note: true,
                open_panel: true
            },
            "활성 노트가 없고 설정이 새 노트면 D3가 발동하고, D1대로 패널도 함께 연다"
        );
    }
}
