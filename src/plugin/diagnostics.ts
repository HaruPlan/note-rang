/**
 * 플러그인 런타임 진단 채널 — **조용히 실패하던 것**을 저작자가 볼 수 있는 기록으로 바꾼다.
 *
 * 역할: 중앙 호스트가 런타임에 관측한 실패(거부된 브리지 호출·창 컨텍스트가 없어 무력화된
 * 호출·설정 저장 거부)와 플러그인이 스스로 남긴 `memo.runtime.log`를 플러그인별 링버퍼에
 * 모으고, 설정 창이 이벤트로 읽어 「최근 오류」로 보여 준다.
 * 왜: 플러그인은 불투명 origin iframe에서 도는 blob 스크립트라 devtools를 붙일 수 없고,
 * 브리지 거부는 `.catch()`를 걸지 않으면 흔적이 0이다(번들 18개 중 `.catch()`를 건 것이 0개).
 * 저작자에게도 나쁘지만, 화면을 못 보는 AI에게는 **피드백 루프 자체가 없다**는 뜻이라 치명적이다.
 *
 * **인자(args)는 절대 싣지 않는다.** 호출명·오류코드·메시지만 담는다 — 노트 본문이 인자로
 * 실려 나가는 유출 경로를 원천 차단하기 위함이다. 메시지는 [`MAX_DIAGNOSTIC_MESSAGE_LEN`]로,
 * 호출명은 [`MAX_DIAGNOSTIC_CALL_LEN`]로, 오류 코드는 [`MAX_DIAGNOSTIC_CODE_LEN`]로 자르고
 * (셋 다 플러그인이 만든 문자열일 수 있어 상한 없이 받으면 상주 호스트의 메모리가 무한히
 * 자란다), 기록은 **메모리에만** 둔다(디스크 미기록 — 앱을 끄면 사라진다).
 *
 * 이벤트 이름을 `host-protocol.ts`가 아니라 여기 두는 이유: 진단은 스냅샷(빌드 시점의 불변
 * 값)이 아니라 **런타임 내내 자라는 기록**이라 스냅샷 프로토콜과 수명이 다르다. 스냅샷에
 * 실으면 재빌드 전까지 갱신되지 않아 "방금 난 오류"를 볼 수 없다.
 */

/** 진단 1건의 종류(닫힌 열거 — 새 종류는 여기 추가하고 설정 창 라벨도 함께 넣는다). */
export type DiagnosticKind =
  /** 브리지 호출이 거부됨(권한·알 수 없는 호출·실행부 예외·창 응답 실패). */
  | "call-reject"
  /** 창-스코프 호출인데 대상 창 컨텍스트가 없어 아무 일도 일어나지 않음(조용한 null). */
  | "no-window-context"
  /** 설정 저장이 백엔드에서 거부됨(브리지 응답은 성공이었는데 실제 저장이 실패). */
  | "setting-write-rejected"
  /** 매니페스트에 선언하지 않은 설정 키에 쓰기를 시도함(백엔드가 버린다). */
  | "setting-key-undeclared"
  /**
   * 같은 id로 다시 등록해 앞의 등록을 **치환**함(툴바 버튼·인라인 패턴·자동완성·임베드).
   *
   * 왜 기록하는가: 치환(upsert)은 옳은 동작이지만, 복사-붙여넣기로 id를 안 바꾼
   * 저작자에게는 "버튼 두 개를 등록했는데 하나만 뜬다"로 보인다 — 이유가 남지 않으면
   * 저작자는 자기 코드가 아니라 호스트를 의심하며 시간을 태운다.
   */
  | "duplicate-registration"
  /** 샌드박스 안에서 역호출된 핸들러(툴바 버튼 onClick 등)가 동기 예외로 죽음. */
  | "onclick-throw"
  /** 샌드박스 안에서 아무도 `.catch`를 걸지 않은 프라미스가 거부됨. */
  | "unhandled-rejection"
  /** 플러그인이 `memo.runtime.log`로 스스로 남긴 줄. */
  | "log"
  /**
   * 실험적(experimental) API 호출이 실제로 실행됨 — 거부가 아니라 **경고**다: 지금은
   * 동작하지만 다음 버전에서 인자·반환·의미가 바뀔 수 있다. 호스트가 자기 눈으로 본 사실이라
   * 샌드박스 화이트리스트에는 넣지 않는다(플러그인이 사칭할 수 없다).
   */
  | "experimental-call";

/**
 * **샌드박스가 스스로** 보고할 수 있는 진단 종류(부트스트랩의 `type: "diagnostic"` 메시지).
 *
 * 왜 화이트리스트인가: 이 값은 신뢰 경계 **밖**(불투명 origin iframe)에서 온 문자열이라,
 * 그대로 받으면 플러그인이 `"call-reject"`처럼 **호스트가 관측한 사실**을 사칭하는 기록을
 * 만들어 낼 수 있다(저작자·사용자가 「최근 오류」에서 진짜와 구분할 방법이 없다). 호스트가
 * 자기 눈으로 본 것(거부·창 없음·설정 저장)은 여기 넣지 않는다.
 */
const SANDBOX_DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = [
  "onclick-throw",
  "unhandled-rejection",
];

/** 샌드박스가 보고한 `kind`가 위 화이트리스트에 있는가(신뢰 경계 검사). */
export function isSandboxDiagnosticKind(
  value: unknown,
): value is DiagnosticKind {
  return (
    typeof value === "string" &&
    (SANDBOX_DIAGNOSTIC_KINDS as readonly string[]).includes(value)
  );
}

/** 진단 1건(플러그인별 링버퍼의 원소). */
export interface PluginDiagnostic {
  pluginId: string;
  /** 기록 시각(에폭 ms) — 설정 창이 시:분:초로 표시한다. */
  at: number;
  kind: DiagnosticKind;
  /** 관련 브리지 호출명(있을 때만 — 예 `ui.toast`). */
  call?: string;
  /** 기계용 안정 오류 코드(의 `MemoErrorCode`와 같은 어휘). */
  code?: string;
  /** 사람이 읽는 한 줄(플러그인이 만든 문자열일 수 있다 — 렌더는 반드시 textContent로). */
  message: string;
}

/**
 * 플러그인 1개가 보관하는 진단 최대 건수.
 *
 * 왜 100인가: 진단은 상주 호스트가 앱 수명 내내 모으므로 상한이 없으면 무한히 자란다.
 * 저작자가 실제로 보는 것은 "방금 무슨 일이 났나"이므로 최근 것이 남아야 하고(오래된 것부터
 * 버린다), 100건이면 부팅 시 등록 실패 폭주(수십 건)를 통째로 담고도 남는다. 플러그인
 * **당** 상한이라 시끄러운 플러그인 하나가 다른 플러그인의 기록을 밀어내지 못한다.
 */
export const MAX_DIAGNOSTICS_PER_PLUGIN = 100;

/**
 * 진단 메시지 1건의 최대 길이(자).
 *
 * 왜: throw된 값·스택에 노트 본문이 우연히 섞일 수 있다. 인자를 아예 싣지 않는 것이 1차
 * 방어이고, 이 상한이 2차 방어다(호스트 `runtime.log`의 상한과 같은 값).
 */
export const MAX_DIAGNOSTIC_MESSAGE_LEN = 2000;

/**
 * 진단 1건이 보관하는 **호출명**의 최대 길이(자).
 *
 * 왜 따로 두는가: `call`은 플러그인이 postMessage로 실어 보낸 원문이다. `memo.a.b()` 대신
 * `memo[거대한문자열][또다른거대한문자열]()`로 부르면 그 문자열이 그대로 호출명이 되고,
 * 게이트키퍼가 `UNKNOWN_CALL`로 즉시 거부하면서(권한이 없어도 누구나 가능하다) 원문이
 * 링버퍼에 그대로 쌓인다 — 건수 상한(플러그인당 100)은 있어도 **건당 크기 상한이 없어**
 * 상주 호스트의 메모리가 기가 단위로 자랄 수 있었고, 「최근 오류」를 여는 순간 그 값이
 * 통째로 이벤트에 직렬화돼 설정 창까지 멈춘다. 실제 호출명은 `ns.method` 형태의 짧은
 * 식별자라 200자면 진단 가독성에 충분하다(잘린 값이라도 원인 추적에는 남는다).
 */
export const MAX_DIAGNOSTIC_CALL_LEN = 200;

/**
 * 진단 1건이 보관하는 **오류 코드**의 최대 길이(자).
 *
 * 왜 코드에도 상한이 필요한가: `code`는 호스트가 붙인 [`MemoErrorCode`]만 오는 자리처럼
 * 보이지만, 샌드박스가 스스로 보고하는 진단(`onclick-throw`·`unhandled-rejection`)에서는
 * **플러그인이 throw한 Error의 `.code` 프로퍼티**가 그대로 실려 온다(부트스트랩의
 * `sendDiagnostic`). 즉 `call`과 똑같이 신뢰 경계 밖 문자열이라, 상한이 없으면
 * `e.code = "A".repeat(5_000_000)`를 던지는 플러그인 하나가 건수 상한(100건) 안에서도
 * 수백 MB를 상주 호스트에 눌러앉히고, 「최근 오류」를 여는 순간 그 값이 통째로 이벤트에
 * 직렬화돼 설정 창까지 멈춘다. 실제 코드는 `PERMISSION_UNDECLARED` 같은 짧은 식별자라
 * 100자면 남고, 잘린 값이라도 원인 추적에는 충분하다.
 */
export const MAX_DIAGNOSTIC_CODE_LEN = 100;

/** 진단 기록기(플러그인별 링버퍼) — 중앙 호스트가 하나 만들어 수명 내내 소유한다. */
interface DiagnosticsLog {
  /** 1건 기록(메시지 절단·상한 초과 시 가장 오래된 것 폐기). */
  record(entry: Omit<PluginDiagnostic, "at"> & { at?: number }): void;
  /** 전체 기록을 시간순(오래된 것 → 최근)으로 평탄화해 돌려준다. */
  list(): PluginDiagnostic[];
  /** 한 플러그인의 기록만 돌려준다(설정 창 상세용). */
  forPlugin(pluginId: string): PluginDiagnostic[];
}

/**
 * 진단 기록기를 만든다(순수 — 시계만 주입).
 *
 * 폐기 정책: 플러그인별 FIFO. 컨텍스트 토큰(LRU + 진행 중 보호)과 달리 진단은 "최근 순서"
 * 자체가 정보라 승급 개념이 없다 — 오래된 것이 그냥 밀려난다.
 */
export function createDiagnosticsLog(
  now: () => number = () => Date.now(),
): DiagnosticsLog {
  const byPlugin = new Map<string, PluginDiagnostic[]>();
  return {
    record: (entry) => {
      const pluginId = entry.pluginId || "(unknown)";
      const bucket = byPlugin.get(pluginId) ?? [];
      bucket.push({
        pluginId,
        at: entry.at ?? now(),
        kind: entry.kind,
        // 호출명·오류 코드도 메시지와 같은 이유로 자른다 — 신뢰 경계 밖 원문이 상한 없이
        // 들어오면 링버퍼 건수 상한이 있어도 메모리가 무한히 자란다.
        ...(entry.call
          ? { call: entry.call.slice(0, MAX_DIAGNOSTIC_CALL_LEN) }
          : {}),
        ...(entry.code
          ? { code: entry.code.slice(0, MAX_DIAGNOSTIC_CODE_LEN) }
          : {}),
        message: String(entry.message ?? "").slice(
          0,
          MAX_DIAGNOSTIC_MESSAGE_LEN,
        ),
      });
      // 상한 초과분은 앞에서 버린다(가장 오래된 것부터).
      if (bucket.length > MAX_DIAGNOSTICS_PER_PLUGIN) {
        bucket.splice(0, bucket.length - MAX_DIAGNOSTICS_PER_PLUGIN);
      }
      byPlugin.set(pluginId, bucket);
    },
    list: () => [...byPlugin.values()].flat().sort((a, b) => a.at - b.at),
    forPlugin: (pluginId) => [...(byPlugin.get(pluginId) ?? [])],
  };
}

/** 진단 조회 요청(설정 창 → 중앙 호스트). */
export const EV_DIAGNOSTICS_GET = "plugin-diagnostics-get";
/** 진단 조회 응답(중앙 호스트 → 요청한 창). */
export const EV_DIAGNOSTICS = "plugin-diagnostics";

/** [`EV_DIAGNOSTICS_GET`] 페이로드 — 요청/응답 상관용 id. */
export interface DiagnosticsGetPayload {
  requestId: string;
}

/** [`EV_DIAGNOSTICS`] 페이로드. */
export interface DiagnosticsPayload {
  requestId: string;
  diagnostics: PluginDiagnostic[];
}

/** 진단 조회 상한(ms) — 호스트가 무응답이면 빈 목록으로 진행한다(설정 창을 막지 않는다). */
const DIAGNOSTICS_BUDGET_MS = 2000;

/**
 * 중앙 호스트에 진단 기록을 요청한다(응답 없으면 빈 목록).
 *
 * 스냅샷과 달리 **재시도 폴링을 하지 않는다**: 진단은 상세 뷰의 부가 정보라, 호스트가 아직
 * 안 떴으면 다음에 다시 열 때 받으면 그만이다(설정 창을 기다리게 만들 이유가 없다).
 */
export function fetchPluginDiagnostics(opts: {
  bus: {
    emit(event: string, payload?: unknown): void;
    listen(event: string, handler: (payload: unknown) => void): () => void;
  };
  budgetMs?: number;
}): Promise<PluginDiagnostic[]> {
  const requestId = `diag-${Math.random().toString(36).slice(2)}`;
  return new Promise<PluginDiagnostic[]>((resolve) => {
    let done = false;
    const finish = (value: PluginDiagnostic[]) => {
      if (done) return;
      done = true;
      clearTimeout(budget);
      unlisten();
      resolve(value);
    };
    const unlisten = opts.bus.listen(EV_DIAGNOSTICS, (payload) => {
      const p = payload as DiagnosticsPayload | null;
      if (!p || p.requestId !== requestId) return;
      finish(Array.isArray(p.diagnostics) ? p.diagnostics : []);
    });
    const budget = setTimeout(
      () => finish([]),
      opts.budgetMs ?? DIAGNOSTICS_BUDGET_MS,
    );
    opts.bus.emit(EV_DIAGNOSTICS_GET, { requestId });
  });
}
