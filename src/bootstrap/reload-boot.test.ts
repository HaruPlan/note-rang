/**
 * 첫 페인트 전 복원 스크립트(`public/reload-boot.js`)의 규칙 가드.
 *
 * 이 파일은 번들 밖(동기 클래식 스크립트)이라 import할 수 없다 — 소스를 읽어 jsdom의 전역
 * 위에서 그대로 실행해, 실제 문서에서 벌어지는 일(테마 cssText 복원·`#app` 배경·오버레이
 * 생성·스냅샷 1회 소비)을 검사한다.
 *
 * 가장 중요한 가드는 **첫 로드(스냅샷 없음)에서 아무 것도 하지 않는다**는 것이다: 이 장치는
 * 순전히 리로드 미관용이고, 정상 기동 경로를 한 톨도 건드려서는 안 된다.
 *
 * 키·필드 이름은 `reload-overlay.ts`에서 그대로 가져온다 — 두 파일이 갈라지면 여기서 깨진다.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELOAD_SNAPSHOT_KEY, type ReloadSnapshot } from "./reload-overlay";

/** `public/reload-boot.js` 원문 — 리포 루트 기준(vitest의 cwd). */
const SOURCE = readFileSync("public/reload-boot.js", "utf8");

const OVERLAY_ID = "memo-reload-overlay";

/** 부트 스크립트를 지금 문서 위에서 한 번 실행한다(브라우저의 동기 <script> 평가와 같은 효과). */
function runBootScript(): void {
  new Function(SOURCE)();
}

/** 노트 창이 리로드 직전에 남겼을 법한 정상 스냅샷. */
function snapshot(overrides: Partial<ReloadSnapshot> = {}): ReloadSnapshot {
  return {
    v: 1,
    at: Date.now(),
    reason: "host-updated",
    themeCss: "--memo-accent: #37506a; --memo-danger: #c0392b;",
    appBg: "rgb(32, 36, 44)",
    textColor: "rgb(237, 237, 237)",
    collapsed: false,
    message: "설정 적용 중…",
    ...overrides,
  };
}

/** 스냅샷을 sessionStorage에 심는다(`writeReloadSnapshot`이 하는 일의 최소 재현). */
function seed(snap: unknown): void {
  sessionStorage.setItem(
    RELOAD_SNAPSHOT_KEY,
    typeof snap === "string" ? snap : JSON.stringify(snap),
  );
}

/** 이 문서를 `?note=<id>` 창으로 만든다(부트 스크립트의 유일한 진입 조건). */
function asNoteWindow(): void {
  history.replaceState({}, "", "/?note=abc123");
}

beforeEach(() => {
  // Date.now()를 고정해 스냅샷 나이 판정을 결정론적으로 만들고, 부트 스크립트가 거는 상한
  // 타이머(10초)가 테스트 사이에 남지 않게 한다.
  vi.useFakeTimers();
  document.body.innerHTML = '<main id="app"></main>';
  document.documentElement.style.cssText = "";
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  history.replaceState({}, "", "/");
  document.body.innerHTML = "";
  document.documentElement.style.cssText = "";
});

describe("public/reload-boot.js", () => {
  /** 가드(핵심): 노트 창이 아니면 스냅샷을 **소비조차 하지 않는다** — 설정·패널 창이 지나가며
   * 노트 창의 스냅샷을 먹어 치우면 정작 노트 창이 복원할 것을 잃는다. */
  it("does nothing and consumes nothing outside a note window", () => {
    seed(snapshot());

    runBootScript();

    expect(sessionStorage.getItem(RELOAD_SNAPSHOT_KEY)).not.toBeNull();
    expect(document.documentElement.style.cssText).toBe("");
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  /** 가드(핵심): 첫 로드(스냅샷 없음)는 지금까지와 완전히 같다 — 문서를 건드리지 않는다. */
  it("does nothing on a first load with no snapshot", () => {
    asNoteWindow();

    runBootScript();

    expect(document.documentElement.style.cssText).toBe("");
    expect(document.getElementById("app")!.style.background).toBe("");
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  /** 가드: 정상 스냅샷이면 테마 인라인 변수·노트 배경을 되돌리고 안내 문구를 붙인 뒤, 스냅샷을
   * 소비한다(1회용 — 다음 로드에 옛 색이 되살아나지 않는다). */
  it("restores theme, background and overlay, then consumes the snapshot", () => {
    asNoteWindow();
    seed(snapshot());

    runBootScript();

    expect(
      document.documentElement.style.getPropertyValue("--memo-accent").trim(),
    ).toBe("#37506a");
    expect(document.getElementById("app")!.style.background).toBe(
      "rgb(32, 36, 44)",
    );
    const overlay = document.getElementById(OVERLAY_ID);
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toBe("설정 적용 중…");
    expect(overlay!.getAttribute("aria-live")).toBe("polite");
    expect(overlay!.parentElement).toBe(document.body);
    expect(sessionStorage.getItem(RELOAD_SNAPSHOT_KEY)).toBeNull();
  });

  /** 가드: 문구 색은 스냅샷의 값(직전 화면의 대비색)을 인라인으로 받는다 — 배경만 되돌리고
   * 글자색을 기본값에 맡기면 어두운 노트에서 문구가 안 보인다. */
  it("colors the message with the snapshot's text color", () => {
    asNoteWindow();
    seed(snapshot());

    runBootScript();

    const label = document.querySelector(`#${OVERLAY_ID} span`);
    expect((label as HTMLElement).style.color).toBe("rgb(237, 237, 237)");
  });

  /** 가드: 오래된 스냅샷(≥10초)은 리로드가 아니라 "나중에 다시 연 창"이다 — 무시하되 소비는
   * 한다(다음 로드에 또 걸리지 않게). */
  it("ignores (but consumes) a stale snapshot", () => {
    asNoteWindow();
    seed(snapshot({ at: Date.now() - 20_000 }));

    runBootScript();

    expect(document.documentElement.style.cssText).toBe("");
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(sessionStorage.getItem(RELOAD_SNAPSHOT_KEY)).toBeNull();
  });

  /** 가드: 접힌 창은 배경·접힘 클래스만 되돌리고 문구는 띄우지 않는다(헤더 36px에 자리가 없다). */
  it("restores a collapsed window without an overlay", () => {
    asNoteWindow();
    seed(snapshot({ collapsed: true }));

    runBootScript();

    const app = document.getElementById("app")!;
    expect(app.style.background).toBe("rgb(32, 36, 44)");
    expect(app.classList.contains("note-collapsed")).toBe(true);
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  /** 가드: 필드가 어긋난 스냅샷(포맷 버전 불일치)은 반쯤 적용하지 않고 통째로 버린다. */
  it("ignores a snapshot with a mismatched format version", () => {
    asNoteWindow();
    seed(snapshot({ v: 2 as unknown as 1 }));

    runBootScript();

    expect(document.documentElement.style.cssText).toBe("");
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  /** 가드: 깨진 JSON에도 던지지 않는다(예외가 새면 그 뒤 `/src/main.ts`가 못 돈다). */
  it("survives a corrupted snapshot", () => {
    asNoteWindow();
    seed("{not json");

    expect(() => runBootScript()).not.toThrow();
    expect(document.documentElement.style.cssText).toBe("");
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(sessionStorage.getItem(RELOAD_SNAPSHOT_KEY)).toBeNull();
  });

  /** 가드: 마운트가 끝나지 않아도 상한(10초)에 문구가 스스로 걷힌다 — 오류 화면을 덮은 채
   * 남으면 사용자는 멈춘 창을 "적용 중"으로 오해한다. */
  it("dismisses the overlay by itself after the safety timeout", () => {
    asNoteWindow();
    seed(snapshot());
    runBootScript();
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

    vi.advanceTimersByTime(10_000);

    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });
});
