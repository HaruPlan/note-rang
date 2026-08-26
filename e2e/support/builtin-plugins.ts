import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 역할: e2e가 참조하는 "번들 플러그인 개수"의 단일 출처. `src/plugin/builtin/index.ts`는
// Vite `import.meta.glob`로 폴더를 모으는데, Playwright는 앱 밖 Node 환경이라 그 모듈을
// 그대로 import할 수 없다 — 그래서 같은 폴더 구조를 node:fs로 직접 읽어 개수를 유도한다
// (번들 폴더를 더하거나 지울 때 이 파일도, 스펙의 하드코딩 숫자도 고칠 필요가 없다).
// 왜: 번들 개수를 assertion에 하드코딩하면 번들이 늘거나 줄 때마다 세 스펙이 동시에 썩는다.
//
// OS 필터를 **일부러 넣지 않는다**: 이 값을 대조하는 세 assertion이 전부 OS와 무관하다.
// (1) 설정 번들 탭의 `.plugin-enable-toggle`은 `renderBuiltinList`가 **모든** 번들에 대해
//     만든다 — 미지원 OS의 번들도 `disabled` 토글로 렌더된다(회색 처리만 다르다).
// (2) 샌드박스 iframe 개수도 e2e에서는 걸러지지 않는다 — 목은 등록하지 않은 커맨드에 null을
//     주고(`get_platform` 미등록), `isSupportedOnPlatform`은 OS 미상이면 제한하지 않는다.
// 즉 `process.platform`(Playwright를 돌리는 호스트 OS)으로 거르면, macOS 전용 번들이 있는
// 한 Linux/Windows에서만 값이 어긋나 세 스펙이 거짓 실패한다. 정말로 OS별 개수를 검증하고
// 싶다면 먼저 목에 `get_platform`을 명시해(toolbar-layout.spec.ts처럼) 앱이 보는 OS부터
// 고정해야 한다.

// 이 저장소는 ESM("type": "module")이라 `__dirname`이 없다 — 모듈 URL에서 유도한다
// (Playwright가 이 파일을 ESM으로 로드하므로 CJS 전역을 참조하면 임포트 시점에 터진다).
const HERE = fileURLToPath(new URL(".", import.meta.url));

const BUILTIN_ROOT = join(HERE, "..", "..", "src", "plugin", "builtin");

/** 폴더 하나 아래의 하위 디렉터리 개수(= 그 종류의 번들 개수). */
function dirCount(root: string): number {
  return readdirSync(root, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  ).length;
}

/**
 * 번들 **플러그인** 폴더 개수(테마·언어팩 제외) — 중앙 호스트가 실제로 **실행하는** 번들의
 * 수와 같다(샌드박스 iframe 개수 assertion이 이 값을 쓴다).
 */
export function bundledPluginCount(): number {
  return dirCount(join(BUILTIN_ROOT, "plugins"));
}

/**
 * 번들 **언어팩** 폴더 개수 — 설정창 번들 목록에는 토글 행으로 함께 뜨지만, 중앙 호스트가
 * **실행하지는 않는다**(선언형 데이터라 `main.js`가 공백뿐이고 샌드박스가 뜨지 않는다).
 *
 * 그래서 [`bundledPluginCount`]와 **일부러 분리**한다: 목록 행 수를 세는 곳은 둘을 더해야
 * 맞고, 샌드박스 iframe 수를 세는 곳(csp·plugin-host 스펙)은 더하면 안 된다.
 */
export function bundledLanguagePackCount(): number {
  return dirCount(join(BUILTIN_ROOT, "language-packs"));
}
