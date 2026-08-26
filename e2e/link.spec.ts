import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 마크다운 링크를 WebKit에서 검증한다(Tauri IPC 모킹). 커서는 문서 끝(마지막 줄)에 있으므로
// 그 위의 줄들은 전부 "커서 없는 줄" = 렌더 상태다(라이브 프리뷰 관례).
const CONTENT = [
  "[구글](https://google.example)",
  "[**굵은 링크**](https://bold.example)",
  "<https://angle.example>",
  "맨 URL https://bare.example 뒤 텍스트",
  "[안 열림](file:///etc/passwd)",
  "[](https://empty.example)",
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

/** 모킹된 IPC에 쌓인 `open_external_url` 호출의 url 인자 목록. */
async function openedUrls(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: { url?: string } }[];
      }
    ).__calls
      .filter((c) => c.cmd === "open_external_url")
      .map((c) => c.args.url),
  );
}

test("[텍스트](url)이 마커 없이 링크 텍스트만으로 렌더된다", async ({
  page,
}) => {
  const link = page.locator(".cm-md-link", { hasText: "구글" });
  await expect(link).toBeVisible();
  expect(await link.textContent()).toBe("구글");
  // 대괄호·괄호·URL은 화면에서 사라진다(원문은 문서에 그대로 남아 있다).
  await expect(page.locator(".cm-content")).not.toContainText(
    "https://google.example",
  );
});

test("링크 텍스트 안의 굵게 서식이 함께 살아 있다", async ({ page }) => {
  // 두 마크가 같은 범위에 겹치면 CM이 중첩 span으로 낸다(굵게가 바깥, 링크가 안쪽).
  const bold = page.locator(".cm-strong .cm-md-link");
  await expect(bold).toBeVisible();
  await expect(bold).toContainText("굵은 링크");
  await expect(page.locator(".cm-content")).not.toContainText("**");
});

test("꺾쇠 자동링크와 본문에 그냥 쓴 URL도 링크가 된다", async ({ page }) => {
  await expect(
    page.locator(".cm-md-link", { hasText: "angle.example" }),
  ).toBeVisible();
  // 꺾쇠는 숨는다.
  await expect(page.locator(".cm-content")).not.toContainText(
    "<https://angle.example>",
  );
  await expect(
    page.locator(".cm-md-link", { hasText: "bare.example" }),
  ).toBeVisible();
});

test("모든 링크가 같은 색으로 보인다(CM 기본 URL 하이라이트에 밀리지 않는다)", async ({
  page,
}) => {
  // CM 기본 마크다운 하이라이트는 URL 토큰 안쪽 span에 자기 파란색을 얹는다 — 그게 이기면
  // 맨 URL만 `[텍스트](url)`과 다른 색으로 튄다.
  const colors = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cm-md-link")).map((el) => {
      const deepest = el.querySelector("*") ?? el;
      return getComputedStyle(deepest).color;
    }),
  );
  expect(colors.length).toBeGreaterThan(2);
  expect(new Set(colors).size).toBe(1);
});

test("브라우저로 열 수 없는 스킴과 빈 링크 텍스트는 원문 그대로 남는다", async ({
  page,
}) => {
  const content = page.locator(".cm-content");
  // file: 링크는 링크가 되지 않고 마크다운 원문이 그대로 보인다.
  await expect(content).toContainText("[안 열림](file:///etc/passwd)");
  await expect(page.locator(".cm-md-link", { hasText: "안 열림" })).toHaveCount(
    0,
  );
  // 보여 줄 글자가 없는 `[](url)`도 숨기지 않는다 — 숨기면 클릭도 편집도 불가능해진다.
  await expect(content).toContainText("[](https://empty.example)");
});

test("링크를 클릭하면 시스템 브라우저로 URL을 넘긴다", async ({ page }) => {
  await page.locator(".cm-md-link", { hasText: "구글" }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "open_external_url",
      ),
    null,
    { timeout: 3000 },
  );
  expect(await openedUrls(page)).toEqual(["https://google.example"]);
});

test("꺾쇠 자동링크 클릭 시 꺾쇠를 벗긴 URL이 넘어간다", async ({ page }) => {
  await page.locator(".cm-md-link", { hasText: "angle.example" }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "open_external_url",
      ),
    null,
    { timeout: 3000 },
  );
  expect(await openedUrls(page)).toEqual(["https://angle.example"]);
});

test("커서가 링크 줄에 있으면 원문이 드러난다(편집 가능)", async ({ page }) => {
  await page.locator(".cm-md-link", { hasText: "구글" }).click();
  // 클릭은 링크를 열 뿐 커서를 옮기지 않는다 → 단축키로 문서 맨 앞(첫 줄)에 들어간다.
  // `Mod-Home`을 쓰는 이유: CodeMirror의 `Cmd-ArrowUp`(문서 시작)은 **맥 전용** 바인딩이라
  // Windows/Linux에서는 아무 데도 안 걸린다. `Mod-Home`은 `standardKeymap`에 있어 두 플랫폼
  // 모두에서 `cursorDocStart`로 간다(`ControlOrMeta`가 실행 OS에 맞춰 Ctrl/⌘을 고른다).
  await page.locator(".cm-content").press("ControlOrMeta+Home");
  await expect(page.locator(".cm-content")).toContainText(
    "[구글](https://google.example)",
  );
});
