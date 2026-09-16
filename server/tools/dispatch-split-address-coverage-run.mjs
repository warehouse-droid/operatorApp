import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const tests = ["frontend", "unit", "integration"].map(group => `test/dispatch/${group}/dispatch-split-address.test.js`);
tests.push("test/dispatch/integration/dispatch-split-address-http.test.js");
for (const args of [["tools/dispatch-split-address-files.mjs", ...tests],
  ["src/dispatch-sales-split-materialization-harness.js"], ["src/dispatch-stop-visit-harness.js"]]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  assert.equal(result.status, 0, args.join(" "));
}
