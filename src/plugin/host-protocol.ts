/**
 * 플러그인 중앙 호스트 ↔ 노트 창 프로토콜 — 이벤트 채널 이름과 직렬화 페이로드 타입.
 *
 * 역할: 숨김 상주 창(중앙 호스트)이 플러그인 샌드박스를 1회 실행해 수집한 디스크립터
 * 스냅샷을 노트 창들에 배달하고, 노트 창의 런타임 특권 호출(버튼 클릭·창-스코프 서비스)을
 * 호스트로 라우팅하는 데 쓰는 공용 계약이다. 전송은 Tauri 전역 이벤트(방송)이고, 수신자는
 * 페이로드의 `requestId`/`windowLabel`로 자기 몫만 걸러 처리한다.
 * 왜: 채널 이름·페이로드 형태를 한 모듈에 못박아 호스트(central-host)와 노트 창
 * (host-client)이 계약을 어긋나게 진화시키지 못하게 한다.
 *
 * 신뢰 경계: 이 이벤트들은 이 앱의 웹뷰(1st-party realm)들만 방송할 수 있다 — 플러그인
 * 샌드박스(불투명 origin iframe)는 Tauri IPC에 닿지 못하므로 이 채널을 위조할 수 없다.
 */
import type { ToolbarPosition, WhenTerm } from "./loader";
import type { MemoErrorCode } from "./host";
import type { PluginGrant } from "./permissions";
import type {
  CompletionDescriptor,
  InlinePatternDescriptor,
} from "./editor-api";
import type { BlockEmbedDescriptor } from "./embed";
import type { SelectionMatch } from "./selection-action";
import type { ThemeDescriptor } from "../theme/theme";
import type { BackgroundDescriptor } from "../theme/background";
import type { FontDescriptor } from "../theme/font";

/**
 * 설정 창 → 호스트: 테마·플러그인 변경 신호(호스트가 받아 재빌드; 기존 live-apply 채널).
 * payload [`NotesReloadPayload`] — **무엇이 이 재빌드를 요청했는지**(사유)를 싣는다.
 */
export const EV_NOTES_RELOAD = "notes-reload";

/**
 * 재빌드를 요청한 **사유** — [`EV_NOTES_RELOAD`]가 싣고, 중앙 호스트가 그대로
 * [`EV_HOST_UPDATED`]에 옮겨 실어 노트 창의 "리로드 vs 제자리 조정" 판정의 첫 입력이 된다.
 *
 * 왜 필요한가: 재빌드 완료 방송에는 원래 아무 맥락이 없어서, 받는 노트 창이 할 수 있는 일이
 * `location.reload()`뿐이었다(깜빡임 + 스크롤·선택·IME 조합·플러그인 상태 초기화). 사유가
 * 실리면 창이 **스냅샷·설정만 다시 읽어 제자리에서 반영할 수 있는 변화**와 그럴 수 없는
 * 변화를 가를 수 있다(판정 정본은 `bootstrap/host-update-plan.ts`).
 *
 * 안전 원칙 — **모르면 리로드**. 그래서 `"unknown"`이 이 목록에 있고(사유 없는·형식이 다른
 * 페이로드가 모두 여기로 떨어진다), 판정기는 이 값을 언제나 리로드로 취급한다. 새 사유를
 * 더할 때도 판정기의 화이트리스트에 넣기 전까지는 리로드로 떨어지는 쪽이 기본값이다.
 *
 * - `settings` — 공유 설정 저장(색·글자 크기처럼 국소 반영 가능한 키만 바뀐 저장은 애초에
 *   이 채널을 타지 않는다 — [`EV_SETTINGS_CHANGED_LOCAL`]).
 * - `plugins` — 플러그인 활성/부여/설치/제거/번들 토글(집합·표면이 바뀔 수 있다).
 * - `plugin-setting` — 플러그인 설정 값 1건 저장(그 플러그인이 등록한 디스크립터가 바뀔 수 있다).
 * - `locale` — 언어 변경·언어팩 설치/토글/제거. 언어팩은 스냅샷에 실리지 않으므로
 *   (`HostSnapshot` 참고) 창이 스냅샷 비교로는 절대 알 수 없다 → 이 사유만이 유일한 근거다.
 * - `vault` — 저장 폴더 변경(첨부 URL의 기준 경로가 통째로 바뀐다).
 * - `reset`·`wipe`·`import` — 설정 초기화·전체 삭제·백업 복원(디스크 상태가 통째로 갈린다).
 * - `unknown` — 사유를 모른다(구버전 발신자·형식 위반). 언제나 리로드.
 */
export type RebuildReason =
  | "settings"
  | "plugins"
  | "plugin-setting"
  | "locale"
  | "vault"
  | "reset"
  | "wipe"
  | "import"
  | "unknown";

/** 아는 재빌드 사유 전수(입력 검사·테스트가 참조하는 정본). */
const REBUILD_REASONS: readonly RebuildReason[] = [
  "settings",
  "plugins",
  "plugin-setting",
  "locale",
  "vault",
  "reset",
  "wipe",
  "import",
  "unknown",
];

/** [`EV_NOTES_RELOAD`] 페이로드(설정 창·저장 폴더·백업 등 → 호스트). */
export interface NotesReloadPayload {
  /** 이 재빌드를 요청한 사유(디바운스 창 안에서 합쳐졌으면 합집합). */
  reasons: RebuildReason[];
}

/**
 * [`EV_HOST_UPDATED`] 페이로드(호스트 → 모든 창).
 *
 * `revision`은 예전부터 있던 진단용 값이고(수신자는 무시해도 된다), `reasons`는 이 재빌드를
 * 낳은 요청들의 합집합이다 — 노트 창이 조정 가능성을 판정하는 데 쓴다.
 */
export interface HostUpdatedPayload {
  revision: number;
  reasons: RebuildReason[];
}

/**
 * 방송 페이로드에서 재빌드 사유를 읽어 낸다 — **모르면 `["unknown"]`**.
 *
 * 왜 한 곳에 두나: 호스트(요청 수신)와 노트 창(완료 수신)이 같은 규칙으로 읽어야, 한쪽만
 * 관대해져 "사유 없음"이 조용히 조정 경로로 새는 일이 없다. 페이로드가 없거나(구버전 발신자)
 * 배열이 아니거나 아는 사유가 하나도 없으면 전부 `["unknown"]`로 접는다 — 그 값은 판정기가
 * 언제나 리로드로 취급하므로, 형식 위반의 결과는 항상 **안전한 쪽**이다.
 */
export function parseRebuildReasons(payload: unknown): RebuildReason[] {
  const raw = (payload as { reasons?: unknown } | null | undefined)?.reasons;
  if (!Array.isArray(raw)) return ["unknown"];
  const known = raw.filter((r): r is RebuildReason =>
    (REBUILD_REASONS as readonly unknown[]).includes(r),
  );
  // 아는 사유가 하나도 없으면(빈 배열·모르는 문자열만) 모른다는 뜻이다.
  return known.length > 0 ? [...new Set(known)] : ["unknown"];
}

/**
 * 복구 화면(설정 창) → 노트 창: 노트 하나의 본문이 스냅샷 복원으로 디스크에서 바뀌었다(finding 4).
 * payload `{ id }`. 그 id의 노트 창이 열려 있으면 자기 에디터 버퍼를 디스크로 다시 읽어야 한다 —
 * 그러지 않으면 낡은 버퍼가 다음 자동저장(write_content, 스냅샷 없음)에서 복원 내용을 조용히
 * 덮어, 복구 화면의 "복원했어요"가 거짓이 된다. `EV_HOST_UPDATED`(전체 리로드)와 달리 이 신호는
 * **콘텐츠만** 다시 읽는다(창을 통째로 리로드하지 않아 스크롤·플러그인 상태를 보존한다).
 */
export const EV_NOTE_RESTORED = "note-restored";

/**
 * Rust 백엔드 → 모든 창(사실상 그 노트의 열린 창): 그 id의 노트가 방금 삭제됐다. payload
 * `{ id }`.
 *
 * 그 id의 노트 창이 열려 있으면(패널에서 지웠거나, 이 창 자신의 삭제 버튼을 눌렀거나 — 두
 * 경로 다 같은 백엔드 커맨드를 타므로 함께 온다) 대기 중인 자동저장을 취소하고 스스로
 * 닫아야 한다. 왜: 노트 창은 `pagehide`에 자동저장 flush를 달아 둔다(`note-window.ts`) —
 * 취소 없이 닫히면(또는 강제로 닫히면) 그 flush가 방금(또는 곧) 지워질 `.md`를 되살릴 수
 * 있다(`write_atomic`이 부모 디렉터리까지 새로 만든다). 백엔드는 파일을 지우기 **전에** 이
 * 이벤트를 보내 창이 먼저 정리할 기회를 준다 — 창이 제한 시간 안에 닫히지 않으면 백엔드가
 * 강제로 닫고, 그 마지막 flush는 `note_save_content`의 삭제-후-쓰기 가드가 무해화한다
 * (`src-tauri/src/commands.rs` 참고 — 두 방어가 겹으로 있다).
 *
 * 왜 Rust가 직접 emit하는가: 삭제는 백엔드 `note_delete` 커맨드 한 곳에서 처리되는데, 그
 * 커맨드가 파일을 지우기 **전에** 창을 정리해야 하는 시점이 바로 거기다 — 프론트 invoke
 * 왕복을 거치지 않고 백엔드가 직접 방송한다([`EV_NOTES_LIST_CHANGED`]가 트레이·전역 단축키
 * 새 노트에서 같은 이유로 Rust가 직접 emit하는 것과 같은 사정).
 */
export const EV_NOTE_DELETED = "note-deleted";

/**
 * Rust 백엔드 → 모든 창(사실상 그 노트의 열린 창): 창을 **세로로 리사이즈해서** 접힘/펼침이
 * 뒤집혔다. payload `{ id, collapsed }`.
 *
 * 접기는 보통 툴바 버튼이 시작하지만(프론트 → `set_note_collapsed`), 반대 방향도 있다: 접힌
 * 창을 아래로 끌어 늘리면 펼침으로, 펼친 창을 최소 높이까지 줄이면 접힘으로 자동 전환된다
 * (`window_manager::collapse_from_resize`). 그 판정의 입력인 **창 크기 실측**은 오직
 * `save_window_geometry`(리사이즈 디바운스)로만 백엔드에 도착하므로, 이 전이를 아는 쪽은
 * 백엔드뿐이다 — 알리지 않으면 창은 펼쳐졌는데 접기 버튼은 접힘으로 남고 에디터도 계속
 * 숨겨진 채가 된다.
 *
 * 받은 창은 **표시만** 되맞춘다(버튼 상태·에디터/하단 바 표시). 창 높이와 메타는 백엔드가
 * 이미 확정했으므로 `set_note_collapsed`를 되부르지 않는다 — 되부르면 그 리사이즈가 다시
 * 이 신호를 낳는 왕복이 된다.
 */
export const EV_NOTE_COLLAPSED_CHANGED = "note-collapsed-changed";

/**
 * 어떤 1st-party 창이든(노트 창의 삭제/보관/저장, 패널 자신의 삭제 버튼) → 모든 창: 노트
 * 목록이 바뀌었을 수 있다(생성·삭제·보관·제목이 바뀌는 저장). 패널이 이 신호를 받아 목록을
 * 다시 불러와 그린다.
 *
 * 왜 [`EV_NOTES_RELOAD`]와 별개인가: 그 채널은 중앙 호스트의 **플러그인 재빌드**(모든
 * 샌드박스 dispose+재실행, 그 결과에 따라 노트 창 리로드까지)를 트리거하는 무거운 신호다.
 * 노트 하나가 삭제·저장됐다고 플러그인 전체를 다시 실행하거나 다른 노트 창을 리로드할
 * 이유가 없다 — 패널만 목록을 다시 그리면 충분하다. 페이로드는 없다(무엇이 바뀌었는지보다
 * "다시 물어봐라"만 전달하면 패널이 `listNotes`/`searchNotes`로 항상 참값을 다시 읽는다).
 */
export const EV_NOTES_LIST_CHANGED = "notes-list-changed";

/**
 * 노트 창 → **Rust 백엔드**(웹뷰가 아니라): 설정 창을 열어 달라는 요청(이슈 #16 — 노트 툴바의
 * 설정 바로가기 버튼). 백엔드 `tray.rs`가 `Listener`로 이 이벤트를 구독해
 * `window_manager::open_settings`를 호출한다.
 *
 * 왜 Tauri 커맨드(`invoke`)가 아니라 이벤트인가: 정공법은 새 `#[tauri::command]`를 등록하고
 * `lib.rs`의 `invoke_handler`에 추가하는 것이지만, 그 등록 지점(`commands.rs`/`lib.rs`)이 이
 * 기능을 만들 당시 다른 작업으로 잠겨 있었다. 이 채널들이 이미 프론트↔백엔드 양방향으로
 * 닿는다는 사실(신뢰 경계 문서 참고)을 이용해, `emit`으로 보내고 백엔드가 `listen`으로 받는
 * 우회로를 썼다 — 등록 파일을 건드리지 않고도 실제로 동작한다.
 */
export const EV_REQUEST_OPEN_SETTINGS = "request-open-settings";

/**
 * 설정 창 → 열려 있는 모든 창: 공유 설정에서 **국소 반영이 가능한 키만** 바뀌었다.
 * payload [`SettingsChangedLocalPayload`].
 *
 * 왜 [`EV_NOTES_RELOAD`]와 별개인가: 그 채널은 **중앙 호스트 재빌드를 거친다** — 색 하나를
 * 고쳐도 모든 샌드박스가 dispose·재실행되고(플러그인 상태 초기화), 그 완료 방송이 노트 창의
 * 재조회·판정을 부른다. 이 채널은 바뀐 키 목록을 실어 호스트를 아예 거치지 않고 받는 창이
 * 그 항목만 제자리에서 다시 적용하게 한다(재빌드도 리로드도 없음 → 샌드박스까지 그대로).
 * 재빌드가 필요한 변화는 [`RebuildReason`]을 실어 그쪽 채널로 간다.
 *
 * **값은 싣지 않는다** — 각 창이 `getSharedSettings()`로 최신 상태를 직접 재조회한다.
 * 이벤트에 값을 실으면 여러 저장이 겹칠 때 늦게 도착한 옛 값이 새 값을 덮을 수 있고,
 * 리로드 경로(디스크가 정본)와 정본이 갈라진다.
 *
 * 보내는 쪽 계약: 바뀐 키가 **전부** `settings-diff.ts`의 `LOCAL_APPLY_KEYS`에 속할 때만
 * 낸다. 하나라도 벗어나면 이 이벤트 없이 기존 `EV_NOTES_RELOAD` 경로를 그대로 탄다(그때
 * 대기 중이던 이 이벤트는 버려진다 — 리로드가 최종 상태를 전부 담으므로 중복 반영이 없다).
 * 받는 쪽 계약: 모르는 키가 하나라도 섞여 있으면 **전부 무시**한다(방어적 — 반쯤 반영된
 * 상태를 만들지 않는다). 재조회가 실패해도 리로드로 대체하지 않는다(무시).
 */
export const EV_SETTINGS_CHANGED_LOCAL = "settings-changed-local";

/** 노트 창 → 호스트: 스냅샷 요청(재시도 시 같은 requestId 재방송). */
export const EV_SNAPSHOT_GET = "plugin-host:get";

/** 호스트 → 노트 창: 스냅샷 응답(requestId가 일치하는 요청자만 소비). */
export const EV_SNAPSHOT = "plugin-host:snapshot";

/** 노트 창 → 호스트: 플러그인 툴바 버튼 클릭(해당 샌드박스의 onClick 실행 요청). */
export const EV_BUTTON_INVOKE = "plugin-host:invoke";

/**
 * 네이티브(Rust 트레이) → 호스트: 플러그인 메뉴바 트레이 항목이 클릭됐다.
 *
 * 왜 별도 채널인가: 트레이는 특정 노트 창과 무관한 **앱 전역** 자원이라, 클릭이 어느 창의
 * 컨텍스트로도 오지 않는다([`EV_BUTTON_INVOKE`]는 항상 `windowLabel`을 싣지만 이건 없다).
 * 방송 주체는 **네이티브 Rust 트레이 핸들러 하나뿐**이다(플러그인 샌드박스는 Tauri IPC에
 * 닿지 못하므로 이 채널을 위조할 수 없다 — 다른 1st-party 채널과 같은 신뢰 경계). 호스트는
 * 이 이벤트로 그 플러그인의 `run` 핸들러를 창 컨텍스트 없이 역호출한다(설정 화면 액션 버튼과
 * 같은 폴백 계약).
 */
export const EV_TRAY_INVOKE = "plugin-tray:invoke";

/** 호스트 → 노트 창: 창-스코프 서비스 호출 위임(toast·글자 델타·클립보드·현재 노트). */
export const EV_WINDOW_CALL = "plugin-host:window-call";

/** 노트 창 → 호스트: 창-스코프 호출 결과 회신(requestId 상관). */
export const EV_WINDOW_RESULT = "plugin-host:window-result";

/**
 * 호스트 → 모든 창: 재빌드 완료 방송. payload [`HostUpdatedPayload`].
 *
 * 노트 창은 이 신호에 **무조건 리로드하지 않는다**: 실린 사유와 새 스냅샷·설정을 예전 값과
 * 비교해, 이미 재적용 API가 있는 표면만 바뀌었으면 제자리에서 조정하고(창 상태 보존) 그 밖의
 * 변화면 예전처럼 리로드한다(판정 정본은 `bootstrap/host-update-plan.ts` — 모르면 리로드).
 * 패널·설정 창은 예전 그대로 payload를 무시하고 각자의 갱신을 한다.
 */
export const EV_HOST_UPDATED = "plugin-host:updated";

/**
 * 개발 소스 감시 → 호스트: 개발 중인 플러그인 하나의 코드가 바뀌었다(단일 핫리로드).
 *
 * 왜 `EV_NOTES_RELOAD`와 별개인가: 재빌드 방송은 **모든** 샌드박스를 dispose·재실행하고,
 * 노트 창들은 그 결과를 재조회해 제자리 조정이든 `location.reload()`든 각자 판정한다
 * (`bootstrap/host-update-plan.ts` — 리로드로 떨어지면 스크롤·선택·IME 조합이 날아간다).
 * 이 채널은 바뀐 플러그인 id를 실어, 호스트가 **그 하나만** 다시 실행하고 나머지 샌드박스·
 * 노트 창 상태를 보존하게 한다. 방송 주체는 Rust 파일 감시자(`set_dev_plugin`)뿐이다 —
 * 개발 모드는 세션 한정이라 프로덕션 경로에서는 이 이벤트가 절대 나지 않는다.
 */
export const EV_PLUGIN_DEV_RELOAD = "plugin-host:dev-reload";

/**
 * 호스트 → 노트 창: 플러그인 **하나만** 핫리로드됐다(개발 중인 설치·사이드로드 플러그인의
 * 단일 핫리로드 전용 — builtin 플러그인의 변화는 이 채널을 타지 않고 항상 전체 빌드 +
 * [`EV_HOST_UPDATED`]로 간다). 노트 창은 전체 리로드 대신 그 플러그인의 CM 확장을
 * 재구성하고(Compartment reconfigure — 창 상태 보존), **함께** 툴바 버튼·상태 아이템·명령·
 * 메뉴 항목(툴바 항목 넷)을 새 스냅샷으로 키 diff해 맞춘다
 * (`NoteWindowHandle.reconcileToolbarItems`) — 예전엔 CM 확장만 재구성해 버튼·명령 변화는
 * 항상 전체 리로드로 폴백했지만, 상태 아이템·메뉴 항목은 애초에 그 폴백 판정에도 없어서 그
 * 둘만 바꾼 개발 편집이 부분 갱신을 타고도 화면에 반영되지 않는 무음 실패가 있었다 — 이제
 * 넷 다 같은 경로로 따라간다.
 *
 * 스냅샷 전체를 싣는 이유: 노트 창의 CM 확장은 플러그인마다 따로가 아니라 **한 Compartment**로
 * 합쳐 들어간다(`setPluginExtensions`가 전부를 한 번에 설정). 그래서 한 플러그인만 바뀌어도
 * 노트 창은 최신 스냅샷 전체로 확장을 다시 만들어야 한다 — 그 재구성이 dispatch 한 번이라
 * 에디터를 새로 만들지 않고 스크롤·선택·IME 조합을 유지한다.
 *
 * **부분 갱신이 불가능한 변화**는 호스트가 이 이벤트가 아니라 [`EV_HOST_UPDATED`]로
 * 폴백한다(전체 리로드) — 폴백 사유는 등록 순서 의존 병합 능력(배경·폰트·창 컨트롤)이
 * 걸려 있거나, 전역 구독 이벤트 집합이 바뀌었거나, 플러그인 슬롯이 추가·제거·실패했을 때다
 * (`central-host.ts`의 `canPartial` 참고 — 위험 절: 부분 갱신 로직은 새 버그 표면이라
 * 경계를 보수적으로 긋는다).
 */
export const EV_HOST_PLUGIN_UPDATED = "plugin-host:plugin-updated";

/**
 * 노트 창 → 호스트: 노트 생명주기 이벤트가 났다.
 *
 * **구독자가 있는 이름만 방송한다** — 스냅샷의 [`HostSnapshot.subscribedEvents`]에 없는
 * 이름이면 노트 창이 아예 emit하지 않는다. 왜: 이 방송은 타이핑 중 자동저장마다 도는
 * 경로라, 아무도 구독하지 않는 앱(=대부분)에서 IPC 트래픽이 0이어야 한다.
 */
export const EV_PLUGIN_EVENT = "plugin-host:event";

/**
 * 설정 창 → 호스트: 플러그인 설정 값 1건이 **폼에서** 바뀌었다.
 *
 * 왜 `EV_NOTES_RELOAD`와 별개인가: 재빌드 방송이 싣는 것은 거친 사유([`RebuildReason`])뿐이고
 * 400ms 디바운스된다 — 어떤 키가 어떤 값으로 바뀌었는지는 거기 없다. 이 채널은 바뀐 키·값을
 * 즉시 실어 보내, 아직 살아 있는 샌드박스가 재빌드에 죽기 **전에** `settings:changed`를 받게
 * 한다. 재빌드 동작 자체는 그대로다(통지만).
 */
export const EV_PLUGIN_SETTING_CHANGED = "plugin-host:setting-changed";

/**
 * 플러그인이 구독할 수 있는 이벤트 이름 전수 — **닫힌 열거이자 계약**이다.
 *
 * 왜 좁게 시작하나: 이름을 **추가**하는 것은 순수 추가라 싸지만, **제거**하면 그 이름을
 * 구독하던 플러그인이 오류도 없이 조용히 안 불린다(무음 실패). 그래서 첫 배포는 저빈도
 * 6종뿐이고, 키 입력마다 나는 텍스트 변경 같은 고빈도 이벤트는 **의도적으로 없다** —
 * 상주 샌드박스 1개가 모든 창을 공유하므로 트래픽이 창 수 × 플러그인 수로 곱해진다.
 */
export const MEMO_EVENT_NAMES = [
  "note:opened",
  "note:saved",
  "note:focused",
  "note:blurred",
  "note:closed",
  "settings:changed",
] as const;

/** 구독 가능한 이벤트 이름(=[`MEMO_EVENT_NAMES`]의 원소). */
export type MemoEventName = (typeof MEMO_EVENT_NAMES)[number];

/** 신뢰 경계 밖 문자열이 아는 이벤트 이름인지(샌드박스·노트 창 입력 검사). */
export function isMemoEventName(value: unknown): value is MemoEventName {
  return (
    typeof value === "string" &&
    (MEMO_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * 이벤트 이름 → 구독에 **추가로** 필요한 권한(없으면 null).
 *
 * 왜 여기서 또 검사하나: `CALL_PERMISSIONS`는 호출 1개당 권한 1개라, `events.on` 한 이름으로
 * "노트 이벤트는 민감, 설정 이벤트는 저위험"을 표현할 수 없다. 그래서 게이트키퍼는 **바닥**
 * (`settings`, 저위험)만 보고, 이름별 추가 권한은 중앙 호스트의 수행부가 같은
 * `checkPermission`으로 한 번 더 판정한다 — 게이트를 **좁히는** 검사라 우회 경로가 아니다.
 * 이 표가 저작 계약(`api-index.ts`)의 문구도 만들어, 코드와 문서가 갈라질 수 없다.
 */
export const MEMO_EVENT_PERMISSION: Readonly<
  Record<MemoEventName, string | null>
> = {
  // 노트가 언제 열리고 저장되는지 + 그 노트의 id·경로는 노트 데이터다 → 민감 게이트.
  "note:opened": "notes:read",
  "note:saved": "notes:read",
  "note:focused": "notes:read",
  "note:blurred": "notes:read",
  "note:closed": "notes:read",
  // 자기 플러그인의 설정 값이라 `events.on`의 바닥 권한(settings) 외에 더 필요한 것이 없다.
  "settings:changed": null,
};

/** [`EV_PLUGIN_EVENT`] 페이로드(노트 창 → 호스트) — 본문은 절대 싣지 않는다. */
export interface NoteEventPayload {
  name: MemoEventName;
  /** 이벤트가 난 노트 창 라벨(`note-<id>`) — 호스트가 컨텍스트 토큰으로 되짚는 열쇠. */
  windowLabel: string;
  noteId: string;
  /** 노트 본문 파일의 절대경로(vault 경로를 못 읽었으면 null). */
  path: string | null;
  /** 이벤트 발생 시각(에폭 ms). */
  at: number;
}

/** [`EV_PLUGIN_SETTING_CHANGED`] 페이로드(설정 창 → 호스트). */
export interface PluginSettingChangedPayload {
  pluginId: string;
  key: string;
  /** 방금 저장된 값(호스트가 소유한 **저장 형태**). */
  value: unknown;
}

/** [`EV_SETTINGS_CHANGED_LOCAL`] 페이로드(설정 창 → 모든 창). */
export interface SettingsChangedLocalPayload {
  /**
   * 이번에 바뀐 설정 키(최상위 키, `defaults`만 `defaults.<서브키>` 점 표기). 짧은 디바운스
   * 동안 쌓인 여러 저장의 **합집합**이라 순서·중복은 의미가 없다. 값은 담기지 않는다 —
   * 받는 창이 `getSharedSettings()`로 재조회한다(위 채널 문서 참고).
   */
  changedKeys: string[];
}

/** [`EV_PLUGIN_DEV_RELOAD`] 페이로드(개발 소스 감시 → 호스트). */
export interface PluginDevReloadPayload {
  /** 코드가 바뀐(개발 중인) 플러그인 id — 호스트가 이 하나만 다시 실행한다. */
  pluginId: string;
}

/**
 * [`EV_HOST_PLUGIN_UPDATED`] 페이로드(호스트 → 노트 창).
 *
 * `pluginId`는 진단·로그용이다(무엇이 핫리로드됐는지). 노트 창은 `snapshot` 전체로 CM
 * 확장을 다시 만든다(위 `EV_HOST_PLUGIN_UPDATED` 문서 참고).
 */
export interface HostPluginUpdatedPayload {
  revision: number;
  pluginId: string;
  snapshot: HostSnapshot;
}

/**
 * 이벤트 버스 추상화 — 프로덕션은 Tauri 전역 이벤트, 테스트는 로컬 버스를 주입한다.
 *
 * `listen`은 해제 함수를 돌려준다(요청/응답 상관이 끝나면 리스너를 정리하기 위함).
 */
export interface HostEventBus {
  emit(event: string, payload: unknown): void;
  listen(event: string, handler: (payload: unknown) => void): () => void;
}

/** 직렬화 가능한 툴바 버튼 스냅샷 — onClick 대신 buttonId(호스트 역호출 키)를 담는다. */
export interface SnapshotToolbarButton {
  id: string;
  label: string;
  title?: string;
  position: ToolbarPosition;
  /**
   * 샌드박스가 onClick 핸들러를 보관한 키 — 클릭 시 호스트가 이 키로 역호출한다.
   *
   * 이 값은 범용 핸들러 id(`onClick$id`)와 **같은 문자열**이다. 이름을 `handlerId`로
   * 바꾸지 않은 것은 하위호환 때문이다(중앙 호스트·노트 창이 이 필드명을 쓴다).
   */
  buttonId: string;
}

/**
 * 플러그인이 등록한 **상태 표시형 아이템** 1건의 직렬화 스냅샷(`ui.addStatusItem`).
 *
 * 왜 버튼과 다른 배열인가: 상태 아이템은 기본적으로 클릭 동작이 아니라 **텍스트·카운트를
 * 보여주는** 것이다. 버튼 배열(`buttons`)에 섞으면 단축키 화면(`activeToolbarButtons`)에도
 * 배정할 수 없는 항목이 뜬다.
 * 그럼에도 **툴바 배치 시스템은 버튼과 공유한다** — 사용자가 「툴바 배치」 편집기에서 버튼과
 * 동급으로 옮길 수 있다(사용자 확정). 다만 키는 버튼과 **같은 네임스페이스가 아니다**:
 * `host-client.ts`의 `snapshotToolbarButtons`가 이 `id`에 `status:`를 접두해
 * `plugin:<pluginId>:status:<id>`로 만든다(명령의 `cmd:`, 메뉴의 `menu:`와 같은 이유·같은
 * 방식) — 접두 없이 버튼과 똑같은 `plugin:<pluginId>:<id>`를 썼다면, 한 플러그인이 버튼과
 * 상태 아이템에 같은 id를 등록했을 때 노트 창의 `reconcileToolbarItems`가 둘을 같은 키로
 * 접어 하나가 다른 하나를 무음으로 덮었다(회귀 이력). 렌더만 버튼이 아니라 텍스트다.
 *
 * `text`는 **초기값**이다 — 등록 후 플러그인이 `ui.updateStatusItem`(창-스코프)으로 그 창의
 * 표시 텍스트를 갱신한다(단어 수처럼 창마다·시점마다 다른 값). 스냅샷은 전역이라 여기에는
 * 등록 시점의 초기 텍스트만 싣고, 창별 라이브 값은 창-스코프 갱신이 나른다.
 */
export interface SnapshotStatusItem {
  /**
   * 저작자가 준(또는 호스트가 만든) 안정 id — `ui.updateStatusItem`이 그대로 받는 **원래
   * (무접두)** 조회 키다. 툴바 배치 키는 이 값 그대로가 아니라 `status:`가 접두된
   * `plugin:<pluginId>:status:<id>`다(위 문서 참고).
   */
  id: string;
  /** 처음 그려질 텍스트/카운트(등록 후 `ui.updateStatusItem`으로 갱신). */
  text: string;
  /** 툴팁(마우스 오버 설명). */
  title?: string;
  /** 배치가 이 키를 한 번도 본 적 없을 때 쓰는 자동 배치 존(버튼과 같은 폴백 규칙). */
  position: ToolbarPosition;
  /**
   * 클릭 핸들러(선택) — 저작자가 `ui.addStatusItem`에 `onClick`을 줬을 때만 실린다.
   *
   * 버튼의 `buttonId`와 **같은 성격**(샌드박스가 보관한 핸들러 id, 클릭 시 호스트가 이 키로
   * 역호출한다)이라 필드명도 그대로 재사용한다 — `snapshotToolbarButtons`가 버튼·상태 아이템을
   * 같은 방식으로 클릭-배선할 수 있게. 없으면(대부분의 상태 아이템) 클릭 버튼이 아니라 순수
   * 텍스트로 렌더된다(커서·hover도 주지 않는다).
   */
  buttonId?: string;
}

/**
 * 플러그인이 등록한 **메뉴바 트레이 항목** 1건의 직렬화 스냅샷(`ui.addTrayItem`).
 *
 * 왜 다른 배열인가: 트레이 항목은 노트 창이 그리는 것이 아니라 **네이티브(Rust) 트레이가**
 * 그린다 — 노트 창의 툴바·컨텍스트 메뉴 어디에도 자리를 차지하지 않는다. 그래서 노트 창에
 * 배달되는 다른 스냅샷 조각(버튼·상태 아이템·메뉴 항목)과 소비처가 다르다: 중앙 호스트가
 * 이 조각들을 (플러그인, id, label)로 평탄화해 네이티브 트레이 커맨드로 보내고, Rust가
 * 고정 항목 아래 「플러그인」 섹션에 얹는다.
 *
 * `handlerId`는 싣지 않는다(역호출 대상은 호스트만 안다 — 버튼·명령·메뉴와 같은 규칙).
 * 네이티브는 클릭을 (pluginId, id)로 되쏘고([`TrayInvokePayload`]), 호스트가 그 id로 `run`을
 * 되짚는다. `when`·`needsSelectedText` 같은 조건은 없다: 트레이는 창 상태와 무관한 전역
 * 표면이라 라이브 노트 상태로 표시 여부를 가릴 근거가 없다.
 */
export interface SnapshotTrayItem {
  /** 저작자가 준(또는 호스트가 만든) 안정 id — 네이티브가 클릭을 되쏠 때 싣는다. */
  id: string;
  /** 트레이 메뉴에 보일 이름(비어 있지 않다 — 등록 시점에 강제). */
  label: string;
}

/**
 * 플러그인이 등록한 **버튼 없는 명령** 1건의 직렬화 스냅샷.
 *
 * 왜 버튼과 다른 배열인가: 명령은 툴바를 차지하지 않는다. 버튼 배열에 섞으면 노트 툴바가
 * 유령 버튼을 그리고 「툴바 배치」 편집기에도 배치할 수 없는 항목이 뜬다(결정이 (c)안을
 * 버린 이유가 정확히 그것이다). 소비처는 **설정 › 단축키 › 「플러그인 동작」 하나뿐**이고,
 * 실행은 노트 창 키맵이 `plugin:<pluginId>:cmd:<id>`를 호스트로 되쏘아 일어난다.
 *
 * `handlerId`를 싣지 않는다: 역호출 대상은 호스트만 알면 되고(호스트가 id로 되짚는다),
 * 노트 창에 실어 보내면 그 값이 창을 통해 흘러 다니는 이유가 없다.
 */
export interface SnapshotCommand {
  /** 저작자가 준(또는 호스트가 만든) 안정 id — 단축키 바인딩이 붙는 영속 키. */
  id: string;
  /** 단축키 화면에 보일 이름. */
  title: string;
  /** true면 호스트가 실행 **전에** 그 창에 확인 팝업을 띄운다(취소하면 실행하지 않는다). */
  destructive?: boolean;
  /**
   * `when` 항목 중 **메모 창의 상태를 봐야만** 판정할 수 있는 키들(지금은 `note.isEmpty`뿐 —
   * 없으면 생략). 설정 화면 액션 버튼이 창 컨텍스트 없는 실행을 **요청하기 전에**
   * "왜 설정 화면에서는 실행할 수 없는지"를 정확히 말하는 근거다(정본은 `WINDOW_WHEN_KEYS`).
   */
  whenPendingKeys?: string[];
}

/**
 * 플러그인이 등록한 **메뉴 전용 항목** 1건의 직렬화 스냅샷(`ui.addMenuItem`).
 *
 * 왜 버튼·명령과 다른 배열인가: 메뉴 항목은 툴바에도 단축키 화면에도 **자리를 차지하지
 * 않는다**(에디터 우클릭 메뉴에만 나타난다). 버튼(`buttons`)이나 명령(`commands`)에 섞으면
 * 그 표면에 유령 항목이 뜬다(이 명령을 별도 배열로 둔 이유와 같다).
 *
 * `handlerId`는 싣지 않는다(역호출 대상은 호스트만 안다 — 버튼·명령과 같은 규칙). 노트 창은
 * `id`로 클릭을 되쏘고, 호스트가 그 id로 `run` 핸들러를 되짚는다.
 */
export interface SnapshotMenuItem {
  /** 저작자가 준(또는 호스트가 만든) 안정 id — 노트 창이 클릭을 되쏠 때 싣는다. */
  id: string;
  /** 컨텍스트 메뉴에 보일 이름(비어 있지 않다 — 등록 시점에 강제). */
  label: string;
  /**
   * 표시 조건 — [`WhenTerm`]의 창 상태 키(`note.isEmpty`·`note.hasSelection`)뿐이다.
   * **노트 창이 렌더 직전에** 자기 에디터 상태로 판정한다(정적 키가 아니라 창 상태라 호스트가
   * 미리 굳힐 수 없다 — `loader.ts`의 `MENU_WHEN_KEYS` 참고). 비면 항상 표시.
   */
  when?: WhenTerm[];
  /**
   * 이 항목의 `run`이 `payload.selectedText`(선택 텍스트)를 받는가 — **`notes:read`가
   * 부여됐을 때만** 호스트가 참으로 채운다(payload 단위 게이트). 노트 창은 이 값이 참일 때만
   * 클릭에 선택 텍스트를 실어 보내고, 호스트도 부여를 다시 확인해 싣는다(심층 방어).
   */
  needsSelectedText?: boolean;
}

/**
 * 플러그인이 등록한 **선택 액션** 1건의 직렬화 스냅샷(`ui.addSelectionAction`).
 *
 * 왜 메뉴 항목과 다른 배열인가: 표면이 다르다 — 선택 액션은 본문을 선택하면(마우스든
 * 키보드든) 뜨는 선택 툴바와 「설정 › 단축키 › 플러그인 동작」 두 곳에 나타나고, 메뉴 항목은
 * 어느 쪽에도 없다. 섞으면 두 표면에 서로의 유령 항목이 뜬다(명령·메뉴 항목을 나눈 이유와 같다).
 *
 * `match`(표시 조건)를 그대로 싣는 이유: 판정은 **선택이 확정된 순간 그 창이** 로컬로 한다
 * (샌드박스 왕복·방송 0). 어휘가 닫혀 있어(`selection-action.ts`) 판정에 필요한 것이 전부
 * 직렬화되므로 가능한 설계다. `handlerId`는 싣지 않는다(역호출은 호스트가 id로 되짚는다 —
 * 버튼·명령·메뉴 항목과 같은 규칙).
 */
export interface SnapshotSelectionAction {
  /** 저작자가 준(또는 호스트가 만든) 안정 id — 창이 실행을 되쏠 때 싣고, 단축키가 붙는 키다. */
  id: string;
  /** 버튼에 보일 글자/이모지(비어 있지 않다 — 등록 시점에 강제). */
  label: string;
  /** 툴팁·단축키 목록 이름(없으면 소비처가 `label`로 폴백). */
  title?: string;
  /**
   * 표시 조건 — `charClasses`·`singleLine`·`maxLength`의 닫힌 어휘(정본은
   * `selection-action.ts`의 `parseSelectionMatch`). 없으면 선택이 있을 때 언제나 표시.
   */
  match?: SelectionMatch;
  /**
   * 이 액션의 `run`이 `payload.selectedText`를 받는가 — **`notes:read`가 부여됐을 때만**
   * 호스트가 참으로 채운다(`SnapshotMenuItem.needsSelectedText`와 같은 payload 단위 게이트).
   */
  needsSelectedText?: boolean;
}

/**
 * 플러그인 1개의 직렬화 스냅샷 — 노트 창이 CM 확장·버튼을 로컬 인스턴스화하는 데 필요한
 * 전부. `grant`는 호스트가 이미 선언∩부여로 좁힌 값으로, 노트 창의 임베드 도메인 게이트
 * (`embed:<domain>`)와 데이터 서비스 연결(notes:read/windows) 판정에 그대로 쓰인다.
 */
export interface PluginSnapshot {
  pluginId: string;
  grant: PluginGrant;
  /**
   * 1st-party 번들(빌트인)인가, 사이드로드(커뮤니티) 설치 플러그인인가 — 중앙 호스트가
   * `runPlugin`을 부르는 두 경로(번들 루프 vs `runPreparedInstalled`)에서 이미 아는 값을
   * 그대로 싣는다. 선택 필드인 이유는 다른 선택 필드와 같다(구버전 스냅샷 폴백).
   *
   * 소비처: 노트 창 컨텍스트 메뉴가 이 값으로 **빌트인 플러그인 출처 항목만** 걸러낸다 —
   * 빌트인은 툴바 버튼이 이미 있어 이름으로 또 나열하면 중복이었다(커뮤니티 항목은 그대로
   * 나열된다). `host-client.ts`의 `snapshotToolbarButtons`가 이 값을 각 `PluginWindowItem`에
   * 그대로 실어 내린다.
   */
  builtin?: boolean;
  patterns: InlinePatternDescriptor[];
  completions: CompletionDescriptor[];
  embeds: BlockEmbedDescriptor[];
  buttons: SnapshotToolbarButton[];
  /**
   * 이 플러그인이 등록한 버튼 없는 명령(없으면 빈 배열/생략).
   *
   * 선택 필드인 이유: 구버전 스냅샷을 받은 창·설정 화면이 `?? []`로 읽어 "명령 없음"이 되는
   * 안전한 폴백이 되게 한다(`subscribedEvents`와 같은 규칙).
   */
  commands?: SnapshotCommand[];
  /**
   * 이 플러그인이 등록한 상태 표시형 아이템(없으면 빈 배열/생략).
   *
   * 선택 필드인 이유: 구버전 스냅샷을 받은 창·설정 화면이 `?? []`로 읽어 "상태 아이템 없음"이
   * 되는 안전한 폴백이 되게 한다(`commands`·`menuItems`·`subscribedEvents`와 같은 규칙).
   */
  statusItems?: SnapshotStatusItem[];
  /**
   * 이 플러그인이 등록한 메뉴 전용 항목(없으면 빈 배열/생략).
   *
   * 선택 필드인 이유: 구버전 스냅샷을 받은 창이 `?? []`로 읽어 "메뉴 항목 없음"이 되는 안전한
   * 폴백이 되게 한다(`commands`·`subscribedEvents`와 같은 규칙).
   */
  menuItems?: SnapshotMenuItem[];
  /**
   * 이 플러그인이 등록한 선택 액션(없으면 빈 배열/생략).
   *
   * 선택 필드인 이유: 구버전 스냅샷을 받은 창·설정 화면이 `?? []`로 읽어 "선택 액션 없음"이
   * 되는 안전한 폴백이 되게 한다(`commands`·`menuItems`와 같은 규칙).
   */
  selectionActions?: SnapshotSelectionAction[];
  /** 배경 플러그인이면 등록한 배경 디스크립터(그 외 플러그인은 null/생략). */
  background?: BackgroundDescriptor | null;
  /** 폰트 플러그인이면 등록한 폰트 디스크립터(그 외 플러그인은 null/생략). */
  font?: FontDescriptor | null;
  /** 이 플러그인이 등록한 창 컨트롤 능력 id(창 기능 플러그인만 — 그 외는 빈 배열/생략). */
  windowControls?: string[];
  /**
   * 이 플러그인이 등록한 메뉴바 트레이 항목(없으면 빈 배열/생략).
   *
   * 선택 필드인 이유: 구버전 스냅샷을 받은 소비처가 `?? []`로 읽어 "트레이 항목 없음"이 되는
   * 안전한 폴백이 되게 한다(`commands`·`menuItems`·`subscribedEvents`와 같은 규칙). 이 조각은
   * 노트 창이 아니라 **중앙 호스트**가 네이티브 트레이로 평탄화해 보내는 유일한 소비처를 갖는다.
   */
  trayItems?: SnapshotTrayItem[];
}

/**
 * 중앙 호스트 → 네이티브(Rust) 트레이: 평탄화된 플러그인 트레이 항목 하나.
 *
 * 왜 (pluginId, id, label) 세 값인가: 네이티브는 클릭을 되쏠 때 pluginId·id가 둘 다 필요하다
 * (호스트가 (pluginId, id)로 `run`을 되짚는다 — `EV_TRAY_INVOKE`). label만으로는 같은 이름을
 * 쓴 두 플러그인을 가를 수 없다. 스냅샷의 [`SnapshotTrayItem`]에는 pluginId가 없지만(그 조각은
 * 이미 플러그인별로 묶여 있다), 네이티브로는 평탄한 목록으로 나가므로 pluginId를 함께 싣는다.
 */
export interface TrayItemDescriptor {
  pluginId: string;
  id: string;
  label: string;
}

/**
 * [`EV_TRAY_INVOKE`] 페이로드(네이티브 → 호스트) — 어느 플러그인의 어느 트레이 항목이
 * 눌렸는지.
 *
 * `windowLabel`이 없다: 트레이는 앱 전역 자원이라 클릭에 창 컨텍스트가 없다(설정 화면 액션
 * 버튼과 같은 계약 — 호스트가 창 컨텍스트 없이 `run`을 역호출하고, `run` 안의 창-스코프
 * 호출은 마지막으로 쓴 메모 창으로 폴백하거나 없으면 CONTEXT_UNAVAILABLE + 진단).
 */
export interface TrayInvokePayload {
  pluginId: string;
  trayItemId: string;
}

/** 로드에 실패한 플러그인 한 건(설정 매니저가 사유와 함께 표시). */
export interface PluginFailure {
  pluginId: string;
  error: string;
}

/** 중앙 호스트가 배달하는 전체 스냅샷(활성 테마 + 배경 + 폰트 + 활성 플러그인들, 수집 순서 유지). */
export interface HostSnapshot {
  /** 재빌드마다 1씩 증가(디버깅·최신성 확인용). */
  revision: number;
  theme: ThemeDescriptor;
  /** 활성 배경 능력(활성화된 배경 플러그인이 등록한 것, 없으면 null). */
  background: BackgroundDescriptor | null;
  /** 활성 폰트 능력(활성화된 폰트 플러그인이 등록한 것, 없으면 null). */
  font: FontDescriptor | null;
  /** 활성화된 창 기능 플러그인들이 제공하는 컨트롤 id의 합집합(툴바가 조건부 렌더에 사용). */
  windowControls: string[];
  /**
   * 이번 빌드에서 **구독자가 하나라도 있는** 이벤트 이름들 — 노트 창의 발신 게이트다.
   *
   * 왜 스냅샷에 싣나: 노트 창은 자기 창에서 무슨 일이 나는지만 알고 "누가 듣고 있는지"는
   * 호스트만 안다. 이 목록이 없으면 노트 창이 자동저장마다 IPC를 쏘고 호스트가 버리는
   * 구조가 되어, 이벤트를 쓰지 않는 사용자(=대부분)까지 비용을 문다.
   *
   * 선택 필드인 이유: 구버전 스냅샷(필드 없음)을 받은 노트 창은 "구독자 없음"으로 읽어
   * 아무것도 emit하지 않는다 — 안전한 폴백이다.
   */
  subscribedEvents?: MemoEventName[];
  /**
   * **언어팩은 이 스냅샷에 실리지 않는다.** 언어팩은 코드 실행이 필요 없는 데이터 선언
   * (`contributes.translations`)이라, 번들 팩은 각 창이 로컬에서 직접 읽고(`src/i18n/packs.ts`)
   * 설치 팩은 코어(Rust `plugin_i18n.rs`)가 매니페스트를 직접 스캔해 IPC로 준다 — 둘 다
   * 호스트 왕복이 없어 **첫 페인트 전에** 등록된다. 예전에는 명령형 `memo.i18n.register`가
   * 등록한 것을 이 스냅샷의 `locales` 필드가 날랐는데, 그 왕복이 첫 페인트보다 늦어 콜드
   * 스타트에서 창을 1회 리로드시키던 것이 그 경로를 걷어낸 이유다.
   */
  plugins: PluginSnapshot[];
  /**
   * 이번 빌드에서 실행에 실패한 플러그인들(빈 배열 = 전부 성공). 실패한 플러그인은
   * `plugins`에 빈 껍데기로 실리지 않고 여기에만 사유와 함께 남는다 — 설정 매니저가
   * "왜 안 되는지"를 표시할 수 있게 하기 위함(조용한 유실 금지).
   */
  failures: PluginFailure[];
}

/** EV_SNAPSHOT_GET 페이로드. */
export interface SnapshotGetPayload {
  requestId: string;
}

/** EV_SNAPSHOT 페이로드. */
export interface SnapshotPayload {
  requestId: string;
  snapshot: HostSnapshot;
}

/**
 * EV_BUTTON_INVOKE 페이로드 — windowLabel은 이후 창-스코프 호출의 라우팅 컨텍스트가 된다.
 *
 * 명령 실행도 **같은 채널**을 쓴다: 노트 창은 `buttonId` 대신 `commandId`를 실어 보내고,
 * 호스트가 그 id로 핸들러를 되짚는다. 채널을 나누지 않은 이유는 컨텍스트 토큰 발급·"마지막
 * 클릭 창" 기록·역호출이 **완전히 같은 절차**이기 때문이다 — 나누면 그 절차가 두 벌이 되고,
 * 한쪽만 고쳐 창 라우팅이 어긋나는(이 저장소가 이미 겪은) 데이터 손상이 다시 열린다.
 */
export interface ButtonInvokePayload {
  pluginId: string;
  /** 툴바 버튼 클릭이면 그 버튼의 핸들러 id. 명령·메뉴 항목 실행이면 비어 있다. */
  buttonId?: string;
  /** 명령 실행이면 그 명령의 id(`SnapshotCommand.id`). 그 외엔 없다. */
  commandId?: string;
  /** 메뉴 항목 실행이면 그 항목의 id(`SnapshotMenuItem.id`). 그 외엔 없다. */
  menuItemId?: string;
  /** 선택 액션 실행이면 그 액션의 id(`SnapshotSelectionAction.id`). 그 외엔 없다. */
  selectionActionId?: string;
  /**
   * 메뉴 항목·선택 액션 실행에서 그 순간의 선택 텍스트. 노트 창은 그 항목의
   * `needsSelectedText`가 참일 때만 싣고, 호스트는 `notes:read` 부여를 **다시 확인**해
   * `run`의 `payload.selectedText`에 채운다(부여가 없으면 이 값이 와도 payload에서 뺀다).
   */
  selectedText?: string;
  windowLabel: string;
}

/** EV_WINDOW_CALL 페이로드(호스트 → 지정 노트 창). */
export interface WindowCallPayload {
  requestId: string;
  windowLabel: string;
  /**
   * 이 호출을 낳은 플러그인 id — **호스트가 검증한 값**이다(게이트키퍼·컨텍스트 토큰 해석을
   * 통과한 시점에 확정되고, 플러그인이 인자로 자칭할 수 없다).
   *
   * 왜 싣나: 창 쪽 수행부가 플러그인별 네임스페이스에 쓴다 — 토스트 id를 (창, 플러그인, id)로
   * 격리해, 플러그인 B가 순번을 추측해 플러그인 A의 진행·실패 토스트를 닫거나 바꿔치지 못하게.
   */
  pluginId: string;
  call: string;
  args: Record<string, unknown>;
}

/** EV_WINDOW_RESULT 페이로드(노트 창 → 호스트, 게이트키퍼 응답과 같은 ok/오류 형태). */
export interface WindowResultPayload {
  requestId: string;
  ok: boolean;
  result?: unknown;
  /** 실패 시 기계용 안정 코드 — 게이트키퍼 응답의 `code`와 같은 어휘. */
  code?: MemoErrorCode;
  error?: string;
}
