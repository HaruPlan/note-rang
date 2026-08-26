//! 원자적 파일 IO.
//!
//! 역할: 본문/사이드카 저장 시 부분 기록·크래시 손상을 막는 원자적 쓰기를 제공한다.
//! 왜: 자동저장이 잦고 동기화 폴더에 놓이므로, 임시 파일에 쓴 뒤 같은 디렉터리 안에서
//! rename(원자적)해 파일이 항상 완결된 상태가 되도록 한다.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 임시 파일명에 섞는 프로세스 내 유일 순번 — 같은 대상 파일에 대한 동시 쓰기를 갈라 놓는다.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// `path`에 바이트를 원자적으로 쓴다(텍스트/바이너리 공통 핵심).
///
/// 같은 디렉터리에 `<파일>.<순번>.tmp`로 먼저 쓰고 `rename`한다(같은 FS 내 rename은 원자적).
/// 디렉터리가 없으면 만든다. 본문(.md)·이미지 첨부가 모두 이 경로를 탄다.
///
/// 임시 파일명이 **고정값이 아니라 순번**인 이유: 백엔드 커맨드가 (메인 스레드를 놓아 주려고)
/// 스레드풀에서 병행 실행되면서, 같은 파일을 향한 두 쓰기가 겹칠 수 있게 됐다. 고정
/// `<path>.tmp`면 한쪽의 rename이 다른 쪽 tmp를 가져가 남은 쪽이 ENOENT로 실패하고, 최악의
/// 경우 반쯤 쓰인 tmp가 그대로 본 파일이 된다(`plugin_storage.rs`가 실측으로 기록한 결함).
/// 이름을 갈라 놓으면 각 쓰기가 자기 tmp만 rename하므로 마지막 쓰기가 이기는 것으로 끝난다.
pub fn write_atomic_bytes(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = temp_sibling(path);
    std::fs::write(&tmp, contents)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename 실패 시 임시 파일을 남기지 않는다(동기화 폴더에 쓰레기가 쌓이지 않게).
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// `path`에 `contents`(문자열)를 원자적으로 쓴다.
///
/// [`write_atomic_bytes`]의 문자열 편의 래퍼 — 노트 본문/사이드카 저장에 쓴다.
pub fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    write_atomic_bytes(path, contents.as_bytes())
}

/// `<path>.<순번>.tmp` 형태의 같은 디렉터리 임시 경로를 만든다(호출마다 다른 이름).
fn temp_sibling(path: &Path) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(format!(".{seq}.tmp"));
    PathBuf::from(name)
}

/// 디렉터리에 남은 임시 파일(`*.tmp`)이 있는지 — 가드 테스트 전용 헬퍼.
#[cfg(test)]
fn has_leftover_tmp(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| x == "tmp")
            })
        })
        .unwrap_or(false)
}

/// 파일을 문자열로 읽는다(없으면 io::Error).
pub fn read_to_string(path: &Path) -> io::Result<String> {
    std::fs::read_to_string(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 원자적 쓰기가 내용을 정확히 남기고, 임시 파일은 남기지 않는다.
    #[test]
    fn write_atomic_persists_contents_without_tmp_leftover() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_atomic(&path, "안녕").unwrap();
        assert_eq!(read_to_string(&path).unwrap(), "안녕");
        assert!(!has_leftover_tmp(dir.path()), "임시 파일이 남으면 안 된다");
    }

    /// 가드: 임시 파일명은 호출마다 다르다 — 같은 파일을 향한 동시 쓰기가 서로의 tmp를
    /// 가져가 rename이 ENOENT로 실패하던 경로를 막는다(커맨드 병행 실행 전제).
    #[test]
    fn temp_sibling_is_unique_per_call() {
        let path = Path::new("note.md");
        assert_ne!(temp_sibling(path), temp_sibling(path));
    }

    /// 가드: 여러 스레드가 같은 파일에 동시에 써도 실패 없이 끝나고, 임시 파일도 남지 않는다.
    #[test]
    fn concurrent_writes_to_same_path_all_succeed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hot.md");
        std::thread::scope(|s| {
            for i in 0..8 {
                let path = path.clone();
                s.spawn(move || {
                    for n in 0..20 {
                        write_atomic(&path, &format!("{i}-{n}")).expect("동시 쓰기 실패");
                    }
                });
            }
        });
        assert!(read_to_string(&path).is_ok());
        assert!(!has_leftover_tmp(dir.path()), "임시 파일이 남으면 안 된다");
    }

    /// 가드: 부모 디렉터리가 없어도 만들어 쓴다.
    #[test]
    fn write_atomic_creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes").join("a.md");
        write_atomic(&path, "x").unwrap();
        assert_eq!(read_to_string(&path).unwrap(), "x");
    }

    /// 가드: 바이트 변형은 바이너리(비 UTF-8)도 그대로 남긴다(이미지 첨부 경로).
    #[test]
    fn write_atomic_bytes_persists_binary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("img.bin");
        let bytes = [0x89u8, 0x50, 0x4e, 0x47, 0x00, 0xff];
        write_atomic_bytes(&path, &bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!temp_sibling(&path).exists());
    }

    /// 가드: 덮어쓰기가 이전 내용을 완전히 대체한다(부분 기록 없음).
    #[test]
    fn write_atomic_overwrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("n.md");
        write_atomic(&path, "old-long-content").unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(read_to_string(&path).unwrap(), "new");
    }
}
