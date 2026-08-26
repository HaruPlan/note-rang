/**
 * Tauri IPC 래퍼.
 *
 * 역할: 프론트가 백엔드 커맨드/창 API를 호출하는 유일한 경계(STYLE.md). UI 코드는 이
 * 래퍼만 통해 호출하고 invoke 세부는 알지 않는다.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EV_NOTES_LIST_CHANGED,
  EV_NOTES_RELOAD,
  EV_REQUEST_OPEN_SETTINGS,
} from "../plugin/host-protocol";
import type {
  NotesReloadPayload,
  RebuildReason,
  TrayItemDescriptor,
} from "../plugin/host-protocol";
import type { ToolbarLayout } from "../note/toolbar-layout";

/**
 * 앱 버전(`tauri.conf.json`의 `version`)을 읽는다 — 두 소비처가 같은 값을 봐야 한다:
 * `memo.runtime.info().hostVersion`(플러그인 계약)과 매니페스트 `minHostVersion` 게이트.
 *
 * 읽지 못하면 **빈 문자열**이다(지어낸 값을 주지 않는다). 빈 문자열의 뜻은 "모른다"이고,
 * 두 소비처 모두 그때는 판정을 포기하는 쪽(경고 없음·분기 없음)으로 폴백한다 — 틀린 버전으로
 * 분기한 플러그인이나 정상 플러그인을 막는 경고보다 침묵이 낫다.
 *
 * 경계에서 정규화한다: 이 커맨드를 모르는 런타임(구버전 백엔드·e2e 목)은 문자열이 아니라
 * null을 돌려주는데, 그대로 통과시키면 `runtime.info().hostVersion`이 선언 타입과 어긋난다.
 */
export function getAppVersion(): Promise<string> {
  return getVersion().then(
    (v) => (typeof v === "string" ? v : ""),
    () => "",
  );
}

/** 창 전체 알파(투명도)를 percent(0~100, 백엔드가 30~100 클램프)로 설정한다. */
export function setWindowAlpha(percent: number): Promise<void> {
  return invoke("set_window_alpha", { percent });
}

/** 창을 항상 위에 표시할지 설정한다. */
export function setAlwaysOnTop(on: boolean): Promise<void> {
  return invoke("set_always_on_top", { on });
}

/** 창을 모든 Space(가상 데스크탑)에 표시할지 설정한다. */
export function setVisibleOnAllSpaces(on: boolean): Promise<void> {
  return invoke("set_visible_on_all_spaces", { on });
}

/** 노트별 override(각 필드 null이면 전역 기본값 상속). Rust `NoteOverrides`와 일치. */
export interface NoteOverrides {
  transparency: number | null;
  background: unknown | null;
  /** 메모별 글자 크기 델타(%). 전역 기본에 더해진다. 폰트 플러그인이 조절. */
  font_delta: number | null;
  markdown_preview: boolean | null;
  pinned: boolean | null;
  all_spaces: boolean | null;
  collapsed: boolean | null;
}

/** 노트 사이드카 메타(소비에 필요한 필드만 좁게 선언). */
interface NoteMeta {
  overrides: NoteOverrides;
}

/** 노트 한 건(본문 + 메타). */
interface NoteData {
  content: string;
  meta: NoteMeta;
}

/** 노트 본문+메타를 읽는다. */
export function noteRead(id: string): Promise<NoteData> {
  return invoke("note_read", { id });
}

/**
 * 노트 목록이 바뀔 수 있는 호출(생성·삭제·보관·저장) 뒤에 성공하면
 * [`EV_NOTES_LIST_CHANGED`]를 방송한다 — 열려 있는 패널이 이 신호로 목록을 다시 읽는다
 * (`settings.ts`의 `reloadAfter`와 같은 "성공 시 신호" 패턴).
 *
 * 값은 그대로 통과시킨다(`noteDuplicate`처럼 새 id를 돌려주는 호출도 감쌀 수 있도록).
 * 실패(reject)면 신호를 보내지 않는다 — 목록이 실제로 안 바뀌었으니 패널이 헛수고로
 * 다시 읽을 이유가 없다.
 */
function afterNotesChanged<T>(p: Promise<T>): Promise<T> {
  return p.then((value) => {
    void emit(EV_NOTES_LIST_CHANGED);
    return value;
  });
}

/** 노트 본문을 저장한다(원자적). 제목(본문 첫 줄)이 바뀌었을 수 있어 패널에도 신호를 보낸다. */
export function noteSaveContent(id: string, content: string): Promise<void> {
  return afterNotesChanged(invoke<void>("note_save_content", { id, content }));
}

/**
 * 현재 창 위치/크기를 노트 메타에 저장한다(드래그/리사이즈 후).
 *
 * 거부를 여기서 흡수한다(콘솔 경고만 남기고 resolve): 호출부(`bootstrap/note.ts`)는 창
 * 이동·리사이즈마다(디바운스) 이 함수를 `void`로 fire-and-forget 부른다 — 노트가 마침 삭제·
 * 보관되는 중이라 메타 파일이 사라졌거나, 동기화 폴더·백신이 잠깐 파일을 잠그는 등으로
 * 백엔드가 거부하면, 흡수하지 않을 경우 처리되지 않은 프라미스 거부가 되어 노트창 전역 오류
 * 오버레이(`note-window.ts`의 `installNoteErrorOverlay`)를 **리사이즈 한 번만으로** 띄운다.
 * 지오메트리 저장 실패는 치명적이지 않다 — 다음 이동·리사이즈에서 다시 시도된다.
 */
export function saveWindowGeometry(id: string): Promise<void> {
  return invoke<void>("save_window_geometry", { id }).catch((err: unknown) => {
    console.warn("[tauri] saveWindowGeometry failed", err);
  });
}

/**
 * 노트 헤더 접기(숨김이 아니라 높이만 조절)를 설정한다.
 * 접으면 현재 높이를 보관하고 접힘 높이로 축소, 펼치면 보관 높이로 복원한다(백엔드가 관리).
 *
 * 거부를 여기서 흡수한다(콘솔 경고만 남기고 resolve) — [`saveWindowGeometry`]와 같은 이유다.
 * 접기/펼치기는 창 크기를 바꾸는 동작이라 `saveWindowGeometry`와 같은 경합(삭제 중·파일 잠금)에
 * 노출되고, 호출부(`note-window.ts`의 `applyCollapsed`)도 반환값을 기다리지 않는 fire-and-forget
 * 경로다. 실패해도 툴바 토글 UI는 이미 로컬로 반영돼 있어 사용자가 체감하는 손해는 없다.
 */
export function setNoteCollapsed(
  id: string,
  collapsed: boolean,
): Promise<void> {
  return invoke<void>("set_note_collapsed", { id, collapsed }).catch(
    (err: unknown) => {
      console.warn("[tauri] setNoteCollapsed failed", err);
    },
  );
}

/**
 * 현재 창의 OS 타이틀을 읽는다 — 접힌 노트 헤더 가운데 라벨("어느 메모인가")이 쓴다.
 *
 * 왜 새 IPC 커맨드를 만들지 않는가: 이 타이틀은 이미 본문 첫 줄에서 파생돼 저장 때마다
 * 갱신된다(`window_manager::window_title_for_content` ← `refresh_window_title`) — 패널·검색·
 * 트레이가 보여주는 제목과 **같은 규칙**(빈 노트는 앱 이름, 40자 절단)이다. 창이 이미 들고
 * 있는 값을 되읽는 편이 같은 파생을 프론트에 한 벌 더 두는 것보다 어긋날 여지가 없다.
 *
 * 경계에서 정규화한다([`getAppVersion`]과 같은 관례): 이 API를 모르는 런타임(e2e 목)은
 * 문자열이 아니라 null을 돌려주는데, 그대로 통과시키면 라벨에 "null"이 뜬다. 실패·비문자열은
 * 모두 **빈 문자열**(="모른다")이고, 호출부는 그때 라벨을 갱신하지 않는다(이전 값 유지).
 */
export function getWindowTitle(): Promise<string> {
  return getCurrentWindow()
    .title()
    .then(
      (v) => (typeof v === "string" ? v : ""),
      () => "",
    );
}

/** 현재 borderless 창의 네이티브 드래그 이동을 시작한다. */
export function startDragging(): Promise<void> {
  return getCurrentWindow().startDragging();
}

/** 현재 창의 이동/리사이즈가 끝날 때 handler를 호출한다(위치 영속화 트리거). */
export function onWindowGeometryChange(handler: () => void): void {
  const win = getCurrentWindow();
  void win.onMoved(handler);
  void win.onResized(handler);
}

/** 노트별 override를 저장한다(창 위치 등은 백엔드가 보존). */
export function noteSaveOverrides(
  id: string,
  overrides: NoteOverrides,
): Promise<void> {
  return invoke("note_save_overrides", { id, overrides });
}

/** 노트를 삭제한다(본문·메타·첨부). 성공하면 패널이 목록을 다시 그리도록 신호를 보낸다. */
export function noteDelete(id: string): Promise<void> {
  return afterNotesChanged(invoke<void>("note_delete", { id }));
}

/** 노트를 복제한다 — 내용·설정(override)이 같은 새 노트를 만들고 새 id를 돌려준다(복제 플러그인). */
export function noteDuplicate(id: string): Promise<string> {
  return afterNotesChanged(invoke<string>("note_duplicate", { id }));
}

/** 노트를 보관한다(hidden=true) — 닫기(영구 삭제가 아님, 목록·소환 유지). */
export function noteArchive(id: string): Promise<void> {
  return afterNotesChanged(invoke<void>("note_archive", { id }));
}

/**
 * 노트의 즐겨찾기(`NoteMeta.favorite`)를 켜고 끈다 — 패널 목록에서 상단 묶음으로 올라간다.
 *
 * 신호는 [`noteArchive`]와 **똑같이 프론트에서** 낸다([`afterNotesChanged`]): 백엔드
 * `note_set_favorite`은 `note_archive`가 그렇듯 아무것도 emit하지 않는다. 양쪽이 다 내면
 * 같은 `notes-list-changed`가 중복 방송돼 패널·트레이가 목록을 두 번씩 다시 읽는다.
 */
export function noteSetFavorite(id: string, favorite: boolean): Promise<void> {
  return afterNotesChanged(invoke<void>("note_set_favorite", { id, favorite }));
}

/**
 * 임의 노트 하나의 본문을 쓴다 — 플러그인 브리지 `memo.notes.write`의 백엔드(Rust `note_write`).
 *
 * `mode`: `"append"`(끝에 이어붙임, 비파괴) 또는 `"overwrite"`(통째 덮음 — Rust `Vault`가 덮기
 * 전에 복구 슬롯에 스냅샷을 남긴다). id 검증(경로 형태 거부)은 **호출 전**에 브리지 수행부
 * (`central-host.ts`)가 한다 — `noteRead`와 같은 관문. 소비처는 그 수행부 하나다(`tauriNotesBackend`).
 */
export function noteWrite(
  id: string,
  content: string,
  mode: string,
): Promise<void> {
  return invoke("note_write", { id, content, mode });
}

/**
 * 복구 슬롯 스냅샷 한 건의 요약(Rust `trash::Snapshot`과 일치 — snake_case가 IPC 경계를 넘는다).
 *
 * `preview`·`title`은 스냅샷 본문(플러그인이 쓴 내용일 수 있는 **신뢰 경계 밖** 문자열)에서
 * 파생된 값이라, 화면에 그릴 때는 반드시 `textContent`로만 쓴다(innerHTML 금지).
 */
export interface NoteSnapshot {
  /** 스냅샷 식별자(파일 stem) — 읽기·복원에 그대로 되돌려 준다. */
  id: string;
  /** 캡처 시각(에폭 ms). 0이면 시각 미상(손으로 둔 파일 등). */
  captured_at: number;
  /** 본문 첫 줄에서 파생한 제목(목록 표시용). */
  title: string;
  /** 본문 앞부분 미리보기(짧은 요약 — 신뢰 경계 밖). */
  preview: string;
  /** 스냅샷 본문의 바이트 크기. */
  bytes: number;
}

/**
 * 노트의 복구 슬롯 스냅샷 목록을 최신순으로 읽는다(복구 UI가 되돌릴 버전을 고르는 데 쓴다).
 * 스냅샷이 없거나 노트가 없으면 빈 배열이다(오류가 아님).
 */
export function noteListSnapshots(id: string): Promise<NoteSnapshot[]> {
  return invoke("note_list_snapshots", { id });
}

/**
 * 복구 슬롯에 스냅샷을 가진 모든 노트 id를 열거한다(삭제된 노트 포함) — 복구 UI가 존재하는
 * 노트뿐 아니라 **삭제된 노트의 스냅샷**도 찾을 수 있게 한다(finding 2). 없으면 빈 배열.
 */
export function noteListSnapshotNoteIds(): Promise<string[]> {
  return invoke("note_list_snapshot_note_ids");
}

/** 복구 슬롯 스냅샷 하나의 본문을 읽는다(미리보기용). 없으면 reject. */
export function noteReadSnapshot(
  id: string,
  snapshotId: string,
): Promise<string> {
  return invoke("note_read_snapshot", { id, snapshotId });
}

/**
 * 노트 본문을 특정 스냅샷으로 되돌린다(파괴적 — 현재 본문을 스냅샷 본문으로 덮는다).
 * 백엔드가 되돌리기 직전 현재 본문을 다시 스냅샷하므로, 복원 자체도 다시 되돌릴 수 있다.
 */
export function noteRestoreSnapshot(
  id: string,
  snapshotId: string,
): Promise<void> {
  return invoke("note_restore_snapshot", { id, snapshotId });
}

/** 현재 창을 닫는다(삭제 후 등). */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

/**
 * 현재 실행 중인 OS 식별자를 읽는다("macos"·"windows"·"linux" 등, Rust `std::env::consts::OS`).
 * 플러그인의 OS 지원 판정(자동 비활성화·배지)에 쓴다. 실패 시 호출부가 빈 문자열로 폴백한다.
 */
export function getPlatform(): Promise<string> {
  return invoke("get_platform");
}

/** 백엔드가 열거한 시스템 설치 글꼴 한 벌. */
interface SystemFont {
  /** CSS `font-family`에 쓸 수 있는 패밀리 이름. */
  family: string;
  /** 한글 글리프를 담고 있는지(설정 피커의 「한글」 구역 판정). */
  korean: boolean;
  /** 지역화 이름(영문 이름과 다를 때만) — 표시가 아니라 검색어로만 쓴다. */
  alias: string | null;
}

/**
 * OS에 설치된 글꼴을 열거한다(설정 글꼴 피커의 「설치된 글꼴」 후보).
 *
 * 웹뷰에는 로컬 글꼴 열거 API가 없어 백엔드가 폰트 파일에서 직접 읽는다. 실패 시 호출부가
 * 빈 배열로 폴백한다(피커는 플러그인이 공급한 후보만 보여 준다).
 */
export function listSystemFonts(): Promise<SystemFont[]> {
  return invoke("list_system_fonts");
}

/** 공유 전역 설정(테마·기본값). */
interface SharedSettings {
  schema_version: number;
  theme: string;
  /** 테마별 사용자 색 오버라이드(테마명 → 토큰 → hex). 구버전 파일엔 없을 수 있다. */
  theme_overrides?: Record<string, Record<string, string>>;
  /** 동작 id → 키 가속기(창 단위 도구 단축키). 노트 창이 읽어 키맵을 설치. 구버전 파일엔 없을 수 있다. */
  keybindings?: Record<string, string>;
  /** 툴바 버튼 배치(설정 창 드래그&드롭). 구버전 파일엔 없을 수 있다(없으면 기본 배치). */
  toolbar_layout?: ToolbarLayout;
  /**
   * 사용자가 고른 툴바 스타일(닫기 버튼 좌/우) — `"mac"` | `"windows"`. 이슈 #16의 최초 실행
   * 프롬프트(`note/toolbar-style-prompt.ts`)가 한 번 고르면 채우는 "이미 물어봤다" 플래그를
   * 겸한다 — 이 필드가 있으면(값이 뭐든) 다시 묻지 않는다. 구버전 파일엔 없을 수 있다(없으면
   * 아직 고른 적 없음 → 프롬프트 대상, 단 `toolbar_layout`을 이미 커스터마이즈해 뒀다면 그
   * 배치를 존중해 역시 묻지 않는다 — `maybeShowToolbarStylePrompt` 참고).
   */
  toolbar_style?: string | null;
  /** UI 언어 로케일 코드(예 `"ko"`). 구버전 파일엔 없을 수 있다(없으면 ko가 기본). */
  language?: string | null;
  /**
   * 「시작 가이드」 메모의 노트 id — 설정 「도움말」이 소환할 대상. 없으면 아직 만든 적 없다.
   *
   * **읽기 전용으로 다룬다**: 값을 정하는 것은 [`claimGuideNote`](코어)뿐이고, 프론트가
   * `saveSharedSettings`로 보내는 값은 코어가 지금 값으로 되돌린다(`commands.rs`의
   * `commit_shared_settings`) — 가이드 생성 **전에** 읽어 둔 설정 스냅샷이 나중에 저장되며
   * 방금 기록된 id를 지우는 경로를 경계에서 닫아 둔 것이다.
   */
  guide_note_id?: string | null;
  defaults: unknown;
}

/** 공유 전역 설정을 읽는다(테마 등). */
export function getSharedSettings(): Promise<SharedSettings> {
  return invoke("get_shared_settings");
}

/** 공유 전역 설정을 저장한다(테마 변경 등) — 설정 창에서 사용. */
export function saveSharedSettings(settings: SharedSettings): Promise<void> {
  return invoke("save_shared_settings", { newSettings: settings });
}

/** 전역 "새 노트" 단축키(기기 고유, LocalConfig)를 읽는다 — 설정 UI 표시용. */
export function getGlobalHotkey(): Promise<string> {
  return invoke("get_global_hotkey");
}

/**
 * 전역 "새 노트" 단축키를 바꾼다(Tauri 가속기 문자열, 예 `"CmdOrCtrl+Shift+N"`).
 * 백엔드가 새 조합을 먼저 등록해 검증하고, 실패하면 reject(이전 단축키 유지)한다.
 */
export function setGlobalHotkey(accel: string): Promise<void> {
  return invoke("set_global_hotkey", { accel });
}

/**
 * 활성 노트(hidden=false) 0개로 시작했을 때 무엇을 띄울지(기기 고유, LocalConfig)를 읽는다.
 *
 * `"panel"`(목록만) | `"new-note"`(새 노트 + 목록) — 백엔드는 이 두 값만 알고, 그 외로
 * 저장돼 있으면 `"panel"`로 해석한다. 설정 창의 드롭다운이 이 값을 보여준다.
 */
export function getStartupNoActiveAction(): Promise<string> {
  return invoke("get_startup_no_active_action");
}

/**
 * 활성 노트 0개 시작 동작을 저장한다. 백엔드가 어휘(`"panel"`/`"new-note"`)를 검증하고,
 * 그 외 값은 reject한다(이전 값 유지).
 */
export function setStartupNoActiveAction(action: string): Promise<void> {
  return invoke("set_startup_no_active_action", { action });
}

/**
 * 패널 목록의 정렬 모드 문자열(기기 고유, LocalConfig)을 읽는다.
 *
 * 백엔드는 이 문자열의 **의미를 모르고** 왕복만 한다(빈 값·과도한 길이만 거부) — 어휘와
 * 해석은 전적으로 프론트(`panel.ts`의 `parsePanelSort`)가 쥔다. 그래서 모르는 값이 저장돼
 * 있어도 화면은 기본 정렬로 조용히 접힌다.
 */
export function getPanelSort(): Promise<string> {
  return invoke("get_panel_sort");
}

/** 패널 목록의 정렬 모드를 저장한다(드롭다운 변경 시). */
export function setPanelSort(sort: string): Promise<void> {
  return invoke("set_panel_sort", { sort });
}

/**
 * `select` 선택지 하나의 **정본 형태**(Rust `PluginSettingOption::Full`과 일치).
 *
 * 저장되는 값은 언제나 `value`, 사용자에게 보이는 것은 언제나 `label`이다.
 * 왜: 예전에는 `options: string[]`이라 **저장 값 = 표시 라벨**이었다 — 라벨을 다듬는 순간
 * 저장된 값이 고아가 되고, 플러그인은 한국어 라벨을 코드값으로 되돌리는 매핑 테이블을
 * 스스로 들어야 했다(번들 `template`이 실제로 두 개를 들고 있었다).
 */
export interface PluginSettingOption {
  /** 저장·비교에 쓰는 안정 값(영문 slug 권장). */
  value: string;
  /** 폼에 보이는 문구. 생략하면 `value`를 쓴다. */
  label?: string;
  /** 선택지 아래에 보일 짧은 설명(선택). */
  description?: string;
}

/** 플러그인이 매니페스트로 선언하는 설정 필드 하나(Rust `PluginSettingField`와 일치). */
export interface PluginSettingField {
  /** 저장 키(값 맵·UI 입력의 식별자). */
  key: string;
  /** UI 라벨. */
  label: string;
  /** 위젯 종류: text | textarea | toggle | select | list | number | button. */
  type:
    "text" | "textarea" | "toggle" | "select" | "list" | "number" | "button";
  /** 기본값(text/textarea/list→문자열, toggle→불리언, number→수, select→options의 value 중 하나). */
  default?: unknown;
  /**
   * select 선택지(그 외 타입은 빈 배열).
   *
   * `string[]` 축약형은 `{ value: s, label: s }`의 줄임으로 재해석한다 — 기존 매니페스트는
   * 무변경으로 유효하다. 정규화는 `shared/plugin-settings.ts`의 `settingOptions`가 한다.
   */
  options: (string | PluginSettingOption)[];
  /** number 전용: 하한(선택 — 값은 이 아래로 내려가지 않게 클램프된다). */
  min?: number;
  /** number 전용: 상한(선택). */
  max?: number;
  /** number 전용: 스피너 증감 폭(선택 — 표시 전용, 값 검증에는 쓰지 않는다). */
  step?: number;
  /** 제목 아래에 보일 도움말(선택 — 예: 사용 가능한 치환 변수 안내). */
  description?: string;
  /** text/textarea 전용: 입력 placeholder(선택). */
  placeholder?: string;
  /** list 전용: 한 항목의 단수 명칭(추가 버튼·빈 상태 문구). 예 "템플릿"(선택). */
  itemLabel?: string;
  /** list 전용: 항목 이름 input placeholder(선택). */
  itemNamePlaceholder?: string;
  /** list 전용: 항목 본문 textarea placeholder(선택). */
  itemBodyPlaceholder?: string;
  /** list 전용: 본문에 삽입 가능한 키워드 칩(클릭 시 커서 위치에 token 삽입, 선택). */
  hints?: { token: string; label?: string }[];
  /**
   * button 전용(필수): 누르면 실행할 **명령 id**(`memo.commands.register`가 등록한 것).
   *
   * 왜 새 콜백 API(`settings.onAction`)가 아니라 명령 id인가: 역호출 경로를 두 벌 만들지
   * 않기 위해서다. 버튼을 누르면 단축키로 그 명령을 실행한 것과 **완전히 같은 절차**를 탄다
   * (같은 핸들러·같은 진단·같은 권한 게이트). 새 경로를 만들면 "버튼에서는 되는데 단축키로는
   * 안 된다" 류의 비대칭이 생기고, 그 비대칭은 이 저장소가 이미 여러 번 겪은 모양이다.
   */
  command?: string;
  /**
   * button 전용(선택): 누른 뒤 실행 **전에** 설정 창이 띄울 확인 문구.
   *
   * 설정 창에는 노트 창의 확인 팝업이 없으므로 확인은 여기서 끝낸다 — 그래서 명령 쪽
   * `destructive`와 역할이 겹치지 않는다(그쪽은 노트 창 팝업이고, 설정 버튼 경로에는 띄울
   * 창이 없어 호스트가 실행을 거부한다).
   */
  confirm?: string;
}

/** 플러그인 설치 출처(Rust `PluginSource`와 일치). local은 원본 위치를 기록하지 않는다. */
export type PluginSource =
  | { type: "url"; url: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "local" };

/** 설치된 플러그인 한 건(Rust `InstalledPlugin`과 일치 — 매니페스트 + 로컬 상태 병합). */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  /** 매니페스트가 선언한 권한. */
  permissions: string[];
  /** 매니페스트가 선언한 지원 OS(없으면 전 플랫폼). 구버전 백엔드 응답엔 없을 수 있다. */
  platforms?: string[];
  /**
   * 매니페스트가 선언한 한 줄 요약 — 목록 행의 부제. 백엔드는 미선언이면 `null`을
   * 실어 보낸다(`Option<String>`). 이 선언이 없어서 값이 IPC 경계에서 통째로 버려지던
   * 것이 웨이브 A의 결함이었다("선언은 됐는데 아무도 안 읽는다") — 소비처는
   * `settings.ts`의 `detailFromInstalled`·`renderPluginList`다.
   */
  summary?: string | null;
  enabled: boolean;
  /** 로컬에서 부여된 권한(민감 권한 게이트). */
  granted: string[];
  /** 매니페스트가 선언한 설정 스키마(비면 설정 UI를 노출하지 않음). */
  settings_schema: PluginSettingField[];
  /** 현재 설정 값(선언 스키마 키로 한정 — 없는 키는 스키마 기본값으로 채워짐). */
  settings: Record<string, unknown>;
  /** 설정 트리 카테고리(매니페스트 선언 — 없으면 프론트가 기본 그룹에 둔다). */
  settings_category?: string | null;
  /** 설정 페이지 상단 소개 문구(매니페스트 선언 — 선택). */
  settings_description?: string | null;
  /** 설치 출처(url/git이면 "업데이트 확인" 제공). 구버전 백엔드 응답엔 없을 수 있다. */
  source?: PluginSource;
  /**
   * 매니페스트가 선언한 종류 — 능력 등록(`theme`·`background`·`font`·`window.register`)
   * 허용 여부의 입력. 어휘의 정본은 `plugin/manifest.ts`의 `PluginKind`이고, 여기 값이 그리로
   * 넘어가므로 둘이 어긋나면 재구성 지점(`main.ts`)에서 tsc가 잡는다. 미선언(구버전 매니페스트·
   * 구버전 백엔드)이면 없음 → 게이트를 적용하지 않는다(하위호환).
   */
  kind?: "capability" | "action";
  /**
   * 매니페스트가 선언한 기여 — `contributes` 원문. 없으면 백엔드가 필드 자체를 생략한다.
   *
   * 형태 검증은 이미 백엔드·프론트 파서가 마쳤고, 항목 내부 규칙은 로드 시점에 registrar가
   * 본다. 이 선언이 없으면 값이 IPC 경계에서 통째로 버려져 **설치 플러그인만** 선언형 기여가
   * 죽는다(`summary`가 정확히 그렇게 사라진 전례가 있다).
   */
  contributes?: Record<string, unknown> | null;
  /**
   * 매니페스트가 다른 플러그인에 공개한 명령 id들(`exposes` 원문). 없으면 백엔드가
   * 필드 자체를 생략한다(Rust `skip_serializing_if = "Vec::is_empty"`). `contributes`와 같은
   * 이유로 여기 선언한다: 값이 IPC 경계에서 버려지면 설치 플러그인의 명령 공개가 조용히 죽어
   * `commands.invoke`가 항상 `INVOKE_NOT_EXPOSED`로 거부된다(번들만 멀쩡한 비대칭).
   *
   * 백엔드 배선 완료(웨이브 F2): Rust `PluginManifest`·`parse_manifest`가 `exposes`를 검증해
   * 읽고, `InstalledPlugin`·`scan_installed_report`가 프론트로 실어 보낸다 — 설치(사이드로드)
   * 경로의 공개가 번들·직접 주입과 대칭으로 동작한다.
   */
  exposes?: string[] | null;
  /**
   * 아직 예약(미구현)이라 부여하지 못한 채 기억해 둔 민감 권한. 예약이 풀리면
   * (`plugin/host.ts`의 `PERMISSION_RESERVED`에서 빠지면) 설정 창이 이 목록으로 재승인
   * 배너를 띄운다 — `install-flow.ts`의 `newlyAvailablePending` 참고. 구버전 백엔드
   * 응답엔 없을 수 있다.
   */
  pendingReserved?: string[];
  /**
   * 저작자 자기 로컬라이즈 사전(축 2, 매니페스트 `nls` 원문 — 선택). 백엔드는 형태만
   * 검증하고 해석하지 않은 채 그대로 나른다(`contributes`와 같은 결) — 실제 `%키%` 해석은
   * 프론트 `plugin/manifest.ts`의 `resolveInstalledPluginNls`가 **파싱 직후 한 번**
   * (`main.ts`의 `listPlugins` 배선)에서 한다. 없으면 백엔드가 필드 자체를 생략한다.
   */
  nls?: Record<string, Record<string, string>> | null;
}

/** 설치된(로컬 사이드로드) 플러그인 목록을 읽는다. */
export function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  return invoke("list_installed_plugins");
}

/** 스캔에서 탈락한 플러그인 폴더 한 건(Rust `RejectedPlugin`과 일치). */
export interface RejectedPlugin {
  /** 실제 폴더 이름(`plugins/<dir_name>`). */
  dir_name: string;
  /** 탈락 사유(사람이 읽는 한국어 — "불러오지 못한 폴더" 표시용). */
  reason: string;
}

/**
 * 스캔에서 탈락한 플러그인 폴더를 사유와 함께 읽는다 — 설정 창 "불러오지 못한 폴더"
 * 안내의 데이터 소스. [`listInstalledPlugins`]가 조용히 걸러내는 손상된 폴더를 진단 가능하게
 * 만든다.
 *
 * 응답을 경계에서 정규화한다: 배열이 아니거나 각 항목의 `dir_name`/`reason`이 문자열이
 * 아니면 그 항목을 버린다 — 형태가 어긋난 IPC 응답에 호스트가 죽은 전례가 있어, 표시 전용
 * 목록이 방어 없이 그대로 새지 않게 한다.
 */
export function listRejectedPlugins(): Promise<RejectedPlugin[]> {
  return invoke<unknown>("list_rejected_plugins").then((raw) => {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is RejectedPlugin => {
      const r = item as Partial<RejectedPlugin> | null;
      return (
        !!r &&
        typeof r === "object" &&
        typeof r.dir_name === "string" &&
        typeof r.reason === "string"
      );
    });
  });
}

/** 플러그인의 entry 코드(main.js)를 읽는다(샌드박스 실행용). */
export function readPluginCode(id: string): Promise<string> {
  return invoke("read_plugin_code", { id });
}

/**
 * 설치형 플러그인의 README(사용법 마크다운)를 읽는다(없으면 null — 상세 뷰가 "설명 없음" 표시).
 *
 * `locale`(선택, 축 2)을 주면 백엔드가 `README.<locale>.md`를 먼저 찾고, 없으면 `README.md`로
 * 폴백한다(로케일 문자열 형식이 방어 정규식과 안 맞으면 그 사실만으로 조용히 `README.md`로
 * 떨어진다 — 오류가 아니다). 생략하면 항상 `README.md`(기존 동작 그대로).
 */
export function readPluginReadme(
  id: string,
  locale?: string,
): Promise<string | null> {
  return invoke("read_plugin_readme", { id, locale: locale ?? null });
}

/** 외부 URL(https만)을 기본 브라우저로 연다 — README 링크 등 앱 밖 탐색 전용. */
export function openExternalUrl(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}

/**
 * 클립보드에 텍스트를 쓴다 — **네이티브(OS) 경로 우선, 웹 API는 폴백**.
 *
 * 왜 네이티브가 먼저인가: `navigator.clipboard.writeText`는 Windows(WebView2)에서 문서
 * 포커스·권한 조건을 타서 거절되는 일이 잦다. 단어 수 상태 아이템처럼 **클릭이 중앙 호스트를
 * 한 바퀴 돌아 돌아오는** 경로는 그 조건을 만족한다는 보장이 없어, 눌러도 아무 일도 일어나지
 * 않는 것처럼 보였다(macOS WKWebView에서는 잘 되어 더 늦게 발견됐다). 네이티브 플러그인은
 * 웹뷰가 아니라 OS 클립보드에 직접 써서 그 조건 자체가 없다.
 * 폴백을 남기는 이유: e2e(브라우저)에는 Tauri 백엔드가 없다 — 거기서는 웹 API로 검증된다.
 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  } catch {
    // 네이티브 경로 부재·거절 — 아래 웹 API로 떨어진다(실패하면 호출부로 reject된다).
  }
  await navigator.clipboard.writeText(text);
}

/** 클립보드 텍스트를 읽는다(쓰기와 같은 이유로 네이티브 우선 — 붙여넣기 경로). */
export async function readClipboardText(): Promise<string> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  } catch {
    // 네이티브 경로 부재·거절 — 웹 API로 떨어진다.
  }
  return navigator.clipboard.readText();
}

/** 플러그인 활성 여부를 설정한다(로컬 상태 영속화). */
export function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_plugin_enabled", { id, enabled });
}

/** 플러그인의 로컬 권한 부여 집합을 설정한다(선언 ∩ 요청으로 좁혀짐). */
export function setPluginGranted(id: string, granted: string[]): Promise<void> {
  return invoke("set_plugin_granted", { id, granted });
}

/**
 * 예약(미구현)이라 아직 부여하지 못한 민감 권한을 pending으로 기록한다.
 *
 * 역할: 설치/업데이트 승인 직후 `install-flow.ts`의 `pendingReservedForApproval` 결과를
 * 영속화한다 — 예약이 나중에 풀렸을 때 [`InstalledPlugin.pendingReserved`]로 재승인 대상을
 * 꺼낼 수 있는 저장소 절반. 승인 시 부여한 권한이 실제 예약 해소로 사용 가능해지면
 * (원래 값 ∖ 해소분)으로 다시 호출해 갱신한다(`newlyAvailablePending` 참고).
 */
export function setPluginPendingReserved(
  id: string,
  pending: string[],
): Promise<void> {
  return invoke("set_plugin_pending_reserved", { id, pending });
}

/** 플러그인 설정 값 하나를 저장한다(선언된 스키마 키만 백엔드가 허용). */
export function setPluginSetting(
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  return invoke("set_plugin_setting", { id, key, value });
}

/** 설치(서드파티) 언어팩 카탈로그 항목 하나(Rust `LanguagePackEntry`와 일치). */
export interface LanguagePackEntry {
  /** 로케일 코드(BCP47 소문자 단순형 — `en`·`pt-br`). */
  code: string;
  /** 언어 드롭다운에 그대로 나가는 표시 라벨(저작자가 매니페스트에 적은 값). */
  label: string;
  /** 이 로케일을 공급하는 플러그인 id(같은 코드를 여러 팩이 공급할 수 있다). */
  pluginId: string;
}

/**
 * 설치(서드파티) 언어팩 카탈로그를 읽는다 — 설정 창 언어 드롭다운의 후보.
 *
 * 코어(Rust)가 설치 매니페스트의 `contributes.translations`를 **직접** 스캔한 결과다 —
 * 중앙 호스트 샌드박스 왕복이 없어 첫 페인트 전에 쓸 수 있다(번들 언어팩이
 * `src/i18n/packs.ts`로 같은 전환을 한 것의 설치 플러그인 판). 수집 자격은 브리지
 * 게이트와 동형이다(활성 · `kind: "capability"` · `i18n` 권한 선언 —
 * `src-tauri/src/plugin_i18n.rs`).
 *
 * 응답을 경계에서 정규화하는 이유는 [`listRejectedPlugins`]와 같고, 여기서는 더 강하다:
 * 이 호출은 **창 부트스트랩의 첫 페인트 전 경로**에 있어서, 형태가 어긋난 응답 하나가
 * `null.map(...)`으로 새면 설정 창이 통째로 뜨지 않는다(빈 화면). 배열이 아니면 빈 배열로,
 * 각 필드가 문자열이 아닌 항목은 버린다 — 언어 하나가 드롭다운에서 빠지는 것이 창 전체가
 * 죽는 것보다 낫다.
 */
export function listLanguagePacks(): Promise<LanguagePackEntry[]> {
  return invoke<unknown>("list_language_packs").then((raw) => {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is LanguagePackEntry => {
      const e = item as Partial<LanguagePackEntry> | null;
      return (
        !!e &&
        typeof e === "object" &&
        typeof e.code === "string" &&
        typeof e.label === "string" &&
        typeof e.pluginId === "string"
      );
    });
  });
}

/**
 * 로케일 하나의 사전을 읽는다(설치 언어팩들의 병합 결과 — 없으면 빈 맵).
 *
 * 각 창 부트스트랩이 **자기가 그릴 언어 하나**를 첫 페인트 전에 IPC 한 번으로 받는 지점이다.
 * 여러 팩이 같은 코드를 공급하면 뒤가 앞을 덮는다(LastWins — `registerLocale`과 같은 규칙).
 * 콘텐츠 검증(ko 사전 대조)은 백엔드가 하지 않는다 — 등록 시점의 `registerLocale`이 한다.
 *
 * [`listLanguagePacks`]와 같은 이유로 경계에서 정규화한다. 특히 호출부가 "빈 맵인가"를
 * `Object.keys(entries).length`로 보는데 `Object.keys(null)`은 **던진다** — 그 예외가 첫
 * 페인트 전 경로에서 나면 창이 뜨지 않는다.
 */
export function readLocaleEntries(
  locale: string,
): Promise<Record<string, string>> {
  return invoke<unknown>("read_locale_entries", { locale }).then((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") entries[key] = value;
    }
    return entries;
  });
}

/** 빌트인(번들) 플러그인 활성 상태 맵을 읽는다(id→enabled; 없으면 기본 켜짐으로 해석). */
export function listBuiltinStates(): Promise<Record<string, boolean>> {
  return invoke("list_builtin_states");
}

/** 빌트인(번들) 플러그인 활성 여부를 설정한다(로컬 상태 영속화). */
export function setBuiltinEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_builtin_enabled", { id, enabled });
}

/** 빌트인(번들) 플러그인 설정 값 맵을 읽는다(id→key→value; 스키마 기본값은 프론트가 합침). */
export function listBuiltinSettings(): Promise<
  Record<string, Record<string, unknown>>
> {
  return invoke("list_builtin_settings");
}

/** 빌트인(번들) 플러그인 설정 값 하나를 저장한다(키 형식만 백엔드가 검증). */
export function setBuiltinSetting(
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  return invoke("set_builtin_setting", { id, key, value });
}

/** 플러그인을 제거한다(디렉터리 + 로컬 상태 + vault 참조 목록 항목). */
export function removePlugin(id: string): Promise<void> {
  return invoke("remove_plugin", { id });
}

/** 설치 요청(Rust `InstallSpec`과 일치): 출처 종류 + 위치(+ git ref). */
export interface InstallSpec {
  kind: "url" | "git" | "local";
  location: string;
  git_ref?: string;
}

/** 설치 미리보기(Rust `InstallPreview`와 일치) — 승인 프롬프트가 표시할 정보. */
export interface InstallPreview {
  /** 스테이징 토큰(confirm/cancel에 되돌려 준다). */
  staging: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    entry: string;
    permissions: string[];
    /**
     * 이 플러그인이 요구한다고 스스로 신고한 최소 memo 앱 버전(선택). 설치 화면이
     * `install-flow.ts`의 `previewMinHostVersion`·`minHostVersionUnmet`으로 읽어 **경고**한다
     * (차단하지 않는다 — 자기신고라 검증할 수 없다). 구버전 백엔드 응답엔 없을 수 있다.
     */
    minHostVersion?: string;
    /**
     * 저작자 자기 로컬라이즈 사전(축 2, 선택 — `InstalledPlugin.nls`와 같은 형태). Rust
     * `PluginManifest`가 이미 나르고 있었지만(9c9fcc9) 이 미리보기 타입엔 빠져 있었다 —
     * `computeApprovalView`가 `manifest.name`을 그대로 승인 프롬프트에 꽂아 `%키%`가 해석
     * 안 된 채 노출되는 결함(9c9fcc9 잔여)이라 `summary`가 한 번 사라진 전례와 같은 패턴이다.
     */
    nls?: Record<string, Record<string, string>> | null;
  };
  source: PluginSource;
  /** 같은 id가 이미 설치돼 있으면 그 버전(업데이트/최신 판단용). */
  installed_version: string | null;
  /** 이미 설치된 경우 현재 선언 권한(새 민감 권한 diff 계산용). */
  installed_permissions: string[];
  /** 이미 설치된 경우 로컬 부여 권한(업데이트 시 기존 부여 유지 계산용). */
  installed_granted: string[];
}

/** vault 참조 목록에만 있는(이 기기에 코드가 없는) 플러그인 항목(Rust `VaultPluginEntry`). */
export interface MissingPlugin {
  id: string;
  name: string;
  version: string;
  source: PluginSource;
}

/** 설치 후보를 가져와 스테이징한다(다운로드/클론/복사 + 검증 — 설치는 아직 안 함). */
export function fetchPluginForInstall(
  spec: InstallSpec,
): Promise<InstallPreview> {
  return invoke("fetch_plugin_for_install", { spec });
}

/** 승인된 스테이징을 확정 설치한다(granted는 백엔드가 선언∩요청으로 클램프). id 반환. */
export function confirmPluginInstall(
  staging: string,
  granted: string[],
): Promise<string> {
  return invoke("confirm_plugin_install", { staging, granted });
}

/** 스테이징을 폐기한다(승인 프롬프트에서 취소/거부 — 잔여물 제거). */
export function cancelPluginInstall(staging: string): Promise<void> {
  return invoke("cancel_plugin_install", { staging });
}

/** vault 목록에는 있는데 이 기기에 없는(무시하지 않은) 플러그인 항목을 읽는다(재조정). */
export function listMissingPlugins(): Promise<MissingPlugin[]> {
  return invoke("list_missing_plugins");
}

/** 재조정 안내 항목을 "무시"로 기록한다(이 기기에서 다시 보이지 않음). */
export function dismissMissingPlugin(id: string): Promise<void> {
  return invoke("dismiss_missing_plugin", { id });
}

// ── `memo.storage.*` 영속(local) 스코프 IPC 바인딩 ──────────────────────────
//
// 역할: `memo.storage.local.*`가 디스크에 닿는 유일한 경로. `session`(중앙 호스트 프로세스
// 메모리)·`window`(창 컨텍스트 토큰 스코프)는 파일시스템을 쓰지 않으므로 여기 바인딩이
// 없다 — 그 둘은 브리지 배선(다음 단계)이 `central-host.ts` 메모리 Map으로 직접 구현한다.
// 설치(사이드로드)와 번들(빌트인)은 백엔드에서 이미 별도 네임스페이스로 격리돼 있으므로
// (같은 id를 써도 파일이 겹치지 않는다 — `plugin_storage.rs`) 그 구분을 그대로 반영해
// 함수를 짝으로 둔다.
//
// **4종 저장소 수명·노출 비교표** (결정 문서가 요구하는 표 — 여기 없으면 "언제 무엇을"
// 이라는 새 애매함만 남긴다):
//
// | 종류                      | 수명                          | 설정 폼에 노출 | vault 동기화 |
// | ------------------------- | ------------------------------ | -------------- | ------------ |
// | `settings.get/set`        | 영속(디스크) — 재빌드 유발     | 예(매니페스트 스키마) | 아니오(기기 로컬) |
// | `storage.local.*`(이 파일) | 영속(디스크) — **재빌드 없음** | 아니오         | 아니오(기기 로컬) |
// | `storage.session.*`       | 재빌드까지(프로세스 메모리)    | 아니오         | 해당 없음(메모리) |
// | `storage.window.*`        | 그 창이 닫힐 때까지(토큰 스코프) | 아니오       | 해당 없음(메모리) |

/** 설치(사이드로드) 플러그인 저장소 값 하나를 읽는다(없으면 `null`). */
export function getPluginStorage(id: string, key: string): Promise<unknown> {
  return invoke("get_plugin_storage", { id, key });
}

/** 설치(사이드로드) 플러그인 저장소 값 하나를 저장한다(파일당 256KB 상한 — 초과 시 reject). */
export function setPluginStorage(
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  return invoke("set_plugin_storage", { id, key, value });
}

/** 설치(사이드로드) 플러그인 저장소 값 하나를 지운다(없어도 오류 아님). */
export function removePluginStorage(id: string, key: string): Promise<void> {
  return invoke("remove_plugin_storage", { id, key });
}

/** 설치(사이드로드) 플러그인 저장소 전체 스냅샷을 읽는다. */
export function getAllPluginStorage(
  id: string,
): Promise<Record<string, unknown>> {
  return invoke("get_all_plugin_storage", { id });
}

/** 빌트인(번들) 플러그인 저장소 값 하나를 읽는다(없으면 `null`). */
export function getBuiltinStorage(id: string, key: string): Promise<unknown> {
  return invoke("get_builtin_storage", { id, key });
}

/** 빌트인(번들) 플러그인 저장소 값 하나를 저장한다(파일당 256KB 상한 — 초과 시 reject). */
export function setBuiltinStorage(
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  return invoke("set_builtin_storage", { id, key, value });
}

/** 빌트인(번들) 플러그인 저장소 값 하나를 지운다(없어도 오류 아님). */
export function removeBuiltinStorage(id: string, key: string): Promise<void> {
  return invoke("remove_builtin_storage", { id, key });
}

/** 빌트인(번들) 플러그인 저장소 전체 스냅샷을 읽는다. */
export function getAllBuiltinStorage(
  id: string,
): Promise<Record<string, unknown>> {
  return invoke("get_all_builtin_storage", { id });
}

// ── 플러그인 네트워크 중계(`memo.network.fetch`의 백엔드) ────────────────────
// 역할: 샌드박스 플러그인은 iframe이라 네트워크에 직접 닿지 못한다 — 호스트(Rust)가 대신
// fetch한다. 이 바인딩은 그 유일한 통로다. **모든 SSRF 방어(https 전용·사설대역 차단·DNS 핀·
// 리다이렉트 미추적·크기/타임아웃 상한·자격증명 미전달)는 백엔드 `net.rs`가 소유**한다 —
// 여기와 호스트 게이트키퍼는 도메인 승인·스킴을 프론트에서 한 번 더 거를 뿐이다(심층 방어).

/** 요청/응답 헤더 한 쌍 — 백엔드 `net::HeaderEntry`와 같은 모양(중복 보존 위해 배열). */
interface NetHeaderEntry {
  name: string;
  value: string;
}

/** 네트워크 중계 응답 — 백엔드 `net::NetResponse`와 같은 모양. */
interface NetFetchResponse {
  /** HTTP 상태 코드(3xx도 그대로 — 리다이렉트를 따라가지 않는다). */
  status: number;
  /** 응답 헤더(중복 보존). */
  headers: NetHeaderEntry[];
  /** 응답 본문(UTF-8 손실 변환, 5MiB 상한). */
  body: string;
}

/**
 * 호스트가 대신 수행하는 https 중계 — 플러그인 브리지 `memo.network.fetch`의 백엔드(Rust
 * `net_fetch`). 거부는 `Err(String)`으로 오고 접두 토큰(`NET_*`)으로 사유를 구분한다 —
 * central-host가 그 토큰을 `MemoErrorCode`로 맵한다(TS는 문구를 매칭하지 않는다).
 */
export function netFetch(
  url: string,
  method: string,
  headers: NetHeaderEntry[],
  body: string | null,
): Promise<NetFetchResponse> {
  return invoke("net_fetch", { url, method, headers, body });
}

/**
 * 목록·검색 결과가 함께 싣는 **정렬용 메타**(Rust `NoteSummary`/`SearchHit` 공통 필드).
 * 패널의 정렬 드롭다운(추가순·수정순·이름순·글자수·최근 연 순)과 즐겨찾기 묶음이 이 값만 본다.
 *
 * 네 필드는 모두 **필수**다: 백엔드가 `note_list`/`note_search` 응답에 언제나 실어 보낸다
 * (`opened_at`은 값이 없을 때 생략이 아니라 JSON null이다 — 그래서 `number | null`이지
 * 옵셔널이 아니다). 타입을 느슨하게 두면 목이나 픽스처가 필드를 빠뜨린 채로 통과해, 정렬이
 * 조용히 어긋나는 것을 컴파일러가 잡아 주지 못한다.
 */
export interface NoteSortFields {
  /**
   * 즐겨찾기 여부 — 패널 목록에서 언제나 위쪽 묶음으로 올라간다(필터를 이기지는 않는다).
   *
   * `NoteOverrides.pinned`(창을 항상 위에 두는 창 옵션)와는 **아무 관계가 없다** — 이름이
   * 비슷해 헷갈리기 쉬운데, 저쪽은 창 동작이고 이쪽은 목록 정렬 전용 메타다. 그래서 패널의
   * 즐겨찾기 아이콘도 노트 툴바의 핀이 아니라 **별**이다(`panel.ts`의 `STAR_ICON_BODY`).
   */
  favorite: boolean;
  /** 본문(`notes/<id>.md`) 파일의 mtime(에폭 ms) — "수정순"의 데이터. 백엔드가 stat에 실패하면 `created_at`을 대신 싣는다. */
  content_updated_at: number;
  /** 마크다운 원문의 글자 수(공백 포함) — "글자수 많은 순"의 데이터. */
  char_count: number;
  /** 마지막으로 **사용자가 직접 연** 시각(에폭 ms). 한 번도 없으면 null(내림차순에서 맨 뒤). */
  opened_at: number | null;
}

/** 노트 목록 항목(제목은 본문 첫 줄에서 파생). */
export interface NoteSummary extends NoteSortFields {
  id: string;
  title: string;
  hidden: boolean;
  /** 생성 시각(에폭 ms) — 패널 목록의 생성일 표기용. */
  created_at: number;
}

/** 검색 결과 한 건(제목 + 본문 미리보기). */
export interface SearchHit extends NoteSortFields {
  id: string;
  title: string;
  snippet: string;
  /** 생성 시각(에폭 ms) — 패널 목록의 생성일 표기용. */
  created_at: number;
}

/** 전체 노트 목록을 읽는다(패널). */
export function noteList(): Promise<NoteSummary[]> {
  return invoke("note_list");
}

/** 제목·본문에서 질의어를 검색한다(패널). */
export function noteSearch(query: string): Promise<SearchHit[]> {
  return invoke("note_search", { query });
}

/**
 * 노트를 새로 만들고 그 창을 곧바로 연다(Rust `note_create_and_open` →
 * `window_manager::create_and_open`). 패널의 "+" 버튼과 노트 컨텍스트 메뉴 "새 메모"가
 * 같은 커맨드를 함께 쓴다(베타 피드백 2건).
 *
 * 백엔드가 생성 성공 시 **자체적으로** [`EV_NOTES_LIST_CHANGED`]를 방송하므로(창 열기 실패와
 * 무관하게, `create_and_open` 문서 참고) 여기서는 [`afterNotesChanged`]로 감싸지 않는다 —
 * 감쌌다면 프론트가 한 번 더 emit해 같은 신호가 중복 방송된다.
 */
export function createAndOpenNote(): Promise<void> {
  return invoke("note_create_and_open");
}

/**
 * 노트를 소환한다(창 포커스/열기) — 패널 항목 클릭·위키링크 클릭.
 *
 * [`afterNotesChanged`]로 감싸는 이유: 백엔드 `summon_note`는 이 경로에서 `opened_at`을
 * 기록한다(D10 — "사용자가 직접 연" 시각). 그런데 목록이 실제로 바뀌었다는 신호는 **새 창을
 * 만들 때만**(그것도 Windows 한정) 나가, 이미 열려 있는 노트를 다시 소환하면 패널의
 * 「최근 연 순」이 그 자리에서 갱신되지 않았다 — 다른 변경이 나거나 패널을 다시 열어야
 * 반영되는 결함. 소환은 곧 `opened_at` 변경이므로 목록 변경 신호를 함께 낸다.
 */
export function summonNote(id: string): Promise<void> {
  return afterNotesChanged(invoke<void>("summon_note", { id }));
}

/**
 * 「시작 가이드」 메모 자리를 **원자적으로 선점**하고, 얻었으면 그 자리에 메모를 만든다
 * (Rust `claim_guide_note`). 새로 만들었으면 그 id, 이미 누가 만들었으면 `null`.
 *
 * 판정과 기록이 코어의 한 잠금 안에서 끝나는 것이 요점이다 — 앱이 뜰 때 여러 창이 동시에
 * 부트스트랩되므로 "설정을 읽어 비었으면 만든다"를 프론트가 하면 창 수만큼 만들어진다.
 *
 * `force`면 기존 기록을 무시하고 새로 만든다(설정 「도움말 › 시작 가이드 다시 보기」 —
 * 사용자가 지웠거나 다른 vault의 백업에서 온 id가 남아 있을 때).
 *
 * 목록 변경 신호는 **실제로 만들었을 때만** 낸다([`afterNotesChanged`]를 쓰지 않는 이유):
 * 이 호출은 창이 열릴 때마다 일어나고 대부분 `null`(=아무것도 안 만듦)로 끝나는데, 그때도
 * 방송하면 열려 있는 패널이 창을 열 때마다 목록을 헛되이 다시 읽는다.
 */
export function claimGuideNote(
  body: string,
  force: boolean,
): Promise<string | null> {
  return invoke<string | null>("claim_guide_note", { body, force }).then(
    (id) => {
      if (id) void emit(EV_NOTES_LIST_CHANGED);
      return id;
    },
  );
}

/** vault 루트의 절대경로를 읽는다(첨부 상대경로를 웹뷰 URL로 합칠 기준). */
export function getVaultPath(): Promise<string> {
  return invoke("get_vault_path");
}

// ── 저장 폴더 이전(이슈 #21) ────────────────────────────────────────────────
// 역할: 설정 창 「관리 › 저장 폴더」와 최초 실행 안내가 쓰는 IPC 네 벌.
//
// 오류는 백엔드가 `"<코드> <설명>"` 문자열로 준다(`net.rs`의 `NET_*`와 같은 관례). 호출부는
// 문구가 아니라 [`vaultErrorCode`]가 뽑은 **첫 토큰**으로 분기해 번역된 안내를 고른다 —
// 백엔드 문구가 다듬어져도 UI가 깨지지 않고, 한국어 문구가 영어 UI에 새지 않는다.

/** 현재 저장 폴더 상태(Rust `VaultInfo`와 일치). */
export interface VaultInfo {
  /** vault 루트의 절대경로. */
  path: string;
  /** 옮길 내용물(notes·attachments·.memo)이 하나라도 있는지 — "함께 이동" 선택지 노출 조건. */
  has_contents: boolean;
  /** 노트 수(안내 문구용). */
  note_count: number;
  /** vault 항목 안의 총 파일 수(안내 문구용). */
  file_count: number;
  /** 첫 실행 저장 폴더 안내를 이미 띄웠는지 — 노트 창의 1회성 안내가 이 값으로 결정한다. */
  prompted: boolean;
}

/** 고른 폴더의 검사 결과(Rust `VaultTargetInfo`와 일치). 권한 실패는 reject로 온다. */
export interface VaultTargetInfo {
  /** 정규화된 절대경로 — 그대로 [`changeVaultPath`]에 넘긴다. */
  path: string;
  /** 이미 vault(`notes/`)가 있는 폴더인지 — 있으면 이동은 거부되고 "연결"만 가능. */
  has_vault: boolean;
  /** vault 소유 항목이 하나라도 있는지. */
  occupied: boolean;
  /** 현재 저장 폴더와 같은 곳인지. */
  same_as_current: boolean;
}

/**
 * 저장 폴더 변경 결과(Rust `VaultChangeResult`와 일치).
 *
 * export하지 않는 이유: 호출부는 [`changeVaultPath`]의 반환 타입으로 추론해 쓰므로 이름을
 * 내보내면 아무도 import하지 않는 표면만 늘어난다(`VaultInfo`·`VaultTargetInfo`는 설정 창이
 * 지역 변수 타입으로 명시해야 해서 내보낸다).
 */
interface VaultChangeResult {
  /** `"moved"` · `"linked"` · `"unchanged"`. */
  outcome: string;
  /** 적용된 vault 경로. */
  path: string;
  /** 옮긴 최상위 항목 수. */
  moved_entries: number;
  /** 옮긴 파일 수. */
  moved_files: number;
  /** 노트 창을 닫고 새 vault 기준으로 다시 열었는지(linked에서만 true). */
  windows_reopened: boolean;
}

/** 현재 저장 폴더 상태를 읽는다(설정 페이지 표시용). */
export function getVaultInfo(): Promise<VaultInfo> {
  return invoke("get_vault_info");
}

/** 네이티브 폴더 선택 창을 띄우고 고른 폴더의 절대경로를 돌려준다(취소하면 null). */
export function pickVaultFolder(): Promise<string | null> {
  return invoke("pick_vault_folder");
}

/**
 * 첫 실행 저장 폴더 안내를 "띄웠음"으로 기록한다(다시 묻지 않기).
 *
 * 노트 창이 안내를 **띄우는 즉시** 부른다(닫을 때가 아니라) — 답하지 않고 앱을 끈 사용자에게
 * 매번 다시 묻는 것보다, 한 번 보여 준 것으로 끝내는 편이 낫다.
 */
export function markVaultPrompted(): Promise<void> {
  return invoke("mark_vault_prompted");
}

/**
 * 고른 폴더가 저장 폴더로 쓸 수 있는지 검사한다 — 백엔드가 **프로브 파일을 실제로 쓰고 지워**
 * 읽기/쓰기를 확인한다(권한은 메타데이터만 봐서는 알 수 없다: OneDrive·네트워크 드라이브·
 * Windows ACL). 실패는 reject이고 사유는 [`vaultErrorCode`]로 분류한다.
 */
export function inspectVaultFolder(path: string): Promise<VaultTargetInfo> {
  return invoke("inspect_vault_folder", { path });
}

/**
 * 저장 폴더를 바꾼다. `moveFiles`가 true면 기존 내용물(노트·첨부·복구 저장본·플러그인 목록)을
 * 새 폴더로 옮기고, false면 옮기지 않고 그 폴더를 그대로 쓴다(다른 기기의 동기화 폴더를 붙이는
 * 경로). 대상에 이미 메모가 있으면 이동은 거부된다(`VAULT_TARGET_HAS_VAULT`) — 합치면 어느
 * 쪽이 정본인지 알 수 없기 때문이다.
 *
 * 실제로 폴더가 바뀌었으면 목록·재빌드 신호를 함께 방송한다([`wipeAllData`]와 같은 짝):
 * 패널이 새 vault의 목록을 다시 읽고([`EV_NOTES_LIST_CHANGED`]), 중앙 호스트가 재빌드하며 그
 * 방송으로 열려 있는 노트 창들이 리로드된다([`EV_NOTES_RELOAD`]) — 노트 창은 마운트 때 읽은
 * vault 절대경로로 첨부 URL을 만들므로, 리로드하지 않으면 옛 폴더를 가리키는 이미지가 깨진 채
 * 남는다. `unchanged`(같은 폴더를 다시 고름)면 방송하지 않는다 — 바뀐 것이 없는데 모든 노트
 * 창을 리로드시킬 이유가 없다.
 */
export function changeVaultPath(
  path: string,
  moveFiles: boolean,
): Promise<VaultChangeResult> {
  return invoke<VaultChangeResult>("change_vault_path", {
    newPath: path,
    moveFiles,
  }).then((result) => {
    if (result.outcome !== "unchanged") {
      void emit(EV_NOTES_LIST_CHANGED);
      // 사유 `vault` — 노트 창은 마운트 때 읽은 vault 절대경로로 첨부 URL을 만든다. 그 기준이
      // 통째로 바뀌었으므로 제자리 조정 대상이 아니다(판정기가 이 사유를 리로드로 못박는다).
      void emitRebuild(["vault"]);
    }
    return result;
  });
}

/**
 * 저장 폴더 IPC의 reject에서 오류 코드(첫 토큰)를 뽑는다 — 호출부가 번역된 안내를 고르는 열쇠.
 *
 * 백엔드는 `"VAULT_NOT_WRITABLE 폴더에 쓸 수 없습니다: ..."` 형태로 거부한다. 토큰이 없거나
 * (구버전 백엔드·예상 못 한 실패) 형태가 다르면 빈 문자열이고, 호출부는 일반 실패 문구로
 * 떨어진다 — 알 수 없는 오류에 지어낸 원인을 붙이지 않는다.
 */
export function vaultErrorCode(error: unknown): string {
  const text = typeof error === "string" ? error : String(error ?? "");
  const first = text.trim().split(/\s+/, 1)[0] ?? "";
  return /^VAULT_[A-Z_]+$/.test(first) ? first : "";
}

/** 붙여넣은 이미지 바이트를 vault에 저장하고 본문에 넣을 상대경로를 돌려준다. */
export function saveAttachment(
  noteId: string,
  data: Uint8Array,
  ext: string,
): Promise<string> {
  // IPC는 number[]만 직렬화하므로 바이트를 일반 배열로 변환해 보낸다.
  return invoke("save_attachment", { noteId, data: Array.from(data), ext });
}

/** 설치 플러그인 루트 디렉터리(`<app_data>/plugins`)의 절대경로를 읽는다(README 로컬 이미지 기준). */
export function getPluginsDir(): Promise<string> {
  return invoke("get_plugins_dir");
}

/** 네이티브 폴더 선택 창을 띄우고 고른 폴더의 절대경로를 돌려준다(취소하면 null). */
export function pickPluginDir(): Promise<string | null> {
  return invoke("pick_plugin_dir");
}

/**
 * 개발자 모드 단일 핫리로드 — 설치 플러그인 `id` 하나의 폴더를 Rust가 감시하게 한다.
 * `id`가 null이면 감시를 해제한다(개발 모드 끄기). 세션 한정이라 두 번째 호출은 이전 감시를
 * 대체한다(동시에 하나만 감시 가능 — `set_dev_plugin`(plugin_commands.rs) 문서 참고).
 */
export function setDevPlugin(id: string | null): Promise<void> {
  return invoke("set_dev_plugin", { id });
}

/** 절대 파일 경로를 웹뷰가 로드할 수 있는 asset URL로 바꾼다(플러그인 로컬 이미지 등). */
export function fileAssetUrl(absPath: string): string {
  return convertFileSrc(absPath);
}

/** vault 상대경로(`attachments/...`)를 웹뷰가 로드할 수 있는 asset URL로 바꾼다. */
export function attachmentUrl(vaultPath: string, relPath: string): string {
  return convertFileSrc(`${vaultPath}/${relPath}`);
}

/**
 * 테마·플러그인 변경 신호를 전역 방송한다(설정 창 → 중앙 호스트가 받아 재빌드).
 *
 * `reasons`는 **무엇이 이 재빌드를 요청했는지**다([`RebuildReason`]) — 호스트가 재빌드 완료
 * 방송에 그대로 옮겨 실어, 노트 창이 리로드 대신 제자리 조정으로 충분한지 가리는 첫 입력이
 * 된다. 생략하면 호스트가 `"unknown"`으로 읽어 **언제나 리로드**한다(모르면 리로드).
 */
export function emitNotesReload(
  reasons: readonly RebuildReason[],
): Promise<void> {
  return emitRebuild([...reasons]);
}

/** 재빌드 신호 하나를 형식(payload)에 맞춰 방송한다 — 이 파일의 모든 발신 지점이 공유한다. */
function emitRebuild(reasons: RebuildReason[]): Promise<void> {
  const payload: NotesReloadPayload = { reasons };
  return emit(EV_NOTES_RELOAD, payload);
}

/**
 * 설정 창을 연다(노트 툴바의 설정 바로가기 버튼, 이슈 #16). Tauri 커맨드(`invoke`)가 아니라
 * 전역 이벤트로 요청한다 — 백엔드 `tray.rs`가 [`EV_REQUEST_OPEN_SETTINGS`]를 구독해
 * `window_manager::open_settings`를 호출한다([`EV_REQUEST_OPEN_SETTINGS`] 문서 참고: 정공법인
 * 새 커맨드 등록 지점이 이 기능을 만들 당시 다른 작업으로 잠겨 있어 우회했다).
 */
export function openSettings(): Promise<void> {
  return emit(EV_REQUEST_OPEN_SETTINGS);
}

/**
 * 노트 목록·검색 패널을 연다(이미 떠 있으면 포커스만 — Rust `window_manager::open_panel`과
 * 같은 동작, 트레이 "노트 목록·검색"의 진입점). 노트 컨텍스트 메뉴 "노트 목록·검색 열기"가
 * 부른다(베타 피드백 2건) — `open_note_panel` 커맨드는 이미 `invoke_handler`에 등록돼 있어
 * (트레이 배선 전례) 새 커맨드 없이 그대로 재사용한다.
 */
export function openNotePanel(): Promise<void> {
  return invoke("open_note_panel");
}

/** 전역 앱 이벤트를 방송한다(플러그인 호스트 프로토콜 등 창 간 통신). */
export function emitAppEvent(event: string, payload?: unknown): Promise<void> {
  return emit(event, payload);
}

/**
 * 플러그인 메뉴바 트레이 항목 전체 목록을 네이티브에 설정한다.
 *
 * 중앙 호스트가 빌드마다 부른다 — Rust가 고정 트레이 항목 아래 「플러그인」 섹션을 이 목록으로
 * 다시 그린다(증분이 아니라 전체 교체라 빈 목록이면 섹션이 사라진다). 클릭은 Rust가
 * `plugin-tray:invoke`(EV_TRAY_INVOKE)로 되쏘고 중앙 호스트가 `run`을 역호출한다.
 */
export function setPluginTrayItems(items: TrayItemDescriptor[]): Promise<void> {
  return invoke("set_plugin_tray_items", { items });
}

/**
 * 전역 앱 이벤트를 구독한다. 즉시 해제 함수를 돌려준다(내부에서 비동기 등록을 처리).
 *
 * 역할: Tauri `listen`의 Promise 반환을 감춰, 호출자가 동기적으로 해제 함수를 받아
 * 정리 시점을 다루게 한다(플러그인 호스트 프로토콜의 요청/응답 상관 정리용).
 */
export function onAppEvent(
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  const registered: Promise<UnlistenFn> = listen(event, (e) =>
    handler(e.payload),
  );
  return () => {
    void registered.then((unlisten) => unlisten());
  };
}

/**
 * 플러그인 중앙 호스트 창을 보장한다(없으면 백엔드가 재생성) — 사용 가능하면 true.
 *
 * 역할: 스냅샷을 기다리기 전 호출해, 호스트 창이 죽었어도 자동 복구되게 한다. 비-true
 * 응답(테스트 목의 null 등)은 false로 좁혀 호출자가 즉시 폴백하게 한다.
 */
export function ensurePluginHost(): Promise<boolean> {
  return invoke<boolean>("ensure_plugin_host").then((v) => v === true);
}

// ── 설정 초기화 / 모든 데이터 삭제(이슈 #20) ────────────────────────────────
// 역할: 설정 창의 "관리 › 초기화" 페이지가 부르는 파괴적 커맨드 두 벌. `mountSettings`의
// `SettingsDeps` 주입을 거치지 않고 여기서 바로 부른다 — 이 창의 배선부(bootstrap/settings.ts)는
// 이번 작업의 편집 범위 밖이라, 다른 IO처럼 "없으면 그 기능만 숨긴다"는 옵션 dep 관례를 쓸 수
// 없다(숨길 수 없는 게 이 페이지의 존재 이유다). `note-window.ts` 등도 이미 이 파일을 deps 없이
// 직접 호출하므로 선례가 있는 경로다.

/**
 * **설정만** 기본값으로 되돌린다(Rust `reset_settings`) — 노트·플러그인 데이터는 그대로 둔다.
 * 테마·색 오버라이드·키맵·툴바 배치·언어·전역 노트 기본값 + 자동 실행·전역 새 노트 단축키가
 * 기본값으로 돌아간다.
 *
 * 성공하면 테마·플러그인 변경 신호([`emitNotesReload`]와 같은 채널)를 함께 방송한다 — 열려
 * 있는 노트 창들이 이 신호로 재빌드된다(`saveSharedSettings` 저장 뒤 `bootstrap/settings.ts`가
 * 하던 것과 같은 신호를 이 래퍼 자신이 낸다). 이 설정 창 자기 자신은 신호가 아니라
 * `window.location.reload()`로 반영한다(호출부 — 언어까지 한꺼번에 바뀌어 부분 재렌더로는
 * 부족하다, `settings.ts`의 언어 변경 처리와 같은 이유).
 */
export function resetSettings(): Promise<void> {
  return invoke<void>("reset_settings").then((v) => {
    // 사유 `reset` — 테마·언어·키맵·배치가 한꺼번에 기본값으로 돌아간다(리로드 전용 사유).
    void emitRebuild(["reset"]);
    return v;
  });
}

/**
 * **모든 데이터**를 영구히 지운다(Rust `wipe_all_data`) — 노트(본문·첨부)·복구 저장본·공유
 * 설정·설치한 플러그인과 그 저장소 전부. vault 폴더 자체는 남지만 안은 빈다. 되돌릴 수 없다 —
 * 호출부가 강한 확인(경고 문구 + 확인 문자열 입력)을 거친 뒤에만 불러야 한다.
 *
 * 백엔드가 열려 있던 노트 창을 이미 전부 닫으므로, 여기서는 남은 창(패널 등)이 빈 상태를
 * 반영하도록 노트 목록 변경 신호와 재빌드 신호를 함께 방송한다 — `noteDelete` 등이 쓰는
 * [`EV_NOTES_LIST_CHANGED`](패널이 목록을 다시 읽는다)와 설정 저장이 쓰는
 * [`EV_NOTES_RELOAD`](중앙 호스트가 플러그인을 다시 실행 — 전부 지워졌으니 빈 상태로)를
 * 둘 다 낸다. 이 앱은 싱글 인스턴스라 자동 재시작은 하지 않는다(Rust `wipe_all_data` 문서
 * 참고) — 호출부가 "트레이에서 종료 후 다시 열기"를 안내한다.
 */
export function wipeAllData(): Promise<void> {
  return invoke<void>("wipe_all_data").then((v) => {
    void emit(EV_NOTES_LIST_CHANGED);
    // 사유 `wipe` — 노트·설정·플러그인이 전부 사라진다(리로드 전용 사유).
    void emitRebuild(["wipe"]);
    return v;
  });
}

// ── 설정·플러그인 백업(이슈 #28 1단계) ──────────────────────────────────────
// 역할: 설정 창 "관리 › 백업" 페이지가 부르는 IPC 네 벌. 설정(공유 + 이식 가능한 로컬 값)과
// 플러그인(코드·상태·저장소)을 zip 파일 하나로 내보내고 되돌린다. 메모 본문은 담기지 않는다 —
// 그쪽은 저장 폴더를 동기화 폴더로 지정하면 이미 따라 움직인다(Rust `backup.rs` 모듈 문서).
//
// 오류는 백엔드가 `"BACKUP_* 설명"` 문자열로 준다(저장 폴더의 `VAULT_*`와 같은 관례) —
// 호출부는 문구가 아니라 [`backupErrorCode`]가 뽑은 첫 토큰으로 분기해 번역된 안내를 고른다.

/** 백업이 담은 플러그인 한 건(Rust `BackupPluginInfo`와 일치) — 미리보기 목록 표시용. */
export interface BackupPluginInfo {
  id: string;
  name: string;
  version: string;
}

/** 백업 파일 하나의 요약(Rust `BackupSummary`와 일치). */
export interface BackupSummary {
  /** 파일 절대경로. */
  path: string;
  /** 백업 포맷 스키마 버전. */
  schema_version: number;
  /** 백업을 만든 앱 버전. */
  app_version: string;
  /** 생성 시각(에폭 ms) — 표시할 때 사용자 로케일로 포맷한다. */
  created_at: number;
  /** 만든 기기의 OS(`macos`·`windows`·…) — 경고가 아니라 정보. */
  platform: string;
  /** 이 앱이 복원할 수 있는 버전인지(더 새로운 스키마면 false). */
  supported: boolean;
  /** 공유 설정이 들어 있는지. */
  has_settings: boolean;
  /** 이식 가능한 로컬 환경설정(자동 실행·전역 단축키)이 들어 있는지. */
  has_prefs: boolean;
  /** 코드가 담긴 플러그인 목록. */
  plugins: BackupPluginInfo[];
  /** 플러그인 저장소 파일 수. */
  storage_count: number;
  /** 파일 크기(바이트). */
  size_bytes: number;
}

/**
 * 복원 결과(Rust `ImportReport`와 일치).
 *
 * export하지 않는 이유는 `VaultChangeResult`와 같다 — 호출부는 [`importBackup`]의 반환
 * 타입으로 추론해 쓰므로, 이름을 내보내면 아무도 import하지 않는 표면만 늘어난다
 * (`BackupSummary`는 설정 창이 지역 변수 타입으로 명시해야 해서 내보낸다).
 */
interface BackupImportReport {
  settings_restored: boolean;
  prefs_restored: boolean;
  plugins_restored: number;
  /** 복원하지 못한 플러그인 id. */
  plugins_failed: string[];
  storage_restored: number;
  /** 복원 직전 자동 저장된 스냅샷 경로 — 되돌리려면 이 파일을 다시 가져오면 된다. */
  snapshot_path: string;
}

/** 무엇을 복원할지(Rust `RestoreSelection`과 일치) — 위와 같은 이유로 내보내지 않는다. */
interface BackupRestoreSelection {
  settings: boolean;
  plugins: boolean;
}

/**
 * 설정 + 플러그인을 파일 하나로 내보낸다(Rust `export_backup`). 저장 위치는 백엔드가 띄우는
 * 네이티브 저장 다이얼로그로 고른다 — 취소하면 `null`이고 아무 일도 일어나지 않는다.
 */
export function exportBackup(): Promise<BackupSummary | null> {
  return invoke<BackupSummary | null>("export_backup");
}

/** 네이티브 파일 선택 창을 띄우고 고른 백업의 절대경로를 돌려준다(취소하면 null). */
export function pickBackupFile(): Promise<string | null> {
  return invoke("pick_backup_file");
}

/**
 * 백업 파일의 내용을 요약해 읽는다(복원 전 미리보기).
 *
 * 더 새로운 스키마 버전도 오류가 아니라 `supported: false`로 온다 — 미리보기가 "이건 더 새
 * 버전에서 만든 백업이다"라고 설명할 수 있어야 하기 때문이다(거부는 [`importBackup`]의 몫).
 */
export function inspectBackup(path: string): Promise<BackupSummary> {
  return invoke("inspect_backup", { path });
}

/**
 * 백업에서 복원한다(Rust `import_backup`) — 파괴적이라 호출부가 확인을 거친 뒤에만 부른다.
 *
 * 백엔드가 복원 직전 현재 상태를 vault의 `.memo/backups/`에 자동 스냅샷하고 그 경로를 결과에
 * 담아 준다(되돌리려면 그 파일을 다시 가져오면 된다).
 *
 * 성공하면 설정 저장·초기화와 **같은 채널**로 재빌드 신호를 방송한다([`EV_NOTES_RELOAD`]) —
 * 테마·플러그인이 한꺼번에 바뀌므로 열린 노트 창과 중앙 호스트가 다시 그려져야 한다. 노트
 * 목록은 건드리지 않으므로 목록 변경 신호는 내지 않는다. 이 설정 창 자신은 신호가 아니라
 * `window.location.reload()`로 반영한다(호출부 — `resetSettings`와 같은 이유).
 */
export function importBackup(
  path: string,
  restore: BackupRestoreSelection,
): Promise<BackupImportReport> {
  return invoke<BackupImportReport>("import_backup", { path, restore }).then(
    (report) => {
      // 사유 `import` — 설정·플러그인이 통째로 갈린다(리로드 전용 사유).
      void emitRebuild(["import"]);
      return report;
    },
  );
}

/**
 * 백업 IPC의 reject에서 오류 코드(첫 토큰)를 뽑는다 — 호출부가 번역된 안내를 고르는 열쇠.
 *
 * 토큰이 없거나 형태가 다르면 빈 문자열이고, 호출부는 일반 실패 문구로 떨어진다
 * ([`vaultErrorCode`]와 같은 규칙 — 알 수 없는 오류에 지어낸 원인을 붙이지 않는다).
 */
export function backupErrorCode(error: unknown): string {
  const text = typeof error === "string" ? error : String(error ?? "");
  const first = text.trim().split(/\s+/, 1)[0] ?? "";
  return /^BACKUP_[A-Z_]+$/.test(first) ? first : "";
}
