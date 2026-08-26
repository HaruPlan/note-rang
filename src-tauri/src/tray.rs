//! 시스템 트레이(메뉴바) — 고정 진입점 + 플러그인 기여 항목.
//!
//! 역할: 메뉴바 상주 앱의 주 진입점을 구성하고(새 노트·노트 목록·모두 보기/숨기기·열린 노트·
//! 설정·종료), 그 아래 플러그인이 `memo.ui.addTrayItem`으로 얹은 항목을 네이티브 메뉴로
//! 그린다. 클릭은 고정 항목이면 직접 수행하고, 플러그인 항목이면 중앙 호스트로 방송해 그
//! `run`이 돌게 한다.
//! 왜 별도 모듈인가: 트레이는 네이티브 자원(메뉴·아이콘)이라 조립·라우팅이 한데 모여 있어야
//! 하고, 커맨드(`set_plugin_tray_items`)를 lib.rs 루트가 아니라 모듈에 두어야 Tauri
//! `generate_handler!`의 매크로 이름 충돌을 피한다(다른 커맨드와 같은 모듈 규약).
//!
//! **Windows 클릭 관례(이슈 #15)**: macOS는 트레이 아이콘 클릭이 곧 메뉴이지만, Windows는
//! 좌클릭=주요 동작·우클릭=메뉴가 관례다. [`setup_tray`]가 `#[cfg(target_os = "windows")]`로
//! `show_menu_on_left_click(false)` + `on_tray_icon_event`를 얹어 이 관례를 따른다(macOS 동작은
//! 그대로 둔다).
//!
//! **「열린 노트」 섹션 최신화(우클릭 메뉴가 안 뜨거나 즉시 사라지던 결함의 수정)**: 예전에는
//! 트레이 호버(`TrayIconEvent::Enter`)마다 이 섹션을 무조건 다시 그려 `set_menu`로 교체했다.
//! Windows에서 우클릭 메뉴는 `TrackPopupMenu` 모달 메시지 루프로 뜨는데, 그 루프도 결국 이
//! 앱의 메인 스레드 메시지 큐를 펌프하므로, 호버 뒤 도착한 `set_menu` 교체가 그 루프 **안에서**
//! 실행될 수 있었다. tray-icon은 `set_menu`에서 이전 `Menu`를 drop하며 `DestroyMenu`를
//! 호출하므로, 그 순간 마침 화면에 떠 있던 HMENU가 파괴돼 메뉴가 안 뜨거나 즉시 사라졌다 —
//! 호버는 항상 우클릭보다 먼저 오므로 사실상 매번 재현됐다. 지금은 호버가 이 재구성을 전혀
//! 하지 않는다 — 대신 목록이 실제로 바뀌는 시점(노트 생성·저장·삭제 등, `notes-list-changed`
//! 이벤트)에만, 그것도 이전 시그니처와 달라졌을 때만 재구성한다([`apply_open_notes_if_changed`]).
//! 클릭 타이밍과 완전히 분리돼 있고 대부분의 호출에서 시그니처가 같아 새 HMENU 자체를 만들지
//! 않으므로, 그 파괴 경로가 사실상 사라진다.
//!
//! **열린 노트 서브메뉴(이슈 #15)**: borderless 노트 창은 작업 표시줄 우클릭 시스템 메뉴가
//! Restore/Move/Size 중심이라 노트 사이를 오가는 용도로는 부실하다 — 트레이 메뉴에 열려 있는
//! 노트를 제목으로 나열해([`open_notes_for_menu`]) 클릭 한 번으로 포커스할 대체 경로를 둔다.
//!
//! **우클릭 팝업 가드(위 결함 완화의 두 번째 층)**: 「열린 노트」 재구성 가드
//! ([`apply_open_notes_if_changed`])만으로 대부분의 재현 경로는 사라지지만, 노트를 타이핑하는
//! 동안은 `notes-list-changed`가 자동저장마다(디바운스 250ms 간격으로) 계속 들어와 시그니처
//! 비교를 통과하는 순간이 마침 우클릭 메뉴가 떠 있는 순간과 겹칠 여지가 남고, `set_plugin_
//! tray_items`·`refresh_for_language_change`는 애초에 그 가드조차 없다. 그래서 우클릭(Down)을
//! 관측한 순간부터 수 초짜리 데드라인을 세워([`mark_popup_menu_shown`]) 세 `set_menu` 호출부를
//! 모두 게이트한다 — 「열린 노트」쪽은 그 틱을 그냥 건너뛰고(다음 디바운스 틱이 자연 재시도),
//! 나머지 둘은 팝업이 닫혔을 시점까지 기다렸다 한 번 더 재조립하도록 예약한다
//! ([`gate_or_schedule_menu_rebuild`]). **이 완화의 성격을 분명히 해 둔다**: 이것은 구조적
//! 보장이 아니라 휴리스틱이다 — 데드라인은 팝업이 실제로 닫히는 시점을 통지받는 게 아니라
//! "그때쯤이면 닫혔을 것"이라는 추정값이고, 명시적 해제([`clear_popup_menu_guard`])는
//! `on_tray_menu_event`(메뉴 항목 클릭)가 왔을 때만 걸린다 — Escape·바깥 클릭으로 메뉴가
//! 조용히 닫히는 경우는 그 통지 자체가 없어 타임아웃에만 기댄다. 지연 재조립이 실제로 도는
//! 메인 스레드 콜백은 `set_menu`를 부르기 직전에 [`gate_or_schedule_menu_rebuild`]를 한 번 더
//! 불러 게이트를 재확인한다 — 슬립하는 동안 마침 새 우클릭이 겹쳐 데드라인이 다시 섰다면
//! 여기서 또 걸려 다음 사이클을 예약할 뿐 무한 연기는 아니다(우클릭이 멎는 순간의 다음
//! 사이클에서 반드시 반영된다). 이 재확인이 없으면 지연 경로 자체가 이 완화가 막으려던 바로
//! 그 크래시 레이스를 재현할 수 있다. 그럼에도 근본 원인 — muda의 `set_menu`가 이전 `Menu`를
//! drop하며 조건 없이 `DestroyMenu`를 부르는 것 자체 — 을 없애지는 못한다. tray-icon/muda가
//! "팝업 표시 중에는 교체를 미룬다" 같은 API를 내놓기 전까지는 남는 잔여 레이스다.

use crate::i18n::{self, Strings};
use crate::window_manager;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use std::sync::PoisonError;
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Listener, Manager,
};

/// 노트 창 → 백엔드: 설정 창 열기 요청(이슈 #16 — 노트 툴바의 설정 바로가기 버튼). 프론트
/// `src/plugin/host-protocol.ts`의 `EV_REQUEST_OPEN_SETTINGS`와 리터럴이 같아야 한다.
///
/// 왜 새 Tauri 커맨드가 아니라 이벤트 리스너인가: 정공법(`#[tauri::command]` + `lib.rs`의
/// `invoke_handler` 등록)은 그 등록 지점이 이 기능을 만들 당시 다른 작업으로 잠겨 있어 쓸 수
/// 없었다. 이미 프론트↔백엔드로 양방향 왕복하는 전역 이벤트 채널을 그대로 이용해, 프론트가
/// `emit`으로 보내고 [`setup_tray`]가 `Listener::listen`으로 받아 트레이 「설정」 메뉴와 같은
/// 동작([`window_manager::open_settings`])을 수행한다.
const EV_REQUEST_OPEN_SETTINGS: &str = "request-open-settings";

/// 프론트 `EV_NOTES_LIST_CHANGED`(`src/plugin/host-protocol.ts`) 및 `window_manager.rs`의
/// 같은 이름 상수와 **리터럴이 같아야** 하는 전역 이벤트 — 노트 생성·저장(자동저장 포함)·
/// 삭제·복제·보관·vault 전환 등 열린 노트 목록이 바뀔 수 있는 지점마다 프론트
/// (`afterNotesChanged`, `src/shared/tauri.ts`)와 Rust(`window_manager::create_and_open`)가
/// 공통으로 방송한다. `window_manager.rs`의 상수가 `pub`이 아니라 여기서 가져다 쓸 수 없어
/// ([`NOTE_WINDOW_PREFIX`]와 같은 사정) 리터럴을 중복하지만, 이미 이 앱 전역에서 통용되는
/// 문자열이다. [`setup_tray`]가 Windows에서만 이 이벤트를 구독해 「열린 노트」 섹션을
/// 최신화한다 — 트레이 호버(Enter)마다 재구성하던 예전 방식이 우클릭 메뉴 파괴를 유발했던
/// 문제(Win32 `TrackPopupMenu`/`DestroyMenu` 상호작용, 모듈 문서 참고)의 대체 경로라 이
/// 이벤트 리스너와 그 아래 헬퍼들([`apply_open_notes_if_changed`] 등)도 그 결함이 있는
/// 플랫폼에만 필요하다 — macOS 경로는 건드리지 않는다(예전에도 macOS는 이 재구성이 없었다).
#[cfg(target_os = "windows")]
const EV_NOTES_LIST_CHANGED: &str = "notes-list-changed";

/// 트레이 메뉴에서 발생할 수 있는 고정 동작.
#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    NewNote,
    Panel,
    Settings,
    CheckUpdate,
    ShowAll,
    HideAll,
    Quit,
    Unknown,
}

/// 고정 트레이 메뉴 id 문자열을 [`TrayAction`]으로 해석한다.
///
/// 역할: 이벤트 핸들러의 분기를 순수 함수로 분리해 GUI 없이 테스트 가능하게 한다.
/// 왜: 메뉴 라우팅이 의도대로 유지되는지 가드 테스트로 고정하기 위함.
///
/// 플러그인 트레이 항목의 id(`ptray-<n>`)는 여기서 `Unknown`으로 떨어진다 — 그 라우팅은
/// [`plugin_tray_index`]가 먼저 가로채므로, 고정 항목 분기가 플러그인 id를 오인해 잘못된
/// 동작을 하지 않게 하는 안전망이다.
fn tray_action_for(id: &str) -> TrayAction {
    match id {
        "new_note" => TrayAction::NewNote,
        "panel" => TrayAction::Panel,
        "settings" => TrayAction::Settings,
        "check_update" => TrayAction::CheckUpdate,
        "show_all" => TrayAction::ShowAll,
        "hide_all" => TrayAction::HideAll,
        "quit" => TrayAction::Quit,
        _ => TrayAction::Unknown,
    }
}

/// 플러그인이 등록한 트레이 항목의 메뉴 id 접두 — `ptray-<목록 인덱스>`.
///
/// 왜 인덱스이고 라벨·id가 아닌가: 라벨과 저작자 id는 임의 문자를 담을 수 있어(구분자·고정 id
/// 충돌) 메뉴 id로 안전하지 않다. 인덱스는 [`plugin_tray_items`] 목록의 위치라 순수 숫자이고,
/// 클릭 시 그 위치를 되짚어 (pluginId, id)를 프론트로 방송한다.
const PLUGIN_TRAY_PREFIX: &str = "ptray-";

/// 노트 창 라벨 접두 — `window_manager::note_label(id)`(비공개)의 실제 형식(`format!("note-{id}")`)
/// 과 반드시 같아야 한다. window_manager.rs를 이 모듈에서 가져다 쓸 수 없어(다른 상수 소유)
/// 리터럴로 중복하지만, 이 앱 전역에서 이미 통용되는 규약이다 — `lib.rs::handle_second_instance`
/// 도 같은 리터럴(`"note-"`)로 노트 창을 가려낸다.
const NOTE_WINDOW_PREFIX: &str = "note-";

/// 트레이 아이콘 자체의 id — [`setup_tray`]가 붙일 때와 이후 다시 찾을 때(재구성·set_menu)
/// 모두 이 상수를 쓴다. 문자열 리터럴을 흩어 두면 오타 하나로 재구성이 조용히 no-op이 된다.
const TRAY_ID: &str = "main-tray";

/// 「열린 노트」 서브메뉴 자체의 메뉴 id(하위 항목이 아니라 부모) — 클릭 라우팅 대상이 아니라
/// (서브메뉴 헤더는 선택되지 않고 펼쳐지기만 한다) 식별용으로만 쓴다.
const OPEN_NOTES_SUBMENU_ID: &str = "open_notes";

/// 트레이 「열린 노트」 항목 제목의 최대 글자 수 — 창 타이틀의 `TITLE_MAX_CHARS`
/// (window_manager.rs, 40자)와 별개 상수다: 트레이 메뉴 폭은 그와 다른 제약이라 여기서
/// 독립적으로 조절한다.
const TRAY_NOTE_TITLE_MAX_CHARS: usize = 40;

/// 노트 제목을 메뉴 폭에 맞게 자른다(char 단위 — 멀티바이트 문자를 깨지 않는다). 잘렸으면
/// 말줄임표를 붙여 온전한 제목이 아님을 알린다.
fn truncate_note_title(title: &str) -> String {
    if title.chars().count() <= TRAY_NOTE_TITLE_MAX_CHARS {
        title.to_string()
    } else {
        let mut truncated: String = title.chars().take(TRAY_NOTE_TITLE_MAX_CHARS).collect();
        truncated.push('…');
        truncated
    }
}

/// 「열린 노트」 목록 — (메뉴 id로 쓸 창 라벨, 표시할 제목) 쌍의 목록. [`open_notes_for_menu`]의
/// 반환 타입이자 [`build_tray_menu`]가 메뉴와 함께 돌려주는 값의 절반이다 — 여러 시그니처에
/// 반복되는 `Vec<(String, String)>`를 이름으로 묶어 가독성을 높이고 clippy의 타입 복잡도
/// 경고(`type_complexity`)도 피한다. Windows 전용 [`OpenNotesSignature`](캐시·비교 쪽)와 값
/// 모양은 같지만 의도(그 시점의 실제 목록 vs 마지막으로 적용한 시그니처)가 달라 별도로 둔다.
type OpenNotesList = Vec<(String, String)>;

/// 현재 열려 있는 노트 창들을 (메뉴 id로 쓸 창 라벨, 표시할 제목) 목록으로 모은다. 제목순으로
/// 정렬해 사용자가 찾기 쉽게 한다.
///
/// 제목은 창 타이틀 캐시(`window.title()`)가 아니라 vault 본문에서 매번
/// [`crate::notes::derive_title`]로 다시 뽑는다 — window_manager의 타이틀 갱신 타이밍(저장
/// 시점)에 결합하지 않기 위함이다. `note_list`(commands.rs)와 같은 파생 규칙이라, 빈 노트는
/// derive_title 그대로 "제목 없음"으로 보인다(패널 목록과 표기가 갈라지지 않는다).
///
/// AppState가 아직 등록되지 않았으면(초기 부팅) 빈 목록을 돌려준다 — 메뉴에서 이 섹션이
/// 그냥 빠질 뿐 패닉하지 않는다. vault 잠금은 `state.lock_vault()`가 poison을 복구해 잡으므로
/// (state.rs 참고) 다른 커맨드의 이전 패닉과 무관하게 항상 잠글 수 있다 — 예전의 원시
/// `state.vault.lock()`은 poison 이후 영구히 실패해, 이 서브메뉴가 그 시점부터 프로세스가
/// 끝날 때까지 계속 비었다.
fn open_notes_for_menu<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> OpenNotesList {
    let Some(state) = manager.try_state::<crate::state::AppState>() else {
        return Vec::new();
    };
    let vault = state.lock_vault();
    let mut items: Vec<(String, String)> = manager
        .webview_windows()
        .into_keys()
        .filter_map(|label| {
            let id = label.strip_prefix(NOTE_WINDOW_PREFIX)?;
            let content = vault.read_content(id).unwrap_or_default();
            Some((label.clone(), crate::notes::derive_title(&content)))
        })
        .collect();
    items.sort_by(|a, b| a.1.cmp(&b.1));
    items
}

/// 「열린 노트」 시그니처 — (메뉴 id로 쓸 창 라벨, 표시할 제목) 목록. [`open_notes_for_menu`]의
/// 반환 타입과 같은 모양이지만, 캐시·비교 쪽 타입이 장황해지는 것을 막기 위해 별칭을 둔다.
/// Windows 전용(위 [`EV_NOTES_LIST_CHANGED`] 문서 참고).
#[cfg(target_os = "windows")]
type OpenNotesSignature = Vec<(String, String)>;

/// 마지막으로 트레이 메뉴에 실제로 적용한 「열린 노트」 시그니처 — 세션 한정(프로세스 메모리,
/// [`plugin_tray_items`]와 같은 이유). `None`은 "아직 한 번도 적용하지 않았다"를 뜻해, 첫
/// 관찰은 [`signature_changed`]가 항상 변경으로 판정한다(초기 트레이 구성과 별개로, 이후
/// 최초의 노트 생성 등에서 정상적으로 한 번 재구성된다).
#[cfg(target_os = "windows")]
fn last_open_notes_signature() -> &'static Mutex<Option<OpenNotesSignature>> {
    static SIG: OnceLock<Mutex<Option<OpenNotesSignature>>> = OnceLock::new();
    SIG.get_or_init(|| Mutex::new(None))
}

/// `cache`가 `current`와 다르면 `cache`를 갱신하고 true, 같으면 건드리지 않고 false.
///
/// 역할: [`apply_open_notes_if_changed`]에서 실제 캐시(전역 static)를 다루는 부분을 떼어낸
/// 순수 함수 — GUI/트레이 없이 테스트 가능하게 한다([`tray_action_for`]와 같은 결).
#[cfg(target_os = "windows")]
fn signature_changed(cache: &mut Option<OpenNotesSignature>, current: &[(String, String)]) -> bool {
    if cache.as_deref() == Some(current) {
        false
    } else {
        *cache = Some(current.to_vec());
        true
    }
}

/// `notes-list-changed` 리스너가 짧은 시간 안에 몰리는 이벤트를 하나로 합칠 때 쓰는 예약
/// 플래그 — 이미 처리가 예약돼 있으면(true) 새로 들어온 이벤트는 스스로 새 작업을 스폰하지
/// 않고 그 예약된 처리에 편승한다(찾은 결함 수정: 자동저장마다 열린 노트 전체를 vault 잠금
/// 아래 다시 읽던 문제 — 열린 노트가 N개면 그 자동저장 하나가 N개의 독립된 읽기를 유발했다).
#[cfg(target_os = "windows")]
static NOTES_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);

/// [`NOTES_REFRESH_PENDING`]으로 합쳐 기다리는 시간. 프론트 자동저장 디바운스(500ms,
/// `note-window.ts`)보다 짧게 잡아 체감 반응성은 거의 그대로 두면서, 그 자동저장 한 번이
/// 여러 창에서 겹쳐 emit해도(예: 다른 창의 저장이 우연히 겹치는 경우) 한 번의 갱신으로
/// 합친다.
#[cfg(target_os = "windows")]
const NOTES_REFRESH_DEBOUNCE: Duration = Duration::from_millis(250);

/// [`NOTES_REFRESH_PENDING`]에 대한 CAS를 순수 함수로 떼어낸 것 — GUI/타이머 없이 테스트
/// 가능하게 한다([`signature_changed`]와 같은 결). 아직 예약이 없으면(false) 참으로 세우고
/// true(새로 스폰하라)를, 이미 예약돼 있으면 건드리지 않고 false(이번 이벤트는 그 예약에
/// 편승하라)를 돌려준다.
#[cfg(target_os = "windows")]
fn should_schedule_refresh(pending: &AtomicBool) -> bool {
    !pending.swap(true, Ordering::AcqRel)
}

/// 우클릭 팝업 가드의 데드라인 — Some이면 "이 시각까지는 우클릭 메뉴(`TrackPopupMenu`)가 떠
/// 있다고 가정한다"를 뜻한다(모듈 문서 "우클릭 팝업 가드" 참고). [`mark_popup_menu_shown`]이
/// 우클릭 Down 관측 시 미래로 밀어 세우고, [`clear_popup_menu_guard`]가 메뉴 클릭 도착
/// (`on_tray_menu_event` 진입) 시 명시적으로 지운다. `None`은 "지금은 안 떠 있다(또는 한 번도
/// 우클릭한 적 없다)"를 뜻한다.
#[cfg(target_os = "windows")]
fn popup_menu_deadline() -> &'static Mutex<Option<Instant>> {
    static DEADLINE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    DEADLINE.get_or_init(|| Mutex::new(None))
}

/// [`popup_menu_deadline`]의 유효 기간 — Escape·바깥 클릭으로 메뉴가 조용히 닫혀
/// `on_tray_menu_event`가 오지 않는 경우를 대비한 안전망이다. 사용자가 메뉴를 띄워 두고
/// 살펴보는 시간을 넉넉히 덮으면서도, 실제로는 떠 있지 않은데 게이트만 눌어붙는 시간은 짧게
/// 묶어 둔다.
#[cfg(target_os = "windows")]
const POPUP_MENU_GUARD_TIMEOUT: Duration = Duration::from_secs(5);

/// `deadline`과 `now`만으로 "지금 set_menu를 미뤄야 하는가"를 판정하는 순수 함수 — GUI/타이머
/// 없이 테스트 가능하게 한다([`signature_changed`]·[`should_schedule_refresh`]와 같은 결).
/// 데드라인이 없거나 이미 지났으면 `None`(그려도 된다), 아직 안 지났으면 남은 시간을 `Some`으로
/// 돌려준다 — [`gate_or_schedule_menu_rebuild`]가 그 남은 시간만큼 재시도를 미루는 데 쓴다.
#[cfg(target_os = "windows")]
fn popup_menu_guard_remaining(deadline: Option<Instant>, now: Instant) -> Option<Duration> {
    deadline.and_then(|d| d.checked_duration_since(now))
}

/// 지금 우클릭 팝업이 떠 있다고 가정해야 하는지를 실제 데드라인 캐시로 판정한다
/// ([`popup_menu_guard_remaining`]의 얇은 래퍼 — static을 다루는 부분만 분리했다).
#[cfg(target_os = "windows")]
fn is_popup_menu_active() -> bool {
    let deadline = *popup_menu_deadline()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    popup_menu_guard_remaining(deadline, Instant::now()).is_some()
}

/// 우클릭(Down)을 관측했을 때 부른다([`on_tray_icon_event_windows`]) — tray-icon 0.24.1은 이
/// 이벤트를 실제 `TrackPopupMenu` 호출(우클릭 Up에서 일어난다) **전에** 보내므로, 이 시점에
/// 데드라인을 세워 두면 그 뒤 곧 뜰 팝업을 놓치지 않는다. 이미 세워져 있어도 다시
/// [`POPUP_MENU_GUARD_TIMEOUT`]만큼 미룬다(밀어 세우는 쪽이 안전하다).
#[cfg(target_os = "windows")]
fn mark_popup_menu_shown() {
    let mut deadline = popup_menu_deadline()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *deadline = Some(Instant::now() + POPUP_MENU_GUARD_TIMEOUT);
}

/// 메뉴 클릭이 도착했을 때([`on_tray_menu_event`] 진입) 부른다 — 메뉴 항목 클릭은
/// `TrackPopupMenu`가 반환한 뒤에만 배달되므로, 이 시점엔 팝업이 이미 닫혀 있어 더 이상 가드가
/// 필요 없다. 데드라인을 즉시 지워 다음 `notes-list-changed` 틱이나 `set_plugin_tray_items`/
/// `refresh_for_language_change` 호출이 불필요하게 기다리지 않게 한다.
#[cfg(target_os = "windows")]
fn clear_popup_menu_guard() {
    let mut deadline = popup_menu_deadline()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *deadline = None;
}

/// [`set_plugin_tray_items`]·[`refresh_for_language_change`] 재조립 예약 플래그 —
/// [`NOTES_REFRESH_PENDING`]과 같은 결의 안전장치이지만 용도는 다르다. 이 둘은
/// `notes-list-changed`처럼 스스로 재시도하는 다음 틱이 없다(플러그인 재설정·언어 변경은
/// 발생 시점 1회성 이벤트) — 그래서 우클릭 팝업 가드에 막혔을 때 여기 명시적으로 예약해 두지
/// 않으면, 그 변경 자체가 화면에 영영 반영되지 않는다(값은 이미 저장했지만 트레이 메뉴만
/// 갈아 끼우지 못한 채로 남는다).
#[cfg(target_os = "windows")]
static MENU_REBUILD_RETRY_PENDING: AtomicBool = AtomicBool::new(false);

/// 저장된 플러그인 항목 + 그 시점의 최신 언어로 트레이 메뉴를 다시 그려 적용한다 —
/// [`gate_or_schedule_menu_rebuild`]가 게이트에 걸려 버린 조립을 대신할 때 쓰는 지연 재조립
/// 본체. [`set_plugin_tray_items`]/[`refresh_for_language_change`]가 게이트를 통과하지 못한
/// 시점과 이 함수가 실제로 도는 시점 사이 언어나 플러그인 목록이 또 바뀌었을 수 있어, 버려둔
/// `Menu`를 재사용하지 않고 이 시점의 상태로 처음부터 다시 조립한다.
#[cfg(target_os = "windows")]
fn rebuild_and_apply_tray_menu(app: &tauri::AppHandle) {
    let items = plugin_tray_items()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let strings = i18n::resolve(app);
    let (menu, open_notes) = match build_tray_menu(app, &items, strings) {
        Ok(built) => built,
        Err(e) => {
            eprintln!("[memo] 팝업 해제 후 트레이 메뉴 재조립 실패: {e}");
            return;
        }
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(e) = tray.set_menu(Some(menu)) {
            eprintln!("[memo] 팝업 해제 후 트레이 메뉴 설정 실패: {e}");
            return;
        }
        sync_open_notes_cache(&open_notes);
    }
}

/// [`set_plugin_tray_items`]·[`refresh_for_language_change`]가 `set_menu`를 부르기 직전에
/// 거치는 게이트. 팝업이 안 떠 있으면(대부분의 호출) `true`를 돌려줘 호출부가 방금 조립한
/// 메뉴를 바로 적용하면 된다. 떠 있으면 그 메뉴는 버리고, 팝업이 닫혔을 시점(데드라인 경과)
/// 까지 기다렸다 [`rebuild_and_apply_tray_menu`]로 한 번 더 재조립하도록 예약한 뒤 `false`를
/// 돌려준다 — 호출부는 이번엔 `set_menu`를 부르지 말아야 한다(값은 이미 저장돼 있으니 유실은
/// 아니고, 반영만 미뤄진다).
///
/// **메인 스레드 콜백도 실행 직전에 이 함수를 다시 부른다(자기 자신을 재귀적으로 예약)**:
/// `spawn_blocking`이 `remaining + 100ms`를 재우는 동안 사용자가 마침 새로 우클릭해
/// [`mark_popup_menu_shown`]으로 데드라인이 다시 세워질 수 있다 — 그 상태로 재조립을 강행하면
/// 이 완화가 막으려던 바로 그 크래시 레이스가 지연 경로를 통해 재발한다. 재확인 시점엔
/// `MENU_REBUILD_RETRY_PENDING`이 이미 `false`로 되돌려져 있으므로(깨어나자마자 되돌린다),
/// 다시 걸리더라도 `should_schedule_refresh`가 정상적으로 새 재시도 한 사이클을 예약한다.
/// 무한 연기가 아니다 — 매 사이클은 "그 시점의" 새 데드라인 이후로만 미뤄지므로, 사용자가
/// 우클릭을 멈추는 순간의 다음 사이클에서 반드시 반영된다(우클릭이 계속 이어지는 동안만
/// 미뤄진다).
///
/// 이 완화의 성격(휴리스틱, 잔여 레이스)은 모듈 문서 "우클릭 팝업 가드" 참고.
#[cfg(target_os = "windows")]
fn gate_or_schedule_menu_rebuild(app: &tauri::AppHandle) -> bool {
    let deadline = *popup_menu_deadline()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let Some(remaining) = popup_menu_guard_remaining(deadline, Instant::now()) else {
        return true;
    };
    if should_schedule_refresh(&MENU_REBUILD_RETRY_PENDING) {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // 데드라인까지 남은 시간 + 여유를 재워 팝업이 확실히 닫힌 뒤에 재조립한다.
            std::thread::sleep(remaining + Duration::from_millis(100));
            MENU_REBUILD_RETRY_PENDING.store(false, Ordering::Release);
            let handle = app.clone();
            let dispatched = app.run_on_main_thread(move || {
                // 깨어난 시점에 게이트를 다시 확인한다 — 이 슬립 동안 새 우클릭이 겹쳐
                // 데드라인이 다시 섰다면(위 문서 참고) 여기서 또 한 번 걸리고, 그러면 이
                // 호출 자체가 위 `should_schedule_refresh` 분기를 다시 태워 다음 사이클을
                // 예약한다 — `rebuild_and_apply_tray_menu`는 게이트를 통과했을 때만 돈다.
                if gate_or_schedule_menu_rebuild(&handle) {
                    rebuild_and_apply_tray_menu(&handle);
                }
            });
            if let Err(e) = dispatched {
                eprintln!("[memo] 팝업 해제 후 트레이 메뉴 재조립 디스패치 실패: {e}");
            }
        });
    }
    false
}

/// 「열린 노트」 목록이 마지막으로 적용한 시그니처와 실제로 다를 때만 트레이 메뉴를 다시 그려
/// `set_menu`로 교체한다 — 같으면 새 `Menu`(HMENU)를 아예 만들지 않고 조용히 반환한다.
///
/// **왜 이 가드가 있어야 하는가(우클릭 메뉴가 안 뜨거나 즉시 사라지던 결함)**: tray-icon의
/// `set_menu`는 내부적으로 이전 `Menu`를 drop하며 Win32 `DestroyMenu`를 호출한다. Windows
/// 우클릭 메뉴는 `TrackPopupMenu` 모달 메시지 루프로 뜨는데, 이 루프도 이 앱의 메인 스레드
/// 메시지 큐를 펌프하므로 `set_menu` 호출이 그 루프 안에서 실행되면 마침 화면에 떠 있는
/// HMENU가 파괴된다. 목록이 실제로 바뀌지 않았으면 이 함수가 `build_tray_menu_with_notes`도
/// `set_menu`도 호출하지 않으므로 그 파괴 경로 자체가 없다 — 열린 노트 목록은 대부분의
/// 호출에서 직전과 같으므로, 이 가드만으로 재현 경로가 사실상 사라진다(모듈 문서의 "「열린
/// 노트」 섹션 최신화" 참고). 호출부([`setup_tray`]의 `notes-list-changed` 리스너)는 이미
/// 메인 스레드에서 부른다 — `set_menu`·`Menu` 생성이 메인 스레드 전용 네이티브 UI 자원이라는
/// 규칙(muda/Win32)은 [`build_tray_menu_with_notes`] 문서 참고. Windows 전용(macOS는 이
/// 결함도, 이 재구성 경로도 없었다 — 손대지 않는다).
#[cfg(target_os = "windows")]
fn apply_open_notes_if_changed(
    app: &tauri::AppHandle,
    strings: &Strings,
    open_notes: OpenNotesSignature,
) {
    // 우클릭 팝업 가드(모듈 문서 참고) — 지금 set_menu를 부르면 화면에 떠 있는 HMENU를 파괴할
    // 위험이 있으니 이번 틱은 그냥 넘긴다. 시그니처 캐시는 건드리지 않는다 — 다음
    // notes-list-changed 디바운스 틱(`NOTES_REFRESH_DEBOUNCE`)이 같은 목록을 다시 관찰해도
    // "달라졌다"고 정상적으로 재시도할 수 있어야 하는데, 여기서 캐시를 앞서 갱신해 버리면 그
    // 재시도 기회 자체가 사라진다.
    if is_popup_menu_active() {
        return;
    }
    let changed = {
        let mut cache = last_open_notes_signature()
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        signature_changed(&mut cache, &open_notes)
    };
    if !changed {
        return;
    }
    let items = plugin_tray_items()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if let Ok(menu) = build_tray_menu_with_notes(app, &items, strings, &open_notes) {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 방금 화면에 실제로 적용한 「열린 노트」 목록으로 [`last_open_notes_signature`] 캐시를
/// 강제로 맞춘다(무조건 덮어쓴다 — [`signature_changed`]처럼 "달랐는가"를 따지지 않는다).
///
/// **왜 필요한가(찾은 결함 수정 — 캐시를 다른 메뉴 재조립 경로가 무효화하지 않던 문제)**:
/// [`apply_open_notes_if_changed`] 말고도 `set_menu`로 트레이 메뉴를 갈아 끼우는 경로가 셋 더
/// 있다 — [`setup_tray`](초기 조립)·[`set_plugin_tray_items`](플러그인 재설정)·
/// [`refresh_for_language_change`](언어 변경). 이 셋은 각자 그 시점의 실제 「열린 노트」
/// 목록으로 메뉴를 새로 그리면서도 캐시는 건드리지 않았다 — 그래서 캐시가 화면과 어긋나면
/// (예: 이 셋 중 하나가 캐시에 없던 새 목록으로 메뉴를 그린 뒤, 다음 `notes-list-changed`가
/// 마침 캐시와 같은 옛 목록을 다시 관찰하면) `signature_changed`가 "안 바뀌었다"고 오판해
/// 이후 실제 변경까지 영구히 재구성을 건너뛰었다. `set_menu`가 성공한 **뒤에만** 불러야
/// 한다(그리지 못한 목록으로 캐시를 앞서 맞추면 반대 방향으로 어긋난다). Windows 전용 —
/// 캐시 자체가 Windows 전용([`OpenNotesSignature`] 문서 참고).
#[cfg(target_os = "windows")]
fn sync_open_notes_cache(open_notes: &[(String, String)]) {
    let mut cache = last_open_notes_signature()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *cache = Some(open_notes.to_vec());
}

/// 프론트 `EV_TRAY_INVOKE`(host-protocol.ts)와 **같은 문자열** — 트레이 클릭을 중앙 호스트로 방송.
const TRAY_INVOKE_EVENT: &str = "plugin-tray:invoke";

/// 플러그인 트레이 항목 하나 — 프론트 `TrayItemDescriptor`(host-protocol.ts)와 같은 모양.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrayItem {
    pub plugin_id: String,
    pub id: String,
    pub label: String,
}

/// 현재 트레이에 그려진 플러그인 항목 목록 — **세션 한정**(프로세스 메모리). 메뉴 id의 인덱스가
/// 이 목록의 위치를 가리키므로, 재설정([`set_plugin_tray_items`])과 클릭 해석이 같은 목록을 본다.
///
/// 왜 `AppState`가 아니라 모듈 static인가: `dev_watcher`(plugin_commands.rs)와 같은 판단이다 —
/// 트레이에 무엇이 떠 있는지는 사용자 데이터가 아니라 순수 UI 세션 상태이고, 앱 상태와
/// 생애주기가 다르다(재시작하면 빈 목록에서 시작해 중앙 호스트가 다시 채운다).
fn plugin_tray_items() -> &'static Mutex<Vec<PluginTrayItem>> {
    static ITEMS: OnceLock<Mutex<Vec<PluginTrayItem>>> = OnceLock::new();
    ITEMS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 플러그인 트레이 메뉴 id(`ptray-<n>`)에서 목록 인덱스를 뽑는다(형식이 아니면 None).
///
/// 역할: 클릭 라우팅의 순수 부분을 떼어 GUI 없이 테스트 가능하게 한다([`tray_action_for`]와 같은 결).
fn plugin_tray_index(id: &str) -> Option<usize> {
    id.strip_prefix(PLUGIN_TRAY_PREFIX)?.parse().ok()
}

/// 트레이 메뉴를 만든다 — 고정 항목 + (플러그인 항목이 있으면) 구분선 + 「플러그인」 섹션.
///
/// 역할: 초기 부착([`setup_tray`])과 플러그인 항목 재설정([`set_plugin_tray_items`]) ·
/// 언어 변경 재구성([`refresh_for_language_change`])이 **같은 조립**을 쓰게 하는 단일 지점.
/// 「열린 노트」 목록은 이 호출 시점에 [`open_notes_for_menu`]로 새로 계산한다 — 세 호출부
/// 모두 이미 메인 스레드라 그 안의 vault IO가 문제되지 않는다. 메인 스레드가 아닌 곳에서
/// 그 IO를 먼저 끝내야 하는 호출부(`notes-list-changed` 리스너, Windows 전용)는 이 함수
/// 대신 목록을 인자로 받는 [`build_tray_menu_with_notes`]를 `apply_open_notes_if_changed`
/// (Windows 전용) 경유로 쓴다.
///
/// 계산한 「열린 노트」 목록을 메뉴와 함께 돌려준다 — 호출부가 `set_menu` 성공 뒤
/// [`sync_open_notes_cache`](Windows 전용)로 캐시를 맞추는 데 쓴다(찾은 결함 수정: 이 함수를
/// 거치는 세 경로가 캐시를 갱신하지 않아, `apply_open_notes_if_changed`의 다음 시그니처
/// 비교가 화면과 어긋난 채 영구히 남던 문제 — 그 함수 문서 참고).
fn build_tray_menu<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    plugin_items: &[PluginTrayItem],
    strings: &Strings,
) -> tauri::Result<(Menu<R>, OpenNotesList)> {
    let open_notes = open_notes_for_menu(manager);
    let menu = build_tray_menu_with_notes(manager, plugin_items, strings, &open_notes)?;
    Ok((menu, open_notes))
}

/// [`build_tray_menu`]의 조립 본체 — 「열린 노트」 목록을 계산하지 않고 인자로 받는다.
///
/// 왜 계산과 조립을 분리했나(이슈 #22와 같은 부류의 회귀 방지): [`open_notes_for_menu`]는
/// 열린 노트마다 vault.lock()+read_content(디스크 IO)를 하고, 이 함수의 `Menu`/`MenuItem`/
/// `Submenu` 생성은 네이티브 UI 자원이라 메인 스레드에서만 안전하다(muda/Win32 규칙 —
/// `commands::save_shared_settings`의 트레이 재구성 문서 참고). `notes-list-changed` 리스너
/// ([`setup_tray`], Windows 전용)처럼 메인 이벤트 루프 스레드 위에서 그 IO를 피해야 하는
/// 호출부는, 목록 계산만 `spawn_blocking`으로 워커에 보내고 그 결과를 들고 이 함수(조립)를
/// 메인 스레드로 되돌려 `apply_open_notes_if_changed`(Windows 전용) 경유로 부른다.
fn build_tray_menu_with_notes<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    plugin_items: &[PluginTrayItem],
    strings: &Strings,
    open_notes: &[(String, String)],
) -> tauri::Result<Menu<R>> {
    let new_note = MenuItem::with_id(
        manager,
        "new_note",
        strings.tray_new_note,
        true,
        Some("Cmd+Shift+N"),
    )?;
    let panel = MenuItem::with_id(manager, "panel", strings.tray_panel, true, None::<&str>)?;
    let settings = MenuItem::with_id(
        manager,
        "settings",
        strings.tray_settings,
        true,
        None::<&str>,
    )?;
    let check_update = MenuItem::with_id(
        manager,
        "check_update",
        strings.tray_check_update,
        true,
        None::<&str>,
    )?;
    let show_all = MenuItem::with_id(
        manager,
        "show_all",
        strings.tray_show_all,
        true,
        None::<&str>,
    )?;
    let hide_all = MenuItem::with_id(
        manager,
        "hide_all",
        strings.tray_hide_all,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(manager, "quit", strings.tray_quit, true, None::<&str>)?;
    let sep_fixed = PredefinedMenuItem::separator(manager)?;
    let sep_bottom = PredefinedMenuItem::separator(manager)?;

    let menu = Menu::new(manager)?;
    menu.append(&new_note)?;
    menu.append(&panel)?;
    menu.append(&settings)?;
    menu.append(&check_update)?;
    menu.append(&sep_fixed)?;
    menu.append(&show_all)?;
    menu.append(&hide_all)?;
    // 「열린 노트」 서브메뉴 — 열린 노트가 하나도 없으면 구분선도 통째로 빠진다(플러그인
    // 섹션과 같은 원칙: 보여줄 게 없으면 트레이 모양이 늘지 않는다).
    if !open_notes.is_empty() {
        menu.append(&PredefinedMenuItem::separator(manager)?)?;
        let open_notes_menu = Submenu::with_id(
            manager,
            OPEN_NOTES_SUBMENU_ID,
            strings.tray_open_notes,
            true,
        )?;
        for (label, title) in open_notes {
            let item = MenuItem::with_id(
                manager,
                label.clone(),
                truncate_note_title(title),
                true,
                None::<&str>,
            )?;
            open_notes_menu.append(&item)?;
        }
        menu.append(&open_notes_menu)?;
    }
    // 플러그인 섹션 — 있을 때만 구분선과 함께 얹는다. 항목이 하나도 없으면 구분선도 없어
    // 트레이 모양이 예전과 완전히 같다(플러그인을 아무도 안 쓰면 비용 0).
    if !plugin_items.is_empty() {
        menu.append(&PredefinedMenuItem::separator(manager)?)?;
        for (index, item) in plugin_items.iter().enumerate() {
            let entry = MenuItem::with_id(
                manager,
                format!("{PLUGIN_TRAY_PREFIX}{index}"),
                &item.label,
                true,
                None::<&str>,
            )?;
            menu.append(&entry)?;
        }
    }
    menu.append(&sep_bottom)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// 시스템 트레이를 만들고 앱에 부착한다.
///
/// 역할: 메뉴바 상주 진입점 — 새 노트·노트 목록 패널·모두 보기/숨기기·종료(+ 플러그인 항목).
/// 왜: 메뉴바 전용 앱이라 트레이가 사용자의 주 진입점이다.
///
/// **호출 순서 전제**: `lib.rs`의 `setup`이 `state::init`을 이 함수보다 먼저 불러야 한다 —
/// 그래야 저장된 `SharedSettings.language`([`i18n::resolve`])를 초기 렌더에 바로 반영할 수
/// 있다. 순서가 바뀌어도 [`i18n::resolve`]는 상태 미등록을 ko 폴백으로 흡수해 패닉하지
/// 않지만, 그 경우 사용자가 저장해 둔 언어가 첫 프레임에 반영되지 않는다.
pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let strings = i18n::resolve(app);
    // 플러그인 항목은 아직 없다(중앙 호스트가 첫 빌드 뒤 set_plugin_tray_items로 채운다).
    // `open_notes`는 `lib.rs::run`이 이 함수를 `open_startup_windows` **뒤에** 부르므로
    // (호출 순서 변경 — 찾은 결함 수정: 예전엔 이 함수가 먼저 돌아 초기 「열린 노트」가 항상
    // 빈 목록이었다) 시작 복원된 노트 창까지 반영한 실제 목록이다.
    let (menu, open_notes) = build_tray_menu(app, &[], strings)?;

    let icon = app
        .default_window_icon()
        .expect("기본 창 아이콘이 필요합니다")
        .clone();

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // 겹침 목록(오버플로우 "^" 화살표)에 들어가도 이름으로 찾을 수 있도록 툴팁을 단다
        // (Windows에서 새 앱의 트레이 아이콘은 기본적으로 겹침 목록에 숨겨진다 — OS 기본
        // 동작이라 앱 코드로 강제 노출은 못 하지만, 툴팁은 찾는 데 도움이 된다).
        .tooltip("note-rang")
        .menu(&menu)
        .on_menu_event(|app, event| on_tray_menu_event(app, event.id.as_ref()));

    // Windows 클릭 관례 — 좌클릭은 메뉴 대신 주요 동작을, 우클릭만 메뉴를 띄운다. macOS는
    // 클릭 자체가 메뉴를 여는 관례라 이 분기를 타지 않는다(OS 분기, 모듈 상단 문서 참고).
    // `mut` 대신 그림자 재바인딩을 쓰는 이유: cfg로 빠지는 플랫폼(비Windows)에서 `let mut`
    // 만 있고 재대입이 없으면 `unused_mut`가 `-D warnings`에 걸린다.
    #[cfg(target_os = "windows")]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(on_tray_icon_event_windows);

    builder.build(app)?;
    // 방금 화면에 적용한 초기 목록으로 캐시를 맞춘다(Windows 전용 — `sync_open_notes_cache`
    // 문서 참고). 그러지 않으면 부팅 직후 첫 `notes-list-changed`의 시그니처 비교가 기준을
    // 잃는다.
    #[cfg(target_os = "windows")]
    sync_open_notes_cache(&open_notes);
    #[cfg(not(target_os = "windows"))]
    let _ = open_notes;

    // 노트 창의 설정 바로가기 버튼 → 이 창(트레이 「설정」과 동일 동작)을 연다. `EV_REQUEST_
    // OPEN_SETTINGS` 문서 참고: 새 Tauri 커맨드 대신 이 전역 이벤트로 우회한 이유가 있다.
    //
    // 왜 워커로 오프로딩하나(Windows 프리즈 수정): 프론트 emit은 WebView2 IPC로 배달되므로 이
    // 리스너 콜백도 메인 스레드의 IPC 디스패치 컨텍스트에서 돈다 — 그 안에서 `open_settings`가
    // 설정 창 부재 시 부르는 `WebviewWindowBuilder::build()`는 Windows에서 WebView2 컨트롤러
    // 생성이 재진입 데드락을 일으킨다(wry#583, docs.rs가 "synchronous command and event
    // handlers"를 함께 경고). `spawn_blocking`으로 넘겨 build가 리스너 컨텍스트 밖(워커)에서
    // 돌게 한다 — `window_manager::create_and_open`의 오프로딩과 같은 처방. 오류 처리(eprintln)는
    // 워커 안으로 그대로 옮긴다.
    let handle = app.handle().clone();
    app.listen(EV_REQUEST_OPEN_SETTINGS, move |_event| {
        let handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = window_manager::open_settings(&handle) {
                eprintln!("[memo] 설정 열기 실패(노트 창 요청): {e}");
            }
        });
    });

    // 「열린 노트」 섹션 최신화 — Windows 전용(`EV_NOTES_LIST_CHANGED` 문서 참고: 호버(Enter)
    // 마다 재구성하던 예전 방식이 우클릭 메뉴 파괴를 유발했던 문제의 대체 경로라, 그 결함이
    // 없던 macOS에는 이 리스너 자체가 필요 없다 — macOS 경로는 예전 그대로 setup/플러그인
    // 재설정/언어 변경 때만 재구성된다). 목록 계산(디스크 IO)은 워커로, 조립·`set_menu`는
    // 메인 스레드로 — 예전 `on_tray_icon_event_windows`의 Enter 처리가 쓰던 것과 같은 왕복
    // 패턴이다(muda/Win32 규칙, `build_tray_menu_with_notes` 문서 참고).
    //
    // 짧은 디바운스로 폭주를 하나로 합친다(찾은 결함 수정 — 열린 노트마다 매 자동저장이 이
    // 리스너를 따로 깨워, vault 잠금 아래 전체 본문을 다시 읽는 일이 열린 노트 수만큼
    // 곱해졌다). `should_schedule_refresh`가 이미 예약된 처리가 있으면 새로 스폰하지 않게
    // 막고, 예약된 처리는 깨어날 때 **그 시점의** 최신 상태를 다시 읽으므로 최신성은 잃지
    // 않는다 — 반영 시점만 최대 `NOTES_REFRESH_DEBOUNCE`만큼 늦춰진다.
    #[cfg(target_os = "windows")]
    {
        let handle = app.handle().clone();
        app.listen(EV_NOTES_LIST_CHANGED, move |_event| {
            if !should_schedule_refresh(&NOTES_REFRESH_PENDING) {
                return;
            }
            let app = handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(NOTES_REFRESH_DEBOUNCE);
                NOTES_REFRESH_PENDING.store(false, Ordering::Release);
                let strings = i18n::resolve(&app);
                // 디스크 IO — 워커 스레드에서 끝낸다(메인 스레드를 블록하지 않기 위함).
                let open_notes = open_notes_for_menu(&app);
                let handle = app.clone();
                let dispatched = app.run_on_main_thread(move || {
                    apply_open_notes_if_changed(&handle, strings, open_notes);
                });
                if let Err(e) = dispatched {
                    eprintln!("[memo] 트레이 메뉴 갱신 디스패치 실패: {e}");
                }
            });
        });
    }

    Ok(())
}

/// Windows 전용 트레이 아이콘 이벤트 — 좌클릭 주요 동작 + 우클릭 팝업 가드 세우기.
///
/// **`Enter`(호버)는 더 이상 아무것도 하지 않는다** — 예전에는 여기서 「열린 노트」 섹션을
/// 매 호버마다 다시 그려 `set_menu`로 교체했지만, 호버는 항상 우클릭보다 먼저 오고 그 재구성
/// (워커 IO → `run_on_main_thread` 왕복)이 우클릭의 `TrackPopupMenu` 모달 루프 안에서
/// 끝나면 `set_menu`의 내부 drop이 그 순간 표시 중인 HMENU를 파괴해 메뉴가 안 뜨거나 즉시
/// 사라졌다(사실상 매번 재현). 「열린 노트」 최신화는 이제 클릭 타이밍과 무관한
/// `notes-list-changed` 이벤트 리스너([`setup_tray`])가 맡고, 그마저도
/// [`apply_open_notes_if_changed`]가 시그니처를 비교해 실제로 달라졌을 때만 재구성한다 —
/// 모듈 문서의 "「열린 노트」 섹션 최신화" 참고.
///
/// - 좌클릭(Up): `show_menu_on_left_click(false)`로 메뉴 대신, 열린 노트가 있으면 모두
///   보이기+맨 앞으로, 없으면 패널을 연다 — `handle_second_instance`(lib.rs)와 같은 진입점
///   규칙이지만 lib.rs에 의존하지 않고 이 모듈 안에서 독립적으로 재현한다(트레이 클릭 경로를
///   tray.rs 안에 닫아 둔다).
/// - 우클릭(Down): tray-icon 0.24.1은 이 이벤트를 실제 `TrackPopupMenu` 호출(우클릭 Up에서
///   일어난다) **전에** 보낸다 — [`mark_popup_menu_shown`]으로 우클릭 팝업 가드를 세워, 그 뒤
///   곧 뜰 팝업이 살아 있는 동안 `set_menu`가 끼어들지 않게 한다(모듈 문서 "우클릭 팝업 가드"
///   참고).
#[cfg(target_os = "windows")]
fn on_tray_icon_event_windows(tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent) {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    if let TrayIconEvent::Click {
        button: MouseButton::Right,
        button_state: MouseButtonState::Down,
        ..
    } = event
    {
        mark_popup_menu_shown();
        return;
    }
    // 좌클릭(Up) 외의 나머지 이벤트(Enter/Move/Leave 등)는 이 핸들러가 다룰 게 없다 — 「열린
    // 노트」 최신화는 이제 `notes-list-changed` 리스너([`setup_tray`])가 맡는다(위 문서 참고).
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        let app = tray.app_handle();
        let has_open_notes = app
            .webview_windows()
            .keys()
            .any(|label| label.starts_with(NOTE_WINDOW_PREFIX));
        if has_open_notes {
            let _ = window_manager::set_all_notes_visible(app.clone(), true);
        } else if let Err(e) = window_manager::open_panel(app) {
            eprintln!("[memo] 트레이 좌클릭: 패널 열기 실패: {e}");
        }
    }
}

/// 트레이 메뉴 클릭 하나를 라우팅한다(고정 항목 또는 플러그인 항목).
///
/// 플러그인 항목(`ptray-<n>`)이면 목록 인덱스를 되짚어 프론트로 방송하고, 그 외에는 고정 항목
/// 동작을 수행한다. 메뉴를 다시 그려도(set_menu) 이 핸들러는 트레이에 그대로 붙어 있어 새
/// 플러그인 항목의 클릭도 여기로 온다.
///
/// **Windows 전용**: 진입 즉시 [`clear_popup_menu_guard`]로 우클릭 팝업 가드를 지운다 — 이
/// 핸들러가 불렸다는 것 자체가 `TrackPopupMenu`가 이미 반환했다는 뜻이라(메뉴 항목 클릭은 그
/// 모달 루프가 끝난 뒤에만 배달된다) 더 기다릴 이유가 없다(모듈 문서 "우클릭 팝업 가드" 참고).
fn on_tray_menu_event(app: &tauri::AppHandle, id: &str) {
    #[cfg(target_os = "windows")]
    clear_popup_menu_guard();
    if let Some(index) = plugin_tray_index(id) {
        emit_plugin_tray_click(app, index);
        return;
    }
    // 「열린 노트」 서브메뉴 항목 — id가 곧 창 라벨(build_tray_menu가 그렇게 만들었다).
    // summon_note는 노트 id(라벨에서 접두를 뗀 부분)를 받아 포커스한다(창이 그새 닫혔어도
    // window_manager가 다시 열어 복구한다).
    //
    // 워커로 보내는 이유(#22와 같은 부류의 회귀): 이 핸들러는 메뉴 클릭이 배달되는 메인
    // 이벤트 루프 스레드에서 동기 호출된다. `summon_note`가 `#[tauri::command(async)]`인
    // 것과는 무관하다 — 그 속성은 Tauri invoke 매크로가 생성하는 IPC 래퍼에만 적용되고,
    // 여기서는 일반 Rust 함수로 직접 부르므로 그 오프로딩이 전혀 적용되지 않는다. 즉
    // vault.lock()+read_meta/write_meta·창 조회가 그대로 이 스레드에서 동기 실행돼, 노트가
    // 많거나 vault가 느린 드라이브/실시간 백신 검사 대상이면 다른 모든 노트 창을 포함한
    // 전체 앱이 그 IO가 끝날 때까지 멎는다. `spawn_blocking`으로 직접 오프로딩한다.
    if let Some(note_id) = id.strip_prefix(NOTE_WINDOW_PREFIX) {
        let app = app.clone();
        let note_id = note_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = window_manager::summon_note(app, note_id) {
                eprintln!("[memo] 트레이 「열린 노트」 포커스 실패: {e}");
            }
        });
        return;
    }
    match tray_action_for(id) {
        TrayAction::Quit => app.exit(0),
        TrayAction::NewNote => {
            if let Err(e) = window_manager::create_and_open(app) {
                eprintln!("[memo] 새 노트 생성 실패: {e}");
            }
        }
        TrayAction::Panel => {
            if let Err(e) = window_manager::open_panel(app) {
                eprintln!("[memo] 패널 열기 실패: {e}");
            }
        }
        TrayAction::Settings => {
            if let Err(e) = window_manager::open_settings(app) {
                eprintln!("[memo] 설정 열기 실패: {e}");
            }
        }
        TrayAction::CheckUpdate => crate::updater::check_interactive(app),
        TrayAction::ShowAll => {
            let _ = window_manager::set_all_notes_visible(app.clone(), true);
        }
        TrayAction::HideAll => {
            let _ = window_manager::set_all_notes_visible(app.clone(), false);
        }
        TrayAction::Unknown => {}
    }
}

/// 플러그인 트레이 클릭을 중앙 호스트로 방송한다(프론트 `EV_TRAY_INVOKE` 수신).
///
/// 인덱스가 현재 목록 범위를 벗어나면(재설정으로 항목이 줄었는데 그 틈에 클릭) 조용히 무시한다 —
/// 되짚을 대상이 없다. 방송 실패도 무해하게 넘긴다(호스트 창이 없으면 클릭이 소실될 뿐이다).
fn emit_plugin_tray_click(app: &tauri::AppHandle, index: usize) {
    let target = plugin_tray_items()
        .lock()
        .ok()
        .and_then(|items| items.get(index).cloned());
    let Some(item) = target else {
        return;
    };
    let _ = app.emit(
        TRAY_INVOKE_EVENT,
        serde_json::json!({ "pluginId": item.plugin_id, "trayItemId": item.id }),
    );
}

/// 플러그인 메뉴바 트레이 항목 목록을 통째로 설정한다(증분이 아니라 전체 교체).
///
/// 중앙 호스트가 빌드마다 부른다 — 목록을 저장하고 트레이 메뉴를 고정 항목 + 「플러그인」
/// 섹션으로 다시 그린다. 빈 목록이면 섹션이 사라진다(플러그인을 끄면 항목도 사라져야 한다).
///
/// **동기 커맨드인 이유**: 메뉴·트레이 조작은 메인 스레드 UI 작업이고, 이 리포에서 동기 커맨드는
/// 메인 스레드에서 돈다 — 그래서 트레이 갱신이 여기 맞다. 항목 수가 적어 블로킹이 아니므로
/// (다이얼로그·파일 감시 같은 장시간 작업과 다르다) async로 뺄 이유가 없다.
#[tauri::command]
pub fn set_plugin_tray_items(
    app: tauri::AppHandle,
    items: Vec<PluginTrayItem>,
) -> Result<(), String> {
    // 목록을 먼저 굳힌 뒤 락을 놓고 메뉴를 만든다 — 메뉴 조립은 락을 필요로 하지 않는다.
    {
        let mut guard = plugin_tray_items()
            .lock()
            .map_err(|_| "트레이 항목 잠금 오류".to_string())?;
        *guard = items.clone();
    }
    let strings = i18n::resolve(&app);
    let (menu, open_notes) = build_tray_menu(&app, &items, strings)
        .map_err(|e| format!("트레이 메뉴 생성 실패: {e}"))?;
    // 트레이가 아직 없으면(부팅 순서 이상) 조용히 넘긴다 — 목록은 이미 저장됐고, 다음 빌드가
    // 다시 배달한다. 다만 정상 경로에서는 setup_tray가 항상 먼저 돈다.
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // 우클릭 팝업 가드(Windows 전용, 모듈 문서 참고) — 지금 set_menu를 부르면 화면에 떠
        // 있는 HMENU를 파괴할 위험이 있다. 걸렸으면 방금 조립한 `menu`는 버리고, 팝업이 닫힌
        // 뒤 한 번 더 재조립하도록 예약한 뒤 그대로 돌아간다(항목은 이미 저장했으니 유실이
        // 아니라 반영만 미뤄진다).
        #[cfg(target_os = "windows")]
        if !gate_or_schedule_menu_rebuild(&app) {
            return Ok(());
        }
        tray.set_menu(Some(menu))
            .map_err(|e| format!("트레이 메뉴 설정 실패: {e}"))?;
        // 방금 화면에 실제로 그려진 목록으로 캐시를 맞춘다(Windows 전용, 찾은 결함 수정 —
        // `sync_open_notes_cache` 문서 참고: 이 경로가 캐시를 건드리지 않아 이후
        // `notes-list-changed`의 시그니처 비교가 영구히 어긋나던 문제).
        #[cfg(target_os = "windows")]
        sync_open_notes_cache(&open_notes);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = open_notes;
    Ok(())
}

/// 언어가 바뀐 뒤 트레이 메뉴를 즉시 다시 그린다(고정 라벨만 새 언어로 — 플러그인 항목은 유지).
///
/// 역할: `save_shared_settings`(commands.rs)가 `SharedSettings.language` 변경을 감지하면
/// 부른다. 플러그인 항목은 세션 동안 [`plugin_tray_items`]에 보관돼 있으므로 그대로 다시
/// 넘겨 재조립한다 — [`set_plugin_tray_items`]와 같은 조립 지점([`build_tray_menu`])을 타므로
/// 트레이 모양이 갈라지는 경로가 생기지 않는다.
///
/// **호출 전제**: 새 언어가 이미 `AppState.shared.language`에 반영된 **뒤에** 불러야 한다 —
/// 이 함수는 별도로 언어를 인자로 받지 않고 [`i18n::resolve`]로 그 시점의 상태를 그대로 읽는다.
pub fn refresh_for_language_change(app: &tauri::AppHandle) -> tauri::Result<()> {
    // 작업 표시줄 점프 리스트(Windows)의 Tasks 라벨도 같은 언어로 다시 등록한다. 트레이와
    // 똑같이 "Rust가 내장 로케일 테이블로 그리는 네이티브 UI"라 프론트의 언어 전환이 닿지
    // 않고, 언어 변경을 감지하는 지점(commands.rs의 세 곳)이 부르는 함수가 이것뿐이라 여기
    // 붙인다. **맨 앞**에 두는 이유: 아래 트레이 재조립이 `?`로 실패해도 점프 리스트는
    // 갱신되게 하려는 것이다(두 네이티브 UI의 언어가 서로 어긋난 채 남지 않도록).
    // 등록 자체는 워커로 빠지므로 이 호출은 즉시 반환한다.
    crate::jumplist::refresh(app);

    let items = plugin_tray_items()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let strings = i18n::resolve(app);
    let (menu, open_notes) = build_tray_menu(app, &items, strings)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // 우클릭 팝업 가드(Windows 전용) — `set_plugin_tray_items`와 같은 이유(모듈 문서 참고).
        #[cfg(target_os = "windows")]
        if !gate_or_schedule_menu_rebuild(app) {
            return Ok(());
        }
        tray.set_menu(Some(menu))?;
        // `set_plugin_tray_items`와 같은 이유로 캐시를 맞춘다(Windows 전용,
        // `sync_open_notes_cache` 문서 참고).
        #[cfg(target_os = "windows")]
        sync_open_notes_cache(&open_notes);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = open_notes;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 알려진 고정 메뉴 id가 올바른 동작으로 매핑되는지 고정한다.
    #[test]
    fn maps_known_menu_ids() {
        assert_eq!(tray_action_for("new_note"), TrayAction::NewNote);
        assert_eq!(tray_action_for("panel"), TrayAction::Panel);
        assert_eq!(tray_action_for("settings"), TrayAction::Settings);
        assert_eq!(tray_action_for("check_update"), TrayAction::CheckUpdate);
        assert_eq!(tray_action_for("show_all"), TrayAction::ShowAll);
        assert_eq!(tray_action_for("hide_all"), TrayAction::HideAll);
        assert_eq!(tray_action_for("quit"), TrayAction::Quit);
    }

    /// 가드: 알 수 없는/빈 id는 Unknown으로 떨어져 잘못된 동작을 유발하지 않는다.
    #[test]
    fn unknown_menu_id_is_inert() {
        assert_eq!(tray_action_for("whatever"), TrayAction::Unknown);
        assert_eq!(tray_action_for(""), TrayAction::Unknown);
    }

    /// 가드: 플러그인 트레이 메뉴 id(`ptray-<n>`)에서 인덱스를 정확히 뽑는다.
    #[test]
    fn parses_plugin_tray_index() {
        assert_eq!(plugin_tray_index("ptray-0"), Some(0));
        assert_eq!(plugin_tray_index("ptray-12"), Some(12));
    }

    /// 가드: 플러그인 항목이 아닌 id는 인덱스로 해석되지 않는다(형식이 정확해야 한다).
    #[test]
    fn non_plugin_ids_have_no_tray_index() {
        assert_eq!(plugin_tray_index("new_note"), None);
        assert_eq!(plugin_tray_index("ptray-"), None); // 숫자 없음
        assert_eq!(plugin_tray_index("ptray-x"), None); // 숫자 아님
        assert_eq!(plugin_tray_index("ptray--1"), None); // 음수 아님(usize)
        assert_eq!(plugin_tray_index("ptray"), None); // 접두만
        assert_eq!(plugin_tray_index(""), None);
    }

    /// 가드: 플러그인 트레이 id는 고정 항목 라우팅에서 Unknown이다 — `on_tray_menu_event`가
    /// `plugin_tray_index`로 먼저 가로채므로, 이 안전망 덕에 고정 분기가 플러그인 id를
    /// 오인하지 못한다(두 라우팅이 겹치지 않음을 고정).
    #[test]
    fn plugin_tray_ids_are_unknown_to_fixed_routing() {
        assert_eq!(tray_action_for("ptray-0"), TrayAction::Unknown);
        assert_eq!(tray_action_for("ptray-7"), TrayAction::Unknown);
    }

    /// 가드: 「열린 노트」 메뉴 id(창 라벨 `note-<id>`)에서 노트 id를 정확히 뽑는다 —
    /// `on_tray_menu_event`가 이 접두로 라우팅을 가로챈다.
    #[test]
    fn strips_note_window_prefix() {
        assert_eq!(
            "note-abc123".strip_prefix(NOTE_WINDOW_PREFIX),
            Some("abc123")
        );
        // UUID 자체에 하이픈이 있어도 접두만 한 번 제거된다(나머지 하이픈은 id의 일부).
        assert_eq!(
            "note-550e8400-e29b-41d4-a716-446655440000".strip_prefix(NOTE_WINDOW_PREFIX),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert_eq!("panel".strip_prefix(NOTE_WINDOW_PREFIX), None);
        assert_eq!("ptray-0".strip_prefix(NOTE_WINDOW_PREFIX), None);
    }

    /// 가드: 노트 창 라벨은 고정 항목 라우팅에서 Unknown이다(`ptray-`와 같은 안전망) —
    /// `on_tray_menu_event`가 `NOTE_WINDOW_PREFIX`로 먼저 가로채므로, 고정 분기가 노트 라벨을
    /// 오인해 엉뚱한 동작(예: 종료)을 하지 않는다.
    #[test]
    fn note_window_ids_are_unknown_to_fixed_routing() {
        assert_eq!(tray_action_for("note-abc123"), TrayAction::Unknown);
    }

    /// 가드: 메뉴 폭 안에 들어가는 짧은 제목은 그대로, 넘치는 제목은 잘리고 말줄임표가 붙는다
    /// (char 단위 — 멀티바이트 문자를 깨지 않는다).
    #[test]
    fn truncates_long_note_titles() {
        assert_eq!(truncate_note_title("짧은 제목"), "짧은 제목");
        let long = "가".repeat(50);
        let truncated = truncate_note_title(&long);
        assert_eq!(
            truncated.chars().count(),
            TRAY_NOTE_TITLE_MAX_CHARS + 1 // 말줄임표 1글자 포함
        );
        assert!(truncated.starts_with(&"가".repeat(TRAY_NOTE_TITLE_MAX_CHARS)));
        assert!(truncated.ends_with('…'));
    }

    /// 가드(우클릭 메뉴 파괴 결함의 핵심 수정, Windows 전용): 목록이 실제로 달라졌을 때만
    /// true를 돌려주고 캐시를 갱신한다 — 같으면 캐시를 건드리지 않고 false.
    /// `apply_open_notes_if_changed`가 이 결과로 `set_menu`(HMENU 교체) 자체를 스킵해,
    /// 우클릭으로 뜬 `TrackPopupMenu`가 표시 중인 HMENU를 파괴하지 않게 한다.
    #[cfg(target_os = "windows")]
    #[test]
    fn signature_changed_detects_diff_and_skips_when_same() {
        let mut cache: Option<Vec<(String, String)>> = None;
        let a = vec![("note-1".to_string(), "제목".to_string())];

        // 최초 관찰(cache == None)은 항상 변경으로 판정된다.
        assert!(signature_changed(&mut cache, &a));
        assert_eq!(cache.as_deref(), Some(a.as_slice()));

        // 같은 목록을 다시 관찰하면 변경 없음 — 캐시도 그대로다.
        assert!(!signature_changed(&mut cache, &a));
        assert_eq!(cache.as_deref(), Some(a.as_slice()));

        // 제목만 바뀌어도(창 라벨은 같음) 변경으로 판정된다.
        let b = vec![("note-1".to_string(), "다른 제목".to_string())];
        assert!(signature_changed(&mut cache, &b));
        assert_eq!(cache.as_deref(), Some(b.as_slice()));
        assert!(!signature_changed(&mut cache, &b));

        // 노트가 하나 더 열려도(길이 변화) 변경으로 판정된다.
        let c = vec![
            ("note-1".to_string(), "다른 제목".to_string()),
            ("note-2".to_string(), "두 번째".to_string()),
        ];
        assert!(signature_changed(&mut cache, &c));
        assert!(!signature_changed(&mut cache, &c));
    }

    /// 가드(찾은 결함 수정, Windows 전용): `apply_open_notes_if_changed`를 거치지 않는 세
    /// 재조립 경로(`setup_tray`·`set_plugin_tray_items`·`refresh_for_language_change`)가
    /// 화면에 실제로 그린 목록으로 캐시를 강제 동기화한다(달랐는지 따지지 않고 항상 덮어쓴다).
    /// 그 뒤 `signature_changed`가 이 값을 정확한 기준으로 삼는지까지 확인한다 — 그러지
    /// 않으면 그 세 경로가 그린 목록과 캐시가 어긋난 채 남아, 실제 변경이 와도 "안 바뀌었다"
    /// 고 오판해 영구히 재구성을 건너뛰었다(찾은 결함).
    #[cfg(target_os = "windows")]
    #[test]
    fn sync_open_notes_cache_overwrites_unconditionally() {
        let a = vec![("note-1".to_string(), "제목".to_string())];
        sync_open_notes_cache(&a);
        {
            let cache = last_open_notes_signature()
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            assert_eq!(cache.as_deref(), Some(a.as_slice()));
        }
        // 캐시가 이 값을 기준으로 정확히 판정하는지(같으면 변경 없음)까지 확인한다.
        {
            let mut cache = last_open_notes_signature()
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            assert!(!signature_changed(&mut cache, &a));
        }

        let b: Vec<(String, String)> = Vec::new();
        sync_open_notes_cache(&b);
        let cache = last_open_notes_signature()
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        assert_eq!(cache.as_deref(), Some(b.as_slice()));
    }

    /// 가드(찾은 결함 수정, Windows 전용 — 자동저장마다 열린 노트 전체를 vault 잠금 아래
    /// 다시 읽던 문제): 짧은 시간 안에 몰린 이벤트를 하나로 합친다 — 처음은 예약(새로
    /// 스폰해야 함), 그 사이 온 이벤트는 이미 예약된 처리에 편승(스폰 불필요), 처리가 끝나
    /// 플래그가 풀리면 다음 버스트는 다시 예약된다.
    #[cfg(target_os = "windows")]
    #[test]
    fn should_schedule_refresh_coalesces_bursts() {
        let pending = AtomicBool::new(false);
        assert!(should_schedule_refresh(&pending), "처음은 예약해야 한다");
        assert!(
            !should_schedule_refresh(&pending),
            "이미 예약됐으면 편승해야 한다"
        );
        assert!(
            !should_schedule_refresh(&pending),
            "여러 번 몰려도 계속 편승해야 한다"
        );

        pending.store(false, Ordering::Release); // 예약된 처리가 끝남을 흉내
        assert!(
            should_schedule_refresh(&pending),
            "처리가 끝난 뒤 다음 버스트는 다시 예약해야 한다"
        );
    }

    /// 가드(우클릭 팝업 가드의 핵심 판정, Windows 전용): 데드라인이 없거나 이미 지났으면
    /// `None`(그려도 된다), 아직 안 지났으면 남은 시간을 `Some`으로 돌려준다.
    /// `gate_or_schedule_menu_rebuild`/`is_popup_menu_active`가 이 순수 함수 하나로 판정한다.
    #[cfg(target_os = "windows")]
    #[test]
    fn popup_menu_guard_remaining_reflects_deadline() {
        let now = Instant::now();

        // 데드라인이 아예 없으면(우클릭한 적 없음) 항상 None.
        assert_eq!(popup_menu_guard_remaining(None, now), None);

        // 아직 지나지 않은 미래 데드라인이면 그 차이를 Some으로 돌려준다.
        let future = now + Duration::from_secs(2);
        assert_eq!(
            popup_menu_guard_remaining(Some(future), now),
            Some(Duration::from_secs(2))
        );

        // 이미 지난 데드라인(과거)이면 None — 언더플로 없이 안전하게 만료로 취급한다.
        let past = now - Duration::from_secs(1);
        assert_eq!(popup_menu_guard_remaining(Some(past), now), None);

        // 정확히 지금이 데드라인이면 남은 시간 0으로 아직 "활성"이다(경계값).
        assert_eq!(
            popup_menu_guard_remaining(Some(now), now),
            Some(Duration::ZERO)
        );
    }

    /// 가드: AppState가 등록되지 않은(mock) 앱에서는 패닉 없이 빈 목록으로 폴백한다(부팅
    /// 초입·테스트 환경 안전망).
    #[test]
    fn open_notes_for_menu_falls_back_when_state_missing() {
        let app = tauri::test::mock_app();
        assert!(open_notes_for_menu(&app).is_empty());
    }

    /// 가드: vault 잠금이 poison된 뒤에도 `open_notes_for_menu`가 영구히 빈 목록으로 굳지
    /// 않는다 — 예전의 원시 `state.vault.lock()`은 poison 이후 계속 `Err`을 돌려줘, 다른
    /// 커맨드의 패닉 한 번이 「열린 노트」 서브메뉴를 프로세스가 끝날 때까지 영구히 비워
    /// 버렸다(state.rs의 `poisoned_lock_recovers_instead_of_cascading`와 같은 결).
    #[test]
    fn open_notes_for_menu_recovers_after_lock_poisoned() {
        use crate::model::SharedSettings;
        use crate::notes::Vault;
        use crate::settings::LocalConfig;
        use crate::state::AppState;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("포이즌 이후 목록 확인").unwrap();
        handle.manage(AppState::new(
            vault,
            SharedSettings::default(),
            LocalConfig::with_defaults(dir.path()),
        ));
        let label = format!("note-{id}");
        tauri::WebviewWindowBuilder::new(
            &handle,
            label.clone(),
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();

        // 다른 커맨드가 vault 잠금을 쥔 채 패닉하는 상황을 흉내낸다.
        let state = handle.state::<AppState>();
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.vault.lock().unwrap();
            panic!("임계구역 패닉");
        }));
        assert!(poisoned.is_err());
        assert!(state.vault.is_poisoned());

        // poison 이후에도 목록이 여전히 채워진다(예전엔 여기서부터 영구히 빈 Vec).
        let items = open_notes_for_menu(&handle);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, label);
    }
}
