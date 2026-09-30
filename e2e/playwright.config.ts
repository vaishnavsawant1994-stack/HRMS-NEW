import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000/api";

export { API_URL };

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global.setup.ts",
  fullyParallel: true,

  // Max 2 retries on CI, 0 locally for fast feedback
  retries: process.env.CI ? 2 : 0,

  // 2 workers on CI, 4 locally
  workers: process.env.CI ? 2 : 4,

  // Fail fast on CI — stop after first failure in a file
  forbidOnly: !!process.env.CI,

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ...(process.env.CI ? [["github"] as ["github"]] : []),
  ],

  use: {
    baseURL: BASE_URL,

    // Capture artifacts on failure only
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "on-first-retry",

    // Sensible timeouts
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    // ── Chromium (primary browser) ─────────────────────────────────────────
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },

    // ── API tests (no browser, no auth dependency) ─────────────────────────
    {
      name: "api",
      testMatch: /tests\/api\/.+\.spec\.ts/,
      use: {
        baseURL: API_URL,
      },
    },
  ],

  // Timeout per test
  timeout: 60_000,

  // Global timeout for the whole test run
  globalTimeout: process.env.CI ? 20 * 60_000 : undefined,
});
