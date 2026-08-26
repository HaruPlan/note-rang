/**
 * host-executor-validators 단위 테스트 — 중앙 호스트와 하니스가 공유하는 판정이
 * 실제로 같은 결정·같은 오류 코드·같은 문구를 낸다는 것을 못박는다.
 *
 * 왜: 이 함수들이 갈라지면 "하니스는 통과했는데 앱은 거부한다"가 조용히 생긴다(가
 * 경계한 실패). 두 실행기가 같은 함수를 import하므로 로직 드리프트는 구조적으로 불가능하고,
 * 여기서는 그 공유 로직 자체의 계약(문구 포함)을 고정한다.
 */
import { describe, it, expect } from "vitest";
import {
  resolveSettingsGetArg,
  buildSettingsSnapshot,
  checkEventName,
  checkEventExtraPermission,
  checkCommandTitle,
} from "./host-executor-validators";
import type { PluginGrant } from "./permissions";
import type { PluginSettingField } from "../shared/tauri";

function grant(overrides: Partial<PluginGrant> = {}): PluginGrant {
  return { declared: [], granted: [], ...overrides };
}

describe("resolveSettingsGetArg", () => {
  it("문자열 축약형은 INVALID_ARGS로 거부한다(객체 인자만 — 엄격)", () => {
    const r = resolveSettingsGetArg("greeting");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("객체 인자");
    }
  });

  it("객체 인자 { key }는 키로 읽는다", () => {
    const r = resolveSettingsGetArg({ key: "greeting" });
    expect(r).toEqual({ ok: true, key: "greeting" });
  });

  it("key 없는 객체는 빈 문자열 키로 흡수한다(선언되지 않은 키 → 나중에 null)", () => {
    const r = resolveSettingsGetArg({});
    expect(r).toEqual({ ok: true, key: "" });
  });
});

describe("buildSettingsSnapshot", () => {
  const schema: PluginSettingField[] = [
    { key: "greeting", label: "인사말", type: "text", options: [] },
    {
      key: "style",
      label: "말투",
      type: "select",
      options: [{ value: "formal" }, { value: "casual" }],
    },
  ];

  it("선언된 모든 키를 read로 읽어 스냅샷 하나로 편다", () => {
    const store: Record<string, unknown> = {
      greeting: "안녕",
      style: "casual",
    };
    const out = buildSettingsSnapshot(schema, (k) => store[k]);
    expect(out).toEqual({ greeting: "안녕", style: "casual" });
  });

  it("read가 없는 값을 주면 null이 병합된다(키는 항상 존재)", () => {
    const out = buildSettingsSnapshot(schema, () => undefined);
    expect(out).toEqual({ greeting: null, style: null });
  });
});

describe("checkEventName", () => {
  it("유효한 이름은 좁혀진 MemoEventName을 돌려준다", () => {
    const r = checkEventName("note:saved");
    expect(r).toEqual({ ok: true, name: "note:saved" });
  });

  it("열거 밖 이름은 INVALID_ARGS로 거부하고 가능한 값을 싣는다", () => {
    const r = checkEventName("note:typed");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("note:saved");
    }
  });
});

describe("checkEventExtraPermission", () => {
  it("추가 권한이 없는 이벤트(settings:changed)는 통과한다", () => {
    expect(checkEventExtraPermission(grant(), "settings:changed")).toBeNull();
  });

  it("notes:read 미선언이면 PERMISSION_UNDECLARED", () => {
    const err = checkEventExtraPermission(grant(), "note:saved");
    expect(err?.code).toBe("PERMISSION_UNDECLARED");
    expect(err?.message).toContain("notes:read");
  });

  it("notes:read 선언·미부여면 PERMISSION_UNGRANTED(민감 권한)", () => {
    // notes:read는 민감 권한이라 declared만으로는 부족하다 — 사용자 승인(granted)까지 있어야
    // 통과한다. 이 UNGRANTED/UNDECLARED 갈림이 두 실행기에서 같아야 한다는 것이 이 함수의 핵심.
    const err = checkEventExtraPermission(
      grant({ declared: ["notes:read"] }),
      "note:saved",
    );
    expect(err?.code).toBe("PERMISSION_UNGRANTED");
  });

  it("notes:read 선언·부여면 통과한다", () => {
    expect(
      checkEventExtraPermission(
        grant({ declared: ["notes:read"], granted: ["notes:read"] }),
        "note:saved",
      ),
    ).toBeNull();
  });
});

describe("checkCommandTitle", () => {
  it("빈 title은 INVALID_ARGS로 거부한다", () => {
    const r = checkCommandTitle("");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("title");
    }
  });

  it("공백 아닌 title은 다듬어 통과한다", () => {
    expect(checkCommandTitle("정리하기")).toEqual({
      ok: true,
      title: "정리하기",
    });
  });

  it("undefined는 빈 문자열로 흡수돼 거부된다", () => {
    expect(checkCommandTitle(undefined).ok).toBe(false);
  });
});
