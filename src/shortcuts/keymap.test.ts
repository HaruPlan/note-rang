import { describe, it, expect, afterEach } from "vitest";
import { runShortcutAction, installNoteKeymap } from "./keymap";
import { pluginSelectionActionId } from "./actions";
import { createEditor } from "../note/editor";
import {
  setSelectionActions,
  type SelectionActionItem,
} from "../plugin/selection-action";

/** data-action 버튼들을 가진 노트 창 루트 스텁을 만들고, id별 클릭 카운터를 돌려준다. */
function hostWith(...actions: string[]): {
  host: HTMLElement;
  clicks: (action: string) => number;
} {
  const host = document.createElement("div");
  const counts: Record<string, number> = {};
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.dataset.action = action;
    counts[action] = 0;
    btn.addEventListener("click", () => (counts[action] += 1));
    host.append(btn);
  }
  return { host, clicks: (a) => counts[a] ?? 0 };
}

describe("runShortcutAction", () => {
  it("확대/축소는 「글자 크기」 플러그인의 A+/A− 버튼을 click한다(클릭과 동일 — 토스트 재사용)", () => {
    const { host, clicks } = hostWith(
      "plugin:font-scale:font-plus",
      "plugin:font-scale:font-minus",
    );
    runShortcutAction("zoom-in", host);
    runShortcutAction("zoom-out", host);
    expect(clicks("plugin:font-scale:font-plus")).toBe(1);
    expect(clicks("plugin:font-scale:font-minus")).toBe(1);
  });

  it("네이티브 동작은 자기 data-action 버튼을 click한다", () => {
    const { host, clicks } = hostWith("toggle-preview");
    runShortcutAction("toggle-preview", host);
    expect(clicks("toggle-preview")).toBe(1);
  });

  it("버튼이 없으면 no-op(오류 없음)", () => {
    const { host, clicks } = hostWith("toggle-preview");
    runShortcutAction("delete-note", host);
    expect(clicks("toggle-preview")).toBe(0);
  });

  it("특수문자 포함 플러그인 id도 안전히 조회한다(따옴표/역슬래시 이스케이프)", () => {
    const { host, clicks } = hostWith("plugin:duplicate:duplicate");
    runShortcutAction("plugin:duplicate:duplicate", host);
    expect(clicks("plugin:duplicate:duplicate")).toBe(1);
  });
});

/**
 * 플러그인 선택 액션의 **단축키 표면**.
 *
 * 무엇을 지키나: 실행 조건이 선택 툴바와 **같다**(선택이 비어 있지 않고 `match`가 맞을 때만).
 * 두 표면이 조건을 따로 적으면 한쪽만 고쳐져 "버튼은 안 뜨는데 단축키로는 돌더라"가 된다.
 * 선택은 DOM이 아니라 **에디터 상태**에서 읽는다(라이브 프리뷰가 마커를 숨기므로 DOM 선택은
 * 원문이 아니다) — 그래서 이 테스트는 진짜 에디터를 하나 마운트한다.
 */
describe("runShortcutAction — 플러그인 선택 액션", () => {
  const editors: { view: { destroy(): void } }[] = [];
  afterEach(() => {
    while (editors.length > 0) editors.pop()!.view.destroy();
    document.body.innerHTML = "";
    setSelectionActions([]);
  });

  /** 문서를 띄우고 주 선택을 [from, to)로 놓는다(이 창의 정본 에디터가 된다). */
  const mount = (doc: string, from: number, to: number): void => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createEditor(parent, doc);
    editors.push(editor);
    editor.view.dispatch({ selection: { anchor: from, head: to } });
  };

  const spyAction = (
    match: SelectionActionItem["match"] | undefined,
    seen: string[],
  ): SelectionActionItem => ({
    pluginId: "calc",
    id: "run",
    label: "=",
    ...(match ? { match } : {}),
    run: (payload) => seen.push(payload.selectedText),
  });

  const actionId = pluginSelectionActionId("calc", "run");

  /** 가드(종단): 조건을 만족하면 그 액션의 run에 지금 선택된 글자가 넘어간다. */
  it("runs the action with the editor selection when the match holds", () => {
    const seen: string[] = [];
    setSelectionActions([
      spyAction({ charClasses: ["digit", "operator"] }, seen),
    ]);
    mount("12+34 글자", 0, 5);
    runShortcutAction(actionId, hostWith().host);
    expect(seen).toEqual(["12+34"]);
  });

  /** 가드(조건, 핵심): match가 맞지 않으면 조용히 아무 일도 하지 않는다(IPC도 안 나간다). */
  it("does nothing when the selection fails the match", () => {
    const seen: string[] = [];
    setSelectionActions([
      spyAction({ charClasses: ["digit", "operator"] }, seen),
    ]);
    mount("12+34 글자", 6, 8); // "글자" — 문자 부류를 벗어난다.
    runShortcutAction(actionId, hostWith().host);
    expect(seen).toEqual([]);
  });

  /** 가드(공통 전제): 선택이 비어 있으면(커서만) 실행하지 않는다 — 툴바와 같은 규칙. */
  it("does nothing when the selection is empty", () => {
    const seen: string[] = [];
    setSelectionActions([spyAction(undefined, seen)]);
    mount("12+34", 3, 3);
    runShortcutAction(actionId, hostWith().host);
    expect(seen).toEqual([]);
  });

  /** 가드: 꺼진/모르는 플러그인의 배정은 조용한 no-op이다(사용자 설정에는 남아 있을 수 있다). */
  it("does nothing for an action id that is not live in this window", () => {
    const seen: string[] = [];
    setSelectionActions([spyAction(undefined, seen)]);
    mount("12+34", 0, 5);
    runShortcutAction(pluginSelectionActionId("gone", "run"), hostWith().host);
    expect(seen).toEqual([]);
  });

  /**
   * 가드(상한과 무관): 툴바가 그리지 못한(상한을 넘긴) 액션도 단축키로는 실행된다 —
   * 자리 부족과 실행 불가는 다른 이야기다.
   */
  it("runs an action beyond the toolbar render limit", () => {
    const seen: string[] = [];
    const filler = Array.from({ length: 8 }, (_, i) => ({
      pluginId: "x",
      id: `f${i}`,
      label: "f",
      run: () => {},
    }));
    setSelectionActions([...filler, spyAction(undefined, seen)]);
    mount("12+34", 0, 5);
    runShortcutAction(actionId, hostWith().host);
    expect(seen).toEqual(["12+34"]);
  });

  /** 가드: 선택 액션 id는 명령·버튼 경로로 새지 않는다(접두 `sel:`이 구분한다). */
  it("does not fall through to the data-action button path", () => {
    const { host, clicks } = hostWith(actionId);
    setSelectionActions([]);
    mount("12+34", 0, 5);
    runShortcutAction(actionId, host);
    expect(clicks(actionId)).toBe(0);
  });
});

describe("installNoteKeymap", () => {
  it("바인딩된 조합을 누르면 동작을 디스패치하고 기본 동작을 막는다", () => {
    const target = new EventTarget();
    const { host, clicks } = hostWith("plugin:font-scale:font-plus");
    installNoteKeymap(target, () => ({ "zoom-in": "Alt+Equal" }), true, host);
    const e = new KeyboardEvent("keydown", {
      code: "Equal",
      altKey: true,
      cancelable: true,
    });
    target.dispatchEvent(e);
    expect(clicks("plugin:font-scale:font-plus")).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("바인딩 없는 조합은 무시하고 기본 동작을 막지 않는다", () => {
    const target = new EventTarget();
    const { host, clicks } = hostWith("plugin:font-scale:font-plus");
    installNoteKeymap(target, () => ({ "zoom-in": "Alt+Equal" }), true, host);
    const e = new KeyboardEvent("keydown", {
      code: "KeyX",
      altKey: true,
      cancelable: true,
    });
    target.dispatchEvent(e);
    expect(clicks("plugin:font-scale:font-plus")).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("바인딩이 비어 있으면 아무 동작도 디스패치하지 않는다", () => {
    const target = new EventTarget();
    const { host, clicks } = hostWith("plugin:font-scale:font-plus");
    const e = new KeyboardEvent("keydown", {
      code: "Equal",
      altKey: true,
      cancelable: true,
    });
    installNoteKeymap(target, () => ({}), true, host);
    target.dispatchEvent(e);
    expect(clicks("plugin:font-scale:font-plus")).toBe(0);
    // 기본 동작도 막지 않는다 — 빈 맵은 "이 키는 내 것이 아니다"와 같은 뜻이다.
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * 가드(핵심): 리스너를 다시 달지 않고 **참조만** 갈아 끼워도 새 바인딩이 즉시 먹고, 옛
   * 바인딩은 완전히 사라진다. 맵을 클로저에 굳혔다면 설정 변경이 창 리로드로만 반영됐고,
   * 리스너를 떼었다 다시 다는 방식이었다면 그 사이의 keydown이 유실됐다.
   */
  it("바인딩을 통째로 갈아 끼우면 새 조합이 먹고 옛 조합은 죽는다(리스너 재등록 없이)", () => {
    const target = new EventTarget();
    const { host, clicks } = hostWith(
      "plugin:font-scale:font-plus",
      "toggle-preview",
    );
    let live: Record<string, string> = { "zoom-in": "Alt+Equal" };
    installNoteKeymap(target, () => live, true, host);

    live = { "toggle-preview": "Alt+Equal" };
    const e = new KeyboardEvent("keydown", {
      code: "Equal",
      altKey: true,
      cancelable: true,
    });
    target.dispatchEvent(e);
    expect(clicks("toggle-preview")).toBe(1);
    expect(clicks("plugin:font-scale:font-plus")).toBe(0);

    // 빈 맵으로 갈아 끼우면(사용자가 전부 지움) 그 조합은 그대로 통과한다.
    live = {};
    const after = new KeyboardEvent("keydown", {
      code: "Equal",
      altKey: true,
      cancelable: true,
    });
    target.dispatchEvent(after);
    expect(clicks("toggle-preview")).toBe(1);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe("플러그인 명령 디스패치", () => {
  /**
   * 가드(핵심): 명령 동작은 **DOM 클릭 경로를 타지 않는다.**
   *
   * 명령은 툴바에 흔적이 없는 것이 존재 이유다. 셀렉터로 찾다가 못 찾고 조용히 끝나면
   * 사용자에게는 "단축키가 먹통"으로만 보인다 — 그래서 버튼 조회보다 먼저 갈라져야 하고,
   * 같은 이름의 버튼이 우연히 있어도 그쪽이 눌려서는 안 된다.
   */
  it("같은 이름의 버튼이 있어도 명령은 버튼을 클릭하지 않는다", () => {
    const { host, clicks } = hostWith("plugin:p:cmd:save", "plugin:p:save");
    runShortcutAction("plugin:p:cmd:save", host);
    expect(clicks("plugin:p:cmd:save")).toBe(0);
    expect(clicks("plugin:p:save")).toBe(0);
  });

  /** 가드(회귀): 버튼 동작은 예전 경로 그대로 클릭된다(명령 분기가 삼키지 않는다). */
  it("버튼 동작은 여전히 data-action 버튼을 클릭한다", () => {
    const { host, clicks } = hostWith("plugin:p:save", "toggle-pin");
    runShortcutAction("plugin:p:save", host);
    runShortcutAction("toggle-pin", host);
    expect(clicks("plugin:p:save")).toBe(1);
    expect(clicks("toggle-pin")).toBe(1);
  });
});
