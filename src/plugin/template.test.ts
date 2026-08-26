/**
 * template 번들 가드 + 표현식 테스트 — 실제 main.js를 mock memo로 구동해 키워드 치환·
 * {cursor} 오프셋·삽입 모드·저장(현재 메모→템플릿) 동작을 검증한다(미러 폴더의 실물 아티팩트).
 *
 * mock memo의 settings는 **중앙 호스트와 같은 순수 모듈**(shared/plugin-settings)로 경계를
 * 재현한다 — 기본값 병합 · list 배열 변환 · select 라벨→값 마이그레이션까지 포함해,
 * 이 테스트가 곧 "호스트가 주는 값으로 이 플러그인이 도는가"의 계약 테스트가 된다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BUILTIN_PLUGINS, resolveBuiltinPluginNls } from "./builtin";
import {
  fromPluginSettingValue,
  mergeSettingDefaults,
  parseListBlob,
  serializeListBlob,
  toPluginSettingValue,
} from "../shared/plugin-settings";
// 설정 창(호스트)이 같은 로케일화 규칙을 위해 따로 갖는 기본 세트 — 두 파일이 서로 다른 실행
// 환경(플러그인 샌드박스 vs 설정 창)이라 부득이 데이터를 나눠 갖는다. 아래 "드리프트 가드"
// describe가 이 실물 main.js의 실행 결과와 대조해 둘이 갈라지지 않게 고정한다.
import {
  TEMPLATE_EN_DEFAULT_TEMPLATES,
  TEMPLATE_KO_DEFAULT_TEMPLATES,
} from "../settings/settings";

/** 캡처된 삽입 인자 형태. */
type InsertArg = { text: string; mode: string; caret?: number };

interface RunOpts {
  settings: Record<string, unknown>;
  note?: { id?: string; path: string; content: string } | null;
  /** pickList가 돌려줄 선택 id(null=취소). */
  pick?: string | null;
  /** prompt가 돌려줄 입력값(null=취소). */
  promptValue?: string | null;
  /** memo.i18n.locale()이 돌려줄 활성 로케일(기본 "ko" — 미지정 시 기존 테스트와 동일). */
  locale?: string;
}

/** template 매니페스트의 설정 스키마(호스트 경계 재현의 기준). */
const SCHEMA = BUILTIN_PLUGINS.find((p) => p.id === "template")!.settings!;

/** main.js가 부르는 memo 브리지를 흉내 내고 호출을 기록한다(설정은 호스트 경계 규칙 그대로). */
function makeMemo(opts: RunOpts) {
  const state = {
    buttons: {} as Record<string, () => void>,
    inserts: [] as InsertArg[],
    sets: [] as { key: string; value: unknown }[],
    toasts: [] as string[],
    picks: [] as unknown[],
    prompts: [] as unknown[],
    // 저장 형태(디스크와 같은 모양) — 기본값 병합·정규화를 거친 값.
    store: mergeSettingDefaults(SCHEMA, opts.settings),
  };
  const field = (key: string) => SCHEMA.find((f) => f.key === key);
  const memo = {
    settings: {
      getAll: () => {
        const out: Record<string, unknown> = {};
        for (const f of SCHEMA)
          out[f.key] = toPluginSettingValue(f, state.store[f.key]);
        return Promise.resolve(out);
      },
      set: (a: { key: string; value: unknown }) => {
        state.sets.push(a);
        // 호스트가 하는 일: 배열 → 블롭 직렬화(+이름 살균).
        state.store[a.key] = fromPluginSettingValue(field(a.key), a.value);
        return Promise.resolve(null);
      },
    },
    ui: {
      addToolbarButton: (b: { id: string; onClick: () => void }) => {
        state.buttons[b.id] = b.onClick;
        return Promise.resolve(null);
      },
      toast: (a: { title: string }) => {
        state.toasts.push(a.title);
        return Promise.resolve(null);
      },
      pickList: (a: unknown) => {
        state.picks.push(a);
        return Promise.resolve(opts.pick ?? null);
      },
      prompt: (a: unknown) => {
        state.prompts.push(a);
        return Promise.resolve(opts.promptValue ?? null);
      },
    },
    notes: { current: () => Promise.resolve(opts.note ?? null) },
    editor: {
      insertText: (a: InsertArg) => {
        state.inserts.push(a);
        return Promise.resolve(null);
      },
    },
    i18n: { locale: () => Promise.resolve(opts.locale ?? "ko") },
  };
  return { memo, state };
}

/** 마이크로태스크 체인을 넉넉히 비운다(설정 로드→버튼 등록→클릭 핸들러의 promise 사슬). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 실제 template main.js를 mock memo로 실행하고, 버튼 등록까지 마친 상태를 돌려준다. */
async function runTemplate(opts: RunOpts) {
  const code = BUILTIN_PLUGINS.find((p) => p.id === "template")!.code;
  const { memo, state } = makeMemo(opts);
  new Function("memo", code)(memo);
  await flush();
  return state;
}

/**
 * 표현식 테스트 공통 설정(고정 시계 필요 항목).
 *
 * 값은 매니페스트가 선언한 **value**("cursor"·"iso")로 둔다 — select 저장값은 언제나 value다
 * (라벨→value 마이그레이션은 제거됐다). 플러그인은 매핑 테이블 없이 이 값을 그대로 받는다.
 */
const base = {
  insertMode: "cursor",
  dateFormat: "iso",
};

describe("template 번들 가드", () => {
  // ko로 nls 해석한 뷰 — 이 describe의 가드들은 "사용자가 실제로 보는 한국어 문구"를
  // 검증하므로 raw(`%키%`)가 아니라 해석된 값을 봐야 한다(축 2, builtin/index.ts 문서 참고).
  const plugin = resolveBuiltinPluginNls(
    BUILTIN_PLUGINS.find((p) => p.id === "template")!,
    "ko",
  );
  const byKey = (k: string) => plugin.settings?.find((f) => f.key === k);

  /** 가드: 이름·최소 권한(툴바·설정·노트 읽기/쓰기)만 선언한다. */
  it("declares name and minimal permissions", () => {
    expect(plugin.name).toBe("템플릿");
    expect(plugin.permissions).toEqual([
      "ui",
      "settings",
      "notes:read",
      "notes:write",
    ]);
  });

  /** 가드: templates=list(여러 항목 카드) + 삽입/날짜 select, 기본 templates에 예시 키워드.
   * 버튼 위치는 전역 "툴바 배치"로 이관돼 더는 이 플러그인 설정에 없다. */
  it("declares templates(list) and the select settings", () => {
    expect(byKey("templates")?.type).toBe("list");
    expect(byKey("insertMode")?.type).toBe("select");
    expect(byKey("dateFormat")?.type).toBe("select");
    // 저장 값은 라벨이 아니라 value다 — 라벨을 다듬어도 저장된 값이 고아가 되지 않는다.
    expect(byKey("insertMode")?.default).toBe("cursor");
    expect(byKey("insertMode")?.options).toContainEqual({
      value: "append",
      label: "문서 끝에 추가",
    });
    expect(byKey("position")).toBeUndefined();
    const def = String(byKey("templates")?.default);
    expect(def).toContain("{week}");
    expect(def).toContain("{cursor}");
    expect(def).toContain("==="); // 저장 형식은 여전히 `=== 이름 ===` 블롭(호스트가 카드로 편집)
    // list 편집기는 키워드 칩(hints)으로 토큰을 노출한다.
    const hints = byKey("templates")?.hints ?? [];
    expect(hints.some((h) => h.token === "{cursor}")).toBe(true);
  });

  /** 가드: 코드가 삽입·저장에 필요한 브리지 호출을 모두 쓴다. */
  it("wires the bridge calls it needs", () => {
    expect(plugin.code).toContain("memo.ui.addToolbarButton");
    expect(plugin.code).toContain("memo.ui.pickList");
    expect(plugin.code).toContain("memo.ui.prompt");
    expect(plugin.code).toContain("memo.editor.insertText");
    expect(plugin.code).toContain("memo.notes.current");
    expect(plugin.code).toContain("memo.settings.set");
    // 설정을 키 단위로 세 번 읽지 않고 병합 스냅샷 하나로 읽는다.
    expect(plugin.code).toContain("memo.settings.getAll");
  });

  /** 가드(이관): 호스트가 소유한 규칙을 플러그인이 다시 구현하지 않는다 — 블롭 파서도,
   * 라벨↔값 매핑 테이블도, 헤더 충돌 방지용 `=` 제거도 코드에서 사라졌다. */
  it("no longer reimplements host-owned serialization or label maps", () => {
    expect(plugin.code).not.toContain('"=== "'); // 헤더 직렬화 리터럴
    expect(plugin.code).not.toContain("DATE_FMT"); // 라벨→코드값 매핑 테이블
    expect(plugin.code).not.toContain("parseTemplates");
    expect(plugin.code).not.toContain('split("=")');
  });

  /** 가드: README가 키워드를 안내한다(선언-문서 표류 방지). `===` 저장 형식은 이제 카드 편집기가
   * 감추므로 사용자 문서에 노출하지 않는다(내부 직렬화 세부). */
  it("documents keywords in the readme", () => {
    expect(plugin.readme).toContain("{today}");
    expect(plugin.readme).toContain("{cursor}");
    expect(plugin.readme).toContain("{today+7}"); // 날짜 연산 키워드 예시
  });
});

describe("template 표현식·동작", () => {
  // 2026-07-09(목) 14:30:05로 고정 — {today}/{weekday}/{week} 결정성.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 14, 30, 5));
  });
  afterEach(() => vi.useRealTimers());

  /** 가드: 키워드를 실제 값으로 치환하고 {cursor} 위치를 caret으로 넘긴다(모드=커서). */
  it("expands keywords and passes the {cursor} offset as caret", async () => {
    const state = await runTemplate({
      settings: {
        ...base,
        templates: "=== 회의 ===\n# {week}주차 ({today} {weekday})\n- {cursor}",
      },
      note: { path: "/v/2026 회의.md", content: "" },
    });
    state.buttons["template-insert"](); // 1개 → pickList 없이 바로 삽입
    await flush();
    expect(state.picks).toHaveLength(0);
    expect(state.inserts).toHaveLength(1);
    const arg = state.inserts[0];
    const expected = "# 28주차 (2026-07-09 목요일)\n- ";
    expect(arg.text).toBe(expected);
    expect(arg.mode).toBe("cursor");
    expect(arg.caret).toBe(expected.length); // {cursor}가 끝이라 caret=길이
  });

  /** 가드: 날짜 포맷·오프셋·요일 날짜 키워드. */
  it("supports date format, offset and weekday-of-week keywords", async () => {
    const state = await runTemplate({
      settings: {
        ...base,
        dateFormat: "dot",
        templates:
          "=== d ===\n{today} / {tomorrow} / {today+7} / {monday} / {weekday}",
      },
      note: { path: "/v/x.md", content: "" },
    });
    state.buttons["template-insert"]();
    await flush();
    // 2026-07-09(목) 기준: 내일=10, +7=16, 이번주 월요일=06(dot 포맷).
    expect(state.inserts[0].text).toBe(
      "2026.07.09 / 2026.07.10 / 2026.07.16 / 2026.07.06 / 목요일",
    );
  });

  /** 가드: 2개 이상이면 pickList로 고른 템플릿을 지정 모드로 삽입한다. */
  it("uses pickList and inserts the chosen template in append mode", async () => {
    const state = await runTemplate({
      settings: {
        ...base,
        insertMode: "append",
        templates: "=== A ===\naaa\n=== B ===\nbbb",
      },
      note: { path: "/v/x.md", content: "기존" },
      pick: "1", // B
    });
    state.buttons["template-insert"]();
    await flush();
    expect(state.picks).toHaveLength(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].text).toBe("bbb");
    expect(state.inserts[0].mode).toBe("append");
  });

  /** 가드: pickList 취소(null)면 삽입하지 않는다. */
  it("does nothing when the pick is cancelled", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "=== A ===\naaa\n=== B ===\nbbb" },
      note: { path: "/v/x.md", content: "" },
      pick: null,
    });
    state.buttons["template-insert"]();
    await flush();
    expect(state.inserts).toHaveLength(0);
  });

  /** 가드: 무헤더 블롭은 통째로 한 템플릿이 된다(문법 없이 "그냥 텍스트"). */
  it("treats a header-less blob as one template", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "그냥 텍스트\n둘째 줄" },
      note: { path: "/v/x.md", content: "" },
    });
    state.buttons["template-insert"]();
    await flush();
    expect(state.picks).toHaveLength(0);
    expect(state.inserts[0].text).toBe("그냥 텍스트\n둘째 줄");
  });

  /** 가드: 템플릿이 없으면 삽입 대신 안내 토스트만 뜬다. */
  it("shows a toast when there are no templates", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "" },
      note: { path: "/v/x.md", content: "" },
    });
    state.buttons["template-insert"]();
    await flush();
    expect(state.inserts).toHaveLength(0);
    expect(state.toasts.length).toBeGreaterThan(0);
  });

  /** 가드(저장): 현재 본문을 이름 붙여 템플릿 블롭 끝에 덧붙이고 로컬에 즉시 반영한다. */
  it("appends the current note as a named template on save", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "=== 기존 ===\nold" },
      note: { path: "/v/x.md", content: "# 새 템플릿\n- 항목" },
      promptValue: "새것",
    });
    state.buttons["template-save"]();
    await flush();
    expect(state.sets).toHaveLength(1);
    // 플러그인이 넘기는 것은 **항목 배열**이다(문자열 조립이 아니다).
    expect(state.sets[0]).toEqual({
      key: "templates",
      value: [
        { name: "기존", body: "old" },
        { name: "새것", body: "# 새 템플릿\n- 항목" },
      ],
    });
    // 디스크에 남는 것은 호스트가 직렬화한 블롭 — 형식은 그대로라 마이그레이션이 필요 없다.
    expect(state.store.templates).toBe(
      "=== 기존 ===\nold\n\n=== 새것 ===\n# 새 템플릿\n- 항목",
    );
    expect(state.toasts.some((t) => t.includes("새것"))).toBe(true);
  });

  /** 가드(저장): 빈 블롭이면 헤더만으로 시작하고, 이름의 '='는 제거해 헤더 충돌을 막는다. */
  it("starts fresh and strips '=' from the name", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "" },
      note: { path: "/v/x.md", content: "본문" },
      promptValue: "A=B",
    });
    state.buttons["template-save"]();
    await flush();
    // 이름의 `=` 제거는 이제 호스트가 한다 — 플러그인은 원문 이름을 그대로 넘긴다.
    expect(state.sets[0].value).toEqual([{ name: "A=B", body: "본문" }]);
    expect(state.store.templates).toBe("=== AB ===\n본문");
  });

  /** 가드(저장): 빈 본문·빈 이름·취소는 저장하지 않는다. */
  it("does not save on empty content, empty name, or cancel", async () => {
    const empty = await runTemplate({
      settings: { ...base, templates: "" },
      note: { path: "/v/x.md", content: "   \n \t" },
      promptValue: "이름",
    });
    empty.buttons["template-save"]();
    await flush();
    expect(empty.sets).toHaveLength(0);

    const cancelled = await runTemplate({
      settings: { ...base, templates: "" },
      note: { path: "/v/x.md", content: "본문" },
      promptValue: null,
    });
    cancelled.buttons["template-save"]();
    await flush();
    expect(cancelled.sets).toHaveLength(0);

    const blankName = await runTemplate({
      settings: { ...base, templates: "" },
      note: { path: "/v/x.md", content: "본문" },
      promptValue: "   ",
    });
    blankName.buttons["template-save"]();
    await flush();
    expect(blankName.sets).toHaveLength(0);
  });
});

/**
 * 기본 예시 세트 로케일화 — 사용자 확정 규칙: "저장된 사용자 값이 없으면 현재 로케일의 기본
 * 세트, 사용자가 한 번이라도 수정·저장했으면 영구 유지, 초기화(설정 창) = 저장값 삭제(→ 자동
 * 으로 현재 언어 기본 재생성)". 여기서는 main.js 쪽(로케일 폴백 계산 자체)만 증명한다 —
 * 설정 창의 되돌리기 버튼·표시는 settings.test.ts가 맡는다.
 */
describe("template 기본 예시 세트 로케일화", () => {
  // 2026-07-09(목) 14:30:05로 고정 — {today}/{week} 결정성(기존 describe와 같은 시각).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 14, 30, 5));
  });
  afterEach(() => vi.useRealTimers());

  /** 매니페스트 `templates.default`를 parseListBlob으로 편 것 — "저장값 없음"의 기준. */
  const manifestKoDefault = parseListBlob(
    String(SCHEMA.find((f) => f.key === "templates")?.default),
  );

  /** 가드(a): 저장값이 아예 없을 때(templates 키 자체가 없음) + en 로케일 → 영어 기본 세트. */
  it("저장값 없음 + en 로케일 → 영어 기본 세트가 쓰인다", async () => {
    const state = await runTemplate({
      settings: { ...base }, // templates 키 없음 → 매니페스트 기본(ko 3개)이 병합된다
      note: { path: "/v/x.md", content: "" },
      locale: "en",
      pick: "1", // 데일리/Daily note 위치
    });
    state.buttons["template-insert"]();
    await flush();
    expect(state.picks).toHaveLength(1);
    const items = state.picks[0] as { items: { id: string; label: string }[] };
    expect(items.items.map((i) => i.label)).toEqual(
      TEMPLATE_EN_DEFAULT_TEMPLATES.map((t) => t.name),
    );
    expect(state.inserts[0].text).toBe(
      "## 2026-07-09 daily note\n- To do today:",
    );
  });

  /** 가드: 저장값 없음 + ko(기본 로케일) → 매니페스트 default 그대로(변화 없음). */
  it("저장값 없음 + ko 로케일 → 매니페스트 기본값 그대로 쓰인다", async () => {
    const state = await runTemplate({
      settings: { ...base },
      note: { path: "/v/x.md", content: "" },
      pick: "1",
    });
    state.buttons["template-insert"]();
    await flush();
    const items = state.picks[0] as { items: { id: string; label: string }[] };
    expect(items.items.map((i) => i.label)).toEqual(
      manifestKoDefault.map((t) => t.name),
    );
  });

  /** 가드(b): 사용자가 실제로 저장한 값은 로케일을 바꿔도 그대로 유지된다. */
  it("사용자가 저장한 실제 값은 로케일을 바꿔도 그대로 유지된다", async () => {
    const state = await runTemplate({
      settings: { ...base, templates: "=== 나만의 템플릿 ===\n내 내용" },
      note: { path: "/v/x.md", content: "" },
      locale: "en",
    });
    state.buttons["template-insert"](); // 1개 → 바로 삽입(선택 팝업 없음)
    await flush();
    expect(state.picks).toHaveLength(0);
    expect(state.inserts[0].text).toBe("내 내용");
  });

  /**
   * 가드(c 대응): 다른 로케일에서 저장된 "그 로케일의 기본 세트"도 여전히 "손대지 않은 기본"
   * 으로 인식돼, 지금 로케일 것으로 다시 바뀐다(설정 창 되돌리기 뒤 로케일을 바꾸는 상황과
   * 같다 — settings.ts `localizeTemplateBlob`과 같은 규칙).
   */
  it("en 기본 세트가 저장된 채 ko로 보면 한국어 기본 세트로 다시 보인다", async () => {
    const enBlob = serializeListBlob(TEMPLATE_EN_DEFAULT_TEMPLATES);
    const state = await runTemplate({
      settings: { ...base, templates: enBlob },
      note: { path: "/v/x.md", content: "" },
      pick: "1", // ko 로케일 — 데일리
    });
    state.buttons["template-insert"]();
    await flush();
    const items = state.picks[0] as { items: { id: string; label: string }[] };
    expect(items.items.map((i) => i.label)).toEqual(
      TEMPLATE_KO_DEFAULT_TEMPLATES.map((t) => t.name),
    );
    expect(state.inserts[0].text).toBe(
      "## 2026-07-09 데일리 노트\n- 오늘 할 일:",
    );
  });

  /**
   * 드리프트 가드: 설정 창(settings.ts)이 따로 갖는 TEMPLATE_KO/EN_DEFAULT_TEMPLATES가 실제
   * main.js 실행 결과(이름·본문 모두)와 바이트 동일하다 — 두 파일이 서로 다른 실행 환경이라
   * 부득이 데이터를 나눠 가지므로, 한쪽만 고치고 다른 쪽을 잊으면 이 테스트가 잡는다.
   */
  it("settings.ts의 로케일 기본 세트가 main.js 실행 결과와 정확히 같다(드리프트 가드)", async () => {
    // ko: 매니페스트 default(=main.js KO_TEMPLATES) 대조.
    expect(manifestKoDefault).toEqual(TEMPLATE_KO_DEFAULT_TEMPLATES);

    // en: main.js를 실제로 돌려 pickList 이름 + 각 항목 삽입 본문을 뽑아 대조한다.
    const names = await runTemplate({
      settings: { ...base },
      note: { path: "/v/x.md", content: "" },
      locale: "en",
      pick: "0",
    });
    names.buttons["template-insert"]();
    await flush();
    const items = names.picks[0] as { items: { id: string; label: string }[] };
    expect(items.items.map((i) => i.label)).toEqual(
      TEMPLATE_EN_DEFAULT_TEMPLATES.map((t) => t.name),
    );

    for (let i = 0; i < TEMPLATE_EN_DEFAULT_TEMPLATES.length; i++) {
      const run = await runTemplate({
        settings: { ...base },
        note: { path: "/v/x.md", content: "" },
        locale: "en",
        pick: String(i),
      });
      run.buttons["template-insert"]();
      await flush();
      // {cursor}만 제거하고 나머지 키워드는 고정 시각으로 결정론적으로 치환된 실제 삽입 결과 —
      // 원본 body에서 {cursor}만 걷어낸 것과 같다(이 세 예시는 {cursor} 말고 다른 자리표시자
      // 앞뒤 텍스트가 없어 문자열 치환으로 기대값을 구성할 수 있다).
      const expected = TEMPLATE_EN_DEFAULT_TEMPLATES[i].body
        .split("{cursor}")
        .join("")
        .split("{today}")
        .join("2026-07-09")
        .split("{week}")
        .join("28");
      expect(run.inserts[0].text).toBe(expected);
    }
  });
});
