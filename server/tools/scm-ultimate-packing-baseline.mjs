import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = ["test/mbt/unit/scm-ultimate-packing.test.js",
  "test/mbt/property/scm-ultimate-packing.property.test.js",
  "test/mbt/integration/scm-ultimate-packing.test.js"];
const red = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files],
  { encoding: "utf8", timeout: 120000 });
const output = `${red.stdout || ""}${red.stderr || ""}`;
writeFileSync("test-artifacts/scm-ultimate-packing-20261005/red-complete.log", output);
assert.notEqual(red.status, 0);
assert.ok(/ERR_ASSERTION/.test(output));
assert.equal(/ERR_MODULE_NOT_FOUND|SyntaxError/.test(output), false);
console.log(JSON.stringify({ redExitCode: red.status, behaviorFailures: [...output.matchAll(/^not ok /gm)].length }));
const baseline = spawnSync(process.execPath, ["tools/scm-ultimate-packing-suites.mjs", "baseline"],
  { stdio: "inherit", timeout: 900000 });
assert.equal(baseline.status, 0);
