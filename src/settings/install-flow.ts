/**
 * 플러그인 설치 플로우의 순수 로직 — 입력 해석·승인 프롬프트 상태·부여 계산.
 *
 * 역할: 설정 창 설치 UI(URL/git/로컬 + 승인 프롬프트 + 업데이트 확인 + 새 기기 재승인)가
 * 쓰는 판단을 DOM 없이 계산한다: (1) 입력 문자열 → 설치 스펙(https-only·`#ref`·zip 판별),
 * (2) 미리보기 → 승인 화면 모델(신규/업데이트/최신, 새로 추가된 민감 권한 diff),
 * (3) 승인 시 보낼 부여 집합, (4) 권한의 한국어 라벨/설명, (5) 예약 해제 시 재승인
 * 대상 계산, (6) minHostVersion 미달 판정,
 * (7) 매니페스트 자기신고 필드(purpose·llmContext·permissionReasons) 안전 읽기.
 * 왜: 신뢰 모델의 프론트 정책(무엇을 승인받고 무엇을 부여할지)을 가드 테스트로 고정하기
 * 위해 렌더링과 분리한다. 최종 강제는 항상 백엔드(선언∩요청 클램프)가 한다.
 */
import { PERMISSION_RESERVED } from "../plugin/host";
import { isSensitive, type Permission } from "../plugin/permissions";
import type {
  InstalledPlugin,
  InstallPreview,
  InstallSpec,
  PluginSource,
} from "../shared/tauri";
import { t } from "../i18n/t";
import { activeLocale } from "../i18n/store";
import { resolveNlsString } from "../plugin/manifest";

/** 권한 id의 사용자 표시(한국어 라벨 + 무엇을 허용하는지 설명 + 예약(미구현) 여부). */
interface PermissionInfo {
  label: string;
  desc: string;
  /** true면 권한 모델은 인식하지만 대응 브리지 호출이 아직 배선되지 않았다(승인해도 무효과). */
  reserved: boolean;
}

/**
 * `PERMISSION_INFO` 카탈로그 항목 — 라벨·설명의 **i18n 키만** 쥔다(문장 자체가 아니다).
 * [`permissionInfo`]가 `t(labelKey)`/`t(descKey)`로 호출 시점에 해석한다: 이 카탈로그는
 * 모듈 로드 시 한 번만 만들어지는데(파일 상단 `const`), 그 시점은 `setActiveLocale()`
 * (창 부트스트랩)보다 항상 먼저다 — 문장을 여기서 `t()`로 미리 구우면 활성 로케일이
 * 무엇이든 영원히 ko로 굳는다(§i18n 규약).
 */
interface PermissionInfoKeys {
  labelKey: string;
  descKey: string;
}

/**
 * 고정 권한들의 라벨/설명 키(`embed:<domain>`은 동적 — [`permissionInfo`]에서 처리).
 * `reserved` 여부는 여기 적지 않는다 — [`permissionInfo`]가 `PERMISSION_RESERVED`로 판정한다.
 *
 * `Record<Permission, ...>`(exhaustive)로 타입을 강화했다 — `permissions.ts`에 권한을
 * 추가하면 이 객체에 라벨을 채우지 않는 한 **컴파일이 실패한다**. 물리적 위치는 이 파일에
 * 그대로 둔다(설계안은 `permissions.ts`로 이관을 권했지만, `drift-guards.test.ts`(다른 소유)가
 * `readFileSync("src/settings/install-flow.ts")` 뒤 `"const PERMISSION_INFO"` 텍스트 마커로
 * 이 상수를 찾는다 — 물리 이동은 그 가드를 깨뜨린다. exhaustive Record 타입이 이관의
 * 핵심 이득이므로, 타입의 출처(Permission)만 `permissions.ts`에서 가져와 이관 없이 같은
 * 효과를 낸다. 물리 이관을 원하면 가드 테스트 소유자에게 마커를 `permissions.ts`로
 * 옮겨 달라고 먼저 요청할 것 — 요청사항으로 남긴다).
 *
 * 값이 `t(...)`가 아니라 키 문자열인 이유도 그 가드와 얽힌다 — 가드는 이 객체의 **최상위
 * 키**(권한 id)만 정규식으로 뽑으므로 내부 필드명·값의 형태는 자유롭지만, 닫는 줄이 정확히
 * `\n};`여야 한다(가드의 `extractObjectTopLevelKeys`). `PERMISSION_INFO`를 호출형
 * (`() => ({ ... })`)으로 바꾸면 닫는 줄이 `});`가 되어 그 마커가 깨진다 — 그래서 객체
 * 리터럴 형태(`const PERMISSION_INFO: ... = { ... };`)는 그대로 두고, 값만 키로 낮춰
 * 호출 시점 해석을 [`permissionInfo`] 쪽으로 옮긴다.
 */
const PERMISSION_INFO: Record<Permission, PermissionInfoKeys> = {
  commands: {
    labelKey: "settings.install-flow.permission-commands-label",
    descKey: "settings.install-flow.permission-commands-desc",
  },
  ui: {
    labelKey: "settings.install-flow.permission-ui-label",
    descKey: "settings.install-flow.permission-ui-desc",
  },
  editor: {
    labelKey: "settings.install-flow.permission-editor-label",
    descKey: "settings.install-flow.permission-editor-desc",
  },
  settings: {
    labelKey: "settings.install-flow.permission-settings-label",
    descKey: "settings.install-flow.permission-settings-desc",
  },
  // 노트가 아니라 **그 플러그인 자기 데이터**만 담는 저장소다 — 문구가 "노트를 저장한다"로
  // 읽히지 않게 주어를 플러그인으로 못박는다(권한 목록은 사용자가 범위를 가늠하는 유일한 자리다).
  storage: {
    labelKey: "settings.install-flow.permission-storage-label",
    descKey: "settings.install-flow.permission-storage-desc",
  },
  // 이전 문구("모든 노트의 내용을 읽을 수 있어요")는 넓었고, 그 다음 문구("지금 열려
  // 있는 메모의 내용")는 **좁았다**. 이 권한이 여는 것은 브리지 호출 하나가 아니라 둘이다:
  //  (1) `notes.current` — 지금 열린 메모 1건의 본문(전체 본문 열람은 이 권한을
  //      넓히지 않고 별도 권한 `notes:all-read`로 쪼갰다 — 아래 항목),
  //  (2) **호출이 아닌 렌더 시점 게이트** — `host-client.ts`의 `buildExtensionsFromSnapshot`이
  //      이 권한이 있을 때만 `noteTitles`(= 전체 노트 제목 전수)를 플러그인이 등록한 자동완성
  //      팝업에 연결하고, `windows`까지 있으면 그 제목으로 노트를 소환한다(`canOpen`).
  // 승인 화면은 (2)까지 말해야 한다 — 사용자가 보는 문구보다 실제 범위가 넓으면 안 된다.
  "notes:read": {
    labelKey: "settings.install-flow.permission-notes-read-label",
    descKey: "settings.install-flow.permission-notes-read-desc",
  },
  // 이 권한이 여는 것은 `notes.list`(전체 메타)와 `notes.read`(임의 노트 본문)다 —
  // 과소서술이 이 저장소에서 이미 문제였으므로("지금 열려 있는 메모"라던 문구가 실제로는
  // 제목 전수까지 열었다), 숨긴 메모까지 포함된다는 사실을 문구가 그대로 말한다.
  "notes:all-read": {
    labelKey: "settings.install-flow.permission-notes-all-read-label",
    descKey: "settings.install-flow.permission-notes-all-read-desc",
  },
  // 이 권한이 여는 것은 커서 삽입(`editor.insertText`)만이 아니라 **호스트 스코프의 임의 노트
  // 쓰기**(`notes.write`)까지다 — `overwrite` 모드는 지금 열려 있지 않은 노트도 통째로 덮는다
  // (파괴적). 이전 문구("노트 내용을 수정할 수 있어요")는 그 범위와 파괴성을 감췄다. 승인 화면은
  // 사용자가 보는 문구보다 실제 능력이 넓으면 안 되므로(notes:all-read와 같은 원칙), 덮어쓰기가
  // 가능하다는 사실과 그 복구 경로(덮기 전 스냅샷 → 설정 「메모 복구」)를 그대로 말한다.
  "notes:write": {
    labelKey: "settings.install-flow.permission-notes-write-label",
    descKey: "settings.install-flow.permission-notes-write-desc",
  },
  "vault:read": {
    labelKey: "settings.install-flow.permission-vault-read-label",
    descKey: "settings.install-flow.permission-vault-read-desc",
  },
  "vault:write": {
    labelKey: "settings.install-flow.permission-vault-write-label",
    descKey: "settings.install-flow.permission-vault-write-desc",
  },
  clipboard: {
    labelKey: "settings.install-flow.permission-clipboard-label",
    descKey: "settings.install-flow.permission-clipboard-desc",
  },
  windows: {
    labelKey: "settings.install-flow.permission-windows-label",
    descKey: "settings.install-flow.permission-windows-desc",
  },
  "browser:open": {
    labelKey: "settings.install-flow.permission-browser-open-label",
    descKey: "settings.install-flow.permission-browser-open-desc",
  },
  "window-control": {
    labelKey: "settings.install-flow.permission-window-control-label",
    descKey: "settings.install-flow.permission-window-control-desc",
  },
  theme: {
    labelKey: "settings.install-flow.permission-theme-label",
    descKey: "settings.install-flow.permission-theme-desc",
  },
  background: {
    labelKey: "settings.install-flow.permission-background-label",
    descKey: "settings.install-flow.permission-background-desc",
  },
  font: {
    labelKey: "settings.install-flow.permission-font-label",
    descKey: "settings.install-flow.permission-font-desc",
  },
  i18n: {
    labelKey: "settings.install-flow.permission-i18n-label",
    descKey: "settings.install-flow.permission-i18n-desc",
  },
};

/**
 * 권한 id를 한국어 라벨/설명으로 바꾼다.
 *
 * 역할: 승인 프롬프트·권한 목록의 표시 문구 단일 지점. `embed:<domain>`은 도메인을 넣어
 * 동적으로 만들고, 미지의 id는 원문 그대로 보인다(설치는 어차피 매니페스트 검증이 막는다).
 */
export function permissionInfo(permission: string): PermissionInfo {
  const reserved = PERMISSION_RESERVED.has(permission);
  // permission은 신뢰할 수 없는 매니페스트에서 온 원시 문자열이라 Permission 유니온의
  // 부분집합이 아닐 수 있다 — 색인 시점에만 단언하고, 없는 키는 아래 known이 undefined로
  // 걸러진다(exhaustive Record의 타입 안전성은 "값 채움"에 있지 "색인 안전"에 있지 않다).
  const known = PERMISSION_INFO[permission as Permission];
  if (known) {
    return { label: t(known.labelKey), desc: t(known.descKey), reserved };
  }
  if (permission.startsWith("embed:")) {
    const domain = permission.slice("embed:".length);
    return {
      label: t("settings.install-flow.permission-embed-label", { domain }),
      desc: t("settings.install-flow.permission-embed-desc", { domain }),
      reserved,
    };
  }
  // `network:<도메인>`도 embed와 같은 동적 접두 권한이다 — 승인 문구는 **정직하게**
  // 그 호스트로 요청을 보낼 수 있다고 말한다(호스트가 대신 fetch하므로 사용자는 이것이
  // 어디로 나가는지 알아야 한다). 도메인은 매니페스트가 선언한 그대로 보인다.
  if (permission.startsWith("network:")) {
    const domain = permission.slice("network:".length);
    return {
      label: t("settings.install-flow.permission-network-label", { domain }),
      desc: t("settings.install-flow.permission-network-desc", { domain }),
      reserved,
    };
  }
  // `invoke:<대상 pluginId>`도 embed·network와 같은 동적 접두 권한이다 — 승인 문구는
  // 도메인 승인보다 이해가 어려운 지점("플러그인이 다른 플러그인을 부른다")을 정직하게
  // 말한다. 대상의 사람 이름은 이 순수 함수가 알 수 없으므로(설치 목록 조회가 필요) 매니페스트에
  // 선언된 pluginId를 그대로 보인다 — 그래도 사용자는 "어느 플러그인을 부를 수 있는지"를 안다.
  // 대상이 그 명령을 `exposes`로 공개해야만 실제로 실행되므로, 이 승인은 "부를 자격"까지다.
  if (permission.startsWith("invoke:")) {
    const target = permission.slice("invoke:".length);
    return {
      label: t("settings.install-flow.permission-invoke-label", { target }),
      desc: t("settings.install-flow.permission-invoke-desc", { target }),
      reserved,
    };
  }
  return { label: permission, desc: "", reserved };
}

/**
 * 매니페스트 자기신고 필드(`purpose`·`llmContext`·`permissionReasons`)를 신뢰
 * 경계 밖 `unknown` 원천에서 안전하게 좁혀 읽는다.
 *
 * 왜 `unknown`을 받는가: 이 필드들은 백엔드(Rust `PluginManifest`/`InstalledPlugin`)가
 * 이미 JSON으로 실어 보내지만, 그 값을 받는 두 프론트 타입 —
 * `InstallPreview["manifest"]`·`InstalledPlugin`(둘 다 `shared/tauri.ts`, 이 파일이 소유하지
 * 않는 파일) — 은 아직 이 필드를 선언하지 않았다. **`summary`가 정확히 이 모양으로 한 번
 * 사라진 전례**(타입엔 없는데 페이로드엔 있어 IPC 경계에서 조용히 버려짐)와 같은 결함이
 * 지금 이 셋에도 있다 — `preview.manifest.purpose`라고 쓰면 타입 자체가 없어 컴파일이
 * 실패한다. 타입을 넓히는 대신(소유 파일 밖) **런타임에 형태만 확인해 좁혀 읽는 것**으로
 * 값을 소비처(승인 프롬프트·상세 뷰)까지 잇는다 — `previewMinHostVersion`이 이미 쓰는
 * 것과 같은 방어("선언 타입은 있어도 실제 값은 그 약속을 지키지 않을 수 있다")를 "선언
 * 타입 자체가 없는" 한 단계 더 낮은 신뢰까지 확장한 것이다.
 *
 * 자기신고 문자열이라 형식(문자열인가·빈 문자열이 아닌가)만 좁히고 내용은 신뢰하지
 * 않는다 — 렌더 쪽이 반드시 `textContent`로만 꽂아야 한다는 계약은 그대로 유지된다.
 */
function readSelfReportedString(
  source: unknown,
  key: string,
): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const v = (source as Record<string, unknown>)[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed !== "" ? trimmed : undefined;
}

/**
 * 플러그인이 스스로 밝힌 한 줄 목적 설명(`purpose`) — 매니페스트(`InstallPreview.manifest`)
 * 든 설치된 플러그인(`InstalledPlugin`)이든 같은 키라 원천을 가리지 않는다. 소비처:
 * 플러그인 상세 뷰(`settings.ts`의 `detailFromInstalled`).
 */
export function selfReportedPurpose(source: unknown): string | undefined {
  return readSelfReportedString(source, "purpose");
}

/**
 * 플러그인이 AI 에이전트에게 주는 힌트 요약(`llmContext`) — 일반 사용자에겐 부차적이라
 * 상세 뷰의 접힌 개발자 섹션에만 쓴다.
 */
export function selfReportedLlmContext(source: unknown): string | undefined {
  return readSelfReportedString(source, "llmContext");
}

/**
 * 권한별 자기신고 보조 설명(`permissionReasons`) — 승인 프롬프트가 각 권한 행 옆에
 * 병기한다. 값이 문자열이 아닌 항목은 그 항목만 버린다(전체를 거부하지 않는다 — 형식이
 * 하나 어긋났다고 나머지 정상 이유까지 숨길 이유가 없다).
 */
export function selfReportedPermissionReasons(
  source: unknown,
): Record<string, string> {
  if (typeof source !== "object" || source === null) return {};
  const raw = (source as Record<string, unknown>).permissionReasons;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed !== "") out[k] = trimmed;
  }
  return out;
}

/** 입력 해석 결과: 성공(스펙) 또는 실패(사용자에게 보일 한국어 오류). */
type ParsedInstallInput =
  { ok: true; spec: InstallSpec } | { ok: false; error: string };

/**
 * "URL로 설치" 입력 문자열을 설치 스펙으로 해석한다.
 *
 * 규칙: https만 허용. `#` 뒤는 git ref(태그/커밋 — 버전 핀). 경로가 `.zip`으로 끝나면
 * zip 다운로드(url), 아니면 git 저장소로 본다. 최종 검증은 백엔드가 다시 한다(이중화).
 */
export function parseInstallInput(raw: string): ParsedInstallInput {
  const trimmed = raw.trim();
  if (trimmed === "")
    return { ok: false, error: t("settings.install-flow.error-empty-url") };

  const hash = trimmed.indexOf("#");
  const url = hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
  const ref = hash === -1 ? "" : trimmed.slice(hash + 1).trim();

  if (!url.startsWith("https://") || url.length <= "https://".length) {
    return {
      ok: false,
      error: t("settings.install-flow.error-https-only"),
    };
  }
  const path = url.split("?")[0];
  if (path.toLowerCase().endsWith(".zip")) {
    return { ok: true, spec: { kind: "url", location: url } };
  }
  return {
    ok: true,
    spec:
      ref === ""
        ? { kind: "git", location: url }
        : { kind: "git", location: url, git_ref: ref },
  };
}

/** 승인 화면에 표시할 권한 한 줄(라벨·설명·민감 여부·업데이트로 새로 추가됐는지·예약 여부). */
export interface ApprovalPermission {
  id: string;
  label: string;
  desc: string;
  sensitive: boolean;
  /** 업데이트에서 새로 선언된 민감 권한(재승인 필수 강조 대상). */
  added: boolean;
  /** true면 대응 브리지 호출이 아직 배선되지 않았다 — 승인해도 효과가 없다(렌더가 경고 표시). */
  reserved: boolean;
  /**
   * 이 권한에 대한 플러그인의 자기신고 보조 설명(`permissionReasons`, 선택). 없으면
   * 저작자가 그 권한만 이유를 안 적은 것 — 렌더는 있을 때만 병기한다. 자기신고이므로
   * 고정 경고문을 대체하지 않고 **아래에 덧붙이는** 보조 정보로만 다룬다.
   */
  reason?: string;
}

/**
 * semver 문자열의 주.부.수만 뽑는다(프리릴리스·빌드 메타는 무시). 형태가 안 맞으면 null —
 * 자유 형식 버전 문자열에 대한 안전한 폴백 신호.
 */
function parseSemverTriple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 두 버전 문자열을 semver 주.부.수 기준으로 비교한다.
 *
 * 반환: a<b면 음수, a>b면 양수, 같으면 0. 둘 중 하나라도 semver로 안 읽히면 null —
 * 호출부는 null을 "비교 불가"로 보고 다운그레이드 판정을 건너뛰어야 한다(자유 형식 버전은
 * 기존처럼 동등 비교로만 다룬다).
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** 승인 화면 모델: 최신(프롬프트 불필요) 또는 설치/업데이트/다운그레이드(권한 목록 포함). */
export type ApprovalView =
  | { kind: "uptodate"; version: string }
  | {
      /** downgrade: semver로 비교했을 때 설치될 버전이 현재 설치보다 낮다(차단은 안 함 —
       * 되돌리기는 사용자 의도일 수 있다. 호출부가 경고/확인을 추가로 띄우는 근거). */
      kind: "install" | "update" | "downgrade";
      name: string;
      version: string;
      /** 업데이트/다운그레이드일 때 현재 설치된 버전(표시용). */
      fromVersion?: string;
      permissions: ApprovalPermission[];
    };

/**
 * 설치 미리보기를 승인 화면 모델로 바꾼다(신규/업데이트/다운그레이드/최신 판정 + 권한 diff).
 *
 * 규칙: 같은 id가 설치돼 있고 버전이 같으면 "최신"(프롬프트 없이 종료). 설치돼 있고 semver
 * 비교로 설치될 버전이 더 낮으면 "다운그레이드"(경고 대상 — 차단은 아님). 그 외 설치돼
 * 있으면 "업데이트" — 이전 매니페스트에 없던 민감 권한을 `added`로 표시한다(재승인 필수).
 * 버전이 semver로 안 읽히면(자유 형식) 다운그레이드 판정 없이 기존 동등 비교 동작으로
 * 안전하게 폴백한다(항상 "업데이트"로 취급).
 */
export function computeApprovalView(preview: InstallPreview): ApprovalView {
  const { manifest } = preview;
  const installed = preview.installed_version;
  if (installed !== null && installed === manifest.version) {
    return { kind: "uptodate", version: manifest.version };
  }
  const isUpdate = installed !== null;
  const cmp = isUpdate ? compareVersions(manifest.version, installed) : null;
  const isDowngrade = cmp !== null && cmp < 0;
  // 매니페스트가 선언한 권한별 보조 설명(자기신고, 선택) — 승인 프롬프트가 각 권한
  // 행 옆에 병기한다. `manifest`는 `unknown`이 아니라 `InstallPreview["manifest"]`지만 그
  // 타입엔 `permissionReasons`가 없다(readSelfReportedString 문서 참고) — 읽기 함수가
  // 내부에서 다시 `unknown`으로 좁혀 안전하게 꺼낸다.
  const reasons = selfReportedPermissionReasons(manifest);
  const permissions = manifest.permissions.map((id) => {
    const info = permissionInfo(id);
    return {
      id,
      label: info.label,
      desc: info.desc,
      sensitive: isSensitive(id),
      added:
        isUpdate &&
        isSensitive(id) &&
        !preview.installed_permissions.includes(id),
      reserved: info.reserved,
      ...(reasons[id] !== undefined ? { reason: reasons[id] } : {}),
    };
  });
  return {
    kind: isDowngrade ? "downgrade" : isUpdate ? "update" : "install",
    // 축 2(9c9fcc9) 잔여 수정: `manifest.nls`가 있으면 `%키%`를 활성 로케일로 해석한다 —
    // 없으면 `resolveNlsString`이 원문을 그대로 돌려줘 100% 무변화(하위호환). 승인 프롬프트는
    // 설정 창이 이미 `setActiveLocale()`을 마친 뒤에만 열리므로(§i18n 규약) `activeLocale()`이
    // 안정적이다 — `main.ts`의 `listPlugins` 배선과 같은 지점 규칙.
    name: resolveNlsString(
      manifest.name,
      manifest.nls ?? undefined,
      activeLocale(),
    ),
    version: manifest.version,
    ...(isUpdate ? { fromVersion: installed } : {}),
    permissions,
  };
}

/**
 * 승인 시 confirm에 보낼 부여 집합을 계산한다(전체 승인 단순 모델).
 *
 * 규칙: 신규 설치 = 선언된 민감 권한 전부(프롬프트가 보여준 그대로) 중 예약(미구현)이
 * 아닌 것만. 업데이트 = (기존 부여 ∩ 새 선언) ∪ 새로 추가된 민감·비예약 권한 — 사용자가
 * 이전에 끈 권한은 존중하되, 재승인 대상으로 강조된 새 권한은 부여한다. 예약 권한은 효과가
 * 없으므로 자동 부여하지 않는다.
 *
 * 한계(이전엔 이 함수로 못 고쳤음, 지금은 [`pendingReservedForApproval`]로 메운다):
 * `PERMISSION_RESERVED`에서 어떤 권한이 나중에 빠져 "구현됨"으로 바뀌면 — 이미 그 권한을
 * 선언해 둔 설치는 `installed_permissions`에 그 id가 이미 들어 있으므로 `added` diff(새로
 * 선언된 권한만 감지)에 걸리지 않는다. 즉 매니페스트가 그대로면 재승인 프롬프트가 자동으로
 * 뜨지 않고, 부여도 비어 있는 채 남는다(무해 — 게이트키퍼가 선언∩부여로 막으므로 새 능력이
 * 몰래 켜지진 않지만, 사용자가 그 능력을 아예 못 쓰게 된다). 이 함수 자체는 여전히 diff만
 * 본다 — 대신 승인 시점마다 [`pendingReservedForApproval`]로 "지금 예약이라 못 준 권한"을
 * 함께 기억해 두고(Rust `set_pending_reserved`), 부팅 시 [`newlyAvailablePending`]으로
 * "그중 지금은 풀린 것"을 찾아 재승인 배너를 띄운다.
 */
export function grantsForApproval(preview: InstallPreview): string[] {
  const declaredSensitive = preview.manifest.permissions.filter(
    (p) => isSensitive(p) && !PERMISSION_RESERVED.has(p),
  );
  if (preview.installed_version === null) return declaredSensitive;
  const kept = preview.installed_granted.filter((g) =>
    preview.manifest.permissions.includes(g),
  );
  const added = declaredSensitive.filter(
    (p) => !preview.installed_permissions.includes(p),
  );
  return [...new Set([...kept, ...added])];
}

/**
 * 승인 시점에 "선언은 했지만 예약(미구현)이라 부여하지 못하는" 민감 권한 집합을
 * 계산한다.
 *
 * 역할: [`grantsForApproval`]이 제외한 예약 권한을 따로 기억해 둘 값을 만든다 — 호출부가
 * 확정 설치 후 Rust `set_pending_reserved(id, 이 결과)`로 영속화한다. 예약 여부의 정본은
 * `host.ts`의 `PERMISSION_RESERVED`뿐이다(Rust는 이 개념을 모른다 — 그래서 저장은 Rust가,
 * 판정은 항상 TS가 한다).
 */
export function pendingReservedForApproval(preview: InstallPreview): string[] {
  return preview.manifest.permissions.filter(
    (p) => isSensitive(p) && PERMISSION_RESERVED.has(p),
  );
}

/**
 * 저장된 pendingReserved 중 지금은 예약이 풀려 사용 가능해진 권한만 골라낸다.
 *
 * 역할: 부팅 시 이 결과가 비어있지 않으면 설정 창이 "'{라벨}'을 이제 쓸 수 있어요 — 승인이
 * 필요합니다" 행을 띄운다(라벨은 [`permissionInfo`]). 승인하면 이 목록을 기존 grant에 더하고,
 * `pendingReserved`는 (원래 값 ∖ 이 결과)로 다시 저장해 해소된 항목을 뺀다.
 * 왜: Chrome의 optional_permissions처럼 "선언과 부여의 시점 분리"를 예약 해제까지
 * 자동으로 이어 준다 — 사용자가 매니페스트를 다시 설치/업데이트하지 않아도 안내받는다.
 */
export function newlyAvailablePending(pendingReserved: string[]): string[] {
  return pendingReserved.filter((p) => !PERMISSION_RESERVED.has(p));
}

/**
 * 예약이 풀린 권한의 재승인 한 건 — 무엇을 부여하고 무엇을 남길지.
 *
 * export하지 않는다: 호출부는 [`reservedRegrant`]의 반환을 구조 분해로만 쓰고 이 이름을
 * 필요로 하지 않는다(쓰지 않는 export를 만들지 않는다 — knip).
 */
interface ReservedRegrant {
  /** 지금 사용 가능해진(=`PERMISSION_RESERVED`에서 빠진) 권한. 비면 재승인 대상이 아니다. */
  available: string[];
  /** 승인 후 `pendingReserved`에 남길 값(원래 값 ∖ available) — 아직 예약인 것들. */
  remaining: string[];
}

/**
 * 설치된 플러그인 한 건의 예약-해제 재승인 대상을 계산한다(목록 렌더와 승인 처리가
 * 함께 읽는 단일 판정).
 *
 * 역할: 목록은 `available`이 비지 않은 행에만 "권한 승인" 안내를 붙이고, 승인 처리는 같은
 * 값으로 `setGranted(기존 ∪ available)` + `setPendingReserved(remaining)`를 보낸다. 두 곳이
 * 각자 계산하면 "배너는 뜨는데 승인해도 그 권한이 안 켜진다"가 생긴다.
 *
 * **취소는 상태를 건드리지 않는다**(다음 실행에 다시 묻는다) — 모달은 Esc·배경 클릭으로도
 * 닫히므로, 취소를 "영구 거부"로 해석하면 오조작 한 번에 사용자가 그 권한을 다시는 볼 수
 * 없게 된다. 되묻는 비용(행 한 줄)이 잃는 비용보다 싸다.
 *
 * `pendingReserved`(정식 추적 중인 항목)만 본다 — [`newlyAvailablePending`]으로 지금은
 * 예약이 풀린 것을 `available`로, 아직 예약인 것을 `remaining`으로 가른다.
 */
export function reservedRegrant(plugin: InstalledPlugin): ReservedRegrant {
  const pending = plugin.pendingReserved ?? [];
  const available = newlyAvailablePending(pending);
  const availableSet = new Set(available);
  return {
    available,
    remaining: pending.filter((p) => !availableSet.has(p)),
  };
}

/**
 * 매니페스트의 `minHostVersion`이 앱 버전보다 높은지(=설치 불가 수준으로 미달인지)
 * 판정한다.
 *
 * 규칙: `minHostVersion`이 없으면 항상 false(제약 없음). semver로 비교할 수 없으면(자유
 * 형식 버전) false — [`compareVersions`]와 같은 폴백 원칙(비교 불가는 통과로 안전하게
 * 처리, 다운그레이드 판정과 동일 관례).
 * 왜: 앱 버전 정책이 아직 없다(0.1.0) — 그래서 이
 * 함수는 "막아야 하는가"가 아니라 "미달인가"만 답한다. 강제(설치 차단) 여부와 경고 문구는
 * 호출부(설치 UI, 이 담당 밖)가 정책으로 고른다 — 첫 배포는 경고만 하고 강제하지 않는 것을
 * 권장한다.
 */
export function minHostVersionUnmet(
  minHostVersion: string | undefined,
  appVersion: string,
): boolean {
  if (minHostVersion === undefined) return false;
  const cmp = compareVersions(appVersion, minHostVersion);
  return cmp !== null && cmp < 0;
}

/**
 * 미리보기 매니페스트에서 `minHostVersion`을 경계에서 좁혀 꺼낸다(minHostVersion 미달 판정의 입력).
 *
 * 왜 이 함수가 필요한가: 타입은 `InstallPreview["manifest"]`(`shared/tauri.ts`)에 선언돼
 * 있지만 **값은 신뢰 경계 밖**이다(플러그인 폴더 → 백엔드 → IPC). 문자열이 아니거나 빈
 * 문자열이면 `undefined`(=제약 없음)로 본다: 구버전 백엔드·형태가 어긋난 응답이 설치를
 * 막는 쪽으로 기울지 않게 한다(다운그레이드 판정과 같은 안전 폴백).
 */
export function previewMinHostVersion(
  preview: InstallPreview,
): string | undefined {
  // 선언 타입은 `string | undefined`지만 런타임 값은 그 약속을 지키지 않을 수 있다 —
  // unknown으로 받아 실제 형태를 확인하고 통과시킨다.
  const raw: unknown = preview.manifest.minHostVersion;
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/**
 * "이 기기에서 권한 승인 필요" 상태인지 판정한다(새 기기 재승인 안내).
 *
 * 규칙: **부여 가능한**(=예약이 아닌) 민감 권한을 하나라도 선언했는데 로컬 부여가 하나도
 * 없으면 — 동기화로 넘어온 설치(로컬 상태 없음)이거나 아직 승인 전이다. 하나라도 부여했다면
 * 사용자가 이미 이 기기에서 판단한 것으로 본다.
 *
 * 왜 예약을 빼는가: 예약 권한만 선언한 플러그인은 승인해도 부여할 것이 없어 `granted`가
 * 계속 비어 있다 — 판정에 예약을 넣으면 **방금 승인을 마친 행에** "이 기기에서 권한 승인
 * 필요"가 영원히 남는다. 판정과 부여([`grantsForRegrant`])는 같은 필터를 공유해야 한다.
 */
export function needsApproval(plugin: InstalledPlugin): boolean {
  return grantsForRegrant(plugin).length > 0 && plugin.granted.length === 0;
}

/**
 * 새 기기 재승인에서 **실제로 부여할** 민감 권한(예약 제외) — 설치 승인의
 * [`grantsForApproval`]과 **같은 필터**다.
 *
 * 왜: 예전에는 이 자리가 "선언된 민감 권한 전부"였다. 그래서 설치 승인은 예약 정책대로 예약을
 * 보류했는데, 같은 플러그인의 "이 기기에서 권한 승인 필요" 버튼 한 번이 그 보류를 뒤집어
 * 예약 권한을 부여했다(같은 질문에 두 함수가 다르게 답했다). 저작 문서가 약속한
 * "예약은 살아나는 순간 자동으로 부여되지 않는다"가 그 경로로 깨졌다.
 */
export function grantsForRegrant(plugin: InstalledPlugin): string[] {
  return plugin.permissions.filter(
    (p) => isSensitive(p) && !PERMISSION_RESERVED.has(p),
  );
}

/**
 * 재승인 시 "선언됐지만 예약이라 부여 보류"로 기억할 권한 — 설치 승인의
 * [`pendingReservedForApproval`]과 같은 필터다.
 *
 * 왜 재승인에서도 기록하나: 동기화로 넘어온 새 기기에는 `pendingReserved`(로컬 상태)가
 * 없다. 여기서 다시 심어 두지 않으면 나중에 예약이 풀려도 [`newlyAvailablePending`]이 비어
 * 재승인 배너가 **아예 뜨지 않고**, 그 권한은 사용자에게 다시 묻지 않은 채 남는다.
 */
export function pendingReservedForRegrant(plugin: InstalledPlugin): string[] {
  return plugin.permissions.filter(
    (p) => isSensitive(p) && PERMISSION_RESERVED.has(p),
  );
}

/**
 * 설치 출처를 다시 받아올 설치 스펙으로 바꾼다(재조정 [설치]·업데이트 확인).
 *
 * local은 원본 위치가 기록되지 않으므로 null — 호출부가 "코드 없음" 안내를 보인다.
 */
export function specFromSource(source: PluginSource): InstallSpec | null {
  if (source.type === "url") return { kind: "url", location: source.url };
  if (source.type === "git") {
    return source.ref !== undefined
      ? { kind: "git", location: source.url, git_ref: source.ref }
      : { kind: "git", location: source.url };
  }
  return null;
}

/** 설치 출처의 표시 문자열(재조정 행·목록에서 어디서 오는지 보여줌). */
export function describeSource(source: PluginSource): string {
  if (source.type === "url") return source.url;
  if (source.type === "git") {
    return source.ref !== undefined
      ? `${source.url}#${source.ref}`
      : source.url;
  }
  return t("settings.install-flow.source-local");
}
