//! 데이터 모델 (노트 메타 · 전역 설정 · 로컬 설정).
//!
//! 역할: 파일로 저장되는 구조를 serde 타입으로 정의하고, "전역 기본값 + 노트별
//! override" 병합 규칙을 제공한다.
//! 왜: 본문(.md)과 분리된 노트별 메타(사이드카)·동기화 설정·기기 고유(로컬) 설정의
//! 경계를 코드로 못박아 동기화 충돌과 vaultPath 순환을 구조적으로 막는다.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 사이드카/설정 스키마 버전 — 향후 마이그레이션 기준점.
pub const SCHEMA_VERSION: u32 = 1;

/// 노트 배경(색 또는 이미지) — **노트별 override에만** 쓰인다([`NoteOverrides::background`]).
///
/// 전역 기본 배경은 여기 없다: "배경색"은 번들 플러그인이 공급하는 **능력**이라 기본값도
/// 그 플러그인의 첫 스와치이고(프론트 `theme/background.ts`), 플러그인을 끄면 고정색으로
/// 떨어진다. 예전엔 `NoteDefaults`에도 배경 필드가 있었지만 읽는 곳이 없었고, 기본값이
/// CSS 색이 아닌 리터럴 `"default"`라 동기화 설정 파일에 의미 없는 값만 남겼다.
///
/// `Default`를 구현하지 않는 이유도 같다 — "기본 배경"이라는 개념이 이 계층에 없다.
/// override는 `Option<Background>`라 `None`(=상속)이 자연스러운 빈 값이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Background {
    /// 단색 배경(`#rgb`·`#rrggbb` — 프론트가 적용 직전 형식을 다시 검증한다).
    Color { value: String },
    /// 이미지 배경(첨부 상대경로 + 맞춤/불투명도).
    Image {
        value: String,
        fit: String,
        opacity: u8,
    },
}

/// 창 기하 정보(디스플레이 기준 오프셋 + 크기). 동기화되지만 복원은 디스플레이
/// 구성에 따라 보정된다.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub display_id: Option<String>,
    pub offset_x: f64,
    pub offset_y: f64,
    pub width: f64,
    pub height: f64,
    /// 접기(롤업) 전 원래 높이.
    pub prev_height: Option<f64>,
}

/// 노트별 override. `None`이면 전역 기본값([`NoteDefaults`])을 상속한다.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NoteOverrides {
    pub transparency: Option<u8>,
    pub background: Option<Background>,
    /// 메모별 글자 크기 델타(%). 전역 기본(px=100%)에 더해진다: 실효 px = 전역 + 14×델타/100.
    /// 플러그인이 조절하며, 전역 글자 크기는 앱 설정(NoteDefaults.font_size)이 담당한다.
    pub font_delta: Option<i32>,
    pub markdown_preview: Option<bool>,
    /// 창 **「항상 위」**(OS 레벨 always-on-top). 목록의 즐겨찾기([`NoteMeta::favorite`])와는
    /// 아무 관계가 없다 — 이름이 비슷해 헷갈리기 쉬우니 서로를 부인해 둔다.
    pub pinned: Option<bool>,
    pub all_spaces: Option<bool>,
    pub collapsed: Option<bool>,
}

/// 노트 사이드카(`notes/<id>.json`) — 동기화되는 노트별 메타.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteMeta {
    pub schema_version: u32,
    pub window: WindowGeometry,
    pub overrides: NoteOverrides,
    /// 보관(닫기) 상태 — 창은 숨기되 데이터·목록은 유지.
    pub hidden: bool,
    pub z_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// 즐겨찾기 — 패널 목록에서 이 노트를 **맨 위 묶음**으로 올린다(정렬 모드와 무관하게
    /// 항상 상단, 단 현재 필터/검색 결과 안에서만).
    ///
    /// 창 **「항상 위」**([`NoteOverrides::pinned`])와는 아무 관계가 없다 — 그쪽은 OS 창
    /// 레벨의 always-on-top이고 이쪽은 목록 순서일 뿐이다. 이름이 비슷해 실제로 혼동이
    /// 일어났던 자리라 두 필드가 서로를 부인해 둔다.
    ///
    /// `#[serde(default)]`가 **필수**다: 이 필드가 없던 구버전 사이드카(`notes/<id>.json`)를
    /// 읽을 때 default가 없으면 [`crate::notes::Vault::read_meta`]가 통째로 실패하고,
    /// 그러면 `hidden` 판정이 뒤집혀 **보관한 노트가 되살아난다**(창 위치·override도 함께
    /// 유실된다). 아래 `opened_at`도 같은 이유다.
    #[serde(default)]
    pub favorite: bool,
    /// 사용자가 **직접** 이 노트를 마지막으로 연 시각(에폭 ms). 없으면 `None`(= 기록된 적 없음,
    /// 「최근 연 순」 내림차순에서 맨 뒤).
    ///
    /// 기록하는 곳: 새 노트 생성([`NoteMeta::new`])·복제·소환(`summon_note`, 그 안의
    /// `mark_opened`)처럼 **사람이 고른 열기**뿐이다. 트레이 「열린 노트」 항목 클릭은 별도
    /// 경로가 아니라 `summon_note`를 그대로 호출하므로 자동으로 같이 기록된다(`tray.rs::
    /// on_tray_menu_event` 참고). 점프 리스트(Windows)는 특정 노트를 여는 동작 자체가 없어
    /// (새 노트·패널·설정 셋뿐, `jumplist::LaunchAction`) 별도 기록 지점이 필요 없다 — 그
    /// "새 노트"도 결국 `create_and_open` → 이 타입의 `new`로 이어져 위 규칙을 그대로 탄다.
    /// 시작 시 창 복원과 「모든 메모 보이기」는 기록하지 않는다 — 한 번에 전부 같은 시각이
    /// 되어 순서가 무의미해지기 때문이다.
    ///
    /// `#[serde(default)]`가 필수인 이유는 위 `favorite` 참고.
    #[serde(default)]
    pub opened_at: Option<i64>,
}

impl NoteMeta {
    /// 생성 시각이 주어진 새 메타를 만든다(현재 스키마 버전).
    ///
    /// `opened_at`을 생성 시각으로 채우는 이유: 방금 만든 노트는 곧바로 창이 뜨므로 사용자가
    /// "지금 연" 노트가 맞다. `None`으로 두면 「최근 연 순」에서 새 노트가 맨 뒤로 가버린다.
    pub fn new(now_ms: i64) -> Self {
        NoteMeta {
            schema_version: SCHEMA_VERSION,
            window: WindowGeometry::default(),
            overrides: NoteOverrides::default(),
            hidden: false,
            z_order: 0,
            created_at: now_ms,
            updated_at: now_ms,
            favorite: false,
            opened_at: Some(now_ms),
        }
    }
}

/// 전역 기본값(동기화) — 노트가 override하지 않은 항목의 출처.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteDefaults {
    pub transparency: u8,
    pub font_size: u32,
    /// 전역 폰트 패밀리(CSS 폰트 스택). 「폰트」 플러그인이 제공하는 목록에서 고른 값이며,
    /// None이면 시스템 기본 폰트. serde 기본값으로 구버전 파일(필드 없음)도 호환한다.
    #[serde(default)]
    pub font_family: Option<String>,
    pub markdown_preview: bool,
    pub pinned: bool,
    pub all_spaces: bool,
}

impl Default for NoteDefaults {
    fn default() -> Self {
        NoteDefaults {
            transparency: 100,
            font_size: 14,
            font_family: None,
            markdown_preview: true,
            pinned: false,
            all_spaces: false,
        }
    }
}

/// 노트의 실제 적용값(전역 기본값 + override 병합 결과).
///
/// 배경은 여기 없다 — 노트 배경은 창을 만드는 백엔드가 아니라 노트 창(프론트)이 적용하고,
/// 그 출처는 override 아니면 배경 플러그인의 스와치다([`Background`] 주석 참고).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedNoteSettings {
    pub transparency: u8,
    pub font_size: u32,
    pub markdown_preview: bool,
    pub pinned: bool,
    pub all_spaces: bool,
    pub collapsed: bool,
}

/// 전역 기본값과 노트별 override를 병합해 실제 적용값을 만든다.
///
/// 역할: "override가 있으면 그것, 없으면 전역 기본값" 규칙을 한 곳에 고정한다.
/// 왜: UI/창 양쪽에서 같은 해석을 쓰도록 단일 진실원천으로 둔다.
pub fn resolve_settings(
    defaults: &NoteDefaults,
    overrides: &NoteOverrides,
) -> ResolvedNoteSettings {
    ResolvedNoteSettings {
        transparency: overrides.transparency.unwrap_or(defaults.transparency),
        // 실효 글자 크기(px) = 전역 기본 + 14×델타/100(반올림), 8~48px로 클램프.
        // 반올림은 프론트 effectiveFontPx(Math.round)와 결과를 일치시키기 위함이다(정수 나눗셈 X).
        font_size: {
            let delta = overrides.font_delta.unwrap_or(0);
            let px = defaults.font_size as i32 + (14.0 * delta as f64 / 100.0).round() as i32;
            px.clamp(8, 48) as u32
        },
        markdown_preview: overrides
            .markdown_preview
            .unwrap_or(defaults.markdown_preview),
        pinned: overrides.pinned.unwrap_or(defaults.pinned),
        all_spaces: overrides.all_spaces.unwrap_or(defaults.all_spaces),
        collapsed: overrides.collapsed.unwrap_or(false),
    }
}

/// 툴바 배치(상·하 바 × 존별 아이템 키 + 정렬·줄임 우선순위·`seen`). 스키마의 **소유자는
/// 프론트**(src/note/toolbar-layout.ts)이고, 백엔드는 의미를 전혀 모른 채 받은 JSON을 그대로
/// 저장/반환한다 — 그래서 구조체가 아니라 불투명 `serde_json::Value`다.
///
/// 왜: 예전엔 Rust가 `{top, bottom}`만 아는 구조체로 받아, 프론트가 배치 스키마에 필드를
/// 더할 때마다(`seen`·`foldRank`) serde가 그 필드를 조용히 **버렸다**. 저장 왕복에서 값이
/// 사라져도 아무 데서도 오류가 나지 않아, "사용자가 뺀 버튼이 재시작마다 되살아난다" 같은
/// 형태로만 드러났다. 불투명 저장이면 프론트가 필드를 늘려도 백엔드를 함께 고칠 일이 없다.
pub type ToolbarLayout = serde_json::Value;

/// 동기화되는 전역 설정(`<vault>/.memo/shared-settings.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SharedSettings {
    pub schema_version: u32,
    pub theme: String,
    /// 테마별 사용자 색 오버라이드(테마명 → 토큰키 → hex). 테마가 준 기본 팔레트 위에
    /// 사용자가 덮어쓰는 레이어(프론트 `mergeThemeOverrides`가 적용). 필드가 없던 구버전
    /// 파일도 읽히도록 serde 기본값(빈 맵) — 없으면 "오버라이드 없음"으로 해석된다.
    #[serde(default)]
    pub theme_overrides: BTreeMap<String, BTreeMap<String, String>>,
    /// 동작 id → 키 가속기(창 단위 도구 단축키). 예 `"zoom-in" → "Alt+Equal"`,
    /// `"plugin:duplicate:duplicate" → "Mod+Shift+KeyD"`. 노트 창이 읽어 포커스 시 키맵을
    /// 설치한다. 필드가 없던 구버전 파일도 읽히도록 serde 기본값(빈 맵) — 없으면 "바인딩 없음".
    #[serde(default)]
    pub keybindings: BTreeMap<String, String>,
    /// 툴바 버튼 배치(설정 창에서 드래그&드롭으로 구성). 필드가 없던 구버전 파일도 읽히도록
    /// serde 기본값(None) — 없으면 프론트가 기본 배치를 쓴다. None이면 직렬화에서 생략한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolbar_layout: Option<ToolbarLayout>,
    /// 사용자가 고른 툴바 스타일(닫기 버튼 좌/우) — `"mac"` | `"windows"`. 백엔드는 값을 그대로
    /// 보관·왕복만 할 뿐 의미를 모른다(어떤 문자열이든 받는다 — 어휘 검증은 프론트가 한다).
    /// 최초 실행 프롬프트(`src/note/toolbar-style-prompt.ts`)가 한 번 고르면 채우는 "이미
    /// 물어봤다" 플래그를 겸한다. 필드가 없던 구버전 파일도 읽히도록 serde 기본값(None) —
    /// 없으면 프론트가 아직 고른 적 없다고 본다. None이면 직렬화에서 생략한다(toolbar_layout과
    /// 같은 관례).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolbar_style: Option<String>,
    /// UI 언어 로케일 코드(예 `"ko"`). 백엔드는 값을 그대로 보관·왕복만 할 뿐 의미를 모른다 —
    /// 등록된 로케일 판정·폴백은 프론트 `src/i18n/store.ts`가 한다. 필드가 없던 구버전 파일도
    /// 읽히도록 serde 기본값(None) — 없으면 프론트가 ko를 기본으로 쓴다. None이면 직렬화에서
    /// 생략한다(toolbar_layout과 같은 관례).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// 「시작 가이드」 메모의 노트 id — 이미 만들었는지의 **단일 진실원천**이자, 설정
    /// 「도움말 › 시작 가이드 다시 보기」가 소환할 대상.
    ///
    /// 왜 `LocalConfig`(기기 고유)가 아니라 여기(vault·동기화)인가: 가이드는 **노트 데이터**라
    /// vault 안에 있다. 기기별로 기록하면 같은 vault를 보는 둘째 기기가 이미 있는 가이드를
    /// 못 보고 하나 더 만든다(`welcomed`는 그 반대 이유로 로컬에 있다 — 그건 이 vault가 아니라
    /// 이 설치의 첫 실행 여부다).
    ///
    /// **코어 소유 필드다** — 프론트가 보내는 `save_shared_settings`는 이 값을 바꾸지 못하고
    /// (보낸 값이 무엇이든 코어가 지금 값으로 되돌린다,
    /// [`crate::commands::save_shared_settings`]), 오직 [`crate::commands::claim_guide_note`]만
    /// 바꾼다. 그래야 가이드를 만들기 전에 로드된 설정 창이 나중에 저장하면서 방금 기록된
    /// id를 지워 버리는(→ 다음 실행에 가이드가 하나 더 생기는) 경로가 닫힌다.
    ///
    /// 값이 있는데 그 노트가 없을 수도 있다(사용자가 지웠다 — 가이드 본문이 권하는 일이다).
    /// 그때도 **다시 만들지 않는다**: "이미 한 번 안내했다"는 뜻이므로 시작 시 자동 생성은
    /// 건너뛰고, 「다시 보기」만 새로 만든다(`force`).
    ///
    /// 필드가 없던 구버전 파일도 읽히도록 serde 기본값(None) — 없으면 아직 만든 적 없음.
    /// None이면 직렬화에서 생략한다(language와 같은 관례).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guide_note_id: Option<String>,
    pub defaults: NoteDefaults,
}

impl Default for SharedSettings {
    fn default() -> Self {
        SharedSettings {
            schema_version: SCHEMA_VERSION,
            theme: "sj_d".to_string(),
            theme_overrides: BTreeMap::new(),
            keybindings: BTreeMap::new(),
            toolbar_layout: None,
            toolbar_style: None,
            language: None,
            guide_note_id: None,
            defaults: NoteDefaults::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: override가 없으면 전역 기본값을 그대로 상속한다.
    #[test]
    fn resolve_inherits_defaults_when_no_override() {
        let resolved = resolve_settings(&NoteDefaults::default(), &NoteOverrides::default());
        assert_eq!(resolved.transparency, 100);
        assert_eq!(resolved.font_size, 14);
        assert!(resolved.markdown_preview);
        assert!(!resolved.pinned);
        assert!(!resolved.collapsed);
    }

    /// 가드: override가 있으면 전역 기본값을 덮어쓴다(섞여도 항목별로 정확히).
    #[test]
    fn resolve_prefers_overrides() {
        let overrides = NoteOverrides {
            transparency: Some(40),
            pinned: Some(true),
            collapsed: Some(true),
            ..NoteOverrides::default()
        };
        let resolved = resolve_settings(&NoteDefaults::default(), &overrides);
        assert_eq!(resolved.transparency, 40);
        assert!(resolved.pinned);
        assert!(resolved.collapsed);
        // override 안 한 항목은 여전히 기본값.
        assert_eq!(resolved.font_size, 14);
    }

    /// 가드: 글자 크기 델타(%)가 전역에 더해진다(전역 14px, +50%→21px; -50%→7→8px 클램프).
    /// 반올림이 프론트 effectiveFontPx(Math.round)와 일치해야 한다(정수 나눗셈이면 어긋남).
    #[test]
    fn resolve_applies_font_delta() {
        let d = NoteDefaults::default();
        let cases = [
            (50, 21u32), // 14 + round(7.0)=7
            (-50, 8),    // 14 - 7 = 7 → clamp 8
            (20, 17),    // 14 + round(2.8)=3 (정수 나눗셈이면 16 — 반올림이라 17)
            (-20, 11),   // 14 + round(-2.8)=-3 (정수 나눗셈이면 12 — 반올림이라 11)
            (300, 48),   // 14 + 42 = 56 → clamp 48
        ];
        for (delta, expected) in cases {
            let r = resolve_settings(
                &d,
                &NoteOverrides {
                    font_delta: Some(delta),
                    ..Default::default()
                },
            );
            assert_eq!(r.font_size, expected, "delta={delta}");
        }
    }

    /// 가드: 사이드카 메타가 JSON 왕복(직렬화→역직렬화)에 안정적이다.
    #[test]
    fn note_meta_json_roundtrip() {
        let meta = NoteMeta::new(1_700_000_000_000);
        let json = serde_json::to_string(&meta).unwrap();
        let back: NoteMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(meta, back);
        assert_eq!(back.schema_version, SCHEMA_VERSION);
    }

    /// 가드(치명 회귀): `favorite`·`opened_at`이 **없던 구버전 사이드카**도 그대로 읽힌다.
    ///
    /// 왜 이 테스트가 필요한가: `NoteMeta`는 오랫동안 `#[serde(default)]` 없는 필수 필드만
    /// 있었다. 새 필드에 default를 빠뜨리면 [`crate::notes::Vault::read_meta`]가 기존 노트
    /// 전부에서 실패하고, `open_startup_windows`의 hidden 판정이 뒤집혀 **보관한 노트가
    /// 되살아난다**(창 위치·override도 함께 유실). 값이 아니라 "파싱이 되는지"가 요점이다.
    #[test]
    fn note_meta_reads_legacy_sidecar_without_new_fields() {
        let legacy = r#"{
            "schema_version": 1,
            "window": {"display_id": null, "offset_x": 0.0, "offset_y": 0.0,
                       "width": 320.0, "height": 240.0, "prev_height": null},
            "overrides": {"transparency": null, "background": null, "font_delta": null,
                          "markdown_preview": null, "pinned": null, "all_spaces": null,
                          "collapsed": null},
            "hidden": true,
            "z_order": 3,
            "created_at": 1700000000000,
            "updated_at": 1700000000000
        }"#;
        let meta: NoteMeta =
            serde_json::from_str(legacy).expect("구버전 사이드카는 반드시 읽혀야 한다");
        assert!(!meta.favorite, "없던 필드는 즐겨찾기 아님으로 읽는다");
        assert_eq!(
            meta.opened_at, None,
            "없던 필드는 「연 적 없음」으로 읽는다"
        );
        assert!(meta.hidden, "보관 상태가 그대로 살아 있어야 한다");
        assert_eq!(meta.z_order, 3);
    }

    /// 가드: 새 메타는 즐겨찾기 아님 + `opened_at`이 생성 시각(새 노트가 「최근 연 순」 맨 뒤로
    /// 밀리지 않게).
    #[test]
    fn new_note_meta_starts_unfavorited_and_opened_now() {
        let meta = NoteMeta::new(1_700_000_000_000);
        assert!(!meta.favorite);
        assert_eq!(meta.opened_at, Some(1_700_000_000_000));
    }

    /// 가드: 즐겨찾기·최근 연 시각이 JSON 왕복에 보존된다.
    #[test]
    fn note_meta_favorite_and_opened_at_roundtrip() {
        let mut meta = NoteMeta::new(1_700_000_000_000);
        meta.favorite = true;
        meta.opened_at = Some(1_800_000_000_000);
        let back: NoteMeta = serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        assert_eq!(back, meta);
    }

    /// 가드: 배경 enum이 type 태그로 직렬화된다(color/image 구분).
    #[test]
    fn background_serializes_with_type_tag() {
        let json = serde_json::to_string(&Background::Color {
            value: "#fff".to_string(),
        })
        .unwrap();
        assert!(json.contains("\"type\":\"color\""));
    }

    /// 가드: theme_overrides가 JSON 왕복에 보존된다(테마별 토큰→hex 맵).
    #[test]
    fn shared_settings_theme_overrides_roundtrip() {
        let mut sjd = BTreeMap::new();
        sjd.insert("accent".to_string(), "#112233".to_string());
        sjd.insert("danger".to_string(), "#445566".to_string());
        let mut ov = BTreeMap::new();
        ov.insert("sj_d".to_string(), sjd);
        let s = SharedSettings {
            theme_overrides: ov,
            ..SharedSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SharedSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.theme_overrides["sj_d"]["accent"], "#112233");
    }

    /// 가드(호환): theme_overrides 필드가 없던 구버전 파일도 빈 맵으로 관대하게 읽힌다.
    #[test]
    fn shared_settings_theme_overrides_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("theme_overrides");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.theme_overrides.is_empty());
    }

    /// 가드: keybindings가 JSON 왕복에 보존된다(동작 id → 키 가속기 맵).
    #[test]
    fn shared_settings_keybindings_roundtrip() {
        let mut kb = BTreeMap::new();
        kb.insert("zoom-in".to_string(), "Alt+Equal".to_string());
        kb.insert(
            "plugin:duplicate:duplicate".to_string(),
            "Mod+Shift+KeyD".to_string(),
        );
        let s = SharedSettings {
            keybindings: kb,
            ..SharedSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SharedSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.keybindings["zoom-in"], "Alt+Equal");
    }

    /// 가드(유실 회귀): 툴바 배치는 백엔드가 의미를 모르는 **불투명 값**이라, 프론트가 넣은
    /// 필드가 저장 왕복에서 하나도 사라지지 않는다.
    ///
    /// 왜: 예전엔 Rust가 `{top, bottom}`만 아는 구조체로 받아, 프론트가 새로 도입한 `seen`
    /// (사용자가 명시적으로 뺀 버튼)과 `foldRank`(줄임 우선순위)를 serde가 조용히 버렸다 —
    /// 저장할 때마다 리셋돼, 팔레트로 빼낸 서드파티 버튼이 다시 툴바에 나타났다.
    #[test]
    fn shared_settings_toolbar_layout_is_opaque_and_lossless() {
        // 프론트(settings.ts persist)가 실제로 보내는 모양.
        let layout = serde_json::json!({
            "top": { "align": "left", "zones": [["core:preview"]], "foldRank": [0] },
            "bottom": { "align": "right", "zones": [[]] },
            "seen": ["core:preview", "plugin:third:btn"],
        });
        let mut raw = serde_json::to_value(SharedSettings::default()).unwrap();
        raw["toolbar_layout"] = layout.clone();

        let parsed: SharedSettings = serde_json::from_value(raw).unwrap();
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back["toolbar_layout"], layout,
            "저장 왕복에서 툴바 배치 필드가 유실됨(백엔드가 스키마를 알려 들면 안 된다)"
        );
    }

    /// 가드(호환): toolbar_layout 필드가 없던 구버전 파일도 None으로 관대하게 읽히고,
    /// 직렬화에서 생략된다(빈 키를 새로 만들지 않는다).
    #[test]
    fn shared_settings_toolbar_layout_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("toolbar_layout");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.toolbar_layout.is_none());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(!json.contains("toolbar_layout"));
    }

    /// 가드(호환): keybindings 필드가 없던 구버전 파일도 빈 맵으로 관대하게 읽힌다.
    #[test]
    fn shared_settings_keybindings_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("keybindings");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.keybindings.is_empty());
    }

    /// 가드: language가 JSON 왕복(직렬화→역직렬화)에 보존된다(UI 언어 로케일 코드).
    #[test]
    fn shared_settings_language_roundtrip() {
        let s = SharedSettings {
            language: Some("ko".to_string()),
            ..SharedSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SharedSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.language.as_deref(), Some("ko"));
    }

    /// 가드(호환): language 필드가 없던 구버전 파일도 None으로 관대하게 읽히고,
    /// 직렬화에서 생략된다(toolbar_layout과 같은 관례 — 빈 키를 새로 만들지 않는다).
    #[test]
    fn shared_settings_language_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("language");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.language.is_none());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(!json.contains("language"));
    }

    /// 가드: toolbar_style이 JSON 왕복(직렬화→역직렬화)에 보존된다(이슈 #16 — 최초 실행
    /// 프롬프트가 고른 닫기 버튼 좌/우 스타일).
    #[test]
    fn shared_settings_toolbar_style_roundtrip() {
        let s = SharedSettings {
            toolbar_style: Some("mac".to_string()),
            ..SharedSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SharedSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.toolbar_style.as_deref(), Some("mac"));
    }

    /// 가드(호환): toolbar_style 필드가 없던 구버전 파일도 None으로 관대하게 읽히고,
    /// 직렬화에서 생략된다(language와 같은 관례 — 빈 키를 새로 만들지 않는다).
    #[test]
    fn shared_settings_toolbar_style_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("toolbar_style");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.toolbar_style.is_none());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(!json.contains("toolbar_style"));
    }

    /// 가드: guide_note_id가 JSON 왕복에 보존된다(「시작 가이드」 메모를 이미 만들었는지의
    /// 단일 진실원천 — 왕복에서 사라지면 재시작마다 가이드가 하나씩 더 생긴다).
    #[test]
    fn shared_settings_guide_note_id_roundtrip() {
        let s = SharedSettings {
            guide_note_id: Some("note-1".to_string()),
            ..SharedSettings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SharedSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.guide_note_id.as_deref(), Some("note-1"));
    }

    /// 가드(호환): guide_note_id 필드가 없던 구버전 파일도 None으로 관대하게 읽히고,
    /// 직렬화에서 생략된다(toolbar_style·language와 같은 관례).
    #[test]
    fn shared_settings_guide_note_id_back_compat() {
        let mut v = serde_json::to_value(SharedSettings::default()).unwrap();
        v.as_object_mut().unwrap().remove("guide_note_id");
        let parsed: SharedSettings = serde_json::from_value(v).unwrap();
        assert!(parsed.guide_note_id.is_none());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(!json.contains("guide_note_id"));
    }
}
