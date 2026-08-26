import { defineConfig, devices } from "@playwright/test";

// 프론트엔드 UI e2e 설정.
//
// 역할: vite dev 서버를 띄우고 WebKit(맥 WKWebView에 가장 근접한 엔진)에서
// 프론트 UI를 검증한다. 에디터·라이브프리뷰·툴바·테마·플러그인 위젯 등 웹 UI
// 대부분을 커버한다.
// 한계: 투명도·always-on-top·모든 Space·IME 같은 네이티브 창 동작은 브라우저로
// 재현 불가 → 해당 항목은 computer-use 스크린샷으로 수동 검증한다.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    // UI 언어를 결정론으로 고정한다(이슈 #30 — 언어 미설정이면 `navigator.language`로
    // ko/en을 자동 판정한다: `src/i18n/detect.ts`). 이 값을 안 박으면 실행 환경의 로케일이
    // 곧 UI 언어가 되어, 한국어 문구를 기대하는 어서션이 CI(영어 러너)에서만 무더기로
    // 깨진다. 앱 기본값(=번역 원본)이 한국어이므로 ko-KR로 고정하고, 자동 감지 자체는
    // `e2e/i18n.spec.ts`가 `test.use({ locale })`로 두 방향 모두 따로 검증한다.
    locale: "ko-KR",
  },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
