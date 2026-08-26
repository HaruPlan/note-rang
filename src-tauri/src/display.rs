//! 디스플레이 인식 창 위치 저장/복원 (확정안: C안 + 폴백).
//!
//! 역할: 창의 절대 위치를 "어느 디스플레이의 frame 기준 오프셋"으로 저장하고,
//! 복원 시 같은 디스플레이 구성이면 정확히, 아니면 주 디스플레이 가시 영역 안으로
//! 폴백(클램프)한다. 모니터 hot-plug/해상도 변경 후에도 노트가 화면 밖으로 사라지지
//! 않게 한다.
//! 왜: 이 좌표 변환·클램프 로직이 복원의 정확성을 좌우하므로 순수 함수로 분리해
//! GUI 없이 유닛 테스트로 고정한다(실제 monitor 열거·창 이동은 호출부에서).

/// 디스플레이(모니터)의 가시 영역.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayInfo {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 저장되는 창 기하 — 디스플레이 id 기준 오프셋 + 크기.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedGeometry {
    pub display_id: Option<String>,
    pub offset_x: f64,
    pub offset_y: f64,
    pub width: f64,
    pub height: f64,
}

/// 점 (x, y)가 디스플레이 가시 영역 안에 있는지.
fn contains(display: &DisplayInfo, x: f64, y: f64) -> bool {
    x >= display.x
        && x < display.x + display.width
        && y >= display.y
        && y < display.y + display.height
}

/// 창의 왼쪽 위 좌표를 포함하는 디스플레이를 찾는다.
fn display_at(displays: &[DisplayInfo], x: f64, y: f64) -> Option<&DisplayInfo> {
    displays.iter().find(|d| contains(d, x, y))
}

/// 창이 디스플레이 가시 영역 안에 완전히 들어오도록 좌상단 좌표를 클램프한다.
fn clamp_into(display: &DisplayInfo, x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
    let max_x = (display.x + display.width - width).max(display.x);
    let max_y = (display.y + display.height - height).max(display.y);
    (x.clamp(display.x, max_x), y.clamp(display.y, max_y))
}

/// 절대 위치/크기를 [`SavedGeometry`]로 변환한다(좌상단이 속한 디스플레이 기준 오프셋).
///
/// 어느 디스플레이에도 속하지 않으면 `display_id = None`으로 절대값을 그대로 담는다.
pub fn capture_geometry(
    abs_x: f64,
    abs_y: f64,
    width: f64,
    height: f64,
    displays: &[DisplayInfo],
) -> SavedGeometry {
    match display_at(displays, abs_x, abs_y) {
        Some(d) => SavedGeometry {
            display_id: Some(d.id.clone()),
            offset_x: abs_x - d.x,
            offset_y: abs_y - d.y,
            width,
            height,
        },
        None => SavedGeometry {
            display_id: None,
            offset_x: abs_x,
            offset_y: abs_y,
            width,
            height,
        },
    }
}

/// [`SavedGeometry`]와 현재 디스플레이 구성으로 복원 절대 위치를 계산한다.
///
/// - 저장된 `display_id`가 현재 구성에 있으면: 그 디스플레이 기준으로 정확 복원(클램프).
/// - 없으면(구성 변경/해상도 변경): `primary` 가시 영역 안으로 폴백 클램프.
pub fn restore_position(
    saved: &SavedGeometry,
    displays: &[DisplayInfo],
    primary: &DisplayInfo,
) -> (f64, f64) {
    let target = saved
        .display_id
        .as_ref()
        .and_then(|id| displays.iter().find(|d| &d.id == id));
    match target {
        Some(d) => clamp_into(
            d,
            d.x + saved.offset_x,
            d.y + saved.offset_y,
            saved.width,
            saved.height,
        ),
        None => clamp_into(
            primary,
            primary.x + saved.offset_x,
            primary.y + saved.offset_y,
            saved.width,
            saved.height,
        ),
    }
}

/// 창이 어느 디스플레이에도 보이지 않으면 주 디스플레이 안으로 모을 새 위치를 돌려준다.
///
/// 이미 어떤 디스플레이 안에 있으면 `None`(이동 불필요). "모든 노트 화면 안으로 모으기"
/// 복구 액션의 코어.
pub fn gather_into_view(
    abs_x: f64,
    abs_y: f64,
    width: f64,
    height: f64,
    displays: &[DisplayInfo],
    primary: &DisplayInfo,
) -> Option<(f64, f64)> {
    if display_at(displays, abs_x, abs_y).is_some() {
        None
    } else {
        Some(clamp_into(primary, abs_x, abs_y, width, height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disp(id: &str, x: f64, y: f64, w: f64, h: f64) -> DisplayInfo {
        DisplayInfo {
            id: id.to_string(),
            x,
            y,
            width: w,
            height: h,
        }
    }

    /// 가드: 절대 위치가 속한 디스플레이 기준 오프셋으로 저장된다.
    #[test]
    fn capture_uses_containing_display_offset() {
        let displays = vec![
            disp("main", 0.0, 0.0, 1920.0, 1080.0),
            disp("ext", 1920.0, 0.0, 2560.0, 1440.0),
        ];
        let g = capture_geometry(2000.0, 100.0, 400.0, 300.0, &displays);
        assert_eq!(g.display_id.as_deref(), Some("ext"));
        assert_eq!((g.offset_x, g.offset_y), (80.0, 100.0));
    }

    /// 가드: 어느 디스플레이에도 없으면 display_id=None + 절대값 보존.
    #[test]
    fn capture_offscreen_keeps_absolute() {
        let displays = vec![disp("main", 0.0, 0.0, 1920.0, 1080.0)];
        let g = capture_geometry(-500.0, 50.0, 400.0, 300.0, &displays);
        assert_eq!(g.display_id, None);
        assert_eq!((g.offset_x, g.offset_y), (-500.0, 50.0));
    }

    /// 가드: 같은 디스플레이 구성이면 정확히 복원된다.
    #[test]
    fn restore_exact_when_display_present() {
        let displays = vec![
            disp("main", 0.0, 0.0, 1920.0, 1080.0),
            disp("ext", 1920.0, 0.0, 2560.0, 1440.0),
        ];
        let saved = SavedGeometry {
            display_id: Some("ext".to_string()),
            offset_x: 80.0,
            offset_y: 100.0,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(
            restore_position(&saved, &displays, &displays[0]),
            (2000.0, 100.0)
        );
    }

    /// 가드: 저장된 디스플레이가 사라지면 주 디스플레이 안으로 폴백·클램프된다.
    #[test]
    fn restore_falls_back_when_display_missing() {
        let displays = vec![disp("main", 0.0, 0.0, 1920.0, 1080.0)];
        let saved = SavedGeometry {
            display_id: Some("ext-gone".to_string()),
            offset_x: 5000.0, // 주 디스플레이 밖으로 나가는 큰 오프셋
            offset_y: 50.0,
            width: 400.0,
            height: 300.0,
        };
        let (x, y) = restore_position(&saved, &displays, &displays[0]);
        // 주 디스플레이 가시 영역 안으로 클램프(최대 x = 1920-400).
        assert_eq!((x, y), (1520.0, 50.0));
    }

    /// 가드: 화면 밖 창은 주 디스플레이 안 위치로 모으고, 안에 있으면 None.
    #[test]
    fn gather_moves_offscreen_only() {
        let displays = vec![disp("main", 0.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(
            gather_into_view(500.0, 500.0, 400.0, 300.0, &displays, &displays[0]),
            None
        );
        assert_eq!(
            gather_into_view(-800.0, 50.0, 400.0, 300.0, &displays, &displays[0]),
            Some((0.0, 50.0))
        );
    }
}
