import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Mutation requires isolated disposable writable source copies.");
}
const frontend = "test/dispatch/frontend/dispatch-co-cargo-preservation.test.js";
const property = "test/dispatch/property/dispatch-co-cargo-preservation.property.test.js";
const mutants = [
  { name: "mislabel source children as CO", file: "public/dispatch.js", from: 'fallbackType === "CO" ? "" : fallbackType', to: "fallbackType", tests: [frontend], propertyOnly: true },
  { name: "retain empty child details during hydration", file: "public/dispatch.js", from: '!(authoritativeLocalCo && ["childOrders", "childOrderDetails", "groupAliases", "isGrouped"].includes(key))', to: "true", tests: [frontend], propertyOnly: true },
  { name: "zero restored pallet quantities", file: "src/dispatch-local-co-cargo.js", from: 'pallets: Number(line.pallet_qty || 0)', to: "pallets: 0", tests: [property], propertyOnly: true },
  { name: "overwrite locked executed cargo", file: "src/dispatch-local-co-cargo.js", from: "record.cargoLocked || !Array.isArray(record.cargoLines)", to: "false || !Array.isArray(record.cargoLines)", tests: [property], propertyOnly: true },
  { name: "accept cargo from a different CO", file: "src/dispatch-local-co-cargo.js", from: 'if (String(order.id || "").toLowerCase() !== String(record.coRef || "").toLowerCase()) return order;', to: "if (false) return order;", tests: [property], propertyOnly: true },
  { name: "leak source PO allocations into CO cargo", file: "src/dispatch-local-co-cargo.js", from: '!key.startsWith("poAllocated")', to: "true", tests: [property], propertyOnly: true }
];
const originals = new Map(mutants.map((m) => [m.file, fs.readFileSync(m.file, "utf8")]));
/** @param {string|Buffer} value */
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
/** @param {string[]} files */
function run(files, propertyOnly = false) {
  return spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=1000"] : []), ...files], {
    encoding: "utf8", timeout: 120000, env: process.env
  });
}
const results = [];
try {
  assert.equal(run([frontend, property]).status, 0, "mutation baseline must be green");
  for (const mutant of mutants) {
    const original = originals.get(mutant.file);
    assert.ok(original, `missing original: ${mutant.file}`);
    assert.equal(original.split(mutant.from).length - 1, 1, `unique mutation site: ${mutant.name}`);
    fs.writeFileSync(mutant.file, original.replace(mutant.from, mutant.to));
    const outcome = run(mutant.tests);
    const propertyOutcome = run(mutant.tests, mutant.propertyOnly);
    fs.writeFileSync(mutant.file, original);
    assert.equal(outcome.error, undefined);
    assert.equal(propertyOutcome.error, undefined);
    assert.notEqual(outcome.status, 0, `survived: ${mutant.name}`);
    assert.notEqual(propertyOutcome.status, 0, `property-only survived: ${mutant.name}`);
    results.push({ name: mutant.name, killed: true, propertyOnlyKilled: true });
  }
} finally {
  for (const [file, original] of originals) {
    fs.writeFileSync(file, original);
    assert.equal(hash(fs.readFileSync(file)), hash(original));
  }
}
assert.equal(run([frontend, property]).status, 0, "restored suite must be green");
console.log(JSON.stringify({ manualMutants: results.length, killed: results.length, propertyOnlyKilled: results.length, results }));
