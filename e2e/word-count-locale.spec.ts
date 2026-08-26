import { test, expect } from "@playwright/test";
import {
  installTauriMock,
  openPluginHost,
  SNAPSHOT_UI_TIMEOUT,
} from "./support/tauri-mock";

// word-count 상태 아이템 문구가 언어 왕복(ko→en→ko) 뒤에도 활성 로케일을 따르는지
// 고정한다 — main.js가 `S`를 플러그인 시작 시 1회만 고르고 재사용하는데, 재빌드마다
// 샌드박스가 통째로 새로 실행되므로 이론상 매 재빌드가 새 `S`를 고른다. 이 테스트는
// `get_shared_settings`의 `language` 응답을 왕복시켜 실제 재빌드 경로로 검증한다.

test("word-count 상태 아이템이 언어 왕복 후에도 활성 로케일 문구를 보인다", async ({
  context,
}) => {
  const sharedSettings = (language: string) => ({
    schema_version: 1,
    theme: "sj_d",
    language,
    defaults: {},
  });

  // 호스트: 처음엔 ko.
  const host = await openPluginHost(context, {
    responses: { get_shared_settings: sharedSettings("ko") },
  });

  const note = await context.newPage();
  await installTauriMock(note, {
    responses: {
      ensure_plugin_host: true,
      get_shared_settings: sharedSettings("ko"),
      note_read: { content: "hello world", meta: { overrides: {} } },
      note_list: [],
    },
  });
  await note.goto("/?note=locale-roundtrip");
  // word-count는 두 세그먼트로 뜬다("N 단어"·"M 자") — 왕복 검증은 "단어" 세그먼트 하나로
  // 충분하다(같은 S 사전에서 함께 고르므로 나머지도 같은 결로 갱신된다).
  const status = note.locator(
    '.note-toolbar-status[data-item-key="plugin:word-count:status:word-count-words"]',
  );
  await expect(status).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
  await expect(status).toContainText("단어", { timeout: SNAPSHOT_UI_TIMEOUT });

  /** 호스트 페이지의 `get_shared_settings` 응답 언어를 바꾸고 재빌드 → 노트 리로드를 기다린다. */
  async function switchLocale(lang: string, expectSubstring: string) {
    await host.evaluate((l) => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      };
      const orig = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "get_shared_settings") {
          return Promise.resolve({
            schema_version: 1,
            theme: "sj_d",
            language: l,
            defaults: {},
          });
        }
        return orig(cmd, args as Record<string, unknown>);
      };
    }, lang);
    await note.evaluate(() => {
      (window as unknown as { __pre?: boolean }).__pre = true;
    });
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
    await note.waitForFunction(
      () => !(window as unknown as { __pre?: boolean }).__pre,
      null,
      { timeout: 10_000 },
    );
    await expect(status).toBeVisible({ timeout: SNAPSHOT_UI_TIMEOUT });
    await expect(status).toContainText(expectSubstring, {
      timeout: SNAPSHOT_UI_TIMEOUT,
    });
  }

  // ko → en
  await switchLocale("en", "words");
  // en → ko(왕복) — 여기서 영어 문구가 남아 있으면 회귀.
  await switchLocale("ko", "단어");
});
