/**
 * run-cmd.ts(CLI 노출) 통합 테스트 — 실물 `loadHostContract`(host-bridge.ts가 함께 노출한
 * `loadPluginForTest`/`loadPluginFromDir`)로 `runRunCommand`/`runTestCommand`가 진짜
 * `docs/plugin/examples/*` 플러그인을 실행해 등록·호출·거부를 정확히 덤프하는지 확인한다.
 *
 * 왜 mock이 아니라 실물인가: cli.test.ts와 같은 이유 — 이 커맨드의 존재 이유가 "하니스를
 * 재구현하지 않고 그대로 노출하는 것"이라, mock으로는 그 재사용이 실제로 되는지를 검증하지
 * 못한다("위험" 절). 그리고 정본 예제로 도그푸딩하면
 * `test-host.test.ts`가 이미 증명한 하니스 정확성 위에 "CLI 표면이 그걸 그대로 전달하는가"만
 * 얹어 검증할 수 있다 — 실행 의미론을 또 검증하지 않는다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHostContract, type HostContract } from "./host-bridge";
import {
  runRunCommand,
  runTestCommand,
  formatRunDumpLines,
  formatActionLines,
} from "./run-cmd";

const EXAMPLES = path.join(process.cwd(), "docs/plugin/examples");

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
  const dir = mkdtempSync(path.join(tmpdir(), "memo-plugin-run-cmd-"));
  tmpDirs.push(dir);
  return dir;
}

describe("runRunCommand — docs/plugin/examples/example-headless-test 도그푸딩", () => {
  const dir = path.join(EXAMPLES, "example-headless-test");

  it("버튼 1개·구독 1개를 등록하고 ready=true, 거부·예외 없음", async () => {
    const result = await runRunCommand(dir, contract, {});
    expect(
      result.dump?.buttons.map((b: unknown) => (b as { id: string }).id),
    ).toEqual(["stamp-path"]);
    expect(
      result.dump?.subscriptions.map(
        (s: unknown) => (s as { name: string }).name,
      ),
    ).toEqual(["note:saved"]);
    expect(result.dump?.ready).toBe(true);
    expect(result.dump?.rejections).toEqual([]);
    expect(result.dump?.errors).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("--granted로 권한을 좁히면 이벤트 구독이 거부되고 ready가 false — 실행 의미론이 그대로 재현된다", async () => {
    const result = await runRunCommand(dir, contract, { granted: ["ui"] });
    expect(result.dump?.ready).toBe(false);
    expect(result.dump?.rejections).toEqual([
      { call: "events.on", code: "PERMISSION_UNGRANTED" },
    ]);
    expect(result.findings.some((f) => f.code === "CALL_REJECTED")).toBe(true);
    // exitCodeFor 정책: 거부는 warn이라 종료코드를 막지 않는다(의도된 권한 축소 테스트일 수
    // 있으므로) — findings 안에는 error가 없어야 한다.
    expect(result.findings.every((f) => f.severity !== "error")).toBe(true);
  });

  it("존재하지 않는 디렉터리는 LOAD_FAILED error", async () => {
    const result = await runRunCommand("/no/such/plugin/dir", contract, {});
    expect(result.findings[0].severity).toBe("error");
    expect(result.findings[0].code).toBe("LOAD_FAILED");
    expect(result.dump).toBeUndefined();
  });

  it("runtime.log 메시지는 console.info로 새지 않고 dump.logs에 담긴다(--json 오염 방지)", async () => {
    const original = console.info;
    const seen: unknown[] = [];
    console.info = (...args: unknown[]) => seen.push(args);
    try {
      const result = await runRunCommand(dir, contract, { granted: ["ui"] });
      // 등록 실패 경로에서 main.js가 memo.runtime.log를 호출한다(catch 블록) — 그 메시지가
      // console.info로 새면 CLI --json 모드의 stdout이 깨진다(run-cmd.ts withSilencedRuntimeLog
      // 문서 참고). 여기서는 정보가 dump.logs로 보존됨을 함께 확인한다.
      expect(result.dump?.logs.length).toBeGreaterThan(0);
      expect(seen).toEqual([]);
    } finally {
      console.info = original;
    }
  });
});

describe("runTestCommand — 클릭/이벤트 발화 시퀀스", () => {
  const dir = path.join(EXAMPLES, "example-headless-test");

  it("--click은 onClick이 낸 호출 시퀀스만 action.calls로 골라 낸다", async () => {
    const result = await runTestCommand(dir, contract, {
      click: "stamp-path",
      stubPath: undefined,
      // 스텁 파일 대신 프로그램적으로 값을 주고 싶을 때를 위해 loadOverrides가 아니라
      // 여기서는 stubPath를 안 쓰고 대신 settings 기본값(stamp="✓ ")과 notes.current 기본
      // 스텁(null)을 그대로 쓴다 — "이 창의 메모를 찾지 못했습니다" 분기를 타는지 본다.
    });
    expect(result.action?.kind).toBe("click");
    expect(result.action?.target).toBe("stamp-path");
    // notes.current 스텁 기본값은 null이므로 "메모를 찾지 못했습니다" 토스트로 빠진다.
    expect(
      result.action?.calls.map((c: unknown) => (c as { call: string }).call),
    ).toEqual(["settings.get", "notes.current", "ui.toast"]);
    // action.calls는 로드 시점 호출(ui.addToolbarButton·events.on·runtime.ready)을 담지
    // 않는다 — dump.calls 전체 길이가 action.calls보다 커야 한다.
    expect(result.dump!.calls.length).toBeGreaterThan(
      result.action!.calls.length,
    );
  });

  it("--stub으로 notes.current를 주입하면 클립보드 복사 경로를 탄다", async () => {
    const stubDir = freshDir();
    const stubPath = path.join(stubDir, "stubs.json");
    writeFileSync(
      stubPath,
      JSON.stringify({
        "notes.current": { id: "n1", path: "/notes/a.md", content: "" },
      }),
    );
    const result = await runTestCommand(dir, contract, {
      click: "stamp-path",
      stubPath,
    });
    const clipboardCall = result.action?.calls.find(
      (c) => (c as { call: string }).call === "clipboard.write",
    ) as { args: { text: string } } | undefined;
    expect(clipboardCall?.args.text).toBe("✓ /notes/a.md");
  });

  it("--event로 note:saved를 발화하면 구독 handler가 토스트한다", async () => {
    const result = await runTestCommand(dir, contract, {
      event: "note:saved",
    });
    expect(result.action?.kind).toBe("event");
    expect(
      result.action?.calls.map((c: unknown) => (c as { call: string }).call),
    ).toEqual(["ui.toast"]);
  });

  it("등록되지 않은 버튼 id는 ACTION_FAILED error를 내고 dump는 그래도 돌려준다", async () => {
    const result = await runTestCommand(dir, contract, { click: "nope" });
    expect(result.findings[0].code).toBe("ACTION_FAILED");
    expect(result.findings[0].severity).toBe("error");
    expect(result.dump).toBeDefined();
  });

  it("--settings로 도장을 바꿔 클릭하면 바뀐 도장이 실린다", async () => {
    const settingsDir = freshDir();
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ stamp: "★ " }));
    const stubPath = path.join(settingsDir, "stubs.json");
    writeFileSync(
      stubPath,
      JSON.stringify({
        "notes.current": { id: "n1", path: "/notes/a.md", content: "" },
      }),
    );
    const result = await runTestCommand(dir, contract, {
      click: "stamp-path",
      settingsPath,
      stubPath,
    });
    const clipboardCall = result.action?.calls.find(
      (c) => (c as { call: string }).call === "clipboard.write",
    ) as { args: { text: string } } | undefined;
    expect(clipboardCall?.args.text).toBe("★ /notes/a.md");
  });

  it("--stub 파일이 깨진 JSON이면 OPTION_FILE_INVALID_JSON error", async () => {
    const badDir = freshDir();
    const stubPath = path.join(badDir, "stubs.json");
    writeFileSync(stubPath, "{ not json");
    const result = await runTestCommand(dir, contract, {
      click: "stamp-path",
      stubPath,
    });
    expect(
      result.findings.some((f) => f.code === "OPTION_FILE_INVALID_JSON"),
    ).toBe(true);
  });
});

describe("runTestCommand — 메뉴 항목(--menu) 발화", () => {
  function makeMenuPlugin(
    id: string,
    permissions: string[],
    code: string,
  ): string {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        entry: "main.js",
        kind: "action",
        permissions,
      }),
    );
    writeFileSync(path.join(dir, "main.js"), code);
    return dir;
  }

  /**
   * 가드(웨이브 D 약속): addMenuItem의 run 본문을 앱 없이 --menu로 발화시킬 수 있다. 예전엔
   * kind가 click/command/event뿐이라 메뉴 항목의 run은 헤드리스로 검증할 방법이 없었다
   * (--command=<id>를 줘도 commands.register 등록만 매칭돼 아무 일도 안 일어났다).
   */
  it("--menu는 등록된 메뉴 항목의 run을 발화시킨다", async () => {
    const dir = makeMenuPlugin(
      "menu-run",
      ["ui"],
      `memo.ui.addMenuItem({
         id: "wrap",
         label: "감싸기",
         run: function (memo) { memo.ui.toast({ title: "메뉴 실행됨" }); },
       }).then(function () { return memo.runtime.ready(); }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, { menu: "wrap" });
    expect(result.findings).toEqual([]);
    expect(result.action?.kind).toBe("menu");
    expect(result.action?.target).toBe("wrap");
    expect(
      result.action?.calls.map((c: unknown) => (c as { call: string }).call),
    ).toEqual(["ui.toast"]);
  });

  /**
   * 가드: --payload의 selectedText가 run의 payload로 흐른다 — 단 중앙 호스트와 같은 게이트로
   * notes:read를 선언·부여받았을 때만 채워진다(하니스가 그 판정을 재현한다).
   */
  it("--payload의 selectedText가 run으로 흐른다(notes:read 게이트)", async () => {
    const dir = makeMenuPlugin(
      "menu-selection",
      ["ui", "notes:read"],
      `memo.ui.addMenuItem({
         id: "upper",
         label: "대문자로",
         when: ["note.hasSelection"],
         run: function (memo, payload) {
           if (payload.selectedText) memo.ui.toast({ title: payload.selectedText });
         },
       }).then(function () { return memo.runtime.ready(); }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, {
      menu: "upper",
      payload: { selectedText: "hi" },
    });
    expect(result.findings).toEqual([]);
    const toast = result.action?.calls.find(
      (c) => (c as { call: string }).call === "ui.toast",
    ) as { args: { title: string } } | undefined;
    expect(toast?.args.title).toBe("hi");
  });

  it("등록되지 않은 메뉴 항목 id는 ACTION_FAILED error를 낸다", async () => {
    const dir = makeMenuPlugin(
      "menu-empty",
      ["ui"],
      `memo.runtime.ready().catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, { menu: "nope" });
    expect(result.findings[0].code).toBe("ACTION_FAILED");
    expect(result.dump).toBeDefined();
  });

  /** 가드(웨이브 F2 약속): addTrayItem의 run 본문을 앱 없이 --tray로 발화시킬 수 있다 —
   * 트레이는 앱 전역 자원이라 예전엔 실제 macOS 앱에서 메뉴바를 클릭하는 것 외엔 확인 경로가
   * 없었다(하니스가 그 run을 헤드리스로 발화시킨다). 창 컨텍스트도 payload도 없다. */
  it("--tray는 등록된 트레이 항목의 run을 발화시킨다", async () => {
    const dir = makeMenuPlugin(
      "tray-run",
      ["ui"],
      `memo.ui.addTrayItem({
         id: "hide",
         label: "숨기기",
         run: function (memo) { memo.ui.toast({ title: "트레이 실행됨" }); },
       }).then(function () { return memo.runtime.ready(); }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, { tray: "hide" });
    expect(result.findings).toEqual([]);
    expect(result.action?.kind).toBe("tray");
    expect(result.action?.target).toBe("hide");
    expect(
      result.action?.calls.map((c: unknown) => (c as { call: string }).call),
    ).toEqual(["ui.toast"]);
  });

  /** 가드: addSelectionAction의 run 본문을 앱 없이 --selection으로 발화시킬 수 있다 —
   * 선택 툴바는 마우스 드래그가 있어야 뜨므로, 하니스가 없으면 실앱 밖에서 확인할 길이 없다.
   * `--payload`의 selectedText는 메뉴 항목과 같은 notes:read 게이트를 탄다. */
  it("--selection은 등록된 선택 액션의 run을 선택 텍스트와 함께 발화시킨다", async () => {
    const dir = makeMenuPlugin(
      "selection-run",
      ["ui", "notes:read"],
      `memo.ui.addSelectionAction({
         id: "calc",
         label: "=",
         match: { charClasses: ["digit", "operator"], singleLine: true },
         run: function (memo, payload) { memo.ui.toast({ title: payload.selectedText }); },
       }).then(function () { return memo.runtime.ready(); }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, {
      selection: "calc",
      payload: { selectedText: "1+1" },
    });
    expect(result.findings).toEqual([]);
    expect(result.action?.kind).toBe("selection");
    expect(result.action?.target).toBe("calc");
    const toast = result.action?.calls.find(
      (c) => (c as { call: string }).call === "ui.toast",
    ) as { args: { title: string } } | undefined;
    expect(toast?.args.title).toBe("1+1");
  });

  /**
   * 가드(거짓 그린 방지, 핵심): `match`와 맞지 않는 선택으로 발화하면 ACTION_FAILED다.
   * 앱에서는 그 선택에 버튼이 뜨지도 않으므로, 하니스가 그냥 실행해 주면 "CLI는 초록인데
   * 앱에서는 눌러지지 않는" 어긋남이 그대로 남는다.
   */
  it("match와 맞지 않는 --payload는 ACTION_FAILED로 드러난다", async () => {
    const dir = makeMenuPlugin(
      "selection-mismatch",
      ["ui", "notes:read"],
      `memo.ui.addSelectionAction({
         id: "calc",
         label: "=",
         match: { charClasses: ["digit"] },
         run: function (memo, payload) { memo.ui.toast({ title: "실행됨" }); },
       }).then(function () { return memo.runtime.ready(); }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, {
      selection: "calc",
      payload: { selectedText: "글자" },
    });
    expect(result.findings[0].code).toBe("ACTION_FAILED");
    expect(result.findings[0].message).toContain("match와 맞지 않는");
  });
});

describe("동기 throw — errors가 findings로 승격된다", () => {
  function makeFixturePlugin(id: string, code: string): string {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        entry: "main.js",
        permissions: ["ui"],
      }),
    );
    writeFileSync(path.join(dir, "main.js"), code);
    return dir;
  }

  it("onClick이 동기적으로 던지면 RUNTIME_THROW error + errors 배열에 기록", async () => {
    const dir = makeFixturePlugin(
      "throws-on-click",
      `memo.ui.addToolbarButton({
         id: "boom",
         label: "x",
         onClick: function () { throw new Error("kaboom"); },
       }).catch(function(){});`,
    );
    const result = await runTestCommand(dir, contract, { click: "boom" });
    expect(result.dump?.errors).toEqual(["kaboom"]);
    expect(
      result.findings.some(
        (f) => f.code === "RUNTIME_THROW" && f.severity === "error",
      ),
    ).toBe(true);
  });
});

describe("미처리 거부(unhandledRejection) — 크래시 대신 findings로 흡수(finding 12)", () => {
  function makePlugin(id: string, permissions: string[], code: string): string {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        entry: "main.js",
        permissions,
      }),
    );
    writeFileSync(path.join(dir, "main.js"), code);
    return dir;
  }

  it("반환되지 않은 거부 프라미스가 새어도 크래시 없이 UNHANDLED_REJECTION 경고로 남고 dump를 낸다", async () => {
    // addStatusItem 정본 예제 패턴 + 권한 선언 누락: .then 안의 notes.write가
    // PERMISSION_UNDECLARED로 거부되는데 return도 .catch도 안 해 거부 프라미스가 흘러 나간다.
    // 이 흡수가 없으면 Node가 프로세스를 죽여 --json 계약이 깨진다(JSON 한 글자도 안 나옴).
    const dir = makePlugin(
      "leaks-rejection",
      ["ui"],
      `memo.ui.addStatusItem({ id: "wc", text: "0" }).then(function () {
         memo.notes.write({ id: "x", content: "y" });
         return memo.runtime.ready();
       });`,
    );
    const result = await runRunCommand(dir, contract, {});
    expect(result.dump).toBeDefined();
    expect(result.findings.some((f) => f.code === "UNHANDLED_REJECTION")).toBe(
      true,
    );
    // 흡수는 warn이라 종료코드를 막지 않는다(거부·진단과 같은 정책).
    expect(
      result.findings
        .filter((f) => f.code === "UNHANDLED_REJECTION")
        .every((f) => f.severity === "warn"),
    ).toBe(true);
  });
});

describe("formatRunDumpLines / formatActionLines — 텍스트 요약", () => {
  it("빈 dump에도 4줄 요약을 낸다", () => {
    const lines = formatRunDumpLines({
      id: "x",
      ready: false,
      buttons: [],
      patterns: [],
      completions: [],
      embeds: [],
      commands: [],
      subscriptions: [],
      menuItems: [],
      selectionActions: [],
      statusItems: [],
      trayItems: [],
      theme: null,
      background: null,
      font: null,
      windowControls: [],
      calls: [],
      rejections: [],
      diagnostics: [],
      errors: [],
      logs: [],
    });
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("runtime.ready 호출됨: 아니오");
  });

  it("action이 없으면 빈 배열", () => {
    expect(formatActionLines(undefined)).toEqual([]);
  });

  it("action.calls를 성공/거부로 나눠 보여준다", () => {
    const lines = formatActionLines({
      kind: "click",
      target: "btn",
      payload: undefined,
      calls: [
        { call: "ui.toast", ok: true },
        { call: "notes.read", ok: false, code: "PERMISSION_UNGRANTED" },
      ],
    });
    expect(lines.some((l) => l.includes("ui.toast 성공"))).toBe(true);
    expect(
      lines.some((l) => l.includes("notes.read 거부(PERMISSION_UNGRANTED)")),
    ).toBe(true);
  });
});
