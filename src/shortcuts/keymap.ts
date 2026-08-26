/**
 * 노트 창 키맵 — 바인딩된 동작을 실제로 디스패치한다(DOM 의존, jsdom 테스트 가능).
 *
 * 역할: `accel.ts`의 순수 조회(`resolveShortcut`)에 "실행"을 붙인다. 툴바에 버튼이 있는
 * 동작은 그 버튼을 click()해 기존 동작·상태·게이팅·플러그인 onClick(토스트 등)을 그대로
 * 재사용하고(확대/축소도 `dispatchTarget`이 「글자 크기」 플러그인 버튼으로 재지정한다),
 * **버튼이 없는 플러그인 명령**은 중앙 호스트로 되쏘아 그 샌드박스의 `run`을 실행한다.
 * keydown은 capture 단계로 붙여 CodeMirror보다 먼저 가로챈다.
 */
import { resolveShortcut } from "./accel";
import {
  dispatchTarget,
  parsePluginCommandAction,
  parsePluginSelectionAction,
} from "./actions";
import { EV_BUTTON_INVOKE } from "../plugin/host-protocol";
import {
  liveSelectionActions,
  selectionMatches,
} from "../plugin/selection-action";
import { readNoteSelection } from "../note/editor";

/**
 * 플러그인 명령 1건을 중앙 호스트로 되쏜다 — 버튼 클릭과 **같은 채널**([`EV_BUTTON_INVOKE`]).
 *
 * 왜 여기서 Tauri를 지연 임포트하나: 이 모듈은 jsdom 단위 테스트가 Tauri 없이 구동한다.
 * 정적으로 가져오면 키맵 전체가 Tauri 런타임에 묶인다. 실제로 명령이 눌린 순간에만 가져오면
 * 배선은 **항상 존재하고**(노트 창이 별도 배선을 넘겨줄 필요가 없다) 테스트 격리도 지킨다 —
 * 노트 창 진입점이 무언가를 넘겨 주기를 기다리는 구조였다면, 그것을 잊는 순간 명령 기능이
 * 통째로 죽는다(이 저장소가 11번 겪은 모양).
 *
 * 창 라벨은 백엔드 규칙(`note-<id>`)대로 이 창이 스스로 알고 있는 값을 쓴다 — 호스트는 그
 * 라벨로 창-스코프 호출을 되돌려 보내므로, 명령 안에서 부른 `memo.ui.toast`가 **이 창**에 뜬다.
 */
async function dispatchPluginCommand(
  pluginId: string,
  commandId: string,
): Promise<void> {
  const [{ emitAppEvent }, { getCurrentWindow }] = await Promise.all([
    import("../shared/tauri"),
    import("@tauri-apps/api/window"),
  ]);
  await emitAppEvent(EV_BUTTON_INVOKE, {
    pluginId,
    commandId,
    windowLabel: getCurrentWindow().label,
  });
}

/**
 * 플러그인 **선택 액션** 1건을 단축키로 실행한다 — 실행 조건을 만족할 때만.
 *
 * 조건은 선택 툴바가 버튼을 그릴 때와 **글자 그대로 같다**: 선택이 비어 있지 않고
 * `match`를 만족해야 한다([`selectionMatches`] — 두 표면이 같은 순수 함수를 본다). 다른 것은
 * 상한뿐이다: 바에 자리가 없어 안 그려진 액션도 단축키로는 실행된다(자리 부족과 실행 불가는
 * 다른 이야기다).
 *
 * 선택은 DOM이 아니라 **에디터 상태**에서 읽는다([`readNoteSelection`]): 라이브 프리뷰가
 * 마커(`**`·`{{…|#hex}}`)를 화면에서 숨기므로 `window.getSelection()`은 원문이 아니라 보이는
 * 글자를 준다 — 그 값으로 판정하면 툴바 경로와 결과가 갈린다.
 *
 * 조건이 거짓이면 **아무 일도 하지 않는다**(진단도 방송도 없다) — 조건부 액션의 단축키는
 * 조건이 안 맞을 때 눌리는 것이 정상이고, 그때마다 IPC를 내보내면 호스트가 무의미한 역호출을
 * 한다. 목록에 없는 id(꺼진 플러그인)도 같은 무음 경로다.
 */
function runSelectionActionShortcut(
  pluginId: string,
  selectionActionId: string,
): void {
  const action = liveSelectionActions().find(
    (a) => a.pluginId === pluginId && a.id === selectionActionId,
  );
  if (!action) return;
  const selection = readNoteSelection();
  // ranges: 0 = 이 창에 에디터가 없다(읽지 못했다) — 빈 선택과 구분되지 않게 다루면 안 된다.
  if (selection.ranges === 0 || selection.empty) return;
  if (!selectionMatches(selection.text, action.match)) return;
  action.run({ selectedText: selection.text });
}

/**
 * 동작 id 하나를 실행한다 — 플러그인 명령·선택 액션이면 호스트로 되쏘고, 그 외에는 대응
 * `data-action` 버튼을 click(버튼 없으면 no-op).
 */
export function runShortcutAction(actionId: string, host: ParentNode): void {
  // 명령은 DOM에 흔적이 없다(툴바를 차지하지 않는 것이 이 기능의 존재 이유다) — 셀렉터로
  // 찾을 대상이 아예 없으므로 버튼 경로보다 **먼저** 가른다.
  const command = parsePluginCommandAction(actionId);
  if (command) {
    // 실패(호스트 창 부재·IPC 오류)는 삼킨다: 키 입력 하나가 노트 창 전체에 미처리 rejection을
    // 던지게 두지 않는다. 실행 결과의 흔적은 호스트 쪽 진단 채널에 남는다.
    void dispatchPluginCommand(command.pluginId, command.commandId).catch(
      () => {},
    );
    return;
  }
  // 선택 액션도 DOM에 상주하는 흔적이 없다(선택 툴바는 드래그 뒤에만 뜬다) — 명령과 같은
  // 이유로 버튼 경로보다 **먼저** 가른다. 방송은 액션 자체가 들고 있는 클로저가 낸다
  // (호스트 채널·선택 텍스트 권한 게이트가 표면마다 두 벌이 되지 않게).
  const selectionAction = parsePluginSelectionAction(actionId);
  if (selectionAction) {
    runSelectionActionShortcut(
      selectionAction.pluginId,
      selectionAction.selectionActionId,
    );
    return;
  }
  // data-action 값(플러그인 id)의 따옴표·역슬래시만 이스케이프해 인용 속성 셀렉터를 안전화한다
  // (CSS.escape는 일부 환경에 없음). 확대/축소는 dispatchTarget이 플러그인 버튼으로 재지정한다.
  const target = dispatchTarget(actionId).replace(/["\\]/g, "\\$&");
  host.querySelector<HTMLElement>(`[data-action="${target}"]`)?.click();
}

/**
 * 대상(보통 노트 창의 `window`)에 capture-phase keydown 리스너를 붙여, 바인딩된 조합을 동작으로
 * 디스패치한다. 매치 시 기본 동작·전파를 막는다(편집기보다 먼저 가로챔). `host`는 대응
 * `[data-action]` 버튼을 찾을 노트 창 루트.
 *
 * ## 왜 맵이 아니라 **getter**인가
 *
 * 바인딩은 설정 창에서 언제든 바뀌고, 예전에는 그 반영이 노트 창 리로드였다. 값을 클로저에
 * 굳히면 바뀔 때마다 리스너를 떼고 다시 달아야 하는데, 그 사이(remove와 add 사이)에 눌린
 * 키는 아무 데도 가지 않는다 — 눈에 잘 안 띄는 유실 창이 생긴다. getter로 받으면 노트 창은
 * 참조 하나만 갈아 끼우면 되고(`NoteWindowHandle.applyKeybindings`) 리스너는 그대로 산다.
 *
 * 그래서 리스너는 **바인딩이 비어 있어도 설치한다**: 지금 비었다는 이유로 안 달면, 사용자가
 * 나중에 바인딩을 되살려도 이 창만 영영 단축키가 죽는다(`resolveShortcut`이 빈 맵에서
 * 곧바로 null을 내므로 비용은 없다).
 */
export function installNoteKeymap(
  target: EventTarget,
  bindings: () => Record<string, string>,
  isMac: boolean,
  host: ParentNode,
): void {
  target.addEventListener(
    "keydown",
    (e) => {
      const actionId = resolveShortcut(bindings(), e as KeyboardEvent, isMac);
      if (!actionId) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      runShortcutAction(actionId, host);
    },
    true,
  );
}
