/**
 * memo-plugin CLI — 공유 타입.
 *
 * 왜 별도 파일인가: `validate.ts`·`lint.ts`·`report.ts`가 모두 `Finding`을 쓰는데, 두 커맨드
 * 모듈이 서로를 import하는 순환을 피하려고(lint가 validate를 재사용) 타입만 이 파일로 뺐다.
 */

/** 검사 하나의 결과. `code`는 host.ts `MemoErrorCode`와 같은 정신(안정 상수, 열린 어휘)이지만
 * 브리지 오류가 아니라 CLI 자체의 진단이므로 별도 값 공간이다 — 브리지 코드와 섞지 않는다. */
export interface Finding {
  /** error: CI/종료 코드를 실패시킨다. warn: 보고는 하되 통과시킨다(확신이 덜한 규칙). */
  severity: "error" | "warn";
  code: string;
  /** 사람이 읽는 한국어 설명. */
  message: string;
  /** 플러그인 디렉터리 기준 상대 경로(예: "manifest.json", "main.js"). */
  file?: string;
  /** 1-기준. */
  line?: number;
  /** 1-기준. */
  column?: number;
}
