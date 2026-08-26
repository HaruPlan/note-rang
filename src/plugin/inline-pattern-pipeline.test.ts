/**
 * 인라인 패턴 **종단 렌더** 가드 — 번들 플러그인의 진짜 `main.js`가 등록한 디스크립터를
 * 노트 창이 소비하는 그 경로 그대로 태워, 실제 CodeMirror DOM에 무엇이 그려지는지 본다.
 *
 * 왜 이 파일이 따로 필요한가: 지금까지 이 저장소의 패턴 가드는 전부 **한 단계씩**만 봤다 —
 * `text-color.test.ts`는 등록 디스크립터를, `editor-api.test.ts`는 손으로 만든 디스크립터
 * 하나의 렌더를 봤다. 그런데 실제 버그는 그 **사이**에 있었다: 노트 창(`host-client.ts`)이
 * 플러그인마다 데코레이션 집합을 따로 만드는 바람에, 서로 다른 플러그인이 같은 구간을 잡으면
 * 겹침 해소가 아예 돌지 않고 **둘 다** 그려졌다. `{{할일|#f36}}`이 「글자 색」의 색과
 * 「키 표시」의 키캡 상자를 동시에 뒤집어쓴 것이 그 결과다(베타 피드백: "색 지정이 동작하지
 * 않는다, `{{}}`가 기존 키캡 기능과 겹치는 것 같다"). 단계별 가드는 셋 다 초록이었고,
 * BUILTIN_PLUGINS의 "kbd보다 앞에 둬야 한다"는 순서 가드는 **발화조차 하지 않는 죽은 규칙**
 * 이었다 — 순서가 뒤집혀도 결과가 같았기 때문이다.
 *
 * 그래서 이 파일은 조각을 새로 만들지 않는다: 디스크립터는 `test-host.ts`(진짜 게이트키퍼 +
 * 진짜 등록 수집기)로 실제 번들 폴더에서 얻고, 확장은 노트 창이 쓰는 그
 * `buildExtensionsFromSnapshot`으로 만들고, 에디터는 노트 창이 쓰는 그 `createEditor`로
 * 띄운다. 중간에 가짜가 없어야 "여기서 초록인데 앱에서 빨강"이 다시 생기지 않는다.
 *
 * 재현하지 않는 것(범위 밖): iframe 샌드박스·postMessage 직렬화·Tauri 이벤트 배달.
 * 그 구간은 `central-host.test.ts`와 e2e가 본다.
 */
import { describe, it, expect, afterEach } from "vitest";
import { loadPluginFromDir } from "./test-host";
import { buildExtensionsFromSnapshot } from "./host-client";
import { colorPatternSyntax } from "./editor-api";
import { BUILTIN_PLUGINS } from "./builtin";
import type { HostSnapshot, PluginSnapshot } from "./host-protocol";
import { SJ_D } from "../theme/theme";
import { createEditor } from "../note/editor";
import { computeLineColorEdit } from "../note/color-segments";

/** 번들 폴더 경로(테스트는 리포 루트에서 돈다 — `loadPluginFromDir`이 fs로 읽는다). */
const DIR = (id: string): string => `src/plugin/builtin/plugins/${id}`;

/**
 * 번들 플러그인들을 실제로 로드해 중앙 호스트가 방송하는 것과 같은 모양의 스냅샷을 만든다.
 *
 * `grant`는 각 매니페스트의 선언 = 부여로 둔다(사용자가 전부 승인한 상태 — 하니스의 기본
 * 가정과 같다). 그래야 노트 창의 동작 게이트(`gatePatternActions`)가 실제와 같은 판정을 한다.
 */
async function snapshotOf(ids: string[]): Promise<HostSnapshot> {
  const plugins: PluginSnapshot[] = [];
  for (const id of ids) {
    const p = await loadPluginFromDir(DIR(id));
    expect(p.errors, `${id} 로드 오류`).toEqual([]);
    expect(p.rejections, `${id} 호출 거부`).toEqual([]);
    // 권한은 번들 매니페스트의 선언 그대로(중앙 호스트가 grant를 만드는 그 출처).
    const declared = BUILTIN_PLUGINS.find((b) => b.id === id)!.permissions;
    plugins.push({
      pluginId: id,
      grant: { declared, granted: declared },
      patterns: p.patterns,
      completions: [],
      embeds: [],
      buttons: [],
    });
  }
  // 나머지 필드는 이 테스트의 관심 밖이지만 스냅샷은 완전한 값이어야 한다(노트 창이 받는
  // 그 모양 그대로 — 축소한 대역을 만들면 여기서만 통과하는 길이 생긴다).
  return {
    revision: 1,
    theme: SJ_D,
    background: null,
    font: null,
    windowControls: [],
    plugins,
    failures: [],
  };
}

/** 만든 뷰들 — 테스트마다 정리한다(jsdom DOM 누수 방지). */
const mounted: { destroy(): void }[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.destroy();
  document.body.innerHTML = "";
});

/**
 * 스냅샷으로 **진짜 노트 에디터**를 띄운다(라이브 프리뷰·마크다운·선택 툴바 전부 포함).
 * 커서는 문서 끝(마지막 줄)에 있으므로 그 앞줄들은 전부 렌더 상태로 그려진다.
 */
function mountEditor(
  doc: string,
  snapshot: HostSnapshot,
  services: Partial<Parameters<typeof buildExtensionsFromSnapshot>[1]> = {},
) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor(parent, doc, {});
  // 노트 창과 **같은 방식**으로 설치한다 — 렌더는 프리뷰에 종속되고, 메타(색 문법)는 항상 산다.
  const built = buildExtensionsFromSnapshot(snapshot, {
    noteTitles: async () => [],
    resolveTitleToId: async () => null,
    summon: () => {},
    openUrl: () => {},
    ...services,
  });
  editor.setPluginExtensions(built.render, built.meta);
  mounted.push(editor.view);
  return editor;
}

/** 위와 같지만 뷰만 돌려준다(대부분의 테스트가 뷰만 본다). */
function mount(
  doc: string,
  snapshot: HostSnapshot,
  services: Partial<Parameters<typeof buildExtensionsFromSnapshot>[1]> = {},
) {
  return mountEditor(doc, snapshot, services).view;
}

/** 렌더된 본문에서 패턴 데코레이션이 붙은 요소를 (글자, 클래스, 색)으로 훑는다. */
function decorated(
  view: ReturnType<typeof mount>,
): { text: string; classes: string[]; color: string }[] {
  return [
    ...view.contentDOM.querySelectorAll<HTMLElement>('[class*="cm-x-"]'),
  ].map((el) => ({
    text: el.textContent ?? "",
    classes: [...el.classList],
    color: el.style.color,
  }));
}

describe("글자 색 × 키 표시 — 같은 `{{…}}` 구간을 두 플러그인이 잡을 때", () => {
  /**
   * 가드(핵심 회귀 — 이 파일이 생긴 이유): `{{할일|#e33}}`은 **글자 색으로만** 그려진다.
   *
   * 수정 전에는 여기서 키캡 클래스(`cm-x-kbd-kbd`)가 색 클래스와 **함께** 잡혔다 — 두
   * 플러그인의 데코레이션이 각자 다른 집합이라 서로를 건너뛰지 못했기 때문이다. 사용자에게는
   * 색 글자가 회색 키캡 상자 안에 갇힌 모습으로 보였고, 그것이 "색 지정이 동작하지 않는다"는
   * 피드백의 실체다.
   */
  it("paints a colored span with the color pattern only — no keycap box", async () => {
    const view = mount(
      "{{할일|#e33}}\n끝",
      await snapshotOf(["text-color", "kbd"]),
    );
    expect(decorated(view)).toEqual([
      {
        text: "할일",
        classes: ["cm-x-text-color-text-color"],
        color: "rgb(238, 51, 51)",
      },
    ]);
  });

  /**
   * 가드: 색 꼬리가 없는 `{{Cmd+C}}`는 예전 그대로 키캡이다 — 겹침 해소가 "색이 언제나
   * 이긴다"가 아니라 "그 구간을 **실제로 잡은** 패턴 중 더 구체적인 쪽이 이긴다"임을 고정한다.
   */
  it("still renders a plain {{Cmd+C}} as a keycap", async () => {
    const view = mount(
      "{{Cmd+C}}\n끝",
      await snapshotOf(["text-color", "kbd"]),
    );
    expect(decorated(view)).toEqual([
      { text: "Cmd+C", classes: ["cm-x-kbd-kbd"], color: "" },
    ]);
  });

  /**
   * 가드(핵심): 승자는 **목록 순서와 무관**하다. 예전 규칙(먼저 등록한 쪽이 이긴다)은
   * `BUILTIN_PLUGINS`에서 한 줄만 옮기면 뒤집히는 우연한 값이었고, 실제로는 발화조차 하지
   * 않았다. 지금은 더 구체적인 패턴(파라미터 꼬리가 있는 쪽)이 이기므로 순서를 뒤집어도
   * 결과가 같다.
   */
  it("gives the same result when kbd is registered first", async () => {
    const view = mount(
      "{{할일|#e33}} {{Cmd+C}}\n끝",
      await snapshotOf(["kbd", "text-color"]),
    );
    expect(decorated(view)).toEqual([
      {
        text: "할일",
        classes: ["cm-x-text-color-text-color"],
        color: "rgb(238, 51, 51)",
      },
      { text: "Cmd+C", classes: ["cm-x-kbd-kbd"], color: "" },
    ]);
  });

  /**
   * 가드(핵심 회귀 — 텍스트 손실의 렌더 쪽 얼굴): 키캡이 **앞**, 색이 **뒤**인 순서에서도
   * 둘 다 제 모습으로 그려진다.
   *
   * 수정 전에는 색 패턴의 lazy 본문이 키캡의 `}}`를 그냥 통과해 index 0부터 통째로 매치됐고
   * (색은 `close` 앞에 `|#hex` 꼬리를 **요구**하므로 그 자리에서 멈출 수 없다), 더 구체적인
   * 색이 키캡을 밀어내 화면에는 `Cmd+C}} {{할일` 한 덩어리가 빨갛게 떴다 — 키캡이 사라지고
   * 원문 `}}`·`{{`가 노출되는, 사용자가 곧바로 알아보는 파손이다. 기존 가드가 못 잡은 이유는
   * 색을 앞에 둔 순서만 봤기 때문이다(그 순서에서는 lazy가 첫 꼬리에서 정확히 멎는다).
   */
  it("keeps the keycap when a colored wrap follows it on the same line", async () => {
    const view = mount(
      "{{Cmd+C}} {{할일|#e33}}\n끝",
      await snapshotOf(["text-color", "kbd"]),
    );
    expect(decorated(view)).toEqual([
      { text: "Cmd+C", classes: ["cm-x-kbd-kbd"], color: "" },
      {
        text: "할일",
        classes: ["cm-x-text-color-text-color"],
        color: "rgb(238, 51, 51)",
      },
    ]);
    // 구분자는 전부 숨는다(원문 노출 없음 = 파손의 눈에 보이는 증상이 사라졌다).
    expect(view.contentDOM.textContent).not.toContain("}}");
    expect(view.contentDOM.textContent).not.toContain("{{");
  });

  /**
   * 가드(가장 흔한 도달 경로): **선택 툴바가 실제로 만든 줄**이 그대로 렌더된다.
   *
   * 사용자는 깨진 원문을 손으로 적을 필요조차 없었다 — 키캡이 있는 줄에서 다른 단어를 드래그해
   * 색 버튼을 누르면 그 줄이 곧 위 케이스가 됐다. 그래서 이 가드는 본문을 손으로 쓰지 않고
   * 툴바의 계산(`computeLineColorEdit`)이 내놓은 문자열을 그대로 태운다 — 두 모듈의 규칙이
   * 갈라지면 여기서 빨간불이 켜진다.
   */
  it("renders the exact line the selection toolbar produces", async () => {
    const line = "{{Cmd+C}} 복사 후 붙여넣기";
    const from = line.indexOf("복사");
    const edit = computeLineColorEdit(line, from, from + 2, "#e33", {
      open: "{{",
      close: "}}",
      prefix: "|",
    })!;
    const next = line.slice(0, edit.from) + edit.insert + line.slice(edit.to);
    expect(next).toBe("{{Cmd+C}} {{복사|#e33}} 후 붙여넣기");
    const view = mount(`${next}\n끝`, await snapshotOf(["text-color", "kbd"]));
    expect(decorated(view).map((d) => [d.text, d.classes[0]])).toEqual([
      ["Cmd+C", "cm-x-kbd-kbd"],
      ["복사", "cm-x-text-color-text-color"],
    ]);
  });

  /** 가드: 6자리 hex·팔레트 밖 색도 종단까지 같은 경로로 칠해진다(등록은 여전히 하나다). */
  it("carries 6-digit and off-palette hex all the way to the DOM", async () => {
    const view = mount(
      "{{a|#112233}} 그리고 {{b|#0f9}}\n끝",
      await snapshotOf(["text-color", "kbd"]),
    );
    expect(decorated(view).map((d) => [d.text, d.color])).toEqual([
      ["a", "rgb(17, 34, 51)"],
      ["b", "rgb(0, 255, 153)"],
    ]);
  });

  /**
   * 가드: 「글자 색」이 꺼져 있으면(스냅샷에 없으면) `{{할일|#e33}}`은 키캡으로 남는다 —
   * 색 문법이 없는 창에서 이 본문이 조용히 사라지지 않는다는 확인이다.
   */
  it("falls back to the keycap when the color plugin is disabled", async () => {
    const view = mount("{{할일|#e33}}\n끝", await snapshotOf(["kbd"]));
    expect(decorated(view)).toEqual([
      { text: "할일|#e33", classes: ["cm-x-kbd-kbd"], color: "" },
    ]);
  });
});

/**
 * **인라인 패턴 중첩** — 색 감싸기 안의 위키링크·키캡이 살아 있는가.
 *
 * 예전 규칙("먼저 시작한 매치가 이기고 겹치는 나머지는 버린다")에서는 줄 머리에서 시작하는
 * 색 감싸기가 그 안의 모든 패턴을 통째로 삼켰다 — `{{[[제목]]을 보라|#3a5}}`의 위키링크는
 * 대괄호째 색 글자가 되어 **눌러도 아무 일이 없었다**. 지금은 채택된 매치가 화면에 남기는
 * 토막 안을 다시 훑어 중첩 매치까지 채택한다([`editor-api`]의 `collectPatternHits`).
 */
describe("인라인 패턴 중첩 — 색 감싸기 안의 다른 패턴", () => {
  /** 색이 칠해진 span(바깥 매치)을 찾는다 — 중첩 확인의 기준점이다. */
  const colored = (view: ReturnType<typeof mount>): HTMLElement | null =>
    view.contentDOM.querySelector<HTMLElement>(".cm-x-text-color-text-color");

  /**
   * 가드(핵심 — 이 기능이 생긴 이유): 색 감싸기 안의 `[[위키링크]]`가 **링크로 남는다**.
   * 바깥 색 span이 안쪽 링크 span을 감싸고(= 색 구간 안에 있고), 안쪽은 클릭 데코(링크 클래스와
   * `data-link-*`)를 그대로 갖는다. 대괄호는 화면에서 사라진다.
   */
  it("keeps a wikilink clickable inside a color wrap", async () => {
    const view = mount(
      "- {{[[노트 제목]]을 보라|#3a5}}\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
    );
    const wrap = colored(view);
    expect(wrap?.style.color).toBe("rgb(51, 170, 85)");
    // 안쪽 링크는 **바깥 색 span의 자손**이다(같은 형제로 흩어지지 않는다).
    const link = wrap!.querySelector<HTMLElement>(".cm-x-wikilink-wikilink");
    expect(link?.textContent).toBe("노트 제목");
    expect(link?.classList.contains("cm-plugin-link")).toBe(true);
    expect(link?.dataset.linkTarget).toBe("노트 제목");
    expect(link?.dataset.linkAction).toBe("open-note");
    // 구분자는 안쪽·바깥 모두 숨는다(원문 노출 없음).
    expect(view.contentDOM.textContent).not.toContain("[[");
    expect(view.contentDOM.textContent).not.toContain("{{");
  });

  /**
   * 가드: 중첩된 링크의 **클릭이 실제로 동작한다**(데코만 붙고 배선이 끊긴 상태를 막는다).
   * 노트 창이 배선하는 그 경로 그대로 — 제목을 id로 풀어 그 창을 소환한다.
   */
  it("summons the note when the nested wikilink is clicked", async () => {
    const summoned: string[] = [];
    const view = mount(
      "{{[[노트 제목]]을 보라|#3a5}}\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
      {
        resolveTitleToId: async (title) =>
          title === "노트 제목" ? "note-1" : null,
        summon: (id) => summoned.push(id),
      },
    );
    view.contentDOM
      .querySelector(".cm-x-wikilink-wikilink")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await Promise.resolve(); // resolveTitleToId(비동기)의 then이 돌게 한다.
    expect(summoned).toEqual(["note-1"]);
  });

  /**
   * 가드: 색 감싸기 안의 **키캡**(`{{Ctrl+C}}`)도 렌더된다.
   *
   * 이 케이스가 성립하는 이유는 재스캔 대상이 **줄 전체가 아니라 바깥 매치의 콘텐츠 부분
   * 문자열**이기 때문이다. 줄 전체 스캔에서 kbd는 줄 머리 `{{`부터 첫 `}}`까지를 잡아 색
   * 매치와 부분만 겹치므로 버려진다. 콘텐츠(`보라 {{Ctrl+C}} 눌러`)만 다시 훑을 때 비로소
   * 안쪽 키캡이 온전한 매치가 된다. (바깥 색 매치가 안쪽 `}}`에서 끊기지 않는 이유: 색 패턴은
   * `}}` 앞에 `|`+hex 꼬리를 **요구**하므로 lazy 매칭이 그 자리에서 멈출 수 없다.)
   */
  it("renders a keycap nested inside a color wrap", async () => {
    const view = mount(
      "{{보라 {{Ctrl+C}} 눌러|#3a5}}\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
    );
    const wrap = colored(view);
    expect(wrap?.style.color).toBe("rgb(51, 170, 85)");
    expect(wrap?.querySelector(".cm-x-kbd-kbd")?.textContent).toBe("Ctrl+C");
    expect(wrap?.textContent).toBe("보라 Ctrl+C 눌러");
    expect(view.contentDOM.textContent).not.toContain("{{");
  });

  /**
   * 가드(무회귀 — 중첩과 **부분 겹침**의 경계): 안쪽에서 시작해 바깥 밖으로 삐져나가는 매치는
   * 예전 그대로 버려진다. `[[노트 {{키]] 보기}}`에서 위키링크는 온전히 잡히지만, 그 안에서
   * 시작해 밖에서 닫히는 kbd는 채택되지 않는다(라벨 안에 완전히 들어가지 않는다).
   */
  it("still drops a partially overlapping match (not nesting)", async () => {
    const view = mount(
      "[[노트 {{키]] 보기}}\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
    );
    expect(decorated(view)).toEqual([
      {
        text: "노트 {{키",
        classes: ["cm-x-wikilink-wikilink", "cm-plugin-link"],
        color: "",
      },
    ]);
  });

  /**
   * 가드: 중첩은 **한 겹에서 멈추지 않는다** — 색 안의 키캡 안의 위키링크(3겹)까지 그려진다.
   * 깊이 상한(`MAX_PATTERN_NEST_DEPTH`)이 실제 용례를 덮는지 고정한다.
   */
  it("nests more than one level deep (color → keycap → wikilink)", async () => {
    const view = mount(
      "{{보라 {{[[노트 제목]]}} 끝|#3a5}}\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
    );
    const wrap = colored(view);
    const kbd = wrap!.querySelector<HTMLElement>(".cm-x-kbd-kbd");
    expect(kbd?.textContent).toBe("노트 제목");
    expect(
      kbd?.querySelector<HTMLElement>(".cm-x-wikilink-wikilink")?.dataset
        .linkTarget,
    ).toBe("노트 제목");
    expect(wrap?.textContent).toBe("보라 노트 제목 끝");
  });

  /**
   * 가드(무회귀): 중첩할 것이 없는 흔한 줄은 예전과 **한 글자도 다르지 않게** 그려진다 —
   * 재스캔이 도입되어도 톱레벨 해소 결과가 흔들리지 않는다는 확인이다.
   */
  it("leaves ordinary (non-nesting) lines exactly as before", async () => {
    const view = mount(
      "{{할일|#e33}} {{Cmd+C}} [[제목]]\n끝",
      await snapshotOf(["text-color", "wikilink", "kbd"]),
    );
    expect(decorated(view).map((d) => [d.text, d.classes[0]])).toEqual([
      ["할일", "cm-x-text-color-text-color"],
      ["Cmd+C", "cm-x-kbd-kbd"],
      ["제목", "cm-x-wikilink-wikilink"],
    ]);
  });
});

describe("색 문법 facet — 선택 툴바 색 버튼의 표시 조건", () => {
  /** 가드: 「글자 색」이 켜져 있으면 그 등록에서 뽑은 구분자가 facet으로 노출된다. */
  it("exposes the registered delimiters while the color plugin is on", async () => {
    const view = mount("x", await snapshotOf(["text-color", "kbd"]));
    expect(view.state.facet(colorPatternSyntax)).toEqual({
      open: "{{",
      close: "}}",
      prefix: "|",
    });
  });

  /** 가드: 색을 칠하는 패턴이 없으면 facet은 null이다(툴바의 색 버튼도 뜨지 않는다). */
  it("is null when no color pattern is registered", async () => {
    const view = mount("x", await snapshotOf(["kbd"]));
    expect(view.state.facet(colorPatternSyntax)).toBeNull();
  });

  /**
   * 가드(회귀): **프리뷰(렌더 모드)를 꺼도** 색 문법 facet은 살아 있어야 한다.
   *
   * 예전엔 이 facet이 렌더 확장과 한 덩어리로 pluginC(프리뷰 종속 칸)에 실려 있어서, 프리뷰를
   * 끄는 순간 함께 내려갔다. 그 facet이 선택 툴바 색 버튼의 **유일한** 표시 조건이라 원문
   * 모드에서는 색을 넣을 방법이 아예 없었다(실사용 재현: 프리뷰를 껐다 켤 때마다 팔레트가
   * 사라졌다 나타났다). 색 문법은 "무엇을 그린다"가 아니라 "감쌀 구분자가 무엇이다"라는
   * 사실이므로 렌더와 생명주기가 다르다 — 선택 액션이 프리뷰와 무관한 것과 같은 이유다.
   */
  it("keeps the color syntax facet when preview is turned off after install", async () => {
    const editor = mountEditor("x", await snapshotOf(["text-color", "kbd"]));
    editor.setPreview(false);
    expect(editor.view.state.facet(colorPatternSyntax)).toEqual({
      open: "{{",
      close: "}}",
      prefix: "|",
    });
    // 다시 켜도 그대로다(껐다 켜는 동안 중복 설치되지 않는다).
    editor.setPreview(true);
    expect(editor.view.state.facet(colorPatternSyntax)).toEqual({
      open: "{{",
      close: "}}",
      prefix: "|",
    });
  });

  /**
   * 가드(회귀 — 위와 **다른 순서**): 프리뷰가 **이미 꺼진 채로** 스냅샷이 도착해도 색 문법이
   * 설치돼야 한다.
   *
   * 이 순서가 실사용의 절반이다: 노트는 `markdown_preview` override를 노트별로 기억하므로,
   * 프리뷰를 꺼둔 채 저장한 메모는 **열자마자 원문 모드**이고 플러그인 스냅샷은 그 뒤에 온다.
   * 설치 시점에 프리뷰 상태로 메타를 거르면 그런 메모에서는 색 버튼이 영영 안 뜬다(프리뷰를
   * 한 번 켜야 비로소 나타난다 — "어떤 메모에선 뜨고 어떤 메모에선 안 뜬다"의 정체).
   */
  it("installs the color syntax facet even when preview is already off", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    // 프리뷰를 끈 채로 연 노트 창(옵션 preview:false) — 그 뒤 스냅샷이 도착한다.
    const editor = createEditor(parent, "x", { preview: false });
    mounted.push(editor.view);
    const built = buildExtensionsFromSnapshot(
      await snapshotOf(["text-color", "kbd"]),
      {
        noteTitles: async () => [],
        resolveTitleToId: async () => null,
        summon: () => {},
        openUrl: () => {},
      },
    );
    editor.setPluginExtensions(built.render, built.meta);
    expect(editor.view.state.facet(colorPatternSyntax)).toEqual({
      open: "{{",
      close: "}}",
      prefix: "|",
    });
  });

  /** 가드: 렌더 확장은 여전히 프리뷰에 종속된다 — 원문 모드에선 데코레이션이 사라져야 한다. */
  it("still drops pattern decorations while live preview is off", async () => {
    const editor = mountEditor(
      "{{할일|#f36}}\n\n끝",
      await snapshotOf(["text-color"]),
    );
    expect(decorated(editor.view).length).toBeGreaterThan(0);
    editor.setPreview(false);
    expect(decorated(editor.view)).toEqual([]);
  });
});
