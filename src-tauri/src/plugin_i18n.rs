//! 설치(서드파티) 언어팩 — 코어가 설치 매니페스트의 `contributes.translations`를 **직접**
//! 읽어 각 창에 공급하는 순수 로직.
//!
//! 역할: 앱데이터 `plugins/` 스캔 결과에서 언어팩 자격이 있는 플러그인만 골라 (1) 어떤
//! 로케일이 있는지 카탈로그([`list_language_packs`])를, (2) 로케일 하나의 사전을
//! ([`read_locale_entries`]) 만든다. IPC 래퍼는 [`crate::plugin_commands`], 등록은 `lib.rs`.
//!
//! ## 왜 코어가 직접 읽는가
//!
//! 예전 경로는 「중앙 호스트가 언어팩 플러그인을 샌드박스에서 실행 → `memo.i18n.register`
//! 브리지 → 스냅샷에 실어 각 창으로 배달」이었다. 그 왕복은 **첫 페인트보다 늦다** — 콜드
//! 스타트에서 창은 ko로 한 번 그려진 뒤 뒤늦게 도착한 언어팩 때문에 1회 리로드로 수습해야
//! 했다. 언어팩의 실체는 매니페스트에 적힌 **데이터**일 뿐이고 코드 실행이 필요 없으므로,
//! 코어가 파일을 직접 읽으면 그 왕복 자체가 사라진다(VS Code가 언어팩 확장을 확장 호스트
//! 없이 코어에서 읽는 것과 같은 구조). 번들 언어팩이 프론트 `src/i18n/packs.ts`로 먼저 같은
//! 전환을 한 것의 설치 플러그인 판이고, 그 브리지(`memo.i18n.register`)와 스냅샷 경로는
//! 이 모듈이 자리를 잡은 뒤 **제거됐다** — 지금 언어팩의 계약은
//! `contributes.translations` 선언 하나뿐이다.
//!
//! ## 수집 게이트는 이제 여기에만 있다
//!
//! 브리지가 있던 시절, 언어팩 등록은 프론트 게이트키퍼(권한·`kind`)와 중앙 호스트의 실행
//! 조건(활성·플랫폼)을 통과해야 했다. 그 경로가 사라졌으므로 **같은 강도의 게이트를 여기서
//! 지지 않으면 게이트가 통째로 없어진다** — 옮긴 것이지 느슨해진 것이 아니라는 뜻이다.
//! [`may_contribute_translations`]가 그 네 조건(활성 · 현재 OS 지원 · `kind: "capability"` ·
//! `i18n` 권한 선언)을 판정하고, 프론트 `src/plugin/host.ts`의 능력 등록 게이트가 쓰는 것과
//! **같은 문자열**을 상수로 고정한다.
//!
//! ## 콘텐츠 검증은 여기서 하지 않는다
//!
//! ko 사전 대조(미지 키 버림·플레이스홀더 일치)는 **소비 시점**(각 창의
//! `src/i18n/store.ts` → `validateLocaleEntries`)의 몫이다 — 기준 사전 ko는 프론트 자산이고,
//! 창마다 활성 로케일이 달라 백엔드가 미리 구울 수 없다(`nls` 원문을 그대로 나르는
//! `parse_manifest`와 같은 결). 여기서는 **구조**만 본다.

use crate::plugins::{is_valid_locale_code, InstalledPlugin};
use serde::Serialize;
use std::collections::BTreeMap;

/// 언어팩 수집을 게이트하는 권한 이름 — 프론트 `manifest.ts`의
/// `CORE_CONTRIBUTION_PERMISSIONS.translations`와 **같은 문자열**이어야 한다(그쪽은 CLI가
/// 설치 전에 같은 게이트를 재현하는 데 쓴다 — 어긋나면 "lint는 통과인데 앱은 수집하지 않는다").
const I18N_PERMISSION: &str = "i18n";

/// 능력(capability) 등록이 요구하는 매니페스트 `kind` — 프론트 `host.ts`의 `CAPABILITY_CALLS`
/// 게이트(`env?.kind !== "capability"`면 `WRONG_PLUGIN_KIND`)와 같은 값이다.
const CAPABILITY_KIND: &str = "capability";

/// `entries` 직렬화 크기 상한(바이트) — 초과 항목은 그 항목만 건너뛴다.
///
/// 왜 [`crate::plugin_storage::MAX_STORAGE_BYTES`]와 같은 256KB인가: 옛 브리지 경로의 상한은
/// 64KB였고 그 근거는 **스냅샷 왕복 비용**(등록된 사전이 모든 창에 복사돼 오간다)이었는데,
/// 이 경로엔 그 왕복이 없다 — 창이 필요한 로케일 하나를 직접 읽는다. 반면 `ko.json`은 계속
/// 자라므로(500키 이상) 낮은 상한을 그대로 옮기면 언젠가 **전 키를 커버한 성실한 언어팩이
/// 조용히 거부되는** 사고가 난다. 디스크 저장소와 같은 상한이 이 경로의 실제 비용 모델에 맞는다.
pub const MAX_ENTRIES_BYTES: usize = 256 * 1024;

/// 카탈로그 항목 하나 — "어떤 코드의 언어팩이 어느 플러그인에서 오는가".
///
/// 필드 이름은 camelCase로 나간다([`InstalledPlugin`]의 `minHostVersion`·`pendingReserved`와
/// 같은 페이로드 관례) — 소비처는 프론트 `src/shared/tauri.ts`의 `listLanguagePacks`다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackEntry {
    /// 로케일 코드(BCP47 소문자 단순형 — `en`·`pt-br`).
    pub code: String,
    /// 언어 드롭다운에 그대로 나가는 표시 라벨(저작자가 매니페스트에 적은 값).
    pub label: String,
    /// 이 로케일을 공급하는 플러그인 id(같은 코드를 여러 팩이 공급할 수 있어 함께 싣는다).
    pub plugin_id: String,
}

/// 구조 검증을 통과한 `contributes.translations` 항목 하나(내부 형).
struct Translation {
    locale: String,
    label: String,
    entries: BTreeMap<String, String>,
}

/// 플러그인이 현재 OS에서 지원되는가 — 프론트 `src/plugin/platform.ts`의
/// `isSupportedOnPlatform`과 **같은 의미론**이다.
///
/// 규칙: `platforms`가 비어 있으면(미선언 포함) 전 OS 지원. 선언돼 있으면 현재 OS가 목록에
/// 있어야 한다. **현재 OS를 알 수 없으면(빈 문자열) 제한하지 않는다** — 그쪽의 안전 폴백을
/// 그대로 옮긴다(판정 입력이 없다고 플러그인을 통째로 없애지 않는다).
fn is_supported_on_platform(platforms: &[String], os: &str) -> bool {
    if platforms.is_empty() || os.is_empty() {
        return true;
    }
    platforms.iter().any(|p| p.as_str() == os)
}

/// 이 플러그인이 언어팩을 공급할 자격이 있는가 — **언어팩 게이트의 유일한 판정 지점**.
///
/// 네 조건은 임의로 고른 것이 아니라, 언어팩이 브리지를 타던 시절 **실제로 통과해야 했던**
/// 조건을 그대로 옮긴 것이다. 앞의 둘은 중앙 호스트가 샌드박스를 아예 띄우지 않는 조건이고
/// (`src/plugin/central-host.ts`의 번들·설치 루프와 핫리로드), 뒤의 둘은 프론트
/// 게이트키퍼가 능력 등록을 거부하는 조건이다(`src/plugin/host.ts`의 `handleBridgeRequest` —
/// `CAPABILITY_CALLS`의 kind 게이트와 권한 게이트):
///
/// 1. **활성(enabled)** — 꺼 둔 플러그인은 애초에 호스트가 실행하지 않았다. 사용자가 끈
///    언어팩이 계속 언어를 공급하면 그 토글이 거짓말이 된다.
/// 2. **현재 OS 지원(`platforms`)** — 미지원 OS의 플러그인도 호스트가 실행하지 않았다
///    (프론트 `isSupportedOnPlatform`과 같은 의미론). 1번과 글자 그대로 같은 근거다.
/// 3. **`kind: "capability"`** — 능력 제공은 kind가 정확히 `"capability"`인 플러그인만 할 수
///    있다(미선언·`"action"` 모두 거부, 엄격). 프론트는 권한 판정보다 **먼저** 이 게이트를
///    두는데, 여기서는 넷이 한 식이라 순서가 관측되지 않는다.
/// 4. **`i18n` 권한 선언** — [`I18N_PERMISSION`].
///
/// **느슨해지면 안 되는 이유**: 이제 이 함수 말고는 언어팩을 막을 곳이 없다. 조건 하나를
/// 빼면 "설정에서 껐는데도 그 언어가 남는다" 같은 일이 아무 진단 없이 일어난다.
///
/// **왜 `granted`(사용자 승인)를 보지 않는가**: `i18n`은 `src/plugin/permissions.ts`의
/// `LOW_RISK_PERMISSIONS`에 있고, 그쪽 `checkPermission`은 **저위험 권한을 선언만으로
/// 통과**시킨다(민감 권한일 때만 `granted`를 요구한다). 실제로 `granted`에는 저위험 권한이
/// 애초에 들어가지 않는다 — 승인 화면이 부여 집합을 만드는
/// `src/settings/install-flow.ts`의 `grantsForApproval`이 `isSensitive`로 거른 **민감 권한만**
/// 백엔드에 보내므로, 정상 설치된 언어팩의 `granted`는 언제나 비어 있다. 그래서 여기서
/// `granted`를 요구하면 **모든 정상 언어팩을 거부**하게 된다 — 다른 저위험 능력(테마·배경·
/// 폰트)은 선언만으로 동작하는데 언어팩만 영영 안 뜨는, 원인을 찾을 단서가 없는 상태다.
fn may_contribute_translations(plugin: &InstalledPlugin, os: &str) -> bool {
    plugin.enabled
        && is_supported_on_platform(&plugin.platforms, os)
        && plugin.kind.as_deref() == Some(CAPABILITY_KIND)
        && plugin
            .permissions
            .iter()
            .any(|p| p.as_str() == I18N_PERMISSION)
}

/// `contributes.translations` 항목 하나를 구조 검증해 [`Translation`]으로 정규화한다(위반이면
/// None → 그 **항목만** 건너뛴다).
///
/// **이 함수가 언어팩 항목 형식의 정본**이다(저작 문서 —
/// `docs/plugin/manifest.schema.json`의 `contributes.translations`와
/// `docs/plugin/authoring.md`의 언어팩 절 — 이 규칙을 서술한다):
///
/// - `locale`: 트림 후 BCP47 소문자 단순형([`is_valid_locale_code`]). 소문자화하지 않는다 —
///   대문자 표기는 **거부**다(관용하면 `en`과 `EN`이 다른 로케일로 갈라진다).
/// - `label`: 트림 후 빈 문자열이 아니어야 한다.
/// - `entries`: 평탄 문자열 맵. 값이 문자열이 아닌 항목은 **그 키만** 버린다(항목 전체를
///   거부하지 않는다 — 콘텐츠 판단은 소비 시점의 몫이라 여기서는 타입만 본다).
/// - 직렬화 크기 [`MAX_ENTRIES_BYTES`] 이내.
///
/// 위반을 조용히 건너뛰는 이유: 한 팩의 실수가 카탈로그 전체를 막으면 안 된다(다른 언어팩
/// 사용자까지 함께 언어를 잃는다). 저작자용 표면화는 CLI(`memo-plugin lint`)가 맡는다.
fn parse_translation(item: &serde_json::Value) -> Option<Translation> {
    let obj = item.as_object()?;

    let locale = obj.get("locale")?.as_str()?.trim().to_string();
    if !is_valid_locale_code(&locale) {
        return None;
    }

    let label = obj.get("label")?.as_str()?.trim().to_string();
    if label.is_empty() {
        return None;
    }

    // `as_object`는 배열·문자열·null을 전부 None으로 떨어뜨린다(TS의 "객체이고 배열이 아님"
    // 검사와 같은 결과).
    let entries: BTreeMap<String, String> = obj
        .get("entries")?
        .as_object()?
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|s| (key.clone(), s.to_string())))
        .collect();

    // 상한은 **버린 키를 뺀 뒤**의 실제 페이로드로 잰다 — 창으로 나가는 것이 이 맵이다.
    if serde_json::to_string(&entries).ok()?.len() > MAX_ENTRIES_BYTES {
        return None;
    }

    Some(Translation {
        locale,
        label,
        entries,
    })
}

/// 한 플러그인이 선언한 translations 중 구조 검증을 통과한 것들(선언이 없으면 빈 벡터).
fn translations_of(plugin: &InstalledPlugin) -> Vec<Translation> {
    plugin
        .contributes
        .as_ref()
        .and_then(|c| c.get("translations"))
        .and_then(|t| t.as_array())
        .map(|items| items.iter().filter_map(parse_translation).collect())
        .unwrap_or_default()
}

/// 설치 언어팩 카탈로그 — "고를 수 있는 로케일" 목록(설정 창 언어 드롭다운용).
///
/// 자격 있는 플러그인([`may_contribute_translations`])의 유효 항목을 **전부** 나열한다.
/// 같은 `code`가 여러 팩에서 나와도 접지 않는다: 카탈로그는 "어느 플러그인이 무엇을
/// 공급하는가"의 사실 기록이고, 실제 병합(LastWins)은 사전을 실제로 읽는
/// [`read_locale_entries`]가 한다. 순서는 `scan_installed`의 반환 순서(id 사전순)를 따른다.
///
/// `os`는 현재 OS 식별자(`std::env::consts::OS`)다 — 호출부가 넘긴다. 이 모듈이 직접 읽지
/// 않는 이유는 순수성이다: 인자로 받아야 테스트가 **실행 OS와 무관하게** 결정적이 된다.
pub fn list_language_packs(scanned: &[InstalledPlugin], os: &str) -> Vec<LanguagePackEntry> {
    let mut entries = Vec::new();
    for plugin in scanned
        .iter()
        .filter(|p| may_contribute_translations(p, os))
    {
        for translation in translations_of(plugin) {
            entries.push(LanguagePackEntry {
                code: translation.locale,
                label: translation.label,
                plugin_id: plugin.id.clone(),
            });
        }
    }
    entries
}

/// 로케일 하나의 사전을 만든다 — 여러 팩이 같은 코드를 공급하면 **뒤가 앞을 덮는다**(LastWins).
///
/// 순회 순서는 `scan_installed`의 반환 순서(id 사전순)라 결정적이다. 프론트
/// `registerLocale`의 LastWins(같은 코드로 다시 등록하면 마지막이 이긴다)와 같은 규칙이라,
/// 두 경로가 같은 입력에서 같은 사전을 낸다. 일치하는 항목이 없으면 빈 맵이다(호출측은
/// "빈 맵 = 이 로케일 없음"으로 읽고 등록 자체를 건너뛴다).
///
/// `os`의 역할은 [`list_language_packs`]와 같다(같은 게이트를 태워야 카탈로그에 보이는 것과
/// 실제로 읽히는 것이 갈리지 않는다).
pub fn read_locale_entries(
    scanned: &[InstalledPlugin],
    locale: &str,
    os: &str,
) -> BTreeMap<String, String> {
    let mut merged = BTreeMap::new();
    for plugin in scanned
        .iter()
        .filter(|p| may_contribute_translations(p, os))
    {
        for translation in translations_of(plugin) {
            if translation.locale == locale {
                merged.extend(translation.entries);
            }
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::PluginSource;
    use serde_json::json;

    /// 이 테스트들이 흉내 내는 "현재 OS".
    ///
    /// 상수로 고정하는 것이 `os`를 인자화한 이유 그 자체다 — 모듈이 `std::env::consts::OS`를
    /// 직접 읽었다면 플랫폼 게이트 테스트가 **러너 OS에 따라 답이 갈렸을** 것이다(macOS에서
    /// 도는 CI와 리눅스 러너가 서로 다른 결과를 내는, 가장 나쁜 종류의 비결정성).
    const TEST_OS: &str = "macos";

    /// 테스트용 설치 플러그인 한 건 — 기본은 **자격을 갖춘** 언어팩(활성 · 전 OS 지원 ·
    /// capability · `i18n` 선언)이라, 각 테스트는 자기가 검증할 조건 하나만 무너뜨리면 된다.
    fn pack(id: &str, contributes: serde_json::Value) -> InstalledPlugin {
        InstalledPlugin {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            permissions: vec!["i18n".to_string()],
            platforms: Vec::new(),
            enabled: true,
            granted: Vec::new(), // 저위험 권한은 부여 목록에 들어가지 않는다(정상 상태).
            settings_schema: Vec::new(),
            settings: BTreeMap::new(),
            settings_category: None,
            settings_description: None,
            source: PluginSource::Local,
            summary: None,
            kind: Some("capability".to_string()),
            min_host_version: None,
            purpose: None,
            llm_context: None,
            permission_reasons: BTreeMap::new(),
            contributes: Some(contributes),
            exposes: Vec::new(),
            nls: None,
            pending_reserved: Vec::new(),
        }
    }

    /// `contributes.translations` 항목 하나를 만드는 축약.
    fn translations(items: serde_json::Value) -> serde_json::Value {
        json!({ "translations": items })
    }

    /// 정상 경로: 카탈로그와 사전이 모두 나온다.
    #[test]
    fn collects_a_valid_language_pack() {
        let packs = vec![pack(
            "language-pack-xx",
            translations(json!([{
                "locale": "xx",
                "label": "Xhosa-ish",
                "entries": { "panel.search.placeholder": "Search" }
            }])),
        )];

        assert_eq!(
            list_language_packs(&packs, TEST_OS),
            vec![LanguagePackEntry {
                code: "xx".to_string(),
                label: "Xhosa-ish".to_string(),
                plugin_id: "language-pack-xx".to_string(),
            }]
        );
        assert_eq!(
            read_locale_entries(&packs, "xx", TEST_OS).get("panel.search.placeholder"),
            Some(&"Search".to_string())
        );
        // 일치하지 않는 로케일은 빈 맵.
        assert!(read_locale_entries(&packs, "yy", TEST_OS).is_empty());
    }

    /// 게이트: 사용자가 꺼 둔 플러그인은 카탈로그에도 사전에도 나오지 않는다.
    #[test]
    fn excludes_a_disabled_plugin() {
        let mut p = pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }])),
        );
        p.enabled = false;
        let packs = vec![p];
        assert!(list_language_packs(&packs, TEST_OS).is_empty());
        assert!(read_locale_entries(&packs, "xx", TEST_OS).is_empty());
    }

    /// 게이트: 현재 OS를 지원하지 않는 언어팩은 카탈로그에도 사전에도 나오지 않는다.
    ///
    /// 왜 이 조건이 필요한가: 중앙 호스트는 미지원 OS 플러그인을 **아예 실행하지 않는다** —
    /// 언어팩만 그 규칙에서 빠지면 `platforms: ["windows"]`인 플러그인이 macOS에서 툴바 버튼
    /// 하나 못 붙이면서 UI 언어는 갈아치우는 앞뒤 안 맞는 상태가 된다.
    #[test]
    fn excludes_a_plugin_that_does_not_support_this_os() {
        let mut p = pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }])),
        );
        p.platforms = vec!["windows".to_string()];
        let packs = vec![p];
        assert!(list_language_packs(&packs, TEST_OS).is_empty());
        assert!(read_locale_entries(&packs, "xx", TEST_OS).is_empty());
    }

    /// 게이트: 지원 목록에 현재 OS가 있거나 목록이 **비어 있으면**(미선언 = 전
    /// OS 지원) 통과한다. OS를 모를 때(빈 문자열 — Tauri 밖·비정상)도 제한하지 않는다:
    /// `isSupportedOnPlatform`의 안전 폴백을 그대로 옮긴 것이라, 판정 입력이 없다고 언어가
    /// 통째로 사라지지 않는다.
    #[test]
    fn accepts_a_plugin_supported_on_this_os() {
        let body = translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }]));

        // 빈 배열(미선언) — 기본 pack()이 이미 그 상태다.
        assert_eq!(
            list_language_packs(&[pack("p", body.clone())], TEST_OS).len(),
            1
        );

        // 현재 OS를 명시적으로 포함.
        let mut listed = pack("p", body.clone());
        listed.platforms = vec!["windows".to_string(), TEST_OS.to_string()];
        assert_eq!(list_language_packs(&[listed], TEST_OS).len(), 1);

        // OS 미상(빈 문자열)이면 제한하지 않는다 — 다른 OS만 선언한 팩도 통과한다.
        let mut other = pack("p", body);
        other.platforms = vec!["windows".to_string()];
        assert_eq!(list_language_packs(&[other], "").len(), 1);
    }

    /// 게이트: `kind`가 `"capability"`가 아니면 제외한다 — 호스트가 능력 등록 호출을
    /// `WRONG_PLUGIN_KIND`로 거부하는 것과 같은 판정이다. 미선언(None)과 `"action"` 둘 다.
    #[test]
    fn excludes_a_plugin_whose_kind_is_not_capability() {
        let body = translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }]));
        for kind in [None, Some("action".to_string())] {
            let mut p = pack("language-pack-xx", body.clone());
            p.kind = kind;
            let packs = vec![p];
            assert!(list_language_packs(&packs, TEST_OS).is_empty());
            assert!(read_locale_entries(&packs, "xx", TEST_OS).is_empty());
        }
    }

    /// 게이트: `i18n` 권한을 선언하지 않았으면 제외한다 — 브리지 호출이
    /// `PERMISSION_UNDECLARED`로 거부되는 것과 같은 판정이다.
    #[test]
    fn excludes_a_plugin_that_did_not_declare_i18n() {
        let mut p = pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }])),
        );
        p.permissions = vec!["ui".to_string()];
        let packs = vec![p];
        assert!(list_language_packs(&packs, TEST_OS).is_empty());
        assert!(read_locale_entries(&packs, "xx", TEST_OS).is_empty());
    }

    /// 게이트(저위험 특례): `i18n`은 저위험이라 **선언만으로** 통과한다.
    ///
    /// 이 테스트가 없으면 "안전해 보이니 `granted`도 요구하자"는 조임이 슬쩍 들어와, 정상
    /// 설치된 모든 언어팩이 죽는다(`grantsForApproval`이 민감 권한만 부여하므로 언어팩의
    /// `granted`는 항상 비어 있다). 프론트 `checkPermission`과 같은 답을 낸다는 사실을 고정한다.
    #[test]
    fn accepts_a_low_risk_permission_without_a_user_grant() {
        let packs = vec![pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "a": "A" } }])),
        )];
        assert!(packs[0].granted.is_empty());
        assert_eq!(list_language_packs(&packs, TEST_OS).len(), 1);
    }

    /// 검증: 로케일 코드 형식 위반 항목은 조용히 건너뛴다(대문자·언더스코어·빈 서브태그·
    /// 1글자 — `is_valid_locale_code`의 규칙).
    #[test]
    fn skips_items_with_a_malformed_locale() {
        for bad in ["EN", "en_us", "en-", "e", "", "../evil"] {
            let packs = vec![pack(
                "language-pack-bad",
                translations(json!([{ "locale": bad, "label": "X", "entries": { "a": "A" } }])),
            )];
            assert!(
                list_language_packs(&packs, TEST_OS).is_empty(),
                "로케일 {bad:?}가 통과했다"
            );
        }
    }

    /// 검증: `label`이 없거나 공백뿐이면 그 항목을 건너뛴다(라벨은 드롭다운에 그대로
    /// 나가므로, 빈 항목을 받으면 "고를 수는 있는데 이름이 없는" 줄이 생긴다).
    #[test]
    fn skips_items_without_a_label() {
        for body in [
            json!([{ "locale": "xx", "entries": { "a": "A" } }]),
            json!([{ "locale": "xx", "label": "   ", "entries": { "a": "A" } }]),
            json!([{ "locale": "xx", "label": 7, "entries": { "a": "A" } }]),
        ] {
            let packs = vec![pack("language-pack-xx", translations(body))];
            assert!(list_language_packs(&packs, TEST_OS).is_empty());
        }
    }

    /// 검증: `entries`가 평탄 문자열 맵이 아니면(배열·문자열·부재) 그 항목을 건너뛴다.
    #[test]
    fn skips_items_whose_entries_are_not_a_map() {
        for body in [
            json!([{ "locale": "xx", "label": "X" }]),
            json!([{ "locale": "xx", "label": "X", "entries": ["a"] }]),
            json!([{ "locale": "xx", "label": "X", "entries": "a" }]),
        ] {
            let packs = vec![pack("language-pack-xx", translations(body))];
            assert!(list_language_packs(&packs, TEST_OS).is_empty());
        }
    }

    /// 검증: 값이 문자열이 아닌 키는 **그 키만** 버리고 항목 자체는 살린다.
    #[test]
    fn drops_only_non_string_entry_values() {
        let packs = vec![pack(
            "language-pack-xx",
            translations(json!([{
                "locale": "xx",
                "label": "X",
                "entries": { "keep": "ok", "drop-number": 1, "drop-object": {}, "drop-null": null }
            }])),
        )];
        let entries = read_locale_entries(&packs, "xx", TEST_OS);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.get("keep"), Some(&"ok".to_string()));
        // 항목이 살아 있으므로 카탈로그에도 나온다.
        assert_eq!(list_language_packs(&packs, TEST_OS).len(), 1);
    }

    /// 검증: 직렬화 크기 상한을 넘는 항목은 건너뛴다. 상한 **이내**는 그대로 통과한다
    /// (경계 양쪽을 함께 고정해 상한이 실수로 0이 되는 회귀도 잡는다).
    #[test]
    fn skips_items_over_the_size_limit() {
        let huge = "x".repeat(MAX_ENTRIES_BYTES + 1);
        let over = vec![pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "k": huge } }])),
        )];
        assert!(list_language_packs(&over, TEST_OS).is_empty());

        let fits = "y".repeat(1024);
        let under = vec![pack(
            "language-pack-xx",
            translations(json!([{ "locale": "xx", "label": "X", "entries": { "k": fits } }])),
        )];
        assert_eq!(list_language_packs(&under, TEST_OS).len(), 1);
    }

    /// 검증: 같은 코드를 여러 팩이 공급하면 카탈로그는 **전부** 나열하고, 사전은
    /// **뒤(=id 사전순 뒤)가 앞을 덮는다**(LastWins — 프론트 `registerLocale`과 같은 규칙이라
    /// 두 경로가 같은 입력에서 같은 사전을 낸다).
    #[test]
    fn merges_duplicate_locales_last_wins() {
        let packs = vec![
            pack(
                "language-pack-a",
                translations(json!([{
                    "locale": "xx",
                    "label": "First",
                    "entries": { "shared": "from-a", "only-a": "A" }
                }])),
            ),
            pack(
                "language-pack-b",
                translations(json!([{
                    "locale": "xx",
                    "label": "Second",
                    "entries": { "shared": "from-b" }
                }])),
            ),
        ];

        let catalog = list_language_packs(&packs, TEST_OS);
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].plugin_id, "language-pack-a");
        assert_eq!(catalog[1].plugin_id, "language-pack-b");

        let entries = read_locale_entries(&packs, "xx", TEST_OS);
        assert_eq!(entries.get("shared"), Some(&"from-b".to_string()));
        // 뒤 팩이 안 덮은 키는 앞 팩의 값이 남는다(전체 교체가 아니라 키 단위 병합).
        assert_eq!(entries.get("only-a"), Some(&"A".to_string()));
    }

    /// 검증: 한 팩의 잘못된 항목이 **같은 팩의 멀쩡한 항목**까지 죽이지 않는다(항목 단위 스킵).
    #[test]
    fn a_bad_item_does_not_kill_its_siblings() {
        let packs = vec![pack(
            "language-pack-multi",
            translations(json!([
                { "locale": "BAD", "label": "X", "entries": { "a": "A" } },
                { "locale": "xx", "label": "Good", "entries": { "a": "A" } }
            ])),
        )];
        let catalog = list_language_packs(&packs, TEST_OS);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].code, "xx");
    }

    /// 검증: `contributes` 자체가 없거나 `translations`가 배열이 아니면 조용히 빈 결과다
    /// (일반 플러그인이 대다수인 정상 경로 — 오류가 아니다).
    #[test]
    fn ignores_plugins_without_translations() {
        let packs = vec![
            {
                let mut p = pack("no-contributes", json!({}));
                p.contributes = None;
                p
            },
            pack("other-kind", json!({ "inlinePatterns": [{ "id": "hl" }] })),
            pack("wrong-shape", translations(json!("nope"))),
        ];
        assert!(list_language_packs(&packs, TEST_OS).is_empty());
        assert!(read_locale_entries(&packs, "xx", TEST_OS).is_empty());
    }

    /// 가드: 카탈로그 페이로드가 camelCase로 나간다(프론트 `LanguagePackEntry`와 필드명 일치 —
    /// snake_case로 새면 `pluginId`가 조용히 undefined가 된다).
    #[test]
    fn serializes_plugin_id_as_camel_case() {
        let json = serde_json::to_string(&LanguagePackEntry {
            code: "xx".to_string(),
            label: "X".to_string(),
            plugin_id: "language-pack-xx".to_string(),
        })
        .unwrap();
        assert!(json.contains("\"pluginId\""), "{json}");
        assert!(!json.contains("plugin_id"), "{json}");
    }
}
