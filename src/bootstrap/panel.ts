/**
 * 노트 목록·검색 패널(`?panel`) 부트스트랩 — 트레이 "노트 목록·검색"으로 열린 창.
 *
 * `main.ts`가 동적 `import()`로만 이 모듈을 로드한다(이슈 #26) — `mountPanel`은 이 창에서만
 * 필요하고, 노트·설정·플러그인호스트 창은 이 청크를 내려받지 않는다.
 *
 * 언어: `src/panel`도 t()를 쓴다 — 노트 창과 같은 패턴으로 로케일을 확정한다: 번들 언어팩은
 * 로컬에서 직접 읽고(`i18n/packs.ts`), 서드파티 언어팩은 코어(Rust)가 설치 매니페스트를
 * 스캔해 주는 IPC(`readLocaleEntries`)로 읽어 **둘 다 첫 페인트 전에** 등록한다. 호스트
 * 스냅샷은 언어를 나르지 않으므로 여기서 스냅샷을 기다릴 이유가 없다. 예전에는 이 창이
 * SharedSettings조차 읽지 않아 언어 설정과 무관하게 항상 ko로 떴다(갭 수복).
 *
 * 색: 이 창은 자기 전용 표면 토큰(`panel`·`panel-text`, `theme/theme.ts`)을 쓴다. 값은 공유
 * 설정의 `theme_overrides`에서 나오므로 위 설정 읽기에 얹혀 오고, 첫 페인트 전에 적용된다
 * (추가 IPC 왕복 0 — 이 창의 지연 없는 첫 페인트를 지킨다).
 */
import { mountPanel } from "../panel/panel";
import { resolveLanguage } from "../i18n/detect";
import { loadActiveBundledLocale } from "../i18n/packs";
import { registerLocale, setActiveLocale } from "../i18n/store";
import {
  EV_HOST_UPDATED,
  EV_NOTES_LIST_CHANGED,
  EV_SETTINGS_CHANGED_LOCAL,
  type SettingsChangedLocalPayload,
} from "../plugin/host-protocol";
import {
  createAndOpenNote,
  getPanelSort,
  getSharedSettings,
  listBuiltinStates,
  noteDelete,
  noteList,
  noteRead,
  noteSearch,
  noteSetFavorite,
  openSettings,
  readLocaleEntries,
  setPanelSort,
  summonNote,
} from "../shared/tauri";
import { applyTheme, mergeThemeOverrides, SJ_D } from "../theme/theme";
import {
  activeThemeOverrides,
  createLocalApplyQueue,
} from "./note-local-apply";
import { ensureGuideNote, tauriGuideNoteIO } from "./guide-note";
import { tauriBus } from "./shared";

/** [`applyPanelTheme`]가 읽는 설정의 최소 표면(`SharedSettings`가 구조적으로 대입된다). */
interface PanelThemeSettings {
  theme?: string;
  theme_overrides?: Record<string, Record<string, string>>;
}

/**
 * 활성 테마의 사용자 색 오버라이드를 이 창의 CSS 변수로 얹는다.
 *
 * export하지 않는 이유: 검증은 `panel.test.ts`가 `bootstrapPanel`을 통째로 돌려 <html>에 실제로
 * 얹힌 변수를 보는 쪽이 낫다 — 배선(마운트 시 1회 + 국소 변경 시 재적용)까지 함께 지켜지고,
 * 미사용 export도 남지 않는다(knip).
 *
 * 베이스가 항상 [`SJ_D`]인 이유: 이 창은 중앙 호스트 스냅샷을 받지 않으므로(첫 페인트를
 * 늦추지 않으려는 의도적 결정 — 위 모듈 주석) 서드파티 **테마 플러그인의 팔레트는 여기까지
 * 오지 않는다**. 그건 이 변경 이전과 똑같은 상태다(그때 패널은 아무 테마도 적용하지 않아
 * 스타일시트 폴백 = SJ_D 기본값으로 그려졌다). 여기서 새로 생기는 것은 **사용자 오버라이드가
 * 반영된다**는 점 하나다. 호스트가 살아 있을 때만 스냅샷을 얹는 비차단 2단계는 지금 배선할 수
 * 없다 — 스냅샷 조회가 요구하는 생존 확인기(`hostAlive`)로 쓸 수 있는 것이 `ensurePluginHost`
 * 뿐인데, 그건 확인이 아니라 **없으면 호스트 창을 새로 띄우는** 함수라 "패널을 열었더니 숨은
 * 창이 하나 뜬다"가 된다. 가벼운 생존 확인 IPC가 생기면 그때 얹으면 된다.
 *
 * `SJ_D`가 모든 토큰을 공급하므로 병합 결과에도 토큰이 전부 있다 — 노트 창(`note-window.ts`)이
 * 하는 "사라진 오버라이드의 인라인 변수 청소"가 여기서는 필요 없다(매번 전부 덮어쓴다).
 */
function applyPanelTheme(
  root: HTMLElement,
  settings: PanelThemeSettings | null | undefined,
): void {
  applyTheme(root, mergeThemeOverrides(SJ_D, activeThemeOverrides(settings)));
}

/** 노트 목록·검색 패널을 마운트한다(트레이 "노트 목록·검색"으로 열린 창). */
export async function bootstrapPanel(host: HTMLElement): Promise<void> {
  host.classList.add("panel-root");
  const bus = tauriBus();
  // **이 창은 더 이상 중앙 호스트 스냅샷을 받지 않는다.** 이 창이 스냅샷을 기다린 이유는
  // 오직 하나, 언어팩이 그 스냅샷에 실려 왔기 때문이었다 — 패널은 플러그인 버튼도 CM 확장도
  // 그리지 않아 그 밖에는 쓸 조각이 없었다. 언어팩이 코어·로컬 직로드로 옮겨간 지금, 이
  // 창의 첫 페인트를 최대 THEME_WAIT_MS 늦추던 레이스가 통째로 사라졌다.
  const [settings, builtinStates, initialSort] = await Promise.all([
    getSharedSettings().catch(() => null),
    // 번들 언어팩 활성 판정의 입력 — 가벼운 백엔드 조회라 설정 읽기와 나란히 띄운다.
    // 실패는 빈 맵이 아니라 null("모른다") — 노트 창과 같은 원칙이다.
    listBuiltinStates().catch(() => null as Record<string, boolean> | null),
    // 저장된 목록 정렬 모드 — 첫 렌더부터 맞는 순서로 그리려면 마운트 **전에** 있어야 하므로
    // 위 두 조회와 나란히 띄운다(직렬로 세우면 그만큼 첫 페인트가 늦는다). 실패·미지원
    // 백엔드는 빈 문자열로 떨어뜨리고, 어휘 판정(=기본값 폴백)은 panel.ts가 한다.
    getPanelSort().catch(() => ""),
  ]);
  // 색은 언어보다 먼저 얹는다 — 아래 언어팩 등록은 await가 몇 번 더 걸리므로, 그 사이에
  // 브라우저가 페인트하면 기본색으로 한 번 그렸다가 바뀌는 깜빡임이 생긴다.
  applyPanelTheme(document.documentElement, settings);
  const language = resolveLanguage(settings?.language);
  // 번들 언어팩(로컬 직로드) → 서드파티 언어팩(코어 스캔 IPC) 순으로 등록한다. 순서가
  // 뒤집혀도 registerLocale이 보호 코드를 거부하므로 번들이 이긴다(노트 창과 같은 배선 —
  // 그쪽 주석에 각 단계의 근거가 있다).
  //
  // 설치 팩 IPC는 번들 팩 로드와 **나란히** 띄운다(둘 다 첫 페인트를 막으므로 직렬로 세우면
  // 그만큼 늦어진다). ko면 부르지 않는다 — 코어 내장이라 언어팩이 공급할 수 없다.
  const installedEntries =
    language === "ko" ? null : readLocaleEntries(language).catch(() => null);
  await loadActiveBundledLocale(language, builtinStates);
  const entries = await installedEntries;
  if (entries && Object.keys(entries).length > 0) {
    // 라벨은 이 창에서 표시에 쓰이지 않아(드롭다운은 설정 창만 그린다) 코드를 그대로 쓴다.
    registerLocale(language, language, entries);
  }
  setActiveLocale(language);

  // 중앙 호스트가 재빌드를 마치면(언어·테마 등 변경) 이 패널도 리로드해 반영한다 — 노트 창
  // (note.ts)과 같은 패턴이다. 노트 창과 달리 이 창은 저장 대기 중인 본문이 없어 flushSave
  // 없이 바로 reload()한다.
  bus.listen(EV_HOST_UPDATED, () => window.location.reload());

  // 설정 창에서 **색만** 바뀐 저장은 재빌드 채널을 타지 않고 이 국소 채널로 온다
  // (`theme_overrides`가 LOCAL_APPLY_KEYS라 EV_HOST_UPDATED가 나지 않는다) — 구독하지 않으면
  // 패널만 옛 색으로 남았다. 값은 실려 오지 않으므로 최신 설정을 재조회하고, 응답 역순 도착에
  // 대비해 노트 창과 같은 최신 우선 큐를 쓴다.
  const applyLatestTheme = createLocalApplyQueue(
    () => getSharedSettings().catch(() => null),
    (_keys, latest) => applyPanelTheme(document.documentElement, latest),
  );
  bus.listen(EV_SETTINGS_CHANGED_LOCAL, (payload) => {
    const keys =
      (payload as SettingsChangedLocalPayload | null)?.changedKeys ?? [];
    // 이 창이 반영할 수 있는 키는 색 하나뿐이다 — 글자 크기·폰트·툴바는 패널에 소비처가
    // 없으므로, 섞여 와도 색만 골라 적용하고 나머지는 그냥 흘린다(무시해도 잃는 것이 없다).
    if (!keys.includes("theme_overrides")) return;
    applyLatestTheme(keys);
  });

  await mountPanel(host, {
    listNotes: () => noteList(),
    searchNotes: (query) => noteSearch(query),
    summon: (id) => void summonNote(id),
    // 소환 전 존재 확인 — 이미 지워진 노트를 열어 빈 창이 뜨는 먹통을 막는다(noteRead가
    // 없는 id에 reject하는 것을 그대로 존재 판정으로 쓴다).
    noteExists: (id) =>
      noteRead(id).then(
        () => true,
        () => false,
      ),
    deleteNote: (id) => noteDelete(id),
    // 노트 창의 삭제/보관/저장(tauri.ts가 성공 시 emit)이나 패널 자신의 삭제가 나면 목록을
    // 다시 그린다 — EV_HOST_UPDATED(플러그인 재빌드)와 별개의 가벼운 채널.
    onNotesChanged: (handler) => bus.listen(EV_NOTES_LIST_CHANGED, handler),
    // "+" 버튼 — 새 노트를 만들고 그 창을 연다(베타 피드백). 성공하면 백엔드가 직접
    // notes-list-changed를 emit하므로 위 onNotesChanged 구독이 목록을 자동으로 다시 그린다.
    createAndOpenNote: () => createAndOpenNote(),
    // 설정(톱니) 버튼 — 검색창 줄에서 바로 설정 창을 연다(베타 피드백). 실패는 panel.ts가
    // 콘솔 로그만 남기고 흡수한다(노트 툴바의 설정 버튼과 같은 처리).
    openSettings: () => openSettings(),
    // 즐겨찾기(별) 버튼 — noteSetFavorite이 성공 시 프론트에서 notes-list-changed를
    // 방송하므로(tauri.ts의 afterNotesChanged) 다른 창의 패널·트레이도 함께 갱신된다.
    // 이 창 자신은 그 신호(디바운스 300ms)를 기다리지 않고 panel.ts가 곧바로 다시 읽는다.
    toggleFavorite: (id, favorite) => noteSetFavorite(id, favorite),
    initialSort,
    // 정렬 선택 영속화 — 실패해도 이번 세션의 화면 정렬은 이미 바뀌어 있고 다음 변경에서
    // 다시 시도되므로, 패널을 방해하지 않고 콘솔 로그만 남긴다(openSettings와 같은 처리).
    saveSort: (mode) => {
      void setPanelSort(mode).catch((err: unknown) => {
        console.error("[panel] setPanelSort failed", err);
      });
    },
  });

  // 첫 실행이면 「시작 가이드」 메모를 만들고 그 창을 연다 — 시작 흐름이 자동시작·점프리스트가
  // 아닌 한 **이 창을 항상** 열기 때문에(`lib.rs`의 `startup_plan` D1) 진짜 첫 실행은 여기서
  // 만들어진다. 목록은 생성 신호(`notes-list-changed`)로 저절로 다시 그려지므로 여기서
  // 따로 갱신하지 않는다. 마운트 **뒤에** 두는 이유: 이 부가 작업의 IPC 왕복이 목록의 첫
  // 페인트를 늦춰서는 안 된다(실패해도 패널은 이미 떠 있다 — `ensureGuideNote`가 삼킨다).
  void ensureGuideNote(tauriGuideNoteIO(), { summon: true });
}
