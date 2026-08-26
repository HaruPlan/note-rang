import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 복제 번들 플러그인을 WebKit에서 검증한다: 중앙 호스트 샌드박스가 등록한 ⧉ 버튼이 노트 툴바에
// 뜨고(회귀 가드 — settings 권한 누락으로 버튼이 안 뜨던 버그), 클릭하면 note_duplicate로 새
// 노트를 만든 뒤 그 id로 summon_note(새 창 소환)까지 이어진다.
test.beforeEach(async ({ page, context }) => {
  await openPluginHost(context); // settings.get(위치)은 호스트 로컬에서 응답.
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "복제할 메모", meta: { overrides: {} } },
      note_duplicate: "dup-new-id",
    },
  });
  await page.goto("/?note=src-note");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("⧉ 복제 버튼이 뜨고, 클릭하면 note_duplicate 후 새 노트를 소환한다", async ({
  page,
}) => {
  await page.locator("#app").hover();
  const button = page.locator('.note-toolbar-btn[title^="메모 복제"]');
  // 호스트 스냅샷 적용 후 툴바에 버튼이 등록된다(호버 시 표시).
  await expect(button).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });

  await button.click();

  // 클릭 위임 → 호스트 샌드박스 onClick → memo.notes.duplicate() → note-window가
  // note_duplicate IPC 호출 → 반환된 새 id로 summon_note(새 창 열기).
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some((c) => c.cmd === "note_duplicate"),
    null,
    { timeout: 3000 },
  );
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls,
  );
  const dup = calls.find((c) => c.cmd === "note_duplicate");
  expect(dup!.args.id).toBe("src-note");
  const summon = calls.find((c) => c.cmd === "summon_note");
  expect(summon!.args.id).toBe("dup-new-id"); // 새 노트를 소환
});
