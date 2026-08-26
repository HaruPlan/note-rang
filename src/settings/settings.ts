/**
 * 설정·플러그인 매니저 창.
 *
 * 역할: 상단 탭 3개로 나눈다 — 「테마」(테마 피커·전역 글자 크기, 공유 설정 저장) ·
 * 「번들 플러그인」(1st-party 번들: 활성 토글·번들 테마 🔒 필수 잠금·⚙ 설정·상세 뷰) ·
 * 「커뮤니티 플러그인」(외부 설치 목록: 민감 권한 부여·제거·업데이트 확인·새 기기 재승인,
 * URL/git/로컬 폴더 설치(스테이징 → 권한 승인 프롬프트 → 확정), vault 목록 재조정 안내
 * ([설치]/[제거]/[무시], 비차단)). 플러그인은 출처(번들 vs 커뮤니티)로 탭을 나눈다.
 * 활성 테마의 크롬 토큰을 설정창 루트에
 * 적용해 설정창도 테마를 따른다(D6 — 마운트 시 + 테마 변경 후 호스트 재빌드 시 갱신).
 * IO는 전부 주입받아 Tauri 없이 테스트한다. 설치 판단 로직은 `install-flow.ts`(순수)에 있다.
 * 왜: 메뉴바 앱의 설정 진입점(트레이 "설정")과 외부 플러그인 신뢰 모델 UI를 담당한다(§6+§7).
 *
 * 보안: 설치는 반드시 승인 프롬프트를 거치고(거부 시 스테이징 폐기), 부여는 로컬 토글/승인으로만
 * 켜지며 백엔드가 선언과 교집합으로 좁힌다 — 동기화 데이터로 민감 권한이 부여되지 않는다
 * (부여는 기기 기준).
 */
import { isSensitive } from "../plugin/permissions";
import type { ToolbarPaletteCapabilities } from "../plugin/capabilities";
import { describePlatforms, isSupportedOnPlatform } from "../plugin/platform";
import {
  BUILTIN_ASSETS,
  BUILTIN_PLUGINS,
  BUILTIN_THEMES,
  type BuiltinPlugin,
  pickBuiltinReadme,
  resolveBuiltinPluginNls,
  resolveBuiltinThemeNls,
} from "../plugin/builtin";
import {
  ALL_TOKEN_KEYS,
  applyTheme,
  baseThemeName,
  CUSTOM_THEME_SUFFIX,
  isSurfaceToken,
  mergeThemeOverrides,
  THEME_TOKEN_DEFAULTS,
  type ThemeDescriptor,
} from "../theme/theme";
import {
  FONT_LIST_LONG_ROWS,
  groupFontRows,
  hasFontPicker,
  type FontDescriptor,
  type FontRow,
} from "../theme/font";
import {
  eventToAccel,
  eventToTauriAccel,
  hasModifier,
  formatAccelLabel,
  findConflicts,
} from "../shortcuts/accel";
import {
  SHORTCUT_ACTIONS,
  effectiveKeybindings,
  isCoreAliasTarget,
} from "../shortcuts/actions";
import { renderReadmeInto } from "./readme";
import { choiceDialog, confirmDialog } from "../note/confirm-dialog";
import { builtinItemIconSvg } from "../note/note-toolbar";
import {
  BUILTIN_ITEMS,
  DEFAULT_LAYOUT_MAC,
  DEFAULT_LAYOUT_WINDOWS,
  availableBuiltinItems,
  pruneLayout,
  resolveLayout,
  sameLayout,
  type FallbackPosition,
  type ToolbarLayout,
} from "../note/toolbar-layout";
import {
  renderToolbarLayoutEditor,
  type LayoutPaletteItem,
} from "./toolbar-layout-editor";
import {
  computeApprovalView,
  describeSource,
  grantsForApproval,
  grantsForRegrant,
  minHostVersionUnmet,
  needsApproval,
  parseInstallInput,
  pendingReservedForApproval,
  pendingReservedForRegrant,
  permissionInfo,
  previewMinHostVersion,
  reservedRegrant,
  selfReportedLlmContext,
  selfReportedPermissionReasons,
  selfReportedPurpose,
  specFromSource,
  type ApprovalPermission,
  type ApprovalView,
} from "./install-flow";
import type {
  InstalledPlugin,
  InstallPreview,
  InstallSpec,
  MissingPlugin,
  NoteSnapshot,
  NoteSummary,
  BackupSummary,
  LanguagePackEntry,
  PluginSettingField,
  RejectedPlugin,
  VaultInfo,
  VaultTargetInfo,
} from "../shared/tauri";
// "관리 › 초기화"(이슈 #20)·"관리 › 저장 폴더"(이슈 #21)·"관리 › 백업"(이슈 #28) 페이지 전용 —
// buildResetPanel doc-comment 참고(SettingsDeps 주입을 거치지 않는 IO 호출 지점).
import {
  backupErrorCode,
  changeVaultPath,
  exportBackup,
  getVaultInfo,
  importBackup,
  inspectBackup,
  inspectVaultFolder,
  pickBackupFile,
  pickVaultFolder,
  resetSettings,
  vaultErrorCode,
  wipeAllData,
} from "../shared/tauri";
// 설치 언어팩 직로드(②단계) — 번들 팩의 `loadEnabledBundledPacks`와 **같은 성격**의 배선이라
// `SettingsDeps` 주입이 아니라 여기서 직접 부른다(둘 다 첫 `setActiveLocale` 전에 끝나야 하는
// 로케일 공급이고, 이 창 말고는 주입을 갈아 끼울 소비자가 없다).
import { listLanguagePacks, readLocaleEntries } from "../shared/tauri";
import { t } from "../i18n/t";
import { resolveLanguage } from "../i18n/detect";
import {
  activeLocale,
  availableLocales,
  registerLocale,
  setActiveLocale,
} from "../i18n/store";
import {
  loadAllBundledPacks,
  loadEnabledBundledPacks,
  packToBuiltin,
} from "../i18n/packs";
// 설정 값의 형태 규칙(기본값 병합·list 직렬화·select 옵션 정규화)은 플러그인 중앙 호스트와
// **같은 순수 모듈**을 쓴다 — 폼이 쓰는 규칙과 플러그인이 받는 값이 어긋나지 않게.
import {
  mergeSettingDefaults,
  parseListBlob,
  sanitizeListName,
  serializeListBlob,
  settingOptions,
  type SettingListItem,
} from "../shared/plugin-settings";
import type { PluginFailure } from "../plugin/host-protocol";
import type { DiagnosticKind, PluginDiagnostic } from "../plugin/diagnostics";

/**
 * 툴바 배치 팔레트를 다시 그려야 하는지 판정한다(순수, 가드 테스트용).
 *
 * **키만이 아니라 표시 내용(name·glyph·position)까지 비교한다.** 키만 보면 "언어가 바뀐
 * 재빌드"를 변화 없음으로 읽어 팔레트가 옛 언어 문구에 영원히 갇힌다 — 플러그인 버튼 이름은
 * 중앙 호스트 스냅샷이 실어 오므로 재빌드 때 **키는 그대로고 이름만** 바뀌기 때문이다. 그
 * 결과가 반쪽만 번역된 팔레트였다(설정 창이 직접 `t()`로 그리는 `core:*` 항목만 새 언어로
 * 바뀌고, 플러그인 항목은 옛 언어 그대로).
 * 반대로 팔레트가 **완전히 같으면** 다시 그리지 않는다 — 배치-만-변경(드래그 편집 → 저장 →
 * 호스트 재빌드)에서 편집 중인 화면이 깜빡이지 않게 하려는 원래 의도를 그대로 지킨다.
 */
export function toolbarPaletteChanged(
  next: readonly LayoutPaletteItem[],
  prev: readonly LayoutPaletteItem[],
): boolean {
  return (
    next.length !== prev.length ||
    next.some((it, i) => {
      const old = prev[i];
      return (
        !old ||
        it.key !== old.key ||
        it.name !== old.name ||
        it.glyph !== old.glyph ||
        it.position !== old.position
      );
    })
  );
}

/** 설치된 플러그인이 테마인지(권한 `theme` 선언) 판정한다(순수, 가드 테스트용). */
export function isThemePluginInfo(plugin: InstalledPlugin): boolean {
  return plugin.permissions.includes("theme");
}

/**
 * 테마 피커에 노출할 선택 가능한 테마 이름 목록을 만든다(순수, 가드 테스트용).
 *
 * 역할: 빌트인 테마(sj_d·plain) + 설치된 테마 플러그인(권한 `theme` 선언)을 합쳐
 * 중복 없이 돌려준다. 활성 테마가 목록에 없으면(제거된 테마 등) 그 이름도 포함해
 * 선택 상태가 유실되지 않게 한다.
 * 왜: 테마는 "하나를 선택"하는 대상 — 피커가 고를 수 있는 모든 테마를 단일 목록으로 모은다.
 */
export function availableThemeNames(
  plugins: InstalledPlugin[],
  active: string,
  customNames: string[] = [],
): string[] {
  const names = new Set<string>(BUILTIN_THEMES.map((t) => t.id));
  for (const p of plugins) {
    if (isThemePluginInfo(p)) names.add(p.id);
  }
  // 사용자 파생 변형({테마}<custom>)도 선택지로 보인다(색을 편집하면 생기는 임시 저장본).
  for (const c of customNames) names.add(c);
  names.add(active); // 활성 테마는 목록에 없어도 선택 상태를 유지한다.
  return [...names];
}

/**
 * 플러그인 매니저에서 카테고리 그룹을 보이는 순서(위→아래). 테마는 잠금이라 맨 뒤.
 *
 * 「언어」는 폰트·배경과 같은 "앱 전체의 표현" 묶음이라 그 뒤, 잠금 그룹인 테마 앞에 둔다.
 * **여기 빠뜨리면 그 카테고리의 행이 렌더 루프에서 통째로 건너뛰어져 무음으로 사라진다**
 * (렌더는 이 배열을 순회한다 — `byCat`에 모인 것이 아니라).
 */
const CATEGORY_ORDER = [
  "에디터",
  "도구",
  "창",
  "폰트",
  "배경",
  "언어",
  "테마",
] as const;

/**
 * 카테고리 헤더 장식(아이콘 + 부제) — 흐릿한 라벨을 실제 섹션 앵커로 만든다.
 *
 * 키(에디터·도구·창·폰트·배경·언어·테마)는 CATEGORY_ORDER·inferPluginCategory의 반환값과 맞물리는
 * 비교/조회 식별자라 t()로 옮기지 않는다(§i18n 규약 — 식별자는 대상 밖). caption 값만 순수
 * 표시 문구라 이관 대상이다.
 *
 * 함수인 이유: 소비 지점(`renderBuiltinList`)이 호출될 때마다 다시 평가해 `t()`가 그 순간의
 * 활성 로케일을 읽게 한다. 모듈 상단 `const`로 한 번만 구우면 이 창이 로드되는 시점
 * (`setActiveLocale()`보다 항상 먼저)의 로케일로 caption이 영원히 고정된다(§i18n 규약).
 */
const CAT_META = (): Record<string, { icon: string; caption: string }> => ({
  에디터: { icon: "✏️", caption: t("settings.category.editor-caption") },
  도구: { icon: "🧰", caption: t("settings.category.tool-caption") },
  창: { icon: "🪟", caption: t("settings.category.window-caption") },
  폰트: { icon: "🔤", caption: t("settings.category.font-caption") },
  배경: { icon: "🖼️", caption: t("settings.category.background-caption") },
  언어: { icon: "🌐", caption: t("settings.category.language-caption") },
  테마: { icon: "🌗", caption: t("settings.category.theme-caption") },
});

/**
 * 카테고리 식별자(위 CAT_META·CATEGORY_ORDER의 키 + 트리 그룹 식별자 "외형"·"복구"·
 * "관리"·"플러그인"·"시작"·"도움말") → 표시명 번역 키. 이 열셋만 우리 어휘다 — 값이 곧 비교/조회에
 * 쓰이는 식별자라 여기 없는 문자열(서드파티 매니페스트의 임의 `category`·`settingsCategory`)은
 * 우리가 번역할 대상이 아니다(플러그인 데이터).
 */
const CATEGORY_NAME_KEYS: Record<string, string> = {
  외형: "settings.category.name-appearance",
  도구: "settings.category.name-tool",
  복구: "settings.category.name-recovery",
  관리: "settings.category.name-manage",
  플러그인: "settings.category.name-plugin",
  에디터: "settings.category.name-editor",
  창: "settings.category.name-window",
  폰트: "settings.category.name-font",
  배경: "settings.category.name-background",
  언어: "settings.category.name-language",
  테마: "settings.category.name-theme",
  시작: "settings.category.name-startup",
  도움말: "settings.category.name-help",
};

/**
 * 카테고리 식별자를 표시명으로 옮긴다(순수, 가드 테스트용).
 *
 * 설정 트리 좌측 그룹 제목("외형"·"도구"·"복구"·"플러그인"·"시작")과 번들/설치 목록의 카테고리
 * 헤더("에디터"·"도구"·"창"·"폰트"·"배경"·"언어"·"테마")는 식별자 겸 표시명이다 — 그 값 자체가
 * CATEGORY_ORDER·CATEGORY_RANK·inferPluginCategory·매니페스트 `settingsCategory` 조인·비교에
 * 쓰이므로 식별자는 절대 t()로 옮기지 않는다(§i18n 규약 — 식별자는 대상 밖). 이 함수는 **표시
 * 시점에만** 알려진 열셋 식별자를 로케일 문구로 바꾼다. 모르는 id(서드파티 플러그인이
 * `settingsCategory`로 선언한 임의 문자열)는 원문 그대로 돌려준다 — 우리 사전에 없는 값이라
 * 번역 대상이 아니다(그 문자열은 플러그인 데이터이지 UI 카피가 아니다).
 *
 * 함수인 이유는 CAT_META와 같다 — 렌더 지점이 호출할 때마다 그 순간의 활성 로케일을
 * 읽어야 한다(§i18n 규약 — 모듈 최상위 t() 즉시평가 금지).
 */
function categoryDisplayName(id: string): string {
  const key = CATEGORY_NAME_KEYS[id];
  return key ? t(key) : id;
}

/**
 * 검색 인덱스: 플러그인 설정 폼이 아닌 고정 페이지가 보여주는 개별 설정 항목의 라벨을 그
 * 페이지가 실제로 쓰는 i18n 키에서 뽑는다(순수, 가드 테스트용) — 페이지를 그리지 않고도
 * 채운다. 페이지 이름 자체(예: "테마"·"단축키")는 이미 트리 label로 매칭되므로 중복해 넣지
 * 않는다. 함수인 이유는 `categoryDisplayName`과 같다(§i18n 규약 — 호출 시점에 활성 로케일로
 * 평가).
 *
 * 관리 노드(`manager:bundle`·`manager:community`)는 여기 없다 — 그 페이지의 "항목"은 설치된
 * 플러그인 자체라 고정 문구가 아니라 목록 데이터이므로, `collectNodes`가 그 자리에서 직접
 * 채운다. 모르는 id는 빈 배열(정적으로 나열할 항목이 없는 페이지).
 */
export function staticPageSearchTerms(id: string): string[] {
  switch (id) {
    case "appearance:theme":
      return [
        t("settings.theme.label-accent"),
        t("settings.theme.label-border"),
        t("settings.theme.label-card"),
        t("settings.theme.label-danger"),
        t("settings.theme.label-surface"),
        t("settings.theme.label-text"),
        t("settings.theme.label-warning"),
        t("settings.theme.reset-all"),
      ];
    case "appearance:font":
      return [
        t("settings.font.size-label"),
        t("settings.font.custom-label"),
        t("settings.font.system-default-label"),
      ];
    case "appearance:shortcuts":
      return [
        t("settings.shortcuts.section-global"),
        t("settings.shortcuts.section-note-tools"),
        t("settings.shortcuts.section-plugin-actions"),
        t("settings.shortcuts.new-note-label"),
        t("settings.shortcuts.clear-label"),
      ];
    case "appearance:ui-layout":
      return [
        t("settings.toolbar-layout.preview-title"),
        t("settings.toolbar-layout.palette-title"),
        t("settings.toolbar-layout.bar-top"),
        t("settings.toolbar-layout.bar-bottom"),
        t("settings.toolbar-layout.reset-button"),
      ];
    case "recovery":
      return [
        t("settings.recovery.restore-button"),
        t("settings.recovery.refresh-button"),
      ];
    case "manage:vault":
      return [
        t("settings.vault.change-button"),
        t("settings.vault.current-label"),
      ];
    case "manage:backup":
      return [
        t("settings.backup.export-title"),
        t("settings.backup.import-title"),
      ];
    case "manage:reset":
      return [
        t("settings.reset.section-settings-title"),
        t("settings.reset.section-wipe-title"),
      ];
    case "startup":
      return [
        t("settings.startup.no-active-label"),
        t("settings.startup.no-active-option-panel"),
        t("settings.startup.no-active-option-new-note"),
      ];
    case "help":
      return [t("settings.help.open-guide")];
    default:
      return [];
  }
}

/**
 * 목록 부제: 매니페스트 `summary`가 있으면 그대로, 없으면 README 첫 비-헤더 줄에서 마크다운을
 * 벗겨 파생한다(순수, 가드 테스트용). 90자를 넘으면 말줄임한다.
 */
export function pluginSummary(
  summary: string | undefined,
  readme: string,
): string {
  if (summary && summary.trim()) return summary.trim();
  const line =
    readme
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0 && !s.startsWith("#")) ?? "";
  const plain = line
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|[*_]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return plain.length > 90 ? plain.slice(0, 89).trimEnd() + "…" : plain;
}

/**
 * 플러그인의 선언 권한으로 카테고리를 추론한다(순수, 가드 테스트용).
 *
 * 규칙: theme→테마, background→배경, font→폰트, window-control→창, editor→에디터,
 * i18n→언어, 그 외→도구.
 * 왜: 번들·설치 플러그인을 매니저에서 카테고리로 묶되, 매니페스트에 별도 카테고리 필드를
 * 요구하지 않고 이미 선언된 권한으로 분류한다(설치형도 동일 규칙).
 *
 * `i18n`(언어팩) 분기가 editor 뒤·도구 폴백 앞에 있는 이유: 언어팩은 권한을 `["i18n"]`
 * 하나만 선언하는 것이 정상이라 앞선 어떤 분기에도 걸리지 않지만, 여러 권한을 함께 선언한
 * 플러그인이라면 능력(테마·배경·폰트·창)이 더 강한 정체성이므로 그쪽을 먼저 본다. 번들
 * 언어팩과 서드파티 설치 언어팩이 **같은 이 함수**를 타므로 분류도 자동으로 대칭이다.
 */
export function inferPluginCategory(permissions: string[]): string {
  if (permissions.includes("theme")) return "테마";
  if (permissions.includes("background")) return "배경";
  if (permissions.includes("font")) return "폰트";
  if (permissions.includes("window-control")) return "창";
  if (permissions.includes("editor")) return "에디터";
  if (permissions.includes("i18n")) return "언어";
  return "도구";
}

/** 전역 글자 크기 기준: 100% = 14px(메모 델타%와 같은 기준 — note-window `effectiveFontPx`). */
const FONT_BASE_PX = 14;

/** 전역 글자 크기 %를 px로(8~48 클램프). 100%→14px. (순수, 가드 테스트용) */
export function globalFontPctToPx(pct: number): number {
  return Math.min(48, Math.max(8, Math.round((FONT_BASE_PX * pct) / 100)));
}

/** 전역 글자 크기 셀렉트에 노출할 % 후보(메모 델타 ±10% 스텝과 결이 맞다). */
export const FONT_PCT_OPTIONS = [
  80, 90, 100, 110, 120, 130, 140, 150, 175, 200,
];

/**
 * 저장된 전역 글자 크기 px를 표시용 %로 되돌린다(순수, 가드 테스트용). 14px→100%.
 *
 * px→%를 단순 역산(반올림)하면 후보 %가 왕복하지 않는다(80%→11px→79%). 후보 %는 모두
 * 서로 다른 px로 매핑되므로(80→11 … 200→28), 저장 px를 정확히 만드는 후보가 있으면 그 %를
 * 그대로 돌려줘 "선택→저장→표시" 왕복을 보존한다. 정확히 맞는 후보가 없으면(임의 저장 px)
 * 가장 가까운 px를 내는 후보 %로 스냅한다.
 */
export function globalFontPxToPct(px: number): number {
  let best = FONT_PCT_OPTIONS[0];
  let bestDist = Infinity;
  for (const pct of FONT_PCT_OPTIONS) {
    const dist = Math.abs(globalFontPctToPx(pct) - px);
    if (dist < bestDist) {
      bestDist = dist;
      best = pct;
    }
  }
  return best;
}

/** 설정 창이 다루는 공유 설정의 좁은 형태(테마·전역 글자 크기·색 오버라이드 변경, 나머지는 보존). */
interface SettingsShape {
  schema_version: number;
  theme: string;
  /** 테마별 사용자 색 오버라이드(테마명 → 토큰 → hex). 없으면 오버라이드 없음. */
  theme_overrides?: Record<string, Record<string, string>>;
  /** 창 단위 도구 단축키(동작 id → 키 가속기). 없으면(구버전) 기본 바인딩을 시드한다. */
  keybindings?: Record<string, string>;
  /** 툴바 버튼 배치(드래그&드롭). 없으면(구버전) 기본 배치를 쓴다. */
  toolbar_layout?: ToolbarLayout;
  /**
   * 최초 실행에 고른 툴바 스타일("mac"|"windows", toolbar-style-prompt.ts). "기본 배치로
   * 초기화" 버튼이 그 스타일에 맞는 DEFAULT_LAYOUT_MAC/WINDOWS를 고르는 데 쓴다(스타일
   * 미확정이면 undefined).
   */
  toolbar_style?: string | null;
  /** UI 언어 로케일 코드(예 `"ko"`). 없으면(구버전) ko를 기본으로 쓴다. */
  language?: string | null;
  defaults: unknown;
}

/** 공유 설정 defaults에서 전역 글자 크기(px)를 읽는다(없으면 14). */
function readDefaultFontPx(defaults: unknown): number {
  const px = (defaults as { font_size?: number } | null | undefined)?.font_size;
  return typeof px === "number" ? px : FONT_BASE_PX;
}

/** 공유 설정 defaults에서 전역 폰트 스택을 읽는다(없거나 빈 문자열이면 null = 시스템 기본). */
function readDefaultFontFamily(defaults: unknown): string | null {
  const stack = (defaults as { font_family?: unknown } | null | undefined)
    ?.font_family;
  return typeof stack === "string" && stack.length > 0 ? stack : null;
}

/**
 * 설정 화면 액션 버튼의 명령 실행 결과 — 요청이 실제로 나갔는지, 못 나갔다면 왜인지.
 *
 * 왜 boolean이 아닌가: 창 컨텍스트가 없는 설정 화면에서는 호스트가 `when`의 창-의존 키·
 * `destructive` 확인을 판정할 수 없어 실행을 삼킨다 — 그 사실을 모르면 설정 화면이
 * "실행을 요청했어요"라는 **거짓 성공**을 띄운다. 사유별 문구는 [`mountSettings`]의
 * `runSettingAction`이 만든다(표시 계약은 설정 계층 소유).
 *
 * export하지 않는다(구현부 main.ts는 반환 리터럴이 구조적으로 검사된다 — knip 미사용
 * export 방지). 이름이 필요하면 `SettingsDeps["runPluginCommand"]`의 반환 타입으로 쓴다.
 */
type RunPluginCommandOutcome =
  /** 명령이 등록돼 있고 창-독립이라 실행 요청을 보냈다. */
  | "dispatched"
  /** 그 id로 등록된 명령이 없다(매니페스트 command와 register id 불일치·오타). */
  | "unregistered"
  /** `when`에 메모 창의 상태를 봐야 판정되는 키(note.isEmpty)가 있어 설정 화면에서는 실행 불가. */
  | "needs-note-window"
  /** `destructive: true` — 확인 팝업을 띄울 메모 창이 없어 설정 화면에서는 실행 불가. */
  | "needs-confirm-window";

/** 설정 창이 필요로 하는 IO 의존성(테스트 시 주입). */
interface SettingsDeps {
  getSettings(): Promise<SettingsShape>;
  saveSettings(settings: SettingsShape): Promise<void>;
  /**
   * 대기 중인 notes-reload 디바운스 타이머를 취소하고 즉시 그 신호를 보낸 뒤 완료를 기다린다.
   *
   * 언어 변경·언어팩 설치/토글/제거처럼 저장 직후 **이 창 자신도** `window.location.reload()`
   * 하는 경로에서만 쓴다 — self-reload가 400ms 디바운스 타이머보다 먼저 이 창의 JS 런타임을
   * 파기하면 notes-reload가 영영 발화하지 않아 노트·패널 창이 예전 언어로 남는다(경합).
   * self-reload 전에 반드시 이 함수를 기다려야 한다.
   */
  flushNotesReload(): Promise<void>;
  listPlugins(): Promise<InstalledPlugin[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setGranted(id: string, granted: string[]): Promise<void>;
  setSetting(id: string, key: string, value: unknown): Promise<void>;
  removePlugin(id: string): Promise<void>;
  /** 설치 후보 스테이징(다운로드/클론/복사 + 검증 — 설치 전 단계). */
  fetchInstall(spec: InstallSpec): Promise<InstallPreview>;
  /** 승인된 스테이징의 확정 설치. */
  confirmInstall(staging: string, granted: string[]): Promise<string>;
  /** 스테이징 폐기(취소/거부). */
  cancelInstall(staging: string): Promise<void>;
  /** vault 목록 재조정 — 이 기기에 코드가 없는 항목. */
  listMissing(): Promise<MissingPlugin[]>;
  /** 재조정 항목 무시(이 기기에서 재표시 안 함). */
  dismissMissing(id: string): Promise<void>;
  /**
   * 스캔에서 탈락한 플러그인 폴더(사유 포함 — `list_rejected_plugins`). 설치했는데 목록에
   * 나타나지 않는 폴더를 사유와 함께 보인다. 없거나(미배선·구버전 백엔드) 실패하면 안내를
   * 통째로 숨긴다(선택 dep — 재조정 배너와 같은 비차단 원칙).
   */
  listRejected?(): Promise<RejectedPlugin[]>;
  /**
   * 예약(미구현)이라 아직 부여하지 못한 민감 권한을 기록한다(* `set_plugin_pending_reserved`). 설치/업데이트 승인 직후와 예약 해제 재승인 뒤에 부른다.
   * 없으면 기록하지 않는다(재승인 안내가 안 뜰 뿐 설치는 정상 — 선택 dep).
   */
  setPendingReserved?(id: string, pending: string[]): Promise<void>;
  /**
   * 앱 버전(`tauri.conf.json`의 `version`) — 매니페스트 `minHostVersion` 게이트의 기준.
   * 없거나 실패하면 빈 문자열로 취급해 게이트를 통과시킨다(버전을 모르면 막지 않는다).
   */
  hostVersion?(): Promise<string>;
  /** 빌트인 플러그인 활성 상태 맵(id→enabled; 없으면 켜짐). */
  listBuiltinStates(): Promise<Record<string, boolean>>;
  /** 빌트인 플러그인 활성 여부를 저장한다. */
  setBuiltinEnabled(id: string, enabled: boolean): Promise<void>;
  /** 빌트인 플러그인 설정 값 맵(id→key→value; 스키마 기본값은 렌더가 합침). */
  listBuiltinSettings(): Promise<Record<string, Record<string, unknown>>>;
  /** 빌트인 플러그인 설정 값 하나를 저장한다. */
  setBuiltinSetting(id: string, key: string, value: unknown): Promise<void>;
  /**
   * 설정 화면 액션 버튼(`type: "button"`)이 가리키는 **명령 하나를 실행**한다.
   *
   * 계약은 네 줄이다:
   *  - `"dispatched"` = 그 명령이 실제로 등록돼 있어 실행을 보냈다. `"unregistered"` =
   *    등록된 적이 없다(매니페스트는 버튼을 선언했는데 `commands.register`가 없거나 id가
   *    어긋난 경우). **이 구분이 이 dep의 존재 이유다** — 없으면 오타 하나가 "눌러도 아무
   *    일이 없다"는 완전한 무음 실패가 되고, 설정 화면은 그걸 표시할 근거를 갖지 못한다.
   *  - `"needs-note-window"`·`"needs-confirm-window"` = 창 컨텍스트가 없는 설정 화면에서는
   *    호스트가 어차피 실행하지 않는 명령이다(`when`의 창-의존 키·`destructive` 확인 팝업).
   *    보내지 않고 이유를 돌려준다 — 예전엔 보내 놓고 "요청했다"고 말해, 호스트가 조용히
   *    삼킨 실행이 사용자에게 거짓 성공으로 보였다.
   *  - **완료를 기다리지 않는다.** 명령은 중앙 호스트의 샌드박스에서 돌고, 설정 폼은 그
   *    실행에 어떤 식으로도 매달리지 않는다(느린 플러그인이 폼을 인질로 잡을 수 없다 —
   *    액션 버튼이 상한 10초를 요구한 이유를 타임아웃이 아니라 **구조**로 없앤다).
   *  - 명령 본문의 예외·거부는 진단 채널(설정 › 플러그인 › 최근 오류)에 남는다.
   */
  runPluginCommand(
    pluginId: string,
    commandId: string,
  ): Promise<RunPluginCommandOutcome>;
  /** 활성 테마 디스크립터(크롬 토큰 적용용 — 중앙 호스트 스냅샷). 호스트 부재면 null. */
  activeTheme(): Promise<ThemeDescriptor | null>;
  /**
   * 중앙 호스트 스냅샷에서 이번 빌드에 실행 실패한 플러그인 목록을 읽는다(빈 배열=전부 성공).
   * 없거나(구버전 호스트) 실패하면 매니저는 조용히 배지 없이 진행한다(선택 dep).
   */
  pluginFailures?(): Promise<PluginFailure[]>;
  /**
   * 중앙 호스트가 모은 런타임 진단(거부된 브리지 호출·무력화된 창-스코프 호출·설정
   * 저장 실패·`memo.runtime.log`). 없거나 실패하면 상세의 「최근 오류」 섹션을 숨긴다(선택 dep).
   */
  pluginDiagnostics?(): Promise<PluginDiagnostic[]>;
  /** 활성 폰트 능력(「폰트」 플러그인 목록 — 폰트 피커 후보). 플러그인 off·호스트 부재면 null. */
  activeFont(): Promise<FontDescriptor | null>;
  /** 활성 플러그인 툴바 버튼(단축키 바인딩 후보) — id는 `plugin:<pluginId>:<buttonId>`. 없으면 빈 목록. */
  activeToolbarButtons?(): Promise<{ id: string; label: string }[]>;
  /**
   * 배치 편집기 팔레트용 플러그인 버튼 목록(key=plugin:pid:bid, 글리프, 이름). 없으면 빈 목록.
   * `position`은 플러그인이 선언한 자동 배치 존 — 배치가 그 키를 아직 모를 때(설치 직후) 노트
   * 창이 렌더하는 자리라, 편집기 목업도 같은 자리에 놓으려면 함께 받아야 한다.
   */
  toolbarButtonItems?(): Promise<
    {
      key: string;
      glyph: string;
      name: string;
      position?: FallbackPosition;
    }[]
  >;
  /**
   * 내장 컨트롤의 가용 판정 근거 — 활성 창 컨트롤 id 집합과 배경 스와치 유무(중앙 호스트
   * 스냅샷). 노트 툴바가 컨트롤을 실제로 만들 때 보는 것과 같은 값이라, 팔레트가 이걸 써야
   * "팔레트엔 있는데 노트엔 안 나오는" 항목이 생기지 않는다.
   *
   * **호스트 스냅샷을 못 읽으면 null**이고, 그때는 아무것도 거르지도 지우지도 않는다(전체
   * 표시 + 정리 생략). 이 값은 미가용 아이템을 배치에서 **지우는** 근거이기도 해서, "모른다"를
   * "없다"로 흘리면 호스트가 잠깐 죽은 사이에 사용자 배치가 통째로 날아간다.
   */
  toolbarCapabilities?(): Promise<ToolbarPaletteCapabilities | null>;
  /** 전역 "새 노트" 단축키(Tauri 가속기)를 읽는다. 없으면 단축키 탭의 전역 섹션을 숨긴다. */
  getGlobalHotkey?(): Promise<string>;
  /** 전역 "새 노트" 단축키를 바꾼다(등록 실패면 reject — 이전 유지). */
  setGlobalHotkey?(accel: string): Promise<void>;
  /**
   * 활성 노트 0개로 시작했을 때 무엇을 띄울지("panel"|"new-note")를 읽는다. 이 dep과
   * {@link setStartupNoActiveAction}이 **둘 다** 있어야 「시작」 트리 노드를 만든다(선택 dep —
   * 없으면 노드째 숨긴다. 읽기만 되고 쓰기가 없으면 고를 수만 있고 저장은 안 되는 반쪽 UI가
   * 되기 때문).
   */
  getStartupNoActiveAction?(): Promise<string>;
  /** 위 값을 저장한다. 백엔드가 어휘("panel"|"new-note")를 검증하고 그 외는 reject한다. */
  setStartupNoActiveAction?(action: string): Promise<void>;
  /**
   * 「시작 가이드」 메모를 연다 — 있으면 소환하고, 사용자가 지웠으면 새로 만들어 연다
   * (`bootstrap/guide-note.ts`의 `showGuideNote`). 없으면(선택 dep) 「도움말」 노드를 아예
   * 만들지 않는다("IO 없으면 UI 없음" — 「시작」 노드와 같은 관례).
   */
  openGuideNote?(): Promise<void>;
  /** 현재 OS 식별자("macos"·"windows" 등). 미지원 플러그인 배지·자동 비활성 표시에 쓴다(선택 — 없으면 미상). */
  platform?(): Promise<string>;
  /** 설치 플러그인 README의 로컬 이미지 경로 → asset URL(플러그인 폴더 파일만). 없으면 미해석(null). */
  pluginAssetUrl?(id: string, relPath: string): string | null;
  /** 네이티브 폴더 선택 창을 띄우고 고른 절대경로를 준다(취소 시 null). 없으면 "폴더에서 설치" 행을 숨긴다. */
  pickPluginDir?(): Promise<string | null>;
  /**
   * 개발자 모드 단일 핫리로드 — `id`(로컬 폴더 사이드로드 플러그인)의 폴더 감시를 켠다,
   * `null`이면 끈다. 세션 한정 싱글턴이라 다른 id로 다시 부르면 이전 감시가 자동 대체된다.
   * 없으면(선택 dep) 상세 뷰의 "개발자 모드" 토글을 숨긴다.
   */
  setDevPlugin?(id: string | null): Promise<void>;
  /**
   * 「메모 복구」 페이지 IO(복구 슬롯 스냅샷 — `notes.write` overwrite가 남긴 이전 본문).
   *
   * memo엔 undo도 휴지통도 없어 이 스냅샷이 유일한 안전망인데, 웨이브 E까지는 백엔드만 있고
   * 되돌릴 화면이 없었다("반쯤 만들지 말라"에 걸림). 네 호출이 복구 화면의 전 흐름이다 —
   * 스냅샷 보유 노트 찾기(`listNotes` + 노트별 `listSnapshots`) → 본문 미리보기(`readSnapshot`)
   * → 그 시점으로 복원(`restoreSnapshot`, 백엔드가 복원 직전 현재 본문도 스냅샷한다).
   */
  listNotes(): Promise<NoteSummary[]>;
  /**
   * 복구 슬롯에 스냅샷을 가진 모든 노트 id(삭제된 노트 포함 — finding 2). `listNotes`는
   * 존재하는 노트만 열거하므로, **삭제된 노트**의 복구 스냅샷은 이 열거와 합쳐야 복구 화면에
   * 나타난다. 없으면(선택 dep) 존재하는 노트만 대상으로 하는 예전 동작으로 폴백한다.
   */
  listSnapshotNoteIds?(): Promise<string[]>;
  /** 노트 하나의 복구 슬롯 스냅샷 목록(최신순 — 백엔드 정렬). 없으면 빈 배열. */
  listSnapshots(id: string): Promise<NoteSnapshot[]>;
  /** 특정 스냅샷 본문(미리보기용 — 신뢰 경계 밖일 수 있어 화면은 textContent로만 쓴다). */
  readSnapshot(id: string, snapshotId: string): Promise<string>;
  /** 노트 본문을 특정 스냅샷으로 되돌린다(파괴적 — 확인 다이얼로그를 거친 뒤 호출). */
  restoreSnapshot(id: string, snapshotId: string): Promise<void>;
  /** 호스트 재빌드 완료 구독(테마 변경 라이브 반영 — 설정창 수명 동안 유지). */
  onThemeUpdated(handler: () => void): void;
  /**
   * 설치형 플러그인의 README(없으면 null — 상세 뷰가 "설명 없음" 표시). `locale`(선택,
   * 축 2)을 주면 `README.<locale>.md`를 먼저 찾고, 없으면 `README.md`로 폴백한다.
   */
  readPluginReadme(id: string, locale?: string): Promise<string | null>;
  /** 외부 URL(https만)을 기본 브라우저로 연다(README 링크). */
  openExternal(url: string): Promise<void>;
}

/**
 * 상세 뷰가 그리는 플러그인 한 건의 통합 모델(번들·번들 테마·설치형 공통).
 *
 * 왜: 마스터 행의 출처가 세 갈래(BUILTIN_PLUGINS·BUILTIN_THEMES·설치 목록)라, 상세 렌더는
 * 한 형태만 알도록 여기서 평탄화한다. `readme`는 번들이면 상수 문자열(즉시 렌더), 설치형이면
 * null(상세를 연 뒤 IPC로 읽어 채운다).
 */
export interface PluginDetailItem {
  kind: "builtin" | "installed";
  id: string;
  name: string;
  version: string;
  /** 매니페스트가 선언한 한 줄 요약(선택 — 없으면 부제를 그리지 않는다). */
  summary?: string;
  /**
   * 플러그인이 스스로 밝힌 목적 설명(선택, 자기신고 — `purpose`). `summary`(짧은
   * 목록 부제)와 달리 상세 뷰 전용이고, "플러그인이 스스로 밝힌" 톤으로 표시해 신뢰
   * 수위를 낮춘다(검증된 값이 아니다).
   */
  purpose?: string;
  /**
   * 플러그인이 AI 에이전트에게 주는 힌트 요약(선택, 자기신고 — `llmContext`). 일반
   * 사용자에겐 부차적이라 상세 뷰의 접힌 개발자 섹션에만 둔다.
   */
  llmContext?: string;
  /** 출처 표시("번들" | URL | git#ref | "로컬 설치"). */
  sourceLabel: string;
  /** 상태 표시("활성" | "비활성" | 테마 잠금 문구). */
  statusLabel: string;
  /** 테마 타입(필수 잠금 — 토글 없음) 여부. */
  isTheme: boolean;
  /** 선언 권한. */
  permissions: string[];
  /** ⚙ 선언형 설정 스키마(비면 설정 섹션 미노출). */
  schema: PluginSettingField[];
  /** 현재 설정 값(스키마 기본값은 렌더가 합침). */
  values: Record<string, unknown>;
  /** README 마크다운(번들: 즉시 렌더, 설치형: null → 열릴 때 IPC로 읽음). */
  readme: string | null;
  /** 설치형 원본(부여 토글·업데이트·제거에 필요). 번들은 없음. */
  installed?: InstalledPlugin;
  /**
   * 이 플러그인의 런타임 진단(중앙 호스트가 모은 최근 실패·로그). 없으면 섹션을 숨긴다.
   * 왜: 샌드박스가 불투명 origin이라 devtools를 붙일 수 없어, 저작자가 실패를 볼 수 있는
   * 창구는 여기뿐이다(브리지 거부는 `.catch()`가 없으면 흔적이 0이다).
   */
  diagnostics?: PluginDiagnostic[];
  /**
   * 개발자 모드 — 지금 이 플러그인이 폴더 감시 대상인지(세션 한정 싱글턴이라 한 번에
   * 최대 하나). 렌더 호출자가 자신의 devPluginId 상태를 이 필드로 투영한다 — 상세 모델
   * 자체는 상태를 갖지 않는다(순수 평탄화 함수 유지, detailFromInstalled 문서 참고).
   */
  devMode?: boolean;
  /** 개발자 모드 토글을 보일지(=`deps.setDevPlugin`이 배선돼 있는지) — 없으면 렌더가 행을
   * 숨긴다(pickPluginDir과 같은 선택 dep 규칙). */
  devModeAvailable?: boolean;
}

/**
 * 테마 잠금 상태 문구(D3 — 테마는 끄는 게 아니라 테마 탭에서 바꾼다).
 *
 * 함수인 이유: 소비 지점(`detailFromInstalled`·`renderBuiltinList`)이 호출될 때마다 다시
 * 평가해 `t()`가 그 순간의 활성 로케일을 읽게 한다. 모듈 상단 `const`로 한 번만 구우면 이
 * 창이 로드되는 시점(`setActiveLocale()`보다 항상 먼저)의 로케일로 영원히 고정된다(§i18n 규약).
 */
const THEME_LOCK_STATUS = (): string =>
  t("settings.plugin-detail.theme-lock-status");

/**
 * 설치형 플러그인을 상세 모델로 평탄화한다(테마 여부·출처 라벨 포함). `devMode`는 호출자의
 * 세션 상태(어느 id가 지금 감시 대상인지)를 그대로 투영한다(기본 false).
 *
 * `purpose`·`llmContext`는 백엔드가 이미 `InstalledPlugin` 페이로드에 실어 보내지만
 * `shared/tauri.ts`의 타입 선언에는 아직 없다(그 파일은 이 함수의 소유 범위 밖 —
 * `install-flow.ts`의 `readSelfReportedString` 문서 참고) — `selfReportedPurpose`/
 * `selfReportedLlmContext`로 런타임에 좁혀 읽어야 값이 여기서 끊기지 않는다.
 */
export function detailFromInstalled(
  plugin: InstalledPlugin,
  devMode = false,
  devModeAvailable = false,
): PluginDetailItem {
  const isTheme = isThemePluginInfo(plugin);
  const purpose = selfReportedPurpose(plugin);
  const llmContext = selfReportedLlmContext(plugin);
  return {
    kind: "installed",
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    // 백엔드가 실어 보낸 매니페스트 `summary`(미선언이면 null) — 없으면 부제를 그리지 않는다.
    ...(plugin.summary ? { summary: plugin.summary } : {}),
    ...(purpose ? { purpose } : {}),
    ...(llmContext ? { llmContext } : {}),
    sourceLabel: plugin.source
      ? describeSource(plugin.source)
      : t("settings.install-flow.source-local"),
    statusLabel: isTheme
      ? THEME_LOCK_STATUS()
      : plugin.enabled
        ? t("settings.plugin-detail.status-active")
        : t("settings.plugin-detail.status-inactive"),
    isTheme,
    permissions: plugin.permissions,
    schema: plugin.settings_schema,
    values: plugin.settings,
    readme: null, // 설치형은 상세를 연 뒤 IPC로 읽는다.
    installed: plugin,
    devMode,
    devModeAvailable,
  };
}

/** 설정 트리의 노드(선택 가능한 페이지). */
interface SettingsNode {
  id: string;
  /** 트리 그룹 카테고리(예: "외형" · "도구" · "플러그인"). 같은 이름끼리 접이식 그룹으로 묶인다. */
  category: string;
  label: string;
  /** 우측에 보일 콘텐츠 패널. */
  panel: HTMLElement;
  /**
   * 이 페이지가 담은 개별 설정 항목의 라벨/설명(검색 인덱스, 선택). 트리 검색은 `label` 자체뿐
   * 아니라 이 목록도 함께 훑는다 — 페이지 이름은 몰라도 그 안의 항목 이름(예: "강조색"·"백업
   * 내보내기")으로 찾아올 수 있게 한다. 매칭이 `label`이 아니라 이 목록에서 났으면 트리 항목
   * 아래에 매칭된 문구를 짧게 보여준다([`createSettingsTree`]의 힌트). 페이지를 실제로 그리지
   * 않고도 채울 수 있는 값만 담는다(플러그인 설정 페이지는 매니페스트 schema에서, 나머지
   * 고정 페이지는 그 페이지가 쓰는 i18n 키에서 — `staticPageSearchTerms` 참고).
   */
  searchTerms?: string[];
}

/** [`createSettingsTree`]가 돌려주는 컨트롤러 — 레이아웃 + 재조립 + 선택. */
interface SettingsTree {
  /** 좌측 트리 + 우측 내용을 담은 루트(호스트에 붙인다). */
  layout: HTMLElement;
  /** 노드 목록으로 트리·내용을 (다시) 조립한다. 선택·접힘은 보존(선택 사라지면 첫 노드). */
  render(nodes: SettingsNode[]): void;
  /** 노드를 선택해 우측에 그 패널만 보인다(없는 id면 첫 노드로 폴백). */
  select(id: string): void;
}

/** 카테고리 정렬 우선순위 — "외형" 맨 앞, "플러그인" 맨 뒤, 나머지는 등장순(안정 정렬). */
const CATEGORY_RANK: Record<string, number> = { 외형: -1, 플러그인: 1 };

/**
 * WebStorm식 좌측 트리 + 우측 내용의 설정 네비게이션(순수 DOM — 가드 테스트 가능).
 *
 * 역할: 노드를 category로 묶어 접을 수 있는 그룹(헤더 + 본문)으로 그린다("외형" 먼저, "플러그인"
 * 맨 뒤). 헤더를 누르면 그 그룹이 접히고(접힘 상태는 재조립에도 보존), 선택 노드의 패널만
 * 우측에 보인다. 상단 검색은 항목 라벨을 좁히고(매칭 있는 그룹만·검색 중엔 접힘 무시), 재조립
 * 후에도 선택을 id로 보존한다.
 * 왜: 설정이 외형·도구·플러그인으로 커져 트리로 나눈다. 플러그인이 매니페스트로 category를
 * 선언하면 그 이름으로 자동 그룹된다(호스트가 렌더 — 샌드박스는 DOM에 못 닿는다).
 */
function createSettingsTree(initialId: string): SettingsTree {
  const nav = document.createElement("nav");
  nav.className = "settings-tree";
  nav.setAttribute("role", "tree");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "settings-tree-search";
  search.placeholder = t("settings.tree.search-placeholder");
  search.setAttribute("aria-label", t("settings.tree.search-placeholder"));
  const items = document.createElement("div");
  items.className = "settings-tree-items";
  nav.append(search, items);

  const content = document.createElement("div");
  content.className = "settings-content";

  const layout = document.createElement("div");
  layout.className = "settings-tree-layout";
  layout.append(nav, content);

  let current: SettingsNode[] = [];
  let selected = initialId;
  // 접힌 카테고리(사용자가 헤더로 토글) — 재조립(rebuild) 후에도 보존한다.
  const collapsed = new Set<string>();
  // 그룹별 헤더·본문·항목을 추적해 검색·접힘 가시성을 한 곳(applyVisibility)에서 계산한다.
  // hint = 항목 라벨 아래에 매칭된 문구를 보여줄 자리(검색이 searchTerms에서 났을 때만 채움).
  let groups: {
    cat: string;
    header: HTMLElement;
    body: HTMLElement;
    entries: { node: SettingsNode; btn: HTMLElement; hint: HTMLElement }[];
  }[] = [];

  const select = (id: string): void => {
    selected = current.some((n) => n.id === id) ? id : (current[0]?.id ?? id);
    for (const n of current) n.panel.hidden = n.id !== selected;
    for (const g of groups)
      for (const { node, btn } of g.entries) {
        const active = node.id === selected;
        btn.classList.toggle("settings-tree-item-active", active);
        btn.setAttribute("aria-selected", String(active));
      }
  };

  // 검색·접힘으로 항목/본문/헤더의 표시를 계산한다(검색 중엔 접힘을 무시하고 매칭만 보인다).
  // 매칭은 페이지 이름(label) 우선, 없으면 그 페이지의 항목 검색어(searchTerms)에서 찾는다 —
  // 항목에서 났을 때만 힌트를 채운다(페이지 이름이 이미 매칭이면 힌트는 군더더기).
  const applyVisibility = (): void => {
    const q = search.value.trim().toLowerCase();
    for (const g of groups) {
      let anyMatch = false;
      for (const { node, btn, hint } of g.entries) {
        const labelMatch = q === "" || node.label.toLowerCase().includes(q);
        const hitTerm = labelMatch
          ? undefined
          : (node.searchTerms ?? []).find((s) => s.toLowerCase().includes(q));
        const match = labelMatch || hitTerm !== undefined;
        btn.hidden = !match;
        hint.textContent = hitTerm ?? "";
        hint.hidden = hitTerm === undefined;
        if (match) anyMatch = true;
      }
      const isCollapsed = q === "" && collapsed.has(g.cat);
      g.body.hidden = isCollapsed || (q !== "" && !anyMatch);
      g.header.hidden = q !== "" && !anyMatch;
      g.header.classList.toggle("settings-tree-group-collapsed", isCollapsed);
      g.header.setAttribute("aria-expanded", String(!isCollapsed));
    }
  };

  const render = (nodes: SettingsNode[]): void => {
    current = nodes;
    // 우측: 패널 (재)배치 — 안정 패널은 이동, 새 플러그인 패널은 새로 추가된다.
    content.replaceChildren(
      ...nodes.map((n) => {
        n.panel.classList.add("settings-page");
        return n.panel;
      }),
    );
    // 좌측: category별 접이식 그룹. 순서 = CATEGORY_RANK(외형 먼저·플러그인 뒤) + 등장순(안정).
    const cats: string[] = [];
    for (const n of nodes)
      if (!cats.includes(n.category)) cats.push(n.category);
    cats.sort((a, b) => (CATEGORY_RANK[a] ?? 0) - (CATEGORY_RANK[b] ?? 0));

    items.replaceChildren();
    groups = cats.map((cat) => {
      const header = document.createElement("button");
      header.type = "button";
      header.className = "settings-tree-group";
      header.setAttribute("aria-expanded", "true");
      const chevron = document.createElement("span");
      chevron.className = "settings-tree-chevron";
      chevron.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = categoryDisplayName(cat);
      header.append(chevron, label);
      header.addEventListener("click", () => {
        // 검색 중엔 접힘을 무시(applyVisibility가 매칭을 펼쳐 보임)하므로, 헤더 클릭이 접힘을
        // 조용히 뒤집어 검색 해제 후 엉뚱한 상태로 반영되는 것을 막는다(무효 클릭 무시).
        if (search.value.trim() !== "") return;
        if (collapsed.has(cat)) collapsed.delete(cat);
        else collapsed.add(cat);
        applyVisibility();
      });

      const body = document.createElement("div");
      body.className = "settings-tree-group-body";
      const entries = nodes
        .filter((n) => n.category === cat)
        .map((node) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "settings-tree-item";
          btn.dataset.node = node.id;
          btn.setAttribute("role", "treeitem");
          const label = document.createElement("span");
          label.className = "settings-tree-item-label";
          label.textContent = node.label;
          // 검색이 항목(searchTerms)에서 매칭됐을 때만 채워지는 힌트 줄 — 평소엔 빈 채로 숨겨진다.
          const hint = document.createElement("span");
          hint.className = "settings-tree-item-hint";
          hint.hidden = true;
          btn.append(label, hint);
          btn.addEventListener("click", () => select(node.id));
          body.append(btn);
          return { node, btn, hint };
        });

      items.append(header, body);
      return { cat, header, body, entries };
    });

    select(selected);
    applyVisibility();
  };

  search.addEventListener("input", applyVisibility);

  return { layout, render, select };
}

/**
 * 언어 피커를 만든다(등록된 로케일 중 현재 활성 하나 선택 → 변경 시 저장 콜백).
 *
 * 역할: `locales`(지금은 ko 하나, `availableLocales()`)를 드롭다운으로 보이고 표시는 label,
 * 값은 code로 쓴다. 테마 피커와 같은 결(하나를 선택)이지만, 변경 콜백의 책임은 다르다 — 언어는
 * 이 창 자신이 이미 그려 둔 문구(트리 라벨 등)에도 영향을 주므로, onChange가 저장 후 이 창의
 * 리로드까지 맡는다(호출부 `mountSettings`가 그 이유를 doc-comment로 남긴다).
 */
function buildLanguagePicker(
  locales: { code: string; label: string }[],
  current: string,
  onChange: (code: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-row";

  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = t("settings.language.picker-label");
  label.htmlFor = "settings-language";

  const select = document.createElement("select");
  // 공용 입력 스킨(plugin-setting-*)을 함께 입혀 설정 창 셀렉트의 겉모습을 하나로 통일한다.
  select.className =
    "plugin-setting-input plugin-setting-select is-inline settings-language";
  select.id = "settings-language";
  for (const locale of locales) {
    const opt = document.createElement("option");
    opt.value = locale.code;
    opt.textContent = locale.label;
    if (locale.code === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => onChange(select.value));

  wrap.append(label, select);
  return wrap;
}

/**
 * 테마 피커를 만든다(선택 가능한 테마 중 현재 활성 하나 선택 → 변경 시 저장 콜백).
 *
 * 역할: `names`(빌트인 + 설치 테마 플러그인)를 드롭다운으로 보이고, 변경 시 공유 설정의
 * theme만 갱신해 저장한다. 테마는 활성화/비활성화가 아니라 "하나를 선택"하는 대상이다.
 */
function buildThemePicker(
  names: string[],
  current: string,
  onChange: (theme: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-row";

  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = t("settings.theme.picker-label");
  label.htmlFor = "settings-theme";

  const select = document.createElement("select");
  // 공용 입력 스킨 — 언어·테마·글꼴 크기 셀렉트가 같은 겉모습을 갖는다(들쭉날쭉 방지).
  select.className =
    "plugin-setting-input plugin-setting-select is-inline settings-theme";
  select.id = "settings-theme";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => onChange(select.value));

  wrap.append(label, select);
  return wrap;
}

/**
 * 시작 동작 어휘("panel"|"new-note") — 백엔드가 검증하는 값과 옵션 라벨 키의 단일 출처.
 * 패널 정렬의 `PANEL_SORT_MODES`(panel.ts)와 같은 이유로 상수화한다 — 값이 옵션 목록·초기
 * 기본값·조회 실패 폴백 세 곳에 리터럴로 흩어지면 어휘 변경 때 하나를 놓치기 쉽다(특히
 * catch 폴백 — 백엔드 조회가 실패할 때만 드러나는 경로라 리뷰에서 놓치기 쉽다).
 */
const STARTUP_NO_ACTIVE_OPTIONS = [
  { value: "panel", labelKey: "settings.startup.no-active-option-panel" },
  {
    value: "new-note",
    labelKey: "settings.startup.no-active-option-new-note",
  },
] as const;

/** 기본값 — 백엔드 `LocalConfig.startup_no_active_action`의 기본값과 같은 문자열이어야 한다. */
const DEFAULT_STARTUP_NO_ACTIVE_ACTION: string =
  STARTUP_NO_ACTIVE_OPTIONS[0].value;

/**
 * 활성 노트 0개 시작 동작 피커를 만든다(buildLanguagePicker·buildThemePicker와 같은 결 —
 * "하나를 선택" 드롭다운 + 변경 시 저장 콜백). 옵션이 둘뿐이라 그 차이를 짐작하기 어려워,
 * 안내 문단을 행 아래 함께 반환한다(`settings-page-desc` 재사용 — 페이지 머리말 전용이 아니라
 * 일반 흐린 톤 설명 문단 스킨이다).
 *
 * 저장 값은 라벨이 아니라 정확히 `STARTUP_NO_ACTIVE_OPTIONS`의 `value` 두 문자열만 오간다 —
 * 백엔드가 그 어휘를 검증해 그 외는 reject하므로, value를 라벨과 분리해 고정해 둔다(로케일이
 * 바뀌어도 저장 값이 절대 흔들리지 않게 — `PluginSettingOption`의 value/label 분리와 같은 이유).
 */
function buildStartupNoActiveActionPicker(
  current: string,
  onChange: (action: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");

  const row = document.createElement("div");
  row.className = "settings-row";

  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = t("settings.startup.no-active-label");
  label.htmlFor = "settings-startup-no-active-action";

  const select = document.createElement("select");
  // 공용 입력 스킨 — 언어·테마·글꼴 크기 셀렉트와 같은 겉모습(들쭉날쭉 방지).
  select.className =
    "plugin-setting-input plugin-setting-select is-inline settings-startup-no-active-action";
  select.id = "settings-startup-no-active-action";
  for (const { value, labelKey } of STARTUP_NO_ACTIVE_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = t(labelKey);
    if (value === current) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => onChange(select.value));

  row.append(label, select);

  const desc = document.createElement("p");
  desc.className = "settings-page-desc";
  desc.textContent = t("settings.startup.no-active-description");

  wrap.append(row, desc);
  return wrap;
}

/** [`buildFontEditor`] 인자 — 전역 글자 크기 + (능력 on일 때) 폰트 패밀리 목록·선택·저장 콜백. */
interface FontEditorArgs {
  /** 저장된 전역 글자 크기(px). 100%=14px로 표시. */
  fontPx: number;
  /** 글자 크기 확정 변경(px). */
  onSizeChange: (px: number) => void;
  /** 「폰트」 플러그인이 공급한 패밀리 목록. null이면 능력 off → 패밀리 목록을 숨긴다(크기만). */
  families: FontDescriptor["families"] | null;
  /** 저장된 폰트 스택(null=시스템 기본). */
  current: string | null;
  /** 폰트 패밀리 선택(스택 또는 null=시스템 기본) 확정 저장. */
  onFamilyChange: (stack: string | null) => void;
}

/**
 * 글꼴 편집기를 만든다(VSCode식 — 색 편집기와 같은 결: 제목 · 상단 미리보기 · 스크롤 목록).
 *
 * 역할: 상단에 선택(또는 호버) 폰트·크기로 렌더한 샘플 문장을 보여 주고, 도구줄의 크기 셀렉트와
 * 아래 스크롤 목록(각 폰트를 **자기 서체로** 렌더한 행 — 클릭 선택)을 준다. 크기는 앱 전역 설정,
 * 패밀리는 「폰트」 플러그인이 공급한 목록에서 고른다(능력 off면 목록을 숨기고 시스템 기본 고정).
 * 왜: "색이 있으니 글자도" — 폰트 선택을 색 편집기와 같은 미리보기·목록 언어로 통일한다. 스택은
 * 플러그인이 등록 시 정규화한 값이라 그대로 신뢰한다(주입 차단은 등록 경계 `normalizeFontArgs`).
 */
function buildFontEditor(args: FontEditorArgs): HTMLElement {
  const { families, onSizeChange, onFamilyChange } = args;
  let selected: string | null = args.current;

  const section = document.createElement("section");
  section.className = "settings-font-editor";
  section.append(
    buildSettingsPageHead(
      t("settings.font.page-title"),
      t("settings.font.page-description"),
    ),
  );

  // ── 미리보기(상단) — 선택(또는 행 호버) 폰트·크기로 샘플 문장을 렌더한다(별도 상태 없음). ──
  const preview = document.createElement("div");
  preview.className = "settings-font-preview";
  const sample = document.createElement("div");
  sample.className = "settings-font-sample";
  sample.textContent = t("settings.font.sample-text");
  preview.append(sample);
  section.append(preview);

  // 시스템 기본(null)이면 font-family 미지정(#app 상속). 스택은 등록 시 살균됐다(직접 대입 안전).
  const applyPreview = (stack: string | null): void => {
    sample.style.fontFamily = stack ?? "";
  };
  const setSize = (px: number): void => {
    sample.style.fontSize = `${px}px`;
  };
  setSize(args.fontPx);
  applyPreview(selected);

  // ── 도구줄 — 전역 글자 크기(%) + (폰트가 많을 때) 검색. ──
  const toolbar = document.createElement("div");
  toolbar.className = "settings-font-toolbar";
  const sizeLabel = document.createElement("label");
  sizeLabel.className = "settings-font-sizelabel";
  sizeLabel.textContent = t("settings.font.size-label");
  sizeLabel.htmlFor = "settings-font";
  const sizeSelect = document.createElement("select");
  // 공용 입력 스킨 + settings-font의 컴팩트 오버라이드(도구줄 밀도 유지).
  sizeSelect.className =
    "plugin-setting-input plugin-setting-select is-inline settings-font";
  sizeSelect.id = "settings-font";
  // 저장 px를 후보 %로 스냅한다(왕복 보존) — 결과는 항상 후보 중 하나라 별도 주입이 필요 없다.
  const currentPct = globalFontPxToPct(args.fontPx);
  for (const pct of FONT_PCT_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(pct);
    opt.textContent = `${pct}%`;
    if (pct === currentPct) opt.selected = true;
    sizeSelect.append(opt);
  }
  sizeSelect.addEventListener("change", () => {
    const px = globalFontPctToPx(Number(sizeSelect.value));
    setSize(px);
    onSizeChange(px);
  });
  toolbar.append(sizeLabel, sizeSelect);
  section.append(toolbar);

  // 능력 off(families=null)면 여기서 끝 — 크기 컨트롤만, 시스템 기본 폰트 고정.
  if (!families) return section;

  // ── 폰트 목록(스크롤) — 시스템 기본 + 각 패밀리를 자기 서체로 렌더한 클릭 행. ──
  const rows: {
    stack: string | null;
    row: HTMLButtonElement;
    /** 검색 대조용 문자열(소문자) — 보이는 이름 + 지역화 별칭. 한글로 "나눔"을 쳐도 걸린다. */
    search: string;
  }[] = [];
  const syncSelected = (): void => {
    for (const { stack, row } of rows)
      row.classList.toggle("is-selected", stack === selected);
  };
  const addRow = (
    stack: string | null,
    label: string,
    alias?: string,
  ): HTMLButtonElement => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "settings-font-row";
    const check = document.createElement("span");
    check.className = "settings-font-check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "settings-font-rowname";
    name.textContent = label;
    name.style.fontFamily = stack ?? ""; // 행을 자기 폰트로 렌더(=미리보기)
    row.append(check, name);
    // 호버 시 그 폰트로 상단 미리보기, 벗어나면 선택 폰트로 복귀(색 편집기의 라이브 반영과 대칭).
    row.addEventListener("mouseenter", () => applyPreview(stack));
    row.addEventListener("mouseleave", () => applyPreview(selected));
    row.addEventListener("click", () => {
      selected = stack;
      applyPreview(selected);
      syncSelected();
      onFamilyChange(stack);
    });
    rows.push({ stack, row, search: `${label} ${alias ?? ""}`.toLowerCase() });
    return row;
  };

  const list = document.createElement("div");
  list.className = "settings-font-list";

  // ── 그릴 행 전부를 먼저 세운다(특수 행 포함) — 구역 나누기·선택 행 끌어올리기가 같은
  // 목록 위에서 이뤄지게. "시스템 기본"(폰트 미지정)은 맨 앞, 목록 밖 저장값은 "사용자 지정"
  // 으로 보존한다(둘 다 플러그인 공급분과 같은 성격이라 system 표시를 달지 않는다).
  const pickerRows: FontRow[] = [
    { stack: null, label: t("settings.font.system-default-label") },
    ...families,
    ...(selected !== null && !families.some((f) => f.stack === selected)
      ? [{ stack: selected, label: t("settings.font.custom-label") }]
      : []),
  ];

  // ── 구역 — 설치 글꼴을 붙이면 300행이 넘는다. 지금 고른 글꼴을 맨 위로 올리고 나머지를
  // 「기본」·「한글」·「설치된 글꼴」로 나눈다. 구역이 하나뿐이면(설치 글꼴 없음) 머리글을
  // 그리지 않아 지금까지와 똑같은 목록으로 보인다. 각 구역은 자기 행들을 쥐고 있다가,
  // 검색으로 행이 전부 숨으면 머리글도 함께 숨는다(빈 머리글이 떠 있지 않게).
  const groups = groupFontRows(pickerRows, selected);
  const sections: {
    head: HTMLElement | null;
    count: HTMLElement | null;
    from: number;
    to: number;
  }[] = [];
  for (const group of groups) {
    const from = rows.length;
    const head =
      groups.length > 1 ? document.createElement("div") : /* 단일 구역 */ null;
    let count: HTMLElement | null = null;
    if (head) {
      head.className = "settings-font-grouphead";
      const name = document.createElement("span");
      name.textContent = group.title;
      count = document.createElement("span");
      count.className = "settings-font-groupcount";
      count.textContent = String(group.rows.length);
      head.append(name, count);
      list.append(head);
    }
    for (const entry of group.rows)
      list.append(addRow(entry.stack, entry.label, entry.alias));
    sections.push({ head, count, from, to: rows.length });
  }
  syncSelected();

  // 검색 — 폰트가 많을 때만 노출한다(적으면 노이즈). 라벨로 필터.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "settings-font-search";
  search.placeholder = t("settings.font.search-placeholder");
  search.setAttribute("aria-label", t("settings.font.search-placeholder"));
  search.hidden = rows.length <= FONT_LIST_LONG_ROWS;
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const { row, search: haystack } of rows)
      row.hidden = q !== "" && !haystack.includes(q);
    // 머리글의 개수는 "지금 보이는 수"다 — 걸러 놓고 전체 수를 달아 두면 숫자가 거짓말을 한다.
    // 한 구역이 통째로 숨으면 머리글도 함께 숨는다(빈 머리글이 떠 있지 않게).
    for (const { head, count, from, to } of sections) {
      const visible = rows.slice(from, to).filter(({ row }) => !row.hidden);
      if (head) head.hidden = visible.length === 0;
      if (count) count.textContent = String(visible.length);
    }
  });
  toolbar.append(search);

  section.append(list);
  return section;
}

/** 테마 색 편집기 토큰 한 줄 — 키·그룹·라벨·용도 힌트. */
interface ThemeColorField {
  key: string;
  group: string;
  label: string;
  use: string;
}

/**
 * 테마 색 편집기에 노출할 토큰(의미색 + 표면 라이트/다크) — 키·그룹·라벨·용도 힌트.
 *
 * 함수인 이유: 소비 지점(`buildThemeColorEditor`)이 호출될 때마다(=테마 페이지를 그릴 때마다)
 * 다시 평가해 `t()`가 그 순간의 활성 로케일을 읽게 한다. 모듈 상단 `const`로 한 번만 구우면
 * 이 창이 로드되는 시점(`setActiveLocale()`보다 항상 먼저)의 로케일로 group·label·use가
 * 영원히 고정된다(§i18n 규약).
 */
const THEME_COLOR_FIELDS = (): ThemeColorField[] => [
  {
    key: "accent",
    group: t("settings.theme.group-semantic"),
    label: t("settings.theme.label-accent"),
    use: t("settings.theme.use-accent"),
  },
  {
    key: "danger",
    group: t("settings.theme.group-semantic"),
    label: t("settings.theme.label-danger"),
    use: t("settings.theme.use-danger"),
  },
  {
    key: "warning",
    group: t("settings.theme.group-semantic"),
    label: t("settings.theme.label-warning"),
    use: t("settings.theme.use-warning"),
  },
  // 표면 토큰 — 크롬 배경/카드/테두리/글자. 라이트·다크를 따로 편집한다(시스템 외관을 따르므로).
  {
    key: "surface",
    group: t("settings.theme.group-surface-light"),
    label: t("settings.theme.label-surface"),
    use: t("settings.theme.use-surface-light"),
  },
  {
    key: "card",
    group: t("settings.theme.group-surface-light"),
    label: t("settings.theme.label-card"),
    use: t("settings.theme.use-card-light"),
  },
  {
    key: "border",
    group: t("settings.theme.group-surface-light"),
    label: t("settings.theme.label-border"),
    use: t("settings.theme.use-border-light"),
  },
  {
    key: "text",
    group: t("settings.theme.group-surface-light"),
    label: t("settings.theme.label-text"),
    use: t("settings.theme.use-text-light"),
  },
  {
    key: "surface-dark",
    group: t("settings.theme.group-surface-dark"),
    label: t("settings.theme.label-surface"),
    use: t("settings.theme.use-surface-dark"),
  },
  {
    key: "card-dark",
    group: t("settings.theme.group-surface-dark"),
    label: t("settings.theme.label-card"),
    use: t("settings.theme.use-card-dark"),
  },
  {
    key: "border-dark",
    group: t("settings.theme.group-surface-dark"),
    label: t("settings.theme.label-border"),
    use: t("settings.theme.use-border-dark"),
  },
  {
    key: "text-dark",
    group: t("settings.theme.group-surface-dark"),
    label: t("settings.theme.label-text"),
    use: t("settings.theme.use-text-dark"),
  },
  // 노트 목록·검색 패널 창 — 표면 토큰과 갈라 둔 별도 그룹. 라이트/다크를 따로 쪼개지 않고
  // 배경·글자를 각각 (라이트, 다크) 짝으로 잇달아 두는 이유: 항목이 4개뿐이라 한 그룹에서
  // "배경 두 짝 · 글자 두 짝"으로 보는 편이 두 그룹을 오가는 것보다 짧다.
  {
    key: "panel",
    group: t("settings.theme.group-panel"),
    label: t("settings.theme.label-panel"),
    use: t("settings.theme.use-panel-light"),
  },
  {
    key: "panel-dark",
    group: t("settings.theme.group-panel"),
    label: t("settings.theme.label-panel"),
    use: t("settings.theme.use-panel-dark"),
  },
  {
    key: "panel-text",
    group: t("settings.theme.group-panel"),
    label: t("settings.theme.label-panel-text"),
    use: t("settings.theme.use-panel-text-light"),
  },
  {
    key: "panel-text-dark",
    group: t("settings.theme.group-panel"),
    label: t("settings.theme.label-panel-text"),
    use: t("settings.theme.use-panel-text-dark"),
  },
];

/**
 * 토큰 키 → 편집기가 라이브 미리보기로 얹는 CSS 변수명.
 * 표면 라이트(`surface`)는 `--memo-surface-light`, 다크(`surface-dark`)는 `--memo-surface-dark`,
 * 의미색(`accent`)은 `--memo-accent`. applyTheme의 매핑과 동일하다.
 */
function cssVarForToken(key: string): string {
  return isSurfaceToken(key) ? `--memo-${key}-light` : `--memo-${key}`;
}

/** [`buildThemeColorEditor`] 인자 — baseline(테마 원본)·현재 오버라이드·확정 저장 콜백. */
interface ThemeColorEditorArgs {
  /** 설정창 루트 — 라이브 미리보기를 위해 여기 CSS 변수를 즉시 갱신한다(미리보기가 상속). */
  host: HTMLElement;
  /** 테마 원본 팔레트(오버라이드가 없을 때의 값 = 리셋 목적지). 표면 토큰은 `-dark` 키도 포함. */
  baseline: Record<string, string>;
  /** 현재 활성 테마의 사용자 오버라이드(토큰 → hex). */
  overrides: Record<string, string>;
  /** 오버라이드 확정 변경 시 호출(활성 테마의 오버라이드 맵 전체 — 저장 트리거). */
  onChange: (overrides: Record<string, string>) => void;
}

/**
 * 테마 색 편집기를 만든다(VSCode식 — 테마 기본 팔레트 위에 토큰별 색을 덮어쓴다).
 *
 * 역할: 토큰마다 색 피커(hex)·개별 리셋(오버라이드일 때만 노출)·"모두 초기화"를 주고, 작은
 * 미리보기(강조 링크·저장/삭제 버튼)로 결과를 보여 준다. 드래그 중(input)엔 설정창 루트 CSS
 * 변수만 즉시 바꿔 라이브 반영하고(저장 X), 값을 놓을 때(change)·리셋에서만 onChange로 확정
 * 저장한다(노트 배경 커스텀 색과 같은 input/commit 분리 — 드래그 중 잦은 파일쓰기 방지).
 * 왜: 테마가 준 색을 사용자가 부분 수정하게 하되, 라이브 피드백과 영속화 비용을 분리한다.
 */
function buildThemeColorEditor(args: ThemeColorEditorArgs): HTMLElement {
  const { host, baseline, onChange } = args;
  const overrides: Record<string, string> = { ...args.overrides };

  const section = document.createElement("section");
  section.className = "settings-color-editor";
  const heading = document.createElement("div");
  heading.className = "settings-title";
  heading.textContent = t("settings.theme.color-heading");
  section.append(heading);

  /** 토큰의 실효 색 — 오버라이드가 있으면 그 값, 없으면 테마 baseline. */
  const effective = (key: string): string =>
    overrides[key] ?? baseline[key] ?? THEME_TOKEN_DEFAULTS[key] ?? "#000000";
  /** 설정창 루트의 해당 CSS 변수를 실효 색으로 갱신(미리보기·설정 크롬이 상속). */
  const applyVar = (key: string): void =>
    host.style.setProperty(cssVarForToken(key), effective(key));

  const syncers: (() => void)[] = [];

  // ── 미리보기(상단) — 설정창 루트의 --memo-* 변수를 상속해 색을 실시간 반영한다(별도 상태 없음). ──
  const preview = document.createElement("div");
  preview.className = "settings-color-preview";
  const pvText = document.createElement("div");
  pvText.className = "settings-color-preview-text";
  const pvLink = document.createElement("span");
  pvLink.className = "settings-color-preview-link";
  pvLink.textContent = t("settings.theme.preview-link");
  pvText.append(
    document.createTextNode(t("settings.theme.preview-text")),
    pvLink,
  );
  const pvBtns = document.createElement("div");
  pvBtns.className = "settings-color-preview-btns";
  const pvPrimary = document.createElement("span");
  pvPrimary.className = "settings-color-preview-primary";
  pvPrimary.textContent = t("settings.theme.preview-save");
  const pvDanger = document.createElement("span");
  pvDanger.className = "settings-color-preview-danger";
  pvDanger.textContent = t("settings.theme.preview-delete");
  const pvWarn = document.createElement("span");
  pvWarn.className = "settings-color-preview-warning";
  pvWarn.textContent = t("settings.theme.preview-approval-needed");
  pvBtns.append(pvPrimary, pvDanger, pvWarn);
  preview.append(pvText, pvBtns);
  section.append(preview);

  // ── 도구줄 — 검색 + 모두 초기화. ──
  const toolbar = document.createElement("div");
  toolbar.className = "settings-color-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "settings-color-search";
  search.placeholder = t("settings.theme.color-search-placeholder");
  search.setAttribute(
    "aria-label",
    t("settings.theme.color-search-aria-label"),
  );
  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.className = "settings-color-resetall";
  resetAll.textContent = t("settings.theme.reset-all");
  toolbar.append(search, resetAll);
  section.append(toolbar);

  /** 모든 행 동기화 + "모두 초기화" 노출 여부를 현재 오버라이드 상태에 맞춘다. */
  const refresh = (): void => {
    for (const sync of syncers) sync();
    resetAll.hidden = !ALL_TOKEN_KEYS.some((k) => overrides[k] !== undefined);
  };

  // ── 토큰 목록(스크롤) — 카테고리 그룹으로 묶는다. ──
  const list = document.createElement("div");
  list.className = "settings-color-list";
  section.append(list);

  // 검색 필터를 위해 행·그룹을 추적한다(빈 그룹 헤더는 검색 시 숨긴다).
  const rowItems: {
    field: ThemeColorField;
    row: HTMLElement;
  }[] = [];
  const groupItems: { header: HTMLElement; rows: HTMLElement[] }[] = [];
  let group: { name: string; rows: HTMLElement[] } | null = null;

  const themeColorFields = THEME_COLOR_FIELDS();
  for (const field of themeColorFields) {
    if (!group || group.name !== field.group) {
      const header = document.createElement("div");
      header.className = "settings-color-group";
      header.textContent = field.group;
      list.append(header);
      group = { name: field.group, rows: [] };
      groupItems.push({ header, rows: group.rows });
    }

    const row = document.createElement("div");
    row.className = "settings-color-row";

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "settings-color-swatch";
    swatch.setAttribute(
      "aria-label",
      t("settings.theme.swatch-aria-label", { label: field.label }),
    );

    const meta = document.createElement("div");
    meta.className = "settings-color-meta";
    const name = document.createElement("div");
    name.className = "settings-color-name";
    name.textContent = field.label;
    const keyTag = document.createElement("span");
    keyTag.className = "settings-color-key";
    keyTag.textContent = field.key;
    name.append(keyTag);
    const use = document.createElement("div");
    use.className = "settings-color-use";
    use.textContent = field.use;
    meta.append(name, use);

    const hex = document.createElement("code");
    hex.className = "settings-color-hex";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-color-reset";
    reset.textContent = "↺";
    reset.title = t("settings.theme.reset-token-label", { label: field.label });
    reset.setAttribute(
      "aria-label",
      t("settings.theme.reset-token-label", { label: field.label }),
    );

    syncers.push(() => {
      const value = effective(field.key);
      swatch.value = value;
      hex.textContent = value.toUpperCase();
      const modified = overrides[field.key] !== undefined;
      reset.hidden = !modified; // 리셋은 오버라이드일 때만
      row.classList.toggle("is-modified", modified); // 왼쪽 "수정됨" 바
    });

    // 드래그 중(input): 라이브 반영만(저장 X). 놓을 때(change)·리셋: 확정 저장.
    swatch.addEventListener("input", () => {
      overrides[field.key] = swatch.value;
      applyVar(field.key);
      refresh();
    });
    swatch.addEventListener("change", () => {
      overrides[field.key] = swatch.value;
      applyVar(field.key);
      refresh();
      onChange({ ...overrides });
    });
    reset.addEventListener("click", () => {
      delete overrides[field.key];
      applyVar(field.key); // baseline으로 복귀
      refresh();
      onChange({ ...overrides });
    });

    row.append(swatch, meta, hex, reset);
    list.append(row);
    rowItems.push({ field, row });
    group.rows.push(row);
  }

  // 검색: 라벨·키·용도에 질의가 들어간 행만 보이고, 모두 숨은 그룹 헤더도 숨긴다.
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const { field, row } of rowItems) {
      const hay = `${field.label} ${field.key} ${field.use}`.toLowerCase();
      row.hidden = q !== "" && !hay.includes(q);
    }
    for (const g of groupItems) g.header.hidden = g.rows.every((r) => r.hidden);
  });

  resetAll.addEventListener("click", () => {
    for (const key of Object.keys(overrides)) delete overrides[key];
    for (const key of ALL_TOKEN_KEYS) applyVar(key);
    refresh();
    onChange({});
  });

  // 초기 진입에도 미리보기·설정 크롬이 현재 실효 색과 일치하도록 한 번 칠한다(활성 테마
  // 디스크립터를 아직 못 받은 상태에서도 기존 오버라이드가 즉시 보이게).
  for (const field of themeColorFields) applyVar(field.key);
  refresh();
  return section;
}

/** 마스터 목록 콜백(행 수준 — 활성 토글·재승인 프롬프트·상세 열기). */
interface MasterActions {
  setEnabled(id: string, enabled: boolean): void;
  /** "이 기기에서 권한 승인 필요" 재승인 프롬프트 열기. */
  approve(plugin: InstalledPlugin): void;
  /**
   * "예약이 풀린 권한" 재승인 프롬프트 열기. `available`은 [`reservedRegrant`]가 뽑은
   * 지금 사용 가능해진 권한 — 렌더가 보여준 것과 같은 값을 그대로 넘겨, 목록이 안내한 권한과
   * 실제로 부여되는 권한이 어긋날 수 없게 한다.
   */
  approveReserved(plugin: InstalledPlugin, available: string[]): void;
  /** 행의 이름을 눌러 상세 뷰를 연다. */
  open(plugin: InstalledPlugin): void;
}

/** 상세 뷰 콜백(뒤로·부여·설정·업데이트 확인·제거·README 링크). */
interface DetailActions {
  back(): void;
  setGranted(id: string, permission: string, granted: boolean): void;
  /** 이 플러그인의 설정 페이지(설정 트리 노드)를 연다 — 설정은 트리가 정본, 상세엔 링크만. */
  openSettings(item: PluginDetailItem): void;
  checkUpdate(plugin: InstalledPlugin): void;
  remove(id: string): void;
  /**
   * 개발자 모드 토글(로컬 폴더 사이드로드 한정) — `on`이면 `id`의 폴더 감시를 켜고
   * (세션 한정 싱글턴이라 이전 감시 대상은 자동 대체), false면 끈다.
   */
  setDevMode(id: string, on: boolean): void;
  /** README의 https 링크를 외부 브라우저로 연다. */
  openLink(url: string): void;
  /** README의 로컬 이미지 경로 → 로드 URL(플러그인 폴더 파일만). 외부/미해석이면 null. */
  resolveImage(src: string): string | null;
}

/** 설정 필드 제목 라벨(모든 타입 공용). */
function settingLabel(text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "plugin-setting-label";
  s.textContent = text;
  return s;
}

/** 설정 필드 도움말(제목 바로 아래 — guidance-before-input). */
function settingDesc(text: string): HTMLElement {
  const d = document.createElement("small");
  d.className = "plugin-setting-desc";
  d.textContent = text;
  return d;
}

/**
 * 설정 페이지 상단 머리말(제목 + 선택 소개 문구) — 모든 설정 페이지가 같은 제목 언어를 쓰게 한다.
 * 플러그인 페이지·글꼴 페이지가 공유해 일관성을 준다.
 */
function buildSettingsPageHead(title: string, desc?: string): HTMLElement {
  const head = document.createElement("header");
  head.className = "settings-page-head";
  const h = document.createElement("h2");
  h.className = "settings-page-title";
  h.textContent = title;
  head.append(h);
  if (desc) {
    const p = document.createElement("p");
    p.className = "settings-page-desc";
    p.textContent = desc;
    head.append(p);
  }
  return head;
}

/** 단축키 탭 안의 섹션 소제목(노트 도구 / 플러그인 동작 / 전역). */
function shortcutSection(title: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "shortcut-section";
  h.textContent = title;
  return h;
}

/** 단축키 행 하나의 설정(창 단위·전역 공용 — capture/format만 다르다). */
interface ShortcutRowConfig {
  /** 동작 라벨. */
  label: string;
  /** 현재 바인딩(창 단위 또는 Tauri accel). 없으면 빈 문자열. */
  accel: string;
  /** 같은 조합을 다른 동작도 써서 겹침을 경고할지. */
  conflict?: boolean;
  /** 보조 안내(예: "관련 플러그인이 켜져 있을 때 동작"). */
  note?: string;
  /** 있으면 "기본" 복원 버튼을 노출(그 accel로 되돌림). */
  defaultAccel?: string;
  /** 지우기(해제) 허용 여부. 전역 단축키는 항상 하나를 유지하므로 false. 기본 true. */
  clearable?: boolean;
  /** KeyboardEvent → accel(무효/수식키 단독이면 null — 계속 대기). */
  capture(e: KeyboardEvent): string | null;
  /** 새 accel(지움=null) 확정 콜백. */
  onSet(accel: string | null): void;
  /** accel → 사람이 읽는 라벨. */
  format(accel: string): string;
}

/**
 * 단축키 한 줄(라벨 + 녹화 버튼 + 지우기/기본 복원)을 만든다.
 *
 * 녹화 버튼을 누르면 다음 키 조합을 캡처한다(수식키 단독은 무시하고 대기, Esc 취소,
 * Backspace/Delete로 해제). 확정/해제는 `onSet`으로 위임하며, 보통 페이지를 다시 그려 반영한다.
 */
function buildShortcutRow(cfg: ShortcutRowConfig): HTMLElement {
  const row = document.createElement("div");
  row.className = "shortcut-row";

  const main = document.createElement("div");
  main.className = "shortcut-row-main";
  const label = document.createElement("span");
  label.className = "shortcut-label";
  label.textContent = cfg.label;
  main.append(label);
  if (cfg.note) {
    const n = document.createElement("small");
    n.className = "shortcut-note";
    n.textContent = cfg.note;
    main.append(n);
  }
  if (cfg.conflict) {
    const w = document.createElement("small");
    w.className = "shortcut-warn";
    w.textContent = t("settings.shortcuts.conflict-warning");
    main.append(w);
  }

  const controls = document.createElement("div");
  controls.className = "shortcut-row-controls";

  const rec = document.createElement("button");
  rec.type = "button";
  rec.className = "shortcut-record";
  const idleText = (): string =>
    cfg.accel ? cfg.format(cfg.accel) : t("settings.shortcuts.idle-none");
  rec.textContent = idleText();
  rec.title = t("settings.shortcuts.record-title");

  let recording = false;
  const stop = (): void => {
    recording = false;
    rec.classList.remove("recording");
    rec.textContent = idleText();
  };
  rec.addEventListener("click", () => {
    recording = true;
    rec.classList.add("recording");
    rec.textContent = t("settings.shortcuts.recording-label");
    rec.focus();
  });
  rec.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stop();
      rec.blur();
      return;
    }
    if (
      (e.key === "Backspace" || e.key === "Delete") &&
      cfg.clearable !== false
    ) {
      recording = false;
      rec.classList.remove("recording");
      cfg.onSet(null);
      return;
    }
    const accel = cfg.capture(e);
    if (!accel) return; // 수식키 단독 등 — 계속 대기.
    recording = false;
    rec.classList.remove("recording");
    cfg.onSet(accel);
  });
  rec.addEventListener("blur", stop);
  controls.append(rec);

  if (cfg.defaultAccel && cfg.accel !== cfg.defaultAccel) {
    const def = document.createElement("button");
    def.type = "button";
    def.className = "shortcut-secondary";
    def.textContent = t("settings.shortcuts.default-button");
    def.title = t("settings.shortcuts.default-title", {
      accel: cfg.format(cfg.defaultAccel),
    });
    def.addEventListener("click", () => cfg.onSet(cfg.defaultAccel ?? null));
    controls.append(def);
  }
  if (cfg.clearable !== false && cfg.accel) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "shortcut-secondary shortcut-clear";
    clear.textContent = "✕";
    clear.setAttribute("aria-label", t("settings.shortcuts.clear-label"));
    clear.title = t("settings.shortcuts.clear-label");
    clear.addEventListener("click", () => cfg.onSet(null));
    controls.append(clear);
  }

  row.append(main, controls);
  return row;
}

/**
 * 액션 버튼 한 번을 실행하는 정책 함수 — 위젯이 아니라 [`mountSettings`]가 소유한다.
 *
 * `say`를 **인자로 받는** 이유: 반환 문구는 "요청을 보냈다"까지밖에 말할 수 없는데(명령은
 * 샌드박스에서 비동기로 돈다), 실행 결과는 그보다 늦게 진단 채널로 도착한다. 반환값만으로는
 * 늦게 온 결과를 그릴 자리가 없어 상태 줄이 영영 "요청했어요"에 멈춘다 — 그래서 위젯이 자기
 * 상태 줄을 쓰는 손잡이를 정책 층에 빌려준다(DOM 소유권은 위젯에 남는다).
 */
type SettingActionRunner = (
  field: PluginSettingField,
  say: (text: string) => void,
) => Promise<string>;

/**
 * 한 설정 필드의 입력 위젯을 만든다(text/textarea/toggle/select/list/number/button).
 *
 * 역할: 스키마 필드 하나를 현재 값으로 초기화한 입력으로 렌더하고, 값이 바뀌면 즉시
 * `onChange(value)`를 호출한다. 라벨 → (도움말) → 컨트롤 순으로 세로로 쌓되, toggle만 좌측
 * 라벨 + 우측 스위치의 인라인 행이다. list는 여러 항목 카드 편집기([`buildListEditor`])로 위임.
 * `button`만 값을 갖지 않는다 — `onChange` 대신 `onAction`을 부르고, 그 결과 문구를
 * 버튼 아래 상태 줄에 그린다.
 * 왜: 샌드박스 플러그인이 못 그리는 설정 UI를 호스트가 선언형 스키마로 대신 그린다. 설치·번들
 * 플러그인이 같은 위젯 로직을 공유하도록 저장 대상(plugin) 대신 값·콜백만 받는다.
 */
export function buildSettingField(
  field: PluginSettingField,
  current: unknown,
  onChange: (value: unknown) => void,
  onAction?: SettingActionRunner,
  confirmReset?: (itemLabel: string) => Promise<boolean>,
): HTMLElement {
  // list — 여러 항목 카드 편집기(다른 타입과 레이아웃이 달라 별도 함수로 위임).
  if (field.type === "list") {
    return buildListEditor(field, current, onChange, confirmReset);
  }
  // button — 값이 없는 필드. 확인·실행·상태 표시는 전부 여기서 끝난다.
  if (field.type === "button") {
    return buildActionButton(field, onAction);
  }

  const row = document.createElement("label");
  row.className = "plugin-setting";
  row.dataset.type = field.type;

  if (field.type === "toggle") {
    // 좌측: 라벨(+도움말) / 우측: 스위치. 실제 체크박스 + 트랙/썸으로 폼 시맨틱·포커스링 유지.
    row.classList.add("plugin-setting--toggle");
    const text = document.createElement("span");
    text.className = "plugin-setting-toggletext";
    text.append(settingLabel(field.label));
    if (field.description) text.append(settingDesc(field.description));

    const sw = document.createElement("span");
    sw.className = "plugin-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "plugin-switch-input";
    input.checked = current === true;
    input.addEventListener("change", () => onChange(input.checked));
    const track = document.createElement("span");
    track.className = "plugin-switch-track";
    const thumb = document.createElement("span");
    thumb.className = "plugin-switch-thumb";
    track.append(thumb);
    sw.append(input, track);

    row.append(text, sw);
    return row;
  }

  row.append(settingLabel(field.label));
  if (field.description) row.append(settingDesc(field.description));

  if (field.type === "select") {
    const select = document.createElement("select");
    select.className = "plugin-setting-input plugin-setting-select";
    // 저장 값은 언제나 `value`, 사용자에게 보이는 것은 `label`이다. 축약형 `string[]`은
    // value=label로 정규화되므로 기존 매니페스트의 화면은 그대로다.
    for (const opt of settingOptions(field)) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.description) option.title = opt.description;
      if (opt.value === current) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => onChange(select.value));
    row.append(select);
    return row;
  }

  if (field.type === "number") {
    // 값은 언제나 number로 넘긴다(플러그인 계약). 입력 도중의 빈 문자열·비수치는 흘려보내고
    // 마지막 유효 값을 유지한다 — ""를 그대로 저장하면 플러그인이 NaN을 받는다.
    const input = document.createElement("input");
    input.type = "number";
    input.className = "plugin-setting-input plugin-setting-number";
    input.value = typeof current === "number" ? String(current) : "";
    if (typeof field.min === "number") input.min = String(field.min);
    if (typeof field.max === "number") input.max = String(field.max);
    if (typeof field.step === "number") input.step = String(field.step);
    input.addEventListener("input", () => {
      const n = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(n)) return;
      const lo = typeof field.min === "number" ? Math.max(n, field.min) : n;
      onChange(typeof field.max === "number" ? Math.min(lo, field.max) : lo);
    });
    row.append(input);
    return row;
  }

  if (field.type === "textarea") {
    // 여러 줄 입력 — monospace·세로 리사이즈.
    const area = document.createElement("textarea");
    area.className = "plugin-setting-input plugin-setting-textarea";
    area.rows = 6;
    area.value = current == null ? "" : String(current);
    if (field.placeholder) area.placeholder = field.placeholder;
    const areaPreview = buildTokenPreview(area.value);
    area.addEventListener("input", () => {
      onChange(area.value);
      areaPreview.update(area.value);
    });
    row.append(area, areaPreview.el);
    return row;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "plugin-setting-input";
  input.value = current == null ? "" : String(current);
  if (field.placeholder) input.placeholder = field.placeholder;
  const preview = buildTokenPreview(input.value);
  input.addEventListener("input", () => {
    onChange(input.value);
    preview.update(input.value);
  });
  row.append(input, preview.el);
  return row;
}

/**
 * 치환 미리보기가 채워 넣는 **임시 값** — 호스트가 아는 토큰만, 호스트의 어휘로 채운다.
 *
 * 왜 플러그인이 선언하지 않나: `{path}`·`{content}`는 플러그인이 발명한 말이 아니라 **이 앱의
 * 개념**이다(노트 파일 경로·본문). 호스트가 이미 뜻을 아는 것을 굳이 매니페스트로 다시 받으면
 * 저작 계약만 늘고 값은 그대로다. 모르는 토큰(`{foo}`)은 **건드리지 않는다** — 아는 것이
 * 하나도 없으면 미리보기 자체를 안 그리므로, 다른 뜻으로 `{foo}`를 쓰는 플러그인에게 거짓
 * 미리보기를 보여 줄 일이 없다.
 *
 * 값이 진짜가 아니라 임시인 이유: 설정 창에는 노트가 없다(그 사실이 이 화면의 모든 것을
 * 규정한다 — 액션 버튼이 걷힌 이유이기도 하다). 어차피 확인하려는 것은 "변수를 맞게
 * 썼는가, 줄바꿈이 어떻게 되는가"라서 그럴듯한 예시 값이면 답이 나온다.
 *
 * 함수인 이유: `t()`가 **호출 시점의** 활성 로케일을 읽어야 한다(모듈 상단 const로 구우면 이
 * 창이 로드되는 시점의 로케일로 영원히 고정된다 — §i18n 규약).
 */
const PREVIEW_TOKENS = (): Record<string, string> => ({
  "{path}": t("settings.setting-preview.sample-path"),
  "{content}": t("settings.setting-preview.sample-content"),
});

/** 미리보기 한 줄의 최대 길이(자) — 본문 토큰이 들어가면 길어질 수 있어 잘라 준다. */
const PREVIEW_MAX_LEN = 300;

/**
 * 값에 든 **아는 토큰**을 임시 값으로 바꿔 돌려준다. 아는 토큰이 하나도 없으면 `null`
 * (= 미리보기를 그리지 않는다 — 치환할 것이 없으면 입력을 그대로 되뇌는 소음일 뿐이다).
 */
function substitutePreviewTokens(value: string): string | null {
  const tokens = PREVIEW_TOKENS();
  const hit = Object.keys(tokens).some((token) => value.includes(token));
  if (!hit) return null;
  let out = value;
  for (const [token, sample] of Object.entries(tokens)) {
    out = out.split(token).join(sample);
  }
  return out.length > PREVIEW_MAX_LEN
    ? out.slice(0, PREVIEW_MAX_LEN) + "…"
    : out;
}

/**
 * 입력 아래에 붙는 치환 미리보기 줄 — 타이핑마다 갱신된다.
 *
 * 왜 필요한가: `{path}`라고 쓴 사람이 그것이 무엇으로 바뀌는지 확인할 방법이 설명글밖에
 * 없었다. 예전엔 「지금 복사해 보기」 버튼이 그 답을 맡았는데, 그 버튼은 메모 창에서 그
 * 플러그인을 한 번 써야만 동작해서(창 컨텍스트 폴백) 시험하려는 일을 먼저 해야 하는
 * 자기모순이었다. 답이 실행에 매여 있을 이유가 없다 — 치환은 순수 문자열 연산이다.
 *
 * 줄바꿈을 보존한다(`pre-wrap`): 여러 줄 문구가 어떻게 접히는지도 확인 대상이다.
 */
function buildTokenPreview(initial: string): {
  el: HTMLElement;
  update: (value: string) => void;
} {
  // 도움말과 같은 흐린 톤이지만 클래스는 따로 쓴다 — `plugin-setting-desc`를 같이 걸면
  // "설명 없는 필드에는 도움말이 안 붙는다"는 계약이 이 줄 때문에 깨진다(그 가드가 있다).
  const el = document.createElement("small");
  el.className = "plugin-setting-preview";
  const update = (value: string): void => {
    const filled = substitutePreviewTokens(value);
    // 플러그인이 만든 문자열이 섞이는 자리다 — 반드시 textContent로만 넣는다.
    el.textContent =
      filled === null
        ? ""
        : t("settings.setting-preview.line", { text: filled });
    el.hidden = filled === null;
  };
  update(initial);
  return { el, update };
}

/**
 * 설정 화면 액션 버튼 한 개(`type: "button"`): 도움말 + 버튼 + 상태 줄.
 *
 * 역할: 누르면 `onAction`을 부르고, 그 사이 버튼을 잠그고, 돌아온 문구를 버튼 아래
 * 상태 줄에 그린다(빈 문자열이면 아무것도 안 그린다 — 확인 취소가 그 경우다). 같은 상태 줄에
 * 쓰는 손잡이(`say`)를 `onAction`에 넘겨, 반환 뒤에 도착하는 실행 결과도 이 자리에 얹힌다.
 * 왜: 이 버튼은 **플러그인 코드를 실행하는 첫 설정 위젯**이다. 눌렀는데 화면이 그대로면
 * 사용자는 눌린 건지조차 모른다 — 그래서 결과 문구를 그리는 자리가 위젯 자체에 있다.
 * 값을 저장하지 않으므로 `<label>`이 아니라 `<div>`다(라벨은 버튼 위에 얹혀 있다).
 */
function buildActionButton(
  field: PluginSettingField,
  onAction?: SettingActionRunner,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plugin-setting plugin-setting--button";
  row.dataset.type = "button";
  row.dataset.key = field.key;

  const line = document.createElement("div");
  line.className = "plugin-setting-actionline";
  if (field.description) line.append(settingDesc(field.description));

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plugin-action-button";
  btn.textContent = field.label;

  const status = document.createElement("small");
  status.className = "plugin-setting-status";
  // 상태가 늦게 나타나므로 스크린리더가 읽도록 라이브 리전으로 둔다.
  status.setAttribute("role", "status");

  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === "";
  };
  say("");

  // `command` 없는 button은 매니페스트 검증(TS·Rust·JSON Schema)이 이미 거부한다 — 여기
  // 오는 경로는 (a) 검증을 우회한 주입이거나 (b) `onAction` 미배선뿐이다. 둘 다 "눌러도
  // 아무 일이 없다"가 되지 않게 버튼을 잠그고 이유를 적는다(이 저장소가 11번 겪은 모양).
  if (!onAction || !field.command) {
    btn.disabled = true;
    say(t("settings.plugin-action.no-command"));
  } else {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      say(t("settings.plugin-action.running"));
      void onAction(field, say)
        .then(say)
        .catch((e: unknown) => {
          say(
            t("settings.plugin-action.failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        })
        .finally(() => {
          btn.disabled = false;
        });
    });
  }

  line.append(btn);
  row.append(line, status);
  return row;
}

/**
 * 플러그인 설정 스키마를 폼으로 렌더한다(설정 트리의 그 플러그인 페이지 본문 — 값 변경 시 onSet).
 *
 * 역할: 스키마 필드마다 현재 값으로 초기화한 입력([`buildSettingField`])을 세로로 쌓는다.
 * 왜: 예전엔 플러그인 상세 뷰 안에 있던 설정 폼을 트리 페이지로 끄집어낸다(설정=트리가 정본).
 */
function buildPluginSettingsForm(
  schema: PluginSettingField[],
  values: Record<string, unknown>,
  onSet: (key: string, value: unknown) => void,
  onAction: SettingActionRunner,
  confirmReset: (field: PluginSettingField) => Promise<boolean>,
): HTMLElement {
  const form = document.createElement("div");
  form.className = "plugin-settings-form";
  // 폼이 보는 값은 플러그인이 보는 값과 **같은 규칙**으로 병합·정규화한다 — 예전엔
  // `values[key] ?? field.default`라 (a) 번들 경로에서 기본값이 폼에만 보이고 플러그인에는
  // 안 갔고, (b) 구 스키마의 "저장값=라벨"이 select에서 선택 상태로 잡히지 않았다.
  const merged = mergeSettingDefaults(schema, values);
  for (const field of schema) {
    form.append(
      buildSettingField(
        field,
        merged[field.key],
        (v) => onSet(field.key, v),
        onAction,
        () => confirmReset(field),
      ),
    );
  }
  return form;
}

/**
 * 여러 항목을 각각의 카드로 편집하는 위젯(list 필드 전용). 저장 값은 parseListBlob/serializeListBlob로
 * 오가는 동일 블롭 문자열이라, 플러그인 코드·저장 형식은 그대로다.
 *
 * 지원: 항목 추가·이름 변경·본문 편집·삭제(2단계 확인)·복제·순서 변경(드래그 + 키보드)·접기,
 * 그리고 hints가 있으면 키워드 칩을 눌러 커서 위치에 토큰 삽입.
 *
 * `confirmReset`이 있고 `field.default`가 실제 내용(빈 문자열이 아님)이면 "기본값으로
 * 되돌리기" 버튼도 그린다 — 확인 후 현재 항목을 통째로 `field.default`로 갈아 끼운다. 호출부
 * (`pluginPage`)가 이 필드의 `default`를 로케일에 맞게 미리 바꿔치기해 두면(템플릿 플러그인처럼)
 * 되돌리기도 그 로케일 세트로 간다 — 이 위젯 자체는 로케일을 모른다(제네릭).
 */
function buildListEditor(
  field: PluginSettingField,
  current: unknown,
  onChange: (value: unknown) => void,
  confirmReset?: (itemLabel: string) => Promise<boolean>,
): HTMLElement {
  const itemLabel =
    field.itemLabel ?? t("settings.list-field.default-item-label");
  const items = parseListBlob(current);
  const collapsed = new Set<SettingListItem>(); // 접힘 상태(표시 전용 — 직렬화 안 함).
  const commit = (): void => onChange(serializeListBlob(items));

  const editor = document.createElement("div");
  editor.className = "plugin-list-editor";

  const head = document.createElement("div");
  head.className = "plugin-list-head";
  head.append(settingLabel(field.label));
  // 되돌리기 + 추가를 한 그룹으로 묶어 오른쪽에 붙인다 — 둘 다 `margin-left: auto`를 각자
  // 가지면(예전 방식) 플렉스가 남는 공간을 auto 마진 개수만큼 나눠 갖어 둘 사이가 벌어진다.
  const headActions = document.createElement("div");
  headActions.className = "plugin-list-head-actions";
  const defaultBlob = typeof field.default === "string" ? field.default : "";
  if (defaultBlob.trim() !== "") {
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "plugin-list-reset";
    resetBtn.textContent = t("settings.list-field.reset-label");
    resetBtn.addEventListener("click", () => {
      void (async () => {
        const ok = confirmReset ? await confirmReset(itemLabel) : true;
        if (!ok) return;
        const restored = parseListBlob(defaultBlob);
        items.splice(0, items.length, ...restored);
        collapsed.clear();
        commit();
        render();
      })();
    });
    headActions.append(resetBtn);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "plugin-list-add";
  addBtn.textContent = t("settings.list-field.add-button", { itemLabel });
  headActions.append(addBtn);
  head.append(headActions);
  editor.append(head);

  if (field.description) editor.append(settingDesc(field.description));

  // 키워드 칩(hints) — 접힌 <details>. 클릭 시 마지막으로 포커스한 본문의 커서 위치에 토큰 삽입.
  let lastBody: HTMLTextAreaElement | null = null;
  if (field.hints && field.hints.length > 0) {
    const keys = document.createElement("details");
    keys.className = "plugin-list-keys";
    const summary = document.createElement("summary");
    summary.textContent = t("settings.list-field.keywords-summary");
    keys.append(summary);
    const chips = document.createElement("div");
    chips.className = "plugin-list-chips";
    for (const hint of field.hints) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "plugin-key-chip";
      chip.textContent = hint.token;
      if (hint.label) chip.title = hint.label;
      chip.addEventListener("click", () => insertToken(hint.token));
      chips.append(chip);
    }
    keys.append(chips);
    editor.append(keys);
  }

  const list = document.createElement("ol");
  list.className = "plugin-list-items";
  editor.append(list);

  const empty = document.createElement("p");
  empty.className = "plugin-list-empty";
  empty.textContent = t("settings.list-field.empty", { itemLabel });
  editor.append(empty);

  // 마지막으로 포커스한 본문 textarea를 기억(키워드 칩 삽입 대상).
  editor.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("plugin-list-body")) {
      lastBody = t as HTMLTextAreaElement;
    }
  });

  function insertToken(token: string): void {
    const ta =
      lastBody ?? list.querySelector<HTMLTextAreaElement>(".plugin-list-body");
    if (!ta) return; // 항목이 없으면 no-op.
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + token.length;
    ta.dispatchEvent(new Event("input")); // items[i].body 갱신 + commit.
  }

  let dragFrom = -1;
  const clearDropMarks = (): void =>
    list.querySelectorAll(".plugin-list-item").forEach((li) => {
      li.classList.remove("drop-before", "drop-after");
    });

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= items.length || from === to) return;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    commit();
    render(to);
  };

  /** 항목들을 카드로 다시 그린다. focusIdx가 오면 그 항목의 이름 input에 포커스한다. */
  function render(focusIdx = -1): void {
    list.replaceChildren();
    empty.hidden = items.length > 0;
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = "plugin-list-item";
      li.draggable = true;
      if (collapsed.has(item)) li.classList.add("is-collapsed");

      const itemHead = document.createElement("div");
      itemHead.className = "plugin-list-item-head";

      const drag = document.createElement("button");
      drag.type = "button";
      drag.className = "plugin-list-drag";
      drag.setAttribute("aria-label", t("settings.list-field.drag-aria-label"));
      drag.textContent = "⠿";
      drag.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          move(i, i - 1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          move(i, i + 1);
        }
      });

      const name = document.createElement("input");
      name.className = "plugin-list-name";
      name.value = item.name;
      if (field.itemNamePlaceholder)
        name.placeholder = field.itemNamePlaceholder;
      name.addEventListener("input", () => {
        item.name = name.value;
        commit();
      });
      name.addEventListener("blur", () => {
        name.value = sanitizeListName(name.value);
      });

      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.className = "plugin-list-collapse";
      collapse.setAttribute("aria-expanded", String(!collapsed.has(item)));
      collapse.setAttribute(
        "aria-label",
        t("settings.list-field.collapse-aria-label"),
      );
      collapse.textContent = collapsed.has(item) ? "▸" : "▾";
      collapse.addEventListener("click", () => {
        if (collapsed.has(item)) collapsed.delete(item);
        else collapsed.add(item);
        li.classList.toggle("is-collapsed");
        collapse.textContent = collapsed.has(item) ? "▸" : "▾";
        collapse.setAttribute("aria-expanded", String(!collapsed.has(item)));
      });

      const dup = document.createElement("button");
      dup.type = "button";
      dup.className = "plugin-list-dup";
      dup.title = t("settings.list-field.duplicate-label");
      dup.setAttribute("aria-label", t("settings.list-field.duplicate-label"));
      dup.textContent = "⧉";
      dup.addEventListener("click", () => {
        items.splice(i + 1, 0, {
          name: t("settings.list-field.duplicate-name", { name: item.name }),
          body: item.body,
        });
        commit();
        render(i + 1);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "plugin-list-del";
      del.title = t("settings.list-field.delete-label");
      del.setAttribute("aria-label", t("settings.list-field.delete-label"));
      del.textContent = "🗑";
      let armed = false;
      let armTimer: ReturnType<typeof setTimeout> | undefined;
      del.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          del.classList.add("is-armed");
          del.textContent = t("settings.list-field.delete-confirm");
          armTimer = setTimeout(() => {
            armed = false;
            del.classList.remove("is-armed");
            del.textContent = "🗑";
          }, 3000);
          return;
        }
        if (armTimer) clearTimeout(armTimer);
        items.splice(i, 1);
        commit();
        render();
      });

      itemHead.append(drag, name, collapse, dup, del);

      const body = document.createElement("textarea");
      body.className = "plugin-list-body";
      body.rows = 4;
      body.value = item.body;
      if (field.itemBodyPlaceholder)
        body.placeholder = field.itemBodyPlaceholder;
      body.addEventListener("input", () => {
        item.body = body.value;
        commit();
      });

      li.addEventListener("dragstart", (e) => {
        dragFrom = i;
        li.classList.add("is-dragging");
        e.dataTransfer?.setData("text/plain", String(i)); // Firefox는 데이터가 있어야 드래그 시작
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("is-dragging");
        clearDropMarks();
        dragFrom = -1;
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        clearDropMarks();
        const before =
          e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
        li.classList.add(before ? "drop-before" : "drop-after");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        clearDropMarks();
        if (dragFrom < 0) return;
        const before =
          e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
        let to = before ? i : i + 1;
        if (dragFrom < to) to -= 1; // 위에서 아래로 옮길 때 인덱스 보정.
        move(dragFrom, to);
      });

      li.append(itemHead, body);
      list.append(li);
    });
    if (focusIdx >= 0) {
      const nameInput =
        list.querySelectorAll<HTMLInputElement>(".plugin-list-name")[focusIdx];
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
        // scrollIntoView는 jsdom 미구현이라 방어적으로 호출(테스트 환경에서 소음/예외 방지).
        try {
          nameInput.scrollIntoView({ block: "nearest" });
        } catch {
          /* no-op */
        }
      }
    }
  }

  addBtn.addEventListener("click", () => {
    items.push({
      name: t("settings.list-field.new-item-name", { itemLabel }),
      body: "",
    });
    commit();
    render(items.length - 1);
  });

  render();
  return editor;
}

/**
 * 템플릿 번들(`template`)의 로케일별 기본 예시 세트 — main.js의 KO_TEMPLATES/EN_TEMPLATES와
 * 바이트 동일해야 한다(settings.test.ts가 실제 main.js 실행 결과와 대조해 드리프트를 잡는다).
 * 두 파일이 서로 다른 실행 환경(플러그인 샌드박스 vs 설정 창 호스트)이라 부득이 데이터를 나눠
 * 갖는다 — 매니페스트 `default`(KO 3종)는 "저장값 없음"의 유일한 신호로 그대로 둔다(main.js
 * 참고). export하는 이유는 오직 그 드리프트 가드 때문이다 — 다른 소비처는 없다.
 */
export const TEMPLATE_KO_DEFAULT_TEMPLATES: SettingListItem[] = [
  {
    name: "📅 주간회의",
    body:
      "# {week}주차 주간회의 ({today} {weekday})\n\n## 지난주 리뷰\n- {cursor}\n\n" +
      "## 이번주 계획\n-\n\n## 논의사항\n-",
  },
  { name: "📝 데일리", body: "## {today} 데일리 노트\n- 오늘 할 일:" },
  { name: "✅ 회고", body: "# 회고 ({today})\n- Keep:\n- Problem:\n- Try:" },
];

/**
 * 위와 쌍 — 단순 직역이 아니라 영어 사용자에게 같은 성격(주간회의·데일리·회고)으로 자연스러운
 * 예시. 일부러 {weekday}를 쓰지 않는다 — 그 키워드가 채우는 요일명은 main.js의 WEEKDAYS가
 * 한국어 고정이라(콘텐츠 치환은 로케일화 대상이 아니다), 영어 본문에 넣으면 언어가 섞여 나온다.
 */
export const TEMPLATE_EN_DEFAULT_TEMPLATES: SettingListItem[] = [
  {
    name: "📅 Weekly meeting",
    body:
      "# Week {week} meeting ({today})\n\n## Last week's review\n- {cursor}\n\n" +
      "## This week's plan\n-\n\n## Discussion topics\n-",
  },
  { name: "📝 Daily note", body: "## {today} daily note\n- To do today:" },
  { name: "✅ Retro", body: "# Retro ({today})\n- Keep:\n- Problem:\n- Try:" },
];

const TEMPLATE_LOCALE_DEFAULT_TEMPLATES: Record<string, SettingListItem[]> = {
  ko: TEMPLATE_KO_DEFAULT_TEMPLATES,
  en: TEMPLATE_EN_DEFAULT_TEMPLATES,
};
const TEMPLATE_KNOWN_DEFAULT_SETS: SettingListItem[][] = [
  TEMPLATE_KO_DEFAULT_TEMPLATES,
  TEMPLATE_EN_DEFAULT_TEMPLATES,
];

/** 두 템플릿 배열이 이름·본문까지 정확히 같은가(순서 포함, 얕은 비교) — main.js와 같은 규칙. */
function sameTemplateList(a: SettingListItem[], b: SettingListItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((it, i) => it.name === b[i].name && it.body === b[i].body)
  );
}

/**
 * `template` 번들의 `templates` 저장값을 설정 창에서 보일 형태로 로케일화한다(main.js
 * `localizeTemplates`와 같은 규칙 — 저장값이 "아직 아무도 손대지 않은 기본 세트"(ko든 en이든,
 * 예: 다른 로케일에서 «기본값으로 되돌리기»를 눌러 그 언어로 저장됐을 수도 있다)와 바이트
 * 동일할 때만 활성 로케일 세트로 바꾼다). 실제로 한 글자라도 고쳐 저장한 값은 그대로 나간다.
 * `blob`이 `undefined`(저장값 자체가 없음)면 손대지 않고 그대로 돌려준다 — 그 경우의 로케일
 * 폴백은 `pluginPages`가 스키마 `default`를 로케일 블롭으로 바꿔치기해 `mergeSettingDefaults`가
 * 대신 채우게 한다(이 함수를 undefined에 대해 부르면 빈 리스트로 굳어 그 경로를 밟지 못한다).
 */
function localizeTemplateBlob(blob: string, locale: string): string {
  const list = parseListBlob(blob);
  const isKnownDefault = TEMPLATE_KNOWN_DEFAULT_SETS.some((set) =>
    sameTemplateList(list, set),
  );
  if (!isKnownDefault) return blob;
  return serializeListBlob(
    TEMPLATE_LOCALE_DEFAULT_TEMPLATES[locale] ?? TEMPLATE_KO_DEFAULT_TEMPLATES,
  );
}

/** 한 권한 배지(저위험/읽기 전용) 또는 부여 토글(민감)을 만든다 — 상세 뷰의 권한 목록용. */
function buildPermissionControl(
  plugin: InstalledPlugin,
  permission: string,
  onGrant: (id: string, permission: string, granted: boolean) => void,
): HTMLElement {
  const info = permissionInfo(permission);
  if (!isSensitive(permission)) {
    const badge = document.createElement("span");
    badge.className = "plugin-perm";
    badge.textContent = info.label;
    if (info.desc) badge.title = info.desc;
    return badge;
  }
  // 민감 권한 → 부여 체크박스(선언됐을 때만 표시되므로 여기서는 켜기/끄기만).
  const label = document.createElement("label");
  label.className = "plugin-perm plugin-perm-sensitive";
  if (info.desc) label.title = info.desc;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "plugin-grant";
  checkbox.checked = plugin.granted.includes(permission);
  checkbox.addEventListener("change", () =>
    onGrant(plugin.id, permission, checkbox.checked),
  );

  const text = document.createElement("span");
  text.textContent = info.label;

  label.append(checkbox, text);
  return label;
}

/** 마스터 행의 이름 버튼(누르면 상세 뷰) — 목록→상세 진입점. */
function buildNameButton(text: string, onOpen: () => void): HTMLElement {
  const name = document.createElement("button");
  name.type = "button";
  name.className = "plugin-name";
  name.textContent = text;
  name.title = t("settings.plugin-list.detail-title");
  name.addEventListener("click", onOpen);
  return name;
}

/**
 * 활성 토글 — 플러그인 설정 폼과 같은 스위치 UI(트랙/썸). 실제 체크박스에 `.plugin-enable-toggle`
 * 클래스를 함께 실어 e2e·유닛의 카운트/조회를 유지한다. input을 돌려줘 호출부가 `.checked`를 읽게 한다.
 */
function buildEnableSwitch(
  checked: boolean,
  disabled: boolean,
  ariaLabel: string,
  onToggle: (v: boolean) => void,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "plugin-enable";
  const sw = document.createElement("span");
  sw.className = "plugin-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "plugin-switch-input plugin-enable-toggle"; // 두 클래스 모두
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute("aria-label", ariaLabel);
  input.addEventListener("change", () => onToggle(input.checked));
  const track = document.createElement("span");
  track.className = "plugin-switch-track";
  const thumb = document.createElement("span");
  thumb.className = "plugin-switch-thumb";
  track.append(thumb);
  sw.append(input, track); // input이 track의 직전 형제 — `+` 셀렉터 유지
  label.append(sw);
  return { label, input };
}

/** 테마 행의 🔒 필수 배지(D3 — 토글 대신 잠금 표시). */
function buildRequiredBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "plugin-required-badge";
  badge.textContent = t("settings.plugin-list.required-badge");
  badge.title = t("settings.plugin-list.required-badge-title");
  return badge;
}

/**
 * 플러그인 OS 지원 배지 — `platforms`를 선언한 플러그인에만 붙는 짧은 마이크로 배지(전 플랫폼이면
 * 없음). 미지원 사유 문장은 이제 행 2번째 줄이 담당하므로, 배지 텍스트는 항상 짧은 OS 라벨이다.
 */
function buildPlatformBadge(
  platforms: string[] | undefined,
  supported: boolean,
): HTMLElement | null {
  const label = describePlatforms(platforms);
  if (!label) return null;
  const badge = document.createElement("span");
  badge.className = supported
    ? "plugin-platform-badge"
    : "plugin-platform-badge plugin-platform-badge--unsupported";
  badge.textContent = label;
  badge.title = supported
    ? t("settings.plugin-list.platform-supported-title", { label })
    : t("settings.plugin-list.platform-unsupported-title");
  return badge;
}

/** 실행 실패 배지 — 다른 상태 배지(🔒 필수·OS 배지)와 같은 결의 짧은 마이크로 배지. 사유는 title 툴팁. */
function buildFailureBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "plugin-failure-badge";
  badge.textContent = t("settings.plugin-list.failure-badge");
  badge.title = t("settings.plugin-list.failure-badge-title");
  return badge;
}

/**
 * 실행 실패 사유를 눈에 띄는 줄로 보인다(OS 미지원 사유 문장과 같은 위치·톤). 사유 문자열은
 * 플러그인(제3자)이 만든 것일 수 있으므로 **반드시 textContent**로만 넣는다(innerHTML 금지 —
 * 신뢰 경계 원칙).
 */
function buildFailureNote(error: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "plugin-desc plugin-desc--failure";
  note.textContent = t("settings.plugin-list.failure-note", { error });
  return note;
}

/** 실패 목록을 pluginId → 사유 맵으로 바꾼다(조회 편의). */
function failureMap(failures: PluginFailure[]): Map<string, string> {
  return new Map(failures.map((f) => [f.pluginId, f.error]));
}

/** 번들 목록 콜백(활성 토글 + 상세 열기). */
interface BuiltinListHandlers {
  onToggle(id: string, enabled: boolean): void;
  onOpen(item: PluginDetailItem): void;
}

/**
 * 번들(1st-party) 목록을 그린다 — 비-테마 플러그인(토글) + 번들 언어팩(토글) + 번들
 * 테마(🔒 필수 잠금).
 *
 * 역할: 각 행은 이름(좌) + 컨트롤(우)로 통일 — 앱 내장 플러그인(위키링크 등)은 우측에
 * 활성/비활성 토글, 번들 테마(sj_d·plain)는 **토글 없이** 우측에 🔒 필수 배지(잠금 사유는
 * 배지 툴팁)로 보인다(D3 — 테마를 끄면 렌더 토큰이 사라지므로 끄는 대상이 아니다). 이미
 * "번들 플러그인" 섹션 아래라 행마다 "번들" 배지는 두지 않는다. 이름을 누르면 상세 뷰가 열린다.
 * 권한·⚙ 설정 폼·README는 상세 뷰가 담당한다(마스터 행은 압축 표시).
 *
 * 이번 호스트 빌드에서 실행 실패한 항목(`failures`)엔 ⚠ 오류 배지 + 사유 줄을 덧붙인다 — 계속
 * "켜짐"으로만 보여 사용자가 왜 안 되는지 알 길이 없던 것을 고친다(중앙 호스트 스냅샷 출처).
 */
export function renderBuiltinList(
  listEl: HTMLElement,
  states: Record<string, boolean>,
  settingsValues: Record<string, Record<string, unknown>>,
  handlers: BuiltinListHandlers,
  /** 현재 OS(""=미상 → 제한 없음). 미지원 번들은 배지 + 토글 비활성으로 표시한다. */
  platform = "",
  /** 이번 빌드에서 실행 실패한 플러그인/테마(중앙 호스트 스냅샷 `failures`). 없으면 표시 없음. */
  failures: PluginFailure[] = [],
  /**
   * 번들 언어팩(`src/plugin/builtin/language-packs/*`)을 [`BuiltinPlugin`] 모양으로 옮긴 것
   * (`packToBuiltin`). `BUILTIN_PLUGINS`에 합류하지 **못하는** 이유는 하나다: 그 배열은 중앙
   * 호스트가 실행할 목록이고, 언어팩은 호스트가 실행하지 않는 데이터 선언이다. 표시만은
   * 같은 목록에 있어야 하므로(사용자에게는 똑같은 "앱에 들어 있는 기능") 여기서 이어붙인다.
   *
   * 이어붙인 뒤의 처리는 기존 코드가 그대로 한다 — 언어팩은 설정 스키마도 플랫폼 제약도
   * 없는 평범한 토글 행이라 분기가 필요 없다(`inferPluginCategory`가 `i18n` 권한을 보고
   * 「언어」 그룹으로 보낸다).
   *
   * 기본값 `[]` — 목록 렌더 자체를 검증하는 기존 호출부는 그대로 둔다(언어팩을 넘기지
   * 않으면 예전과 바이트상 같은 DOM이 나온다).
   */
  languagePacks: BuiltinPlugin[] = [],
): void {
  listEl.replaceChildren();
  const failed = failureMap(failures);
  // 번들 자기 로컬라이즈(축 2) — 호출 시점의 활성 로케일로 한 번 해석한다(§i18n 규약: 이
  // 함수는 렌더 때마다 다시 불리므로 여기서 매번 읽는 것이 곧 "소비 지점에서 해석"이다).
  // nls 없는 번들은 이 map을 거쳐도 참조까지 그대로다(무변화).
  const locale = activeLocale();
  // 번들 언어팩도 **같은 해석기**를 탄다 — 매니페스트 `%키%`+`nls`를 쓰는 것이 번들 플러그인과
  // 완전히 같기 때문이다(도그푸딩: 언어팩만 다른 규칙을 타면 그게 곧 표류의 시작이다).
  const localizedBuiltins = [...BUILTIN_PLUGINS, ...languagePacks].map((p) =>
    resolveBuiltinPluginNls(p, locale),
  );
  const localizedThemes = BUILTIN_THEMES.map((th) =>
    resolveBuiltinThemeNls(th, locale),
  );
  // 카테고리별로 모아 그룹 헤더와 함께 렌더한다(에디터·도구·창·폰트·배경·언어·테마).
  const byCat = new Map<string, HTMLElement[]>();
  const collect = (category: string, li: HTMLElement): void => {
    const arr = byCat.get(category);
    if (arr) arr.push(li);
    else byCat.set(category, [li]);
  };
  for (const builtin of localizedBuiltins) {
    const li = document.createElement("li");
    li.className = "plugin-item";
    // 활성 로케일에 맞는 README 변형(없으면 기본 README.md로 폴백) — 요약 파생과 상세 뷰가
    // 같은 본문을 쓴다.
    const readme = pickBuiltinReadme(
      builtin.readme,
      builtin.readmeLocales,
      locale,
    );

    const head = document.createElement("div");
    head.className = "plugin-head";

    // 현재 OS 미지원이면 자동 비활성(토글 잠금 + 회색 처리) — 저장된 enabled는 보존한다
    // (지원 OS로 옮기면 복원). 실제 미실행은 중앙 호스트가 같은 platform 게이트로 강제한다.
    const supported = isSupportedOnPlatform(builtin.platforms, platform);
    if (!supported) li.classList.add("plugin-item--unsupported");

    const { label: enableLabel, input: enable } = buildEnableSwitch(
      supported && (states[builtin.id] ?? true), // 기록 없으면 기본 켜짐
      !supported,
      t("settings.plugin-list.enable-aria-label", { name: builtin.name }),
      (v) => handlers.onToggle(builtin.id, v),
    );
    enableLabel.title = enable.checked
      ? t("settings.plugin-list.toggle-on-title")
      : t("settings.plugin-list.toggle-off-title");

    // 지원 OS면 이름 옆 짧은 마이크로 배지; 미지원이면 배지 대신 2번째 줄에 사유 문장(아래).
    const platformBadge = supported
      ? buildPlatformBadge(builtin.platforms, true)
      : null;
    const failure = failed.get(builtin.id);

    // 상세 모델은 열리는 순간의 토글 상태를 담는다(상태 문구용).
    const openDetail = (): void =>
      handlers.onOpen({
        kind: "builtin",
        id: builtin.id,
        name: builtin.name,
        version: builtin.version,
        // 목록 행과 같은 부제(README 폴백 포함) — 상세에서도 같은 한 줄을 잇는다.
        summary: pluginSummary(builtin.summary, readme),
        sourceLabel: t("settings.plugin-list.source-bundled"),
        statusLabel: enable.checked
          ? t("settings.plugin-detail.status-active")
          : t("settings.plugin-detail.status-inactive"),
        isTheme: false,
        permissions: builtin.permissions,
        schema: builtin.settings ?? [],
        values: settingsValues[builtin.id] ?? {},
        readme,
      });

    // 1번째 줄: 이름(버전 제외) + 버전 뱃지 + [OS 배지] + 스위치.
    const ver = document.createElement("span");
    ver.className = "plugin-ver";
    ver.textContent = "v" + builtin.version;
    head.append(buildNameButton(builtin.name, openDetail), ver);
    if (platformBadge) head.append(platformBadge);
    if (failure !== undefined) head.append(buildFailureBadge());
    head.append(enableLabel);
    li.append(head);

    // 2번째 줄: 미지원이면 danger 톤 사유, 아니면 한 줄 요약.
    const desc = document.createElement("p");
    desc.className = "plugin-desc";
    if (!supported) {
      desc.classList.add("plugin-desc--unavailable");
      desc.textContent = t("settings.plugin-list.unsupported-desc");
    } else {
      desc.textContent = pluginSummary(builtin.summary, readme);
    }
    if (desc.textContent) li.append(desc);
    if (failure !== undefined) li.append(buildFailureNote(failure));

    collect(inferPluginCategory(builtin.permissions), li);
  }

  // 번들 테마 — 목록에 보이되 잠금(토글 없음): 테마는 테마 탭에서 "선택"하는 대상.
  for (const theme of localizedThemes) {
    const li = document.createElement("li");
    li.className = "plugin-item";
    const themeReadme = pickBuiltinReadme(
      theme.readme,
      theme.readmeLocales,
      locale,
    );

    const head = document.createElement("div");
    head.className = "plugin-head";

    const openDetail = (): void =>
      handlers.onOpen({
        kind: "builtin",
        id: theme.id,
        name: theme.name,
        version: theme.version,
        summary: pluginSummary(theme.summary, themeReadme),
        sourceLabel: t("settings.plugin-list.source-bundled"),
        statusLabel: THEME_LOCK_STATUS(),
        isTheme: true,
        permissions: theme.permissions,
        schema: [],
        values: {},
        readme: themeReadme,
      });

    // 이름(버전 제외) + 버전 + [⚠ 오류] + 🔒 필수 배지(우) — 비-테마 행과 리듬을 맞춘다.
    const themeFailure = failed.get(theme.id);
    const ver = document.createElement("span");
    ver.className = "plugin-ver";
    ver.textContent = "v" + theme.version;
    head.append(buildNameButton(theme.name, openDetail), ver);
    if (themeFailure !== undefined) head.append(buildFailureBadge());
    head.append(buildRequiredBadge());
    li.append(head);

    const desc = document.createElement("p");
    desc.className = "plugin-desc";
    desc.textContent = pluginSummary(theme.summary, themeReadme);
    if (desc.textContent) li.append(desc);
    if (themeFailure !== undefined) li.append(buildFailureNote(themeFailure));

    collect("테마", li);
  }

  // 카테고리별로 아이콘·개수·부제를 단 헤더 + 하나의 hairline 카드(중첩)로 렌더한다.
  const catMeta = CAT_META();
  for (const category of CATEGORY_ORDER) {
    const items = byCat.get(category);
    if (!items || items.length === 0) continue;
    const meta = catMeta[category];
    const group = document.createElement("li");
    group.className = "plugin-category-group";
    if (category === "테마")
      group.classList.add("plugin-category-group--locked");

    const header = document.createElement("div");
    header.className = "plugin-category";
    const icon = document.createElement("span");
    icon.className = "cat-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = meta.icon;
    const label = document.createElement("span");
    label.className = "cat-label";
    label.textContent = categoryDisplayName(category);
    const count = document.createElement("span");
    count.className = "cat-count";
    count.textContent = String(items.length);
    const caption = document.createElement("span");
    caption.className = "cat-caption";
    caption.textContent = meta.caption;
    header.append(icon, label, count, caption);

    const ul = document.createElement("ul");
    ul.className = "plugin-category-items";
    ul.append(...items);
    group.append(header, ul);
    listEl.append(group);
  }
}

/**
 * 설치 플러그인 목록(마스터)을 다시 그린다(순수 함수 — 가드 테스트 가능).
 *
 * 역할: 각 행을 이름 버튼(좌, 상세 열기) + 우측 컨트롤[활성 토글 | 🔒 필수 잠금(테마)]로
 * 통일 렌더한다. 테마 플러그인(권한 `theme`)은 **토글 없이** 잠금 배지(사유는 툴팁)를
 * 보인다(D3 — 테마를 끄면 렌더가 깨지므로 끄기 대상이 아니다). 민감 권한이 하나도
 * 부여되지 않은 행에는 재승인 안내를 유지한다(#새 기기 재승인). 승인 당시 예약(미구현)이라
 * 못 준 권한이 이제 풀린 행에도 같은 결의 재승인 안내를 붙인다(`pendingReserved`).
 * 권한 토글·⚙ 설정·업데이트·제거는 상세 뷰로 이관됐다. 비면 안내 문구를 보인다.
 *
 * 이번 호스트 빌드에서 실행 실패한 항목(`failures`)엔 ⚠ 오류 배지 + 사유 줄을 덧붙인다(번들
 * 목록과 같은 표시 — 활성 토글은 계속 "켜짐"으로 보여도 실제로는 로드되지 않았음을 알린다).
 */
export function renderPluginList(
  listEl: HTMLElement,
  plugins: InstalledPlugin[],
  actions: MasterActions,
  /** 이번 빌드에서 실행 실패한 플러그인/테마(중앙 호스트 스냅샷 `failures`). 없으면 표시 없음. */
  failures: PluginFailure[] = [],
): void {
  listEl.replaceChildren();
  if (plugins.length === 0) {
    const empty = document.createElement("li");
    empty.className = "plugin-empty";
    empty.textContent = t("settings.plugin-list.empty");
    listEl.append(empty);
    return;
  }
  const failed = failureMap(failures);
  // 카테고리별로 모아 그룹 헤더와 함께 렌더한다(설치형은 권한으로 카테고리 추론).
  const byCat = new Map<string, HTMLElement[]>();
  const collect = (category: string, li: HTMLElement): void => {
    const arr = byCat.get(category);
    if (arr) arr.push(li);
    else byCat.set(category, [li]);
  };
  for (const plugin of plugins) {
    const li = document.createElement("li");
    li.className = "plugin-item";

    const head = document.createElement("div");
    head.className = "plugin-head";
    const failure = failed.get(plugin.id);

    if (isThemePluginInfo(plugin)) {
      // 테마 행: 토글 컨트롤을 아예 만들지 않는다(어떤 경로로도 비활성화 불가 — D3).
      // 이름(좌) + [⚠ 오류] + 🔒 필수 배지(우) — 잠금 사유는 배지 툴팁(레이아웃 통일).
      head.append(
        buildNameButton(`${plugin.name} v${plugin.version}`, () =>
          actions.open(plugin),
        ),
      );
      if (failure !== undefined) head.append(buildFailureBadge());
      head.append(buildRequiredBadge());
    } else {
      // 번들 목록과 같은 스위치 UI(일관성). 설치 목록은 버전을 이름에 함께 둔다(부제는 아래).
      const { label: enableLabel } = buildEnableSwitch(
        plugin.enabled,
        false,
        t("settings.plugin-list.enable-aria-label", { name: plugin.name }),
        (v) => actions.setEnabled(plugin.id, v),
      );
      // 이름(좌) + [⚠ 오류] + 활성 토글(우) — 번들·테마 행과 정렬 통일.
      head.append(
        buildNameButton(`${plugin.name} v${plugin.version}`, () =>
          actions.open(plugin),
        ),
      );
      if (failure !== undefined) head.append(buildFailureBadge());
      head.append(enableLabel);
    }
    li.append(head);

    // 2번째 줄: 매니페스트 `summary` 부제(번들 행과 같은 자리·같은 클래스).
    // README 폴백은 여기서 쓸 수 없다 — 설치형 README는 상세를 열 때 IPC로 읽으므로 목록
    // 렌더 시점에는 없다(그래서 `pluginSummary`의 두 번째 인자가 빈 문자열이다).
    const desc = pluginSummary(plugin.summary ?? undefined, "");
    if (desc) {
      const descEl = document.createElement("p");
      descEl.className = "plugin-desc";
      descEl.textContent = desc;
      li.append(descEl);
    }
    if (failure !== undefined) li.append(buildFailureNote(failure));

    // 민감 권한을 선언했는데 하나도 부여되지 않았다면 — 동기화로 넘어온 새 기기이거나
    // 아직 승인 전 — 재승인 안내와 승인 버튼을 보인다(#새 기기 재승인).
    if (needsApproval(plugin)) {
      const row = document.createElement("div");
      row.className = "plugin-approval-row";
      const note = document.createElement("span");
      note.className = "plugin-approval-needed";
      note.textContent = t("settings.plugin-list.approval-needed");
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "plugin-approve-open";
      approveBtn.textContent = t("settings.plugin-list.approve-button");
      approveBtn.addEventListener("click", () => actions.approve(plugin));
      row.append(note, approveBtn);
      li.append(row);
    }

    // 승인 당시엔 예약(미구현)이라 부여하지 못했던 권한이 이제 풀렸다면 — 같은 결의 안내
    // 행으로 재승인을 요청한다. 이게 없으면 기존 설치는 매니페스트를 다시 설치하지
    // 않는 한 새로 구현된 능력을 영영 못 쓴다(부여가 빈 채로 남아 게이트키퍼가 계속 막는다).
    const { available } = reservedRegrant(plugin);
    if (available.length > 0) {
      const row = document.createElement("div");
      row.className = "plugin-approval-row plugin-approval-row--reserved";
      const note = document.createElement("span");
      note.className = "plugin-approval-needed";
      // 권한 라벨은 우리 어휘(PERMISSION_INFO)라 안전하다 — 그래도 textContent로만 넣는다.
      const labels = available.map((p) => permissionInfo(p).label).join(" · ");
      note.textContent = t("settings.plugin-list.reserved-approval-needed", {
        labels,
      });
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "plugin-approve-open plugin-approve-reserved-open";
      approveBtn.textContent = t("settings.plugin-list.approve-button");
      approveBtn.addEventListener("click", () =>
        actions.approveReserved(plugin, available),
      );
      row.append(note, approveBtn);
      li.append(row);
    }
    collect(inferPluginCategory(plugin.permissions), li);
  }

  for (const category of CATEGORY_ORDER) {
    const items = byCat.get(category);
    if (!items || items.length === 0) continue;
    const header = document.createElement("li");
    header.className = "plugin-category";
    header.textContent = categoryDisplayName(category);
    listEl.append(header, ...items);
  }
}

/**
 * 플러그인 상세 뷰를 그린다(순수 DOM — 가드 테스트 가능).
 *
 * 역할: [← 목록] 헤더, 이름·버전·출처·상태 메타, 권한 목록(설치형 민감 권한은 부여 토글,
 * 번들은 읽기 전용 배지), ⚙ 선언형 설정 폼(스키마 있을 때, 펼친 상태), README 섹션(번들은
 * 즉시 렌더·설치형은 호출부가 IPC로 채움), 설치형이면 [업데이트 확인(URL/git)]·[제거]를
 * 모은다(D2 마스터-디테일). README 링크는 openLink(외부 브라우저)로만 위임된다.
 */
/**
 * 플러그인 저작 가이드(GitHub) 링크 — 「커뮤니티 플러그인」 패널의 "플러그인 만들기" 버튼이
 * 연다(베타 피드백: 커뮤니티 플러그인을 어떻게 만드는지 몰랐다는 진입점 부재). 저장소 루트는
 * `package.json`이 알지 못해(비공개 필드) 여기서 리터럴로 못박는다 — README.md의 GitHub
 * 링크와 `builtin.test.ts`의 예제 소스 URL이 같은 저장소를 가리키는 것과 같은 값이다.
 */
const PLUGIN_AUTHORING_GUIDE_URL =
  "https://github.com/HaruPlan/note-rang/blob/main/docs/plugin/authoring.md";

/**
 * 액션 버튼을 누른 뒤 그 실행이 남긴 진단을 지켜보는 상한(ms)과 폴링 간격(ms).
 *
 * 왜 상한이 있는가: 명령이 아무 기록도 남기지 않고 끝날 수 있다(조용한 성공). 영원히 폴링하면
 * 설정 창이 창 수명 내내 IPC를 두드린다 — 상한을 넘기면 "결과를 남기지 않았다"고 사실대로
 * 적고 멈춘다. 2초는 창 하나를 거쳐 오는 브리지 왕복(수십 ms) 대비 넉넉하면서, 사람이 버튼
 * 앞에서 기다려 줄 만한 상한이다.
 */
const ACTION_RESULT_WINDOW_MS = 2000;
const ACTION_RESULT_POLL_MS = 100;

/**
 * 진단 종류 → 사람이 읽는 한 줄 이름(플러그인 문자열이 아니라 우리 어휘라 안전하다).
 *
 * 함수인 이유: 소비 지점(`buildDiagnosticsList`)이 호출될 때마다 다시 평가해 `t()`가 그
 * 순간의 활성 로케일을 읽게 한다. 모듈 상단 `const`로 한 번만 구우면 이 창이 로드되는 시점
 * (`setActiveLocale()`보다 항상 먼저)의 로케일로 영원히 고정된다(§i18n 규약).
 */
const DIAGNOSTIC_LABELS = (): Record<DiagnosticKind, string> => ({
  "call-reject": t("settings.plugin-detail.diagnostic-call-reject"),
  "no-window-context": t("settings.plugin-detail.diagnostic-no-window-context"),
  "setting-write-rejected": t(
    "settings.plugin-detail.diagnostic-setting-write-rejected",
  ),
  "setting-key-undeclared": t(
    "settings.plugin-detail.diagnostic-setting-key-undeclared",
  ),
  "duplicate-registration": t(
    "settings.plugin-detail.diagnostic-duplicate-registration",
  ),
  "onclick-throw": t("settings.plugin-detail.diagnostic-onclick-throw"),
  "unhandled-rejection": t(
    "settings.plugin-detail.diagnostic-unhandled-rejection",
  ),
  log: t("settings.plugin-detail.diagnostic-log"),
  "experimental-call": t("settings.plugin-detail.diagnostic-experimental-call"),
});

/**
 * 런타임 진단 목록을 그린다(최신 것이 위로).
 *
 * **보안: 모든 플러그인 유래 문자열은 `textContent`로만 넣는다.** 메시지·호출명은 플러그인이
 * 만든 값이라 innerHTML로 넣으면 설정 창에 마크업 주입이 열린다.
 */
function buildDiagnosticsList(entries: PluginDiagnostic[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "plugin-diagnostics";
  const diagnosticLabels = DIAGNOSTIC_LABELS();
  // 최신이 위(방금 난 일을 먼저 본다).
  for (const entry of [...entries].reverse()) {
    const li = document.createElement("li");
    li.className = "plugin-diagnostic";
    li.dataset.kind = entry.kind;

    const head = document.createElement("div");
    head.className = "plugin-diagnostic-head";
    const kind = document.createElement("span");
    kind.className = "plugin-diagnostic-kind";
    kind.textContent = diagnosticLabels[entry.kind] ?? entry.kind;
    head.append(kind);
    if (entry.call) {
      const call = document.createElement("code");
      call.className = "plugin-diagnostic-call";
      call.textContent = entry.call;
      head.append(call);
    }
    if (entry.code) {
      // 기계용 안정 코드 — 저작자·AI가 그대로 검색·분기할 수 있게 눈에 보이게 둔다.
      const code = document.createElement("code");
      code.className = "plugin-diagnostic-code";
      code.textContent = entry.code;
      head.append(code);
    }
    const at = document.createElement("time");
    at.className = "plugin-diagnostic-at";
    at.textContent = new Date(entry.at).toLocaleTimeString();
    head.append(at);

    const message = document.createElement("p");
    message.className = "plugin-diagnostic-message";
    message.textContent = entry.message;

    li.append(head, message);
    list.append(li);
  }
  return list;
}

/**
 * 이미 그려진 상세의 「최근 오류」 섹션만 새 기록으로 갈아 끼운다.
 *
 * 왜 부분 갱신인가: 진단은 상세를 연 뒤 비동기로 도착하는데, 그때 상세 전체를 다시 그리면
 * 같은 방식으로 비동기 로드 중인 README가 통째로 날아간다(둘의 경쟁을 없애는 가장 싼 방법).
 */
export function updatePluginDiagnostics(
  host: HTMLElement,
  entries: PluginDiagnostic[],
): void {
  const wrap = host.querySelector<HTMLElement>(
    ".plugin-detail-section--diagnostics",
  );
  if (!wrap) return;
  wrap.hidden = entries.length === 0;
  wrap
    .querySelector(".plugin-diagnostics")
    ?.replaceWith(buildDiagnosticsList(entries));
}

export function renderPluginDetail(
  host: HTMLElement,
  item: PluginDetailItem,
  actions: DetailActions,
): void {
  host.replaceChildren();
  const root = document.createElement("div");
  root.className = "plugin-detail";

  const head = document.createElement("div");
  head.className = "plugin-detail-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "plugin-detail-back";
  back.textContent = t("settings.plugin-detail.back-button");
  back.addEventListener("click", () => actions.back());
  const name = document.createElement("span");
  name.className = "plugin-detail-name";
  name.textContent = item.name;
  const version = document.createElement("span");
  version.className = "plugin-detail-version";
  version.textContent = `v${item.version}`;
  head.append(back, name, version);
  root.append(head);

  // 매니페스트 `summary` 한 줄(선언했을 때만) — 이름 바로 아래 부제. 목록 행과 같은 값이라
  // 「목록에서 본 그 플러그인」임을 상세에서도 잇는다.
  if (item.summary) {
    const summary = document.createElement("p");
    summary.className = "plugin-detail-summary";
    summary.textContent = item.summary;
    root.append(summary);
  }

  // 플러그인이 스스로 밝힌 목적 설명(`purpose`, 선택) — summary와 달리 저작자가 자유
  // 형식으로 쓴 문장이라, 검증된 값이 아님을 시각적으로 구분하는 라벨을 함께 둔다("자기신고"
  // 톤). 자기신고 문자열은 신뢰 경계 밖이라 반드시 textContent로만 꽂는다(innerHTML 금지 —
  // renderRejectedList의 dir_name/reason과 같은 원칙).
  if (item.purpose) {
    const purposeWrap = document.createElement("div");
    purposeWrap.className = "plugin-detail-purpose-wrap";
    const label = document.createElement("span");
    label.className = "plugin-detail-selfreport-label";
    label.textContent = t("settings.plugin-detail.self-report-label");
    const text = document.createElement("p");
    text.className = "plugin-detail-purpose";
    text.textContent = item.purpose;
    purposeWrap.append(label, text);
    root.append(purposeWrap);
  }

  const meta = document.createElement("div");
  meta.className = "plugin-detail-meta";
  const source = document.createElement("span");
  source.className = "plugin-detail-source";
  source.textContent = t("settings.plugin-detail.source-line", {
    sourceLabel: item.sourceLabel,
  });
  const status = document.createElement("span");
  status.className = "plugin-detail-status";
  status.textContent = t("settings.plugin-detail.status-line", {
    statusLabel: item.statusLabel,
  });
  meta.append(source, status);
  root.append(meta);

  /** 제목 붙은 상세 섹션 컨테이너를 만든다. */
  const section = (title: string): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "plugin-detail-section";
    const h = document.createElement("h3");
    h.className = "plugin-detail-title";
    h.textContent = title;
    wrap.append(h);
    root.append(wrap);
    return wrap;
  };

  if (item.permissions.length > 0) {
    const perms = document.createElement("div");
    perms.className = "plugin-perms";
    for (const permission of item.permissions) {
      if (item.installed) {
        // 설치형: 민감 권한은 부여 토글(기존 계약 이관), 저위험은 배지.
        perms.append(
          buildPermissionControl(
            item.installed,
            permission,
            actions.setGranted,
          ),
        );
      } else {
        // 번들: 1st-party 자동 부여 — 읽기 전용 배지만(친근한 라벨 + 설명 툴팁).
        const info = permissionInfo(permission);
        const badge = document.createElement("span");
        badge.className = "plugin-perm";
        badge.textContent = info.label;
        if (info.desc) badge.title = info.desc;
        perms.append(badge);
      }
    }
    section(t("settings.plugin-detail.section-permissions")).append(perms);
  }

  if (item.schema.length > 0) {
    // 설정은 좌측 트리의 이 플러그인 페이지가 정본이라, 상세엔 그리로 가는 링크만 둔다(중복 제거).
    const open = document.createElement("button");
    open.type = "button";
    open.className = "plugin-settings-link";
    open.textContent = t("settings.plugin-detail.settings-link");
    open.addEventListener("click", () => actions.openSettings(item));
    section(t("settings.plugin-detail.section-settings")).append(open);
  }

  // 「최근 오류」 — 이 플러그인의 런타임 진단. 기록이 없으면 섹션째로 숨긴다(평상시
  // 소음 0, 문제가 생긴 순간에만 나타난다). 섹션 자체는 **항상 만든다** — 진단을 비동기로
  // 다시 읽어 왔을 때 상세 전체를 다시 그리지 않고 이 자리만 갈아 끼우기 위함이다
  // (전체 재렌더는 비동기로 채워지는 README를 날려 버린다).
  const diagnostics = item.diagnostics ?? [];
  const diagnosticsSection = section(
    t("settings.plugin-detail.section-diagnostics"),
  );
  diagnosticsSection.classList.add("plugin-detail-section--diagnostics");
  diagnosticsSection.hidden = diagnostics.length === 0;
  diagnosticsSection.append(buildDiagnosticsList(diagnostics));

  const readme = document.createElement("div");
  readme.className = "plugin-readme";
  if (item.kind === "builtin") {
    renderReadmeInto(
      readme,
      item.readme,
      actions.openLink,
      actions.resolveImage,
    );
  } else {
    // 로딩도 빈 상태와 같은 흐린 톤으로(본문 굵기로 깜빡이지 않게) — 호출부가 IPC 결과로 교체.
    const loading = document.createElement("div");
    loading.className = "plugin-readme-empty";
    loading.textContent = t("settings.plugin-detail.readme-loading");
    readme.append(loading);
  }
  const readmeSection = section(t("settings.plugin-detail.section-readme"));
  readmeSection.classList.add("plugin-detail-section--readme");
  readmeSection.append(readme);

  // AI 컨텍스트(`llmContext`, 선택, 자기신고) — 일반 사용자에겐 부차적이라 접힌
  // <details>로 둔다(네이티브 disclosure — 기본은 닫힘). purpose와 같은 신뢰 경계 원칙:
  // 반드시 textContent로만 꽂는다.
  if (item.llmContext) {
    const details = document.createElement("details");
    details.className = "plugin-detail-llmcontext";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = t("settings.plugin-detail.llm-context-summary");
    const body = document.createElement("p");
    body.className = "plugin-detail-llmcontext-body";
    body.style.whiteSpace = "pre-wrap";
    body.textContent = item.llmContext;
    details.append(summaryEl, body);
    root.append(details);
  }

  // 개발자 모드 — 로컬 폴더 사이드로드 플러그인에 한정(원본 폴더가 이 기기에 있어야
  // 감시할 수 있다). `devModeAvailable`은 호출자가 `deps.setDevPlugin` 배선 여부를 투영한
  // 값 — 없으면 행 자체를 안 그린다(pickPluginDir과 같은 선택 dep 규칙).
  if (
    item.installed &&
    item.installed.source?.type === "local" &&
    item.devModeAvailable
  ) {
    const devSection = section(t("settings.plugin-detail.section-dev-mode"));
    const devLabel = document.createElement("label");
    devLabel.className = "plugin-devmode";
    const devInput = document.createElement("input");
    devInput.type = "checkbox";
    devInput.className = "plugin-devmode-toggle";
    devInput.checked = item.devMode === true;
    devInput.setAttribute(
      "aria-label",
      t("settings.plugin-detail.dev-mode-aria-label"),
    );
    const pluginId = item.id;
    devInput.addEventListener("change", () =>
      actions.setDevMode(pluginId, devInput.checked),
    );
    const devText = document.createElement("span");
    devText.textContent = t("settings.plugin-detail.dev-mode-text");
    devLabel.append(devInput, devText);
    devSection.append(devLabel);
    const devHint = document.createElement("small");
    devHint.className = "plugin-devmode-hint";
    devHint.textContent = item.devMode
      ? t("settings.plugin-detail.dev-mode-hint-on")
      : t("settings.plugin-detail.dev-mode-hint-off");
    devSection.append(devHint);
  }

  if (item.installed) {
    const buttons = document.createElement("div");
    buttons.className = "plugin-detail-actions";
    const sourceType = item.installed.source?.type;
    if (sourceType === "url" || sourceType === "git") {
      const update = document.createElement("button");
      update.type = "button";
      update.className = "plugin-update";
      update.textContent = t("settings.plugin-detail.update-check-button");
      const installed = item.installed;
      update.addEventListener("click", () => actions.checkUpdate(installed));
      buttons.append(update);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "plugin-remove";
    remove.textContent = t("settings.plugin-detail.remove-button");
    remove.addEventListener("click", () => actions.remove(item.id));
    buttons.append(remove);
    root.append(buttons);
  }

  host.append(root);
}

/** 재조정 안내 콜백([설치]/[제거]/[무시]). */
interface MissingActions {
  install(entry: MissingPlugin): void;
  remove(id: string): void;
  dismiss(id: string): void;
}

/**
 * vault 목록 재조정 안내를 그린다(비차단 배너 — 항목이 없으면 통째로 숨김).
 *
 * 역할: 동기화 목록엔 있는데 이 기기에 코드가 없는 항목마다 [설치](URL/git — 승인 플로우
 * 재사용) 또는 "코드 없음" 안내(local), [제거](vault 목록에서 삭제), [무시](로컬 기록)를
 * 제공한다.
 */
export function renderMissingList(
  container: HTMLElement,
  entries: MissingPlugin[],
  actions: MissingActions,
): void {
  container.replaceChildren();
  container.hidden = entries.length === 0;
  if (entries.length === 0) return;

  const intro = document.createElement("div");
  intro.className = "plugin-missing-intro";
  intro.textContent = t("settings.reconcile.intro");
  container.append(intro);

  const ul = document.createElement("ul");
  ul.className = "plugin-missing-list";
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "plugin-missing-item";

    const head = document.createElement("div");
    head.className = "plugin-missing-head";
    const name = document.createElement("span");
    name.className = "plugin-missing-name";
    name.textContent = `${entry.name} v${entry.version}`;
    const source = document.createElement("span");
    source.className = "plugin-missing-source";
    source.textContent = describeSource(entry.source);
    head.append(name, source);
    li.append(head);

    const buttons = document.createElement("div");
    buttons.className = "plugin-missing-actions";
    const spec = specFromSource(entry.source);
    if (spec) {
      const install = document.createElement("button");
      install.type = "button";
      install.className = "plugin-missing-install";
      install.textContent = t("settings.reconcile.install-button");
      install.addEventListener("click", () => actions.install(entry));
      buttons.append(install);
    } else {
      const note = document.createElement("span");
      note.className = "plugin-missing-note";
      note.textContent = t("settings.reconcile.no-code");
      buttons.append(note);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "plugin-missing-remove";
    remove.textContent = t("settings.plugin-detail.remove-button");
    remove.addEventListener("click", () => actions.remove(entry.id));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "plugin-missing-dismiss";
    dismiss.textContent = t("settings.reconcile.dismiss-button");
    dismiss.addEventListener("click", () => actions.dismiss(entry.id));
    buttons.append(remove, dismiss);
    li.append(buttons);
    ul.append(li);
  }
  container.append(ul);
}

/**
 * 스캔에서 탈락한 플러그인 폴더 안내를 그린다(비차단 배너, 항목이 없으면 통째로 숨김).
 *
 * 역할: `plugins/` 아래 있는데 매니페스트가 깨졌거나·id가 폴더명과 다르거나·entry 파일이 없어
 * 설치 목록에서 **조용히 사라진** 폴더를 폴더명 + 사유로 보인다. 이전에는 설치가 성공한 뒤에도
 * 목록에 아무것도 안 뜨는 것이 유일한 신호라, 사용자가 원인을 알 방법이 없었다(재조정 배너가
 * "코드가 없는 항목"을 알리는 것과 정확히 짝을 이루는, "코드는 있는데 못 읽는 항목" 안내).
 * 조치 버튼은 두지 않는다 — 고칠 수 있는 것은 폴더 안의 파일이지 앱이 아니다.
 *
 * 보안: `dir_name`·`reason`은 사용자가 넣은 폴더(신뢰 경계 밖)에서 온 문자열이라 **반드시
 * `textContent`로만** 넣는다(실행 실패 사유 줄과 같은 원칙 — innerHTML 금지).
 *
 * 스타일은 재조정 배너(`.plugin-missing*`)를 그대로 재사용한다 — 같은 자리·같은 톤의
 * 비차단 안내라 새 규칙을 만들 이유가 없다. `.plugin-rejected`는 이 배너를 가리키는 훅이다.
 */
export function renderRejectedList(
  container: HTMLElement,
  entries: RejectedPlugin[],
): void {
  container.replaceChildren();
  container.hidden = entries.length === 0;
  if (entries.length === 0) return;

  const intro = document.createElement("div");
  intro.className = "plugin-missing-intro";
  intro.textContent = t("settings.reconcile.rejected-intro");
  container.append(intro);

  const ul = document.createElement("ul");
  ul.className = "plugin-missing-list";
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "plugin-missing-item plugin-rejected-item";

    const head = document.createElement("div");
    head.className = "plugin-missing-head";
    const name = document.createElement("span");
    name.className = "plugin-missing-name";
    name.textContent = entry.dir_name; // 폴더명 — 신뢰 경계 밖 문자열.
    head.append(name);
    li.append(head);

    const reason = document.createElement("div");
    reason.className = "plugin-missing-note plugin-rejected-reason";
    reason.textContent = entry.reason; // 사유 — 신뢰 경계 밖 문자열.
    li.append(reason);

    ul.append(li);
  }
  container.append(ul);
}

/** 승인 프롬프트에 그릴 모델(설치/업데이트/재승인 공통 형태). */
interface PromptModel {
  title: string;
  summary: string;
  permissions: ApprovalPermission[];
  approveLabel: string;
}

/**
 * 설치/업데이트/다운그레이드 승인 화면 모델을 프롬프트 모델로 바꾼다(제목·요약·버튼 문구 결정).
 *
 * 다운그레이드는 차단 대상이 아니다(되돌리기는 사용자 의도일 수 있음) — 이 프롬프트를 띄우기
 * 전에 호출부(startInstall)가 이미 별도 확인(confirmDialog)을 받았으므로, 여기서는 제목·버튼
 * 문구만 업데이트와 구분한다(권한 목록·흐름은 동일).
 */
function promptModelForView(
  view: Extract<ApprovalView, { kind: "install" | "update" | "downgrade" }>,
): PromptModel {
  if (view.kind === "update") {
    return {
      title: t("settings.approval.title-update"),
      summary: `${view.name} v${view.fromVersion ?? "?"} → v${view.version}`,
      permissions: view.permissions,
      approveLabel: t("settings.approval.approve-update"),
    };
  }
  if (view.kind === "downgrade") {
    return {
      title: t("settings.approval.title-downgrade"),
      summary: `${view.name} v${view.fromVersion ?? "?"} → v${view.version}`,
      permissions: view.permissions,
      approveLabel: t("settings.approval.approve-downgrade"),
    };
  }
  return {
    title: t("settings.approval.title-install"),
    summary: `${view.name} v${view.version}`,
    permissions: view.permissions,
    approveLabel: t("settings.approval.approve-install"),
  };
}

/**
 * 새 기기 재승인용 프롬프트 모델(설치된 플러그인의 선언 권한 그대로).
 *
 * `reason`은 `InstalledPlugin`이 이미 실어 보내는 `permissionReasons`를
 * `selfReportedPermissionReasons`로 안전하게 읽어 권한별로 붙인다 — 값 없는 권한은 그냥
 * 비운다(전체를 거부하지 않는다).
 */
function promptModelForRegrant(plugin: InstalledPlugin): PromptModel {
  const reasons = selfReportedPermissionReasons(plugin);
  return {
    title: t("settings.approval.title-permission"),
    summary: `${plugin.name} v${plugin.version}`,
    permissions: plugin.permissions.map((id) => ({
      id,
      ...permissionInfo(id),
      sensitive: isSensitive(id),
      added: false,
      ...(reasons[id] !== undefined ? { reason: reasons[id] } : {}),
    })),
    approveLabel: t("settings.approval.approve-all"),
  };
}

/**
 * 예약이 풀린 권한의 재승인 프롬프트 모델 — 새로 쓸 수 있게 된 권한만 보인다.
 *
 * 왜 선언 권한 전체가 아닌가: 나머지는 이미 승인 시점에 판단이 끝났다(부여했거나, 사용자가
 * 껐거나). 여기서 다시 보이면 "무엇이 달라졌는지"가 묻히고, 전체 승인 버튼이 사용자가
 * 예전에 끈 권한까지 되살리는 것처럼 읽힌다. `added` 표식으로 "이번에 새로 열린 것"임을
 * 명시한다(업데이트 프롬프트의 "새 권한"과 같은 어휘).
 */
function promptModelForReserved(
  plugin: InstalledPlugin,
  available: string[],
): PromptModel {
  // promptModelForRegrant와 같은 이유로 자기신고 이유를 병기한다.
  const reasons = selfReportedPermissionReasons(plugin);
  return {
    title: t("settings.approval.title-permission"),
    summary: t("settings.approval.reserved-summary", {
      name: plugin.name,
      version: plugin.version,
    }),
    permissions: available.map((id) => ({
      id,
      ...permissionInfo(id),
      sensitive: isSensitive(id),
      added: true,
      ...(reasons[id] !== undefined ? { reason: reasons[id] } : {}),
    })),
    approveLabel: t("settings.approval.approve-single"),
  };
}

/** 승인 프롬프트 버튼 콜백. */
interface ApprovalHandlers {
  onApprove(): void;
  onCancel(): void;
}

/**
 * 권한 승인 프롬프트를 그린다(순수 렌더 — 가드 테스트 가능).
 *
 * 역할: 플러그인 이름/버전과 선언 권한 전체를 한국어 라벨·설명으로 보여준다. 민감 권한은
 * 강조하고, 업데이트로 새로 추가된 민감 권한엔 "새 권한" 표식을 붙인다(재승인 필수 대상).
 * 예약(미구현) 권한엔 "아직 동작하지 않음" 표식을 붙여, 승인해도 효과가 없음을 알린다
 * (`PERMISSION_RESERVED` — install-flow.ts의 `permissionInfo`가 판정). 전체 승인/취소의
 * 단순 모델 — 개별 조정은 설치 후 권한 토글로 한다. 매니페스트가 그 권한에 자기신고
 * `permissionReasons`를 붙였으면 고정 경고문 아래에 "플러그인이 밝힌 이유"로 병기한다.
 */
export function renderApprovalPrompt(
  host: HTMLElement,
  model: PromptModel,
  handlers: ApprovalHandlers,
): void {
  host.replaceChildren();

  const title = document.createElement("div");
  title.className = "plugin-approve-title";
  title.textContent = model.title;

  const summary = document.createElement("div");
  summary.className = "plugin-approve-summary";
  summary.textContent = model.summary;
  host.append(title, summary);

  if (model.permissions.length === 0) {
    const none = document.createElement("div");
    none.className = "plugin-approve-none";
    none.textContent = t("settings.approval.no-permissions");
    host.append(none);
  } else {
    const ul = document.createElement("ul");
    ul.className = "plugin-approve-perms";
    for (const perm of model.permissions) {
      const li = document.createElement("li");
      li.className = perm.sensitive
        ? "plugin-approve-perm plugin-approve-sensitive"
        : "plugin-approve-perm";
      const label = document.createElement("span");
      label.className = "plugin-approve-label";
      label.textContent = perm.label;
      li.append(label);
      if (perm.added) {
        const added = document.createElement("span");
        added.className = "plugin-approve-added";
        added.textContent = t("settings.approval.new-permission-badge");
        li.append(added);
      }
      if (perm.reserved) {
        // 예약(미구현) 권한 — 승인해도 대응 브리지 호출이 없어 효과가 없다. 사용자가 정상
        // 동작 중인 권한으로 오해하지 않게 명시한다(PERMISSION_RESERVED, install-flow.ts).
        const reserved = document.createElement("span");
        reserved.className = "plugin-approve-reserved";
        reserved.textContent = t("settings.approval.reserved-badge");
        reserved.title = t("settings.approval.reserved-badge-title");
        li.append(reserved);
      }
      if (perm.desc !== "") {
        const desc = document.createElement("span");
        desc.className = "plugin-approve-desc";
        desc.textContent = perm.desc;
        li.append(desc);
      }
      if (perm.reason) {
        // 저작자가 이 권한에 붙인 자기신고 보조 설명. 고정 경고문(desc)을 대체하지
        // 않고 아래에 덧붙인다 — "플러그인이 밝힌"이라는 톤으로 신뢰 수위를 낮춘다(검증된
        // 문구가 아니다). 자기신고 문자열은 신뢰 경계 밖이라 반드시 textContent로만 꽂는다.
        const reason = document.createElement("span");
        reason.className = "plugin-approve-reason";
        reason.textContent = t("settings.approval.self-reported-reason", {
          reason: perm.reason,
        });
        li.append(reason);
      }
      ul.append(li);
    }
    host.append(ul);
  }

  const actions = document.createElement("div");
  actions.className = "plugin-approve-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "plugin-approve-cancel";
  cancel.textContent = t("settings.approval.cancel-button");
  cancel.addEventListener("click", () => handlers.onCancel());
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "plugin-approve-ok";
  ok.textContent = model.approveLabel;
  ok.addEventListener("click", () => handlers.onApprove());
  actions.append(cancel, ok);
  host.append(actions);
}

/** 실패 원인을 사용자 문구로 바꾼다(Error/문자열 공통). */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 설치 입력 UI를 만든다 — URL 행 + 로컬 폴더 선택 행 + 진행/오류 상태 줄.
 *
 * 역할: 두 입력 모두 설치 스펙을 만들어 같은 설치 플로우(onSpec — 스테이징 → 권한 승인
 * 프롬프트)로 보낸다. URL은 문자열 해석(`parseInstallInput`), 폴더는 네이티브 선택기(`pickDir`)로
 * 경로를 받는다 — 손으로 경로를 타이핑하지 않는다. `pickDir`가 없으면 폴더 행을 숨긴다.
 */
function buildInstaller(
  onSpec: (spec: InstallSpec) => void,
  pickDir: (() => Promise<string | null>) | undefined,
): {
  root: HTMLElement;
  status: HTMLElement;
  reset: () => void;
} {
  const root = document.createElement("div");
  root.className = "plugin-install";

  const urlRow = document.createElement("div");
  urlRow.className = "plugin-install-row";
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "plugin-install-url";
  urlInput.placeholder = t("settings.install.url-placeholder");
  const urlButton = document.createElement("button");
  urlButton.type = "button";
  urlButton.className = "plugin-install-url-btn";
  urlButton.textContent = t("settings.install.url-button");
  urlRow.append(urlInput, urlButton);

  const status = document.createElement("div");
  status.className = "plugin-install-status";

  urlButton.addEventListener("click", () => {
    const parsed = parseInstallInput(urlInput.value);
    if (!parsed.ok) {
      status.textContent = parsed.error;
      return;
    }
    onSpec(parsed.spec);
  });

  root.append(urlRow);

  // 폴더 설치: 경로 타이핑 대신 OS 폴더 선택기를 연다. 선택기를 못 쓰는 호스트면 행을 숨긴다.
  if (pickDir) {
    const dirRow = document.createElement("div");
    dirRow.className = "plugin-install-row plugin-install-folder";
    const dirHint = document.createElement("span");
    dirHint.className = "plugin-install-folder-hint";
    dirHint.textContent = t("settings.install.dir-hint");
    const dirButton = document.createElement("button");
    dirButton.type = "button";
    dirButton.className = "plugin-install-btn";
    dirButton.textContent = t("settings.install.dir-button");
    dirButton.addEventListener("click", () => {
      void (async () => {
        dirButton.disabled = true;
        try {
          const path = await pickDir();
          if (path !== null && path.trim() !== "") {
            onSpec({ kind: "local", location: path });
          }
        } catch {
          status.textContent = t("settings.install.dir-error");
        } finally {
          dirButton.disabled = false;
        }
      })();
    });
    dirRow.append(dirHint, dirButton);
    root.append(dirRow);
  }

  /** 입력·상태를 비운다(모달을 다시 열 때 깨끗한 상태로). */
  const reset = (): void => {
    urlInput.value = "";
    status.textContent = "";
  };
  return { root, status, reset };
}

/** 복구 화면이 필요로 하는 IO — [`SettingsDeps`]의 복구 4종만 좁혀 받는다(테스트 격리·가독성). */
type RecoveryDeps = Pick<
  SettingsDeps,
  | "listNotes"
  | "listSnapshotNoteIds"
  | "listSnapshots"
  | "readSnapshot"
  | "restoreSnapshot"
>;

/**
 * 「메모 복구」 페이지를 만든다 — 파괴적 덮어쓰기(`notes.write` overwrite) 전에 앱이 남긴
 * 복구 슬롯 스냅샷을 보고 그 시점으로 되돌리는 화면.
 *
 * 역할: memo엔 undo도 휴지통도 없어 스냅샷이 유일한 안전망이지만(웨이브 E 백엔드), 되돌릴
 * 사용자 표면이 없어 "복구 가능성"이 절반만 실현돼 있었다 — 이 페이지가 나머지 절반이다.
 * 흐름은 네 단계다: (a) 스냅샷 보유 노트 나열(`listNotes` + 노트별 `listSnapshots`) →
 * (b) 한 노트의 스냅샷을 최신순으로 열기 → (c) 본문 미리보기(`readSnapshot`) →
 * (d) 확인 다이얼로그를 거쳐 복원(`restoreSnapshot`).
 *
 * 왜 미리보기가 textContent인가: 스냅샷 본문은 플러그인이 쓴 내용일 수 있어 **신뢰 경계 밖**이다
 * — innerHTML로 그리면 저장된 마크업이 설정 창에서 실행된다(같은 원칙, 이 저장소의 불변식).
 * 왜 복원에 확인이 필요한가: 복원은 현재 본문을 스냅샷 본문으로 덮는 **파괴적** 행위다. 다만
 * 백엔드가 복원 직전 현재 본문을 다시 스냅샷하므로, 복원 자체도 이 화면에서 다시 되돌릴 수 있다.
 *
 * `host`를 받는 이유: 확인 다이얼로그([`confirmDialog`])가 오버레이를 붙일 마운트 표면이
 * 필요하기 때문이다(설정 루트 host를 그대로 넘긴다). 반환하는 `refresh`는 마운트 시 한 번,
 * 그리고 복원 뒤 목록을 다시 읽을 때 쓴다(스냅샷이 새로 생겼으므로).
 *
 * 반환하는 `relocalize`는 **정적** 문구(페이지 제목·설명·새로고침 버튼·빈 상태 안내) 네 곳을
 * 호출 시점 로케일로 다시 그린다.
 *
 * **역사 주의**: 이 훅이 생긴 이유는 언어팩이 중앙 호스트 스냅샷으로 **늦게** 도착하던 시절,
 * 이 함수가 언어팩 등록보다 먼저 호출돼 네 문구가 ko로 굳었기 때문이다. 지금은 언어팩이
 * 첫 페인트 전에 등록되고 `mountSettings`가 그보다 뒤에 이 함수를 부르므로 그 실패 자체가
 * 없다 — `relocalize`는 "패널을 만든 뒤 로케일이 또 바뀌는" 미래의 배선 변경에 대한 값싼
 * 안전망으로만 남는다(호출부는 백업·저장폴더 패널의 재렌더 때문에 어차피 이 네 훅을 함께
 * 부른다). 목록 본문(`refresh`)이 그리는 문구는 매번 t()를 다시 부르므로 애초에 무관하다.
 */
function buildRecoveryPanel(
  host: HTMLElement,
  deps: RecoveryDeps,
): {
  panel: HTMLElement;
  refresh: () => Promise<void>;
  relocalize: () => void;
} {
  const panel = document.createElement("section");
  panel.id = "settings-page-recovery"; // e2e/테스트가 대상 삼는 안정 id
  const head = buildSettingsPageHead(
    t("settings.recovery.page-title"),
    t("settings.recovery.page-description"),
  );
  panel.append(head);

  // 상단 도구줄(새로고침) + 상태줄(성공·실패 사유). 상태줄은 평소 숨김.
  // 레이아웃·색은 인라인 스타일로 준다. styles.css는 이 작업의 소유 파일이 아니라 새 규칙을
  // 더할 수 없기 때문이다 — 대신 **테마 CSS 변수**(`--memo-*`)를 참조해 라이트/다크 모두에서
  // 앱과 같은 색을 따르게 한다(설정 창이 루트에 테마 크롬 토큰을 심어 두므로 여기서 해석된다).
  const BORDER = "var(--memo-border, #dcdcd6)";
  const ACCENT = "var(--memo-accent, #37506a)";
  const CARD = "var(--memo-card, #ffffff)";
  const SURFACE = "var(--memo-surface, #faf9f5)";
  const TINT = "var(--memo-accent-tint, rgba(122, 160, 199, 0.12))";
  /** 클릭 가능한 행(노트·저장본) 공통 서식 — 카드형 버튼. */
  const rowBase = `width:100%; text-align:left; padding:8px 10px; border:1px solid ${BORDER}; border-radius:8px; background:${CARD}; color:inherit; font:inherit; cursor:pointer; box-sizing:border-box;`;
  /** 선택된 행에 accent 테두리·틴트를 입힌다(인라인 토글 — 클래스 규칙을 못 쓰므로). */
  const markActive = (el: HTMLElement, active: boolean): void => {
    el.style.borderColor = active ? ACCENT : BORDER;
    el.style.background = active ? TINT : CARD;
  };

  const toolbar = document.createElement("div");
  toolbar.className = "recovery-toolbar";
  toolbar.style.cssText = "display:flex; gap:8px; margin:12px 0 4px;";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  // `.plugin-action-button`을 함께 걸어 기존 설정 버튼과 같은 서식(다크 모드 포함)을 얻는다 —
  // styles.css는 이 작업의 소유 파일이 아니라 새 규칙을 더하지 않고 검증된 클래스를 재사용한다.
  refreshBtn.className = "recovery-refresh plugin-action-button";
  refreshBtn.textContent = t("settings.recovery.refresh-button");
  refreshBtn.style.marginLeft = "0"; // 액션 버튼의 margin-left:auto(우측 밀기)를 취소.
  toolbar.append(refreshBtn);
  const status = document.createElement("p");
  status.className = "recovery-status";
  status.style.cssText = "margin:4px 0 0; font-size:12px;";
  status.hidden = true;
  panel.append(toolbar, status);

  // 본문: 좌(스냅샷 보유 노트) · 우(선택 노트의 저장본 목록 + 미리보기 + 복원).
  const bodyEl = document.createElement("div");
  bodyEl.className = "recovery-body";
  bodyEl.style.cssText =
    "display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; margin-top:8px;";
  const notesEl = document.createElement("div");
  notesEl.className = "recovery-notes";
  notesEl.setAttribute("role", "list");
  notesEl.style.cssText =
    "display:flex; flex-direction:column; gap:6px; flex:0 0 240px; min-width:200px;";
  const detailEl = document.createElement("div");
  detailEl.className = "recovery-detail";
  detailEl.style.cssText =
    "flex:1 1 320px; min-width:280px; display:flex; flex-direction:column; gap:12px;";
  bodyEl.append(notesEl, detailEl);
  panel.append(bodyEl);

  // 빈 상태 안내(스냅샷 보유 노트 0개) — 평소 숨김, 목록이 비면 노출.
  const empty = document.createElement("p");
  empty.className = "recovery-empty";
  empty.style.cssText = "font-size:13px; opacity:0.65; margin-top:12px;";
  empty.textContent = t("settings.recovery.empty");
  empty.hidden = true;
  panel.append(empty);

  // 마지막으로 연 노트 — 새로고침·복원 뒤에도 같은 노트를 다시 연다(사라졌으면 첫 노트로 폴백).
  let selectedNoteId: string | null = null;
  // 선택 세대 카운터 — selectNote는 비동기(listSnapshots)라, 노트 A를 고른 뒤 곧바로 B를
  // 고르면 A의 늦은 응답이 B의 패널 위에 자기 것을 덧그려 두 노트가 겹쳐 보이고(활성 표시와
  // 불일치) 엉뚱한 노트의 복원 버튼이 남는다. 매 호출마다 세대를 올리고 await 뒤 최신 세대가
  // 아니면 렌더를 포기해, 항상 마지막 선택만 화면에 남게 한다(같은 id 재선택도 방어).
  let selectNoteGen = 0;

  const setStatus = (text: string): void => {
    status.textContent = text;
    status.hidden = text === "";
  };

  /** 캡처 시각(에폭 ms)을 사람이 읽는 로컬 시각으로. 0(시각 미상)이면 안내 문구로 폴백. */
  const timeLabel = (ms: number): string =>
    ms > 0
      ? new Date(ms).toLocaleString()
      : t("settings.recovery.time-unknown");

  /** 노트 하나를 골라 그 저장본 목록·미리보기·복원 컨트롤을 우측에 그린다. */
  const selectNote = async (id: string): Promise<void> => {
    const myGen = ++selectNoteGen;
    selectedNoteId = id;
    for (const b of notesEl.querySelectorAll<HTMLElement>(".recovery-note")) {
      const active = b.dataset.note === id;
      b.classList.toggle("recovery-note-active", active);
      b.setAttribute("aria-current", active ? "true" : "false");
      markActive(b, active);
    }
    detailEl.replaceChildren();

    let snaps: NoteSnapshot[];
    try {
      snaps = await deps.listSnapshots(id);
    } catch {
      if (myGen !== selectNoteGen) return; // 오래된 실패 응답이 현재 선택의 상태줄을 덮지 않게.
      setStatus(t("settings.recovery.list-error"));
      return;
    }
    // 이 호출이 더 이상 최신 선택이 아니면(그 사이 다른 노트를 골랐다) 렌더를 포기한다 —
    // 그러지 않으면 이미 비워지고 새로 채워진 detailEl 위에 이 노트의 패널이 덧붙어 겹친다.
    if (myGen !== selectNoteGen) return;

    // 미리보기 + 복원 컨트롤(먼저 만들어 두고, 저장본을 고르면 채운다).
    const previewWrap = document.createElement("div");
    previewWrap.className = "recovery-previewwrap";
    previewWrap.style.cssText =
      "display:flex; flex-direction:column; gap:10px; align-items:flex-start;";
    const previewHint = document.createElement("p");
    previewHint.className = "recovery-preview-hint";
    previewHint.style.cssText = "font-size:12px; opacity:0.6; margin:0;";
    previewHint.textContent = t("settings.recovery.preview-hint");
    const preview = document.createElement("pre");
    preview.className = "recovery-preview";
    preview.style.cssText = `margin:0; width:100%; max-height:320px; overflow:auto; padding:12px; border:1px solid ${BORDER}; border-radius:8px; background:${SURFACE}; white-space:pre-wrap; word-break:break-word; font-size:12px; line-height:1.5; box-sizing:border-box;`;
    preview.hidden = true;
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "recovery-restore plugin-action-button";
    restoreBtn.textContent = t("settings.recovery.restore-button");
    restoreBtn.style.marginLeft = "0"; // 액션 버튼 기본 margin-left:auto 취소(좌측 정렬 유지).
    restoreBtn.hidden = true;
    previewWrap.append(previewHint, preview, restoreBtn);

    let selectedSnapshotId: string | null = null;
    // 저장본 선택도 비동기(readSnapshot)라 같은 경합이 있다: A를 고르고 곧바로 B를 고르면
    // A의 늦은 본문이 미리보기를 덮어, 화면엔 A가 보이는데 복원 대상(selectedSnapshotId)은 B인
    // 불일치가 생긴다(파괴 직전 "미리보기로 확인 후 복원" 안전장치가 깨진다). 세대로 방어한다.
    let selectSnapshotGen = 0;

    /** 저장본 하나의 본문을 읽어 미리보기에 텍스트로만 그린다(신뢰 경계 밖 — innerHTML 금지). */
    const selectSnapshot = async (snapId: string): Promise<void> => {
      const myGen = ++selectSnapshotGen;
      selectedSnapshotId = snapId;
      for (const b of list.querySelectorAll<HTMLElement>(
        ".recovery-snapshot",
      )) {
        const active = b.dataset.snapshot === snapId;
        b.classList.toggle("recovery-snapshot-active", active);
        markActive(b, active);
      }
      let content: string;
      try {
        content = await deps.readSnapshot(id, snapId);
      } catch {
        if (myGen !== selectSnapshotGen) return; // 오래된 실패가 최신 미리보기를 지우지 않게.
        setStatus(t("settings.recovery.snapshot-error"));
        preview.hidden = true;
        restoreBtn.hidden = true;
        return;
      }
      // 이 응답이 더 이상 최신 선택이 아니면 미리보기를 덮지 않는다 — 화면(미리보기)과 복원
      // 대상이 항상 같은 저장본을 가리키게 한다.
      if (myGen !== selectSnapshotGen) return;
      setStatus("");
      previewHint.hidden = true;
      preview.textContent = content; // 신뢰 경계 밖 — 반드시 textContent
      preview.hidden = false;
      restoreBtn.hidden = false;
    };

    restoreBtn.addEventListener("click", () => {
      if (selectedSnapshotId !== null) void doRestore(id, selectedSnapshotId);
    });

    // 저장본 목록(최신순 — 백엔드가 이미 정렬해 준다).
    const list = document.createElement("div");
    list.className = "recovery-snapshots";
    list.setAttribute("role", "list");
    list.style.cssText =
      "display:flex; flex-direction:column; gap:6px; flex:0 0 220px; min-width:180px;";
    for (const s of snaps) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "recovery-snapshot";
      item.dataset.snapshot = s.id;
      item.style.cssText = `${rowBase} display:flex; flex-direction:column; gap:2px;`;
      const when = document.createElement("span");
      when.className = "recovery-snapshot-time";
      when.style.cssText = "font-size:12px; font-weight:600;";
      when.textContent = timeLabel(s.captured_at);
      const pv = document.createElement("span");
      pv.className = "recovery-snapshot-preview";
      pv.style.cssText =
        "font-size:11px; opacity:0.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
      pv.textContent =
        s.preview || s.title || t("settings.recovery.empty-body");
      item.append(when, pv);
      item.addEventListener("click", () => void selectSnapshot(s.id));
      list.append(item);
    }

    // 저장본 목록과 미리보기를 좌우로 나눈다(목록은 좁게, 미리보기는 넓게).
    const detailInner = document.createElement("div");
    detailInner.style.cssText =
      "display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; width:100%;";
    previewWrap.style.flex = "1 1 280px";
    previewWrap.style.minWidth = "240px";
    detailInner.append(list, previewWrap);
    detailEl.append(detailInner);
  };

  /** 복원: 확인 다이얼로그 → restoreSnapshot → 목록 재조회(새 스냅샷 반영) → 성공 안내. */
  const doRestore = async (noteId: string, snapId: string): Promise<void> => {
    const ok = await confirmDialog(
      host,
      t("settings.recovery.restore-confirm"),
      t("settings.recovery.restore-confirm-label"),
    );
    if (!ok) return;
    try {
      await deps.restoreSnapshot(noteId, snapId);
    } catch {
      setStatus(t("settings.recovery.restore-failed"));
      return;
    }
    // 복원으로 새 스냅샷이 생겼으니 목록을 다시 읽어 반영한다(선택 노트 유지). 성공 문구는
    // refresh가 상태줄을 비운 뒤에 얹어, 갱신 후에도 남게 한다.
    await refresh();
    setStatus(t("settings.recovery.restore-done"));
  };

  /** 스냅샷 보유 노트를 다시 읽어 좌측 목록을 조립한다(마운트·새로고침·복원 뒤 공통 진입점). */
  const refresh = async (): Promise<void> => {
    setStatus("");
    notesEl.replaceChildren();
    detailEl.replaceChildren();

    let notes: NoteSummary[];
    try {
      const raw = await deps.listNotes();
      // 경계 방어: 형태가 어긋난 IPC 응답(배열 아님)에 뒤의 .map이 터지지 않게 좁힌다
      // (표시 전용 목록의 관례 — listRejectedPlugins와 같은 원칙).
      notes = Array.isArray(raw) ? raw : [];
    } catch {
      empty.hidden = true;
      setStatus(t("settings.recovery.notes-error"));
      return;
    }

    // 스냅샷 보유 노트 id(삭제된 노트 포함 — finding 2)를 존재하는 노트 목록과 합친다. 삭제된
    // 노트는 `listNotes`(notes/*.md 스캔)에 없어, 이 열거와 합치지 않으면 그 복구 스냅샷이
    // 복구 화면에 영영 나타나지 못한다. 선택 dep이 없으면(구버전 백엔드) 존재 노트만 대상으로
    // 폴백한다(예전 동작).
    let snapNoteIds: string[] = [];
    if (deps.listSnapshotNoteIds) {
      const rawIds = await deps.listSnapshotNoteIds().catch(() => []);
      snapNoteIds = Array.isArray(rawIds) ? rawIds : [];
    }
    const titleById = new Map(notes.map((n) => [n.id, n.title] as const));
    // 합집합: 존재 노트를 앞에, 그다음 목록에 없는(=삭제된) 스냅샷 보유 노트를 붙인다.
    const ids = [...notes.map((n) => n.id)];
    for (const id of snapNoteIds) if (!titleById.has(id)) ids.push(id);

    // 각 노트의 스냅샷 개수를 병렬로 읽어 보유분(>0)만 남긴다 — 스티키 노트 앱은 노트 수가
    // 작아 이 팬아웃이 부담이 되지 않는다.
    const withCounts = await Promise.all(
      ids.map(async (id) => {
        const rawSnaps = await deps.listSnapshots(id).catch(() => []);
        // 경계 방어: 형태가 어긋난 IPC 응답(배열 아님)에 뒤의 인덱싱이 터지지 않게 좁힌다
        // (바로 위 listSnapshotNoteIds와 같은 원칙 — .catch는 reject만 막고 resolve(비배열)는
        // 못 막는다).
        const snaps = Array.isArray(rawSnaps) ? rawSnaps : [];
        const deleted = !titleById.has(id);
        // 삭제된 노트는 사이드카 메타가 없어 제목이 없다 — 최신 스냅샷의 제목으로 대체한다.
        const title = titleById.get(id) || snaps[0]?.title || "";
        return { id, title, deleted, count: snaps.length };
      }),
    );
    const owning = withCounts.filter((w) => w.count > 0);
    if (owning.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const { id, title, deleted, count } of owning) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recovery-note";
      btn.dataset.note = id;
      if (deleted) btn.dataset.deleted = "true";
      btn.style.cssText = `${rowBase} display:flex; justify-content:space-between; align-items:center; gap:10px;`;
      const titleEl = document.createElement("span");
      titleEl.className = "recovery-note-title";
      titleEl.style.cssText =
        "font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;";
      titleEl.textContent = title || t("settings.recovery.untitled-note");
      const badge = document.createElement("span");
      badge.className = "recovery-note-count";
      badge.style.cssText =
        "flex:0 0 auto; font-size:11px; opacity:0.6; white-space:nowrap;";
      // 삭제된 노트는 배지에 "삭제됨"을 병기해 "왜 노트 목록엔 없는데 여기 있나"를 설명한다.
      badge.textContent = deleted
        ? t("settings.recovery.deleted-snapshot-count", { count })
        : t("settings.recovery.snapshot-count", { count });
      btn.append(titleEl, badge);
      btn.addEventListener("click", () => void selectNote(id));
      notesEl.append(btn);
    }

    // 이전에 보던 노트를 유지하되, 목록에서 사라졌으면 첫 노트를 연다.
    const keep = owning.some((w) => w.id === selectedNoteId)
      ? selectedNoteId!
      : owning[0].id;
    await selectNote(keep);
  };

  refreshBtn.addEventListener("click", () => void refresh());

  /** 정적 문구 네 곳을 호출 시점 로케일로 다시 그린다(doc-comment 참고 — mountSettings가
   * 언어팩 등록 뒤 다시 부른다). */
  const relocalize = (): void => {
    const titleEl = head.querySelector<HTMLElement>(".settings-page-title");
    if (titleEl) titleEl.textContent = t("settings.recovery.page-title");
    const descEl = head.querySelector<HTMLElement>(".settings-page-desc");
    if (descEl) descEl.textContent = t("settings.recovery.page-description");
    refreshBtn.textContent = t("settings.recovery.refresh-button");
    empty.textContent = t("settings.recovery.empty");
  };

  return { panel, refresh, relocalize };
}

/**
 * 저장 폴더 이전 오류 코드 → 안내 문구 키(이슈 #21).
 *
 * 백엔드(`vault_move.rs`)가 `"<코드> <설명>"`으로 거부하면 프론트는 **첫 토큰**만 보고 이 표에서
 * 번역된 안내를 고른다([`vaultErrorCode`]). 백엔드 설명문은 한국어라 그대로 보여 주면 영어 UI에
 * 한국어가 새고, 문구를 다듬을 때마다 UI 분기가 깨진다 — 코드가 그 사이의 안정 계약이다.
 * 표에 없는 코드(구버전 백엔드·예상 못 한 실패)는 일반 실패 문구로 떨어진다.
 */
const VAULT_ERROR_MESSAGES: Record<string, string> = {
  VAULT_NOT_ABSOLUTE: "settings.vault.err-not-absolute",
  VAULT_CREATE_FAILED: "settings.vault.err-create-failed",
  VAULT_NOT_A_DIR: "settings.vault.err-not-a-dir",
  VAULT_NOT_READABLE: "settings.vault.err-not-readable",
  VAULT_NOT_WRITABLE: "settings.vault.err-not-writable",
  VAULT_TARGET_HAS_VAULT: "settings.vault.err-target-has-vault",
  VAULT_TARGET_OCCUPIED: "settings.vault.err-target-occupied",
  VAULT_NESTED: "settings.vault.err-nested",
  VAULT_MOVE_FAILED: "settings.vault.err-move-failed",
  VAULT_CONFIG_SAVE_FAILED: "settings.vault.err-config-save-failed",
};

/** 저장 폴더 IPC의 reject를 사용자에게 보여줄 한 문장으로 바꾼다(코드 미상이면 일반 문구). */
function vaultErrorText(error: unknown): string {
  const key = VAULT_ERROR_MESSAGES[vaultErrorCode(error)];
  return t(key ?? "settings.vault.err-unknown");
}

/**
 * 파괴적 작업(저장 폴더 이전 · 설정 초기화 · 모든 데이터 삭제 · 백업 복원)이 **성공한 시점부터**
 * `window.location.reload()`가 실제로 뜨기까지의 대기 구간(900ms~2.5s — [`buildResetPanel`]의
 * 「모든 데이터 삭제」는 reload 자체가 없어 재시작 전까지 영구히) 동안 설정 창 전체를 잠근다.
 *
 * 왜 필요한가: [`mountSettings`]는 마운트 때 읽은 SharedSettings를 클로저(`settings`)에 들고
 * 있다가 저장 때마다 그 전체를 스프레드해 다시 쓴다(`persist`). 그런데 지금까지는 성공 후
 * reload가 뜨기 전까지 그 패널 자신의 버튼만 잠그고 좌측 트리·다른 탭(테마·글꼴·단축키·툴바
 * 배치)은 그대로 열어 뒀다 — 그 틈에 다른 탭에서 사소한 값 하나만 바꿔도 persist가 낡은
 * 스냅샷 전체를 저장해, 방금 전환·초기화·복원된 값을 조용히 되돌린다. 오버레이는
 * pointer-events로 클릭을 가로채고 전체를 어둡게 덮어 이 창 자체를 조작 불가능하게 만든다.
 *
 * 실패(취소·에러) 경로에서는 아예 부르지 않는다 — 그 경우 되돌릴 값이 없으므로 각 패널이
 * 이미 하던 대로 자기 버튼만 다시 풀어 재시도를 허용한다. 즉 한 번 잠그면 이 창은
 * reload(또는 「모든 데이터 삭제」처럼 수동 재시작)까지 다시 풀리지 않는다 — unlock을 굳이
 * 제공하지 않는 이유다.
 */
function lockSettingsHost(host: HTMLElement, message: string): void {
  let overlay = host.querySelector<HTMLElement>(
    ":scope > .settings-destructive-overlay",
  );
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "settings-destructive-overlay";
    overlay.setAttribute("role", "alert");
    overlay.setAttribute("aria-live", "assertive");
    host.append(overlay);
  }
  overlay.textContent = message;
  overlay.hidden = false;
}

/**
 * "도움말 › 시작 가이드" 페이지 — 시작 가이드 메모를 다시 연다.
 *
 * 페이지에 항목이 버튼 하나뿐인 이유: 가이드는 **설정 값이 아니라 메모**다. 여기서 할 수 있는
 * 일은 "다시 보여 줘" 하나뿐이고, 나머지(읽고 지우기)는 그 메모 창에서 한다.
 *
 * 노드 자체가 선택 dep([`SettingsDeps.openGuideNote`])에 매여 있어(없으면 이 페이지를 아예
 * 만들지 않는다 — "IO 없으면 UI 없음" 관례) 여기서는 `open`이 항상 있다고 보고 그린다.
 *
 * 버튼을 누르는 동안 비활성화하는 이유: 없는 가이드를 다시 만드는 경로는 노트 생성 IO라
 * 느린 vault에서 몇 백 ms가 걸릴 수 있고, 그 사이 연타하면 `force` 생성이 여러 번 나가
 * 가이드가 여러 장 만들어진다(코어의 선점은 `force`를 막지 않는다 — 「다시 보기」의 계약이
 * 그렇다).
 */
function buildHelpPanel(open: () => Promise<void>): HTMLElement {
  const panel = document.createElement("section");
  panel.id = "settings-page-help"; // e2e/테스트 대상 안정 id
  panel.append(
    buildSettingsPageHead(
      t("settings.help.page-title"),
      t("settings.help.page-description"),
    ),
  );

  const section = document.createElement("div");
  section.className = "reset-section"; // 저장 폴더·초기화 페이지와 같은 카드 룩.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plugin-action-button";
  button.style.marginLeft = "0"; // 액션 버튼 기본 margin-left:auto 취소(좌측 정렬).
  button.textContent = t("settings.help.open-guide");
  const status = document.createElement("p");
  status.className = "reset-status plugin-setting-status";
  status.hidden = true;
  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === "";
  };
  button.addEventListener("click", () => {
    button.disabled = true;
    say(t("settings.help.opening"));
    void open()
      .then(
        () => say(t("settings.help.opened")),
        // 실패 문구는 고정이다 — 백엔드 오류 문자열은 한국어 원문이라 영어 UI에 새고,
        // 사용자가 할 수 있는 일도 "잠시 후 다시"뿐이다(저장 폴더 페이지와 같은 관례).
        (err: unknown) => {
          console.error("[settings] openGuideNote failed", err);
          say(t("settings.help.open-failed"));
        },
      )
      .finally(() => {
        button.disabled = false;
      });
  });
  section.append(button, status);
  panel.append(section);
  return panel;
}

/**
 * "관리 › 저장 폴더" 페이지(이슈 #21) — 메모가 저장되는 폴더를 보여 주고 옮긴다.
 *
 * ## 플로우
 *
 * 1. 「폴더 변경…」 → 네이티브 폴더 선택기([`pickVaultFolder`]). 취소면 아무 일도 없다.
 * 2. 고른 폴더를 곧바로 검사한다([`inspectVaultFolder`]) — 백엔드가 프로브 파일을 **실제로 쓰고
 *    지워** 읽기/쓰기를 확인한다. 권한이 없으면 여기서 끝난다(내용물을 옮기기 시작한 뒤가
 *    아니라, 폴더를 고른 직후에 알려 준다).
 * 3. 무엇을 물을지는 검사 결과가 정한다:
 *    - 대상에 이미 메모가 있다 → 이동은 애초에 거부되므로(합치면 어느 쪽이 정본인지 알 수 없다)
 *      "그 메모를 이어서 쓸까요?"만 확인한다.
 *    - 대상이 비어 있고 지금 폴더에 옮길 것이 있다 → **3지선다**([`choiceDialog`]):
 *      "파일을 함께 이동" / "이동하지 않고 전환" / "취소". 이 갈림길을 확인 팝업 두 번으로
 *      쪼개면 두 번째 질문에서 첫 답의 맥락이 사라진다.
 *    - 대상이 비어 있고 지금 폴더도 비어 있다 → 물어볼 것이 없다(단순 확인 한 번).
 * 4. [`changeVaultPath`] 실행 → 결과 요약을 상태 줄에 남기고 페이지를 새로 읽는다.
 *
 * `host`가 필요한 이유는 복구·초기화 페이지와 같다(확인/선택 오버레이의 마운트 표면).
 * IO를 `SettingsDeps`로 주입하지 않는 이유도 [`buildResetPanel`]과 같다 — 이 창의 배선부는
 * 이번 작업의 편집 범위 밖이고, "배선이 없으면 조용히 숨긴다"는 옵션 dep 관례는 **숨길 수 없는**
 * 페이지에는 쓸 수 없다.
 */
function buildVaultPanel(host: HTMLElement): {
  panel: HTMLElement;
  refresh: () => Promise<void>;
  relocalize: () => void;
} {
  const panel = document.createElement("section");
  panel.id = "settings-page-vault"; // e2e/테스트 대상 안정 id
  const head = buildSettingsPageHead(
    t("settings.vault.page-title"),
    t("settings.vault.page-description"),
  );
  panel.append(head);

  const section = document.createElement("div");
  section.className = "reset-section"; // 초기화 페이지와 같은 카드 룩을 재사용한다.
  const label = document.createElement("h3");
  label.className = "settings-group-title reset-section-title";
  label.textContent = t("settings.vault.current-label");
  const pathEl = document.createElement("p");
  pathEl.className = "vault-path";
  // 경로는 사용자가 복사해 파일 탐색기에 붙여넣는 값이라 선택 가능해야 한다.
  pathEl.style.userSelect = "text";
  const countsEl = document.createElement("p");
  countsEl.className = "reset-section-desc vault-counts";
  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "vault-change-button plugin-action-button";
  changeBtn.style.marginLeft = "0"; // 액션 버튼 기본 margin-left:auto 취소(좌측 정렬).
  changeBtn.textContent = t("settings.vault.change-button");
  const status = document.createElement("p");
  status.className = "reset-status plugin-setting-status";
  status.hidden = true;
  section.append(label, pathEl, countsEl, changeBtn, status);
  panel.append(section);

  /** 현재 폴더 상태(마지막으로 읽은 값) — 3지선다를 낼지 판단하는 근거. */
  let info: VaultInfo | null = null;

  const setStatus = (text: string): void => {
    status.textContent = text;
    status.hidden = text === "";
  };

  const refresh = async (): Promise<void> => {
    try {
      info = await getVaultInfo();
    } catch {
      info = null;
      pathEl.textContent = t("settings.vault.info-failed");
      countsEl.textContent = "";
      return;
    }
    pathEl.textContent = info.path;
    countsEl.textContent = info.has_contents
      ? t("settings.vault.counts", {
          notes: info.note_count,
          files: info.file_count,
        })
      : t("settings.vault.empty-note");
  };

  /**
   * 변경을 실행하고 결과를 상태 줄에 남긴다.
   *
   * 성공하면(실제로 폴더가 바뀌었으면) 잠시 뒤 **이 창을 새로고침한다**. 왜: `mountSettings`는
   * 마운트 때 읽은 공유 설정을 메모리에 들고 있다가 사용자가 무언가를 바꿀 때 그 객체를 통째로
   * 저장한다(`persist`). 다른 vault로 갈아탄 뒤에도 그 낡은 사본을 들고 있으면, 이후의 사소한
   * 변경 하나가 **새 vault의 테마·키맵·툴바 배치를 옛 vault의 값으로 조용히 덮어쓴다**. 창을
   * 다시 그리는 편이 확실하다(설정 초기화가 같은 이유로 쓰는 처리 — `buildResetPanel` 참고).
   * 지연을 두는 것은 결과 문구를 읽을 시간을 주기 위함이고, 새로고침 뒤에는 이 페이지가 새
   * 경로를 그대로 보여 주므로 확인이 이어진다.
   */
  const apply = async (path: string, moveFiles: boolean): Promise<void> => {
    changeBtn.disabled = true;
    setStatus(
      t(moveFiles ? "settings.vault.working" : "settings.vault.switching"),
    );
    try {
      const result = await changeVaultPath(path, moveFiles);
      if (result.outcome === "unchanged") {
        // 바뀐 것이 없으니 새로고침도 필요 없다(버튼만 되살린다).
        setStatus(t("settings.vault.same-folder"));
        changeBtn.disabled = false;
        return;
      }
      setStatus(
        result.outcome === "moved"
          ? t("settings.vault.done-moved", {
              path: result.path,
              files: result.moved_files,
            })
          : t("settings.vault.done-linked", { path: result.path }),
      );
      // 성공 확정 — reload가 뜨기 전까지 이 창 전체를 잠근다(confirmed[19], 위 doc-comment 참고).
      lockSettingsHost(host, t("settings.overlay.applying"));
      await refresh();
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      setStatus(vaultErrorText(error));
      changeBtn.disabled = false;
    }
  };

  changeBtn.addEventListener("click", () => {
    void (async () => {
      const picked = await pickVaultFolder().catch(() => null);
      if (!picked) return; // 취소 — 아무 말도 하지 않는다.

      changeBtn.disabled = true;
      setStatus(t("settings.vault.checking"));
      let target: VaultTargetInfo;
      try {
        target = await inspectVaultFolder(picked);
      } catch (error) {
        setStatus(vaultErrorText(error));
        changeBtn.disabled = false;
        return;
      }
      changeBtn.disabled = false;
      setStatus("");

      if (target.same_as_current) {
        setStatus(t("settings.vault.same-folder"));
        return;
      }

      // 대상에 이미 우리 데이터가 있으면 이동은 백엔드가 거부한다 — "연결"만 물어본다.
      if (target.has_vault || target.occupied) {
        const ok = await confirmDialog(
          host,
          t(
            target.has_vault
              ? "settings.vault.confirm-link-existing"
              : "settings.vault.confirm-link-occupied",
            { path: target.path },
          ),
          t("settings.vault.confirm-link-label"),
        );
        if (ok) await apply(target.path, false);
        return;
      }

      // 대상이 비어 있다. 옮길 것이 없으면 물어볼 것도 없다(확인 한 번).
      if (!info?.has_contents) {
        const ok = await confirmDialog(
          host,
          t("settings.vault.confirm-empty", { path: target.path }),
          t("settings.vault.confirm-empty-label"),
        );
        if (ok) await apply(target.path, false);
        return;
      }

      const choice = await choiceDialog<"move" | "link">(
        host,
        t("settings.vault.choose-message", {
          path: target.path,
          notes: info.note_count,
          files: info.file_count,
        }),
        [
          { label: t("settings.vault.choice-link"), value: "link" },
          { label: t("settings.vault.choice-move"), value: "move" },
        ],
      );
      if (choice === null) return;
      await apply(target.path, choice === "move");
    })();
  });

  /** 정적 문구를 호출 시점 로케일로 다시 그린다(복구·초기화 페이지와 같은 이유). */
  const relocalize = (): void => {
    const titleEl = head.querySelector<HTMLElement>(".settings-page-title");
    if (titleEl) titleEl.textContent = t("settings.vault.page-title");
    const descEl = head.querySelector<HTMLElement>(".settings-page-desc");
    if (descEl) descEl.textContent = t("settings.vault.page-description");
    label.textContent = t("settings.vault.current-label");
    changeBtn.textContent = t("settings.vault.change-button");
    // 개수 줄은 데이터에서 파생되므로 마지막으로 읽은 값으로 다시 만든다.
    if (info) {
      countsEl.textContent = info.has_contents
        ? t("settings.vault.counts", {
            notes: info.note_count,
            files: info.file_count,
          })
        : t("settings.vault.empty-note");
    }
  };

  return { panel, refresh, relocalize };
}

/** 백업 IPC 오류 코드 → 안내 문구 키(저장 폴더의 `VAULT_ERROR_MESSAGES`와 같은 관례). */
const BACKUP_ERROR_MESSAGES: Record<string, string> = {
  BACKUP_WRITE_FAILED: "settings.backup.err-write-failed",
  BACKUP_READ_FAILED: "settings.backup.err-read-failed",
  BACKUP_TOO_LARGE: "settings.backup.err-too-large",
  BACKUP_NOT_A_BACKUP: "settings.backup.err-not-a-backup",
  BACKUP_UNSUPPORTED_VERSION: "settings.backup.err-unsupported",
  BACKUP_CORRUPT: "settings.backup.err-corrupt",
  BACKUP_NOTHING_SELECTED: "settings.backup.err-nothing-selected",
  BACKUP_SNAPSHOT_FAILED: "settings.backup.err-snapshot-failed",
  BACKUP_RESTORE_FAILED: "settings.backup.err-restore-failed",
};

/** 백업 IPC의 reject를 사용자에게 보여줄 한 문장으로 바꾼다(코드 미상이면 일반 문구). */
function backupErrorText(error: unknown): string {
  const key = BACKUP_ERROR_MESSAGES[backupErrorCode(error)];
  return t(key ?? "settings.backup.err-unknown");
}

/**
 * "관리 › 백업" 페이지(이슈 #28 1단계) — 설정과 플러그인을 파일 하나로 내보내고 되돌린다.
 *
 * ## 플로우
 *
 * **내보내기**: 버튼 하나. 저장 위치는 백엔드가 띄우는 네이티브 저장 다이얼로그로 고르고
 * (취소하면 아무 말도 하지 않는다), 성공하면 경로와 담긴 플러그인 수를 상태 줄에 남긴다.
 *
 * **가져오기**: 파일 선택 → [`inspectBackup`] → **미리보기 카드**(만든 시각·앱 버전·담긴 것)
 * + 복원 대상 체크박스(설정/플러그인) → 확인 다이얼로그 → 실행. 고르자마자 복원하지 않고
 * 미리보기를 한 단계 두는 이유는 저장 폴더 이전([`buildVaultPanel`])과 같다 — 파괴적 동작
 * 앞에서는 "무엇이 일어날지"를 먼저 보여 주는 편이 정직하고, 백업 파일은 이름만으로 내용을
 * 알 수 없다(석 달 전 다른 기기에서 만든 것일 수 있다).
 *
 * 체크박스는 백업에 **실제로 들어 있는 것**만 켤 수 있다(설정이 없는 백업이면 잠긴다) — 고를
 * 수 없는 선택지를 켤 수 있게 두면 "복원했는데 아무 일도 없었다"가 된다.
 *
 * `host`가 필요한 이유는 초기화·저장 폴더 페이지와 같다(확인 오버레이의 마운트 표면).
 * IO를 `SettingsDeps`로 주입하지 않는 이유도 [`buildResetPanel`]과 같다.
 */
function buildBackupPanel(host: HTMLElement): {
  panel: HTMLElement;
  relocalize: () => void;
} {
  const panel = document.createElement("section");
  panel.id = "settings-page-backup"; // e2e/테스트 대상 안정 id
  const head = buildSettingsPageHead(
    t("settings.backup.page-title"),
    t("settings.backup.page-description"),
  );
  panel.append(head);

  // ── 내보내기 ──
  const exportSection = document.createElement("div");
  exportSection.className = "reset-section";
  const exportTitle = document.createElement("h3");
  exportTitle.className = "settings-group-title reset-section-title";
  exportTitle.textContent = t("settings.backup.export-title");
  const exportDesc = document.createElement("p");
  exportDesc.className = "reset-section-desc";
  exportDesc.textContent = t("settings.backup.export-desc");
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "backup-export-button plugin-action-button";
  exportBtn.style.marginLeft = "0"; // 액션 버튼 기본 margin-left:auto 취소(좌측 정렬).
  exportBtn.textContent = t("settings.backup.export-button");
  const exportStatus = document.createElement("p");
  exportStatus.className = "reset-status plugin-setting-status";
  exportStatus.hidden = true;
  exportSection.append(exportTitle, exportDesc, exportBtn, exportStatus);

  // ── 가져오기 ──
  const importSection = document.createElement("div");
  importSection.className = "reset-section";
  const importTitle = document.createElement("h3");
  importTitle.className = "settings-group-title reset-section-title";
  importTitle.textContent = t("settings.backup.import-title");
  const importDesc = document.createElement("p");
  importDesc.className = "reset-section-desc";
  importDesc.textContent = t("settings.backup.import-desc");
  const grantNote = document.createElement("p");
  grantNote.className = "reset-wipe-hint backup-grant-note";
  grantNote.textContent = t("settings.backup.grant-note");
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "backup-import-button plugin-action-button";
  importBtn.style.marginLeft = "0";
  importBtn.textContent = t("settings.backup.import-button");

  // 미리보기 카드(파일을 고른 뒤에만 보인다).
  const preview = document.createElement("div");
  preview.className = "backup-preview";
  preview.hidden = true;
  const previewPath = document.createElement("p");
  previewPath.className = "backup-preview-path";
  previewPath.style.userSelect = "text"; // 경로는 사용자가 복사할 수 있어야 한다.
  const previewFacts = document.createElement("ul");
  previewFacts.className = "backup-preview-facts";
  const previewWarn = document.createElement("p");
  previewWarn.className = "backup-preview-warn";
  previewWarn.hidden = true;
  const choices = document.createElement("div");
  choices.className = "backup-choices";
  const settingsChoice = buildBackupChoice("settings");
  const pluginsChoice = buildBackupChoice("plugins");
  choices.append(settingsChoice.label, pluginsChoice.label);
  const actions = document.createElement("div");
  actions.className = "backup-preview-actions";
  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.className = "backup-restore-button plugin-action-button";
  restoreBtn.style.marginLeft = "0";
  restoreBtn.textContent = t("settings.backup.restore-button");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "backup-cancel-button plugin-action-button";
  cancelBtn.style.marginLeft = "0";
  cancelBtn.textContent = t("settings.backup.cancel-button");
  actions.append(restoreBtn, cancelBtn);
  preview.append(previewPath, previewFacts, previewWarn, choices, actions);

  const importStatus = document.createElement("p");
  importStatus.className = "reset-status plugin-setting-status";
  importStatus.hidden = true;
  importSection.append(
    importTitle,
    importDesc,
    grantNote,
    importBtn,
    preview,
    importStatus,
  );

  // 메모 자체는 백업에 담기지 않는다 — 그 몫이 저장 폴더에 있다는 것을 한 줄로 알려 준다.
  const syncHint = document.createElement("p");
  syncHint.className = "reset-section-desc backup-sync-hint";
  syncHint.textContent = t("settings.backup.sync-hint");

  panel.append(exportSection, importSection, syncHint);

  /** 마지막으로 검사한 백업(복원 실행의 대상). 닫으면 null로 돌아간다. */
  let selected: BackupSummary | null = null;
  /**
   * `importBackup()`이 진행 중인가(confirmed[20]) — restoreBtn 클릭 핸들러가 요청 직전에
   * true로, 완료(성공·실패 무관)되면 false로 되돌린다. 이 창이 살아 있는 동안 다른 창의 설정
   * 저장 등으로 호스트가 재빌드되면 `relocalize()`가 `renderPreview(selected)`를 다시 태워
   * `syncRestoreEnabled()`가 재계산되는데, 그 재계산은 `selected.supported`와 체크박스 상태만
   * 보고 restoreBtn을 되살린다 — 진행 중인 복원 자체는 전혀 모른다. `restoring`은 그 재계산이
   * 무슨 값을 내든 무조건 restoreBtn을 잠가, 첫 번째 `importBackup()` 호출이 끝나기 전에
   * 두 번째 호출이 겹치는 것을 막는다.
   */
  let restoring = false;

  const setStatus = (el: HTMLElement, text: string): void => {
    el.textContent = text;
    el.hidden = text === "";
  };

  /** 복원 버튼 활성 조건: 복원 진행 중이 아니고 + 복원 가능한 백업 + 체크된 항목이 하나 이상. */
  const syncRestoreEnabled = (): void => {
    restoreBtn.disabled =
      restoring ||
      !selected?.supported ||
      (!settingsChoice.input.checked && !pluginsChoice.input.checked);
  };
  settingsChoice.input.addEventListener("change", syncRestoreEnabled);
  pluginsChoice.input.addEventListener("change", syncRestoreEnabled);

  /** 미리보기를 닫고 선택을 버린다(취소·복원 완료 후). */
  const closePreview = (): void => {
    selected = null;
    preview.hidden = true;
    previewFacts.replaceChildren();
  };

  /** 검사 결과를 카드에 그린다 — 사실만 나열하고 판단은 사용자에게 맡긴다. */
  const renderPreview = (summary: BackupSummary): void => {
    selected = summary;
    previewPath.textContent = summary.path;
    const facts = [
      t("settings.backup.fact-created", {
        time: new Date(summary.created_at).toLocaleString(),
      }),
      t("settings.backup.fact-app", {
        version: summary.app_version || "?",
        platform: summary.platform || "?",
      }),
      summary.has_settings
        ? t("settings.backup.fact-settings")
        : t("settings.backup.fact-no-settings"),
      summary.plugins.length > 0
        ? t("settings.backup.fact-plugins", {
            count: summary.plugins.length,
            names: summary.plugins.map((p) => p.name).join(", "),
          })
        : t("settings.backup.fact-no-plugins"),
    ];
    previewFacts.replaceChildren(
      ...facts.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    previewWarn.textContent = summary.supported
      ? ""
      : t("settings.backup.preview-unsupported");
    previewWarn.hidden = summary.supported;

    // 백업에 없는 것은 고를 수 없다(잠근 채 꺼 둔다).
    settingsChoice.input.checked = summary.has_settings;
    settingsChoice.input.disabled = !summary.has_settings;
    pluginsChoice.input.checked = summary.plugins.length > 0;
    pluginsChoice.input.disabled = summary.plugins.length === 0;
    preview.hidden = false;
    syncRestoreEnabled();
  };

  exportBtn.addEventListener("click", () => {
    void (async () => {
      exportBtn.disabled = true;
      setStatus(exportStatus, t("settings.backup.export-working"));
      try {
        const result = await exportBackup();
        setStatus(
          exportStatus,
          result
            ? t("settings.backup.export-done", {
                path: result.path,
                plugins: result.plugins.length,
              })
            : "", // 취소 — 아무 말도 하지 않는다.
        );
      } catch (error) {
        setStatus(exportStatus, backupErrorText(error));
      }
      exportBtn.disabled = false;
    })();
  });

  importBtn.addEventListener("click", () => {
    void (async () => {
      const picked = await pickBackupFile().catch(() => null);
      if (!picked) return; // 취소 — 아무 말도 하지 않는다.
      importBtn.disabled = true;
      closePreview();
      setStatus(importStatus, t("settings.backup.checking"));
      try {
        renderPreview(await inspectBackup(picked));
        setStatus(importStatus, "");
      } catch (error) {
        setStatus(importStatus, backupErrorText(error));
      }
      importBtn.disabled = false;
    })();
  });

  cancelBtn.addEventListener("click", () => {
    closePreview();
    setStatus(importStatus, "");
  });

  restoreBtn.addEventListener("click", () => {
    void (async () => {
      const target = selected;
      if (!target) return;
      const restore = {
        settings: settingsChoice.input.checked,
        plugins: pluginsChoice.input.checked,
      };
      const ok = await confirmDialog(
        host,
        t("settings.backup.confirm", { path: target.path }),
        t("settings.backup.confirm-label"),
      );
      if (!ok) return;
      // confirmed[20]: importBackup() 요청 전에 먼저 세운다 — 진행 중 이 창이 relocalize()로
      // 다시 그려져도(다른 창의 설정 저장으로 인한 호스트 재빌드 등) syncRestoreEnabled가
      // restoring을 보고 restoreBtn을 계속 잠근 채로 둔다(아래 restoring 선언부 doc-comment).
      restoring = true;
      restoreBtn.disabled = true;
      cancelBtn.disabled = true;
      importBtn.disabled = true;
      setStatus(importStatus, t("settings.backup.working"));
      let report;
      try {
        report = await importBackup(target.path, restore);
      } catch (error) {
        setStatus(importStatus, backupErrorText(error));
        restoring = false;
        restoreBtn.disabled = false;
        cancelBtn.disabled = false;
        importBtn.disabled = false;
        return;
      }
      restoring = false;
      // 결과를 한 문단으로 모아 보여 준다: 무엇이 돌아왔는지 + 되돌리는 법 + (있다면) 실패 목록.
      const lines = [
        t("settings.backup.done"),
        report.plugins_restored > 0
          ? t("settings.backup.done-plugins", {
              count: report.plugins_restored,
            })
          : "",
        report.plugins_failed.length > 0
          ? t("settings.backup.done-failed", {
              names: report.plugins_failed.join(", "),
            })
          : "",
        t("settings.backup.snapshot-note", { path: report.snapshot_path }),
      ].filter((line) => line !== "");
      closePreview();
      setStatus(importStatus, lines.join(" "));
      // 성공 확정 — reload가 뜨기 전까지 이 창 전체를 잠근다(confirmed[19], lockSettingsHost 참고).
      lockSettingsHost(host, t("settings.overlay.applying"));
      // 테마·언어·플러그인이 한꺼번에 바뀌므로 부분 재렌더 대신 이 창 자체를 새로 고친다
      // (설정 초기화와 같은 이유 — `buildResetPanel` 참고). 결과 문구를 읽을 시간을 준다.
      setTimeout(() => window.location.reload(), 2500);
    })();
  });

  /** 정적 문구를 호출 시점 로케일로 다시 그린다(다른 관리 페이지와 같은 이유). */
  const relocalize = (): void => {
    const titleEl = head.querySelector<HTMLElement>(".settings-page-title");
    if (titleEl) titleEl.textContent = t("settings.backup.page-title");
    const descEl = head.querySelector<HTMLElement>(".settings-page-desc");
    if (descEl) descEl.textContent = t("settings.backup.page-description");
    exportTitle.textContent = t("settings.backup.export-title");
    exportDesc.textContent = t("settings.backup.export-desc");
    exportBtn.textContent = t("settings.backup.export-button");
    importTitle.textContent = t("settings.backup.import-title");
    importDesc.textContent = t("settings.backup.import-desc");
    grantNote.textContent = t("settings.backup.grant-note");
    importBtn.textContent = t("settings.backup.import-button");
    restoreBtn.textContent = t("settings.backup.restore-button");
    cancelBtn.textContent = t("settings.backup.cancel-button");
    settingsChoice.text.textContent = t("settings.backup.choice-settings");
    pluginsChoice.text.textContent = t("settings.backup.choice-plugins");
    syncHint.textContent = t("settings.backup.sync-hint");
    // 미리보기는 데이터에서 파생되므로 열려 있으면 마지막 결과로 다시 그린다. 사용자가 이미
    // 손댄 체크 상태는 그대로 되돌려 놓는다 — 이 함수는 언어 변경뿐 아니라 (다른 창의 설정
    // 저장으로 인한) 호스트 재빌드로도 불릴 수 있어서, 다시 그리는 김에 선택을 초기화하면
    // 사용자가 고른 복원 대상이 남의 저장 한 번에 조용히 바뀐다. renderPreview → syncRestoreEnabled가
    // restoreBtn.disabled를 재계산하지만(confirmed[20]), `restoring`이 true인 동안은 그 재계산
    // 결과와 무관하게 잠근 채로 남는다 — importBackup()이 끝나기 전에 이 재호출로 복원 버튼이
    // 되살아나 두 번째 importBackup()이 겹치는 일은 없다.
    if (selected) {
      const kept = {
        settings: settingsChoice.input.checked,
        plugins: pluginsChoice.input.checked,
      };
      renderPreview(selected);
      if (!settingsChoice.input.disabled) {
        settingsChoice.input.checked = kept.settings;
      }
      if (!pluginsChoice.input.disabled) {
        pluginsChoice.input.checked = kept.plugins;
      }
      syncRestoreEnabled();
    }
  };

  return { panel, relocalize };
}

/** 복원 대상 체크박스 하나(설정/플러그인) — 라벨·입력·문구 노드를 함께 돌려준다. */
function buildBackupChoice(kind: "settings" | "plugins"): {
  label: HTMLElement;
  input: HTMLInputElement;
  text: HTMLElement;
} {
  const label = document.createElement("label");
  label.className = "backup-choice";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "backup-choice-input";
  input.checked = true;
  const text = document.createElement("span");
  text.textContent = t(`settings.backup.choice-${kind}`);
  label.append(input, text);
  return { label, input, text };
}

/** 모든 데이터 삭제 확인 입력에 요구하는 문자열 — 로케일과 무관하게 고정된다(GitHub 저장소
 * 삭제 등 파괴적 확인의 흔한 관례). 안내 문구(`settings.reset.wipe-hint`)는 번역돼도, 실제
 * 대조 문자열은 어떤 언어에서도 같아야 사용자가 "타이핑 실수인지 언어 문제인지" 헷갈리지 않는다. */
const WIPE_CONFIRM_WORD = "DELETE";

/**
 * "관리 › 초기화" 페이지(이슈 #20) — 설정만 초기화하는 버튼과 모든 데이터를 영구히 지우는
 * 버튼을 담는다. 둘 다 이 파괴적 동작에 걸맞은 확인을 거친다: 설정 초기화는 `confirmDialog`
 * 한 번(다른 "기본값으로 되돌리기" 액션과 같은 무게 — `settings.list-field.reset-confirm`·
 * `settings.toolbar-layout.reset-button` 참고), 모든 데이터 삭제는 확인 문자열
 * 입력(버튼이 잠겨 있다가 [`WIPE_CONFIRM_WORD`]를 정확히 입력해야 풀린다) + `confirmDialog`
 * 이중 확인이다.
 *
 * `host`가 필요한 이유: `confirmDialog`가 오버레이를 붙일 마운트 표면이 필요하다(recovery
 * 패널과 같은 이유).
 *
 * IO는 `SettingsDeps`로 주입하지 않고 `shared/tauri`의 `resetSettings`/`wipeAllData`를 이
 * 파일이 직접 부른다(예외 — recovery 등 다른 페이지와 다르다). 왜: 이 창의 배선부
 * (`bootstrap/settings.ts`, `mountSettings` 호출부의 deps 객체 리터럴)는 이번 작업의 편집
 * 범위 밖이다. 다른 IO는 전부 선택(optional) dep으로 두어 "배선이 없으면 그 기능만 조용히
 * 숨긴다"는 관례를 쓰지만(`pickPluginDir`·`setDevPlugin` 등), 초기화/삭제는 **숨길 수 없는**
 * 이 페이지의 존재 이유라 그 관례를 쓸 수 없다 — 배선 없이 뜬 죽은 버튼보다, 이 파일이 직접
 * 부르는 살아있는 버튼이 낫다.
 *
 * 정적 문구만 있어(플러그인·노트처럼 목록을 그리지 않는다) 데이터 refresh는 필요 없고,
 * `relocalize`는 recovery 패널과 **같은 이유·같은 위상**이다(그쪽 doc-comment 참고 — 언어팩이
 * 늦게 오던 시절의 훅이 지금은 값싼 안전망으로 남았다).
 */
function buildResetPanel(host: HTMLElement): {
  panel: HTMLElement;
  relocalize: () => void;
} {
  const panel = document.createElement("section");
  panel.id = "settings-page-reset"; // e2e/테스트 대상 안정 id
  const head = buildSettingsPageHead(
    t("settings.reset.page-title"),
    t("settings.reset.page-description"),
  );
  panel.append(head);

  // ── 설정 초기화 ──
  const settingsSection = document.createElement("div");
  settingsSection.className = "reset-section";
  const settingsTitle = document.createElement("h3");
  settingsTitle.className = "settings-group-title reset-section-title";
  settingsTitle.textContent = t("settings.reset.section-settings-title");
  const settingsDesc = document.createElement("p");
  settingsDesc.className = "reset-section-desc";
  settingsDesc.textContent = t("settings.reset.section-settings-desc");
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "reset-settings-button plugin-action-button";
  settingsBtn.style.marginLeft = "0"; // 액션 버튼 기본 margin-left:auto 취소(좌측 정렬 유지).
  settingsBtn.textContent = t("settings.reset.settings-button");
  const settingsStatus = document.createElement("p");
  settingsStatus.className = "reset-status plugin-setting-status";
  settingsStatus.hidden = true;
  settingsSection.append(
    settingsTitle,
    settingsDesc,
    settingsBtn,
    settingsStatus,
  );

  // ── 모든 데이터 삭제 ──
  const wipeSection = document.createElement("div");
  wipeSection.className = "reset-section reset-section-danger";
  const wipeTitle = document.createElement("h3");
  wipeTitle.className =
    "settings-group-title reset-section-title reset-section-title-danger";
  wipeTitle.textContent = t("settings.reset.section-wipe-title");
  const wipeDesc = document.createElement("p");
  wipeDesc.className = "reset-section-desc";
  wipeDesc.textContent = t("settings.reset.section-wipe-desc");
  const wipeHint = document.createElement("p");
  wipeHint.className = "reset-wipe-hint";
  wipeHint.textContent = t("settings.reset.wipe-hint");
  const wipeInput = document.createElement("input");
  wipeInput.type = "text";
  wipeInput.className = "plugin-setting-input reset-wipe-input";
  wipeInput.autocomplete = "off";
  wipeInput.spellcheck = false;
  wipeInput.placeholder = t("settings.reset.wipe-input-placeholder");
  wipeInput.setAttribute("aria-label", t("settings.reset.wipe-hint"));
  const wipeBtn = document.createElement("button");
  wipeBtn.type = "button";
  wipeBtn.className = "reset-wipe-button";
  wipeBtn.disabled = true;
  wipeBtn.textContent = t("settings.reset.wipe-button");
  const wipeStatus = document.createElement("p");
  wipeStatus.className = "reset-status plugin-setting-status";
  wipeStatus.hidden = true;
  wipeSection.append(
    wipeTitle,
    wipeDesc,
    wipeHint,
    wipeInput,
    wipeBtn,
    wipeStatus,
  );

  panel.append(settingsSection, wipeSection);

  const setStatus = (el: HTMLElement, text: string): void => {
    el.textContent = text;
    el.hidden = text === "";
  };

  wipeInput.addEventListener("input", () => {
    wipeBtn.disabled = wipeInput.value.trim() !== WIPE_CONFIRM_WORD;
  });

  settingsBtn.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        host,
        t("settings.reset.settings-confirm"),
        t("settings.reset.settings-confirm-label"),
      );
      if (!ok) return;
      settingsBtn.disabled = true;
      setStatus(settingsStatus, "");
      try {
        await resetSettings();
      } catch {
        setStatus(settingsStatus, t("settings.reset.settings-failed"));
        settingsBtn.disabled = false;
        return;
      }
      // 테마·언어·키맵 등이 한꺼번에 바뀌므로 부분 재렌더 대신 이 창 자체를 새로 고친다
      // (언어 변경 처리와 같은 이유 — renderThemePage의 언어 피커 onChange 주석 참고). 짧게
      // 지연해 완료 문구를 잠깐 보여준 뒤 넘어간다.
      setStatus(settingsStatus, t("settings.reset.settings-done"));
      // 성공 확정 — reload가 뜨기 전까지 이 창 전체를 잠근다(confirmed[19], lockSettingsHost 참고).
      lockSettingsHost(host, t("settings.overlay.applying"));
      setTimeout(() => window.location.reload(), 900);
    })();
  });

  wipeBtn.addEventListener("click", () => {
    void (async () => {
      if (wipeInput.value.trim() !== WIPE_CONFIRM_WORD) return; // 방어(버튼이 이미 잠겨 있다).
      const ok = await confirmDialog(
        host,
        t("settings.reset.wipe-confirm"),
        t("settings.reset.wipe-confirm-label"),
      );
      if (!ok) return;
      wipeBtn.disabled = true;
      wipeInput.disabled = true;
      setStatus(wipeStatus, "");
      try {
        await wipeAllData();
      } catch {
        setStatus(wipeStatus, t("settings.reset.wipe-failed"));
        wipeInput.disabled = false;
        wipeBtn.disabled = wipeInput.value.trim() !== WIPE_CONFIRM_WORD;
        return;
      }
      // 입력을 비우고 버튼을 잠근 채 둔다(우발적 재삭제 방지) — 상태 문구가 재시작 안내를 맡는다.
      wipeInput.value = "";
      setStatus(wipeStatus, t("settings.reset.wipe-done"));
      // 성공 확정 — wipe는 reload가 아예 없어(수동 재시작 전까지) 이 창을 영구히 잠근다.
      // confirmed[19]가 없었다면 재시작 전 사소한 편집 하나가 방금 지운 설정을 되살릴 수 있었다.
      lockSettingsHost(host, t("settings.reset.wipe-done"));
    })();
  });

  /** 정적 문구를 호출 시점 로케일로 다시 그린다(recovery 패널과 같은 이유 — 위 doc-comment 참고). */
  const relocalize = (): void => {
    const titleEl = head.querySelector<HTMLElement>(".settings-page-title");
    if (titleEl) titleEl.textContent = t("settings.reset.page-title");
    const descEl = head.querySelector<HTMLElement>(".settings-page-desc");
    if (descEl) descEl.textContent = t("settings.reset.page-description");
    settingsTitle.textContent = t("settings.reset.section-settings-title");
    settingsDesc.textContent = t("settings.reset.section-settings-desc");
    settingsBtn.textContent = t("settings.reset.settings-button");
    wipeTitle.textContent = t("settings.reset.section-wipe-title");
    wipeDesc.textContent = t("settings.reset.section-wipe-desc");
    wipeHint.textContent = t("settings.reset.wipe-hint");
    wipeInput.placeholder = t("settings.reset.wipe-input-placeholder");
    wipeInput.setAttribute("aria-label", t("settings.reset.wipe-hint"));
    wipeBtn.textContent = t("settings.reset.wipe-button");
  };

  return { panel, relocalize };
}

/**
 * 설정 창을 host에 마운트한다: 탭바(테마/플러그인) + 각 탭 콘텐츠 + 테마 크롬 토큰 적용.
 *
 * 「테마」 탭: 테마 피커(빌트인 + 설치 테마 플러그인, "하나 선택") + 전역 글자 크기.
 * 「플러그인」 탭: 번들·설치 목록·재조정 배너·URL/폴더 설치·승인 프롬프트(기존 매니저 전부).
 * 설치 플로우: 스펙 → fetch(스테이징 + 미리보기) → 최신이면 안내 후 폐기, 아니면 승인
 * 프롬프트 → 승인 시 confirm(부여 반영), 취소 시 cancel(잔여물 없음). 재조정([설치])과
 * 업데이트 확인도 같은 플로우를 재사용한다. 재조정 IO는 비차단(실패 시 안내만 생략).
 * 테마 토큰: 마운트 시 + 호스트 재빌드 신호(테마 변경 반영 완료) 때 루트에 다시 적용한다.
 */
export async function mountSettings(
  host: HTMLElement,
  deps: SettingsDeps,
): Promise<void> {
  // 번들 플러그인 활성 상태(id→enabled) — 공유 설정과 **나란히** 시작한다. 첫
  // `setActiveLocale` 전에 번들 언어팩을 등록해야 하는데(아래), 그 판정 입력이 이 맵이기
  // 때문이다. 조회 실패는 빈 맵이 아니라 null("모른다")이다 — 빈 맵으로 폴백하면
  // `states[id] ?? true`가 전부 "켜짐"으로 읽혀 사용자가 꺼둔 팩이 실패 경로에서만
  // 되살아난다(note.ts `builtinRunning`과 같은 원칙).
  const builtinStatesPromise = deps
    .listBuiltinStates()
    .catch(() => null as Record<string, boolean> | null);
  let settings = await deps.getSettings();
  // 번들 언어팩을 **전부**(활성인 것 한정) 이 창의 로케일 저장소에 등록한다 — 다른 창은
  // 자기가 그릴 언어 하나면 되지만(`loadActiveBundledLocale`), 설정 창은 언어 드롭다운
  // 후보를 `availableLocales()`에서 얻으므로 지금 활성이 아닌 언어도 등록돼 있어야 고를 수
  // 있다. 첫 `setActiveLocale`보다 **먼저** 끝나야 한다: 등록 전에 확정하면 미등록 코드로
  // 취급돼 조용히 ko로 접힌다.
  const initialBuiltinStates = await builtinStatesPromise;
  await loadEnabledBundledPacks(initialBuiltinStates);
  // **설치(서드파티) 언어팩**도 같은 이유로 여기서 전부 등록한다 — 코어(Rust)가 설치
  // 매니페스트를 직접 스캔해 주므로(`listLanguagePacks`) 중앙 호스트 스냅샷을 기다리지 않고
  // 첫 `setActiveLocale` 전에 끝난다. 다른 창은 자기가 그릴 언어 하나만 받지만
  // (`readLocaleEntries(language)`), 설정 창은 **고를 수 있는 언어 전부**가 후보로 있어야
  // 하므로 카탈로그를 받아 코드마다 사전을 읽는다(라벨도 카탈로그의 것을 쓴다 — 드롭다운에
  // 실제로 표시되는 유일한 창이다).
  //
  // 실패는 전부 흡수한다(그 언어가 드롭다운에 안 나타날 뿐 — 설정 창이 열리지 못하는 것보다
  // 낫다). 사전이 빈 맵이면 등록하지 않는다: 고를 수는 있는데 전부 ko로 폴백되는 유령 항목이
  // 생기지 않게 한다. 번들 팩이 이미 등록한 코드(en 등)는 `registerLocale`이 보호 코드로
  // 거부하므로, 위 `loadEnabledBundledPacks`가 **먼저** 끝나 있는 이 순서가 곧 "번들이 이긴다"다.
  //
  // **등록 순서는 결정적이어야 한다.** 카탈로그는 같은 `code`를 여러 팩이 공급하는 것을
  // 허용하므로(그것이 사실 기록이다), 등록을 `Promise.all`의 완료 순서에 맡기면 두 가지가
  // 실행마다 흔들린다: (1) `registerLocale`은 LastWins라 **드롭다운 라벨**이 IPC 응답이
  // 도착한 순서의 마지막 팩 것이 되고, (2) `availableLocales()`가 로케일 Map의 **삽입
  // 순서**를 그대로 드롭다운 순서로 쓰므로 언어 목록 자체가 뒤섞인다. 백엔드는 id 사전순
  // LastWins로 이미 결정적인데(`read_locale_entries`) 프런트가 그 순서를 깨뜨릴 이유가 없다.
  const installedPacks = await listLanguagePacks().catch(
    () => [] as LanguagePackEntry[],
  );
  // 카탈로그를 앞→뒤로 훑어 code→label 맵을 만든다. `Map.set`은 같은 키를 덮어쓰되 **삽입
  // 위치는 첫 등장 자리에 유지**하므로, 이 한 줄이 두 규칙을 동시에 준다: 라벨은 **뒤가
  // 이기고**(백엔드 사전 병합의 승자와 같은 팩이다 — 둘이 갈리면 "A의 라벨인데 B의 문장"이
  // 된다), 순서는 카탈로그 첫 등장 순서로 안정된다.
  const labelByCode = new Map<string, string>();
  for (const pack of installedPacks) labelByCode.set(pack.code, pack.label);
  // 유니크 code에만 IPC를 부른다 — 중복 code마다 같은 스캔을 반복하면 첫 페인트 핫패스에
  // 그만큼이 그대로 얹힌다(사전은 어차피 그 code의 병합 결과 하나다).
  const catalog = [...labelByCode];
  const fetched = await Promise.all(
    catalog.map(([code]) => readLocaleEntries(code).catch(() => null)),
  );
  // fetch는 위에서 병렬로 끝냈고(왕복 지연은 겹친다), **등록만** 카탈로그 순서대로 돈다 —
  // 병렬성은 유지하면서 순서 의존만 제거한다.
  catalog.forEach(([code, label], i) => {
    const entries = fetched[i];
    if (entries && Object.keys(entries).length > 0) {
      registerLocale(code, label, entries);
    }
  });
  // 이 창의 UI 언어를 확정한다(첫 렌더 전) — main.ts의 다른 창 부트스트랩과 같은 지점
  // (SharedSettings를 이미 읽은 직후)이지만, 설정 창은 그 await가 main.ts가 아니라 여기(
  // mountSettings)에서 일어나 여기 둔다. language가 미설정이면(이슈 #30) resolveLanguage가
  // 이 창의 OS/브라우저 로케일로 ko/en을 낙관적으로 고른다 — en은 방금 번들 팩으로 등록돼
  // 있어 리로드 없이 바로 반영된다(store.ts doc-comment 참고).
  //
  // **이 창의 로케일 확정은 여기 한 번이 전부다.** 위 두 등록(번들 팩 + 코어가 스캔해 준 설치
  // 팩)이 모두 끝난 뒤이므로 미등록 코드로 접히는 일이 없고, 뒤늦게 도착해 재확정을 요구하는
  // 언어팩 경로가 더는 없다.
  setActiveLocale(resolveLanguage(settings.language));
  // 테마 피커 후보(빌트인 + 설치 테마 플러그인)를 위해 목록을 먼저 읽는다.
  const initialPlugins = await deps.listPlugins().catch(() => []);

  // 「테마」 탭 상태: 활성 테마 원본 디스크립터(오버라이드 병합 전 — 편집기 baseline 출처)와
  // 로컬 공유 설정을 저장 때마다 갱신해, 이후 저장·오버라이드 인덱싱이 항상 최신을 쓰게 한다.
  let activeDesc: ThemeDescriptor | null = null;
  // 「테마」 탭 폰트 피커 후보(활성 「폰트」 플러그인 목록). 플러그인 off·호스트 부재면 null →
  // 폰트 피커를 숨긴다("끄면 시스템 기본 고정"). 호스트 재빌드 때 activeDesc와 함께 갱신된다.
  let activeFontDesc: FontDescriptor | null = null;
  // 「단축키」 탭 상태: 활성 플러그인 툴바 버튼(바인딩 후보 — 호스트 재빌드 때 갱신), 전역 새-노트
  // 단축키(Tauri accel), 전역 등록 실패 안내.
  let toolbarActions: { id: string; label: string }[] = [];
  let globalHotkey = "";
  let globalError = "";
  // 「시작」 탭 상태: 활성 노트 0개 시작 동작(STARTUP_NO_ACTIVE_OPTIONS 중 하나)과 저장 실패 안내.
  let startupNoActiveAction = DEFAULT_STARTUP_NO_ACTIVE_ACTION;
  let startupSaveError = "";
  // 이번 호스트 빌드에서 실행 실패한 플러그인/테마(중앙 호스트 스냅샷 `failures`) — 번들·커뮤니티
  // 매니저 목록이 ⚠ 오류 배지로 표시한다. 없거나(구버전 호스트) 조회 실패면 빈 배열(표시 없음).
  let pluginFailures: PluginFailure[] = [];
  // 앱 버전(매니페스트 `minHostVersion` 게이트의 기준) — 창 수명 동안 바뀌지 않으므로
  // 마운트 때 한 번 읽는다. 미배선·실패면 빈 문자열 → semver 비교 불가 → 게이트 통과.
  let appVersion = "";
  // 플러그인 런타임 진단(상세의 「최근 오류」) — 상세를 열 때마다 새로 읽는다(호스트가 계속
  // 모으므로 목록 렌더 시점의 스냅샷으로는 "방금 난 오류"를 놓친다).
  let pluginDiagnostics: PluginDiagnostic[] = [];
  // 크롬 토큰 재적용(마운트·호스트 재빌드) 직후 실행할 훅 — 단축키 탭이 배선되면 플러그인 버튼
  // 후보를 새로 읽어 다시 그린다. 초기값 no-op(단축키 배선 전 첫 호출은 건드리지 않는다).
  let afterChromeTokens: () => void = () => {};

  /** 공유 설정을 로컬에 반영하고 영속화한다(저장 성공 → 호스트 재빌드 → 라이브 반영). */
  const persist = (next: SettingsShape): void => {
    settings = next;
    void deps.saveSettings(next);
  };

  // 트리 페이지 패널들 — 외형(테마·글꼴)과 관리(번들·커뮤니티). 안정 id로 e2e/테스트가 대상 삼는다.
  const themePanel = document.createElement("section"); // 외형 › 테마(피커 + 색 편집기)
  themePanel.id = "settings-page-theme";
  const fontPanel = document.createElement("section"); // 외형 › 글꼴(글꼴 편집기)
  fontPanel.id = "settings-page-font";
  const shortcutsPanel = document.createElement("section"); // 외형 › 단축키(키맵 편집)
  shortcutsPanel.id = "settings-page-shortcuts";
  const uiLayoutPanel = document.createElement("section"); // 외형 › 툴바 배치(드래그&드롭)
  uiLayoutPanel.id = "settings-page-ui-layout";
  const startupPanel = document.createElement("section"); // 시작 › 활성 노트 0개 동작
  startupPanel.id = "settings-page-startup";
  // 도움말 › 시작 가이드 — 배선이 없으면 null이고, 그러면 트리 노드도 만들지 않는다
  // ("IO 없으면 UI 없음"). 지역 상수로 좁혀 잡는 이유는 「시작」 페이지의 `setAction`과 같다.
  const openGuideNote = deps.openGuideNote;
  const helpPanel = openGuideNote
    ? buildHelpPanel(() => openGuideNote())
    : null;
  const bundlePanel = document.createElement("section");
  bundlePanel.id = "settings-page-bundle";
  const communityPanel = document.createElement("section");
  communityPanel.id = "settings-page-community";
  // 복구 › 메모 복구(스냅샷 목록·미리보기·복원). host는 확인 다이얼로그의 마운트 표면.
  const recovery = buildRecoveryPanel(host, deps);
  // 관리 › 저장 폴더(경로 표시 · 이전, 이슈 #21). host는 위와 같은 이유.
  const vaultPanel = buildVaultPanel(host);
  void vaultPanel.refresh();
  // 관리 › 백업(설정·플러그인 내보내기/가져오기, 이슈 #28). host는 위와 같은 이유.
  const backupPanel = buildBackupPanel(host);
  // 관리 › 초기화(설정 초기화 · 모든 데이터 삭제, 이슈 #20). host는 위와 같은 이유.
  const resetPanel = buildResetPanel(host);

  /** 편집기 baseline — 활성 테마가 선언한 토큰 값(없으면 기본값), 모든 토큰에 대해. */
  const themeBaseline = (): Record<string, string> => {
    const tokens = activeDesc?.tokens ?? {};
    const base: Record<string, string> = {};
    for (const key of ALL_TOKEN_KEYS) {
      base[key] = tokens[key] ?? THEME_TOKEN_DEFAULTS[key];
    }
    return base;
  };

  // 고른 폰트를 설정 창 자체에도 적용한다(테마 색이 설정 크롬에 적용되는 것과 같은 결 —
  // "테마+글꼴은 설정까지 반영"). 능력 off(activeFontDesc 없음)면 시스템 기본 폰트로 두어
  // 노트창 동작("끄면 시스템")과 일치시킨다. 폰트 편집기 행·미리보기는 자기 서체를 덮어써 유지.
  const applySettingsFont = (): void => {
    const on = !!(activeFontDesc && hasFontPicker(activeFontDesc.families));
    const stack = readDefaultFontFamily(settings.defaults);
    host.style.fontFamily = on && stack ? stack : "";
  };

  // ── 외형 › 테마 페이지: 테마 피커 + 색 편집기 ──
  // 테마 전환·색 커밋은 저장→호스트 재빌드→onThemeUpdated로 돌아오며, 그때 이 함수가 새
  // 팔레트·오버라이드로 컨트롤을 다시 그린다(활성 테마의 색을 정확히 반영).
  const renderThemePage = (): void => {
    themePanel.replaceChildren(
      buildLanguagePicker(
        availableLocales(),
        resolveLanguage(settings.language),
        (code) => {
          settings = { ...settings, language: code };
          // 언어 변경은 저장 후 이 창 자신도 명시적으로 새로고침한다. 테마·색은 저장만 하면
          // EV_HOST_UPDATED → applyChromeTokens 부분 재렌더로 충분하지만(renderThemePage를
          // 다시 부르는 정도), 언어는 이미 DOM에 박제된 다른 페이지의 문구(트리 라벨 등)까지
          // 바꿔야 해서 부분 재렌더로는 부족하다 — 그래서 언어 변경만 자체 reload()를 탄다.
          // 노트·패널 창은 notes-reload → EV_HOST_UPDATED에 이미 전체 reload()가 걸려 있어서
          // (main.ts bootstrap) 그 경로가 처리해 주지만, 그 신호는 400ms 디바운스라 이 창의
          // self-reload가 먼저 JS 런타임을 파기하면 영영 발화하지 않는다 — 그래서
          // reload() 전에 flushNotesReload()로 그 신호부터 확정한다.
          void deps
            .saveSettings(settings)
            .then(() => deps.flushNotesReload())
            .then(() => window.location.reload());
        },
      ),
      buildThemePicker(
        availableThemeNames(
          initialPlugins,
          settings.theme,
          Object.keys(settings.theme_overrides ?? {}),
        ),
        settings.theme,
        (theme) => persist({ ...settings, theme }),
      ),
      buildThemeColorEditor({
        host,
        baseline: themeBaseline(),
        overrides: settings.theme_overrides?.[settings.theme] ?? {},
        onChange: (overrides) => {
          const base = baseThemeName(settings.theme);
          const customName = `${base}${CUSTOM_THEME_SUFFIX}`;
          const rest = { ...(settings.theme_overrides ?? {}) };
          if (Object.keys(overrides).length === 0) {
            // 모두 초기화 → 베이스 테마로 복귀 + 파생 변형 항목 제거.
            delete rest[customName];
            persist({ ...settings, theme: base, theme_overrides: rest });
            return;
          }
          // 색을 편집하면 그 테마의 파생 변형({테마}<custom>)으로 자동 전환·저장한다.
          persist({
            ...settings,
            theme: customName,
            theme_overrides: { ...rest, [customName]: overrides },
          });
        },
      }),
    );
  };

  // ── 외형 › 글꼴 페이지: 글꼴 편집기(크기 + 폰트 패밀리) ──
  // 크기(px)는 defaults에 저장(메모별 조절은 "글자 크기" 플러그인이 델타%를 더한다). 폰트 능력이
  // 켜져 후보가 있을 때만 패밀리 목록을 보이고(off면 시스템 기본 고정), 선택 스택도 defaults에 저장.
  const renderFontPage = (): void => {
    fontPanel.replaceChildren(
      buildFontEditor({
        fontPx: readDefaultFontPx(settings.defaults),
        onSizeChange: (px) =>
          persist({
            ...settings,
            defaults: {
              ...(settings.defaults as object | null),
              font_size: px,
            },
          }),
        families:
          activeFontDesc && hasFontPicker(activeFontDesc.families)
            ? activeFontDesc.families
            : null,
        current: readDefaultFontFamily(settings.defaults),
        onFamilyChange: (stack) => {
          persist({
            ...settings,
            defaults: {
              ...(settings.defaults as object | null),
              font_family: stack,
            },
          });
          applySettingsFont(); // 설정 창 자체도 즉시 그 폰트로(라이브 — 호스트 재빌드 기다리지 않음).
        },
      }),
    );
  };

  // 활성 테마의 크롬 토큰(CSS 변수)을 설정창 루트에 적용 — 설정창도 테마의 일부(D6). 노트 배경
  // 스와치는 칠하지 않는다("노트 종이색" 개념). 적용 후 편집기도 최신 상태로 다시 그린다.
  const applyChromeTokens = async (): Promise<void> => {
    activeDesc = await deps.activeTheme().catch(() => null);
    // 폰트 피커 후보도 같은 호스트 스냅샷에서 읽는다(테마 갱신과 같은 시점에 함께 최신화).
    activeFontDesc = await deps.activeFont().catch(() => null);
    // **로케일은 여기서 다시 손대지 않는다.** 이 창이 쓰는 사전은 전부 마운트 첫머리에서
    // 등록이 끝났고(번들 팩 + 코어가 스캔해 준 설치 팩), 그 직후 `setActiveLocale`이 활성
    // 언어를 확정했다 — 호스트 재빌드가 나른 언어팩이 없으므로 여기서 다시 등록·재확정할
    // 대상 자체가 없다. 예전에는 언어팩이 스냅샷으로 늦게 도착해서, 여기서 등록하고 첫
    // 페인트가 이미 다른 언어로 굳었으면 1회 리로드로 수습해야 했다.
    //
    // 설정 창을 띄워 둔 채 언어팩 플러그인이 오가면(설치·활성 토글·제거) 마운트 때 굳은 그
    // 등록이 낡는다. 그 수습은 **여기가 아니라 해당 핸들러들**이 한다 — 대상이 언어팩일 때만
    // 설정 창 자신을 리로드한다(`reloadForLanguagePack`, 판정은 `isLanguagePack`). 여기서
    // 매 재빌드마다 카탈로그 스캔 IPC 전체(`listLanguagePacks` + 코드별 `readLocaleEntries`)를
    // 다시 태우지 않는 이유도 거기 적어 뒀다: 테마·색·일반 플러그인 토글 등 훨씬 잦은 재빌드가
    // 전부 그 비용을 물게 되기 때문이다.
    //
    // 아래 재렌더는 여전히 필요하다: 언어가 아니라 **테마·폰트·실패 목록**이 재빌드마다 바뀐다.

    // 실행 실패 목록도 같은 시점에 최신화(호스트 재빌드 = 실패 여부가 바뀔 수 있는 유일한 시점).
    pluginFailures = deps.pluginFailures
      ? await deps.pluginFailures().catch(() => [])
      : [];
    if (activeDesc) {
      const merged = mergeThemeOverrides(
        activeDesc,
        settings.theme_overrides?.[settings.theme],
      );
      applyTheme(host, merged);
      // 이전 테마에서 남은 토큰 변수는 지운다(현 테마 미선언 토큰 → CSS 폴백이 되살아나게).
      for (const key of ALL_TOKEN_KEYS) {
        if (!(key in merged.tokens)) {
          host.style.removeProperty(cssVarForToken(key));
        }
      }
    }
    applySettingsFont(); // 테마와 함께 폰트도 설정 창에 반영(마운트·호스트 재빌드 시 최신화).
    renderThemePage();
    renderFontPage();
    // 복구·백업·저장폴더·초기화 페이지를 다시 그린다. 이제 **언어 때문이 아니다**: 언어는
    // 마운트에서 이미 확정돼 이 네 패널이 만들어질 때 최종 로케일로 구워진다. 남은 이유는
    // 재빌드가 실제로 바꾸는 것들이다 — 백업 패널은 미리보기를, 저장폴더 패널은 경로 상태를
    // 다시 읽는다. 이름(`relocalize`)은 그 시절의 흔적이라 그대로 두되, 호출을 빼면 그 갱신이
    // 함께 죽는다는 것이 여기 남은 진짜 근거다.
    recovery.relocalize();
    vaultPanel.relocalize();
    backupPanel.relocalize();
    resetPanel.relocalize();
    afterChromeTokens(); // 단축키 탭이 배선돼 있으면 플러그인 버튼 후보를 새로 읽어 다시 그린다.
  };
  await applyChromeTokens();
  // 테마·플러그인·색 변경 → 저장 → 중앙 호스트 재빌드 완료 신호가 오면 라이브 갱신.
  deps.onThemeUpdated(() => void applyChromeTokens());

  // 각 플러그인 탭은 자기 마스터(목록) ↔ 디테일(상세) 쌍을 갖는다. 상세 닫기는 idempotent라
  // 아래 closeDetail이 "양쪽 모두 닫기"로 통일한다(열려 있는 상세는 활성 탭의 것 하나뿐).
  const makeMasterDetail = (
    panel: HTMLElement,
  ): { master: HTMLElement; detail: HTMLElement } => {
    const master = document.createElement("div");
    master.className = "plugin-master";
    const detail = document.createElement("div");
    detail.className = "plugin-detail-view";
    detail.hidden = true;
    panel.append(master, detail);
    return { master, detail };
  };
  const bundleUI = makeMasterDetail(bundlePanel);
  const communityUI = makeMasterDetail(communityPanel);

  // ── 「번들 플러그인」 탭: 1st-party 번들만(비-테마는 토글, 번들 테마는 🔒 필수 잠금 — D3).
  // 탭 이름이 곧 섹션 제목이라 별도 소제목은 두지 않는다.
  const builtinList = document.createElement("ul");
  builtinList.className = "plugin-list";
  bundleUI.master.append(builtinList);
  // 트리의 플러그인 설정 페이지가 읽는 상태(let — 토글·설치·설정 변경 후 갱신하고 트리를 다시 조립).
  // 마운트 첫머리에서 이미 받아 둔 값을 **재사용한다**(같은 IPC를 두 번 부르지 않는다) —
  // 그때는 "모르면 안 켠다"를 판정해야 해서 null을 보존했고, 여기서는 렌더가 `states[id] ??
  // true`로 읽으므로 빈 맵으로 떨어뜨린다(예전과 같은 의미).
  let builtinStates = initialBuiltinStates ?? {};
  const builtinSettings =
    (await deps.listBuiltinSettings().catch(() => null)) ?? {};
  // 번들 언어팩 목록(설정창 표시용) — **활성/비활성과 무관하게 전부** 읽는다: 꺼진 팩도
  // 목록에 보여야 다시 켤 수 있다(꺼진 번들 플러그인이 목록에 남는 것과 같은 규칙).
  // 등록(=로케일 저장소 반영)은 위 `loadEnabledBundledPacks`가 이미 활성분만 했다 — 여기서
  // 다시 읽어도 모듈 캐시라 청크를 두 번 받지 않는다.
  const languagePacks = (await loadAllBundledPacks()).map(packToBuiltin);
  // 현재 OS(미상이면 "") — 미지원 플러그인의 OS 배지·자동 비활성 표시에 쓴다.
  const platform = deps.platform ? await deps.platform().catch(() => "") : "";
  let installedList: InstalledPlugin[] = [];

  // ── 외형 › 단축키 페이지 ──
  const isMac = platform === "macos";
  // 전역 새-노트 단축키와 플러그인 툴바 버튼 후보를 먼저 읽는다(둘 다 선택 dep — 없으면 섹션 생략/빈 목록).
  globalHotkey = deps.getGlobalHotkey
    ? await deps.getGlobalHotkey().catch(() => "")
    : "";
  toolbarActions = deps.activeToolbarButtons
    ? await deps.activeToolbarButtons().catch(() => [])
    : [];

  // ── 시작 페이지 — 활성 노트 0개로 실행됐을 때 무엇을 띄울지(선택 dep, 둘 다 있어야 노드 노출) ──
  if (deps.getStartupNoActiveAction && deps.setStartupNoActiveAction) {
    // 이 블록 안에서만 좁혀 잡는다(전역 단축키 섹션의 `setGlobal` 지역 상수와 같은 이유 —
    // 클로저 밖에서 `deps.setStartupNoActiveAction`을 다시 좁힐 방법이 없다).
    const setAction = deps.setStartupNoActiveAction;
    startupNoActiveAction = await deps
      .getStartupNoActiveAction()
      .catch(() => DEFAULT_STARTUP_NO_ACTIVE_ACTION);
    /**
     * 시작 페이지 렌더 — 저장이 **끝난 뒤에만** 다시 그린다(전역 단축키와 같은 관례:
     * `.then()/.catch()`로 상태를 정하고 `.finally()`에서 한 번만 렌더). onChange 안에서
     * 저장 전에 동기로 재렌더하면 방금 change를 낸 `<select>` 자신이 교체돼 포커스가
     * body로 튀어(Tab·화살표 키 탐색이 끊긴다) — 그래서 성공/실패가 정해지기 전에는
     * DOM을 건드리지 않는다(네이티브 select는 사용자가 고른 값을 이미 스스로 반영한다).
     */
    const renderStartupPage = (): void => {
      startupPanel.replaceChildren(
        buildSettingsPageHead(t("settings.startup.page-title")),
        buildStartupNoActiveActionPicker(startupNoActiveAction, (action) => {
          startupSaveError = "";
          void setAction(action)
            .then(() => {
              startupNoActiveAction = action;
            })
            .catch(() => {
              // 어휘 거부 등으로 저장이 reject되면 이전 값으로 되돌리고 실패를 알린다(전역
              // 단축키 등록 실패와 같은 관례 — 값은 되돌리되 조용히 삼키지 않는다).
              startupSaveError = t("settings.startup.save-failed");
            })
            .finally(() => renderStartupPage());
        }),
      );
      if (startupSaveError) {
        const err = document.createElement("p");
        // 전역 단축키 등록 실패와 같은 danger 톤(`.shortcut-warn`) — 중립 상태줄
        // (`.plugin-setting-status`)과 달리 실패로 읽혀야 한다. role="alert"로 재렌더가
        // 이미 포커스를 옮긴 뒤에도 스크린 리더가 실패를 알리게 한다.
        err.className = "shortcut-warn";
        err.setAttribute("role", "alert");
        err.textContent = startupSaveError;
        startupPanel.append(err);
      }
    };
    renderStartupPage();
  }

  /** 창 단위 바인딩 하나를 바꾼다(지움=null) → 공유 설정 저장 + 페이지 재조립. */
  const setBinding = (actionId: string, accel: string | null): void => {
    const next = { ...effectiveKeybindings(settings.keybindings) };
    if (accel) next[actionId] = accel;
    else delete next[actionId];
    persist({ ...settings, keybindings: next });
    renderShortcutsPage();
  };

  // 단축키 페이지 렌더 — 핵심 노트 동작 + 플러그인 버튼 + 전역 새-노트. 저장·전역 등록 실패 후
  // 다시 호출해 충돌 표시·라벨·안내를 갱신한다.
  const renderShortcutsPage = (): void => {
    const bindings = effectiveKeybindings(settings.keybindings);
    const conflicts = findConflicts(bindings);
    const fmt = (a: string): string => formatAccelLabel(a, isMac);
    // 창 단위 캡처: event.code 기반 accel + 수식키 필수(수식키 없는 조합은 무효 처리해 계속 대기).
    const winCapture = (e: KeyboardEvent): string | null => {
      const a = eventToAccel(e, isMac);
      return a && hasModifier(a) ? a : null;
    };
    const isConflict = (a: string): boolean =>
      !!a && (conflicts[a]?.length ?? 0) > 1;

    const children: HTMLElement[] = [
      buildSettingsPageHead(
        t("settings.shortcuts.page-title"),
        t("settings.shortcuts.page-description"),
      ),
      shortcutSection(t("settings.shortcuts.section-note-tools")),
    ];
    for (const action of SHORTCUT_ACTIONS) {
      const accel = bindings[action.id] ?? "";
      children.push(
        buildShortcutRow({
          label: t(action.labelKey),
          accel,
          conflict: isConflict(accel),
          note: action.requires
            ? t("settings.shortcuts.requires-plugin-note")
            : undefined,
          defaultAccel: action.defaultAccel,
          capture: winCapture,
          format: fmt,
          onSet: (a) => setBinding(action.id, a),
        }),
      );
    }

    // 플러그인 동작: 활성 스냅샷 버튼 + 저장돼 있으나 지금은 없는(꺼짐/미설치) plugin:* 바인딩 보존.
    // 핵심 동작으로 이미 노출되는 별칭 버튼(확대/축소=A+/A−)은 중복이라 제외한다.
    const pluginItems: { id: string; label: string; available: boolean }[] = [];
    const seen = new Set<string>();
    for (const b of toolbarActions) {
      if (isCoreAliasTarget(b.id)) continue;
      pluginItems.push({ id: b.id, label: b.label, available: true });
      seen.add(b.id);
    }
    for (const id of Object.keys(bindings)) {
      if (id.startsWith("plugin:") && !seen.has(id) && !isCoreAliasTarget(id)) {
        pluginItems.push({
          id,
          label: id.split(":").slice(2).join(":") || id,
          available: false,
        });
      }
    }
    if (pluginItems.length > 0) {
      children.push(
        shortcutSection(t("settings.shortcuts.section-plugin-actions")),
      );
      for (const item of pluginItems) {
        const accel = bindings[item.id] ?? "";
        children.push(
          buildShortcutRow({
            label: item.label,
            accel,
            conflict: isConflict(accel),
            note: item.available
              ? undefined
              : t("settings.shortcuts.plugin-unavailable-note"),
            capture: winCapture,
            format: fmt,
            onSet: (a) => setBinding(item.id, a),
          }),
        );
      }
    }

    // 전역 새-노트 단축키(선택 dep). Tauri accel을 캡처하고, 등록 실패면 안내를 남긴다.
    if (deps.getGlobalHotkey && deps.setGlobalHotkey) {
      const setGlobal = deps.setGlobalHotkey;
      children.push(shortcutSection(t("settings.shortcuts.section-global")));
      children.push(
        buildShortcutRow({
          label: t("settings.shortcuts.new-note-label"),
          accel: globalHotkey,
          note: t("settings.shortcuts.global-note"),
          clearable: false,
          capture: (e) => eventToTauriAccel(e),
          format: fmt,
          onSet: (a) => {
            if (!a) return;
            globalError = "";
            void setGlobal(a)
              .then(() => {
                globalHotkey = a;
              })
              .catch(() => {
                globalError = t("settings.shortcuts.global-register-failed");
              })
              .finally(() => renderShortcutsPage());
          },
        }),
      );
      if (globalError) {
        const err = document.createElement("small");
        err.className = "shortcut-warn";
        err.textContent = globalError;
        children.push(err);
      }
    }

    shortcutsPanel.replaceChildren(...children);
  };

  /** 호스트 재빌드(플러그인 토글 등) 후 플러그인 버튼 후보를 새로 읽어 페이지를 다시 그린다. */
  const refreshShortcuts = async (): Promise<void> => {
    toolbarActions = deps.activeToolbarButtons
      ? await deps.activeToolbarButtons().catch(() => [])
      : [];
    renderShortcutsPage();
  };
  renderShortcutsPage();

  // ── 외형 › 툴바 배치 페이지: 상/하 바 × 단(존)에 버튼을 드래그&드롭으로 배치 ──
  // 팔레트 = 지금 쓸 수 있는 내장 컨트롤 + 활성 플러그인 버튼(중앙 호스트 스냅샷). 변경 시 공유
  // 설정 toolbar_layout에 저장한다(저장 → 호스트 재빌드 → 노트 창 리로드로 새 배치가 반영).
  let pluginPaletteItems = deps.toolbarButtonItems
    ? await deps.toolbarButtonItems().catch(() => [])
    : [];
  let capabilities = deps.toolbarCapabilities
    ? await deps.toolbarCapabilities().catch(() => null)
    : null;
  /**
   * 지금 팔레트에 올릴 아이템 전체. 렌더와 변경 감지가 **같은 값**을 봐야 하므로 함수로 둔다
   * (캐시하지 않는 이유: 내장 이름은 여기서 `t()`로 해석되므로 언어가 바뀌면 다시 읽혀야 한다).
   * 내장 컨트롤은 가용한 것만 남긴다 — 꺼진 창-기능 플러그인·미지원 OS의 컨트롤은 노트에서
   * 렌더되지 않으므로 팔레트에 두면 "끌어다 놔도 안 나오는" 유령이 된다. 능력을 못 읽었으면
   * (호스트 부재) 거르지 않는다.
   */
  const buildPalette = (): LayoutPaletteItem[] => [
    ...(capabilities
      ? availableBuiltinItems(
          capabilities.windowControls,
          capabilities.hasBackground,
        )
      : BUILTIN_ITEMS
    ).map((it) => ({
      key: it.key,
      name: t(it.nameKey),
      iconSvg: builtinItemIconSvg(it.key),
      // 내장도 플러그인 버튼과 같은 폴백 자리를 갖는다 — 미가용으로 배치에서 빠졌다가 다시
      // 켜졌을 때 이 자리로 돌아온다(이전 위치는 기억하지 않는다 — 스펙).
      position: it.position,
    })),
    ...pluginPaletteItems.map((it) => ({
      key: it.key,
      name: it.name,
      glyph: it.glyph,
      position: it.position,
    })),
  ];
  const renderUiLayoutPage = (): void => {
    const palette = buildPalette();
    // 지금 쓸 수 없는 아이템(꺼진/삭제된 플러그인의 버튼, 미가용 내장 컨트롤)을 배치에서
    // 아예 지운다 — 존에서도 `seen`에서도. 남겨 두면 편집기 목업에 정체 모를 칩("• pid · bid")
    // 으로 그려지고, 다시 켰을 때 "사용자가 뺀 것"으로 오인돼 영영 안 나온다. 지우고 나면 그
    // 키는 신규 취급이라 다시 켜질 때 `position` 기본 자리로 돌아온다(스펙: 이전 위치 미기억).
    // 능력을 못 읽었으면(호스트 부재) 손대지 않는다 — "모른다"를 "없다"로 읽으면 안 된다.
    const stored = resolveLayout(settings.toolbar_layout);
    const known = new Set(palette.map((it) => it.key));
    // 가용 판정(능력을 읽었을 때만 존재) — 배치 정리와 「기본 배치로 초기화」 기준선이 **같은
    // 판정**을 써야 한다. 초기화 쪽이 이걸 못 받으면 기본 상수에 하드코딩된 조건부 아이템
    // (투명도 등)이 되살아나 목업에만 유령 칩으로 남고, 기본 판정도 어긋나 초기화 버튼이 영구히
    // 뜬다(toolbar-layout.ts의 defaultLayoutFor 참고).
    const isAvailable = capabilities
      ? (key: string): boolean => known.has(key)
      : undefined;
    const layout = isAvailable ? pruneLayout(stored, isAvailable) : stored;
    // 실제로 지워진 게 있으면 그 결과를 한 번 저장한다 — 정리가 메모리에만 남으면 다음 로드에서
    // 저장값의 죽은 키가 되살아나 "다시 켜면 이전 위치로 복원"이 되어 버린다(스펙 위반).
    if (!sameLayout(stored, layout))
      persist({ ...settings, toolbar_layout: layout });
    // "기본 배치로 초기화" 버튼이 사용자의 toolbar_style(mac/windows)에 맞는 기본 배치로
    // 돌아가도록 골라 넘긴다 — 안 그러면 Mac 스타일 사용자가 Windows 배치로 되돌아가는 회귀가
    // 난다(toolbar-layout-editor.ts의 resetToDefault 참고). 스타일 미확정이면 편집기의
    // 자체 폴백(옛 단일 DEFAULT_LAYOUT)에 맡긴다.
    const defaultLayout =
      settings.toolbar_style === "mac"
        ? DEFAULT_LAYOUT_MAC
        : settings.toolbar_style === "windows"
          ? DEFAULT_LAYOUT_WINDOWS
          : undefined;
    uiLayoutPanel.replaceChildren(
      renderToolbarLayoutEditor({
        layout,
        paletteItems: palette,
        defaultLayout,
        isAvailable,
        onChange: (next) => persist({ ...settings, toolbar_layout: next }),
      }),
    );
  };
  renderUiLayoutPage();
  // 플러그인 토글·언어 변경 등으로 팔레트가 바뀌면 다시 읽어 재렌더한다(단축키 페이지와 같은 훅).
  // 창-기능 플러그인(투명도 등)은 버튼이 없어 `toolbarButtonItems`만으로는 변화가 안 보이므로
  // 능력(capabilities)도 함께 다시 읽고, 비교는 **합쳐진 팔레트**로 한다.
  const refreshUiLayout = async (): Promise<void> => {
    const before = buildPalette();
    pluginPaletteItems = deps.toolbarButtonItems
      ? await deps.toolbarButtonItems().catch(() => [])
      : [];
    capabilities = deps.toolbarCapabilities
      ? await deps.toolbarCapabilities().catch(() => null)
      : null;
    if (!toolbarPaletteChanged(buildPalette(), before)) return;
    renderUiLayoutPage();
  };

  // 크롬 토큰 재적용(호스트 재빌드) 훅 — 단축키·툴바 배치 팔레트·실행 실패 배지를 함께 새로 읽어
  // 갱신한다(실패 여부는 호스트 재빌드 시점에만 바뀔 수 있다 — 플러그인을 막 켰다가 샌드박스가
  // 터지는 경우가 대표적).
  afterChromeTokens = () => {
    void refreshShortcuts();
    void refreshUiLayout();
    renderBuiltinPage();
    renderCommunityPage();
  };

  // ── 설정 트리(좌측) + 내용(우측) ──
  // 노드 = 외형 페이지(테마·글꼴) + 플러그인 설정 페이지(활성 + 스키마 보유, 매니페스트 category로
  // 자동 그룹) + 관리 노드(번들·커뮤니티). 데이터가 바뀌면 rebuildTree로 다시 조립한다.
  const tree = createSettingsTree("appearance:theme");

  /**
   * 액션 버튼 한 번의 정책 — 확인 → 실행 요청 → 사용자에게 보일 결과 문구.
   *
   * 확인(`confirm`)을 위젯이 아니라 여기서 받는 이유: 확인 다이얼로그는 마운트 호스트를
   * 필요로 하는데(`confirmDialog(host, ...)`) 위젯 빌더는 그것을 모른다. 그리고 "무엇을 물을
   * 것인가"는 매니페스트가 정하는 **정책**이라 위젯보다 이 층에 있는 것이 맞다.
   *
   * 되돌아오는 문구가 계약이다:
   *  - 취소 → `""`(상태 줄을 아예 안 그린다 — 취소는 실패가 아니다)
   *  - 등록 안 된 명령 → 무엇이 잘못됐는지 + 어디를 고쳐야 하는지(저작자 대상)
   *  - 설정 화면에서 실행할 수 없는 명령(`when`의 창-의존 키·`destructive`) → **왜 안 되는지**
   *    + 대신 무엇을 하면 되는지. 예전엔 요청을 보내 놓고 "요청했어요"라고 말해, 호스트가
   *    조용히 삼킨 실행이 거짓 성공으로 보였다.
   *  - 정상 → "보냈다"까지만 말하고 **결과는 진단 채널에서 뒤따라 받는다**([`watchActionResult`]).
   *    여전히 "끝났다"고 단정하지 않는다 — 명령은 샌드박스에서 비동기로 돌고 설정 창은 완료
   *    신호를 받지 않는다. 대신 그 실행이 남긴 진단을 짧게 지켜보다 도착하면 상태 줄에 얹는다.
   */
  const runSettingAction = async (
    pluginId: string,
    field: PluginSettingField,
    say: (text: string) => void,
  ): Promise<string> => {
    if (field.confirm) {
      const ok = await confirmDialog(host, field.confirm, field.label);
      if (!ok) return "";
    }
    const commandId = field.command ?? "";
    // 진단의 `at`과 비교할 기준선 — 요청을 보내기 **전에** 찍는다(이전 실행의 기록을 이번
    // 결과로 오인하지 않게).
    const since = Date.now();
    const outcome = await deps.runPluginCommand(pluginId, commandId);
    if (outcome === "unregistered") {
      return t("settings.plugin-action.unregistered", { commandId });
    }
    if (outcome === "needs-note-window") {
      return t("settings.plugin-action.needs-note-window");
    }
    if (outcome === "needs-confirm-window") {
      return t("settings.plugin-action.needs-confirm-window");
    }
    if (!deps.pluginDiagnostics) return t("settings.plugin-action.no-result");
    // 비차단이다 — 지켜보기는 반환 뒤에 저 혼자 돌고, 버튼은 지금 바로 다시 눌린다(느린
    // 플러그인이 폼을 인질로 잡지 않는다는 액션 버튼 계약을 구조로 유지한다).
    void watchActionResult(pluginId, since, say);
    return t("settings.plugin-action.dispatched");
  };

  /**
   * 방금 보낸 실행이 진단 채널에 남긴 결과를 짧게 지켜보다 상태 줄에 얹는다(피드백 루프).
   *
   * 왜 필요한가: 설정 창에는 노트가 없어 명령 본문의 창-스코프 호출(`ui.toast`)이 사용자에게
   * 닿지 못한다 — 폴백 메모 창이 있으면 **그쪽에** 뜨고, 없으면 아무 데도 안 뜬다. 그래서
   * 버튼을 누른 사람에게 남는 창구는 진단뿐인데, 그건 다른 페이지(플러그인 › 상세 › 「최근
   * 오류」)에 있다. "실행을 요청했어요"가 사실상 마지막 말이 되던 자리를 이 지켜보기가 메운다.
   *
   * 왜 폴링인가: 진단은 상주 호스트가 모으고 설정 창은 당겨 읽는다(푸시 채널이 없다). 상한을
   * **우리 타이머**로 두므로 플러그인이 아무리 느려도 이 루프는 [`ACTION_RESULT_WINDOW_MS`]에서
   * 끝난다(기다림이 플러그인 수명에 매이지 않는다).
   *
   * 고르는 기록: 기준선 이후 **가장 마지막** 것 하나. 한 번의 실행이 여러 줄을 남길 수 있고
   * (호스트의 «창 없음» + 플러그인의 `runtime.log`), 그때 사람에게 쓸모 있는 것은 플러그인이
   * 마지막에 적은 사람말이다. 종류가 `log`가 아니면 호스트가 관측한 실패이므로 종류 라벨을
   * 앞에 붙여 정보와 실패를 구분한다.
   */
  const watchActionResult = async (
    pluginId: string,
    since: number,
    say: (text: string) => void,
  ): Promise<void> => {
    const deadline = since + ACTION_RESULT_WINDOW_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, ACTION_RESULT_POLL_MS));
      const all = await (
        deps.pluginDiagnostics?.() ?? Promise.resolve<PluginDiagnostic[]>([])
      ).catch((): PluginDiagnostic[] => []);
      const mine = all.filter((d) => d.pluginId === pluginId && d.at >= since);
      const last = mine[mine.length - 1];
      if (last) {
        say(
          last.kind === "log"
            ? last.message
            : t("settings.plugin-action.result-kind", {
                kind: DIAGNOSTIC_LABELS()[last.kind] ?? last.kind,
                message: last.message,
              }),
        );
        return;
      }
      if (Date.now() >= deadline) {
        say(t("settings.plugin-action.no-result"));
        return;
      }
    }
  };

  /** list 필드 "기본값으로 되돌리기"의 확인 팝업(확인 팝업과 같은 관례 — confirmDialog). */
  const confirmListReset = (field: PluginSettingField): Promise<boolean> => {
    const itemLabel =
      field.itemLabel ?? t("settings.list-field.default-item-label");
    return confirmDialog(
      host,
      t("settings.list-field.reset-confirm", { itemLabel }),
      t("settings.list-field.reset-confirm-ok"),
    );
  };

  /** 스키마 폼을 담은 플러그인 설정 페이지 노드 하나(제목 + 폼). */
  /**
   * 플러그인 설정 스키마에서 검색 인덱스(항목 라벨·설명·select 선택지 라벨/설명)를 뽑는다.
   * 페이지를 그리지 않고도 매니페스트 데이터만으로 채울 수 있다 — 설정 트리 검색이 페이지
   * 이름뿐 아니라 그 안의 개별 항목("복사 문구"·"기본 글자 크기" 등)까지 찾게 하는 자리.
   */
  const schemaSearchTerms = (schema: PluginSettingField[]): string[] => {
    const terms: string[] = [];
    for (const field of schema) {
      terms.push(field.label);
      if (field.description) terms.push(field.description);
      for (const opt of settingOptions(field)) {
        terms.push(opt.label ?? opt.value);
        if (opt.description) terms.push(opt.description);
      }
    }
    return terms;
  };

  const pluginPage = (
    id: string,
    label: string,
    category: string,
    schema: PluginSettingField[],
    values: Record<string, unknown>,
    onSet: (key: string, value: unknown) => void,
    description?: string,
  ): SettingsNode => {
    const panel = document.createElement("section");
    panel.id = `settings-page-plugin-${id}`; // e2e/테스트 대상 안정 id
    panel.append(
      buildSettingsPageHead(label, description),
      buildPluginSettingsForm(
        schema,
        values,
        onSet,
        (field, say) => runSettingAction(id, field, say),
        confirmListReset,
      ),
    );
    return {
      id: `plugin:${id}`,
      category,
      label,
      panel,
      searchTerms: schemaSearchTerms(schema),
    };
  };

  // 카테고리 미선언 플러그인 설정의 기본 그룹. "플러그인" 그룹은 번들·커뮤니티 관리 전용이라
  // 설정 페이지는 "도구"로 떨군다(대부분 유틸리티) — 플러그인은 settingsCategory로 바꿀 수 있다.
  const DEFAULT_SETTINGS_CATEGORY = "도구";

  /** 활성 + 스키마 보유 플러그인의 설정 페이지들(번들 + 설치형). category는 매니페스트 선언(없으면 "도구"). */
  const pluginPages = (): SettingsNode[] => {
    const pages: SettingsNode[] = [];
    // 번들 자기 로컬라이즈(축 2) — 설정 페이지 라벨·설명·hints도 활성 로케일로 해석해야
    // renderBuiltinList의 목록 행과 같은 언어로 보인다(호출 시점 해석, §i18n 규약).
    for (const raw of BUILTIN_PLUGINS) {
      const p = resolveBuiltinPluginNls(raw, activeLocale());
      if (!p.settings || p.settings.length === 0) continue;
      if (builtinStates[p.id] === false) continue; // 상태에 없으면 켜짐(기본 ON)
      if (!isSupportedOnPlatform(p.platforms, platform)) continue; // 미지원 OS는 설정 페이지도 숨김
      // template 번들: `templates`(list)의 기본 예시가 로케일마다 다르다(main.js와 같은 규칙 —
      // TEMPLATE_LOCALE_DEFAULT_TEMPLATES 정의부 주석 참고). 두 가지를 여기서 손본다:
      // (1) 스키마 `default`를 "지금 로케일"의 블롭으로 바꿔치기 — 저장값이 아예 없을 때
      //     `mergeSettingDefaults`가 그 값으로 채우고, "기본값으로 되돌리기"도 그 값으로 간다.
      // (2) 저장값이 **있지만** 아직 아무도 손대지 않은 기본 세트(ko든 en이든)와 바이트
      //     동일하면(예: 다른 로케일에서 되돌리기를 눌러 그 언어로 저장된 뒤 로케일을 다시
      //     바꾼 경우) 지금 로케일 세트로 다시 바꿔 보여준다 — (1)만으로는 "저장값이 이미
      //     있다"는 이유로 `default`가 아예 안 쓰여 이 경우를 못 잡는다.
      let schema = p.settings;
      let values = builtinSettings[p.id] ?? {};
      if (p.id === "template") {
        const locale = activeLocale();
        const localeBlob = serializeListBlob(
          TEMPLATE_LOCALE_DEFAULT_TEMPLATES[locale] ??
            TEMPLATE_KO_DEFAULT_TEMPLATES,
        );
        schema = schema.map((f) =>
          f.key === "templates" ? { ...f, default: localeBlob } : f,
        );
        if (typeof values.templates === "string") {
          values = {
            ...values,
            templates: localizeTemplateBlob(values.templates, locale),
          };
        }
      }
      pages.push(
        pluginPage(
          p.id,
          p.name,
          p.settingsCategory ?? DEFAULT_SETTINGS_CATEGORY,
          schema,
          values,
          (key, value) => {
            builtinSettings[p.id] = {
              ...(builtinSettings[p.id] ?? {}),
              [key]: value,
            };
            void deps.setBuiltinSetting(p.id, key, value);
          },
          p.settingsDescription,
        ),
      );
    }
    for (const p of installedList) {
      if (!p.enabled || p.settings_schema.length === 0) continue;
      pages.push(
        pluginPage(
          p.id,
          p.name,
          p.settings_category ?? DEFAULT_SETTINGS_CATEGORY,
          p.settings_schema,
          p.settings,
          (key, value) => void deps.setSetting(p.id, key, value),
          p.settings_description ?? undefined,
        ),
      );
    }
    return pages;
  };

  /** 트리 노드 전체 = 외형 페이지 + 플러그인 설정 페이지 + 관리 노드(번들·커뮤니티). */
  const collectNodes = (): SettingsNode[] => [
    {
      id: "appearance:theme",
      category: "외형",
      label: t("settings.tree.node-theme"),
      panel: themePanel,
      searchTerms: staticPageSearchTerms("appearance:theme"),
    },
    {
      id: "appearance:font",
      category: "외형",
      label: t("settings.tree.node-font"),
      panel: fontPanel,
      searchTerms: staticPageSearchTerms("appearance:font"),
    },
    {
      id: "appearance:shortcuts",
      category: "외형",
      label: t("settings.tree.node-shortcuts"),
      panel: shortcutsPanel,
      searchTerms: staticPageSearchTerms("appearance:shortcuts"),
    },
    {
      id: "appearance:ui-layout",
      category: "외형",
      label: t("settings.tree.node-ui-layout"),
      panel: uiLayoutPanel,
      searchTerms: staticPageSearchTerms("appearance:ui-layout"),
    },
    {
      id: "recovery",
      category: "복구",
      label: t("settings.tree.node-recovery"),
      panel: recovery.panel,
      searchTerms: staticPageSearchTerms("recovery"),
    },
    {
      id: "manage:vault",
      category: "관리",
      label: t("settings.tree.node-vault"),
      panel: vaultPanel.panel,
      searchTerms: staticPageSearchTerms("manage:vault"),
    },
    {
      id: "manage:backup",
      category: "관리",
      label: t("settings.tree.node-backup"),
      panel: backupPanel.panel,
      searchTerms: staticPageSearchTerms("manage:backup"),
    },
    {
      id: "manage:reset",
      category: "관리",
      label: t("settings.tree.node-reset"),
      panel: resetPanel.panel,
      searchTerms: staticPageSearchTerms("manage:reset"),
    },
    // 「시작」— 선택 dep 둘(get/setStartupNoActiveAction) 다 있을 때만 노드를 만든다("IO 없으면
    // UI 없음" 관례). 기존 일반/동작 성격의 노드가 없어 새로 신설했다(스펙 §2 F2).
    ...(deps.getStartupNoActiveAction && deps.setStartupNoActiveAction
      ? [
          {
            id: "startup",
            category: "시작",
            label: t("settings.tree.node-startup"),
            panel: startupPanel,
            searchTerms: staticPageSearchTerms("startup"),
          },
        ]
      : []),
    // 「도움말」— 선택 dep(openGuideNote)이 있을 때만("IO 없으면 UI 없음" 관례 — 「시작」과
    // 같다). 플러그인 그룹보다 **앞**에 두는 이유: 카테고리 정렬은 "외형 맨 앞, 플러그인 맨
    // 뒤, 나머지는 등장순"이라(CATEGORY_RANK) 여기 놓으면 도움말이 관리·시작 다음, 플러그인
    // 앞에 온다 — 처음 온 사람이 찾을 자리다.
    ...(helpPanel
      ? [
          {
            id: "help",
            category: "도움말",
            label: t("settings.tree.node-help"),
            panel: helpPanel,
            searchTerms: staticPageSearchTerms("help"),
          },
        ]
      : []),
    ...pluginPages(),
    // 「플러그인」 그룹 하위로 번들·커뮤니티 관리 노드를 세분화한다(설치·토글·권한). 이 두
    // 페이지의 "항목"은 고정 문구가 아니라 설치된 플러그인 자체라, 이름·한 줄 요약을 검색어로
    // 삼는다 — 설정 폼이 없어 자기 페이지가 없는 플러그인도 이름으로 찾아올 수 있게 한다.
    {
      id: "manager:bundle",
      category: "플러그인",
      label: t("settings.tree.node-bundle"),
      panel: bundlePanel,
      searchTerms: [
        ...BUILTIN_PLUGINS.flatMap((raw) => {
          const p = resolveBuiltinPluginNls(raw, activeLocale());
          return p.summary ? [p.name, p.summary] : [p.name];
        }),
        ...BUILTIN_THEMES.flatMap((raw) => {
          const th = resolveBuiltinThemeNls(raw, activeLocale());
          return th.summary ? [th.name, th.summary] : [th.name];
        }),
        // 번들 언어팩도 이 페이지의 항목이므로 같은 검색어에 합류한다 — 목록에 보이는데
        // 검색으로는 못 찾는 비대칭을 만들지 않는다(번들 플러그인·테마와 같은 규칙).
        ...languagePacks.flatMap((raw) => {
          const p = resolveBuiltinPluginNls(raw, activeLocale());
          return p.summary ? [p.name, p.summary] : [p.name];
        }),
      ],
    },
    {
      id: "manager:community",
      category: "플러그인",
      label: t("settings.tree.node-community"),
      panel: communityPanel,
      searchTerms: installedList.flatMap((p) =>
        p.summary ? [p.name, p.summary] : [p.name],
      ),
    },
  ];

  const rebuildTree = (): void => tree.render(collectNodes());

  // 번들 목록 렌더 — 실행 실패 배지 최신화(호스트 재빌드) 때도 다시 불러 반영한다.
  const renderBuiltinPage = (): void => {
    renderBuiltinList(
      builtinList,
      builtinStates,
      builtinSettings,
      {
        onToggle: (id, enabled) => {
          void deps.setBuiltinEnabled(id, enabled);
          // 로컬 상태를 즉시 반영하고 트리를 다시 조립한다(끄면 그 플러그인 설정 페이지가 사라짐).
          builtinStates = { ...builtinStates, [id]: enabled };
          rebuildTree();
        },
        onOpen: (item) => openDetailInto(item, bundleUI),
      },
      platform,
      pluginFailures,
      languagePacks,
    );
  };
  renderBuiltinPage();

  // ── 「커뮤니티 플러그인」 탭: 외부에서 설치한 플러그인(목록·재조정·설치 모달). ──
  // "플러그인 추가"는 목록 위 버튼 → 누르면 URL/폴더 입력 모달이 뜬다(아래 openAddModal).
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "plugin-add-btn";
  addButton.textContent = t("settings.community.add-button");
  addButton.addEventListener("click", () => openAddModal());

  // "플러그인 만들기" — 베타 피드백(커뮤니티 플러그인을 어떻게 만드는지 모르겠다)의 진입점.
  // 저작 가이드는 이 저장소의 GitHub 문서(docs/plugin/authoring.md)라 인앱 렌더보다 외부
  // 브라우저로 여는 편이 간단하고, 저장소 쪽 갱신도 바로 반영된다(README 링크와 같은 경로 —
  // openLink는 이 시점엔 아직 선언 전이라 deps.openExternal을 직접 쓴다).
  const guideButton = document.createElement("button");
  guideButton.type = "button";
  guideButton.className = "plugin-guide-btn";
  guideButton.textContent = t("settings.community.guide-button");
  guideButton.title = t("settings.community.guide-button-title");
  guideButton.addEventListener("click", () => {
    void deps.openExternal(PLUGIN_AUTHORING_GUIDE_URL).catch(() => {});
  });

  const communityActions = document.createElement("div");
  communityActions.className = "community-actions";
  communityActions.append(addButton, guideButton);
  communityUI.master.append(communityActions);

  // 재조정 안내(비차단 배너) — vault 목록엔 있는데 이 기기에 코드가 없는 항목.
  const missing = document.createElement("div");
  missing.className = "plugin-missing";
  missing.hidden = true;
  communityUI.master.append(missing);

  // 스캔 탈락 안내(비차단 배너) — 재조정과 짝: 이쪽은 "코드는 있는데 못 읽는 항목".
  const rejected = document.createElement("div");
  rejected.className = "plugin-missing plugin-rejected";
  rejected.hidden = true;
  communityUI.master.append(rejected);

  const list = document.createElement("ul");
  list.className = "plugin-list";
  communityUI.master.append(list);

  // 설치 플러그인 검색 — 목록이 길어질 때 이름으로 좁힌다(색 편집기 검색과 같은 패턴).
  const communitySearch = document.createElement("input");
  communitySearch.type = "search";
  communitySearch.className = "plugin-search";
  communitySearch.placeholder = t("settings.community.search-placeholder");
  communitySearch.setAttribute(
    "aria-label",
    t("settings.community.search-placeholder"),
  );
  communitySearch.addEventListener("input", () => {
    const q = communitySearch.value.trim().toLowerCase();
    for (const item of list.querySelectorAll<HTMLElement>(".plugin-item")) {
      const name =
        item.querySelector(".plugin-name")?.textContent?.toLowerCase() ?? "";
      item.hidden = q !== "" && !name.includes(q);
    }
    // 검색 중엔 카테고리 헤더를 숨겨 평평한 결과로 보인다(빈 검색이면 헤더 복원).
    for (const header of list.querySelectorAll<HTMLElement>(
      ".plugin-category",
    )) {
      header.hidden = q !== "";
    }
  });
  communityUI.master.insertBefore(communitySearch, missing);

  /** 열려 있는 상세를 닫고 마스터 목록으로 돌아간다(양쪽 탭 공통 — idempotent). */
  const closeDetail = (): void => {
    for (const ui of [bundleUI, communityUI]) {
      ui.detail.hidden = true;
      ui.detail.replaceChildren();
      ui.master.hidden = false;
    }
  };

  /** README의 https 링크를 외부 브라우저로 연다(실패는 무해 — 무시). */
  const openLink = (url: string): void => {
    void deps.openExternal(url).catch(() => {});
  };

  /**
   * 상세 뷰를 해당 탭의 detail에 연다 — 렌더 후 설치형이면 README를 IPC로 읽어 채운다(번들은
   * 즉시 렌더됨). 읽기 실패/부재는 null → "설명 없음". 그 사이 목록으로 돌아갔으면 결과를 버린다.
   */
  /**
   * README 로컬 이미지 경로 → 로드 URL. 번들은 Vite가 번들한 자산 맵([`BUILTIN_ASSETS`]), 설치형은
   * 플러그인 폴더의 파일을 asset URL로(호스트가 `pluginAssetUrl` 주입). 외부/미해석이면 null.
   */
  const resolvePluginImage = (
    item: PluginDetailItem,
    src: string,
  ): string | null => {
    const rel = src.replace(/^\.\//, ""); // 선행 "./"는 벗긴다.
    if (item.kind === "builtin")
      return BUILTIN_ASSETS[`${item.id}/${rel}`] ?? null;
    return deps.pluginAssetUrl ? deps.pluginAssetUrl(item.id, rel) : null;
  };

  /**
   * 지금까지 연 상세의 일련번호 — 비동기로 늦게 도착한 결과(진단·README)가 **그 사이 열린
   * 다른 상세**에 꽂히는 것을 막는 토큰이다.
   *
   * 왜 `ui.detail.hidden`만으로는 부족한가: 사용자가 A 상세를 열고(요청 in-flight) ← 목록으로
   * 돌아가 B 상세를 열면 detail은 계속 보이는 상태다 — A의 응답이 그대로 B 화면의 「최근
   * 오류」를 갈아 끼운다(A 기록이 비어 있으면 반대로 B의 오류가 사라진 채 섹션이 숨겨진다).
   * 진단 조회는 호스트 무응답 시 2초 예산을 다 쓰므로 경쟁 창이 짧지 않다.
   */
  let detailSeq = 0;

  /**
   * 개발자 모드 감시 대상 플러그인 id — 세션 한정 싱글턴(Rust `set_dev_plugin`과 같은
   * 규칙: 한 번에 최대 하나). 설정 창을 새로 열면 이 값은 다시 null로 시작한다 — Rust 쪽
   * 감시자는 앱 재시작 전까지 계속 살아 있을 수 있지만, 이 변수는 그 상태를 진짜로 아는
   * 유일한 방법이 아니다(추적용 UI 상태일 뿐, 재조회 API가 없다) — 그래서 설정 창을 닫았다
   * 다시 열면 토글이 꺼진 채로 보인다. 감시 자체는 계속되므로 핫리로드는 안 끊긴다.
   */
  let devPluginId: string | null = null;

  const openDetailInto = (
    item: PluginDetailItem,
    ui: { master: HTMLElement; detail: HTMLElement },
  ): void => {
    const seq = ++detailSeq;
    const resolveImage = (src: string): string | null =>
      resolvePluginImage(item, src);
    renderPluginDetail(
      ui.detail,
      {
        ...item,
        diagnostics: pluginDiagnostics.filter((d) => d.pluginId === item.id),
      },
      { ...detailActions, resolveImage },
    );
    // 진단은 상세를 열 때마다 새로 읽는다(호스트가 계속 모으므로 목록 렌더 시점의 값으로는
    // "방금 난 오류"를 놓친다). 도착하면 그 섹션만 갈아 끼운다 — 비차단이고, 호스트 부재·
    // 미배선이면 조용히 지금 화면 그대로 둔다.
    void (deps.pluginDiagnostics?.() ?? Promise.resolve([]))
      .catch(() => [])
      .then((fresh) => {
        pluginDiagnostics = fresh;
        // 그 사이 다른 상세를 열었으면(seq가 밀렸으면) 이 응답은 남의 화면 것이다 — 버린다.
        if (seq !== detailSeq || ui.detail.hidden) return;
        updatePluginDiagnostics(
          ui.detail,
          fresh.filter((d) => d.pluginId === item.id),
        );
      });
    ui.master.hidden = true;
    ui.detail.hidden = false;
    if (item.kind === "installed") {
      const readmeEl = ui.detail.querySelector<HTMLElement>(".plugin-readme");
      void deps
        .readPluginReadme(item.id, activeLocale())
        .catch(() => null)
        .then((md) => {
          // 여전히 이 상세 렌더 안에 있고(뒤로/재열림 시 옛 결과 무시) **이 열기가 최신일
          // 때만** 채운다 — 진단과 같은 오배달 방지 토큰.
          if (seq === detailSeq && readmeEl && ui.detail.contains(readmeEl)) {
            renderReadmeInto(readmeEl, md, openLink, resolveImage);
          }
        });
    }
  };

  /** 설치형 상세를 최신 서버 상태로 다시 연다(부여 토글 후). 사라졌으면 목록으로. */
  const reopenInstalledDetail = async (id: string): Promise<void> => {
    if (communityUI.detail.hidden) return;
    const plugin = (await deps.listPlugins()).find((p) => p.id === id);
    if (plugin)
      openDetailInto(
        detailFromInstalled(
          plugin,
          devPluginId === id,
          Boolean(deps.setDevPlugin),
        ),
        communityUI,
      );
    else closeDetail();
  };

  // 권한 승인 프롬프트(설치/업데이트/재승인 공용 — 평소엔 숨김).
  const prompt = document.createElement("div");
  prompt.className = "plugin-approve";
  prompt.hidden = true;

  /**
   * 이 플러그인이 **언어팩**인가 — 매니페스트 `contributes.translations`가 비어 있지 않은가.
   *
   * 판정은 이미 손에 있는 `installedList`로 끝낸다(추가 IPC 없음): `InstalledPlugin.contributes`가
   * 매니페스트 원문을 그대로 실어 오므로 백엔드에 다시 물을 이유가 없다. 목록에 없는 id
   * (제거 후·재조정 항목처럼 로컬 코드가 없는 것)는 false — 등록된 로케일도 없었다.
   */
  const isLanguagePack = (id: string): boolean => {
    const declared = installedList.find((p) => p.id === id)?.contributes
      ?.translations;
    return Array.isArray(declared) && declared.length > 0;
  };

  /**
   * 언어팩의 설치·활성 토글·제거 뒤 **이 창만** 새로고침한다.
   *
   * 언어 드롭다운 후보(`availableLocales()`)는 마운트 첫머리의 카탈로그 스캔
   * (`listLanguagePacks` + 코드별 `readLocaleEntries`) 한 번으로 굳는다 — 그 뒤 로케일 저장소를
   * 다시 채우는 경로가 없어서, 목록만 다시 그려서는 새 언어가 나타나지도 사라지지도 않는다.
   *
   * **왜 재스캔이 아니라 리로드인가.** 재스캔을 호스트 재빌드마다 태우면 테마·색·일반 플러그인
   * 토글 등 **훨씬 잦은** 재빌드가 전부 그 IPC 비용을 문다(그쪽은 언어와 무관하다). 리로드는
   * 언어팩이 실제로 오갈 때만 일어나고, 그때는 어차피 이미 DOM에 박제된 다른 페이지의 문구까지
   * 새 사전으로 다시 그려야 한다. 선례도 같다 — 언어 피커가 저장 뒤 이 창만 reload한다
   * (노트·패널 창들은 EV_HOST_UPDATED가 이미 전체 reload를 걸어 준다). 대상이 아닌 플러그인의
   * 토글·설치는 지금처럼 부분 재렌더로 끝나 스크롤·탐색 상태를 잃지 않는다.
   *
   * reload() 전에 `flushNotesReload()`를 기다린다 — 이 호출들은 모두 그 앞에서 `reloadAfter`로
   * 감싼 IO(setEnabled·removePlugin·confirmInstall)를 거쳐 400ms notes-reload 타이머를 이미
   * 예약해 둔 상태다. 기다리지 않고 바로 reload()하면 이 창의 self-reload가 그 타이머보다
   * 먼저 JS 런타임을 파기해 notes-reload가 영영 발화하지 않는다(언어 피커와 같은 경합).
   */
  const reloadForLanguagePack = (): Promise<void> =>
    deps.flushNotesReload().then(() => window.location.reload());

  // 목록/재조정을 다시 읽어 그린다(토글·부여·제거·설치 후 서버 상태를 반영).
  const refresh = async (): Promise<void> => {
    installedList = await deps.listPlugins();
    renderPluginList(list, installedList, actions, pluginFailures);
    // 설치 목록이 바뀌면 트리의 플러그인 설정 페이지도 다시 조립한다(활성 + 스키마 보유분).
    rebuildTree();
    // 재조정은 비차단 — 실패해도 설정 창의 나머지는 정상 동작한다.
    const entries = await deps.listMissing().catch(() => []);
    renderMissingList(missing, entries ?? [], missingActions);
    // 스캔 탈락 안내도 같은 비차단 원칙(미배선 dep·조회 실패면 배너를 숨긴 채 진행).
    const bad = await (deps.listRejected?.() ?? Promise.resolve([])).catch(
      () => [],
    );
    renderRejectedList(rejected, bad ?? []);
  };

  // 이미 읽어 둔 installedList로 커뮤니티 목록만 다시 그린다(IPC 재조회 없음) — 호스트 재빌드마다
  // 실행 실패 배지를 최신화하려고 전체 refresh(listPlugins·listMissing 재조회)를 반복할 필요는
  // 없다. 실제 목록 변경(토글·부여·제거·설치)은 여전히 refresh()가 전담한다.
  const renderCommunityPage = (): void => {
    renderPluginList(list, installedList, actions, pluginFailures);
  };

  /** 프롬프트를 닫는다(내용 비움 + 숨김). */
  const closePrompt = (): void => {
    prompt.hidden = true;
    prompt.replaceChildren();
  };

  // 승인 대기 중인 스테이징 토큰(모달을 배경/✕/Esc로 닫으면 이걸 폐기한다).
  let activeStaging: string | null = null;

  /**
   * 설치 플로우 본체 — 스테이징 후 승인 프롬프트를 모달에 띄우고 확정/취소를 처리한다.
   * URL/폴더 설치, 재조정 [설치], 상세 뷰의 업데이트 확인이 모두 이 경로를 쓴다.
   * 진행 중엔 입력을 감춘 채 상태·프롬프트만 보인다(모달 재사용). 상세가 열려 있으면 닫는다.
   * 다운그레이드(설치될 버전이 현재보다 낮음)면 승인 프롬프트 전에 confirmDialog로 한 번 더
   * 확인만 받는다 — 차단하지 않는다(의도적 되돌리기 허용, install-flow.ts의 ApprovalView 참고).
   */
  const startInstall = async (spec: InstallSpec): Promise<void> => {
    closeDetail();
    modal.hidden = false;
    installer.root.hidden = true; // 가져오는 동안·승인 중엔 입력을 감춘다.
    closePrompt();
    status.textContent = t("settings.install.fetching");
    let preview: InstallPreview;
    try {
      preview = await deps.fetchInstall(spec);
    } catch (e) {
      status.textContent = t("settings.install.fetch-failed", {
        error: errorText(e),
      });
      installer.root.hidden = false; // 다시 입력할 수 있게 되돌린다.
      return;
    }
    const view = computeApprovalView(preview);
    if (view.kind === "uptodate") {
      status.textContent = t("settings.install.up-to-date", {
        version: view.version,
      });
      await deps.cancelInstall(preview.staging).catch(() => {});
      installer.root.hidden = false;
      return;
    }
    // minHostVersion 미달: **경고만 하고 차단하지 않는다.** 이 저장소의 선례가
    // 다운그레이드다 — 위험을 알리되 사용자의 의도적 선택은 막지 않는다. 여기서도 같은
    // 이유가 성립한다: (a) 앱 버전 정책이 아직 없어(0.1.0 고정) 이 숫자로 차단하면 정상
    // 플러그인이 통째로 막힐 수 있고, (b) 요구 버전은 저작자의 자기신고라 우리가 검증할 수
    // 없으며, (c) 실제 미지원이면 어차피 브리지 게이트가 호출 단위로 막는다(무음 실패가
    // 아니라 진단에 남는다). 그래서 판단은 사용자에게 넘기고 사실만 정확히 알린다.
    const minHost = previewMinHostVersion(preview);
    if (minHostVersionUnmet(minHost, appVersion)) {
      const proceed = await confirmDialog(
        host,
        t("settings.install.min-host-confirm", {
          minHost: minHost ?? "",
          appVersion,
        }),
        t("settings.install.continue-install-label"),
      );
      if (!proceed) {
        await deps.cancelInstall(preview.staging).catch(() => {});
        status.textContent = t("settings.install.cancelled");
        installer.root.hidden = false;
        return;
      }
    }
    if (view.kind === "downgrade") {
      // 차단하지 않는다 — 되돌리기는 사용자 의도일 수 있다. 다만 실수로 낮은 버전을 받아오지
      // 않도록 승인 프롬프트 전에 한 번 더 확인만 받는다(취소하면 스테이징 폐기 + 입력 복귀).
      const proceed = await confirmDialog(
        host,
        t("settings.install.downgrade-confirm", {
          version: view.version,
          fromVersion: view.fromVersion ?? "?",
        }),
        t("settings.install.continue-install-label"),
      );
      if (!proceed) {
        await deps.cancelInstall(preview.staging).catch(() => {});
        status.textContent = t("settings.install.cancelled");
        installer.root.hidden = false;
        return;
      }
    }
    activeStaging = preview.staging;
    status.textContent = "";
    renderApprovalPrompt(prompt, promptModelForView(view), {
      onApprove: () => {
        void (async () => {
          // 성공한 설치의 id — 아래 refresh 뒤 "방금 들어온 것이 언어팩인가"를 판정할 때 쓴다.
          // 실패하면 null로 남아 판정 자체를 건너뛴다.
          let installedId: string | null = null;
          try {
            const id = await deps.confirmInstall(
              preview.staging,
              grantsForApproval(preview),
            );
            installedId = id;
            activeStaging = null;
            // 승인은 받았지만 예약(미구현)이라 부여하지 못한 민감 권한을 기억해 둔다.
            // 이 기록이 없으면 나중에 예약이 풀려도 아무도 그 사실을 모른다 — 사용자는
            // 이미 "승인"을 눌렀는데 그 권한을 영영 못 쓰게 된다. 실패는 무해(다음 설치·
            // 업데이트에서 다시 기록된다)라 설치 결과를 뒤엎지 않는다.
            await deps
              .setPendingReserved?.(id, pendingReservedForApproval(preview))
              .catch(() => {});
            status.textContent =
              view.kind === "update"
                ? t("settings.install.updated", { id, version: view.version })
                : view.kind === "downgrade"
                  ? t("settings.install.downgraded", {
                      id,
                      version: view.version,
                    })
                  : t("settings.install.installed", {
                      id,
                      version: view.version,
                    });
          } catch (e) {
            status.textContent = t("settings.install.install-failed", {
              error: errorText(e),
            });
          }
          // 모달은 열어 둔 채 결과 상태 + 입력을 다시 보인다(연속 추가·재시도 가능 — ✕/배경/Esc로 닫음).
          closePrompt();
          installer.root.hidden = false;
          await refresh();
          // 설치·업데이트로 들어온 것이 언어팩이면 이 창을 새로고침한다(그 언어가 드롭다운에
          // 나타나는 유일한 경로). 판정은 refresh **뒤에** — 방금 설치된 플러그인은 그때서야
          // 목록에 들어온다. 방금 쓴 결과 문구는 리로드로 사라지지만, 리로드가 여는 기본
          // 페이지(외형 › 테마)가 바로 그 언어 드롭다운이 있는 곳이고 설치 결과는 목록에
          // 남는다 — 이 드문 경로 하나를 위해 "모달을 닫을 때 리로드" 같은 상태를 더 두지 않는다.
          if (installedId !== null && isLanguagePack(installedId))
            await reloadForLanguagePack();
        })();
      },
      onCancel: () => {
        void (async () => {
          if (activeStaging !== null) {
            await deps.cancelInstall(activeStaging).catch(() => {});
            activeStaging = null;
          }
          closePrompt();
          installer.root.hidden = false;
          status.textContent = t("settings.install.cancelled");
        })();
      },
    });
    prompt.hidden = false;
  };

  /**
   * 새 기기 재승인 — 모달에 입력 없이 프롬프트만 띄우고 **부여 가능한** 민감 권한을 부여한다.
   *
   * 설치 승인과 **같은 필터**를 쓴다(`grantsForRegrant` = `grantsForApproval`): 예약 권한은
   * 부여하지 않고 `pendingReserved`로 따로 기억해 둔다. 두 경로가 다른 답을 내면
   * "설치에서는 보류된 권한이 이 버튼 한 번으로 부여된다"가 된다 — 특히 동기화로 넘어온 새
   * 기기에는 `pendingReserved`가 없어, 여기서 심어 두지 않으면 나중에 예약이 풀려도 재승인
   * 배너가 뜨지 않는다.
   */
  const startRegrant = (plugin: InstalledPlugin): void => {
    modal.hidden = false;
    installer.root.hidden = true;
    status.textContent = "";
    closePrompt();
    renderApprovalPrompt(prompt, promptModelForRegrant(plugin), {
      onApprove: () => {
        void (async () => {
          await deps.setGranted(plugin.id, grantsForRegrant(plugin));
          await deps
            .setPendingReserved?.(plugin.id, pendingReservedForRegrant(plugin))
            .catch(() => {});
          await refresh();
          closeAddModal();
        })();
      },
      onCancel: () => closeAddModal(),
    });
    prompt.hidden = false;
  };

  /**
   * 예약 해제 재승인 — 이제 쓸 수 있게 된 권한만 프롬프트에 띄운다.
   *
   * 승인: 기존 부여 ∪ available로 `setGranted`, `pendingReserved`는 remaining으로 줄인다
   * (해소된 항목이 빠져 다음 실행부터 안내가 사라진다). 취소: 아무 상태도 바꾸지 않는다 —
   * 모달은 Esc·배경 클릭으로도 닫히므로 오조작 한 번에 권한을 영구히 잃게 하지 않는다
   * (`reservedRegrant` 참고). 안내 행은 다음 실행에 다시 뜬다.
   */
  const startReservedRegrant = (
    plugin: InstalledPlugin,
    available: string[],
  ): void => {
    modal.hidden = false;
    installer.root.hidden = true;
    status.textContent = "";
    closePrompt();
    renderApprovalPrompt(prompt, promptModelForReserved(plugin, available), {
      onApprove: () => {
        void (async () => {
          // 부여·기록은 **지금의** 서버 상태 위에 얹는다(상세 뷰의 부여 토글과 같은 규칙) —
          // 행을 그린 뒤 다른 경로로 부여가 바뀌었을 수 있어, 행 스냅샷으로 덮어쓰면 그
          // 변경을 조용히 되돌린다.
          const current =
            (await deps.listPlugins().catch(() => [])).find(
              (p) => p.id === plugin.id,
            ) ?? plugin;
          await deps.setGranted(plugin.id, [
            ...new Set([...current.granted, ...available]),
          ]);
          await deps
            .setPendingReserved?.(plugin.id, reservedRegrant(current).remaining)
            .catch(() => {});
          await refresh();
          closeAddModal();
        })();
      },
      onCancel: () => closeAddModal(),
    });
    prompt.hidden = false;
  };

  const actions: MasterActions = {
    setEnabled: (id, enabled) => {
      // 언어팩 여부는 **바꾸기 전에** 읽어 둔다 — 판정 근거(매니페스트)는 활성 여부와 무관하고,
      // 제거 경로와 같은 규칙을 쓰면 나중에 목록 갱신 시점이 바뀌어도 어긋나지 않는다.
      const languagePack = isLanguagePack(id);
      void deps.setEnabled(id, enabled).then(async () => {
        await refresh();
        if (languagePack) await reloadForLanguagePack();
      });
    },
    approve: (plugin) => {
      startRegrant(plugin);
    },
    approveReserved: (plugin, available) => {
      startReservedRegrant(plugin, available);
    },
    open: (plugin) => {
      openDetailInto(
        detailFromInstalled(
          plugin,
          devPluginId === plugin.id,
          Boolean(deps.setDevPlugin),
        ),
        communityUI,
      );
    },
  };

  const detailActions: DetailActions = {
    back: closeDetail,
    // 민감 권한 부여 토글(상세 뷰) — 현재 부여와 병합해 보내고 상세를 최신으로 다시 연다.
    setGranted: (id, permission, granted) => {
      void (async () => {
        const plugins = await deps.listPlugins();
        const current = plugins.find((p) => p.id === id)?.granted ?? [];
        const next = granted
          ? [...new Set([...current, permission])]
          : current.filter((p) => p !== permission);
        await deps.setGranted(id, next);
        await refresh();
        await reopenInstalledDetail(id);
      })();
    },
    // 설정은 트리가 정본 — 상세의 "설정 열기"가 그 플러그인의 트리 노드로 이동시킨다.
    openSettings: (item) => tree.select(`plugin:${item.id}`),
    checkUpdate: (plugin) => {
      const spec = plugin.source ? specFromSource(plugin.source) : null;
      if (spec) void startInstall(spec);
    },
    remove: (id) => {
      // 제거 뒤에는 목록에서 사라져 매니페스트를 볼 수 없다 — 언어팩 여부를 먼저 읽어 둔다.
      const languagePack = isLanguagePack(id);
      void deps.removePlugin(id).then(async () => {
        closeDetail();
        await refresh();
        if (languagePack) await reloadForLanguagePack();
      });
    },
    // 개발자 모드 — 세션 한정 싱글턴이라 켜면 이전 감시 대상을 자동 대체한다(Rust
    // `set_dev_plugin`이 직전 감시자를 drop). 실패해도 조용히 넘어간다(폴더가 그 사이
    // 사라졌을 수 있다) — devPluginId는 실제로 성공했을 때만 갱신해, 토글이 거짓으로 "켜짐"
    // 상태를 보이지 않게 한다.
    setDevMode: (id, on) => {
      void (async () => {
        try {
          await deps.setDevPlugin?.(on ? id : null);
          devPluginId = on ? id : null;
        } catch {
          // 실패 시 devPluginId를 바꾸지 않는다 — 토글 재렌더가 실제 상태(안 바뀜)를 그대로 보인다.
        }
        await reopenInstalledDetail(id);
      })();
    },
    openLink,
    // 기본 이미지 해석기(아이템 미지정) — openDetailInto가 아이템별 해석기로 덮어쓴다.
    resolveImage: () => null,
  };

  const missingActions: MissingActions = {
    install: (entry) => {
      const spec = specFromSource(entry.source);
      if (spec) void startInstall(spec);
    },
    // 제거는 설치 플러그인과 같은 경로 — 로컬 코드가 없으니 vault 목록 항목만 지워진다.
    remove: (id) => {
      void deps.removePlugin(id).then(refresh);
    },
    dismiss: (id) => {
      void deps.dismissMissing(id).then(refresh);
    },
  };

  const installer = buildInstaller(
    (spec) => void startInstall(spec),
    deps.pickPluginDir?.bind(deps),
  );
  const status = installer.status;

  // "플러그인 추가" 모달 — 입력(installer)·상태·승인 프롬프트를 담는다(평소엔 숨김).
  // add 버튼에선 입력을 보이고, 설치/업데이트/재승인 진행 중엔 감춘 채 프롬프트만 보인다.
  const modal = document.createElement("div");
  modal.className = "settings-modal";
  modal.hidden = true;
  const modalCard = document.createElement("div");
  modalCard.className = "settings-modal-card";
  const modalClose = document.createElement("button");
  modalClose.type = "button";
  modalClose.className = "settings-modal-close";
  modalClose.setAttribute("aria-label", t("settings.community.modal-close"));
  modalClose.textContent = "✕";
  modalClose.addEventListener("click", () => closeAddModal());
  const modalTitle = document.createElement("h2");
  modalTitle.className = "settings-modal-title";
  modalTitle.textContent = t("settings.community.modal-title");
  modalCard.append(modalClose, modalTitle, installer.root, status, prompt);
  modal.append(modalCard);
  // 배경(카드 밖) 클릭으로 닫는다 — 카드 내부 클릭은 무시.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeAddModal();
  });
  communityUI.master.append(modal);

  /** 추가 모달을 연다(입력 표시 + 프롬프트·상태 초기화). */
  const openAddModal = (): void => {
    installer.reset();
    closePrompt();
    installer.root.hidden = false;
    modal.hidden = false;
  };
  /** 추가 모달을 닫는다(승인 대기 스테이징이 있으면 폐기 + 초기화). */
  const closeAddModal = (): void => {
    modal.hidden = true;
    if (activeStaging !== null) {
      void deps.cancelInstall(activeStaging).catch(() => {});
      activeStaging = null;
    }
    closePrompt();
    installer.root.hidden = false;
    installer.reset();
  };
  // Esc로 모달을 닫는다(설정창은 언마운트가 없어 리스너 정리 불필요).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeAddModal();
  });

  // 좌측 트리 + 우측 내용을 마운트한다(기본 선택: 외형 › 테마). 트리는 먼저 동기로 한 번 조립해
  // 외형·번들 페이지를 즉시 보이고, refresh가 설치 플러그인까지 반영해 다시 조립한다.
  host.append(tree.layout);
  rebuildTree();
  // minHostVersion 게이트의 기준값 — 설치 플로우가 시작되기 전에 한 번만 읽는다.
  appVersion = await (deps.hostVersion?.() ?? Promise.resolve("")).catch(
    () => "",
  );
  await refresh();
  // 복구 페이지의 첫 조회(스냅샷 보유 노트) — 비차단이라 설정 창의 나머지를 붙잡지 않는다.
  void recovery.refresh();
}
