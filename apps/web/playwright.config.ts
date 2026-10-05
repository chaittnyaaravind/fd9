import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev -w apps/signaling",
      cwd: "../../",
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000
    },
    {
      command: "npm run dev -w apps/web -- --port 5173",
      cwd: "../../",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000
    }
  ]
});
