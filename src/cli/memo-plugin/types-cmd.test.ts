/**
 * types-cmd.ts 통합 테스트 — `runTypes`가 실제 저작 폴더에 대해 plugin-api.d.ts 복사·
 * settings.d.ts 생성·main.js 참조 주석 삽입을 실제로 하는지, 그리고 idempotent한지(변경
 * 없으면 다시 안 씀) 확인한다. validate.ts의 신선도 경고(SETTINGS_DTS_STALE 등)도 여기서
 * 함께 검증한다 — 생성기와 그 결과를 소비하는 검사기가 실제로 맞물리는지가 핵심이다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHostContract, type HostContract } from "./host-bridge";
import { runValidate } from "./validate";
import { runTypes, REFERENCE_LINE } from "./types-cmd";
import { apiDtsPath } from "./repo-paths";

let contract: HostContract;
let close: () => Promise<void>;
const tmpDirs: string[] = [];

beforeAll(async () => {
  const loaded = await loadHostContract();
  contract = loaded.contract;
  close = loaded.close;
}, 30_000);

afterAll(async () => {
  await close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makePlugin(
  id: string,
  settings: unknown[] | undefined,
  code: string,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-types-"));
  tmpDirs.push(dir);
  const manifest: Record<string, unknown> = {
    id,
    name: id,
    version: "1.0.0",
    entry: "main.js",
    permissions: ["ui"],
  };
  if (settings !== undefined) manifest.settings = settings;
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "main.js"), code);
  return dir;
}

describe("runTypes", () => {
  it("plugin-api.d.ts를 저장소 원본과 바이트 동일하게 복사한다", async () => {
    const dir = makePlugin(
      "types-a",
      undefined,
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const result = await runTypes(dir, contract);
    expect(result.wrote).toContain("plugin-api.d.ts");
    const copied = readFileSync(path.join(dir, "plugin-api.d.ts"), "utf8");
    const original = readFileSync(apiDtsPath(), "utf8");
    expect(copied).toBe(original);
  });

  it("plugin-manifest.schema.json도 복사한다", async () => {
    const dir = makePlugin(
      "types-b",
      undefined,
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const result = await runTypes(dir, contract);
    expect(result.wrote).toContain("plugin-manifest.schema.json");
    expect(existsSync(path.join(dir, "plugin-manifest.schema.json"))).toBe(
      true,
    );
  });

  it("main.js 첫 줄에 참조 주석을 넣는다(이미 있으면 다시 안 넣는다)", async () => {
    const dir = makePlugin(
      "types-c",
      undefined,
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    await runTypes(dir, contract);
    const first = readFileSync(path.join(dir, "main.js"), "utf8");
    expect(first.startsWith(REFERENCE_LINE)).toBe(true);

    const second = await runTypes(dir, contract);
    expect(second.wrote.some((w) => w.includes("참조 주석"))).toBe(false);
  });

  it("settings가 있으면 settings.d.ts를 만들고, 없으면 안 만든다", async () => {
    const withSettings = makePlugin(
      "types-d",
      [{ key: "prefix", label: "접두", type: "text" }],
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const r1 = await runTypes(withSettings, contract);
    expect(r1.wrote).toContain("settings.d.ts");

    const noSettings = makePlugin(
      "types-e",
      undefined,
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const r2 = await runTypes(noSettings, contract);
    expect(r2.wrote).not.toContain("settings.d.ts");
    expect(existsSync(path.join(noSettings, "settings.d.ts"))).toBe(false);
  });

  it("변경이 없으면 다시 쓰지 않는다(idempotent)", async () => {
    const dir = makePlugin(
      "types-f",
      [{ key: "prefix", label: "접두", type: "text" }],
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const r1 = await runTypes(dir, contract);
    expect(r1.wrote.length).toBeGreaterThan(0);
    const r2 = await runTypes(dir, contract);
    expect(r2.wrote).toEqual([]);
  });

  it("매니페스트가 깨지면 아무것도 안 쓰고 validate 오류만 돌려준다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-types-broken-"));
    tmpDirs.push(dir);
    const result = await runTypes(dir, contract);
    expect(result.wrote).toEqual([]);
    expect(result.findings.some((f) => f.code === "MANIFEST_MISSING")).toBe(
      true,
    );
  });
});

describe("validate — 생성물 신선도 경고(3항)", () => {
  it("settings.d.ts가 manifest의 settings와 달라지면 SETTINGS_DTS_STALE을 경고한다", async () => {
    const dir = makePlugin(
      "stale-a",
      [{ key: "prefix", label: "접두", type: "text" }],
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    await runTypes(dir, contract);
    const before = await runValidate(dir, contract);
    expect(before.findings.some((f) => f.code === "SETTINGS_DTS_STALE")).toBe(
      false,
    );

    // 매니페스트만 바꾸고 settings.d.ts는 그대로 둔다 — 이제 어긋난다.
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.settings[0].label = "바뀐 라벨";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const after = await runValidate(dir, contract);
    expect(after.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SETTINGS_DTS_STALE" }),
      ]),
    );
  });

  it("settings.d.ts는 있는데 settings 필드가 전부 사라지면 SETTINGS_DTS_ORPHANED를 경고한다", async () => {
    const dir = makePlugin(
      "stale-b",
      [{ key: "prefix", label: "접두", type: "text" }],
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    await runTypes(dir, contract);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.settings;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await runValidate(dir, contract);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SETTINGS_DTS_ORPHANED" }),
      ]),
    );
  });

  it("settings.d.ts·plugin-api.d.ts가 없으면 신선도 경고 자체가 없다(동봉은 선택)", async () => {
    const dir = makePlugin(
      "no-dts",
      undefined,
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const result = await runValidate(dir, contract);
    expect(
      result.findings.some((f) =>
        [
          "SETTINGS_DTS_STALE",
          "SETTINGS_DTS_ORPHANED",
          "PLUGIN_API_DTS_STALE",
        ].includes(f.code),
      ),
    ).toBe(false);
  });
});
