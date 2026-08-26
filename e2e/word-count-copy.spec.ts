import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 단어 수 상태 아이템을 눌러 그 문구를 복사하는 경로를 검증한다 — 클릭이 노트 창에서
// 중앙 호스트 샌드박스(onClick)로 갔다가 `clipboard.write` 창-스코프 위임으로 돌아오는
// 전 구간이다. 목은 **네이티브 클립보드 커맨드**를 기록하므로, 이 테스트는 프론트가 실제로
// 네이티브 경로를 타는지도 함께 못박는다(브라우저 `navigator.clipboard`만 쓰던 시절
// Windows 웹뷰에서 조용히 거절돼 "눌러도 아무 일이 없던" 회귀의 가드).
test("단어 수 상태 아이템을 누르면 그 문구가 클립보드에 복사된다", async ({
  page,
  context,
}) => {
  await openPluginHost(context);
  await installTauriMock(page, {
    captureClipboard: true,
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "hello brave new world", meta: { overrides: {} } },
      get_vault_path: "/Users/test/Memo",
      note_list: [],
    },
  });
  await page.goto("/?note=wc-copy");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator("#app").hover();

  const words = page.locator(
    '.note-toolbar-status[data-item-key="plugin:word-count:status:word-count-words"]',
  );
  await expect(words).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
  // note:opened로 실제 개수가 채워질 때까지 기다린다(0 단어 초기값 → 4 단어).
  await expect(words).toContainText("4 단어", { timeout: SNAPSHOT_UI_TIMEOUT });

  await words.click();

  await page.waitForFunction(
    () => (window as unknown as { __clip: string[] }).__clip.length > 0,
    null,
    { timeout: 5000 },
  );
  const clip = await page.evaluate(
    () => (window as unknown as { __clip: string[] }).__clip,
  );
  // 화면에 보이는 문구 그대로(로케일 표기 포함)가 복사된다.
  expect(clip[0]).toBe("4 단어");
});
