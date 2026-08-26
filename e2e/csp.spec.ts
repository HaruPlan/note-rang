import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { installTauriMock, SNAPSHOT_UI_TIMEOUT } from "./support/tauri-mock";
import {
  collectCspViolations,
  cspWithoutScriptBlob,
  documentCspEvents,
  PROD_CSP,
  type CspViolation,
} from "./support/csp";
import { bundledPluginCount } from "./support/builtin-plugins";

// 프로덕션 CSP(tauri.conf.json)를 meta로 복제 주입해 WebKit에서 실측한다:
// ① 샌드박스 부트스트랩(인라인, sha256 허용) + 플러그인 코드(blob 스크립트) 동작,
// ② 임베드 iframe(https, route 스텁) 렌더, ③ CM 에디터 스타일 정상,
// ④ securitypolicyviolation·콘솔 CSP 거부 0건.
// 좁힌 정책에서 unsafe-inline/unsafe-eval 없이 전 기능이 도는지가 핵심 증명이다.

/** 노트 본문: 위키링크(인라인 패턴) + 유튜브 임베드(blob·https 프레임) 둘 다 태운다. */
const CONTENT = [
  "link to [[Alpha]] here",
  "",
  "```youtube",
  "https://youtu.be/dQw4w9WgXcQ",
  "```",
  "",
  "끝",
].join("\n");

/** CSP 하에서 호스트 페이지를 띄우고 초기 빌드 완료를 기다린다(위반 수집 포함). */
async function openHostUnderCsp(
  context: BrowserContext,
): Promise<{ page: Page; violations: () => CspViolation[] }> {
  const page = await context.newPage();
  const violations = await collectCspViolations(page);
  await installTauriMock(page);
  await page.goto("/?plugin-host=1");
  await page.waitForSelector("body[data-host-ready]", {
    state: "attached",
    timeout: 10_000,
  });
  return { page, violations };
}

test("좁힌 CSP에서 샌드박스·플러그인·임베드·에디터가 위반 0으로 동작한다", async ({
  context,
}) => {
  // 외부 임베드는 로컬 스텁으로 차단(실제 유튜브 로드 없음 — DOM만 검증).
  const host = await openHostUnderCsp(context);

  const note = await context.newPage();
  const noteViolations = await collectCspViolations(note);
  await note.route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>stub</title>",
    }),
  );
  await installTauriMock(note, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: CONTENT, meta: { overrides: {} } },
      note_list: [{ id: "alpha-id", title: "Alpha", hidden: false }],
    },
  });
  await note.goto("/?note=csp");
  await expect(note.locator(".cm-editor")).toBeVisible();

  // ① 샌드박스 부트스트랩(sha256) + 플러그인 코드(blob) 동작 → 위키링크 데코레이션.
  await expect(note.locator(".cm-x-wikilink-wikilink")).toBeVisible({
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  await expect(note.locator(".cm-x-wikilink-wikilink")).toContainText("Alpha");

  // ② 임베드 iframe(https 프레임) 렌더 — blob 스크립트가 등록한 디스크립터의 게이트 통과.
  await expect(note.locator(".cm-embed-frame")).toHaveCount(1, {
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  await expect(note.locator(".cm-embed-frame")).toHaveAttribute(
    "src",
    /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/,
  );

  // ③ CM 에디터 런타임 스타일 정상: 주입된 <style>이 실제로 적용된다(cm-content 폰트 등).
  const fontFamily = await note.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? getComputedStyle(el).fontFamily : "";
  });
  expect(fontFamily.length).toBeGreaterThan(0);

  // 플러그인 로드가 실제로 blob 스크립트를 태웠는지 확인(호스트 페이지에 샌드박스 iframe 존재).
  // 개수는 번들 폴더 수에서 유도한다(e2e 목은 OS를 알려주지 않아 전부 실행된다).
  await expect(host.page.locator("iframe[data-plugin-sandbox]")).toHaveCount(
    bundledPluginCount(),
    {
      timeout: SNAPSHOT_UI_TIMEOUT,
    },
  );

  // ④ 위반 0건 — 문서 이벤트 + 프레임 콘솔 양쪽.
  const hostConsole = host.violations();
  const noteConsole = noteViolations();
  const hostDocEvents = await documentCspEvents(host.page);
  const noteDocEvents = await documentCspEvents(note);

  expect(
    { hostConsole, noteConsole, hostDocEvents, noteDocEvents },
    "CSP 위반이 감지되면 안 된다(좁힌 정책에서 전 기능 동작)",
  ).toEqual({
    hostConsole: [],
    noteConsole: [],
    hostDocEvents: [],
    noteDocEvents: [],
  });
});

test("네거티브 컨트롤: script-src에서 blob: 제거 시 플러그인 로드가 거부되고 수집기가 잡는다", async ({
  context,
}) => {
  // "정상 경로의 위반 0"이 수집기 사망이 아니라 진짜 0임을 자기검사로 고정한다: blob:만 뺀
  // 변형 정책에서는 플러그인 코드(불투명 origin의 blob 스크립트) 로드가 CSP에 거부되고,
  // 수집기가 위반을 ≥1건 잡아야 한다. blob 하나만 제거하므로 잡히는 위반은 정확히 그것이다.
  const strict = cspWithoutScriptBlob(PROD_CSP);
  // script-src에서만 blob:가 빠졌는지 확인('self' 바로 뒤 sha256). img-src의 blob:는 유지.
  expect(strict).toMatch(/script-src 'self' 'sha256-/);
  expect(strict).not.toBe(PROD_CSP); // 변형이 실제로 무언가 바꿨다
  expect(strict).toContain("'sha256-"); // 부트스트랩 인라인 허용은 그대로 → 부트스트랩은 뜬다

  const host = await context.newPage();
  const hostViolations = await collectCspViolations(host, strict);
  await installTauriMock(host);
  await host.goto("/?plugin-host=1");
  await host.waitForSelector("body[data-host-ready]", {
    state: "attached",
    timeout: 10_000,
  });
  // 부트스트랩(sha256)은 떴지만 플러그인 blob 스크립트는 거부되므로, 거부가 쌓일 시간을 준다.
  await host.waitForFunction(
    () =>
      (window as unknown as { __csp?: unknown[] }).__csp !== undefined &&
      performance.now() > 1200,
    null,
    { timeout: 5000 },
  );

  const consoleV = hostViolations();
  const docV = await documentCspEvents(host);
  // 불투명 origin 서브프레임(샌드박스)의 blob 거부는 프레임 콘솔로 온다 → 콘솔 수집이 핵심.
  expect(
    consoleV.length + docV.length,
    "blob 제거 시 CSP 위반이 최소 1건 수집돼야 한다(수집기 유효성)",
  ).toBeGreaterThan(0);
  // 잡힌 위반이 실제로 blob 스크립트 거부인지 좁게 확인(엉뚱한 위반이 아님).
  expect(
    consoleV.some((v) => /blob:/.test(v.detail)),
    "수집된 위반은 blob 스크립트 거부여야 한다",
  ).toBe(true);
});

test("주입한 CSP 정책이 프로덕션 정책과 동일하다(픽스처 무결성)", async ({
  context,
}) => {
  // 픽스처가 실제 tauri.conf.json 정책을 그대로 쓰는지 — 느슨한 정책으로 자기기만 방지.
  // (script-src에 unsafe-inline/eval이 없다는 정밀 단언은 csp-policy.test.ts가 담당.)
  expect(PROD_CSP).toContain("default-src 'self'");
  expect(PROD_CSP).not.toContain("unsafe-eval");
  const page = await context.newPage();
  await collectCspViolations(page);
  await installTauriMock(page, { responses: { note_read: null } });
  await page.goto("/?note=probe");
  const applied = await page.evaluate(() => {
    const meta = document.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    return meta?.getAttribute("content") ?? null;
  });
  expect(applied).toBe(PROD_CSP);
});
