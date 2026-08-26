//! 노트 제목·본문 substring 검색 — IO와 분리된 순수 로직 + 결과 타입.
//!
//! 역할: (id, 본문) 목록에서 질의어를 대소문자 무시로 찾아 소환용 결과를 만든다.
//! 왜: 검색 핵심을 순수 함수로 두어 파일 IO 없이 테스트하고, 커맨드는 읽기만 담당한다.

use crate::notes::derive_title;
use serde::Serialize;

/// 검색 입력 한 건 — 노트의 본문과, 매치되면 결과에 **해석 없이 그대로** 실어 보낼 목록 메타.
///
/// 튜플이 아니라 struct인 이유: 패널이 정렬에 쓰는 메타가 늘어나면서(생성·수정·최근 연 시각)
/// 필드 순서만으로는 어느 `i64`가 무엇인지 호출부에서 분간할 수 없게 됐다 — 시각 두 개를
/// 맞바꿔 넣어도 컴파일러가 잡아 주지 못하는 자리다.
#[derive(Debug)]
pub struct SearchEntry {
    pub id: String,
    pub content: String,
    /// 생성 시각(에폭 ms).
    pub created_at: i64,
    /// 즐겨찾기 여부([`crate::model::NoteMeta::favorite`] — 창 「항상 위」와 무관).
    pub favorite: bool,
    /// 본문(`.md`) 파일이 마지막으로 바뀐 시각(에폭 ms).
    pub content_updated_at: i64,
    /// 사용자가 직접 마지막으로 연 시각(에폭 ms). 기록된 적 없으면 `None`.
    pub opened_at: Option<i64>,
}

/// 검색 결과 한 건(노트 소환에 필요한 최소 정보 + 미리보기 + 패널 정렬용 메타).
///
/// 정렬용 4개 필드(`favorite`·`content_updated_at`·`char_count`·`opened_at`)는 목록
/// 항목([`crate::commands::NoteSummary`])과 **같은 이름·같은 타입**이다 — 패널은 검색 중에도
/// 같은 정렬 함수를 쓰므로 두 모양이 갈리면 검색 결과만 정렬이 다르게 나온다.
#[derive(Debug, Serialize, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub snippet: String,
    /// 생성 시각(에폭 ms) — 패널 목록의 생성일 표기용(항목에서 그대로 전달).
    pub created_at: i64,
    /// 즐겨찾기 여부 — 패널이 검색 결과 **안에서** 맨 위 묶음으로 올린다(필터를 이기지 않는다).
    pub favorite: bool,
    /// 본문(`.md`) mtime(에폭 ms) — 「수정순」 정렬 키.
    pub content_updated_at: i64,
    /// 마크다운 원문 글자 수(공백 포함) — 「글자수 많은 순」 정렬 키.
    pub char_count: u64,
    /// 사용자가 직접 마지막으로 연 시각(에폭 ms). 없으면 JSON `null`.
    pub opened_at: Option<i64>,
}

/// 노트 목록에서 질의어를 제목·본문에서 찾는다(대소문자 무시 substring).
///
/// 역할: 빈 질의어는 빈 결과. 제목 또는 본문에 매치가 있으면 포함하고, 본문 매치는
/// 주변을 잘라 snippet으로, 제목만 매치면 제목을 snippet으로 쓴다(목록 미리보기용).
/// 시각·즐겨찾기 값은 해석 없이 매치된 항목의 값을 그대로 실어 보내고, `char_count`만
/// 본문에서 센다(목록 커맨드와 같은 규칙 — 마크다운 원문 글자 수, 공백 포함).
pub fn search_notes(entries: &[SearchEntry], query: &str) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    entries
        .iter()
        .filter_map(|entry| {
            let content = &entry.content;
            let title = derive_title(content);
            let body_pos = content.to_lowercase().find(&needle);
            if !title.to_lowercase().contains(&needle) && body_pos.is_none() {
                return None;
            }
            let snippet = match body_pos {
                Some(pos) => snippet_around(content, pos),
                None => title.clone(),
            };
            Some(SearchHit {
                id: entry.id.clone(),
                title,
                snippet,
                created_at: entry.created_at,
                favorite: entry.favorite,
                content_updated_at: entry.content_updated_at,
                char_count: content.chars().count() as u64,
                opened_at: entry.opened_at,
            })
        })
        .collect()
}

/// 본문 위치 `pos`(바이트) 주변을 한 줄 미리보기로 자른다(문자 경계 안전, 양끝 …).
fn snippet_around(content: &str, pos: usize) -> String {
    const BEFORE: usize = 20;
    const AFTER: usize = 50;
    // pos가 문자 경계가 아닐 수 있으니(소문자화 길이차) 가장 가까운 경계로 내린다.
    let safe = (0..=pos.min(content.len()))
        .rev()
        .find(|&i| content.is_char_boundary(i))
        .unwrap_or(0);
    let char_at = content[..safe].chars().count();
    let chars: Vec<char> = content.chars().collect();
    let start = char_at.saturating_sub(BEFORE);
    let end = (char_at + AFTER).min(chars.len());
    let body = chars[start..end]
        .iter()
        .collect::<String>()
        .replace('\n', " ");
    let mut out = body.trim().to_string();
    if start > 0 {
        out = format!("…{out}");
    }
    if end < chars.len() {
        out = format!("{out}…");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 본문만 주고 나머지 메타는 기본값으로 채운 입력(대부분의 테스트가 메타에 무관심하다).
    fn entry(id: &str, content: &str) -> SearchEntry {
        SearchEntry {
            id: id.into(),
            content: content.into(),
            created_at: 0,
            favorite: false,
            content_updated_at: 0,
            opened_at: None,
        }
    }

    fn sample() -> Vec<SearchEntry> {
        vec![
            entry("a", "# Shopping\nmilk and eggs"),
            entry("b", "# Ideas\nbuild a memo app today"),
            entry("c", "plain note about cats"),
        ]
    }

    /// 가드: 빈/공백 질의어는 빈 결과(전체 노출 방지).
    #[test]
    fn empty_query_returns_nothing() {
        assert!(search_notes(&sample(), "   ").is_empty());
    }

    /// 가드: 제목 매치는 대소문자를 무시한다.
    #[test]
    fn matches_title_case_insensitive() {
        let hits = search_notes(&sample(), "SHOPPING");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
        assert_eq!(hits[0].title, "Shopping");
    }

    /// 가드: 본문 매치는 질의어를 포함한 snippet을 만든다.
    #[test]
    fn matches_body_with_snippet() {
        let hits = search_notes(&sample(), "memo");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "b");
        assert!(hits[0].snippet.to_lowercase().contains("memo"));
    }

    /// 가드: 매치가 없으면 빈 결과.
    #[test]
    fn no_match_is_empty() {
        assert!(search_notes(&sample(), "zzz-none").is_empty());
    }

    /// 가드: 여러 노트가 동시에 매치될 수 있다.
    #[test]
    fn matches_multiple_notes() {
        let hits = search_notes(&sample(), "a");
        assert!(hits.len() >= 2);
    }

    /// 가드: 멀티바이트(한글) 본문에서도 패닉 없이 snippet을 만든다.
    #[test]
    fn multibyte_snippet_no_panic() {
        let entries = vec![entry("k", "회의 메모\n오늘 일정 정리")];
        let hits = search_notes(&entries, "일정");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("일정"));
    }

    /// 가드: 검색 결과는 매치된 항목의 created_at을 해석 없이 그대로 전달한다(패널 생성일 표기).
    #[test]
    fn carries_created_at_through() {
        let entries = vec![SearchEntry {
            created_at: 1_700_000_000_000,
            ..entry("a", "# Shopping\nmilk")
        }];
        let hits = search_notes(&entries, "shopping");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].created_at, 1_700_000_000_000);
    }

    /// 가드: 검색 결과가 패널 정렬용 메타 4개를 목록 항목과 **같은 이름·타입**으로 함께
    /// 나른다 — 즐겨찾기·수정 시각·최근 연 시각은 그대로 통과, 글자 수만 본문에서 센다.
    #[test]
    fn carries_sort_metadata_through() {
        let entries = vec![SearchEntry {
            favorite: true,
            content_updated_at: 1_800_000_000_000,
            opened_at: Some(1_900_000_000_000),
            ..entry("a", "# Shopping\nmilk")
        }];
        let hits = search_notes(&entries, "shopping");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].favorite);
        assert_eq!(hits[0].content_updated_at, 1_800_000_000_000);
        assert_eq!(hits[0].opened_at, Some(1_900_000_000_000));
        // "# Shopping\nmilk" = 15자(개행·마크다운 마커 포함, 원문 그대로).
        assert_eq!(hits[0].char_count, 15);
    }

    /// 가드: 글자 수는 바이트가 아니라 **문자** 수다(한글이 3배로 세지면 안 된다).
    #[test]
    fn char_count_counts_chars_not_bytes() {
        let entries = vec![entry("k", "회의 메모")];
        let hits = search_notes(&entries, "회의");
        assert_eq!(hits[0].char_count, 5, "「회의 메모」는 공백 포함 5자");
    }

    /// 가드: `opened_at`이 없으면 JSON에서 `null`로 나간다(생략되면 프론트의
    /// `number | null` 계약이 깨진다 — 필드 자체가 사라져 `undefined`가 된다).
    #[test]
    fn opened_at_serializes_as_null_when_missing() {
        let hits = search_notes(&sample(), "shopping");
        let json = serde_json::to_string(&hits[0]).unwrap();
        assert!(json.contains("\"opened_at\":null"), "{json}");
    }
}
