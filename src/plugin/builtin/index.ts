/**
 * 1st-party 번들 플러그인·테마의 병합 지점(도그푸딩) — [`plugins/`]·[`themes/`]의 각 폴더가
 * 외부 플러그인과 **똑같은 형태**(`manifest.json` + `main.js` + `README.md`)로 자신을
 * 정의하면, 여기서 파일을 모아 두 목록으로 조립한다.
 *
 * 역할: 매니페스트 + 플러그인 코드 + 사용법 README(마크다운)를 데이터로 제공한다. 코드는
 * 샌드박스에서 eval되어 구조화 API(에디터 인라인 패턴·자동완성·블록 임베드, 툴바 버튼,
 * 클립보드, 현재 노트)만 호출한다 — raw 에디터/DOM 접근은 없다.
 * 왜: (1) 각 빌트인이 외부 플러그인과 바이트상 동일한 폴더 구조라, 외부 저작자에게 살아있는
 * 예제이자 API 실효성 검증이 된다(어려우면 API 보강 신호). (2) 매니저 표시와 노트 창 로드가
 * 같은 목록을 단일 출처로 소비하게 한다(정의 재사용).
 *
 * 로드 방식: `import.meta.glob`로 각 폴더의 세 파일을 모은다. `main.js`·`README.md`는 `?raw`
 * 문자열로, `manifest.json`은 데이터로 읽어 [`BuiltinPlugin`]/[`BuiltinTheme`]로 합친다. 글로브는
 * 파일명 알파벳순이라 순서를 보장하지 못하므로, 아래 명시적 순서 목록으로 재정렬한다 —
 * [`BUILTIN_PLUGINS`] 순서 = 에디터 확장 우선순위(중앙 호스트가 번들→설치 순서를 보존).
 */
import type { PluginSettingField } from "../../shared/tauri";
import type { PluginContributions, PluginKind } from "../manifest";
import { resolveNlsString, resolveSettingFieldNls } from "../manifest";
import type { BuiltinPlugin, BuiltinTheme } from "./types";

export type { BuiltinPlugin, BuiltinTheme } from "./types";

/** manifest.json의 형태(각 빌트인 폴더가 선언 — 외부 플러그인 매니페스트와 같은 필드). */
interface RawManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  /** 목록 부제로 쓰는 한 줄 요약(선택). */
  summary?: string;
  /** 능력 등록 가능 여부(능력 등록 게이트의 입력). */
  kind?: PluginKind;
  permissions: string[];
  /** 지원 OS 목록(선택 — 없으면 전 플랫폼). 미지원 OS에서는 자동 비활성화된다. */
  platforms?: string[];
  /** 선언형 설정 스키마(선택 — 외부 플러그인도 매니페스트로 싣는 필드). */
  settings?: PluginSettingField[];
  /** 설정 트리 카테고리(선택 — 이 플러그인 설정 페이지를 묶을 그룹). */
  settingsCategory?: string;
  /** 설정 페이지 상단 소개 문구(선택). */
  settingsDescription?: string;
  /** 선언형 기여(선택, JS 없이 매니페스트만으로 하는 등록). */
  contributes?: PluginContributions;
  /** 다른 플러그인에 공개할 명령 id들(선택). */
  exposes?: string[];
  /** 저작자 자기 로컬라이즈 사전(선택, 축 2 — 설치 플러그인 매니페스트 `nls`와 같은 형태). */
  nls?: Record<string, Record<string, string>>;
}

/**
 * README 로케일 변형 파일명(`README.<locale>.md`)에서 로케일 코드를 뽑는다. 기본
 * `README.md`는 이 정규식에 매치되지 않는다(중간에 `.<locale>`이 있어야 한다) — 그래서 같은
 * glob 결과에 기본 파일이 섞여 있어도 안전하게 걸러진다.
 */
const README_LOCALE_RE = /^README\.([^./]+)\.md$/;

/**
 * `<dir>/manifest.json`(데이터) + `<dir>/main.js`·`README.md`(?raw) + `README.<locale>.md`
 * 변형(?raw, 선택)을 폴더별로 모은다. `readmeVariants`는 `README.*.md` 글로브 전체(기본
 * `README.md`도 섞여 들어올 수 있는 넓은 패턴)를 받아 여기서 로케일 변형만 골라낸다.
 */
function loadFolder(
  manifests: Record<string, { default: RawManifest }>,
  codes: Record<string, string>,
  readmes: Record<string, string>,
  readmeVariants: Record<string, string> = {},
): Map<string, BuiltinPlugin> {
  const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  // dir → {locale → 원문} — 변형 글로브 경로("<dir>/README.<locale>.md")에서 파일명만 떼어
  // README_LOCALE_RE로 로케일을 뽑는다. 기본 README.md(dirOf가 같은 폴더)는 매치되지 않아
  // 자연히 제외된다.
  const localesByDir = new Map<string, Record<string, string>>();
  for (const [path, content] of Object.entries(readmeVariants)) {
    const dir = dirOf(path);
    const filename = path.slice(dir.length + 1);
    const m = README_LOCALE_RE.exec(filename);
    if (!m) continue;
    const bucket = localesByDir.get(dir) ?? {};
    bucket[m[1]] = content.trim();
    localesByDir.set(dir, bucket);
  }
  const byId = new Map<string, BuiltinPlugin>();
  for (const [path, mod] of Object.entries(manifests)) {
    const m = mod.default;
    const dir = dirOf(path);
    const variants = localesByDir.get(dir);
    byId.set(m.id, {
      id: m.id,
      name: m.name,
      version: m.version,
      permissions: m.permissions,
      ...(m.summary ? { summary: m.summary } : {}),
      // 계약 필드(kind)를 여기서 떨어뜨리면 번들만 게이트를 빠져나간다 — 번들은 외부
      // 플러그인과 같은 경로를 타야 도그푸딩이 성립한다(어긋나면 `builtin.test.ts`가 잡는다).
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.platforms ? { platforms: m.platforms } : {}),
      // 파일 앞뒤 공백은 무의미하므로 정규화(런타임 eval·마크다운 렌더에 영향 없음).
      code: (codes[`${dir}/main.js`] ?? "").trim(),
      readme: (readmes[`${dir}/README.md`] ?? "").trim(),
      ...(m.settings ? { settings: m.settings } : {}),
      ...(m.settingsCategory ? { settingsCategory: m.settingsCategory } : {}),
      ...(m.settingsDescription
        ? { settingsDescription: m.settingsDescription }
        : {}),
      // 선언형 기여를 여기서 떨어뜨리면 번들만 매니페스트 등록이 무시된다(계약 필드
      // kind와 같은 이유로 반드시 통과시킨다).
      ...(m.contributes ? { contributes: m.contributes } : {}),
      // 공개 명령도 번들에서 떨어뜨리면 사이드로드에서만 되는 비대칭이 생긴다(contributes와
      // 같은 이유). 매니페스트가 exposes를 선언한 번들만 실린다(대부분 없어 undefined).
      ...(m.exposes ? { exposes: m.exposes } : {}),
      // 자기 로컬라이즈 사전(축 2) — 원문 그대로 싣는다. 해석은 소비 지점에서(모듈 최상위
      // 즉시평가 금지 — 이 시점엔 활성 로케일을 아직 모른다).
      ...(m.nls ? { nls: m.nls } : {}),
      ...(variants && Object.keys(variants).length > 0
        ? { readmeLocales: variants }
        : {}),
    });
  }
  return byId;
}

/**
 * 폴더 맵을 명시적 순서 목록으로 정렬한다(목록에 없는 폴더는 알파벳순 뒤로 — 조용히 누락되지
 * 않게). 순서 목록은 "정의"가 아니라 "순서"만 담는 작은 레지스트리다.
 */
function ordered<T extends BuiltinPlugin | BuiltinTheme>(
  byId: Map<string, T>,
  order: readonly string[],
): T[] {
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

const pluginById = loadFolder(
  import.meta.glob("./plugins/*/manifest.json", { eager: true }) as Record<
    string,
    { default: RawManifest }
  >,
  import.meta.glob("./plugins/*/main.js", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  import.meta.glob("./plugins/*/README.md", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  // README 로케일 변형(축 2, 선택) — "README.<locale>.md"만 매치한다(기본 README.md는
  // 중간에 로케일 세그먼트가 없어 이 패턴에 안 걸린다). loadFolder가 파일명에서 로케일을
  // 뽑아 폴더별로 묶는다.
  import.meta.glob("./plugins/*/README.*.md", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
);

const themeById = loadFolder(
  import.meta.glob("./themes/*/manifest.json", { eager: true }) as Record<
    string,
    { default: RawManifest }
  >,
  import.meta.glob("./themes/*/main.js", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  import.meta.glob("./themes/*/README.md", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  import.meta.glob("./themes/*/README.*.md", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
) as Map<string, BuiltinTheme>;

/**
 * 번들 비-테마 플러그인 목록(설정의 "번들 플러그인" 섹션 + 노트 창 로드가 함께 소비).
 * 순서 = 에디터 확장 우선순위(글로브 알파벳순이 아니라 이 목록으로 고정).
 */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = ordered(pluginById, [
  "wikilink",
  "copy-ai-prompt",
  "template",
  "duplicate",
  "reset-options",
  "font-scale",
  "youtube-embed",
  "background",
  "highlight",
  // text-color는 kbd와 같은 "{{...}}" 바깥 구분자를 쓴다("{{글자|#hex}}") — 같은 구간을 둘 다
  // 잡는다. 승자는 **이 목록 순서가 아니라** 더 구체적인 패턴(editor-api.ts의
  // patternSpecificity — 파라미터 꼬리 "|#hex"가 있는 쪽)이 가져간다. 순서에 기대던 예전
  // 주석은 사실이 아니었다: 노트 창이 플러그인마다 데코레이션 집합을 따로 만들어 겹침 해소가
  // 아예 돌지 않았고, 그래서 색 글자가 키캡 상자까지 함께 뒤집어썼다.
  "text-color",
  "word-count",
  "underline",
  "superscript",
  "spoiler",
  "kbd",
  "font",
  "transparency",
  "always-on-top",
  "all-desktops",
]);

/** 빌트인 테마 플러그인 목록(설정 창 테마 피커 + 활성 테마 로드). */
export const BUILTIN_THEMES: BuiltinTheme[] = ordered(themeById, [
  "sj_d",
  "plain",
]);

/**
 * 번들 플러그인 한 건의 `%키%` 필드를 nls로 해석한다(축 2 — 설치 플러그인
 * `resolveInstalledPluginNls`의 번들판). 필드 이름만 카멜케이스로 다를 뿐(`settingsCategory`
 * vs `settings_category` 등) 대상·규칙은 완전히 같다 — `resolveSettingFieldNls`를 그대로
 * 재사용해 두 경로가 표류하지 않는다.
 *
 * **소비 지점에서만 부른다** — `BUILTIN_PLUGINS` 자체(모듈 최상위, `import.meta.glob` eager
 * 평가 시점)에는 절대 적용하지 않는다. 그 시점은 어느 창의 활성 로케일도 확정되기 전이라
 * (§i18n 규약), 여기서 구우면 첫 창이 로드된 로케일로 영원히 고정된다. 실제 소비처는
 * `settings/settings.ts`의 번들 목록(`renderBuiltinList`)·설정 페이지(`pluginPages`)다.
 *
 * `nls`가 없으면 입력을 그대로 돌려준다(참조까지 동일 — 하위호환 100%, nls 없는 번들은 이
 * 함수를 거쳐도 완전히 무변화).
 */
export function resolveBuiltinPluginNls(
  plugin: BuiltinPlugin,
  locale: string,
): BuiltinPlugin {
  const nls = plugin.nls;
  if (!nls) return plugin;
  const r = (s: string): string => resolveNlsString(s, nls, locale);
  return {
    ...plugin,
    name: r(plugin.name),
    ...(plugin.summary ? { summary: r(plugin.summary) } : {}),
    ...(plugin.settingsCategory
      ? { settingsCategory: r(plugin.settingsCategory) }
      : {}),
    ...(plugin.settingsDescription
      ? { settingsDescription: r(plugin.settingsDescription) }
      : {}),
    ...(plugin.settings
      ? {
          settings: plugin.settings.map((f) =>
            resolveSettingFieldNls(f, nls, locale),
          ),
        }
      : {}),
  };
}

/**
 * 번들 테마 한 건의 `%키%` 필드를 nls로 해석한다([`resolveBuiltinPluginNls`]와 같은 규칙,
 * 대상만 좁다) — 테마는 설정 스키마가 없고(`isTheme` 고정 잠금), `name`은 대개 고유명사라
 * 저작자가 굳이 `nls`에 안 걸면 그대로 무변화다. `summary`만 실질적으로 해석 대상이 된다.
 */
export function resolveBuiltinThemeNls(
  theme: BuiltinTheme,
  locale: string,
): BuiltinTheme {
  const nls = theme.nls;
  if (!nls) return theme;
  const r = (s: string): string => resolveNlsString(s, nls, locale);
  return {
    ...theme,
    name: r(theme.name),
    ...(theme.summary ? { summary: r(theme.summary) } : {}),
  };
}

/**
 * README 로케일 변형 중 활성 로케일에 맞는 것을 고른다(축 2) — 없으면 기본(`readme`, 이미
 * `README.md` 원문)으로 조용히 폴백한다(오류가 아니다, Rust `read_plugin_readme`의 로케일
 * 우선순위와 같은 결). 설치 플러그인은 IPC로 매번 다시 읽어 이 선택을 백엔드가 하지만, 번들은
 * 이미 전부 메모리에 있으므로(빌드 시 번들됨) 여기서 동기로 고른다.
 */
export function pickBuiltinReadme(
  base: string,
  locales: Record<string, string> | undefined,
  locale: string,
): string {
  return locales?.[locale] ?? base;
}

/**
 * 번들 플러그인/테마 폴더의 이미지 자산 맵(`<id>/<파일명>` → 번들 URL) — README의 로컬 이미지
 * 렌더에 쓴다. Vite가 자산으로 번들해 앱 origin('self')에서 서빙하므로 CSP img-src 'self'로 로드된다.
 * 지금은 빈 맵일 수 있으나(번들 README는 이미지를 안 씀), 폴더에 이미지를 넣으면 자동 포함된다.
 */
export const BUILTIN_ASSETS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob(
      "./{plugins,themes}/*/*.{png,jpg,jpeg,gif,svg,webp,avif}",
      {
        eager: true,
        query: "?url",
        import: "default",
      },
    ) as Record<string, string>,
  ).map(([path, url]) => {
    // "./plugins/<id>/<file>" → "<id>/<file>"
    const parts = path.split("/");
    return [`${parts[parts.length - 2]}/${parts[parts.length - 1]}`, url];
  }),
);
