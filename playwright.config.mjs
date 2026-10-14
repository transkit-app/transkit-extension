import { defineConfig } from "@playwright/test";
import { PORT } from "./tests/e2e/constants.mjs";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Each test launches its own browser with the extension loaded
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: `http://127.0.0.1:${PORT}/hostile.html`,
    reuseExistingServer: !process.env.CI
  }
});
