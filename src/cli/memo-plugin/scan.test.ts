import { describe, it, expect } from "vitest";
import { findMemoCallSites, lineColOf, scanBalanced } from "./scan";

describe("scanBalanced", () => {
  it("단순 괄호의 짝을 찾는다", () => {
    const src = "foo(a, b)";
    const { closeIndex, topLevelCommas } = scanBalanced(src, 3);
    expect(src[closeIndex]).toBe(")");
    expect(topLevelCommas.length).toBe(1);
  });

  it("중첩 괄호/배열/객체 안의 콤마는 최상위로 안 센다", () => {
    const src = "foo({a: 1, b: [1, 2, 3]}, bar(1, 2))";
    const { topLevelCommas } = scanBalanced(src, 3);
    // 최상위 인자는 2개(객체 하나, bar(...) 하나) → 콤마 1개.
    expect(topLevelCommas.length).toBe(1);
  });

  it("문자열 안의 괄호/콤마는 무시한다", () => {
    const src = 'foo("a, (b), c", 2)';
    const { topLevelCommas } = scanBalanced(src, 3);
    expect(topLevelCommas.length).toBe(1);
  });

  it("템플릿 리터럴의 ${} 중첩을 존중한다", () => {
    const src = "foo(`x${bar(1, 2)}y`, 2)";
    const { topLevelCommas } = scanBalanced(src, 3);
    expect(topLevelCommas.length).toBe(1);
  });

  it("미종결 괄호는 closeIndex: -1", () => {
    const src = "foo(a, b";
    const { closeIndex } = scanBalanced(src, 3);
    expect(closeIndex).toBe(-1);
  });
});

describe("findMemoCallSites — 기본 탐지", () => {
  it("call 이름과 인자 개수를 뽑는다", () => {
    const src = 'memo.settings.get({ key: "template" });';
    const [site] = findMemoCallSites(src);
    expect(site?.call).toBe("settings.get");
    expect(site?.argCount).toBe(1);
  });

  it("인자 2개 이상을 감지한다(위반)", () => {
    const src = 'memo.settings.set("key", "value");';
    const [site] = findMemoCallSites(src);
    expect(site?.argCount).toBe(2);
  });

  it("인자 0개를 감지한다", () => {
    const src = "memo.notes.current();";
    const [site] = findMemoCallSites(src);
    expect(site?.argCount).toBe(0);
  });

  it("주석 속 memo.* 텍스트는 호출로 보지 않는다", () => {
    const src = '// memo.settings.get({ key: "x" }) 예시\nconst a = 1;';
    expect(findMemoCallSites(src)).toEqual([]);
  });

  it("문자열 리터럴 속 memo.* 텍스트는 호출로 보지 않는다", () => {
    const src = 'const s = "memo.settings.get(1)";';
    expect(findMemoCallSites(src)).toEqual([]);
  });

  it("obj.memo.x.y()처럼 memo가 프로퍼티면 호출로 보지 않는다", () => {
    const src = "obj.memo.settings.get({key:1});";
    expect(findMemoCallSites(src)).toEqual([]);
  });
});

describe("findMemoCallSites — 문맥(대입/반환/await/중첩)", () => {
  it("await 뒤 호출은 precededByAwait", () => {
    const src = "async function f() { const n = await memo.notes.current(); }";
    const [site] = findMemoCallSites(src);
    expect(site?.precededByAwait).toBe(true);
  });

  it("화살표 함수 암묵 반환은 precededByArrow", () => {
    const src = "const f = () => memo.notes.current();";
    const [site] = findMemoCallSites(src);
    expect(site?.precededByArrow).toBe(true);
  });

  it("return 뒤 호출은 isNested(반환도 값 위치로 취급)", () => {
    const src = "function f() { return memo.notes.current(); }";
    const [site] = findMemoCallSites(src);
    expect(site?.isNested).toBe(true);
  });

  it("Promise.all 배열 인자 안의 호출은 isNested", () => {
    const src =
      "Promise.all([memo.notes.current(), memo.settings.get({ key: 't' })]).then(function(){}).catch(function(){});";
    const sites = findMemoCallSites(src);
    expect(sites.every((s) => s.isNested)).toBe(true);
  });

  it("최상위 문장으로 시작하는 호출은 isNested가 아니다", () => {
    const src = 'memo.ui.toast({ title: "hi" });';
    const [site] = findMemoCallSites(src);
    expect(site?.isNested).toBe(false);
  });
});

describe("findMemoCallSites — .then/.catch 체인 추적", () => {
  it("catch가 있으면 hasCatch: true", () => {
    const src =
      "memo.notes.current().then(function(n){}).catch(function(e){});";
    const [site] = findMemoCallSites(src);
    expect(site?.chain.hasCatch).toBe(true);
    expect(site?.chain.uncertain).toBe(false);
  });

  it("then만 있고 catch가 없으면 hasCatch: false, uncertain: false", () => {
    const src = "memo.notes.current().then(function(n){});";
    const [site] = findMemoCallSites(src);
    expect(site?.chain.hasThen).toBe(true);
    expect(site?.chain.hasCatch).toBe(false);
    expect(site?.chain.uncertain).toBe(false);
  });

  it("체인이 아예 없는 fire-and-forget 호출도 uncertain: false, hasCatch: false", () => {
    const src = 'memo.ui.toast({ title: "hi" });';
    const [site] = findMemoCallSites(src);
    expect(site?.chain.hasCatch).toBe(false);
    expect(site?.chain.uncertain).toBe(false);
  });

  it("알 수 없는 체인 메서드를 만나면 uncertain: true(뒤에 catch가 있을 수도 있어 단정 안 함)", () => {
    const src = "memo.notes.current().then(function(n){}).somethingElse(1);";
    const [site] = findMemoCallSites(src);
    expect(site?.chain.uncertain).toBe(true);
  });
});

describe("findMemoCallSites — 실제 저작 코드의 모양(회귀)", () => {
  /** 가드: 바로 위 줄의 주석이 마침표로 끝나도 그 호출을 놓치지 않는다. 이 저장소의 주석은
   * 한국어 문장이라 마침표로 끝나는 것이 표준인데(STYLE.md), 원문에서 앞 문자를 읽으면
   * 그 마침표가 `prevChar === "."`가 되어 "프로퍼티 접근"으로 오인됐다 — 호출이 통째로
   * 스캔에서 빠져 미사용 권한·없는 호출 검사가 조용히 건너뛰어졌다(정본 예제에서 실증). */
  it("마침표로 끝나는 주석 다음 줄의 호출도 잡는다", () => {
    const src = ["// 설정은 창과 무관하다.", "memo.settings.getAll();"].join(
      "\n",
    );
    expect(findMemoCallSites(src).map((s) => s.call)).toEqual([
      "settings.getAll",
    ]);
  });

  /** 가드: prettier가 긴 호출을 `memo.ui\n  .addToolbarButton({`로 줄바꿈한다 — 점 앞뒤에
   * 공백·개행이 끼어도 같은 호출이다. */
  it("점 앞뒤 개행/들여쓰기를 넘어 같은 호출로 본다", () => {
    const src =
      'memo.ui\n  .addToolbarButton({ id: "b" })\n  .catch(function(){});';
    const [site] = findMemoCallSites(src);
    expect(site?.call).toBe("ui.addToolbarButton");
    expect(site?.chain.hasCatch).toBe(true);
  });

  /** 가드: 진짜 프로퍼티 접근(`x.memo.a.b()`)은 여전히 제외한다 — 위 완화가 이 판정을
   * 무디게 만들지 않았음을 못박는다. */
  it("프로퍼티로 감싸인 memo는 여전히 제외한다", () => {
    expect(findMemoCallSites("wrapper.memo.ui.toast({});")).toEqual([]);
  });

  /** 가드: 호출과 `.catch` 사이에 주석이 끼어도 catch를 본다(원문으로 체인을 따라가면
   * `/`에서 끊겨 있지도 않은 MISSING_CATCH가 났다). */
  it("체인 중간의 주석을 건너뛰고 catch를 찾는다", () => {
    const src =
      "memo.ui.toast({})\n  // 실패는 조용히 넘긴다.\n  .catch(function(){});";
    const [site] = findMemoCallSites(src);
    expect(site?.chain.hasCatch).toBe(true);
  });
});

describe("findMemoCallSites — catch 핸들러 본문 안의 호출(inCatchHandler)", () => {
  /** 실증: 정본 예제 3개가 이 모양의 로그 호출 7건에 MISSING_CATCH 오탐을 냈다 — catch
   * 핸들러 안에서 부른 memo.*에 다시 .catch를 요구하는 것은 무의미하다. */
  it("function 표현식 .catch 핸들러 본문 안의 호출은 inCatchHandler: true", () => {
    const src =
      "memo.notes.current().catch(function (e) { memo.runtime.log({ message: e.code }); });";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it("화살표 함수(블록 본문) .catch 핸들러 안의 호출도 inCatchHandler: true", () => {
    const src =
      "memo.notes.current().catch((e) => { memo.runtime.log({ message: e.code }); });";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it("화살표 함수(식 본문, 암묵 반환) .catch 핸들러 안의 호출도 inCatchHandler: true", () => {
    const src =
      "memo.notes.current().catch((e) => memo.runtime.log({ message: e.code }));";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it(".then(onFulfilled, onRejected)의 두 번째 인자(에러 핸들러) 안의 호출도 inCatchHandler: true", () => {
    const src =
      "memo.notes.current().then(function (n) {}, function (e) { memo.runtime.log({ message: e.code }); });";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it("try/catch 블록 안의 호출도 inCatchHandler: true(async 함수의 catch 포함)", () => {
    const src =
      "async function f() { try { await memo.notes.current(); } catch (e) { memo.runtime.log({ message: e.code }); } }";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it("중첩 catch(핸들러 안의 try/catch) 안의 호출도 inCatchHandler: true", () => {
    const src =
      "memo.notes.current().catch(function (e) { try { risky(); } catch (e2) { memo.runtime.log({ message: e2.code }); } });";
    const site = findMemoCallSites(src).find((s) => s.call === "runtime.log");
    expect(site?.inCatchHandler).toBe(true);
  });

  it("catch 핸들러 밖의 최상위 호출은 여전히 inCatchHandler: false(진짜 누락은 계속 잡힘)", () => {
    const src = 'memo.ui.toast({ title: "hi" });';
    const [site] = findMemoCallSites(src);
    expect(site?.inCatchHandler).toBe(false);
  });

  it(".then 성공 콜백 안의 호출은 inCatchHandler: false(에러 핸들러가 아니다)", () => {
    const src =
      "memo.notes.current().then(function (n) { memo.ui.toast({ title: n }); }).catch(function(){});";
    const site = findMemoCallSites(src).find((s) => s.call === "ui.toast");
    expect(site?.inCatchHandler).toBe(false);
  });
});

describe("lineColOf", () => {
  it("첫 줄은 1행", () => {
    expect(lineColOf("abc", 1)).toEqual({ line: 1, column: 2 });
  });

  it("개행 이후는 줄 번호가 올라가고 열이 재설정된다", () => {
    const src = "line1\nline2\nline3";
    const idx = src.indexOf("line3");
    expect(lineColOf(src, idx)).toEqual({ line: 3, column: 1 });
  });
});
