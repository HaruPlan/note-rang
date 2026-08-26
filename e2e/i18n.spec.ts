import { test, expect } from "@playwright/test";
import { installTauriMock } from "./support/tauri-mock";

// UI 언어 확정 체인을 검증한다: 저장된 `language` → 없으면 OS/브라우저 로케일 자동 감지
// (`src/i18n/detect.ts`, 이슈 #30) → `setActiveLocale`(미등록 코드는 무시) → 설정·패널 창 렌더.
//
// **영어는 번들 언어팩이다**(`src/plugin/builtin/language-packs/language-pack-en/`을 각 창
// 부트스트랩이 로컬에서 직접 읽어 첫 페인트 전에 등록한다 — `src/i18n/packs.ts`, 이슈 #30 →
// ①단계. 예전엔 `src/i18n/en.json`을 store.ts가 정적 시드했다). (a)·(d)·(e)가 그 경로다.
//
// **서드파티(설치) 언어팩은 코어(Rust)가 설치 매니페스트를 직접 스캔해 공급한다**(②단계 —
// `list_language_packs`/`read_locale_entries`). 그래서 아래 (b)·(c)는 **플러그인 호스트를
// 아예 띄우지 않는다**: 그것이 이 단계의 요점이다 — 샌드박스 실행도, 스냅샷 왕복도, 뒤늦은
// 리로드도 없이 **첫 페인트부터** 그 언어로 뜬다.
//
// 픽스처가 en이 아니라 합성 로케일 `xx`인 이유: en은 번들 팩이 먼저 등록해 보호 코드가 되므로
// 서드파티가 등록해도 영구히 무시된다(이슈 #30) — en으로는 서드파티 경로가 실제로 살아 있는지
// 구분할 수 없다("영어로 보인다"가 번들 덕인지 설치 팩 덕인지 알 수 없다). `xx`는 어떤 번들도
// 공급하지 않으므로, 화면에 뜨면 그것은 오직 새 IPC 경로가 동작했다는 뜻이다.
//
// 로케일은 `playwright.config.ts`가 ko-KR로 고정한다 — 자동 감지 자체는 (e)가
// `test.use({ locale })`로 en 쪽 분기를 따로 덮는다.

const KO_SETTINGS = { schema_version: 1, theme: "sj_d", defaults: {} };
const EN_SETTINGS = { ...KO_SETTINGS, language: "en" };
const XX_SETTINGS = { ...KO_SETTINGS, language: "xx" };

/** `list_language_packs`가 돌려줄 카탈로그(Rust `LanguagePackEntry` — camelCase). */
const XX_CATALOG = [
  { code: "xx", label: "Test Language", pluginId: "language-pack-xx" },
];

/**
 * `read_locale_entries`가 돌려줄 사전 — **소수 키만** 담는다.
 *
 * 전 커버리지가 필요 없는 이유: 놓친 키는 ko로 폴백되는 것이 정상 동작이고(`t()`의 폴백
 * 체인), 이 스펙이 고정하려는 것은 "공급된 키가 첫 페인트에 실제로 닿는가" 하나다. 키는
 * `src/i18n/ko.json`에 실재해야 한다 — `validateLocaleEntries`가 ko 사전에 없는 키를
 * 소비 시점에 버린다.
 */
const XX_ENTRIES = {
  "settings.language.picker-label": "Xx-Language",
  "settings.theme.picker-label": "Xx-Theme",
  "settings.tree.search-placeholder": "Xx-Search settings",
  "panel.search.placeholder": "Xx-Search notes",
};

test("(a) language 미설정 + 한국어 로케일 → 설정 창이 한국어로 렌더된다(자동 감지 ko 분기)", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: KO_SETTINGS,
      list_installed_plugins: [],
    },
  });
  await page.goto("/?settings=1");

  await expect(page.locator('label[for="settings-language"]')).toHaveText(
    "언어",
  );
  await expect(page.locator('label[for="settings-theme"]')).toHaveText("테마");
  await expect(page.locator(".settings-language")).toHaveValue("ko");
  // 서드파티 언어팩이 하나도 없어도 드롭다운 후보는 둘(ko 코어 + 번들 en)이다 — 설정 창이
  // 마운트 때 `loadEnabledBundledPacks`로 켜져 있는 번들 팩을 전부 등록하기 때문이다.
  // 이 개수가 1이면 그 배선이 끊겼다는 뜻이다(회귀, 이슈 #30).
  await expect(page.locator(".settings-language option")).toHaveCount(2);
  await expect(
    page.locator('.settings-language option[value="en"]'),
  ).toHaveText("English");
});

test.describe("(e) 자동 감지 en 분기", () => {
  // 이 블록만 영어 로케일로 돈다 — 실제 영어 OS 사용자의 첫 실행(설정에 language가 아직
  // 없는 상태)을 재현한다. CI 러너가 영어 로케일이라 예전엔 이 분기가 **모든** 테스트에
  // 조용히 적용돼 한국어 어서션을 전부 깼다(config의 locale 고정이 그 원인을 없앴다).
  test.use({ locale: "en-US" });

  test("language 미설정 + 영어 로케일 → 설정 창이 영어로 렌더된다", async ({
    page,
  }) => {
    await installTauriMock(page, {
      responses: {
        get_shared_settings: KO_SETTINGS, // language 키가 없다(미설정).
        list_installed_plugins: [],
      },
    });
    await page.goto("/?settings=1");

    await expect(page.locator('label[for="settings-language"]')).toHaveText(
      "Language",
    );
    await expect(page.locator(".settings-language")).toHaveValue("en");
  });

  test("영어 로케일이어도 저장된 language:ko가 이긴다(명시 설정 우선)", async ({
    page,
  }) => {
    await installTauriMock(page, {
      responses: {
        get_shared_settings: { ...KO_SETTINGS, language: "ko" },
        list_installed_plugins: [],
      },
    });
    await page.goto("/?settings=1");

    await expect(page.locator('label[for="settings-language"]')).toHaveText(
      "언어",
    );
    await expect(page.locator(".settings-language")).toHaveValue("ko");
  });
});

test("(b) 설치 언어팩(xx) + language:xx → 플러그인 호스트 없이 설정 창이 첫 페인트부터 xx로 렌더된다", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: XX_SETTINGS,
      list_language_packs: XX_CATALOG,
      read_locale_entries: XX_ENTRIES,
    },
  });
  await page.goto("/?settings=1");

  // 설치 팩이 공급한 키가 실제로 화면에 닿는다.
  await expect(page.locator('label[for="settings-language"]')).toHaveText(
    "Xx-Language",
  );
  await expect(page.locator('label[for="settings-theme"]')).toHaveText(
    "Xx-Theme",
  );
  await expect(page.locator(".settings-tree-search")).toHaveAttribute(
    "placeholder",
    "Xx-Search settings",
  );

  // 공급하지 않은 키는 ko로 폴백된다(전 커버리지를 요구하지 않는 것이 정상 — `t()`의 폴백
  // 체인). 이 어서션이 없으면 "xx가 통째로 무시되고 ko로 굳은" 실패와 구분되지 않는다:
  // 위 세 줄이 xx인데 이 줄이 ko여야 폴백이 살아 있다는 뜻이다.
  await expect(
    page.locator('.settings-tree-item[data-node="recovery"]'),
  ).toContainText("메모 복구");

  // 드롭다운 후보는 셋이다: ko(코어) + en(번들 팩) + xx(설치 팩). 라벨은 **카탈로그의 값**을
  // 쓴다 — 다른 창은 코드를 그대로 쓰지만 설정 창만 `list_language_packs`의 label을 읽는다.
  await expect(page.locator(".settings-language option")).toHaveCount(3);
  await expect(page.locator(".settings-language")).toHaveValue("xx");
  await expect(
    page.locator('.settings-language option[value="xx"]'),
  ).toHaveText("Test Language");
});

test("(b2) 설치 언어팩이 en을 등록하려 해도 번들 en이 이긴다(보호 코드)", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: EN_SETTINGS,
      // 설치 팩이 en을 가로채려 한다(악의적이거나 실수 — 이슈 #30이 막으려던 바로 그 상황).
      list_language_packs: [
        { code: "en", label: "Hijacked", pluginId: "language-pack-evil" },
      ],
      read_locale_entries: {
        "settings.language.picker-label": "HIJACKED",
      },
    },
  });
  await page.goto("/?settings=1");

  // 번들 en 팩이 먼저 등록해 "en"을 보호 집합에 넣으므로 설치 팩의 값은 무시된다.
  await expect(page.locator('label[for="settings-language"]')).toHaveText(
    "Language",
  );
  // 라벨도 번들 팩의 것이 남는다(드롭다운 표시까지 가로채이지 않는다).
  await expect(
    page.locator('.settings-language option[value="en"]'),
  ).toHaveText("English");
  await expect(page.locator(".settings-language option")).toHaveCount(2);
});

test("(c) 설치 언어팩(xx) + language:xx → 패널 창도 첫 페인트부터 xx로 렌더된다", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: XX_SETTINGS,
      list_language_packs: XX_CATALOG,
      read_locale_entries: XX_ENTRIES,
      note_list: [],
    },
  });
  await page.goto("/?panel=1");

  // 패널은 카탈로그를 조회하지 않고 `read_locale_entries(language)` 한 번만 쓴다(라벨이
  // 필요 없는 창 — 코드를 그대로 등록한다).
  await expect(page.locator(".panel-search")).toHaveAttribute(
    "placeholder",
    "Xx-Search notes",
  );
});

test("(d) 언어팩 없이 language:en만 저장돼도 영어로 렌더된다(번들 en 팩)", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: EN_SETTINGS,
      list_installed_plugins: [],
    },
  });
  await page.goto("/?settings=1");

  // "en"은 앱과 함께 실리는 번들 언어팩이 공급한다 — 플러그인 호스트가 아예 없어도(설치
  // 목록 비어 있음) 영어가 나온다. 서드파티 언어팩만이 en을 공급하던 시절에는 이 경우 ko로
  // 접혔다. 번들 팩의 활성 판정 입력은 `list_builtin_states`이고, e2e 목의
  // `CONTRACT_DEFAULTS`가 그 계약(빈 맵)을 이미 지키므로 이 스펙은 따로 목을 두지 않는다.
  await expect(page.locator('label[for="settings-language"]')).toHaveText(
    "Language",
  );
  await expect(page.locator('label[for="settings-theme"]')).toHaveText("Theme");
  await expect(page.locator(".settings-language")).toHaveValue("en");
});

test("(d2) 등록되지 않은 언어 코드가 저장돼 있으면 ko를 유지한다(방어 가드)", async ({
  page,
}) => {
  await installTauriMock(page, {
    responses: {
      get_shared_settings: { ...KO_SETTINGS, language: "zz" },
      list_installed_plugins: [],
    },
  });
  await page.goto("/?settings=1");

  // 미설치 언어팩 코드가 설정에 남아 있어도(팩 삭제 등) 화면 전체가 키 폴백으로 깨지지
  // 않는다 — store.ts의 setActiveLocale이 등록되지 않은 코드를 조용히 무시한다.
  await expect(page.locator('label[for="settings-language"]')).toHaveText(
    "언어",
  );
  await expect(page.locator('label[for="settings-theme"]')).toHaveText("테마");
});
