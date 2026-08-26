import { describe, it, expect } from "vitest";
import {
  eventToAccel,
  eventToTauriAccel,
  hasModifier,
  formatAccelLabel,
  findConflicts,
  resolveShortcut,
} from "./accel";

/** 함수가 읽는 필드만 담은 KeyboardEvent 스텁(결정적 테스트). */
function ev(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    code: "",
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("eventToAccel (창 단위)", () => {
  it("Alt+= 는 물리 키 Equal로 표기(문자 변환 무관)", () => {
    expect(eventToAccel(ev({ code: "Equal", altKey: true }), true)).toBe(
      "Alt+Equal",
    );
  });

  it("mac에선 metaKey가 Mod로, 순서는 Mod→Shift→키", () => {
    expect(
      eventToAccel(ev({ code: "KeyP", metaKey: true, shiftKey: true }), true),
    ).toBe("Mod+Shift+KeyP");
  });

  it("非mac에선 ctrlKey가 Mod, metaKey는 Meta", () => {
    expect(eventToAccel(ev({ code: "KeyP", ctrlKey: true }), false)).toBe(
      "Mod+KeyP",
    );
    expect(eventToAccel(ev({ code: "KeyK", metaKey: true }), false)).toBe(
      "Meta+KeyK",
    );
  });

  it("mac에서 ctrlKey는 Ctrl(별개 수식키)", () => {
    expect(
      eventToAccel(ev({ code: "KeyA", metaKey: true, ctrlKey: true }), true),
    ).toBe("Mod+Ctrl+KeyA");
  });

  it("수식키 단독(메인 키 없음)이면 null", () => {
    expect(eventToAccel(ev({ code: "ShiftLeft", shiftKey: true }), true)).toBe(
      null,
    );
    expect(eventToAccel(ev({ code: "", altKey: true }), true)).toBe(null);
  });

  it("수식키 없는 메인 키도 accel은 만들되(호출부가 hasModifier로 거부)", () => {
    expect(eventToAccel(ev({ code: "KeyP" }), true)).toBe("KeyP");
  });
});

describe("eventToTauriAccel (전역)", () => {
  it("실제 물리 수식키 그대로(meta→Super) + event.code", () => {
    expect(
      eventToTauriAccel(ev({ code: "KeyN", metaKey: true, shiftKey: true })),
    ).toBe("Super+Shift+KeyN");
    expect(eventToTauriAccel(ev({ code: "Equal", altKey: true }))).toBe(
      "Alt+Equal",
    );
  });

  it("전역은 수식키 필수 — 수식키 없으면 null", () => {
    expect(eventToTauriAccel(ev({ code: "KeyN" }))).toBe(null);
  });

  it("수식키 단독이면 null", () => {
    expect(eventToTauriAccel(ev({ code: "MetaLeft", metaKey: true }))).toBe(
      null,
    );
  });
});

describe("hasModifier", () => {
  it("창 단위·전역 표기 모두 수식키를 인식", () => {
    expect(hasModifier("Alt+Equal")).toBe(true);
    expect(hasModifier("Mod+Shift+KeyP")).toBe(true);
    expect(hasModifier("Super+KeyN")).toBe(true);
    expect(hasModifier("KeyP")).toBe(false);
  });
});

describe("formatAccelLabel", () => {
  it("mac은 글리프를 붙여서", () => {
    expect(formatAccelLabel("Alt+Equal", true)).toBe("⌥=");
    expect(formatAccelLabel("Mod+Shift+KeyP", true)).toBe("⌘⇧P");
    expect(formatAccelLabel("Super+Shift+KeyN", true)).toBe("⌘⇧N");
    expect(formatAccelLabel("Mod+Digit1", true)).toBe("⌘1");
  });

  it("非mac은 +로 잇고 텍스트 수식키", () => {
    expect(formatAccelLabel("Mod+Shift+KeyP", false)).toBe("Ctrl+Shift+P");
    expect(formatAccelLabel("Alt+Minus", false)).toBe("Alt+-");
  });

  // 가드: 기본 전역 단축키의 `CmdOrCtrl`은 "이 OS의 주 수식키"라 非mac에서 Ctrl이다.
  // 예전엔 Super/Command와 한 묶음이라 Windows에서 `Win+Shift+N`으로 보였다 — 그 조합은
  // 실제로 눌러도 아무 일이 없어, 설정 화면과 시작 가이드가 틀린 키를 안내했다.
  it("CmdOrCtrl은 mac ⌘ / 그 외 Ctrl", () => {
    expect(formatAccelLabel("CmdOrCtrl+Shift+N", true)).toBe("⌘⇧N");
    expect(formatAccelLabel("CmdOrCtrl+Shift+N", false)).toBe("Ctrl+Shift+N");
    expect(formatAccelLabel("CommandOrControl+KeyJ", false)).toBe("Ctrl+J");
    // Super/Command는 그대로 OS 키다(mac ⌘ / 그 외 Win).
    expect(formatAccelLabel("Super+Shift+KeyN", false)).toBe("Win+Shift+N");
  });

  it("빈 문자열은 빈 라벨", () => {
    expect(formatAccelLabel("", true)).toBe("");
  });
});

describe("resolveShortcut", () => {
  const bindings = { "zoom-in": "Alt+Equal", "toggle-pin": "Mod+Shift+KeyP" };

  it("눌린 조합에 바인딩된 동작 id를 돌려준다", () => {
    expect(
      resolveShortcut(bindings, ev({ code: "Equal", altKey: true }), true),
    ).toBe("zoom-in");
    expect(
      resolveShortcut(
        bindings,
        ev({ code: "KeyP", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe("toggle-pin");
  });

  it("바인딩 없는 조합·수식키 단독은 null", () => {
    expect(
      resolveShortcut(bindings, ev({ code: "KeyX", altKey: true }), true),
    ).toBe(null);
    expect(
      resolveShortcut(
        bindings,
        ev({ code: "ShiftLeft", shiftKey: true }),
        true,
      ),
    ).toBe(null);
  });
});

describe("findConflicts", () => {
  it("같은 accel을 2개 이상 동작이 쓰면 충돌로 묶는다", () => {
    const c = findConflicts({
      "zoom-in": "Alt+Equal",
      dup: "Alt+Equal",
      "zoom-out": "Alt+Minus",
    });
    expect(c).toEqual({ "Alt+Equal": ["zoom-in", "dup"] });
  });

  it("빈 값은 충돌에서 제외", () => {
    expect(findConflicts({ a: "", b: "" })).toEqual({});
  });
});
