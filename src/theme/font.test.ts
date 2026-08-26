import { afterEach, describe, it, expect } from "vitest";
import {
  DEFAULT_FONT,
  hasFontPicker,
  FONT_LIST_LONG_ROWS,
  groupFontRows,
  mergeFontFamilies,
  normalizeFontArgs,
  resolveFontFamily,
  savedFontFamily,
  systemFontFamilies,
  type FontRow,
} from "./font";
import { registerLocale, setActiveLocale } from "../i18n/store";

describe("normalizeFontArgs", () => {
  /** 가드: 온전한 입력을 정규화한다(라벨 + CSS 폰트 스택). */
  it("normalizes a well-formed font registration", () => {
    const d = normalizeFontArgs({
      families: [
        { label: "세리프", stack: "Georgia, serif" },
        { label: "모노", stack: "ui-monospace, monospace" },
      ],
    });
    expect(d.families).toEqual([
      { label: "세리프", stack: "Georgia, serif" },
      { label: "모노", stack: "ui-monospace, monospace" },
    ]);
  });

  /** 가드(보안): CSS 이탈 문자가 든 스택은 버린다(스타일 인젝션 차단). */
  it("drops stacks with CSS-escape characters", () => {
    const d = normalizeFontArgs({
      families: [
        { label: "안전", stack: "Arial, sans-serif" },
        { label: "중괄호", stack: "x} body{display:none" },
        { label: "세미콜론", stack: "Arial; color:red" },
        { label: "꺾쇠", stack: "Arial<script>" },
        { label: "역슬래시", stack: "Arial\\65" },
      ],
    });
    expect(d.families).toEqual([{ label: "안전", stack: "Arial, sans-serif" }]);
  });

  /** 가드: 라벨이 없거나 비어 있으면 항목을 버린다(피커에 빈 이름이 새지 않게). */
  it("drops entries with a missing or empty label", () => {
    const d = normalizeFontArgs({
      families: [
        { label: "", stack: "Arial" },
        { label: "   ", stack: "Arial" },
        { stack: "Arial" },
        { label: "좋음", stack: "Arial" },
      ],
    });
    expect(d.families).toEqual([{ label: "좋음", stack: "Arial" }]);
  });

  /** 가드: 200자 초과 스택은 버린다(길이 상한). */
  it("drops overly long stacks", () => {
    const long = "A".repeat(201);
    const d = normalizeFontArgs({ families: [{ label: "긴", stack: long }] });
    expect(d.families).toEqual([]);
  });

  /** 가드: 라벨 앞뒤 공백은 다듬는다. */
  it("trims label whitespace", () => {
    const d = normalizeFontArgs({
      families: [{ label: "  다듬기  ", stack: "Arial" }],
    });
    expect(d.families).toEqual([{ label: "다듬기", stack: "Arial" }]);
  });

  /** 가드: 출처 표시(korean·system)는 호스트 소유 — 플러그인이 넣어도 떼어낸다. */
  it("strips host-owned provenance flags from plugin input", () => {
    const d = normalizeFontArgs({
      families: [{ label: "위장", stack: "Arial", korean: true, system: true }],
    });
    expect(d.families).toEqual([{ label: "위장", stack: "Arial" }]);
  });

  /** 가드: includeSystem은 정확히 true일 때만 살아남는다(느슨한 참 값은 무시). */
  it("keeps includeSystem only when it is exactly true", () => {
    expect(normalizeFontArgs({ families: [], includeSystem: true })).toEqual({
      families: [],
      includeSystem: true,
    });
    expect(normalizeFontArgs({ families: [], includeSystem: 1 })).toEqual({
      families: [],
    });
    expect(normalizeFontArgs({ families: [] })).toEqual({ families: [] });
  });

  /** 가드: 완전히 잘못된 입력(비객체)도 안전한 빈 디스크립터로 정규화된다. */
  it("returns a safe empty descriptor for junk input", () => {
    expect(normalizeFontArgs(null).families).toEqual([]);
    expect(normalizeFontArgs({ families: "nope" }).families).toEqual([]);
    expect(normalizeFontArgs(42).families).toEqual([]);
  });

  /** 가드: 기본 「폰트」 번들의 DEFAULT_FONT는 정규화를 그대로 통과한다(안전한 값만 선언). */
  it("passes DEFAULT_FONT through unchanged (all values already safe)", () => {
    expect(normalizeFontArgs(DEFAULT_FONT())).toEqual(DEFAULT_FONT());
    expect(DEFAULT_FONT().families.length).toBeGreaterThan(0);
  });
});

describe("systemFontFamilies", () => {
  /** 가드: 열거된 글꼴을 따옴표로 감싼 스택 행으로 만들고, 출처(system)와 한글 여부를 남긴다. */
  it("builds quoted stacks and keeps provenance", () => {
    expect(
      systemFontFamilies([
        { family: "Pretendard", korean: true },
        { family: "Helvetica Neue", korean: false },
      ]),
    ).toEqual([
      {
        label: "Pretendard",
        stack: '"Pretendard", sans-serif',
        korean: true,
        system: true,
      },
      {
        label: "Helvetica Neue",
        stack: '"Helvetica Neue", sans-serif',
        korean: false,
        system: true,
      },
    ]);
  });

  /**
   * 가드: 형태가 어긋난 IPC 응답도 빈 목록이 된다(던지지 않는다).
   *
   * 백엔드가 없거나(목·구버전) 커맨드가 null을 돌려주면 여기서 던졌었고, 그러면 호스트
   * 빌드가 통째로 죽어 플러그인이 전부 사라졌다.
   */
  it("returns an empty list for a malformed IPC response", () => {
    expect(systemFontFamilies(null)).toEqual([]);
    expect(systemFontFamilies(undefined)).toEqual([]);
    expect(systemFontFamilies("nope")).toEqual([]);
    expect(systemFontFamilies([null, 42, {}, { family: 7 }])).toEqual([]);
  });

  /** 가드: 지역화 별칭은 검색용으로 실어 오고, 없거나 빈 값이면 필드를 아예 안 만든다. */
  it("carries a localized alias only when the backend supplies one", () => {
    expect(
      systemFontFamilies([
        { family: "NanumGothic", korean: true, alias: "나눔고딕" },
        { family: "Helvetica", korean: false, alias: "" },
        { family: "Arial", korean: false },
      ]),
    ).toEqual([
      {
        label: "NanumGothic",
        stack: '"NanumGothic", sans-serif',
        korean: true,
        system: true,
        alias: "나눔고딕",
      },
      {
        label: "Helvetica",
        stack: '"Helvetica", sans-serif',
        korean: false,
        system: true,
      },
      {
        label: "Arial",
        stack: '"Arial", sans-serif',
        korean: false,
        system: true,
      },
    ]);
  });

  /** 가드: korean 필드가 없으면 한글 아님으로 본다(구버전 백엔드 응답). */
  it("treats a missing korean flag as non-Korean", () => {
    expect(systemFontFamilies([{ family: "Arial" }])).toEqual([
      {
        label: "Arial",
        stack: '"Arial", sans-serif',
        korean: false,
        system: true,
      },
    ]);
  });

  /** 가드(보안): 따옴표·CSS 이탈 문자가 든 이름은 버린다(스택을 따옴표로 감싸므로). */
  it("drops family names that would break out of the quoted stack", () => {
    expect(
      systemFontFamilies([
        { family: 'A", x{display:none', korean: false },
        { family: "It's", korean: false },
        { family: "A;B", korean: false },
        { family: "Arial", korean: false },
      ]).map((f) => f.label),
    ).toEqual(["Arial"]);
  });
});

describe("mergeFontFamilies", () => {
  /** 가드: 여러 플러그인의 목록을 등록 순서대로 이어 붙인다(외부 폰트 플러그인 공존). */
  it("concatenates lists in registration order", () => {
    expect(
      mergeFontFamilies([
        [{ label: "A", stack: "Arial" }],
        [
          { label: "B", stack: "Georgia" },
          { label: "C", stack: "Menlo" },
        ],
      ]),
    ).toEqual([
      { label: "A", stack: "Arial" },
      { label: "B", stack: "Georgia" },
      { label: "C", stack: "Menlo" },
    ]);
  });

  /** 가드: 같은 스택은 먼저 온 항목만 남긴다(라벨이 달라도 고르는 결과가 같아 중복 행). */
  it("keeps the first entry for a duplicate stack", () => {
    expect(
      mergeFontFamilies([
        [{ label: "먼저", stack: "Arial" }],
        [{ label: "나중", stack: "Arial" }],
      ]),
    ).toEqual([{ label: "먼저", stack: "Arial" }]);
  });

  /** 가드: 빈 입력·빈 목록도 안전하게 빈 결과가 된다. */
  it("returns an empty list for empty input", () => {
    expect(mergeFontFamilies([])).toEqual([]);
    expect(mergeFontFamilies([[], []])).toEqual([]);
  });
});

describe("groupFontRows", () => {
  /** 설치 글꼴이 섞인 긴 목록(끌어올리기 조건을 넘도록 라틴 글꼴을 채운다). */
  const longRows: FontRow[] = [
    { label: "시스템 기본", stack: null },
    { label: "세리프", stack: "Georgia" },
    { label: "나눔", stack: '"Nanum"', system: true, korean: true },
    ...Array.from({ length: 5 }, (_, i) => ({
      label: `Latin ${i}`,
      stack: `"Latin ${i}"`,
      system: true,
      korean: false,
    })),
  ];

  /** 가드: 「기본」(플러그인 공급) · 「한글」 · 「설치된 글꼴」 순으로 나눈다. */
  it("splits into bundled, Korean, and installed groups in that order", () => {
    const groups = groupFontRows(
      [
        { label: "세리프", stack: "Georgia" },
        {
          label: "Helvetica",
          stack: '"Helvetica"',
          system: true,
          korean: false,
        },
        { label: "나눔", stack: '"Nanum"', system: true, korean: true },
      ],
      null,
    );
    expect(groups.map((g) => g.title)).toEqual(["기본", "한글", "설치된 글꼴"]);
    expect(groups.map((g) => g.rows.map((r) => r.label))).toEqual([
      ["세리프"],
      ["나눔"],
      ["Helvetica"],
    ]);
  });

  /** 가드: 빈 구역은 내보내지 않는다 — 설치 글꼴이 없으면 구역이 하나뿐(머리글 없는 목록). */
  it("omits empty groups", () => {
    const groups = groupFontRows([{ label: "세리프", stack: "Georgia" }], null);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("기본");
    expect(groupFontRows([], null)).toEqual([]);
  });

  /** 가드: 목록이 길면 지금 고른 행을 맨 위 「지금 글꼴」로 올린다 — 300행 밑에 묻히지 않게. */
  it("hoists the selected row to the top of a long list", () => {
    const groups = groupFontRows(longRows, '"Latin 3"');
    expect(groups[0]).toEqual({
      title: "지금 글꼴",
      rows: [
        { label: "Latin 3", stack: '"Latin 3"', system: true, korean: false },
      ],
    });
  });

  /** 가드: 끌어올린 행은 원래 구역에서 **빠진다**(복제 아님) — 체크 표시와 개수가 어긋나지 않게. */
  it("moves the selected row rather than duplicating it", () => {
    const groups = groupFontRows(longRows, '"Latin 3"');
    const installed = groups.find((g) => g.title === "설치된 글꼴");
    expect(installed?.rows.map((r) => r.label)).toEqual([
      "Latin 0",
      "Latin 1",
      "Latin 2",
      "Latin 4",
    ]);
    expect(
      groups.flatMap((g) => g.rows).filter((r) => r.stack === '"Latin 3"'),
    ).toHaveLength(1);
  });

  /** 가드: "시스템 기본"(스택 없음)을 고른 상태도 똑같이 올라온다. */
  it("hoists the system-default row too", () => {
    const groups = groupFontRows(longRows, null);
    expect(groups[0].title).toBe("지금 글꼴");
    expect(groups[0].rows[0].label).toBe("시스템 기본");
  });

  /** 가드: 짧은 목록은 끌어올리지 않는다 — 한눈에 다 보이는데 머리글만 늘어난다. */
  it("does not hoist in a short list", () => {
    const short = longRows.slice(0, FONT_LIST_LONG_ROWS);
    expect(groupFontRows(short, "Georgia")[0].title).toBe("기본");
  });

  /** 가드: 저장값이 목록에 없으면(끌어올릴 행이 없음) 구역이 그대로다. */
  it("leaves the groups alone when the selection is not in the list", () => {
    expect(groupFontRows(longRows, "없는 글꼴")[0].title).toBe("기본");
  });
});

describe("hasFontPicker", () => {
  /** 가드: 패밀리가 있으면 폰트 피커 노출, 없으면(플러그인 off) 숨김. */
  it("shows the picker only when there are families", () => {
    expect(hasFontPicker([{ label: "x", stack: "Arial" }])).toBe(true);
    expect(hasFontPicker([])).toBe(false);
  });
});

describe("DEFAULT_FONT", () => {
  // registerLocale이 더한 로케일(store.ts locales Map)은 되돌릴 export가 없다(store.test.ts와
  // 같은 관례) — active만 테스트마다 ko로 되돌린다.
  afterEach(() => setActiveLocale("ko"));

  /**
   * 회귀 가드: DEFAULT_FONT가 모듈 최상위 `const`로 `t()`를 import 시점에 즉시 평가하던
   * 버그(활성 로케일이 무엇이든 이 창이 로드되는 순간의 로케일 — 늘 ko — 로 영원히 굳는다)의
   * 재발을 막는다 — 함수라서 호출될 때마다 그 순간의 활성 로케일을 읽어야 한다.
   * `registerLocale`은 되돌릴 export가 없으므로(store.test.ts와 같은 관례) 이 파일에서
   * 유일한 코드("xx")를 쓴다.
   */
  it("family labels follow the active locale at call time", () => {
    registerLocale("xx", "Test", {
      "theme.font.system": "XX System",
      "theme.font.serif": "XX Serif",
      "theme.font.monospace": "XX Monospace",
    });

    setActiveLocale("xx");
    expect(DEFAULT_FONT().families.map((f) => f.label)).toEqual([
      "XX System",
      "XX Serif",
      "XX Monospace",
    ]);

    setActiveLocale("ko");
    expect(DEFAULT_FONT().families.map((f) => f.label)).toEqual([
      "시스템",
      "세리프",
      "모노스페이스",
    ]);
  });
});

/**
 * 저장값·능력 → **실제로 적용할 스택**을 내는 두 순수 함수. 노트 창 마운트·국소 설정 반영·
 * 재빌드 후 제자리 조정이 전부 이 둘만 본다 — 규칙이 갈리면 "새로 연 창과 열려 있던 창의
 * 글꼴이 다르다"가 된다.
 */
describe("savedFontFamily", () => {
  /** 가드: `defaults.font_family`를 그대로 읽는다. */
  it("reads the stack from defaults", () => {
    expect(
      savedFontFamily({ defaults: { font_family: "Georgia, serif" } }),
    ).toBe("Georgia, serif");
  });

  /** 가드: 없거나 빈 문자열이거나 형식이 다르면 null(=시스템 기본)로 접는다. */
  it("folds anything unusable to null", () => {
    expect(savedFontFamily({ defaults: { font_family: "" } })).toBeNull();
    expect(savedFontFamily({ defaults: {} })).toBeNull();
    expect(savedFontFamily({ defaults: null })).toBeNull();
    expect(savedFontFamily({})).toBeNull();
    expect(savedFontFamily(null)).toBeNull();
    expect(savedFontFamily({ defaults: { font_family: 12 } })).toBeNull();
  });
});

describe("resolveFontFamily", () => {
  const FONT = { families: [{ label: "세리프", stack: "Georgia, serif" }] };

  /** 가드: 능력이 있고 저장값이 있으면 그 스택 그대로다. */
  it("uses the saved stack while the capability is present", () => {
    expect(resolveFontFamily(FONT, "Georgia, serif")).toBe("Georgia, serif");
  });

  /**
   * 가드(핵심): 능력이 없으면 저장값이 있어도 **무시한다**(끄면 시스템 기본 고정 — 배경
   * 능력과 대칭). 이 게이트가 새면 폰트 플러그인을 껐는데 글꼴만 그대로 남는다.
   */
  it("ignores the saved stack without the capability", () => {
    expect(resolveFontFamily(null, "Georgia, serif")).toBeUndefined();
    expect(resolveFontFamily(undefined, "Georgia, serif")).toBeUndefined();
  });

  /** 가드: 저장값이 없으면(피커의 "시스템 기본") 능력이 있어도 지정 없음이다. */
  it("returns undefined when nothing is saved", () => {
    expect(resolveFontFamily(FONT, null)).toBeUndefined();
    expect(resolveFontFamily(FONT, "")).toBeUndefined();
    expect(resolveFontFamily(FONT, undefined)).toBeUndefined();
  });
});
