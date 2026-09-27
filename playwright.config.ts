import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  reporter: "list",
  use: {
    channel: process.env.CI ? undefined : "chrome",
    baseURL: "http://127.0.0.1:4322",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "PORT=4322 GV_SAMPLE_DB=memory:// npm run dev",
    url: "http://127.0.0.1:4322/health",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
