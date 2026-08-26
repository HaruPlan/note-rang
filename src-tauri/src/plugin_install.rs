//! 플러그인 네트워크 설치(URL zip · git) — 스테이징 → 승인 → 확정의 2단계 플로우.
//!
//! 역할: https zip 다운로드(시스템 curl)/git 클론(시스템 git)/로컬 폴더를 앱데이터
//! `plugins-staging/<token>/`에 준비하고 매니페스트를 검증해 미리보기([`InstallPreview`])를
//! 만든다. 사용자가 권한을 승인하면 그 스테이징 바이트 그대로 기존
//! [`plugins::install_from_dir`] 경로로 확정 설치하고, vault 참조 목록에 upsert한다.
//! 왜: 미리보기와 설치가 **같은 바이트**를 쓰게(승인 후 재다운로드 금지 — TOCTOU 방지)
//! 2단계(fetch→confirm/cancel)로 나누고, zip-slip·심볼릭 링크·크기 상한·https-only를
//! 설치 경로 진입 전에 강제한다. 거부/실패 시 스테이징을 지워 부분 설치 잔여물을 남기지 않는다.

use crate::io::{read_to_string, write_atomic};
use crate::plugin_sync::{self, VaultPluginEntry};
use crate::plugins::{self, PluginManifest, PluginSource};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 설치 안전 상한(다운로드·압축해제 폭탄 방어). 테스트에서 작은 값을 주입한다.
pub struct InstallLimits {
    /// 다운로드 아카이브 최대 바이트.
    pub max_archive_bytes: u64,
    /// 압축 해제(또는 git 체크아웃) 총합 최대 바이트.
    pub max_unpacked_bytes: u64,
    /// zip 엔트리 최대 개수.
    pub max_entries: usize,
}

/// 기본 상한 — 플러그인(manifest + JS 몇 개)에 넉넉하고 폭탄에는 부족한 크기.
pub const DEFAULT_LIMITS: InstallLimits = InstallLimits {
    max_archive_bytes: 10 * 1024 * 1024,
    max_unpacked_bytes: 20 * 1024 * 1024,
    max_entries: 256,
};

/// 설치 미리보기 — 승인 프롬프트가 표시할 정보(스테이징 토큰 + 매니페스트 + 현재 설치 상태).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallPreview {
    /// 스테이징 토큰(confirm/cancel에 되돌려 준다).
    pub staging: String,
    /// 검증된 매니페스트(선언 권한 포함 — 프롬프트의 승인 대상).
    pub manifest: PluginManifest,
    /// 확정 시 기록될 설치 출처.
    pub source: PluginSource,
    /// 같은 id가 이미 설치돼 있으면 그 버전(업데이트/최신 판단용).
    pub installed_version: Option<String>,
    /// 이미 설치된 경우 현재 선언 권한(새로 추가된 민감 권한 diff 계산용).
    pub installed_permissions: Vec<String>,
    /// 이미 설치된 경우 로컬 부여 권한(업데이트 시 기존 부여 유지 계산용).
    pub installed_granted: Vec<String>,
}

/// 스테이징에 출처를 기록하는 사이드카 파일 이름(확정 시 로컬 상태·vault 목록에 옮겨 적는다).
///
/// 프론트가 보내는 값을 믿지 않고 fetch 시점의 출처를 서버가 보관한다(출처 위조 방지).
const SOURCE_FILE: &str = ".memo-source.json";

/// 스테이징 루트(`<app_data>/plugins-staging`) — 승인 대기 중인 설치 후보가 놓인다.
fn staging_root(app_data: &Path) -> PathBuf {
    app_data.join("plugins-staging")
}

/// 스테이징 토큰이 uuid v4 소문자 하이픈 형식인지 검사한다.
///
/// 역할: confirm/cancel이 받은 토큰이 경로 조작(`../` 등)으로 스테이징 밖을 가리키지
/// 못하게 형식을 강제한다(신뢰 경계: 토큰은 프론트를 왕복한 값).
fn is_valid_token(token: &str) -> bool {
    token.len() == 36
        && token
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f' | '-'))
}

/// 유효한 토큰의 스테이징 디렉터리 경로를 돌려준다(형식 오류면 None → 조작 차단).
fn staged_dir(app_data: &Path, token: &str) -> Option<PathBuf> {
    is_valid_token(token).then(|| staging_root(app_data).join(token))
}

/// 새 스테이징 디렉터리를 만든다. 이전 스테이징 잔여물은 전부 비운다(단일 설치 플로우 모델).
fn new_staging_dir(app_data: &Path) -> Result<(String, PathBuf), String> {
    let root = staging_root(app_data);
    let _ = std::fs::remove_dir_all(&root); // 이전 실행 잔여물 정리(없으면 무시).
    let token = uuid::Uuid::new_v4().to_string();
    let dir = root.join(&token);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((token, dir))
}

/// 실패 시 스테이징 디렉터리를 지우고 오류를 그대로 돌려준다(부분 설치 잔여물 방지).
fn cleaned_on_err<T>(dir: &Path, result: Result<T, String>) -> Result<T, String> {
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

/// 설치 출처 URL이 https인지 검증한다(그 외 스킴·빈 호스트·공백/제어문자 거부).
///
/// 역할: 원격 설치의 유일한 허용 스킴을 https로 못박는다(평문 http·file·ssh 금지).
/// 왜: 다운로드/클론 모두 공개 API 진입점에서 걸러 시스템 도구(curl/git)에 닿기 전에 막고,
/// curl에는 `--proto '=https'`를 함께 걸어 이중으로 강제한다.
pub fn validate_https_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("https URL만 설치할 수 있습니다: {url}"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("URL 형식이 올바르지 않습니다: {url}"));
    }
    Ok(())
}

/// 바이트가 zip 아카이브(로컬 파일 헤더 `PK\x03\x04`)로 시작하는지 확인한다.
fn is_zip_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

/// 다운로드용 curl 인자를 만든다(순수 함수 — https 강제·상한 옵션을 테스트로 고정).
///
/// `--proto/--proto-redir '=https'`로 리다이렉트 포함 https만 허용, `--max-filesize`로
/// (서버가 크기를 알릴 때) 조기 중단, `--fail`로 4xx/5xx를 오류로 만들고 본문은 stdout으로
/// 받는다(임시 파일 없음). URL은 `--` 뒤에 둬 옵션 주입을 차단한다.
fn curl_args(url: &str, limits: &InstallLimits) -> Vec<String> {
    [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-redirs",
        "3",
        "--max-time",
        "60",
        "--max-filesize",
        &limits.max_archive_bytes.to_string(),
        "--output",
        "-",
        "--",
        url,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 읽기 스트림에서 최대 cap 바이트까지만 읽는다(초과가 드러나는 즉시 중단·오류).
///
/// 역할: 다운로드 본문을 전부 버퍼링한 뒤 검사하는 대신 **읽는 도중** 상한을 강제한다 —
/// 청크 전송처럼 서버가 크기를 알리지 않아 curl `--max-filesize`가 못 잡는 응답도
/// cap+1 바이트에서 끊겨 메모리·시간 소비가 상한에 묶인다(zip 해제의 take 패턴과 동일).
/// curl 실행과 분리해 임의 reader 픽스처로 테스트한다.
fn read_capped(reader: impl Read, cap: u64) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    reader
        .take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("다운로드 스트림 읽기 실패: {e}"))?;
    if buf.len() as u64 > cap {
        return Err("다운로드 크기가 상한을 초과합니다".to_string());
    }
    Ok(buf)
}

/// https URL에서 아카이브를 내려받아 바이트로 돌려준다(시스템 curl — macOS 기본 탑재).
///
/// 역할: 얇은 IO 껍데기 — 인자 구성([`curl_args`])·상한 읽기([`read_capped`])·이후
/// 처리([`stage_from_zip_bytes`])는 분리해 테스트하고, 여기서는 프로세스 실행/정리만 한다.
/// 본문은 stdout 파이프에서 상한까지만 읽고, 초과 시 curl을 즉시 종료시킨다(잔여 전송 차단).
fn download_https(url: &str, limits: &InstallLimits) -> Result<Vec<u8>, String> {
    let mut child = Command::new("curl")
        .args(curl_args(url, limits))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl 실행 실패: {e}"))?;
    let stdout = child.stdout.take().ok_or("curl stdout 파이프 없음")?;
    let body = read_capped(stdout, limits.max_archive_bytes);
    if body.is_err() {
        // 상한 초과/읽기 실패 — 남은 전송을 즉시 중단한다(파이프도 위에서 닫힘).
        let _ = child.kill();
    }
    // 종료를 수거해 좀비를 막고 stderr(오류 메시지)를 모은다.
    let out = child
        .wait_with_output()
        .map_err(|e| format!("curl 종료 대기 실패: {e}"))?;
    let body = body?; // 상한 초과가 kill로 인한 종료 코드 오류에 가려지지 않게 먼저 전파.
    if !out.status.success() {
        return Err(format!(
            "다운로드 실패: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(body)
}

/// zip 바이트를 dest에 안전하게 푼다 — zip-slip·심볼릭 링크·상한 방어의 단일 지점.
///
/// 역할: 엔트리마다 (1) 심볼릭 링크 거부, (2) `enclosed_name`으로 경로 탈출(`..`/절대경로)
/// 거부, (3) 엔트리 수·총 해제 크기 상한을 강제하며 일반 파일/디렉터리만 만든다. 크기는
/// 헤더 선언이 아니라 **실제로 읽은 바이트**로 계산한다(헤더 위조 방어).
///
/// `pub(crate)`인 이유: 백업 가져오기([`crate::backup`])도 사용자가 고른 zip을 푼다 — 같은
/// 위협(경로 탈출·심링크·압축 폭탄)에 두 번째 구현을 두면 한쪽만 고쳐지는 날이 온다. 상한만
/// 호출부가 정하고 방어는 이 함수 하나에 남긴다.
pub(crate) fn extract_zip(bytes: &[u8], dest: &Path, limits: &InstallLimits) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("zip 열기 실패: {e}"))?;
    if archive.len() > limits.max_entries {
        return Err(format!(
            "zip 엔트리가 너무 많습니다({}개, 상한 {}개)",
            archive.len(),
            limits.max_entries
        ));
    }
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("zip 엔트리 읽기 실패: {e}"))?;
        if entry.is_symlink() {
            return Err(format!(
                "심볼릭 링크 엔트리는 허용되지 않습니다: {}",
                entry.name()
            ));
        }
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("경로 탈출 엔트리를 거부합니다: {}", entry.name()));
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        // 남은 예산 + 1바이트까지만 읽어, 초과분이 있으면(= 예산보다 많이 읽힘) 거부한다.
        let budget = limits.max_unpacked_bytes.saturating_sub(total);
        let mut buf = Vec::new();
        entry
            .take(budget + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("zip 엔트리 해제 실패: {e}"))?;
        if buf.len() as u64 > budget {
            return Err("압축 해제 크기가 상한을 초과합니다".to_string());
        }
        total += buf.len() as u64;
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&out, &buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 디렉터리 트리에 심볼릭 링크가 하나라도 있으면 거부한다(재귀).
///
/// 역할: git 체크아웃(저장소가 심링크를 담을 수 있음)·zip 해제 결과를 설치 전에 걸러,
/// 이후 매니페스트/entry 읽기가 스테이징 밖 파일(자격증명 등)을 따라가지 못하게 한다.
fn reject_symlinks(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "심볼릭 링크가 포함돼 설치를 거부합니다: {}",
                path.display()
            ));
        }
        if meta.is_dir() {
            reject_symlinks(&path)?;
        }
    }
    Ok(())
}

/// 디렉터리 트리 총 바이트(재귀 — git 체크아웃 크기 상한 검사용).
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            total += dir_size(&path);
        } else {
            total += meta.len();
        }
    }
    total
}

/// git ref 형식을 보수적으로 검증한다(브랜치·태그·커밋 SHA만 통과).
///
/// 역할: ref는 `--` 뒤 위치 인자라 옵션 주입은 안 되지만, 콜론 refspec(`HEAD:refs/x` —
/// fetch의 의미를 바꿈)·공백·선행 `-`/`.`/`/` 같은 형태가 그대로 전달되는 것을 막는다.
/// 허용: 첫 글자 영숫자·`_`, 이후 `[A-Za-z0-9._/-]`. 빈 문자열/None은 호출부가 HEAD로 본다.
fn validate_git_ref(git_ref: &str) -> Result<(), String> {
    let mut chars = git_ref.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() || c == '_' => {}
        _ => return Err(format!("git ref 형식이 올바르지 않습니다: {git_ref}")),
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-')) {
        Ok(())
    } else {
        Err(format!("git ref 형식이 올바르지 않습니다: {git_ref}"))
    }
}

/// 스테이징 안에서 실행할 git 하위명령 목록을 만든다(순수 함수 — 테스트로 고정).
///
/// `init → fetch --depth 1 <src> <ref|HEAD> → checkout FETCH_HEAD` 순서라 브랜치·태그·
/// 커밋 SHA를 한 경로로 지원한다(`clone --branch`는 SHA를 못 받는다). 소스는 `--` 뒤에
/// 둬 옵션 주입을 차단하고, ref는 [`validate_git_ref`]를 통과한 값만 들어온다.
fn git_steps(src: &str, git_ref: Option<&str>) -> Vec<Vec<String>> {
    vec![
        vec!["init".into(), "--quiet".into()],
        vec![
            "fetch".into(),
            "--quiet".into(),
            "--depth".into(),
            "1".into(),
            "--".into(),
            src.into(),
            git_ref.unwrap_or("HEAD").into(),
        ],
        vec![
            "-c".into(),
            "advice.detachedHead=false".into(),
            "checkout".into(),
            "--quiet".into(),
            "--detach".into(),
            "FETCH_HEAD".into(),
        ],
    ]
}

/// git 저장소를 스테이징 디렉터리로 얕게 받아온다(시스템 git, 자격증명 프롬프트 차단).
fn git_fetch_checkout(src: &str, git_ref: Option<&str>, dest: &Path) -> Result<(), String> {
    for step in git_steps(src, git_ref) {
        let out = Command::new("git")
            .args(&step)
            .current_dir(dest)
            .env("GIT_TERMINAL_PROMPT", "0") // 인증 프롬프트로 멈추지 않게(즉시 실패).
            .output()
            .map_err(|e| format!("git 실행 실패: {e}"))?;
        if !out.status.success() {
            // 메시지용 하위명령 이름(옵션이 아닌 첫 인자).
            let sub = step
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(String::as_str)
                .unwrap_or("git");
            return Err(format!(
                "git {sub} 실패: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(())
}

/// 풀린 트리에서 플러그인 루트(manifest.json이 있는 곳)를 찾는다.
///
/// 역할: (a) 루트에 manifest가 있는 형태와 (b) GitHub 아카이브처럼 최상위 폴더 하나로
/// 감싼 형태를 지원한다. 숨김 항목(`.git`·`.memo-source.json`)과 `__MACOSX`는 무시한다.
fn find_plugin_root(dir: &Path) -> Result<PathBuf, String> {
    if dir.join("manifest.json").is_file() {
        return Ok(dir.to_path_buf());
    }
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "__MACOSX" {
            continue;
        }
        if entry.path().is_dir() {
            dirs.push(entry.path());
        }
    }
    match dirs.as_slice() {
        [single] if single.join("manifest.json").is_file() => Ok(single.clone()),
        _ => Err("manifest.json을 찾을 수 없습니다".to_string()),
    }
}

/// 이미 설치된 같은 id의 현재 상태(버전·선언 권한·로컬 부여)를 읽는다(미리보기용).
///
/// 역할: 승인 프롬프트가 업데이트 여부와 "새로 추가된 민감 권한" diff를 계산할 근거를 준다.
fn current_install_info(app_data: &Path, id: &str) -> (Option<String>, Vec<String>, Vec<String>) {
    let manifest_path = plugins::plugins_dir(app_data)
        .join(id)
        .join("manifest.json");
    let Some(manifest) = read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| plugins::parse_manifest(&raw).ok())
    else {
        return (None, Vec::new(), Vec::new());
    };
    let state = plugins::load_state(app_data);
    let granted = state
        .plugins
        .get(id)
        .map(|r| {
            r.granted
                .iter()
                .filter(|g| manifest.permissions.contains(g))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    (Some(manifest.version), manifest.permissions, granted)
}

/// 스테이징 공통 마무리 — 매니페스트 검증, entry 확인, 출처 기록, 미리보기 생성.
///
/// 역할: 모든 출처(zip/git/로컬)가 같은 검증을 통과하게 하는 수렴 지점. 실패는 호출부의
/// [`cleaned_on_err`]가 스테이징을 정리한다.
fn finish_staging(
    app_data: &Path,
    token: String,
    dir: &Path,
    source: PluginSource,
) -> Result<InstallPreview, String> {
    let root = find_plugin_root(dir)?;
    let raw = read_to_string(&root.join("manifest.json")).map_err(|_| "manifest.json 없음")?;
    let manifest = plugins::parse_manifest(&raw)?;
    if !root.join(&manifest.entry).is_file() {
        return Err(format!("entry 파일 없음: {}", manifest.entry));
    }
    let source_json = serde_json::to_string(&source).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(SOURCE_FILE), &source_json).map_err(|e| e.to_string())?;

    let (installed_version, installed_permissions, installed_granted) =
        current_install_info(app_data, &manifest.id);
    Ok(InstallPreview {
        staging: token,
        manifest,
        source,
        installed_version,
        installed_permissions,
        installed_granted,
    })
}

/// zip 바이트에서 설치 후보를 스테이징한다(다운로드와 분리 — 픽스처 바이트로 테스트).
///
/// 역할: zip 시그니처 확인 → 안전 해제([`extract_zip`]) → 심링크 재검(벨트+멜빵) →
/// 공통 검증([`finish_staging`]). 어느 단계든 실패하면 스테이징을 지운다.
pub fn stage_from_zip_bytes(
    app_data: &Path,
    bytes: &[u8],
    source: PluginSource,
    limits: &InstallLimits,
) -> Result<InstallPreview, String> {
    let (token, dir) = new_staging_dir(app_data)?;
    let result = (|| {
        if !is_zip_bytes(bytes) {
            return Err("zip 아카이브가 아닙니다".to_string());
        }
        extract_zip(bytes, &dir, limits)?;
        reject_symlinks(&dir)?;
        finish_staging(app_data, token, &dir, source)
    })();
    cleaned_on_err(&dir, result)
}

/// https URL의 zip 아카이브에서 설치 후보를 스테이징한다(요구사항 1-a).
pub fn stage_from_url(
    app_data: &Path,
    url: &str,
    limits: &InstallLimits,
) -> Result<InstallPreview, String> {
    validate_https_url(url)?;
    let bytes = download_https(url, limits)?;
    stage_from_zip_bytes(
        app_data,
        &bytes,
        PluginSource::Url {
            url: url.to_string(),
        },
        limits,
    )
}

/// git 소스(경로/URL)에서 설치 후보를 스테이징한다 — 내부 코어(테스트는 로컬 경로 픽스처).
///
/// 역할: ref 살균([`validate_git_ref`], 빈 문자열은 HEAD 취급) 후 얕은 fetch/checkout,
/// 체크아웃 크기 상한·심링크를 검사하고 공통 검증으로 넘긴다.
/// 공개 진입점([`stage_from_git`])이 https를 강제하므로 여기는 스킴을 다시 검사하지 않는다.
fn stage_from_git_source(
    app_data: &Path,
    src: &str,
    git_ref: Option<&str>,
    limits: &InstallLimits,
) -> Result<InstallPreview, String> {
    // ref를 스테이징 생성 전에 살균한다(형식 오류는 잔여물 없이 즉시 거부).
    let git_ref = match git_ref {
        None | Some("") => None,
        Some(r) => {
            validate_git_ref(r)?;
            Some(r)
        }
    };
    let (token, dir) = new_staging_dir(app_data)?;
    let result = (|| {
        git_fetch_checkout(src, git_ref, &dir)?;
        if dir_size(&dir) > limits.max_unpacked_bytes {
            return Err("저장소 크기가 상한을 초과합니다".to_string());
        }
        reject_symlinks(&dir)?;
        finish_staging(
            app_data,
            token,
            &dir,
            PluginSource::Git {
                url: src.to_string(),
                git_ref: git_ref.map(str::to_string),
            },
        )
    })();
    cleaned_on_err(&dir, result)
}

/// https git 저장소에서 설치 후보를 스테이징한다(요구사항 1-b — 커밋/태그 ref 지원).
pub fn stage_from_git(
    app_data: &Path,
    url: &str,
    git_ref: Option<&str>,
    limits: &InstallLimits,
) -> Result<InstallPreview, String> {
    validate_https_url(url)?;
    stage_from_git_source(app_data, url, git_ref, limits)
}

/// 로컬 폴더에서 설치 후보를 스테이징한다(수동 사이드로드 — 같은 승인 플로우를 태운다).
///
/// 역할: 필수 두 파일(manifest + entry)은 항상 옮기고, README.md + 1단계 아래 이미지
/// 에셋은 [`plugins::install_from_dir`]과 동일한 닫힌 화이트리스트로 옮긴다(이전엔
/// 이 두 파일만 옮겨 로컬 사이드로드는 README/이미지가 항상 유실됐다. zip/git 경로는 스테이징
/// 시점에 전체 트리를 받으므로 원래도 안 겪던 결함). 그 외 임의 파일은 들이지 않는다.
pub fn stage_from_local_dir(app_data: &Path, src_dir: &Path) -> Result<InstallPreview, String> {
    let (token, dir) = new_staging_dir(app_data)?;
    let result = (|| {
        let raw =
            read_to_string(&src_dir.join("manifest.json")).map_err(|_| "manifest.json 없음")?;
        let manifest = plugins::parse_manifest(&raw)?;
        let entry_code = read_to_string(&src_dir.join(&manifest.entry))
            .map_err(|_| format!("entry 파일 없음: {}", manifest.entry))?;
        write_atomic(&dir.join("manifest.json"), &raw).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(&manifest.entry), &entry_code).map_err(|e| e.to_string())?;
        plugins::copy_readme_if_present(src_dir, &dir);
        plugins::copy_asset_images(src_dir, &dir);
        finish_staging(app_data, token, &dir, PluginSource::Local)
    })();
    cleaned_on_err(&dir, result)
}

/// 승인된 스테이징을 확정 설치한다 — 검증된 스테이징 그대로 설치 + 상태/출처 기록 + vault upsert.
///
/// 역할: (1) 토큰 형식/존재 검증, (2) 같은 id의 기존 설치 디렉터리를 정리(클린 교체 —
/// entry 파일명이 바뀌어도 옛 파일이 남지 않게), (3) [`plugins::install_from_dir`] 재사용
/// 설치, (4) enabled(기존 유지·신규는 켬)·granted(선언∩승인 클램프)·version·source 기록,
/// (5) vault 참조 목록 upsert, (6) 스테이징 전체 정리. 설치된 id를 돌려준다.
/// 왜: 사용자가 승인한 **그 바이트**가 설치되는 유일한 경로다(재다운로드 없음).
pub fn confirm_install(
    app_data: &Path,
    vault_root: &Path,
    token: &str,
    granted: &[String],
) -> Result<String, String> {
    let dir = staged_dir(app_data, token).ok_or("잘못된 스테이징 토큰")?;
    if !dir.is_dir() {
        return Err("설치 후보가 없습니다(취소되었거나 만료됨)".to_string());
    }
    let source: PluginSource = read_to_string(&dir.join(SOURCE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .ok_or("스테이징 출처 정보가 없습니다")?;
    let root = find_plugin_root(&dir)?;
    let raw = read_to_string(&root.join("manifest.json")).map_err(|_| "manifest.json 없음")?;
    let manifest = plugins::parse_manifest(&raw)?;

    // 기존 설치의 활성 여부는 승계한다(업데이트가 플러그인을 꺼버리지 않게). 신규는 켠다 —
    // 사용자가 방금 승인한 설치이므로 바로 동작하는 것이 원클릭 설치의 기대 동작.
    //
    // 상태 파일 갱신(load → 수정 → save) 전체를 `with_state_lock`으로 감싼다: 이 커맨드도
    // 이제 `(async)`라 다른 플러그인 상태 쓰기(토글·설정 저장)와 병행될 수 있고, 그러면
    // 서로의 load 결과를 덮어써 방금 승인한 부여가 조용히 사라질 수 있다.
    let id = plugins::with_state_lock(|| -> Result<String, String> {
        let mut state = plugins::load_state(app_data);
        let previous_enabled = state.plugins.get(&manifest.id).map(|r| r.enabled);
        let plugin_dir = plugins::plugins_dir(app_data).join(&manifest.id);
        if plugin_dir.exists() {
            std::fs::remove_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
        }
        let id = plugins::install_from_dir(app_data, &root)?;

        let record = state.plugins.entry(id.clone()).or_default();
        record.enabled = previous_enabled.unwrap_or(true);
        // 부여는 항상 선언의 부분집합으로 클램프(프론트가 뭘 보내든 특권이 새지 않게).
        record.granted = granted
            .iter()
            .filter(|g| manifest.permissions.contains(g))
            .cloned()
            .collect();
        record.version = Some(manifest.version.clone());
        record.source = Some(source.clone());
        plugins::save_state(app_data, &state).map_err(|e| e.to_string())?;
        Ok(id)
    })?;

    plugin_sync::upsert_entry(
        vault_root,
        VaultPluginEntry {
            id: id.clone(),
            name: manifest.name,
            version: manifest.version,
            source,
        },
    )
    .map_err(|e| format!("vault 목록 기록 실패: {e}"))?;

    let _ = std::fs::remove_dir_all(staging_root(app_data)); // 스테이징 정리(실패해도 무해).
    Ok(id)
}

/// 스테이징을 폐기한다(사용자 취소/거부 — 잔여물 제거).
pub fn cancel_install(app_data: &Path, token: &str) -> Result<(), String> {
    let dir = staged_dir(app_data, token).ok_or("잘못된 스테이징 토큰")?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// 테스트용 zip 바이트를 만든다(이름 → 내용).
    fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// 테스트용 유효 매니페스트 JSON.
    fn manifest_json(id: &str, version: &str, perms: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id} 이름","version":"{version}","entry":"main.js","permissions":{perms}}}"#
        )
    }

    /// 테스트용 소스(zip Url) — 출처 기록 검증에 쓴다.
    fn url_source() -> PluginSource {
        PluginSource::Url {
            url: "https://example.com/p.zip".to_string(),
        }
    }

    /// 가드: https만 통과 — http·file·ssh·빈 호스트·공백 포함 URL은 거부.
    #[test]
    fn https_only_url_validation() {
        assert!(validate_https_url("https://example.com/p.zip").is_ok());
        assert!(validate_https_url("https://example.com/repo.git").is_ok());
        assert!(validate_https_url("http://example.com/p.zip").is_err());
        assert!(validate_https_url("file:///etc/passwd").is_err());
        assert!(validate_https_url("ssh://git@host/repo.git").is_err());
        assert!(validate_https_url("https://").is_err());
        assert!(validate_https_url("https://exa mple.com/p.zip").is_err());
        assert!(validate_https_url("example.com/p.zip").is_err());
    }

    /// 가드: curl 인자가 https 강제(--proto/--proto-redir)·크기 상한·옵션 주입 차단(`--`)을
    /// 유지한다 — 다운로드 보안 옵션이 실수로 빠지지 않게 고정.
    #[test]
    fn curl_args_enforce_security_options() {
        let args = curl_args("https://example.com/p.zip", &DEFAULT_LIMITS);
        let joined = args.join(" ");
        assert!(joined.contains("--proto =https"));
        assert!(joined.contains("--proto-redir =https"));
        assert!(joined.contains(&format!(
            "--max-filesize {}",
            DEFAULT_LIMITS.max_archive_bytes
        )));
        // URL은 반드시 `--` 뒤(옵션으로 해석 금지).
        let sep = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[sep + 1], "https://example.com/p.zip");
        assert_eq!(sep + 2, args.len());
    }

    /// 가드: git 단계가 init → fetch --depth 1 <src> <ref|HEAD> → checkout FETCH_HEAD를
    /// 유지한다(브랜치·태그·SHA를 한 경로로 지원하는 구조 고정).
    #[test]
    fn git_steps_shape() {
        let steps = git_steps("https://example.com/r.git", None);
        assert_eq!(steps[0][0], "init");
        let fetch = steps[1].join(" ");
        assert!(fetch.contains("--depth 1"));
        assert!(fetch.ends_with("-- https://example.com/r.git HEAD"));
        assert!(steps[2].join(" ").contains("checkout"));

        let pinned = git_steps("u", Some("v1.0.0"));
        assert!(pinned[1].join(" ").ends_with("-- u v1.0.0"));
    }

    /// 가드: 다운로드 읽기 상한 — cap 이하 통과, 초과는 오류이며 초과분을 계속 읽지 않는다
    /// (cap+1 바이트에서 중단 — 무한 스트림에서도 테스트가 끝나는 것이 그 증거).
    #[test]
    fn read_capped_stops_at_limit() {
        // cap 이하: 그대로 통과.
        assert_eq!(read_capped(&b"abc"[..], 8).unwrap(), b"abc");
        // 정확히 cap: 통과.
        assert_eq!(read_capped(&b"12345678"[..], 8).unwrap(), b"12345678");

        // 몇 바이트를 내줬는지 세는 reader — 초과 판정에 필요한 cap+1까지만 읽혀야 한다.
        struct Counting<R> {
            inner: R,
            served: u64,
        }
        impl<R: Read> Read for Counting<R> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.inner.read(buf)?;
                self.served += n as u64;
                Ok(n)
            }
        }
        // 무한 스트림(std::io::repeat) — 상한이 없다면 read_to_end가 영원히 끝나지 않는다.
        let mut counting = Counting {
            inner: std::io::repeat(b'x'),
            served: 0,
        };
        let err = read_capped(&mut counting, 64).unwrap_err();
        assert!(err.contains("상한"), "실제 오류: {err}");
        assert_eq!(counting.served, 65, "cap+1 바이트에서 즉시 중단해야 한다");
    }

    /// 가드: git ref 살균 — 브랜치·태그·SHA 형태만 통과하고, 콜론 refspec·공백·선행
    /// `-`/`.`/`/`는 거부된다(fetch 의미 변조 차단).
    #[test]
    fn git_ref_sanitization() {
        for ok in ["v1.2.0", "main", "feature/x-1", "1a2b3c4d", "release_2024"] {
            assert!(validate_git_ref(ok).is_ok(), "통과해야 함: {ok}");
        }
        for bad in [
            "HEAD:refs/heads/main", // 콜론 refspec — 로컬 ref 생성 의미로 바뀜.
            "v1 v2",                // 공백.
            "-option",              // 선행 하이픈.
            ".hidden",              // 선행 점.
            "/abs",                 // 선행 슬래시.
            "a~1",                  // rev 연산자.
            "",                     // 빈 문자열은 여기서는 거부(호출부가 HEAD로 정규화).
        ] {
            assert!(validate_git_ref(bad).is_err(), "거부해야 함: {bad:?}");
        }
    }

    /// 가드: 정상 zip(manifest + main.js)이 스테이징되고 미리보기에 매니페스트가 담긴다.
    #[test]
    fn stage_zip_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let zip = make_zip(&[
            (
                "manifest.json",
                &manifest_json("fresh", "1.0.0", r#"["editor","notes:read"]"#),
            ),
            ("main.js", "// code"),
        ]);
        let preview = stage_from_zip_bytes(app_data, &zip, url_source(), &DEFAULT_LIMITS).unwrap();
        assert_eq!(preview.manifest.id, "fresh");
        assert_eq!(preview.installed_version, None);
        assert!(staging_root(app_data).join(&preview.staging).is_dir());
    }

    /// 가드: GitHub 아카이브처럼 최상위 폴더 하나로 감싼 zip도 설치 루트를 찾는다.
    #[test]
    fn stage_zip_with_wrapping_top_dir() {
        let dir = tempfile::tempdir().unwrap();
        let zip = make_zip(&[
            (
                "repo-main/manifest.json",
                &manifest_json("wrapped", "1.0.0", "[]"),
            ),
            ("repo-main/main.js", "// code"),
        ]);
        let preview =
            stage_from_zip_bytes(dir.path(), &zip, url_source(), &DEFAULT_LIMITS).unwrap();
        assert_eq!(preview.manifest.id, "wrapped");
    }

    /// 가드: zip-slip — `..` 경로 탈출 엔트리는 거부되고 스테이징 잔여물이 없다.
    #[test]
    fn zip_slip_entry_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let zip = make_zip(&[
            ("manifest.json", &manifest_json("evil", "1.0.0", "[]")),
            ("../evil.js", "// escape"),
        ]);
        let err = stage_from_zip_bytes(app_data, &zip, url_source(), &DEFAULT_LIMITS).unwrap_err();
        assert!(err.contains("경로 탈출"), "실제 오류: {err}");
        // 탈출 파일이 스테이징 밖(app_data 상위)에 쓰이지 않았다.
        assert!(!dir.path().parent().unwrap().join("evil.js").exists());
        assert_no_staging_leftover(app_data);
    }

    /// 가드: 절대경로 엔트리는 스테이징 밖(그 절대경로)에 쓰이지 않는다(zip-slip 변종 —
    /// `enclosed_name`이 루트를 떼어 상대 경로로 격리함을 고정).
    #[test]
    fn zip_absolute_path_entry_does_not_escape() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        // 방어가 없다면 이 절대경로에 파일이 생긴다.
        let escape_target = dir.path().join("escaped.js");
        let abs_name = escape_target.to_string_lossy().into_owned();
        let zip = make_zip(&[
            ("manifest.json", &manifest_json("abs", "1.0.0", "[]")),
            ("main.js", "// code"),
            (&abs_name, "// escape"),
        ]);
        stage_from_zip_bytes(&app_data, &zip, url_source(), &DEFAULT_LIMITS).unwrap();
        assert!(
            !escape_target.exists(),
            "절대경로 엔트리가 스테이징 밖에 쓰이면 안 된다"
        );
    }

    /// 가드: 심볼릭 링크 엔트리는 거부된다.
    #[test]
    fn zip_symlink_entry_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(manifest_json("link", "1.0.0", "[]").as_bytes())
            .unwrap();
        writer
            .add_symlink("main.js", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();

        let err =
            stage_from_zip_bytes(dir.path(), &bytes, url_source(), &DEFAULT_LIMITS).unwrap_err();
        assert!(err.contains("심볼릭 링크"), "실제 오류: {err}");
        assert_no_staging_leftover(dir.path());
    }

    /// 가드: 압축 해제 총량이 상한을 넘으면 거부한다(실제 읽은 바이트 기준).
    #[test]
    fn zip_unpacked_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let limits = InstallLimits {
            max_archive_bytes: 1024 * 1024,
            max_unpacked_bytes: 64, // 아주 작게 — 본문이 넘치게.
            max_entries: 16,
        };
        let big = "x".repeat(256);
        let zip = make_zip(&[
            ("manifest.json", &manifest_json("big", "1.0.0", "[]")),
            ("main.js", &big),
        ]);
        let err = stage_from_zip_bytes(dir.path(), &zip, url_source(), &limits).unwrap_err();
        assert!(err.contains("상한"), "실제 오류: {err}");
        assert_no_staging_leftover(dir.path());
    }

    /// 가드: zip 엔트리 수 상한을 넘으면 거부한다.
    #[test]
    fn zip_entry_count_cap() {
        let dir = tempfile::tempdir().unwrap();
        let limits = InstallLimits {
            max_archive_bytes: 1024 * 1024,
            max_unpacked_bytes: 1024 * 1024,
            max_entries: 2,
        };
        let zip = make_zip(&[("a", "1"), ("b", "2"), ("c", "3")]);
        let err = stage_from_zip_bytes(dir.path(), &zip, url_source(), &limits).unwrap_err();
        assert!(err.contains("엔트리가 너무 많습니다"), "실제 오류: {err}");
    }

    /// 가드: zip이 아닌 바이트·불량 매니페스트는 거부되고 스테이징 잔여물이 없다.
    #[test]
    fn zip_invalid_content_rejected_and_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();

        // zip 시그니처가 아님.
        let err =
            stage_from_zip_bytes(app_data, b"<html>404</html>", url_source(), &DEFAULT_LIMITS)
                .unwrap_err();
        assert!(err.contains("zip 아카이브가 아닙니다"), "실제 오류: {err}");

        // 매니페스트 불량(미지의 권한).
        let bad = make_zip(&[
            (
                "manifest.json",
                r#"{"id":"p","name":"P","version":"1","entry":"main.js","permissions":["filesystem"]}"#,
            ),
            ("main.js", "// code"),
        ]);
        assert!(stage_from_zip_bytes(app_data, &bad, url_source(), &DEFAULT_LIMITS).is_err());

        // entry 파일 없음.
        let no_entry = make_zip(&[("manifest.json", &manifest_json("p", "1.0.0", "[]"))]);
        let err =
            stage_from_zip_bytes(app_data, &no_entry, url_source(), &DEFAULT_LIMITS).unwrap_err();
        assert!(err.contains("entry 파일 없음"), "실제 오류: {err}");

        assert_no_staging_leftover(app_data);
    }

    /// 스테이징 루트에 잔여 디렉터리가 없는지 확인한다(부분 설치 잔여물 금지 가드 헬퍼).
    fn assert_no_staging_leftover(app_data: &Path) {
        let root = staging_root(app_data);
        let count = std::fs::read_dir(&root).map(|d| d.count()).unwrap_or(0);
        assert_eq!(count, 0, "스테이징 잔여물이 없어야 한다");
    }

    /// 가드: 확정 설치 — 스캔에 나타나고 source/version/granted(클램프)/enabled가 기록되며
    /// vault 목록에 upsert되고 스테이징이 정리된다.
    #[test]
    fn confirm_installs_records_and_syncs() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault = dir.path().join("vault");
        let zip = make_zip(&[
            (
                "manifest.json",
                &manifest_json("fresh", "1.0.0", r#"["editor","notes:read"]"#),
            ),
            ("main.js", "// code"),
        ]);
        let preview = stage_from_zip_bytes(&app_data, &zip, url_source(), &DEFAULT_LIMITS).unwrap();

        // notes:write는 선언에 없음 → 클램프로 버려져야 한다.
        let id = confirm_install(
            &app_data,
            &vault,
            &preview.staging,
            &["notes:read".to_string(), "notes:write".to_string()],
        )
        .unwrap();
        assert_eq!(id, "fresh");

        let list = plugins::scan_installed(&app_data, &plugins::load_state(&app_data));
        assert_eq!(list.len(), 1);
        assert!(list[0].enabled, "신규 설치는 활성으로 시작");
        assert_eq!(list[0].granted, vec!["notes:read"]);
        assert_eq!(list[0].source, url_source());

        let record = plugins::load_state(&app_data)
            .plugins
            .get("fresh")
            .cloned()
            .unwrap();
        assert_eq!(record.version, Some("1.0.0".to_string()));

        let vault_list = plugin_sync::load_vault_list(&vault);
        assert_eq!(vault_list.plugins.len(), 1);
        assert_eq!(vault_list.plugins[0].id, "fresh");
        assert_eq!(vault_list.plugins[0].source, url_source());

        assert!(
            !staging_root(&app_data).exists(),
            "확정 후 스테이징은 비워진다"
        );
    }

    /// 가드: 업데이트 확정 — 미리보기에 기존 버전이 실리고, entry 파일명이 바뀌면 옛 파일이
    /// 지워지며(클린 교체) 활성 여부는 승계된다.
    #[test]
    fn confirm_update_replaces_cleanly_and_keeps_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault = dir.path().join("vault");

        // v1 설치(entry: main.js) 후 활성화.
        let v1 = make_zip(&[
            (
                "manifest.json",
                &manifest_json("p", "1.0.0", r#"["notes:read"]"#),
            ),
            ("main.js", "// v1"),
        ]);
        let preview = stage_from_zip_bytes(&app_data, &v1, url_source(), &DEFAULT_LIMITS).unwrap();
        confirm_install(
            &app_data,
            &vault,
            &preview.staging,
            &["notes:read".to_string()],
        )
        .unwrap();

        // v2는 entry 이름이 다르다(index.js) + 새 민감 권한(clipboard).
        let v2 = r#"{"id":"p","name":"p 이름","version":"2.0.0","entry":"index.js","permissions":["notes:read","clipboard"]}"#;
        let zip2 = make_zip(&[("manifest.json", v2), ("index.js", "// v2")]);
        let preview2 =
            stage_from_zip_bytes(&app_data, &zip2, url_source(), &DEFAULT_LIMITS).unwrap();
        assert_eq!(preview2.installed_version, Some("1.0.0".to_string()));
        assert_eq!(preview2.installed_permissions, vec!["notes:read"]);
        assert_eq!(preview2.installed_granted, vec!["notes:read"]);

        confirm_install(
            &app_data,
            &vault,
            &preview2.staging,
            &["notes:read".to_string(), "clipboard".to_string()],
        )
        .unwrap();

        let plugin_dir = plugins::plugins_dir(&app_data).join("p");
        assert!(plugin_dir.join("index.js").is_file());
        assert!(
            !plugin_dir.join("main.js").exists(),
            "옛 entry는 남지 않는다"
        );

        let list = plugins::scan_installed(&app_data, &plugins::load_state(&app_data));
        assert_eq!(list[0].version, "2.0.0");
        assert!(list[0].enabled, "업데이트는 활성 여부를 승계");
        assert_eq!(list[0].granted, vec!["notes:read", "clipboard"]);

        // vault 목록도 새 버전으로 교체(중복 없음).
        let vault_list = plugin_sync::load_vault_list(&vault);
        assert_eq!(vault_list.plugins.len(), 1);
        assert_eq!(vault_list.plugins[0].version, "2.0.0");
    }

    /// 가드: 취소가 스테이징을 지우고, 취소된 토큰의 확정은 실패한다(잔여물 없음).
    #[test]
    fn cancel_discards_staging() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault = dir.path().join("vault");
        let zip = make_zip(&[
            ("manifest.json", &manifest_json("p", "1.0.0", "[]")),
            ("main.js", "// code"),
        ]);
        let preview = stage_from_zip_bytes(&app_data, &zip, url_source(), &DEFAULT_LIMITS).unwrap();
        cancel_install(&app_data, &preview.staging).unwrap();

        assert_no_staging_leftover(&app_data);
        assert!(confirm_install(&app_data, &vault, &preview.staging, &[]).is_err());
        // 설치도 vault 기록도 없어야 한다.
        assert!(plugins::scan_installed(&app_data, &plugins::load_state(&app_data)).is_empty());
        assert!(plugin_sync::load_vault_list(&vault).plugins.is_empty());
    }

    /// 가드: 조작된 스테이징 토큰(경로 탈출·형식 오류)은 확정/취소 모두 거부한다.
    #[test]
    fn invalid_staging_token_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        for bad in [
            "../escape",
            "abc",
            "",
            "AAAAAAAA-1111-2222-3333-444444444444",
        ] {
            assert!(confirm_install(app_data, app_data, bad, &[]).is_err());
            assert!(cancel_install(app_data, bad).is_err());
        }
    }

    /// 가드: 공개 진입점은 네트워크에 닿기 전에 https가 아닌 소스를 거부한다.
    #[test]
    fn public_entrypoints_require_https() {
        let dir = tempfile::tempdir().unwrap();
        assert!(stage_from_url(dir.path(), "http://x/p.zip", &DEFAULT_LIMITS).is_err());
        assert!(stage_from_git(dir.path(), "file:///tmp/repo", None, &DEFAULT_LIMITS).is_err());
        assert!(stage_from_git(dir.path(), "git@host:repo.git", None, &DEFAULT_LIMITS).is_err());
    }

    /// 가드: 로컬 폴더 스테이징 — manifest + entry + README + 이미지 에셋(화이트리스트)은
    /// 옮기고, 화이트리스트 밖 파일(junk.txt)은 여전히 걸러진다.
    #[test]
    fn stage_local_dir_copies_manifest_entry_readme_and_assets() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            manifest_json("side", "1.0.0", "[]"),
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "// code").unwrap();
        std::fs::write(src.join("README.md"), "# 사이드 플러그인").unwrap();
        std::fs::write(src.join("icon.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        std::fs::write(src.join("junk.txt"), "따라오면 안 됨").unwrap();

        let preview = stage_from_local_dir(&app_data, &src).unwrap();
        assert_eq!(preview.source, PluginSource::Local);
        let staged = staging_root(&app_data).join(&preview.staging);
        assert!(staged.join("manifest.json").is_file());
        assert!(staged.join("main.js").is_file());
        assert_eq!(
            std::fs::read_to_string(staged.join("README.md")).unwrap(),
            "# 사이드 플러그인",
            "README도 스테이징으로 옮겨져야 상세 뷰·확정 설치에 도달한다"
        );
        assert!(
            staged.join("icon.png").is_file(),
            "화이트리스트 확장자 이미지는 스테이징으로 옮겨진다"
        );
        assert!(
            !staged.join("junk.txt").exists(),
            "화이트리스트 밖 파일은 여전히 스테이징하지 않는다"
        );
    }

    // ---- git 픽스처 테스트(로컬 경로 리포 — 네트워크 없음) ----

    /// 테스트용 git 리포 픽스처: v1 커밋(태그 v1) → v2 커밋. (sha_v1, 리포 경로) 반환.
    fn make_git_fixture(base: &Path) -> (String, PathBuf) {
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .expect("git 실행");
            assert!(
                out.status.success(),
                "git {args:?} 실패: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "테스트"]);
        // SHA fetch를 허용(로컬 픽스처를 원격처럼 쓰기 위한 서버측 설정).
        git(&["config", "uploadpack.allowAnySHA1InWant", "true"]);

        std::fs::write(
            repo.join("manifest.json"),
            manifest_json("gitp", "1.0.0", "[]"),
        )
        .unwrap();
        std::fs::write(repo.join("main.js"), "// v1").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "v1"]);
        git(&["tag", "v1"]);
        let sha_v1 = git(&["rev-parse", "HEAD"]);

        std::fs::write(
            repo.join("manifest.json"),
            manifest_json("gitp", "2.0.0", "[]"),
        )
        .unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "v2"]);
        (sha_v1, repo)
    }

    /// 가드: git 스테이징 — HEAD는 최신(2.0.0), 태그/커밋 ref는 그 시점(1.0.0)을 받는다.
    #[test]
    fn stage_git_head_tag_and_sha() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let (sha_v1, repo) = make_git_fixture(dir.path());
        let src = repo.to_string_lossy().into_owned();

        let head = stage_from_git_source(&app_data, &src, None, &DEFAULT_LIMITS).unwrap();
        assert_eq!(head.manifest.version, "2.0.0");

        let tagged = stage_from_git_source(&app_data, &src, Some("v1"), &DEFAULT_LIMITS).unwrap();
        assert_eq!(tagged.manifest.version, "1.0.0");
        assert_eq!(
            tagged.source,
            PluginSource::Git {
                url: src.clone(),
                git_ref: Some("v1".to_string())
            }
        );

        let pinned =
            stage_from_git_source(&app_data, &src, Some(&sha_v1), &DEFAULT_LIMITS).unwrap();
        assert_eq!(pinned.manifest.version, "1.0.0");

        // 빈 ref는 HEAD로 정규화된다(출처 기록에도 ref가 남지 않음).
        let empty = stage_from_git_source(&app_data, &src, Some(""), &DEFAULT_LIMITS).unwrap();
        assert_eq!(empty.manifest.version, "2.0.0");
        assert_eq!(
            empty.source,
            PluginSource::Git {
                url: src.clone(),
                git_ref: None
            }
        );
    }

    /// 가드: 형식 위반 ref(콜론 refspec 등)는 git 실행 전에 거부되고 스테이징 잔여물이 없다.
    #[test]
    fn stage_git_rejects_malformed_ref() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let (_, repo) = make_git_fixture(dir.path());
        let src = repo.to_string_lossy().into_owned();

        let err =
            stage_from_git_source(&app_data, &src, Some("HEAD:refs/heads/x"), &DEFAULT_LIMITS)
                .unwrap_err();
        assert!(err.contains("git ref 형식"), "실제 오류: {err}");
        assert!(
            !staging_root(&app_data).exists(),
            "형식 오류는 스테이징 생성 전에 거부돼야 한다"
        );
    }

    /// 가드: git 스테이징 후 확정까지 — 설치·출처(git) 기록·vault upsert가 동작한다.
    #[test]
    fn stage_git_then_confirm() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let vault = dir.path().join("vault");
        let (_, repo) = make_git_fixture(dir.path());
        let src = repo.to_string_lossy().into_owned();

        let preview = stage_from_git_source(&app_data, &src, None, &DEFAULT_LIMITS).unwrap();
        let id = confirm_install(&app_data, &vault, &preview.staging, &[]).unwrap();
        assert_eq!(id, "gitp");

        let list = plugins::scan_installed(&app_data, &plugins::load_state(&app_data));
        assert_eq!(list[0].version, "2.0.0");
        assert!(matches!(list[0].source, PluginSource::Git { .. }));
        assert_eq!(plugin_sync::load_vault_list(&vault).plugins[0].id, "gitp");
    }

    /// 가드: 심볼릭 링크를 담은 git 리포는 설치를 거부한다(체크아웃 후 검사).
    ///
    /// `#[cfg(unix)]`인 이유는 **검사 대상이 아니라 준비물** 때문이다 — [`reject_symlinks`]는
    /// `symlink_metadata`를 쓰므로 플랫폼을 가리지 않지만, 이 테스트가 미끼로 만드는 심볼릭
    /// 링크 생성이 Windows에서는 관리자 권한이나 개발자 모드를 요구해 CI에서 세울 수 없다.
    /// 같은 이유로 gate된 형제 테스트가 plugins.rs에도 있다.
    #[cfg(unix)]
    #[test]
    fn stage_git_rejects_symlink_in_repo() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let repo = dir.path().join("linkrepo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git 실행");
            assert!(out.status.success(), "git {args:?} 실패");
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "테스트"]);
        std::fs::write(
            repo.join("manifest.json"),
            manifest_json("lnk", "1.0.0", "[]"),
        )
        .unwrap();
        std::os::unix::fs::symlink("/etc/passwd", repo.join("main.js")).unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "symlink"]);

        let err = stage_from_git_source(&app_data, &repo.to_string_lossy(), None, &DEFAULT_LIMITS)
            .unwrap_err();
        assert!(err.contains("심볼릭 링크"), "실제 오류: {err}");
        assert_no_staging_leftover(&app_data);
    }

    /// 가드: git 체크아웃 크기가 상한을 넘으면 설치를 거부한다.
    #[test]
    fn stage_git_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("appdata");
        let (_, repo) = make_git_fixture(dir.path());
        let limits = InstallLimits {
            max_archive_bytes: 1024,
            max_unpacked_bytes: 1, // 체크아웃(.git 포함)이 반드시 넘는 크기.
            max_entries: 16,
        };
        let err =
            stage_from_git_source(&app_data, &repo.to_string_lossy(), None, &limits).unwrap_err();
        assert!(err.contains("상한"), "실제 오류: {err}");
        assert_no_staging_leftover(&app_data);
    }
}
