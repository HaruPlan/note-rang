/**
 * 번들(1st-party) 플러그인·테마의 공용 형(型) — `plugins/`·`themes/`의 각 모듈이
 * 이 인터페이스로 자신을 한 건씩 export하고, [`../builtin`](index)이 순서대로 병합한다.
 */
import type { PluginSettingField } from "../../shared/tauri";
import type { PluginContributions, PluginKind } from "../manifest";

/** 번들(1st-party) 비-테마 플러그인 한 건(매니저 표시 + 중앙 호스트 실행의 단일 출처). */
export interface BuiltinPlugin {
  id: string;
  name: string;
  version: string;
  /** 한 줄 요약(선택 — 목록 부제. 없으면 렌더가 README 첫 줄에서 파생). */
  summary?: string;
  /**
   * 매니페스트가 선언한 종류 — 능력 등록 게이트의 입력. 번들 20개는 전부 이 필드를
   * 적고 있으므로, 여기서 끊기면 **도그푸딩 경로만 게이트를 빠져나간다**(외부 플러그인은
   * 막히는데 번들은 안 막히는 비대칭). 미선언이면 없음 → 게이트 미적용(하위호환).
   */
  kind?: PluginKind;
  /** 매니페스트가 선언한 권한(1st-party라 선언 = 부여). */
  permissions: string[];
  /** 지원 OS 목록(선택 — 없으면 전 플랫폼). 미지원 OS에서는 자동 비활성화된다. */
  platforms?: string[];
  /** 샌드박스에서 eval되는 코드. */
  code: string;
  /** 사용법 문서(마크다운) — 설정창 상세 뷰가 표시한다(요약·사용법·권한·설정 설명). */
  readme: string;
  /** 선언형 설정 스키마(선택 — 있으면 매니저에 ⚙ 폼을 노출, 값은 기기 로컬로 영속화). */
  settings?: PluginSettingField[];
  /** 설정 트리에서 이 플러그인의 설정 페이지를 묶을 카테고리(선택 — 없으면 기본 그룹). */
  settingsCategory?: string;
  /** 설정 페이지 상단에 보일 소개 문구(선택 — 페이지 제목 아래 설명). */
  settingsDescription?: string;
  /**
   * 선언형 기여(선택). 번들도 외부 플러그인과 **같은 경로**로 이 필드를 읽어야
   * 도그푸딩이 성립한다: 여기서 떨어뜨리면 "JSON만으로 되는 플러그인"이 사이드로드에서만
   * 되고 번들에서는 안 되는 비대칭이 생긴다.
   */
  contributes?: PluginContributions;
  /**
   * 다른 플러그인에 공개할 명령 id들(선택). `contributes`·`kind`와 같은 이유로 번들도
   * 이 필드를 읽어야 `commands.invoke`의 공개 판정이 사이드로드와 대칭이 된다.
   */
  exposes?: string[];
  /**
   * 저작자 자기 로컬라이즈 사전(축 2, 선택) — 설치 플러그인의 매니페스트 `nls`와 완전히 같은
   * 형태(로케일 코드 또는 `"default"` → {키→문장})다. 번들도 외부 플러그인과 **같은 메커니즘**
   * 으로 자기 문자열을 소유해야 도그푸딩이 성립한다(`contributes`·`exposes`와 같은 이유) —
   * 여기서 떨어뜨리면 번들만 `%키%`가 해석되지 않고 그대로 노출된다. 해석은 원문을 그대로
   * 들고 있다가 **소비 지점**(`resolveBuiltinPluginNls`, settings.ts의 번들 목록·설정 페이지
   * 렌더)에서 활성 로케일로 이뤄진다 — 모듈 최상위(`import.meta.glob` eager 평가 시점)는
   * 로케일을 아직 모르므로 여기서는 절대 미리 해석하지 않는다.
   */
  nls?: Record<string, Record<string, string>>;
  /**
   * `README.<locale>.md` 변형(축 2, 선택) — 로케일 코드 → 그 README 원문. 기본 로케일
   * (`README.md`)은 위 `readme` 필드가 정본이라 여기 다시 담지 않는다(중복 방지). 폴더에
   * 로케일 변형이 없으면 빈 객체 — `pickBuiltinReadme`가 항상 `readme`로 폴백한다.
   */
  readmeLocales?: Record<string, string>;
}

/**
 * 빌트인 테마 플러그인 한 건(매니페스트 + 테마 코드).
 *
 * 역할: 테마도 다른 플러그인과 동일하게 매니페스트(권한 `theme` 선언) + 샌드박스에서
 * 실행되는 코드로 표현한다. 코드는 `memo.theme.register(...)`만 호출한다.
 * 왜: 테마를 1급 코드 플러그인으로 만들어 사이드로드 테마 플러그인과 같은 보안 경로를 쓴다.
 */
export interface BuiltinTheme {
  id: string;
  name: string;
  version: string;
  /** 한 줄 요약(선택 — 목록 부제. 없으면 렌더가 README 첫 줄에서 파생). */
  summary?: string;
  /** 항상 `["theme"]` — 테마 등록만 하는 저위험 권한. */
  permissions: string[];
  /** 샌드박스에서 eval되는 코드(`memo.theme.register(...)` 호출). */
  code: string;
  /** 테마 설명 문서(마크다운) — 어떤 룩인지 + 배경 스와치 유무. */
  readme: string;
  /** 저작자 자기 로컬라이즈 사전(축 2, 선택) — [`BuiltinPlugin.nls`]와 같은 형태·규칙. */
  nls?: Record<string, Record<string, string>>;
  /** `README.<locale>.md` 변형(축 2, 선택) — [`BuiltinPlugin.readmeLocales`]와 같은 규칙. */
  readmeLocales?: Record<string, string>;
}
