import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const unit = ["test/mbt/unit", "test/mbt/property"].flatMap((directory) => readdirSync(directory)
  .filter((name) => /^(smart-scm|transfer-dependency).*\.js$/.test(name)).map((name) => `${directory}/${name}`));
unit.push("src/smart-scm-pallet-override-harness.js", "src/smart-scm-vendor-ui-harness.js", "src/smart-scm-calculation-ui-harness.js");
if (process.argv.includes("--reverse")) unit.reverse();
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...unit], { stdio: "inherit" });
assert.equal(result.status, 0, "all affected unit and property regressions pass");
if (!process.argv.includes("--reverse")) {
  const status = await runNodeTestFilesIsolated([
    "test/mbt/integration/smart-scm-line-order.test.js",
    "test/mbt/integration/smart-scm-vendor-unit-price.test.js",
    "src/smart-scm-vendor-workflow-harness.js",
    "src/smart-scm-purchase-review-harness.js",
    "src/smart-scm-vendor-hold-split-harness.js",
    "src/smart-scm-purchase-conservation-harness.js"
  ], { environment: process.env, label: "SCM order persistence and vendor lifecycle" });
  assert.equal(status, 0, "all affected database lifecycle regressions pass");
}
