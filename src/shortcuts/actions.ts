/**
 * 단축키로 실행 가능한 **핵심 노트 동작** 카탈로그 — 설정 UI(라벨 나열)와 노트 창(invoker 배선)이
 * 공유하는 단일 진실원천. 순수 데이터/함수만.
 *
 * 플러그인 툴바 버튼은 런타임 호스트 스냅샷에서 `plugin:<pluginId>:<buttonId>` 형태로 별도 합류하며
 * 이 정적 카탈로그에 포함되지 않는다(활성 플러그인에 따라 동적).
 */
/** 단축키를 걸 수 있는 핵심 동작 하나. */
interface ShortcutAction {
  /** 안정 id — accel 맵 키이자(기본적으로) 노트 창 버튼의 `data-action` 값. */
  id: string;
  /**
   * 설정 UI 라벨의 i18n 키(문장 자체가 아니다) — `t(labelKey)`는 소비 지점(설정 렌더)이
   * 호출 시점에 해석한다. 이 카탈로그는 모듈 로드 시 한 번만 만들어지는데(파일 상단
   * `export const`), 그 시점은 `setActiveLocale()`(창 부트스트랩)보다 항상 먼저다 — 문장을
   * 여기서 `t()`로 미리 구우면 활성 로케일이 무엇이든 영원히 ko로 굳는다(§i18n 규약).
   */
  labelKey: string;
  /**
   * 이 동작이 대응 플러그인이 켜졌을 때만 동작함을 표시(핀·모든데스크탑=창 컨트롤, 확대/축소=글자
   * 크기). 꺼져 있으면 버튼이 없어 디스패치는 no-op이 된다(설정 UI가 "플러그인 필요"를 안내).
   */
  requires?: string;
  /**
   * 실제 디스패치할 `data-action`(id와 다를 때). 예 확대/축소는 「글자 크기」 플러그인의 A+/A− 버튼을
   * 눌러 **플러그인 동작(글자 조절 + 토스트)을 그대로 재사용**한다 — 클릭과 완전히 동일하게 동작.
   */
  target?: string;
  /** 기본 바인딩(창 단위 accel). 사용자가 지우면 해제(기본으로 되돌리려면 복원 버튼). */
  defaultAccel?: string;
}

/** 핵심 노트 동작 카탈로그(고정 순서 — 설정 UI 표시 순서와 일치). */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  // 확대/축소는 「글자 크기」 플러그인의 A+/A− 버튼으로 디스패치한다(클릭과 동일 — 토스트 포함).
  {
    id: "zoom-in",
    labelKey: "shortcuts.actions.zoom-in",
    requires: "font-scale",
    target: "plugin:font-scale:font-plus",
    defaultAccel: "Alt+Equal",
  },
  {
    id: "zoom-out",
    labelKey: "shortcuts.actions.zoom-out",
    requires: "font-scale",
    target: "plugin:font-scale:font-minus",
    defaultAccel: "Alt+Minus",
  },
  { id: "toggle-preview", labelKey: "shortcuts.actions.toggle-preview" },
  {
    id: "toggle-pin",
    labelKey: "shortcuts.actions.toggle-pin",
    requires: "always-on-top",
  },
  { id: "toggle-collapse", labelKey: "shortcuts.actions.toggle-collapse" },
  {
    id: "toggle-all-desktops",
    labelKey: "shortcuts.actions.toggle-all-desktops",
    requires: "all-desktops",
  },
  // 옵션 초기화는 「옵션 초기화」 플러그인의 ↺ 버튼으로 디스패치한다(클릭과 동일 — confirm 게이트
  // 포함). 파괴적이라 기본 바인딩은 주지 않는다(설정에 보이고 걸 수 있으나 기본은 미바인딩).
  {
    id: "reset-options",
    labelKey: "shortcuts.actions.reset-options",
    requires: "reset-options",
    target: "plugin:reset-options:reset",
  },
  { id: "archive-note", labelKey: "shortcuts.actions.archive-note" },
  { id: "delete-note", labelKey: "shortcuts.actions.delete-note" },
];

/**
 * 플러그인 **명령**의 단축키 동작 id — `plugin:<pluginId>:cmd:<commandId>`.
 *
 * 왜 `cmd:`를 끼우는가: 툴바 버튼의 동작 id는 `plugin:<pluginId>:<buttonId>`다. 구분자가
 * 없으면 `commandId`가 `"save"`인 명령과 `buttonId`가 `"save"`인 버튼이 **같은 문자열**이
 * 되어, 사용자가 배정한 단축키 하나가 둘 중 아무거나 실행한다(사용자 설정에 영속되는 키라
 * 뒤늦게 고치면 배정이 통째로 초기화된다). 접두사를 넣는 값은 지금 한 번이고, 안 넣는 대가는
 * 영구적이다.
 */
export function pluginCommandActionId(
  pluginId: string,
  commandId: string,
): string {
  return `plugin:${pluginId}:cmd:${commandId}`;
}

/**
 * 동작 id가 플러그인 명령이면 (플러그인, 명령) 짝으로 쪼갠다(아니면 null).
 *
 * `commandId`에 `:`가 들어 있어도 안전하게 되짚도록 **첫 세 조각만** 고정으로 떼고 나머지를
 * 전부 명령 id로 본다(플러그인 id에는 `:`가 들어갈 수 없다 — 매니페스트 id 형식이 막는다).
 */
export function parsePluginCommandAction(
  actionId: string,
): { pluginId: string; commandId: string } | null {
  const parts = actionId.split(":");
  if (parts.length < 4 || parts[0] !== "plugin" || parts[2] !== "cmd") {
    return null;
  }
  const commandId = parts.slice(3).join(":");
  // 빈 명령 id는 되짚어 봐야 호스트에서 어떤 명령과도 안 맞는다 — 여기서 끊어 "빈 명령을
  // 실행하려 했다"는 IPC가 아예 나가지 않게 한다(그 왕복은 흔적 없이 사라진다).
  return commandId === "" ? null : { pluginId: parts[1], commandId };
}

/**
 * 플러그인 **선택 액션**의 단축키 동작 id — `plugin:<pluginId>:sel:<actionId>`.
 *
 * `cmd:`를 끼운 이유와 **같다**: 구분자가 없으면 `actionId`가 `"calc"`인 선택 액션과
 * `buttonId`가 `"calc"`인 툴바 버튼이 같은 문자열이 되어, 사용자가 배정한 단축키 하나가 둘 중
 * 아무거나 실행한다(사용자 설정에 영속되는 키라 뒤늦게 고치면 배정이 통째로 초기화된다).
 */
export function pluginSelectionActionId(
  pluginId: string,
  actionId: string,
): string {
  return `plugin:${pluginId}:sel:${actionId}`;
}

/**
 * 동작 id가 플러그인 선택 액션이면 (플러그인, 액션) 짝으로 쪼갠다(아니면 null).
 *
 * 명령 파서와 같은 규칙이다: 첫 세 조각만 고정으로 떼고 나머지를 전부 액션 id로 본다
 * (플러그인 id에는 `:`가 들어갈 수 없다 — 매니페스트 id 형식이 막는다).
 */
export function parsePluginSelectionAction(
  actionId: string,
): { pluginId: string; selectionActionId: string } | null {
  const parts = actionId.split(":");
  if (parts.length < 4 || parts[0] !== "plugin" || parts[2] !== "sel") {
    return null;
  }
  const selectionActionId = parts.slice(3).join(":");
  // 빈 액션 id는 되짚어 봐야 호스트에서 어떤 액션과도 안 맞는다(명령 파서와 같은 이유).
  return selectionActionId === ""
    ? null
    : { pluginId: parts[1], selectionActionId };
}

/** 동작 id → 실제 클릭할 `data-action`(별칭). 확대/축소만 플러그인 버튼으로 재지정된다. */
const DISPATCH_TARGETS: Record<string, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.filter((a) => a.target).map((a) => [a.id, a.target!]),
);

/**
 * 동작 id를 실제 디스패치 대상 `data-action`으로 해석한다. 별칭이 있으면 그것(확대/축소→플러그인
 * 버튼), 없으면 id 그대로(네이티브 토글·보관·삭제 및 플러그인 버튼 id는 자기 자신).
 */
export function dispatchTarget(actionId: string): string {
  return DISPATCH_TARGETS[actionId] ?? actionId;
}

/** 핵심 동작의 별칭 대상(예 A+/A− 플러그인 버튼) 집합 — 설정 "플러그인 동작"에서 중복 노출을 막는다. */
const ALIASED_TARGETS = new Set(Object.values(DISPATCH_TARGETS));

/**
 * 이 플러그인 버튼 `data-action`이 이미 핵심 동작(확대/축소)으로 노출되는지. 설정의 "플러그인 동작"
 * 섹션이 중복 행(A+/A−가 글자 확대/축소와 겹침)을 숨길 때 쓴다.
 */
export function isCoreAliasTarget(dataAction: string): boolean {
  return ALIASED_TARGETS.has(dataAction);
}

/** 카탈로그의 기본 바인딩만 모은 맵(id→accel) — 저장된 설정이 아예 없을 때의 시드값. */
export function defaultKeybindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of SHORTCUT_ACTIONS) {
    if (a.defaultAccel) out[a.id] = a.defaultAccel;
  }
  return out;
}

/**
 * 실제 적용할 바인딩 맵을 낸다. 저장된 값이 있으면(빈 맵이라도) 그것이 권위 — 사용자가 명시적으로
 * 지운 것을 존중한다. 저장 필드 자체가 없던(undefined) 최초 상태면 기본 바인딩을 시드한다.
 */
export function effectiveKeybindings(
  saved: Record<string, string> | undefined,
): Record<string, string> {
  return saved ?? defaultKeybindings();
}
