/**
 * memo-plugin CLI(types) — `types <dir>`: 저작 폴더에 타입 선언을 동봉한다.
 *
 * 하는 일 셋(전부 순수 생성물 — 검증 규칙을 손으로 옮겨 적지 않는다):
 *  1. `docs/plugin/api-reference.d.ts`(`api-index.ts`에서 생성한 최신본)를 폴더에 그대로 복사한다.
 *  2. `docs/plugin/manifest.schema.json`(정본)을 복사한다 — 매니페스트의
 *     `"$schema": "./plugin-manifest.schema.json"`이 가리키는 실제 파일이 폴더 안에
 *     있어야 편집기가 "도달 가능한 경로"로 읽는다(authoring.md 62행).
 *  3. 매니페스트 `settings[]`에서 `settings.d.ts`를 생성한다(settings-types.ts).
 *     설정 스키마가 없거나 `button` 필드뿐이면(값을 저장하지 않는다) 만들지 않는다.
 *  4. entry 파일(main.js) 첫 줄에 `/// <reference path="./plugin-api.d.ts" />`를 넣는다
 *     (이미 있으면 건드리지 않는다 — 저작자가 다른 참조 방식을 골랐을 수 있다).
 *
 * `scaffold.ts`도 새로 만든 폴더에 이 함수를 그대로 불러 쓴다 — "생성 직후 타입까지 갖춘
 * 상태"가 scaffold와 types 두 명령의 공통 경로가 되어야 둘이 갈라지지 않는다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginSettingField } from "../../shared/tauri.ts";
import type { HostContract } from "./host-bridge.ts";
import type { Finding } from "./types.ts";
import { runValidate } from "./validate.ts";
import {
  generateSettingsDts,
  hasTypedSettingsFields,
} from "./settings-types.ts";
import { apiDtsPath, manifestSchemaPath } from "./repo-paths.ts";

export const REFERENCE_LINE = '/// <reference path="./plugin-api.d.ts" />';

interface TypesResult {
  findings: Finding[];
  /** 실제로 새로 쓰거나 갱신한 파일(플러그인 폴더 기준 상대 경로). 변경이 없었던 파일은
   * 안 실린다 — "무엇을 했는지"만 보고하지 "무엇을 확인했는지"까지 늘어놓지 않는다. */
  wrote: string[];
}

/** 파일이 없거나 내용이 다를 때만 쓴다(불필요한 mtime 변경 방지) — 존재+동일이면 조용히
 * 넘어간다. 실제로 썼으면 true. */
function writeIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) {
    return false;
  }
  writeFileSync(filePath, content, "utf8");
  return true;
}

/** 파일이 없거나 원본과 바이트가 다를 때만 복사한다. 원본이 없으면 아무 일도 하지 않고
 * false(호출자가 진단을 남긴다 — 저장소 밖에서 실행됐을 수 있다). */
function copyIfChanged(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  const content = readFileSync(src, "utf8");
  return writeIfChanged(dest, content);
}

export async function runTypes(
  pluginDir: string,
  contract: HostContract,
): Promise<TypesResult> {
  const { findings, manifest } = await runValidate(pluginDir, contract);
  if (manifest === undefined) {
    return { findings, wrote: [] };
  }
  const wrote: string[] = [];

  const apiSrc = apiDtsPath();
  if (copyIfChanged(apiSrc, path.join(pluginDir, "plugin-api.d.ts"))) {
    wrote.push("plugin-api.d.ts");
  } else if (!existsSync(apiSrc)) {
    findings.push({
      severity: "warn",
      code: "API_DTS_SOURCE_MISSING",
      message: `${apiSrc}를 찾을 수 없어 plugin-api.d.ts를 복사하지 못함 — 이 CLI를 memo 저장소 안에서 실행했는지 확인하라`,
    });
  }

  const schemaSrc = manifestSchemaPath();
  if (
    copyIfChanged(
      schemaSrc,
      path.join(pluginDir, "plugin-manifest.schema.json"),
    )
  ) {
    wrote.push("plugin-manifest.schema.json");
  } else if (!existsSync(schemaSrc)) {
    findings.push({
      severity: "warn",
      code: "SCHEMA_SOURCE_MISSING",
      message: `${schemaSrc}를 찾을 수 없어 plugin-manifest.schema.json을 복사하지 못함`,
    });
  }

  // settings.d.ts는 validate가 이미 구조 검증을 마친 manifest.json을 **원문 그대로 다시**
  // 읽어 만든다 — host-bridge의 ParsedPluginManifest는 CLI가 실제로 쓰는 필드(key/type/
  // command)만 덕타이핑하므로 타입 유도에 필요한 label/options/default 등이 없다. 이미
  // parseManifest를 통과한 파일이라 재검증 없이 필드만 뽑아 쓰는 것이 안전하다.
  const rawManifest = JSON.parse(
    readFileSync(path.join(pluginDir, "manifest.json"), "utf8"),
  ) as { settings?: PluginSettingField[] };
  const settingsFields = rawManifest.settings ?? [];
  if (hasTypedSettingsFields(settingsFields)) {
    const dts = generateSettingsDts(settingsFields);
    if (writeIfChanged(path.join(pluginDir, "settings.d.ts"), dts)) {
      wrote.push("settings.d.ts");
    }
  }

  const entryPath = path.join(pluginDir, manifest.entry);
  const src = readFileSync(entryPath, "utf8");
  if (!src.includes(REFERENCE_LINE)) {
    writeFileSync(entryPath, `${REFERENCE_LINE}\n${src}`, "utf8");
    wrote.push(`${manifest.entry}(참조 주석 추가)`);
  }

  return { findings, wrote };
}
