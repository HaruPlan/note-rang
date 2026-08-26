import { describe, it, expect } from "vitest";
import {
  checkPermission,
  isKnownPermission,
  isSensitive,
  permissionToCalls,
  type PluginGrant,
} from "./permissions";

describe("isSensitive / isKnownPermission", () => {
  /** 가드: 저위험·민감·embed·미지의 권한을 올바르게 분류한다. */
  it("classifies low-risk, sensitive, embed, and unknown", () => {
    expect(isSensitive("ui")).toBe(false);
    expect(isSensitive("theme")).toBe(false); // theme은 저위험(민감 아님)
    expect(isSensitive("notes:read")).toBe(true);
    expect(isSensitive("embed:youtube.com")).toBe(true);

    expect(isKnownPermission("editor")).toBe(true);
    expect(isKnownPermission("theme")).toBe(true); // 새 저위험 권한
    expect(isKnownPermission("notes:write")).toBe(true);
    expect(isKnownPermission("embed:vimeo.com")).toBe(true);
    expect(isKnownPermission("filesystem")).toBe(false);
  });

  /** 가드: `invoke:<대상>`은 embed·network와 같은 접두 매칭 민감 권한이다. */
  it("classifies invoke:<target> as a sensitive, known prefix permission", () => {
    expect(isSensitive("invoke:copy-ai-prompt")).toBe(true);
    expect(isKnownPermission("invoke:copy-ai-prompt")).toBe(true);
    // 바 `invoke`(대상 없음)는 접두가 아니라 미지의 권한이다(대상별 선언이 계약).
    expect(isKnownPermission("invoke")).toBe(false);
  });
});

describe("theme 권한 게이팅", () => {
  const grant = (declared: string[], granted: string[] = []): PluginGrant => ({
    declared,
    granted,
  });

  /** 가드: theme은 저위험 — 선언만으로 허용(부여 불필요). */
  it("allows theme when declared, without a grant", () => {
    expect(checkPermission(grant(["theme"]), "theme").allowed).toBe(true);
  });

  /** 가드(보안 핵심): theme 미선언이면 거부(테마 등록 권한도 예외 없음). */
  it("denies theme when not declared", () => {
    const d = checkPermission(grant([]), "theme");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("미선언");
  });

  /** 가드: theme 선언만으론 다른 민감 권한을 얻지 못한다(권한 확장 없음). */
  it("declaring theme grants no sensitive access", () => {
    const g = grant(["theme"]);
    expect(checkPermission(g, "notes:read").allowed).toBe(false);
    expect(checkPermission(g, "vault:read").allowed).toBe(false);
  });
});

describe("checkPermission", () => {
  const grant = (declared: string[], granted: string[] = []): PluginGrant => ({
    declared,
    granted,
  });

  /** 가드: 선언된 저위험 권한은 부여 없이도 허용. */
  it("allows a declared low-risk permission without a grant", () => {
    expect(checkPermission(grant(["ui"]), "ui").allowed).toBe(true);
  });

  /** 가드: 미선언 권한은 거부. */
  it("denies an undeclared permission", () => {
    const d = checkPermission(grant([]), "ui");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("미선언");
  });

  /** 가드: 민감 권한은 선언만으론 부족(부여 필요). */
  it("denies a sensitive permission declared but not granted", () => {
    const d = checkPermission(grant(["notes:read"]), "notes:read");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("미승인");
  });

  /** 가드: 민감 권한은 선언 + 부여 모두 있으면 허용. */
  it("allows a sensitive permission declared AND granted", () => {
    expect(
      checkPermission(grant(["notes:read"], ["notes:read"]), "notes:read")
        .allowed,
    ).toBe(true);
  });

  /** 가드: 알 수 없는 권한은 부여돼 있어도 거부. */
  it("denies an unknown permission even if granted", () => {
    const d = checkPermission(
      grant(["filesystem"], ["filesystem"]),
      "filesystem",
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("알 수 없는");
  });

  /** 가드: embed는 도메인 단위로 강제(다른 도메인은 미선언). */
  it("enforces embed per-domain", () => {
    const g = grant(["embed:youtube.com"], ["embed:youtube.com"]);
    expect(checkPermission(g, "embed:youtube.com").allowed).toBe(true);
    expect(checkPermission(g, "embed:evil.com").allowed).toBe(false);
  });
});

describe("permissionToCalls (역인덱스)", () => {
  /** 가드: 호출→권한 매핑을 뒤집어 권한→호출 목록을 만든다(알파벳 정렬). */
  it("groups call names by the permission that gates them", () => {
    const callPermissions = {
      "settings.get": "settings",
      "settings.set": "settings",
      "editor.insertText": "notes:write",
      "notes.duplicate": "notes:write",
    };
    expect(permissionToCalls(callPermissions)).toEqual({
      settings: ["settings.get", "settings.set"],
      "notes:write": ["editor.insertText", "notes.duplicate"],
    });
  });

  /** 가드: 빈 입력은 빈 출력. */
  it("returns an empty object for an empty call map", () => {
    expect(permissionToCalls({})).toEqual({});
  });
});
