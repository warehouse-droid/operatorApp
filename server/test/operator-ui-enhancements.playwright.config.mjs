import config from "./playwright.config.mjs";

export default {
  ...config,
  outputDir: "../test-artifacts/operator-ui-enhancements/browser",
  reporter: [
    ["list"],
    ["json", { outputFile: "../test-artifacts/operator-ui-enhancements/browser-report.json" }]
  ]
};
