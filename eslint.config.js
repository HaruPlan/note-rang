import js from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

// 프론트엔드 TypeScript 린트 설정 (flat config).
// 역할: 공통 코드 스타일 강제 + 미사용 import/변수 차단(품질 게이트).
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src-tauri/**",
      "node_modules/**",
      ".claude/**",
      "*.config.js",
      // 번들 플러그인 코드는 샌드박스에서 도는 아티팩트다(memo 전역 사용, app 소스 아님).
      // 외부 플러그인을 호스트 규칙으로 린트하지 않듯 제외한다. 저작 예제(docs/plugin/examples)의
      // main.js도 같은 샌드박스 아티팩트이고 `/// <reference>`로 스펙을 참조하므로 같이 제외한다.
      "src/plugin/builtin/**/main.js",
      "docs/plugin/examples/**/main.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "unused-imports": unusedImports },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
);
