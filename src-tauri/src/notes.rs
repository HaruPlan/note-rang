//! 노트 저장소 (vault) — UUID 기반 `.md` 본문 + 사이드카 메타.
//!
//! 역할: vault 디렉터리 안에서 노트의 생성/읽기/쓰기/삭제/목록과 제목 파생을 담당한다.
//! 왜: 파일명을 UUID로 고정(rename 없음)해 동기화 충돌·깨진 참조를 줄이고, 본문(.md)과
//! 메타(.json)를 원자적으로 따로 저장한다.

use crate::io::{read_to_string, write_atomic};
use crate::model::NoteMeta;
use crate::trash::{Snapshot, Trash};
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 본문 첫 줄에서 제목을 파생한다.
///
/// 규칙: 첫 줄 trim → 선행 `#` 제거 → 다시 trim → 인라인 문법 벗기기(마크다운 강조·플러그인
/// 래퍼) → 다시 trim. 결과가 비면 "제목 없음".
/// 왜: 노트 목록·검색·트래시·트레이 목록·창 타이틀 전부 이 함수 하나로 제목을 얻는다(단일
/// 소비 지점: `commands.rs`·`search.rs`·`trash.rs`·`tray.rs`·`window_manager.rs`) — `{{굵게|#93b}}`
/// 같은 편집기 원문 문법이 창 타이틀·작업 표시줄·목록에 그대로 새어 나가던 문제(첫 줄이
/// 곧 표시용 제목이라는 전제가 인라인 문법과 부딪혔다)를 이 한 곳만 고쳐서 막는다.
pub fn derive_title(content: &str) -> String {
    let first = content.lines().next().unwrap_or("").trim();
    let stripped = first.trim_start_matches('#').trim_start();
    let plain = strip_inline_syntax(stripped);
    let plain = plain.trim();
    if plain.is_empty() {
        "제목 없음".to_string()
    } else {
        plain.to_string()
    }
}

/// 인라인 래퍼 문법을 벗겨 순수 텍스트만 남긴다. 완벽한 마크다운 파서가 아니라 "제목 한 줄에
/// 원문 기호가 새지 않을 정도"만 노린 단순 반복 치환이다 — 제목은 사람이 목록에서 훑어보는
/// 라벨이지 렌더링 결과가 아니므로, 중첩이 한두 겹 안 벗겨져도 무해하다.
///
/// 전체 파이프라인([`strip_inline_syntax_once`])을 최대 두 번 돌리는 이유: 한 겹의 문법이
/// 다른 겹을 감싸되 파이프라인 순서와 반대로 중첩된 경우(예: `**{{색|#fff}}**` — 중괄호
/// 처리가 파이프라인 앞쪽인데 여기서는 굵게가 바깥) 첫 판에서는 굵게만 벗겨지고 드러난
/// 중괄호는 다음 판에서 벗겨진다. 두 판이면 이 정도 상호 중첩까지는 충분히 커버된다.
fn strip_inline_syntax(s: &str) -> String {
    let mut out = s.to_string();
    for _ in 0..2 {
        let next = strip_inline_syntax_once(&out);
        if next == out {
            break;
        }
        out = next;
    }
    out
}

/// 인라인 문법 벗기기 한 판. 순서가 결과에 영향을 준다:
/// - `**굵게**`를 `*기울임*`보다 먼저 봐야 한다 — 반대로 하면 `**x**`의 바깥 `*` 한 쌍이
///   기울임으로 먼저 먹혀 `*x*`만 남고 나머지 `*` 두 개가 글자처럼 남는다.
/// - `{{...}}`(text-color·kbd, [`strip_curly_wrap`])는 자체적으로 "|#hex 꼬리가 있으면
///   text-color, 없으면 kbd"를 한 번에 가른다 — 두 빌트인 플러그인이 같은 `{{`/`}}` 구분자를
///   쓰기 때문(각 main.js 주석 참고).
fn strip_inline_syntax_once(s: &str) -> String {
    let s = strip_curly_wrap(s);
    let s = strip_wrap(&s, "**", "**");
    let s = strip_wrap(&s, "~~", "~~");
    let s = strip_wrap(&s, "==", "==");
    let s = strip_wrap(&s, "*", "*");
    let s = strip_wrap(&s, "`", "`");
    strip_three_part(&s, "[", "](", ")")
}

/// `{{...}}` 감싸기를 벗긴다 — 빌트인 두 인라인 패턴(text-color·kbd)이 이 구분자 하나를
/// 공유한다(`src/plugin/builtin/plugins/text-color/main.js`, `.../kbd/main.js`):
/// - `{{텍스트|#hex}}`(hex가 3·6자리 16진수일 때만) → `텍스트`만 남긴다.
/// - 그 외 `{{텍스트}}` → `텍스트` 전체를 남긴다(kbd).
///
/// 닫는 짝이 없는 `{{`는 평범한 텍스트로 그대로 둔다.
fn strip_curly_wrap(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(start) = rest.find("{{") else {
            result.push_str(rest);
            break;
        };
        let after_open = &rest[start + 2..];
        let Some(close_idx) = after_open.find("}}") else {
            result.push_str(&rest[..start + 2]);
            rest = after_open;
            continue;
        };
        let inner = &after_open[..close_idx];
        result.push_str(&rest[..start]);
        result.push_str(strip_hex_color_tail(inner));
        rest = &after_open[close_idx + 2..];
    }
    result
}

/// `inner`가 `...|#hex`(3 또는 6자리 16진수, 대소문자 무관)로 끝나면 그 꼬리를 뗀 앞부분을
/// 돌려준다 — `src/note/selection-toolbar.ts`의 `COLOR_HEX_RE`와 같은 형식 어휘. 아니면
/// `inner`를 그대로 돌려준다(kbd로 취급).
fn strip_hex_color_tail(inner: &str) -> &str {
    if let Some(sep) = inner.rfind("|#") {
        let tail = &inner[sep + 2..];
        let is_hex_len = tail.len() == 3 || tail.len() == 6;
        if is_hex_len && tail.bytes().all(|b| b.is_ascii_hexdigit()) {
            return &inner[..sep];
        }
    }
    inner
}

/// `open`…`close` 감싸기를 벗겨 안쪽 글자만 남긴다(`open == close`인 `**`/`*`/`~~`/`==`/`` ` ``와
/// `open != close`인 경우 둘 다 다룬다). 닫는 짝이 없으면 그 `open`은 평범한 텍스트로 두고 그
/// 뒤부터 계속 찾는다.
///
/// 안이 빈 매치(`end == 0`)는 진짜 강조로 보지 않고 `open`의 첫 글자만 리터럴로 소비한 뒤
/// 다음 글자부터 다시 찾는다 — 안 닫힌 `**foo`처럼 겹마커 한쪽이 짝 없이 남으면, 뒤이은 단일
/// 마커 패스(`*`)가 그 남은 두 글자를 "빈 기울임"으로 오인해 통째로 지워 버리는 걸 막는다
/// (`open`/`close`는 전부 ASCII라 `start + 1` 슬라이스가 항상 문자 경계다).
fn strip_wrap(s: &str, open: &str, close: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(start) = rest.find(open) else {
            result.push_str(rest);
            break;
        };
        let after_open = &rest[start + open.len()..];
        let Some(end) = after_open.find(close) else {
            result.push_str(&rest[..start + open.len()]);
            rest = after_open;
            continue;
        };
        if end == 0 {
            result.push_str(&rest[..start + 1]);
            rest = &rest[start + 1..];
            continue;
        }
        let inner = &after_open[..end];
        result.push_str(&rest[..start]);
        result.push_str(inner);
        rest = &after_open[end + close.len()..];
    }
    result
}

/// `open`…`mid`…`close` 3토막 문법에서 첫 토막만 남기고 둘째 토막은 버린다 —
/// `[라벨](url)`처럼 "보여줄 글자"와 "가리키는 대상"이 다른 토막에 있는 문법용. 어느 구분자든
/// 짝이 없으면 그 앞부분은 평범한 텍스트로 두고 계속 찾는다.
fn strip_three_part(s: &str, open: &str, mid: &str, close: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(start) = rest.find(open) else {
            result.push_str(rest);
            break;
        };
        let after_open = &rest[start + open.len()..];
        let Some(mid_idx) = after_open.find(mid) else {
            result.push_str(&rest[..start + open.len()]);
            rest = after_open;
            continue;
        };
        let label = &after_open[..mid_idx];
        let after_mid = &after_open[mid_idx + mid.len()..];
        let Some(close_idx) = after_mid.find(close) else {
            result.push_str(&rest[..start + open.len() + mid_idx + mid.len()]);
            rest = after_mid;
            continue;
        };
        result.push_str(&rest[..start]);
        result.push_str(label);
        rest = &after_mid[close_idx + close.len()..];
    }
    result
}

/// 본문이 공백뿐인지(빈 노트) 판정한다 — 시작 시 빈 노트 정리에 쓴다.
pub fn is_blank(content: &str) -> bool {
    content.trim().is_empty()
}

/// 현재 시각을 epoch 밀리초로 반환한다(시계 역행 시 0).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 새 노트 id를 발급한다(UUID v4 — 불투명 식별자).
///
/// [`Vault::create_note`] 밖에서도 부를 수 있게 떼어 둔 이유는
/// [`Vault::create_note_with_id`] 문서 참고(생성 전에 id를 예약해야 하는 호출부가 있다).
pub fn new_note_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// serde 직렬화 실패를 io 오류로 변환한다(상위가 io::Result로 다루게).
fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// 노트 id가 경로 조립에 안전한지(빈값·구분자·`..`·`:` 없음) 검사한다.
///
/// 역할: `md_path`/`meta_path`가 id를 `notes/<id>.md`로 이어붙이기 전의 단일 관문.
/// [`crate::attachments`]도 같은 검증을 쓴다(첨부 경로 `attachments/<note_id>/...`).
/// 왜: 계약은 id를 **불투명 식별자**("경로 해석은 호스트 독점")로 약속한다 — 정상
/// 발급분은 UUID지만, 신뢰 경계 밖(플러그인 브리지)에서 온 문자열을 검증 없이 join하면
/// `../`는 그대로 이어붙고 절대경로는 베이스를 통째로 대체해 vault 밖 임의 파일에 닿는다.
/// `:`까지 거부하는 이유: Windows에서 `C:foo` 같은 드라이브 접두 경로는 `PathBuf::push`가
/// 베이스를 통째로 대체한다(지금은 macOS 전용이지만 규칙은 이식 가능하게 닫아 둔다).
/// 프론트(central-host.ts의 `isSafeNoteId`)에도 같은 규칙이 있지만 여기서 이중화한다 —
/// 프론트 검증만 두면 다른 호출자가 생길 때 이 경계가 다시 열린다
/// (`plugin_storage::is_valid_plugin_id`와 같은 심층 방어 패턴).
pub fn is_safe_note_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains(':')
}

/// `Path::try_exists()`의 결과를 [`Vault::note_exists`] 판정으로 접는다(순수 함수 — GUI/파일
/// 시스템 없이 가드 테스트 가능하게 분리, 이 파일의 `is_safe_note_id`/`check_note_id`와 같은
/// 결). `Ok(false)`(정말 없음)일 때만 false다 — `Ok(true)`는 물론, `Err`(권한 오류·공유
/// 위반·네트워크 순단 등으로 확인 자체가 실패한 경우, "없다"가 아니라 "모른다")도 true로
/// 접는다. 여기서 `Err`를 false로 접으면(예전 `Path::exists()`의 동작) 삭제-후-쓰기 가드가
/// 일시적 오류를 "삭제됨"으로 오판해 실제로는 남아 있는 노트에 대한 저장을 조용히 건너뛴다.
fn note_exists_from_probe(probe: io::Result<bool>) -> bool {
    probe.unwrap_or(true)
}

/// [`is_safe_note_id`] 위반을 io 오류(InvalidInput)로 변환한다 — Vault 각 메서드의 첫 관문.
fn check_note_id(id: &str) -> io::Result<()> {
    if is_safe_note_id(id) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("잘못된 노트 id(경로 형태 금지): {id:?}"),
        ))
    }
}

/// vault 루트와 하위 경로를 다루는 노트 저장소.
///
/// `Clone`인 이유: 이 타입은 루트 경로만 들고 있는 **상태 없는 핸들**이다(열린 파일 핸들도,
/// 캐시도, 갱신되는 불변식도 없다). 그래서 `AppState`의 잠금 아래에서 값을 복제해 꺼낸 뒤
/// 잠금을 놓고 IO를 할 수 있다 — 전체 노트를 훑는 오래 걸리는 읽기가 잠금을 붙들고 있어
/// 다른 창의 저장이나 메인 스레드의 트레이 갱신을 막는 일을 없앤다
/// ([`crate::commands::note_list`] 참고). 파일 자체의 일관성은 잠금이 아니라 원자적
/// 쓰기(tmp → rename)가 보장하므로, 읽는 쪽은 언제나 옛 파일 아니면 새 파일을 본다.
#[derive(Clone)]
pub struct Vault {
    root: PathBuf,
}

impl Vault {
    /// 주어진 루트 경로로 저장소를 연다(디렉터리 생성은 쓰기 시점에).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Vault { root: root.into() }
    }

    /// vault 최상위 경로. 첫 실행 안내 같은 앱 소유 첨부를 이 vault 안에 둘 때만 쓴다.
    pub fn root(&self) -> &PathBuf {
        &self.root
    }

    /// `notes/` 디렉터리 경로.
    pub fn notes_dir(&self) -> PathBuf {
        self.root.join("notes")
    }

    /// 노트 본문 경로 `notes/<id>.md`.
    pub fn md_path(&self, id: &str) -> PathBuf {
        self.notes_dir().join(format!("{id}.md"))
    }

    /// 노트 사이드카 경로 `notes/<id>.json`.
    pub fn meta_path(&self, id: &str) -> PathBuf {
        self.notes_dir().join(format!("{id}.json"))
    }

    /// 새 노트를 만든다(id 발급 → 본문·메타 원자적 기록). 생성된 id를 돌려준다.
    pub fn create_note(&self, content: &str) -> io::Result<String> {
        let id = new_note_id();
        self.create_note_with_id(&id, content)?;
        Ok(id)
    }

    /// **호출자가 미리 발급한** id로 노트를 만든다(본문·메타 원자적 기록).
    ///
    /// 왜 이 변형이 필요한가: [`crate::commands::claim_guide_note`]는 「시작 가이드」 자리를
    /// 공유 설정에 **먼저 예약**한 뒤(그 잠금만 쥐고) 노트를 만든다 — 예약과 생성을 한
    /// 임계구역에 묶으려면 설정 잠금을 쥔 채 vault 잠금을 잡아야 하는데, 이 코드베이스는 두
    /// 잠금을 겹쳐 쥐지 않는다는 규칙으로 순서 역전 교착을 구조적으로 막고 있다
    /// (`window_manager::read_note_view` 참고). id를 밖에서 발급하면 예약에 그 id를 적고
    /// 잠금을 놓은 뒤 만들 수 있어 규칙을 지키면서도 "정확히 한 장"이 유지된다.
    pub fn create_note_with_id(&self, id: &str, content: &str) -> io::Result<()> {
        check_note_id(id)?;
        write_atomic(&self.md_path(id), content)?;
        self.write_meta(id, &NoteMeta::new(now_ms()))
    }

    /// 노트를 복제한다 — 본문과 모든 설정(override: 투명도·배경·글자·핀·모든 데스크탑 등)이
    /// 같은 새 노트를 만들고 그 id를 돌려준다.
    ///
    /// 복사하는 것: 본문 + `meta.overrides`. 복사하지 않는 것: 창 지오메트리(새 창은 기본
    /// 배치)·hidden·z_order·created_at(새 노트 고유)·`favorite`(즐겨찾기는 내용의 일부가
    /// 아니라 **원본에 매단 사용자 표시**다 — 복제본까지 목록 맨 위에 끼어들면 즐겨찾기
    /// 묶음이 금세 지저분해진다). 원본은 변경하지 않는다.
    pub fn duplicate_note(&self, id: &str) -> io::Result<String> {
        let content = self.read_content(id)?;
        let src_overrides = self.read_meta(id)?.overrides;
        let new_id = self.create_note(&content)?;
        let mut new_meta = self.read_meta(&new_id)?;
        new_meta.overrides = src_overrides;
        new_meta.updated_at = now_ms();
        // 복제는 사용자가 방금 만들어 곧바로 보는 노트다 — 「최근 연 순」의 맨 앞이 맞다.
        // `favorite`는 `create_note`가 이미 false로 시작한 그대로 둔다(위 문서 참고).
        new_meta.opened_at = Some(now_ms());
        self.write_meta(&new_id, &new_meta)?;
        Ok(new_id)
    }

    /// 본문(`.md`)이 마지막으로 바뀐 시각(에폭 ms). 파일이 없거나 OS가 시각을 주지 못하면 `None`.
    ///
    /// 왜 사이드카의 `updated_at`이 아닌 파일 mtime인가: `NoteMeta::updated_at`은 보관·복제
    /// 같은 **본문과 무관한 변경**에서도 갱신돼 "언제 수정했나"의 근거로 쓸 수 없게 의미가
    /// 오염돼 있다(읽는 곳도 없다). 반면 본문 mtime은 자동저장이 `write_atomic`으로 파일을
    /// 갈아끼울 때마다 OS가 알아서 갱신하므로, **추가 쓰기 없이** 정확한 값을 얻는다 —
    /// 타자 한 번(500ms 디바운스)마다 사이드카까지 덧쓰면 동기화 폴더에 올린 vault에서
    /// 업로드할 파일이 노트당 두 배가 된다.
    ///
    /// 경로 형태의 id는 파일시스템에 닿기 전에 거부한다(`None`) — [`Self::read_content`]와 같은 관문.
    pub fn content_modified_at(&self, id: &str) -> Option<i64> {
        check_note_id(id).ok()?;
        std::fs::metadata(self.md_path(id))
            .ok()?
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64)
    }

    /// 노트 본문을 읽는다. 경로 형태의 id는 파일시스템에 닿기 전에 거부한다.
    pub fn read_content(&self, id: &str) -> io::Result<String> {
        check_note_id(id)?;
        read_to_string(&self.md_path(id))
    }

    /// 노트 본문(`.md`)이 지금 존재하는지 — 삭제-후-쓰기 가드에 쓴다
    /// ([`crate::commands::note_save_content`] 참고: 방금 삭제된 노트에 자동저장이 늦게
    /// 도착해도 `write_content`(write_atomic)가 부모 디렉터리째 되살리지 않도록 먼저 확인한다).
    ///
    /// `write_content` 자체를 존재 여부로 막지 않는 이유: 그 메서드는 손으로 vault에 둔 새
    /// 파일에 처음 쓰는 경로로도 쓰인다(`accepts_normal_ids` 테스트) — 여기서 막으면 그 용례가
    /// 깨진다. 그래서 확인은 호출부(삭제-후-쓰기 가드가 필요한 곳)의 몫으로 남긴다.
    ///
    /// 경로 형태의 id는 항상 false다(존재를 확언할 근거가 없다 — `check_note_id`와 같은 관문).
    ///
    /// `Path::exists()`가 아니라 `try_exists()`를 쓰는 이유(일시적 IO 오류가 삭제로 오판되던
    /// 결함 수정): `exists()`는 `fs::metadata`가 **어떤 이유로든** 실패하면(권한 오류, 백신
    /// 실시간 검사의 공유 위반, 느린 네트워크/동기화 드라이브의 순단 등) 조용히 false를
    /// 돌려준다 — "진짜 없음"과 "지금은 확인할 수 없음"을 구분하지 못한다. 이 판정을 그대로
    /// 믿는 `note_save_content`는 false를 "삭제됨"으로 여겨 쓰기를 건너뛰므로, 일시적 오류가
    /// 나면 사용자가 방금 친 내용이 조용히 유실된다. `try_exists()`의 `Err`는 "모른다"로 취급해
    /// (있다고 가정하고) 뒤이은 `write_content`가 시도되게 한다 — 그 시도가 진짜 영구 오류라면
    /// 그 오류가 그대로 표면화된다([`note_exists_from_probe`] 참고).
    pub fn note_exists(&self, id: &str) -> bool {
        is_safe_note_id(id) && note_exists_from_probe(self.md_path(id).try_exists())
    }

    /// 노트 본문을 원자적으로 덮어쓴다. 경로 형태의 id는 거부한다.
    ///
    /// 참고: 이건 앱 내부(에디터 자동저장 등)의 저마찰 쓰기 경로다 — 스냅샷을 남기지 않는다.
    /// 플러그인 브리지(`memo.notes.write`)의 **파괴적** 덮어쓰기는 [`Self::overwrite_content`]로,
    /// 반드시 이전 본문을 복구 슬롯에 스냅샷한 뒤 쓴다. 존재 여부는 스스로 확인하지 않는다 —
    /// [`Self::note_exists`] 문서 참고.
    pub fn write_content(&self, id: &str, content: &str) -> io::Result<()> {
        check_note_id(id)?;
        write_atomic(&self.md_path(id), content)
    }

    /// 이 vault의 복구 장치(휴지통) 뷰를 연다.
    fn trash(&self) -> Trash {
        Trash::new(self.root.clone())
    }

    /// 노트 본문을 **파괴적으로** 전체 덮어쓴다(`memo.notes.write` overwrite 모드의 백엔드).
    ///
    /// 역할: 덮어쓰기 **직전** 현재 본문을 복구 슬롯에 스냅샷한 뒤 새 본문을 원자적으로 쓴다 —
    /// memo에는 undo도 휴지통도 없어 이 스냅샷이 유일한 안전망이다. 스냅샷 저장이 실패하면 **덮어쓰지 않는다**(백업 없는 파괴를 막는다 — 오류 전파).
    /// 왜 없는 노트를 만들지 않는가: 존재하지 않는 id는 NotFound 오류다(새 노트 생성은
    /// [`Self::create_note`]의 몫). 브리지는 이 실패를 `NOTE_NOT_FOUND`로 분류한다.
    pub fn overwrite_content(&self, id: &str, content: &str) -> io::Result<()> {
        check_note_id(id)?;
        let previous = self.read_content(id)?; // 없으면 NotFound → 브리지가 NOTE_NOT_FOUND로 분류
        self.trash().snapshot(id, &previous)?; // 백업 실패 시 덮어쓰기 중단
        write_atomic(&self.md_path(id), content)
    }

    /// 노트 본문 끝에 **비파괴적으로** 이어쓴다(`memo.notes.write` append 모드의 백엔드).
    ///
    /// 역할: 기존 내용을 보존하고 뒤에 덧붙이기만 하므로 스냅샷이 필요 없다(Obsidian `process`
    /// vs `modify` 선례 — 이어쓰기는 저마찰 기본, 덮어쓰기는 파괴적). 없는 노트는 NotFound 오류.
    pub fn append_content(&self, id: &str, extra: &str) -> io::Result<()> {
        check_note_id(id)?;
        let mut next = self.read_content(id)?; // 없으면 NotFound
        next.push_str(extra);
        write_atomic(&self.md_path(id), &next)
    }

    /// 노트의 복구 슬롯 스냅샷 목록을 최신순으로 돌려준다(복구 UI가 어느 버전인지 고르는 데 쓴다).
    pub fn list_snapshots(&self, id: &str) -> io::Result<Vec<Snapshot>> {
        check_note_id(id)?;
        self.trash().list(id)
    }

    /// 복구 슬롯 스냅샷 하나의 본문을 읽는다(복구 UI의 미리보기용). 없으면 NotFound 오류.
    pub fn read_snapshot(&self, id: &str, snapshot_id: &str) -> io::Result<String> {
        check_note_id(id)?;
        self.trash().read(id, snapshot_id)
    }

    /// 복구 슬롯에 스냅샷을 가진 모든 노트 id를 열거한다(삭제된 노트 포함).
    ///
    /// 역할: 복구 UI가 **존재하는 노트**(`list_note_ids`)뿐 아니라 **삭제된 노트**의 스냅샷에도
    /// 닿을 수 있게, 스냅샷 디렉터리를 가진 노트 id를 모아 준다([`Trash::note_ids`] 위임).
    pub fn list_snapshot_note_ids(&self) -> io::Result<Vec<String>> {
        self.trash().note_ids()
    }

    /// 노트 본문을 특정 스냅샷으로 되돌린다.
    ///
    /// 역할: (1) 되돌리기 **직전** 현재 본문도 스냅샷한다 — 복원 자체가 되돌릴 수 있어야 하기
    /// 때문(잘못 복원해도 방금 상태로 다시 갈 수 있다). (2) 스냅샷 본문을 노트에 원자적으로 쓴다.
    /// (3) 노트 파일이 삭제된 뒤 복원하는 경우엔 사이드카 메타가 없으므로 기본 메타를 새로 만들어
    /// 목록↔읽기 계약(`.md`가 있으면 `.json`도 있어야 한다)을 채운다 — 즉 **삭제한 노트도 복구**된다.
    /// 스냅샷이 없으면 NotFound 오류.
    ///
    /// 되돌리기 직전 현재-본문 스냅샷은 [`Self::overwrite_content`]와 **대칭으로** 오류를 전파한다
    /// (`?`) — 백업 없는 파괴를 막는다. 현재 본문이 에디터 자동저장(스냅샷 안 남김)으로만 저장돼
    /// 다른 사본이 없을 수 있어, 그 스냅샷이 실패하는데도 복원을 진행하면 되돌릴 수 없이 현재
    /// 작업을 잃는다 — 되돌릴 수 없는 복원보다 깨끗한 실패(재시도 가능)가 낫다. 공백뿐인 현재
    /// 본문은 `snapshot`이 `Ok(None)`이라 자연히 통과하고(잃을 것 없음), 삭제됐던 노트를 되살릴
    /// 때는 `read_content`가 NotFound라 스냅샷 단계를 건너뛴다(그 현재 본문이 없다).
    pub fn restore_snapshot(&self, id: &str, snapshot_id: &str) -> io::Result<()> {
        check_note_id(id)?;
        let body = self.trash().read(id, snapshot_id)?; // 대상 스냅샷이 없으면 여기서 실패
        if let Ok(current) = self.read_content(id) {
            self.trash().snapshot(id, &current)?; // 백업 실패 시 복원 중단(overwrite와 대칭)
        }
        write_atomic(&self.md_path(id), &body)?;
        // 삭제됐던 노트를 되살리는 경우 사이드카가 없다 — 기본 메타를 채워 유효한 노트로 만든다.
        if !self.meta_path(id).exists() {
            self.write_meta(id, &NoteMeta::new(now_ms()))?;
        }
        Ok(())
    }

    /// 노트 사이드카 메타를 읽는다. 경로 형태의 id는 거부한다.
    pub fn read_meta(&self, id: &str) -> io::Result<NoteMeta> {
        check_note_id(id)?;
        let raw = read_to_string(&self.meta_path(id))?;
        serde_json::from_str(&raw).map_err(to_io)
    }

    /// 노트 사이드카 메타를 원자적으로 쓴다(사람이 읽기 쉬운 pretty JSON).
    /// 경로 형태의 id는 거부한다.
    pub fn write_meta(&self, id: &str, meta: &NoteMeta) -> io::Result<()> {
        check_note_id(id)?;
        let json = serde_json::to_string_pretty(meta).map_err(to_io)?;
        write_atomic(&self.meta_path(id), &json)
    }

    /// 노트를 삭제한다(본문·메타·첨부 폴더). 이미 없는 항목은 무시하되,
    /// 경로 형태의 id는 거부한다(멱등의 범위는 vault 안이다).
    ///
    /// 삭제도 파괴적이므로 본문이 남아 있고 비어있지 않으면 지우기 **직전** 복구 슬롯에
    /// 스냅샷한다 — 실수로 지운 노트를 되살릴 수 있다([`Self::restore_snapshot`]). 스냅샷은
    /// **최선 노력**이다(overwrite와 달리 실패가 삭제를 막지 않는다): 사용자가 의도적으로
    /// 버리는 노트라, 백업 실패로 삭제 자체를 못 하게 되는 편이 더 나쁘다. 공백뿐인 노트는
    /// 스냅샷하지 않으므로(잃을 것 없음) 시작 시 빈 노트 정리는 휴지통을 어지럽히지 않는다.
    pub fn delete_note(&self, id: &str) -> io::Result<()> {
        check_note_id(id)?;
        if let Ok(previous) = self.read_content(id) {
            let _ = self.trash().snapshot(id, &previous);
        }
        ignore_missing(std::fs::remove_file(self.md_path(id)))?;
        ignore_missing(std::fs::remove_file(self.meta_path(id)))?;
        ignore_missing(std::fs::remove_dir_all(
            self.root.join("attachments").join(id),
        ))?;
        Ok(())
    }

    /// 이 경로가 실제 vault로 보이는지(마커: `notes/` 디렉터리 존재) 판정한다.
    ///
    /// 역할: [`crate::commands::wipe_all_data`] 같은 파괴적 커맨드가 실행되기 **전**의 방어
    /// 관문이다 — 로컬 설정의 `vault_path`가 마이그레이션 중이거나 오지정된 경로를 가리키는
    /// 드문 상황에서, 엉뚱한(vault가 아닌) 폴더의 하위 디렉터리를 지우는 사고를 막는다.
    /// 왜 `notes/` 하나만 보는가: vault 생성 경로([`Vault::create_note`]가 처음 쓸 때) 외에는
    /// 이 디렉터리가 생길 이유가 없어 가장 신뢰할 수 있는 단일 마커다(빈 vault도 `notes/`
    /// 자체는 `create_note` 이전에는 없을 수 있으나, 그 경우 지울 노트 데이터도 없다).
    pub fn looks_like_vault(&self) -> bool {
        self.notes_dir().is_dir()
    }

    /// vault의 모든 노트 데이터를 지운다 — "모든 데이터 삭제"(이슈 #20)의 노트 쪽 절반.
    ///
    /// `notes/`(본문+메타)·`attachments/`(첨부)·`.memo/`(공유 설정·복구 슬롯·vault 플러그인
    /// 참조 목록 — [`crate::settings::shared_settings_path`]·[`crate::trash::Trash`]·
    /// vault 플러그인 목록이 모두 이 아래에 있다) 세 디렉터리를 통째로 지운다. vault 루트
    /// 자체는 남긴다 — 다음 노트 생성이 [`crate::io::write_atomic_bytes`]로 부모 디렉터리를
    /// 다시 만들므로 굳이 루트까지 지울 이유가 없고, 루트를 지우면 그 순간 "vault가 어디
    /// 있는지"의 유일한 근거([`Self::looks_like_vault`])까지 함께 사라진다.
    ///
    /// 이미 없는 디렉터리는 성공으로 본다(멱등 — [`Self::delete_note`]와 같은 관례).
    pub fn wipe_all(&self) -> io::Result<()> {
        ignore_missing(std::fs::remove_dir_all(self.notes_dir()))?;
        ignore_missing(std::fs::remove_dir_all(self.root.join("attachments")))?;
        ignore_missing(std::fs::remove_dir_all(self.root.join(".memo")))?;
        Ok(())
    }

    /// `notes/`의 `.md` 파일명(stem)에서 노트 id 목록을 만든다(정렬).
    pub fn list_note_ids(&self) -> io::Result<Vec<String>> {
        let mut ids = Vec::new();
        let dir = self.notes_dir();
        if !dir.exists() {
            return Ok(ids);
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    ids.push(stem.to_string());
                }
            }
        }
        ids.sort();
        Ok(ids)
    }
}

/// `NotFound` 오류는 성공으로 흡수한다(이미 없는 파일 삭제 등 멱등 처리).
fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가드: 제목 파생 규칙(헤딩 마커 제거·trim·빈 줄 폴백).
    #[test]
    fn derive_title_rules() {
        assert_eq!(derive_title("# Hello\nbody"), "Hello");
        assert_eq!(derive_title("### 제목  "), "제목");
        assert_eq!(derive_title("  plain text"), "plain text");
        assert_eq!(derive_title(""), "제목 없음");
        assert_eq!(derive_title("#"), "제목 없음");
        assert_eq!(derive_title("\n둘째 줄"), "제목 없음");
    }

    /// 가드: 인라인 문법이 제목에 원문 그대로 새지 않는다 — text-color·kbd(`{{...}}`)와
    /// 마크다운 강조(굵게·기울임·취소선·형광펜·인라인 코드·링크)가 벗겨져 순수 텍스트만
    /// 남는다.
    #[test]
    fn derive_title_strips_inline_syntax() {
        // text-color: {{텍스트|#hex}} → 텍스트 (3자리·6자리 둘 다).
        assert_eq!(derive_title("{{J KJNKJNK|#93b}}"), "J KJNKJNK");
        assert_eq!(derive_title("{{글자색|#a1b2c3}}"), "글자색");
        // kbd: {{텍스트}} → 텍스트 (|#hex 꼬리가 없으면 색 문법이 아니다).
        assert_eq!(derive_title("{{Cmd+C}}"), "Cmd+C");
        // hex 형식이 안 맞으면(길이 어긋남) kbd로 취급해 안쪽 전체를 남긴다.
        assert_eq!(derive_title("{{텍스트|#zz}}"), "텍스트|#zz");
        // 마크다운 강조.
        assert_eq!(derive_title("**굵게**"), "굵게");
        assert_eq!(derive_title("*기울임*"), "기울임");
        assert_eq!(derive_title("~~취소선~~"), "취소선");
        assert_eq!(derive_title("==형광펜=="), "형광펜");
        assert_eq!(derive_title("`코드`"), "코드");
        // 링크: [라벨](url) → 라벨.
        assert_eq!(derive_title("[문서](https://example.com)"), "문서");
        // 두 겹 중첩(파이프라인 역순 포함) — 한두 겹은 벗겨진다.
        assert_eq!(derive_title("**{{강조|#fff}}**"), "강조");
        assert_eq!(derive_title("[**굵은 링크**](url)"), "굵은 링크");
        // 짝이 안 맞는 문법은 원문 그대로 남는다(데이터 손실 없이 보수적으로).
        assert_eq!(derive_title("{{안 닫힘"), "{{안 닫힘");
        assert_eq!(derive_title("**안 닫힘"), "**안 닫힘");
    }

    /// 가드: 공백/빈 본문은 blank, 내용이 있으면 아니다.
    #[test]
    fn is_blank_detects_empty() {
        assert!(is_blank(""));
        assert!(is_blank("   \n\t "));
        assert!(!is_blank("# 제목"));
    }

    /// 가드: 생성한 노트의 본문·메타를 다시 읽을 수 있고 목록에 나타난다.
    #[test]
    fn create_then_read_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 제목\n본문").unwrap();
        assert_eq!(vault.read_content(&id).unwrap(), "# 제목\n본문");
        assert_eq!(vault.read_meta(&id).unwrap().schema_version, 1);
        assert_eq!(vault.list_note_ids().unwrap(), vec![id]);
    }

    /// 가드: 본문 덮어쓰기가 반영된다.
    #[test]
    fn write_content_updates() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("old").unwrap();
        vault.write_content(&id, "new").unwrap();
        assert_eq!(vault.read_content(&id).unwrap(), "new");
    }

    /// 가드: 복제는 본문·override(설정)를 복사한 새 노트를 만들고 원본은 건드리지 않는다.
    #[test]
    fn duplicate_copies_content_and_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 원본\n본문").unwrap();
        // 원본에 설정 override를 심는다(투명도·핀).
        let mut meta = vault.read_meta(&id).unwrap();
        meta.overrides.transparency = Some(60);
        meta.overrides.pinned = Some(true);
        vault.write_meta(&id, &meta).unwrap();

        let new_id = vault.duplicate_note(&id).unwrap();
        assert_ne!(new_id, id); // 새 id
        assert_eq!(vault.read_content(&new_id).unwrap(), "# 원본\n본문"); // 본문 동일
        let new_meta = vault.read_meta(&new_id).unwrap();
        assert_eq!(new_meta.overrides.transparency, Some(60)); // 설정 복사
        assert_eq!(new_meta.overrides.pinned, Some(true));
        assert!(!new_meta.hidden); // 새 노트는 표시 상태(hidden 미복사)

        // 원본은 그대로다.
        assert_eq!(vault.read_content(&id).unwrap(), "# 원본\n본문");
        assert_eq!(
            vault.list_note_ids().unwrap().len(),
            2,
            "복제로 노트가 2개가 된다"
        );
    }

    /// 가드: 즐겨찾기는 **복제되지 않는다**(원본에 매단 사용자 표시). 반면 복제본의
    /// `opened_at`은 지금으로 갱신된다 — 방금 만들어 곧바로 보는 노트이므로.
    #[test]
    fn duplicate_does_not_carry_favorite() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("# 원본").unwrap();
        let mut meta = vault.read_meta(&id).unwrap();
        meta.favorite = true;
        meta.opened_at = Some(1_000);
        vault.write_meta(&id, &meta).unwrap();

        let new_id = vault.duplicate_note(&id).unwrap();
        let new_meta = vault.read_meta(&new_id).unwrap();
        assert!(!new_meta.favorite, "복제본은 즐겨찾기를 물려받지 않는다");
        assert!(
            new_meta.opened_at.unwrap_or(0) > 1_000,
            "복제본의 「최근 연」 시각은 지금이다"
        );
        // 원본의 즐겨찾기는 그대로다.
        assert!(vault.read_meta(&id).unwrap().favorite);
    }

    /// 가드: 본문 mtime을 ms로 돌려준다(「수정순」 정렬의 근거). 본문을 다시 쓰면 값이
    /// 뒤로 가지 않고, 없는 노트/경로 형태 id는 `None`.
    #[test]
    fn content_modified_at_tracks_md_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("처음").unwrap();
        let first = vault
            .content_modified_at(&id)
            .expect("생성 직후 본문 mtime을 읽을 수 있어야 한다");
        // 에폭 ms로 그럴듯한 범위인지(2001년 이후) — 초 단위로 잘못 환산했으면 여기서 걸린다.
        assert!(first > 1_000_000_000_000, "에폭 ms여야 한다: {first}");

        vault.write_content(&id, "나중").unwrap();
        let second = vault.content_modified_at(&id).unwrap();
        assert!(second >= first, "다시 쓴 뒤 mtime이 뒤로 가면 안 된다");

        assert_eq!(vault.content_modified_at("없는-노트"), None);
        assert_eq!(vault.content_modified_at("../탈출"), None);
    }

    /// 가드: 삭제가 본문·메타를 모두 제거하고, 두 번 호출해도 안전하다(멱등).
    #[test]
    fn delete_removes_md_and_meta_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("x").unwrap();
        vault.delete_note(&id).unwrap();
        assert!(!vault.md_path(&id).exists());
        assert!(!vault.meta_path(&id).exists());
        // 이미 없는 노트 삭제도 오류 없이 통과.
        vault.delete_note(&id).unwrap();
    }

    /// 가드(부활 방지 가드의 기반): `note_exists`는 생성된 노트는 true, 삭제된 노트는 false,
    /// 아예 존재한 적 없는 id도 false를 돌려준다 — `note_save_content`의 삭제-후-쓰기 가드가
    /// 이 판정을 그대로 믿는다.
    #[test]
    fn note_exists_reflects_md_presence() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert!(!vault.note_exists("never-created"));

        let id = vault.create_note("본문").unwrap();
        assert!(vault.note_exists(&id));

        vault.delete_note(&id).unwrap();
        assert!(
            !vault.note_exists(&id),
            "삭제된 노트는 더 이상 존재하지 않아야 한다"
        );
    }

    /// 가드(일시적 IO 오류로 자동저장이 조용히 유실되던 결함 수정): `try_exists()`의 `Err`
    /// (권한 오류·공유 위반 등 "모른다")는 "없다"가 아니라 "있다"로 접혀야 한다 — 그래야
    /// `note_save_content`의 삭제-후-쓰기 가드가 일시적 오류를 "삭제됨"으로 오판해 쓰기를
    /// 건너뛰지 않는다. `Ok(false)`(진짜 없음)만 false다.
    #[test]
    fn note_exists_from_probe_treats_err_as_unknown_not_absent() {
        assert!(note_exists_from_probe(Ok(true)));
        assert!(!note_exists_from_probe(Ok(false)));
        assert!(note_exists_from_probe(Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "공유 위반(예: 백신 실시간 검사)"
        ))));
    }

    /// 가드(보안): 경로 형태의 id는 파일이 실제로 있어도 상관없이 항상 false다 — 존재
    /// 판정 자체가 경로 탈출의 곁문이 되지 않게 한다(다른 메서드들과 같은 관문).
    #[test]
    fn note_exists_rejects_path_escaping_ids() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        for id in ["../escape", "a/b", "a\\b", "..", "C:evil", ""] {
            assert!(!vault.note_exists(id), "note_exists({id:?})");
        }
    }

    /// 가드: 빈/없는 vault의 목록은 빈 벡터(패닉 없음).
    #[test]
    fn list_empty_vault_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().join("does-not-exist"));
        assert!(vault.list_note_ids().unwrap().is_empty());
    }

    /// 가드(보안 — 경로 인젝션): 경로 형태의 id는 파일시스템에 닿기 전에 거부된다.
    ///
    /// 계약(api-index.ts)은 id를 "불투명 식별자 — 경로 해석은 호스트 독점"으로 약속하는데,
    /// 검증 없이 `notes_dir().join(format!("{id}.md"))`에 넣으면 `../`는 그대로 이어붙고
    /// 절대경로는 베이스를 통째로 대체한다 — vault 밖 임의 .md를 읽고 쓰고 지울 수 있었다
    /// (rustc 재현으로 실증). 프론트(central-host.ts)에도 같은 가드가 있지만 여기서
    /// 이중화한다 — 다른 호출자가 생겨도 이 경계는 닫혀 있어야 한다.
    #[test]
    fn rejects_path_escaping_ids() {
        let dir = tempfile::tempdir().unwrap();
        // vault 밖(형제 디렉터리)에 비밀 파일을 심는다.
        let secret_dir = dir.path().join("secret");
        std::fs::create_dir_all(&secret_dir).unwrap();
        let secret = secret_dir.join("private.md");
        std::fs::write(&secret, "vault 밖의 비밀").unwrap();

        let vault = Vault::new(dir.path().join("v"));
        let escaping = [
            "../../secret/private",
            "a/b",
            "a\\b",
            "..",
            "a..b",
            "C:evil",
            "",
        ];
        for id in escaping {
            assert!(vault.read_content(id).is_err(), "read_content({id:?})");
            assert!(vault.read_meta(id).is_err(), "read_meta({id:?})");
            assert!(
                vault.write_content(id, "x").is_err(),
                "write_content({id:?})"
            );
            assert!(vault.delete_note(id).is_err(), "delete_note({id:?})");
            assert!(vault.duplicate_note(id).is_err(), "duplicate_note({id:?})");
        }
        // 절대경로 id도 마찬가지다(join이 베이스를 통째로 대체하는 경우).
        let abs = secret_dir.join("private");
        let abs_id = abs.to_str().unwrap();
        assert!(vault.read_content(abs_id).is_err());

        // 비밀 파일은 읽히지도, 지워지지도, 덮어써지지도 않았다.
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "vault 밖의 비밀");
    }

    /// 가드(복구 안전망 — overwrite): 파괴적 덮어쓰기는 이전 본문을 복구 슬롯에 스냅샷한 뒤
    /// 쓴다. 스냅샷으로 원래 내용을 되찾을 수 있다.
    #[test]
    fn overwrite_snapshots_previous_body() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("원본 본문").unwrap();

        vault.overwrite_content(&id, "덮어쓴 본문").unwrap();
        assert_eq!(vault.read_content(&id).unwrap(), "덮어쓴 본문");

        let snaps = vault.list_snapshots(&id).unwrap();
        assert_eq!(snaps.len(), 1, "덮어쓰기 직전 이전 본문이 스냅샷된다");
        assert_eq!(vault.read_snapshot(&id, &snaps[0].id).unwrap(), "원본 본문");
    }

    /// 가드: 없는 노트를 overwrite/append하면 NotFound 오류다(생성이 아니다).
    #[test]
    fn write_to_missing_note_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let err = vault.overwrite_content("no-such", "x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(vault.append_content("no-such", "x").is_err());
    }

    /// 가드(복구 안전망 — append): 이어쓰기는 기존 내용을 보존해 덧붙이고, 비파괴이므로
    /// 스냅샷을 남기지 않는다.
    #[test]
    fn append_preserves_and_does_not_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("첫 줄").unwrap();

        vault.append_content(&id, "\n둘째 줄").unwrap();
        assert_eq!(vault.read_content(&id).unwrap(), "첫 줄\n둘째 줄");
        assert!(
            vault.list_snapshots(&id).unwrap().is_empty(),
            "이어쓰기는 스냅샷하지 않는다"
        );
    }

    /// 가드(복구): 스냅샷으로 되돌리면 본문이 그 시점으로 복원되고, 복원 직전 본문도 다시
    /// 스냅샷돼(복원을 되돌릴 수 있게) 목록에 남는다.
    #[test]
    fn restore_reverts_body_and_keeps_reversal_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("v1").unwrap();
        vault.overwrite_content(&id, "v2").unwrap(); // v1 스냅샷 생성

        let snaps = vault.list_snapshots(&id).unwrap();
        let v1_snap = snaps[0].id.clone();
        vault.restore_snapshot(&id, &v1_snap).unwrap();

        assert_eq!(vault.read_content(&id).unwrap(), "v1", "본문이 복원된다");
        // 복원 직전 본문(v2)도 스냅샷돼 목록이 늘어난다(복원 자체가 되돌릴 수 있다).
        assert_eq!(vault.list_snapshots(&id).unwrap().len(), 2);
    }

    /// 가드(데이터 안전 — 복원 대칭성): 되돌리기 직전 현재 본문 스냅샷이 실패하면 복원을
    /// 중단하고 현재 본문을 보존한다(백업 없는 파괴 금지 — overwrite_content와 대칭).
    ///
    /// 재현: 대상 스냅샷 읽기는 되지만 새 스냅샷 쓰기만 실패하도록 복구 슬롯 디렉터리를
    /// 읽기 전용(r-x)으로 만든다. 현재 본문은 자동저장(write_content — 스냅샷 없음)으로만
    /// 저장돼 다른 사본이 없는 상태를 모사한다. 버그(오류 무시)가 있으면 복원이 진행돼 현재
    /// 본문이 영구 소실된다.
    #[cfg(unix)]
    #[test]
    fn restore_aborts_when_reversal_snapshot_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("원본").unwrap();
        vault.overwrite_content(&id, "덮어쓴 v2").unwrap(); // 원본 스냅샷 생성(복구 슬롯 디렉터리도 생김)
        let snap = vault.list_snapshots(&id).unwrap()[0].id.clone();

        // 되돌리기 직전 현재 본문을 자동저장만 한 상태로 둔다(스냅샷 없는 유일한 사본).
        vault.write_content(&id, "자동저장만 된 현재 작업").unwrap();

        // 복구 슬롯 디렉터리를 r-x(쓰기 불가)로 만든다 — 기존 스냅샷 읽기는 되나 새 스냅샷
        // 파일 생성은 실패한다.
        let note_trash_id = dir.path().join(".memo").join("trash").join(&id);
        let mut ro = std::fs::metadata(&note_trash_id).unwrap().permissions();
        ro.set_mode(0o500);
        std::fs::set_permissions(&note_trash_id, ro).unwrap();

        let result = vault.restore_snapshot(&id, &snap);

        // 정리(tempdir 삭제를 위해 쓰기 권한 복원) — 단언보다 먼저 해 실패해도 누수 없게.
        let mut rw = std::fs::metadata(&note_trash_id).unwrap().permissions();
        rw.set_mode(0o700);
        std::fs::set_permissions(&note_trash_id, rw).unwrap();

        assert!(
            result.is_err(),
            "스냅샷 실패 시 복원은 깨끗이 실패해야 한다"
        );
        assert_eq!(
            vault.read_content(&id).unwrap(),
            "자동저장만 된 현재 작업",
            "복원이 중단돼 현재 본문이 보존된다"
        );
    }

    /// 가드(복구 — 삭제 되살리기): 삭제한 노트도 스냅샷으로 복구되고, 사이드카 메타가 새로
    /// 만들어져 목록·읽기 계약이 채워진다.
    #[test]
    fn delete_then_restore_recovers_note_with_meta() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("지우면 안 되는 본문").unwrap();

        vault.delete_note(&id).unwrap(); // 삭제 직전 스냅샷됨
        assert!(!vault.md_path(&id).exists());

        let snaps = vault.list_snapshots(&id).unwrap();
        assert_eq!(snaps.len(), 1, "삭제도 스냅샷을 남긴다");
        vault.restore_snapshot(&id, &snaps[0].id).unwrap();

        assert_eq!(vault.read_content(&id).unwrap(), "지우면 안 되는 본문");
        // 사이드카 메타가 재생성돼 정상 노트로 목록에 뜬다.
        assert!(vault.read_meta(&id).is_ok());
        assert!(vault.list_note_ids().unwrap().contains(&id));
    }

    /// 가드(복구 도달성, finding 2): 삭제된 노트도 스냅샷을 가지면 `list_snapshot_note_ids`에
    /// 열거된다 — 존재하는 노트만 스캔하는 목록에는 없어 복구 화면이 그 스냅샷에 닿지 못했다.
    #[test]
    fn list_snapshot_note_ids_includes_deleted_notes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        // 존재하는 노트(스냅샷 있음).
        let alive = vault.create_note("살아있는 노트").unwrap();
        vault.overwrite_content(&alive, "덮어씀").unwrap(); // 스냅샷 1건.
                                                            // 삭제된 노트(삭제 직전 스냅샷됨 → notes/에는 없지만 trash에는 있음).
        let gone = vault.create_note("지워질 노트").unwrap();
        vault.delete_note(&gone).unwrap();
        assert!(!vault.md_path(&gone).exists());

        let ids = vault.list_snapshot_note_ids().unwrap();
        assert!(ids.contains(&alive), "존재 노트의 스냅샷도 열거된다");
        assert!(ids.contains(&gone), "삭제된 노트의 스냅샷도 열거된다");
        // 존재하는 노트 목록(notes/*.md)에는 삭제된 노트가 없다 — 이 열거가 그 간극을 메운다.
        assert!(!vault.list_note_ids().unwrap().contains(&gone));
    }

    /// 가드: 스냅샷이 하나도 없으면 빈 벡터(패닉 없음).
    #[test]
    fn list_snapshot_note_ids_empty_when_no_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert!(vault.list_snapshot_note_ids().unwrap().is_empty());
    }

    /// 가드: 공백뿐인 노트 삭제는 스냅샷을 남기지 않는다(시작 시 빈 노트 정리가 휴지통을
    /// 어지럽히지 않게).
    #[test]
    fn deleting_blank_note_does_not_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("   \n\t").unwrap();
        vault.delete_note(&id).unwrap();
        assert!(vault.list_snapshots(&id).unwrap().is_empty());
    }

    /// 가드(이슈 #20 — 모든 데이터 삭제): `wipe_all`이 노트·첨부·`.memo`(공유 설정·복구 슬롯)를
    /// 모두 지우지만 vault 루트 자체는 남긴다. 지운 뒤 다시 써도(새 노트 생성) 문제없이 동작해야
    /// 한다(부모 디렉터리 자동 재생성).
    #[test]
    fn wipe_all_clears_notes_attachments_and_memo_but_keeps_root() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("지워질 노트").unwrap();
        vault.overwrite_content(&id, "덮어씀").unwrap(); // .memo/trash에 스냅샷 생성
        std::fs::write(crate::settings::shared_settings_path(dir.path()), "{}").unwrap();
        let attach_dir = dir.path().join("attachments").join(&id);
        std::fs::create_dir_all(&attach_dir).unwrap();
        std::fs::write(attach_dir.join("x.png"), b"fake").unwrap();

        assert!(vault.looks_like_vault());
        vault.wipe_all().unwrap();

        assert!(dir.path().exists(), "vault 루트 자체는 남는다");
        assert!(!vault.notes_dir().exists());
        assert!(!dir.path().join("attachments").exists());
        assert!(!dir.path().join(".memo").exists());
        assert!(vault.list_note_ids().unwrap().is_empty());

        // 지운 뒤에도 다시 쓸 수 있다(디렉터리 자동 재생성).
        let new_id = vault.create_note("새 노트").unwrap();
        assert_eq!(vault.read_content(&new_id).unwrap(), "새 노트");
    }

    /// 가드: `wipe_all`은 애초에 아무것도 없는(생성된 적 없는) vault에서도 오류 없이 끝난다(멱등).
    #[test]
    fn wipe_all_on_empty_vault_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().join("does-not-exist-yet"));
        assert!(!vault.looks_like_vault());
        vault.wipe_all().unwrap();
    }

    /// 가드: `looks_like_vault`는 `notes/`가 있을 때만 true다(파괴적 커맨드의 방어 관문).
    #[test]
    fn looks_like_vault_requires_notes_dir() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert!(!vault.looks_like_vault(), "아직 노트를 만들기 전");
        vault.create_note("x").unwrap();
        assert!(vault.looks_like_vault(), "notes/가 생기면 vault로 인정");
    }

    /// 가드(경계의 반대쪽): 정상 발급 형식(UUID)과 손으로 둔 평범한 파일명 stem은 통과한다 —
    /// 검증이 `notes.list`가 돌려줄 수 있는 id를 다시 거부하면 목록↔읽기 계약이 깨진다.
    #[test]
    fn accepts_normal_ids() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        let id = vault.create_note("uuid 노트").unwrap();
        assert_eq!(vault.read_content(&id).unwrap(), "uuid 노트");
        // 손으로 vault에 둔 비-UUID 파일명(한글·공백·점 하나)도 읽을 수 있어야 한다.
        vault.write_content("메모 v1.2", "손으로 둔 노트").unwrap();
        assert_eq!(vault.read_content("메모 v1.2").unwrap(), "손으로 둔 노트");
    }
}
