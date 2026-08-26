//! 시스템에 설치된 글꼴 열거 — 폰트 파일에서 패밀리 이름과 한글 지원 여부만 얇게 읽는다.
//!
//! 역할: OS 글꼴 폴더를 훑어 각 sfnt(ttf·otf·ttc)의 `name` 테이블에서 패밀리 이름을,
//! `cmap` 테이블에서 한글(U+AC00 '가') 포함 여부를 뽑아 설정 글꼴 피커의 후보 목록을 만든다.
//! 왜: 웹뷰(WKWebView)에는 로컬 글꼴을 열거하는 API가 없다 — "설치된 글꼴을 고른다"를
//! 지원하려면 백엔드가 알려주는 수밖에 없다. 파일을 통째로 읽지 않고 필요한 테이블만
//! 임의 접근으로 읽어(대형 CJK 글꼴은 수십 MB) 앱 시작·설정 변경마다 도는 열거를 가볍게 한다.
//!
//! 신뢰 경계: 폰트 파일은 신뢰할 수 없는 입력으로 다룬다 — 모든 오프셋·길이 읽기는
//! 경계 검사 후 `Option`으로 돌려주고, 깨진 파일은 조용히 건너뛴다(패닉 없음).

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 한글 지원 판정에 쓰는 대표 코드포인트 — U+AC00 '가'(한글 음절 블록의 첫 글자).
const HANGUL_PROBE: u32 = 0xAC00;

/// `name` 테이블 읽기 상한(바이트) — 이름 문자열 모음이라 실제로는 수 KB다.
const NAME_TABLE_CAP: u32 = 1 << 20;

/// `cmap` 테이블 읽기 상한(바이트) — CJK 글꼴의 큰 서브테이블도 담을 만큼 넉넉히.
const CMAP_TABLE_CAP: u32 = 8 << 20;

/// 글꼴 폴더를 훑을 때 방문할 파일 수 상한(비정상적으로 큰 폴더에서의 폭주 방지).
const MAX_FONT_FILES: usize = 4000;

/// 패밀리 이름 길이 상한(자) — 이보다 긴 값은 깨진 파일로 보고 버린다.
const MAX_FAMILY_LEN: usize = 64;

/// 열거된 시스템 글꼴 한 벌(프론트의 글꼴 피커 후보 1행).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SystemFont {
    /// CSS `font-family`에 그대로 쓸 수 있는 패밀리 이름(영문 이름 우선).
    pub family: String,
    /// 한글 글리프를 담고 있는지 — 프론트가 「한글」 구역으로 올리는 데 쓴다.
    pub korean: bool,
    /// 지역화 이름(영문 이름과 다를 때만) — 표시가 아니라 **검색어**로만 쓴다.
    ///
    /// 왜: 스택에 넣는 정규 이름은 영문("NanumGothic")이라, 한글로 "나눔"을 친 사용자가
    /// 아무것도 못 찾는다. 이름은 영문으로 두되 검색에는 지역화 이름도 걸리게 한다.
    pub alias: Option<String>,
}

/// 폰트 파일의 임의 위치를 읽는 최소 인터페이스(런타임=[`File`], 테스트=`&[u8]`).
///
/// 왜: 파싱을 순수 함수로 테스트하면서도, 실제 열거는 파일 전체를 메모리에 올리지 않고
/// 필요한 테이블만 seek해서 읽게 하기 위한 경계다.
pub trait ReadAt {
    /// `offset`부터 `len`바이트를 읽는다. 파일 끝을 넘거나 실패하면 `None`.
    fn read_at(&mut self, offset: u64, len: usize) -> Option<Vec<u8>>;
}

impl ReadAt for &[u8] {
    fn read_at(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
        let start = usize::try_from(offset).ok()?;
        let end = start.checked_add(len)?;
        self.get(start..end).map(|s| s.to_vec())
    }
}

impl ReadAt for File {
    fn read_at(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
        self.seek(SeekFrom::Start(offset)).ok()?;
        let mut buf = vec![0u8; len];
        self.read_exact(&mut buf).ok()?;
        Some(buf)
    }
}

/// 빅엔디언 u16을 경계 검사와 함께 읽는다.
fn u16_at(bytes: &[u8], index: usize) -> Option<u16> {
    let slice = bytes.get(index..index.checked_add(2)?)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

/// 빅엔디언 u32를 경계 검사와 함께 읽는다.
fn u32_at(bytes: &[u8], index: usize) -> Option<u32> {
    let slice = bytes.get(index..index.checked_add(4)?)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// sfnt 하나의 테이블 디렉터리를 읽어 `(태그, 오프셋, 길이)` 목록으로 돌려준다.
///
/// `base`는 이 sfnt의 시작 오프셋이다(ttc 안의 개별 글꼴은 0이 아니다). 테이블 오프셋은
/// ttc에서도 **파일 시작 기준**이라 그대로 쓴다.
fn table_directory<S: ReadAt>(src: &mut S, base: u64) -> Option<Vec<([u8; 4], u64, u32)>> {
    let header = src.read_at(base, 12)?;
    let count = u16_at(&header, 4)? as usize;
    let records = src.read_at(base + 12, count.checked_mul(16)?)?;
    let mut tables = Vec::with_capacity(count);
    for i in 0..count {
        let at = i * 16;
        let tag = [
            records[at],
            records[at + 1],
            records[at + 2],
            records[at + 3],
        ];
        tables.push((
            tag,
            u32_at(&records, at + 8)? as u64,
            u32_at(&records, at + 12)?,
        ));
    }
    Some(tables)
}

/// 테이블 디렉터리에서 태그로 `(오프셋, 길이)`를 찾는다(상한을 넘는 길이는 못 찾은 것으로).
fn find_table(tables: &[([u8; 4], u64, u32)], tag: &[u8; 4], cap: u32) -> Option<(u64, u32)> {
    tables
        .iter()
        .find(|(t, _, len)| t == tag && *len <= cap)
        .map(|(_, offset, len)| (*offset, *len))
}

/// `name` 레코드의 선호도 점수 — 클수록 좋다. 패밀리 이름이 아니면 `None`.
///
/// 우선순위: **언어가 먼저**(Windows en-US → Mac 영어 → Unicode → 그 외), 같은 언어 안에서
/// 타이포그래픽 패밀리(nameID 16) > 패밀리(nameID 1).
/// 왜: CSS가 매칭하는 정규 패밀리 이름은 영문 이름이다. 언어보다 nameID를 앞세우면 한 글꼴이
/// 영문·지역화 이름 두 행으로 갈라진다(예: "Apple SD Gothic Neo"와 "Apple SD 산돌고딕 Neo").
fn name_score(platform: u16, encoding: u16, language: u16, name_id: u16) -> Option<u32> {
    let locale = match (platform, encoding, language) {
        (3, 1 | 10, 0x0409) => 500, // Windows · UTF-16BE · en-US
        (1, 0, 0) => 400,           // Macintosh · Roman · 영어
        (0, _, _) => 300,           // Unicode 플랫폼(언어 없음)
        (3, 1 | 10, _) => 200,      // Windows · 그 외 언어(지역화 이름)
        (1, 0, _) => 100,           // Macintosh · 그 외 언어
        _ => return None,
    };
    let rank = match name_id {
        16 => 20,
        1 => 10,
        _ => return None,
    };
    Some(locale + rank)
}

/// `name` 레코드 바이트를 플랫폼 인코딩에 맞춰 문자열로 푼다(못 풀면 `None`).
///
/// Windows·Unicode 플랫폼은 UTF-16BE, Macintosh는 ASCII 범위만 받는다(MacRoman의 비ASCII는
/// 그대로 두면 깨진 글자가 되므로 그 레코드를 버린다 — 다른 레코드가 대신 뽑힌다).
fn decode_name(platform: u16, bytes: &[u8]) -> Option<String> {
    if platform == 1 {
        return if bytes.is_ascii() {
            Some(String::from_utf8_lossy(bytes).into_owned())
        } else {
            None
        };
    }
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

/// 패밀리 이름을 후보로 받아들일지 판정하고 다듬는다(그 외는 `None`).
///
/// 거르는 것: 빈 이름·과도한 길이·제어 문자·CSS 이탈 문자(`;{}<>\"'\\`)·macOS 내부 글꼴
/// (`.` 로 시작하는 `.SF NS` 등).
/// 왜: 이 이름은 프론트에서 `"<family>", <폴백>` 형태의 CSS 스택으로 조립된다 — 따옴표나
/// 이탈 문자가 들어가면 스타일이 깨지거나 주입 벡터가 된다. 경계에서 못박는다.
pub fn sanitize_family(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > MAX_FAMILY_LEN || name.starts_with('.') {
        return None;
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '"' | '\''))
    {
        return None;
    }
    Some(name.to_string())
}

/// [`name_score`]가 이 값보다 낮으면 지역화(영문이 아닌) 이름이다 — 언어 구간 200·100.
const LOCALIZED_BELOW: u32 = 300;

/// `name` 테이블에서 `(패밀리 이름, 지역화 이름)`을 뽑는다(후보로 못 쓸 이름이면 `None`).
///
/// 패밀리 이름은 영문을 앞세우고, 지역화 이름은 **검색용**으로 따로 들고 나온다(영문과 같으면
/// `None`). 영문 이름이 아예 없는 글꼴이면 지역화 이름이 패밀리가 되고 별칭은 비운다.
///
/// 살균([`sanitize_family`])은 **뽑은 뒤 한 번만** 적용한다 — 후보를 거르는 데 쓰면, 최선
/// 후보가 내부 글꼴(`.`로 시작)이라 버려질 때 그 아래 지역화 이름으로 흘러내린다. macOS의
/// AppleSDGothicNeo.ttc가 정확히 그래서, 내부 sfnt들이 "Apple SD 산돌고딕 Neo"라는 별도 행으로
/// 새어 나왔다. 최선 후보가 내부 글꼴이면 그 sfnt를 통째로 건너뛰는 게 맞다.
/// 다만 **디코드 실패**(MacRoman 비ASCII 등)는 그 레코드만 버리고 다음 후보로 넘어간다 —
/// 인코딩 한계일 뿐 "내부 글꼴" 신호가 아니기 때문이다.
pub fn names_from_name_table(table: &[u8]) -> Option<(String, Option<String>)> {
    let count = u16_at(table, 2)? as usize;
    let storage = u16_at(table, 4)? as usize;
    let mut best: Option<(u32, String)> = None;
    let mut localized: Option<(u32, String)> = None;
    for i in 0..count {
        let at = 6 + i * 12;
        let (Some(platform), Some(encoding), Some(language), Some(name_id)) = (
            u16_at(table, at),
            u16_at(table, at + 2),
            u16_at(table, at + 4),
            u16_at(table, at + 6),
        ) else {
            break; // 레코드 배열이 잘렸다 — 여기까지 모은 것으로 판정한다.
        };
        let Some(score) = name_score(platform, encoding, language, name_id) else {
            continue;
        };
        // 영문 후보와 지역화 후보를 따로 모은다 — 표시·스택은 영문, 검색은 둘 다.
        let slot = if score < LOCALIZED_BELOW {
            &mut localized
        } else {
            &mut best
        };
        if slot.as_ref().is_some_and(|(top, _)| *top >= score) {
            continue; // 이 자리엔 이미 더 좋은 후보가 있다 — 문자열을 풀 필요도 없다.
        }
        let (Some(length), Some(offset)) = (u16_at(table, at + 8), u16_at(table, at + 10)) else {
            break;
        };
        let start = storage + offset as usize;
        let Some(raw) = table.get(start..start.checked_add(length as usize)?) else {
            continue; // 오프셋이 테이블 밖 — 이 레코드만 버린다.
        };
        if let Some(name) = decode_name(platform, raw) {
            *slot = Some((score, name));
        }
    }
    // 영문 이름이 없으면 지역화 이름이 패밀리가 된다(그때 별칭은 비운다 — 같은 값이므로).
    let family = best
        .as_ref()
        .or(localized.as_ref())
        .and_then(|(_, name)| sanitize_family(name))?;
    let alias = localized
        .and_then(|(_, name)| sanitize_family(&name))
        .filter(|name| *name != family);
    Some((family, alias))
}

/// cmap 포맷 4(BMP 세그먼트) 서브테이블이 코드포인트를 담는지 판정한다.
fn format4_covers(sub: &[u8], code: u32) -> Option<bool> {
    let code = u16::try_from(code).ok()?;
    let seg_x2 = u16_at(sub, 6)? as usize;
    let ends = 14;
    let starts = ends + seg_x2 + 2; // endCode[] 다음의 reservedPad(u16)를 건너뛴다.
    let deltas = starts + seg_x2;
    let ranges = deltas + seg_x2;
    for i in (0..seg_x2).step_by(2) {
        if code > u16_at(sub, ends + i)? {
            continue;
        }
        if code < u16_at(sub, starts + i)? {
            return Some(false); // 세그먼트는 오름차순 — 이 구간 앞이면 미포함이다.
        }
        let range_offset = u16_at(sub, ranges + i)?;
        if range_offset == 0 {
            return Some(code.wrapping_add(u16_at(sub, deltas + i)?) != 0);
        }
        // idRangeOffset은 "그 필드 자신의 위치"를 기준으로 glyphIdArray를 가리킨다.
        let at =
            ranges + i + range_offset as usize + 2 * (code - u16_at(sub, starts + i)?) as usize;
        return Some(u16_at(sub, at)? != 0);
    }
    Some(false)
}

/// cmap 포맷 12(UCS-4 그룹) 서브테이블이 코드포인트를 담는지 판정한다.
fn format12_covers(sub: &[u8], code: u32) -> Option<bool> {
    let groups = u32_at(sub, 12)? as usize;
    for i in 0..groups {
        let at = 16 + i * 12;
        let start = u32_at(sub, at)?;
        if code < start {
            return Some(false); // 그룹은 오름차순 — 이 구간 앞이면 미포함이다.
        }
        if code <= u32_at(sub, at + 4)? {
            return Some(true);
        }
    }
    Some(false)
}

/// `cmap` 테이블의 유니코드 서브테이블 중 하나라도 코드포인트를 담으면 참.
///
/// 유니코드로 볼 수 있는 서브테이블만 본다: Unicode 플랫폼(0) 전체, Windows 플랫폼(3)의
/// BMP(enc 1)·UCS-4(enc 10). 심볼 인코딩(3/0) 등은 코드포인트 의미가 달라 제외한다.
pub fn cmap_covers(cmap: &[u8], code: u32) -> bool {
    let Some(count) = u16_at(cmap, 2) else {
        return false;
    };
    for i in 0..count as usize {
        let at = 4 + i * 8;
        let (Some(platform), Some(encoding), Some(offset)) =
            (u16_at(cmap, at), u16_at(cmap, at + 2), u32_at(cmap, at + 4))
        else {
            break;
        };
        if !matches!((platform, encoding), (0, _) | (3, 1) | (3, 10)) {
            continue;
        }
        let Some(sub) = cmap.get(offset as usize..) else {
            continue;
        };
        let covered = match u16_at(sub, 0) {
            Some(4) => format4_covers(sub, code),
            Some(12) => format12_covers(sub, code),
            _ => None, // 그 외 포맷(0·6·13…)은 판정하지 않는다 — 다른 서브테이블에 맡긴다.
        };
        if covered == Some(true) {
            return true;
        }
    }
    false
}

/// sfnt 하나(파일 시작 기준 `base`)에서 패밀리 이름과 한글 지원 여부를 읽는다.
pub fn read_sfnt<S: ReadAt>(src: &mut S, base: u64) -> Option<SystemFont> {
    let tables = table_directory(src, base)?;
    let (name_offset, name_len) = find_table(&tables, b"name", NAME_TABLE_CAP)?;
    let name_table = src.read_at(name_offset, name_len as usize)?;
    let (family, alias) = names_from_name_table(&name_table)?;
    // cmap이 없거나 깨졌으면 한글 미지원으로 둔다(이름은 이미 얻었으니 후보로는 살린다).
    let korean = find_table(&tables, b"cmap", CMAP_TABLE_CAP)
        .and_then(|(offset, len)| src.read_at(offset, len as usize))
        .is_some_and(|cmap| cmap_covers(&cmap, HANGUL_PROBE));
    Some(SystemFont {
        family,
        korean,
        alias,
    })
}

/// 폰트 파일 하나에서 글꼴들을 읽는다(ttc·otc는 안에 든 글꼴 전부).
pub fn read_font_file<S: ReadAt>(src: &mut S) -> Vec<SystemFont> {
    let Some(header) = src.read_at(0, 12) else {
        return Vec::new();
    };
    if &header[0..4] != b"ttcf" {
        return read_sfnt(src, 0).into_iter().collect();
    }
    let Some(count) = u32_at(&header, 8) else {
        return Vec::new();
    };
    let Some(offsets) = count
        .try_into()
        .ok()
        .and_then(|n: usize| n.checked_mul(4))
        .and_then(|len| src.read_at(12, len))
    else {
        return Vec::new();
    };
    (0..offsets.len() / 4)
        .filter_map(|i| u32_at(&offsets, i * 4))
        .filter_map(|base| read_sfnt(src, base as u64))
        .collect()
}

/// OS의 글꼴 설치 폴더 목록(macOS 전용 — 다른 OS에서는 빈 목록 = 열거 없음).
///
/// 왜: 이 앱은 macOS 전용이다. 다른 OS에서는 열거를 조용히 비워 "설치된 글꼴 없음"으로
/// 두고(피커는 플러그인이 공급한 후보만 보여 준다), 폴더 규약을 추측하지 않는다.
pub fn font_dirs(home: &Path) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/Library/Fonts"),
            home.join("Library/Fonts"),
        ]
    } else {
        Vec::new()
    }
}

/// 파일 이름이 우리가 파싱할 수 있는 sfnt 계열 확장자인지.
fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| matches!(e.as_str(), "ttf" | "otf" | "ttc" | "otc"))
}

/// 폴더(및 한 단계 하위 폴더)에서 폰트 파일 경로를 모은다.
///
/// macOS의 `/System/Library/Fonts/Supplemental`처럼 한 단계 아래에 더 있으므로 깊이 1까지
/// 내려간다. 그 이상은 내려가지 않는다(심링크 순환·엉뚱한 트리 탐색 방지).
fn collect_font_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FONT_FILES {
            return;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() && depth > 0 => collect_font_files(&path, depth - 1, out),
            Ok(t) if t.is_file() && is_font_file(&path) => out.push(path),
            _ => {}
        }
    }
}

/// 여러 파일에서 읽은 글꼴을 패밀리 이름으로 합친다(이름 오름차순, 대소문자 무시).
///
/// 같은 패밀리가 여러 파일(굵기·기울임 등)에 흩어져 있으므로 이름 기준으로 한 행으로 모으고,
/// 한 벌이라도 한글을 담으면 그 패밀리를 한글 글꼴로 본다.
pub fn dedupe_families(fonts: Vec<SystemFont>) -> Vec<SystemFont> {
    let mut merged: Vec<SystemFont> = Vec::new();
    for font in fonts {
        match merged.iter_mut().find(|f| f.family == font.family) {
            Some(existing) => {
                existing.korean |= font.korean;
                existing.alias = existing.alias.take().or(font.alias);
            }
            None => merged.push(font),
        }
    }
    merged.sort_by_key(|f| f.family.to_lowercase());
    merged
}

/// 시스템에 설치된 글꼴을 열거한다(읽기 실패·깨진 파일은 건너뛴다).
pub fn list_system_fonts(home: &Path) -> Vec<SystemFont> {
    let mut paths = Vec::new();
    for dir in font_dirs(home) {
        collect_font_files(&dir, 1, &mut paths);
    }
    let fonts = paths
        .iter()
        .filter_map(|path| File::open(path).ok())
        .flat_map(|mut file| read_font_file(&mut file))
        .collect();
    dedupe_families(fonts)
}

/// [`list_system_fonts`] 결과를 재사용하는 캐시 유효 기간.
///
/// 왜 영구 캐시가 아니라 TTL인가: 사용자가 앱을 켜 둔 채로 새 글꼴을 설치할 수 있다 —
/// 영구 캐시는 "방금 설치한 글꼴이 피커에 안 보인다"는 새 버그를 만든다. 반대로 매번
/// 스캔하면 설정 창에서 뭘 하나 바꿀 때마다(중앙 호스트 재빌드 때마다) 글꼴 폴더 수백
/// 파일을 여는 IO가 반복된다. 60초면 "연달아 설정을 만지는 동안"은 캐시로 넘기고,
/// 그보다 오래 걸리는 경우(설치 직후 재확인 등)엔 다시 스캔해 새 글꼴을 놓치지 않는다.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// 스캔 결과와 그 시각을 함께 들고 있는 캐시 한 칸.
struct FontCache {
    entry: Mutex<Option<(Vec<SystemFont>, Instant)>>,
}

impl FontCache {
    /// 빈 캐시를 만든다(`static`에 쓸 수 있게 `const`).
    const fn new() -> Self {
        Self {
            entry: Mutex::new(None),
        }
    }

    /// 캐시가 TTL 안이면 복제해 돌려주고, 아니면 `scan`으로 다시 채운다.
    ///
    /// 락을 쥔 채로 `scan`(IO)을 돌린다 — 이 락은 이 캐시 하나만 지키므로 다른 상태를 막지
    /// 않는다. 오히려 그래야 재빌드가 겹쳐 도착한 두 번째 호출이 스캔을 또 돌리지 않고
    /// 첫 호출이 채운 결과를 그대로 받는다(스캔이 스캔을 부르는 중복보다 잠깐의 대기가 싸다).
    fn get_or_scan(&self, scan: impl FnOnce() -> Vec<SystemFont>) -> Vec<SystemFont> {
        let mut guard = self
            .entry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((fonts, fetched_at)) = guard.as_ref() {
            if fetched_at.elapsed() < CACHE_TTL {
                return fonts.clone();
            }
        }
        let fonts = scan();
        *guard = Some((fonts.clone(), Instant::now()));
        fonts
    }
}

/// 프로세스 수명 동안 사는 전역 글꼴 캐시 — 이 캐시 전용 락이라 다른 상태와 얽히지 않는다.
static FONT_CACHE: FontCache = FontCache::new();

/// 캐시를 거쳐 시스템 글꼴을 돌려준다 — 설정 창 재빌드마다 불려도 TTL 안이면 재스캔하지 않는다.
pub fn list_system_fonts_cached(home: &Path) -> Vec<SystemFont> {
    let home = home.to_path_buf();
    FONT_CACHE.get_or_scan(move || list_system_fonts(&home))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 최소 sfnt 바이트를 조립한다 — 테이블 디렉터리 + 주어진 테이블들.
    ///
    /// `base`는 이 sfnt가 놓일 **파일 안 위치**다. 테이블 오프셋은 규격상 파일 시작 기준이라
    /// ttc(글꼴 모음) 안에 넣을 때는 그 위치를 더해 줘야 한다.
    fn sfnt_at(base: usize, tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0x00, 0x01, 0x00, 0x00];
        out.extend((tables.len() as u16).to_be_bytes());
        out.extend([0u8; 6]); // searchRange · entrySelector · rangeShift(미사용)
        let mut offset = base + 12 + tables.len() * 16;
        let mut body: Vec<u8> = Vec::new();
        for (tag, data) in tables {
            out.extend(**tag);
            out.extend(0u32.to_be_bytes()); // checksum(미사용)
            out.extend((offset as u32).to_be_bytes());
            out.extend((data.len() as u32).to_be_bytes());
            offset += data.len();
            body.extend(data);
        }
        out.extend(body);
        out
    }

    /// 파일 맨 앞에 놓이는 단독 sfnt.
    fn sfnt(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        sfnt_at(0, tables)
    }

    /// 최소 `name` 테이블을 조립한다 — `(platform, encoding, language, nameID, 이름)`.
    fn name_table(records: &[(u16, u16, u16, u16, &str)]) -> Vec<u8> {
        let mut strings = Vec::new();
        let mut entries = Vec::new();
        for (platform, encoding, language, name_id, text) in records {
            let bytes: Vec<u8> = if *platform == 1 {
                text.bytes().collect()
            } else {
                text.encode_utf16().flat_map(u16::to_be_bytes).collect()
            };
            entries.push((
                *platform,
                *encoding,
                *language,
                *name_id,
                strings.len(),
                bytes.len(),
            ));
            strings.extend(bytes);
        }
        let mut out = vec![0x00, 0x00];
        out.extend((entries.len() as u16).to_be_bytes());
        out.extend((6 + entries.len() as u16 * 12).to_be_bytes()); // stringOffset
        for (platform, encoding, language, name_id, offset, length) in entries {
            out.extend(platform.to_be_bytes());
            out.extend(encoding.to_be_bytes());
            out.extend(language.to_be_bytes());
            out.extend(name_id.to_be_bytes());
            out.extend((length as u16).to_be_bytes());
            out.extend((offset as u16).to_be_bytes());
        }
        out.extend(strings);
        out
    }

    /// 포맷 4 서브테이블 하나를 가진 `cmap` 테이블을 조립한다(세그먼트: `[start, end]` 목록).
    fn cmap_format4(segments: &[(u16, u16)]) -> Vec<u8> {
        // 마지막 세그먼트는 규격상 0xFFFF로 끝나야 한다(탐색 종료 표식).
        let mut segs: Vec<(u16, u16)> = segments.to_vec();
        segs.push((0xFFFF, 0xFFFF));
        let seg_x2 = (segs.len() * 2) as u16;
        let mut sub = vec![0x00, 0x04];
        sub.extend((16u16 + seg_x2 * 4).to_be_bytes()); // length
        sub.extend(0u16.to_be_bytes()); // language
        sub.extend(seg_x2.to_be_bytes());
        sub.extend([0u8; 6]); // searchRange · entrySelector · rangeShift(미사용)
        for (_, end) in &segs {
            sub.extend(end.to_be_bytes());
        }
        sub.extend(0u16.to_be_bytes()); // reservedPad
        for (start, _) in &segs {
            sub.extend(start.to_be_bytes());
        }
        for (start, _) in &segs {
            // idDelta: 글리프 id가 0이 되지 않게 start를 1로 옮긴다(매핑 있음 표시).
            sub.extend((1u16.wrapping_sub(*start)).to_be_bytes());
        }
        for _ in &segs {
            sub.extend(0u16.to_be_bytes()); // idRangeOffset(전부 delta 방식)
        }
        let mut out = vec![0x00, 0x00, 0x00, 0x01];
        out.extend(3u16.to_be_bytes()); // platformID: Windows
        out.extend(1u16.to_be_bytes()); // encodingID: BMP
        out.extend(12u32.to_be_bytes()); // 서브테이블 오프셋
        out.extend(sub);
        out
    }

    /// 가드: 영문 패밀리 이름과 한글 지원 여부를 함께 읽는다.
    #[test]
    fn reads_family_and_hangul_coverage() {
        let font = sfnt(&[
            (b"cmap", cmap_format4(&[(0xAC00, 0xD7A3)])),
            (b"name", name_table(&[(3, 1, 0x0409, 1, "Nanum Gothic")])),
        ]);
        let read = read_font_file(&mut font.as_slice());
        assert_eq!(
            read,
            vec![SystemFont {
                family: "Nanum Gothic".to_string(),
                korean: true,
                alias: None,
            }]
        );
    }

    /// 가드: 한글 구간이 없는 글꼴은 korean=false로 읽힌다(라틴 전용 글꼴 구분).
    #[test]
    fn marks_latin_only_font_as_non_korean() {
        let font = sfnt(&[
            (b"cmap", cmap_format4(&[(0x0020, 0x007E)])),
            (b"name", name_table(&[(3, 1, 0x0409, 1, "Helvetica")])),
        ]);
        assert!(!read_font_file(&mut font.as_slice())[0].korean);
    }

    /// 가드: 타이포그래픽 패밀리(nameID 16)를 일반 패밀리(nameID 1)보다 앞세운다.
    #[test]
    fn prefers_typographic_family_name() {
        let table = name_table(&[
            (3, 1, 0x0409, 1, "Helvetica Neue Light"),
            (3, 1, 0x0409, 16, "Helvetica Neue"),
        ]);
        assert_eq!(
            names_from_name_table(&table).map(|(f, _)| f).as_deref(),
            Some("Helvetica Neue")
        );
    }

    /// 가드: 지역화 이름이 아니라 영문 이름을 집는다 — 지역화 쪽이 상위 nameID여도 그렇다.
    ///
    /// 언어보다 nameID를 앞세우면 한 글꼴이 영문·한글 두 행으로 갈라진다(실제 macOS의
    /// AppleSDGothicNeo가 그랬다).
    #[test]
    fn prefers_english_name_over_localized() {
        let table = name_table(&[
            (3, 1, 0x0412, 16, "Apple SD 산돌고딕 Neo"),
            (3, 1, 0x0409, 1, "Apple SD Gothic Neo"),
        ]);
        assert_eq!(
            names_from_name_table(&table).map(|(f, _)| f).as_deref(),
            Some("Apple SD Gothic Neo")
        );
    }

    /// 가드(보안): CSS 이탈 문자가 든 이름은 버린다 — 프론트가 스택으로 조립하기 때문.
    #[test]
    fn rejects_names_with_css_escape_characters() {
        assert_eq!(sanitize_family("Arial\", x{display:none"), None);
        assert_eq!(sanitize_family("A;B"), None);
        assert_eq!(sanitize_family("A\\65"), None);
        assert_eq!(sanitize_family("It's"), None);
        assert_eq!(sanitize_family(" Arial "), Some("Arial".to_string()));
    }

    /// 가드: 지역화 이름을 검색용 별칭으로 함께 들고 나온다 — 한글로 "나눔"을 쳐도 걸리게.
    #[test]
    fn keeps_the_localized_name_as_a_search_alias() {
        let table = name_table(&[
            (3, 1, 0x0412, 1, "나눔고딕"),
            (3, 1, 0x0409, 1, "NanumGothic"),
        ]);
        assert_eq!(
            names_from_name_table(&table),
            Some(("NanumGothic".to_string(), Some("나눔고딕".to_string())))
        );
    }

    /// 가드: 영문 이름밖에 없으면 별칭은 비운다(같은 값을 두 번 들고 다니지 않게).
    #[test]
    fn leaves_the_alias_empty_without_a_localized_name() {
        let table = name_table(&[(3, 1, 0x0409, 1, "Helvetica")]);
        assert_eq!(
            names_from_name_table(&table),
            Some(("Helvetica".to_string(), None))
        );
    }

    /// 가드: 지역화 이름밖에 없으면 그게 패밀리가 되고 별칭은 비운다(중복 방지).
    #[test]
    fn falls_back_to_the_localized_name_as_the_family() {
        let table = name_table(&[(3, 1, 0x0412, 1, "나눔고딕")]);
        assert_eq!(
            names_from_name_table(&table),
            Some(("나눔고딕".to_string(), None))
        );
    }

    /// 가드: 최선 이름이 내부 글꼴(`.` 시작)이면 그 sfnt를 통째로 건너뛴다 — 아래 순위의
    /// 지역화 이름으로 흘러내려 같은 글꼴이 두 행이 되지 않게(AppleSDGothicNeo.ttc 실제 사례).
    #[test]
    fn skips_sfnt_whose_best_name_is_internal() {
        let table = name_table(&[
            (3, 1, 0x0409, 16, ".Apple SD Gothic NeoI"),
            (3, 1, 0x0412, 16, "Apple SD 산돌고딕 Neo"),
        ]);
        assert_eq!(names_from_name_table(&table), None);
    }

    /// 가드: 디코드 실패(MacRoman 비ASCII)는 그 레코드만 버리고 다음 후보로 넘어간다.
    #[test]
    fn falls_through_when_the_best_record_cannot_be_decoded() {
        let mut table = name_table(&[(1, 0, 0, 1, "placeholder"), (3, 1, 0x0412, 1, "나눔고딕")]);
        // Mac 레코드(최고 점수)의 문자열을 비ASCII로 덮어 디코드를 실패시킨다.
        let storage = 6 + 2 * 12;
        table[storage] = 0xC0;
        assert_eq!(
            names_from_name_table(&table).map(|(f, _)| f).as_deref(),
            Some("나눔고딕")
        );
    }

    /// 가드: macOS 내부 글꼴(`.` 로 시작)과 빈 이름은 후보에서 뺀다.
    #[test]
    fn rejects_hidden_and_empty_names() {
        assert_eq!(sanitize_family(".SF NS"), None);
        assert_eq!(sanitize_family("   "), None);
        assert_eq!(sanitize_family(&"A".repeat(65)), None);
    }

    /// 가드: ttc(글꼴 모음) 파일은 안에 든 글꼴을 전부 읽는다.
    #[test]
    fn reads_every_font_in_a_collection() {
        let body_at = 12 + 2 * 4; // ttc 헤더 + 글꼴 오프셋 배열 다음이 첫 글꼴이다.
        let first = sfnt_at(
            body_at,
            &[(b"name", name_table(&[(3, 1, 0x0409, 1, "First")]))],
        );
        let second = sfnt_at(
            body_at + first.len(),
            &[(b"name", name_table(&[(3, 1, 0x0409, 1, "Second")]))],
        );
        let mut out = b"ttcf".to_vec();
        out.extend(0x0001_0000u32.to_be_bytes()); // version
        out.extend(2u32.to_be_bytes()); // numFonts
        out.extend((body_at as u32).to_be_bytes());
        out.extend(((body_at + first.len()) as u32).to_be_bytes());
        out.extend(&first);
        out.extend(&second);

        let families: Vec<String> = read_font_file(&mut out.as_slice())
            .into_iter()
            .map(|f| f.family)
            .collect();
        assert_eq!(families, vec!["First", "Second"]);
    }

    /// 가드: 잘린·엉뚱한 바이트에도 패닉 없이 빈 결과를 돌려준다(신뢰 못 할 입력).
    #[test]
    fn survives_malformed_input() {
        assert!(read_font_file(&mut [].as_slice()).is_empty());
        assert!(read_font_file(&mut [0u8; 8].as_slice()).is_empty());
        assert!(read_font_file(&mut b"ttcf\xff\xff\xff\xff\xff\xff\xff\xff".as_slice()).is_empty());
        let truncated = sfnt(&[(b"name", name_table(&[(3, 1, 0x0409, 1, "X")]))]);
        assert!(read_font_file(&mut &truncated[..20]).is_empty());
    }

    /// 가드: 같은 패밀리는 한 행으로 합치고, 한 벌이라도 한글을 담으면 한글 글꼴로 본다.
    #[test]
    fn dedupes_families_and_keeps_hangul_flag() {
        let merged = dedupe_families(vec![
            SystemFont {
                family: "Nanum".to_string(),
                korean: false,
                alias: None,
            },
            SystemFont {
                family: "Apple".to_string(),
                korean: false,
                alias: None,
            },
            SystemFont {
                family: "Nanum".to_string(),
                korean: true,
                alias: Some("나눔".to_string()),
            },
        ]);
        assert_eq!(
            merged,
            vec![
                SystemFont {
                    family: "Apple".to_string(),
                    korean: false,
                    alias: None,
                },
                SystemFont {
                    family: "Nanum".to_string(),
                    korean: true,
                    alias: Some("나눔".to_string()),
                },
            ]
        );
    }

    /// 가드: 폰트 확장자만 훑는다(관련 없는 파일은 열지 않는다).
    #[test]
    fn recognizes_font_extensions_only() {
        assert!(is_font_file(Path::new("/x/A.ttf")));
        assert!(is_font_file(Path::new("/x/A.OTF")));
        assert!(is_font_file(Path::new("/x/A.ttc")));
        assert!(!is_font_file(Path::new("/x/A.txt")));
        assert!(!is_font_file(Path::new("/x/A")));
    }

    /// 가드: TTL 안의 두 번째 호출은 캐시를 그대로 돌려주고 `scan`을 다시 부르지 않는다.
    ///
    /// 전역 `static FONT_CACHE`를 쓰면 병렬로 도는 다른 테스트와 상태가 섞이므로, 이 테스트만
    /// 쓰는 로컬 `FontCache` 인스턴스로 검증한다(캐시 자체는 어떤 인스턴스든 동작이 같다).
    #[test]
    fn second_call_within_ttl_does_not_rescan() {
        let cache = FontCache::new();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let make = |name: &str| SystemFont {
            family: name.to_string(),
            korean: false,
            alias: None,
        };

        let first = cache.get_or_scan(|| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![make("First")]
        });
        let second = cache.get_or_scan(|| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![make("Second")]
        });

        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(first, vec![make("First")]);
        assert_eq!(second, vec![make("First")]); // 캐시된 첫 결과 그대로 — 재스캔 안 함.
    }

    /// 가드: TTL이 지나면(0초로 강제 만료) 다시 스캔한다 — 새 글꼴 설치가 영영 안 보이지
    /// 않게 하는 무효화 경로.
    #[test]
    fn rescans_after_ttl_elapses() {
        let cache = FontCache::new();
        let make = |name: &str| SystemFont {
            family: name.to_string(),
            korean: false,
            alias: None,
        };

        let first = cache.get_or_scan(|| vec![make("First")]);
        // 캐시 시각을 과거로 되돌려 TTL 만료를 흉내 낸다(실제 sleep 없이).
        {
            let mut guard = cache.entry.lock().unwrap();
            if let Some((_, fetched_at)) = guard.as_mut() {
                *fetched_at = Instant::now() - CACHE_TTL - Duration::from_secs(1);
            }
        }
        let second = cache.get_or_scan(|| vec![make("Second")]);

        assert_eq!(first, vec![make("First")]);
        assert_eq!(second, vec![make("Second")]); // 만료됐으니 새 스캔 결과를 받는다.
    }
}
