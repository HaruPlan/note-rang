/**
 * CSP 정책 회귀 가드 — tauri.conf.json의 `app.security.csp`가 (1) null이 아니고(빈 정책 회귀
 * 방지), (2) 좁힌 정책의 핵심 지시어·속성을 유지하는지 고정한다.
 *
 * 왜: CSP는 조용히 느슨해지기 쉽다(디버깅 중 `'unsafe-inline'` 추가 후 되돌리기 잊음 등).
 * 실수로 정책을 지우거나(`null`) 위험 소스를 넣으면 이 스냅샷/속성 가드가 즉시 실패한다.
 * 각 지시어의 "왜 필요한가"는 docs/history/2026-07-early-decisions.md §6에 문서로 남긴다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SANDBOX_BOOTSTRAP_CSP_HASH } from "./sandbox-bootstrap";

/** tauri.conf.json에서 CSP 문자열을 읽는다(문자열이 아니면 실패 — null 회귀 방지). */
function readCsp(): string {
  const conf = JSON.parse(
    readFileSync("src-tauri/tauri.conf.json", "utf8"),
  ) as { app?: { security?: { csp?: unknown } } };
  const csp = conf.app?.security?.csp;
  expect(
    typeof csp,
    "csp는 null이 아닌 문자열이어야 한다(빈 정책 회귀 방지)",
  ).toBe("string");
  return csp as string;
}

/** 정책 문자열을 지시어 → 소스 집합으로 파싱한다(순서 무관 비교용). */
function parseDirectives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out[tokens[0]] = tokens.slice(1);
  }
  return out;
}

describe("tauri.conf.json CSP", () => {
  /** 가드(회귀 방지): csp가 null이 아니고 정확히 이 정책 전문이다(느슨해지면 실패). */
  it("matches the exact hardened policy snapshot", () => {
    const csp = readCsp();
    expect(csp).toBe(
      "default-src 'self'; " +
        `script-src 'self' blob: ${SANDBOX_BOOTSTRAP_CSP_HASH}; ` +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' asset: http://asset.localhost data: blob:; " +
        "font-src 'self'; " +
        "connect-src 'self' ipc: http://ipc.localhost; " +
        "frame-src 'self' https:; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'",
    );
  });

  /** 가드(보안 핵심): script-src에 'unsafe-inline'/'unsafe-eval'이 절대 없다. */
  it("never allows unsafe-inline or unsafe-eval in script-src", () => {
    const d = parseDirectives(readCsp());
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    // 플러그인 코드(blob 스크립트) + 부트스트랩(해시) 허용은 유지.
    expect(d["script-src"]).toContain("blob:");
    expect(d["script-src"]).toContain(SANDBOX_BOOTSTRAP_CSP_HASH);
  });

  /** 가드: 잠금 지시어(default-src/object-src/base-uri)가 유지된다. */
  it("keeps the lockdown directives", () => {
    const d = parseDirectives(readCsp());
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
  });

  /** 가드: 첨부 이미지(asset 프로토콜)와 Tauri IPC(connect) 소스가 유지된다. */
  it("keeps asset image and IPC connect sources", () => {
    const d = parseDirectives(readCsp());
    // convertFileSrc 이미지: asset: 와 http://asset.localhost 둘 다 필요(Tauri 문서).
    expect(d["img-src"]).toEqual(
      expect.arrayContaining(["asset:", "http://asset.localhost"]),
    );
    // Tauri IPC: ipc: 와 http://ipc.localhost.
    expect(d["connect-src"]).toEqual(
      expect.arrayContaining(["ipc:", "http://ipc.localhost"]),
    );
  });
});
