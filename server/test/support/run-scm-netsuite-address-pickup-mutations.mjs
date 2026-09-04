// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const NON_DATABASE_TESTS = Object.freeze([
  "test/dispatch/frontend/scm-schedule-status-save.test.js",
  "test/dispatch/property/scm-po-pickup-save-policy.property.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/dispatch/integration/scm-po-netsuite-address-pickup.red.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "NetSuite-address fallback is never recognized",
    target: "src/scm-po-pickup-save-policy.js",
    from: "  return samePickup(requested, netSuiteAddressVendor);",
    to: "  return false;"
  },
  {
    name: "stored legacy pickup is revalidated as a new route",
    target: "src/scm-po-pickup-save-policy.js",
    from: "  if (stored) return samePickup(requested, stored);",
    to: "  if (stored) return false;"
  },
  {
    name: "PO Schedule resubmits an unchanged pickup",
    target: "public/scm-schedule.js",
    from: "    if (!unchangedPoPickup) patch[field.dataset.field] = value;",
    to: "    patch[field.dataset.field] = value;"
  },
  {
    name: "PO Schedule edits a pickup with no configured options",
    target: "public/scm-schedule.js",
    from: "        <div class=\"scm-sheet-cell\">${rowEditable && rowPickupOptions.length",
    to: "        <div class=\"scm-sheet-cell\">${rowEditable"
  },
  {
    name: "cached-client fallback becomes a stored pickup override",
    target: "src/dispatch-repository.js",
    from: "      next.pickupPoint = String(current.pickup_point || \"\").trim();",
    to: "      next.pickupPoint = String(next.pickupPoint || \"\").trim();"
  },
  {
    name: "unrelated pickup bypasses server validation",
    target: "src/dispatch-repository.js",
    from: "      if (!unchanged) {",
    to: "      if (false && !unchanged) {"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function runNonDatabaseTests() {
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...NON_DATABASE_TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/** @param {string} label */
async function runFocusedTests(label) {
  const nonDatabase = runNonDatabaseTests();
  if (nonDatabase !== 0) {
    return nonDatabase;
  }
  return runNodeTestFilesIsolated([...DATABASE_TESTS], {
    environment: process.env,
    label
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("NetSuite-address pickup mutations require a writable disposable MBT test container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string") {
      throw new Error(`Missing mutation source ${mutant.target}.`);
    }
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    const result = await runFocusedTests(`NetSuite-address pickup mutant: ${mutant.name}`);
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    const restored = await readFile(path.resolve(target), "utf8");
    if (sha256(restored) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (killed !== MUTANTS.length) {
  throw new Error(`NetSuite-address pickup mutation score ${killed}/${MUTANTS.length}.`);
}
const finalResult = await runFocusedTests("NetSuite-address pickup post-mutation green");
if (finalResult !== 0) {
  throw new Error("Focused tests failed after restoring mutation sources.");
}
console.log(`NetSuite-address pickup mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
