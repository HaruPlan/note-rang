import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 복사하기 번들 플러그인을 WebKit에서 검증한다: 중앙 호스트 샌드박스가 등록한 툴바 버튼이
// 스냅샷으로 노트 툴바에 뜨고, 클릭하면 노트 창→호스트(EV_BUTTON_INVOKE)→샌드박스 onClick
// →창-스코프 위임(notes.current·clipboard.write·ui.toast는 클릭한 노트 창에서 수행)으로
// 현재 노트 절대경로가 담긴 문구가 클립보드에 복사된다 — 콜백 왕복 전 경로를 한 번에 확인.
test.beforeEach(async ({ page, context }) => {
  await openPluginHost(context); // settings.get(문구·위치)은 호스트 로컬에서 응답.
  await installTauriMock(page, {
    captureClipboard: true, // 클립보드 쓰기는 클릭한 노트 창에서 수행된다(창-스코프 위임).
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "메모 본문", meta: { overrides: {} } },
      get_vault_path: "/Users/test/Memo",
    },
  });
  await page.goto("/?note=abc123");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("📋 버튼이 뜨고, 클릭하면 노트 절대경로가 담긴 문구를 클립보드에 복사한다", async ({
  page,
}) => {
  // 기본 배치(`toolbar-layout.ts`의 sharedBottom)가 이 버튼을 하단 바 좌측 존에 둔다.
  // 셀렉터는 툴팁이 아니라 `data-action`(=`pluginItemKey`, 배치 계약의 정본 키)으로 잡는다 —
  // 툴팁은 플러그인이 nls로 번역·개편하는 표시 문자열이라 셀렉터로 삼으면 문구가 바뀔 때마다
  // 깨진다(실제로 "복사하기"→"문구 템플릿으로 복사"로 바뀌어 깨졌다).
  const button = page.locator(
    '.note-toolbar--bottom .note-toolbar-btn[data-action="plugin:copy-ai-prompt:copy-ai-prompt"]',
  );
  // 호스트 스냅샷 적용 후 툴바에 버튼이 등록된다(호버 시 표시).
  await page.locator("#app").hover();
  await expect(button).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });

  await button.click();

  // 클릭 위임 → 호스트 샌드박스 onClick → notes.current + settings.get(기본 템플릿)
  // → clipboard.write(이 창에서 수행).
  await page.waitForFunction(
    () => (window as unknown as { __clip: string[] }).__clip.length > 0,
    null,
    { timeout: 3000 },
  );
  const clip = await page.evaluate(
    () => (window as unknown as { __clip: string[] }).__clip,
  );
  // {path}가 현재 노트의 절대경로(vault/notes/<id>.md)로 치환돼 복사된다.
  expect(clip[0]).toContain("/Users/test/Memo/notes/abc123.md");
});
