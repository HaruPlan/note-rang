/**
 * 플러그인 중앙 호스트 창(`?plugin-host`) 부트스트랩 — 숨김 상주 창(트레이 앱과 함께 산다).
 *
 * `main.ts`가 동적 `import()`로만 이 모듈을 로드한다(이슈 #26) — `mountPluginHost`
 * (central-host.ts, 3000줄대)는 이 창에서만 필요하고, 노트·패널·설정 창은 이 청크를
 * 내려받지 않는다.
 *
 * 역할: 활성 플러그인마다 샌드박스를 1회 실행·소유하고, 노트 창들의 스냅샷 요청·버튼
 * 클릭·창-스코프 호출 회신을 서빙한다. 권한 게이트키퍼는 여기(호스트)에서 강제된다.
 */
import { resolveLanguage } from "../i18n/detect";
import { loadActiveBundledLocale } from "../i18n/packs";
import { registerLocale, setActiveLocale } from "../i18n/store";
import {
  installedSourceFromRecord,
  type InstalledPluginSource,
} from "../plugin/loader";
import { mountPluginHost } from "../plugin/central-host";
import {
  getAppVersion,
  getPlatform,
  getSharedSettings,
  listBuiltinSettings,
  listBuiltinStates,
  listInstalledPlugins,
  listSystemFonts,
  readLocaleEntries,
  readPluginCode,
  setBuiltinSetting,
  setPluginSetting,
  setPluginTrayItems,
  type InstalledPlugin,
} from "../shared/tauri";
import { tauriBus } from "./shared";

/**
 * 설치 플러그인 목록 항목들의 entry 코드를 읽어 로더가 쓸 로드 입력으로 만든다.
 *
 * 역할: 각 플러그인의 매니페스트 재구성은 로더가 소유한 [`installedSourceFromRecord`]에
 * 맡기고(재구성이 필드를 빠뜨리면 기능 하나가 통째로 죽어서, 왕복 가드가 붙어 있는 그쪽에
 * 둔다), 여기서는 entry 코드를 읽어 묶는 IO만 한다. 코드를 못 읽은 항목은 버린다(빈 코드
 * 실행 방지).
 */
async function toInstalledSources(
  plugins: InstalledPlugin[],
): Promise<InstalledPluginSource[]> {
  const sources = await Promise.all(
    plugins.map(async (p) =>
      installedSourceFromRecord(p, await readPluginCode(p.id).catch(() => "")),
    ),
  );
  return sources.filter((s) => s.code !== "");
}

/** 설치 플러그인 목록을 안전히 읽는다(실패·비배열 응답이면 빈 배열). */
async function safeListInstalledPlugins(): Promise<InstalledPlugin[]> {
  const installed = await listInstalledPlugins().catch(() => []);
  return Array.isArray(installed) ? installed : [];
}

/**
 * 활성화된 설치 플러그인들의 로드 입력을 모은다(에디터 확장용 — enabled만).
 */
async function enabledInstalledSources(): Promise<InstalledPluginSource[]> {
  const installed = await safeListInstalledPlugins();
  return toInstalledSources(installed.filter((p) => p.enabled));
}

/**
 * 모든 설치 플러그인의 로드 입력을 모은다(테마 해석용).
 *
 * 왜: 테마는 enabled 토글이 아니라 "이름으로 선택"되므로, 활성 테마가 설치 플러그인이면
 * enabled 여부와 무관하게 찾을 수 있어야 한다(테마는 선택된 하나만 실행된다).
 */
async function allInstalledSources(): Promise<InstalledPluginSource[]> {
  return toInstalledSources(await safeListInstalledPlugins());
}

/** [`resolveHostLocale`]이 쓰는 IO — 테스트가 갈아 끼우는 유일한 지점. */
interface HostLocaleIo {
  settings(): Promise<{ language?: string | null } | null>;
  builtinStates(): Promise<Record<string, boolean> | null>;
  /**
   * 설치(서드파티) 언어팩이 공급하는 이 로케일의 사전(없으면 빈 맵) — 코어가 설치
   * 매니페스트를 직접 스캔한 결과다(`shared/tauri.ts`의 `readLocaleEntries`).
   *
   * 다른 두 IO와 **같은 이유로 여기 두었다**: 이 파일의 순수 함수가 IPC를 직접 부르면
   * 테스트가 그것만 따로 갈아 끼울 수 없다. 이 창이 이 IPC를 필요로 하는 이유는 번들 팩과
   * 정확히 같다 — 리로드가 없어 스냅샷/재빌드로는 사전이 이 창에 들어오지 않는다.
   */
  localeEntries(locale: string): Promise<Record<string, string>>;
}

/**
 * 이 창이 그릴 언어 코드를 정하고, **그 언어의 언어팩(번들 + 설치)을 이 창의 로케일 저장소에
 * 등록한 뒤 활성 로케일로 전환하고** 코드를 돌려준다. 부팅 1회와 매 재빌드
 * (`deps.activeLocale`)가 **같은 함수**를 탄다.
 *
 * ## 이 함수가 호스트 창 로케일의 단일 소유자다
 *
 * 예전에는 등록과 전환이 갈려 있었다: 사전 등록은 여기서, `setActiveLocale`은 중앙 호스트의
 * `syncHostLocale()`이 매 빌드 끝에서 했다(그쪽이 스냅샷으로 배달된 언어팩을 함께 등록해야
 * 했기 때문이다). 언어팩이 호스트를 거치지 않게 되면서 그 함수는 할 일이 `setActiveLocale`
 * 한 줄만 남았고, 그 한 줄이 **여기서 등록한 사전에만 의존**했다 — 소유자를 둘로 나눌 이유가
 * 사라졌으므로 전환도 이 함수가 한다. 호스트는 반환된 코드를 캐시할 뿐이다.
 *
 * 순서가 계약이다: **등록 → 전환**. `setActiveLocale`은 등록되지 않은 코드를 조용히 무시하는
 * 방어적 함수라, 순서가 뒤집히면 이 창의 `t()`가 아무 진단 없이 ko로 접힌다.
 *
 * ## 왜 매번 다시 로드해야 하는가(회귀 방지)
 *
 * 중앙 호스트 창은 숨김 상주 창이라 **리로드하지 않는다** — 다른 세 창처럼 "재빌드 → 리로드
 * → 새 런타임에서 부트스트랩 다시"로 언어가 갱신되지 않는다. 그래서 부팅 때 한 번만
 * 로드하면: 부팅 언어가 ko였던 창은 사용자가 나중에 en으로 바꿔도 이 창의 store에 en 사전이
 * 없고, `setActiveLocale("en")`이 미등록 코드로 무시되어 이 창의 `t()`가 영원히 ko로 남는다
 * (파괴적 명령 확인 팝업의 title/placeholder/취소·실행 라벨). 중앙 호스트가 매
 * `build()`/`rebuildPlugin()`에서 이 함수를 다시 태우는 것이 그 회귀를 막는 유일한 장치다.
 * 중복 호출은 무해하다 — `registerBundledLocale`은 Map upsert + Set add라 몇 번을 불러도
 * 같은 결과다.
 *
 * ## 곁가지: 부팅 시 조회 실패의 자연 복구
 *
 * `listBuiltinStates()`가 실패하면(states=null) "모른다"라서 팩을 로드하지 않는다 — 다른
 * 창은 리로드가 잦아 다음 로드에서 저절로 복구되지만, 이 창은 리로드가 없어 예전엔 그 실패가
 * 세션 내내 굳었다. 이제 매 재빌드가 같은 조회를 다시 태우므로 자연히 복구된다.
 *
 * IO 실패는 전부 흡수한다 — 호스트 기동·재빌드가 언어 때문에 막히면 안 된다. 설정 읽기 실패도
 * `resolveLanguage(undefined)`에 넘겨 OS 로케일 감지(`systemDefaultLanguage`)를 거치게 한다
 * (예전처럼 catch에서 바로 `"ko"`로 확정하면 이 창만 그 감지를 건너뛴 채 한국어로 고정된다).
 */
export async function resolveHostLocale(io: HostLocaleIo): Promise<string> {
  // `builtinStates`는 호스트 `build()`가 자기 `Promise.all`에서 따로 한 번 더 부른다(같은
  // IPC 중복). 그쪽 결과를 이 콜백이 볼 방법이 없고(둘은 나란히 resolve된다), 캐시로 우회하면
  // 첫 빌드엔 값이 없고 이후엔 한 빌드 뒤처진 값을 쓰게 된다 — 상태 파일 한 번 더 읽는 쪽이
  // 정확하고 싸다(다른 세 창도 부트스트랩마다 같은 조회를 한다).
  const [settings, states] = await Promise.all([
    io.settings().catch(() => null),
    io.builtinStates().catch(() => null),
  ]);
  const language = resolveLanguage(settings?.language);
  await loadActiveBundledLocale(language, states).catch(() => false);
  // **설치(서드파티) 언어팩**도 같은 자리에서, 같은 이유로 등록한다 — 코어(Rust)가 설치
  // 매니페스트를 직접 스캔해 주므로 다른 세 창과 같은 IPC 하나면 된다. 매 재빌드가 다시
  // 타므로 설치/삭제도 자연히 반영된다.
  //
  // ko는 코어 내장이라 부르지 않는다(등록해도 보호 코드로 거부된다). 라벨은 이 창에서
  // 표시에 쓰이지 않으므로 코드를 그대로 넘긴다.
  if (language !== "ko") {
    const entries = await io.localeEntries(language).catch(() => null);
    if (entries && Object.keys(entries).length > 0) {
      registerLocale(language, language, entries);
    }
  }
  // 등록이 **끝난 뒤** 전환한다(위 "순서가 계약이다" 참고) — 이 한 줄이 이 창의 t()가 보는
  // 언어를 확정한다. 반환값은 호출부의 캐시(`memo.i18n.locale()`)용이지 전환 신호가 아니다.
  setActiveLocale(language);
  return language;
}

/**
 * 플러그인 중앙 호스트 창을 기동한다(숨김 상주 창 — 트레이 앱과 함께 산다).
 *
 * 역할: 활성 플러그인마다 샌드박스를 1회 실행·소유하고, 노트 창들의 스냅샷 요청·버튼
 * 클릭·창-스코프 호출 회신을 서빙한다. 권한 게이트키퍼는 여기(호스트)에서 강제된다.
 */
export async function bootstrapPluginHost(): Promise<void> {
  const hostLocaleIo: HostLocaleIo = {
    settings: () => getSharedSettings(),
    builtinStates: () => listBuiltinStates(),
    localeEntries: (locale) => readLocaleEntries(locale),
  };
  // 이 숨김 상주 창도 자기 t()를 쓴다(명령 `destructive` 확인 팝업 등) — 다른 세 창과 같은
  // 지점·같은 순서로 부팅 언어를 확정한다.
  //
  // 왜 build() 전에 한 번 더 하는가: `deps.activeLocale`(아래)이 매 빌드마다 같은 일을
  // 하지만, 그것이 반영되는 시점은 첫 `build()`가 끝난 뒤다. 그 전까지 뜨는 문구가 언어
  // 설정과 무관하게 한국어로 굳던 결함을 이 한 줄이 막는다(빌드가 실패해도 언어는 맞다).
  // 반환값은 버린다 — 활성 전환은 `resolveHostLocale`이 이미 끝냈다.
  await resolveHostLocale(hostLocaleIo);

  await mountPluginHost({
    doc: document,
    bus: tauriBus(),
    builtinStates: () => listBuiltinStates().catch(() => null),
    builtinSettings: () => listBuiltinSettings().catch(() => null),
    enabledInstalledSources,
    allInstalledSources,
    activeThemeName: () =>
      getSharedSettings()
        .then((s) => s.theme)
        .catch(() => "sj_d"),
    // 이 창 자신의 로케일 재동기화 — 중앙 호스트가 매 build()/rebuildPlugin()에서 플러그인
    // 실행보다 **먼저** 이 콜백을 await한다. 부팅과 **같은 함수**라 등록·활성 전환이 함께
    // 끝나고, 호스트는 돌려받은 코드를 `memo.i18n.locale()` 캐시로 쓸 뿐이다. 이 콜백이
    // 없으면 이 창은 부팅 이후 바뀐 언어로 절대 갱신되지 않는다(`resolveHostLocale`
    // doc-comment의 "왜 매번 다시 로드해야 하는가" 참고).
    activeLocale: () => resolveHostLocale(hostLocaleIo),
    platform: () => getPlatform().catch(() => ""),
    // 앱 버전 → `memo.runtime.info().hostVersion`. 읽지 못하면 빈 문자열("모른다") —
    // 지어낸 버전으로 분기하는 플러그인을 만드느니 침묵이 낫다(정규화는 래퍼가 한다).
    hostVersion: () => getAppVersion(),
    // 설치된 시스템 글꼴 — 「폰트」 플러그인이 includeSystem을 켰을 때만 호출된다.
    systemFonts: () => listSystemFonts().catch(() => []),
    // 프라미스를 **버리지 않고 돌려준다** — 거부(선언되지 않은 설정 키 등)를 호스트가
    // 진단으로 기록해 설정 창 「최근 오류」에 띄운다. 예전엔 `void`로 삼켰다.
    persistBuiltinSetting: (id, key, value) =>
      setBuiltinSetting(id, key, value),
    persistPluginSetting: (id, key, value) => setPluginSetting(id, key, value),
    // 개발 모드: 개발 중인 플러그인 하나의 **현재 디스크 소스**를 다시 읽는다. 설치
    // 플러그인 읽기 경로(listInstalledPlugins + readPluginCode + installedSourceFromRecord)를
    // 그대로 재사용하므로 게이트키퍼·권한 클램프가 정식 로드와 똑같이 적용된다(개발 모드는
    // 편의지 보안 우회가 아니다). 없거나 코드를 못 읽으면 null → 호스트가 전체 재빌드로 폴백.
    devSource: async (pluginId) => {
      const installed = await safeListInstalledPlugins();
      const record = installed.find((p) => p.id === pluginId);
      if (!record) return null;
      const code = await readPluginCode(record.id).catch(() => "");
      if (code === "") return null;
      return installedSourceFromRecord(record, code);
    },
    // 메뉴바 트레이 항목: 빌드마다 평탄화한 전체 목록을 네이티브(Rust)로 배달한다 —
    // Rust가 고정 트레이 항목 아래 「플러그인」 섹션을 이 목록으로 다시 그린다. 클릭은 Rust가
    // EV_TRAY_INVOKE로 되쏘고 중앙 호스트가 `run`을 창 컨텍스트 없이 역호출한다.
    setTrayItems: (items) => setPluginTrayItems(items),
  });
}
