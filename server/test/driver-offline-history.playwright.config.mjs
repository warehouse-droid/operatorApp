import { devices } from "@playwright/test";

const trustedProxyTarget = process.env.MBT_TEST_TRUSTED_PROXY_TARGET || "";
const trustedProxyPort = process.env.MBT_TEST_TRUSTED_PROXY_PORT || "3100";

function project(name, device) {
  return {
    name,
    grep: new RegExp(`@${name}(?:\\s|$)`, "u"),
    use: { ...devices[device] }
  };
}

export default {
  testDir: "./driver-offline-history",
  testMatch: "historical-route-offline.spec.js",
  outputDir: "../test-artifacts/driver-offline-history/playwright-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: "../test-artifacts/driver-offline-history/report.json" }]],
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
    video: "off",
    serviceWorkers: "block"
  },
  projects: [
    project("chromium-mobile", "Pixel 7"),
    project("webkit-mobile", "iPhone 15")
  ]
};
