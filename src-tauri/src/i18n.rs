//! 내장 로케일 문자열 테이블 — 트레이 메뉴 · 업데이터 다이얼로그(러스트가 직접 그리는 네이티브
//! UI 텍스트).
//!
//! 역할: 서드파티 언어팩은 자바스크립트 플러그인이라 Rust가 그리는 네이티브 UI(메뉴바 트레이 ·
//! 다이얼로그) 문자열을 바꿀 수 없다. 그래서 Rust는 **내장 테이블**(ko + en)만 갖고, 그 외
//! 로케일은 ko로 폴백한다. 로케일 값 자체는 `SharedSettings.language`([`crate::model`],
//! 이미 완성)에서 오며, 등록된 로케일 판정·프론트 쪽 폴백은 `src/i18n/store.ts`가 별도로 한다 —
//! 이 모듈은 Rust 쪽에서만 쓰는 좁은 대응표다.
//!
//! 왜 struct이고 `HashMap<&str, &str>`가 아닌가: 필드로 고정하면 두 언어(EN/KO) 상수가 반드시
//! 같은 필드 집합을 채워야 컴파일이 통과한다 — 번역 하나를 빠뜨리면 그 자리에서 컴파일 에러로
//! 잡힌다. `HashMap`이었다면 키 오타·누락이 런타임에야(그것도 조용히 빈 문자열이나 `unwrap`
//! 패닉으로) 드러난다.

use tauri::Manager;

/// 내장 로케일 문자열 테이블 — 트레이 고정 메뉴 8개 + 업데이터 다이얼로그 문구.
///
/// 플레이스홀더가 있는 필드(`{next}`·`{current}`·`{error}`)는 리터럴 문자열 그대로 담고
/// 호출부가 `.replace(...)`로 치환한다 — `format!`은 컴파일 타임 리터럴만 포맷 문자열로 받을 수
/// 있어, 이 테이블처럼 런타임에 고른 `&str`을 포맷 문자열 자리에 넣을 수 없기 때문이다.
pub struct Strings {
    // 트레이 고정 메뉴(tray.rs) — 필드 순서는 메뉴 표시 순서와 같다.
    pub tray_new_note: &'static str,
    pub tray_panel: &'static str,
    pub tray_settings: &'static str,
    pub tray_check_update: &'static str,
    pub tray_show_all: &'static str,
    pub tray_hide_all: &'static str,
    /// 「열린 노트」 서브메뉴 제목(tray.rs) — 현재 열린 노트 창을 제목으로 나열해 클릭 시
    /// 포커스한다. Windows에서 borderless 노트 창의 작업 표시줄 우클릭 메뉴가 부실할 때의
    /// 대체 진입점(이슈 #15).
    pub tray_open_notes: &'static str,
    pub tray_quit: &'static str,

    // 작업 표시줄 점프 리스트의 Tasks 항목(jumplist.rs, Windows 전용) — 트레이 앞 세 항목과
    // 같은 동작이지만 라벨을 따로 둔다: 트레이는 "메뉴가 창/대화상자를 연다"는 뜻의 말줄임표
    // (`…`) 관례를 따르고, 점프 리스트 Tasks는 그 관례가 없어(크롬 "새 창"처럼) 말줄임표를
    // 쓰지 않는다. 같은 상수를 공유하면 둘 중 한쪽이 반드시 어색해진다.
    pub jumplist_new_note: &'static str,
    pub jumplist_panel: &'static str,
    pub jumplist_settings: &'static str,

    // 업데이터 다이얼로그(updater.rs).
    pub updater_dialog_title: &'static str,
    /// 새 버전 안내. 플레이스홀더: `{next}`(새 버전) · `{current}`(현재 버전).
    pub updater_prompt: &'static str,
    pub updater_up_to_date: &'static str,
    pub updater_install_button: &'static str,
    pub updater_later_button: &'static str,
    /// 확인 실패 문구. 플레이스홀더: `{error}`.
    pub updater_check_failed: &'static str,
    /// 설치 실패 문구. 플레이스홀더: `{error}`.
    pub updater_install_failed: &'static str,
    /// 실패 다이얼로그의 수동 내려받기 버튼 — 릴리스 페이지를 기본 브라우저로 연다.
    pub updater_open_release_button: &'static str,
    /// 실패 다이얼로그의 닫기 버튼. 「나중에」와 달리 나중에 다시 묻지 않는다는 뜻이 없다.
    pub updater_close_button: &'static str,

    /// 첫 실행 환영 노트 본문(state.rs). 플레이스홀더: `{shortcut}`(전역 새-노트 단축키 표기 —
    /// 호출부가 실행 중인 OS에 맞는 표기로 치환한다), `{logo}`(note-rang 캐릭터 이미지). 이 노트도 Rust가 만드는 산출물이라
    /// 언어팩(자바스크립트)이 닿지 못하므로 여기 내장 테이블에 둔다.
    pub welcome_note: &'static str,

    // 노트/패널/설정 창 타이틀(window_manager.rs) — 언어별 앱·창 표시 이름. tauri.conf.json의
    // productName("Note Rang")·macOS Info.plist 로컬라이즈(infoplist/*.lproj)와 표기를 맞춘다.
    /// 빈 노트 창의 기본 타이틀 — 한국어 "노트랑", 영어 "Note Rang".
    pub app_name: &'static str,
    /// 노트 목록·검색 패널 창 타이틀.
    pub panel_title: &'static str,
    /// 설정·플러그인 매니저 창 타이틀.
    pub settings_title: &'static str,
}

/// 한국어 테이블(기본값·폴백 대상).
static KO: Strings = Strings {
    tray_new_note: "새 노트",
    tray_panel: "노트 목록·검색…",
    tray_settings: "설정…",
    tray_check_update: "업데이트 확인…",
    tray_show_all: "모두 보기",
    tray_hide_all: "모두 숨기기",
    tray_open_notes: "열린 노트",
    tray_quit: "종료",

    jumplist_new_note: "새 노트",
    jumplist_panel: "노트 목록·검색",
    jumplist_settings: "설정",

    updater_dialog_title: "업데이트",
    updater_prompt: "새 버전 {next}이(가) 나왔습니다. 현재 버전은 {current}입니다.\n\n지금 내려받아 설치할까요? 설치가 끝나면 앱이 다시 시작됩니다.",
    updater_up_to_date: "최신 버전을 쓰고 있습니다.",
    updater_install_button: "설치",
    updater_later_button: "나중에",
    updater_check_failed: "업데이트를 확인하지 못했습니다.\n\n{error}\n\n릴리스 페이지에서 설치 파일을 직접 내려받을 수 있습니다.",
    updater_install_failed: "업데이트를 설치하지 못했습니다.\n\n{error}\n\n릴리스 페이지에서 설치 파일을 직접 내려받을 수 있습니다.",
    updater_open_release_button: "릴리스 페이지 열기",
    updater_close_button: "닫기",

    welcome_note: "# 안녕, 나는 note-rang! 👋

{logo}

생각이 떠오르면 나한테 툭 적어줘. 내가 화면 위에서 잊지 않게 같이 붙들고 있을게!

- 노트 위쪽에 마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타나.
- `**굵게**`, `# 제목`, `- [ ] 할 일`처럼 마크다운으로 자유롭게 꾸며봐.
- 다른 노트와 이어 쓰고 싶다면 [[노트 제목]]을 적어줘. 누르면 바로 열어줄게.
- 트레이 아이콘이나 {shortcut}을 누르면 언제든 새 노트를 만날 수 있어.

이 노트는 네 거야. 지우고 네 이야기로 채워도 좋아! ✏️
",

    app_name: "노트랑",
    panel_title: "메모 목록",
    settings_title: "설정",
};

/// 영어 테이블.
static EN: Strings = Strings {
    tray_new_note: "New Note",
    tray_panel: "Notes & Search…",
    tray_settings: "Settings…",
    tray_check_update: "Check for Updates…",
    tray_show_all: "Show All",
    tray_hide_all: "Hide All",
    tray_open_notes: "Open Notes",
    tray_quit: "Quit",

    jumplist_new_note: "New Note",
    jumplist_panel: "Notes & Search",
    jumplist_settings: "Settings",

    updater_dialog_title: "Update",
    updater_prompt: "A new version {next} is available. You're currently on {current}.\n\nDownload and install it now? The app will restart when installation finishes.",
    updater_up_to_date: "You're using the latest version.",
    updater_install_button: "Install",
    updater_later_button: "Later",
    updater_check_failed: "Couldn't check for updates.\n\n{error}\n\nYou can download the installer yourself from the releases page.",
    updater_install_failed: "Couldn't install the update.\n\n{error}\n\nYou can download the installer yourself from the releases page.",
    updater_open_release_button: "Open releases page",
    updater_close_button: "Close",

    welcome_note: "# Welcome to note-rang! 👋

{logo}

Got a thought? Jot it down with me, and I'll keep it floating nearby until you need it.

- Hover near the top of a note to find preview, pin, transparency, and background tools.
- Make it yours with Markdown: **bold**, `# Heading`, or `- [ ] to-do`.
- Type [[Note title]] to link another note, and I'll open it when you click.
- Use the tray icon or {shortcut} whenever you want a fresh note.

This note is yours now — erase it and fill it with your ideas! ✏️
",

    app_name: "Note Rang",
    panel_title: "Notes",
    settings_title: "Settings",
};

/// 시스템 로케일 문자열(예: `"ko-KR"`, `"en-US"`)에서 내장 언어 코드(`"ko"`/`"en"`)를 고른다
/// (순수 함수 — 실제 OS 조회는 [`system_language`]가 맡고, 이 함수는 그 결과를 판정만 해
/// GUI/OS 없이 테스트 가능하게 한다).
///
/// 규칙: 로케일이 `"ko"`로 시작하면(대소문자 무관) `"ko"`, 그 외(조회 실패 포함)는 전부
/// `"en"` — Rust 내장 표가 ko/en 둘뿐이라 이분법으로 충분하다.
fn locale_to_builtin_language(locale: Option<&str>) -> &'static str {
    match locale {
        Some(loc) if loc.to_ascii_lowercase().starts_with("ko") => "ko",
        _ => "en",
    }
}

/// 이 머신의 시스템 로케일을 조회해 내장 언어 코드로 변환한다(OS API 호출 — 부수효과 있음).
///
/// [`strings`]의 `None` 분기(언어를 아직 고른 적 없음)에서만 쓰인다. 트레이·창 타이틀·환영
/// 노트가 전부 [`strings`]나 [`resolve`]를 거쳐 언어를 고르므로, 이 판정을 여기 한 곳에 두면
/// 셋 다 자동으로 같은 결정을 공유한다(부팅 초입처럼 아직 `SharedSettings.language`가 없는
/// 시점에도 하드코딩된 ko 대신 실제 OS 로케일을 반영한다).
fn system_language() -> &'static str {
    locale_to_builtin_language(sys_locale::get_locale().as_deref())
}

/// 요청 로케일에 맞는 내장 문자열 테이블을 고른다.
///
/// `"en"`이면 영어, 그 외 **명시된** 코드(`"ko"`·서드파티 언어팩이 등록해 둔 미지 코드 등)는
/// 전부 한국어로 폴백한다 — Rust 내장 테이블엔 ko/en 둘뿐이니 ko가 안전한 기본값이다.
///
/// `None`(언어를 아직 고른 적 없음 — 최초 실행 등)은 다르게 다룬다: 하드코딩된 ko 대신 **이
/// 머신의 시스템 로케일**을 읽어 한국어 계열이면 ko, 그 외(조회 실패 포함)는 en으로 고른다
/// ([`system_language`]). 사용자가 설정에서 명시적으로 고른 언어는 항상 그 선택을 그대로
/// 존중하고, "아직 고르지 않음"일 때만 시스템 로케일을 참고한다는 구분이다.
pub fn strings(language: Option<&str>) -> &'static Strings {
    match language {
        Some("en") => &EN,
        Some(_) => &KO,
        None => match system_language() {
            "en" => &EN,
            _ => &KO,
        },
    }
}

/// [`AppState`](crate::state::AppState)에 보관된 `SharedSettings.language`를 읽어 맞는 문자열
/// 테이블을 고른다.
///
/// 역할: 트레이·업데이터 둘 다 "지금 이 순간의 언어"로 문자열을 골라야 하고, 상태 조회를 두
/// 모듈에 복붙하지 않도록 단일 지점으로 둔다. 상태가 아직 등록되지 않았으면(부팅 초입) `None`
/// 으로 넘어가 [`strings`]가 시스템 로케일로 폴백한다. 잠금은 [`AppState::lock_shared`]
/// (crate::state)가 poison을 복구해 잡으므로, 어떤 커맨드가 임계구역에서 패닉한 적이 있어도
/// 그 뒤로 계속 지금 이 순간 저장된 값을 그대로 읽는다 — 사용자가 설정에서 명시적으로 고른
/// 언어가 poison 이후에도 조용히 시스템 로케일로 뒤바뀌지 않는다.
pub fn resolve<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> &'static Strings {
    let language = manager
        .try_state::<crate::state::AppState>()
        .and_then(|state| state.lock_shared().language.clone());
    strings(language.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: `"en"`을 요청하면 영어 테이블을 돌려준다.
    #[test]
    fn selects_en_for_en_locale() {
        let s = strings(Some("en"));
        assert_eq!(s.tray_new_note, "New Note");
        assert_eq!(s.updater_dialog_title, "Update");
    }

    /// 가드: 명시적으로 주어진 로케일 코드 중 `"ko"`·미지 코드는 모두 ko로 폴백한다(서드파티
    /// 언어팩이 늘린 로케일 포함). `None`(언어 미설정)은 시스템 로케일을 따르므로 별도로
    /// [`locale_to_builtin_language_rules`]·[`strings_none_follows_system_locale`]에서 검증한다.
    #[test]
    fn falls_back_to_ko_for_unknown_locales() {
        for language in [Some("ko"), Some("xx"), Some("fr"), Some("")] {
            assert_eq!(strings(language).tray_new_note, "새 노트");
        }
    }

    /// 가드: 시스템 로케일 문자열 → 내장 언어 코드 변환의 순수 규칙(OS 조회와 분리해 테스트).
    /// "ko"로 시작하면(대소문자 무관) ko, 그 외(빈 문자열·조회 실패 포함)는 en.
    #[test]
    fn locale_to_builtin_language_rules() {
        assert_eq!(locale_to_builtin_language(Some("ko-KR")), "ko");
        assert_eq!(locale_to_builtin_language(Some("ko")), "ko");
        assert_eq!(locale_to_builtin_language(Some("KO-kr")), "ko");
        assert_eq!(locale_to_builtin_language(Some("en-US")), "en");
        assert_eq!(locale_to_builtin_language(Some("fr-FR")), "en");
        assert_eq!(locale_to_builtin_language(Some("")), "en");
        assert_eq!(locale_to_builtin_language(None), "en");
    }

    /// 가드: `strings(None)`은 이 머신의 실제 시스템 로케일([`system_language`])을 그대로
    /// 따른다. 실제 로케일 값은 실행 환경마다 다르므로 고정 언어를 기대하지 않고, `strings`가
    /// [`system_language`]와 같은 판정으로 수렴한다는 것만 고정한다(어느 쪽이든 패닉 없이
    /// KO/EN 중 하나로 정확히 떨어진다).
    #[test]
    fn strings_none_follows_system_locale() {
        let expected = match system_language() {
            "en" => "Note Rang",
            _ => "노트랑",
        };
        assert_eq!(strings(None).app_name, expected);
    }

    /// 가드: 새 버전 안내 문구의 `{next}`/`{current}` 플레이스홀더가 두 언어 모두에서
    /// 치환되고, 리터럴이 남지 않는다.
    #[test]
    fn update_prompt_placeholders_substitute_in_both_languages() {
        for language in [None, Some("en")] {
            let s = strings(language);
            let message = s
                .updater_prompt
                .replace("{next}", "0.2.0")
                .replace("{current}", "0.1.0");
            assert!(message.contains("0.2.0"));
            assert!(message.contains("0.1.0"));
            assert!(!message.contains("{next}"));
            assert!(!message.contains("{current}"));
        }
    }

    /// 가드: 오류 문구의 `{error}` 플레이스홀더도 두 언어 모두에서 치환된다.
    #[test]
    fn error_placeholder_substitutes_in_both_languages() {
        for language in [None, Some("en")] {
            let s = strings(language);
            let check = s.updater_check_failed.replace("{error}", "network down");
            let install = s.updater_install_failed.replace("{error}", "disk full");
            assert!(check.contains("network down"));
            assert!(!check.contains("{error}"));
            assert!(install.contains("disk full"));
            assert!(!install.contains("{error}"));
        }
    }

    /// 가드: 상태가 아직 등록되지 않은 매니저에서도 패닉 없이 폴백한다(부팅 초입 안전망) —
    /// `strings(None)`과 정확히 같은 결과로 수렴해야 한다(둘 다 같은 시스템 로케일 판정을
    /// 거치므로, 상태 미등록이 `None`으로 흘러드는 배관이 어긋나지 않았는지 고정한다).
    #[test]
    fn resolve_falls_back_when_state_missing() {
        // `tauri::test`의 mock 앱은 AppState를 관리하지 않으므로 폴백 경로를 그대로 탄다.
        let app = tauri::test::mock_app();
        assert_eq!(resolve(&app).app_name, strings(None).app_name);
    }
}
