/**
 * 활성 테마 해석 — 이름(공유 설정) → 실행할 테마 코드/권한(로드 입력).
 *
 * 역할: 활성 테마 이름을 빌트인 테마([`BUILTIN_THEMES`]) 또는 설치된 테마 플러그인
 * (권한 `theme` 선언) 중에서 찾아 로드 입력(code + grant)으로 해석한다. 실행(샌드박스 +
 * 게이트키퍼)은 중앙 호스트([`central-host`])가 하고, 못 찾으면 호스트가 SJ_D로 폴백한다.
 * 왜: "테마도 코드 플러그인"이라는 규칙의 이름→코드/권한 해석을 순수 함수로 유지해
 * 샌드박스 없이 단위 테스트한다.
 */
import { parseManifest } from "../plugin/manifest";
import { BUILTIN_THEMES, type BuiltinTheme } from "../plugin/builtin";
import { baseThemeName } from "./theme";
import type { InstalledPluginSource } from "../plugin/loader";
import type { PluginGrant } from "../plugin/permissions";

/** 활성 테마 로드 입력(샌드박스에서 실행할 코드 + 권한). */
interface ThemeSource {
  code: string;
  grant: PluginGrant;
}

/** 빌트인 테마 목록에서 이름으로 찾는다(없으면 undefined). */
function findBuiltinTheme(name: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === name);
}

/**
 * 활성 테마 이름을 로드 입력(code + grant)으로 해석한다(순수, 테스트용).
 *
 * 규칙: (1) 빌트인 테마 id면 그 코드 + 선언=부여(1st-party) grant. (2) 아니면 설치 소스에서
 * id가 일치하고 `theme`를 선언한 플러그인을 찾아 code + 선언∩부여 grant. (3) 둘 다 아니면
 * null(→ 호출자가 SJ_D 기본으로 대체).
 * 왜: 이름→코드/권한 해석을 순수 함수로 분리해 샌드박스 없이 단위 테스트하고, 설치 테마도
 * 반드시 매니페스트 검증 + 부여 좁히기를 거치게 한다(미선언 권한 차단).
 */
export function resolveThemeSource(
  name: string,
  installedSources: InstalledPluginSource[],
): ThemeSource | null {
  // "{테마}<custom>" 파생 변형은 베이스 테마 코드로 로드한다(색 오버라이드는 적용 말단에서 얹음).
  const base = baseThemeName(name);
  const builtin = findBuiltinTheme(base);
  if (builtin) {
    // 1st-party 번들 테마: 선언 = 부여(사이드로드가 아니므로 별도 부여 흐름 없음).
    return {
      code: builtin.code,
      grant: { declared: builtin.permissions, granted: builtin.permissions },
    };
  }

  for (const source of installedSources) {
    const parsed = parseManifest(source.manifest);
    if (!parsed.ok) continue;
    if (parsed.manifest.id !== base) continue;
    if (!parsed.manifest.permissions.includes("theme")) continue;
    const declared = parsed.manifest.permissions;
    return {
      code: source.code,
      grant: {
        declared,
        granted: source.granted.filter((g) => declared.includes(g)),
      },
    };
  }

  return null;
}
