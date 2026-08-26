import { test, expect } from "@playwright/test";

// 노트 목록·검색 패널을 WebKit에서 검증한다(Tauri IPC 모킹).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __calls: { cmd: string; args: Record<string, unknown> }[];
      __TAURI_INTERNALS__: {
        transformCallback: (cb: unknown) => unknown;
        invoke: (
          cmd: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb) => cb,
      invoke: (cmd, args) => {
        w.__calls.push({ cmd, args });
        if (cmd === "note_list") {
          // **일부러 뒤집힌 순서**로 돌려준다(오래된 것 먼저) — 화면이 "첫 노트"를 위에
          // 그린다면 그건 프론트의 기본 정렬(추가순 최신)이 실제로 걸렸다는 뜻이다.
          return Promise.resolve([
            {
              id: "n2",
              title: "둘째 노트",
              hidden: false,
              created_at: 1600000000000,
              favorite: false,
              content_updated_at: 1600000000000,
              char_count: 12,
              opened_at: null,
            },
            {
              id: "n1",
              title: "첫 노트",
              hidden: false,
              created_at: 1700000000000,
              favorite: false,
              content_updated_at: 1700000000000,
              char_count: 40,
              opened_at: 1700000000000,
            },
          ]);
        }
        if (cmd === "note_search") {
          // 제목·본문 매치는 "둘째"에만 응답한다(날짜 질의는 생성일 매치로만 검증되게).
          const q = String((args as { query?: unknown }).query ?? "");
          const hit = {
            id: "n2",
            title: "둘째 노트",
            snippet: "…검색 결과…",
            created_at: 1600000000000,
            favorite: false,
            content_updated_at: 1600000000000,
            char_count: 12,
            opened_at: null,
          };
          return Promise.resolve(q.includes("둘째") ? [hit] : []);
        }
        // 저장된 정렬 모드 — 계약상 항상 문자열이다(백엔드가 기본값을 채워 돌려준다).
        if (cmd === "get_panel_sort") return Promise.resolve("created-desc");
        return Promise.resolve(null);
      },
    };
  });
  await page.goto("/?panel=1");
});

test("패널이 전체 노트 목록을 기본 정렬(추가순 최신)로 보여준다", async ({
  page,
}) => {
  await expect(page.locator(".panel-item")).toHaveCount(2);
  // 목이 오래된 것부터 돌려줬는데도 최신이 위 — 프론트 정렬이 걸렸다는 증거.
  await expect(page.locator(".panel-item-title")).toHaveText([
    "첫 노트",
    "둘째 노트",
  ]);
  // 각 항목에 생성일을 YYYY.MM.DD로 함께 보여준다(로컬 시간대 무관하게 형식만 검증).
  await expect(page.locator(".panel-item-date")).toHaveCount(2);
  await expect(page.locator(".panel-item-date").first()).toHaveText(
    /^\d{4}\.\d{2}\.\d{2}$/,
  );
});

test("검색하면 결과로 좁혀지고, 클릭 시 노트를 소환한다", async ({ page }) => {
  await page.locator(".panel-search").fill("둘째");

  await expect(page.locator(".panel-item")).toHaveCount(1);
  await expect(page.locator(".panel-item-snippet")).toBeVisible();

  await page.locator(".panel-item").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "summon_note",
      ),
    null,
    { timeout: 3000 },
  );
});

test("생성일(연도)로도 검색된다", async ({ page }) => {
  // n1은 2023년, n2는 2020년 생성 — 연도 경계에서 먼 순간이라 로컬 TZ와 무관하게 연도가 안정적.
  await page.locator(".panel-search").fill("2023");

  await expect(page.locator(".panel-item")).toHaveCount(1);
  await expect(page.locator(".panel-item-title")).toHaveText("첫 노트");
  await expect(page.locator(".panel-item-date")).toHaveText(/^2023\./);
});

test("정렬을 바꾸면 순서가 뒤집히고 선택이 저장된다", async ({ page }) => {
  await expect(page.locator(".panel-item")).toHaveCount(2);

  await page.locator(".panel-sort-select").selectOption("created-asc");

  await expect(page.locator(".panel-item-title")).toHaveText([
    "둘째 노트",
    "첫 노트",
  ]);
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) => c.cmd === "set_panel_sort" && c.args.sort === "created-asc",
      ),
    null,
    { timeout: 3000 },
  );
});

test("즐겨찾기 버튼이 note_set_favorite을 부르고 행을 열지 않는다", async ({
  page,
}) => {
  await expect(page.locator(".panel-item")).toHaveCount(2);

  await page.locator(".panel-item-favorite").first().click();

  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) =>
          c.cmd === "note_set_favorite" &&
          c.args.id === "n1" &&
          c.args.favorite === true,
      ),
    null,
    { timeout: 3000 },
  );
  // 항목 안의 버튼 클릭이 행 클릭(소환)으로 번지지 않았다.
  const summoned = await page.evaluate(() =>
    (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
      (c) => c.cmd === "summon_note",
    ),
  );
  expect(summoned).toBe(false);
});
