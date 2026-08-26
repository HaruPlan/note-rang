/**
 * 노트 에디터(CodeMirror 6) 생성.
 *
 * 역할: GFM 마크다운 + 하이브리드 라이브 프리뷰 + 코드 하이라이트 + 편집/찾기 단축키 +
 * undo를 묶어 노트 에디터를 만들고, 라이브 프리뷰 on/off·폰트 크기를 런타임에 바꿀 수
 * 있는 핸들을 돌려준다(노트별 옵션).
 * 왜: 본문은 순수 마크다운(.md)이라 서식은 마커로 다루고, 노트별 설정은 Compartment로
 * 재구성한다.
 */
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  insertNewlineContinueMarkup,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { GFM } from "@lezer/markdown";
import { livePreview } from "./live-preview";
import { markdownShortcuts } from "./md-shortcuts";
import { imagePasteHandler } from "./image-paste";
import { imeListContinue } from "./ime-continue";
import { selectionToolbar } from "./selection-toolbar";
import { t } from "../i18n/t";

/** 마운트된 에디터 핸들 — 라이브 프리뷰/폰트 크기·패밀리를 런타임에 바꿀 수 있다. */
interface NoteEditor {
  view: EditorView;
  setPreview(on: boolean): void;
  setFontSize(px: number): void;
  /**
   * 전역 폰트 패밀리를 갈아 끼운다(`undefined` = 지정 없음 → 시스템 기본).
   *
   * 예전엔 정적 확장이라 글꼴을 바꾸면 창을 통째로 리로드해야 했다. Compartment로 옮겨
   * dispatch 한 번에 바뀌므로 스크롤·선택·IME 조합이 유지된다(`setFontSize`와 같은 결).
   */
  setFontFamily(family: string | undefined): void;
  /** 문서 전체를 새 본문으로 교체한다(디스크가 바깥에서 바뀐 경우 — 스냅샷 복원 반영). */
  setContent(text: string): void;
  /**
   * 플러그인 확장을 갈아 끼운다.
   *
   * `extension`(렌더 — 데코레이션·임베드)은 프리뷰가 꺼지면 내려가고, `meta`(색 문법 facet 등
   * **사실 정보**)는 프리뷰와 무관하게 항상 살아 있다. 둘 다 필수 인자다: 하나로 합치거나
   * 옵셔널로 두면 호출부가 메타를 빠뜨렸을 때 원문 모드에서 색 버튼이 조용히 사라진다
   * (실제로 났던 결함이다 — host-client의 `buildExtensionsFromSnapshot`이 둘을 갈라 준다).
   */
  setPluginExtensions(extension: Extension, meta: Extension): void;
}

/** 노트 에디터 생성 옵션. */
interface EditorOptions {
  onChange?: (content: string) => void;
  preview?: boolean;
  fontSize?: number;
  /** 전역 폰트 패밀리(CSS 폰트 스택 — 「폰트」 플러그인 선택값). 없으면 시스템 기본. */
  fontFamily?: string;
  /** 이미지 본문 경로 → 웹뷰 URL 해석기(라이브 프리뷰의 `<img>` src). */
  resolveImageSrc?: (path: string) => string;
  /** 본문 링크 클릭 시 시스템 브라우저로 넘긴다(없으면 링크는 보이되 클릭이 무시된다). */
  openExternalUrl?: (url: string) => void;
  /** 붙여넣은 이미지 바이트를 저장하고 본문에 넣을 상대경로를 돌려준다(없으면 이미지 붙여넣기 무시). */
  saveImage?: (data: Uint8Array, ext: string) => Promise<string>;
}

const DEFAULT_FONT_PX = 14;

/** 폰트 크기 테마 확장을 만든다. */
function fontTheme(px: number): Extension {
  return EditorView.theme({ "&": { fontSize: `${px}px` } });
}

/**
 * 폰트 패밀리 테마 확장을 만든다(지정 없으면 빈 확장 = 시스템 기본).
 *
 * `.cm-content`가 `font-family: inherit`이라 `.cm-editor`(`&`)에 지정하면 본문까지 상속된다.
 */
function fontFamilyTheme(family: string | undefined): Extension {
  return family ? EditorView.theme({ "&": { fontFamily: family } }) : [];
}

/**
 * 이 창의 에디터가 지금 잡고 있는 선택 영역 — 플러그인 계약 `MemoSelection`의 실체.
 *
 * 역할: "선택한 텍스트를 대문자로"·"선택을 `**`로 감싸기" 같은 요구를 코드로 옮길 수 있게
 * 하는 **읽기** 표면. 되쓰기는 오프셋을 받는 API를 열지 않고 반드시
 * `insertText({ mode: "cursor" })`를 통하게 한다 — 읽은 뒤 사용자가 타이핑해 오프셋이
 * 어긋나도 CodeMirror 트랜잭션이 그 경합을 흡수하기 때문이다.
 */
interface NoteSelection {
  /** 주 선택(main range)의 텍스트. 빈 선택이면 "". */
  text: string;
  /** 주 선택의 시작 문서 문자 오프셋. */
  from: number;
  /** 주 선택의 끝 문서 문자 오프셋(빈 선택이면 from과 같다 = 커서 위치). */
  to: number;
  /** 빈 선택(=커서만 있음)인지. */
  empty: boolean;
  /**
   * 선택 범위 개수(다중 커서면 2 이상). **0이면 이 창에 에디터가 없어 읽지 못했다는 뜻**이라,
   * 나머지 필드는 전부 기본값이다(빈 문자열·0·true).
   */
  ranges: number;
  /**
   * IME 조합(한글·일본어 등) 중인지. 조합 중에 되쓰면 조합이 깨지므로, 되쓰는 플러그인은
   * 이 값이 true면 아무 것도 하지 않는 편이 안전하다.
   */
  composing: boolean;
}

/** 에디터가 없을 때의 선택값 — `ranges: 0`이 "읽지 못했다"는 신호다. */
const NO_SELECTION: NoteSelection = {
  text: "",
  from: 0,
  to: 0,
  empty: true,
  ranges: 0,
  composing: false,
};

/**
 * 이 창에 마운트된 에디터(노트 창당 정확히 1개 — [`createEditor`]가 갱신한다).
 *
 * 왜 모듈 변수인가: 창-스코프 호출의 수행부(`host-client.ts`)는 **주입받은 서비스 객체**만
 * 들고 있고 그 객체를 만드는 곳(`main.ts`)은 이 담당의 소유가 아니다. 노트 창에 에디터가
 * 하나뿐이라는 사실은 이 모듈이 이미 알고 있으므로, 새 배선을 요구하는 대신 여기서 정본을
 * 노출한다(같은 프로세스에서 여러 번 만들면 마지막 것이 정본 — 테스트가 그 경우다).
 */
let mountedView: EditorView | null = null;

/**
 * 이 창 에디터의 선택 영역을 읽는다. 에디터가 없으면 `ranges: 0`인 기본값.
 *
 * 다중 선택(Alt+클릭·⌘D)에서는 **주 선택만** text/from/to에 싣고 개수를 `ranges`로 알린다 —
 * 되쓰기 경로(`insertText({mode:"cursor"})`)가 주 선택 하나만 대체하므로, 여러 범위를 읽은
 * 척하면 저작자가 "다 바뀔 것"이라 오해한다.
 */
export function readNoteSelection(): NoteSelection {
  const view = mountedView;
  if (!view) return NO_SELECTION;
  const sel = view.state.selection;
  const main = sel.main;
  return {
    text: view.state.sliceDoc(main.from, main.to),
    from: main.from,
    to: main.to,
    empty: main.empty,
    ranges: sel.ranges.length,
    composing: view.composing,
  };
}

/**
 * CodeMirror 6 에디터를 생성해 parent에 마운트하고 핸들을 돌려준다.
 *
 * 초기 커서는 문서 끝에 두어 첫 줄(헤딩)이 곧바로 렌더 상태로 보이게 한다.
 */
export function createEditor(
  parent: HTMLElement,
  doc: string,
  options: EditorOptions = {},
): NoteEditor {
  const previewC = new Compartment();
  const fontC = new Compartment();
  const fontFamilyC = new Compartment();
  const pluginC = new Compartment();
  // 플러그인 **메타** 확장 전용 칸 — 프리뷰에 종속되지 않는다(아래 pluginC와 대비).
  const pluginMetaC = new Compartment();
  // 프리뷰 상태와 플러그인 렌더 확장을 함께 추적한다 — 프리뷰를 끄면 플러그인 렌더(유튜브 임베드·
  // 인라인 패턴 등)도 원문 텍스트로 보이도록 pluginC를 프리뷰에 종속시킨다(둘은 별도 Compartment).
  let previewOn = options.preview !== false;
  let pluginExt: Extension = [];
  // 라이브 프리뷰에 주입하는 것들: 이미지 `<img>` src 해석기, 링크 열기 핸들러.
  const previewOptions = {
    resolveImageSrc: options.resolveImageSrc,
    openExternalUrl: options.openExternalUrl,
  };
  // 이미지 붙여넣기 핸들러는 저장 함수가 주어졌을 때만 단다.
  const pasteExt = options.saveImage
    ? imagePasteHandler(options.saveImage)
    : [];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        history(),
        // 다중 커서(포인터): CM이 선택/커서를 직접 그려(drawSelection) 여러 개를 렌더하고,
        // allowMultipleSelections로 다중 선택을 허용한다. Alt+클릭=커서 추가, Alt+드래그=사각
        // 선택, ⌘D=다음 일치 선택(searchKeymap). dropCursor=드래그 삽입 위치 표시.
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        search({ top: true }),
        // Tab/⇧Tab 들여쓰기 폭 = 2칸(리스트 중첩·일반 들여쓰기 일관).
        indentUnit.of("  "),
        keymap.of([
          ...markdownShortcuts,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: GFM,
          // 기본 키맵(Enter+Backspace)을 끄고 Enter만 아래에서 되살린다 — 이유는 그 주석 참고.
          addKeymap: false,
        }),
        // lang-markdown 기본 키맵 중 **Enter 이어쓰기만** 되살린다(원래 정밀도 Prec.high 그대로).
        //
        // 왜 Backspace(`deleteMarkupBackward`)는 빼나: 마커 바로 뒤에서 ⌫를 누르면 한 글자가
        // 아니라 마커 전체(`- [ ] `)를 한 번에 지우고, 이어진 리스트 항목에서는 마커를 **같은
        // 너비의 공백으로 치환**한다. 사용자 기대(`- [ ] ` → `- [ ]`)와 어긋날 뿐 아니라, 본문이
        // 그대로 디스크에 저장되는 이 앱에서는 후자가 `.md`에 눈에 안 보이는 꼬리 공백을 남긴다.
        // ⌫는 CM 표준 `deleteCharBackward`(defaultKeymap)에 맡겨 한 글자씩 지운다.
        Prec.high(
          keymap.of([{ key: "Enter", run: insertNewlineContinueMarkup }]),
        ),
        // 한글 IME 조합 확정 Enter에서도 리스트 마커가 이어지도록 보정(위
        // insertNewlineContinueMarkup을 조합 종료 후 재실행). 일반 Enter는 그대로 CM이 처리.
        imeListContinue(),
        // 마우스로 텍스트를 드래그해 선택하면 선택 영역 근처에 뜨는 서식 플로팅 툴바
        // (굵게·기울임·취소선·코드·링크·형광펜) — Mod-B/Mod-I/Mod-K와 같은 감싸기 계산을 공유한다.
        selectionToolbar(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        previewC.of(
          options.preview === false ? [] : livePreview(previewOptions),
        ),
        fontC.of(fontTheme(options.fontSize ?? DEFAULT_FONT_PX)),
        // 전역 폰트 패밀리(「폰트」 플러그인 선택값). Compartment라 설정 변경·호스트 재빌드
        // 뒤에도 창을 리로드하지 않고 제자리에서 갈아 끼운다(`setFontFamily`).
        fontFamilyC.of(fontFamilyTheme(options.fontFamily)),
        pluginC.of([]),
        pluginMetaC.of([]),
        pasteExt,
        // 빈 노트가 "배경색만" 보이지 않도록 입력 힌트를 표시한다.
        placeholder(t("note.editor.placeholder")),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && options.onChange) {
            options.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });
  // 창-스코프 선택 영역 읽기의 정본 — 노트 창에는 에디터가 하나뿐이다.
  mountedView = view;
  return {
    view,
    setPreview: (on) => {
      previewOn = on;
      view.dispatch({
        effects: [
          previewC.reconfigure(on ? livePreview(previewOptions) : []),
          // 프리뷰를 끄면 플러그인 렌더도 원문으로(유튜브 임베드·인라인 패턴 등).
          pluginC.reconfigure(on ? pluginExt : []),
        ],
      });
    },
    setFontSize: (px) =>
      view.dispatch({ effects: fontC.reconfigure(fontTheme(px)) }),
    setFontFamily: (family) =>
      view.dispatch({
        effects: fontFamilyC.reconfigure(fontFamilyTheme(family)),
      }),
    /** 문서 전체를 새 본문으로 교체한다(스냅샷 복원 등 디스크가 바깥에서 바뀐 경우 —
     * 낡은 버퍼가 그 변경을 덮지 않게 다시 읽어 온다). docChanged가 되므로 onChange가
     * 불려 자동저장이 다시 걸린다(디스크와 같은 내용이라 무해하다). */
    setContent: (text: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      }),
    setPluginExtensions: (extension, meta) => {
      pluginExt = extension;
      view.dispatch({
        effects: [
          pluginC.reconfigure(previewOn ? extension : []),
          // 메타는 프리뷰와 무관하게 항상 살린다 — 렌더가 아니라 "색을 넣을 때 어떤 구분자로
          // 감싸는가" 같은 사실이고, 선택 툴바의 색 버튼은 그 facet의 유무만 보고 뜬다.
          // 예전엔 렌더와 한 덩어리라 프리뷰를 끄면 색 버튼이 함께 사라졌다(실사용 재현).
          pluginMetaC.reconfigure(meta),
        ],
      });
    },
  };
}
