/**
 * CSP 실측 픽스처 — 프로덕션 정책(tauri.conf.json)을 `<meta http-equiv>`로 복제 주입하고
 * WebKit에서 위반을 수집한다.
 *
 * 역할: vite dev 서버는 tauri.conf의 CSP를 안 태우므로, 프로덕션과 **같은 정책 문자열**을
 * 문서 HTML의 `<head>` 맨 앞에 파서-삽입(라우트 가로채기)해 실제 브라우저 강제를 재현한다.
 * 위반은 (1) 문서의 `securitypolicyviolation` 이벤트(window.__csp)와 (2) 프레임 콘솔의 CSP
 * 거부 메시지 양쪽으로 잡는다 — 샌드박스 iframe(불투명 origin) 내부 위반은 부모 이벤트로
 * 오지 않으므로 콘솔까지 본다.
 * 왜: "좁힌 CSP에서 샌드박스 부트스트랩·blob 스크립트·임베드·CM 스타일이 위반 0으로
 * 동작한다"를 문서가 아니라 실측으로 증명하기 위함.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 프로덕션 CSP 문자열(단일 출처 — tauri.conf.json에서 직접 읽는다). */
export const PROD_CSP: string = (() => {
  const confPath = resolve(HERE, "../../src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app?: { security?: { csp?: unknown } };
  };
  const csp = conf.app?.security?.csp;
  if (typeof csp !== "string" || csp.length === 0) {
    throw new Error(
      "tauri.conf.json app.security.csp가 비어 있음(문자열 정책 필요)",
    );
  }
  return csp;
})();

/**
 * 프로덕션 정책에서 `script-src`의 `blob:`만 제거한 변형 정책을 만든다(네거티브 컨트롤용).
 *
 * 역할: 이 변형으로는 플러그인 코드(blob 스크립트) 로드가 CSP에 거부돼야 한다 — "정상
 * 경로의 위반 0"이 수집기 사망이 아니라 진짜 0임을 자기검사로 고정하는 데 쓴다.
 * 왜: `blob:` 하나만 빼서 다른 조건은 프로덕션과 동일하게 두어야, 잡히는 위반이 정확히
 * "plugin blob 스크립트 거부"임을 좁게 단정할 수 있다.
 */
export function cspWithoutScriptBlob(csp: string = PROD_CSP): string {
  return csp.replace(/(script-src[^;]*?)\s+blob:/, (_m, head: string) => head);
}

/** 수집된 CSP 위반 한 건(문서 이벤트 + 프레임 콘솔 통합 형태). */
export interface CspViolation {
  /** 위반 출처: "event"(securitypolicyviolation) | "console"(프레임 콘솔 거부 메시지). */
  from: "event" | "console";
  /** 위반한 지시어 또는 원본 메시지. */
  detail: string;
}

/**
 * 문서 HTML의 `<head>` 맨 앞에 프로덕션 CSP를 meta로 파서-삽입한다(라우트 가로채기).
 *
 * 파서가 이 meta를 먼저 만나야 이후 인라인/외부 스크립트에 정책이 강제된다 — 그래서 JS로
 * 나중에 삽입하지 않고 응답 본문을 고쳐 넣는다. 문서 요청(navigation)만 대상으로 한다.
 */
async function injectCspMeta(page: Page, csp: string): Promise<void> {
  await page.route("**/*", async (route) => {
    // 문서 이외(스크립트·이미지·임베드 스텁 등)는 다른 라우트/네트워크로 넘긴다.
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    const html = await res.text();
    const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
    // <head> 바로 뒤(또는 없으면 맨 앞)에 삽입한다.
    const patched = html.includes("<head>")
      ? html.replace("<head>", `<head>${meta}`)
      : `${meta}${html}`;
    return route.fulfill({ response: res, body: patched });
  });
}

/**
 * 페이지에 CSP 위반 수집기를 설치한다(반환된 getter로 누적 위반을 읽는다).
 *
 * 문서 이벤트(window.__csp)와 모든 프레임의 콘솔 CSP 거부 메시지를 함께 모은다.
 * `installTauriMock`보다 먼저 호출해도 되고 뒤여도 되지만, `page.goto` 전에는 호출해야 한다.
 */
export async function collectCspViolations(
  page: Page,
  csp: string = PROD_CSP,
): Promise<() => CspViolation[]> {
  const violations: CspViolation[] = [];

  // (1) 최상위 문서의 구조화 위반 이벤트를 window.__csp에 모은다.
  await page.addInitScript(() => {
    const store: { violatedDirective: string; blockedURI: string }[] = [];
    (window as unknown as { __csp: typeof store }).__csp = store;
    document.addEventListener("securitypolicyviolation", (e) => {
      store.push({
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
      });
    });
  });

  // (2) 프레임 콘솔의 CSP 거부 메시지(샌드박스 iframe 등 하위 프레임 포함).
  const CSP_RE =
    /Content Security Policy|Refused to (load|execute|apply|connect|frame)|violates the following/i;
  page.on("console", (msg) => {
    const text = msg.text();
    if (CSP_RE.test(text)) violations.push({ from: "console", detail: text });
  });
  page.on("pageerror", (err) => {
    if (CSP_RE.test(err.message)) {
      violations.push({ from: "console", detail: err.message });
    }
  });

  await injectCspMeta(page, csp);

  return () => {
    // 최상위 문서 이벤트를 병합해 돌려준다(중복 없이 누적).
    return violations.slice();
  };
}

/** 최상위 문서에 쌓인 securitypolicyviolation 이벤트를 읽는다(구조화). */
export async function documentCspEvents(
  page: Page,
): Promise<{ violatedDirective: string; blockedURI: string }[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __csp?: { violatedDirective: string; blockedURI: string }[];
        }
      ).__csp ?? [],
  );
}
