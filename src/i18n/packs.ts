/**
 * 번들 언어팩 로더 — `src/plugin/builtin/language-packs/*`의 **데이터 선언**을 각 창이
 * 로컬에서 직접(동적 import) 읽어 로케일 저장소에 등록한다.
 *
 * 역할: 폴더 하나가 외부 언어팩 플러그인과 **바이트상 같은 형태**(`manifest.json` +
 * `main.js` + `README.md`)로 자신을 선언하면, 여기서 (1) 어떤 코드의 팩이 있는지 동기로
 * 알려 주고(`bundledPackMetas`), (2) 실제로 필요한 팩 하나만 비동기로 읽어
 * (`loadBundledPack`) `registerBundledLocale`에 넘긴다.
 *
 * ## 왜 `plugin/builtin/index.ts`와 다른 파일인가
 *
 * 그쪽 글로브는 **eager**다 — 목적이 "중앙 호스트가 실행할 번들 목록"이라 앱이 뜨는 순간
 * 전부 메모리에 있어야 한다(`BUILTIN_PLUGINS`가 곧 실행 목록이다). 언어팩은 정반대다:
 * 호스트가 **실행하지 않는다**(main.js가 공백뿐이고, 등록 내용은 매니페스트 데이터가
 * 전부다). 코어(각 창 부트스트랩)가 활성 로케일 하나를 직접 읽어 쓰는 것이 이 구조의
 * 요점이라(C안 — VS Code의 언어팩과 같은 결), 두 목록은 소비자도 로드 시점도 다르다.
 * 같은 파일에 섞으면 eager 글로브 하나가 언어팩 사전까지 함께 끌고 들어온다.
 *
 * ## 왜 반드시 비-eager인가
 *
 * 사전 한 벌은 500키가 넘는 수십 KB다. eager로 모으면 그 바이트가 **모든 창의 공용
 * 청크**에 박혀, ko 사용자도 앱을 켤 때마다 영어 사전을 통째로 내려받는다 — "활성 로케일만
 * 로드"라는 이 단계의 목적 자체가 무너진다. 비-eager 글로브는 경로→로더 함수 맵만 만들고
 * 실제 청크는 부르는 순간 받아 온다.
 *
 * ## 폴더명 규약: `language-pack-<code>`
 *
 * 코드는 **폴더명에서** 파생한다(매니페스트를 열어 `locale`을 읽지 않는다). 사전을 읽어야
 * 코드를 알 수 있으면 "필요한 팩 하나만 읽는다"가 성립하지 않기 때문이다 — 무엇을 읽을지
 * 고르는 판단 자체가 이미 전부 읽은 뒤가 된다. 파생 코드와 매니페스트
 * `contributes.translations[0].locale`이 어긋나면 그 팩은 영원히 안 쓰이므로,
 * 일치는 `packs.test.ts`가 가드로 고정한다.
 *
 * ## 왜 팩 토글이 여전히 중앙 호스트 재빌드를 태우는가(지우지 마라)
 *
 * 이 팩들은 호스트가 실행하지 않으므로, 설정 창에서 팩을 켜고 끌 때 도는 재빌드
 * (`set_builtin_enabled` → `notes-reload` → 호스트 `build()` → `EV_HOST_UPDATED`)는 언뜻
 * 낭비로 보인다 — 호스트가 다시 실행할 것이 하나도 없기 때문이다. 그럼에도 **유지한다**:
 * 이 체인의 마지막 고리(`EV_HOST_UPDATED` → 노트 창 `location.reload()`)가 곧 **언어 변경이
 * 열려 있는 창에 전파되는 유일한 메커니즘**이다. 각 창은 부트스트랩에서 한 번 사전을 읽고
 * 첫 페인트에 문구를 굳히므로(반응형 렌더가 아니다), 리로드 없이는 팩을 꺼도 켜도 화면이
 * 그대로다. "언어팩은 호스트를 안 거치니 재빌드도 필요 없다"는 최적화를 넣으면, 그 순간
 * 토글이 열려 있는 창에 아무 영향도 주지 못하는 상태가 된다.
 *
 * 그 마지막 고리는 이제 **조건부**다: 노트 창은 재빌드 완료 방송을 받으면 새 스냅샷·설정을
 * 예전 것과 비교해, 제자리에서 반영할 수 있는 변화면 리로드하지 않는다
 * (`bootstrap/host-update-plan.ts`). 언어팩 토글은 이 호스트를 거치지 않으므로 그 비교에
 * **아무 차이도 남기지 않는다** — 그래서 발신 쪽이 재빌드 사유를 `"locale"`로 실어 보내고
 * (`bootstrap/settings.ts`의 `builtinReason`·`flushNotesReload`), 판정기가 그 사유를 언제나
 * 리로드로 못박는다. 팩 토글의 사유를 `"plugins"`로 되돌리면 위 문단의 사고가 그대로 재현된다.
 */
import type { PluginContributions } from "../plugin/manifest";
import type { BuiltinPlugin } from "../plugin/builtin/types";
import { registerBundledLocale } from "./store";

/** 번들 언어팩 폴더 이름의 접두 — 뒤에 붙는 것이 로케일 코드다(`language-pack-en` → `en`). */
const PACK_DIR_PREFIX = "language-pack-";

/**
 * 번들 언어팩 매니페스트의 형태(폴더가 선언 — 외부 언어팩 매니페스트와 같은 필드).
 *
 * `purpose`·`llmContext`·`permissionReasons`처럼 저작 도구·승인 UI용 필드는 여기서 읽지
 * 않는다(있어도 무해하다 — 매니페스트는 원문 그대로 소비 지점에 전달된다).
 */
interface PackManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  summary?: string;
  kind?: string;
  permissions: string[];
  /** 저작자 자기 로컬라이즈 사전(축 2) — 설정창 목록이 `%키%`를 이걸로 해석한다. */
  nls?: Record<string, Record<string, string>>;
  /** 언어팩의 실체 — `translations[0]`이 `{locale,label,entries}`다. */
  contributes?: PluginContributions;
}

/**
 * 로드된 번들 언어팩 한 건(매니페스트 원문 + README 원문·로케일 변형).
 *
 * export하지 않는다 — 소비처는 전부 이 모듈의 함수 시그니처를 통해 이 형을 **추론**해서
 * 쓴다(이름으로 import하는 곳이 없다). 굳이 export하면 knip이 "아무도 안 쓰는 export"로
 * 잡는데, 그 경고는 옳다: 지금은 내부 형이다.
 */
interface BundledPack {
  id: string;
  /** 폴더명에서 파생한 로케일 코드(`language-pack-en` → `"en"`). */
  code: string;
  manifest: PackManifest;
  readme: string;
  readmeLocales: Record<string, string>;
}

/** 폴더 하나를 식별하는 최소 정보 — 글로브 **키에서만** 파생하므로 동기다(청크를 안 받는다).
 * [`BundledPack`]과 같은 이유로 export하지 않는다(추론으로만 소비된다). */
interface BundledPackMeta {
  id: string;
  code: string;
}

/**
 * 폴더별 세 글로브(전부 비-eager) — 값은 "부르면 그 청크를 받아 오는 함수"다.
 *
 * `README.*.md`는 로케일 변형만 매치한다(`README.md`는 중간에 `.<locale>` 세그먼트가 없어
 * 이 패턴에 안 걸린다) — 그래도 아래 파싱은 `builtin/index.ts`와 같은 정규식으로 한 번 더
 * 거른다(글로브 구현이 바뀌어도 기본 README가 변형으로 새지 않게).
 */
const manifestLoaders = import.meta.glob(
  "../plugin/builtin/language-packs/*/manifest.json",
) as Record<string, () => Promise<{ default: PackManifest }>>;
const readmeLoaders = import.meta.glob(
  "../plugin/builtin/language-packs/*/README.md",
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;
const readmeVariantLoaders = import.meta.glob(
  "../plugin/builtin/language-packs/*/README.*.md",
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;

/** `README.<locale>.md`에서 로케일 코드를 뽑는다(`builtin/index.ts`와 같은 규칙·정규식). */
const README_LOCALE_RE = /^README\.([^./]+)\.md$/;

/** 글로브 키(파일 경로)에서 그 파일이 든 폴더 경로를 뽑는다. */
function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** 폴더 경로에서 폴더 이름(= 매니페스트 `id`와 같아야 한다)을 뽑는다. */
function dirName(dir: string): string {
  return dir.slice(dir.lastIndexOf("/") + 1);
}

/**
 * 이 빌드에 들어 있는 번들 언어팩 전부의 `{id, code}`를 돌려준다(**동기** — 글로브 키만 본다).
 *
 * 규약을 안 지킨 폴더(접두 없음·코드 빈 문자열)는 조용히 뺀다 — 코드를 파생할 수 없으면
 * 어차피 어떤 로케일로도 활성화될 수 없어서, 목록에 넣어 봐야 "고를 수 없는 항목"만 는다.
 */
export function bundledPackMetas(): BundledPackMeta[] {
  const metas: BundledPackMeta[] = [];
  for (const path of Object.keys(manifestLoaders)) {
    const id = dirName(dirOf(path));
    if (!id.startsWith(PACK_DIR_PREFIX)) continue;
    const code = id.slice(PACK_DIR_PREFIX.length);
    if (code === "") continue;
    metas.push({ id, code });
  }
  return metas;
}

/**
 * 코드 하나에 해당하는 번들 언어팩을 읽는다(없으면 null) — 여기서 처음으로 사전 청크가
 * 실제로 내려온다.
 *
 * README는 있으면 싣고 없으면 빈 문자열이다(목록 표시가 요약을 README 첫 줄에서 파생할 뿐,
 * 없다고 등록이 막히지는 않는다 — 등록에 필요한 것은 매니페스트뿐이다).
 */
export async function loadBundledPack(
  code: string,
): Promise<BundledPack | null> {
  const id = `${PACK_DIR_PREFIX}${code}`;
  const path = Object.keys(manifestLoaders).find(
    (p) => dirName(dirOf(p)) === id,
  );
  if (path === undefined) return null;
  const dir = dirOf(path);
  const manifest = (await manifestLoaders[path]()).default;
  const readmeLoader = readmeLoaders[`${dir}/README.md`];
  const readme = readmeLoader ? (await readmeLoader()).trim() : "";
  const readmeLocales: Record<string, string> = {};
  for (const [variantPath, load] of Object.entries(readmeVariantLoaders)) {
    if (dirOf(variantPath) !== dir) continue;
    const m = README_LOCALE_RE.exec(variantPath.slice(dir.length + 1));
    if (!m) continue;
    readmeLocales[m[1]] = (await load()).trim();
  }
  return { id, code, manifest, readme, readmeLocales };
}

/** 번들 언어팩 전부를 읽는다(설정창 목록용 — 활성/비활성과 무관하게 전부). */
export async function loadAllBundledPacks(): Promise<BundledPack[]> {
  const packs = await Promise.all(
    bundledPackMetas().map((meta) => loadBundledPack(meta.code)),
  );
  return packs.filter((p): p is BundledPack => p !== null);
}

/** 팩의 실제 등록 대상(`contributes.translations[0]`)을 꺼낸다 — 없으면 null. */
function translationOf(
  pack: BundledPack,
): { locale: string; label: string; entries: unknown } | null {
  const item = pack.manifest.contributes?.translations?.[0];
  if (!item) return null;
  const locale = item.locale;
  if (typeof locale !== "string" || locale === "") return null;
  return {
    locale,
    label: typeof item.label === "string" ? item.label : "",
    entries: item.entries,
  };
}

/** 팩 하나를 로케일 저장소에 등록한다(등록됐으면 true). */
function registerPack(pack: BundledPack): boolean {
  const tr = translationOf(pack);
  if (!tr) return false;
  registerBundledLocale(tr.locale, tr.label, tr.entries);
  return true;
}

/**
 * 번들 팩이 지금 켜져 있는가 — 중앙 호스트·노트 창의 번들 실행 판정과 **같은 규칙**이다.
 *
 * `states`가 `null`(=조회 실패, "모른다")이면 **로드하지 않는다.** 빈 맵으로 폴백하면
 * `states[id] ?? true`가 전부 "켜짐"으로 읽혀, 사용자가 꺼둔 팩이 실패 경로에서만 되살아나는
 * fail-open이 생긴다(`note.ts`의 `builtinRunning` — "모르면 안 그린다"와 같은 결).
 */
function packEnabled(
  id: string,
  states: Record<string, boolean> | null,
): boolean {
  if (!states) return false;
  return states[id] ?? true; // 기록이 없으면 켜짐(listBuiltinStates의 계약).
}

/**
 * 활성 로케일에 해당하는 번들 팩 **하나만** 로드·등록한다(등록했으면 true).
 *
 * 각 창 부트스트랩이 첫 페인트 전에 부르는 지점이다 — 코드가 일치하는 팩이 아예 없으면
 * (예: `language`가 ko이거나 서드파티 언어팩 코드) **어떤 청크도 받지 않고** 즉시 false로
 * 끝난다. 그게 폴더명에서 코드를 파생하는 이유다(파일 상단 참고).
 */
export async function loadActiveBundledLocale(
  language: string,
  states: Record<string, boolean> | null,
): Promise<boolean> {
  const meta = bundledPackMetas().find((m) => m.code === language);
  if (!meta || !packEnabled(meta.id, states)) return false;
  const pack = await loadBundledPack(meta.code);
  return pack ? registerPack(pack) : false;
}

/**
 * 켜져 있는 번들 팩을 **전부** 로드·등록한다(설정 창 전용).
 *
 * 왜 설정 창만 전부인가: 언어 드롭다운 후보가 `availableLocales()`(=이 창에 등록된 로케일)
 * 라서, 지금 활성이 아닌 언어도 등록돼 있어야 고를 수 있다. 다른 창은 자기가 그릴 언어
 * 하나만 있으면 되므로 [`loadActiveBundledLocale`]로 충분하다.
 */
export async function loadEnabledBundledPacks(
  states: Record<string, boolean> | null,
): Promise<void> {
  const enabled = bundledPackMetas().filter((m) => packEnabled(m.id, states));
  const packs = await Promise.all(
    enabled.map((meta) => loadBundledPack(meta.code)),
  );
  for (const pack of packs) {
    if (pack) registerPack(pack);
  }
}

/**
 * 번들 팩을 설정창 목록이 그릴 수 있는 [`BuiltinPlugin`] 모양으로 옮긴다(표시 전용 어댑터).
 *
 * `code`(=샌드박스에서 eval되는 소스)는 **의도적으로 빈 문자열**이다 — 언어팩의 main.js는
 * 공백뿐이고, 애초에 이 팩은 중앙 호스트가 실행하지 않는다. 목록 렌더는 `code`를 쓰지 않고
 * 이름·요약·README·권한·토글만 그리므로 빈 값으로 충분하다(반대로 여기에 무언가를 넣으면
 * "실행되는 번들"처럼 보이는 거짓 신호가 된다).
 */
export function packToBuiltin(pack: BundledPack): BuiltinPlugin {
  const m = pack.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    permissions: m.permissions,
    ...(m.summary ? { summary: m.summary } : {}),
    ...(m.kind ? { kind: m.kind as BuiltinPlugin["kind"] } : {}),
    code: "",
    readme: pack.readme,
    ...(m.contributes ? { contributes: m.contributes } : {}),
    // nls는 원문 그대로 싣는다 — 해석은 소비 지점(renderBuiltinList)이 활성 로케일로 한다
    // (§i18n 규약 — 모듈 최상위 nls 해석 금지).
    ...(m.nls ? { nls: m.nls } : {}),
    ...(Object.keys(pack.readmeLocales).length > 0
      ? { readmeLocales: pack.readmeLocales }
      : {}),
  };
}
