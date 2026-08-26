import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 고른 글꼴이 **노트 본문에 실제로 그려지는지**를 WebKit에서 검증한다.
//
// 왜 e2e인가: 이 결함은 계산된 스타일에서만 보인다. CM 기본 테마가 `.cm-scroller`에
// font-family: monospace를 박아 두기 때문에, `.cm-editor`에 글꼴을 지정해도 본문까지 닿지
// 않아 무엇을 골라도 메모가 고정폭으로 보였다. jsdom은 상속을 계산하지 않아 못 잡는다.

/** 저장된 글꼴로 노트 창을 띄우고 본문(.cm-content)의 계산된 서체를 돌려준다. */
async function noteBodyFont(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  fontFamily: string | null,
): Promise<string> {
  const settings = {
    schema_version: 1,
    theme: "sj_d",
    defaults: { font_family: fontFamily },
  };
  await openPluginHost(context, {
    responses: {
      get_shared_settings: settings,
      list_system_fonts: [
        { family: "NanumGothic", korean: true, alias: "나눔고딕" },
      ],
    },
  });
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      get_shared_settings: settings,
      note_read: { content: "가나다 hello", meta: { overrides: {} } },
      note_list: [],
    },
  });
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();
  // 스냅샷은 비동기로 도착한다 — 글꼴이 붙을 때까지 기다린다(고정폭이 아니게 될 때까지).
  // 상한을 명시하는 이유: `expect.poll`의 기본값(5초)은 앱의 스냅샷 예산(10초)보다 짧아,
  // 호스트가 느린 실행에서 앱이 아직 정상 대기 중인데 테스트만 먼저 포기한다.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".cm-content")!).fontFamily,
        ),
      { timeout: SNAPSHOT_UI_TIMEOUT },
    )
    .not.toBe("monospace");
  return page.evaluate(
    () => getComputedStyle(document.querySelector(".cm-content")!).fontFamily,
  );
}

test("고른 글꼴이 노트 본문까지 적용된다(설치 글꼴)", async ({
  page,
  context,
}) => {
  const font = await noteBodyFont(page, context, '"NanumGothic", sans-serif');
  expect(font).toContain("NanumGothic");
});

test("빌트인 세리프를 고르면 본문이 세리프로 그려진다", async ({
  page,
  context,
}) => {
  const font = await noteBodyFont(
    page,
    context,
    "Georgia, 'Times New Roman', serif",
  );
  expect(font).toContain("Georgia");
});

test("고른 글꼴이 없으면 본문은 시스템 기본 서체다(고정폭이 아니다)", async ({
  page,
  context,
}) => {
  const font = await noteBodyFont(page, context, null);
  expect(font).toContain("-apple-system");
});
