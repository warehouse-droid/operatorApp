import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const status = await runNodeTestFilesIsolated([
  "test/mbt/integration/smart-scm-vendor-unit-price.test.js",
  "src/smart-scm-blanket-workflow-harness.js"
], {
  environment: process.env,
  label: "Vendor Replies unit-price database regressions"
});

process.exitCode = status;
