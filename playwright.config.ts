import { defineConfig } from "@playwright/test";
const port = Number(process.env.GV_BROWSER_PORT || 4322);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid GV_BROWSER_PORT");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  reporter: "list",
  use: {
    channel: process.env.CI ? undefined : "chrome",
    baseURL,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `PORT=${port} GV_SAMPLE_DB=memory:// npm run dev`,
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
