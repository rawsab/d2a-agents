import { defineConfig } from "vitest/config";

export default defineConfig({
  // e2e/*.spec.ts are Playwright tests.
  test: { include: ["packages/**/*.test.ts", "apps/**/*.test.ts"] },
});
