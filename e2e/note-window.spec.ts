import { test, expect } from "@playwright/test";
import { installTauriMock, savedContents } from "./support/tauri-mock";

// Tauri IPC를 모킹해 WebKit에서 노트창 동작을 검증한다.
// (네이티브 창 동작 — 투명도·드래그·멀티윈도우 — 은 e2e·수동으로 검증한다.)
//
// 목은 공용 `installTauriMock`을 쓴다 — 스펙마다 손으로 짠 목은 "목록에 없는 커맨드는 null"
// 이라, 백엔드 계약이 맵/리스트인 커맨드(예: `list_builtin_states`)까지 null로 흘려 실제
// 앱에서는 불가능한 크래시를 만든다(support/tauri-mock.ts의 CONTRACT_DEFAULTS 참고).
test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    responses: {
      note_read: {
        content: "# 목 노트\n\n본문에 **굵게** 가 있다.\n마지막 줄.",
        meta: { overrides: {} },
      },
    },
  });
});

test("노트창이 본문을 로드해 하이브리드 프리뷰로 렌더한다", async ({
  page,
}) => {
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  // 커서는 문서 끝(마지막 줄)이라 헤딩/굵게 줄은 렌더 상태.
  const heading = page.locator(".cm-line.cm-h1");
  await expect(heading).toContainText("목 노트");
  await expect(heading).not.toContainText("#");
  await expect(page.locator(".cm-strong")).toContainText("굵게");
});

test("편집하면 디바운스 후 본문이 저장된다", async ({ page }) => {
  await page.goto("/?note=mock");
  await page.locator(".cm-content").click();
  await page.keyboard.type(" 추가됨");
  await expect.poll(() => savedContents(page)).not.toHaveLength(0);
  const saves = await savedContents(page);
  expect(saves[saves.length - 1]).toContain("추가됨");
  // 저장이 이 창의 노트 id로 나갔는지도 함께 본다(창-노트 짝짓기 회귀 가드).
  const ids = await page.evaluate(() =>
    (
      window as unknown as { __calls: { cmd: string; args: { id?: string } }[] }
    ).__calls
      .filter((c) => c.cmd === "note_save_content")
      .map((c) => c.args.id),
  );
  expect(ids[ids.length - 1]).toBe("mock");
});
