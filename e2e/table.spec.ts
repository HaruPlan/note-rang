import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 가드: 문서가 표로 끝나는 노트도 열자마자(기본 커서=문서 끝) 표로 렌더된다.
// (커서-안쪽 판정의 끝 경계가 배타가 아니면 원문이 보이는 회귀를 잡는다.)
test("문서 끝이 표인 노트도 열자마자 표로 렌더된다", async ({ page }) => {
  await installTauriMock(page, {
    responses: {
      note_read: {
        content: "| A | B |\n| --- | --- |\n| 1 | 2 |",
        meta: { overrides: {} },
      },
    },
  });
  await page.goto("/?note=table-eod");

  await expect(page.locator(".cm-md-table")).toBeVisible();
  await expect(page.locator(".cm-md-table th").first()).toHaveText("A");
});
