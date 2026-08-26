import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 테마 코드 플러그인을 WebKit에서 검증한다: 활성 테마가 **중앙 호스트**의 격리 iframe
// 샌드박스에서 실행되고(memo.theme.register 브리지), 그 디스크립터가 스냅샷으로 노트 창에
// 배달돼 배경 스와치·자동 대비를 결정한다. 단위 테스트가 못 닿는 "실제 샌드박스 실행"
// 경로를 여기서 커버한다(e2e).

/** 활성 테마 이름으로 호스트+노트 페이지를 띄운다(설치 플러그인 없음 → 빌트인 테마). */
async function openThemedNote(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  theme: string,
  builtinStates?: Record<string, boolean>,
) {
  await openPluginHost(context, {
    responses: {
      get_shared_settings: { schema_version: 1, theme, defaults: {} },
      ...(builtinStates ? { list_builtin_states: builtinStates } : {}),
    },
  });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "hello theme", meta: { overrides: {} } },
      note_list: [],
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
}

test.describe("SJ_D 기본 테마(하위호환)", () => {
  test.beforeEach(async ({ page, context }) => {
    await openThemedNote(page, context, "sj_d");
  });

  test("배경 피커(🎨)와 4색 스와치가 나타나고 자동 대비가 켜진다", async ({
    page,
  }) => {
    // 툴바는 평소 숨김 → #app 호버로 컨트롤을 드러낸다.
    await page.locator("#app").hover();
    // 활성 테마(SJ_D)가 호스트 샌드박스에서 로드되면 🎨 배경 트리거가 존재한다.
    await expect(page.locator(".note-bg-trigger")).toBeVisible({
      timeout: SNAPSHOT_UI_TIMEOUT,
    });
    // 트리거를 열면 정확히 4개의 스와치가 보인다(기존과 동일).
    await page.locator(".note-bg-trigger").click();
    await expect(page.locator(".note-swatch")).toHaveCount(4);

    // 가드(회귀): 스와치가 **실제로 화면에 그려지고 눌린다**. toHaveCount는 DOM만 세므로
    // 예전엔 패널이 존 측정 영역(`.tb-zone-inner { overflow: hidden }`)에 통째로 잘려
    // 아무것도 안 보이는데도 이 테스트가 통과했다 — 그게 "🎨를 눌러도 반응이 없다"의 정체다.
    // elementFromPoint로 스와치 자리의 최상단 요소가 그 스와치인지 직접 확인한다.
    // 툴바는 스냅샷 도착·오버플로 재배치로 한동안 움직이므로 안정될 때까지 폴링한다.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const sw = document.querySelector<HTMLElement>(".note-swatch");
            if (!sw) return "no swatch";
            const b = sw.getBoundingClientRect();
            const hit = document.elementFromPoint(
              b.x + b.width / 2,
              b.y + b.height / 2,
            );
            return hit === sw
              ? "swatch"
              : (hit?.className ?? hit?.tagName ?? "none");
          }),
        { timeout: 5000 },
      )
      .toBe("swatch");
    // 클릭도 실제로 닿는다(Playwright의 액션 가능성 검사가 hit-target을 확인한다).
    await page.locator(".note-swatch").first().click();

    // 자동 대비: 기본 밝은 배경 → 어두운 글자색(--note-text)이 적용된다.
    const noteText = await page.evaluate(() =>
      getComputedStyle(document.querySelector("#app")!).getPropertyValue(
        "--note-text",
      ),
    );
    expect(noteText.trim()).toBe("#1f2328");
  });
});

test.describe("배경색 플러그인 off(배경 능력 없음)", () => {
  test.beforeEach(async ({ page, context }) => {
    // 배경색 번들 플러그인을 끄면 배경 능력이 사라진다(테마와 무관 — 배경은 별도 플러그인).
    await openThemedNote(page, context, "sj_d", { background: false });
  });

  test("배경 피커(🎨)가 아예 사라진다", async ({ page }) => {
    await page.locator("#app").hover();
    // 다른 툴바 컨트롤(프리뷰)은 로드됐지만 배경 트리거는 없어야 한다.
    await expect(
      page.locator('.note-toolbar-btn[title="마크다운 프리뷰"]'),
    ).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
    await expect(page.locator(".note-bg-trigger")).toHaveCount(0);
    await expect(page.locator(".note-swatch")).toHaveCount(0);
  });
});
