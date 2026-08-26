/**
 * 정본 예제(`docs/plugin/examples/*`) 가드 — 예제가 **지금도 동작함**을 매 커밋 증명한다.
 *
 * 역할: 각 예제 폴더에 대해 (1) 매니페스트를 실제 검증기로 통과시키고, (2) `main.js`가 부르는
 * 모든 `memo.*` 호출이 존재·비예약이며 그 권한이 선언돼 있는지 확인하고, (3) `main.js`를
 * **공개 헤드리스 하니스([`loadPluginFromDir`] — `test-host.ts`, 로 실행**해 기대한 등록·
 * 창-스코프 호출이 실제로 일어나는지 확인한다.
 * 왜: 동작하지 않는 예제는 없느니만 못하다. 문서가 AI를 잘못된 예제로 안내하던 것이 이
 * 저장소에서 가장 즉각적인 해악이었으므로, 정본 예제는 "예전엔 됐던 코드"가 아니라 **지금
 * 되는 것이 증명된 코드**여야 한다.
 *
 * (3)은 저작자가 자기 플러그인을 테스트할 때 쓰는 바로 그 하니스다 — 예제 검증과 저작자
 * 도구가 같은 코드를 공유하므로 "예제는 되는데 하니스로는 안 된다"가 생기지 않는다(의
 * 도그푸딩). 그 하니스도 게이트키퍼·등록 수집기는 **진짜**를 쓰고, 부트스트랩 의미론(인자
 * 1개 규칙·바인딩된 memo·거부 code 복원)만 재현한다 — iframe·postMessage·CSP·다중 창 토큰
 * 라우팅은 재현하지 않는다(그 경계는 `central-host.test.ts`와 e2e의 몫이다).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { loadHostContract } from "../cli/memo-plugin/host-bridge";
import { runLint } from "../cli/memo-plugin/lint";
import {
  CONTRIBUTION_CALLS,
  CORE_CONTRIBUTION_PERMISSIONS,
  parseManifest,
  type PluginManifest,
} from "./manifest";
import { CALL_PERMISSIONS, NO_PERMISSION_CALLS, RESERVED_CALLS } from "./host";
import { loadPluginFromDir, type StubValue } from "./test-host";

/**
 * `contributes`로 쓰는 권한 집합 — `main.js` 코드가 아니라 매니페스트 데이터로 등록되는
 * 능력(예: 선언형 전용 언어팩)도 "권한을 실제로 쓴다"고 인정해야 한다. 안 그러면 main.js 없이
 * JSON만으로 등록하는 플러그인이 "선언했는데 안 쓰는 권한"으로 오탐된다 — CLI
 * `lint.ts`의 `lintContributes`가 이미 같은 규칙으로 `usedPermissions`에 더한다(정본).
 *
 * 두 갈래를 본다: 브리지 호출로 되돌아가는 기여는 그 호출의 권한을(`CONTRIBUTION_CALLS` →
 * `CALL_PERMISSIONS`), 코어가 직접 읽는 기여(언어팩)는 표에 적힌 권한을 그대로 쓴다 — 후자는
 * 대응하는 호출이 아예 없어 첫 갈래로는 절대 인정되지 않는다.
 */
function contributionPermissionsUsed(
  contributes: PluginManifest["contributes"],
): Set<string> {
  const used = new Set<string>();
  if (!contributes) return used;
  const raw = contributes as Record<string, unknown>;
  const declared = (kind: string): boolean => {
    const items = raw[kind];
    return Array.isArray(items) && items.length > 0;
  };
  for (const [kind, callName] of Object.entries(CONTRIBUTION_CALLS)) {
    if (!declared(kind)) continue;
    const perm = CALL_PERMISSIONS[callName];
    if (perm) used.add(perm);
  }
  for (const [kind, perm] of Object.entries(CORE_CONTRIBUTION_PERMISSIONS)) {
    if (declared(kind)) used.add(perm);
  }
  return used;
}

const ROOT = "docs/plugin/examples";

/** 예제 폴더 이름 전수(README.md 같은 파일은 제외). */
const EXAMPLES = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** `//` 줄 주석을 지운다 — 예제는 "하면 안 되는 것"을 주석으로 보여 주므로 그걸 세면 안 된다. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** 코드가 실제로 부르는 `memo.<ns>.<method>(` 호출 이름 전수(중복 제거). */
function callsIn(code: string): string[] {
  // 체인이 여러 줄로 접히므로(`memo.editor\n  .registerInlinePattern(`) 공백·개행을 허용한다.
  const hits = [
    ...stripLineComments(code).matchAll(/memo\s*\.\s*(\w+)\s*\.\s*(\w+)\s*\(/g),
  ].map((m) => `${m[1]}.${m[2]}`);
  return [...new Set(hits)].sort();
}

/**
 * 창-스코프 + 호스트 데이터 호출에 하니스가 돌려줄 대표값(실제 수행부의 스텁).
 *
 * `ui.pickList`가 `"first"`를 돌려주므로 `notes.list` 스텁도 그 id를 가진 항목을 실어 예제의
 * 목록→선택→읽기 체인이 자기모순 없이 이어지게 한다. `editor.setFontDelta`는 하니스가 실제
 * 수행부처럼 클램프하므로 여기 둘 필요가 없다.
 */
const STUBS: Record<string, StubValue> = {
  "ui.toast": null,
  "ui.prompt": "오늘의 할 일",
  "ui.pickList": "first",
  "editor.getFontDelta": 0,
  "editor.insertText": null,
  "clipboard.write": null,
  "notes.current": { id: "n1", path: "/notes/n1.md", content: "본문" },
  "notes.duplicate": null,
  "notes.resetOptions": null,
  // 전체 노트 읽기(호스트 스코프): 중앙 호스트 수행부의 계약 형태 그대로.
  "notes.list": [
    { id: "first", title: "첫 노트", hidden: false, createdAt: 100 },
    { id: "ghost", title: "숨긴 노트", hidden: true, createdAt: 200 },
  ],
  "notes.read": { id: "first", content: "첫 노트\n본문" },
  // 네트워크 중계(호스트 스코프): 중앙 호스트 수행부의 반환 형태 그대로(백엔드 대역).
  "network.fetch": { status: 200, headers: [], body: "정신을 맑게 유지하라" },
};

/**
 * 예제 하나를 **공개 헤드리스 하니스**([`loadPluginFromDir`] → `test-host.ts`)로 로드·실행한다.
 *
 * 왜 인라인 미니 브리지가 아니라 이걸 쓰나: 저작자가 자기 플러그인을 테스트할 때 쓰는 바로 그
 * 하니스로 정본 예제를 돌려야 "예제는 되는데 하니스로는 안 된다"(또는 그 반대)가 생기지 않는다 —
 * 예제 검증과 저작자 도구가 **같은 코드**를 공유한다(그 하니스도 게이트키퍼·등록 수집기는
 * 진짜를 쓴다). 설치 승인이 끝난 상태(선언=부여)와 매니페스트 기본값 병합은 하니스가 처리한다.
 */
function runExample(name: string) {
  return loadPluginFromDir(`${ROOT}/${name}`, { stubs: STUBS });
}

describe("정본 예제: 매니페스트·권한 정합", () => {
  it("예제가 하나 이상 있다(폴더 탐색 실패 방지)", () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
  });

  for (const name of EXAMPLES) {
    describe(name, () => {
      const dir = `${ROOT}/${name}`;
      const raw = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
      const parsed = parseManifest(raw);
      const code = parsed.ok
        ? readFileSync(`${dir}/${parsed.manifest.entry}`, "utf8")
        : "";
      const used = callsIn(code);

      it("매니페스트가 검증기를 통과한다", () => {
        expect(parsed.ok ? "" : parsed.error).toBe("");
      });

      it("README.md가 있다(설정 창 상세 뷰가 읽는다)", () => {
        expect(readFileSync(`${dir}/README.md`, "utf8").length).toBeGreaterThan(
          0,
        );
      });

      /**
       * 가드: 폴더 이름 = 매니페스트 id.
       *
       * 왜: 설치된 플러그인은 `plugins/<id>` 폴더에 놓이고 `scan_installed`가 폴더명≠id를
       * 탈락시킨다. 저작 폴더도 같은 규약을 지켜야 저작자가 "설치는 됐는데 목록에 없다"를
       * 겪지 않고, `memo-plugin lint`의 ID_DIR_MISMATCH 경고도 안 뜬다.
       */
      it("폴더 이름이 매니페스트 id와 같다", () => {
        expect(parsed.ok && parsed.manifest.id).toBe(name);
      });

      it("존재하지 않거나 예약된 호출을 쓰지 않는다", () => {
        const bad = used.filter(
          (c) =>
            RESERVED_CALLS.has(c) ||
            !(c in CALL_PERMISSIONS || NO_PERMISSION_CALLS.has(c)),
        );
        expect(bad).toEqual([]);
      });

      it("쓰는 호출의 권한을 빠짐없이 선언한다", () => {
        if (!parsed.ok) throw new Error("매니페스트 검증 실패");
        const declared = parsed.manifest.permissions;
        const missing = used
          // network.fetch의 권한은 URL 호스트에서 파생한 `network:<호스트>`라 정적 표의
          // 대표값('network:<도메인>')으로 판정할 수 없다 — 이 호출의 권한 검사는 CLI 린트가
          // URL 호스트를 뽑아 따로 한다(embed:<도메인>이 렌더 게이트에서 별도로 다뤄지는 결).
          .filter((c) => c !== "network.fetch")
          .map((c) => CALL_PERMISSIONS[c])
          .filter((p) => p !== undefined && !declared.includes(p));
        expect([...new Set(missing)]).toEqual([]);
      });

      /** 가드: AI가 매니페스트를 베껴 권한을 과잉 선언하는 흔한 결함을 예제에서부터 막는다. */
      it("선언했는데 한 번도 안 쓰는 권한이 없다", () => {
        if (!parsed.ok) throw new Error("매니페스트 검증 실패");
        const usedPermissions = new Set([
          ...used
            .filter((c) => c !== "network.fetch")
            .map((c) => CALL_PERMISSIONS[c])
            .filter(Boolean),
          // 선언형 전용(main.js가 공백뿐인) 예제는 권한을 main.js가 아니라 contributes로
          // 쓴다 — 위 `used`만 보면 그런 예제는 전부 오탐이 난다(language-pack-en이 그렇다).
          ...contributionPermissionsUsed(parsed.manifest.contributes),
        ]);
        const unused = parsed.manifest.permissions.filter(
          // `network:<호스트>` 선언은 network.fetch가 쓰지만 그 매핑이 동적이라 usedPermissions에
          // 없다(embed:<도메인>과 같은 이유로 "안 씀" 판정에서 제외한다).
          (p) => !p.startsWith("network:") && !usedPermissions.has(p),
        );
        expect(unused).toEqual([]);
      });

      // 선언형 전용 예제(main.js가 공백뿐)는 실행되는 코드가 없다 — 호스트가 샌드박스
      // 자체를 안 띄우므로 `.catch`·`runtime.ready()`를 요구할 대상이 없다.
      if (code.trim() !== "") {
        /** 가드: `.catch` 없는 최상위 체인은 실패를 통째로 삼킨다 — 예제가 그러면 안 된다. */
        it("최상위 체인에 .catch를 건다", () => {
          expect(code).toContain(".catch(");
        });

        it("등록 마감을 runtime.ready()로 명시한다", () => {
          expect(used).toContain("runtime.ready");
        });
      } else {
        it("선언형 전용 — main.js가 공백뿐이라 샌드박스가 뜨지 않는다", () => {
          expect(code.trim()).toBe("");
        });
      }
    });
  }
});

describe("정본 예제: 실제 실행", () => {
  it("example-starter가 인라인 패턴을 등록한다", async () => {
    const p = await runExample("example-starter");
    expect(p.rejections).toEqual([]);
    expect(p.patterns.map((x) => x.id)).toEqual(["highlight"]);
    // 클래스는 플러그인 값이 아니라 호스트가 파생한다(셀렉터 하이재킹 차단).
    expect(p.patterns[0].className).toBe("cm-x-example-starter-highlight");
  });

  it("example-toolbar-button이 버튼을 등록하고, 클릭하면 경로를 복사·알린다", async () => {
    const p = await runExample("example-toolbar-button");
    expect(p.rejections).toEqual([]);
    expect(p.buttons.map((b) => b.id)).toEqual(["copy-path"]);
    await p.clickButton("copy-path");
    expect(p.rejections).toEqual([]);
    const names = p.calls.map((c) => c.call);
    expect(names).toContain("notes.current");
    expect(names).toContain("clipboard.write");
    expect(names).toContain("ui.toast");
  });

  it("example-note-picker가 목록→선택→읽기→삽입 체인을 잇는다(도그푸딩)", async () => {
    const p = await runExample("example-note-picker");
    expect(p.rejections).toEqual([]);
    expect(p.buttons.map((b) => b.id)).toEqual(["pick-note"]);
    const before = p.calls.length;
    await p.clickButton("pick-note");
    expect(p.rejections).toEqual([]);
    expect(p.calls.slice(before).map((c) => c.call)).toEqual([
      "notes.list",
      "ui.pickList",
      "notes.read",
      "editor.insertText",
      "ui.toast",
    ]);
  });

  it("example-note-append가 notes.current→notes.write(append)→toast를 잇는다", async () => {
    const p = await runExample("example-note-append");
    expect(p.rejections).toEqual([]);
    expect(p.buttons.map((b) => b.id)).toEqual(["append-stamp"]);
    const before = p.calls.length;
    await p.clickButton("append-stamp");
    expect(p.rejections).toEqual([]);
    expect(p.calls.slice(before).map((c) => c.call)).toEqual([
      "notes.current",
      "notes.write",
      "ui.toast",
    ]);
    // 쓰기는 비파괴 append로 나간다(overwrite가 아니다).
    const write = p.calls.slice(before).find((c) => c.call === "notes.write");
    expect((write?.args as { mode?: string }).mode).toBe("append");
  });

  it("example-network-fetch가 network.fetch→editor.insertText→toast를 잇는다(도그푸딩)", async () => {
    const p = await runExample("example-network-fetch");
    expect(p.rejections).toEqual([]);
    expect(p.buttons.map((b) => b.id)).toEqual(["fetch-zen"]);
    const before = p.calls.length;
    await p.clickButton("fetch-zen");
    expect(p.rejections).toEqual([]);
    expect(p.calls.slice(before).map((c) => c.call)).toEqual([
      "network.fetch",
      "editor.insertText",
      "ui.toast",
    ]);
    // 요청은 선언한 호스트(api.github.com)로, https로 나간다.
    const fetch = p.calls.slice(before).find((c) => c.call === "network.fetch");
    expect((fetch?.args as { url?: string }).url).toBe(
      "https://api.github.com/zen",
    );
    // 삽입되는 본문은 스텁이 준 응답 body다(호스트가 대신 받은 것).
    const insert = p.calls
      .slice(before)
      .find((c) => c.call === "editor.insertText");
    expect((insert?.args as { text?: string }).text).toContain(
      "정신을 맑게 유지하라",
    );
  });

  it("example-status-menu가 상태 아이템을 등록하고 메뉴 run이 updateStatusItem을 부른다", async () => {
    const p = await runExample("example-status-menu");
    expect(p.rejections).toEqual([]);
    expect(p.statusItems.map((s) => s.id)).toEqual(["menu-count"]);
    expect(p.menuItems.map((m) => m.id)).toEqual(["bump"]);
    const before = p.calls.length;
    await p.invokeMenuItem("bump");
    expect(p.rejections).toEqual([]);
    expect(p.calls.slice(before).map((c) => c.call)).toEqual([
      "ui.updateStatusItem",
    ]);
  });

  it("example-window-calls가 네 창-스코프 호출을 순서대로 잇는다", async () => {
    const p = await runExample("example-window-calls");
    expect(p.rejections).toEqual([]);
    expect(p.buttons.map((b) => b.id)).toEqual(["insert-heading"]);
    const before = p.calls.length;
    await p.clickButton("insert-heading");
    expect(p.rejections).toEqual([]);
    expect(p.calls.slice(before).map((c) => c.call)).toEqual([
      "ui.prompt",
      "editor.insertText",
      "editor.getFontDelta",
      "editor.setFontDelta",
      "ui.toast",
    ]);
  });

  /**
   * 가드: 선언형 전용 예제(main.js가 공백뿐)는 이 하니스로 실행해도 오류·거부가 없어야 한다.
   * 이 하니스는 `contributes`를 처리하지 않는다(그건 중앙 호스트만의 책임 —
   * `central-host.test.ts`의 "매니페스트 선언형 기여 contributes"가 그 경계를 검증한다).
   * 여기서 증명하는 건 좁게 "빈 코드를 실행해도 안전하다"는 것뿐이다.
   */
  it("language-pack-en(선언형 전용)은 공백 main.js를 오류 없이 실행한다", async () => {
    const p = await runExample("language-pack-en");
    expect(p.errors).toEqual([]);
    expect(p.rejections).toEqual([]);
    // 실행할 코드가 없으니 runtime.ready()도 부르지 않는다 — 프로덕션에서는 바로 이 조건
    // (code.trim() === "")일 때 호스트가 샌드박스 자체를 안 띄운다.
    expect(p.ready).toBe(false);
  });
});

/**
 * 예제를 저작자용 CLI(`memo-plugin lint`)에도 통과시킨다.
 *
 * 왜: 예제는 저작자가 복사해 가는 출발점이므로, 우리가 권하는 도구가 **우리 예제에서
 * 무언가를 지적하면** 도구든 예제든 하나는 거짓말을 하는 것이다. 경고까지 보는 이유:
 * MISSING_CATCH 면제를 무권한 진단 호출로 좁혔을 때, 정본 예제 둘이 catch 핸들러 안에서
 * `ui.toast`(창-스코프라 거부될 수 있다)를 무캐치로 부르고 있던 것이 그제야 드러났다 —
 * 경고를 안 보면 "복사해 가는 출발점"이 조용히 나쁜 패턴을 퍼뜨린다.
 */
describe("정본 예제: memo-plugin lint", () => {
  it("모든 예제가 오류·경고 없이 lint를 통과한다", async () => {
    const { contract, close } = await loadHostContract();
    try {
      for (const name of EXAMPLES) {
        const findings = await runLint(`${ROOT}/${name}`, contract);
        expect(findings.map((f) => `${name}: ${f.code} ${f.message}`)).toEqual(
          [],
        );
      }
    } finally {
      await close();
    }
  }, 60_000);
});
