//! 외부(로컬 사이드로드) 플러그인 — 앱데이터 `plugins/` 스캔·설치·활성/권한 영속화.
//!
//! 역할: 앱데이터의 `plugins/<id>/{manifest.json,main.js}`를 스캔해 설치 목록을 만들고,
//! 활성 여부와 **로컬** 권한 부여를 `plugins-state.json`(비동기화)에 저장한다. 폴더를
//! 복사하는 로컬 설치, 제거도 담당한다. 매니페스트는 서버(Rust)에서도 검증한다.
//! 왜: 권한 부여는 기기 기준이어야 하므로(동기화 데이터로 특권 상승 금지) 활성·부여 상태를
//! vault가 아닌 앱데이터에 두고, 신뢰할 수 없는 폴더를 로드 전에 구조적으로 검증한다.
//!
//! 네트워크(URL/Git) 설치는 [`crate::plugin_install`], vault 동기화 목록은
//! [`crate::plugin_sync`]가 담당한다 — 여기는 로컬 저장/상태의 코어만.

use crate::io::{read_to_string, write_atomic, write_atomic_bytes};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// `plugins-state.json`의 읽기-수정-쓰기를 직렬화하는 잠금.
///
/// 왜 필요한가: 이 모듈의 쓰기는 전부 **load_state → 한 칸 수정 → save_state**의 3단계다.
/// 이것을 감싸는 [`crate::plugin_commands`]의 커맨드들이 (메인 스레드를 놓아 주려고)
/// `#[tauri::command(async)]`가 되면서 서로 다른 스레드에서 진짜로 병행 실행된다 — 예전에는
/// 동기 커맨드라 메인 스레드가 자동으로 직렬화해 주던 보호가 사라진 것이다. 잠금이 없으면
/// 두 쓰기가 서로의 load 결과를 덮어써 **먼저 쓴 변경이 조용히 사라진다**(lost update).
/// 설정 창에서 토글을 빠르게 여러 개 켜는 것만으로 재현되는 모양이다.
///
/// 파일 단위가 아니라 모듈 단위 잠금인 이유는 [`crate::plugin_storage`]의 `STORAGE_LOCK`과
/// 같다 — 상태 파일은 하나뿐이고 작아 경합 비용이 무의미하다.
static STATE_LOCK: Mutex<()> = Mutex::new(());

/// [`STATE_LOCK`]을 잡고 `plugins-state.json`의 읽기-수정-쓰기 하나를 수행한다.
///
/// 읽기 전용 경로([`load_state`]·[`scan_installed`])는 잠그지 않는다: `write_atomic`이
/// rename으로 갈아 끼우므로 읽는 쪽은 **옛 파일 아니면 새 파일**을 보고 중간 상태를 보지 않는다.
///
/// 중독된 잠금도 그대로 이어 쓴다 — 각 쓰기가 파일 전체를 원자적으로 갈아 끼우므로
/// "반쯤 쓰다 만 상태"가 남지 않는다(`plugin_storage::with_storage_lock`과 같은 근거).
pub fn with_state_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// 플러그인 id 허용 형식(프론트 `manifest.ts`의 ID_RE와 동일: 소문자·숫자·`._-`, 첫 글자 영숫자).
fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// 우리가 아는 권한인지(프론트 `permissions.ts`와 동일 집합: 저위험·민감·`embed:`).
///
/// 역할: 서버 측 매니페스트 검증에서 미지의 권한을 거부한다(프론트 검증과 이중화).
/// 왜: 신뢰할 수 없는 폴더가 모르는 권한을 선언하면 설치/로드 전에 막는다.
fn is_known_permission(p: &str) -> bool {
    const LOW_RISK: [&str; 10] = [
        "commands",
        "ui",
        "editor",
        "settings",
        // 플러그인 전용 저장소(`memo.storage.*`). 프론트 `permissions.ts`의
        // LOW_RISK_PERMISSIONS와 **같은 집합**이어야 한다 — 한쪽만 알면 사이드로드 설치가
        // 백엔드에서 "알 수 없는 권한"으로 거부되고 번들만 동작하는 비대칭이 난다.
        "storage",
        "theme",
        "background",
        "font",
        "window-control",
        // 언어팩 선언(`contributes.translations`) — 이 권한만은 대응하는 브리지 호출이
        // 없다(언어팩은 런타임 등록 API가 아니라 매니페스트 데이터다). 수집 게이트는
        // `plugin_i18n.rs`의 `may_contribute_translations`가 건다.
        "i18n",
    ];
    const SENSITIVE: [&str; 8] = [
        "notes:read",
        // 전체 노트 컬렉션 읽기(`notes.list`/`notes.read`). 프론트 SENSITIVE_EXACT와
        // 같은 집합이어야 한다(drift-guards.test.ts가 대조).
        "notes:all-read",
        "notes:write",
        "vault:read",
        "vault:write",
        "clipboard",
        "windows",
        // 링크를 시스템 브라우저로 여는 권한. 프론트 SENSITIVE_EXACT와 같은 집합이어야
        // 한다(drift-guards.test.ts가 대조). 실제 스킴 제한은 `open_external_url`이 소유한다.
        "browser:open",
    ];
    // 네트워크는 `network:<도메인>` **접두 매칭** 민감 권한이다(`embed:<도메인>`과 같은 결).
    // 바 `network`는 SENSITIVE에서 빠졌다 — 프론트 `permissions.ts`의 `network:` 접두 처리와
    // 정확히 대칭이라야 한다(안 그러면 `network:api.example.com`이 백엔드 매니페스트 검증에서
    // "알 수 없는 권한"으로 거부돼 network.fetch가 통째로 막힌다).
    // 플러그인 간 호출은 `invoke:<대상 pluginId>` **접두 매칭** 민감 권한이다(`embed:`·
    // `network:`과 같은 결). 프론트 `permissions.ts`의 `invoke:` 접두 처리와 대칭이라야 한다 —
    // 안 그러면 호출측이 `invoke:target`을 선언한 사이드로드 플러그인이 "알 수 없는 권한"으로
    // 매니페스트째 거부돼, 대상의 `exposes`를 배선해도 설치 경로에서 여전히 죽는다.
    LOW_RISK.contains(&p)
        || SENSITIVE.contains(&p)
        || p.starts_with("embed:")
        || p.starts_with("network:")
        || p.starts_with("invoke:")
}

/// 플러그인이 매니페스트로 선언하는 설정 필드 하나(호스트가 폼으로 렌더한다).
///
/// 역할: "이 플러그인은 어떤 설정을 가진다"를 선언형으로 표현한다 — 키·라벨·위젯 종류
/// (text/toggle/select)·기본값·(select) 선택지. 호스트가 이 스키마로 설정 폼을 그리고 값을
/// 영속화하며, 플러그인은 샌드박스에서 `memo.settings.get/set`으로 값만 읽고 쓴다.
/// 왜: 샌드박스 플러그인은 호스트 DOM을 못 그리므로, 설정 UI를 선언형 스키마로 위임한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginSettingField {
    /// 저장 키(값 맵·UI 입력의 식별자). `[A-Za-z0-9_]+`.
    pub key: String,
    /// UI 라벨(설정 폼에 보이는 이름).
    pub label: String,
    /// 위젯 종류: `text` | `textarea` | `toggle` | `select` | `list` | `number` | `button`.
    #[serde(rename = "type")]
    pub kind: String,
    /// 기본값(text/list→문자열, toggle→불리언, number→수, select→options의 value 중 하나).
    /// 미지정이면 타입 기본값.
    #[serde(default)]
    pub default: serde_json::Value,
    /// `select`의 선택지(그 외 타입은 빈 배열). 문자열 축약형과 객체형이 섞일 수 있다.
    #[serde(default)]
    pub options: Vec<PluginSettingOption>,
    /// `number` 전용: 하한(선택).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// `number` 전용: 상한(선택).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// `number` 전용: 스피너 증감 폭(선택 — 표시 전용).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    /// 제목 아래에 보일 도움말(선택 — 예: 사용 가능한 치환 변수 안내). 미지정이면 없음.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// text/textarea 전용: 입력 placeholder(선택).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// list 전용: 한 항목의 단수 명칭(추가 버튼·빈 상태 문구, 선택).
    #[serde(rename = "itemLabel", default, skip_serializing_if = "Option::is_none")]
    pub item_label: Option<String>,
    /// list 전용: 항목 이름 input placeholder(선택).
    #[serde(
        rename = "itemNamePlaceholder",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub item_name_placeholder: Option<String>,
    /// list 전용: 항목 본문 textarea placeholder(선택).
    #[serde(
        rename = "itemBodyPlaceholder",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub item_body_placeholder: Option<String>,
    /// list 전용: 본문에 삽입 가능한 키워드 칩(선택).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<PluginSettingHint>,
    /// `button` 전용(필수): 누르면 실행할 명령 id(`memo.commands.register`가 등록한 것).
    ///
    /// 왜 콜백이 아니라 id인가: 설정 버튼과 단축키가 **같은 역호출 경로**를 타게 하기 위함이다.
    /// 프론트 `PluginSettingField.command`와 같은 이름·같은 규칙(비면 매니페스트 거부).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// `button` 전용(선택): 실행 전에 설정 창이 띄울 확인 문구.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
}

/// `select` 선택지 하나 — 문자열 축약형과 `{value,label,description?}` 객체형 둘 다 허용한다.
///
/// 역할: 저장 값(`value`)과 표시 문구(`label`)를 분리한다. 축약형 `"라벨"`은
/// `{ value: "라벨", label: "라벨" }`의 줄임으로 **재해석**하므로 기존 매니페스트는 무변경으로
/// 유효하다((A)안 — 되돌리는 비용을 싸게 유지하는 핵심).
/// 왜: 예전에는 저장 값이 곧 표시 라벨이라, 라벨을 다듬는 순간 저장된 값이 고아가 되고
/// 플러그인이 한국어 라벨↔코드값 매핑 테이블을 스스로 들어야 했다.
///
/// `untagged`인 이유: 직렬화가 입력 형태를 그대로 보존한다(축약형은 문자열로 다시 나간다) —
/// 프론트가 받는 매니페스트가 저작자가 쓴 것과 같은 모양이라 왕복이 안전하다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginSettingOption {
    /// 축약형 — 값과 라벨이 같다.
    Short(String),
    /// 정본 — 값과 라벨을 분리한다.
    Full {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

impl PluginSettingOption {
    /// 저장·비교에 쓰는 값(축약형은 문자열 자신).
    pub fn value(&self) -> &str {
        match self {
            Self::Short(s) => s,
            Self::Full { value, .. } => value,
        }
    }
}

/// list 설정의 키워드 칩 하나(토큰 + 선택적 라벨).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginSettingHint {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// 매니페스트 `kind` — 능력 등록 가능 여부. 미선언은 "action"으로 간주(하위호환).
/// TS `manifest.ts`의 `PluginKind`와 동형.
pub type PluginKind = String;

/// 검증된 플러그인 매니페스트(서버 측). 프론트 `PluginManifest`와 필드 일치.
///
/// 새 필드(summary 이후)는 전부 선택이다 — 없으면 기존 동작 그대로(하위호환). 필드
/// 전수는 `docs/plugin/manifest.schema.json`이 정본이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 지원 OS 목록(선택 — 없으면 전 플랫폼). 미지원 OS에서는 프론트가 자동 비활성화한다.
    #[serde(default)]
    pub platforms: Vec<String>,
    /// 목록 부제로 쓰는 한 줄 요약(선택). 이전엔 이 구조체에 필드 자체가 없어
    /// 사이드로드 플러그인의 목록 부제가 항상 비었다(번들만 프론트 별도 경로로 summary를 읽음).
    /// 소비처는 프론트 `settings.ts`의 `renderPluginList`(목록 행 부제)·`detailFromInstalled`
    /// (상세 뷰 부제)다 — 여기서 실어 보내도 그쪽 선언(`shared/tauri.ts`)이 없으면 IPC
    /// 경계에서 통째로 버려진다(실제로 한 번 그랬다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 선언형 설정 스키마(선택 — 없으면 빈 배열, 설정 UI 미노출).
    #[serde(default)]
    pub settings: Vec<PluginSettingField>,
    /// 설정 트리에서 이 플러그인의 페이지를 묶을 카테고리(선택). 없으면 프론트가 기본 그룹에 둔다.
    #[serde(default)]
    pub settings_category: Option<String>,
    /// 설정 페이지 상단에 보일 소개 문구(선택 — 페이지 제목 아래 설명).
    #[serde(
        rename = "settingsDescription",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub settings_description: Option<String>,
    /// 능력 등록(theme/background/font/window.register) 가능 여부 — "capability" |
    /// "action". 미선언은 "action"으로 간주(게이트 판정은 host.ts 소관 — 여기선 형식만 검증).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PluginKind>,
    /// 이 매니페스트가 요구하는 최소 memo 앱 버전(semver) — 설치 화면 게이트용.
    #[serde(
        rename = "minHostVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub min_host_version: Option<String>,
    /// 이 플러그인이 하는 일 한 줄(80자 이내, 자기신고) — 승인 화면 상단 표시.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// 노출 능력·설정 키·예시 호출 요약 마크다운(2000자 이내, 자기신고).
    #[serde(
        rename = "llmContext",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub llm_context: Option<String>,
    /// 권한별 보조 설명(선택, 자기신고, 값 200자 이내) — 고정 경고문 아래 병기.
    #[serde(
        rename = "permissionReasons",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub permission_reasons: BTreeMap<String, String>,
    /// JS 없이 매니페스트만으로 하는 선언형 등록(`contributes`).
    ///
    /// 값을 **해석하지 않고 원문 그대로** 나른다: 항목 하나하나의 규칙(인라인 패턴의
    /// open/close, 임베드의 소스 룰 등)은 프론트의 registrar가 이미 소유하고 있고, 그 규칙을
    /// Rust에 복사하면 두 벌이 갈라진다. 여기서 하는 것은 **형태 검증**뿐이다
    /// ([`parse_contributes`] — 객체인가, 아는 종류가 배열인가). 그래서 타입이
    /// `serde_json::Value`다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<serde_json::Value>,
    /// 다른 플러그인에 **공개**할 명령 id 목록(선택 — 기본 비공개). `commands.invoke`의
    /// 릴레이가 "대상이 이 명령을 열었는가"를 판정하는 원천이다. `contributes`·`llm_context`와
    /// 똑같은 결함을 피하려 여기 담는다: 이 필드가 없으면 사이드로드(설치) 플러그인의 공개가
    /// IPC 경계에서 통째로 버려져 `commands.invoke`가 항상 `INVOKE_NOT_EXPOSED`로 거부됐다
    /// (번들만 멀쩡한 비대칭). TS `manifest.ts`의 `exposes`와 동일 규칙으로 검증한다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exposes: Vec<String>,
    /// 저작자 자기 로컬라이즈 사전(축 2, 선택) — 로케일 코드(또는 `"default"`) → {키→문장}.
    ///
    /// `contributes`와 같은 이유로 **해석하지 않고 원문 그대로** 나른다: `%키%` 해석은
    /// 프론트 `plugin/manifest.ts`의 `resolveInstalledPluginNls`가 파싱 직후 한 번 한다(활성
    /// 로케일은 창마다 다르므로 백엔드가 특정 로케일로 미리 구워 보낼 수 없다). 여기서 하는
    /// 것은 [`parse_nls`]의 형태 검증뿐이다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nls: Option<serde_json::Value>,
}

/// 설정 키 허용 형식(비어있지 않고 영숫자·`_`만, camelCase 허용) + JS 예약 키 거부.
///
/// 왜: 값 맵이 결국 JS 객체(`values[key] = ...`)에 쓰이므로 `__proto__`/`constructor`/`prototype`
/// 같은 키는 프로토타입 오염 여지를 만든다 — 매니페스트 선언 시점에서 아예 막는다(프론트도
/// 방어하지만 유일 진실 출처인 선언 게이트에서 차단하는 게 근본적).
fn is_valid_setting_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(key, "__proto__" | "constructor" | "prototype")
}

/// 매니페스트의 `settings`(알 수 없는 입력)를 검증해 [`PluginSettingField`] 목록으로 만든다.
///
/// 역할: 배열 여부·각 필드(key 형식·label·type∈{text,textarea,toggle,select}·select의 options)를 확인한다.
/// 왜: 신뢰할 수 없는 스키마가 설정 UI에 새지 않게 매니페스트 검증 시점에 형태를 못박는다
/// (권한 검증과 동일하게 위반 시 매니페스트 전체를 거부).
fn parse_settings_schema(
    value: Option<&serde_json::Value>,
) -> Result<Vec<PluginSettingField>, String> {
    use serde_json::Value;
    let arr = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("settings가 배열이 아님".to_string()),
    };
    let get_str = |o: &serde_json::Map<String, Value>, k: &str| -> Result<String, String> {
        o.get(k)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("설정 {k} 누락 또는 형식 오류"))
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let o = item.as_object().ok_or("설정 항목이 객체가 아님")?;
        let key = get_str(o, "key")?;
        if !is_valid_setting_key(&key) {
            return Err(format!("설정 key 형식 오류: {key}"));
        }
        let label = get_str(o, "label")?;
        let kind = get_str(o, "type")?;
        if !matches!(
            kind.as_str(),
            "text" | "toggle" | "select" | "textarea" | "list" | "number" | "button"
        ) {
            return Err(format!("알 수 없는 설정 type: {kind}"));
        }
        let options = match o.get("options") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(opts)) => opts
                .iter()
                .map(|op| match op {
                    // 축약형 — `{value: s, label: s}`의 줄임(기존 매니페스트 무변경).
                    Value::String(s) => Ok(PluginSettingOption::Short(s.clone())),
                    // 정본 — value 필수(저장 값), label·description은 선택.
                    Value::Object(oo) => {
                        let value = oo
                            .get("value")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "설정 options 항목에 value가 없음".to_string())?
                            .to_string();
                        Ok(PluginSettingOption::Full {
                            value,
                            label: oo.get("label").and_then(Value::as_str).map(str::to_string),
                            description: oo
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                    }
                    _ => Err("설정 options 항목이 문자열도 객체도 아님".to_string()),
                })
                .collect::<Result<Vec<_>, String>>()?,
            Some(_) => return Err("설정 options가 배열이 아님".to_string()),
        };
        if kind == "select" && options.is_empty() {
            return Err(format!("select 설정 '{key}'에 options가 필요함"));
        }
        let opt_str = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        // button은 `command`가 없으면 눌러도 아무 일이 없는 버튼이 폼에 뜬다 — 무음 실패를
        // 만들지 않기 위해 매니페스트를 통째로 거부한다(프론트 `parseSettingsSchema`와 같은 규칙).
        if kind == "button" && opt_str("command").is_none_or(|c| c.trim().is_empty()) {
            return Err(format!(
                "button 설정 '{key}'에 command(실행할 명령 id)가 필요함"
            ));
        }
        let opt_num = |k: &str| o.get(k).and_then(Value::as_f64);
        let hints = match o.get("hints") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|h| {
                    let ho = h.as_object().ok_or("hints 항목이 객체가 아님")?;
                    let token = ho
                        .get("token")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or("hints token 누락 또는 형식 오류")?;
                    Ok(PluginSettingHint {
                        token,
                        label: ho.get("label").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            Some(_) => return Err("hints가 배열이 아님".to_string()),
        };
        out.push(PluginSettingField {
            key,
            label,
            kind,
            default: o.get("default").cloned().unwrap_or(Value::Null),
            options,
            min: opt_num("min"),
            max: opt_num("max"),
            step: opt_num("step"),
            description: opt_str("description"),
            placeholder: opt_str("placeholder"),
            item_label: opt_str("itemLabel"),
            item_name_placeholder: opt_str("itemNamePlaceholder"),
            item_body_placeholder: opt_str("itemBodyPlaceholder"),
            hints,
            command: opt_str("command"),
            confirm: opt_str("confirm"),
        });
    }
    Ok(out)
}

/// 신뢰할 수 없는 manifest.json 원문을 검증해 [`PluginManifest`]로 만든다.
///
/// 역할: 필수 필드·id 형식·알려진 권한을 확인한다(프론트 `parseManifest`와 동일 규칙).
/// 왜: 설치/스캔 시 형식 오류·미지의 권한을 가진 매니페스트를 로드 전에 거부한다.
pub fn parse_manifest(raw: &str) -> Result<PluginManifest, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("매니페스트 JSON 파싱 실패: {e}"))?;
    let obj = value.as_object().ok_or("매니페스트가 객체가 아님")?;

    let get_str = |key: &str| -> Result<String, String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{key} 누락 또는 형식 오류"))
    };

    let id = get_str("id")?;
    if !is_valid_id(&id) {
        return Err("id 형식 오류".to_string());
    }
    let name = get_str("name")?;
    let version = get_str("version")?;
    // version은 semver 접두 형식(주.부.수로 시작)을 강제한다 — 이 관문(`parse_manifest`)은
    // 설치·스캔·로드 전 경로(`install_from_dir`·`scan_installed_report`·`read_plugin_code`·
    // `set_granted` 등)가 공용으로 지나므로, 여기서 강제하면 모든 경로가 대칭으로 강제된다.
    // 출시 전이라 이미 설치된 비-semver 플러그인을 보호할 이유가 없다(TS `manifest.ts`와 대칭).
    if !is_semver_prefixed(&version) {
        return Err("version이 semver 형식이 아님(예: 1.0.0)".to_string());
    }
    let entry = get_str("entry")?;
    // entry는 플러그인 디렉터리 내 단순 파일명이어야 한다 — 경로 구분자/상위 이동이 있으면
    // 스캔·코드 읽기·설치가 디렉터리 밖 파일을 가리킬 수 있어 한 지점에서 막는다(경로 탈출 차단).
    if entry.is_empty() || entry.contains('/') || entry.contains('\\') || entry.contains("..") {
        return Err("entry 경로가 올바르지 않음".to_string());
    }

    let permissions = match obj.get("permissions") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let p = item.as_str().ok_or("권한 항목이 문자열이 아님")?;
                if !is_known_permission(p) {
                    return Err(format!("알 수 없는 권한: {p}"));
                }
                out.push(p.to_string());
            }
            out
        }
        Some(_) => return Err("permissions가 배열이 아님".to_string()),
    };

    // platforms(선택) — 문자열 배열만 취한다. 미지의 OS 이름은 거부하지 않는다(전방 호환 —
    // 미래 OS를 선언한 플러그인이 현재 빌드의 파싱을 깨지 않게; 지원 판정은 프론트 platform.ts).
    let platforms = match obj.get("platforms") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let p = item.as_str().ok_or("platforms 항목이 문자열이 아님")?;
                out.push(p.to_string());
            }
            out
        }
        Some(_) => return Err("platforms가 배열이 아님".to_string()),
    };

    let settings = parse_settings_schema(obj.get("settings"))?;
    // 설정 트리 카테고리(선택) — 문자열만 취하고, 그 외(숫자·객체 등)는 무시(없음으로).
    // 카멜 케이스(settingsCategory)만 받는다 — 저자 문서(docs/plugin/authoring.md)와 번들
    // 매니페스트(builtin/plugins/*/manifest.json)가 전부 카멜을 쓴다. 스네이크(settings_category)
    // 폴백은 없다(출시 전, 그 이름으로 배포된 플러그인이 존재하지 않는다).
    let settings_category = obj
        .get("settingsCategory")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let settings_description = obj
        .get("settingsDescription")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // summary(선택) — 문자열만. 이전엔 이 구조체에 필드가 없어 사이드로드 목록
    // 부제가 항상 비었다(TS `manifest.ts`가 이제 동일 규칙으로 읽는다).
    let summary = match obj.get("summary") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("summary가 문자열이 아님".to_string()),
    };

    // kind(선택) — "capability" | "action"만. 게이트 판정 자체는 host.ts 소관, 여기선
    // 형식만 검증한다(미지의 값을 가진 매니페스트를 로드 전에 거부).
    let kind = match obj.get("kind") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if s == "capability" || s == "action" => Some(s.clone()),
        Some(v) => return Err(format!("알 수 없는 kind: {v}")),
    };

    // minHostVersion(선택) — semver 접두 형식만(주.부.수로 시작). 강제(설치 게이트)는
    // 이 함수의 책임이 아니다 — 프론트 install-flow.ts가 앱 버전과 비교해 판단한다.
    let min_host_version = match obj.get("minHostVersion") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if is_semver_prefixed(s) => Some(s.clone()),
        Some(_) => return Err("minHostVersion이 semver 형식이 아님".to_string()),
    };

    // purpose(선택) — 80자(문자 단위) 이내.
    let purpose = match obj.get("purpose") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if s.chars().count() <= 80 => Some(s.clone()),
        Some(serde_json::Value::String(_)) => return Err("purpose가 80자를 초과함".to_string()),
        Some(_) => return Err("purpose가 문자열이 아님".to_string()),
    };

    // llmContext(선택) — 2000자(문자 단위) 이내.
    let llm_context = match obj.get("llmContext") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if s.chars().count() <= 2000 => Some(s.clone()),
        Some(serde_json::Value::String(_)) => {
            return Err("llmContext가 2000자를 초과함".to_string())
        }
        Some(_) => return Err("llmContext가 문자열이 아님".to_string()),
    };

    // permissionReasons(선택) — 문자열 값 맵, 각 값 200자 이내.
    let permission_reasons = match obj.get("permissionReasons") {
        None | Some(serde_json::Value::Null) => BTreeMap::new(),
        Some(serde_json::Value::Object(map)) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                let s = v
                    .as_str()
                    .ok_or_else(|| format!("permissionReasons['{k}']가 문자열이 아님"))?;
                if s.chars().count() > 200 {
                    return Err(format!("permissionReasons['{k}']가 200자를 초과함"));
                }
                out.insert(k.clone(), s.to_string());
            }
            out
        }
        Some(_) => return Err("permissionReasons가 객체가 아님".to_string()),
    };

    // contributes(선택) — 형태만 검증하고 원문을 그대로 나른다.
    let contributes = parse_contributes(obj.get("contributes"))?;

    // exposes(선택) — 다른 플러그인에 공개할 명령 id 배열. 각 항목이 비어있지 않은
    // 문자열이어야 한다. 명령 id는 형식이 고정돼 있지 않아 형식은 강제하지 않는다(비공개가
    // 기본이라 잘못 적어도 그 명령이 안 열릴 뿐). TS `manifest.ts`와 **같은 규칙**(대칭 검증 —
    // 한쪽만 거부하면 "CLI는 통과인데 설치가 거부된다"가 난다).
    let exposes = match obj.get("exposes") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                match item.as_str() {
                    Some(s) if !s.is_empty() => out.push(s.to_string()),
                    _ => return Err("exposes 항목이 비어있지 않은 문자열이 아님".to_string()),
                }
            }
            out
        }
        Some(_) => return Err("exposes가 배열이 아님".to_string()),
    };

    // nls(선택, 축 2) — 형태만 검증하고 원문을 그대로 나른다(해석은 프론트 소관).
    let nls = parse_nls(obj.get("nls"))?;

    Ok(PluginManifest {
        id,
        name,
        version,
        entry,
        permissions,
        platforms,
        summary,
        settings,
        settings_category,
        settings_description,
        kind,
        min_host_version,
        purpose,
        llm_context,
        permission_reasons,
        contributes,
        exposes,
        nls,
    })
}

/// 매니페스트가 선언형으로 등록할 수 있는 기여 종류 — TS `manifest.ts`의
/// `CONTRIBUTION_KINDS`와 **같은 집합**이어야 한다(한쪽만 알면 "CLI는 통과인데 설치가
/// 거부된다"가 난다).
const CONTRIBUTION_KINDS: [&str; 5] = [
    "inlinePatterns",
    "completions",
    "blockEmbeds",
    "windowControls",
    // 언어팩 선언(`{locale,label,entries}` 객체 배열) — windowControls와 같은 이유로
    // 등록 순서에 의존하지 않는다(병합 키가 로케일 코드). 이 종류만은 프론트
    // `CONTRIBUTION_CALLS`에 대응 호출이 없다(코어가 직접 읽는다 — `plugin_i18n.rs`)
    // 그래서 TS 쪽 대조 상대는 `CONTRIBUTION_KINDS`다.
    "translations",
];

/// `contributes` 블록의 **형태만** 검증한다 — 통과하면 원문을 그대로 돌려준다.
///
/// 역할: 객체인지, 아는 종류가 배열인지, 그 항목이 (windowControls는 문자열/나머지는 객체)
/// 맞는지까지만 본다. 항목 내부 규칙은 프론트 registrar가 소유한다 — 여기 복사하면 두 벌이
/// 갈라지고, 그 드리프트가 원래 없애려던 바로 그것이다.
/// 왜 모르는 종류를 거부하지 않는가: 스키마의 전방 호환 정책("모르는 필드는 무시")과 같은
/// 이유다 — 구버전 앱이 신버전 플러그인을 통째로 못 읽게 되는 쪽이 더 나쁘다. 대신 프론트가
/// 진단으로, CLI가 오류로 표면화한다(무시하되 침묵하지는 않는다).
fn parse_contributes(raw: Option<&serde_json::Value>) -> Result<Option<serde_json::Value>, String> {
    let value = match raw {
        None | Some(serde_json::Value::Null) => return Ok(None),
        Some(v) => v,
    };
    let obj = value
        .as_object()
        .ok_or_else(|| "contributes가 객체가 아님".to_string())?;
    for (kind, items) in obj {
        if !CONTRIBUTION_KINDS.contains(&kind.as_str()) {
            continue; // 모르는 종류 — 전방 호환으로 통과(표면화는 프론트·CLI 몫).
        }
        let arr = items
            .as_array()
            .ok_or_else(|| format!("contributes.{kind}가 배열이 아님"))?;
        for item in arr {
            let ok = if kind == "windowControls" {
                item.is_string()
            } else {
                item.is_object()
            };
            if !ok {
                return Err(if kind == "windowControls" {
                    "contributes.windowControls 항목이 문자열이 아님".to_string()
                } else {
                    format!("contributes.{kind} 항목이 객체가 아님")
                });
            }
        }
    }
    Ok(Some(value.clone()))
}

/// `nls`(축 2, 알 수 없는 입력)의 **형태만** 검증한다 — 통과하면 원문을 그대로 돌려준다.
///
/// 역할: 객체인지, 각 로케일 값이 객체인지, 그 leaf가 전부 문자열인지만 본다(콘텐츠는
/// 검증하지 않는다 — `%키%` 해석은 프론트 소관). `nls`를 선언했다면 `"default"` 사전이
/// **필수**다(없으면 %키%가 활성 로케일에 없을 때 기댈 곳이 없다). TS `manifest.ts`의
/// `parseNls`와 같은 규칙(대칭 검증).
fn parse_nls(raw: Option<&serde_json::Value>) -> Result<Option<serde_json::Value>, String> {
    let value = match raw {
        None | Some(serde_json::Value::Null) => return Ok(None),
        Some(v) => v,
    };
    let obj = value
        .as_object()
        .ok_or_else(|| "nls가 객체가 아님".to_string())?;
    for (locale, dict) in obj {
        let dict_obj = dict
            .as_object()
            .ok_or_else(|| format!("nls['{locale}']가 객체가 아님"))?;
        for (key, v) in dict_obj {
            if !v.is_string() {
                return Err(format!("nls['{locale}']['{key}']가 문자열이 아님"));
            }
        }
    }
    if !obj.contains_key("default") {
        return Err("nls를 선언하면 'default' 사전이 필수".to_string());
    }
    Ok(Some(value.clone()))
}

/// 문자열이 "주.부.수"로 시작하는지(자유 형식 접미사는 허용) — `version`/`minHostVersion`의
/// semver 접두 검증 공통 규칙(TS `manifest.ts`의 `SEMVER_PREFIX_RE`와 동일).
fn is_semver_prefixed(s: &str) -> bool {
    let mut parts = s.splitn(4, '.');
    let is_digits =
        |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    // 세 번째 조각은 숫자 접두만 있으면 된다(예: "1.2.3-beta"의 "3-beta"에서 "3"까지).
    let major_minor_ok = is_digits(parts.next()) && is_digits(parts.next());
    let patch_ok = parts
        .next()
        .is_some_and(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit()));
    major_minor_ok && patch_ok
}

/// 플러그인 설치 출처 — 어디서 왔는지(재설치·업데이트 확인의 근거).
///
/// 역할: 로컬 상태와 vault 참조 목록(`installed-plugins.json`)에 같은 형태로 기록돼,
/// 다른 기기가 [설치]로 같은 출처에서 다시 받아올 수 있게 한다.
/// `Local`은 원본 경로를 기록하지 않아 다른 기기에서 가져올 수 없다(재조정 시 "코드 없음" 안내).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PluginSource {
    /// https zip 아카이브 다운로드.
    Url { url: String },
    /// git 저장소 클론(선택적 브랜치/태그/커밋 ref — 버전 핀).
    Git {
        url: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    /// 로컬 폴더 사이드로드.
    Local,
}

/// 한 플러그인의 로컬 상태(활성 여부 + 로컬 권한 부여 + 설정 값 + 설치 출처).
/// **동기화되지 않는다.**
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PluginRecord {
    #[serde(default)]
    pub enabled: bool,
    /// 로컬에서 사용자가 승인한 민감 권한(기기 기준 — 동기화 데이터로 들어오지 않음).
    #[serde(default)]
    pub granted: Vec<String>,
    /// 플러그인 설정 값(선언된 스키마 키만 유효). 사용자가 폼에서 바꾸거나 플러그인이 저장한다.
    #[serde(default)]
    pub settings: BTreeMap<String, serde_json::Value>,
    /// 설치 시점의 버전(참조용 — 설치된 코드의 진실은 매니페스트).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 설치 출처(업데이트 확인·vault 목록 기록의 근거). 없으면 Local로 간주(구버전 상태 파일).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PluginSource>,
    /// 승인 시점엔 예약(미구현)이라 부여하지 못하고 "선언은 했다"만 기억해 둔 민감
    /// 권한. 예약이 풀리는 시점은 Rust가 모른다(예약 여부는 TS `host.ts`의
    /// `PERMISSION_RESERVED` 소관) — 그래서 이 필드는 순수 저장소이고, "지금도 예약인가"
    /// 판정과 재승인 배너는 프론트(install-flow.ts)가 한다. [`set_pending_reserved`] 참고.
    #[serde(
        rename = "pendingReserved",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub pending_reserved: Vec<String>,
}

/// 설치된 모든 플러그인의 로컬 상태(`plugins-state.json`). id → 레코드.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PluginsState {
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginRecord>,
    /// 빌트인(번들) 플러그인 활성 상태(id→enabled). 기록 없으면 기본 켜짐. 설치와 분리 저장한다
    /// (번들은 디렉터리가 없고 기본이 켜짐이라 설치 플러그인과 의미가 반대다).
    #[serde(default)]
    pub builtins: BTreeMap<String, bool>,
    /// 빌트인(번들) 플러그인 설정 값(id → key → value). 번들은 디스크 매니페스트가 없어
    /// 선언 스키마는 프론트(builtin.ts)에 있고 여기선 값만 저장한다(키 형식만 검증).
    #[serde(default)]
    pub builtin_settings: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
    /// 재조정 안내에서 "무시"를 누른 vault 목록 항목 id(이 기기에서 다시 보이지 않음).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissed_missing: Vec<String>,
}

/// 프론트로 보내는 설치 플러그인 한 건(매니페스트 + 로컬 상태 병합 결과).
///
/// 신규 필드는 전부 매니페스트 선택 필드를 그대로 반영한 것이거나
/// (summary/kind/min_host_version/purpose/llm_context/permission_reasons) 로컬
/// 상태 필드(pending_reserved) — 구버전 프론트가 이 필드들을 몰라도 나머지 필드로 기존처럼
/// 동작한다(하위호환 추가).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    /// 매니페스트가 선언한 지원 OS(없으면 전 플랫폼). 프론트가 OS 배지·자동 비활성에 쓴다.
    pub platforms: Vec<String>,
    pub enabled: bool,
    /// 로컬에서 부여된 권한(프론트가 grant.granted로 사용).
    pub granted: Vec<String>,
    /// 매니페스트가 선언한 설정 스키마(비면 설정 UI를 노출하지 않음).
    pub settings_schema: Vec<PluginSettingField>,
    /// 현재 설정 값(선언 스키마 키로 한정 — 없는 키는 스키마 기본값으로 채움).
    pub settings: BTreeMap<String, serde_json::Value>,
    /// 설정 트리 카테고리(매니페스트 선언 — 없으면 프론트가 기본 그룹에 둔다).
    pub settings_category: Option<String>,
    /// 설정 페이지 상단 소개 문구(매니페스트 선언 — 선택).
    pub settings_description: Option<String>,
    /// 설치 출처(URL/git이면 설정 UI가 "업데이트 확인"을 제공).
    pub source: PluginSource,
    /// 목록 부제로 쓰는 한 줄 요약(매니페스트 선언 — 선택).
    #[serde(default)]
    pub summary: Option<String>,
    /// 능력/액션 구분(매니페스트 선언 — 선택). None은 "action"과 동치.
    #[serde(default)]
    pub kind: Option<PluginKind>,
    /// 요구하는 최소 memo 앱 버전(매니페스트 선언 — 선택).
    #[serde(rename = "minHostVersion", default)]
    pub min_host_version: Option<String>,
    /// 이 플러그인이 하는 일 한 줄(매니페스트 선언 — 선택).
    #[serde(default)]
    pub purpose: Option<String>,
    /// 노출 능력·설정 키·예시 호출 요약 마크다운(매니페스트 선언 — 선택, 자기신고).
    ///
    /// `purpose`와 같은 이유로 여기 실어 보낸다 — `PluginManifest`엔 이미 있었지만 이 구조체가
    /// 옮겨 담지 않아 사이드로드 플러그인의 `llmContext`가 프론트에 닿기 전에 사라졌다
    /// (`summary`가 정확히 그 이유로 한 번 사라진 전례와 같은 결함).
    #[serde(
        rename = "llmContext",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub llm_context: Option<String>,
    /// 권한별 보조 설명(매니페스트 선언 — 선택, 자기신고). 승인 화면이 권한 행 옆에
    /// 병기한다. 위 `llm_context`와 같은 이유로 여기 옮겨 담는다.
    #[serde(
        rename = "permissionReasons",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub permission_reasons: BTreeMap<String, String>,
    /// 아직 예약(미구현)이라 부여하지 않은 채 기억해 둔 민감 권한(`pendingReserved`).
    /// 예약이 풀리면 설정 창이 이 목록으로 "방금 사용 가능해짐" 재승인 배너를 띄운다.
    #[serde(rename = "pendingReserved", default)]
    pub pending_reserved: Vec<String>,
    /// 매니페스트가 선언한 기여(선택). 프론트는 이 값을 그대로 registrar에 넣는다.
    ///
    /// 여기 실어 보내지 않으면 설치(사이드로드) 플러그인만 `contributes`가 통째로 무시된다:
    /// 백엔드는 매니페스트 원문이 아니라 **펼친 레코드**를 보내므로 이 필드가 유일한 통로다
    /// (`summary`가 정확히 그 이유로 한 번 사라졌다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<serde_json::Value>,
    /// 매니페스트가 다른 플러그인에 공개한 명령 id들(선택). 프론트 `loader.ts`가 이 값을
    /// `commands.invoke` 릴레이의 공개 판정(`exposesOf`)에 그대로 넣는다.
    ///
    /// `contributes`와 같은 이유로 이 구조체가 옮겨 담아야 한다 — 백엔드는 매니페스트 원문이
    /// 아니라 **펼친 레코드**를 보내므로 이 필드가 유일한 통로다. 실어 보내지 않으면 설치
    /// (사이드로드) 플러그인의 명령 공개가 조용히 죽어 `commands.invoke`가 항상
    /// `INVOKE_NOT_EXPOSED`로 거부된다(`summary`가 정확히 그 이유로 한 번 사라진 전례와 같은 결함).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exposes: Vec<String>,
    /// 매니페스트가 선언한 자기 로컬라이즈 사전(축 2 — 선택). `contributes`·`exposes`와 같은
    /// 이유로 이 구조체가 옮겨 담아야 한다 — 실어 보내지 않으면 설치(사이드로드) 플러그인의
    /// `%키%`가 프론트 `resolveInstalledPluginNls`에 닿기 전에 사라진다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nls: Option<serde_json::Value>,
}

/// serde 직렬화 실패를 io 오류로 변환한다.
fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// 플러그인 루트 디렉터리(`<app_data>/plugins`).
pub fn plugins_dir(app_data: &Path) -> PathBuf {
    app_data.join("plugins")
}

/// 한 플러그인의 디렉터리(`<app_data>/plugins/<id>`).
fn plugin_dir(app_data: &Path, id: &str) -> PathBuf {
    plugins_dir(app_data).join(id)
}

/// 로컬 상태 파일 경로(`<app_data>/plugins-state.json`).
pub fn state_path(app_data: &Path) -> PathBuf {
    app_data.join("plugins-state.json")
}

/// 로컬 상태를 읽는다. 파일이 없거나 깨졌으면 빈 상태(모두 비활성).
pub fn load_state(app_data: &Path) -> PluginsState {
    read_to_string(&state_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 로컬 상태를 원자적으로 쓴다(사람이 읽기 쉬운 pretty JSON).
pub fn save_state(app_data: &Path, state: &PluginsState) -> io::Result<()> {
    let json = serde_json::to_string_pretty(state).map_err(to_io)?;
    write_atomic(&state_path(app_data), &json)
}

/// 부여 목록을 선언된 권한 ∩ 부여 권한으로 좁힌다(선언에 없는 부여는 버린다).
///
/// 역할: 매니페스트가 바뀌어 더는 선언하지 않는 권한이 상태에 남아도 새지 않게 한다.
/// 왜: "선언 + 로컬 부여"가 민감 권한의 조건이므로, 부여는 항상 현재 선언의 부분집합이어야 한다.
fn sanitize_granted(declared: &[String], granted: &[String]) -> Vec<String> {
    granted
        .iter()
        .filter(|g| declared.contains(g))
        .cloned()
        .collect()
}

/// 설정 필드의 기본값을 정한다(default 지정이 있으면 그것, 없으면 타입별 기본).
///
/// 왜: 저장된 값이 없어도 폼·플러그인이 항상 유효한 값을 받도록 타입에 맞는 기본을 준다.
/// 프론트 `shared/plugin-settings.ts`의 `settingDefault`와 **같은 규칙**이다(설치 경로는 이
/// 함수가, 번들 경로는 그쪽이 채운다 — 두 경로가 같은 값을 봐야 한다. 대조는 TS 가드 테스트).
fn default_setting_value(field: &PluginSettingField) -> serde_json::Value {
    use serde_json::Value;
    if !field.default.is_null() {
        return field.default.clone();
    }
    match field.kind.as_str() {
        "toggle" => Value::Bool(false),
        // number: min이 있으면 그 하한이 기본(0이 범위 밖일 수 있다), 없으면 0.
        "number" => serde_json::Number::from_f64(field.min.unwrap_or(0.0))
            .map(Value::Number)
            .unwrap_or_else(|| Value::Number(0.into())),
        // select: 첫 선택지의 **값**(라벨이 아니다 — 저장 값은 언제나 value다).
        "select" => Value::String(
            field
                .options
                .first()
                .map(|o| o.value().to_string())
                .unwrap_or_default(),
        ),
        _ => Value::String(String::new()), // text/textarea/list
    }
}

/// 저장된 값을 스키마로 정규화한다(선언 키만, 없는 키는 기본값으로 채움).
///
/// 역할: 프론트로 보내는 설정 값이 항상 "선언된 모든 키 = 유효한 값" 형태가 되게 한다.
/// 왜: 스키마가 바뀌어 상태에 남은 옛 키는 버리고(부여 좁히기와 같은 원칙), 새 키는 기본값으로
/// 채워 설정 폼과 플러그인 `settings.get`이 결측 없이 동작하게 한다.
fn resolve_settings(
    schema: &[PluginSettingField],
    values: &BTreeMap<String, serde_json::Value>,
) -> BTreeMap<String, serde_json::Value> {
    schema
        .iter()
        // button은 **값이 없는 필드**다 — 누르는 것이 전부다. 여기서 빈 문자열을 채우면
        // 아무도 읽지 않는 키가 상태 파일에 영원히 남고, `settings.get`이 null이 아니라 ""를
        // 돌려줘 저작자가 "값이 있는 설정"으로 착각한다. 프론트 `mergeSettingDefaults`와 같은 규칙.
        .filter(|f| f.kind != "button")
        .map(|f| {
            let value = values
                .get(&f.key)
                .cloned()
                .unwrap_or_else(|| default_setting_value(f));
            (f.key.clone(), value)
        })
        .collect()
}

/// 스캔에서 탈락한 폴더 한 건 — 사유와 함께 표면화해 "설치했는데 목록에 없다"는
/// 침묵 실패를 진단 가능하게 한다("실패는 항상 보인다"는 원칙과 같은 결).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedPlugin {
    /// 실제 폴더 이름(`plugins/<dir_name>`).
    pub dir_name: String,
    /// 탈락 사유(사람이 읽는 한국어 — 설정 창 "불러오지 못한 폴더" 표시용).
    pub reason: String,
}

/// [`scan_installed_report`]의 결과 — 유효 목록과 탈락 목록을 함께 담는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ScanReport {
    pub valid: Vec<InstalledPlugin>,
    pub rejected: Vec<RejectedPlugin>,
}

/// 앱데이터 `plugins/`를 스캔해 유효/탈락을 모두 보고한다(`scan_installed`의 조용한
/// `continue`를 사유와 함께 표면화한 버전).
///
/// 역할: 각 하위 디렉터리에서 `manifest.json`을 검증하고 `main.js` 존재를 확인한 뒤, 로컬
/// 상태(활성·부여)와 병합한다. 실패한 폴더는 버리지 않고 [`RejectedPlugin`]으로 사유와
/// 함께 모은다.
/// 왜: 이전엔 파싱 실패·id 불일치·entry 부재가 전부 `continue`로 사라져 사용자도 저작자도
/// "왜 안 보이는지" 알 방법이 없었다("실패는 항상 보인다"는 원칙과 같은 결함군).
/// 호환: [`scan_installed`]는 이 함수의 `valid`만 돌려주는 얇은 래퍼로 유지해 기존 호출부·
/// 테스트를 깨지 않는다 — IPC로 `rejected`를 노출하는 배선은 `plugin_commands.rs`
/// 소유자에게 요청사항으로 남긴다.
pub fn scan_installed_report(app_data: &Path, state: &PluginsState) -> ScanReport {
    let dir = plugins_dir(app_data);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return ScanReport::default();
    };
    let mut report = ScanReport::default();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue; // 파일은 애초에 플러그인 후보가 아니다 — 탈락으로 보고할 대상이 아님.
        }
        let Some(dir_id) = path.file_name().and_then(|s| s.to_str()) else {
            continue; // 비UTF-8 폴더명 — dir_name 자체를 못 만들어 보고 불가(극히 드묾).
        };
        let raw = match read_to_string(&path.join("manifest.json")) {
            Ok(r) => r,
            Err(_) => {
                report.rejected.push(RejectedPlugin {
                    dir_name: dir_id.to_string(),
                    reason: "manifest.json을 읽을 수 없음".to_string(),
                });
                continue;
            }
        };
        let manifest = match parse_manifest(&raw) {
            Ok(m) => m,
            Err(e) => {
                report.rejected.push(RejectedPlugin {
                    dir_name: dir_id.to_string(),
                    reason: format!("매니페스트 검증 실패: {e}"),
                });
                continue;
            }
        };
        // 디렉터리 이름과 매니페스트 id가 일치해야 한다(경로 위조·혼동 방지).
        if manifest.id != dir_id {
            report.rejected.push(RejectedPlugin {
                dir_name: dir_id.to_string(),
                reason: format!(
                    "폴더 이름과 매니페스트 id가 다름(폴더: {dir_id}, id: {})",
                    manifest.id
                ),
            });
            continue;
        }
        // entry(보통 main.js)가 실제로 있어야 로드 가능한 플러그인으로 본다.
        if !path.join(&manifest.entry).is_file() {
            report.rejected.push(RejectedPlugin {
                dir_name: dir_id.to_string(),
                reason: format!("entry 파일 없음: {}", manifest.entry),
            });
            continue;
        }
        let record = state.plugins.get(&manifest.id).cloned().unwrap_or_default();
        report.valid.push(InstalledPlugin {
            granted: sanitize_granted(&manifest.permissions, &record.granted),
            enabled: record.enabled,
            settings: resolve_settings(&manifest.settings, &record.settings),
            settings_schema: manifest.settings,
            settings_category: manifest.settings_category,
            settings_description: manifest.settings_description,
            source: record.source.unwrap_or(PluginSource::Local),
            summary: manifest.summary,
            kind: manifest.kind,
            min_host_version: manifest.min_host_version,
            purpose: manifest.purpose,
            llm_context: manifest.llm_context,
            permission_reasons: manifest.permission_reasons,
            contributes: manifest.contributes,
            exposes: manifest.exposes,
            nls: manifest.nls,
            pending_reserved: record.pending_reserved,
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            permissions: manifest.permissions,
            platforms: manifest.platforms,
        });
    }
    report.valid.sort_by(|a, b| a.id.cmp(&b.id));
    report.rejected.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    report
}

/// 앱데이터 `plugins/`를 스캔해 설치 플러그인 목록을 만든다(순수 IO, 테스트용).
///
/// 역할: [`scan_installed_report`]의 `valid`만 돌려주는 얇은 래퍼(하위호환 — 기존 호출부는
/// 탈락 사유가 필요 없으면 이 함수를 그대로 쓴다). 탈락 사유가 필요하면
/// [`scan_installed_report`]를 쓴다.
pub fn scan_installed(app_data: &Path, state: &PluginsState) -> Vec<InstalledPlugin> {
    scan_installed_report(app_data, state).valid
}

/// 플러그인의 entry 코드(보통 `main.js`)를 읽는다. 설치되지 않았거나 매니페스트가
/// 깨졌으면 오류.
///
/// 역할: 샌드박스에서 eval할 코드를 매니페스트의 entry 파일명으로 읽어 돌려준다.
/// 왜: 프론트 로더가 이 코드를 격리 iframe에서 실행한다(게이트키퍼를 통과한 호출만 특권).
pub fn read_plugin_code(app_data: &Path, id: &str) -> Result<String, String> {
    let dir = plugin_dir(app_data, id);
    let manifest = read_to_string(&dir.join("manifest.json"))
        .map_err(|_| format!("설치되지 않은 플러그인: {id}"))
        .and_then(|raw| parse_manifest(&raw))?;
    read_to_string(&dir.join(&manifest.entry)).map_err(|e| e.to_string())
}

/// 설치 플러그인 README 최대 크기(설정창 상세 뷰 표시용 상한 — 과대 파일 방어).
const MAX_README_BYTES: u64 = 64 * 1024;

/// 로케일 코드 형식 — BCP47 소문자 단순형만(`en`·`en-us`·`pt-br`).
/// 정규식으로 쓰면 `^[a-z]{2}(-[a-z0-9]+)*$`이고, 이 규칙이 곧 저작 계약이다
/// (`docs/plugin/manifest.schema.json`의 `contributes.translations`가 같은 문장으로 적는다).
///
/// 소비처가 둘이라 `pub(crate)`다:
///
/// - README 로케일 변형(`README.<locale>.md`, [`read_plugin_readme`]) — 형식이 안 맞으면
///   (대문자·언더스코어·경로 구분자·`..` 등) 변형을 아예 시도하지 않고 기본 `README.md`로
///   조용히 떨어진다(오류가 아니다). 파일명 조립 **전에** 걸러 경로 탈출 여지를 원천
///   차단한다(호출측이 `locale`을 사용자 입력·IPC로 받으므로 신뢰하지 않는다).
/// - 설치 언어팩의 `contributes.translations[].locale`
///   ([`crate::plugin_i18n::parse_translation`]) — 이 코드로 파일명(README 변형)도 만들고
///   드롭다운 항목도 만드는데, 두 자리에서 다른 규칙을 쓰면 "목록에는 뜨는데 README는
///   안 뜬다" 같은 설명 불가능한 비대칭이 생긴다.
pub(crate) fn is_valid_locale_code(locale: &str) -> bool {
    let mut parts = locale.split('-');
    let Some(lang) = parts.next() else {
        return false;
    };
    if lang.len() != 2 || !lang.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    parts.all(|p| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

/// 경로 하나를 README 안전 규칙(심링크 아님·일반 파일·64KB 이내·UTF-8)으로 읽는다. 위반이면
/// None — 로케일 변형과 기본 `README.md`가 이 규칙을 공유한다.
///
/// symlink_metadata는 링크를 따라가지 않는다 — 링크 자체를 감지해 거부한다(설치 시 방어
/// [`crate::plugin_install`]의 reject_symlinks를 우회해 나중에 심어진 링크가 임의 파일을
/// 노출하지 못하게 읽기 시점에도 거른다 — 심층 방어).
fn read_readme_file(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_README_BYTES {
        return None;
    }
    std::fs::read(path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// 설치 플러그인의 README(사용법 마크다운)를 읽는다. 못 읽으면 None.
///
/// 역할: `<app_data>/plugins/<id>/README.md` 원문을 설정창 상세 뷰용으로 돌려준다. `locale`
/// (선택, 축 2)을 주면 `README.<locale>.md`(소문자 정규화)를 **먼저** 찾고, 없거나 로케일
/// 형식이 무효하면 `README.md`로 폴백한다. 부재·상한(64KB) 초과·비UTF-8·심링크·형식 위반
/// id는 전부 None으로 통일한다 — README는 표시 전용이라 호출측이 실패 종류를 구분할 이유가
/// 없고, 균일한 "설명 없음" 처리가 단순하다.
/// 왜: id는 경로 결합 전에 형식 검증해 디렉터리 탈출을 차단한다(locale도 같은 이유로
/// [`is_valid_locale_code`]을 먼저 통과해야 파일명 조립에 쓰인다).
pub fn read_plugin_readme(app_data: &Path, id: &str, locale: Option<&str>) -> Option<String> {
    if !is_valid_id(id) {
        return None;
    }
    let dir = plugin_dir(app_data, id);
    if let Some(loc) = locale {
        let normalized = loc.to_lowercase();
        if is_valid_locale_code(&normalized) {
            if let Some(text) = read_readme_file(&dir.join(format!("README.{normalized}.md"))) {
                return Some(text);
            }
        }
    }
    read_readme_file(&dir.join("README.md"))
}

/// 활성 상태를 설정한다(상태 갱신 후 영속화). 설치되지 않은 id면 오류.
///
/// 역할: 토글된 활성 여부를 로컬 상태에 반영한다. 부여 권한은 보존한다.
pub fn set_enabled(app_data: &Path, id: &str, enabled: bool) -> Result<(), String> {
    if !plugin_dir(app_data, id).is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state.plugins.entry(id.to_string()).or_default().enabled = enabled;
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 민감 권한 부여 집합을 설정한다(선언 ∩ 요청으로 좁힌 뒤 영속화).
///
/// 역할: 설정 UI에서 켠 민감 권한만 로컬에 부여한다. 선언되지 않은 권한 요청은 버린다.
/// 왜: 부여는 항상 매니페스트 선언의 부분집합 — 동기화나 UI 버그로도 특권이 새지 않게.
pub fn set_granted(app_data: &Path, id: &str, granted: &[String]) -> Result<(), String> {
    let dir = plugin_dir(app_data, id);
    if !dir.is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    let manifest = read_to_string(&dir.join("manifest.json"))
        .map_err(|e| e.to_string())
        .and_then(|raw| parse_manifest(&raw))?;
    let safe = sanitize_granted(&manifest.permissions, granted);
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state.plugins.entry(id.to_string()).or_default().granted = safe;
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// "선언은 했지만 아직 예약이라 부여하지 못한" 민감 권한 집합을 저장한다.
///
/// 역할: 승인 시점의 diff(`grantsForApproval`류)가 계산한 예약-보류 권한을 로컬 상태에
/// 기억해 둔다 — 예약이 풀리는 시점(어떤 권한이 `PERMISSION_RESERVED`에서 빠짐)은 이
/// 함수가 몰라도 된다. 그건 프론트(TS `host.ts`가 유일한 정본)가 부팅 시
/// `pending_reserved ∖ PERMISSION_RESERVED`로 판정해 재승인 배너를 띄우고, 사용자가
/// 승인하면 [`set_granted`]로 실제 부여를 추가한 뒤 이 함수를 다시 호출해 해소된 항목을
/// 뺀 나머지로 갱신한다.
/// 왜: `install-flow.ts`의 `grantsForApproval` 주석이 스스로 인정한 구멍 — 예약이 풀려도
/// 매니페스트가 그대로면 재승인 프롬프트가 자동으로 뜨지 않는 문제의 저장소 절반.
/// 부여와 동일하게 선언 ∩ 요청으로 좁혀 저장한다(선언 안 한 권한이 상태에 새지 않게).
pub fn set_pending_reserved(app_data: &Path, id: &str, pending: &[String]) -> Result<(), String> {
    let dir = plugin_dir(app_data, id);
    if !dir.is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    let manifest = read_to_string(&dir.join("manifest.json"))
        .map_err(|e| e.to_string())
        .and_then(|raw| parse_manifest(&raw))?;
    let safe = sanitize_granted(&manifest.permissions, pending);
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state
            .plugins
            .entry(id.to_string())
            .or_default()
            .pending_reserved = safe;
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 플러그인 설정 값 하나를 저장한다(선언된 스키마 키만 허용 후 영속화).
///
/// 역할: 설정 폼(또는 플러그인 `settings.set`)이 바꾼 값 하나를 로컬 상태에 반영한다.
/// 왜: 선언 안 한 키는 거부해 상태에 임의 키가 쌓이지 않게 한다(부여 좁히기와 같은 원칙 —
/// 매니페스트 선언이 유일한 진실). 설치되지 않은 플러그인/미선언 키는 오류로 막는다.
pub fn set_setting(
    app_data: &Path,
    id: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let dir = plugin_dir(app_data, id);
    if !dir.is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    let manifest = read_to_string(&dir.join("manifest.json"))
        .map_err(|e| e.to_string())
        .and_then(|raw| parse_manifest(&raw))?;
    if !manifest.settings.iter().any(|f| f.key == key) {
        return Err(format!("선언되지 않은 설정 키: {key}"));
    }
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state
            .plugins
            .entry(id.to_string())
            .or_default()
            .settings
            .insert(key.to_string(), value);
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 빌트인(번들) 플러그인의 활성 여부를 설정한다(로컬 상태 영속화).
///
/// 역할: 설치 플러그인과 달리 디렉터리 존재 검사 없이 활성 플래그만 저장한다(코드가 앱에
/// 내장돼 항상 존재). 기본이 켜짐이라 보통 끌 때 false가 기록된다.
/// 왜: 번들 플러그인도 사용자가 끌 수 있게 하되, 활성 상태는 기기 기준(비동기화)으로 둔다.
pub fn set_builtin_enabled(app_data: &Path, id: &str, enabled: bool) -> Result<(), String> {
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state.builtins.insert(id.to_string(), enabled);
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 빌트인(번들) 플러그인의 설정 값 하나를 저장한다(키 형식 검증 후 영속화).
///
/// 역할: 번들 플러그인 설정 폼(또는 플러그인 `settings.set`)이 바꾼 값 하나를 로컬 상태에
/// 반영한다. 번들은 디스크 매니페스트가 없어 선언 스키마 대조 대신 키 형식만 검증한다
/// (`is_valid_setting_key` — 예약 키 거부로 프로토타입 오염 여지를 막는다). 코드가 1st-party라
/// 값 자체는 신뢰한다.
/// 왜: 번들 플러그인도 사용자가 설정을 바꿀 수 있게 하되, 값은 기기 기준(비동기화)으로 둔다.
pub fn set_builtin_setting(
    app_data: &Path,
    id: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    if !is_valid_setting_key(key) {
        return Err(format!("설정 키 형식 오류: {key}"));
    }
    with_state_lock(|| {
        let mut state = load_state(app_data);
        state
            .builtin_settings
            .entry(id.to_string())
            .or_default()
            .insert(key.to_string(), value);
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 플러그인을 제거한다(디렉터리 삭제 + 상태에서 레코드 제거).
///
/// 역할: 설치 폴더와 로컬 상태 항목을 함께 지워 잔여 부여가 남지 않게 한다.
pub fn remove(app_data: &Path, id: &str) -> Result<(), String> {
    let dir = plugin_dir(app_data, id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    with_state_lock(|| {
        let mut state = load_state(app_data);
        if state.plugins.remove(id).is_some() {
            save_state(app_data, &state).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// 설치된 플러그인 전부(코드 디렉터리 + 활성/권한/설정 로컬 상태)를 지운다 — "모든 데이터
/// 삭제"(이슈 #20)의 플러그인 쪽 절반. `plugins/`(코드) 디렉터리와 `plugins-state.json`
/// (활성·부여·설정·빌트인 상태 전부)을 함께 지운다.
///
/// 플러그인별 저장소(`memo.storage.local.*`, `<app_data>/plugin-storage/`)는 이 함수의 소관이
/// 아니다 — 그 파일 경계는 [`crate::plugin_storage`]가 소유한다(모듈 문서 「격리」절). 호출부
/// ([`crate::commands::wipe_all_data`])가 `plugin_storage::storage_dir`로 나란히 지운다 —
/// [`crate::plugin_commands::remove_plugin`]이 단일 플러그인 제거에서 이미 이 두 모듈을
/// 나란히 부르는 것과 같은 분업을, 전체 삭제에도 그대로 반복한다.
///
/// 이미 없는 디렉터리/파일은 성공으로 본다(멱등 — [`remove`]와 같은 관례).
pub fn wipe_all(app_data: &Path) -> Result<(), String> {
    let dir = plugins_dir(app_data);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    with_state_lock(|| {
        let path = state_path(app_data);
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// vault 목록 항목 id를 "무시" 목록에 추가한다(로컬 영속 — 재조정 안내 재표시 방지).
///
/// 역할: 재조정 배너에서 [무시]를 누른 항목을 이 기기에서만 기억한다(정렬·중복 제거).
/// 왜: 무시는 기기별 선호라 동기화 목록이 아니라 로컬 상태에 둔다.
pub fn dismiss_missing(app_data: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("무시할 플러그인 id가 비어 있습니다".to_string());
    }
    with_state_lock(|| {
        let mut state = load_state(app_data);
        if state.dismissed_missing.iter().any(|d| d == id) {
            return Ok(());
        }
        state.dismissed_missing.push(id.to_string());
        state.dismissed_missing.sort();
        save_state(app_data, &state).map_err(|e| e.to_string())
    })
}

/// 폴더(`manifest.json` + entry 포함)를 `plugins/<id>/`로 복사 설치한다. 설치된 id를 반환.
///
/// 역할: 로컬 사이드로드 — 소스 폴더의 매니페스트를 검증하고 entry 파일 존재를 확인한 뒤,
/// `manifest.json`과 entry 파일을 대상 디렉터리에 복사한다(있으면 덮어쓰기/재설치).
/// 왜: 신뢰할 수 없는 폴더를 그대로 로드하지 않고 검증 통과분만 앱 영역으로 들인다.
/// 보안: 임의 파일 복사가 아니라 manifest + entry(파일명 검증)만 복사 — 경로 탈출을 막는다.
pub fn install_from_dir(app_data: &Path, src_dir: &Path) -> Result<String, String> {
    let manifest_raw =
        read_to_string(&src_dir.join("manifest.json")).map_err(|_| "manifest.json 없음")?;
    // parse_manifest가 id 형식·entry 파일명(경로 탈출 금지)·semver 버전 형식을 이미 검증한다
    // (모든 공용 관문에서 강제 — 신규 설치만 따로 막을 이유가 없다).
    let manifest = parse_manifest(&manifest_raw)?;
    let src_entry = src_dir.join(&manifest.entry);
    if !src_entry.is_file() {
        return Err(format!("entry 파일 없음: {}", manifest.entry));
    }

    let dest = plugin_dir(app_data, &manifest.id);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    // manifest.json과 entry 파일만 필수로 복사한다(원자적 쓰기로 부분 기록 방지).
    let entry_code = read_to_string(&src_entry).map_err(|e| e.to_string())?;
    write_atomic(&dest.join("manifest.json"), &manifest_raw).map_err(|e| e.to_string())?;
    write_atomic(&dest.join(&manifest.entry), &entry_code).map_err(|e| e.to_string())?;
    // README.md + 1단계 아래 이미지 에셋을 닫힌 화이트리스트로 추가 복사한다. 둘 다
    // 있으면 좋고 없어도 설치 자체는 계속된다 — 실행 표면(entry 1개)에는 영향 없는 장식.
    copy_readme_if_present(src_dir, &dest);
    copy_asset_images(src_dir, &dest);

    Ok(manifest.id)
}

/// README 복사 상한(설치 시점 — [`read_plugin_readme`]의 읽기 시점 상한과 같은 크기).
const MAX_README_COPY_BYTES: u64 = MAX_README_BYTES;
/// 에셋(이미지) 화이트리스트 확장자 — 번들 `BUILTIN_ASSETS`(index.ts의 import.meta.glob)와
/// 정확히 같은 집합(대소문자 무시). 실행 가능한 확장자는 이 목록에 없다(실행 표면 불변).
const ASSET_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
/// 플러그인당 복사할 이미지 에셋 최대 개수(과다 첨부 방어).
const MAX_ASSET_COUNT: usize = 20;
/// 에셋 이미지 1개 최대 바이트(과대 이미지 방어).
const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024;

/// `src_dir/README.md`가 안전(심링크 아님·일반 파일·상한 이내·UTF-8)하면 `dest`에 복사한다.
/// 실패하면 조용히 건너뛴다 — README는 표시 전용 장식이라 설치 전체를 막을 이유가 없다
/// ([`read_plugin_readme`]가 어차피 읽기 시점에도 같은 규칙으로 걸러 "설명 없음"으로 처리한다).
pub(crate) fn copy_readme_if_present(src_dir: &Path, dest: &Path) {
    let src = src_dir.join("README.md");
    let Ok(meta) = std::fs::symlink_metadata(&src) else {
        return; // 없음.
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_README_COPY_BYTES {
        return;
    }
    let Ok(bytes) = std::fs::read(&src) else {
        return;
    };
    if String::from_utf8(bytes.clone()).is_err() {
        return; // 비UTF-8 — 표시 전용 텍스트만 신뢰.
    }
    let _ = write_atomic_bytes(&dest.join("README.md"), &bytes);
}

/// `src_dir` 1단계 아래(재귀 없음)의 이미지 파일을 화이트리스트 확장자·심링크 거부·개수/
/// 크기 상한을 적용해 `dest`로 복사한다. 상한을 넘는 항목은 건너뛴다(전체 실패시키지
/// 않음 — 에셋은 README 렌더의 장식이라 최선 노력이면 충분하다).
pub(crate) fn copy_asset_images(src_dir: &Path, dest: &Path) {
    let Ok(entries) = std::fs::read_dir(src_dir) else {
        return;
    };
    let mut copied = 0usize;
    for entry in entries.flatten() {
        if copied >= MAX_ASSET_COUNT {
            break;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !ASSET_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_ASSET_BYTES {
            continue; // 심링크·비일반 파일·과대 파일은 건너뛴다(실패시키지 않음).
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if write_atomic_bytes(&dest.join(name), &bytes).is_ok() {
            copied += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트용: 앱데이터에 유효한 플러그인 폴더를 만든다(manifest + main.js).
    fn make_plugin(app_data: &Path, id: &str, perms: &str) {
        let dir = plugins_dir(app_data).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = format!(
            r#"{{"id":"{id}","name":"{id} 이름","version":"1.0.0","entry":"main.js","permissions":{perms}}}"#
        );
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        std::fs::write(dir.join("main.js"), "// code").unwrap();
    }

    /// 가드: 정상 README.md는 원문 그대로 읽힌다.
    #[test]
    fn readme_reads_utf8_markdown() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        std::fs::write(
            plugins_dir(app_data).join("alpha").join("README.md"),
            "# 알파\n\n## 사용법",
        )
        .unwrap();
        assert_eq!(
            read_plugin_readme(app_data, "alpha", None).as_deref(),
            Some("# 알파\n\n## 사용법")
        );
    }

    /// 가드: README 부재·64KB 상한 초과·비UTF-8은 전부 None(균일한 "설명 없음" 처리).
    #[test]
    fn readme_missing_oversized_or_binary_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        assert_eq!(read_plugin_readme(app_data, "alpha", None), None); // 부재

        let path = plugins_dir(app_data).join("alpha").join("README.md");
        std::fs::write(&path, vec![b'a'; 64 * 1024 + 1]).unwrap();
        assert_eq!(read_plugin_readme(app_data, "alpha", None), None); // 상한 초과

        std::fs::write(&path, [0xffu8, 0xfe, 0x00]).unwrap();
        assert_eq!(read_plugin_readme(app_data, "alpha", None), None); // 비UTF-8
    }

    /// 가드(보안): 형식 위반 id(경로 탈출 시도 포함)는 경로 결합 전에 거부된다.
    #[test]
    fn readme_rejects_invalid_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        // plugins/ 밖(app_data/evil)에 README를 두고 상대경로 id로 탈출을 시도한다.
        let outside = app_data.join("evil");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("README.md"), "탈출").unwrap();
        assert_eq!(read_plugin_readme(app_data, "../evil", None), None);
        assert_eq!(read_plugin_readme(app_data, "", None), None);
        assert_eq!(read_plugin_readme(app_data, "Bad Id", None), None);
    }

    /// 가드(보안): 심링크 README는 대상이 유효한 파일이어도 거부된다(임의 파일 노출 차단).
    #[cfg(unix)]
    #[test]
    fn readme_rejects_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        let secret = app_data.join("secret.md");
        std::fs::write(&secret, "비밀").unwrap();
        std::os::unix::fs::symlink(
            &secret,
            plugins_dir(app_data).join("alpha").join("README.md"),
        )
        .unwrap();
        assert_eq!(read_plugin_readme(app_data, "alpha", None), None);
    }

    /// 가드(축 2): `README.<locale>.md`가 있으면 기본 `README.md`보다 우선한다.
    #[test]
    fn readme_prefers_locale_variant_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        let dir = plugins_dir(app_data).join("alpha");
        std::fs::write(dir.join("README.md"), "# 기본(한국어)").unwrap();
        std::fs::write(dir.join("README.en.md"), "# English").unwrap();
        assert_eq!(
            read_plugin_readme(app_data, "alpha", Some("en")).as_deref(),
            Some("# English")
        );
        // 로케일 변형이 없는 코드는 기본으로 폴백한다.
        assert_eq!(
            read_plugin_readme(app_data, "alpha", Some("fr")).as_deref(),
            Some("# 기본(한국어)")
        );
        // locale=None은 기존 동작(항상 기본).
        assert_eq!(
            read_plugin_readme(app_data, "alpha", None).as_deref(),
            Some("# 기본(한국어)")
        );
    }

    /// 가드(축 2): 로케일 코드 대소문자는 정규화된다(`README.EN.md`가 아니라 소문자 파일명을 찾는다).
    #[test]
    fn readme_locale_variant_is_lowercase_normalized() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        let dir = plugins_dir(app_data).join("alpha");
        std::fs::write(dir.join("README.md"), "# 기본").unwrap();
        std::fs::write(dir.join("README.en-us.md"), "# US English").unwrap();
        assert_eq!(
            read_plugin_readme(app_data, "alpha", Some("EN-US")).as_deref(),
            Some("# US English")
        );
    }

    /// 가드(보안): 형식 위반 로케일(경로 탈출 시도 포함)은 파일명 조립에 쓰이지 않고
    /// 조용히 기본 README.md로 떨어진다(오류가 아니다).
    #[test]
    fn readme_invalid_locale_falls_back_without_error() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path();
        make_plugin(app_data, "alpha", "[]");
        let dir = plugins_dir(app_data).join("alpha");
        std::fs::write(dir.join("README.md"), "# 기본").unwrap();
        for bad in ["../../evil", "en/../../x", "e", "english", "en_US", ""] {
            assert_eq!(
                read_plugin_readme(app_data, "alpha", Some(bad)).as_deref(),
                Some("# 기본"),
                "locale={bad:?}"
            );
        }
    }

    /// 가드: 로케일 코드 형식 판정 그 자체(`is_valid_locale_code`) — TS `LOCALE_RE`와
    /// 같은 규칙(`^[a-z]{2}(-[a-z0-9]+)*$`). README 변형과 설치 언어팩
    /// (`plugin_i18n`)이 **같은 함수**를 쓰므로 이 가드가 두 경로를 함께 고정한다.
    #[test]
    fn locale_code_format_rules() {
        assert!(is_valid_locale_code("en"));
        assert!(is_valid_locale_code("en-us"));
        assert!(is_valid_locale_code("pt-br"));
        assert!(!is_valid_locale_code("EN")); // 대문자 거부(정규화는 호출부 책임)
        assert!(!is_valid_locale_code("e")); // 1글자
        assert!(!is_valid_locale_code("eng")); // 3글자
        assert!(!is_valid_locale_code("en_us")); // 언더스코어
        assert!(!is_valid_locale_code("en-")); // 빈 서브태그
        assert!(!is_valid_locale_code("../evil")); // 경로 탈출
        assert!(!is_valid_locale_code(""));
    }

    /// 가드: id 형식 규칙(첫 글자 영숫자, 본문 소문자·숫자·`._-`).
    #[test]
    fn id_format_rules() {
        assert!(is_valid_id("wikilink"));
        assert!(is_valid_id("a.b_c-1"));
        assert!(!is_valid_id("Bad"));
        assert!(!is_valid_id("-leading"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("has space"));
    }

    /// 가드: 유효 매니페스트는 통과하고, 미지의 권한/형식 오류는 거부.
    #[test]
    fn parse_manifest_validates() {
        let ok = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["editor","notes:read"]}"#,
        )
        .unwrap();
        assert_eq!(ok.id, "p");
        assert_eq!(ok.permissions, vec!["editor", "notes:read"]);

        // permissions 생략 → 빈 배열.
        let no_perms =
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert!(no_perms.permissions.is_empty());

        // theme은 저위험 권한(프론트와 동일 집합) → 테마 플러그인 설치가 통과해야 한다.
        let theme = parse_manifest(
            r#"{"id":"t","name":"T","version":"1.0.0","entry":"main.js","permissions":["theme"]}"#,
        )
        .unwrap();
        assert_eq!(theme.permissions, vec!["theme"]);

        assert!(
            parse_manifest(r#"{"id":"Bad Id","name":"P","version":"1.0.0","entry":"m.js"}"#)
                .is_err()
        );
        assert!(parse_manifest(r#"{"name":"P","version":"1.0.0","entry":"m.js"}"#).is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","permissions":["filesystem"]}"#
        )
        .is_err());
        assert!(parse_manifest("not json").is_err());
        // entry 경로 탈출은 거부(한 지점에서 막아 스캔·읽기·설치 모두 보호).
        assert!(
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"../evil.js"}"#)
                .is_err()
        );
        assert!(
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"sub/m.js"}"#)
                .is_err()
        );

        // storage는 프론트 permissions.ts와 같은 저위험 권한 집합에 있어야 한다 —
        // 한쪽만 알면 사이드로드 설치가 백엔드에서 "알 수 없는 권한"으로 거부된다.
        let storage = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["storage"]}"#,
        )
        .unwrap();
        assert_eq!(storage.permissions, vec!["storage"]);

        // notes:all-read도 같은 이유로 백엔드가 알아야 한다 — 모르면 이 권한을 선언한
        // 사이드로드 플러그인이 설치 자체를 거부당한다.
        let all_read = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["notes:all-read"]}"#,
        )
        .unwrap();
        assert_eq!(all_read.permissions, vec!["notes:all-read"]);
    }

    /// 가드: `parse_manifest`(설치·스캔·로드 공용 관문)는 semver 접두 형식을 강제한다 —
    /// 모든 경로가 대칭으로 강제되므로 신규 설치뿐 아니라 재스캔·로드도 비-semver를 거부한다.
    #[test]
    fn parse_manifest_requires_semver_version() {
        let with_version =
            |v: &str| format!(r#"{{"id":"p","name":"P","version":"{v}","entry":"main.js"}}"#);
        assert!(parse_manifest(&with_version("1")).is_err());
        assert!(parse_manifest(&with_version("1.0")).is_err());
        assert!(parse_manifest(&with_version("v1.0.0")).is_err());
        assert!(parse_manifest(&with_version("1.0.0")).is_ok());
        // version 필드 자체가 없으면 여전히 거부(필수 필드).
        assert!(parse_manifest(r#"{"id":"p","name":"P","entry":"main.js"}"#).is_err());
    }

    /// 가드: `platforms`(선택) — 문자열 배열이면 그대로 실어 나르고, 미선언은 빈 배열,
    /// 배열이 아니거나 항목이 문자열이 아니면 거부한다. TS `manifest.ts`의 동명 테스트와 짝
    /// (대칭 검증 — 한쪽만 거부하면 "CLI는 통과인데 설치가 거부된다"가 난다).
    #[test]
    fn parse_manifest_reads_platforms() {
        // 미선언 → 빈 배열(전 플랫폼 지원).
        let no_platforms =
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert!(no_platforms.platforms.is_empty());

        // 선언 → 그대로 실어 나른다. 미지의 OS 이름도 거부하지 않는다(전방 호환).
        let with_platforms = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","platforms":["macos","futureos"]}"#,
        )
        .unwrap();
        assert_eq!(with_platforms.platforms, vec!["macos", "futureos"]);

        // 배열이 아니면 거부.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","platforms":"macos"}"#
        )
        .is_err());

        // 항목이 문자열이 아니면 거부.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","platforms":["macos",1]}"#
        )
        .is_err());
    }

    /// 가드: 신규 설치는 semver 접두 형식을 강제한다([`install_from_dir`] → `parse_manifest`
    /// 관문) — `compareVersions`(다운그레이드 판정)가 항상 유효하도록 막는다.
    #[test]
    fn install_from_dir_rejects_non_semver_version() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path().join("app");
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("main.js"), "// noop").unwrap();
        let write_manifest = |v: &str| {
            std::fs::write(
                src.join("manifest.json"),
                format!(r#"{{"id":"p","name":"P","version":"{v}","entry":"main.js"}}"#),
            )
            .unwrap();
        };
        write_manifest("1");
        assert!(
            install_from_dir(&app_data, &src).is_err(),
            "비-semver 신규 설치는 거부된다"
        );
        write_manifest("1.0.0");
        assert!(
            install_from_dir(&app_data, &src).is_ok(),
            "semver 버전 신규 설치는 통과한다"
        );
    }

    /// 가드(대칭): 비-semver 버전 플러그인이 디스크에 있으면 재스캔([`scan_installed_report`])이
    /// 탈락 목록(`rejected`)으로 표면화한다 — `valid`에 조용히 남지 않는다(실패는 항상 보인다).
    #[test]
    fn scan_rejects_non_semver_install() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = tmp.path().join("app");
        // 설치 게이트를 우회해 비-semver 버전 플러그인을 디스크에 직접 심는다.
        let dir = plugins_dir(&app_data).join("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"id":"legacy","name":"Legacy","version":"1","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("main.js"), "// noop").unwrap();

        let report = scan_installed_report(&app_data, &PluginsState::default());
        assert!(
            report.valid.iter().all(|p| p.id != "legacy"),
            "비-semver 버전은 valid에 남지 않는다"
        );
        assert!(
            report.rejected.iter().any(|r| r.dir_name == "legacy"),
            "탈락 목록에 사유와 함께 표면화된다"
        );
    }

    /// 가드: `contributes`는 **형태만** 검증하고 원문을 그대로 나른다.
    ///
    /// 항목 내부 규칙(패턴의 open/close 등)은 프론트 registrar가 소유하므로 여기서 보지
    /// 않는다 — 복사하면 두 벌이 갈라진다. 모르는 종류는 전방 호환으로 통과시킨다(표면화는
    /// 프론트 진단·CLI가 한다).
    #[test]
    fn parse_manifest_validates_contributes() {
        let base = r#""id":"p","name":"P","version":"1.0.0","entry":"main.js""#;

        let ok = parse_manifest(&format!(
            r#"{{{base},"contributes":{{"inlinePatterns":[{{"id":"hl"}}],"windowControls":["transparency"],"translations":[{{"locale":"en","label":"English","entries":{{"a":"A"}}}}]}}}}"#
        ))
        .unwrap();
        let contributes = ok.contributes.expect("contributes가 실려야 한다");
        assert!(contributes["inlinePatterns"].is_array());
        assert_eq!(contributes["windowControls"][0], "transparency");
        assert_eq!(contributes["translations"][0]["locale"], "en");

        // 없으면 None(기존 매니페스트 무변경).
        assert!(parse_manifest(&format!("{{{base}}}"))
            .unwrap()
            .contributes
            .is_none());

        // 모르는 종류는 거부하지 않는다(전방 호환) — 구버전 앱이 신버전 플러그인을 통째로
        // 못 읽는 쪽이 더 나쁘다.
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"statusBar":[{{"id":"x"}}]}}}}"#
        ))
        .is_ok());

        // 형태가 어긋나면 거부한다(TS `parseContributes`와 같은 규칙).
        assert!(parse_manifest(&format!(r#"{{{base},"contributes":[]}}"#)).is_err());
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"completions":{{}}}}}}"#
        ))
        .is_err());
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"completions":["x"]}}}}"#
        ))
        .is_err());
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"windowControls":[1]}}}}"#
        ))
        .is_err());
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"translations":"x"}}}}"#
        ))
        .is_err());
        assert!(parse_manifest(&format!(
            r#"{{{base},"contributes":{{"translations":["x"]}}}}"#
        ))
        .is_err());
    }

    /// 가드: settingsCategory(카멜, 정본)가 파싱된다 — 저자 문서·번들 매니페스트가 쓰는 표기.
    #[test]
    fn parse_manifest_reads_settings_category_camel() {
        let m = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","settingsCategory":"도구"}"#,
        )
        .unwrap();
        assert_eq!(m.settings_category.as_deref(), Some("도구"));
    }

    /// 가드: settings_category(스네이크)는 더는 인식되지 않는다 — settingsCategory(카멜)만.
    #[test]
    fn parse_manifest_rejects_settings_category_snake() {
        let m = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","settings_category":"도구"}"#,
        )
        .unwrap();
        assert_eq!(m.settings_category, None);
    }

    /// 가드: 둘 다 없으면 None(기본 그룹으로 떨어짐).
    #[test]
    fn parse_manifest_settings_category_absent_is_none() {
        let m =
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert_eq!(m.settings_category, None);
    }

    /// 가드: 스캔이 유효 플러그인만 올리고, 상태(활성)와 병합한다. id 정렬.
    #[test]
    fn scan_lists_valid_and_merges_state() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "bravo", "[\"editor\"]");
        make_plugin(app_data, "alpha", "[\"editor\",\"notes:read\"]");

        let mut state = PluginsState::default();
        state.plugins.insert(
            "alpha".to_string(),
            PluginRecord {
                enabled: true,
                granted: vec!["notes:read".to_string()],
                ..Default::default()
            },
        );

        let list = scan_installed(app_data, &state);
        assert_eq!(list.len(), 2);
        // 정렬: alpha 먼저.
        assert_eq!(list[0].id, "alpha");
        assert!(list[0].enabled);
        assert_eq!(list[0].granted, vec!["notes:read"]);
        assert_eq!(list[1].id, "bravo");
        assert!(!list[1].enabled); // 상태에 없으면 기본 비활성.
    }

    /// 가드: main.js 없음·매니페스트 깨짐·id 불일치 폴더는 스캔에서 제외.
    #[test]
    fn scan_skips_invalid_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();

        // main.js 없는 폴더.
        let no_main = plugins_dir(app_data).join("nomain");
        std::fs::create_dir_all(&no_main).unwrap();
        std::fs::write(
            no_main.join("manifest.json"),
            r#"{"id":"nomain","name":"N","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();

        // 디렉터리 이름 ≠ 매니페스트 id.
        let mismatch = plugins_dir(app_data).join("dirname");
        std::fs::create_dir_all(&mismatch).unwrap();
        std::fs::write(
            mismatch.join("manifest.json"),
            r#"{"id":"other","name":"N","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(mismatch.join("main.js"), "// x").unwrap();

        // 깨진 매니페스트.
        let broken = plugins_dir(app_data).join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("manifest.json"), "{ not json").unwrap();
        std::fs::write(broken.join("main.js"), "// x").unwrap();

        assert!(scan_installed(app_data, &PluginsState::default()).is_empty());
    }

    /// 가드: 활성 토글이 영속화되고 다시 스캔에 반영된다(왕복).
    #[test]
    fn set_enabled_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"editor\"]");

        set_enabled(app_data, "alpha", true).unwrap();
        let list = scan_installed(app_data, &load_state(app_data));
        assert!(list[0].enabled);

        set_enabled(app_data, "alpha", false).unwrap();
        let list = scan_installed(app_data, &load_state(app_data));
        assert!(!list[0].enabled);
    }

    /// 가드: 설치되지 않은 id의 활성 토글은 오류.
    #[test]
    fn set_enabled_unknown_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(set_enabled(dir.path(), "ghost", true).is_err());
    }

    /// 가드: 부여는 선언 ∩ 요청으로 좁혀 영속화된다(선언 안 한 권한은 버려진다).
    #[test]
    fn set_granted_clamps_to_declared() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"editor\",\"notes:read\"]");

        // notes:write는 선언 안 됨 → 버려져야 한다.
        set_granted(
            app_data,
            "alpha",
            &["notes:read".to_string(), "notes:write".to_string()],
        )
        .unwrap();
        let list = scan_installed(app_data, &load_state(app_data));
        assert_eq!(list[0].granted, vec!["notes:read"]);
    }

    /// 가드: 제거가 디렉터리와 상태 레코드를 함께 지운다.
    #[test]
    fn remove_deletes_dir_and_record() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"editor\"]");
        set_enabled(app_data, "alpha", true).unwrap();

        remove(app_data, "alpha").unwrap();
        assert!(!plugins_dir(app_data).join("alpha").exists());
        assert!(scan_installed(app_data, &load_state(app_data)).is_empty());
        assert!(!load_state(app_data).plugins.contains_key("alpha"));
    }

    /// 가드(이슈 #20 — 모든 데이터 삭제): `wipe_all`이 설치 코드 디렉터리와 상태 파일을
    /// 모두 지운다 — 제거 뒤 스캔은 빈 목록, 상태는 완전 기본값이다.
    #[test]
    fn wipe_all_clears_plugins_dir_and_state_file() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"editor\"]");
        set_enabled(app_data, "alpha", true).unwrap();
        set_builtin_enabled(app_data, "template", false).unwrap();
        assert!(state_path(app_data).is_file());

        wipe_all(app_data).unwrap();

        assert!(!plugins_dir(app_data).exists());
        assert!(!state_path(app_data).exists());
        assert!(scan_installed(app_data, &load_state(app_data)).is_empty());
        assert_eq!(load_state(app_data), PluginsState::default());
    }

    /// 가드: 아무것도 설치된 적 없는(디렉터리·상태 파일 모두 부재) 앱데이터에서도 `wipe_all`은
    /// 오류 없이 끝난다(멱등).
    #[test]
    fn wipe_all_on_empty_app_data_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        wipe_all(dir.path()).unwrap();
    }

    /// 가드: 로컬 폴더 설치가 manifest + entry를 복사하고 스캔에 나타난다.
    #[test]
    fn install_from_dir_copies_and_scans() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let src = dir.path().join("src-plugin");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{"id":"fresh","name":"Fresh","version":"2.0.0","entry":"main.js","permissions":["editor"]}"#,
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "memo.editor;").unwrap();

        let id = install_from_dir(&app_data, &src).unwrap();
        assert_eq!(id, "fresh");

        let list = scan_installed(&app_data, &load_state(&app_data));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Fresh");
        assert_eq!(list[0].version, "2.0.0");
    }

    /// 가드: `llmContext`·`permissionReasons`가 `PluginManifest`엔 있었지만
    /// `InstalledPlugin`이 옮겨 담지 않아 사이드로드 플러그인만 이 값이 프론트에 닿기 전에
    /// 사라지던 결함(`summary`가 정확히 이렇게 한 번 사라진 전례) — 지금은 스캔까지 살아남는다.
    #[test]
    fn scan_installed_carries_llm_context_and_permission_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let src = dir.path().join("src-plugin");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{"id":"selfdesc","name":"SD","version":"1.0.0","entry":"main.js",
                "permissions":["settings"],
                "llmContext":"이 플러그인은 설정 값 하나를 저장한다.",
                "permissionReasons":{"settings":"토글 상태를 기억하려고요"}}"#,
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "// code").unwrap();

        install_from_dir(&app_data, &src).unwrap();
        let list = scan_installed(&app_data, &load_state(&app_data));
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].llm_context.as_deref(),
            Some("이 플러그인은 설정 값 하나를 저장한다.")
        );
        assert_eq!(
            list[0]
                .permission_reasons
                .get("settings")
                .map(String::as_str),
            Some("토글 상태를 기억하려고요")
        );
    }

    /// 가드: README.md + 화이트리스트 확장자 이미지가 함께 복사되고, 화이트리스트
    /// 밖 파일(junk.txt)·심링크·과대 파일은 걸러진다(설치 자체는 실패시키지 않음).
    #[test]
    fn install_from_dir_copies_readme_and_asset_whitelist() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let src = dir.path().join("src-plugin");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{"id":"withassets","name":"WA","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "// code").unwrap();
        std::fs::write(src.join("README.md"), "# 사용법").unwrap();
        std::fs::write(src.join("icon.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        std::fs::write(src.join("junk.txt"), "따라오면 안 됨").unwrap();
        // 화이트리스트 밖 실행 확장자는 절대 복사되지 않는다(실행 표면 불변).
        std::fs::write(src.join("evil.sh"), "#!/bin/sh").unwrap();

        install_from_dir(&app_data, &src).unwrap();
        let dest = plugins_dir(&app_data).join("withassets");
        assert_eq!(
            std::fs::read_to_string(dest.join("README.md")).unwrap(),
            "# 사용법"
        );
        assert!(dest.join("icon.png").is_file());
        assert!(!dest.join("junk.txt").exists());
        assert!(!dest.join("evil.sh").exists());
    }

    /// 가드(보안): 심링크 README/이미지는 복사되지 않는다(설치는 계속 성공 — 장식
    /// 파일 하나 없다고 전체를 막지 않는다).
    #[cfg(unix)]
    #[test]
    fn install_from_dir_skips_symlinked_assets() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let src = dir.path().join("src-plugin");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            r#"{"id":"linked","name":"L","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "// code").unwrap();
        let secret = dir.path().join("secret.md");
        std::fs::write(&secret, "비밀").unwrap();
        std::os::unix::fs::symlink(&secret, src.join("README.md")).unwrap();

        install_from_dir(&app_data, &src).unwrap();
        assert!(!plugins_dir(&app_data)
            .join("linked")
            .join("README.md")
            .exists());
    }

    /// 가드: 예약-보류 권한이 왕복 저장되고, 선언에 없는 권한은 버려진다(부여와 같은
    /// 원칙). 설치되지 않은 id는 오류.
    #[test]
    fn set_pending_reserved_clamps_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"commands\",\"notes:read\"]");

        // vault:read는 선언 안 됨 → 버려져야 한다.
        set_pending_reserved(
            app_data,
            "alpha",
            &["commands".to_string(), "vault:read".to_string()],
        )
        .unwrap();
        let list = scan_installed(app_data, &load_state(app_data));
        assert_eq!(list[0].pending_reserved, vec!["commands"]);

        assert!(set_pending_reserved(app_data, "ghost", &["commands".to_string()]).is_err());
    }

    /// 가드: 새 매니페스트 필드(summary/kind/minHostVersion/
    /// purpose/llmContext/permissionReasons)가 파싱되고 InstalledPlugin까지 전달된다 —
    /// 이 fixture는 `manifest.test.ts`의 동명 대칭 fixture와 짝이다(같은 입력, 같은 합격).
    #[test]
    fn parse_manifest_reads_new_wave_a_fields() {
        let m = parse_manifest(
            r#"{"id":"sym","name":"Symmetric","version":"1.0.0","entry":"main.js",
                "permissions":["settings"],
                "settings":[{"key":"tone","label":"톤","type":"select","options":["a","b"]}],
                "kind":"action","minHostVersion":"0.1.0",
                "purpose":"대칭 검증용 픽스처","llmContext":"짧은 컨텍스트",
                "permissionReasons":{"settings":"설정을 저장하려고요"}}"#,
        )
        .unwrap();
        assert_eq!(m.summary, None);
        assert_eq!(m.kind.as_deref(), Some("action"));
        assert_eq!(m.min_host_version.as_deref(), Some("0.1.0"));
        assert_eq!(m.purpose.as_deref(), Some("대칭 검증용 픽스처"));
        assert_eq!(m.llm_context.as_deref(), Some("짧은 컨텍스트"));
        assert_eq!(
            m.permission_reasons.get("settings").map(String::as_str),
            Some("설정을 저장하려고요")
        );
    }

    /// 가드(대칭): select인데 options가 비면 거부(`manifest.test.ts`의 동명 fixture와 짝).
    #[test]
    fn symmetric_fixture_rejects_select_without_options() {
        let raw = r#"{"id":"sym","name":"Symmetric","version":"1.0.0","entry":"main.js",
            "settings":[{"key":"tone","label":"톤","type":"select"}]}"#;
        assert!(parse_manifest(raw).is_err());
    }

    /// 가드(대칭, 단위): 길이 상한은 **코드포인트**로 잰다(`manifest.test.ts`의
    /// "counts length limits in code points" fixture와 짝 — 같은 문자열, 같은 판정).
    ///
    /// 왜 이 fixture인가: `"가"×79 + "🎨"`는 코드포인트 80(=상한)이지만 UTF-16 코드 유닛으로는
    /// 81이다. 두 검증기가 다른 단위를 쓰면 이 매니페스트가 한쪽만 통과해, 설치는 되는데
    /// 로드에서 조용히 사라지는(또는 CLI만 거부하는) 비대칭이 난다.
    #[test]
    fn symmetric_fixture_emoji_boundary_counts_code_points() {
        let purpose = format!("{}🎨", "가".repeat(79)); // 코드포인트 80
        assert_eq!(purpose.chars().count(), 80);
        let with = |field: &str, value: &str| {
            format!(
                r#"{{"id":"sym","name":"Symmetric","version":"1.0.0","entry":"main.js","{field}":"{value}"}}"#
            )
        };
        assert!(parse_manifest(&with("purpose", &purpose)).is_ok());
        assert!(parse_manifest(&with("purpose", &format!("가{purpose}"))).is_err());

        let llm = format!("{}🎨", "가".repeat(1999)); // 코드포인트 2000
        assert!(parse_manifest(&with("llmContext", &llm)).is_ok());
        assert!(parse_manifest(&with("llmContext", &format!("가{llm}"))).is_err());

        let reason = format!("{}🎨", "가".repeat(199)); // 코드포인트 200
        let reasons = |v: &str| {
            format!(
                r#"{{"id":"sym","name":"Symmetric","version":"1.0.0","entry":"main.js","permissionReasons":{{"settings":"{v}"}}}}"#
            )
        };
        assert!(parse_manifest(&reasons(&reason)).is_ok());
        assert!(parse_manifest(&reasons(&format!("가{reason}"))).is_err());
    }

    /// 가드: 알 수 없는 kind·형식 오류 minHostVersion은 매니페스트
    /// 전체를 거부한다.
    #[test]
    fn parse_manifest_rejects_malformed_wave_a_fields() {
        let base = |extra: &str| {
            format!(r#"{{"id":"p","name":"P","version":"1.0.0","entry":"main.js"{extra}}}"#)
        };
        assert!(parse_manifest(&base(r#","kind":"widget""#)).is_err());
        assert!(parse_manifest(&base(r#","minHostVersion":"v1.0.0""#)).is_err());
        let long_purpose = format!(r#","purpose":"{}""#, "x".repeat(81));
        assert!(parse_manifest(&base(&long_purpose)).is_err());
        assert!(parse_manifest(&base(r#","permissionReasons":{"settings":42}"#)).is_err());
    }

    /// 가드: `exposes`(공개 명령 목록)가 파싱된다 — 없으면 빈 배열, 있으면 그대로.
    /// TS `manifest.ts`의 `exposes` 검증과 대칭(같은 입력, 같은 합격/거부).
    #[test]
    fn parse_manifest_reads_exposes() {
        // 없으면 빈 배열(기본 비공개).
        let none =
            parse_manifest(r#"{"id":"b","name":"B","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert!(none.exposes.is_empty());

        // 있으면 원문 순서대로.
        let some = parse_manifest(
            r#"{"id":"b","name":"B","version":"1.0.0","entry":"main.js",
                "exposes":["cmd1","cmd2"]}"#,
        )
        .unwrap();
        assert_eq!(some.exposes, vec!["cmd1", "cmd2"]);
    }

    /// 가드: `exposes`가 배열이 아니거나 항목이 비어있지 않은 문자열이 아니면 매니페스트
    /// 전체를 거부한다(TS `manifest.ts`와 같은 규칙 — 한쪽만 거부하면 CLI·설치 판정이 갈린다).
    #[test]
    fn parse_manifest_rejects_malformed_exposes() {
        let base = |extra: &str| {
            format!(r#"{{"id":"b","name":"B","version":"1.0.0","entry":"main.js"{extra}}}"#)
        };
        assert!(parse_manifest(&base(r#","exposes":"cmd1""#)).is_err()); // 배열 아님
        assert!(parse_manifest(&base(r#","exposes":["cmd1",""]"#)).is_err()); // 빈 문자열 항목
        assert!(parse_manifest(&base(r#","exposes":[42]"#)).is_err()); // 문자열 아님
    }

    /// 가드(축 2): `nls`가 없으면 None(하위호환 — nls 없는 기존 매니페스트 무변화). 있고
    /// `"default"` 사전을 포함하면 원문 그대로 실린다(해석은 프론트 소관, 여기는 형태만 본다).
    #[test]
    fn parse_manifest_reads_nls() {
        let none =
            parse_manifest(r#"{"id":"b","name":"B","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert!(none.nls.is_none());

        let some = parse_manifest(
            r#"{"id":"b","name":"%b.name%","version":"1.0.0","entry":"main.js",
                "nls":{"default":{"b.name":"기본 이름"},"en":{"b.name":"English Name"}}}"#,
        )
        .unwrap();
        let nls = some.nls.unwrap();
        assert_eq!(nls["default"]["b.name"], "기본 이름");
        assert_eq!(nls["en"]["b.name"], "English Name");
    }

    /// 가드(축 2): `nls`가 객체가 아니거나, 로케일 값이 객체가 아니거나, leaf가 문자열이
    /// 아니거나, `"default"` 사전이 없으면 매니페스트 전체를 거부한다(TS `manifest.ts`의
    /// `parseNls`와 같은 규칙 — 대칭 검증).
    #[test]
    fn parse_manifest_rejects_malformed_nls() {
        let base = |extra: &str| {
            format!(r#"{{"id":"b","name":"B","version":"1.0.0","entry":"main.js"{extra}}}"#)
        };
        assert!(parse_manifest(&base(r#","nls":"bad""#)).is_err()); // 객체 아님(문자열)
        assert!(parse_manifest(&base(r#","nls":["a"]"#)).is_err()); // 배열
        assert!(parse_manifest(&base(r#","nls":{"default":"bad"}"#)).is_err()); // 로케일 값이 객체 아님
        assert!(parse_manifest(&base(r#","nls":{"default":{"k":1}}"#)).is_err()); // leaf가 문자열 아님
        assert!(parse_manifest(&base(r#","nls":{"en":{"k":"v"}}"#)).is_err()); // default 사전 없음
    }

    /// 가드(호출측 자격): `invoke:<대상>`은 접두 매칭 민감 권한이라 매니페스트 파싱을
    /// 통과해야 한다(프론트 `permissions.ts`와 대칭). 이게 없으면 호출측이 `invoke:target`을
    /// 선언한 사이드로드 플러그인이 "알 수 없는 권한"으로 매니페스트째 거부돼, 대상의 exposes를
    /// 배선해도 설치 경로에서 여전히 죽는다.
    #[test]
    fn parse_manifest_accepts_invoke_prefix_permission() {
        let m = parse_manifest(
            r#"{"id":"a","name":"A","version":"1.0.0","entry":"main.js",
                "permissions":["invoke:copy-ai-prompt"]}"#,
        )
        .unwrap();
        assert_eq!(m.permissions, vec!["invoke:copy-ai-prompt"]);
    }

    /// 가드(사이드로드 종단): 매니페스트에 `exposes`를 선언한 설치 플러그인을 스캔하면
    /// 그 값이 `InstalledPlugin`까지 실려 프론트로 나간다(`contributes`·`llm_context`가 겪은
    /// 것과 같은 3중 배선 결함을 이 스캔 경로로 실증한다 — 이전엔 필드 자체가 없어 항상 빈 값이
    /// 프론트에 닿았고 `commands.invoke`가 설치 경로에서 항상 INVOKE_NOT_EXPOSED로 죽었다).
    #[test]
    fn scan_installed_report_carries_exposes() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let plug = plugins_dir(app_data).join("exposer");
        std::fs::create_dir_all(&plug).unwrap();
        std::fs::write(
            plug.join("manifest.json"),
            r#"{"id":"exposer","name":"공개자","version":"1.0.0","entry":"main.js",
                "permissions":["commands"],"exposes":["cmd1","cmd2"]}"#,
        )
        .unwrap();
        std::fs::write(plug.join("main.js"), "// code").unwrap();

        let list = scan_installed(app_data, &load_state(app_data));
        let found = list.iter().find(|p| p.id == "exposer").unwrap();
        assert_eq!(found.exposes, vec!["cmd1", "cmd2"]);
    }

    /// 가드(축 2 — 사이드로드 종단): 매니페스트에 `nls`를 선언한 설치 플러그인을 스캔하면
    /// 그 원문이 `InstalledPlugin`까지 실려 프론트로 나간다(`exposes`가 겪은 것과 같은 3중
    /// 배선 결함을 이 스캔 경로로 실증한다 — 필드 자체가 없으면 항상 빈 값이 프론트에 닿아
    /// `resolveInstalledPluginNls`가 해석할 사전을 영영 못 받는다).
    #[test]
    fn scan_installed_report_carries_nls() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let plug = plugins_dir(app_data).join("localized");
        std::fs::create_dir_all(&plug).unwrap();
        std::fs::write(
            plug.join("manifest.json"),
            r#"{"id":"localized","name":"%name%","version":"1.0.0","entry":"main.js",
                "nls":{"default":{"name":"기본 이름"},"en":{"name":"English"}}}"#,
        )
        .unwrap();
        std::fs::write(plug.join("main.js"), "// code").unwrap();

        let list = scan_installed(app_data, &load_state(app_data));
        let found = list.iter().find(|p| p.id == "localized").unwrap();
        assert_eq!(found.name, "%name%"); // 백엔드는 해석하지 않고 원문 그대로 나른다.
        let nls = found.nls.as_ref().unwrap();
        assert_eq!(nls["default"]["name"], "기본 이름");
        assert_eq!(nls["en"]["name"], "English");
    }

    /// 가드: scan_installed_report가 탈락 폴더를 사유와 함께 보고한다(이전엔 조용한
    /// continue로 사라졌다). 유효 플러그인은 여전히 valid에 담긴다.
    #[test]
    fn scan_installed_report_surfaces_rejections_with_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[]"); // 유효.

        let broken = plugins_dir(app_data).join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("manifest.json"), "{ not json").unwrap();
        std::fs::write(broken.join("main.js"), "// x").unwrap();

        let mismatch = plugins_dir(app_data).join("dirname");
        std::fs::create_dir_all(&mismatch).unwrap();
        std::fs::write(
            mismatch.join("manifest.json"),
            r#"{"id":"other","name":"N","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(mismatch.join("main.js"), "// x").unwrap();

        let no_entry = plugins_dir(app_data).join("noentry");
        std::fs::create_dir_all(&no_entry).unwrap();
        std::fs::write(
            no_entry.join("manifest.json"),
            r#"{"id":"noentry","name":"N","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();

        let report = scan_installed_report(app_data, &PluginsState::default());
        assert_eq!(report.valid.len(), 1);
        assert_eq!(report.valid[0].id, "alpha");
        assert_eq!(report.rejected.len(), 3);
        let by_dir = |name: &str| {
            report
                .rejected
                .iter()
                .find(|r| r.dir_name == name)
                .unwrap_or_else(|| panic!("{name}이(가) rejected에 없음"))
        };
        assert!(by_dir("broken").reason.contains("매니페스트 검증 실패"));
        assert!(by_dir("dirname")
            .reason
            .contains("폴더 이름과 매니페스트 id"));
        assert!(by_dir("noentry").reason.contains("entry 파일 없음"));

        // scan_installed(하위호환 래퍼)는 valid만 돌려준다 — 기존 호출부는 그대로 동작.
        assert_eq!(scan_installed(app_data, &PluginsState::default()).len(), 1);
    }

    /// 가드: 매니페스트 없음·entry 파일 없음·entry 경로 위조는 설치 거부.
    #[test]
    fn install_from_dir_rejects_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");

        // 매니페스트 없음.
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(install_from_dir(&app_data, &empty).is_err());

        // entry 파일 없음.
        let no_entry = dir.path().join("noentry");
        std::fs::create_dir_all(&no_entry).unwrap();
        std::fs::write(
            no_entry.join("manifest.json"),
            r#"{"id":"x","name":"X","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        assert!(install_from_dir(&app_data, &no_entry).is_err());

        // entry 경로 위조(상위 이동).
        let traversal = dir.path().join("traversal");
        std::fs::create_dir_all(&traversal).unwrap();
        std::fs::write(
            traversal.join("manifest.json"),
            r#"{"id":"x","name":"X","version":"1.0.0","entry":"../evil.js"}"#,
        )
        .unwrap();
        assert!(install_from_dir(&app_data, &traversal).is_err());
    }

    /// 가드: entry 코드 읽기 — 설치된 플러그인은 main.js 내용을, 미설치는 오류.
    #[test]
    fn read_plugin_code_reads_entry() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let pdir = plugins_dir(app_data).join("alpha");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("manifest.json"),
            r#"{"id":"alpha","name":"A","version":"1.0.0","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::write(pdir.join("main.js"), "memo.editor.registerCompletion({});").unwrap();

        assert_eq!(
            read_plugin_code(app_data, "alpha").unwrap(),
            "memo.editor.registerCompletion({});"
        );
        assert!(read_plugin_code(app_data, "ghost").is_err());
    }

    /// 가드: 상태 파일이 없으면 빈 상태, 저장 후엔 그 값을 읽는다(왕복 — 출처·무시 목록 포함).
    #[test]
    fn state_default_then_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        assert!(load_state(app_data).plugins.is_empty());

        let mut state = PluginsState::default();
        state.plugins.insert(
            "p".to_string(),
            PluginRecord {
                enabled: true,
                granted: vec!["notes:read".to_string()],
                version: Some("1.2.0".to_string()),
                source: Some(PluginSource::Git {
                    url: "https://example.com/p.git".to_string(),
                    git_ref: Some("v1.2.0".to_string()),
                }),
                ..Default::default()
            },
        );
        state.dismissed_missing = vec!["ghost".to_string()];
        save_state(app_data, &state).unwrap();
        assert_eq!(load_state(app_data), state);
    }

    /// 가드: 구버전 상태 파일(version/source/dismissed 없음)도 그대로 읽힌다(하위 호환).
    #[test]
    fn state_back_compat_without_new_fields() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        write_atomic(
            &state_path(app_data),
            r#"{"plugins":{"old":{"enabled":true,"granted":["notes:read"]}}}"#,
        )
        .unwrap();
        let state = load_state(app_data);
        let record = state.plugins.get("old").unwrap();
        assert!(record.enabled);
        assert_eq!(record.version, None);
        assert_eq!(record.source, None);
        assert!(state.dismissed_missing.is_empty());
    }

    /// 가드: 출처 직렬화 형태를 고정한다 — vault 목록과 프론트가 이 태그 형태에 의존한다.
    #[test]
    fn plugin_source_serde_shape() {
        let url = PluginSource::Url {
            url: "https://x/p.zip".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&url).unwrap(),
            r#"{"type":"url","url":"https://x/p.zip"}"#
        );

        let git = PluginSource::Git {
            url: "https://x/p.git".to_string(),
            git_ref: Some("v1".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&git).unwrap(),
            r#"{"type":"git","url":"https://x/p.git","ref":"v1"}"#
        );
        // ref 없는 git은 ref 키를 아예 쓰지 않는다.
        let git_no_ref = PluginSource::Git {
            url: "https://x/p.git".to_string(),
            git_ref: None,
        };
        assert_eq!(
            serde_json::to_string(&git_no_ref).unwrap(),
            r#"{"type":"git","url":"https://x/p.git"}"#
        );

        assert_eq!(
            serde_json::to_string(&PluginSource::Local).unwrap(),
            r#"{"type":"local"}"#
        );
        // 왕복.
        let back: PluginSource =
            serde_json::from_str(r#"{"type":"git","url":"https://x/p.git","ref":"v1"}"#).unwrap();
        assert_eq!(back, git);
    }

    /// 가드: 출처를 기록하지 않은(구버전) 설치는 스캔에서 Local로 나타난다.
    #[test]
    fn scan_defaults_source_to_local() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        make_plugin(app_data, "alpha", "[\"editor\"]");
        let list = scan_installed(app_data, &PluginsState::default());
        assert_eq!(list[0].source, PluginSource::Local);
    }

    /// 가드: 무시(dismiss)가 정렬·중복 없이 영속되고, 빈 id는 거부된다.
    #[test]
    fn dismiss_missing_persists_sorted_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        dismiss_missing(app_data, "zeta").unwrap();
        dismiss_missing(app_data, "alpha").unwrap();
        dismiss_missing(app_data, "zeta").unwrap(); // 중복은 한 번만.
        assert_eq!(
            load_state(app_data).dismissed_missing,
            vec!["alpha", "zeta"]
        );
        assert!(dismiss_missing(app_data, "").is_err());
    }

    /// 가드: 빌트인 활성 토글이 builtins 맵에 영속화된다(기록 없음=프론트가 기본 켜짐으로 해석).
    #[test]
    fn set_builtin_enabled_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        // 기본: 기록 없음(프론트가 켜짐으로 해석).
        assert!(load_state(app_data).builtins.is_empty());

        set_builtin_enabled(app_data, "wikilink", false).unwrap();
        assert_eq!(load_state(app_data).builtins.get("wikilink"), Some(&false));

        set_builtin_enabled(app_data, "wikilink", true).unwrap();
        assert_eq!(load_state(app_data).builtins.get("wikilink"), Some(&true));
        // 설치 플러그인 맵과 분리돼 있다(간섭 없음).
        assert!(load_state(app_data).plugins.is_empty());
    }

    /// 가드: 빌트인 설정 값이 왕복 저장되고, 예약 키는 거부되며, 다른 맵과 분리된다.
    #[test]
    fn set_builtin_setting_roundtrip_and_rejects_reserved() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();

        set_builtin_setting(
            app_data,
            "copy-ai-prompt",
            "template",
            serde_json::json!("고쳐줘 {path}"),
        )
        .unwrap();
        assert_eq!(
            load_state(app_data)
                .builtin_settings
                .get("copy-ai-prompt")
                .unwrap()
                .get("template")
                .unwrap(),
            &serde_json::json!("고쳐줘 {path}")
        );

        // 예약 키(프로토타입 오염 여지)는 거부.
        assert!(set_builtin_setting(app_data, "x", "__proto__", serde_json::json!(1)).is_err());
        // 설치 플러그인 맵과는 분리(간섭 없음).
        assert!(load_state(app_data).plugins.is_empty());
    }

    /// 가드: 유효한 설정 스키마는 통과하고, 형식 오류(키·타입·select options·비배열)는 거부한다.
    #[test]
    fn parse_manifest_validates_settings_schema() {
        let ok = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["settings"],
                "settings":[
                  {"key":"showBrackets","label":"괄호","type":"toggle","default":true},
                  {"key":"style","label":"스타일","type":"select","options":["a","b"],"default":"b"},
                  {"key":"prefix","label":"접두사","type":"text"},
                  {"key":"body","label":"본문","type":"textarea","default":"여러\n줄"}
                ]}"#,
        )
        .unwrap();
        assert_eq!(ok.settings.len(), 4);
        assert_eq!(ok.settings[0].key, "showBrackets");
        assert_eq!(ok.settings[0].kind, "toggle");
        // 문자열 축약형 options는 Short로 보존된다(값 = 라벨).
        let opt_values: Vec<&str> = ok.settings[1].options.iter().map(|o| o.value()).collect();
        assert_eq!(opt_values, vec!["a", "b"]);
        // textarea(여러 줄) 타입도 허용되고 여러 줄 기본값이 보존된다.
        assert_eq!(ok.settings[3].kind, "textarea");
        assert_eq!(ok.settings[3].default, serde_json::json!("여러\n줄"));
        // textarea에 default가 없으면 빈 문자열(text와 동일 폴백).
        let ta = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"body","label":"본문","type":"textarea"}]}"#,
        )
        .unwrap();
        assert_eq!(
            default_setting_value(&ta.settings[0]),
            serde_json::json!("")
        );
        // description은 선택 — 선언 안 하면 None.
        assert!(ok.settings[0].description.is_none());

        // description을 선언하면 파싱돼 프론트로 전달된다(설정 UI 도움말).
        let desc = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["settings"],
                "settings":[{"key":"template","label":"문구","type":"text","description":"변수: {path}, {content}"}]}"#,
        )
        .unwrap();
        assert_eq!(
            desc.settings[0].description.as_deref(),
            Some("변수: {path}, {content}")
        );

        // settings 생략 → 빈 스키마(하위호환).
        let none =
            parse_manifest(r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js"}"#).unwrap();
        assert!(none.settings.is_empty());

        // 잘못된 키 형식 / 알 수 없는 타입 / select인데 options 없음 / settings 비배열 → 모두 거부.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"bad key","label":"L","type":"text"}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"slider"}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"select"}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":{}}"#
        )
        .is_err());
        // JS 예약 키(__proto__/constructor/prototype)는 프로토타입 오염 여지 → 거부.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"__proto__","label":"L","type":"text"}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"constructor","label":"L","type":"text"}]}"#
        )
        .is_err());
    }

    /// 가드: `button` 타입은 `command`를 요구하고, `confirm`까지 프론트로 실려 나간다.
    ///
    /// 왜 값이 실렸는지까지 보나: 검증만 통과시키고 필드를 떨어뜨리면 설정 화면은 실행할
    /// 명령을 모르는 버튼을 그린다 — 이 저장소가 겪은 "IPC 경계에서 값이 통째로 버려진다"와
    /// 같은 모양이다.
    #[test]
    fn parse_manifest_validates_settings_action_button() {
        let ok = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","permissions":["commands"],
                "settings":[{"key":"clearCache","label":"캐시 지우기","type":"button",
                             "command":"clear-cache","confirm":"정말 지울까요?"}]}"#,
        )
        .unwrap();
        assert_eq!(ok.settings[0].kind, "button");
        assert_eq!(ok.settings[0].command.as_deref(), Some("clear-cache"));
        assert_eq!(ok.settings[0].confirm.as_deref(), Some("정말 지울까요?"));

        // command 없음 / 공백뿐 → 눌러도 아무 일이 없는 버튼이므로 매니페스트 전체를 거부한다.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"button"}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"button","command":"   "}]}"#
        )
        .is_err());
    }

    /// 가드: `button`은 값이 없는 필드다 — `resolve_settings`가 그 키를 만들지 않는다.
    ///
    /// 채우면 아무도 읽지 않는 키가 상태 파일에 영원히 남고, 플러그인의 `settings.get`이
    /// null이 아니라 ""를 받아 "값이 있는 설정"으로 오해된다. 프론트 `mergeSettingDefaults`와
    /// 같은 규칙이어야 한다(두 경로가 같은 값을 봐야 한다).
    #[test]
    fn resolve_settings_skips_button_fields() {
        let manifest = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","permissions":["commands"],
                "settings":[{"key":"tone","label":"톤","type":"text","default":"soft"},
                            {"key":"act","label":"실행","type":"button","command":"go"}]}"#,
        )
        .unwrap();
        let resolved = resolve_settings(&manifest.settings, &BTreeMap::new());
        assert_eq!(resolved.get("tone"), Some(&serde_json::json!("soft")));
        assert!(!resolved.contains_key("act"));
    }

    /// 가드: `select` options의 객체형 `{value,label,description?}`을 받아들이고, 저장 값은
    /// 라벨이 아니라 **value**다(기본값 폴백 포함). 축약형 문자열과 섞여 있어도 된다.
    #[test]
    fn parse_manifest_accepts_option_objects_and_defaults_to_value() {
        let m = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["settings"],
                "settings":[{"key":"mode","label":"방식","type":"select",
                  "options":[{"value":"cursor","label":"커서 위치","description":"현재 커서 자리"},
                             {"value":"append","label":"문서 끝"},
                             "replace"]}]}"#,
        )
        .unwrap();
        let opts = &m.settings[0].options;
        assert_eq!(opts.len(), 3);
        let values: Vec<&str> = opts.iter().map(|o| o.value()).collect();
        assert_eq!(values, vec!["cursor", "append", "replace"]);
        // default 미선언 → 첫 선택지의 value("커서 위치"라는 라벨이 아니다).
        assert_eq!(
            default_setting_value(&m.settings[0]),
            serde_json::json!("cursor")
        );
        // 객체형 options는 직렬화에서 형태가 보존된다(프론트가 label·description을 그린다).
        let json = serde_json::to_value(&m.settings[0].options).unwrap();
        assert_eq!(json[0]["label"], serde_json::json!("커서 위치"));
        assert_eq!(json[0]["description"], serde_json::json!("현재 커서 자리"));
        assert_eq!(json[2], serde_json::json!("replace"));
        // value 없는 객체 · 문자열도 객체도 아닌 항목은 거부.
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"select","options":[{"label":"값 없음"}]}]}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"k","label":"L","type":"select","options":[7]}]}"#
        )
        .is_err());
    }

    /// 가드: `type:"number"`를 허용하고 min/max/step을 파싱한다. default 미선언이면
    /// min(없으면 0)이 기본값이다 — 범위 밖 0이 기본으로 새지 않게.
    #[test]
    fn parse_manifest_accepts_number_type_with_bounds() {
        let m = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"main.js","permissions":["settings"],
                "settings":[{"key":"stepPct","label":"증감 폭","type":"number","min":5,"max":50,"step":5}]}"#,
        )
        .unwrap();
        let f = &m.settings[0];
        assert_eq!(f.kind, "number");
        assert_eq!(f.min, Some(5.0));
        assert_eq!(f.max, Some(50.0));
        assert_eq!(f.step, Some(5.0));
        assert_eq!(default_setting_value(f), serde_json::json!(5.0));
        // min이 없으면 0.
        let plain = parse_manifest(
            r#"{"id":"p","name":"P","version":"1.0.0","entry":"m.js","settings":[{"key":"n","label":"N","type":"number"}]}"#,
        )
        .unwrap();
        assert_eq!(
            default_setting_value(&plain.settings[0]),
            serde_json::json!(0.0)
        );
    }

    /// 가드: 설정 값 저장은 선언 키만 허용하고 왕복 반영된다(미선언 키·미설치는 오류).
    #[test]
    fn set_setting_clamps_to_declared_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let pdir = plugins_dir(app_data).join("cfg");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("manifest.json"),
            r#"{"id":"cfg","name":"Cfg","version":"1.0.0","entry":"main.js","permissions":["settings"],"settings":[{"key":"tone","label":"톤","type":"text","default":"soft"}]}"#,
        )
        .unwrap();
        std::fs::write(pdir.join("main.js"), "// code").unwrap();

        // 저장 값이 없으면 스캔이 기본값을 채운다.
        let list = scan_installed(app_data, &load_state(app_data));
        assert_eq!(list[0].settings.get("tone").unwrap(), "soft");
        assert_eq!(list[0].settings_schema.len(), 1);

        // 선언된 키 저장 → 왕복 반영.
        set_setting(app_data, "cfg", "tone", serde_json::json!("loud")).unwrap();
        let list = scan_installed(app_data, &load_state(app_data));
        assert_eq!(list[0].settings.get("tone").unwrap(), "loud");

        // 미선언 키·미설치 플러그인은 거부.
        assert!(set_setting(app_data, "cfg", "ghost", serde_json::json!(1)).is_err());
        assert!(set_setting(app_data, "nope", "tone", serde_json::json!("x")).is_err());
    }

    /// 가드: 스캔이 스키마 밖 옛 값(stale)은 버리고, 없는 키는 기본값으로 채운다.
    #[test]
    fn scan_resolves_settings_against_schema() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let pdir = plugins_dir(app_data).join("cfg");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("manifest.json"),
            r#"{"id":"cfg","name":"Cfg","version":"1.0.0","entry":"main.js","settings":[{"key":"keep","label":"K","type":"toggle","default":true}]}"#,
        )
        .unwrap();
        std::fs::write(pdir.join("main.js"), "// code").unwrap();

        // 상태에 스키마 밖 키(stale)를 심는다(keep은 저장값 없음 → 기본값으로 채워져야 함).
        let mut state = PluginsState::default();
        let mut vals = BTreeMap::new();
        vals.insert("stale".to_string(), serde_json::json!("x"));
        state.plugins.insert(
            "cfg".to_string(),
            PluginRecord {
                settings: vals,
                ..Default::default()
            },
        );

        let list = scan_installed(app_data, &state);
        assert_eq!(list[0].settings.len(), 1);
        assert_eq!(
            list[0].settings.get("keep").unwrap(),
            &serde_json::json!(true)
        );
        assert!(!list[0].settings.contains_key("stale"));
    }
}
