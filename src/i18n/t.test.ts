import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ko from "./ko.json";
import { t } from "./t";

describe("t", () => {
  /** 가드: 알려진 키는 ko.json에 저장된 문장을 그대로 반환한다. */
  it("returns the ko sentence for a known key", () => {
    expect(t("panel.list.empty")).toBe("노트 없음");
  });

  /** 가드: 없는 키는 키 문자열 그대로 반환한다(폴백 규약 고정). */
  it("returns the key itself when it is missing from ko.json", () => {
    expect(t("panel.does.not.exist")).toBe("panel.does.not.exist");
  });

  /** 가드: Object.prototype의 속성명을 키로 줘도 폴백을 지킨다(프로토타입 체인 누수 방지). */
  it("returns the key itself for Object.prototype property names", () => {
    expect(t("toString")).toBe("toString");
    expect(t("constructor")).toBe("constructor");
    expect(t("__proto__")).toBe("__proto__");
  });
});

describe("t placeholder substitution", () => {
  // ko.json에는 아직 {이름} 플레이스홀더를 쓰는 키가 없다(이번 이관 범위가 panel 2개뿐이라서).
  // 치환 로직 자체는 사전 내용과 무관하므로, ko.json을 픽스처 사전으로 모킹해 검증한다.
  let tFixture: typeof t;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./ko.json", () => ({
      default: {
        "fixture.greeting": "{name}님, {name}님 환영합니다 ({count}번째 방문)",
      },
    }));
    ({ t: tFixture } = await import("./t"));
  });

  afterAll(() => {
    vi.doUnmock("./ko.json");
    vi.resetModules();
  });

  /** 가드: {이름} 자리를 params 값으로 치환한다. */
  it("substitutes a placeholder with the given value", () => {
    expect(tFixture("fixture.greeting", { name: "철수", count: 1 })).toBe(
      "철수님, 철수님 환영합니다 (1번째 방문)",
    );
  });

  /** 가드: 같은 이름의 플레이스홀더가 여러 번 나와도 전부 치환한다. */
  it("substitutes every repeated occurrence of the same placeholder", () => {
    const result = tFixture("fixture.greeting", { name: "영희", count: 2 });
    expect(result.match(/영희/g)).toHaveLength(2);
  });

  /** 가드: params에 없는 플레이스홀더는 원형 그대로 남긴다(문장 훼손 방지). */
  it("leaves a placeholder untouched when params omits it", () => {
    expect(tFixture("fixture.greeting", { name: "철수" })).toBe(
      "철수님, 철수님 환영합니다 ({count}번째 방문)",
    );
  });

  /** 가드: number 값도 치환할 수 있다(문자열로 강제 변환). */
  it("accepts a number value for a placeholder", () => {
    expect(tFixture("fixture.greeting", { name: "철수", count: 3 })).toContain(
      "3번째 방문",
    );
  });
});

describe("t locale fallback chain", () => {
  // 지금은 실제로 등록된 로케일이 ko 하나뿐이라(store.ts), "활성 로케일 → ko → 키" 체인의
  // 중간 단계(활성 로케일에 없는 키를 ko가 메워 주는 경우)를 실제 로케일로는 재현할 수 없다.
  // store 모듈을 가짜 2-로케일 구성으로 모킹해 t.ts의 폴백 순서 자체를 검증한다.
  let tFixture: typeof t;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./store", () => ({
      activeLocale: () => "xx",
      localeDictionary: (code: string) =>
        ({
          xx: { "fixture.only-in-active": "활성 전용" },
          ko: {
            "fixture.only-in-ko": "ko 전용",
            "fixture.only-in-active": "ko 쪽 같은 키(가려짐)",
          },
        })[code],
    }));
    ({ t: tFixture } = await import("./t"));
  });

  afterAll(() => {
    vi.doUnmock("./store");
    vi.resetModules();
  });

  /** 가드: 활성 로케일 사전에 키가 있으면 ko를 보지 않고 그 값을 쓴다(우선순위 1번). */
  it("prefers the active locale dictionary over ko", () => {
    expect(tFixture("fixture.only-in-active")).toBe("활성 전용");
  });

  /** 가드: 활성 로케일 사전에 없는 키는 ko 사전으로 폴백한다(우선순위 2번). */
  it("falls back to the ko dictionary when the active locale lacks the key", () => {
    expect(tFixture("fixture.only-in-ko")).toBe("ko 전용");
  });

  /** 가드: 활성 로케일·ko 어디에도 없는 키는 키 문자열 그대로 반환한다(최종 폴백). */
  it("falls back to the key itself when neither dictionary has it", () => {
    expect(tFixture("fixture.nowhere")).toBe("fixture.nowhere");
  });
});

describe("ko.json format", () => {
  /** 가드: 평탄한 문자열→문자열 맵이다(중첩 객체 금지 — 언어팩 포맷의 전제). */
  it("is a flat string-to-string map", () => {
    const dict = ko as Record<string, unknown>;
    for (const [key, value] of Object.entries(dict)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
    }
  });

  /** 가드: 키가 사전순으로 정렬돼 있다(리뷰 diff·중복 키 방지). */
  it("keeps keys sorted lexicographically", () => {
    const keys = Object.keys(ko);
    expect(keys).toEqual([...keys].sort());
  });
});
