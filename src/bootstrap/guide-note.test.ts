import { describe, expect, it, vi } from "vitest";
import { ensureGuideNote, showGuideNote, type GuideNoteIO } from "./guide-note";

/**
 * 「시작 가이드」 배선 가드 — 만들지/열지의 **판정**만 본다(본문 조립은 `note/guide-note.ts`,
 * "정확히 한 장"은 코어의 `claim_guide_note`가 각각 자기 가드를 갖는다).
 *
 * 여기서 지키는 계약 넷:
 *  - 이미 있으면(claim이 null) 아무것도 열지 않는다 — 창을 열 때마다 가이드가 앞으로
 *    튀어나오면 안 된다.
 *  - 만들었을 때만 소환하고, 그것도 호출부가 원할 때만(`summon` 옵션).
 *  - 시작 경로의 실패는 삼킨다(패널·설정 창의 마운트를 깨뜨리지 않는다).
 *  - 「다시 보기」는 **지워진 가이드를 다시 만든다**(없는 id로 조용히 아무 일도 안 하지 않는다).
 */

/** 목 IO — 기본은 "아직 가이드 없음". 테스트가 필요한 부분만 덮어쓴다. */
function io(overrides: Partial<GuideNoteIO> = {}): GuideNoteIO {
  return {
    buildBody: vi.fn(async () => "# 시작 가이드"),
    claim: vi.fn(async () => "new-id" as string | null),
    guideNoteId: vi.fn(async () => null as string | null),
    noteExists: vi.fn(async () => true),
    summon: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ensureGuideNote", () => {
  it("선점하면 본문과 함께 만들고(force 없이) 그 창을 연다", async () => {
    const deps = io();
    const id = await ensureGuideNote(deps, { summon: true });
    expect(id).toBe("new-id");
    expect(deps.claim).toHaveBeenCalledWith("# 시작 가이드", false);
    expect(deps.summon).toHaveBeenCalledWith("new-id");
  });

  it("이미 있으면(claim null) 소환하지 않는다", async () => {
    const deps = io({ claim: vi.fn(async () => null) });
    expect(await ensureGuideNote(deps, { summon: true })).toBeNull();
    expect(deps.summon).not.toHaveBeenCalled();
  });

  it("summon:false면 만들되 열지 않는다(포커스를 뺏지 않는다)", async () => {
    const deps = io();
    expect(await ensureGuideNote(deps, { summon: false })).toBe("new-id");
    expect(deps.summon).not.toHaveBeenCalled();
  });

  it("실패를 삼킨다 — 창 마운트를 깨뜨리지 않는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = io({
      claim: vi.fn(async () => {
        throw new Error("vault busy");
      }),
    });
    await expect(ensureGuideNote(deps, { summon: true })).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("showGuideNote", () => {
  it("있으면 그대로 소환한다(새로 만들지 않는다)", async () => {
    const deps = io({ guideNoteId: vi.fn(async () => "old-id") });
    await showGuideNote(deps);
    expect(deps.summon).toHaveBeenCalledWith("old-id");
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("기록은 있는데 노트가 없으면 force로 다시 만들어 연다", async () => {
    const deps = io({
      guideNoteId: vi.fn(async () => "deleted-id"),
      noteExists: vi.fn(async () => false),
    });
    await showGuideNote(deps);
    expect(deps.claim).toHaveBeenCalledWith("# 시작 가이드", true);
    expect(deps.summon).toHaveBeenCalledWith("new-id");
  });

  it("한 번도 만든 적 없으면 만들어 연다", async () => {
    const deps = io();
    await showGuideNote(deps);
    expect(deps.claim).toHaveBeenCalledWith("# 시작 가이드", true);
    expect(deps.noteExists).not.toHaveBeenCalled();
    expect(deps.summon).toHaveBeenCalledWith("new-id");
  });

  it("실패를 삼키지 않는다 — 버튼을 누른 사람이 결과를 기다린다", async () => {
    const deps = io({
      guideNoteId: vi.fn(async () => "old-id"),
      summon: vi.fn(async () => {
        throw new Error("no window");
      }),
    });
    await expect(showGuideNote(deps)).rejects.toThrow("no window");
  });
});
