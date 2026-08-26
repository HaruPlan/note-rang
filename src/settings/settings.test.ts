import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  availableThemeNames,
  buildSettingField,
  detailFromInstalled,
  inferPluginCategory,
  FONT_PCT_OPTIONS,
  globalFontPctToPx,
  globalFontPxToPct,
  isThemePluginInfo,
  mountSettings,
  pluginSummary,
  renderApprovalPrompt,
  renderBuiltinList,
  renderMissingList,
  renderPluginDetail,
  renderPluginList,
  renderRejectedList,
  staticPageSearchTerms,
  toolbarPaletteChanged,
  updatePluginDiagnostics,
  TEMPLATE_EN_DEFAULT_TEMPLATES,
  type PluginDetailItem,
} from "./settings";
import { KNOWN_WINDOW_CONTROLS } from "../plugin/window-control";
import type { PluginDiagnostic } from "../plugin/diagnostics";
import type { LayoutPaletteItem } from "./toolbar-layout-editor";
// list 블롭 직렬화는 플러그인 중앙 호스트와 공유하는 순수 모듈로 옮겼다.
import { parseListBlob, serializeListBlob } from "../shared/plugin-settings";
import { registerLocale, setActiveLocale } from "../i18n/store";
import { loadAllBundledPacks, packToBuiltin } from "../i18n/packs";
import type {
  InstalledPlugin,
  InstallPreview,
  MissingPlugin,
  NoteSnapshot,
  NoteSummary,
  RejectedPlugin,
} from "../shared/tauri";
// 파괴적 작업 잠금 회귀(confirmed[19]·confirmed[20]) 전용 — 아래 vi.mock이 이 값들을 제어
// 가능한 목으로 바꾼다("파괴적 작업 잠금" describe 블록 doc-comment 참고).
import {
  changeVaultPath,
  getVaultInfo,
  importBackup,
  inspectBackup,
  inspectVaultFolder,
  listLanguagePacks,
  pickBackupFile,
  pickVaultFolder,
  readLocaleEntries,
  resetSettings,
  wipeAllData,
} from "../shared/tauri";

/**
 * "관리 › 저장 폴더/초기화/백업" 세 페이지(`buildVaultPanel`/`buildResetPanel`/`buildBackupPanel`)는
 * `SettingsDeps` 주입을 거치지 않고 `../shared/tauri`를 직접 호출한다(그 파일들의 doc-comment
 * 참고). 이 파일의 다른 모든 테스트는 이 IPC들을 전혀 부르지 않으므로(`SettingsDeps` 목만으로
 * 마운트), 실제 구현으로 감싸 둔다(`vi.fn(actual.fn)`) — 마운트마다 실행되는
 * `getVaultInfo()`가 테스트 환경에 Tauri 런타임이 없어 reject → "정보를 읽지 못했다" 문구로
 * 떨어지는 기존 동작이 그대로 보존된다. 파괴적 작업 잠금 describe 블록의 테스트만
 * `vi.mocked(fn).mockResolvedValueOnce(...)`로 다음 호출 한 번만 원하는 값으로 바꿔 쓴다.
 */
vi.mock("../shared/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/tauri")>();
  return {
    ...actual,
    // 설치 언어팩 직로드(②단계)도 `SettingsDeps` 주입을 거치지 않고 이 모듈을 직접 부른다
    // (settings.ts의 import 주석 참고) — 위 셋과 같은 이유로 여기서 감싼다. 기본은 실제
    // 구현이라 Tauri 없는 이 환경에서 reject → mountSettings가 흡수(`[]`)하는 기존 동작이
    // 그대로 보존되고, 카탈로그를 실제로 검증하는 테스트만 mockResolvedValue로 덮어쓴다.
    listLanguagePacks: vi.fn(actual.listLanguagePacks),
    readLocaleEntries: vi.fn(actual.readLocaleEntries),
    changeVaultPath: vi.fn(actual.changeVaultPath),
    getVaultInfo: vi.fn(actual.getVaultInfo),
    importBackup: vi.fn(actual.importBackup),
    inspectBackup: vi.fn(actual.inspectBackup),
    inspectVaultFolder: vi.fn(actual.inspectVaultFolder),
    pickBackupFile: vi.fn(actual.pickBackupFile),
    pickVaultFolder: vi.fn(actual.pickVaultFolder),
    resetSettings: vi.fn(actual.resetSettings),
    wipeAllData: vi.fn(actual.wipeAllData),
  };
});

/**
 * 이 파일의 기존 다수 테스트는 "language 미설정 → ko"를 전제로 한국어 문구를 그대로
 * 어서션한다(이슈 #30 전부터 있던 관례). `resolveLanguage`(settings.ts가 이제 그 폴백에
 * 쓴다)는 미설정일 때 `navigator.language`를 본다 — jsdom 기본값("en-US")을 그대로 두면
 * 이 파일의 거의 모든 마운트가 조용히 en으로 넘어가 그 전제를 깬다. 그래서 이 파일 전체의
 * 기본 로케일을 ko로 고정한다. 자동 감지(en) 자체를 검증하는 테스트는 각자
 * `navigator.language`를 필요한 값으로 바꾸고 finally로 복원한다(그 패턴은 아래 "언어를
 * 바꾸면...reload" 가드가 `window.location`을 다루는 방식과 같다).
 */
Object.defineProperty(navigator, "language", {
  value: "ko-KR",
  configurable: true,
});

const plugin = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "p",
  name: "Plugin",
  version: "1.0.0",
  permissions: ["editor"],
  enabled: false,
  granted: [],
  settings_schema: [],
  settings: {},
  ...over,
});

/** 마스터 목록 콜백 묶음(모두 스파이) — 테스트마다 필요한 것만 덮어쓴다. */
const actions = () => ({
  setEnabled: vi.fn(),
  approve: vi.fn(),
  approveReserved: vi.fn(),
  open: vi.fn(),
});

describe("buildSettingField", () => {
  /** 가드: textarea 타입은 여러 줄 입력(textarea)으로 렌더되고 입력마다 onChange가 발화한다. */
  it("renders a <textarea> for type=textarea and fires onChange", () => {
    const changes: unknown[] = [];
    const el = buildSettingField(
      {
        key: "body",
        label: "본문",
        type: "textarea",
        options: [],
        default: "",
      },
      "초기\n값",
      (v) => changes.push(v),
    );
    const area = el.querySelector<HTMLTextAreaElement>(
      "textarea.plugin-setting-textarea",
    );
    expect(area).not.toBeNull();
    expect(area!.value).toBe("초기\n값"); // 현재 값(여러 줄) 선반영
    area!.value = "새 값";
    area!.dispatchEvent(new Event("input"));
    expect(changes).toEqual(["새 값"]);
  });

  /** 가드: text 타입은 한 줄 input으로 렌더된다(textarea 아님). */
  it("renders a single-line input for type=text", () => {
    const el = buildSettingField(
      { key: "p", label: "L", type: "text", options: [] },
      "x",
      () => {},
    );
    const input = el.querySelector<HTMLElement>(".plugin-setting-input");
    expect(input?.tagName).toBe("INPUT");
    expect(el.querySelector("textarea")).toBeNull();
  });
});

/** 상세 뷰 콜백 묶음(모두 스파이). */
const detailActions = () => ({
  back: vi.fn(),
  setGranted: vi.fn(),
  openSettings: vi.fn(),
  checkUpdate: vi.fn(),
  remove: vi.fn(),
  setDevMode: vi.fn(),
  openLink: vi.fn(),
  resolveImage: vi.fn(() => null),
});

/** 상세 모델 픽스처(설치형 기본) — 테스트마다 필요한 것만 덮어쓴다. */
const detailItem = (over: Partial<PluginDetailItem> = {}): PluginDetailItem => {
  const installed = over.installed ?? plugin();
  return {
    kind: "installed",
    id: installed.id,
    name: installed.name,
    version: installed.version,
    sourceLabel: "로컬 설치",
    statusLabel: "활성",
    isTheme: false,
    permissions: installed.permissions,
    schema: installed.settings_schema,
    values: installed.settings,
    readme: null,
    installed,
    ...over,
  };
};

/** 설치 미리보기 픽스처(신규 설치 기본형) — 테스트마다 필요한 것만 덮어쓴다. */
const preview = (over: Partial<InstallPreview> = {}): InstallPreview => ({
  staging: "tok-1",
  manifest: {
    id: "fresh",
    name: "Fresh",
    version: "1.0.0",
    entry: "main.js",
    permissions: ["editor", "notes:read"],
  },
  source: { type: "url", url: "https://x/p.zip" },
  installed_version: null,
  installed_permissions: [],
  installed_granted: [],
  ...over,
});

/** 마이크로태스크+타이머 한 사이클을 비운다(비동기 설치 플로우 반영 대기). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("renderRejectedList", () => {
  /** 가드: 탈락 폴더가 폴더명 + 사유로 보인다 — 이전엔 목록에서 조용히 사라지는 게 유일한
   * 신호였다(설치는 성공했는데 아무것도 안 뜸). */
  it("shows each rejected folder with its reason", () => {
    const el = document.createElement("div");
    renderRejectedList(el, [
      { dir_name: "broken", reason: "manifest.json을 읽을 수 없음" },
      { dir_name: "no-entry", reason: "entry 파일 없음: main.js" },
    ] satisfies RejectedPlugin[]);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("broken");
    expect(el.textContent).toContain("manifest.json을 읽을 수 없음");
    expect(el.textContent).toContain("no-entry");
    expect(el.querySelectorAll(".plugin-rejected-item")).toHaveLength(2);
  });

  /** 가드: 항목이 없으면 배너를 통째로 숨긴다(정상 상태에 잡음을 남기지 않는다). */
  it("hides itself when there is nothing rejected", () => {
    const el = document.createElement("div");
    renderRejectedList(el, [{ dir_name: "x", reason: "y" }]);
    renderRejectedList(el, []);
    expect(el.hidden).toBe(true);
    expect(el.childElementCount).toBe(0);
  });

  /** 가드(신뢰 경계): 폴더명·사유는 사용자가 넣은 폴더에서 온 문자열이라 마크업으로 해석되면
   * 안 된다 — textContent로만 들어가는지 못박는다. */
  it("never interprets folder names or reasons as markup", () => {
    const el = document.createElement("div");
    renderRejectedList(el, [
      { dir_name: "<img src=x onerror=alert(1)>", reason: "<b>굵게</b>" },
    ]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<b>굵게</b>");
  });
});

describe("global font size %↔px", () => {
  /** 가드: 100%는 14px, 그 외 %는 14 기준으로 반올림·클램프(8~48)한다. */
  it("converts % to px around a 14px = 100% base", () => {
    expect(globalFontPctToPx(100)).toBe(14);
    expect(globalFontPctToPx(150)).toBe(21); // round(14×1.5)
    expect(globalFontPctToPx(50)).toBe(8); // round(7) → clamp 하한 8
    expect(globalFontPctToPx(400)).toBe(48); // clamp 상한 48
  });

  /** 가드: px→% 표시 변환은 14px→100%이고, 14의 정수배 %에서 %→px의 역이다(왕복 안정). */
  it("converts px back to % (round-trips at clean option values)", () => {
    expect(globalFontPxToPct(14)).toBe(100);
    expect(globalFontPxToPct(globalFontPctToPx(150))).toBe(150); // 21px
    expect(globalFontPxToPct(globalFontPctToPx(200))).toBe(200); // 28px
  });

  /**
   * 가드(핵심): 후보 % 전부가 pct→px→pct로 왕복한다 — 단순 반올림 역산(80%→11px→79%)으로
   * 셀렉트가 엉뚱한 값을 보이던 회귀를 막는다.
   */
  it("round-trips every FONT_PCT_OPTIONS value (pct→px→pct)", () => {
    for (const pct of FONT_PCT_OPTIONS) {
      expect(globalFontPxToPct(globalFontPctToPx(pct))).toBe(pct);
    }
  });

  /** 가드: 후보와 정확히 안 맞는 저장 px는 가장 가까운 후보 %로 스냅한다(임의 px 관대 처리). */
  it("snaps an off-table px to the nearest option %", () => {
    // 30px는 후보 밖(200%→28px가 가장 가깝다).
    expect(globalFontPxToPct(30)).toBe(200);
  });
});

describe("isThemePluginInfo / availableThemeNames", () => {
  /** 가드: theme 권한을 선언한 플러그인만 테마로 분류한다. */
  it("classifies theme plugins by the theme permission", () => {
    expect(isThemePluginInfo(plugin({ permissions: ["theme"] }))).toBe(true);
    expect(isThemePluginInfo(plugin({ permissions: ["editor"] }))).toBe(false);
  });

  /** 가드: 피커 목록 = 빌트인(sj_d·plain) + 설치 테마 플러그인, 중복 없이. */
  it("lists builtin themes plus installed theme plugins", () => {
    const names = availableThemeNames(
      [
        plugin({ id: "my-theme", permissions: ["theme"] }),
        plugin({ id: "wikilink", permissions: ["editor"] }), // 테마 아님 → 제외
      ],
      "sj_d",
    );
    expect(names).toContain("sj_d");
    expect(names).toContain("plain");
    expect(names).toContain("my-theme");
    expect(names).not.toContain("wikilink");
  });

  /** 가드: 활성 테마가 목록에 없어도(제거 등) 포함해 선택 상태를 유지한다. */
  it("includes the active theme even if it is not otherwise available", () => {
    const names = availableThemeNames([], "ghost-theme");
    expect(names).toContain("ghost-theme");
  });

  /** 가드: 사용자 파생 변형({테마}<custom>)도 피커 목록에 포함된다(색 편집으로 생긴 임시본). */
  it("includes user <custom> variants passed as customNames", () => {
    const names = availableThemeNames([], "sj_d", ["sj_d<custom>"]);
    expect(names).toContain("sj_d<custom>");
    expect(names).toContain("sj_d");
  });

  /** 가드: 권한으로 카테고리를 추론한다(theme/background/font/editor, 그 외 도구). */
  it("infers plugin category from permissions", () => {
    expect(inferPluginCategory(["theme"])).toBe("테마");
    expect(inferPluginCategory(["background"])).toBe("배경");
    expect(inferPluginCategory(["font"])).toBe("폰트");
    expect(inferPluginCategory(["editor", "notes:read"])).toBe("에디터");
    expect(inferPluginCategory(["ui", "clipboard"])).toBe("도구");
  });
});

describe("renderPluginList (마스터 목록)", () => {
  /** 가드: 활성 토글이 setEnabled를, 이름 버튼이 open(상세 열기)을 부른다. */
  it("wires the enable toggle and the name button", () => {
    const list = document.createElement("ul");
    const acts = actions();
    const p = plugin({ id: "x", enabled: false });
    renderPluginList(list, [p], acts);

    const toggle = list.querySelector<HTMLInputElement>(
      ".plugin-enable-toggle",
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(acts.setEnabled).toHaveBeenCalledWith("x", true);

    list.querySelector<HTMLButtonElement>(".plugin-name")!.click();
    expect(acts.open).toHaveBeenCalledWith(p);
  });

  /**
   * 가드: 매니페스트 `summary`가 설치형 행에도 부제로 나온다 — 번들 행의 부제 가드와
   * 대칭이다.
   *
   * 왜: 백엔드는 이 값을 실어 보내는데(Rust `InstalledPlugin.summary`) 프론트에 소비처가
   * 하나도 없어 경계에서 통째로 버려졌다. 저작 문서는 「목록에 표시」라고 단언한다.
   */
  it("shows the manifest summary as the row subtitle", () => {
    const list = document.createElement("ul");
    renderPluginList(
      list,
      [plugin({ id: "x", summary: "메모를 자동 정리합니다" })],
      actions(),
    );
    expect(list.querySelector(".plugin-desc")!.textContent).toBe(
      "메모를 자동 정리합니다",
    );
  });

  /** 가드: `summary` 미선언이면 빈 부제 요소를 만들지 않는다(빈 줄이 생기지 않게). */
  it("omits the subtitle when no summary is declared", () => {
    const list = document.createElement("ul");
    renderPluginList(list, [plugin({ id: "x" })], actions());
    expect(list.querySelector(".plugin-desc")).toBeNull();
  });

  /** 가드: 마스터 행은 압축 표시 — 권한 토글·제거·업데이트는 상세 뷰로 이관돼 없다. */
  it("keeps rows compact (no grant/remove/update controls in the list)", () => {
    const list = document.createElement("ul");
    renderPluginList(
      list,
      [
        plugin({
          permissions: ["editor", "notes:read"],
          granted: ["notes:read"],
          source: { type: "git", url: "https://x/r.git" },
        }),
      ],
      actions(),
    );
    expect(list.querySelector(".plugin-grant")).toBeNull();
    expect(list.querySelector(".plugin-remove")).toBeNull();
    expect(list.querySelector(".plugin-update")).toBeNull();
  });

  /** 가드: 설치된 플러그인이 없으면 안내 문구를 보인다. */
  it("shows an empty message when there are no plugins", () => {
    const list = document.createElement("ul");
    renderPluginList(list, [], actions());
    expect(list.querySelector(".plugin-empty")).not.toBeNull();
    expect(list.querySelector(".plugin-item")).toBeNull();
  });

  /** 가드(D3 잠금): 테마 플러그인은 목록에 보이되 토글 컨트롤이 아예 없고
   * 우측에 🔒 필수 배지(잠금 사유는 배지 툴팁)가 붙는다. 이름으로 상세는 열 수 있다. */
  it("renders theme plugins locked (no toggle, required badge w/ tooltip)", () => {
    const list = document.createElement("ul");
    const acts = actions();
    const theme = plugin({ id: "t", name: "테마", permissions: ["theme"] });
    renderPluginList(
      list,
      [theme, plugin({ id: "w", name: "위키", permissions: ["editor"] })],
      acts,
    );
    const items = list.querySelectorAll(".plugin-item");
    expect(items).toHaveLength(2); // 테마도 목록에 보인다.

    // 카테고리 그룹 순서상 에디터(위키)가 먼저, 테마가 뒤 — 순서 대신 내용으로 찾는다.
    const themeRow = [...items].find(
      (it) => it.querySelector(".plugin-required-badge") !== null,
    )!;
    expect(themeRow.querySelector(".plugin-enable-toggle")).toBeNull(); // 토글 자체가 없다.
    const badge = themeRow.querySelector<HTMLElement>(
      ".plugin-required-badge",
    )!;
    expect(badge.textContent).toBe("🔒 필수");
    // 잠금 사유("테마 탭에서 선택")는 별도 문구가 아니라 배지 툴팁에 있다(레이아웃 통일).
    expect(badge.title).toContain("테마 탭");
    // 비-테마 행(위키)은 기존대로 토글이 있다.
    const wikiRow = [...items].find(
      (it) => it.querySelector(".plugin-enable-toggle") !== null,
    )!;
    expect(wikiRow.querySelector(".plugin-enable-toggle")).not.toBeNull();

    // 이름 버튼으로 상세는 열 수 있고, 토글이 없으니 setEnabled는 어떤 경로로도 불리지 않는다.
    themeRow.querySelector<HTMLButtonElement>(".plugin-name")!.click();
    expect(acts.open).toHaveBeenCalledWith(theme);
    expect(acts.setEnabled).not.toHaveBeenCalled();
  });

  /** 가드: 테마 플러그인만 있어도 행이 렌더된다(빈 안내가 아님 — D3로 목록 표시 대상). */
  it("renders rows (not the empty note) when only theme plugins exist", () => {
    const list = document.createElement("ul");
    renderPluginList(list, [plugin({ permissions: ["theme"] })], actions());
    expect(list.querySelector(".plugin-empty")).toBeNull();
    expect(list.querySelectorAll(".plugin-item")).toHaveLength(1);
    expect(list.querySelector(".plugin-required-badge")).not.toBeNull();
  });

  /** 가드(새 기기 재승인): 민감 권한 선언 + 부여 0이면 "권한 승인 필요" 안내와 승인
   * 버튼이 뜨고, 하나라도 부여됐거나 민감 선언이 없으면 뜨지 않는다. */
  it("shows the approval-needed row only when sensitive perms are all ungranted", () => {
    const acts = actions();
    const list = document.createElement("ul");
    const needy = plugin({
      id: "needy",
      permissions: ["notes:read", "editor"],
      granted: [],
    });
    renderPluginList(
      list,
      [
        needy,
        plugin({
          id: "ok",
          permissions: ["notes:read"],
          granted: ["notes:read"],
        }),
        plugin({ id: "lowrisk", permissions: ["editor"] }),
      ],
      acts,
    );
    const rows = list.querySelectorAll(".plugin-approval-needed");
    expect(rows).toHaveLength(1);
    list.querySelector<HTMLButtonElement>(".plugin-approve-open")!.click();
    expect(acts.approve).toHaveBeenCalledWith(needy);
  });

  /** 가드: 실행 실패 목록에 있는 플러그인엔 ⚠ 오류 배지 + 사유 줄이 붙고, 나머지는 그대로다. */
  it("marks a failed plugin with a badge and a visible reason line", () => {
    const list = document.createElement("ul");
    const broken = plugin({ id: "broken", name: "고장난플러그인" });
    const ok = plugin({ id: "ok", name: "정상플러그인" });
    renderPluginList(list, [broken, ok], actions(), [
      { pluginId: "broken", error: "SyntaxError: 예상치 못한 토큰" },
    ]);
    const items = [...list.querySelectorAll(".plugin-item")];
    const brokenRow = items.find((it) =>
      it.textContent?.includes("고장난플러그인"),
    )!;
    const okRow = items.find((it) => it.textContent?.includes("정상플러그인"))!;
    expect(brokenRow.querySelector(".plugin-failure-badge")).not.toBeNull();
    const note = brokenRow.querySelector(".plugin-desc--failure")!;
    expect(note.textContent).toContain("SyntaxError: 예상치 못한 토큰");
    expect(okRow.querySelector(".plugin-failure-badge")).toBeNull();
    expect(okRow.querySelector(".plugin-desc--failure")).toBeNull();
  });

  /** 가드: 실패 목록을 생략하면(기본값) 배지가 전혀 안 붙는다(하위호환 — 기존 호출부 무변경). */
  it("shows no failure badge when the failures argument is omitted", () => {
    const list = document.createElement("ul");
    renderPluginList(list, [plugin({ id: "x" })], actions());
    expect(list.querySelector(".plugin-failure-badge")).toBeNull();
  });
});

describe("renderMissingList (재조정 안내)", () => {
  const entry = (over: Partial<MissingPlugin> = {}): MissingPlugin => ({
    id: "m",
    name: "Missing",
    version: "1.0.0",
    source: { type: "url", url: "https://x/m.zip" },
    ...over,
  });

  /** 가드: 항목이 없으면 배너 전체가 숨겨진다(비차단). */
  it("hides the banner when there is nothing to reconcile", () => {
    const container = document.createElement("div");
    renderMissingList(container, [], {
      install: vi.fn(),
      remove: vi.fn(),
      dismiss: vi.fn(),
    });
    expect(container.hidden).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  /** 가드: URL/git 항목엔 [설치][제거][무시]가 있고 각 콜백이 연결된다. */
  it("renders install/remove/dismiss for fetchable sources", () => {
    const container = document.createElement("div");
    const install = vi.fn();
    const remove = vi.fn();
    const dismiss = vi.fn();
    const e = entry();
    renderMissingList(container, [e], { install, remove, dismiss });

    expect(container.hidden).toBe(false);
    expect(container.querySelector(".plugin-missing-name")!.textContent).toBe(
      "Missing v1.0.0",
    );
    container
      .querySelector<HTMLButtonElement>(".plugin-missing-install")!
      .click();
    expect(install).toHaveBeenCalledWith(e);
    container
      .querySelector<HTMLButtonElement>(".plugin-missing-remove")!
      .click();
    expect(remove).toHaveBeenCalledWith("m");
    container
      .querySelector<HTMLButtonElement>(".plugin-missing-dismiss")!
      .click();
    expect(dismiss).toHaveBeenCalledWith("m");
  });

  /** 가드: local 출처는 [설치] 대신 "코드 없음 — 원본 기기" 안내를 보인다. */
  it("shows the no-code note instead of install for local sources", () => {
    const container = document.createElement("div");
    renderMissingList(container, [entry({ source: { type: "local" } })], {
      install: vi.fn(),
      remove: vi.fn(),
      dismiss: vi.fn(),
    });
    expect(container.querySelector(".plugin-missing-install")).toBeNull();
    expect(
      container.querySelector(".plugin-missing-note")!.textContent,
    ).toContain("코드 없음");
    // 제거·무시는 여전히 가능하다.
    expect(container.querySelector(".plugin-missing-remove")).not.toBeNull();
    expect(container.querySelector(".plugin-missing-dismiss")).not.toBeNull();
  });
});

describe("renderApprovalPrompt (권한 승인 프롬프트)", () => {
  /** 가드: 권한이 한국어 라벨·설명으로 렌더되고 민감 권한은 강조된다. */
  it("renders Korean labels and descriptions, highlighting sensitive perms", () => {
    const host = document.createElement("div");
    renderApprovalPrompt(
      host,
      {
        title: "플러그인 설치",
        summary: "Fresh v1.0.0",
        permissions: [
          {
            id: "editor",
            label: "에디터 확장",
            desc: "에디터 동작(패턴·자동완성)을 확장해요",
            sensitive: false,
            added: false,
            reserved: false,
          },
          {
            id: "notes:read",
            label: "노트 읽기",
            desc: "모든 노트의 내용을 읽을 수 있어요",
            sensitive: true,
            added: false,
            reserved: false,
          },
        ],
        approveLabel: "승인하고 설치",
      },
      { onApprove: vi.fn(), onCancel: vi.fn() },
    );
    expect(host.querySelector(".plugin-approve-title")!.textContent).toBe(
      "플러그인 설치",
    );
    const perms = host.querySelectorAll(".plugin-approve-perm");
    expect(perms).toHaveLength(2);
    expect(perms[1].classList.contains("plugin-approve-sensitive")).toBe(true);
    expect(perms[1].textContent).toContain("노트 읽기");
    expect(perms[1].textContent).toContain("읽을 수 있어요");
  });

  /** 가드: 업데이트로 새로 추가된 민감 권한엔 "새 권한" 표식이 붙는다(재승인 강조). */
  it("marks newly added sensitive permissions", () => {
    const host = document.createElement("div");
    renderApprovalPrompt(
      host,
      {
        title: "플러그인 업데이트",
        summary: "Fresh v1.0.0 → v2.0.0",
        permissions: [
          {
            id: "clipboard",
            label: "클립보드",
            desc: "",
            sensitive: true,
            added: true,
            reserved: false,
          },
        ],
        approveLabel: "승인하고 업데이트",
      },
      { onApprove: vi.fn(), onCancel: vi.fn() },
    );
    expect(host.querySelector(".plugin-approve-added")!.textContent).toBe(
      "새 권한",
    );
  });

  /** 가드: 예약(미구현) 권한엔 "아직 동작하지 않음" 표식이 붙고, 비예약 권한엔 붙지 않는다. */
  it("marks reserved permissions as not yet functional", () => {
    const host = document.createElement("div");
    renderApprovalPrompt(
      host,
      {
        title: "플러그인 설치",
        summary: "Fresh v1.0.0",
        permissions: [
          {
            id: "vault:read",
            label: "저장 폴더 읽기",
            desc: "저장 폴더의 파일을 읽을 수 있어요",
            sensitive: true,
            added: false,
            reserved: true,
          },
          {
            id: "notes:read",
            label: "노트 읽기",
            desc: "모든 노트의 내용을 읽을 수 있어요",
            sensitive: true,
            added: false,
            reserved: false,
          },
        ],
        approveLabel: "승인하고 설치",
      },
      { onApprove: vi.fn(), onCancel: vi.fn() },
    );
    const marks = host.querySelectorAll(".plugin-approve-reserved");
    expect(marks).toHaveLength(1); // 예약 권한(vault:read)에만 붙는다.
    expect(marks[0].textContent).toBe("아직 동작하지 않음");
    const perms = host.querySelectorAll(".plugin-approve-perm");
    expect(perms[0].textContent).toContain("저장 폴더 읽기"); // 예약 권한 행에 붙었는지 확인.
    expect(perms[1].querySelector(".plugin-approve-reserved")).toBeNull();
  });

  /** 가드: 권한에 자기신고 `reason`이 있으면 "플러그인이 밝힌 이유"로 병기되고,
   * 없으면 그 행에 렌더되지 않는다(전체를 지어내지 않는다). */
  it("appends the plugin's self-reported reason next to a permission when present", () => {
    const host = document.createElement("div");
    renderApprovalPrompt(
      host,
      {
        title: "플러그인 설치",
        summary: "Fresh v1.0.0",
        permissions: [
          {
            id: "notes:read",
            label: "노트 읽기",
            desc: "지금 열려 있는 메모의 내용을 읽을 수 있어요",
            sensitive: true,
            added: false,
            reserved: false,
            reason: "위키링크 자동완성에 노트 제목이 필요해요",
          },
          {
            id: "editor",
            label: "에디터 확장",
            desc: "",
            sensitive: false,
            added: false,
            reserved: false,
          },
        ],
        approveLabel: "승인하고 설치",
      },
      { onApprove: vi.fn(), onCancel: vi.fn() },
    );
    const perms = host.querySelectorAll(".plugin-approve-perm");
    expect(perms[0].querySelector(".plugin-approve-reason")!.textContent).toBe(
      "플러그인이 밝힌 이유: 위키링크 자동완성에 노트 제목이 필요해요",
    );
    expect(perms[1].querySelector(".plugin-approve-reason")).toBeNull();
  });

  /** 가드: 승인/취소 버튼이 각 콜백을 부르고, 권한이 없으면 안내 문구를 보인다. */
  it("wires approve/cancel and shows a no-permission note", () => {
    const host = document.createElement("div");
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    renderApprovalPrompt(
      host,
      { title: "t", summary: "s", permissions: [], approveLabel: "승인" },
      { onApprove, onCancel },
    );
    expect(host.querySelector(".plugin-approve-none")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    expect(onApprove).toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>(".plugin-approve-cancel")!.click();
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("renderBuiltinList (번들 플러그인)", () => {
  const handlers = () => ({ onToggle: vi.fn(), onOpen: vi.fn() });

  /** 가드: 번들(위키링크)을 활성 토글로 렌더하고, 중복 "번들" 배지·제거·부여 UI는 없다. */
  it("renders builtins with an enable toggle, no badge/remove/grant", () => {
    const list = document.createElement("ul");
    renderBuiltinList(list, {}, {}, handlers());
    expect(list.querySelector(".plugin-name")!.textContent).toContain(
      "위키링크",
    );
    // 이미 "번들 플러그인" 섹션 아래라 행별 "번들" 배지는 두지 않는다(중복 정보 제거).
    expect(list.querySelector(".plugin-builtin-badge")).toBeNull();
    // 기록 없으면 기본 켜짐.
    expect(
      list.querySelector<HTMLInputElement>(".plugin-enable-toggle")!.checked,
    ).toBe(true);
    // 번들은 제거 버튼·부여 토글이 없다(1st-party 자동 부여).
    expect(list.querySelector(".plugin-remove")).toBeNull();
    expect(list.querySelector(".plugin-grant")).toBeNull();
  });

  /** 가드: 상태 맵의 false가 토글 꺼짐으로 반영되고, 토글 변경이 onToggle(id, checked)을 부른다. */
  it("reflects disabled state and wires the toggle", () => {
    const list = document.createElement("ul");
    const h = handlers();
    renderBuiltinList(list, { wikilink: false }, {}, h);
    const toggle = list.querySelector<HTMLInputElement>(
      ".plugin-enable-toggle",
    )!;
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(h.onToggle).toHaveBeenCalledWith("wikilink", true);
  });

  /** 가드(D3 잠금): 번들 테마(sj_d·plain)는 목록에 보이되 토글 없이 🔒 필수 배지 +
   * 안내가 붙는다 — 토글이 없으니 onToggle이 테마 id로 불릴 방법 자체가 없다. */
  it("renders builtin themes locked (required badge, no toggle)", () => {
    const list = document.createElement("ul");
    const h = handlers();
    renderBuiltinList(list, {}, {}, h);

    const badges = list.querySelectorAll(".plugin-required-badge");
    expect(badges).toHaveLength(2); // sj_d + plain
    // 토글 개수 = 비-테마 번들 개수(테마 행엔 토글이 없다).
    const toggles = list.querySelectorAll(".plugin-enable-toggle");
    const items = list.querySelectorAll(".plugin-item");
    expect(items.length - toggles.length).toBe(2);
    // 잠금 사유는 배지 툴팁에 있다(별도 안내 문구 없음).
    expect(
      list.querySelector<HTMLElement>(".plugin-required-badge")!.title,
    ).toContain("테마 탭");
  });

  /** 가드: 이름 버튼이 상세 모델(README·⚙ 스키마 포함)로 onOpen을 부른다. */
  it("opens the detail model with readme and schema via the name button", () => {
    const list = document.createElement("ul");
    const h = handlers();
    renderBuiltinList(list, {}, { "copy-ai-prompt": { template: "T" } }, h);

    const names = [...list.querySelectorAll<HTMLButtonElement>(".plugin-name")];
    // 위키링크(첫 번들) 상세.
    names[0].click();
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    const wikiItem = h.onOpen.mock.calls[0][0] as PluginDetailItem;
    expect(wikiItem.kind).toBe("builtin");
    expect(wikiItem.id).toBe("wikilink");
    expect(wikiItem.sourceLabel).toBe("번들");
    expect(wikiItem.isTheme).toBe(false);
    expect(wikiItem.readme).toContain("[[제목]]"); // 번들 readme 상수가 실린다.

    // 번들 테마(마지막 행들) 상세 — 잠금 상태 문구.
    names[names.length - 2].click();
    const themeItem = h.onOpen.mock.calls[1][0] as PluginDetailItem;
    expect(themeItem.isTheme).toBe(true);
    expect(themeItem.id).toBe("sj_d");
    expect(themeItem.statusLabel).toContain("필수");
  });

  /** 가드: 각 번들 행은 한 줄 부제(.plugin-desc)를 갖고, 활성 토글은 스위치 UI다. */
  it("renders a summary line and a switch toggle per row", () => {
    const list = document.createElement("ul");
    renderBuiltinList(list, {}, {}, handlers());
    // 비-테마 행마다 부제가 있다(요약 파생 — 빈 문자열이면 렌더 안 함).
    const items = [...list.querySelectorAll(".plugin-item")];
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.querySelector(".plugin-desc")).not.toBeNull();
    }
    // 활성 토글은 스위치 input이면서 .plugin-enable-toggle 클래스를 함께 갖는다(카운트 유지).
    const toggle = list.querySelector<HTMLInputElement>(
      "input.plugin-enable-toggle",
    )!;
    expect(toggle.classList.contains("plugin-switch-input")).toBe(true);
    // input이 트랙의 직전 형제여야 `+` 셀렉터가 동작한다.
    expect(
      (toggle.nextElementSibling as HTMLElement).classList.contains(
        "plugin-switch-track",
      ),
    ).toBe(true);
    // 카테고리 카드로 묶인다(중첩 — .plugin-item은 여전히 descendant로 잡힌다).
    expect(list.querySelector(".plugin-category-group")).not.toBeNull();
    expect(list.querySelector(".plugin-category-items")).not.toBeNull();
  });

  /** 가드: 현재 OS 미지원 번들은 토글이 비활성·꺼짐이고 2번째 줄이 사유 문장이다. */
  it("disables and explains an OS-unsupported bundle row", () => {
    const list = document.createElement("ul");
    // transparency는 macOS 전용 — Windows에서 미지원.
    renderBuiltinList(list, {}, {}, handlers(), "windows");
    const rows = [...list.querySelectorAll(".plugin-item")];
    const unsupported = rows.find((r) =>
      r.classList.contains("plugin-item--unsupported"),
    )!;
    expect(unsupported).toBeDefined();
    const toggle = unsupported.querySelector<HTMLInputElement>(
      ".plugin-enable-toggle",
    )!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(
      unsupported.querySelector(".plugin-desc--unavailable"),
    ).not.toBeNull();
  });

  /** 가드: 실행 실패 목록에 있는 번들(플러그인·테마 모두)엔 ⚠ 오류 배지 + 사유 줄이 붙는다. */
  it("marks failed builtins (plugin and theme) with a badge and reason line", () => {
    const list = document.createElement("ul");
    renderBuiltinList(list, {}, {}, handlers(), "", [
      { pluginId: "wikilink", error: "TypeError: 초기화 실패" },
      { pluginId: "sj_d", error: "구문 오류" },
    ]);
    const items = [...list.querySelectorAll(".plugin-item")];
    const wikiRow = items.find((it) => it.textContent?.includes("위키링크"))!;
    // 행 텍스트는 표시 이름("SJ_D")으로 찾는다 — pluginId(위 실패 목록의 "sj_d")는
    // 매칭용 id일 뿐 화면엔 name 필드가 렌더된다.
    const themeRow = items.find((it) => it.textContent?.includes("SJ_D"))!;
    expect(wikiRow.querySelector(".plugin-failure-badge")).not.toBeNull();
    expect(wikiRow.querySelector(".plugin-desc--failure")!.textContent).toBe(
      "실행 오류: TypeError: 초기화 실패",
    );
    expect(themeRow.querySelector(".plugin-failure-badge")).not.toBeNull();
    expect(themeRow.querySelector(".plugin-desc--failure")).not.toBeNull();
    // 실패 없는 다른 행은 배지가 없다.
    const untouched = items.filter((it) => it !== wikiRow && it !== themeRow);
    for (const row of untouched) {
      expect(row.querySelector(".plugin-failure-badge")).toBeNull();
    }
  });

  /**
   * 가드(①단계): 번들 언어팩을 넘기면 「언어」 카테고리 헤더 아래에 **토글 있는 평범한 행**
   * 으로 렌더된다.
   *
   * 픽스처를 손으로 짓지 않고 실제 팩 폴더를 읽는 이유: 검증하려는 것이 렌더 코드만이 아니라
   * "매니페스트 → `packToBuiltin` → 목록"이라는 **연결 전체**다(권한 `i18n`이 실제로
   * `inferPluginCategory`를 「언어」로 보내는지가 그 사슬의 한가운데다).
   */
  it("renders bundled language packs as a toggle row under the 언어 category", async () => {
    const packs = (await loadAllBundledPacks()).map(packToBuiltin);
    expect(packs.length).toBeGreaterThan(0);
    const list = document.createElement("ul");
    const h = handlers();
    renderBuiltinList(list, {}, {}, h, "", [], packs);

    const groups = [...list.querySelectorAll(".plugin-category-group")];
    const langGroup = groups.find(
      (g) => g.querySelector(".cat-label")?.textContent === "언어",
    )!;
    expect(langGroup, "「언어」 카테고리 그룹이 렌더되지 않음").toBeDefined();
    expect(langGroup.querySelector(".cat-caption")!.textContent).toBe(
      "앱 화면의 번역 · 언어 드롭다운에서 선택",
    );
    // 이름은 매니페스트 nls의 ko(default) 사전으로 해석돼야 한다(`%name%` 노출이면 회귀).
    const row = langGroup.querySelector(".plugin-item")!;
    expect(row.querySelector(".plugin-name")!.textContent).toBe("영어 언어팩");
    // 잠금이 아니라 평범한 토글 행이다(테마와 달리 끌 수 있다).
    expect(row.querySelector(".plugin-required-badge")).toBeNull();
    const toggle = row.querySelector<HTMLInputElement>(
      ".plugin-enable-toggle",
    )!;
    expect(toggle.checked).toBe(true); // 기록 없으면 기본 켜짐.
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(h.onToggle).toHaveBeenCalledWith("language-pack-en", false);
  });

  /** 가드(①단계): 언어팩 이름을 누르면 상세 모델에 그 팩의 README가 실린다(번들 플러그인과
   * 같은 경로 — 상세 뷰가 별도 분기 없이 그대로 처리한다). */
  it("opens the language pack detail with its readme", async () => {
    const packs = (await loadAllBundledPacks()).map(packToBuiltin);
    const list = document.createElement("ul");
    const h = handlers();
    renderBuiltinList(list, {}, {}, h, "", [], packs);

    const langGroup = [...list.querySelectorAll(".plugin-category-group")].find(
      (g) => g.querySelector(".cat-label")?.textContent === "언어",
    )!;
    langGroup.querySelector<HTMLButtonElement>(".plugin-name")!.click();
    const item = h.onOpen.mock.calls[0][0] as PluginDetailItem;
    expect(item.kind).toBe("builtin");
    expect(item.id).toBe("language-pack-en");
    expect(item.isTheme).toBe(false);
    expect(item.permissions).toContain("i18n");
    expect(item.schema).toEqual([]); // 언어팩은 설정 스키마가 없다.
    expect(item.readme).toContain("## 이렇게 써요");
  });
});

describe("pluginSummary", () => {
  it("prefers the explicit summary, trimmed", () => {
    expect(pluginSummary("  한 줄 요약 ", "# 제목\n본문")).toBe("한 줄 요약");
  });

  it("falls back to the first non-heading README line, stripping markdown", () => {
    expect(
      pluginSummary(
        undefined,
        "# 제목\n\n**굵게** `코드` [링크](https://x)와 본문",
      ),
    ).toBe("굵게 코드 링크와 본문");
  });

  it("returns empty string for an empty/heading-only readme", () => {
    expect(pluginSummary(undefined, "")).toBe("");
    expect(pluginSummary(undefined, "# 제목만")).toBe("");
  });

  it("truncates past 90 chars with an ellipsis", () => {
    const long = "가".repeat(120);
    const out = pluginSummary(undefined, long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(90);
  });
});

describe("staticPageSearchTerms (설정 트리 검색 인덱스)", () => {
  it("lists a fixed page's item labels without repeating the page name itself", () => {
    const terms = staticPageSearchTerms("appearance:theme");
    expect(terms).toContain("강조색");
    expect(terms).toContain("배경");
    expect(terms).not.toContain("테마"); // 페이지 라벨 자체는 이미 label로 매칭되니 중복 없음.
  });

  it("returns an empty list for manager nodes and unknown ids", () => {
    // manager:bundle·manager:community의 검색어는 고정 문구가 아니라 설치된 플러그인
    // 데이터라 collectNodes가 직접 채운다 — 여기서는 빈 배열이어야 한다.
    expect(staticPageSearchTerms("manager:bundle")).toEqual([]);
    expect(staticPageSearchTerms("manager:community")).toEqual([]);
    expect(staticPageSearchTerms("no-such-id")).toEqual([]);
  });
});

describe("buildSettingField (설정 입력 위젯)", () => {
  /** 가드: text/toggle/select가 현재 값으로 초기화되고, 변경이 onChange(value)로 위임된다. */
  it("initializes with the current value and wires edits (text/toggle/select)", () => {
    const textOut: unknown[] = [];
    const text = buildSettingField(
      { key: "prefix", label: "접두사", type: "text", options: [] },
      "»",
      (v) => textOut.push(v),
    );
    const textInput = text.querySelector<HTMLInputElement>(
      'input[type="text"].plugin-setting-input',
    )!;
    expect(textInput.value).toBe("»");
    textInput.value = "→";
    textInput.dispatchEvent(new Event("input"));
    expect(textOut).toEqual(["→"]);

    const toggleOut: unknown[] = [];
    const toggle = buildSettingField(
      { key: "bold", label: "굵게", type: "toggle", options: [] },
      true,
      (v) => toggleOut.push(v),
    );
    // 토글은 스위치 UI(트랙/썸) 안의 실제 체크박스로 렌더된다.
    const cb = toggle.querySelector<HTMLInputElement>(
      "input[type=checkbox].plugin-switch-input",
    )!;
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    expect(toggleOut).toEqual([false]);

    const selectOut: unknown[] = [];
    const select = buildSettingField(
      { key: "mode", label: "모드", type: "select", options: ["a", "b"] },
      "b",
      (v) => selectOut.push(v),
    );
    const sel = select.querySelector<HTMLSelectElement>(
      "select.plugin-setting-input",
    )!;
    expect(sel.value).toBe("b");
    sel.value = "a";
    sel.dispatchEvent(new Event("change"));
    expect(selectOut).toEqual(["a"]);
  });

  /** 가드: select는 **value를 저장하고 label을 보여 준다** — 옵션 객체형. */
  it("renders select options with value/label split", () => {
    const out: unknown[] = [];
    const el = buildSettingField(
      {
        key: "mode",
        label: "방식",
        type: "select",
        options: [
          { value: "cursor", label: "커서 위치" },
          { value: "append", label: "문서 끝에 추가", description: "끝에" },
        ],
      },
      "cursor",
      (v) => out.push(v),
    );
    const sel = el.querySelector<HTMLSelectElement>("select")!;
    expect([...sel.options].map((o) => o.value)).toEqual(["cursor", "append"]);
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      "커서 위치",
      "문서 끝에 추가",
    ]);
    expect(sel.value).toBe("cursor"); // 라벨이 아니라 값으로 선택 상태가 잡힌다
    expect(sel.options[1].title).toBe("끝에"); // description은 툴팁
    sel.value = "append";
    sel.dispatchEvent(new Event("change"));
    expect(out).toEqual(["append"]); // 저장되는 것도 값
  });

  /** 가드: number 위젯은 min/max/step을 반영하고 **언제나 수를** 넘긴다(NaN 차단). */
  it("renders a number input that clamps and never emits NaN", () => {
    const out: unknown[] = [];
    const el = buildSettingField(
      {
        key: "step",
        label: "폭",
        type: "number",
        options: [],
        min: 5,
        max: 50,
        step: 5,
      },
      10,
      (v) => out.push(v),
    );
    const input = el.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input.value).toBe("10");
    expect([input.min, input.max, input.step]).toEqual(["5", "50", "5"]);

    input.value = "80";
    input.dispatchEvent(new Event("input"));
    expect(out).toEqual([50]); // 상한 클램프

    input.value = ""; // 지우는 도중 — 빈 값은 흘려보낸다(플러그인이 NaN을 받지 않게)
    input.dispatchEvent(new Event("input"));
    expect(out).toEqual([50]);
  });
});

describe("parseListBlob / serializeListBlob (템플릿 리스트 직렬화)", () => {
  /** 가드: 3개 항목의 왕복(parse→serialize→parse)이 안정적이다. */
  it("round-trips a multi-item list", () => {
    const items = [
      { name: "주간회의", body: "# {week}주차\n- a" },
      { name: "데일리", body: "## {today}" },
      { name: "회고", body: "Keep:\nProblem:" },
    ];
    expect(parseListBlob(serializeListBlob(items))).toEqual(items);
  });

  /** 가드: 헤더 없는 레거시 블롭은 "템플릿" 한 항목이 된다(main.js와 동일 규칙). */
  it("treats a header-less legacy blob as one item named 템플릿", () => {
    expect(parseListBlob("그냥 본문\n둘째 줄")).toEqual([
      { name: "템플릿", body: "그냥 본문\n둘째 줄" },
    ]);
  });

  /** 가드: 이름 안 `=`는 직렬화 시 제거된다(헤더 문법 충돌 방지). */
  it("strips '=' from names on serialize", () => {
    const out = serializeListBlob([{ name: "a=b=c", body: "x" }]);
    expect(out).toBe("=== abc ===\nx");
    expect(parseListBlob(out)).toEqual([{ name: "abc", body: "x" }]);
  });

  /** 가드: 이름 있는 항목은 빈 본문이어도 살아남는다. */
  it("keeps a named item with empty body", () => {
    expect(parseListBlob("=== 빈템플릿 ===\n")).toEqual([
      { name: "빈템플릿", body: "" },
    ]);
  });

  /** 가드: 빈/비문자열 입력은 빈 목록. */
  it("returns [] for empty or non-string input", () => {
    expect(parseListBlob("")).toEqual([]);
    expect(parseListBlob(null)).toEqual([]);
    expect(parseListBlob(42)).toEqual([]);
  });
});

describe("buildSettingField — 액션 버튼", () => {
  const buttonField = {
    key: "clearCache",
    label: "캐시 지우기",
    type: "button" as const,
    command: "clear-cache",
    options: [],
  };

  /** 가드: 라벨이 붙은 실제 버튼이 뜨고, 누르면 onAction이 그 필드로 불린다. */
  it("renders a button and dispatches the field on click", async () => {
    const seen: string[] = [];
    const el = buildSettingField(
      buttonField,
      undefined,
      () => {},
      (f) => {
        seen.push(f.command ?? "");
        return Promise.resolve("실행을 요청했어요.");
      },
    );
    const btn = el.querySelector<HTMLButtonElement>(
      "button.plugin-action-button",
    )!;
    expect(btn.textContent).toBe("캐시 지우기");
    expect(btn.disabled).toBe(false);
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["clear-cache"]);
    expect(
      el.querySelector<HTMLElement>(".plugin-setting-status")!.textContent,
    ).toBe("실행을 요청했어요.");
  });

  /**
   * 가드: 결과 문구가 빈 문자열이면 상태 줄을 아예 그리지 않는다.
   *
   * 확인 다이얼로그를 취소한 경우가 이것이다 — 취소는 실패가 아니므로 빨간 줄도, 남는
   * 문구도 없어야 한다.
   */
  it("hides the status line when the action returns an empty message", async () => {
    const el = buildSettingField(
      buttonField,
      undefined,
      () => {},
      () => Promise.resolve(""),
    );
    const status = el.querySelector<HTMLElement>(".plugin-setting-status")!;
    expect(status.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(status.hidden).toBe(true);
  });

  /**
   * 가드: `onAction`이 없거나 `command`가 없으면 **버튼을 잠그고 이유를 적는다**.
   *
   * 이 저장소가 11번 겪은 "선언은 됐는데 아무도 안 읽는다"의 새 서식이 정확히 이것이다 —
   * 배선이 빠지면 눌러도 아무 일이 없는 버튼이 남는다. 잠그면 그 상태가 눈에 보인다.
   */
  it("disables the button when the action or the command is missing", () => {
    const unwired = buildSettingField(buttonField, undefined, () => {});
    expect(unwired.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    const noCommand = buildSettingField(
      { key: "x", label: "무명", type: "button", options: [] },
      undefined,
      () => {},
      () => Promise.resolve("실행함"),
    );
    expect(noCommand.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
      true,
    );
    expect(
      noCommand.querySelector<HTMLElement>(".plugin-setting-status")!.hidden,
    ).toBe(false);
  });

  /** 가드: 값이 없는 필드라 `<label>`이 아니고 입력 위젯도 만들지 않는다. */
  it("renders no value input (button holds no value)", () => {
    const el = buildSettingField(
      buttonField,
      undefined,
      () => {},
      () => Promise.resolve(""),
    );
    expect(el.tagName).toBe("DIV");
    expect(el.querySelector("input, select, textarea")).toBeNull();
  });
});

describe("buildSettingField — list 편집기", () => {
  const listField = {
    key: "templates",
    label: "템플릿",
    type: "list" as const,
    itemLabel: "템플릿",
    options: [],
    hints: [{ token: "{today}", label: "오늘" }],
  };

  /** 가드: list 값이 항목 카드(이름+본문)로 렌더된다. */
  it("renders one card per item", () => {
    const el = buildSettingField(
      listField,
      "=== A ===\n본문A\n\n=== B ===\n본문B",
      () => {},
    );
    const cards = el.querySelectorAll(".plugin-list-item");
    expect(cards).toHaveLength(2);
    const names = el.querySelectorAll<HTMLInputElement>(".plugin-list-name");
    expect([names[0].value, names[1].value]).toEqual(["A", "B"]);
    // 키워드 칩(hints)이 노출된다.
    expect(el.querySelector(".plugin-key-chip")!.textContent).toBe("{today}");
  });

  /** 가드: 항목 추가가 새 카드를 만들고 직렬화된 값을 onChange로 넘긴다. */
  it("adds an item and serializes on change", () => {
    const out: unknown[] = [];
    const el = buildSettingField(listField, "=== A ===\n본문A", (v) =>
      out.push(v),
    );
    el.querySelector<HTMLButtonElement>(".plugin-list-add")!.click();
    expect(el.querySelectorAll(".plugin-list-item")).toHaveLength(2);
    // 마지막 onChange 값은 새 항목이 포함된 블롭이다.
    expect(String(out[out.length - 1])).toContain("=== 새 템플릿 ===");
  });

  /** 가드: 본문 편집이 직렬화 값에 반영된다. */
  it("edits a body and reserializes", () => {
    const out: unknown[] = [];
    const el = buildSettingField(listField, "=== A ===\n old", (v) =>
      out.push(v),
    );
    const body = el.querySelector<HTMLTextAreaElement>(".plugin-list-body")!;
    body.value = "새 본문";
    body.dispatchEvent(new Event("input"));
    expect(String(out[out.length - 1])).toBe("=== A ===\n새 본문");
  });
});

describe("renderPluginDetail — 「최근 오류」 진단 패널", () => {
  const diag = (over: Partial<PluginDiagnostic> = {}): PluginDiagnostic => ({
    pluginId: "x",
    at: Date.parse("2026-07-27T10:11:12Z"),
    kind: "call-reject",
    message: "권한 없음",
    ...over,
  });

  /** 가드: 기록이 없으면 섹션은 숨는다(평상시 소음 0) — 하지만 DOM에는 존재해야 한다
   * (진단이 비동기로 도착했을 때 상세 전체를 다시 그리지 않고 이 자리만 갈아 끼운다). */
  it("hides the section when there is nothing to report", () => {
    const host = document.createElement("div");
    renderPluginDetail(host, detailItem({}), detailActions());
    const section = host.querySelector<HTMLElement>(
      ".plugin-detail-section--diagnostics",
    )!;
    expect(section).not.toBeNull();
    expect(section.hidden).toBe(true);
  });

  /** 가드: 호출명·안정 코드·메시지가 보이고 **최신이 위**다(방금 난 일을 먼저 본다). */
  it("shows call, stable code and message, newest first", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({
        diagnostics: [
          diag({ message: "오래된 것", at: 1 }),
          diag({
            call: "ui.toast",
            code: "PERMISSION_UNDECLARED",
            message: "최근 것",
            at: 2,
          }),
        ],
      }),
      detailActions(),
    );
    const items = host.querySelectorAll(".plugin-diagnostic");
    expect(items).toHaveLength(2);
    expect(
      items[0].querySelector(".plugin-diagnostic-message")!.textContent,
    ).toBe("최근 것");
    expect(items[0].querySelector(".plugin-diagnostic-call")!.textContent).toBe(
      "ui.toast",
    );
    expect(items[0].querySelector(".plugin-diagnostic-code")!.textContent).toBe(
      "PERMISSION_UNDECLARED",
    );
  });

  /**
   * 가드: 모든 진단 종류에 사람이 읽는 라벨이 있다(슬러그가 그대로 새지 않는다).
   *
   * 왜: `DiagnosticKind`와 라벨표는 짝이다 — 종류만 늘리고 라벨을 빠뜨리면 화면에
   * `onclick-throw` 같은 영문 슬러그가 그대로 노출된다(폴백이 그렇게 돼 있다).
   */
  it("labels every diagnostic kind in Korean", () => {
    const kinds: PluginDiagnostic["kind"][] = [
      "call-reject",
      "no-window-context",
      "setting-write-rejected",
      "setting-key-undeclared",
      "duplicate-registration",
      "onclick-throw",
      "unhandled-rejection",
      "log",
    ];
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({
        diagnostics: kinds.map((kind, i) => diag({ kind, at: i })),
      }),
      detailActions(),
    );
    const labels = [...host.querySelectorAll(".plugin-diagnostic-kind")].map(
      (el) => el.textContent,
    );
    expect(labels).toHaveLength(kinds.length);
    expect(labels.filter((l) => kinds.includes(l as never))).toEqual([]);
  });

  /** 가드(보안): 진단 메시지·호출명은 플러그인이 만든 문자열이다 — 마크업이 아니라
   * 텍스트로만 들어간다(설정 창에 주입이 열리면 안 된다). */
  it("renders plugin-authored strings as text, never as markup", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({
        diagnostics: [diag({ message: "<img src=x onerror=alert(1)>" })],
      }),
      detailActions(),
    );
    const message = host.querySelector(".plugin-diagnostic-message")!;
    expect(message.querySelector("img")).toBeNull();
    expect(message.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  /** 가드: 비동기로 도착한 진단은 그 섹션만 갈아 끼운다 — 같은 방식으로 늦게 채워지는
   * README를 날리지 않는다(경쟁 제거). */
  it("swaps only the diagnostics section in place", () => {
    const host = document.createElement("div");
    renderPluginDetail(host, detailItem({}), detailActions());
    const readme = host.querySelector(".plugin-readme")!;
    updatePluginDiagnostics(host, [diag({ message: "늦게 도착" })]);
    expect(host.querySelector(".plugin-readme")).toBe(readme); // 같은 노드 그대로
    const section = host.querySelector<HTMLElement>(
      ".plugin-detail-section--diagnostics",
    )!;
    expect(section.hidden).toBe(false);
    expect(host.querySelector(".plugin-diagnostic-message")!.textContent).toBe(
      "늦게 도착",
    );
  });
});

describe("detailFromInstalled — 자기신고 필드 배선", () => {
  /**
   * 가드(핵심 배선): 백엔드(`InstalledPlugin`)는 이미 `purpose`·`llmContext`를 실어
   * 보내지만 `shared/tauri.ts`의 타입 선언엔 없다 — `summary`가 정확히 이 모양으로 한 번
   * 사라진 전례와 같은 결함이다. 타입에 없는 런타임 필드를 `unknown` 주입으로 흉내 내
   * `detailFromInstalled`가 그래도 상세 모델까지 값을 잇는지 고정한다(여기서 끊기면
   * 상세 뷰가 조용히 아무것도 안 보여준다).
   */
  it("carries purpose and llmContext from the raw plugin payload into the detail model", () => {
    const p = plugin({ id: "x" }) as unknown as Record<string, unknown>;
    p.purpose = "  메모를 예쁘게 꾸며줘요  ";
    p.llmContext = "능력: 툴바 버튼 1개";
    const item = detailFromInstalled(p as unknown as InstalledPlugin);
    expect(item.purpose).toBe("메모를 예쁘게 꾸며줘요");
    expect(item.llmContext).toBe("능력: 툴바 버튼 1개");
  });

  /** 가드: 없거나 형식이 어긋나면 필드 자체를 만들지 않는다(빈 문자열을 지어내지 않는다). */
  it("omits purpose/llmContext entirely when absent or malformed", () => {
    const item = detailFromInstalled(plugin({ id: "y" }));
    expect(item.purpose).toBeUndefined();
    expect(item.llmContext).toBeUndefined();
  });
});

describe("renderPluginDetail (상세 뷰)", () => {
  /** 가드: 헤더(← 목록·이름·버전)·출처·상태 메타가 렌더되고 뒤로가 back을 부른다. */
  it("renders header/meta and wires the back button", () => {
    const host = document.createElement("div");
    const acts = detailActions();
    renderPluginDetail(
      host,
      detailItem({
        installed: plugin({ id: "x", name: "엑스", version: "2.0.0" }),
        sourceLabel: "https://x/p.zip",
        statusLabel: "활성",
      }),
      acts,
    );
    expect(host.querySelector(".plugin-detail-name")!.textContent).toBe("엑스");
    expect(host.querySelector(".plugin-detail-version")!.textContent).toBe(
      "v2.0.0",
    );
    expect(host.querySelector(".plugin-detail-source")!.textContent).toContain(
      "https://x/p.zip",
    );
    expect(host.querySelector(".plugin-detail-status")!.textContent).toContain(
      "활성",
    );
    host.querySelector<HTMLButtonElement>(".plugin-detail-back")!.click();
    expect(acts.back).toHaveBeenCalled();
  });

  /** 가드: `purpose`가 있으면 "플러그인이 스스로 밝힌 설명" 라벨과 함께 낮은 신뢰
   * 톤으로 렌더되고, 없으면 그 블록 자체가 없다(지어내지 않는다). */
  it("renders the self-reported purpose with a low-trust label when present", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({ purpose: "메모를 예쁘게 꾸며주는 플러그인이에요" }),
      detailActions(),
    );
    expect(
      host.querySelector(".plugin-detail-selfreport-label")!.textContent,
    ).toBe("플러그인이 스스로 밝힌 설명");
    expect(host.querySelector(".plugin-detail-purpose")!.textContent).toBe(
      "메모를 예쁘게 꾸며주는 플러그인이에요",
    );

    const noPurpose = document.createElement("div");
    renderPluginDetail(noPurpose, detailItem({}), detailActions());
    expect(noPurpose.querySelector(".plugin-detail-purpose")).toBeNull();
    expect(
      noPurpose.querySelector(".plugin-detail-selfreport-label"),
    ).toBeNull();
  });

  /** 가드: `llmContext`가 있으면 접힌 `<details>`(기본 닫힘)로 렌더되고, 없으면
   * 섹션 자체가 없다. */
  it("renders the self-reported llmContext as a closed-by-default details section", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({ llmContext: "능력: 툴바 버튼 1개\n설정 키: prefix" }),
      detailActions(),
    );
    const details = host.querySelector<HTMLDetailsElement>(
      ".plugin-detail-llmcontext",
    )!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false); // 기본 닫힘 — 일반 사용자에겐 부차적.
    expect(
      details.querySelector(".plugin-detail-llmcontext-body")!.textContent,
    ).toBe("능력: 툴바 버튼 1개\n설정 키: prefix");

    const noContext = document.createElement("div");
    renderPluginDetail(noContext, detailItem({}), detailActions());
    expect(noContext.querySelector(".plugin-detail-llmcontext")).toBeNull();
  });

  /** 가드(계약 이관): 설치형 민감 권한은 상세에서 부여 토글로 렌더되고
   * (id, permission, checked)로 setGranted를 부른다. 저위험은 배지. */
  it("renders sensitive grants as toggles for installed plugins", () => {
    const host = document.createElement("div");
    const acts = detailActions();
    renderPluginDetail(
      host,
      detailItem({
        installed: plugin({
          id: "x",
          permissions: ["editor", "notes:read"],
          granted: ["notes:read"],
        }),
        permissions: ["editor", "notes:read"],
      }),
      acts,
    );
    const badges = host.querySelectorAll(".plugin-perm");
    expect(badges.length).toBe(2);
    const grant = host.querySelector<HTMLInputElement>(".plugin-grant")!;
    expect(grant.checked).toBe(true);
    grant.checked = false;
    grant.dispatchEvent(new Event("change"));
    expect(acts.setGranted).toHaveBeenCalledWith("x", "notes:read", false);
  });

  /** 가드: 번들 상세는 권한이 읽기 전용 배지뿐이다(부여 토글 없음 — 1st-party 자동 부여). */
  it("renders builtin permissions as read-only badges", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({
        kind: "builtin",
        installed: undefined,
        permissions: ["editor", "notes:read"],
        readme: "# 위키링크",
      }),
      detailActions(),
    );
    expect(host.querySelectorAll(".plugin-perm")).toHaveLength(2);
    expect(host.querySelector(".plugin-grant")).toBeNull();
  });

  /** 가드(설정=트리 정본): 스키마가 있으면 상세엔 폼 대신 "설정 열기" 링크만 두고, 클릭하면
   * openSettings(item)로 그 플러그인의 트리 설정 페이지로 이동시킨다. */
  it("renders a 설정 열기 link that opens the plugin settings page", () => {
    const host = document.createElement("div");
    const acts = detailActions();
    const item = detailItem({
      installed: plugin({ id: "cfg" }),
      schema: [{ key: "prefix", label: "접두사", type: "text", options: [] }],
      values: { prefix: "»" },
    });
    renderPluginDetail(host, item, acts);

    // 폼은 상세에 없고(트리가 정본), 링크만 있다.
    expect(host.querySelector(".plugin-settings-form")).toBeNull();
    const link = host.querySelector<HTMLButtonElement>(
      ".plugin-settings-link",
    )!;
    expect(link).not.toBeNull();
    link.click();
    expect(acts.openSettings).toHaveBeenCalledWith(item);
  });

  /** 가드: 스키마가 없으면 설정 섹션(링크)이 아예 없다. */
  it("omits the settings section when there is no schema", () => {
    const host = document.createElement("div");
    renderPluginDetail(host, detailItem(), detailActions());
    expect(host.querySelector(".plugin-settings-link")).toBeNull();
    expect(host.querySelector(".plugin-settings-form")).toBeNull();
  });

  /** 가드(계약 이관): 설치형 URL/git 출처엔 [업데이트 확인]이, 모든 설치형엔 [제거]가
   * 상세에 있고 각 콜백을 부른다. 번들 상세엔 둘 다 없다. */
  it("moves update/remove actions into the detail view", () => {
    const host = document.createElement("div");
    const acts = detailActions();
    const p = plugin({
      id: "g",
      source: { type: "git", url: "https://x/r.git" },
    });
    renderPluginDetail(host, detailItem({ installed: p }), acts);

    host.querySelector<HTMLButtonElement>(".plugin-update")!.click();
    expect(acts.checkUpdate).toHaveBeenCalledWith(p);
    host.querySelector<HTMLButtonElement>(".plugin-remove")!.click();
    expect(acts.remove).toHaveBeenCalledWith("g");

    // local 출처는 업데이트 버튼이 없다(원본 위치 없음).
    const local = document.createElement("div");
    renderPluginDetail(
      local,
      detailItem({ installed: plugin({ source: { type: "local" } }) }),
      detailActions(),
    );
    expect(local.querySelector(".plugin-update")).toBeNull();
    expect(local.querySelector(".plugin-remove")).not.toBeNull();

    // 번들 상세엔 업데이트·제거가 없다.
    const builtin = document.createElement("div");
    renderPluginDetail(
      builtin,
      detailItem({ kind: "builtin", installed: undefined, readme: "x" }),
      detailActions(),
    );
    expect(builtin.querySelector(".plugin-update")).toBeNull();
    expect(builtin.querySelector(".plugin-remove")).toBeNull();
  });

  /**
   * 가드: 개발자 모드 토글은 로컬 사이드로드 + `devModeAvailable`(=deps.setDevPlugin
   * 배선) 둘 다일 때만 보이고, 클릭하면 `setDevMode(id, checked)`를 부른다. url/git 출처거나
   * `devModeAvailable`이 없으면(선택 dep 미배선) 행 자체가 없다 — pickPluginDir과 같은
   * "없으면 숨긴다" 규칙.
   */
  it("shows the developer-mode toggle only for local sideloads when available, and calls setDevMode", () => {
    const host = document.createElement("div");
    const acts = detailActions();
    renderPluginDetail(
      host,
      detailItem({
        installed: plugin({ id: "loc", source: { type: "local" } }),
        devModeAvailable: true,
      }),
      acts,
    );
    const toggle = host.querySelector<HTMLInputElement>(
      ".plugin-devmode-toggle",
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(false);
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change"));
    expect(acts.setDevMode).toHaveBeenCalledWith("loc", true);

    // git 출처(원본 폴더가 이 기기에 없음)에는 토글이 없다.
    const gitHost = document.createElement("div");
    renderPluginDetail(
      gitHost,
      detailItem({
        installed: plugin({
          source: { type: "git", url: "https://x/r.git" },
        }),
        devModeAvailable: true,
      }),
      detailActions(),
    );
    expect(gitHost.querySelector(".plugin-devmode-toggle")).toBeNull();

    // devModeAvailable 없음(선택 dep 미배선)이면 local이어도 토글이 없다.
    const unavailable = document.createElement("div");
    renderPluginDetail(
      unavailable,
      detailItem({
        installed: plugin({ source: { type: "local" } }),
        devModeAvailable: false,
      }),
      detailActions(),
    );
    expect(unavailable.querySelector(".plugin-devmode-toggle")).toBeNull();
  });

  /** 가드: `devMode: true`면 토글이 이미 켜진 채로 렌더된다(reopenInstalledDetail이
   * 세션 상태를 투영한 결과 — 사용자가 다시 안 눌러도 실제 상태를 보여준다). */
  it("renders the developer-mode toggle pre-checked when devMode is true", () => {
    const host = document.createElement("div");
    renderPluginDetail(
      host,
      detailItem({
        installed: plugin({ source: { type: "local" } }),
        devMode: true,
        devModeAvailable: true,
      }),
      detailActions(),
    );
    expect(
      host.querySelector<HTMLInputElement>(".plugin-devmode-toggle")!.checked,
    ).toBe(true);
  });

  /** 가드(D4): 번들 README는 즉시 마크다운 렌더되고, 설치형은 로딩 문구를 보인다
   * (IPC 결과는 호출부가 채움). */
  it("renders builtin readme immediately and a loading note for installed", () => {
    const builtin = document.createElement("div");
    renderPluginDetail(
      builtin,
      detailItem({
        kind: "builtin",
        installed: undefined,
        readme: "# 사용법\n\n**굵게** 안내",
      }),
      detailActions(),
    );
    const readme = builtin.querySelector(".plugin-readme")!;
    expect(readme.querySelector("h1")!.textContent).toBe("사용법");
    expect(readme.querySelector("strong")!.textContent).toBe("굵게");

    const installed = document.createElement("div");
    renderPluginDetail(installed, detailItem(), detailActions());
    expect(installed.querySelector(".plugin-readme")!.textContent).toContain(
      "불러오는 중",
    );
  });
});

describe("plugin settings form (트리 페이지 ⚙ 계약)", () => {
  /** 가드: 필드에 description이 있으면 입력 아래 도움말(.plugin-setting-desc)로 렌더된다. */
  /**
   * 가드(치환 미리보기): `{path}` 같은 **호스트가 아는 토큰**이 든 text 필드는 입력 아래에
   * 임시 값으로 치환된 줄을 보여 주고, 타이핑마다 갱신한다.
   *
   * 왜: `{path}`라고 쓴 사람이 그것이 무엇으로 바뀌는지 확인할 방법이 설명글밖에 없었다.
   * 예전엔 「지금 복사해 보기」 액션 버튼이 그 답을 맡았는데, 그 버튼은 메모 창에서 그
   * 플러그인을 한 번 써야 동작해서(창 컨텍스트 폴백) 시험하려는 일을 먼저 해야 하는
   * 자기모순이었다 — 치환은 순수 문자열 연산이라 실행에 매달릴 이유가 없다.
   */
  it("previews known tokens under the input and updates as you type", () => {
    const row = buildSettingField(
      { key: "template", label: "복사 문구", type: "text", options: [] },
      "{path} 입니다.",
      () => {},
    );
    const preview = row.querySelector<HTMLElement>(".plugin-setting-preview")!;
    expect(preview).not.toBeNull();
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe(
      "미리보기: /Users/me/Memo/notes/메모.md 입니다.",
    );

    // 타이핑 → 같은 줄이 즉시 갱신된다.
    const input = row.querySelector<HTMLInputElement>(".plugin-setting-input")!;
    input.value = "봐줘: {path} / {content}";
    input.dispatchEvent(new Event("input"));
    expect(preview.textContent).toBe(
      "미리보기: 봐줘: /Users/me/Memo/notes/메모.md / 메모 본문",
    );
  });

  /**
   * 가드: textarea에도 같은 미리보기가 붙고 **줄바꿈이 보존된다**(`pre-wrap`). 여러 줄 문구가
   * 어떻게 접히는지도 확인 대상이라, 한 줄로 뭉개면 미리보기의 절반이 사라진다.
   */
  it("previews a multi-line textarea value with its line breaks intact", () => {
    const row = buildSettingField(
      { key: "tmpl", label: "문구", type: "textarea", options: [] },
      "봐줘:\n{path}\n{content}",
      () => {},
    );
    const preview = row.querySelector<HTMLElement>(".plugin-setting-preview")!;
    expect(preview.textContent).toBe(
      "미리보기: 봐줘:\n/Users/me/Memo/notes/메모.md\n메모 본문",
    );
  });

  /**
   * 가드(거짓 미리보기 방지): **아는 토큰이 하나도 없으면** 줄 자체를 감춘다. 모르는 토큰은
   * 손대지 않는다 — 다른 뜻으로 `{foo}`를 쓰는 플러그인에게 지어낸 값을 보여 주지 않는다.
   */
  it("hides the preview when the value has no known token", () => {
    for (const value of ["", "그냥 문장", "{foo} 만 있음"]) {
      const row = buildSettingField(
        { key: "t", label: "L", type: "text", options: [] },
        value,
        () => {},
      );
      const preview = row.querySelector<HTMLElement>(
        ".plugin-setting-preview",
      )!;
      expect(preview.hidden, value).toBe(true);
      expect(preview.textContent, value).toBe("");
    }
  });

  it("renders a field description as help text below the input", () => {
    const withDesc = buildSettingField(
      {
        key: "template",
        label: "복사 문구",
        type: "text",
        options: [],
        description: "변수: {path}, {content}",
      },
      "",
      () => {},
    );
    const desc = withDesc.querySelector(".plugin-setting-desc");
    expect(desc).not.toBeNull();
    expect(desc!.textContent).toContain("{content}");

    // description이 없는 필드에는 도움말이 붙지 않는다.
    const noDesc = buildSettingField(
      { key: "plain", label: "그냥", type: "text", options: [] },
      "",
      () => {},
    );
    expect(noDesc.querySelector(".plugin-setting-desc")).toBeNull();
  });
});

const settings = { schema_version: 1, theme: "sj_d", defaults: {} };

/** mountSettings 의존성 전체(모두 스파이/기본값) — 테스트마다 필요한 것만 덮어쓴다. */
const deps = (over: Record<string, unknown> = {}) => ({
  getSettings: async () => ({ ...settings }),
  saveSettings: vi.fn(async () => {}),
  flushNotesReload: vi.fn(async () => {}),
  listPlugins: async () => [] as InstalledPlugin[],
  setEnabled: vi.fn(async () => {}),
  setGranted: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  removePlugin: vi.fn(async () => {}),
  fetchInstall: vi.fn(async () => preview()),
  confirmInstall: vi.fn(async () => "fresh"),
  cancelInstall: vi.fn(async () => {}),
  listMissing: vi.fn(async () => [] as MissingPlugin[]),
  dismissMissing: vi.fn(async () => {}),
  // 웨이브 A 배선의 선택 dep — 기본은 "탈락 없음 / 기록 성공 / 앱 v0.1.0".
  // 미배선 경로를 검증하는 테스트는 `deps({ listRejected: undefined })`처럼 지워서 쓴다.
  listRejected: vi.fn(async () => [] as RejectedPlugin[]),
  setPendingReserved: vi.fn(async () => {}),
  hostVersion: vi.fn(async () => "0.1.0"),
  listBuiltinStates: vi.fn(async () => ({})),
  setBuiltinEnabled: vi.fn(async () => {}),
  listBuiltinSettings: vi.fn(async () => ({})),
  setBuiltinSetting: vi.fn(async () => {}),
  // 설정 액션 버튼 — 기본은 "명령이 등록돼 있어 실행을 보냈다"(dispatched).
  runPluginCommand: vi.fn(async () => "dispatched" as const),
  activeTheme: vi.fn(async () => null),
  activeFont: vi.fn(async () => null),
  onThemeUpdated: vi.fn(),
  readPluginReadme: vi.fn(async () => null as string | null),
  openExternal: vi.fn(async () => {}),
  pickPluginDir: vi.fn(async () => "/some/plugin/dir" as string | null),
  // 「메모 복구」 페이지 IO — 기본은 "노트도 스냅샷도 없음"(빈 상태). 스냅샷 흐름을 검증하는
  // 테스트는 listNotes·listSnapshots·readSnapshot·restoreSnapshot을 덮어써서 쓴다.
  listNotes: vi.fn(async () => [] as NoteSummary[]),
  listSnapshotNoteIds: vi.fn(async () => [] as string[]),
  listSnapshots: vi.fn(async () => [] as NoteSnapshot[]),
  readSnapshot: vi.fn(async () => ""),
  restoreSnapshot: vi.fn(async () => {}),
  ...over,
});

/** 설치 목록(두 번째 .plugin-list)에서 이름 버튼을 눌러 상세를 연다. */
const openInstalledDetail = (host: HTMLElement, name: string): void => {
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    ".plugin-list .plugin-name",
  );
  const target = [...buttons].find((b) => b.textContent?.startsWith(name));
  target!.click();
};

describe("mountSettings", () => {
  /** 가드: 초기 마운트가 테마 피커와 플러그인 목록을 그린다. */
  it("renders the theme picker and the plugin list", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [plugin({ name: "Wiki", version: "2.0.0" })],
      }),
    );
    expect(
      host.querySelector<HTMLSelectElement>(".settings-theme")!.value,
    ).toBe("sj_d");
    // 두 섹션: [0]=번들(위키링크), [1]=설치(Wiki). 설치 목록에 설치 플러그인이 뜬다.
    const lists = host.querySelectorAll(".plugin-list");
    // 번들 행은 이름과 버전을 분리(이름 버튼 + .plugin-ver 뱃지).
    expect(lists[0].querySelector(".plugin-name")!.textContent).toBe(
      "위키링크",
    );
    expect(lists[0].querySelector(".plugin-ver")!.textContent).toBe("v1.0.0");
    // 설치 목록은 버전을 이름에 함께 둔다(변경 없음).
    expect(lists[1].querySelector(".plugin-name")!.textContent).toBe(
      "Wiki v2.0.0",
    );
  });

  /** 가드: 테마를 바꾸면 theme만 덮어 저장한다(나머지 보존). */
  it("saves only the theme when the picker changes", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));
    const select = host.querySelector<HTMLSelectElement>(".settings-theme")!;
    // 옵션이 하나뿐이라 같은 값으로 트리거해도 콜백 경로를 검증할 수 있다.
    select.dispatchEvent(new Event("change"));
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d",
      defaults: {},
    });
  });

  /** 가드(이슈 #30 → ①단계): 언어 피커가 등록된 로케일(ko 코어 + 번들 언어팩이 공급하는
   * en — 둘 다 서드파티 언어팩 설치 없이 나온다. en은 `mountSettings`가 첫 렌더 전에
   * `loadEnabledBundledPacks`로 등록한다)을 보이고, language 미설정이면 이 창의 로케일(이
   * 파일은 위에서 "ko-KR"로 고정)로 판정된 언어가 기본 선택된다(store.ts availableLocales·
   * resolveLanguage와 일치). */
  it("renders the language picker with ko and en, ko selected by default on a Korean locale", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps({}));
    const select = host.querySelector<HTMLSelectElement>(".settings-language")!;
    expect(select.value).toBe("ko");
    expect([...select.options].map((o) => o.value)).toEqual(["ko", "en"]);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "한국어",
      "English",
    ]);
  });

  /** 가드(이슈 #30, 핵심): language가 미설정이고 이 창의 로케일이 한국어 계열이 아니면
   * en이 기본 선택된다 — resolveLanguage가 navigator.language로 판정한다. */
  it("defaults the language picker to en when unset on a non-Korean locale", async () => {
    Object.defineProperty(navigator, "language", {
      value: "en-US",
      configurable: true,
    });
    try {
      const host = document.createElement("div");
      await mountSettings(host, deps({}));
      const select =
        host.querySelector<HTMLSelectElement>(".settings-language")!;
      expect(select.value).toBe("en");
    } finally {
      Object.defineProperty(navigator, "language", {
        value: "ko-KR",
        configurable: true,
      });
    }
  });

  /** 가드: 언어를 바꾸면 language를 저장하고, 그 저장이 실제로 끝난 뒤에야 이 창 자신을
   * 새로고침한다(부분 재렌더로는 이미 그려진 다른 페이지 문구가 안 바뀌어 자체 reload가
   * 필요 — 저장 완료 전에 reload하면 아직 디스크에 안 닿은 변경을 버릴 수 있다). */
  it("saves the language and reloads this window only after the save resolves", async () => {
    const saveSettings = vi.fn(async () => {});
    const reloadFn = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadFn },
    });
    try {
      const host = document.createElement("div");
      await mountSettings(host, deps({ saveSettings }));
      const select =
        host.querySelector<HTMLSelectElement>(".settings-language")!;
      select.dispatchEvent(new Event("change"));
      expect(saveSettings).toHaveBeenCalledWith({
        schema_version: 1,
        theme: "sj_d",
        defaults: {},
        language: "ko",
      });
      expect(reloadFn).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(reloadFn).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  /** 가드(경합 수복): reload() 전에 notes-reload 디바운스 타이머를 반드시 flush한다 — self-reload가
   * 400ms 타이머보다 먼저 이 창의 JS 런타임을 파기해 다른 노트·패널 창이 예전 언어로 남는
   * 경합을 막는 안전장치가 실제로 배선돼 있는지 본다(순서까지: flush가 reload보다 먼저). */
  it("flushes the pending notes-reload before reloading after a language change", async () => {
    const calls: string[] = [];
    const saveSettings = vi.fn(async () => {
      calls.push("save");
    });
    const flushNotesReload = vi.fn(async () => {
      calls.push("flush");
    });
    const reloadFn = vi.fn(() => calls.push("reload"));
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadFn },
    });
    try {
      const host = document.createElement("div");
      await mountSettings(host, deps({ saveSettings, flushNotesReload }));
      const select =
        host.querySelector<HTMLSelectElement>(".settings-language")!;
      select.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(reloadFn).toHaveBeenCalledTimes(1));
      expect(flushNotesReload).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["save", "flush", "reload"]);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  /** 가드(상세 뷰 부여 이관): 상세 뷰의 민감 권한 토글이 현재 부여 + 새 권한을 합쳐
   * setGranted를 부른다(마스터 행 → 이름 클릭 → 상세 진입). */
  it("merges current grants when a sensitive permission is enabled in the detail view", async () => {
    const setGranted = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        // notes:read 이미 부여, windows는 미부여 — windows를 켜면 둘 다 보내야 한다.
        listPlugins: async () => [
          plugin({
            id: "x",
            name: "엑스",
            permissions: ["notes:read", "windows"],
            granted: ["notes:read"],
          }),
        ],
        setGranted,
      }),
    );
    // 마스터 행의 이름을 눌러 상세를 연다(권한 토글은 상세 뷰에 있다).
    openInstalledDetail(host, "엑스");
    await flush();
    // windows 토글(두 번째 민감 권한)을 켠다.
    const grants = host.querySelectorAll<HTMLInputElement>(".plugin-grant");
    const windowsToggle = grants[grants.length - 1];
    windowsToggle.checked = true;
    windowsToggle.dispatchEvent(new Event("change"));
    await flush();
    expect(setGranted).toHaveBeenCalledWith("x", ["notes:read", "windows"]);
  });

  /** 가드(설치 플로우): "폴더 선택"이 네이티브 선택기로 경로를 받아 local 스펙으로 fetch →
   * 프롬프트 → 승인 시 confirmInstall(스테이징, 민감 권한 전부)로 이어지고 상태를 표시한다. */
  it("stages a folder install picked from the native chooser and confirms it after approval", async () => {
    const d = deps();
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();

    // 선택기가 호출되고, 고른 경로가 그대로 local 스펙이 된다(손입력 없음).
    expect(d.pickPluginDir).toHaveBeenCalled();
    expect(d.fetchInstall).toHaveBeenCalledWith({
      kind: "local",
      location: "/some/plugin/dir",
    });
    // 프롬프트가 열리고 선언 권한이 한국어 설명으로 보인다.
    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toContain("Fresh v1.0.0");
    expect(prompt.textContent).toContain("노트 읽기");

    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    // 신규 설치 승인 = 선언된 민감 권한 전부 부여.
    expect(d.confirmInstall).toHaveBeenCalledWith("tok-1", ["notes:read"]);
    expect(prompt.hidden).toBe(true);
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "설치됨: fresh",
    );
  });

  /** 가드(설치 플로우): 폴더 선택기를 취소(null)하면 설치를 시작하지 않는다. */
  it("does nothing when the folder chooser is cancelled", async () => {
    const d = deps({ pickPluginDir: vi.fn(async () => null) });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();

    expect(d.pickPluginDir).toHaveBeenCalled();
    expect(d.fetchInstall).not.toHaveBeenCalled();
  });

  /** 가드(설치 플로우): URL 입력이 해석돼 fetchInstall(spec)로 가고, https가 아니면
   * 백엔드 호출 없이 오류를 보인다. */
  it("parses the URL input and rejects non-https without calling the backend", async () => {
    const d = deps();
    const host = document.createElement("div");
    await mountSettings(host, d);

    const input = host.querySelector<HTMLInputElement>(".plugin-install-url")!;
    const button = host.querySelector<HTMLButtonElement>(
      ".plugin-install-url-btn",
    )!;

    input.value = "http://x/p.zip"; // 평문 http → 거부.
    button.click();
    await flush();
    expect(d.fetchInstall).not.toHaveBeenCalled();
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "https",
    );

    input.value = "https://x/repo.git#v2";
    button.click();
    await flush();
    expect(d.fetchInstall).toHaveBeenCalledWith({
      kind: "git",
      location: "https://x/repo.git",
      git_ref: "v2",
    });
  });

  /** 가드(설치 플로우): 취소가 cancelInstall(스테이징)을 부르고 설치하지 않는다. */
  it("cancels the staged install when the prompt is dismissed", async () => {
    const d = deps();
    const host = document.createElement("div");
    await mountSettings(host, d);

    const input = host.querySelector<HTMLInputElement>(".plugin-install-url")!;
    input.value = "https://x/p.zip";
    host.querySelector<HTMLButtonElement>(".plugin-install-url-btn")!.click();
    await flush();

    host.querySelector<HTMLButtonElement>(".plugin-approve-cancel")!.click();
    await flush();
    expect(d.cancelInstall).toHaveBeenCalledWith("tok-1");
    expect(d.confirmInstall).not.toHaveBeenCalled();
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "취소",
    );
  });

  /** 가드(모달): "＋ 플러그인 추가" 버튼이 설치 모달을 열고(입력 표시), ✕가 닫는다. */
  it("opens the install modal from the add button and closes it with ✕", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const modal = host.querySelector<HTMLElement>(".settings-modal")!;
    const installRoot = host.querySelector<HTMLElement>(".plugin-install")!;
    expect(modal.hidden).toBe(true); // 평소엔 숨김.

    host.querySelector<HTMLButtonElement>(".plugin-add-btn")!.click();
    expect(modal.hidden).toBe(false); // 버튼 → 모달 열림.
    expect(installRoot.hidden).toBe(false); // 입력(URL·폴더)이 보인다.

    host.querySelector<HTMLButtonElement>(".settings-modal-close")!.click();
    expect(modal.hidden).toBe(true); // ✕ → 닫힘.
  });

  /** 가드(업데이트): 같은 버전이면 "최신" 안내 + 스테이징 폐기, 프롬프트는 열리지 않는다. */
  it("reports up-to-date and discards staging when versions match", async () => {
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "fresh",
          version: "1.0.0",
          source: { type: "url", url: "https://x/p.zip" },
        }),
      ],
      fetchInstall: vi.fn(async () => preview({ installed_version: "1.0.0" })),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    // "업데이트 확인"은 상세 뷰에 있다 — 이름 클릭으로 상세를 연 뒤 누른다.
    openInstalledDetail(host, "Plugin");
    await flush();
    host.querySelector<HTMLButtonElement>(".plugin-update")!.click();
    await flush();

    expect(d.fetchInstall).toHaveBeenCalledWith({
      kind: "url",
      location: "https://x/p.zip",
    });
    expect(d.cancelInstall).toHaveBeenCalledWith("tok-1");
    expect(host.querySelector<HTMLElement>(".plugin-approve")!.hidden).toBe(
      true,
    );
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "최신",
    );
  });

  /**
   * 가드(통합): `deps.setDevPlugin`이 배선돼 있으면 로컬 사이드로드 상세에 토글이 뜨고,
   * 켜면 `setDevPlugin(id)`를, 다시 열었을 때 체크 상태가 유지되며(reopenInstalledDetail이
   * 세션 상태를 투영), 끄면 `setDevPlugin(null)`을 부른다. `deps.setDevPlugin` 없이(기본
   * `deps()`) 열면 토글 자체가 없다 — pickPluginDir과 같은 "선택 dep 미배선=숨김" 규칙.
   */
  it("wires the developer-mode toggle to setDevPlugin and reflects it on reopen", async () => {
    const setDevPlugin = vi.fn(async () => {});
    const d = deps({
      listPlugins: async () => [
        plugin({ id: "loc", name: "Loc", source: { type: "local" } }),
      ],
      setDevPlugin,
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    openInstalledDetail(host, "Loc");
    const toggle = host.querySelector<HTMLInputElement>(
      ".plugin-devmode-toggle",
    )!;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(setDevPlugin).toHaveBeenCalledWith("loc");
    // 재조정 렌더(reopenInstalledDetail) 후에도 켜진 상태가 유지된다.
    expect(
      host.querySelector<HTMLInputElement>(".plugin-devmode-toggle")!.checked,
    ).toBe(true);

    const toggle2 = host.querySelector<HTMLInputElement>(
      ".plugin-devmode-toggle",
    )!;
    toggle2.checked = false;
    toggle2.dispatchEvent(new Event("change"));
    await flush();
    expect(setDevPlugin).toHaveBeenLastCalledWith(null);
  });

  /** 가드: `setDevPlugin` dep이 없으면(기본 deps()) 로컬 사이드로드여도 토글이 없다. */
  it("hides the developer-mode toggle when setDevPlugin is not wired", async () => {
    const d = deps({
      listPlugins: async () => [
        plugin({ id: "loc", name: "Loc", source: { type: "local" } }),
      ],
    });
    const host = document.createElement("div");
    await mountSettings(host, d);
    openInstalledDetail(host, "Loc");
    expect(host.querySelector(".plugin-devmode-toggle")).toBeNull();
  });

  /** 가드(업데이트): 새 버전이면 프롬프트에 "새 권한"이 강조되고, 승인 시 기존 부여 ∪
   * 새 민감 권한으로 confirm한다(사용자가 껐던 권한은 다시 켜지 않음). */
  it("highlights newly added sensitive perms and grants kept ∪ added on update", async () => {
    const d = deps({
      fetchInstall: vi.fn(async () =>
        preview({
          manifest: {
            id: "fresh",
            name: "Fresh",
            version: "2.0.0",
            entry: "main.js",
            // notes:write는 이전에도 선언됐지만 사용자가 부여하지 않았다 → 유지(재부여 안 함).
            permissions: ["editor", "notes:read", "notes:write", "clipboard"],
          },
          installed_version: "1.0.0",
          installed_permissions: ["editor", "notes:read", "notes:write"],
          installed_granted: ["notes:read"],
        }),
      ),
      listPlugins: async () => [
        plugin({
          id: "fresh",
          name: "프레시",
          version: "1.0.0",
          source: { type: "url", url: "https://x/p.zip" },
        }),
      ],
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    openInstalledDetail(host, "프레시");
    await flush();
    host.querySelector<HTMLButtonElement>(".plugin-update")!.click();
    await flush();

    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.textContent).toContain("v1.0.0 → v2.0.0");
    // clipboard(새로 선언된 민감 권한)에만 "새 권한" 표식.
    expect(prompt.querySelectorAll(".plugin-approve-added")).toHaveLength(1);

    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    expect(d.confirmInstall).toHaveBeenCalledWith("tok-1", [
      "notes:read",
      "clipboard",
    ]);
  });

  /** 가드(다운그레이드 — 차단 안 함): 설치될 버전이 현재보다 낮으면 승인 프롬프트 전에
   * confirm 다이얼로그로 한 번 더 묻는다. 취소하면 cancelInstall하고 승인 프롬프트는 안 뜬다. */
  it("asks for confirmation on downgrade and cancels the staging if declined", async () => {
    const d = deps({
      fetchInstall: vi.fn(async () =>
        preview({
          manifest: {
            id: "fresh",
            name: "Fresh",
            version: "1.0.0",
            entry: "main.js",
            permissions: ["editor"],
          },
          installed_version: "2.0.0",
          installed_permissions: ["editor"],
          installed_granted: [],
        }),
      ),
      listPlugins: async () => [
        plugin({
          id: "fresh",
          name: "프레시",
          version: "2.0.0",
          source: { type: "url", url: "https://x/p.zip" },
        }),
      ],
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    openInstalledDetail(host, "프레시");
    await flush();
    host.querySelector<HTMLButtonElement>(".plugin-update")!.click();
    await flush();

    // confirm 다이얼로그가 먼저 뜬다(승인 프롬프트는 아직 안 뜸).
    const confirmMsg = host.querySelector(".confirm-msg")!;
    expect(confirmMsg.textContent).toContain("v1.0.0");
    expect(confirmMsg.textContent).toContain("v2.0.0");
    expect(host.querySelector<HTMLElement>(".plugin-approve")!.hidden).toBe(
      true,
    );

    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();
    expect(d.cancelInstall).toHaveBeenCalledWith("tok-1");
    expect(d.confirmInstall).not.toHaveBeenCalled();
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "취소",
    );
  });

  /** 가드(다운그레이드 — 허용): confirm에서 계속을 고르면 "다운그레이드" 승인 프롬프트가 뜨고,
   * 승인하면 confirmInstall이 불려 되돌리기가 실제로 진행된다. */
  it("proceeds to the downgrade approval prompt when confirmed", async () => {
    const d = deps({
      fetchInstall: vi.fn(async () =>
        preview({
          manifest: {
            id: "fresh",
            name: "Fresh",
            version: "1.0.0",
            entry: "main.js",
            permissions: ["editor"],
          },
          installed_version: "2.0.0",
          installed_permissions: ["editor"],
          installed_granted: [],
        }),
      ),
      listPlugins: async () => [
        plugin({
          id: "fresh",
          name: "프레시",
          version: "2.0.0",
          source: { type: "url", url: "https://x/p.zip" },
        }),
      ],
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    openInstalledDetail(host, "프레시");
    await flush();
    host.querySelector<HTMLButtonElement>(".plugin-update")!.click();
    await flush();

    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toContain("다운그레이드");

    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    expect(d.confirmInstall).toHaveBeenCalledWith("tok-1", []);
    expect(host.querySelector(".plugin-install-status")!.textContent).toContain(
      "다운그레이드됨",
    );
  });

  /** 가드(재조정): listMissing 항목이 배너로 뜨고 [설치]는 승인 플로우를, [무시]는
   * dismissMissing을 부른다. */
  it("shows missing plugins and wires install/dismiss", async () => {
    const d = deps({
      listMissing: vi.fn(async () => [
        {
          id: "m",
          name: "Missing",
          version: "1.0.0",
          source: { type: "git", url: "https://x/m.git", ref: "v1" },
        } satisfies MissingPlugin,
      ]),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    const banner = host.querySelector<HTMLElement>(".plugin-missing")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Missing v1.0.0");

    banner.querySelector<HTMLButtonElement>(".plugin-missing-install")!.click();
    await flush();
    expect(d.fetchInstall).toHaveBeenCalledWith({
      kind: "git",
      location: "https://x/m.git",
      git_ref: "v1",
    });

    banner.querySelector<HTMLButtonElement>(".plugin-missing-dismiss")!.click();
    await flush();
    expect(d.dismissMissing).toHaveBeenCalledWith("m");
  });

  /** 가드(새 기기 재승인): "권한 승인" 버튼 → 프롬프트 승인 → setGranted(선언된 민감
   * 권한 전부)로 이어진다. */
  it("re-grants all declared sensitive perms via the approval prompt", async () => {
    const setGranted = vi.fn(async () => {});
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "needy",
          permissions: ["editor", "notes:read", "windows"],
          granted: [],
        }),
      ],
      setGranted,
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-approve-open")!.click();
    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.hidden).toBe(false);
    expect(prompt.textContent).toContain("권한 승인");

    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    expect(setGranted).toHaveBeenCalledWith("needy", ["notes:read", "windows"]);
  });

  /** 가드(배선): 새 기기 재승인 프롬프트도 플러그인의 자기신고 `permissionReasons`를
   * 권한 행 옆에 병기한다 — `InstalledPlugin` 타입엔 이 필드가 없으므로 런타임 페이로드를
   * 흉내 낸 주입으로 배선을 끝까지 검증한다. */
  it("shows the plugin's self-reported permission reason in the re-approval prompt", async () => {
    const withReason = plugin({
      id: "needy2",
      permissions: ["notes:read"],
      granted: [],
    }) as unknown as Record<string, unknown>;
    withReason.permissionReasons = {
      "notes:read": "위키링크 자동완성에 노트 제목이 필요해요",
    };
    const d = deps({
      listPlugins: async () => [withReason as unknown as InstalledPlugin],
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-approve-open")!.click();
    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.querySelector(".plugin-approve-reason")!.textContent).toBe(
      "플러그인이 밝힌 이유: 위키링크 자동완성에 노트 제목이 필요해요",
    );
  });

  /**
   * 가드(회귀): 새 기기 재승인은 **예약 권한을 부여하지 않고** pendingReserved로 남긴다.
   *
   * 왜: 설치 승인은 예약(vault:write 등)을 일부러 보류하는데, 이 버튼은 "선언된 민감 권한 전부"를
   * 부여해 그 보류를 뒤집었다 — 사용자는 앱 업데이트만으로 살아날 권한을 다시 묻지 않은 채
   * 갖게 됐다. 게다가 동기화로 넘어온 새 기기는 pendingReserved가 비어 있어, 여기서 심어
   * 두지 않으면 예약이 풀려도 재승인 배너가 아예 뜨지 않는다.
   */
  it("keeps reserved permissions pending instead of granting them on re-approval", async () => {
    const setGranted = vi.fn(async () => {});
    const setPendingReserved = vi.fn(async () => {});
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "needy",
          permissions: ["notes:read", "vault:write", "vault:read"],
          granted: [],
        }),
      ],
      setGranted,
      setPendingReserved,
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-approve-open")!.click();
    host
      .querySelector<HTMLElement>(".plugin-approve")!
      .querySelector<HTMLButtonElement>(".plugin-approve-ok")!
      .click();
    await flush();
    expect(setGranted).toHaveBeenCalledWith("needy", ["notes:read"]);
    expect(setPendingReserved).toHaveBeenCalledWith("needy", [
      "vault:write",
      "vault:read",
    ]);
  });

  /** 가드(배선): listRejected 결과가 실제로 커뮤니티 탭 배너에 뜬다 — 함수만 있고
   * 호출부가 없으면(예전 상태) 사용자는 여전히 아무것도 못 본다. */
  it("surfaces scan rejections with their reason in the community tab", async () => {
    const d = deps({
      listRejected: vi.fn(async () => [
        { dir_name: "half-copied", reason: "entry 파일 없음: main.js" },
      ]),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    expect(d.listRejected).toHaveBeenCalled();
    const banner = host.querySelector<HTMLElement>(".plugin-rejected")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("half-copied");
    expect(banner.textContent).toContain("entry 파일 없음: main.js");
  });

  /** 가드(비차단): dep이 없거나(미배선 호스트) 조회가 실패해도 배너만 숨긴 채 설정 창은
   * 정상 동작한다(재조정 배너와 같은 원칙). */
  it("keeps the settings window working when the rejection query is missing or fails", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps({ listRejected: undefined })); // 미배선 호스트
    expect(host.querySelector<HTMLElement>(".plugin-rejected")!.hidden).toBe(
      true,
    );

    const host2 = document.createElement("div");
    await mountSettings(
      host2,
      deps({
        listRejected: vi.fn(async () => {
          throw new Error("IPC 없음");
        }),
      }),
    );
    expect(host2.querySelector<HTMLElement>(".plugin-rejected")!.hidden).toBe(
      true,
    );
    expect(host2.querySelector(".plugin-list")).not.toBeNull();
  });

  /** 가드(기록): 설치 승인 시 예약이라 부여하지 못한 민감 권한이 pendingReserved로
   * 기록된다 — 이 기록이 없으면 예약이 풀려도 재승인 기회가 영영 오지 않는다. */
  it("records reserved-but-approved permissions after a confirmed install", async () => {
    const d = deps({
      fetchInstall: vi.fn(async () =>
        preview({
          manifest: {
            id: "fresh",
            name: "Fresh",
            version: "1.0.0",
            entry: "main.js",
            // vault:write는 민감 + 예약(PERMISSION_RESERVED) — 승인해도 부여되지 않는다.
            permissions: ["notes:read", "vault:write"],
          },
        }),
      ),
      setPendingReserved: vi.fn(async () => {}),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();
    host
      .querySelector<HTMLElement>(".plugin-approve")!
      .querySelector<HTMLButtonElement>(".plugin-approve-ok")!
      .click();
    await flush();

    // 부여는 비-예약 민감 권한만, 기억은 예약 민감 권한만 — 둘이 정확히 갈린다.
    expect(d.confirmInstall).toHaveBeenCalledWith("tok-1", ["notes:read"]);
    expect(d.setPendingReserved).toHaveBeenCalledWith("fresh", ["vault:write"]);
  });

  /** 가드(재승인): 저장된 pendingReserved 중 예약이 풀린 권한이 목록 행에 안내로 뜨고,
   * 승인하면 기존 부여에 더해 setGranted되고 pendingReserved는 남은 것만으로 줄어든다. */
  it("offers re-approval when a reserved permission became available", async () => {
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "late",
          name: "레이트",
          permissions: ["notes:read", "notes:write"],
          granted: ["notes:read"],
          // 설치 당시엔 둘 다 예약이었다고 가정 — notes:write는 지금 풀렸고 vault:write는 아직이다.
          pendingReserved: ["notes:write", "vault:write"],
        }),
      ],
      setPendingReserved: vi.fn(async () => {}),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    // 행에 "이제 쓸 수 있어요" 안내가 뜬다(권한 라벨과 함께).
    const row = host.querySelector<HTMLElement>(
      ".plugin-approval-row--reserved",
    )!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("노트 쓰기");

    row
      .querySelector<HTMLButtonElement>(".plugin-approve-reserved-open")!
      .click();
    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.hidden).toBe(false);
    // 이번에 열린 권한만 보인다(이미 판단이 끝난 나머지는 다시 묻지 않는다).
    expect(prompt.textContent).toContain("노트 쓰기");
    expect(prompt.textContent).not.toContain("노트 읽기");

    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    expect(d.setGranted).toHaveBeenCalledWith("late", [
      "notes:read",
      "notes:write",
    ]);
    // 해소된 항목만 빠지고 아직 예약인 것은 계속 기억한다.
    expect(d.setPendingReserved).toHaveBeenCalledWith("late", ["vault:write"]);
  });

  /** 가드(취소): 재승인을 취소하면 아무 상태도 바뀌지 않는다 — 모달은 Esc·배경 클릭으로도
   * 닫히므로, 취소를 영구 거부로 해석하면 오조작 한 번에 권한을 다시 볼 수 없게 된다. */
  it("changes nothing when the reserved re-approval is cancelled", async () => {
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "late",
          permissions: ["notes:write"],
          granted: ["notes:write"],
          pendingReserved: ["notes:write"],
        }),
      ],
      setPendingReserved: vi.fn(async () => {}),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host
      .querySelector<HTMLButtonElement>(".plugin-approve-reserved-open")!
      .click();
    host
      .querySelector<HTMLElement>(".plugin-approve")!
      .querySelector<HTMLButtonElement>(".plugin-approve-cancel")!
      .click();
    await flush();
    expect(d.setGranted).not.toHaveBeenCalled();
    expect(d.setPendingReserved).not.toHaveBeenCalled();
  });

  /** 가드(하위호환): pendingReserved 기록이 없는 기존 설치(구버전 백엔드 응답)에는
   * 안내 행이 뜨지 않는다. */
  it("shows no reserved re-approval row for installs without a record", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ listPlugins: async () => [plugin({ id: "old" })] }),
    );
    expect(host.querySelector(".plugin-approval-row--reserved")).toBeNull();
  });

  /** 가드: 매니페스트 minHostVersion이 앱 버전보다 높으면 승인 프롬프트 전에 확인을
   * 받는다(차단이 아니라 경고 — 다운그레이드 선례와 같은 정책). 취소하면 스테이징을 폐기한다. */
  it("warns before installing a plugin that requires a newer host", async () => {
    const staged = preview();
    (staged.manifest as Record<string, unknown>).minHostVersion = "9.9.9";
    const d = deps({
      fetchInstall: vi.fn(async () => staged),
      hostVersion: vi.fn(async () => "0.1.0"),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();

    // 확인 다이얼로그가 먼저 뜬다(승인 프롬프트는 아직).
    const msg = host.querySelector(".confirm-msg")!;
    expect(msg.textContent).toContain("9.9.9");
    expect(msg.textContent).toContain("0.1.0");
    expect(host.querySelector<HTMLElement>(".plugin-approve")!.hidden).toBe(
      true,
    );

    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();
    expect(d.cancelInstall).toHaveBeenCalledWith("tok-1");
    expect(d.confirmInstall).not.toHaveBeenCalled();
  });

  /** 가드(차단 아님): 확인에서 계속을 고르면 평소대로 승인 프롬프트로 이어져 설치된다. */
  it("still allows installing after the minHostVersion warning is accepted", async () => {
    const staged = preview();
    (staged.manifest as Record<string, unknown>).minHostVersion = "9.9.9";
    const d = deps({
      fetchInstall: vi.fn(async () => staged),
      hostVersion: vi.fn(async () => "0.1.0"),
    });
    const host = document.createElement("div");
    await mountSettings(host, d);

    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    const prompt = host.querySelector<HTMLElement>(".plugin-approve")!;
    expect(prompt.hidden).toBe(false);
    prompt.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
    await flush();
    expect(d.confirmInstall).toHaveBeenCalledWith("tok-1", ["notes:read"]);
  });

  /** 가드(폴백): 요구 버전을 충족하거나 앱 버전을 모르면(hostVersion 미배선) 확인 없이
   * 곧장 승인 프롬프트로 간다 — 모르면 막지 않는다. */
  it("does not warn when the requirement is met or the app version is unknown", async () => {
    const met = preview();
    (met.manifest as Record<string, unknown>).minHostVersion = "0.1.0";
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        fetchInstall: vi.fn(async () => met),
        hostVersion: vi.fn(async () => "0.2.0"),
      }),
    );
    host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();
    expect(host.querySelector(".confirm-msg")).toBeNull();
    expect(host.querySelector<HTMLElement>(".plugin-approve")!.hidden).toBe(
      false,
    );

    // hostVersion 미배선(구버전 호스트) — 비교 불가라 경고 없이 통과한다.
    const unknown = preview();
    (unknown.manifest as Record<string, unknown>).minHostVersion = "9.9.9";
    const host2 = document.createElement("div");
    await mountSettings(
      host2,
      deps({
        fetchInstall: vi.fn(async () => unknown),
        hostVersion: undefined, // 구버전 호스트 — 앱 버전을 알 길이 없다.
      }),
    );
    host2.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
    await flush();
    expect(host2.querySelector(".confirm-msg")).toBeNull();
    expect(host2.querySelector<HTMLElement>(".plugin-approve")!.hidden).toBe(
      false,
    );
  });
});

describe("settings tree + theme tokens (D2·D6)", () => {
  const treeItem = (host: HTMLElement, id: string) =>
    host.querySelector<HTMLElement>(`.settings-tree-item[data-node="${id}"]`)!;

  /** 가드: 좌측 트리에 외형(테마·글꼴) 그룹 + 관리 노드가 뜨고, 기본 선택은 외형 › 테마다. */
  it("mounts with the 외형 group and 테마 page selected", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());

    // 트리 항목 라벨 — 외형(테마·글꼴)과 「플러그인」 하위 관리 노드(번들·커뮤니티)가 모두 있다.
    const labels = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-item"),
    ].map((i) => i.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["테마", "글꼴", "번들", "커뮤니티"]),
    );
    // 그룹 헤더 순서: "외형" 맨 앞, "플러그인" 맨 뒤(그 사이 "도구").
    const groups = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].map((g) => g.textContent);
    expect(groups[0]).toBe("외형");
    expect(groups[groups.length - 1]).toBe("플러그인");
    expect(groups).toContain("도구");
    // 번들·커뮤니티는 "플러그인" 그룹 본문 안에 있다(하위 세분화).
    const pluginGroup = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].find((g) => g.textContent === "플러그인")!;
    const pluginBody = pluginGroup.nextElementSibling as HTMLElement;
    expect(pluginBody.classList.contains("settings-tree-group-body")).toBe(
      true,
    );
    const subLabels = [
      ...pluginBody.querySelectorAll<HTMLElement>(".settings-tree-item"),
    ].map((i) => i.textContent);
    expect(subLabels).toEqual(["번들", "커뮤니티"]);

    // 기본 선택 = 외형 › 테마 → 테마 페이지만 보이고 테마 피커가 있다.
    expect(
      treeItem(host, "appearance:theme").classList.contains(
        "settings-tree-item-active",
      ),
    ).toBe(true);
    const themePage = host.querySelector<HTMLElement>("#settings-page-theme")!;
    expect(themePage.hidden).toBe(false);
    expect(themePage.querySelector(".settings-theme")).not.toBeNull();
    // 관리 페이지는 숨김이되 내용(목록·추가 버튼·모달)은 존재한다.
    const bundlePage = host.querySelector<HTMLElement>(
      "#settings-page-bundle",
    )!;
    const communityPage = host.querySelector<HTMLElement>(
      "#settings-page-community",
    )!;
    expect(bundlePage.hidden).toBe(true);
    expect(bundlePage.querySelector(".plugin-list")).not.toBeNull();
    expect(communityPage.hidden).toBe(true);
    expect(communityPage.querySelector(".plugin-add-btn")).not.toBeNull();
    expect(host.querySelector<HTMLElement>(".settings-modal")!.hidden).toBe(
      true,
    ); // 설치 모달은 평소 숨김.
  });

  /**
   * 가드: 「커뮤니티 플러그인」 패널의 "플러그인 만들기" 버튼은 저작 가이드(GitHub)를
   * openExternal(외부 브라우저)로 연다 — 베타 피드백(만드는 법을 모르겠다)의 진입점.
   */
  it("opens the plugin authoring guide via the 플러그인 만들기 button", async () => {
    const openExternal = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ openExternal }));
    const communityPage = host.querySelector<HTMLElement>(
      "#settings-page-community",
    )!;
    const guideButton =
      communityPage.querySelector<HTMLButtonElement>(".plugin-guide-btn")!;
    expect(guideButton).not.toBeNull();
    guideButton.click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/HaruPlan/note-rang/blob/main/docs/plugin/authoring.md",
    );
  });

  /** 가드: 트리 항목 클릭이 활성 표시·페이지 표시를 함께 전환한다(왕복). */
  it("switches pages when tree items are clicked", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const themePage = host.querySelector<HTMLElement>("#settings-page-theme")!;
    const bundlePage = host.querySelector<HTMLElement>(
      "#settings-page-bundle",
    )!;

    treeItem(host, "manager:bundle").click();
    expect(
      treeItem(host, "manager:bundle").classList.contains(
        "settings-tree-item-active",
      ),
    ).toBe(true);
    expect(
      treeItem(host, "appearance:theme").classList.contains(
        "settings-tree-item-active",
      ),
    ).toBe(false);
    expect(themePage.hidden).toBe(true);
    expect(bundlePage.hidden).toBe(false);

    treeItem(host, "appearance:theme").click(); // 테마로 복귀.
    expect(themePage.hidden).toBe(false);
    expect(bundlePage.hidden).toBe(true);
  });

  /** 가드(설정 추출): 스키마 있는 번들이 자기 매니페스트 category 그룹의 트리 페이지가 된다. */
  it("gives schema plugins their own tree page under their category", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    // 복사하기(도구)는 트리 항목 + 설정 페이지(스키마 폼)를 갖는다.
    const item = treeItem(host, "plugin:copy-ai-prompt");
    expect(item).not.toBeNull();
    expect(item.textContent).toBe("복사하기");
    item.click();
    const page = [...host.querySelectorAll<HTMLElement>(".settings-page")].find(
      (p) => !p.hidden && p.querySelector(".plugin-settings-form"),
    )!;
    expect(page).not.toBeUndefined();
    // 저장값이 없으면 스키마 기본값으로 초기화된다(복사하기 "복사 문구" 기본 "{path}").
    const firstInput = page.querySelector<HTMLInputElement>(
      ".plugin-setting-input",
    )!;
    expect(firstInput.value).toBe("{path}");
    // 도구 그룹 헤더도 있다(외형 외 카테고리 자동 분류).
    const groups = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].map((g) => g.textContent);
    expect(groups).toContain("도구");
  });

  // "en"은 번들 언어팩이 공급하고 `mountSettings`가 첫 렌더 전에 등록한다(store.ts·packs.ts)
  // — 예전엔 여기 beforeEach에서 registerLocale("en", ...)로 직접 등록해야 했지만 이제
  // 불필요하다. 아래 테스트들이 language: "en"으로 여는 것만으로 setActiveLocale이 즉시
  // 반영된다. "en"으로 새는 활성 로케일만 afterEach로 되돌린다.
  afterEach(() => setActiveLocale("ko"));

  /** template 설정 페이지를 en 로케일로 연다 — 아래 로케일화 가드들이 공유. */
  const openTemplatePageInEnglish = async (
    over: Record<string, unknown> = {},
  ): Promise<HTMLElement> => {
    const host = document.createElement("div");
    const d = deps({
      getSettings: async () => ({ ...settings, language: "en" }),
      ...over,
    });
    await mountSettings(host, d);
    treeItem(host, "plugin:template").click();
    return host;
  };

  const listCards = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLElement>(
      "#settings-page-plugin-template .plugin-list-item",
    ),
  ];
  const cardName = (card: HTMLElement) =>
    card.querySelector<HTMLInputElement>(".plugin-list-name")!.value;
  const cardBody = (card: HTMLElement) =>
    card.querySelector<HTMLTextAreaElement>(".plugin-list-body")!.value;

  /**
   * 가드(a): 템플릿 설정에 저장값이 없으면(listBuiltinSettings 기본 `{}`) + en 로케일 → 영어
   * 기본 세트가 카드로 뜬다(main.js가 보는 값과 같은 규칙 — template.test.ts와 쌍).
   */
  it("template 설정: 저장값 없음 + en 로케일 → 영어 기본 세트 카드가 뜬다", async () => {
    const host = await openTemplatePageInEnglish();
    const cards = listCards(host);
    expect(cards.map(cardName)).toEqual(
      TEMPLATE_EN_DEFAULT_TEMPLATES.map((t) => t.name),
    );
    expect(cardBody(cards[0])).toBe(TEMPLATE_EN_DEFAULT_TEMPLATES[0].body);
  });

  /** 가드(b): 사용자가 실제로 저장한 값은 로케일이 en이어도 그대로 카드에 보인다. */
  it("template 설정: 저장된 실제 값은 en 로케일이어도 그대로 유지된다", async () => {
    const host = await openTemplatePageInEnglish({
      listBuiltinSettings: vi.fn(async () => ({
        template: { templates: "=== 내 템플릿 ===\n내 내용" },
      })),
    });
    const cards = listCards(host);
    expect(cards.map(cardName)).toEqual(["내 템플릿"]);
    expect(cardBody(cards[0])).toBe("내 내용");
  });

  /**
   * 가드(c): "기본값으로 되돌리기" 버튼이 있고, 확인 후 누르면 **현재 로케일**(en)의 기본
   * 세트로 통째로 갈아 끼우며 그 값을 저장한다(설정 창의 기존 confirm 관례를 따른다).
   */
  it("template 설정: 되돌리기 확인 → en 기본 세트로 되돌리고 저장한다", async () => {
    const setBuiltinSetting = vi.fn(async () => {});
    const host = await openTemplatePageInEnglish({
      listBuiltinSettings: vi.fn(async () => ({
        template: { templates: "=== 내 템플릿 ===\n내 내용" },
      })),
      setBuiltinSetting,
    });
    const page = host.querySelector<HTMLElement>(
      "#settings-page-plugin-template",
    )!;
    page.querySelector<HTMLButtonElement>(".plugin-list-reset")!.click();
    await flush();
    // 확인 팝업 — 취소 없이 곧장 반영되지 않는다(파괴적 동작이므로 확인이 우선 뜬다).
    const confirmBox = host.querySelector(".confirm-overlay");
    expect(confirmBox).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    const cards = listCards(host);
    expect(cards.map(cardName)).toEqual(
      TEMPLATE_EN_DEFAULT_TEMPLATES.map((t) => t.name),
    );
    expect(setBuiltinSetting).toHaveBeenCalledWith(
      "template",
      "templates",
      serializeListBlob(TEMPLATE_EN_DEFAULT_TEMPLATES),
    );
  });

  /** 가드: 되돌리기 확인 팝업에서 취소하면 아무것도 바뀌지 않는다. */
  it("template 설정: 되돌리기 취소 → 저장된 값이 그대로 남는다", async () => {
    const setBuiltinSetting = vi.fn(async () => {});
    const host = await openTemplatePageInEnglish({
      listBuiltinSettings: vi.fn(async () => ({
        template: { templates: "=== 내 템플릿 ===\n내 내용" },
      })),
      setBuiltinSetting,
    });
    const page = host.querySelector<HTMLElement>(
      "#settings-page-plugin-template",
    )!;
    page.querySelector<HTMLButtonElement>(".plugin-list-reset")!.click();
    await flush();
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();

    expect(listCards(host).map(cardName)).toEqual(["내 템플릿"]);
    expect(setBuiltinSetting).not.toHaveBeenCalled();
  });

  /**
   * 가드: `default`가 없는(빈) list 필드는 "기본값으로 되돌리기" 버튼 자체가 안 뜬다 — 되돌릴
   * 데이터가 없는데 버튼만 있으면 눌러도 빈 목록으로 갈아 끼우는 혼란만 준다.
   */
  it("default가 없는 list 필드에는 되돌리기 버튼이 없다(설치 플러그인)", async () => {
    const host = document.createElement("div");
    const noDefaultListPlugin = plugin({
      id: "no-default-list",
      name: "목록만",
      enabled: true,
      settings_schema: [
        { key: "items", label: "항목", type: "list", options: [] },
      ],
      settings: {},
    });
    await mountSettings(
      host,
      deps({ listPlugins: async () => [noDefaultListPlugin] }),
    );
    treeItem(host, "plugin:no-default-list").click();
    const page = host.querySelector<HTMLElement>(
      "#settings-page-plugin-no-default-list",
    )!;
    expect(page.querySelector(".plugin-list-reset")).toBeNull();
    expect(page.querySelector(".plugin-list-add")).not.toBeNull();
  });

  /**
   * 액션 버튼을 선언한 설치 플러그인 픽스처.
   *
   * 왜 번들 실물이 아닌가: 번들에는 액션 버튼을 두는 것이 더는 없다(copy-ai-prompt에서
   * 걷어냈다 — 설정 창에는 노트가 없어 그 버튼의 창-스코프 호출이 "메모 창에서 이 플러그인을
   * 한 번 써야" 동작하는 자기모순이었다). 저작 쪽 도그푸딩은 정본 예제
   * `example-settings-button`이 헤드리스 하니스로 계속 태운다(examples.test.ts).
   */
  const actionPlugin = () =>
    plugin({
      id: "util",
      name: "Util",
      enabled: true,
      settings_schema: [
        {
          key: "wipe",
          label: "전부 지우기",
          type: "button",
          command: "wipe-all",
          options: [],
        },
      ],
    });

  /** 액션 버튼이 있는 설정 페이지를 열고 그 버튼을 누른다(가드 공용). */
  const clickActionButton = async (
    host: HTMLElement,
    over: Record<string, unknown> = {},
  ): Promise<{ status: HTMLElement; d: ReturnType<typeof deps> }> => {
    const d = deps({ listPlugins: async () => [actionPlugin()], ...over });
    await mountSettings(host, d);
    treeItem(host, "plugin:util").click();
    const page = host.querySelector<HTMLElement>("#settings-page-plugin-util")!;
    page.querySelector<HTMLButtonElement>(".plugin-action-button")!.click();
    await flush();
    return {
      status: page.querySelector<HTMLElement>(".plugin-setting-status")!,
      d,
    };
  };

  /**
   * 가드(종단 배선): 매니페스트가 선언한 액션 버튼이 설정 페이지에 뜨고, 누르면 **그
   * 플러그인의 명령 id로** `runPluginCommand`가 불린다.
   *
   * 왜 필요한가: 위젯 단위 테스트는 "버튼이 그려진다"까지만 증명한다. 매니페스트의 `command`
   * → 설정 페이지 → dep 호출까지가 이어져 있는지는 스키마를 실제로 태워야 드러난다(이
   * 저장소가 11번 겪은 "선언은 됐는데 아무도 안 읽는다"를 여기서 막는다).
   */
  it("runs the manifest-declared command when a settings action button is clicked", async () => {
    const host = document.createElement("div");
    const { status, d } = await clickActionButton(host);
    expect(
      host.querySelector<HTMLElement>(
        "#settings-page-plugin-util .plugin-action-button",
      )!.textContent,
    ).toBe("전부 지우기");
    expect(d.runPluginCommand).toHaveBeenCalledWith("util", "wipe-all");
    expect(status.textContent).toContain("실행을 요청했어요");
  });

  /**
   * 가드(피드백 루프): 보낸 실행이 남긴 진단이 **버튼 아래 상태 줄**에 나타난다.
   *
   * 왜: 설정 창에는 노트가 없어 명령 본문의 `ui.toast`가 누른 사람에게 닿지 못한다(폴백
   * 메모 창이 있으면 그쪽에 뜨고, 없으면 아무 데도 안 뜬다). 이 배선이 없으면 상태 줄은
   * "실행을 요청했어요"에서 멈추고 진짜 결과는 다른 페이지(상세 › 「최근 오류」)에만 남는다 —
   * 버튼을 누른 사람이 보고 있지 않은 곳이다.
   */
  it("shows the diagnostic the dispatched command left in the status line", async () => {
    const { status } = await clickActionButton(document.createElement("div"), {
      pluginDiagnostics: vi.fn(async () => [
        {
          pluginId: "util",
          at: Date.now(),
          kind: "log" as const,
          message: "이렇게 복사했어요: /tmp/메모.md",
        },
      ]),
    });
    await vi.waitFor(() =>
      expect(status.textContent).toBe("이렇게 복사했어요: /tmp/메모.md"),
    );
  });

  /**
   * 가드: 플러그인이 적은 사람말(`log`)이 아니라 **호스트가 관측한 실패**면 종류 라벨을
   * 앞에 붙인다 — 정보 한 줄과 실패 한 줄이 상태 줄에서 구별되지 않으면 안 된다.
   */
  it("labels a host-observed failure by its diagnostic kind", async () => {
    const { status } = await clickActionButton(document.createElement("div"), {
      pluginDiagnostics: vi.fn(async () => [
        {
          pluginId: "util",
          at: Date.now(),
          kind: "no-window-context" as const,
          code: "CONTEXT_UNAVAILABLE",
          message: "창 컨텍스트가 유휴 만료되었습니다",
        },
      ]),
    });
    await vi.waitFor(() =>
      expect(status.textContent).toBe(
        "창 없음(무시됨): 창 컨텍스트가 유휴 만료되었습니다",
      ),
    );
  });

  /**
   * 가드: 이번 실행이 아무 기록도 안 남기면 상한에서 멈추고 **사실대로** 적는다. 이전 실행이
   * 남긴 옛 기록(`at`이 기준선보다 앞)은 이번 결과로 오인하지 않는다 — 그 오인이 생기면
   * 한 번 실패한 플러그인이 이후 모든 클릭에서 같은 실패를 다시 보고하게 된다.
   */
  it("reports no result instead of reusing a diagnostic from an earlier run", async () => {
    const host = document.createElement("div");
    const { status } = await clickActionButton(host, {
      pluginDiagnostics: vi.fn(async () => [
        {
          pluginId: "util",
          at: 1, // 지난 실행의 기록(기준선보다 한참 앞)
          kind: "log" as const,
          message: "옛날 기록",
        },
      ]),
    });
    // 지켜보기 상한(2초)을 실시간으로 넘긴다 — 가짜 타이머로 갈아 끼우면 이미 실타이머로
    // 예약된 첫 폴링이 영영 안 깨어나 루프가 상한에 닿지 못한다(그 함정을 여기 적어 둔다).
    await vi.waitFor(
      () => expect(status.textContent).toContain("남긴 결과는 없어요"),
      { timeout: 5000, interval: 50 },
    );
    expect(status.textContent).not.toContain("옛날 기록");
  });

  /**
   * 가드: 등록되지 않은 명령이면 **무음이 아니라 무엇이 어긋났는지**를 적는다.
   *
   * 매니페스트의 `command`와 `commands.register`의 `id`가 어긋나는 것이 이 기능의 대표
   * 실패 모드다. 여기서 문구를 안 내면 사용자에게는 "눌러도 아무 일이 없다"만 남는다.
   */
  it("reports the mismatch when the command is not registered", async () => {
    const host = document.createElement("div");
    const { status } = await clickActionButton(host, {
      runPluginCommand: vi.fn(async () => "unregistered" as const),
    });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("wipe-all");
    expect(status.textContent).toContain("등록하지 않았어요");
  });

  /**
   * 가드(회귀): 설정 화면에서 실행할 수 없는 명령(`when`의 창-의존 키·`destructive`)은
   * "실행을 요청했어요"라는 **거짓 성공이 아니라 왜 안 되는지**를 상태 줄에 적는다.
   *
   * 예전엔 요청을 무조건 보내고 성공 문구를 띄웠는데, 호스트는 창 컨텍스트가 없어 그 실행을
   * 진단만 남기고 조용히 삼켰다 — 사용자에게는 "됐다는데 아무 일도 없다"만 남았다.
   */
  it("explains why a window-dependent or destructive command cannot run from settings", async () => {
    for (const [outcome, phrase] of [
      ["needs-note-window", "when 조건은 메모 창의 상태"],
      ["needs-confirm-window", "확인 팝업을 띄울 메모 창이 없어요"],
    ] as const) {
      const host = document.createElement("div");
      const { status } = await clickActionButton(host, {
        runPluginCommand: vi.fn(async () => outcome),
      });
      expect(status.hidden).toBe(false);
      expect(status.textContent).toContain(phrase);
      expect(status.textContent).not.toContain("실행을 요청했어요");
    }
  });

  /** 가드: 그룹 헤더를 누르면 그 그룹이 접히고(본문 숨김), 다시 누르면 펼쳐진다. */
  it("collapses and expands a group when its header is clicked", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const pluginGroup = [
      ...host.querySelectorAll<HTMLButtonElement>(".settings-tree-group"),
    ].find((g) => g.textContent === "플러그인")!;
    const body = pluginGroup.nextElementSibling as HTMLElement;
    expect(body.hidden).toBe(false); // 기본은 펼침
    pluginGroup.click();
    expect(body.hidden).toBe(true); // 접힘
    expect(
      pluginGroup.classList.contains("settings-tree-group-collapsed"),
    ).toBe(true);
    pluginGroup.click();
    expect(body.hidden).toBe(false); // 다시 펼침
  });

  /** 가드: 트리 검색이 라벨로 항목을 좁히고, 매칭 없는 그룹 헤더는 숨긴다(검색 중엔 접힘 무시). */
  it("filters tree items by search and hides empty groups", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    search.value = "글꼴";
    search.dispatchEvent(new Event("input"));
    expect(treeItem(host, "appearance:font").hidden).toBe(false);
    expect(treeItem(host, "appearance:theme").hidden).toBe(true);
    // "플러그인" 그룹은 이제 숨지 않는다 — 번들 「폰트」 플러그인의 한 줄 요약("테마 폰트
    // 피커에 글꼴 공급")도 검색 인덱스에 있어 "번들" 항목이 함께 매칭된다(아래 별도 가드).
    const pluginGroup = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].find((g) => g.textContent === "플러그인")!;
    expect(pluginGroup.hidden).toBe(false);
  });

  /** 가드: 매칭이 어느 그룹에도 없으면 그 그룹 헤더는 여전히 숨는다(검색 좁히기의 핵심). */
  it("still hides a group with no match at all", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    // "시스템 기본"은 「글꼴」 페이지의 항목 검색어(settings.font.system-default-label)에만
    // 있고, 어떤 번들/설치 플러그인 이름·요약에도 없다.
    search.value = "시스템 기본";
    search.dispatchEvent(new Event("input"));
    expect(treeItem(host, "appearance:font").hidden).toBe(false);
    expect(treeItem(host, "appearance:theme").hidden).toBe(true);
    const pluginGroup = [
      ...host.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].find((g) => g.textContent === "플러그인")!;
    expect(pluginGroup.hidden).toBe(true);
  });

  /** 그룹 헤더·본문을 라벨로 (재)조회한다 — rebuild로 DOM이 갈리므로 매번 다시 찾는다. */
  const groupBody = (host: HTMLElement, name: string) => {
    const header = [
      ...host.querySelectorAll<HTMLButtonElement>(".settings-tree-group"),
    ].find((g) => g.textContent === name)!;
    return { header, body: header.nextElementSibling as HTMLElement };
  };

  /** 가드(핵심): 접힘 상태가 트리 재조립(플러그인 토글 등) 후에도 보존된다(collapsed는 render 밖 상태). */
  it("keeps a group collapsed across a tree rebuild", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    groupBody(host, "플러그인").header.click(); // 접기
    expect(groupBody(host, "플러그인").body.hidden).toBe(true);

    // 번들 목록의 빌트인 토글 → onToggle → rebuildTree(DOM 전체 교체).
    host
      .querySelector<HTMLInputElement>(
        "#settings-page-bundle .plugin-enable-toggle",
      )!
      .click();
    await flush();

    // 재조립 후 '다시 조회'해도 여전히 접혀 있다(기존 참조로는 회귀를 못 잡는다).
    const after = groupBody(host, "플러그인");
    expect(after.body.hidden).toBe(true);
    expect(
      after.header.classList.contains("settings-tree-group-collapsed"),
    ).toBe(true);
  });

  /** 가드: category 미선언 설치 플러그인의 설정은 기본 "도구" 그룹으로 가고, "플러그인" 그룹은
   * 관리(번들·커뮤니티) 전용으로 남는다(설정 페이지가 관리 그룹으로 새지 않음). */
  it("puts a category-undeclared plugin's settings under 도구", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({
            id: "util",
            name: "Util",
            enabled: true,
            settings_schema: [
              { key: "x", label: "X", type: "text", options: [] },
            ],
          }),
        ],
      }),
    );
    // 설치 플러그인은 마운트 끝 refresh에서 반영된다.
    const util = treeItem(host, "plugin:util");
    expect(util).not.toBeNull();
    // "플러그인" 그룹 본문은 여전히 번들·커뮤니티뿐(설치형 설정이 새지 않음).
    const pluginLabels = [
      ...groupBody(host, "플러그인").body.querySelectorAll<HTMLElement>(
        ".settings-tree-item",
      ),
    ].map((i) => i.textContent);
    expect(pluginLabels).toEqual(["번들", "커뮤니티"]);
    // Util은 "도구" 그룹 본문 안에 있다.
    const toolLabels = [
      ...groupBody(host, "도구").body.querySelectorAll<HTMLElement>(
        ".settings-tree-item",
      ),
    ].map((i) => i.textContent);
    expect(toolLabels).toContain("Util");
  });

  /**
   * 가드: `confirm`이 선언된 액션 버튼은 **확인을 통과해야만** 명령을 보낸다.
   *
   * 설정 창에는 노트 창의 확인 팝업(`destructive`)이 닿지 않으므로, 되돌릴 수 없는 설정
   * 버튼의 확인은 오직 이 경로다. 취소가 조용히 실행으로 이어지면 그것이 곧 사고다.
   */
  it("gates a confirm-declared action button on the dialog answer", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const d = deps({
      listPlugins: async () => [
        plugin({
          id: "util",
          name: "Util",
          enabled: true,
          settings_schema: [
            {
              key: "wipe",
              label: "전부 지우기",
              type: "button",
              command: "wipe-all",
              confirm: "정말 지울까요?",
              options: [],
            },
          ],
        }),
      ],
    });
    await mountSettings(host, d);
    treeItem(host, "plugin:util").click();
    const btn = host.querySelector<HTMLButtonElement>(
      "#settings-page-plugin-util .plugin-action-button",
    )!;

    // 1) 취소 — 확인 다이얼로그의 취소 버튼을 누르면 명령이 나가지 않는다.
    btn.click();
    await Promise.resolve();
    const cancel = [
      ...host.querySelectorAll<HTMLButtonElement>(".confirm-actions button"),
    ][0];
    expect(cancel).not.toBeUndefined();
    cancel.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.runPluginCommand).not.toHaveBeenCalled();
    // 취소는 실패가 아니다 — 상태 줄에 아무것도 남기지 않는다.
    expect(
      host.querySelector<HTMLElement>(
        "#settings-page-plugin-util .plugin-setting-status",
      )!.hidden,
    ).toBe(true);

    // 2) 확인 — 그때 비로소 명령이 나간다.
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const confirm = [
      ...host.querySelectorAll<HTMLButtonElement>(".confirm-actions button"),
    ][1];
    confirm.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.runPluginCommand).toHaveBeenCalledWith("util", "wipe-all");
    host.remove();
  });

  /** 가드: 접힌 그룹도 검색 매칭이 있으면 펼쳐 보이고(검색 중 접힘 무시), 검색을 지우면 복원된다. */
  it("search overrides collapse and restores it when cleared", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    groupBody(host, "플러그인").header.click(); // 접기
    expect(groupBody(host, "플러그인").body.hidden).toBe(true);

    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    search.value = "번들";
    search.dispatchEvent(new Event("input"));
    expect(groupBody(host, "플러그인").body.hidden).toBe(false); // 검색이 접힘 무시
    expect(treeItem(host, "manager:bundle").hidden).toBe(false);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(groupBody(host, "플러그인").body.hidden).toBe(true); // 접힘 복원
  });

  /** 가드(회귀): 검색 중 그룹 헤더 클릭은 접힘을 조용히 뒤집지 않는다(무효 클릭 무시). */
  it("ignores group-header clicks while searching", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    search.value = "번들"; // "플러그인" 그룹만 매칭 → 헤더 표시됨
    search.dispatchEvent(new Event("input"));
    groupBody(host, "플러그인").header.click(); // 검색 중 클릭(무효)

    search.value = "";
    search.dispatchEvent(new Event("input"));
    // 검색을 지워도 접히지 않는다(무효 클릭이 상태를 바꾸지 않았다).
    expect(groupBody(host, "플러그인").body.hidden).toBe(false);
  });

  /** 트리 항목의 라벨(첫 줄)·힌트(둘째 줄) 텍스트를 읽는다. */
  const itemHint = (host: HTMLElement, id: string) =>
    treeItem(host, id).querySelector<HTMLElement>(".settings-tree-item-hint")!;

  /**
   * 가드(핵심): 검색이 페이지 이름이 아니라 그 페이지의 개별 설정 항목(플러그인 매니페스트
   * schema의 label/description)에서 매칭되면, 페이지는 트리에 뜨고 매칭된 항목 문구가 힌트로
   * 보인다. 검색을 지우면 힌트도 비워진다.
   */
  it("matches a settings page by its individual field label/description and shows a hint", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({
            id: "util",
            name: "Util",
            enabled: true,
            settings_schema: [
              {
                key: "x",
                label: "표시 이름",
                type: "text",
                options: [],
                description: "AI 프롬프트에 쓸 별칭이에요",
              },
            ],
          }),
        ],
      }),
    );
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    // "Util"이라는 페이지 이름에는 없고 필드 description에만 있는 문구.
    search.value = "AI 프롬프트";
    search.dispatchEvent(new Event("input"));
    expect(treeItem(host, "plugin:util").hidden).toBe(false);
    expect(itemHint(host, "plugin:util").hidden).toBe(false);
    expect(itemHint(host, "plugin:util").textContent).toBe(
      "AI 프롬프트에 쓸 별칭이에요",
    );
    // 매칭이 항목에서 났으므로 트리 항목 자체(버튼) textContent는 라벨 + 힌트를 잇는다.
    expect(treeItem(host, "plugin:util").textContent).toBe(
      "UtilAI 프롬프트에 쓸 별칭이에요",
    );

    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(itemHint(host, "plugin:util").hidden).toBe(true);
    expect(itemHint(host, "plugin:util").textContent).toBe("");
  });

  /**
   * 가드: 페이지 이름 자체가 매칭되면(라벨 매칭) 힌트는 채우지 않는다 — 페이지 이름과 똑같은
   * 문구를 그 아래 다시 보여주는 군더더기를 피한다.
   */
  it("does not show a hint when the match is the page label itself", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    search.value = "글꼴";
    search.dispatchEvent(new Event("input"));
    // 라벨이 정확히 "글꼴"인 appearance:font는 힌트 없이(라벨 매칭) 보인다.
    expect(itemHint(host, "appearance:font").hidden).toBe(true);
  });

  /**
   * 가드: 설정 폼이 없어(스키마 無) 자기 설정 페이지가 없는 번들 플러그인도, 그 한 줄 요약으로
   * 검색하면 「번들」 관리 페이지가 매칭되고 힌트에 그 요약이 뜬다 — 매니페스트 데이터만으로
   * 채운 검색 인덱스([`manager:bundle`] searchTerms)를 검증한다.
   */
  it("finds a schema-less bundled plugin by its summary via the 번들 manager page", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const search = host.querySelector<HTMLInputElement>(
      ".settings-tree-search",
    )!;
    // 「폰트」 번들(설정 폼 없음)의 요약: "테마 폰트 피커에 글꼴 공급".
    search.value = "테마 폰트 피커";
    search.dispatchEvent(new Event("input"));
    expect(treeItem(host, "manager:bundle").hidden).toBe(false);
    expect(itemHint(host, "manager:bundle").textContent).toBe(
      "테마 폰트 피커에 글꼴 공급",
    );
  });

  /** 가드(D6): 활성 테마의 크롬 토큰이 마운트 시 설정창 루트 CSS 변수로 적용된다. */
  it("applies the active theme's chrome tokens to the root", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        activeTheme: vi.fn(async () => ({
          tokens: { accent: "#123456", danger: "#654321" },
        })),
      }),
    );
    expect(host.style.getPropertyValue("--memo-accent")).toBe("#123456");
    expect(host.style.getPropertyValue("--memo-danger")).toBe("#654321");
  });

  /** 가드(D6): 테마 갱신 신호(호스트 재빌드 완료)가 오면 토큰을 다시 읽어 라이브 갱신한다. */
  it("re-applies tokens when the theme-updated signal fires", async () => {
    let accent = "#111111";
    let notify: (() => void) | null = null;
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        activeTheme: vi.fn(async () => ({
          tokens: { accent },
        })),
        onThemeUpdated: (handler: () => void) => {
          notify = handler;
        },
      }),
    );
    expect(host.style.getPropertyValue("--memo-accent")).toBe("#111111");

    accent = "#222222"; // 테마 전환 후 호스트가 재빌드를 마쳤다고 흉내낸다.
    notify!();
    await flush();
    expect(host.style.getPropertyValue("--memo-accent")).toBe("#222222");
  });

  /** 가드: 호스트 재빌드 신호가 오면 pluginFailures를 다시 읽어 번들·커뮤니티 목록의 ⚠ 오류
   * 배지를 최신화한다 — listPlugins를 다시 부르지 않고도(캐시된 installedList로) 반영된다. */
  it("refreshes failure badges on the theme-updated signal without refetching listPlugins", async () => {
    let failed = false;
    let notify: (() => void) | null = null;
    const listPlugins = vi.fn(async () => [
      plugin({ id: "fresh", name: "프레시" }),
    ]);
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins,
        pluginFailures: vi.fn(async () =>
          failed ? [{ pluginId: "fresh", error: "죽었어요" }] : [],
        ),
        onThemeUpdated: (handler: () => void) => {
          notify = handler;
        },
      }),
    );
    const callsAfterMount = listPlugins.mock.calls.length;
    expect(host.querySelector(".plugin-list .plugin-failure-badge")).toBeNull();

    failed = true; // 플러그인을 막 켰다가 샌드박스가 터졌다고 흉내낸다.
    notify!();
    await flush();

    expect(
      host.querySelector(".plugin-list .plugin-failure-badge"),
    ).not.toBeNull();
    // 목록 자체(installedList)는 캐시를 재사용 — 재조회 없이 배지만 갱신됐다.
    expect(listPlugins.mock.calls.length).toBe(callsAfterMount);
  });

  /** 가드: 호스트 부재(activeTheme null)에서도 설정창은 정상 마운트되고, 색 편집기가 테마
   * 기본 팔레트로 미리보기·크롬을 칠한다(스냅샷이 늦어도 색 미리보기가 비지 않는다). */
  it("mounts fine without a theme snapshot", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps({ activeTheme: vi.fn(async () => null) }));
    expect(host.style.getPropertyValue("--memo-accent")).toBe("#37506a");
    expect(host.querySelector(".settings-theme")).not.toBeNull();
  });
});

describe("mountSettings — 글꼴 편집기(「폰트」 능력)", () => {
  const fontDesc = {
    families: [
      { label: "세리프", stack: "Georgia, serif" },
      { label: "모노", stack: "ui-monospace, monospace" },
    ],
  };

  /** 테마 탭 글꼴 목록의 행들(시스템 기본 + 각 패밀리)을 이름·요소·선택여부로 뽑는다. */
  const fontRows = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>(".settings-font-row")].map(
      (row) => ({
        row,
        name: row.querySelector(".settings-font-rowname")!.textContent,
        selected: row.classList.contains("is-selected"),
      }),
    );

  /** 가드: 능력이 켜져 있으면 글꼴 목록이 시스템 기본 + 각 폰트를 자기 서체로 렌더한다. */
  it("renders a font list, each row in its own typeface", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => fontDesc) }),
    );
    expect(host.querySelector(".settings-font-editor")).not.toBeNull();
    const rows = fontRows(host);
    expect(rows.map((r) => r.name)).toEqual(["시스템 기본", "세리프", "모노"]);
    // 각 폰트 행은 자기 CSS 스택으로 렌더된다(미리보기 = 이름 자체).
    const serif = rows.find((r) => r.name === "세리프")!;
    expect(
      serif.row.querySelector<HTMLElement>(".settings-font-rowname")!.style
        .fontFamily,
    ).toContain("Georgia");
    // 저장값이 없으면 "시스템 기본" 행이 선택 상태.
    expect(rows.find((r) => r.name === "시스템 기본")!.selected).toBe(true);
  });

  /** 가드: 능력이 꺼져 있으면(activeFont null) 목록은 숨기되 크기 컨트롤은 남는다(시스템 기본 고정). */
  it("hides the font list but keeps the size control when off", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps({ activeFont: vi.fn(async () => null) }));
    expect(host.querySelector(".settings-font-editor")).not.toBeNull();
    expect(host.querySelector(".settings-font-list")).toBeNull();
    expect(host.querySelector("#settings-font")).not.toBeNull(); // 글자 크기 셀렉트는 유지
  });

  /**
   * 가드(핵심): 저장 px가 후보 %(120%→17px)면 크기 셀렉트가 정확히 그 %를 선택해 보인다
   * (120%가 121%로 미끄러지던 회귀 방지). 첫 후보(80%)가 아닌 가운데 후보를 써, 선택 로직이
   * 깨져 첫 옵션으로 기본값이 잡히는 경우도 잡아낸다. 후보 밖 %(121% 등)는 옵션에 안 낀다.
   */
  it("shows the exact saved option % in the size select (120% stays 120%)", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_size: globalFontPctToPx(120) }, // 17px
        }),
      }),
    );
    const select = host.querySelector<HTMLSelectElement>("#settings-font")!;
    expect(select.value).toBe("120");
    // 옵션 라벨은 후보 %와 정확히 일치한다(주입된 121% 같은 것이 없다).
    expect([...select.options].map((o) => o.textContent)).toEqual(
      FONT_PCT_OPTIONS.map((p) => `${p}%`),
    );
  });

  /** 가드: 저장된 font_family가 목록에 있으면 그 행이 선택된다. */
  it("preselects the saved font family row", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "ui-monospace, monospace" },
        }),
        activeFont: vi.fn(async () => fontDesc),
      }),
    );
    const selected = fontRows(host).filter((r) => r.selected);
    expect(selected.map((r) => r.name)).toEqual(["모노"]);
  });

  /** 가드: 폰트 행을 누르면 그 CSS 스택이 defaults.font_family로 저장된다. */
  it("persists the chosen font stack on row click", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ saveSettings, activeFont: vi.fn(async () => fontDesc) }),
    );
    fontRows(host)
      .find((r) => r.name === "세리프")!
      .row.dispatchEvent(new MouseEvent("click"));
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d",
      defaults: { font_family: "Georgia, serif" },
    });
  });

  /** 가드: "시스템 기본" 행을 누르면 font_family가 null로 저장된다(시스템 폰트로 되돌림). */
  it("persists null when choosing the system default row", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        saveSettings,
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "Georgia, serif" },
        }),
        activeFont: vi.fn(async () => fontDesc),
      }),
    );
    fontRows(host)
      .find((r) => r.name === "시스템 기본")!
      .row.dispatchEvent(new MouseEvent("click"));
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d",
      defaults: { font_family: null },
    });
  });

  /** 가드: 저장값이 현재 목록 밖이면 "사용자 지정" 행으로 보존해 선택 상태를 잃지 않는다. */
  it("preserves an out-of-list saved font as a 사용자 지정 row", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "Comic Sans MS, cursive" },
        }),
        activeFont: vi.fn(async () => fontDesc),
      }),
    );
    const rows = fontRows(host);
    expect(rows.map((r) => r.name)).toContain("사용자 지정");
    expect(rows.find((r) => r.name === "사용자 지정")!.selected).toBe(true);
  });

  /** 설치 글꼴이 섞인 디스크립터 — 구역 나누기·검색 가드가 함께 쓴다. */
  const withSystemFonts = {
    families: [
      ...fontDesc.families,
      {
        label: "NanumGothic",
        stack: '"NanumGothic", sans-serif',
        system: true,
        korean: true,
        alias: "나눔고딕",
      },
      {
        label: "Helvetica",
        stack: '"Helvetica", sans-serif',
        system: true,
        korean: false,
      },
    ],
  };

  /** 목록의 구역 머리글(이름·개수·숨김여부)을 뽑는다. */
  const groupHeads = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>(".settings-font-grouphead")].map(
      (head) => ({
        head,
        name: head.firstElementChild!.textContent,
        count: head.querySelector(".settings-font-groupcount")!.textContent,
      }),
    );

  /** 가드: 설치 글꼴이 붙으면 「기본」·「한글」·「설치된 글꼴」 구역으로 나뉘고 개수를 단다. */
  it("splits the list into groups when system fonts are present", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => withSystemFonts) }),
    );
    expect(groupHeads(host).map((g) => [g.name, g.count])).toEqual([
      ["기본", "3"], // 시스템 기본 + 세리프 + 모노
      ["한글", "1"],
      ["설치된 글꼴", "1"],
    ]);
    // 한글 글꼴이 라틴 전용보다 위에 온다(한글 메모에 쓸 수 있는 것부터).
    expect(fontRows(host).map((r) => r.name)).toEqual([
      "시스템 기본",
      "세리프",
      "모노",
      "NanumGothic",
      "Helvetica",
    ]);
  });

  /** 가드: 설치 글꼴이 없으면(구역 하나) 머리글을 그리지 않는다 — 지금까지와 같은 목록. */
  it("draws no group headings when there is only one group", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => fontDesc) }),
    );
    expect(groupHeads(host)).toEqual([]);
  });

  /** 가드: 검색으로 한 구역의 행이 전부 숨으면 그 머리글도 함께 숨는다(빈 머리글 방지). */
  it("hides a group heading when its rows are all filtered out", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => withSystemFonts) }),
    );
    const search = host.querySelector<HTMLInputElement>(
      ".settings-font-search",
    )!;
    search.value = "NanumGothic";
    search.dispatchEvent(new Event("input"));
    // 개수는 "지금 보이는 수"로 따라간다 — 걸러 놓고 전체 수를 달면 숫자가 거짓말을 한다.
    expect(
      groupHeads(host).map((g) => [g.name, g.head.hidden, g.count]),
    ).toEqual([
      ["기본", true, "0"],
      ["한글", false, "1"],
      ["설치된 글꼴", true, "0"],
    ]);
  });

  /**
   * 가드: 지역화 이름으로도 검색된다 — 스택에 넣는 정규 이름은 영문("NanumGothic")이라,
   * 한글로 친 사용자가 아무것도 못 찾던 자리다.
   */
  it("matches a font by its localized name in search", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => withSystemFonts) }),
    );
    const search = host.querySelector<HTMLInputElement>(
      ".settings-font-search",
    )!;
    search.value = "나눔";
    search.dispatchEvent(new Event("input"));
    expect(
      fontRows(host)
        .filter((r) => !r.row.hidden)
        .map((r) => r.name),
    ).toEqual(["NanumGothic"]);
  });

  /**
   * 가드: 목록이 길면 지금 고른 글꼴이 맨 위 「지금 글꼴」로 올라온다 — 300행 밑에 묻히지
   * 않게. 원래 구역에서는 빠지므로(복제 아님) 체크된 행은 하나뿐이다.
   */
  it("hoists the selected font to the top of a long list", async () => {
    const manyFonts = {
      families: [
        ...withSystemFonts.families,
        ...Array.from({ length: 8 }, (_, i) => ({
          label: `Latin ${i}`,
          stack: `"Latin ${i}", sans-serif`,
          system: true,
          korean: false,
        })),
      ],
    };
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: '"Latin 5", sans-serif' },
        }),
        activeFont: vi.fn(async () => manyFonts),
      }),
    );
    expect(groupHeads(host)[0]).toMatchObject({
      name: "지금 글꼴",
      count: "1",
    });
    const names = fontRows(host).map((r) => r.name);
    expect(names[0]).toBe("Latin 5");
    // 원래 구역에서는 빠졌다 — 목록 전체에 딱 한 번만 나온다.
    expect(names.filter((n) => n === "Latin 5")).toHaveLength(1);
    expect(
      fontRows(host)
        .filter((r) => r.selected)
        .map((r) => r.name),
    ).toEqual(["Latin 5"]);
  });

  /** 가드: 짧은 목록은 끌어올리지 않는다 — 한눈에 다 보이는데 머리글만 늘어난다. */
  it("does not hoist in a short list", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => withSystemFonts) }),
    );
    expect(groupHeads(host)[0].name).toBe("기본");
  });

  /** 가드: 목록 밖 저장값의 "사용자 지정" 행은 설치 글꼴이 섞여도 첫 구역(「기본」)에 남는다. */
  it("keeps the 사용자 지정 row in the first group", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "Comic Sans MS, cursive" },
        }),
        activeFont: vi.fn(async () => withSystemFonts),
      }),
    );
    expect(groupHeads(host)[0].count).toBe("4"); // 시스템 기본 + 세리프 + 모노 + 사용자 지정
    expect(fontRows(host)[3].name).toBe("사용자 지정");
  });

  /** 가드: 능력이 켜져 있으면 고른 폰트가 설정 창 자체(host)에도 적용된다(테마 색과 같은 결). */
  it("applies the saved font to the settings window when active", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "Georgia, serif" },
        }),
        activeFont: vi.fn(async () => fontDesc),
      }),
    );
    expect(host.style.fontFamily).toBe("Georgia, serif");
  });

  /** 가드: 능력이 꺼져 있으면 설정 창 폰트는 시스템 기본(빈 값)으로 둔다(노트창 "끄면 시스템"과 일치). */
  it("leaves the settings window font at system default when off", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d",
          defaults: { font_family: "Georgia, serif" },
        }),
        activeFont: vi.fn(async () => null),
      }),
    );
    expect(host.style.fontFamily).toBe("");
  });

  /** 가드: 행을 누르면 설정 창 폰트가 즉시 그 폰트로 라이브 반영된다(호스트 재빌드 대기 없음). */
  it("applies the chosen font to the settings window live on click", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ activeFont: vi.fn(async () => fontDesc) }),
    );
    expect(host.style.fontFamily).toBe(""); // 초기: 저장값 없음 → 시스템 기본
    fontRows(host)
      .find((r) => r.name === "모노")!
      .row.dispatchEvent(new MouseEvent("click"));
    expect(host.style.fontFamily).toBe("ui-monospace, monospace");
  });
});

describe("mountSettings — 테마 색 편집기", () => {
  /** 가드: 토큰마다 색 피커 행이 그려진다(의미색 3 + 표면 라이트 4 + 표면 다크 4 +
   * 패널 4 = 15). */
  it("renders a color row with a color input per theme token", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const rows = host.querySelectorAll(".settings-color-row");
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(
        row.querySelector<HTMLInputElement>(".settings-color-swatch")!.type,
      ).toBe("color");
    }
  });

  /** 가드: 노트 목록·검색 창 그룹이 자기 4개 토큰(배경·글자 × 라이트·다크)을 그린다 —
   * 이 행들이 없으면 패널 색을 설정 창에서 손댈 방법 자체가 없다. */
  it("renders the note list panel group with its four tokens", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const groups = [...host.querySelectorAll(".settings-color-group")].map(
      (el) => el.textContent,
    );
    expect(groups).toContain("노트 목록·검색 창");
    const keys = [...host.querySelectorAll(".settings-color-key")].map(
      (el) => el.textContent,
    );
    expect(keys.slice(-4)).toEqual([
      "panel",
      "panel-dark",
      "panel-text",
      "panel-text-dark",
    ]);
  });

  /** 가드: 패널 토큰 편집이 표면 토큰과 **같은 변수 규칙**(라이트=`-light` 소스, 다크=`-dark`)
   * 으로 라이브 반영·저장된다 — `panel-text-dark`처럼 `-`가 둘인 키에서 규칙이 어긋나기 쉽다. */
  it("previews and persists panel token edits on the right CSS vars", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));
    const rows = [...host.querySelectorAll(".settings-color-row")];
    const swatchOf = (key: string): HTMLInputElement =>
      rows
        .find(
          (r) => r.querySelector(".settings-color-key")!.textContent === key,
        )!
        .querySelector<HTMLInputElement>(".settings-color-swatch")!;

    const light = swatchOf("panel");
    light.value = "#123456";
    light.dispatchEvent(new Event("input"));
    expect(host.style.getPropertyValue("--memo-panel-light")).toBe("#123456");

    const dark = swatchOf("panel-text-dark");
    dark.value = "#654321";
    dark.dispatchEvent(new Event("change"));
    expect(host.style.getPropertyValue("--memo-panel-text-dark")).toBe(
      "#654321",
    );
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d<custom>",
      defaults: {},
      theme_overrides: {
        "sj_d<custom>": { panel: "#123456", "panel-text-dark": "#654321" },
      },
    });
  });

  /** 가드(핵심): 드래그(input)는 라이브 반영만, 놓을 때(change)만 오버라이드를 확정 저장한다. */
  it("applies live on input but persists only on commit", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));
    const swatch = host.querySelector<HTMLInputElement>(
      ".settings-color-swatch",
    )!; // 첫 행 = 강조색(accent)
    swatch.value = "#aabbcc";
    swatch.dispatchEvent(new Event("input"));
    expect(host.style.getPropertyValue("--memo-accent")).toBe("#aabbcc");
    expect(saveSettings).not.toHaveBeenCalled();

    swatch.dispatchEvent(new Event("change"));
    // 색을 편집하면 자동으로 {테마}<custom> 파생 변형으로 전환·저장된다.
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d<custom>",
      defaults: {},
      theme_overrides: { "sj_d<custom>": { accent: "#aabbcc" } },
    });
  });

  /** 가드: 리셋은 오버라이드가 있을 때만 보이고, 누르면 그 토큰 오버라이드를 지운다. */
  it("shows reset only when overridden and clears it on click", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));
    const row = host.querySelector(".settings-color-row")!;
    const swatch = row.querySelector<HTMLInputElement>(
      ".settings-color-swatch",
    )!;
    const reset = row.querySelector<HTMLButtonElement>(
      ".settings-color-reset",
    )!;
    expect(reset.hidden).toBe(true);

    swatch.value = "#010203";
    swatch.dispatchEvent(new Event("change"));
    expect(reset.hidden).toBe(false);

    saveSettings.mockClear();
    reset.click();
    expect(reset.hidden).toBe(true);
    // 마지막 오버라이드가 지워지면 베이스 테마로 복귀하고 파생 변형 항목이 사라진다.
    expect(saveSettings).toHaveBeenCalledWith({
      schema_version: 1,
      theme: "sj_d",
      defaults: {},
      theme_overrides: {},
    });
  });

  /** 가드: 마운트 시 기존 오버라이드로 스와치·리셋·크롬(--memo-*)이 채워진다(테마별). */
  it("pre-fills from existing overrides and paints chrome on mount", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getSettings: async () => ({
          schema_version: 1,
          theme: "sj_d<custom>",
          defaults: {},
          theme_overrides: { "sj_d<custom>": { danger: "#00ff00" } },
        }),
        activeTheme: vi.fn(async () => ({
          tokens: { accent: "#37506a", danger: "#c0392b" },
        })),
      }),
    );
    const rows = host.querySelectorAll(".settings-color-row");
    const dangerSwatch = rows[1].querySelector<HTMLInputElement>(
      ".settings-color-swatch",
    )!;
    const dangerReset = rows[1].querySelector<HTMLButtonElement>(
      ".settings-color-reset",
    )!;
    expect(dangerSwatch.value).toBe("#00ff00");
    expect(dangerReset.hidden).toBe(false);
    // 강조색은 오버라이드 없음 → 테마 baseline, 리셋 숨김.
    expect(
      rows[0].querySelector<HTMLButtonElement>(".settings-color-reset")!.hidden,
    ).toBe(true);
    // 크롬에도 반영: --memo-danger = 오버라이드 값.
    expect(host.style.getPropertyValue("--memo-danger")).toBe("#00ff00");
  });
});

describe("mountSettings — 마스터↔디테일 내비게이션 (D2·D4)", () => {
  /** 가드: 이름 클릭 → 상세 뷰(마스터 숨김), ← 목록 → 마스터 복귀(상세 숨김). */
  it("navigates into the detail view and back", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ listPlugins: async () => [plugin({ id: "x", name: "엑스" })] }),
    );
    // 설치형은 「커뮤니티 플러그인」 탭의 마스터-디테일에서 열린다.
    const community = host.querySelector<HTMLElement>(
      "#settings-page-community",
    )!;
    const master = community.querySelector<HTMLElement>(".plugin-master")!;
    const detail = community.querySelector<HTMLElement>(".plugin-detail-view")!;
    expect(detail.hidden).toBe(true);

    openInstalledDetail(host, "엑스");
    await flush();
    expect(master.hidden).toBe(true);
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector(".plugin-detail-name")!.textContent).toBe(
      "엑스",
    );

    detail.querySelector<HTMLButtonElement>(".plugin-detail-back")!.click();
    expect(master.hidden).toBe(false);
    expect(detail.hidden).toBe(true);
  });

  /** 가드: 설치형 상세도 매니페스트 `summary`를 부제로 잇는다(목록 행과 같은 값). */
  it("carries the manifest summary into the installed detail view", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({ id: "x", name: "엑스", summary: "한 줄 요약" }),
        ],
      }),
    );
    openInstalledDetail(host, "엑스");
    await flush();
    expect(host.querySelector(".plugin-detail-summary")!.textContent).toBe(
      "한 줄 요약",
    );
  });

  /**
   * 가드(오배달): A 상세의 진단 응답이 늦게 도착해도 그 사이 열린 B 상세에 꽂히지 않는다.
   *
   * 왜: 진단은 「이 플러그인이 왜 안 되는지」를 보는 유일한 창구라, 남의 기록이 꽂히면
   * 그대로 오진이 된다. `detail.hidden`만 보면(예전 판정) B가 열려 있는 동안 detail은
   * 계속 보이므로 A의 응답이 B 화면을 갈아 끼운다.
   */
  it("drops a late diagnostics response when another detail has been opened", async () => {
    const resolvers: ((v: PluginDiagnostic[]) => void)[] = [];
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({ id: "a", name: "에이" }),
          plugin({ id: "b", name: "비" }),
        ],
        pluginDiagnostics: vi.fn(
          () =>
            new Promise<PluginDiagnostic[]>((resolve) =>
              resolvers.push(resolve),
            ),
        ),
      }),
    );
    const community = host.querySelector<HTMLElement>(
      "#settings-page-community",
    )!;
    const detail = community.querySelector<HTMLElement>(".plugin-detail-view")!;

    openInstalledDetail(host, "에이"); // A 상세 — 진단 요청 in-flight
    await flush();
    detail.querySelector<HTMLButtonElement>(".plugin-detail-back")!.click();
    openInstalledDetail(host, "비"); // B 상세 — 두 번째 요청 in-flight
    await flush();

    // 이제 A의 응답이 뒤늦게 도착한다.
    resolvers[0]([
      {
        pluginId: "a",
        at: 1,
        kind: "call-reject",
        call: "ui.toast",
        message: "A의 오류",
      },
    ]);
    await flush();

    expect(detail.querySelector(".plugin-detail-name")!.textContent).toBe("비");
    expect(detail.textContent).not.toContain("A의 오류");
    expect(
      detail.querySelector<HTMLElement>(".plugin-detail-section--diagnostics")!
        .hidden,
    ).toBe(true);
  });

  /** 가드(3탭): 번들 플러그인 이름을 누르면 「번들」 탭의 상세가 열린다(커뮤니티 상세는 불변). */
  it("opens bundle plugin detail in the bundle panel, not community", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const bundle = host.querySelector<HTMLElement>("#settings-page-bundle")!;
    const community = host.querySelector<HTMLElement>(
      "#settings-page-community",
    )!;
    bundle
      .querySelector<HTMLButtonElement>(".plugin-master .plugin-name")!
      .click();
    expect(
      bundle.querySelector<HTMLElement>(".plugin-detail-view")!.hidden,
    ).toBe(false);
    // 다른 탭(커뮤니티)의 상세는 영향받지 않는다.
    expect(
      community.querySelector<HTMLElement>(".plugin-detail-view")!.hidden,
    ).toBe(true);
  });

  /** 가드(D4): 설치형 상세를 열면 readPluginReadme(id)로 README를 읽어 렌더한다. */
  it("loads installed README via IPC into the detail view", async () => {
    const readPluginReadme = vi.fn(async () => "# 사용법\n\n외부 링크 안내");
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [plugin({ id: "x", name: "엑스" })],
        readPluginReadme,
      }),
    );
    openInstalledDetail(host, "엑스");
    await flush();
    expect(readPluginReadme).toHaveBeenCalledWith("x", "ko");
    const readme = host.querySelector(".plugin-readme")!;
    expect(readme.querySelector("h1")!.textContent).toBe("사용법");
  });

  /** 가드(축 2): 활성 로케일이 README 조회에 실려 간다(README.<locale>.md 우선 조회의
   * 프론트 절반) — 이 창의 `activeLocale()` 값 그대로. */
  it("passes the active locale to readPluginReadme", async () => {
    registerLocale("xx", "XX", {}); // setActiveLocale은 등록된 코드만 반영한다.
    const readPluginReadme = vi.fn(async () => "# usage");
    const host = document.createElement("div");
    try {
      await mountSettings(
        host,
        deps({
          getSettings: async () => ({ ...settings, language: "xx" }),
          listPlugins: async () => [plugin({ id: "x", name: "엑스" })],
          readPluginReadme,
        }),
      );
      openInstalledDetail(host, "엑스");
      await flush();
    } finally {
      setActiveLocale("ko");
    }
    expect(readPluginReadme).toHaveBeenCalledWith("x", "xx");
  });

  /** 가드(D4): README가 null이면 "설명 없음"을 보인다. */
  it("shows the empty note when README is null", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [plugin({ id: "x", name: "엑스" })],
        readPluginReadme: vi.fn(async () => null),
      }),
    );
    openInstalledDetail(host, "엑스");
    await flush();
    expect(host.querySelector(".plugin-readme")!.textContent).toContain(
      "설명 없음",
    );
  });

  /** 가드(D4): README의 https 링크 클릭이 openExternal로 위임된다(웹뷰 탐색 금지). */
  it("delegates README links to openExternal", async () => {
    const openExternal = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [plugin({ id: "x", name: "엑스" })],
        readPluginReadme: vi.fn(async () => "[문서](https://example.com/d)"),
        openExternal,
      }),
    );
    openInstalledDetail(host, "엑스");
    await flush();
    const link = host.querySelector<HTMLAnchorElement>(".plugin-readme-link")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/d");
  });

  /** 가드(D3): 상세에서 제거하면 removePlugin 후 마스터로 돌아간다. */
  it("removes from the detail view and returns to the master list", async () => {
    const removePlugin = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({ id: "x", name: "엑스", source: { type: "local" } }),
        ],
        removePlugin,
      }),
    );
    openInstalledDetail(host, "엑스");
    await flush();
    host
      .querySelector<HTMLButtonElement>(".plugin-detail-view .plugin-remove")!
      .click();
    await flush();
    expect(removePlugin).toHaveBeenCalledWith("x");
    expect(host.querySelector<HTMLElement>(".plugin-master")!.hidden).toBe(
      false,
    );
    expect(host.querySelector<HTMLElement>(".plugin-detail-view")!.hidden).toBe(
      true,
    );
  });

  /** 가드(D3 잠금 통합): 설치형 테마도 마스터 목록에서 토글 없이 잠금 표시된다 —
   * 어떤 경로로도 setPluginEnabled가 불리지 않는다. */
  it("locks installed theme plugins in the list (no enable command path)", async () => {
    const setEnabled = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listPlugins: async () => [
          plugin({ id: "th", name: "내테마", permissions: ["theme"] }),
        ],
        setEnabled,
      }),
    );
    const installedList = host.querySelectorAll(".plugin-list")[1];
    expect(
      installedList.querySelector(".plugin-required-badge"),
    ).not.toBeNull();
    expect(installedList.querySelector(".plugin-enable-toggle")).toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

/**
 * 언어팩 플러그인의 상태 변경만 설정 창을 리로드한다.
 *
 * 언어 드롭다운 후보(`availableLocales()`)는 마운트 첫머리의 카탈로그 스캔 한 번으로 굳는다 —
 * 창을 띄워 둔 채 언어팩을 설치·토글·제거하면 목록만 다시 그려서는 반영되지 않는다
 * (`settings.ts`의 `reloadForLanguagePack` 주석). 그 수습으로 재빌드마다의 재스캔이 아니라
 * 리로드를 골랐으므로, **대상이 언어팩일 때만** 도는 것까지가 계약이다: 일반 플러그인 토글이
 * 리로드를 타면 스크롤·탐색 상태를 매번 잃는다. 두 방향을 모두 고정한다.
 *
 * `window.location` 목킹은 언어 피커 가드("saves the language and reloads this window only
 * after the save resolves")와 같은 패턴이다.
 */
describe("mountSettings — 언어팩 상태 변경만 이 창을 리로드한다", () => {
  /** window.location.reload를 스파이로 갈아 끼우고 본문 실행 후 반드시 원복한다. */
  const withReloadSpy = async (
    body: (reload: () => void) => Promise<void>,
  ): Promise<void> => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    try {
      await body(reload);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  };

  /** 언어팩 픽스처 — 판정 근거는 매니페스트 `contributes.translations`가 비지 않았다는 것뿐이다. */
  const languagePack = (over: Partial<InstalledPlugin> = {}): InstalledPlugin =>
    plugin({
      id: "lp",
      name: "언어팩",
      permissions: ["i18n"],
      kind: "capability",
      contributes: {
        translations: [{ locale: "xx", label: "XX", entries: { a: "b" } }],
      },
      source: { type: "local" },
      ...over,
    });

  /** 커뮤니티(설치) 목록의 첫 활성 토글을 켠다. */
  const toggleFirstInstalled = (host: HTMLElement): void => {
    const toggle = host.querySelector<HTMLInputElement>(
      "#settings-page-community .plugin-enable-toggle",
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
  };

  it("reloads this window after a language pack is enabled", async () => {
    await withReloadSpy(async (reload) => {
      const host = document.createElement("div");
      await mountSettings(
        host,
        deps({ listPlugins: async () => [languagePack()] }),
      );
      toggleFirstInstalled(host);
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it("does not reload when a plain plugin is enabled", async () => {
    await withReloadSpy(async (reload) => {
      const host = document.createElement("div");
      await mountSettings(
        host,
        deps({
          // contributes 자체가 없는 평범한 설치 플러그인 — 여기서 리로드가 돌면 언어와
          // 무관한 모든 토글이 창 상태를 날린다.
          listPlugins: async () => [plugin({ id: "plain", name: "보통" })],
        }),
      );
      toggleFirstInstalled(host);
      await flush();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  /** 가드: `contributes`는 있는데 `translations`가 빈 배열이면 언어팩이 아니다(공급하는
   * 로케일이 없으므로 드롭다운도 그대로다). */
  it("does not reload for a plugin whose translations list is empty", async () => {
    await withReloadSpy(async (reload) => {
      const host = document.createElement("div");
      await mountSettings(
        host,
        deps({
          listPlugins: async () => [
            languagePack({ id: "empty", contributes: { translations: [] } }),
          ],
        }),
      );
      toggleFirstInstalled(host);
      await flush();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  it("reloads this window after a language pack is removed", async () => {
    await withReloadSpy(async (reload) => {
      const host = document.createElement("div");
      await mountSettings(
        host,
        deps({ listPlugins: async () => [languagePack()] }),
      );
      openInstalledDetail(host, "언어팩");
      await flush();
      host
        .querySelector<HTMLButtonElement>(".plugin-detail-view .plugin-remove")!
        .click();
      await flush();
      // 제거 뒤 목록에는 없다 — 판정이 제거 **전에** 일어나야만 이 기대가 선다.
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it("reloads this window after a language pack is installed", async () => {
    await withReloadSpy(async (reload) => {
      // 설치 전엔 목록이 비어 있고, confirmInstall이 끝난 뒤의 refresh부터 들어온다 —
      // 판정이 refresh **뒤에** 일어나야만 매니페스트를 볼 수 있다.
      let installed: InstalledPlugin[] = [];
      const host = document.createElement("div");
      await mountSettings(
        host,
        deps({
          listPlugins: async () => installed,
          confirmInstall: vi.fn(async () => {
            installed = [languagePack()];
            return "lp";
          }),
        }),
      );
      host.querySelector<HTMLButtonElement>(".plugin-install-btn")!.click();
      await flush();
      host.querySelector<HTMLButtonElement>(".plugin-approve-ok")!.click();
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});

describe("단축키 탭", () => {
  /** label 텍스트로 단축키 행의 녹화 버튼을 찾는다. */
  const recordFor = (host: HTMLElement, label: string): HTMLButtonElement => {
    const row = [...host.querySelectorAll<HTMLElement>(".shortcut-row")].find(
      (r) => r.querySelector(".shortcut-label")?.textContent === label,
    );
    return row!.querySelector<HTMLButtonElement>(".shortcut-record")!;
  };

  /** 가드: 단축키 페이지가 안정 id로 렌더되고, 기본 바인딩(확대=Alt+=)이 보인다(non-mac 라벨). */
  it("renders the shortcuts page with default zoom binding", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const page = host.querySelector<HTMLElement>("#settings-page-shortcuts");
    expect(page).not.toBeNull();
    expect(recordFor(host, "글자 확대").textContent).toBe("Alt+=");
  });

  /** 가드: 핵심 동작을 녹화하면 공유 설정 keybindings에 창 단위 accel로 저장된다(Mod=Ctrl, non-mac). */
  it("records a core action and persists it to keybindings", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));

    const rec = recordFor(host, "마크다운 프리뷰");
    rec.click(); // 녹화 시작
    rec.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyE",
        ctrlKey: true,
        bubbles: true,
      }),
    );

    expect(saveSettings).toHaveBeenCalled();
    const calls = saveSettings.mock.calls as unknown as Array<
      [{ keybindings: Record<string, string> }]
    >;
    const saved = calls[calls.length - 1][0];
    expect(saved.keybindings["toggle-preview"]).toBe("Mod+KeyE");
  });

  /** 가드: 수식키 없는 키는 무효 — 녹화 대기 상태를 유지하고 저장하지 않는다. */
  it("ignores a modifier-less key while recording", async () => {
    const saveSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ saveSettings }));

    const rec = recordFor(host, "삭제");
    rec.click();
    rec.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  /** 가드: 전역 섹션은 dep이 있을 때만 뜨고, 녹화하면 Tauri accel로 setGlobalHotkey를 부른다. */
  it("sets the global hotkey via its dep", async () => {
    const setGlobalHotkey = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getGlobalHotkey: async () => "Super+Shift+KeyN",
        setGlobalHotkey,
      }),
    );

    const rec = recordFor(host, "새 노트");
    rec.click();
    rec.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyM",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(setGlobalHotkey).toHaveBeenCalledWith("Super+Shift+KeyM");
  });

  /** 가드: 전역 dep이 없으면 전역 섹션(새 노트 행)을 숨긴다. */
  it("hides the global section without the dep", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    const labels = [
      ...host.querySelectorAll<HTMLElement>(
        "#settings-page-shortcuts .shortcut-label",
      ),
    ].map((s) => s.textContent);
    expect(labels).not.toContain("새 노트");
  });
});

describe("mountSettings — 「시작」(활성 노트 0개 시작 동작, D3)", () => {
  const startupTreeItem = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('.settings-tree-item[data-node="startup"]');
  const startupSelect = (host: HTMLElement): HTMLSelectElement | null =>
    host.querySelector<HTMLSelectElement>(
      "#settings-page-startup .settings-startup-no-active-action",
    );

  /** 가드: dep이 둘 다 없으면 트리 노드 자체가 없다("IO 없으면 UI 없음" 관례). */
  it("omits the tree node and panel when both deps are missing", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    expect(startupTreeItem(host)).toBeNull();
    expect(host.querySelector("#settings-page-startup")).toBeNull();
  });

  /** 가드: 조회 dep만 있고 저장 dep이 없으면(반쪽 배선) 여전히 노드를 숨긴다. */
  it("omits the node when only the getter dep is wired", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ getStartupNoActiveAction: async () => "panel" }),
    );
    expect(startupTreeItem(host)).toBeNull();
  });

  /** 가드: 두 dep이 다 있으면 노드가 뜨고, 드롭다운 초기값이 조회한 값을 반영한다. 노드
   * 라벨은 카테고리명("시작")과 달라야 한다(리뷰 m11 — 같으면 트리에 "시작 › 시작"처럼
   * 헤더 안에 이름이 같은 항목 하나만 있는 중복 계층으로 보인다). */
  it("renders the tree node and reflects the initial value", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getStartupNoActiveAction: async () => "new-note",
        setStartupNoActiveAction: vi.fn(async () => {}),
      }),
    );
    expect(startupTreeItem(host)?.textContent).not.toBe("시작");
    startupTreeItem(host)!.click();
    expect(
      host.querySelector<HTMLElement>("#settings-page-startup")!.hidden,
    ).toBe(false);
    expect(startupSelect(host)!.value).toBe("new-note");
  });

  /** 가드: 유효한 값을 고르면 그 값 그대로 setStartupNoActiveAction을 부른다(라벨이 아니라
   * value가 저장된다). */
  it("saves the picked value via setStartupNoActiveAction", async () => {
    const setStartupNoActiveAction = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getStartupNoActiveAction: async () => "panel",
        setStartupNoActiveAction,
      }),
    );
    const select = startupSelect(host)!;
    select.value = "new-note";
    select.dispatchEvent(new Event("change"));
    expect(setStartupNoActiveAction).toHaveBeenCalledWith("new-note");
  });

  /**
   * 가드: 알 수 없는 저장값(구버전/오염된 config.json)이 조회되면, 어느 `<option>`도
   * `selected`를 받지 못한다 — 그 경우 HTML 명세대로 브라우저가 **첫 옵션**을 자동
   * 선택한다(jsdom도 이 동작을 그대로 구현한다). 그래서 화면엔 "메모 목록 띄우기"로 보이지만
   * 그 값을 실제로 저장하기 전까지 백엔드 저장값은 여전히 손상된 문자열 그대로다 — "표시값과
   * 저장값이 다를 수 있다"는 사실을 여기서 고정한다(이전 doc-comment는 "아무 옵션도 선택되지
   * 않는다"고 잘못 서술했었다 — 리뷰 m9/m20).
   */
  it("falls back to the browser's first-option default when the stored value is unknown", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getStartupNoActiveAction: async () => "some-corrupted-value",
        setStartupNoActiveAction: vi.fn(async () => {}),
      }),
    );
    const select = startupSelect(host)!;
    expect([...select.options].every((o) => !o.selected)).toBe(false);
    expect(select.value).toBe("panel"); // STARTUP_NO_ACTIVE_OPTIONS의 첫 값.
  });

  /** 가드: 저장이 reject되면(어휘 거부 등) 이전 값으로 되돌리고 실패 문구를 danger 톤
   * (`.shortcut-warn`, 전역 단축키 등록 실패와 같은 클래스) + `role="alert"`로 보인다(리뷰
   * m10 — 중립 상태줄로 보이면 실패로 안 읽히고 스크린 리더에도 안 알려진다). */
  it("reverts the selection and shows an alert when saving rejects", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        getStartupNoActiveAction: async () => "panel",
        setStartupNoActiveAction: vi.fn(async () => {
          throw new Error("bad vocabulary");
        }),
      }),
    );
    const select = startupSelect(host)!;
    select.value = "new-note";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(startupSelect(host)!.value).toBe("panel");
    const err = host.querySelector<HTMLElement>(
      "#settings-page-startup .shortcut-warn",
    );
    expect(err?.textContent).toBeTruthy();
    expect(err?.getAttribute("role")).toBe("alert");
  });
});

describe("mountSettings — 「도움말」(시작 가이드 다시 보기)", () => {
  const helpTreeItem = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('.settings-tree-item[data-node="help"]');
  const openButton = (host: HTMLElement): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(
      "#settings-page-help .plugin-action-button",
    );
  const statusText = (host: HTMLElement): string =>
    host.querySelector<HTMLElement>("#settings-page-help .reset-status")
      ?.textContent ?? "";

  /** 가드: dep이 없으면 노드도 페이지도 없다("IO 없으면 UI 없음" — 「시작」과 같은 관례). */
  it("omits the tree node and panel without the dep", async () => {
    const host = document.createElement("div");
    await mountSettings(host, deps());
    expect(helpTreeItem(host)).toBeNull();
    expect(host.querySelector("#settings-page-help")).toBeNull();
  });

  /** 가드: dep이 있으면 노드가 뜨고, 버튼이 그 dep을 부른다(가이드를 다시 여는 유일한 경로). */
  it("renders the node and opens the guide through the dep", async () => {
    const openGuideNote = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountSettings(host, deps({ openGuideNote }));
    // 노드 라벨은 카테고리명("도움말")과 달라야 한다(트리에 "도움말 › 도움말"이 되지 않게).
    expect(helpTreeItem(host)?.textContent).not.toBe("도움말");
    helpTreeItem(host)!.click();
    expect(host.querySelector<HTMLElement>("#settings-page-help")!.hidden).toBe(
      false,
    );

    openButton(host)!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(openGuideNote).toHaveBeenCalledTimes(1);
    expect(statusText(host)).toBe("시작 가이드를 열었어요.");
  });

  /** 가드: 여는 동안 버튼을 잠근다 — 연타하면 `force` 재생성이 여러 번 나가 가이드가
   * 여러 장 만들어진다(코어의 선점은 「다시 보기」의 force를 막지 않는다). */
  it("locks the button while opening", async () => {
    let release = (): void => {};
    const openGuideNote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const host = document.createElement("div");
    await mountSettings(host, deps({ openGuideNote }));
    openButton(host)!.click();
    expect(openButton(host)!.disabled).toBe(true);
    openButton(host)!.click(); // 잠긴 동안의 클릭은 아무 일도 하지 않는다.
    expect(openGuideNote).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(openButton(host)!.disabled).toBe(false);
  });

  /** 가드: 실패는 번역된 고정 문구로 알린다(백엔드 오류 원문을 화면에 흘리지 않는다). */
  it("reports failures with a translated message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        openGuideNote: vi.fn(async () => {
          throw new Error("VAULT_BUSY 저장소를 정리하는 중");
        }),
      }),
    );
    openButton(host)!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusText(host)).toBe(
      "시작 가이드를 열지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
    expect(statusText(host)).not.toContain("VAULT_BUSY");
    expect(openButton(host)!.disabled).toBe(false);
    spy.mockRestore();
  });
});

describe("설정 화면 CSS 가드 — 액션 버튼 다크 모드", () => {
  /**
   * 가드(회귀): `.plugin-action-button`은 다크 모드 오버라이드를 가져야 한다.
   *
   * 라이트 전용 rgba(0,0,0,…) 테두리·배경만 있으면 다크 배경에서 둘 다 사실상 사라져,
   * 누를 수 있는 컨트롤인지 알아볼 수 없다(실제 렌더에서 확인된 결함). jsdom은 CSS를
   * 계산하지 않으므로 시트 원문에서 다크 미디어 블록을 잘라 존재를 검사한다 — 설정 입력
   * (.plugin-setting-input)과 같은 오버라이드 패턴을 따르는지가 검사 대상이다.
   */
  it("overrides the action button inside a dark color-scheme media block", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const darkBlocks: string[] = [];
    const re = /@media\s*\(prefers-color-scheme:\s*dark\)/g;
    for (let m = re.exec(css); m !== null; m = re.exec(css)) {
      const open = css.indexOf("{", m.index);
      let depth = 1;
      let i = open + 1;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
        i += 1;
      }
      darkBlocks.push(css.slice(open + 1, i - 1));
    }
    expect(darkBlocks.length).toBeGreaterThan(0);
    const withButton = darkBlocks.filter((b) =>
      b.includes(".plugin-action-button"),
    );
    expect(withButton.length).toBeGreaterThan(0);
    // hover 상태도 다크 값으로 갈아입어야 한다(기본만 고치면 hover에서 라이트 값이 되살아난다).
    expect(
      withButton.some((b) =>
        b.includes(".plugin-action-button:hover:not(:disabled)"),
      ),
    ).toBe(true);
  });
});

describe("mountSettings — 메모 복구(스냅샷 복원)", () => {
  const note = (over: Partial<NoteSummary> = {}): NoteSummary => ({
    id: "n1",
    title: "노트 하나",
    hidden: false,
    created_at: 1000,
    favorite: false,
    content_updated_at: 1000,
    char_count: 0,
    opened_at: null,
    ...over,
  });
  const snap = (over: Partial<NoteSnapshot> = {}): NoteSnapshot => ({
    id: "1700000000000-aaaaaaaa",
    captured_at: 1700000000000,
    title: "지난 제목",
    preview: "지난 본문 미리보기",
    bytes: 10,
    ...over,
  });
  const panel = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>("#settings-page-recovery")!;

  /** 가드: 스냅샷 보유 노트만 목록에 뜨고, 개수 배지를 단다(스냅샷 0개 노트는 숨김). */
  it("lists only notes that own snapshots, with a count badge", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listNotes: async () => [
          note({ id: "n1", title: "가진 노트" }),
          note({ id: "n2", title: "안 가진 노트" }),
        ],
        listSnapshots: async (id: string) =>
          id === "n1" ? [snap(), snap({ id: "older-2222" })] : [],
      }),
    );
    await flush();
    const names = [
      ...panel(host).querySelectorAll<HTMLElement>(".recovery-note-title"),
    ].map((s) => s.textContent);
    expect(names).toEqual(["가진 노트"]);
    expect(
      panel(host).querySelector(".recovery-note-count")!.textContent,
    ).toContain("2");
  });

  /** 가드(복구 도달성, finding 2): 삭제된 노트(존재 목록엔 없지만 스냅샷 보유)도 목록에 뜨고
   * "삭제됨" 배지를 단다 — 삭제한 노트의 복구 스냅샷에 UI가 닿을 수 있어야 한다. */
  it("lists deleted notes that still own snapshots (reachable recovery)", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        // 존재하는 노트는 없다(전부 삭제된 상태를 모사).
        listNotes: async () => [],
        // 그러나 삭제된 노트 'gone'의 스냅샷은 trash에 남아 있다.
        listSnapshotNoteIds: async () => ["gone"],
        listSnapshots: async (id: string) =>
          id === "gone" ? [snap({ id: "s1", title: "지워진 노트 제목" })] : [],
      }),
    );
    await flush();
    const titles = [
      ...panel(host).querySelectorAll<HTMLElement>(".recovery-note-title"),
    ].map((s) => s.textContent);
    expect(titles).toEqual(["지워진 노트 제목"]); // 최신 스냅샷 제목으로 폴백.
    const deletedBtn = panel(host).querySelector<HTMLElement>(
      '.recovery-note[data-deleted="true"]',
    );
    expect(deletedBtn).not.toBeNull();
    expect(
      panel(host).querySelector(".recovery-note-count")!.textContent,
    ).toContain("삭제됨");
  });

  /** 가드: 스냅샷 보유 노트가 없으면 빈 상태 안내를 보인다(노트 목록은 비운다). */
  it("shows an empty state when no note owns a snapshot", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({ listNotes: async () => [note()], listSnapshots: async () => [] }),
    );
    await flush();
    expect(
      panel(host).querySelector<HTMLElement>(".recovery-empty")!.hidden,
    ).toBe(false);
    expect(panel(host).querySelectorAll(".recovery-note")).toHaveLength(0);
  });

  /** 가드: 노트를 고르면 저장본 목록이 최신순으로 뜬다(백엔드 정렬을 그대로 그린다). */
  it("opens the snapshot list for the selected note", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listNotes: async () => [note()],
        listSnapshots: async () => [
          snap({ id: "newest", preview: "최신본" }),
          snap({ id: "oldest", preview: "옛본" }),
        ],
      }),
    );
    await flush();
    const previews = [
      ...panel(host).querySelectorAll<HTMLElement>(
        ".recovery-snapshot-preview",
      ),
    ].map((s) => s.textContent);
    expect(previews).toEqual(["최신본", "옛본"]);
  });

  /**
   * 가드(신뢰 경계): 저장본 본문은 플러그인이 쓴 것일 수 있어 미리보기는 textContent로만
   * 그린다 — 마크업이 실제 DOM 노드로 실행되지 않아야 한다.
   */
  it("previews snapshot body as text, never as markup", async () => {
    const host = document.createElement("div");
    const evil = '<img src=x onerror="alert(1)"><b>굵게</b>';
    await mountSettings(
      host,
      deps({
        listNotes: async () => [note()],
        listSnapshots: async () => [snap({ id: "s1" })],
        readSnapshot: async () => evil,
      }),
    );
    await flush();
    panel(host).querySelector<HTMLButtonElement>(".recovery-snapshot")!.click();
    await flush();
    const preview =
      panel(host).querySelector<HTMLElement>(".recovery-preview")!;
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe(evil); // 원문 그대로 텍스트
    expect(preview.querySelector("img")).toBeNull(); // 마크업 미실행
    expect(preview.querySelector("b")).toBeNull();
  });

  /** 가드(경합, finding 7): 노트 A를 고른 뒤 곧바로 B를 고르면, A의 늦은 응답이 B의 패널
   * 위에 자기 것을 덧그리면 안 된다 — 항상 마지막 선택만 화면에 남는다. */
  it("ignores a stale note selection response (no duplicated detail panels)", async () => {
    const host = document.createElement("div");
    let defer = false;
    const pending: { id: string; resolve: (v: NoteSnapshot[]) => void }[] = [];
    const listSnapshots = (id: string): Promise<NoteSnapshot[]> =>
      defer
        ? new Promise((resolve) => pending.push({ id, resolve }))
        : Promise.resolve([snap({ id: `${id}-s`, preview: `${id}본` })]);
    await mountSettings(
      host,
      deps({
        listNotes: async () => [
          note({ id: "n1", title: "노트1" }),
          note({ id: "n2", title: "노트2" }),
        ],
        listSnapshots,
      }),
    );
    await flush();
    defer = true; // 이제부터 selectNote의 listSnapshots는 수동 해제.
    const byNote = (nid: string): HTMLButtonElement =>
      [
        ...panel(host).querySelectorAll<HTMLButtonElement>(".recovery-note"),
      ].find((b) => b.dataset.note === nid)!;
    // n2를 먼저(스테일이 될 것) 고른 뒤 n1(최신 선택)을 고른다.
    byNote("n2").click();
    byNote("n1").click();
    await flush();
    const p1 = pending.find((p) => p.id === "n1")!;
    const p2 = pending.find((p) => p.id === "n2")!;
    p1.resolve([snap({ id: "n1-s", preview: "n1본" })]); // 최신 선택 먼저 렌더.
    await flush();
    p2.resolve([snap({ id: "n2-s", preview: "n2본" })]); // 스테일 응답 — 무시돼야.
    await flush();
    const previews = [
      ...panel(host).querySelectorAll<HTMLElement>(
        ".recovery-snapshot-preview",
      ),
    ].map((s) => s.textContent);
    expect(previews).toEqual(["n1본"]); // n2본이 섞이면 스테일 응답이 덧그린 것.
  });

  /** 가드(경합, finding 8): 저장본 A를 고른 뒤 곧바로 B를 고르면, A의 늦은 본문이 미리보기를
   * 덮으면 안 된다 — 미리보기(화면)와 복원 대상이 항상 같은 저장본을 가리킨다. */
  it("ignores a stale snapshot preview response", async () => {
    const host = document.createElement("div");
    let defer = false;
    const pending: { id: string; resolve: (v: string) => void }[] = [];
    const readSnapshot = (_id: string, snapId: string): Promise<string> =>
      defer
        ? new Promise((resolve) => pending.push({ id: snapId, resolve }))
        : Promise.resolve("");
    await mountSettings(
      host,
      deps({
        listNotes: async () => [note()],
        listSnapshots: async () => [
          snap({ id: "s1", preview: "저장본1" }),
          snap({ id: "s2", preview: "저장본2" }),
        ],
        readSnapshot,
      }),
    );
    await flush();
    defer = true;
    const bySnap = (sid: string): HTMLButtonElement =>
      [
        ...panel(host).querySelectorAll<HTMLButtonElement>(
          ".recovery-snapshot",
        ),
      ].find((b) => b.dataset.snapshot === sid)!;
    bySnap("s1").click(); // 스테일이 될 것.
    bySnap("s2").click(); // 최신 선택.
    await flush();
    const p2 = pending.find((p) => p.id === "s2")!;
    const p1 = pending.find((p) => p.id === "s1")!;
    p2.resolve("s2 본문"); // 최신 먼저 렌더.
    await flush();
    p1.resolve("s1 본문"); // 스테일 — 미리보기를 덮으면 안 됨.
    await flush();
    const preview =
      panel(host).querySelector<HTMLElement>(".recovery-preview")!;
    expect(preview.textContent).toBe("s2 본문");
  });

  /** 가드: 복원은 확인을 거쳐 restoreSnapshot을 부르고, 목록을 다시 읽는다(새 스냅샷 반영). */
  it("restores after confirmation and refreshes the list", async () => {
    const host = document.createElement("div");
    const restoreSnapshot = vi.fn(async () => {});
    let listCalls = 0;
    await mountSettings(
      host,
      deps({
        listNotes: async () => [note()],
        listSnapshots: async () => {
          listCalls += 1;
          return [snap({ id: "s1" })];
        },
        readSnapshot: async () => "옛 본문",
        restoreSnapshot,
      }),
    );
    await flush();
    const callsBefore = listCalls;
    panel(host).querySelector<HTMLButtonElement>(".recovery-snapshot")!.click();
    await flush();
    panel(host).querySelector<HTMLButtonElement>(".recovery-restore")!.click();
    await flush();
    // 확인 다이얼로그의 확인 버튼을 누른다(파괴적 행위 — 확인 필수).
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();
    expect(restoreSnapshot).toHaveBeenCalledWith("n1", "s1");
    expect(listCalls).toBeGreaterThan(callsBefore); // 복원 뒤 목록을 다시 읽었다
  });

  /** 가드: 확인 다이얼로그에서 취소하면 restoreSnapshot을 부르지 않는다. */
  it("does not restore when the confirmation is cancelled", async () => {
    const host = document.createElement("div");
    const restoreSnapshot = vi.fn(async () => {});
    await mountSettings(
      host,
      deps({
        listNotes: async () => [note()],
        listSnapshots: async () => [snap({ id: "s1" })],
        readSnapshot: async () => "옛 본문",
        restoreSnapshot,
      }),
    );
    await flush();
    panel(host).querySelector<HTMLButtonElement>(".recovery-snapshot")!.click();
    await flush();
    panel(host).querySelector<HTMLButtonElement>(".recovery-restore")!.click();
    await flush();
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  /** 가드: 새로고침 버튼은 노트 목록을 다시 읽어 최신 스냅샷 상태를 반영한다. */
  it("re-reads notes when the refresh button is clicked", async () => {
    const host = document.createElement("div");
    let calls = 0;
    await mountSettings(
      host,
      deps({
        listNotes: async () => {
          calls += 1;
          return [];
        },
      }),
    );
    await flush();
    const before = calls;
    panel(host).querySelector<HTMLButtonElement>(".recovery-refresh")!.click();
    await flush();
    expect(calls).toBeGreaterThan(before);
  });

  /** 가드: 노트 목록 조회가 실패해도 조용히 깨지지 않고 사유를 상태줄에 보인다. */
  it("surfaces a reason when listing notes fails", async () => {
    const host = document.createElement("div");
    await mountSettings(
      host,
      deps({
        listNotes: async () => {
          throw new Error("boom");
        },
      }),
    );
    await flush();
    const status = panel(host).querySelector<HTMLElement>(".recovery-status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).not.toBe("");
  });
});

/**
 * 회귀 가드: 모듈 최상위 `const`가 `t()`를 import 시점에 즉시 평가하던 버그(활성 로케일이
 * 무엇이든 이 창이 로드되는 순간의 로케일 — 늘 ko — 로 영원히 굳는다)의 재발을 막는다.
 *
 * 각 지점을 실제 소비 지점(렌더 함수·호출 시점 함수)을 통해 검증한다 — 고친 것이 "모듈을
 * import하면 끝"이 아니라 "호출될 때마다 그 순간의 활성 로케일을 읽는다"는 사실 자체다.
 * `registerLocale`은 되돌릴 export가 없으므로(store.test.ts와 같은 관례) 이 파일에서
 * 유일한 코드("xx")를 쓰고, 이 describe를 파일 맨 끝에 두어 앞선 테스트의
 * `availableLocales()`(언어 드롭다운 옵션 = ko + 번들 en 둘) 가정과 부딪히지 않게 한다.
 */
describe("i18n — 모듈 최상위 t() 즉시평가 회귀 가드(호출 시점 로케일 반영)", () => {
  afterEach(() => setActiveLocale("ko"));

  /** 가드: CAT_META의 caption(renderBuiltinList 카테고리 헤더)이 호출 시점 로케일을 읽는다. */
  it("CAT_META caption follows the active locale at render time", () => {
    registerLocale("xx", "Test", {
      "settings.category.theme-caption": "XX theme caption",
    });
    const handlers = () => ({ onToggle: vi.fn(), onOpen: vi.fn() });

    setActiveLocale("xx");
    const listXx = document.createElement("ul");
    renderBuiltinList(listXx, {}, {}, handlers());
    expect(
      [...listXx.querySelectorAll(".cat-caption")].map((el) => el.textContent),
    ).toContain("XX theme caption");

    setActiveLocale("ko");
    const listKo = document.createElement("ul");
    renderBuiltinList(listKo, {}, {}, handlers());
    expect(
      [...listKo.querySelectorAll(".cat-caption")].map((el) => el.textContent),
    ).toContain("테마 탭에서 선택 · 끄기 없음");
  });

  /** 가드: THEME_LOCK_STATUS(테마 잠금 상태 문구)가 호출 시점 로케일을 읽는다. */
  it("THEME_LOCK_STATUS follows the active locale at call time", () => {
    registerLocale("xx", "Test", {
      "settings.plugin-detail.theme-lock-status": "XX locked",
    });
    const themePlugin = plugin({ id: "t", permissions: ["theme"] });

    setActiveLocale("xx");
    expect(detailFromInstalled(themePlugin).statusLabel).toBe("XX locked");

    setActiveLocale("ko");
    expect(detailFromInstalled(themePlugin).statusLabel).toBe(
      "필수 — 테마 탭에서 선택",
    );
  });

  /** 가드: THEME_COLOR_FIELDS의 group/label/use(테마 색 편집기)가 호출 시점 로케일을 읽는다. */
  it("THEME_COLOR_FIELDS group/label/use follow the active locale at render time", async () => {
    registerLocale("xx", "Test", {
      "settings.theme.group-semantic": "XX semantic",
      "settings.theme.label-accent": "XX accent",
      "settings.theme.use-accent": "XX use",
    });

    const hostXx = document.createElement("div");
    await mountSettings(
      hostXx,
      deps({ getSettings: async () => ({ ...settings, language: "xx" }) }),
    );
    expect(hostXx.querySelector(".settings-color-group")!.textContent).toBe(
      "XX semantic",
    );
    const rowXx = hostXx.querySelector(".settings-color-row")!;
    expect(rowXx.querySelector(".settings-color-name")!.textContent).toContain(
      "XX accent",
    );
    expect(rowXx.querySelector(".settings-color-use")!.textContent).toBe(
      "XX use",
    );

    const hostKo = document.createElement("div");
    await mountSettings(hostKo, deps());
    expect(hostKo.querySelector(".settings-color-group")!.textContent).toBe(
      "의미색",
    );
    const rowKo = hostKo.querySelector(".settings-color-row")!;
    expect(rowKo.querySelector(".settings-color-name")!.textContent).toContain(
      "강조색",
    );
    expect(rowKo.querySelector(".settings-color-use")!.textContent).toBe(
      "링크 · 버튼 · 활성 탭 · 선택 강조",
    );
  });

  /** 가드: DIAGNOSTIC_LABELS(진단 종류 라벨)가 호출 시점 로케일을 읽는다. */
  it("DIAGNOSTIC_LABELS follow the active locale at render time", () => {
    registerLocale("xx", "Test", {
      "settings.plugin-detail.diagnostic-call-reject": "XX call reject",
    });
    const diagEntry: PluginDiagnostic = {
      pluginId: "x",
      at: Date.now(),
      kind: "call-reject",
      message: "m",
    };

    setActiveLocale("xx");
    const hostXx = document.createElement("div");
    renderPluginDetail(
      hostXx,
      detailItem({ diagnostics: [diagEntry] }),
      detailActions(),
    );
    expect(hostXx.querySelector(".plugin-diagnostic-kind")!.textContent).toBe(
      "XX call reject",
    );

    setActiveLocale("ko");
    const hostKo = document.createElement("div");
    renderPluginDetail(
      hostKo,
      detailItem({ diagnostics: [diagEntry] }),
      detailActions(),
    );
    expect(hostKo.querySelector(".plugin-diagnostic-kind")!.textContent).toBe(
      "호출 거부",
    );
  });

  /** 가드: SHORTCUT_ACTIONS의 labelKey(단축키 탭 라벨)가 호출 시점 로케일을 읽는다. */
  it("SHORTCUT_ACTIONS labels follow the active locale at render time", async () => {
    registerLocale("xx", "Test", {
      "shortcuts.actions.toggle-preview": "XX preview",
    });

    const hostXx = document.createElement("div");
    await mountSettings(
      hostXx,
      deps({ getSettings: async () => ({ ...settings, language: "xx" }) }),
    );
    const labelsXx = [
      ...hostXx.querySelectorAll<HTMLElement>(
        "#settings-page-shortcuts .shortcut-label",
      ),
    ].map((el) => el.textContent);
    expect(labelsXx).toContain("XX preview");
    expect(labelsXx).not.toContain("마크다운 프리뷰");

    const hostKo = document.createElement("div");
    await mountSettings(hostKo, deps());
    const labelsKo = [
      ...hostKo.querySelectorAll<HTMLElement>(
        "#settings-page-shortcuts .shortcut-label",
      ),
    ].map((el) => el.textContent);
    expect(labelsKo).toContain("마크다운 프리뷰");
  });

  /** 가드: BUILTIN_ITEMS의 nameKey(툴바 배치 팔레트 이름)가 호출 시점 로케일을 읽는다. */
  it("BUILTIN_ITEMS names follow the active locale at render time", async () => {
    registerLocale("xx", "Test", {
      "note.layout.item-transparency": "XX Transparency",
    });

    const hostXx = document.createElement("div");
    await mountSettings(
      hostXx,
      deps({ getSettings: async () => ({ ...settings, language: "xx" }) }),
    );
    expect(
      hostXx.querySelector('[data-item-key="core:transparency"] .tb-chip-name')!
        .textContent,
    ).toBe("XX Transparency");

    const hostKo = document.createElement("div");
    await mountSettings(hostKo, deps());
    expect(
      hostKo.querySelector('[data-item-key="core:transparency"] .tb-chip-name')!
        .textContent,
    ).toBe("투명도");
  });

  /** 가드: renderBuiltinList의 cat-label(카테고리 식별자 자체 — CAT_META.caption과는 다른
   * 별개 렌더 지점)이 categoryDisplayName을 통해 호출 시점 로케일을 읽는다. */
  it("renderBuiltinList cat-label follows the active locale at render time", () => {
    registerLocale("xx", "Test", {
      "settings.category.name-tool": "XX Tools",
    });
    const handlers = () => ({ onToggle: vi.fn(), onOpen: vi.fn() });

    setActiveLocale("xx");
    const listXx = document.createElement("ul");
    renderBuiltinList(listXx, {}, {}, handlers());
    expect(
      [...listXx.querySelectorAll(".cat-label")].map((el) => el.textContent),
    ).toContain("XX Tools");

    setActiveLocale("ko");
    const listKo = document.createElement("ul");
    renderBuiltinList(listKo, {}, {}, handlers());
    expect(
      [...listKo.querySelectorAll(".cat-label")].map((el) => el.textContent),
    ).toContain("도구");
  });

  /**
   * 가드: 설정 트리 좌측 그룹 제목(categoryDisplayName)이 알려진 카테고리 식별자("외형")는
   * 호출 시점 로케일을 따르고, 서드파티 플러그인이 매니페스트로 선언한 임의
   * `settingsCategory`(우리 사전에 없는 id)는 로케일과 무관하게 원문 그대로 남는다 —
   * 식별자는 번역 대상이 아니라는 §i18n 규약을 미지 id에서도 지킨다.
   */
  it("categoryDisplayName translates known category ids but passes unknown ones through untouched", async () => {
    registerLocale("xx", "Test", {
      "settings.category.name-appearance": "XX Appearance",
    });
    const customPlugin = () =>
      plugin({
        id: "custom",
        name: "Custom",
        enabled: true,
        settings_category: "MyCustomCat", // 서드파티 임의 카테고리 — 우리 사전에 없다.
        settings_schema: [{ key: "x", label: "X", type: "text", options: [] }],
      });

    const hostXx = document.createElement("div");
    await mountSettings(
      hostXx,
      deps({
        getSettings: async () => ({ ...settings, language: "xx" }),
        listPlugins: async () => [customPlugin()],
      }),
    );
    const groupsXx = [
      ...hostXx.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].map((g) => g.textContent);
    expect(groupsXx[0]).toBe("XX Appearance"); // 알려진 id는 xx 로케일 문구로 바뀐다.
    expect(groupsXx).toContain("MyCustomCat"); // 미지 id는 로케일과 무관하게 원문 그대로.

    const hostKo = document.createElement("div");
    await mountSettings(
      hostKo,
      deps({ listPlugins: async () => [customPlugin()] }),
    );
    const groupsKo = [
      ...hostKo.querySelectorAll<HTMLElement>(".settings-tree-group"),
    ].map((g) => g.textContent);
    expect(groupsKo[0]).toBe("외형"); // ko 로케일은 식별자와 같은 표시 문구.
    expect(groupsKo).toContain("MyCustomCat"); // 미지 id는 ko에서도 원문 그대로.
  });

  /**
   * 가드: 「메모 복구」 페이지의 정적 문구(제목·설명·새로고침 버튼·빈 상태 안내)가 이 창이
   * 확정한 로케일을 따른다.
   *
   * 다른 지점들과 달리 이 버그는 모듈 최상위가 아니라 **함수 호출 순서** 문제였다:
   * 언어팩이 중앙 호스트 스냅샷으로 늦게 오던 시절, `mountSettings`는 그 등록보다 **먼저**
   * `buildRecoveryPanel`을 불러 정적 문구를 ko로 구웠다. 지금은 언어팩(번들 + 코어가 스캔해
   * 준 설치 팩)이 마운트 첫머리에서 등록·확정되므로 그 순서 자체가 뒤집혔다 — 이 가드는
   * 그 새 순서를 못박는다. **`registerLocale`을 테스트가 미리 부르지 않는 것이 핵심**이다:
   * 프로덕션과 같은 경로(`listLanguagePacks` → `readLocaleEntries`)로 사전이 들어와야, 등록을
   * 마운트 밖으로 되돌리는 회귀를 이 테스트가 잡는다.
   */
  it("recovery page static copy follows the locale registered from installed packs", async () => {
    vi.mocked(listLanguagePacks).mockResolvedValueOnce([
      { code: "xx", label: "Test", pluginId: "language-pack-xx" },
    ]);
    vi.mocked(readLocaleEntries).mockResolvedValueOnce({
      "settings.recovery.page-title": "XX Recover Notes",
      "settings.recovery.page-description": "XX description",
      "settings.recovery.refresh-button": "XX Refresh",
      "settings.recovery.empty": "XX nothing to restore",
    });
    const hostXx = document.createElement("div");
    await mountSettings(
      hostXx,
      deps({ getSettings: async () => ({ ...settings, language: "xx" }) }),
    );
    const panelXx = hostXx.querySelector<HTMLElement>(
      "#settings-page-recovery",
    )!;
    expect(panelXx.querySelector(".settings-page-title")!.textContent).toBe(
      "XX Recover Notes",
    );
    expect(panelXx.querySelector(".settings-page-desc")!.textContent).toBe(
      "XX description",
    );
    expect(panelXx.querySelector(".recovery-refresh")!.textContent).toBe(
      "XX Refresh",
    );
    expect(panelXx.querySelector(".recovery-empty")!.textContent).toBe(
      "XX nothing to restore",
    );

    const hostKo = document.createElement("div");
    await mountSettings(hostKo, deps());
    const panelKo = hostKo.querySelector<HTMLElement>(
      "#settings-page-recovery",
    )!;
    expect(panelKo.querySelector(".settings-page-title")!.textContent).toBe(
      "메모 복구",
    );
    expect(panelKo.querySelector(".recovery-refresh")!.textContent).toBe(
      "새로고침",
    );
  });
});

describe("toolbarPaletteChanged (툴바 배치 팔레트 재렌더 판정)", () => {
  const item = (over: Partial<LayoutPaletteItem> = {}): LayoutPaletteItem => ({
    key: "plugin:word-count:word-count-words",
    name: "단어 수 — 눌러서 복사",
    glyph: "0 단어",
    ...over,
  });

  it("완전히 같으면 다시 그리지 않는다(배치-만-변경의 깜빡임 방지)", () => {
    expect(toolbarPaletteChanged([item()], [item()])).toBe(false);
  });

  it("키는 그대로고 이름만 바뀌어도 다시 그린다(언어 변경 — 반쪽 번역 회귀 가드)", () => {
    expect(
      toolbarPaletteChanged(
        [item({ name: "Word count — click to copy" })],
        [item()],
      ),
    ).toBe(true);
  });

  it("글리프·폴백 위치가 바뀌어도 다시 그린다", () => {
    expect(toolbarPaletteChanged([item({ glyph: "0 words" })], [item()])).toBe(
      true,
    );
    expect(
      toolbarPaletteChanged([item({ position: "bottom-right" })], [item()]),
    ).toBe(true);
  });

  it("항목이 늘거나 줄면(플러그인 토글) 다시 그린다", () => {
    expect(toolbarPaletteChanged([item(), item({ key: "x" })], [item()])).toBe(
      true,
    );
    expect(toolbarPaletteChanged([], [item()])).toBe(true);
  });
});

/**
 * 스펙(사용자 확정): 비활성 플러그인은 앱이 아예 모르는 상태여야 한다 — 그 버튼 키는 팔레트에도
 * 배치에도 남지 않는다. 다시 켜지면 이전 위치가 아니라 `position` 기본 자리로 새로 들어온다.
 */
describe("mountSettings — 툴바 배치: 미가용 아이템 정리", () => {
  const host = () => document.createElement("div");
  /** 창 컨트롤·배경이 모두 살아 있는 능력(기본). */
  const allCaps = {
    windowControls: KNOWN_WINDOW_CONTROLS,
    hasBackground: true,
  };
  const chipKeys = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>(".tb-chip")].map(
      (c) => c.dataset.itemKey ?? "",
    );

  it("꺼진 창-기능 플러그인의 내장 컨트롤을 팔레트·목업에서 뺀다", async () => {
    const h = host();
    await mountSettings(
      h,
      deps({
        toolbarButtonItems: vi.fn(async () => []),
        toolbarCapabilities: vi.fn(async () => ({
          windowControls: ["always-on-top"],
          hasBackground: false,
        })),
      }),
    );
    const keys = chipKeys(
      h.querySelector<HTMLElement>("#settings-page-ui-layout")!,
    );
    expect(keys).toContain("core:pin"); // 켜져 있는 것만 남는다
    expect(keys).not.toContain("core:transparency");
    expect(keys).not.toContain("core:all-desktops");
    expect(keys).not.toContain("core:background");
    expect(keys).toContain("core:preview"); // 조건 없는 컨트롤은 그대로
  });

  it("저장된 배치의 죽은 플러그인 키를 지우고 그 결과를 저장한다", async () => {
    // 저장된 값을 꺼내 볼 것이므로 인자를 명시한 스파이로 둔다(무인자 vi.fn은 calls가 []).
    const saveSettings = vi.fn(async (_next: unknown) => {});
    const h = host();
    await mountSettings(
      h,
      deps({
        saveSettings,
        getSettings: async () => ({
          ...settings,
          toolbar_layout: {
            top: {
              align: "left",
              zones: [["core:preview", "plugin:gone:btn"]],
            },
            bottom: { align: "left", zones: [[]] },
            seen: ["core:preview", "plugin:gone:btn", "plugin:also-gone:btn"],
          },
        }),
        toolbarButtonItems: vi.fn(async () => []),
        toolbarCapabilities: vi.fn(async () => allCaps),
      }),
    );
    const keys = chipKeys(
      h.querySelector<HTMLElement>("#settings-page-ui-layout")!,
    );
    expect(keys).not.toContain("plugin:gone:btn");
    // 정리 결과가 저장돼야 다음 로드에서 되살아나지 않는다(그러면 "이전 위치 복원"이 된다).
    expect(saveSettings).toHaveBeenCalled();
    // `.at(-1)`은 ES2022라 이 프로젝트 target(ES2020)에서 타입 오류다 — 인덱스로 마지막을 집는다.
    const calls = saveSettings.mock.calls;
    const saved = calls[calls.length - 1][0] as {
      toolbar_layout: { seen: string[]; top: { zones: string[][] } };
    };
    expect(saved.toolbar_layout.top.zones[0]).toEqual(["core:preview"]);
    expect(saved.toolbar_layout.seen).toEqual(["core:preview"]);
  });

  /** 가드(중요): 호스트 스냅샷이 없으면 "모른다"이지 "없다"가 아니다 — 아무것도 지우지 않는다. */
  it("능력을 못 읽으면(null) 배치를 정리하지 않는다", async () => {
    const saveSettings = vi.fn(async () => {});
    const h = host();
    await mountSettings(
      h,
      deps({
        saveSettings,
        getSettings: async () => ({
          ...settings,
          toolbar_layout: {
            top: {
              align: "left",
              zones: [["core:preview", "plugin:gone:btn"]],
            },
            bottom: { align: "left", zones: [[]] },
            seen: ["core:preview", "plugin:gone:btn"],
          },
        }),
        toolbarButtonItems: vi.fn(async () => []),
        toolbarCapabilities: vi.fn(async () => null),
      }),
    );
    const keys = chipKeys(
      h.querySelector<HTMLElement>("#settings-page-ui-layout")!,
    );
    expect(keys).toContain("plugin:gone:btn"); // 그대로 둔다
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

/**
 * 회귀(confirmed[19]·confirmed[20]): 파괴적 작업(저장 폴더 이전·설정 초기화·모든 데이터
 * 삭제·백업 복원)이 성공하면 `lockSettingsHost`가 설정 창 전체에 잠금 오버레이를 씌운다 —
 * reload 대기 중 다른 탭에서 사소한 편집 하나가 낡은 in-memory settings로 방금 적용된 값을
 * 조용히 덮어쓰는 경합을 막는다. 백업 복원은 추가로, `importBackup()`이 아직 끝나지 않은
 * 동안(성공/실패 확정 전, 즉 위 오버레이가 뜨기 전) 다른 창의 설정 저장으로 인한 호스트
 * 재빌드가 `backupPanel.relocalize()`를 태워 잠갔던 복원 버튼을 되살리는 별도 경합도 막는다
 * (`restoring` 플래그).
 *
 * 모든 테스트가 `vi.useFakeTimers()`를 쓴다: 각 페이지는 성공 뒤 `setTimeout(reload, …)`을
 * 예약하는데, 실제 타이머로 두면 테스트가 끝난 뒤 실제 시간이 흘러 언마운트된 jsdom에서
 * `window.location.reload()`가 뒤늦게 실행되는(다른 테스트에 노이즈를 남기는) 위험이 있다 —
 * `vi.advanceTimersByTimeAsync(0)`로 미결 프라미스 체인만 흘려보내고, 900ms~2.5s 재로드
 * 타이머는 절대 넘기지 않는다(그래서 실제 reload는 이 테스트들에서 한 번도 발화하지 않는다).
 */
describe("mountSettings — 파괴적 작업 잠금(confirmed[19]·confirmed[20])", () => {
  const emptyVaultInfo = {
    path: "/vault",
    has_contents: false,
    note_count: 0,
    file_count: 0,
    prompted: true,
  };

  /**
   * 가드(confirmed[19]): 저장 폴더 이전이 성공하면 reload 전까지 창 전체를 잠근다 — reload
   * 타이머(1500ms)가 아직 안 뜬 시점에도 이미 잠겨 있고, 잠금이 그 예약 자체를 방해하지도
   * 않는다(reload는 여전히 예정대로 정확히 한 번 일어난다).
   */
  it("locks the whole settings window after a successful vault move, until reload", async () => {
    vi.useFakeTimers();
    const originalLocation = window.location;
    const reloadFn = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadFn },
    });
    try {
      const host = document.createElement("div");
      vi.mocked(getVaultInfo)
        .mockResolvedValueOnce(emptyVaultInfo) // 마운트 시 vaultPanel.refresh()
        .mockResolvedValueOnce({ ...emptyVaultInfo, path: "/new/vault" }); // apply() 성공 후 refresh()
      vi.mocked(pickVaultFolder).mockResolvedValueOnce("/new/vault");
      vi.mocked(inspectVaultFolder).mockResolvedValueOnce({
        path: "/new/vault",
        has_vault: false,
        occupied: false,
        same_as_current: false,
      });
      vi.mocked(changeVaultPath).mockResolvedValueOnce({
        outcome: "linked",
        path: "/new/vault",
        moved_entries: 0,
        moved_files: 0,
        windows_reopened: false,
      });

      await mountSettings(host, deps());
      await vi.advanceTimersByTimeAsync(0); // 마운트 시 refresh()의 첫 getVaultInfo() 소비

      expect(host.querySelector(".settings-destructive-overlay")).toBeNull(); // 아직 아무 것도 안 바뀌었다 — 잠글 이유가 없다.

      host.querySelector<HTMLButtonElement>(".vault-change-button")!.click();
      await vi.advanceTimersByTimeAsync(0); // pickVaultFolder → inspectVaultFolder → confirmDialog

      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await vi.advanceTimersByTimeAsync(0); // apply(): changeVaultPath → lockSettingsHost → refresh()

      const overlay = host.querySelector<HTMLElement>(
        ".settings-destructive-overlay",
      );
      expect(overlay).not.toBeNull();
      expect(overlay!.hidden).toBe(false);
      expect(overlay!.textContent).toBe(
        "적용하는 중이에요. 잠시만 기다려 주세요…",
      );
      // 아직 reload 타이머(1500ms)를 넘기지 않았다 — 잠금이 "성공 즉시"부터 유효함을 확인한다.
      expect(reloadFn).not.toHaveBeenCalled();

      // 예약된 reload는 잠금과 무관하게 예정대로 정확히 한 번 일어난다.
      await vi.advanceTimersByTimeAsync(1500);
      expect(reloadFn).toHaveBeenCalledTimes(1);
      expect(overlay!.hidden).toBe(false); // 잠금은 (실제 reload가 없는 테스트 환경이라) 계속 남는다.
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  /**
   * 가드: `changeVaultPath`가 `outcome: "unchanged"`로 돌아오면(실제로 바뀐 것이 없음) 잠그지
   * 않는다 — 되돌릴 값이 없다(위 성공 테스트와 정확히 같은 `apply()` 함수, 다른 분기).
   */
  it("does not lock the window when changeVaultPath reports outcome=unchanged", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      vi.mocked(getVaultInfo).mockResolvedValueOnce(emptyVaultInfo);
      vi.mocked(pickVaultFolder).mockResolvedValueOnce("/vault2");
      vi.mocked(inspectVaultFolder).mockResolvedValueOnce({
        path: "/vault2",
        has_vault: true, // "연결" 확인 한 번만 거치는 분기로 apply()까지 곧장 간다.
        occupied: false,
        same_as_current: false,
      });
      vi.mocked(changeVaultPath).mockResolvedValueOnce({
        outcome: "unchanged",
        path: "/vault2",
        moved_entries: 0,
        moved_files: 0,
        windows_reopened: false,
      });

      await mountSettings(host, deps());
      await vi.advanceTimersByTimeAsync(0);

      host.querySelector<HTMLButtonElement>(".vault-change-button")!.click();
      await vi.advanceTimersByTimeAsync(0); // pickVaultFolder → inspectVaultFolder → confirmDialog

      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await vi.advanceTimersByTimeAsync(0); // apply(): changeVaultPath(outcome=unchanged)

      expect(host.querySelector(".settings-destructive-overlay")).toBeNull();
      expect(
        host.querySelector<HTMLButtonElement>(".vault-change-button")!.disabled,
      ).toBe(false); // 버튼도 다시 풀려 있다.
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드(confirmed[19]): 설정 초기화가 성공하면 reload 전까지 창 전체를 잠근다. */
  it("locks the whole settings window after a successful settings reset, until reload", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      vi.mocked(resetSettings).mockResolvedValueOnce(undefined);

      await mountSettings(host, deps());
      await vi.advanceTimersByTimeAsync(0);

      host.querySelector<HTMLButtonElement>(".reset-settings-button")!.click();
      await vi.advanceTimersByTimeAsync(0); // confirmDialog 마운트
      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await vi.advanceTimersByTimeAsync(0); // resetSettings() → lockSettingsHost

      const overlay = host.querySelector<HTMLElement>(
        ".settings-destructive-overlay",
      );
      expect(overlay).not.toBeNull();
      expect(overlay!.hidden).toBe(false);
      expect(overlay!.textContent).toBe(
        "적용하는 중이에요. 잠시만 기다려 주세요…",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 가드(confirmed[19], wipe 강화): 「모든 데이터 삭제」는 reload가 아예 없어(재시작 전까지)
   * 성공하면 창을 영구히 잠근다 — 오버레이 문구도 재시작 안내로 다르게 보여준다.
   */
  it("permanently locks the window after wiping all data (no reload exists for this path)", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      vi.mocked(wipeAllData).mockResolvedValueOnce(undefined);

      await mountSettings(host, deps());
      await vi.advanceTimersByTimeAsync(0);

      const wipeInput =
        host.querySelector<HTMLInputElement>(".reset-wipe-input")!;
      wipeInput.value = "DELETE"; // settings.ts의 WIPE_CONFIRM_WORD
      wipeInput.dispatchEvent(new Event("input"));
      host.querySelector<HTMLButtonElement>(".reset-wipe-button")!.click();
      await vi.advanceTimersByTimeAsync(0); // confirmDialog 마운트
      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await vi.advanceTimersByTimeAsync(0); // wipeAllData() → lockSettingsHost

      const overlay = host.querySelector<HTMLElement>(
        ".settings-destructive-overlay",
      );
      expect(overlay).not.toBeNull();
      expect(overlay!.hidden).toBe(false);
      expect(overlay!.textContent).toBe(
        "모든 데이터를 삭제했어요. 변경 사항을 완전히 반영하려면 트레이에서 앱을 종료했다가 다시 열어 주세요.",
      );

      // reload가 없는 경로다 — 아무리 시간이 흘러도(재로드 대기창 900~2500ms를 훌쩍 넘겨도)
      // 잠금이 스스로 풀리지 않는다(수동 재시작 전까지 영구 잠금이라는 설계를 확인한다).
      await vi.advanceTimersByTimeAsync(10_000);
      expect(overlay!.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 가드(confirmed[20], 핵심 회귀): importBackup()이 아직 끝나지 않은 동안 다른 창의 설정
   * 저장으로 인한 호스트 재빌드(onThemeUpdated)가 와도, relocalize()가 다시 그리는 미리보기가
   * 복원 버튼을 되살리지 못한다 — `restoring` 플래그가 무조건 잠근다. 이 가드가 없으면
   * syncRestoreEnabled()가 selected.supported·체크박스 상태만 보고 restoreBtn.disabled를
   * false로 되돌려, 사용자가 그 순간 다시 눌러 두 번째 importBackup()이 겹칠 수 있었다.
   */
  it("keeps the restore button locked while importBackup() is in flight, even if the host rebuilds", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      let onHostUpdated: (() => void) | null = null;
      vi.mocked(pickBackupFile).mockResolvedValueOnce("/backups/b.zip");
      vi.mocked(inspectBackup).mockResolvedValueOnce({
        path: "/backups/b.zip",
        schema_version: 1,
        app_version: "0.1.0",
        created_at: Date.now(),
        platform: "windows",
        supported: true,
        has_settings: true,
        has_prefs: false,
        plugins: [],
        storage_count: 0,
        size_bytes: 100,
      });
      let resolveImport:
        | ((report: {
            settings_restored: boolean;
            prefs_restored: boolean;
            plugins_restored: number;
            plugins_failed: string[];
            storage_restored: number;
            snapshot_path: string;
          }) => void)
        | null = null;
      vi.mocked(importBackup).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImport = resolve;
          }),
      );

      await mountSettings(
        host,
        deps({
          onThemeUpdated: (handler: () => void) => {
            onHostUpdated = handler;
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      host.querySelector<HTMLButtonElement>(".backup-import-button")!.click();
      await vi.advanceTimersByTimeAsync(0); // pickBackupFile → inspectBackup → renderPreview

      const restoreBtn = host.querySelector<HTMLButtonElement>(
        ".backup-restore-button",
      )!;
      expect(restoreBtn.disabled).toBe(false); // 미리보기 직후 — 아직 진행 중이 아니다.

      restoreBtn.click();
      await vi.advanceTimersByTimeAsync(0); // confirmDialog 마운트
      host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
      await vi.advanceTimersByTimeAsync(0); // restoring=true → importBackup() 호출, 아직 대기 중

      expect(restoreBtn.disabled).toBe(true);
      expect(resolveImport).not.toBeNull();

      // 다른 창의 설정 저장 등으로 이 창의 호스트 재빌드 신호가 온다 — relocalize()가
      // renderPreview(selected) → syncRestoreEnabled()를 다시 태운다.
      onHostUpdated!();
      await vi.advanceTimersByTimeAsync(0);

      // 핵심 단언: importBackup()이 아직 끝나지 않았으므로 restoreBtn은 계속 잠긴 채여야 한다.
      expect(restoreBtn.disabled).toBe(true);

      // 이제 복원을 완료시킨다 — confirmed[19]와 같은 이유로 이 창 전체도 잠긴다.
      resolveImport!({
        settings_restored: true,
        prefs_restored: false,
        plugins_restored: 0,
        plugins_failed: [],
        storage_restored: 0,
        snapshot_path: "/vault/.memo/backups/snap.zip",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(
        host.querySelector(".backup-preview")!.hasAttribute("hidden"),
      ).toBe(true); // closePreview()로 닫혔다.
      const overlay = host.querySelector<HTMLElement>(
        ".settings-destructive-overlay",
      );
      expect(overlay).not.toBeNull();
      expect(overlay!.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 설치(서드파티) 언어팩 등록의 **결정성** 가드(②단계 적대 검증에서 확정된 결함).
 *
 * 카탈로그는 같은 로케일 코드를 여러 플러그인이 공급하는 것을 허용한다(그것이 "어느
 * 플러그인이 무엇을 공급하는가"의 사실 기록이다). 예전 배선은 `installedPacks.map`을
 * `Promise.all`로 병렬 등록해서, `registerLocale`의 LastWins 승자가 **IPC 완료 순서**에
 * 좌우됐다 — 드롭다운 라벨이 실행마다 바뀔 수 있었다(백엔드 `read_locale_entries`는 id
 * 사전순 LastWins로 이미 결정적인데 프런트가 그 순서를 깨뜨린 것이다).
 *
 * `registerLocale`은 되돌릴 export가 없으므로 이 파일의 관례대로 코드 "xx"를 쓰고 파일
 * 맨 끝에 둔다(앞선 테스트의 `availableLocales()` 가정과 부딪히지 않게).
 */
describe("설치 언어팩 등록 — 라벨 승자와 스캔 횟수가 결정적이다", () => {
  afterEach(() => setActiveLocale("ko"));

  it("uses the last catalog entry's label for a duplicate code and scans each code once", async () => {
    // 호출 횟수를 세므로 앞선 it들이 남긴 카운터를 먼저 지운다(이 파일은 `clearMocks`를 쓰지
    // 않아 mock.calls가 누적된다 — 지우지 않으면 이 가드가 "누가 앞에서 이 IPC를 썼는가"에
    // 따라 흔들린다). `mockClear`는 호출 기록만 지우고 아래 once 큐는 건드리지 않는다.
    vi.mocked(readLocaleEntries).mockClear();
    // 같은 code를 두 팩이 공급한다. 뒤(=id 사전순 뒤, 백엔드 사전 병합의 승자와 같은 팩)의
    // 라벨이 이겨야 한다 — 그러지 않으면 "A의 라벨인데 B의 문장"이 된다.
    vi.mocked(listLanguagePacks).mockResolvedValueOnce([
      { code: "xx", label: "Alpha", pluginId: "language-pack-a" },
      { code: "xx", label: "Beta", pluginId: "language-pack-b" },
    ]);
    vi.mocked(readLocaleEntries).mockResolvedValueOnce({
      "settings.language.picker-label": "XX language",
    });

    const host = document.createElement("div");
    await mountSettings(host, deps({}));

    const select = host.querySelector<HTMLSelectElement>(".settings-language")!;
    const xx = [...select.options].find((o) => o.value === "xx");
    expect(xx?.textContent).toBe("Beta");

    // 유니크 code에만 IPC를 부른다 — 중복 code마다 같은 스캔을 반복하면 첫 페인트 핫패스에
    // 그만큼이 그대로 얹힌다(사전은 어차피 그 code의 병합 결과 하나다).
    expect(vi.mocked(readLocaleEntries)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readLocaleEntries)).toHaveBeenCalledWith("xx");
  });

  /** 가드: 사전이 비어 있으면 등록하지 않는다 — "고를 수는 있는데 전부 ko로 폴백되는"
   * 유령 항목을 드롭다운에 만들지 않는다. */
  it("does not register a locale whose dictionary comes back empty", async () => {
    vi.mocked(listLanguagePacks).mockResolvedValueOnce([
      { code: "zz", label: "Ghost", pluginId: "language-pack-ghost" },
    ]);
    vi.mocked(readLocaleEntries).mockResolvedValueOnce({});

    const host = document.createElement("div");
    await mountSettings(host, deps({}));

    const select = host.querySelector<HTMLSelectElement>(".settings-language")!;
    expect([...select.options].map((o) => o.value)).not.toContain("zz");
  });
});
