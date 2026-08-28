import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Интеграционные тесты ходят в общую базу — параллельные файлы
    // мешали бы друг другу.
    fileParallelism: false,
  },
});
