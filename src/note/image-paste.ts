/**
 * 이미지 붙여넣기 핸들러 — 클립보드 이미지를 vault에 저장하고 본문에 마크다운으로 삽입.
 *
 * 역할: 에디터에 이미지를 붙여넣으면 바이트를 읽어 `saveImage`로 vault에 저장하고,
 * 돌려받은 상대경로로 `![](path)`를 커서 자리에 끼워 넣는다.
 * 왜: 붙여넣기→저장→삽입을 한 확장으로 묶되, MIME→확장자 같은 순수 로직은 분리해
 * 테스트로 고정한다(네이티브 클립보드는 e2e에서 검증).
 */
import { EditorView } from "@codemirror/view";

/** MIME 타입별 파일 확장자(이미지). 모르는 타입은 null(붙여넣기 무시). */
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/**
 * 이미지 MIME 타입에서 파일 확장자를 고른다(순수, 테스트용). 이미지가 아니면 null.
 *
 * 역할: 클립보드 항목의 `type`(예: `image/png`)을 저장 파일 확장자로 매핑한다.
 * 왜: 어떤 타입을 이미지로 받아들일지/확장자를 무엇으로 둘지의 규칙을 한 곳에 고정한다.
 */
export function pickImageExt(mimeType: string): string | null {
  return IMAGE_MIME_EXT[mimeType.trim().toLowerCase()] ?? null;
}

/**
 * 붙여넣기 이벤트에서 첫 이미지 파일을 찾는다(순수, 테스트용). 없으면 null.
 *
 * 역할: `clipboardData.files`를 훑어 [`pickImageExt`]가 받아들이는 첫 이미지를 고른다.
 * 왜: "무엇을 이미지로 볼지" 선택을 DOM 핸들러와 분리해 단위 테스트로 못박는다.
 */
export function findPastedImage(
  files: ArrayLike<File> | null | undefined,
): { file: File; ext: string } | null {
  if (!files) return null;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const ext = pickImageExt(file.type);
    if (ext) return { file, ext };
  }
  return null;
}

/** 이미지 붙여넣기 핸들러가 쓰는 저장 함수(바이트·확장자 → vault 상대경로). */
type SaveImage = (data: Uint8Array, ext: string) => Promise<string>;

/**
 * 저장한 이미지의 상대경로를 커서 위치에 `![](path)`로 삽입한다.
 *
 * 역할: 현재 선택 범위를 마크다운 이미지로 치환하고, 삽입 뒤로 커서를 옮긴다.
 * 왜: 비동기 저장이 끝난 시점의 최신 선택을 기준으로 넣어, 그 사이 입력과 충돌하지 않게 한다.
 */
function insertImageMarkdown(view: EditorView, relPath: string): void {
  const snippet = `![](${relPath})`;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: snippet },
    selection: { anchor: from + snippet.length },
  });
}

/**
 * 이미지 붙여넣기 DOM 핸들러 확장을 만든다.
 *
 * 클립보드에 이미지가 있으면 기본 붙여넣기를 막고(true 반환), 바이트를 읽어 `saveImage`로
 * 저장한 뒤 `![](상대경로)`를 삽입한다. 이미지가 없으면 false를 돌려 기본 동작(텍스트
 * 붙여넣기)을 유지한다. 저장 실패는 콘솔에 남기고 조용히 무시한다(편집 흐름 비차단).
 */
export function imagePasteHandler(saveImage: SaveImage) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const found = findPastedImage(event.clipboardData?.files);
      if (!found) return false;
      event.preventDefault();
      void found.file
        .arrayBuffer()
        .then((buf) => saveImage(new Uint8Array(buf), found.ext))
        .then((relPath) => insertImageMarkdown(view, relPath))
        .catch((error: unknown) => {
          console.error("[memo] 이미지 붙여넣기 저장 실패:", error);
        });
      return true;
    },
  });
}
