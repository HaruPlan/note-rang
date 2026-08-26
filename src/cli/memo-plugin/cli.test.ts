/**
 * memo-plugin CLI 통합 테스트 — `loadHostContract`로 실제 앱 소스(manifest.ts·host.ts·
 * permissions.ts)를 로드해 `validate`/`lint`/`runCli`가 실물 규칙과 맞물려 동작하는지 확인한다.
 *
 * 왜 mock이 아니라 실물 로드인가: 이 CLI의 존재 이유 자체가 "검증 규칙을 다시 베끼지 않고
 * 재사용하는 것"이다(host-bridge.ts 문서 참고) — mock으로 테스트하면 재사용이 실제로
 * 되는지를 검증하지 못한다. 대신 서버 기동 비용을 줄이려고 파일 전체에서 계약을 한 번만
 * 로드해 공유한다(각 it가 새 임시 플러그인 폴더만 만든다).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHostContract, type HostContract } from "./host-bridge";
import { runValidate } from "./validate";
import { runLint } from "./lint";
import { runCli } from "./cli";
import { exitCodeFor, formatJson, formatText } from "./report";

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

/** 임시 플러그인 폴더를 만들고 manifest.json·main.js를 써 넣는다. */
function makeFixturePlugin(
  id: string,
  manifestOverrides: Record<string, unknown>,
  code: string,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-cli-"));
  tmpDirs.push(dir);
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    entry: "main.js",
    permissions: [],
    ...manifestOverrides,
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "main.js"), code);
  return dir;
}

describe("runValidate — 실물 parseManifest 재사용", () => {
  it("유효한 매니페스트는 오류 없이 통과한다", async () => {
    const dir = makeFixturePlugin(
      "valid-plugin",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" });',
    );
    const { findings, manifest } = await runValidate(dir, contract);
    // id('valid-plugin')와 폴더명(mkdtemp가 만든 임의 이름)이 다르므로 ID_DIR_MISMATCH
    // 경고만 있고 error는 없어야 한다.
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(manifest?.id).toBe("valid-plugin");
  });

  it("manifest.json이 없으면 MANIFEST_MISSING", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-cli-"));
    tmpDirs.push(dir);
    const { findings } = await runValidate(dir, contract);
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", code: "MANIFEST_MISSING" }),
    ]);
  });

  it("깨진 JSON은 MANIFEST_JSON_INVALID", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-cli-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    const { findings } = await runValidate(dir, contract);
    expect(findings[0]?.code).toBe("MANIFEST_JSON_INVALID");
  });

  it("알 수 없는 권한이 선언돼 있으면 parseManifest가 거부(MANIFEST_INVALID)", async () => {
    const dir = makeFixturePlugin(
      "bad-perm",
      { permissions: ["not-a-real-permission"] },
      "",
    );
    const { findings } = await runValidate(dir, contract);
    expect(findings[0]?.code).toBe("MANIFEST_INVALID");
  });

  it("entry 파일이 없으면 ENTRY_MISSING", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-cli-"));
    tmpDirs.push(dir);
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "no-entry",
        name: "x",
        version: "1.0.0",
        entry: "main.js",
        permissions: [],
      }),
    );
    const { findings } = await runValidate(dir, contract);
    expect(findings.some((f) => f.code === "ENTRY_MISSING")).toBe(true);
  });
});

describe("runLint — 존재하지 않는 호출 / 예약 호출", () => {
  it("오타 호출(존재하지 않음)을 UNKNOWN_CALL로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "typo-plugin",
      { permissions: ["ui"] },
      'memo.ui.toats({ text: "oops" });',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some((f) => f.code === "UNKNOWN_CALL" && f.line === 1),
    ).toBe(true);
  });

  it("예약 호출(vault.read)을 RESERVED_CALL로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "reserved-plugin",
      { permissions: ["vault:read"] },
      'memo.vault.read({ path: "x" });',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "RESERVED_CALL")).toBe(true);
  });

  /**
   * 가드: **없어진 호출**은 오타(UNKNOWN_CALL)와 갈라져 옮길 곳을 알려 준다.
   *
   * 왜 lint에 이 배선이 필요한가: `memo-plugin lint`는 저작자가 가장 먼저 돌리는 도구다.
   * 안내가 런타임 진단에만 있으면, 앱을 띄우고 그 플러그인을 실행해 「최근 오류」까지 열어 본
   * 사람만 마이그레이션 방법을 알게 된다 — lint는 그동안 "오타이거나 아직 없는 API"라는
   * **틀린** 추측을 준다(옛 `memo.i18n.register`는 오타도 아니고 아직 없는 것도 아니다).
   *
   * 코드를 `RESERVED_CALL`처럼 따로 파는 이유도 같다: 도구가 "타이핑 실수"와 "계약이 바뀜"을
   * 갈라야 저작자에게 다른 말을 할 수 있다. severity는 예약(warn)과 달리 error다 — 예약은
   * 언젠가 열릴 수 있지만 없어진 호출은 돌아오지 않는다.
   */
  it("없어진 호출(i18n.register)에 마이그레이션 안내를 준다", async () => {
    const dir = makeFixturePlugin(
      "old-language-pack",
      { kind: "capability", permissions: ["i18n"] },
      'memo.i18n.register({ locale: "fr", label: "Français", entries: {} });',
    );
    const findings = await runLint(dir, contract);
    const removed = findings.find((f) => f.code === "REMOVED_CALL");
    expect(removed?.severity).toBe("error");
    expect(removed?.line).toBe(1);
    expect(removed?.message).toContain("없어진 호출");
    expect(removed?.message).toContain("contributes.translations");
    // 오타로 오인하지 않는다 — 두 진단이 동시에 뜨면 저작자가 어느 쪽을 믿을지 모른다.
    expect(findings.some((f) => f.code === "UNKNOWN_CALL")).toBe(false);
  });

  /**
   * 가드: `ui.addMenuItem`·`notes.write`는 예약에서 풀렸다 — CLI가 이 둘을 예약/오타로
   * 오인하지 않는다(예전엔 RESERVED_CALL을 줬다). 이 대조가 없으면 CLI가 계약을 몰라
   * "문제 없음"이 거짓말이 된다(예약된 줄 모르고 통과 vs 풀린 줄 모르고 거부).
   */
  it("ui.addMenuItem·notes.write를 예약/오타로 오인하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "p27-plugin",
      { kind: "action", permissions: ["ui", "notes:write"] },
      "memo.ui.addMenuItem({ label: '항목', run: function () {} }).catch(function () {});\n" +
        "memo.notes.write({ id: 'x', content: 'y', mode: 'append' }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) => f.code === "RESERVED_CALL" || f.code === "UNKNOWN_CALL",
      ),
    ).toBe(false);
  });

  /**
   * 가드(payload 게이트): `ui.addMenuItem`의 `payload.selectedText`는 `notes:read`로
   * 게이트되므로, 선택 텍스트를 쓰려고 notes:read를 선언한 플러그인이 UNUSED_PERMISSION
   * 오탐을 받지 않는다(선언을 지우면 selectedText가 조용히 비는 무음 실패로 유도된다).
   */
  it("ui.addMenuItem과 함께 선언한 notes:read를 UNUSED_PERMISSION으로 오탐하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "p27-selection-plugin",
      { kind: "action", permissions: ["ui", "notes:read"] },
      "memo.ui.addMenuItem({ label: '감싸기', run: function (memo, payload) { void payload.selectedText; } }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "UNUSED_PERMISSION" && f.message.includes("notes:read"),
      ),
    ).toBe(false);
  });
});

describe("runLint — network.fetch 도메인 권한", () => {
  /** 가드: URL 리터럴의 호스트로 `network:<호스트>`를 선언하지 않으면 PERMISSION_UNDECLARED. */
  it("URL 호스트 권한을 선언하지 않으면 PERMISSION_UNDECLARED error", async () => {
    const dir = makeFixturePlugin(
      "net-missing-host",
      { kind: "action", permissions: [] },
      'memo.network.fetch({ url: "https://api.example.com/x" }).catch(function () {});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.severity === "error" &&
          f.message.includes("network:api.example.com"),
      ),
    ).toBe(true);
  });

  /** 가드: 정확한 호스트 권한을 선언하면 통과한다(오탐 없음). */
  it("정확한 호스트 권한을 선언하면 통과한다", async () => {
    const dir = makeFixturePlugin(
      "net-ok",
      { kind: "action", permissions: ["network:api.example.com"] },
      'memo.network.fetch({ url: "https://api.example.com/x" }).catch(function () {});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.filter(
        (f) => f.severity === "error" && f.code === "PERMISSION_UNDECLARED",
      ),
    ).toEqual([]);
  });

  /** 가드: 다른 호스트를 선언하면(도메인 불일치) 여전히 그 호스트 권한 누락으로 잡힌다. */
  it("선언한 호스트와 URL 호스트가 다르면 잡는다", async () => {
    const dir = makeFixturePlugin(
      "net-wrong-host",
      { kind: "action", permissions: ["network:other.com"] },
      'memo.network.fetch({ url: "https://api.example.com/x" }).catch(function () {});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.message.includes("network:api.example.com"),
      ),
    ).toBe(true);
  });
});

describe("runLint — commands.invoke 대상 권한", () => {
  /** 가드: 대상 리터럴(pluginId)에 맞는 invoke:<대상>을 선언하지 않으면 PERMISSION_UNDECLARED. */
  it("대상 권한을 선언하지 않으면 PERMISSION_UNDECLARED error", async () => {
    const dir = makeFixturePlugin(
      "invoke-missing",
      { kind: "action", permissions: [] },
      'memo.commands.invoke({ pluginId: "copy-ai-prompt", commandId: "copy" }).catch(function () {});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.severity === "error" &&
          f.message.includes("invoke:copy-ai-prompt"),
      ),
    ).toBe(true);
  });

  /** 가드: 정확한 대상 권한을 선언하면 통과한다(대표 권한 'invoke:<pluginId>' 오탐 없음). */
  it("정확한 대상 권한을 선언하면 통과한다", async () => {
    const dir = makeFixturePlugin(
      "invoke-ok",
      { kind: "action", permissions: ["invoke:copy-ai-prompt"] },
      'memo.commands.invoke({ pluginId: "copy-ai-prompt", commandId: "copy" }).catch(function () {});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.filter(
        (f) => f.severity === "error" && f.code === "PERMISSION_UNDECLARED",
      ),
    ).toEqual([]);
  });
});

describe("runLint — ui.addMenuItem 등록 계약", () => {
  /**
   * 가드: `run`이 없는 addMenuItem은 MISSING_RUN. 호스트는 INVALID_ARGS로 거부해 메뉴 항목이
   * 등록되지 않는데(우클릭 메뉴에 안 뜬다), 예전엔 이 정적 검사가 없어 "린트 통과인데 앱에서
   * 안 뜬다"였다(툴바·명령에는 있던 검사가 신규 API에만 빠져 있었다).
   */
  it("run이 없는 addMenuItem은 MISSING_RUN error", async () => {
    const dir = makeFixturePlugin(
      "menu-no-run",
      { kind: "action", permissions: ["ui"] },
      "memo.ui.addMenuItem({ label: '항목' }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some((f) => f.code === "MISSING_RUN" && f.severity === "error"),
    ).toBe(true);
  });

  /** 가드: label이 없거나 빈 리터럴이면 MISSING_LABEL(메뉴에 보일 유일한 문자열이라 비면 거부). */
  it("빈 label의 addMenuItem은 MISSING_LABEL error", async () => {
    const dir = makeFixturePlugin(
      "menu-empty-label",
      { kind: "action", permissions: ["ui"] },
      "memo.ui.addMenuItem({ label: '', run: function () {} }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) => f.code === "MISSING_LABEL" && f.severity === "error",
      ),
    ).toBe(true);
  });

  /**
   * 가드: 메뉴 항목 when에 정적 키(platform.macos)를 넣으면 INVALID_WHEN. 호스트의 실물 파서를
   * `menu` 옵션으로 부르므로 앱과 같은 판정이다(정적 키는 렌더 시점의 노트 창이 못 봐서 거부).
   */
  it("메뉴 항목 when의 정적 키는 INVALID_WHEN error", async () => {
    const dir = makeFixturePlugin(
      "menu-bad-when",
      { kind: "action", permissions: ["ui"] },
      "memo.ui.addMenuItem({ label: '항목', when: ['platform.macos'], run: function () {} }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some((f) => f.code === "INVALID_WHEN" && f.severity === "error"),
    ).toBe(true);
  });

  /** 가드(오탐 없음): run·label·창 상태 when을 갖춘 정상 addMenuItem은 error가 없다. */
  it("정상 addMenuItem은 등록 계약 error가 없다", async () => {
    const dir = makeFixturePlugin(
      "menu-ok",
      { kind: "action", permissions: ["ui"] },
      "memo.ui.addMenuItem({ label: '감싸기', when: ['note.hasSelection'], run: function () {} }).catch(function () {});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.filter(
        (f) =>
          f.severity === "error" &&
          ["MISSING_RUN", "MISSING_LABEL", "INVALID_WHEN"].includes(f.code),
      ),
    ).toEqual([]);
  });
});

describe("runLint — kind 게이트", () => {
  /**
   * 가드(거짓 통과 회귀): `kind: "action"`인데 능력 등록을 부르면 error다.
   *
   * 왜: 정본 예제 3개가 전부 `kind: "action"`이라, 그것을 복사해 테마·배경 플러그인을 만든
   * 저작자(또는 AI)는 kind를 그대로 둔다. 예전 lint는 "✓ 문제 없음"(그리고 `--json`의
   * `ok: true`)을 줬지만 설치하면 능력 등록이 전부 WRONG_PLUGIN_KIND로 거부돼 플러그인이
   * 아무 일도 하지 않았다 — 앱을 띄우지 않고 스스로 검증하라고 만든 도구가 거짓 통과를 줬다.
   */
  it("kind: action 플러그인이 능력 등록을 부르면 WRONG_PLUGIN_KIND", async () => {
    const dir = makeFixturePlugin(
      "action-capability-plugin",
      { kind: "action", permissions: ["theme"] },
      'memo.theme.register({ tokens: { accent: "#ff0000" } }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) => f.code === "WRONG_PLUGIN_KIND" && f.severity === "error",
      ),
    ).toBe(true);
  });

  it("kind: capability면 능력 등록이 통과한다", async () => {
    const dir = makeFixturePlugin(
      "capability-plugin",
      { kind: "capability", permissions: ["theme"] },
      'memo.theme.register({ tokens: { accent: "#ff0000" } }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "WRONG_PLUGIN_KIND")).toBe(false);
  });

  /** 가드(하위호환): kind 미선언은 게이트가 통과시키므로 lint도 검사하지 않는다. */
  it("kind 미선언은 검사하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "no-kind-plugin",
      { permissions: ["theme"] },
      'memo.theme.register({ tokens: { accent: "#ff0000" } }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "WRONG_PLUGIN_KIND")).toBe(false);
  });
});

describe("runLint — 미선언 권한", () => {
  it("settings 권한 없이 memo.settings.get을 쓰면 PERMISSION_UNDECLARED", async () => {
    const dir = makeFixturePlugin(
      "no-perm-plugin",
      { permissions: [] },
      'memo.settings.get({ key: "x" }).then(function(){}).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "PERMISSION_UNDECLARED")).toBe(true);
  });

  it("권한을 선언하고 실제로 쓰면 PERMISSION_UNDECLARED가 없다", async () => {
    const dir = makeFixturePlugin(
      "has-perm-plugin",
      { permissions: ["notes:read"] },
      "memo.notes.current().then(function(n){}).catch(function(e){});",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "PERMISSION_UNDECLARED")).toBe(
      false,
    );
  });

  /**
   * 가드: CLI가 새 호출·권한(`notes.list`/`notes.read` × `notes:all-read`)을 실제로
   * 안다 — 계약을 모르는 lint의 「문제 없음」은 거짓말이다. CLI는 host.ts를 SSR 로더로
   * 그대로 재사용하므로 구조적으로는 자동 추종이지만, "정말 아는지"는 이 왕복만이 증명한다.
   */
  it("notes:all-read 없이 memo.notes.list를 쓰면 PERMISSION_UNDECLARED", async () => {
    const dir = makeFixturePlugin(
      "all-read-missing-plugin",
      { permissions: ["notes:read"] }, // 기존 notes:read로는 부족하다(소급 확대 금지)
      "memo.notes.list().then(function(n){}).catch(function(e){});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.message.includes("notes:all-read"),
      ),
    ).toBe(true);
  });

  it("notes:all-read를 선언하면 notes.list/notes.read가 깨끗이 통과한다", async () => {
    const dir = makeFixturePlugin(
      "all-read-ok-plugin",
      { permissions: ["notes:all-read"] },
      "memo.notes.list().then(function(n){ return memo.notes.read({ id: n[0].id }); }).catch(function(e){});",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.filter(
        (f) => f.code === "PERMISSION_UNDECLARED" || f.code === "RESERVED_CALL",
      ),
    ).toEqual([]);
  });
});

describe("runLint — 인자 2개 이상", () => {
  it("memo.settings.set('k','v') 2-인자 호출을 TOO_MANY_ARGS로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "two-args-plugin",
      { permissions: ["settings"] },
      'memo.settings.set("k", "v");',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "TOO_MANY_ARGS")).toBe(true);
  });

  it("객체 인자 1개는 TOO_MANY_ARGS가 아니다", async () => {
    const dir = makeFixturePlugin(
      "one-arg-plugin",
      { permissions: ["settings"] },
      'memo.settings.set({ key: "k", value: "v" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "TOO_MANY_ARGS")).toBe(false);
  });

  /**
   * 가드(회귀): 문구가 **실제 인과**를 말한다.
   *
   * 왜: 예전 문구는 "나머지는 조용히 버려짐"이었다 — 예전 동작이다. 지금은 그 줄에서
   * 동기 TypeError가 나 최상위 실행이 멈추고, ready가 "스크립트 실행 오류"로 거부되어
   * **그 플러그인의 등록이 하나도 남지 않는다**. 옛 문구를 믿으면 저작자는 버튼·패턴이
   * 전부 사라진 원인을 툴바 배치·권한·활성 토글에서 찾는다. CLI는 AI가 앱을 띄우지 않고
   * 스스로 검증하는 유일한 창구라, 여기의 오해가 그대로 복제된다.
   */
  it("TOO_MANY_ARGS 문구가 '조용히 버려짐'이 아니라 로드 실패를 말한다", async () => {
    const dir = makeFixturePlugin(
      "two-args-message-plugin",
      { permissions: ["settings"] },
      'memo.settings.set("k", "v");',
    );
    const findings = await runLint(dir, contract);
    const message = findings.find((f) => f.code === "TOO_MANY_ARGS")!.message;
    expect(message).not.toContain("조용히 버려");
    expect(message).toContain("TypeError");
    expect(message).toContain("로드 자체가 실패");
  });
});

describe("runLint — 렌더 시점 게이트 권한(RENDER_GATE_UNDECLARED)", () => {
  /**
   * 가드(핵심): `notes:read` 없는 자동완성 등록은 런타임에서 **100% 무력화**된다 —
   * `host-client.ts`가 `noteTitles`를 빈 목록으로 갈아 끼워 팝업 후보가 영원히 0개이고,
   * 진단 채널에도 아무것도 남지 않는다. lint가 「문제 없음」을 주면 아무도 못 잡는다.
   */
  it("notes:read 없이 registerCompletion을 쓰면 경고한다", async () => {
    const dir = makeFixturePlugin(
      "completion-no-read",
      { permissions: ["editor"] },
      'memo.editor.registerCompletion({ id: "at", trigger: "@", wrap: "[[%]]" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "RENDER_GATE_UNDECLARED" &&
          f.message.includes("notes:read"),
      ),
    ).toBe(true);
  });

  it("notes:read를 선언했으면 경고하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "completion-with-read",
      { permissions: ["editor", "notes:read"] },
      'memo.editor.registerCompletion({ id: "at", trigger: "@", wrap: "[[%]]" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "RENDER_GATE_UNDECLARED")).toBe(
      false,
    );
  });

  /** 가드(오탐 방지): 스타일만 입히는 인라인 패턴은 정상 용례다 — `notes:read`·`windows`가
   * 없다고 경고하면 안 된다(클릭 이동을 안 쓰는 패턴이 대부분이다). */
  it("스타일 전용 인라인 패턴에는 경고하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "style-only-pattern",
      { permissions: ["editor"] },
      'memo.editor.registerInlinePattern({ id: "hl", open: "==", close: "==" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "RENDER_GATE_UNDECLARED")).toBe(
      false,
    );
  });

  /** 가드: 임베드는 `embed:<도메인>` 권한이 없으면 등록 성공 후 렌더 직전에 조용히 취소된다
   * (`embed.ts`의 `allowDomain`) — 정적 리터럴 템플릿에서 호스트를 뽑아 대조한다. */
  it("embedTemplate 도메인 권한이 없으면 경고한다", async () => {
    const dir = makeFixturePlugin(
      "embed-no-domain",
      { permissions: ["editor"] },
      'memo.editor.registerBlockEmbed({ id: "yt", fence: "youtube", sources: [{ host: "www.youtube.com", queryParam: "v" }], embedTemplate: "https://www.youtube-nocookie.com/embed/{id}" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "RENDER_GATE_UNDECLARED" &&
          f.message.includes("embed:www.youtube-nocookie.com"),
      ),
    ).toBe(true);
  });

  it("embedTemplate 도메인 권한을 선언했으면 경고하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "embed-with-domain",
      { permissions: ["editor", "embed:www.youtube-nocookie.com"] },
      'memo.editor.registerBlockEmbed({ id: "yt", fence: "youtube", sources: [{ host: "www.youtube.com", queryParam: "v" }], embedTemplate: "https://www.youtube-nocookie.com/embed/{id}" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "RENDER_GATE_UNDECLARED")).toBe(
      false,
    );
  });

  /** 가드: 템플릿이 정적 리터럴이 아니면 건너뛴다(추측성 오탐 금지 — 도구의 기존 태도). */
  it("동적 embedTemplate은 판단하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "embed-dynamic",
      { permissions: ["editor"] },
      'var t = base + "/embed/{id}"; memo.editor.registerBlockEmbed({ id: "yt", fence: "youtube", sources: [], embedTemplate: t }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "RENDER_GATE_UNDECLARED")).toBe(
      false,
    );
  });
});

describe("runLint — 툴바 버튼 등록 계약", () => {
  /**
   * 가드: 같은 id로 두 번 등록하면 경고한다.
   *
   * 왜: 복사-붙여넣기로 id를 안 바꾼 버튼 두 개는 런타임에서 치환돼 하나가 사라지고,
   * 그 전까지 어떤 도구도(앱을 띄우기 전에는) 이것을 말해 주지 않았다.
   */
  it("같은 id로 두 번 등록하면 DUPLICATE_BUTTON_ID", async () => {
    const dir = makeFixturePlugin(
      "dup-button-plugin",
      { permissions: ["ui"] },
      'memo.ui.addToolbarButton({ id: "b", label: "1", position: "bottom-left", onClick: function () {} });\n' +
        'memo.ui.addToolbarButton({ id: "b", label: "2", position: "top-right", onClick: function () {} });',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.filter((f) => f.code === "DUPLICATE_BUTTON_ID"),
    ).toHaveLength(1);
  });

  /** 가드: 서로 다른 id면 조용하다(오탐 금지). */
  it("id가 다르면 DUPLICATE_BUTTON_ID가 없다", async () => {
    const dir = makeFixturePlugin(
      "two-button-plugin",
      { permissions: ["ui"] },
      'memo.ui.addToolbarButton({ id: "a", label: "1", position: "bottom-left", onClick: function () {} });\n' +
        'memo.ui.addToolbarButton({ id: "b", label: "2", position: "top-right", onClick: function () {} });',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "DUPLICATE_BUTTON_ID")).toBe(false);
  });

  /** 가드: onClick 없는 등록은 런타임이 INVALID_ARGS로 거부하므로 error다. */
  it("onClick이 없으면 MISSING_ONCLICK", async () => {
    const dir = makeFixturePlugin(
      "no-onclick-plugin",
      { permissions: ["ui"] },
      'memo.ui.addToolbarButton({ id: "dead", label: "X", position: "bottom-left" });',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_ONCLICK")).toBe(true);
  });

  /** 가드: 인자가 리터럴이 아니면 판단하지 않는다(추측성 오탐 금지 — 도구의 기존 태도). */
  it("변수로 넘긴 인자는 MISSING_ONCLICK을 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "dynamic-button-plugin",
      { permissions: ["ui"] },
      'var cfg = { id: "a", label: "1", position: "bottom-left", onClick: function () {} };\n' +
        "memo.ui.addToolbarButton(cfg);",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_ONCLICK")).toBe(false);
  });
});

describe("runLint — catch 없는 최상위 호출", () => {
  it("catch 없는 fire-and-forget 호출을 MISSING_CATCH로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "no-catch-plugin",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" });',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_CATCH")).toBe(true);
  });

  it("catch가 붙어 있으면 MISSING_CATCH가 없다", async () => {
    const dir = makeFixturePlugin(
      "with-catch-plugin",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" }).catch(function(e){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_CATCH")).toBe(false);
  });

  it("Promise.all(...) 인자 안에 중첩된 호출은 MISSING_CATCH를 내지 않는다(불확실 회피)", async () => {
    const dir = makeFixturePlugin(
      "nested-plugin",
      { permissions: ["notes:read", "settings"] },
      "Promise.all([memo.notes.current(), memo.settings.get({key:'t'})]).then(function(){}).catch(function(){});",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_CATCH")).toBe(false);
  });

  /** 실증(정본 예제 3개, 7건): catch 핸들러 안에서 부른 memo.*에 다시 .catch를 요구하는 것은
   * 오탐이다 — 이미 실패를 처리하는 중인 곳이다. */
  it("catch 핸들러 본문 안에서 부른 호출은 MISSING_CATCH를 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "catch-body-plugin",
      { permissions: ["notes:read"] },
      "memo.notes.current().catch(function (e) { memo.runtime.log({ message: e.code }); });",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_CATCH")).toBe(false);
  });

  /**
   * 가드(면제 범위): catch 핸들러 안이라도 **상태를 바꾸는 호출**은 면제하지 않는다.
   *
   * 왜: 면제의 근거("이미 실패를 처리하는 중")는 실패해도 잃을 것이 없는 진단 호출에만
   * 성립한다. 복구 로직이 catch 안에서 `settings.set`을 부르면 그 호출의 거부(권한 미부여·
   * IPC 실패)는 여전히 조용히 사라진다 — 무음 실패를 없애려는 도구가 정확히 에러 복구
   * 코드에서 그것을 재도입한다.
   */
  it("catch 핸들러 안이라도 상태를 바꾸는 호출은 MISSING_CATCH를 낸다", async () => {
    const dir = makeFixturePlugin(
      "catch-body-mutating-plugin",
      { permissions: ["notes:read", "settings"] },
      "memo.notes.current().catch(function (e) { memo.settings.set({ key: 'lastError', value: String(e) }); });",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) => f.code === "MISSING_CATCH" && f.message.includes("settings.set"),
      ),
    ).toBe(true);
  });

  it("catch 핸들러 밖의 진짜 누락은 여전히 MISSING_CATCH로 잡힌다", async () => {
    const dir = makeFixturePlugin(
      "still-missing-plugin",
      { permissions: ["notes:read"] },
      "memo.notes.current().catch(function (e) {}); memo.ui.toast({ title: 'hi' });",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) => f.code === "MISSING_CATCH" && f.message.includes("ui.toast"),
      ),
    ).toBe(true);
  });
});

describe("runLint — 설정 스키마에 없는 키", () => {
  it("선언 안 된 키를 settings.get으로 읽으면 UNKNOWN_SETTING_KEY", async () => {
    const dir = makeFixturePlugin(
      "unknown-key-plugin",
      {
        permissions: ["settings"],
        settings: [{ key: "known", label: "K", type: "text" }],
      },
      'memo.settings.get({ key: "unknown" }).then(function(){}).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_SETTING_KEY")).toBe(true);
  });

  /** 가드: 진단 문구가 브리지의 실제 반환(null)을 말한다 — 예전 문구("항상 undefined")를
   * 믿고 `=== undefined` 폴백을 짜면 그 분기가 절대 타지 않는다. */
  it("미선언 키 진단은 undefined가 아니라 null을 말한다", async () => {
    const dir = makeFixturePlugin(
      "undeclared-key-message-plugin",
      { permissions: ["settings"] },
      'memo.settings.get({ key: "nope" }).then(function(){}).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    const found = findings.find((f) => f.code === "UNKNOWN_SETTING_KEY");
    expect(found?.message).toContain("null");
    expect(found?.message).not.toContain("undefined");
  });

  it("선언된 키를 읽으면 UNKNOWN_SETTING_KEY가 없다", async () => {
    const dir = makeFixturePlugin(
      "known-key-plugin",
      {
        permissions: ["settings"],
        settings: [{ key: "known", label: "K", type: "text" }],
      },
      'memo.settings.get({ key: "known" }).then(function(){}).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_SETTING_KEY")).toBe(false);
  });

  it("동적 키(변수)는 판단할 수 없으므로 검사하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "dynamic-key-plugin",
      { permissions: ["settings"] },
      "var k = pick(); memo.settings.get({ key: k }).then(function(){}).catch(function(){});",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_SETTING_KEY")).toBe(false);
  });
});

describe("runLint — 선언했으나 안 쓴 권한", () => {
  it("clipboard 권한을 선언하고 clipboard.write를 안 쓰면 UNUSED_PERMISSION", async () => {
    const dir = makeFixturePlugin(
      "unused-perm-plugin",
      { permissions: ["clipboard", "ui"] },
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "UNUSED_PERMISSION" && f.message.includes("clipboard"),
      ),
    ).toBe(true);
    // ui는 실제로 썼으니 안 걸려야 한다.
    expect(
      findings.some(
        (f) => f.code === "UNUSED_PERMISSION" && f.message.includes("'ui'"),
      ),
    ).toBe(false);
  });

  /** 가드: `notes:read`는 브리지 호출뿐 아니라 자동완성 후보 원천(노트 제목)도 게이트한다 —
   * 지우라고 권하면 팝업만 뜨고 후보가 영원히 0개인 무음 실패가 된다(wikilink 번들이 실례). */
  it("editor.registerCompletion을 쓰면 notes:read는 '안 쓴 권한'이 아니다", async () => {
    const dir = makeFixturePlugin(
      "completion-plugin",
      { permissions: ["editor", "notes:read"] },
      'memo.editor.registerCompletion({ trigger: "[[", wrap: "[[%]]" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "UNUSED_PERMISSION" && f.message.includes("notes:read"),
      ),
    ).toBe(false);
  });

  /** 가드: 인라인 패턴 클릭 → 노트 소환은 `notes:read` + `windows` 조합이 여는 렌더 게이트다. */
  it("editor.registerInlinePattern을 쓰면 notes:read·windows는 '안 쓴 권한'이 아니다", async () => {
    const dir = makeFixturePlugin(
      "wikilink-like-plugin",
      { permissions: ["editor", "notes:read", "windows"] },
      'memo.editor.registerInlinePattern({ open: "[[", close: "]]" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    const unused = findings
      .filter((f) => f.code === "UNUSED_PERMISSION")
      .map((f) => f.message);
    expect(unused.some((m) => m.includes("notes:read"))).toBe(false);
    expect(unused.some((m) => m.includes("windows"))).toBe(false);
  });

  it("완전-예약 권한(vault:read — 매핑된 호출이 전부 예약)은 안 쓰여도 UNUSED_PERMISSION을 내지 않는다", async () => {
    // vault:read는 알려진 민감 권한이라 매니페스트 검증을 통과하고(그래야 lint의 코드 스캔까지
    // 도달), permissionToCalls는 vault.read 하나만 매핑하는데 그 호출이 RESERVED_CALL이라
    // liveCalls가 비어 UNUSED_PERMISSION을 skip하는 경로(lint.ts)를 실제로 태운다.
    const dir = makeFixturePlugin(
      "reserved-perm-plugin",
      { permissions: ["vault:read"] },
      "// no calls",
    );
    const findings = await runLint(dir, contract);
    // 매니페스트가 MANIFEST_INVALID로 먼저 죽으면 이 단언은 공허하게 통과한다 — 파싱 통과를 확인.
    expect(findings.some((f) => f.code === "MANIFEST_INVALID")).toBe(false);
    expect(findings.some((f) => f.code === "UNUSED_PERMISSION")).toBe(false);
  });

  it("embed:<domain> 권한은 정적 판단 불가라 UNUSED_PERMISSION을 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "embed-perm-plugin",
      { permissions: ["embed:youtube.com"] },
      "// no calls",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNUSED_PERMISSION")).toBe(false);
  });
});

describe("runCli — argv 파싱·종료 코드·--json", () => {
  it("명령 없이 실행하면 도움말 + 종료코드 1", async () => {
    const { exitCode, output } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(output).toContain("사용법");
  });

  it("--help는 종료코드 0", async () => {
    const { exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
  });

  it("알 수 없는 명령은 종료코드 1", async () => {
    const { exitCode, output } = await runCli(["frobnicate", "./x"]);
    expect(exitCode).toBe(1);
    expect(output).toContain("알 수 없는 명령");
  });

  it("존재하지 않는 디렉터리는 종료코드 1", async () => {
    const { exitCode, output } = await runCli([
      "validate",
      "/no/such/dir/at/all",
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("디렉터리를 찾을 수 없음");
  });

  it("validate 성공 시 종료코드 0, --json은 유효한 JSON", async () => {
    const dir = makeFixturePlugin(
      "cli-ok-plugin",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const { exitCode, output } = await runCli(["validate", dir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("validate");
  });

  it("lint에서 error 등급 발견 시 종료코드 1", async () => {
    const dir = makeFixturePlugin(
      "cli-lint-fail-plugin",
      { permissions: [] },
      "memo.settings.get({ key: 'x' });",
    );
    const { exitCode, output } = await runCli(["lint", dir, "--json"]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCount).toBeGreaterThan(0);
  });

  it("warn만 있으면 lint도 종료코드 0", async () => {
    const dir = makeFixturePlugin(
      "cli-lint-warn-plugin",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" });', // MISSING_CATCH는 warn
    );
    const { exitCode } = await runCli(["lint", dir]);
    expect(exitCode).toBe(0);
  });
});

describe("report — 사람용 텍스트 / JSON 형식", () => {
  it("빈 findings는 통과 메시지", () => {
    expect(formatText("validate", "/x", [])).toContain("문제 없음");
    expect(exitCodeFor([])).toBe(0);
  });

  it("error 하나면 exitCodeFor는 1", () => {
    expect(
      exitCodeFor([
        { severity: "error", code: "X", message: "m" },
        { severity: "warn", code: "Y", message: "m" },
      ]),
    ).toBe(1);
  });

  it("JSON 출력은 findings 배열과 카운트를 포함한다", () => {
    const json = formatJson("lint", "/x", [
      { severity: "error", code: "X", message: "m" },
      { severity: "warn", code: "Y", message: "m" },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.warnCount).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });
});

describe("runLint — 명령 등록·when", () => {
  it("run 없는 commands.register를 MISSING_RUN으로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "cmd-no-run",
      { permissions: ["commands"] },
      'memo.commands.register({ id: "x", title: "T" }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "MISSING_RUN")).toBe(true);
  });

  /**
   * 가드(핵심): `when`의 오타를 **앱을 띄우기 전에** 잡는다.
   *
   * 런타임에서는 이 오타가 명령 등록 전체를 거부시키고, 그 흔적은 진단 채널에만 남는다 —
   * 저작자 눈에는 "단축키 화면에 내 명령이 없다"로만 보인다.
   */
  it("어휘 밖 when 키를 INVALID_WHEN으로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "cmd-bad-when",
      { permissions: ["commands"] },
      'memo.commands.register({ title: "T", when: ["note.hasSelection"], run: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "INVALID_WHEN")).toBe(true);
  });

  it("유효한 when은 아무 것도 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "cmd-ok-when",
      { permissions: ["commands"] },
      'memo.commands.register({ title: "T", when: ["!note.isEmpty", "platform.macos"], run: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "INVALID_WHEN")).toBe(false);
  });
});

/**
 * 이벤트 구독의 정적 검사 — 이름은 닫힌 어휘이고, 이름마다 **추가** 권한이 다르다.
 *
 * 왜 CLI가 이것을 알아야 하나: 둘 다 런타임에서 `INVALID_ARGS`·권한 거부로 끝나는데 그
 * 흔적은 진단 채널뿐이다("구독은 했는데 핸들러가 영영 안 불린다"). CLI가 모르면 그런
 * 플러그인에 「문제 없음」을 준다 — 웨이브 B 통합 게이트에서 실제로 그 상태를 발견해 메웠다.
 */
describe("runLint — 이벤트 구독", () => {
  it("없는 이벤트 이름을 UNKNOWN_EVENT_NAME으로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "ev-bad-name",
      { permissions: ["settings"] },
      'memo.events.on({ name: "note:typed", handler: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_EVENT_NAME")).toBe(true);
  });

  /**
   * 가드(핵심): `CALL_PERMISSIONS["events.on"]`는 **바닥**(`settings`)이라 공통 권한 검사만
   * 돌면 `note:*` 구독이 `settings`만으로 통과한다 — 이름별 추가 권한을 따로 봐야 잡힌다.
   */
  it("note:* 구독에 notes:read가 없으면 PERMISSION_UNDECLARED", async () => {
    const dir = makeFixturePlugin(
      "ev-missing-perm",
      { permissions: ["settings"] },
      'memo.events.on({ name: "note:saved", handler: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.message.includes("notes:read"),
      ),
    ).toBe(true);
  });

  it("settings:changed는 settings만으로 통과한다", async () => {
    const dir = makeFixturePlugin(
      "ev-ok",
      { permissions: ["settings"] },
      'memo.events.on({ name: "settings:changed", handler: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  /** 동적 이름은 **추측하지 않는다** — 오탐이 미탐보다 나쁘다(이 저장소의 일관된 방침). */
  it("동적 name은 판정하지 않는다", async () => {
    const dir = makeFixturePlugin(
      "ev-dynamic",
      { permissions: ["settings", "notes:read"] },
      "var n = pick(); memo.events.on({ name: n, handler: function(){} }).catch(function(){});",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_EVENT_NAME")).toBe(false);
  });
});

describe("runLint — 설정 액션 버튼", () => {
  const buttonField = (command: string) => ({
    key: "act",
    label: "실행",
    type: "button",
    command,
  });

  /**
   * 가드(핵심): 매니페스트의 `command`와 코드의 `commands.register({ id })`가 어긋나면 잡는다.
   *
   * 이 어긋남은 **매니페스트도 코드도 각자는 유효**해서 다른 어떤 검증기도 못 잡는다.
   * 앱에서는 버튼이 멀쩡히 뜨고 눌러도 아무 일이 없다 — CLI가 모르면 "✓ 문제 없음"이
   * 거짓말이 되는 정확히 그 자리다.
   */
  it("등록되지 않은 command를 UNKNOWN_COMMAND_ID로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "btn-missing-cmd",
      { permissions: ["commands"], settings: [buttonField("nope")] },
      'memo.commands.register({ id: "other", title: "T", run: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_COMMAND_ID")).toBe(true);
  });

  it("id가 맞으면 아무 것도 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "btn-ok-cmd",
      { permissions: ["commands"], settings: [buttonField("go")] },
      'memo.commands.register({ id: "go", title: "T", run: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_COMMAND_ID")).toBe(false);
  });

  /** 가드: 판정이 틀리는 방향은 "건너뛴다"여야 한다 — 동적 id를 "없는 명령"으로 단정하면
   * 정상 플러그인이 오류를 받는다(오탐이 미탐보다 나쁘다). */
  it("동적 id가 섞이면 대조를 건너뛴다", async () => {
    const dir = makeFixturePlugin(
      "btn-dynamic-cmd",
      { permissions: ["commands"], settings: [buttonField("go")] },
      'memo.commands.register({ id: NAME, title: "T", run: function(){} }).catch(function(){});',
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_COMMAND_ID")).toBe(false);
  });
});

describe("runLint — 매니페스트 선언형 기여", () => {
  /** 가드: 기여만 있는(코드 0줄) 플러그인도 검사된다 — 여기서 안 보면 `contributes`를 쓴
   * 플러그인은 무조건 「문제 없음」을 받는다(CLI가 새 계약을 모르면 그 보고가 거짓말이 된다). */
  it("기여가 요구하는 권한을 선언하지 않으면 잡는다", async () => {
    const dir = makeFixturePlugin(
      "contrib-no-perm",
      {
        permissions: [],
        contributes: {
          inlinePatterns: [{ id: "hl", open: "==", close: "==" }],
        },
      },
      "",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.message.includes("contributes"),
      ),
    ).toBe(true);
  });

  it("모르는 기여 종류(오타)를 UNKNOWN_CONTRIBUTION으로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "contrib-typo",
      {
        permissions: ["editor"],
        contributes: { inlinePattern: [{ id: "hl" }] },
      },
      "",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNKNOWN_CONTRIBUTION")).toBe(true);
  });

  /** 가드: 항목 형식은 호스트의 **실물 registrar**로 검증한다(규칙 사본을 만들지 않는다). */
  it("형식이 틀린 기여 항목을 INVALID_CONTRIBUTION으로 잡는다", async () => {
    const dir = makeFixturePlugin(
      "contrib-bad-item",
      {
        permissions: ["editor"],
        contributes: { blockEmbeds: [{ id: "v", fence: "VID" }] },
      },
      "",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "INVALID_CONTRIBUTION")).toBe(true);
  });

  /** 가드: 기여로 쓴 권한은 "안 쓴 권한"이 아니다 — JSON만 쓴 플러그인이 정반대 경고를
   * 받으면 저작자는 권한을 지우게 되고 그러면 기여가 통째로 죽는다. */
  it("기여가 쓴 권한은 UNUSED_PERMISSION을 내지 않는다", async () => {
    const dir = makeFixturePlugin(
      "contrib-uses-perm",
      {
        permissions: ["editor"],
        contributes: {
          inlinePatterns: [{ id: "hl", open: "==", close: "==" }],
        },
      },
      "",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "UNUSED_PERMISSION")).toBe(false);
  });

  /** 가드: 능력 기여도 kind 게이트를 탄다(명령형 호출과 같은 규칙). */
  it("kind: action이 windowControls를 기여하면 WRONG_PLUGIN_KIND", async () => {
    const dir = makeFixturePlugin(
      "contrib-kind",
      {
        permissions: ["window-control"],
        kind: "action",
        contributes: { windowControls: ["transparency"] },
      },
      "",
    );
    const findings = await runLint(dir, contract);
    expect(findings.some((f) => f.code === "WRONG_PLUGIN_KIND")).toBe(true);
  });
});

/**
 * 언어팩(`contributes.translations`) — **브리지 호출이 없는 유일한 기여**라 위 describe의
 * 검사들과 경로가 다르다(호출로 되돌려 registrar에 태울 수가 없다).
 *
 * 왜 lint가 이 셋을 봐야 하는가: 코어(Rust)의 수집 게이트는 조건이 안 맞는 팩을 **오류 없이
 * 그냥 건너뛴다**. 저작자가 받는 신호는 "설치는 됐는데 언어 드롭다운에 안 뜬다" 하나뿐이고,
 * 진단 채널에도 아무것도 안 남는다 — 이 저장소가 반복해서 잡아 온 무음 실패의 전형이다.
 * lint가 그 게이트를 설치 **전에** 재현하는 것이 유일한 표면화 지점이라, 두 부정 경로와
 * 긍정 경로를 함께 못박는다(긍정이 없으면 "전부 오류를 내는" 구현도 통과한다).
 */
describe("runLint — 언어팩 기여(코어가 직접 읽는 선언)", () => {
  /** 올바른 언어팩 매니페스트 — 각 테스트가 자기가 검증할 조건 하나만 무너뜨린다. */
  const pack = (overrides: Record<string, unknown>) => ({
    kind: "capability",
    permissions: ["i18n"],
    contributes: {
      translations: [
        {
          locale: "fr",
          label: "Français",
          entries: { "panel.list.empty": "" },
        },
      ],
    },
    ...overrides,
  });

  it("i18n 권한을 선언하지 않으면 PERMISSION_UNDECLARED", async () => {
    const dir = makeFixturePlugin(
      "pack-no-perm",
      pack({ permissions: [] }),
      "",
    );
    const findings = await runLint(dir, contract);
    expect(
      findings.some(
        (f) =>
          f.code === "PERMISSION_UNDECLARED" &&
          f.message.includes("translations"),
      ),
    ).toBe(true);
  });

  /** 미선언(kind 없음)도 `"action"`과 똑같이 거부된다 — 코어 게이트가 `"capability"`를
   * **정확히** 요구하기 때문이다(엄격). 관용하면 kind를 빠뜨린 팩이 조용히 안 뜬다. */
  it("kind가 capability가 아니면 WRONG_PLUGIN_KIND(미선언 포함)", async () => {
    for (const overrides of [{ kind: "action" }, { kind: undefined }]) {
      const dir = makeFixturePlugin("pack-kind", pack(overrides), "");
      const findings = await runLint(dir, contract);
      expect(
        findings.some(
          (f) =>
            f.code === "WRONG_PLUGIN_KIND" &&
            f.message.includes("translations"),
        ),
        `kind=${String(overrides.kind)}에서 안 잡힘`,
      ).toBe(true);
    }
  });

  /** 가드(긍정 경로): 올바른 언어팩은 **오류가 하나도 없다** — 특히 `i18n`이
   * UNUSED_PERMISSION으로 오탐되지 않는다(대응 호출이 없는 유일한 권한이라 그 오탐이
   * 구조적으로 생기기 쉽다: 지우라는 말을 따르면 팩이 통째로 죽는다). */
  it("올바른 언어팩 매니페스트는 오류 없이 통과한다", async () => {
    const dir = makeFixturePlugin("language-pack-fr", pack({}), "");
    const findings = await runLint(dir, contract);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(findings.some((f) => f.code === "UNUSED_PERMISSION")).toBe(false);
  });
});

describe("runCli — scaffold(2단계)", () => {
  it("기본 템플릿(toolbar-button)으로 뼈대를 내고 종료코드 0", async () => {
    const parent = mkdtempSync(
      path.join(tmpdir(), "memo-plugin-cli-scaffold-"),
    );
    tmpDirs.push(parent);
    const outDir = path.join(parent, "my-plugin");
    const { exitCode, output } = await runCli([
      "scaffold",
      "my-plugin",
      `--dir=${outDir}`,
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain("문제 없음");
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);
  });

  it("--template로 템플릿을 고를 수 있다", async () => {
    const parent = mkdtempSync(
      path.join(tmpdir(), "memo-plugin-cli-scaffold-"),
    );
    tmpDirs.push(parent);
    const outDir = path.join(parent, "inline-demo");
    const { exitCode } = await runCli([
      "scaffold",
      "inline-demo",
      "--template=inline-pattern",
      `--dir=${outDir}`,
    ]);
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(
      readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    );
    expect(manifest.permissions).toEqual(["editor"]);
  });

  it("모르는 템플릿은 종료코드 1(디스크에 아무것도 안 남긴다)", async () => {
    const parent = mkdtempSync(
      path.join(tmpdir(), "memo-plugin-cli-scaffold-"),
    );
    tmpDirs.push(parent);
    const outDir = path.join(parent, "bad");
    const { exitCode, output } = await runCli([
      "scaffold",
      "bad",
      "--template=nope",
      `--dir=${outDir}`,
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("모르는 템플릿");
    expect(existsSync(outDir)).toBe(false);
  });

  it("id 없이 부르면 종료코드 1", async () => {
    const { exitCode, output } = await runCli(["scaffold"]);
    expect(exitCode).toBe(1);
    expect(output).toContain("id가 필요합니다");
  });

  it("--json은 wrote·template 필드를 포함한 유효한 JSON", async () => {
    const parent = mkdtempSync(
      path.join(tmpdir(), "memo-plugin-cli-scaffold-"),
    );
    tmpDirs.push(parent);
    const outDir = path.join(parent, "json-demo");
    const { exitCode, output } = await runCli([
      "scaffold",
      "json-demo",
      `--dir=${outDir}`,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.template).toBe("toolbar-button");
    expect(Array.isArray(parsed.wrote)).toBe(true);
    expect(parsed.wrote).toContain("manifest.json");
  });

  it("--dir 생략 시 현재 작업 폴더 아래 ./<id>에 낸다", async () => {
    const parent = mkdtempSync(
      path.join(tmpdir(), "memo-plugin-cli-scaffold-"),
    );
    tmpDirs.push(parent);
    const prevCwd = process.cwd();
    process.chdir(parent);
    try {
      const { exitCode } = await runCli(["scaffold", "default-dir-demo"]);
      expect(exitCode).toBe(0);
      expect(
        existsSync(path.join(parent, "default-dir-demo", "manifest.json")),
      ).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("runCli — types", () => {
  it("plugin-api.d.ts·settings.d.ts를 동봉하고 종료코드 0", async () => {
    const dir = makeFixturePlugin(
      "types-cli-a",
      {
        permissions: ["ui", "settings"],
        settings: [{ key: "prefix", label: "접두", type: "text", options: [] }],
      },
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const { exitCode, output } = await runCli(["types", dir]);
    expect(exitCode).toBe(0);
    expect(output).toContain("settings.d.ts");
    expect(existsSync(path.join(dir, "settings.d.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "plugin-api.d.ts"))).toBe(true);
  });

  it("dir 없이 부르면 종료코드 1", async () => {
    const { exitCode, output } = await runCli(["types"]);
    expect(exitCode).toBe(1);
    expect(output).toContain("디렉터리 경로가 필요합니다");
  });

  it("존재하지 않는 디렉터리는 종료코드 1", async () => {
    const { exitCode } = await runCli(["types", "/no/such/dir/at/all"]);
    expect(exitCode).toBe(1);
  });

  it("--json은 wrote 필드를 포함한 유효한 JSON", async () => {
    const dir = makeFixturePlugin(
      "types-cli-b",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    const { output } = await runCli(["types", dir, "--json"]);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.wrote)).toBe(true);
    expect(parsed.wrote).toContain("plugin-api.d.ts");
  });

  it("변경이 없으면 다시 부를 때 wrote가 빈 배열이다(idempotent)", async () => {
    const dir = makeFixturePlugin(
      "types-cli-c",
      { permissions: ["ui"] },
      'memo.ui.toast({ title: "hi" }).catch(function(){});',
    );
    await runCli(["types", dir]);
    const { output } = await runCli(["types", dir, "--json"]);
    const parsed = JSON.parse(output);
    expect(parsed.wrote).toEqual([]);
  });
});

describe("runCli — run/test", () => {
  const examplesDir = path.join(
    process.cwd(),
    "docs/plugin/examples/example-headless-test",
  );

  it("run은 등록 요약을 텍스트로 내고 종료코드 0", async () => {
    const { exitCode, output } = await runCli(["run", examplesDir]);
    expect(exitCode).toBe(0);
    expect(output).toContain("버튼 1개");
    expect(output).toContain("runtime.ready 호출됨: 예");
  });

  it("run --json은 dump 필드를 포함한 유효한 JSON이고 stdout에 다른 텍스트가 섞이지 않는다", async () => {
    const { exitCode, output } = await runCli(["run", examplesDir, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output); // 파싱 자체가 오염 여부의 증거다
    expect(parsed.dump.buttons.map((b: { id: string }) => b.id)).toEqual([
      "stamp-path",
    ]);
    expect(parsed.dump.ready).toBe(true);
  });

  it("run --granted로 권한을 좁히면 CALL_REJECTED 경고가 findings에 실리지만 종료코드는 0(warn)", async () => {
    const { exitCode, output } = await runCli([
      "run",
      examplesDir,
      "--granted=ui",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.warnCount).toBeGreaterThan(0);
    expect(
      parsed.findings.some((f: { code: string }) => f.code === "CALL_REJECTED"),
    ).toBe(true);
  });

  it("test는 --click|--command|--event 중 하나가 없으면 종료코드 1", async () => {
    const { exitCode, output } = await runCli(["test", examplesDir]);
    expect(exitCode).toBe(1);
    expect(output).toContain("--click|--command|--event");
  });

  it("test는 --click과 --event를 동시에 주면 종료코드 1(정확히 하나만 허용)", async () => {
    const { exitCode } = await runCli([
      "test",
      examplesDir,
      "--click=stamp-path",
      "--event=note:saved",
    ]);
    expect(exitCode).toBe(1);
  });

  it("test --click은 클릭이 낸 호출 시퀀스를 action.calls로 낸다", async () => {
    const { exitCode, output } = await runCli([
      "test",
      examplesDir,
      "--click=stamp-path",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.action.kind).toBe("click");
    expect(parsed.action.target).toBe("stamp-path");
    expect(parsed.action.calls.map((c: { call: string }) => c.call)).toEqual([
      "settings.get",
      "notes.current",
      "ui.toast",
    ]);
  });

  it("test --event는 구독 handler를 발화시킨다", async () => {
    const { output } = await runCli([
      "test",
      examplesDir,
      "--event=note:saved",
      "--json",
    ]);
    const parsed = JSON.parse(output);
    expect(parsed.action.calls.map((c: { call: string }) => c.call)).toEqual([
      "ui.toast",
    ]);
  });

  it("test --stub으로 창-스코프 호출 응답을 주입한다", async () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), "memo-plugin-cli-stub-"));
    tmpDirs.push(stubDir);
    const stubPath = path.join(stubDir, "stubs.json");
    writeFileSync(
      stubPath,
      JSON.stringify({
        "notes.current": { id: "n1", path: "/notes/a.md", content: "" },
      }),
    );
    const { output } = await runCli([
      "test",
      examplesDir,
      "--click=stamp-path",
      `--stub=${stubPath}`,
      "--json",
    ]);
    const parsed = JSON.parse(output);
    const clipboardCall = parsed.action.calls.find(
      (c: { call: string }) => c.call === "clipboard.write",
    );
    expect(clipboardCall.args.text).toBe("✓ /notes/a.md");
  });

  it("test --payload가 깨진 JSON이면 종료코드 1", async () => {
    const { exitCode, output } = await runCli([
      "test",
      examplesDir,
      "--click=stamp-path",
      "--payload={not json",
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("--payload");
  });

  it("존재하지 않는 디렉터리는 run/test 둘 다 종료코드 1", async () => {
    const run = await runCli(["run", "/no/such/dir/at/all"]);
    expect(run.exitCode).toBe(1);
    const test = await runCli(["test", "/no/such/dir/at/all", "--click=x"]);
    expect(test.exitCode).toBe(1);
  });
});

describe("runCli — --help은 새 명령을 안내한다", () => {
  it("scaffold·types·run·test가 사용법에 나온다", async () => {
    const { output } = await runCli(["--help"]);
    expect(output).toContain("scaffold <id>");
    expect(output).toContain("types <dir>");
    expect(output).toContain("run <dir>");
    expect(output).toContain("test <dir>");
    expect(output).toContain("--template=");
    expect(output).toContain("--click=");
  });
});
