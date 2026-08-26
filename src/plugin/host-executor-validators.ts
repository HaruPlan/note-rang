/**
 * 호스트 실행기 공유 판정(드리프트 방지) — 중앙 호스트(`central-host.ts`)와 헤드리스
 * 하니스(`test-host.ts`)가 **같은** 순수 함수를 태워 settings·events·commands의 인자·권한을
 * 판정한다.
 *
 * 왜 별도 모듈인가: 두 실행기는 값을 읽는 백엔드(중앙은 설정 서비스, 하니스는 인메모리
 * store)와 핸들러 표현(중앙은 `handlerId` 문자열, 하니스는 함수 그대로)이 달라 한 함수로
 * 합칠 수 없다 — 하지만 그 차이 **바깥**의 판정(settings.get 객체-인자 강제, 이벤트 이름 열거,
 * 이름별 추가 권한, 명령 title 필수, getAll 스냅샷 구성)은 오류 문구 한 글자까지 같아야
 * 한다. 손으로 두 벌 적어 두면 한쪽만 고쳐도 게이트가 통과해 "하니스는 통과했는데 앱은
 * 거부한다"가 조용히 생긴다(가 명시적으로 경계한 실패). 그 공통 판정만 여기 모아
 * **양쪽이 import**하게 해 드리프트를 구조적으로 없앤다.
 *
 * 거부는 `MemoCallError`(=`bridgeError`)로 표현한다 — 던지지 않고 **돌려준다**. 중앙 호스트는
 * `Promise.reject(err)`로, 하니스는 `throw err`로 각자 자기 제어 흐름에 맞게 소비한다(그
 * 차이만 호출부에 남는다).
 */
import { bridgeError, type MemoCallError } from "./host";
import { checkPermission, type PluginGrant } from "./permissions";
import {
  isMemoEventName,
  MEMO_EVENT_NAMES,
  MEMO_EVENT_PERMISSION,
  type MemoEventName,
} from "./host-protocol";
import { toPluginSettingValue } from "../shared/plugin-settings";
import type { PluginSettingField } from "../shared/tauri";

/** `settings.get` 인자 해석 결과 — 성공이면 읽을 키, 실패면 거부 오류.
 *  호출부는 구조적으로만 쓰므로(`.ok`/`.key`) 이름을 내보내지 않는다. */
type SettingsGetArg =
  { ok: true; key: string } | { ok: false; error: MemoCallError };

/**
 * `settings.get`의 인자(`{ key }`)를 읽을 키로 해석한다.
 *
 * **객체 인자만 받는다**(엄격) — 문자열 축약형은 제거했다. 문자열을 조용히 받아 주면
 * 저작자가 "됐다"고 믿은 채 `list` 반환 형태 차이에서 깨진다. `list`는 언제나 구조화
 * 배열로 나가므로 저장 블롭을 그대로 받는 `raw` 탈출구도 없다. 값 자체는 호출부가 자기
 * 백엔드에서 읽는다(중앙은 설정 서비스, 하니스는 store) — 여기서는 **무엇을 읽을지**만 정한다.
 */
export function resolveSettingsGetArg(rawArg: unknown): SettingsGetArg {
  if (typeof rawArg !== "object" || rawArg === null || Array.isArray(rawArg)) {
    return {
      ok: false,
      error: bridgeError(
        "INVALID_ARGS",
        'settings.get에는 객체 인자만 줄 수 있습니다: settings.get({ key: "..." })',
      ),
    };
  }
  const key = String((rawArg as { key?: unknown }).key ?? "");
  return { ok: true, key };
}

/**
 * `settings.getAll` 스냅샷 — 선언된 모든 키를 기본값 병합된 값으로 편다. 저장값은
 * 호출부가 준 `read`로 읽는다(백엔드 차이를 이 함수 밖에 둔다).
 */
export function buildSettingsSnapshot(
  schema: readonly PluginSettingField[],
  read: (key: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema) {
    out[field.key] = toPluginSettingValue(field, read(field.key) ?? null);
  }
  return out;
}

/**
 * `events.on`의 이벤트 이름 검증 — 닫힌 열거 밖 값은 거부(가능한 값을 문구에 싣는다).
 * 오타를 조용히 받으면 "구독은 됐는데 영원히 안 불린다"가 되어 원인을 찾을 길이 없다.
 * 통과하면 좁혀진 `MemoEventName`을 돌려줘 호출부가 다시 좁히지 않게 한다.
 */
export function checkEventName(
  name: unknown,
): { ok: true; name: MemoEventName } | { ok: false; error: MemoCallError } {
  if (isMemoEventName(name)) return { ok: true, name };
  return {
    ok: false,
    error: bridgeError(
      "INVALID_ARGS",
      `알 수 없는 이벤트 이름: ${String(name)} (가능한 값: ${MEMO_EVENT_NAMES.join(", ")})`,
    ),
  };
}

/**
 * 이벤트 이름별 추가 권한 게이트(노트 이벤트 → `notes:read` 등) — 게이트키퍼가 이미 바닥
 * 권한(`settings`)을 봤으므로, 여기서 막히는 것은 "이 이름만" 못 듣는 경우다. 선언은 했으나
 * 미부여면 `PERMISSION_UNGRANTED`, 아예 미선언이면 `PERMISSION_UNDECLARED`로 가른다.
 */
export function checkEventExtraPermission(
  grant: PluginGrant,
  name: MemoEventName,
): MemoCallError | null {
  const extra = MEMO_EVENT_PERMISSION[name];
  if (extra === null) return null;
  const decision = checkPermission(grant, extra);
  if (decision.allowed) return null;
  return bridgeError(
    grant.declared.includes(extra)
      ? "PERMISSION_UNGRANTED"
      : "PERMISSION_UNDECLARED",
    `${name} 구독에는 ${extra} 권한이 필요합니다: ${decision.reason ?? ""}`,
  );
}

/**
 * `commands.register`의 `title` 필수 검증 — title은 단축키 화면에 보일 **유일한** 이름이라
 * 비면 사용자는 정체불명의 빈 행에 키를 배정하게 된다. 통과하면 다듬은 title을 돌려준다.
 */
export function checkCommandTitle(
  rawTitle: unknown,
): { ok: true; title: string } | { ok: false; error: MemoCallError } {
  const title = String(rawTitle ?? "");
  if (title === "") {
    return {
      ok: false,
      error: bridgeError(
        "INVALID_ARGS",
        "commands.register에는 title이 필요합니다(단축키 화면에 보일 이름)",
      ),
    };
  }
  return { ok: true, title };
}
