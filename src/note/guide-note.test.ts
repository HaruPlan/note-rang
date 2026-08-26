import { beforeEach, describe, expect, it } from "vitest";
import ko from "../i18n/ko.json";
import { registerLocale, setActiveLocale } from "../i18n/store";
import { buildGuideNoteBody } from "./guide-note";

/**
 * 「시작 가이드」 본문 조립 가드.
 *
 * 무엇을 지키나: (1) 목록 제목이 뽑히는 첫 줄 헤딩, (2) 눌러서 토글되는 **작업목록** 문법
 * (평범한 목록이 되면 "체크해 보세요"가 거짓말이 된다), (3) 버튼 이름을 사전에서 끌어온다
 * (문장에 박아 두면 버튼 라벨이 바뀌는 날 가이드만 옛 이름으로 남는다), (4) 치환되지 않은
 * `{자리}`가 남지 않는다, (5) 로케일을 따라간다.
 */
describe("buildGuideNoteBody", () => {
  beforeEach(() => {
    setActiveLocale("ko");
  });

  it("첫 줄이 제목 헤딩이다(목록 제목이 여기서 나온다)", () => {
    const body = buildGuideNoteBody({ newNoteAccel: "", isMac: true });
    expect(body.split("\n")[0]).toBe(`# ${ko["note.guide.title"]}`);
  });

  it("해 보는 항목만 작업목록(`- [ ]`)이다", () => {
    const body = buildGuideNoteBody({ newNoteAccel: "", isMac: false });
    const lines = body.split("\n");
    const tasks = lines.filter((l) => l.startsWith("- [ ] "));
    // 창 3 + 글쓰기 4 + 찾기 4 + 취향 1.
    expect(tasks).toHaveLength(12);
    // 저장 위치 안내는 "해 보는 일"이 아니라 알아 두는 것 — 체크박스를 달지 않는다.
    const facts = lines.filter(
      (l) => l.startsWith("- ") && !l.startsWith("- ["),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain(".md");
  });

  it("버튼 이름을 그 버튼의 i18n 키에서 끌어온다", () => {
    const body = buildGuideNoteBody({ newNoteAccel: "", isMac: true });
    for (const key of [
      "note.layout.item-collapse",
      "note.layout.item-transparency",
      "note.layout.item-pin",
      "note.layout.item-all-desktops",
      "note.layout.item-archive",
      "note.selection-toolbar.bold",
      "note.selection-toolbar.color",
      "note.window.menu-insert-image",
      "note.window.menu-insert-youtube",
      "panel.sort.label",
    ] as const) {
      expect(body, `${key}의 라벨이 본문에 없다`).toContain(ko[key]);
    }
  });

  it("단축키를 이 OS 표기로 넣고, 모르면 설정 안내로 갈아 끼운다", () => {
    const mac = buildGuideNoteBody({
      newNoteAccel: "CmdOrCtrl+Shift+N",
      isMac: true,
    });
    expect(mac).toContain("⌘⇧N");
    const win = buildGuideNoteBody({
      newNoteAccel: "CmdOrCtrl+Shift+N",
      isMac: false,
    });
    // `CmdOrCtrl`은 "이 OS의 주 수식키" — 非mac에서 Win이 아니라 Ctrl이다(accel.ts 가드).
    expect(win).toContain("Ctrl+Shift+N");
    expect(win).not.toContain("Win+");

    const unknown = buildGuideNoteBody({ newNoteAccel: "", isMac: false });
    expect(unknown).toContain(ko["note.guide.find-shortcut-unknown"]);
    // 조합을 모를 때 지어낸 기본값을 적지 않는다.
    expect(unknown).not.toContain("Shift+N");
  });

  it("치환되지 않은 플레이스홀더가 남지 않는다", () => {
    const body = buildGuideNoteBody({
      newNoteAccel: "Alt+KeyN",
      isMac: false,
    });
    expect(body).not.toMatch(/\{[^{}]+\}/);
  });

  it("활성 로케일을 따라간다(언어팩이 번역한다)", () => {
    registerLocale("xx", "xx", {
      "note.guide.title": "안내서",
      "note.guide.window-toolbar":
        "{fold}/{transparency}/{pin}/{allDesktops} 눌러 보기",
    });
    setActiveLocale("xx");
    const body = buildGuideNoteBody({ newNoteAccel: "", isMac: true });
    expect(body.split("\n")[0]).toBe("# 안내서");
    expect(body).toContain("눌러 보기");
    // 번역이 없는 줄은 ko로 메워진다(t()의 폴백 체인 — 반쪽 언어팩도 읽을 수 있는 가이드).
    expect(body).toContain(ko["note.guide.outro"]);
  });
});
