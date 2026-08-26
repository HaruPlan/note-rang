import { test, expect, type Page } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";
import { bundledPluginCount } from "./support/builtin-plugins";

const BUNDLED_COUNT = bundledPluginCount();

// 플러그인 중앙 호스트의 성능 계약을 실제 브라우저에서 고정한다: 샌드박스 iframe은
// **호스트 페이지에만 플러그인당 1개** 존재하고, 노트 창이 몇 개 열리든 노트 창에는
// 샌드박스가 0개다(디스크립터 주입만 받는다). 수명주기(notes-reload → 재빌드 → 노트
// 리로드)도 전 경로로 검증한다.

/** 페이지의 살아있는 플러그인 샌드박스 iframe 수(임베드 위젯 등 다른 iframe 제외). */
function sandboxCount(page: Page): Promise<number> {
  return page.locator("iframe[data-plugin-sandbox]").count();
}

/** 위키링크가 보이는 노트 페이지를 연다(플러그인 스냅샷이 적용됐다는 신호). */
async function openNote(
  context: import("@playwright/test").BrowserContext,
  id: string,
): Promise<Page> {
  const page = await context.newPage();
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      // 위키링크를 첫 줄에, 커서(문서 끝)는 다른 줄에 — 커서 없는 줄에서만 링크 데코가 뜬다.
      note_read: {
        content: `링크 [[Alpha]]\n\n(${id})`,
        meta: { overrides: {} },
      },
      note_list: [{ id: "alpha-id", title: "Alpha", hidden: false }],
    },
  });
  await page.goto(`/?note=${id}`);
  await expect(page.locator(".cm-editor")).toBeVisible();
  // 스냅샷이 적용돼 플러그인 기능이 실제로 동작 중임을 확인한 뒤에 센다.
  await expect(page.locator(".cm-x-wikilink-wikilink")).toBeVisible({
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  return page;
}

test("샌드박스는 호스트에 플러그인당 1개 — 노트 창이 늘어도 0개씩 유지된다", async ({
  context,
}) => {
  const host = await openPluginHost(context);
  // 기본 구성: 번들 플러그인이 모두 켜져 있고, 테마 샌드박스는 즉시 정리되므로 살아있는
  // iframe 수는 번들 개수와 같다 — 개수는 번들 폴더 수에서 유도한다(하드코딩 금지).
  expect(await sandboxCount(host)).toBe(BUNDLED_COUNT);

  const noteA = await openNote(context, "counter-a");
  const noteB = await openNote(context, "counter-b");

  // 노트 창에는 샌드박스가 전혀 생성되지 않는다(디스크립터 주입 + 로컬 인스턴스화만).
  expect(await sandboxCount(noteA)).toBe(0);
  expect(await sandboxCount(noteB)).toBe(0);
  // 노트 창이 2개 열려도 호스트의 샌드박스 수는 그대로다(창 수와 무관 = 플러그인당 1개).
  expect(await sandboxCount(host)).toBe(BUNDLED_COUNT);
});

test("설정 변경 방송(notes-reload) 시 호스트가 재빌드하고 노트 창이 리로드된다", async ({
  context,
}) => {
  const host = await openPluginHost(context);
  const note = await openNote(context, "lifecycle");
  expect(await sandboxCount(host)).toBe(BUNDLED_COUNT);

  // 리로드 감지 마커(리로드되면 사라진다).
  await note.evaluate(() => {
    (window as unknown as { __pre?: boolean }).__pre = true;
  });

  // 설정 창 역할: 변경 신호를 방송한다(호스트가 재빌드 → EV_HOST_UPDATED → 노트 리로드).
  await host.evaluate(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "notes-reload",
      payload: null,
    }),
  );

  // 노트가 리로드돼 마커가 사라지고, 새 스냅샷으로 플러그인이 다시 동작한다.
  await note.waitForFunction(
    () =>
      !(window as unknown as { __pre?: boolean }).__pre &&
      document.querySelector(".cm-x-wikilink-wikilink") !== null,
    null,
    { timeout: 10_000 },
  );
  // 재빌드 후에도 호스트의 샌드박스는 플러그인당 1개로 유지된다(누수 없음).
  await expect
    .poll(() => sandboxCount(host), { timeout: 5000 })
    .toBe(BUNDLED_COUNT);
});

test("호스트가 무응답이어도 노트는 즉시 뜬다(논블로킹 마운트)", async ({
  context,
}) => {
  // 최악 경로 재현: ensure는 true(창은 있음)인데 호스트 페이지를 띄우지 않아 스냅샷이
  // 영영 오지 않는다(웹뷰 무응답과 동형). 노트 열림은 스냅샷 예산(10s)에 묶이면 안 된다.
  const page = await context.newPage();
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "무응답 호스트", meta: { overrides: {} } },
    },
  });
  await page.goto("/?note=zombie");
  // 테마 대기 상한(~1s) + 마운트 안에 에디터가 뜬다(10s 예산과 무관함을 4s 상한으로 고정).
  await expect(page.locator(".cm-editor")).toBeVisible({ timeout: 4000 });
  // 플러그인 없이도 노트는 정상 동작(샌드박스 0개 · 기본 테마).
  expect(await sandboxCount(page)).toBe(0);
});
