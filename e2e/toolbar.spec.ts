import { test, expect, type Page } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 노트 옵션 툴바(호버) 동작을 WebKit에서 검증한다(Tauri IPC 모킹).

/** 공통 노트 응답(제목 헤딩 + 본문 한 줄). */
const NOTE_READ = {
  content: "# 토글 제목\n\n본문 줄.",
  meta: { overrides: {} },
};

test.describe("내장 툴바(플러그인 무관)", () => {
  test.beforeEach(async ({ page }) => {
    // 호스트 없음(ensure_plugin_host 미지정 → null) — 노트는 즉시 플러그인 없이 뜬다.
    await installTauriMock(page, { responses: { note_read: NOTE_READ } });
    await page.goto("/?note=mock");
    await expect(page.locator(".cm-editor")).toBeVisible();
  });

  test("프리뷰 토글 시 렌더↔원문이 전환되고 override가 저장된다", async ({
    page,
  }) => {
    // 프리뷰 on: 헤딩이 렌더(cm-h1).
    await expect(page.locator(".cm-line.cm-h1")).toContainText("토글 제목");

    await page.locator("#app").hover();
    await page.locator('.note-toolbar-btn[title="마크다운 프리뷰"]').click();

    // 프리뷰 off: 원문 `# 토글 제목`이 그대로, cm-h1 없음.
    await expect(page.locator(".cm-content")).toContainText("# 토글 제목");
    await expect(page.locator(".cm-line.cm-h1")).toHaveCount(0);

    const calls = await page.evaluate(
      () => (window as unknown as { __calls: { cmd: string }[] }).__calls,
    );
    expect(calls.some((c) => c.cmd === "note_save_overrides")).toBe(true);
  });

  test("보관 버튼이 note_archive를 호출한다(내용 있는 노트)", async ({
    page,
  }) => {
    await page.locator("#app").hover();
    await page.locator('.note-toolbar-btn[title="닫기(보관)"]').click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
          (c) => c.cmd === "note_archive",
        ),
      null,
      { timeout: 3000 },
    );
  });

  test("삭제는 확인 모달 후에만 note_delete를 호출한다", async ({ page }) => {
    await page.locator("#app").hover();
    await page.locator('.note-toolbar-btn[title="삭제"]').click();

    // 확인 모달이 떠야 하고, 확인을 눌러야 삭제된다.
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator(".confirm-ok").click();

    await page.waitForFunction(
      () =>
        (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
          (c) => c.cmd === "note_delete",
        ),
      null,
      { timeout: 3000 },
    );
  });

  test("배경 스와치 선택 시 노트 배경이 바뀌고 override가 저장된다", async ({
    page,
  }) => {
    await page.locator("#app").hover();
    await page.locator('.note-toolbar-btn[title="배경색"]').click();
    await page.locator(".note-swatch").first().click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
          (c) => c.cmd === "note_save_overrides",
        ),
      null,
      { timeout: 3000 },
    );
    const bg = await page
      .locator("#app")
      .evaluate((el) => (el as HTMLElement).style.background);
    expect(bg).not.toBe("");
  });

  test("빈 노트를 보관하면 삭제로 정리된다", async ({ page }) => {
    // 본문을 모두 지워 빈 노트로 만든다.
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");

    await page.locator("#app").hover();
    await page.locator('.note-toolbar-btn[title="닫기(보관)"]').click();

    // 빈 노트는 보관이 아니라 삭제로 정리되어야 한다.
    await page.waitForFunction(
      () =>
        (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
          (c) => c.cmd === "note_delete",
        ),
      null,
      { timeout: 3000 },
    );
  });

  test("배경 드롭다운은 트리거 클릭으로 열리고 바깥(에디터) 클릭으로 닫힌다", async ({
    page,
  }) => {
    await page.locator("#app").hover();
    const swatchPanel = page.locator(".note-toolbar-swatches");
    await expect(swatchPanel).toBeHidden(); // 호버만으론 안 열림(회귀 가드)

    await page.locator('.note-toolbar-btn[title="배경색"]').click();
    await expect(swatchPanel).toBeVisible();

    // 메뉴 밖(에디터)을 누르면 닫힌다.
    await page.locator(".cm-content").click();
    await expect(swatchPanel).toBeHidden();
  });
});

/**
 * 접히지 않은 상태의 하단 바 콘텐츠 폭(존 inner의 scrollWidth 합)을 잰다 — 창을 충분히 넓혀 둔
 * 뒤에 부를 것(좁으면 이미 접혀 있어 잘린 폭이 나온다).
 *
 * 값이 **연속 두 번 같을 때까지** 기다린다: 플러그인 버튼은 스냅샷으로 하나씩 붙으므로, 도착
 * 중간에 재면 폭을 실제보다 작게 보고 → 그걸 기준으로 잡은 창이 여전히 넓어 "안 접힌다"는
 * 엉뚱한 실패가 된다.
 */
async function bottomBarContentWidth(page: Page): Promise<number> {
  const measure = (): Promise<number> =>
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".note-toolbar--bottom .tb-zone-inner",
        ),
      ).reduce((w, inner) => w + inner.scrollWidth, 0),
    );
  let prev = await measure();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await measure();
    if (now > 0 && now === prev) return now;
    prev = now;
  }
  return prev;
}

test.describe("플러그인 버튼 오버플로(중앙 호스트 스냅샷)", () => {
  test.beforeEach(async ({ page, context }) => {
    // 폰트 플러그인(A−/A+)은 중앙 호스트가 실행하고 버튼 디스크립터가 스냅샷으로 온다.
    await openPluginHost(context);
    await installTauriMock(page, {
      responses: { ensure_plugin_host: true, note_read: NOTE_READ },
    });
    await page.goto("/?note=mock");
    await expect(page.locator(".cm-editor")).toBeVisible();
  });

  test("너비가 좁으면 상단 플러그인 버튼이 존 ⋯로 접히고, 넓으면 인라인으로 펴진다", async ({
    page,
  }) => {
    // 폰트 플러그인 A−/A+는 기본 배치에서 상단 우측 존에 놓인다 — 존별 ⋯ 오버플로로 접힌다.
    // 인라인이면 존 inner 직속 자식, 접히면 ⋯ 패널(.note-toolbar-menu) 자식이 된다(글자 작게로 추적).
    const inline = page.locator(
      '.tb-zone-inner > .note-toolbar-btn[title="글자 작게"]',
    );
    const folded = page.locator(
      '.note-toolbar-menu > .note-toolbar-btn[title="글자 작게"]',
    );

    // 넓은 폭: 플러그인 버튼이 뜰 때까지 기다린다(스냅샷 비동기 적용) → 인라인, 접힘 없음.
    await page.setViewportSize({ width: 1000, height: 400 });
    await expect(inline).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
    await expect(folded).toHaveCount(0);

    // 좁히면 그 존의 버튼이 ⋯ 패널로 접힌다(각 존이 독립으로 접힘).
    await page.setViewportSize({ width: 200, height: 400 });
    await expect(folded).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
    await expect(inline).toHaveCount(0);
  });

  // 하단 바의 ⋯ 패널이 아래로 펼쳐지면 창 밖(#app overflow:hidden)이라 통째로 잘려, 눌러도
  // 아무것도 안 뜨는 것처럼 보였다(사용자 신고) → 하단 바에서는 위로 펼친다.
  test("하단 바의 ⋯ 메뉴는 위로 펼쳐져 창 안에 보인다", async ({ page }) => {
    const H = 320;
    // 넓게 시작한다 — 아무것도 접히지 않은 상태에서 하단 바의 **실제 콘텐츠 폭**을 재기 위해서다.
    await page.setViewportSize({ width: 1000, height: H });
    await page.locator("#app").hover();

    // 전제: 하단 바가 넘치려면 **플러그인 버튼이 먼저 도착**해야 한다. 코어만 있는 상태의
    // 하단 바는 `core:delete` 하나뿐이라 어지간히 좁혀도 안 넘쳐 `⋯`가 영영 안 뜬다. 그래서
    // 스냅샷 도착을 먼저, 그것도 앱의 스냅샷 예산을 덮는 상한으로 기다린다 — 이 단계를
    // 생략하면 스냅샷이 늦은 실행에서 "⋯가 안 보인다"라는, 원인을 가리키지 못하는 실패가 난다.
    await expect(
      page
        .locator(
          '.note-toolbar--bottom .note-toolbar-btn[data-action^="plugin:"]',
        )
        .first(),
    ).toBeAttached({ timeout: SNAPSHOT_UI_TIMEOUT });

    // 접히는 폭은 **상수로 박지 않는다**: 하단 바에 무엇이 놓이는지(기본 배치)와 글자 폭에 따라
    // 임계가 움직인다. 실제로 예전엔 220px이 "좁은 폭"이었지만 보관이 상단으로 옮겨가 하단이
    // 가벼워지자 220px에서 더는 안 넘쳐, 원인을 못 가리키는 타임아웃으로 바뀌었다. 그래서 지금
    // 콘텐츠 폭을 재고 그보다 확실히 좁게 창을 잡는다.
    const bottomContentWidth = await bottomBarContentWidth(page);
    expect(bottomContentWidth).toBeGreaterThan(0); // 아무것도 못 쟀으면 아래 기대가 무의미하다.
    await page.setViewportSize({
      width: Math.max(120, Math.ceil(bottomContentWidth * 0.8)),
      height: H,
    });
    await page.locator("#app").hover();

    // 좁은 폭이라 하단 존이 ⋯로 접힌다.
    const more = page
      .locator(
        '.note-toolbar--bottom .note-toolbar-overflow:not([hidden]) [aria-haspopup="menu"]',
      )
      .first();
    await expect(more).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
    await more.click();

    const panel = page
      .locator(".note-toolbar--bottom .note-toolbar-menu:not([hidden])")
      .first();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".note-toolbar-btn")).not.toHaveCount(0);

    const p = (await panel.boundingBox())!;
    const t = (await more.boundingBox())!;
    // 트리거 위로 펼쳐지고(아래로 펼치면 창 밖), 창 안에 온전히 들어온다.
    expect(p.y + p.height).toBeLessThanOrEqual(t.y + 1);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.height).toBeLessThanOrEqual(H);
  });
});
