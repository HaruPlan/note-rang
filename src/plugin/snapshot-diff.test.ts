/**
 * 스냅샷 슬라이스 비교 헬퍼 가드 — 두 판정기(중앙 호스트의 단일 핫리로드, 노트 창의 재빌드
 * 반영)가 **같은 기준**으로 "부분 갱신으로 따라갈 수 있는가"를 묻게 하는 계약.
 *
 * 여기서 못박는 것은 두 가지다: (1) 생략(`undefined`)과 빈 배열은 같다 — 구버전 스냅샷 폴백이
 * "바뀌었다"로 잡히면 안 된다. (2) 순서가 바뀌면 다르다 — 소비처의 렌더 순서가 실제로 달라진다.
 */
import { describe, expect, it } from "vitest";
import {
  buttonsEqual,
  commandsEqual,
  menuItemsEqual,
  sameNameSet,
  sliceHasCapabilities,
  statusItemsEqual,
} from "./snapshot-diff";
import type { PluginSnapshot, SnapshotToolbarButton } from "./host-protocol";

/** 최소 슬라이스(능력 판정에만 쓴다 — 나머지 표면은 빈 등록). */
function slice(over: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return {
    pluginId: "p",
    grant: { declared: [], granted: [] },
    patterns: [],
    completions: [],
    embeds: [],
    buttons: [],
    ...over,
  };
}

const BTN = (id: string): SnapshotToolbarButton => ({
  id,
  label: id.toUpperCase(),
  position: "top-left",
  buttonId: `onClick$${id}`,
});

describe("buttonsEqual", () => {
  it("treats identical button lists as equal and any difference as unequal", () => {
    expect(buttonsEqual([BTN("a")], [BTN("a")])).toBe(true);
    expect(buttonsEqual([BTN("a")], [BTN("b")])).toBe(false);
    expect(buttonsEqual([BTN("a")], [])).toBe(false);
  });

  /** 가드: 순서가 바뀌면 툴바 렌더가 실제로 달라진다 — "다름"으로 본다(보수적). */
  it("treats reordering as a change", () => {
    expect(buttonsEqual([BTN("a"), BTN("b")], [BTN("b"), BTN("a")])).toBe(
      false,
    );
  });
});

describe("commandsEqual / menuItemsEqual / statusItemsEqual", () => {
  /** 가드(핵심): 생략은 빈 목록과 같다 — 구버전 스냅샷 폴백(`?? []`)과 같은 의미론. */
  it("treats an omitted list as an empty one", () => {
    expect(commandsEqual(undefined, [])).toBe(true);
    expect(menuItemsEqual(undefined, [])).toBe(true);
    expect(statusItemsEqual(undefined, [])).toBe(true);
  });

  it("detects added, removed, and edited entries", () => {
    expect(commandsEqual([{ id: "c", title: "C" }], undefined)).toBe(false);
    expect(
      menuItemsEqual([{ id: "m", label: "M" }], [{ id: "m", label: "M2" }]),
    ).toBe(false);
    expect(
      statusItemsEqual(
        [{ id: "s", text: "0", position: "top-right" }],
        [{ id: "s", text: "1", position: "top-right" }],
      ),
    ).toBe(false);
  });
});

describe("sliceHasCapabilities", () => {
  /** 가드: 등록 순서 의존 병합 능력(배경·폰트·창 컨트롤) 중 하나라도 있으면 참이다. */
  it("is true for background, font, or window controls", () => {
    expect(sliceHasCapabilities(slice())).toBe(false);
    expect(
      sliceHasCapabilities(
        slice({ background: { swatches: [], autoTextContrast: false } }),
      ),
    ).toBe(true);
    expect(sliceHasCapabilities(slice({ font: { families: [] } }))).toBe(true);
    expect(
      sliceHasCapabilities(slice({ windowControls: ["transparency"] })),
    ).toBe(true);
    // 빈 배열은 "등록 없음"이다(생략과 같다).
    expect(sliceHasCapabilities(slice({ windowControls: [] }))).toBe(false);
  });
});

describe("sameNameSet", () => {
  /** 가드: 순서는 무관하고 원소 집합만 본다(구독 이름·창 컨트롤 id 비교용). */
  it("compares as an unordered set", () => {
    expect(sameNameSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameNameSet(["a"], ["a", "b"])).toBe(false);
    expect(sameNameSet([], [])).toBe(true);
  });
});
