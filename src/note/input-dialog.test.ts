import { describe, it, expect, vi } from "vitest";
import { fieldsDialog, inputDialog } from "./input-dialog";

describe("inputDialog", () => {
  /** 가드: 확인 버튼 → trim된 입력값으로 해소되고 오버레이가 정리된다. */
  it("resolves the trimmed value on confirm and cleans up", async () => {
    const host = document.createElement("div");
    const pending = inputDialog(host, "URL을 입력하세요");
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    input.value = "  https://example.com  ";
    input.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    expect(await pending).toBe("https://example.com");
    expect(host.querySelector(".confirm-overlay")).toBeNull();
  });

  /** 가드: 취소 버튼 → null. */
  it("resolves null on cancel", async () => {
    const host = document.createElement("div");
    const pending = inputDialog(host, "URL을 입력하세요");
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    expect(await pending).toBeNull();
  });

  /** 가드: Esc → null(document 캡처 단계에서 듣는다 — plugin-popup.ts의 openPopup과 같은 결). */
  it("resolves null on Escape", async () => {
    const host = document.createElement("div");
    const pending = inputDialog(host, "URL을 입력하세요");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await pending).toBeNull();
  });

  /** 가드: 바깥(오버레이) 클릭 → null. */
  it("resolves null on an outside click", async () => {
    const host = document.createElement("div");
    const pending = inputDialog(host, "URL을 입력하세요");
    const overlay = host.querySelector<HTMLElement>(".confirm-overlay")!;
    overlay.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(await pending).toBeNull();
  });

  /** 가드: 유효한 값에서 Enter는 확인과 같다. */
  it("confirms on Enter when the value is valid", async () => {
    const host = document.createElement("div");
    const pending = inputDialog(host, "URL을 입력하세요", {
      defaultValue: "https://example.com",
    });
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(await pending).toBe("https://example.com");
  });

  /**
   * 가드(핵심): validate가 거짓이면 확인 버튼이 비활성화되고 Enter도 무시된다 — 잘못된 값이
   * 삽입되는 사고를 다이얼로그 층에서 막는다.
   */
  it("disables confirm and ignores Enter while the value fails validate", async () => {
    const host = document.createElement("div");
    const onResolve = vi.fn();
    void inputDialog(host, "URL을 입력하세요", {
      validate: (v) => v.startsWith("https://"),
    }).then(onResolve);
    const input = host.querySelector<HTMLInputElement>(".plugin-popup-input")!;
    const ok = host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!;
    expect(ok.disabled).toBe(true); // 초기값(빈 문자열)부터 이미 무효.

    input.value = "not a url";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(true);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await Promise.resolve();
    expect(onResolve).not.toHaveBeenCalled(); // 아직 열려 있어야 한다.

    input.value = "https://example.com";
    input.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(false);
    ok.click();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledWith("https://example.com");
  });

  /** 가드: confirmLabel·placeholder가 그대로 반영된다. */
  it("reflects confirmLabel and placeholder", () => {
    const host = document.createElement("div");
    void inputDialog(host, "URL을 입력하세요", {
      confirmLabel: "삽입",
      placeholder: "https://example.com",
    });
    expect(host.querySelector(".plugin-popup-ok")!.textContent).toBe("삽입");
    expect(
      host.querySelector<HTMLInputElement>(".plugin-popup-input")!.placeholder,
    ).toBe("https://example.com");
  });
});

describe("fieldsDialog", () => {
  /** 가드(기존 동작): `newRow`를 아무 칸도 안 주면 전부 한 줄에 나란히 놓인다(너비·높이 등). */
  it("puts all fields on one row when none set newRow", () => {
    const host = document.createElement("div");
    void fieldsDialog(host, "크기", [
      { id: "width", label: "너비" },
      { id: "height", label: "높이" },
    ]);
    const rows = host.querySelectorAll(".confirm-fields");
    expect(rows).toHaveLength(1);
    expect(rows[0].className).toContain("confirm-fields--row");
    expect(rows[0].querySelectorAll(".plugin-popup-input")).toHaveLength(2);
  });

  /**
   * 가드(핵심): `newRow: true`인 칸부터 새 가로 줄이 시작된다(이미지 추가의 URL·너비·높이
   * 3필드 — URL은 혼자 제 줄, 너비·높이는 같은 줄).
   */
  it("starts a new row at the field marked newRow", () => {
    const host = document.createElement("div");
    void fieldsDialog(host, "이미지 추가", [
      { id: "url", placeholder: "https://…" },
      { id: "width", label: "너비", newRow: true },
      { id: "height", label: "높이" },
    ]);
    const rows = [...host.querySelectorAll(".confirm-fields")];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).not.toContain("confirm-fields--row"); // URL 혼자.
    expect(rows[0].querySelectorAll(".plugin-popup-input")).toHaveLength(1);
    expect(rows[1].className).toContain("confirm-fields--row"); // 너비+높이.
    expect(rows[1].querySelectorAll(".plugin-popup-input")).toHaveLength(2);
    // DOM 순서가 곧 필드 순서 — 첫 입력이 URL이라 기본 포커스도 URL로 간다.
    const inputs = host.querySelectorAll<HTMLInputElement>(
      ".plugin-popup-input",
    );
    expect(inputs).toHaveLength(3);
  });

  /** 가드: 값 맵은 `{ 필드id: trim된 값 }`로 해소된다(줄 구성과 무관). */
  it("resolves a trimmed value map keyed by field id", async () => {
    const host = document.createElement("div");
    const pending = fieldsDialog(host, "이미지 추가", [
      { id: "url" },
      { id: "width", newRow: true },
      { id: "height" },
    ]);
    const inputs = host.querySelectorAll<HTMLInputElement>(
      ".plugin-popup-input",
    );
    inputs[0].value = "  https://example.com/a.png  ";
    inputs[1].value = "300";
    inputs[2].value = "";
    host.querySelector<HTMLButtonElement>(".plugin-popup-ok")!.click();
    expect(await pending).toEqual({
      url: "https://example.com/a.png",
      width: "300",
      height: "",
    });
  });
});
