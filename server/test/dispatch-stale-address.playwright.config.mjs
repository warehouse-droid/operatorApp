import { devices } from "@playwright/test";
export default {
  testDir: "./mbt/e2e", testMatch: "dispatch-stale-address.spec.js", retries: 0, workers: 1,
  outputDir: "../test-artifacts/stale-address/browser-results",
  reporter: [["list"], ["json", { outputFile: "../test-artifacts/stale-address/browser-report.json" }]],
  webServer: { command: "node test/support/operator-ui-static-server.mjs", cwd: new URL("..", import.meta.url).pathname, url: "http://127.0.0.1:3000/health", timeout: 30000 },
  use: { baseURL: "http://127.0.0.1:3000", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }]
};
