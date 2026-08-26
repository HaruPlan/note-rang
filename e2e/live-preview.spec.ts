import { test, expect } from "@playwright/test";
import { installTauriMock, savedContents } from "./support/tauri-mock";

// GFM 라이브 프리뷰를 WebKit에서 검증한다(Tauri IPC 모킹).
const CONTENT = [
  "# 제목",
  "",
  "**굵게** *기울임* `인라인코드` ~~취소선~~ 텍스트.",
  "",
  "- [ ] 할 일 하나",
  "- [x] 끝난 일",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "| 이름 | 값 |",
  "| :--- | ---: |",
  "| 가 | 1 |",
  "",
  "마지막 줄.",
].join("\n");

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    responses: { note_read: { content: CONTENT, meta: { overrides: {} } } },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("GFM 인라인이 마커 없이 렌더된다 (굵게·기울임·인라인코드·취소선)", async ({
  page,
}) => {
  await expect(page.locator(".cm-strong")).toContainText("굵게");
  await expect(page.locator(".cm-em")).toContainText("기울임");
  await expect(page.locator(".cm-inline-code")).toContainText("인라인코드");
  await expect(page.locator(".cm-strike")).toContainText("취소선");
});

test("헤딩은 # 마커와 뒤 공백까지 숨겨 왼쪽에 붙어 렌더된다", async ({
  page,
}) => {
  const h1 = page.locator(".cm-h1");
  await expect(h1).toBeVisible();
  // `# `(해시+공백)이 모두 숨겨져 앞 들여쓰기 없이 "제목"만 보인다.
  expect(await h1.textContent()).toBe("제목");
});

test("코드펜스는 ``` 마커가 숨겨지고 코드가 보인다 (블록 단위)", async ({
  page,
}) => {
  const content = page.locator(".cm-content");
  await expect(content).toContainText("const x = 1;");
  await expect(content).not.toContainText("```");
});

test("GFM 표가 블록 위젯(table)으로 렌더된다 (커서가 표 밖일 때)", async ({
  page,
}) => {
  // 초기 커서는 문서 끝(표 밖) → 표가 렌더된다.
  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();
  await expect(table.locator("th").first()).toHaveText("이름");
  await expect(table.locator("td").first()).toHaveText("가");
});

test("작업목록 체크박스가 상태대로 렌더되고 클릭 시 토글·저장된다", async ({
  page,
}) => {
  const boxes = page.locator(".cm-task-checkbox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();

  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect.poll(() => savedContents(page)).not.toHaveLength(0);
  const saves = await savedContents(page);
  expect(saves[saves.length - 1]).toContain("- [x] 할 일 하나");
});

test("Mod+B가 선택 단어를 **로 감싼다", async ({ page }) => {
  await page.locator(".cm-line", { hasText: "마지막 줄." }).dblclick();
  // `md-shortcuts.ts`의 바인딩은 CodeMirror 관례대로 `Mod-b`다 — CM은 `Mod`를
  // `navigator.platform`으로 풀므로(맥이면 ⌘, 아니면 Ctrl) 테스트도 실행 OS를 따라가는
  // `ControlOrMeta`를 눌러야 한다. `Meta`로 박으면 macOS CI에서만 통과하고 Windows에서는
  // 아무 일도 일어나지 않는다(로컬에서만 빨간 테스트 — 실제로 그랬다).
  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => savedContents(page)).not.toHaveLength(0);
  const saves = await savedContents(page);
  expect(saves[saves.length - 1]).toContain("**");
});
