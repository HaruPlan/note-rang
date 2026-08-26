/**
 * memo-plugin CLI — 호스트 검증 규칙을 실제 소스에서 그대로 빌려 온다.
 *
 * 역할: `src/plugin/manifest.ts`(매니페스트 검증)·`src/plugin/host.ts`(호출/권한
 * 매핑·예약 호출)·`src/plugin/permissions.ts`(권한 판정·역인덱스)·`src/plugin/test-host.ts`
 * (헤드리스 하니스)를 Vite의 SSR 모듈 로더로 그대로 불러와 CLI가 같은 함수·같은 상수를
 * 직접 재사용하게 한다.
 *
 * 왜 이 방식인가: 검증 규칙은 이미 TS 검증기(manifest.ts)·Rust 검증기(plugins.rs)·JSON
 * Schema(docs/plugin/manifest.schema.json) 세 곳에 있다. CLI가 규칙을 손으로
 * 다시 옮겨 적으면 그 네 번째 사본이 되어 이 저장소가 이미 겪은 복제 드리프트를 반복한다
 * (절 지시사항). Node의 기본 ESM 로더는 이 저장소의
 * 확장자 없는 상대 import(`from "./permissions"`)를 해석하지 못한다(직접 확인:
 * `node manifest.ts`를 실행하면 `ERR_MODULE_NOT_FOUND`) — 반면 이미 devDependency로 있는
 * `vite`의 `ssrLoadModule`은 이 저장소의 tsconfig(`moduleResolution: bundler`)와 같은 방식
 * 으로 모듈을 완전히 해석한다. 새 의존성을 CLI에 들이지 않고 이 경로를 빌려 쓴다.
 */
import { createServer } from "vite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  LoadPluginOptions,
  HeadlessPlugin,
} from "../../plugin/test-host.ts";

/** manifest.ts `parseManifest`가 성공 시 돌려주는 형태 중 CLI가 실제로 읽는 부분만 —
 * 전체 타입을 다시 선언하지 않고 필요한 필드만 덕타이핑한다(구조가 늘어도 CLI는 안 깨진다). */
export interface ParsedPluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: string[];
  /**
   * `type`·`command`까지 읽는다: 설정 액션 버튼이 가리키는 명령이 코드에 실재하는지
   * 대조해야 하기 때문이다. `key`만 읽던 시절에는 그 대조가 아예 불가능했다.
   */
  settings?: { key: string; type?: string; command?: string }[];
  /** 능력/액션 구분. 미선언은 하위호환으로 통과(게이트도 막지 않는다). */
  kind?: "capability" | "action";
  /** 선언형 기여. 종류별 항목 배열 + 이 빌드가 모르는 종류 이름(`unknownKinds`). */
  contributes?: {
    inlinePatterns?: Record<string, unknown>[];
    completions?: Record<string, unknown>[];
    blockEmbeds?: Record<string, unknown>[];
    windowControls?: string[];
    translations?: Record<string, unknown>[];
    unknownKinds?: string[];
  };
}

/** `parseManifest`의 반환 유니온 — manifest.ts와 동일 형태. */
export type ParseManifestResult =
  { ok: true; manifest: ParsedPluginManifest } | { ok: false; error: string };

/** CLI가 실제로 재사용하는 호스트 심볼의 집합. 전부 `src/plugin/*.ts`에서 그대로 로드한
 * 실물이다 — 아래 타입은 "이 CLI가 그중 무엇을 쓰는지"의 계약일 뿐, 규칙 자체가 아니다. */
export interface HostContract {
  parseManifest: (raw: unknown) => ParseManifestResult;
  /** host.ts `CALL_PERMISSIONS` 그대로. */
  callPermissions: Readonly<Record<string, string>>;
  isKnownCall: (call: string) => boolean;
  isReservedCall: (call: string) => boolean;
  /**
   * host.ts `removedCallHint` 그대로 — 없어진 호출이면 마이그레이션 안내, 아니면 undefined.
   *
   * `isReservedCall`과 같은 이유로 계약에 싣는다: "이 이름을 어떻게 판정하는가"의 정본이
   * host.ts 하나여야 한다. 없으면 lint가 옛 이름에 "오타이거나 아직 없는 API"라는 **틀린**
   * 추측을 주고, 저작자는 앱을 띄워 진단 채널을 열어 봐야만 옮길 곳을 알게 된다.
   */
  removedCallHint: (call: string) => string | undefined;
  /** host.ts `CAPABILITY_CALLS` 그대로 — `kind: "capability"`만 부를 수 있는 등록. */
  capabilityCalls: ReadonlySet<string>;
  /** host.ts `NO_PERMISSION_CALLS` 그대로 — 권한 게이트를 안 타는 진단·조회 호출. */
  noPermissionCalls: ReadonlySet<string>;
  requiredPermissionFor: (call: string) => string | null;
  /** permissions.ts `permissionToCalls` 그대로 — 권한→호출 역인덱스를 CLI가
   * 다시 만들지 않는다. */
  permissionToCalls: (
    callPermissions: Readonly<Record<string, string>>,
  ) => Record<string, string[]>;
  /**
   * manifest.ts `CONTRIBUTION_CALLS` 그대로 — 기여 종류 → 그것이 대신하는 브리지 호출.
   *
   * CLI가 이 표를 읽어야 선언형 기여도 명령형 등록과 **같은 규칙**으로 검사된다(권한·kind·
   * 형식). 안 읽으면 `contributes`만 쓰는 플러그인이 무조건 「문제 없음」을 받는다 — 웨이브
   * A에서 정확히 그 모양의 발견이 나왔다("CLI가 새 계약을 모르면 문제 없음이 거짓말이 된다").
   */
  contributionCalls: Readonly<Record<string, string>>;
  /**
   * manifest.ts `CONTRIBUTION_KINDS` 그대로 — 매니페스트가 선언할 수 있는 기여 종류 **전부**.
   *
   * `contributionCalls`의 키보다 넓다: 브리지 호출이 없는 기여(언어팩)가 있기 때문이다.
   * "모르는 기여 종류" 진단이 저작자에게 보여 주는 「가능한 값」 목록이 이 어휘여야 한다 —
   * 좁은 쪽을 쓰면 정상 언어팩 저작자에게 "translations는 없는 이름"이라고 말하게 된다.
   */
  contributionKinds: readonly string[];
  /**
   * manifest.ts `CORE_CONTRIBUTION_PERMISSIONS` 그대로 — 브리지 호출이 없는 기여 →
   * 그 기여가 요구하는 권한.
   *
   * CLI가 이 표를 읽어야 언어팩 매니페스트가 **설치 전에** 같은 게이트를 받는다: `i18n` 권한
   * 미선언은 오류이고, 선언했다면 "안 쓰는 권한" 오탐이 나지 않아야 한다. 코어(Rust)의
   * 수집 게이트가 이 조건을 실제로 강제하므로, 여기서 안 잡으면 저작자는 "설치는 됐는데
   * 언어가 목록에 안 뜬다"는 무음 실패를 만난다.
   */
  coreContributionPermissions: Readonly<Record<string, string>>;
  /**
   * loader.ts `makeRegistrar` 그대로 — 기여 항목의 **형식 검증**을 실물 수집기로 돌린다.
   *
   * 규칙을 CLI에 옮겨 적지 않는 이유는 이 파일 전체의 이유와 같다: 사본은 반드시 갈라진다.
   */
  makeRegistrar: (pluginId?: string) => {
    execute: (call: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  /**
   * loader.ts `parseWhenClause` 그대로 — `when`의 닫힌 키 어휘 판정.
   *
   * `opts.menu`: 메뉴 항목(`ui.addMenuItem`)의 `when`은 창 상태 두 키만 받는다 —
   * 정적 키(`platform`·`plugin.enabled`·`settings`)는 렌더 시점의 노트 창이 판정할 수 없어
   * 거부한다. CLI가 이 옵션을 넘겨야 호스트와 **같은 판정**을 써서 "린트는 통과인데 앱은
   * 거부"가 생기지 않는다.
   */
  parseWhenClause: (
    raw: unknown,
    settingKeys: readonly string[],
    opts?: { menu?: boolean },
  ) => { ok: true } | { ok: false; error: string };
  /**
   * host-protocol.ts `MEMO_EVENT_NAMES`·`MEMO_EVENT_PERMISSION` 그대로.
   *
   * CLI가 이 어휘를 알아야 `memo.events.on({ name: "note:typed" })` 같은 오타를 앱을 띄우기
   * 전에 잡는다. 몰랐을 때는 「문제 없음」을 주는데 호스트는 `INVALID_ARGS`로 거부해, 구독이
   * 영영 안 불리는 이유를 저작자가 진단 채널에서만 찾을 수 있었다.
   *
   * 권한 표가 함께 필요한 이유: `events.on`의 `CALL_PERMISSIONS` 값(`settings`)은 **바닥**
   * 이고, `note:*`는 그 위에 `notes:read`를 더 요구한다(판정은 중앙 호스트가 이름별로
   * 좁혀서 한다). 바닥만 보면 `settings`만 선언한 플러그인의 `note:saved` 구독이 통과한다.
   */
  eventNames: readonly string[];
  eventPermission: Readonly<Record<string, string | null>>;
  /**
   * test-host.ts `loadPluginForTest` 그대로 — 매니페스트+코드를 헤드리스로 실행해
   * 등록·호출·거부를 관측한다. `run`/`test` 커맨드의 유일한 실행 경로다(신규 구현이 아니라
   * 노출 — "위험" 절: 하니스가 실제 호스트와 벌어지면
   * "통과했는데 앱에서는 실패"가 생기므로 CLI는 이 함수를 재구현하지 않고 그대로 부른다).
   */
  loadPluginForTest: (options: LoadPluginOptions) => Promise<HeadlessPlugin>;
  /** test-host.ts `loadPluginFromDir` 그대로 — 폴더(manifest.json + entry)를 읽어
   * 헤드리스로 실행한다. `run`/`test` 커맨드가 받는 `<dir>`을 그대로 넘긴다. */
  loadPluginFromDir: (
    dir: string,
    overrides?: Partial<Omit<LoadPluginOptions, "manifest" | "code">>,
  ) => Promise<HeadlessPlugin>;
}

/** `startDir`에서 위로 올라가며 `package.json`이 있는 첫 디렉터리(저장소 루트)를 찾는다. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `저장소 루트(package.json)를 찾을 수 없음 — 탐색 시작 지점: ${startDir}`,
      );
    }
    dir = parent;
  }
}

/**
 * 호스트 계약을 로드한다. 반환된 `close()`를 반드시 호출해야 Vite dev 서버가 정리되고
 * 프로세스가 자연 종료된다(CLI 명령 실행이 끝나는 `finally`에서 호출).
 */
export async function loadHostContract(): Promise<{
  contract: HostContract;
  close: () => Promise<void>;
}> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const server = await createServer({
    root: repoRoot,
    // 앱용 vite.config.ts(고정 포트·HMR 등)는 미들웨어 모드 SSR 로딩에 필요 없다 — 이 CLI는
    // 별칭도 플러그인도 안 쓰므로 기본 해석만으로 충분하고, 로딩 안 하는 편이 더 빠르고
    // 앱 설정 변경에 CLI가 엮이지 않는다.
    configFile: false,
    server: { middlewareMode: true },
    logLevel: "silent",
  });
  try {
    const manifestMod = await server.ssrLoadModule("/src/plugin/manifest.ts");
    const hostMod = await server.ssrLoadModule("/src/plugin/host.ts");
    const permissionsMod = await server.ssrLoadModule(
      "/src/plugin/permissions.ts",
    );
    const loaderMod = await server.ssrLoadModule("/src/plugin/loader.ts");
    const protocolMod = await server.ssrLoadModule(
      "/src/plugin/host-protocol.ts",
    );
    const testHostMod = await server.ssrLoadModule("/src/plugin/test-host.ts");
    const contract: HostContract = {
      eventNames: protocolMod.MEMO_EVENT_NAMES,
      eventPermission: protocolMod.MEMO_EVENT_PERMISSION,
      loadPluginForTest: testHostMod.loadPluginForTest,
      loadPluginFromDir: testHostMod.loadPluginFromDir,
      contributionCalls: manifestMod.CONTRIBUTION_CALLS,
      contributionKinds: manifestMod.CONTRIBUTION_KINDS,
      coreContributionPermissions: manifestMod.CORE_CONTRIBUTION_PERMISSIONS,
      makeRegistrar: loaderMod.makeRegistrar,
      parseWhenClause: loaderMod.parseWhenClause,
      parseManifest: manifestMod.parseManifest,
      callPermissions: hostMod.CALL_PERMISSIONS,
      isKnownCall: hostMod.isKnownCall,
      isReservedCall: hostMod.isReservedCall,
      removedCallHint: hostMod.removedCallHint,
      capabilityCalls: hostMod.CAPABILITY_CALLS,
      noPermissionCalls: hostMod.NO_PERMISSION_CALLS,
      requiredPermissionFor: hostMod.requiredPermissionFor,
      permissionToCalls: permissionsMod.permissionToCalls,
    };
    return { contract, close: () => server.close() };
  } catch (e) {
    await server.close();
    throw e;
  }
}
