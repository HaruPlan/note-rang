/**
 * 플러그인 로드 공용 재료 — 매니페스트 검증·부여 병합, 등록 디스크립터 수집기(registrar),
 * 설정 스냅샷 바인딩, 툴바 존 정규화.
 *
 * 역할: 중앙 호스트([`central-host`])가 샌드박스를 실행할 때 쓰는 순수 재료들을 모은다.
 * 등록 호출은 게이트키퍼를 거친 뒤에만 여기(registrar) 도달하고, 설치 플러그인의 부여는
 * 선언과의 교집합으로만 인정한다.
 * 왜: 보안 모델의 순수 로직(검증·수집·병합)을 샌드박스·전송 배선과 분리해 단위 테스트한다.
 */
import type { PluginGrant } from "./permissions";
import { bridgeError } from "./host";
import {
  parseManifest,
  type PluginContributions,
  type PluginKind,
} from "./manifest";
import type {
  InstalledPlugin as InstalledPluginRecord,
  PluginSettingField,
} from "../shared/tauri";
import {
  parseInlinePatternShape,
  type CompletionDescriptor,
  type InlinePatternDescriptor,
} from "./editor-api";
import { parseBlockEmbedDescriptor, type BlockEmbedDescriptor } from "./embed";
import { normalizeInlineStyle, pluginPatternClass } from "./inline-style";
import { normalizeThemeArgs, type ThemeDescriptor } from "../theme/theme";
import {
  normalizeBackgroundArgs,
  type BackgroundDescriptor,
} from "../theme/background";
import { normalizeFontArgs, type FontDescriptor } from "../theme/font";
import {
  normalizeWindowControlArgs,
  type WindowControlId,
} from "./window-control";

/** 툴바 버튼이 놓일 존 — 플러그인이 지정(상/하 × 좌/우 4방향). */
export type ToolbarPosition =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * 허용 존 목록(검증용) + 기본값.
 *
 * export하는 이유: 저작 계약의 단일 출처(`api-index.ts`)가 이 어휘를 그대로 실어
 * `MemoToolbarPosition` 타입을 만든다. 모르는 값은 오류가 아니라 **조용히 `top-left`로**
 * 정규화되므로(아래), 저작자가 이름을 추측하면 버튼이 소리 없이 한 존에 몰린다.
 */
export const TOOLBAR_POSITIONS: readonly ToolbarPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/**
 * `when` 조건이 쓸 수 있는 **닫힌 컨텍스트 키 어휘** — 사람용 표기(패턴 포함).
 *
 * 역할: 저작 계약(`api-index.ts`)과 CLI 린트가 같은 목록을 읽어 "지어낸 키"를 등록 시점에
 * 잡게 하는 단일 출처. 실제 판정은 [`parseWhenClause`]가 한다.
 *
 * 왜 배열 AND인가(표현식 언어가 아니라): memo는 플러그인에게 정규식도 CSS 셀렉터도 주지
 * 않는 시스템이다. 여기서 표현식 파서를 열면 그 원칙에 첫 구멍이 나고, 파서 자체가 새
 * 공격면이 된다. 배열 AND는 파서가 없어 인젝션 표면이 **0**이고, 나중에 문자열 표현식을
 * 허용해도 배열을 AND의 축약형으로 재해석할 수 있어 확장 경로가 막히지 않는다.
 *
 * **`note.hasSelection`은 이번 배포에 없다**(설계안 목록에서 뺀 유일한 키). 선택 영역을 읽는
 * 경로 자체는 생겼지만(`notes.current`가 `selection`을 함께 싣는다), **`when` 판정부가
 * 그 값을 보지 않는다** — 중앙 호스트는 보류 항목을 `note.isEmpty` 하나로 보고 `content`만
 * 읽는다(`central-host.ts`의 보류 판정). 그 상태로 키만 열면 **언제나 참**으로 평가되는
 * 키가 된다("조건을 걸었는데 아무 때나 도는" 무음 실패). 키를 나중에 **추가**하는 값싼 쪽을
 * 골랐다(제거는 그 키를 쓰던 기여를 깨서 비싸다) — 같은 왕복이 이미 `selection.empty`를
 * 나르므로 추가 비용은 판정부 한 줄이다.
 */
export const WHEN_KEYS: readonly string[] = [
  "note.isEmpty",
  "platform.macos",
  "platform.windows",
  "platform.linux",
  "plugin.<id>.enabled",
  "settings.<key>",
];

/** `when` 항목 하나를 파싱한 결과(부정 여부 + 키). */
export interface WhenTerm {
  /** `!` 접두가 붙었는지(그 조건의 반대여야 통과). */
  negated: boolean;
  /** 부정 접두를 뗀 키(어휘 검사를 통과한 값). */
  key: string;
}

/** [`parseWhenClause`]의 결과 — 실패는 **어느 항목이 왜**인지까지 문구에 싣는다. */
type WhenParseResult =
  { ok: true; terms: WhenTerm[] } | { ok: false; error: string };

/** `plugin.<id>.enabled` 형태에서 id를 뽑는 형식(플러그인 id 규칙과 같은 문자 집합). */
const WHEN_PLUGIN_RE = /^plugin\.([a-z0-9][a-z0-9._-]*)\.enabled$/;
/** `settings.<key>` 형태(설정 키 규칙과 같은 문자 집합 — 영숫자·`_`). */
const WHEN_SETTING_RE = /^settings\.([A-Za-z0-9_]+)$/;

/**
 * **에디터 컨텍스트 메뉴 항목(`ui.addMenuItem`)의 `when`이 쓸 수 있는 닫힌 키 어휘.**
 *
 * 명령(`commands.register`)의 [`WHEN_KEYS`]와 **다른 집합**인 이유는 **판정 시점과 판정 주체가
 * 다르기 때문**이다. 명령의 `when`은 실행 시점에 **호스트**가 판정하므로 호스트가 아는 정적
 * 사실(`platform.*`·`plugin.<id>.enabled`·`settings.<key>`)을 쓸 수 있다. 메뉴 항목의 `when`은
 * **표시 여부**를 정하는데, 그 판정은 우클릭한 **그 순간 그 노트 창**이 렌더 직전에 한다 —
 * 노트 창이 정직하게 아는 것은 라이브 에디터 상태(선택 영역·본문)뿐이다(설정 값·다른
 * 플러그인의 활성 여부는 노트 창에 없다). 그래서 메뉴 `when`은 **창 상태 두 키로 좁힌다**:
 *
 * - `note.hasSelection` — 선택 영역이 있는지. **명령에는 없고 메뉴에만 있는 이유가 여기다**:
 *   메뉴는 렌더 시점에 `selection.empty`를 그 자리에서 보므로 이 키를 정직하게 판정할 수 있다
 *   (명령의 `when`은 그 값을 보지 않아 언제나 참이 되는 무음 실패라 [`WHEN_KEYS`]에서 뺐다).
 * - `note.isEmpty` — 본문이 (공백만 빼고) 비었는지. 메뉴도 명령과 같은 의미로 판정한다.
 */
export const MENU_WHEN_KEYS: readonly string[] = [
  "note.isEmpty",
  "note.hasSelection",
];

/**
 * `when` 배열을 닫힌 어휘로 검증해 항목 목록으로 만든다(명령 / 메뉴 항목).
 *
 * 역할: 등록 시점에 **모르는 키를 거부**한다 — 통과시키면 그 조건은 영원히 평가되지 않고,
 * 저작자는 "조건이 무시되는지 항상 참인지"조차 알 수 없다(무음 실패). `settings.<key>`는
 * **자기 플러그인이 매니페스트에 선언한 키**만 허용한다: 남의 설정을 읽는 통로가 되면 안 되고,
 * 오타 난 키는 언제나 거짓이 되어 기여가 통째로 사라진다.
 * 왜 여기(loader)인가: 호스트(central-host)와 CLI(memo-plugin lint)가 **같은 판정**을 써야
 * "CLI는 문제 없다는데 앱은 거부한다"가 생기지 않는다.
 *
 * `opts.menu`: 메뉴 항목의 `when`은 [`MENU_WHEN_KEYS`](창 상태 두 키)만 받는다 — 정적
 * 키(`platform`·`plugin.enabled`·`settings`)는 렌더 시점의 노트 창이 판정할 수 없어 거부한다.
 */
export function parseWhenClause(
  raw: unknown,
  settingKeys: readonly string[],
  opts?: { menu?: boolean },
): WhenParseResult {
  if (raw === undefined || raw === null) return { ok: true, terms: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "when이 배열이 아님(문자열 배열 AND만 받습니다)",
    };
  }
  const menu = opts?.menu === true;
  const terms: WhenTerm[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "") {
      return { ok: false, error: `when 항목이 문자열이 아님: ${String(item)}` };
    }
    const negated = item.startsWith("!");
    const key = negated ? item.slice(1) : item;
    if (menu) {
      // 메뉴 항목은 창 상태 두 키만 — 정적 키는 렌더 시점의 노트 창이 못 본다.
      if (key === "note.isEmpty" || key === "note.hasSelection") {
        terms.push({ negated, key });
        continue;
      }
      return {
        ok: false,
        error: `메뉴 항목 when의 알 수 없는 키: ${key} (메뉴 항목은 ${MENU_WHEN_KEYS.join(", ")}만 씁니다 — 정적 조건은 run 안에서 판단하세요)`,
      };
    }
    if (
      key === "note.isEmpty" ||
      key === "platform.macos" ||
      key === "platform.windows" ||
      key === "platform.linux" ||
      WHEN_PLUGIN_RE.test(key)
    ) {
      terms.push({ negated, key });
      continue;
    }
    const setting = WHEN_SETTING_RE.exec(key);
    if (setting) {
      if (!settingKeys.includes(setting[1])) {
        return {
          ok: false,
          error: `when의 settings.${setting[1]}: 매니페스트 settings에 선언되지 않은 키(자기 플러그인의 선언된 키만 쓸 수 있습니다)`,
        };
      }
      terms.push({ negated, key });
      continue;
    }
    return {
      ok: false,
      error:
        key === "note.hasSelection"
          ? "when의 note.hasSelection: 명령(commands.register)의 when은 선택 영역을 보지 않아 언제나 참이 됩니다 — 선택 조건이 필요하면 ui.addMenuItem(메뉴 항목)의 when을 쓰세요"
          : `when의 알 수 없는 키: ${key} (가능한 값: ${WHEN_KEYS.join(", ")})`,
    };
  }
  return { ok: true, terms };
}

/**
 * **메모 창의 상태를 봐야만** 판정할 수 있는 `when` 키(지금은 `note.isEmpty`뿐).
 *
 * 역할: 정적 평가([`evaluateStaticWhen`])가 이 키들을 `pending`으로 넘기고, 스냅샷의
 * `whenPendingKeys`(설정 화면 액션 버튼이 "왜 실행할 수 없는지"를 미리 말하는 근거)도
 * 이 목록으로 만든다.
 * 왜 상수인가: 판정(호스트)과 안내(설정 화면)가 서로 다른 목록을 보면, 새 창-의존 키를
 * 추가할 때 한쪽만 갱신돼 "실행은 보류되는데 안내는 없다"(또는 그 반대)로 갈라진다.
 */
export const WINDOW_WHEN_KEYS: readonly string[] = ["note.isEmpty"];

/**
 * 파싱된 `when` 항목 중 **호스트가 즉시 판정할 수 있는 것**만 평가한다.
 *
 * [`WINDOW_WHEN_KEYS`](`note.isEmpty`)는 그 순간 그 창의 본문을 봐야 하므로 여기서 판정하지
 * 않고 `pending`으로 넘긴다 — 호출부(중앙 호스트)가 창-스코프 호출로 확인한다. 정적 항목 중
 * 하나라도 거짓이면 창에 물어볼 것도 없이 `false`다(왕복을 아끼는 것이 아니라, 창이 없을 때도
 * 정답이 나온다).
 */
export function evaluateStaticWhen(
  terms: readonly WhenTerm[],
  ctx: {
    /** OS 식별자("macos"·"windows"·"linux"). 빈 문자열이면 platform.* 는 전부 거짓. */
    platform: string;
    /** 이번 빌드에서 실제로 실행 중인 플러그인 id 집합. */
    enabledPlugins: ReadonlySet<string>;
    /** 자기 플러그인 설정 값 읽기(참/거짓 판정은 JS 진릿값 + 빈 문자열=거짓). */
    setting(key: string): unknown;
  },
): { value: boolean; pending: WhenTerm[] } {
  const pending: WhenTerm[] = [];
  for (const term of terms) {
    let actual: boolean;
    if (WINDOW_WHEN_KEYS.includes(term.key)) {
      pending.push(term);
      continue;
    } else if (term.key.startsWith("platform.")) {
      actual = ctx.platform === term.key.slice("platform.".length);
    } else {
      const plugin = WHEN_PLUGIN_RE.exec(term.key);
      if (plugin) {
        actual = ctx.enabledPlugins.has(plugin[1]);
      } else {
        const value = ctx.setting(WHEN_SETTING_RE.exec(term.key)![1]);
        // 빈 문자열·0·null은 거짓이다(토글은 boolean, 텍스트는 "비어 있으면 꺼짐"이 자연스럽다).
        actual = value !== "" && Boolean(value);
      }
    }
    if (actual === term.negated) return { value: false, pending: [] };
  }
  return { value: true, pending };
}

/** 임의 입력을 알려진 존으로 정규화한다(모르면 기본 top-left — 신뢰 못 할 값 차단). */
export function normalizeToolbarPosition(raw: unknown): ToolbarPosition {
  return TOOLBAR_POSITIONS.includes(raw as ToolbarPosition)
    ? (raw as ToolbarPosition)
    : "top-left";
}

/** 플러그인이 등록한 툴바 버튼(호스트가 노트 툴바의 지정 존에 렌더, 클릭 시 onClick 실행). */
export interface PluginToolbarButton {
  id: string;
  /** 이 버튼을 등록한 플러그인 id — 단축키 디스패치의 안정 식별자(`plugin:<pluginId>:<id>`)에 쓴다. */
  pluginId: string;
  label: string;
  title?: string;
  /** 놓일 존(플러그인이 결정). */
  position: ToolbarPosition;
  onClick(): void;
}

/**
 * 플러그인 런타임 설정 서비스 — 플러그인 id·현재 값에 바인딩된 값 읽기/저장.
 *
 * 역할: 샌드박스가 보내는 `settings.get`/`settings.set` 브리지 호출의 실제 백엔드다.
 * `get`은 로컬 스냅샷에서 읽고, `set`은 스냅샷을 갱신하며 영속화(IPC)를 호출한다.
 * 왜: 값 저장은 백엔드가 선언 스키마 키로 제한하므로, 여기서는 값 전달만 담당한다.
 */
interface PluginSettingsService {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * 플러그인 설정 스냅샷을 만든다(런타임 get/set 백엔드, 순수 — 테스트용).
 *
 * 역할: 초기 값을 복사한 스냅샷에서 `get`으로 읽고, `set`은 스냅샷을 즉시 갱신하며 `persist`
 * (영속화)를 호출한다. 같은 세션 안에서 set→get 일관성을 보장한다.
 * 왜: 값 저장의 영속화(IPC)를 주입받아, 스냅샷/일관성 로직만 샌드박스 없이 단위 테스트한다.
 */
export function bindPluginSettings(
  initial: Record<string, unknown>,
  persist: (key: string, value: unknown) => void,
): PluginSettingsService {
  // 값 맵은 프로토타입 없는 객체 — 신뢰 경계를 넘어온 `__proto__` 키가 `values[key] = ...`로
  // 프로토타입을 오염시키지 못하게 한다(Rust 게이트가 예약 키를 이미 막지만 방어 심층화).
  const values: Record<string, unknown> = Object.assign(
    Object.create(null),
    initial,
  );
  return {
    get: (key) => values[key],
    set: (key, value) => {
      values[key] = value;
      persist(key, value);
    },
  };
}

/** 설치된(사이드로드) 플러그인 한 건의 로드 입력(매니페스트 원문 + 코드 + 로컬 부여). */
export interface InstalledPluginSource {
  /** 매니페스트 원문(검증 전 — `parseManifest`로 다시 검증한다). */
  manifest: unknown;
  /** entry 코드(샌드박스에서 eval). */
  code: string;
  /** 로컬에서 부여된 권한(민감 권한 게이트). 선언과 교집합만 유효. */
  granted: string[];
  /** 현재 설정 값(런타임 `settings.get` 초기 스냅샷). 없으면 빈 값으로 취급. */
  settings?: Record<string, unknown>;
}

/**
 * 저작자가 id를 주지 않은 등록에 호스트가 붙여 주는 안정 id.
 *
 * 왜 함수로 빼는가: 이 형식을 만드는 곳이 둘이다 — 등록 수집기([`makeRegistrar`])와
 * 중앙 호스트의 툴바 버튼 수집. 두 곳이 각자 문자열을 조립하면 한쪽만 바뀌어도 아무 가드가
 * 울지 않고, 그 id는 사용자의 툴바 배치·단축키가 붙는 **영속 키**라 조용히 갈리면
 * "업데이트했더니 버튼 배치가 초기화됐다"로 나타난다.
 */
export function autoRegistrationId(
  pluginId: string,
  call: string,
  seq: number,
): string {
  return `${pluginId || "plugin"}:${call}:${seq}`;
}

/**
 * 등록된 디스크립터를 모으는 실행기(브리지 executor 본체).
 *
 * 역할: 에디터 등록(인라인 패턴·자동완성·블록 임베드)과 능력 등록(`theme.register`·
 * `background.register`·`font.register`·`window.register`)을 각각 수집한다.
 * 테마는 하나만 유효하므로 마지막 등록이 `theme`에 들어간다(정규화는 [`normalizeThemeArgs`]).
 * 왜: 번들·설치 플러그인과 테마 플러그인이 같은 브리지 executor를 공유하면서, 게이트키퍼가
 * 각 호출을 이미 검사한 뒤에만 여기 도달한다(미선언 `theme.register`는 여기 오지 못한다).
 *
 * `pluginId`는 인라인 패턴 클래스 네임스페이스([`pluginPatternClass`])와 자동 생성 id에만
 * 쓴다 — 테마 등 패턴을 등록하지 않는 경로는 생략해도 무해하다.
 *
 * **등록 계약**: 모든 등록 호출은 `{ id }`를 돌려준다. id를 주지 않으면 호스트가
 * `<pluginId>:<call>:<seq>`로 만들어 돌려주고, **같은 id로 다시 등록하면 append가 아니라
 * 치환(upsert)**이다. 왜: 예전에는 id 검증 없이 배열에 push해서, 빈 id·중복 id로 같은 키에
 * 두 요소가 조용히 붙었다(첫 등록만 실제로 쓰이므로 저작자는 원인을 알 수 없었다).
 *
 * `onDuplicate`는 그 치환을 **저작자가 볼 수 있게** 올려 보내는 통로다(중앙 호스트가 진단으로
 * 기록한다) — upsert는 옳은 동작이지만, 복사-붙여넣기로 id를 안 바꾼 저작자에게는 "등록이
 * 하나 사라졌다"로 보이므로 그 이유가 어딘가에 남아야 한다.
 */
export function makeRegistrar(
  pluginId = "",
  onDuplicate?: (call: string, id: string) => void,
): {
  patterns: InlinePatternDescriptor[];
  completions: CompletionDescriptor[];
  embeds: BlockEmbedDescriptor[];
  /** 테마 플러그인이 등록한 디스크립터(미등록이면 null). */
  theme: ThemeDescriptor | null;
  /** 배경 플러그인이 등록한 디스크립터(미등록이면 null). */
  background: BackgroundDescriptor | null;
  /** 폰트 플러그인이 등록한 디스크립터(미등록이면 null). */
  font: FontDescriptor | null;
  /** 이 플러그인이 등록한 창 컨트롤 능력 id 목록(미등록이면 빈 배열). */
  windowControls: WindowControlId[];
  execute(call: string, args: Record<string, unknown>): Promise<unknown>;
} {
  // 등록 순서를 보존하면서 id로 치환할 수 있게 Map으로 모은다(Map.set은 기존 키의 자리를
  // 유지한다 → upsert가 순서를 흔들지 않는다).
  const patterns = new Map<string, InlinePatternDescriptor>();
  const completions = new Map<string, CompletionDescriptor>();
  const embeds = new Map<string, BlockEmbedDescriptor>();
  // 객체를 참조로 유지해 execute 내부에서 갱신하고 반환 객체에서 읽게 한다(테마는 단일).
  const collected: {
    theme: ThemeDescriptor | null;
    background: BackgroundDescriptor | null;
    font: FontDescriptor | null;
    windowControls: WindowControlId[];
  } = { theme: null, background: null, font: null, windowControls: [] };
  let autoSeq = 0;
  /** 저작자가 준 id를 쓰되, 비었으면 `<pluginId>:<call>:<seq>`로 만들어 준다. */
  const registrationId = (raw: unknown, call: string): string => {
    const given = String(raw ?? "");
    if (given !== "") return given;
    return autoRegistrationId(pluginId, call, ++autoSeq);
  };
  /** 이미 있는 id면 치환이다 — 그 사실만 호출자에게 알린다(수집 자체는 그대로 upsert). */
  const noteIfReplacing = (
    map: Map<string, unknown>,
    call: string,
    id: string,
  ): void => {
    if (map.has(id)) onDuplicate?.(call, id);
  };
  /** 슬롯이 하나뿐인 능력 등록(테마·배경·폰트·창 컨트롤)의 안정 id — seq가 필요 없다. */
  const capabilityId = (call: string): string =>
    `${pluginId || "plugin"}:${call}`;

  const execute = async (
    call: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    if (call === "editor.registerInlinePattern") {
      // 구분자·토막·동작은 구조 검증을 통과해야 등록된다(블록 임베드와 같은 결). 예전에는
      // `String(args.open ?? "")`가 전부라 `open:"["`·`close:")"` 같은 등록이 성공한 뒤
      // 엉뚱한 구간을 캡처해 조용히 잘못 동작했다 — 그 무음 실패를 여기서 끝낸다.
      const shape = parseInlinePatternShape({
        open: args.open,
        mid: args.mid,
        close: args.close,
        param: args.param,
        label: args.label,
        target: args.target,
        action: args.action,
      });
      if (!shape.ok) {
        throw bridgeError(
          "INVALID_ARGS",
          `잘못된 인라인 패턴 디스크립터: ${shape.field} — ${shape.reason}`,
        );
      }
      const id = registrationId(args.id, call);
      const style = normalizeInlineStyle(args.style);
      const styleHover = normalizeInlineStyle(args.styleHover);
      noteIfReplacing(patterns, call, id);
      patterns.set(id, {
        id,
        ...shape.shape,
        // 클래스는 플러그인 값이 아니라 호스트가 파생한다(셀렉터 하이재킹 차단).
        className: pluginPatternClass(pluginId, id),
        ...(style ? { style } : {}),
        ...(styleHover ? { styleHover } : {}),
      });
      return { id };
    }
    if (call === "editor.registerCompletion") {
      const id = registrationId(args.id, call);
      noteIfReplacing(completions, call, id);
      completions.set(id, {
        id,
        trigger: String(args.trigger ?? ""),
        wrap: String(args.wrap ?? "%"),
        // 후보 원천은 지금 노트 제목 하나뿐 — 닫힌 열거형이라 모르는 값은 그리로 정규화한다
        // (열어 두면 "조용히 후보 0개"라는 무음 실패가 다시 생긴다).
        source: "note-titles",
      });
      return { id };
    }
    if (call === "editor.registerBlockEmbed") {
      // 구조 검증 실패는 등록 거부(게이트키퍼가 오류 응답으로 감싼다). **어느 필드가 왜**
      // 인지를 문구에 싣는다 — 진단 채널에 남는 이 한 줄이 저작자의 유일한 단서다.
      const parsed = parseBlockEmbedDescriptor(args);
      if (!parsed.ok) {
        throw bridgeError(
          "INVALID_ARGS",
          `잘못된 블록 임베드 디스크립터: ${parsed.field} — ${parsed.reason}`,
        );
      }
      // 임베드 id는 파서가 이미 형식을 강제하므로(빈 값 불가) 자동 생성이 필요 없다.
      noteIfReplacing(embeds, call, parsed.descriptor.id);
      embeds.set(parsed.descriptor.id, parsed.descriptor);
      return { id: parsed.descriptor.id };
    }
    if (call === "theme.register") {
      collected.theme = normalizeThemeArgs(args);
      return { id: capabilityId(call) };
    }
    if (call === "background.register") {
      collected.background = normalizeBackgroundArgs(args);
      return { id: capabilityId(call) };
    }
    if (call === "font.register") {
      collected.font = normalizeFontArgs(args);
      return { id: capabilityId(call) };
    }
    if (call === "window.register") {
      collected.windowControls = normalizeWindowControlArgs(args).controls;
      return { id: capabilityId(call) };
    }
    throw bridgeError("UNKNOWN_CALL", `지원하지 않는 호출: ${call}`);
  };
  return {
    get patterns() {
      return [...patterns.values()];
    },
    get completions() {
      return [...completions.values()];
    },
    get embeds() {
      return [...embeds.values()];
    },
    get theme() {
      return collected.theme;
    },
    get background() {
      return collected.background;
    },
    get font() {
      return collected.font;
    },
    get windowControls() {
      return collected.windowControls;
    },
    execute,
  };
}

/**
 * 백엔드 목록 항목(`InstalledPlugin`) + entry 코드를 로더 입력으로 재구성한다.
 *
 * 역할: IPC로 온 **평탄한 레코드**에서 매니페스트를 되짚어 [`InstalledPluginSource`]를
 * 만든다. 백엔드는 매니페스트 원문을 돌려주지 않고 필드별로 펼쳐 보내므로, 로드 경로가
 * 요구하는 형태로 다시 접는 지점이 반드시 하나 필요하다.
 *
 * 왜 여기(로더)에 있나: 재구성이 **빠뜨린 필드는 그대로 기능 하나가 죽는다.** 실제로
 * `settings`를 빠뜨려 설치(서드파티) 플러그인 전원의 `settings.getAll()`이 `{}`였고
 * (번들만 멀쩡했다), 그전엔 `kind`가 같은 방식으로 누락됐다. 재구성과 소비를
 * 한 모듈에 두면 `prepareInstalledPlugin`으로 왕복시키는 가드 하나로 전 필드를 못박을 수
 * 있다 — 화면 진입점(main.ts)에 두면 그 가드를 붙일 자리가 없다.
 *
 * `kind`는 **알려진 어휘일 때만** 싣는다: 타입은 선언돼 있어도 값은 신뢰 경계
 * 밖이고(사용자 폴더 → 백엔드 → IPC), 어휘 밖 값이 섞이면 `parseManifest`가 매니페스트
 * **전체**를 거부해 그 플러그인이 통째로 사라진다. 재구성 경로가 원본보다 엄격해질 이유가
 * 없으므로 모르는 값은 실패가 아니라 누락(=미선언 = 하위호환 경로)으로 처리한다.
 */
export function installedSourceFromRecord(
  record: InstalledPluginRecord,
  code: string,
): InstalledPluginSource {
  return {
    manifest: {
      id: record.id,
      name: record.name,
      version: record.version,
      entry: "main.js",
      permissions: record.permissions,
      ...(record.platforms ? { platforms: record.platforms } : {}),
      ...(record.settings_schema?.length
        ? { settings: record.settings_schema }
        : {}),
      ...(record.kind === "capability" || record.kind === "action"
        ? { kind: record.kind }
        : {}),
      // 선언형 기여도 여기서 되접지 않으면 설치 플러그인만 통째로 무시된다 — 백엔드는
      // 매니페스트 원문이 아니라 펼친 레코드를 보내므로, 이 한 줄이 유일한 통로다.
      ...(record.contributes ? { contributes: record.contributes } : {}),
      // 공개 명령도 같은 이유로 되접는다 — 없으면 설치 플러그인의 명령 공개가 통째로
      // 무시된다(백엔드 `scan_installed_report`가 `exposes`를 실어 보낸다 — 웨이브 F2에서 배선).
      ...(record.exposes ? { exposes: record.exposes } : {}),
    },
    code,
    granted: record.granted,
    settings: record.settings,
  };
}

/**
 * 검증을 통과한 설치 플러그인 1건에서 로드에 필요한 사실 전부(중앙 호스트의 입력).
 *
 * export하지 않는다: 소비처(central-host)는 `prepareInstalledPlugin`의 반환을 구조 분해로만
 * 쓰고 이 이름을 필요로 하지 않는다(쓰지 않는 export를 만들지 않는다 — knip).
 */
interface PreparedInstalledPlugin {
  id: string;
  code: string;
  grant: PluginGrant;
  /** 매니페스트가 선언한 지원 OS(없으면 전 플랫폼) — 중앙 호스트의 OS 게이트에 쓴다. */
  platforms: string[] | undefined;
  /**
   * 매니페스트가 선언한 종류 — 중앙 호스트가 [`PluginRuntimeEnv`]에 실어 게이트키퍼에
   * 넘긴다. 선택 필드라 미선언이면 undefined(하위호환 경로).
   *
   * 왜 여기서 같이 꺼내는가: 이 함수가 "검증된 매니페스트에서 로드에 필요한 사실만 뽑는"
   * 유일한 지점이다. 소비처가 매니페스트를 또 파싱해 꺼내면 검증과 소비가 갈라진다.
   */
  kind: PluginKind | undefined;
  /**
   * 매니페스트가 선언한 설정 스키마(없으면 빈 배열) — `settings.get`/`getAll`의 값 구조화와
   * 기본값 병합의 기준. 예전엔 중앙 호스트가 매니페스트를 **다시 파싱해** 꺼냈다.
   */
  settings: PluginSettingField[];
  /**
   * 매니페스트가 선언한 기여(없으면 undefined).
   *
   * 이 줄이 없으면 정확히 이 파일의 docstring이 경고하는 사고가 재현된다: 재구성이 빠뜨린
   * 필드는 그대로 기능 하나가 죽고(설치 플러그인만 `contributes`가 무시된다), 번들만 멀쩡해
   * 원인이 보이지 않는다.
   */
  contributes: PluginContributions | undefined;
  /**
   * 매니페스트가 다른 플러그인에 공개한 명령 id들(없으면 undefined). 중앙 호스트가
   * `commands.invoke` 릴레이의 공개 판정(`exposesOf`)에 쓴다. `contributes`와 같은 이유로
   * 여기서 함께 꺼낸다 — 소비처가 매니페스트를 또 파싱하면 검증과 소비가 갈라진다.
   */
  exposes: string[] | undefined;
}

/** [`prepareInstalledPlugin`]의 결과 — 실패는 사유와 함께 돌려준다(조용히 사라지지 않게). */
type PrepareResult =
  | { ok: true; plugin: PreparedInstalledPlugin }
  | {
      ok: false;
      /** 표시·진단용 id(매니페스트가 깨져 못 읽으면 `"(알 수 없음)"`). */
      id: string;
      error: string;
    };

/**
 * 설치 플러그인 한 건을 로드 준비한다(순수 — 매니페스트 검증 + 부여 병합).
 *
 * 역할: 매니페스트를 다시 검증(`parseManifest`)하고, 부여(granted)를 선언과의 교집합으로만
 * 인정한 grant를 만들며, 로드에 필요한 나머지 사실(플랫폼·kind·설정 스키마)을
 * 함께 꺼낸다. 검증 실패는 **사유와 함께** 돌려준다 — 호출부가 스냅샷 `failures`에 실어
 * 설정 화면에 띄운다.
 * 왜 사유가 필요한가: 예전에는 null을 돌려주고 호출부가 `continue`로 건너뛰었다. 그래서
 * TS 검증만 거부하는 매니페스트(예: Rust와 길이 단위가 어긋난 경우)에서 그 플러그인이
 * ⚠ 배지도 진단도 없이 통째로 사라졌다 — Rust 스캔 탈락에서 없앤 침묵이 TS 로드
 * 경로에 그대로 남아 있었다.
 * 왜: 선언 안 한 권한은 부여돼 있어도 무효 — 동기화/UI 버그로도 미선언 권한이 새지 않게
 * 게이트키퍼에 넘기기 전에 부여를 선언의 부분집합으로 못박는다. 샌드박스 실행과 분리해
 * 이 로직만 단위 테스트할 수 있게 한다(샌드박스 iframe은 e2e에서 검증).
 */
export function prepareInstalledPlugin(
  source: InstalledPluginSource,
): PrepareResult {
  const parsed = parseManifest(source.manifest);
  if (!parsed.ok) {
    const rawId = (source.manifest as { id?: unknown } | null)?.id;
    return {
      ok: false,
      id: typeof rawId === "string" && rawId !== "" ? rawId : "(알 수 없음)",
      error: `매니페스트 검증 실패: ${parsed.error}`,
    };
  }
  const declared = parsed.manifest.permissions;
  return {
    ok: true,
    plugin: {
      id: parsed.manifest.id,
      code: source.code,
      grant: {
        declared,
        granted: source.granted.filter((g) => declared.includes(g)),
      },
      platforms: parsed.manifest.platforms,
      kind: parsed.manifest.kind,
      settings: parsed.manifest.settings ?? [],
      contributes: parsed.manifest.contributes,
      exposes: parsed.manifest.exposes,
    },
  };
}
