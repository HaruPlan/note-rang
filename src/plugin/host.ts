/**
 * 플러그인 호스트 — 브리지 요청을 권한 게이트키퍼로 검사한 뒤에만 실행한다.
 *
 * 역할: 격리 샌드박스(플러그인)가 보내는 모든 특권 요청의 강제 지점. 호출→필요권한을
 * 정하고, 통과할 때만 executor(실제 Rust IPC 대행)로 라우팅한다. 거부 시 executor를
 * 절대 호출하지 않는다.
 * 왜: 보안 모델의 단일 관문 — 미선언/미부여 호출이 호스트 특권에 닿지 못하게 한다.
 */
import {
  checkPermission,
  isKnownPermission,
  type PluginGrant,
} from "./permissions";
import type { PluginKind } from "./manifest";

/**
 * 브리지 오류의 **기계용 안정 식별자**(사람용 문구는 `error`에 따로 실린다).
 *
 * 역할: 저작자·AI가 실패 원인별로 분기할 때 한국어 자유 문자열을 매칭하지 않아도 되게
 * 하는 안정 상수 집합. 부트스트랩이 이 값을 `Error.code`로 복원하므로 플러그인은
 * `err.code === "PERMISSION_UNDECLARED"`처럼 쓴다.
 * 왜: 지금까지 모든 거부가 `알 수 없는 호출: X` 같은 문구뿐이라, 문구를 다듬는 순간
 * 저작자의 방어 코드가 조용히 깨졌다.
 *
 * **열린 유니온인 이유**(의도된 비대칭): 오류는 늘어나는 게 정상이다 — `WRONG_PLUGIN_KIND`
 * 에 이어 `NOTE_NOT_FOUND`가 실제로 들어왔다. 닫힌 유니온이면 코드가
 * 늘 때마다 `.d.ts`를 참조하는 플러그인의 타입이 깨진다. `(string & {})`를 유니온에 넣으면
 * 알려진 코드는 자동완성되고 새 코드도 타입 오류 없이 통과한다.
 *
 * **토큰 만료는 새 코드를 만들지 않았다**: 유휴 만료된 컨텍스트 토큰의 민감 호출 거부도
 * `CONTEXT_UNAVAILABLE`을 재사용한다. 저작자의 교정 행동이 두 경우 정확히 같기 때문이다 —
 * 「새 클릭·이벤트에서 받은 바인딩된 memo로 다시 호출하라」. 코드를 쪼개면 기존 방어 코드가
 * 같은 처방을 두 가지로 나눠 적어야 한다(구분이 필요한 진단은 문구·진단 채널이 담당한다).
 *
 * 여기 열거하는 것은 **지금 실제로 방출되는 코드만**이다. 아직 아무도 던지지 않는 코드를
 * 미리 적으면 자동완성이 "있는데 안 오는 값"을 권해 저작자를 속인다.
 */
export type MemoErrorCode =
  /** `CALL_PERMISSIONS`에 없는 이름(오타·존재하지 않는 API). */
  | "UNKNOWN_CALL"
  /** 이름은 있지만 실행 경로가 아직 없음([`RESERVED_CALLS`]). */
  | "RESERVED_CALL"
  /** 능력 등록([`CAPABILITY_CALLS`])을 `kind: "action"` 플러그인이 호출함. */
  | "WRONG_PLUGIN_KIND"
  /** 우리가 모르는 권한 이름을 요구하는 호출(매핑표 자체의 오류). */
  | "PERMISSION_UNKNOWN"
  /** 매니페스트에 선언하지 않은 권한이 필요한 호출. */
  | "PERMISSION_UNDECLARED"
  /** 선언은 했지만 사용자가 부여하지 않은 민감 권한. */
  | "PERMISSION_UNGRANTED"
  /** 창-스코프 호출인데 대상 창 컨텍스트가 없음(`requireWindow: true` 옵트인),
   * **또는** 유휴 만료된 토큰으로 민감 호출을 시도함(이쪽은 옵트인 무관). */
  | "CONTEXT_UNAVAILABLE"
  /** `notes.read`에 준 id의 노트가 존재하지 않음. */
  | "NOTE_NOT_FOUND"
  /** 등록 인자의 구조가 잘못됨(검증 실패). */
  | "INVALID_ARGS"
  /** 저장소 상한 초과(`storage.set` — 어느 스코프든 같은 코드로 온다). */
  | "QUOTA_EXCEEDED"
  // ── network.fetch 거부 코드 ──────────────────────────────────────────
  // URL·스킴은 프론트 게이트키퍼가 백엔드 전에 판정하고(심층 방어 1차), 사설대역·DNS·크기·
  // 타임아웃은 백엔드(`net.rs`)가 `NET_*` 토큰으로 거부한 것을 central-host가 이 코드로 맵한다.
  /** `network.fetch`의 url이 https가 아님(프론트·백엔드 양쪽에서 거부). */
  | "NETWORK_SCHEME"
  /** `network.fetch`의 url을 URL로 해석할 수 없음(호스트 없음 포함). */
  | "NETWORK_INVALID_URL"
  /** 대상이 사설/내부/링크로컬/메타데이터 대역으로 해석됨(SSRF 차단 — 백엔드 재검증). */
  | "NETWORK_BLOCKED"
  /** 호스트를 어떤 IP로도 해석하지 못함(DNS 실패). */
  | "NETWORK_DNS"
  /** 허용 목록 밖 HTTP 메서드(GET·POST·PUT·PATCH·DELETE·HEAD만). */
  | "NETWORK_METHOD"
  /** 응답이 크기 상한(5MiB)을 초과함. */
  | "NETWORK_TOO_LARGE"
  /** 연결/전송 타임아웃. */
  | "NETWORK_TIMEOUT"
  /** 그 외 전송 실패(연결 거부·TLS 오류 등). */
  | "NETWORK_FAILED"
  /**
   * 동시 `network.fetch` 호출이 상한을 초과함(플러그인당/전역). 큐잉 대신 즉시 거부한다 —
   * 각 fetch는 공유 Tauri 블로킹 스레드풀을 최대 타임아웃(~30초)까지 붙잡을 수 있어, 상한이
   * 없으면 폭주/느린-서버 플러그인이 노트 읽기·저장 등 무관한 async 커맨드까지 굶긴다.
   */
  | "NETWORK_TOO_MANY_REQUESTS"
  // ── commands.invoke 거부 코드 ──────────────────────────────────────────
  // 권한(`invoke:<대상>` 미선언·미부여)은 기존 PERMISSION_* 코드를 그대로 쓴다 — 호출측이
  // 그 대상을 부를 자격이 있는가는 다른 민감 호출과 같은 질문이라 새 코드를 만들 이유가 없다.
  // 아래 셋은 자격을 통과한 **뒤에** 갈리는, invoke에만 있는 실패다(대상·공개·순환).
  /** `commands.invoke`의 대상 플러그인이 지금 실행 중이 아니거나(그 id의 샌드박스 없음),
   * 대상이 공개한 그 명령이 런타임에 등록돼 있지 않음(부를 것이 없음). */
  | "INVOKE_NO_TARGET"
  /** 대상 플러그인이 그 commandId를 매니페스트 `exposes`로 **공개하지 않음**(기본 비공개). */
  | "INVOKE_NOT_EXPOSED"
  /** 플러그인 간 호출이 상한 깊이를 넘김(A→B→A… 순환/폭주 방어 — 바인딩된 memo 경로 기준). */
  | "INVOKE_CYCLE"
  /** 위 어느 것도 아닌 실행부 예외(코드가 아직 안 붙은 경로). */
  | "UNKNOWN"
  | (string & {});

/** `code`를 실은 브리지 오류 — 부트스트랩이 `Error.code`로 복원한다. */
export interface MemoCallError extends Error {
  code: MemoErrorCode;
}

/**
 * 안정 코드를 실은 오류를 만든다(브리지 실행부의 표준 거부 수단).
 *
 * 역할: `throw bridgeError("INVALID_ARGS", "잘못된 …")`로 던지면
 * [`handleBridgeRequest`]가 `code`를 응답에 그대로 실어 샌드박스까지 나른다.
 * 왜: 실행부(registrar·창-스코프 수행부)의 거부도 게이트키퍼의 거부와 같은 계약을 갖게 해,
 * 저작자가 "어디서 거부됐는지"와 무관하게 `err.code` 하나만 보면 되게 한다.
 */
export function bridgeError(
  code: MemoErrorCode,
  message: string,
): MemoCallError {
  return Object.assign(new Error(message), { code });
}

/** 던져진 값에 실린 안정 코드를 꺼낸다(없으면 undefined — 아직 코드가 안 붙은 경로). */
function errorCodeOf(e: unknown): MemoErrorCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * 권한 거부의 사유를 안정 코드로 판정한다(문구 매칭 없이 규칙을 다시 평가).
 *
 * 왜: [`checkPermission`]은 사람용 `reason` 문자열만 돌려준다(그 모듈은 이 담당의 소유가
 * 아니라 반환형을 넓히지 못했다). 문구를 파싱하는 대신 **같은 순서로 같은 규칙**을 다시
 * 평가해 코드를 얻는다 — 두 판정이 어긋나면 `host.test.ts`의 대조 가드가 잡는다.
 */
function permissionDenialCode(
  grant: PluginGrant,
  required: string,
): MemoErrorCode {
  if (!isKnownPermission(required)) return "PERMISSION_UNKNOWN";
  if (!grant.declared.includes(required)) return "PERMISSION_UNDECLARED";
  return "PERMISSION_UNGRANTED";
}

/**
 * 호출 이름 → 필요 권한 매핑. 여기 없는 호출은 알 수 없는 호출로 거부한다.
 *
 * export하는 이유: 가드 테스트가 이 표의 모든 키가 (구현됨 ∪ [`RESERVED_CALLS`])로
 * 정확히 분할되는지 검사한다(표에 새 호출을 추가하고 예약/구현 어느 쪽에도 반영하지
 * 않는 드리프트를 잡는다) — `host.test.ts` 참고.
 */
export const CALL_PERMISSIONS: Readonly<Record<string, string>> = {
  "ui.addToolbarButton": "ui",
  "ui.addMenuItem": "ui",
  // 선택 액션 — 본문을 선택하면(마우스든 키보드든) 선택 툴바 끝에 뜨는 버튼(+ 단축키로도 실행). 등록·
  // 렌더 자체는 텍스트 + 클릭이라 저위험 `ui`다. 다만 `run`의 `payload.selectedText`는 본문의
  // 일부라 **`notes:read`가 부여됐을 때만** 채워진다(`ui.addMenuItem`과 같은 payload 단위
  // 게이트 — 호출 자체를 막지 않고 payload만 좁힌다). 되쓰기는 새 경로를 열지 않고 기존
  // `editor.insertText`(notes:write)를 그대로 쓴다.
  "ui.addSelectionAction": "ui",
  // 상태 표시형 아이템 — 클릭 버튼이 아니라 텍스트·카운트를 툴바에 보여준다. 등록
  // (`addStatusItem`)은 버튼 수집처럼 호스트 스코프에서 스냅샷에 모이고, 창별 라이브 텍스트
  // 갱신(`updateStatusItem`)은 그 호출을 낳은 창으로 위임되는 창-스코프 호출이다(toast와 같은
  // 결). 둘 다 텍스트 표시라 저위험 `ui`다(노트 데이터를 읽거나 쓰지 않는다).
  "ui.addStatusItem": "ui",
  "ui.updateStatusItem": "ui",
  // 메뉴바 트레이 항목 — 플러그인이 시스템 트레이(메뉴바)에 항목 하나를 얹고, 클릭하면
  // 등록한 `run`이 돈다. 텍스트 + 클릭뿐이라(노트 데이터를 읽거나 쓰지 않는다) 저위험 `ui`다.
  // **호스트 스코프**다: 트레이는 특정 노트 창과 무관한 앱 전역 자원이라, 클릭 실행에는 창
  // 컨텍스트가 없다(설정 화면 액션 버튼과 같은 폴백 계약 — `run` 안의 창-스코프 호출은
  // 마지막으로 쓴 메모 창으로 가거나, 없으면 CONTEXT_UNAVAILABLE + 진단). 등록은 버튼·명령과
  // 같은 자리(makeHostExecutor)에서 수집되고, 실제 트레이는 네이티브(Rust)가 그린다.
  "ui.addTrayItem": "ui",
  "ui.toast": "ui",
  // 목록 선택·한 줄 입력 팝업(창-스코프) — 사용자 제스처로 뜨는 UI라 ui 저위험.
  "ui.pickList": "ui",
  "ui.prompt": "ui",
  "editor.registerWidget": "editor",
  "editor.registerInlinePattern": "editor",
  "editor.registerCompletion": "editor",
  // 블록 임베드 등록 자체는 editor 저위험 — 실제 렌더는 최종 URL 도메인별
  // `embed:<domain>` 게이트(blockEmbedField의 allowEmbedDomain)가 별도로 막는다.
  "editor.registerBlockEmbed": "editor",
  "editor.getFontDelta": "editor",
  "editor.setFontDelta": "editor",
  // 커서 위치 텍스트 삽입은 노트 본문을 실제로 쓴다 → editor 저위험이 아니라
  // notes:write(민감, 선언+부여) 게이트로 막는다(템플릿 등이 본문을 바꾸므로).
  "editor.insertText": "notes:write",
  // 버튼 없는 명령 — 툴바를 차지하지 않고 단축키로만 실행되는 동작. 등록 자체는
  // 저위험(`commands`)이고, 그 명령이 실제로 하는 일은 `run` 안에서 부르는 호출들이 각자
  // 자기 권한 게이트를 탄다 — 명령이 권한 우회로가 되지 않는 이유가 여기 있다.
  "commands.register": "commands",
  "theme.register": "theme",
  "background.register": "background",
  "font.register": "font",
  // 주의(혼동 위험 — 이름 변경은 파급이 커서 보류, 문서 담당에게 요청사항으로 전달):
  // `window.register`(이 줄, 단수)는 "창 컨트롤 능력 선언"이라 저위험 `window-control`
  // 권한이고, 아래 `windows.open`(복수)은 "임의 창 열기"라 민감 `windows` 권한이다.
  // 한 글자(단수/복수) 차이로 권한 등급이 갈리므로 호출명을 오타·자동완성으로 섞어 쓰면
  // 의도와 다른 권한 검사 경로를 탈 수 있다.
  "window.register": "window-control",
  "settings.get": "settings",
  // 선언된 모든 키를 기본값 병합된 스냅샷 1개로 받는다 — get과 같은 권한(같은 데이터를
  // 한 번에 볼 뿐이라 권한 등급이 달라질 이유가 없다). 수행부는 central-host.ts.
  "settings.getAll": "settings",
  "settings.set": "settings",
  // 이벤트 구독. 여기 적힌 `settings`는 **바닥**이다 — 이 표는 호출 1개당 권한 1개만
  // 표현할 수 있는데, 실제 규칙은 이름별로 다르다(`note:*`는 민감한 `notes:read`,
  // `settings:changed`는 추가 권한 없음). 그래서 이름별 판정은 중앙 호스트의 수행부가
  // 같은 `checkPermission`으로 한 번 더 **좁혀서** 한다(어휘는 host-protocol.ts의
  // `MEMO_EVENT_PERMISSION`). 바닥을 `notes:read`로 두지 않은 이유: 그러면 자기 설정이
  // 바뀐 것만 듣고 싶은 플러그인이 노트 읽기 승인을 사용자에게 요구하게 된다.
  "events.on": "settings",
  // ── 플러그인 전용 저장소 ──────────────────────────────────────────────────
  // 넷 다 같은 저위험 `storage` 권한이다. 등급이 갈리지 않는 이유: 담기는 것이 전부 **그
  // 플러그인이 스스로 쓴 값**이라, 스코프를 나눠도 노출되는 정보의 **종류**가 달라지지
  // 않는다. 스코프가 나누는 축은 권한이 아니라 **수명**이다(local=영속 / session=재빌드까지 /
  // window=그 창까지) — 수명 비교표는 `api-index.ts`의 `MemoStorageScope`에 있다.
  //
  // **설계안(`memo.storage.local.get`)에서 바꾼 점**: 부트스트랩의 `memo` 프록시는 정확히
  // 2단(`memo.<ns>.<method>`)이라 `memo.storage.local`은 함수가 되고 그 위의 `.get`은
  // undefined다 — 3단 네임스페이스는 부트스트랩을 고쳐야 하고 그러면 CSP 해시 3곳이 함께
  // 움직인다. 스코프를 인자(`scope`)로 내리면 계약은 같고 실패 모드는 줄어든다.
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
  "storage.getAll": "storage",
  // 전체 노트 컬렉션 읽기는 `notes:read`(현재 노트 + 제목 목록)가 아니라 **별도 민감
  // 권한** `notes:all-read`다 — 기존 `notes:read` 승인의 의미를 소급 확대하지 않기 위한
  // 분리(decisions 문서 채택안 (b)+(c)). 수행부는 central-host.ts(호스트 스코프 — 창 컨텍스트
  // 불필요, Rust `note_list`/`note_read` IPC 재사용).
  "notes.list": "notes:all-read",
  "notes.read": "notes:all-read",
  "notes.current": "notes:read",
  "notes.write": "notes:write",
  // 현재 노트를 복제해 새 노트를 만들고 그 창을 연다 → 본문을 쓰므로 notes:write 게이트.
  "notes.duplicate": "notes:write",
  // 이 메모의 override(사이드카 메타)를 전역 기본값으로 되돌린다 → 노트 데이터를 다시 쓰므로
  // notes:write 게이트(notes.duplicate와 동급). 본문은 건드리지 않지만 권한은 본문 쓰기까지
  // 함께 부여됨 — 전용 권한을 새로 만들지 않고 기존 민감 게이트를 재사용한다.
  "notes.resetOptions": "notes:write",
  "vault.read": "vault:read",
  "vault.write": "vault:write",
  "clipboard.read": "clipboard",
  "clipboard.write": "clipboard",
  // 네트워크 중계 — 실제로 게이트하는 권한은 **URL 호스트에서 파생한** `network:<호스트>`라
  // 정적 표에 담을 수 없다(도메인마다 다르다). 여기 값은 문서·CLI 린트가 쓰는 **대표 표기**일
  // 뿐이고, 런타임 판정은 [`handleBridgeRequest`]가 `args.url`을 파싱해 [`networkTargetOf`]로
  // 뽑은 `network:<호스트>`로 한다(`embed:<도메인>`이 렌더 시점에 도메인별로 게이트되는 것과
  // 같은 결 — 다만 이쪽은 브리지 호출이라 표에 이름은 있어야 한다). `isSensitive("network:<도메인>")`
  // 는 접두로 참이라 등급·오류 코드 유도가 자동으로 민감으로 붙는다.
  "network.fetch": "network:<도메인>",
  "windows.open": "windows",
  // 링크를 시스템 기본 브라우저로 연다. 도메인별로 쪼개지 않은 이유는 `permissions.ts`의
  // `browser:open` 주석에 있다(열 주소가 노트 본문에서 오므로 승인 시점에 열거 불가).
  // 스킴 허용 목록(http·https·mailto)은 백엔드 `open_external_url`이 소유한다 — 여기서
  // 통과한 문자열도 거기서 다시 검사받는다.
  "browser.open": "browser:open",
  // 플러그인 간 명령 호출 — 실제로 게이트하는 권한은 **인자 pluginId에서 파생한**
  // `invoke:<대상>`이라 정적 표에 담을 수 없다(대상마다 다르다). 여기 값은 문서·CLI 린트가
  // 쓰는 **대표 표기**일 뿐이고, 런타임 판정은 [`handleBridgeRequest`]가 `args.pluginId`를
  // [`invokeTargetOf`]로 뽑은 `invoke:<대상>`으로 한다(`network.fetch`가 URL 호스트에서
  // 파생하는 것과 같은 결). `isSensitive("invoke:<대상>")`는 접두로 참이라 등급·오류 코드
  // 유도가 자동으로 민감으로 붙는다.
  "commands.invoke": "invoke:<pluginId>",
};

/** `commands.invoke`의 대상 파싱 결과 — 게이트할 대상 id/권한, 또는 거부 사유(안정 코드). */
type InvokeTarget =
  | { ok: true; targetId: string; commandId: string; permission: string }
  | { ok: false; code: MemoErrorCode; error: string };

/**
 * `commands.invoke`의 인자에서 대상 pluginId·commandId와 `invoke:<대상>` 권한을 뽑는다(순수).
 *
 * 역할: 게이트키퍼(런타임)·CLI 린트(정적)·문서가 **같은 규칙**으로 대상을 뽑게 하는 단일
 * 지점(`networkTargetOf`와 같은 결). pluginId·commandId가 비어있지 않은 문자열이어야 하고,
 * 통과하면 `invoke:<대상 id>` 권한으로 좁힌다. 형식 오류는 권한 판정 전에 `INVALID_ARGS`로
 * 끝낸다 — 대상이 자기 자신을 부르는 것(pluginId === 호출측)은 여기서 막지 않는다(자격은
 * 권한 게이트가, 순환은 중앙 호스트의 깊이 방어가 본다).
 */
export function invokeTargetOf(args: Record<string, unknown>): InvokeTarget {
  const targetId = args.pluginId;
  if (typeof targetId !== "string" || targetId === "") {
    return {
      ok: false,
      code: "INVALID_ARGS",
      error: "commands.invoke: pluginId가 필요합니다(비어있지 않은 문자열)",
    };
  }
  const commandId = args.commandId;
  if (typeof commandId !== "string" || commandId === "") {
    return {
      ok: false,
      code: "INVALID_ARGS",
      error: "commands.invoke: commandId가 필요합니다(비어있지 않은 문자열)",
    };
  }
  return {
    ok: true,
    targetId,
    commandId,
    permission: `invoke:${targetId}`,
  };
}

/** `network.fetch`의 URL 파싱 결과 — 게이트할 호스트/권한, 또는 거부 사유(안정 코드). */
type NetworkTarget =
  | { ok: true; host: string; permission: string }
  | { ok: false; code: MemoErrorCode; error: string };

/**
 * `network.fetch`의 `url` 인자에서 게이트할 호스트와 `network:<호스트>` 권한을 뽑는다(순수).
 *
 * 역할: 게이트키퍼(런타임)·CLI 린트(정적)·문서가 **같은 규칙**으로 호스트를 뽑게 하는 단일
 * 지점이다. (1) 문자열·비어있지 않음, (2) URL로 파싱, (3) https 전용, (4) 호스트 소문자화 후
 * `network:<host>`. https가 아니거나 파싱 실패면 권한 판정 전에 코드 붙은 거부를 돌려준다.
 * 왜: 백엔드(`net.rs`)도 스킴·호스트를 재검증하지만(TS 매칭만 믿지 않는 심층 방어), 권한
 * 매칭은 호스트가 정해져야 가능하므로 프론트가 먼저 같은 관문을 통과시킨다. 사설대역·DNS
 * 리바인딩·리다이렉트 같은 실제 SSRF 방어는 백엔드가 소유한다(여기서 흉내 내지 않는다).
 */
export function networkTargetOf(url: unknown): NetworkTarget {
  if (typeof url !== "string" || url === "") {
    return {
      ok: false,
      code: "INVALID_ARGS",
      error: "network.fetch: url이 필요합니다(비어있지 않은 문자열)",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      code: "NETWORK_INVALID_URL",
      error: `network.fetch: URL을 해석할 수 없습니다: ${url}`,
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "NETWORK_SCHEME",
      error: `network.fetch: https만 허용됩니다(요청 스킴: ${parsed.protocol.replace(/:$/, "")}): ${url}`,
    };
  }
  // hostname은 이미 정규화돼 있다(IPv6은 대괄호 포함, 유니코드는 punycode). 소문자화해 선언과의
  // 정확 매칭을 대소문자 무관하게 만든다(도메인은 대소문자를 구분하지 않는다).
  const host = parsed.hostname.toLowerCase();
  if (host === "") {
    return {
      ok: false,
      code: "NETWORK_INVALID_URL",
      error: `network.fetch: 호스트가 없습니다: ${url}`,
    };
  }
  return { ok: true, host, permission: `network:${host}` };
}

/**
 * 아직 실행 경로가 없는(=예약) 브리지 호출. `CALL_PERMISSIONS`에 권한은 배정돼 있지만
 * 실제로는 어떤 executor(등록 실행기 [`makeRegistrar`]·창-스코프 [`executeWindowCall`]·
 * 중앙 호스트가 직접 처리하는 `settings.get`/`settings.set`/`ui.addToolbarButton`)도 이
 * 호출을 인식하지 못한다 — 전수 조사 완료(프로덕션 executor 주입 경로는 `central-host.ts`
 * 두 곳뿐, 숨은 처리 지점 없음). 도달하면 `loader.ts`의 `지원하지 않는 호출` 오류로
 * 떨어지던 것을, 여기서 먼저 "미구현"이라고 명확히 밝히고 거부한다(오타·미구현 구분).
 *
 * 왜 예약인가(권한별):
 * - `editor.registerWidget` — 위젯 등록 API가 아직 없음(editor 권한은 다른 호출로 살아있다).
 * - `vault.read`, `vault.write` — 볼트 파일 접근 서비스가 아직 없음(vault:read·vault:write
 *   권한 자체가 완전히 죽어 있다).
 * - `clipboard.read` — 클립보드 읽기 서비스가 아직 없음(clipboard 권한은 write로 살아있다).
 * - `windows.open` — 임의 창 열기 API가 아직 없음(windows 권한 자체는 임베드
 *   `openByTitle`/`canOpen` 판정에서 직접 `checkPermission`으로 살아있다 — 이 브리지
 *   호출과는 별개 경로).
 *
 * **예약에서 풀린 것(·notes.write):**
 * - `ui.addMenuItem` — 「메뉴에만 있는 별도 항목」이 실장됐다. 등록 수집은 중앙 호스트
 *   수행부([`makeHostExecutor`]), 배달은 스냅샷의 `menuItems`, 렌더는 노트 창 컨텍스트
 *   메뉴다. `run`은 `payload.selectedText`를 받는데, 그 필드는 `notes:read`가 부여됐을 때만
 *   호스트가 채운다(payload 단위 게이트 — `ui` 권한만으로 본문이 새지 않는다).
 * - `notes.write` — 임의 노트 **직접 쓰기**(append/overwrite)가 실장됐다. **호스트 스코프**다
 *   (특정 창과 무관한 전역 데이터 쓰기라 창 컨텍스트가 필요 없다 — `notes.list`/`notes.read`와
 *   같은 결). 권한은 **기존 `notes:write`를 재사용**한다(별도 `notes:all-write`를 신설하지
 *   않은 이유는 `central-host.ts`의 `notes.write` 수행부 주석과 보고서 참고 — 요지: ① 권한
 *   목록이 TS·Rust·승인 UI·문서·스키마 5곳에 복제돼 드리프트 가드가 그 동치를 강제하므로 새
 *   권한은 소유 밖 파일 셋을 함께 고쳐야 하고, ② overwrite가 덮기 전에 스냅샷을 남겨
 *   복구 가능해져 예약 이유로 든 "복구 불가"가 해소됐다). 참고: 이 해제는
 *   재승인을 태우지 않는다 — `notes:write`는 `PERMISSION_RESERVED`에 든 적이 없어(늘
 *   `editor.insertText`로 부여 가능했다) 예약-보류(pendingReserved)로 남은 설치가 없다.
 */
export const RESERVED_CALLS: ReadonlySet<string> = new Set([
  "editor.registerWidget",
  "vault.read",
  "vault.write",
  "clipboard.read",
  "windows.open",
]);

/**
 * 호출에 필요한 권한을 판정하는지 여부와 무관하게 완전히 죽은 권한(유일한 호출이 예약).
 *
 * 설치 승인 UI가 이 권한을 요구하는 매니페스트에 "(예약)" 배지를 붙이는 데 쓴다 —
 * 사용자에게 승인을 요구해도 실제로 행사할 방법이 아직 없음을 알린다.
 *
 * **`commands`는 여기서 빠졌다.** 이 집합에서 빠지는 순간이 곧 pendingReserved의
 * 방아쇠다: 예약이던 시절에 승인된 설치는 `commands`가 부여 목록이 아니라 `pendingReserved`에
 * 남아 있고, 다음 실행에서 `reservedRegrant()`가 "이 집합에 더는 없는 권한"만 골라 재승인 행을
 * 띄운다. 그래서 이 줄을 지우는 것만으로 기존 설치가 자동으로 재승인 안내를 받는다 — 목록을
 * 손보는 사람은 그 연쇄가 있다는 것을 알고 있어야 한다.
 */
export const PERMISSION_RESERVED: ReadonlySet<string> = new Set([
  "vault:read",
  "vault:write",
]);

/** 호출이 예약(아직 미구현)인지. */
export function isReservedCall(call: string): boolean {
  return RESERVED_CALLS.has(call);
}

/**
 * **능력 등록** 호출 — 매니페스트 `kind: "capability"`를 선언한 플러그인만 통과한다.
 *
 * 역할: 이 집합이 kind 게이트의 **단일 어휘**다. 게이트([`handleBridgeRequest`])와 저작
 * 계약 인덱스(`api-index.ts`가 이 집합에서 `requiresKind`·병합 규칙을 파생)가 같은 값을
 * 읽으므로, "코드는 막는데 문서는 된다고 한다"가 구조적으로 불가능하다.
 * 왜: 이 네 호출은 스냅샷의 슬롯(또는 목록) 하나로 병합된다(theme=LastWins,
 * background=FirstWins, font·window=Union). 그래서 액션 플러그인이 불러도 게이트·registrar를
 * 통과한 뒤 조립 단계에서 **결과만 조용히 버려졌다** — 저작자는 성공 응답을 받고 아무 일도
 * 일어나지 않는다. 잡으려던 무음 실패가 정확히 이것이다.
 *
 * 언어팩(`contributes.translations`)도 `kind: "capability"`를 요구하지만 이 집합에 없다 —
 * 브리지 호출이 아니라 코어가 직접 읽는 데이터 선언이라 게이트 자체가 다른 곳
 * (`plugin_i18n.rs`의 `may_contribute_translations`)에 있다. 그쪽이 이 값과 같은 문자열을
 * 요구한다는 사실은 그 함수의 doc이 못박는다.
 *
 * **능력 등록은 `kind: "capability"`를 명시적으로 요구한다(엄격).** `kind`를 안 적었거나
 * `"action"`이면 능력 등록은 거부된다 — 미선언을 관용하면 능력 플러그인이 kind를 빠뜨린 채
 * 성공 응답을 받고 아무 일도 안 일어나는 무음 실패가 되살아난다. 능력을 등록하려면
 * 매니페스트에 `kind: "capability"`를 반드시 선언한다.
 */
export const CAPABILITY_CALLS: ReadonlySet<string> = new Set([
  "theme.register",
  "background.register",
  "font.register",
  "window.register",
]);

/**
 * **불안정(experimental) 호출** — 이름·권한·실행 경로는 전부 실재하지만(예약과 다르다),
 * 계약이 아직 굳지 않아 다음 사이클에 인자·반환·의미가 바뀔 수 있는 호출.
 *
 * 역할: 이 집합이 experimental 표식의 **단일 어휘**다. api-index(`experimental: true` 파생)와
 * 중앙 호스트의 진단(experimental 호출이 실행되면 진단 채널에 "이 API는 실험적이라 바뀔 수
 * 있음" 경고)이 같은 값을 읽으므로, "문서는 안정이라는데 런타임은 경고한다"가 구조적으로
 * 불가능하다.
 *
 * **왜 apiVersion과 다른가(죽은 무게가 아닌 이유):** 이 표식은 "선언만 되고 아무것도 안 하는"
 * 것이 아니다 — experimental 호출이 실제로 실행될 때마다 관측 가능한 진단 경고를 남긴다
 * (`central-host.ts`의 브리지 콜백). 저작자·AI는 "이 코드는 지금 동작하지만 다음 버전에서
 * 깨질 수 있다"를 앱을 띄우지 않고도 「최근 오류」에서 본다. 경고가 실제로 나지 않으면 이
 * 집합은 순수한 죽은 무게가 되므로, 여기 든 호출은 반드시 그 배선을 갖는다.
 *
 * **지금 든 것:** `commands.invoke`. 플러그인 간 호출은 이번 사이클에 처음 들어온 가장
 * 새 표면이고, 반환 계약(지금은 대상 명령을 **디스패치**하고 `null`을 준다 — 명령의
 * `run: (memo) => void`에 반환값이 없어 대상의 "결과"를 돌려줄 것 자체가 없다)과 인자 모양이
 * 실사용으로 검증되기 전이다. 안정으로 굳으면 이 집합에서 뺀다(그러면 경고도 저절로 멈춘다).
 */
export const EXPERIMENTAL_CALLS: ReadonlySet<string> = new Set([
  "commands.invoke",
]);

/** 호출이 불안정(experimental)한지 — 실행 경로는 있으나 계약이 아직 바뀔 수 있음. */
export function isExperimentalCall(call: string): boolean {
  return EXPERIMENTAL_CALLS.has(call);
}

/** 진단 로그 1건의 최대 길이(자) — 노트 본문이 통째로 실려 나가지 않게 하는 상한. */
const MAX_LOG_LEN = 2000;

/**
 * 권한이 필요 없는 호출(`memo.runtime.*`) — 권한 게이트 **앞에서** 호스트가 직접 처리한다.
 *
 * 왜 무권한인가: 실행 환경 introspection과 진단 로그는 어떤 특권도 행사하지 않는다. 여기에
 * 권한을 요구하면 "권한을 얻기 전에는 자기 부여 집합조차 물어볼 수 없는" 순환이 생긴다.
 * `granted`는 **자기 자신의** 부여 집합뿐이고 어차피 호출해 보면 알 수 있어 정보 이득이 0에
 * 가깝다(다른 플러그인의 부여는 절대 싣지 않는다).
 *
 * `CALL_PERMISSIONS`에 넣지 않는 이유: 그 표는 "권한 게이트를 타는 호출"의 단일 출처이고,
 * 드리프트 가드들이 그 표의 모든 키에 권한·번들 사용 커버리지를 요구한다. 무권한 호출을
 * 섞으면 그 가드들의 의미가 흐려진다 — 대신 이 집합을 별도 vocabulary로 둔다.
 */
export const NO_PERMISSION_CALLS: ReadonlySet<string> = new Set([
  // 부트스트랩이 로컬에서 가로채므로 정상 경로에서는 호스트에 도달하지 않는다(등록 마감
  // 선언은 브리지 왕복이 아니다). 여기 두는 것은 "아는 이름"의 어휘를 완전하게 하기 위함.
  "runtime.ready",
  "runtime.info",
  "runtime.log",
  // ready와 같은 이유로 부트스트랩이 로컬에서 가로챈다(정리 콜백은 샌드박스 안에 남아야
  // 하고, 호스트는 파괴 직전 `type: "dispose"` 한 번으로 실행시킨다). 여기 두는 것은
  // 「아는 이름」의 어휘를 완전하게 하기 위함이다(도달하면 무해한 no-op).
  "runtime.onDispose",
  // 활성 로케일 코드 조회(축 2) — `runtime.info()`의 `os`와 같은 결의 실행 환경 introspection
  // 이다(어떤 특권도 행사하지 않는다). 언어팩 기여(`contributes.translations`, 저위험 `i18n`
  // 권한 + kind:"capability" 필요)와 이름 네임스페이스만 같을 뿐 전혀 다른 성격이라 그 권한을
  // 재사용하지 않는다 — 그러면 "지금 로케일이 뭔지 알고 싶을 뿐인" 평범한 action 플러그인
  // (예: 날짜 형식을 로케일에 맞게 고르는 위젯)이 언어팩 전용 권한을 선언해야 하는
  // 부자연스러움이 생긴다. `os`·`hostVersion`처럼 값 자체가 민감하지 않다(설정 창 언어
  // 드롭다운에 이미 노출돼 있다).
  //
  // **`memo.i18n.register`는 없다.** 언어팩은 런타임 등록 API가 아니라 매니페스트 선언이다 —
  // 옛 이름을 부르면 `UNKNOWN_CALL`로 떨어지고 그 진단이 저작자에게 남는다.
  "i18n.locale",
]);

/** 브리지가 아는 호출 이름인지(권한 게이트 대상 ∪ 무권한) — 도구·린트의 단일 출처. */
export function isKnownCall(call: string): boolean {
  return call in CALL_PERMISSIONS || NO_PERMISSION_CALLS.has(call);
}

/**
 * **없어진 호출** → 저작자가 대신 해야 하는 것.
 *
 * 왜 필요한가: 이 이름들은 한때 실재했으므로 `알 수 없는 호출`이라는 기본 문구만으로는
 * "내가 오타를 냈나, API가 없어졌나"를 가릴 수 없다 — 진단 한 줄이 저작자의 유일한 단서인
 * 이 저장소에서 그 차이는 크다([`RESERVED_CALLS`]가 "아직 없다"를 말하는 것과 대칭으로,
 * 이 표는 "이제 없다 + 대신 이것"을 말한다). 어휘가 아니라 **문구**라 게이트 판정에는
 * 관여하지 않는다: 런타임 결과는 어느 쪽이든 `UNKNOWN_CALL` 거부다(새 `MemoErrorCode`를
 * 만들지 않는 이유 — 저작자가 분기할 대상이 아니라 읽을 안내다).
 *
 * **이 표의 키는 살아 있는 어휘 어디에도 있으면 안 된다**(`CALL_PERMISSIONS`·
 * `NO_PERMISSION_CALLS`·`RESERVED_CALLS`와 교집합 0). 겹치면 실제로는 동작하는 호출에
 * "없어졌다"고 안내하게 된다 — `drift-guards.test.ts`가 그 교집합을 가드로 고정한다.
 */
export const REMOVED_CALLS: Readonly<Record<string, string>> = {
  "i18n.register":
    '언어팩은 런타임 등록 API가 아니라 매니페스트 선언입니다 — 같은 `{locale,label,entries}`를 manifest.json의 `contributes.translations` 배열로 옮기고 `kind: "capability"`와 `i18n` 권한을 선언하세요(코어가 직접 읽습니다).',
};

/**
 * 없어진 호출이면 마이그레이션 안내를, 아니면 `undefined`를 준다([`isReservedCall`]과 같은
 * 결의 조회 헬퍼 — CLI가 표 자체가 아니라 이 함수를 계약으로 받는다).
 *
 * 왜 CLI에도 필요한가: `memo-plugin lint`는 저작자가 **가장 먼저** 돌리는 도구다. 런타임
 * 진단에만 안내를 배선하면, 앱을 띄우고 그 플러그인을 실행해 진단 채널까지 열어 본 사람만
 * 마이그레이션 방법을 알게 된다 — 정작 lint는 "존재하지 않는 호출: 오타이거나 아직 없는 API"
 * 라는, 이 경우엔 **틀린** 추측을 준다(오타도 아니고 아직 없는 것도 아니다).
 */
export function removedCallHint(call: string): string | undefined {
  return REMOVED_CALLS[call];
}

/**
 * 플러그인 실행 1건의 **정체**(중앙 호스트가 주입) — `runtime.info()` 응답과 **게이트 판정**이
 * 함께 읽는다.
 *
 * 왜 한 덩어리인가: 여기 실린 것은 전부 "이 실행이 무엇인가"(누가·어느 앱 버전에서)에 대한
 * 답이고, 그 답을 아는 곳은 중앙 호스트 한 곳뿐이다. 게이트가 매니페스트 사실(`kind`)을 별도
 * 인자로 또 받으면 주입 지점이 둘로 갈린다.
 */
export interface PluginRuntimeEnv {
  pluginId: string;
  /** 앱 버전(`tauri.conf.json`의 `version`) — 진단·경고용이지 기능 분기용이 아니다. */
  hostVersion: string;
  /** OS 식별자("macos"·"windows"·"linux"). 알 수 없으면 빈 문자열. */
  os: string;
  /**
   * 이 실행이 시작된 사유.
   *
   * **프로덕션에서 이 필드를 채우는 곳은 `central-host.ts`의 `build()` 하나이고 값은 언제나
   * `"reload"`다** — 설치/갱신 흐름은 `notes-reload` 방송 하나만 보내므로 호스트가 그 둘을
   * 구분할 근거를 갖지 못한다. 그래서 저작자 계약(`docs/plugin/api-reference.d.ts`)에는 `"reload"`
   * 하나로 좁혀 적는다(관측되지 않는 값을 타입으로 약속하지 않는다). 여기 유니온이 남아
   * 있는 것은 사유 전달 경로가 생겼을 때 이 타입부터 넓히지 않아도 되게 하는 여유다.
   */
  reason: "install" | "update" | "reload";
  /**
   * 매니페스트가 선언한 종류 — 능력 등록 게이트의 입력. 능력 등록은 `"capability"`를
   * **명시적으로** 요구한다(미선언·`"action"`이면 거부, [`CAPABILITY_CALLS`] 참고).
   */
  kind?: PluginKind;
  /**
   * 이 실행이 보는 활성 로케일 코드(축 2 — `memo.i18n.locale()`의 값). 중앙 호스트가
   * `build()`/단일 핫리로드마다 캐시를 갱신해 주입한다(`hostVersion`·`os`와 같은 캐싱 결 —
   * **이번 빌드 시작 시점**의 값으로 고정되고 다음 재빌드 전까지 바뀌지 않는다). 주지 않으면
   * (`env` 자체가 없는 테스트 등) `"ko"`로 취급한다.
   */
  locale?: string;
}

/**
 * 무권한 `runtime.*` 호출을 처리한다(게이트 통과 없이 호스트가 직접 응답).
 *
 * 역할: `info`는 실행 환경 스냅샷을, `log`는 진단 한 줄을, `ready`는 무해한 no-op을
 * 돌려준다.
 * 왜: 등록 마감·부여 집합·호스트 버전이 지금은 전부 관측 불가라, 저작자는 시행착오로
 * 배우고 AI는 배울 근거가 아예 없다.
 */
function handleRuntimeCall(
  grant: PluginGrant,
  request: BridgeRequest,
  env?: PluginRuntimeEnv,
): BridgeResponse {
  if (request.call === "runtime.info") {
    return {
      ok: true,
      result: {
        pluginId: env?.pluginId ?? "",
        hostVersion: env?.hostVersion ?? "",
        os: env?.os ?? "",
        reason: env?.reason ?? "reload",
        declared: [...grant.declared],
        granted: [...grant.granted],
      },
    };
  }
  if (request.call === "runtime.log") {
    const message = String(request.args?.message ?? "").slice(0, MAX_LOG_LEN);
    // 싱크는 둘이다: 호스트 콘솔(개발 중 실시간)과 플러그인별 진단 링버퍼(설정 창
    // 「최근 오류」). 링버퍼 기록은 게이트키퍼가 아니라 `central-host.ts`의 브리지 콜백이
    // 한다(진단 로그를 소유한 쪽이 거기다) — 이 함수는 순수하게 유지한다.
    console.info("[memo:plugin]", env?.pluginId ?? "", message);
    return { ok: true, result: null };
  }
  // runtime.ready: 부트스트랩이 가로채는 것이 정상이라 여기 오면 이미 마감된 뒤다 —
  // 오류로 만들 이유가 없다(멱등한 no-op).
  return { ok: true, result: null };
}

/** 브리지 요청(샌드박스 플러그인 → 호스트). */
export interface BridgeRequest {
  call: string;
  args?: Record<string, unknown>;
}

/** 브리지 응답(호스트 → 샌드박스 플러그인). */
export interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  /** 실패 시 기계용 안정 코드. 사람용 문구는 `error`. */
  code?: MemoErrorCode;
  error?: string;
}

/**
 * 호출에 필요한 권한을 매핑 표에서 구한다. 모르는 호출이면 null(→ 거부).
 *
 * `embed:<domain>` 권한은 브리지 호출이 아니라 렌더 시점에 검사된다 — 블록 임베드의
 * 최종 URL 도메인 게이트(blockEmbedField의 allowEmbedDomain)가 checkPermission으로 강제.
 */
export function requiredPermissionFor(call: string): string | null {
  return CALL_PERMISSIONS[call] ?? null;
}

/**
 * 창-스코프 호출이 **창 컨텍스트를 필수로** 요구했는지(공통 옵션 `requireWindow`).
 *
 * 역할: 컨텍스트가 없을 때 조용한 `null` 대신 `CONTEXT_UNAVAILABLE` 거부를 원하는
 * 호출인지 판정한다(옵트인).
 * 왜: 지금은 "토큰 없음/모르는 토큰"이 `ok:true, result:null`로 감싸져 **성공과 구분되지
 * 않는다**. 부팅 시점에 `ui.toast`를 부른 플러그인은 성공 응답을 받고 아무 일도 일어나지
 * 않는다 — 눈이 없는 AI 저작자에게 치명적인 무음 실패다.
 */
export function requiresWindowContext(args: Record<string, unknown>): boolean {
  return args.requireWindow === true;
}

/** 창 컨텍스트 부재의 표준 거부 오류 — 라우팅 실패를 테스트 가능한 신호로 만든다. */
export function contextUnavailableError(call: string): MemoCallError {
  return bridgeError(
    "CONTEXT_UNAVAILABLE",
    `창 컨텍스트 없음(requireWindow): ${call}`,
  );
}

/**
 * 브리지 요청을 처리한다: 권한 검사를 통과할 때만 executor로 라우팅한다.
 *
 * 거부(미선언·미부여·알 수 없는 호출) 시 executor를 호출하지 않고 오류 응답을 돌려준다.
 * executor가 던지면 오류 응답으로 감싼다(샌드박스에 예외가 새지 않게). 모든 거부에는
 * 기계용 안정 코드([`MemoErrorCode`])가 함께 실린다 — 기존 `error` 문구는 그대로 유지되므로
 * 문구를 보던 테스트·UI는 변하지 않는다.
 *
 * `env`(선택)는 이 실행의 정체([`PluginRuntimeEnv`])다 — `runtime.info` 응답을 채울 뿐 아니라
 * **kind 게이트 판정에도 쓰인다**(`kind` → 능력 등록 허용 여부). 능력 등록은 `kind`가
 * `"capability"`일 때만 통과하므로, `env`를 주지 않으면(kind 미상) 능력 등록은 거부된다.
 */
export async function handleBridgeRequest(
  grant: PluginGrant,
  request: BridgeRequest,
  execute: (call: string, args: Record<string, unknown>) => Promise<unknown>,
  env?: PluginRuntimeEnv,
): Promise<BridgeResponse> {
  // 무권한 호출은 권한 게이트 앞에서 호스트가 직접 처리한다 — 어떤 특권도 행사하지
  // 않으므로 매니페스트 선언을 요구하지 않는다. `i18n.locale`은 `runtime.*`와 이름
  // 네임스페이스만 다를 뿐 같은 성격(실행 환경 introspection)이라 여기서 함께 가로챈다 —
  // `handleRuntimeCall`은 `runtime.*` 세 호출의 계약만 지고 있으므로 이름을 넓히지 않는다.
  if (request.call === "i18n.locale") {
    return { ok: true, result: env?.locale ?? "ko" };
  }
  if (NO_PERMISSION_CALLS.has(request.call)) {
    return handleRuntimeCall(grant, request, env);
  }
  // 예약 호출은 권한 판정 전에 명시적으로 거부한다 — "알 수 없는 호출"(오타)과 구분되는
  // "아직 지원하지 않음"(계획됐지만 미구현) 오류를 준다.
  if (isReservedCall(request.call)) {
    return {
      ok: false,
      code: "RESERVED_CALL",
      error: `아직 지원하지 않는 예약 호출: ${request.call}`,
    };
  }
  // 능력 등록은 kind 게이트를 **권한 판정보다 먼저** 통과해야 한다. 순서가 중요하다:
  // 뒤에 두면 `theme` 권한을 안 적은 액션 플러그인이 PERMISSION_UNDECLARED를 받고, 권한을
  // 채워 넣은 뒤에야 진짜 원인(kind)을 만난다 — 저작자를 두 번 헛돌게 한다. `"capability"`를
  // **명시적으로** 선언한 플러그인만 통과한다(미선언·`"action"` 모두 거부 — 엄격).
  if (CAPABILITY_CALLS.has(request.call) && env?.kind !== "capability") {
    return {
      ok: false,
      code: "WRONG_PLUGIN_KIND",
      error: `능력 등록은 매니페스트 kind가 "capability"인 플러그인만 할 수 있습니다: ${request.call}`,
    };
  }
  // network.fetch는 게이트할 권한이 **URL 호스트에서 파생**한다(정적 표에 없다). URL·
  // 스킴을 여기서 먼저 판정해(심층 방어 1차 — 백엔드가 재검증) `network:<호스트>`로 좁힌 뒤
  // 일반 권한 검사에 태운다. 파싱·스킴 실패는 권한 판정 전에 코드 붙은 거부로 끝낸다.
  let required: string;
  if (request.call === "network.fetch") {
    const target = networkTargetOf((request.args ?? {}).url);
    if (!target.ok) {
      return { ok: false, code: target.code, error: target.error };
    }
    required = target.permission;
  } else if (request.call === "commands.invoke") {
    // commands.invoke는 `network.fetch`와 같은 유도 권한이다: 게이트할 권한이 인자(pluginId)에서 나온다.
    // 형식(pluginId·commandId)을 여기서 먼저 판정해 `invoke:<대상>`으로 좁힌 뒤 일반 권한
    // 검사에 태운다. 형식 실패는 권한 판정 전에 코드 붙은 거부로 끝낸다.
    const target = invokeTargetOf(request.args ?? {});
    if (!target.ok) {
      return { ok: false, code: target.code, error: target.error };
    }
    required = target.permission;
  } else {
    const staticRequired = requiredPermissionFor(request.call);
    if (staticRequired === null) {
      const removed = removedCallHint(request.call);
      return {
        ok: false,
        code: "UNKNOWN_CALL",
        error:
          removed === undefined
            ? `알 수 없는 호출: ${request.call}`
            : `없어진 호출: ${request.call} — ${removed}`,
      };
    }
    required = staticRequired;
  }
  const decision = checkPermission(grant, required);
  if (!decision.allowed) {
    return {
      ok: false,
      code: permissionDenialCode(grant, required),
      error: decision.reason,
    };
  }
  try {
    const result = await execute(request.call, request.args ?? {});
    return { ok: true, result };
  } catch (e) {
    // 코드가 붙지 않은 실행부 예외는 `code`를 **아예 싣지 않는다** — "호스트가 분류한 오류"와
    // "아직 분류되지 않은 오류"를 응답 수준에서 구분하기 위함. 샌드박스 쪽에서는 부트스트랩이
    // 없는 code를 "UNKNOWN"으로 채우므로, 저작자가 보는 `err.code`는 언제나 문자열이다.
    const code = errorCodeOf(e);
    return {
      ok: false,
      ...(code === undefined ? {} : { code }),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
