// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/scm-split-receipt-allocation.red.test.js",
  "test/mbt/property/scm-split-receipt-allocation.property.test.js",
  "test/mbt/integration/scm-split-receipt-allocation.red.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "known receipt locations use the legacy cross-yard allocator",
    target: "src/scm-split-receipt-allocation.js",
    from: "  if (!quantitiesByLocation.size) {",
    to: "  if (true) {"
  },
  {
    name: "destination eligibility accepts every split target",
    target: "src/scm-split-receipt-allocation.js",
    from: "      (target) => target.destinationLocationId === locationId",
    to: "      () => true"
  },
  {
    name: "known-location budget is discarded",
    target: "src/scm-split-receipt-allocation.js",
    from: "      Math.max(knownQuantityBudget, 0)",
    to: "      0"
  },
  {
    name: "receipt rows above authoritative total are accepted",
    target: "src/scm-split-receipt-allocation.js",
    from: "  let overflowQty = roundReconciliationQuantity(Math.max(observedRowTotal - total, 0));",
    to: "  let overflowQty = 0;"
  },
  {
    name: "known-location quantity is also reallocated as unlocated",
    target: "src/scm-split-receipt-allocation.js",
    from: "  const unlocatedQty = roundReconciliationQuantity(Math.max(total - allocatedKnownBudget, 0));",
    to: "  const unlocatedQty = total;"
  },
  {
    name: "unallocated exact child evidence no longer conflicts",
    target: "src/scm-split-receipt-allocation.js",
    from: "  conflict ||= unallocatedExactQty > EPSILON;",
    to: "  conflict ||= false;"
  },
  {
    name: "repository bypasses destination-aware PO allocation",
    target: "src/scm-reconciliation-repository.js",
    from: "    const receivedAllocation = order.kind === \"PO\"",
    to: "    const receivedAllocation = order.kind === \"PO_DISABLED\""
  },
  {
    name: "split target destination is forced to the parent yard",
    target: "src/scm-reconciliation-repository.js",
    from: "              COALESCE(child_line.location_id, child.destination_location_id) AS target_destination_location_id,",
    to: "              1 AS target_destination_location_id,"
  }
]);

/** @param {string} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[SCM split receipt mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("SCM split receipt mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, hash(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (hash(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`SCM split receipt mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
