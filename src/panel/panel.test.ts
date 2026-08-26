import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import ko from "../i18n/ko.json";
import type { NoteSummary, SearchHit } from "../shared/tauri";
import {
  matchesDateQuery,
  mergeSearchResults,
  mountPanel,
  parsePanelSort,
  renderList,
  sortEntries,
} from "./panel";

// 2026-07-23 로컬 정오 — formatCreatedAt(로컬 기준)이 "2026.07.23"을 내도록 TZ 무관 고정.
const JUL23 = new Date(2026, 6, 23, 12, 0, 0).getTime();

/**
 * 목록 픽스처 — 백엔드가 언제나 싣는 정렬용 메타 4종을 기본값으로 채운다.
 *
 * 왜 헬퍼인가: 그 네 필드는 타입상 필수라 리터럴마다 손으로 적어야 하는데, 대부분의 테스트는
 * 그중 아무것도 보지 않는다(삭제 흐름·포커스 보존 등). 매 픽스처에 네 줄이 붙으면 정작 그
 * 테스트가 **무엇을 흔들어 보는지**가 잡음에 묻힌다 — 관심 있는 필드만 덮어쓰게 한다.
 *
 * `content_updated_at` 기본값이 `created_at`인 이유: 백엔드도 본문 mtime을 못 읽으면
 * `created_at`을 대신 싣는다(한 번도 저장되지 않은 새 노트의 실제 모습이기도 하다).
 */
function summary(over: Partial<NoteSummary> & { id: string }): NoteSummary {
  const created_at = over.created_at ?? 0;
  return {
    title: over.id,
    hidden: false,
    favorite: false,
    content_updated_at: created_at,
    char_count: 0,
    opened_at: null,
    ...over,
    created_at,
  };
}

/**
 * `renderList` 픽스처 — 정렬용 메타 4종만 채우고 나머지는 호출부가 준 그대로 둔다.
 *
 * [`summary`]와 따로 두는 이유: 이 함수는 `created_at`을 **아예 넣지 않는** 항목도 만들 수
 * 있어야 한다("생성일이 없으면 날짜를 그리지 않는다" 가드가 보는 것이 바로 그 부재다).
 */
function listEntry<T extends { id: string; title: string }>(over: T) {
  return {
    favorite: false,
    content_updated_at: 0,
    char_count: 0,
    opened_at: null,
    ...over,
  };
}

/** 검색 결과 픽스처 — [`summary`]와 같은 기본값에 snippet만 더한다. */
function hit(over: Partial<SearchHit> & { id: string }): SearchHit {
  const created_at = over.created_at ?? 0;
  return {
    title: over.id,
    snippet: "",
    favorite: false,
    content_updated_at: created_at,
    char_count: 0,
    opened_at: null,
    ...over,
    created_at,
  };
}

describe("renderList", () => {
  /** 가드: 항목을 제목·미리보기로 그리고, 클릭하면 그 id로 소환한다. */
  it("renders items and summons on click", () => {
    const list = document.createElement("ul");
    const summon = vi.fn();
    renderList(
      list,
      [listEntry({ id: "a", title: "First", snippet: "ctx" })],
      summon,
    );

    const item = list.querySelector(".panel-item")!;
    expect(item.querySelector(".panel-item-title")!.textContent).toBe("First");
    expect(item.querySelector(".panel-item-snippet")!.textContent).toBe("ctx");

    (item as HTMLElement).click();
    expect(summon).toHaveBeenCalledWith("a");
  });

  /** 가드: created_at이 있으면 제목 옆에 생성일을 YYYY.MM.DD로 작게 그린다. */
  it("renders a small creation date when present", () => {
    const list = document.createElement("ul");
    // 로컬 시간대로 구성해 formatCreatedAt(로컬 기준)과 일치시킨다(타임존 무관 결정성).
    const ms = new Date(2026, 6, 23, 12, 0, 0).getTime();
    renderList(
      list,
      [listEntry({ id: "a", title: "First", created_at: ms })],
      vi.fn(),
    );
    expect(list.querySelector(".panel-item-date")!.textContent).toBe(
      "2026.07.23",
    );
  });

  /** 가드: created_at이 없으면 생성일 요소를 만들지 않는다. */
  it("omits the creation date when absent", () => {
    const list = document.createElement("ul");
    renderList(list, [listEntry({ id: "a", title: "First" })], vi.fn());
    expect(list.querySelector(".panel-item-date")).toBeNull();
  });

  /** 가드: 항목이 없으면 안내 문구를 보인다. */
  it("shows an empty message for no items", () => {
    const list = document.createElement("ul");
    renderList(list, [], vi.fn());
    expect(list.querySelector(".panel-empty")).not.toBeNull();
    expect(list.querySelector(".panel-item")).toBeNull();
  });
});

describe("renderList — selection mode (베타 피드백: 다중 선택)", () => {
  /** 가드: selection을 주면 체크박스를 그리고(선택 상태를 반영), 행 클릭이 onSummon 대신
   * 토글 콜백을 부른다(선택 모드에서는 실수로 노트가 열리면 안 된다). */
  it("renders a checkbox reflecting selectedIds and toggles instead of summoning on row click", () => {
    const list = document.createElement("ul");
    const summon = vi.fn();
    const onToggleSelect = vi.fn();
    renderList(
      list,
      [listEntry({ id: "a", title: "First" })],
      summon,
      undefined,
      {
        selectedIds: new Set(["a"]),
        onToggleSelect,
      },
    );

    const checkbox = list.querySelector<HTMLInputElement>(
      ".panel-item-checkbox",
    )!;
    expect(checkbox.checked).toBe(true);
    expect(list.querySelector(".panel-item-selected")).not.toBeNull();

    (list.querySelector(".panel-item") as HTMLElement).click();
    expect(summon).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledWith("a");
  });

  /** 가드: selection이 있으면 selectedIds에 없는 항목의 체크박스는 unchecked로 그린다. */
  it("renders an unchecked checkbox for an id not in selectedIds", () => {
    const list = document.createElement("ul");
    renderList(
      list,
      [listEntry({ id: "a", title: "First" })],
      vi.fn(),
      undefined,
      {
        selectedIds: new Set(),
        onToggleSelect: vi.fn(),
      },
    );
    expect(
      list.querySelector<HTMLInputElement>(".panel-item-checkbox")!.checked,
    ).toBe(false);
    expect(list.querySelector(".panel-item-selected")).toBeNull();
  });
});

describe("parsePanelSort", () => {
  /** 가드: 어휘에 있는 값은 그대로 통과한다(6개 전부 — 하나라도 빠지면 그 옵션이 조용히
   * 기본 정렬로 접혀 드롭다운이 먹통처럼 보인다). */
  it("passes every known mode through unchanged", () => {
    for (const mode of [
      "created-desc",
      "created-asc",
      "updated-desc",
      "title-asc",
      "chars-desc",
      "opened-desc",
    ]) {
      expect(parsePanelSort(mode)).toBe(mode);
    }
  });

  /** 가드(핵심): 모르는 값·빈 값·null·undefined는 모두 기본값으로 접힌다 — 백엔드는 이
   * 문자열의 의미를 모르고 왕복만 하므로 어휘 판정은 전적으로 여기 몫이다. */
  it("falls back to created-desc for unknown, empty, and missing values", () => {
    for (const raw of ["", "  ", "nope", "CREATED-DESC", null, undefined]) {
      expect(parsePanelSort(raw)).toBe("created-desc");
    }
  });
});

describe("sortEntries", () => {
  /**
   * 정렬 키 하나만 골라 흔들어 보기 위한 최소 항목. 안 준 키는 중립값(0/null/false)으로
   * 채워져 지정한 키만 순서를 가른다.
   *
   * **폴백을 흉내 내지 않는다**: `content_updated_at`을 `created_at`으로 대신 채우는 짓을
   * 하지 않는다(예전엔 그랬다). 프로덕션 `SORT_COMPARATORS`에는 그런 폴백이 없어서, 픽스처가
   * 대신 메워 주면 "필드가 없어도 잘 정렬된다"는 **거짓 초록**이 나온다 — 실제로 필드가 빠진
   * 입력이 오면 어떻게 되는지는 아래 계약 위반 가드가 따로 못 박는다.
   */
  const entry = (over: {
    id: string;
    title?: string;
    created_at?: number;
    content_updated_at?: number;
    char_count?: number;
    opened_at?: number | null;
    favorite?: boolean;
  }) => ({
    id: over.id,
    title: over.title ?? over.id,
    created_at: over.created_at ?? 0,
    content_updated_at: over.content_updated_at ?? 0,
    char_count: over.char_count ?? 0,
    opened_at: over.opened_at ?? null,
    favorite: over.favorite ?? false,
  });
  const ids = (items: { id: string }[]) => items.map((i) => i.id);

  /** 가드: 추가순(최신) — created_at 내림, 같으면 id 오름. */
  it("sorts by created_at descending, breaking ties by id", () => {
    const items = [
      entry({ id: "b", created_at: 100 }),
      entry({ id: "c", created_at: 300 }),
      entry({ id: "a", created_at: 100 }),
    ];
    expect(ids(sortEntries(items, "created-desc"))).toEqual(["c", "a", "b"]);
  });

  /** 가드: 추가순(오래된) — 방향만 뒤집히고 tie-break는 그대로 id 오름(뒤집지 않는다). */
  it("sorts by created_at ascending with the same id tie-break", () => {
    const items = [
      entry({ id: "b", created_at: 100 }),
      entry({ id: "c", created_at: 300 }),
      entry({ id: "a", created_at: 100 }),
    ];
    expect(ids(sortEntries(items, "created-asc"))).toEqual(["a", "b", "c"]);
  });

  /** 가드: 수정순 — content_updated_at 내림(created_at과 무관하게 그 필드만 본다). */
  it("sorts by content_updated_at descending, independently of created_at", () => {
    const items = [
      // b는 가장 늦게 만들어졌지만 그 뒤로 손대지 않아 맨 아래로 간다 — 두 시각이 서로
      // 다른 축임을 못 박는다(created_at으로 정렬했다면 b가 맨 위였을 것이다).
      entry({ id: "a", created_at: 100, content_updated_at: 300 }),
      entry({ id: "b", created_at: 900, content_updated_at: 100 }),
      entry({ id: "c", created_at: 100, content_updated_at: 500 }),
    ];
    expect(ids(sortEntries(items, "updated-desc"))).toEqual(["c", "a", "b"]);
  });

  /** 가드: 수정순의 tie-break는 created_at 내림 → id 오름(id 단독이 아니다). */
  it("breaks updated-desc ties by created_at descending, then id", () => {
    const items = [
      entry({ id: "a", created_at: 100, content_updated_at: 500 }),
      entry({ id: "b", created_at: 900, content_updated_at: 500 }),
      entry({ id: "c", created_at: 900, content_updated_at: 500 }),
    ];
    expect(ids(sortEntries(items, "updated-desc"))).toEqual(["b", "c", "a"]);
  });

  /** 가드: 이름순 — 숫자를 자연스럽게 읽고(2 < 10) 대소문자 차이는 무시한다. */
  it("sorts titles naturally and case-insensitively", () => {
    const items = [
      entry({ id: "x", title: "Note 10" }),
      entry({ id: "y", title: "note 2" }),
      entry({ id: "z", title: "가나다" }),
    ];
    expect(ids(sortEntries(items, "title-asc"))).toEqual(["y", "x", "z"]);
  });

  /** 가드: 제목이 같게 읽히면(대소문자만 다름) created_at 내림 → id 오름으로 갈린다. */
  it("breaks equal titles by created_at descending, then id", () => {
    const items = [
      entry({ id: "a", title: "Apple", created_at: 100 }),
      entry({ id: "c", title: "apple", created_at: 500 }),
      entry({ id: "b", title: "APPLE", created_at: 500 }),
    ];
    expect(ids(sortEntries(items, "title-asc"))).toEqual(["b", "c", "a"]);
  });

  /** 가드: 글자수 많은 순 — char_count 내림. 빈 노트(0)는 맨 뒤다. */
  it("sorts by char_count descending, with empty notes last", () => {
    const items = [
      entry({ id: "a", char_count: 10 }),
      entry({ id: "b", char_count: 0 }),
      entry({ id: "c", char_count: 900 }),
    ];
    expect(ids(sortEntries(items, "chars-desc"))).toEqual(["c", "a", "b"]);
  });

  /** 가드(핵심): 최근 연 순 — opened_at 내림이되, 한 번도 연 적 없는(null) 노트는 언제나
   * 맨 뒤다(0으로 읽으면 "아주 오래전에 열었다"가 되어 같은 자리를 다투게 된다). */
  it("sorts by opened_at descending and pushes never-opened notes to the end", () => {
    const items = [
      entry({ id: "a", opened_at: null, created_at: 900 }),
      entry({ id: "b", opened_at: 100 }),
      entry({ id: "c", opened_at: null }),
      entry({ id: "d", opened_at: 700 }),
    ];
    expect(ids(sortEntries(items, "opened-desc"))).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
  });

  /** 가드(핵심): 즐겨찾기는 언제나 위쪽 묶음이고, 각 묶음 안에서만 모드가 적용된다. */
  it("keeps favorites as a group on top, sorted within each group", () => {
    const items = [
      entry({ id: "a", created_at: 900 }),
      entry({ id: "b", created_at: 100, favorite: true }),
      entry({ id: "c", created_at: 500 }),
      entry({ id: "d", created_at: 300, favorite: true }),
    ];
    expect(ids(sortEntries(items, "created-desc"))).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
  });

  /** 가드: 모르는 모드는 기본값(추가순 최신)으로 정렬한다 — 저장된 값이 낡았어도 화면이
   * 순서 없이 흐트러지지 않는다. */
  it("falls back to created-desc for an unknown mode", () => {
    const items = [
      entry({ id: "a", created_at: 100 }),
      entry({ id: "b", created_at: 900 }),
    ];
    expect(ids(sortEntries(items, "nope"))).toEqual(["b", "a"]);
  });

  /** 가드: 순수 함수 — 입력 배열의 순서를 건드리지 않는다(호출부가 같은 배열을 다시 쓴다). */
  it("does not mutate the input array", () => {
    const items = [
      entry({ id: "a", created_at: 100 }),
      entry({ id: "b", created_at: 900 }),
    ];
    sortEntries(items, "created-desc");
    expect(ids(items)).toEqual(["a", "b"]);
  });

  /** 가드: 빈 목록도 안전하다(검색 결과 0건 경로). */
  it("returns an empty array for no items", () => {
    expect(sortEntries([], "title-asc")).toEqual([]);
  });

  /**
   * 가드(계약 위반 입력): 필수 정렬 필드가 정말로 빠진 채 들어오면 프로덕션이 **무엇을
   * 하는지**를 못 박는다 — 폴백은 없다. 뺄셈이 `NaN`이 되고 `NaN`은 falsy라 tie-break
   * (생성 시각 내림 → id 오름)로 흘러, 세 모드가 조용히 추가순으로 퇴화한다.
   *
   * 왜 고정해 두나: 타입은 네 필드를 필수로 선언하지만 IPC 경계는 타입을 강제하지 못한다
   * (e2e 목이 필드를 빠뜨리거나 Rust에 `skip_serializing_if`가 붙는 순간 그대로 새어 든다).
   * 이 가드가 없으면 그 퇴화가 아무 테스트도 깨뜨리지 않고 지나간다.
   */
  it("degrades to the created-desc tie-break when a required field is missing", () => {
    const broken = [
      { id: "a", title: "A", created_at: 100 },
      { id: "b", title: "B", created_at: 900 },
    ] as unknown as Parameters<typeof sortEntries>[0];
    for (const mode of ["updated-desc", "chars-desc", "opened-desc"]) {
      expect(ids(sortEntries(broken, mode)), mode).toEqual(["b", "a"]);
    }
  });
});

describe("matchesDateQuery", () => {
  /** 가드: 연/연.월/연.월.일/월.일 및 -,/,공백 구분자로 생성일을 매칭한다(자리 맞춤 포함). */
  it("matches full and partial dates with various separators", () => {
    for (const q of [
      "2026", // 연
      "2026.07", // 연.월
      "2026.7", // 연.월(자리 맞춤)
      "2026.07.23", // 연.월.일
      "2026-7-23", // 대시
      "2026/07/23", // 슬래시
      "2026 07", // 공백
      "07.23", // 월.일
    ]) {
      expect(matchesDateQuery(q, JUL23)).toBe(true);
    }
  });

  /** 가드: 다른 날짜는 매칭하지 않는다. */
  it("does not match a different date", () => {
    expect(matchesDateQuery("2026.08", JUL23)).toBe(false);
    expect(matchesDateQuery("2025", JUL23)).toBe(false);
  });

  /** 가드: 날짜꼴이 아니면(텍스트·단독 소수 숫자·빈 값) 날짜 매칭하지 않는다(오탐 방지). */
  it("ignores non-date queries", () => {
    for (const q of ["회의", "7", "23", "", "  ", "2026abc"]) {
      expect(matchesDateQuery(q, JUL23)).toBe(false);
    }
  });

  /** 가드: 생성 시각이 없으면(0/음수) 날짜 매칭하지 않는다. */
  it("ignores notes without a creation time", () => {
    expect(matchesDateQuery("2026", 0)).toBe(false);
    expect(matchesDateQuery("2026", -1)).toBe(false);
  });
});

describe("mergeSearchResults", () => {
  /** 가드: 텍스트 매치를 앞에, 생성일로만 매치된 노트를 뒤에 붙이고 id 중복은 제거한다. */
  it("appends date-only matches after text hits without duplicates", () => {
    const textHits = [
      hit({ id: "a", title: "A", snippet: "hit", created_at: JUL23 }),
    ];
    const allNotes = [
      summary({ id: "a", title: "A", created_at: JUL23 }), // 텍스트에도 이미 있음
      summary({ id: "b", title: "B", created_at: JUL23 }), // 생성일로만 매치
      summary({ id: "c", title: "C" }), // 생성일 없음 → 제외
    ];
    const merged = mergeSearchResults(textHits, allNotes, "2026.07");
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  /** 가드: 날짜꼴이 아닌 질의면 텍스트 매치만 남는다. */
  it("keeps only text hits for a non-date query", () => {
    const textHits = [
      hit({ id: "a", title: "A", snippet: "hit", created_at: JUL23 }),
    ];
    const allNotes = [summary({ id: "b", title: "B", created_at: JUL23 })];
    const merged = mergeSearchResults(textHits, allNotes, "회의");
    expect(merged.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("mountPanel", () => {
  /** 가드: 초기 마운트는 전체 노트 목록을 그린다. */
  it("renders the full list initially", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-item-title")!.textContent).toBe("Note A");
  });

  /** 가드: 검색창은 아이콘과 함께 필드형 래퍼로 감싸 렌더한다(리스타일 구조). */
  it("wraps the search input in a field with an icon", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    const wrap = host.querySelector(".panel-search-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector(".panel-search-icon")).not.toBeNull();
    expect(wrap!.querySelector("input.panel-search")).not.toBeNull();
  });

  /** 가드: 입력 시 디바운스 후 검색하고, 결과 클릭이 소환을 부른다. */
  it("searches after typing and summons on result click", async () => {
    vi.useFakeTimers();
    try {
      const summon = vi.fn();
      const searchNotes = vi.fn(async () => [
        hit({ id: "b", title: "Found", snippet: "hit" }),
      ]);
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes: async () => [],
        searchNotes,
        summon,
        searchDebounceMs: 0,
      });

      const input = host.querySelector<HTMLInputElement>(".panel-search")!;
      input.value = "fo";
      input.dispatchEvent(new Event("input"));
      await vi.runAllTimersAsync();

      expect(searchNotes).toHaveBeenCalledWith("fo");
      host.querySelector<HTMLElement>(".panel-item")!.click();
      // 클릭 → summonSafely가 존재 확인(생략 시 즉시 true로 해소)을 거쳐 소환한다 —
      // 그 한 단계 마이크로태스크를 흘려보낸다(가짜 타이머는 마이크로태스크에 영향 없음).
      await Promise.resolve();
      expect(summon).toHaveBeenCalledWith("b");
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 날짜 질의는 텍스트 매치가 없어도 생성일이 맞는 노트를 목록에 올린다. */
  it("finds notes by creation date even without text matches", async () => {
    vi.useFakeTimers();
    try {
      const searchNotes = vi.fn(async () => []); // 제목·본문 매치 없음
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes: async () => [
          summary({ id: "n1", title: "회의록", created_at: JUL23 }),
          summary({ id: "n2", title: "메모" }),
        ],
        searchNotes,
        summon: vi.fn(),
        searchDebounceMs: 0,
      });

      const input = host.querySelector<HTMLInputElement>(".panel-search")!;
      input.value = "2026.07";
      input.dispatchEvent(new Event("input"));
      await vi.runAllTimersAsync();

      expect(searchNotes).toHaveBeenCalledWith("2026.07");
      const items = host.querySelectorAll(".panel-item");
      expect(items).toHaveLength(1);
      expect(items[0].querySelector(".panel-item-title")!.textContent).toBe(
        "회의록",
      );
      expect(items[0].querySelector(".panel-item-date")!.textContent).toBe(
        "2026.07.23",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 실제 타이머로 진행하되, 대기 중인 프로미스 체인(마이크로태스크)을 확실히 흘려보낸다. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mountPanel — delete flow (#18)", () => {
  /** 가드: deleteNote를 안 주면 삭제 버튼 자체를 그리지 않는다(기존 동작 보존). */
  it("omits the delete button when deleteNote is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-item-delete")).toBeNull();
  });

  /** 가드: 삭제 버튼 → 확인 다이얼로그 → 확인해야만 deleteNote가 불리고 목록이 다시 읽힌다. */
  it("confirms before deleting, then reloads the list", async () => {
    const deleteNote = vi.fn(async () => {});
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    const del = host.querySelector<HTMLElement>(".panel-item-delete");
    expect(del).not.toBeNull();
    del!.click();

    // 클릭 직후엔 아직 확인 다이얼로그만 떴을 뿐 삭제되지 않았다.
    expect(deleteNote).not.toHaveBeenCalled();
    expect(host.querySelector(".confirm-overlay")).not.toBeNull();
    expect(host.querySelector(".confirm-msg")!.textContent).toContain("Note A");

    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    expect(deleteNote).toHaveBeenCalledWith("a");
    expect(listNotes).toHaveBeenCalledTimes(2); // 초기 1회 + 삭제 후 리로드 1회
  });

  /** 가드: 삭제 버튼 클릭이 행 클릭(소환)으로 번지지 않는다. */
  it("does not summon when the delete button is clicked", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      deleteNote: vi.fn(async () => {}),
    });

    host.querySelector<HTMLElement>(".panel-item-delete")!.click();
    await flush();
    expect(summon).not.toHaveBeenCalled();
  });

  /**
   * 가드: 삭제 버튼에 포커스된 채 Enter를 눌러도 keydown이 행까지 버블링해
   * 소환(summon)이 함께 일어나지 않는다 — 삭제 확인과 노트 소환이 동시에 나는
   * 이중 동작 회귀 방지.
   */
  it("does not summon when Enter is pressed on the focused delete button", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      deleteNote: vi.fn(async () => {}),
    });

    const del = host.querySelector<HTMLElement>(".panel-item-delete")!;
    del.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();

    expect(summon).not.toHaveBeenCalled();
  });

  /** 가드: 확인 다이얼로그를 취소하면 deleteNote를 부르지 않는다. */
  it("does not delete when the confirmation is cancelled", async () => {
    const deleteNote = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    host.querySelector<HTMLElement>(".panel-item-delete")!.click();
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();

    expect(deleteNote).not.toHaveBeenCalled();
  });

  /** 가드: 삭제 IPC가 실패해도 안내 후 목록을 다시 읽는다(먹통 방지). */
  it("shows an error and still reloads when the delete call fails", async () => {
    const deleteNote = vi.fn(async () => {
      throw new Error("boom");
    });
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    host.querySelector<HTMLElement>(".panel-item-delete")!.click();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    // 실패 안내(alert 모드 — 확인 버튼만) 오버레이가 떴다.
    const overlay = host.querySelector(".confirm-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector(".confirm-cancel")).toBeNull();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    expect(listNotes).toHaveBeenCalledTimes(2);
  });
});

describe("mountPanel — stale summon guard (#17)", () => {
  /** 가드: noteExists가 false면 소환하지 않고 안내 후 목록을 다시 읽는다(빈 창 먹통 방지). */
  it("blocks summoning a note that no longer exists and refreshes the list", async () => {
    const summon = vi.fn();
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon,
      noteExists: async () => false,
    });

    host.querySelector<HTMLElement>(".panel-item")!.click();
    await flush();

    expect(summon).not.toHaveBeenCalled();
    expect(host.querySelector(".confirm-overlay")).not.toBeNull();

    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();
    expect(listNotes).toHaveBeenCalledTimes(2);
  });

  /** 가드: noteExists가 true(또는 생략)면 그대로 소환한다(기존 동작). */
  it("summons directly when the note exists", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      noteExists: async () => true,
    });

    host.querySelector<HTMLElement>(".panel-item")!.click();
    await flush();

    expect(summon).toHaveBeenCalledWith("a");
  });
});

describe("mountPanel — external change signal (#17)", () => {
  /** 가드: onNotesChanged 신호가 오면(디바운스 후) 목록을 다시 읽는다 — 다른 창의 삭제/보관/
   *  저장이 이 창에 반영되는 경로. */
  it("reloads the list when the notes-changed signal fires", async () => {
    vi.useFakeTimers();
    try {
      let changeHandler: (() => void) | undefined;
      const listNotes = vi.fn(async () => []);
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes,
        searchNotes: async () => [],
        summon: vi.fn(),
        onNotesChanged: (handler) => {
          changeHandler = handler;
          return () => {};
        },
      });

      expect(listNotes).toHaveBeenCalledTimes(1);
      expect(changeHandler).toBeTypeOf("function");
      changeHandler!();
      await vi.runAllTimersAsync();

      expect(listNotes).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 가드: 신호가 짧은 간격으로 여러 번 와도 디바운스되어 한 번만 다시 읽는다. */
  it("coalesces bursts of notes-changed signals into a single reload", async () => {
    vi.useFakeTimers();
    try {
      let changeHandler: (() => void) | undefined;
      const listNotes = vi.fn(async () => []);
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes,
        searchNotes: async () => [],
        summon: vi.fn(),
        onNotesChanged: (handler) => {
          changeHandler = handler;
          return () => {};
        },
      });

      changeHandler!();
      changeHandler!();
      changeHandler!();
      await vi.runAllTimersAsync();

      expect(listNotes).toHaveBeenCalledTimes(2); // 초기 1회 + 디바운스된 리로드 1회
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountPanel — add note button (베타 피드백: 패널에서도 노트 추가)", () => {
  /** 가드: createAndOpenNote를 안 주면 "+" 버튼 자체를 그리지 않는다(deleteNote와 같은 관례). */
  it("omits the add button when createAndOpenNote is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-add-btn")).toBeNull();
  });

  /** 가드: "+" 버튼을 누르면 deps.createAndOpenNote를 호출한다(새 노트 생성 + 창 열기). */
  it("calls createAndOpenNote when the add button is clicked", async () => {
    const createAndOpenNote = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      createAndOpenNote,
    });

    const addBtn = host.querySelector<HTMLButtonElement>(".panel-add-btn");
    expect(addBtn).not.toBeNull();
    addBtn!.click();
    await flush();

    expect(createAndOpenNote).toHaveBeenCalledTimes(1);
  });

  /** 가드: 생성 실패 시 기존 알림 패턴(alert 모드 확인 오버레이)으로 안내한다. */
  it("shows a failure dialog when creation fails", async () => {
    const createAndOpenNote = vi.fn(async () => {
      throw new Error("boom");
    });
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      createAndOpenNote,
    });

    host.querySelector<HTMLButtonElement>(".panel-add-btn")!.click();
    await flush();

    const overlay = host.querySelector(".confirm-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector(".confirm-cancel")).toBeNull(); // alert 모드(확인 버튼만)
  });

  /** 가드: 생성 중엔 버튼을 비활성화해 중복 클릭을 막고, 끝나면 다시 활성화한다. */
  it("disables the button while creating and re-enables afterward", async () => {
    let resolveCreate: (() => void) | undefined;
    const createAndOpenNote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      createAndOpenNote,
    });

    const addBtn = host.querySelector<HTMLButtonElement>(".panel-add-btn")!;
    addBtn.click();
    expect(addBtn.disabled).toBe(true);

    resolveCreate!();
    await flush();
    expect(addBtn.disabled).toBe(false);
  });
});

describe("mountPanel — settings button (베타 피드백: 패널에 설정 아이콘 추가)", () => {
  /** 가드: openSettings를 안 주면 버튼 자체를 그리지 않는다(createAndOpenNote와 같은 관례). */
  it("omits the settings button when openSettings is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-settings-btn")).toBeNull();
  });

  /** 가드: 버튼을 누르면 deps.openSettings를 호출한다. */
  it("calls openSettings when the settings button is clicked", async () => {
    const openSettings = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      openSettings,
    });

    const btn = host.querySelector<HTMLButtonElement>(".panel-settings-btn");
    expect(btn).not.toBeNull();
    btn!.click();
    await flush();

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  /** 가드: 실패는 조용히 흡수한다(이 패널엔 토스트가 없다 — 노트 툴바 설정 버튼과 같은 처리,
   * 확인 다이얼로그를 새로 띄우지 않는다). */
  it("swallows a failure without showing a dialog", async () => {
    const openSettings = vi.fn(async () => {
      throw new Error("boom");
    });
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      openSettings,
    });

    host.querySelector<HTMLButtonElement>(".panel-settings-btn")!.click();
    await flush();

    expect(host.querySelector(".confirm-overlay")).toBeNull();
  });
});

describe("mountPanel — multi-select bulk delete (베타 피드백: 검색에서 다중 체크로 모두 제거)", () => {
  /** 가드: deleteNote를 안 주면 "선택" 토글 버튼 자체를 그리지 않는다(선택 모드의 유일한
   * 용도가 일괄 삭제라서 — onDelete·addBtn과 같은 관례). */
  it("omits the select toggle button when deleteNote is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-select-toggle")).toBeNull();
  });

  /** 가드: 선택 모드로 들어가면 체크박스가 나타나고 개별 삭제 버튼은 사라진다(두 삭제 경로가
   * 겹치지 않게 — aria-pressed도 함께 반영). */
  it("entering select mode shows checkboxes and hides the per-item delete button", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
    });

    expect(host.querySelector(".panel-item-checkbox")).toBeNull();
    expect(host.querySelector(".panel-item-delete")).not.toBeNull();

    const toggle = host.querySelector<HTMLButtonElement>(
      ".panel-select-toggle",
    )!;
    toggle.click();

    expect(host.querySelector(".panel-item-checkbox")).not.toBeNull();
    expect(host.querySelector(".panel-item-delete")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  /** 가드: 하나 이상 체크되면 "N개 삭제" 액션 바가 나타나고, 다시 0개가 되면 숨는다. */
  it("shows the bulk delete bar with a count once checked, hides it once unchecked", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    expect(host.querySelector(".panel-bulk-bar")!.hasAttribute("hidden")).toBe(
      true,
    );

    const checkbox = () =>
      host.querySelector<HTMLInputElement>(".panel-item-checkbox")!;
    checkbox().click();
    const bulkBar = host.querySelector(".panel-bulk-bar")!;
    expect(bulkBar.hasAttribute("hidden")).toBe(false);
    expect(bulkBar.querySelector(".panel-bulk-delete")!.textContent).toContain(
      "1",
    );

    checkbox().click();
    expect(host.querySelector(".panel-bulk-bar")!.hasAttribute("hidden")).toBe(
      true,
    );
  });

  /** 가드: 선택 모드에서 행을 클릭해도(체크박스가 아니라 행 자체) 소환 대신 체크가 토글된다. */
  it("clicking a row in select mode toggles the checkbox instead of summoning", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      deleteNote: vi.fn(async () => {}),
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    host.querySelector<HTMLElement>(".panel-item")!.click();
    await flush();

    expect(summon).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.checked,
    ).toBe(true);
  });

  /** 가드: 체크박스를 직접 클릭해도 소환되지 않고, 정확히 한 번만 토글된다(더블 토글 없음 —
   * 삭제 버튼의 Enter/Space 이중 동작 방지와 같은 함정). */
  it("clicking the checkbox itself does not summon and toggles exactly once", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      deleteNote: vi.fn(async () => {}),
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.click();

    expect(summon).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.checked,
    ).toBe(true);
  });

  /** 가드: 선택 모드에서 포커스된 행에 Enter를 눌러도 체크가 토글된다(체크박스 자체는
   * tab으로 따로 포커스·Space로 토글 가능 — 네이티브 동작, 별도 배선 불필요). */
  it("pressing Enter on a focused row toggles the checkbox in select mode", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      deleteNote: vi.fn(async () => {}),
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    host
      .querySelector<HTMLElement>(".panel-item")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );

    expect(summon).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.checked,
    ).toBe(true);
  });

  /** 가드: 확인 → 체크된 항목 모두 삭제(항목별 호출) → 목록 갱신. */
  it("confirms, deletes every checked note, and reloads the list", async () => {
    const deleteNote = vi.fn(async () => {});
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
      summary({ id: "b", title: "Note B" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    const checkboxes = () =>
      host.querySelectorAll<HTMLInputElement>(".panel-item-checkbox");
    checkboxes()[0].click();
    checkboxes()[1].click();

    const bulkBtn =
      host.querySelector<HTMLButtonElement>(".panel-bulk-delete")!;
    expect(bulkBtn.textContent).toContain("2");
    bulkBtn.click();

    // 클릭 직후엔 확인 다이얼로그만 — 아직 삭제되지 않았다(개수를 문구에 명시).
    expect(deleteNote).not.toHaveBeenCalled();
    expect(host.querySelector(".confirm-msg")!.textContent).toContain("2");

    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    expect(deleteNote).toHaveBeenCalledWith("a");
    expect(deleteNote).toHaveBeenCalledWith("b");
    expect(listNotes).toHaveBeenCalledTimes(2); // 초기 1회 + 삭제 후 리로드 1회
  });

  /** 가드: 확인 다이얼로그를 취소하면 아무것도 지우지 않는다. */
  it("does not delete when the bulk confirmation is cancelled", async () => {
    const deleteNote = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.click();
    host.querySelector<HTMLButtonElement>(".panel-bulk-delete")!.click();
    host.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    await flush();

    expect(deleteNote).not.toHaveBeenCalled();
  });

  /** 가드: 일부만 실패하면 실패 개수를 모아 한 번에 안내하고, 성공한 항목은 목록·선택에서
   * 사라지며 실패한(여전히 존재하는) 항목만 계속 체크된 채로 남는다. */
  it("aggregates partial failures into one notice and keeps only the failed item selected", async () => {
    let notes = [
      summary({ id: "a", title: "Note A" }),
      summary({ id: "b", title: "Note B" }),
    ];
    const deleteNote = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("boom"); // b는 삭제 실패(예: 파일 잠금)로 남는다.
      notes = notes.filter((n) => n.id !== id);
    });
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => notes,
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote,
    });

    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    const checkboxes = () =>
      host.querySelectorAll<HTMLInputElement>(".panel-item-checkbox");
    checkboxes()[0].click();
    checkboxes()[1].click();

    host.querySelector<HTMLButtonElement>(".panel-bulk-delete")!.click();
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    // 실패 안내(1개 실패) 오버레이 — alert 모드(확인 버튼만, 개수 명시).
    const overlay = host.querySelector(".confirm-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector(".confirm-cancel")).toBeNull();
    expect(overlay!.querySelector(".confirm-msg")!.textContent).toContain("1");

    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    const titles = host.querySelectorAll(".panel-item-title");
    expect(titles).toHaveLength(1);
    expect(titles[0].textContent).toBe("Note B");
    expect(checkboxes()[0].checked).toBe(true);
  });

  /** 가드: 선택 모드를 나가면(다시 토글) 선택이 비워지고 체크박스·액션 바가 사라진다 —
   * 다음에 다시 들어가도 이전 체크가 남아 있지 않는다. */
  it("clears the selection and hides checkboxes/bulk bar when leaving select mode", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
    });

    const toggle = host.querySelector<HTMLButtonElement>(
      ".panel-select-toggle",
    )!;
    toggle.click();
    host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.click();
    expect(host.querySelector(".panel-bulk-bar")!.hasAttribute("hidden")).toBe(
      false,
    );

    toggle.click(); // 선택 모드 나가기.
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".panel-item-checkbox")).toBeNull();
    expect(host.querySelector(".panel-bulk-bar")!.hasAttribute("hidden")).toBe(
      true,
    );

    toggle.click(); // 다시 들어가면 이전 체크가 남아 있지 않다.
    expect(
      host.querySelector<HTMLInputElement>(".panel-item-checkbox")!.checked,
    ).toBe(false);
  });

  /** 가드: 선택 모드 중 다른 창이 체크된 노트를 지우면(외부 변경 신호) 그 항목의 체크가
   * 자동으로 풀린다 — 화면에 없는 노트가 "선택됨"으로 남아 있지 않게 한다. */
  it("unchecks a selected note that was deleted elsewhere when the change signal fires", async () => {
    vi.useFakeTimers();
    try {
      let changeHandler: (() => void) | undefined;
      let notes = [
        summary({ id: "a", title: "Note A" }),
        summary({ id: "b", title: "Note B" }),
      ];
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes: async () => notes,
        searchNotes: async () => [],
        summon: vi.fn(),
        deleteNote: vi.fn(async () => {}),
        onNotesChanged: (handler) => {
          changeHandler = handler;
          return () => {};
        },
      });

      host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
      const checkboxes = () =>
        host.querySelectorAll<HTMLInputElement>(".panel-item-checkbox");
      checkboxes()[0].click(); // "a" 체크
      checkboxes()[1].click(); // "b" 체크
      expect(host.querySelector(".panel-bulk-delete")!.textContent).toContain(
        "2",
      );

      // 다른 창이 "a"를 지웠다고 가정.
      notes = notes.filter((n) => n.id !== "a");
      changeHandler!();
      await vi.runAllTimersAsync();

      expect(host.querySelector(".panel-bulk-delete")!.textContent).toContain(
        "1",
      );
      expect(checkboxes()).toHaveLength(1);
      expect(checkboxes()[0].checked).toBe(true); // "b"는 여전히 체크된 채.
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountPanel — 정렬 드롭다운 (F4)", () => {
  /** 가드: saveSort를 안 주면 드롭다운 자체를 그리지 않는다("IO 없으면 UI 없음" 관례 —
   * 다음 실행에 사라지는 선택지를 보여 주지 않는다). */
  it("omits the sort select when saveSort is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-sort-select")).toBeNull();
  });

  /** 가드: 드롭다운은 어휘 6개를 모두 그리고, 저장된 값을 초기 선택으로 반영한다. */
  it("renders every mode and preselects the saved one", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      initialSort: "chars-desc",
      saveSort: vi.fn(),
    });

    const select = host.querySelector<HTMLSelectElement>(".panel-sort-select")!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "created-desc",
      "created-asc",
      "updated-desc",
      "title-asc",
      "chars-desc",
      "opened-desc",
    ]);
    expect(select.value).toBe("chars-desc");
  });

  /**
   * 가드(핵심, i18n 드리프트): 옵션에 **보이는 글자**가 실제 i18n 라벨이다.
   *
   * 라벨은 `t(`panel.sort.${mode}`)` 동적 키로 만든다 — `packs.test.ts`의 드리프트 가드는
   * ko.json↔en 매니페스트만 대조할 뿐 소스의 동적 키 사용처를 스캔하지 못하므로, 7번째
   * 모드를 추가하며 ko.json 키를 빠뜨려도 거기서는 안 걸린다. 그 경우 `t()`의 최종 폴백이
   * 키 문자열 자체를 돌려줘 드롭다운에 `panel.sort.xxx`가 그대로 노출된다 — 여기서 잡는다.
   * value가 아니라 textContent를 보는 것이 요점이다.
   */
  it("labels every option with its i18n string, never a raw key", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      saveSort: vi.fn(),
    });

    const select = host.querySelector<HTMLSelectElement>(".panel-sort-select")!;
    const dict = ko as Record<string, string>;
    for (const option of Array.from(select.options)) {
      const key = `panel.sort.${option.value}`;
      expect(dict[key], `${key}: ko.json에 없다`).toBeTruthy();
      expect(option.textContent).toBe(dict[key]);
      expect(option.textContent).not.toBe(key); // 원문 키 노출 금지.
    }
    expect(select.getAttribute("aria-label")).toBe(dict["panel.sort.label"]);
  });

  /** 가드: 어휘 6개 + 드롭다운 aria-label의 ko 라벨이 실제로 사전에 있다(위 가드가 마운트
   * 경로를 타는 것과 달리, 키 집합 자체를 명시로 못 박는다). */
  it("has a ko.json label for every sort mode", () => {
    const dict = ko as Record<string, string>;
    for (const key of [
      "panel.sort.label",
      "panel.sort.created-desc",
      "panel.sort.created-asc",
      "panel.sort.updated-desc",
      "panel.sort.title-asc",
      "panel.sort.chars-desc",
      "panel.sort.opened-desc",
    ]) {
      expect(dict[key], `${key}: ko.json에 없다`).toBeTruthy();
    }
  });

  /** 가드: 저장된 값이 어휘에 없으면 기본값이 선택된 채로 뜬다(빈 select 방지). */
  it("preselects the default when the saved value is unknown", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [],
      searchNotes: async () => [],
      summon: vi.fn(),
      initialSort: "nope",
      saveSort: vi.fn(),
    });
    expect(
      host.querySelector<HTMLSelectElement>(".panel-sort-select")!.value,
    ).toBe("created-desc");
  });

  /** 가드(핵심): 초기 목록이 기본 정렬(추가순 최신)로 그려진다 — 백엔드가 주는 배열 순서를
   * 그대로 믿지 않는다. */
  it("renders the initial list in created-desc order", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [
        summary({ id: "a", title: "옛것", created_at: 100 }),
        summary({ id: "b", title: "새것", created_at: 900 }),
      ],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(
      Array.from(host.querySelectorAll(".panel-item-title")).map(
        (e) => e.textContent,
      ),
    ).toEqual(["새것", "옛것"]);
  });

  /** 가드: initialSort는 드롭다운이 없어도(saveSort 미제공) 정렬에 적용된다 — 정렬은 순수
   * 함수라 IO가 필요 없다. */
  it("applies initialSort even without the select", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [
        summary({ id: "a", title: "옛것", created_at: 100 }),
        summary({ id: "b", title: "새것", created_at: 900 }),
      ],
      searchNotes: async () => [],
      summon: vi.fn(),
      initialSort: "created-asc",
    });
    expect(
      Array.from(host.querySelectorAll(".panel-item-title")).map(
        (e) => e.textContent,
      ),
    ).toEqual(["옛것", "새것"]);
  });

  /** 가드(핵심): 드롭다운을 바꾸면 saveSort로 영속화하고, 목록을 **다시 읽지 않고** 그 자리에서
   * 다시 늘어놓는다(정렬에 IPC 왕복을 한 번 더 걸 이유가 없다). */
  it("saves the new mode and re-sorts in place without reloading", async () => {
    const saveSort = vi.fn();
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "옛것", created_at: 100 }),
      summary({ id: "b", title: "새것", created_at: 900 }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      saveSort,
    });

    const select = host.querySelector<HTMLSelectElement>(".panel-sort-select")!;
    select.value = "created-asc";
    select.dispatchEvent(new Event("change"));

    expect(saveSort).toHaveBeenCalledWith("created-asc");
    expect(listNotes).toHaveBeenCalledTimes(1); // 초기 1회뿐 — 재조회 없음.
    expect(
      Array.from(host.querySelectorAll(".panel-item-title")).map(
        (e) => e.textContent,
      ),
    ).toEqual(["옛것", "새것"]);
  });

  /** 가드: 선택한 정렬은 이후의 검색 결과에도 계속 걸린다(검색 중에도 같은 규칙). */
  it("keeps applying the chosen mode to later search results", async () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      await mountPanel(host, {
        listNotes: async () => [],
        searchNotes: async () => [
          hit({ id: "a", title: "옛것", snippet: "hit", created_at: 100 }),
          hit({ id: "b", title: "새것", snippet: "hit", created_at: 900 }),
        ],
        summon: vi.fn(),
        searchDebounceMs: 0,
        saveSort: vi.fn(),
      });

      const select =
        host.querySelector<HTMLSelectElement>(".panel-sort-select")!;
      select.value = "created-asc";
      select.dispatchEvent(new Event("change"));

      const input = host.querySelector<HTMLInputElement>(".panel-search")!;
      input.value = "것";
      input.dispatchEvent(new Event("input"));
      await vi.runAllTimersAsync();

      expect(
        Array.from(host.querySelectorAll(".panel-item-title")).map(
          (e) => e.textContent,
        ),
      ).toEqual(["옛것", "새것"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mountPanel — 즐겨찾기 토글 (F3)", () => {
  /** 가드: toggleFavorite을 안 주면 별 버튼 자체를 그리지 않는다(deleteNote와 같은 관례). */
  it("omits the favorite button when toggleFavorite is not provided", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
    });
    expect(host.querySelector(".panel-item-favorite")).toBeNull();
  });

  /** 가드: 버튼의 aria-pressed·라벨이 현재 즐겨찾기 상태를 반영한다(스크린리더가 읽는 유일한 단서). */
  it("reflects the current favorite state on the button", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [
        summary({ id: "a", title: "Note A", created_at: 200 }),
        summary({ id: "b", title: "Note B", created_at: 100, favorite: true }),
      ],
      searchNotes: async () => [],
      summon: vi.fn(),
      toggleFavorite: vi.fn(async () => {}),
    });

    // 즐겨찾기 항목이 위로 올라오므로 첫 번째가 "b"다.
    const buttons = host.querySelectorAll<HTMLButtonElement>(
      ".panel-item-favorite",
    );
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect(buttons[0].getAttribute("aria-label")).not.toBe(
      buttons[1].getAttribute("aria-label"),
    );
  });

  /** 가드(핵심): 클릭하면 **뒤집힌 값**으로 toggleFavorite을 부르고 목록을 다시 읽는다
   * (즐겨찾기 묶음이 곧바로 위로 올라오도록). */
  it("calls toggleFavorite with the flipped value and reloads", async () => {
    const toggleFavorite = vi.fn(async () => {});
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      toggleFavorite,
    });

    host.querySelector<HTMLButtonElement>(".panel-item-favorite")!.click();
    await flush();

    expect(toggleFavorite).toHaveBeenCalledWith("a", true);
    expect(listNotes).toHaveBeenCalledTimes(2); // 초기 1회 + 토글 후 리로드 1회.
  });

  /** 가드: 이미 즐겨찾기인 항목은 해제(false)로 부른다. */
  it("turns the favorite off for an item that is already on", async () => {
    const toggleFavorite = vi.fn(async () => {});
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [
        summary({ id: "a", title: "Note A", favorite: true }),
      ],
      searchNotes: async () => [],
      summon: vi.fn(),
      toggleFavorite,
    });

    host.querySelector<HTMLButtonElement>(".panel-item-favorite")!.click();
    await flush();

    expect(toggleFavorite).toHaveBeenCalledWith("a", false);
  });

  /** 가드: 버튼 클릭이 행 클릭(소환)으로 번지지 않는다 — 즐겨찾기하려다 창이 열리면 안 된다. */
  it("does not summon when the favorite button is clicked", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      toggleFavorite: vi.fn(async () => {}),
    });

    host.querySelector<HTMLButtonElement>(".panel-item-favorite")!.click();
    await flush();
    expect(summon).not.toHaveBeenCalled();
  });

  /** 가드: 포커스된 버튼에서 Enter를 눌러도 행의 Enter 핸들러(소환)가 함께 돌지 않는다
   * (삭제 버튼과 같은 이중 동작 함정). */
  it("does not summon when Enter is pressed on the focused favorite button", async () => {
    const summon = vi.fn();
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon,
      toggleFavorite: vi.fn(async () => {}),
    });

    host
      .querySelector<HTMLButtonElement>(".panel-item-favorite")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    await flush();

    expect(summon).not.toHaveBeenCalled();
  });

  /** 가드: IPC가 실패하면 안내 후 목록을 다시 읽는다(삭제 실패와 같은 처리 — "안 바뀌었음"이
   * 화면에 그대로 반영된다). */
  it("shows an error and still reloads when the toggle call fails", async () => {
    const listNotes = vi.fn(async () => [
      summary({ id: "a", title: "Note A" }),
    ]);
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes,
      searchNotes: async () => [],
      summon: vi.fn(),
      toggleFavorite: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    host.querySelector<HTMLButtonElement>(".panel-item-favorite")!.click();
    await flush();

    const overlay = host.querySelector(".confirm-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector(".confirm-cancel")).toBeNull(); // alert 모드.
    host.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    await flush();

    expect(listNotes).toHaveBeenCalledTimes(2);
  });

  /**
   * 가드(핵심 회귀): 토글로 **목록 순서가 바뀌는** 재렌더에서도 포커스가 같은 노트의 별
   * 버튼에 남는다.
   *
   * 예전엔 `captureFocusTarget`이 옛 DOM 인덱스를 이미 새로 정렬된 `currentItems`에 대봐서
   * 엉뚱한 이웃 행을 가리켰고, `FocusTarget`에 "favorite" 파트가 없어 행(li)으로 포커스가
   * 갔다 — 그 상태로 Enter를 누르면 **건드리지도 않은 옆 노트가 열렸다**. 별 버튼 keydown의
   * stopPropagation은 같은 이벤트의 버블링만 막을 뿐 재렌더 뒤의 새 Enter는 막지 못한다.
   */
  it("keeps focus on the same note's star across the re-sort that follows a toggle", async () => {
    const notes = [1, 2, 3, 4, 5].map((n) =>
      summary({ id: `n${n}`, title: `Note ${n}`, created_at: n * 100 }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    try {
      await mountPanel(host, {
        listNotes: async () => notes.map((n) => ({ ...n })),
        searchNotes: async () => [],
        summon: vi.fn(),
        toggleFavorite: async (id, favorite) => {
          notes.find((n) => n.id === id)!.favorite = favorite;
        },
      });

      const starAt = (i: number) =>
        host.querySelectorAll<HTMLButtonElement>(".panel-item-favorite")[i];
      const titles = () =>
        Array.from(host.querySelectorAll(".panel-item-title")).map(
          (e) => e.textContent,
        );

      // created-desc라 [5,4,3,2,1] — 4번째 행이 "Note 2"다.
      expect(titles()).toEqual([
        "Note 5",
        "Note 4",
        "Note 3",
        "Note 2",
        "Note 1",
      ]);
      starAt(3).focus();
      expect(document.activeElement).toBe(starAt(3));

      starAt(3).click();
      await flush();

      // 즐겨찾기 묶음으로 올라가 맨 위가 됐다(인덱스 3 → 0).
      expect(titles()).toEqual([
        "Note 2",
        "Note 5",
        "Note 4",
        "Note 3",
        "Note 1",
      ]);
      // 포커스는 인덱스가 아니라 **그 노트**를 따라간다 — 새 맨 위 행의 별 버튼.
      expect(document.activeElement).toBe(starAt(0));
      expect(starAt(0).getAttribute("aria-pressed")).toBe("true");
    } finally {
      host.remove();
    }
  });

  /** 가드: 다중 선택 모드 중엔 삭제 버튼과 똑같이 감춘다 — 그 화면의 유일한 동작은 "고르기"다. */
  it("hides the favorite button in select mode", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
      toggleFavorite: vi.fn(async () => {}),
    });

    expect(host.querySelector(".panel-item-favorite")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
    expect(host.querySelector(".panel-item-favorite")).toBeNull();
  });
});

describe("mountPanel — 즐겨찾기 버튼 위치 (좌측 정렬, 삭제 버튼과의 오조작 방지)", () => {
  /** 가드(핵심): 별 버튼이 타이틀보다 앞(행의 맨 앞 쪽)에 있고, 삭제 버튼과는 DOM 상
   * 인접하지 않는다(둘 사이에 타이틀·날짜가 있다) — 오른쪽 끝에 나란히 있어 실수로
   * 삭제를 누르기 쉬웠던 원래 배치를 DOM 순서 자체로 되돌릴 수 없게 만든다. */
  it("renders the favorite button before the title and non-adjacent to the delete button", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [
        summary({ id: "a", title: "Note A", created_at: 100 }),
      ],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
      toggleFavorite: vi.fn(async () => {}),
    });

    const head = host.querySelector(".panel-item-head")!;
    const children = Array.from(head.children);
    const favIndex = children.findIndex((el) =>
      el.classList.contains("panel-item-favorite"),
    );
    const titleIndex = children.findIndex((el) =>
      el.classList.contains("panel-item-title"),
    );
    const deleteIndex = children.findIndex((el) =>
      el.classList.contains("panel-item-delete"),
    );

    expect(favIndex).toBe(0); // head(행 헤더)의 첫 번째 자식.
    expect(favIndex).toBeLessThan(titleIndex);
    expect(titleIndex).toBeLessThan(deleteIndex);
    // 별과 삭제 사이(인덱스 차 > 1)에 타이틀(·날짜)이 끼어 있다 — 서로 인접하지 않는다.
    expect(deleteIndex - favIndex).toBeGreaterThan(1);
  });

  /** 가드: 다중 선택 체크박스가 있을 때도(선택 모드) 순서 규칙은 "체크박스가 맨 앞"이다 —
   * 다만 선택 모드 중엔 별 버튼 자체를 그리지 않으므로(위 "hides the favorite button in
   * select mode") 체크박스와 별이 한 행에 같이 나타나 순서를 다툴 일은 없다. */
  it("never renders the checkbox and the favorite button in the same row", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
      toggleFavorite: vi.fn(async () => {}),
    });
    host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();

    const head = host.querySelector(".panel-item-head")!;
    expect(head.querySelector(".panel-item-checkbox")).not.toBeNull();
    expect(head.querySelector(".panel-item-favorite")).toBeNull();
  });

  /**
   * 가드: 별↔삭제의 상대 탭 순서는 "별 먼저"다. 행(li) 자체가 tabIndex=0인 컨테이너라
   * 컨테이너-후손 관계에서는 항상 li가 자신의 버튼들보다 먼저 탭 정지점이 되지만(브라우저의
   * 표준 sequential focus navigation은 트리 순서를 따른다 — 이는 이 변경 전에도 같았다),
   * 후손들끼리의 상대 순서는 DOM 순서 그대로다 — 별을 타이틀 앞으로 옮긴 뒤에도 별은
   * 여전히 삭제보다 앞선 문서 위치에 있다.
   */
  it("keeps the favorite button before the delete button in document (tab) order", async () => {
    const host = document.createElement("div");
    await mountPanel(host, {
      listNotes: async () => [summary({ id: "a", title: "Note A" })],
      searchNotes: async () => [],
      summon: vi.fn(),
      deleteNote: vi.fn(async () => {}),
      toggleFavorite: vi.fn(async () => {}),
    });

    const row = host.querySelector<HTMLLIElement>(".panel-item")!;
    const fav = row.querySelector<HTMLButtonElement>(".panel-item-favorite")!;
    const del = row.querySelector<HTMLButtonElement>(".panel-item-delete")!;

    expect(row.tabIndex).toBe(0); // 행 자체도 여전히 탭 정지점(Enter=소환).
    expect(fav.tabIndex).toBe(0);
    expect(del.tabIndex).toBe(0);
    // del이 fav보다 뒤(DOCUMENT_POSITION_FOLLOWING)에 있다 = 별이 삭제보다 먼저 탭된다.
    expect(
      fav.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("mountPanel — 다중 선택 모드 포커스 보존 (2차 비판 검토 confirmed[5])", () => {
  /** 가드: 체크박스에 포커스한 채(Tab으로 도달했다고 가정) Space로 토글을 반복해도(=native
   * click) 매번 같은 항목의 체크박스에 포커스가 남는다. renderList가 매 토글마다 <li>·체크박스
   * DOM을 통째로 새로 만들어도(replaceChildren) draw()가 포커스를 명시적으로 되돌려줘야
   * 한다 — 안 그러면 포커스가 body로 튀어 다음 Tab이 검색창부터 다시 시작한다. */
  it("keeps focus on the same checkbox across repeated toggles", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      await mountPanel(host, {
        listNotes: async () => [
          summary({ id: "a", title: "Note A" }),
          summary({ id: "b", title: "Note B" }),
          summary({ id: "c", title: "Note C" }),
        ],
        searchNotes: async () => [],
        summon: vi.fn(),
        deleteNote: vi.fn(async () => {}),
      });

      host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
      const checkboxAt = (i: number) =>
        host.querySelectorAll<HTMLInputElement>(".panel-item-checkbox")[i];

      // Tab으로 두 번째 항목("b")의 체크박스에 도달했다고 가정.
      checkboxAt(1).focus();
      expect(document.activeElement).toBe(checkboxAt(1));

      // Space(=click)로 토글을 3회 반복 — 매번 전체 재렌더가 일어나 체크박스 DOM 자체가
      // 새로 만들어지지만, 포커스는 매번 같은 항목("b")의 (새) 체크박스로 돌아와야 한다.
      for (let i = 0; i < 3; i++) {
        checkboxAt(1).click();
        expect(checkboxAt(1).checked).toBe(i % 2 === 0);
        expect(document.activeElement).toBe(checkboxAt(1));
      }
    } finally {
      host.remove();
    }
  });

  /** 가드: 체크박스가 아니라 행(li) 자체에 포커스한 채 Enter로 토글해도(행 클릭/Enter 경로,
   * activate()) 포커스가 같은 행에 남는다. */
  it("keeps focus on the same row when toggled via Enter on the row itself", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    try {
      await mountPanel(host, {
        listNotes: async () => [
          summary({ id: "a", title: "Note A" }),
          summary({ id: "b", title: "Note B" }),
        ],
        searchNotes: async () => [],
        summon: vi.fn(),
        deleteNote: vi.fn(async () => {}),
      });

      host.querySelector<HTMLButtonElement>(".panel-select-toggle")!.click();
      const rowAt = (i: number) =>
        host.querySelectorAll<HTMLElement>(".panel-item")[i];

      rowAt(0).focus();
      expect(document.activeElement).toBe(rowAt(0));

      rowAt(0).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );

      expect(
        host.querySelectorAll<HTMLInputElement>(".panel-item-checkbox")[0]
          .checked,
      ).toBe(true);
      // rowAt(0)은 토글 전의(이미 교체된) 옛 노드를 가리키므로 다시 조회해 비교한다.
      expect(document.activeElement).toBe(rowAt(0));
    } finally {
      host.remove();
    }
  });
});

/**
 * 즐겨찾기 별의 "켜짐은 항상 또렷" 규칙은 **CSS 특이도**에 달려 있는데 jsdom은 시트를
 * 계산하지 않는다 — 시트 원문에서 그 장치가 살아 있는지 확인한다(`settings.test.ts`가
 * 다크 오버라이드를 검사하는 것과 같은 방식).
 */
describe("styles.css — 즐겨찾기 별 특이도", () => {
  const css = readFileSync("src/styles.css", "utf8");

  /**
   * 가드(핵심 회귀): 행 호버로 별을 드러내는 규칙이 **켜진 별을 제외**한다.
   *
   * `.panel-item:hover .panel-item-favorite`는 특이도 (0,3,0)이라 `[aria-pressed="true"]`
   * (0,2,0)를 언제나 이긴다 — :not() 제외가 빠지면 즐겨찾기한 항목에 마우스를 올릴 때마다
   * 별이 0.55로 흐려져 요구가 정확히 뒤집힌다.
   */
  it("excludes pressed stars from the row-hover reveal", () => {
    for (const prefix of [":hover", ":focus-within"]) {
      expect(
        css,
        `${prefix} 드러내기 규칙에 :not([aria-pressed="true"])가 없다`,
      ).toContain(
        `.panel-item${prefix} .panel-item-favorite:not([aria-pressed="true"])`,
      );
    }
  });

  /** 가드: 별을 직접 겨냥한 규칙이 위 (0,4,0) 드러내기 규칙을 이기도록 조상까지 적는다. */
  it("scopes the direct hover/focus rule high enough to win", () => {
    expect(css).toContain(".panel-item:hover .panel-item-favorite:hover");
    expect(css).toContain(
      ".panel-item:focus-within .panel-item-favorite:focus-visible",
    );
  });
});
