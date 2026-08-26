import { defineConfig } from "vitest/config";

// 프론트엔드 단위 테스트 설정.
// 역할: jsdom 환경에서 *.test.ts 가드 테스트를 실행한다.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
