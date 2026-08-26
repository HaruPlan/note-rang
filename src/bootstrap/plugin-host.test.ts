/**
 * 중앙 호스트 창의 언어 확정 가드 — `resolveHostLocale`.
 *
 * 이 창은 숨김 상주 창이라 **리로드하지 않는다.** 다른 세 창은 재빌드마다 새 JS 런타임에서
 * 부트스트랩을 다시 타 언어가 저절로 갱신되지만, 이 창의 언어를 갱신하는 것은 매
 * `build()`/`rebuildPlugin()`이 부르는 `deps.activeLocale` 콜백, 곧 이 파일이 검증하는
 * `resolveHostLocale` **하나뿐**이다.
 *
 * ## 이 함수가 등록과 활성 전환을 **둘 다** 한다(가드의 초점)
 *
 * 예전에는 사전 등록만 여기서 하고 `setActiveLocale`은 중앙 호스트가 따로 불렀다. 호스트가
 * 언어팩을 나르지 않게 되면서 그 한 줄이 **이 함수가 등록한 사전에만** 의존하게 됐고, 소유자를
 * 둘로 나눌 이유가 사라져 전환도 이 함수로 들어왔다. 그래서 아래 테스트들은
 * `setActiveLocale`을 **직접 부르지 않는다** — 부르면 이 함수가 전환을 빠뜨려도 통과해 버려,
 * 가드가 검증하려는 바로 그 지점이 사라진다. `resolveHostLocale` 호출 뒤 `activeLocale()`을
 * 그대로 읽는 것이 이 파일의 규칙이다.
 *
 * ## 왜 모듈을 매번 리셋하는가
 *
 * `src/i18n/store.ts`는 창(=JS 런타임)당 하나인 모듈 싱글턴이고 등록을 되돌릴 export가 없다.
 * 여기서 검증하려는 것이 바로 "등록되기 **전** → 등록된 **후**"의 전이라, 테스트마다 깨끗한
 * store가 필요하다 — `vi.resetModules()` + 동적 import로 매번 새 런타임을 흉내 낸다(그래야
 * 파일 전체 실행과 `-t` 단독 실행이 같은 결과를 낸다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 한 "창"을 새로 연 것과 같은 효과 — 갓 만들어진 store와 그것을 쓰는 부트스트랩을 함께 준다. */
async function freshWindow(): Promise<{
  resolveHostLocale: typeof import("./plugin-host").resolveHostLocale;
  store: typeof import("../i18n/store");
}> {
  vi.resetModules();
  const [{ resolveHostLocale }, store] = await Promise.all([
    import("./plugin-host"),
    import("../i18n/store"),
  ]);
  return { resolveHostLocale, store };
}

/**
 * `deps.settings`/`deps.builtinStates`/`deps.localeEntries` 대역 — 값은 클로저로 언제든
 * 바꿀 수 있다.
 *
 * `states`를 안 주면 기본은 빈 맵(=조회 성공, 기록 없음 → 켜짐)이다. **`?? {}`로 쓰지
 * 마라**: 이 테스트들이 구분해야 하는 `null`("모른다")까지 빈 맵으로 접혀, states=null
 * 가드가 조용히 아무것도 검증하지 않게 된다(실제로 처음에 그렇게 썼다가 잡혔다).
 *
 * `entries`를 안 주면 기본은 빈 맵 — "설치된 서드파티 언어팩이 하나도 없다"는, 대다수
 * 사용자의 정상 상태다(백엔드 `read_locale_entries`의 계약도 빈 맵이지 null이 아니다).
 */
function io(read: {
  language: () => string | null;
  states?: () => Record<string, boolean> | null;
  entries?: (locale: string) => Record<string, string>;
}) {
  return {
    settings: async () => ({ language: read.language() }),
    builtinStates: async () => (read.states ? read.states() : {}),
    localeEntries: async (locale: string) =>
      read.entries ? read.entries(locale) : {},
  };
}

beforeEach(() => {
  // 언어 미설정 분기가 OS 로케일을 타므로 한국어로 고정한다(playwright.config의 locale 고정과
  // 같은 이유 — 러너 로케일이 곧 기대값이 되면 어서션이 환경에 따라 갈린다).
  Object.defineProperty(navigator, "language", {
    value: "ko-KR",
    configurable: true,
  });
});

describe("resolveHostLocale", () => {
  /**
   * 가드(핵심 회귀): 부팅 언어가 ko였던 상주 창이 **부팅 이후** en으로 바뀐 설정을 실제로
   * 반영한다.
   *
   * 이 테스트가 없으면 다음이 조용히 되살아난다: 부팅 시 1회만 팩을 로드하면 이 창의 store에
   * en 사전이 영영 없고, `setActiveLocale("en")`이 `locales.has("en")` 검사에서 무시되어
   * 이 창의 t()가 세션 내내 ko로 남는다(파괴적 명령 확인 팝업 문구). 마지막 세 줄이 정확히
   * 그 지점이다 — 이 함수 하나가 사전 등록과 활성 전환을 **둘 다** 끝냈는가.
   */
  it("registers the bundled pack and activates a language chosen after boot", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    let language: string | null = "ko";

    // 부팅: ko — 이 시점엔 en 사전이 이 창에 없는 것이 정상이다(ko 사용자는 영어 바이트를
    // 받지 않는다는 ①단계의 요점).
    expect(await resolveHostLocale(io({ language: () => language }))).toBe(
      "ko",
    );
    expect(store.activeLocale()).toBe("ko");
    expect(store.localeDictionary("en")).toBeUndefined();

    // 사용자가 설정에서 en으로 바꾼다 → 저장 → 호스트 재빌드가 deps.activeLocale을 다시
    // 부른다(central-host: build()의 Promise.all / rebuildPlugin()의 직접 await).
    language = "en";
    expect(await resolveHostLocale(io({ language: () => language }))).toBe(
      "en",
    );

    // 호출부는 반환값을 캐시할 뿐이다 — 전환은 이미 끝나 있어야 한다.
    expect(store.activeLocale()).toBe("en");
    expect(store.localeDictionary("en")?.["settings.tree.node-theme"]).toBe(
      "Theme",
    );
  });

  /**
   * 가드: 부팅 때 `listBuiltinStates()`가 실패해(states=null → "모르면 안 켠다") 팩을 못
   * 실었더라도, 다음 재빌드에서 조회가 성공하면 그때 실린다.
   *
   * 이 창은 리로드가 없어 예전엔 그 실패가 세션 내내 굳었다 — 매 빌드가 같은 조회를 다시
   * 태우는 지금 배선의 곁가지 이득이다.
   */
  it("recovers on a later rebuild when the boot-time state lookup failed", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    let states: Record<string, boolean> | null = null;
    const deps = io({ language: () => "en", states: () => states });

    expect(await resolveHostLocale(deps)).toBe("en");
    // 사전이 없으니 이 함수 안의 setActiveLocale도 미등록 코드로 무시된다 — 언어 코드는
    // 돌려주되 화면은 ko다(조용한 폴백이 옳은 동작이다).
    expect(store.activeLocale()).toBe("ko");

    states = {}; // 다음 빌드에서는 조회가 성공한다(기록 없음 = 켜짐).
    expect(await resolveHostLocale(deps)).toBe("en");
    expect(store.activeLocale()).toBe("en");
  });

  /** 가드: 사용자가 그 팩을 꺼 뒀으면 등록하지 않는다 — 언어 코드는 그대로 돌려주되
   * `setActiveLocale`이 미등록 코드로 무시해 ko로 남는다(다른 창과 같은 결). */
  it("does not register a pack the user turned off", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    const wanted = await resolveHostLocale(
      io({
        language: () => "en",
        states: () => ({ "language-pack-en": false }),
      }),
    );
    expect(wanted).toBe("en");
    expect(store.activeLocale()).toBe("ko");
    expect(store.localeDictionary("en")).toBeUndefined();
  });

  /**
   * 가드(멱등): 같은 언어로 여러 번 불러도(=재빌드가 반복돼도) 사전이 그대로 살아 있고 언어
   * 드롭다운 순서도 흔들리지 않는다 — `registerBundledLocale`이 Map upsert라는 성질에
   * 이 경로가 실제로 의존한다.
   */
  it("stays correct when called repeatedly (every rebuild)", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    const deps = io({ language: () => "en" });
    for (let i = 0; i < 3; i++) await resolveHostLocale(deps);
    expect(store.activeLocale()).toBe("en");
    // ko가 여전히 첫 항목이고 en이 중복으로 들어가지 않았다(upsert — 삽입 순서 불변).
    expect(store.availableLocales().map((l) => l.code)).toEqual(["ko", "en"]);
  });

  /** 가드: 설정 조회가 실패해도(IO 예외) 호스트 기동을 막지 않고, `resolveLanguage`의 OS
   * 로케일 감지 분기로 폴백한다(catch에서 바로 "ko"로 굳히지 않는다 — 이 창만 다른 세 창과
   * 다른 규칙을 타면 안 된다). 이 파일은 navigator.language를 ko-KR로 고정해 두었다. */
  it("absorbs a failing settings lookup and falls back to OS detection", async () => {
    const { resolveHostLocale } = await freshWindow();
    const wanted = await resolveHostLocale({
      settings: () => Promise.reject(new Error("boom")),
      builtinStates: () => Promise.reject(new Error("boom")),
      localeEntries: () => Promise.reject(new Error("boom")),
    });
    expect(wanted).toBe("ko");
  });

  /**
   * 가드(②단계 핵심): **설치(서드파티)** 언어팩도 이 창에 등록된다.
   *
   * 왜 이 창에 별도 배선이 필요한가: 다른 세 창은 부트스트랩이 이 IPC를 직접 부르지만, 이
   * 창의 부트스트랩은 재빌드마다 다시 돌지 않는다 — 이 함수가 매 빌드 그 자리를 대신한다.
   * 이 배선이 없으면 활성 전환이 미등록 코드로 무시돼 이 창의 t()가 세션 내내 ko로 남는다.
   */
  it("registers an installed third-party pack and activates that language", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    const wanted = await resolveHostLocale(
      io({
        language: () => "xx",
        entries: () => ({ "settings.tree.node-theme": "Xx-Theme" }),
      }),
    );
    expect(wanted).toBe("xx");
    expect(store.activeLocale()).toBe("xx");
    expect(store.localeDictionary("xx")?.["settings.tree.node-theme"]).toBe(
      "Xx-Theme",
    );
  });

  /**
   * 가드: 번들 팩이 공급하는 코드는 서드파티가 **덮지 못한다**(보호 코드 — 이슈 #30).
   *
   * ②단계가 서드파티 사전을 첫 페인트 전으로 끌어오면서 두 경로가 같은 시점에 같은 코드를
   * 등록할 수 있게 됐다. 번들 en이 켜져 있는 한 en은 언제나 앱과 함께 배포·검증된 번역이어야
   * 한다 — 순서가 아니라 `registerLocale`의 보호 집합이 그것을 보장한다는 사실을 고정한다.
   */
  it("does not let an installed pack override a bundled locale", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    await resolveHostLocale(
      io({
        language: () => "en",
        entries: () => ({ "settings.tree.node-theme": "HIJACKED" }),
      }),
    );
    expect(store.activeLocale()).toBe("en");
    expect(store.localeDictionary("en")?.["settings.tree.node-theme"]).toBe(
      "Theme",
    );
  });

  /**
   * 가드: 설치 팩 조회가 실패하거나(IPC 거부) 빈 맵이어도 등록을 시도하지 않고 조용히
   * 넘어간다 — "고를 수는 있는데 전부 ko로 폴백되는" 유령 로케일을 만들지 않는다.
   */
  it("registers nothing when the installed-pack lookup fails or is empty", async () => {
    const { resolveHostLocale, store } = await freshWindow();
    await resolveHostLocale({
      settings: async () => ({ language: "xx" }),
      builtinStates: async () => ({}),
      localeEntries: () => Promise.reject(new Error("boom")),
    });
    expect(store.localeDictionary("xx")).toBeUndefined();

    await resolveHostLocale(io({ language: () => "yy", entries: () => ({}) }));
    expect(store.localeDictionary("yy")).toBeUndefined();
  });
});
