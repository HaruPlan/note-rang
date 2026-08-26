//! 플러그인 네트워크 중계(`memo.network.fetch`의 백엔드) — SSRF 방어의 단일 지점.
//!
//! 역할: 샌드박스 플러그인은 iframe이라 네트워크에 직접 닿지 못한다. 그래서 **호스트(Rust)가
//! 대신 fetch**한다 — 그 순간 호스트가 SSRF 표면이 된다. 이 모듈은 호출 하나가 사설/내부
//! 대역·메타데이터 엔드포인트·자격증명·리다이렉트 우회로 새지 않도록 방어를 전부 강제한다.
//! 왜: 도메인 화이트리스트 매칭은 프론트 게이트키퍼(`host.ts`)가 하지만, **스킴·사설대역·IP
//! 핀·리다이렉트·크기·타임아웃은 TS 매칭을 믿지 않고 여기서 다시 강제한다**(심층 방어).
//!
//! 방어 목록(하나라도 빠지면 SSRF):
//! 1. https 전용 — 그 외 스킴 거부([`parse_target`]).
//! 2. 사설/내부 대역 차단 — DNS 해석 후 **모든** IP를 검사, 하나라도 차단 대역이면 거부
//!    ([`is_blocked_ip`]·[`resolve_and_pin`]). IP 리터럴 URL도 같은 검사.
//! 3. DNS 리바인딩 방어 — 검증 통과한 IP를 **핀**해 그 IP로 연결(reqwest `.resolve`), Host는
//!    원 호스트 유지. "검사 시점 IP ≠ 연결 시점 IP"를 차단.
//! 4. 리다이렉트 미추적 — `redirect(Policy::none())`. 3xx는 그대로 반환(플러그인이 새 URL로
//!    다시 부르면 그 URL이 또 전 검사를 받는다). 자동 추적은 검사를 우회하므로 금지.
//! 5. 자격증명 미전달 — 쿠키 스토어 없음(feature 미포함), 프록시 없음(`no_proxy` — 프록시가
//!    핀·사설대역 검사를 통째로 우회하는 길을 막는다), Host·Cookie·Authorization 등은 플러그인이
//!    못 세팅([`sanitize_headers`]).
//! 6. 상한 — 응답 크기·타임아웃·메서드 화이트리스트.
//! 7. 오류 — 각 거부 사유를 안정 토큰(`NET_*`)으로 구분해 프론트가 `MemoErrorCode`로 매핑한다.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// 응답 본문 최대 바이트(초과분은 읽지 않고 즉시 거부). AI/텍스트 API에 넉넉하고 폭탄에는
/// 부족한 크기. content-length 선언과 실제 스트림 양쪽에서 강제한다.
const MAX_RESPONSE_BYTES: u64 = 5 * 1024 * 1024;

/// 요청 전체 타임아웃(연결+전송). 느린 내부 서비스에 매달리지 않게 상한.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 연결 수립 타임아웃 — 차단 대역이 방화벽에 먹혀 무응답일 때 빨리 실패한다.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 핀 이전 DNS 해석 타임아웃 — reqwest의 connect/timeout은 요청 시작 뒤에만 걸려 이 사전
/// 해석 단계를 덮지 못한다. 느린/무응답 권위 DNS가 tauri 워커 스레드를 OS 리졸버 상한(macOS
/// getaddrinfo 수십 초)까지 붙잡지 못하게 [`resolve_and_pin`]이 자체 상한으로 감싼다.
const DNS_TIMEOUT: Duration = Duration::from_secs(5);

/// 동시에 살아 있을 수 있는 블로킹 DNS 해석 스레드의 **전역** 상한.
///
/// 역할: [`resolve_with_timeout`]이 호출마다 분리(detach) 스레드에서 blocking `getaddrinfo`를
/// 돌리는데, 그 스레드는 호출자의 [`DNS_TIMEOUT`] 만료가 아니라 `getaddrinfo`가 실제로 반환할
/// 때까지 산다(macOS는 무응답 권위 DNS에 수십 초). 프론트(`central-host.ts`)의 인플라이트
/// 상한은 "프라미스가 reject된 시점"에 슬롯을 반납하므로 백엔드에 살아 있는 스레드 수를 전혀
/// 반영하지 못한다. 그 틈으로 블랙홀 DNS를 노린 반복 호출이 스레드/스택 메모리를 누적시켜 앱을
/// 고갈시킬 수 있다.
/// 왜 이 값: 정상 부하(프론트 전역 인플라이트 16)를 여유 있게 덮으면서도, 스레드당 기본 스택
/// (~2MiB)을 곱해도 총량이 유계로 묶이는 크기. 상한에 닿으면 새 해석은 [`NET_TOO_MANY_REQUESTS`]로
/// 즉시 거부해 스레드가 무한히 쌓이지 못하게 한다. 슬롯은 스레드 수명에 묶인다(아래 참조).
const MAX_DNS_THREADS: usize = 32;

/// 현재 살아 있는(=`getaddrinfo` 반환을 기다리는) DNS 해석 스레드 수.
///
/// 역할: 이 전역 카운터가 백엔드의 실제 OS 스레드 총량을 상한하는 세마포어다. 슬롯은
/// [`acquire_dns_slot`]으로 잡고 [`DnsSlotGuard`]가 스레드 종료 시점에 반납한다 — 호출자의
/// 타임아웃이 아니라 **스레드 수명**에 묶여, 프론트 인플라이트 카운터와 무관하게 진짜 리소스를
/// 반영한다.
static DNS_THREADS_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

// ── 오류 토큰(프론트가 code로 매핑하는 안정 접두) ────────────────────────────────
// 각 거부는 `"<TOKEN>: <한국어 상세>"` 형태다. 프론트(`central-host.ts`)는 첫 `:` 앞
// 토큰만 보고 `MemoErrorCode`로 분류하고, 상세는 진단에 그대로 잇는다. 토큰을 바꾸면
// 프론트 매핑도 함께 바꿔야 한다(계약).
/// https가 아닌 스킴.
pub const NET_SCHEME: &str = "NET_SCHEME";
/// URL 파싱 실패·호스트 없음.
pub const NET_INVALID_URL: &str = "NET_INVALID_URL";
/// 허용 목록 밖 메서드.
pub const NET_METHOD: &str = "NET_METHOD";
/// 호스트를 IP로 해석하지 못함.
pub const NET_DNS: &str = "NET_DNS";
/// 사설/내부/메타데이터 대역으로 해석됨.
pub const NET_BLOCKED_ADDRESS: &str = "NET_BLOCKED_ADDRESS";
/// 응답 크기 상한 초과.
pub const NET_TOO_LARGE: &str = "NET_TOO_LARGE";
/// 타임아웃(연결/전송).
pub const NET_TIMEOUT: &str = "NET_TIMEOUT";
/// 그 외 전송 오류(연결 거부·TLS 실패 등).
pub const NET_REQUEST: &str = "NET_REQUEST";
/// 동시 DNS 해석 스레드가 전역 상한([`MAX_DNS_THREADS`])에 닿아 즉시 거부됨(백엔드 자원 보호).
/// 프론트(`central-host.ts`)가 `NETWORK_TOO_MANY_REQUESTS`로 맵한다 — 일시적 과부하 신호(재시도).
pub const NET_TOO_MANY_REQUESTS: &str = "NET_TOO_MANY_REQUESTS";

/// 허용 메서드 화이트리스트(대문자 정규화 후 대조).
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/// 플러그인이 세팅하지 못하는 요청 헤더(소문자). Host·Cookie·Authorization은 자격증명/핀
/// 우회의 통로라 무조건 버리고, content-length·connection·transfer-encoding은 전송 계층이
/// 소유한다(플러그인이 손대면 요청이 깨진다).
const FORBIDDEN_REQUEST_HEADERS: &[&str] = &[
    "host",
    "cookie",
    "authorization",
    "proxy-authorization",
    "content-length",
    "connection",
    "transfer-encoding",
];

/// 요청/응답 헤더 한 쌍(이름·값). 프론트 계약(`shared/tauri.ts`)과 같은 형태.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
}

/// 중계 응답 — 플러그인에 그대로 돌려주는 값.
///
/// `body`는 문자열이다(바이너리 미지원 — AI/텍스트 API 대상). 비-UTF8 바이트는 손실 대체된다.
#[derive(Debug, Clone, Serialize)]
pub struct NetResponse {
    /// HTTP 상태 코드(3xx도 그대로 — 리다이렉트를 따라가지 않으므로 플러그인이 본다).
    pub status: u16,
    /// 응답 헤더(중복 보존 위해 배열).
    pub headers: Vec<HeaderEntry>,
    /// 응답 본문(UTF-8 손실 변환, 크기 상한 적용).
    pub body: String,
}

/// 검증을 통과한 요청 대상(스킴·호스트·포트·연결할 핀 주소).
#[derive(Debug)]
struct Target {
    /// 정규화된 요청 URL(원 호스트 유지 — TLS SNI·Host 헤더가 이 호스트로 나간다).
    url: reqwest::Url,
    /// reqwest DNS 오버라이드 키(도메인일 때만 Some — IP 리터럴은 reqwest가 해석을 안 하므로 불필요).
    pin_host: Option<String>,
    /// 검증 통과해 핀한 연결 주소.
    pin_addr: SocketAddr,
}

/// IP가 차단 대역(사설·루프백·링크로컬·ULA·메타데이터·0.0.0.0 등)인지 판정한다.
///
/// 역할: SSRF 방어의 핵심 술어 — 이 함수가 참이면 그 주소로는 절대 연결하지 않는다.
/// 왜: v4/v6 각 대역을 한 곳에 모아 테스트로 전수 고정한다(std의 `is_*`가 불안정한 것은
/// 직접 비트마스크로 구현). IPv4-매핑 v6(`::ffff:a.b.c.d`)은 내부 v4로 되돌려 재검사한다
/// (v4 검사를 우회하는 고전적 트릭 차단).
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => {
            // IPv4-매핑/호환 주소는 담긴 v4로 판정(우회 차단).
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_v4(v4);
            }
            // NAT64(64:ff9b::/96·64:ff9b:1::/48)·6to4(2002::/16)는 v6 안에 v4를 임베딩한다.
            // 그 v4를 뽑아 v4 대역 검사에 태운다 — 안 그러면 사설/메타데이터 v4를 이 프리픽스로
            // 인코딩해 v6 리터럴로 위장하면 v4 검사를 통째로 우회한다(macOS는 IPv6-only 망에서
            // NAT64 프리픽스를 자동 발견·사용하므로 실배포 환경에서 라우팅 가능한 우회다).
            if let Some(v4) = embedded_v4(v6) {
                if is_blocked_v4(v4) {
                    return true;
                }
            }
            v6.is_loopback()                       // ::1
                || v6.is_unspecified()             // ::
                || v6.is_multicast()               // ff00::/8
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7 (fd00:ec2::254 메타데이터 포함)
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // 링크로컬 fe80::/10
        }
    }
}

/// v4 차단 대역 판정(RFC1918·루프백·링크로컬·CGNAT·메타데이터·0.0.0.0/8·멀티캐스트·예약).
fn is_blocked_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_private()             // 10/8 · 172.16/12 · 192.168/16
        || v4.is_loopback()     // 127/8
        || v4.is_link_local()   // 169.254/16 (169.254.169.254 메타데이터 포함)
        || v4.is_broadcast()    // 255.255.255.255
        || v4.is_documentation()// 192.0.2/24 · 198.51.100/24 · 203.0.113/24
        || v4.is_multicast()    // 224/4
        || o[0] == 0            // 0.0.0.0/8 (0.0.0.0 로컬 자기 지정 포함)
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
        || o[0] >= 240 // 예약 240/4
}

/// v6 안에 IPv4를 임베딩하는 프리픽스(NAT64·6to4)에서 그 IPv4를 추출한다(해당 없으면 None).
///
/// 역할: [`is_blocked_ip`]가 이 v4를 [`is_blocked_v4`]로 재검사해, 사설/메타데이터 IPv4를 v6
/// 리터럴로 위장하는 우회를 막는다. `to_ipv4()`(IPv4-매핑/호환)는 호출부가 먼저 처리하므로
/// 여기서는 그 밖의 임베딩 프리픽스만 본다.
/// 왜 통째 차단이 아니라 추출인가: DNS64가 켜진 IPv6-only 망(AWS IPv6 서브넷·모바일 464XLAT)은
/// 정상 공개 도메인의 A 레코드도 64:ff9b::/96로 합성한다 — 프리픽스를 통째로 막으면 그 망에서
/// 정당한 fetch가 전부 깨진다. 임베딩된 v4가 공개면 통과, 사설/메타데이터면 차단이 옳다.
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    // 마지막 32비트(segments[6..=7])를 IPv4로 조립.
    let low32 = || {
        Ipv4Addr::new(
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        )
    };
    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) → 하위 32비트가 IPv4.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(low32());
    }
    // NAT64 RFC 8215 로컬용 64:ff9b:1::/48 → 하위 32비트가 IPv4.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0x0001 {
        return Some(low32());
    }
    // 6to4 2002::/16 (RFC 3056) → segments[1..=2]가 임베딩된 IPv4.
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        ));
    }
    None
}

/// URL을 파싱해 https·호스트를 검증하고 대상 정보를 만든다(연결 없이 순수).
///
/// 역할: (1) https 전용 강제, (2) IP 리터럴은 즉시 대역 검사, (3) 도메인은 DNS 해석 후 검사.
/// 리터럴 v4/v6은 reqwest가 해석을 안 하므로 핀 오버라이드 없이 그대로 연결하되, 여기서
/// 이미 차단 대역을 걸러 낸다. 도메인은 [`resolve_and_pin`]으로 넘긴다.
fn parse_target(url: &str) -> Result<Target, String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("{NET_INVALID_URL}: URL을 해석할 수 없습니다: {url} ({e})"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "{NET_SCHEME}: https만 허용됩니다(요청 스킴: {}): {url}",
            parsed.scheme()
        ));
    }
    // userinfo(`user:pass@host`) 거부 — reqwest는 URL의 userinfo를 자동으로
    // `Authorization: Basic ...`로 주입한다. [`sanitize_headers`]가 막는 것은 `headers`
    // 배열 경로뿐이라, userinfo를 그냥 두면 플러그인이 못 세팅한다고 문서가 약속한 인증
    // 헤더가 URL을 통해 우회로 실린다. 살균 후 진행이 아니라 명시적 거부다(이 리포의 규약).
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "{NET_INVALID_URL}: URL에 자격증명(userinfo)을 포함할 수 없습니다: {url}"
        ));
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    // 호스트를 소유 값(owned)으로 먼저 뽑아 `parsed`의 대여를 끊는다(뒤에서 parsed를 Target으로
    // 이동해야 하므로). IP 리터럴은 핀 오버라이드가 필요 없고, 도메인은 해석해 핀한다.
    let (pin_host, pin_addr) = match parsed
        .host()
        .ok_or_else(|| format!("{NET_INVALID_URL}: 호스트가 없습니다: {url}"))?
    {
        // IP 리터럴 — DNS 없이 곧장 대역 검사(reqwest가 해석을 안 하므로 핀 불필요).
        url::Host::Ipv4(ip) => {
            let addr = SocketAddr::new(IpAddr::V4(ip), port);
            reject_if_blocked(addr.ip(), &ip.to_string())?;
            (None, addr)
        }
        url::Host::Ipv6(ip) => {
            let addr = SocketAddr::new(IpAddr::V6(ip), port);
            reject_if_blocked(addr.ip(), &ip.to_string())?;
            (None, addr)
        }
        // 도메인 — 해석 후 모든 IP 검사, 통과 IP를 핀한다.
        url::Host::Domain(domain) => (Some(domain.to_string()), resolve_and_pin(domain, port)?),
    };
    Ok(Target {
        url: parsed,
        pin_host,
        pin_addr,
    })
}

/// IP가 차단 대역이면 `NET_BLOCKED_ADDRESS`로 거부한다(리터럴·해석 공용).
fn reject_if_blocked(ip: IpAddr, shown_host: &str) -> Result<(), String> {
    if is_blocked_ip(ip) {
        return Err(format!(
            "{NET_BLOCKED_ADDRESS}: 사설/내부 대역 주소로 해석됩니다: {shown_host} → {ip}"
        ));
    }
    Ok(())
}

/// 도메인을 DNS 해석하고 **모든** 결과 IP를 검사한 뒤 첫 통과 주소를 핀으로 돌려준다.
///
/// 역할: 하나라도 차단 대역으로 해석되면 전체를 거부한다(공용+사설 혼합 응답 = 리바인딩/분할
/// 지평선 공격 징후 — 정상 공개 API는 그러지 않는다). 통과 시 첫 주소를 핀해, 이후 reqwest가
/// 재해석 없이 그 IP로만 연결하게 한다(리다이렉트도 없어 재해석 지점이 없다).
fn resolve_and_pin(domain: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs = resolve_with_timeout(domain, port)?;
    let first = addrs
        .first()
        .copied()
        .ok_or_else(|| format!("{NET_DNS}: 호스트가 어떤 주소로도 해석되지 않습니다: {domain}"))?;
    for a in &addrs {
        reject_if_blocked(a.ip(), domain)?;
    }
    Ok(first)
}

/// `counter`가 `cap` 미만이면 원자적으로 1 증가시키고 `true`, 이미 `cap`이면 그대로 두고 `false`.
///
/// 역할: 경합에 안전한 CAS 루프로 "상한이 있는 카운팅 세마포어의 획득"을 구현한다. 여러 tauri
/// 워커 스레드가 동시에 슬롯을 다퉈도 총합이 절대 `cap`을 넘지 않음을 보장한다(단순
/// load→비교→store는 두 스레드가 같은 값을 보고 둘 다 증가시키는 경합에 뚫린다).
fn try_increment_capped(counter: &AtomicUsize, cap: usize) -> bool {
    let mut cur = counter.load(Ordering::Relaxed);
    loop {
        if cur >= cap {
            return false;
        }
        match counter.compare_exchange_weak(cur, cur + 1, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return true,
            Err(actual) => cur = actual,
        }
    }
}

/// DNS 해석 슬롯의 소유권 — 드롭될 때 [`DNS_THREADS_INFLIGHT`]를 1 반납한다(RAII).
///
/// 역할: 슬롯 반납을 스레드 종료(가드 드롭) 시점에 묶는 핵심 장치다. 이 가드를 해석 스레드
/// 클로저로 **이동**시키면, 호출자가 [`DNS_TIMEOUT`]에 먼저 떠나도 슬롯은 유지되고 `getaddrinfo`가
/// 실제로 반환해 스레드가 끝날 때에야 반납된다 — 그래서 카운터가 "살아 있는 스레드 수"와 정확히
/// 일치한다. 클로저 패닉 시에도 드롭은 실행돼 슬롯이 새지 않는다.
struct DnsSlotGuard;

impl Drop for DnsSlotGuard {
    fn drop(&mut self) {
        DNS_THREADS_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 전역 상한 안에서 DNS 해석 슬롯 하나를 잡는다(상한이면 `None`).
fn acquire_dns_slot() -> Option<DnsSlotGuard> {
    if try_increment_capped(&DNS_THREADS_INFLIGHT, MAX_DNS_THREADS) {
        Some(DnsSlotGuard)
    } else {
        None
    }
}

/// 블로킹 DNS 해석(`to_socket_addrs`)을 [`DNS_TIMEOUT`] 상한 + 전역 스레드 상한으로 감싼다.
///
/// 역할: OS 리졸버는 자체 상한이 수십 초라, 공격자가 통제하는 권위 DNS가 쿼리를 받되 응답을
/// 흘리면 이 사전 해석 단계가 워커 스레드를 그만큼 붙잡는다(reqwest 타임아웃은 이 지점을 못
/// 덮는다). 별도 스레드에서 해석하고 채널 `recv_timeout`으로 상한을 강제해, 상한을 넘으면
/// `NET_TIMEOUT`으로 즉시 실패한다(해석 스레드는 분리(detach) — 뒤늦게 끝나도 채널 송신만
/// 조용히 버려진다).
/// 왜 슬롯이 필요한가: `recv_timeout`은 **호출자가 기다리는 시간**만 상한할 뿐 detach 스레드의
/// 수명은 상한하지 못한다. 블랙홀 DNS면 스레드는 `getaddrinfo` 반환까지 계속 살아, 반복 호출로
/// 수백~수천 개가 누적돼 스레드/스택 메모리를 고갈시킨다(프론트 인플라이트 상한은 이를 못 본다).
/// 그래서 스레드를 띄우기 전에 [`acquire_dns_slot`]으로 전역 슬롯을 잡고, 그 가드를 스레드로
/// 옮겨 **스레드가 실제로 끝날 때** 반납한다. 상한에 닿으면 새 스레드를 아예 만들지 않고
/// [`NET_TOO_MANY_REQUESTS`]로 즉시 거부해 백엔드 스레드 총량 자체를 강하게 유계로 묶는다.
fn resolve_with_timeout(domain: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let slot = acquire_dns_slot().ok_or_else(|| {
        format!(
            "{NET_TOO_MANY_REQUESTS}: 동시 DNS 해석이 상한({MAX_DNS_THREADS})을 초과했습니다: {domain}"
        )
    })?;
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = domain.to_string();
    std::thread::spawn(move || {
        // 슬롯 가드를 스레드로 이동 — `getaddrinfo`가 실제로 반환해 이 클로저가 끝날 때(정상·패닉
        // 무관) 드롭되며 슬롯을 반납한다. 호출자의 recv_timeout이 아니라 스레드 수명에 슬롯을
        // 묶는 것이 이 방어의 핵심이다.
        let _slot = slot;
        let result = (owned.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<SocketAddr>>());
        // 수신자가 이미 타임아웃으로 떠났으면 송신 실패는 무시한다(스레드는 곧 종료).
        let _ = tx.send(result);
    });
    match rx.recv_timeout(DNS_TIMEOUT) {
        Ok(Ok(addrs)) => Ok(addrs),
        Ok(Err(e)) => Err(format!(
            "{NET_DNS}: 호스트를 해석할 수 없습니다: {domain} ({e})"
        )),
        Err(_) => Err(format!(
            "{NET_TIMEOUT}: DNS 해석이 {}초 상한을 넘었습니다: {domain}",
            DNS_TIMEOUT.as_secs()
        )),
    }
}

/// 메서드 문자열을 화이트리스트로 검증해 `reqwest::Method`로 바꾼다.
fn parse_method(method: &str) -> Result<reqwest::Method, String> {
    let upper = method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&upper.as_str()) {
        return Err(format!(
            "{NET_METHOD}: 허용되지 않는 메서드입니다: {method} (허용: {})",
            ALLOWED_METHODS.join("/")
        ));
    }
    reqwest::Method::from_bytes(upper.as_bytes())
        .map_err(|e| format!("{NET_METHOD}: 메서드 형식 오류: {method} ({e})"))
}

/// 플러그인이 준 요청 헤더에서 금지 헤더(자격증명·전송 계층 소유)를 걸러 낸다(대소문자 무시).
///
/// 역할: Host·Cookie·Authorization 등을 플러그인이 세팅하지 못하게 해 자격증명 주입과 핀
/// 우회(Host 위조)를 막는다. 이름/값에 개행이 섞이면(헤더 인젝션) 그 항목을 버린다.
fn sanitize_headers(headers: &[HeaderEntry]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|h| {
            let lower = h.name.to_ascii_lowercase();
            !FORBIDDEN_REQUEST_HEADERS.contains(&lower.as_str())
                && !h.name.is_empty()
                && !h.name.contains(['\r', '\n'])
                && !h.value.contains(['\r', '\n'])
        })
        .map(|h| (h.name.clone(), h.value.clone()))
        .collect()
}

/// 모든 보안 옵션을 적용한 블로킹 클라이언트 빌더(https_only 제외 — 호출부가 더한다).
///
/// 역할: 리다이렉트 미추적·프록시 무시·타임아웃을 한 곳에 모은다. `https_only`는 여기 넣지
/// 않는다 — 리다이렉트 미추적 테스트가 인증서 없는 http 루프백 서버로 그 정책만 검증하기
/// 위해서다(https 강제는 [`parse_target`]의 스킴 거부가 1차 관문이고, 실경로는 아래
/// [`build_client`]가 `https_only(true)`를 벨트로 더한다).
fn secure_builder() -> reqwest::blocking::ClientBuilder {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent("memo-plugin-fetch")
}

/// 대상에 맞춘 실경로 클라이언트를 만든다(핀 오버라이드 + https 강제).
fn build_client(target: &Target) -> Result<reqwest::blocking::Client, String> {
    let mut builder = secure_builder().https_only(true);
    if let Some(host) = &target.pin_host {
        // 도메인 → 검증 통과 IP로 DNS를 고정한다(리바인딩 차단). Host/SNI는 URL의 원 호스트 유지.
        builder = builder.resolve(host, target.pin_addr);
    }
    builder
        .build()
        .map_err(|e| format!("{NET_REQUEST}: HTTP 클라이언트 생성 실패: {e}"))
}

/// reqwest 오류를 안정 토큰으로 분류한다(타임아웃/크기/그 외 전송).
fn classify_error(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        NET_TIMEOUT
    } else {
        NET_REQUEST
    }
}

/// 응답 헤더를 배열로 수집한다(비-UTF8 값은 손실 변환, 중복 보존).
fn collect_headers(headers: &reqwest::header::HeaderMap) -> Vec<HeaderEntry> {
    headers
        .iter()
        .map(|(k, v)| HeaderEntry {
            name: k.as_str().to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).into_owned(),
        })
        .collect()
}

/// 검증된 대상으로 실제 요청을 보내고 상한까지만 응답을 읽는다(블로킹).
///
/// 역할: [`net_fetch`]의 순수-아닌 실행부를 분리해, 상태·헤더를 먼저 캡처하고 본문은
/// `cap+1`까지만 읽어 초과를 거부한다(무한/거대 응답이 메모리를 먹지 못하게).
fn send_and_read(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    target: &Target,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<NetResponse, String> {
    let mut req = client.request(method, target.url.clone());
    for (name, value) in headers {
        req = req.header(name, value);
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let resp = req
        .send()
        .map_err(|e| format!("{}: 요청에 실패했습니다: {e}", classify_error(&e)))?;

    let status = resp.status().as_u16();
    let headers = collect_headers(resp.headers());

    // content-length가 상한을 선언하면 본문을 읽기 전에 거부(빠른 실패).
    if let Some(len) = resp.content_length() {
        if len > MAX_RESPONSE_BYTES {
            return Err(format!(
                "{NET_TOO_LARGE}: 응답이 너무 큽니다: {len}바이트(상한 {MAX_RESPONSE_BYTES}바이트)"
            ));
        }
    }

    // content-length가 없거나 거짓일 수 있으므로 실제 스트림도 cap+1까지만 읽어 강제한다.
    let mut buf = Vec::new();
    resp.take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{NET_REQUEST}: 응답 본문 읽기 실패: {e}"))?;
    if buf.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(format!(
            "{NET_TOO_LARGE}: 응답이 상한({MAX_RESPONSE_BYTES}바이트)을 초과합니다"
        ));
    }

    Ok(NetResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

/// `memo.network.fetch`의 백엔드 — 호스트가 대신 수행하는 https 중계.
///
/// 역할: 도메인 승인(화이트리스트 매칭)은 **프론트 게이트키퍼가 이 커맨드 호출 전에** 끝냈다는
/// 전제이지만, 스킴·사설대역·IP 핀·리다이렉트·크기·타임아웃·메서드·자격증명은 여기서 다시
/// 강제한다(TS 매칭만 믿지 않는 심층 방어 — 이 커맨드는 신뢰 경계 밖 인자를 받는다).
/// `async`인 이유: 네트워크 IO는 메인 스레드에서 돌리면 앱 전체가 멈춘다(이 리포의 실측 교훈).
/// `#[tauri::command(async)]`가 tauri 스레드풀에서 실행해 블로킹 클라이언트를 안전히 돌린다.
///
/// 오류: 각 거부 사유를 `NET_*` 토큰 접두로 구분한다(프론트가 `MemoErrorCode`로 매핑).
#[tauri::command(async)]
pub fn net_fetch(
    url: String,
    method: String,
    headers: Vec<HeaderEntry>,
    body: Option<String>,
) -> Result<NetResponse, String> {
    let target = parse_target(&url)?;
    let method = parse_method(&method)?;
    let sanitized = sanitize_headers(&headers);
    let client = build_client(&target)?;
    send_and_read(&client, method, &target, sanitized, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// 가드: v4 차단 대역 전수 — RFC1918·루프백·링크로컬(메타데이터)·CGNAT·0/8·브로드캐스트·
    /// 예약은 차단, 공개 주소는 통과.
    #[test]
    fn blocks_v4_ranges() {
        let blocked = [
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "127.0.0.1",
            "127.1.2.3",
            "169.254.1.1",
            "169.254.169.254", // 클라우드 메타데이터
            "100.64.0.1",      // CGNAT
            "0.0.0.0",
            "0.1.2.3",
            "255.255.255.255",
            "240.0.0.1", // 예약
            "224.0.0.1", // 멀티캐스트
        ];
        for ip in blocked {
            assert!(is_blocked_ip(ip.parse().unwrap()), "차단돼야 함: {ip}");
        }
        let allowed = [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "172.15.0.1",
            "172.32.0.1",
        ];
        for ip in allowed {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "허용돼야 함: {ip}");
        }
    }

    /// 가드: v6 차단 대역 — 루프백·미지정·ULA(메타데이터 fd00:ec2::254)·링크로컬·멀티캐스트·
    /// IPv4-매핑 사설은 차단, 공개 v6는 통과.
    #[test]
    fn blocks_v6_ranges() {
        let blocked = [
            "::1",
            "::",
            "fc00::1",
            "fd00::1",
            "fd00:ec2::254", // 클라우드 메타데이터(ULA)
            "fe80::1",
            "ff02::1",
            "::ffff:10.0.0.1",        // IPv4-매핑 사설(우회 시도)
            "::ffff:169.254.169.254", // IPv4-매핑 메타데이터
            "::ffff:127.0.0.1",
            // NAT64 well-known 64:ff9b::/96에 사설/메타데이터 v4를 인코딩(우회 시도).
            "64:ff9b::a9fe:a9fe", // 169.254.169.254 메타데이터
            "64:ff9b::7f00:1",    // 127.0.0.1 루프백
            "64:ff9b::a00:1",     // 10.0.0.1 사설
            // NAT64 RFC 8215 로컬용 64:ff9b:1::/48.
            "64:ff9b:1::7f00:1", // 127.0.0.1
            // 6to4 2002::/16에 사설/메타데이터 v4를 인코딩.
            "2002:7f00:1::",    // 127.0.0.1
            "2002:a9fe:a9fe::", // 169.254.169.254 메타데이터
        ];
        for ip in blocked {
            assert!(is_blocked_ip(ip.parse().unwrap()), "차단돼야 함: {ip}");
        }
        let allowed = [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            // NAT64·6to4에 **공개** v4를 인코딩한 것은 통과해야 한다(통째 차단이 아니라
            // 임베딩 v4 재검사임을 고정 — DNS64가 켜진 IPv6-only 망에서 정당한 fetch 보존).
            "64:ff9b::808:808", // 8.8.8.8 (공개)
            "2002:101:101::",   // 1.1.1.1 (공개)
        ];
        for ip in allowed {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "허용돼야 함: {ip}");
        }
    }

    /// 가드: https가 아닌 스킴은 NET_SCHEME로 거부된다(http·file·ftp·javascript).
    #[test]
    fn rejects_non_https_scheme() {
        for url in [
            "http://example.com/",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "javascript:alert(1)",
        ] {
            let err = parse_target(url).unwrap_err();
            assert!(
                err.starts_with(NET_SCHEME) || err.starts_with(NET_INVALID_URL),
                "{url} → {err}"
            );
        }
        // javascript:는 스킴 거부여야 한다(파싱은 성공).
        assert!(parse_target("javascript:alert(1)")
            .unwrap_err()
            .starts_with(NET_SCHEME));
    }

    /// 가드: IP 리터럴 URL도 사설/메타데이터 대역이면 연결 전에 거부된다(v4·v6·IPv4-매핑).
    #[test]
    fn rejects_ip_literal_private_and_metadata() {
        let blocked_urls = [
            "https://127.0.0.1/",
            "https://10.0.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
            "https://[fd00:ec2::254]/",
            "https://[::ffff:10.0.0.1]/",
            // NAT64로 위장한 메타데이터/루프백 리터럴도 연결 전에 차단돼야 한다.
            "https://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
            "https://[64:ff9b::7f00:1]/",
        ];
        for url in blocked_urls {
            let err = parse_target(url).unwrap_err();
            assert!(err.starts_with(NET_BLOCKED_ADDRESS), "{url} → {err}");
        }
        // 공개 IP 리터럴은 통과(핀 오버라이드 없이).
        let ok = parse_target("https://1.1.1.1/").unwrap();
        assert!(ok.pin_host.is_none());
        assert_eq!(ok.pin_addr, "1.1.1.1:443".parse().unwrap());
    }

    /// 가드(자격증명 우회): userinfo(`user:pass@host`)가 실린 URL은 Target을 만들기 전에
    /// NET_INVALID_URL로 거부된다. reqwest가 userinfo를 `Authorization: Basic ...`로 자동
    /// 주입하는데, 이는 sanitize_headers가 막는 `headers` 배열 경로 밖이라 그냥 두면
    /// 플러그인이 URL을 통해 인증 헤더를 우회로 실을 수 있다(살균이 아니라 명시 거부).
    #[test]
    fn rejects_url_with_userinfo() {
        for url in [
            "https://user:pass@api.example.com/path",
            "https://user@api.example.com/path", // 비밀번호 없는 username만 있어도 거부
            "https://:pass@api.example.com/path", // 비밀번호만 있어도 거부
        ] {
            let err = parse_target(url).unwrap_err();
            assert!(err.starts_with(NET_INVALID_URL), "{url} → {err}");
        }
        // userinfo가 없는 같은 호스트는 통과 경로로 진행한다(스킴·userinfo 관문을 넘어
        // DNS 해석까지 감 — 여기서는 관문만 검증하므로 NET_INVALID_URL이 아니면 충분).
        let err = parse_target("https://api.example.com.invalid.nonexistent.tld/").unwrap_err();
        assert!(
            !err.starts_with(NET_INVALID_URL),
            "userinfo 없이는 관문 통과: {err}"
        );
    }

    /// 가드: 도메인 해석 — 루프백으로 해석되는 이름(localhost)은 거부된다(리터럴이 아닌
    /// 경로에서도 사설대역이 걸린다). 해석 불가 호스트는 NET_DNS.
    #[test]
    fn rejects_domain_resolving_to_loopback() {
        // localhost는 루프백으로 해석된다 → 차단.
        let err = parse_target("https://localhost/").unwrap_err();
        assert!(err.starts_with(NET_BLOCKED_ADDRESS), "실제: {err}");

        // 존재하지 않을 TLD → 해석 실패(NET_DNS).
        let err = parse_target("https://memo.invalid.nonexistent.tld.example-does-not-resolve/")
            .unwrap_err();
        assert!(err.starts_with(NET_DNS), "실제: {err}");
    }

    /// 가드: 메서드 화이트리스트 — 6종만 통과, 그 외(OPTIONS·TRACE·CONNECT·헛것)는 거부.
    #[test]
    fn method_whitelist() {
        for m in ["get", "POST", "Put", "patch", "delete", "head"] {
            assert!(parse_method(m).is_ok(), "허용: {m}");
        }
        for m in ["OPTIONS", "TRACE", "CONNECT", "FROBNICATE", ""] {
            assert!(
                parse_method(m).unwrap_err().starts_with(NET_METHOD),
                "거부: {m}"
            );
        }
    }

    /// 가드: 헤더 살균 — Host·Cookie·Authorization(대소문자 무시)·전송 계층 헤더·개행 주입은
    /// 버려지고, 정상 헤더는 통과한다.
    #[test]
    fn sanitizes_credential_and_injection_headers() {
        let input = vec![
            HeaderEntry {
                name: "Accept".into(),
                value: "application/json".into(),
            },
            HeaderEntry {
                name: "Host".into(),
                value: "internal".into(),
            },
            HeaderEntry {
                name: "cookie".into(),
                value: "sid=1".into(),
            },
            HeaderEntry {
                name: "AUTHORIZATION".into(),
                value: "Bearer x".into(),
            },
            HeaderEntry {
                name: "Content-Length".into(),
                value: "999".into(),
            },
            HeaderEntry {
                name: "X-Inject".into(),
                value: "a\r\nHost: evil".into(),
            },
            HeaderEntry {
                name: "X-Custom".into(),
                value: "ok".into(),
            },
        ];
        let out = sanitize_headers(&input);
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["Accept", "X-Custom"], "실제: {names:?}");
    }

    /// 가드(SSRF 핵심): 리다이렉트를 따라가지 않는다 — 302를 주는 루프백 서버에 붙어도
    /// 상태 302가 그대로 돌아오고 Location만 실린다(자동 추적 시 검사 우회 발생).
    ///
    /// https_only 없는 [`secure_builder`]로 인증서 없는 http 루프백을 때려 **리다이렉트
    /// 정책만** 검증한다(https 강제는 스킴 거부·`build_client`가 따로 본다).
    #[test]
    fn does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut req = [0u8; 1024];
                let _ = sock.read(&mut req);
                let _ = sock.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 2\r\n\r\nhi",
                );
                let _ = sock.flush();
            }
        });

        let client = secure_builder().build().unwrap();
        let resp = client
            .get(format!("http://{addr}/"))
            .send()
            .expect("루프백 요청");
        assert_eq!(resp.status().as_u16(), 302, "리다이렉트를 따라가면 안 된다");
        assert_eq!(
            resp.headers().get("location").and_then(|v| v.to_str().ok()),
            Some("http://evil.example/"),
            "3xx 응답이 그대로 반환돼야 한다"
        );
        let _ = handle.join();
    }

    /// 가드: 응답 크기 상한 — 상한을 넘는 스트림은 cap+1에서 끊겨 NET_TOO_LARGE로 거부되고,
    /// 초과분을 계속 읽지 않는다(무한 스트림에서도 테스트가 끝나는 것이 그 증거).
    #[test]
    fn response_size_cap_enforced() {
        // `send_and_read`의 본문 상한 로직과 동일한 패턴을 순수 reader로 고정한다
        // (네트워크 없이 상한 강제 자체를 검증).
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
        let cap = MAX_RESPONSE_BYTES;
        let mut counting = Counting {
            inner: std::io::repeat(b'x'),
            served: 0,
        };
        let mut buf = Vec::new();
        counting
            .by_ref()
            .take(cap + 1)
            .read_to_end(&mut buf)
            .unwrap();
        assert!(buf.len() as u64 > cap, "cap 초과가 감지돼야 한다");
        assert_eq!(counting.served, cap + 1, "cap+1 바이트에서 멈춰야 한다");
    }

    /// 가드(DoS): DNS 해석 슬롯 상한은 경합에 안전한 카운팅 세마포어다 — cap까지만 획득되고,
    /// 상한에 닿으면 거부(증가 없이 false)하며, 슬롯 하나가 반납되면 다시 하나가 열린다.
    ///
    /// 이 상한이 [`resolve_with_timeout`]에서 새 해석 스레드 생성 여부를 좌우한다. 상한이 없으면
    /// 블랙홀 DNS를 노린 반복 호출이 (호출자는 5초 뒤 실패하지만 스레드는 `getaddrinfo` 반환까지
    /// 살아) 스레드/스택 메모리를 무한 누적시켜 앱을 고갈시킨다 — 프론트 인플라이트 상한은 이미
    /// reject된 슬롯을 즉시 반납하므로 그 누적을 전혀 못 막는다. 전역 카운터가 실제 스레드 수를
    /// 상한하는 것이 유일한 방어라, 그 카운터의 획득 규칙을 로컬 카운터로 전수 고정한다.
    #[test]
    fn dns_slot_cap_is_a_counting_semaphore() {
        let counter = AtomicUsize::new(0);
        let cap = 3usize;
        for i in 0..cap {
            assert!(
                try_increment_capped(&counter, cap),
                "cap 미만이면 획득돼야 함(i={i})"
            );
        }
        // 상한에 닿으면 거부하고, 거부가 카운터를 건드리지 않아야 한다(안 그러면 오버런).
        assert!(
            !try_increment_capped(&counter, cap),
            "상한 도달 시 새 슬롯은 거부돼야 함"
        );
        assert_eq!(
            counter.load(Ordering::Relaxed),
            cap,
            "거부는 카운터를 증가시키지 않아야 함"
        );
        // 스레드 하나가 끝나 슬롯을 반납하면(=fetch_sub) 정확히 하나가 다시 열린다.
        counter.fetch_sub(1, Ordering::AcqRel);
        assert!(
            try_increment_capped(&counter, cap),
            "반납된 슬롯만큼만 다시 열려야 함"
        );
        assert!(
            !try_increment_capped(&counter, cap),
            "그 하나로 다시 상한 — 더는 안 열림"
        );
    }
}
