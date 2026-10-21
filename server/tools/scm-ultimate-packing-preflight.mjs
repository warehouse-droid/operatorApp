import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const directory = "test-artifacts/scm-ultimate-packing-20261005";
const files = ["test/mbt/unit/scm-ultimate-packing.test.js", "test/mbt/property/scm-ultimate-packing.property.test.js",
  "test/mbt/integration/scm-ultimate-packing.test.js"];
for (const [label, args] of [["expanded-green", ["--test", "--test-concurrency=1", ...files]],
  ["static-preflight", ["tools/scm-ultimate-packing-static.mjs"]]]) {
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
  writeFileSync(`${directory}/${label}.log`, `${run.stdout || ""}${run.stderr || ""}`);
  console.log(JSON.stringify({ label, exitCode: run.status }));
  assert.equal(run.status, 0, `${label} failed`);
}
