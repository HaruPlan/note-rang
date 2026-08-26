/**
 * 번들 언어팩(`src/plugin/builtin/language-packs/*`) 가드 — 폴더가 실제로 실린 아티팩트를
 * 그대로 검증한다.
 *
 * 이 파일이 지키는 것은 두 가지다:
 *
 * 1. **폴더 규약이 로더와 맞물린다.** `src/i18n/packs.ts`는 사전을 열지 않고 폴더 이름에서
 *    로케일 코드를 파생한다(그래야 "활성 로케일만 로드"가 성립한다). 파생 코드와 매니페스트
 *    `contributes.translations[0].locale`이 어긋나면 그 팩은 **아무 오류도 없이 영원히 안
 *    쓰인다** — 그 조용한 실패를 여기서 잡는다.
 * 2. **en 드리프트.** en이 정적 시드(`src/i18n/en.json`)였을 때 `store.test.ts`가 지키던
 *    커버리지 가드를 그대로 옮겨 왔다 — 진실 원천이 팩 매니페스트로 옮겨 갔으므로 가드도
 *    그 파일을 읽어야 의미가 있다. ko.json에 키를 추가하고 팩을 같이 안 고치면 en 모드에서
 *    그 키만 조용히 ko로 폴백한다(t.ts의 폴백 체인).
 *
 * 선언형 전용(=`main.js`가 공백뿐) 팩이라 코드 본문을 스캔하는 `builtin.test.ts`의 가드들이
 * 여기에는 아무것도 발화하지 않는다 — `kind`·`permissions`를 명시적으로 확인하는 아래 가드가
 * 그 사각지대를 메운다.
 */
import { describe, expect, it } from "vitest";
import ko from "./ko.json";
import { validateLocaleEntries } from "./validate";
import { parseManifest } from "../plugin/manifest";
import {
  bundledPackMetas,
  loadActiveBundledLocale,
  loadAllBundledPacks,
  loadBundledPack,
  packToBuiltin,
} from "./packs";
import { availableLocales, localeDictionary } from "./store";

/** `contributes.translations[0]`를 느슨한 형으로 꺼낸다(브리지 계약과 같은 모양). */
function translationOf(manifest: {
  contributes?: { translations?: Record<string, unknown>[] };
}): { locale?: unknown; label?: unknown; entries?: unknown } {
  return manifest.contributes?.translations?.[0] ?? {};
}

describe("번들 언어팩 폴더 규약", () => {
  /** 가드: 적어도 한 팩(en)은 실려 있다 — 글로브가 조용히 빈손이 되면 아래 가드 전부가
   * 무의미하게 통과하므로 먼저 못박는다. */
  it("ships at least the English pack", () => {
    expect(bundledPackMetas().map((m) => m.id)).toContain("language-pack-en");
  });

  /**
   * 가드(핵심): 폴더명에서 파생한 코드가 매니페스트가 선언한 `locale`과 정확히 같다.
   *
   * 어긋나면 `loadActiveBundledLocale`이 그 팩을 후보로 고르지 못하거나(파생 코드 기준),
   * 골라 놓고 다른 로케일을 등록해(`locale` 기준) `setActiveLocale`이 미등록 코드로 무시한다 —
   * 어느 쪽이든 화면은 조용히 ko로 접힌다.
   */
  it("derives the folder code equal to the manifest locale", async () => {
    for (const meta of bundledPackMetas()) {
      const pack = await loadBundledPack(meta.code);
      expect(pack, `${meta.id}: 폴더 코드로 로드되지 않음`).not.toBeNull();
      expect(translationOf(pack!.manifest).locale).toBe(meta.code);
    }
  });

  /** 가드: 표시 라벨(언어 드롭다운에 보이는 이름)이 비어 있지 않다 — 빈 라벨은 고를 수는
   * 있는데 이름이 없는 항목이 된다. */
  it("declares a non-empty label for the picker", async () => {
    for (const pack of await loadAllBundledPacks()) {
      const label = translationOf(pack.manifest).label;
      expect(typeof label, `${pack.id}: label이 문자열이 아님`).toBe("string");
      expect(
        String(label).length,
        `${pack.id}: label이 비어 있음`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * 가드(도그푸딩): 번들 언어팩 매니페스트가 **외부 플러그인과 같은 검증기**를 통과하고,
   * 능력 게이트가 요구하는 선언(`kind: "capability"` + 권한 `i18n`)을 갖춘다.
   *
   * 왜 명시 가드인가: `builtin.test.ts`의 "코드가 부르는 호출에 권한을 선언했나" 가드는
   * `main.js` 본문을 스캔하는데, 이 팩의 main.js는 공백뿐이라 아무 패턴에도 안 걸린다.
   * 선언형 전용 플러그인은 그 스캔의 사각지대다 — 여기서 직접 못박는다.
   */
  it("passes manifest validation and declares the i18n capability", async () => {
    for (const pack of await loadAllBundledPacks()) {
      const parsed = parseManifest(pack.manifest);
      expect(parsed.ok, `${pack.id}: 매니페스트 검증 실패`).toBe(true);
      expect(pack.manifest.id, `${pack.id}: id가 폴더명과 다름`).toBe(pack.id);
      expect(pack.manifest.kind).toBe("capability");
      expect(pack.manifest.permissions).toContain("i18n");
    }
  });

  /** 가드: 번들 README 관례를 따른다 — 사용자용 "이렇게 써요" 절이 있고, raw 권한 나열
   * ("## 권한")은 하지 않는다(상세 뷰가 친근한 라벨로 보여준다). */
  it("ships a user-facing readme following the bundle conventions", async () => {
    for (const pack of await loadAllBundledPacks()) {
      expect(pack.readme).toContain("## 이렇게 써요");
      expect(pack.readme.length).toBeGreaterThan(40);
      expect(pack.readme).not.toContain("## 권한");
      // 영어 변형도 함께 싣는다(설정창 상세가 활성 로케일로 고른다) — 언어팩이야말로
      // 영어 README가 없으면 정작 그 언어 사용자가 읽을 수 없다.
      expect(
        pack.readmeLocales.en,
        `${pack.id}: README.en.md 없음`,
      ).toBeDefined();
      expect(pack.readmeLocales.en).not.toBe(pack.readme);
    }
  });
});

/**
 * 드리프트 가드(이슈 #30에서 `store.test.ts`가 en.json에 걸던 것을 팩 매니페스트로 이관):
 * 번들 en 팩이 ko.json 전 키를 계속 100% 커버하는지 고정한다.
 *
 * 실제 등록 경로(`registerBundledLocale`)가 쓰는 바로 그 함수로 검사해 "등록이 실제로
 * 받아들이는 것"과 "이 가드가 요구하는 것"이 같은 규칙이게 한다.
 */
describe("en 팩이 ko.json 전 키를 계속 커버한다(드리프트 가드)", () => {
  it("entries가 ko.json의 모든 키를 100% 커버한다(플레이스홀더 집합까지 일치)", async () => {
    const pack = await loadBundledPack("en");
    expect(pack).not.toBeNull();
    const { accepted, coverage } = validateLocaleEntries(
      translationOf(pack!.manifest).entries,
      ko as Record<string, string>,
    );
    expect(coverage).toBe(1);
    expect(Object.keys(accepted).length).toBe(Object.keys(ko).length);
  });
});

describe("loadActiveBundledLocale", () => {
  /** 가드(핵심): 활성 상태 맵을 못 읽었으면(null = "모른다") **로드하지 않는다** — 빈 맵으로
   * 폴백하면 사용자가 꺼둔 팩이 실패 경로에서만 되살아나는 fail-open이 된다. */
  it("loads nothing when the enabled-state map is unknown (null)", async () => {
    expect(await loadActiveBundledLocale("en", null)).toBe(false);
  });

  /** 가드: 그 팩이 꺼져 있으면 로드하지 않는다(기록 없음 = 켜짐이라는 계약과 짝). */
  it("skips a pack the user turned off", async () => {
    expect(
      await loadActiveBundledLocale("en", { "language-pack-en": false }),
    ).toBe(false);
  });

  /** 가드: 코드가 일치하는 팩이 없으면(ko·미설치 언어팩 코드) 조용히 false다 — 이 경로에서
   * 어떤 청크도 받지 않는 것이 "활성 로케일만 로드"의 요점이다. */
  it("returns false when no bundled pack matches the language", async () => {
    expect(await loadActiveBundledLocale("ko", {})).toBe(false);
    expect(await loadActiveBundledLocale("zz", {})).toBe(false);
  });

  /**
   * 가드(핵심): 기록이 없으면 켜짐으로 보고 로드·등록하며, 그 결과가 이 창의 로케일
   * 저장소에 실제로 반영된다(드롭다운 후보 + 사전 조회 둘 다).
   *
   * 이 테스트가 이 파일의 마지막 로드 테스트인 이유: 등록은 모듈 싱글턴에 남아 되돌릴 수
   * 없다(store.ts에 해제 export가 없다 — `store.test.ts`와 같은 관례).
   */
  it("registers the matching pack when the state map has no record", async () => {
    expect(await loadActiveBundledLocale("en", {})).toBe(true);
    expect(availableLocales()).toContainEqual({
      code: "en",
      label: "English",
    });
    expect(localeDictionary("en")?.["panel.list.empty"]).toBeDefined();
  });
});

describe("packToBuiltin", () => {
  /** 가드: 설정창 목록이 읽는 필드가 전부 옮겨지고, `code`(샌드박스 소스)는 빈 문자열이다 —
   * 언어팩은 중앙 호스트가 실행하지 않는 데이터 선언이라 실행할 코드가 없다. */
  it("maps the display fields and leaves the sandbox code empty", async () => {
    const pack = await loadBundledPack("en");
    const builtin = packToBuiltin(pack!);
    expect(builtin.id).toBe("language-pack-en");
    expect(builtin.version).toBe(pack!.manifest.version);
    expect(builtin.permissions).toContain("i18n");
    expect(builtin.kind).toBe("capability");
    expect(builtin.code).toBe("");
    expect(builtin.readme).toBe(pack!.readme);
    expect(builtin.readmeLocales?.en).toBe(pack!.readmeLocales.en);
    // `%키%`는 원문 그대로 남는다 — 해석은 소비 지점(renderBuiltinList)이 활성 로케일로 한다
    // (§i18n 규약: 모듈 최상위·데이터 조립 시점 해석 금지).
    expect(builtin.name).toBe("%name%");
    expect(builtin.nls?.default?.name).toBeDefined();
  });
});
