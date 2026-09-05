import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Артефакты браузерных прогонов.
    "test-results/**",
    "playwright-report/**",
  ]),
  {
    // Фикстуры Playwright объявляются как { context: async ({ context }, use) }.
    // Правило хуков видит вызов `use(...)` и считает функцию сломанным React-хуком,
    // хотя React здесь нет вовсе: браузерные тесты — обычный Node-код.
    files: ["e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
]);

export default eslintConfig;
