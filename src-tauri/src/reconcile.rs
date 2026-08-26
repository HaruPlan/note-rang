//! 시작 재조정 + 동기화 충돌본 감지.
//!
//! 역할: vault의 `notes/`를 스캔해 본문(.md)과 사이드카(.json)의 짝을 맞추고,
//! 메타 없는 본문·본문 없는 메타·동기화 충돌본을 분류한다.
//! 왜: 외부(동기화)에서 파일이 들어오거나 사라져도 앱이 일관된 상태로 복구하고,
//! 충돌본을 사용자에게 알려 데이터 손실을 막는다(병합은 범위 밖).

use std::io;
use std::path::Path;

/// `notes/` 스캔 분류 결과.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// 본문·메타가 모두 있는 정상 노트 id.
    pub ok: Vec<String>,
    /// 본문만 있고 메타가 없는 id(메타 생성 대상).
    pub missing_meta: Vec<String>,
    /// 메타만 있고 본문이 없는 id(정리 대상).
    pub orphan_meta: Vec<String>,
    /// 동기화 충돌본 파일명(사용자 알림 대상).
    pub conflicts: Vec<String>,
}

/// 파일명이 동기화 충돌본인지 판별한다.
///
/// Dropbox/다수 동기화 도구가 쓰는 "conflicted copy" 패턴을 대소문자 무시로 잡는다.
/// (iCloud의 숫자 접미 방식은 일반 파일과 구분이 모호해 의도적으로 제외한다.)
pub fn is_conflict_copy(file_name: &str) -> bool {
    file_name.to_lowercase().contains("conflicted copy")
}

/// `notes_dir`를 스캔해 [`ReconcileReport`]를 만든다. 디렉터리가 없으면 빈 리포트.
pub fn reconcile(notes_dir: &Path) -> io::Result<ReconcileReport> {
    use std::collections::BTreeSet;

    let mut report = ReconcileReport::default();
    if !notes_dir.exists() {
        return Ok(report);
    }

    let mut md_ids = BTreeSet::new();
    let mut meta_ids = BTreeSet::new();

    for entry in std::fs::read_dir(notes_dir)? {
        let path = entry?.path();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if is_conflict_copy(&file_name) {
            report.conflicts.push(file_name);
            continue;
        }

        let stem = path.file_stem().and_then(|s| s.to_str());
        match (path.extension().and_then(|e| e.to_str()), stem) {
            (Some("md"), Some(stem)) => {
                md_ids.insert(stem.to_string());
            }
            (Some("json"), Some(stem)) => {
                meta_ids.insert(stem.to_string());
            }
            _ => {}
        }
    }

    for id in &md_ids {
        if meta_ids.contains(id) {
            report.ok.push(id.clone());
        } else {
            report.missing_meta.push(id.clone());
        }
    }
    for id in &meta_ids {
        if !md_ids.contains(id) {
            report.orphan_meta.push(id.clone());
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 가드: 충돌본 파일명 판별(대소문자 무시, 일반 파일 제외).
    #[test]
    fn detects_conflict_copies() {
        assert!(is_conflict_copy("note (conflicted copy 2024-01-01).md"));
        assert!(is_conflict_copy("a (Someone's Conflicted Copy).json"));
        assert!(!is_conflict_copy("note.md"));
        assert!(!is_conflict_copy("note 2.md"));
    }

    /// 가드: 스캔이 정상/메타없음/고아/충돌본을 정확히 분류한다.
    #[test]
    fn reconcile_classifies_entries() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        // 정상(a): md+json
        fs::write(notes.join("a.md"), "x").unwrap();
        fs::write(notes.join("a.json"), "{}").unwrap();
        // 메타 없음(b): md만
        fs::write(notes.join("b.md"), "x").unwrap();
        // 고아(c): json만
        fs::write(notes.join("c.json"), "{}").unwrap();
        // 충돌본
        fs::write(notes.join("a (conflicted copy).md"), "x").unwrap();

        let report = reconcile(&notes).unwrap();
        assert_eq!(report.ok, vec!["a"]);
        assert_eq!(report.missing_meta, vec!["b"]);
        assert_eq!(report.orphan_meta, vec!["c"]);
        assert_eq!(report.conflicts.len(), 1);
    }

    /// 가드: 없는 디렉터리는 빈 리포트(패닉 없음).
    #[test]
    fn reconcile_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let report = reconcile(&dir.path().join("nope")).unwrap();
        assert_eq!(report, ReconcileReport::default());
    }
}
