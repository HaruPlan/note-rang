/**
 * e2e 공용 Tauri 목 — IPC(invoke) 정적 응답 + 창 간 이벤트 버스 심(BroadcastChannel).
 *
 * 역할: 브라우저(WebKit)에서 도는 e2e는 실제 Tauri 백엔드가 없다. `__TAURI_INTERNALS__`를
 * 목으로 심되, `plugin:event|listen/emit/unlisten`을 BroadcastChannel로 잇는 이벤트 버스를
 * 제공해 **여러 페이지(중앙 호스트 창 + 노트 창들)가 실제 프로토콜 그대로** 통신하게 한다.
 * 왜: 플러그인 중앙화 이후 샌드박스는 호스트 페이지에서만 돌므로, 플러그인 e2e는 호스트
 * 페이지를 함께 띄워야 한다 — 스냅샷 배달·버튼 위임·창-스코프 회신까지 전 경로가
 * 프로덕션과 같은 이벤트 채널로 검증된다.
 */
import type { BrowserContext, Page } from "@playwright/test";

/**
 * 스냅샷으로 배달되는 UI를 기다릴 때 쓰는 상한(ms) — 플러그인 버튼·상태 아이템·인라인 패턴
 * 데코레이션·배경 스와치처럼 **중앙 호스트 스냅샷이 도착해야 생기는** 것 전부.
 *
 * 왜 5초가 아닌가: 노트 창은 스냅샷을 **최대 10초**까지 기다린다(`src/plugin/host-client.ts`의
 * `SNAPSHOT_BUDGET_MS` — 250ms 간격으로 재요청하다 그 예산을 넘기면 플러그인 없이 진행).
 * 그보다 짧은 상한을 테스트에 박으면 5~10초 구간이 통째로 "앱은 계약대로 동작하는데 테스트만
 * 먼저 포기하는" 회색지대가 된다. 워커 6개가 콜드 vite 서버를 동시에 두드리거나 머신이 다른
 * 빌드로 바쁠 때 실제로 그 구간에 들어간다 — 사용자가 신고한 `toolbar.spec.ts`의 하단 `⋯`
 * 어서션(스냅샷이 와야만 하단 존이 넘쳐 `⋯`가 뜬다)이 바로 그 경우였다.
 *
 * 앱 예산(10초)보다 **크게** 잡는 것이 요점이다: 이 상한을 넘겨 실패했다면 앱이 스스로
 * 포기한 뒤이므로 "테스트가 성급했다"가 아니라 진짜 결함이다.
 */
export const SNAPSHOT_UI_TIMEOUT = 15_000;

/** 페이지에 설치할 Tauri IPC 목 스펙. */
interface TauriMockSpec {
  /**
   * invoke(cmd)에 돌려줄 정적 응답(JSON 직렬화 가능). 여기에도 [`CONTRACT_DEFAULTS`]에도
   * 없는 커맨드는 null.
   */
  responses?: Record<string, unknown>;
  /** navigator.clipboard.writeText를 가로채 window.__clip에 기록할지(복사 검증용). */
  captureClipboard?: boolean;
  /**
   * `convertFileSrc(path)`가 돌려줄 URL. 기본은 실제 Tauri 규칙을 흉내 낸
   * `asset://localhost/<path>`지만, 브라우저가 로드할 수 없는 스킴이라 **렌더된 이미지가
   * 실제로 그려지는지** 보는 스펙은 로드 가능한 data URL을 여기에 넣는다(경로 무관 고정값).
   */
  assetUrl?: string;
}

/**
 * 백엔드 계약이 "항상 맵/리스트"인 커맨드의 기본 응답 — `responses`에 없으면 이 값이 나간다.
 *
 * 왜 필요한가: 목의 기본 폴백은 `null`인데, 이 커맨드들의 Rust 시그니처는
 * `Result<BTreeMap<..>, String>`·`Result<Vec<..>, String>`이라 **성공하면 절대 null이 아니고,
 * 실패하면 invoke가 reject된다**(프론트는 그쪽만 `.catch`로 막는다). 목이 계약을 어기고 null을
 * 흘리면 프론트가 `null[...]`을 하게 되어 실제 앱에서는 일어날 수 없는 크래시로 테스트가
 * 깨진다 — 실제로 `list_builtin_states`가 그랬다(`src/bootstrap/note.ts`의
 * `builtinStates["youtube-embed"]`에서 노트 창 전체가 오류 오버레이로 죽어 노트 e2e가 전멸).
 * 목이 계약을 지키게 두면 각 스펙이 자기 관심사만 `responses`에 적으면 된다.
 */
const CONTRACT_DEFAULTS: Record<string, unknown> = {
  list_builtin_states: {},
  list_builtin_settings: {},
  list_installed_plugins: [],
  list_rejected_plugins: [],
  list_missing_plugins: [],
  // 설치 언어팩 직로드(②단계) — 창 부트스트랩이 **첫 페인트 전에** 부르는 계약이라 기본값이
  // 특히 중요하다: null이 새면 `Object.keys(null)`로 창이 통째로 죽는다(`list_builtin_states`가
  // 정확히 그래서 여기 들어왔다). "서드파티 언어팩이 하나도 없다"가 대다수 스펙의 정상 상태다.
  list_language_packs: [],
  read_locale_entries: {},
  list_system_fonts: [],
  note_list: [],
  note_list_snapshot_note_ids: [],
  note_list_snapshots: [],
  // 창 타이틀 조회(`getCurrentWindow().title()` — 접힌 노트 헤더 가운데 라벨이 쓴다). 실제
  // 런타임의 계약은 **항상 문자열**이라(백엔드가 본문 첫 줄에서 파생해 저장마다 갱신한다) 여기서도
  // 문자열을 준다 — null이면 프론트가 "모른다"로 읽어 라벨 경로가 e2e에서 통째로 죽는다.
  // 값은 빈 노트의 실제 폴백(앱 이름)이다. 제목을 실제로 보는 스펙은 `responses`로 덮어쓴다.
  "plugin:window|title": "노트랑",
  // 기기 고유(LocalConfig) 문자열 설정 둘 — 계약상 **항상 문자열**이라(백엔드가 기본값을
  // 채워 돌려준다) 여기서도 그 기본값을 준다. null이 새면 프론트가 "모른다"로 읽어 패널
  // 정렬은 기본값으로 접히고(무해) 설정 창 드롭다운은 아무것도 선택되지 않은 채 뜬다.
  get_panel_sort: "created-desc",
  get_startup_no_active_action: "panel",
  // `prompted: true`(=이미 안내함)로 둬 최초 실행 저장 폴더 안내(`vault-folder-prompt.ts`)가
  // 뜨지 않게 한다 — 그 오버레이는 노트 창 위를 덮어 툴바 클릭을 가로챈다. 안내 자체를 보는
  // 스펙이 생기면 `responses`로 false를 덮어쓰면 된다.
  get_vault_info: {
    path: "/vault",
    has_contents: false,
    note_count: 0,
    file_count: 0,
    prompted: true,
  },
};

/**
 * 페이지에 Tauri IPC 목 + 이벤트 버스 심을 설치한다(내비게이션마다 재적용).
 *
 * 호출 기록은 `window.__calls`(cmd/args — 이벤트 플러그인 호출은 이벤트 이름만)로 남긴다.
 * 같은 브라우저 컨텍스트의 페이지들은 BroadcastChannel("__memo_e2e_tauri_events")로
 * 이벤트를 공유한다(Tauri 전역 방송의 대역 — 자기 페이지에도 배달된다).
 */
export async function installTauriMock(
  page: Page,
  spec: TauriMockSpec = {},
): Promise<void> {
  // 스펙이 명시한 응답이 계약 기본값을 이긴다(스펙이 정본 — 기본값은 빈손 폴백일 뿐).
  const mergedSpec: TauriMockSpec = {
    ...spec,
    responses: { ...CONTRACT_DEFAULTS, ...spec.responses },
  };
  // `addInitScript`는 해제 핸들(Disposable)을 돌려준다 — 이 목은 페이지 수명 내내 살아 있어야
  // 하므로 핸들을 버리고 void로 좁힌다(그대로 return하면 선언한 `Promise<void>`와 어긋난다).
  await page.addInitScript((rawSpec: TauriMockSpec) => {
    interface EventHandler {
      (e: { event: string; id: number; payload: unknown }): void;
    }
    const w = window as unknown as {
      __calls: { cmd: string; args: Record<string, unknown> }[];
      __clip: string[];
      __TAURI_INTERNALS__: {
        transformCallback: (cb: unknown) => unknown;
        invoke: (
          cmd: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
        metadata: {
          currentWindow: { label: string };
          currentWebview: { label: string };
        };
        convertFileSrc: (path: string, protocol?: string) => string;
      };
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, id: number) => void;
      };
    };

    /**
     * 이 페이지가 흉내 내는 창 라벨 — 백엔드(`src-tauri/src/window_manager.rs`)의 생성 규칙과
     * 같은 이름을 URL에서 되짚는다(`note-<id>`·`panel`·`settings`·`plugin-host`).
     *
     * 왜 필요한가: `@tauri-apps/api`의 `getCurrentWindow()`는 `__TAURI_INTERNALS__.metadata`
     * 를 **동기로** 읽는다. 목이 그 필드를 안 채우면 `startDragging`·`closeWindow`·
     * `onWindowGeometryChange`가 TypeError를 던지고, 노트 창은 그 거부를 크래시
     * 오버레이(#24, `installNoteErrorOverlay`)로 바꿔 창 전체를 덮어 버린다 — 실제 앱에서는
     * 런타임이 metadata를 항상 채우므로 일어날 수 없는 실패다.
     */
    const params = new URLSearchParams(location.search);
    const noteId = params.get("note");
    const windowLabel = noteId
      ? `note-${noteId}`
      : params.has("panel")
        ? "panel"
        : params.has("settings")
          ? "settings"
          : params.has("plugin-host")
            ? "plugin-host"
            : "main";
    w.__calls = [];
    w.__clip = [];
    // @tauri-apps/api의 unlisten이 invoke 전에 부르는 내부 정리 훅 — 실제 해제는 아래
    // 목 invoke(plugin:event|unlisten)가 수행하므로 여기서는 무해한 스텁이면 된다.
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

    if (rawSpec.captureClipboard) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__clip.push(String(t));
            return Promise.resolve();
          },
        },
      });
    }

    // ---- 이벤트 버스 심: 로컬 리스너 + BroadcastChannel(같은 컨텍스트의 다른 페이지) ----
    const listeners: { id: number; event: string; handler: EventHandler }[] =
      [];
    let nextId = 1;
    const bc = new BroadcastChannel("__memo_e2e_tauri_events");
    const deliverLocal = (event: string, payload: unknown) => {
      for (const l of [...listeners]) {
        if (l.event === event) l.handler({ event, id: l.id, payload });
      }
    };
    bc.onmessage = (m: MessageEvent<{ event: string; payload: unknown }>) =>
      deliverLocal(m.data.event, m.data.payload);

    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: windowLabel },
        currentWebview: { label: windowLabel },
      },
      convertFileSrc: (path) =>
        rawSpec.assetUrl ?? `asset://localhost/${encodeURIComponent(path)}`,
      // 목 invoke는 인자를 직렬화하지 않으므로 콜백 함수가 그대로 전달된다.
      transformCallback: (cb) => cb,
      invoke: (cmd, args) => {
        // 이벤트 호출은 핸들러(함수)를 기록에서 빼 evaluate 직렬화가 깨지지 않게 한다.
        w.__calls.push({
          cmd,
          args: cmd.startsWith("plugin:event|")
            ? { event: (args as { event?: string }).event ?? "" }
            : args,
        });
        if (cmd === "plugin:event|listen") {
          const id = nextId++;
          listeners.push({
            id,
            event: String(args.event),
            handler: args.handler as EventHandler,
          });
          return Promise.resolve(id);
        }
        if (cmd === "plugin:event|unlisten") {
          const i = listeners.findIndex(
            (l) => l.event === String(args.event) && l.id === args.eventId,
          );
          if (i >= 0) listeners.splice(i, 1);
          return Promise.resolve(null);
        }
        if (cmd === "plugin:event|emit") {
          deliverLocal(String(args.event), args.payload);
          bc.postMessage({ event: String(args.event), payload: args.payload });
          return Promise.resolve(null);
        }
        // 네이티브 클립보드(tauri-plugin-clipboard-manager) — 프론트가 **먼저** 타는 경로다
        // (웹 API는 그 실패 폴백). 목이 이 커맨드를 그냥 null로 흘리면 "성공했다"로 읽혀
        // 복사 검증이 조용히 빈손이 된다 — 그래서 여기서도 __clip에 기록한다.
        if (
          rawSpec.captureClipboard &&
          cmd === "plugin:clipboard-manager|write_text"
        ) {
          w.__clip.push(String((args as { text?: unknown }).text ?? ""));
          return Promise.resolve(null);
        }
        // 붙여넣기도 같은 이유로 네이티브가 먼저다 — 마지막으로 쓴 값을 돌려줘 왕복을 재현한다.
        if (
          rawSpec.captureClipboard &&
          cmd === "plugin:clipboard-manager|read_text"
        ) {
          return Promise.resolve(w.__clip[w.__clip.length - 1] ?? "");
        }
        if (rawSpec.responses && cmd in rawSpec.responses) {
          return Promise.resolve(rawSpec.responses[cmd]);
        }
        return Promise.resolve(null);
      },
    };
  }, mergedSpec);
}

/**
 * 목에 쌓인 `note_save_content` 호출의 본문 인자 목록(오래된 것부터).
 *
 * 자동저장은 디바운스라 "저장이 일어났는가"는 폴링으로 봐야 한다 — 스펙들이 각자
 * `waitForFunction`을 복붙하던 자리를 이 헬퍼로 모은다(`expect.poll(...).not.toHaveLength(0)`
 * 처럼 쓰면 대기와 조회가 한 번에 끝난다).
 */
export function savedContents(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: { content?: string } }[];
      }
    ).__calls
      .filter((c) => c.cmd === "note_save_content")
      .map((c) => String(c.args.content ?? "")),
  );
}

/**
 * 플러그인 중앙 호스트 페이지를 같은 컨텍스트에 띄우고 초기 빌드 완료까지 기다린다.
 *
 * 역할: 프로덕션의 숨김 상주 창(`?plugin-host=1`)을 e2e에서 재현한다 — 샌드박스 iframe이
 * 실제로 실행되는 유일한 페이지. 노트 페이지들은 이 페이지가 방송하는 스냅샷을 받는다.
 */
export async function openPluginHost(
  context: BrowserContext,
  spec: TauriMockSpec = {},
): Promise<Page> {
  const page = await context.newPage();
  await installTauriMock(page, spec);
  await page.goto("/?plugin-host=1");
  await page.waitForSelector("body[data-host-ready]", {
    state: "attached",
    timeout: 10_000,
  });
  return page;
}
