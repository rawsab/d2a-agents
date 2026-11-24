import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1, // the e2e extension build talks to one fixed server port
  timeout: 60_000,
  // *.live.spec.ts hit real websites; opt in with LIVE=1.
  testIgnore: process.env.LIVE ? [] : ["**/*.live.spec.ts"],
});
