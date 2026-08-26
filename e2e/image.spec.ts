import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 이미지 첨부(붙여넣기→저장→렌더)를 WebKit에서 검증한다(Tauri IPC·convertFileSrc 모킹).
// 네이티브 클립보드/파일시스템은 브라우저로 재현 불가하므로, save_attachment·convertFileSrc를
// 모킹하고 합성 paste 이벤트로 흐름만 확인한다(저장 호출 + img 삽입/렌더).

/** 웹뷰에서 실제로 로드 가능한 1x1 png — 렌더된 img가 깨지지 않게 asset URL 대신 쓴다. */
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pdUAAAAAElFTkSuQmCC";

/** 모킹된 Tauri 내부를 설치한다(note_read 본문은 인자로 주입). */
async function installMock(
  page: import("@playwright/test").Page,
  content: string,
): Promise<void> {
  await installTauriMock(page, {
    assetUrl: PNG_1X1,
    responses: {
      note_read: { content, meta: { overrides: {} } },
      get_vault_path: "/vault",
      save_attachment: "attachments/mock/saved.png",
    },
  });
}

test("단독 이미지 문단이 블록 img로 렌더된다", async ({ page }) => {
  await installMock(page, "![alt](attachments/mock/a.png)");
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  // 초기 커서는 문서 끝(이미지 밖) → 블록 이미지 위젯이 만들어진다.
  // (img의 시각적 visible은 data URL 디코드 타이밍에 좌우되므로, attach + src/alt로 렌더를 검증한다.)
  const img = page.locator("img.cm-md-image-block");
  await expect(img).toBeAttached({ timeout: 5000 });
  await expect(img).toHaveAttribute("alt", "alt");
  await expect(img).toHaveAttribute("src", /^data:image\/png/);
});

test("이미지를 붙여넣으면 저장 후 본문에 ![](경로)가 삽입된다", async ({
  page,
}) => {
  // 둘째 줄을 두어, 붙여넣기 후 커서를 그쪽으로 옮겨 첫 줄 이미지가 렌더되게 한다.
  await installMock(page, "처음 텍스트\n둘째 줄");
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  // 첫 줄 끝을 클릭해 커서를 그 줄에 둔다.
  await page.locator(".cm-line", { hasText: "처음 텍스트" }).click();
  // 합성 paste: image/png 파일 하나를 담은 clipboardData로 paste 이벤트를 발생시킨다.
  await page.evaluate(() => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new File([bytes], "clip.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector(".cm-content");
    target?.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // save_attachment가 호출되고, 돌려준 경로 ![](...)가 첫 줄 본문에 삽입된다.
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "save_attachment",
      ),
    null,
    { timeout: 5000 },
  );
  await expect(page.locator(".cm-content")).toContainText(
    "![](attachments/mock/saved.png)",
  );

  // 커서를 둘째 줄로 옮기면 첫 줄 이미지가 인라인 img로 렌더된다(커서-노출 해제).
  await page.locator(".cm-line", { hasText: "둘째 줄" }).click();
  await expect(page.locator("img.cm-md-image")).toBeAttached({ timeout: 5000 });
  await expect(page.locator("img.cm-md-image")).toHaveAttribute(
    "src",
    /^data:image\/png/,
  );

  // 붙여넣기로 보낸 인자: noteId·ext가 맞고 data가 바이트 배열이다.
  const call = await page.evaluate(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.find((c) => c.cmd === "save_attachment")?.args,
  );
  expect(call?.noteId).toBe("mock");
  expect(call?.ext).toBe("png");
  expect(Array.isArray(call?.data)).toBe(true);
});
