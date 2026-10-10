import { defineConfig } from "@playwright/test";
import { testOrigin, testPort } from "./tests/browser/test-origin";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  reporter: "list",
  use: {
    channel: process.env.CI ? undefined : "chrome",
    baseURL: testOrigin,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `PORT=${testPort} GV_SAMPLE_DB=memory:// npm run dev`,
    url: `${testOrigin}/health`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
