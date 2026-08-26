/**
 * 플러그인 중앙 호스트 — 숨김 상주 창에서 활성 플러그인마다 샌드박스를 **1회만**
 * 실행·소유하고, 수집한 디스크립터 스냅샷을 노트 창들에 배달한다.
 *
 * 역할: (1) 번들+설치 활성 플러그인을 격리 샌드박스에서 실행하고 등록 호출을
 * 게이트키퍼([`handleBridgeRequest`])로 검사해 디스크립터를 수집한다(권한 enforcement는
 * 여기 한 곳). (2) 활성 테마 플러그인을 일시 샌드박스로 실행해 [`ThemeDescriptor`]를
 * 얻는다. (3) 노트 창의 스냅샷 요청([`EV_SNAPSHOT_GET`])에 응답하고, 버튼 클릭
 * ([`EV_BUTTON_INVOKE`])을 해당 샌드박스로 역호출하며, 플러그인의 창-스코프 특권 호출
 * (toast·글자 델타·클립보드·현재 노트)은 그 호출을 낳은 클릭의 창으로 위임한다(클릭마다
 * 발급한 불투명 컨텍스트 토큰으로 되짚는다 — 창이 여러 개여도 섞이지 않는다).
 * (4) 설정 변경 방송(`notes-reload`)을 받으면 샌드박스를 전부 재빌드하고
 * [`EV_HOST_UPDATED`]로 열린 창들에 알린다. (5) 노트 창의 생명주기 이벤트([`EV_PLUGIN_EVENT`])와
 * 설정 값 변경([`EV_PLUGIN_SETTING_CHANGED`])을 **그 이름을 구독한 플러그인에게만** 역호출하고
 * , 재빌드로 샌드박스를 파괴하기 직전에 `runtime.onDispose` 정리 기회를 준다.
 * 왜: 기존에는 노트 창마다 샌드박스를 N×M개 띄웠다 — 실행 주체를 상주 창 하나로 모아
 * 창 수와 무관하게 플러그인당 1개로 고정한다(성능 최적화, 승인 계획서 후속 항목).
 */
import { checkPermission, isSensitive, type PluginGrant } from "./permissions";
import {
  buildSettingsSnapshot,
  checkCommandTitle,
  checkEventExtraPermission,
  checkEventName,
  resolveSettingsGetArg,
} from "./host-executor-validators";
import {
  bridgeError,
  CALL_PERMISSIONS,
  contextUnavailableError,
  handleBridgeRequest,
  invokeTargetOf,
  isExperimentalCall,
  requiresWindowContext,
  type MemoCallError,
  type MemoErrorCode,
  type PluginRuntimeEnv,
} from "./host";
import {
  CONTRIBUTION_CALLS,
  CONTRIBUTION_KINDS,
  parseManifest,
  type PluginContributions,
  type PluginKind,
} from "./manifest";
import {
  createDiagnosticsLog,
  EV_DIAGNOSTICS,
  EV_DIAGNOSTICS_GET,
  type DiagnosticsGetPayload,
} from "./diagnostics";
import type { PluginSettingField } from "../shared/tauri";
import {
  fromPluginSettingValue,
  mergeSettingDefaults,
  toPluginSettingValue,
} from "../shared/plugin-settings";
import { createPluginSandbox } from "./sandbox";
import { BUILTIN_PLUGINS, type BuiltinPlugin } from "./builtin";
import {
  autoRegistrationId,
  bindPluginSettings,
  evaluateStaticWhen,
  makeRegistrar,
  normalizeToolbarPosition,
  parseWhenClause,
  prepareInstalledPlugin,
  WINDOW_WHEN_KEYS,
  type InstalledPluginSource,
  type WhenTerm,
} from "./loader";
import { resolveThemeSource } from "../theme/active-theme";
import { isSupportedOnPlatform } from "./platform";
import { t } from "../i18n/t";
import { SJ_D, baseThemeName, type ThemeDescriptor } from "../theme/theme";
import {
  mergeFontFamilies,
  systemFontFamilies,
  type FontDescriptor,
} from "../theme/font";
import {
  EV_BUTTON_INVOKE,
  EV_HOST_PLUGIN_UPDATED,
  EV_HOST_UPDATED,
  EV_NOTE_RESTORED,
  EV_NOTES_RELOAD,
  EV_PLUGIN_DEV_RELOAD,
  EV_PLUGIN_EVENT,
  EV_PLUGIN_SETTING_CHANGED,
  EV_SNAPSHOT,
  EV_SNAPSHOT_GET,
  EV_TRAY_INVOKE,
  EV_WINDOW_CALL,
  EV_WINDOW_RESULT,
  isMemoEventName,
  parseRebuildReasons,
  type ButtonInvokePayload,
  type HostEventBus,
  type HostSnapshot,
  type MemoEventName,
  type NoteEventPayload,
  type PluginDevReloadPayload,
  type PluginFailure,
  type PluginSettingChangedPayload,
  type PluginSnapshot,
  type RebuildReason,
  type SnapshotGetPayload,
  type SnapshotMenuItem,
  type SnapshotSelectionAction,
  type SnapshotStatusItem,
  type SnapshotToolbarButton,
  type SnapshotTrayItem,
  type TrayInvokePayload,
  type TrayItemDescriptor,
  type WindowResultPayload,
} from "./host-protocol";
import { parseSelectionMatch, type SelectionMatch } from "./selection-action";
import { sameNameSet, sliceHasCapabilities } from "./snapshot-diff";

/** 창-스코프 호출의 노트 창 응답 대기 상한(ms) — 창이 닫혔거나 응답이 없으면 실패 처리. */
const WINDOW_CALL_TIMEOUT_MS = 5000;

/** 창-스코프(호출한 노트 창으로 위임해야 하는) 브리지 호출 집합. */
const WINDOW_SCOPED_CALLS = new Set([
  "ui.toast",
  // 상태 아이템의 라이브 텍스트 갱신 — 등록(addStatusItem)은 호스트 스코프에서 스냅샷에
  // 모이지만, 갱신은 **그 값을 보여줄 창**의 것이라 toast와 같은 창-스코프 위임이다(단어 수는
  // 창마다 다르다). 이 집합에 없으면 registrar로 잘못 흘러 조용히 아무 일도 안 한다.
  "ui.updateStatusItem",
  "ui.pickList",
  "ui.prompt",
  "editor.getFontDelta",
  "editor.setFontDelta",
  "editor.insertText",
  "clipboard.write",
  "notes.current",
  "notes.duplicate",
  // notes.resetOptions는 창-스코프다(옵션 초기화는 대상 노트 창이 수행). 이 집합에 없으면
  // registrar로 잘못 흘러 조용히 아무 일도 안 한다.
  "notes.resetOptions",
]);

/**
 * 대화형(사용자 응답을 기다리는) 창-스코프 호출 — 5초 대신 긴 상한을 준다. 팝업이
 * 선택/취소/언마운트 시 즉시 회신하므로 실제로는 안 닿는 "죽은 창" 누수 방지용 상한이다.
 */
/**
 * 플러그인 전용 저장소의 스코프 어휘 — **수명이 다른 세 서랍**이다.
 *
 * | 스코프    | 사는 곳                        | 사라지는 때                    |
 * | --------- | ------------------------------ | ------------------------------ |
 * | `local`   | 디스크(`plugin-storage/<id>.json`) | 사용자가 지울 때까지(재빌드에도 생존) |
 * | `session` | 중앙 호스트 프로세스 메모리    | 중앙 호스트 창이 죽을 때(앱 종료) |
 * | `window`  | 창 컨텍스트 토큰으로 격리된 메모리 | 그 창을 다시 안 볼 때          |
 *
 * export하는 이유: 저작 계약(`api-index.ts`)이 이 어휘를 그대로 실어 `MemoStorageScope`를
 * 만든다 — 값을 두 곳에 적으면 반드시 갈라진다.
 */
export const STORAGE_SCOPES = ["local", "session", "window"] as const;

/** 저장소 스코프(=[`STORAGE_SCOPES`]의 원소). */
type StorageScope = (typeof STORAGE_SCOPES)[number];

/** 신뢰 경계 밖 값이 아는 스코프인지(모르는 값은 기본값으로 흡수하지 않고 거부한다). */
function isStorageScope(value: unknown): value is StorageScope {
  return (
    typeof value === "string" &&
    (STORAGE_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * 저장소 호출의 `scope` 인자를 닫힌 열거로 읽는다(생략하면 `local`, 모르는 값이면 null).
 *
 * 왜 셋을 따로 두는가(scope·key·value): 네 호출이 **읽는 인자가 서로 다르다**(`getAll`은
 * key도 value도 안 본다). 하나로 묶으면 저작 계약의 드리프트 가드가 "getAll이 value를
 * 읽는다"고 믿게 되어, 계약에 없는 인자를 억지로 선언해야 한다 — 함수 경계를 실제 인자
 * 경계에 맞추면 그 거짓말이 필요 없다.
 */
function readStorageScope(args: Record<string, unknown>): StorageScope | null {
  // 오타를 기본값(local)으로 흡수하면 "저장은 됐는데 다른 서랍에 들어갔다"가 되어 값이
  // 영원히 안 보인다(무음 손상) — 모르는 값은 거부한다.
  const scope = args.scope === undefined ? "local" : args.scope;
  return isStorageScope(scope) ? scope : null;
}

/** 저장소 호출의 `key` 인자(빈 문자열이면 호출부가 거부 — 서로 다른 저장이 겹치지 않게). */
function readStorageKey(args: Record<string, unknown>): string {
  return String(args.key ?? "");
}

/** 저장소 호출의 `value` 인자(undefined는 JSON에 없는 값이라 null로 굳힌다). */
function readStorageValue(args: Record<string, unknown>): unknown {
  return args.value ?? null;
}

/** `storage.window` 서랍의 상한((플러그인 × 창) 조합 수) — 넘으면 가장 오래된 것부터 버린다. */
const MAX_WINDOW_STORES = 64;

/**
 * 용량 초과 오류 문구의 정본 접두어 — **Rust `plugin_storage::QUOTA_EXCEEDED_PREFIX`와 같은
 * 문자열**이다(어긋나면 `drift-guards.test.ts`가 실패한다).
 *
 * 왜 문자열을 보는가: 이 크레이트의 Tauri 커맨드는 전부 `Result<T, String>`이라 거부가
 * `code` 없는 문자열로 건너온다. 그대로 흘리면 부트스트랩이 `UNKNOWN`으로 채워, 계약이
 * 약속한 `err.code === "QUOTA_EXCEEDED"` 가지가 영원히 안 도는 죽은 코드가 된다.
 * `plugins.rs`의 "선언되지 않은 설정 키: "를 진단으로 분기하는 것과 같은 관례다.
 */
const QUOTA_EXCEEDED_PREFIX = "저장소 용량 초과";

/**
 * 메모리 스코프(`session`·`window`) 서랍 하나의 용량 상한(바이트, 압축 JSON 기준).
 *
 * 왜 디스크와 같은 값인가: `local`은 Rust가 256KB에서 거부하는데(`plugin_storage.rs`의
 * `MAX_STORAGE_BYTES`) 메모리 두 스코프에만 상한이 없으면, `storage` 권한(저위험 — 사용자
 * 승인 없이 선언만으로 통과)을 가진 플러그인 하나가 큰 값을 반복 저장해 **모든 창이 공유하는
 * 상주 중앙 호스트**를 OOM으로 죽일 수 있다(그 순간 다른 모든 플러그인·창이 함께 죽는다).
 * 스코프마다 상한이 다르면 저작자가 "어디까지 되는지"를 스코프별로 외워야 하므로 같은 값을 쓴다.
 *
 * 서랍 **개수**는 따로 막지 않는다: `session`의 서랍 키는 플러그인 id(호스트가 정한다)라
 * 설치된 플러그인 수로 이미 유한하고, `window`는 [`MAX_WINDOW_STORES`]가 막는다.
 */
const MAX_MEMORY_STORE_BYTES = 256 * 1024;

/**
 * `notes.write` 본문 하나의 바이트 상한(UTF-8, 1MiB).
 *
 * 왜 필요한가: `overwrite`는 덮기 직전 이전 본문 **전체**를 복구 슬롯에 스냅샷하므로
 * (`trash.rs`), 상한이 없으면 `notes:write` 플러그인이 한 노트를 대용량 본문으로 반복 덮어써
 * 노트당 스냅샷 사본이 통째로 커진다 — 개수 상한(20)은 사본 **수**만 묶고 **크기**는 못 묶는다.
 * 여기서 한 번의 쓰기 크기를 막고, `trash.rs`의 노트당 총 스냅샷 바이트 상한이 축적을 막는다
 * (두 축을 함께 묶어야 디스크 소진을 막는다). 스티키 노트 한 건에 1MiB는 매우 넉넉한 여유다.
 */
const MAX_NOTE_WRITE_BYTES = 1024 * 1024;

/**
 * 메모리 스코프 서랍 하나 — 값과 **키별 직렬화 바이트 수**를 함께 들고 다닌다.
 *
 * 왜 크기를 캐시하나: 상한을 지키려면 쓰기마다 서랍 크기를 알아야 하는데, 그때마다 서랍
 * 전체를 재직렬화하면 쓰기 비용이 서랍 크기에 비례한다(상한 근처에서 가장 느려진다).
 * 키별 크기를 들고 있으면 판정이 뺄셈·덧셈 하나로 끝난다.
 */
interface MemoryStore {
  /** 키 → 값(플러그인이 보는 것). */
  values: Map<string, unknown>;
  /** 키 → 그 항목의 직렬화 바이트 수. */
  sizes: Map<string, number>;
  /** 현재 서랍의 총 바이트(= `sizes`의 합). */
  total: number;
}

/** 빈 메모리 서랍. */
function newMemoryStore(): MemoryStore {
  return { values: new Map(), sizes: new Map(), total: 0 };
}

const STORAGE_ENCODER = new TextEncoder();

/**
 * 항목 하나의 직렬화 바이트 수(UTF-8) — 직렬화할 수 없는 값이면 null.
 *
 * 키까지 함께 재는 것은 Rust `save`가 **맵 전체 JSON**의 길이를 재는 것과 같은 단위이기
 * 때문이다(구분자 몇 바이트만큼 보수적으로 셈한다 — 상한 판정은 그 정도로 충분하다).
 */
function storageEntryBytes(key: string, value: unknown): number | null {
  try {
    return STORAGE_ENCODER.encode(JSON.stringify({ [key]: value })).length;
  } catch {
    // 구조화 복제는 순환 참조를 나르지만 JSON은 못 나른다 — 계약("JSON으로 직렬화되는 값만
    // 담긴다")대로 여기서 거부한다(담아 두면 getAll이 통째로 터진다).
    return null;
  }
}

/**
 * 메모리 서랍에 값 하나를 넣는다 — 성공이면 null, 거부면 그 오류를 **돌려준다**(던지지 않음).
 *
 * 상한을 넘기면 `local`과 **같은 코드**(`QUOTA_EXCEEDED`)로 거부한다: 스코프마다 실패 모양이
 * 다르면 저작자의 정리·재시도 가지가 스코프를 바꾼 순간 죽는다.
 */
function setInMemoryStore(
  store: MemoryStore,
  key: string,
  value: unknown,
): MemoCallError | null {
  const bytes = storageEntryBytes(key, value);
  if (bytes === null) {
    return bridgeError(
      "INVALID_ARGS",
      `storage.set: JSON으로 직렬화할 수 없는 값입니다(key: ${key})`,
    );
  }
  const next = store.total - (store.sizes.get(key) ?? 0) + bytes;
  if (next > MAX_MEMORY_STORE_BYTES) {
    return bridgeError(
      "QUOTA_EXCEEDED",
      `${QUOTA_EXCEEDED_PREFIX}: ${next}바이트(상한 ${MAX_MEMORY_STORE_BYTES}바이트)`,
    );
  }
  store.values.set(key, value);
  store.sizes.set(key, bytes);
  store.total = next;
  return null;
}

/** 메모리 서랍에서 값 하나를 지운다(없어도 오류 아님 — 멱등). */
function removeFromMemoryStore(store: MemoryStore, key: string): void {
  if (!store.sizes.has(key)) return;
  store.total -= store.sizes.get(key) ?? 0;
  store.sizes.delete(key);
  store.values.delete(key);
}

/**
 * `storage.local` 백엔드(Rust)의 거부를 안정 코드가 실린 오류로 바꾼다.
 *
 * 왜 문자열을 보는가: Tauri 커맨드의 `Err(String)`은 `code` 없는 값으로 건너오고, 그대로
 * 흘리면 부트스트랩이 `UNKNOWN`으로 채운다 — 계약이 약속한 `QUOTA_EXCEEDED` 가지가 도는
 * 경로가 사라진다. 접두어는 Rust와 같은 정본([`QUOTA_EXCEEDED_PREFIX`])을 쓴다.
 */
function classifyStorageRejection(e: unknown): unknown {
  const message = e instanceof Error ? e.message : String(e);
  if (!message.startsWith(QUOTA_EXCEEDED_PREFIX)) return e;
  return bridgeError("QUOTA_EXCEEDED", message);
}

/** 스코프 인자로 갈리는 저장소 호출 집합(권한은 `host.ts`가 소유 — 여기는 라우팅만). */
const STORAGE_CALLS = new Set([
  "storage.get",
  "storage.set",
  "storage.remove",
  "storage.getAll",
]);

const INTERACTIVE_CALLS = new Set(["ui.pickList", "ui.prompt"]);
const WINDOW_CALL_INTERACTIVE_TIMEOUT_MS = 600_000; // 10분

/**
 * 샌드박스 부팅(ready 회신) 상한(ms) — 초과하면 그 플러그인만 실패로 접고 빌드를 계속한다.
 * 왜: 부트스트랩이 CSP 위반 등으로 ready를 아예 못 보내면 상한이 없을 때 `build()`가 영영
 * 멈추고 스냅샷이 null로 고정돼 모든 노트 창이 플러그인 없이 굶는다.
 */
const SANDBOX_BOOT_TIMEOUT_MS = 5000;

/**
 * 보관하는 호출 컨텍스트 토큰의 최대 개수 — 상주 호스트에서 무한 증가 방지.
 *
 * 폐기 정책은 삽입 순 FIFO가 아니라 **LRU + 진행 중 보호**다: 쓰일 때마다 최근으로 승급하고,
 * 창-스코프 호출이 아직 응답을 기다리는 토큰(대화형 pickList·prompt는 최대 10분)은 상한을
 * 넘겨도 버리지 않는다. 왜: FIFO였을 때 사용자가 팝업을 띄워 놓고 고민하는 사이 다른 창·다른
 * 플러그인 클릭이 200번을 넘기면 그 체인의 토큰이 폐기돼, 응답 후 이어지는 삽입이 "모르는
 * 토큰"으로 무력화(null)돼 조용히 사라졌다.
 */
const MAX_INVOCATIONS = 200;

/**
 * 플러그인 간 호출의 최대 릴레이 깊이 — A→B→A… 순환·폭주를 끊는 상한.
 *
 * 왜 이 방식인가: 각 `commands.invoke`는 대상 명령을 **디스패치**하고 곧바로 resolve하는
 * fire-and-forget이라(호스트가 대상 핸들러의 완료를 기다리지 않는다) 동기 콜스택으로는
 * 깊이가 잡히지 않는다 — 순환은 별개의 태스크로 무한히 이어지는 async 핑퐁이다. 그래서
 * 깊이를 **컨텍스트 토큰**에 실어 나른다: 대상에게 발급하는 토큰의 `relayDepth`를 호출측
 * 토큰의 깊이 + 1로 두고, 대상이 그 토큰(=바인딩된 memo)으로 다시 invoke하면 깊이가
 * 증가해 여기서 끊긴다. **한계(정직하게):** 이 방어는 **바인딩된 memo 경로**를 덮는다 —
 * 대상이 토큰을 일부러 버리고(비-브리지 async 경계 뒤 전역 memo) 다시 부르면 깊이가 폴백
 * (0)으로 리셋될 수 있다. 그래도 각 홉은 여전히 `invoke:<대상>` 선언∩승인 게이트를 전부
 * 통과해야 하므로(양방향 승인 없이는 핑퐁 자체가 성립하지 않는다) 실질 위험은 작다.
 * 값(8)은 정당한 오케스트레이션 체인(설정→여러 플러그인 위임)에는 넉넉하고 폭주는 막는다.
 */
const MAX_INVOKE_DEPTH = 8;

/**
 * 컨텍스트 토큰의 **유휴 만료** — 마지막 활동 후 이 시간이 지난 토큰으로는 민감 권한
 * (`notes:write`·`clipboard` 등 `isSensitive`)의 창-스코프 호출을 할 수 없다
 * (`CONTEXT_UNAVAILABLE`로 명시 거부 + 진단).
 *
 * **왜 5분인가**: 정당한 지연 사용 중 가장 긴 것들이 전부 이 값 안에 든다 — 호스트 자신이
 * 만드는 비대화형 대기는 최대 5초([`WINDOW_CALL_TIMEOUT_MS`]), 진행 토스트의 강제 소멸은
 * 30초, 재빌드 디바운스는 400ms다. 유일하게 더 긴 대기(대화형 팝업 최대 10분)는 만료가
 * 아니라 **진행 중 보호**(`inflight`)와 **완료 시 활동 갱신**(unpin이 `lastUsed`를 새로
 * 찍는다)이 담당하므로 이 값과 경합하지 않는다. 반대로 이보다 길게 "아무 호출 없이" 들고만
 * 있던 토큰은 저작 계약이 권장하는 어떤 패턴에도 해당하지 않는다 — 그런 토큰이 바로 유휴 만료가
 * 막으려는 "예전에 클릭됐던 창들을 나중에 개별 타깃"하는 재료다. 고정 발급-후-30초(제안
 * 원안)가 아니라 유휴 기준인 이유: 활동 중인 체인(진행 토스트 갱신 등)을 30초에 자르면
 * 정당한 지연 쓰기가 더 자주 실패한다는 위험이 원안 스스로에 적혀 있었다. 실측 후 조정 여지
 * 있음.
 */
const INVOCATION_IDLE_TTL_MS = 5 * 60_000;

/**
 * `runtime.onDispose` 핸들러를 기다리는 상한(ms) — 초과하면 진단만 남기고 파괴를 강행한다.
 *
 * 왜 300ms인가, 그리고 왜 **병렬**인가: dispose는 설정을 한 번 바꿀 때마다 도는 경로다.
 * 직렬로 기다리면 번들 20개 × 상한 = 6초가 그대로 "설정 저장이 멈춘 시간"이 된다. 병렬이면
 * 총 지연이 플러그인 수와 무관하게 상한 하나로 고정된다. 핸들러를 등록하지 않은 샌드박스는
 * 즉시 회신하므로(부트스트랩이 무조건 ack) 정상 경로에서 이 상한에 닿는 일은 없다.
 */
const DISPOSE_TIMEOUT_MS = 300;

/**
 * `memo.storage.local`(영속 스코프)의 백엔드 계약.
 *
 * `builtin`으로 갈리는 이유: 백엔드가 번들과 사이드로드를 **다른 네임스페이스**에 저장한다
 * (같은 id를 써도 파일이 겹치지 않는다 — `plugin_storage.rs`). 그 구분은 호스트가 이미
 * 알고 있으므로(어느 목록에서 왔는지) 여기서 그대로 넘긴다.
 */
interface PluginStorageBackend {
  get(id: string, key: string, builtin: boolean): Promise<unknown>;
  set(id: string, key: string, value: unknown, builtin: boolean): Promise<void>;
  remove(id: string, key: string, builtin: boolean): Promise<void>;
  getAll(id: string, builtin: boolean): Promise<Record<string, unknown>>;
}

/**
 * 프로덕션 `storage.local` 백엔드 — Rust 커맨드를 지연 임포트해 부른다.
 *
 * 왜 지연(동적) 임포트인가: 이 모듈은 jsdom 단위 테스트가 Tauri 없이 통째로 구동한다.
 * `../shared/tauri`를 정적으로 가져오면 그 파일이 최상위에서 `@tauri-apps/api/*`를 끌어와
 * 테스트 환경 전체가 그 의존성에 묶인다. 실제로 호출되는 순간에만 가져오면 계약(기본 배선이
 * 항상 존재한다)과 테스트 격리를 둘 다 지킨다.
 */
const tauriStorageBackend: PluginStorageBackend = {
  get: async (id, key, builtin) => {
    const t = await import("../shared/tauri");
    return builtin ? t.getBuiltinStorage(id, key) : t.getPluginStorage(id, key);
  },
  set: async (id, key, value, builtin) => {
    const t = await import("../shared/tauri");
    return builtin
      ? t.setBuiltinStorage(id, key, value)
      : t.setPluginStorage(id, key, value);
  },
  remove: async (id, key, builtin) => {
    const t = await import("../shared/tauri");
    return builtin
      ? t.removeBuiltinStorage(id, key)
      : t.removePluginStorage(id, key);
  },
  getAll: async (id, builtin) => {
    const t = await import("../shared/tauri");
    return builtin ? t.getAllBuiltinStorage(id) : t.getAllPluginStorage(id);
  },
};

/**
 * `notes.list`가 한 번에 돌려주는 항목 수의 기본값·상한.
 *
 * 왜 못박나: `list`는 노트 수에 비례하는 응답을 내는 유일한 브리지 호출이다 — 상한 없이
 * 열면 상주 호스트↔샌드박스 postMessage 한 번에 컬렉션 전체가 실려 간다. 기본 500은
 * 스티키 노트 앱의 현실적인 컬렉션(수백 장)을 한 호출로 덮고, 상한 1000은 "더 달라"는
 * 호출이 `offset`으로 페이지를 넘기게 강제한다(값은 계약 문서와 함께 움직인다 —
 * api-index.ts의 `notes.list` 인자 doc).
 */
const NOTES_LIST_DEFAULT_LIMIT = 500;
const NOTES_LIST_MAX_LIMIT = 1000;

/**
 * `notes.list` 결과의 호스트 캐시 TTL — 이 시간 안의 반복 호출은 백엔드를 다시 부르지
 * 않는다.
 *
 * 왜: `note_list`는 모든 노트의 .md·.json을 읽는 O(전체 노트) 파일 IO다 — 계약의
 * limit/offset은 **응답 크기**만 접고 IO 비용은 못 접는다. 짧은 캐시가 있어야 플러그인
 * 루프·버그가 브리지로 아무리 두드려도 실제 vault 스캔은 "TTL당 1회"로 상한이 잡힌다.
 * 1초인 이유: 재빌드 디바운스(400ms)보다 길어 폭주를 실제로 흡수하면서, 사람이 노트를
 * 저장하고 목록을 다시 묻는 자연스러운 흐름(초 단위)에는 낡은 값이 보이지 않는 크기다.
 * 실패는 캐시하지 않고, 재빌드(`build()`)가 캐시를 비운다.
 */
const NOTES_LIST_CACHE_TTL_MS = 1000;

/**
 * `network.fetch` 동시 호출 상한(스레드풀 고갈 방지). 각 fetch는 Rust `net_fetch`
 * (`#[tauri::command(async)]`)를 공유 Tauri 블로킹 스레드풀에서 돌리고, 하나가 최대
 * REQUEST_TIMEOUT(30초)까지 스레드를 쥔다 — 그 풀은 `note_read`/`note_write`/`plugin_storage`
 * 등 무관한 async 커맨드도 함께 쓴다. 상한을 넘는 호출은 큐잉(풀에 얹기) 대신 즉시
 * `NETWORK_TOO_MANY_REQUESTS`로 거부해, 폭주·느린-서버 플러그인이 자기 자신만 굶게 한다.
 * 플러그인당(폭주 플러그인 격리)·전역(여러 플러그인 합산 방어) 두 상한을 함께 건다.
 */
const NETWORK_FETCH_MAX_INFLIGHT_PER_PLUGIN = 6;
const NETWORK_FETCH_MAX_INFLIGHT_GLOBAL = 16;

/**
 * `notes.read`의 id가 경로 조립에 안전한지(구분자·`..`·`:` 없음) 검사한다 — Rust
 * `notes::is_safe_note_id`와 **동일 규칙**(빈 문자열은 호출부가 먼저 별도 문구로 거른다).
 *
 * 왜: 계약은 id를 **불투명 식별자**("경로 해석은 호스트 독점")로 약속하는데, 이 문자열은
 * 신뢰 경계 밖(샌드박스)에서 온다 — 검증 없이 넘기면 Rust가 `notes/<id>.md`로 join할 때
 * `../`는 그대로 이어붙고 절대경로는 베이스를 통째로 대체해, `notes:all-read` 승인 문구
 * ("모든 **메모**")가 약속한 범위 밖의 파일(vault 밖 .md)까지 읽힌다(실증된 경로 인젝션).
 * Rust에도 같은 가드가 있지만(심층 방어) 여기서 먼저 거부해야 진단 코드가
 * `INVALID_ARGS`로 정확히 남는다.
 */
function isSafeNoteId(id: string): boolean {
  return (
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("..") &&
    !id.includes(":")
  );
}

/**
 * `memo.notes.list`/`memo.notes.read`의 백엔드 계약 — 기존 Rust 커맨드
 * `note_list`/`note_read`를 그대로 재사용한다(새 Rust 표면을 만들지 않는다).
 *
 * 페이로드 최소화는 백엔드가 아니라 **수행부**가 한다: `note_read`는 사이드카 메타(창
 * 위치·투명도 등)까지 돌려주지만 플러그인에게는 본문만 나간다 — 권한 문구가 약속한 것
 * ("제목과 내용")보다 많이 실어 보내지 않는다.
 */
interface PluginNotesBackend {
  list(): Promise<
    { id: string; title: string; hidden: boolean; created_at: number }[]
  >;
  read(id: string): Promise<{ content: string }>;
  /**
   * 임의 노트 하나에 본문을 쓴다(과 함께 예약 해제된 `notes.write`).
   *
   * `mode`: `"append"`(본문 끝에 이어붙임 — 저마찰 기본, 데이터를 잃지 않는다) 또는
   * `"overwrite"`(통째로 덮음 — Rust `Vault`가 **덮기 전에 스냅샷을 남겨** 복구 가능하게 한다).
   * id 검증(경로 형태 거부)은 **수행부**가 백엔드 호출 전에 한다(`notes.read`와 같은 관문).
   */
  write(id: string, content: string, mode: string): Promise<void>;
}

/** 프로덕션 노트 백엔드 — 저장소 백엔드와 같은 이유로 지연 임포트(jsdom 테스트 격리). */
const tauriNotesBackend: PluginNotesBackend = {
  list: async () => {
    const t = await import("../shared/tauri");
    return t.noteList();
  },
  read: async (id) => {
    const t = await import("../shared/tauri");
    return t.noteRead(id);
  },
  // `noteList`/`noteRead`와 같은 명명 바인딩(`shared/tauri`)을 쓴다 — 이 백엔드가 그 바인딩의
  // 유일한 소비처다. 한때는 소비처 없는 바인딩을 막는 drift 가드 때문에 여기서 `invoke`로
  // 직접 불렀지만, 이제 `shared/tauri.ts`가 `noteWrite`를 노출해(그 소비처가 바로 여기라) 다른
  // 노트 호출과 배선이 일관된다 — 커맨드명·인자는 Rust `note_write`와 같다.
  write: async (id, content, mode) => {
    const t = await import("../shared/tauri");
    return t.noteWrite(id, content, mode);
  },
};

/**
 * `memo.network.fetch`의 백엔드 계약 — 호스트가 대신 수행하는 https 중계(Rust `net_fetch`).
 *
 * 왜 인터페이스인가: `notes`·`storage`와 같은 이유로 테스트가 Tauri 없이 가짜를 주입한다.
 * 실제 SSRF 방어(사설대역·DNS 핀·리다이렉트·크기·타임아웃)는 전부 백엔드가 소유하고, 이
 * 계약은 그 커맨드를 부르는 얇은 통로일 뿐이다(수행부는 인자 형식·메서드만 앞에서 거른다).
 */
interface PluginNetworkBackend {
  fetch(
    url: string,
    method: string,
    headers: { name: string; value: string }[],
    body: string | null,
  ): Promise<{
    status: number;
    headers: { name: string; value: string }[];
    body: string;
  }>;
}

/** 프로덕션 네트워크 백엔드 — 노트/저장소 백엔드와 같은 이유로 지연 임포트(jsdom 격리). */
const tauriNetworkBackend: PluginNetworkBackend = {
  fetch: async (url, method, headers, body) => {
    const t = await import("../shared/tauri");
    return t.netFetch(url, method, headers, body);
  },
};

/** `memo.browser.open`의 백엔드 — URL 하나를 시스템 기본 브라우저로 넘긴다. */
interface PluginBrowserBackend {
  open(url: string): Promise<void>;
}

/** 프로덕션 브라우저 백엔드 — 네트워크 백엔드와 같은 이유로 지연 임포트(jsdom 격리). */
const tauriBrowserBackend: PluginBrowserBackend = {
  open: async (url) => {
    const t = await import("../shared/tauri");
    return t.openExternalUrl(url);
  },
};

/**
 * 백엔드(`net.rs`)가 `Err(String)`으로 돌려준 `NET_*` 접두 토큰을 `MemoErrorCode`로 맵한다.
 *
 * 왜 문자열을 보는가: Tauri 커맨드의 거부는 code 없는 문자열이라(QUOTA_EXCEEDED·NOTE_NOT_FOUND와
 * 같은 상황) 그대로 흘리면 부트스트랩이 `UNKNOWN`으로 채운다 — 계약이 약속한 사설대역·타임아웃·
 * 크기 초과 가지가 도는 경로가 사라진다. 토큰의 정본은 `net.rs`의 `NET_*` 상수다(계약 — 한쪽을
 * 바꾸면 이 맵도 함께 바꿔야 한다). 알 수 없는 토큰은 `NETWORK_FAILED`로 접는다(전송 실패류).
 */
function classifyNetworkRejection(e: unknown): MemoCallError {
  const message = e instanceof Error ? e.message : String(e);
  const token = message.split(":")[0]?.trim() ?? "";
  const code: MemoErrorCode =
    token === "NET_SCHEME"
      ? "NETWORK_SCHEME"
      : token === "NET_INVALID_URL"
        ? "NETWORK_INVALID_URL"
        : token === "NET_BLOCKED_ADDRESS"
          ? "NETWORK_BLOCKED"
          : token === "NET_DNS"
            ? "NETWORK_DNS"
            : token === "NET_METHOD"
              ? "NETWORK_METHOD"
              : token === "NET_TOO_LARGE"
                ? "NETWORK_TOO_LARGE"
                : token === "NET_TIMEOUT"
                  ? "NETWORK_TIMEOUT"
                  : token === "NET_TOO_MANY_REQUESTS"
                    ? "NETWORK_TOO_MANY_REQUESTS"
                    : "NETWORK_FAILED";
  return bridgeError(code, message);
}

/** 중앙 호스트 의존성(테스트 시 주입 — Tauri·실제 iframe 없이 구동 가능). */
interface CentralHostDeps {
  doc: Document;
  bus: HostEventBus;
  /** 빌트인 활성 상태 맵(null → 전부 기본 켜짐). */
  builtinStates(): Promise<Record<string, boolean> | null>;
  /** 빌트인 설정 값 맵(null → 빈 값). */
  builtinSettings(): Promise<Record<string, Record<string, unknown>> | null>;
  /** 활성화된(enabled) 설치 플러그인 로드 입력. */
  enabledInstalledSources(): Promise<InstalledPluginSource[]>;
  /** 모든 설치 플러그인 로드 입력(테마 해석용 — 테마는 enabled가 아니라 이름으로 선택). */
  allInstalledSources(): Promise<InstalledPluginSource[]>;
  /** 활성 테마 이름(공유 설정). */
  activeThemeName(): Promise<string>;
  /**
   * 이 창이 그릴 UI 언어 코드를 **확정하고 반영까지 끝낸 뒤** 돌려준다. 미제공/실패 시
   * `"ko"` 폴백.
   *
   * 왜 필요한가: 이 중앙 호스트 창 자신도 `t()`를 쓴다(예: 명령 실행 확인 팝업). 이
   * 창은 note/settings/panel 창과 달리 재빌드마다 스스로 리로드하지 않으므로(숨김 상주 창),
   * `build()`가 매번 이 콜백을 태워야 언어 설정 변경·언어팩 설치/해제가 이 창에 반영된다.
   * 안 그러면 이 창이 만들어 노트 창에 넘기는 팝업 문자열이 부팅 시점 언어로 고정된다.
   *
   * **호스트는 반환된 코드를 캐시할 뿐, 로케일 저장소를 직접 건드리지 않는다.** 사전 등록과
   * `setActiveLocale`은 전부 이 콜백(`bootstrap/plugin-host.ts`의 `resolveHostLocale`) 안에서
   * 끝난다 — 호스트가 나르는 언어팩이 더는 없으므로(언어팩은 코어·창이 직접 읽는 데이터
   * 선언이다) 소유자를 한 곳으로 모으는 편이 옳다.
   */
  activeLocale?(): Promise<string>;
  /**
   * 현재 OS 식별자("macos"·"windows"·"linux" 등). 미지원 OS의 플러그인은 실행하지 않는다
   * (스냅샷에서 제외 = 자동 비활성화). 미제공/실패 시 빈 문자열 → 제한 없음(안전 폴백).
   */
  platform?(): Promise<string>;
  /**
   * 앱 버전(`tauri.conf.json`의 `version`) — `memo.runtime.info().hostVersion`으로 나간다.
   * 미제공/실패 시 빈 문자열(폴백) → 저작자에게 "모른다"가 그대로 보인다. 지어낸 버전을
   * 주는 것이 최악이다: 그 값으로 분기한 플러그인이 조용히 틀린 길을 탄다.
   */
  hostVersion?(): Promise<string>;
  /**
   * OS에 설치된 글꼴 목록. 폰트 플러그인이 `includeSystem`을 켰을 때만 호출한다.
   * 미제공/실패 시 빈 목록 → 「설치된 글꼴」 후보 없음(플러그인 공급분만 남는다).
   */
  systemFonts?(): Promise<{ family: string; korean: boolean }[]>;
  /**
   * 빌트인 플러그인 설정 값 영속화(런타임 settings.set 백엔드).
   *
   * 프라미스를 돌려주면 호스트가 **거부를 진단으로 기록한다** — 브리지 응답은 `ok:true`인데
   * 실제 저장은 실패하는 구멍이 여기였다. 동기(void) 구현도 그대로 받는다(하위호환).
   */
  persistBuiltinSetting(
    id: string,
    key: string,
    value: unknown,
  ): void | Promise<void>;
  /** 설치 플러그인 설정 값 영속화(런타임 settings.set 백엔드 — 위와 같은 진단 규칙). */
  persistPluginSetting(
    id: string,
    key: string,
    value: unknown,
  ): void | Promise<void>;
  /**
   * `memo.storage.local`의 디스크 백엔드 — 기본 [`tauriStorageBackend`].
   *
   * 왜 기본값을 두는가: `session`·`window`는 이 파일의 Map으로 끝나지만 `local`만 Rust IPC가
   * 필요하다. 이것을 주입 **필수**로 만들면 진입점(main.ts)이 넘기는 것을 잊는 순간
   * `storage.local`만 통째로 죽는다 — 이 저장소가 11번 겪은 「선언은 됐는데 아무도 안 읽는다」의
   * 정확한 모양이다. 기본 구현을 여기 붙여 두면 배선을 잊을 자리 자체가 없다(테스트는 가짜를
   * 주입해 Tauri 없이 돈다).
   */
  storage?: PluginStorageBackend;
  /** `memo.notes.list/read`의 노트 백엔드 — 기본 [`tauriNotesBackend`]. `storage`와
   * 같은 이유로 기본값을 붙여 둔다(배선을 잊을 자리를 없앤다 — 테스트만 가짜를 주입한다). */
  notes?: PluginNotesBackend;
  /** `memo.network.fetch`의 백엔드 — 기본 [`tauriNetworkBackend`]. `notes`·`storage`와
   * 같은 이유로 기본값을 붙여 둔다(배선을 잊을 자리를 없앤다 — 테스트만 가짜를 주입한다). */
  network?: PluginNetworkBackend;
  /** `memo.browser.open`의 백엔드 — 기본 [`tauriBrowserBackend`](테스트만 가짜를 주입한다). */
  browser?: PluginBrowserBackend;
  /** 샌드박스 팩토리(기본 [`createPluginSandbox`] — 테스트가 가짜를 주입해 생성 수를 센다). */
  createSandbox?: typeof createPluginSandbox;
  /** 번들 플러그인 목록(기본 [`BUILTIN_PLUGINS`] — 테스트가 합성 목록을 주입한다). */
  builtins?: BuiltinPlugin[];
  /**
   * 개발 모드 — 개발 중인 플러그인 하나의 **현재 소스**를 다시 읽는다(없으면 null).
   *
   * 왜 필요한가: [`EV_PLUGIN_DEV_RELOAD`]를 받으면 호스트는 그 플러그인 하나만 다시 실행해야
   * 하는데, 디스크의 바뀐 코드를 다시 읽는 경로가 필요하다. 진입점(main.ts)이 설치 플러그인
   * 읽기 경로(`readPluginCode` + `installedSourceFromRecord`)를 그대로 재사용해 넘긴다 —
   * 개발 소스도 결국 설치 플러그인이라 게이트키퍼·권한 클램프가 전과 똑같이 적용된다(개발
   * 모드는 편의지 보안 우회가 아니다). 미제공이면 개발 리로드 요청은 전체 재빌드로 폴백한다.
   */
  devSource?(pluginId: string): Promise<InstalledPluginSource | null>;
  /**
   * 메뉴바 트레이 항목의 네이티브 배달 — 빌드마다 평탄화한 전체 목록으로 호출한다.
   *
   * 기본 [`tauriTraySink`]. `storage`·`notes`·`network`와 **같은 이유로** 기본값을 붙여 둔다:
   * 진입점(main.ts)이 넘기는 것을 잊으면 트레이 항목이 조용히 안 뜨는 「선언은 됐는데 아무도
   * 안 읽는다」가 된다 — 기본 구현을 여기 붙여 배선을 잊을 자리 자체를 없앤다(테스트는 가짜를
   * 주입해 네이티브 없이 배달을 검사한다). 창-스코프 호출과 달리 **빌드마다 무조건** 불린다
   * (플러그인을 켜고 끄면 트레이 섹션 전체가 다시 그려져야 하므로, 빈 목록도 배달한다).
   */
  setTrayItems?(items: TrayItemDescriptor[]): void | Promise<void>;
}

/**
 * 트레이 항목의 네이티브 배달 기본 구현 — Rust `set_plugin_tray_items` 커맨드를 부른다.
 *
 * `tauriStorageBackend`와 같은 결로 `../shared/tauri`를 지연 import한다(중앙 호스트를 전송
 * 계층에서 떼어 놓아 테스트가 Tauri 없이 돈다). 실패는 삼킨다: 트레이 배달이 못 되어도 노트
 * 창·창-스코프 호출은 멀쩡히 살아야 하고(비차단), 호스트 창이 아닌 곳에서 build()가 돌면
 * (테스트) invoke가 거부되는데 그것이 호스트 부팅을 막아선 안 된다.
 */
async function tauriSetTrayItems(items: TrayItemDescriptor[]): Promise<void> {
  const t = await import("../shared/tauri");
  await t.setPluginTrayItems(items);
}

/** 살아있는 플러그인 샌드박스 핸들(팩토리 반환형에서 유도 — 소유·역호출·정리에 필요한 만큼). */
type SandboxHandle = ReturnType<typeof createPluginSandbox>;

/**
 * 중앙 호스트를 기동한다: 활성 플러그인 샌드박스 실행 → 스냅샷 조립 → 프로토콜 서빙.
 *
 * 역할: 초기 빌드를 마친 뒤 [`EV_SNAPSHOT_GET`]/[`EV_BUTTON_INVOKE`]/[`EV_WINDOW_RESULT`]/
 * `notes-reload`를 구독해 상주한다. 빌드 중 도착한 스냅샷 요청은 큐에 쌓았다가 빌드가
 * 끝나면 응답한다(오래된 스냅샷을 주지 않기 위함). 반환 시점 = 초기 빌드 완료.
 * 왜: 노트 창이 언제 떠도(호스트보다 먼저 요청해도) 재시도 폴링으로 결국 최신 스냅샷을
 * 받게 하는 단일 진입점이다.
 */
export async function mountPluginHost(deps: CentralHostDeps): Promise<void> {
  const factory = deps.createSandbox ?? createPluginSandbox;
  const builtins = deps.builtins ?? BUILTIN_PLUGINS;
  const storage = deps.storage ?? tauriStorageBackend;
  const notesBackend = deps.notes ?? tauriNotesBackend;
  const networkBackend = deps.network ?? tauriNetworkBackend;
  const browserBackend = deps.browser ?? tauriBrowserBackend;

  /**
   * `notes.list`의 짧은 결과 캐시([`NOTES_LIST_CACHE_TTL_MS`]) — 값은 진행 중이거나
   * 성공한 백엔드 호출의 프라미스다(동시 도착 호출도 스캔 1회를 공유). 실패는 캐시에서
   * 즉시 내려 다음 호출이 재시도하게 한다(일시 오류가 TTL 동안 눌러앉지 않게).
   */
  let notesListCache: {
    at: number;
    data: ReturnType<PluginNotesBackend["list"]>;
  } | null = null;

  /**
   * `network.fetch`의 진행 중(in-flight) 호출 수 — 플러그인당(`networkInflight`) + 전역
   * (`networkInflightGlobal`) 두 상한을 강제한다([`NETWORK_FETCH_MAX_INFLIGHT_PER_PLUGIN`]·
   * [`NETWORK_FETCH_MAX_INFLIGHT_GLOBAL`]). 이 호스트 인스턴스 스코프라 모든 플러그인이 전역
   * 카운터를 공유한다(여러 플러그인 합산 폭주도 막힌다).
   */
  const networkInflight = new Map<string, number>();
  let networkInflightGlobal = 0;

  /**
   * 상한을 확인하고 슬롯을 잡는다. 여유가 있으면 두 카운터를 올리고 **정확히 한 번** 도는
   * 해제 함수를 돌려준다(성공·실패·예외 모든 경로에서 finally로 부른다). 초과면 null을
   * 돌려주고 호출부가 `NETWORK_TOO_MANY_REQUESTS`로 즉시 거부한다(큐잉 없음).
   */
  function acquireNetworkSlot(pluginId: string): (() => void) | null {
    const current = networkInflight.get(pluginId) ?? 0;
    if (
      current >= NETWORK_FETCH_MAX_INFLIGHT_PER_PLUGIN ||
      networkInflightGlobal >= NETWORK_FETCH_MAX_INFLIGHT_GLOBAL
    ) {
      return null;
    }
    networkInflight.set(pluginId, current + 1);
    networkInflightGlobal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      networkInflightGlobal -= 1;
      const n = (networkInflight.get(pluginId) ?? 1) - 1;
      if (n <= 0) networkInflight.delete(pluginId);
      else networkInflight.set(pluginId, n);
    };
  }

  /** 캐시를 거쳐 전체 노트 메타를 읽는다 — limit/offset 절단은 호출부가 호출별로 한다. */
  function listNotesCached(): ReturnType<PluginNotesBackend["list"]> {
    const cached = notesListCache;
    if (cached && Date.now() - cached.at <= NOTES_LIST_CACHE_TTL_MS) {
      return cached.data;
    }
    const fresh = { at: Date.now(), data: notesBackend.list() };
    notesListCache = fresh;
    fresh.data.catch(() => {
      if (notesListCache === fresh) notesListCache = null;
    });
    return fresh.data;
  }

  /** 현재 서빙 중인 스냅샷(null = 빌드 중 — 요청은 pendingGets에 대기). */
  let snapshot: HostSnapshot | null = null;
  let revision = 0;
  /** 빌드 중 도착한 스냅샷 요청 id들(빌드 완료 시 일괄 응답). */
  const pendingGets: string[] = [];
  /** 플러그인 id → 소유 중인 샌드박스(재빌드 시 dispose). */
  const sandboxes = new Map<string, SandboxHandle>();
  /**
   * 플러그인 id → 마지막으로 그 플러그인 버튼을 클릭한 창 라벨 + 마지막 활동 시각(창-스코프
   * 호출 라우팅의 **폴백**). 토큰이 실리지 않은 호출(로드 시점 toast, `setTimeout`·
   * `Promise.all` 뒤처럼 부트스트랩이 토큰을 유실한 호출)에만 쓴다 — 클릭 파생 호출은
   * 아래 `invocations`의 토큰으로 정확히 라우팅한다.
   *
   * `lastUsed`를 함께 드는 이유: 유휴 만료를 토큰에만 걸면 만료를 피하는 방법이
   * "토큰을 빼는 것"이 된다 — 그리고 그것은 지연 호출의 **기본 동작**이다. 그래서 이 폴백도
   * 토큰과 같은 유휴 규칙을 탄다(민감 호출만 거부, 사용·완료가 활동 — [`resolveWindow`]).
   *
   * `inflight`를 함께 드는 이유(토큰 경로와 대칭): 토큰은 응답 대기 중(대화형 팝업 최대
   * 10분)이면 만료로 판정하지 않는다(`invocations`의 `inflight`). 폴백에도 같은 보호가
   * 없으면, 토큰 없는 대화형 팝업이 유휴 상한(5분)을 넘겨 아직 열려 있는 동안 같은 플러그인의
   * 다른 민감 폴백 호출이 "유휴"로 오판돼 거부된다 — 토큰 경로가 명시적으로 막은 그 상황이다.
   * 그래서 폴백도 진행-중 카운터를 들고, [`resolveWindow`]가 그 값이 0일 때만 만료로 본다.
   */
  const contexts = new Map<
    string,
    { window: string; lastUsed: number; inflight: number }
  >();
  /**
   * 호출 컨텍스트 토큰 → 그 클릭의 주인(플러그인 + 창 라벨). 버튼 클릭마다 새 토큰을
   * 발급해 샌드박스에 내려보내고, 그 클릭에서 파생된 브리지 호출이 토큰을 되싣는다.
   * 왜: 창이 여러 개면 "마지막 클릭 창" 단일 슬롯이 뒤집혀, A 창의 팝업 응답으로 이어진
   * 삽입이 B 창 본문에 들어가는 데이터 손상이 난다(실증).
   *
   * **보장하는 것**: 토큰 값은 호스트만 발급·해석한다(순번 문자열이지만 의미는 이 맵에만
   * 있다). 지어낸 토큰·남의 플러그인 토큰은 폴백 없이 거부하므로, 샌드박스는 **자기 버튼이
   * 클릭된 적 있는 창** 밖을 타깃할 수 없다.
   *
   * **유효기간(유휴 만료)**: 클릭 완료를 호스트에 알리는 신호는 여전히 프로토콜에
   * 없다. 대신 토큰마다 마지막 활동 시각(`lastUsed`)을 들고, 유휴가
   * [`INVOCATION_IDLE_TTL_MS`]를 넘긴 토큰으로는 **민감 권한 호출**(`isSensitive` —
   * `editor.insertText`·`clipboard.write`·`notes.current` 등)을 거부한다
   * (`CONTEXT_UNAVAILABLE` + 진단 — 조용한 null이 아니다). 활동으로 치는 것: 그 토큰을 실은
   * 호출의 도착, 창 응답 대기의 **완료**(unpin — 10분짜리 대화형 팝업의 후속 삽입이 잘리지
   * 않게 하는 핵심), 그 (플러그인, 창)으로의 이벤트 배달. 진행 중(`inflight > 0`)인 토큰은
   * 절대 만료로 판정하지 않는다.
   *
   * **여전히 보장하지 않는 것 — keep-alive**: 유휴 기준이므로 주기적으로 아무 호출이나 하는
   * 플러그인은 토큰을 계속 살릴 수 있다(그것이 "유휴"의 정의다). 이 만료가 막는 것은
   * "들고만 있던" 오래된 바인딩 memo로 예전 클릭 창들을 나중에 타깃하는 경로다. 저위험
   * 호출(`ui.toast` 등)은 만료 뒤에도 현행 그대로 동작한다(하위호환 — 제안 원안 3항).
   * 같은 유휴 규칙이 토큰 없는 폴백(`contexts` — 마지막 클릭 창)에도 적용된다: 토큰을
   * 빼는 것이 만료 우회가 되면 안 되기 때문이다(그 맵의 문서 참고).
   * 실제 범위는 central-host.test.ts의 유휴 만료 절이 못박고 있다.
   */
  const invocations = new Map<
    string,
    {
      pluginId: string;
      window: string;
      /** 이 토큰으로 지금 응답을 기다리는 창-스코프 호출 수(>0이면 폐기·만료 대상에서 제외). */
      inflight: number;
      /** 마지막 활동 시각(에폭 ms) — 유휴 만료 판정의 기준. */
      lastUsed: number;
      /**
       * 플러그인 간 호출 릴레이 깊이. 사용자 클릭·이벤트로 발급된 원천 토큰은 0이고,
       * `commands.invoke`가 대상에게 발급하는 토큰은 호출측 토큰의 깊이 + 1이다. 대상이
       * **바인딩된 memo**로 다시 invoke하면 이 값이 계속 증가해 A→B→A… 순환이 상한
       * (`MAX_INVOKE_DEPTH`)에서 끊긴다. 없으면(원천 토큰) 0으로 본다.
       */
      relayDepth?: number;
    }
  >();
  let nextInvocationSeq = 0;
  /**
   * 플러그인 id → 이 빌드에서 살아있는 이벤트 구독들. 재빌드마다 통째로 버려진다 —
   * 그것이 이 API에 `off`가 없는 이유다(리스너 수명이 이미 리빌드 단위로 닫혀 있다).
   */
  const eventSubs = new Map<
    string,
    Map<string, { name: MemoEventName; handlerId: string }>
  >();
  /**
   * (플러그인, 창) → 그 조합에 재사용하는 이벤트용 컨텍스트 토큰.
   *
   * 왜 재사용하나: 이벤트마다 새 토큰을 발급하면 `invocations`(상한 200, LRU)가 이벤트
   * 빈도만큼 회전해, 사용자가 팝업을 띄워 놓은 클릭 체인의 토큰까지 밀어낸다. 같은
   * (플러그인, 창)에 같은 토큰을 쓰면 권한은 정확히 같고(그 창을 타깃할 수 있다는 사실 하나)
   * 토큰 수는 플러그인 × 창으로 묶인다. LRU에 밀려 사라졌으면 같은 키에 다시 발급한다 —
   * 그래서 이 맵은 이벤트 횟수가 아니라 "이번 빌드에서 본 창 수"만큼만 자라고, 재빌드마다
   * 비워진다.
   */
  const eventTokens = new Map<string, string>();
  /**
   * 플러그인 id → 이 빌드가 등록한 명령들. 구독과 같은 이유로 재빌드마다 통째로 버려진다.
   *
   * 스냅샷에는 `id`·`title`·`destructive`(그리고 창 상태를 봐야 판정되는 when 키의 목록
   * `whenPendingKeys`)만 나가고 `handlerId`·`when` 전체는 여기 남는다 — 노트 창은 "무엇을
   * 실행해 달라"만 말하고, **누구를 어떤 조건에서 부를지는 호스트가 정한다**.
   * 조건 판정 결과를 창에 알려주지 않는 것이 정보 유출 차단 규칙이다.
   */
  const commandsOf = new Map<
    string,
    Map<
      string,
      {
        title: string;
        handlerId: string;
        when: WhenTerm[];
        destructive: boolean;
      }
    >
  >();
  /**
   * 플러그인 id → 이 빌드가 등록한 메뉴 전용 항목들(`ui.addMenuItem`). 구독·명령과 같은
   * 이유로 재빌드마다 통째로 버려진다.
   *
   * 스냅샷에는 `id`·`label`·`when`(창 상태 키)·`needsSelectedText`만 나가고 `handlerId`는 여기
   * 남는다 — 노트 창은 "이 항목을 실행해 달라"만 말하고 역호출 대상은 호스트만 안다(버튼·명령과
   * 같은 규칙). `needsSelectedText`는 등록 시점의 `notes:read` 부여로 굳힌다(payload 게이트).
   */
  const menuItemsOf = new Map<
    string,
    Map<
      string,
      {
        label: string;
        handlerId: string;
        when: WhenTerm[];
        needsSelectedText: boolean;
      }
    >
  >();
  /**
   * 플러그인 id → 이 빌드가 등록한 선택 액션들(`ui.addSelectionAction`). 구독·명령·메뉴
   * 항목과 같은 이유로 재빌드마다 통째로 버려진다.
   *
   * 스냅샷에는 `id`·`label`·`title`·`match`·`needsSelectedText`만 나가고 `handlerId`는 여기
   * 남는다(버튼·명령·메뉴와 같은 규칙). `match`는 **창이 로컬로** 판정하므로 그대로 나가고,
   * `needsSelectedText`는 등록 시점의 `notes:read` 부여로 굳힌다(payload 게이트).
   */
  const selectionActionsOf = new Map<
    string,
    Map<
      string,
      {
        label: string;
        title?: string;
        handlerId: string;
        match?: SelectionMatch;
        needsSelectedText: boolean;
      }
    >
  >();
  /**
   * 플러그인 id → 이 빌드가 등록한 메뉴바 트레이 항목들(`ui.addTrayItem`). 구독·명령·메뉴
   * 항목과 같은 이유로 재빌드마다 통째로 버려진다.
   *
   * 스냅샷·네이티브에는 `id`·`label`만 나가고 `handlerId`는 여기 남는다 — 네이티브는 "이 항목을
   * 실행해 달라"만 되쏘고 역호출 대상은 호스트만 안다(버튼·명령·메뉴와 같은 규칙). 트레이 클릭은
   * 창 컨텍스트가 없어 `run`을 창 없이 역호출한다([`invokeTrayItem`]).
   */
  const trayItemsOf = new Map<
    string,
    Map<string, { label: string; handlerId: string }>
  >();
  /**
   * 플러그인 id → 그 플러그인이 **공개한** 명령 id 집합(매니페스트 `exposes`).
   *
   * 왜 여기 두나: `commands.invoke` 릴레이가 "대상이 이 명령을 공개했는가"를 판정하는 유일한
   * 자리다(공개는 대상의 **정적 선언**이라 명령 등록 맵 `commandsOf`와 별개다 — 공개했지만
   * 등록 안 한 명령은 `INVOKE_NO_TARGET`, 등록했지만 공개 안 한 명령은 `INVOKE_NOT_EXPOSED`).
   * 재빌드마다 다시 채워진다(`runPlugin`이 set, dispose가 delete) — 매니페스트가 정본이므로
   * 살아있는 상태가 아니라 선언의 사본이지만, 명령·구독과 수명을 맞춰 둔다.
   */
  const exposesOf = new Map<string, ReadonlySet<string>>();
  /**
   * 플러그인 id → `memo.storage.session` 값 — 중앙 호스트 **프로세스 메모리**.
   *
   * 노트 창 리로드에는 살아남고 재빌드에서 사라진다… 가 아니라 **재빌드에도 살아남는다**:
   * `build()`가 비우지 않기 때문이다. 왜 그렇게 정했나: 설정을 한 글자 바꿀 때마다 재빌드가
   * 도는데, 그때마다 캐시가 날아가면 `session`은 `local`의 못 쓰는 사본이 된다. 사라지는
   * 시점은 **중앙 호스트 창이 죽을 때**(앱 종료·호스트 재생성)이고, 그것이 이 스코프가
   * 약속하는 수명이다. 서랍 하나의 용량은 [`MAX_MEMORY_STORE_BYTES`]로 막는다(디스크
   * 스코프와 같은 상한 — 상주 호스트를 메모리로 죽이는 길을 열어 두지 않는다).
   */
  const sessionStore = new Map<string, MemoryStore>();
  /**
   * `${pluginId}\n${windowLabel}` → `memo.storage.window` 값.
   *
   * 창 식별자는 플러그인에게 **절대 노출되지 않는다** — 호스트가 이미 소유한 컨텍스트
   * 토큰에서 창 라벨을 되짚어 키 네임스페이스로 쓸 뿐이다. 그래서 플러그인은 창 관리 코드를
   * 짤 필요도, 남의 창 상태를 가리킬 방법도 없다.
   */
  const windowStore = new Map<string, MemoryStore>();
  /** 이번 빌드에서 실제로 실행 중인 플러그인 id(의 `plugin.<id>.enabled` 판정 입력). */
  let enabledPluginIds: ReadonlySet<string> = new Set<string>();
  /** 현재 OS 식별자(의 `platform.*` 판정 입력) — 읽지 못했으면 빈 문자열. */
  let platformId = "";
  /**
   * 앱 버전(`runtime.info().hostVersion`) — build()가 갱신한다. 단일 핫리로드가
   * 재빌드 없이 한 플러그인만 다시 실행할 때, `runtimeEnv`가 이 캐시로 같은 실행 정체를 준다
   * (전체 빌드와 한 플러그인이 다른 hostVersion을 보면 도그푸딩이 거짓이 된다).
   */
  let hostVersionValue = "";
  /**
   * 활성 로케일 코드(`runtime.info` 확장 필드가 아니라 `memo.i18n.locale()`의 값) —
   * `hostVersionValue`와 같은 캐싱 결(build()/rebuildPlugin()이 갱신, `runtimeEnv`가 읽는다).
   *
   * **플러그인 루프보다 먼저 `deps.activeLocale()`을 fetch해 채운다.** 그 콜백
   * (`bootstrap/plugin-host.ts`의 `resolveHostLocale`)은 이 창의 로케일 저장소 등록·활성 전환
   * 까지 함께 끝내는 유일한 소유자라, 늦게 부르면 이번 빌드에서 도는 플러그인이 전부
   * **직전 빌드**의 로케일을 보게 된다(언어를 막 바꾼 빌드에서 `i18n.locale()`이 새 언어를
   * 아직 모르고, 새 값은 다음 재빌드부터야 보이는 한 세대 지연). 먼저 읽어 두면 그 지연이
   * 아예 생기지 않는다.
   */
  let localeValue = "ko";
  /**
   * 플러그인 id → 이 빌드의 설정 바인딩과 스키마(의 폼 경로가 옛 값을 읽는 데 쓴다).
   *
   * 왜 필요한가: 설정 창은 "무엇을 저장했는지"만 알고 "직전 값이 무엇이었는지"는 모른다.
   * 호스트의 인메모리 바인딩이 재빌드 전까지 옛 값을 들고 있으므로, `oldValue`를 아는 곳이
   * 여기뿐이다.
   */
  const settingsOf = new Map<
    string,
    { get(key: string): unknown; schema: PluginSettingField[] }
  >();
  /**
   * 런타임 진단 기록 — 플러그인별 링버퍼. **재빌드에도 비우지 않는다**: 설정을 한 번
   * 바꿀 때마다 재빌드가 돌므로, 비우면 저작자가 방금 만든 증거가 바로 사라진다.
   */
  const diagnostics = createDiagnosticsLog();
  /** 창-스코프 호출 대기표(requestId → 응답 처리기). */
  const windowCalls = new Map<
    string,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  let nextCallSeq = 0;

  /**
   * 창-스코프 브리지 호출을 지정 노트 창으로 위임하고 응답을 기다린다.
   *
   * 역할: requestId를 발급해 [`EV_WINDOW_CALL`]을 방송하고, 대응하는
   * [`EV_WINDOW_RESULT`]가 오면 해소한다. 타임아웃(창 닫힘·응답 유실)이면 거부해
   * 게이트키퍼가 오류 응답으로 감싸게 한다(샌드박스 promise가 영원히 걸리지 않게).
   *
   * `pluginId`는 **호스트가 검증한 호출 주체**다(게이트키퍼·토큰 해석을 지난 값 — 플러그인이
   * 자칭할 수 없다). 페이로드에 실어 창 쪽 수행부가 플러그인별 네임스페이스(토스트 id 격리)에
   * 쓰게 한다.
   */
  function callWindow(
    pluginId: string,
    windowLabel: string,
    call: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = `wc-${++nextCallSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          windowCalls.delete(requestId);
          reject(new Error(`창 응답 없음: ${call}`));
        },
        INTERACTIVE_CALLS.has(call)
          ? WINDOW_CALL_INTERACTIVE_TIMEOUT_MS
          : WINDOW_CALL_TIMEOUT_MS,
      );
      windowCalls.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      deps.bus.emit(EV_WINDOW_CALL, {
        requestId,
        windowLabel,
        pluginId,
        call,
        args,
      });
    });
  }

  /**
   * 창-스코프 호출을 배달할 노트 창 라벨을 정한다.
   *
   * 역할: 샌드박스가 실어 보낸 컨텍스트 토큰(`ctx`)이 있으면 호스트가 발급한 것인지,
   * 그리고 **그 플러그인의 것인지** 확인해 그 클릭의 창을 쓴다. 토큰이 없을 때만 마지막
   * 클릭 창으로 폴백한다.
   * 왜: 토큰 해석을 호스트가 독점해야 샌드박스가 창 라벨을 스스로 정해 남의 창에 쓰는 일을
   * 막는다 — 모르는 토큰은 폴백이 아니라 거부(`none`)다.
   *
   * 검사하는 것은 소유권 + (민감 호출이면) **유휴 만료**다. `sensitiveCall`이 참이고
   * 유휴가 [`INVOCATION_IDLE_TTL_MS`]를 넘겼으면 `expired`를 돌려준다 — 호출부가
   * 조용한 null이 아니라 `CONTEXT_UNAVAILABLE`로 거부하고 진단을 남긴다. 진행 중
   * (`inflight > 0`) 토큰은 만료로 판정하지 않고, 통과한 컨텍스트는 활동 시각을 갱신한다
   * (저위험 호출도 갱신한다 — 활동이 있는 컨텍스트를 살리는 것이 유휴 기준의 정의다).
   *
   * 유휴 만료는 **폴백 경로에도 똑같이** 적용된다: 토큰 없는 민감 호출이 무기한 "마지막
   * 클릭 창"을 탈 수 있으면, 만료를 우회하는 방법이 곧 "토큰을 싣지 않는 것"이 된다(실증 —
   * 클릭 3시간 뒤 토큰을 실은 `notes.current`는 거부됐지만 토큰을 뺀 같은 호출은 성공했다).
   * 만료 거부는 어느 경로든 활동이 아니다 — `lastUsed`를 갱신하지 않는다.
   */
  function resolveWindow(
    pluginId: string,
    ctx: string | undefined,
    sensitiveCall = false,
  ):
    | { kind: "window"; window: string }
    | { kind: "none" }
    | { kind: "expired" } {
    if (ctx !== undefined && ctx !== "") {
      const owner = invocations.get(ctx);
      if (!owner || owner.pluginId !== pluginId) return { kind: "none" };
      // window==""는 **깊이 반송 전용 토큰**(창 컨텍스트 없는 릴레이가 relayDepth만
      // 나르려고 발급한 것)이다. 자기 창이 없으므로 창-스코프 라우팅에서는 빈 토큰과 똑같이
      // 폴백("마지막 클릭 창") 계약을 타야 한다 — 그냥 window:""를 돌려주면 아무도 없는
      // 라벨로 창 호출을 보내 초 단위 타임아웃만 기다린다. 그래서 아래 폴백으로 흘려보낸다
      // (깊이 조회는 commands.invoke가 invocations에서 직접 읽으므로 이 폴백과 무관하다).
      if (owner.window !== "") {
        if (
          sensitiveCall &&
          owner.inflight === 0 &&
          Date.now() - owner.lastUsed > INVOCATION_IDLE_TTL_MS
        ) {
          // 만료 거부는 활동이 아니다 — lastUsed를 갱신하지 않는다(거부 재시도로 토큰이
          // 되살아나면 만료가 무의미해진다).
          return { kind: "expired" };
        }
        owner.lastUsed = Date.now();
        // 쓰인 토큰을 최근으로 승급한다(Map은 삽입 순 반복 → 재삽입이 LRU 갱신).
        invocations.delete(ctx);
        invocations.set(ctx, owner);
        return { kind: "window", window: owner.window };
      }
    }
    const fallback = contexts.get(pluginId);
    if (fallback === undefined) return { kind: "none" };
    if (
      sensitiveCall &&
      // 진행 중(대화형 팝업 대기 등) 폴백은 만료로 판정하지 않는다 — 토큰 경로의
      // `owner.inflight === 0`과 대칭. 이게 없으면 토큰 없는 팝업이 오래 열려 있는 동안
      // 곁가지 민감 호출이 조용히 거부된다.
      fallback.inflight === 0 &&
      Date.now() - fallback.lastUsed > INVOCATION_IDLE_TTL_MS
    ) {
      return { kind: "expired" };
    }
    fallback.lastUsed = Date.now();
    return { kind: "window", window: fallback.window };
  }

  /**
   * 버튼 클릭 1건에 불투명 컨텍스트 토큰을 발급해 기록한다(상한으로 누수 방지).
   *
   * 왜: 이 클릭에서 파생된 창-스코프 호출이 "마지막 클릭 창"이 아니라 **자기 클릭의 창**으로
   * 가게 하는 열쇠다. 값은 순번 문자열이지만 의미 해석은 호스트 맵에서만 일어난다.
   * 폐기는 LRU(가장 오래 안 쓰인 것부터)이고, 응답을 기다리는 중(`inflight > 0`)인 토큰은
   * 건너뛴다 — 10분짜리 팝업이 떠 있는 체인이 남의 클릭 폭주에 잘려 나가지 않게.
   */
  function issueInvocation(
    pluginId: string,
    windowLabel: string,
    relayDepth = 0,
  ): string {
    const token = `inv-${++nextInvocationSeq}`;
    invocations.set(token, {
      pluginId,
      window: windowLabel,
      inflight: 0,
      lastUsed: Date.now(),
      ...(relayDepth > 0 ? { relayDepth } : {}),
    });
    if (invocations.size <= MAX_INVOCATIONS) return token;
    for (const [key, entry] of invocations) {
      if (invocations.size <= MAX_INVOCATIONS) break;
      if (entry.inflight > 0 || key === token) continue; // 진행 중·방금 발급분은 보호.
      invocations.delete(key);
    }
    return token;
  }

  /**
   * 창 응답을 기다리는 동안 그 컨텍스트를 폐기·만료에서 보호한다(참조 카운트) — 반환값은 해제
   * 함수. 대상이 없으면(폐기된 토큰, 폴백 컨텍스트 없음) 아무 일도 하지 않는다.
   *
   * 토큰이 실린 호출은 그 토큰(`invocations`)을, 토큰 없는 폴백 호출은 그 플러그인의 폴백
   * 컨텍스트(`contexts`)를 핀한다 — **양쪽 대칭**이라야 "진행 중이면 만료하지 않는다"는
   * 규칙이 두 경로에서 같아진다(폴백 경로에만 이 보호가 없으면, 토큰 없는 대화형 팝업이 열려
   * 있는 동안 곁가지 민감 폴백 호출이 유휴로 오판돼 거부된다).
   *
   * 해제가 `lastUsed`를 새로 찍는 이유(의 핵심 안전장치): 대화형 팝업(pickList/prompt)은
   * 사용자 응답을 최대 10분 기다린다 — 그 사이 만료는 `inflight`가 막지만, 응답이 돌아온
   * **직후의 후속 호출**(고른 템플릿 삽입 등)은 호출 시각 기준으로 이미 유휴 상한을 넘겨
   * 있다. 완료를 활동으로 치지 않으면 "팝업이 오래 떠 있었다는 이유만으로 삽입이 거부되는"
   * 회귀가 된다(같은 유형의 조용한 유실이 과거 LRU-FIFO 시절 실제로 터졌다). 핀 시점에
   * 붙잡은 항목을 해제 때 갱신하므로, 대기 중 사용자가 다른 창을 클릭해 폴백이 새 객체로
   * 바뀌어도 옛 완료가 새 창의 수명을 늘리지 않는다(옛 객체는 맵에서 빠진 채 갱신될 뿐이다).
   */
  function pinInvocation(pluginId: string, ctx?: string): () => void {
    const hasCtx = ctx !== undefined && ctx !== "";
    const owner = hasCtx ? invocations.get(ctx) : undefined;
    // 어떤 컨텍스트를 핀할지는 resolveWindow의 창 라우팅과 **대칭**이라야 한다: 실제 창
    // 토큰(window!=="")은 그 토큰을, window==""(깊이 반송 전용 토큰, 이나 토큰 없는
    // 폴백 호출은 그 플러그인의 폴백 컨텍스트(contexts)를 핀한다. 안 그러면 대기 중(대화형
    // 팝업 최대 10분) 폴백 컨텍스트가 보호받지 못해 만료·폐기된다. 모르는/남의 토큰(owner
    // 없음, ctx 있음)은 원래대로 아무것도 핀하지 않는다(resolveWindow가 none으로 막는 경로).
    const entry =
      owner !== undefined
        ? owner.window !== ""
          ? owner
          : contexts.get(pluginId)
        : hasCtx
          ? undefined
          : contexts.get(pluginId);
    if (!entry) return () => {};
    entry.inflight += 1;
    return () => {
      entry.inflight = Math.max(0, entry.inflight - 1);
      entry.lastUsed = Date.now();
    };
  }

  /**
   * (플러그인, 창) 조합의 이벤트용 컨텍스트 토큰을 얻는다(없거나 폐기됐으면 새로 발급).
   *
   * 왜 토큰이 필요한가: 상주 샌드박스 1개가 모든 노트 창을 공유하므로, `note:saved` 핸들러
   * 안에서 부른 `memo.ui.toast`가 **그 저장이 일어난 창**으로 가야 한다. 토큰이 없으면
   * "마지막으로 클릭된 창" 폴백을 타 A 창의 저장 알림이 B 창에 뜬다(버튼 클릭에서 이미
   * 겪은 데이터 손상과 같은 유형).
   */
  function eventToken(pluginId: string, windowLabel: string): string {
    const key = `${pluginId}\u0000${windowLabel}`;
    const cached = eventTokens.get(key);
    if (cached !== undefined) {
      const entry = invocations.get(cached);
      if (entry) {
        // 이벤트 배달도 활동이다 — 방금 이벤트를 받은 핸들러의 민감 호출(예:
        // `note:saved` 뒤의 `notes.current`)이 "재사용된 오래된 토큰"이라는 이유로 만료
        // 거부되면 안 된다(이벤트는 지금 그 창에서 실제로 일어난 일이다).
        entry.lastUsed = Date.now();
        return cached;
      }
    }
    const token = issueInvocation(pluginId, windowLabel);
    eventTokens.set(key, token);
    return token;
  }

  /**
   * 이벤트 1건을 구독자에게만 역호출한다(구독자 없는 이벤트는 어떤 샌드박스에도 안 간다).
   *
   * `tokenFor`는 그 플러그인에 실어 보낼 창 컨텍스트 토큰을 정한다 — 창에서 난 이벤트는
   * 그 창의 토큰을, 창이 없는 이벤트(`settings:changed`)는 빈 문자열을 준다(빈 토큰은
   * 부트스트랩에서 "컨텍스트 없음"이 되어 호스트의 기존 폴백 규칙을 탄다).
   */
  function dispatchEvent(
    name: MemoEventName,
    tokenFor: (pluginId: string) => string,
    payload: Record<string, unknown>,
    only?: string,
  ): void {
    for (const [pluginId, subs] of eventSubs) {
      if (only !== undefined && pluginId !== only) continue;
      const sandbox = sandboxes.get(pluginId);
      if (!sandbox) continue;
      let token: string | null = null;
      for (const sub of subs.values()) {
        if (sub.name !== name) continue;
        // 토큰 발급은 **실제 구독자가 있을 때만** 한다 — 없으면 invocations가 이벤트마다
        // 헛돌아 남의 클릭 토큰을 밀어낸다.
        token ??= tokenFor(pluginId);
        sandbox.invoke(sub.handlerId, token, payload);
      }
    }
  }

  /**
   * `settings:changed`를 그 플러그인에게만 통지한다(통지만, 재빌드 동작은 그대로).
   *
   * `ctx`는 이 변경을 낳은 호출의 창 토큰이다(플러그인이 스스로 `settings.set`을 부른
   * 경로에서만 있다) — 그대로 이어 실어 핸들러의 memo가 같은 창을 가리키게 한다.
   */
  function notifySettingsChanged(
    pluginId: string,
    key: string,
    oldValue: unknown,
    newValue: unknown,
    origin: "form" | "plugin",
    ctx?: string,
  ): void {
    dispatchEvent(
      "settings:changed",
      () => ctx ?? "",
      {
        name: "settings:changed",
        at: Date.now(),
        key,
        oldValue,
        newValue,
        origin,
      },
      pluginId,
    );
  }

  /**
   * 명령 1건을 실행한다 — 조건 판정 → 파괴적이면 확인 → 샌드박스 `run` 역호출.
   *
   * 왜 호스트가 판정하나: `when`의 결과는 플러그인에게 **알려주지 않는다**(의 정보 유출
   * 차단). 조건이 거짓이면 그냥 아무 일도 일어나지 않고, 그 사실만 진단에 남는다 — 안 그러면
   * 사용자는 "단축키가 먹통"이라고만 느끼고 저작자는 원인을 볼 방법이 없다.
   *
   * `note.isEmpty`는 그 창의 지금 본문을 봐야 알 수 있어 창-스코프 호출(`notes.current`)로
   * 확인한다. 그 호출은 `notes:read` 게이트를 타므로, 권한 없는 플러그인이 조건을 통해
   * 본문 상태를 엿보는 우회로가 되지 않는다(게이트키퍼를 그대로 통과시킨다).
   */
  async function invokeCommand(
    pluginId: string,
    commandId: string,
    windowLabel: string,
    token: string,
    /**
     * 명령 `run`의 둘째 인자로 전달할 페이로드(플러그인 간 호출이 실어 보낸 args).
     * 단축키·설정 버튼 실행 경로는 주지 않는다(undefined → 페이로드 없는 기존 역호출 그대로).
     */
    payload?: unknown,
  ): Promise<void> {
    const command = commandsOf.get(pluginId)?.get(commandId);
    const sandbox = sandboxes.get(pluginId);
    if (!command || !sandbox) return;
    /**
     * 창 없는 실행(설정 화면 액션 버튼, 에서 **창에 물어봐야만 알 수 있는 단계**를 끊는다.
     *
     * 왜 끊나: 빈 라벨로 `callWindow`를 부르면 아무도 응답하지 않아 타임아웃(초 단위)을
     * 기다린 뒤 같은 결론에 도달한다. 결론이 같다면 기다리지 않는 편이 낫고, 무엇보다
     * **이유를 남기는 것**이 이 분기의 값이다 — 저작자가 "설정 버튼이 먹통"의 원인을 볼
     * 유일한 창구가 진단 채널이다.
     */
    const needsWindow = (why: string): boolean => {
      if (windowLabel !== "") return false;
      diagnostics.record({
        pluginId,
        kind: "no-window-context",
        call: "commands.register",
        message: `설정 화면에서 「${command.title}」을(를) 실행하지 못했습니다: ${why}`,
      });
      return true;
    };
    const settingsBinding = settingsOf.get(pluginId);
    const staticWhen = evaluateStaticWhen(command.when, {
      platform: platformId,
      enabledPlugins: enabledPluginIds,
      setting: (key) => settingsBinding?.get(key),
    });
    let allowed = staticWhen.value;
    if (allowed && staticWhen.pending.length > 0) {
      if (needsWindow("when 조건은 메모 창의 상태를 봐야 판정할 수 있습니다")) {
        return;
      }
      // 남은 항목은 `note.isEmpty` 하나뿐이다(어휘가 그렇게 좁다) — 창에 한 번만 물어본다.
      //
      // 이 호출은 **호스트가 자기 판단을 위해** 하는 것이라 플러그인 권한 게이트를 태우지
      // 않는다(본문은 호스트 밖으로 한 글자도 나가지 않는다). 남는 것은 "명령이 돌았는가"
      // 라는 1비트 추론뿐이고, 그건 사용자가 단축키를 눌러야만 얻어지므로 `notes:read`를
      // 요구할 만한 노출이 아니다 — 대신 그 1비트가 존재한다는 사실은 계약에 적는다.
      const note = (await callWindow(
        pluginId,
        windowLabel,
        "notes.current",
        {},
      ).catch(() => undefined)) as { content?: unknown } | null | undefined;
      if (note === undefined) {
        // 창이 응답하지 않았다 = 조건을 **모른다**. 모르는 채로 실행하면 저작자가 "빈 노트일
        // 때만"이라고 건 조건이 조용히 깨진다 — 실행하지 않고 이유를 남긴다.
        diagnostics.record({
          pluginId,
          kind: "no-window-context",
          call: "commands.register",
          message: `창이 응답하지 않아 when 조건을 확인하지 못했습니다(「${command.title}」 실행 안 함)`,
        });
        return;
      }
      const isEmpty = String(note?.content ?? "").trim() === "";
      for (const term of staticWhen.pending) {
        if (isEmpty === term.negated) allowed = false;
      }
    }
    if (!allowed) {
      diagnostics.record({
        pluginId,
        kind: "call-reject",
        call: "commands.register",
        code: "INVALID_ARGS",
        message: `when 조건이 맞지 않아 「${command.title}」을(를) 실행하지 않았습니다: ${command.when.map((t) => (t.negated ? `!${t.key}` : t.key)).join(", ")}`,
      });
      return;
    }
    if (command.destructive) {
      if (
        needsWindow(
          "확인 팝업을 띄울 메모 창이 없습니다 — 매니페스트 설정 필드의 confirm으로 확인을 받으세요",
        )
      ) {
        return;
      }
      // 확인 UI는 노트 창이 이미 가진 목록 팝업을 쓴다 — 호스트(숨김 창)에는 사용자에게
      // 보일 표면이 없고, 전용 `ui.confirm` 창-스코프 호출을 새로 여는 것은 이 담당의 소유
      // 밖(host-client)이다. Esc·바깥 클릭은 null로 와서 그대로 중단된다.
      //
      // 취소는 **보이는 버튼이자 기본 포커스**다(confirm-dialog의 취소 버튼 관행): 액션 줄은
      // 선언 순서대로 그려지고 팝업은 첫 버튼을 포커스하므로, 취소를 앞에 두면 Enter/Space가
      // 곧장 「실행」에 먹히지 않는다 — 자동 포커스된 실행 버튼 하나뿐인 확인 팝업은 실수
      // 방지라는 존재 이유를 스스로 무효화한다. 「실행」은 destructive 스타일(빨강)로 성격을
      // 드러낸다.
      const choice = await callWindow(pluginId, windowLabel, "ui.pickList", {
        title: t("plugin.command-confirm.title", { title: command.title }),
        placeholder: t("plugin.command-confirm.placeholder"),
        items: [
          {
            id: "confirm",
            label: command.title,
            actions: [
              { id: "cancel", label: t("plugin.command-confirm.cancel") },
              {
                id: "run",
                label: t("plugin.command-confirm.run"),
                style: "destructive",
              },
            ],
          },
        ],
      }).catch(() => null);
      const actionId =
        typeof choice === "object" && choice !== null
          ? String((choice as { actionId?: unknown }).actionId ?? "")
          : "";
      if (actionId !== "run") return;
    }
    sandbox.invoke(command.handlerId, token, payload);
  }

  /**
   * 메뉴 전용 항목 1건을 실행한다(`ui.addMenuItem`의 `run` 역호출).
   *
   * `when`(표시 조건)은 이미 **노트 창이 렌더 시점에** 판정했다(보이지 않는 항목은 클릭될 수
   * 없다) — 그래서 여기서 다시 보지 않는다(명령과 달리 판정 주체가 창이다).
   *
   * `payload.selectedText`는 **`notes:read`가 부여됐을 때만** 싣는다: 등록 시점에 굳힌
   * `needsSelectedText`를 신뢰하되(그 값 자체가 부여로 판정됐다), 노트 창이 보낸 값이 있을
   * 때만 채운다. 부여가 없으면 창이 애초에 안 보내고, 와도 여기서 뺀다 — `ui` 권한만으로
   * 본문(선택 텍스트)이 새지 않게 하는 payload 단위 게이트다.
   */
  function invokeMenuItem(
    pluginId: string,
    menuItemId: string,
    token: string,
    selectedText?: string,
  ): void {
    const item = menuItemsOf.get(pluginId)?.get(menuItemId);
    const sandbox = sandboxes.get(pluginId);
    if (!item || !sandbox) return;
    const payload: Record<string, unknown> = {};
    if (item.needsSelectedText && typeof selectedText === "string") {
      payload.selectedText = selectedText;
    }
    sandbox.invoke(item.handlerId, token, payload);
  }

  /**
   * 선택 액션 1건을 실행한다(`ui.addSelectionAction`의 `run` 역호출).
   *
   * `match`(표시 조건)는 이미 **노트 창이** 판정했다(툴바에서는 버튼이 뜨지 않았고, 단축키
   * 경로에서는 키맵이 실행 전에 같은 순수 함수로 걸렀다) — 그래서 여기서 다시 보지 않는다
   * (메뉴 항목의 `when`과 같은 규칙: 판정 주체가 창이다).
   *
   * `payload.selectedText`는 메뉴 항목과 **글자 그대로 같은 계약**이다: 등록 시점에 굳힌
   * `needsSelectedText`(그 값 자체가 `notes:read` 부여로 판정됐다)가 참이고 창이 실제로 보낸
   * 값이 있을 때만 채운다 — `ui` 권한만으로 본문이 새지 않게 하는 payload 단위 게이트다.
   */
  function invokeSelectionAction(
    pluginId: string,
    actionId: string,
    token: string,
    selectedText?: string,
  ): void {
    const action = selectionActionsOf.get(pluginId)?.get(actionId);
    const sandbox = sandboxes.get(pluginId);
    if (!action || !sandbox) return;
    const payload: Record<string, unknown> = {};
    if (action.needsSelectedText && typeof selectedText === "string") {
      payload.selectedText = selectedText;
    }
    sandbox.invoke(action.handlerId, token, payload);
  }

  /**
   * 메뉴바 트레이 항목 1건을 실행한다(`ui.addTrayItem`의 `run` 역호출).
   *
   * **창 컨텍스트 없이** 역호출한다(빈 토큰): 트레이는 특정 노트 창과 무관한 앱 전역 자원이라
   * 클릭이 어느 창에서도 오지 않는다 — 설정 화면 액션 버튼과 **정확히 같은 계약**이다.
   * 그래서 `run` 안의 창-스코프 호출(`ui.toast`·`editor.insertText`·`notes.current`)은 마지막으로
   * 쓴 메모 창으로 폴백하거나, 그마저 없으면 `CONTEXT_UNAVAILABLE` + 진단으로 끝난다.
   *
   * 기존 폴백 컨텍스트가 있으면 그 활동 시각만 갱신한다(EV_BUTTON_INVOKE의 빈 라벨 분기와 같은
   * 이유): 트레이 클릭도 '이 플러그인에 대한 지금의 사용자 활동'이라, 뒤이은 민감 폴백 호출이
   * 5분 전 노트-창 클릭 기준으로 유휴 만료되는 모순을 막는다. 폴백 컨텍스트를 **만들지는**
   * 않는다(트레이엔 창이 없어 만들 창 라벨이 없다 — ""를 창으로 기억하면 이후 폴백이 아무도 없는
   * 창으로 타임아웃한다).
   */
  function invokeTrayItem(pluginId: string, trayItemId: string): void {
    const item = trayItemsOf.get(pluginId)?.get(trayItemId);
    const sandbox = sandboxes.get(pluginId);
    if (!item || !sandbox) return;
    const existing = contexts.get(pluginId);
    if (existing) existing.lastUsed = Date.now();
    sandbox.invoke(item.handlerId, "", {});
  }

  /**
   * 게이트키퍼를 통과한 브리지 호출의 호스트 측 수행부를 만든다(플러그인 1개 전용).
   *
   * 역할: settings.get/set은 호스트가 소유한 스냅샷·영속화로, 툴바 버튼 등록은 직렬화
   * 버튼 수집으로, 창-스코프 호출(toast·글자 델타·클립보드·현재 노트)은 **그 호출을 낳은
   * 클릭의 창**으로 위임한다. 나머지 등록 호출은 registrar로 라우팅한다.
   * 왜: 창-스코프 호출은 "어느 창의 것인가"가 필요하다. 클릭마다 발급한 불투명 토큰(`ctx`)이
   * 있으면 그것으로 정확히 되짚고(창 여러 개에서 동시에 팝업이 떠 있어도 안 섞인다), 토큰이
   * 없는 호출(로드 시점 등)만 "마지막 클릭 창" 폴백을 쓴다. 어느 쪽도 없으면 조용히 null을
   * 돌려줘 플러그인이 방어적으로 처리하게 한다.
   */
  function makeHostExecutor(
    pluginId: string,
    registrar: ReturnType<typeof makeRegistrar>,
    /**
     * 이 플러그인이 등록한 툴바 버튼(id → 버튼). 배열이 아니라 **Map**인 이유는 등록 계약이
     * registrar와 같기 때문이다 — 같은 id는 append가 아니라 치환이고, `Map.set`은 기존
     * 키의 자리를 유지하므로 치환이 순서를 흔들지 않는다.
     */
    buttons: Map<string, SnapshotToolbarButton>,
    /**
     * 이 플러그인이 등록한 상태 표시형 아이템(id → 아이템). 버튼과 같은 등록 계약:
     * id 생략 시 자동 생성, 같은 id는 append가 아니라 치환이고 `Map.set`이 자리를 유지한다.
     * 버튼과 별도 Map인 이유는 SnapshotStatusItem 문서 참고(역호출 핸들러가 없다).
     */
    statusItems: Map<string, SnapshotStatusItem>,
    /**
     * 이 플러그인의 이벤트 구독 — 버튼과 같은 등록 계약이다(id 생략 시 자동 생성, 같은
     * id는 치환). 호출자가 소유한 Map을 받아 채운다(빌드 완료 시 `eventSubs`로 넘어간다).
     */
    subscriptions: Map<string, { name: MemoEventName; handlerId: string }>,
    /**
     * 이 플러그인의 명령 등록 — 버튼과 같은 등록 계약(id 생략 시 자동 생성, 같은 id는
     * 치환). 호출자가 소유한 Map을 받아 채운다(빌드 완료 시 `commandsOf`로 넘어간다).
     */
    commands: Map<
      string,
      {
        title: string;
        handlerId: string;
        when: WhenTerm[];
        destructive: boolean;
      }
    >,
    /**
     * 이 플러그인의 메뉴 전용 항목 등록 — 버튼·명령과 같은 등록 계약(id 생략 시 자동
     * 생성, 같은 id는 치환). 호출자가 소유한 Map을 받아 채운다(빌드 완료 시 `menuItemsOf`로 넘어간다).
     */
    menuItems: Map<
      string,
      {
        label: string;
        handlerId: string;
        when: WhenTerm[];
        needsSelectedText: boolean;
      }
    >,
    /**
     * 이 플러그인의 선택 액션 등록 — 버튼·명령·메뉴와 같은 등록 계약(id 생략 시 자동 생성,
     * 같은 id는 치환). 호출자가 소유한 Map을 받아 채운다(빌드 완료 시 `selectionActionsOf`로
     * 넘어간다).
     */
    selectionActions: Map<
      string,
      {
        label: string;
        title?: string;
        handlerId: string;
        match?: SelectionMatch;
        needsSelectedText: boolean;
      }
    >,
    /**
     * 이 플러그인의 메뉴바 트레이 항목 등록 — 버튼·명령·메뉴와 같은 등록 계약(id 생략 시
     * 자동 생성, 같은 id는 치환). 호출자가 소유한 Map을 받아 채운다(빌드 완료 시 `trayItemsOf`로
     * 넘어가고, 평탄화돼 네이티브 트레이로 배달된다).
     */
    trayItems: Map<string, { label: string; handlerId: string }>,
    /**
     * 이 플러그인의 권한 상태 — 이벤트 **이름별** 추가 권한 판정에 쓴다.
     *
     * 게이트키퍼(`host.ts`)는 호출 1개당 권한 1개만 볼 수 있어 `events.on`의 바닥 권한
     * (`settings`)까지만 판정한다. 노트 이벤트가 요구하는 `notes:read`는 여기서 **같은**
     * `checkPermission`으로 한 번 더 좁힌다 — 게이트를 넓히는 우회가 아니라 좁히는 검사다.
     */
    grant: PluginGrant,
    settings: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
    },
    /** 이 플러그인의 매니페스트 설정 스키마(값 구조화·기본값 병합의 기준). */
    schema: PluginSettingField[],
    /** 번들(빌트인)인가 — `storage.local`의 백엔드 네임스페이스를 가른다. */
    builtin: boolean,
  ): (
    call: string,
    args: Record<string, unknown>,
    ctx?: string,
  ) => Promise<unknown> {
    const fieldOf = (key: string): PluginSettingField | undefined =>
      schema.find((f) => f.key === key);
    // 저작자가 id를 생략한 버튼에 붙이는 순번(registrar의 autoSeq와 같은 역할).
    let autoButtonSeq = 0;
    let autoStatusSeq = 0;
    let autoEventSeq = 0;
    let autoCommandSeq = 0;
    let autoMenuSeq = 0;
    let autoSelectionSeq = 0;
    let autoTraySeq = 0;
    return (call, args, ctx) => {
      if (call === "settings.get") {
        // **객체 인자 `{ key }`만 받는다**(엄격) — 문자열 축약형은 제거했다. `list`는 언제나
        // `{name,body}[]`로 구조화해 주고, 저장 블롭을 그대로 받는 `raw` 탈출구도 없다. 인자
        // 판정은 하니스와 공유하는 순수 함수가 한다(host-executor-validators).
        const arg = resolveSettingsGetArg(args as unknown);
        if (!arg.ok) return Promise.reject(arg.error);
        return Promise.resolve(
          toPluginSettingValue(fieldOf(arg.key), settings.get(arg.key) ?? null),
        );
      }
      if (call === "settings.getAll") {
        // 병합된 스냅샷 1회 반환 — 선언된 모든 키가 유효한 값을 갖는다. 키를 하나씩
        // 정확히 맞춰야 하는 부담을 없애고, 기본값이 런타임에 실제로 도달함을 보장한다.
        // 스냅샷 구성은 하니스와 공유하는 순수 함수가 한다(값 읽기 백엔드만 여기서 준다).
        return Promise.resolve(
          buildSettingsSnapshot(schema, (key) => settings.get(key)),
        );
      }
      if (call === "settings.set") {
        const key = String(args.key);
        const field = fieldOf(key);
        // 미선언 키는 백엔드가 버린다(설치 경로) — 예전엔 브리지가 ok를 돌려줘 저작자가
        // "저장했는데 다음 실행에 없다"를 겪었다. 거부하지는 않되(번들 경로는 백엔드가
        // 키 형식만 보므로 하위호환) 진단으로 반드시 남긴다.
        if (!field) {
          diagnostics.record({
            pluginId,
            kind: "setting-key-undeclared",
            call,
            message: `매니페스트 settings에 선언되지 않은 키: ${key}`,
          });
        }
        // 통지는 저장 **직전에** 옛 값을 떠 둔다 — set 뒤에 읽으면 새 값이라 oldValue가
        // 늘 newValue와 같아진다(있으나 마나 한 페이로드가 된다).
        const before = toPluginSettingValue(field, settings.get(key) ?? null);
        const stored = fromPluginSettingValue(field, args.value);
        settings.set(key, stored);
        // 같은 플러그인이 스스로 쓴 값도 통지한다(Chrome storage.onChanged와 같은 이디엄) —
        // 자기 창 여러 개 중 하나만 값을 바꿨을 때 나머지가 갱신될 유일한 경로다. 자기가 쓴
        // 값에 자기가 반응해 다시 쓰는 루프는 저작자 몫이라 `.d.ts`가 경고한다.
        notifySettingsChanged(
          pluginId,
          key,
          before,
          toPluginSettingValue(field, stored ?? null),
          "plugin",
          ctx,
        );
        return Promise.resolve(null);
      }
      if (call === "events.on") {
        // 이름은 닫힌 열거다 — 오타를 조용히 받아 두면 "구독은 됐는데 영원히 안 불린다"가
        // 되어 저작자가 원인을 찾을 방법이 없다(무음 실패). 검증은 하니스와 공유하는 순수
        // 함수가 한다(유효 목록을 문구에 실어 준다).
        const nameCheck = checkEventName(args.name);
        if (!nameCheck.ok) return Promise.reject(nameCheck.error);
        const name = nameCheck.name;
        // handlerId는 부트스트랩이 `handler` 함수를 바꿔 실어 보내는 값 — 비었다는 것은 곧
        // handler가 없다는 뜻이다(등록해 봐야 부를 것이 없다).
        const handlerId = String(args.handlerId ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "events.on에는 handler 함수가 필요합니다(없으면 이벤트가 나도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // 이름별 추가 권한(노트 이벤트 → notes:read). 게이트키퍼가 이미 바닥 권한을 봤으므로
        // 여기서 통과하지 못하는 것은 "이 이름만" 못 듣는 경우다(하니스와 공유하는 판정).
        const permError = checkEventExtraPermission(grant, name);
        if (permError !== null) return Promise.reject(permError);
        const givenId = String(args.id ?? "");
        const id =
          givenId || autoRegistrationId(pluginId, call, ++autoEventSeq);
        if (subscriptions.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 구독해 앞의 구독을 대체했습니다: ${id}`,
          });
        }
        subscriptions.set(id, { name, handlerId });
        // 등록 마감(ready) 뒤에 도착한 구독은 이번 실행에서 **발화하지 않을 수 있다**: 노트
        // 창의 발신 게이트가 빌드 시점의 이름 목록으로 굳어 있어서다. 다른 등록(버튼·패턴)이
        // 조용히 유실되는 것과 같은 계약이지만, 이벤트는 "안 불리는 것"이 정상과 구별되지
        // 않으므로 반드시 흔적을 남긴다.
        if (snapshot !== null && !snapshot.subscribedEvents?.includes(name)) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: "INVALID_ARGS",
            message: `등록 마감 뒤에 구독해 이번 실행에서는 ${name}이(가) 발화하지 않습니다 — 구독은 runtime.ready() 전에 하세요`,
          });
        }
        return Promise.resolve({ id });
      }
      if (call === "commands.register") {
        // `run$id`는 부트스트랩이 `run` 함수를 바꿔 실어 보낸 핸들러 id다 — 비었다는 것은 곧
        // **run이 없다**는 뜻이라, 단축키를 걸어도 아무 일도 일어나지 않는 명령이 만들어진다.
        const handlerId = String(args["run$id"] ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "commands.register에는 run 함수가 필요합니다(없으면 단축키를 걸어도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // title은 단축키 화면에 보일 **유일한** 이름이다. 비면 사용자는 정체불명의 빈 행에
        // 키를 배정하게 된다(어느 플러그인의 무엇인지 알 방법이 없다 — 하니스와 공유하는 판정).
        const titleCheck = checkCommandTitle(args.title);
        if (!titleCheck.ok) return Promise.reject(titleCheck.error);
        const title = titleCheck.title;
        // when은 닫힌 어휘다 — 모르는 키를 통과시키면 그 조건은 영원히 평가되지 않고
        // 저작자는 "조건이 무시되는지 항상 참인지"조차 알 수 없다.
        const when = parseWhenClause(
          args.when,
          schema.map((f) => f.key),
        );
        if (!when.ok) {
          return Promise.reject(bridgeError("INVALID_ARGS", when.error));
        }
        const givenId = String(args.id ?? "");
        const id =
          givenId || autoRegistrationId(pluginId, call, ++autoCommandSeq);
        if (commands.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 명령을 대체했습니다: ${id}`,
          });
        }
        commands.set(id, {
          title,
          handlerId,
          when: when.terms,
          destructive: args.destructive === true,
        });
        // 등록 마감(ready) 뒤에 도착한 명령은 이미 배달된 스냅샷에 없다 = 단축키 화면에도
        // 뜨지 않는다. 버튼과 같은 계약이지만, 명령은 툴바에 흔적조차 없어 "등록했는데
        // 아무 데도 없다"가 되므로 반드시 이유를 남긴다.
        if (snapshot !== null) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: "INVALID_ARGS",
            message: `등록 마감 뒤에 등록해 이번 실행의 단축키 목록에는 「${title}」이(가) 없습니다 — 명령 등록은 runtime.ready() 전에 하세요`,
          });
        }
        return Promise.resolve({ id });
      }
      if (call === "ui.addMenuItem") {
        // `run$id`는 부트스트랩이 `run` 함수를 바꿔 실어 보낸 핸들러 id다 — 비었다는 것은 곧
        // **run이 없다**는 뜻이라, 메뉴에 떠도 눌러도 아무 일이 안 일어나는 항목이 된다.
        const handlerId = String(args["run$id"] ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addMenuItem에는 run 함수가 필요합니다(없으면 메뉴에서 눌러도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // label은 메뉴에 보일 **유일한** 문자열이다(툴바 버튼과 달리 글리프 폴백이 없다) —
        // 비면 사용자는 빈 메뉴 줄을 보게 된다.
        const label = String(args.label ?? "").trim();
        if (label === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addMenuItem에는 비어 있지 않은 label이 필요합니다(메뉴에 보일 이름)",
            ),
          );
        }
        // when은 메뉴 항목 전용 어휘(창 상태 두 키)로 판정한다 — 정적 키는 렌더 시점의
        // 노트 창이 못 봐서 거부된다(loader.ts의 MENU_WHEN_KEYS).
        const when = parseWhenClause(
          args.when,
          schema.map((f) => f.key),
          { menu: true },
        );
        if (!when.ok) {
          return Promise.reject(bridgeError("INVALID_ARGS", when.error));
        }
        const givenId = String(args.id ?? "");
        const id = givenId || autoRegistrationId(pluginId, call, ++autoMenuSeq);
        if (menuItems.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 메뉴 항목을 대체했습니다: ${id}`,
          });
        }
        // payload.selectedText 게이트: 선택 텍스트는 본문의 일부라 `notes:read`가 있어야 준다
        // (없으면 run은 payload에서 그 필드를 못 본다). 등록 시점에 굳혀 스냅샷·역호출이 같은
        // 판정을 쓰게 한다.
        const needsSelectedText = checkPermission(grant, "notes:read").allowed;
        menuItems.set(id, {
          label,
          handlerId,
          when: when.terms,
          needsSelectedText,
        });
        if (snapshot !== null) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: "INVALID_ARGS",
            message: `등록 마감 뒤에 등록해 이번 실행의 컨텍스트 메뉴에는 「${label}」이(가) 없습니다 — 메뉴 항목 등록은 runtime.ready() 전에 하세요`,
          });
        }
        return Promise.resolve({ id });
      }
      if (call === "ui.addSelectionAction") {
        // `run$id`는 부트스트랩이 `run` 함수를 바꿔 실어 보낸 핸들러 id다(명령·메뉴 항목과
        // 같은 규칙) — 비었다는 것은 곧 **run이 없다**는 뜻이라, 선택 툴바에 떠도 눌러도
        // 아무 일이 안 일어나는 버튼이 된다.
        const handlerId = String(args["run$id"] ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addSelectionAction에는 run 함수가 필요합니다(없으면 눌러도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // label은 좁은 플로팅 바에 보일 **유일한** 문자열이다(글리프 폴백이 없다) — 비면
        // 사용자는 정체불명의 빈 버튼을 보게 된다(addMenuItem·addTrayItem과 같은 판정).
        const label = String(args.label ?? "").trim();
        if (label === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addSelectionAction에는 비어 있지 않은 label이 필요합니다(선택 툴바 버튼에 보일 글자)",
            ),
          );
        }
        // match는 닫힌 어휘(문자 부류·singleLine·maxLength)로 판정한다 — 정규식을 받지
        // 않는 이유는 인라인 패턴의 구분자와 같다(ReDoS + 호스트가 대신 판정). 어휘 밖
        // 값은 조용히 버리지 않고 거부한다(조건이 넓어진 버튼이 뜨는 무음 실패를 막는다).
        const match = parseSelectionMatch(args.match);
        if (!match.ok) {
          return Promise.reject(bridgeError("INVALID_ARGS", match.reason));
        }
        const givenId = String(args.id ?? "");
        const id =
          givenId || autoRegistrationId(pluginId, call, ++autoSelectionSeq);
        if (selectionActions.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 선택 액션을 대체했습니다: ${id}`,
          });
        }
        const title = String(args.title ?? "").trim();
        // payload.selectedText 게이트: 메뉴 항목과 **글자 그대로 같은 계약**이다(선택 텍스트는
        // 본문의 일부라 `notes:read`가 있어야 준다). 등록 시점에 굳혀 스냅샷·역호출이 같은
        // 판정을 쓰게 한다.
        const needsSelectedText = checkPermission(grant, "notes:read").allowed;
        selectionActions.set(id, {
          label,
          ...(title !== "" ? { title } : {}),
          handlerId,
          ...(match.match !== undefined ? { match: match.match } : {}),
          needsSelectedText,
        });
        if (snapshot !== null) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: "INVALID_ARGS",
            message: `등록 마감 뒤에 등록해 이번 실행의 선택 툴바에는 「${label}」이(가) 없습니다 — 선택 액션 등록은 runtime.ready() 전에 하세요`,
          });
        }
        return Promise.resolve({ id });
      }
      if (call === "ui.addTrayItem") {
        // `run$id`는 부트스트랩이 `run` 함수를 바꿔 실어 보낸 핸들러 id다(commands.register·
        // addMenuItem과 같은 규칙) — 비었다는 것은 곧 **run이 없다**는 뜻이라, 트레이에 떠도
        // 눌러도 아무 일이 안 일어나는 항목이 된다(눌러도 죽는 유령 항목을 만들지 않는다).
        const handlerId = String(args["run$id"] ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addTrayItem에는 run 함수가 필요합니다(없으면 트레이에서 눌러도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // label은 트레이 메뉴에 보일 **유일한** 문자열이다(글리프 폴백이 없다) — 비면 사용자는
        // 정체불명의 빈 메뉴 줄을 보게 된다(addMenuItem과 같은 판정).
        const label = String(args.label ?? "").trim();
        if (label === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addTrayItem에는 비어 있지 않은 label이 필요합니다(트레이 메뉴에 보일 이름)",
            ),
          );
        }
        // id는 registrar·버튼과 같은 계약이다: 비면 호스트가 만들어 주고, 같으면 치환한다.
        const givenId = String(args.id ?? "");
        const id = givenId || autoRegistrationId(pluginId, call, ++autoTraySeq);
        if (trayItems.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 트레이 항목을 대체했습니다: ${id}`,
          });
        }
        trayItems.set(id, { label, handlerId });
        // 트레이는 노트 창이 아니라 네이티브가 그린다 — 등록 마감(ready) 뒤에 도착한 항목은
        // 이미 배달된 스냅샷·네이티브 목록에 없다(버튼·명령과 같은 계약). 트레이엔 흔적조차
        // 없어 "등록했는데 아무 데도 없다"가 되므로 반드시 이유를 남긴다.
        if (snapshot !== null) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: "INVALID_ARGS",
            message: `등록 마감 뒤에 등록해 이번 실행의 트레이에는 「${label}」이(가) 없습니다 — 트레이 항목 등록은 runtime.ready() 전에 하세요`,
          });
        }
        return Promise.resolve({ id });
      }
      if (STORAGE_CALLS.has(call)) {
        const scope = readStorageScope(args);
        if (scope === null) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `알 수 없는 storage scope: ${String(args.scope)} (가능한 값: ${STORAGE_SCOPES.join(", ")})`,
            ),
          );
        }
        const key = readStorageKey(args);
        if (call !== "storage.getAll" && key === "") {
          return Promise.reject(
            bridgeError("INVALID_ARGS", `${call}에는 key가 필요합니다`),
          );
        }
        if (scope === "local") {
          if (call === "storage.get")
            return storage.get(pluginId, key, builtin);
          if (call === "storage.getAll") {
            return storage.getAll(pluginId, builtin);
          }
          if (call === "storage.remove") {
            return storage.remove(pluginId, key, builtin).then(() => null);
          }
          if (call === "storage.set") {
            return storage
              .set(pluginId, key, readStorageValue(args), builtin)
              .then(() => null)
              .catch((e: unknown) => {
                throw classifyStorageRejection(e);
              });
          }
        }
        // session·window는 이 프로세스 메모리다 — 디스크에 닿지 않으므로 상한·직렬화 검사도
        // 백엔드가 아니라 여기서 끝난다(값은 구조화 복제로 이미 건너온 JSON 호환 값이다).
        let bucket: MemoryStore | undefined;
        if (scope === "session") {
          bucket = sessionStore.get(pluginId);
          if (!bucket) sessionStore.set(pluginId, (bucket = newMemoryStore()));
        } else {
          // `storage`는 저위험 권한이라 유휴 만료의 대상이 아니다 — sensitiveCall을
          // 주지 않는다(만료된 토큰의 창 서랍 접근은 현행 그대로 동작한다).
          const resolved = resolveWindow(pluginId, ctx);
          if (resolved.kind !== "window") {
            // 창 스코프인데 창을 모른다 — 창-스코프 호출과 **같은 계약**으로 끝낸다:
            // 옵트인(`requireWindow: true`)이면 거부, 아니면 조용한 null + 진단(성공과
            // 구분되지 않으므로 저작자가 볼 수 있는 흔적을 반드시 남긴다).
            if (requiresWindowContext(args)) {
              diagnostics.record({
                pluginId,
                kind: "no-window-context",
                call,
                code: "CONTEXT_UNAVAILABLE",
                message:
                  "창 컨텍스트가 없어 storage.window 접근을 거부했습니다",
              });
              return Promise.reject(contextUnavailableError(call));
            }
            diagnostics.record({
              pluginId,
              kind: "no-window-context",
              call,
              message:
                "창 컨텍스트가 없어 storage.window가 아무 일도 하지 않았습니다. 버튼 onClick·명령 run이 준 memo로 호출하세요",
            });
            return Promise.resolve(call === "storage.getAll" ? {} : null);
          }
          const bucketKey = `${pluginId}\n${resolved.window}`;
          bucket = windowStore.get(bucketKey);
          if (!bucket) {
            windowStore.set(bucketKey, (bucket = newMemoryStore()));
            // 창이 닫혔다는 통지를 호스트가 받는 경로는 없다(`note:closed`는 구독자가 있을
            // 때만 난다). 그래서 "그 창이 닫히면 폐기"를 정확히 지킬 수 없고, 대신 오래된
            // 서랍부터 버리는 상한으로 누수를 막는다 — Map은 삽입 순 반복이라 앞이 가장 오래된
            // 것이다. 계약 문구도 그 한계를 그대로 적는다(지키지 못할 약속을 하지 않는다).
            for (const key of windowStore.keys()) {
              if (windowStore.size <= MAX_WINDOW_STORES) break;
              if (key !== bucketKey) windowStore.delete(key);
            }
          }
        }
        if (call === "storage.get") {
          return Promise.resolve(bucket.values.get(key) ?? null);
        }
        if (call === "storage.getAll") {
          return Promise.resolve(Object.fromEntries(bucket.values));
        }
        if (call === "storage.remove") {
          removeFromMemoryStore(bucket, key);
          return Promise.resolve(null);
        }
        const stored = setInMemoryStore(bucket, key, readStorageValue(args));
        return stored === null ? Promise.resolve(null) : Promise.reject(stored);
      }
      if (call === "ui.addToolbarButton") {
        // `buttonId`는 부트스트랩이 `onClick` 함수를 바꿔 실어 보내는 핸들러 id다 — 비었다는
        // 것은 곧 **onClick이 없다**는 뜻이다. 예전에는 그대로 수집돼 버튼이 정상으로 보이는데
        // 클릭이 샌드박스의 `handlers.get("")`에서 조용히 끝났다(진단도 0건). 등록 시점에
        // 거부하면 게이트키퍼가 call-reject 진단으로 남긴다.
        const handlerId = String(args.buttonId ?? "");
        if (handlerId === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "ui.addToolbarButton에는 onClick 함수가 필요합니다(없으면 눌러도 아무 일도 일어나지 않는다)",
            ),
          );
        }
        // id는 registrar와 같은 계약이다: 비면 호스트가 만들어 주고, 같으면 치환한다.
        // 이 id는 툴바 배치 키(`plugin:<pluginId>:<id>`)이자 단축키 타깃이라, 검증 없이
        // 배열에 push하면 중복 id 두 건이 같은 키 하나로 접혀 "둘 다 보이는데 함께 옮겨지고
        // 단축키는 첫 버튼만 눌리는" 상태가 된다.
        //
        // 이 `buttons` Map은 아래 `ui.addStatusItem`의 `statusItems` Map과 **별도 레지스트리**
        // 다 — 같은 플러그인이 버튼과 상태 아이템에 같은 id를 써도(예: 둘 다 "x") 서로 다른
        // Map에 들어가므로 이 중복-등록 진단은 절대 걸리지 않는다(이미 kind별로 네임스페이스가
        // 갈려 있다). 그 둘을 나중에 노트 창이 합쳐 하나의 목록(`PluginWindowItem[]`)으로 받을
        // 때(`snapshotToolbarButtons`) 겹치지 않게 하는 것은 이 함수의 몫이 아니라
        // `snapshotToolbarButtons`가 상태 아이템 쪽 id에 `status:`를 접두하는 몫이다.
        const givenId = String(args.id ?? "");
        const id =
          givenId || autoRegistrationId(pluginId, call, ++autoButtonSeq);
        if (buttons.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 버튼을 대체했습니다: ${id}`,
          });
        }
        buttons.set(id, {
          id,
          label: String(args.label ?? ""),
          title: args.title == null ? undefined : String(args.title),
          position: normalizeToolbarPosition(args.position),
          buttonId: handlerId,
        });
        return Promise.resolve(null);
      }
      if (call === "ui.addStatusItem") {
        // id는 registrar·버튼과 같은 계약이다: 비면 호스트가 만들어 주고, 같으면 치환한다.
        // 이 id 자체는 저작자가 부른 `ui.updateStatusItem`의 조회 키(갱신 대상)이자, 접두
        // (`status:`)가 붙은 채로 툴바 배치 키가 된다(`snapshotToolbarButtons` 참고 —
        // 이 함수는 접두 없이 원래 id로만 저장한다). 검증 없이 push하면 중복 id 두 건이 같은
        // 키 하나로 접혀 "둘 다 보이는데 갱신은 하나만 되는" 상태가 된다. 이 `statusItems`
        // Map은 위 `ui.addToolbarButton`의 `buttons` Map과 별도라, 버튼과 상태 아이템이 같은
        // id를 써도 이 진단끼리는 절대 충돌하지 않는다(kind별 네임스페이스).
        const givenId = String(args.id ?? "");
        const id =
          givenId || autoRegistrationId(pluginId, call, ++autoStatusSeq);
        if (statusItems.has(id)) {
          diagnostics.record({
            pluginId,
            kind: "duplicate-registration",
            call,
            message: `같은 id로 다시 등록해 앞의 상태 아이템을 대체했습니다: ${id}`,
          });
        }
        // text는 **초기값**이다(빈 문자열도 허용 — 등록 직후 note:opened 핸들러가 첫 값을
        // 채우는 것이 정본이다). 갱신은 창-스코프 ui.updateStatusItem이 나른다(단어 수는
        // 창마다 다르므로 전역 스냅샷에 실을 수 없다).
        //
        // onClick(선택): 부트스트랩의 범용 치환(swapHandlers)이 이미 `onClick$id`로 바꿔
        // 실어 보낸다 — `ui.addToolbarButton`의 `buttonId`처럼 별칭 한 줄을 더 두지 않고
        // (`SANDBOX_BOOTSTRAP`을 건드리면 CSP 해시 세 곳이 함께 움직인다) `run$id`·`handlerId`류와
        // 같은 최소 규약으로 raw 필드를 그대로 읽는다. **버튼과 달리 필수가 아니다** — 없으면
        // (대부분의 상태 아이템) 그냥 텍스트로만 렌더된다(INVALID_ARGS로 거부하지 않는다).
        const onClickId = String(args["onClick$id"] ?? "");
        statusItems.set(id, {
          id,
          text: String(args.text ?? ""),
          title: args.title == null ? undefined : String(args.title),
          position: normalizeToolbarPosition(args.position),
          ...(onClickId !== "" ? { buttonId: onClickId } : {}),
        });
        return Promise.resolve(null);
      }
      // ── 전체 노트 컬렉션 읽기(`notes:all-read` 게이트는 게이트키퍼가 이미 봤다) ──
      // 창-스코프가 아니라 **호스트 스코프**다: 전역 데이터라 창 컨텍스트가 필요 없고,
      // 중앙 호스트가 기존 Rust IPC(`note_list`/`note_read`)를 직접 부른다.
      if (call === "notes.list") {
        // 수가 아닌 limit/offset은 기본값으로 흡수하지 않는다(storage scope와 같은 원칙 —
        // 오타가 조용히 "다른 페이지"를 주면 무음 손상이다).
        const limitRaw =
          args.limit === undefined ? NOTES_LIST_DEFAULT_LIMIT : args.limit;
        const offsetRaw = args.offset === undefined ? 0 : args.offset;
        if (
          typeof limitRaw !== "number" ||
          !Number.isFinite(limitRaw) ||
          limitRaw < 1 ||
          typeof offsetRaw !== "number" ||
          !Number.isFinite(offsetRaw) ||
          offsetRaw < 0
        ) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `notes.list: limit은 1 이상, offset은 0 이상의 수여야 합니다(limit: ${String(args.limit)}, offset: ${String(args.offset)})`,
            ),
          );
        }
        // 상한 초과는 거부가 아니라 클램프다(setFontDelta와 같은 관례 — 범위 값은 실제
        // 적용치로 접고, 그 사실을 계약 문서에 적는다).
        const limit = Math.min(Math.floor(limitRaw), NOTES_LIST_MAX_LIMIT);
        const offset = Math.floor(offsetRaw);
        return listNotesCached().then((all) =>
          all.slice(offset, offset + limit).map((n) => ({
            // 페이로드 최소화: 메타만 싣는다 — 본문은 `notes.read`의 몫이다.
            // 숨긴(hidden) 노트도 **포함**한다: 이 권한의 존재 이유(전체 검색·백링크·통계)가
            // 숨김 여부와 무관하게 컬렉션 전체를 봐야 성립하고, 승인 문구도 "숨긴 메모를
            // 포함한 모든 메모"라고 정확히 그렇게 말한다. 대신 hidden 플래그를 그대로 실어
            // 플러그인이 사용자의 숨김 의도를 존중해 거를 수 있게 한다.
            id: n.id,
            title: n.title,
            hidden: n.hidden,
            createdAt: n.created_at,
          })),
        );
      }
      if (call === "notes.read") {
        const id = String(args.id ?? "");
        if (id === "") {
          return Promise.reject(
            bridgeError("INVALID_ARGS", "notes.read에는 id가 필요합니다"),
          );
        }
        // 경로 형태의 id는 백엔드에 닿기 전에 닫는다 — 계약("id는 불투명 식별자, 경로
        // 해석은 호스트 독점")을 실제로 참이 되게 하는 관문이다. Rust `Vault`에도 같은
        // 가드가 있다(심층 방어 — [`isSafeNoteId`] 문서 참고).
        if (!isSafeNoteId(id)) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `notes.read: 경로 형태의 id는 허용되지 않습니다(구분자와 "..", ":" 금지): ${id}`,
            ),
          );
        }
        return notesBackend.read(id).then(
          // 페이로드 최소화: `note_read`가 함께 돌려주는 사이드카 메타(창 위치·투명도
          // 등)는 **버린다** — 권한 문구가 약속한 것("제목과 내용")만 나간다.
          (n) => ({ id, content: n.content }),
          (e: unknown) => {
            // Rust 경계는 `Result<T, String>`이라 거부에 code가 없다(QUOTA_EXCEEDED와 같은
            // 상황). 노트 단위 읽기가 실패하는 실질적 원인은 "그 id의 노트 파일이 없다"
            // 하나이므로 NOTE_NOT_FOUND로 분류하되, 다른 원인(잠금 등)도 진단할 수 있게
            // 백엔드 원문을 문구에 그대로 잇는다.
            throw bridgeError(
              "NOTE_NOT_FOUND",
              `노트를 찾을 수 없습니다: ${id} (${e instanceof Error ? e.message : String(e)})`,
            );
          },
        );
      }
      // ── 임의 노트 직접 쓰기(과 함께 예약 해제 — `notes:write` 게이트는 게이트키퍼가 봤다) ──
      // `notes.list`/`notes.read`와 같은 **호스트 스코프**다: 특정 창과 무관한 전역 데이터
      // 쓰기라 창 컨텍스트가 필요 없다(그래서 유휴 만료의 대상도 아니다 — 창-스코프가
      // 아니다). Rust `note_write`(append/overwrite)를 직접 부른다.
      if (call === "notes.write") {
        const id = String(args.id ?? "");
        if (id === "") {
          return Promise.reject(
            bridgeError("INVALID_ARGS", "notes.write에는 id가 필요합니다"),
          );
        }
        // 경로 형태의 id는 백엔드에 닿기 전에 닫는다(`notes.read`와 같은 관문 — id는 불투명
        // 식별자, 경로 해석은 호스트 독점). Rust `Vault`에도 같은 가드가 있다(심층 방어).
        if (!isSafeNoteId(id)) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `notes.write: 경로 형태의 id는 허용되지 않습니다(구분자와 "..", ":" 금지): ${id}`,
            ),
          );
        }
        // content는 문자열만(구조화 값을 그대로 파일에 쓸 수는 없다).
        if (typeof args.content !== "string") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "notes.write의 content는 문자열이어야 합니다",
            ),
          );
        }
        // 본문 바이트 상한: overwrite가 이전 본문 전체를 스냅샷하므로, 상한이 없으면 대용량
        // 반복 쓰기가 노트당 스냅샷 사본을 통째로 키운다(`trash.rs`의 총 용량 상한과 함께 축적을
        // 막는다). id·mode와 같은 계열의 계약 위반이라 INVALID_ARGS로 거부한다(문서화된 코드).
        const contentBytes = STORAGE_ENCODER.encode(args.content).length;
        if (contentBytes > MAX_NOTE_WRITE_BYTES) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `notes.write의 content가 너무 큽니다: ${contentBytes}바이트(상한 ${MAX_NOTE_WRITE_BYTES}바이트)`,
            ),
          );
        }
        // mode 기본값은 저마찰·비파괴 `append`다(생략하면 데이터를 잃지 않는 쪽으로 붙인다).
        // `overwrite`는 통째로 덮지만 Rust가 덮기 전에 스냅샷을 남긴다(복구 가능).
        const mode = args.mode === undefined ? "append" : args.mode;
        if (mode !== "append" && mode !== "overwrite") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              `notes.write의 mode는 "append" 또는 "overwrite"여야 합니다(생략하면 append): ${String(args.mode)}`,
            ),
          );
        }
        return notesBackend.write(id, args.content, mode).then(
          () => {
            // 쓰기가 성공하면 그 노트의 **열려 있는 창**에 통지한다(복원 경로와 같은 위험 계열):
            // 통지가 없으면 그 창의 낡은 에디터 버퍼가 통지받지 못한 채 남고, 다음 자동저장이
            // 방금 플러그인이 쓴 본문을 조용히 덮는다 — append 텍스트도 overwrite 본문도
            // 자동저장 스냅샷에 없어 복구조차 못 한다(플러그인은 성공을 반환했는데 결과가 증발).
            // 복원 경로가 이미 쓰는 EV_NOTE_RESTORED를 그대로 재사용한다(main.ts 리스너 →
            // id 일치 시 reloadContent). 다른 노트의 창은 id 불일치로 무시한다.
            deps.bus.emit(EV_NOTE_RESTORED, { id });
            return null;
          },
          (e: unknown) => {
            // Rust 경계는 code 없는 문자열 거부다. 안전한 id인데도 쓰기가 실패하는 실질적
            // 원인은 "그 id의 노트가 없다"이므로 NOTE_NOT_FOUND로 분류하되(read와 같은 관례),
            // 다른 원인(IO 등)도 진단할 수 있게 백엔드 원문을 문구에 잇는다.
            throw bridgeError(
              "NOTE_NOT_FOUND",
              `노트에 쓰지 못했습니다: ${id} (${e instanceof Error ? e.message : String(e)})`,
            );
          },
        );
      }
      // ── 네트워크 중계(`network:<호스트>` 게이트는 게이트키퍼가 이미 봤다) ──────
      // `notes.list`/`notes.write`와 같은 **호스트 스코프**다: 특정 창과 무관한 외부 IO라 창
      // 컨텍스트가 필요 없다(유휴 만료의 대상도 아니다). URL·스킴·도메인 승인은
      // 게이트키퍼(host.ts)가 이 호출 전에 끝냈고, 실제 SSRF 방어(사설대역·DNS 핀·리다이렉트·
      // 크기·타임아웃)는 백엔드(`net.rs`)가 소유한다. 여기는 인자 형식만 앞에서 거른다.
      if (call === "network.fetch") {
        const method = args.method === undefined ? "GET" : args.method;
        if (typeof method !== "string" || method === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "network.fetch의 method는 비어있지 않은 문자열이어야 합니다(생략하면 GET)",
            ),
          );
        }
        // body는 문자열만(구조화 값을 그대로 보낼 수는 없다 — 저작자가 JSON.stringify한다).
        // 생략·null이면 본문 없음. 다른 타입은 계약 위반이라 INVALID_ARGS로 거부한다.
        if (
          args.body !== undefined &&
          args.body !== null &&
          typeof args.body !== "string"
        ) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "network.fetch의 body는 문자열이어야 합니다(객체는 JSON.stringify 후 넘기세요)",
            ),
          );
        }
        const body = typeof args.body === "string" ? args.body : null;
        // 요청 헤더는 `{ name, value }[]` 배열이다(응답과 대칭 — 값 어휘가 열린 인자를
        // `Record`로 두지 않는 계약 가드 때문에 배열로 표현한다). name·value가 문자열인 항목만
        // 싣고 나머지는 버린다(헤더 하나가 어긋났다고 요청 자체를 못 보내게 할 이유가 없다).
        // 자격증명·전송 계층 헤더(Host·Cookie·Authorization 등) 제거는 백엔드가 소유한다(TS를 믿지 않는다).
        const headers: { name: string; value: string }[] = [];
        const rawHeaders = args.headers;
        if (Array.isArray(rawHeaders)) {
          for (const entry of rawHeaders) {
            if (typeof entry !== "object" || entry === null) continue;
            const { name, value } = entry as {
              name?: unknown;
              value?: unknown;
            };
            if (typeof name === "string" && typeof value === "string") {
              headers.push({ name, value });
            }
          }
        } else if (rawHeaders !== undefined && rawHeaders !== null) {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "network.fetch의 headers는 { name, value } 배열이어야 합니다",
            ),
          );
        }
        // 동시 호출 상한(스레드풀 고갈 방지) — 백엔드를 부르기 **전에** 슬롯을 잡는다.
        // 초과면 큐잉하지 않고 즉시 거부해, 이 fetch가 공유 블로킹 스레드풀에 얹혀 무관한
        // async 커맨드(노트 읽기·저장·저장소)를 굶기지 못하게 한다.
        const releaseSlot = acquireNetworkSlot(pluginId);
        if (releaseSlot === null) {
          return Promise.reject(
            bridgeError(
              "NETWORK_TOO_MANY_REQUESTS",
              `network.fetch 동시 호출이 상한을 초과했습니다(플러그인당 ${NETWORK_FETCH_MAX_INFLIGHT_PER_PLUGIN}·전역 ${NETWORK_FETCH_MAX_INFLIGHT_GLOBAL}) — 진행 중 요청이 끝난 뒤 다시 호출하세요`,
            ),
          );
        }
        // args.url은 게이트키퍼가 이미 https·파싱을 통과시킨 문자열이다(같은 값을 다시 넘긴다).
        return networkBackend
          .fetch(String(args.url), method, headers, body)
          .then(
            (res) => ({
              status: res.status,
              headers: res.headers,
              body: res.body,
            }),
            (e: unknown) => {
              // 백엔드의 NET_* 토큰을 MemoErrorCode로 맵한다(사설대역·타임아웃·크기초과 구분).
              throw classifyNetworkRejection(e);
            },
          )
          .finally(releaseSlot); // 성공·실패·예외 모든 경로에서 슬롯을 정확히 한 번 반납.
      }
      // ── 브라우저 열기(`browser:open` 게이트는 게이트키퍼가 이미 봤다) ────────────────
      // `network.fetch`와 같은 **호스트 스코프**다: 특정 창과 무관한 앱 밖 탐색이라 창
      // 컨텍스트가 필요 없다. 여기서는 인자 형식만 보고, 스킴 허용 목록(http·https·mailto)은
      // 백엔드 `open_external_url`이 소유한다 — 프론트 판정을 믿지 않는 심층 방어.
      if (call === "browser.open") {
        const url = args.url;
        if (typeof url !== "string" || url === "") {
          return Promise.reject(
            bridgeError(
              "INVALID_ARGS",
              "browser.open의 url은 비어있지 않은 문자열이어야 합니다",
            ),
          );
        }
        return browserBackend.open(url).then(
          () => null,
          (e: unknown) => {
            // 백엔드 거부는 code 없는 문자열이다(스킴 거부가 대부분) — 원문을 문구에 실어
            // 저작자가 "왜 안 열렸는지"를 진단에서 볼 수 있게 한다.
            throw bridgeError(
              "INVALID_ARGS",
              `브라우저로 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
            );
          },
        );
      }
      // ── 플러그인 간 명령 호출(`invoke:<대상>` 게이트는 게이트키퍼가 이미 봤다) ──────
      // 두 샌드박스는 **절대 직접 통신하지 않는다**: A의 invoke를 중앙 호스트가 받아, 대상 B가
      // 공개(`exposes`)한 명령을 B의 등록된 핸들러로 역호출하고(명령 실행 경로 재사용), A에는
      // `null`을 돌려준다. B의 "결과"는 돌려주지 않는다 — 명령의 `run`은 `(memo) => void`라
      // 반환값 자체가 없다(그래서 이 호출은 experimental 표식을 단다, . A는 B의 관측 가능한
      // 효과(B가 자기 권한으로 부르는 toast·노트 쓰기 등)로 결과를 본다.
      if (call === "commands.invoke") {
        const target = invokeTargetOf(args);
        // 게이트키퍼가 이미 형식·권한을 통과시켰으므로 여기 도달하면 ok지만, 수행부가
        // 게이트키퍼 판정에 암묵 의존하지 않게 방어적으로 다시 본다.
        if (!target.ok) {
          return Promise.reject(bridgeError(target.code, target.error));
        }
        const { targetId, commandId } = target;
        // 릴레이 깊이(순환 방어): 호출측 토큰이 실어 온 깊이 + 1. 원천(클릭·이벤트)은 0.
        const callerEntry =
          ctx !== undefined && ctx !== "" ? invocations.get(ctx) : undefined;
        const callerDepth =
          callerEntry && callerEntry.pluginId === pluginId
            ? (callerEntry.relayDepth ?? 0)
            : 0;
        const nextDepth = callerDepth + 1;
        if (nextDepth > MAX_INVOKE_DEPTH) {
          return Promise.reject(
            bridgeError(
              "INVOKE_CYCLE",
              `플러그인 간 호출 깊이가 상한(${MAX_INVOKE_DEPTH})을 넘었습니다 — A→B→A 같은 순환을 의심하세요: ${pluginId} → ${targetId}.${commandId}`,
            ),
          );
        }
        // 대상 플러그인이 지금 살아 있는가.
        if (!sandboxes.has(targetId)) {
          return Promise.reject(
            bridgeError(
              "INVOKE_NO_TARGET",
              `대상 플러그인이 실행 중이 아닙니다: ${targetId}(꺼졌거나 설치되지 않음)`,
            ),
          );
        }
        // 대상이 그 명령을 **공개**했는가(exposes) — 기본 비공개. 자격(invoke:<대상>)이 있어도
        // 대상이 명시적으로 열지 않은 명령은 부를 수 없다(호출은 양쪽 동의로만 성립한다).
        if (!exposesOf.get(targetId)?.has(commandId)) {
          return Promise.reject(
            bridgeError(
              "INVOKE_NOT_EXPOSED",
              `대상 플러그인이 공개하지 않은 명령입니다: ${targetId}.${commandId} — 대상 매니페스트의 exposes에 그 commandId를 넣어야 부를 수 있습니다`,
            ),
          );
        }
        // 공개는 했지만 런타임에 등록됐는가(commands.register). 공개했는데 등록을 빠뜨린 명령은
        // 부를 것이 없으므로 미공개와 구분되는 코드로 거부한다.
        if (!commandsOf.get(targetId)?.has(commandId)) {
          return Promise.reject(
            bridgeError(
              "INVOKE_NO_TARGET",
              `공개는 됐지만 등록되지 않은 명령입니다: ${targetId}.${commandId} — 대상이 commands.register로 그 id를 등록해야 합니다`,
            ),
          );
        }
        // 호출측의 창으로 대상 명령을 실행한다(대상의 창-스코프 호출이 그 창으로 가게). 창이
        // 없으면(호스트-스코프 호출측·설정 버튼·트레이) windowLabel="" — 대상 토큰은 자기 창이
        // 없는 **깊이 반송 전용**이 되고, 대상의 창-스코프 호출은 폴백 계약을 탄다(resolveWindow가
        // window="" 토큰을 폴백으로 처리). commands.invoke는 **민감 호출**(게이트가 민감 접두
        // `invoke:<대상>`)이므로 유휴
        // 만료를 여기서 태운다: 대상이 실제로 행동할 창은 호출측의 이 토큰에서 파생되므로,
        // 만료된(오래된 클릭의) 창 권한이 플러그인 경계를 넘어 세탁되면 안 된다 — WINDOW_SCOPED_CALLS와
        // 같은 문구·같은 진단으로 시끄럽게 거부한다(조용한 폴백이면 A가 5분 뒤에도 B를 A의 옛 창으로
        // 읽고·쓰게 만들 수 있다). 방금 발급한 대상 토큰의 lastUsed=now는 만료 대상이 아니지만,
        // 그 토큰이 **어느 창을 가리키는가**는 여기서 만료 검사한 호출측 토큰이 정한다.
        const resolved = resolveWindow(pluginId, ctx, /* sensitiveCall */ true);
        if (resolved.kind === "expired") {
          diagnostics.record({
            pluginId,
            kind: "no-window-context",
            call,
            code: "CONTEXT_UNAVAILABLE",
            message: `창 컨텍스트가 유휴 만료되었습니다(마지막 활동 후 ${Math.round(INVOCATION_IDLE_TTL_MS / 60_000)}분 초과) — 새 클릭·이벤트 핸들러가 받은 바인딩된 memo로 다시 호출하세요`,
          });
          return Promise.reject(
            bridgeError(
              "CONTEXT_UNAVAILABLE",
              `창 컨텍스트가 만료됨(유휴 상한 초과): ${call}`,
            ),
          );
        }
        const windowLabel = resolved.kind === "window" ? resolved.window : "";
        // 깊이(nextDepth)는 **항상** 대상 토큰에 실어 나른다 — windowLabel이 빈(창 컨텍스트
        // 없는) 릴레이에서도 토큰을 발급해야 relayDepth가 다음 홉으로 이어진다. 안 그러면
        // 트레이 항목·설정 버튼처럼 창이 한 번도 확립되지 않는 진입점에서 시작된
        // 순환이 홉마다 깊이 0으로 리셋돼 MAX_INVOKE_DEPTH 상한에 결코 걸리지 않는다(A↔B
        // 무한 async 핑퐁). window==""면 그 토큰은 자기 창이 없어(깊이 반송 전용) 대상의
        // 창-스코프 호출은 폴백 계약을 탄다(resolveWindow가 window="" 토큰을 폴백으로 처리).
        const targetToken = issueInvocation(targetId, windowLabel, nextDepth);
        // 호출측이 준 `args`(중첩)를 대상 `run`의 페이로드로 넘긴다 — 대상은 `run(memo, args)`로
        // 받는다. when 판정·destructive 확인은 대상의 선언대로 걸린다(경로 그대로).
        return invokeCommand(
          targetId,
          commandId,
          windowLabel,
          targetToken,
          args.args,
        ).then(() => null);
      }
      if (WINDOW_SCOPED_CALLS.has(call)) {
        // 유휴 만료는 **민감 권한 호출에만** 적용한다(제안 원안 3항 — 저위험 호출은
        // 현행 하위호환 유지). 민감 여부는 게이트키퍼와 같은 어휘(CALL_PERMISSIONS ×
        // isSensitive)에서 유도하므로 새 호출이 늘어도 따로 적을 것이 없다.
        const sensitiveCall = isSensitive(CALL_PERMISSIONS[call] ?? "");
        const resolved = resolveWindow(pluginId, ctx, sensitiveCall);
        if (resolved.kind === "expired") {
          // 만료는 옵트인과 무관하게 **항상 시끄러운 실패**다 — 조용한
          // null이면 "예전 클릭 창을 노린 지연 쓰기"와 "정당한 후속 쓰기"가 똑같이 소리
          // 없이 사라져, 저작자도 사용자도 원인을 볼 수 없다. 토큰 경로든 폴백(토큰 없는
          // 호출) 경로든 같은 문구다 — 교정 행동이 동일하기 때문이다.
          diagnostics.record({
            pluginId,
            kind: "no-window-context",
            call,
            code: "CONTEXT_UNAVAILABLE",
            message: `창 컨텍스트가 유휴 만료되었습니다(마지막 활동 후 ${Math.round(INVOCATION_IDLE_TTL_MS / 60_000)}분 초과) — 새 클릭·이벤트 핸들러가 받은 바인딩된 memo로 다시 호출하세요`,
          });
          return Promise.reject(
            bridgeError(
              "CONTEXT_UNAVAILABLE",
              `창 컨텍스트가 만료됨(유휴 상한 초과): ${call}`,
            ),
          );
        }
        // 컨텍스트 없음(어느 창도 이 플러그인을 호출한 적 없음) 또는 모르는/남의 토큰 →
        // 무력 응답. 토큰은 폴백하지 않는다(임의 창 타깃 차단).
        if (resolved.kind === "none") {
          // 옵트인(`requireWindow: true`)이면 조용한 null 대신 코드가 붙은 거부다 —
          // 게이트키퍼가 이 예외를 `code: "CONTEXT_UNAVAILABLE"` 응답으로 감싼다. 판정은
          // 여기서만 한다: 창 컨텍스트를 아는 곳이 이 수행부뿐이다(host.ts의 게이트키퍼는
          // (call,args)만 본다). 조용한 null은 성공과 구분되지 않는 무음 실패라, 오류로 받고
          // 싶은 저작자는 `requireWindow: true`를 준다.
          if (requiresWindowContext(args)) {
            // 진단에도 남긴다 — 옵트인한 호출도 「최근 오류」에서 같은 자리로 모이게.
            diagnostics.record({
              pluginId,
              kind: "no-window-context",
              call,
              code: "CONTEXT_UNAVAILABLE",
              message: "창 컨텍스트가 없어 거부했습니다(requireWindow: true)",
            });
            return Promise.reject(contextUnavailableError(call));
          }
          // 이 null은 성공과 구분되지 않는다 — 저작자가 볼 수 있는 유일한 흔적을 남긴다.
          diagnostics.record({
            pluginId,
            kind: "no-window-context",
            call,
            message: `창 컨텍스트가 없어 아무 일도 일어나지 않았습니다. 버튼 onClick이 준 memo로 호출하거나 { requireWindow: true }를 주면 오류로 받을 수 있습니다`,
          });
          return Promise.resolve(null);
        }
        // 응답을 기다리는 동안(대화형은 최대 10분) 이 컨텍스트를 폐기·만료에서 보호한다.
        // 토큰 경로는 그 토큰을, 폴백 경로는 그 플러그인의 폴백 컨텍스트를 핀한다(대칭) —
        // 진행 중이면 만료하지 않고, 완료가 `lastUsed`를 새로 찍어 활동으로 집계된다.
        const unpin = pinInvocation(pluginId, ctx);
        // setFontDelta 비수치 방어는 창 쪽 수행부(executeWindowCall)가 담당한다.
        return callWindow(pluginId, resolved.window, call, args).finally(unpin);
      }
      return registrar.execute(call, args);
    };
  }

  /**
   * 샌드박스의 부팅(ready)을 상한과 함께 기다린다 — 초과하면 "부팅 시간 초과"로 거부한다.
   *
   * 왜: ready가 영영 안 오는 샌드박스(CSP 해시 불일치 등) 하나가 빌드 전체를 멈춰 세우면
   * 스냅샷이 null로 고정돼 모든 노트 창이 굶는다. 진 쪽(늦게 도착하는 거부)에는 무해한
   * catch를 붙여 미처리 거부 경고를 막는다.
   */
  async function awaitBoot(sandbox: SandboxHandle): Promise<void> {
    void sandbox.ready.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("부팅 시간 초과")),
        SANDBOX_BOOT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([sandbox.ready, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 플러그인 1개를 샌드박스에서 실행해 스냅샷 조각을 수집한다(번들·설치 공통 경로).
   *
   * 등록 호출은 게이트키퍼를 거치고(미선언·미부여 거부), 실행이 끝나면(ready) 수집된
   * 디스크립터 + 좁힌 grant를 직렬화 스냅샷으로 돌려준다. 샌드박스는 살려서 소유 목록에
   * 남긴다(버튼 클릭 역호출·런타임 브리지 호출을 계속 받기 위함).
   */
  async function runPlugin(
    pluginId: string,
    code: string,
    grant: PluginGrant,
    settings: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
    },
    schema: PluginSettingField[],
    env: PluginRuntimeEnv,
    /** 번들(빌트인)인가 — `storage.local`의 백엔드 네임스페이스를 가른다. */
    builtin: boolean,
    /** 매니페스트가 선언한 기여(없으면 undefined). */
    contributes: PluginContributions | undefined,
    /** 매니페스트가 다른 플러그인에 공개한 명령 id들(없으면 빈 배열). */
    exposes: readonly string[],
  ): Promise<PluginSnapshot> {
    // pluginId를 넘겨 인라인 패턴 클래스를 이 플러그인으로 네임스페이스한다. 같은 id로
    // 다시 등록해 앞의 등록이 치환된 것은 진단으로 남긴다 — 수집기 안에서는 조용히 덮이므로
    // 저작자가 "등록이 하나 사라졌다"의 이유를 볼 곳이 여기밖에 없다.
    // 매니페스트 기여를 적용하는 동안만 켜지는 표식 — 같은 id의 치환이 "저작자의 중복 등록"이
    // 아니라 **선언형이 명령형을 이겼다**는 뜻이 되므로, 진단 문구가 그 사실을 말해야 한다
    // (의 우선순위 규칙을 문서에만 적으면 "왜 내 JS 등록이 무시되지"가 새 미스터리가 된다).
    let applyingContributes = false;
    // experimental 호출 경고를 빌드당 (플러그인, 호출) 1회로 좁히는 표식.
    const warnedExperimental = new Set<string>();
    const registrar = makeRegistrar(pluginId, (call, id) => {
      diagnostics.record({
        pluginId,
        kind: "duplicate-registration",
        call,
        message: applyingContributes
          ? `매니페스트 contributes가 같은 id의 main.js 등록을 대체했습니다(선언형이 우선): ${id}`
          : `같은 id로 다시 등록해 앞의 등록을 대체했습니다: ${id}`,
      });
    });
    const buttons = new Map<string, SnapshotToolbarButton>();
    const statusItems = new Map<string, SnapshotStatusItem>();
    const subscriptions = new Map<
      string,
      { name: MemoEventName; handlerId: string }
    >();
    const commands = new Map<
      string,
      {
        title: string;
        handlerId: string;
        when: WhenTerm[];
        destructive: boolean;
      }
    >();
    const menuItems = new Map<
      string,
      {
        label: string;
        handlerId: string;
        when: WhenTerm[];
        needsSelectedText: boolean;
      }
    >();
    const selectionActions = new Map<
      string,
      {
        label: string;
        title?: string;
        handlerId: string;
        match?: SelectionMatch;
        needsSelectedText: boolean;
      }
    >();
    const trayItems = new Map<string, { label: string; handlerId: string }>();
    const execute = makeHostExecutor(
      pluginId,
      registrar,
      buttons,
      statusItems,
      subscriptions,
      commands,
      menuItems,
      selectionActions,
      trayItems,
      grant,
      settings,
      schema,
      builtin,
    );
    /**
     * 매니페스트 기여를 **명령형 등록과 같은 관문**으로 통과시킨다.
     *
     * 왜 `handleBridgeRequest`를 다시 타는가: 선언형이라고 게이트를 건너뛰면 `editor` 권한을
     * 선언하지 않은 플러그인이 JSON만으로 인라인 패턴을 등록할 수 있게 된다 — 게이트키퍼가
     * 한 곳이라는 보안 모델에 구멍이 난다. 같은 함수를 타면 권한·`kind`·형식 검증이 전부
     * 자동으로 같아지고, 실패는 진단 채널에 그대로 남는다.
     *
     * **[`CONTRIBUTION_CALLS`]에 없는 기여 종류는 이 루프가 아예 건너뛴다.** 지금 그런 종류는
     * `translations`(언어팩) 하나인데, 그것은 브리지 호출로 되돌릴 대상이 아니라 코어가 직접
     * 읽는 순수 데이터다(`plugin_i18n.rs`) — 아는 종류인지의 판정은 [`CONTRIBUTION_KINDS`]가
     * 하므로 위 `unknownKinds` 진단이 언어팩을 오탐하지도 않는다.
     */
    const applyContributes = async (): Promise<void> => {
      if (!contributes) return;
      applyingContributes = true;
      for (const kind of contributes.unknownKinds ?? []) {
        diagnostics.record({
          pluginId,
          kind: "call-reject",
          call: "contributes",
          code: "INVALID_ARGS",
          message: `모르는 기여 종류라 무시했습니다: contributes.${kind} (가능한 값: ${CONTRIBUTION_KINDS.join(", ")})`,
        });
      }
      for (const [name, callName] of Object.entries(CONTRIBUTION_CALLS)) {
        // windowControls는 값 배열 하나가 `window.register({controls})` 한 번이고, 나머지
        // 셋은 항목마다 등록 한 번이다(등록 인자가 곧 항목 자체다 — 미러링).
        const items =
          name === "windowControls"
            ? contributes.windowControls === undefined
              ? []
              : [{ controls: contributes.windowControls }]
            : (((contributes as Record<string, unknown>)[name] as
                Record<string, unknown>[] | undefined) ?? []);
        for (const args of items) {
          const response = await handleBridgeRequest(
            grant,
            { call: callName, args },
            (c, a) => execute(c, a),
            env,
          );
          if (!response.ok) {
            diagnostics.record({
              pluginId,
              kind: "call-reject",
              call: `contributes.${name}`,
              code: response.code,
              message: response.error ?? "거부됨",
            });
          }
        }
      }
      applyingContributes = false;
    };
    /** 수집이 끝난 뒤의 직렬화 조각(빈 main.js 경로와 정상 경로가 **같은 모양**을 내게 한다). */
    const collected = (): PluginSnapshot => {
      // 구독·명령은 스냅샷(불변 값)이 아니라 **살아있는 샌드박스의 상태**라 별도 맵에 남긴다 —
      // 노트 창에는 이름·제목만 나가고, 역호출은 여기 있는 handlerId로 한다. 빈 맵도 등록한다
      // (같은 Map 인스턴스를 공유) — 늦게 도착한 등록도 최소한 호스트에는 닿게 하려는 것이다.
      eventSubs.set(pluginId, subscriptions);
      commandsOf.set(pluginId, commands);
      menuItemsOf.set(pluginId, menuItems);
      selectionActionsOf.set(pluginId, selectionActions);
      trayItemsOf.set(pluginId, trayItems);
      // 공개 명령은 매니페스트 정적 선언이라 수집이 아니라 그대로 싣는다 — 명령·구독과
      // 수명을 맞춰(dispose가 함께 지운다) `commands.invoke` 릴레이의 공개 판정 원천이 된다.
      exposesOf.set(pluginId, new Set(exposes));
      // 수집 배열은 전부 복사해 굳힌다 — ready 이후 늦게 도착한 등록이 이미 배달된 스냅샷을
      // 몰래 바꾸지 못하게(스냅샷은 관측 시점의 불변 값이어야 한다).
      return {
        pluginId,
        grant,
        // 이 플러그인이 번들(빌트인)로 실행됐는지 — 호출부(번들 루프/`runPreparedInstalled`)가
        // 넘긴 값을 그대로 싣는다. 노트 창 컨텍스트 메뉴가 빌트인 출처 항목만 걸러내는 근거다
        // (`PluginSnapshot.builtin` 참고).
        builtin,
        patterns: [...registrar.patterns],
        completions: [...registrar.completions],
        embeds: [...registrar.embeds],
        buttons: [...buttons.values()],
        // 상태 표시형 아이템 — 버튼과 같은 툴바 배치 키를 쓰되 렌더가 텍스트다. 초기
        // 텍스트만 싣고(창별 라이브 값은 창-스코프 갱신이 나른다), 굳혀 복사한다(ready 이후
        // 늦게 도착한 등록이 이미 배달된 스냅샷을 몰래 바꾸지 못하게).
        statusItems: [...statusItems.values()],
        // 메뉴 전용 항목 — 노트 창이 렌더 시점에 `when`을 판정하므로 창 상태 키를 그대로
        // 싣는다. handlerId는 싣지 않는다(역호출은 호스트가 id로 되짚는다 — 버튼·명령과 같은 규칙).
        menuItems: [...menuItems.entries()].map(
          ([id, m]): SnapshotMenuItem => ({
            id,
            label: m.label,
            ...(m.when.length > 0 ? { when: m.when } : {}),
            ...(m.needsSelectedText ? { needsSelectedText: true } : {}),
          }),
        ),
        // 선택 액션 — 표시 조건(`match`)을 그대로 싣는다. 판정 주체가 **선택이 확정된 순간의
        // 노트 창**이기 때문이다(왕복 0·방송 0). handlerId는 싣지 않는다(버튼·명령·메뉴와 같은
        // 규칙 — 역호출 대상은 호스트만 안다).
        selectionActions: [...selectionActions.entries()].map(
          ([id, a]): SnapshotSelectionAction => ({
            id,
            label: a.label,
            ...(a.title !== undefined ? { title: a.title } : {}),
            ...(a.match !== undefined ? { match: a.match } : {}),
            ...(a.needsSelectedText ? { needsSelectedText: true } : {}),
          }),
        ),
        commands: [...commands.entries()].map(([id, c]) => {
          // 창의 상태를 봐야만 판정할 수 있는 when 키(note.isEmpty)를 스냅샷에 함께 싣는다 —
          // 설정 화면 액션 버튼이 창 없는 실행을 요청하기 **전에** "왜 안 되는지"를
          // 말할 수 있는 유일한 근거다(판정 기준은 evaluateStaticWhen과 같은 WINDOW_WHEN_KEYS).
          const whenPendingKeys = [
            ...new Set(
              c.when
                .map((t) => t.key)
                .filter((k) => WINDOW_WHEN_KEYS.includes(k)),
            ),
          ];
          return {
            id,
            title: c.title,
            ...(c.destructive ? { destructive: true } : {}),
            ...(whenPendingKeys.length > 0 ? { whenPendingKeys } : {}),
          };
        }),
        // 메뉴바 트레이 항목 — id·label만 싣는다(handlerId는 trayItemsOf에 남는다).
        // 노트 창은 이 조각을 무시하고(트레이는 네이티브가 그린다), 중앙 호스트가 build()에서
        // 전 플러그인의 것을 평탄화해 네이티브로 배달한다. 굳혀 복사한다(ready 이후 늦게 도착한
        // 등록이 이미 배달된 스냅샷·네이티브 목록을 몰래 바꾸지 못하게).
        trayItems: [...trayItems.entries()].map(
          ([id, t]): SnapshotTrayItem => ({ id, label: t.label }),
        ),
        background: registrar.background,
        font: registrar.font,
        windowControls: [...registrar.windowControls],
      };
    };
    // main.js가 비어 있으면 **샌드박스를 아예 띄우지 않는다**(의 실질 이득).
    //
    // 왜 이 조건인가: 기여가 전부 매니페스트에 있으면 실행할 코드가 없다 — 그런데도 iframe을
    // 만들고 blob을 로드하고 부팅 왕복(최대 5초 상한)을 기다리는 것은 순수한 낭비이고,
    // 그 왕복 자체가 실패 모드였다(코드가 조금만 늦어도 등록이 통째로 유실됐다). 조건을
    // "코드가 공백뿐"으로 좁게 잡은 이유: 주석만 있는 파일까지 판별하려면 파서가 필요하고,
    // 잘못 판별하면 **멀쩡한 플러그인이 실행되지 않는다**(가장 비싼 오답).
    if (code.trim() === "") {
      await applyContributes();
      return collected();
    }
    const sandbox = factory(
      deps.doc,
      code,
      async (call, args, ctx) => {
        // 플러그인이 스스로 남긴 줄도 같은 기록으로 모은다(호스트 콘솔은 저작자에게 안 보인다).
        if (call === "runtime.log") {
          diagnostics.record({
            pluginId,
            kind: "log",
            message: String(args.message ?? ""),
          });
        }
        // 게이트키퍼는 (call,args)만 검사한다 — 컨텍스트 토큰은 통과 후 수행부에만 넘긴다.
        const response = await handleBridgeRequest(
          grant,
          { call, args },
          (c, a) => execute(c, a, ctx),
          env,
        );
        // 거부는 **플러그인이 .catch를 걸었든 아니든** 여기서 한 번 기록된다(의 핵심) —
        // 인자는 절대 싣지 않는다(노트 본문 유출 차단). 이 한 지점이 브리지 거부 전부를 덮는다.
        if (!response.ok) {
          diagnostics.record({
            pluginId,
            kind: "call-reject",
            call,
            code: response.code,
            message: response.error ?? "거부됨",
          });
        } else if (isExperimentalCall(call) && !warnedExperimental.has(call)) {
          // experimental 호출이 **실제로 통과·실행되면** 관측 가능한 경고를 남긴다 —
          // "지금 동작하지만 다음 버전에서 계약이 바뀔 수 있다". 조용한 표식이 아니라 「최근
          // 오류」에 뜨는 진단이라 저작자·AI가 앱을 띄우지 않고도 본다(apiVersion과 다른 점).
          // 빌드당 (플러그인, 호출) 1회로 좁힌다 — 매 호출마다 남기면 링버퍼를 채워 진짜
          // 거부를 밀어낸다. 거부(response.ok=false)에는 남기지 않는다: 그건 이미 call-reject로
          // 잡히고, 실행되지 않은 호출의 불안정성 경고는 잡음이다.
          warnedExperimental.add(call);
          diagnostics.record({
            pluginId,
            kind: "experimental-call",
            call,
            message: `memo.${call}는 실험적(experimental) API라 다음 버전에서 인자·반환·의미가 바뀔 수 있습니다 — 계약이 굳을 때까지 방어적으로 쓰세요`,
          });
        }
        return response;
      },
      // 샌드박스 **안에서** 난 실패(핸들러 예외·미처리 rejection)도 같은 기록으로 모은다 —
      // 이 배선이 없으면 "버튼은 눌리는데 아무 일도 안 일어난다"의 원인이 앱 어디에도 안 남는다.
      (entry) => {
        diagnostics.record({
          pluginId,
          kind: entry.kind,
          ...(entry.call ? { call: entry.call } : {}),
          ...(entry.code ? { code: entry.code } : {}),
          message: entry.message,
        });
      },
    );
    sandboxes.set(pluginId, sandbox);
    try {
      await awaitBoot(sandbox);
    } catch (e) {
      // 실행 실패한 플러그인의 샌드박스는 정리한다 — 소유 목록(sandboxes)이 항상
      // "스냅샷에 실린 살아있는 플러그인"과 일치하게 유지한다.
      sandbox.dispose();
      sandboxes.delete(pluginId);
      throw e;
    }
    // 매니페스트 기여는 `main.js`가 **끝난 뒤에** 적용한다 — 그래야 같은 id에서 매니페스트가
    // 이긴다(의 우선순위 규칙: 정적 검증을 통과한 쪽이 정본). 순서를 뒤집으면 JS가 조용히
    // 덮어써서, 저작자가 매니페스트만 고치고 왜 안 바뀌는지 모르는 상태가 된다.
    await applyContributes();
    return collected();
  }

  /**
   * 활성 테마 이름을 해석·실행해 [`ThemeDescriptor`]를 얻는다(못 찾거나 실패 시 SJ_D).
   *
   * 테마 샌드박스는 등록만 하고 즉시 정리한다(일시 실행 — 상주 소유 대상이 아니다).
   *
   * **제약: 테마 경로에서는 `theme.register`만 쓸 수 있다.** 이 샌드박스는 즉시 dispose되므로
   * 버튼·설정 같은 상주 능력을 수집해 봐야 곧바로 버려진다 — 조용히 삼키는 대신 명확한
   * 오류로 거부한다(테마가 `ui`·`settings`를 선언해도 마찬가지). 실패 사유는 호출자가
   * 스냅샷 `failures`로 노출한다.
   *
   * kind 게이트는 `env.kind: "capability"`를 주어 통과시킨다 — 테마로 선택된다는 것 자체가
   * 그 플러그인이 능력(테마)임을 뜻하고(`resolveThemeSource`가 `theme` 권한 선언까지 요구한다),
   * 이 경로는 허용 호출이 `theme.register` 하나뿐이라 이미 그보다 좁다. `kind: "action"`으로
   * 선언한 플러그인이 **테마로 선택되어도** 테마 등록은 통과한다(테마 선택은 사용자의 명시적
   * 행위다).
   */
  async function loadThemeDescriptor(
    name: string,
    sources: InstalledPluginSource[],
  ): Promise<{ theme: ThemeDescriptor; failure: PluginFailure | null }> {
    const source = resolveThemeSource(name, sources);
    if (!source) return { theme: SJ_D, failure: null };
    const registrar = makeRegistrar();
    const themeEnv = runtimeEnv(baseThemeName(name), { kind: "capability" });
    const sandbox = factory(deps.doc, source.code, (call, args) =>
      handleBridgeRequest(
        source.grant,
        { call, args },
        (c, a) => {
          if (c !== "theme.register") {
            console.warn("[memo] 테마 플러그인의 비테마 호출 거부:", name, c);
            return Promise.reject(
              new Error(
                `테마 플러그인은 theme.register만 사용할 수 있습니다: ${c}`,
              ),
            );
          }
          return registrar.execute(c, a);
        },
        themeEnv,
      ),
    );
    try {
      await awaitBoot(sandbox);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[memo] 플러그인 로드 실패:", name, error);
      // 실패 id는 `<custom>` 접미를 벗긴 **베이스 테마 id**로 남긴다(resolveThemeSource와 같은
      // 규칙) — 설정 매니저가 플러그인 id로 조회하므로 파생 이름이면 ⚠ 배지가 매칭되지 않는다.
      return { theme: SJ_D, failure: { pluginId: baseThemeName(name), error } };
    } finally {
      sandbox.dispose();
    }
    return { theme: registrar.theme ?? SJ_D, failure: null };
  }

  /**
   * 영속화 콜백을 진단으로 감싼다 — 저장이 백엔드에서 거부되면 기록한다.
   *
   * 왜 build 밖으로 뺐나: 전체 빌드와 단일 핫리로드가 **같은** 영속화 진단 규칙을 쓰게
   * 한다 — 한쪽만 감싸면 개발 모드에서 저장한 값의 거부가 「최근 오류」에서 사라진다.
   */
  const watchedPersist =
    (
      pluginId: string,
      persist: (key: string, value: unknown) => void | Promise<void>,
    ) =>
    (key: string, value: unknown): void => {
      const result = persist(key, value);
      if (!result || typeof result.then !== "function") return;
      void result.catch((e: unknown) => {
        diagnostics.record({
          pluginId,
          kind: "setting-write-rejected",
          call: "settings.set",
          message: `${key}: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    };

  /**
   * 이 빌드/리로드에서 실행되는 플러그인 1개의 실행 정체(`runtime.info` + 게이트 입력).
   *
   * `hostVersion`·`os`는 build()가 갱신한 캐시([`hostVersionValue`]·[`platformId`])에서 읽는다 —
   * 그래야 전체 빌드로 뜬 19개와 핫리로드로 다시 뜬 1개가 **같은 세계**를 본다.
   *
   * `reason`이 언제나 `"reload"`인 것은 하드코딩이 아니라 **호스트가 아는 전부**다: 설치·갱신·
   * 개발 리로드 흐름이 결국 방송 하나로 수렴하므로 이 자리에서 그 셋을 구분할 근거가 없다.
   */
  const runtimeEnv = (
    pluginId: string,
    manifest: { kind?: PluginKind },
  ): PluginRuntimeEnv => ({
    pluginId,
    hostVersion: hostVersionValue,
    os: platformId,
    reason: "reload",
    locale: localeValue,
    ...(manifest.kind !== undefined ? { kind: manifest.kind } : {}),
  });

  /**
   * 설치(사이드로드) 소스 1개를 실행해 스냅샷 조각을 낸다(build 루프와 단일 핫리로드 공유).
   *
   * 매니페스트 검증·미지원 OS 판정은 **호출부**가 한다(실패 취급이 경로마다 다르다 — build는
   * failures에 싣고 리로드는 스냅샷 슬롯을 비운다). 여기서는 설정 바인딩 → `settingsOf` 등록 →
   * `runPlugin`만 담당해 두 경로가 갈라지지 않게 한다.
   */
  async function runPreparedInstalled(
    prepared: {
      id: string;
      code: string;
      grant: PluginGrant;
      settings: PluginSettingField[];
      contributes: PluginContributions | undefined;
      kind?: PluginKind;
      exposes: string[] | undefined;
    },
    sourceSettings: Record<string, unknown> | undefined,
  ): Promise<PluginSnapshot> {
    const schema = prepared.settings;
    const settings = bindPluginSettings(
      mergeSettingDefaults(schema, sourceSettings),
      watchedPersist(prepared.id, (key, value) =>
        deps.persistPluginSetting(prepared.id, key, value),
      ),
    );
    settingsOf.set(prepared.id, { get: (key) => settings.get(key), schema });
    return runPlugin(
      prepared.id,
      prepared.code,
      prepared.grant,
      settings,
      schema,
      runtimeEnv(prepared.id, prepared),
      false,
      prepared.contributes,
      prepared.exposes ?? [],
    );
  }

  /**
   * `plugins` 배열 + 현재 `eventSubs`에서 스냅샷의 **전역 파생값**을 계산한다(build·핫리로드 공유).
   *
   * 능력(배경·폰트·창 컨트롤)은 등록 순서에 의존하는 병합이라 이 한 곳에서만 조립한다 —
   * 부분 갱신이 이 규칙을 따로 재현하다 어긋나는 위험(위험 절)을 아예 만들지 않는다.
   * 단일 핫리로드는 능력을 건드리는 변화면 전체 리로드로 폴백하므로, 이 함수가 부분 경로에서
   * 부르는 값은 언제나 "능력 없음"이다(그래도 같은 코드로 계산해 두 경로가 갈라지지 않게 한다).
   */
  async function deriveGlobals(plugins: PluginSnapshot[]): Promise<{
    background: HostSnapshot["background"];
    font: HostSnapshot["font"];
    windowControls: string[];
    subscribedEvents: MemoEventName[];
  }> {
    const background = plugins.find((p) => p.background)?.background ?? null;
    const fontDescriptors = plugins
      .map((p) => p.font)
      .filter((f): f is FontDescriptor => f != null);
    const systemFamilies = fontDescriptors.some((f) => f.includeSystem)
      ? systemFontFamilies(
          await (deps.systemFonts?.() ?? Promise.resolve([])).catch(() => []),
        )
      : [];
    const font =
      fontDescriptors.length === 0
        ? null
        : {
            families: mergeFontFamilies([
              ...fontDescriptors.map((f) => f.families),
              systemFamilies,
            ]),
          };
    const windowControls = [
      ...new Set(plugins.flatMap((p) => p.windowControls ?? [])),
    ];
    const subscribedEvents = [
      ...new Set(
        [...eventSubs.values()].flatMap((subs) =>
          [...subs.values()].map((s) => s.name),
        ),
      ),
    ];
    return { background, font, windowControls, subscribedEvents };
  }

  /**
   * 이번 빌드의 전 플러그인 메뉴바 트레이 항목을 수집 순서대로 평탄화해 네이티브로
   * **전체 교체** 배달한다.
   *
   * 왜 함수로 뽑나: `build()`(전체 재빌드)와 `rebuildPlugin`(단일 핫리로드) **두 경로가
   * 같은 배달 로직을 공유**해야 한다 — 갈라지면 개발 모드에서 트레이만 마지막 `build()` 시점의
   * 옛 값으로 멈추는 무음 실패가 난다(라벨을 바꿔도 메뉴바에 안 뜨는데 어떤 진단도 안 남는 —
   * 「무음 실패의 표면화」에 정면으로 어긋나는 사각지대). 전체 교체(증분 아님)라 플러그인을
   * 끄거나 리로드 중 실패로 빠지면 그 항목이 트레이에서 자연히 사라진다 — 스냅샷 `plugins`가
   * 곧 "지금 살아있는 것 전부"이므로 여기서 평탄화하면 죽은 항목이 남지 않는다.
   *
   * 비차단·실패 무해(호스트 창 밖 build()면 invoke가 거부되지만 부팅을 막지 않는다) — 배달
   * 실패로 노트 창·창-스코프 호출이 죽지 않게 한다.
   */
  function deliverTrayItems(plugins: readonly PluginSnapshot[]): void {
    const trayList: TrayItemDescriptor[] = plugins.flatMap((p) =>
      (p.trayItems ?? []).map((t) => ({
        pluginId: p.pluginId,
        id: t.id,
        label: t.label,
      })),
    );
    void Promise.resolve(
      (deps.setTrayItems ?? tauriSetTrayItems)(trayList),
    ).catch((e: unknown) =>
      console.error("[memo] 플러그인 트레이 항목 배달 실패:", e),
    );
  }

  /**
   * 모든 활성 플러그인·테마를 (재)실행해 스냅샷을 새로 조립한다.
   *
   * 역할: 기존 샌드박스를 전부 정리한 뒤 번들(활성) → 설치(활성) 순서로 실행한다
   * (에디터 확장 우선순위가 기존 per-window 로더와 같도록 순서 보존). 개별 플러그인
   * 실패는 나머지 로드를 막지 않되 **조용히 넘기지 않는다** — 스냅샷 `failures`에 사유와
   * 함께 실어 설정 매니저가 표시하게 한다. 완료 후 대기 중이던 스냅샷 요청에 응답한다.
   */
  async function build(): Promise<void> {
    snapshot = null;
    // 파괴 **전에** 정리 기회를 준다 — 병렬로 기다리고 상한을 넘긴 것만 진단에 남긴다.
    // 순서가 중요하다: 아래의 컨텍스트·대기표 정리보다 먼저 와야, dispose 핸들러가 마지막으로
    // 부르는 창-스코프 호출·설정 저장이 아직 유효한 상태에서 처리된다.
    await Promise.all(
      [...sandboxes.entries()].map(async ([pluginId, sandbox]) => {
        const flushed = await sandbox
          .notifyDispose(DISPOSE_TIMEOUT_MS)
          .catch(() => false);
        if (flushed) return;
        diagnostics.record({
          pluginId,
          kind: "call-reject",
          call: "runtime.onDispose",
          code: "DISPOSE_TIMEOUT",
          message: `onDispose가 ${DISPOSE_TIMEOUT_MS}ms 안에 끝나지 않아 정리를 기다리지 않고 파괴했습니다`,
        });
      }),
    );
    for (const sandbox of sandboxes.values()) sandbox.dispose();
    sandboxes.clear();
    // `contexts`(플러그인 → 마지막 클릭 창 + 활동 시각)는 **비우지 않는다**. 창
    // 라벨은 재빌드를 넘어 유효하다 — 노트 창은 제자리에서 조정되거나(대개) 리로드될 뿐,
    // 어느 쪽이든 `note-<id>` 라벨과 창-스코프 호출에 응답하는 능력을 그대로 유지한다.
    // 비웠을 때 실제로 깨진 흐름: 설정 폼의 액션
    // 버튼은 `windowLabel: ""`로 쏘므로 컨텍스트를 **만들지 못하고 폴백에만 의존**하는데,
    // 바로 위 폼에서 값을 하나 저장하면 그 저장이 재빌드를 돌려 폴백 창이 방금 사라졌다
    // ("고치고 바로 눌러 본다"가 이 버튼의 유일한 자연스러운 사용 흐름인데 항상 실패했다).
    // 재빌드를 넘어도 만료는 남는다: `lastUsed`가 보존되므로 유휴 5분을 넘긴 폴백은
    // 민감 호출에 대해 그대로 거부된다 — 재빌드가 수명 연장 수단이 되면 안 된다.
    // 무효가 되는 것은 아래 `invocations`(그 클릭에 발급한 토큰)뿐이다.
    // 구독·명령은 리빌드 단위로 닫힌다(에 `off`가 없는 이유) — 남기면 이벤트가 N배로
    // 발화하고, 죽은 샌드박스의 handlerId를 가리키는 명령이 단축키 목록에 유령으로 남는다.
    eventSubs.clear();
    commandsOf.clear();
    menuItemsOf.clear();
    selectionActionsOf.clear();
    trayItemsOf.clear();
    exposesOf.clear();
    eventTokens.clear();
    settingsOf.clear();
    // `storage.session`·`storage.window`는 **일부러 비우지 않는다**. 재빌드는 설정을 한
    // 글자 바꿀 때마다 도는 일상 경로라, 여기서 비우면 `session`이 `local`의 못 쓰는 사본이
    // 된다 — 이 두 스코프가 약속하는 수명은 "재빌드까지"가 아니라 "이 호스트 창이 사는 동안"이다.
    // 이전 빌드의 호출 컨텍스트는 전부 무효(대상 샌드박스·창 구성이 바뀌었다).
    invocations.clear();
    // 노트 목록 캐시도 비운다 — 재빌드는 notes-reload(노트 생성·삭제 등)로도 도는 경로라,
    // 여기서 비워야 "방금 만든 노트가 목록에 없다"가 TTL만큼도 이어지지 않는다.
    notesListCache = null;
    // 진행 중이던 창-스코프 호출은 즉시 취소한다 — 대상 샌드박스·컨텍스트가 방금 무효가
    // 됐으므로 5초 타임아웃까지 기다리게 두지 않는다(응답은 정리된 iframe에 무해하게 소멸).
    for (const waiter of windowCalls.values()) {
      waiter.reject(new Error("호스트 재빌드로 취소됨"));
    }
    windowCalls.clear();

    const [
      builtinStates,
      builtinSettings,
      installedSources,
      allSources,
      themeName,
      platform,
      hostVersion,
      locale,
    ] = await Promise.all([
      deps.builtinStates(),
      deps.builtinSettings(),
      deps.enabledInstalledSources().catch(() => []),
      deps.allInstalledSources().catch(() => []),
      deps.activeThemeName(),
      (deps.platform?.() ?? Promise.resolve("")).catch(() => ""),
      (deps.hostVersion?.() ?? Promise.resolve("")).catch(() => ""),
      (deps.activeLocale?.() ?? Promise.resolve("ko")).catch(() => "ko"),
    ]);
    // `runtimeEnv`·단일 핫리로드가 읽는 캐시를 이 빌드 값으로 굳힌다 — 루프보다 먼저
    // 채워야 첫 플러그인부터 올바른 hostVersion/os/locale을 본다.
    hostVersionValue = hostVersion;
    platformId = platform;
    localeValue = locale;

    const plugins: PluginSnapshot[] = [];
    const failures: PluginFailure[] = [];

    /** 실패 1건을 기록한다(콘솔 + 스냅샷) — 빈 껍데기로 plugins에 싣지 않는다. */
    const recordFailure = (pluginId: string, e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[memo] 플러그인 로드 실패:", pluginId, error);
      failures.push({ pluginId, error });
    };

    // 번들: 기록 없음/조회 실패(null) → 기본 켜짐. 1st-party라 선언 = 부여.
    for (const builtin of builtins) {
      if (!(builtinStates?.[builtin.id] ?? true)) continue; // 꺼진 번들은 미실행.
      // 현재 OS에서 미지원인 번들은 실행하지 않는다(자동 비활성화 — 스냅샷에서 제외).
      if (!isSupportedOnPlatform(builtin.platforms, platform)) continue;
      const parsed = parseManifest({
        id: builtin.id,
        name: builtin.name,
        version: builtin.version,
        entry: "main.js",
        permissions: builtin.permissions,
      });
      if (!parsed.ok) continue;
      const grant: PluginGrant = {
        declared: parsed.manifest.permissions,
        granted: parsed.manifest.permissions,
      };
      // 번들 경로에도 매니페스트 기본값을 병합한다 — 예전엔 저장된 값만 바인딩해서,
      // 사용자가 설정 폼을 한 번도 안 열면 `settings.get`이 null이었다(그래서 번들들이
      // 기본값을 main.js에 다시 하드코딩했다). 설치 경로는 Rust `resolve_settings`가 이미
      // 같은 병합을 하므로 이제 두 경로가 같은 값을 본다.
      const schema = builtin.settings ?? [];
      const settings = bindPluginSettings(
        mergeSettingDefaults(schema, (builtinSettings ?? {})[builtin.id]),
        watchedPersist(builtin.id, (key, value) =>
          deps.persistBuiltinSetting(builtin.id, key, value),
        ),
      );
      // 폼에서 값이 바뀌었을 때 `oldValue`를 아는 곳은 이 인메모리 바인딩뿐이다.
      settingsOf.set(builtin.id, { get: (key) => settings.get(key), schema });
      try {
        plugins.push(
          await runPlugin(
            builtin.id,
            builtin.code,
            grant,
            settings,
            schema,
            // 번들도 설치 플러그인과 **같은 게이트 입력**을 받는다 — 번들 20개가
            // 매니페스트에 `kind`를 적어 두고 게이트만 빠져나가면 도그푸딩이 거짓이 된다.
            runtimeEnv(builtin.id, builtin),
            true,
            builtin.contributes,
            builtin.exposes ?? [],
          ),
        );
      } catch (e) {
        // 개별 번들 실행 실패는 나머지를 막지 않되 사유를 남긴다.
        recordFailure(builtin.id, e);
      }
    }

    // 설치(사이드로드): 검증 + 부여를 선언과의 교집합으로 좁힌 뒤 같은 보안 경로로 실행.
    for (const source of installedSources) {
      const result = prepareInstalledPlugin(source);
      if (!result.ok) {
        // 검증 실패를 **조용히 건너뛰지 않는다**: 예전엔 `continue`뿐이라 TS 검증만 거부하는
        // 매니페스트에서 그 플러그인이 ⚠ 배지도 진단도 없이 사라졌다(사용자·저작자 모두
        // 원인을 찾을 근거가 0). 스냅샷 failures에 실어 설정 화면이 사유를 보이게 한다.
        recordFailure(result.id, new Error(result.error));
        continue;
      }
      const prepared = result.plugin;
      // 현재 OS 미지원 설치 플러그인도 실행하지 않는다(번들과 동일 게이트).
      if (!isSupportedOnPlatform(prepared.platforms, platform)) continue;
      try {
        // 설정 바인딩·settingsOf 등록·runPlugin은 단일 핫리로드와 **공유**한다 — 두
        // 경로가 갈라지면 개발 모드로 뜬 플러그인과 정식 빌드로 뜬 플러그인이 달라진다.
        plugins.push(await runPreparedInstalled(prepared, source.settings));
      } catch (e) {
        // 개별 플러그인 실행 실패는 나머지 로드를 막지 않되 사유를 남긴다.
        recordFailure(prepared.id, e);
      }
    }

    const loadedTheme = await loadThemeDescriptor(themeName, allSources);
    const theme = loadedTheme.theme;
    if (loadedTheme.failure) failures.push(loadedTheme.failure);
    // 배경·폰트·창 컨트롤·구독 집합은 등록 순서 의존 병합이라 한 곳(deriveGlobals)
    // 에서만 조립한다 — 단일 핫리로드의 부분 갱신 판정이 같은 계산을 재사용한다.
    const { background, font, windowControls, subscribedEvents } =
      await deriveGlobals(plugins);

    // `when` 조건의 정적 입력을 이 빌드 값으로 굳힌다 — 명령이 실행되는 시점에 다시
    // 읽어야 하므로 빌드 지역 변수가 아니라 호스트 상태여야 한다. 재빌드가 정본이다
    // (플러그인을 켜고 끄면 재빌드가 돌므로 `plugin.<id>.enabled`가 자동으로 최신이 된다).
    // `platformId`·`hostVersionValue`는 위에서 이미 채웠다(runtimeEnv가 루프 중 읽는다).
    enabledPluginIds = new Set(plugins.map((p) => p.pluginId));

    revision += 1;
    snapshot = {
      revision,
      theme,
      background,
      font,
      windowControls,
      subscribedEvents,
      plugins,
      failures,
    };

    // 빌드 중 대기하던 요청에 최신 스냅샷으로 응답한다.
    for (const requestId of pendingGets.splice(0)) {
      deps.bus.emit(EV_SNAPSHOT, { requestId, snapshot });
    }
    // 메뉴바 트레이 항목을 네이티브로 배달한다 — 스냅샷 `plugins` 순서(번들 → 설치)대로
    // 평탄화해 전체 교체한다. 단일 핫리로드(rebuildPlugin)와 **같은 헬퍼**를 쓴다(배달 로직 단일 출처).
    deliverTrayItems(plugins);
    // e2e·디버깅용 준비 마커(빌드마다 revision 갱신).
    deps.doc.body?.setAttribute("data-host-ready", String(revision));
  }

  /**
   * 개발 중인 플러그인 **하나만** 다시 실행한다(단일 핫리로드).
   *
   * 역할: 그 플러그인의 샌드박스 하나만 dispose·재실행하고 스냅샷의 해당 슬롯만 교체한다.
   * 나머지 샌드박스(19개)·노트 창 상태·`storage.session`/`window`·다른 플러그인의 컨텍스트는
   * **건드리지 않는다**. 이 플러그인의 옛 컨텍스트 토큰·이벤트 토큰만 무효화한다(샌드박스가
   * 교체됐다). 저작자의 "고치고 → 확인" 루프에서 전체 재빌드/전체 리로드 비용을 없애는 것이
   * 이 함수의 존재 이유다.
   *
   * 버튼·명령·상태 아이템·메뉴 항목(툴바 항목 넷)은 더 이상 이 폴백 사유가 아니다 — 노트
   * 창이 부분 갱신 신호([`EV_HOST_PLUGIN_UPDATED`])를 받으면 CM 확장과 **함께** 그 넷을 키로
   * diff해 맞춘다(`NoteWindowHandle.reconcileToolbarItems`, 아래 `canPartial` 참고).
   *
   * **부분 갱신이 불가능한 변화**(등록 순서 의존 병합 능력 — 배경·폰트·창 컨트롤, 구독 이벤트
   * 집합 변경, 플러그인 슬롯 추가·제거·실패, 활성 테마, 소스 소실)는 재빌드 완료 방송으로
   * 폴백한다([`EV_HOST_UPDATED`], 사유 `"plugins"`) — 그런 표면은 등록 순서 의존 병합이라
   * 부분 재구성이 규칙을 어긋나게 재현할 위험이 있다(위험 절). 이 채널 자체가 설치(사이드로드)
   * 개발 플러그인의 단일 핫리로드 전용이라, builtin 플러그인의 변화는 애초에 이 함수를 타지
   * 않고 항상 전체 빌드(`build()`) + `EV_HOST_UPDATED`로 간다. 그 방송을 받은 노트 창이 새
   * 스냅샷을 예전 것과 비교해 리로드할지 제자리에서 조정할지 다시 판정한다
   * (`bootstrap/host-update-plan.ts`).
   * 폴백은 진단에 사유를 남긴다(설정 창 「최근 오류」에 뜬다 — "UI에 표시" 요구 충족).
   *
   * **보안 불변**: 개발 소스도 `prepareInstalledPlugin`을 그대로 타므로 게이트키퍼·권한
   * 클램프가 정식 설치와 똑같이 적용된다. 개발 모드는 편의지 우회가 아니다.
   */
  async function rebuildPlugin(pluginId: string): Promise<void> {
    let source: InstalledPluginSource | null = null;
    try {
      source = (await deps.devSource?.(pluginId)) ?? null;
    } catch {
      source = null;
    }
    const activeTheme = await deps.activeThemeName().catch(() => "");
    // `localeValue` 캐시도 build()와 같은 이유로 **재실행보다 먼저** 갱신한다 — 아래
    // `runPreparedInstalled`가 `runtimeEnv()`로 이 플러그인의 실행 정체를 만드는데, 그때
    // 옛 값이 실리면 방금 바꾼 언어를 이 플러그인만 한 세대 늦게 본다(`localeValue` 선언부의
    // 같은 주석 참고).
    localeValue = await (deps.activeLocale?.() ?? Promise.resolve("ko")).catch(
      () => "ko",
    );
    // 증분 불가 → 전체 재빌드 폴백:
    //  - 초기 빌드 미완(스냅샷 없음): 진행 중 빌드가 최신을 낸다.
    //  - 소스 소실(폴더 삭제·읽기 실패): 무엇을 실행할지 모른다.
    //  - 활성 테마: 테마 병합은 등록 순서 의존이라 부분 교체가 어긋난다.
    if (
      snapshot === null ||
      !source ||
      baseThemeName(activeTheme) === pluginId
    ) {
      diagnostics.record({
        pluginId,
        kind: "log",
        message:
          "[개발 모드] 증분 재실행 불가로 전체 리로드했습니다: " +
          (snapshot === null
            ? "초기 빌드 진행 중"
            : !source
              ? "개발 소스를 읽지 못함"
              : "활성 테마(등록 순서 의존 병합)"),
      });
      await build();
      // 개발 소스가 바뀌어 돈 재실행이라 사유는 플러그인 변경이다 — 노트 창은 이 사유와
      // 새 스냅샷을 보고 리로드/조정을 스스로 가른다(여기서 강제하지 않는다).
      deps.bus.emit(EV_HOST_UPDATED, { revision, reasons: ["plugins"] });
      return;
    }
    const snap = snapshot;

    const oldIndex = snap.plugins.findIndex((p) => p.pluginId === pluginId);
    const oldSlice = oldIndex >= 0 ? snap.plugins[oldIndex] : null;
    const oldSubscribed = snap.subscribedEvents ?? [];

    // 이 플러그인 하나만 정리한다(파괴 전 onDispose 기회 — build와 같은 계약).
    const old = sandboxes.get(pluginId);
    if (old) {
      await old.notifyDispose(DISPOSE_TIMEOUT_MS).catch(() => false);
      old.dispose();
      sandboxes.delete(pluginId);
    }
    // 구독·명령·설정 바인딩은 다시 만들 것이므로 지운다(runPlugin이 재설정).
    eventSubs.delete(pluginId);
    commandsOf.delete(pluginId);
    menuItemsOf.delete(pluginId);
    // 선택 액션도 명령·메뉴와 같은 자리에서 지운다 — 성공하면 runPlugin이 다시 채우고,
    // 실패하면 지워진 채 남아 죽은 handlerId를 가리키는 유령 버튼이 생기지 않는다.
    selectionActionsOf.delete(pluginId);
    // 트레이 항목도 명령·메뉴와 같은 자리에서 지운다 — 성공하면 runPlugin이 다시 채우고,
    // 로드 실패·미지원 OS로 newSlice가 null이 되면 지워진 채 남아 아래 deliverTrayItems가 죽은
    // handlerId(이미 폐기된 샌드박스를 가리키는)를 네이티브에서 걷어낸다(눌러도 무반응인 유령 방지).
    trayItemsOf.delete(pluginId);
    exposesOf.delete(pluginId);
    settingsOf.delete(pluginId);
    // 이 플러그인의 이벤트 토큰·호출 컨텍스트만 무효화(샌드박스가 교체됐다). 다른 플러그인
    // 토큰과 storage.session/window, contexts(마지막 클릭 창 — 창 라벨은 여전히 유효)는 보존.
    for (const key of [...eventTokens.keys()]) {
      if (key.startsWith(`${pluginId}\u0000`)) eventTokens.delete(key);
    }
    for (const [token, info] of [...invocations]) {
      if (info.pluginId === pluginId) invocations.delete(token);
    }

    // 이 하나만 다시 실행한다(다른 샌드박스는 그대로 살아 있다).
    let newSlice: PluginSnapshot | null = null;
    let failure: PluginFailure | null = null;
    const result = prepareInstalledPlugin(source);
    if (!result.ok) {
      failure = { pluginId: result.id, error: result.error };
    } else if (isSupportedOnPlatform(result.plugin.platforms, platformId)) {
      try {
        newSlice = await runPreparedInstalled(result.plugin, source.settings);
      } catch (e) {
        failure = {
          pluginId: result.plugin.id,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    // 미지원 OS면 newSlice·failure 둘 다 null → 스냅샷에서 조용히 빠진다(build와 같은 취급).

    // plugins 배열을 원래 순서로 재조립(슬롯 교체 또는 제거).
    const plugins = snap.plugins.filter((p) => p.pluginId !== pluginId);
    if (newSlice) {
      const at =
        oldIndex >= 0 ? Math.min(oldIndex, plugins.length) : plugins.length;
      plugins.splice(at, 0, newSlice);
    }
    // 실패 목록: 이 플러그인의 옛 항목만 갈아끼운다(다른 실패·테마 실패는 보존).
    const failures = snap.failures.filter((f) => f.pluginId !== pluginId);
    if (failure) failures.push(failure);

    const globals = await deriveGlobals(plugins);
    enabledPluginIds = new Set(plugins.map((p) => p.pluginId));

    // 부분 갱신 가능? 노트 창이 **제자리에서 따라갈 수 없는** 표면(등록 순서 의존 병합인
    // 능력)이 걸려 있지 않고, 전역 구독 집합도 그대로일 때만. 추가·제거·실패로 슬롯 구조가
    // 바뀌어도 전체 리로드로 폴백한다.
    //
    // 버튼·명령은 더 이상 여기서 보지 않는다: 노트 창이 부분 갱신 신호를 받으면 CM 확장과
    // **함께** 툴바 항목을 키로 diff해 맞춘다(`bootstrap/note.ts`의 EV_HOST_PLUGIN_UPDATED
    // 핸들러 → `NoteWindowHandle.reconcileToolbarItems`). 오히려 예전 조건이 반쪽이었다 —
    // 상태 아이템·메뉴 항목은 애초에 보지 않아, 그 둘만 바꾼 개발 편집은 부분 갱신을 타고도
    // 화면에 반영되지 않았다(무음 실패). 이제 넷 다 같은 경로로 따라간다.
    const canPartial =
      oldSlice !== null &&
      newSlice !== null &&
      failure === null &&
      !sliceHasCapabilities(oldSlice) &&
      !sliceHasCapabilities(newSlice) &&
      sameNameSet(oldSubscribed, globals.subscribedEvents);

    revision += 1;
    snapshot = {
      revision,
      theme: snap.theme,
      background: globals.background,
      font: globals.font,
      windowControls: globals.windowControls,
      subscribedEvents: globals.subscribedEvents,
      plugins,
      failures,
    };
    deps.doc.body?.setAttribute("data-host-ready", String(revision));

    // 트레이 항목을 네이티브로 재배달한다 — `canPartial` 여부와 **무관하게** 매번 부른다:
    // 부분 갱신은 노트 창의 CM 확장만 재구성할 뿐 네이티브 메뉴바를 건드리지 않고, 전체 리로드
    // 폴백(EV_HOST_UPDATED)도 중앙 호스트에서 build()를 다시 돌리지 않는다(스냅샷은 이미 여기서
    // 갱신됐다). 그래서 이 배달을 빼면 개발 중 트레이 라벨·항목 변경이 메뉴바에 영영 반영되지
    // 않는다. 전체 교체라 이 비용은 낮고(build()가 이미 그렇게 한다), newSlice가 null인 실패
    // 경로에서도 위에서 trayItemsOf를 지웠으므로 죽은 항목이 메뉴에서 사라진다.
    deliverTrayItems(plugins);

    if (canPartial) {
      // 노트 창은 이 플러그인의 CM 확장만 재구성한다(창 상태 보존).
      deps.bus.emit(EV_HOST_PLUGIN_UPDATED, { revision, pluginId, snapshot });
    } else {
      diagnostics.record({
        pluginId,
        kind: "log",
        message:
          "[개발 모드] 능력·구독 또는 슬롯 구조가 바뀌어 일반 재빌드로 폴백했습니다(노트 창이 다시 판정해 필요한 경우에만 리로드합니다)",
      });
      // 개발 소스가 바뀌어 돈 재실행이라 사유는 플러그인 변경이다 — 노트 창은 이 사유와
      // 새 스냅샷을 보고 리로드/조정을 스스로 가른다(여기서 강제하지 않는다).
      deps.bus.emit(EV_HOST_UPDATED, { revision, reasons: ["plugins"] });
    }
  }

  // ---- 프로토콜 구독(상주) ----

  deps.bus.listen(EV_SNAPSHOT_GET, (payload) => {
    const p = payload as SnapshotGetPayload | null;
    if (!p || typeof p.requestId !== "string") return;
    if (snapshot === null) {
      // 빌드 중 — 완료 시 응답(중복 재시도 requestId는 한 번만 답해도 요청자가 걸러낸다).
      if (!pendingGets.includes(p.requestId)) pendingGets.push(p.requestId);
      return;
    }
    deps.bus.emit(EV_SNAPSHOT, { requestId: p.requestId, snapshot });
  });

  deps.bus.listen(EV_BUTTON_INVOKE, (payload) => {
    const p = payload as ButtonInvokePayload | null;
    if (!p || typeof p.pluginId !== "string") return;
    // 이 클릭에 컨텍스트 토큰을 발급해(정확한 라우팅) 샌드박스 onClick을 역호출한다.
    // 마지막 클릭 창도 함께 기록한다 — 토큰 없는 호출의 폴백.
    //
    // 빈 라벨 = **창 컨텍스트 없음**(설정 화면 액션 버튼, . 이때는 기록도 발급도 하지
    // 않는다: 설정 창은 창-스코프 호출에 응답할 표면이 없어, ""를 "마지막 클릭 창"으로
    // 기억하면 그 뒤 그 플러그인의 모든 폴백 호출이 아무도 없는 창을 향해 타임아웃한다
    // (창 라우팅이 뒤집히는 이 저장소의 단골 사고 유형을 여기서 다시 열지 않는다).
    const windowLabel = String(p.windowLabel ?? "");
    if (windowLabel !== "") {
      contexts.set(p.pluginId, {
        window: windowLabel,
        lastUsed: Date.now(),
        inflight: 0,
      });
    } else {
      // 설정 화면 액션 버튼은 `windowLabel: ""`로 온다 — 창 컨텍스트를 **만들지는**
      // 않되(""를 창으로 기억하면 이후 폴백이 아무도 없는 창으로 타임아웃한다, 아래 주석),
      // 기존 폴백 컨텍스트가 있으면 그 활동 시각만 갱신한다. 이 클릭도 '이 플러그인에 대한
      // 지금의 사용자 활동'이므로, 방금 누른 액션 버튼의 민감 폴백 호출(insertText·
      // notes.duplicate·clipboard.write 등)이 5분 전 노트-창 클릭 기준으로 유휴 만료
      // 되는 모순을 없앤다 — 만료가 '고치고 바로 눌러 본다' 흐름을 5분 창으로 좁히지
      // 않게 하고, "새 클릭으로 다시 호출하라"는 진단 처방(설정 화면엔 노트-창 클릭 표면이
      // 없어 실행 불가)과의 어긋남도 없앤다.
      const existing = contexts.get(p.pluginId);
      if (existing) existing.lastUsed = Date.now();
    }
    const token =
      windowLabel === "" ? "" : issueInvocation(p.pluginId, windowLabel);
    // 명령 실행은 같은 채널의 다른 페이로드다 — 창 컨텍스트 발급까지는 버튼과 **완전히
    // 같은 절차**를 타고, 여기서부터 조건 판정·확인 팝업이 얹힌다.
    if (typeof p.commandId === "string" && p.commandId !== "") {
      void invokeCommand(p.pluginId, p.commandId, windowLabel, token);
      return;
    }
    // 메뉴 전용 항목 실행도 같은 채널의 또 다른 페이로드다 — 창 컨텍스트 발급까지 버튼과
    // 같은 절차를 타고, 여기서부터 `run` 역호출에 선택 텍스트(부여됐을 때만)를 얹는다. 이 분기가
    // 없으면 `menuItemId`만 실린 클릭이 아래 buttonId 폴백으로 떨어져 빈 handlerId를 역호출하고
    // 아무 일도 일어나지 않는다(등록·스냅샷·렌더까지 다 됐는데 마지막 한 줄이 없어 죽는 그 형태).
    if (typeof p.menuItemId === "string" && p.menuItemId !== "") {
      invokeMenuItem(p.pluginId, p.menuItemId, token, p.selectedText);
      return;
    }
    // 선택 액션 실행도 같은 채널의 또 다른 페이로드다(메뉴 항목과 같은 이유로 별도 분기가
    // 필요하다 — 없으면 아래 buttonId 폴백이 빈 handlerId를 역호출하고 조용히 끝난다).
    if (typeof p.selectionActionId === "string" && p.selectionActionId !== "") {
      invokeSelectionAction(
        p.pluginId,
        p.selectionActionId,
        token,
        p.selectedText,
      );
      return;
    }
    sandboxes.get(p.pluginId)?.invoke(String(p.buttonId ?? ""), token);
  });

  // 네이티브 트레이 클릭 → 그 플러그인의 트레이 항목 `run`을 창 컨텍스트 없이 역호출한다.
  // 방송 주체는 Rust 트레이 핸들러뿐이라(샌드박스는 Tauri IPC에 닿지 못한다) 채널을 위조할 수
  // 없지만, id는 여전히 살아있는 등록(trayItemsOf)과 대조한다 — 죽은/모르는 id는 조용히 무시된다.
  deps.bus.listen(EV_TRAY_INVOKE, (payload) => {
    const p = payload as TrayInvokePayload | null;
    if (
      !p ||
      typeof p.pluginId !== "string" ||
      typeof p.trayItemId !== "string" ||
      p.pluginId === "" ||
      p.trayItemId === ""
    ) {
      return;
    }
    invokeTrayItem(p.pluginId, p.trayItemId);
  });

  // 노트 창에서 난 생명주기 이벤트 → 그 이름을 구독한 플러그인에게만 역호출.
  // 페이로드는 **메타데이터만**이다: 본문은 절대 싣지 않고, 필요하면 핸들러가 받은 바인딩된
  // memo로 `notes.current()`를 불러 `notes:read` 경계를 그대로 통과하게 한다.
  deps.bus.listen(EV_PLUGIN_EVENT, (payload) => {
    const p = payload as NoteEventPayload | null;
    // 이 채널은 1st-party 웹뷰만 방송할 수 있지만(샌드박스는 Tauri IPC에 닿지 못한다) 이름은
    // 여전히 닫힌 어휘로 좁힌다 — 모르는 이름이 구독 맵을 헛돌지 않게.
    if (!p || !isMemoEventName(p.name)) return;
    const windowLabel = String(p.windowLabel ?? "");
    dispatchEvent(p.name, (pluginId) => eventToken(pluginId, windowLabel), {
      name: p.name,
      windowId: windowLabel,
      noteId: String(p.noteId ?? ""),
      path: typeof p.path === "string" ? p.path : null,
      at: typeof p.at === "number" ? p.at : Date.now(),
    });
  });

  // 설정 창의 폼 변경 → 아직 살아 있는 그 플러그인 샌드박스에 통지.
  // 재빌드(EV_NOTES_RELOAD)는 400ms 디바운스되므로, 이 통지는 샌드박스가 죽기 **전에** 닿는다.
  deps.bus.listen(EV_PLUGIN_SETTING_CHANGED, (payload) => {
    const p = payload as PluginSettingChangedPayload | null;
    if (!p || typeof p.pluginId !== "string" || typeof p.key !== "string") {
      return;
    }
    const bound = settingsOf.get(p.pluginId);
    if (!bound) return;
    const field = bound.schema.find((f) => f.key === p.key);
    // 호스트의 인메모리 값은 **일부러 갱신하지 않는다** — 이번 범위는 통지만이고((a)안),
    // 값의 정본은 곧 뒤따르는 재빌드다. 그래서 `settings.get`은 재빌드 전까지 옛 값을 줄 수
    // 있고, 핸들러는 페이로드의 newValue를 써야 한다(`.d.ts`가 그렇게 못박는다).
    notifySettingsChanged(
      p.pluginId,
      p.key,
      toPluginSettingValue(field, bound.get(p.key) ?? null),
      toPluginSettingValue(field, p.value ?? null),
      "form",
    );
  });

  // 진단 조회(설정 창의 「최근 오류」) — 스냅샷과 달리 빌드와 무관하게 항상 즉시 응답한다.
  deps.bus.listen(EV_DIAGNOSTICS_GET, (payload) => {
    const p = payload as DiagnosticsGetPayload | null;
    if (!p || typeof p.requestId !== "string") return;
    deps.bus.emit(EV_DIAGNOSTICS, {
      requestId: p.requestId,
      diagnostics: diagnostics.list(),
    });
  });

  deps.bus.listen(EV_WINDOW_RESULT, (payload) => {
    const p = payload as WindowResultPayload | null;
    if (!p || typeof p.requestId !== "string") return;
    const waiter = windowCalls.get(p.requestId);
    if (!waiter) return;
    windowCalls.delete(p.requestId);
    if (p.ok) waiter.resolve(p.result ?? null);
    // 창 쪽에서 난 거부에 코드가 실려 있으면 그대로 이어 싣는다 — 게이트키퍼가
    // `Error.code`를 응답의 `code`로 옮기므로, 창에서 난 실패도 샌드박스에 같은 어휘로
    // 도달한다. 코드가 없으면 예전처럼 문구만 나른다("UNKNOWN"은 부트스트랩이 채운다).
    else if (typeof p.code === "string" && p.code !== "")
      waiter.reject(bridgeError(p.code, p.error ?? "창-스코프 호출 실패"));
    else waiter.reject(new Error(p.error ?? "창-스코프 호출 실패"));
  });

  // 설정 창의 변경 방송 → 재빌드 후 열린 창들에 갱신 신호(직렬화: 겹치면 순서대로).
  // 실패해도 체인을 죽이지 않는다(다음 notes-reload가 다시 재빌드를 시도할 수 있게).
  let rebuildChain = Promise.resolve();

  /**
   * 재빌드가 **지금 돌고 있는지** / 도는 동안 **또 요청이 왔는지**.
   *
   * 왜 접어야 하는가(이슈 #22 — "설정에서 무언가를 바꾸면 응답 없음"): `notes-reload` 한 번의
   * 실제 비용은 이 호스트의 `build()`로 끝나지 않는다. 그 끝에서 [`EV_HOST_UPDATED`]가 나가면
   * **열려 있는 모든 노트 창이 설정·스냅샷·vault 경로를 재조회해** 판정하고
   * (`bootstrap/host-update-plan.ts`), 리로드로 떨어지는 사유면 창 N개가 웹뷰 N개를 동시에
   * 다시 띄우며 각자 자기 몫의 백엔드 커맨드를 다시 부른다. 신호가 M번 오면 그 폭풍이 M번
   * 분다 — 제자리 조정으로 끝나는 경우에도 재조회 IPC는 창마다 그대로 돈다.
   *
   * 예전에는 `rebuildChain`에 그냥 이어 붙였다 — **직렬화는 되지만 합쳐지지는 않는다**. 재빌드
   * 하나는 샌드박스 부팅을 포함해 수백 ms가 걸리고, 그 사이에 도착한 신호(설정 저장·플러그인
   * 토글·설치 확정은 서로 다른 경로라 설정 창의 400ms 디바운스를 각각 따로 지난다)는 전부
   * 별도의 재빌드로 줄을 섰다. 도는 동안 온 요청을 **하나로 접으면** 어떤 조합으로 들어와도
   * 재빌드는 「지금 것 + 뒤이어 한 번」으로 수렴한다.
   *
   * 신호를 **버리지는 않는다**: 접힌 요청이 있으면 현재 재빌드가 끝난 뒤 반드시 한 번 더
   * 돌린다. 재빌드는 매번 현재 상태 전체를 다시 읽으므로, 그 한 번이 접힌 모든 변경을 담는다.
   *
   * 지연(타이머)을 두지 않는 이유: 변경 하나만 온 정상 경로가 느려지면 안 된다 — 반영은 여전히
   * 즉시 시작되고, 겹칠 때만 합쳐진다.
   */
  let rebuilding = false;
  let rebuildQueued = false;
  /**
   * 아직 방송되지 않은 재빌드 사유의 합집합 — 다음에 시작하는 재빌드가 통째로 가져간다.
   *
   * 왜 모으나: 요청은 접히지만(`rebuildQueued`) 사유는 버려지면 안 된다 — 노트 창은 이 값
   * 하나로 "리로드 vs 제자리 조정"을 가르므로, 합쳐진 요청 중 하나라도 리로드가 필요한
   * 사유(`locale` 등)였다면 그 사실이 방송에 남아 있어야 한다.
   *
   * 드레인 시점은 **재빌드 시작**이다: 그 뒤에 도착한 사유는 다음 라운드가 실어 나른다
   * (요청이 접히면 `rebuildQueued`가 그 라운드를 보장하므로 유실되지 않는다). 반대로 방송
   * 직전에 드레인하면, 접혀서 이어 도는 라운드가 사유 없이(=`unknown`) 방송돼 애먼 리로드를
   * 부른다.
   */
  let pendingReasons = new Set<RebuildReason>();

  const scheduleRebuild = (payload?: unknown): void => {
    // 재귀 호출(접힌 요청 소화)은 payload가 없다 — 그때는 이미 쌓인 사유만 쓴다.
    if (payload !== undefined) {
      for (const reason of parseRebuildReasons(payload)) {
        pendingReasons.add(reason);
      }
    }
    if (rebuilding) {
      rebuildQueued = true; // 도는 중 — 끝나고 딱 한 번만 더 돈다.
      return;
    }
    rebuilding = true;
    // 이 라운드가 실어 나를 사유를 확정하고 통을 비운다(위 주석 — 드레인은 시작 시점).
    const reasons = [...pendingReasons];
    pendingReasons = new Set();
    rebuildChain = rebuildChain
      .then(() => build())
      .then(() => deps.bus.emit(EV_HOST_UPDATED, { revision, reasons }))
      .catch((e: unknown) =>
        console.error("[memo] 플러그인 호스트 재빌드 실패:", e),
      )
      .then(() => {
        rebuilding = false;
        if (rebuildQueued) {
          rebuildQueued = false;
          scheduleRebuild();
        }
      });
  };

  deps.bus.listen(EV_NOTES_RELOAD, scheduleRebuild);

  // 개발 소스 감시 → 그 플러그인 하나만 다시 실행(단일 핫리로드). **같은 체인**에
  // 얹는다: 전체 재빌드(notes-reload)와 단일 리로드가 겹치면 도착 순서대로 직렬 처리해야
  // 스냅샷이 중간 상태로 새지 않는다. rebuildPlugin이 자기 안에서 부분·전체 신호를 방송하므로
  // 여기서는 추가 방송을 하지 않는다. `EV_PLUGIN_DEV_RELOAD`는 세션 한정 개발 감시자만
  // 방송하므로 프로덕션 경로에서는 이 리스너가 절대 발화하지 않는다.
  deps.bus.listen(EV_PLUGIN_DEV_RELOAD, (payload) => {
    const p = payload as PluginDevReloadPayload | null;
    if (!p || typeof p.pluginId !== "string" || p.pluginId === "") return;
    const pluginId = p.pluginId;
    rebuildChain = rebuildChain
      .then(() => rebuildPlugin(pluginId))
      .catch((e: unknown) =>
        console.error("[memo] 개발 모드 단일 핫리로드 실패:", e),
      );
  });

  await build();
}
