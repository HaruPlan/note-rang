import { test, expect, type Page } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 템플릿 번들 플러그인을 WebKit에서 왕복 검증한다: ➕(현재 메모→이름 입력 팝업→저장)로
// 템플릿을 만들고, 📄(선택 팝업→키워드 치환→커서 위치 삽입)로 다시 넣는다. 팝업·삽입·저장이
// 실제 샌드박스 + 창-스코프 브릿지(ui.prompt·ui.pickList·editor.insertText·notes.current)를
// 타고 프로덕션과 같은 이벤트 채널로 동작하는지 확인한다.
//
// 빌트인은 선언=부여라 notes:write가 자동 부여된다. 위치는 기본값(상단 우) → 넓은 뷰포트에서
// 상단 버튼이 인라인으로 보인다(좁으면 ⋯로 접힘). 설정 주입 대신 저장으로 템플릿을 만든다
// (e2e 목의 list_builtin_settings는 초기 빌드 타이밍상 소비되지 않는다 — copy-ai-prompt와 동일).

const NOTE = { content: "## {today} 회의\n- 안건", meta: { overrides: {} } };

/** 노트 창을 띄우고 템플릿 버튼이 인라인으로 뜰 때까지 기다린다. */
async function openNote(page: Page, id: string) {
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: NOTE,
      get_vault_path: "/Users/test/Memo", // notes.current의 path 해석(없으면 null 반환)
    },
  });
  await page.goto(`/?note=${id}`);
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.locator("#app").hover();
  await expect(
    page.locator('.note-toolbar-btn[title="템플릿 삽입"]'),
  ).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
}

/** ➕ → 이름 입력 팝업에 name을 넣고 저장한다(현재 에디터 본문이 그 이름의 템플릿이 된다). */
async function saveTemplate(page: Page, name: string) {
  await page.locator("#app").hover();
  await page
    .locator('.note-toolbar-btn[title="현재 메모를 템플릿으로 저장"]')
    .click();
  const input = page.locator(".plugin-popup-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.locator(".plugin-popup-ok").click();
  await expect(page.locator(".plugin-popup-overlay")).toBeHidden();
}

test("➕ 저장: 현재 메모를 이름 입력 팝업으로 템플릿에 저장한다", async ({
  page,
  context,
}) => {
  const host = await openPluginHost(context);
  await openNote(page, "t-save");

  await saveTemplate(page, "회의록");

  // 저장은 호스트(상주 샌드박스)의 set_builtin_setting으로 영속화된다 —
  // 현재 본문이 그 이름의 템플릿으로(키워드는 원문 {today} 그대로) 들어간다.
  await host.waitForFunction(
    () =>
      (
        window as unknown as {
          __calls: { cmd: string; args: Record<string, unknown> }[];
        }
      ).__calls.some(
        (c) =>
          c.cmd === "set_builtin_setting" &&
          c.args.id === "template" &&
          c.args.key === "templates" &&
          typeof c.args.value === "string" &&
          (c.args.value as string).includes("회의록") &&
          (c.args.value as string).includes("{today}"),
      ),
    null,
    { timeout: 5000 },
  );
});

test("📄 삽입: 저장한 템플릿을 선택 팝업에서 골라 키워드 치환 후 커서 위치에 넣는다", async ({
  page,
  context,
}) => {
  await openPluginHost(context);
  await openNote(page, "t-insert");

  // 같은 본문을 두 이름으로 저장 → 매니페스트 기본 템플릿 3개 + 저장분 2개가 팝업에 뜬다.
  // 저장된 값이 없어도 매니페스트 `default`가 플러그인에 실제로 도달한다 — 예전엔
  // 설정 폼을 한 번이라도 열기 전까지 기본 템플릿이 플러그인에 보이지 않았다.)
  await saveTemplate(page, "회의A");
  await saveTemplate(page, "회의B");

  // 에디터를 비운 뒤 삽입 → 결과가 오롯이 삽입분만 남는다.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");

  await page.locator("#app").hover();
  await page.locator('.note-toolbar-btn[title="템플릿 삽입"]').click();

  // 여러 개 → 선택 팝업. 기본 3개(주간회의·데일리·회고) + 방금 저장한 2개.
  const popup = page.locator(".plugin-popup-overlay");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".plugin-popup-item")).toHaveCount(5);
  await popup.locator(".plugin-popup-item", { hasText: "회의A" }).click();
  await expect(popup).toBeHidden();

  // {today}가 실제 날짜(YYYY-MM-DD)로 치환돼 커서 위치(빈 문서)에 삽입된다.
  await expect(page.locator(".cm-content")).toContainText("회의");
  const text = await page.locator(".cm-content").innerText();
  expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
});
