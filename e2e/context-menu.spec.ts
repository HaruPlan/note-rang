import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 우클릭 컨텍스트 메뉴가 낮은 창에서도 모든 항목에 닿는지 검증한다.
// (jsdom 가드는 좌표·상한 계산만 본다 — 실제로 스크롤이 생기는지는 레이아웃이 있는 엔진에서만 보인다.)
test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    responses: { note_read: { content: "본문", meta: { overrides: {} } } },
  });
});

test("창이 낮으면 컨텍스트 메뉴가 창 안에서 스크롤된다", async ({ page }) => {
  // 기본 항목(잘라내기·복사·붙여넣기·전체 선택)만으로도 다 못 담는 높이 — 플러그인이 메뉴
  // 항목을 붙이면 훨씬 큰 창에서도 같은 상황이 된다.
  await page.setViewportSize({ width: 420, height: 100 });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".cm-content").click({ button: "right" });

  const menu = page.locator(".plugin-context-menu");
  await expect(menu).toBeVisible();
  // 메뉴 전체가 창 안에 있다(넘치는 부분이 창 밖으로 흘러 잘리지 않는다).
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(3);
  expect(box.y + box.height).toBeLessThanOrEqual(97);
  // 다 못 담은 만큼은 사라지는 게 아니라 메뉴 안에서 스크롤된다.
  const size = await menu.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }));
  expect(size.scroll).toBeGreaterThan(size.client);

  // 키보드로도 닿는다 — ↓로 마지막 항목까지 내려가면 메뉴가 따라 스크롤된다.
  const last = menu.locator(".plugin-context-menu-item").last();
  await page.keyboard.press("ArrowUp");
  await expect(last).toBeFocused();
  const byKey = (await last.boundingBox())!;
  expect(byKey.y + byKey.height).toBeLessThanOrEqual(box.y + box.height + 0.5);

  // 그리고 맨 아래 항목까지 실제로 눌린다(스크롤이 장식이 아니라 도달 수단인지).
  await last.scrollIntoViewIfNeeded();
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.y).toBeGreaterThanOrEqual(box.y - 0.5);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(
    box.y + box.height + 0.5,
  );
  await last.click();
  await expect(menu).toHaveCount(0);
});
