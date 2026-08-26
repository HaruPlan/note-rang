import { test, expect, type Page } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// 설정 「테마」 탭의 색 편집기(테마 기본 팔레트 위 사용자 오버라이드)를 WebKit에서 검증한다.
// get_shared_settings/save_shared_settings 목킹으로 실제 프론트 편집기 → 라이브 반영(설정창
// 루트 --memo-* 변수) → 저장 커맨드까지 전 경로를 탄다(단위 테스트가 못 닿는 실제 렌더 포함).

interface OpenOpts {
  overrides?: Record<string, Record<string, string>>;
  theme?: string;
}

async function openSettings(page: Page, opts: OpenOpts = {}): Promise<void> {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: {
        schema_version: 1,
        theme: opts.theme ?? "sj_d",
        defaults: {},
        ...(opts.overrides ? { theme_overrides: opts.overrides } : {}),
      },
      save_shared_settings: null,
      list_installed_plugins: [],
      list_builtin_states: {},
      list_builtin_settings: {},
      list_missing_plugins: [],
    },
  });
  await page.goto("/?settings=1");
  await expect(page.locator(".settings-color-editor")).toBeVisible();
}

/** 색 입력의 값을 바꾸고 input(라이브)·change(커밋) 이벤트를 함께 발생시킨다. */
const setColor = (page: Page, index: number, value: string): Promise<void> =>
  page
    .locator(".settings-color-swatch")
    .nth(index)
    .evaluate((el, v) => {
      const input = el as HTMLInputElement;
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);

const rootAccent = (page: Page): Promise<string> =>
  page.evaluate(() =>
    getComputedStyle(document.querySelector("#app")!)
      .getPropertyValue("--memo-accent")
      .trim(),
  );

test("색 편집기: 토큰 행이 뜨고, 강조색을 바꾸면 크롬에 라이브 반영 + 저장한다", async ({
  page,
}) => {
  await openSettings(page);
  // 초기엔 오버라이드 없음 → 리셋 숨김.
  // 의미색 3 + 표면 라이트 4 + 표면 다크 4 + 패널 4 = 15 토큰 행.
  await expect(page.locator(".settings-color-row")).toHaveCount(15);
  await expect(page.locator(".settings-color-swatch")).toHaveCount(15);
  await expect(page.locator(".settings-color-reset").first()).toBeHidden();

  await setColor(page, 0, "#aa4488"); // 강조색(첫 행)

  // 설정창 루트 CSS 변수에 라이브 반영(미리보기·설정 크롬이 상속).
  await expect.poll(() => rootAccent(page)).toBe("#aa4488");
  // 리셋 노출 + 저장 커맨드에 활성 테마 오버라이드가 담긴다.
  await expect(page.locator(".settings-color-reset").first()).toBeVisible();
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: Record<string, unknown> }[];
      }
    ).__calls.some((c) => {
      const ov = (
        c.args as {
          newSettings?: { theme_overrides?: Record<string, unknown> };
        }
      )?.newSettings?.theme_overrides as
        Record<string, Record<string, string>> | undefined;
      return (
        c.cmd === "save_shared_settings" &&
        ov?.["sj_d<custom>"]?.accent === "#aa4488"
      );
    }),
  );
});

test("색 편집기: 리셋이 오버라이드를 지워 테마 기본값으로 되돌린다", async ({
  page,
}) => {
  await openSettings(page, {
    theme: "sj_d<custom>",
    overrides: { "sj_d<custom>": { accent: "#123456" } },
  });
  const accentReset = page.locator(".settings-color-reset").first();
  // 기존 오버라이드 → 스와치가 그 값으로 채워지고 리셋이 보인다.
  await expect(page.locator(".settings-color-swatch").first()).toHaveValue(
    "#123456",
  );
  await expect(accentReset).toBeVisible();

  await accentReset.click();
  await expect(accentReset).toBeHidden();
  // 저장 커맨드에서 그 토큰 오버라이드가 사라진다.
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __calls: { cmd: string; args: Record<string, unknown> }[];
      }
    ).__calls.some((c) => {
      const ns = (
        c.args as {
          newSettings?: {
            theme?: string;
            theme_overrides?: Record<string, Record<string, string>>;
          };
        }
      )?.newSettings;
      return (
        c.cmd === "save_shared_settings" &&
        ns?.theme === "sj_d" &&
        !(ns?.theme_overrides && "sj_d<custom>" in ns.theme_overrides)
      );
    }),
  );
});
