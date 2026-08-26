//! 노트 첨부(이미지 등) 저장 — vault 안 `attachments/<note_id>/<uuid>.<ext>`.
//!
//! 역할: 붙여넣은 이미지의 바이트를 vault 하위 첨부 폴더에 원자적으로 저장하고, 본문
//! 마크다운에 넣을 **vault 상대경로**를 돌려준다.
//! 왜: 본문(.md)에는 절대경로 대신 상대경로(`attachments/...`)만 남겨 동기화 폴더가
//! 기기마다 다른 위치여도 참조가 깨지지 않게 한다. 저장 자체는 `io.rs`의 원자적 쓰기를
//! 재사용해 부분 기록을 막는다.

use crate::io::write_atomic_bytes;
use crate::notes::is_safe_note_id;
use std::io;
use std::path::{Path, PathBuf};

/// 첨부 파일의 확장자를 안전한 소문자 영숫자로 정규화한다(`.` 제거).
///
/// 역할: 클립보드가 주는 확장자(`PNG`, `.jpeg`, `jpg ` 등)를 파일명·경로 주입 위험이
/// 없는 형태로 좁힌다. 영숫자가 아닌 문자는 버리고, 비면 `bin`으로 폴백한다.
/// 왜: 확장자를 그대로 경로에 붙이면 `../`·구분자 주입으로 vault 밖에 쓸 수 있어 위험하다.
pub fn normalize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

/// note_id·파일명에서 vault 상대 첨부 경로 문자열을 만든다(항상 `/` 구분자).
///
/// 역할: `attachments/<note_id>/<file_name>` 규칙을 한 곳에 고정한다(순수, 테스트용).
/// 왜: 본문에 들어갈 마크다운 경로와 디스크 경로가 같은 규칙을 쓰도록 단일 진실원천으로 둔다.
/// 마크다운/웹뷰는 `/`만 쓰므로 OS 구분자와 무관하게 `/`로 조립한다.
pub fn attachment_rel_path(note_id: &str, file_name: &str) -> String {
    format!("attachments/{note_id}/{file_name}")
}

/// 첨부 바이트를 vault 안에 저장하고 vault 상대경로를 돌려준다.
///
/// `<vault_root>/attachments/<note_id>/<uuid>.<ext>`에 원자적으로 쓰고(디렉터리 생성
/// 포함), 본문에 넣을 상대경로 `attachments/<note_id>/<uuid>.<ext>`를 반환한다.
/// 확장자는 정규화하고 note_id는 [`is_safe_note_id`](crate::notes::is_safe_note_id)로
/// 검증해(노트 저장소와 같은 규칙) 경로 주입을 막는다.
pub fn save_attachment(
    vault_root: &Path,
    note_id: &str,
    data: &[u8],
    ext: &str,
) -> io::Result<String> {
    if !is_safe_note_id(note_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "잘못된 note_id",
        ));
    }
    let safe_ext = normalize_ext(ext);
    let file_name = format!("{}.{}", uuid::Uuid::new_v4(), safe_ext);
    let abs_path: PathBuf = vault_root
        .join("attachments")
        .join(note_id)
        .join(&file_name);
    write_atomic_bytes(&abs_path, data)?;
    Ok(attachment_rel_path(note_id, &file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 확장자 정규화 — 점 제거·소문자화·영숫자 외 제거·빈 값 폴백.
    #[test]
    fn normalize_ext_rules() {
        assert_eq!(normalize_ext("PNG"), "png");
        assert_eq!(normalize_ext(".JPEG"), "jpeg");
        assert_eq!(normalize_ext("  jpg  "), "jpg");
        assert_eq!(normalize_ext("png/../../etc"), "pngetc");
        assert_eq!(normalize_ext(""), "bin");
        assert_eq!(normalize_ext("!@#"), "bin");
    }

    /// 가드: 상대경로 조립 규칙(항상 `/`, attachments 접두).
    #[test]
    fn rel_path_format() {
        assert_eq!(
            attachment_rel_path("note-1", "a.png"),
            "attachments/note-1/a.png"
        );
    }

    /// 가드: 저장이 바이트를 디스크에 남기고, 반환 경로가 그 파일을 가리킨다.
    #[test]
    fn save_writes_bytes_and_returns_rel_path() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 1, 2, 3];
        let rel = save_attachment(dir.path(), "note-1", &bytes, "PNG").unwrap();

        // 반환 경로: attachments/note-1/<uuid>.png
        assert!(rel.starts_with("attachments/note-1/"));
        assert!(rel.ends_with(".png"));

        // 디스크: 같은 바이트가 그대로 저장됐고, 임시 파일은 남지 않는다.
        let abs = dir.path().join(&rel);
        assert_eq!(std::fs::read(&abs).unwrap(), bytes);
        let dir_entries: Vec<_> = std::fs::read_dir(dir.path().join("attachments").join("note-1"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(dir_entries.len(), 1, "임시 파일이 남으면 안 된다");
    }

    /// 가드: 경로 탈출 note_id(`..`·구분자·빈값)는 저장을 거부한다.
    #[test]
    fn save_rejects_unsafe_note_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_attachment(dir.path(), "../evil", b"x", "png").is_err());
        assert!(save_attachment(dir.path(), "a/b", b"x", "png").is_err());
        assert!(save_attachment(dir.path(), "a\\b", b"x", "png").is_err());
        assert!(save_attachment(dir.path(), "", b"x", "png").is_err());
    }

    /// 가드: 같은 노트에 두 번 저장하면 서로 다른 파일(UUID)로 둘 다 남는다.
    #[test]
    fn save_twice_keeps_both_with_unique_names() {
        let dir = tempfile::tempdir().unwrap();
        let a = save_attachment(dir.path(), "n", b"a", "png").unwrap();
        let b = save_attachment(dir.path(), "n", b"b", "png").unwrap();
        assert_ne!(a, b);
        assert!(dir.path().join(&a).exists());
        assert!(dir.path().join(&b).exists());
    }
}
