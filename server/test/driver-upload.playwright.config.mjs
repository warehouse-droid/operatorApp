import {devices} from "@playwright/test";

export default {
  testDir: "./driver-upload",
  outputDir: "../test-artifacts/browser-results",
  workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
  timeout: 240000, expect: {timeout: 15000},
  reporter: [["list"], ["json", {outputFile: "../test-artifacts/browser-report.json"}]],
  webServer: {
    command: "node support/mbt-e2e-trusted-origin-proxy.mjs",
    url: "http://127.0.0.1:3100/health", reuseExistingServer: false, timeout: 30000
  },
  use: {baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure", serviceWorkers: "block"},
  projects: [
    {name: "chromium-mobile", use: {...devices["Pixel 7"]}},
    {name: "webkit-mobile", use: {...devices["iPhone 15"]}}
  ]
};
