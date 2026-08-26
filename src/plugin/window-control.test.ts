import { describe, expect, it } from "vitest";
import {
  KNOWN_WINDOW_CONTROLS,
  enabledBuiltinWindowControls,
  normalizeWindowControlArgs,
} from "./window-control";
import { BUILTIN_PLUGINS } from "./builtin";

describe("normalizeWindowControlArgs", () => {
  it("알려진 컨트롤만 취한다", () => {
    expect(
      normalizeWindowControlArgs({ controls: ["transparency"] }).controls,
    ).toEqual(["transparency"]);
    expect(
      normalizeWindowControlArgs({
        controls: ["always-on-top", "all-desktops"],
      }).controls,
    ).toEqual(["always-on-top", "all-desktops"]);
  });

  it("미지의 id·비문자열·중복은 버린다", () => {
    expect(
      normalizeWindowControlArgs({
        controls: ["transparency", "hack", 42, "transparency"],
      }).controls,
    ).toEqual(["transparency"]);
  });

  it("잘못된 입력은 빈 목록", () => {
    expect(normalizeWindowControlArgs(null).controls).toEqual([]);
    expect(normalizeWindowControlArgs({}).controls).toEqual([]);
    expect(
      normalizeWindowControlArgs({ controls: "transparency" }).controls,
    ).toEqual([]);
  });

  it("KNOWN_WINDOW_CONTROLS는 세 컨트롤을 포함한다", () => {
    expect(KNOWN_WINDOW_CONTROLS).toContain("transparency");
    expect(KNOWN_WINDOW_CONTROLS).toContain("always-on-top");
    expect(KNOWN_WINDOW_CONTROLS).toContain("all-desktops");
  });
});

/**
 * 스냅샷 없이(=샌드박스가 아직 안 떴을 때) 창 컨트롤을 판정하는 규칙. 원칙은 하나다:
 * **플러그인이 로드됐다고 추정하지 않는다** — 모르면 안 그린다.
 */
describe("enabledBuiltinWindowControls", () => {
  const BUILTINS = [
    { id: "transparency", platforms: ["macos", "windows"] },
    { id: "always-on-top" },
    { id: "all-desktops", platforms: ["macos"] },
    { id: "wikilink" }, // 창 컨트롤이 아닌 번들(무관 — 섞여 있어도 영향 없어야 한다)
  ];

  it("기록이 없으면 켜짐으로 본다(listBuiltinStates 계약)", () => {
    expect(enabledBuiltinWindowControls(BUILTINS, {}, "macos")).toEqual([
      "transparency",
      "always-on-top",
      "all-desktops",
    ]);
  });

  /**
   * 가드(회귀): 예전엔 스냅샷이 늦으면 "지원되는 컨트롤은 다 켜져 있겠거니" 가정해, 사용자가
   * **꺼둔** 플러그인의 컨트롤이 노트 툴바에 그려졌다(늦게 온 스냅샷은 이 값을 교정하지 않아
   * 세션 내내 남았다). 활성 맵이 유일한 근거다.
   */
  it("꺼둔 번들의 컨트롤은 제외한다", () => {
    expect(
      enabledBuiltinWindowControls(
        BUILTINS,
        { transparency: false, "all-desktops": false },
        "macos",
      ),
    ).toEqual(["always-on-top"]);
  });

  it("이 OS에서 미지원인 번들의 컨트롤도 제외한다(중앙 호스트의 실행 조건과 동일)", () => {
    expect(enabledBuiltinWindowControls(BUILTINS, {}, "windows")).toEqual([
      "transparency",
      "always-on-top",
    ]);
  });

  /** 번들이 제공하지 않는 컨트롤(서드파티 선언)은 스냅샷으로만 알 수 있다 → 보수적으로 제외. */
  it("번들 제공자가 없는 컨트롤은 제외한다", () => {
    expect(
      enabledBuiltinWindowControls([{ id: "always-on-top" }], {}, "macos"),
    ).toEqual(["always-on-top"]);
    expect(enabledBuiltinWindowControls([], {}, "macos")).toEqual([]);
  });

  /** 실제 번들 목록으로도 성립해야 한다 — id가 바뀌면(오타 포함) 컨트롤이 통째로 사라진다. */
  it("실제 BUILTIN_PLUGINS에 세 컨트롤의 제공자가 모두 있다", () => {
    for (const control of KNOWN_WINDOW_CONTROLS)
      expect(BUILTIN_PLUGINS.some((p) => p.id === control)).toBe(true);
  });
});
