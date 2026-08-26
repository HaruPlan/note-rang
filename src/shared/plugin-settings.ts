/**
 * 플러그인 설정 값의 **경계 규칙**(순수 — IO·DOM 없음).
 *
 * 역할: 매니페스트 설정 스키마 하나를 기준으로 (1) 기본값을 정하고(Rust
 * `default_setting_value`와 같은 규칙), (2) 저장된 값을 스키마에 맞게 정규화하며(숫자 강제·
 * 타입별 좁히기), (3) 플러그인이 보는 **구조화 값**(list → 배열)과 디스크에 저장하는
 * **직렬화 값**(list → 블롭 문자열)을 서로 변환한다.
 * 왜: 지금까지 이 규칙이 세 곳에 흩어져 있었다 — Rust `resolve_settings`(설치 경로만),
 * 설정 창의 `parseListBlob`(UI만), 그리고 **플러그인 main.js**(직렬화 포맷 역파싱). 호스트가
 * 직렬화한 것을 플러그인이 역직렬화하게 만드는 설계 자체가 결함이라, 변환을 이 한 모듈로 모으고
 * 양쪽(중앙 호스트·설정 창)이 같은 함수를 쓰게 한다.
 *
 * 이 모듈은 `src/shared/`에 둔다 — 설정 창(UI)과 플러그인 중앙 호스트(런타임)가 둘 다 쓰는
 * 공용 로직이고, 어느 쪽에도 종속되지 않는다(STYLE.md의 "공통 로직은 src/shared/로 추출").
 */
import type { PluginSettingField, PluginSettingOption } from "./tauri";

/**
 * `list` 설정 항목 하나(이름 + 본문).
 *
 * 디스크에는 `=== 이름 ===\n<본문>` 블롭 문자열로 저장되지만, 플러그인과 설정 UI는 항상 이
 * 구조로 다룬다 — 직렬화 포맷은 호스트 소유다.
 */
export interface SettingListItem {
  name: string;
  body: string;
}

/** `list` 항목의 자동 이름(헤더 없는 본문 · 이름이 빈 항목에 붙는다). */
const UNNAMED_LIST_ITEM = "템플릿";

/**
 * `select` 옵션을 항상 `{ value, label }` 객체형으로 정규화한다(순수).
 *
 * 역할: 매니페스트가 `["커서 위치", ...]`(축약형)로 적었든
 * `[{ value: "cursor", label: "커서 위치" }]`(정본)로 적었든 한 형태로 좁힌다.
 * 왜: 축약형은 `{ value: s, label: s }`의 줄임이라는 재해석이라 **기존 매니페스트가 무변경으로
 * 계속 유효**하다((A)안). 저장 값은 언제나 `value`, 표시는 언제나 `label`이다 — 라벨을
 * 다듬는 순간 저장된 값이 고아가 되던 문제를 없앤다.
 */
export function settingOptions(
  field: Pick<PluginSettingField, "options">,
): { value: string; label: string; description?: string }[] {
  const raw: (string | PluginSettingOption)[] = field.options ?? [];
  return raw.map((opt) =>
    typeof opt === "string"
      ? { value: opt, label: opt }
      : {
          value: String(opt.value ?? ""),
          label: String(opt.label ?? opt.value ?? ""),
          ...(opt.description ? { description: opt.description } : {}),
        },
  );
}

/**
 * 리스트 블롭(`=== 이름 ===\n<본문>`)을 항목들로 파싱한다(순수).
 *
 * 헤더 없는 선행 내용은 [`UNNAMED_LIST_ITEM`] 한 항목으로, 앞뒤 빈 줄은 제거한다. 왕복
 * (parse→serialize→parse) 안정성을 위해 규칙을 정확히 맞춘다.
 * 왜: 이 규칙은 원래 설정 창(`buildListEditor`)과 번들 `template/main.js`에 **각각 복제**돼
 * 있었다(같은 정규식·같은 무헤더 폴백 40줄). 정본을 여기 하나로 모은다.
 */
export function parseListBlob(blob: unknown): SettingListItem[] {
  const lines = (typeof blob === "string" ? blob : "").split("\n");
  const headerRe = /^===\s*(.+?)\s*===\s*$/;
  const chunks: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      if (cur) chunks.push(cur);
      cur = { name: m[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { name: UNNAMED_LIST_ITEM, lines: [line] };
    }
  }
  if (cur) chunks.push(cur);
  const out: SettingListItem[] = [];
  for (const c of chunks) {
    const a = c.lines.slice();
    while (a.length && a[0].trim() === "") a.shift();
    while (a.length && a[a.length - 1].trim() === "") a.pop();
    const body = a.join("\n");
    // 이름 있는 항목은 빈 본문이어도 유지, 무헤더 자동 이름은 빈 본문이면 버린다.
    if (body.length > 0 || c.name !== UNNAMED_LIST_ITEM) {
      out.push({ name: c.name, body });
    }
  }
  return out;
}

/**
 * 항목 이름을 정규화한다 — `=` 제거 + trim, 비면 [`UNNAMED_LIST_ITEM`].
 *
 * 왜: 이름에 `=`가 들어가면 헤더 문법(`=== 이름 ===`)과 충돌해 다음 파싱에서 항목이 쪼개진다.
 * 이 방어는 **호스트가 한다** — 예전에는 플러그인(`template/main.js`)이 같은 우회
 * (`raw.split("=").join("")`)를 스스로 들고 있었다.
 */
export function sanitizeListName(name: string): string {
  const n = name
    .split("=")
    .join("")
    .replace(/^\s+|\s+$/g, "");
  return n === "" ? UNNAMED_LIST_ITEM : n;
}

/** 항목들을 블롭 문자열로 직렬화한다(순수) — [`parseListBlob`]의 역함수. */
export function serializeListBlob(items: SettingListItem[]): string {
  return items
    .map((it) => "=== " + sanitizeListName(it.name) + " ===\n" + it.body)
    .join("\n\n");
}

/**
 * 알 수 없는 입력을 [`SettingListItem`] 배열로 좁힌다(항목 아닌 것은 버린다).
 *
 * 왜: 플러그인이 `settings.set`에 넘긴 배열은 신뢰 경계 밖이다 — 문자열 두 개가 아닌 항목이
 * 섞이면 직렬화가 `undefined` 같은 쓰레기를 디스크에 남긴다.
 */
function coerceListItems(value: unknown): SettingListItem[] {
  if (!Array.isArray(value)) return [];
  const out: SettingListItem[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as { name?: unknown; body?: unknown };
    out.push({ name: String(o.name ?? ""), body: String(o.body ?? "") });
  }
  return out;
}

/**
 * 숫자 설정의 값을 정규화한다 — 유한수로 강제하고 `min`/`max`로 클램프한다.
 *
 * 왜: 값이 폼(문자열 input)·플러그인·저장 파일 세 경로로 들어오는데, `type: "number"`의 계약은
 * "플러그인은 언제나 number를 받는다"이다. 숫자로 못 읽으면 기본값으로 되돌린다(NaN을
 * 플러그인에 흘리면 그 자리에서가 아니라 한참 뒤 계산에서 터진다).
 */
function coerceNumber(
  field: PluginSettingField,
  value: unknown,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(String(value ?? ""));
  let out = Number.isFinite(n) ? n : fallback;
  if (typeof field.min === "number" && out < field.min) out = field.min;
  if (typeof field.max === "number" && out > field.max) out = field.max;
  return out;
}

/**
 * 필드의 기본값을 정한다 — `default` 선언이 있으면 그것, 없으면 타입별 기본.
 *
 * Rust `default_setting_value`(plugins.rs)와 **같은 규칙**이다(설치 경로는 Rust가, 번들 경로는
 * 이 함수가 채운다 — 두 경로가 같은 값을 봐야 한다). 드리프트는 대조 테스트가 잡는다.
 */
export function settingDefault(field: PluginSettingField): unknown {
  if (field.default !== undefined && field.default !== null) {
    return normalizeSettingValue(field, field.default);
  }
  if (field.type === "toggle") return false;
  if (field.type === "number") return coerceNumber(field, 0, 0);
  if (field.type === "select") return settingOptions(field)[0]?.value ?? "";
  return ""; // text/textarea/list — list는 빈 블롭.
}

/**
 * 저장된 값 하나를 스키마에 맞는 **저장 형태**로 정규화한다.
 *
 * 역할: toggle→boolean, number→유한수(클램프), list→블롭 문자열, 나머지(text/textarea/
 * select)→문자열. `select`는 저장된 값을 **그대로** 문자열로 둔다(값이 곧 저장 형태다) —
 * 라벨→값 마이그레이션은 제거했다(출시 전이라 저장값=라벨인 옛 데이터가 존재하지 않는다).
 * 옵션 목록 밖 값이라도 버리지 않고 그대로 두는 것은 데이터 보호를 위함이다(스키마가 잠시
 * 어긋난 개발 중 상황에서 사용자 선택이 초기화되는 편이 더 나쁘다).
 */
export function normalizeSettingValue(
  field: PluginSettingField,
  value: unknown,
): unknown {
  if (field.type === "toggle") return value === true;
  if (field.type === "number") {
    const base =
      typeof field.default === "number" ? field.default : (field.min ?? 0);
    return coerceNumber(field, value, base);
  }
  if (field.type === "list") {
    // 배열로 들어오면 블롭으로 굳힌다(디스크 형식은 언제나 문자열 하나 — 단일 정본).
    return Array.isArray(value)
      ? serializeListBlob(coerceListItems(value))
      : typeof value === "string"
        ? value
        : "";
  }
  return value == null ? "" : String(value);
}

/**
 * 저장된 값 맵을 스키마로 병합·정규화한다 — **선언된 모든 키가 유효한 값을 갖는** 스냅샷.
 *
 * 역할: 선언 키 중 없는 것은 기본값으로 채우고, 있는 것은 [`normalizeSettingValue`]로
 * 정규화한다. Rust `resolve_settings`와 같은 규칙이되 **한 가지가 다르다**: 선언되지 않은
 * 저장 키를 버리지 않고 그대로 남긴다.
 * 왜 안 버리는가: 설치 경로는 Rust가 이미 선언 키로 좁혀 주므로 여기서 또 좁힐 필요가 없고,
 * 번들 경로는 백엔드가 **키 형식만** 검사해 저장하므로 여기서 좁히면 매니페스트에 아직
 * 안 올라온 값을 소리 없이 잃는다(설정 값 손실은 되돌릴 수 없다 — 좁히기의 이득보다 크다).
 * 형태를 모르는 값이라 정규화도 하지 않고 원본 그대로 통과시킨다.
 *
 * 왜 이 함수가 필요한가: 지금까지 **번들 경로에는 기본값 병합이 아예 없었다** — 사용자가 설정
 * 폼을 한 번도 안 열면 `memo.settings.get({ key: "x" })`가 null이라, 번들 플러그인들이 기본값을
 * 매니페스트와 main.js **두 곳에** 하드코딩하고 있었다. 이제 매니페스트 `default`가
 * 런타임에 실제로 도달한다.
 */
export function mergeSettingDefaults(
  schema: PluginSettingField[],
  saved: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  // 프로토타입 없는 객체 — 신뢰 경계를 넘어온 `__proto__` 키가 프로토타입을 오염시키지 못하게.
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(saved ?? {})) {
    if (key === "__proto__") continue;
    out[key] = value;
  }
  for (const field of schema) {
    // button은 **값이 없는 필드**다 — 누르는 것이 전부라 저장할 것도 플러그인이 읽을
    // 것도 없다. 여기서 빈 문자열을 채우면 (a) 아무도 안 읽는 키가 상태 파일에 쌓이고
    // (b) `settings.get({ key: "clearCache" })`가 null이 아니라 ""를 돌려줘 저작자가 "값이 있는
    // 설정"으로 착각한다. Rust `resolve_settings`도 같은 규칙으로 건너뛴다.
    if (field.type === "button") continue;
    const raw = saved?.[field.key];
    out[field.key] =
      raw === undefined
        ? settingDefault(field)
        : normalizeSettingValue(field, raw);
  }
  return out;
}

/**
 * 저장 형태의 값을 **플러그인이 보는 형태**로 바꾼다(경계 변환).
 *
 * 역할: `list`는 `{ name, body }[]` 배열로 파싱해 넘긴다 — 호스트가 직렬화한 것을 플러그인이
 * 역직렬화하는 일이 없어진다. 그 외 타입은 그대로다. `list`는 **항상** 구조화 배열로 나간다
 * (저장 블롭을 그대로 받는 `raw` 탈출구는 제거했다 — 엄격).
 * 스키마에 없는 키(`field`가 undefined)는 변환하지 않는다 — 무엇인지 모르는 값은 안 건드린다.
 */
export function toPluginSettingValue(
  field: PluginSettingField | undefined,
  stored: unknown,
): unknown {
  if (!field || field.type !== "list") return stored;
  return parseListBlob(stored);
}

/**
 * 플러그인이 넘긴 값을 **저장 형태**로 바꾼다([`toPluginSettingValue`]의 역방향).
 *
 * 역할: `list`에 배열이 오면 호스트가 직렬화하고, 문자열이 오면 블롭 그대로 받는다(구 플러그인
 * 호환). 그 외 타입은 [`normalizeSettingValue`]로 정규화한다.
 * 왜: 직렬화를 호스트가 소유하면 플러그인은 헤더 문법 충돌(`=== 이름 ===`)을 방어할 이유가
 * 사라진다 — 이름 살균도 호스트가 한다.
 */
export function fromPluginSettingValue(
  field: PluginSettingField | undefined,
  given: unknown,
): unknown {
  if (!field) return given; // 선언되지 않은 키 — 형태를 모르므로 그대로 둔다.
  return normalizeSettingValue(field, given);
}
