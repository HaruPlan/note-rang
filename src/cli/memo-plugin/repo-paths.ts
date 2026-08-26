/**
 * memo-plugin CLI — 저장소 안의 생성물 경로를 찾는 작은 파일 유틸리티.
 *
 * 역할: `scaffold`/`types`가 복사해 오는 두 생성물(`docs/plugin/api-reference.d.ts` ·
 * `docs/plugin/manifest.schema.json`)의 절대 경로를 구한다. 둘 다 **파일을
 * 그대로 복사**하는 용도일 뿐, 그 안의 내용(검증 규칙·API 계약)을 다시 옮겨 적지 않는다 —
 * "생성물 위치를 찾는 것"과 "생성물의 내용을 다시 구현하는 것"은 다른 일이다. 후자를
 * `host-bridge.ts`가 이미 Vite SSR 로딩으로 하고 있으므로 여기서 반복하지 않는다.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `startDir`에서 위로 올라가며 `package.json`이 있는 첫 디렉터리(저장소 루트)를 찾는다.
 * host-bridge.ts `findRepoRoot`와 같은 방법이지만 그 함수는 export되지 않는다(그 파일의
 * 소유 범위 밖) — 10줄짜리 디렉터리 탐색이라 사본을 두는 비용이 새 의존을 들이는 비용보다
 * 낮다. 검증 규칙이 아니라 순수 파일시스템 유틸리티라 "규칙 드리프트"의 대상이 아니다. */
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

/** 이 모듈 파일 기준 저장소 루트. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return findRepoRoot(here);
}

/** 생성되는 앰비언트 타입 선언 파일의 절대 경로. */
export function apiDtsPath(): string {
  return path.join(repoRoot(), "docs", "plugin", "api-reference.d.ts");
}

/** 매니페스트 JSON Schema 정본의 절대 경로. */
export function manifestSchemaPath(): string {
  return path.join(repoRoot(), "docs", "plugin", "manifest.schema.json");
}
