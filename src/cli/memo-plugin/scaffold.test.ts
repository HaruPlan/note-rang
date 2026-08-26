/**
 * scaffold.ts(2단계) 통합 테스트 — 실물 `loadHostContract`로 4개 템플릿 전부가
 * (1) 디스크에 실제로 파일을 내고 (2) `contract.parseManifest`(실물 검증기)를 통과하며
 * (3) `runScaffold`의 자기검증 단계(runLint 재사용)가 오류·경고 0건을 낸다는 것을 확인한다.
 *
 * 왜 mock이 아니라 실물인가: cli.test.ts와 같은 이유(host-bridge.ts 문서 참고) — "생성물이
 * 즉시 validate/lint를 통과한다"는 이 항목의 핵심 주장이라, mock 검증기로는 그 주장 자체를
 * 검증하지 못한다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHostContract, type HostContract } from "./host-bridge";
import {
  runScaffold,
  SCAFFOLD_TEMPLATES,
  isScaffoldTemplate,
  type ScaffoldTemplate,
} from "./scaffold";

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

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-scaffold-"));
  tmpDirs.push(dir);
  return dir;
}

describe("isScaffoldTemplate", () => {
  it("4종 전부 인정한다", () => {
    for (const t of SCAFFOLD_TEMPLATES)
      expect(isScaffoldTemplate(t)).toBe(true);
  });

  it("모르는 이름은 거부한다", () => {
    expect(isScaffoldTemplate("nope")).toBe(false);
  });
});

describe.each(SCAFFOLD_TEMPLATES)("runScaffold — 템플릿 %s", (template) => {
  it("파일 3종을 내고 스스로 확인(validate+lint)에서 오류·경고 0건", async () => {
    const parent = freshDir();
    const id = `scaffold-${template}`;
    const outDir = path.join(parent, id);
    const result = await runScaffold(id, { template, outDir }, contract);

    expect(result.findings).toEqual([]);
    expect(result.wrote).toEqual(
      expect.arrayContaining(["manifest.json", "main.js", "README.md"]),
    );
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "main.js"))).toBe(true);
    expect(existsSync(path.join(outDir, "README.md"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    );
    expect(manifest.id).toBe(id);
    expect(manifest.entry).toBe("main.js");
    // minHostVersion은 **일부러 넣지 않는다**(scaffold.ts 주석 참고): since 메타·버전 정책이
    // 아직 없어 자동 계산할 근거가 없다. 문서(authoring)가 이 부재를 명시하므로, 여기서
    // 못박아 "문서는 비워 둔다는데 코드가 채운다(또는 그 반대)"의 조용한 드리프트를 막는다.
    expect(manifest.minHostVersion).toBeUndefined();
    const parsed = contract.parseManifest(manifest);
    expect(parsed.ok).toBe(true);
  });

  it("기본으로 타입 생성물을 동봉한다(plugin-api.d.ts + main.js 참조 주석)", async () => {
    const parent = freshDir();
    const id = `scaffold-types-${template}`;
    const outDir = path.join(parent, id);
    const result = await runScaffold(id, { template, outDir }, contract);

    expect(result.wrote).toContain("plugin-api.d.ts");
    expect(existsSync(path.join(outDir, "plugin-api.d.ts"))).toBe(true);
    const mainJs = readFileSync(path.join(outDir, "main.js"), "utf8");
    expect(
      mainJs.startsWith('/// <reference path="./plugin-api.d.ts" />'),
    ).toBe(true);
  });
});

it("settings-driven 템플릿만 settings.d.ts를 낸다(text+select 필드가 있어서)", async () => {
  const parent = freshDir();
  const withSettings = path.join(parent, "with-settings");
  const r1 = await runScaffold(
    "with-settings",
    { template: "settings-driven", outDir: withSettings },
    contract,
  );
  expect(r1.wrote).toContain("settings.d.ts");
  const dts = readFileSync(path.join(withSettings, "settings.d.ts"), "utf8");
  expect(dts).toContain("export interface PluginSettings");
  expect(dts).toContain('style: "formal" | "casual";');

  const noSettings = path.join(parent, "no-settings");
  const r2 = await runScaffold(
    "no-settings",
    { template: "command", outDir: noSettings },
    contract,
  );
  expect(r2.wrote).not.toContain("settings.d.ts");
  expect(existsSync(path.join(noSettings, "settings.d.ts"))).toBe(false);
});

it("--no-types(withTypes:false)는 타입 생성물·참조 주석을 건너뛴다", async () => {
  const parent = freshDir();
  const outDir = path.join(parent, "no-types-demo");
  const result = await runScaffold(
    "no-types-demo",
    { template: "toolbar-button", outDir, withTypes: false },
    contract,
  );
  expect(result.findings).toEqual([]);
  expect(existsSync(path.join(outDir, "plugin-api.d.ts"))).toBe(false);
  const mainJs = readFileSync(path.join(outDir, "main.js"), "utf8");
  expect(mainJs.startsWith("/// <reference")).toBe(false);
});

it("--name을 주면 manifest.json의 name에 실린다(생략하면 id를 그대로 쓴다)", async () => {
  const parent = freshDir();
  const outDir = path.join(parent, "named");
  await runScaffold(
    "named",
    { template: "command", outDir, name: "표시 이름" },
    contract,
  );
  const manifest = JSON.parse(
    readFileSync(path.join(outDir, "manifest.json"), "utf8"),
  );
  expect(manifest.name).toBe("표시 이름");
});

it("모르는 템플릿은 디스크에 아무것도 안 남기고 오류를 낸다", async () => {
  const parent = freshDir();
  const outDir = path.join(parent, "bad-template");
  const result = await runScaffold(
    "bad-template",
    { template: "nope" as ScaffoldTemplate, outDir },
    contract,
  );
  expect(result.findings).toEqual([
    expect.objectContaining({ severity: "error", code: "UNKNOWN_TEMPLATE" }),
  ]);
  expect(existsSync(outDir)).toBe(false);
});

it("id가 매니페스트 형식(소문자·숫자·._-)을 어기면 디스크에 아무것도 안 남기고 오류를 낸다", async () => {
  const parent = freshDir();
  const outDir = path.join(parent, "bad-id-dir");
  const result = await runScaffold(
    "Not A Valid Id!",
    { template: "command", outDir },
    contract,
  );
  expect(result.findings).toEqual([
    expect.objectContaining({ severity: "error", code: "MANIFEST_INVALID" }),
  ]);
  expect(existsSync(outDir)).toBe(false);
});

it("출력 폴더가 이미 있고 비어 있지 않으면 --force 없이는 거부한다", async () => {
  const outDir = freshDir();
  writeFileSync(path.join(outDir, "keep-me.txt"), "선주민 파일");
  const result = await runScaffold(
    "clash",
    { template: "command", outDir },
    contract,
  );
  expect(result.findings).toEqual([
    expect.objectContaining({
      severity: "error",
      code: "OUTPUT_DIR_NOT_EMPTY",
    }),
  ]);
  // 실패했으니 기존 파일이 그대로 있어야 한다(덮어쓰지 않았다).
  expect(existsSync(path.join(outDir, "keep-me.txt"))).toBe(true);
  expect(existsSync(path.join(outDir, "manifest.json"))).toBe(false);
});

it("--force면 비어 있지 않은 폴더에도 쓴다", async () => {
  const outDir = freshDir();
  writeFileSync(path.join(outDir, "keep-me.txt"), "선주민 파일");
  const result = await runScaffold(
    "clash-force",
    { template: "command", outDir, force: true },
    contract,
  );
  // freshDir()의 폴더명은 mkdtempSync가 무작위로 붙이므로 id와 다르다 — ID_DIR_MISMATCH
  // 경고 하나는 정상이다(이 테스트가 확인하려는 것은 그게 아니라 "썼다"는 사실).
  expect(result.findings).toEqual([
    expect.objectContaining({ code: "ID_DIR_MISMATCH" }),
  ]);
  expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);
});

it("이미 있는 빈 폴더에는 --force 없이도 쓴다(비어 있으면 충돌이 아니다)", async () => {
  const outDir = freshDir(); // mkdtempSync가 이미 빈 폴더를 만들어 둔다.
  const result = await runScaffold(
    "empty-ok",
    { template: "command", outDir },
    contract,
  );
  expect(result.findings).toEqual([
    expect.objectContaining({ code: "ID_DIR_MISMATCH" }),
  ]);
});

it("--dir 생략 시 기본 출력 경로는 상위 호출자가 정한다(scaffold.ts 자체는 outDir을 그대로 쓴다)", async () => {
  // runScaffold는 outDir을 필수로 받는다 — cli.ts가 "생략하면 ./<id>"를 계산해 넘긴다.
  // 이 테스트는 그 책임 분리를 문서화한다(scaffold.ts는 경로 계산을 모른다).
  const parent = freshDir();
  const outDir = path.join(parent, "id-matches-dir");
  mkdirSync(outDir);
  const result = await runScaffold(
    "id-matches-dir",
    { template: "command", outDir },
    contract,
  );
  expect(result.findings).toEqual([]); // 폴더명 === id라 ID_DIR_MISMATCH도 없다.
});
