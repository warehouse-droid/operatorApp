import config from "./playwright.config.mjs";

export default {
  ...config,
  outputDir: "../test-artifacts/consolidation-load/e2e/browser",
  reporter: [
    ["list"],
    ["json", { outputFile: "../test-artifacts/consolidation-load/e2e/browser-report.json" }]
  ]
};
