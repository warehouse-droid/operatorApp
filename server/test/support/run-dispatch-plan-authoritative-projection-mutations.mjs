// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceUrl = new URL("../../src/dispatch-plan-order-projection.js", import.meta.url);
const tests = Object.freeze([
  "test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js",
  "test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js",
  "test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js"
]);

const mutants = Object.freeze([
  {
    name: "stale relationship pickup locations are never removed",
    from: "      if (!wasProjected) return true;",
    to: "      if (wasProjected) return true;"
  },
  {
    name: "a native pickup matching a relationship manifest is erased",
    from: "      return nativeLocations.some((candidate) => scmDependencyLocationsMatch(candidate, location));",
    to: "      return false;"
  },
  {
    name: "a current order projection skips route-only reconciliation",
    from: "    affectedTargetRefs: allLogicalRefs(projectedOrders)",
    to: "    affectedTargetRefs: affectedOrderRefs"
  },
  {
    name: "route caches survive a changed authoritative projection",
    from: "    plan: invalidateAffectedRoutes(reconciled, routeMetadataAffectedRefs, changedLoadKeys),",
    to: "    plan: reconciled,"
  },
  {
    name: "the stale plan order wins over the database projection",
    from: "    enrichedOrders: projectedOrders,",
    to: "    enrichedOrders: candidatePlan.orders || [],"
  },
  {
    name: "PO item allocation annotations survive relationship removal",
    from: "  for (const field of PO_ITEM_PROJECTION_FIELDS) delete next[field];",
    to: "  for (const field of []) delete next[field];"
  }
]);

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[Authoritative projection mutation] ${label}\n`);
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    cwd: serverRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 120_000
  });
}

/** @param {string} label */
function assertGreen(label) {
  const result = runTests(label);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${label}: focused mutation suite did not pass.`);
  }
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Authoritative projection mutations require an isolated writable source copy.");
}

const original = await readFile(sourceUrl, "utf8");
const originalHash = digest(original);
assertGreen("baseline");

let killed = 0;
try {
  for (const mutant of mutants) {
    if (occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(sourceUrl, original.replace(mutant.from, mutant.to), "utf8");
    const result = runTests(mutant.name);
    await writeFile(sourceUrl, original, "utf8");
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      throw new Error(`SURVIVED: ${mutant.name}`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutants.length}: ${mutant.name}`);
  }
} finally {
  await writeFile(sourceUrl, original, "utf8");
  if (digest(await readFile(sourceUrl, "utf8")) !== originalHash) {
    throw new Error("Authoritative projection mutation source restoration failed.");
  }
}

assertGreen("restored source");
console.log(`Authoritative projection mutation score: ${killed}/${mutants.length} killed.`);
