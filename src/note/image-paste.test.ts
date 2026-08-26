import { describe, it, expect } from "vitest";
import { findPastedImage, pickImageExt } from "./image-paste";

describe("pickImageExt", () => {
  /** 가드: 지원 이미지 MIME → 확장자 매핑(대문자·공백 허용). */
  it("maps known image MIME types to extensions", () => {
    expect(pickImageExt("image/png")).toBe("png");
    expect(pickImageExt("image/jpeg")).toBe("jpg");
    expect(pickImageExt("image/gif")).toBe("gif");
    expect(pickImageExt("image/webp")).toBe("webp");
    expect(pickImageExt(" IMAGE/PNG ")).toBe("png");
  });

  /** 가드: 이미지가 아니거나 모르는 타입은 null(붙여넣기 무시 신호). */
  it("returns null for non-image or unknown types", () => {
    expect(pickImageExt("text/plain")).toBeNull();
    expect(pickImageExt("application/pdf")).toBeNull();
    expect(pickImageExt("")).toBeNull();
  });
});

describe("findPastedImage", () => {
  const file = (type: string): File =>
    new File([new Uint8Array([1])], "x", { type });

  /** 가드: 파일 목록에서 첫 이미지(+확장자)를 고른다. */
  it("picks the first image file with its extension", () => {
    const found = findPastedImage([file("text/plain"), file("image/png")]);
    expect(found?.ext).toBe("png");
    expect(found?.file.type).toBe("image/png");
  });

  /** 가드: 이미지가 없거나 목록이 비면 null. */
  it("returns null when there is no image", () => {
    expect(findPastedImage([file("text/plain")])).toBeNull();
    expect(findPastedImage([])).toBeNull();
    expect(findPastedImage(null)).toBeNull();
    expect(findPastedImage(undefined)).toBeNull();
  });
});
