import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 위키링크 1st-party 플러그인을 WebKit에서 검증한다: **중앙 호스트 페이지**의 격리 iframe
// 샌드박스에서 코드가 실행되고, 브리지로 등록된 디스크립터가 스냅샷으로 노트 창에 배달돼
// [[ ]] 링크/자동완성을 만든다(프로덕션과 같은 이벤트 프로토콜 — tauri-mock의 버스 심).
test.beforeEach(async ({ page, context }) => {
  await openPluginHost(context); // 샌드박스는 여기(호스트)에서만 돈다.
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true, // 호스트 창 보장(있으면 재사용) → 노트가 스냅샷을 기다린다.
      note_read: {
        // 위키링크를 첫 줄에 두고 커서(문서 끝)는 다른 줄에 — 커서 없는 줄에서 구분자가
        // 숨고 안쪽만 스타일되는 동작을 관찰한다(라이브 프리뷰 관례).
        // 셋째 줄의 마크다운 링크는 코어 라이브 프리뷰가, 첫 줄 [[Alpha]]는 플러그인이 맡는다 —
        // 둘이 같은 에디터에서 서로를 밟지 않는지 함께 관찰한다.
        content:
          "link to [[Alpha]] here\n\n[구글](https://google.example)\n\n끝",
        meta: { overrides: {} },
      },
      note_list: [{ id: "alpha-id", title: "Alpha", hidden: false }],
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("위키링크가 클릭 가능한 링크로 렌더되고 클릭 시 노트를 소환한다", async ({
  page,
}) => {
  // 호스트 스냅샷 적용 후 [[Alpha]]가 cm-x-wikilink-wikilink로 데코레이션된다.
  await expect(page.locator(".cm-x-wikilink-wikilink")).toBeVisible({
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  await expect(page.locator(".cm-x-wikilink-wikilink")).toContainText("Alpha");

  await page.locator(".cm-x-wikilink-wikilink").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "summon_note",
      ),
    null,
    { timeout: 3000 },
  );
});

test("위키링크와 마크다운 링크가 한 노트에서 각자 제 동작을 한다", async ({
  page,
}) => {
  await expect(page.locator(".cm-x-wikilink-wikilink")).toBeVisible({
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  const md = page.locator(".cm-md-link", { hasText: "구글" });
  await expect(md).toBeVisible();
  // 위키링크 쪽은 코어 링크로 오인되지 않는다(lezer는 [[Alpha]]도 Link로 파싱하지만 URL이 없다).
  await expect(page.locator(".cm-md-link", { hasText: "Alpha" })).toHaveCount(
    0,
  );

  await md.click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "open_external_url",
      ),
    null,
    { timeout: 3000 },
  );
  // 마크다운 링크 클릭이 플러그인 패턴 핸들러까지 흘러가 노트를 소환하면 안 된다.
  const summoned = await page.evaluate(() =>
    (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
      (c) => c.cmd === "summon_note",
    ),
  );
  expect(summoned).toBe(false);
});

test("[[ 입력 시 노트 제목 자동완성이 뜬다", async ({ page }) => {
  // 플러그인이 로드됐음을 먼저 확인(데코레이션 존재).
  await expect(page.locator(".cm-x-wikilink-wikilink")).toBeVisible({
    timeout: SNAPSHOT_UI_TIMEOUT,
  });

  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[");

  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible({
    timeout: 3000,
  });
  await expect(page.locator(".cm-completionLabel").first()).toContainText(
    "Alpha",
  );
});
