import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { createEditor } from "./editor";
import {
  computeColorApply,
  computeColorRemove,
  computeLinkApply,
  computeLinkToggleOff,
  computeToggleWrap,
  computeToolbarPosition,
  hideSelectionToolbar,
  isCompositionStale,
  isSelectionDrivenScroll,
  parseLinkSelection,
  selectionAnchorCandidates,
  selectionToolbar,
  COMPOSITION_STALE_MS,
  SELECTION_COLOR_PALETTE,
  SELECTION_SHOW_DEBOUNCE_MS,
  shouldHandleSelectionMouseUp,
  shouldRetryAfterComposition,
  shouldShowSelectionToolbar,
} from "./selection-toolbar";
import { colorPatternSyntax } from "../plugin/editor-api";
import {
  SELECTION_ACTION_RENDER_LIMIT,
  setSelectionActions,
  type SelectionActionItem,
} from "../plugin/selection-action";
import { loadPluginFromDir } from "../plugin/test-host";
import { buildExtensionsFromSnapshot } from "../plugin/host-client";
import { BUILTIN_PLUGINS } from "../plugin/builtin";
import type { HostSnapshot, PluginSnapshot } from "../plugin/host-protocol";
import { SJ_D } from "../theme/theme";

/**
 * 테스트 전용 unwrap — `computeToggleWrap`은 감쌀 글자가 없으면(무변경) `null`을 돌려준다
 * ([`computeToggleWrap`]의 무변경 분기 참고). 그 분기 자체를 검증하는 테스트는 원본 함수를
 * 직접 쓰고 `null`을 기대하며, 그 외의 모든 테스트는 이 래퍼로 null 가능성을 걷어내
 * (실패 시 명확한 에러로) 기존처럼 `r.changes` 등을 바로 쓸 수 있게 한다.
 */
function toggleWrap(
  ...args: Parameters<typeof computeToggleWrap>
): NonNullable<ReturnType<typeof computeToggleWrap>> {
  const r = computeToggleWrap(...args);
  if (r === null) throw new Error("expected a WrapResult, got null");
  return r;
}

/** 테스트 전용 unwrap — [`toggleWrap`]과 같은 이유([`computeColorApply`]의 무변경 분기). */
function colorApply(
  ...args: Parameters<typeof computeColorApply>
): NonNullable<ReturnType<typeof computeColorApply>> {
  const r = computeColorApply(...args);
  if (r === null) throw new Error("expected a WrapResult, got null");
  return r;
}

describe("computeToggleWrap", () => {
  /** 가드: 마커가 없으면 감싼다 — md-shortcuts의 wrapRange와 같은 결과(공유 로직 회귀 방지). */
  it("wraps when no marker is present yet", () => {
    const r = toggleWrap("abc", 0, 3, "**", "**");
    expect(r.changes).toEqual({ from: 0, to: 3, insert: "**abc**" });
    expect(r.anchor).toBe(2);
    expect(r.head).toBe(5);
  });

  /** 가드: 선택 영역 자체가 마커를 통째로 물고 있으면(예: "**abc**" 전체 드래그) 안쪽만 남긴다. */
  it("strips markers when the selection itself carries them", () => {
    const doc = "x **abc** y";
    const from = doc.indexOf("**abc**");
    const to = from + "**abc**".length;
    const r = toggleWrap(doc, from, to, "**", "**");
    expect(r.changes).toEqual({ from, to, insert: "abc" });
    expect(r.anchor).toBe(from);
    expect(r.head).toBe(from + 3);
  });

  /** 가드: 선택 영역 바로 바깥에 마커가 있으면(안쪽만 드래그) 바깥 마커를 지운다. */
  it("strips surrounding markers when the selection sits just inside them", () => {
    const doc = "x **abc** y";
    const from = doc.indexOf("abc");
    const to = from + 3;
    const r = toggleWrap(doc, from, to, "**", "**");
    expect(r.changes).toEqual([
      { from: from - 2, to: from, insert: "" },
      { from: to, to: to + 2, insert: "" },
    ]);
    expect(r.anchor).toBe(from - 2);
    expect(r.head).toBe(from - 2 + 3);
  });

  /** 가드: 빈 선택도 마커만 삽입한다(커서가 마커 사이에 놓인다). */
  it("inserts markers around an empty selection", () => {
    const r = toggleWrap("hello", 5, 5, "*", "*");
    expect(r.changes).toEqual({ from: 5, to: 5, insert: "**" });
    expect(r.anchor).toBe(6);
    expect(r.head).toBe(6);
  });

  /** 가드: 문서 시작·끝 경계 밖으로 나가지 않는다(바깥 검사가 음수/문서 밖으로 안 나감). */
  it("does not read past document boundaries when checking outer markers", () => {
    const r = toggleWrap("abc", 0, 3, "**", "**");
    // "abc" 전체를 선택했지만 문서 안 어디에도 "**"가 없으므로 감싸는 결과가 나와야 한다.
    expect(r.changes).toEqual({ from: 0, to: 3, insert: "**abc**" });
  });

  /**
   * 회귀(#18) — 굵게(`**`)·기울임(`*`) 조합 표. 같은 문자를 반복해 서로 다른 길이를 만드는
   * 이 앱의 유일한 마커 쌍이라, 순진한 startsWith/endsWith만으로는 "**bold**"(연속 2개)가
   * 기울임 마커("*", 길이1)의 접두사와 우연히 일치해 굵게가 기울임으로 깨진다. 아래 표는
   * "선택 영역이 마커를 통째로 물고 있는" 케이스(첫 번째 분기)를 전부 고정한다.
   */
  describe("bold/italic marker confusion table (selection carries the marker)", () => {
    /** **bold**에 기울임: 기존 굵게 마커를 기울임으로 오인하면 안 된다 — 추가(wrap)로 폴백. */
    it("adding italic to a fully-bold selection wraps instead of corrupting the bold marker", () => {
      const r = toggleWrap("**bold**", 0, 8, "*", "*");
      expect(r.changes).toEqual({ from: 0, to: 8, insert: "***bold***" });
      expect(r.anchor).toBe(1);
      expect(r.head).toBe(9);
    });

    /** *italic*에 굵게: 기울임 마커를 건드리지 않고 굵게를 추가해야 한다. */
    it("adding bold to a fully-italic selection wraps around it", () => {
      const r = toggleWrap("*italic*", 0, 8, "**", "**");
      expect(r.changes).toEqual({ from: 0, to: 8, insert: "***italic***" });
      expect(r.anchor).toBe(2);
      expect(r.head).toBe(10);
    });

    /** ***both***에 굵게: 굵게만 벗기고 기울임(별표 1개)은 그대로 남아야 한다. */
    it("removing bold from a bold+italic selection leaves italic intact", () => {
      const r = toggleWrap("***both***", 0, 10, "**", "**");
      expect(r.changes).toEqual({ from: 0, to: 10, insert: "*both*" });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe(6);
    });

    /** ***both***에 기울임: 기울임만 벗기고 굵게(별표 2개)는 그대로 남아야 한다. */
    it("removing italic from a bold+italic selection leaves bold intact", () => {
      const r = toggleWrap("***both***", 0, 10, "*", "*");
      expect(r.changes).toEqual({ from: 0, to: 10, insert: "**both**" });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe(8);
    });

    /** 대조군: 별표를 공유하지 않는 마커(취소선)는 원래대로 정상 토글-오프된다. */
    it("strikethrough (non-overlapping marker) still toggles off normally", () => {
      const r = toggleWrap("~~strike~~", 0, 10, "~~", "~~");
      expect(r.changes).toEqual({ from: 0, to: 10, insert: "strike" });
    });

    /** 대조군: 인라인 코드(길이1, 별표와 무관)도 원래대로 정상 토글-오프된다. */
    it("inline code (non-overlapping marker) still toggles off normally", () => {
      const r = toggleWrap("`code`", 0, 6, "`", "`");
      expect(r.changes).toEqual({ from: 0, to: 6, insert: "code" });
    });

    /** 대조군: 형광펜(길이2, 별표와 무관)도 원래대로 정상 토글-오프된다. */
    it("highlight (non-overlapping marker) still toggles off normally", () => {
      const r = toggleWrap("==hl==", 0, 6, "==", "==");
      expect(r.changes).toEqual({ from: 0, to: 6, insert: "hl" });
    });
  });

  /** 같은 표를 "선택 영역 바로 바깥에 마커가 붙은" 케이스(두 번째 분기)에도 적용한다. */
  describe("bold/italic marker confusion table (marker sits just outside the selection)", () => {
    /** 회귀(#18): "**abc**"에서 안쪽만 선택해 기울임을 누르면 바깥 굵게 마커를 건드리면 안 된다. */
    it("does not strip an outer bold marker when italic is toggled on the inner text", () => {
      const doc = "x **abc** y";
      const from = doc.indexOf("abc");
      const to = from + 3;
      const r = toggleWrap(doc, from, to, "*", "*");
      // 바깥 "**"를 건드리지 않고 안쪽만 감싸는 wrapRange 폴백이어야 한다.
      expect(r.changes).toEqual({ from, to, insert: "*abc*" });
      expect(r.anchor).toBe(from + 1);
      expect(r.head).toBe(from + 4);
    });

    /** 조합: "***abc***"에서 안쪽만 선택해 굵게를 벗기면 기울임(별표 1개씩)만 바깥에 남는다. */
    it("removing an outer bold layer from a bold+italic wrap leaves the italic layer outside", () => {
      const doc = "x ***abc*** y";
      const from = doc.indexOf("abc");
      const to = from + 3;
      const r = toggleWrap(doc, from, to, "**", "**");
      expect(r.changes).toEqual([
        { from: from - 2, to: from, insert: "" },
        { from: to, to: to + 2, insert: "" },
      ]);
      expect(r.anchor).toBe(from - 2);
      expect(r.head).toBe(from - 2 + 3);
    });
  });

  // ── 다중 라인 ──────────────────────────────────────────────────────────
  // 인라인 마커는 줄을 넘어 매치되지 않으므로, 선택이 여러 줄에 걸치면 줄 조각별로 따로
  // 감싸거나 벗겨야 한다(md-shortcuts.ts의 wrapRange와 같은 규칙).
  /**
   * 단일 라인 선택도 줄 머리의 구조 문법(`- `·`# `·`> `·`- [ ] `)은 마커 밖에 남는다 —
   * 다중 라인·색 칠하기와 같은 규칙을 [`contentStart`](md-shortcuts.ts)로 공유한다. 회귀
   * 시나리오: 트리플 클릭으로 줄 전체를 선택한 뒤 서식 버튼을 누른다.
   */
  describe("single-line structural prefixes", () => {
    /** 가드(핵심): 트리플 클릭(줄 전체 선택) 뒤 굵게 → 불릿은 밖에, 내용만 감싸진다. */
    it("wraps a triple-click bullet line after the prefix", () => {
      const doc = "- 항목";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 2,
        to: doc.length,
        insert: "**항목**",
      });
      expect(applyEdit(doc, r)).toBe("- **항목**");
      expect(r.anchor).toBe(4);
      expect(r.head).toBe(6);
    });

    /** 가드(핵심): 위 결과를 다시 통째로 선택해 굵게를 누르면 정확히 원래 상태로 돌아온다. */
    it("re-toggling the wrapped bullet line restores the original text", () => {
      const doc = "- **항목**";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({ from: 2, to: doc.length, insert: "항목" });
      expect(applyEdit(doc, r)).toBe("- 항목");
      expect(r.anchor).toBe(2);
      expect(r.head).toBe(4);
    });

    /** 가드: 헤딩 줄도 같은 규칙 — `#`+공백은 마커 밖에 남는다(왕복 확인). */
    it("wraps and unwraps a triple-click heading line after the prefix", () => {
      const doc = "# 제목";
      const wrapped = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(applyEdit(doc, wrapped)).toBe("# **제목**");

      const doc2 = "# **제목**";
      const back = toggleWrap(doc2, 0, doc2.length, "**", "**");
      expect(applyEdit(doc2, back)).toBe("# 제목");
    });

    /** 가드: 인용 줄도 같은 규칙 — `> `는 마커 밖에 남는다(왕복 확인). */
    it("wraps and unwraps a triple-click quote line after the prefix", () => {
      const doc = "> 인용";
      const wrapped = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(applyEdit(doc, wrapped)).toBe("> **인용**");

      const doc2 = "> **인용**";
      const back = toggleWrap(doc2, 0, doc2.length, "**", "**");
      expect(applyEdit(doc2, back)).toBe("> 인용");
    });

    /** 가드: 태스크 줄도 같은 규칙 — `- [ ] `(체크박스까지 통째로)는 마커 밖에 남는다(왕복 확인). */
    it("wraps and unwraps a triple-click task line after the prefix", () => {
      const doc = "- [ ] 할 일";
      const wrapped = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(applyEdit(doc, wrapped)).toBe("- [ ] **할 일**");

      const doc2 = "- [ ] **할 일**";
      const back = toggleWrap(doc2, 0, doc2.length, "**", "**");
      expect(applyEdit(doc2, back)).toBe("- [ ] 할 일");
    });

    /** 가드: 선택이 접두 중간에서 시작해도(드래그가 불릿 글자 중간에서 출발) 접두 뒤부터 감싼다. */
    it("clamps to after the prefix when the drag starts inside it", () => {
      const doc = "- 항목";
      // "- 항목"의 인덱스 1(공백 자리)에서 시작 — 접두("- ", 길이 2) 중간.
      const r = toggleWrap(doc, 1, doc.length, "**", "**");
      expect(applyEdit(doc, r)).toBe("- **항목**");
    });

    /**
     * 가드(회귀): 선택이 접두 안에서만 놀면(예: 불릿만 드래그) 감쌀 글자가 없으므로
     * 무변경 — `null`을 돌려줘 호출부가 dispatch 자체를 생략하게 한다. 예전에는 "같은
     * 글자로 치환"하는 `{ from, to, insert: "- " }`를 돌려줬는데, CodeMirror는 삽입
     * 문자열을 원문과 비교하지 않으므로 그 트랜잭션도 `docChanged`가 되어 노트가
     * dirty로 표시되고 되돌리기 스텝이 쌓였다.
     */
    it("returns null when the selection sits entirely inside the prefix", () => {
      const doc = "- 항목";
      expect(computeToggleWrap(doc, 0, 2, "**", "**")).toBeNull();
    });

    /** 가드(무회귀): 구조 접두가 없는 평범한 한 줄은 이전과 똑같이 통짜로 감싼다. */
    it("still wraps a plain line with no structural prefix exactly as before", () => {
      const r = toggleWrap("항목", 0, 2, "**", "**");
      expect(r.changes).toEqual({ from: 0, to: 2, insert: "**항목**" });
      expect(r.anchor).toBe(2);
      expect(r.head).toBe(4);
    });

    /** 가드(무회귀): 다른 줄에 구조 접두가 있어도, 선택하지 않은 그 줄은 영향을 주지 않는다. */
    it("ignores a structural prefix on a different line", () => {
      const doc = "- 하나\n둘째줄";
      const from = doc.indexOf("둘째줄");
      const to = from + "둘째줄".length;
      const r = toggleWrap(doc, from, to, "**", "**");
      expect(r.changes).toEqual({ from, to, insert: "**둘째줄**" });
    });
  });

  describe("multi-line selections", () => {
    /** 가드(핵심): 아무 줄도 감싸져 있지 않으면(2줄) 각 줄을 따로 감싼다(md-shortcuts의
     * wrapRange와 같은 결과 — 공유 로직 회귀 방지). */
    it("wraps each line of a fresh two-line selection", () => {
      const doc = "line1\nline2";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "**line1**\n**line2**",
      });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("**line1**\n**line2**".length);
    });

    /** 가드: 3줄 중 빈 줄은 건너뛰고 비어있지 않은 줄만 감싼다. */
    it("wraps non-blank lines only in a three-line selection with a blank line", () => {
      const doc = "a\n\nb";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "**a**\n\n**b**",
      });
    });

    /** 가드(핵심): 비어있지 않은 줄 전부가 이미 마커를 통짜로 물고 있으면 전부 벗긴다. */
    it("strips the marker from every line when all lines already carry it", () => {
      const doc = "**line1**\n**line2**";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "line1\nline2",
      });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("line1\nline2".length);
    });

    /** 가드(핵심): 일부 줄만 감싸져 있으면(부분 상태) 감싸지지 않은 줄만 새로 감싸 "전부
     * 감싼 상태"로 통일한다 — 이미 감싸진 줄은 다시 감싸지 않는다(중첩 방지). */
    it("unifies a partially-wrapped selection to fully wrapped", () => {
      const doc = "**line1**\nline2";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "**line1**\n**line2**",
      });
    });

    /**
     * 가드(회귀): 빈 줄/공백뿐인 선택은 감쌀 조각이 하나도 없으므로 `null`(무변경) —
     * 마커만 남는 줄이 생기지 않을 뿐 아니라, dispatch 자체가 생략돼 노트가 dirty로
     * 표시되지 않는다.
     */
    it("returns null when the selection has no non-blank lines", () => {
      const doc = "   \n\t";
      expect(computeToggleWrap(doc, 0, doc.length, "**", "**")).toBeNull();
    });

    /**
     * 회귀(핵심): 라이브 프리뷰는 커서가 있는 줄만 마커를 원문으로 보여주고 나머지는 숨긴다
     * (live-preview.ts). 이미 굵게인 두 줄을 드래그로 선택하면, 선택은 연속 구간이라 중간을
     * 지나는 경계는 항상 마커까지 통째로 딸려 들어오지만, 그 선택의 첫 줄은 (숨은) 여는
     * 마커 **바로 뒤**에서 시작하고 마지막 줄은 (숨은) 닫는 마커 **바로 앞**에서 끝나는 게
     * 자연스럽다 — 즉 "**abc**\n**def**"를 안쪽 텍스트만 딱 맞춰 드래그하면 선택 범위는
     * "abc**\n**def"가 된다(양 끝 마커 한 겹씩만 선택 밖에 남는다). 이 모양을 통짜/양쪽
     * 바깥으로만 판정하면 두 줄 다 "마커 없음"으로 오판해 다시 감싸 `**abc****`처럼 깨진다 —
     * 선택 밖에 남은 마커까지 올바르게 찾아 벗겨야 한다(그 결과 변경 범위도 원래 마커
     * 전체를 덮도록 넓어진다).
     */
    it("strips markers whose one side sits outside the drag boundary on first/last lines", () => {
      const doc = "**abc**\n**def**";
      // "abc**\n**def" — 앞쪽 여는 "**"와 뒤쪽 닫는 "**"만 선택 밖에 남긴 드래그.
      const from = doc.indexOf("abc");
      const to = doc.lastIndexOf("def") + 3;
      expect(doc.slice(from, to)).toBe("abc**\n**def");

      const r = toggleWrap(doc, from, to, "**", "**");
      // 선택 밖에 남아 있던 마커까지 포함해 문서 전체가 원래 대상이 된다.
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "abc\ndef",
      });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("abc\ndef".length);
    });

    /**
     * 가드(핵심 회귀 — 색과 같은 규칙): 줄 머리의 구조 문법은 마커 **밖**에 남는다. 불릿까지
     * 감싸면(`**- 항목**`) 줄이 `*`로 시작해 목록이 문단이 된다 —
     * [`structuralPrefixLength`](md-shortcuts.ts)를 색 칠하기와 공유해 막는다.
     */
    it("keeps structural prefixes outside the markers", () => {
      const doc = "- 하나\n## 제목\n> 인용";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "- **하나**\n## **제목**\n> **인용**",
      });
    });

    /** 가드: 접두 뒤가 이미 감싸져 있으면 전부 벗긴다(감싸기 판정도 접두 뒤에서 한다). */
    it("strips markers that sit just after a structural prefix", () => {
      const doc = "- **하나**\n- **둘**";
      const r = toggleWrap(doc, 0, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "- 하나\n- 둘",
      });
    });

    /**
     * 가드(핵심 회귀 — 실사용 재현): 선택의 첫 줄이 줄 중간에서 시작하면, 그 자리가 우연히
     * 구조 마커 모양이어도(`- `) 접두로 오판해 마커 밖으로 밀려나면 안 된다.
     * "가격은 100원 - 200원"에서 "- 200원"부터 드래그한 경우 — 같은 선택을 한 줄만
     * 잡으면(`contentStart` 경로) 정상이므로 두 경로의 결과가 어긋나지 않아야 한다.
     */
    it("does not mistake a mid-line dash for a structural prefix on the first line of the selection", () => {
      const doc = "가격은 100원 - 200원\n배송비 별도";
      const from = doc.indexOf("- 200원");
      const r = toggleWrap(doc, from, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from,
        to: doc.length,
        insert: "**- 200원**\n**배송비 별도**",
      });
    });

    /** 가드: `>`도 같은 규칙이다 — 줄 중간의 `>`(비교 연산자 등)는 인용 마커가 아니다. */
    it("does not mistake a mid-line '>' for a quote marker on the first line of the selection", () => {
      const doc = "조건 > 0 이면\n참";
      const from = doc.indexOf("> 0");
      const r = toggleWrap(doc, from, doc.length, "**", "**");
      expect(r.changes).toEqual({
        from,
        to: doc.length,
        insert: "**> 0 이면**\n**참**",
      });
    });
  });
});

describe("parseLinkSelection", () => {
  /** 가드: 완전한 마크다운 링크에서 라벨·url을 뽑는다. */
  it("extracts label and url from a full markdown link", () => {
    expect(parseLinkSelection("[memo](https://example.com)")).toEqual({
      label: "memo",
      url: "https://example.com",
    });
  });

  /** 가드: 링크 모양이 아니면 null. */
  it("returns null for non-link text", () => {
    expect(parseLinkSelection("plain text")).toBeNull();
    expect(parseLinkSelection("[broken(url)")).toBeNull();
  });

  /** 회귀(#16): 라벨에 이스케이프된 `]`/`[`가 있어도 링크 텍스트가 조기 절단되지 않고 뽑힌다. */
  it("extracts an escaped label without truncating at the escaped bracket", () => {
    expect(parseLinkSelection("[a\\]b](https://example.com)")).toEqual({
      label: "a]b",
      url: "https://example.com",
    });
    expect(
      parseLinkSelection("[\\[TODO\\] item](https://example.com)"),
    ).toEqual({
      label: "[TODO] item",
      url: "https://example.com",
    });
  });
});

describe("computeLinkApply", () => {
  /** 가드: 일반 텍스트 선택을 링크로 바꾸고, 커서를 삽입된 링크 뒤로 collapse한다. */
  it("wraps plain selected text into a markdown link", () => {
    const doc = "check memo out";
    const from = doc.indexOf("memo");
    const to = from + 4;
    const r = computeLinkApply(doc, from, to, "https://example.com");
    const insert = "[memo](https://example.com)";
    expect(r.changes).toEqual({ from, to, insert });
    expect(r.anchor).toBe(from + insert.length);
    expect(r.head).toBe(from + insert.length);
  });

  /** 가드: 선택이 이미 링크면 라벨은 유지하고 url만 새로 바꾼다. */
  it("keeps the existing label when re-applying a link to an existing link", () => {
    const doc = "[memo](https://old.example)";
    const r = computeLinkApply(doc, 0, doc.length, "https://new.example");
    expect(r.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "[memo](https://new.example)",
    });
  });

  /** 회귀(#16): 선택 텍스트에 `]`가 섞이면 라벨을 이스케이프해 링크 구조가 깨지지 않는다. */
  it("escapes `]` in the selected text when turning it into a link label", () => {
    const doc = "note: a]b done";
    const from = doc.indexOf("a]b");
    const to = from + 3;
    const r = computeLinkApply(doc, from, to, "https://example.com");
    const insert = "[a\\]b](https://example.com)";
    expect(r.changes).toEqual({ from, to, insert });
    expect(r.anchor).toBe(from + insert.length);
  });

  /** 회귀(#16): 짝이 안 맞는 `)`가 섞인 URL은 꺾쇠로 감싸 목적지가 잘리지 않는다. */
  it("wraps an unbalanced-paren url in angle brackets", () => {
    const doc = "check memo out";
    const from = doc.indexOf("memo");
    const to = from + 4;
    const url = "https://example.com/Foo)bar";
    const r = computeLinkApply(doc, from, to, url);
    expect(r.changes).toEqual({
      from,
      to,
      insert: `[memo](<${url}>)`,
    });
  });

  /** 회귀(#16): 재적용 시 기존 라벨이 이스케이프된 상태였어도 원문 그대로 이어받는다. */
  it("round-trips an escaped label when re-applying a link", () => {
    const doc = "[a\\]b](https://old.example)";
    const r = computeLinkApply(doc, 0, doc.length, "https://new.example");
    expect(r.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "[a\\]b](https://new.example)",
    });
  });
});

describe("computeLinkToggleOff", () => {
  /** 가드: 완전한 링크 선택이면 라벨만 남기고 벗겨낸다. */
  it("unwraps a full link selection to its label", () => {
    const doc = "[memo](https://example.com)";
    const r = computeLinkToggleOff(doc, 0, doc.length);
    expect(r).toEqual({
      changes: { from: 0, to: doc.length, insert: "memo" },
      anchor: 0,
      head: 4,
    });
  });

  /** 가드: 링크가 아니면 null(호출부가 URL 입력 모드로 전환해야 한다는 신호). */
  it("returns null when the selection is not a full link", () => {
    expect(computeLinkToggleOff("plain text", 0, 10)).toBeNull();
  });

  /** 회귀(#16): 이스케이프된 라벨을 벗겨내면 원문(이스케이프 없는) 평문으로 돌아온다. */
  it("unwraps an escaped label back to plain text", () => {
    const doc = "[a\\]b](https://example.com)";
    const r = computeLinkToggleOff(doc, 0, doc.length);
    expect(r).toEqual({
      changes: { from: 0, to: doc.length, insert: "a]b" },
      anchor: 0,
      head: 3,
    });
  });
});

describe("shouldShowSelectionToolbar", () => {
  /** 가드: 비어 있지 않은 선택 + 비조합 상태면 뜬다. */
  it("shows for a non-empty, non-composing selection", () => {
    expect(
      shouldShowSelectionToolbar({ hasSelection: true, composing: false }),
    ).toBe(true);
  });

  /**
   * 가드(이번 변경의 정본): 선택을 **무엇으로 만들었는지는 묻지 않는다**. 예전에는
   * `fromMouse` 조건이 하나 더 있어 Shift+화살표·`Mod-A`로 고른 글자에는 서식 바가 영영
   * 뜨지 않았다 — 기술적 제약이 아니라 관례였고, 키보드만 쓰는 사용자에게는 이 기능이
   * 통째로 없는 것과 같았다. 판정에 남은 입력이 둘뿐임을 타입으로도 못박는다.
   */
  it("no longer asks how the selection was made", () => {
    const gesture: Parameters<typeof shouldShowSelectionToolbar>[0] = {
      hasSelection: true,
      composing: false,
    };
    expect(Object.keys(gesture).sort()).toEqual(["composing", "hasSelection"]);
    expect(shouldShowSelectionToolbar(gesture)).toBe(true);
  });

  /** 가드: 빈 선택(커서만)에는 뜨지 않는다. */
  it("does not show for an empty selection", () => {
    expect(
      shouldShowSelectionToolbar({ hasSelection: false, composing: false }),
    ).toBe(false);
  });

  /** 가드: IME 조합 중에는 뜨지 않는다. */
  it("does not show while composing", () => {
    expect(
      shouldShowSelectionToolbar({ hasSelection: true, composing: true }),
    ).toBe(false);
  });
});

describe("shouldRetryAfterComposition", () => {
  /** 가드(핵심): 조합**만**이 걸림돌인 제스처는 조합 종료 뒤 다시 봐야 한다. */
  it("retries a selection that was blocked only by composing", () => {
    expect(
      shouldRetryAfterComposition({ hasSelection: true, composing: true }),
    ).toBe(true);
  });

  /** 가드: 이미 뜬(=막히지 않은) 제스처는 다시 볼 것이 없다 — 중복 표시를 만들지 않는다. */
  it("does not retry a gesture that already passes", () => {
    expect(
      shouldRetryAfterComposition({ hasSelection: true, composing: false }),
    ).toBe(false);
  });

  /**
   * 가드: 조합이 아닌 이유로 막힌 것은 다시 봐도 답이 같다 — 빈 선택은 계속 비어 있다.
   * 그것까지 재판정하면 조합 종료가 "원래 뜨면 안 되는" 제스처를 뒤늦게 띄우는 새 결함이
   * 된다. (예전에는 "키보드 선택"도 이 목록에 있었지만, 이제는 조합 중 키보드 선택도
   * 마우스 선택과 똑같이 구제 대상이다 — 조합만 풀리면 뜰 자격이 있다.)
   */
  it("does not retry for an empty selection", () => {
    expect(
      shouldRetryAfterComposition({ hasSelection: false, composing: true }),
    ).toBe(false);
  });
});

describe("isSelectionDrivenScroll", () => {
  /**
   * 가드(핵심): 키보드 선택 표시가 예약된 채로 곧바로 오는 스크롤은 CM의 `scrollIntoView`
   * (선택이 스스로 끌고 간 스크롤)로 본다 — 그것까지 숨기면 화면 끝에서 Shift+↓로 선택을
   * 늘리는 내내 바가 깜빡인다.
   */
  it("treats a scroll during a pending keyboard show as selection-driven", () => {
    expect(isSelectionDrivenScroll(true, 1_000, 1_000 - 10)).toBe(true);
  });

  /** 가드: 예약이 없으면(=선택이 방금 움직인 적 없다) 스크롤은 예전처럼 전부 숨김 사유다. */
  it("does not claim a scroll when no keyboard show is pending", () => {
    expect(isSelectionDrivenScroll(false, 1_000, 1_000 - 10)).toBe(false);
  });

  /** 가드: 창을 벗어난 스크롤은 인과가 끊긴 것으로 본다(사용자가 굴린 휠). */
  it("does not claim a scroll once the window has passed", () => {
    expect(
      isSelectionDrivenScroll(true, 1_000, 1_000 - SELECTION_SHOW_DEBOUNCE_MS),
    ).toBe(false);
  });

  /** 가드: 선택 변경을 한 번도 못 본 상태(0)는 근거가 없다 — 숨김 쪽으로 기운다. */
  it("does not claim a scroll before any selection change was seen", () => {
    expect(isSelectionDrivenScroll(true, 1_000, 0)).toBe(false);
  });
});

describe("isCompositionStale", () => {
  /** 가드: 조합 활동이 이어지는 동안에는 `composing`을 그대로 믿는다(진짜 조합 중이다). */
  it("trusts composing while composition activity is recent", () => {
    expect(isCompositionStale(1_000, 1_000 - (COMPOSITION_STALE_MS - 1))).toBe(
      false,
    );
  });

  /** 가드(핵심): 경계만큼 활동이 끊기면 낡은 값으로 본다 — `compositionend` 유실 복구의 전부다. */
  it("treats composing as stale once activity stops for the window", () => {
    expect(isCompositionStale(1_000, 1_000 - COMPOSITION_STALE_MS)).toBe(true);
  });

  /**
   * 가드: 조합을 한 번도 못 봤는데(`0`) `composing`만 참인 상태는 그 자체로 믿을 수 없다 —
   * 그대로 두면 되돌릴 신호가 영영 오지 않아 모든 드래그가 삼켜진다.
   */
  it("treats composing as stale when no composition was ever observed", () => {
    expect(isCompositionStale(1_000, 0)).toBe(true);
  });
});

describe("shouldHandleSelectionMouseUp", () => {
  /** 가드: 좌클릭(button 0)만 통과시킨다. */
  it("accepts the left button", () => {
    expect(shouldHandleSelectionMouseUp(0)).toBe(true);
  });

  /**
   * 회귀(#17): 선택 영역 안에서 우클릭하면 mousedown→mouseup→contextmenu 순으로 이벤트가
   * 나는데, mouseup(button 2)이 재표시를 유발하면 뒤이은 contextmenu와 동시에 떠 겹쳐
   * 보인다. 우클릭·휠클릭 모두 거부해야 한다.
   */
  it("rejects the right button and the middle button", () => {
    expect(shouldHandleSelectionMouseUp(2)).toBe(false);
    expect(shouldHandleSelectionMouseUp(1)).toBe(false);
  });
});

describe("selectionAnchorCandidates", () => {
  /** 가드(핵심): 움직이는 끝(head)이 첫 후보다 — 눈이 따라가는 지점이자 화면에 붙들려 있는 쪽. */
  it("prefers the moving end, then the fixed end", () => {
    expect(
      selectionAnchorCandidates({ anchor: 10, head: 40 }, { from: 0, to: 100 }),
    ).toEqual([40, 10]);
    // 역방향 선택(뒤에서 앞으로 끌었다)에서도 기준은 여전히 head다.
    expect(
      selectionAnchorCandidates({ anchor: 40, head: 10 }, { from: 0, to: 100 }),
    ).toEqual([10, 40]);
  });

  /**
   * 가드(`Mod-A` 결함의 정본): 양끝이 렌더 범위 밖이면 범위 안으로 접어 넣은 위치까지
   * 후보에 넣는다 — 그러지 않으면 좌표를 주는 후보가 하나도 없어 바가 통째로 접힌다.
   */
  it("adds viewport-clamped fallbacks for a selection that runs past the rendered range", () => {
    expect(
      selectionAnchorCandidates(
        { anchor: 0, head: 9_000 },
        { from: 400, to: 900 },
      ),
    ).toEqual([9_000, 0, 900, 400]);
  });

  /** 가드: 이미 렌더 범위 안이면 접어 넣어도 같은 값이라 후보가 중복되지 않는다. */
  it("does not repeat a candidate that is already inside the rendered range", () => {
    expect(
      selectionAnchorCandidates({ anchor: 5, head: 8 }, { from: 0, to: 100 }),
    ).toEqual([8, 5]);
  });
});

describe("computeToolbarPosition", () => {
  const viewport = { width: 800, height: 600 };
  const barSize = { width: 120, height: 32 };

  /** 가드: 기본은 선택 영역 위, 가로는 선택 영역 중심에 맞춘다. */
  it("centers above the selection when there is room", () => {
    const pos = computeToolbarPosition(
      { left: 300, right: 340, top: 200, bottom: 220 },
      barSize,
      viewport,
    );
    expect(pos.top).toBe(200 - 32 - 6);
    expect(pos.left).toBe(320 - 60); // 중심(320) - 바 너비 절반(60)
  });

  /** 가드: 위쪽 여백이 모자라면 아래로 뒤집는다. */
  it("flips below the selection when there is no room above", () => {
    const pos = computeToolbarPosition(
      { left: 300, right: 340, top: 10, bottom: 30 },
      barSize,
      viewport,
    );
    expect(pos.top).toBe(30 + 6);
  });

  /** 가드: 왼쪽 가장자리를 넘지 않게 접어 넣는다. */
  it("clamps to the left edge", () => {
    const pos = computeToolbarPosition(
      { left: -10, right: 10, top: 200, bottom: 220 },
      barSize,
      viewport,
    );
    expect(pos.left).toBe(6);
  });

  /** 가드: 오른쪽 가장자리를 넘지 않게 접어 넣는다. */
  it("clamps to the right edge", () => {
    const pos = computeToolbarPosition(
      { left: 780, right: 820, top: 200, bottom: 220 },
      barSize,
      viewport,
    );
    expect(pos.left).toBe(viewport.width - barSize.width - 6);
  });
});

// ── 글자 색 ────────────────────────────────────────────────────────────────
//
// 문법(`{{`·`}}`·`|`)은 상수가 아니라 「글자 색」 플러그인 등록에서 온 값이다 — 아래 테스트도
// 그 사실을 흉내 내어 문법 객체를 인자로 넘긴다(앱에서는 colorPatternSyntax facet이 나른다).

/** 「글자 색」 번들이 실제로 등록하는 것과 같은 문법. */
const SYNTAX = { open: "{{", close: "}}", prefix: "|" } as const;

// 파싱·칠하기·직렬화(평탄 세그먼트 모델) 자체의 가드는 `color-segments.test.ts`에 있다 —
// 여기서는 **선택(문서 오프셋)이 그 모델에 어떻게 실려 들어가고 나오는가**만 본다.

describe("computeColorApply", () => {
  /** 가드(핵심): 평범한 선택은 고른 색으로 감싸고, 감싼 전체가 다시 선택된다. */
  it("wraps a fresh selection with the chosen color", () => {
    const r = colorApply("할일 끝", 0, 2, "#3a5", SYNTAX);
    expect(r.changes).toEqual({ from: 0, to: 2, insert: "{{할일|#3a5}}" });
    expect(r.anchor).toBe(0);
    expect(r.head).toBe("{{할일|#3a5}}".length);
  });

  /** 가드(핵심): 통짜 선택이면 안쪽 글자를 그대로 두고 색만 갈아 끼운다(중첩되지 않는다). */
  it("swaps the color of a whole-wrap selection instead of nesting", () => {
    const doc = "{{할일|#e33}}";
    const r = colorApply(doc, 0, doc.length, "#17c", SYNTAX);
    expect(r.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "{{할일|#17c}}",
    });
  });

  /** 가드(핵심): 안쪽 글자만 선택해도 색만 갈아 끼운다 — 선택 **밖**의 구분자까지 함께
   * 바꾼다(렌더된 줄에서는 이 경로가 사실상 유일한 사용 경로다). */
  it("swaps the color when only the inner text is selected", () => {
    const doc = "앞 {{할일|#e33}} 뒤";
    const from = doc.indexOf("할일");
    const r = colorApply(doc, from, from + 2, "#17c", SYNTAX);
    expect(r.changes).toEqual({
      from: from - 2,
      to: from + 2 + "|#e33}}".length,
      insert: "{{할일|#17c}}",
    });
  });

  /** 가드: 6자리 팔레트 값도 깎이지 않고 그대로 실린다. */
  it("keeps a 6-digit color verbatim", () => {
    const r = colorApply("x", 0, 1, "#334455", SYNTAX);
    expect(r.changes).toEqual({ from: 0, to: 1, insert: "{{x|#334455}}" });
  });

  // ── 기존 감싸기와 **부분만** 겹치는 선택 ─────────────────────────────────
  // 회귀(핵심 버그): 예전 계산은 "선택 하나 = 감싸기 하나"라 이런 선택에서
  // `{{앞{{뒤|#00f}}|#f00}}` 같은 중첩을 만들었다 — 호스트는 중첩을 매치하지 못하므로
  // 화면에 원문이 그대로 노출됐다. 지금은 감싸기를 쪼개 평탄하게 다시 쓴다.

  /** 가드(핵심): 칠해진 구간의 **가운데 일부**만 다른 색으로 바꾸면 셋으로 쪼개진다. */
  it("splits an existing wrap when only its middle is repainted", () => {
    const doc = "{{abcde|#f00}}";
    const from = doc.indexOf("bcd");
    const r = colorApply(doc, from, from + 3, "#00f", SYNTAX);
    expect(r.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "{{a|#f00}}{{bcd|#00f}}{{e|#f00}}",
    });
  });

  /** 가드(핵심): 감싸기 안에서 시작해 바깥 평문까지 이어지는 선택도 경계에서 쪼갠다. */
  it("splits at the wrap boundary when the selection crosses out of it", () => {
    const doc = "{{ab|#f00}}cd";
    const from = doc.indexOf("b");
    const to = doc.indexOf("c") + 1;
    const r = colorApply(doc, from, to, "#00f", SYNTAX);
    expect(r.changes).toEqual({
      from: 0,
      to,
      insert: "{{a|#f00}}{{bc|#00f}}",
    });
  });

  /** 가드: 여러 감싸기와 평문을 통째로 덮는 선택은 전부 새 색으로 **평탄화**된다
   * (같은 색이 이어지면 하나로 합쳐 `{{a|#3a5}}{{b|#3a5}}` 같은 잔해를 남기지 않는다). */
  it("flattens a selection that spans several wraps and plain text", () => {
    const doc = "{{a|#f00}} b {{c|#00f}}";
    const r = colorApply(doc, 0, doc.length, "#3a5", SYNTAX);
    expect(r.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "{{a b c|#3a5}}",
    });
  });

  /** 가드: 이미 그 색인 구간에 같은 색을 다시 적용해도 감싸기가 겹쳐 쌓이지 않는다. */
  it("does not stack a second wrap when the same color is reapplied", () => {
    const doc = "{{abc|#f00}}";
    const r = colorApply(doc, 2, 5, "#f00", SYNTAX);
    expect(r.changes).toEqual({ from: 0, to: doc.length, insert: doc });
  });

  // ── 다중 라인 ────────────────────────────────────────────────────────────
  // 색 감싸기(`{{...|#hex}}`)도 다른 인라인 마커처럼 줄을 넘어 매치되지 않으므로, 선택이
  // 여러 줄에 걸치면 줄 조각별로 따로 적용해야 한다.
  describe("multi-line selections", () => {
    /** 가드(핵심): 색이 없는 2줄 선택은 각 줄을 따로 감싼다. */
    it("wraps each line of a fresh two-line selection", () => {
      const doc = "a\nb";
      const r = colorApply(doc, 0, doc.length, "#3a5", SYNTAX);
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "{{a|#3a5}}\n{{b|#3a5}}",
      });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("{{a|#3a5}}\n{{b|#3a5}}".length);
    });

    /**
     * 가드(회귀 — computeToggleWrap의 무변경 분기와 같은 이유): 칠할 non-blank 줄이 하나도
     * 없으면(빈 줄·공백만 있는 여러 줄) `null` — dispatch 자체를 생략한다. 예전에는
     * `colorEditTargets`가 빈 대상 목록을 냈고, `spliceTargets`가 그걸로 "같은 글자로
     * 치환"하는 트랜잭션(`{ from, to, insert: doc }`)을 돌려줘 노트가 dirty로 표시됐다.
     */
    it("returns null when the multi-line selection has no non-blank lines", () => {
      const doc = "   \n\t";
      expect(computeColorApply(doc, 0, doc.length, "#3a5", SYNTAX)).toBeNull();
    });

    /** 가드(핵심): 이미 색이 있는 두 줄을 통짜로 선택하면 안쪽 글자는 그대로 두고 줄마다
     * 색만 갈아 끼운다(중첩되지 않는다). */
    it("swaps the color of every already-colored line instead of nesting", () => {
      const doc = "{{a|#e33}}\n{{b|#17c}}";
      const r = colorApply(doc, 0, doc.length, "#000", SYNTAX);
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "{{a|#000}}\n{{b|#000}}",
      });
    });

    /**
     * 회귀(핵심): computeToggleWrap의 마커 다중 라인 회귀와 같은 이유 — 색이 칠해진 줄에서는
     * `{{`·`|#hex}}`가 화면에서 숨겨져(라이브 프리뷰) 드래그가 그 경계 바로 바깥에서
     * 자연히 멎는다. 여는 `{{`가 선택 밖(첫 줄)에, 닫는 꼬리(`|#hex}}`)가 선택 밖(마지막
     * 줄)에 남는 드래그에서도 두 줄 다 올바르게 "색이 있다"로 인식해 색만 갈아 끼워야
     * 한다 — 그러지 않으면 `|#e33}}` 같은 잔해가 화면에 그대로 끼어든다.
     */
    it("recognizes color spans whose delimiters sit outside the drag boundary on first/last lines", () => {
      const doc = "{{abc|#e33}}\n{{def|#17c}}";
      // "abc|#e33}}\n{{def" — 앞쪽 여는 "{{"와 뒤쪽 꼬리("|#17c}}")만 선택 밖에 남긴 드래그.
      const from = doc.indexOf("abc");
      const to = doc.indexOf("{{def") + "{{def".length;
      expect(doc.slice(from, to)).toBe("abc|#e33}}\n{{def");

      const r = colorApply(doc, from, to, "#000", SYNTAX);
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "{{abc|#000}}\n{{def|#000}}",
      });
      expect(r.anchor).toBe(0);
      expect(r.head).toBe("{{abc|#000}}\n{{def|#000}}".length);
    });

    /**
     * 회귀(사용자가 신고한 버그 그 자체): 한 줄 전체가 빨강인 상태에서 **그 줄 중간부터
     * 다음 줄까지** 드래그해 파랑을 적용한 경우. 예전에는 첫 줄이 `{{앞{{뒤|#00f}}|#f00}}`
     * 류의 중첩이 되어 렌더되지 않고 원문이 그대로 보였다. 지금은 첫 줄이 앞(빨강)/뒤(파랑)
     * 두 감싸기로 **쪼개지고**, 다음 줄은 통째로 파랑이 된다.
     */
    it("splits the first line instead of nesting when the drag starts mid-wrap", () => {
      const doc = "{{abcd|#f00}}\nxyz";
      const from = doc.indexOf("cd");
      const r = colorApply(doc, from, doc.length, "#00f", SYNTAX);
      expect(r.changes).toEqual({
        from: 0,
        to: doc.length,
        insert: "{{ab|#f00}}{{cd|#00f}}\n{{xyz|#00f}}",
      });
      // 중첩이 남지 않는다(= 호스트가 매치할 수 있는 평탄한 감싸기만 있다).
      expect((r.changes as { insert: string }).insert).not.toContain("{{{{");
    });

    /**
     * 가드(핵심 회귀 — computeToggleWrap의 다중 라인 회귀와 같은 원인): 선택의 첫 줄이 줄
     * 중간에서 시작하면, 그 자리가 우연히 구조 마커 모양이어도(`- `) 색칠 대상에서 빠지면
     * 안 된다. "가격은 100원 - 200원"에서 "- 200원"부터 드래그한 경우.
     */
    it("does not mistake a mid-line dash for a structural prefix on the first line of the selection", () => {
      const doc = "가격은 100원 - 200원\n배송비 별도";
      const from = doc.indexOf("- 200원");
      const r = colorApply(doc, from, doc.length, "#e33", SYNTAX);
      expect(r.changes).toEqual({
        from,
        to: doc.length,
        insert: "{{- 200원|#e33}}\n{{배송비 별도|#e33}}",
      });
    });
  });
});

describe("computeColorRemove", () => {
  /** 가드(핵심): 통짜 선택·안쪽만 선택 둘 다 감싸기를 벗겨 평문만 남긴다. */
  it("strips the wrap from both whole and inner selections", () => {
    const whole = "{{할일|#e33}}";
    expect(computeColorRemove(whole, 0, whole.length, SYNTAX)).toEqual({
      changes: { from: 0, to: whole.length, insert: "할일" },
      anchor: 0,
      head: 2,
    });
    expect(computeColorRemove(whole, 2, 4, SYNTAX)).toEqual({
      changes: { from: 0, to: whole.length, insert: "할일" },
      anchor: 0,
      head: 2,
    });
  });

  /** 가드: 색이 없는 선택은 null — 호출부가 아무것도 되쓰지 않는다(지울 게 없다). */
  it("returns null when there is no color to remove", () => {
    expect(computeColorRemove("할일", 0, 2, SYNTAX)).toBeNull();
  });

  /** 가드(핵심): 감싸기의 **일부만** 선택해 해제하면 그 부분만 평문이 되고 나머지는 원래
   * 색으로 남는다(적용과 같은 쪼개기 규칙 — 여기서도 중첩은 생기지 않는다). */
  it("strips only the selected part and keeps the rest colored", () => {
    const doc = "{{abc|#f00}}";
    const from = doc.indexOf("b");
    expect(computeColorRemove(doc, from, from + 1, SYNTAX)?.changes).toEqual({
      from: 0,
      to: doc.length,
      insert: "{{a|#f00}}b{{c|#f00}}",
    });
  });

  // ── 다중 라인 ────────────────────────────────────────────────────────────
  describe("multi-line selections", () => {
    /** 가드(핵심): 색이 있는 줄만 벗기고 색이 없는 줄은 그대로 둔다(줄마다 독립 판정). */
    it("strips color only from lines that have it, leaving plain lines untouched", () => {
      const doc = "{{a|#e33}}\nb";
      const r = computeColorRemove(doc, 0, doc.length, SYNTAX);
      expect(r).toEqual({
        changes: { from: 0, to: doc.length, insert: "a\nb" },
        anchor: 0,
        head: "a\nb".length,
      });
    });

    /** 가드: 벗길 색이 있는 줄이 하나도 없으면 단일 라인과 마찬가지로 null. */
    it("returns null when no line in the selection has a color", () => {
      const doc = "a\nb";
      expect(computeColorRemove(doc, 0, doc.length, SYNTAX)).toBeNull();
    });
  });
});

/**
 * 실사용 신고 픽스처 — "여러 줄을 드래그해 색을 칠했더니 문서가 깨졌다".
 *
 * 원문은 새 노트의 안내 문구 그대로(불릿 목록 + 인라인 코드 + 위키링크가 섞여 있다). 예전
 * 계산은 **줄 전체**를 조각으로 삼아 `{{- 항목|#3a5}}`처럼 불릿까지 감싸기 안에 넣었고, 그러면
 * 줄이 `{{`로 시작하므로 마크다운이 그 줄을 목록으로 보지 않는다(신고자가 본 "렌더가 깨졌다").
 */
const SAMPLE = [
  "- 노트 위쪽에 마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타나.",
  "- `**굵게**`, `# 제목`, `- [ ] 할 일`처럼 마크다운으로 자유롭게 꾸며봐.",
  "- 다른 노트와 이어 쓰고 싶다면 [[노트 제목]]을 적어줘. 누르면 바로 열어줄게.",
  "- 트레이 아이콘이나 Ctrl+Shift+N을 누르면 언제든 새  노트를 만날 수 있어.",
].join("\n");

/** 신고에 붙어 있던 **깨진 결과** 그대로 — 2~4줄의 불릿이 감싸기 안에 들어가 있다. */
const SAMPLE_BROKEN = [
  "- {{노트 위쪽에 마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타|#93b}}나.",
  "{{- `**굵게**`, `# 제목`, `- [ ] 할 일`처럼 |#850}}{{마|#93b}}{{크다운으로 자유롭게 꾸며봐.|#3a5}}",
  "{{- 다른 노트와 이어 쓰고 싶다면 [[노트 제목]]을 적어줘. 누르면 바로 열어줄게.|#3a5}}",
  "{{- 트레이 아이콘이나 Ctrl+Shift+N을 누르면 언제든 새  노트를 만날 수|#3a5}}{{ 있어.|#17c}}",
].join("\n");

/** 툴바가 낸 단일 변경을 문서에 반영한다(결과 원문을 눈으로 읽기 위한 테스트 도우미). */
function applyEdit(doc: string, result: { changes: unknown }): string {
  const c = result.changes as { from: number; to: number; insert: string };
  return doc.slice(0, c.from) + c.insert + doc.slice(c.to);
}

describe("사용자 샘플 — 여러 줄 색 칠하기", () => {
  /**
   * 가드(핵심 회귀): 4줄을 통째로 드래그해 색을 칠하면 **모든 줄의 불릿이 감싸기 밖**에
   * 남는다. 신고된 문서에서는 2~4줄이 `{{- …`로 시작해 목록이 무너져 있었다.
   */
  it("keeps every bullet outside the wrap when the whole list is painted", () => {
    const next = applyEdit(
      SAMPLE,
      colorApply(SAMPLE, 0, SAMPLE.length, "#93b", SYNTAX),
    );
    expect(next).toBe(
      [
        "- {{노트 위쪽에 마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타나.|#93b}}",
        "- {{`**굵게**`, `# 제목`, `- [ ] 할 일`처럼 마크다운으로 자유롭게 꾸며봐.|#93b}}",
        "- {{다른 노트와 이어 쓰고 싶다면 [[노트 제목]]을 적어줘. 누르면 바로 열어줄게.|#93b}}",
        "- {{트레이 아이콘이나 Ctrl+Shift+N을 누르면 언제든 새  노트를 만날 수 있어.|#93b}}",
      ].join("\n"),
    );
    // 어느 줄도 감싸기로 시작하지 않는다(= 마크다운이 네 줄 모두 목록으로 읽는다).
    for (const line of next.split("\n"))
      expect(line.startsWith("- ")).toBe(true);
  });

  /**
   * 가드: 신고와 같은 드래그 모양 — 첫 줄은 **글자 중간**에서 시작한다. 그 줄만 드래그한
   * 자리부터 칠해지고(1번째 줄이 원래 정상이었던 이유), 나머지 줄은 접두 뒤부터 칠해진다.
   */
  it("paints from the drag point on the first line and after the prefix on the rest", () => {
    const from = SAMPLE.indexOf("마우스");
    const next = applyEdit(
      SAMPLE,
      colorApply(SAMPLE, from, SAMPLE.length, "#3a5", SYNTAX),
    );
    const lines = next.split("\n");
    expect(lines[0]).toBe(
      "- 노트 위쪽에 {{마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타나.|#3a5}}",
    );
    for (const line of lines.slice(1))
      expect(line.startsWith("- {{")).toBe(true);
  });

  /**
   * 가드(복원력): 이미 깨진 문서에서 색을 해제하면 **원문이 정확히 돌아온다** — 파서는 감싸기가
   * 줄 어디에 있든(불릿을 물고 있어도) 벗겨내므로, 접두를 삼킨 기존 데이터도 되살릴 수 있다.
   */
  it("restores the original text when the broken document is cleared", () => {
    const r = computeColorRemove(
      SAMPLE_BROKEN,
      0,
      SAMPLE_BROKEN.length,
      SYNTAX,
    );
    expect(r).not.toBeNull();
    expect(applyEdit(SAMPLE_BROKEN, r!)).toBe(SAMPLE);
  });

  /**
   * 가드(정규화): 깨진 문서를 **다시 칠하기만 해도** 접두가 밖으로 나온다 — 쓰던 사람이
   * 색을 바꾸는 것만으로 목록 구조가 복구된다(따로 고쳐 주는 마이그레이션이 필요 없다).
   */
  it("pulls swallowed bullets back out when the broken document is repainted", () => {
    const next = applyEdit(
      SAMPLE_BROKEN,
      colorApply(SAMPLE_BROKEN, 0, SAMPLE_BROKEN.length, "#000", SYNTAX),
    );
    expect(next).toBe(
      [
        "- {{노트 위쪽에 마우스를 올리면 프리뷰·핀·투명도·배경 같은 도구가 나타나.|#000}}",
        "- {{`**굵게**`, `# 제목`, `- [ ] 할 일`처럼 마크다운으로 자유롭게 꾸며봐.|#000}}",
        "- {{다른 노트와 이어 쓰고 싶다면 [[노트 제목]]을 적어줘. 누르면 바로 열어줄게.|#000}}",
        "- {{트레이 아이콘이나 Ctrl+Shift+N을 누르면 언제든 새  노트를 만날 수 있어.|#000}}",
      ].join("\n"),
    );
    expect(next).not.toContain("{{-");
  });
});

describe("SELECTION_COLOR_PALETTE", () => {
  /** 가드: 9색이고 전부 호스트 hex 형식(3·6자리)이다 — 「글자 색」 번들이 예전에 설정
   * 기본값으로 싣던 것과 같은 색이라, 쓰던 사람이 색이 바뀌었다고 느끼지 않는다. */
  it("carries the nine hand-picked colors in host hex format", () => {
    expect(SELECTION_COLOR_PALETTE).toHaveLength(9);
    for (const c of SELECTION_COLOR_PALETTE) {
      expect(c, c).toMatch(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    }
    // 대비 양 끝(검정·흰색)이 있어야 라이트·다크 모두에서 쓸 색이 있다.
    expect(SELECTION_COLOR_PALETTE).toContain("#000");
    expect(SELECTION_COLOR_PALETTE).toContain("#fff");
  });
});

describe("선택 툴바 색 모드(DOM)", () => {
  // jsdom에는 레이아웃이 없어 `Range.getClientRects`가 없다 — CodeMirror의 `coordsAtPos`가
  // 그걸 부르므로 바 위치 계산(reposition)이 좌표를 못 얻고 바를 숨겨 버린다(없으면 아예
  // 던진다). 위치 계산 자체는 순수 함수(`computeToolbarPosition`)로 이미 따로 검증하므로,
  // 여기서는 "글자가 어딘가에 있다"는 최소 대역만 깔고 **모드 전환·되쓰기**에 집중한다.
  const oneRect = (): DOMRect[] => [new DOMRect(0, 0, 10, 16)];
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: oneRect,
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 10, 16),
    });
  });

  const views: EditorView[] = [];
  afterEach(() => {
    while (views.length > 0) views.pop()!.destroy();
    document.body.innerHTML = "";
  });

  /** 색 문법 facet을 주거나(활성) 주지 않은(비활성) 툴바를 띄우고, 바 DOM을 돌려준다. */
  const mountBar = (
    doc: string,
    withColor: boolean,
  ): { view: EditorView; bar: HTMLElement } => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          selectionToolbar(),
          withColor ? colorPatternSyntax.of(SYNTAX) : [],
        ],
      }),
    });
    views.push(view);
    // 바는 에디터가 아니라 `#app`(없으면 body)에 붙는다 — 한 테스트에서 둘을 띄우면 둘 다
    // body에 쌓이므로 **가장 최근 것**을 집는다.
    const bars = [
      ...document.querySelectorAll<HTMLElement>(".selection-toolbar"),
    ];
    return { view, bar: bars[bars.length - 1] };
  };

  /** 드래그 선택을 흉내 낸다: 에디터 mousedown → 선택 설정 → window mouseup(좌클릭). */
  const dragSelect = async (
    view: EditorView,
    from: number,
    to: number,
  ): Promise<void> => {
    view.dom.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    view.dispatch({ selection: { anchor: from, head: to } });
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    await Promise.resolve(); // maybeShow는 queueMicrotask로 미뤄진다.
  };

  const colorBtn = (bar: HTMLElement): HTMLButtonElement =>
    bar.querySelector<HTMLButtonElement>(".selection-toolbar-color-btn")!;
  const linkBtn = (bar: HTMLElement): HTMLButtonElement =>
    bar.querySelector<HTMLButtonElement>(".selection-toolbar-link-btn")!;
  const swatches = (bar: HTMLElement): HTMLButtonElement[] => [
    ...bar.querySelectorAll<HTMLButtonElement>(".selection-toolbar-swatch"),
  ];
  const clearBtn = (bar: HTMLElement): HTMLButtonElement =>
    bar.querySelector<HTMLButtonElement>(
      ".selection-toolbar-color .selection-toolbar-btn",
    )!;
  const rowHidden = (bar: HTMLElement, cls: string): boolean =>
    bar.querySelector<HTMLElement>(cls)!.hidden;

  /**
   * 가드(핵심): 바깥(노트 창 접기)이 부르는 [`hideSelectionToolbar`]가 떠 있는 바를 실제로
   * 접는다 — 확장 스펙을 호출마다 새로 만들면 `view.plugin(...)` 조회가 null이 되어 조용한
   * no-op이 되므로(그러면 접힌 창에 잘린 레이어가 그대로 남는다) 그 배선을 고정한다.
   */
  it("hideSelectionToolbar closes an open bar from outside the editor", async () => {
    const { view, bar } = mountBar("할일 끝", true);
    await dragSelect(view, 0, 2);
    expect(bar.hidden).toBe(false);

    hideSelectionToolbar(view);
    expect(bar.hidden).toBe(true);
    // 확장을 얹지 않은 에디터에 불러도 무해하다(테스트·프리뷰 off 경로).
    const plain = new EditorView({ state: EditorState.create({ doc: "x" }) });
    views.push(plain);
    expect(() => hideSelectionToolbar(plain)).not.toThrow();
  });

  /** 가드(핵심 — 표시 조건): 색 문법이 살아 있을 때만 팔레트 버튼이 보인다. */
  it("shows the palette button only while a color pattern is registered", async () => {
    const on = mountBar("할일 끝", true);
    await dragSelect(on.view, 0, 2);
    expect(on.bar.hidden).toBe(false);
    expect(colorBtn(on.bar).hidden).toBe(false);

    const off = mountBar("할일 끝", false);
    await dragSelect(off.view, 0, 2);
    expect(colorBtn(off.bar).hidden).toBe(true);
  });

  /** 가드: 버튼을 누르면 링크 입력과 **같은 방식**으로 바 내용이 팔레트 줄로 바뀐다
   * (별도 모달이 뜨지 않는다). 팔레트 줄에는 9색 스와치 + 해제 버튼이 있다. */
  it("swaps the bar contents for a palette row on click", async () => {
    const { view, bar } = mountBar("할일 끝", true);
    await dragSelect(view, 0, 2);
    colorBtn(bar).click();
    expect(rowHidden(bar, ".selection-toolbar-buttons")).toBe(true);
    expect(rowHidden(bar, ".selection-toolbar-color")).toBe(false);
    expect(swatches(bar).map((s) => s.dataset.color)).toEqual([
      ...SELECTION_COLOR_PALETTE,
    ]);
    expect(clearBtn(bar)).not.toBeNull();
  });

  /** 가드(핵심): 스와치를 누르면 선택이 그 색으로 감싸진다. */
  it("wraps the selection when a swatch is clicked", async () => {
    const { view, bar } = mountBar("할일 끝", true);
    await dragSelect(view, 0, 2);
    colorBtn(bar).click();
    swatches(bar)[0].click();
    expect(view.state.doc.toString()).toBe(
      `{{할일|${SELECTION_COLOR_PALETTE[0]}}} 끝`,
    );
  });

  /** 가드(핵심): 이미 색이 칠해진 안쪽 글자를 다시 드래그하고 다른 색을 고르면 색만 바뀐다
   * (중첩되지 않는다) — 렌더된 줄에서 구분자가 숨겨져 있어도 되는 이유. */
  it("swaps the color of an already-wrapped span", async () => {
    const { view, bar } = mountBar("{{할일|#e33}} 끝", true);
    await dragSelect(view, 2, 4);
    colorBtn(bar).click();
    swatches(bar)[4].click(); // 다섯 번째 색.
    expect(view.state.doc.toString()).toBe(
      `{{할일|${SELECTION_COLOR_PALETTE[4]}}} 끝`,
    );
  });

  /** 가드(핵심): 해제 버튼은 감싸기를 벗겨 평문만 남긴다. */
  it("strips the wrap when the clear button is clicked", async () => {
    const { view, bar } = mountBar("{{할일|#e33}} 끝", true);
    await dragSelect(view, 2, 4);
    colorBtn(bar).click();
    clearBtn(bar).click();
    expect(view.state.doc.toString()).toBe("할일 끝");
  });

  /** 가드: 색이 없는 선택에서 해제를 누르면 본문을 건드리지 않고 버튼 줄로 돌아간다. */
  it("only returns to the button row when there is no color to clear", async () => {
    const { view, bar } = mountBar("할일 끝", true);
    await dragSelect(view, 0, 2);
    colorBtn(bar).click();
    clearBtn(bar).click();
    expect(view.state.doc.toString()).toBe("할일 끝");
    expect(rowHidden(bar, ".selection-toolbar-buttons")).toBe(false);
    expect(rowHidden(bar, ".selection-toolbar-color")).toBe(true);
  });

  /** 가드: 다음 번 선택은 언제나 버튼 줄부터 시작한다(팔레트 줄이 눌러앉지 않는다). */
  it("reopens on the button row after a previous palette session", async () => {
    const { view, bar } = mountBar("할일 끝 다시", true);
    await dragSelect(view, 0, 2);
    colorBtn(bar).click();
    await dragSelect(view, 3, 4);
    expect(rowHidden(bar, ".selection-toolbar-buttons")).toBe(false);
    expect(rowHidden(bar, ".selection-toolbar-color")).toBe(true);
  });

  // ── 링크 버튼과 다중 라인 ───────────────────────────────────────────────
  // `[여러\n줄](url)`은 유효한 링크가 아니므로, 링크 버튼은 다중 라인 선택에서 숨는다.
  describe("link button visibility for multi-line selections", () => {
    /** 가드(핵심): 단일 라인 선택에서는 링크 버튼이 보이고, 같은 바를 다중 라인 선택으로
     * 갱신하면 숨는다. */
    it("hides the link button for a multi-line selection, shows it for single-line", async () => {
      const { view, bar } = mountBar("line1\nline2", false);
      await dragSelect(view, 0, 5); // "line1"만(단일 라인).
      expect(linkBtn(bar).hidden).toBe(false);

      await dragSelect(view, 0, 11); // "line1\nline2" 전체(다중 라인).
      expect(linkBtn(bar).hidden).toBe(true);
    });

    /** 가드: 다중 라인 선택에서 버튼이 숨어 있을 뿐 아니라, 클릭이 들어와도(방어적 가드)
     * 문서를 건드리지 않는다. */
    it("does not turn a multi-line selection into a link even if clicked", async () => {
      const doc = "line1\nline2";
      const { view, bar } = mountBar(doc, false);
      await dragSelect(view, 0, doc.length);
      linkBtn(bar).click();
      expect(view.state.doc.toString()).toBe(doc);
    });
  });

  /**
   * 플러그인 선택 액션(`ui.addSelectionAction`)의 **툴바 표면**.
   *
   * 무엇을 지키나: (1) 액션 버튼이 코어 서식 버튼 **뒤에**(색 버튼 다음) 붙는다, (2) 표시
   * 여부를 매번 그 선택으로 다시 판정한다(등록은 런타임에 켜고 끌 수 있다), (3) 클릭이 그
   * 액션의 `run`에 **지금** 선택된 글자를 넘긴다, (4) 상한을 넘으면 그리지 않는다.
   */
  describe("플러그인 선택 액션", () => {
    afterEach(() => setSelectionActions([]));

    const actionBtns = (bar: HTMLElement): HTMLButtonElement[] => [
      ...bar.querySelectorAll<HTMLButtonElement>(
        ".selection-toolbar-action-btn",
      ),
    ];

    /** 실행 인자를 기록하는 테스트용 액션. */
    const spyAction = (
      id: string,
      match: SelectionActionItem["match"] | undefined,
      seen: string[],
    ): SelectionActionItem => ({
      pluginId: "p",
      id,
      label: id,
      title: `${id} 툴팁`,
      ...(match ? { match } : {}),
      run: (payload) => seen.push(payload.selectedText),
    });

    /** 가드(핵심 — 위치): 액션 버튼은 코어 버튼 줄의 **맨 끝**(색 버튼 다음)에 붙는다. */
    it("renders action buttons after the color button, at the end of the row", async () => {
      setSelectionActions([spyAction("A", undefined, [])]);
      const { view, bar } = mountBar("할일 끝", true);
      await dragSelect(view, 0, 2);
      const row = bar.querySelector<HTMLElement>(".selection-toolbar-buttons")!;
      const buttons = [...row.querySelectorAll("button")];
      // 마지막 버튼이 액션이고, 그 앞에 색 버튼이 있다.
      expect(buttons[buttons.length - 1].textContent).toBe("A");
      expect(buttons.indexOf(colorBtn(bar))).toBe(buttons.length - 2);
      expect(actionBtns(bar)[0].title).toBe("A 툴팁");
    });

    /** 가드: 등록이 없으면 버튼이 하나도 그려지지 않는다(코어 바는 그대로다). */
    it("renders nothing when no plugin registered a selection action", async () => {
      const { view, bar } = mountBar("할일 끝", false);
      await dragSelect(view, 0, 2);
      expect(actionBtns(bar)).toHaveLength(0);
    });

    /**
     * 가드(핵심 — 로컬 판정): 같은 바에서 선택이 바뀌면 표시 여부가 **그때** 다시 판정된다.
     * 한 번 그린 뒤 재판정하지 않으면 조건에 안 맞는 선택에서도 버튼이 남는다.
     */
    it("re-evaluates match on every selection, not once at mount", async () => {
      setSelectionActions([
        spyAction("=", { charClasses: ["digit", "operator"] }, []),
      ]);
      const { view, bar } = mountBar("12+34 그리고 글자", false);
      await dragSelect(view, 0, 5); // "12+34" — 조건에 맞는다.
      expect(actionBtns(bar).map((b) => b.textContent)).toEqual(["="]);

      await dragSelect(view, 6, 9); // "그리고" — 문자 부류를 벗어난다.
      expect(actionBtns(bar)).toHaveLength(0);
    });

    /** 가드(종단): 클릭이 그 액션의 run에 **지금** 선택된 글자를 넘긴다. */
    it("dispatches run with the live selected text on click", async () => {
      const seen: string[] = [];
      setSelectionActions([spyAction("=", undefined, seen)]);
      const { view, bar } = mountBar("12+34", false);
      await dragSelect(view, 0, 5);
      actionBtns(bar)[0].click();
      expect(seen).toEqual(["12+34"]);
      // 실행하면 바는 닫힌다(누른 뒤에도 떠 있으면 결과를 가린다).
      expect(bar.hidden).toBe(true);
    });

    /** 가드: 되쓰기는 이 표면이 하지 않는다 — 문서는 클릭만으로 바뀌지 않는다
     * (본문을 바꾸려면 액션이 `run` 안에서 editor.insertText를 부른다 = notes:write). */
    it("does not touch the document itself — writing back stays on insertText", async () => {
      setSelectionActions([spyAction("=", undefined, [])]);
      const { view, bar } = mountBar("12+34", false);
      await dragSelect(view, 0, 5);
      actionBtns(bar)[0].click();
      expect(view.state.doc.toString()).toBe("12+34");
    });

    /** 가드(상한): 바가 한 번에 그리는 액션 수는 상한을 넘지 않는다(좁은 플로팅 바 보호). */
    it("draws at most SELECTION_ACTION_RENDER_LIMIT action buttons", async () => {
      setSelectionActions(
        Array.from({ length: SELECTION_ACTION_RENDER_LIMIT + 3 }, (_, i) =>
          spyAction(`a${i}`, undefined, []),
        ),
      );
      const { view, bar } = mountBar("할일 끝", false);
      await dragSelect(view, 0, 2);
      expect(actionBtns(bar)).toHaveLength(SELECTION_ACTION_RENDER_LIMIT);
    });

    /** 가드(주입 금지): 라벨은 평문으로 그려진다 — 저작자 문자열이 마크업이 되지 않는다. */
    it("renders the label as plain text, never as markup", async () => {
      setSelectionActions([
        {
          pluginId: "p",
          id: "x",
          label: "<img src=x onerror=1>",
          run: () => {},
        },
      ]);
      const { view, bar } = mountBar("할일 끝", false);
      await dragSelect(view, 0, 2);
      const btn = actionBtns(bar)[0];
      expect(btn.querySelector("img")).toBeNull();
      expect(btn.textContent).toBe("<img src=x onerror=1>");
    });
  });

  /**
   * 회귀(핵심): 무변경 편집 경로 — 감쌀/칠할 글자가 없으면 `dispatchWrap`이 dispatch 자체를
   * 생략한다. 예전에는 "같은 글자로 치환"하는 트랜잭션을 그대로 dispatch했는데, CodeMirror는
   * 삽입 문자열을 원문과 비교하지 않으므로 그것도 `docChanged`가 되어 노트가 dirty로
   * 표시되고(자동저장이 돈다) 되돌리기 스택에 아무 일도 안 하는 단계가 쌓였다.
   */
  describe("무변경 편집 경로(no-op) — dispatch를 건너뛴다", () => {
    /** 가드: 선택이 구조 접두 안에서만 놀면(예: 불릿 "- "만 드래그) 굵게를 눌러도 문서와
     * dispatch 둘 다 그대로다. */
    it("does not dispatch when the marker-toggle selection sits entirely inside the structural prefix", async () => {
      const doc = "- 항목";
      const { view, bar } = mountBar(doc, false);
      await dragSelect(view, 0, 2); // "- "만.
      const dispatchSpy = vi.spyOn(view, "dispatch");
      const boldBtn = bar.querySelectorAll<HTMLButtonElement>(
        ".selection-toolbar-buttons > .selection-toolbar-btn",
      )[0];
      boldBtn.click();
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(doc);
    });

    /** 가드: 빈 줄·공백만 있는 여러 줄을 드래그해 팔레트에서 색을 골라도 dispatch가
     * 일어나지 않는다(칠할 non-blank 줄이 없다). */
    it("does not dispatch when the color selection has no non-blank lines", async () => {
      const doc = "   \n\t";
      const { view, bar } = mountBar(doc, true);
      await dragSelect(view, 0, doc.length);
      colorBtn(bar).click();
      const dispatchSpy = vi.spyOn(view, "dispatch");
      swatches(bar)[0].click();
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(doc);
    });
  });
});

/**
 * **실 파이프라인 종단 가드** — 노트 창이 실제로 쓰는 에디터([`createEditor`])를 그대로
 * 마운트하고, 진짜 마우스 이벤트 시퀀스로만 바를 띄운다.
 *
 * 왜 위의 DOM 블록으로 부족한가: 그쪽은 `selectionToolbar()` **하나만** 얹은 맨 EditorView를
 * 만든다. 그래서 (1) `editor.ts`의 확장 목록에서 이 확장이 빠지거나, (2) 같은 목록의 다른
 * 확장(라이브 프리뷰·마크다운·검색·다중 커서)과 얽혀 표시가 깨지거나, (3) 창 로컬 등록부
 * (`setSelectionActions`)에 들어온 값 하나가 표시 경로 전체를 무너뜨려도 전부 통과한다 —
 * "드래그해도 바가 아예 안 뜬다"는 실사용 보고가 정확히 그 사각지대의 모양이다.
 *
 * 이벤트는 **내부 함수 직접 호출이 아니라** 실제 `MouseEvent` 객체로만 만든다: 리스너
 * 시그니처가 어긋나 `event.button`이 `undefined`가 되면([`shouldHandleSelectionMouseUp`]
 * 도입 시의 위험) 모든 표시가 죽는데, 순수 함수만 부르는 테스트는 그것을 못 본다.
 */
describe("선택 툴바 — 실 파이프라인(createEditor) + 실제 마우스 이벤트", () => {
  // jsdom에는 레이아웃이 없어 CM의 `coordsAtPos`가 좌표를 못 얻는다 — 위 DOM 블록과 같은
  // 최소 대역만 깔고(위치 계산 자체는 순수 함수로 따로 검증) 표시 여부에 집중한다.
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: (): DOMRect[] => [new DOMRect(0, 0, 10, 16)],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 10, 16),
    });
  });

  const editors: EditorView[] = [];
  afterEach(() => {
    while (editors.length > 0) editors.pop()!.destroy();
    setSelectionActions([]);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  /** 노트 창과 같은 모양으로 마운트한다: `#app` > `#editor` > 진짜 에디터. */
  const mountNoteEditor = (
    doc: string,
  ): {
    view: EditorView;
    bar: HTMLElement;
    editor: ReturnType<typeof createEditor>;
  } => {
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
    const editorHost = document.createElement("div");
    editorHost.id = "editor";
    app.append(editorHost);
    const editor = createEditor(editorHost, doc);
    const { view } = editor;
    editors.push(view);
    const bars = [
      ...document.querySelectorAll<HTMLElement>(".selection-toolbar"),
    ];
    const bar = bars[bars.length - 1];
    // 바는 에디터가 아니라 `#app`에 붙는다(노트 창의 `#app` overflow에 잘리지 않게).
    expect(bar.parentElement).toBe(app);
    return { view, bar, editor };
  };

  /**
   * 마우스 드래그 한 번을 실제 이벤트로 흉내 낸다 — 에디터 안 `mousedown`(button 0) →
   * 선택 생성 → **window** `mouseup`(진짜 MouseEvent, 지정 button).
   */
  const dragSelect = async (
    view: EditorView,
    from: number,
    to: number,
    button = 0,
  ): Promise<void> => {
    view.dom.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }),
    );
    view.dispatch({ selection: { anchor: from, head: to } });
    window.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true }));
    await Promise.resolve(); // maybeShow는 queueMicrotask로 미뤄진다.
  };

  /**
   * 키보드 선택 한 걸음 — 마우스 이벤트 **없이** 선택 변경 트랜잭션만 만든다.
   *
   * 왜 진짜 `keydown`이 아닌가: Shift+화살표·Shift+Home/End·`Mod-A`가 툴바에 남기는 흔적은
   * 전부 이 트랜잭션 하나로 같다(키맵은 `EditorSelection`을 만들어 dispatch할 뿐이다). 키
   * 종류마다 따로 흉내 내면 검증하는 것은 CodeMirror의 키맵이지 이 툴바가 아니다 — 툴바가
   * 지켜야 할 계약은 "마우스 흔적이 하나도 없는 선택 변경에도 뜬다"이므로 그것만 만든다.
   */
  const keyboardSelect = (view: EditorView, from: number, to: number): void => {
    view.dispatch({ selection: { anchor: from, head: to } });
  };

  /**
   * `view.composing`(IME 조합 중)을 테스트가 조종할 수 있게 인스턴스에 own 프로퍼티로 덮는다.
   *
   * 왜 이벤트로 만들지 않나: CM의 `composing`은 `inputState.composing > 0`인데, 그 값은
   * `compositionstart` 하나로는 0에 머물고 실제 DOM 변이가 관측돼야 올라간다 — jsdom에는
   * 그 변이를 만드는 IME가 없다. 여기서 조종하는 것은 **CM이 알려주는 조합 상태 하나**뿐이고,
   * mousedown·mouseup·compositionend는 전부 진짜 이벤트로 흘린다(내부 함수 직접 호출 금지).
   */
  const setComposing = (view: EditorView, composing: boolean): void => {
    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => composing,
    });
  };

  /**
   * 조합을 **실제 순서대로** 시작한다: 진짜 `compositionstart`를 올려 "마지막 조합 활동"
   * 시각을 남기고, CM이 알려 주는 `composing`을 참으로 만든다.
   *
   * 시작 이벤트를 빠뜨리면 안 되는 이유: 툴바는 `composing`을 단독으로 믿지 않고 마지막 조합
   * 활동으로부터 얼마나 지났는지를 함께 본다([`isCompositionStale`]). 활동 기록 없이
   * `composing`만 참인 상태는 "조합 종료 통지를 잃은 창"으로 취급돼 표시가 진행된다 — 그건
   * 의도된 복구 동작이지 조합 중 동작이 아니므로, 조합 중을 재현하려면 시작을 함께 흘려야 한다.
   */
  const startComposition = (view: EditorView): void => {
    view.contentDOM.dispatchEvent(
      new Event("compositionstart", { bubbles: true }),
    );
    setComposing(view, true);
  };

  /** 진짜 `compositionend`를 CM과 같은 자리(contentDOM)에서 올린다 — `view.dom`으로 버블한다. */
  const endComposition = async (view: EditorView): Promise<void> => {
    view.contentDOM.dispatchEvent(
      new Event("compositionend", { bubbles: true }),
    );
    await Promise.resolve();
  };

  /**
   * 가드(핵심 — 이번 회귀의 정본): 노트 창이 실제로 만드는 에디터에서, 진짜 마우스 이벤트
   * 시퀀스만으로 바가 뜬다. `editor.ts`의 확장 목록에서 `selectionToolbar()`가 빠지거나
   * 리스너 배선이 어긋나면 여기서 바로 붉어진다.
   */
  it("shows the bar after a real drag through the note editor's own extension list", async () => {
    const { view, bar } = mountNoteEditor("할일 끝");
    expect(bar.hidden).toBe(true);
    await dragSelect(view, 0, 2);
    expect(bar.hidden).toBe(false);
    // 코어 서식 버튼(굵게·기울임·취소선·코드·형광펜 + 링크)이 실제로 그려져 있다.
    expect(
      bar.querySelectorAll(".selection-toolbar-buttons .selection-toolbar-btn")
        .length,
    ).toBeGreaterThanOrEqual(6);
  });

  /**
   * 가드(회귀 #17의 반대편): 우클릭 mouseup은 바를 띄우지 않지만, **그 다음 좌클릭 드래그는
   * 반드시 뜬다**. 리스너가 진짜 MouseEvent를 받아 `button`을 읽고 있다는 종단 증명이기도
   * 하다 — 시그니처가 어긋나 `button`이 `undefined`면 두 번째 단언이 깨진다.
   */
  it("skips the right-click mouseup but keeps the next left drag alive", async () => {
    const { view, bar } = mountNoteEditor("할일 끝 다시");
    await dragSelect(view, 0, 2, 2); // 우클릭 — 뜨지 않는다.
    expect(bar.hidden).toBe(true);
    await dragSelect(view, 3, 4, 0); // 좌클릭 — 낡은 플래그에 막히지 않는다.
    expect(bar.hidden).toBe(false);
  });

  /**
   * 가드(격리 — 이번 하드닝): 창 로컬 선택 액션 등록부가 표시 도중 던져도 **코어 서식 바는
   * 뜬다**. 등록 내용은 호스트 스냅샷을 타고 오는 신뢰 경계 밖 데이터라, 그 하나가 굵게·
   * 기울임까지 데려가면 "드래그해도 아무 것도 안 뜬다"는 무음 실패가 된다.
   */
  it("still shows the core bar when a registered selection action explodes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setSelectionActions([
      {
        pluginId: "bad",
        id: "boom",
        label: "x",
        get match(): never {
          throw new Error("등록부 폭발");
        },
        run: () => {},
      } as unknown as SelectionActionItem,
    ]);
    const { view, bar } = mountNoteEditor("할일 끝");
    await dragSelect(view, 0, 2);
    expect(bar.hidden).toBe(false);
    expect(bar.querySelectorAll(".selection-toolbar-action-btn")).toHaveLength(
      0,
    );
    // 조용히 삼키지 않는다 — 원인은 콘솔에 남는다.
    expect(spy).toHaveBeenCalled();
  });

  /**
   * 가드(격리): 액션의 `run`(플러그인 소유 코드)이 던져도 바는 정상적으로 닫히고 다음
   * 드래그가 살아 있다 — 던진 예외가 정리 코드를 건너뛰면 바가 선택 위에 눌러앉는다.
   */
  it("closes the bar even when a plugin action's run throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setSelectionActions([
      {
        pluginId: "bad",
        id: "throws",
        label: "!",
        run: () => {
          throw new Error("run 폭발");
        },
      },
    ]);
    const { view, bar } = mountNoteEditor("할일 끝 다시");
    await dragSelect(view, 0, 2);
    const btn = bar.querySelector<HTMLButtonElement>(
      ".selection-toolbar-action-btn",
    );
    expect(btn).not.toBeNull();
    expect(() => btn!.click()).not.toThrow();
    expect(bar.hidden).toBe(true);
    expect(spy).toHaveBeenCalled();
    // 다음 제스처는 그대로 산다.
    await dragSelect(view, 3, 4);
    expect(bar.hidden).toBe(false);
  });

  /**
   * IME 조합과 드래그가 겹치는 경로 — 한글 사용자의 실사용 모양이다.
   *
   * 무엇을 지키나: 조합 중이라 표시를 건너뛴 제스처를 **버리지 않는다**. 조합이 끝나면 한 번
   * 다시 판정해 그때도 선택이 살아 있으면 띄운다. 이 예약이 없으면, `compositionend`가
   * `mouseup`보다 늦게 도착하는 웹뷰에서 드래그가 오류도 로그도 없이 사라진다(이 저장소가
   * 조사에서 확인한 **유일한 무음 실패 경로**).
   */
  describe("IME 조합 중 드래그", () => {
    /** 가드(핵심): 조합 중엔 안 뜨고, 조합이 끝나면 그 선택 그대로 뜬다. */
    it("defers the bar until the composition ends, then shows it", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      await dragSelect(view, 0, 2);
      expect(bar.hidden).toBe(true); // 조합 중 — 관례대로 뜨지 않는다.

      setComposing(view, false);
      await endComposition(view);
      expect(bar.hidden).toBe(false); // 조합이 끝났고 선택은 그대로 → 이제 뜬다.
    });

    /** 가드(기존 숨김 규칙 우선): 그 사이 선택이 풀렸으면 재판정에서도 뜨지 않는다. */
    it("does not show when the selection is gone by the time composition ends", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      await dragSelect(view, 0, 2);
      expect(bar.hidden).toBe(true);

      view.dispatch({ selection: { anchor: 2, head: 2 } }); // 선택 해제(커서만).
      setComposing(view, false);
      await endComposition(view);
      expect(bar.hidden).toBe(true);
    });

    /** 가드(기존 숨김 규칙 우선): 새 제스처가 시작됐으면 예약은 무효다 — 낡은 선택으로 뜨지
     * 않는다(그 mousedown이 만들 선택은 아직 오지도 않았다). */
    it("drops the pending retry once a new gesture starts", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      await dragSelect(view, 0, 2);
      expect(bar.hidden).toBe(true);

      // 새 드래그가 시작된다(mousedown만 — 아직 버튼을 놓지 않았다).
      view.dom.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true }),
      );
      setComposing(view, false);
      await endComposition(view);
      expect(bar.hidden).toBe(true);
    });

    /** 가드(1회성): 예약은 조합 종료 한 번에 소모된다 — 이후 조합을 여닫아도 낡은 제스처가
     * 되살아나지 않는다(폴링도, 영구 무장도 아니다). */
    it("consumes the retry exactly once", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      await dragSelect(view, 0, 2);
      setComposing(view, false);
      await endComposition(view);
      expect(bar.hidden).toBe(false);

      // 사용자가 스크롤해 바가 숨는다 → 다음 조합 종료가 그것을 되살리면 안 된다.
      view.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(bar.hidden).toBe(true);
      await endComposition(view);
      expect(bar.hidden).toBe(true);
    });

    /** 가드(비회귀): 조합이 아닌 이유로 걸린 제스처(선택 없음)는 예약하지 않는다 — 조합
     * 종료가 빈 선택을 근거로 바를 띄우는 일이 없다. */
    it("never arms the retry for a gesture that had no selection", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      await dragSelect(view, 2, 2); // 빈 선택(클릭) — 조합과 무관하게 뜰 이유가 없다.
      view.dispatch({ selection: { anchor: 0, head: 2 } }); // 다른 경로가 선택을 만든다.
      setComposing(view, false);
      await endComposition(view);
      expect(bar.hidden).toBe(true);
    });

    /**
     * 가드(영구 사망 방지 — 통지 유실 복구): `compositionend`를 흘린 웹뷰에서 `composing`은
     * 영영 참으로 남는다(CM에는 그 값을 되돌리는 다른 경로가 없다). 그 상태에서 조합 활동이
     * 한동안 끊겼다면 낡은 값으로 보고 표시를 진행한다 — 그러지 않으면 그 창의 모든 드래그가
     * 영구히 삼켜진다.
     */
    it("shows the bar when composing is stale (a lost compositionend)", async () => {
      const { view, bar } = mountNoteEditor("할일 끝");
      startComposition(view);
      // 마지막 조합 활동으로부터 경계를 넘겨 시간이 흘렀다(종료 통지는 끝내 오지 않았다).
      const started = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(started + COMPOSITION_STALE_MS);

      await dragSelect(view, 0, 2);
      expect(bar.hidden).toBe(false);
    });

    /**
     * 가드(폴백 타이머): 조합 종료도 오지 않고 그 사이 시간도 흐르지 않은 순간에 막혔다면,
     * 예약된 타이머가 **딱 한 번** 다시 판정해 되살린다 — 이벤트 하나에만 목숨을 걸지 않는다.
     */
    it("recovers through the fallback timer when compositionend never arrives", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        startComposition(view);
        await dragSelect(view, 0, 2);
        expect(bar.hidden).toBe(true); // 조합 중 — 아직 뜨지 않는다.

        // 조합 종료는 끝내 오지 않는다. 타이머만 흐른다(가짜 시계라 Date.now도 함께 간다).
        vi.advanceTimersByTime(COMPOSITION_STALE_MS * 2);
        await Promise.resolve(); // 재판정은 queueMicrotask로 한 단계 미뤄진다.
        expect(bar.hidden).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(핵심 회귀): 조합 때문에 표시를 건너뛴 제스처는 바가 **한 번도 뜬 적이 없어**
     * (`visible === false`) `hide()`가 예전엔 그 자리에서 바로 반환해 폴백 타이머를 풀지
     * 못했다. 그 상태에서 스크롤(또는 다른 숨김 경로)이 끼어들어도 타이머가 살아남으면,
     * 약 1초 뒤 선택과 무관한 자리에 바가 혼자 뜬다 — 이 테스트는 스크롤이 그 예약을
     * 확실히 취소함을 확인한다.
     */
    it("does not resurrect the bar via the fallback timer once a hidden gesture is scrolled away", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        startComposition(view);
        await dragSelect(view, 0, 2);
        expect(bar.hidden).toBe(true); // 조합 중 — 아직 뜨지 않는다(폴백 타이머는 예약됨).

        // 바가 한 번도 뜬 적 없는 상태에서 스크롤 — hide()가 no-op이면 예약이 살아남는다.
        view.scrollDOM.dispatchEvent(new Event("scroll"));

        // 조합 종료는 끝내 오지 않는다. 타이머만 흐른다.
        vi.advanceTimersByTime(COMPOSITION_STALE_MS * 2);
        await Promise.resolve();
        expect(bar.hidden).toBe(true); // 스크롤이 예약을 취소했으므로 되살아나지 않는다.
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * 키보드로 만든 선택 — 이번 변경의 본체.
   *
   * 무엇을 지키나: 마우스 흔적이 하나도 없는 선택(Shift+화살표·Shift+Home/End·`Mod-A`)에도
   * 바가 뜬다. 다만 키보드에는 `mouseup` 같은 "다 골랐다" 신호가 없어 선택 변경마다 판정하면
   * 글자마다 바가 튀므로, 손이 멈춘 뒤 한 번만 판정하는 디바운스를 거친다.
   */
  describe("키보드로 만든 선택", () => {
    /** 가드(핵심): 마우스 이벤트 없이 만든 선택도 디바운스가 끝나면 뜬다. */
    it("shows the bar for a keyboard-made selection once the keys settle", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        keyboardSelect(view, 0, 2);
        expect(bar.hidden).toBe(true); // 아직 디바운스 중 — 손이 멈춘 뒤에 판정한다.

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve(); // 판정은 queueMicrotask로 한 단계 미뤄진다.
        expect(bar.hidden).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(깜빡임 방지 — 디바운스의 존재 이유): Shift+→ 연타 중에는 **한 번도** 뜨지 않고,
     * 손이 멈춘 뒤 한 번만 뜬다. 매 글자 재표시는 눈에 보이는 깜빡임이자 키 입력마다 붙는
     * 레이아웃 비용이다.
     *
     * "몇 번 판정했나"는 등록된 선택 액션의 `match`를 몇 번 읽었는지로 센다 — 표시 판정은
     * 반드시 그 등록부를 훑고 지나가므로(액션 버튼을 매번 다시 그린다), 이 카운터가 곧
     * 표시 판정 횟수다.
     */
    it("does not flash while the arrow keys are still coming", async () => {
      vi.useFakeTimers();
      try {
        let shows = 0;
        setSelectionActions([
          {
            pluginId: "count",
            id: "count",
            label: "#",
            get match(): undefined {
              shows++;
              return undefined;
            },
            run: () => {},
          } as unknown as SelectionActionItem,
        ]);
        const { view, bar } = mountNoteEditor("할일 끝 다시 또");

        for (const head of [1, 2, 3, 4]) {
          keyboardSelect(view, 0, head);
          vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS - 50);
          await Promise.resolve();
          expect(bar.hidden).toBe(true);
        }
        expect(shows).toBe(0); // 연타 도중에는 판정 자체가 돌지 않는다.

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();
        expect(bar.hidden).toBe(false);
        expect(shows).toBe(1); // 손이 멈춘 뒤 딱 한 번.
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(경로 분리): 드래그 **도중**에는 이 트리거가 끼어들지 않는다 — 마우스에는 정확한
     * 종료 신호(`mouseup`)가 있으므로 그 경로가 처리한다. 둘 다 걸리면 같은 제스처를 두 번
     * 띄우려 들고, 아직 만들어지는 중인 선택 위에 바가 먼저 뜬다.
     */
    it("stays out of the way while a drag is still in progress", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        view.dom.dispatchEvent(
          new MouseEvent("mousedown", { button: 0, bubbles: true }),
        );
        view.dispatch({ selection: { anchor: 0, head: 2 } }); // 드래그가 늘어나는 중.
        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS * 2);
        await Promise.resolve();
        expect(bar.hidden).toBe(true); // 아직 버튼을 놓지 않았다.

        window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
        await Promise.resolve();
        expect(bar.hidden).toBe(false); // 놓는 순간 기존 경로가 띄운다.
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(회귀 재발 방지 — 조합 폴백 타이머와 같은 사고): 예약이 걸린 채 바가 숨겨지면
     * 그 예약은 **반드시** 풀려야 한다. 안 풀면 잠시 뒤 타이머가 혼자 판정을 돌려, 이미
     * 접힌 창·이미 끝난 선택 자리에 바가 되살아난다.
     */
    it("drops the pending keyboard show when something hides the bar first", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        keyboardSelect(view, 0, 2);
        hideSelectionToolbar(view); // 바깥 사정(노트 창 접기)이 바를 접는다.

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS * 2);
        await Promise.resolve();
        expect(bar.hidden).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    /** 가드(같은 규율): 새 마우스 제스처가 시작되면 낡은 키보드 예약은 그 자리에서 버려진다. */
    it("drops the pending keyboard show once a new mouse gesture starts", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        keyboardSelect(view, 0, 2);
        view.dom.dispatchEvent(
          new MouseEvent("mousedown", { button: 0, bubbles: true }),
        );

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS * 2);
        await Promise.resolve();
        expect(bar.hidden).toBe(true); // 그 mousedown이 만들 선택은 아직 오지도 않았다.
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(깜빡임 방지 — 스크롤 숨김과의 충돌): 화면 경계에서 Shift+↓를 이어 누르면 CM이
     * `scrollIntoView`로 스스로 스크롤한다. 그 스크롤까지 숨김으로 치면 선택을 늘리는 내내
     * 바가 떴다 사라졌다 한다 — 선택 변경이 설명하는 스크롤은 숨기지 않고 따라간다.
     */
    it("keeps the bar through the scroll that the selection itself caused", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝 다시 또");
        keyboardSelect(view, 0, 2);
        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();
        expect(bar.hidden).toBe(false);

        keyboardSelect(view, 0, 5); // Shift+↓ 한 걸음 더 — 경계를 넘겼다.
        view.scrollDOM.dispatchEvent(new Event("scroll")); // CM의 자동 스크롤.
        expect(bar.hidden).toBe(false);

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();
        expect(bar.hidden).toBe(false); // 디바운스 끝에 새 자리로 다시 잡힌 채 유지된다.
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(예외의 경계): 선택 변경이 설명하지 못하는 스크롤은 **예전 그대로** 즉시 숨김이다.
     * 바는 `position: fixed`라 본문과 함께 움직이지 않으므로, 놔두면 엉뚱한 글자 위에 남는다.
     */
    it("still hides for a scroll that no selection change explains", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝 다시 또");
        keyboardSelect(view, 0, 2);
        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();
        expect(bar.hidden).toBe(false);

        // 예약은 이미 소모됐다 — 지금 오는 스크롤은 사용자가 굴린 휠이다.
        view.scrollDOM.dispatchEvent(new Event("scroll"));
        expect(bar.hidden).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(`Mod-A` 결함의 정본): 선택의 한쪽 끝이 렌더 범위 밖이라 좌표가 없어도 바는 뜬다.
     *
     * 긴 노트에서 `Mod-A`를 누르면 `from = 0`이 화면 밖이다. 예전 위치 계산은 **양끝**의
     * 좌표를 둘 다 요구해 그때 놓을 자리가 없다고 보고 바를 접었다 — 사용자에게는 "전체
     * 선택하면 서식 바가 안 뜬다". 마우스로 화면 밖까지 끌어 놓았을 때도 같은 결함이었다.
     */
    it("anchors on the head when the other end is outside the rendered range", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝 다시 또");
        vi.spyOn(view, "coordsAtPos").mockImplementation((pos: number) =>
          pos === 0 ? null : { left: 120, right: 140, top: 200, bottom: 216 },
        );

        keyboardSelect(view, 0, view.state.doc.length); // Mod-A와 같은 선택.
        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();

        expect(bar.hidden).toBe(false);
        // 좌표를 준 쪽(head) 위에 걸린다 — jsdom에서 바 크기는 0이라 여백만 남는다.
        expect(bar.style.left).toBe("130px");
        expect(bar.style.top).toBe("194px");
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 가드(IME): 조합 중에 Shift+화살표로 고른 선택도 버려지지 않는다 — 조합이 끝나면
     * 그때 다시 판정해 뜬다(마우스 드래그와 완전히 같은 구제 경로).
     */
    it("defers a keyboard selection made during composition until it ends", async () => {
      vi.useFakeTimers();
      try {
        const { view, bar } = mountNoteEditor("할일 끝");
        startComposition(view);
        keyboardSelect(view, 0, 2);

        vi.advanceTimersByTime(SELECTION_SHOW_DEBOUNCE_MS);
        await Promise.resolve();
        expect(bar.hidden).toBe(true); // 조합 중 — 관례대로 뜨지 않는다.

        setComposing(view, false);
        await endComposition(view);
        expect(bar.hidden).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * 업데이트 사이클 중 레이아웃 읽기 — 이 저장소가 실사용 콘솔에서 잡은 **영구 사망**의 정체.
   *
   * CodeMirror는 `ViewPlugin.update()`가 던지면 그 플러그인을 되살리지 않는다: 예외를
   * "CodeMirror plugin crashed"로 남기고 `destroy()`를 부른 뒤 인스턴스를 폐기한다. 그리고
   * `coordsAtPos`는 업데이트 사이클 중 호출되면 반드시 던진다("Reading the editor layout
   * isn't allowed during an update"). 예전 `update()`는 바가 떠 있으면 그 자리에서 재배치를
   * 불렀으므로, **문서도 선택도 바꾸지 않는 트랜잭션 하나**(글자 크기 변경·플러그인 재구성·
   * 포커스 변화)만 들어와도 툴바가 죽고 그 뒤로는 아무리 드래그해도 뜨지 않았다.
   */
  describe("업데이트 사이클 중 트랜잭션", () => {
    /** 플러그인이 죽었는지 보는 정본: CM은 폐기하며 `destroy()`를 부르고, 그때 바 DOM이 통째로
     * 사라진다. 살아 있다면 DOM도 그대로고 다음 드래그도 여전히 바를 띄운다. */
    const expectAliveAndReshows = async (
      view: EditorView,
      bar: HTMLElement,
    ): Promise<void> => {
      expect(document.querySelector(".selection-toolbar")).not.toBeNull();
      await dragSelect(view, 6, 11);
      expect(bar.hidden).toBe(false);
    };

    /** 가드(핵심): 바가 떠 있는 동안 온 글자 크기 변경(문서·선택 불변)에도 살아남는다. */
    it("survives a reconfigure dispatched while the bar is visible", async () => {
      const { view, bar, editor } = mountNoteEditor("hello world here");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await dragSelect(view, 0, 5);
      expect(bar.hidden).toBe(false);

      editor.setFontSize(18); // 설정 창에서 글자 크기를 바꾸면 이 트랜잭션이 온다.

      await expectAliveAndReshows(view, bar);
      expect(errors).not.toHaveBeenCalled();
    });

    /** 가드: 스냅샷 도착·플러그인 켜고 끄기가 만드는 확장 재구성에도 살아남는다. */
    it("survives a plugin-extension reconfigure while the bar is visible", async () => {
      const { view, bar, editor } = mountNoteEditor("hello world here");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await dragSelect(view, 0, 5);
      expect(bar.hidden).toBe(false);

      editor.setPluginExtensions([], []);

      await expectAliveAndReshows(view, bar);
      expect(errors).not.toHaveBeenCalled();
    });

    /** 가드: 선택을 **다른 비어 있지 않은 범위**로 옮기는 트랜잭션(숨김 규칙에 걸리지 않아
     * 재배치까지 가는 유일한 선택 경로)에도 살아남는다. */
    it("survives a selection move that keeps the selection non-empty", async () => {
      const { view, bar } = mountNoteEditor("hello world here");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await dragSelect(view, 0, 5);
      expect(bar.hidden).toBe(false);

      view.dispatch({ selection: { anchor: 6, head: 11 } });

      await expectAliveAndReshows(view, bar);
      expect(errors).not.toHaveBeenCalled();
    });

    /** 가드(수단): `update()`는 스스로 측정하지 않고 CM의 measure 단계에 **예약만** 한다 —
     * 이 규율이 무너지면 위 세 가드가 다시 붉어진다. */
    it("only schedules a measure from update, never reads layout inline", async () => {
      const { view, bar } = mountNoteEditor("hello world here");
      await dragSelect(view, 0, 5);
      expect(bar.hidden).toBe(false);

      const requestMeasure = vi.spyOn(view, "requestMeasure");
      const coordsAtPos = vi.spyOn(view, "coordsAtPos");
      view.dispatch({ selection: { anchor: 6, head: 11 } });

      expect(requestMeasure).toHaveBeenCalled();
      expect(coordsAtPos).not.toHaveBeenCalled();
    });

    /**
     * 가드(이중 방어): `update()`에서 **무엇이 던지든** CM으로 새어나가지 않는다.
     *
     * 위의 세 가드는 알려진 원인 하나(레이아웃 읽기)를 막을 뿐이다. 이 메서드에서 나가는 예외는
     * 종류를 가리지 않고 플러그인을 영구히 죽이므로, 원인이 무엇이든 이번 표시만 접고 다음
     * 제스처는 살려 둔다(원인은 콘솔에 남긴다 — 삼켜서 감추는 것이 아니다).
     */
    it("swallows any failure inside update so the plugin is never destroyed", async () => {
      const { view, bar } = mountNoteEditor("hello world here");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await dragSelect(view, 0, 5);
      expect(bar.hidden).toBe(false);

      vi.spyOn(view, "requestMeasure").mockImplementation(() => {
        throw new Error("측정 예약이 터졌다");
      });
      view.dispatch({ selection: { anchor: 6, head: 11 } });

      expect(bar.hidden).toBe(true); // 이번 표시는 접는다.
      expect(errors).toHaveBeenCalled(); // 원인은 남긴다.
      await expectAliveAndReshows(view, bar); // 다음 제스처는 살아 있다.
    });
  });
});

/**
 * **칠한 결과가 실제로 어떻게 렌더되는가** — 번들 플러그인(글자 색·위키링크·키 표시)의 진짜
 * 등록을 노트 창과 같은 경로로 태워 확인한다(`inline-pattern-pipeline.test.ts`와 같은 방식).
 *
 * 왜 순수 함수 가드로 부족한가: 이번 버그의 피해는 원문 문자열이 아니라 **화면**이었다 —
 * `{{- 항목|#3a5}}`은 문자열로는 멀쩡해 보이지만 줄이 `{{`로 시작하는 순간 마크다운이 그 줄을
 * 목록으로 보지 않는다. "불릿이 밖에 남는다"는 주장을 문자열이 아니라 DOM으로 건다.
 */
describe("색을 칠한 줄의 실제 렌더(번들 플러그인 파이프라인)", () => {
  const rendered: { destroy(): void }[] = [];
  afterEach(() => {
    while (rendered.length > 0) rendered.pop()!.destroy();
    document.body.innerHTML = "";
  });

  /** 번들 플러그인들을 실제로 로드해 중앙 호스트가 방송하는 것과 같은 스냅샷을 만든다. */
  const snapshotOf = async (ids: string[]): Promise<HostSnapshot> => {
    const plugins: PluginSnapshot[] = [];
    for (const id of ids) {
      const p = await loadPluginFromDir(`src/plugin/builtin/plugins/${id}`);
      expect(p.errors, `${id} 로드 오류`).toEqual([]);
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
    return {
      revision: 1,
      theme: SJ_D,
      background: null,
      font: null,
      windowControls: [],
      plugins,
      failures: [],
    };
  };

  /** 노트 창이 쓰는 그 에디터에 스냅샷을 얹는다 — 커서는 문서 끝이라 앞줄은 렌더 상태다. */
  const mountRendered = async (doc: string): Promise<EditorView> => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createEditor(parent, doc, {});
    const built = buildExtensionsFromSnapshot(
      await snapshotOf(["text-color", "wikilink", "kbd"]),
      {
        noteTitles: async () => [],
        resolveTitleToId: async () => null,
        summon: () => {},
        openUrl: () => {},
      },
    );
    editor.setPluginExtensions(built.render, built.meta);
    rendered.push(editor.view);
    return editor.view;
  };

  /**
   * 가드(핵심 — 이번 수정의 목적 그 자체): 접두를 밖에 남기고 칠한 태스크 줄은 **여전히
   * 체크박스로 렌더된다**(라이브 프리뷰가 `- [ ] `를 위젯으로 바꾼다). 접두를 삼킨 옛 모양
   * (`{{- [ ] …|#3a5}}`)에서는 줄이 `{{`로 시작해 마크다운이 태스크로 보지 않으므로 체크박스가
   * 아예 없다 — 두 문서를 나란히 놓아 "블록 구조가 살아 있는가"를 DOM으로 고정한다.
   */
  it("still renders the line as a task item when the prefix stays outside", async () => {
    const boxes = (view: EditorView): number =>
      view.contentDOM.querySelectorAll(".cm-task-checkbox").length;

    expect(boxes(await mountRendered("- [ ] {{할 일|#3a5}}\n끝"))).toBe(1);
    // 옛 모양(접두를 삼킨 감싸기) — 줄이 `{{`로 시작해 태스크 자체가 사라진다.
    expect(boxes(await mountRendered("{{- [ ] 할 일|#3a5}}\n끝"))).toBe(0);
    // 색 자체는 두 모양 모두에서 칠해진다 — 잃은 것은 오직 블록 구조다.
    expect(
      (
        await mountRendered("{{- [ ] 할 일|#3a5}}\n끝")
      ).contentDOM.querySelector<HTMLElement>(".cm-x-text-color-text-color")
        ?.style.color,
    ).toBe("rgb(51, 170, 85)");
  });

  /**
   * 가드: 색 감싸기 **안의 마크다운 인라인 문법**(인라인 코드)은 그대로 살아 있다 — 라이브
   * 프리뷰(마크다운 문법 트리)와 플러그인 패턴은 서로 다른 데코레이션 집합이라 겹쳐 그려진다.
   * 신고 픽스처 2번째 줄이 그 모양이다.
   */
  it("keeps inline code rendering inside a color wrap", async () => {
    const view = await mountRendered(
      "- {{`**굵게**`, `# 제목`처럼 꾸며봐|#850}}\n끝",
    );
    const colored = view.contentDOM.querySelector<HTMLElement>(
      ".cm-x-text-color-text-color",
    );
    expect(colored?.style.color).toBe("rgb(136, 85, 0)");
    expect(
      [...view.contentDOM.querySelectorAll(".cm-inline-code")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["**굵게**", "# 제목"]);
  });

  /**
   * 가드(예전의 **알려진 한계**였던 자리 — 지금은 동작한다): 색 감싸기 **안의 위키링크도
   * 링크로 남는다**. 예전 겹침 해소는 한 데코레이션 집합 안에서 "먼저 시작한 매치가 이기고
   * 겹치는 나머지는 버린다"라, 줄 머리에서 시작하는 색 감싸기가 그 안의 위키링크를 통째로
   * 덮었다 — `[[제목]]`이 대괄호째 색 글자로 남아 눌러도 아무 일이 없었다. 지금은 채택된
   * 매치의 **콘텐츠 안을 다시 훑어** 중첩 매치까지 채택한다(`plugin/editor-api.ts`의
   * `collectPatternHits`). 여기서는 색을 칠하는 쪽(선택 툴바)의 관심사만 본다: **칠한 결과가
   * 안쪽 링크를 죽이지 않는다.** 중첩 규칙 자체의 가드는 `plugin/inline-pattern-pipeline`에 있다.
   */
  it("keeps a wikilink clickable inside a color wrap", async () => {
    const inside = await mountRendered("- {{[[노트 제목]]을 보라|#3a5}}\n끝");
    const wrap = inside.contentDOM.querySelector<HTMLElement>(
      ".cm-x-text-color-text-color",
    );
    expect(wrap?.style.color).toBe("rgb(51, 170, 85)");
    // 안쪽 링크는 색 구간 **안에** 있고(자손), 클릭 데코를 그대로 갖는다.
    const nested = wrap?.querySelector<HTMLElement>(".cm-x-wikilink-wikilink");
    expect(nested?.classList.contains("cm-plugin-link")).toBe(true);
    expect(nested?.dataset.linkTarget).toBe("노트 제목");
    expect(inside.contentDOM.textContent).not.toContain("[[노트 제목]]");

    const outside = await mountRendered("- [[노트 제목]]을 보라\n끝");
    const link = outside.contentDOM.querySelector<HTMLElement>(
      ".cm-x-wikilink-wikilink",
    );
    expect(link?.dataset.linkTarget).toBe("노트 제목");
    expect(outside.contentDOM.textContent).not.toContain("[[");
  });
});
