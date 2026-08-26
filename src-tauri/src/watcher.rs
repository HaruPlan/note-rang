//! vault 파일 감시 (notify).
//!
//! 역할: vault 디렉터리를 재귀 감시하고, 노트 데이터(.md/.json) 변경 시 콜백을 부른다.
//! 왜: 동기화로 외부에서 파일이 들어오거나 바뀌면 앱이 리로드할 수 있게 한다.
//! (실제 리로드 연결은 이후 단계. 여기서는 감시 플러밍 + 관련성 판정을 제공한다.)

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};

/// 변경된 경로가 노트 데이터(.md/.json)인지 — 리로드 대상 판정.
///
/// 역할: 무관한 변경(임시 `.tmp` 등)을 걸러내는 순수 판정으로 분리해 테스트한다.
pub fn is_relevant(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md") | Some("json")
    )
}

/// `root`를 재귀 감시하는 watcher를 만든다. 관련 파일 변경 시 `on_change(경로들)`을 부른다.
///
/// 반환된 watcher가 살아있는 동안만 감시가 유지된다(drop 시 중단).
pub fn watch_vault<F>(root: &Path, on_change: F) -> notify::Result<RecommendedWatcher>
where
    F: Fn(Vec<PathBuf>) + Send + 'static,
{
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let relevant: Vec<PathBuf> =
                event.paths.into_iter().filter(|p| is_relevant(p)).collect();
            if !relevant.is_empty() {
                on_change(relevant);
            }
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: .md/.json만 관련 파일로 보고 그 외(.tmp 등)는 무시한다.
    #[test]
    fn relevance_by_extension() {
        assert!(is_relevant(&PathBuf::from("notes/a.md")));
        assert!(is_relevant(&PathBuf::from("notes/a.json")));
        assert!(!is_relevant(&PathBuf::from("notes/a.md.tmp")));
        assert!(!is_relevant(&PathBuf::from("notes/a")));
    }

    /// 가드(스모크): 유효한 디렉터리에서 watcher 생성이 성공한다.
    /// (실제 이벤트 전달은 타이밍 의존이라 수동/통합으로 검증한다.)
    #[test]
    fn watch_vault_constructs() {
        let dir = tempfile::tempdir().unwrap();
        assert!(watch_vault(dir.path(), |_paths| {}).is_ok());
    }
}
