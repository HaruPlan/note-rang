/**
 * 재빌드 완료 방송의 판정기 가드 — "리로드해야 하는가, 제자리 조정으로 충분한가".
 *
 * 이 파일이 못박는 계약은 둘이다:
 * 1. **모르면 리로드** — 사유가 리로드 전용이거나, 판정 입력이 없거나, 화이트리스트 밖 표면이
 *    바뀌었으면 언제나 `reload`다. 이 방향의 실패는 깜빡임이지만, 반대 방향의 실패(조정으로
 *    새는 것)는 낡은 화면이 그대로 남는 **무음 실패**라 훨씬 나쁘다.
 * 2. 조정할 때는 **바뀐 것만** 단계에 담되, 이벤트 재배선은 언제나 담는다(재빌드는 모든
 *    샌드박스를 새 인스턴스로 갈아 끼우므로 발신기가 반드시 낡는다).
 */
import { describe, expect, it } from "vitest";
import {
  applyReconcileSteps,
  planHostUpdate,
  planLateSnapshot,
  type HostUpdatePlanInput,
  type ReconcileStep,
  type ReconcileTarget,
} from "./host-update-plan";
import type {
  HostSnapshot,
  PluginSnapshot,
  RebuildReason,
} from "../plugin/host-protocol";
import { LOCAL_APPLY_KEYS } from "./settings-diff";
import { defaultKeybindings } from "../shortcuts/actions";
import { SJ_D } from "../theme/theme";

/** 플러그인 슬라이스 헬퍼 — 필요한 표면만 덮어쓴다(나머지는 빈 등록). */
function slice(
  pluginId: string,
  over: Partial<PluginSnapshot> = {},
): PluginSnapshot {
  return {
    pluginId,
    grant: { declared: [], granted: [] },
    patterns: [],
    completions: [],
    embeds: [],
    buttons: [],
    ...over,
  };
}

/** 인라인 패턴 하나(내용은 상관없다 — 비교가 구조 동등이라 값만 다르면 된다). */
function pattern(className: string): PluginSnapshot["patterns"][number] {
  return {
    id: `p-${className}`,
    open: "**",
    close: "**",
    className,
    style: { color: "#f00" },
  };
}

/** 스냅샷 헬퍼(host-client.test.ts의 `snap`과 같은 최소 형태 + 필요한 전역 표면). */
function snap(
  plugins: PluginSnapshot[],
  over: Partial<HostSnapshot> = {},
): HostSnapshot {
  return {
    revision: 1,
    theme: SJ_D,
    background: null,
    font: null,
    windowControls: [],
    plugins,
    failures: [],
    ...over,
  };
}

const SETTINGS = {
  theme: "sj-d",
  theme_overrides: { "sj-d": { accent: "#111" } },
  keybindings: { "font.increase": "Alt+=" },
  toolbar_layout: undefined,
  language: "ko",
  defaults: { font_size: 14, font_family: "Serif" },
};

/** 기본 입력(변화 없음) — 각 테스트가 필요한 축만 갈아 끼운다. */
function input(over: Partial<HostUpdatePlanInput> = {}): HostUpdatePlanInput {
  const base = snap([slice("community", { patterns: [pattern("a")] })]);
  return {
    reasons: ["plugins"],
    prevSettings: SETTINGS,
    nextSettings: SETTINGS,
    prevSnapshot: base,
    nextSnapshot: base,
    prevVaultPath: "/vault",
    nextVaultPath: "/vault",
    ...over,
  };
}

describe("planHostUpdate — 리로드가 강제되는 경우", () => {
  /** 가드(핵심): 스냅샷·설정에 흔적이 남지 않는 변화는 사유만이 유일한 근거다. 언어팩
   * (`locale`)이 대표이고, vault·초기화·삭제·복원·미상도 같은 칸이다. */
  it("reloads for every reload-only reason", () => {
    const reasons: RebuildReason[] = [
      "locale",
      "vault",
      "reset",
      "wipe",
      "import",
      "unknown",
    ];
    for (const reason of reasons) {
      expect(planHostUpdate(input({ reasons: [reason] }))).toEqual({
        action: "reload",
        why: `reason:${reason}`,
      });
    }
  });

  /** 가드: 조정 가능한 사유에 리로드 전용 사유가 **하나라도** 섞이면 리로드다(합집합 발신). */
  it("reloads when a reload-only reason is mixed into the union", () => {
    const plan = planHostUpdate(
      input({ reasons: ["settings", "plugin-setting", "locale"] }),
    );
    expect(plan).toEqual({ action: "reload", why: "reason:locale" });
  });

  /** 가드: 사유가 아예 없는 방송(구버전 호스트)도 모른다는 뜻이다. */
  it("reloads when no reason is carried at all", () => {
    expect(planHostUpdate(input({ reasons: [] }))).toEqual({
      action: "reload",
      why: "reason:none",
    });
  });

  /** 가드: 판정 입력이 하나라도 없으면(설정·스냅샷 조회 실패, 마운트 때 스냅샷 미도착)
   * 무엇이 바뀌었는지 알 수 없다 → 리로드. */
  it("reloads when any comparison input is missing", () => {
    expect(planHostUpdate(input({ prevSettings: null })).action).toBe("reload");
    expect(planHostUpdate(input({ nextSettings: null }))).toEqual({
      action: "reload",
      why: "settings:unavailable",
    });
    expect(planHostUpdate(input({ prevSnapshot: null }))).toEqual({
      action: "reload",
      why: "snapshot:unavailable",
    });
    expect(planHostUpdate(input({ nextSnapshot: null })).action).toBe("reload");
  });

  /** 가드: vault 경로가 달라지면 첨부 URL의 기준이 통째로 낡는다(이미지가 깨진 채 남는다). */
  it("reloads when the vault path changed", () => {
    expect(planHostUpdate(input({ nextVaultPath: "/other" }))).toEqual({
      action: "reload",
      why: "vault:changed",
    });
  });

  /** 가드(핵심): 화이트리스트 밖 설정 키는 전부 리로드다 — 언어·툴바 배치·모르는 신규 키. */
  it("reloads for settings keys outside the reconcile whitelist", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ language: "en" }, "settings:language"],
      [
        { toolbar_layout: { seen: [], left: [], right: [] } },
        "settings:toolbar_layout",
      ],
      [
        { defaults: { font_size: 14, font_family: "Serif", line_height: 1.6 } },
        "settings:defaults.line_height",
      ],
    ];
    for (const [patch, why] of cases) {
      expect(
        planHostUpdate(input({ nextSettings: { ...SETTINGS, ...patch } })),
      ).toEqual({ action: "reload", why });
    }
  });

  /**
   * 가드(핵심): 조정 화이트리스트는 국소 반영 화이트리스트를 **포함**하되 같지는 않다.
   * `theme`이 국소 쪽에 새어 들어가면 `bootstrap/settings.ts`가 재빌드 방송을 건너뛰고,
   * 노트 창은 새 팔레트를 받을 길이 없어 옛 테마 위에 오버라이드만 얹은 채 남는다.
   */
  it("keeps theme and keybindings out of the local-apply whitelist", () => {
    expect(LOCAL_APPLY_KEYS).not.toContain("theme");
    expect(LOCAL_APPLY_KEYS).not.toContain("keybindings");
    // 반대 방향(포함 관계): 국소 반영이 되는 키는 재빌드 뒤에도 반드시 조정 가능해야 한다.
    const patches: Record<string, unknown>[] = [
      { theme_overrides: { "sj-d": { accent: "#999" } } },
      { defaults: { font_size: 22, font_family: "Serif" } },
      { defaults: { font_size: 14, font_family: "Mono" } },
      { toolbar_style: "mac" },
    ];
    expect(patches).toHaveLength(LOCAL_APPLY_KEYS.length);
    for (const patch of patches) {
      expect(
        planHostUpdate(input({ nextSettings: { ...SETTINGS, ...patch } }))
          .action,
      ).toBe("reconcile");
    }
  });

  /**
   * 가드: `builtin` 플래그가 뒤집히면 여전히 리로드다.
   *
   * 이 값은 컨텍스트 메뉴의 출처 필터를 통째로 뒤집고, 같은 플러그인 id가 번들↔사이드로드로
   * 갈아 끼워졌다는 것은 코드 자체가 바뀌었다는 뜻이다 — 보수적으로 무거운 경로로 간다.
   */
  it("reloads when a plugin's builtin flag flips", () => {
    const prev = snap([slice("community", { patterns: [pattern("a")] })]);
    const next = snap([
      slice("community", { patterns: [pattern("a")], builtin: true }),
    ]);
    expect(
      planHostUpdate(input({ prevSnapshot: prev, nextSnapshot: next })),
    ).toEqual({ action: "reload", why: "plugin-surface:community" });
  });

  /**
   * 가드(핵심, 이번 배치): 툴바 버튼·명령·메뉴 항목·상태 아이템이 바뀌면 **리로드가 아니라**
   * `toolbar_items` 단계다 — 노트 창이 키로 diff해 제자리에서 맞춘다.
   */
  it("plans a toolbar_items step (not a reload) when a plugin's toolbar surface changes", () => {
    const prev = snap([slice("community", { patterns: [pattern("a")] })]);
    const surfaces: Partial<PluginSnapshot>[] = [
      {
        buttons: [
          { id: "b", label: "B", position: "top-left", buttonId: "onClick$1" },
        ],
      },
      { commands: [{ id: "c", title: "C" }] },
      { menuItems: [{ id: "m", label: "M" }] },
      { statusItems: [{ id: "s", text: "0", position: "top-right" }] },
    ];
    for (const over of surfaces) {
      const next = snap([
        slice("community", { patterns: [pattern("a")], ...over }),
      ]);
      expect(
        planHostUpdate(input({ prevSnapshot: prev, nextSnapshot: next })),
      ).toEqual({
        action: "reconcile",
        steps: ["toolbar_items", "events"],
      });
    }
  });

  /**
   * 가드: 능력(배경·폰트·창 컨트롤)을 **누가** 등록했는지가 바뀌어도, 전역 병합 결과가 같으면
   * 아무 일도 없었던 것이다 — 창이 소비하는 값은 병합 결과 하나뿐이다. 예전엔 "등록 순서
   * 의존 병합의 입력이 달라졌다"는 이유로 여기서 리로드했지만, 그건 재적용 API가 없던 시절의
   * 안전장치였다.
   */
  it("ignores which plugin registered a capability when the merged result is the same", () => {
    const capabilities: Partial<PluginSnapshot>[] = [
      { background: { swatches: ["#ffffff"], autoTextContrast: true } },
      { font: { families: [{ label: "Serif", stack: "serif" }] } },
      { windowControls: ["transparency"] },
    ];
    for (const over of capabilities) {
      const prev = snap([slice("community", { patterns: [pattern("a")] })]);
      const next = snap([
        slice("community", { patterns: [pattern("a")], ...over }),
      ]);
      expect(
        planHostUpdate(input({ prevSnapshot: prev, nextSnapshot: next })),
      ).toEqual({ action: "reconcile", steps: ["events"] });
    }
  });

  /**
   * 가드(핵심, 이번 배치): 툴바 항목만 가진 플러그인이 통째로 들어오거나 빠져도 리로드가
   * 아니다 — `toolbar_items` 단계 하나로 따라간다(번들 「복제」·「AI 프롬프트 복사」를 켜고
   * 끄는 것이 정확히 이 모양이다).
   */
  it("plans a toolbar_items step when a plugin with toolbar items is added or removed", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const withButton = slice("buttons", {
      buttons: [{ id: "b", label: "B", position: "top-left", buttonId: "h" }],
    });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base]),
          nextSnapshot: snap([base, withButton]),
        }),
      ),
    ).toEqual({ action: "reconcile", steps: ["toolbar_items", "events"] });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base, withButton]),
          nextSnapshot: snap([base]),
        }),
      ),
    ).toEqual({ action: "reconcile", steps: ["toolbar_items", "events"] });
  });

  /**
   * 가드(핵심): **아무 표면도 등록하지 않은** 슬라이스의 추가·삭제도 리로드다.
   *
   * 그 모양의 대표가 설치 언어팩이다(코드도 디스크립터도 없이 사전만 선언한다) — 조정으로
   * 새면 화면이 옛 언어 그대로 남는 무음 실패가 된다. 사유(`locale`)로도 걸리지만 판정을
   * 두 겹으로 둔다.
   */
  it("reloads when an empty (descriptor-less) plugin appears or disappears", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const empty = slice("language-pack-xx");
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base]),
          nextSnapshot: snap([base, empty]),
        }),
      ),
    ).toEqual({ action: "reload", why: "plugin-added:language-pack-xx" });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base, empty]),
          nextSnapshot: snap([base]),
        }),
      ),
    ).toEqual({ action: "reload", why: "plugin-removed:language-pack-xx" });
  });
});

describe("planHostUpdate — 제자리 조정", () => {
  /** 가드(핵심): 아무것도 안 바뀐 재빌드는 이벤트 재배선만 한다(리로드하지 않는다). */
  it("only re-wires events when nothing observable changed", () => {
    expect(planHostUpdate(input())).toEqual({
      action: "reconcile",
      steps: ["events"],
    });
  });

  /** 가드: 커뮤니티 플러그인의 설정이 바뀌어 패턴이 달라지면 확장만 다시 만든다. */
  it("rebuilds extensions when a plugin's patterns changed", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["plugin-setting"],
        prevSnapshot: snap([slice("community", { patterns: [pattern("a")] })]),
        nextSnapshot: snap([slice("community", { patterns: [pattern("b")] })]),
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: ["extensions", "events"],
    });
  });

  /**
   * 가드: 플러그인 설정 변경은 스냅샷에 차이가 안 보여도 확장을 다시 만든다 — 확장이 설정을
   * 런타임에 읽는 형태면 비교로는 잡히지 않기 때문이다(재구성은 dispatch 한 번이라 싸다).
   */
  it("rebuilds extensions for a plugin-setting rebuild even without a visible diff", () => {
    expect(planHostUpdate(input({ reasons: ["plugin-setting"] }))).toEqual({
      action: "reconcile",
      steps: ["extensions", "events"],
    });
  });

  /** 가드: 임베드 게이트의 입력인 `grant`가 바뀌어도 확장을 다시 만든다. */
  it("rebuilds extensions when the grant changed", () => {
    const plan = planHostUpdate(
      input({
        prevSnapshot: snap([slice("community", { patterns: [pattern("a")] })]),
        nextSnapshot: snap([
          slice("community", {
            patterns: [pattern("a")],
            grant: { declared: ["embed:youtube.com"], granted: [] },
          }),
        ]),
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: ["extensions", "events"],
    });
  });

  /** 가드: 색 오버라이드만 바뀌면 그 재적용 + 이벤트 재배선뿐이다. */
  it("applies only theme overrides when that is the sole change", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: {
          ...SETTINGS,
          theme_overrides: { "sj-d": { accent: "#222" } },
        },
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: ["theme_overrides", "events"],
    });
  });

  /** 가드: 여러 표면이 함께 바뀌면 전부, **선언 순서대로** 담긴다. */
  it("keeps the declared step order for multiple settings changes", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: {
          ...SETTINGS,
          theme_overrides: { "sj-d": { accent: "#222" } },
          keybindings: { "font.increase": "Alt+Minus" },
          defaults: { font_size: 18, font_family: "Mono" },
        },
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: [
        "theme_overrides",
        "font_size",
        "font_family",
        "keymap",
        "events",
      ],
    });
  });

  /** 가드: 열린 창에 렌더 소비처가 없는 `toolbar_style`은 통과하되 단계는 만들지 않는다. */
  it("passes toolbar_style through without a step", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: { ...SETTINGS, toolbar_style: "mac" },
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["events"] });
  });

  /**
   * 가드(핵심): 활성 테마 팔레트가 바뀌어도 리로드하지 않는다 — 테마는 색 토큰뿐이고 소비처가
   * 전부 `var(--memo-*)` 참조라 CSS 변수만 다시 쓰면 따라온다.
   */
  it("applies a changed theme palette in place", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const plan = planHostUpdate(
      input({
        prevSnapshot: snap([base]),
        nextSnapshot: snap([base], {
          theme: { tokens: { ...SJ_D.tokens, accent: "#0000ff" } },
        }),
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["theme", "events"] });
  });

  /**
   * 가드(핵심): 테마 **선택**(설정 `theme`)이 바뀌면 팔레트가 우연히 같아도 `theme` 단계다 —
   * 그 테마에 딸린 색 오버라이드 엔트리가 통째로 바뀌기 때문이다.
   */
  it("applies a theme selection change even when the palette is identical", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: { ...SETTINGS, theme: "sj-l" },
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["theme", "events"] });
  });

  /**
   * 가드: 테마와 오버라이드가 함께 바뀌어도 단계는 `theme` 하나다 — 그 단계가 오버라이드까지
   * 같은 값으로 얹으므로 `theme_overrides`를 더하면 같은 일을 두 번 한다.
   */
  it("subsumes the theme_overrides step into the theme step", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: {
          ...SETTINGS,
          theme_overrides: { "sj-d": { accent: "#222" } },
        },
        prevSnapshot: snap([base]),
        nextSnapshot: snap([base], {
          theme: { tokens: { ...SJ_D.tokens, accent: "#0000ff" } },
        }),
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["theme", "events"] });
  });

  /** 가드: 저장된 글꼴만 바뀌면 폰트 단계 하나다(능력은 그대로). */
  it("applies a saved font family change in place", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: {
          ...SETTINGS,
          defaults: { font_size: 14, font_family: "Mono" },
        },
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: ["font_family", "events"],
    });
  });

  /** 가드: 폰트 **능력**(스냅샷)만 바뀌어도 같은 단계다 — 적용부가 능력·값을 함께 재해석한다. */
  it("applies a font capability change in place", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const plan = planHostUpdate(
      input({
        prevSnapshot: snap([base]),
        nextSnapshot: snap([base], {
          font: { families: [{ label: "Serif", stack: "serif" }] },
        }),
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: ["font_family", "events"],
    });
  });

  /**
   * 가드(핵심): 배경 능력(스와치·자동 대비)이 바뀌면 리로드가 아니라 `background` 단계다 —
   * 노트 배경색·대비·툴바의 배경색 항목을 창이 제자리에서 다시 그린다.
   */
  it("applies a background capability change in place", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const on = planHostUpdate(
      input({
        prevSnapshot: snap([base]),
        nextSnapshot: snap([base], {
          background: { swatches: ["#ffffff"], autoTextContrast: true },
        }),
      }),
    );
    expect(on).toEqual({
      action: "reconcile",
      steps: ["background", "events"],
    });
    // 팔레트만 갈린 경우(플러그인은 그대로)도 같은 단계다 — 스와치 목록이 곧 능력이다.
    const repaint = planHostUpdate(
      input({
        prevSnapshot: snap([base], {
          background: { swatches: ["#ffffff"], autoTextContrast: true },
        }),
        nextSnapshot: snap([base], {
          background: { swatches: ["#000000"], autoTextContrast: false },
        }),
      }),
    );
    expect(repaint).toEqual({
      action: "reconcile",
      steps: ["background", "events"],
    });
  });

  /**
   * 가드(핵심): 창 컨트롤 능력이 바뀌면 `window_controls` 단계다. 비교는 **집합**이라
   * 순서만 다른 목록은 아무 단계도 내지 않는다(병합 순서가 흔들려도 창이 깜빡이지 않는다).
   */
  it("applies a window control capability change in place, order-insensitively", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base]),
          nextSnapshot: snap([base], { windowControls: ["transparency"] }),
        }),
      ),
    ).toEqual({ action: "reconcile", steps: ["window_controls", "events"] });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base], {
            windowControls: ["transparency", "always-on-top"],
          }),
          nextSnapshot: snap([base], {
            windowControls: ["always-on-top", "transparency"],
          }),
        }),
      ),
    ).toEqual({ action: "reconcile", steps: ["events"] });
  });

  /**
   * 가드(핵심): **능력만 등록하는** 플러그인의 설치·삭제(=번들 「배경색」·「글꼴」·「투명도」를
   * 켜고 끄는 일)는 이제 리로드가 아니다 — 그 능력의 단계 하나로 따라간다. 확장 표면이 없으니
   * `extensions` 단계는 따라붙지 않는다(단계 목록이 곧 "무엇이 바뀌었는가"다).
   */
  it("reconciles a capability-only plugin coming or going", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const bgPlugin = slice("background", {
      builtin: true,
      background: { swatches: ["#ffffff"], autoTextContrast: true },
    });
    const bgOn = snap([base, bgPlugin], {
      background: { swatches: ["#ffffff"], autoTextContrast: true },
    });
    const bgOff = snap([base]);
    expect(
      planHostUpdate(input({ prevSnapshot: bgOff, nextSnapshot: bgOn })),
    ).toEqual({ action: "reconcile", steps: ["background", "events"] });
    expect(
      planHostUpdate(input({ prevSnapshot: bgOn, nextSnapshot: bgOff })),
    ).toEqual({ action: "reconcile", steps: ["background", "events"] });

    const pinPlugin = slice("always-on-top", {
      builtin: true,
      windowControls: ["always-on-top"],
    });
    const pinOn = snap([base, pinPlugin], {
      windowControls: ["always-on-top"],
    });
    expect(
      planHostUpdate(input({ prevSnapshot: bgOff, nextSnapshot: pinOn })),
    ).toEqual({ action: "reconcile", steps: ["window_controls", "events"] });

    const fontPlugin = slice("font", {
      builtin: true,
      font: { families: [{ label: "Serif", stack: "serif" }] },
    });
    const fontOn = snap([base, fontPlugin], {
      font: { families: [{ label: "Serif", stack: "serif" }] },
    });
    expect(
      planHostUpdate(input({ prevSnapshot: bgOff, nextSnapshot: fontOn })),
    ).toEqual({ action: "reconcile", steps: ["font_family", "events"] });
  });

  /**
   * 가드: 능력과 버튼을 **함께** 가진 플러그인이 들어와도 리로드가 아니다 — 두 표면 각각의
   * 단계가 선언 순서대로 담긴다(이 배치로 마지막 경계가 사라졌다).
   */
  it("plans both the capability and toolbar_items steps for a plugin that registers both", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const fat = slice("fat", {
      background: { swatches: ["#ffffff"], autoTextContrast: true },
      buttons: [{ id: "b", label: "B", position: "top-left", buttonId: "h" }],
    });
    expect(
      planHostUpdate(
        input({
          prevSnapshot: snap([base]),
          nextSnapshot: snap([base, fat], {
            background: { swatches: ["#ffffff"], autoTextContrast: true },
          }),
        }),
      ),
    ).toEqual({
      action: "reconcile",
      steps: ["background", "toolbar_items", "events"],
    });
  });

  /** 가드: 여러 표면이 한꺼번에 바뀌면 **선언 순서**대로 담긴다(같은 재빌드, 같은 결과). */
  it("keeps the declared step order when several surfaces change at once", () => {
    const base = slice("community", { patterns: [pattern("a")] });
    const plan = planHostUpdate(
      input({
        reasons: ["settings", "plugins"],
        nextSettings: {
          ...SETTINGS,
          defaults: { font_size: 20, font_family: "Mono" },
          keybindings: { "font.increase": "Alt+Minus" },
        },
        prevSnapshot: snap([base]),
        nextSnapshot: snap([base], {
          theme: { tokens: { ...SJ_D.tokens, accent: "#0000ff" } },
          background: { swatches: ["#ffffff"], autoTextContrast: true },
          font: { families: [{ label: "Serif", stack: "serif" }] },
          windowControls: ["transparency"],
        }),
      }),
    );
    expect(plan).toEqual({
      action: "reconcile",
      steps: [
        "theme",
        "background",
        "font_size",
        "font_family",
        "window_controls",
        "keymap",
        "events",
      ],
    });
  });

  /** 가드: 단축키가 바뀌면 키맵 단계로 맵만 갈아 끼운다(리로드 없음). */
  it("swaps the keymap in place when keybindings changed", () => {
    const plan = planHostUpdate(
      input({
        reasons: ["settings"],
        nextSettings: {
          ...SETTINGS,
          keybindings: { "font.increase": "Alt+Minus" },
        },
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["keymap", "events"] });
  });

  /**
   * 가드: 빌트인 유튜브 임베드가 켜지거나 꺼지면 컨텍스트 메뉴 항목만 제자리에서 켠다/끈다.
   * (이 슬라이스는 임베드 하나만 등록하므로 굳는 표면이 없어 조정 대상이다.)
   */
  it("toggles the youtube menu item when that builtin comes or goes", () => {
    const community = slice("community", { patterns: [pattern("a")] });
    const youtube = slice("youtube-embed", {
      builtin: true,
      embeds: [
        {
          id: "youtube",
          fence: "youtube",
          sources: [{ host: "youtu.be", pathPrefix: "/" }],
          embedTemplate: "https://e/{id}",
        },
      ],
    });
    const on = planHostUpdate(
      input({
        prevSnapshot: snap([community]),
        nextSnapshot: snap([community, youtube]),
      }),
    );
    expect(on).toEqual({
      action: "reconcile",
      steps: ["extensions", "youtubeEmbed", "events"],
    });
    const off = planHostUpdate(
      input({
        prevSnapshot: snap([community, youtube]),
        nextSnapshot: snap([community]),
      }),
    );
    expect(off).toEqual({
      action: "reconcile",
      steps: ["extensions", "youtubeEmbed", "events"],
    });
  });

  /**
   * 가드(핵심): 확장 표면(패턴 등)만 가진 플러그인이 통째로 들어오거나 빠지면 `extensions`
   * 단계 하나로 끝난다 — 툴바 항목도 능력도 없으므로 그 단계들이 따라붙지 않는다. 위 "빈
   * 껍데기가 들어오거나 빠지면 리로드"와 갈리는 정확한 경계값이다
   * (`sliceHasReconcilableSurfaces`=true, `sliceHasToolbarItemSurfaces`=false).
   */
  it("reconciles when a plugin with only reconcilable surfaces is added or removed", () => {
    const community = slice("community", { patterns: [pattern("a")] });
    const patternOnly = slice("pattern-only", { patterns: [pattern("b")] });
    const added = planHostUpdate(
      input({
        prevSnapshot: snap([community]),
        nextSnapshot: snap([community, patternOnly]),
      }),
    );
    expect(added).toEqual({
      action: "reconcile",
      steps: ["extensions", "events"],
    });
    const removed = planHostUpdate(
      input({
        prevSnapshot: snap([community, patternOnly]),
        nextSnapshot: snap([community]),
      }),
    );
    expect(removed).toEqual({
      action: "reconcile",
      steps: ["extensions", "events"],
    });
  });

  /** 가드: 구독 집합만 바뀐 재빌드도 조정이다 — 이벤트 단계가 발신기를 통째로 갈아 끼운다. */
  it("reconciles a subscription-only change through the events step", () => {
    const community = slice("community", { patterns: [pattern("a")] });
    const plan = planHostUpdate(
      input({
        prevSnapshot: snap([community]),
        nextSnapshot: snap([community], { subscribedEvents: ["note:opened"] }),
      }),
    );
    expect(plan).toEqual({ action: "reconcile", steps: ["events"] });
  });
});

/**
 * 지각 도착 스냅샷 교정 가드(`bootstrap/note.ts`의 `installPlugins` 콜백 전용) — 마운트가
 * `THEME_WAIT_MS` 상한을 넘겨 그린 낙관값(테마=SJ_D, 폰트=능력 없음)이 뒤늦게 온 실제 스냅샷과
 * 다르면 그 자리에서 교정해야 한다. `planHostUpdate`와 달리 리로드 분기가 없다(입력이
 * 스냅샷 하나뿐이라 "모르면 리로드"가 애초에 적용되지 않는다).
 */
/** planLateSnapshot 호출 기본값 — 각 테스트가 관심 있는 축만 덮어쓴다(나머지는 무변화). */
function lateInput(
  over: Partial<Parameters<typeof planLateSnapshot>[0]>,
): Parameters<typeof planLateSnapshot>[0] {
  return {
    mountedTheme: SJ_D,
    mountedBackground: null,
    mountedFont: null,
    mountedWindowControls: [],
    snapshot: snap([]),
    ...over,
  };
}

describe("planLateSnapshot", () => {
  /** 가드(핵심): 테마만 낙관값과 다르면 `theme` 단계 하나만 낸다. */
  it("corrects only the theme when just the palette differs", () => {
    const snapshot = snap([], {
      theme: { tokens: { ...SJ_D.tokens, accent: "#0000ff" } },
      font: null,
    });
    expect(planLateSnapshot(lateInput({ snapshot }))).toEqual(["theme"]);
  });

  /**
   * 가드(핵심): 배경만 낙관값(`early?.background ?? null`)과 다르면 `background` 단계
   * 하나만 낸다 — 마운트가 배경 플러그인 off로 봤는데(early 미도착) 뒤늦게 켜져 있던 실제
   * 스냅샷이 오는 경우다.
   */
  it("corrects only the background when just the capability differs", () => {
    const snapshot = snap([], {
      background: { swatches: ["#ffffff"], autoTextContrast: true },
    });
    expect(planLateSnapshot(lateInput({ snapshot }))).toEqual(["background"]);
  });

  /** 가드(핵심): 폰트만 낙관값과 다르면 `font_family` 단계 하나만 낸다. */
  it("corrects only the font when just the capability differs", () => {
    const snapshot = snap([], {
      theme: SJ_D,
      font: { families: [{ label: "Serif", stack: "serif" }] },
    });
    expect(planLateSnapshot(lateInput({ snapshot }))).toEqual(["font_family"]);
  });

  /**
   * 가드(핵심): 창 컨트롤은 **집합** 비교라 순서만 다른 목록은 무변화고, 원소 자체가
   * 다르면(마운트가 `early?.windowControls ?? []`로 봤는데 뒤늦게 온 스냅샷엔 컨트롤이
   * 있는 경우) `window_controls` 단계 하나만 낸다.
   */
  it("corrects window controls by set, ignoring order", () => {
    const reordered = snap([], { windowControls: ["always-on-top", "pin"] });
    expect(
      planLateSnapshot(
        lateInput({
          mountedWindowControls: ["pin", "always-on-top"],
          snapshot: reordered,
        }),
      ),
    ).toEqual([]);

    const changed = snap([], { windowControls: ["transparency"] });
    expect(planLateSnapshot(lateInput({ snapshot: changed }))).toEqual([
      "window_controls",
    ]);
  });

  /** 가드: 낙관값이 실제 스냅샷과 완전히 같으면(제때 도착한 경우) 교정할 것이 없다. */
  it("returns no steps when the optimistic mount already matched", () => {
    const font = { families: [{ label: "Serif", stack: "serif" }] };
    const snapshot = snap([], { theme: SJ_D, font });
    expect(
      planLateSnapshot(lateInput({ mountedFont: font, snapshot })),
    ).toEqual([]);
  });

  /** 가드: 여럿이 다르면 선언 순서(theme → background → font_family → window_controls) 그대로 낸다. */
  it("keeps declared order when multiple surfaces differ", () => {
    const snapshot = snap([], {
      theme: { tokens: { ...SJ_D.tokens, accent: "#0000ff" } },
      background: { swatches: ["#ffffff"], autoTextContrast: true },
      font: { families: [{ label: "Serif", stack: "serif" }] },
      windowControls: ["transparency"],
    });
    expect(planLateSnapshot(lateInput({ snapshot }))).toEqual([
      "theme",
      "background",
      "font_family",
      "window_controls",
    ]);
  });
});

/**
 * 단계 이름 → 재적용 API 배선 가드. 여기서 하나를 잘못 이으면 화면이 조용히 낡는다(무음
 * 실패) — 그래서 판정과 별개로 배선 자체를 DOM 없이 못박는다.
 */
describe("applyReconcileSteps", () => {
  /** 호출을 순서대로 기록하는 대상(노트 창 배선의 테스트 대역). */
  function spyTarget(): { calls: string[]; target: ReconcileTarget } {
    const calls: string[] = [];
    return {
      calls,
      target: {
        applyTheme: (t, o) =>
          calls.push(
            `theme:${JSON.stringify(t.tokens.accent)}+${JSON.stringify(o)}`,
          ),
        applyThemeOverrides: (o) =>
          calls.push(`overrides:${JSON.stringify(o)}`),
        applyBackgroundCapability: (b) =>
          calls.push(`bg:${b ? b.swatches.join("/") : "off"}`),
        applyBaseFontPx: (px) => calls.push(`font:${px}`),
        applyFontCapability: (f, saved) =>
          calls.push(`family:${f ? f.families.length : "off"}:${saved}`),
        applyWindowControls: (c) => calls.push(`controls:${c.join("/")}`),
        applyKeybindings: (b) => calls.push(`keys:${JSON.stringify(b)}`),
        applyExtensions: (s) => calls.push(`ext:${s.revision}`),
        reconcileToolbarItems: (s) => calls.push(`items:${s.revision}`),
        applyYoutubeEmbedEnabled: (on) => calls.push(`yt:${String(on)}`),
        rewireEvents: (s) => calls.push(`events:${s.revision}`),
      },
    };
  }

  /** 가드: 단계마다 정확히 그 API를 부르고, **준 순서대로** 부른다. */
  it("wires each step to its re-apply API in order", () => {
    const { calls, target } = spyTarget();
    const steps: ReconcileStep[] = [
      "theme",
      "theme_overrides",
      "background",
      "font_size",
      "font_family",
      "window_controls",
      "keymap",
      "extensions",
      "toolbar_items",
      "youtubeEmbed",
      "events",
    ];
    applyReconcileSteps(
      steps,
      {
        settings: {
          theme: "sj-d",
          theme_overrides: { "sj-d": { accent: "#222" } },
          keybindings: { "zoom-in": "Alt+Minus" },
          defaults: { font_size: 18, font_family: "Mono" },
        },
        snapshot: snap([slice("youtube-embed", { builtin: true })], {
          revision: 7,
          theme: { tokens: { accent: "#0000ff" } },
          background: { swatches: ["#fff"], autoTextContrast: true },
          font: { families: [{ label: "Serif", stack: "serif" }] },
          windowControls: ["transparency", "all-desktops"],
        }),
      },
      target,
    );
    expect(calls).toEqual([
      'theme:"#0000ff"+{"accent":"#222"}',
      'overrides:{"accent":"#222"}',
      "bg:#fff",
      "font:18",
      "family:1:Mono",
      "controls:transparency/all-desktops",
      'keys:{"zoom-in":"Alt+Minus"}',
      "ext:7",
      "items:7",
      "yt:true",
      "events:7",
    ]);
  });

  /**
   * 가드: 폰트 단계는 능력이 **없을 때도** 부른다 — 저장값을 무시하고 시스템 기본으로 되돌리는
   * 것이 이 단계의 일이다(플러그인을 끈 창에 옛 글꼴이 남지 않는다).
   */
  it("passes a null font capability through so the window falls back", () => {
    const { calls, target } = spyTarget();
    applyReconcileSteps(
      ["font_family"],
      {
        settings: { defaults: { font_family: "Mono" } },
        snapshot: snap([]),
      },
      target,
    );
    expect(calls).toEqual(["family:off:Mono"]);
  });

  /** 가드: 저장된 단축키가 아예 없으면(최초 상태) 기본 바인딩을 시드해 넘긴다 — 마운트와 같은 규칙. */
  it("seeds the default keybindings when none are saved", () => {
    const { calls, target } = spyTarget();
    applyReconcileSteps(
      ["keymap"],
      { settings: { defaults: {} }, snapshot: snap([]) },
      target,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`keys:${JSON.stringify(defaultKeybindings())}`);
  });

  /** 가드: 단계에 없는 것은 부르지 않는다(바뀌지 않은 표면을 건드리지 않는다). */
  it("touches nothing outside the given steps", () => {
    const { calls, target } = spyTarget();
    applyReconcileSteps(
      ["events"],
      { settings: SETTINGS, snapshot: snap([], { revision: 3 }) },
      target,
    );
    expect(calls).toEqual(["events:3"]);
  });

  /** 가드: 유튜브 단계는 **새 스냅샷의 실행 여부**를 그대로 넘긴다(꺼진 쪽도 확인). */
  it("passes the youtube plugin's running state from the fresh snapshot", () => {
    const { calls, target } = spyTarget();
    applyReconcileSteps(
      ["youtubeEmbed"],
      { settings: SETTINGS, snapshot: snap([]) },
      target,
    );
    expect(calls).toEqual(["yt:false"]);
  });
});
