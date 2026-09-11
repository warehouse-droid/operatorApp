import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(process.env.MBT_MUTATION_EPHEMERAL, "1");
const property = "test/dispatch/property/transfer-completed-unlink.property.test.js";
const integration = "test/dispatch/integration/transfer-completed-unlink.test.js";
const mutants = [
  { name: "allow changes other than unlink", file: "src/scm-dependency-management-policy.js", from: 'action === "unlink_to" && !activeDriverWork', to: 'true && !activeDriverWork' },
  { name: "ignore active transfer work", file: "src/scm-dependency-management-policy.js", from: '&& !activeDriverWork &&', to: '&& true &&' },
  { name: "require both completion sources", file: "src/scm-dependency-management-policy.js", from: '(receiptComplete || completedDrop)', to: '(receiptComplete && completedDrop)' },
  { name: "pickup completion mistaken for drop", file: "src/order-dependency-repository.js", from: "AND lower(job.stop_type) = 'dropoff'", to: "AND lower(job.stop_type) IN ('pickup', 'dropoff')" },
  { name: "lose save date again", file: "src/dispatch-plan-repository.js", from: 'await sanitizeDispatchPlan({\n        id: String(planId),\n        planDate: expectedPlanDate,', to: 'await sanitizeDispatchPlan({\n        id: String(planId),' }
];
const originals = new Map(mutants.map((m) => [m.file, fs.readFileSync(m.file, "utf8")]));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function run(files) {
  return spawnSync(process.execPath, ["test/support/run-co-cargo-tests.mjs", "ordered", ...files], {
    encoding: "utf8", timeout: 120000, env: process.env
  });
}
const results = [];
try {
  const baseline = run([integration, property]);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const mutant of mutants) {
    const original = originals.get(mutant.file);
    assert.equal(original.split(mutant.from).length, 2, mutant.name);
    fs.writeFileSync(mutant.file, original.replace(mutant.from, mutant.to));
    const all = run([integration, property]);
    const propertyOnly = run([property]);
    fs.writeFileSync(mutant.file, original);
    assert.equal(all.error, undefined);
    assert.equal(propertyOnly.error, undefined);
    assert.notEqual(all.status, 0, `survived: ${mutant.name}`);
    assert.notEqual(propertyOnly.status, 0, `property-only survived: ${mutant.name}`);
    results.push({ name: mutant.name, killed: true, propertyOnlyKilled: true });
  }
} finally {
  for (const [file, original] of originals) {
    fs.writeFileSync(file, original);
    assert.equal(hash(fs.readFileSync(file)), hash(original));
  }
}
const restored = run([integration, property]);
assert.equal(restored.status, 0, restored.stdout + restored.stderr);
console.log(JSON.stringify({ mutants: results.length, results }));
