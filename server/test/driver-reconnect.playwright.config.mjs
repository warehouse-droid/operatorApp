import {devices} from "@playwright/test";

export default {
  testDir: ".",
  testMatch: ["driver-reconnect/*.spec.js"],
  outputDir: "../test-artifacts/browser-results",
  workers: 1, retries: 0, timeout: 180000,
  expect: {timeout: 15000},
  reporter: [["list"], ["json", {outputFile: "../test-artifacts/browser-report.json"}]],
  webServer: {
    command: "node support/mbt-e2e-trusted-origin-proxy.mjs",
    url: "http://127.0.0.1:3100/health", reuseExistingServer: false, timeout: 30000
  },
  use: {baseURL: "http://127.0.0.1:3100", trace: "on", screenshot: "only-on-failure", serviceWorkers: "block"},
  projects: [
    {name: "aurther-android", use: {...devices["Pixel 7"]}},
    {name: "dao-iphone", use: {...devices["iPhone 15"]}}
  ]
};
