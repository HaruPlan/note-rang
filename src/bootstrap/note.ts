/**
 * 노트 창(`?note=<id>`) 부트스트랩 — 본문·옵션·배경·에디터·자동저장·드래그를 마운트한다.
 *
 * `main.ts`가 동적 `import()`로만 이 모듈을 로드한다(이슈 #26) — 여기서 정적으로 끌어오는
 * `mountNoteWindow`(CodeMirror 포함)는 노트 창에서만 필요하고, 설정·패널·플러그인호스트
 * 창은 이 청크를 아예 내려받지 않는다.
 */
import { resolveLanguage } from "../i18n/detect";
import { t } from "../i18n/t";
import { loadActiveBundledLocale } from "../i18n/packs";
import { registerLocale, setActiveLocale } from "../i18n/store";
import {
  attachWindowCallHandler,
  buildExtensionsFromSnapshot,
  collectPluginStyleCss,
  fetchHostSnapshot,
  noteEventEmitter,
  raceSnapshot,
  snapshotSelectionActions,
  snapshotToolbarButtons,
  SNAPSHOT_BUDGET_MS,
} from "../plugin/host-client";
import { setSelectionActions } from "../plugin/selection-action";
import {
  EV_HOST_PLUGIN_UPDATED,
  EV_HOST_UPDATED,
  EV_NOTE_COLLAPSED_CHANGED,
  EV_NOTE_DELETED,
  EV_NOTE_RESTORED,
  EV_SETTINGS_CHANGED_LOCAL,
  parseRebuildReasons,
  type HostPluginUpdatedPayload,
  type HostSnapshot,
  type MemoEventName,
  type RebuildReason,
  type SettingsChangedLocalPayload,
} from "../plugin/host-protocol";
import { enabledBuiltinWindowControls } from "../plugin/window-control";
import {
  NO_CAPABILITIES,
  type PluginCapabilities,
} from "../plugin/capabilities";
import { BUILTIN_PLUGINS } from "../plugin/builtin";
import { isSupportedOnPlatform } from "../plugin/platform";
import { SJ_D } from "../theme/theme";
import { DEFAULT_BACKGROUND } from "../theme/background";
import { savedFontFamily } from "../theme/font";
import { debounce, mountNoteWindow } from "../note/note-window";
import { maybeShowVaultFolderPrompt } from "../note/vault-folder-prompt";
import { effectiveKeybindings } from "../shortcuts/actions";
import {
  attachmentUrl,
  closeWindow,
  createAndOpenNote,
  ensurePluginHost,
  getPlatform,
  getSharedSettings,
  getVaultPath,
  getWindowTitle,
  listBuiltinStates,
  noteArchive,
  noteDelete,
  noteDuplicate,
  noteList,
  noteRead,
  noteSaveContent,
  noteSaveOverrides,
  onWindowGeometryChange,
  openExternalUrl,
  openNotePanel,
  openSettings,
  readClipboardText,
  readLocaleEntries,
  writeClipboardText,
  saveAttachment,
  saveWindowGeometry,
  setAlwaysOnTop,
  setNoteCollapsed,
  setVisibleOnAllSpaces,
  setWindowAlpha,
  startDragging,
  summonNote,
} from "../shared/tauri";
import {
  activeThemeOverrides,
  applyLocalSettingChanges,
  canApplyLocally,
  createLocalApplyQueue,
  defaultFontPx,
  withTimeout,
} from "./note-local-apply";
import {
  applyReconcileSteps,
  planHostUpdate,
  planLateSnapshot,
  type ReconcileTarget,
} from "./host-update-plan";
import { tauriBus, THEME_WAIT_MS } from "./shared";
import { dismissReloadOverlay, writeReloadSnapshot } from "./reload-overlay";

/**
 * 중앙 호스트의 스냅샷으로 테마를 정하고 노트창을 마운트한다(마운트는 호스트에 비차단).
 *
 * 마운트가 끝나면 — **성공이든 실패든** — 설정 반영 리로드 안내 오버레이를 걷는다
 * (`reload-overlay.ts`). 실패 경로에서 남으면 그 자리에 뜨는 오류 오버레이 위에 "설정 적용
 * 중…"이 겹쳐, 사용자는 멈춘 창을 아직 작업 중인 창으로 오해한다. 첫 로드에는 오버레이 자체가
 * 없으므로(부트 스크립트가 스냅샷을 못 찾고 빠진다) 이 호출은 no-op이다.
 */
export async function bootstrapNote(
  host: HTMLElement,
  id: string,
): Promise<void> {
  try {
    await runNoteBootstrap(host, id);
  } finally {
    dismissReloadOverlay();
  }
}

/** [`bootstrapNote`]의 본체 — 위 래퍼가 오버레이 정리(try/finally)만 얹는다. */
async function runNoteBootstrap(host: HTMLElement, id: string): Promise<void> {
  const bus = tauriBus();
  // 창 라벨은 백엔드 생성 규칙(window_manager::note_label)과 동일한 `note-<id>` —
  // 창-스코프 호출 라우팅과 버튼 클릭 컨텍스트에 쓴다.
  const windowLabel = `note-${id}`;

  // 중앙 호스트가 수집한 직렬화 디스크립터 스냅샷(테마 + 플러그인). ensure가 죽은 호스트
  // 창을 재생성하고(자동 복구), 스냅샷은 백그라운드로 계속 기다린다 — 도착하면 플러그인
  // 확장·버튼이 적용된다(설치는 비동기 Compartment 주입이라 마운트 후 적용과 정합).
  const snapshotPromise = fetchHostSnapshot({
    bus,
    hostAlive: ensurePluginHost,
  });
  // 플랫폼은 스냅샷과 무관한 가벼운 IPC라 스냅샷 레이스와 나란히 미리 받아 둔다 — 아래
  // windowControls 폴백과 isMac(단축키 가속기 해석)이 **같은 값**을 공유한다(중복 호출 제거).
  const platformPromise = getPlatform().catch(() => "");
  // 번들 플러그인 활성 상태(id→enabled) — 플러그인 **호스트와 무관한** 가벼운 백엔드 조회라
  // 스냅샷 레이스와 나란히 띄운다. 이것이 이 앱의 "레지스트리"다: 어떤 번들 기능이 켜져 있는지는
  // 샌드박스를 띄우지 않고도 **확정적으로** 알 수 있다(중앙 호스트도 같은 맵으로 실행 여부를
  // 가른다 — central-host의 `builtinStates?.[id] ?? true`). 스냅샷(=샌드박스 실행 결과)이 늦다고
  // 해서 "켜져 있겠거니" 추정할 이유가 없다.
  // 조회 실패는 **빈 맵이 아니라 null**(모름)이다 — 빈 맵으로 넘기면 `states[id] ?? true`가
  // 전부 "켜짐"으로 읽어, 없애려는 fail-open이 실패 경로로 되살아난다.
  const builtinStatesPromise = listBuiltinStates().catch(
    () => null as Record<string, boolean> | null,
  );
  // 테마만 짧게 레이스한다: 늦으면 SJ_D로 즉시 마운트(노트 열림은 호스트에 비차단).
  // 상한을 넘겨 늦게 도착한 스냅샷의 테마는 `installPlugins`의 snapshotPromise 콜백이
  // 이 낙관값과 비교해(`planLateSnapshot`) 도착하는 그 자리에서 바로 교정한다 — 호스트
  // 재빌드 방송(EV_HOST_UPDATED)이나 창 재열기를 기다리지 않는다.
  const early = await raceSnapshot(snapshotPromise, THEME_WAIT_MS);
  const theme = early?.theme ?? SJ_D;
  // 창 단위 도구 단축키 키맵 해석에 쓸 플랫폼(가속기의 Mod=⌘/Ctrl 판정). 실패 시 non-mac 취급.
  const platform = await platformPromise;
  const isMac = platform === "macos";
  // 빌트인 활성 상태 — 아래 창-컨트롤·배경 판정과 컨텍스트 메뉴(youtube-embed)가 공유한다.
  const builtinStates = await builtinStatesPromise;
  /**
   * 이 번들 플러그인이 지금 실제로 실행 중인지 — 중앙 호스트의 실행 판정과 **같은 규칙**.
   * 활성 맵을 못 읽었으면(null) 언제나 false다: 모르면 안 그린다.
   */
  const builtinRunning = (pluginId: string): boolean => {
    if (!builtinStates) return false;
    const plugin = BUILTIN_PLUGINS.find((p) => p.id === pluginId);
    return (
      !!plugin &&
      (builtinStates[plugin.id] ?? true) &&
      isSupportedOnPlatform(plugin.platforms, platform)
    );
  };
  // 배경 능력(스와치·자동 대비): 스냅샷이 도착했으면 그 값(플러그인 off면 null)을 존중하고,
  // 아직이면 **background 번들이 켜져 있을 때만** 기본 배경으로 마운트한다. 꺼둔 사용자에게
  // 배경 피커를 잠깐 띄웠다 뺏지 않는다(아래 windowControls와 같은 규약).
  const background = early
    ? early.background
    : builtinRunning("background")
      ? DEFAULT_BACKGROUND
      : null;
  // 활성화된 창 컨트롤(투명도·항상 위·모든 데스크탑): 스냅샷이 왔으면 그 합집합(플러그인 off면
  // 빠짐)을 그대로 쓴다. 아직이면 **추정하지 않고** 번들 활성 상태로 직접 판정한다 — 판정 입력
  // (활성 맵 + 플랫폼 지원)이 중앙 호스트의 실행 조건과 완전히 같으므로 스냅샷을 기다리지 않고도
  // 같은 답이 나온다.
  //
  // 왜 낙관적 추정을 버렸나: 예전엔 스냅샷이 THEME_WAIT_MS(1초) 안에 못 오면(호스트 첫 기동에
  // 흔하다) "지원되는 컨트롤은 다 켜져 있겠거니" 가정했다. 그래서 **사용자가 꺼둔** 창-기능
  // 플러그인의 컨트롤이 그 창에 그려졌고, 늦게 도착한 스냅샷은 이 값을 교정하지 않아
  // (교정 경로는 EV_HOST_UPDATED 재빌드나 창 재열기뿐) 세션 내내 유령으로 남았다. 설정 창은
  // 언제나 실제 스냅샷을 기다리므로(`capabilities`가 null이면 아무 판정도 안 한다) 두 화면의
  // 답이 갈렸다. 원칙: **어떤 화면도 플러그인이 로드됐다고 추정하지 않는다** — 모르면 안 그린다.
  //
  // 번들이 제공하지 않는 컨트롤(서드파티가 `memo.window.register`로 선언한 것)은 이 경로에서
  // 알 수 없으므로 뺀다(보수적). 스냅샷이 도착한 창부터 정확히 나온다.
  // 이 창이 조건부 UI를 그릴 때 쓰는 능력 묶음 — 노트 창은 이 값 하나만 보고 판정한다
  // (deps에 옵셔널 플래그를 흩뿌리면 하나를 빠뜨렸을 때 조용히 "켜짐"이 된다, capabilities.ts).
  //
  // 스냅샷도 활성 맵도 없으면 [`NO_CAPABILITIES`] — 조건부 UI를 하나도 그리지 않는다. 백엔드
  // 조회까지 실패한 상황이라 앱 상당 부분이 이미 정상이 아니며, 그때 "다 켜진 척"하는 것보다
  // 안 그리는 쪽이 안전하다(꺼둔 플러그인의 UI를 띄우지 않는다).
  const capabilities: PluginCapabilities =
    !early && !builtinStates
      ? NO_CAPABILITIES
      : {
          windowControls: early
            ? early.windowControls
            : enabledBuiltinWindowControls(
                BUILTIN_PLUGINS,
                builtinStates ?? {},
                platform,
              ),
          // 빌트인 youtube-embed 활성 여부 — 컨텍스트 메뉴 "유튜브 추가" 항목 표시 조건(꺼져
          // 있으면 삽입해도 렌더되지 않는 죽은 기능이라 항목을 숨긴다). 플랫폼 제약이 없어 활성
          // 여부만 본다(기록 없음 = 켜짐 — listBuiltinStates의 계약). 맵을 못 읽었으면 숨긴다.
          youtubeEmbed: builtinStates
            ? builtinStates["youtube-embed"] !== false
            : false,
        };

  const settings = await getSharedSettings().catch(() => null);
  // 이 창의 UI 언어를 확정한다(첫 렌더 전).
  const language = resolveLanguage(settings?.language);
  // (2)의 IPC를 (1)보다 **먼저 띄운다** — 둘은 서로 독립이라(하나는 청크 로드, 하나는 로컬
  // IPC) 나란히 달리면 첫 페인트가 둘 중 느린 쪽만큼만 늦는다. `language`가 settings 도착
  // 뒤에야 확정되므로 여기가 가장 이른 시작점이다. ko면 아예 부르지 않는다: ko는 코어 내장이라
  // 언어팩이 공급할 수 없고(등록해도 `registerLocale`이 보호 코드로 거부한다) 왕복만 남는다.
  const installedEntries =
    language === "ko" ? null : readLocaleEntries(language).catch(() => null);
  // (1) **번들** 언어팩: 이 언어에 해당하는 팩이 있고 켜져 있으면 로컬에서 직접 읽어 등록한다
  // (호스트 왕복 없음 — 그래서 첫 페인트가 늦은 스냅샷을 기다릴 이유가 없다). 코드가 일치하는
  // 팩이 없으면(ko 등) 어떤 청크도 받지 않고 즉시 끝난다(i18n/packs.ts 참고).
  await loadActiveBundledLocale(language, builtinStates);
  // (2) **서드파티** 언어팩(직로드): 코어(Rust)가 설치 매니페스트를 직접 스캔해 준 사전을
  // 첫 페인트 전에 등록한다 — 이것도 호스트 왕복이 없어 (1)과 같은 시점에 준비된다.
  // 라벨은 이 경로에서 표시에 쓰이지 않으므로(드롭다운은 설정 창만 그린다) 카탈로그 조회를
  // 생략하고 코드를 그대로 넘긴다 — IPC 한 번을 아낀다.
  //
  // 번들 en이 활성이면 "en"은 이미 보호 코드라 서드파티 영어팩이 여기서 조용히 무시된다.
  // **번들 en 팩을 사용자가 꺼 뒀다면** "en"은 보호되지 않으므로 서드파티 영어팩이 그 자리를
  // 차지한다 — 의도된 의미론이다(내장 언어를 끄고 커뮤니티 팩으로 대체하는 것을 허용한다;
  // 설치와 `i18n` 권한 선언이 이미 전제되어 있다).
  const entries = await installedEntries;
  if (entries && Object.keys(entries).length > 0) {
    registerLocale(language, language, entries);
  }
  // 두 등록이 **모두 끝난 뒤** 활성 로케일을 확정한다 — 이 시점이 첫 페인트보다 앞이므로
  // "늦게 도착한 사전" 자체가 없다(그것을 리로드로 수습하던 장치가 사라진 이유).
  setActiveLocale(language);
  // vault 절대경로를 한 번 받아 이미지 상대경로를 웹뷰 URL로 합치는 데 쓴다(실패 시 이미지 미렌더).
  const vaultPath = await getVaultPath().catch(() => null);
  // 노트 본문 파일의 절대경로(Rust `Vault::md_path`와 동일 규칙: `notes/<id>.md`).
  // 플러그인이 현재 노트 경로를 물으면(memo.notes.current) 이 값을 준다.
  const notePath = vaultPath ? `${vaultPath}/notes/${id}.md` : null;
  // 전역 기본 글자 크기(px, 앱 설정). 메모 델타(font_delta%)가 여기 더해진다(폰트 플러그인).
  // 해석 규칙은 국소 반영기와 공유한다 — 두 벌이면 열려 있던 창과 새로 연 창이 갈린다.
  const baseFontPx = defaultFontPx(settings);
  // 전역 폰트 패밀리(「폰트」 플러그인 선택값)는 **원본 저장값과 능력 디스크립터를 따로** 넘긴다 —
  // 해석(플러그인 off면 시스템 기본 고정, 배경 능력과 대칭인 "끄면 고정")은 노트 창이 한 곳에서
  // 한다(`theme/font.ts`의 `resolveFontFamily`). 마운트와 재적용이 규칙을 나눠 가지면 국소
  // 반영·재빌드 조정에서 조용히 갈린다. 스냅샷이 늦으면(early=null) 능력이 없는 것으로 보고
  // 시스템 기본으로 일단 열지만, 실제 스냅샷이 도착하는 즉시(`installPlugins`) 이 낙관값과
  // 다르면 그 자리에서 교정한다(`planLateSnapshot`) — 재빌드·재열기까지 기다리지 않는다.
  const font = early?.font ?? null;
  const savedFont = savedFontFamily(settings);

  /**
   * 이 창의 플러그인 생명주기 이벤트 발신 — 스냅샷이 도착하기 전에는 no-op이다.
   *
   * 왜 가변 슬롯인가: "누가 구독 중인가"는 중앙 호스트만 알고 그 사실은 스냅샷에 실려
   * 뒤늦게 온다. 노트 마운트는 스냅샷에 비차단이어야 하므로(테마 폴백과 같은 원칙), 도착
   * 전에 난 이벤트는 그냥 흘려보낸다 — 늦게 오는 이벤트로 순서를 뒤집는 것보다 낫다.
   */
  let emitNoteEvent: (name: MemoEventName) => void = () => {};

  /**
   * 이 창의 플러그인 CM 확장을 (재)적용하는 슬롯(단일 핫리로드). 스냅샷이 도착해
   * `installPlugins`가 채우기 전에는 no-op이다(부분 갱신 신호가 먼저 와도 안전).
   */
  let applyPluginExtensions: (snap: HostSnapshot) => void = () => {};

  /**
   * 이 창이 **마지막으로 반영한** 상태 — 다음 재빌드 완료 방송이 "무엇이 바뀌었는지"를
   * 알아내는 기준이다(`host-update-plan.ts`).
   *
   * 세 값을 한 묶음으로 두는 이유: 판정은 셋을 함께 봐야 하고(설정·스냅샷·vault 경로), 갱신도
   * 함께 일어나야 한다 — 하나만 앞으로 감기면 다음 판정이 "설정은 새것, 스냅샷은 옛것"인
   * 어긋난 기준으로 비교해 바뀐 것을 놓치거나 없는 변경을 지어낸다.
   *
   * `snapshot`이 null로 시작하는 이유: 마운트는 스냅샷에 비차단이라 아직 도착 전일 수 있다
   * (도착하면 `installPlugins` 안에서 채운다). 기준이 없는 채로 방송이 오면 판정기가 리로드로
   * 떨어진다 — 모르면 리로드.
   *
   * `EV_SETTINGS_CHANGED_LOCAL`(국소 반영)도 `settings`를 앞으로 감는다: 두 경로가 같은
   * 기준을 봐야 색을 국소 반영한 직후 온 재빌드가 그 색을 "또 바뀐 것"으로 보지 않는다.
   */
  const current: {
    settings: Awaited<ReturnType<typeof getSharedSettings>> | null;
    snapshot: HostSnapshot | null;
    vaultPath: string | null;
  } = { settings, snapshot: null, vaultPath };

  const note = await mountNoteWindow(host, id, {
    loadNote: async (noteId) => {
      const data = await noteRead(noteId);
      return { content: data.content, overrides: data.meta.overrides };
    },
    // 저장이 **실제로 끝난 뒤** 알린다 — 파일에 안 들어간 변경을 "저장됨"으로 알리면
    // 그걸 믿고 파일을 읽는 플러그인이 옛 본문을 본다(거부되면 이벤트도 없다).
    // 프라미스를 그대로 돌려준다(void로 버리지 않는다) — note-window.ts가 이 완료 시점을 관찰해
    // 접힘 헤더 라벨을 백엔드의 refresh_window_title 이후 시점에 재조회한다.
    saveContent: (noteId, content) =>
      noteSaveContent(noteId, content).then(() => {
        emitNoteEvent("note:saved");
      }),
    saveOverrides: (noteId, overrides) =>
      void noteSaveOverrides(noteId, overrides),
    applyTransparency: (percent) => void setWindowAlpha(percent),
    applyPinned: (on) => void setAlwaysOnTop(on),
    applyAllSpaces: (on) => void setVisibleOnAllSpaces(on),
    applyCollapsed: (on) => void setNoteCollapsed(id, on),
    // 접힘 헤더 가운데 라벨의 제목 — 창 타이틀(본문 첫 줄)을 그대로 쓴다(패널·검색과 같은 규칙).
    windowTitle: getWindowTitle,
    deleteNote: (noteId) => void noteDelete(noteId).then(() => closeWindow()),
    archiveNote: (noteId) => void noteArchive(noteId).then(() => closeWindow()),
    startDrag: () => void startDragging(),
    resolveImageSrc: vaultPath
      ? (path) => attachmentUrl(vaultPath, path)
      : undefined,
    // 본문 링크는 웹뷰가 아니라 시스템 브라우저로 나간다. 실패(스킴 거부 등)는 조용히
    // 무시한다 — 설정 창 README 링크와 같은 관례.
    openExternalUrl: (url) => void openExternalUrl(url).catch(() => {}),
    // 우클릭 메뉴 복사/붙여넣기도 네이티브 클립보드를 먼저 탄다(웹 API는 폴백).
    writeClipboard: writeClipboardText,
    readClipboard: readClipboardText,
    // 컨텍스트 메뉴 "설정 열기" — 노트 툴바의 "설정 바로가기" 버튼(이슈 #16)과 같은 배선원.
    openSettings,
    // 컨텍스트 메뉴 "노트 목록·검색 열기"/"새 메모" — 패널의 "+" 버튼·트레이 진입점과 같은
    // 배선원(베타 피드백 2건).
    openPanel: openNotePanel,
    createNote: createAndOpenNote,
    saveImage: (data, ext) => saveAttachment(id, data, ext),
    theme,
    background,
    // 활성 테마에 대한 사용자 색 오버라이드(공유 설정) — 노트창이 테마 위에 얹어 적용한다.
    // 고르는 규칙은 국소 반영기와 같은 함수를 쓴다(위 baseFontPx와 같은 이유).
    themeOverrides: activeThemeOverrides(settings),
    baseFontPx,
    fontFamily: savedFont,
    font,
    capabilities,
    // 창 단위 도구 단축키: 저장 필드가 없으면(최초) 기본 바인딩(⌥=/⌥- 확대·축소)을 시드한다.
    keybindings: effectiveKeybindings(settings?.keybindings),
    // 전역 툴바 배치(설정 창 드래그&드롭). 없으면 note-window가 기본 배치를 쓴다.
    toolbarLayout: settings?.toolbar_layout,
    isMac,
    installPlugins: (ctx) => {
      // 스냅샷이 "도착하는 시점"에 에디터 확장·툴바 버튼을 **로컬에서** 인스턴스화한다 —
      // 샌드박스는 이 창에서 실행되지 않고(호스트가 플러그인당 1개 소유), 스냅샷이 늦어도
      // 노트 마운트는 이미 끝나 있다(논블로킹). null(호스트 이상·예산 초과)이면 플러그인
      // 없이 유지한다.
      void snapshotPromise.then((snapshot) => {
        if (!snapshot) {
          console.error(
            "[memo] 플러그인 호스트 스냅샷 없음 — 플러그인 없이 진행",
          );
          return;
        }

        // 스냅샷은 언어를 나르지 않는다 — 언어팩은 위에서 첫 페인트 전에 이미 등록됐다
        // (`HostSnapshot` 참고). 예전에는 여기서 늦게 온 언어팩을 등록하고 첫 페인트가 이미
        // 다른 언어로 굳었으면 1회 리로드로 수습했는데, 그 지연 자체가 없어졌다.

        // 호스트가 위임하는 창-스코프 호출(toast·글자 델타·클립보드·현재 노트) 수행부.
        attachWindowCallHandler(bus, windowLabel, {
          showToast: ctx.showToast,
          // 상태 아이템의 라이브 텍스트 갱신 — 등록은 스냅샷으로 왔고, 갱신만 이 창으로 위임된다.
          updateStatusItem: ctx.updateStatusItem,
          getFontDelta: ctx.getFontDelta,
          setFontDelta: ctx.setFontDelta,
          insertText: ctx.insertText,
          writeClipboard: (text) => writeClipboardText(text),
          // 현재 노트: id·절대경로 + 라이브 본문(복사 문구의 {content} 치환용).
          currentNote: () =>
            notePath ? { id, path: notePath, content: ctx.getContent() } : null,
          // 복제: 내용·설정이 같은 새 노트를 만들고 그 창을 소환한다(복제 플러그인).
          duplicateNote: () =>
            noteDuplicate(id).then((newId) => void summonNote(newId)),
          // 옵션 초기화: 이 메모만의 override를 전역 기본값으로 되돌린다(옵션 초기화 플러그인).
          resetOptions: ctx.resetOptions,
          pickList: ctx.pickList,
          prompt: ctx.prompt,
        });

        // 생명주기 이벤트 발신기: 구독자가 있는 이름만 호스트로 나간다. 발신기가 생기는
        // 이 자리가 곧 note:opened다 — 창이 뜬 순간이 아니라 **플러그인이 관측 가능해진**
        // 순간이라, 스냅샷이 끝내 오지 않으면(호스트 이상) 이 이벤트도 없다.
        const emit = noteEventEmitter(snapshot, windowLabel, bus);
        emitNoteEvent = (name) => emit(name, { id, path: notePath });
        emitNoteEvent("note:opened");

        // 플러그인 툴바 버튼·상태 아이템·명령·메뉴 항목: 클릭하면 호스트의 해당 샌드박스
        // onClick으로 위임된다. 마운트도 재빌드 후 조정도 **같은 함수**(reconcileToolbarItems)를
        // 탄다 — 마운트는 빈 레지스트리에 대한 diff라 결과가 "전부 추가"다. 두 벌로 나누면
        // 새로 연 창과 열려 있던 창이 조용히 갈린다(이 저장소의 단골).
        //
        // 핸들(`note`)이 아니라 `ctx`로 부르는 이유: 스냅샷이 제때 오면 이 `then` 콜백이
        // 위 `await mountNoteWindow`가 풀리기 **전에** 실행된다(이미 resolved인 프라미스의
        // 콜백이 먼저 큐에 든다). 그때 `note`는 아직 TDZ라 건드리면 ReferenceError로 플러그인
        // 항목이 통째로 사라진다. `ctx`는 그 시점에 이미 손에 있다.
        ctx.reconcileToolbarItems(
          snapshotToolbarButtons(snapshot, windowLabel, bus),
        );

        // 디스크립터 → CM 확장 + 인라인 패턴 스타일. 개발 모드 단일 핫리로드가 전체
        // 리로드 없이 이 둘만 다시 적용하므로(창 상태 보존), 재사용 가능한 클로저로 묶는다.
        // 버튼·창-스코프 배선·note:opened는 여기 넣지 않는다 — 그것들은 마운트당 1회이고,
        // 부분 갱신은 그 표면이 바뀌지 않을 때만 오기 때문이다(바뀌면 호스트가 전체 리로드).
        const applyExtensions = (snap: HostSnapshot): void => {
          // 선택 액션(`ui.addSelectionAction`): 선택 툴바와 단축키가 함께 읽는 창 로컬 등록부에
          // 통째로 싣는다. 버튼과 달리 여기(재적용 경로)에 두는 이유는 두 가지다 — 개발 모드
          // 부분 갱신에서도 최신 등록이 반영돼야 하고, CM 확장과 달리 **라이브 프리뷰를 꺼도**
          // 살아 있어야 한다(선택 액션은 렌더가 아니라 사용자 동작이다).
          setSelectionActions(snapshotSelectionActions(snap, windowLabel, bus));
          // 디스크립터 → CM 확장(패턴·자동완성·임베드 게이트는 노트창 로컬에서 평가).
          // 렌더(render)와 메타(meta)를 갈라 넘긴다 — 메타(색 문법 facet)는 위 선택 액션과
          // 같은 이유로 **라이브 프리뷰를 꺼도** 살아 있어야 한다(렌더가 아니라 사실 정보다).
          const built = buildExtensionsFromSnapshot(snap, {
            noteTitles: () =>
              noteList().then((notes) => notes.map((n) => n.title)),
            resolveTitleToId: (title) =>
              noteList().then(
                (notes) => notes.find((n) => n.title === title)?.id ?? null,
              ),
            summon: (nid) => void summonNote(nid),
            // 코어 마크다운 링크와 같은 경로로 나간다(스킴 판정은 백엔드가 소유).
            openUrl: (url) => void openExternalUrl(url).catch(() => {}),
          });
          ctx.setPluginExtensions(built.render, built.meta);
          // 플러그인 인라인 패턴 스타일 주입 — 호스트가 화이트리스트로 검증·네임스페이스한
          // CSS를 <style>에 넣는다(textContent라 HTML 재파싱·`</style>` 탈출 불가).
          const styleEl =
            document.getElementById("memo-plugin-styles") ??
            document.head.appendChild(
              Object.assign(document.createElement("style"), {
                id: "memo-plugin-styles",
              }),
            );
          styleEl.textContent = collectPluginStyleCss(snap);
        };
        applyExtensions(snapshot);
        applyPluginExtensions = applyExtensions;
        // 이제부터 이 스냅샷이 "이 창이 반영한 상태"다 — 재빌드 완료 방송의 비교 기준.
        current.snapshot = snapshot;

        // 상한(THEME_WAIT_MS)을 넘겨 늦게 온 스냅샷이면 마운트가 그렸던 낙관값(테마=SJ_D,
        // 배경=early?.background ?? null, 폰트=능력 없음, 창 컨트롤=early?.windowControls ??
        // [])이 실제와 다를 수 있다 — 다르면 지금 이 자리에서 바로 교정한다(재빌드 방송이나
        // 창 재열기를 기다리지 않는다). 배경·창 컨트롤은 `background`·`capabilities.
        // windowControls`(builtinRunning 추정을 태운 값)가 아니라 `early`를 그대로 넘긴다 —
        // 추정이 맞았는지 다시 검증하지 않고, "실제 스냅샷을 봤는가"만으로 교정 여부를 정한다.
        // 제때 왔으면(early가 이 snapshot과 같은 값) `planLateSnapshot`이 빈 배열을 내 아무
        // 일도 하지 않는다. 오버라이드·저장 글꼴은 지금 아는 가장 최신 설정(`current.
        // settings`)에서 뽑는다 — 국소 반영이 그 사이 settings를 앞으로 감겼을 수 있어서다.
        const lateSteps = planLateSnapshot({
          mountedTheme: theme,
          mountedBackground: early?.background ?? null,
          mountedFont: font,
          mountedWindowControls: early?.windowControls ?? [],
          snapshot,
        });
        if (lateSteps.length > 0) {
          applyReconcileSteps(
            lateSteps,
            { settings: current.settings ?? {}, snapshot },
            reconcileTarget,
          );
        }
      });
    },
  });

  /**
   * `host-update-plan.ts`의 조정 단계 → 재적용 API 배선 — 재빌드 후 제자리 조정
   * (`applyHostUpdate`)과 위 지각 스냅샷 교정이 **같은 대상**을 공유한다. 단계 이름이 어떤
   * API를 부르는가는 배선 하나로 못박아야 한다(두 벌이면 한쪽만 API를 바꿨을 때 조용히 갈린다).
   */
  const reconcileTarget: ReconcileTarget = {
    applyTheme: (nextTheme, overrides) => note.applyTheme(nextTheme, overrides),
    applyThemeOverrides: (overrides) => note.applyThemeOverrides(overrides),
    applyBackgroundCapability: (background) =>
      note.applyBackgroundCapability(background),
    applyBaseFontPx: (px) => note.applyBaseFontPx(px),
    applyFontCapability: (nextFont, saved) =>
      note.applyFontCapability(nextFont, saved),
    applyWindowControls: (controls) => note.applyWindowControls(controls),
    applyKeybindings: (bindings) => note.applyKeybindings(bindings),
    // 개발 모드 단일 핫리로드가 쓰던 그 클로저 — CM 확장 + 선택 액션 + 플러그인 CSS를
    // 새 스냅샷으로 한 번에 다시 만든다(dispatch 한 번이라 에디터를 새로 만들지 않는다).
    applyExtensions: (nextSnap) => applyPluginExtensions(nextSnap),
    // 마운트가 쓰는 그 평탄화 함수를 그대로 다시 태운다 — 창 라벨·이벤트 버스 배선이 한 벌
    // 이어야 클릭이 어느 경로로 등록됐든 같은 호스트 역호출로 나간다.
    reconcileToolbarItems: (nextSnap) =>
      note.reconcileToolbarItems(
        snapshotToolbarButtons(nextSnap, windowLabel, bus),
      ),
    applyYoutubeEmbedEnabled: (on) => note.applyYoutubeEmbedEnabled(on),
    // 재빌드는 모든 샌드박스를 새 인스턴스로 갈아 끼운다 — 발신기를 새 스냅샷으로 다시
    // 만들고(구독 집합도 그때 갱신된다) `note:opened`를 다시 쏴, 새 인스턴스가 이 창을
    // "열려 있는 노트"로 알게 한다.
    rewireEvents: (nextSnap) => {
      const emit = noteEventEmitter(nextSnap, windowLabel, bus);
      emitNoteEvent = (name) => emit(name, { id, path: notePath });
      emitNoteEvent("note:opened");
    },
  };

  // 최초 실행 저장 폴더 안내(이슈 #21) — "메모가 어디에 저장되는지"를 한 번 알려 준다.
  // 마운트가 끝난 뒤에 부르는 이유: 툴바 스타일 프롬프트(`createNoteToolbar`가 마운트 중에
  // 시도한다)와 겹치지 않도록 이 안내가 그쪽 신호를 기다리는데, 그 신호는 스타일 프롬프트가
  // **한 번이라도 시도된 뒤에야** 의미가 있다. 필요 없으면(이미 안내함·조회 실패) 조용히
  // 아무것도 하지 않는다.
  maybeShowVaultFolderPrompt();

  // 개발 모드 단일 핫리로드: 플러그인 하나만 바뀌면 호스트가 전체 리로드 대신 이
  // 신호를 보낸다 — 그 스냅샷으로 CM 확장만 다시 구성한다(Compartment reconfigure는 dispatch
  // 한 번이라 에디터를 새로 만들지 않고 스크롤·선택·IME 조합을 유지한다). 스냅샷이 아직
  // 안 왔으면(applyPluginExtensions=no-op) 조용히 넘긴다 — 곧 도착하는 첫 스냅샷이 최신이다.
  bus.listen(EV_HOST_PLUGIN_UPDATED, (payload) => {
    const p = payload as HostPluginUpdatedPayload | null;
    if (!p || typeof p.snapshot !== "object" || p.snapshot === null) return;
    // 경합 가드: 이 핫리로드와 재빌드 재조회(`applyHostUpdate`의 fetchLatest)는 둘 다
    // 비동기라 완료 순서가 뒤집힐 수 있다 — 재조회가 먼저 시작했더라도 이 핫리로드가 먼저
    // 끝나 `current.snapshot`을 더 새 revision으로 앞당겼는데, 뒤늦게 끝난 재조회의 더 오래된
    // 응답이 그걸 덮으면(아래 `applyHostUpdate`) 안 된다. 반대 방향(이 핸들러가 더 오래된
    // revision을 든 채 나중에 도착)도 같은 이유로 막는다: `current.snapshot`보다 낮은
    // revision이면 적용도 대입도 건너뛴다. `current`만 가드하고 `applyPluginExtensions`는
    // 그대로 불렀다면, 창은 "최신을 안다"고 기록하면서 화면은 그 낡은 스냅샷의 확장(패턴·
    // 자동완성·임베드)으로 되돌아가는 표시-상태 불일치가 남는다 — 그래서 여기서 완전히
    // return한다.
    if (current.snapshot && p.snapshot.revision < current.snapshot.revision) {
      return;
    }
    applyPluginExtensions(p.snapshot);
    // 툴바 항목도 함께 맞춘다 — 이것이 있어야 중앙 호스트가 "버튼·명령이 바뀌었다"는 이유로
    // 전체 리로드로 폴백하지 않아도 된다(`central-host.ts`의 `canPartial`). 예전에는 이 호출이
    // 없어서, canPartial이 보지 않던 상태 아이템·메뉴 항목 변경은 부분 갱신을 타고도 화면에
    // 반영되지 않았다(개발 중 무음 실패).
    note.reconcileToolbarItems(
      snapshotToolbarButtons(p.snapshot, windowLabel, bus),
    );
    // 재빌드 판정의 기준도 이 스냅샷으로 앞으로 감는다 — 안 감으면 다음 재빌드가 이 핫리로드의
    // 변경까지 "새 변화"로 다시 보게 된다(개발 모드 한정이지만 기준은 한 벌이어야 한다).
    current.snapshot = p.snapshot;
  });

  // 창 포커스 변화·닫힘도 플러그인이 반응할 수 있는 생명주기다. 발신 게이트가
  // 구독자 유무를 이미 보므로, 아무도 안 들으면 이 리스너들은 아무것도 하지 않는다.
  window.addEventListener("focus", () => emitNoteEvent("note:focused"));
  window.addEventListener("blur", () => emitNoteEvent("note:blurred"));
  // 재빌드발 리로드도 pagehide를 일으킨다 — 그때 note:closed를 쏘면 "창이 닫혔다"가
  // 거짓말이 되고(창은 그대로 살아 다시 열린다) 구독자가 상태를 잘못 정리한다.
  let reloading = false;
  window.addEventListener("pagehide", () => {
    if (!reloading) emitNoteEvent("note:closed");
  });

  /**
   * 재빌드 반영을 **리로드로** 한다 — 예전 그대로의 경로.
   *
   * 리로드 **전에** 대기 중인 본문 저장을 확정한다 — 자동저장은 500ms 디바운스라, 그 안에
   * 리로드가 떨어지면 마지막 타이핑이 통째로 유실된다(실측 확인). flush는 대기 중인 저장이
   * 없으면 아무 일도 하지 않으므로 정상 경로에는 부담이 없다.
   */
  const reloadForHostUpdate = (): void => {
    reloading = true;
    note.flushSave();
    // 리로드된 문서가 첫 페인트 전에 지금 색을 되돌리고 안내 문구를 띄울 수 있게 화면 상태를
    // 남긴다(`reload-overlay.ts` → `public/reload-boot.js`). flush 뒤·reload 앞이 유일하게
    // 맞는 자리다: 이 시점의 DOM이 사용자가 마지막으로 본 화면이고, 저장은 이미 확정됐다.
    writeReloadSnapshot(host, t("note.reload.applying-settings"));
    window.location.reload();
  };

  /**
   * 중앙 호스트가 재빌드를 마쳤다(테마·플러그인·설정 변경) — **무조건 리로드하지 않는다**.
   * 새 설정·스냅샷·vault 경로를 재조회해 예전 기준과 비교하고, 이미 재적용 API가 있는 표면만
   * 바뀌었으면 제자리에서 조정한다(창이 살아 있으므로 스크롤·선택·IME 조합이 유지된다).
   * 판정 정본은 `host-update-plan.ts`이고, 원칙은 하나다 — **모르면 리로드**.
   *
   * 재조회는 국소 반영과 같은 최신-우선 큐를 탄다: 재빌드 방송이 연달아 오면 응답이 역순으로
   * 도착할 수 있어, 가장 나중 방송의 응답만 적용하고 그 사이의 사유는 합집합으로 함께 싣는다.
   *
   * 재조회 실패는 국소 반영과 **반대로** 다룬다(그쪽은 조용히 무시). 여기서 무시하면 창이
   * 옛 플러그인·옛 색으로 남은 채 아무도 다시 알려 주지 않는다 — 판정 입력이 없다는 것은
   * "무엇이 바뀌었는지 모른다"이므로 리로드가 맞다(판정기가 null 입력을 리로드로 못박는다).
   */
  const applyHostUpdate = createLocalApplyQueue(
    () =>
      // 셋 다 개별 실패를 값(null)으로 접는다 — 묶음 자체는 실패하지 않는다(큐가 실패를 조용히
      // 버리기 때문에, "못 읽었다"는 사실이 판정기까지 도달해야 리로드로 이어진다).
      //
      // `getSharedSettings`·`getVaultPath`는 순수 IPC라 자체 상한이 없다(`fetchHostSnapshot`과
      // 달리) — 응답이 영영 안 오면 이 `Promise.all`이 스냅샷만으로는 절대 해소되지 않아
      // 판정기까지 입력이 못 간다(창이 옛 상태로 조용히 남는다). `fetchHostSnapshot`과 같은
      // 예산(`SNAPSHOT_BUDGET_MS`)으로 감싸 상한을 맞춘다 — 초과하면 null(=값)로 접는다.
      Promise.all([
        withTimeout(
          getSharedSettings().catch(() => null),
          SNAPSHOT_BUDGET_MS,
        ),
        fetchHostSnapshot({ bus, hostAlive: ensurePluginHost }),
        withTimeout(
          getVaultPath().catch(() => null),
          SNAPSHOT_BUDGET_MS,
        ),
      ]).then(([freshSettings, freshSnapshot, freshVaultPath]) => ({
        settings: freshSettings,
        snapshot: freshSnapshot,
        vaultPath: freshVaultPath,
      })),
    (reasons, fresh) => {
      // 이미 리로드가 결정된 뒤(문서가 곧 파기된다)에 도착한 응답은 버린다.
      if (reloading) return;
      // 경합 가드: dev 핫리로드(EV_HOST_PLUGIN_UPDATED)가 이 재조회보다 먼저 끝나
      // `current.snapshot`을 더 새 revision으로 앞당겨 놨을 수 있다(둘 다 비동기라 완료
      // 순서가 뒤집힐 수 있다). 이 재조회가 그보다 **낮은** revision의 스냅샷을 들고 왔으면,
      // 판정·적용 모두에서 그 낡은 값 대신 이미 아는 최신(`current.snapshot`)을 쓴다.
      //
      // `current` 대입만 막는 가드로는 부족한 이유: `planHostUpdate`가 그 낡은 스냅샷을
      // nextSnapshot으로 비교하면, 실은 핫리로드가 이미 최신을 반영해 아무것도 나빠지지
      // 않았는데도 표면이 "달라졌다"고 오판해 애먼 리로드를 부르거나(prev=최신 vs
      // next=구버전으로 굳는 표면 비교가 어긋나서), extensions/events 단계가 최신 확장을
      // 그 구버전으로 되돌리는 퇴행을 일으킨다. `current.snapshot`을 그대로 재사용하면
      // 비교는 "변화 없음"이 되어 안전하고(핫리로드가 이미 반영한 것을 다시 적용하는 것은
      // 무해하다), settings·vaultPath는 이 스냅샷 경합과 무관하므로 방금 재조회한 최신값을
      // 그대로 쓴다 — 스냅샷이 낡았다는 이유로 방금 읽은 최신 색·글자 크기까지 버릴 이유는
      // 없다.
      const freshSnapshot =
        fresh.snapshot &&
        current.snapshot &&
        fresh.snapshot.revision < current.snapshot.revision
          ? current.snapshot
          : fresh.snapshot;
      const plan = planHostUpdate({
        // 큐는 항목을 문자열로 다루므로 되좁힌다 — 넣은 값이 `parseRebuildReasons`가 검증한
        // 사유뿐이라(아래 리스너) 이 좁힘은 안전하다.
        reasons: reasons as RebuildReason[],
        prevSettings: current.settings,
        nextSettings: fresh.settings,
        prevSnapshot: current.snapshot,
        nextSnapshot: freshSnapshot,
        prevVaultPath: current.vaultPath,
        nextVaultPath: fresh.vaultPath,
      });
      if (plan.action === "reload") {
        reloadForHostUpdate();
        return;
      }
      const snap = freshSnapshot;
      const nextSettings = fresh.settings;
      // 판정기가 이미 보장하는 조건이지만(둘 중 하나가 null이면 reload) 타입을 좁히는 김에
      // 한 번 더 막는다 — 판정기와 적용부가 어긋나도 조용히 반쯤 적용되지는 않는다.
      if (!snap || !nextSettings) {
        reloadForHostUpdate();
        return;
      }
      try {
        applyReconcileSteps(
          plan.steps,
          { settings: nextSettings, snapshot: snap },
          reconcileTarget,
        );
      } catch (e) {
        // 조정 도중 예외 = 반쯤 반영된 화면이다. 그 상태로 두는 것보다 리로드가 낫다.
        console.error(
          "[memo] 호스트 갱신 제자리 반영 실패 — 리로드로 폴백:",
          e,
        );
        reloadForHostUpdate();
        return;
      }
      current.settings = nextSettings;
      current.snapshot = snap;
      current.vaultPath = fresh.vaultPath;
    },
  );
  bus.listen(EV_HOST_UPDATED, (payload) => {
    // 리로드가 이미 결정된 뒤 오는 통지는 무시한다(문서가 곧 파기된다 — 재조회 IPC를 쓸 이유가
    // 없다). 큐 안에서도 한 번 더 본다(그 사이에 결정될 수 있다).
    if (reloading) return;
    applyHostUpdate(parseRebuildReasons(payload));
  });

  // 설정 창이 **국소 반영 가능한 키만** 바꿨다 — 리로드 없이 그 항목만 제자리에서 적용한다
  // (색·전역 글자 크기). 위 EV_HOST_UPDATED와 달리 창은 살아 있으므로 스크롤·선택·IME 조합·
  // 플러그인 상태가 그대로다. 무엇을 어떻게 적용할지는 note-local-apply.ts가 정본이다.
  //
  // 값은 이벤트가 아니라 디스크에서 다시 읽는다(정본 일원화 — 통지 계약 참고). 통지가
  // 연달아 오면 그 재조회 응답이 역순으로 도착할 수 있어(예: 1차=theme_overrides,
  // 2차=font_size 통지인데 2차 응답이 먼저 옴), 큐(`createLocalApplyQueue`)가 항상
  // **가장 나중 통지의 응답**만 적용하고 그 사이 쌓인 키는 합집합으로 함께 싣는다(누락 방지).
  const applyLocalKeys = createLocalApplyQueue(
    () => getSharedSettings().catch(() => null),
    (keys, fresh) => {
      applyLocalSettingChanges(keys, fresh, note);
      // 재빌드 판정의 기준도 함께 앞으로 감는다 — 두 경로가 같은 기준을 보지 않으면, 방금
      // 국소 반영한 색이 다음 재빌드 판정에서 "또 바뀐 것"으로 잡혀 애먼 조정을 부른다
      // (반대로 리로드를 부르지는 않는다 — 그 키는 조정 화이트리스트 안이다).
      current.settings = fresh;
    },
  );
  bus.listen(EV_SETTINGS_CHANGED_LOCAL, (payload) => {
    const keys = (payload as SettingsChangedLocalPayload | null)?.changedKeys;
    // 모르는 키가 하나라도 섞여 있으면 통째로 무시한다(반쯤 반영된 상태를 만들지 않는다).
    // 재조회 IPC보다 **먼저** 거른다 — 어차피 버릴 통지에 왕복을 쓰지 않는다.
    if (!Array.isArray(keys) || !canApplyLocally(keys)) return;
    applyLocalKeys(keys);
  });

  // 복구 화면(설정 창)이 이 노트를 스냅샷으로 복원하면(finding 4), 열려 있는 이 창의 에디터
  // 버퍼를 디스크에서 다시 읽어 반영한다 — 그러지 않으면 낡은 버퍼가 다음 자동저장에서 복원
  // 내용을 조용히 덮는다("복원했어요"가 거짓이 된다). 다른 노트의 복원은 무시(id 일치만).
  bus.listen(EV_NOTE_RESTORED, (payload) => {
    if ((payload as { id?: unknown } | null)?.id === id)
      void note.reloadContent();
  });

  // 백엔드가 이 노트를 지웠다(패널에서 지웠거나, 이 창 자신의 삭제 버튼이 같은 백엔드
  // 커맨드를 탔거나 — 두 경로 다 이 이벤트를 받는다). 대기 중인 자동저장을 먼저 취소한 뒤
  // 스스로 닫는다 — 취소 없이 닫히면(또는 이벤트를 놓쳐 백엔드가 강제로 닫으면) 닫힐 때
  // 나가는 `pagehide` flush가 방금(또는 곧) 지운 `.md`를 되살릴 수 있다
  // (`EV_NOTE_DELETED` 문서 · `note_save_content`의 삭제-후-쓰기 가드가 그 남는 틈을 마저
  // 막는다). 다른 노트의 삭제는 무시(id 일치만). `cancelSave()`는 멱등이고 이미 닫히는 중인
  // 창에 `closeWindow()`를 다시 불러도 무해하다 — 이 창 자신의 삭제 버튼 경로와 겹쳐도
  // 안전하다.
  bus.listen(EV_NOTE_DELETED, (payload) => {
    if ((payload as { id?: unknown } | null)?.id !== id) return;
    note.cancelSave();
    void closeWindow().catch(() => {});
  });

  // 창을 세로로 끌어 접힘/펼침이 뒤집히면(백엔드가 리사이즈 실측으로 판정 — 아래
  // saveWindowGeometry가 그 입력이다) 이 창의 버튼·에디터 표시를 그 결과에 맞춘다. 창 높이와
  // 메타는 이미 백엔드가 확정했으므로 되돌려 부르지 않는다(EV_NOTE_COLLAPSED_CHANGED 문서).
  // 다른 노트의 전이는 무시(id 일치만).
  bus.listen(EV_NOTE_COLLAPSED_CHANGED, (payload) => {
    const p = payload as { id?: unknown; collapsed?: unknown } | null;
    if (p?.id !== id || typeof p.collapsed !== "boolean") return;
    note.syncCollapsed(p.collapsed);
  });

  // 창을 옮기거나 크기를 바꾸면 위치/크기를 노트 메타에 영속화(디바운스).
  onWindowGeometryChange(debounce(() => void saveWindowGeometry(id), 400));
}
