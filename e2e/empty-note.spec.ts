import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 빈 노트가 reload 후에도 "배경색만" 보이지 않고 에디터 + 입력 힌트(placeholder)를
// 보여주는지 검증한다(사용자 보고: 우클릭 reload 시 빈 메모가 배경색만 뜸).
test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    responses: { note_read: { content: "", meta: { overrides: {} } } },
  });
  await page.goto("/?note=empty");
});

test("빈 노트는 에디터 + 입력 힌트를 보여준다(배경색만 아님)", async ({
  page,
}) => {
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".cm-placeholder")).toHaveText(
    "메모를 입력하세요…",
  );
});

test("reload 후에도 빈 노트가 에디터 + 힌트로 보인다", async ({ page }) => {
  await expect(page.locator(".cm-editor")).toBeVisible();

  await page.reload();

  // 핵심: reload 후에도 에디터가 마운트되고(throw로 사라지지 않음) 힌트가 보인다.
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".cm-placeholder")).toBeVisible();
});
