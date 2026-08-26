//! 저장 폴더(vault) 이전 — 대상 검증·실제 권한 확인·내용물 이동(이슈 #21).
//!
//! 역할: "저장 폴더를 바꾼다"의 파일시스템 절반을 담는다. Tauri 상태·창·설정 영속화는
//! [`crate::commands::change_vault_path`]가 맡고, 여기서는 **경로 판정과 바이트 이동**만
//! 한다 — 그래야 GUI 없이 tempdir로 전 시나리오를 유닛 테스트할 수 있다.
//!
//! ## 왜 "쓸 수 있는지" 를 추측하지 않고 실제로 써 보는가
//!
//! 권한은 메타데이터만 봐서는 알 수 없다: Windows의 ACL·OneDrive의 "요청 시 파일"·
//! 네트워크 드라이브·macOS의 TCC(문서 폴더 접근 승인)는 모두 `metadata().permissions()`가
//! 쓰기 가능이라고 말하는 동안에도 실제 `write`를 거절한다. 그래서
//! [`probe_access`]는 프로브 파일을 **정말로 쓰고, 되읽고, 지운다** — 실패하면 그 자리에서
//! 명확한 오류 코드로 끊는다(내용물을 옮기기 시작한 뒤에 알게 되는 것이 최악이다).
//!
//! ## 오류 코드
//!
//! 모든 실패는 `"<코드> <사람이 읽는 설명>"` 형태의 문자열이다(`net.rs`의 `NET_*` 관례).
//! 프론트는 **문구가 아니라 첫 토큰**으로 분류해 번역된 안내를 고른다 — 백엔드 문구가
//! 바뀌어도 UI 분기가 깨지지 않는다.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// vault가 소유하는 최상위 항목 — 이전 대상의 전수(全數).
///
/// [`crate::notes::Vault::wipe_all`]이 지우는 집합과 **같아야 한다**: 한쪽이 아는 항목을
/// 다른 쪽이 모르면 "지울 땐 지워지는데 옮길 땐 남는" 비대칭이 생긴다. 플러그인 참조
/// 목록(`installed-plugins.json`)·공유 설정·복구 슬롯은 모두 `.memo/` 아래라 여기 세 개면
/// 전부다([`crate::plugin_sync`]·[`crate::settings::shared_settings_path`]·[`crate::trash`]).
///
/// 왜 vault 루트의 **모든** 항목을 옮기지 않는가: vault 루트가 전용 폴더라는 보장이 없다
/// (사용자가 `Documents` 자체를 지정할 수도 있다). 우리가 만든 것만 옮기는 편이, 남의 파일을
/// 말없이 다른 폴더로 나르는 것보다 훨씬 안전하다.
pub const VAULT_ENTRIES: [&str; 3] = ["notes", "attachments", ".memo"];

/// 절대경로가 아니다(빈 문자열·상대경로).
pub const ERR_NOT_ABSOLUTE: &str = "VAULT_NOT_ABSOLUTE";
/// 대상 폴더를 만들지 못했다.
pub const ERR_CREATE_FAILED: &str = "VAULT_CREATE_FAILED";
/// 대상이 폴더가 아니다(파일이 같은 이름으로 있다).
pub const ERR_NOT_A_DIR: &str = "VAULT_NOT_A_DIR";
/// 대상 폴더를 읽을 수 없다.
pub const ERR_NOT_READABLE: &str = "VAULT_NOT_READABLE";
/// 대상 폴더에 쓸 수 없다.
pub const ERR_NOT_WRITABLE: &str = "VAULT_NOT_WRITABLE";
/// 대상에 이미 vault(`notes/`)가 있다 — 이동 대신 연결만 가능.
pub const ERR_TARGET_HAS_VAULT: &str = "VAULT_TARGET_HAS_VAULT";
/// 대상에 vault 소유 항목 일부가 이미 있다(합치면 어느 쪽이 정본인지 알 수 없다).
pub const ERR_TARGET_OCCUPIED: &str = "VAULT_TARGET_OCCUPIED";
/// 대상이 현재 vault의 하위 폴더다(자기 안으로 옮길 수 없다).
pub const ERR_NESTED: &str = "VAULT_NESTED";
/// 내용물을 옮기지 못했다(원본은 그대로 남는다).
pub const ERR_MOVE_FAILED: &str = "VAULT_MOVE_FAILED";

/// 프로브 파일명에 섞는 프로세스 내 유일 순번 — 동시 검사가 서로의 프로브를 지우지 않게.
/// ([`crate::io::write_atomic_bytes`]의 임시 파일명이 순번인 것과 같은 이유.)
static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 이동 결과 요약(옮긴 최상위 항목 수 + 그 안의 파일 수).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MoveReport {
    /// 옮긴 최상위 항목 수(`notes`·`attachments`·`.memo` 중 실제로 있던 것).
    pub entries: usize,
    /// 옮긴 파일 수(재귀 합계) — 안내 문구에 쓴다.
    pub files: usize,
}

/// 프론트가 준 경로 문자열을 대상 경로로 정규화한다.
///
/// 하는 일: 양끝 공백 제거 → 빈 값·상대경로 거부. **`canonicalize`는 하지 않는다** — Windows에서
/// 그 함수는 `\\?\C:\...`(확장 길이 접두) 형태를 돌려주는데, 이 경로는 그대로 로컬 설정에
/// 저장돼 프론트의 첨부 URL 조립(`convertFileSrc(vault + "/" + rel)`)에 쓰인다. 접두가 붙은
/// 경로를 저장하면 첨부 이미지가 조용히 깨진다. 동일성 판정에만 canonicalize를 쓴다
/// ([`same_dir`]).
pub fn normalize_target(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err(format!(
            "{ERR_NOT_ABSOLUTE} 폴더의 전체 경로가 필요합니다: {trimmed:?}"
        ));
    }
    Ok(path)
}

/// 두 경로가 같은 폴더를 가리키는지 판정한다.
///
/// 먼저 경로 문자열로 비교하고, 다르면 **둘 다 실재할 때만** canonicalize해서 다시 본다 —
/// 심볼릭 링크·`C:\Users\me\..\me`·대소문자 차이(Windows)로 "같은 폴더로 바꾸기"가 실제
/// 이동을 시작하는 사고를 막는다. 한쪽이라도 없으면(=대상을 아직 안 만들었으면) 같을 수 없다.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// `child`가 `ancestor` 안(또는 자기 자신)인지 판정한다 — 자기 하위 폴더로의 이동 차단용.
///
/// 원문 경로로 먼저 보고(대상 폴더를 아직 만들지 않은 시점에도 답이 나오게), 아니라고 나오면
/// **둘 다 실재할 때만** canonicalize해서 다시 본다([`same_dir`]와 같은 이유 — 심볼릭 링크나
/// `..`를 지나가는 경로를 놓치지 않기 위함).
pub fn is_inside(child: &Path, ancestor: &Path) -> bool {
    if child.starts_with(ancestor) {
        return true;
    }
    match (
        std::fs::canonicalize(child),
        std::fs::canonicalize(ancestor),
    ) {
        (Ok(c), Ok(a)) => c.starts_with(a),
        // 한쪽이라도 실재하지 않으면 정규화한 비교를 할 수 없다. 원문 비교(위)가 이미
        // 아니라고 했으므로 아니라고 답한다 — 두 형태를 **섞어** 비교하면 안 된다(Windows의
        // canonicalize는 `\\?\` 접두를 붙여 돌려주므로 원문과는 절대 접두가 맞지 않는다).
        _ => false,
    }
}

/// 대상 폴더를 보장한다(없으면 만든다). 같은 이름의 **파일**이 있으면 오류.
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    if path.exists() {
        return Err(format!(
            "{ERR_NOT_A_DIR} 폴더가 아닙니다(같은 이름의 파일이 있어요): {}",
            path.display()
        ));
    }
    std::fs::create_dir_all(path)
        .map_err(|e| format!("{ERR_CREATE_FAILED} 폴더를 만들지 못했습니다: {e}"))
}

/// 폴더의 읽기/쓰기를 **실제로 해 보고** 확인한다(모듈 문서의 「추측하지 않는다」).
///
/// 순서: 폴더인지 → 목록 읽기 → 프로브 파일 쓰기 → 되읽기 → 지우기. 프로브 파일은 어떤
/// 경로로 끝나든 지운다(실패해도 남지 않게 삭제를 먼저 하고 되읽기 결과를 나중에 본다).
pub fn probe_access(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "{ERR_NOT_A_DIR} 폴더가 아닙니다: {}",
            dir.display()
        ));
    }
    std::fs::read_dir(dir)
        .map_err(|e| format!("{ERR_NOT_READABLE} 폴더를 읽을 수 없습니다: {e}"))?;

    let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
    let probe = dir.join(format!(".note-rang-access-probe-{seq}"));
    std::fs::write(&probe, b"note-rang")
        .map_err(|e| format!("{ERR_NOT_WRITABLE} 폴더에 쓸 수 없습니다: {e}"))?;
    let read_back = std::fs::read(&probe);
    let removed = std::fs::remove_file(&probe);
    read_back.map_err(|e| format!("{ERR_NOT_READABLE} 방금 쓴 파일을 읽지 못했습니다: {e}"))?;
    removed.map_err(|e| format!("{ERR_NOT_WRITABLE} 임시 파일을 지우지 못했습니다: {e}"))?;
    Ok(())
}

/// 이 폴더가 이미 vault로 보이는지(마커: `notes/`) — [`crate::notes::Vault::looks_like_vault`]와
/// 같은 판정을 경로만으로 한다(대상 폴더는 아직 `Vault`가 아니다).
pub fn has_vault(dir: &Path) -> bool {
    dir.join("notes").is_dir()
}

/// vault 소유 항목([`VAULT_ENTRIES`])이 하나라도 있는지 — 이동 대상이 비어 있는지 판정.
pub fn has_any_entry(dir: &Path) -> bool {
    VAULT_ENTRIES.iter().any(|e| dir.join(e).exists())
}

/// 이 폴더 아래 vault 항목의 파일 수(재귀 합계). 없으면 0.
pub fn count_files(dir: &Path) -> usize {
    VAULT_ENTRIES
        .iter()
        .map(|e| count_files_in(&dir.join(e)))
        .sum()
}

/// 경로 하나(파일이면 1, 폴더면 재귀 합계)의 파일 수를 센다. 읽지 못하면 0.
fn count_files_in(path: &Path) -> usize {
    if path.is_file() {
        return 1;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| count_files_in(&e.path()))
        .sum::<usize>()
}

/// vault 내용물을 `from`에서 `to`로 옮긴다 — 이 모듈의 본체.
///
/// **2단계 전략**
///
/// 1. `rename`을 항목마다 시도한다. 같은 볼륨이면 이게 정답이다 — 즉시 끝나고 원자적이라
///    중간 상태가 없다. 하나라도 실패하면(대표적으로 **다른 드라이브**: Windows `ERROR_NOT_SAME_DEVICE`,
///    unix `EXDEV`) 이미 옮긴 것을 **역-rename으로 되돌리고** 2단계로 간다. 되돌리기는 방금
///    한 연산의 역이라 신뢰할 수 있다(원본 볼륨 안에서만 움직인다).
/// 2. 전부 **복사**한 뒤, **모든 복사가 성공한 다음에야** 원본을 지운다. 복사 도중 실패하면
///    대상에 만든 것을 치우고 오류를 낸다 — 원본은 한 바이트도 건드리지 않은 상태로 남는다.
///    "원본 삭제는 전체 복사 성공 후에만"이 이 함수의 유일한 불변식이다.
///
/// 원본 삭제 실패는 **치명적으로 다루지 않는다**: 그 시점에 데이터는 이미 새 위치에 온전히
/// 있고, 설정도 그쪽을 가리키게 된다. 남은 옛 폴더 때문에 "이전 실패"라고 말하면 사용자가
/// 멀쩡히 옮겨진 데이터를 두고 되돌리려 들 위험이 더 크다(지우지 못한 사실은 로그로 남긴다).
///
/// **전제**: 대상에 [`VAULT_ENTRIES`] 항목이 없어야 한다 — 호출부
/// ([`crate::commands::change_vault_path`])가 `has_any_entry`로 먼저 막는다. 이 함수는 그
/// 전제를 강제하지는 않지만, 어겨도 **남의 파일을 지우지 않는다**: 이미 있는 이름은 1단계
/// (rename)를 통째로 건너뛰어 파일 단위 복사로 합치고, 실패 정리에서도 손대지 않는다.
pub fn move_contents(from: &Path, to: &Path) -> Result<MoveReport, String> {
    let present: Vec<&str> = VAULT_ENTRIES
        .iter()
        .copied()
        .filter(|e| from.join(e).exists())
        .collect();
    // 대상에 **원래부터** 있던 항목 — 실패 정리에서 절대 지우지 않는다. 호출부(커맨드)가
    // 이미 "대상이 비어 있어야 이동"으로 걸러 주지만, 이 함수만 봐도 남의 파일을 지우지
    // 않는다는 것이 성립해야 한다(심층 방어).
    let pre_existing: Vec<&str> = VAULT_ENTRIES
        .iter()
        .copied()
        .filter(|e| to.join(e).exists())
        .collect();
    let report = MoveReport {
        entries: present.len(),
        files: count_files(from),
    };
    if present.is_empty() {
        return Ok(report);
    }

    // 1단계 — 같은 볼륨이면 rename으로 끝난다.
    //
    // 대상에 같은 이름이 하나라도 있으면 이 길을 **아예 타지 않는다**: Windows의
    // `std::fs::rename`은 대상을 조용히 **대체**한다(REPLACE_EXISTING 의미론 — 실측으로
    // 폴더가 같은 이름의 파일을 덮어쓰는 것을 확인했다). 그러면 우리가 만들지 않은 파일이
    // 말없이 사라진다. 그럴 때는 2단계로 내려가 파일 단위로 합친다(디렉터리는 만들기만 하고
    // 지우지 않는다).
    let mut renamed: Vec<&str> = Vec::new();
    let mut rename_failed = !pre_existing.is_empty();
    if !rename_failed {
        for entry in &present {
            if std::fs::rename(from.join(entry), to.join(entry)).is_ok() {
                renamed.push(entry);
            } else {
                rename_failed = true;
                break;
            }
        }
    }
    if !rename_failed {
        return Ok(report);
    }
    // 부분 이동 상태를 남기지 않는다 — 방금 한 rename을 역순으로 되돌린다.
    for entry in renamed.iter().rev() {
        if let Err(e) = std::fs::rename(to.join(entry), from.join(entry)) {
            // 되돌리기 실패는 그 항목이 **대상에 남았다**는 뜻이다. 이대로 복사 폴백에 들어가면
            // 원본에 없는 항목을 복사하려다 실패하고, 그 실패 정리가 방금 옮겨진 진짜 데이터를
            // 지운다. 그래서 더 진행하지 않고 즉시 멈춘다 — 파일이 두 폴더에 나뉘어 있게 되지만
            // 하나도 잃지 않는다(사용자는 오류를 보고, 설정은 아직 옛 폴더를 가리킨다).
            return Err(format!(
                "{ERR_MOVE_FAILED} 옮기다 중단했습니다({entry}) — 일부 파일이 새 폴더에 남아 있을 수 있습니다: {e}"
            ));
        }
    }

    // 2단계 — 복사 후 일괄 삭제(크로스 드라이브 폴백).
    let mut copied: Vec<&str> = Vec::new();
    for entry in &present {
        if let Err(e) = copy_recursive(&from.join(entry), &to.join(entry)) {
            // 이번 항목의 부분 복사분과 앞서 복사한 항목을 치운다(대상을 원래대로).
            // 원래부터 있던 항목은 우리 것이 아니므로 건드리지 않는다.
            for done in copied.iter().chain(std::iter::once(entry)).rev() {
                if !pre_existing.contains(done) {
                    let _ = remove_path(&to.join(done));
                }
            }
            return Err(format!(
                "{ERR_MOVE_FAILED} 파일을 옮기지 못했습니다({entry}) — 원본은 그대로 있습니다: {e}"
            ));
        }
        copied.push(entry);
    }
    for entry in &present {
        if let Err(e) = remove_path(&from.join(entry)) {
            eprintln!("[memo] 저장 폴더 이전: 옮긴 뒤 원본을 지우지 못했습니다({entry}): {e}");
        }
    }
    Ok(report)
}

/// 파일이면 복사, 폴더면 재귀 복사한다(대상 폴더는 필요하면 만든다).
fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_file() {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

/// 파일이든 폴더든 지운다. 이미 없으면 성공([`crate::notes::Vault::delete_note`]와 같은 멱등 관례).
fn remove_path(path: &Path) -> io::Result<()> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트용 vault를 만든다(노트 1건 + 첨부 1건 + `.memo` 공유 설정 1건).
    fn seed_vault(root: &Path) {
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes").join("a.md"), "# 노트 A").unwrap();
        std::fs::write(root.join("notes").join("a.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("attachments").join("a")).unwrap();
        std::fs::write(root.join("attachments").join("a").join("img.png"), [1u8, 2]).unwrap();
        std::fs::create_dir_all(root.join(".memo").join("trash")).unwrap();
        std::fs::write(root.join(".memo").join("shared-settings.json"), "{}").unwrap();
    }

    /// 가드: 절대경로만 통과한다(빈 값·상대경로는 파일시스템에 닿기 전에 거부).
    #[test]
    fn normalize_target_requires_absolute() {
        assert!(normalize_target("").is_err());
        assert!(normalize_target("   ").is_err());
        assert!(normalize_target("relative/path").is_err());
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().to_string_lossy().into_owned();
        assert_eq!(normalize_target(&abs).unwrap(), dir.path());
        // 양끝 공백은 다듬는다(붙여넣기 흔한 사고).
        assert_eq!(normalize_target(&format!("  {abs}  ")).unwrap(), dir.path());
    }

    /// 가드: 같은 폴더 판정이 `.`/`..`를 지나가는 경로에도 통한다 — "같은 곳으로 바꾸기"가
    /// 실제 이동을 시작하면 안 된다.
    #[test]
    fn same_dir_sees_through_indirection() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("v");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(same_dir(&inner, &inner));
        assert!(same_dir(&inner, &dir.path().join("v").join(".").join("")));
        assert!(same_dir(&inner, &inner.join("..").join("v")));
        assert!(!same_dir(&inner, dir.path()));
    }

    /// 가드: 하위 폴더 판정(자기 안으로 옮기기 차단의 근거).
    #[test]
    fn is_inside_detects_nesting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let child = root.join("sub").join("deep");
        std::fs::create_dir_all(&child).unwrap();
        assert!(is_inside(&child, &root));
        assert!(is_inside(&root, &root));
        assert!(!is_inside(&root, &child));
        assert!(!is_inside(&dir.path().join("other"), &root));
    }

    /// 가드: 쓸 수 있는 폴더는 통과하고, 프로브 파일을 남기지 않는다.
    #[test]
    fn probe_access_passes_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        probe_access(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// 가드: 없는 폴더·파일 경로는 프로브 단계에서 명확한 코드로 거부된다.
    #[test]
    fn probe_access_rejects_non_directory() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(probe_access(&missing)
            .unwrap_err()
            .starts_with(ERR_NOT_A_DIR));
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(probe_access(&file).unwrap_err().starts_with(ERR_NOT_A_DIR));
    }

    /// 가드(권한 없음 시나리오): 쓰기 불가 폴더는 `VAULT_NOT_WRITABLE`로 끊긴다.
    ///
    /// unix 전용인 이유: Windows에서 "쓰기 불가 폴더"를 만들려면 ACL을 손봐야 하는데 그건
    /// 이 테스트가 증명하려는 것(프로브가 실제 쓰기를 한다)과 무관한 플랫폼 배관이다.
    /// 판정 자체는 플랫폼 공통 코드다.
    #[cfg(unix)]
    #[test]
    fn probe_access_reports_permission_failure() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        let mut ro = std::fs::metadata(&locked).unwrap().permissions();
        ro.set_mode(0o500); // r-x — 목록은 되지만 쓰기는 안 된다.
        std::fs::set_permissions(&locked, ro).unwrap();

        let err = probe_access(&locked).unwrap_err();

        // 정리(tempdir 삭제를 위해 권한 복원) — 단언보다 먼저.
        let mut rw = std::fs::metadata(&locked).unwrap().permissions();
        rw.set_mode(0o700);
        std::fs::set_permissions(&locked, rw).unwrap();

        assert!(err.starts_with(ERR_NOT_WRITABLE), "실제 오류: {err}");
    }

    /// 가드: 대상 폴더가 없으면 만들고, 같은 이름의 파일이 있으면 거부한다.
    #[test]
    fn ensure_dir_creates_or_rejects_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("b");
        ensure_dir(&target).unwrap();
        assert!(target.is_dir());
        ensure_dir(&target).unwrap(); // 멱등

        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(ensure_dir(&file).unwrap_err().starts_with(ERR_NOT_A_DIR));
    }

    /// 가드: vault 마커(`notes/`)와 "뭔가 있다" 판정.
    #[test]
    fn vault_markers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_vault(dir.path()));
        assert!(!has_any_entry(dir.path()));
        std::fs::create_dir_all(dir.path().join(".memo")).unwrap();
        assert!(!has_vault(dir.path()), ".memo만으로는 vault가 아니다");
        assert!(has_any_entry(dir.path()));
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        assert!(has_vault(dir.path()));
    }

    /// 가드(빈 대상 시나리오): 같은 볼륨 이동은 내용물을 전부 옮기고 원본을 비운다.
    #[test]
    fn move_contents_relocates_everything() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        let to = dir.path().join("new");
        seed_vault(&from);
        std::fs::create_dir_all(&to).unwrap();

        let report = move_contents(&from, &to).unwrap();
        assert_eq!(report.entries, 3);
        // notes/a.md · notes/a.json · attachments/a/img.png · .memo/shared-settings.json
        // (`.memo/trash`는 빈 디렉터리라 파일 수에 들어가지 않는다).
        assert_eq!(report.files, 4);

        assert_eq!(
            std::fs::read_to_string(to.join("notes").join("a.md")).unwrap(),
            "# 노트 A"
        );
        assert!(to.join("attachments").join("a").join("img.png").is_file());
        assert!(to.join(".memo").join("shared-settings.json").is_file());
        assert!(
            to.join(".memo").join("trash").is_dir(),
            "빈 하위 폴더도 따라온다"
        );
        // 원본에는 vault 항목이 하나도 남지 않는다(루트 자체는 남는다 — wipe_all과 같은 관례).
        assert!(!has_any_entry(&from));
        assert!(from.is_dir());
    }

    /// 가드: 옮길 것이 없는 vault도 오류 없이 끝난다(0건 보고).
    #[test]
    fn move_contents_on_empty_vault_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        let to = dir.path().join("new");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        assert_eq!(move_contents(&from, &to).unwrap(), MoveReport::default());
    }

    /// 가드: vault 소유 항목만 옮기고, 사용자가 vault 루트에 둔 다른 파일은 건드리지 않는다
    /// (vault 루트가 전용 폴더라는 보장이 없다 — VAULT_ENTRIES 문서 참고).
    #[test]
    fn move_contents_leaves_foreign_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        let to = dir.path().join("new");
        seed_vault(&from);
        std::fs::write(from.join("남의 문서.txt"), "내 것이 아님").unwrap();
        std::fs::create_dir_all(&to).unwrap();

        move_contents(&from, &to).unwrap();
        assert!(from.join("남의 문서.txt").is_file(), "남의 파일은 그대로");
        assert!(!to.join("남의 문서.txt").exists());
    }

    /// 가드(크로스 드라이브 폴백): rename이 통하지 않는 상황에서도 복사 경로로 끝까지 옮긴다.
    ///
    /// 실제 두 번째 드라이브를 요구할 수 없으므로 **복사 경로 자체**(`copy_recursive`)를 직접
    /// 검증한다 — 폴백이 하는 일이 정확히 이 함수의 결과 + 원본 삭제다.
    #[test]
    fn copy_recursive_reproduces_tree() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        let to = dir.path().join("new");
        seed_vault(&from);

        copy_recursive(&from.join("notes"), &to.join("notes")).unwrap();
        copy_recursive(&from.join("attachments"), &to.join("attachments")).unwrap();
        copy_recursive(&from.join(".memo"), &to.join(".memo")).unwrap();

        assert_eq!(count_files(&to), count_files(&from));
        assert_eq!(
            std::fs::read(to.join("attachments").join("a").join("img.png")).unwrap(),
            vec![1u8, 2]
        );
        assert!(
            from.join("notes").join("a.md").is_file(),
            "복사는 원본을 남긴다"
        );
    }

    /// 가드(부분 실패 안전): 복사 도중 실패하면 **원본을 한 바이트도 지우지 않고** 대상에
    /// 만든 것도 치운다 — "원본 삭제는 전체 복사 성공 후에만" 불변식. 대상에 원래부터 있던
    /// 것도 정리에서 건드리지 않는다(남의 파일 보호).
    ///
    /// 재현: 대상에 `.memo/`를 만들고 그 **안**에 `trash`라는 이름의 **파일**을 둔다. 그러면
    /// 대상에 vault 항목이 있으므로 rename 빠른 길은 통째로 건너뛰고(모듈 문서 참고), 복사
    /// 경로가 `.memo/trash`를 폴더로 만들려다 확정적으로 실패한다 — 권한·플랫폼에 기대지 않는
    /// 재현이다(원래 이 자리에 쓰려던 "읽기 전용 파일" 트릭은 Windows의 `rename`이 파일을 조용히
    /// 덮어써 실패 자체가 일어나지 않았다 — 그 실측이 위 rename 건너뛰기 규칙의 근거다).
    #[test]
    fn move_contents_keeps_source_when_copy_fails() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old");
        let to = dir.path().join("new");
        seed_vault(&from);
        std::fs::create_dir_all(to.join(".memo")).unwrap();
        std::fs::write(to.join(".memo").join("trash"), "블로커").unwrap();

        let err = move_contents(&from, &to).unwrap_err();
        assert!(err.starts_with(ERR_MOVE_FAILED), "실제 오류: {err}");

        // 원본은 온전하다.
        assert_eq!(
            std::fs::read_to_string(from.join("notes").join("a.md")).unwrap(),
            "# 노트 A"
        );
        assert_eq!(count_files(&from), 4);
        // 대상에는 이번에 만든 것이 남지 않고, 원래 있던 `.memo`와 그 블로커는 그대로다.
        assert!(!to.join("notes").exists());
        assert!(!to.join("attachments").exists());
        assert!(to.join(".memo").join("trash").is_file());
    }
}
