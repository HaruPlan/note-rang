/**
 * 키 가속기(단축키) 유틸 — 순수 함수만(테스트 가능, Tauri/DOM 부수효과 없음).
 *
 * 역할: KeyboardEvent → 정규화 가속기 문자열, 사람이 읽는 라벨, 수식키 검사, 충돌 검사.
 * 두 표기를 다룬다:
 *  - **창 단위**(노트 도구 단축키): `Mod`(=mac ⌘/그 외 Ctrl) 기반 이식성 있는 표기. 예 `"Alt+Equal"`, `"Mod+Shift+KeyP"`.
 *  - **전역**(새 노트 OS 단축키): `tauri_plugin_global_shortcut` 파서가 받는 표기. 예 `"Super+Shift+KeyN"`.
 * 왜: 메인 키를 `event.code`(물리 키)로 표기해 macOS에서 Option이 문자를 바꾸는 문제
 * (Alt+= → "≠")를 피하고, 글로벌 파서(W3C Code 이름 수용)와도 그대로 호환한다.
 */

/** 단독으로 눌렸을 때 "메인 키 없음"으로 볼 수식키 `event.code` 집합. */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** 창 단위 수식키 토큰(라벨·충돌 검사에서 수식키로 인식). */
const WINDOW_MODIFIER_TOKENS = new Set(["Mod", "Meta", "Ctrl", "Alt", "Shift"]);

/** 전역 표기 수식키 토큰(창 단위와 함께 라벨·검사에서 인식). */
const TAURI_MODIFIER_TOKENS = new Set([
  "Super",
  "Command",
  "Cmd",
  "CmdOrCtrl",
  "CommandOrControl",
  "Control",
]);

/**
 * KeyboardEvent에서 눌린 메인 키의 `event.code`를 얻는다(수식키 단독이면 null).
 * 빈 code(일부 IME/합성)도 메인 키 없음으로 본다.
 */
function mainKeyCode(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  return e.code;
}

/**
 * KeyboardEvent → 창 단위 정규화 가속기(수식키 없거나 메인 키 없으면 null 아님 —
 * 메인 키만 없으면 null). `Mod` = mac ⌘ / 그 외 Ctrl(CodeMirror 관례와 일치, 동기화 이식성).
 * 수식키 유무는 호출부가 `hasModifier`로 강제한다(수식키 없는 바인딩 거부).
 */
export function eventToAccel(e: KeyboardEvent, isMac: boolean): string | null {
  const key = mainKeyCode(e);
  if (!key) return null;
  const mods: string[] = [];
  const primary = isMac ? e.metaKey : e.ctrlKey; // Mod
  const secondary = isMac ? e.ctrlKey : e.metaKey; // Ctrl(mac) / Meta(그 외)
  if (primary) mods.push("Mod");
  if (secondary) mods.push(isMac ? "Ctrl" : "Meta");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

/**
 * KeyboardEvent → 전역(Tauri) 가속기(수식키 단독이면 null). 실제 눌린 물리 수식키를 그대로
 * 표기한다(metaKey→Super, ctrlKey→Control, altKey→Alt, shiftKey→Shift) + 메인 키는 `event.code`.
 * global-hotkey 파서가 `SUPER/CONTROL/ALT/SHIFT`와 W3C Code 이름을 수용한다.
 */
export function eventToTauriAccel(e: KeyboardEvent): string | null {
  const key = mainKeyCode(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (mods.length === 0) return null; // 전역 단축키는 수식키 필수(단독 키 등록 방지).
  return [...mods, key].join("+");
}

/** 가속기에 수식키가 하나라도 있으면 true(창 단위 바인딩 유효성). */
export function hasModifier(accel: string): boolean {
  return accel
    .split("+")
    .some((t) => WINDOW_MODIFIER_TOKENS.has(t) || TAURI_MODIFIER_TOKENS.has(t));
}

/** 수식키 토큰 → 표시 라벨(mac 글리프 / 그 외 텍스트). */
function modifierLabel(token: string, isMac: boolean): string | null {
  switch (token) {
    case "Mod":
      return isMac ? "⌘" : "Ctrl";
    // Tauri 전역 가속기의 "이 OS의 주 수식키" 토큰 — 이름 그대로 mac은 ⌘, 그 외는 Ctrl이다
    // (`Super`/`Command`와 갈라 두는 이유: 예전엔 한 묶음이라 非mac에서 "Win"으로 그려져,
    // 기본 전역 단축키 `CmdOrCtrl+Shift+N`이 Windows 설정 화면과 안내에 **있지도 않은**
    // `Win+Shift+N`으로 보였다).
    case "CmdOrCtrl":
    case "CommandOrControl":
      return isMac ? "⌘" : "Ctrl";
    case "Super":
    case "Command":
    case "Cmd":
      return isMac ? "⌘" : "Win";
    case "Meta":
      return isMac ? "⌘" : "Meta";
    case "Ctrl":
    case "Control":
      return isMac ? "⌃" : "Ctrl";
    case "Alt":
      return isMac ? "⌥" : "Alt";
    case "Shift":
      return isMac ? "⇧" : "Shift";
    default:
      return null;
  }
}

/** 자주 쓰는 `event.code` → 사람이 읽는 키 라벨. */
const KEY_LABELS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** 메인 키 `event.code` → 표시 라벨(Key·Digit 접두 제거, 특수키는 표에서). */
function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num${code.slice(6)}`;
  return code;
}

/**
 * 가속기 문자열 → 사람이 읽는 라벨. mac은 글리프를 붙여서(`⌥=`, `⌘⇧P`), 그 외는 `+`로
 * 잇는다(`Alt+=`, `Ctrl+Shift+P`). 창 단위·전역 표기 모두 처리한다.
 */
export function formatAccelLabel(accel: string, isMac: boolean): string {
  if (!accel) return "";
  const tokens = accel.split("+");
  const parts = tokens.map((t, i) =>
    i === tokens.length - 1 ? keyLabel(t) : (modifierLabel(t, isMac) ?? t),
  );
  return isMac ? parts.join("") : parts.join("+");
}

/**
 * 눌린 이벤트에 바인딩된 동작 id를 찾는다(없으면 null). 창 단위 표기(`eventToAccel`)로 정규화해
 * 바인딩 맵(id→accel)을 역방향 조회한다. 빈 accel은 무시. 노트 창 키맵 디스패치의 순수 코어.
 */
export function resolveShortcut(
  bindings: Record<string, string>,
  e: KeyboardEvent,
  isMac: boolean,
): string | null {
  const accel = eventToAccel(e, isMac);
  if (!accel) return null;
  for (const [id, bound] of Object.entries(bindings)) {
    if (bound && bound === accel) return id;
  }
  return null;
}

/**
 * 바인딩 맵(id→accel)에서 같은 가속기를 2개 이상 동작이 공유하는 충돌을 찾는다.
 * 빈 값은 무시. 반환: `accel → [충돌 동작 id들]`(2개 이상인 것만).
 */
export function findConflicts(
  bindings: Record<string, string>,
): Record<string, string[]> {
  const byAccel: Record<string, string[]> = {};
  for (const [id, accel] of Object.entries(bindings)) {
    if (!accel) continue;
    (byAccel[accel] ??= []).push(id);
  }
  const conflicts: Record<string, string[]> = {};
  for (const [accel, ids] of Object.entries(byAccel)) {
    if (ids.length > 1) conflicts[accel] = ids;
  }
  return conflicts;
}
