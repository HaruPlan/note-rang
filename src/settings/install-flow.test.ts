import { afterEach, describe, it, expect } from "vitest";
import {
  compareVersions,
  computeApprovalView,
  describeSource,
  grantsForApproval,
  grantsForRegrant,
  minHostVersionUnmet,
  needsApproval,
  newlyAvailablePending,
  parseInstallInput,
  pendingReservedForApproval,
  pendingReservedForRegrant,
  permissionInfo,
  previewMinHostVersion,
  reservedRegrant,
  selfReportedLlmContext,
  selfReportedPermissionReasons,
  selfReportedPurpose,
  specFromSource,
} from "./install-flow";
import { registerLocale, setActiveLocale } from "../i18n/store";
import type { InstalledPlugin, InstallPreview } from "../shared/tauri";

/** 설치 미리보기 픽스처(신규 설치 기본형). */
const preview = (over: Partial<InstallPreview> = {}): InstallPreview => ({
  staging: "tok",
  manifest: {
    id: "p",
    name: "P",
    version: "2.0.0",
    entry: "main.js",
    permissions: ["editor", "notes:read"],
  },
  source: { type: "url", url: "https://x/p.zip" },
  installed_version: null,
  installed_permissions: [],
  installed_granted: [],
  ...over,
});

/** 설치 플러그인 픽스처. */
const plugin = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "p",
  name: "P",
  version: "1.0.0",
  permissions: ["editor"],
  enabled: true,
  granted: [],
  settings_schema: [],
  settings: {},
  ...over,
});

describe("parseInstallInput", () => {
  /** 가드: https만 통과 — 빈 입력·http·스킴 없는 입력은 사용자 오류로 거부. */
  it("rejects empty and non-https inputs", () => {
    expect(parseInstallInput("")).toEqual({
      ok: false,
      error: "URL을 입력하세요.",
    });
    expect(parseInstallInput("   ").ok).toBe(false);
    expect(parseInstallInput("http://x/p.zip").ok).toBe(false);
    expect(parseInstallInput("example.com/repo.git").ok).toBe(false);
    expect(parseInstallInput("https://").ok).toBe(false);
  });

  /** 가드: 경로가 .zip으로 끝나면 zip 다운로드(url), 그 외 https는 git 저장소로 해석. */
  it("classifies .zip paths as url and everything else as git", () => {
    expect(parseInstallInput("https://x/p.zip")).toEqual({
      ok: true,
      spec: { kind: "url", location: "https://x/p.zip" },
    });
    // 쿼리가 붙어도 경로 기준으로 판별한다.
    expect(parseInstallInput("https://x/p.ZIP?dl=1")).toEqual({
      ok: true,
      spec: { kind: "url", location: "https://x/p.ZIP?dl=1" },
    });
    expect(parseInstallInput("https://github.com/u/repo")).toEqual({
      ok: true,
      spec: { kind: "git", location: "https://github.com/u/repo" },
    });
  });

  /** 가드: `#ref`가 git ref(태그/커밋 — 버전 핀)로 분리된다. 공백은 정리. */
  it("splits #ref into git_ref", () => {
    expect(parseInstallInput("  https://x/r.git#v1.2.0 ")).toEqual({
      ok: true,
      spec: { kind: "git", location: "https://x/r.git", git_ref: "v1.2.0" },
    });
    // 빈 ref(#만)면 ref 없이 git으로 해석한다.
    expect(parseInstallInput("https://x/r.git#")).toEqual({
      ok: true,
      spec: { kind: "git", location: "https://x/r.git" },
    });
  });
});

describe("permissionInfo", () => {
  // registerLocale이 더한 로케일(store.ts locales Map)은 되돌릴 export가 없다
  // (store.test.ts와 같은 관례) — active만 테스트마다 ko로 되돌린다.
  afterEach(() => setActiveLocale("ko"));

  /** 가드: 알려진 권한은 한국어 라벨/설명, embed는 도메인 삽입, 미지는 원문 유지. */
  it("maps known permissions to Korean labels and handles embed/unknown", () => {
    expect(permissionInfo("notes:read").label).toBe("노트 읽기");
    expect(permissionInfo("notes:read").desc).toContain("읽을 수");

    const embed = permissionInfo("embed:youtube.com");
    expect(embed.label).toContain("youtube.com");
    expect(embed.desc).toContain("youtube.com");

    // network:<도메인>도 embed처럼 도메인을 삽입한 동적 문구다(정직하게 호스트를 밝힌다).
    const net = permissionInfo("network:api.example.com");
    expect(net.label).toContain("api.example.com");
    expect(net.desc).toContain("api.example.com");

    // invoke:<대상>도 동적 접두 문구 — "다른 플러그인을 부른다"를 정직하게 밝힌다.
    const inv = permissionInfo("invoke:copy-ai-prompt");
    expect(inv.label).toContain("copy-ai-prompt");
    expect(inv.desc).toContain("다른 플러그인");
    expect(inv.desc).toContain("copy-ai-prompt");
    expect(inv.reserved).toBe(false);

    expect(permissionInfo("mystery").label).toBe("mystery");
  });

  /** 가드: `vault:read`/`vault:write`는 대응 브리지 호출이 미구현이라 `reserved: true` —
   * 승인해도 효과가 없다는 걸 승인 뷰가 표시할 수 있어야 한다. `commands`는 이미,
   * `network:<도메인>`은 실장돼 예약이 풀렸다(`storage`는 처음부터 실동작 권한이다). */
  it("flags reserved (not-yet-wired) permissions via PERMISSION_RESERVED", () => {
    expect(permissionInfo("network:api.example.com").reserved).toBe(false);
    expect(permissionInfo("vault:read").reserved).toBe(true);
    expect(permissionInfo("vault:write").reserved).toBe(true);
    expect(permissionInfo("commands").reserved).toBe(false);
    expect(permissionInfo("storage").reserved).toBe(false);
    expect(permissionInfo("notes:read").reserved).toBe(false);
    // clipboard.read는 미구현이지만 clipboard.write는 동작하므로 권한 전체는 예약이 아니다.
    expect(permissionInfo("clipboard").reserved).toBe(false);
  });

  /** 가드: clipboard/windows 설명은 실제로 동작하는 범위만 서술한다(과대 서술 금지). */
  it("describes clipboard and windows narrowly to match actual behavior", () => {
    expect(permissionInfo("clipboard").desc).toBe("클립보드에 쓸 수 있어요");
    expect(permissionInfo("clipboard").desc).not.toContain("읽고");
    expect(permissionInfo("windows").desc).toContain("위키링크");
  });

  // notes:write는 호스트 스코프의 임의 노트 덮어쓰기(파괴적)까지 여므로, 승인 문구가 그
  // 범위(지금 열려 있지 않은 노트)·파괴성(덮어쓰기)·복구 경로(메모 복구)를 다 말해야 한다 —
  // 이전의 "노트 내용을 수정할 수 있어요"는 그 위험을 감췄다.
  it("warns that notes:write can overwrite arbitrary notes and points to recovery", () => {
    const desc = permissionInfo("notes:write").desc;
    expect(desc).toContain("덮어쓸 수 있어요");
    expect(desc).toContain("지금 열려 있지 않은 메모");
    expect(desc).toContain("메모 복구");
  });

  /**
   * 회귀 가드: `PERMISSION_INFO`가 모듈 최상위 `const`로 `t()`를 import 시점에 즉시
   * 평가하던 버그(활성 로케일이 무엇이든 이 창이 로드되는 순간의 로케일 — 늘 ko — 로
   * 영원히 굳는다)의 재발을 막는다 — 지금은 라벨/설명을 `labelKey`/`descKey`로만 쥐고
   * `permissionInfo`가 호출될 때마다 `t()`로 그 순간의 활성 로케일을 읽는다.
   * `registerLocale`은 되돌릴 export가 없으므로(store.test.ts와 같은 관례) 이 파일에서
   * 유일한 코드("xx")를 쓴다.
   */
  it("known-permission label/desc follow the active locale at call time", () => {
    registerLocale("xx", "Test", {
      "settings.install-flow.permission-clipboard-label": "XX Clipboard",
      "settings.install-flow.permission-clipboard-desc": "XX clipboard desc",
    });

    setActiveLocale("xx");
    expect(permissionInfo("clipboard").label).toBe("XX Clipboard");
    expect(permissionInfo("clipboard").desc).toBe("XX clipboard desc");

    setActiveLocale("ko");
    expect(permissionInfo("clipboard").label).toBe("클립보드");
    expect(permissionInfo("clipboard").desc).toBe("클립보드에 쓸 수 있어요");
  });
});

describe("compareVersions", () => {
  /** 가드: 주.부.수 순서로 비교 — 같으면 0, 크면 양수, 작으면 음수. */
  it("compares semver triples numerically", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0); // 숫자 비교(문자열 비교 아님).
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
  });

  /** 가드: 프리릴리스/빌드 메타데이터는 무시하고 주.부.수만 비교. */
  it("ignores prerelease/build metadata suffixes", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0+build5", "1.0.0")).toBe(0);
  });

  /** 가드: semver로 안 읽히면 null — 호출부가 다운그레이드 판정을 건너뛰는 신호. */
  it("returns null for non-semver version strings", () => {
    expect(compareVersions("release-42", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "not-a-version")).toBeNull();
  });
});

describe("computeApprovalView", () => {
  /** 가드: 미설치 id는 신규 설치 — 모든 선언 권한이 표시되고 added 없음. */
  it("classifies a fresh install", () => {
    const view = computeApprovalView(preview());
    expect(view.kind).toBe("install");
    if (view.kind !== "install") return;
    expect(view.name).toBe("P");
    expect(view.permissions.map((p) => p.id)).toEqual(["editor", "notes:read"]);
    expect(view.permissions.every((p) => !p.added)).toBe(true);
    // 민감 여부가 라벨 강조의 근거다.
    expect(view.permissions.find((p) => p.id === "notes:read")!.sensitive).toBe(
      true,
    );
  });

  /** 가드: 같은 버전이면 최신(uptodate) — 프롬프트를 띄우지 않는 근거. */
  it("classifies up-to-date when versions match", () => {
    const view = computeApprovalView(preview({ installed_version: "2.0.0" }));
    expect(view).toEqual({ kind: "uptodate", version: "2.0.0" });
  });

  /** 가드: 승인 화면의 각 권한 행은 reserved 여부를 실어 나른다(승인 프롬프트가
   * "아직 동작하지 않음"을 표시할 수 있게). */
  it("carries the reserved flag on each permission row", () => {
    const view = computeApprovalView(
      preview({
        manifest: {
          id: "p",
          name: "P",
          version: "2.0.0",
          entry: "main.js",
          permissions: ["editor", "vault:read"],
        },
      }),
    );
    if (view.kind === "uptodate") throw new Error("unexpected");
    expect(view.permissions.find((p) => p.id === "vault:read")!.reserved).toBe(
      true,
    );
    expect(view.permissions.find((p) => p.id === "editor")!.reserved).toBe(
      false,
    );
  });

  /** 가드: 설치될 버전이 semver로 현재보다 낮으면 downgrade — 차단은 안 하되 종류를 분리한다. */
  it("classifies a lower version as downgrade (not blocked, just flagged)", () => {
    const view = computeApprovalView(
      preview({
        manifest: {
          id: "p",
          name: "P",
          version: "1.0.0",
          entry: "main.js",
          permissions: ["editor"],
        },
        installed_version: "2.0.0",
      }),
    );
    expect(view.kind).toBe("downgrade");
    if (view.kind !== "downgrade") return;
    expect(view.fromVersion).toBe("2.0.0");
    expect(view.version).toBe("1.0.0");
  });

  /** 가드: 버전이 semver로 안 읽히면 다운그레이드 판정 없이 기존처럼 update로 폴백한다. */
  it("falls back to update when versions are not semver-comparable", () => {
    const view = computeApprovalView(
      preview({
        manifest: {
          id: "p",
          name: "P",
          version: "release-old",
          entry: "main.js",
          permissions: ["editor"],
        },
        installed_version: "release-new",
      }),
    );
    expect(view.kind).toBe("update");
  });

  /** 가드: 업데이트 — 이전 선언에 없던 민감 권한만 added로 표시된다(재승인 강조). */
  it("marks only newly declared sensitive permissions as added on update", () => {
    const view = computeApprovalView(
      preview({
        manifest: {
          id: "p",
          name: "P",
          version: "2.0.0",
          entry: "main.js",
          permissions: ["editor", "notes:read", "clipboard"],
        },
        installed_version: "1.0.0",
        installed_permissions: ["editor", "notes:read"],
      }),
    );
    expect(view.kind).toBe("update");
    if (view.kind !== "update") return;
    expect(view.fromVersion).toBe("1.0.0");
    const added = view.permissions.filter((p) => p.added).map((p) => p.id);
    expect(added).toEqual(["clipboard"]); // notes:read는 기존 선언 → added 아님.
  });

  /** 가드: 매니페스트가 `permissionReasons`를 선언하면 그 권한 행에만 자기신고
   * 이유가 실린다 — 승인 프롬프트가 병기할 데이터. `InstallPreview["manifest"]` 타입엔
   * 이 필드가 없으므로 `unknown` 주입으로 실제 IPC 페이로드 모양을 흉내낸다. */
  it("attaches the plugin's self-reported reason to the matching permission only", () => {
    const p = preview();
    (p.manifest as Record<string, unknown>).permissionReasons = {
      "notes:read": "위키링크 자동완성에 노트 제목이 필요해요",
    };
    const view = computeApprovalView(p);
    if (view.kind === "uptodate") throw new Error("expected install view");
    expect(view.permissions.find((x) => x.id === "notes:read")!.reason).toBe(
      "위키링크 자동완성에 노트 제목이 필요해요",
    );
    expect(
      view.permissions.find((x) => x.id === "editor")!.reason,
    ).toBeUndefined();
  });

  /** 가드: `permissionReasons` 미선언이면 모든 권한 행의 reason이 undefined다(없는 필드를
   * 지어내지 않는다). */
  it("omits reason entirely when the manifest declares none", () => {
    const view = computeApprovalView(preview());
    if (view.kind === "uptodate") throw new Error("expected install view");
    expect(view.permissions.every((p) => p.reason === undefined)).toBe(true);
  });

  /**
   * 가드(축 2, 9c9fcc9 잔여 결함 수정): `manifest.nls`가 있으면 승인 프롬프트 이름도 해석된다.
   * 고치기 전엔 `computeApprovalView`가 `manifest.name`을 원문 그대로 꽂아 `%키%`가 승인
   * 프롬프트에 그대로 노출됐다 — `resolveNlsString`을 거치게 한 배선을 여기서 고정한다.
   * `registerLocale`은 되돌릴 export가 없으므로(위 "known-permission label..." 가드와 같은
   * 관례) 이 파일에서 유일한 코드("xx")를 쓴다.
   */
  it("resolves the manifest's own nls into the approval name", () => {
    const withNls = preview({
      manifest: {
        id: "p",
        name: "%p.name%",
        version: "2.0.0",
        entry: "main.js",
        permissions: [],
        nls: {
          default: { "p.name": "복사하기" },
          xx: { "p.name": "XX Copy" },
        },
      },
    });

    // 활성 로케일에 없으면 default 사전으로 폴백한다(등록 전 상태 = ko가 사전에 없음).
    const koView = computeApprovalView(withNls);
    expect(koView.kind).toBe("install");
    if (koView.kind !== "install") return;
    expect(koView.name).toBe("복사하기");

    registerLocale("xx", "Test", {});
    setActiveLocale("xx");
    const xxView = computeApprovalView(withNls);
    setActiveLocale("ko");
    expect(xxView.kind).toBe("install");
    if (xxView.kind !== "install") return;
    expect(xxView.name).toBe("XX Copy");
  });

  /** 가드(하위호환): `nls` 없는 매니페스트는 이름이 100% 무변화다(기존 동작 그대로). */
  it("leaves the name untouched when the manifest declares no nls", () => {
    const view = computeApprovalView(preview());
    expect(view.kind).toBe("install");
    if (view.kind !== "install") return;
    expect(view.name).toBe("P");
  });
});

describe("selfReportedPurpose", () => {
  /** 가드: purpose 문자열을 앞뒤 공백 제거해 읽는다 — 매니페스트든 설치 플러그인이든
   * 같은 키라 원천을 가리지 않는다. */
  it("reads a trimmed purpose string from any self-report source", () => {
    expect(selfReportedPurpose({ purpose: "  메모를 예쁘게 꾸며요  " })).toBe(
      "메모를 예쁘게 꾸며요",
    );
  });

  /** 가드: 없음·빈 문자열·공백뿐·비문자열·null/undefined 원천은 전부 undefined(=표시 안 함)로
   * 본다 — "선언은 됐는데 화면엔 이상한 값이 뜬다"를 막는 안전 폴백. */
  it("treats missing, blank, or malformed values as absent", () => {
    expect(selfReportedPurpose({})).toBeUndefined();
    expect(selfReportedPurpose({ purpose: "   " })).toBeUndefined();
    expect(selfReportedPurpose({ purpose: 7 })).toBeUndefined();
    expect(selfReportedPurpose(null)).toBeUndefined();
    expect(selfReportedPurpose(undefined)).toBeUndefined();
  });
});

describe("selfReportedLlmContext", () => {
  /** 가드: llmContext 문자열을 앞뒤 공백 제거해 읽는다. */
  it("reads a trimmed llmContext string", () => {
    expect(
      selfReportedLlmContext({ llmContext: "능력: 툴바 버튼 1개\n" }),
    ).toBe("능력: 툴바 버튼 1개");
  });

  /** 가드: 없음·빈 문자열·비문자열 원천은 undefined다. */
  it("treats missing or malformed values as absent", () => {
    expect(selfReportedLlmContext({})).toBeUndefined();
    expect(selfReportedLlmContext({ llmContext: "" })).toBeUndefined();
    expect(selfReportedLlmContext({ llmContext: [] })).toBeUndefined();
  });
});

describe("selfReportedPermissionReasons", () => {
  /** 가드: 권한 id → 이유 문자열 맵을 그대로 읽는다. */
  it("reads a permission-id to reason string map", () => {
    expect(
      selfReportedPermissionReasons({
        permissionReasons: { "notes:read": "토글 상태를 기억하려고요" },
      }),
    ).toEqual({ "notes:read": "토글 상태를 기억하려고요" });
  });

  /** 가드: 형식이 어긋난 항목만 그 항목만 버리고(전체 거부 아님), 원천 자체가 잘못돼도
   * 빈 객체로 안전 폴백한다. */
  it("drops non-string values per-entry and tolerates a malformed source", () => {
    expect(selfReportedPermissionReasons({})).toEqual({});
    expect(selfReportedPermissionReasons(null)).toEqual({});
    expect(
      selfReportedPermissionReasons({ permissionReasons: ["a", "b"] }),
    ).toEqual({});
    expect(
      selfReportedPermissionReasons({
        permissionReasons: { editor: "이유", ui: 7, settings: "   " },
      }),
    ).toEqual({ editor: "이유" });
  });
});

describe("grantsForApproval", () => {
  /** 가드: 신규 설치 승인 = 선언된 민감 권한 전부(저위험은 부여 대상 아님). */
  it("grants all declared sensitive permissions on fresh install", () => {
    expect(grantsForApproval(preview())).toEqual(["notes:read"]);
  });

  /** 가드: 업데이트 승인 = (기존 부여 ∩ 새 선언) ∪ 새로 추가된 민감 권한 —
   * 사용자가 껐던 기존 권한은 다시 켜지 않고, 선언에서 빠진 부여는 버린다. */
  it("keeps prior grants and adds only newly declared sensitive perms on update", () => {
    const granted = grantsForApproval(
      preview({
        manifest: {
          id: "p",
          name: "P",
          version: "2.0.0",
          entry: "main.js",
          // windows는 선언에서 빠졌고, clipboard가 새로 선언됐다.
          permissions: ["editor", "notes:read", "notes:write", "clipboard"],
        },
        installed_version: "1.0.0",
        installed_permissions: [
          "editor",
          "notes:read",
          "notes:write",
          "windows",
        ],
        // notes:write는 선언돼 있었지만 사용자가 부여하지 않았다 → 재부여 금지.
        installed_granted: ["notes:read", "windows"],
      }),
    );
    expect(granted).toEqual(["notes:read", "clipboard"]);
  });

  /** 가드: 예약(미구현) 민감 권한은 승인해도 효과가 없으므로 자동 부여 대상에서 뺀다
   * (신규 설치·업데이트 둘 다). */
  it("excludes reserved sensitive permissions from auto-grant", () => {
    expect(
      grantsForApproval(
        preview({
          manifest: {
            id: "p",
            name: "P",
            version: "2.0.0",
            entry: "main.js",
            permissions: ["editor", "notes:read", "vault:write", "vault:read"],
          },
        }),
      ),
    ).toEqual(["notes:read"]);

    expect(
      grantsForApproval(
        preview({
          manifest: {
            id: "p",
            name: "P",
            version: "2.0.0",
            entry: "main.js",
            permissions: ["editor", "vault:read"],
          },
          installed_version: "1.0.0",
          installed_permissions: ["editor"],
          installed_granted: [],
        }),
      ),
    ).toEqual([]);
  });
});

describe("notes:all-read 승인 경로", () => {
  const allReadPreview = preview({
    manifest: {
      id: "p",
      name: "P",
      version: "2.0.0",
      entry: "main.js",
      permissions: ["ui", "notes:all-read"],
    },
  });

  /**
   * 가드(지시 — 예약 해제 경로 확인): `notes.list`/`notes.read`가 예약에서 풀린 방식은
   * 기존 권한의 해제가 아니라 **처음부터 예약이 아닌 신설 권한**이다. 그래서
   * (1) 승인 즉시 부여된다(pendingReserved로 보류되지 않는다) — 재승인 행이 뜰 이유가
   * 없고, (2) 만에 하나 pendingReserved에 들어 있어도 `newlyAvailablePending`이 즉시
   * "사용 가능"으로 골라낸다(예약 목록에 없으므로) — 재승인 배선이 이 권한에 대해 실제로
   * 도는 방향이 이 둘이다.
   */
  it("grants notes:all-read immediately on approval (never parked as pendingReserved)", () => {
    expect(grantsForApproval(allReadPreview)).toEqual(["notes:all-read"]);
    expect(pendingReservedForApproval(allReadPreview)).toEqual([]);
  });

  it("newlyAvailablePending treats notes:all-read as available (not reserved)", () => {
    expect(newlyAvailablePending(["notes:all-read", "vault:read"])).toEqual([
      "notes:all-read",
    ]);
    const regrant = reservedRegrant(
      plugin({ pendingReserved: ["notes:all-read", "vault:read"] }),
    );
    expect(regrant.available).toEqual(["notes:all-read"]);
    expect(regrant.remaining).toEqual(["vault:read"]);
  });

  /** 가드: 승인 화면 문구가 권한이 실제로 여는 범위(숨긴 메모 포함 전체)를 그대로 말한다 —
   * 과소서술은 이 저장소에서 이미 사고였다(그 교훈). */
  it("describes notes:all-read honestly (hidden notes included)", () => {
    const info = permissionInfo("notes:all-read");
    expect(info.label).toBe("모든 노트 읽기");
    expect(info.desc).toContain("숨긴 메모");
    expect(info.desc).toContain("모든 메모");
    expect(info.reserved).toBe(false);
  });
});

describe("pendingReservedForApproval", () => {
  /** 가드: 선언된 민감 권한 중 예약(미구현)인 것만 pendingReserved 후보로 뽑는다
   * (grantsForApproval이 제외한 것과 정확히 상보 관계). */
  it("picks declared sensitive permissions that are currently reserved", () => {
    const p = preview({
      manifest: {
        id: "p",
        name: "P",
        version: "2.0.0",
        entry: "main.js",
        permissions: ["editor", "notes:read", "vault:write", "vault:read"],
      },
    });
    expect(pendingReservedForApproval(p)).toEqual([
      "vault:write",
      "vault:read",
    ]);
    // grantsForApproval과 상보 — 합쳐서 declared sensitive 전체가 된다.
    expect(
      [...grantsForApproval(p), ...pendingReservedForApproval(p)].sort(),
    ).toEqual(["notes:read", "vault:read", "vault:write"]);
  });

  /** 가드: 예약 권한이 없으면 빈 배열. */
  it("returns an empty array when nothing is reserved", () => {
    expect(pendingReservedForApproval(preview())).toEqual([]);
  });
});

describe("newlyAvailablePending", () => {
  /** 가드: 지금도 예약인 권한은 걸러지고, 예약이 풀린 권한만 남는다. */
  it("filters out permissions that are still reserved", () => {
    // vault:read/vault:write는 지금도 PERMISSION_RESERVED다(host.ts). network:<도메인>은 풀렸다.
    expect(newlyAvailablePending(["vault:write", "vault:read"])).toEqual([]);
    // editor는 애초에 저위험이라 PERMISSION_RESERVED에 없다 — "풀렸다"고 판정된다.
    expect(newlyAvailablePending(["vault:write", "editor"])).toEqual([
      "editor",
    ]);
  });

  /** 가드: 빈 입력은 빈 출력(배너를 안 띄우는 정상 경로). */
  it("returns empty for empty input", () => {
    expect(newlyAvailablePending([])).toEqual([]);
  });
});

describe("reservedRegrant", () => {
  /** 가드: 풀린 것은 available(부여 대상), 아직 예약인 것은 remaining(계속 기억)으로 갈린다 —
   * 목록의 안내와 승인이 같은 값을 쓰게 하는 단일 판정. */
  it("splits pendingReserved into now-available and still-reserved", () => {
    // editor는 PERMISSION_RESERVED에 없다(=풀림), vault:write/vault:read는 지금도 예약이다.
    const p = plugin({
      pendingReserved: ["vault:write", "editor", "vault:read"],
    });
    expect(reservedRegrant(p)).toEqual({
      available: ["editor"],
      remaining: ["vault:write", "vault:read"],
    });
  });

  /** 가드: 기록이 없거나(구버전 백엔드 응답 — 필드 부재) 전부 아직 예약이면 available이 비어
   * 안내 행이 뜨지 않는다. */
  it("yields no re-approval target when nothing became available", () => {
    expect(reservedRegrant(plugin())).toEqual({
      available: [],
      remaining: [],
    });
    expect(
      reservedRegrant(plugin({ pendingReserved: ["vault:read"] })),
    ).toEqual({
      available: [],
      remaining: ["vault:read"],
    });
  });

  /** 가드: available ∪ remaining은 원래 pendingReserved 전체다(승인해도 항목이 새거나
   * 사라지지 않는다 — 저장값이 조용히 유실되면 재승인 기회 자체가 없어진다). */
  it("partitions pendingReserved without losing entries", () => {
    const pending = [
      "network:api.example.com",
      "editor",
      "vault:write",
      "windows",
    ];
    const { available, remaining } = reservedRegrant(
      plugin({ pendingReserved: pending }),
    );
    expect([...available, ...remaining].sort()).toEqual([...pending].sort());
  });
});

describe("previewMinHostVersion", () => {
  /** 가드: 백엔드가 실어 보내는 minHostVersion을 꺼낸다 — 여기서 끊기면 설치 게이트가
   * 영원히 "제약 없음"만 본다. */
  it("reads minHostVersion off the preview manifest", () => {
    const p = preview();
    p.manifest.minHostVersion = "9.9.9";
    expect(previewMinHostVersion(p)).toBe("9.9.9");
    expect(minHostVersionUnmet(previewMinHostVersion(p), "0.1.0")).toBe(true);
  });

  /** 가드: 부재·빈 문자열·비문자열은 "제약 없음"으로 본다(형태가 어긋난 응답이 설치를 막는
   * 쪽으로 기울지 않게 — 안전 폴백). */
  it("treats missing or malformed values as no constraint", () => {
    expect(previewMinHostVersion(preview())).toBeUndefined();
    const blank = preview();
    (blank.manifest as Record<string, unknown>).minHostVersion = "   ";
    expect(previewMinHostVersion(blank)).toBeUndefined();
    const bogus = preview();
    (bogus.manifest as Record<string, unknown>).minHostVersion = 3;
    expect(previewMinHostVersion(bogus)).toBeUndefined();
  });
});

describe("minHostVersionUnmet", () => {
  /** 가드: minHostVersion 미선언은 항상 통과(제약 없음). */
  it("passes when minHostVersion is undefined", () => {
    expect(minHostVersionUnmet(undefined, "0.1.0")).toBe(false);
  });

  /** 가드: 앱 버전이 minHostVersion보다 낮으면 미달(true). */
  it("flags when the app version is lower than minHostVersion", () => {
    expect(minHostVersionUnmet("0.5.0", "0.1.0")).toBe(true);
    expect(minHostVersionUnmet("0.1.0", "0.1.0")).toBe(false);
    expect(minHostVersionUnmet("0.1.0", "0.2.0")).toBe(false);
  });

  /** 가드: 어느 한쪽이 semver로 안 읽히면 비교 불가 → false(폴백은 항상 통과 — 다운그레이드
   * 판정과 동일한 안전 폴백 관례). */
  it("does not block when versions are not semver-comparable", () => {
    expect(minHostVersionUnmet("not-a-version", "0.1.0")).toBe(false);
  });
});

describe("needsApproval / grantsForRegrant", () => {
  /** 가드: 민감 권한 선언 + 부여 0일 때만 재승인 안내 대상이다(새 기기 신호). */
  it("flags plugins with declared-but-ungranted sensitive permissions", () => {
    expect(
      needsApproval(plugin({ permissions: ["notes:read"], granted: [] })),
    ).toBe(true);
    expect(
      needsApproval(
        plugin({ permissions: ["notes:read"], granted: ["notes:read"] }),
      ),
    ).toBe(false);
    expect(needsApproval(plugin({ permissions: ["editor"] }))).toBe(false);
  });

  /** 가드: 재승인이 부여할 대상은 선언된 민감 권한뿐이다. */
  it("lists only sensitive permissions for re-granting", () => {
    expect(
      grantsForRegrant(
        plugin({ permissions: ["editor", "notes:read", "windows"] }),
      ),
    ).toEqual(["notes:read", "windows"]);
  });

  /**
   * 가드(회귀): 재승인은 **예약 권한을 부여하지 않는다** — 설치 승인
   * (`grantsForApproval`)과 같은 필터여야 한다.
   *
   * 왜: 예전에는 "선언된 민감 권한 전부"를 부여해, 설치 승인이 일부러 보류한 vault:write를
   * 「이 기기에서 권한 승인 필요」 버튼 한 번으로 부여했다(저작 문서가 약속한
   * "예약은 살아나는 순간 자동으로 부여되지 않는다"가 그 경로로 깨졌다).
   */
  it("never grants reserved permissions on re-approval", () => {
    const p = plugin({
      permissions: ["notes:read", "vault:write", "vault:read"],
    });
    expect(grantsForRegrant(p)).toEqual(["notes:read"]);
    expect(pendingReservedForRegrant(p)).toEqual(["vault:write", "vault:read"]);
    // 설치 승인 경로와 정확히 같은 답이어야 한다(두 경로가 갈리면 그 자체가 결함이다).
    expect(grantsForRegrant(p)).toEqual(
      grantsForApproval(
        preview({
          manifest: { ...preview().manifest, permissions: p.permissions },
        }),
      ),
    );
  });

  /**
   * 가드: 예약 권한만 선언한 플러그인은 승인 나그를 띄우지 않는다.
   *
   * 왜: 부여할 것이 없어 `granted`가 계속 비므로, 예약을 판정에 넣으면 방금 승인을 마친
   * 행에 "이 기기에서 권한 승인 필요"가 영원히 남는다(누르면 예약이 부여된다).
   */
  it("does not nag when only reserved permissions are declared", () => {
    expect(
      needsApproval(plugin({ permissions: ["vault:read"], granted: [] })),
    ).toBe(false);
  });
});

describe("specFromSource / describeSource", () => {
  /** 가드: 출처 → 재설치 스펙 변환 — local은 null(원본 위치 없음 → "코드 없음" 안내). */
  it("converts sources to install specs (local has none)", () => {
    expect(specFromSource({ type: "url", url: "https://x/p.zip" })).toEqual({
      kind: "url",
      location: "https://x/p.zip",
    });
    expect(
      specFromSource({ type: "git", url: "https://x/r.git", ref: "v1" }),
    ).toEqual({ kind: "git", location: "https://x/r.git", git_ref: "v1" });
    expect(specFromSource({ type: "git", url: "https://x/r.git" })).toEqual({
      kind: "git",
      location: "https://x/r.git",
    });
    expect(specFromSource({ type: "local" })).toBeNull();
  });

  /** 가드: 출처 표시 문자열 — git ref는 #으로 붙이고 local은 한국어 안내. */
  it("describes sources for the UI", () => {
    expect(describeSource({ type: "url", url: "https://x/p.zip" })).toBe(
      "https://x/p.zip",
    );
    expect(
      describeSource({ type: "git", url: "https://x/r.git", ref: "v1" }),
    ).toBe("https://x/r.git#v1");
    expect(describeSource({ type: "local" })).toBe("로컬 설치");
  });
});
