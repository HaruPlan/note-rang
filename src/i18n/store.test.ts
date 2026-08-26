import { beforeEach, describe, expect, it } from "vitest";
import ko from "./ko.json";
import {
  activeLocale,
  availableLocales,
  localeDictionary,
  registerBundledLocale,
  registerLocale,
  setActiveLocale,
} from "./store";

// 모듈 전역 상태(active)를 테스트마다 ko로 되돌린다 — 이전 테스트가 setActiveLocale로
// 남긴 상태가 다음 테스트에 새는 것을 막는다. 등록된 로케일(locales Map)은 되돌릴 export가
// 없으므로, **등록을 하는 테스트는 전부** 파일 안에서 서로 부딪히지 않는 고유 코드
// ("qz"·"qy"·"qp" 등 실재하지 않는 태그)를 쓰고, 각자 자기 안에서 등록까지 끝내 앞선 it의
// 실행 여부에 기대지 않는다(`-t`로 하나만 돌려도 통과해야 한다). 번들 등록 가드가 실제
// 코드인 "en"을 쓰지 않는 이유도 같다 — store.ts의 보호 로직에는 ko 외에 코드별 분기가
// 전혀 없어(`PROTECTED_CODES.add(code)`) 고유 코드로도 커버리지 손실이 0이고, 대신 아래
// "ko만 시드된다" 가드와 같은 파일에서 모순되지 않는다.
beforeEach(() => {
  setActiveLocale("ko");
});

describe("availableLocales", () => {
  /** 가드: ko가 항상 첫 번째 항목이다(다른 테스트가 로케일을 더해도 순서는 등록 순서라
   * ko가 여전히 맨 앞이다 — 정확히 이 파일 하나뿐인 목록과 비교하지 않는다). */
  it("lists ko first", () => {
    expect(availableLocales()[0]).toEqual({ code: "ko", label: "한국어" });
  });

  /** 가드: 코어에 시드되는 로케일은 **ko 하나뿐**이다 — en은 이제 번들 언어팩
   * (`src/plugin/builtin/language-packs/language-pack-en`)이 공급하고, 각 창 부트스트랩이
   * 첫 페인트 전에 `registerBundledLocale`로 등록한다(store.ts 상단 doc-comment 참고).
   * 여기서 en이 그냥 있으면 정적 시드가 되살아났다는 뜻이다(회귀). */
  it("seeds ko only — en is not statically bundled into the store", () => {
    // 이 테스트는 파일 맨 앞 describe에 있어 아래 registerBundledLocale 테스트보다 먼저 돈다
    // (vitest는 파일 순서대로 실행한다) — 그래서 "아직 아무도 등록하지 않은" 상태를 본다.
    expect(availableLocales()).toEqual([{ code: "ko", label: "한국어" }]);
  });
});

describe("setActiveLocale", () => {
  /** 가드: 등록된 코드(ko)는 활성으로 반영된다. */
  it("activates a registered code", () => {
    setActiveLocale("ko");
    expect(activeLocale()).toBe("ko");
  });

  /** 가드(방어): 등록되지 않은 코드는 무시하고 기존 활성 로케일을 유지한다. */
  it("ignores an unregistered code and keeps the previous active locale", () => {
    setActiveLocale("qz-never-registered");
    expect(activeLocale()).toBe("ko");
  });
});

describe("localeDictionary", () => {
  /** 가드: ko 사전은 실제 ko.json 내용을 그대로 돌려준다(t.ts 폴백 체인의 최종 소스). */
  it("returns the ko dictionary for the ko code", () => {
    expect(localeDictionary("ko")).toBe(ko);
  });

  /** 가드: 등록되지 않은 코드는 undefined를 돌려준다(호출부가 폴백을 판단할 수 있도록). */
  it("returns undefined for an unregistered code", () => {
    expect(localeDictionary("qz-never-registered")).toBeUndefined();
  });
});

/**
 * 번들 언어팩 등록 경로(①단계 — en이 정적 시드에서 번들 팩으로 옮겨 오면서 생긴 진입점).
 *
 * 여기서 검증하는 것은 **등록 함수의 계약**이지 en 사전의 내용이 아니다 — 팩 콘텐츠가
 * ko.json 전 키를 100% 커버하는지(드리프트 가드)는 팩 폴더를 실제로 읽는
 * `src/i18n/packs.test.ts`가 본다(원래 이 파일에 있던 가드를 그쪽으로 옮겼다: 진실 원천이
 * `en.json`에서 팩 매니페스트로 갔으므로 가드도 그 파일을 읽어야 의미가 있다).
 */
describe("registerBundledLocale", () => {
  /** 가드: 등록한 사전이 그대로 조회되고 언어 드롭다운 후보(availableLocales)에도 나타난다. */
  it("registers a bundled locale into the dictionary and the picker", () => {
    registerBundledLocale("qz-bundled", "Bundled", {
      "panel.list.empty": "No notes",
      "made.up.key": "should be dropped", // ko에 없는 키는 조용히 버려진다.
    });
    expect(localeDictionary("qz-bundled")).toEqual({
      "panel.list.empty": "No notes",
    });
    expect(availableLocales()).toContainEqual({
      code: "qz-bundled",
      label: "Bundled",
    });
  });

  /**
   * 가드(핵심, 이슈 #30): 번들 팩으로 등록된 코드는 그 뒤 **서드파티** 등록이 덮지 못한다.
   *
   * 보호의 근거가 "정적 시드라서"에서 "앱과 함께 배포·검증된 번역이라서"로 옮겨 갔을 뿐,
   * 지키는 것은 같다 — 같은 코드를 쓰는 악의적·실수 언어팩이 앱 내장 번역을 조용히
   * 대체하지 못한다.
   *
   * 앞 it의 등록에 기대지 않고 자기 코드("qp")를 여기서 직접 등록한다 — 모듈 싱글턴 상태에
   * 기대면 이 테스트 하나만 `-t`로 돌릴 때 거짓 실패한다.
   */
  it("protects the registered code from a later third-party registerLocale", () => {
    registerBundledLocale("qp", "Bundled", { "panel.list.empty": "No notes" });
    const before = localeDictionary("qp");
    registerLocale("qp", "Fake", { "panel.list.empty": "fake" });
    expect(localeDictionary("qp")).toBe(before);
    expect(availableLocales().find((l) => l.code === "qp")?.label).toBe(
      "Bundled",
    );
  });

  /** 가드(핵심): ko는 **번들 팩으로도** 덮을 수 없다 — 기준 언어이자 검증 base라, 이것이
   * 바뀌면 다른 언어의 정합성을 판정할 근거 자체가 사라진다. */
  it("refuses to overwrite ko", () => {
    registerBundledLocale("ko", "가짜 한국어", { "panel.list.empty": "가짜" });
    expect(localeDictionary("ko")).toBe(ko);
    expect(availableLocales().find((l) => l.code === "ko")?.label).toBe(
      "한국어",
    );
  });
});

describe("registerLocale", () => {
  /** 가드(핵심): ko는 절대 덮어쓸 수 없다 — code:"ko"로 불러도 내장 사전이 그대로다. */
  it("refuses to overwrite ko", () => {
    registerLocale("ko", "가짜 한국어", { "panel.list.empty": "가짜" });
    expect(localeDictionary("ko")).toBe(ko);
    expect(availableLocales().find((l) => l.code === "ko")?.label).toBe(
      "한국어",
    );
  });

  /** 가드: 번들 팩이 **등록하지 않은** 코드는 보호 대상이 아니다 — 그 언어는 이 창에 아예
   * 없으므로 서드파티가 공급하는 것이 정상 동작이다(보호가 과하게 넓어지지 않는다). */
  it("still accepts a code no bundled pack registered", () => {
    registerLocale("qv", "Third-party", { "panel.list.empty": "No notes" });
    expect(availableLocales()).toContainEqual({
      code: "qv",
      label: "Third-party",
    });
  });

  /** 가드: ko와 플레이스홀더가 일치하는 키만 통과해 등록되고, 목록에도 나타난다. */
  it("registers a new locale with the validated subset of entries", () => {
    registerLocale("qz", "Test Locale", {
      "panel.list.empty": "No notes",
      "made.up.key": "should be dropped",
    });
    expect(availableLocales()).toContainEqual({
      code: "qz",
      label: "Test Locale",
    });
    expect(localeDictionary("qz")).toEqual({
      "panel.list.empty": "No notes",
    });
  });

  /** 가드: 플레이스홀더 집합이 어긋난 키는 그 키만 빠지고 나머지는 등록된다(전체 거부 아님). */
  it("drops only the mismatched key, keeping the rest", () => {
    registerLocale("qy", "Partial", {
      "panel.list.empty": "No notes",
      "note.restore.done": "missing the placeholder",
    });
    const dict = localeDictionary("qy");
    expect(dict?.["panel.list.empty"]).toBe("No notes");
    expect(dict).not.toHaveProperty("note.restore.done");
  });

  /** 가드(핵심): 같은 code로 다시 등록하면 마지막 등록이 이긴다(LastWins). */
  it("lets the last registration win for the same code", () => {
    registerLocale("qx", "First", { "panel.list.empty": "First" });
    registerLocale("qx", "Second", { "panel.list.empty": "Second" });
    expect(availableLocales().find((l) => l.code === "qx")?.label).toBe(
      "Second",
    );
    expect(localeDictionary("qx")).toEqual({ "panel.list.empty": "Second" });
  });

  /** 가드: 등록된 적 없는 코드로는 activeLocale이 바뀌지 않고 ko를 유지한다 — 언어팩
   * 플러그인을 끄면 자동으로 ko 폴백이 되는 동작의 기반. */
  it("keeps activeLocale on ko when the wanted locale was never registered", () => {
    setActiveLocale("qw-disabled-plugin");
    expect(activeLocale()).toBe("ko");
  });
});
