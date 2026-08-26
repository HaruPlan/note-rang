/**
 * 헤드리스 플러그인 테스트 하니스 — 앱을 띄우지 않고 플러그인의 **진짜 main.js**를
 * 실행해 등록·호출·거부를 단언한다.
 *
 * 역할: 저작자·AI가 `import`해서 "이 플러그인을 로드하면 툴바 버튼 2개가 등록되고, 버튼을
 * 누르면 `notes.current`가 불리고 그 결과로 `editor.insertText`가 이 텍스트로 호출된다"를
 * 코드로 검증하게 한다. 그동안 이 폐루프는 `examples.test.ts`의 테스트 파일 안에 갇혀
 * 1st-party만 쓸 수 있었다 — 이 모듈은 그 배선을 공개 API로 승격한 것이다.
 *
 * 왜 프로덕션 순수 함수만 쓰나(신규 가짜 구현 금지): 하니스가 실제 호스트와 벌어지면
 * "하니스는 통과했는데 앱에서는 실패"가 생긴다. 그래서 이 모듈은 **재구현을 하지 않는다** —
 * 게이트는 [`handleBridgeRequest`](host.ts), 등록 수집은 [`makeRegistrar`](loader.ts),
 * 매니페스트·부여 준비는 [`prepareInstalledPlugin`](loader.ts), 설정 경계 변환은
 * `shared/plugin-settings.ts`, settings·events·commands의 인자·권한 판정은 중앙 호스트와
 * **같은** 순수 함수([`host-executor-validators.ts`] — `resolveSettingsGetArg`·
 * `buildSettingsSnapshot`·`checkEventName`·`checkEventExtraPermission`·`checkCommandTitle`)를
 * **그대로** 호출한다(그래서 두 실행기가 갈라질 수 없다). `memo` 프록시 의미론(인자 1개
 * 규칙·거부의 code/call 복원·역호출 첫 인자 바인딩 memo)만 부트스트랩과 같은 규칙으로 재현한다.
 *
 * **무엇을 실제로 돌리고 무엇을 대역하나(정직한 경계):**
 * - **실제로 돈다**: 저작자의 `main.js`(격리 없이 같은 프로세스에서 `new Function`으로),
 *   권한 게이트키퍼, 등록 수집기, 설정 값 구조화·기본값 병합, 이벤트 이름·명령 when 검증.
 * - **대역한다**: 창-스코프 호출(`ui.toast`·`ui.prompt`·`ui.pickList`·`editor.insertText`·
 *   `notes.current` 등)의 **수행부**는 스텁으로 응답을 주입한다(실제 노트 창이 없으므로).
 * - **재현하지 않는다(범위 밖)**: iframe·postMessage·CSP 격리 자체와 **다중 창 토큰 라우팅**.
 *   하니스는 **단일 창 컨텍스트**를 모델링한다 — "A에서 눌렀는데 B에 삽입" 같은 다중 창
 *   오배달은 `central-host.test.ts`와 e2e가 검증한다. 이 하니스로는 잡지 못한다.
 */
import {
  handleBridgeRequest,
  bridgeError,
  type PluginRuntimeEnv,
} from "./host";
import {
  makeRegistrar,
  prepareInstalledPlugin,
  normalizeToolbarPosition,
  parseWhenClause,
  autoRegistrationId,
  type ToolbarPosition,
  type WhenTerm,
} from "./loader";
import {
  buildSettingsSnapshot,
  checkCommandTitle,
  checkEventExtraPermission,
  checkEventName,
  resolveSettingsGetArg,
} from "./host-executor-validators";
import { checkPermission } from "./permissions";
import {
  parseSelectionMatch,
  selectionMatches,
  type SelectionMatch,
} from "./selection-action";
import {
  isMemoEventName,
  MEMO_EVENT_NAMES,
  type MemoEventName,
} from "./host-protocol";
import {
  mergeSettingDefaults,
  toPluginSettingValue,
  fromPluginSettingValue,
} from "../shared/plugin-settings";
import type { PluginSettingField } from "../shared/tauri";
import type {
  InlinePatternDescriptor,
  CompletionDescriptor,
} from "./editor-api";
import type { BlockEmbedDescriptor } from "./embed";
import type { ThemeDescriptor } from "../theme/theme";
import type { BackgroundDescriptor } from "../theme/background";
import type { FontDescriptor } from "../theme/font";
import type { WindowControlId } from "./window-control";

/** 스텁 값 — 고정값 또는 인자를 받아 응답을 만드는 함수(비동기 허용). */
export type StubValue =
  unknown | ((args: Record<string, unknown>) => unknown | Promise<unknown>);

/** 플러그인 하나를 하니스로 로드할 때의 입력. */
export interface LoadPluginOptions {
  /** 매니페스트 원문(객체) — 실제 검증기([`prepareInstalledPlugin`])로 다시 검증된다. */
  manifest: unknown;
  /** entry 코드(main.js 원문 문자열) — 저작자의 **진짜** 코드가 실행된다. */
  code: string;
  /**
   * 저장된(디스크) 설정 값 — 중앙 호스트가 백엔드에서 받는 것과 같은 형태다. 선언 기본값은
   * 하니스가 [`mergeSettingDefaults`]로 병합하므로 여기엔 덮어쓸 값만 넣으면 된다.
   */
  settings?: Record<string, unknown>;
  /**
   * 사용자가 승인한 권한(민감 게이트). 생략하면 **선언한 권한 전부 승인**으로 본다(예제가
   * "권한이 다 부여된 조건"을 가정하듯). 부여를 좁혀 권한 거부 경로를 테스트할 수 있다.
   */
  granted?: string[];
  /** 창-스코프·호스트 데이터 호출의 응답 주입(호출명 → 값 또는 함수). */
  stubs?: Record<string, StubValue>;
  /** 실행 환경 재정의(진단·게이트 판정용) — os·hostVersion·reason. kind는 매니페스트에서 온다. */
  env?: Partial<Pick<PluginRuntimeEnv, "os" | "hostVersion" | "reason">>;
}

/** 하니스가 노출하는 툴바 버튼 디스크립터(함수는 싣지 않는다 — 실행은 clickButton으로). */
interface HarnessButton {
  id: string;
  label: string;
  title?: string;
  position: ToolbarPosition;
}

/** 하니스가 노출하는 명령 디스크립터. */
interface HarnessCommand {
  id: string;
  title: string;
  when: WhenTerm[];
  destructive: boolean;
}

/** 하니스가 노출하는 이벤트 구독. */
interface HarnessSubscription {
  id: string;
  name: MemoEventName;
}

/** 하니스가 노출하는 컨텍스트 메뉴 항목(`ui.addMenuItem`). run 함수는 싣지 않는다 —
 * 실행은 invokeMenuItem으로. `needsSelectedText`는 등록 시점 `notes:read` 부여로 굳힌
 * payload 게이트(중앙 호스트와 같은 판정). */
interface HarnessMenuItem {
  id: string;
  label: string;
  when: WhenTerm[];
  needsSelectedText: boolean;
}

/** 하니스가 노출하는 선택 액션(`ui.addSelectionAction`). run 함수는 싣지 않는다 —
 * 실행은 invokeSelectionAction으로. `match`는 검증·정규화를 마친 값이고(닫힌 어휘),
 * `needsSelectedText`는 등록 시점 `notes:read` 부여로 굳힌 payload 게이트(중앙 호스트와 동일). */
interface HarnessSelectionAction {
  id: string;
  label: string;
  title?: string;
  match?: SelectionMatch;
  needsSelectedText: boolean;
}

/** 하니스가 노출하는 상태 아이템(`ui.addStatusItem`). onClick 함수 자체는 싣지 않는다
 * (다른 디스크립터와 같은 규칙 — 실행은 clickStatusItem으로). */
interface HarnessStatusItem {
  id: string;
  text: string;
  title?: string;
  position: ToolbarPosition;
  /** onClick을 줬는지(클릭 가능 확장) — 값 자체는 싣지 않고 존재 여부만. */
  clickable: boolean;
}

/** 하니스가 노출하는 메뉴바 트레이 항목(`ui.addTrayItem`). run 함수는 싣지 않는다 —
 * 실행은 invokeTrayItem으로. 트레이는 앱 전역 자원이라 창 컨텍스트도 when도 payload도 없다
 * (중앙 호스트가 빈 토큰·빈 payload로 역호출하는 것과 같은 계약, central-host.ts invokeTrayItem). */
interface HarnessTrayItem {
  id: string;
  label: string;
}

/** 플러그인이 브리지로 낸 호출 한 건의 기록(단언 대상). */
interface RecordedCall {
  /** 호출명(`ui.toast` 등). */
  call: string;
  /** 인자(함수 값은 `"[Function]"`로 치환 — 직렬화·비교를 깨지 않게). */
  args: Record<string, unknown>;
  /** 게이트·수행부가 성공을 돌려줬는지. */
  ok: boolean;
  /** 성공 시 반환값. */
  result?: unknown;
  /** 실패 시 기계용 안정 코드. */
  code?: string;
}

/** 게이트·수행부가 거부한 호출(건강한 플러그인은 `[]`여야 한다). */
interface RecordedRejection {
  call: string;
  code?: string;
}

/** 하니스가 관측·기록한 진단(중복 등록 등) 한 건. */
interface HarnessDiagnostic {
  kind: string;
  call: string;
  message: string;
}

/**
 * 로드된 플러그인 하니스 — 등록 조회 + 실행(클릭·명령·이벤트) + 관측(호출·거부).
 *
 * 조회 프로퍼티는 **호출 시점의 스냅샷**을 돌려준다(등록은 로드가 끝나면 확정되지만,
 * `calls`·`rejections`는 clickButton 등으로 계속 늘어난다).
 */
export interface HeadlessPlugin {
  /** 매니페스트 id. */
  readonly id: string;
  /** 등록된 툴바 버튼(등록 순서). */
  readonly buttons: HarnessButton[];
  /** 등록된 인라인 패턴. */
  readonly patterns: InlinePatternDescriptor[];
  /** 등록된 자동완성. */
  readonly completions: CompletionDescriptor[];
  /** 등록된 블록 임베드. */
  readonly embeds: BlockEmbedDescriptor[];
  /** 등록된 명령. */
  readonly commands: HarnessCommand[];
  /** 등록된 이벤트 구독. */
  readonly subscriptions: HarnessSubscription[];
  /** 등록된 컨텍스트 메뉴 항목. */
  readonly menuItems: HarnessMenuItem[];
  /** 등록된 선택 액션. */
  readonly selectionActions: HarnessSelectionAction[];
  /** 등록된 상태 아이템. */
  readonly statusItems: HarnessStatusItem[];
  /** 등록된 메뉴바 트레이 항목. */
  readonly trayItems: HarnessTrayItem[];
  /** 등록된 테마 능력(미등록이면 null). */
  readonly theme: ThemeDescriptor | null;
  /** 등록된 배경 능력(미등록이면 null). */
  readonly background: BackgroundDescriptor | null;
  /** 등록된 폰트 능력(미등록이면 null). */
  readonly font: FontDescriptor | null;
  /** 등록된 창 컨트롤 능력 id 목록. */
  readonly windowControls: WindowControlId[];
  /** 플러그인이 낸 모든 브리지 호출(순서 그대로 — runtime.* 포함). */
  readonly calls: RecordedCall[];
  /** 거부된 호출(권한 미선언·미부여·예약·잘못된 인자 등). */
  readonly rejections: RecordedRejection[];
  /** 하니스가 기록한 진단(중복 등록 등). */
  readonly diagnostics: HarnessDiagnostic[];
  /** 역호출 핸들러(onClick·run·이벤트)가 **동기적으로 던진** 예외. */
  readonly errors: Error[];
  /** 플러그인이 `runtime.ready()`로 등록 마감을 선언했는지. */
  readonly ready: boolean;

  /** 이름으로 호출 기록을 거른다(단언 편의). */
  callsTo(call: string): RecordedCall[];

  /** 툴바 버튼 클릭을 시뮬레이션한다(onClick을 바인딩된 memo로 역호출). */
  clickButton(id: string, payload?: unknown): Promise<void>;
  /** 명령 실행을 시뮬레이션한다(단축키·설정 버튼과 같은 경로 — run 역호출). */
  runCommand(id: string, payload?: unknown): Promise<void>;
  /** 이벤트 발화를 시뮬레이션한다(그 이름의 모든 구독 handler 역호출). */
  emitEvent(name: MemoEventName, payload?: unknown): Promise<void>;
  /** 컨텍스트 메뉴 항목 선택을 시뮬레이션한다 — 중앙 호스트와 같은 payload.selectedText
   * 게이트를 재현한다: `needsSelectedText`(등록 시 notes:read 부여로 굳힘)일 때만 selectedText를
   * 싣는다. 그 외 payload 필드는 전달하지 않는다(중앙 호스트 invokeMenuItem과 동일). */
  invokeMenuItem(
    id: string,
    payload?: { selectedText?: string },
  ): Promise<void>;
  /**
   * 선택 액션 실행을 시뮬레이션한다(선택 툴바 버튼 클릭·단축키와 같은 경로 — run 역호출).
   *
   * `selectedText`를 주면 **그 액션의 `match`를 앱과 같은 순수 함수로 먼저 판정한다** —
   * 앱에서는 조건이 거짓이면 버튼이 뜨지도 않고 단축키도 아무 일을 하지 않으므로, 하니스가
   * 그것을 건너뛰면 "테스트는 통과하는데 앱에서는 눌러지지 않는" 거짓 그린이 된다. 조건이
   * 거짓이면 던진다(무음 통과가 아니라 그 자리에서 이유를 말한다).
   *
   * payload는 중앙 호스트 `invokeSelectionAction`과 동일하다: `needsSelectedText`(등록 시
   * notes:read 부여로 굳힘)일 때만 `selectedText`를 싣는다.
   */
  invokeSelectionAction(
    id: string,
    payload?: { selectedText?: string },
  ): Promise<void>;
  /** 상태 아이템 클릭을 시뮬레이션한다(onClick을 바인딩된 memo로 역호출) — 버튼의
   * clickButton과 같은 규칙. `onClick`을 안 준 상태 아이템(대부분)을 클릭하면 no-op이다. */
  clickStatusItem(id: string, payload?: unknown): Promise<void>;
  /** 메뉴바 트레이 항목 클릭을 시뮬레이션한다 — 중앙 호스트 invokeTrayItem과 동일하게
   * 창 컨텍스트도 payload도 없이(빈 토큰·빈 객체) run을 역호출한다. run의 창-스코프 호출은
   * 기본/주입 스텁으로 응답한다(단일 창 하니스는 토큰 라우팅을 재현하지 않는다). */
  invokeTrayItem(id: string): Promise<void>;

  /** 설정 값을 런타임에 주입·변경한다(디스크 형태로 저장 — 읽을 땐 구조화되어 온다). */
  setSetting(key: string, value: unknown): void;
  /** 플러그인이 보는 형태(구조화)로 설정 값을 읽는다. */
  getSetting(key: string): unknown;
  /** 창-스코프·호스트 호출의 스텁을 얹거나 바꾼다. */
  stub(call: string, value: StubValue): void;
}

/**
 * 창-스코프·호스트 데이터 호출의 기본 스텁 — 저작자가 `stubs`로 덮기 전의 안전한 기본값.
 *
 * `notes.current`·`ui.prompt`·`ui.pickList`가 **null**인 것은 "대상 창/선택 없음"의 정직한
 * 기본이다(창-스코프 호출은 컨텍스트가 없으면 오류가 아니라 null이라는 계약을 그대로 반영).
 * 의미 있는 값이 필요하면 `stubs`로 주입한다. `editor.setFontDelta`는 스텁이 없으면 실제
 * 수행부처럼 [-50, 50]으로 클램프한 값을 돌려준다.
 */
const DEFAULT_STUBS: Readonly<Record<string, StubValue>> = {
  "ui.toast": null,
  "ui.prompt": null,
  "ui.pickList": null,
  "editor.getFontDelta": 0,
  "editor.insertText": null,
  "clipboard.write": null,
  "notes.current": null,
  "notes.list": [],
  "notes.read": null,
  "notes.duplicate": null,
  "notes.resetOptions": null,
  "storage.get": null,
  "storage.getAll": {},
  "storage.set": null,
  "storage.remove": null,
};

/** 마이크로·매크로태스크 큐를 한 번 비운다(플러그인의 프라미스 체인이 정착하도록). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 경로 조립에 안전한 노트 id인지(구분자·`..`·`:` 없음) — 중앙 호스트(central-host.ts)의
 * `isSafeNoteId`와 같은 규칙. 빈 문자열은 여기서 보지 않는다(호출부가 따로 거부). */
function isSafeNoteIdArg(id: string): boolean {
  return (
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("..") &&
    !id.includes(":")
  );
}

/** 인자에서 함수 값을 `"[Function]"`으로 치환한 얕은 복사본(기록·비교용). */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "function" ? "[Function]" : v;
  }
  return out;
}

/**
 * 플러그인 하나를 헤드리스로 로드해 하니스를 돌려준다.
 *
 * 매니페스트를 실제 검증기로 통과시키고(실패는 throw), 게이트키퍼·등록 수집기·설정 서비스를
 * 프로덕션과 같은 순수 함수로 배선한 뒤, 저작자의 `main.js`를 같은 프로세스에서 실행한다.
 * 반환 시점에는 동기 등록 + 늦은(.then) 등록까지 정착해 있다(내부에서 큐를 비운다).
 */
export async function loadPluginForTest(
  options: LoadPluginOptions,
): Promise<HeadlessPlugin> {
  const rawPerms = Array.isArray(
    (options.manifest as { permissions?: unknown })?.permissions,
  )
    ? ((options.manifest as { permissions: string[] }).permissions ?? [])
    : [];
  const prep = prepareInstalledPlugin({
    manifest: options.manifest,
    code: options.code,
    granted: options.granted ?? rawPerms,
    settings: options.settings,
  });
  if (!prep.ok) {
    throw new Error(`플러그인 로드 실패(매니페스트): ${prep.error}`);
  }
  const plugin = prep.plugin;
  const schema: PluginSettingField[] = plugin.settings;
  const env: PluginRuntimeEnv = {
    pluginId: plugin.id,
    hostVersion: options.env?.hostVersion ?? "0.0.0",
    os: options.env?.os ?? "macos",
    reason: options.env?.reason ?? "reload",
    kind: plugin.kind,
  };

  // ── 관측 상태 ────────────────────────────────────────────────────────────
  const calls: RecordedCall[] = [];
  const rejections: RecordedRejection[] = [];
  const diagnostics: HarnessDiagnostic[] = [];
  const errors: Error[] = [];
  const stubs: Record<string, StubValue> = { ...options.stubs };

  // ── 등록 수집 ────────────────────────────────────────────────────────────
  const registrar = makeRegistrar(plugin.id, (call, id) => {
    diagnostics.push({
      kind: "duplicate-registration",
      call,
      message: `같은 id로 다시 등록해 앞의 것을 대체했습니다: ${id}`,
    });
  });
  const buttons = new Map<
    string,
    { desc: HarnessButton; onClick: HandlerFn }
  >();
  const commands = new Map<string, { desc: HarnessCommand; run: HandlerFn }>();
  const subscriptions = new Map<
    string,
    { name: MemoEventName; handler: HandlerFn }
  >();
  const menuItems = new Map<
    string,
    { desc: HarnessMenuItem; run: HandlerFn }
  >();
  const selectionActions = new Map<
    string,
    { desc: HarnessSelectionAction; run: HandlerFn }
  >();
  const statusItems = new Map<
    string,
    { desc: HarnessStatusItem; onClick: HandlerFn }
  >();
  const trayItems = new Map<
    string,
    { desc: HarnessTrayItem; run: HandlerFn }
  >();
  let autoButtonSeq = 0;
  let autoCommandSeq = 0;
  let autoEventSeq = 0;
  let autoMenuSeq = 0;
  let autoSelectionSeq = 0;
  let autoStatusSeq = 0;
  let autoTraySeq = 0;

  // ── 설정 서비스(중앙 호스트와 같은 경계 규칙) ────────────────────────────
  const store = mergeSettingDefaults(schema, options.settings ?? {});
  const fieldOf = (key: string): PluginSettingField | undefined =>
    schema.find((f) => f.key === key);

  /** 스텁을 해석해 응답을 만든다(함수면 인자와 함께 호출, 없으면 기본값). */
  async function resolveStub(
    call: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const stub = call in stubs ? stubs[call] : undefined;
    if (stub !== undefined) {
      return typeof stub === "function"
        ? await (stub as (a: Record<string, unknown>) => unknown)(args)
        : stub;
    }
    if (call === "editor.setFontDelta") {
      return Math.min(50, Math.max(-50, Number(args.value) || 0));
    }
    if (call in DEFAULT_STUBS) {
      const d = DEFAULT_STUBS[call];
      return typeof d === "function"
        ? await (d as (a: Record<string, unknown>) => unknown)(args)
        : d;
    }
    // 아는 호출이지만 스텁이 없는 경우(예: windows.open 계열이 예약을 벗어난 뒤) — null.
    return null;
  }

  /**
   * 게이트를 통과한 호출의 **수행부**(examples/central-host의 실행기 자리).
   *
   * 등록 호출은 [`makeRegistrar`]로, 콜백 등록(버튼·명령·이벤트)은 여기서 함수를 붙잡아
   * 디스크립터로 모으고, 나머지 창-스코프·호스트 호출은 스텁으로 응답한다.
   */
  async function execute(
    call: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // ── 설정 ──
    // settings.get 객체-인자 강제·키 판정·스냅샷 구성은 중앙 호스트와 **공유하는 순수 함수**를
    // 그대로 태운다(host-executor-validators) — 여기서 다르게 적으면 "하니스는 통과했는데
    // 앱은 거부한다"가 조용히 생긴다. 값을 읽는 백엔드(인메모리 store)만 여기서 준다.
    if (call === "settings.get") {
      const arg = resolveSettingsGetArg(args as unknown);
      if (!arg.ok) throw arg.error;
      return toPluginSettingValue(fieldOf(arg.key), store[arg.key] ?? null);
    }
    if (call === "settings.getAll") {
      return buildSettingsSnapshot(schema, (key) => store[key]);
    }
    if (call === "settings.set") {
      const key = String(args.key);
      const field = fieldOf(key);
      if (!field) {
        diagnostics.push({
          kind: "setting-key-undeclared",
          call,
          message: `매니페스트 settings에 선언되지 않은 키: ${key}`,
        });
      }
      store[key] = fromPluginSettingValue(field, args.value);
      return null;
    }

    // ── 콜백 등록(함수 인자를 붙잡는다) ──
    if (call === "ui.addToolbarButton") {
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoButtonSeq);
      if (buttons.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 버튼을 대체했습니다: ${id}`,
        });
      }
      buttons.set(id, {
        desc: {
          id,
          label: String(args.label ?? ""),
          title: args.title === undefined ? undefined : String(args.title),
          position: normalizeToolbarPosition(args.position),
        },
        onClick:
          typeof args.onClick === "function"
            ? (args.onClick as HandlerFn)
            : noopHandler,
      });
      return { id };
    }
    if (call === "commands.register") {
      if (typeof args.run !== "function") {
        throw bridgeError(
          "INVALID_ARGS",
          "commands.register에는 run 함수가 필요합니다(없으면 단축키를 걸어도 아무 일도 일어나지 않는다)",
        );
      }
      const titleCheck = checkCommandTitle(args.title);
      if (!titleCheck.ok) throw titleCheck.error;
      const title = titleCheck.title;
      const when = parseWhenClause(
        args.when,
        schema.map((f) => f.key),
      );
      if (!when.ok) throw bridgeError("INVALID_ARGS", when.error);
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoCommandSeq);
      if (commands.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 명령을 대체했습니다: ${id}`,
        });
      }
      commands.set(id, {
        desc: {
          id,
          title,
          when: when.terms,
          destructive: args.destructive === true,
        },
        run: args.run as HandlerFn,
      });
      return { id };
    }
    if (call === "events.on") {
      // 이름 열거·이름별 추가 권한은 중앙 호스트와 **공유하는 순수 함수**로 판정한다
      // (host-executor-validators). handler는 하니스에선 함수 그대로 붙잡으므로(중앙은
      // handlerId 문자열) 그 존재 검사만 여기 남는다.
      const nameCheck = checkEventName(args.name);
      if (!nameCheck.ok) throw nameCheck.error;
      const name = nameCheck.name;
      if (typeof args.handler !== "function") {
        throw bridgeError(
          "INVALID_ARGS",
          "events.on에는 handler 함수가 필요합니다(없으면 이벤트가 나도 아무 일도 일어나지 않는다)",
        );
      }
      const permError = checkEventExtraPermission(plugin.grant, name);
      if (permError !== null) throw permError;
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoEventSeq);
      if (subscriptions.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 구독해 앞의 구독을 대체했습니다: ${id}`,
        });
      }
      subscriptions.set(id, { name, handler: args.handler as HandlerFn });
      return { id };
    }

    // ── 컨텍스트 메뉴 항목 등록(ui.addMenuItem) — 중앙 호스트와 같은 검증을 태운다.
    // 예약 해제(웨이브 E) 전에는 게이트키퍼가 RESERVED_CALL로 시끄럽게 거부했으나, 예약이
    // 풀린 지금은 여기 분기가 없으면 resolveStub로 떨어져 '조용한 성공(무등록)'이 된다 —
    // 저작자가 거짓 그린을 받는다. 중앙 호스트(central-host.ts)와 같은 순수 판정을 쓴다. ──
    if (call === "ui.addMenuItem") {
      // 하니스는 함수를 직렬화 없이 그대로 받는다(commands.register와 같은 규칙) — 중앙
      // 호스트의 run$id(핸들러 id) 빈 검사에 대응하는 것이 run 함수 부재 검사다.
      if (typeof args.run !== "function") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addMenuItem에는 run 함수가 필요합니다(없으면 메뉴에서 눌러도 아무 일도 일어나지 않는다)",
        );
      }
      const label = String(args.label ?? "").trim();
      if (label === "") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addMenuItem에는 비어 있지 않은 label이 필요합니다(메뉴에 보일 이름)",
        );
      }
      // when은 메뉴 항목 전용 어휘(창 상태 두 키)로 판정한다(MENU_WHEN_KEYS).
      const when = parseWhenClause(
        args.when,
        schema.map((f) => f.key),
        { menu: true },
      );
      if (!when.ok) throw bridgeError("INVALID_ARGS", when.error);
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoMenuSeq);
      if (menuItems.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 메뉴 항목을 대체했습니다: ${id}`,
        });
      }
      // payload.selectedText 게이트: 선택 텍스트는 본문 일부라 notes:read가 있어야 준다.
      // 등록 시점에 굳혀 역호출(invokeMenuItem)이 같은 판정을 쓰게 한다(중앙 호스트와 동일).
      const needsSelectedText = checkPermission(
        plugin.grant,
        "notes:read",
      ).allowed;
      menuItems.set(id, {
        desc: { id, label, when: when.terms, needsSelectedText },
        run: args.run as HandlerFn,
      });
      return { id };
    }

    // ── 선택 액션 등록(ui.addSelectionAction) — 중앙 호스트와 같은 검증을 태운다.
    // 이 분기가 없으면 resolveStub로 떨어져 '조용한 성공(무등록)'이 된다 — 저작자가
    // 하니스에서 거짓 그린을 받고 앱에서야 버튼이 없다는 것을 안다(addMenuItem과 같은 이유). ──
    if (call === "ui.addSelectionAction") {
      // 하니스는 함수를 직렬화 없이 그대로 받는다(addMenuItem과 같은 규칙) — 중앙 호스트의
      // run$id(핸들러 id) 빈 검사에 대응하는 것이 run 함수 부재 검사다.
      if (typeof args.run !== "function") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addSelectionAction에는 run 함수가 필요합니다(없으면 눌러도 아무 일도 일어나지 않는다)",
        );
      }
      const label = String(args.label ?? "").trim();
      if (label === "") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addSelectionAction에는 비어 있지 않은 label이 필요합니다(선택 툴바 버튼에 보일 글자)",
        );
      }
      // match는 닫힌 어휘로 판정한다 — 중앙 호스트와 **같은 순수 함수**를 쓴다(두 판정이
      // 갈리면 하니스 통과가 앱 동작을 보장하지 못한다).
      const match = parseSelectionMatch(args.match);
      if (!match.ok) throw bridgeError("INVALID_ARGS", match.reason);
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoSelectionSeq);
      if (selectionActions.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 선택 액션을 대체했습니다: ${id}`,
        });
      }
      const title = String(args.title ?? "").trim();
      // payload.selectedText 게이트: 메뉴 항목과 같은 계약(등록 시점에 굳힌다).
      const needsSelectedText = checkPermission(
        plugin.grant,
        "notes:read",
      ).allowed;
      selectionActions.set(id, {
        desc: {
          id,
          label,
          ...(title !== "" ? { title } : {}),
          ...(match.match !== undefined ? { match: match.match } : {}),
          needsSelectedText,
        },
        run: args.run as HandlerFn,
      });
      return { id };
    }

    // ── 상태 아이템 등록(ui.addStatusItem) — 호스트 스코프 등록. text는 초기값(빈 문자열
    // 허용). 검증 없이 스텁으로 떨어지면 등록이 조용히 사라져 저작자가 거짓 그린을 받는다. ──
    if (call === "ui.addStatusItem") {
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoStatusSeq);
      if (statusItems.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 상태 아이템을 대체했습니다: ${id}`,
        });
      }
      const onClick =
        typeof args.onClick === "function"
          ? (args.onClick as HandlerFn)
          : noopHandler;
      statusItems.set(id, {
        desc: {
          id,
          text: String(args.text ?? ""),
          title: args.title == null ? undefined : String(args.title),
          position: normalizeToolbarPosition(args.position),
          clickable: onClick !== noopHandler,
        },
        onClick,
      });
      return null;
    }

    // ── 메뉴바 트레이 항목 등록(ui.addTrayItem) — 호스트 스코프 등록. 예약 해제(웨이브 E)
    // 뒤 이 분기가 없으면 resolveStub로 떨어져 '조용한 성공(무등록)'이 된다 — 저작자가 거짓
    // 그린을 받는다(중앙 호스트는 run 없거나 label 비면 INVALID_ARGS로 거부한다, central-host.ts).
    // 중앙 호스트(central-host.ts ui.addTrayItem)와 같은 순수 판정을 태운다. ──
    if (call === "ui.addTrayItem") {
      // 하니스는 run 함수를 직렬화 없이 그대로 받는다(addMenuItem과 같은 규칙) — 중앙 호스트의
      // run$id(핸들러 id) 빈 검사에 대응하는 것이 run 함수 부재 검사다.
      if (typeof args.run !== "function") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addTrayItem에는 run 함수가 필요합니다(없으면 트레이에서 눌러도 아무 일도 일어나지 않는다)",
        );
      }
      // label은 트레이 메뉴에 보일 유일한 문자열이다(글리프 폴백 없음) — 비면 정체불명의 빈
      // 메뉴 줄이 된다(중앙 호스트·addMenuItem과 같은 판정).
      const label = String(args.label ?? "").trim();
      if (label === "") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.addTrayItem에는 비어 있지 않은 label이 필요합니다(트레이 메뉴에 보일 이름)",
        );
      }
      const id =
        String(args.id ?? "") ||
        autoRegistrationId(plugin.id, call, ++autoTraySeq);
      if (trayItems.has(id)) {
        diagnostics.push({
          kind: "duplicate-registration",
          call,
          message: `같은 id로 다시 등록해 앞의 트레이 항목을 대체했습니다: ${id}`,
        });
      }
      trayItems.set(id, { desc: { id, label }, run: args.run as HandlerFn });
      return { id };
    }

    // ── 상태 아이템 갱신(ui.updateStatusItem) — 창-스코프지만, 등록 여부는 호스트가 아는
    // 사실이라 하니스(단일 창)도 검증할 수 있다: 등록 전이거나 없는 id면 계약대로 INVALID_ARGS
    // (무음 무시가 아니다). 실제 갱신 렌더는 창 표면이라 여기선 값만 확인하고 null을 돌려준다. ──
    if (call === "ui.updateStatusItem") {
      const id = String(args.id ?? "");
      if (id === "") {
        throw bridgeError(
          "INVALID_ARGS",
          "ui.updateStatusItem에는 id가 필요합니다",
        );
      }
      if (!statusItems.has(id)) {
        throw bridgeError(
          "INVALID_ARGS",
          `ui.updateStatusItem: 등록되지 않은 상태 아이템 id입니다(먼저 addStatusItem으로 등록하세요): ${id}`,
        );
      }
      return null;
    }

    // ── 임의 노트 직접 쓰기(notes.write) — 중앙 호스트와 같은 인자 검증을 태운다. 실제 vault가
    // 없으므로 성공 시 수행부는 null을 돌려주지만(스텁), 인자 검증(id 필수·경로형 id 거부·
    // content 문자열·mode 어휘)은 실제 호스트와 같은 코드 경로로 거부되어야 거짓 그린이 없다. ──
    if (call === "notes.write") {
      const id = String(args.id ?? "");
      if (id === "") {
        throw bridgeError("INVALID_ARGS", "notes.write에는 id가 필요합니다");
      }
      if (!isSafeNoteIdArg(id)) {
        throw bridgeError(
          "INVALID_ARGS",
          `notes.write: 경로 형태의 id는 허용되지 않습니다(구분자와 "..", ":" 금지): ${id}`,
        );
      }
      if (typeof args.content !== "string") {
        throw bridgeError(
          "INVALID_ARGS",
          "notes.write의 content는 문자열이어야 합니다",
        );
      }
      const mode = args.mode === undefined ? "append" : args.mode;
      if (mode !== "append" && mode !== "overwrite") {
        throw bridgeError(
          "INVALID_ARGS",
          `notes.write의 mode는 "append" 또는 "overwrite"여야 합니다(생략하면 append): ${String(args.mode)}`,
        );
      }
      // 실제 노트 저장(백엔드)은 앱 밖이라 없다 — 스텁으로 응답한다(있으면 저작자가 주입).
      return resolveStub(call, args);
    }

    // ── 에디터·능력 등록(진짜 수집기로 위임) ──
    if (
      call === "editor.registerInlinePattern" ||
      call === "editor.registerCompletion" ||
      call === "editor.registerBlockEmbed" ||
      call === "theme.register" ||
      call === "background.register" ||
      call === "font.register" ||
      call === "window.register"
    ) {
      return registrar.execute(call, args);
    }

    // ── 플러그인 간 명령 호출(commands.invoke) — 이 하니스로는 정직하게 검증할 수 없다.
    // loadPluginForTest는 플러그인을 정확히 하나만 인스턴스화하므로 릴레이 대상(다른 플러그인)이
    // 이 환경에 존재할 수 없다(크로스-플러그인 릴레이는
    // 단일-플러그인 하니스로는 실행되지 않는다). resolveStub로 떨어지면 바로 null을 돌려줘
    // 프로덕션의 '성공적 디스패치'(central-host.ts도 성공 시 null)와 구분되지 않아, 대상·
    // commandId·exposes 배선이 틀려도 거짓 그린을 준다. 그래서 조용한 성공 대신 하니스 전용
    // 코드로 시끄럽게 거부해 저작자가 "여기선 확인 못 한다"는 신호를 받게 한다. ──
    if (call === "commands.invoke") {
      throw bridgeError(
        "HARNESS_UNSUPPORTED",
        "commands.invoke는 단일-플러그인 하니스로 검증할 수 없습니다(릴레이 대상 플러그인이 없다) — central-host.test.ts 통합 테스트나 실제 앱으로 확인하세요",
      );
    }

    // ── 창-스코프·호스트 데이터(스텁) ──
    return resolveStub(call, args);
  }

  // ── memo 프록시(부트스트랩 의미론 재현) ─────────────────────────────────
  const memo = makeMemoProxy({
    grant: plugin.grant,
    env,
    execute,
    onCall: (rec) => calls.push(rec),
    onReject: (rej) => rejections.push(rej),
  });

  /** 역호출 헬퍼 — 핸들러를 바인딩된 memo로 부르고 큐를 비운다(동기 throw는 errors에). */
  async function invoke(fn: HandlerFn, payload?: unknown): Promise<void> {
    try {
      fn(memo, payload);
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
    await settle();
  }

  // ── 플러그인 코드 실행 + 등록 정착 ──────────────────────────────────────
  // 최상위에서 던지면(예: 인자 개수 위반 TypeError) 부트스트랩과 같은 계약을 따른다 —
  // 예외 **이전까지 동기로 수집된 등록은 살리고**, 던진 예외는 errors에 남긴다(앱에서는
  // window error가 ready를 대신 회신한다). 로드 자체를 실패시키지 않아 저작자가 "무엇까지
  // 등록됐고 어디서 죽었는지"를 단언할 수 있다.
  try {
    new Function("memo", options.code)(memo);
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
  await settle();

  return {
    id: plugin.id,
    get buttons() {
      return [...buttons.values()].map((b) => ({ ...b.desc }));
    },
    get patterns() {
      return registrar.patterns;
    },
    get completions() {
      return registrar.completions;
    },
    get embeds() {
      return registrar.embeds;
    },
    get commands() {
      return [...commands.values()].map((c) => ({ ...c.desc }));
    },
    get subscriptions() {
      return [...subscriptions.entries()].map(([id, v]) => ({
        id,
        name: v.name,
      }));
    },
    get menuItems() {
      return [...menuItems.values()].map((m) => ({ ...m.desc }));
    },
    get selectionActions() {
      return [...selectionActions.values()].map((a) => ({ ...a.desc }));
    },
    get statusItems() {
      return [...statusItems.values()].map((s) => ({ ...s.desc }));
    },
    get trayItems() {
      return [...trayItems.values()].map((t) => ({ ...t.desc }));
    },
    get theme() {
      return registrar.theme;
    },
    get background() {
      return registrar.background;
    },
    get font() {
      return registrar.font;
    },
    get windowControls() {
      return registrar.windowControls;
    },
    get calls() {
      return calls;
    },
    get rejections() {
      return rejections;
    },
    get diagnostics() {
      return diagnostics;
    },
    get errors() {
      return errors;
    },
    get ready() {
      return calls.some((c) => c.call === "runtime.ready");
    },
    callsTo: (call) => calls.filter((c) => c.call === call),
    clickButton: async (id, payload) => {
      const b = buttons.get(id);
      if (!b) {
        throw new Error(
          `등록되지 않은 버튼 id: ${id} (등록된 것: ${[...buttons.keys()].join(", ") || "없음"})`,
        );
      }
      await invoke(b.onClick, payload);
    },
    runCommand: async (id, payload) => {
      const c = commands.get(id);
      if (!c) {
        throw new Error(
          `등록되지 않은 명령 id: ${id} (등록된 것: ${[...commands.keys()].join(", ") || "없음"})`,
        );
      }
      await invoke(c.run, payload);
    },
    emitEvent: async (name, payload) => {
      if (!isMemoEventName(name)) {
        throw new Error(
          `알 수 없는 이벤트 이름: ${String(name)} (가능한 값: ${MEMO_EVENT_NAMES.join(", ")})`,
        );
      }
      const targets = [...subscriptions.values()].filter(
        (s) => s.name === name,
      );
      for (const s of targets) await invoke(s.handler, payload);
    },
    invokeMenuItem: async (id, payload) => {
      const m = menuItems.get(id);
      if (!m) {
        throw new Error(
          `등록되지 않은 메뉴 항목 id: ${id} (등록된 것: ${[...menuItems.keys()].join(", ") || "없음"})`,
        );
      }
      // 중앙 호스트 invokeMenuItem과 동일: needsSelectedText(등록 시 notes:read 부여로 굳힘)일
      // 때만 selectedText를 싣는다. payload의 다른 필드는 전달하지 않는다(본문이 새지 않게).
      const gated: Record<string, unknown> = {};
      if (
        m.desc.needsSelectedText &&
        typeof payload?.selectedText === "string"
      ) {
        gated.selectedText = payload.selectedText;
      }
      await invoke(m.run, gated);
    },
    invokeSelectionAction: async (id, payload) => {
      const a = selectionActions.get(id);
      if (!a) {
        throw new Error(
          `등록되지 않은 선택 액션 id: ${id} (등록된 것: ${[...selectionActions.keys()].join(", ") || "없음"})`,
        );
      }
      // 앱은 `match`가 맞을 때만 버튼을 그리고 단축키도 실행한다 — 하니스가 그 판정을
      // 건너뛰면 "테스트는 통과인데 앱에서는 눌러지지 않는" 거짓 그린이 된다. 같은 순수
      // 함수로 판정하고, 거짓이면 무음 통과가 아니라 이유를 말하며 던진다.
      if (typeof payload?.selectedText === "string") {
        if (!selectionMatches(payload.selectedText, a.desc.match)) {
          throw new Error(
            `선택 액션 ${id}의 match와 맞지 않는 선택이라 앱에서는 실행되지 않는다: ${JSON.stringify(payload.selectedText)}`,
          );
        }
      }
      // payload 게이트는 중앙 호스트 invokeSelectionAction과 동일(메뉴 항목과 같은 계약).
      const gated: Record<string, unknown> = {};
      if (
        a.desc.needsSelectedText &&
        typeof payload?.selectedText === "string"
      ) {
        gated.selectedText = payload.selectedText;
      }
      await invoke(a.run, gated);
    },
    clickStatusItem: async (id, payload) => {
      const s = statusItems.get(id);
      if (!s) {
        throw new Error(
          `등록되지 않은 상태 아이템 id: ${id} (등록된 것: ${[...statusItems.keys()].join(", ") || "없음"})`,
        );
      }
      await invoke(s.onClick, payload);
    },
    invokeTrayItem: async (id) => {
      const t = trayItems.get(id);
      if (!t) {
        throw new Error(
          `등록되지 않은 트레이 항목 id: ${id} (등록된 것: ${[...trayItems.keys()].join(", ") || "없음"})`,
        );
      }
      // 중앙 호스트 invokeTrayItem과 동일: 창 컨텍스트도 payload도 없이(빈 토큰·빈 객체) run을
      // 역호출한다(central-host.ts: sandbox.invoke(item.handlerId, "", {})). 트레이 payload
      // 게이트가 따로 없으므로 빈 객체를 그대로 싣는다.
      await invoke(t.run, {});
    },
    setSetting: (key, value) => {
      store[key] = fromPluginSettingValue(fieldOf(key), value);
    },
    getSetting: (key) => toPluginSettingValue(fieldOf(key), store[key] ?? null),
    stub: (call, value) => {
      stubs[call] = value;
    },
  };
}

/**
 * 폴더에서 플러그인을 읽어 로드한다(`manifest.json` + entry) — 저작자가 자기 폴더를 그대로
 * 가리키는 가장 흔한 경로.
 *
 * 왜 여기서 fs를 쓰나: 저작자 테스트는 자기 플러그인 폴더를 대상으로 하므로, "매니페스트와
 * main.js를 손으로 읽어 넘기는" 상용구를 하니스가 대신 처리한다. 브라우저 번들에는 들어가지
 * 않는다(테스트·CLI 전용 경로).
 */
export async function loadPluginFromDir(
  dir: string,
  overrides: Partial<Omit<LoadPluginOptions, "manifest" | "code">> = {},
): Promise<HeadlessPlugin> {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const entry =
    typeof manifest?.entry === "string" ? manifest.entry : "main.js";
  const code = readFileSync(`${dir}/${entry}`, "utf8");
  return loadPluginForTest({ manifest, code, ...overrides });
}

// ── 내부: memo 프록시 ───────────────────────────────────────────────────────

/** 역호출 핸들러(첫 인자는 바인딩된 memo, 둘째는 선택 payload). */
type HandlerFn = (memo: unknown, payload?: unknown) => unknown;
/** 함수 인자가 없는 등록에 채우는 no-op(디스크립터는 만들되 실행은 아무것도 안 함). */
const noopHandler: HandlerFn = () => undefined;

/** [`makeMemoProxy`]의 배선(게이트·환경·수행부 + 관측 콜백). */
interface MemoProxyDeps {
  grant: { declared: string[]; granted: string[] };
  env: PluginRuntimeEnv;
  execute: (call: string, args: Record<string, unknown>) => Promise<unknown>;
  onCall: (rec: RecordedCall) => void;
  onReject: (rej: RecordedRejection) => void;
}

/**
 * 부트스트랩의 `makeMemo`와 **같은 규칙**의 memo 프록시를 만든다.
 *
 * 재현하는 것: (1) 모든 호출은 `memo.<ns>.<method>(객체 1개)` — 인자 2개 이상은 동기
 * TypeError, (2) `runtime.log("문자열")` 정규화만 원시값 예외(settings.get은 예외가 아니다),
 * (3) 게이트키퍼([`handleBridgeRequest`])를 태우고 거부는 `Error`에 `code`·`call`을 복원해
 * reject, (4) 성공/거부를 관측 콜백으로 기록.
 *
 * 재현하지 않는 것: 창 토큰 전파(단일 창 컨텍스트라 불필요), postMessage 직렬화(같은 프로세스
 * 실행이라 함수 인자를 그대로 수행부에 넘긴다 — 그래서 onClick·run·handler를 붙잡을 수 있다).
 */
function makeMemoProxy(deps: MemoProxyDeps): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_t, ns: string) =>
        new Proxy(
          {},
          {
            get: (_t2, method: string) =>
              function (this: unknown, ...given: unknown[]) {
                const call = `${ns}.${method}`;
                if (given.length > 1) {
                  throw new TypeError(
                    `memo.${call}은(는) 객체 인자 1개만 받습니다(받은 인자 ${given.length}개)`,
                  );
                }
                let arg = given[0];
                if (arg == null) arg = {};
                if (typeof arg !== "object") {
                  if (call === "runtime.log") arg = { message: String(arg) };
                  else {
                    // settings.get도 예외가 아니다 — 비객체 인자는 다른 호출과 똑같이 던진다
                    // (수행부도 INVALID_ARGS로 거부하므로 하니스가 앞당겨 잡는다).
                    throw new TypeError(
                      `memo.${call}은(는) 객체 인자 1개만 받습니다(받은 인자: ${typeof arg})`,
                    );
                  }
                }
                return dispatch(call, arg);
              },
          },
        ),
    },
  );

  /**
   * 한 호출을 게이트에 태우고 결과를 관측·반환한다(거부는 code/call을 실어 reject).
   *
   * `args`는 이제 언제나 객체다 — `runtime.log`만 원시 인자를 `{ message }`로 정규화해 넘기고,
   * 그 밖의 비객체 인자는 프록시가 이미 동기 TypeError로 던졌다(settings.get 축약형은 없다).
   * 기록에는 만일을 대비해 객체가 아닌 인자도 `{ arg }`로 감싸 담는다(단언 편의 — 방어적).
   */
  function dispatch(call: string, args: unknown): Promise<unknown> {
    return handleBridgeRequest(
      deps.grant,
      { call, args: args as Record<string, unknown> },
      deps.execute,
      deps.env,
    ).then((res) => {
      const recArgs =
        typeof args === "object" && args !== null
          ? sanitizeArgs(args as Record<string, unknown>)
          : { arg: args };
      if (res.ok) {
        deps.onCall({ call, args: recArgs, ok: true, result: res.result });
        return res.result;
      }
      deps.onCall({ call, args: recArgs, ok: false, code: res.code });
      deps.onReject({ call, code: res.code });
      return Promise.reject(
        Object.assign(new Error(res.error ?? "거부됨"), {
          code: res.code ?? "UNKNOWN",
          call,
        }),
      );
    });
  }
}
