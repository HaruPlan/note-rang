import { describe, it, expect } from "vitest";
import { choiceDialog, confirmDialog } from "./confirm-dialog";

describe("confirmDialog", () => {
  /** 가드: 확인 버튼 → true로 해소되고 오버레이가 정리된다. */
  it("resolves true on confirm and cleans up", async () => {
    const host = document.createElement("div");
    const pending = confirmDialog(host, "삭제할까요?", "삭제");
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    expect(await pending).toBe(true);
    expect(host.querySelector(".confirm-overlay")).toBeNull();
  });

  /** 가드: 취소 버튼 → false. */
  it("resolves false on cancel", async () => {
    const host = document.createElement("div");
    const pending = confirmDialog(host, "삭제할까요?");
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    expect(await pending).toBe(false);
  });

  /** 가드: confirmLabel이 확인 버튼 라벨에 반영된다. */
  it("uses the given confirm label", () => {
    const host = document.createElement("div");
    void confirmDialog(host, "지울까요?", "삭제");
    expect(host.querySelector(".confirm-ok")!.textContent).toBe("삭제");
  });

  /** 가드: alert 모드면 취소 버튼 없이 확인만 두는 단순 안내 다이얼로그가 된다. */
  it("omits the cancel button in alert mode", () => {
    const host = document.createElement("div");
    void confirmDialog(host, "되돌릴 설정이 없어요.", "확인", { alert: true });
    expect(host.querySelector(".confirm-ok")).not.toBeNull();
    expect(host.querySelector(".confirm-cancel")).toBeNull();
  });

  /**
   * 가드(회귀): 확인 모드의 기본 포커스는 **취소**다 — 실행(파괴) 버튼이 자동 포커스되면
   * 반사적 Enter가 숙고 없이 파괴를 확정해 확인 팝업의 존재 이유가 무효화된다. 메모 창의
   * destructive 명령 확인과 설정 버튼 confirm 경로가 반대 안전 기본값을 갖지 않게 한다.
   */
  it("focuses cancel by default so a reflexive Enter does not confirm", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const pending = confirmDialog(host, "영구 삭제할까요?", "삭제");
      expect(document.activeElement).toBe(
        host.querySelector(".confirm-cancel"),
      );
      // 포커스된 버튼의 Enter는 click으로 떨어진다 — 취소(false)여야 한다.
      host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
      expect(await pending).toBe(false);
    } finally {
      host.remove();
    }
  });

  /** 가드: 취소 버튼이 없는 alert 모드만 확인 버튼이 기본 포커스를 받는다. */
  it("focuses the ok button in alert mode where it is the only action", () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      void confirmDialog(host, "되돌릴 설정이 없어요.", "확인", {
        alert: true,
      });
      expect(document.activeElement).toBe(host.querySelector(".confirm-ok"));
    } finally {
      host.remove();
    }
  });
});

describe("choiceDialog", () => {
  /** 저장 폴더 이전(이슈 #21)이 실제로 쓰는 모양의 선택지 두 벌. */
  const CHOICES = [
    { label: "이동하지 않고 전환", value: "link" as const },
    { label: "파일을 함께 이동", value: "move" as const },
  ];

  /** 가드: 고른 선택지의 값으로 해소되고 오버레이가 정리된다. */
  it("resolves the chosen value and cleans up", async () => {
    const host = document.createElement("div");
    const pending = choiceDialog(host, "함께 옮길까요?", CHOICES);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((b) => b.textContent === "파일을 함께 이동")!.click();
    expect(await pending).toBe("move");
    expect(host.querySelector(".confirm-overlay")).toBeNull();
  });

  /** 가드: 취소 버튼 → null(선택 값과 타입으로 구분된다). */
  it("resolves null on cancel", async () => {
    const host = document.createElement("div");
    const pending = choiceDialog(host, "함께 옮길까요?", CHOICES);
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    expect(await pending).toBeNull();
  });

  /** 가드: 오버레이 바깥 클릭도 취소(null)다 — confirmDialog와 같은 관례. */
  it("treats an outside click as cancel", async () => {
    const host = document.createElement("div");
    const pending = choiceDialog(host, "함께 옮길까요?", CHOICES);
    const overlay = host.querySelector<HTMLElement>(".confirm-overlay")!;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(await pending).toBeNull();
  });

  /**
   * 가드(회귀 방지): 선택지가 셋이어도 기본 포커스는 **취소**다 — 되돌리기 어려운 쪽
   * (파일 이동)이 반사적 Enter로 확정되면 안 된다(confirmDialog와 같은 안전 기본값).
   */
  it("focuses cancel so a reflexive Enter picks nothing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      void choiceDialog(host, "함께 옮길까요?", CHOICES);
      expect(document.activeElement).toBe(
        host.querySelector(".confirm-cancel"),
      );
    } finally {
      host.remove();
    }
  });
});
