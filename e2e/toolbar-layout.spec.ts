import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 저장된 커스텀 배치는 사용자가 "본" 버튼 전체를 seen에 담는다(설정 편집기의 markSeen이 기록).
// 엄격 계약: resolveLayout은 더 이상 seen 없는 구버전 배치를 마이그레이션하지 않으므로(폴백 시드 제거),
// 실물 저장 형태처럼 seen을 명시한다. 배치에서 뺀 버튼은 seen에 남아 노트 창에서 position 폴백으로
// 되살아나지 않고(=미배치는 숨김), seen에도 없는 신규 버튼만 폴백으로 자동 노출된다.
const ALL_SEEN = [
  "core:transparency",
  "core:preview",
  "core:pin",
  "core:all-desktops",
  "core:background",
  "core:collapse",
  "core:archive",
  "core:delete",
  "plugin:font-scale:font-minus",
  "plugin:font-scale:font-plus",
  "plugin:template:template-insert",
  "plugin:template:template-save",
  "plugin:duplicate:duplicate-note",
  "plugin:copy-ai-prompt:copy-ai-prompt",
  "plugin:word-count:status:word-count-words",
  "plugin:word-count:status:word-count-chars",
  "plugin:reset-options:reset",
];

// 설정 「외형 › 툴바 배치」 편집기를 실제 WebKit에서 검증한다(중앙 호스트가 번들 플러그인 버튼을
// 스냅샷으로 공급). 포인터 기반 드래그가 실제 마우스 이벤트로 배치를 바꾸고 저장하는지 확인한다.
test("툴바 배치: 존의 칩을 팔레트로 끌어 미배치하면 저장·표시된다", async ({
  page,
  context,
}) => {
  await openPluginHost(context, { responses: { ensure_plugin_host: true } });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      get_shared_settings: { schema_version: 1, theme: "sj_d", defaults: {} },
      list_installed_plugins: [],
      list_builtin_states: {},
      list_builtin_settings: {},
      list_missing_plugins: [],
      get_global_hotkey: "",
      get_platform: "macos",
    },
  });
  await page.goto("/?settings=1");
  await page
    .locator('.settings-tree-item[data-node="appearance:ui-layout"]')
    .click();
  await page.waitForSelector("#settings-page-ui-layout .tb-editor");

  // 상단 우측 존에 폰트 플러그인 A− 칩이 뜰 때까지 기다린다(스냅샷 비동기 도착).
  const aMinus = page.locator(
    '.tb-zone-slots .tb-chip[data-item-key="plugin:font-scale:font-minus"]',
  );
  await expect(aMinus).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
  // 기본 배치는 모두 배치돼 있어 팔레트가 비어 있다.
  await expect(page.locator(".tb-palette-empty")).toHaveCount(1);

  // A− 칩을 팔레트 영역으로 실제 마우스로 끌어 미배치한다.
  const palette = page.locator(".tb-palette-items");
  const src = (await aMinus.boundingBox())!;
  const dst = (await palette.boundingBox())!;
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, {
    steps: 12,
  });
  await page.mouse.up();

  // 이제 A−는 존에서 빠지고 팔레트에 뜬다.
  await expect(
    page.locator(
      '.tb-zone-slots .tb-chip[data-item-key="plugin:font-scale:font-minus"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '.tb-palette-items .tb-chip[data-item-key="plugin:font-scale:font-minus"]',
    ),
  ).toHaveCount(1);

  // 저장된 배치에도 A−가 없다(미배치=저장 반영).
  const placed = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __calls: { cmd: string; args: Record<string, unknown> }[];
      }
    ).__calls.filter((x) => x.cmd === "save_shared_settings");
    const last = c[c.length - 1]?.args?.newSettings as {
      toolbar_layout?: {
        top?: { zones?: string[][] };
        bottom?: { zones?: string[][] };
      };
    };
    const zones = [
      ...(last?.toolbar_layout?.top?.zones ?? []),
      ...(last?.toolbar_layout?.bottom?.zones ?? []),
    ].flat();
    return zones.includes("plugin:font-scale:font-minus");
  });
  expect(placed).toBe(false);
});

test("툴바 배치: 팔레트 칩을 존으로 끌어 배치한다", async ({
  page,
  context,
}) => {
  await openPluginHost(context, { responses: { ensure_plugin_host: true } });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      // word-count가 미배치인 커스텀 배치(seen엔 있으나 어느 존에도 없음) → 팔레트에 뜬다.
      get_shared_settings: {
        schema_version: 1,
        theme: "sj_d",
        defaults: {},
        toolbar_layout: {
          top: { align: "left", zones: [["core:preview"]] },
          bottom: { align: "left", zones: [["core:archive"]] },
          seen: ALL_SEEN,
        },
      },
      list_installed_plugins: [],
      list_builtin_states: {},
      list_builtin_settings: {},
      list_missing_plugins: [],
      get_global_hotkey: "",
      get_platform: "macos",
    },
  });
  await page.goto("/?settings=1");
  await page
    .locator('.settings-tree-item[data-node="appearance:ui-layout"]')
    .click();
  await page.waitForSelector("#settings-page-ui-layout .tb-editor");

  const wc = page.locator(
    '.tb-palette-items .tb-chip[data-item-key="plugin:word-count:status:word-count-words"]',
  );
  await expect(wc).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });

  // 팔레트의 word-count를 상단 좌측 존으로 실제 마우스로 끌어 배치.
  const zone = page.locator('.tb-zone-slots[data-bar="top"][data-zone="0"]');
  const s = (await wc.boundingBox())!;
  const d = (await zone.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 12 });
  // 드래그 중에는 삽입 위치 마커가 대상 존에 나타난다.
  await expect(zone.locator(".tb-drop-marker")).toHaveCount(1);
  await page.mouse.up();
  // 드롭 후에는 마커가 사라진다.
  await expect(page.locator(".tb-drop-marker")).toHaveCount(0);

  await expect(
    zone.locator(
      '.tb-chip[data-item-key="plugin:word-count:status:word-count-words"]',
    ),
  ).toHaveCount(1);
  await expect(wc).toHaveCount(0);
});

test("툴바 배치: 미배치 버튼은 노트 툴바에 뜨지 않는다", async ({
  page,
  context,
}) => {
  await openPluginHost(context, { responses: { ensure_plugin_host: true } });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "본문 줄.", meta: { overrides: {} } },
      // 커스텀 배치: 상단에 프리뷰+A−만, 하단에 보관·삭제만 — word-count·template 등은 미배치.
      get_shared_settings: {
        schema_version: 1,
        theme: "sj_d",
        defaults: {},
        toolbar_layout: {
          top: {
            align: "left",
            zones: [["core:preview", "plugin:font-scale:font-minus"]],
          },
          bottom: { align: "left", zones: [["core:archive", "core:delete"]] },
          seen: ALL_SEEN,
        },
      },
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  // 배치된 A−는 뜬다(스냅샷 도착 후).
  await expect(
    page.locator('.note-toolbar-btn[title="글자 작게"]'),
  ).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
  // 미배치 버튼(단어 수·템플릿 삽입)은 폴백 제거로 노트에 렌더되지 않는다.
  await expect(page.locator('.note-toolbar-btn[title="단어 수"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.note-toolbar-btn[title="템플릿 삽입"]'),
  ).toHaveCount(0);
});

test("툴바 배치: 접으면 #app에 note-collapsed가 걸려 상단 바가 창 중앙에 온다", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      note_read: { content: "본문 줄.", meta: { overrides: {} } },
      // 창 타이틀은 백엔드가 본문 첫 줄에서 파생한다 — 접힌 헤더 가운데 라벨이 이 값을 쓴다.
      "plugin:window|title": "본문 줄.",
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator("#app").hover(); // 호버로 툴바 노출.
  await page.locator('[data-action="toggle-collapse"]').click();
  await expect(page.locator("#app.note-collapsed")).toHaveCount(1);
  // 접힌 헤더 가운데(좌/우 존 사이)에는 제목(본문 첫 줄) 라벨이 항상 보인다 — 본문이 안 보이니
  // 유일한 단서다.
  const collapsedTitle = page.locator(".note-collapsed-title");
  await expect(collapsedTitle).toBeVisible();
  await expect(collapsedTitle).toHaveText("본문 줄.");
  // 다시 펼치면 클래스가 빠지고 라벨도 숨는다.
  await page.locator('[data-action="toggle-collapse"]').click();
  await expect(page.locator("#app.note-collapsed")).toHaveCount(0);
  await expect(collapsedTitle).toBeHidden();
});

// 접힘 창(헤더 36px)에서 플러그인 버튼·배경색 피커를 열면 그 레이어가 anchorFloatingPanel의
// window.innerHeight 클램프에 잘려 "아주 작게" 표시됐다(사용자 보고) — 접힘 헤더에서는 아예
// 감춰 열 수 없게 한 회귀 가드.
test("툴바 배치: 접으면 플러그인 버튼·배경색 피커가 헤더에서 사라지고, 펼치면 되돌아온다", async ({
  page,
  context,
}) => {
  // sj_d 테마가 배경 스와치를 공급해 🎨 트리거가 뜨고, 폰트 플러그인(A−)은 기본 배치의 상단
  // 우측 존(접기와 같은 존)에 있다 — 둘 다 플로팅 레이어(스와치 패널·없음)를 여는 버튼의 대표.
  await openPluginHost(context, {
    responses: {
      get_shared_settings: { schema_version: 1, theme: "sj_d", defaults: {} },
    },
  });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: "본문 줄.", meta: { overrides: {} } },
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator("#app").hover(); // 호버로 툴바 노출.

  const fontMinus = page.locator('.note-toolbar-btn[title="글자 작게"]');
  const bgTrigger = page.locator(".note-bg-trigger");
  const collapseToggle = page.locator('[data-action="toggle-collapse"]');
  await expect(fontMinus).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
  await expect(bgTrigger).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });

  await collapseToggle.click();
  await expect(page.locator("#app.note-collapsed")).toHaveCount(1);
  // 접힘 헤더에선 플러그인 버튼·배경색 피커가 숨는다(다시 열 방법이 없다).
  await expect(fontMinus).toBeHidden();
  await expect(bgTrigger).toBeHidden();
  // 접기 토글 자신은 항상 남아 다시 펼칠 수 있다(갇힘 방지).
  await expect(collapseToggle).toBeVisible();

  // 펼치면 둘 다 되돌아온다 — CSS 숨김일 뿐 내부 상태가 사라진 게 아니다.
  await collapseToggle.click();
  await expect(page.locator("#app.note-collapsed")).toHaveCount(0);
  await expect(fontMinus).toBeVisible();
  await expect(bgTrigger).toBeVisible();
});

test("툴바 배치: 줄임 우선순위(foldRank)가 노트 존에 반영된다", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      note_read: { content: "본문 줄.", meta: { overrides: {} } },
      // 상단 2단: 좌=먼저 줄임(0), 우=끝까지 유지(2).
      get_shared_settings: {
        schema_version: 1,
        theme: "sj_d",
        defaults: {},
        toolbar_layout: {
          top: {
            align: "left",
            zones: [["core:preview"], ["core:collapse"]],
            foldRank: [0, 2],
          },
          bottom: { align: "left", zones: [["core:delete"]] },
        },
      },
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  // 존의 data-fold가 배치대로 붙는다(CSS가 flex-shrink 가중치로 접힘 순서를 정함).
  await expect(
    page.locator('.note-toolbar .tb-zone[data-zone="0"]').first(),
  ).toHaveAttribute("data-fold", "0");
  await expect(
    page.locator('.note-toolbar .tb-zone[data-zone="1"]').first(),
  ).toHaveAttribute("data-fold", "2");
});

test("툴바 배치: 상단이 0단이어도 상단 바가 드래그 스트립으로 남는다", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      note_read: { content: "본문 줄.", meta: { overrides: {} } },
      // 상단 0단(존 없음) + 하단에만 버튼 — 상단은 숨지 않고 스트립으로 남아 창 이동을 보장해야 한다.
      get_shared_settings: {
        schema_version: 1,
        theme: "sj_d",
        defaults: {},
        toolbar_layout: {
          top: { align: "left", zones: [] },
          bottom: { align: "left", zones: [["core:archive"]] },
        },
      },
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  // 상단 바는 0단이어도 숨지 않고(display:none 아님) 아이콘 행 높이의 드래그 스트립으로 보인다.
  const topBar = page.locator(".note-toolbar:not(.note-toolbar--bottom)");
  await expect(topBar).toBeVisible();
  const box = await topBar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(20);
  // 스트립엔 존이 없다(0단) — 바 배경 전체가 드래그 영역이고 커서는 에디터의 I-beam이 아니다.
  await expect(topBar.locator(".tb-zone")).toHaveCount(0);
});

// 상태 표시형 아이템(단어 수)의 글리프는 이모지가 아니라 문장("0 단어 · 0 자")이다. 목업 칩은
// 아이콘 한 칸이라, 예전엔 그 문장이 칸 안에서 줄바꿈돼 칩이 깨져 보였다(사용자 신고).
test("툴바 배치: 문장 글리프(단어 수)는 미리보기에서 한 줄 칩으로 그려진다", async ({
  page,
  context,
}) => {
  await openPluginHost(context, { responses: { ensure_plugin_host: true } });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      // 기본 배치 그대로 — 단어 수는 하단 우측 존에 놓인다.
      get_shared_settings: { schema_version: 1, theme: "sj_d", defaults: {} },
      list_installed_plugins: [],
      list_builtin_states: {},
      list_builtin_settings: {},
      list_missing_plugins: [],
      get_global_hotkey: "",
      get_platform: "macos",
    },
  });
  await page.goto("/?settings=1");
  await page
    .locator('.settings-tree-item[data-node="appearance:ui-layout"]')
    .click();
  await page.waitForSelector("#settings-page-ui-layout .tb-editor");

  const chip = page.locator(
    '.tb-zone-slots .tb-chip[data-item-key="plugin:word-count:status:word-count-words"]',
  );
  await expect(chip).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
  await expect(chip).toHaveClass(/tb-chip--label/);

  // 한 줄이다 — 아이콘 칸에서 줄바꿈되면 내용 높이가 칸을 넘는다(예전 결함의 직접 증거).
  const wrapped = await chip
    .locator(".tb-chip-icon")
    .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(wrapped).toBe(false);

  // 칩이 목업의 바 스트립 안에 들어간다(높이로 삐져나오지 않는다).
  const c = (await chip.boundingBox())!;
  const strip = (await page
    .locator('.tb-editor-stage .tb-editor-zones[data-bar="bottom"]')
    .boundingBox())!;
  expect(c.height).toBeLessThanOrEqual(strip.height);
  expect(c.y).toBeGreaterThanOrEqual(strip.y - 1);
  expect(c.y + c.height).toBeLessThanOrEqual(strip.y + strip.height + 1);
});
