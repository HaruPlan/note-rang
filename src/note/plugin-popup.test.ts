/**
 * 노트 창 오버레이 UI 가드 — 목록 선택/입력 폼/컨텍스트 메뉴가 값·null을 정확히 1회
 * 돌려주고 DOM을 정리한다.
 */
import { describe, it, expect } from "vitest";
import {
  contextMenuPopup,
  DEFAULT_PICK_ACTION,
  pickListPopup,
  promptPopup,
} from "./plugin-popup";

/** 새 host 하나를 document에 붙여 돌려준다(테스트마다 격리). */
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

describe("pickListPopup", () => {
  /** 가드: 클릭한 항목 id + 기본 액션으로 resolve하고 오버레이를 정리한다. */
  it("resolves with the clicked item id and cleans up the DOM", async () => {
    const host = makeHost();
    const p = pickListPopup(host, {
      title: "고르기",
      items: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const items =
      host.querySelectorAll<HTMLButtonElement>(".plugin-popup-item");
    expect(items).toHaveLength(2);
    items[1].click();
    await expect(p).resolves.toEqual({
      itemId: "b",
      actionId: DEFAULT_PICK_ACTION,
    });
    expect(host.querySelector(".plugin-popup-overlay")).toBeNull();
  });

  /** 가드: 부제는 라벨과 다른 요소로 들어가고 텍스트 노드로만 채워진다. */
  it("renders a sublabel as its own text node", () => {
    const host = makeHost();
    void pickListPopup(host, {
      title: "고르기",
      placeholder: "안내",
      items: [{ id: "a", label: "A", sublabel: "<b>경로</b>" }],
    });
    const sub = host.querySelector(".plugin-popup-sublabel")!;
    expect(sub.textContent).toBe("<b>경로</b>");
    expect(sub.querySelector("b")).toBeNull();
    expect(host.querySelector(".plugin-popup-hint")!.textContent).toBe("안내");
  });

  /** 가드: 항목별 액션은 각자 버튼이 되고, 고른 액션 id가 함께 온다. */
  it("resolves with the chosen per-item action", async () => {
    const host = makeHost();
    const p = pickListPopup(host, {
      title: "고르기",
      items: [
        {
          id: "a",
          label: "A",
          actions: [
            { id: "insert", label: "삽입" },
            { id: "delete", label: "삭제", style: "destructive" },
          ],
        },
      ],
    });
    const actions = host.querySelectorAll<HTMLButtonElement>(
      ".plugin-popup-action",
    );
    expect(actions).toHaveLength(2);
    expect(actions[1].className).toContain("plugin-popup-action--danger");
    actions[1].click();
    await expect(p).resolves.toEqual({ itemId: "a", actionId: "delete" });
  });

  /** 가드: Esc면 null. */
  it("resolves null on Escape", async () => {
    const host = makeHost();
    const p = pickListPopup(host, {
      title: "",
      items: [{ id: "a", label: "A" }],
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeNull();
    expect(host.querySelector(".plugin-popup-overlay")).toBeNull();
  });

  /** 가드: 바깥(오버레이) 클릭이면 null. */
  it("resolves null when the backdrop is clicked", async () => {
    const host = makeHost();
    const p = pickListPopup(host, {
      title: "",
      items: [{ id: "a", label: "A" }],
    });
    const overlay = host.querySelector<HTMLElement>(".plugin-popup-overlay")!;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });
});

describe("promptPopup", () => {
  /** 가드: 확인 버튼이면 입력값을 돌려준다(기본값 선반영). */
  it("resolves with the input value on 확인", async () => {
    const host = makeHost();
    const p = promptPopup(host, {
      title: "이름",
      placeholder: "예: 주간회의",
      default: "초기",
    });
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    expect(input.value).toBe("초기");
    input.value = "주간회의";
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await expect(p).resolves.toBe("주간회의");
    expect(host.querySelector(".plugin-popup-overlay")).toBeNull();
  });

  /** 가드: 취소면 null. */
  it("resolves null on 취소", async () => {
    const host = makeHost();
    const p = promptPopup(host, { title: "이름" });
    host.querySelector<HTMLButtonElement>(".plugin-popup-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  /** 가드: 입력창에서 Enter면 그 값을 돌려준다. */
  it("resolves with the value on Enter", async () => {
    const host = makeHost();
    const p = promptPopup(host, { title: "이름" });
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    input.value = "엔터값";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await expect(p).resolves.toBe("엔터값");
  });

  /** 가드: 필드를 주면 타입별 위젯을 그리고 값 맵을 돌려준다. */
  it("renders declared fields and resolves a value map", async () => {
    const host = makeHost();
    const p = promptPopup(host, {
      title: "새 템플릿",
      submitLabel: "만들기",
      fields: [
        { id: "name", label: "이름", type: "text", default: "주간회의" },
        { id: "body", label: "본문", type: "textarea" },
        { id: "pin", label: "고정", type: "toggle", default: true },
        {
          id: "kind",
          label: "종류",
          type: "select",
          options: ["회의", { value: "todo", label: "할 일" }],
          default: "todo",
        },
        { id: "count", label: "개수", type: "number", default: 3, min: 1 },
      ],
    });
    expect(host.querySelectorAll(".plugin-popup-field")).toHaveLength(5);
    expect(
      host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.textContent,
    ).toBe("만들기");
    const area = host.querySelector<HTMLTextAreaElement>(
      ".plugin-popup-textarea",
    )!;
    area.value = "본문 내용";
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("todo");
    expect(select.options[1].textContent).toBe("할 일");
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await expect(p).resolves.toEqual({
      name: "주간회의",
      body: "본문 내용",
      pin: true,
      kind: "todo",
      count: 3,
    });
  });

  /** 가드: number 필드에 비수치가 남아도 NaN이 아니라 0으로 굳는다. */
  it("coerces a non-numeric number field to 0", async () => {
    const host = makeHost();
    const p = promptPopup(host, {
      title: "수",
      fields: [{ id: "n", label: "수", type: "number" }],
    });
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    await expect(p).resolves.toEqual({ n: 0 });
  });

  /** 가드: 필드가 빈 배열이면 폼이 아니라 한 줄 입력으로 떨어진다. */
  it("falls back to the single-line prompt when fields is empty", async () => {
    const host = makeHost();
    const p = promptPopup(host, { title: "이름", fields: [] });
    expect(host.querySelector(".plugin-popup-form")).toBeNull();
    host.querySelector<HTMLButtonElement>(".plugin-popup-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });
});

describe("contextMenuPopup", () => {
  /** 가드: 구역 사이에 구분선이 들어가고, 고른 항목 id로 resolve한다. */
  it("renders groups with separators and resolves the clicked id", async () => {
    const host = makeHost();
    const p = contextMenuPopup(host, 12, 34, [
      [
        { id: "edit:copy", label: "복사", disabled: true },
        { id: "edit:paste", label: "붙여넣기" },
      ],
      [{ id: "plugin:x:y", label: "템플릿 삽입" }],
    ]);
    const box = host.querySelector<HTMLElement>(".plugin-context-menu")!;
    expect(box.style.left).toBe("12px");
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(1);
    const items = host.querySelectorAll<HTMLButtonElement>(
      ".plugin-context-menu-item",
    );
    expect(items[0].disabled).toBe(true);
    items[2].click();
    await expect(p).resolves.toBe("plugin:x:y");
    expect(host.querySelector(".plugin-popup-overlay")).toBeNull();
  });

  /** 가드: 빈 구역은 구분선을 남기지 않는다(플러그인이 하나도 없을 때 꼬리 선 방지). */
  it("drops empty groups entirely", () => {
    const host = makeHost();
    void contextMenuPopup(host, 0, 0, [[{ id: "a", label: "A" }], []]);
    expect(host.querySelectorAll(".plugin-context-menu-sep")).toHaveLength(0);
  });

  /** 가드: Esc면 null. */
  it("resolves null on Escape", async () => {
    const host = makeHost();
    const p = contextMenuPopup(host, 0, 0, [[{ id: "a", label: "A" }]]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBeNull();
  });

  /**
   * 가드(회귀): 뷰포트 클램핑은 **DOM 부착 후 실측 크기**로 계산한다.
   *
   * 부착 전에 측정하면 offsetWidth/Height가 항상 0이라(레이아웃 전) 실제 브라우저에서도
   * 가로는 폴백 추정치, 세로는 클램프 생략으로 떨어져 — 작은 스티키 창의 아래·오른쪽
   * 가장자리 근처에서 우클릭하면 메뉴가 창 밖으로 잘려 항목을 누를 수 없었다. jsdom은
   * 레이아웃이 없어 "부착된 뒤에만 크기가 잡히는" 실제 브라우저를 프로토타입 게터로 흉내 낸다.
   */
  it("clamps the menu into the viewport using post-attach measurements", async () => {
    const host = makeHost();
    const widthDesc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    const heightDesc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.isConnected ? 200 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.isConnected ? 150 : 0;
      },
    });
    try {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const p = contextMenuPopup(host, vw - 10, vh - 10, [
        [{ id: "a", label: "A" }],
      ]);
      const box = host.querySelector<HTMLElement>(".plugin-context-menu")!;
      expect(box.style.left).toBe(`${vw - 200 - 4}px`);
      expect(box.style.top).toBe(`${vh - 150 - 4}px`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await expect(p).resolves.toBeNull();
    } finally {
      if (widthDesc) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDesc);
      }
      if (heightDesc) {
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetHeight",
          heightDesc,
        );
      }
    }
  });

  /**
   * 가드(회귀): 창이 낮아 항목이 다 안 들어가면 메뉴를 창 높이로 접고 **안에서 스크롤**시킨다.
   *
   * 상한을 걸지 않으면 넘치는 항목이 창 밖으로 흘러 누를 수 없었다(잘려서 보이지도 않는다).
   * jsdom은 레이아웃이 없어 "max-height까지만 커지는" 실제 배치를 프로토타입 게터로 흉내 낸다.
   */
  it("caps the menu to the window height so overflow scrolls inside", async () => {
    const host = makeHost();
    const heightDesc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    const NATURAL = 2000;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.isConnected) return 0;
        const cap = Number.parseFloat(this.style.maxHeight);
        return Number.isFinite(cap) ? Math.min(NATURAL, cap) : NATURAL;
      },
    });
    try {
      const vh = window.innerHeight;
      const p = contextMenuPopup(host, 0, 0, [
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      ]);
      const box = host.querySelector<HTMLElement>(".plugin-context-menu")!;
      expect(box.style.maxHeight).toBe(`${vh - 8}px`);
      // 상한만큼 커졌으니 위아래 여백 4px만 남는다 — 창 밖으로 삐져나가지 않는다.
      expect(box.style.top).toBe("4px");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await expect(p).resolves.toBeNull();
    } finally {
      if (heightDesc) {
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetHeight",
          heightDesc,
        );
      }
    }
  });
});
