import { describe, it, expect } from "vitest";
import {
  BUILTIN_PLUGINS,
  BUILTIN_THEMES,
  pickBuiltinReadme,
  resolveBuiltinPluginNls,
} from "./builtin";
import { SHORTCUT_ACTIONS } from "../shortcuts/actions";
import { parseManifest } from "./manifest";
import { CAPABILITY_CALLS } from "./host";
import { checkPermission, type PluginGrant } from "./permissions";
import { loadPluginFromDir } from "./test-host";
import { findPatternMatches } from "./editor-api";
import { DEFAULT_FONT } from "../theme/font";
import {
  buildEmbedUrl,
  parseBlockEmbedDescriptor,
  type BlockEmbedDescriptor,
} from "./embed";

/**
 * youtube-embed 플러그인의 실제 main.js를 mock memo로 실행해 등록되는 블록 임베드
 * 디스크립터를 추출한다 — 미러 폴더의 아티팩트를 그대로 검증한다(타입 공유 상수 대체).
 */
function extractYoutubeDescriptor(): BlockEmbedDescriptor {
  const code = BUILTIN_PLUGINS.find((p) => p.id === "youtube-embed")!.code;
  let captured: BlockEmbedDescriptor | null = null;
  const memo = {
    editor: {
      registerBlockEmbed: (d: BlockEmbedDescriptor) => {
        captured = d;
      },
      registerInlinePattern: () => {},
      registerCompletion: () => {},
    },
  };
  new Function("memo", code)(memo);
  if (captured === null) {
    throw new Error("youtube 디스크립터를 추출하지 못했습니다");
  }
  return captured;
}

const YOUTUBE_EMBED_DESCRIPTOR = extractYoutubeDescriptor();

/**
 * id로 찾은 번들을 ko 로케일로 nls 해석해 돌려준다(축 2) — `BUILTIN_PLUGINS`의 raw 항목은
 * `nls`를 선언한 번들이면 `name`·`summary`·설정 라벨이 `%키%` 그대로다(해석은 소비 지점
 * 전용, 모듈 최상위에서 굽지 않는다 — `builtin/index.ts` 문서 참고). 이 가드들이 검증하려는
 * 것은 "사용자가 실제로 보는 한국어 문구"이므로, 그 값을 보려면 명시적으로 ko로 해석해야
 * 한다(활성 로케일에 기대지 않는다 — 이 테스트 파일은 무엇을 보든 항상 ko 기준으로 고정).
 */
const ko = (id: string): (typeof BUILTIN_PLUGINS)[number] =>
  resolveBuiltinPluginNls(
    BUILTIN_PLUGINS.find((p) => p.id === id)!,
    "ko",
  );

describe("BUILTIN_PLUGINS", () => {
  /** 가드: 위키링크·복사하기·글자 크기·유튜브 임베드·배경색·폰트 번들이 모두 존재한다. */
  it("bundles wikilink, copy-ai-prompt, font-scale, youtube-embed, background and font", () => {
    const ids = BUILTIN_PLUGINS.map((p) => p.id);
    expect(ids).toContain("wikilink");
    expect(ids).toContain("copy-ai-prompt");
    expect(ids).toContain("font-scale");
    expect(ids).toContain("youtube-embed");
    expect(ids).toContain("background");
    expect(ids).toContain("font");
  });

  /** 가드: 모든 번들은 로드 시 구성되는 매니페스트 검증을 통과한다(형식·알려진 권한). */
  it("every bundled plugin passes manifest validation", () => {
    for (const plugin of BUILTIN_PLUGINS) {
      // 중앙 호스트(central-host)가 항목에서 만드는 매니페스트와 같은 형태로 검증한다.
      const parsed = parseManifest({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        entry: "main.js",
        permissions: plugin.permissions,
      });
      expect(parsed.ok).toBe(true);
      expect(plugin.code.length).toBeGreaterThan(0);
    }
  });

  /** 가드(회귀): 코드가 호출하는 memo.* 네임스페이스에 필요한 권한을 매니페스트가 빠짐없이
   * 선언한다. (복제 플러그인이 settings 권한을 빠뜨려 settings.get이 거부→버튼이 아예 안 뜨던
   * 버그를 잡는다.) 매핑은 host.ts CALL_PERMISSIONS와 일치. */
  it("declares a permission for every memo.* call its code makes", () => {
    const REQUIRES: { pattern: RegExp; perm: string }[] = [
      { pattern: /memo\.settings\./, perm: "settings" },
      // events.on의 **바닥** 권한은 settings다(이름별 추가 권한 notes:read는 호스트 수행부가
      // 따로 판정한다 — host.ts CALL_PERMISSIONS와 host-protocol.ts MEMO_EVENT_PERMISSION).
      { pattern: /memo\.events\./, perm: "settings" },
      // 버튼 없는 명령 등록 — 등록 자체만 저위험 commands이고, run 안에서 부르는
      // 호출들은 각자 자기 권한 게이트를 그대로 탄다.
      { pattern: /memo\.commands\./, perm: "commands" },
      // 플러그인 전용 저장소 — 스코프(local/session/window)와 무관하게 같은 권한이다.
      { pattern: /memo\.storage\./, perm: "storage" },
      { pattern: /memo\.clipboard\./, perm: "clipboard" },
      { pattern: /memo\.theme\.register/, perm: "theme" },
      { pattern: /memo\.background\.register/, perm: "background" },
      { pattern: /memo\.font\.register/, perm: "font" },
      { pattern: /memo\.window\.register/, perm: "window-control" },
      { pattern: /memo\.notes\.current/, perm: "notes:read" },
      // 전체 노트 컬렉션 읽기 — `notes:read`(현재 노트)가 아니라 별도 민감 권한이다.
      // `notes.read`는 `notes.resetOptions`와 접두가 다르므로(`read` vs `rese`) 이대로 안전.
      { pattern: /memo\.notes\.list/, perm: "notes:all-read" },
      { pattern: /memo\.notes\.read/, perm: "notes:all-read" },
      { pattern: /memo\.notes\.duplicate/, perm: "notes:write" },
      // 임의 노트 직접 쓰기(과 함께 예약 해제) — insertText·duplicate와 같은 notes:write.
      { pattern: /memo\.notes\.write/, perm: "notes:write" },
      // 정본이자 유일한 이름은 복수형 notes.resetOptions다(host.ts CALL_PERMISSIONS에서
      // notes:write로 매핑). 단수 note.resetOptions는 게이트에 없어 UNKNOWN_CALL이다.
      { pattern: /memo\.notes\.resetOptions/, perm: "notes:write" },
      { pattern: /memo\.editor\.insertText/, perm: "notes:write" },
      // 네트워크 중계 — 실제 권한은 URL 호스트에서 파생한 `network:<호스트>`라 도메인마다
      // 다르다(정적 perm으로 못 적는다). 번들 중 network.fetch를 쓰는 것이 없어 아래 본문
      // 검사(코드가 이 패턴이면 perm 선언 필수)는 발화하지 않는다 — 이 항목은 drift-guards의
      // 「모든 실행 가능 호출이 REQUIRES 패턴으로 커버된다」를 만족시키는 커버리지 표식이다.
      // 도메인별 실제 게이트는 host.ts가 `args.url`을 파싱해 한다(builtin이 생기면 이 perm은
      // 그 번들이 선언하는 `network:<그 호스트>`로 갈아야 한다).
      { pattern: /memo\.network\.fetch/, perm: "network:<domain>" },
      // 브라우저 열기 — 도메인별로 쪼개지 않은 단일 민감 권한이라 정적 perm으로 적을 수 있다.
      // 번들 중 이 호출을 쓰는 것이 아직 없어 본문 검사는 발화하지 않는다(커버리지 표식).
      { pattern: /memo\.browser\.open/, perm: "browser:open" },
      // ui는 addToolbarButton/toast/pickList/prompt 어디서든 쓰면 필요.
      { pattern: /memo\.ui\./, perm: "ui" },
      // editor 저위험 등록·글자 델타(insertText는 위에서 notes:write로 별도 처리).
      {
        pattern:
          /memo\.editor\.(registerInlinePattern|registerCompletion|registerBlockEmbed|getFontDelta|setFontDelta)/,
        perm: "editor",
      },
    ];
    for (const plugin of BUILTIN_PLUGINS) {
      for (const { pattern, perm } of REQUIRES) {
        if (pattern.test(plugin.code)) {
          expect(
            plugin.permissions,
            `${plugin.id}: 코드가 ${pattern.source}를 쓰는데 ${perm} 권한 미선언`,
          ).toContain(perm);
        }
      }
    }
  });

  /**
   * 가드(도그푸딩): 능력 등록을 하는 번들은 `kind: "capability"`를 선언하고, 그 선언이
   * **로드까지 살아 남는다**(`BuiltinPlugin.kind`).
   *
   * 왜 이 두 가지를 한 테스트로 묶는가: 선언이 있어도 로더가 필드를 떨어뜨리면 게이트가
   * 번들에만 적용되지 않는 비대칭이 생기고, 로더가 나르더라도 선언이 틀리면 그 번들이
   * 런타임에 `WRONG_PLUGIN_KIND`로 죽는다. 둘 중 하나만 봐서는 어느 쪽도 못 잡는다.
   * (능력 호출 어휘는 `host.ts`의 `CAPABILITY_CALLS`가 단일 출처다 — 능력이 늘면 이 가드가
   * 저절로 따라간다.)
   */
  it("declares kind: capability on every bundle that registers a capability", () => {
    for (const plugin of BUILTIN_PLUGINS) {
      const registers = [...CAPABILITY_CALLS].filter((call) =>
        // `memo.font.register` — prettier가 점 앞뒤로 줄바꿈할 수 있어 공백을 허용한다.
        new RegExp(`memo\\s*\\.\\s*${call.replace(".", "\\s*\\.\\s*")}`).test(
          plugin.code,
        ),
      );
      expect(
        registers.length > 0 ? plugin.kind : "capability",
        `${plugin.id}: ${registers.join("·")}를 부르는데 kind 선언이 어긋남`,
      ).toBe("capability");
    }
  });

  /** 가드: 능력을 등록하지 않는 번들은 `kind: "action"`이다(선언을 빠뜨린 채 두지 않는다 —
   * 미선언은 하위호환 통과라 조용히 게이트 밖으로 새기 때문이다). */
  it("declares kind: action on every bundle that registers no capability", () => {
    for (const plugin of BUILTIN_PLUGINS) {
      if (plugin.kind === "capability") continue;
      expect(plugin.kind, `${plugin.id}: kind 미선언`).toBe("action");
    }
  });

  /** 가드(회귀): 핵심 동작이 플러그인 버튼으로 별칭하는 target(`plugin:<id>:<btn>` — 확대/축소·
   * 옵션 초기화)이 실제 번들 플러그인이 등록하는 버튼 id와 정확히 일치한다. 어긋나면 단축키가
   * 조용히 no-op이 된다(카탈로그 target과 플러그인 버튼 id가 표류하는 걸 막는다). */
  it("every core-action plugin alias resolves to a real bundled plugin button", async () => {
    const aliased = SHORTCUT_ACTIONS.filter((a) =>
      a.target?.startsWith("plugin:"),
    );
    // 확대/축소·옵션 초기화 — 최소 3개는 있어야 한다(별칭 패턴이 아예 사라진 것도 회귀).
    expect(aliased.length).toBeGreaterThanOrEqual(3);
    for (const action of aliased) {
      const parts = action.target!.split(":");
      const pluginId = parts[1];
      const buttonId = parts.slice(2).join(":");
      const plugin = BUILTIN_PLUGINS.find((p) => p.id === pluginId);
      expect(
        plugin,
        `${action.id}: 대상 플러그인 ${pluginId} 없음`,
      ).toBeDefined();
      // 플러그인 코드를 mock memo로 실행해 등록되는 버튼 id를 수집한다(버튼 등록은
      // settings.get().then 안에서 일어나므로 마이크로태스크를 흘려 기다린다).
      const ids: string[] = [];
      const memo = {
        settings: { get: () => Promise.resolve(undefined) },
        ui: { addToolbarButton: (b: { id: string }) => ids.push(b.id) },
        editor: {
          getFontDelta: () => Promise.resolve(0),
          setFontDelta: () => Promise.resolve(0),
        },
        note: { resetOptions: () => {} },
        notes: { duplicate: () => Promise.resolve() },
      };
      new Function("memo", plugin!.code)(memo);
      await Promise.resolve();
      await Promise.resolve();
      expect(
        ids,
        `${action.id}: 버튼 "${buttonId}" 미등록 — 단축키가 no-op이 된다`,
      ).toContain(buttonId);
    }
  });

  /** 가드: 모든 번들 README가 사용자용 "이렇게 써요" 섹션과 실질 본문을 갖춘다. 권한은 상세
   * 뷰가 친근한 라벨로 보여주므로(permissionInfo) README엔 raw 권한 문자열을 나열하지 않는다.
   * 선언-호출 정합성은 별도 가드("declares a permission for every memo.* call")가 지킨다. */
  it("every bundled plugin ships a user-facing readme with a usage section", () => {
    for (const plugin of BUILTIN_PLUGINS) {
      expect(plugin.readme).toContain("## 이렇게 써요");
      expect(plugin.readme.length).toBeGreaterThan(40);
      // 개발자용 raw 권한 나열은 하지 않는다(UI가 친근한 라벨로 보여줌).
      expect(plugin.readme).not.toContain("## 권한");
    }
  });

  /** 가드: 설정 스키마가 있는 번들은 README에 "바꿀 수 있는 것" 섹션과 각 설정 라벨이 있다
   * (사용자용 헤딩 — 추상적 "설정" 대신 "내가 뭘 바꿀 수 있지?"에 답한다). */
  it("bundled plugins with settings document them in the readme", () => {
    for (const raw of BUILTIN_PLUGINS) {
      if (!raw.settings) continue;
      // README는 항상 한국어 원문(로케일 변형과 무관하게 기본 파일) — 라벨도 ko로 해석해
      // 대조한다(raw는 nls 선언 번들이면 `%키%`라 문자열 그대로는 README에 없다).
      const plugin = ko(raw.id);
      expect(plugin.readme).toContain("## 이런 걸 바꿀 수 있어요");
      for (const field of plugin.settings!) {
        expect(plugin.readme).toContain(field.label);
      }
    }
  });

  /**
   * 가드(축 2 도그푸딩): 대표 번들 둘(font·copy-ai-prompt)이 `README.en.md` 변형을 실제로
   * 갖고 있고, 로더가 그 원문을 `readmeLocales.en`으로 모은다(기본 `readme`와는 다른 내용 —
   * 두 파일이 같은 값이면 로더가 변형을 못 찾고 기본으로 계속 폴백해도 이 가드가 못 잡는다).
   * `pickBuiltinReadme`가 "en"에서 그 변형을, 미번역 로케일("fr")에서는 기본으로 폴백하는
   * 것까지 실증한다(Rust `read_plugin_readme`의 로케일 우선순위와 같은 계).
   */
  it("font and copy-ai-prompt ship a README.en.md variant the loader picks up", () => {
    for (const id of ["font", "copy-ai-prompt"]) {
      const plugin = BUILTIN_PLUGINS.find((p) => p.id === id)!;
      expect(plugin.readmeLocales?.en).toBeDefined();
      expect(plugin.readmeLocales!.en).not.toBe(plugin.readme);
      expect(pickBuiltinReadme(plugin.readme, plugin.readmeLocales, "en")).toBe(
        plugin.readmeLocales!.en,
      );
      // 없는 로케일은 조용히 기본(ko)으로 폴백한다(오류가 아니다).
      expect(pickBuiltinReadme(plugin.readme, plugin.readmeLocales, "fr")).toBe(
        plugin.readme,
      );
    }
  });

  /**
   * 가드(축 2 종단): 번들 매니페스트의 `%키%`+`nls`가 실제로 해석된다 — ko는 원문과 동치
   * (default 사전 = 기존 ko 렌더 결과, 무손실), en은 자기 사전의 영어로 갈아 낀다. 소비
   * 지점(`resolveBuiltinPluginNls`)을 직접 부르는 이 가드가 `settings.ts`가 실제로 쓰는
   * 것과 같은 함수를 검증한다.
   */
  it("resolveBuiltinPluginNls translates bundle names via their own manifest nls", () => {
    const raw = BUILTIN_PLUGINS.find((p) => p.id === "copy-ai-prompt")!;
    expect(raw.name).toBe("%copy-ai-prompt.name%"); // raw는 해석되지 않은 채로 남는다(소비 지점 전용).
    expect(resolveBuiltinPluginNls(raw, "ko").name).toBe("복사하기");
    expect(resolveBuiltinPluginNls(raw, "en").name).toBe("Copy");
    // nls 없는 번들(단축형 wikilink 등은 실제로는 다 nls를 갖지만, 원리를 보이려 undefined
    // nls로 직접 구성한 최소 객체)은 어떤 로케일을 줘도 무변화다(하위호환).
    const noNls = { ...raw, nls: undefined };
    expect(resolveBuiltinPluginNls(noNls, "en")).toBe(noNls); // 참조까지 동일.
  });

  /** 가드: 핵심 사용법 디테일 — 유튜브 펜스 예시, 복사 변수, 글자 델타 %가 문서에 있다. */
  it("readmes carry the concrete usage details", () => {
    const byId = (id: string) => BUILTIN_PLUGINS.find((p) => p.id === id)!;
    expect(byId("youtube-embed").readme).toContain("```youtube");
    expect(byId("copy-ai-prompt").readme).toContain("{path}");
    expect(byId("copy-ai-prompt").readme).toContain("{content}");
    expect(byId("font-scale").readme).toContain("%");
    expect(byId("wikilink").readme).toContain("[[");
  });

  /** 가드: 테마 README는 룩(색 팔레트)을 설명하고 「테마 탭」에서 고르는 법을 안내한다. */
  it("themes ship a readme describing the palette and picker usage", () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(2);
    for (const theme of BUILTIN_THEMES) {
      expect(theme.readme).toContain("## 이렇게 써요");
      expect(theme.readme).toContain("테마 탭");
    }
  });

  /** 가드: 배경색 번들은 memo.background.register로 스와치·자동대비를 공급한다(테마와 분리). */
  it("the background bundle registers a background capability", () => {
    const bg = BUILTIN_PLUGINS.find((p) => p.id === "background")!;
    expect(bg.permissions).toEqual(["background"]);
    expect(bg.code).toContain("memo.background.register");
    expect(bg.code).toContain("autoTextContrast");
  });

  /** 가드: 폰트 번들은 memo.font.register로 폰트 패밀리 목록을 공급한다(색·배경과 분리된 능력). */
  it("the font bundle registers a font capability", () => {
    const font = BUILTIN_PLUGINS.find((p) => p.id === "font")!;
    expect(font.permissions).toEqual(["font"]);
    expect(font.code).toContain("memo.font.register");
    expect(font.code).toContain("families");
  });

  /**
   * 가드(축 2로 갱신): 폰트 번들의 등록값과 [`DEFAULT_FONT`]가 "단일 출처"였던 예전 의미는
   * font main.js가 자기 로컬라이즈 사전을 갖게 되면서(라벨을 memo.i18n.locale()로 스스로
   * 고른다) 더는 문자 그대로 성립하지 않는다 — `DEFAULT_FONT()`는 **호스트** t()(언어팩
   * 설치가 있어야 en을 낸다)로, 번들 자신은 **자기 사전**(언어팩 없이도 en)으로 라벨을
   * 고르는 서로 다른 경로이기 때문이다. 새 의미: (1) **ko에서는 여전히 값이 동치**다(둘 다
   * 지금 한국어 문구를 쓴다 — 우연이 아니라 번들의 `default` 사전이 호스트 ko.json과 같은
   * 문구를 갖고 있어야 한다는 규율), (2) **en에서는 번들 자신의 사전이 이긴다**(호스트
   * `activeLocale()`이 en으로 등록돼 있지 않아도, 즉 언어팩 미설치여도 번들은 스스로
   * 영어를 낸다 — 이게 축 2가 여는 것 자체다). 등록은 `memo.i18n.locale()` 뒤로 미뤄지므로
   * (한 틱) 두 가드 모두 비동기로 플러시한다.
   */
  it("the font bundle's registration matches DEFAULT_FONT in ko", async () => {
    const code = BUILTIN_PLUGINS.find((p) => p.id === "font")!.code;
    let captured: unknown = null;
    new Function("memo", code)({
      font: {
        register: (d: unknown) => {
          captured = d;
          return Promise.resolve(null);
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toEqual(DEFAULT_FONT());
    // 설치된 시스템 글꼴을 후보에 넣으라는 플래그가 켜져 있어야 피커에 「설치된 글꼴」이 뜬다.
    expect(DEFAULT_FONT().includeSystem).toBe(true);
  });

  /**
   * 가드(축 2): 활성 로케일이 en이면 폰트 번들은 **호스트 언어팩 설치 여부와 무관하게**
   * 자기 사전으로 영어 라벨을 낸다 — `DEFAULT_FONT()`(호스트 t(), 언어팩 필요)가 아니라
   * 번들 자신의 `STRINGS.en`이 이긴다는 것을 실증한다(자기 로컬라이즈의 요점).
   */
  it("registers its own English labels when memo.i18n.locale() resolves en, independent of DEFAULT_FONT", async () => {
    const code = BUILTIN_PLUGINS.find((p) => p.id === "font")!.code;
    let captured: unknown = null;
    new Function("memo", code)({
      font: {
        register: (d: unknown) => {
          captured = d;
          return Promise.resolve(null);
        },
      },
      i18n: { locale: () => Promise.resolve("en") },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const families = (captured as { families: { label: string }[] }).families;
    expect(families.map((f) => f.label)).toEqual([
      "System",
      "Serif",
      "Monospace",
    ]);
  });

  describe("copy-ai-prompt", () => {
    const plugin = ko("copy-ai-prompt");

    /** 가드: 이름은 "복사하기"다(일반 복사 용도로 개칭). */
    it('is named "복사하기"', () => {
      expect(plugin.name).toBe("복사하기");
    });

    /** 가드: 필요한 권한(툴바 버튼·토스트·클립보드·현재 노트·복사 문구 설정·설정 액션
     * 버튼이 실행하는 명령)만 선언한다. 버튼 위치는 전역 "툴바 배치"로 옮겨져 더는 플러그인
     * 설정이 아니다. */
    it("declares the minimal permissions it needs", () => {
      expect(plugin.permissions).toEqual([
        "ui",
        "clipboard",
        "notes:read",
        "settings",
        "commands",
      ]);
    });

    /**
     * 가드(회귀): 설정에 **액션 버튼을 두지 않는다.** 명령(`copy-now`)은 단축키 배정용으로
     * 살아 있지만 매니페스트에서 버튼으로 노출하지는 않는다.
     *
     * 왜 되돌리면 안 되나: 설정 창에는 노트가 없어 그 버튼의 창-스코프 호출은 "마지막으로 쓴
     * 메모 창"으로 폴백해야 하는데, 그 컨텍스트는 **메모 창에서 이 플러그인을 한 번 써야**
     * 생긴다(central-host의 EV_BUTTON_INVOKE만이 만든다). 시험용 버튼이 시험하려는 일을 먼저
     * 해야 동작하는 자기모순이라, 설정 화면의 답은 실행이 아니라 「복사 문구」 미리보기다.
     */
    it("exposes copy-now as a shortcut command but not as a settings button", () => {
      expect(plugin.settings?.find((f) => f.type === "button")).toBeUndefined();
      expect(plugin.code).toContain('id: "copy-now"');
    });

    /** 가드(회귀): "버튼 위치" select는 전역 배치로 이관돼 더는 이 플러그인 설정에 없다. */
    it("no longer declares a per-plugin button position setting", () => {
      expect(
        plugin.settings?.find((f) => f.key === "position"),
      ).toBeUndefined();
    });

    /** 가드: 문구 템플릿 설정(text)이 있고 기본값에 {path} 치환 자리가 있다. */
    it("declares a text template setting defaulting with a {path} slot", () => {
      const field = plugin.settings?.find((f) => f.key === "template");
      expect(field).toBeDefined();
      expect(field!.type).toBe("text");
      expect(String(field!.default)).toContain("{path}");
    });

    /** 가드: 템플릿 설정에 사용 가능한 변수({path}·{content})를 안내하는 설명이 있다. */
    it("documents the available variables in the template description", () => {
      const field = plugin.settings?.find((f) => f.key === "template");
      expect(field!.description).toBeDefined();
      expect(field!.description).toContain("{path}");
      expect(field!.description).toContain("{content}");
    });

    /** 가드: 코드가 버튼 등록 + 현재 노트/설정 읽기 + 클립보드 쓰기 + 복사 후 토스트를 쓴다. */
    it("wires notes.current, settings.get, clipboard.write and a toast", () => {
      expect(plugin.code).toContain("memo.ui.addToolbarButton");
      expect(plugin.code).toContain("memo.notes.current");
      expect(plugin.code).toContain("memo.settings.get");
      expect(plugin.code).toContain("memo.clipboard.write");
      expect(plugin.code).toContain("memo.ui.toast"); // "복사됨" 피드백
    });

    /** 가드: 코드가 {path}·{content} 두 변수를 모두 치환한다. */
    it("substitutes both {path} and {content} placeholders", () => {
      expect(plugin.code).toContain("{path}");
      expect(plugin.code).toContain("{content}");
      expect(plugin.code).toContain("note.path");
      expect(plugin.code).toContain("note.content");
    });

    /** 실앱과 같은 노트를 물린 하니스 — 툴바/단축키 두 진입점을 같은 조건으로 비교한다. */
    const runCopyPlugin = () =>
      loadPluginFromDir("src/plugin/builtin/plugins/copy-ai-prompt", {
        settings: { template: "봐줘: {path}\n{content}" },
        stubs: {
          "notes.current": {
            id: "n1",
            path: "/메모/오늘.md",
            content: "본문 열두 자",
          },
        },
      });

    /**
     * 가드(하니스): 단축키로 들어온 명령 경로도 툴바 클릭과 **같은 일**을 한다 — 문구를
     * 치환해 클립보드에 넣고 그 창에 토스트를 띄운다. 정적 문자열 검사는 두 진입점이 같은
     * 본문을 타는지까지는 증명하지 못한다(한쪽만 고쳐 갈라지는 것이 이 형태의 단골 사고다).
     */
    it("copies and toasts the same way when run as a command", async () => {
      const p = await runCopyPlugin();
      await p.runCommand("copy-now");
      expect(
        String(
          (p.callsTo("clipboard.write")[0].args as { text?: unknown }).text ??
            "",
        ),
      ).toBe("봐줘: /메모/오늘.md\n본문 열두 자");
      expect(p.callsTo("ui.toast")).toHaveLength(1);
    });

    /**
     * 가드(소음): 정상 복사는 진단 채널에 **아무것도 남기지 않는다.** 「최근 오류」가 평상시
     * 소음으로 차면 정작 실패가 묻힌다(그 섹션은 조용한 것이 정상이라는 계약).
     */
    it("stays silent in the diagnostics channel on a successful copy", async () => {
      const p = await runCopyPlugin();
      await p.clickButton("copy-ai-prompt");
      expect(p.callsTo("clipboard.write")).toHaveLength(1);
      expect(p.callsTo("runtime.log")).toHaveLength(0);
      expect(p.callsTo("ui.toast")).toHaveLength(1);
    });
  });

  describe("word-count", () => {
    const plugin = ko("word-count");

    /** 가드: 이름은 "단어 수"다. */
    it('is named "단어 수"', () => {
      expect(plugin.name).toBe("단어 수");
    });

    /** 가드: 필요한 권한(상태 아이템·클립보드·현재 노트 읽기·설정 바인딩)만 선언한다.
     * clipboard는 세그먼트 클릭 복사(클릭 확장)를 위해 새로 더해졌다. */
    it("declares the minimal permissions it needs", () => {
      expect(plugin.permissions).toEqual([
        "ui",
        "clipboard",
        "notes:read",
        "settings",
      ]);
    });

    /** 가드: 코드가 두 상태 아이템(단어·글자)을 등록하고, 노트 생명주기로 갱신하며, 클릭
     * 복사(클립보드+토스트)를 배선한다. */
    it("wires two status items, lifecycle refresh, and click-to-copy", () => {
      expect(plugin.code).toContain("memo.ui.addStatusItem");
      expect(plugin.code).toContain("word-count-words");
      expect(plugin.code).toContain("word-count-chars");
      expect(plugin.code).toContain("memo.events.on");
      expect(plugin.code).toContain("note:opened");
      expect(plugin.code).toContain("note:saved");
      expect(plugin.code).toContain("memo.clipboard.write");
      expect(plugin.code).toContain("memo.ui.toast"); // "복사됨" 피드백
    });

    /** 실앱과 같은 노트를 물린 하니스. */
    const runWordCountPlugin = (content: string) =>
      loadPluginFromDir("src/plugin/builtin/plugins/word-count", {
        stubs: {
          "notes.current": { id: "n1", path: "/메모/오늘.md", content },
        },
      });

    /** 가드: 등록 직후(첫 note:opened 전) 두 상태 아이템 모두 0으로 뜨고 클릭 가능(buttonId
     * 대역인 onClick$id 없이도 하니스는 onClick 함수 자체를 붙잡으므로 clickable=true)하다. */
    it("registers both status items at 0 and marks them clickable", async () => {
      const p = await runWordCountPlugin("");
      expect(p.statusItems).toEqual([
        {
          id: "word-count-words",
          text: "0 단어",
          title: "단어 수 — 눌러서 복사",
          position: "bottom-right",
          clickable: true,
        },
        {
          id: "word-count-chars",
          text: "0 자",
          title: "글자 수 — 눌러서 복사",
          position: "bottom-right",
          clickable: true,
        },
      ]);
    });

    /** 가드(핵심): note:opened가 두 상태 아이템을 각각 올바른 단어·글자 수로 갱신한다. */
    it("refreshes both segments on note:opened", async () => {
      const content = "hello there friend";
      const words = (content.trim().match(/\S+/g) ?? []).length;
      const p = await runWordCountPlugin(content);
      await p.emitEvent("note:opened");
      const updates = p.callsTo("ui.updateStatusItem");
      expect(updates).toContainEqual(
        expect.objectContaining({
          args: expect.objectContaining({
            id: "word-count-words",
            text: `${words} 단어`,
          }),
        }),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          args: expect.objectContaining({
            id: "word-count-chars",
            text: `${content.length} 자`,
          }),
        }),
      );
    });

    /**
     * 가드(핵심 — 클릭 확장): "N 단어" 세그먼트를 클릭하면 **그 순간 표시된 것과 같은
     * 문구**("3 단어")를 클립보드에 복사하고 토스트로 확인한다. "M 자" 세그먼트는 독립적으로
     * 자기 문구만 복사한다(서로 섞이지 않는다).
     */
    it("copies exactly the displayed segment text on click, independently per segment", async () => {
      const content = "hello there friend";
      const words = (content.trim().match(/\S+/g) ?? []).length;
      const p = await runWordCountPlugin(content);

      await p.clickStatusItem("word-count-words");
      expect(
        String(
          (p.callsTo("clipboard.write")[0].args as { text?: unknown }).text ??
            "",
        ),
      ).toBe(`${words} 단어`);
      expect(p.callsTo("ui.toast")).toHaveLength(1);

      await p.clickStatusItem("word-count-chars");
      expect(
        String(
          (p.callsTo("clipboard.write")[1].args as { text?: unknown }).text ??
            "",
        ),
      ).toBe(`${content.length} 자`);
      expect(p.callsTo("ui.toast")).toHaveLength(2);
      // 진단 채널은 조용해야 한다(정상 경로 소음 없음, copy-ai-prompt와 같은 계약).
      expect(p.callsTo("runtime.log")).toHaveLength(0);
    });
  });

  describe("font-scale", () => {
    const plugin = ko("font-scale");

    /** 가드: 이름은 "글자 크기"다. */
    it('is named "글자 크기"', () => {
      expect(plugin.name).toBe("글자 크기");
    });

    /** 가드: 필요한 권한(툴바 버튼·토스트·에디터 델타)만 선언한다. 버튼 위치는 전역
     * "툴바 배치"로 옮겨져 settings 권한·설정이 더는 필요 없다(최소 권한). */
    it("declares the minimal permissions it needs", () => {
      expect(plugin.permissions).toEqual(["ui", "editor"]);
    });

    /** 가드(회귀): "버튼 위치" select는 전역 배치로 이관돼 더는 이 플러그인 설정에 없다. */
    it("no longer declares a per-plugin button position setting", () => {
      expect(plugin.settings ?? []).toEqual([]);
    });

    /** 가드: 코드가 A−/A+ 버튼을 달고, 메모 델타를 읽고/쓴 뒤 토스트로 피드백한다. */
    it("wires two toolbar buttons and editor font-delta get/set with a toast", () => {
      expect(plugin.code).toContain("memo.ui.addToolbarButton");
      expect(plugin.code).toContain("memo.editor.getFontDelta");
      expect(plugin.code).toContain("memo.editor.setFontDelta");
      expect(plugin.code).toContain("memo.ui.toast"); // "글자 ±N%" 피드백
      expect(plugin.code).toContain("A−"); // 작게
      expect(plugin.code).toContain("A+"); // 크게
    });
  });

  describe("youtube-embed", () => {
    const plugin = ko("youtube-embed");

    /** 가드: 이름은 "유튜브 임베드"고, 필요한 권한(등록 + 임베드 도메인)만 선언한다. */
    it("declares the minimal permissions it needs", () => {
      expect(plugin.name).toBe("유튜브 임베드");
      expect(plugin.permissions).toEqual([
        "editor",
        "embed:www.youtube-nocookie.com",
      ]);
    });

    /** 가드: 코드는 디스크립터 등록만 한다(변환·검증 로직 없음 — 전부 호스트 수행). */
    it("only registers the block-embed descriptor", () => {
      expect(plugin.code).toContain("memo.editor.registerBlockEmbed");
      expect(plugin.code).not.toContain("fetch");
      expect(plugin.code).not.toContain("document");
    });

    /** 가드: 디스크립터는 브리지 등록 검증을 그대로 통과한다(JSON 직렬화 왕복 포함). */
    it("the descriptor passes the registration validator", () => {
      const roundTripped = JSON.parse(
        JSON.stringify(YOUTUBE_EMBED_DESCRIPTOR),
      ) as Record<string, unknown>;
      expect(parseBlockEmbedDescriptor(roundTripped)).toEqual({
        ok: true,
        descriptor: YOUTUBE_EMBED_DESCRIPTOR,
      });
    });

    /** 가드: 임베드 템플릿의 도메인이 선언 권한과 일치한다(표류 방지). */
    it("the embed template domain matches the declared permission", () => {
      const host = new URL(
        YOUTUBE_EMBED_DESCRIPTOR.embedTemplate.split("{id}").join("probe"),
      ).hostname;
      expect(plugin.permissions).toContain(`embed:${host}`);
    });
  });
});

describe("유튜브 URL 변환(순수)", () => {
  /** 번들과 동일한 grant(선언=부여)로 만든 도메인 게이트. */
  const permissions = BUILTIN_PLUGINS.find(
    (p) => p.id === "youtube-embed",
  )!.permissions;
  const grant: PluginGrant = { declared: permissions, granted: permissions };
  const allow = (domain: string): boolean =>
    checkPermission(grant, `embed:${domain}`).allowed;
  const embed = (source: string): string | null =>
    buildEmbedUrl(YOUTUBE_EMBED_DESCRIPTOR, source, allow);

  /** 변환 결과에서 도메인+경로(영상 위치)만 뽑는다 — 식별 파라미터는 별도 가드가 고정. */
  const embedBase = (source: string): string | null => {
    const url = embed(source);
    if (url === null) return null;
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  };

  const EXPECTED_BASE = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

  /** 가드: watch?v= / youtu.be / shorts 세 형태 모두 nocookie 임베드 URL로 변환된다. */
  it("converts watch, youtu.be, and shorts URLs", () => {
    expect(embedBase("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      EXPECTED_BASE,
    );
    expect(embedBase("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe(
      EXPECTED_BASE,
    );
    expect(embedBase("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      EXPECTED_BASE,
    );
    expect(embedBase("https://youtu.be/dQw4w9WgXcQ")).toBe(EXPECTED_BASE);
    expect(embedBase("https://youtu.be/dQw4w9WgXcQ?si=share")).toBe(
      EXPECTED_BASE,
    );
    expect(embedBase("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      EXPECTED_BASE,
    );
    expect(embedBase("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      EXPECTED_BASE,
    );
  });

  /** 가드(Error 153 대응): 임베드 URL이 RMF 클라이언트 식별 파라미터를 싣는다 —
   * origin(도메인 형식, Referer 불가 웹뷰의 대체 식별) + widget_referrer(임베드 위치 URL). */
  it("carries RMF client-identification query parameters", () => {
    const url = new URL(embed("https://youtu.be/dQw4w9WgXcQ")!);
    expect(url.searchParams.get("origin")).toBe("https://github.com");
    expect(url.searchParams.get("widget_referrer")).toBe(
      "https://github.com/HaruPlan/note-rang",
    );
    // 식별 값은 https URL이어야 한다(RMF의 도메인/URL 식별 형식).
    expect(url.searchParams.get("origin")!.startsWith("https://")).toBe(true);
    expect(
      url.searchParams.get("widget_referrer")!.startsWith("https://"),
    ).toBe(true);
  });

  /** 가드: 유튜브가 아닌 호스트·http·비URL은 변환하지 않는다(원문 유지 경로). */
  it("rejects non-youtube, http, and non-URL sources", () => {
    expect(embed("https://vimeo.com/12345")).toBeNull();
    expect(embed("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(embed("https://evil.youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(embed("메모 텍스트")).toBeNull();
  });

  /** 가드(보안): 번들 grant는 nocookie 도메인만 허용한다 — 다른 도메인은 게이트가 막는다. */
  it("grants only the nocookie domain", () => {
    expect(allow("www.youtube-nocookie.com")).toBe(true);
    expect(allow("www.youtube.com")).toBe(false);
    expect(allow("evil.example")).toBe(false);
  });
});

describe("번들 인라인 패턴 하위호환(param은 opt-in이다)", () => {
  /**
   * 패턴을 등록하는 번들과 그 번들이 실제로 잡아야 하는 본문 한 줄(+ 안쪽 글자).
   *
   * 왜 이 표가 필요한가: `registerInlinePattern`에 `param`(파라미터화 꼬리)이 생기면서
   * 매처 조립부가 바뀌었다. 새 필드를 쓰지 않는 기존 번들이 **한 글자도 다르게 동작하지
   * 않는다**는 것을 실물 아티팩트로 고정한다 — 하위호환 주장을 타입이 아니라 매칭 결과로 건다.
   */
  const LEGACY: [string, string, string][] = [
    ["highlight", "이건 ==중요== 해요", "중요"],
    ["kbd", "복사는 {{Cmd+C}}", "Cmd+C"],
    ["spoiler", "범인은 ||집사||", "집사"],
    ["underline", "++밑줄++ 텍스트", "밑줄"],
    ["superscript", "각주^1^ 참고", "1"],
    ["wikilink", "보라 [[다른 노트]] 끝", "다른 노트"],
  ];

  for (const [id, line, inner] of LEGACY) {
    it(`${id} registers without a param and matches exactly as before`, async () => {
      const p = await loadPluginFromDir(`src/plugin/builtin/plugins/${id}`);
      expect(p.errors).toEqual([]);
      expect(p.rejections).toEqual([]);
      expect(p.patterns.length).toBeGreaterThan(0);
      for (const pattern of p.patterns) {
        expect("param" in pattern, `${id}는 param을 쓰지 않는다`).toBe(false);
      }
      const hit = p.patterns
        .flatMap((pattern) =>
          findPatternMatches(line, pattern.open, pattern.close, pattern.mid),
        )
        .map((m) => line.slice(m.first.from, m.first.to));
      expect(hit).toContain(inner);
    });
  }

  /** 가드: 번들 전체에서 `param`을 쓰는 것은 text-color 하나뿐이다(새 표면의 확산 추적). */
  it("only text-color opts into the parameterized tail", async () => {
    const users: string[] = [];
    for (const [id, plugin] of BUILTIN_PLUGINS.map((p) => [p.id, p] as const)) {
      if (!plugin.code.includes("registerInlinePattern")) continue;
      const p = await loadPluginFromDir(`src/plugin/builtin/plugins/${id}`);
      if (p.patterns.some((pattern) => pattern.param !== undefined)) {
        users.push(id);
      }
    }
    expect(users).toEqual(["text-color"]);
  });
});
