/**
 * memo-plugin CLI — `lint <dir>`: 정적으로 잡을 수 있는 저작 실수를 찾는다.
 *
 * 검사 목록(절 표와 1:1):
 *  - 없어진 호출(계약이 바뀌어 사라진 옛 이름) — `contract.removedCallHint`
 *  - 존재하지 않는 호출(오타·미구현 API) — `contract.isKnownCall`
 *  - 예약 호출 사용 — `contract.isReservedCall`
 *  - `kind: "action"`인데 능력 등록을 부르는 것 — `contract.capabilityCalls`
 *  - 미선언 권한이 필요한 호출 — `contract.requiredPermissionFor` + manifest.permissions
 *  - 인자 2개 이상 호출 — 부트스트랩 1-인자 규칙, scan.ts의 `argCount`
 *  - `.catch` 없는 최상위 프라미스 체인 — scan.ts의 체인 추적(불확실하면 스킵, catch 핸들러
 *    본문 안의 **무권한 진단 호출**(`memo.runtime.*`)만 스킵 — 실패해도 잃을 것이 없는
 *    호출에만 면제를 준다)
 *  - 설정 스키마에 없는 키를 `settings.get`으로 읽는 것 — 정적 문자열 리터럴 키만
 *  - 선언했으나 한 번도 안 쓴 권한 — `contract.permissionToCalls` 역인덱스 재사용
 *  - **렌더 시점 게이트 권한**을 선언하지 않은 등록 — [`RENDER_GATE_PERMISSIONS`]와
 *    `embedTemplate`의 `embed:<도메인>`(호출은 성공하는데 렌더가 조용히 취소되는 부류)
 *  - 툴바 버튼의 등록 계약 — `onClick` 없는 등록(런타임이 `INVALID_ARGS`로 거부)과
 *    같은 파일 안 정적 `id` 중복(뒤엣것이 앞엣것을 치환해 버튼 하나가 사라진다)
 *  - 명령의 등록 계약 — `run`·`title` 없는 등록, 그리고 `when`의 닫힌 키 어휘를
 *    **호스트의 실물 파서**로 판정(모르는 키는 런타임에 거부돼 명령이 통째로 사라진다)
 *  - 매니페스트 선언형 기여 — 모르는 기여 종류(호스트는 무시하므로 여기서 안 잡으면
 *    영영 아무도 못 잡는다), 기여가 요구하는 권한·`kind` 선언, 그리고 항목 형식을
 *    **호스트의 실물 registrar로 실제 등록해 보며** 확인
 *
 * 전부 **정적** 검사다: 등록 마감 타이밍이나 창 컨텍스트 전파 같은 실행 의미론은 재현하지
 * 않는다(헤드리스 하니스의 몫 — 스스로 밝히는 한계).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HostContract, ParsedPluginManifest } from "./host-bridge.ts";
import type { Finding } from "./types.ts";
import { runValidate } from "./validate.ts";
import { findMemoCallSites, lineColOf } from "./scan.ts";

/** `memo.settings.get(...)`의 인자 텍스트에서 정적 문자열 키를 뽑는다. **객체형만** 인식한다
 * (`{key: "key", ...}`) — 문자열 축약형(`get("key")`)은 런타임이 `INVALID_ARGS`로 거부하는
 * 무효 형태라 여기서도 키를 뽑지 않는다. 변수·템플릿 리터럴처럼 동적인 키는 정적으로
 * 판단할 수 없으므로 null(검사 대상에서 제외). */
/**
 * **호출이 아니라 렌더 시점에** 권한이 필요한 등록 — 그 등록을 쓰면 이 권한들도 "쓴 것"이다.
 *
 * 왜 필요한가: `UNUSED_PERMISSION`은 `CALL_PERMISSIONS`(브리지 호출→권한) 역인덱스만 본다.
 * 그런데 `notes:read`·`windows`는 브리지 호출뿐 아니라 **에디터 서비스 연결**도 게이트한다
 * (`host-client.ts`의 `buildExtensionsFromSnapshot`: `canRead`가 false면 `noteTitles`가
 * 빈 목록으로 무력화되고, `canOpen = windows && canRead`라 위키링크 클릭 이동도 죽는다).
 * 그 경로는 호출이 아니라 정적 역인덱스에 영영 안 잡히므로, 이 표가 없으면 도구가
 * "자동완성 후보를 받으려면 notes:read가 필요하다"는 문서와 **정반대**를 권하게 된다 —
 * 그 권고를 따르면 팝업은 뜨는데 후보가 영원히 0개인 무음 실패가 된다(없앤 실패 모드).
 *
 * `required`는 **반대 방향**(권한을 선언하지 않은 채 이 등록을 쓰는 것)까지 진단할지다.
 * kind 게이트를 정적으로 앞당긴 것과 같은 이유로 필요하다 — 그게 없으면 런타임에서
 * 100% 무력화되는 플러그인이 「오류 0건, 경고 0건」을 받는다. 다만 오탐이 없는 것에만 켠다:
 *  - `registerCompletion`: 후보 원천이 노트 제목 하나뿐이라 `notes:read`가 없으면 팝업이
 *    **항상** 비어 있다 → 켠다.
 *  - `registerInlinePattern`: 스타일만 입히는 등록이 정상 용례라(클릭 이동을 안 쓰는 패턴)
 *    없다고 경고하면 오탐이다 → 끈다. 대신 이 표에 남겨 `UNUSED_PERMISSION` 오탐만 막는다.
 */
const RENDER_GATE_PERMISSIONS: Readonly<
  Record<string, { permissions: readonly string[]; required: boolean }>
> = {
  // 후보 원천이 노트 제목뿐이라 notes:read 없이는 팝업이 항상 비어 있다.
  "editor.registerCompletion": { permissions: ["notes:read"], required: true },
  // 패턴 클릭 게이트: `action: "open-note"`(기본)는 notes:read + windows, `action: "open-url"`은
  // browser:open이다. 셋을 한 표에 두는 이유 — 이 표는 `UNUSED_PERMISSION` 오탐만 막고
  // (required:false) 어느 동작을 쓰는지는 정적으로 알 수 없다. 셋 중 무엇을 선언했든 인라인
  // 패턴 등록이 그 권한의 용처가 된다.
  "editor.registerInlinePattern": {
    permissions: ["notes:read", "windows", "browser:open"],
    required: false,
  },
  // 메뉴 항목의 `run`이 받는 `payload.selectedText`는 **payload 단위 `notes:read`
  // 게이트**다 — 부여됐을 때만 호스트가 선택 텍스트를 채운다(선택 텍스트는 노트 본문의
  // 일부). required:false인 이유: 선택 텍스트 없이도 메뉴 항목은 정상 동작하므로(단지
  // payload가 비는 것뿐) notes:read는 선택이다. 이 표에 있어야 「선택 텍스트를 쓰려고
  // notes:read를 선언한」 플러그인이 UNUSED_PERMISSION 오탐을 받지 않는다.
  "ui.addMenuItem": { permissions: ["notes:read"], required: false },
  // 선택 액션의 `payload.selectedText`도 **메뉴 항목과 글자 그대로 같은** payload 단위
  // `notes:read` 게이트다(required:false인 이유도 같다 — 선택 텍스트 없이도 버튼은 뜨고
  // 눌린다). 이 표에 있어야 「선택 텍스트를 쓰려고 notes:read를 선언한」 플러그인이
  // UNUSED_PERMISSION 오탐을 받지 않는다.
  "ui.addSelectionAction": { permissions: ["notes:read"], required: false },
};

/**
 * `memo.editor.registerBlockEmbed(...)`의 인자 텍스트에서 **정적** `embedTemplate`의 호스트를
 * 뽑는다(리터럴이 아니면 null — 정적으로 판단할 수 없는 것은 건드리지 않는다).
 *
 * 왜: 임베드는 등록이 성공해도 렌더 직전에 `embed:<도메인>` 권한으로 한 번 더 게이트된다
 * (`embed.ts`의 `if (!allowDomain(url.hostname)) return null`). 그 취소는 조용해서 오류도
 * 진단도 남지 않으므로, 선언 누락은 여기서 잡지 않으면 영영 아무도 못 잡는다.
 */
function extractEmbedTemplateHost(argsText: string): string | null {
  const m = /embedTemplate\s*:\s*["'](https:\/\/[^"'\s]+)["']/.exec(argsText);
  if (!m) return null;
  try {
    return new URL(m[1].replace("{id}", "probe")).hostname;
  } catch {
    return null;
  }
}

/**
 * `memo.ui.addToolbarButton(...)`의 인자 텍스트에서 **정적** `id` 리터럴을 뽑는다.
 *
 * 비었거나(`id: ""`) 동적이면 null — 호스트가 안정 id를 만들어 주므로 중복 판정 대상이
 * 아니다. 판정은 리터럴로 적힌 것들 사이에서만 한다(추측하지 않는다).
 */
function extractToolbarButtonId(argsText: string): string | null {
  // `//` 줄 주석을 먼저 지운다: `id:`는 **앞이 `{`나 `,`일 때만** 인정하는데, 주석 한 줄이
  // 사이에 끼면 그 조건이 깨져 "id를 못 읽었다"가 된다. 잘 주석 단 코드일수록 검사가
  // 헐거워지는 것은 명백한 결함이다(정본 예제에서 실제로 걸렸다).
  const stripped = argsText
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const m = /(?:^|[{,])\s*id\s*:\s*["']([^"']+)["']/.exec(stripped);
  return m ? m[1]! : null;
}

/**
 * `memo.commands.register(...)`의 인자 텍스트에서 **정적** `when` 배열을 뽑는다.
 *
 * 문자열 리터럴만 있는 배열일 때만 판정한다 — 변수·전개가 섞이면 null(추측하지 않는다).
 * 왜 정적으로 보나: 모르는 키는 런타임에 `INVALID_ARGS`로 거부돼 그 명령이 통째로 등록되지
 * 않는데, 그 거부는 진단 채널에만 남는다(단축키 화면에는 그냥 안 나타난다). 오타 하나가
 * "등록했는데 아무 데도 없다"로 나타나므로 앱을 띄우기 전에 잡을 값어치가 크다.
 */
function extractWhenKeys(argsText: string): string[] | null {
  const m = /(?:^|[{,])\s*when\s*:\s*\[([^\]]*)\]/.exec(argsText);
  if (!m) return null;
  const inner = m[1]!.trim();
  if (inner === "") return [];
  const parts = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const keys: string[] = [];
  for (const part of parts) {
    const lit = /^["']([^"']*)["']$/.exec(part);
    if (!lit) return null; // 동적 항목이 섞였다 — 배열 전체를 판정하지 않는다.
    keys.push(lit[1]!);
  }
  return keys;
}

/**
 * `memo.events.on(...)`의 인자 텍스트에서 **정적** `name` 리터럴을 뽑는다.
 *
 * 변수·표현식이면 null(추측하지 않는다). 주석은 먼저 걷어낸다 — 주석 안의 예시 이름이
 * 진짜 인자로 오인되면 오탐이 나고, 오탐은 미탐보다 나쁘다.
 */
function extractEventName(argsText: string): string | null {
  const stripped = argsText
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const m = /(?:^|[{,])\s*name\s*:\s*["']([^"']+)["']/.exec(stripped);
  return m ? m[1]! : null;
}

/**
 * `memo.network.fetch(...)`의 인자 텍스트에서 **정적** `url` 호스트를 뽑는다.
 *
 * 왜: network.fetch가 게이트하는 권한은 URL 호스트에서 파생한 `network:<호스트>`라, 그 호스트를
 * 정적으로 알 수 있을 때만 "권한 선언 누락"을 판정할 수 있다(`embed:<도메인>`과 같은 결).
 * 리터럴 https URL이 아니면 null — 동적 URL은 어떤 호스트 권한이 필요한지 정적으로 알 수 없다
 * (추측하지 않는다). **주석은 걷어내지 않는다**: URL 자체가 `//`(https://)를 포함해 순진한 줄
 * 주석 제거가 URL을 통째로 잘라 버린다(`extractEmbedTemplateHost`와 같은 이유로 리터럴을
 * 직접 매칭한다).
 */
function extractNetworkFetchUrlHost(argsText: string): string | null {
  const m = /(?:^|[{,])\s*url\s*:\s*["'](https:\/\/[^"'\s]+)["']/.exec(
    argsText,
  );
  if (!m) return null;
  try {
    return new URL(m[1]!).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * `memo.commands.invoke(...)`의 인자 텍스트에서 **정적** `pluginId` 리터럴을 뽑는다.
 *
 * 왜: commands.invoke가 게이트하는 권한은 대상 id에서 파생한 `invoke:<대상>`이라, 그 id를
 * 정적으로 알 수 있을 때만 "권한 선언 누락"을 판정할 수 있다(`network:<호스트>`와 같은 결).
 * 리터럴이 아니면 null — 동적 id는 어떤 대상 권한이 필요한지 정적으로 알 수 없다(추측하지
 * 않는다). 주석은 걷어낸다(예시 id가 진짜 인자로 오인되면 오탐).
 */
function extractInvokeTargetId(argsText: string): string | null {
  const stripped = argsText
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const m = /(?:^|[{,])\s*pluginId\s*:\s*["']([^"']+)["']/.exec(stripped);
  return m ? m[1]! : null;
}

function extractSettingsGetKey(argsText: string): string | null {
  const trimmed = argsText.trim();
  const inObject = /(?:^|[{,])\s*key\s*:\s*["']([^"']+)["']/.exec(trimmed);
  if (inObject) return inObject[1]!;
  return null;
}

/**
 * 매니페스트 `contributes`를 호스트와 **같은 규칙**으로 검사한다.
 *
 * 넷을 본다: (1) 모르는 기여 종류(오타 — 호스트는 무시하므로 여기서 안 잡으면 영영 아무도
 * 못 잡는다), (2) 그 기여가 요구하는 권한 선언, (3) 능력 기여의 `kind` 게이트,
 * (4) 항목 하나하나의 형식(호스트의 실물 registrar로 실제 등록해 본다).
 * (2)는 `usedPermissions`에도 더한다 — 안 그러면 `main.js` 없이 JSON만 쓴 플러그인이
 * "선언했는데 안 쓴 권한"이라는 정반대 경고를 받는다.
 *
 * 기여는 두 갈래다. **브리지 호출로 되돌아가는 것**(`contributionCalls`)은 그 호출을 실제로
 * 게이트·registrar에 태워 넷을 전부 본다. **코어가 직접 읽는 것**(`coreContributionPermissions`
 * — 지금은 언어팩)은 태울 호출이 없으므로 (2)(3)만 본다: 권한 선언과 `kind: "capability"`.
 * 그 둘이 곧 코어(`plugin_i18n.rs`의 `may_contribute_translations`)가 수집 시점에 요구하는
 * 조건이고, 어긋나면 "설치는 됐는데 언어가 목록에 안 뜬다"는 무음 실패가 된다. 항목 형식(4)은
 * 코어가 항목 단위로 조용히 건너뛰므로 여기서 재현하지 않는다 — 그 규칙의 정본은 Rust다.
 */
async function lintContributes(
  manifest: ParsedPluginManifest,
  declaredPermissions: ReadonlySet<string>,
  usedPermissions: Set<string>,
  contract: HostContract,
  findings: Finding[],
): Promise<void> {
  const contributes = manifest.contributes;
  if (!contributes) return;
  for (const kind of contributes.unknownKinds ?? []) {
    findings.push({
      severity: "error",
      code: "UNKNOWN_CONTRIBUTION",
      message: `contributes.${kind}는 모르는 기여 종류 — 매니페스트는 통과하지만 호스트가 무시해 아무것도 등록되지 않는다(가능한 값: ${contract.contributionKinds.join(", ")})`,
      file: "manifest.json",
    });
  }
  // 코어가 직접 읽는 기여(언어팩) — 태울 브리지 호출이 없어 게이트만 재현한다.
  for (const [kind, required] of Object.entries(
    contract.coreContributionPermissions,
  )) {
    const raw = (contributes as Record<string, unknown>)[kind];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    usedPermissions.add(required);
    if (!declaredPermissions.has(required)) {
      findings.push({
        severity: "error",
        code: "PERMISSION_UNDECLARED",
        message: `contributes.${kind}는 권한 '${required}'이 manifest.permissions에 필요함 — 코어가 이 선언을 읽을 때 같은 게이트를 걸어, 없으면 아무 오류 없이 그냥 수집되지 않는다`,
        file: "manifest.json",
      });
    }
    if (manifest.kind !== "capability") {
      findings.push({
        severity: "error",
        code: "WRONG_PLUGIN_KIND",
        message: `contributes.${kind}는 능력 선언이라 kind: "capability"가 필요함 — 지금 매니페스트는 ${manifest.kind === undefined ? "kind 미선언" : `kind: "${manifest.kind}"`}이라 코어가 이 기여를 조용히 건너뛴다`,
        file: "manifest.json",
      });
    }
  }
  const registrar = contract.makeRegistrar(manifest.id);
  for (const [kind, call] of Object.entries(contract.contributionCalls)) {
    const raw = (contributes as Record<string, unknown>)[kind];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const required = contract.requiredPermissionFor(call);
    if (required !== null) {
      usedPermissions.add(required);
      if (!declaredPermissions.has(required)) {
        findings.push({
          severity: "error",
          code: "PERMISSION_UNDECLARED",
          message: `contributes.${kind}는 memo.${call}(...)과 같은 게이트를 타므로 권한 '${required}'이 manifest.permissions에 필요함 — 선언형이라고 게이트를 건너뛰지 않는다`,
          file: "manifest.json",
        });
      }
    }
    if (manifest.kind === "action" && contract.capabilityCalls.has(call)) {
      findings.push({
        severity: "error",
        code: "WRONG_PLUGIN_KIND",
        message: `contributes.${kind}는 능력 등록(memo.${call})이라 kind: "capability"가 필요함 — 지금 매니페스트는 kind: "action"이라 호스트가 WRONG_PLUGIN_KIND로 거부한다`,
        file: "manifest.json",
      });
    }
    // windowControls는 값 배열 하나가 `window.register({controls})` 한 번이고, 나머지는
    // 항목마다 등록 한 번이다(호스트의 적용 규칙과 같은 모양).
    const calls =
      kind === "windowControls"
        ? [{ controls: raw }]
        : (raw as Record<string, unknown>[]);
    for (const args of calls) {
      try {
        await registrar.execute(call, args);
      } catch (e) {
        findings.push({
          severity: "error",
          code: "INVALID_CONTRIBUTION",
          message: `contributes.${kind}의 항목이 등록되지 않는다: ${e instanceof Error ? e.message : String(e)}`,
          file: "manifest.json",
        });
      }
    }
  }
}

export async function runLint(
  pluginDir: string,
  contract: HostContract,
): Promise<Finding[]> {
  const { findings, manifest } = await runValidate(pluginDir, contract);
  if (manifest === undefined) {
    // 매니페스트가 구조적으로 깨졌으면 권한·설정 대조 자체가 무의미하다 — validate가 이미
    // 낸 오류만 돌려주고 코드 검사로 넘어가지 않는다(추측성 후속 오탐 방지).
    return findings;
  }

  const entryPath = path.join(pluginDir, manifest.entry);
  if (!existsSync(entryPath)) {
    // ENTRY_MISSING은 validate가 이미 보고했다 — 코드가 없으니 더 볼 것도 없다.
    return findings;
  }

  const src = readFileSync(entryPath, "utf8");
  const callSites = findMemoCallSites(src);
  const declaredPermissions = new Set(manifest.permissions);
  const declaredSettingKeys = new Set(
    (manifest.settings ?? []).map((s) => s.key),
  );
  const usedPermissions = new Set<string>();
  /** 이 파일에서 이미 본 툴바 버튼 id(정적 리터럴만) — 중복 등록 판정용. */
  const toolbarButtonIds = new Set<string>();
  /** 코드가 등록하는 명령 id(정적 리터럴만) — 설정 액션 버튼의 대조 대상. */
  const registeredCommandIds = new Set<string>();
  /** 리터럴로 못 읽은 `id:`가 하나라도 있으면 대조를 포기한다(추측하지 않는다). */
  let hasDynamicCommandId = false;

  for (const site of callSites) {
    const { line, column } = lineColOf(src, site.matchIndex);
    const loc = { file: manifest.entry, line, column };

    // **없어진 호출을 먼저 본다.** 옛 이름은 `isKnownCall`에도 당연히 없으므로, 순서를
    // 뒤집으면 아래 일반 UNKNOWN_CALL이 먼저 잡아 "오타이거나 아직 없는 API"라는 틀린 추측을
    // 준다(오타도 아니고 아직 없는 것도 아니다 — 있었고 옮겨 갔다).
    //
    // 별도 코드를 파는 이유는 `RESERVED_CALL` 선례와 같다: 이름 하나로 "타이핑 실수"와
    // "계약이 바뀜"을 가를 수 있어야 도구·문서가 그 둘을 다르게 다룬다. 다만 severity는
    // 예약(warn)과 달리 **error**다 — 예약은 언젠가 열릴 수 있지만 없어진 호출은 돌아오지 않는다.
    const removed = contract.removedCallHint(site.call);
    if (removed !== undefined) {
      findings.push({
        severity: "error",
        code: "REMOVED_CALL",
        message: `없어진 호출: memo.${site.call}(...) — ${removed}`,
        ...loc,
      });
      continue; // 실행 경로가 없으니 권한·인자 대조가 무의미하다(UNKNOWN_CALL과 같은 이유).
    }

    if (!contract.isKnownCall(site.call)) {
      findings.push({
        severity: "error",
        code: "UNKNOWN_CALL",
        message: `존재하지 않는 호출: memo.${site.call}(...) — 오타이거나 아직 없는 API`,
        ...loc,
      });
      continue; // 존재하지 않는 호출은 권한·인자 대조가 무의미하다.
    }

    // kind 게이트를 **정적으로** 미리 본다: 이 대조는 완전히 정적이고(매니페스트 kind ↔
    // CAPABILITY_CALLS) 계약에도 이미 실려 있다. 없으면 정본 예제(`kind: "action"`)를 복사해
    // 테마·배경·폰트 플러그인을 만든 저작자가 "✓ 문제 없음"을 받고 설치한 뒤, 능력 등록이
    // 전부 WRONG_PLUGIN_KIND로 거부돼 아무 일도 하지 않는 플러그인을 손에 쥔다.
    // 미선언(kind 없음)은 게이트가 통과시키므로(하위호환) 여기서도 검사하지 않는다.
    if (manifest.kind === "action" && contract.capabilityCalls.has(site.call)) {
      findings.push({
        severity: "error",
        code: "WRONG_PLUGIN_KIND",
        message: `memo.${site.call}(...)은 능력 등록이라 kind: "capability" 플러그인만 쓸 수 있음 — 지금 매니페스트는 kind: "action"이라 런타임에서 WRONG_PLUGIN_KIND로 거부된다`,
        ...loc,
      });
    }

    if (contract.isReservedCall(site.call)) {
      findings.push({
        severity: "warn",
        code: "RESERVED_CALL",
        message: `예약 호출: memo.${site.call}(...) — 이름은 있지만 실행 경로가 없어 항상 거부됨`,
        ...loc,
      });
    }

    // 호출 자체의 권한 외에, 이 등록이 렌더 시점에 요구하는 권한도 "쓴 것"으로 센다.
    // 그리고 `required`인 것은 **반대 방향**으로도 본다 — 선언이 없으면 그 등록은 런타임에서
    // 100% 무력화되는데 지금까지는 lint가 「문제 없음」을 줬다.
    const gate = RENDER_GATE_PERMISSIONS[site.call];
    if (gate) {
      for (const perm of gate.permissions) {
        usedPermissions.add(perm);
        if (!gate.required || declaredPermissions.has(perm)) continue;
        findings.push({
          severity: "warn",
          code: "RENDER_GATE_UNDECLARED",
          message: `memo.${site.call}(...)은 '${perm}' 없이는 렌더 시점에 무력화된다 — 등록은 성공하지만 아무 일도 일어나지 않고 오류·진단도 남지 않는다(manifest.permissions에 '${perm}'을 추가하라)`,
          ...loc,
        });
      }
    }

    // 블록 임베드는 최종 임베드 URL의 도메인이 `embed:<도메인>` 권한으로 **따로** 게이트된다.
    if (site.call === "editor.registerBlockEmbed") {
      const host = extractEmbedTemplateHost(site.argsText);
      if (host !== null && !declaredPermissions.has(`embed:${host}`)) {
        findings.push({
          severity: "warn",
          code: "RENDER_GATE_UNDECLARED",
          message: `embedTemplate의 도메인 권한 'embed:${host}'가 manifest.permissions에 없음 — 등록은 성공하지만 렌더 직전에 조용히 취소된다(임베드가 영영 안 뜬다)`,
          ...loc,
        });
      }
    }

    // 이벤트 구독은 이름이 닫힌 어휘이고, 이름마다 **추가** 권한이 다르다. 둘 다 정적으로
    // 판정된다 — 못 하면 오타난 구독이 「문제 없음」을 받고 런타임에서만 조용히 거부된다.
    if (site.call === "events.on") {
      const name = extractEventName(site.argsText);
      if (name !== null) {
        if (!contract.eventNames.includes(name)) {
          findings.push({
            severity: "error",
            code: "UNKNOWN_EVENT_NAME",
            message: `memo.events.on(...)의 name '${name}'은 없는 이벤트 — 호스트가 INVALID_ARGS로 거부해 구독이 만들어지지 않는다(가능한 값: ${contract.eventNames.join(", ")})`,
            ...loc,
          });
        } else {
          // `CALL_PERMISSIONS["events.on"]`는 바닥(`settings`)이라 아래 공통 검사가 이름별
          // 추가 권한을 못 본다 — `note:*`의 `notes:read`가 정확히 그 구멍이었다.
          const extra = contract.eventPermission[name] ?? null;
          if (extra !== null) {
            usedPermissions.add(extra);
            if (!declaredPermissions.has(extra)) {
              findings.push({
                severity: "error",
                code: "PERMISSION_UNDECLARED",
                message: `memo.events.on({ name: "${name}" })에 필요한 권한 '${extra}'이 manifest.permissions에 없음 — 이름별 추가 권한이라 'settings'만으로는 구독이 거부된다`,
                ...loc,
              });
            }
          }
        }
      }
    }

    // network.fetch의 권한은 URL 호스트에서 파생한 `network:<호스트>`라 정적 표의
    // 대표값('network:<도메인>')으로 판정하면 안 된다(그러면 실제 도메인을 선언한 플러그인이
    // 오탐을 받는다). URL 리터럴에서 호스트를 뽑아 그 호스트 권한만 대조하고, 아래 generic
    // 검사는 건너뛴다(embed:<도메인>이 렌더 게이트에서 별도로 다뤄지는 것과 같은 결).
    if (site.call === "network.fetch") {
      const host = extractNetworkFetchUrlHost(site.argsText);
      if (host !== null && !declaredPermissions.has(`network:${host}`)) {
        findings.push({
          severity: "error",
          code: "PERMISSION_UNDECLARED",
          message: `memo.network.fetch(...)의 URL 호스트 권한 'network:${host}'이 manifest.permissions에 없음 — 호스트마다 network:<호스트>를 선언해야 그 호스트로 요청할 수 있다`,
          ...loc,
        });
      }
    } else if (site.call === "commands.invoke") {
      // commands.invoke의 권한도 인자(pluginId)에서 파생한 `invoke:<대상>`이라, 정적 표의
      // 대표값('invoke:<pluginId>')으로 판정하면 실제 대상을 선언한 플러그인이 오탐을 받는다.
      // pluginId 리터럴에서 대상을 뽑아 그 권한만 대조하고, 아래 generic 검사는 건너뛴다
      // (network.fetch가 URL 호스트를 별도로 다루는 것과 같은 결).
      const targetId = extractInvokeTargetId(site.argsText);
      if (targetId !== null && !declaredPermissions.has(`invoke:${targetId}`)) {
        findings.push({
          severity: "error",
          code: "PERMISSION_UNDECLARED",
          message: `memo.commands.invoke(...)의 대상 권한 'invoke:${targetId}'이 manifest.permissions에 없음 — 대상마다 invoke:<대상 id>를 선언해야 그 플러그인의 공개 명령을 부를 수 있다(대상은 그 명령을 exposes로 공개해야 한다)`,
          ...loc,
        });
      }
    } else {
      const required = contract.requiredPermissionFor(site.call);
      if (required !== null) {
        usedPermissions.add(required);
        if (!declaredPermissions.has(required)) {
          findings.push({
            severity: "error",
            code: "PERMISSION_UNDECLARED",
            message: `memo.${site.call}(...)에 필요한 권한 '${required}'이 manifest.permissions에 없음`,
            ...loc,
          });
        }
      }
    }

    if (site.argCount >= 2) {
      findings.push({
        severity: "error",
        code: "TOO_MANY_ARGS",
        // 인과를 **실제 계약과 같은 사실로** 적는다. 예전에는 두 번째 인자가 조용히
        // 버려졌지만 지금은 부트스트랩이 그 자리에서 동기 TypeError를 던진다 — 최상위
        // 실행이 거기서 멈추고 ready가 "스크립트 실행 오류"로 거부되어 그 플러그인은
        // 스냅샷에서 통째로 빠진다(예외 이전에 성공한 등록까지 하나도 안 남는다).
        // "나머지 인자만 버려진다"고 적으면 저작자는 버튼·패턴이 전부 사라진 원인을
        // 툴바 배치·권한·활성 토글에서 찾게 된다.
        message: `memo.${site.call}(...)에 인자를 ${site.argCount}개 넘김 — 브리지는 객체 인자 1개만 받는다. 이 줄에서 동기 TypeError가 나 최상위 실행이 멈추고, 그 플러그인은 "스크립트 실행 오류"로 로드 자체가 실패한다(등록이 하나도 남지 않는다)`,
        ...loc,
      });
    }

    // catch 핸들러 안이라도 면제는 **무권한 진단 호출**(`memo.runtime.*`)에만 준다.
    // 왜: "이미 실패를 처리하는 중이니 또 catch를 요구하지 말자"는 근거는 실패해도 잃을 것이
    // 없는 로그 호출에서만 성립한다. 복구 로직이 catch 안에서 `settings.set`·`notes.*`처럼
    // 상태를 바꾸는 호출을 하면 그 호출의 거부(권한 미부여·IPC 실패)는 여전히 조용히
    // 사라진다 — 무음 실패를 없애려는 도구가 정확히 에러 복구 코드에서 그것을 재도입한다.
    const catchExempt =
      site.inCatchHandler && contract.noPermissionCalls.has(site.call);
    if (
      !site.isNested &&
      !site.precededByAwait &&
      !site.precededByArrow &&
      !catchExempt &&
      !site.chain.uncertain &&
      !site.chain.hasCatch
    ) {
      findings.push({
        severity: "warn",
        code: "MISSING_CATCH",
        message: `memo.${site.call}(...)에 .catch가 없는 최상위 호출 — 거부돼도 조용히 사라짐`,
        ...loc,
      });
    }

    // 툴바 버튼은 등록 계약이 따로 있다 — 둘 다 앱을 띄우기 전에 정적으로 잡힌다.
    if (site.call === "ui.addToolbarButton") {
      // 객체 리터럴이 아니거나(변수 전달) 스프레드가 섞이면 인자 구성을 정적으로 알 수 없다.
      const literalArgs =
        site.argsText.trim().startsWith("{") && !site.argsText.includes("...");
      if (literalArgs && !/\bonClick\b/.test(site.argsText)) {
        findings.push({
          severity: "error",
          code: "MISSING_ONCLICK",
          message: `memo.ui.addToolbarButton(...)에 onClick이 없음 — 호스트가 INVALID_ARGS로 거부해 버튼이 등록조차 되지 않는다(예전엔 눌러도 아무 일도 없는 버튼이 조용히 떴다)`,
          ...loc,
        });
      }
      const buttonId = extractToolbarButtonId(site.argsText);
      if (buttonId !== null) {
        if (toolbarButtonIds.has(buttonId)) {
          findings.push({
            // warn인 이유: 두 등록이 서로 다른 분기에 있으면(if/else) 실제로는 하나만 돈다.
            severity: "warn",
            code: "DUPLICATE_BUTTON_ID",
            message: `툴바 버튼 id '${buttonId}'가 이 파일에서 두 번 등록됨 — 나중 등록이 앞의 버튼을 치환하므로 버튼 하나가 사라진다. 버튼마다 다른 id를 줘라(id는 사용자의 툴바 배치·단축키가 붙는 키다)`,
            ...loc,
          });
        }
        toolbarButtonIds.add(buttonId);
      }
    }

    // 명령도 툴바 버튼과 같은 등록 계약을 갖는다 — `run`이 없으면 호스트가 등록 자체를
    // 거부하고, `when`의 모르는 키도 마찬가지다. 둘 다 앱을 띄우기 전에 정적으로 잡힌다.
    if (site.call === "commands.register") {
      // 등록되는 명령 id를 모아 둔다 — 설정 액션 버튼이 가리킬 수 있는 유일한 후보다.
      // `id:` 키 자체가 없으면 호스트가 자동 생성하므로 매니페스트가 그 id를 알 방법이
      // 없다 → 후보가 아니다(대조 포기 대상도 아니다). 키는 있는데 리터럴이 아닐 때만 포기한다.
      const commandId = extractToolbarButtonId(site.argsText);
      if (commandId !== null) registeredCommandIds.add(commandId);
      // 리터럴로 못 읽었는데 `id:`가 어디엔가 있으면 동적 id로 보고 대조를 포기한다.
      // 일부러 느슨하게(주석까지 포함해) 본다 — 이 판정이 틀리는 방향은 "검사를 건너뛴다"여야
      // 하지 "없는 명령이라고 단정한다"가 되면 안 된다(오탐이 미탐보다 훨씬 나쁘다).
      else if (/\bid\s*:/.test(site.argsText)) hasDynamicCommandId = true;
      const literalArgs =
        site.argsText.trim().startsWith("{") && !site.argsText.includes("...");
      if (literalArgs && !/\brun\b/.test(site.argsText)) {
        findings.push({
          severity: "error",
          code: "MISSING_RUN",
          message: `memo.commands.register(...)에 run이 없음 — 호스트가 INVALID_ARGS로 거부해 명령이 등록되지 않는다(단축키 화면에도 나타나지 않는다)`,
          ...loc,
        });
      }
      if (literalArgs && !/\btitle\b/.test(site.argsText)) {
        findings.push({
          severity: "error",
          code: "MISSING_TITLE",
          message: `memo.commands.register(...)에 title이 없음 — 단축키 화면에 보일 이름이 없어 호스트가 INVALID_ARGS로 거부한다`,
          ...loc,
        });
      }
      const whenKeys = extractWhenKeys(site.argsText);
      if (whenKeys !== null) {
        // 판정은 호스트의 실물 파서로 한다 — 어휘를 CLI가 다시 적으면 그 사본이 갈라진다.
        const parsed = contract.parseWhenClause(whenKeys, [
          ...declaredSettingKeys,
        ]);
        if (!parsed.ok) {
          findings.push({
            severity: "error",
            code: "INVALID_WHEN",
            message: `memo.commands.register(...)의 when이 유효하지 않음: ${parsed.error}`,
            ...loc,
          });
        }
      }
    }

    // 컨텍스트 메뉴 항목도 툴바 버튼·명령과 같은 등록 계약을 갖는다 — `run`이 없거나
    // `label`이 비었거나 `when`에 모르는 키가 있으면 호스트가 INVALID_ARGS로 등록 자체를
    // 거부하고, 그 거부는 진단 채널에만 남는다(우클릭 메뉴에는 그냥 나타나지 않는다). 툴바·
    // 명령에는 이 정적 검사가 있는데 신규 API(addMenuItem)에만 없으면 "린트 통과인데 앱에서
    // 안 뜬다"가 재발하므로, commands.register 블록과 대칭으로 앱을 띄우기 전에 잡는다.
    if (site.call === "ui.addMenuItem") {
      const literalArgs =
        site.argsText.trim().startsWith("{") && !site.argsText.includes("...");
      if (literalArgs && !/\brun\b/.test(site.argsText)) {
        findings.push({
          severity: "error",
          code: "MISSING_RUN",
          message: `memo.ui.addMenuItem(...)에 run이 없음 — 호스트가 INVALID_ARGS로 거부해 메뉴 항목이 등록되지 않는다(우클릭 메뉴에 나타나지 않는다)`,
          ...loc,
        });
      }
      // label은 메뉴에 보일 **유일한** 문자열이다(툴바 버튼과 달리 글리프 폴백이 없다) — 없거나
      // 빈 리터럴이면 호스트가 거부한다. 리터럴로 빈 값을 적은 경우(`label: ""`)까지 잡는다.
      const emptyLabelLiteral = /(?:^|[{,])\s*label\s*:\s*(["'`])\s*\1/.test(
        site.argsText,
      );
      if (
        literalArgs &&
        (!/\blabel\b/.test(site.argsText) || emptyLabelLiteral)
      ) {
        findings.push({
          severity: "error",
          code: "MISSING_LABEL",
          message: `memo.ui.addMenuItem(...)에 비어 있지 않은 label이 없음 — 호스트가 INVALID_ARGS로 거부한다(메뉴에 보일 이름)`,
          ...loc,
        });
      }
      const whenKeys = extractWhenKeys(site.argsText);
      if (whenKeys !== null) {
        // 메뉴 항목 전용 어휘(창 상태 두 키)로 판정한다 — 호스트와 같은 파서에 `menu` 옵션을
        // 넘긴다(정적 키는 렌더 시점의 노트 창이 못 봐서 거부된다).
        const parsed = contract.parseWhenClause(
          whenKeys,
          [...declaredSettingKeys],
          { menu: true },
        );
        if (!parsed.ok) {
          findings.push({
            severity: "error",
            code: "INVALID_WHEN",
            message: `memo.ui.addMenuItem(...)의 when이 유효하지 않음: ${parsed.error}`,
            ...loc,
          });
        }
      }
    }

    // 선택 액션도 같은 등록 계약을 갖는다 — `run`이 없거나 `label`이 비면 호스트가
    // INVALID_ARGS로 등록 자체를 거부하고, 그 거부는 진단 채널에만 남는다(선택 툴바에는
    // 그냥 나타나지 않는다). 메뉴 항목 블록과 대칭으로 앱을 띄우기 전에 잡는다.
    if (site.call === "ui.addSelectionAction") {
      const literalArgs =
        site.argsText.trim().startsWith("{") && !site.argsText.includes("...");
      if (literalArgs && !/\brun\b/.test(site.argsText)) {
        findings.push({
          severity: "error",
          code: "MISSING_RUN",
          message: `memo.ui.addSelectionAction(...)에 run이 없음 — 호스트가 INVALID_ARGS로 거부해 선택 액션이 등록되지 않는다(선택 툴바에 나타나지 않는다)`,
          ...loc,
        });
      }
      // label은 좁은 플로팅 바에 보일 **유일한** 문자열이다(글리프 폴백이 없다) — 없거나 빈
      // 리터럴이면 호스트가 거부한다(메뉴 항목과 같은 판정).
      const emptyLabelLiteral = /(?:^|[{,])\s*label\s*:\s*(["'`])\s*\1/.test(
        site.argsText,
      );
      if (
        literalArgs &&
        (!/\blabel\b/.test(site.argsText) || emptyLabelLiteral)
      ) {
        findings.push({
          severity: "error",
          code: "MISSING_LABEL",
          message: `memo.ui.addSelectionAction(...)에 비어 있지 않은 label이 없음 — 호스트가 INVALID_ARGS로 거부한다(선택 툴바 버튼에 보일 글자)`,
          ...loc,
        });
      }
    }

    if (site.call === "settings.get") {
      const key = extractSettingsGetKey(site.argsText);
      if (key !== null && !declaredSettingKeys.has(key)) {
        findings.push({
          severity: "error",
          code: "UNKNOWN_SETTING_KEY",
          // 값 계약은 인덱스(`api-index.ts`의 settings.get returns)와 같아야 한다:
          // 브리지는 `settings.get(key) ?? null`을 넘기므로 미선언 키는 **null**이다.
          // 예전 문구("항상 undefined")를 믿고 `=== undefined` 폴백을 짜면 그 분기가
          // 절대 타지 않는다.
          message: `memo.settings.get(...)이 읽는 키 '${key}'가 manifest.settings에 선언되어 있지 않음 — settings.get은 null을 돌려준다(매니페스트 settings에 키를 추가하거나 호출을 지워라)`,
          ...loc,
        });
      }
    }
  }

  // 설정 액션 버튼이 가리키는 명령이 코드에 실재하는지 대조한다.
  //
  // 왜 이게 CLI에 있어야 하나: 이 어긋남은 **매니페스트도 코드도 각자는 유효**해서 어느
  // 검증기도 잡지 못한다. 앱에서는 버튼이 멀쩡히 뜨고 누르면 아무 일도 일어나지 않는다 —
  // 이 저장소가 11번 겪은 "선언은 됐는데 아무도 안 읽는다"의 새 서식이라, 새 계약을 만든
  // 그 커밋에서 CLI도 함께 알게 해 둔다("✓ 문제 없음"이 거짓말이 되지 않도록).
  if (!hasDynamicCommandId) {
    for (const field of manifest.settings ?? []) {
      if (field.type !== "button") continue;
      const commandId = field.command ?? "";
      if (registeredCommandIds.has(commandId)) continue;
      findings.push({
        severity: "error",
        code: "UNKNOWN_COMMAND_ID",
        message: `설정 버튼 '${field.key}'의 command '${commandId}'를 등록하는 memo.commands.register({ id: "${commandId}", ... })가 ${manifest.entry}에 없음 — 설정 화면에 버튼은 뜨지만 눌러도 아무 일이 일어나지 않는다`,
        file: "manifest.json",
      });
    }
  }

  // 선언형 기여는 **명령형 등록과 같은 규칙**을 받아야 한다: 같은 권한, 같은 kind
  // 게이트, 같은 형식 검증. 안 그러면 "JSON으로는 통과인데 설치하면 조용히 아무것도 등록되지
  // 않는" 상태가 되고, 그 실패는 진단 채널에만 남아 저작자가 볼 방법이 사실상 없다.
  await lintContributes(
    manifest,
    declaredPermissions,
    usedPermissions,
    contract,
    findings,
  );

  // 선언했으나 한 번도 안 쓴 권한(permissionToCalls 재사용 — 역인덱스를 다시 안 만든다).
  const permissionCallMap = contract.permissionToCalls(
    contract.callPermissions,
  );
  for (const perm of declaredPermissions) {
    const calls = permissionCallMap[perm];
    if (calls === undefined || calls.length === 0) continue; // embed:<domain> 등 — 정적 판단 불가.
    const liveCalls = calls.filter((c) => !contract.isReservedCall(c));
    if (liveCalls.length === 0) continue; // 예약 호출뿐인 권한 — "안 씀" 판정이 무의미하다.
    if (!usedPermissions.has(perm)) {
      findings.push({
        severity: "warn",
        code: "UNUSED_PERMISSION",
        message: `권한 '${perm}'을 선언했지만 이 권한이 필요한 호출(${liveCalls.join(", ")})을 코드에서 쓰지 않음`,
        file: "manifest.json",
      });
    }
  }

  return findings;
}
