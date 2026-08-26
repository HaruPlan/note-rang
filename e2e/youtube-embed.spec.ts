import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// 유튜브 임베드 1st-party 플러그인을 WebKit에서 검증한다: 중앙 호스트 샌드박스에서 등록한
// 블록 임베드 디스크립터가 스냅샷으로 노트 창에 배달돼 ```youtube 펜스를 격리 iframe 블록
// 위젯으로 렌더하고, 커서가 블록에 들어가면 원문이 드러난다. per-plugin 도메인 게이트
// (granted `embed:<domain>`)가 디스크립터 전달 후에도 유지되는지(eviltube 거부) 함께
// 확인한다. 외부 네트워크는 라우트 스텁으로 차단한다(실제 유튜브 로드 없음).

/** 노트 본문: 승인된 유튜브 펜스 + 미승인 도메인 펜스 + 꼬리 문단(기본 커서 위치). */
const CONTENT = [
  "```youtube",
  "https://youtu.be/dQw4w9WgXcQ",
  "```",
  "",
  "```eviltube",
  "https://watch.evil.example/w?v=zzz",
  "```",
  "",
  "끝",
].join("\n");

// 미승인 도메인 게이트 검증용 설치 플러그인: embed:evil.example을 선언만 하고 로컬 부여는
// 없다 → 등록은 되지만(호스트) 렌더는 노트 창 게이트가 거부해야 한다.
const INSTALLED = [
  {
    id: "eviltube",
    name: "Evil Tube",
    version: "1.0.0",
    permissions: ["editor", "embed:evil.example"],
    enabled: true,
    granted: ["editor"],
  },
];

const EVIL_CODE =
  'memo.editor.registerBlockEmbed({ id: "eviltube", fence: "eviltube",' +
  ' sources: [{ host: "watch.evil.example", queryParam: "v" }],' +
  ' embedTemplate: "https://evil.example/e/{id}" });';

test.beforeEach(async ({ page, context }) => {
  // 설치 플러그인은 중앙 호스트가 실행한다(코드 읽기도 호스트 쪽 IPC).
  await openPluginHost(context, {
    responses: {
      list_installed_plugins: INSTALLED,
      read_plugin_code: EVIL_CODE,
    },
  });
  // 외부 임베드 요청을 로컬 스텁으로 응답해 실제 네트워크 로드를 차단한다(노트 페이지).
  await page.route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>stub</title>",
    }),
  );
  await installTauriMock(page, {
    responses: {
      ensure_plugin_host: true,
      note_read: { content: CONTENT, meta: { overrides: {} } },
    },
  });
  await page.goto("/?note=embed");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("```youtube 펜스가 격리 iframe 블록 위젯으로 렌더된다", async ({
  page,
}) => {
  // 호스트 스냅샷 적용 후 승인된 펜스만 위젯이 된다(미승인 eviltube는 제외).
  const frame = page.locator(".cm-embed-frame");
  await expect(frame).toHaveCount(1, { timeout: SNAPSHOT_UI_TIMEOUT });
  // RMF 클라이언트 식별 파라미터(origin·widget_referrer — Error 153 대응)까지 포함한 최종 URL.
  await expect(frame).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" +
      "?origin=https%3A%2F%2Fgithub.com" +
      "&widget_referrer=https%3A%2F%2Fgithub.com%2FHaruPlan%2Fnote-rang",
  );
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  await expect(frame).toHaveAttribute(
    "referrerpolicy",
    "strict-origin-when-cross-origin",
  );
  // 본문 소스는 위젯으로 가려진다(마크다운 원문은 파일에만 존재).
  await expect(page.locator(".cm-content")).not.toContainText("youtu.be");
});

test("미승인 도메인 임베드는 위젯 없이 원문 코드펜스로 남는다", async ({
  page,
}) => {
  // 승인된 유튜브 위젯이 뜰 때까지 기다린다(플러그인 로드 완료 신호).
  await expect(page.locator(".cm-embed-frame")).toHaveCount(1, {
    timeout: SNAPSHOT_UI_TIMEOUT,
  });
  // eviltube 펜스는 게이트가 거부해 원문 그대로 보인다(조용한 실패).
  await expect(page.locator(".cm-content")).toContainText("watch.evil.example");
});

test("커서가 블록에 들어가면 원문이 드러나고 나오면 다시 위젯이 된다", async ({
  page,
}) => {
  await expect(page.locator(".cm-embed-frame")).toHaveCount(1, {
    timeout: SNAPSHOT_UI_TIMEOUT,
  });

  // 마지막 문단("끝")을 클릭해 포커스를 얻고, 문서 처음(펜스 첫 줄)으로 이동한다.
  // `Mod-Home`/`Mod-End`를 쓰는 이유: CodeMirror의 `Cmd-ArrowUp`/`Cmd-ArrowDown`(문서
  // 시작/끝)은 **맥 전용** 바인딩이라 Windows/Linux에서는 아무 데도 안 걸린다 —
  // `standardKeymap`의 `Mod-Home`/`Mod-End`가 두 플랫폼 모두에서 같은 명령으로 간다.
  await page.getByText("끝").click();
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.locator(".cm-embed-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("youtu.be");

  // 블록 밖(문서 끝)으로 나오면 다시 위젯으로 렌더된다.
  await page.keyboard.press("ControlOrMeta+End");
  await expect(page.locator(".cm-embed-frame")).toHaveCount(1);
});

test("마크다운 프리뷰를 끄면 유튜브 임베드도 원문 코드펜스로 보인다", async ({
  page,
}) => {
  // 프리뷰 켜짐(기본) — 임베드 위젯이 뜬다.
  await expect(page.locator(".cm-embed-frame")).toHaveCount(1, {
    timeout: SNAPSHOT_UI_TIMEOUT,
  });

  // 툴바에서 마크다운 프리뷰를 끈다 → 플러그인 렌더(임베드)도 원문으로 돌아와야 한다.
  await page.locator("#app").hover();
  await page.locator('.note-toolbar-btn[title="마크다운 프리뷰"]').click();

  await expect(page.locator(".cm-embed-frame")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("youtu.be");
});
