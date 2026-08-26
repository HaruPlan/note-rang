import { afterEach, describe, it, expect } from "vitest";
import {
  SHORTCUT_ACTIONS,
  defaultKeybindings,
  dispatchTarget,
  effectiveKeybindings,
  isCoreAliasTarget,
  parsePluginCommandAction,
  parsePluginSelectionAction,
  pluginCommandActionId,
  pluginSelectionActionId,
} from "./actions";
import { t } from "../i18n/t";
import { registerLocale, setActiveLocale } from "../i18n/store";

describe("SHORTCUT_ACTIONS 카탈로그", () => {
  it("동작 id는 유일하다", () => {
    const ids = SHORTCUT_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("확대/축소는 기본 바인딩(Alt+Equal/Alt+Minus)을 가진다", () => {
    const map = Object.fromEntries(
      SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultAccel]),
    );
    expect(map["zoom-in"]).toBe("Alt+Equal");
    expect(map["zoom-out"]).toBe("Alt+Minus");
  });

  it("핀·모든데스크탑은 창-컨트롤 플러그인을, 확대/축소는 글자 크기 플러그인을 요구한다", () => {
    const req = Object.fromEntries(
      SHORTCUT_ACTIONS.map((a) => [a.id, a.requires]),
    );
    expect(req["toggle-pin"]).toBe("always-on-top");
    expect(req["toggle-all-desktops"]).toBe("all-desktops");
    expect(req["zoom-in"]).toBe("font-scale");
    expect(req["zoom-out"]).toBe("font-scale");
  });

  /** 가드: 옵션 초기화는 「옵션 초기화」 플러그인을 요구하고, 파괴적이라 기본 바인딩이 없다
   * (설정에 보이고 걸 수 있으나 기본은 미바인딩 — confirm으로 게이트되는 되돌릴 수 없는 동작). */
  it("옵션 초기화는 reset-options 플러그인을 요구하되 기본 바인딩이 없다", () => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === "reset-options")!;
    expect(action).toBeDefined();
    expect(action.requires).toBe("reset-options");
    expect(action.defaultAccel).toBeUndefined();
  });

  describe("labelKey", () => {
    // registerLocale이 더한 로케일(store.ts locales Map)은 되돌릴 export가 없다
    // (store.test.ts와 같은 관례) — active만 테스트마다 ko로 되돌린다.
    afterEach(() => setActiveLocale("ko"));

    /**
     * 회귀 가드: 카탈로그가 `label`(완성 문장)이 아니라 `labelKey`(i18n 키)만 갖는다 — 소비
     * 지점이 `t(labelKey)`로 호출 시점에 해석해야 한다. `label: t(...)`로 되돌리면(모듈
     * 최상위 즉시 평가) 활성 로케일이 무엇이든 이 모듈이 로드되는 순간의 로케일로 영원히
     * 굳는다(§i18n 규약). `registerLocale`은 되돌릴 export가 없으므로(store.test.ts와 같은
     * 관례) 이 파일에서 유일한 코드("xx")를 쓴다.
     */
    it("t(labelKey)는 활성 로케일을 호출 시점에 반영한다", () => {
      registerLocale("xx", "Test", {
        "shortcuts.actions.toggle-preview": "XX preview",
      });
      const action = SHORTCUT_ACTIONS.find((a) => a.id === "toggle-preview")!;

      setActiveLocale("xx");
      expect(t(action.labelKey)).toBe("XX preview");

      setActiveLocale("ko");
      expect(t(action.labelKey)).toBe("마크다운 프리뷰");
    });
  });
});

describe("dispatchTarget", () => {
  it("확대/축소는 「글자 크기」 플러그인 A+/A− 버튼으로 재지정된다", () => {
    expect(dispatchTarget("zoom-in")).toBe("plugin:font-scale:font-plus");
    expect(dispatchTarget("zoom-out")).toBe("plugin:font-scale:font-minus");
  });

  it("옵션 초기화는 「옵션 초기화」 플러그인 ↺ 버튼으로 재지정된다", () => {
    expect(dispatchTarget("reset-options")).toBe("plugin:reset-options:reset");
  });

  it("별칭 없는 동작은 자기 id 그대로다(네이티브·플러그인 버튼)", () => {
    expect(dispatchTarget("toggle-preview")).toBe("toggle-preview");
    expect(dispatchTarget("plugin:duplicate:duplicate")).toBe(
      "plugin:duplicate:duplicate",
    );
  });
});

describe("isCoreAliasTarget", () => {
  /** 가드: 핵심 동작이 별칭으로 노출하는 플러그인 버튼은 "플러그인 동작"에서 중복으로 뜨지 않게 숨긴다. */
  it("확대/축소·옵션 초기화 별칭 버튼을 핵심 동작 중복으로 인식한다", () => {
    expect(isCoreAliasTarget("plugin:font-scale:font-plus")).toBe(true);
    expect(isCoreAliasTarget("plugin:font-scale:font-minus")).toBe(true);
    expect(isCoreAliasTarget("plugin:reset-options:reset")).toBe(true);
    // 별칭이 아닌 플러그인 버튼(복제)은 숨기지 않는다.
    expect(isCoreAliasTarget("plugin:duplicate:duplicate")).toBe(false);
  });
});

describe("defaultKeybindings", () => {
  it("defaultAccel이 있는 동작만 담는다", () => {
    const d = defaultKeybindings();
    expect(d).toEqual({ "zoom-in": "Alt+Equal", "zoom-out": "Alt+Minus" });
    expect(d["toggle-preview"]).toBeUndefined();
  });
});

describe("effectiveKeybindings", () => {
  it("저장 필드가 없으면(undefined) 기본을 시드", () => {
    expect(effectiveKeybindings(undefined)).toEqual(defaultKeybindings());
  });

  it("저장된 값(빈 맵 포함)은 권위 — 사용자가 지운 것을 존중", () => {
    expect(effectiveKeybindings({})).toEqual({});
    expect(effectiveKeybindings({ "zoom-in": "Mod+Equal" })).toEqual({
      "zoom-in": "Mod+Equal",
    });
  });
});

describe("플러그인 명령 동작 id", () => {
  /**
   * 가드(핵심): 명령 id 공간이 툴바 버튼 id 공간과 **겹치지 않는다**.
   *
   * 왜 이 한 줄을 가드로 두는가: 이 문자열은 사용자의 단축키 설정에 그대로 영속된다.
   * 나중에 접두사를 넣으면 이미 배정된 키가 통째로 초기화되므로, 되돌릴 수 없는 결정이다.
   */
  it("명령 id는 버튼 id와 다른 이름 공간을 쓴다", () => {
    expect(pluginCommandActionId("p", "save")).toBe("plugin:p:cmd:save");
    expect(pluginCommandActionId("p", "save")).not.toBe("plugin:p:save");
  });

  it("명령 동작 id만 (플러그인, 명령)으로 되짚는다", () => {
    expect(parsePluginCommandAction("plugin:p:cmd:save")).toEqual({
      pluginId: "p",
      commandId: "save",
    });
    // commandId에 `:`가 들어 있어도 잃지 않는다(플러그인 id에는 못 들어간다).
    expect(parsePluginCommandAction("plugin:p:cmd:a:b")).toEqual({
      pluginId: "p",
      commandId: "a:b",
    });
    // 버튼·핵심 동작은 명령이 아니다.
    expect(parsePluginCommandAction("plugin:p:save")).toBeNull();
    expect(parsePluginCommandAction("toggle-pin")).toBeNull();
    expect(parsePluginCommandAction("plugin:p:cmd:")).toBeNull();
  });

  /** 가드: 명령 동작은 별칭 대상이 아니다 — 설정 「플러그인 동작」에서 숨겨지면 안 된다. */
  it("명령 id는 핵심 동작 별칭으로 취급되지 않는다", () => {
    expect(isCoreAliasTarget(pluginCommandActionId("font-scale", "x"))).toBe(
      false,
    );
    expect(dispatchTarget("plugin:p:cmd:save")).toBe("plugin:p:cmd:save");
  });

  /**
   * 가드(핵심): 선택 액션 id 공간이 **버튼·명령 어느 쪽과도 겹치지 않는다**.
   *
   * 명령의 `cmd:`와 같은 이유다 — 이 문자열은 사용자의 단축키 설정에 영속되므로 나중에
   * 접두사를 넣으면 이미 배정된 키가 통째로 초기화된다(되돌릴 수 없는 결정).
   */
  it("선택 액션 id는 버튼·명령과 다른 이름 공간을 쓴다", () => {
    expect(pluginSelectionActionId("p", "calc")).toBe("plugin:p:sel:calc");
    expect(pluginSelectionActionId("p", "calc")).not.toBe(
      pluginCommandActionId("p", "calc"),
    );
    expect(pluginSelectionActionId("p", "calc")).not.toBe("plugin:p:calc");
  });

  it("선택 액션 동작 id만 (플러그인, 액션)으로 되짚는다", () => {
    expect(parsePluginSelectionAction("plugin:p:sel:calc")).toEqual({
      pluginId: "p",
      selectionActionId: "calc",
    });
    // 액션 id에 `:`가 들어 있어도 잃지 않는다(명령 파서와 같은 규칙).
    expect(parsePluginSelectionAction("plugin:p:sel:a:b")).toEqual({
      pluginId: "p",
      selectionActionId: "a:b",
    });
    // 버튼·명령·핵심 동작은 선택 액션이 아니다(서로 새지 않는다).
    expect(parsePluginSelectionAction("plugin:p:calc")).toBeNull();
    expect(parsePluginSelectionAction("plugin:p:cmd:calc")).toBeNull();
    expect(parsePluginSelectionAction("toggle-pin")).toBeNull();
    expect(parsePluginSelectionAction("plugin:p:sel:")).toBeNull();
    // 반대 방향도 마찬가지 — 선택 액션은 명령 파서에 잡히지 않는다.
    expect(parsePluginCommandAction("plugin:p:sel:calc")).toBeNull();
  });

  /** 가드: 선택 액션도 별칭 대상이 아니다 — 설정 「플러그인 동작」에서 숨겨지면 안 된다. */
  it("선택 액션 id는 핵심 동작 별칭으로 취급되지 않는다", () => {
    expect(isCoreAliasTarget(pluginSelectionActionId("font-scale", "x"))).toBe(
      false,
    );
    expect(dispatchTarget("plugin:p:sel:calc")).toBe("plugin:p:sel:calc");
  });
});
