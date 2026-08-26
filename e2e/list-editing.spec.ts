import { test, expect } from "@playwright/test";
import { installTauriMock, savedContents } from "./support/tauri-mock";

// 리스트·체크박스 편집 키(Backspace 한 글자 삭제 / Enter 마커 이어쓰기)를 WebKit에서 검증한다.
//
// 왜 e2e인가: 이 동작은 `editor.ts`가 조립한 **키맵 우선순위**의 결과다 —
// `@codemirror/lang-markdown`의 기본 Backspace(`deleteMarkupBackward`)를 끄고 Enter만
// 되살렸는지는 실제 키 입력을 흘려 봐야만 확인된다.

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    responses: { note_read: { content: "", meta: { overrides: {} } } },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".cm-content").click();
});

/**
 * 마지막으로 저장된 본문이 기대와 같아질 때까지 기다린다.
 *
 * 화면(`.cm-content`)이 아니라 저장 payload를 보는 이유: 체크박스는 위젯이라 `[ ]` 원문이
 * DOM 텍스트에 없다. 디스크에 실제로 무엇이 적히는지가 이 테스트의 관심사다.
 */
async function expectSaved(
  page: import("@playwright/test").Page,
  content: string,
) {
  await expect
    .poll(
      async () => {
        const saves = await savedContents(page);
        return saves.length > 0 ? saves[saves.length - 1] : null;
      },
      { timeout: 5000 },
    )
    .toBe(content);
}

test("마커 바로 뒤 Backspace는 한 글자만 지운다", async ({ page }) => {
  await page.keyboard.type("- [ ] ");
  await page.keyboard.press("Backspace");
  // lang-markdown 기본 Backspace였다면 `- [ ] ` 전체가 한 번에 사라졌다.
  await expectSaved(page, "- [ ]");
  await page.keyboard.press("Backspace");
  await expectSaved(page, "- [ ");
});

test("이어진 리스트 항목의 Backspace가 마커를 공백으로 바꾸지 않는다", async ({
  page,
}) => {
  await page.keyboard.type("- [ ] 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  // lang-markdown 기본 Backspace였다면 둘째 줄이 마커 너비만큼의 공백(`      `)이 되어
  // 눈에 보이지 않는 꼬리 공백이 그대로 .md에 저장됐다.
  await expectSaved(page, "- [ ] 하나\n- [ ]");
});

test("Enter 마커 이어쓰기는 그대로 동작한다", async ({ page }) => {
  await page.keyboard.type("- [x] 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘");
  // 체크 상태는 이어받지 않는다(새 항목은 언제나 빈 상자).
  await expectSaved(page, "- [x] 하나\n- [ ] 둘");
});

test("번호 목록은 다음 번호로 이어진다", async ({ page }) => {
  await page.keyboard.type("1. 하나");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘");
  await expectSaved(page, "1. 하나\n2. 둘");
});
