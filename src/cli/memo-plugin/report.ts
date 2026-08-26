/**
 * memo-plugin CLI — 검사 결과 보고 형식(사람용 텍스트 / 기계용 JSON).
 *
 * 역할: `validate`·`lint`가 만든 [`Finding`] 목록을 두 형태로 렌더링한다. `--json`은 AI
 * 저작자·CI가 파싱하는 창구이므로 필드명·구조를 안정적으로 유지한다(host.ts의
 * `MemoErrorCode`처럼 code는 열거를 늘려도 되지만 필드 자체는 바뀌지 않는다).
 */
import type { Finding } from "./types.ts";

/** 종료 코드: error 등급이 하나라도 있으면 1(CI 실패), 없으면 0(warn만 있어도 통과 —
 * 정확도를 100% 확신 못 하는 규칙은 warn으로 두고 빌드를 막지 않는다). */
export function exitCodeFor(findings: Finding[]): 0 | 1 {
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}

/** 사람이 읽는 텍스트 보고. 파일:줄:열 형태로 위치를 표시하고 severity별로 묶는다.
 * `extraLines`(선택)는 findings와 별개인 정보(예: scaffold/types가 실제로 쓴 파일 목록)를
 * findings 유무와 무관하게 덧붙인다 — 이후 명령들이 report.ts를 재사용하려고 추가했다(findings
 * 형식을 또 하나 만들지 않는다). */
export function formatText(
  command: string,
  dir: string,
  findings: Finding[],
  extraLines?: string[],
): string {
  const lines: string[] =
    findings.length === 0
      ? [`✓ ${command} ${dir} — 문제 없음`]
      : (() => {
          const errors = findings.filter((f) => f.severity === "error");
          const warns = findings.filter((f) => f.severity === "warn");
          const out: string[] = [
            `${command} ${dir} — 오류 ${errors.length}건, 경고 ${warns.length}건`,
            "",
          ];
          for (const f of findings) {
            const loc =
              f.file !== undefined
                ? f.line !== undefined
                  ? ` (${f.file}:${f.line}:${f.column ?? 1})`
                  : ` (${f.file})`
                : "";
            const tag = f.severity === "error" ? "오류" : "경고";
            out.push(`[${tag}] ${f.code}${loc}`);
            out.push(`  ${f.message}`);
          }
          return out;
        })();
  if (extraLines !== undefined && extraLines.length > 0) {
    if (findings.length > 0) lines.push("");
    lines.push(...extraLines);
  }
  return lines.join("\n");
}

/** 기계가 읽는 JSON 보고. `ok`는 error 등급 부재 여부(경고만 있어도 true). `extra`(선택)는
 * 고정 필드(command/dir/ok/errorCount/warnCount/findings) 옆에 명령별 필드를 더한다 —
 * `formatText`의 `extraLines`와 같은 이유. */
export function formatJson(
  command: string,
  dir: string,
  findings: Finding[],
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify(
    {
      command,
      dir,
      ok: exitCodeFor(findings) === 0,
      errorCount: findings.filter((f) => f.severity === "error").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
      findings,
      ...(extra ?? {}),
    },
    null,
    2,
  );
}
