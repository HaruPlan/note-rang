/**
 * 재빌드 완료 방송(`EV_HOST_UPDATED`)을 받은 노트 창의 **판정기** — 창을 리로드해야 하는가,
 * 아니면 새 설정·스냅샷으로 제자리에서 조정(reconcile)하면 되는가.
 *
 * 왜 별도 모듈인가: 배선(`bootstrap/note.ts`)은 Tauri 이벤트·IPC·DOM과 얽혀 단위 테스트가
 * 어렵다. "이 변화를 제자리에서 따라갈 수 있는가"라는 규칙만 여기로 떼어 내면, 리스너는
 * 조회·적용만 남고 규칙은 DOM 없이 검증된다(`note-local-apply.ts`와 같은 결).
 *
 * ## 안전 원칙 — 모르면 리로드
 *
 * 판정은 **화이트리스트**다: 여기서 "따라갈 수 있다"고 이름을 적어 둔 표면만 조정하고, 그
 * 밖의 차이가 하나라도 보이면 리로드한다. 뒤집어(블랙리스트로) 쓰면 새 표면이 하나 생길
 * 때마다 조용히 조정 경로를 타고 **낡은 화면이 남는다** — 눈에 띄지 않는 무음 실패다.
 * 리로드는 깜빡이고 상태를 잃지만 언제나 옳은 화면을 낸다. 그래서 판정 입력이 하나라도
 * 없으면(설정·스냅샷·vault 경로를 못 읽었으면) 그것도 리로드다.
 *
 * ## 조정하는 표면(= 재적용 API가 있는 것만)
 *
 * - 활성 테마 자체 + 그 위의 색 오버라이드 → `NoteWindowHandle.applyTheme`
 * - `theme_overrides` → `NoteWindowHandle.applyThemeOverrides`
 * - 배경 능력(스와치·자동 대비) → `NoteWindowHandle.applyBackgroundCapability`
 * - `defaults.font_size` → `NoteWindowHandle.applyBaseFontPx`
 * - 폰트 능력 + `defaults.font_family` → `NoteWindowHandle.applyFontCapability`
 * - 창 컨트롤 능력(투명도·항상 위·모든 데스크탑) → `NoteWindowHandle.applyWindowControls`
 * - `keybindings` → `NoteWindowHandle.applyKeybindings`
 * - 플러그인 CM 확장·선택 액션·인라인 패턴 CSS → `applyPluginExtensions(snapshot)`
 *   (개발 모드 단일 핫리로드가 쓰던 그 클로저 그대로)
 * - 유튜브 임베드 컨텍스트 메뉴 항목 → `NoteWindowHandle.applyYoutubeEmbedEnabled`
 * - 플러그인 툴바 버튼·상태 아이템·명령·메뉴 항목 → `NoteWindowHandle.reconcileToolbarItems`
 * - 플러그인 생명주기 이벤트 발신기 → `noteEventEmitter(새 스냅샷, …)` 교체 + `note:opened` 재발신
 *
 * 능력 세 가지(배경·폰트·창 컨트롤)가 여기 있다는 것은 **그 능력만 등록하는 플러그인**의
 * 설치·삭제·on/off도 조정이라는 뜻이다 — 번들 「배경색」·「글꼴」·「투명도」·「항상 위」·
 * 「모든 데스크탑」이 정확히 그 모양이라(각자 능력 하나만 등록한다) 이 다섯을 켜고 끄는 일이
 * 더는 창을 깜빡이지 않는다. 툴바 항목 네 표면이 합류하면서 **버튼을 가진 플러그인**(번들
 * 「복제」·「AI 프롬프트 복사」·「글자 크기」·「옵션 초기화」, 커뮤니티 플러그인 대부분)의
 * 설치·삭제·on/off·설정 변경도 같은 자리에 들어왔다.
 *
 * 그 밖은 리로드다: 언어팩(사유 `locale` + 아무 표면도 등록하지 않는 **빈 껍데기** 판정),
 * `builtin` 플래그가 뒤집힌 플러그인, vault 경로, 화이트리스트 밖 설정 키(툴바 배치 등),
 * 초기화/삭제/복원 사유.
 */
import type {
  HostSnapshot,
  PluginSnapshot,
  RebuildReason,
} from "../plugin/host-protocol";
import {
  buttonsEqual,
  commandsEqual,
  menuItemsEqual,
  sameNameSet,
  sliceHasCapabilities,
  statusItemsEqual,
} from "../plugin/snapshot-diff";
import {
  diffSettingsKeys,
  LOCAL_APPLY_KEYS,
  type DiffableSettings,
} from "./settings-diff";
import { activeThemeOverrides, defaultFontPx } from "./note-local-apply";
import type { ThemeDescriptor } from "../theme/theme";
import type { BackgroundDescriptor } from "../theme/background";
import { savedFontFamily, type FontDescriptor } from "../theme/font";
import { effectiveKeybindings } from "../shortcuts/actions";

/**
 * 제자리 조정으로 따라갈 수 있는 **공유 설정 키**.
 *
 * 관계는 포함이다: `LOCAL_APPLY_KEYS` ⊆ `RECONCILE_SETTINGS_KEYS`. 국소 반영이 되는 키는
 * 값만 다시 읽으면 창이 혼자 반영할 수 있는 것들이라 재빌드 뒤에도 당연히 조정 가능하고,
 * 그래서 정본 하나(`settings-diff.ts`)를 그대로 깔고 간다 — 한쪽만 넓히면 같은 키가 어느
 * 경로로 왔느냐에 따라 반영되기도 하고 안 되기도 한다.
 *
 * **초과분**은 "스냅샷(또는 호스트 재빌드)이 있어야 해석되는 키"다 — 그래서 국소 경로에는
 * 넣을 수 없다:
 * - `theme` — 활성 테마 **선택**이다. 새 팔레트는 중앙 호스트가 테마 플러그인을 다시 돌려야
 *   나오므로(스냅샷의 `theme`), 값만 읽는 국소 경로로는 알 방법이 없다. 국소 화이트리스트에
 *   넣으면 `bootstrap/settings.ts`가 재빌드 방송 자체를 건너뛰어, 노트 창이 **옛 테마 위에
 *   새 오버라이드만** 얹은 채 영원히 남는다.
 * - `keybindings` — 노트 창은 값만으로 반영할 수 있지만(맵 교체), 이 설정의 소비처가 노트
 *   창만은 아니다. 재빌드를 거치는 편이 다른 표면과 어긋나지 않고, 노트 창 입장에서 잃는
 *   것도 없다(아래 `keymap` 단계가 리로드를 대신한다).
 */
const RECONCILE_SETTINGS_KEYS: readonly string[] = [
  ...LOCAL_APPLY_KEYS,
  "theme",
  "keybindings",
];

/**
 * **언제나 리로드**인 재빌드 사유.
 *
 * `locale`이 여기 있는 이유가 이 목록의 존재 이유다: 언어팩은 스냅샷에도 공유 설정에도
 * (설치·활성 여부가) 실리지 않아, 사유가 아니면 노트 창이 알 방법이 아예 없다.
 * `unknown`(사유 없음·형식 위반)도 같은 칸에 둔다 — 모르면 리로드.
 */
const RELOAD_ONLY_REASONS: readonly RebuildReason[] = [
  "locale",
  "vault",
  "reset",
  "wipe",
  "import",
  "unknown",
];

/**
 * 조정 절차 한 단계 — 노트 창이 이 순서(선언 순서)대로 재적용한다.
 *
 * 툴바 DOM을 건드리는 세 단계(`background`·`window_controls`·`toolbar_items`)는 같은 존을
 * 나눠 쓰지만 서로 다른 항목만 넣고 빼므로(앞의 둘은 내장 컨트롤, 마지막은 플러그인 항목)
 * 순서 의존이 없다 — 그래도 선언 순서를 정본으로 두어 두 창이 같은 재빌드에서 다른 결과를
 * 내지 않게 한다. `toolbar_items`를 내장 능력 단계 **뒤**에 두는 이유는 그래서 정합성이
 * 아니라 읽는 순서다: 존이 먼저 제 모습을 갖춘 뒤 플러그인 항목이 그 위에 얹힌다.
 */
export type ReconcileStep =
  | "theme"
  | "theme_overrides"
  | "background"
  | "font_size"
  | "font_family"
  | "window_controls"
  | "keymap"
  | "extensions"
  | "toolbar_items"
  | "youtubeEmbed"
  | "events";

/** [`planHostUpdate`]의 입력 — 마운트(또는 직전 조정) 시점의 값과 방금 재조회한 값의 짝. */
export interface HostUpdatePlanInput {
  /** 이 재빌드를 낳은 사유들(합집합). 빈 배열·모르는 값은 발신 쪽에서 이미 `unknown`이 된다. */
  reasons: readonly RebuildReason[];
  /** 기준 공유 설정(못 읽었으면 null → 리로드). */
  prevSettings: DiffableSettings | null;
  /** 방금 재조회한 공유 설정(못 읽었으면 null → 리로드). */
  nextSettings: DiffableSettings | null;
  /** 기준 스냅샷(마운트 때 못 받았으면 null → 리로드). */
  prevSnapshot: HostSnapshot | null;
  /** 방금 재조회한 스냅샷(못 받았으면 null → 리로드). */
  nextSnapshot: HostSnapshot | null;
  prevVaultPath: string | null;
  nextVaultPath: string | null;
}

/**
 * 판정 결과 — 리로드(사유 문자열 포함)이거나, 순서가 정해진 조정 단계 목록이다.
 *
 * `why`는 진단·테스트용 짧은 기계 문자열(`"reason:locale"`·`"settings:theme"` 같은 형태)이다.
 * 사용자에게 보이지 않는다 — 리로드 안내 문구는 예전 그대로 하나다.
 */
type HostUpdatePlan =
  | { action: "reload"; why: string }
  | { action: "reconcile"; steps: ReconcileStep[] };

/** 플러그인 id → 슬라이스 맵(집합 비교·슬롯 비교의 공통 준비). */
function byId(snapshot: HostSnapshot): Map<string, PluginSnapshot> {
  return new Map(snapshot.plugins.map((p) => [p.pluginId, p]));
}

/**
 * 이 슬라이스가 **노트 창의 툴바 항목 표면**(툴바 버튼·명령·메뉴 항목·상태 아이템)을
 * 하나라도 등록했는가 — 이제는 리로드 근거가 아니라 [`ReconcileStep`]`"toolbar_items"`의
 * 근거다.
 *
 * 예전에는 이 네 표면이 "마운트 때 굳는다"는 이유로 리로드를 강제했다. 노트 창이 항목을
 * 키(`plugin:<pluginId>:<id>`)로 들고 diff할 수 있게 되면서(`NoteWindowHandle.
 * reconcileToolbarItems`) 굳는 표면이 아니게 됐다. 트레이 항목은 여전히 여기 없다: 그것은
 * 노트 창이 아니라 **네이티브 메뉴바**가 그리고, 중앙 호스트가 재빌드마다 직접 다시 배달한다
 * (`deliverTrayItems`) — 노트 창을 리로드해도 달라지는 것이 없다.
 */
function sliceHasToolbarItemSurfaces(s: PluginSnapshot): boolean {
  return (
    s.buttons.length > 0 ||
    (s.commands?.length ?? 0) > 0 ||
    (s.menuItems?.length ?? 0) > 0 ||
    (s.statusItems?.length ?? 0) > 0
  );
}

/**
 * 이 슬라이스가 **제자리 재적용이 되는 표면**을 하나라도 등록했는가(패턴·자동완성·임베드·
 * 선택 액션 + 능력 셋: 배경·폰트·창 컨트롤 + 툴바 항목 넷).
 *
 * 플러그인 하나가 통째로 들어오거나 빠질 때 쓰는 판정이다: 이 표면들만 있으면
 * `applyPluginExtensions`(확장)·능력 단계(배경·폰트·창 컨트롤)·`toolbar_items` 단계로 따라갈
 * 수 있다. 반대로 **아무 표면도 없는 빈 껍데기**는 조정하지 않고 리로드한다 — 노트 창이
 * 관측할 수 있는 근거가 하나도 없다는 뜻이고, 실제로 그 모양의 대표가 **언어팩**이다(코드도
 * 디스크립터도 없이 사전만 선언한다). 사유(`locale`)로도 걸리지만 판정을 두 겹으로 둔다(무음
 * 실패가 나면 화면이 옛 언어로 남는 종류의 실패라서). 언어팩은 능력도 툴바 항목도 등록하지
 * 않으므로 이 확장으로도 여전히 걸린다.
 */
function sliceHasReconcilableSurfaces(s: PluginSnapshot): boolean {
  return (
    sliceHasExtensionSurfaces(s) ||
    sliceHasCapabilities(s) ||
    sliceHasToolbarItemSurfaces(s)
  );
}

/**
 * 이 슬라이스가 **CM 확장으로 재적용되는 표면**을 등록했는가 — 위 판정의 절반이자,
 * "확장을 다시 만들어야 하는가"(`extensions` 단계)의 근거다.
 *
 * 능력과 갈라 두는 이유: 능력만 등록한 플러그인이 들어오고 나가는 것은 확장과 무관하다.
 * 함께 묶으면 배경 플러그인을 켤 때마다 애먼 `extensions` 단계가 따라붙는다(무해하지만,
 * 단계 목록은 "무엇이 바뀌었는가"를 그대로 읽을 수 있어야 한다).
 */
function sliceHasExtensionSurfaces(s: PluginSnapshot): boolean {
  return (
    s.patterns.length > 0 ||
    s.completions.length > 0 ||
    s.embeds.length > 0 ||
    (s.selectionActions?.length ?? 0) > 0
  );
}

/** 키 순서와 무관한 깊은 동등 비교(직렬화 스냅샷 전용 — 함수·순환 없음). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 이 슬라이스에서 **CM 확장으로 재적용되는 부분**이 바뀌었는가(패턴·자동완성·임베드·선택
 * 액션 + 그 게이트인 `grant`).
 *
 * `grant`를 함께 보는 이유: 임베드 도메인 게이트(`embed:<domain>`)와 선택 텍스트 전달 여부가
 * 부여에 따라 달라지는데, 그 판정을 노트 창이 로컬에서 한다(`buildExtensionsFromSnapshot`).
 * 부여만 바뀌어도 확장을 다시 만들어야 한다.
 */
function extensionsChanged(a: PluginSnapshot, b: PluginSnapshot): boolean {
  return (
    !sameJson(a.patterns, b.patterns) ||
    !sameJson(a.completions, b.completions) ||
    !sameJson(a.embeds, b.embeds) ||
    !sameJson(a.selectionActions ?? [], b.selectionActions ?? []) ||
    !sameJson(a.grant, b.grant)
  );
}

/**
 * 빌트인 `youtube-embed`가 이 스냅샷에서 **실행 중인가** — 컨텍스트 메뉴의 "유튜브 추가"
 * 표시 조건이다.
 *
 * 마운트 때는 이 값을 `listBuiltinStates()`(활성 맵)로 판정한다 — 스냅샷이 늦게 올 수 있어서다.
 * 재빌드 완료 시점에는 스냅샷이 이미 손에 있고, 중앙 호스트가 번들을 실행하는 조건이 곧
 * "활성 ∧ 플랫폼 지원"이라(이 플러그인은 플랫폼 제약이 없다) 스냅샷에 들어 있는지가 활성
 * 여부와 같은 답을 준다. 그래서 IPC를 한 번 더 태우지 않는다.
 */
const YOUTUBE_EMBED_ID = "youtube-embed";
function youtubeEmbedRunning(snapshot: HostSnapshot): boolean {
  return snapshot.plugins.some((p) => p.pluginId === YOUTUBE_EMBED_ID);
}

/**
 * 재빌드 완료 방송 하나를 어떻게 반영할지 정한다 — 리로드 또는 조정 단계 목록.
 *
 * 순서: (1) 사유만으로 리로드가 확정되는가 → (2) 판정 입력이 다 있는가 → (3) vault·설정·
 * 스냅샷에서 화이트리스트(위 "조정하는 표면") 밖 변화가 있는가 → (4) 남으면 바뀐 것만 골라
 * 조정 단계로.
 */
export function planHostUpdate(input: HostUpdatePlanInput): HostUpdatePlan {
  // (1) 사유 — 이 중 하나라도 있으면 다른 입력을 볼 것도 없이 리로드다.
  for (const reason of input.reasons) {
    if (RELOAD_ONLY_REASONS.includes(reason)) {
      return { action: "reload", why: `reason:${reason}` };
    }
  }
  // 사유가 아예 없는 방송(구버전 호스트)도 모른다는 뜻이다 — 발신 쪽이 `unknown`으로 접지만
  // 여기서도 한 번 더 막는다(두 겹).
  if (input.reasons.length === 0) {
    return { action: "reload", why: "reason:none" };
  }

  // (2) 판정 입력 — 하나라도 없으면 무엇이 바뀌었는지 알 수 없다.
  const { prevSettings, nextSettings, prevSnapshot, nextSnapshot } = input;
  if (!prevSettings || !nextSettings) {
    return { action: "reload", why: "settings:unavailable" };
  }
  if (!prevSnapshot || !nextSnapshot) {
    return { action: "reload", why: "snapshot:unavailable" };
  }

  // (3-a) vault 경로 — 첨부 URL의 기준이라 바뀌면 이미 그려진 이미지가 통째로 낡는다.
  if (input.prevVaultPath !== input.nextVaultPath) {
    return { action: "reload", why: "vault:changed" };
  }

  // (3-b) 공유 설정 — 화이트리스트 밖 키가 하나라도 바뀌었으면 리로드(가장 먼저 걸리는 것을
  // `why`에 담아 진단에 쓴다).
  const changedKeys = diffSettingsKeys(prevSettings, nextSettings);
  const foreignKey = changedKeys.find(
    (key) => !RECONCILE_SETTINGS_KEYS.includes(key),
  );
  if (foreignKey !== undefined) {
    return { action: "reload", why: `settings:${foreignKey}` };
  }

  // (3-c) 스냅샷의 전역 표면(테마·배경·폰트·창 컨트롤)은 전부 재적용 API가 생겼다 — 여기서
  // 리로드로 접지 않고 아래 (4)에서 단계로 만든다.

  // (3-d) 플러그인별 표면.
  const prevPlugins = byId(prevSnapshot);
  const nextPlugins = byId(nextSnapshot);
  let extensionsDirty = false;
  let toolbarItemsDirty = false;
  for (const [pluginId, next] of nextPlugins) {
    const prev = prevPlugins.get(pluginId);
    if (!prev) {
      // 새로 들어온 플러그인: 관측할 표면이 하나도 없으면(빈 껍데기 — 언어팩이 그 모양이다)
      // 리로드. 그 밖에는 등록한 표면에 해당하는 단계만 켠다.
      if (!sliceHasReconcilableSurfaces(next)) {
        return { action: "reload", why: `plugin-added:${pluginId}` };
      }
      // 능력만 등록한 플러그인이면 확장은 그대로다 — 그쪽은 아래 (4)의 능력 단계가 맡는다.
      if (sliceHasExtensionSurfaces(next)) extensionsDirty = true;
      if (sliceHasToolbarItemSurfaces(next)) toolbarItemsDirty = true;
      continue;
    }
    // 빌트인/사이드로드 구분은 컨텍스트 메뉴의 출처 항목 필터를 뒤집는다. 노트 창은 그 값을
    // 항목마다 실어 받으므로 원리상 조정할 수 있지만, 같은 플러그인 id가 번들↔사이드로드로
    // 갈아 끼워졌다는 것은 코드 자체가 바뀌었다는 뜻이라 보수적으로 리로드로 남긴다.
    if (prev.builtin !== next.builtin) {
      return { action: "reload", why: `plugin-surface:${pluginId}` };
    }
    if (
      !buttonsEqual(prev.buttons, next.buttons) ||
      !commandsEqual(prev.commands, next.commands) ||
      !menuItemsEqual(prev.menuItems, next.menuItems) ||
      !statusItemsEqual(prev.statusItems, next.statusItems)
    ) {
      toolbarItemsDirty = true;
    }
    // 능력(배경·폰트·창 컨트롤)이 **누구 것인지**는 더 보지 않는다: 창이 실제로 소비하는 것은
    // 전역 병합 결과 하나이고(아래 (4)에서 그 값을 그대로 비교한다), 등록 주체만 바뀌고 병합
    // 결과가 같다면 화면에 달라질 것이 없다. 예전엔 "등록 순서 의존 병합의 입력이 달라졌다"는
    // 이유로 여기서 리로드했지만, 그 논리는 재적용 API가 없던 시절의 안전장치였다.
    if (extensionsChanged(prev, next)) extensionsDirty = true;
  }
  for (const [pluginId, prev] of prevPlugins) {
    if (nextPlugins.has(pluginId)) continue;
    // 빠진 플러그인: 들어올 때와 같은 잣대(빈 껍데기면 리로드).
    if (!sliceHasReconcilableSurfaces(prev)) {
      return { action: "reload", why: `plugin-removed:${pluginId}` };
    }
    if (sliceHasExtensionSurfaces(prev)) extensionsDirty = true;
    if (sliceHasToolbarItemSurfaces(prev)) toolbarItemsDirty = true;
  }

  // (4) 조정 단계 — 바뀐 것만, 선언 순서대로.
  const steps: ReconcileStep[] = [];
  // 활성 테마가 갈렸는가 — 팔레트(스냅샷)가 달라졌거나 테마 **선택**(설정)이 달라졌거나.
  // 후자는 팔레트가 우연히 같아도 딸린 색 오버라이드 엔트리가 통째로 바뀌므로 함께 본다.
  const themeChanged =
    !sameJson(prevSnapshot.theme, nextSnapshot.theme) ||
    changedKeys.includes("theme");
  if (themeChanged) {
    // `theme` 단계가 오버라이드까지 같은 값(`activeThemeOverrides(next.settings)`)으로 함께
    // 얹으므로 `theme_overrides`를 따로 넣지 않는다 — 넣으면 같은 일을 두 번 한다.
    steps.push("theme");
  } else if (changedKeys.includes("theme_overrides")) {
    steps.push("theme_overrides");
  }
  // 배경 능력 — 스와치 목록·자동 대비가 통째로 이 값에서 온다(저장된 노트별 색은 설정이 아니라
  // 노트 메타라 여기 근거가 없다: 창이 자기 override를 새 능력으로 다시 해석한다).
  if (!sameJson(prevSnapshot.background, nextSnapshot.background)) {
    steps.push("background");
  }
  if (changedKeys.includes("defaults.font_size")) steps.push("font_size");
  // 능력(스냅샷)이든 저장값(설정)이든 한쪽만 바뀌어도 실효 글꼴이 달라질 수 있다 — 단계는
  // 하나이고, 적용부가 언제나 둘을 함께 다시 해석한다.
  if (
    !sameJson(prevSnapshot.font, nextSnapshot.font) ||
    changedKeys.includes("defaults.font_family")
  ) {
    steps.push("font_family");
  }
  // 창 컨트롤 능력 — 집합 비교다(순서는 의미가 없다: 병합 결과의 원소가 곧 가용 컨트롤이다).
  if (!sameNameSet(prevSnapshot.windowControls, nextSnapshot.windowControls)) {
    steps.push("window_controls");
  }
  if (changedKeys.includes("keybindings")) steps.push("keymap");
  // 플러그인 설정이 바뀐 재빌드는 그 플러그인이 등록한 디스크립터가 바뀌었을 수 있는데,
  // 값에 따라서는 스냅샷 비교로 안 잡히는 부분(패턴 내부의 색 등은 잡히지만, 확장이 설정을
  // 런타임에 읽는 형태면 안 잡힌다)이 있다 — 그 사유면 무조건 다시 만든다(싸다: dispatch 한 번).
  if (extensionsDirty || input.reasons.includes("plugin-setting")) {
    steps.push("extensions");
  }
  // 툴바 항목(버튼·상태 아이템·명령·메뉴 항목)은 빌트인 능력 단계 뒤·이벤트 재배선 앞에서
  // 맞춘다: 앞선 단계가 툴바 DOM에서 내장 컨트롤을 넣고 빼므로, 플러그인 항목의 삽입 자리가
  // 그 결과 위에서 정해져야 한 프레임 어긋난 순서가 보이지 않는다.
  if (toolbarItemsDirty) steps.push("toolbar_items");
  if (youtubeEmbedRunning(prevSnapshot) !== youtubeEmbedRunning(nextSnapshot)) {
    steps.push("youtubeEmbed");
  }
  // 이벤트는 **언제나** 다시 잇는다: 재빌드는 모든 샌드박스를 dispose·재실행하므로 구독 집합이
  // 그대로여도 저쪽 인스턴스는 전부 새것이다. 예전 발신기를 그대로 두면 이 창은 살아 있는데
  // 플러그인 입장에서는 "열린 적 없는 노트"가 된다(`note:opened`를 못 받는다).
  steps.push("events");
  return { action: "reconcile", steps };
}

/**
 * [`planLateSnapshot`]이 낼 수 있는 단계 — 마운트 낙관값이 있는 표면(테마·배경·폰트·창
 * 컨트롤)뿐이다.
 */
type LateSnapshotStep = Extract<
  ReconcileStep,
  "theme" | "background" | "font_family" | "window_controls"
>;

/**
 * [`planLateSnapshot`]의 입력 — 마운트 낙관값과 뒤늦게 도착한 실제 스냅샷의 짝.
 * export하지 않는다(호출부는 구조적으로 검사되므로 이름이 필요 없다 — knip 미사용 export
 * 방지, `note-local-apply.ts`의 `LocalApplySettings`와 같은 관례).
 */
interface LateSnapshotInput {
  /** 마운트가 즉시 그린 낙관적 테마 — 스냅샷이 늦으면 언제나 `SJ_D`(`bootstrap/note.ts`). */
  mountedTheme: ThemeDescriptor;
  /**
   * 마운트가 즉시 그린 낙관적 배경 능력 — `bootstrap/note.ts`가 마운트 시 쓰는 값
   * (`early?.background ?? null`)을 그대로 넘긴다. 스냅샷이 늦으면 언제나 `null`.
   */
  mountedBackground: BackgroundDescriptor | null;
  /** 마운트가 즉시 그린 낙관적 폰트 능력 — 스냅샷이 늦으면 언제나 `null`(능력 없음 취급). */
  mountedFont: FontDescriptor | null;
  /**
   * 마운트가 즉시 그린 낙관적 창 컨트롤 집합 — `bootstrap/note.ts`가 마운트 시 쓰는 값
   * (`early?.windowControls ?? []`)을 그대로 넘긴다. 스냅샷이 늦으면 언제나 빈 배열.
   */
  mountedWindowControls: readonly string[];
  /** `THEME_WAIT_MS` 상한을 넘겨 뒤늦게 도착한 실제 스냅샷. */
  snapshot: HostSnapshot;
}

/**
 * `THEME_WAIT_MS` 상한을 넘겨 늦게 온 첫 스냅샷을, 마운트가 그렸던 낙관값과 견줘 무엇을
 * 교정해야 하는지 고른다(`bootstrap/note.ts`의 `installPlugins` 콜백 전용 — `planHostUpdate`
 * 와는 쓰임이 다르다).
 *
 * `planHostUpdate`(재빌드 판정)와 다른 점: 여기 입력은 스냅샷 하나뿐이고, "무엇이 바뀌었는가"
 * 가 아니라 "낙관값이 실제와 다른가"만 본다 — 리로드 분기가 없다. 이미 그려져 열려 있는
 * 창을 깜빡이지 않고 조용히 맞추는 것이 이 경로의 취지이기 때문이다(모르면 리로드가 아니라
 * "낙관값이 곧 최선이었다"는 원래 설계 — 실제 스냅샷이 왔으니 그 낙관값을 버릴 근거가 생긴
 * 표면만 다룬다). 결과는 선언 순서([`ReconcileStep`])대로 나며, 그대로
 * [`applyReconcileSteps`]에 넘길 수 있다.
 *
 * 창 컨트롤은 집합 비교다(`sameNameSet`) — `planHostUpdate`의 `window_controls` 단계와 같은
 * 이유로 순서는 의미가 없다(병합 결과의 원소가 곧 가용 컨트롤이다).
 */
export function planLateSnapshot(input: LateSnapshotInput): LateSnapshotStep[] {
  const steps: LateSnapshotStep[] = [];
  if (!sameJson(input.mountedTheme, input.snapshot.theme)) {
    steps.push("theme");
  }
  if (!sameJson(input.mountedBackground, input.snapshot.background)) {
    steps.push("background");
  }
  if (!sameJson(input.mountedFont ?? null, input.snapshot.font ?? null)) {
    steps.push("font_family");
  }
  if (
    !sameNameSet(input.mountedWindowControls, input.snapshot.windowControls)
  ) {
    steps.push("window_controls");
  }
  return steps;
}

/**
 * 조정 단계를 실제로 수행할 대상 — 노트 창 배선(`bootstrap/note.ts`)이 구조적으로 만족한다.
 *
 * 왜 인터페이스로 받나: 단계 이름 → 어떤 재적용 API를 부르는가라는 **배선 자체**를 DOM·IPC
 * 없이 검증하기 위해서다(`note-local-apply.ts`의 적용기 맵과 같은 결). 여기서 이름을 하나
 * 잘못 잇는 실수는 화면이 조용히 낡는 종류의 실패라, 테스트가 닿는 자리에 두는 값이 크다.
 */
export interface ReconcileTarget {
  /** 활성 테마 자체를 갈아 끼우고 그 위에 색 오버라이드를 다시 얹는다. */
  applyTheme(theme: ThemeDescriptor, overrides: Record<string, string>): void;
  /** 활성 테마 위의 사용자 색 오버라이드를 다시 적용한다. */
  applyThemeOverrides(overrides: Record<string, string>): void;
  /**
   * 배경 능력(스와치·자동 대비)을 다시 해석한다 — 노트 배경색·대비·툴바의 배경색 항목이
   * 함께 따라온다(능력이 없으면 고정 기본 배경).
   */
  applyBackgroundCapability(background: BackgroundDescriptor | null): void;
  /** 전역 기본 글자 크기(px)를 다시 적용한다(이 메모의 델타는 유지). */
  applyBaseFontPx(px: number): void;
  /** 폰트 능력과 저장된 스택을 함께 다시 해석해 에디터에 적용한다(능력이 없으면 시스템 기본). */
  applyFontCapability(font: FontDescriptor | null, saved: string | null): void;
  /**
   * 가용한 창 컨트롤 집합을 다시 적용한다 — 꺼진 기능은 네이티브를 기본값으로 되돌리고,
   * 켜진 기능은 이 메모의 저장값을 네이티브·툴바에 함께 복원한다.
   */
  applyWindowControls(controls: readonly string[]): void;
  /** 창 단위 도구 단축키 맵을 통째로 교체한다(옛 바인딩은 남지 않는다). */
  applyKeybindings(bindings: Record<string, string>): void;
  /** CM 확장 + 선택 액션 + 플러그인 인라인 CSS를 새 스냅샷으로 다시 만든다. */
  applyExtensions(snapshot: HostSnapshot): void;
  /**
   * 플러그인 툴바 버튼·상태 아이템·명령·메뉴 항목을 새 스냅샷으로 제자리 조정한다.
   *
   * 스냅샷을 그대로 넘기는 이유: 항목으로 평탄화하는 `snapshotToolbarButtons`는 창 라벨과
   * 이벤트 버스를 필요로 하는데(클릭을 호스트로 되돌리는 배선), 둘 다 이 순수 모듈에 없다.
   * 평탄화는 배선(`bootstrap/note.ts`)이 마운트 때와 **같은 함수로** 하고, 여기서는 "언제"
   * 만 정한다.
   */
  reconcileToolbarItems(snapshot: HostSnapshot): void;
  /** 컨텍스트 메뉴의 "유튜브 추가" 항목을 켜고 끈다. */
  applyYoutubeEmbedEnabled(enabled: boolean): void;
  /** 생명주기 이벤트 발신기를 새 스냅샷으로 갈아 끼우고 `note:opened`를 다시 쏜다. */
  rewireEvents(snapshot: HostSnapshot): void;
}

/**
 * [`planHostUpdate`]가 낸 단계를 순서대로 수행한다 — 순수 배선(값 해석은 전부 기존 규칙 재사용).
 *
 * 값을 이벤트가 아니라 **재조회한 최신 상태**에서 뽑는 것도 국소 반영과 같은 규칙이다:
 * 마운트 경로(`bootstrap/note.ts`)와 같은 함수(`activeThemeOverrides`·`defaultFontPx`)를 써야
 * 새로 연 창과 열려 있던 창이 갈리지 않는다.
 */
export function applyReconcileSteps(
  steps: readonly ReconcileStep[],
  next: { settings: DiffableSettings; snapshot: HostSnapshot },
  target: ReconcileTarget,
): void {
  for (const step of steps) {
    switch (step) {
      case "theme":
        target.applyTheme(
          next.snapshot.theme,
          activeThemeOverrides(next.settings),
        );
        break;
      case "theme_overrides":
        target.applyThemeOverrides(activeThemeOverrides(next.settings));
        break;
      case "background":
        target.applyBackgroundCapability(next.snapshot.background);
        break;
      case "font_size":
        target.applyBaseFontPx(defaultFontPx(next.settings));
        break;
      case "font_family":
        target.applyFontCapability(
          next.snapshot.font,
          savedFontFamily(next.settings),
        );
        break;
      case "window_controls":
        target.applyWindowControls(next.snapshot.windowControls);
        break;
      case "keymap":
        target.applyKeybindings(
          effectiveKeybindings(next.settings.keybindings),
        );
        break;
      case "extensions":
        target.applyExtensions(next.snapshot);
        break;
      case "toolbar_items":
        target.reconcileToolbarItems(next.snapshot);
        break;
      case "youtubeEmbed":
        target.applyYoutubeEmbedEnabled(youtubeEmbedRunning(next.snapshot));
        break;
      case "events":
        target.rewireEvents(next.snapshot);
        break;
    }
  }
}
