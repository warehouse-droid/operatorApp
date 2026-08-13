import { devices } from "@playwright/test";

const trustedProxyTarget = process.env.MBT_TEST_TRUSTED_PROXY_TARGET || "";
const trustedProxyPort = process.env.MBT_TEST_TRUSTED_PROXY_PORT || "3100";

export default {
  testDir: "./mbt/e2e",
  outputDir: "../test-artifacts/playwright/results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "../test-artifacts/playwright/report.json" }]
  ],
  ...(trustedProxyTarget ? {
    webServer: {
      command: "node support/mbt-e2e-trusted-origin-proxy.mjs",
      url: `http://127.0.0.1:${trustedProxyPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    }
  } : {}),
  use: {
    baseURL: process.env.MBT_TEST_BASE_URL || "http://app:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium-desktop",
      testIgnore: /driver-pwa-cache-repair\.spec\.js/u,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "chromium-mobile",
      testIgnore: /driver-pwa-cache-repair\.spec\.js/u,
      use: { ...devices["Pixel 7"] }
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 15"] }
    }
  ]
};
