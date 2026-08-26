//! 네이티브 창 제어 (macOS / Windows).
//!
//! 역할: 플로팅 스티키 노트에 필요한 OS 창 수준 제어를 모아 둔다 — macOS는 NSWindow의 창
//! 전체 알파(투명도)·항상 위·모든 Space 표시, Windows는 borderless 창의 모서리 처리
//! ([`apply_borderless_corners`]).
//! 왜: 이 동작들은 Tauri 표준 API만으로 부족해 objc2/DWM으로 네이티브 핸들을 직접 다뤄야
//! 한다. OS별 코드는 전부 `cfg`로 갈라 **다른 OS의 동작을 건드리지 않는다**.

use tauri::{Runtime, WebviewWindow};

/// 투명도 하한(%) — 노트가 완전히 비쳐 못 읽게 되는 사고를 방지한다.
const MIN_ALPHA_PERCENT: u8 = 30;

/// 0~100 백분율을 NSWindow alphaValue(0.30~1.0)로 클램프 변환한다.
///
/// 역할: UI 백분율을 안전 범위 알파로 고정한다.
/// 왜: 30% 미만이면 가독성이 깨지므로 하한을 강제한다.
fn alpha_from_percent(percent: u8) -> f64 {
    let clamped = percent.clamp(MIN_ALPHA_PERCENT, 100);
    f64::from(clamped) / 100.0
}

/// 창 전체 알파(투명도)를 설정한다. `percent`는 0~100(내부적으로 30~100 클램프).
///
/// 역할: 노트별 투명도 조절의 백엔드. 왜: 창 전체 알파는 NSWindow.setAlphaValue:로만
/// 가능해 objc2로 메인 스레드에서 호출한다.
#[tauri::command]
pub fn set_window_alpha<R: Runtime>(window: WebviewWindow<R>, percent: u8) -> Result<(), String> {
    let alpha = alpha_from_percent(percent);
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    let obj = ptr.cast::<objc2::runtime::AnyObject>();
                    // SAFETY: ptr는 살아있는 NSWindow이고 메인 스레드에서 호출된다.
                    unsafe {
                        let _: () = objc2::msg_send![&*obj, setAlphaValue: alpha];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    // macOS 밖에서는 아무것도 하지 않는다(NSWindow 전용). 인자를 소비해 미사용 경고만 막는다 —
    // CI가 Windows에서도 `-D warnings`로 돌기 때문에 경고 하나가 곧 빌드 실패다.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, alpha);
    }
    Ok(())
}

/// 창을 항상 위에 표시할지 설정한다.
///
/// 역할: 노트별 "핀" 동작. 왜: Tauri 표준 API로 충분해 그대로 사용한다.
#[tauri::command]
pub fn set_always_on_top<R: Runtime>(window: WebviewWindow<R>, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// 창을 모든 Space(가상 데스크탑)에 표시할지 설정한다.
///
/// 역할: 노트별 "모든 Space 표시" 동작. 왜: NSWindow collectionBehavior로만 가능해
/// objc2로 메인 스레드에서 설정한다.
#[tauri::command]
pub fn set_visible_on_all_spaces<R: Runtime>(
    window: WebviewWindow<R>,
    on: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    let obj = ptr.cast::<objc2::runtime::AnyObject>();
                    // NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0, Default = 0.
                    let behavior: usize = usize::from(on);
                    // SAFETY: ptr는 살아있는 NSWindow이고 메인 스레드에서 호출된다.
                    unsafe {
                        let _: () = objc2::msg_send![&*obj, setCollectionBehavior: behavior];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    // macOS 밖에서는 아무것도 하지 않는다(NSWindow collectionBehavior 전용) — 위와 같은 처리.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, on);
    }
    Ok(())
}

/// 창을 다른 앱 위로 올리고 앱을 전면화한다.
///
/// 역할: 새 노트 생성·패널 소환·"모두 보기"에서 노트 창이 확실히 맨 앞으로 오게 한다.
/// 왜: borderless 창은 생성·`show()`나 `set_focus()`만으로는 백그라운드 앱 위로 확실히
/// 오지 않는다. `NSWindow.orderFrontRegardless`로 z-order 최상단에 올리고,
/// `NSApplication`을 활성화해 다른 앱이 전면일 때도 노트가 가려지지 않게 한다
/// (사용자 요청: 새 노트/트레이 상호작용 시 메모가 맨 위로).
pub fn raise_window<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ptr) = win.ns_window() {
                let obj = ptr.cast::<objc2::runtime::AnyObject>();
                // SAFETY: ptr는 살아있는 NSWindow이고 메인 스레드에서 호출된다.
                unsafe {
                    let _: () = objc2::msg_send![&*obj, orderFrontRegardless];
                }
            }
            // 창만 올려선 앱이 백그라운드일 때 다른 앱 위로 못 온다 → 앱 자체를 활성화.
            // SAFETY: 메인 스레드에서 AppKit 공유 인스턴스에 접근한다. sharedApplication은
            // 비-null NSApplication을 돌려준다(방어적으로 null 확인).
            unsafe {
                let ns_app: *mut objc2::runtime::AnyObject =
                    objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
                if !ns_app.is_null() {
                    let _: () = objc2::msg_send![ns_app, activateIgnoringOtherApps: true];
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
}

/// borderless 노트 창의 모서리 처리를 OS에 명시적으로 지시한다(Windows 전용, 그 외 no-op).
///
/// **왜(베타 피드백 "윈도우에서 꼭지점 부분에 뭔가 보인다")**: Windows 11의 DWM은 기본값
/// (`DWMWA_WINDOW_CORNER_PREFERENCE` = `DWMWCP_DEFAULT`)에서 최상위 창의 모서리를 **자기
/// 반경(약 8px)으로** 둥글게 깎는다. 노트 창의 실제 모양은 `styles.css`의 `#app`이 그리는
/// `border-radius: 10px` 카드이므로, 반경이 다른 둥근 모서리가 한 창에 두 겹 생긴다. 창을
/// 투명하게 만든 이상 그 두 곡선 사이의 초승달 영역이 그대로 노출된다 — 사용자가 본
/// "꼭지점의 뭔가"의 절반이다(나머지 절반인 네이티브 그림자는 `window_manager`가 `shadow
/// (false)`로 끈다. 그 호출부 주석 참고).
///
/// 그래서 **모서리 모양의 단일 출처를 CSS로 못 박는다**: OS에는 "아무것도 깎지 말라"
/// (`DWMWCP_DONOTROUND`)고 선언하고, 둥근 모서리는 웹뷰가 혼자 그린다. 그림자를 끈 창에는
/// DWM이 그릴 프레임(테두리·그림자)이 남아 있지 않으므로 이 선언으로 잃는 시각 요소가 없다
/// — 실측으로 확인했다: 그림자가 **켜진** 창에 `DONOTROUND`만 걸면 그림자 실루엣이 직각이
/// 되어 오히려 꼭지점의 사각 얼룩이 도드라진다. 두 처방은 **반드시 짝으로** 간다.
///
/// 실패는 무시한다(`let _`) — 모서리는 순전히 장식이라, 이 호출이 실패해도 노트는 CSS 모양
/// 그대로 정상 동작한다. Windows 10(빌드 22000 미만)에서는 이 속성 자체가 없어
/// `DwmSetWindowAttribute`가 `E_INVALIDARG`를 돌려주는데, 그 OS에는 애초에 DWM 라운딩이
/// 없으므로 무시가 곧 정답이다.
///
/// 메인 스레드에서 실행하는 이유: 창 핸들 조회(`hwnd()`)와 DWM 속성 변경을 창을 소유한
/// 이벤트 루프 스레드로 모아, 워커에서 창을 여는 경로([`crate::window_manager::create_and_open`])
/// 와 메인 스레드에서 여는 경로(시작 복원)가 같은 순서를 타게 한다.
pub fn apply_borderless_corners<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
            DWM_WINDOW_CORNER_PREFERENCE,
        };
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(hwnd) = win.hwnd() else {
                return;
            };
            let pref = DWMWCP_DONOTROUND;
            // SAFETY: hwnd는 살아있는 창의 핸들이고, 넘기는 버퍼는 이 속성이 요구하는 타입
            // (DWM_WINDOW_CORNER_PREFERENCE)과 크기가 정확히 일치한다.
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    std::ptr::addr_of!(pref).cast(),
                    std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                );
            }
        });
    }
    // Windows 밖에서는 아무것도 하지 않는다(DWM 전용). 인자를 소비해 미사용 경고만 막는다 —
    // CI가 macOS에서도 `-D warnings`로 돌기 때문에 경고 하나가 곧 빌드 실패다.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 백분율이 0.30~1.0 알파로 정확히 변환된다(정상 범위).
    #[test]
    fn alpha_maps_percent_in_range() {
        assert_eq!(alpha_from_percent(100), 1.0);
        assert_eq!(alpha_from_percent(50), 0.5);
        assert_eq!(alpha_from_percent(30), 0.30);
    }

    /// 가드: 30% 미만은 하한 0.30으로 클램프되어 노트가 사라지지 않는다.
    #[test]
    fn alpha_clamps_below_minimum() {
        assert_eq!(alpha_from_percent(0), 0.30);
        assert_eq!(alpha_from_percent(10), 0.30);
        assert_eq!(alpha_from_percent(29), 0.30);
    }
}
