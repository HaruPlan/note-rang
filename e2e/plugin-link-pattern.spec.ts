import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 세 토막 인라인 패턴(`mid` + `action`)을 **설치형 플러그인**으로 끝까지 검증한다:
// 샌드박스에서 등록 → 스냅샷 배달 → 노트 창 데코레이션 → 클릭 → open_external_url.
// 번들이 아니라 사이드로드 경로를 쓰는 이유: 이 API의 실제 사용자는 서드파티 저작자이고,
// 설치 레코드 → InstalledPluginSource 되접기(installedSourceFromRecord)까지 함께 지난다.
//
// 구분자를 `{{라벨|url}}`로 둔 이유: `[텍스트](url)`은 **코어 라이브 프리뷰도 렌더한다**.
// 같은 구간을 둘이 함께 꾸미면 어느 쪽 클릭인지 관측할 수 없어, 플러그인 경로만 보이도록
// 겹치지 않는 모양을 쓴다(모양 자체가 표현 가능한지는 editor-api.test.ts가 못박는다).
const PLUGIN_CODE = `
memo.editor
  .registerInlinePattern({
    id: "mdlink",
    open: "{{",
    mid: "|",
    close: "}}",
    label: "first",
    target: "second",
    action: "open-url",
    style: { color: "accent", textDecoration: "underline", cursor: "pointer" },
  })
  .then(function () { return memo.runtime.ready(); })
  .catch(function (e) {
    memo.runtime.log({ message: "등록 실패: " + e.call + " → " + e.code });
  });
`;

/** 첫 줄에 링크, 커서(문서 끝)는 다른 줄 — 커서 없는 줄에서만 렌더된다(라이브 프리뷰 관례). */
const CONTENT = "가 {{구글|https://g.example}} 나\n\n끝";

/** 설치형 플러그인 한 건을 실은 목 스펙 — `granted`를 바꿔 권한 게이트를 관찰한다. */
function spec(granted: string[]) {
  return {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: CONTENT, meta: { overrides: {} } },
      list_installed_plugins: [
        {
          id: "mdlink",
          name: "마크다운 링크",
          version: "1.0.0",
          permissions: ["editor", "browser:open"],
          enabled: true,
          granted,
          settings_schema: [],
          settings: {},
        },
      ],
      read_plugin_code: PLUGIN_CODE,
    },
  };
}

test("세 토막 패턴이 라벨만 남기고 클릭 시 대상 토막을 브라우저로 넘긴다", async ({
  page,
  context,
}) => {
  await openPluginHost(context, spec(["editor", "browser:open"]));
  await installTauriMock(page, spec(["editor", "browser:open"]));
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  const link = page.locator(".cm-x-mdlink-mdlink");
  await expect(link).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
  // label이 첫 토막이므로 화면에는 라벨만 남고 구분자·URL은 숨는다.
  expect(await link.textContent()).toBe("구글");
  await expect(page.locator(".cm-content")).not.toContainText(
    "https://g.example",
  );

  // target이 둘째 토막이므로 클릭 대상은 화면에 보이는 글자가 아니라 URL이다.
  await link.click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
        (c) => c.cmd === "open_external_url",
      ),
    null,
    { timeout: 3000 },
  );
  const urls = await page.evaluate(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: { url?: string } }[];
      }
    ).__calls
      .filter((c) => c.cmd === "open_external_url")
      .map((c) => c.args.url),
  );
  expect(urls).toEqual(["https://g.example"]);
});

test("browser:open이 부여되지 않으면 링크 표식 없이 스타일만 남는다", async ({
  page,
  context,
}) => {
  // 선언은 했지만 사용자가 승인하지 않은 상태.
  await openPluginHost(context, spec(["editor"]));
  await installTauriMock(page, spec(["editor"]));
  await page.goto("/?note=mock");
  await expect(page.locator(".cm-editor")).toBeVisible();

  const styled = page.locator(".cm-x-mdlink-mdlink");
  await expect(styled).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
  // 데코레이션(플러그인 스타일)은 남지만 클릭 훅은 붙지 않는다 — 눌러도 아무 일이 없는
  // 가짜 링크를 만들지 않는다는 계약이 여기서 관측된다.
  await expect(page.locator(".cm-x-mdlink-mdlink.cm-plugin-link")).toHaveCount(
    0,
  );

  await styled.click();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() =>
    (window as unknown as { __calls: { cmd: string }[] }).__calls.some(
      (c) => c.cmd === "open_external_url",
    ),
  );
  expect(opened).toBe(false);
});
