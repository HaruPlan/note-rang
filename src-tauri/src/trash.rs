//! 노트 복구 장치(휴지통/스냅샷) — 파괴적 연산 직전 이전 본문을 보관한다.
//!
//! 역할: memo는 undo도 휴지통도 없어 노트 **전체 덮어쓰기**(`notes.write` overwrite)와 **삭제**가
//! 곧 복구 불가능한 데이터 손실이었다. 업계 조사 결론은
//! 명확하다 — Obsidian·VS Code·Figma 어디도 "쓰기마다 확인 다이얼로그"로 안전을 확보하지 않고,
//! 표준 안전망은 예외 없이 **앱이 소유한 복구 가능성**이다(Obsidian `.trash`, VS Code·Figma의 앱
//! undo 스택). 이 모듈이 memo의 그 복구 장치다: 파괴적 연산 직전 현재 본문을 vault 내부 슬롯에
//! 스냅샷하고, 스냅샷 목록 조회와 특정 스냅샷 복원을 제공한다.
//!
//! 저장 위치 판단 — vault 내부 `.memo/trash/<id>/`:
//! 왜 vault 내부인가: 스냅샷은 **노트 콘텐츠에 속한** 데이터라 노트와 함께 다니는 편이 자연스럽다
//! (공유 설정 `.memo/shared-settings.json`과 같은 원칙 — [`crate::settings::shared_settings_path`]).
//! 왜 `notes/`가 아니라 `.memo/` 아래인가: [`crate::reconcile`]와 [`crate::notes::Vault::list_note_ids`]는
//! `notes/`의 `.md`만 스캔한다 — 스냅샷을 그 아래 두면 복구본이 진짜 노트로 오인돼 목록·검색·시작
//! 재조정에 새어 나온다. `.memo/` 아래로 격리해 그 오염을 원천 차단한다.
//!
//! 보존 상한(무한 누적 방지): 스냅샷은 본문 전체 사본이라 방치하면 디스크를 채운다. 서로 독립인
//! 두 상한을 **매 스냅샷마다** 함께 적용한다(둘 중 하나만으로는 각각 반대쪽 실패 모드를 못 막는다):
//! - [`MAX_SNAPSHOTS_PER_NOTE`]: 한 노트를 짧은 시간에 여러 번 덮어써도 개수가 폭발하지 않게.
//! - [`MAX_SNAPSHOT_AGE_MS`]: 한 번 편집 후 버려진 노트의 오래된 스냅샷이 영원히 남지 않게.
//!
//! 경로 안전: 노트 id·스냅샷 id 모두 경로 조립 직전 [`crate::notes::is_safe_note_id`]로 검증한다
//! (구분자·`..`·`:` 거부). 계약이 id를 "불투명 식별자"로 약속하므로, 복구 슬롯 경로를 짜는
//! 이쪽에서도 같은 관문을 다시 세운다(심층 방어 — `Vault`가 이미 검증했더라도 여기서 이중화한다).

use crate::io::{read_to_string, write_atomic};
use crate::notes::{derive_title, is_blank, is_safe_note_id, now_ms};
use serde::Serialize;
use std::io;
use std::path::PathBuf;

/// 노트당 보관할 스냅샷 개수 상한 — 초과하면 오래된 것부터 정리한다.
///
/// 왜 20인가: 스티키 노트 한 건의 편집 세션에서 나올 수 있는 파괴적 저장(전체 덮어쓰기) 횟수를
/// 넉넉히 덮으면서도, 본문 사본 20개는 작은 노트 기준 디스크 부담이 무시할 수준이다.
pub const MAX_SNAPSHOTS_PER_NOTE: usize = 20;

/// 스냅샷 나이 상한(에폭 ms 기준, 30일) — 이보다 오래된 스냅샷은 정리한다.
///
/// 왜 나이 상한도 두는가: 개수 상한만 두면 "한 번 편집하고 버린 노트"의 스냅샷 몇 개가 개수
/// 상한에 걸리지 않아 영원히 남는다. 30일은 "실수를 되돌리고 싶은" 현실적 구제 창을 덮으면서
/// 무기한 축적을 끊는 절충값이다.
pub const MAX_SNAPSHOT_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 노트당 보관할 스냅샷 **총 바이트** 상한(4MiB) — 초과하면 오래된 중간 세대부터 정리한다.
///
/// 왜 개수·나이 말고 용량 축도 두는가: 개수 상한([`MAX_SNAPSHOTS_PER_NOTE`])은 사본 **수**만
/// 묶고 **크기**는 못 묶는다. `notes:write` 플러그인이 한 노트를 대용량 본문으로 여러 번
/// overwrite하면(overwrite는 덮기 직전 이전 본문 전체를 스냅샷한다) 노트당 고정량 ≈ 개수 ×
/// 본문 크기로 커져, 이를 모든 노트에 반복하면 디스크를 수 GB까지 잠식할 수 있다. 이 상한이
/// 노트당 축적을 묶어(호스트의 쓰기당 바이트 상한과 함께) 디스크 소진을 막는다. 4MiB는
/// 스티키 노트 한 건의 복구 역사로 넉넉하면서도(쓰기당 상한 1MiB의 여러 배) 축적을 끊는 값이다.
pub const MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE: usize = 4 * 1024 * 1024;

/// 목록 미리보기에 실을 본문 앞부분 최대 문자 수(코드포인트).
const PREVIEW_CHARS: usize = 80;

/// 복구 슬롯 스냅샷 한 건의 요약(목록 표시·복원 대상 식별용).
///
/// serde 필드명(snake_case)이 그대로 IPC 경계를 넘어 프론트 `NoteSnapshot`과 짝을 이룬다 —
/// 이름을 바꾸면 프론트 바인딩(`shared/tauri.ts`)도 함께 바꿔야 한다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    /// 스냅샷 식별자(파일 stem) — 복원·읽기 호출에 그대로 되돌려 준다.
    pub id: String,
    /// 스냅샷을 찍은 시각(에폭 ms) — 목록 정렬·"언제 저장본" 표기용.
    pub captured_at: i64,
    /// 본문 첫 줄에서 파생한 제목(목록에서 어느 버전인지 알아보게).
    pub title: String,
    /// 본문 앞부분 미리보기([`PREVIEW_CHARS`]자 이내).
    pub preview: String,
    /// 스냅샷 본문의 바이트 크기.
    pub bytes: usize,
}

/// vault 한 곳의 복구 장치 뷰(휴지통 루트 = `<vault>/.memo/trash`).
pub struct Trash {
    vault_root: PathBuf,
}

impl Trash {
    /// vault 루트로 복구 장치를 연다(디렉터리 생성은 스냅샷 시점에).
    pub fn new(vault_root: impl Into<PathBuf>) -> Self {
        Trash {
            vault_root: vault_root.into(),
        }
    }

    /// 휴지통 루트 `.memo/trash`.
    fn trash_root(&self) -> PathBuf {
        self.vault_root.join(".memo").join("trash")
    }

    /// 노트 하나의 스냅샷 디렉터리 `.memo/trash/<id>`. 경로 형태 id는 거부한다.
    fn note_dir(&self, id: &str) -> io::Result<PathBuf> {
        check_id(id, "노트 id")?;
        Ok(self.trash_root().join(id))
    }

    /// 스냅샷 파일 경로 `.memo/trash/<id>/<snapshot_id>.md`. 두 id 모두 경로 형태를 거부한다.
    fn snapshot_path(&self, id: &str, snapshot_id: &str) -> io::Result<PathBuf> {
        let dir = self.note_dir(id)?;
        check_id(snapshot_id, "스냅샷 id")?;
        Ok(dir.join(format!("{snapshot_id}.md")))
    }

    /// 파괴적 연산 직전 `previous`(이전 본문)를 복구 슬롯에 저장한다.
    ///
    /// 본문이 공백뿐이면(=잃을 것이 없으면) 스냅샷을 만들지 않고 `Ok(None)`을 돌려준다 —
    /// 시작 시 빈 노트 정리([`crate::state`])나 빈 노트 덮어쓰기가 휴지통을 잡동사니로 채우지
    /// 않게 한다. 스냅샷을 남기면 그 식별자(`snapshot_id`)를 `Ok(Some(..))`으로 돌려준다.
    /// 저장 후 [`MAX_SNAPSHOTS_PER_NOTE`]·[`MAX_SNAPSHOT_AGE_MS`] 상한을 즉시 적용한다.
    pub fn snapshot(&self, id: &str, previous: &str) -> io::Result<Option<String>> {
        if is_blank(previous) {
            return Ok(None);
        }
        let ms = now_ms();
        // 같은 ms에 두 번 찍혀도 충돌하지 않게 짧은 uuid 접미사를 붙인다. stem은 `<ms>-<hex>`라
        // `-` 앞부분을 정수로 파싱하면 캡처 시각을 되찾는다(파일명 하나에 시각을 실어, 사이드카
        // 없이도 목록 정렬·나이 상한을 계산한다).
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let snapshot_id = format!("{ms}-{}", &unique[..8]);
        let path = self.snapshot_path(id, &snapshot_id)?;
        write_atomic(&path, previous)?;
        self.prune(id)?;
        Ok(Some(snapshot_id))
    }

    /// 노트의 스냅샷 목록을 최신순(캡처 시각 내림차순)으로 돌려준다. 디렉터리가 없으면 빈 벡터.
    pub fn list(&self, id: &str) -> io::Result<Vec<Snapshot>> {
        let dir = self.note_dir(id)?;
        let mut out = Vec::new();
        if !dir.exists() {
            return Ok(out);
        }
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            // 손상돼 못 읽는 스냅샷은 목록에서 조용히 건너뛴다(하나가 깨져도 나머지는 보인다).
            let Ok(body) = read_to_string(&path) else {
                continue;
            };
            out.push(Snapshot {
                id: stem.to_string(),
                captured_at: captured_at_of(stem),
                title: derive_title(&body),
                preview: preview_of(&body),
                bytes: body.len(),
            });
        }
        // 최신순: 캡처 시각 내림차순, 동률이면 id로 안정 정렬(파싱 불가한 0은 뒤로 밀린다).
        out.sort_by(|a, b| {
            b.captured_at
                .cmp(&a.captured_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(out)
    }

    /// 특정 스냅샷의 본문을 읽는다(없으면 io NotFound 오류).
    pub fn read(&self, id: &str, snapshot_id: &str) -> io::Result<String> {
        let path = self.snapshot_path(id, snapshot_id)?;
        read_to_string(&path)
    }

    /// 스냅샷을 하나라도 가진 노트 id를 모두 열거한다(정렬). 휴지통 루트가 없으면 빈 벡터.
    ///
    /// 역할: `.memo/trash` 아래 하위 디렉터리 이름(=노트 id)을 모은다.
    /// 왜: `notes/*.md`만 스캔하는 노트 목록에는 **삭제된 노트**가 없어, 삭제된 노트의 복구
    /// 스냅샷이 복구 화면에 영영 나타나지 못했다(백엔드 복구 기능이 배선 없이 죽어 있었다).
    /// 이 열거로 존재하는 노트 목록과 합쳐, 삭제된 노트의 스냅샷도 복구 표면에 올린다.
    /// 경로 형태 이름은 스냅샷 경로가 이미 검증돼 만들어질 수 없지만 방어적으로 거른다(심층 방어).
    pub fn note_ids(&self) -> io::Result<Vec<String>> {
        let mut ids = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.trash_root()) else {
            return Ok(ids); // 아직 아무 스냅샷도 없음(루트 부재).
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if is_safe_note_id(name) {
                    ids.push(name.to_string());
                }
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// 보존 상한을 적용한다 — 나이 초과분을 먼저 지우고, 그래도 개수 상한을 넘으면 오래된 것부터
    /// 지운다. 정리 실패(개별 파일 삭제 오류)는 최선 노력으로 흡수한다(정리 못 한 스냅샷이
    /// 남는 것이, 정리 실패로 방금 만든 스냅샷을 잃는 것보다 낫다).
    fn prune(&self, id: &str) -> io::Result<()> {
        let mut snaps = self.list(id)?; // 최신순
        let now = now_ms();
        // 1) 나이 상한: 캡처 시각을 아는(>0) 스냅샷 중 상한을 넘긴 것을 지운다.
        snaps.retain(|s| {
            let too_old = s.captured_at > 0 && now - s.captured_at > MAX_SNAPSHOT_AGE_MS;
            if too_old {
                self.remove_file(id, &s.id);
            }
            !too_old
        });
        // 2) 개수 상한: 남은 것이 상한을 넘으면 오래된 것부터 지우되, **가장 오래된(최초/원본)
        //    스냅샷은 항상 보존한다**. 최초 스냅샷은 대개 사용자의 원본(플러그인 개입 이전) 본문 —
        //    복구 상황에서 가장 되찾고 싶은 판본이다. `notes:write`를 부여받은 플러그인이 한 노트를
        //    상한(20)보다 여러 번 overwrite하면(악의적 루프이든, 저장마다 덮는 동기화/포매터이든)
        //    개수 상한만으로는 원본이 링버퍼에서 밀려나 광고된 나이 상한 30일과 달리 몇 분 만에
        //    사라진다. 그래서 최신 (상한-1)개 + 최초 1개를 남기고 그 사이 중간 세대만 지운다 —
        //    원본은 나이 상한([`MAX_SNAPSHOT_AGE_MS`])으로만 사라진다(1단계에서 이미 적용됨).
        if snaps.len() > MAX_SNAPSHOTS_PER_NOTE {
            // snaps는 최신순 — 마지막 원소가 최초(원본). 최신 (상한-1)개와 마지막 1개는 남기고,
            // 그 사이[상한-1 .. 마지막)의 오래된 중간 세대를 지운다.
            let oldest = snaps.len() - 1;
            for s in &snaps[(MAX_SNAPSHOTS_PER_NOTE - 1)..oldest] {
                self.remove_file(id, &s.id);
            }
        }
        // 3) 용량 상한: 개수·나이 상한을 통과한 뒤에도 노트당 총 스냅샷 바이트가 상한을 넘으면,
        //    **중간 세대를 오래된 것부터** 지운다(개수 상한과 같은 보존 규칙 — 최신[0]과 최초[last]는
        //    최대한 남긴다). 개수 상한은 사본 '수'만, 이 상한은 사본 '크기'를 묶는다(대용량 반복
        //    overwrite가 노트당 스냅샷을 통째로 키우는 것을 막는다). 위 두 단계가 파일을 지웠을 수
        //    있으므로 현재 디스크 상태를 다시 읽어(정확한 bytes) 판정한다.
        let snaps = self.list(id)?; // 최신순 — 위 단계 반영
        let total: usize = snaps.iter().map(|s| s.bytes).sum();
        if total > MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE && snaps.len() > 2 {
            let last = snaps.len() - 1;
            let mut running = total;
            // 중간 세대(최신[0]·최초[last] 제외)만 **오래된 것부터** 지운다: 인덱스 last-1..=1.
            // 최신[0]과 최초[last]는 어떤 경우에도 지우지 않는다 — 이는 개수 상한(2단계)이
            // 지키기로 한 보존 규칙과 **정확히 같다**. 중간 세대를 다 지워도 최신+최초만으로
            // 상한을 넘으면, 상한을 잠깐 넘는 것을 감수한다(방금 만든 스냅샷도, 사용자 원본도
            // 잃지 않는 것이 이 prune의 일관된 원칙). 원본은 나이 상한([`MAX_SNAPSHOT_AGE_MS`])
            // 으로만 사라진다. 예전 구현은 여기서 최초[last](사용자 원본)를 지워, 큰 노트에서
            // 2단계의 원본 보존 보증을 조용히 무효화했다(대용량 원본 + overwrite 1회면
            // 중간 세대가 없어 곧장 원본이 삭제됐다).
            for i in (1..last).rev() {
                if running <= MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE {
                    break;
                }
                self.remove_file(id, &snaps[i].id);
                running -= snaps[i].bytes;
            }
        }
        Ok(())
    }

    /// 스냅샷 파일 하나를 최선 노력으로 지운다(정리 경로 전용 — 실패는 무시).
    fn remove_file(&self, id: &str, snapshot_id: &str) {
        if let Ok(path) = self.snapshot_path(id, snapshot_id) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 경로 조립에 안전한 id인지 검사한다([`is_safe_note_id`] 재사용). 위반은 io InvalidInput 오류.
fn check_id(id: &str, what: &str) -> io::Result<()> {
    if is_safe_note_id(id) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("잘못된 {what}(경로 형태 금지): {id:?}"),
        ))
    }
}

/// 스냅샷 stem(`<ms>-<hex>`)의 앞부분에서 캡처 시각(ms)을 되찾는다. 형식을 못 맞추면 0
/// (손으로 둔 파일 등) — 0은 목록에서 맨 뒤로 밀리고 나이 상한 대상에서 빠진다.
fn captured_at_of(stem: &str) -> i64 {
    stem.split_once('-')
        .and_then(|(ms, _)| ms.parse::<i64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(0)
}

/// 본문 앞부분 미리보기를 만든다([`PREVIEW_CHARS`]자 이내, 줄바꿈은 공백으로).
fn preview_of(body: &str) -> String {
    let flat: String = body
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .take(PREVIEW_CHARS)
        .collect();
    flat.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 스냅샷을 만들고 목록·읽기로 되찾을 수 있다.
    #[test]
    fn snapshot_then_list_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        let sid = trash.snapshot("note-1", "# 제목\n본문").unwrap().unwrap();

        let list = trash.list("note-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, sid);
        assert_eq!(list[0].title, "제목");
        assert!(list[0].captured_at > 0, "stem에서 캡처 시각을 되찾는다");
        assert_eq!(trash.read("note-1", &sid).unwrap(), "# 제목\n본문");
    }

    /// 가드: 공백뿐인 이전 본문은 스냅샷하지 않는다(잃을 것이 없다 → 휴지통 오염 방지).
    #[test]
    fn blank_previous_is_not_snapshotted() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        assert_eq!(trash.snapshot("n", "   \n\t").unwrap(), None);
        assert!(trash.list("n").unwrap().is_empty());
    }

    /// 가드: 없는 노트/스냅샷 목록·읽기는 각각 빈 벡터·오류다(패닉 없음).
    #[test]
    fn missing_note_lists_empty_and_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        assert!(trash.list("never").unwrap().is_empty());
        assert!(trash.read("never", "0-abc").is_err());
    }

    /// 가드(보존 상한 — 개수): 개수 상한을 넘겨 저장하면 오래된 것부터 정리돼 상한을 넘지 않는다.
    #[test]
    fn count_cap_prunes_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        // 상한 + 5개를 저장한다(각기 다른 내용이라 blank로 건너뛰지 않는다).
        for i in 0..(MAX_SNAPSHOTS_PER_NOTE + 5) {
            trash.snapshot("n", &format!("버전 {i}")).unwrap();
        }
        let list = trash.list("n").unwrap();
        assert_eq!(list.len(), MAX_SNAPSHOTS_PER_NOTE, "개수 상한으로 접힌다");
    }

    /// 가드(데이터 안전 — 원본 보존): 개수 상한을 넘겨 덮어써도 **최초(원본) 스냅샷**은 밀려나지
    /// 않는다. 플러그인이 한 노트를 상한보다 여러 번 overwrite해도 사용자의 원본 본문이 살아남는다.
    #[test]
    fn count_cap_preserves_original_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        // 사용자의 원본 본문을 가장 오래된 스냅샷으로 심는다(나이 상한 미만의 과거 시각).
        let base_ms = now_ms() - 1_000_000;
        let orig_id = format!("{base_ms}-aaaaaaaa");
        let orig_path = trash.snapshot_path("n", &orig_id).unwrap();
        write_atomic(&orig_path, "사용자 원본 본문").unwrap();
        // 플러그인이 그 뒤 상한+5회 덮어쓴다(각기 더 최신 시각·다른 내용).
        for i in 0..(MAX_SNAPSHOTS_PER_NOTE + 5) {
            let ms = base_ms + 1000 + i as i64;
            let p = trash.snapshot_path("n", &format!("{ms}-bbbbbbbb")).unwrap();
            write_atomic(&p, &format!("플러그인 덮어쓰기 {i}")).unwrap();
        }
        // 정상 경로로 한 번 더 저장해 prune을 태운다(now_ms → 목록 맨 앞).
        trash.snapshot("n", "마지막 저장").unwrap();

        let list = trash.list("n").unwrap();
        assert_eq!(list.len(), MAX_SNAPSHOTS_PER_NOTE, "개수 상한으로 접힌다");
        assert!(
            list.iter().any(|s| s.id == orig_id),
            "최초(원본) 스냅샷은 개수 상한에서 보호된다"
        );
        assert_eq!(trash.read("n", &orig_id).unwrap(), "사용자 원본 본문");
    }

    /// 가드(데이터 안전 — 용량): 노트당 총 스냅샷 바이트가 상한을 넘으면 오래된 중간 세대부터
    /// 정리돼 상한 이하로 유지되고, **방금 만든 최신 스냅샷은 반드시 남는다**. 개수 상한(20)에
    /// 걸리지 않는 소수의 대용량 스냅샷도 이 축으로 묶인다.
    #[test]
    fn total_bytes_cap_prunes_and_keeps_newest() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        let big = "x".repeat(1024 * 1024); // 1MiB
                                           // 서로 다른(순증) 캡처 시각을 stem에 박아 대용량 스냅샷 5개를 심는다(각 ~1MiB, 총 ~5MiB
                                           // > 상한 4MiB). 개수(5)는 개수 상한(20)에 안 걸리므로 순수하게 용량 축만 검증한다.
        let base_ms = now_ms() - 1_000_000;
        for i in 0..5 {
            let ms = base_ms + i as i64;
            let p = trash.snapshot_path("n", &format!("{ms}-cccccccc")).unwrap();
            write_atomic(&p, &big).unwrap();
        }
        let before: usize = trash.list("n").unwrap().iter().map(|s| s.bytes).sum();
        assert!(
            before > MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE,
            "심은 스냅샷이 상한을 넘는다"
        );
        // 정상 경로로 한 번 더 저장해 prune을 태운다(now_ms → 목록 맨 앞 = 최신).
        let newest = trash.snapshot("n", "마지막 저장").unwrap().unwrap();

        let list = trash.list("n").unwrap();
        let total: usize = list.iter().map(|s| s.bytes).sum();
        assert!(
            total <= MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE,
            "총 바이트가 상한 이하로 접힌다: {total}"
        );
        assert_eq!(list[0].id, newest, "최신 스냅샷은 지워지지 않는다");
        assert_eq!(trash.read("n", &newest).unwrap(), "마지막 저장");
    }

    /// 가드(데이터 안전 — 용량 vs 원본): 용량 상한(3단계)이 개수 상한(2단계)의 원본 보존 보증을
    /// 무효화하지 않는다. 상한을 홀로 넘기는 **대용량 사용자 원본** + 플러그인 overwrite 1회로
    /// 총 바이트가 상한을 넘겨도, 최초(원본) 스냅샷은 살아남는다(중간 세대가 없어 지울 것이 없으면
    /// 상한을 잠깐 넘는 것을 감수한다). 예전 구현은 이 경우 원본을 지워 유일한 백업을 잃었다.
    #[test]
    fn total_bytes_cap_preserves_original_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        // 사용자 원본(최초) — 용량 상한(4MiB)을 홀로 넘기는 대용량 본문(긴 문서를 붙여넣은 노트).
        let orig_body = "o".repeat(MAX_SNAPSHOT_TOTAL_BYTES_PER_NOTE + 512 * 1024);
        let base_ms = now_ms() - 1_000_000;
        let orig_id = format!("{base_ms}-aaaaaaaa");
        write_atomic(&trash.snapshot_path("n", &orig_id).unwrap(), &orig_body).unwrap();
        // notes:write 플러그인이 그 노트를 덮어써 두 번째(최신) 스냅샷을 남기고 prune을 태운다.
        trash.snapshot("n", "플러그인 덮어쓰기").unwrap();

        let list = trash.list("n").unwrap();
        assert!(
            list.iter().any(|s| s.id == orig_id),
            "용량 상한이 사용자 원본(최초) 스냅샷을 지우면 안 된다"
        );
        assert_eq!(trash.read("n", &orig_id).unwrap(), orig_body);
    }

    /// 가드(보존 상한 — 나이): 상한보다 오래된 스냅샷은 다음 스냅샷 저장 시 정리된다.
    ///
    /// 나이 상한을 실제 벽시계 없이 검증하려고, 오래된 캡처 시각을 stem에 박은 스냅샷 파일을
    /// 손으로 심고(=자연 발생 경로와 같은 파일 형식) 새 스냅샷을 한 번 저장해 prune을 태운다.
    #[test]
    fn age_cap_prunes_stale_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        // 상한을 훨씬 넘긴 과거 시각(ms)으로 stem을 지어 스냅샷 파일을 심는다.
        let old_ms = now_ms() - MAX_SNAPSHOT_AGE_MS - 1000;
        let stale_path = trash
            .snapshot_path("n", &format!("{old_ms}-deadbeef"))
            .unwrap();
        write_atomic(&stale_path, "아주 오래된 본문").unwrap();
        assert_eq!(trash.list("n").unwrap().len(), 1);

        // 새 스냅샷을 저장하면 prune이 돌아 오래된 것을 지운다 → 새 것 하나만 남는다.
        trash.snapshot("n", "새 본문").unwrap();
        let list = trash.list("n").unwrap();
        assert_eq!(list.len(), 1, "오래된 스냅샷은 정리된다");
        assert_eq!(list[0].title, "새 본문");
    }

    /// 가드(보안 — 경로 인젝션): 경로 형태의 노트 id·스냅샷 id는 파일시스템에 닿기 전에
    /// 거부된다(복구 슬롯 경로 조립도 [`is_safe_note_id`]와 같은 관문을 통과해야 한다).
    #[test]
    fn rejects_path_escaping_ids() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        for bad in ["../secret", "a/b", "a\\b", "..", "C:evil", ""] {
            assert!(trash.snapshot(bad, "x").is_err(), "snapshot({bad:?})");
            assert!(trash.list(bad).is_err(), "list({bad:?})");
            assert!(trash.read(bad, "0-a").is_err(), "read({bad:?})");
        }
        // 스냅샷 id 쪽도 막힌다(정상 노트 id + 경로 형태 스냅샷 id).
        assert!(trash.read("n", "../escape").is_err());
        assert!(trash.read("n", "a/b").is_err());
    }

    /// 가드: 최신 스냅샷이 목록 맨 앞에 온다(캡처 시각 내림차순).
    #[test]
    fn list_is_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let trash = Trash::new(dir.path());
        // 서로 다른 캡처 시각을 stem에 박아 순서를 결정적으로 만든다.
        for (ms, body) in [
            (1000i64, "가장 오래됨"),
            (3000, "가장 최신"),
            (2000, "중간"),
        ] {
            let p = trash.snapshot_path("n", &format!("{ms}-aaaaaaaa")).unwrap();
            write_atomic(&p, body).unwrap();
        }
        let list = trash.list("n").unwrap();
        assert_eq!(list[0].title, "가장 최신");
        assert_eq!(list[2].title, "가장 오래됨");
    }
}
