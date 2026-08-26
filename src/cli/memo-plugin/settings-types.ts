/**
 * memo-plugin CLI — 매니페스트 `settings` 스키마에서 `settings.d.ts`를 유도한다.
 *
 * 역할: `manifest.json`의 `settings[]`(7종 위젯 어휘 — text/textarea/toggle/select/
 * list/number/button)를 읽어, `memo.settings.get(key)`/`getAll()`이 그 키에 대해 실제로
 * 돌려주는 타입과 **정확히 같은** TypeScript 인터페이스를 만든다.
 *
 * 왜 손으로 안 쓰나: 매니페스트의 설정 키와 `main.js` 안의 문자열 키를 저작자가 손으로
 * 맞춰야 하는 것이 문제 그 자체다(절). 타입을
 * 매니페스트에서 **유도**해야만 둘이 어긋날 수 없다 — 이 파일이 갈라지면 그건 이 함수의
 * 버그이지 저작자의 오타가 아니다.
 *
 * 정본은 언제나 `manifest.json`이다. 이 모듈은 이미 `parseManifest`(manifest.ts)가
 * 구조적으로 검증한 뒤의 `settings` 배열만 받는다 — 형식 검증을 다시 하지 않는다(그건
 * validate.ts가 실물 검증기로 이미 한 일이다). 타입은 `src/shared/tauri.ts`의
 * `PluginSettingField`를 **타입 전용으로만** 참조한다 — 런타임 의존을 들이지 않는다(그
 * 파일은 `@tauri-apps/api`를 임포트하므로 값으로 끌어오면 CLI가 앱 런타임에 묶인다).
 */
import type {
  PluginSettingField,
  PluginSettingOption,
} from "../../shared/tauri.ts";

/**
 * 생성된 `settings.d.ts` 헤더가 저작자에게 "그대로 베껴 쓰라"고 싣는 참조 스니펫(main.js용, JS).
 *
 * 왜 상수인가, 왜 이 이상한 이중 캐스트인가: `memo.settings.getAll()`은 계약상
 * `Promise<Record<string, unknown>>`를 돌려준다(모든 플러그인 공통이라 키를 알 수 없다).
 * `Record<string, unknown>`은 `PluginSettings`에 **대입되지 않고**(TS2739), 단일 캐스트도
 * 안 된다(TS2352 — tsc 스스로 "unknown을 먼저 거치라"고 안내한다). checkJs에서 실제로
 * 컴파일되면서 좁히기까지 되는 형태는 `unknown`을 거치는 이 이중 캐스트뿐이다. 헤더에 실은
 * 예시가 컴파일되지 않으면 이 문서는 자기 사용례에서 고장 난 것이라, 저작자는 주석을 지우고
 * 좁히기(오타 검출)를 통째로 잃는다 — 그래서 이 문자열이 실제로 tsc(checkJs)를 통과하는지
 * `settings-types.test.ts`가 이 상수 그대로 컴파일해 확인한다(생성기·문서·예제가 한 출처를
 * 공유해 다시 갈라지지 않는다).
 */
export const SETTINGS_USAGE_SNIPPET = `memo.settings.getAll().then(function (cfg) {
  // getAll()은 Record<string, unknown>을 주므로 unknown을 거쳐 이 플러그인 설정 타입으로 좁힌다.
  var s = /** @type {import("./settings.d.ts").PluginSettings} */ (/** @type {unknown} */ (cfg));
  // 이제 s.<키>는 타입이 잡혀 편집기가 오타(cfg.greetng)·리터럴 오타(style === "casaul")를 잡는다.
});`;

/** JSDoc 블록 코멘트 안에 안전하게 넣을 수 있도록 다듬는다 — 저작자가 라벨·설명에 코멘트
 * 닫힘 기호(별표+슬래시)를 그대로 적으면 주석이 거기서 끊겨 뒤 텍스트가 코드로 해석된다.
 * 줄바꿈도 한 줄로 접는다(라벨·설명은 UI에서 한 줄로 쓰이는 값이라 여러 줄일 이유가 없다). */
function toDocComment(text: string): string {
  return text
    .replace(/\*\//g, "*\\/")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

/** `select` 옵션 하나에서 저장 값(`value`)을 뽑는다 — 문자열 축약형은 그 문자열 자체가
 * value다(manifest.ts의 재해석 규칙과 동일). */
function optionValue(o: string | PluginSettingOption): string {
  return typeof o === "string" ? o : o.value;
}

/** `memo.settings.get`/`getAll`이 이 필드에 대해 실제로 돌려주는 TS 타입 텍스트.
 * host.ts의 정규화 규칙(선언 코멘트 참고)과 1:1로 맞춰야 한다: list→`{name,body}[]`,
 * select→`value` 리터럴 유니온(라벨이 아니다), number→number, toggle→boolean,
 * text/textarea→string. `button`은 값을 저장하지 않아 호출자가 이 함수를 부르지 않는다
 * (아래 `generateSettingsDts`가 그 전에 걸러낸다). */
function tsTypeFor(field: PluginSettingField): string {
  switch (field.type) {
    case "text":
    case "textarea":
      return "string";
    case "toggle":
      return "boolean";
    case "number":
      return "number";
    case "list":
      // 전역 앰비언트 `MemoSettingListItem`(plugin-api.d.ts)을 참조하지 않고 그대로 편다 —
      // settings.d.ts는 독립 모듈이라(export가 있어 모듈이 된다) 그 전역이 반드시 보인다는
      // 보장이 없다(plugin-api.d.ts를 안 복사한 저작자도 있을 수 있다).
      return "{ name: string; body: string }[]";
    case "select": {
      const values = field.options.map(optionValue);
      return values.length > 0
        ? [...new Set(values)].map((v) => JSON.stringify(v)).join(" | ")
        : "string";
    }
    case "button":
      // 호출되지 않는다(generateSettingsDts가 button을 미리 거른다) — 스위치를 닫아 두는
      // 목적으로만 남긴다.
      return "never";
    default:
      // 알려진 7종 밖의 값이 여기 오면 그건 validate가 먼저 거부했어야 할 매니페스트다.
      // 코드생성이 조용히 잘못된 타입을 내지 않도록 원인 텍스트를 그대로 싣는다.
      return `unknown /* 알 수 없는 설정 type: ${JSON.stringify((field as { type?: unknown }).type)} */`;
  }
}

/** 필드 하나의 doc 코멘트 본문 — 라벨 + (있으면) 설명 + (number면) 범위. */
function fieldDoc(field: PluginSettingField): string {
  let doc = field.label;
  if (field.description) doc += ` — ${field.description}`;
  if (
    field.type === "number" &&
    (field.min !== undefined || field.max !== undefined)
  ) {
    const min = field.min ?? "-∞";
    const max = field.max ?? "∞";
    doc += ` (${min}~${max})`;
  }
  return toDocComment(doc);
}

/**
 * `settings[]`에서 `settings.d.ts` 파일 내용을 생성한다.
 *
 * `type: "button"` 필드는 뺀다 — 값을 저장하지 않으므로(누르면 명령이 돌 뿐)
 * `settings.get`으로 읽을 값 자체가 없다(manifest.ts·Rust `resolve_settings`와 같은 규칙).
 * 그 결과 필드가 하나도 안 남으면(전부 button, 또는 settings 자체가 없음) 호출자는 이
 * 함수를 부르지 않아야 한다(빈 인터페이스는 만들 값어치가 없다) — `hasTypedFields`로 미리
 * 판단하게 한다.
 */
export function hasTypedSettingsFields(
  fields: readonly PluginSettingField[],
): boolean {
  return fields.some((f) => f.type !== "button");
}

export function generateSettingsDts(
  fields: readonly PluginSettingField[],
): string {
  const usable = fields.filter((f) => f.type !== "button");
  const lines: string[] = [
    "// memo-plugin types가 manifest.json의 settings 스키마에서 생성했다 — 손으로 고치지 마라.",
    "// 정본은 manifest.json이다. 스키마를 바꾼 뒤에는 다시 생성한다:",
    "//   npm run plugin -- types <이 폴더>",
    "//",
    "// main.js에서 이렇게 참조한다(VS Code 등 TS 언어 서버가 붙는 편집기에서 자동완성·오타 검출):",
    // 참조 스니펫은 상수 하나(SETTINGS_USAGE_SNIPPET)에서 온다 — 테스트가 그 상수를 그대로
    // 컴파일해 "헤더에 실린 예시가 실제로 tsc를 통과한다"를 못박는다(자기모순 방지).
    ...SETTINGS_USAGE_SNIPPET.split("\n").map((l) => (l ? `//   ${l}` : "//")),
    "",
    "/** 이 플러그인의 설정 값 맵 — `memo.settings.getAll()`의 반환을 이 타입으로 좁혀 쓴다.",
    ' *  개별 키는 `memo.settings.get({ key: "..." })`의 반환과 같은 타입이다.',
  ];
  if (fields.length !== usable.length) {
    lines.push(
      ' *  `type: "button"` 필드는 값을 저장하지 않아(누르면 명령이 돌 뿐) 여기 없다.',
    );
  }
  lines.push(" */");
  lines.push("export interface PluginSettings {");
  for (const field of usable) {
    lines.push(`  /** ${fieldDoc(field)} */`);
    lines.push(`  ${field.key}: ${tsTypeFor(field)};`);
  }
  lines.push("}");
  lines.push("");
  lines.push(
    "/** 설정 키 이름의 닫힌 유니온 — `memo.settings.get({ key })`의 key 자동완성·오타 검출용. */",
  );
  lines.push("export type PluginSettingKey = keyof PluginSettings;");
  lines.push("");
  return lines.join("\n");
}
