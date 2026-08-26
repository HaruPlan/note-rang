import { afterEach, describe, it, expect } from "vitest";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_MAC,
  DEFAULT_LAYOUT_WINDOWS,
  BUILTIN_ITEMS,
  MAX_TIERS,
  resolveLayout,
  tierOf,
  placedKeys,
  locateItem,
  setTier,
  setAlign,
  setFoldRank,
  foldRankOf,
  clearZone,
  moveItem,
  isBuiltinItemKey,
  isTopOnlyKey,
  defaultLayoutFor,
  isDefaultLayout,
  isPluginItemKey,
  pluginItemKey,
  zoneAlignOf,
  markSeen,
  materializeFallbacks,
  availableBuiltinItems,
  pruneLayout,
  sameLayout,
  fallbackZoneFor,
  type BarLayout,
  type ToolbarLayout,
} from "./toolbar-layout";
import { t } from "../i18n/t";
import { registerLocale, setActiveLocale } from "../i18n/store";

describe("toolbar-layout — 키 판별", () => {
  it("내장/플러그인 키를 구분한다", () => {
    expect(isBuiltinItemKey("core:preview")).toBe(true);
    expect(isBuiltinItemKey("core:nope")).toBe(false);
    expect(isPluginItemKey("plugin:font-scale:font-plus")).toBe(true);
    expect(isPluginItemKey("core:preview")).toBe(false);
    expect(pluginItemKey("font-scale", "font-plus")).toBe(
      "plugin:font-scale:font-plus",
    );
  });
});

describe("resolveLayout", () => {
  it("null/undefined/비객체 → 기본 배치를 복제한다(독립 인스턴스)", () => {
    for (const raw of [null, undefined, 42, "x"]) {
      const r = resolveLayout(raw);
      // seen을 뺀 top/bottom은 기본 배치와 같다(seen은 저장된 적 없으면 빈 배열이다 — 엄격).
      expect({ top: r.top, bottom: r.bottom }).toEqual({
        top: DEFAULT_LAYOUT.top,
        bottom: DEFAULT_LAYOUT.bottom,
      });
      expect(r.seen).toEqual([]);
      // 복제본이라 변형이 기본값을 오염시키지 않는다.
      r.top.zones.push(["x"]);
      expect(DEFAULT_LAYOUT.top.zones.length).toBe(2);
    }
  });

  it("seen이 저장돼 있으면 그대로 정제해서 쓴다(비문자열·중복 제거)", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [] },
      bottom: { align: "left", zones: [] },
      seen: ["a", "a", 1, "", "b"],
    });
    expect(r.seen).toEqual(["a", "b"]);
  });

  it("seen 필드가 없으면 빈 집합으로 본다(엄격 — 마이그레이션 없음)", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [["plugin:x:only-here"]] },
      bottom: { align: "left", zones: [] },
    });
    expect(r.seen).toEqual([]);
  });

  it("존 수를 MAX_TIERS로 자르고 비문자열·빈문자 키를 거른다", () => {
    const r = resolveLayout({
      top: { align: "right", zones: [["a", 1, "", "b"], ["c"], [], ["d"]] },
      bottom: { zones: [] },
    });
    expect(r.top.zones.length).toBe(MAX_TIERS);
    expect(r.top.zones[0]).toEqual(["a", "b"]);
    expect(r.top.align).toBe("right");
    expect(r.bottom.zones).toEqual([]);
  });

  it("같은 키가 여러 곳에 있으면 처음 것만 남긴다(전체 스코프 중복 제거)", () => {
    const r = resolveLayout({
      top: { zones: [["a", "b"], ["a"]] },
      bottom: { zones: [["b", "c"]] },
    });
    expect(r.top.zones).toEqual([["a", "b"], []]);
    expect(r.bottom.zones).toEqual([["c"]]);
  });

  it("모르는 정렬 값은 left로 강등한다", () => {
    expect(
      resolveLayout({ top: { align: "middle", zones: [] } }).top.align,
    ).toBe("left");
  });

  it("하단의 상단 전용 키(core:collapse)를 상단 마지막 존으로 이관한다(제거 아님)", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [["core:preview"]] },
      bottom: { align: "left", zones: [["core:collapse", "core:archive"]] },
    });
    expect(r.bottom.zones[0]).toEqual(["core:archive"]);
    expect(r.top.zones[r.top.zones.length - 1]).toContain("core:collapse");
    expect(placedKeys(r).has("core:collapse")).toBe(true);
  });

  it("상단이 0단이면(둘 곳 없음) 하단의 접기는 부득이 제거된다(미배치)", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [] },
      bottom: { align: "left", zones: [["core:collapse", "core:archive"]] },
    });
    expect(placedKeys(r).has("core:collapse")).toBe(false);
    expect(r.bottom.zones[0]).toEqual(["core:archive"]);
  });

  /** 가드: 접힘 제목도 접기와 같은 상단 전용 이관 규칙을 탄다(TOP_ONLY_KEYS 공통 경로). */
  it("하단의 상단 전용 키(core:collapsed-title)도 상단으로 이관한다", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [["core:preview"]] },
      bottom: {
        align: "left",
        zones: [["core:collapsed-title", "core:archive"]],
      },
    });
    expect(r.bottom.zones[0]).toEqual(["core:archive"]);
    expect(r.top.zones[r.top.zones.length - 1]).toContain(
      "core:collapsed-title",
    );
    expect(placedKeys(r).has("core:collapsed-title")).toBe(true);
  });
});

describe("isTopOnlyKey", () => {
  it("접기·접힘 제목만 상단 전용이다", () => {
    expect(isTopOnlyKey("core:collapse")).toBe(true);
    expect(isTopOnlyKey("core:collapsed-title")).toBe(true);
    expect(isTopOnlyKey("core:archive")).toBe(false);
    expect(isTopOnlyKey("plugin:demo:btn")).toBe(false);
  });
});

describe("markSeen", () => {
  it("기존 seen과 새 키를 합집합한다(원본 불변, 좁히지 않음)", () => {
    const base: ToolbarLayout = {
      top: { align: "left", zones: [["a"]] },
      bottom: { align: "left", zones: [] },
      seen: ["a"],
    };
    const r = markSeen(base, ["a", "b", "c"]);
    expect(r.seen).toEqual(["a", "b", "c"]);
    expect(base.seen).toEqual(["a"]); // 원본 불변
  });

  it("seen이 없던 배치에도 새로 채운다", () => {
    const base: ToolbarLayout = {
      top: { align: "left", zones: [] },
      bottom: { align: "left", zones: [] },
    };
    expect(markSeen(base, ["x", "y"]).seen).toEqual(["x", "y"]);
  });
});

// 서드파티 버튼이 배치도 seen도 모르는 신규일 때 자동 배치될 존을 고르는 순수 매핑.
describe("fallbackZoneFor", () => {
  it("바가 0단이면 null(안전하게 건너뜀)", () => {
    const layout: ToolbarLayout = {
      top: { align: "left", zones: [] },
      bottom: { align: "left", zones: [["core:archive"]] },
    };
    expect(fallbackZoneFor(layout, "top-left")).toBeNull();
  });

  it("존이 1개뿐이면 좌/우 요청과 무관하게 그 존으로 간다", () => {
    const layout: ToolbarLayout = {
      top: { align: "left", zones: [["core:preview"]] },
      bottom: { align: "left", zones: [] },
    };
    expect(fallbackZoneFor(layout, "top-left")).toEqual({
      bar: "top",
      zone: 0,
    });
    expect(fallbackZoneFor(layout, "top-right")).toEqual({
      bar: "top",
      zone: 0,
    });
  });

  it("존이 2개 이상이면 정렬이 맞는 존을 고른다(top-left→좌, bottom-right→우)", () => {
    const layout: ToolbarLayout = {
      top: { align: "left", zones: [["a"], ["b"]] },
      bottom: { align: "left", zones: [["c"], ["d"], ["e"]] }, // 3단: 좌·중·우
    };
    expect(fallbackZoneFor(layout, "top-left")).toEqual({
      bar: "top",
      zone: 0,
    });
    expect(fallbackZoneFor(layout, "top-right")).toEqual({
      bar: "top",
      zone: 1,
    });
    expect(fallbackZoneFor(layout, "bottom-right")).toEqual({
      bar: "bottom",
      zone: 2,
    });
  });
});

// 폴백 자리를 배치에 실제로 써 넣는 변형 — 설정 편집기 목업이 노트 실물과 같아지게 한다.
describe("materializeFallbacks", () => {
  const base = (): ToolbarLayout => ({
    top: { align: "left", zones: [["core:preview"], ["core:collapse"]] },
    bottom: { align: "left", zones: [["core:archive"], ["core:delete"]] },
    seen: ["core:preview", "core:collapse", "core:archive", "core:delete"],
  });

  it("미확인(seen 밖) 아이템만 position이 가리키는 존 끝에 넣는다", () => {
    const r = materializeFallbacks(base(), [
      { key: "plugin:new:btn", position: "bottom-left" },
      { key: "plugin:known:btn", position: "top-left" }, // seen에 없지만 position 없음 케이스 대비
    ]);
    expect(r.bottom.zones[0]).toEqual(["core:archive", "plugin:new:btn"]);
    expect(r.top.zones[0]).toEqual(["core:preview", "plugin:known:btn"]);
  });

  it("이미 배치됐거나 seen에 있는 키·position 없는 키는 건드리지 않는다", () => {
    const layout: ToolbarLayout = {
      ...base(),
      seen: [...(base().seen ?? []), "plugin:removed:btn"],
    };
    const r = materializeFallbacks(layout, [
      { key: "plugin:removed:btn", position: "bottom-left" }, // 사용자가 뺀 것 → 계속 숨김
      { key: "core:archive", position: "bottom-right" }, // 이미 배치됨 → 이동하지 않음
      { key: "plugin:noposition:btn" }, // 폴백 자리 없음 → 미배치 유지
    ]);
    expect(r).toEqual(layout); // 원본과 같은 내용(변화 없음)
  });

  it("그 바가 0단이면 넣지 않는다(원본 불변)", () => {
    const layout: ToolbarLayout = {
      top: { align: "left", zones: [] },
      bottom: { align: "left", zones: [] },
      seen: [],
    };
    const r = materializeFallbacks(layout, [
      { key: "plugin:new:btn", position: "top-left" },
    ]);
    expect(placedKeys(r).size).toBe(0);
  });
});

describe("tierOf / placedKeys / locateItem", () => {
  it("단 수와 배치 키를 센다", () => {
    expect(tierOf(DEFAULT_LAYOUT.top)).toBe(2);
    const placed = placedKeys(DEFAULT_LAYOUT);
    expect(placed.has("core:preview")).toBe(true);
    expect(placed.has("core:delete")).toBe(true);
    expect(placed.has("plugin:font-scale:font-plus")).toBe(true);
  });

  it("아이템 위치를 찾는다(없으면 null)", () => {
    expect(locateItem(DEFAULT_LAYOUT, "core:preview")).toEqual({
      bar: "top",
      zone: 0,
      index: 1,
    });
    expect(locateItem(DEFAULT_LAYOUT, "core:collapse")?.bar).toBe("top");
    expect(locateItem(DEFAULT_LAYOUT, "nope")).toBeNull();
  });
});

// 노트 툴바 렌더와 설정 편집기 목업이 같은 정렬 규칙을 써야 "보이는 대로 배치된다"가 성립한다.
describe("zoneAlignOf", () => {
  const bar = (zones: string[][], align: "left" | "right"): BarLayout => ({
    align,
    zones,
  });

  it("1단은 바 정렬(좌/우)을 따른다", () => {
    expect(zoneAlignOf(bar([["a"]], "left"), 0)).toBe("left");
    expect(zoneAlignOf(bar([["a"]], "right"), 0)).toBe("right");
  });

  it("2단은 좌·우, 3단은 좌·중·우로 고정(바 정렬 무시)", () => {
    const two = bar([["a"], ["b"]], "right");
    expect([zoneAlignOf(two, 0), zoneAlignOf(two, 1)]).toEqual([
      "left",
      "right",
    ]);
    const three = bar([["a"], ["b"], ["c"]], "right");
    expect([
      zoneAlignOf(three, 0),
      zoneAlignOf(three, 1),
      zoneAlignOf(three, 2),
    ]).toEqual(["left", "center", "right"]);
  });

  it("존 범위를 벗어난 index는 좌로 떨어진다(방어)", () => {
    expect(zoneAlignOf(bar([["a"], ["b"], ["c"]], "left"), 9)).toBe("left");
  });
});

// 초기화 버튼 노출 기준 — 저장 이력이 아니라 **내용**으로 판단해야 한다.
describe("isDefaultLayout", () => {
  /** `position`을 선언한(=설치 직후 자동 배치되는) 서드파티 버튼 하나짜리 팔레트. */
  const AUTO = [{ key: "plugin:third:btn", position: "bottom-right" as const }];

  it("기본 배치 자체(와 그 복제)는 같다고 본다", () => {
    expect(isDefaultLayout(DEFAULT_LAYOUT, [])).toBe(true);
    expect(isDefaultLayout(structuredClone(DEFAULT_LAYOUT), [])).toBe(true);
    expect(isDefaultLayout(resolveLayout(null), [])).toBe(true);
  });

  it("아이템·단 수·정렬·줄임 우선순위 중 하나만 달라도 다르다고 본다", () => {
    const drop = structuredClone(DEFAULT_LAYOUT);
    drop.top.zones[0].pop();
    expect(isDefaultLayout(drop, [])).toBe(false);
    expect(isDefaultLayout(setTier(DEFAULT_LAYOUT, "bottom", 1), [])).toBe(
      false,
    );
    expect(isDefaultLayout(setAlign(DEFAULT_LAYOUT, "top", "right"), [])).toBe(
      false,
    );
    expect(isDefaultLayout(setFoldRank(DEFAULT_LAYOUT, "top", 0, 0), [])).toBe(
      false,
    );
  });

  it("옮겼다 제자리로 되돌리면 다시 같다고 본다", () => {
    const key = DEFAULT_LAYOUT.top.zones[0][0];
    const moved = moveItem(DEFAULT_LAYOUT, key, {
      bar: "bottom",
      zone: 0,
      index: 0,
    });
    expect(isDefaultLayout(moved, [])).toBe(false);
    expect(
      isDefaultLayout(
        moveItem(moved, key, { bar: "top", zone: 0, index: 0 }),
        [],
      ),
    ).toBe(true);
  });

  /**
   * 가드(회귀): `position` 폴백으로 **자동 배치된** 버튼은 "사용자가 바꾼 것"이 아니다 —
   * 기본 배치 쪽에도 같은 폴백을 태워 비교하므로 여전히 기본으로 본다. 이걸 놓쳤을 때
   * 서드파티 플러그인 하나만 설치돼도 초기화 버튼이 영구히 떠 있었다.
   */
  it("자동 배치된(position) 버튼이 채워진 기본 배치도 기본으로 본다", () => {
    const auto = materializeFallbacks(DEFAULT_LAYOUT, AUTO);
    expect(auto.bottom.zones[1]).toContain("plugin:third:btn");
    expect(isDefaultLayout(auto, AUTO)).toBe(true);
    // 팔레트를 안 넘기면(자동 배치를 모르면) 당연히 다르다 — 판정은 팔레트에 의존한다.
    expect(isDefaultLayout(auto, [])).toBe(false);
  });

  /** 가드: 자동 배치된 버튼을 사용자가 치우면(팔레트로 빼면) 되돌릴 것이 생긴다. */
  it("자동 배치된 버튼을 빼면 기본과 다르다고 본다", () => {
    const auto = materializeFallbacks(DEFAULT_LAYOUT, AUTO);
    const removed = moveItem(auto, "plugin:third:btn", null);
    expect(isDefaultLayout(removed, AUTO)).toBe(false);
  });

  /**
   * 가드(이슈 #16): Mac 스타일 기본 배치도 "기본"으로 인정한다 — DEFAULT_LAYOUT(단일 폴백,
   * Windows 스타일)만 기준으로 비교하면 Mac 스타일을 고른 사용자는 아무것도 안 만졌는데
   * "초기화" 버튼이 영구히 뜬다.
   */
  it("Mac 스타일 기본 배치도 기본으로 본다", () => {
    expect(isDefaultLayout(DEFAULT_LAYOUT_MAC, [])).toBe(true);
    expect(isDefaultLayout(structuredClone(DEFAULT_LAYOUT_MAC), [])).toBe(true);
  });

  /**
   * 가드(회귀): 조건부 컨트롤(투명도 등)을 끈 사용자의 배치는 이미 정리된(pruned) 상태다 —
   * 기준선도 **같은 판정으로** 걸러야 "손 안 댔다"가 성립한다. 안 그러면 초기화 버튼이 영구히
   * 떠 있었다.
   */
  it("가용 판정을 주면 정리된 기본 배치도 기본으로 본다", () => {
    const off = new Set(["core:transparency", "core:pin"]);
    const isAvailable = (key: string): boolean => !off.has(key);
    const pruned = pruneLayout(DEFAULT_LAYOUT_WINDOWS, isAvailable);
    expect(isDefaultLayout(pruned, [])).toBe(false); // 판정 없이는 다르게 보인다(모름).
    expect(isDefaultLayout(pruned, [], isAvailable)).toBe(true);
    // 그래도 진짜 변경은 여전히 잡는다.
    expect(
      isDefaultLayout(setAlign(pruned, "top", "right"), [], isAvailable),
    ).toBe(false);
  });
});

describe("defaultLayoutFor", () => {
  /**
   * 기본 배치 상수에는 조건부 아이템(투명도·핀·모든 데스크탑·배경색, 번들 플러그인 버튼)이
   * 하드코딩돼 있다 — 「기본 배치로 초기화」가 그걸 그대로 쓰면 꺼둔 항목이 유령으로 되살아난다.
   */
  it("가용 판정을 주면 못 쓰는 아이템을 기준선에서 걷어낸다", () => {
    const off = new Set(["core:transparency", "plugin:font-scale:font-plus"]);
    const base = defaultLayoutFor(
      DEFAULT_LAYOUT_WINDOWS,
      [],
      (key) => !off.has(key),
    );
    const placed = [...base.top.zones, ...base.bottom.zones].flat();
    expect(placed).not.toContain("core:transparency");
    expect(placed).not.toContain("plugin:font-scale:font-plus");
    expect(placed).toContain("core:preview");
    expect(base.seen).toEqual([]); // 초기화 = 폴백 규칙을 처음처럼 다시 적용.
  });

  it("판정을 생략하면(모름) 기본 상수를 그대로 기준선으로 쓴다", () => {
    const base = defaultLayoutFor(DEFAULT_LAYOUT_WINDOWS, []);
    expect(base.top.zones).toEqual(DEFAULT_LAYOUT_WINDOWS.top.zones);
    expect(base.bottom.zones).toEqual(DEFAULT_LAYOUT_WINDOWS.bottom.zones);
  });

  it("position 폴백은 그대로 채운다(가용한 신규 버튼은 기본 자리로)", () => {
    const item = { key: "plugin:third:btn", position: "bottom-right" as const };
    const base = defaultLayoutFor(DEFAULT_LAYOUT_WINDOWS, [item], () => true);
    expect(base.bottom.zones[1]).toContain("plugin:third:btn");
  });
});

/**
 * 이슈 #16 — OS별 기본 배치 2종. 둘 다 "닫기(core:archive)는 상단, 삭제(core:delete)는
 * 하단"을 지키되, 닫기의 좌/우만 OS 관례를 따라 갈린다(Mac=좌측 맨 앞, Windows=우측 맨 끝).
 */
describe("DEFAULT_LAYOUT_MAC / DEFAULT_LAYOUT_WINDOWS", () => {
  it("닫기는 둘 다 상단, 삭제는 둘 다 하단에 있다", () => {
    for (const layout of [DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS]) {
      expect(locateItem(layout, "core:archive")?.bar).toBe("top");
      expect(locateItem(layout, "core:delete")?.bar).toBe("bottom");
    }
  });

  it("Mac은 닫기가 상단 좌측 존의 맨 앞, Windows는 상단 우측 존의 맨 끝이다", () => {
    const macLoc = locateItem(DEFAULT_LAYOUT_MAC, "core:archive")!;
    expect(zoneAlignOf(DEFAULT_LAYOUT_MAC.top, macLoc.zone)).toBe("left");
    expect(macLoc.index).toBe(0);

    const winLoc = locateItem(DEFAULT_LAYOUT_WINDOWS, "core:archive")!;
    expect(zoneAlignOf(DEFAULT_LAYOUT_WINDOWS.top, winLoc.zone)).toBe("right");
    expect(
      DEFAULT_LAYOUT_WINDOWS.top.zones[winLoc.zone][
        DEFAULT_LAYOUT_WINDOWS.top.zones[winLoc.zone].length - 1
      ],
    ).toBe("core:archive");
  });

  it("설정 바로가기(core:settings)가 두 배치 모두 상단 우측에 있다", () => {
    for (const layout of [DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS]) {
      const loc = locateItem(layout, "core:settings")!;
      expect(loc.bar).toBe("top");
      expect(zoneAlignOf(layout.top, loc.zone)).toBe("right");
    }
  });

  it("하단 바(복제·복사·단어수·초기화·삭제)는 두 배치가 완전히 같다", () => {
    expect(DEFAULT_LAYOUT_MAC.bottom).toEqual(DEFAULT_LAYOUT_WINDOWS.bottom);
    // 서로 다른 객체(참조 공유 없음) — 한쪽을 변형해도 다른 쪽이 오염되지 않는다.
    expect(DEFAULT_LAYOUT_MAC.bottom).not.toBe(DEFAULT_LAYOUT_WINDOWS.bottom);
  });

  /** 가드(베타 피드백 1건): 새 메모 버튼이 두 기본 배치 모두 상단 우측 존의 맨 앞에 있다. */
  it("새 메모(core:new-note)가 두 배치 모두 상단 우측 존의 맨 앞에 있다", () => {
    for (const layout of [DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS]) {
      const loc = locateItem(layout, "core:new-note")!;
      expect(loc.bar).toBe("top");
      expect(zoneAlignOf(layout.top, loc.zone)).toBe("right");
      expect(loc.index).toBe(0);
    }
  });

  it("DEFAULT_LAYOUT(단일 폴백)은 Windows 스타일과 같다", () => {
    expect(DEFAULT_LAYOUT).toEqual(DEFAULT_LAYOUT_WINDOWS);
  });

  /** 가드: 접힘 제목이 두 배치 모두 기본으로 보인다(사용자 요구 1건 — 회귀 시 접힘 헤더가 빈다). */
  it("접힘 제목(core:collapsed-title)이 두 배치 모두 상단 좌측 존에 있다", () => {
    for (const layout of [DEFAULT_LAYOUT_MAC, DEFAULT_LAYOUT_WINDOWS]) {
      const loc = locateItem(layout, "core:collapsed-title")!;
      expect(loc.bar).toBe("top");
      expect(zoneAlignOf(layout.top, loc.zone)).toBe("left");
    }
  });
});

describe("setTier", () => {
  const base: ToolbarLayout = {
    top: { align: "left", zones: [["a"], ["b"], ["c"]] },
    bottom: { align: "left", zones: [["d"]] },
  };

  it("단을 줄이면 사라진 존의 아이템은 미배치가 된다(남은 존은 그대로)", () => {
    const r = setTier(base, "top", 1);
    expect(r.top.zones).toEqual([["a"]]);
    expect(placedKeys(r).has("b")).toBe(false);
    expect(placedKeys(r).has("c")).toBe(false);
    // 원본 불변.
    expect(base.top.zones.length).toBe(3);
  });

  it("단을 늘리면 빈 존을 뒤에 추가한다", () => {
    const r = setTier(base, "bottom", 3);
    expect(r.bottom.zones).toEqual([["d"], [], []]);
  });

  it("0..MAX_TIERS로 클램프한다", () => {
    expect(setTier(base, "top", -5).top.zones).toEqual([]);
    expect(setTier(base, "top", 99).top.zones.length).toBe(MAX_TIERS);
  });
});

describe("setAlign", () => {
  it("바 정렬을 바꾼다(원본 불변)", () => {
    const r = setAlign(DEFAULT_LAYOUT, "top", "right");
    expect(r.top.align).toBe("right");
    expect(DEFAULT_LAYOUT.top.align).toBe("left");
  });
});

describe("foldRank (줄임 우선순위)", () => {
  const base: ToolbarLayout = {
    top: { align: "left", zones: [["a"], ["b"], ["c"]] },
    bottom: { align: "left", zones: [["d"]] },
  };

  it("기본은 보통(1)이고, setFoldRank가 한 존만 바꾼다(원본 불변)", () => {
    expect(foldRankOf(base.top, 0)).toBe(1);
    const r = setFoldRank(base, "top", 1, 0); // 가운데 존 '먼저 줄임'
    expect(foldRankOf(r.top, 1)).toBe(0);
    expect(foldRankOf(r.top, 0)).toBe(1);
    expect(foldRankOf(r.top, 2)).toBe(1);
    expect(base.top.foldRank).toBeUndefined(); // 원본 불변
  });

  it("모두 보통이면 foldRank를 두지 않는다(직렬화 최소화)", () => {
    const r = setFoldRank(setFoldRank(base, "top", 0, 2), "top", 0, 1);
    expect(r.top.foldRank).toBeUndefined();
  });

  it("resolveLayout이 foldRank를 존 개수만큼·0..2로 정규화한다", () => {
    const r = resolveLayout({
      top: { align: "left", zones: [["a"], ["b"]], foldRank: [2, 9, 0] },
      bottom: { align: "left", zones: [] },
    });
    expect(foldRankOf(r.top, 0)).toBe(2);
    expect(foldRankOf(r.top, 1)).toBe(2); // 9 → 클램프 2
    expect(r.top.foldRank?.length).toBe(2); // 존 개수만큼만
  });

  it("clone이 foldRank를 독립 복제한다", () => {
    const src = setFoldRank(base, "top", 0, 0);
    const r = setTier(src, "bottom", 2); // clone 경유
    r.top.foldRank![0] = 2;
    expect(foldRankOf(src.top, 0)).toBe(0); // 원본 영향 없음
  });
});

describe("clearZone", () => {
  it("한 존을 비우고(아이템은 미배치) 다른 존은 보존한다(원본 불변)", () => {
    const base: ToolbarLayout = {
      top: { align: "left", zones: [["a", "b"], ["c"]] },
      bottom: { align: "left", zones: [["d"]] },
    };
    const r = clearZone(base, "top", 0);
    expect(r.top.zones).toEqual([[], ["c"]]);
    expect(placedKeys(r).has("a")).toBe(false);
    expect(base.top.zones[0]).toEqual(["a", "b"]); // 원본 불변
  });
});

describe("moveItem", () => {
  const base: ToolbarLayout = {
    top: { align: "left", zones: [["a", "b", "c"], ["x"]] },
    bottom: { align: "left", zones: [["d"]] },
  };

  it("같은 존 안에서 재정렬한다(제거 후 삽입으로 정확한 최종 index)", () => {
    const r = moveItem(base, "a", { bar: "top", zone: 0, index: 2 });
    expect(r.top.zones[0]).toEqual(["b", "c", "a"]);
  });

  it("다른 존/바로 옮긴다", () => {
    const r = moveItem(base, "b", { bar: "bottom", zone: 0, index: 0 });
    expect(r.top.zones[0]).toEqual(["a", "c"]);
    expect(r.bottom.zones[0]).toEqual(["b", "d"]);
  });

  it("to=null이면 팔레트로(어디서든 제거)", () => {
    const r = moveItem(base, "x", null);
    expect(placedKeys(r).has("x")).toBe(false);
    expect(r.top.zones[1]).toEqual([]);
  });

  it("존이 없으면 무시하고, 인덱스는 존 길이로 클램프한다", () => {
    expect(moveItem(base, "a", { bar: "top", zone: 5, index: 0 })).toEqual(
      base,
    );
    const r = moveItem(base, "d", { bar: "top", zone: 0, index: 99 });
    expect(r.top.zones[0]).toEqual(["a", "b", "c", "d"]);
  });

  it("원본을 변형하지 않는다", () => {
    moveItem(base, "a", { bar: "bottom", zone: 0, index: 0 });
    expect(base.top.zones[0]).toEqual(["a", "b", "c"]);
  });
});

describe("BUILTIN_ITEMS", () => {
  it("11개 내장 컨트롤을 고유 키로 선언한다", () => {
    expect(BUILTIN_ITEMS.length).toBe(11);
    const keys = BUILTIN_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("조건부 컨트롤 메타를 붙인다(창 컨트롤·배경)", () => {
    const byKey = Object.fromEntries(BUILTIN_ITEMS.map((i) => [i.key, i]));
    expect(byKey["core:transparency"].requiresControl).toBe("transparency");
    expect(byKey["core:pin"].requiresControl).toBe("always-on-top");
    expect(byKey["core:all-desktops"].requiresControl).toBe("all-desktops");
    expect(byKey["core:background"].requiresBackground).toBe(true);
    expect(byKey["core:preview"].requiresControl).toBeUndefined();
    // 새 메모(베타 피드백 1건)는 조건부 창 컨트롤이 아니다 — 항상 가용.
    expect(byKey["core:new-note"].requiresControl).toBeUndefined();
    expect(byKey["core:new-note"].requiresBackground).toBeUndefined();
  });

  describe("nameKey", () => {
    // registerLocale이 더한 로케일(store.ts locales Map)은 되돌릴 export가 없다
    // (store.test.ts와 같은 관례) — active만 테스트마다 ko로 되돌린다.
    afterEach(() => setActiveLocale("ko"));

    /**
     * 회귀 가드: 카탈로그가 `name`(완성 문장)이 아니라 `nameKey`(i18n 키)만 갖는다 — 소비
     * 지점(설정 › 툴바 배치 팔레트)이 `t(nameKey)`로 호출 시점에 해석해야 한다.
     * `nameKey: t(...)`로 되돌리면(모듈 최상위 즉시 평가) 활성 로케일이 무엇이든 이 모듈이
     * 로드되는 순간의 로케일로 영원히 굳는다(§i18n 규약). `registerLocale`은 되돌릴 export가
     * 없으므로(store.test.ts와 같은 관례) 이 파일에서 유일한 코드("xx")를 쓴다.
     */
    it("t(nameKey)는 활성 로케일을 호출 시점에 반영한다", () => {
      registerLocale("xx", "Test", {
        "note.layout.item-transparency": "XX Transparency",
      });
      const item = BUILTIN_ITEMS.find((i) => i.key === "core:transparency")!;

      setActiveLocale("xx");
      expect(t(item.nameKey)).toBe("XX Transparency");

      setActiveLocale("ko");
      expect(t(item.nameKey)).toBe("투명도");
    });
  });
});

describe("availableBuiltinItems", () => {
  it("대응 창 컨트롤이 꺼진 내장 컨트롤을 뺀다", () => {
    const keys = availableBuiltinItems(["transparency"], true).map(
      (i) => i.key,
    );
    expect(keys).toContain("core:transparency");
    expect(keys).not.toContain("core:pin"); // always-on-top 없음
    expect(keys).not.toContain("core:all-desktops");
    // 조건 없는 컨트롤은 항상 남는다.
    expect(keys).toContain("core:preview");
    expect(keys).toContain("core:archive");
  });

  it("배경 스와치가 없으면 배경색 피커를 뺀다", () => {
    const keys = availableBuiltinItems([], false).map((i) => i.key);
    expect(keys).not.toContain("core:background");
    expect(availableBuiltinItems([], true).map((i) => i.key)).toContain(
      "core:background",
    );
  });

  it("모든 내장 컨트롤이 폴백 자리를 선언한다(기본 배치와 같은 바·정렬)", () => {
    const byKey = Object.fromEntries(BUILTIN_ITEMS.map((i) => [i.key, i]));
    expect(byKey["core:transparency"].position).toBe("top-left");
    expect(byKey["core:collapse"].position).toBe("top-right");
    expect(byKey["core:settings"].position).toBe("top-right");
    // 닫기(구 보관)의 단일 폴백 자리는 상단(스펙: 닫기는 상단) — 두 OS 기본 배치가 갈리는
    // 좌/우 중 Windows 쪽(top-right)을 대표로 쓴다(DEFAULT_LAYOUT=Windows 스타일 참고).
    expect(byKey["core:archive"].position).toBe("top-right");
    expect(byKey["core:delete"].position).toBe("bottom-right");
    // 폴백 자리는 DEFAULT_LAYOUT의 실제 자리와 일치해야 한다 — 어긋나면 다시 켠 컨트롤이
    // "기본 위치"라며 엉뚱한 바에 나타난다.
    for (const item of BUILTIN_ITEMS) {
      const loc = locateItem(DEFAULT_LAYOUT, item.key)!;
      const bar = item.position.startsWith("top") ? "top" : "bottom";
      const align = item.position.endsWith("left") ? "left" : "right";
      expect(loc.bar).toBe(bar);
      expect(zoneAlignOf(DEFAULT_LAYOUT[bar], loc.zone)).toBe(align);
    }
  });
});

describe("pruneLayout", () => {
  const layout: ToolbarLayout = {
    top: { align: "left", zones: [["keep", "drop"], ["drop2"]] },
    bottom: { align: "left", zones: [["keep2"]] },
    seen: ["keep", "drop", "gone"],
  };
  const alive = (key: string) => key.startsWith("keep");

  it("존과 seen 양쪽에서 미가용 키를 지운다", () => {
    const r = pruneLayout(layout, alive);
    expect(r.top.zones).toEqual([["keep"], []]);
    expect(r.bottom.zones).toEqual([["keep2"]]);
    expect(r.seen).toEqual(["keep"]);
  });

  /**
   * 스펙(사용자 확정): 비활성화 → 활성화는 **이전 위치를 기억하지 않는다**. seen까지 지워야
   * 그 키가 "한 번도 본 적 없는 신규"로 되돌아가 materializeFallbacks가 기본 자리에 놓는다.
   * seen에 남기면 "사용자가 명시적으로 뺀 것"으로 읽혀 다시 켜도 영영 안 나온다.
   */
  it("정리된 키는 다시 가용해질 때 이전 자리가 아니라 기본 자리로 돌아온다", () => {
    // 사용자가 삭제 버튼을 하단-좌로 옮겨 둔 상태에서 그 컨트롤이 미가용이 됐다고 하자.
    const moved: ToolbarLayout = {
      top: { align: "left", zones: [["core:preview"], []] },
      bottom: { align: "left", zones: [["core:delete"], []] },
      seen: ["core:preview", "core:delete"],
    };
    const pruned = pruneLayout(moved, (k) => k !== "core:delete");
    expect(placedKeys(pruned).has("core:delete")).toBe(false);
    expect(pruned.seen).not.toContain("core:delete");

    const back = materializeFallbacks(pruned, [
      { key: "core:delete", position: "bottom-right" },
    ]);
    const loc = locateItem(back, "core:delete")!;
    expect(loc.bar).toBe("bottom");
    expect(zoneAlignOf(back.bottom, loc.zone)).toBe("right"); // 옛 자리(하단 좌)가 아니다.
  });

  it("원본을 변형하지 않는다", () => {
    pruneLayout(layout, alive);
    expect(layout.top.zones[0]).toEqual(["keep", "drop"]);
    expect(layout.seen).toEqual(["keep", "drop", "gone"]);
  });
});

describe("sameLayout", () => {
  const base: ToolbarLayout = {
    top: { align: "left", zones: [["a"]] },
    bottom: { align: "left", zones: [[]] },
    seen: ["a", "b"],
  };

  it("같은 내용이면 참(seen 순서는 무관)", () => {
    expect(sameLayout(base, { ...base, seen: ["b", "a"] })).toBe(true);
  });

  /** 가드: 존은 그대로고 seen에서만 키가 빠지는 정리도 "바뀜"으로 봐야 저장이 일어난다. */
  it("seen만 달라도 거짓", () => {
    expect(sameLayout(base, { ...base, seen: ["a"] })).toBe(false);
  });

  it("존 내용·정렬이 다르면 거짓", () => {
    expect(
      sameLayout(base, { ...base, top: { align: "right", zones: [["a"]] } }),
    ).toBe(false);
    expect(
      sameLayout(base, {
        ...base,
        top: { align: "left", zones: [["a", "c"]] },
      }),
    ).toBe(false);
  });
});
