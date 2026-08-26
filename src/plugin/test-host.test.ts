/**
 * 헤드리스 하니스 가드 — 하니스가 **저작자의 진짜 플러그인을 실제로 돌려** 단언을
 * 통과시킴을 증명한다.
 *
 * 역할: 두 층으로 검증한다 — (1) **도그푸딩**: 정본 예제(`docs/plugin/examples/*`)를 하니스로
 * 로드·실행해 등록·호출이 실제로 일어남을 단언하고, (2) **기능 단위**: 인라인 플러그인으로
 * 하니스의 각 능력(버튼 클릭·설정 주입·창-스코프 스텁·이벤트 발화·명령 실행·권한 거부·
 * 능력 kind 게이트)을 하나씩 못박는다.
 * 왜: "하니스가 있다"가 아니라 "하니스가 실제로 플러그인을 돌린다"가 이 임무의 완료 정의다.
 */
import { describe, it, expect } from "vitest";
import {
  loadPluginForTest,
  loadPluginFromDir,
  type LoadPluginOptions,
  type HeadlessPlugin,
} from "./test-host";

const EXAMPLES = "docs/plugin/examples";

/** 인라인 매니페스트 헬퍼(검증기가 요구하는 최소 필드 + 선택 설정 스키마). */
function manifest(
  id: string,
  permissions: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    entry: "main.js",
    permissions,
    ...extra,
  };
}

describe("도그푸딩: 정본 예제를 하니스로 실행", () => {
  it("example-starter — 인라인 패턴을 등록하고 마감한다", async () => {
    const p: HeadlessPlugin = await loadPluginFromDir(
      `${EXAMPLES}/example-starter`,
    );
    expect(p.rejections).toEqual([]);
    expect(p.patterns.map((x) => x.id)).toEqual(["highlight"]);
    // 클래스는 플러그인 값이 아니라 호스트가 파생한다(셀렉터 하이재킹 차단) — 진짜 수집기를
    // 쓰므로 이 파생이 그대로 나타난다.
    expect(p.patterns[0].className).toBe("cm-x-example-starter-highlight");
    expect(p.ready).toBe(true);
    expect(p.errors).toEqual([]);
  });

  it("example-toolbar-button — 클릭하면 설정 접두 + 경로를 복사·알린다", async () => {
    const p = await loadPluginFromDir(`${EXAMPLES}/example-toolbar-button`, {
      settings: { prefix: "경로: " },
      stubs: {
        "notes.current": { id: "n1", path: "/notes/a.md", content: "본문" },
      },
    });
    expect(p.buttons.map((b) => b.id)).toEqual(["copy-path"]);
    await p.clickButton("copy-path");
    expect(p.rejections).toEqual([]);
    expect(p.callsTo("clipboard.write")[0].args.text).toBe("경로: /notes/a.md");
    expect(p.callsTo("ui.toast")[0].args.title).toBe("경로를 복사했습니다");
  });

  it("example-toolbar-button — 창 컨텍스트가 없으면(null) '찾지 못했습니다'로 끝난다", async () => {
    // 기본 스텁의 notes.current는 null이다(대상 창 없음) — 예제의 null 분기를 탄다.
    const p = await loadPluginFromDir(`${EXAMPLES}/example-toolbar-button`);
    await p.clickButton("copy-path");
    expect(p.rejections).toEqual([]);
    expect(p.callsTo("clipboard.write")).toEqual([]); // 복사까지 가지 않는다
    expect(p.callsTo("ui.toast")[0].args.title).toBe(
      "이 창의 메모를 찾지 못했습니다",
    );
  });

  it("example-note-picker — 목록→선택→읽기→삽입 체인을 잇는다", async () => {
    const p = await loadPluginFromDir(`${EXAMPLES}/example-note-picker`, {
      stubs: {
        "notes.list": [
          { id: "first", title: "첫 노트", hidden: false, createdAt: 1 },
          { id: "ghost", title: "숨김", hidden: true, createdAt: 2 },
        ],
        "ui.pickList": "first",
        "notes.read": { id: "first", content: "첫 노트\n본문" },
      },
    });
    await p.clickButton("pick-note");
    expect(p.rejections).toEqual([]);
    expect(p.calls.map((c) => c.call)).toEqual(
      expect.arrayContaining([
        "notes.list",
        "ui.pickList",
        "notes.read",
        "editor.insertText",
        "ui.toast",
      ]),
    );
    // 숨긴 노트는 pickList 후보에서 빠진다(예제의 계약).
    const pick = p.callsTo("ui.pickList")[0].args.items as { id: string }[];
    expect(pick.map((i) => i.id)).toEqual(["first"]);
    expect(p.callsTo("editor.insertText")[0].args.text).toBe("첫 노트\n본문");
  });

  it("example-window-calls — 입력→삽입→글자크기→알림을 순차로 잇고 클램프한다", async () => {
    const p = await loadPluginFromDir(`${EXAMPLES}/example-window-calls`, {
      stubs: {
        "ui.prompt": "오늘의 할 일",
        "editor.getFontDelta": 48, // +5하면 53 → setFontDelta가 50으로 클램프
      },
    });
    await p.clickButton("insert-heading");
    expect(p.rejections).toEqual([]);
    expect(p.callsTo("editor.insertText")[0].args.text).toBe(
      "# 오늘의 할 일\n",
    );
    // setFontDelta는 요청값(53)이 아니라 실제 클램프값(50)을 돌려주고, 예제는 그 값으로 알린다.
    expect(p.callsTo("editor.setFontDelta")[0].args.value).toBe(53);
    expect(p.callsTo("ui.toast")[0].args.title).toBe(
      "머리말을 넣고 글자를 50%로 맞췄습니다",
    );
  });

  it("example-settings-button — 명령을 등록하고, 실행하면 경로를 알린다", async () => {
    const p = await loadPluginFromDir(`${EXAMPLES}/example-settings-button`, {
      stubs: {
        "notes.current": { id: "n1", path: "/notes/here.md", content: "" },
      },
    });
    expect(p.commands.map((c) => c.id)).toEqual(["where-am-i"]);
    await p.runCommand("where-am-i");
    expect(p.rejections).toEqual([]);
    expect(p.callsTo("ui.toast")[0].args.message).toBe("/notes/here.md");
  });

  it("example-headless-test — 버튼·구독을 등록하고 둘 다 실행된다(새 예제)", async () => {
    const p = await loadPluginFromDir(`${EXAMPLES}/example-headless-test`, {
      stubs: {
        "notes.current": { id: "n1", path: "/notes/오늘.md", content: "" },
      },
    });
    expect(p.buttons.map((b) => b.id)).toEqual(["stamp-path"]);
    expect(p.subscriptions.map((s) => s.name)).toEqual(["note:saved"]);
    expect(p.ready).toBe(true);
    expect(p.rejections).toEqual([]);

    p.setSetting("stamp", "★ ");
    await p.clickButton("stamp-path");
    expect(p.callsTo("clipboard.write")[0].args.text).toBe("★ /notes/오늘.md");

    await p.emitEvent("note:saved", { id: "n1" });
    expect(p.callsTo("ui.toast").map((c) => c.args.title)).toContain("저장됨");
  });
});

describe("하니스 기능 — 등록 조회", () => {
  it("버튼은 자동 id·upsert·위치 정규화를 진짜 계약대로 처리한다", async () => {
    const code = `
      memo.ui.addToolbarButton({ label: "A", position: "bogus", onClick: function(){} });
      memo.ui.addToolbarButton({ id: "b", label: "1", position: "top-right", onClick: function(){} });
      memo.ui.addToolbarButton({ id: "b", label: "2", position: "bottom-left", onClick: function(){} });
      memo.runtime.ready();
    `;
    // 로드 옵션을 명시적으로 타이핑한다(공개 계약 LoadPluginOptions 사용).
    const opts: LoadPluginOptions = { manifest: manifest("m", ["ui"]), code };
    const p = await loadPluginForTest(opts);
    // 첫 버튼은 id 생략 → 자동 id, 모르는 위치 → top-left로 정규화.
    expect(p.buttons[0].id).toBe("m:ui.addToolbarButton:1");
    expect(p.buttons[0].position).toBe("top-left");
    // 같은 id "b"는 append가 아니라 치환(자리 유지) — 라벨은 마지막 값.
    expect(p.buttons.map((b) => `${b.id}:${b.label}`)).toEqual([
      "m:ui.addToolbarButton:1:A",
      "b:2",
    ]);
    expect(
      p.diagnostics.filter((d) => d.kind === "duplicate-registration"),
    ).toHaveLength(1);
  });

  it("능력 등록은 kind 게이트를 탄다(action은 거부, capability는 수집)", async () => {
    const code = `memo.theme.register({ tokens: { accent: "#111111" } }).catch(function(){}); memo.runtime.ready();`;
    const action = await loadPluginForTest({
      manifest: manifest("a", ["theme"], { kind: "action" }),
      code,
    });
    expect(action.theme).toBeNull();
    expect(action.rejections).toEqual([
      { call: "theme.register", code: "WRONG_PLUGIN_KIND" },
    ]);

    const cap = await loadPluginForTest({
      manifest: manifest("c", ["theme"], { kind: "capability" }),
      code,
    });
    expect(cap.rejections).toEqual([]);
    expect(cap.theme?.tokens).toEqual({ accent: "#111111" });
  });
});

describe("하니스 기능 — 권한 거부(진짜 게이트키퍼)", () => {
  it("미선언 권한 호출은 PERMISSION_UNDECLARED로 거부되고 스냅샷에 안 남는다", async () => {
    const code = `memo.ui.toast({ title: "hi" }).catch(function(){}); memo.runtime.ready();`;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["editor"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "ui.toast", code: "PERMISSION_UNDECLARED" },
    ]);
  });

  it("선언했지만 미부여한 민감 권한은 PERMISSION_UNGRANTED로 거부된다", async () => {
    const code = `memo.notes.current().catch(function(){}); memo.runtime.ready();`;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["notes:read"]),
      code,
      granted: [], // 선언은 했지만 사용자가 승인하지 않음
    });
    expect(p.rejections).toEqual([
      { call: "notes.current", code: "PERMISSION_UNGRANTED" },
    ]);
  });

  it("이벤트 이름별 추가 권한을 좁혀 검사한다(note:*는 notes:read 필요)", async () => {
    const code = `
      memo.events.on({ name: "note:saved", handler: function(){} }).catch(function(){});
      memo.events.on({ name: "settings:changed", handler: function(){} }).catch(function(){});
      memo.runtime.ready();
    `;
    // settings만 선언 → settings:changed는 되지만 note:saved는 notes:read 미선언으로 거부.
    const p = await loadPluginForTest({
      manifest: manifest("m", ["settings"]),
      code,
    });
    expect(p.subscriptions.map((s) => s.name)).toEqual(["settings:changed"]);
    expect(p.rejections).toEqual([
      { call: "events.on", code: "PERMISSION_UNDECLARED" },
    ]);
  });

  it("예약 호출은 RESERVED_CALL로 거부된다", async () => {
    // vault.read는 아직 예약이다(에서 network.fetch가 예약 해제됐으므로 이 예시를 옮겼다).
    const code = `memo.vault.read({ path: "x" }).catch(function(){}); memo.runtime.ready();`;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["vault:read"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "vault.read", code: "RESERVED_CALL" },
    ]);
  });
});

describe("하니스 기능 — 창-스코프 스텁·설정 주입·이벤트", () => {
  it("스텁을 함수로 주면 인자를 받아 응답을 만든다", async () => {
    const code = `
      memo.ui.addToolbarButton({ id: "b", label: "B", position: "top-left", onClick: function(memo){
        memo.notes.read({ id: "k1" }).then(function(note){
          memo.editor.insertText({ text: note.content });
        }).catch(function(){});
      }});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui", "notes:all-read", "notes:write"]),
      code,
    });
    p.stub("notes.read", (args: Record<string, unknown>) => ({
      id: args.id,
      content: "읽음:" + args.id,
    }));
    await p.clickButton("b");
    expect(p.callsTo("editor.insertText")[0].args.text).toBe("읽음:k1");
  });

  it("설정을 주입하면 플러그인이 구조화된 값을 본다(list → 배열)", async () => {
    const code = `
      memo.ui.addToolbarButton({ id: "b", label: "B", position: "top-left", onClick: function(memo){
        memo.settings.getAll().then(function(cfg){
          memo.ui.toast({ title: JSON.stringify(cfg) });
        }).catch(function(){});
      }});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui", "settings"], {
        settings: [
          {
            key: "prefix",
            label: "접두",
            type: "text",
            default: "»",
            options: [],
          },
          { key: "tpls", label: "템플릿", type: "list", options: [] },
        ],
      }),
      code,
      settings: { tpls: "=== A ===\n본문" },
    });
    // 매니페스트 기본값(»)이 런타임에 도달하고, list는 {name,body}[]로 구조화된다.
    expect(p.getSetting("prefix")).toBe("»");
    expect(p.getSetting("tpls")).toEqual([{ name: "A", body: "본문" }]);
    await p.clickButton("b");
    expect(JSON.parse(String(p.callsTo("ui.toast")[0].args.title))).toEqual({
      prefix: "»",
      tpls: [{ name: "A", body: "본문" }],
    });
  });

  it("emitEvent는 그 이름의 모든 구독을 바인딩된 memo로 역호출한다", async () => {
    const code = `
      memo.events.on({ name: "settings:changed", handler: function(memo, payload){
        memo.ui.toast({ title: "changed:" + payload.key });
      }}).then(function(){ return memo.runtime.ready(); }).catch(function(){});
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["settings", "ui"]),
      code,
    });
    await p.emitEvent("settings:changed", { key: "tone" });
    expect(p.callsTo("ui.toast")[0].args.title).toBe("changed:tone");
  });
});

describe("하니스 기능 — 계약 위반·오류 노출", () => {
  it("인자 2개 이상은 동기 TypeError로 죽고, 그전 등록은 살아남는다", async () => {
    const code = `
      memo.editor.registerInlinePattern({ id: "p", open: "==", close: "==" });
      memo.settings.set("k", "v"); // ← 인자 2개: 부트스트랩과 같은 TypeError
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["editor", "settings"]),
      code,
    });
    // 예외 이전의 등록은 수집되고, 던진 예외는 errors에 남는다(로드는 실패하지 않는다).
    expect(p.patterns.map((x) => x.id)).toEqual(["p"]);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toBeInstanceOf(TypeError);
    expect(p.ready).toBe(false); // ready 이전에 죽었다
  });

  it("역호출 핸들러가 동기적으로 던지면 errors에 담기고 로드는 계속된다", async () => {
    const code = `
      memo.ui.addToolbarButton({ id: "b", label: "B", position: "top-left", onClick: function(){
        throw new Error("boom");
      }});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    await p.clickButton("b");
    expect(p.errors.map((e) => e.message)).toEqual(["boom"]);
  });

  it("깨진 매니페스트는 로드 시 throw한다(사유 포함)", async () => {
    await expect(
      loadPluginForTest({ manifest: { id: "" }, code: "" }),
    ).rejects.toThrow(/플러그인 로드 실패/);
  });

  it("없는 버튼·명령을 실행하면 무엇이 등록됐는지와 함께 throw한다", async () => {
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code: `memo.runtime.ready();`,
    });
    await expect(p.clickButton("nope")).rejects.toThrow(/등록되지 않은 버튼/);
  });
});

describe("하니스 기능 — 트레이 항목 등록·역호출", () => {
  /** 가드: 트레이 항목이 등록되고 invokeTrayItem이 창 컨텍스트·payload 없이 run을 발화한다 —
   * 중앙 호스트 invokeTrayItem과 같은 계약(빈 토큰·빈 객체). 이 분기가 없으면 addTrayItem이
   * resolveStub로 떨어져 '조용한 성공(무등록)'이 돼 저작자가 거짓 그린을 받는다. */
  it("addTrayItem을 등록하고 invokeTrayItem이 run을 빈 payload로 역호출한다", async () => {
    const code = `
      memo.ui.addTrayItem({ id: "hide", label: "숨기기", run: function(memo, payload){
        memo.ui.toast({ title: "tray:" + JSON.stringify(payload) });
      }});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.rejections).toEqual([]);
    expect(p.trayItems.map((t) => t.id)).toEqual(["hide"]);
    expect(p.trayItems[0].label).toBe("숨기기");
    await p.invokeTrayItem("hide");
    // 중앙 호스트가 항상 빈 객체를 싣는다 — run은 {}를 본다(undefined가 아니다).
    expect(p.callsTo("ui.toast")[0].args.title).toBe("tray:{}");
  });

  /** 가드: run 함수가 없으면 중앙 호스트와 같은 코드(INVALID_ARGS)로 거부된다 — 조용한 성공이
   * 아니다. 눌러도 죽는 유령 항목을 만들지 않는다. */
  it("run 함수 없는 addTrayItem은 INVALID_ARGS로 거부된다(거짓 그린 방지)", async () => {
    const code = `memo.ui.addTrayItem({ id: "x", label: "라벨" }).catch(function(){}); memo.runtime.ready();`;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "ui.addTrayItem", code: "INVALID_ARGS" },
    ]);
    expect(p.trayItems).toEqual([]);
  });

  /** 가드: 빈 label도 중앙 호스트와 같이 INVALID_ARGS로 거부된다(트레이에 보일 이름이 없다). */
  it("빈 label의 addTrayItem은 INVALID_ARGS로 거부된다", async () => {
    const code = `memo.ui.addTrayItem({ id: "x", label: "  ", run: function(){} }).catch(function(){}); memo.runtime.ready();`;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "ui.addTrayItem", code: "INVALID_ARGS" },
    ]);
    expect(p.trayItems).toEqual([]);
  });

  /** 가드: 같은 id로 다시 등록하면 앞의 것을 대체하고 진단이 남는다(버튼·메뉴와 같은 계약). */
  it("같은 id 재등록은 대체하고 중복 진단을 남긴다", async () => {
    const code = `
      memo.ui.addTrayItem({ id: "t", label: "첫째", run: function(){} });
      memo.ui.addTrayItem({ id: "t", label: "둘째", run: function(){} });
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.trayItems.map((t) => t.label)).toEqual(["둘째"]);
    expect(
      p.diagnostics.filter(
        (d) =>
          d.kind === "duplicate-registration" && d.call === "ui.addTrayItem",
      ),
    ).toHaveLength(1);
  });

  /** 가드: 없는 트레이 id를 역호출하면 무엇이 등록됐는지와 함께 throw한다(버튼·메뉴와 같은 계약). */
  it("없는 트레이 항목을 역호출하면 throw한다", async () => {
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code: `memo.ui.addTrayItem({ id: "t", label: "T", run: function(){} }); memo.runtime.ready();`,
    });
    await expect(p.invokeTrayItem("nope")).rejects.toThrow(
      /등록되지 않은 트레이 항목/,
    );
  });
});

describe("하니스 기능 — 선택 액션 등록·역호출", () => {
  /** 가드: 선택 액션이 등록되고 `match`가 정규화돼 노출된다 — 이 분기가 없으면
   * addSelectionAction이 resolveStub로 떨어져 '조용한 성공(무등록)'이 돼 거짓 그린이 된다. */
  it("addSelectionAction을 등록하고 정규화된 match를 노출한다", async () => {
    const code = `
      memo.ui.addSelectionAction({
        id: "calc", label: "=", title: "선택 계산",
        match: { charClasses: ["digit", "operator"], singleLine: true, maxLength: 200 },
        run: function(memo, payload){ memo.ui.toast({ title: "sel:" + JSON.stringify(payload) }); }
      });
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui", "notes:read"]),
      code,
    });
    expect(p.rejections).toEqual([]);
    expect(p.selectionActions.map((a) => a.id)).toEqual(["calc"]);
    expect(p.selectionActions[0].title).toBe("선택 계산");
    expect(p.selectionActions[0].match).toEqual({
      charClasses: ["digit", "operator"],
      singleLine: true,
      maxLength: 200,
    });
    expect(p.selectionActions[0].needsSelectedText).toBe(true);
    await p.invokeSelectionAction("calc", { selectedText: "1+1" });
    expect(p.callsTo("ui.toast")[0].args.title).toBe(
      'sel:{"selectedText":"1+1"}',
    );
  });

  /** 가드(payload 게이트): notes:read가 없으면 하니스도 선택 텍스트를 싣지 않는다(앱과 같다). */
  it("notes:read가 없으면 selectedText를 payload에 싣지 않는다", async () => {
    const code = `
      memo.ui.addSelectionAction({ id: "calc", label: "=", run: function(memo, payload){
        memo.ui.toast({ title: "sel:" + JSON.stringify(payload) });
      }});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.selectionActions[0].needsSelectedText).toBe(false);
    await p.invokeSelectionAction("calc", { selectedText: "1+1" });
    expect(p.callsTo("ui.toast")[0].args.title).toBe("sel:{}");
  });

  /** 가드: run·label이 없으면 중앙 호스트와 같은 코드(INVALID_ARGS)로 거부된다(거짓 그린 방지). */
  it("run·label 없는 addSelectionAction은 INVALID_ARGS로 거부된다", async () => {
    const code = `
      memo.ui.addSelectionAction({ id: "a", label: "=" }).catch(function(){});
      memo.ui.addSelectionAction({ id: "b", label: "  ", run: function(){} }).catch(function(){});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "ui.addSelectionAction", code: "INVALID_ARGS" },
      { call: "ui.addSelectionAction", code: "INVALID_ARGS" },
    ]);
    expect(p.selectionActions).toEqual([]);
  });

  /** 가드(어휘): 어휘 밖 match는 하니스에서도 등록 시점에 거부된다 — 앱과 같은 순수 함수를 쓴다. */
  it("어휘 밖 match는 INVALID_ARGS로 거부된다", async () => {
    const code = `
      memo.ui.addSelectionAction({ id: "a", label: "=", match: { charClasses: ["emoji"] }, run: function(){} }).catch(function(){});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.rejections).toEqual([
      { call: "ui.addSelectionAction", code: "INVALID_ARGS" },
    ]);
    expect(p.selectionActions).toEqual([]);
  });

  /**
   * 가드(거짓 그린 방지, 핵심): `match`가 맞지 않는 선택으로 역호출하면 던진다.
   *
   * 앱에서는 그런 선택에 버튼이 뜨지도 않고 단축키도 아무 일을 하지 않는다 — 하니스가 그냥
   * 실행해 주면 "테스트는 통과인데 앱에서는 눌러지지 않는" 정확히 그 어긋남이 생긴다.
   */
  it("match와 맞지 않는 선택으로 역호출하면 이유와 함께 throw한다", async () => {
    const code = `
      memo.ui.addSelectionAction({ id: "calc", label: "=", match: { charClasses: ["digit"] }, run: function(){} });
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    await expect(
      p.invokeSelectionAction("calc", { selectedText: "글자" }),
    ).rejects.toThrow(/match와 맞지 않는/);
    // 조건에 맞는 선택은 그대로 실행된다.
    await expect(
      p.invokeSelectionAction("calc", { selectedText: "123" }),
    ).resolves.toBeUndefined();
  });

  /** 가드: 같은 id 재등록은 대체하고 진단이 남는다(버튼·메뉴·트레이와 같은 계약). */
  it("같은 id 재등록은 대체하고 중복 진단을 남긴다", async () => {
    const code = `
      memo.ui.addSelectionAction({ id: "s", label: "첫째", run: function(){} });
      memo.ui.addSelectionAction({ id: "s", label: "둘째", run: function(){} });
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code,
    });
    expect(p.selectionActions.map((a) => a.label)).toEqual(["둘째"]);
    expect(
      p.diagnostics.filter(
        (d) =>
          d.kind === "duplicate-registration" &&
          d.call === "ui.addSelectionAction",
      ),
    ).toHaveLength(1);
  });

  /** 가드: 없는 id를 역호출하면 무엇이 등록됐는지와 함께 throw한다(버튼·메뉴와 같은 계약). */
  it("없는 선택 액션을 역호출하면 throw한다", async () => {
    const p = await loadPluginForTest({
      manifest: manifest("m", ["ui"]),
      code: `memo.ui.addSelectionAction({ id: "s", label: "=", run: function(){} }); memo.runtime.ready();`,
    });
    await expect(p.invokeSelectionAction("nope")).rejects.toThrow(
      /등록되지 않은 선택 액션/,
    );
  });
});

describe("하니스 기능 — commands.invoke는 정직하게 거부한다", () => {
  /** 가드(거짓 그린 방지): 단일-플러그인 하니스에는 릴레이 대상이 존재할 수 없으므로,
   * commands.invoke는 조용히 null로 '성공'하는 대신 하니스 전용 코드로 시끄럽게 거부돼야 한다 —
   * 안 그러면 대상·commandId·exposes 배선이 틀려도 프로덕션의 성공(null)과 구분되지 않는다. */
  it("commands.invoke는 조용한 성공이 아니라 HARNESS_UNSUPPORTED로 거부된다", async () => {
    const code = `
      memo.commands.invoke({ pluginId: "other", commandId: "doThing" }).catch(function(){});
      memo.runtime.ready();
    `;
    const p = await loadPluginForTest({
      // invoke:<대상>은 민감 권한이라 선언∩부여가 있어야 게이트를 통과해 수행부에 도달한다.
      manifest: manifest("m", ["invoke:other"]),
      granted: ["invoke:other"],
      code,
    });
    expect(p.rejections).toEqual([
      { call: "commands.invoke", code: "HARNESS_UNSUPPORTED" },
    ]);
    // 조용한 성공 호출로 기록되지 않았다(거짓 그린의 흔적이 없다).
    expect(p.callsTo("commands.invoke").every((c) => c.ok === false)).toBe(
      true,
    );
  });
});
