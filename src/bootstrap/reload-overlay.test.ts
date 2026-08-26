/**
 * 리로드 스냅샷 쓰기/오버레이 정리(`reload-overlay.ts`)의 규칙 가드.
 *
 * 배선(`bootstrap/note.ts`)은 Tauri 이벤트와 얽혀 있어 여기서는 "무엇을 남기는가"와
 * "실패해도 리로드를 막지 않는가"만 못박는다. 남긴 값을 실제로 **복원하는** 쪽
 * (`public/reload-boot.js`)의 가드는 `reload-boot.test.ts`가 같은 키로 짝을 맞춘다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissReloadOverlay,
  RELOAD_SNAPSHOT_KEY,
  type ReloadSnapshot,
  writeReloadSnapshot,
} from "./reload-overlay";

/** 노트 창의 `#app`을 흉내 낸 호스트(테마 인라인 변수는 `<html>`에 따로 얹는다). */
function noteHost(): HTMLElement {
  const host = document.createElement("main");
  host.id = "app";
  host.style.background = "#20242c";
  document.body.append(host);
  return host;
}

/** 방금 쓴 스냅샷을 읽어 파싱한다(없으면 테스트 실패). */
function readSnapshot(): ReloadSnapshot {
  const raw = sessionStorage.getItem(RELOAD_SNAPSHOT_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as ReloadSnapshot;
}

afterEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  document.documentElement.style.cssText = "";
  vi.restoreAllMocks();
});

describe("writeReloadSnapshot", () => {
  /** 가드: 리로드 뒤 화면을 그대로 되돌리는 데 필요한 네 가지(테마·배경·글자색·접힘)를 담는다. */
  it("captures the theme cssText, background, collapse state and message", () => {
    document.documentElement.style.setProperty("--memo-accent", "#37506a");
    const host = noteHost();

    writeReloadSnapshot(host, "설정 적용 중…", 1_700_000_000_000);

    const snap = readSnapshot();
    expect(snap.v).toBe(1);
    expect(snap.at).toBe(1_700_000_000_000);
    expect(snap.reason).toBe("host-updated");
    expect(snap.themeCss).toContain("--memo-accent");
    expect(snap.themeCss).toContain("#37506a");
    expect(snap.appBg).toBe(host.style.background);
    expect(snap.collapsed).toBe(false);
    expect(snap.message).toBe("설정 적용 중…");
  });

  /** 가드: 접힘 상태가 실려야 부트 스크립트가 문구를 띄울지(자리가 있는지) 판단할 수 있다. */
  it("records the collapsed state", () => {
    const host = noteHost();
    host.classList.add("note-collapsed");

    writeReloadSnapshot(host, "설정 적용 중…");

    expect(readSnapshot().collapsed).toBe(true);
  });

  /** 가드: 인라인 배경이 아직 없으면(마운트 도중 리로드) 계산값으로 떨어진다 — 빈 값을 남겨
   * 부트 스크립트가 통째로 포기하게 두지 않는다. */
  it("falls back to the computed background when no inline value is set", () => {
    const host = noteHost();
    host.style.background = "";
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      backgroundColor: "rgb(253, 246, 227)",
      color: "rgb(31, 35, 40)",
    } as unknown as CSSStyleDeclaration);

    writeReloadSnapshot(host, "설정 적용 중…");

    const snap = readSnapshot();
    expect(snap.appBg).toBe("rgb(253, 246, 227)");
    expect(snap.textColor).toBe("rgb(31, 35, 40)");
  });

  /** 가드(핵심): sessionStorage가 던져도 **던지지 않는다** — 여기서 예외가 새면 호출부의
   * `window.location.reload()`가 실행되지 않아 창이 옛 설정에 굳는다(깜빡임보다 나쁘다). */
  it("never throws when sessionStorage is unavailable", () => {
    const host = noteHost();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => writeReloadSnapshot(host, "설정 적용 중…")).not.toThrow();
  });
});

describe("dismissReloadOverlay", () => {
  /** 가드: 부트 스크립트가 만든 오버레이를 id로 찾아 지운다(전역 함수 공유 없음). */
  it("removes the overlay element", () => {
    const overlay = document.createElement("div");
    overlay.id = "memo-reload-overlay";
    document.body.append(overlay);

    dismissReloadOverlay();

    expect(document.getElementById("memo-reload-overlay")).toBeNull();
  });

  /** 가드: 오버레이가 없는 첫 로드에서도 조용히 no-op이다. */
  it("is a no-op when there is no overlay", () => {
    expect(() => dismissReloadOverlay()).not.toThrow();
  });
});
