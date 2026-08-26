import { describe, it, expect } from "vitest";
import { resolveThemeSource } from "./active-theme";
import type { InstalledPluginSource } from "../plugin/loader";

/** 설치 소스 헬퍼(매니페스트 원문 + 코드 + 부여). */
const source = (
  id: string,
  permissions: string[],
  granted: string[] = [],
  code = "memo.theme.register({});",
): InstalledPluginSource => ({
  manifest: { id, name: id, version: "1.0.0", entry: "main.js", permissions },
  code,
  granted,
});

describe("resolveThemeSource", () => {
  /** 가드: 빌트인 sj_d 이름은 빌트인 코드 + 선언=부여 grant로 해석된다. */
  it("resolves the builtin sj_d theme", () => {
    const r = resolveThemeSource("sj_d", []);
    expect(r).not.toBeNull();
    expect(r!.grant.declared).toEqual(["theme"]);
    expect(r!.grant.granted).toEqual(["theme"]);
    expect(r!.code).toContain("memo.theme.register");
  });

  /** 가드: 빌트인 plain 이름도 해석된다(2번째 빌트인 테마). */
  it("resolves the builtin plain theme", () => {
    const r = resolveThemeSource("plain", []);
    expect(r).not.toBeNull();
    // plain은 무채색(슬레이트) 강조 팔레트를 등록한다(색 토큰만).
    expect(r!.code).toContain("memo.theme.register");
    expect(r!.code).toContain("#5f6672");
  });

  /** 가드: "{테마}<custom>" 파생 변형은 베이스 테마 코드로 해석된다(색 오버라이드는 별도 적용). */
  it("resolves a <custom> variant to its base theme code", () => {
    const r = resolveThemeSource("sj_d<custom>", []);
    expect(r).not.toBeNull();
    expect(r!.code).toContain("memo.theme.register");
    // 베이스 sj_d(딥블루)로 해석 — plain(#5f6672)이 아니다.
    expect(r!.code).toContain("#37506a");
  });

  /** 가드: 설치된 테마 플러그인(theme 선언)을 이름으로 해석하고 부여를 선언과 교집합으로 좁힌다. */
  it("resolves an installed theme plugin and narrows grants to declared", () => {
    const installed = [source("my-theme", ["theme"], ["theme", "notes:read"])];
    const r = resolveThemeSource("my-theme", installed);
    expect(r).not.toBeNull();
    expect(r!.grant.declared).toEqual(["theme"]);
    // 선언 안 한 notes:read 부여는 제거된다.
    expect(r!.grant.granted).toEqual(["theme"]);
  });

  /** 가드(보안): theme를 선언하지 않은 설치 플러그인은 테마로 해석되지 않는다. */
  it("does not resolve a non-theme installed plugin", () => {
    const installed = [source("editor-plugin", ["editor"])];
    expect(resolveThemeSource("editor-plugin", installed)).toBeNull();
  });

  /** 가드(보안): 매니페스트가 무효한 설치 소스는 건너뛴다(파싱 실패 → 해석 안 됨). */
  it("skips an installed source with an invalid manifest", () => {
    const installed = [source("Bad Id!", ["theme"], ["theme"])];
    expect(resolveThemeSource("Bad Id!", installed)).toBeNull();
  });

  /** 가드: 빌트인·설치 어디에도 없는 이름은 null(호출자가 sj_d 기본으로 대체). */
  it("returns null for an unknown theme name", () => {
    expect(resolveThemeSource("nope", [])).toBeNull();
  });

  /** 가드: 빌트인 이름이 설치 플러그인보다 우선한다(id 충돌 시). */
  it("prefers a builtin over an installed plugin with the same id", () => {
    const installed = [source("sj_d", ["theme"], ["theme"], "EVIL")];
    const r = resolveThemeSource("sj_d", installed);
    expect(r!.code).not.toBe("EVIL");
    expect(r!.code).toContain("memo.theme.register");
  });
});
