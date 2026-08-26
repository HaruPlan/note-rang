import { test, expect } from "@playwright/test";
import {
  bundledLanguagePackCount,
  bundledPluginCount,
} from "./support/builtin-plugins";

// 설정·플러그인 매니저 창을 WebKit에서 검증한다(Tauri IPC 모킹).
// 설치된 플러그인 목록을 렌더하고, 활성 토글이 set_plugin_enabled 커맨드를 부른다.
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
    // 활성 상태를 mock에 유지해 토글 후 재조회가 실제처럼 반영되게 한다.
    let enabled = false;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb) => cb,
      invoke: (cmd, args) => {
        w.__calls.push({ cmd, args });
        if (cmd === "get_shared_settings") {
          return Promise.resolve({
            schema_version: 1,
            theme: "sj_d",
            defaults: {},
          });
        }
        if (cmd === "set_plugin_enabled") {
          enabled = args.enabled === true;
          return Promise.resolve(null);
        }
        if (cmd === "set_plugin_setting") {
          return Promise.resolve(null);
        }
        if (cmd === "list_builtin_states") {
          return Promise.resolve({}); // 기록 없음 → 번들은 기본 켜짐
        }
        if (cmd === "set_builtin_enabled") {
          return Promise.resolve(null);
        }
        if (cmd === "list_missing_plugins") {
          return Promise.resolve([]); // 재조정 대상 없음 → 배너 숨김
        }
        if (cmd === "get_startup_no_active_action") {
          return Promise.resolve("panel"); // 기본값(D3) — 「시작」 탭 초기 렌더 검증용.
        }
        if (cmd === "get_vault_info") {
          // 백엔드 계약은 `Result<VaultInfo, String>`이라 성공 시 절대 null이 아니다 —
          // 목이 null을 흘리면 저장 폴더 패널이 `info.path`에서 미처리 거부를 던진다(테스트를
          // 깨지는 않지만 로그를 오염시켜 진짜 오류를 묻는다).
          return Promise.resolve({
            path: "/vault",
            has_contents: false,
            note_count: 0,
            file_count: 0,
            prompted: true,
          });
        }
        if (cmd === "fetch_plugin_for_install") {
          // URL/git/로컬 공통 스테이징 미리보기(설치 전 승인 프롬프트 데이터).
          return Promise.resolve({
            staging: "tok-e2e",
            manifest: {
              id: "net",
              name: "네트 플러그인",
              version: "1.0.0",
              entry: "main.js",
              permissions: ["editor", "notes:read"],
            },
            source: {
              type: "url",
              url: (args.spec as { location: string }).location,
            },
            installed_version: null,
            installed_permissions: [],
            installed_granted: [],
          });
        }
        if (cmd === "confirm_plugin_install") {
          return Promise.resolve("net");
        }
        if (cmd === "list_installed_plugins") {
          return Promise.resolve([
            {
              id: "samp",
              name: "샘플 플러그인",
              version: "1.2.0",
              permissions: ["editor", "notes:read"],
              enabled,
              granted: [],
              // 선언형 설정 스키마 → ⚙ 버튼 + 폼이 뜬다(빈 배열이면 미노출).
              settings_schema: [
                { key: "greeting", label: "인사말", type: "text", options: [] },
                { key: "loud", label: "크게", type: "toggle", options: [] },
              ],
              settings: { greeting: "안녕", loud: false },
            },
          ]);
        }
        return Promise.resolve(null);
      },
    };
  });
  await page.goto("/?settings=1");
});

// 설치(커뮤니티) 플러그인 목록은 「커뮤니티 플러그인」 관리 페이지 안의 .plugin-list다.
const installedList = (page: import("@playwright/test").Page) =>
  page.locator("#settings-page-community .plugin-list");

// 좌측 트리에서 관리 노드(번들·커뮤니티)로 이동한다.
const openBundleTab = async (page: import("@playwright/test").Page) => {
  await page.locator('.settings-tree-item[data-node="manager:bundle"]').click();
};
const openCommunityTab = async (page: import("@playwright/test").Page) => {
  await page
    .locator('.settings-tree-item[data-node="manager:community"]')
    .click();
};

test("트리 전환 — 외형(테마) / 번들 플러그인 / 커뮤니티 플러그인", async ({
  page,
}) => {
  // 기본: 외형 › 테마 선택 — 피커는 보이고 번들 목록은 숨겨져 있다.
  const themeItem = page.locator(
    '.settings-tree-item[data-node="appearance:theme"]',
  );
  await expect(themeItem).toHaveClass(/settings-tree-item-active/);
  await expect(themeItem).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".settings-theme")).toBeVisible();
  await expect(page.locator("#settings-page-bundle .plugin-list")).toBeHidden();

  // 번들 노드 → 번들 목록이 보이고 피커는 숨겨진다.
  await openBundleTab(page);
  await expect(
    page.locator('.settings-tree-item[data-node="manager:bundle"]'),
  ).toHaveClass(/settings-tree-item-active/);
  await expect(
    page.locator("#settings-page-bundle .plugin-list"),
  ).toBeVisible();
  await expect(page.locator(".settings-theme")).toBeHidden();

  // 커뮤니티 노드 → "＋ 플러그인 추가" 버튼이 보인다(설치 UI는 버튼 → 모달).
  await openCommunityTab(page);
  await expect(
    page.locator('.settings-tree-item[data-node="manager:community"]'),
  ).toHaveClass(/settings-tree-item-active/);
  await expect(page.locator(".plugin-add-btn")).toBeVisible();
  // 설치 모달은 버튼을 누르기 전엔 숨겨져 있다.
  await expect(page.locator(".plugin-install")).toBeHidden();

  // 테마 노드로 복귀하면 원래대로.
  await themeItem.click();
  await expect(page.locator(".settings-theme")).toBeVisible();
});

// 「시작」 탭 배선 회귀 방지(리뷰 m14) — mountSettings는 두 dep이 둘 다 있어야 이 노드를
// 만드는데, bootstrapSettings에서 그 배선 두 줄이 빠져도 vitest 유닛 테스트는 (deps를 직접
// 주는 테스트라) 못 잡는다. 실제 bootstrap 경로를 타는 e2e만이 이 배선 자체의 존재를 검증한다.
test("「시작」 탭 — bootstrap 배선으로 노드가 뜨고 기본값을 보인다", async ({
  page,
}) => {
  const startupItem = page.locator('.settings-tree-item[data-node="startup"]');
  await expect(startupItem).toHaveCount(1);
  await startupItem.click();
  await expect(startupItem).toHaveClass(/settings-tree-item-active/);
  await expect(
    page.locator("#settings-page-startup .settings-startup-no-active-action"),
  ).toHaveValue("panel");
});

test("툴바 배치 — 편집기가 뜨고 단을 바꾸면 toolbar_layout이 저장된다", async ({
  page,
}) => {
  await page
    .locator('.settings-tree-item[data-node="appearance:ui-layout"]')
    .click();
  const editor = page.locator("#settings-page-ui-layout .tb-editor");
  await expect(editor).toBeVisible();
  // 상/하 바 설정 블록 2개(목업 위에 모여 있다 — 스트립은 미리보기 안이라 data-bar로 짝짓는다).
  await expect(
    page.locator("#settings-page-ui-layout .tb-editor-bar"),
  ).toHaveCount(2);
  // 기본 배치의 내장 컨트롤 칩(프리뷰)이 상단 바에 배치돼 있다.
  await expect(
    page.locator('#settings-page-ui-layout [data-item-key="core:preview"]'),
  ).toBeVisible();

  // 상단 바를 0단으로 바꾸면 '바 없음' 안내가 뜨고 toolbar_layout이 저장된다.
  await page
    .locator('.tb-editor-bar[data-bar="top"] .tb-tier-btn[data-tier="0"]')
    .click();
  await expect(
    page.locator('.tb-editor-zones[data-bar="top"] .tb-zone-none'),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: Record<string, unknown> }[];
      }
    ).__calls.filter((c) => c.cmd === "save_shared_settings"),
  );
  expect(saved.length).toBeGreaterThan(0);
  const last = saved[saved.length - 1].args.newSettings as {
    toolbar_layout: { top: { zones: unknown[] } };
  };
  expect(last.toolbar_layout.top.zones.length).toBe(0);
});

test("설정 창이 설치된 플러그인을 목록으로 보여주고, 상세에서 권한을 렌더한다", async ({
  page,
}) => {
  await openCommunityTab(page);
  const installed = installedList(page);
  await expect(installed.locator(".plugin-item")).toHaveCount(1);
  await expect(installed.locator(".plugin-name")).toHaveText(
    "샘플 플러그인 v1.2.0",
  );
  // 권한은 마스터-디테일 구조에서 상세 뷰로 이동했다 — 이름을 눌러 상세를 연다.
  await installed.locator(".plugin-name").click();
  const detail = page.locator("#settings-page-community .plugin-detail-view");
  await expect(detail).toBeVisible();
  // 저위험(editor)은 배지, 민감(notes:read)은 부여 토글로 렌더된다(배지 2·토글 1).
  await expect(detail.locator(".plugin-perm")).toHaveCount(2);
  await expect(detail.locator(".plugin-grant")).toHaveCount(1);
});

test("활성 토글이 set_plugin_enabled 커맨드를 부른다", async ({ page }) => {
  await openCommunityTab(page);
  const toggle = installedList(page).locator(".plugin-enable-toggle");
  await expect(toggle).toBeVisible();
  await toggle.check();

  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) => c.cmd === "set_plugin_enabled" && c.args.enabled === true,
      ),
    null,
    { timeout: 3000 },
  );
});

test("테마 피커가 보이고 현재 테마가 선택돼 있다", async ({ page }) => {
  // 테마 피커는 기본 탭(테마)에 있다 — 탭 전환 없이 바로 보여야 한다.
  await expect(page.locator(".settings-theme")).toBeVisible();
  await expect(page.locator(".settings-theme")).toHaveValue("sj_d");
});

test("스키마 있는 플러그인이 트리 설정 페이지를 갖고, 값 변경이 set_plugin_setting을 부른다", async ({
  page,
}) => {
  await openCommunityTab(page);
  // 활성화하면(스키마 보유) 좌측 트리에 이 플러그인의 설정 페이지 노드가 생긴다(설정=트리 정본).
  await installedList(page).locator(".plugin-enable-toggle").check();
  await page.locator('.settings-tree-item[data-node="plugin:samp"]').click();

  // 상세가 아니라 트리 페이지에 ⚙ 폼이 있고, 텍스트가 현재 값으로 초기화된다.
  const pluginPage = page.locator("#settings-page-plugin-samp");
  await expect(pluginPage.locator(".plugin-settings-form")).toBeVisible();
  const text = pluginPage.locator('input[type="text"].plugin-setting-input');
  await expect(text).toHaveValue("안녕");
  await text.fill("반가워");

  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) =>
          c.cmd === "set_plugin_setting" &&
          c.args.key === "greeting" &&
          c.args.value === "반가워",
      ),
    null,
    { timeout: 3000 },
  );
});

test("상세 뷰의 '설정 열기'가 그 플러그인의 트리 설정 페이지로 이동시킨다", async ({
  page,
}) => {
  await openCommunityTab(page);
  await installedList(page).locator(".plugin-enable-toggle").check();
  // 상세엔 설정 폼 대신 "설정 열기" 링크만 있다(설정=트리 정본).
  await installedList(page).locator(".plugin-name").click();
  const detail = page.locator("#settings-page-community .plugin-detail-view");
  await expect(detail.locator(".plugin-settings-form")).toHaveCount(0);
  await detail.locator(".plugin-settings-link").click();
  await expect(
    page.locator("#settings-page-plugin-samp .plugin-settings-form"),
  ).toBeVisible();
});

test("번들 플러그인이 활성 토글과 함께 뜨고, 위키링크를 끄면 set_builtin_enabled를 부른다", async ({
  page,
}) => {
  await openBundleTab(page);
  // 번들 탭의 .plugin-list에는 번들 전부가 토글과 함께 뜬다(미지원 OS는 disabled 토글) —
  // 개수는 번들 폴더 수에서 유도한다(하드코딩 금지). 번들 **언어팩**도 같은 목록에 평범한
  // 토글 행으로 합류하므로 함께 더한다(중앙 호스트가 실행하지 않을 뿐, 사용자에게는 똑같이
  // 켜고 끄는 항목이다 — 샌드박스 개수를 세는 csp·plugin-host 스펙과 갈리는 지점이다).
  const builtinList = page.locator("#settings-page-bundle .plugin-list");
  await expect(builtinList.locator(".plugin-enable-toggle")).toHaveCount(
    bundledPluginCount() + bundledLanguagePackCount(),
  );
  // 잠긴 번들 테마(SJ_D·plain)는 토글 없이 우측 🔒 필수 배지로 뜬다.
  await expect(builtinList.locator(".plugin-required-badge")).toHaveCount(2);
  // 위키링크(첫 번째 번들)의 활성 토글을 끈다.
  const builtinToggle = builtinList
    .locator(".plugin-item")
    .first()
    .locator(".plugin-enable-toggle");
  await expect(builtinToggle).toBeChecked(); // 기록 없음 → 기본 켜짐
  await builtinToggle.uncheck();

  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) =>
          c.cmd === "set_builtin_enabled" &&
          c.args.id === "wikilink" &&
          c.args.enabled === false,
      ),
    null,
    { timeout: 3000 },
  );
});

test("URL 설치가 권한 승인 프롬프트를 거쳐 confirm_plugin_install을 부른다", async ({
  page,
}) => {
  await openCommunityTab(page);
  await page.locator(".plugin-add-btn").click(); // "＋ 플러그인 추가" → 설치 모달 열기.
  await page
    .locator(".plugin-install-url")
    .fill("https://example.com/plugin.zip");
  await page.locator(".plugin-install-url-btn").click();

  // 스테이징(fetch) 후 승인 프롬프트가 열리고 선언 권한이 한국어 설명으로 보인다.
  const prompt = page.locator(".plugin-approve");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("네트 플러그인 v1.0.0");
  await expect(prompt).toContainText("노트 읽기");
  await expect(prompt.locator(".plugin-approve-sensitive")).toHaveCount(1);

  // 승인하면 스테이징 토큰 + 민감 권한 부여로 확정 설치를 부른다.
  await prompt.locator(".plugin-approve-ok").click();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) =>
          c.cmd === "confirm_plugin_install" &&
          c.args.staging === "tok-e2e" &&
          Array.isArray(c.args.granted) &&
          (c.args.granted as string[]).includes("notes:read"),
      ),
    null,
    { timeout: 3000 },
  );
  await expect(page.locator(".plugin-install-status")).toContainText(
    "설치됨: net",
  );
});
