/**
 * text-color 번들 가드 — 실제 main.js를 진짜 게이트키퍼·등록 수집기(test-host.ts)로 돌려
 * (1) 파라미터화 인라인 패턴이 **딱 하나** 등록되는지, (2) 그 패턴이 3자리·6자리·팔레트에
 * 없는 임의 hex를 전부 잡고 색을 캡처하는지, (3) kbd와 같은 구간을 잡되 더 구체적이라
 * 겹침에서 이기는지, (4) **UI를 아무것도 등록하지 않는지**(색 고르기는 노트 창 선택 툴바로
 * 옮겼다 — 베타 피드백)를 검증한다(미러 폴더의 실물 아티팩트).
 *
 * 종단 렌더(이 등록이 실제 CodeMirror DOM에 어떻게 그려지는가)는
 * [`inline-pattern-pipeline.test.ts`]가 본다 — 겹침 버그는 등록이 아니라 **소비 쪽**에 있었다.
 */
import { describe, it, expect } from "vitest";
import { loadPluginFromDir } from "./test-host";
import { findPatternMatches, patternSpecificity } from "./editor-api";
import { renderParamStyleDeclaration } from "./inline-style";
import { BUILTIN_PLUGINS, resolveBuiltinPluginNls } from "./builtin";

const DIR = "src/plugin/builtin/plugins/text-color";

describe("text-color 번들 가드", () => {
  const plugin = resolveBuiltinPluginNls(
    BUILTIN_PLUGINS.find((p) => p.id === "text-color")!,
    "ko",
  );

  /**
   * 가드: 이름 + 필요한 권한만 선언한다 — 지금은 인라인 패턴 등록 하나뿐이라 `editor`가
   * 전부다(kbd와 같다).
   *
   * 회귀 의미: 예전에는 우클릭 메뉴·pickList·선택 텍스트 되쓰기 때문에
   * `ui`·`settings`·`notes:read`·`notes:write`까지 받아 갔다. 그 UI를 노트 창 선택 툴바로
   * 옮기면서 **권한도 함께 반납한다** — 안 쓰는 권한이 남아 있으면 사용자에게는 "이 플러그인이
   * 내 노트를 읽는다"로 보이고, 실제로도 나중에 조용히 쓰이기 시작할 수 있다.
   */
  it("declares name and only the editor permission", () => {
    expect(plugin.name).toBe("글자 색");
    expect(plugin.permissions).toEqual(["editor"]);
  });

  /**
   * 가드(회귀 — 베타 피드백): 우클릭 컨텍스트 메뉴에 아무것도 넣지 않는다. 색은 드래그한
   * 자리(선택 툴바)에서 고른다 — 우클릭 메뉴가 이미 길다는 지적을 반영한 것이다.
   */
  it("registers no context-menu item, button, command or setting", async () => {
    const p = await loadPluginFromDir(DIR);
    expect(p.errors).toEqual([]);
    expect(p.rejections).toEqual([]);
    expect(p.menuItems).toEqual([]);
    expect(p.buttons).toEqual([]);
    expect(p.commands).toEqual([]);
    expect(p.statusItems).toEqual([]);
    expect(plugin.settings).toBeUndefined();
    // 코드에 UI·설정 호출 자체가 남아 있지 않다(권한 반납과 같은 사실의 다른 면).
    expect(plugin.code).not.toContain("memo.ui.");
    expect(plugin.code).not.toContain("memo.settings.");
  });

  /**
   * 가드(회귀): README·설정 문구가 "3자리만 된다"는 **낡은 제약**을 더는 말하지 않고,
   * 색을 고르는 곳을 **선택 툴바**로 안내한다(우클릭 메뉴로 안내하면 없는 기능을 가리킨다).
   */
  it("documents the selection-toolbar flow without the stale 3-digit-only limitation", () => {
    expect(plugin.readme).toContain("## 이렇게 써요");
    expect(plugin.readme).toContain("{{할 일|#f36}}"); // 3자리 예시
    expect(plugin.readme).toContain("#a1b2c3"); // 6자리 예시가 실제로 있다.
    expect(plugin.readme).toContain("드래그");
    expect(plugin.readme).not.toContain("우클릭");
    const texts = [
      plugin.readme ?? "",
      plugin.summary ?? "",
      plugin.settingsDescription ?? "",
    ].join("\n");
    expect(texts).not.toMatch(/3자리[^\n]*만/);
    expect(texts).not.toContain("표현할 수 없");
  });
});

describe("text-color 인라인 패턴 등록", () => {
  /** 가드(핵심): 등록은 **하나**이고, 색은 등록값이 아니라 파라미터 캡처(`param`)로 온다.
   * 예전에는 팔레트 색마다 close를 "|#rgb}}"로 굳혀 하나씩 등록했고(9개), 그래서 팔레트 밖
   * 색은 렌더되지 않았고 6자리는 구분자 8자 상한에 걸렸다. */
  it("registers exactly one parameterized pattern", async () => {
    const p = await loadPluginFromDir(DIR);
    expect(p.errors).toEqual([]);
    expect(p.rejections).toEqual([]);
    expect(p.patterns).toHaveLength(1);
    const [pattern] = p.patterns;
    expect(pattern.open).toBe("{{");
    expect(pattern.close).toBe("}}");
    expect(pattern.mid).toBeUndefined();
    expect(pattern.action).toBe("none");
    expect(pattern.param).toEqual({
      prefix: "|",
      format: "hex-color",
      apply: "color",
    });
    // 색이 매치별로 정해지므로 등록 시점의 고정 스타일은 없다.
    expect(pattern.style).toBeUndefined();
  });

  /** 가드(핵심 — 사용자 요구): 3자리·6자리·**팔레트에 없는 임의 색**이 전부 한 등록으로
   * 매치되고, 안쪽 글자와 색이 각각 정확히 캡처된다. */
  it("matches 3-digit, 6-digit and off-palette hex with the same single registration", async () => {
    const p = await loadPluginFromDir(DIR);
    const [pattern] = p.patterns;
    const cases: [string, string, string][] = [
      ["{{할일|#e33}}", "할일", "#e33"], // 팔레트에 있는 3자리
      ["{{할일|#ffffff}}", "할일", "#ffffff"], // 6자리
      ["{{urgent|#A1b2C3}}", "urgent", "#A1b2C3"], // 팔레트 밖 + 대소문자 혼합
      ["{{x|#0f9}}", "x", "#0f9"], // 팔레트 밖 3자리
    ];
    for (const [line, inner, hex] of cases) {
      const matches = findPatternMatches(
        line,
        pattern.open,
        pattern.close,
        pattern.mid,
        pattern.param,
      );
      expect(matches, line).toHaveLength(1);
      expect(matches[0].from).toBe(0);
      expect(matches[0].to).toBe(line.length);
      expect(line.slice(matches[0].first.from, matches[0].first.to)).toBe(
        inner,
      );
      const span = matches[0].param!;
      expect(line.slice(span.from, span.to)).toBe(hex);
      // 그 캡처가 실제로 칠해질 CSS 선언이 된다(호스트가 다시 검증한 값).
      expect(
        renderParamStyleDeclaration(
          pattern.param!.apply!,
          pattern.param!.format,
          line.slice(span.from, span.to),
        ),
      ).toBe(`color: ${hex}`);
    }
  });

  /** 가드: 형식이 아닌 색(자리수 오류·색 이름)은 **매치 자체가 되지 않아** 원문 그대로 남는다
   * — 잘못 칠해지는 대신 하이라이트가 안 켜진다(예전 "팔레트에 없으면 원문"과 같은 결). */
  it("leaves malformed hex untouched (no match at all)", async () => {
    const p = await loadPluginFromDir(DIR);
    const [pattern] = p.patterns;
    for (const line of [
      "{{할일|#ff}}",
      "{{할일|#ffff}}",
      "{{할일|#fffffff}}",
      "{{할일|red}}",
      "{{할일|#ggg}}",
    ]) {
      expect(
        findPatternMatches(
          line,
          pattern.open,
          pattern.close,
          pattern.mid,
          pattern.param,
        ),
        line,
      ).toEqual([]);
    }
  });

  /** 가드(회귀 — 새로 얻은 것): 한 줄에 색이 여럿이어도 각각 잡힌다. 색마다 등록하던 예전
   * 구조에서는 두 번째 패턴의 lazy 매치가 첫 구간을 통째로 삼켜 하나만 그려졌다. */
  it("keeps multiple colored spans on one line separate", async () => {
    const p = await loadPluginFromDir(DIR);
    const [pattern] = p.patterns;
    const line = "{{a|#111}} 그리고 {{b|#222222}}";
    const matches = findPatternMatches(
      line,
      pattern.open,
      pattern.close,
      pattern.mid,
      pattern.param,
    );
    expect(matches).toHaveLength(2);
    expect(line.slice(matches[0].first.from, matches[0].first.to)).toBe("a");
    expect(line.slice(matches[1].first.from, matches[1].first.to)).toBe("b");
    expect(line.slice(matches[1].param!.from, matches[1].param!.to)).toBe(
      "#222222",
    );
  });

  /**
   * 가드(회귀 — 이 기능이 "동작하지 않는다"고 신고된 그 지점): kbd의 포괄적 "{{...}}"는 같은
   * 줄에서 text-color와 **똑같은 구간**을 잡는다. 겹침의 승자는 등록 순서가 아니라
   * [`patternSpecificity`]가 정하고, 파라미터 꼬리를 요구하는 이 패턴이 더 크다 — 그래서
   * 목록에서 어느 쪽이 앞에 있든 색이 이긴다. 반대로 색 꼬리가 없는 "{{Cmd+C}}"는
   * text-color에 걸리지 않아 키캡이 그대로 살아 있다.
   */
  it("collides with kbd only on colored spans, and wins by being more specific", async () => {
    const p = await loadPluginFromDir(DIR);
    const [pattern] = p.patterns;
    const kbd = (await loadPluginFromDir("src/plugin/builtin/plugins/kbd"))
      .patterns[0];
    const colored = "{{할일|#e33}}";
    const textColor = findPatternMatches(
      colored,
      pattern.open,
      pattern.close,
      pattern.mid,
      pattern.param,
    );
    const kbdHits = findPatternMatches(colored, kbd.open, kbd.close);
    expect(textColor).toHaveLength(1);
    expect(kbdHits).toHaveLength(1);
    expect(kbdHits[0].from).toBe(textColor[0].from);
    expect(kbdHits[0].to).toBe(textColor[0].to);
    // 같은 구간이지만 승자는 결정적이다(순서와 무관).
    expect(patternSpecificity(pattern)).toBeGreaterThan(
      patternSpecificity(kbd),
    );
    // 키캡은 text-color가 건드리지 않는다(색 꼬리가 없다).
    expect(
      findPatternMatches(
        "{{Cmd+C}}",
        pattern.open,
        pattern.close,
        pattern.mid,
        pattern.param,
      ),
    ).toEqual([]);
    expect(findPatternMatches("{{Cmd+C}}", kbd.open, kbd.close)).toHaveLength(
      1,
    );
  });
});
