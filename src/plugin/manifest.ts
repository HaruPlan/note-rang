/**
 * 플러그인 매니페스트 모델 + 검증.
 *
 * 역할: 신뢰할 수 없는 manifest.json을 구조적으로 검증해 PluginManifest로 만든다
 * (필수 필드·타입·id 형식·알려진 권한·설정 스키마·버전/종류 계약 필드). 실패는 사유와 함께
 * 거부한다.
 * 왜: 형식 오류·미지의 권한을 가진 매니페스트를 로드 전에 차단한다.
 *
 * 단일 JSON Schema: 이 파일이 검증하는 필드 전수는 `docs/plugin/manifest.schema.json`이
 * 정본이다 — 필드를 추가/변경할 때는 스키마도 함께 갱신한다. Rust 쪽 동형 검증기는
 * `src-tauri/src/plugins.rs`의 `parse_manifest`(같은 스키마를 따름, 대칭 테스트는
 * `manifest.test.ts`/`plugins.rs`의 테스트 양쪽에 동일 fixture로 존재).
 */
import { isKnownPermission } from "./permissions";
import type { InstalledPlugin, PluginSettingField } from "../shared/tauri";

/** 매니페스트 `kind` — 능력 등록 가능 여부. 능력 등록은 `"capability"`를 명시적으로
 * 요구한다(미선언·`"action"`이면 게이트키퍼가 능력 등록을 거부 — 엄격). */
export type PluginKind = "capability" | "action";

/**
 * 선언형 기여 종류 → 그것이 대신하는 브리지 호출.
 *
 * 역할: 매니페스트의 데이터 한 덩어리를 "저작자가 `main.js`에서 불렀을 호출"로 되돌린다.
 * 호스트는 이 호출명으로 **게이트키퍼(권한·kind)와 registrar(형식 검증)를 그대로 태우고**,
 * CLI도 같은 표를 읽어 설치 전에 같은 검증을 돌린다 — 선언형 경로가 명령형 경로와 다른
 * 규칙을 갖는 순간 "JSON으로는 되는데 JS로는 안 된다"가 생긴다.
 *
 * `windowControls`가 여기 있는 이유: 병합이 **등록 순서에 의존하지 않는다**(3값 닫힌
 * 열거형의 Union이라 매니페스트 항목이 몇 번째로 평가되는지가 결과를 바꾸지 않는다).
 * 배경(FirstWins)·폰트(스택 선착순)는 등록 순서가 결과를 바꾸므로 선언형으로 옮기지 않았다.
 *
 * **아는 기여 종류의 단일 출처는 이 표가 아니라 [`CONTRIBUTION_KINDS`]다.** 대응하는 브리지
 * 호출이 아예 없는 선언형 기여(언어팩)가 생겼기 때문이다 — 아래 참고.
 */
export const CONTRIBUTION_CALLS: Readonly<Record<string, string>> = {
  inlinePatterns: "editor.registerInlinePattern",
  completions: "editor.registerCompletion",
  blockEmbeds: "editor.registerBlockEmbed",
  windowControls: "window.register",
};

/**
 * **브리지 호출이 없는** 선언형 기여 종류 → 그 기여를 하려면 선언해야 하는 권한.
 *
 * 지금은 언어팩(`translations`) 하나다. 언어팩은 한때 `memo.i18n.register` 브리지가 나르는
 * 능력이었지만, 실체가 매니페스트에 적힌 **데이터**일 뿐이라 지금은 코어가 파일을 직접 읽는다
 * (번들 팩은 각 창의 `src/i18n/packs.ts`, 설치 팩은 Rust `plugin_i18n.rs`). 즉 플러그인
 * 샌드박스도, 그 결과를 나르는 호스트 스냅샷도 경로에서 빠졌다 — 브리지 왕복이 첫 페인트보다
 * 늦어 콜드 스타트에서 창을 1회 리로드시키던 것이 그 전환의 이유다.
 *
 * 그래도 **게이트는 사라지지 않았다**: 코어는 `contributes.translations`를 읽을 때
 * 활성·현재 OS 지원·`kind: "capability"`·여기 적힌 권한 선언의 네 조건을 그대로 요구한다
 * (`plugin_i18n.rs`의 `may_contribute_translations` — 옛 브리지 게이트와 동형). 이 표가
 * 있어야 CLI(`memo-plugin lint`)가 설치 전에 같은 게이트를 재현할 수 있다.
 */
export const CORE_CONTRIBUTION_PERMISSIONS: Readonly<Record<string, string>> = {
  translations: "i18n",
};

/**
 * 매니페스트가 선언할 수 있는 기여 종류 전부 — **아는 종류인지의 단일 출처**.
 *
 * 브리지로 되돌아가는 것([`CONTRIBUTION_CALLS`])과 코어가 직접 읽는 것
 * ([`CORE_CONTRIBUTION_PERMISSIONS`])의 합집합이다. 모르는 종류는 거부가 아니라
 * `unknownKinds`로 표면화되므로(전방 호환), 이 목록에서 빠진 종류는 **조용히 무시되는 것이
 * 아니라 오탐 경고를 받는다** — 언어팩을 여기 넣지 않으면 정상 언어팩이 매번 "모르는 기여
 * 종류"로 진단에 뜬다. Rust `plugins.rs`의 `CONTRIBUTION_KINDS`와 **같은 집합**이어야 한다
 * (한쪽만 알면 "CLI는 통과인데 설치가 거부된다"가 난다).
 */
export const CONTRIBUTION_KINDS: readonly string[] = [
  ...Object.keys(CONTRIBUTION_CALLS),
  ...Object.keys(CORE_CONTRIBUTION_PERMISSIONS),
];

/**
 * 검증을 통과한 `contributes` 블록 — **형태만** 확인한 원자료다.
 *
 * 왜 여기서 깊게 검증하지 않는가: 항목 하나하나의 규칙(패턴의 open/close, 임베드의 소스 룰
 * 개수 등)은 이미 `loader.ts`의 registrar가 소유하고 있고, 그 규칙을 여기 복사하면 두 벌이
 * 갈라진다. 매니페스트 파서는 "배열인가/객체인가"까지만 보고, 나머지는 호스트가 registrar로
 * 실제 등록해 보며 확인한다(실패는 진단 채널로 표면화).
 */
export interface PluginContributions {
  inlinePatterns?: Record<string, unknown>[];
  completions?: Record<string, unknown>[];
  blockEmbeds?: Record<string, unknown>[];
  /** 창 컨트롤 능력 id 목록(`window.register({controls})`와 같은 값). */
  windowControls?: string[];
  /** 언어팩 선언 항목 배열(`{locale,label,entries}` — 항목 내부 검증은 이것을 실제로 읽는
   * 코어(Rust `plugin_i18n.rs`의 `parse_translation`)가 한다, 여기서는 형태만 본다). */
  translations?: Record<string, unknown>[];
  /**
   * 이 빌드가 모르는 기여 종류 이름들(전방 호환으로 **무시**하되 버리지는 않는다).
   *
   * 왜 남기는가: `inlinePattern`(단수 오타)처럼 한 글자 틀린 이름은 조용히 아무것도 등록하지
   * 않는 완전한 무음 실패다. 매니페스트를 거부하면 구버전 앱이 신버전 플러그인을 통째로
   * 못 읽으므로(스키마의 전방 호환 정책), 거부 대신 **표면화**한다 — 호스트는 진단으로,
   * CLI(`memo-plugin validate`)는 오류로 올린다.
   */
  unknownKinds?: string[];
}

/** 검증된 플러그인 매니페스트. 새 필드는 전부 선택(옵셔널) — 없으면 기존 동작 그대로다
 * (하위호환: 이미 배포된 사이드로드 매니페스트는 새 필드를 모른 채로도 계속 유효하다). */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: string[];
  /** 지원 OS 목록(선택 — 없으면 전 플랫폼 지원). 미지원 OS에서는 자동 비활성화된다. */
  platforms?: string[];
  /** 목록 부제로 쓰는 한 줄 요약(선택 — 이전엔 Rust만 읽고 TS는 몰랐다). */
  summary?: string;
  /** 선언형 설정 스키마(선택 — 없으면 설정 UI 미노출). Rust `parse_settings_schema`와 동일 규칙. */
  settings?: PluginSettingField[];
  /** 설정 트리에서 이 플러그인 페이지를 묶을 카테고리(선택). */
  settingsCategory?: string;
  /** 설정 페이지 상단 소개 문구(선택). */
  settingsDescription?: string;
  /** 능력 등록(theme/background/font/window.register) 가능 여부. */
  kind?: PluginKind;
  /** 이 매니페스트가 요구하는 최소 memo 앱 버전(semver) — 설치 게이트용. */
  minHostVersion?: string;
  /** 이 플러그인이 하는 일 한 줄(80자 이내, 자기신고) — 승인 화면 상단 표시. */
  purpose?: string;
  /** 노출 능력·설정 키·예시 호출 요약 마크다운(2KB 이내, 자기신고). */
  llmContext?: string;
  /** 권한별 보조 설명(선택, 자기신고) — 고정 경고문 아래 병기. */
  permissionReasons?: Record<string, string>;
  /** JS 없이 매니페스트만으로 하는 선언형 등록([`PluginContributions`]). */
  contributes?: PluginContributions;
  /**
   * 다른 플러그인이 `memo.commands.invoke`로 부를 수 있게 **공개**할 명령 id 목록.
   *
   * 기본은 비공개다 — 여기 적지 않은 명령은 `invoke:<이 id>` 권한을 가진 호출측이라도
   * `INVOKE_NOT_EXPOSED`로 거부된다. 즉 호출은 **양쪽 동의**로만 성립한다: 호출측은
   * `invoke:<대상>`을 선언·승인받고, 대상은 그 명령을 `exposes`에 명시한다. 여기 적은 id는
   * `commands.register`로 실제 등록한 명령 id와 같아야 한다(공개했는데 등록 안 한 명령을
   * 부르면 `INVOKE_NO_TARGET`).
   */
  exposes?: string[];
  /**
   * 저작자 자기 로컬라이즈(축 2) — `%키%` 자리표시자가 가리키는 로케일별 사전.
   *
   * 형태: 로케일 코드(또는 특수 코드 `"default"`) → {키 → 문장}. `nls`를 선언하면 `"default"`
   * 사전이 **필수**다(%키%가 활성 로케일에 없을 때의 기본값 — i18n.md 폴백 철학과 같은 결).
   * 콘텐츠(각 문장)는 검증하지 않는다 — [`resolveNlsString`]이 소비 시점에 찾아 쓸 뿐, 여기서는
   * 형태(객체 중첩 · leaf가 문자열)만 확인한다. Rust `plugins.rs`의 `parse_nls`가 동형이다.
   */
  nls?: Record<string, Record<string, string>>;
}

/** 매니페스트 파싱 결과: 성공(manifest) 또는 실패(error). */
type ManifestResult =
  { ok: true; manifest: PluginManifest } | { ok: false; error: string };

/** 플러그인 id 허용 형식(소문자·숫자·`._-`; 첫 글자는 영숫자). */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 설정 키 허용 형식(Rust `is_valid_setting_key`와 동일: 비어있지 않고 영숫자·`_`만) +
 * JS 예약 키 거부(값 맵이 결국 JS 객체에 쓰이므로 `__proto__` 등은 프로토타입 오염 여지). */
const SETTING_KEY_RE = /^[A-Za-z0-9_]+$/;
const RESERVED_SETTING_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isValidSettingKey(key: string): boolean {
  return (
    key.length > 0 &&
    SETTING_KEY_RE.test(key) &&
    !RESERVED_SETTING_KEYS.has(key)
  );
}

/**
 * Rust `parse_settings_schema`가 인정하는 위젯 종류(초기 `number`, 이후 추가된 `button` — 7종).
 *
 * `button`만 값을 저장하지 않는 필드다(누르는 것이 전부다) — 그래서
 * `mergeSettingDefaults`·Rust `resolve_settings` 둘 다 이 타입의 키를 건너뛴다. 그 규칙이
 * 한쪽에만 있으면 저장 파일에 아무도 안 읽는 빈 문자열 키가 쌓인다.
 */
const VALID_SETTING_TYPES = new Set([
  "text",
  "textarea",
  "toggle",
  "select",
  "list",
  "number",
  "button",
]);

/**
 * `settings` 필드(알 수 없는 입력)를 검증해 [`PluginSettingField`] 목록으로 만든다.
 *
 * 역할: 배열 여부·각 필드(key 형식·label·type·select의 options·hints)를 Rust
 * `parse_settings_schema`와 동일 규칙으로 확인한다.
 * 왜: 지금까지 번들 설정 스키마는 어느 검증기도 통과하지 않았다(의 핵심 결함) — 이제
 * TS 경로(번들이 타는 경로)도 Rust와 같은 형태를 강제한다.
 */
function parseSettingsSchema(
  raw: unknown,
): { ok: true; fields: PluginSettingField[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, fields: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "settings가 배열이 아님" };
  }
  const fields: PluginSettingField[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `설정[${i}]: 항목이 객체가 아님` };
    }
    const f = item as Record<string, unknown>;
    const key = f.key;
    if (typeof key !== "string") {
      return { ok: false, error: `설정[${i}]: key 누락 또는 형식 오류` };
    }
    if (!isValidSettingKey(key)) {
      return { ok: false, error: `설정[${i}] key '${key}': key 형식 오류` };
    }
    const label = f.label;
    if (typeof label !== "string") {
      return {
        ok: false,
        error: `설정[${i}] key '${key}': label 누락 또는 형식 오류`,
      };
    }
    const type = f.type;
    if (typeof type !== "string" || !VALID_SETTING_TYPES.has(type)) {
      return {
        ok: false,
        error: `설정[${i}] key '${key}': 알 수 없는 type '${String(type)}'`,
      };
    }
    // options는 문자열 축약형과 `{value,label?,description?}` 객체형이 섞일 수 있다.
    // 축약형 `"라벨"`은 `{value:"라벨", label:"라벨"}`의 줄임으로 재해석하므로 기존 매니페스트는
    // 무변경으로 유효하다. Rust `parse_settings_schema`와 같은 규칙.
    let options: PluginSettingField["options"] = [];
    if (f.options !== undefined && f.options !== null) {
      if (!Array.isArray(f.options)) {
        return {
          ok: false,
          error: `설정[${i}] key '${key}': options가 배열이 아님`,
        };
      }
      for (const o of f.options) {
        if (typeof o === "string") continue;
        if (typeof o !== "object" || o === null || Array.isArray(o)) {
          return {
            ok: false,
            error: `설정[${i}] key '${key}': options 항목이 문자열도 객체도 아님`,
          };
        }
        if (typeof (o as { value?: unknown }).value !== "string") {
          return {
            ok: false,
            error: `설정[${i}] key '${key}': options 항목에 value가 없음`,
          };
        }
      }
      options = f.options as PluginSettingField["options"];
    }
    if (type === "select" && options.length === 0) {
      return {
        ok: false,
        error: `설정[${i}] key '${key}': select에 options가 필요함`,
      };
    }
    // button은 `command`가 없으면 **아무것도 하지 않는 버튼**이 폼에 뜬다 — 누르면 조용히
    // 아무 일도 안 일어나는 UI가 되므로 매니페스트 단계에서 거부한다(Rust도 같은 규칙).
    if (type === "button" && typeof f.command !== "string") {
      return {
        ok: false,
        error: `설정[${i}] key '${key}': button에 command(실행할 명령 id)가 필요함`,
      };
    }
    if (type === "button" && (f.command as string).trim() === "") {
      return {
        ok: false,
        error: `설정[${i}] key '${key}': button의 command가 비어 있음`,
      };
    }
    let hints: { token: string; label?: string }[] | undefined;
    if (f.hints !== undefined && f.hints !== null) {
      if (!Array.isArray(f.hints)) {
        return {
          ok: false,
          error: `설정[${i}] key '${key}': hints가 배열이 아님`,
        };
      }
      hints = [];
      for (const h of f.hints) {
        if (typeof h !== "object" || h === null) {
          return {
            ok: false,
            error: `설정[${i}] key '${key}': hints 항목이 객체가 아님`,
          };
        }
        const ho = h as Record<string, unknown>;
        if (typeof ho.token !== "string") {
          return {
            ok: false,
            error: `설정[${i}] key '${key}': hints token 누락 또는 형식 오류`,
          };
        }
        hints.push({
          token: ho.token,
          ...(typeof ho.label === "string" ? { label: ho.label } : {}),
        });
      }
    }
    const str = (k: string): string | undefined =>
      typeof f[k] === "string" ? (f[k] as string) : undefined;
    const num = (k: string): number | undefined =>
      typeof f[k] === "number" && Number.isFinite(f[k]) ? f[k] : undefined;
    fields.push({
      key,
      label,
      type: type as PluginSettingField["type"],
      options,
      ...(num("min") !== undefined ? { min: num("min") } : {}),
      ...(num("max") !== undefined ? { max: num("max") } : {}),
      ...(num("step") !== undefined ? { step: num("step") } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(str("description") !== undefined
        ? { description: str("description") }
        : {}),
      ...(str("placeholder") !== undefined
        ? { placeholder: str("placeholder") }
        : {}),
      ...(str("itemLabel") !== undefined
        ? { itemLabel: str("itemLabel") }
        : {}),
      ...(str("itemNamePlaceholder") !== undefined
        ? { itemNamePlaceholder: str("itemNamePlaceholder") }
        : {}),
      ...(str("itemBodyPlaceholder") !== undefined
        ? { itemBodyPlaceholder: str("itemBodyPlaceholder") }
        : {}),
      ...(hints !== undefined ? { hints } : {}),
      ...(str("command") !== undefined ? { command: str("command") } : {}),
      ...(str("confirm") !== undefined ? { confirm: str("confirm") } : {}),
    });
  }
  return { ok: true, fields };
}

/**
 * `contributes` 블록(알 수 없는 입력)을 검증해 [`PluginContributions`]로 만든다.
 *
 * 규칙: 아는 종류는 배열이어야 하고(항목은 객체, `windowControls`만 문자열), 모르는 종류는
 * 거부가 아니라 `unknownKinds`에 모아 호출부가 표면화한다. Rust `parse_contributes`와 같은
 * 규칙 — 한쪽만 거부하면 "CLI는 통과인데 설치가 거부된다"가 난다.
 */
function parseContributes(
  raw: unknown,
):
  | { ok: true; contributes?: PluginContributions }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "contributes가 객체가 아님" };
  }
  const out: PluginContributions = {};
  const unknownKinds: string[] = [];
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (!CONTRIBUTION_KINDS.includes(kind)) {
      unknownKinds.push(kind);
      continue;
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: `contributes.${kind}가 배열이 아님` };
    }
    if (kind === "windowControls") {
      if (value.some((v) => typeof v !== "string")) {
        return {
          ok: false,
          error: "contributes.windowControls 항목이 문자열이 아님",
        };
      }
      out.windowControls = value as string[];
      continue;
    }
    if (
      value.some((v) => typeof v !== "object" || v === null || Array.isArray(v))
    ) {
      return { ok: false, error: `contributes.${kind} 항목이 객체가 아님` };
    }
    // 나머지 아는 종류(inlinePatterns·completions·blockEmbeds·translations)는 전부 "객체 배열"
    // 이라는 같은 모양이라 한 줄로 받는다.
    (out as Record<string, unknown>)[kind] = value as Record<string, unknown>[];
  }
  if (unknownKinds.length > 0) out.unknownKinds = unknownKinds;
  return {
    ok: true,
    ...(Object.keys(out).length > 0 ? { contributes: out } : {}),
  };
}

/** minHostVersion/version처럼 "주.부.수로 시작"하는 형식인지(자유 형식 접미사는 허용). */
const SEMVER_PREFIX_RE = /^\d+\.\d+\.\d+/;

/**
 * 문자열의 길이를 **유니코드 코드포인트 수**로 잰다(`String.length`의 UTF-16 코드 유닛 아님).
 *
 * 왜: 같은 상한(purpose 80·llmContext 2000·permissionReasons 200)을 세 곳이 잰다 —
 * Rust `parse_manifest`는 `chars().count()`(스칼라), JSON Schema의 `maxLength`도 규격상
 * 코드포인트다. TS만 `.length`(UTF-16)를 쓰면 이모지·서로게이트 페어가 섞인 순간 판정이
 * 갈린다: `"가".repeat(79) + "🎨"`는 코드포인트 80(Rust·스키마 통과)인데 `.length` 81이라
 * TS만 거부한다. 그러면 CLI(`memo-plugin validate`)는 실패하는데 앱은 설치되고, 설치된 뒤
 * 로드 시점에 TS 검증이 그 플러그인만 조용히 떨궈 툴바 버튼·패턴이 통째로 사라진다.
 * 단위를 정본(스키마)에 맞춘다.
 */
function codePointLength(s: string): number {
  return [...s].length;
}

/**
 * `nls`(알 수 없는 입력)를 검증해 로케일→사전 맵으로 만든다(축 2 — 저작자 자기 로컬라이즈).
 *
 * 역할: 객체인지, 각 로케일 값이 객체인지, 그 leaf가 전부 문자열인지만 본다(콘텐츠 자체는
 * 검증하지 않는다 — `%키%`가 실제로 쓰이는지, 사전에 여분의 키가 있는지는 신경 쓰지 않는다.
 * 언어팩 `entries`와 달리 이 사전은 **이 플러그인 자신만** 쓰므로 다른 저작자의 사전과
 * 충돌할 여지가 없다). `nls`를 선언했다면 `"default"` 사전이 **필수**다 — 없으면 %키%가
 * 활성 로케일에 없을 때 기댈 곳이 없어 항상 원문 노출로 새는데, 그 상태를 매니페스트
 * 검증에서 미리 잡는다. Rust `parse_nls`(`plugins.rs`)와 같은 규칙.
 */
function parseNls(
  raw: unknown,
):
  | { ok: true; nls?: Record<string, Record<string, string>> }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "nls가 객체가 아님" };
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, dict] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof dict !== "object" || dict === null || Array.isArray(dict)) {
      return { ok: false, error: `nls['${locale}']가 객체가 아님` };
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      dict as Record<string, unknown>,
    )) {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `nls['${locale}']['${key}']가 문자열이 아님`,
        };
      }
      entries[key] = value;
    }
    out[locale] = entries;
  }
  if (!("default" in out)) {
    return { ok: false, error: "nls를 선언하면 'default' 사전이 필수" };
  }
  return { ok: true, nls: out };
}

/**
 * `%키%` 자리표시자 형식 — 시작·끝이 `%`이고 안쪽(키)이 `%`를 포함하지 않는 비어있지 않은
 * 문자열. `%`로 시작·끝나지 않는 일반 문자열은 애초에 이 정규식에 매치되지 않아 그대로
 * 통과한다(하위호환 100% — 기존 플러그인 문자열은 우연히 `%`를 포함해도 이 형식과 다르면
 * 무변화).
 */
const NLS_PLACEHOLDER_RE = /^%([^%]+)%$/;

/**
 * 문자열 하나를 `%키%` → 로케일 문장으로 해석한다(활성 로케일 사전 → `default` 사전 → 원문
 * 그대로, `docs/contributing/i18n.md`의 `t()` 폴백과 같은 계 — 다만 마지막 폴백이 "키
 * 문자열"이 아니라 "%키% 그대로"인 점만 다르다: 이 값은 **저작자가 이미 쓴 리터럴**이라
 * 잃어버릴 "키 이름"이 따로 없다).
 *
 * `nls`가 없으면(플러그인이 로컬라이즈에 참여하지 않음) `%`로 시작·끝나는 문자열이라도
 * 절대 건드리지 않는다 — nls 없는 기존 플러그인은 무조건 무변화여야 하기 때문이다(우연히
 * `%할인%` 같은 라벨을 쓴 플러그인이 nls 없이도 값이 사라지면 안 된다).
 */
export function resolveNlsString(
  value: string,
  nls: Record<string, Record<string, string>> | undefined,
  locale: string,
): string {
  if (!nls) return value;
  const m = NLS_PLACEHOLDER_RE.exec(value);
  if (!m) return value;
  const key = m[1];
  const active = nls[locale];
  if (active && typeof active[key] === "string") return active[key];
  const def = nls.default;
  if (def && typeof def[key] === "string") return def[key];
  return value; // 어느 사전에도 없음 — "%키%"를 그대로 노출해 누락을 가시화한다.
}

/**
 * 설정 필드 하나의 사용자 노출 문자열을 nls로 해석한다(label·description·placeholder·
 * itemLabel·itemNamePlaceholder·itemBodyPlaceholder·confirm·hints[].label·options[]의
 * label/description). **options의 `value`는 절대 건드리지 않는다** — 저장된 사용자 선택값의
 * 정체성이 `value`라, 로케일마다 값이 달라지면 이미 저장된 선택이 로케일 전환에 깨진다.
 * 이 비대칭 때문에 `options`의 **문자열 축약형**(`"라벨"` — value와 label이 같다)은 nls 대상이
 * 아니다: 축약형은 해석하면 저장 값 자체가 로케일에 따라 바뀌므로, 로케일화하려는 저작자는
 * `{value, label}` 정본형을 써야 한다(정본형의 `value`는 그대로 두고 `label`만 해석된다).
 *
 * export하는 이유(축 2 번들 적용): 설치 플러그인 전용이던 것을 번들에도 재사용한다 —
 * `plugin/builtin/index.ts`의 `resolveBuiltinPluginNls`가 같은 필드 집합을 같은 규칙으로
 * 해석해야 두 경로(설치·번들)가 어긋나지 않는다(정본 하나).
 */
export function resolveSettingFieldNls(
  field: PluginSettingField,
  nls: Record<string, Record<string, string>> | undefined,
  locale: string,
): PluginSettingField {
  if (!nls) return field;
  const r = (s: string): string => resolveNlsString(s, nls, locale);
  return {
    ...field,
    label: r(field.label),
    ...(field.description !== undefined
      ? { description: r(field.description) }
      : {}),
    ...(field.placeholder !== undefined
      ? { placeholder: r(field.placeholder) }
      : {}),
    ...(field.itemLabel !== undefined ? { itemLabel: r(field.itemLabel) } : {}),
    ...(field.itemNamePlaceholder !== undefined
      ? { itemNamePlaceholder: r(field.itemNamePlaceholder) }
      : {}),
    ...(field.itemBodyPlaceholder !== undefined
      ? { itemBodyPlaceholder: r(field.itemBodyPlaceholder) }
      : {}),
    ...(field.confirm !== undefined ? { confirm: r(field.confirm) } : {}),
    ...(field.hints
      ? {
          hints: field.hints.map((h) =>
            h.label !== undefined ? { ...h, label: r(h.label) } : h,
          ),
        }
      : {}),
    ...(field.options && field.options.length > 0
      ? {
          options: field.options.map((o) => {
            // 문자열 축약형은 의도적으로 건드리지 않는다(위 문서 참고 — value=label이라
            // 해석하면 저장 값 정체성이 로케일에 물든다).
            if (typeof o === "string") return o;
            return {
              ...o,
              ...(o.label !== undefined ? { label: r(o.label) } : {}),
              ...(o.description !== undefined
                ? { description: r(o.description) }
                : {}),
            };
          }),
        }
      : {}),
  };
}

/**
 * 설치(사이드로드) 플러그인 한 건(백엔드 `InstalledPlugin`)의 사용자 노출 문자열을 nls로
 * 해석한다(축 2 — 파싱 직후 한 번, 소비처는 `main.ts`의 `listPlugins` 배선).
 *
 * 대상 필드(실제로 화면에 렌더되는 것만 — `settings/settings.ts`를 rg로 확인): `name`
 * (목록·상세 이름) · `summary`(목록 부제) · `settings_category`(트리 그룹 — 다만 호스트가
 * 아는 9종 식별자와 일치하면 그 자리에서 `t()`로 다시 덮이므로 nls는 **커스텀 카테고리**에만
 * 실질적으로 영향을 준다) · `settings_description`(설정 페이지 소개) · `settings_schema[]`의
 * 사용자 노출 필드(`resolveSettingFieldNls`). `purpose`·`llmContext`·`permissionReasons`는
 * 아직 어느 화면에도 렌더되지 않아(관련 문서 참고) 대상에서 뺐다 — 렌더 지점이 생기면
 * 그때 추가한다(지금 넣으면 "해석하는데 아무도 안 읽는" 죽은 경로가 된다).
 *
 * `nls`가 없으면 입력을 **그대로** 돌려준다(참조까지 동일 — 하위호환 100%, nls 없는 기존
 * 설치 플러그인은 이 함수를 거쳐도 완전히 무변화).
 */
export function resolveInstalledPluginNls(
  plugin: InstalledPlugin,
  locale: string,
): InstalledPlugin {
  const nls = plugin.nls ?? undefined;
  if (!nls) return plugin;
  const r = (s: string): string => resolveNlsString(s, nls, locale);
  return {
    ...plugin,
    name: r(plugin.name),
    ...(plugin.summary ? { summary: r(plugin.summary) } : {}),
    ...(plugin.settings_category
      ? { settings_category: r(plugin.settings_category) }
      : {}),
    ...(plugin.settings_description
      ? { settings_description: r(plugin.settings_description) }
      : {}),
    settings_schema: plugin.settings_schema.map((f) =>
      resolveSettingFieldNls(f, nls, locale),
    ),
  };
}

/**
 * 알 수 없는 입력을 검증해 PluginManifest로 만든다.
 *
 * 필수: id(형식 검사)·name·version(semver 접두 형식, ·entry 문자열. permissions는
 * 선택(기본 []), 배열이어야 하며 각 항목이 알려진 권한이어야 한다(미지의 권한은 거부).
 * 그 외 필드는 전부 선택 — 존재할 때만 형식을 검사한다.
 *
 * **`version` semver 강제(모든 경로).** `minHostVersion`과 같은 [`SEMVER_PREFIX_RE`]를
 * 적용한다 — **버전 정책**(몇 버전을 발행할지)과 무관하게 **형식**만 강제해
 * `compareVersions`(install-flow.ts)의 다운그레이드 판정이 항상 유효하게 한다. 설치·로드·저작
 * 검증 어느 경로든 semver를 요구한다(하위호환 lenient 경로는 제거했다 — 출시 전이라 비-semver
 * 로 설치된 플러그인이 존재하지 않는다).
 */
export function parseManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "매니페스트가 객체가 아님" };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof o[k] === "string" ? (o[k] as string) : null;

  const id = str("id");
  const name = str("name");
  const version = str("version");
  const entry = str("entry");
  if (id === null || !ID_RE.test(id)) {
    return { ok: false, error: "id 누락 또는 형식 오류" };
  }
  if (name === null) return { ok: false, error: "name 누락" };
  if (version === null) return { ok: false, error: "version 누락" };
  // version semver 강제는 모든 경로에 적용된다(설치·로드·저작 검증). `SEMVER_PREFIX_RE`는
  // 이미 `minHostVersion`에 쓰던 것과 같은 정규식(정본 하나).
  if (!SEMVER_PREFIX_RE.test(version)) {
    return { ok: false, error: "version이 semver 형식이 아님(예: 1.0.0)" };
  }
  if (entry === null) return { ok: false, error: "entry 누락" };
  // entry는 플러그인 디렉터리 내 단순 파일명이어야 한다 — 경로 구분자·상위 이동이 있으면
  // 거부한다. Rust 쪽(`plugins.rs`의 parse_manifest)과 동일한 규칙(빈 문자열·'/'·'\\'·'..'
  // 거부) — 설치 플러그인은 두 검증을 모두 거치지만, TS 검증도 독립적으로 신뢰할 수
  // 있어야 한다(방어 심층화).
  if (
    entry === "" ||
    entry.includes("/") ||
    entry.includes("\\") ||
    entry.includes("..")
  ) {
    return { ok: false, error: "entry 경로가 올바르지 않음" };
  }

  const permsRaw = o.permissions;
  if (permsRaw !== undefined && !Array.isArray(permsRaw)) {
    return { ok: false, error: "permissions가 배열이 아님" };
  }
  const permissions = (permsRaw as unknown[] | undefined) ?? [];
  for (const p of permissions) {
    if (typeof p !== "string" || !isKnownPermission(p)) {
      return { ok: false, error: `알 수 없는 권한: ${String(p)}` };
    }
  }

  // platforms(선택): 배열이면 각 항목이 문자열이어야 한다. 미지의 OS 이름은 거부하지 않는다
  // (전방 호환 — 미래 OS를 선언한 플러그인이 현재 빌드의 파싱을 깨지 않게; 판정은 platform.ts).
  const platsRaw = o.platforms;
  if (platsRaw !== undefined) {
    if (!Array.isArray(platsRaw)) {
      return { ok: false, error: "platforms가 배열이 아님" };
    }
    if (platsRaw.some((p) => typeof p !== "string")) {
      return { ok: false, error: "platforms 항목이 문자열이 아님" };
    }
  }
  const platforms = platsRaw as string[] | undefined;

  // summary(선택): 문자열만.
  if (o.summary !== undefined && typeof o.summary !== "string") {
    return { ok: false, error: "summary가 문자열이 아님" };
  }
  const summary = str("summary") ?? undefined;

  // settings(선택): Rust와 동일 규칙.
  const settingsResult = parseSettingsSchema(o.settings);
  if (!settingsResult.ok) return { ok: false, error: settingsResult.error };
  const settings =
    settingsResult.fields.length > 0 ? settingsResult.fields : undefined;

  // settingsCategory(카멜만) — 스네이크(settings_category) 폴백은 제거했다(엄격).
  const settingsCategoryRaw = o.settingsCategory;
  if (
    settingsCategoryRaw !== undefined &&
    typeof settingsCategoryRaw !== "string"
  ) {
    return { ok: false, error: "settingsCategory가 문자열이 아님" };
  }
  const settingsCategory = settingsCategoryRaw as string | undefined;

  if (
    o.settingsDescription !== undefined &&
    typeof o.settingsDescription !== "string"
  ) {
    return { ok: false, error: "settingsDescription이 문자열이 아님" };
  }
  const settingsDescription = str("settingsDescription") ?? undefined;

  // kind(선택): capability | action.
  if (o.kind !== undefined && o.kind !== "capability" && o.kind !== "action") {
    return { ok: false, error: `알 수 없는 kind: ${String(o.kind)}` };
  }
  const kind = o.kind as PluginKind | undefined;

  // minHostVersion(선택): semver 접두 형식만. 강제(설치 게이트)는 이 함수의 책임이
  // 아니다 — install-flow.ts가 앱 버전과 비교해 판단한다(여기선 형식만 확인).
  if (
    o.minHostVersion !== undefined &&
    (typeof o.minHostVersion !== "string" ||
      !SEMVER_PREFIX_RE.test(o.minHostVersion))
  ) {
    return { ok: false, error: "minHostVersion이 semver 형식이 아님" };
  }
  const minHostVersion = str("minHostVersion") ?? undefined;

  // purpose(선택): 80자 이내 — **코드포인트 기준**([`codePointLength`]).
  if (o.purpose !== undefined) {
    if (typeof o.purpose !== "string") {
      return { ok: false, error: "purpose가 문자열이 아님" };
    }
    if (codePointLength(o.purpose) > 80) {
      return { ok: false, error: "purpose가 80자를 초과함" };
    }
  }
  const purpose = str("purpose") ?? undefined;

  // llmContext(선택): 2000자 이내(코드포인트 기준 — Rust·스키마와 같은 단위).
  if (o.llmContext !== undefined) {
    if (typeof o.llmContext !== "string") {
      return { ok: false, error: "llmContext가 문자열이 아님" };
    }
    if (codePointLength(o.llmContext) > 2000) {
      return { ok: false, error: "llmContext가 2000자를 초과함" };
    }
  }
  const llmContext = str("llmContext") ?? undefined;

  // permissionReasons(선택): 문자열 값 맵, 각 값 200자 이내.
  let permissionReasons: Record<string, string> | undefined;
  if (o.permissionReasons !== undefined) {
    if (
      typeof o.permissionReasons !== "object" ||
      o.permissionReasons === null ||
      Array.isArray(o.permissionReasons)
    ) {
      return { ok: false, error: "permissionReasons가 객체가 아님" };
    }
    const entries = Object.entries(
      o.permissionReasons as Record<string, unknown>,
    );
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (typeof v !== "string") {
        return {
          ok: false,
          error: `permissionReasons['${k}']가 문자열이 아님`,
        };
      }
      if (codePointLength(v) > 200) {
        return {
          ok: false,
          error: `permissionReasons['${k}']가 200자를 초과함`,
        };
      }
      out[k] = v;
    }
    permissionReasons = out;
  }

  // contributes(선택): JS 없이 매니페스트만으로 하는 선언형 등록.
  const contributesResult = parseContributes(o.contributes);
  if (!contributesResult.ok)
    return { ok: false, error: contributesResult.error };
  const contributes = contributesResult.contributes;

  // exposes(선택): 다른 플러그인에 공개할 명령 id 목록. 배열이어야 하고 각 항목이
  // 비어있지 않은 문자열이어야 한다(명령 id는 setting 키처럼 형식이 고정돼 있지 않으므로
  // 형식은 강제하지 않는다 — 비공개가 기본이라 잘못 적어도 그 명령이 안 열릴 뿐이다).
  // Rust `parse_manifest`와 같은 규칙(대칭 검증 — 한쪽만 거부하면 "CLI는 통과인데 설치가
  // 거부된다"가 난다).
  let exposes: string[] | undefined;
  if (o.exposes !== undefined && o.exposes !== null) {
    if (!Array.isArray(o.exposes)) {
      return { ok: false, error: "exposes가 배열이 아님" };
    }
    if (o.exposes.some((e) => typeof e !== "string" || e === "")) {
      return { ok: false, error: "exposes 항목이 비어있지 않은 문자열이 아님" };
    }
    if (o.exposes.length > 0) exposes = o.exposes as string[];
  }

  // nls(축 2, 선택): 저작자 자기 로컬라이즈 사전. Rust `parse_manifest`와 같은 규칙(대칭
  // 검증 — 한쪽만 거부하면 "CLI는 통과인데 설치가 거부된다"가 난다).
  const nlsResult = parseNls(o.nls);
  if (!nlsResult.ok) return { ok: false, error: nlsResult.error };
  const nls = nlsResult.nls;

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      entry,
      permissions: permissions as string[],
      ...(platforms ? { platforms } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(settingsCategory !== undefined ? { settingsCategory } : {}),
      ...(settingsDescription !== undefined ? { settingsDescription } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(minHostVersion !== undefined ? { minHostVersion } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(llmContext !== undefined ? { llmContext } : {}),
      ...(permissionReasons !== undefined ? { permissionReasons } : {}),
      ...(contributes !== undefined ? { contributes } : {}),
      ...(exposes !== undefined ? { exposes } : {}),
      ...(nls !== undefined ? { nls } : {}),
    },
  };
}
