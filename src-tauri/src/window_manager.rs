//! 노트 창 관리 — borderless 창 생성, 위치 복원, override 적용.
//!
//! 역할: 노트 id별 borderless+transparent 창을 만들고, 저장된 기하를 디스플레이 인식
//! 방식으로 복원하며, 노트별 override(투명도·핀·모든 Space)를 적용한다. 좌표는 DPI에
//! 무관하도록 논리 좌표로 다룬다.
//! 왜: 데이터 계층과 네이티브 창 제어를 실제 멀티윈도우로 연결한다.

use crate::display::{
    capture_geometry, gather_into_view, restore_position, DisplayInfo, SavedGeometry,
};
use crate::i18n::{self, Strings};
use crate::model::{resolve_settings, ResolvedNoteSettings};
use crate::notes::{now_ms, Vault};
use crate::state::AppState;
use crate::windows;
use std::time::{Duration, Instant};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// 새 노트 창의 기본 크기.
const DEFAULT_W: f64 = 360.0;
const DEFAULT_H: f64 = 260.0;

/// 헤더만 남기고 접었을 때의 창 높이. 숨김이 아니라 높이 조절.
/// 값 근거: 테두리 2px + 상단 툴바 상하 패딩 8px×2 + 아이콘 행 20px = 38px. 이렇게 하면 접힘 헤더의
/// 버튼이 펼침 상태(상단 패딩 8px)와 창 top 기준 같은 위치에 와, 접기/펼치기 전환 시 세로 이동이 0이다
/// (styles.css의 `#app.note-collapsed .note-toolbar` 대칭 패딩과 짝을 이룬다).
const COLLAPSED_H: f64 = 38.0;

/// 노트 창 최소 크기(펼침 상태) — 너무 작게 줄여 못 쓰게 되는 것을 막는다.
const MIN_W: f64 = 240.0;
const MIN_H: f64 = 100.0;

/// 리사이즈 실측 높이를 "사용자가 실제로 끌었다"고 볼 최소 폭(논리 px).
///
/// 왜 필요한가: [`collapse_from_resize`]가 보는 높이는 논리 좌표로 환산한 실측값이라 DPI
/// 배율·플랫폼 보정에서 1px 안팎으로 흔들릴 수 있고, 우리가 프로그램적으로 맞춘 높이가
/// 그대로 다시 되돌아오기도 한다(리사이즈 → `save_window_geometry` 되먹임). 그 폭 안의
/// 차이는 전이 신호로 읽지 않아야 같은 입력이 다시 들어와도 상태가 진동하지 않는다.
const RESIZE_SLACK: f64 = 2.0;

/// 모니터 열거가 재시도 후에도 끝내 비어 있을 때 쓰는 안전 위치 — 화면 좌상단 (0,0) 구석에
/// 딱 붙지 않도록 살짝 띄운다(부팅 자동시작 극단 상황의 최후 폴백, [`apply_saved_state`] 참고).
const FALLBACK_X: f64 = 80.0;
const FALLBACK_Y: f64 = 80.0;

/// 창 타이틀에 노출할 제목의 최대 글자 수. 작업 표시줄/미션 컨트롤에서 과도하게 길어지지
/// 않도록 자른다(바이트가 아니라 char 단위 — 멀티바이트 문자를 깨지 않는다).
const TITLE_MAX_CHARS: usize = 40;

/// 노트 본문에서 창 타이틀을 만든다. 빈 노트는 구분할 제목이 없으므로 언어별 앱 이름을
/// 유지한다(`strings.app_name` — i18n.rs, 한국어 "노트랑" / 영어 "Note Rang". tauri.conf.json의
/// productName("Note Rang")과도 맞춘다).
///
/// `pub(crate)`인 이유: 창 생성(`open_note_window_impl` → `initial_window_title`)과 저장 갱신
/// (`refresh_window_title`, `commands::note_save_content`가 호출)이 같은 규칙을 공유해야,
/// "제목이 실제로 바뀌었는지" 비교(저장 때마다 불필요한 `set_title` 호출을 피하는 것)가 두
/// 경로에서 어긋나지 않는다. `strings`를 인자로 받는 이유: 이 함수 자체는 순수하게 남겨
/// GUI/상태 없이 테스트 가능하게 하고, "지금 이 순간의 언어"를 고르는 일은 호출부
/// ([`i18n::resolve`])에 맡긴다.
pub(crate) fn window_title_for_content(content: &str, strings: &Strings) -> String {
    if crate::notes::is_blank(content) {
        return strings.app_name.to_string();
    }
    truncate_chars(&crate::notes::derive_title(content), TITLE_MAX_CHARS)
}

/// 문자(char) 단위로 최대 `max`자까지 자른다.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 저장 시점에 노트 창 타이틀을 본문에 맞춰 갱신한다. 창이 없으면(닫혀 있거나 플러그인
/// 브리지 경유 저장 등) 조용히 넘어간다. 계산한 제목이 현재 타이틀과 같으면 `set_title`을
/// 호출하지 않는다(저장은 자동저장으로 잦으므로 불필요한 네이티브 호출을 줄인다).
pub fn refresh_window_title<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, content: &str) {
    let Some(window) = app.get_webview_window(&note_label(id)) else {
        return;
    };
    let new_title = window_title_for_content(content, i18n::resolve(app));
    let changed = window.title().map(|cur| cur != new_title).unwrap_or(true);
    if changed {
        let _ = window.set_title(&new_title);
    }
}

/// 접힘/펼침에 맞는 크기 제약을 적용한다 — **다른 것은 최소 높이뿐**이다(접힘 COLLAPSED_H,
/// 펼침 MIN_H). 폭 하한은 두 상태 모두 MIN_W이고, 최대 크기는 어느 쪽에도 두지 않는다.
///
/// 왜 접힘에 세로 상한을 두지 않는가(예전에는 min==max==COLLAPSED_H로 잠갔다): 접힌 창을
/// 위아래로 끌어 다시 펼치고 싶다는 요구가 있었는데, 세로가 잠겨 있으면 드래그 자체가 OS
/// 단계에서 막혀 [`collapse_from_resize`]가 판정할 실측값이 애초에 생기지 않는다. 잠금을
/// 풀어 두면 접힌 창을 세로로 끄는 순간 실측 높이가 백엔드로 올라오고, 그 높이가 곧
/// "펼쳐라"라는 신호가 된다.
///
/// max를 항상 **먼저** 해제한다 — 예전 잠금(세로 max)이 남아 있는 창에서도 min 높이를
/// MIN_H로 올릴 수 있어야 한다(min>max 충돌 방지).
fn apply_size_limits<R: tauri::Runtime>(window: &WebviewWindow<R>, collapsed: bool) {
    let _ = window.set_max_size(Option::<LogicalSize<f64>>::None);
    let min_h = if collapsed { COLLAPSED_H } else { MIN_H };
    let _ = window.set_min_size(Some(LogicalSize::new(MIN_W, min_h)));
}

/// 노트 목록·검색 패널 창 라벨(노트 창 라벨 `note-*`과 구분).
const PANEL_LABEL: &str = "panel";

/// 설정·플러그인 매니저 창 라벨.
const SETTINGS_LABEL: &str = "settings";

/// 플러그인 중앙 호스트(숨김 상주) 창 라벨.
const PLUGIN_HOST_LABEL: &str = "plugin-host";

/// 노트 id에서 창 라벨을 만든다.
pub fn note_label(id: &str) -> String {
    format!("note-{id}")
}

fn is_note_window_label(label: &str) -> bool {
    label.starts_with("note-")
}

/// 프론트 `EV_NOTES_LIST_CHANGED`(`src/plugin/host-protocol.ts`)와 **같은 문자열** — 열려
/// 있는 패널이 이 신호로 노트 목록을 다시 읽는다. 페이로드는 없다(무엇이 바뀌었는지보다
/// "다시 읽어라"만 전달한다 — host-protocol.ts의 같은 상수 문서와 동일한 규약).
///
/// 왜 Rust가 직접 emit하는가: `src/shared/tauri.ts`의 `afterNotesChanged`는 노트 생성·삭제·
/// 보관·저장 커맨드의 프론트 invoke를 감싸 성공 시 이 이벤트를 낸다. 그런데 트레이 "새 노트"
/// 와 전역 단축키로 만든 노트는 프론트 invoke를 전혀 거치지 않고 [`create_and_open`]이
/// Rust에서 곧장 vault에 쓴다 — `afterNotesChanged`가 감쌀 지점 자체가 없다. 그 결과 패널을
/// 띄워 둔 채 트레이·단축키로 새 노트를 만들면, 그 노트에 실제로 타이핑해 자동저장이 한 번
/// 돌기 전까지 패널 목록에 나타나지 않았다(빈 노트를 만들고 바로 닫으면 패널은 영원히 모른
/// 채로 남는다). 여기서 직접 방송해 그 갭을 메운다.
///
/// `pub(crate)`인 이유: `lib.rs`의 전역 `on_window_event` 훅(`on_note_window_event`)이 노트
/// 창 파괴(`WindowEvent::Destroyed`)에서도 같은 이벤트를 내야 트레이 「열린 노트」가 창 닫힘도
/// 반영한다(찾은 결함 수정) — 그 훅은 `tray.rs`가 아니라 `lib.rs`의 `Builder` 단계에서만 등록
/// 가능해(트레이는 `.setup()` 안에서 만들어져 이미 늦다) 리터럴을 중복하는 대신 여기서 직접
/// 가져다 쓴다(같은 파일 안의 `tray.rs`는 여전히 자체 사본을 쓴다 — 그 파일 상단 주석 참고).
pub(crate) const EV_NOTES_LIST_CHANGED: &str = "notes-list-changed";

/// 프론트 `EV_NOTE_DELETED`(`src/plugin/host-protocol.ts`)와 **같은 문자열** — 노트 하나가
/// 지워졌음을 그 노트의 열린 창에 알린다. 페이로드는 `{ id }`.
///
/// 쓰임: [`commands::note_delete`](crate 문서 참고)가 파일을 지우기 **전에** 이 이벤트를
/// 전역 방송한다. 그 id의 노트 창이 열려 있으면(`bootstrap/note.ts`의 리스너) 대기 중인
/// 자동저장을 취소하고 스스로 닫는다 — 그래야 창이 닫히며 나가는 `pagehide` flush가
/// 방금(또는 곧) 지워질 `.md`를 되살리지 않는다(note-window.ts 모듈 문서의 「부활 함정」).
///
/// [`notify_and_close_note_window`]가 이 이벤트를 낸 뒤 그 창이 실제로 사라질 때까지
/// 기다린다 — `close_all_note_windows`가 부르는 강제 `window.close()`와 달리, 이 경로는
/// 프론트가 먼저 취소한 뒤 스스로 닫게 해 "닫는 행위 자체가 flush를 유발한다"는 문제를
/// 애초에 피한다(강제 닫기는 제한 시간을 넘긴 뒤의 최후 수단일 뿐이다).
const EV_NOTE_DELETED: &str = "note-deleted";

/// 프론트 `EV_NOTE_COLLAPSED_CHANGED`(`src/plugin/host-protocol.ts`)와 **같은 문자열** — 창
/// 세로 리사이즈로 백엔드가 접힘/펼침을 **스스로 다시 판정했음**을 알린다. 페이로드는
/// `{ id, collapsed }`.
///
/// 왜 필요한가: 접기/펼치기는 평소 프론트(툴바 버튼)가 시작하지만, 세로 드래그로 일어나는
/// 전이([`collapse_from_resize`])는 **백엔드만 안다** — 창 크기 실측은 `save_window_geometry`로만
/// 올라오기 때문이다. 알리지 않으면 창은 펼쳐졌는데 접기 버튼은 접힘 상태로 남고 에디터도
/// 계속 숨겨져 있다(반대도 마찬가지). 그 id의 노트 창이 이 신호로 버튼·에디터 표시만
/// 되맞춘다 — 창 높이와 메타는 이미 백엔드가 확정했으므로 되돌려 부르지 않는다(무한 왕복 방지).
const EV_NOTE_COLLAPSED_CHANGED: &str = "note-collapsed-changed";

/// 노트 창이 스스로 정리하고 닫기를 기다리는 상한 — 넘으면 강제로 닫는다(무한정 매달리지
/// 않는다). `commands::WINDOW_CLOSE_WAIT`(전체 삭제용)와 같은 값을 쓴다 — 정상 경로에서는
/// 프론트가 이벤트를 받자마자 취소+닫기를 동기로 처리하므로 이 상한에 거의 닿지 않는다.
const NOTE_DELETE_CLOSE_WAIT: Duration = Duration::from_millis(1500);

/// 노트 창이 사라졌는지 확인하는 간격.
const NOTE_DELETE_CLOSE_POLL: Duration = Duration::from_millis(20);

fn wait_until_window_closed<F>(deadline: Instant, mut is_open: F) -> bool
where
    F: FnMut() -> bool,
{
    loop {
        if !is_open() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(NOTE_DELETE_CLOSE_POLL);
    }
}

/// 지워질 노트의 창이 열려 있으면 [`EV_NOTE_DELETED`]로 알리고, 실제로 사라질 때까지
/// 기다린다. 열려 있지 않으면 즉시 true(알릴 것도 닫을 것도 없다).
///
/// **파일을 지우기 전에** 불러야 한다([`crate::commands::note_delete`] 문서 참고) — 이
/// 함수가 도는 동안(그리고 이 함수가 true를 돌려준 뒤)에도 노트는 아직 vault에 존재하므로,
/// 그 사이 도착하는 자동저장은 정상적으로 쓰일 뿐 지운 파일을 되살리는 것이 아니다.
///
/// 창이 제한 시간 안에 스스로 닫지 않으면(얼어붙었거나 이벤트를 놓쳤거나) 강제로 닫고
/// false를 돌려준다 — 그 강제 닫기가 유발하는 마지막 `pagehide` flush는
/// [`crate::commands::note_save_content`]의 삭제-후-쓰기 가드가 무해화한다(파일이 이미
/// 없으면 되살리지 않는다). `close_note_windows_and_settle`(전체 삭제)과 같은 최후 수단
/// 구조이지만, 이쪽은 강제 닫기 전에 먼저 취소할 기회를 준다는 점이 다르다.
///
/// 블로킹 대기이므로 **blocking 풀에서** 불러야 한다(다른 `close_*_and_settle`과 같은 이유
/// — commands.rs 모듈 문서의 「blocking 풀에서」 정책).
pub fn notify_and_close_note_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> bool {
    let label = note_label(id);
    let Some(window) = app.get_webview_window(&label) else {
        return true;
    };
    let _ = app.emit(EV_NOTE_DELETED, serde_json::json!({ "id": id }));
    if wait_until_window_closed(Instant::now() + NOTE_DELETE_CLOSE_WAIT, || {
        app.get_webview_window(&label).is_some()
    }) {
        return true;
    }
    let _ = window.close();
    false
}

/// 창에서 본 monitor 목록을 논리 좌표 [`DisplayInfo`]로 모은다.
fn displays_of(window: &WebviewWindow) -> Vec<DisplayInfo> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let scale = m.scale_factor();
            let p = m.position().to_logical::<f64>(scale);
            let s = m.size().to_logical::<f64>(scale);
            DisplayInfo {
                id: m.name().cloned().unwrap_or_else(|| format!("display-{i}")),
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            }
        })
        .collect()
}

/// [`displays_of_with_retry`]가 빈 목록일 때 재시도하는 최대 횟수(첫 시도 포함).
const DISPLAY_RETRY_MAX: u32 = 5;

/// 재시도 사이 대기 간격.
const DISPLAY_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// 빈 결과를 돌려주는 동안 `interval` 간격으로 `max_attempts`회까지 `f`를 다시 부르는 일반
/// 재시도 로직. 실제 모니터 열거(`WebviewWindow` 의존)와 분리해 두어 클로저만으로 순수
/// 테스트할 수 있게 한다 — `displays_of_with_retry`는 이것을 `displays_of`로 감싼 것뿐이다.
fn retry_until_non_empty<T>(
    max_attempts: u32,
    interval: Duration,
    mut f: impl FnMut() -> Vec<T>,
) -> Vec<T> {
    for attempt in 0..max_attempts {
        let result = f();
        if !result.is_empty() {
            return result;
        }
        if attempt + 1 < max_attempts {
            std::thread::sleep(interval);
        }
    }
    Vec::new()
}

/// 부팅 직후 자동시작에서는 모니터 열거(`available_monitors`)가 아직 준비되지 않아 빈 목록을
/// 돌려줄 수 있다 — 그러면 [`apply_saved_state`]가 위치 복원을 통째로 건너뛰어 창이 (0,0)
/// 구석에 생긴다. 빈 목록이면 `DISPLAY_RETRY_INTERVAL` 간격으로 `DISPLAY_RETRY_MAX`회까지
/// 재시도한다(마지막 시도 뒤에는 기다리지 않는다). 평소 실행(첫 호출에 값이 있음)은 지연이
/// 전혀 없다.
fn displays_of_with_retry(window: &WebviewWindow) -> Vec<DisplayInfo> {
    retry_until_non_empty(DISPLAY_RETRY_MAX, DISPLAY_RETRY_INTERVAL, || {
        displays_of(window)
    })
}

/// 노트 창을 연다(이미 있으면 재사용). borderless + transparent. 새 노트·소환은 창을
/// 포커스+맨 앞으로 올린다(사용자 요청).
pub fn open_note_window(app: &tauri::AppHandle, id: &str) -> tauri::Result<()> {
    open_note_window_impl(app, id, true)
}

/// `open_note_window`의 본체. `focus=false`면 포커스/raise를 건너뛴다(시작 복원처럼 포커스를
/// 뺏지 않아야 할 때). `focus=true`면 새로 만들거나 재사용한 창을 앞으로 올린다.
fn open_note_window_impl(app: &tauri::AppHandle, id: &str, focus: bool) -> tauri::Result<()> {
    let label = note_label(id);
    if let Some(win) = app.get_webview_window(&label) {
        // 창이 숨겨진 채(트레이 "모두 숨기기" → `set_all_notes_visible(false)` → `hide()`)
        // 재사용될 수 있다 — 이미 보이는 창에 다시 불러도 안전하므로(idempotent) 무조건
        // unminimize()+show()를 먼저 부른다. show()만으로는 최소화가 풀리지 않는다(tao
        // Windows의 `show()`는 `SW_SHOW`라 이미 `WS_MINIMIZE`인 창은 그대로 최소화 상태로
        // 남는다) — 이게 없으면 트레이 "열린 노트"로 숨기거나 최소화한 노트를 소환해도
        // 계속 안 보인다: tao의 Windows `set_focus`는 `is_visible`이 false거나 최소화 상태면
        // 완전히 no-op이고, `windows::raise_window`도 이 플랫폼에서는 macOS 전용 구현이라
        // no-op이기 때문이다.
        let _ = win.unminimize();
        let _ = win.show();
        if focus {
            let _ = win.set_focus();
            windows::raise_window(&win);
        }
        return Ok(());
    }
    let url = WebviewUrl::App(format!("index.html?note={id}").into());
    let title = initial_window_title(app, id);
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title(title)
        .decorations(false)
        .transparent(true)
        .inner_size(DEFAULT_W, DEFAULT_H)
        .min_inner_size(MIN_W, MIN_H);
    // Windows에서만 네이티브 창 그림자를 끈다(베타 피드백 "꼭지점 부분에 뭔가 보인다").
    //
    // 왜: tao는 "장식 없음 + 그림자 있음" 창을 **실제 창 사각형을 프레임 두께만큼 부풀리고
    // WM_NCCALCSIZE로 클라이언트 영역을 그만큼 안쪽으로 밀어** 만든다(`calculate_insets_for_dpi`).
    // 이 머신에서 실측한 값이 정확히 그 모양이었다: 창 사각형 376×269, DWM이 보는 프레임
    // 376-14=362×262, 좌/상/우/하 간격 7/0/7/7. 남은 바깥 테두리에 DWM이 표준 창 그림자를
    // 그리는데, 그 그림자는 창 **뒤에** 깔리므로 `transparent(true)` + 둥근 CSS 모서리로 뚫려
    // 있는 네 꼭지점을 통해 그대로 비쳐 보인다. 게다가 그림자 실루엣의 모서리 반경(DWM)과
    // 카드의 반경(CSS 10px)이 서로 다르고 기준 사각형도 7px 어긋나 있어, 직선 변에서는 자연스러운
    // 그림자가 **꼭지점에서만** 두껍고 각진 얼룩으로 뭉친다 — 사용자가 본 그것이다.
    //
    // `shadow(false)`면 tao가 이 부풀리기 자체를 하지 않아(WM_NCCALCSIZE가 창 전체를 클라이언트로
    // 돌려준다) 창 사각형 = 보이는 영역이 되고, DWM이 그릴 프레임이 없어져 비쳐 보일 그림자도
    // 사라진다. 리사이즈는 그대로다 — 그림자가 없는 borderless 창에서 tao는 위쪽 모서리만이
    // 아니라 **네 변 전부**를 자체 히트 테스트로 처리한다(tao event_loop.rs의 WM_NCHITTEST).
    // 짝이 되는 처방은 [`windows::apply_borderless_corners`](DWM 라운딩 끄기) — 그 문서 참고.
    //
    // macOS는 건드리지 않는다: NSWindow 그림자는 창 모양(둥근 모서리)을 따라 정확히 그려져
    // 같은 문제가 없고, 스티키 노트의 떠 있는 느낌을 그 그림자가 담당한다(styles.css 주석).
    //
    // `let mut` 대신 그림자 재바인딩을 쓰는 이유: cfg로 빠지는 플랫폼에서 재대입이 없어져
    // `unused_mut`가 `-D warnings`에 걸린다(tray.rs의 같은 패턴과 동일한 이유).
    #[cfg(target_os = "windows")]
    let builder = builder.shadow(false);
    let window = builder.build()?;
    windows::apply_borderless_corners(&window);
    apply_saved_state(app, &window, id);
    // 트레이 「열린 노트」 최신화(Windows 전용 — 찾은 결함: 그 섹션이 창 열림/닫힘을 더는
    // 반영하지 않던 문제 수정). 창이 실제로 새로 생겼으니(재사용 분기는 여기 오지 않는다)
    // 목록이 바뀐다 — tray.rs의 `notes-list-changed` 리스너(Windows 전용, 그 파일의
    // `EV_NOTES_LIST_CHANGED` 문서 참고)가 이 신호로 시그니처를 다시 계산한다. macOS는 그
    // 리스너 자체가 없어(tray.rs 모듈 문서) 여기서 방송해도 아무 일도 하지 않지만, 프론트
    // 패널의 불필요한 재조회(이 이벤트를 `afterNotesChanged`가 아니라 여기서 직접 냄에도
    // 패널이 구독한다)를 막기 위해 애초에 Windows에서만 낸다. 창 파괴 쪽 짝은
    // `lib.rs::on_note_window_event`(전역 `on_window_event`, `WindowEvent::Destroyed`)가
    // 맡는다 — 창 생성은 이 함수를 통하지만 파괴는 OS/사용자가 직접 트리거하므로 별도 훅이
    // 필요하다.
    #[cfg(target_os = "windows")]
    let _ = app.emit(EV_NOTES_LIST_CHANGED, ());
    if focus {
        let _ = window.set_focus();
        windows::raise_window(&window);
    }
    Ok(())
}

/// 노트 목록·검색 패널 창을 연다(이미 있으면 재사용). 일반(장식 있는) 작은 창.
/// 열 때 포커스+맨 앞으로 올린다(트레이에서 부르면 백그라운드여도 바로 보이도록).
///
/// 재사용 분기에서 `unminimize()`를 먼저 부르는 이유(찾은 결함: 점프 리스트 "노트 목록"이
/// 창이 최소화돼 있으면 무동작하던 문제): `set_focus()`(tao Windows 구현)는 창이 최소화
/// 상태면 `is_minimized`를 보고 완전한 no-op으로 빠진다 — 최소화를 먼저 풀지 않으면 어떤
/// 후속 호출도 창을 화면에 되돌리지 못한다. `unminimize()`는 이미 펼쳐진 창에도 안전하다
/// (idempotent) — `open_note_window_impl`의 재사용 분기와 같은 처방.
pub fn open_panel(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        windows::raise_window(&win);
        return Ok(());
    }
    let url = WebviewUrl::App("index.html?panel=1".into());
    let window = WebviewWindowBuilder::new(app, PANEL_LABEL, url)
        .title(i18n::resolve(app).panel_title)
        .inner_size(320.0, 480.0)
        .build()?;
    let _ = window.set_focus();
    windows::raise_window(&window);
    Ok(())
}

/// 설정·플러그인 매니저 창을 연다(이미 있으면 재사용). 일반(장식 있는) 창.
///
/// 역할: 트레이 "설정"에서 `index.html?settings`를 띄운다. 패널과 같은 구조의 일반 창.
/// 열 때 포커스+맨 앞으로 올린다(트레이에서 부르면 백그라운드여도 바로 보이도록).
///
/// 재사용 분기의 `unminimize()`는 [`open_panel`]과 같은 이유([`open_panel`] 문서 참고) —
/// 점프 리스트 "설정"도 최소화된 창에서는 그전까지 무동작이었다.
pub fn open_settings(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        windows::raise_window(&win);
        return Ok(());
    }
    let url = WebviewUrl::App("index.html?settings=1".into());
    // 좌측 트리(사이드바) + 우측 내용의 2단 레이아웃이라 기본 너비를 넓게 잡는다. 최소 크기는
    // 사이드바(~200) + 내용이 눌리지 않을 만큼 확보한다(그 아래로는 못 줄임).
    let window = WebviewWindowBuilder::new(app, SETTINGS_LABEL, url)
        .title(i18n::resolve(app).settings_title)
        .inner_size(760.0, 620.0)
        .min_inner_size(520.0, 420.0)
        // 템플릿 목록 편집기가 HTML5 dragstart/dragover/drop으로 재정렬을 구현한다 — Tauri
        // 기본값(drag_drop_handler_enabled=true)은 wry가 그 이벤트를 네이티브 레벨에서 먼저
        // 가로채 페이지 DOM에 전달하지 않는다. 이 창은 tauri://drag-drop을 구독하지 않으므로
        // 꺼도 잃는 동작이 없다.
        .disable_drag_drop_handler()
        .build()?;
    let _ = window.set_focus();
    windows::raise_window(&window);
    Ok(())
}

/// 플러그인 중앙 호스트 창을 연다(이미 있으면 재사용). 항상 숨김 — UI가 없는 상주 창.
///
/// 역할: 메뉴바 앱이라 항상 살아있는 UI 창이 없으므로, 플러그인 샌드박스를 1회 실행·소유할
/// 상주 웹뷰를 하나 만든다. 노트 창들은 이 창이 방송하는 디스크립터 스냅샷으로 에디터
/// 확장을 만들고, 런타임 특권 호출만 이벤트로 왕복한다.
/// 왜: 기존에는 노트 창마다 샌드박스를 새로 띄웠다(창 N×플러그인 M) — 실행 주체를 한
/// 창으로 모아 플러그인당 1개로 고정한다(성능 최적화).
pub fn open_plugin_host<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(PLUGIN_HOST_LABEL).is_some() {
        return Ok(());
    }
    let url = WebviewUrl::App("index.html?plugin-host=1".into());
    WebviewWindowBuilder::new(app, PLUGIN_HOST_LABEL, url)
        .title("memo-plugin-host")
        .visible(false)
        .build()?;
    Ok(())
}

/// 플러그인 중앙 호스트 창을 보장한다(없으면 재생성) — 사용 가능하면 true.
///
/// 역할: 노트 창이 스냅샷을 기다리기 전에 호출한다 — 창이 있으면 그대로 true(스냅샷을
/// 기다릴 근거), 사라졌으면(웹뷰 크래시 등) [`open_plugin_host`]의 재사용 가드를 거쳐
/// 재생성해 자동 복구한다. 생성 실패만 false(호출자는 즉시 폴백 — Tauri 밖 테스트 환경
/// 포함). 참고: 호스트가 죽어 있는 동안의 설정 변경 방송(notes-reload)은 유실되지만,
/// 다음 노트 열림이 이 경로로 호스트를 되살리므로 실질적으로 완화된다.
///
/// `(async)`인 이유는 [`open_note_panel`]과 같다 — [`open_plugin_host`]가 호스트 부재 시
/// `WebviewWindowBuilder::build()`를 부르므로, 동기 커맨드면 메인 스레드의 WebView2 IPC
/// 디스패치 컨텍스트에서 build가 돌아 Windows 재진입 데드락 위험이 있다(wry#583).
#[tauri::command(async)]
pub fn ensure_plugin_host<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
    open_plugin_host(&app).is_ok()
}

/// 새 창을 만들 때 쓸 초기 타이틀을 읽는다 — 저장된 본문에서 파생한다. 상태·본문을 읽지
/// 못하면(신규 노트가 아직 파일이 없는 등) 언어별 기본 앱 이름으로 폴백한다.
fn initial_window_title(app: &tauri::AppHandle, id: &str) -> String {
    let strings = i18n::resolve(app);
    app.try_state::<AppState>()
        .and_then(|state| state.lock_vault().read_content(id).ok())
        .map(|content| window_title_for_content(&content, strings))
        .unwrap_or_else(|| strings.app_name.to_string())
}

/// 저장된 메타로 위치/크기 복원 + override(투명도·핀·Space) 적용.
fn apply_saved_state(app: &tauri::AppHandle, window: &WebviewWindow, id: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some((geo, resolved)) = read_note_view(&state, id) else {
        return;
    };

    if geo.width > 0.0 && geo.height > 0.0 {
        let displays = displays_of_with_retry(window);
        if let Some(primary) = displays.first() {
            let (x, y) = restore_position(&geo, &displays, primary);
            let _ = window.set_position(LogicalPosition::new(x, y));
            let _ = window.set_size(LogicalSize::new(geo.width, geo.height));
        } else {
            // 재시도로도 모니터 목록이 비면(부팅 직후 극단적인 경우) 위치 복원 자체를 포기하고,
            // (0,0) 구석에 딱 붙지 않는 안전 좌표에 놓는다 — 크기는 그대로 적용한다.
            let _ = window.set_position(LogicalPosition::new(FALLBACK_X, FALLBACK_Y));
            let _ = window.set_size(LogicalSize::new(geo.width, geo.height));
        }
    }

    let _ = windows::set_window_alpha(window.clone(), resolved.transparency);
    let _ = windows::set_always_on_top(window.clone(), resolved.pinned);
    let _ = windows::set_visible_on_all_spaces(window.clone(), resolved.all_spaces);
    // 접힘으로 저장된 노트는 접힌 높이로 연다(펼침 높이는 prev_height에 보관 — 펼칠 때 복원).
    // 접힘 상태의 최소 높이는 COLLAPSED_H다(세로로 끌어 늘리면 자동으로 펼쳐진다 —
    // [`apply_size_limits`]·[`collapse_from_resize`]).
    if resolved.collapsed {
        apply_size_limits(window, true);
        let w = if geo.width > 0.0 {
            geo.width
        } else {
            DEFAULT_W
        };
        let _ = window.set_size(LogicalSize::new(w, COLLAPSED_H));
    }
}

/// 상태에서 노트의 저장 기하 + 해석된 설정을 읽는다.
///
/// 두 잠금을 **겹쳐 쥐지 않는다**(각 문장이 끝나면 가드가 사라진다) — 잠금 순서 역전으로
/// 교착이 생길 여지를 구조적으로 없앤다.
fn read_note_view(state: &AppState, id: &str) -> Option<(SavedGeometry, ResolvedNoteSettings)> {
    let meta = state.lock_vault().read_meta(id).ok()?;
    let defaults = state.lock_shared().defaults.clone();
    let geo = SavedGeometry {
        display_id: meta.window.display_id.clone(),
        offset_x: meta.window.offset_x,
        offset_y: meta.window.offset_y,
        width: meta.window.width,
        height: meta.window.height,
    };
    Some((geo, resolve_settings(&defaults, &meta.overrides)))
}

/// 새 노트를 만들고 창을 연다(트레이 "새 노트" / 전역 단축키).
///
/// **호출 즉시 반환한다** — 실제 작업(노트 파일 2개 생성 + 창 만들기)은 백그라운드 태스크로
/// 나간다. 왜(이슈 #22): 이 함수의 호출자는 트레이 메뉴 이벤트와 전역 단축키 핸들러, 둘 다
/// **메인 스레드(이벤트 루프)** 위다. 예전에는 여기서 vault 쓰기까지 동기로 해, 새 메모를
/// 하나 만들 때마다 디스크 IO가 끝날 때까지 이벤트 루프가 멎었다(Windows "응답 없음"의
/// 직접 원인 중 하나). 이제 IO는 워커에서 끝내고, 창 생성만 Tauri가 이벤트 루프로 되돌린다
/// (`WebviewWindowBuilder::build()`는 어느 스레드에서 불러도 안전하다 — 메인 스레드에 작업을
/// 넘기고 **호출한 워커가** 기다린다).
///
/// 반환 타입은 그대로 둔다(호출부 계약 유지). 이제 오류는 반환값이 아니라 태스크 안에서
/// 로깅된다 — 어차피 두 호출부 모두 `eprintln!`으로 끝내던 값이다.
///
/// 노트 생성이 성공하면 [`EV_NOTES_LIST_CHANGED`]를 직접 emit한다(그 상수 문서 참고) — 이
/// 경로는 프론트엔드 invoke를 거치지 않아 `tauri.ts`의 `afterNotesChanged`가 감쌀 지점이
/// 없으므로, 패널이 새 노트를 알아채려면 여기서 신호를 내야 한다. 창 열기가 실패해도 노트
/// 자체는 이미 vault에 존재하므로 신호는 그대로 낸다.
///
/// **쓰기 봉인을 존중한다**(찾은 결함 수정 — 이 경로가 봉인을 우회해 "모든 데이터 삭제"·
/// "저장 폴더 이전"이 진행 중에도 노트를 만들 수 있었다): [`AppState::lock_vault`]가 아니라
/// [`AppState::lock_vault_for_write`]를 쓴다. `note_create` 커맨드(commands.rs)가 이미 같은
/// 잠금으로 봉인을 지키는데, 이 함수만 원시 잠금을 써서 그 보장이 새지 않아야 한다. 그
/// 봉인 구간(`wipe_all_data`·`change_vault_path`)은 노트 창만 닫을 뿐 패널은 열려 있으므로
/// (`close_all_note_windows` 참고), 패널의 "+"·"새 메모"(둘 다 이 함수로 이어진다)가 그
/// 사이에도 눌릴 수 있다 — 봉인 중이면 로깅만 하고 노트도 만들지 않고 창도 열지 않는다
/// ([`create_note_respecting_seal`] 참고, 순수 로직을 분리해 가드 테스트한다).
pub fn create_and_open(app: &tauri::AppHandle) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = {
            let Some(state) = app.try_state::<AppState>() else {
                eprintln!("[memo] 새 노트: 앱 상태 없음");
                return;
            };
            match create_note_respecting_seal(&state) {
                Ok(id) => id,
                Err(e) => {
                    eprintln!("[memo] 새 노트 생성 실패: {e}");
                    return;
                }
            }
        };
        let _ = app.emit(EV_NOTES_LIST_CHANGED, ());
        if let Err(e) = open_note_window(&app, &id) {
            eprintln!("[memo] 새 노트 창 열기 실패: {e}");
        }
    });
    Ok(())
}

/// 쓰기 봉인을 확인한 뒤 빈 노트를 만든다 — [`create_and_open`]의 워커 클로저에서 쓰는 순수
/// 로직을 분리해 GUI/스레드 없이 가드 테스트 가능하게 한다(`tray.rs`의 `signature_changed`와
/// 같은 결). 봉인 중이면([`AppState::lock_vault_for_write`]가 거부하면) 그 오류 문자열을
/// 그대로 돌려주고 아무것도 쓰지 않는다.
///
/// `pub(crate)`인 이유: [`create_and_open_sync`]가 이 함수를 그대로 감싼다(문서 참고).
pub(crate) fn create_note_respecting_seal(state: &AppState) -> Result<String, String> {
    let vault = state.lock_vault_for_write()?;
    vault.create_note("").map_err(|e| e.to_string())
}

/// D3 새 노트를 **동기로** 만들고 곧바로 연다 — 성공하면 [`EV_NOTES_LIST_CHANGED`]도 이
/// 함수가 직접 emit한다(그 상수 문서 참고). `create_and_open`(트레이 "새 노트"·전역 단축키)의
/// `spawn_blocking` 비동기 경로와 달리, 실제 생성·창 열기가 **이 함수가 반환하기 전에** 전부
/// 끝난다.
///
/// `lib.rs`의 두 호출부(`run()`의 `setup()` D3, `handle_second_instance`의 D3/D4) **둘 다**
/// 이 동기 버전을 쓴다(리뷰 지적 m6으로 통일) — 이유가 호출부마다 다르다:
/// - `setup()`: 이 함수가 끝나기 **전에** 이어지는 `tray::setup_tray`가 초기 「열린 노트」
///   스냅샷을 찍으므로, 비동기 경로면 그 스냅샷이 방금 만든 창을 놓치는 레이스가 있었다.
/// - `handle_second_instance`: 트레이는 이미 살아 있어 그 레이스는 없지만, 그 대신 **막
///   새로 뜨는 패널**이 문제다 — 패널이 뜨자마자 부르는 초기 `note_list()`가, 비동기 워커가
///   아직 못 끝낸 시점의(방금 만든 노트가 없는) 목록을 스냅샷 떠 버리고, 그 뒤 도착하는
///   `EV_NOTES_LIST_CHANGED`를 리스너 타이밍에 따라 놓칠 수 있다 — vault가 느리면(동기화
///   폴더 등) 패널이 방금 만든 노트 없이 남는다.
///
/// 두 호출부가 이 함수 반환 뒤 **곧바로 패널을 열지 않는 이유**는 호출부 쪽 문서(포커스
/// 순서 — 새 노트를 사용자가 골랐다면 마지막 포커스는 그 창이 가져야 한다) 참고.
pub(crate) fn create_and_open_sync(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.try_state::<AppState>().ok_or("상태 없음")?;
    let id = create_note_respecting_seal(&state)?;
    let _ = app.emit(EV_NOTES_LIST_CHANGED, ());
    open_note_window(app, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 시작 시 보관(hidden)되지 않은 노트들의 창을 연다.
///
/// `setup()`(메인 스레드)에서 불리므로 여기서는 옮기지 않는다 — 부팅 중에는 아직 사용자가
/// 조작할 창이 없어 "응답 없음"으로 보일 대상이 없고, 창 생성 순서를 보장하는 편이 낫다.
///
/// 반환값은 hidden=false 노트를 **하나라도 발견했는지**다(창 생성 자체의 성공 여부와는
/// 무관 — 열거 단계에서 이미 결정되는 값이라 `open_note_window_impl` 실패와 분리해 둔다).
/// `lib.rs::run`의 `setup()`이 이 값으로 D3("활성 노트 0개")을 판정한다: 시작 복원과 서로
/// 다른 관심사(복원은 창을 실제로 여는 부수효과, 이 반환값은 그 뒤 새 노트 생성 여부를
/// 가르는 순수한 판정 근거)라 별도 카운터 대신 여기서 함께 계산해 반환하는 편이
/// "활성 노트가 있었다"는 사실을 다시 조회하지 않고 한 번의 순회로 끝낸다.
///
/// **`opened_at`을 기록하지 않는다** — 시작 복원은 "사람이 지금 골라서 연" 행위가 아니라
/// 한 번에 여러 노트가 동시에 다시 나타나는 것이므로, 여기서 기록하면 전부 같은 시각이 되어
/// 「최근 연 순」이 무의미해진다(`model.rs`의 `NoteMeta::opened_at` 문서 참고 — 기록 지점
/// 목록에 이 함수가 없는 이유).
pub fn open_startup_windows(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let ids = state.lock_vault().list_note_ids().unwrap_or_default();
    let mut opened_any = false;
    for id in ids {
        let hidden = state.lock_vault().read_meta(&id).is_ok_and(|m| m.hidden);
        if !hidden {
            opened_any = true;
            // 시작 복원은 포커스를 뺏지 않는다(자동실행 시 다른 앱을 가로채지 않도록).
            let _ = open_note_window_impl(app, &id, false);
        }
    }
    opened_any
}

/// 현재 창의 논리 좌표 위치/크기를 읽는다.
fn logical_bounds(window: &WebviewWindow) -> Result<(f64, f64, f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok((pos.x, pos.y, size.width, size.height))
}

/// 현재 창 위치/크기를 노트 메타에 저장한다(드래그/리사이즈 후 프론트가 호출).
///
/// **세로 리사이즈로 접힘/펼침이 뒤집히는 유일한 자리**이기도 하다: 창 크기 실측이 백엔드에
/// 도착하는 통로가 여기뿐이라([`crate::commands`]가 아니라 프론트 `onResized` → 디바운스 →
/// 이 커맨드), 판정([`collapse_from_resize`])·창 제약·프론트 통지를 여기서 함께 끝낸다.
///
/// `async`인 이유: 창을 옮기거나 크기를 바꿀 때마다(400ms 디바운스) 사이드카 JSON을 읽고 다시
/// 쓴다 — 창이 여럿이면 그만큼 곱해진다. 동기 커맨드면 그 IO가 전부 메인 스레드에서 일어나
/// **창을 드래그하는 동안** 앱이 버벅인다(이슈 #22).
///
/// 순서가 중요하다: 창 기하 조회(`logical_bounds`·`displays_of`)는 이벤트 루프로 왕복하는
/// **블로킹 getter**다. 그래서 잠금을 잡기 **전에** 모두 끝낸다 — 잠금을 쥔 채 메인 스레드를
/// 기다리면, 메인 스레드가 그 잠금을 기다리는 순간 교착이 된다. 같은 이유로 전이가 요구하는
/// 창 조작(제약·리사이즈)은 잠금을 **놓은 뒤**에 한다.
#[tauri::command(async)]
pub fn save_window_geometry(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    let (x, y, w, h) = logical_bounds(&window)?;
    let captured = capture_geometry(x, y, w, h, &displays_of(&window));

    let state = app.try_state::<AppState>().ok_or("상태 없음")?;
    let (transition, resize_to) = {
        let vault = state.lock_vault();
        let mut meta = vault.read_meta(&id).map_err(|e| e.to_string())?;
        meta.window.display_id = captured.display_id;
        meta.window.offset_x = captured.offset_x;
        meta.window.offset_y = captured.offset_y;
        // 폭은 항상 저장한다(접힘 중에도 좌우 리사이즈가 허용되므로 반영).
        meta.window.width = captured.width;

        let was = meta.overrides.collapsed.unwrap_or(false);
        let transition = collapse_from_resize(was, meta.window.height, captured.height);
        let resize_to = match transition {
            // 접힌 창을 세로로 끌어 늘렸다 → 펼침. **사용자가 만든 높이를 그대로 존중**하고,
            // 펼침 최소보다 낮을 때만 MIN_H로 끌어올린다(보관해 둔 prev_height로 되돌리지
            // 않는다 — 방금 손으로 정한 크기를 무시하는 쪽이 더 놀랍다).
            Some(false) => {
                meta.overrides.collapsed = Some(false);
                let target = captured.height.max(MIN_H);
                // 새 펼침 높이를 **즉시** 메타에 반영한다: 이 값이 다음 판정의 "직전 높이"라,
                // 낡은 값을 남기면 클램프가 만든 높이가 "줄어든 것"으로 읽혀 곧바로 다시
                // 접히는 진동이 된다.
                meta.window.height = target;
                (target > captured.height).then_some(target)
            }
            // 펼친 창을 최소 높이까지 줄였다 → 접힘. 버튼으로 접을 때와 **같은 자리**
            // (prev_height)에 직전 펼침 높이를 보관한다 — 다시 펼치면 바닥(MIN_H)이 아니라
            // 줄이기 전 높이로 돌아온다.
            Some(true) => {
                meta.overrides.collapsed = Some(true);
                meta.window.prev_height = Some(meta.window.height);
                Some(COLLAPSED_H)
            }
            // 상태 변화 없음: 높이는 펼침 때만 저장해 window.height가 "펼침 높이"를 의미하게
            // 한다(접힘 높이는 apply_saved_state가 강제, 펼침 높이는 prev_height로 복원 —
            // 접힘 중 저장이 펼침 높이를 덮지 않게).
            None => {
                if !was {
                    meta.window.height = captured.height;
                }
                None
            }
        };
        meta.updated_at = now_ms();
        vault.write_meta(&id, &meta).map_err(|e| e.to_string())?;
        (transition, resize_to)
    };

    if let Some(collapsed) = transition {
        apply_size_limits(&window, collapsed);
        if let Some(target) = resize_to {
            let _ = window.set_size(LogicalSize::new(captured.width, target));
        }
        // 창을 실제로 맞춘 **뒤에** 알린다 — 프론트가 에디터를 먼저 펼쳐 봐야 아직 헤더
        // 높이인 창에 잠깐 구겨 넣는 그림이 될 뿐이다.
        let _ = app.emit(
            EV_NOTE_COLLAPSED_CHANGED,
            serde_json::json!({ "id": id, "collapsed": collapsed }),
        );
    }
    Ok(())
}

/// 리사이즈 실측 높이로 접힘/펼침을 자동 재판정한다(순수) — 바뀌지 않으면 `None`.
///
/// - 접힘인데 접힘 높이보다 [`RESIZE_SLACK`]을 넘게 커졌다 → 펼침(세로로 끌어 늘렸다).
/// - 펼침인데 **줄어들어** 펼침 최소 높이(MIN_H)에 닿았다 → 접힘(더 줄일 수 없는 바닥이 곧
///   "접어라"라는 뜻이다 — 사용자 요구사항 그대로).
///
/// `saved_h`(직전에 저장된 펼침 높이)를 함께 보는 이유는 **수렴** 때문이다: 전이가 유발한
/// 프로그램적 리사이즈는 다시 `onResized` → [`save_window_geometry`]로 되돌아온다. "줄어들었을
/// 때만" 접는 규칙이면, 이미 MIN_H에 앉아 있는 창에 같은 높이가 다시 들어와도(줄어든 것이
/// 아니므로) 아무 일도 일어나지 않는다. 두 방향의 임계도 겹치지 않는다(펼침 판정은
/// COLLAPSED_H+slack 초과, 접힘 판정은 MIN_H+slack 이하이면서 감소) — 한 번 전이한 상태에
/// 같은 입력을 다시 넣으면 항상 `None`이다(가드 테스트가 이 성질을 고정한다).
fn collapse_from_resize(was: bool, saved_h: f64, new_h: f64) -> Option<bool> {
    if was {
        (new_h > COLLAPSED_H + RESIZE_SLACK).then_some(false)
    } else {
        (new_h <= MIN_H + RESIZE_SLACK && new_h < saved_h - RESIZE_SLACK).then_some(true)
    }
}

/// 접기/펼치기 전이에서 (보관할 prev_height, 리사이즈 목표 높이)를 정한다(순수).
///
/// - 펼침→접힘: 현재 높이를 `prev_height`에 보관하고 접힘 높이로 축소.
/// - 접힘→펼침: 보관값(없으면 기본)으로 복원(`prev_height`는 그대로 둔다).
/// - 상태 변화 없음: 리사이즈도 보관 변경도 없음.
///
/// 왜: "이미 접힘일 때 다시 접기가 접힘 높이를 prev로 덮어써 펼침 높이를 잃는" 실수를 막는
/// 전이 규칙을 순수 함수로 분리해 가드 테스트한다(Tauri 창 리사이즈만 커맨드에 남긴다).
fn collapse_transition(
    was: bool,
    want: bool,
    current_h: f64,
    prev_h: Option<f64>,
) -> (Option<f64>, Option<f64>) {
    if want && !was {
        (Some(current_h), Some(COLLAPSED_H))
    } else if !want && was {
        (prev_h, Some(prev_h.unwrap_or(DEFAULT_H)))
    } else {
        (prev_h, None)
    }
}

/// 노트 헤더 접기(숨김이 아니라 높이만 조절)를 **버튼으로** 설정한다(세로 드래그로 뒤집히는
/// 쪽은 [`save_window_geometry`]가 맡는다 — 두 경로가 같은 메타 필드를 쓴다).
///
/// 접을 때: 현재(펼침) 높이를 `prev_height`에 보관하고 창을 접힘 높이로 축소한다.
/// 펼칠 때: 보관한 높이(없으면 기본)로 복원한다. 접힘 상태(`collapsed`)는 override로
/// 영속화돼 재시작 시에도 접힌 채로 복원된다(`apply_saved_state`가 접힘 높이로 연다).
/// 프론트는 반환값 없이 에디터 표시만 토글한다(창 높이·상태는 여기서 단일 관리).
///
/// `async`인 이유: 사이드카 JSON 읽기·쓰기가 들어간다(다른 노트 커맨드와 같은 정책).
/// 창 조작(크기 제약·리사이즈)은 **잠금을 놓은 뒤** 한다 — 잠금을 쥔 채 창 API를 부르면
/// 메인 스레드를 기다리게 되고, 메인 스레드가 같은 잠금을 기다리면 교착이다.
#[tauri::command(async)]
pub fn set_note_collapsed(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
    collapsed: bool,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);

    let state = app.try_state::<AppState>().ok_or("상태 없음")?;
    let resize_to = {
        let vault = state.lock_vault();
        let mut meta = vault.read_meta(&id).map_err(|e| e.to_string())?;
        let was = meta.overrides.collapsed.unwrap_or(false);

        let (new_prev, resize_to) =
            collapse_transition(was, collapsed, size.height, meta.window.prev_height);
        meta.window.prev_height = new_prev;
        meta.overrides.collapsed = Some(collapsed);
        // 펼치며 복원한 높이는 곧 새 "펼침 높이"다 — 메타에 즉시 반영해야 이어지는
        // `save_window_geometry`가 그 높이를 "줄어든 것"으로 읽어 도로 접지 않는다
        // ([`collapse_from_resize`]가 직전 높이로 이 값을 본다).
        if !collapsed {
            if let Some(h) = resize_to {
                meta.window.height = h;
            }
        }
        meta.updated_at = now_ms();
        vault.write_meta(&id, &meta).map_err(|e| e.to_string())?;
        resize_to
    };

    // 크기 제약을 리사이즈보다 먼저 적용한다(접힘=최소 COLLAPSED_H, 펼침=최소 MIN_H). 그래야
    // 이어지는 set_size가 제약 안에서 동작한다(접힘 높이로 줄이려면 최소 높이가 먼저 내려가
    // 있어야 한다).
    apply_size_limits(&window, collapsed);
    if let Some(h) = resize_to {
        let _ = window.set_size(LogicalSize::new(size.width, h));
    }
    Ok(())
}

/// 화면 밖으로 나간 모든 노트 창을 주 디스플레이 안으로 모은다.
#[tauri::command]
pub fn gather_windows(app: tauri::AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if !label.starts_with("note-") {
            continue; // 패널 등 비-노트 창은 모으기 대상이 아니다.
        }
        let displays = displays_of(&window);
        let Some(primary) = displays.first().cloned() else {
            continue;
        };
        let (x, y, w, h) = logical_bounds(&window)?;
        if let Some((nx, ny)) = gather_into_view(x, y, w, h, &displays, &primary) {
            let _ = window.set_position(LogicalPosition::new(nx, ny));
        }
    }
    Ok(())
}

/// 노트를 소환한다(창이 있으면 포커스, 없으면 연다) — 패널 클릭에서 호출.
///
/// 보관(hidden)된 노트를 소환하면 보관을 해제한다(목록·시작 복원에 다시 포함되도록).
///
/// `async`인 이유: 보관 해제(사이드카 쓰기)와 창 복원(본문 읽기 → 타이틀, 메타 읽기 → 위치)에
/// 파일 IO가 여럿 붙는다. 창 생성 자체(`build()`)는 어느 스레드에서 불러도 안전하며 내부적으로
/// 메인 스레드에 넘겨져 처리된다 — 워커에서 부르면 **그 IO만큼** 이벤트 루프가 자유로워진다.
///
/// 보관 해제 쓰기는 `state.lock_vault()`가 아니라 [`AppState::lock_vault_for_write`]를 쓴다 —
/// 트레이 "열린 노트" 메뉴는 `tray.rs`의 메뉴 라우터가 `spawn_blocking`으로 직접 호출하므로,
/// `commands::wipe_all_data`의 쓰기 봉인 구간과 동시에 실행될 수 있다. 보통 잠금이면 그
/// 구간에도 메타를 쓸 수 있어, 방금 지운 노트의 `.json` 사이드카를 되살릴 수 있다(그 함수
/// 문서의 「지운 것이 되살아나지 않게 하는 순서」와 같은 위험). 봉인 중이면 쓰기를 건너뛰고
/// 조용히 이어간다 — 창 열기는 계속 진행하되(사용자 클릭에 반응은 해야 한다) 이후 그 창의
/// `note_read`가 파일을 못 찾으면 프론트가 처리한다. **남는 한계**: 여기서 막는 것은 이 메타
/// 쓰기 하나뿐이다 — 이어지는 [`open_note_window`]가 여는 창에서 사용자가 다시 타이핑하면,
/// 그 저장(`note_save_content`)은 봉인이 풀린 뒤(이 커맨드가 끝난 뒤)에 도착할 수 있고 그
/// 시점엔 봉인이 없어 그대로 쓰여 노트를 되살릴 수 있다 — 이는 `wipe_all_data` 문서가 이미
/// 인정하는 일반적인 틈(창이 제때 닫히지 않는 경우)과 같은 종류라 여기서 추가로 막지 않는다.
///
/// **D10(`NoteMeta::opened_at`) 기록 지점**: [`mark_opened`]가 이 함수가 하는 메타 갱신의
/// 전부다 — 트레이 「열린 노트」 서브메뉴 클릭도 (프론트 invoke를 거치지 않고) 이 함수를
/// 직접 부르므로(`tray.rs::on_tray_menu_event`), 패널 항목 클릭과 트레이 클릭 두 「사람이
/// 고른 열기」 진입점이 자동으로 같은 기록을 공유한다. 점프 리스트(Windows)는 특정 노트를
/// 여는 동작이 아예 없어(새 노트·패널·설정 셋뿐, `jumplist::LaunchAction`) 별도 기록 지점이
/// 필요 없다.
#[tauri::command(async)]
pub fn summon_note(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(vault) = state.lock_vault_for_write() {
            mark_opened(&vault, &id);
        }
    }
    open_note_window(&app, &id).map_err(|e| e.to_string())
}

/// [`summon_note`]의 메타 갱신 알맹이 — 보관 해제 + `opened_at` 기록(D10). `AppHandle`·창
/// 없이 부를 수 있게 떼어 둔 이유는 테스트다: `summon_note` 자체는 실제 창 생성이 필요해
/// GUI 없는 유닛 테스트로 재현할 수 없지만, 메타 조작만은 `Vault` 목으로 검증 가능하다
/// (`create_note_respecting_seal`과 같은 결의 분리).
///
/// **매번** `opened_at`을 지금 시각으로 갱신한다 — hidden이 이미 false라도(이미 보이는 노트를
/// 다시 클릭해 앞으로 올리는 경우 포함) 기록한다. hidden 해제에만 쓰기를 걸었던 예전 방식은
/// 이미 열려 있는 노트를 소환해도 「최근 연 순」이 갱신되지 않는 결함이 있었다.
fn mark_opened(vault: &Vault, id: &str) {
    if let Ok(mut meta) = vault.read_meta(id) {
        meta.hidden = false;
        meta.opened_at = Some(now_ms());
        let _ = vault.write_meta(id, &meta);
    }
}

/// 노트 목록·검색 패널을 연다(트레이/단축키/프론트에서).
///
/// `(async)`인 이유(Windows 프리즈 수정): Tauri v2에서 **동기 커맨드는 메인 스레드의 WebView2
/// IPC 디스패치 컨텍스트에서 실행된다**. 그 안에서 [`open_panel`]이 패널 부재 시 부르는
/// `WebviewWindowBuilder::build()`는 Windows에서 WebView2 컨트롤러 생성이 **재진입 데드락**을
/// 일으킨다(wry#583, docs.rs `WebviewWindowBuilder` Known issues). `(async)`로 두면 커맨드가
/// 워커 스레드에서 돌아 build가 메인 스레드로 프록시되므로 재진입이 없다 — [`summon_note`]와
/// 같은 처방. 시그니처·반환형은 그대로 둔다(프론트 Promise/.catch 계약 유지).
#[tauri::command(async)]
pub fn open_note_panel(app: tauri::AppHandle) -> Result<(), String> {
    open_panel(&app).map_err(|e| e.to_string())
}

/// 모든 노트 창의 표시/숨김을 일괄 전환한다(트레이 "모두 보기/숨기기").
///
/// "모두 보기"는 표시에 더해 각 노트를 다른 앱 위로 올린다(사용자 요청: 트레이에서
/// 부르면 메모들이 맨 위로).
#[tauri::command]
pub fn set_all_notes_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if !label.starts_with("note-") {
            continue;
        }
        if visible {
            let _ = window.show();
            windows::raise_window(&window);
        } else {
            let _ = window.hide();
        }
    }
    Ok(())
}

/// 모든 노트 창을 닫는다("모든 데이터 삭제"(이슈 #20) 후 정리용).
///
/// 왜 숨기지 않고 닫는가: `set_all_notes_visible(false)`(트레이 "모두 숨기기")와 달리, 이
/// 창들이 보여주던 파일은 방금 디스크에서 지워졌다 — 열어 둔 채로 두면 그 에디터의 다음
/// 자동저장([`crate::commands::note_save_content`])이 지워진 노트를 그대로 되살린다. 패널·
/// 설정 등 다른 창은 건드리지 않는다 — 그 창들은 각자 다음 IPC 호출에서 빈 상태를 받아
/// 스스로 다시 그린다(프론트가 `wipe_all_data` 성공 뒤 방송하는 새로고침 신호로 트리거).
pub fn close_all_note_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if is_note_window_label(&label) {
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 노트 창 타이틀 파생 규칙 — 빈 노트는 언어별 앱 이름, 그 외는 derive_title 결과를
    /// TITLE_MAX_CHARS로 자른다(멀티바이트 문자를 깨지 않도록 char 단위).
    #[test]
    fn window_title_for_content_rules() {
        let ko = i18n::strings(Some("ko"));
        assert_eq!(window_title_for_content("", ko), "노트랑");
        assert_eq!(window_title_for_content("   \n\t", ko), "노트랑");
        assert_eq!(window_title_for_content("# 제목\n본문", ko), "제목");
        // 40자를 넘는 제목은 40자로 잘린다(바이트가 아니라 글자 수 기준).
        let long = "가".repeat(50);
        let title = window_title_for_content(&long, ko);
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(title, "가".repeat(TITLE_MAX_CHARS));
    }

    /// 가드: 빈 노트의 기본 타이틀이 언어를 따른다 — 한국어 "노트랑", 영어 "Note Rang"
    /// (tauri.conf.json의 productName과 맞춘 표기, 이슈 #29).
    #[test]
    fn window_title_for_content_follows_language() {
        let en = i18n::strings(Some("en"));
        assert_eq!(window_title_for_content("", en), "Note Rang");
        assert_eq!(window_title_for_content("내용 있음", en), "내용 있음");
    }

    /// 가드: 접기 전이 규칙 — 펼침→접힘은 현재 높이 보관+접힘 높이, 접힘→펼침은 보관값
    /// 복원, 이미 접힘일 때 재접기는 prev_height를 덮어쓰지 않는다(펼침 높이 유실 방지).
    #[test]
    fn collapse_transition_rules() {
        // 펼침→접힘: 현재(260) 보관, 접힘 높이로 축소.
        assert_eq!(
            collapse_transition(false, true, 260.0, None),
            (Some(260.0), Some(COLLAPSED_H))
        );
        // 접힘→펼침: 보관값(260)으로 복원, prev 유지.
        assert_eq!(
            collapse_transition(true, false, COLLAPSED_H, Some(260.0)),
            (Some(260.0), Some(260.0))
        );
        // 접힘→펼침, 보관값 없음: 기본 높이로 복원.
        assert_eq!(
            collapse_transition(true, false, COLLAPSED_H, None),
            (None, Some(DEFAULT_H))
        );
        // 이미 접힘인데 또 접기: prev를 접힘 높이로 덮어쓰지 않고 리사이즈도 없음.
        assert_eq!(
            collapse_transition(true, true, COLLAPSED_H, Some(260.0)),
            (Some(260.0), None)
        );
        // 이미 펼침인데 또 펼치기: 변화 없음.
        assert_eq!(collapse_transition(false, false, 260.0, None), (None, None));
    }

    /// 가드: 세로 리사이즈 자동 재판정 — 접힌 창을 끌어 늘리면 펼침, 펼친 창을 최소 높이까지
    /// **줄이면** 접힘, 그 밖에는 변화 없음(사용자 요구사항 그대로).
    #[test]
    fn collapse_from_resize_rules() {
        // 접힘: 헤더 높이 그대로면 변화 없음(프로그램적 축소가 되돌아온 경우).
        assert_eq!(collapse_from_resize(true, 260.0, COLLAPSED_H), None);
        // 접힘: 슬랙 안의 흔들림(DPI 반올림)은 드래그로 보지 않는다.
        assert_eq!(
            collapse_from_resize(true, 260.0, COLLAPSED_H + RESIZE_SLACK),
            None
        );
        // 접힘: 눈에 띄게 늘렸다 → 펼침(펼침 최소보다 낮게 늘려도 마찬가지 — 클램프는 호출부).
        assert_eq!(collapse_from_resize(true, 260.0, 60.0), Some(false));
        assert_eq!(collapse_from_resize(true, 260.0, 300.0), Some(false));
        // 펼침: 최소 높이까지 줄였다 → 접힘.
        assert_eq!(collapse_from_resize(false, 260.0, MIN_H), Some(true));
        // 펼침: 여유 있게 줄인 것뿐이면 그대로 펼침.
        assert_eq!(collapse_from_resize(false, 260.0, 180.0), None);
        // 펼침: 최소 높이 근처라도 **늘어난** 리사이즈는 접지 않는다(바닥에서 다시 키우는 중).
        assert_eq!(collapse_from_resize(false, MIN_H, MIN_H + 1.0), None);
    }

    /// 가드: 자동 재판정의 **수렴성** — 전이가 만든 창 높이가 리사이즈 이벤트로 되돌아와도
    /// 다시 전이하지 않는다(되먹임 진동 방지, [`save_window_geometry`]가 의존하는 성질).
    #[test]
    fn collapse_from_resize_converges() {
        // 접힘→펼침(끌어 늘림): 호출부가 MIN_H로 클램프하고 그 값을 saved_h에 반영한다 →
        // 그 리사이즈가 되돌아와도(높이=클램프값, 직전 높이도 같은 값) 무전이.
        assert_eq!(collapse_from_resize(true, 260.0, 60.0), Some(false));
        assert_eq!(collapse_from_resize(false, MIN_H, MIN_H), None);
        // 클램프가 필요 없던 경우도 같다(끈 높이 그대로가 새 펼침 높이).
        assert_eq!(collapse_from_resize(false, 300.0, 300.0), None);
        // 펼침→접힘(바닥까지 줄임): 이어지는 축소(COLLAPSED_H)가 되돌아와도 무전이.
        assert_eq!(collapse_from_resize(false, 260.0, MIN_H), Some(true));
        assert_eq!(collapse_from_resize(true, 260.0, COLLAPSED_H), None);
    }

    /// 가드: 재시도 로직 — 빈 결과가 계속되면 `max_attempts`회까지 부르고 그래도 비면 빈
    /// 벡터, 중간에 값이 나오면 그 시점에서 멈추고 그 값을 돌려준다(초과 호출 없음).
    #[test]
    fn retry_until_non_empty_stops_at_first_non_empty() {
        let mut calls = 0;
        let result = retry_until_non_empty(5, Duration::from_millis(0), || {
            calls += 1;
            if calls < 3 {
                Vec::<i32>::new()
            } else {
                vec![1, 2]
            }
        });
        assert_eq!(result, vec![1, 2]);
        assert_eq!(
            calls, 3,
            "세 번째 호출에서 값이 나왔으면 더 부르지 않아야 한다"
        );
    }

    /// 가드: 재시도 로직 — `max_attempts`회 모두 비어 있으면 그만큼만 부르고 빈 벡터를
    /// 돌려준다(무한 재시도가 아니다).
    #[test]
    fn retry_until_non_empty_gives_up_after_max_attempts() {
        let mut calls = 0;
        let result = retry_until_non_empty(5, Duration::from_millis(0), || {
            calls += 1;
            Vec::<i32>::new()
        });
        assert_eq!(result, Vec::<i32>::new());
        assert_eq!(calls, 5);
    }

    /// 가드(이슈 #20 — 모든 데이터 삭제): "note-"로 시작하는 라벨의 창만 닫히고, 그 외
    /// (패널·설정 등) 창은 그대로 남는다.
    #[test]
    fn close_all_note_windows_closes_only_note_prefixed() {
        assert!(is_note_window_label("note-a"));
        assert!(is_note_window_label("note-b"));
        assert!(!is_note_window_label(PANEL_LABEL));
    }

    /// 가드: 노트 창이 하나도 없어도(패널·설정만 있거나 창이 아예 없어도) 오류 없이 끝난다.
    #[test]
    fn close_all_note_windows_noop_when_none_open() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        close_all_note_windows(&handle); // 창이 하나도 없음
        WebviewWindowBuilder::new(&handle, PANEL_LABEL, WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        close_all_note_windows(&handle); // 노트 창 없이 패널만 있음
        assert_eq!(handle.webview_windows().len(), 1);
    }

    /// 가드(삭제 뒤 창 정리): 지워질 노트의 창이 열려 있지 않으면 알릴 것도 없어 즉시
    /// true(부작용 없음).
    #[test]
    fn notify_and_close_note_window_true_when_not_open() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        assert!(notify_and_close_note_window(&handle, "no-such-id"));
    }

    /// 가드: 창이 (프론트가 그러듯) 이벤트를 받고 스스로 곧 닫으면, 강제 닫기 없이 true를
    /// 돌려주고 실제로 창이 사라진 뒤에야 반환한다(폴링이 지연을 견딘다).
    #[test]
    fn notify_and_close_note_window_settles_when_window_closes_itself() {
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closer = std::sync::Arc::clone(&closed);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            closer.store(true, std::sync::atomic::Ordering::Release);
        });

        let settled = wait_until_window_closed(Instant::now() + Duration::from_millis(200), || {
            !closed.load(std::sync::atomic::Ordering::Acquire)
        });
        assert!(settled, "스스로 닫았으면 강제 닫기 없이 true여야 한다");
    }

    /// 가드: 제한 시간 안에 스스로 닫지 못하면(얼어붙었거나 이벤트를 놓쳤거나) 강제로 닫고
    /// false를 돌려준다 — 창이 영원히 남아 있지는 않는다(원 버그 리포트: "삭제해도 창이
    /// 계속 살아있다").
    #[test]
    fn notify_and_close_note_window_force_closes_after_timeout() {
        let settled = wait_until_window_closed(Instant::now(), || true);
        assert!(!settled, "제한 시간을 넘기면 강제로 닫혔음을 보고해야 한다");
    }

    /// 가드: 호스트 자동 복구 경로 — 창이 없으면 만들어 true, 이미 있으면 재생성 없이
    /// 재사용한다(창 개수 불변). 노트가 열릴 때마다 호출돼도 호스트 창이 늘지 않는다.
    #[test]
    fn ensure_plugin_host_creates_once_then_reuses() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        assert!(handle.get_webview_window(PLUGIN_HOST_LABEL).is_none());

        assert!(ensure_plugin_host(handle.clone())); // 없으면 생성해 복구
        assert!(handle.get_webview_window(PLUGIN_HOST_LABEL).is_some());
        let count = handle.webview_windows().len();

        assert!(ensure_plugin_host(handle.clone())); // 있으면 그대로 재사용
        assert_eq!(handle.webview_windows().len(), count); // 재생성 없음
    }

    /// 상태 조립 헬퍼 — tray.rs의 같은 이름 헬퍼와 같은 목적(tempdir 하나로 AppState를 만든다).
    fn state_for(dir: &std::path::Path) -> AppState {
        use crate::model::SharedSettings;
        use crate::settings::LocalConfig;
        AppState::new(
            Vault::new(dir),
            SharedSettings::default(),
            LocalConfig::with_defaults(dir),
        )
    }

    /// 가드(찾은 결함 수정): `note_create_and_open`이 쓰기 봉인을 우회해 "모든 데이터 삭제"·
    /// "저장 폴더 이전" 구간에도 노트를 만들 수 있던 문제 — 봉인 중에는 노트를 만들지 않고
    /// 오류를 돌려주며, 봉인이 풀리면 다시 정상 동작한다(`note_create` 커맨드가 이미 지키는
    /// 것과 같은 보장을 `create_and_open` 경로에도 준다).
    #[test]
    fn create_note_respecting_seal_denied_while_sealed_then_allowed_after_drop() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_for(dir.path());

        assert!(create_note_respecting_seal(&state).is_ok());

        let seal = state.seal_note_writes();
        let denied = create_note_respecting_seal(&state)
            .expect_err("봉인 중엔 새 노트 생성이 거부돼야 한다");
        assert!(denied.starts_with("VAULT_BUSY"), "오류 코드: {denied}");
        // 거부됐으므로 노트가 하나도 더 생기지 않았어야 한다(위에서 만든 1개뿐).
        assert_eq!(state.lock_vault().list_note_ids().unwrap().len(), 1);

        drop(seal);
        assert!(create_note_respecting_seal(&state).is_ok());
        assert_eq!(state.lock_vault().list_note_ids().unwrap().len(), 2);
    }

    /// 가드(D10): [`mark_opened`]가 hidden을 해제하고 `opened_at`을 갱신한다 — hidden이 이미
    /// false인 노트를 다시 소환해도(이미 열려 있는 노트 재클릭) 매번 갱신되는지까지 확인한다
    /// (예전엔 hidden 해제가 필요할 때만 메타를 써 이 경우 「최근 연 순」이 굳어 있었다).
    ///
    /// **동어반복을 피하는 법(리뷰 지적 M2)**: 두 번째 호출 전에 `opened_at`을 명백한 과거
    /// 센티넬로 되감아 둔다. 첫 호출 값과 비교(`>= first_opened_at`)만 하면 두 번째
    /// `mark_opened`가 **아무 것도 안 써도** `T1 >= T1`이라 항상 통과해 버려, `mark_opened`를
    /// 예전 형태(`if meta.hidden { … }`)로 되돌리는 회귀를 이 테스트가 못 잡는다 — 센티넬
    /// 대비 비교라야 "실제로 다시 썼는지"를 결정적으로 관측한다.
    #[test]
    fn mark_opened_unhides_and_stamps_opened_at() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_for(dir.path());
        let vault = state.lock_vault();
        let id = vault.create_note("").unwrap();

        // 보관(hidden) 상태에서 소환 — 해제되고 기록된다.
        let mut meta = vault.read_meta(&id).unwrap();
        meta.hidden = true;
        meta.opened_at = None;
        vault.write_meta(&id, &meta).unwrap();

        mark_opened(&vault, &id);
        let after_first = vault.read_meta(&id).unwrap();
        assert!(!after_first.hidden);
        assert!(after_first.opened_at.is_some(), "소환했으니 기록돼야 한다");

        // 이미 보이는(hidden=false) 노트를 다시 소환해도 opened_at이 다시 갱신되는지 확인한다.
        // 명백한 과거 센티넬로 되감아 둔 뒤, 두 번째 호출이 그 센티넬보다 뒤로 실제로
        // 밀어내는지를 본다.
        let sentinel = 1_000;
        let mut meta = vault.read_meta(&id).unwrap();
        meta.opened_at = Some(sentinel);
        vault.write_meta(&id, &meta).unwrap();

        mark_opened(&vault, &id);
        let after_second = vault.read_meta(&id).unwrap();
        assert!(!after_second.hidden);
        assert!(
            after_second.opened_at.unwrap() > sentinel,
            "이미 열려 있는 노트를 다시 소환해도 opened_at이 갱신돼야 한다"
        );
    }

    /// 가드(찾은 결함 없음 확인용 회귀): 존재하지 않는 노트 id로 불러도 패닉하지 않는다
    /// (읽기 실패 시 `mark_opened`가 조용히 아무 일도 하지 않아야 한다).
    #[test]
    fn mark_opened_missing_note_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_for(dir.path());
        let vault = state.lock_vault();
        mark_opened(&vault, "no-such-id"); // 패닉하지 않으면 통과.
    }

    // `open_note_window`/`open_note_window_impl`/`open_panel`/`open_settings`는 (다른 여러
    // 헬퍼와 달리) 의도적으로 구체 런타임(`tauri::AppHandle` = 기본 Wry)을 받는다 — 그래서
    // `tauri::test::mock_app()`(`MockRuntime`)으로는 타입이 맞지 않아 직접 호출할 수 없다
    // (이 파일에서 그런 함수들에 `<R: tauri::Runtime>`을 붙인 것만 mock으로 테스트 가능한
    // 이유이기도 하다 — `close_all_note_windows`·`notify_and_close_note_window` 등 참고).
    // 그래서 이 세 함수(`open_note_window_impl`의 창 생성 시 `EV_NOTES_LIST_CHANGED` emit,
    // `open_panel`/`open_settings`의 재사용 분기 `unminimize()`)는 코드 리뷰로 정확성을
    // 확인했다 — 실제 창 생성 없이 검증 가능한 부분(봉인 확인 로직)은
    // `create_note_respecting_seal_denied_while_sealed_then_allowed_after_drop`가,
    // 트레이 쪽 반응(시그니처 캐시·디바운스)은 tray.rs의 순수 함수 가드가 커버한다.
    // `open_startup_windows`도 같은 사정(실제 창 생성)이라 새로 생긴 `bool` 반환값(hidden=false
    // 발견 여부)만 코드 리뷰로 확인했다 — 그 판정 자체는 이 파일의 다른 곳에서 이미 검증된
    // `read_meta`/`hidden` 읽기 경로를 그대로 재사용해 새 분기 로직이 없다. D10 기록은
    // `mark_opened_unhides_and_stamps_opened_at`/`mark_opened_missing_note_is_noop`가 커버한다.
    // `create_and_open_sync`도 같은 이유로 직접 테스트하지 않는다 — 안의 `create_note_
    // respecting_seal`(봉인 확인)은 위 테스트가, 조합 판정(D1~D4, "언제 이 함수를 부르는가")은
    // `lib.rs::tests::startup_plan_truth_table`이 각각 커버해, 이 함수 자체는 그 둘을
    // 이어 붙이는 얇은 조립(호출 순서: 생성 → emit → 창 열기)만 남는다.
}
