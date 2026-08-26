/**
 * memo-plugin CLI — `validate <dir>`: 매니페스트가 구조적으로 유효한지 검사한다.
 *
 * 역할: manifest.json을 읽어 JSON 파싱 → `src/plugin/manifest.ts`의 실물 `parseManifest`로
 * 검증(스키마와 동형 — TS 검증기 자체가 그 스키마의 런타임 구현이므로 이것이 곧
 * "스키마 재사용"이다, host-bridge.ts 참고) → entry 파일 실존 여부 → id/폴더명 일치까지
 * 확인한다. 권한 이름 검증은 `parseManifest` 내부(`isKnownPermission`)에 이미 있으므로
 * 여기서 다시 만들지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HostContract, ParsedPluginManifest } from "./host-bridge.ts";
import type { Finding } from "./types.ts";
import type { PluginSettingField } from "../../shared/tauri.ts";
import {
  generateSettingsDts,
  hasTypedSettingsFields,
} from "./settings-types.ts";
import { apiDtsPath } from "./repo-paths.ts";

/** validate 성공 시 lint.ts가 이어서 쓸 수 있도록 파싱된 매니페스트도 함께 돌려준다. */
interface ValidateResult {
  findings: Finding[];
  /** 구조적으로 유효한 매니페스트를 얻었을 때만 존재(치명적 오류가 있으면 undefined). */
  manifest?: ParsedPluginManifest;
}

export async function runValidate(
  pluginDir: string,
  contract: HostContract,
): Promise<ValidateResult> {
  const findings: Finding[] = [];
  const manifestPath = path.join(pluginDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    findings.push({
      severity: "error",
      code: "MANIFEST_MISSING",
      message: `manifest.json이 없음: ${manifestPath}`,
    });
    return { findings };
  }

  const raw = readFileSync(manifestPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    findings.push({
      severity: "error",
      code: "MANIFEST_JSON_INVALID",
      message: `manifest.json이 유효한 JSON이 아님: ${e instanceof Error ? e.message : String(e)}`,
      file: "manifest.json",
    });
    return { findings };
  }

  const result = contract.parseManifest(parsedJson);
  if (!result.ok) {
    findings.push({
      severity: "error",
      code: "MANIFEST_INVALID",
      message: result.error,
      file: "manifest.json",
    });
    return { findings };
  }
  const manifest = result.manifest;

  const entryPath = path.join(pluginDir, manifest.entry);
  if (!existsSync(entryPath)) {
    findings.push({
      severity: "error",
      code: "ENTRY_MISSING",
      message: `entry로 선언한 파일이 폴더에 없음: ${manifest.entry}`,
      file: "manifest.json",
    });
  }

  // 스키마 설명: "설치 디렉터리 이름과 일치해야 한다". 강제 규칙이 아니라 관행이므로
  // warn — 사이드로드 배포에서 폴더명이 달라도 오늘은 동작하지만, 나중에 id 충돌 진단이나
  // 자동 갱신 매칭에서 혼동의 씨앗이 된다.
  const dirName = path.basename(pluginDir);
  if (manifest.id !== dirName) {
    findings.push({
      severity: "warn",
      code: "ID_DIR_MISMATCH",
      message: `매니페스트 id('${manifest.id}')가 폴더명('${dirName}')과 다름`,
      file: "manifest.json",
    });
  }

  checkGeneratedFilesFresh(pluginDir, parsedJson, findings);

  return { findings, manifest };
}

/**
 * memo-plugin types가 낸 생성물이 지금의 매니페스트·저장소 계약과 여전히 같은지
 * 확인한다(3항: "재생성 결과와 다르면 경고"). **error가 아니라 warn이다** — 파일이
 * 낡아도 플러그인 자체는 여전히 동작한다(런타임은 이 파일들을 안 읽는다), 낡아지는 것은
 * 편집기 자동완성·오타 검출뿐이다. 두 파일 다 저작자 폴더에 없으면(애초에 types를 안
 * 돌렸다면) 아무 것도 하지 않는다 — 동봉은 선택이라 없는 것 자체는 문제가 아니다.
 *
 * 저장소 경로 해석이 실패할 수 있는 실행 환경(이 CLI 파일 자체가 저장소 밖으로 옮겨진 경우
 * 등)에서는 조용히 건너뛴다 — 신선도 확인은 부가 기능이지 validate의 핵심 계약이 아니다.
 */
function checkGeneratedFilesFresh(
  pluginDir: string,
  rawManifest: unknown,
  findings: Finding[],
): void {
  const settingsDtsPath = path.join(pluginDir, "settings.d.ts");
  if (existsSync(settingsDtsPath)) {
    const settingsFields =
      (rawManifest as { settings?: PluginSettingField[] } | null)?.settings ??
      [];
    if (!hasTypedSettingsFields(settingsFields)) {
      findings.push({
        severity: "warn",
        code: "SETTINGS_DTS_ORPHANED",
        message:
          "settings.d.ts가 있지만 manifest.json에는 타입을 낼 설정 필드가 없음(모두 button이거나 settings가 비어 있음) — 지워도 된다",
        file: "settings.d.ts",
      });
    } else {
      const expected = generateSettingsDts(settingsFields);
      const actual = readFileSync(settingsDtsPath, "utf8");
      if (actual !== expected) {
        findings.push({
          severity: "warn",
          code: "SETTINGS_DTS_STALE",
          message: `settings.d.ts가 manifest.json의 settings 스키마와 다름 — 다시 내라: npm run plugin -- types ${pluginDir}`,
          file: "settings.d.ts",
        });
      }
    }
  }

  const localApiDts = path.join(pluginDir, "plugin-api.d.ts");
  if (existsSync(localApiDts)) {
    try {
      const src = apiDtsPath();
      if (existsSync(src)) {
        const expected = readFileSync(src, "utf8");
        const actual = readFileSync(localApiDts, "utf8");
        if (actual !== expected) {
          findings.push({
            severity: "warn",
            code: "PLUGIN_API_DTS_STALE",
            message: `plugin-api.d.ts가 저장소의 최신 계약(docs/plugin/api-reference.d.ts)과 다름 — 다시 내라: npm run plugin -- types ${pluginDir}`,
            file: "plugin-api.d.ts",
          });
        }
      }
    } catch {
      // 저장소 루트를 못 찾음(이 CLI가 저장소 밖에서 실행됨 등) — 신선도는 부가 기능이라
      // 조용히 건너뛴다. plugin-api.d.ts 자체의 유효성은 이 검사의 책임이 아니다.
    }
  }
}
