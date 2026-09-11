// Explicitly retain, rerun and compare unrelated pre-existing failures. This
// does not mark those tests passed or alter their assertions.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [mode, prefix] = process.argv.slice(2);
assert.ok(mode === "baseline" || mode === "candidate");
const result = spawnSync(process.execPath, ["test/support/run-co-cargo-tests.mjs", "ordered",
  "test/dispatch/integration/dispatch-required-pickups-save.test.js", "src/dispatch-driver-order-harness.js"],
{ encoding: "utf8", env: process.env, timeout: 120000 });
assert.equal(result.error, undefined);
fs.writeFileSync(`${prefix}-${mode}.log`, result.stdout + result.stderr);
assert.equal(result.status, 1, "Known-baseline inventory changed; investigate instead of silently waiving");
const failures = [...new Set([...result.stdout.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map((match) => match[1]))].sort();
const expected = ["/app/src/dispatch-driver-order-harness.js",
  "incremental group save refreshes cancelled PO allocations after the global definition is reloaded",
  "incremental group save refreshes full PO allocations after the global definition is reloaded",
  "incremental group save refreshes partial PO allocations after the global definition is reloaded"].sort();
assert.deepEqual(failures, expected);
assert.match(result.stdout, /Dispatch planner browser asset version was not bumped/u);
assert.match(result.stdout, /DISPATCH_PICKUP_ORDER_MISSING/u);
if (mode === "candidate") {
  assert.deepEqual(failures, JSON.parse(fs.readFileSync(`${prefix}-baseline.json`, "utf8")));
}
fs.writeFileSync(`${prefix}-${mode}.json`, JSON.stringify(failures));
console.log(JSON.stringify({ mode, unchangedKnownFailures: failures, newFailures: 0 }));
