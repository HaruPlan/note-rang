import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "./capabilities";
import { KNOWN_WINDOW_CONTROLS } from "./window-control";

/**
 * 능력 바닥값의 계약을 못박는다. 이 두 상수는 "모르면 안 그린다"(fail-closed) 원칙이 코드에
 * 남아 있는지 보는 유일한 자리다 — 누군가 편의를 위해 NO_CAPABILITIES에 컨트롤을 채워 넣으면
 * 예전의 유령 버튼(꺼둔 플러그인의 컨트롤이 그려지던 결함)이 통째로 돌아온다.
 */
describe("플러그인 능력 바닥값", () => {
  it("NO_CAPABILITIES는 아무것도 켜지 않는다(모르면 안 그린다)", () => {
    expect(NO_CAPABILITIES.windowControls).toEqual([]);
    expect(NO_CAPABILITIES.youtubeEmbed).toBe(false);
  });

  /**
   * 가드: 새 창 컨트롤을 KNOWN_WINDOW_CONTROLS에 추가하고 ALL_CAPABILITIES를 안 고치면,
   * "능력 제한 없음"으로 쓰는 테스트들이 조용히 그 컨트롤만 빠진 채 돌아간다(커버리지 구멍).
   */
  it("ALL_CAPABILITIES는 알려진 창 컨트롤을 하나도 빠뜨리지 않는다", () => {
    expect([...ALL_CAPABILITIES.windowControls].sort()).toEqual(
      [...KNOWN_WINDOW_CONTROLS].sort(),
    );
    expect(ALL_CAPABILITIES.youtubeEmbed).toBe(true);
  });

  /** 상수를 실수로 공유·변형하지 않게 서로 다른 배열 인스턴스여야 한다. */
  it("두 바닥값은 배열을 공유하지 않는다", () => {
    expect(ALL_CAPABILITIES.windowControls).not.toBe(
      NO_CAPABILITIES.windowControls,
    );
  });
});

/**
 * 구조 가드(드리프트 방지) — 렌더 경로가 능력을 **추정**할 수 없게 소스를 직접 읽어 대조한다
 * (drift-guards.test.ts와 같은 방식: export에 기대면 그 export가 바뀔 때 가드가 조용히 무의미
 * 해지므로, "그렇게 쓰여 있어야 하는 그 소스"를 읽는다).
 *
 * 막으려는 회귀는 실제로 났던 것이다: 능력이 옵셔널 필드였고 기본값이 "전부 켜짐"이라, 인자를
 * 빠뜨린 호출부가 **꺼둔 플러그인의 컨트롤을 그리는데도** 컴파일이 통과했다.
 */
describe("능력 fail-open 금지(구조 가드)", () => {
  const RENDER_SOURCES = [
    "src/note/note-window.ts",
    "src/note/note-toolbar.ts",
  ];

  it("노트 창·툴바는 능력을 **필수**로 받는다(옵셔널 금지)", () => {
    for (const path of RENDER_SOURCES) {
      const src = readFileSync(path, "utf8");
      expect(src, `${path}: 능력 필수 선언이 없다`).toMatch(
        /capabilities: PluginCapabilities;/,
      );
      expect(src, `${path}: 능력이 옵셔널로 되돌아갔다`).not.toMatch(
        /capabilities\?:/,
      );
    }
  });

  /**
   * "전부 켜짐" 상수가 렌더 경로에 있으면 그 자리가 곧 폴백 후보가 된다(예전 결함이 정확히
   * `?? [...KNOWN_WINDOW_CONTROLS]` 한 줄이었다). 이 상수는 능력을 **판정하는** 쪽
   * (window-control·capabilities·부트스트랩)에만 있어야 한다.
   */
  it("렌더 경로에 '전부 켜짐' 상수가 없다", () => {
    for (const path of RENDER_SOURCES) {
      const src = readFileSync(path, "utf8");
      expect(src, `${path}: 렌더 경로가 전체 컨트롤 상수를 안다`).not.toMatch(
        /KNOWN_WINDOW_CONTROLS/,
      );
    }
  });
});
