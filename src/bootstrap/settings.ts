/**
 * 설정·플러그인 매니저 창(`?settings`) 부트스트랩 — 트레이 "설정"으로 열린 창.
 *
 * `main.ts`가 동적 `import()`로만 이 모듈을 로드한다(이슈 #26) — `mountSettings`(5000줄대)는
 * 이 창에서만 필요하고, 노트·패널·플러그인호스트 창은 이 청크를 내려받지 않는다.
 *
 * 왜 `debounce`를 여기서 새로 정의하는가: 같은 이름의 유틸이 `note/note-window.ts`에도
 * 있지만, 그 파일은 CodeMirror 기반 에디터(`mountNoteWindow`)를 정적으로 묶고 있다. 거기서
 * `debounce`만 import해도 번들러가 모듈 전체(에디터 포함)를 이 설정 청크에 함께 실어 보낸다
 * — 그러니 트레일링 디바운스만 필요한 이 창은 최소 구현을 자체로 둔다(동작은 동일: 마지막
 * 호출만 `ms` 뒤 실행).
 */
import { mountSettings } from "../settings/settings";
import { activeLocale } from "../i18n/store";
import { bundledPackMetas } from "../i18n/packs";
import { fetchHostSnapshot } from "../plugin/host-client";
import {
  EV_BUTTON_INVOKE,
  EV_HOST_PLUGIN_UPDATED,
  EV_HOST_UPDATED,
  EV_NOTE_RESTORED,
  EV_PLUGIN_SETTING_CHANGED,
  EV_SETTINGS_CHANGED_LOCAL,
  type RebuildReason,
} from "../plugin/host-protocol";
import { resolveInstalledPluginNls } from "../plugin/manifest";
import { fetchPluginDiagnostics } from "../plugin/diagnostics";
import { hasBackgroundPicker } from "../theme/background";
import {
  pluginCommandActionId,
  pluginSelectionActionId,
} from "../shortcuts/actions";
import {
  cancelPluginInstall,
  confirmPluginInstall,
  dismissMissingPlugin,
  emitAppEvent,
  emitNotesReload,
  ensurePluginHost,
  fetchPluginForInstall,
  fileAssetUrl,
  getAppVersion,
  getPluginsDir,
  pickPluginDir,
  getGlobalHotkey,
  getPlatform,
  getSharedSettings,
  getStartupNoActiveAction,
  listBuiltinSettings,
  listBuiltinStates,
  listInstalledPlugins,
  listMissingPlugins,
  listRejectedPlugins,
  noteList,
  noteListSnapshots,
  noteListSnapshotNoteIds,
  noteReadSnapshot,
  noteRestoreSnapshot,
  openExternalUrl,
  readPluginReadme,
  removePlugin,
  saveSharedSettings,
  setBuiltinEnabled,
  setBuiltinSetting,
  setDevPlugin,
  setGlobalHotkey,
  setPluginEnabled,
  setPluginGranted,
  setPluginPendingReserved,
  setPluginSetting,
  setStartupNoActiveAction,
} from "../shared/tauri";
import { diffSettingsKeys, isLocalOnlyChange } from "./settings-diff";
import { ensureGuideNote, showGuideNote, tauriGuideNoteIO } from "./guide-note";
import { tauriBus } from "./shared";

/** 디바운스 핸들 — 대기 중인 타이머를 실행 없이 취소할 수 있다(`flushNotesReload`가 사용). */
interface Debounced {
  (): void;
  /** 대기 중인 타이머가 있으면 취소한다(없으면 아무 일도 하지 않는다). fn은 실행하지 않는다. */
  cancel(): void;
}

/** 마지막 호출만 `ms` 뒤 실행되도록 디바운스한다(잦은 저장 신호를 합친다). */
function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  }) as Debounced;
  debounced.cancel = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

/**
 * 공유 설정의 저장 형태 — `shared/tauri.ts`가 그 타입을 export하지 않으므로 시그니처에서 뽑는다
 * (설정 화면의 `SettingsShape`도 구조적으로 이 형태에 대입된다).
 */
type SharedSettingsValue = Parameters<typeof saveSharedSettings>[0];

/**
 * 번들 플러그인 토글의 재빌드 사유 — **언어팩이면 `"locale"`**, 그 외는 `"plugins"`.
 *
 * 왜 갈라야 하는가: 번들 언어팩은 중앙 호스트가 실행하지 않아 스냅샷에 아무 흔적도 남기지
 * 않는다(`i18n/packs.ts`). 그래서 팩을 켜고 꺼도 재빌드 전후 스냅샷이 **완전히 같고**, 노트
 * 창은 비교만으로는 언어가 바뀐 사실을 알 방법이 없다 — 사유가 `"plugins"`로 나가면 창이
 * "바뀐 게 없네"라며 제자리 조정으로 넘어가 옛 언어 그대로 남는다. 설치(커뮤니티) 언어팩은
 * 설정 화면이 `flushNotesReload`를 태우므로 그쪽에서 같은 사유가 붙는다.
 *
 * 판정 근거는 번들 팩 목록(`bundledPackMetas`, 글로브 키만 보는 동기 함수 — 사전 청크를
 * 받지 않는다)이다. 문자열 접두 규칙을 여기서 다시 쓰지 않는다(정본은 그 모듈 하나).
 */
function builtinReason(id: string): RebuildReason {
  return bundledPackMetas().some((m) => m.id === id) ? "locale" : "plugins";
}

/** 설정·플러그인 매니저 창을 마운트한다(트레이 "설정"으로 열린 창). */
export async function bootstrapSettings(host: HTMLElement): Promise<void> {
  host.classList.add("settings-root");
  const bus = tauriBus();
  // 설치 플러그인 루트 경로를 한 번 받아, README 로컬 이미지를 asset URL로 만드는 데 쓴다(실패 시 미해석).
  const pluginsDir = await getPluginsDir().catch(() => null);
  // 변경 성공 시 변경 신호를 방송한다 → 중앙 호스트가 재빌드 후 노트 창들에 갱신을
  // 알린다(테마·플러그인 즉시 반영). 텍스트 설정의 매-입력 저장이 매번 재빌드하지 않도록
  // 디바운스하고, 반환값은 보존한다(설치 UI가 id 사용).
  /**
   * 아직 발신되지 않은 재빌드 사유의 합집합(400ms 디바운스 창 안에서 쌓인다).
   *
   * 왜 모으나: 디바운스는 여러 요청을 방송 **한 번**으로 합친다 — 사유도 함께 합치지 않으면
   * 마지막 요청의 사유만 남아, 그 사이에 있던 리로드가 필요한 변경(언어팩 토글 등)이
   * 조용히 조정 경로로 새어 반영되지 않는다.
   */
  const pendingReasons = new Set<RebuildReason>();
  /** 쌓인 사유를 통째로 실어 보낸다(비어 있으면 `unknown` — 모르면 리로드). */
  const emitPendingReload = (): Promise<void> => {
    const reasons: RebuildReason[] =
      pendingReasons.size > 0 ? [...pendingReasons] : ["unknown"];
    pendingReasons.clear();
    return emitNotesReload(reasons);
  };
  const scheduleReload = debounce(() => void emitPendingReload(), 400);
  const reloadAfter = <T>(p: Promise<T>, reason: RebuildReason): Promise<T> =>
    p.then((v) => {
      pendingReasons.add(reason);
      scheduleReload();
      return v;
    });
  /**
   * 대기 중인 400ms 디바운스 타이머를 취소하고 notes-reload를 즉시 emit해, 그 완료를
   * 기다릴 수 있게 Promise로 돌려준다.
   *
   * 왜 필요한가: 언어 변경·언어팩 설치/토글/제거는 저장 직후 **이 설정 창 자신도**
   * `window.location.reload()`한다. 그런데 scheduleReload는 400ms 뒤에야 실제 emit이 도는
   * 트레일링 디바운스라, self-reload가 그 400ms보다 먼저 이 창의 JS 런타임(과 타이머)을
   * 파기하면 notes-reload가 영영 나가지 않는다 — 다른 노트·패널 창은 재빌드 신호를 못 받아
   * 예전 언어로 남는다(경합). self-reload 전에 반드시 이 함수를 기다려야 한다. cancel()로
   * 타이머만 지우고 발신은 새로 부른다 — 타이머의 fn을 그대로 실행하면 `void`로 결과를 버려
   * 완료를 기다릴 Promise를 못 돌려받는다.
   *
   * **사유에 언제나 `"locale"`을 더한다.** 이 함수의 호출 지점은 전부 언어가 실제로 바뀌는
   * 자리다(언어 드롭다운 저장, 언어팩 설치·활성 토글·제거 — `settings/settings.ts`의
   * `reloadForLanguagePack`). 언어팩은 중앙 호스트를 거치지 않아 스냅샷에 아무 흔적도 남기지
   * 않으므로(`HostSnapshot` 참고), 노트 창이 "언어가 바뀌었다"를 알 수 있는 근거는 이 사유
   * 하나뿐이다 — 빠지면 창들이 옛 언어 그대로 남는다(`i18n/packs.ts`의 "왜 팩 토글이 여전히
   * 재빌드를 태우는가" 절이 지키라고 못박은 바로 그 고리다).
   */
  const flushNotesReload = (): Promise<void> => {
    scheduleReload.cancel();
    pendingReasons.add("locale");
    return emitPendingReload();
  };
  /**
   * 마지막으로 확정된 공유 설정 스냅샷 — 다음 저장이 "무엇이 바뀌었는지" 알아내는 기준이다.
   * 마운트가 처음 읽은 값으로 시드하고(`getSettings` 래퍼), 저장이 성공할 때마다 앞으로
   * 감는다. `null`이면 기준이 없다는 뜻이고 그때의 저장은 무조건 기존 리로드 경로로 간다 —
   * 모르면 무거운 쪽이 안전하다.
   */
  let lastSettings: SharedSettingsValue | null = null;
  /** 아직 발신되지 않은 국소 변경 키의 합집합(디바운스 창 안에서 쌓인다). */
  const pendingLocalKeys = new Set<string>();
  /**
   * 국소 변경 통지 — reload(400ms)와 **별도 인스턴스**의 짧은 디바운스다. 색 편집기처럼
   * 드래그 중 연속 저장하는 표면이 있어 합치긴 해야 하지만, 이 경로는 반영이 눈에 바로
   * 보이므로 400ms는 "색이 늦게 따라온다"로 체감된다. 쌓인 키는 합집합으로 한 번에 보낸다.
   */
  const emitLocalChange = debounce(() => {
    const changedKeys = [...pendingLocalKeys];
    pendingLocalKeys.clear();
    if (changedKeys.length === 0) return;
    void emitAppEvent(EV_SETTINGS_CHANGED_LOCAL, { changedKeys });
  }, 100);
  /**
   * 저장을 무엇이 바뀌었는지에 따라 세 갈래로 나눈다(이슈: 값 하나 바꿀 때마다 모든 창 깜빡임).
   *
   * 1. **변경 없음** — 저장만 하고 아무 신호도 내지 않는다(같은 값 재저장·왕복 정규화).
   * 2. **전부 국소 반영 가능** — 저장이 성공한 뒤 [`EV_SETTINGS_CHANGED_LOCAL`]만 낸다.
   *    호스트 재빌드도, 노트 창 리로드도 일어나지 않는다.
   * 3. **하나라도 화이트리스트 밖** — 예전 그대로 `scheduleReload()`(400ms 디바운스 →
   *    재빌드 → 전체 리로드). 이때 대기 중이던 국소 통지는 **버린다**: 리로드가 최종 상태를
   *    전부 담으므로 같은 변경이 두 경로로 두 번 반영될 이유가 없다.
   *
   * 저장이 실패하면 디스크는 그대로이므로 diff 기준도 이전 값으로 되돌린다 — 그러지 않으면
   * 다음 저장의 diff가 "저장되지 않은 값"을 기준으로 계산돼 실제 변경을 놓친다.
   */
  const routeSaveSettings = (next: SharedSettingsValue): Promise<void> => {
    const prev = lastSettings;
    lastSettings = next;
    // 이 호출 이후 더 최근 저장이 성공해 lastSettings를 앞으로 감았다면(=lastSettings가
    // 이미 next가 아니라면) 그쪽이 디스크의 실제 최신 상태이므로 되돌리지 않는다 — 무조건
    // prev로 롤백하면 나중에 성공한 저장의 스냅샷을 뒤처진 기준으로 덮어써 버린다.
    const restore = (err: unknown): never => {
      if (lastSettings === next) lastSettings = prev;
      throw err;
    };
    const changed = prev ? diffSettingsKeys(prev, next) : null;
    if (changed && changed.length === 0) {
      return saveSharedSettings(next).catch(restore);
    }
    if (changed && isLocalOnlyChange(changed)) {
      return saveSharedSettings(next).then(() => {
        for (const key of changed) pendingLocalKeys.add(key);
        emitLocalChange();
      }, restore);
    }
    emitLocalChange.cancel();
    pendingLocalKeys.clear();
    // 사유를 고른다: `language`가 바뀐 저장은 언어 변경이다(`locale` — 언제나 리로드). 기준
    // 스냅샷이 없어 무엇이 바뀌었는지 모르는 저장(changed=null, 최초 조회 실패)은 `unknown`으로
    // 보낸다 — 그 안에 언어가 섞여 있어도 안전한 쪽(리로드)으로 떨어진다.
    const reason: RebuildReason = !changed
      ? "unknown"
      : changed.includes("language")
        ? "locale"
        : "settings";
    return reloadAfter(saveSharedSettings(next), reason).catch(restore);
  };
  /**
   * 설정 값 1건이 저장되면 재빌드 신호와 **별개로** 즉시 통지한다.
   *
   * 왜 두 신호인가: `notes-reload`는 400ms 디바운스되고 무엇이 바뀌었는지도 싣지 않는다.
   * 이 통지는 바뀐 키·값을 즉시 실어, 아직 살아 있는 샌드박스가 `settings:changed`를 받고
   * 정리할 시간을 준다(그 뒤 재빌드가 예전과 똑같이 일어난다 — 동작은 안 바꾼다).
   */
  const notifySettingChanged = <T>(
    pluginId: string,
    key: string,
    value: unknown,
    p: Promise<T>,
  ): Promise<T> =>
    reloadAfter(p, "plugin-setting").then((v) => {
      void emitAppEvent(EV_PLUGIN_SETTING_CHANGED, { pluginId, key, value });
      return v;
    });
  await mountSettings(host, {
    // 마운트가 읽는 이 최초 값이 곧 diff의 출발점이다(이 창의 저장은 전부 여기서 파생된다).
    // 이후 호출이 있어도 기준을 덮지 않는다 — 저장 성공만이 기준을 앞으로 감는다.
    getSettings: () =>
      getSharedSettings().then((s) => {
        lastSettings ??= s;
        return s;
      }),
    // 활성 테마 크롬 토큰: 노트 창과 같은 중앙 호스트 스냅샷에서 읽고(D6), 호스트 재빌드
    // 완료 신호(테마 변경 반영)를 그대로 라이브 갱신 트리거로 쓴다.
    activeTheme: async () =>
      (await fetchHostSnapshot({ bus, hostAlive: ensurePluginHost }))?.theme ??
      null,
    // 이번 빌드에서 로드에 실패한 플러그인들(사유 포함) — 설정 매니저가 "왜 안 뜨는지"를
    // 표시한다. 호스트 부재·스냅샷 미도착이면 빈 목록(실패 없음과 같게 취급 — 설정 창이
    // 호스트 이상 때문에 못 뜨는 일은 없어야 한다).
    pluginFailures: async () =>
      (await fetchHostSnapshot({ bus, hostAlive: ensurePluginHost }))
        ?.failures ?? [],
    // 런타임 진단(거부된 호출·무력화된 창-스코프 호출·설정 저장 실패·runtime.log) — 스냅샷과
    // 달리 빌드와 무관하게 계속 자라므로 별도 채널로 읽는다.
    pluginDiagnostics: () => fetchPluginDiagnostics({ bus }),
    // 활성 폰트 능력(「폰트」 플러그인 목록): 테마와 같은 중앙 호스트 스냅샷에서 읽는다(off면 null).
    activeFont: async () =>
      (await fetchHostSnapshot({ bus, hostAlive: ensurePluginHost }))?.font ??
      null,
    // 단축키 바인딩 후보: 활성 플러그인 툴바 버튼을 중앙 호스트 스냅샷에서 평탄화한다
    // (id=`plugin:<pluginId>:<buttonId>` — 노트 창 data-action과 동일 규칙).
    activeToolbarButtons: async () => {
      const snap = await fetchHostSnapshot({
        bus,
        hostAlive: ensurePluginHost,
      });
      if (!snap) return [];
      return snap.plugins.flatMap((p) => [
        ...p.buttons.map((b) => ({
          id: `plugin:${p.pluginId}:${b.id}`,
          // 설명 레이블(title) 우선 — 글리프("📄"·"⧉")보다 읽기 쉽다. 없으면 글리프로 폴백.
          label: b.title || b.label,
        })),
        // 버튼 없는 명령도 **같은 자리**에 합류한다 — 단축키 배정 화면이 명령의 유일한
        // 노출 지점이라, 여기서 빠지면 등록은 되는데 사용자가 걸 방법이 없다. 배치 편집기
        // (toolbarButtonItems)에는 일부러 넣지 않는다: 명령은 툴바에 자리가 없다.
        ...(p.commands ?? []).map((c) => ({
          id: pluginCommandActionId(p.pluginId, c.id),
          label: c.title,
        })),
        // 선택 액션도 **같은 자리**에 합류한다 — 선택 툴바는 마우스 드래그 뒤에만 뜨고
        // `match`가 맞을 때만 버튼을 그리므로, 키보드로 쓰려는 사용자에게는 이 화면이 유일한
        // 노출 지점이다(명령과 같은 이유). 배치 편집기(toolbarButtonItems)에는 넣지 않는다:
        // 선택 액션은 툴바에 상주하지 않아 옮기거나 숨길 자리가 없다.
        ...(p.selectionActions ?? []).map((a) => ({
          id: pluginSelectionActionId(p.pluginId, a.id),
          // 설명 레이블(title) 우선 — 글리프("=")보다 읽기 쉽다(버튼과 같은 규칙).
          label: a.title || a.label,
        })),
      ]);
    },
    // 배치 편집기 팔레트: 활성 플러그인 버튼을 글리프(label)·이름(title)과 함께 스냅샷에서 평탄화한다.
    toolbarButtonItems: async () => {
      const snap = await fetchHostSnapshot({
        bus,
        hostAlive: ensurePluginHost,
      });
      if (!snap) return [];
      return snap.plugins.flatMap((p) => [
        ...p.buttons.map((b) => ({
          key: `plugin:${p.pluginId}:${b.id}`,
          glyph: b.label,
          name: b.title || b.label,
          // 자동 배치 존(설치 직후 폴백 자리) — 편집기 목업이 노트 실물과 같아지게 한다.
          position: b.position,
        })),
        // 상태 표시형 아이템도 버튼과 **같은 팔레트**에 넣는다 — 사용자가 배치 편집기에서
        // 버튼과 동급으로 옮길 수 있어야 하기 때문이다(사용자 확정). 글리프는 등록 시점의 초기
        // 텍스트다(라이브 값은 노트 창에서만 갱신되고, 팔레트는 대표 표시만 하면 된다). 키에
        // `status:`를 접두한다 — 노트 창의 `reconcileToolbarItems`/`toolbar_layout`이 같은
        // id의 버튼과 상태 아이템을 구분하는 것과 **같은 규약**이라야, 이 편집기에서 옮긴
        // 자리가 노트 창의 실제 렌더 키와 어긋나지 않는다(host-client.ts의
        // `snapshotToolbarButtons` 참고).
        ...(p.statusItems ?? []).map((s) => ({
          key: `plugin:${p.pluginId}:status:${s.id}`,
          glyph: s.text,
          name: s.title || s.text || s.id,
          position: s.position,
        })),
      ]);
    },
    // 내장 컨트롤 가용 판정 근거 — 노트 창이 `windowControls`·배경 스와치로 컨트롤을 만들거나
    // 마는 것과 **같은 값**을 배치 편집기에도 준다. 스냅샷이 없으면 null(모름) — 편집기가
    // 팔레트를 거르지도, 배치를 정리하지도 않는다(호스트가 잠깐 죽은 사이의 오정리 방지).
    toolbarCapabilities: async () => {
      const snap = await fetchHostSnapshot({
        bus,
        hostAlive: ensurePluginHost,
      });
      if (!snap) return null;
      return {
        windowControls: snap.windowControls,
        hasBackground: hasBackgroundPicker(snap.background?.swatches ?? []),
      };
    },
    getGlobalHotkey: () => getGlobalHotkey(),
    setGlobalHotkey: (accel) => setGlobalHotkey(accel),
    // 「시작」 탭 — 활성 노트 0개로 실행됐을 때 무엇을 띄울지(기기 고유 LocalConfig). 재빌드
    // 신호(reloadAfter)를 안 태운다: 다음 실행에만 영향을 주는 값이라 다른 창을 다시 그릴
    // 이유가 없다(단축키 저장과 같은 원칙).
    getStartupNoActiveAction: () => getStartupNoActiveAction(),
    setStartupNoActiveAction: (action) => setStartupNoActiveAction(action),
    // 「도움말」 탭 — 시작 가이드 메모를 다시 연다(있으면 소환, 지웠으면 새로 만든다).
    // 실패는 삼키지 않는다: 설정 화면이 상태 줄로 알린다(`showGuideNote` 문서 참고).
    openGuideNote: () => showGuideNote(tauriGuideNoteIO()),
    platform: () => getPlatform().catch(() => ""),
    // README 로컬 이미지: 플러그인 폴더의 파일만 asset URL로 해석한다(경로 안전성은 readme.ts가 검사).
    pluginAssetUrl: (id, relPath) =>
      pluginsDir ? fileAssetUrl(`${pluginsDir}/${id}/${relPath}`) : null,
    // 폴더 설치: OS 폴더 선택기로 경로를 받는다(취소·실패면 null → 설치 안 함).
    pickPluginDir: () => pickPluginDir().catch(() => null),
    // 개발자 모드 — 재빌드 신호(reloadAfter)를 안 태운다: 감시 시작 자체는 아무 소스도
    // 안 바꾸므로 다른 창을 다시 그릴 이유가 없다(단일 핫리로드는 Rust 감시자가 소스 변경을
    // 볼 때만 EV_PLUGIN_DEV_RELOAD로 따로 방송한다, central-host.ts 참고).
    setDevPlugin: (id) => setDevPlugin(id),
    // 「메모 복구」 페이지(스냅샷 목록·미리보기·복원) — 웨이브 E 백엔드(trash.rs)의 사용자 표면.
    // restoreSnapshot은 백엔드가 복원 직전 현재 본문을 다시 스냅샷하므로 복원도 되돌릴 수 있다.
    // reloadAfter(테마·플러그인 재빌드 신호)로 감싸지 않는다: 스냅샷 조회·복원은 어떤 소스도
    // 바꾸지 않아 다른 창을 다시 그릴 이유가 없다(플러그인 토글·설치와 달리).
    listNotes: () => noteList(),
    listSnapshotNoteIds: () => noteListSnapshotNoteIds(),
    listSnapshots: (id) => noteListSnapshots(id),
    readSnapshot: (id, snapshotId) => noteReadSnapshot(id, snapshotId),
    // 복원 성공 후 그 노트의 열린 창에 EV_NOTE_RESTORED를 방송한다(finding 4) — 낡은 에디터
    // 버퍼가 다음 자동저장에서 복원 내용을 조용히 덮지 않게 그 창이 디스크를 다시 읽게 한다.
    restoreSnapshot: (noteId, snapshotId) =>
      noteRestoreSnapshot(noteId, snapshotId).then(() => {
        void emitAppEvent(EV_NOTE_RESTORED, { id: noteId });
      }),
    // 이 창 자신의 크롬 토큰(활성 테마 + 색 오버라이드) 갱신 트리거. 호스트 재빌드 신호에
    // 더해 국소 변경 통지도 **같은 콜백**으로 흘려보낸다 — 색 오버라이드만 바뀐 저장은
    // 이제 재빌드를 일으키지 않으므로, 이 채널이 없으면 정작 설정 창 자신만 옛 색으로 남는다.
    //
    // EV_HOST_PLUGIN_UPDATED(dev 단일 핫리로드)도 같은 콜백으로 흘려보낸다 — canPartial
    // 완화(central-host.ts) 이후 버튼·상태 아이템만 바뀐 재실행은 EV_HOST_UPDATED 없이 이
    // 이벤트만 나간다. 이 채널이 없으면 「단축키」·「툴바 배치」 페이지(refreshShortcuts·
    // refreshUiLayout, settings.ts의 afterChromeTokens)가 낡은 목록으로 남는다 —
    // applyChromeTokens가 한 번 더(불필요하게) 도는 비용은 무시할 만하다.
    onThemeUpdated: (handler) => {
      bus.listen(EV_HOST_UPDATED, handler);
      bus.listen(EV_SETTINGS_CHANGED_LOCAL, handler);
      bus.listen(EV_HOST_PLUGIN_UPDATED, handler);
    },
    // locale(축 2, 선택) — 없으면 백엔드가 항상 기본 README.md를 준다(기존 동작).
    readPluginReadme: (id, locale) => readPluginReadme(id, locale),
    openExternal: (url) => openExternalUrl(url),
    saveSettings: (settings) => routeSaveSettings(settings),
    flushNotesReload: () => flushNotesReload(),
    // 축 2(플러그인 자기 로컬라이즈) — 백엔드는 매니페스트 `nls`를 해석하지 않고 원문 그대로
    // 나른다(창마다 활성 로케일이 달라 미리 구울 수 없다). **파싱 직후 한 번**(이 fetch가 유일한
    // 진입점 — settings.ts의 여러 소비 지점이 전부 이 배열을 공유한다) `resolveInstalledPluginNls`로
    // `%키%`를 해석해 내려보낸다 — 이 창은 이미 부트스트랩에서 `setActiveLocale()`을 마친
    // 뒤라(§i18n 규약) `activeLocale()`이 안정적이다.
    listPlugins: () =>
      listInstalledPlugins().then((plugins) =>
        plugins.map((p) => resolveInstalledPluginNls(p, activeLocale())),
      ),
    setEnabled: (id, enabled) =>
      reloadAfter(setPluginEnabled(id, enabled), "plugins"),
    setGranted: (id, granted) =>
      reloadAfter(setPluginGranted(id, granted), "plugins"),
    setSetting: (id, key, value) =>
      notifySettingChanged(id, key, value, setPluginSetting(id, key, value)),
    removePlugin: (id) => reloadAfter(removePlugin(id), "plugins"),
    fetchInstall: (spec) => fetchPluginForInstall(spec),
    confirmInstall: (staging, granted) =>
      reloadAfter(confirmPluginInstall(staging, granted), "plugins"),
    cancelInstall: (staging) => cancelPluginInstall(staging),
    listMissing: () => listMissingPlugins(),
    dismissMissing: (id) => dismissMissingPlugin(id),
    // 스캔에서 탈락한 폴더 — "설치했는데 목록에 안 뜬다"의 사유를 보여 준다. 조회
    // 실패는 안내를 숨길 뿐 설정 창을 막지 않는다(재조정 배너와 같은 비차단 원칙).
    listRejected: () => listRejectedPlugins().catch(() => []),
    // 예약(미구현)이라 아직 부여하지 못한 민감 권한 기록 — 예약이 풀렸을 때 재승인
    // 안내를 띄울 수 있는 유일한 근거다. 저장은 reloadAfter로 감싸지 않는다: 부여가 아직
    // 바뀌지 않았으므로 호스트를 재빌드할 이유가 없다(승인 시점에 setGranted가 재빌드한다).
    setPendingReserved: (id, pending) => setPluginPendingReserved(id, pending),
    // 매니페스트 `minHostVersion` 경고의 기준. 읽지 못하면 빈 문자열 → 비교 불가 →
    // 경고 없음(버전을 모르면 정상 플러그인을 막지 않는다).
    hostVersion: () => getAppVersion(),
    listBuiltinStates: () => listBuiltinStates(),
    setBuiltinEnabled: (id, enabled) =>
      reloadAfter(setBuiltinEnabled(id, enabled), builtinReason(id)),
    listBuiltinSettings: () => listBuiltinSettings(),
    setBuiltinSetting: (id, key, value) =>
      notifySettingChanged(id, key, value, setBuiltinSetting(id, key, value)),
    /**
     * 설정 화면 액션 버튼 → 그 플러그인의 명령 실행. 결과는 사유가 담긴 outcome이다.
     *
     * 먼저 스냅샷에서 명령의 **존재를 확인**한다: 없는 id로 방송하면 중앙 호스트가 조용히
     * 무시해(`commandsOf.get(...)?.get(id)`가 undefined → return) 사용자에게는 "눌러도
     * 아무 일이 없다"만 남는다. 여기서 걸러야 설정 화면이 "이 플러그인이 그 동작을 등록하지
     * 않았다"고 정확히 말할 수 있다.
     *
     * 같은 이유로 **호스트가 어차피 삼킬 실행은 보내지 않는다**: 창 컨텍스트가 없는 실행에서
     * 호스트는 `when`의 창-의존 키(스냅샷 `whenPendingKeys`)를 판정할 수 없고 `destructive`
     * 확인 팝업을 띄울 곳도 없어 진단만 남기고 실행하지 않는다 — 보내 놓고 "요청했다"고
     * 말하면 설정 화면이 거짓 성공을 띄우게 된다(판정 순서도 호스트와 같다: when → 확인).
     *
     * `windowLabel: ""`이 **"창 컨텍스트 없음"의 표시**다(결정). 설정 창은 노트 창이
     * 아니라 창-스코프 호출에 응답할 표면이 없으므로, 여기서 설정 창 라벨을 실어 보내면
     * 호스트가 그것을 "마지막 클릭 창"으로 기억해 이후 그 플러그인의 모든 폴백 호출이
     * 응답 없는 창을 향하게 된다. 빈 라벨을 받은 호스트는 기록하지 않고 토큰도 발급하지
     * 않는다 — 명령 본문의 창-스코프 호출은 기존 폴백 계약(마지막으로 쓴 메모 창, 없으면
     * CONTEXT_UNAVAILABLE + 진단)을 그대로 탄다.
     */
    runPluginCommand: async (pluginId, commandId) => {
      const snap = await fetchHostSnapshot({
        bus,
        hostAlive: ensurePluginHost,
      });
      const command = snap?.plugins
        .find((p) => p.pluginId === pluginId)
        ?.commands?.find((c) => c.id === commandId);
      if (!command) return "unregistered";
      if ((command.whenPendingKeys ?? []).length > 0) {
        return "needs-note-window";
      }
      if (command.destructive === true) return "needs-confirm-window";
      await emitAppEvent(EV_BUTTON_INVOKE, {
        pluginId,
        commandId,
        windowLabel: "",
      });
      return "dispatched";
    },
  });

  // 첫 실행이면 「시작 가이드」 메모를 만든다 — **마운트가 끝난 뒤** 곁다리로(실패해도 이
  // 창은 이미 떠 있다). 설정 창이 이 일을 하는 이유는 `bootstrap/guide-note.ts` 참고:
  // 시작 흐름이 창을 하나도 안 여는 자동시작 뒤에는, 사용자가 처음 여는 창이 만든다.
  void ensureGuideNote(tauriGuideNoteIO(), { summon: true });
}
