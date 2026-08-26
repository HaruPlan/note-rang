/**
 * 플러그인 권한 모델 + 게이트키퍼.
 *
 * 역할: 권한을 저위험/민감으로 분류하고 "선언 + (민감이면)로컬 부여" 규칙으로 특권
 * 행사를 허용/차단한다. 호스트는 모든 브리지 호출을 이 게이트키퍼로 검사한 뒤에만 실행한다.
 * 왜: 격리 샌드박스의 보안을 실질화 — 미선언/미부여 권한을 한 지점에서 확실히 막는다.
 */

/** 구조화 API로 제공되는 저위험 권한(선언만으로 허용). */
const LOW_RISK_PERMISSIONS = [
  "commands",
  "ui",
  "editor",
  "settings",
  // 플러그인 전용 저장소(`memo.storage.local/session/window.*`). 노트 데이터가 아니라
  // **그 플러그인 자기 데이터**만 담으므로 저위험이다(선언만으로 통과, 승인 마찰 없음).
  // 그럼에도 권한을 두는 이유: 권한 목록이 곧 "이 플러그인이 뭘 하는지"의 요약이고, 디스크에
  // 쓰는 능력은 그 요약에 드러나는 편이 낫다. 이름은 Obsidian·Chrome·Raycast가 전부 `storage`라
  // 저작자·AI의 사전지식과 맞는다(결정 (a)안).
  "storage",
  "theme",
  "background",
  "font",
  // 창 컨트롤 "능력" 등록(투명도·항상 위·모든 데스크탑 컨트롤 제공 선언). 실제 특권 창 제어는
  // 네이티브 노트 창이 수행하므로, 능력 선언 자체는 저위험(배경·폰트 능력과 동급).
  "window-control",
  // 언어팩 선언(`contributes.translations`). 담기는 것이 UI 문자열 사전뿐이고 노트
  // 데이터·시스템 자원에 닿지 않으므로 theme/background/font와 동급 저위험이다.
  //
  // 대응하는 브리지 호출이 없는 유일한 권한이다(언어팩은 코어가 매니페스트에서 직접 읽는
  // 데이터라 런타임 등록 API가 없다) — 그래도 권한으로 남는 이유는 셋이다: 코어의 수집
  // 게이트(`plugin_i18n.rs`)가 이 선언을 요구하고, 설정 창이 이 권한으로 플러그인의 언어
  // 카테고리를 추론하며, 설치 승인 화면이 "이 플러그인은 UI 언어를 공급합니다"를 사용자에게
  // 보여 준다.
  "i18n",
] as const;

/** 민감 권한(선언 + 로컬 부여 필요). `embed:<domain>`·`network:<domain>`은 접두 매칭으로 별도 처리. */
const SENSITIVE_EXACT = [
  "notes:read",
  // 전체 노트 컬렉션 **읽기**(`notes.list`/`notes.read`). `notes:read`(현재 노트 +
  // 제목 목록)를 넓히지 않고 새 권한으로 쪼갠 이유: 이미 `notes:read`를 승인한 사용자의
  // 승인 의미를 소급 확대하는 것은 「선언∩승인」 원칙에서 가장 하면 안 되는 종류의 변경이다
  // (채택안 (b)+(c)). 쓰기(`notes.write`)는 계속 예약 —
  // memo에 undo/백업 인프라가 없어 오사용이 곧 복구 불가 데이터 손실이다.
  "notes:all-read",
  "notes:write",
  "vault:read",
  "vault:write",
  // 네트워크는 `network:<도메인>` **접두 매칭** 민감 권한이다(`embed:<도메인>`과 같은
  // 결) — 바 `network` 하나가 아니라 도메인별로 쪼갠다. 이유: 호스트가 플러그인을 대신
  // fetch하므로 승인의 단위가 "네트워크 일반"이면 사용자가 어디로 나가는지 알 수 없다.
  // 정확 호스트 매칭(`network:api.example.com`)이라 선언한 도메인 밖으로는 못 나간다.
  // 그래서 바 `network`는 SENSITIVE_EXACT에서 빠졌다(아래 [`isSensitive`]가 접두로 판정).
  "clipboard",
  "windows",
  // 링크를 시스템 기본 브라우저로 여는 권한(`memo.browser.open` + 인라인 패턴의
  // `action: "open-url"`). 민감인 이유: 앱 밖으로 사용자를 데리고 나가는 동작이고, 열리는
  // 주소는 대개 노트 본문에서 온다 — 어떤 주소가 나갈지 승인 시점에 열거할 수 없다.
  // 그래서 `network:<도메인>`·`embed:<도메인>`처럼 도메인별로 쪼개지 않았다: 본문에 적힌
  // 임의의 URL을 여는 것이 이 권한의 용도라 도메인 목록은 거짓 정밀도가 된다. 대신 스킴을
  // 백엔드가 http·https·mailto로 좁힌다(`open_external_url` — 실행 스킴은 못 나간다).
  "browser:open",
] as const;

/** 고정(embed 제외) 권한 id의 유니온 — `PERMISSION_INFO`를 `Record<Permission, ...>`로
 * exhaustive하게 강제하는 데 쓴다(권한을 추가했는데 문구를 안 채우면 컴파일이 실패한다).
 * `embed:<domain>`은 동적이라 이 유니온에 없다(런타임 판정은 [`isSensitive`]가 접두 매칭). */
export type Permission =
  (typeof LOW_RISK_PERMISSIONS)[number] | (typeof SENSITIVE_EXACT)[number];

/** 권한 문자열이 민감 권한인지(민감 목록 또는 `embed:`·`network:`·`invoke:` 접두). */
export function isSensitive(permission: string): boolean {
  return (
    (SENSITIVE_EXACT as readonly string[]).includes(permission) ||
    permission.startsWith("embed:") ||
    permission.startsWith("network:") ||
    // 플러그인 간 호출은 `invoke:<대상 pluginId>` **접두 매칭** 민감 권한이다
    // (`network:<도메인>`과 같은 결) — 바 `invoke` 하나가 아니라 대상별로 쪼갠다. 이유:
    // 호출측이 대상 플러그인의 명령을 실행하게 되므로 승인의 단위가 "다른 플러그인 일반"이면
    // 사용자가 무엇을 부르는지 알 수 없다. 정확 id 매칭(`invoke:copy-ai-prompt`)이라 선언한
    // 대상 밖으로는 부를 수 없다. 그래서 바 `invoke`는 SENSITIVE_EXACT에 넣지 않는다.
    permission.startsWith("invoke:")
  );
}

/** 우리가 아는 권한인지(저위험·민감·embed). 매니페스트 검증에 사용. */
export function isKnownPermission(permission: string): boolean {
  return (
    (LOW_RISK_PERMISSIONS as readonly string[]).includes(permission) ||
    isSensitive(permission)
  );
}

/** 플러그인의 권한 상태: 선언(manifest)과 로컬 부여(granted)는 별개다. */
export interface PluginGrant {
  /** manifest.permissions — 플러그인이 요구한다고 선언한 권한. */
  declared: string[];
  /** 로컬에서 사용자가 승인한 권한(동기화 파일이 아니라 기기 기준). */
  granted: string[];
}

/** 권한 검사 결과(거부 시 사유 포함). */
interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 플러그인이 `required` 권한을 행사할 수 있는지 판정한다.
 *
 * 규칙: 알 수 없는 권한 → 거부. 미선언 → 거부. 민감인데 미부여 → 거부.
 * 저위험은 선언만으로, 민감은 선언 + 부여가 모두 있어야 허용. 부여는 로컬 기준이라
 * 동기화 파일을 변조해도 로컬 미승인이면 차단된다.
 */
export function checkPermission(
  grant: PluginGrant,
  required: string,
): PermissionDecision {
  if (!isKnownPermission(required)) {
    return { allowed: false, reason: `알 수 없는 권한: ${required}` };
  }
  if (!grant.declared.includes(required)) {
    return { allowed: false, reason: `미선언 권한: ${required}` };
  }
  if (isSensitive(required) && !grant.granted.includes(required)) {
    return { allowed: false, reason: `미승인 권한: ${required}` };
  }
  return { allowed: true };
}

/**
 * 권한 → 그 권한이 게이트하는 브리지 호출 이름 역인덱스.
 *
 * 역할: "이 권한으로 가능한 동작"을 승인 화면에 나열하기 위한 순수 변환. `callPermissions`는
 * 호출부가 주입한다(`host.ts`의 `CALL_PERMISSIONS`) — 이 파일이 직접 가져오지 않는 이유는
 * `host.ts`가 이미 `permissions.ts`를 임포트하므로 반대 방향 임포트는 순환 참조가 되기
 * 때문이다(단일 관문 원칙 — host.ts가 permissions.ts를 참조하는 방향만 존재해야 한다).
 * 왜: 호출은 늘어나는데 권한→호출 매핑을 승인 화면이 손으로 다시 나열하면 드리프트가
 * 재발한다 — CALL_PERMISSIONS 자체를 뒤집으면 항상 최신이다.
 */
export function permissionToCalls(
  callPermissions: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [call, permission] of Object.entries(callPermissions)) {
    (out[permission] ??= []).push(call);
  }
  for (const calls of Object.values(out)) calls.sort();
  return out;
}
