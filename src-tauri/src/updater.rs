//! 자동 업데이트 — GitHub Release를 채널로 쓰는 updater 배선.
//!
//! 역할: `tauri.conf.json`의 `plugins.updater.endpoints`(= 릴리스에 올라간 `latest.json`)를
//! 조회해 새 버전이 있으면 사용자에게 묻고, 승낙하면 내려받아 앱 번들을 교체한 뒤 재시작한다.
//! 확인 경로는 둘이다 — 앱 시작 직후의 조용한 자동 확인과, 트레이 「업데이트 확인…」의 수동 확인.
//!
//! 왜 프론트가 아니라 Rust인가: 이 리포의 경계 규약(Rust = 단일 진실원천, 프론트는
//! `shared/tauri.ts` 래퍼만)에 맞고, 업데이트 통신이 웹뷰 밖에서 일어나 좁혀 둔 CSP
//! (`connect-src 'self' ipc:`)를 손대지 않아도 된다. JS 의존성·capability 추가도 없다.
//!
//! **Apple 서명과는 별개 체계다**: 여기서 검증하는 서명은 minisign 키쌍(무료)이고 "이 업데이트
//! 패키지를 만든 게 개발자 본인인가"만 본다. Gatekeeper의 최초 실행 검사를 대신하지 못하므로
//! 최초 설치는 Homebrew tap이 담당하며, Gatekeeper 대응은 사용자가 필요할 때 직접 처리한다 —
//! [docs/contributing/release.md](../../docs/contributing/release.md).

use crate::i18n::{self, Strings};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 자동 업데이트가 실패했을 때 안내하는 수동 내려받기 자리.
///
/// **왜 `update.download_url`(설치 파일 직링크)이 아니라 릴리스 페이지인가.** 실패 원인의
/// 상당수는 그 설치 파일을 받는 호스트가 막혔거나 쿼터를 넘긴 것이다(사내망 403 —
/// [docs/contributing/release.md](../../docs/contributing/release.md)). 방금 거절당한 주소를
/// 다시 권하면 브라우저에서도 같은 자리에서 막힌다. 반면 이 페이지는 `github.com`에 있고,
/// **여기까지 왔다는 것은 버전 확인이 이미 `github.com`을 통과했다는 뜻**이라 열릴 가능성이
/// 훨씬 높다. 게다가 확인 단계에서 실패했으면 `Update`가 아예 없어 직링크를 만들 수도 없다 —
/// 두 실패 경로가 같은 자리를 가리키려면 상수여야 한다.
///
/// `latest`는 게시된 최신 릴리스로 GitHub이 리다이렉트해 주므로 버전을 올려도 갱신할 필요가
/// 없다. **`api.github.com`을 쓰지 않는다**(아래 가드 테스트가 고정한다).
const RELEASE_PAGE_URL: &str = "https://github.com/HaruPlan/note-rang/releases/latest";

/// 시작 시 자동 확인을 할지 판단한다(디버그 빌드에서는 하지 않는다).
///
/// 왜 순수 함수로 빼는가: `sync_autostart`(lib.rs)와 같은 판단이다 — 개발 중에 업데이트가
/// 설치되면 방금 만든 빌드 산출물이 배포본으로 덮여 사라진다. 분기를 인자로 받아 두 갈래 모두
/// 가드 테스트로 고정한다(테스트는 항상 디버그로 도니 `cfg!`를 직접 부르면 한쪽만 검증된다).
fn auto_check_enabled(is_debug_build: bool) -> bool {
    !is_debug_build
}

/// 새 버전 안내 문구 — 현재 버전과 새 버전을 함께 보여 준다.
///
/// 왜 둘 다 보여 주는가: 사용자가 "지금 뭘 쓰고 있고 뭘로 가는지"를 눌러야 판단할 수 있다.
/// 재시작이 뒤따른다는 사실도 승낙 전에 알린다(설치 후 통보하면 늦다). 문구 자체는
/// `strings.updater_prompt`(내장 로케일 테이블, [`crate::i18n`])에서 오고, 여기서는
/// `{next}`/`{current}` 플레이스홀더만 실제 버전 문자열로 치환한다.
fn update_prompt(strings: &Strings, current: &str, next: &str) -> String {
    strings
        .updater_prompt
        .replace("{next}", next)
        .replace("{current}", current)
}

/// 앱 시작 직후 조용히 업데이트를 확인한다(릴리스 빌드에서만).
///
/// 조용하다 = 새 버전이 있을 때만 말을 건다. 네트워크가 없는 곳에서 앱을 켤 때마다 오류 창이
/// 뜨면 안 되기 때문이다(실패는 stderr 로깅으로 끝낸다).
pub fn check_on_startup(app: &AppHandle) {
    if !auto_check_enabled(cfg!(debug_assertions)) {
        return;
    }
    check(app.clone(), false);
}

/// 트레이 「업데이트 확인…」 — 최신이든 실패든 결과를 항상 사용자에게 알린다.
///
/// 왜 자동 확인과 다른가: 사용자가 직접 눌렀으면 아무 반응이 없는 것이 곧 고장으로 읽힌다.
pub fn check_interactive(app: &AppHandle) {
    check(app.clone(), true);
}

/// 업데이트를 확인하고, 있으면 설치 여부를 묻는다.
///
/// `interactive`는 "결과 없음·실패도 알릴지"를 가른다([`check_on_startup`]/[`check_interactive`]).
/// 네트워크 왕복이라 반드시 비동기 태스크에서 돈다 — 메인 스레드에서 하면 앱이 멎는다.
/// 문자열 테이블은 **이 호출 시점**의 언어로 한 번 고정해([`i18n::resolve`]) 비동기 태스크에
/// 그대로 넘긴다 — 확인 도중 언어가 바뀌어도 이 확인 왕복 안에서는 다이얼로그 문구가 섞이지
/// 않는다.
fn check(app: AppHandle, interactive: bool) {
    let strings = i18n::resolve(&app);
    tauri::async_runtime::spawn(async move {
        // `updater()`는 설정(`plugins.updater`)이 없거나 공개키가 깨졌으면 여기서 Err다.
        // 그 경우도 오류 경로로 흘려보낸다 — 업데이트 채널이 없는 빌드에서 앱이 죽으면 안 된다.
        let found = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => prompt_and_install(app, update, strings),
            Ok(None) => {
                if interactive {
                    notify(
                        &app,
                        strings.updater_up_to_date,
                        MessageDialogKind::Info,
                        strings,
                    );
                }
            }
            Err(e) => {
                eprintln!("[memo] 업데이트 확인 실패: {e}");
                if interactive {
                    let message = strings
                        .updater_check_failed
                        .replace("{error}", &e.to_string());
                    notify_failure(&app, &message, MessageDialogKind::Warning, strings);
                }
            }
        }
    });
}

/// 새 버전을 알리고 승낙하면 설치로 넘긴다.
///
/// 버튼 라벨을 직접 준다("설치"/"나중에" 또는 그 언어 대역) — OS 기본 라벨(확인/취소)로는
/// 무엇이 설치인지가 문구를 다 읽어야만 드러난다.
fn prompt_and_install(app: AppHandle, update: Update, strings: &'static Strings) {
    let message = update_prompt(strings, &update.current_version, &update.version);
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title(strings.updater_dialog_title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            strings.updater_install_button.to_string(),
            strings.updater_later_button.to_string(),
        ))
        .show(move |accepted| {
            if accepted {
                install(handle, update, strings);
            }
        });
}

/// 업데이트를 내려받아 설치하고 앱을 재시작한다.
///
/// 진행률 콜백은 비워 둔다 — 노트 앱의 업데이트는 수십 MB라 진행 UI를 띄울 만큼 길지 않고,
/// 띄우려면 창을 하나 더 만들어야 해서 얻는 것보다 표면이 커진다. 실패는 사용자에게 알린다
/// (여기까지 왔으면 사용자가 설치를 명시적으로 눌렀으므로 침묵은 곧 고장으로 읽힌다).
///
/// **`app.restart()`는 macOS 전용 경로다.** Windows에서는 플러그인이 NSIS 인스톨러를
/// `ShellExecuteW`로 띄운 **직후 `std::process::exit(0)`으로 프로세스를 끝내므로**
/// `download_and_install`이 반환하지 않는다 — 아래 `Ok(())` 갈래는 Windows에서 도달하지
/// 않는다(Windows 인스톨러가 실행 중인 앱을 교체할 수 없어서 생기는 제약). Windows의 재시작은
/// `installMode: "passive"`(tauri.conf.json)가 인스톨러에 넘기는 `/R` 플래그가 담당한다.
/// 즉 이 함수를 고칠 때 "재시작이 두 번 일어나지 않나"를 걱정할 필요는 없지만, 반대로
/// **종료 직전에 할 일(저장 플러시 등)을 여기에 두면 Windows에서는 실행되지 않는다** —
/// 그런 것은 `UpdaterBuilder::on_before_exit` 훅에 걸어야 한다(현재 미사용).
fn install(app: AppHandle, update: Update, strings: &'static Strings) {
    tauri::async_runtime::spawn(async move {
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => {
                eprintln!("[memo] 업데이트 설치 실패: {e}");
                let message = strings
                    .updater_install_failed
                    .replace("{error}", &e.to_string());
                notify_failure(&app, &message, MessageDialogKind::Error, strings);
            }
        }
    });
}

/// 결과 알림 다이얼로그(확인 버튼 하나).
///
/// 논블로킹 `show`를 쓴다 — `blocking_show`는 호출 스레드를 막아, 비동기 태스크에서 부르면
/// 런타임 워커를 붙잡는다(동기 커맨드에서 부르면 메인 스레드가 멎는 것과 같은 함정).
fn notify(app: &AppHandle, message: &str, kind: MessageDialogKind, strings: &Strings) {
    app.dialog()
        .message(message)
        .title(strings.updater_dialog_title)
        .kind(kind)
        .show(|_| {});
}

/// 실패 알림 다이얼로그 — 「릴리스 페이지 열기」로 수동 내려받기 길을 함께 준다.
///
/// 왜 버튼을 다는가: 자동 업데이트 실패는 **사용자가 앱 안에서 할 수 있는 일이 없는 상태**다.
/// 오류 문자열만 띄우면 막다른 길이 되고, 실제로 사내망 403에서 그랬다. 설치 파일을 직접
/// 받는 경로가 남아 있으므로 그 자리를 한 번의 클릭으로 잇는다 — 대상은
/// [`RELEASE_PAGE_URL`](자세한 선택 이유는 그 상수의 주석).
///
/// 열기는 [`crate::commands::open_external_url`]에 위임한다(노트 본문 링크와 같은 경로 —
/// OS별 도구 선택과 스킴 allowlist가 이미 거기 있다). 실패해도 사용자에게 창을 하나 더
/// 띄우지는 않는다. 이 시점에 이미 오류 창을 하나 보여 준 뒤이고, "브라우저도 못 열었다"는
/// 사실은 사용자가 브라우저를 직접 여는 것 말고 달리 할 일이 없다 — stderr로만 남긴다.
fn notify_failure(app: &AppHandle, message: &str, kind: MessageDialogKind, strings: &Strings) {
    app.dialog()
        .message(message)
        .title(strings.updater_dialog_title)
        .kind(kind)
        .buttons(MessageDialogButtons::OkCancelCustom(
            strings.updater_open_release_button.to_string(),
            strings.updater_close_button.to_string(),
        ))
        .show(|open_release| {
            if open_release {
                if let Err(e) = crate::commands::open_external_url(RELEASE_PAGE_URL.to_string()) {
                    eprintln!("[memo] 릴리스 페이지 열기 실패: {e}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 시작 시 자동 확인은 릴리스 빌드에서만 돈다(개발 빌드가 스스로를 덮어쓰지 않게).
    #[test]
    fn auto_check_is_release_only() {
        assert!(auto_check_enabled(false));
        assert!(!auto_check_enabled(true));
    }

    /// 가드: 안내 문구(ko)가 현재 버전과 새 버전을 모두 담고 재시작을 미리 알린다.
    #[test]
    fn prompt_names_both_versions_and_restart() {
        let ko = i18n::strings(Some("ko"));
        let message = update_prompt(ko, "0.1.0", "0.2.0");
        assert!(message.contains("0.1.0"));
        assert!(message.contains("0.2.0"));
        assert!(message.contains("다시 시작"));
    }

    /// 가드: 수동 내려받기 자리는 공개 릴리스 페이지다.
    ///
    /// `api.github.com`을 막는 것이 요점이다 — 그 호스트는 인증 없이 쓰면 IP당 시간당 60회
    /// 제한을 받아, 사내망처럼 출구 IP를 공유하는 곳에서 403이 난다. 자동 경로가 바로 그
    /// 이유로 실패해 여기까지 온 상황에서 같은 호스트를 다시 권하면 탈출구가 되지 못한다.
    #[test]
    fn release_page_is_a_public_github_page() {
        assert!(RELEASE_PAGE_URL.starts_with("https://github.com/"));
        assert!(RELEASE_PAGE_URL.ends_with("/releases/latest"));
        assert!(!RELEASE_PAGE_URL.contains("api.github.com"));
    }

    /// 가드: 두 실패 문구가 수동 경로를 안내하고, 두 로케일 모두 버튼 라벨이 비지 않는다
    /// (빈 라벨은 OS 기본 라벨로 대체되지 않고 빈 버튼으로 그려진다).
    #[test]
    fn failure_messages_point_at_manual_download() {
        for locale in ["ko", "en"] {
            let s = i18n::strings(Some(locale));
            assert!(!s.updater_open_release_button.is_empty());
            assert!(!s.updater_close_button.is_empty());
            for message in [s.updater_check_failed, s.updater_install_failed] {
                assert!(message.contains("{error}"));
                let manual = if locale == "ko" {
                    "릴리스 페이지"
                } else {
                    "releases page"
                };
                assert!(message.contains(manual), "{locale}: {message}");
            }
        }
    }

    /// 가드: en 로케일에서도 두 버전이 문구에 들어가고 플레이스홀더가 남지 않는다.
    #[test]
    fn prompt_works_for_en_locale() {
        let en = i18n::strings(Some("en"));
        let message = update_prompt(en, "0.1.0", "0.2.0");
        assert!(message.contains("0.1.0"));
        assert!(message.contains("0.2.0"));
        assert!(!message.contains("{next}"));
        assert!(!message.contains("{current}"));
    }
}
