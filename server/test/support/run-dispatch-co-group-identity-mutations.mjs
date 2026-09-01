// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const IDENTITY = path.resolve("src/dispatch-co-group-identity.js");
const IDENTITY_REPOSITORY = path.resolve("src/dispatch-co-group-identity-repository.js");
const LIFECYCLE = path.resolve("src/dispatch-co-lifecycle.js");
const DISPATCH_REPOSITORY = path.resolve("src/dispatch-repository.js");
const SERVER = path.resolve("src/server.js");
const DISPATCH_CLIENT = path.resolve("public/dispatch.js");
const TESTS = Object.freeze([
  "test/dispatch/unit/dispatch-co-group-identity.red.test.js",
  "test/dispatch/property/dispatch-co-group-identity.property.test.js",
  "test/dispatch/frontend/dispatch-runtime-resilience.red.test.js",
  "test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js",
  "test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "all-CO groups keep the ambiguous GO identity",
    target: IDENTITY,
    from: "    if (!containsCo) continue;",
    to: "    if (true) continue;",
    tests: ["test/dispatch/unit/dispatch-co-group-identity.red.test.js"]
  },
  {
    name: "mixed CO and non-CO groups are accepted",
    target: IDENTITY,
    from: "    if (containsCo && containsNonCo) {",
    to: "    if (false && containsCo && containsNonCo) {",
    tests: ["test/dispatch/property/dispatch-co-group-identity.property.test.js"]
  },
  {
    name: "canonical mapping does not reach semantic snapshot references",
    target: IDENTITY,
    from: "    return mappingsByOldRef.get(text(value).toLowerCase()) || value;",
    to: "    return value;",
    tests: ["test/dispatch/unit/dispatch-co-group-identity.red.test.js"]
  },
  {
    name: "planned CO is incorrectly treated as terminal",
    target: IDENTITY,
    from: "  return [\"completed\", \"received\"].includes(text(status).toLowerCase());",
    to: "  return [\"completed\", \"received\", \"planned\"].includes(text(status).toLowerCase());",
    tests: ["test/dispatch/unit/dispatch-co-group-identity.red.test.js"]
  },
  {
    name: "manual CO grouping omits the CO namespace",
    target: DISPATCH_CLIENT,
    from: "  return allCo ? `CO-${groupedRef}` : groupedRef;",
    to: "  return groupedRef;",
    tests: ["test/dispatch/frontend/dispatch-runtime-resilience.red.test.js"]
  },
  {
    name: "completed hidden CO remains blocked in the browser",
    target: DISPATCH_CLIENT,
    from: `  if (["completed", "received"].includes(status)) return true;
  return allAssignedOrderIds().has(order.transitCo.id) || Boolean(coOrder?.dispatchPlanned);`,
    to: "  return allAssignedOrderIds().has(order.transitCo.id) || Boolean(coOrder?.dispatchPlanned);",
    tests: ["test/dispatch/frontend/dispatch-runtime-resilience.red.test.js"]
  },
  {
    name: "source order payload omits terminal CO evidence",
    target: DISPATCH_REPOSITORY,
    from: `    toYard: row.transit_co_to_yard || "",
    status: row.transit_co_status || "",
    source: "local-db"`,
    to: `    toYard: row.transit_co_to_yard || "",
    source: "local-db"`,
    tests: ["test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js"]
  },
  {
    name: "backend ignores terminal local CO state",
    target: SERVER,
    from: "    if (terminalCoRefs.has(coRef.trim().toLowerCase())) continue;",
    to: "    if (false && terminalCoRefs.has(coRef.trim().toLowerCase())) continue;",
    tests: ["test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js"]
  },
  {
    name: "startup repair skips legacy current plans",
    target: IDENTITY_REPOSITORY,
    from: "      const mappings = dispatchCoGroupIdentityMappings(current);",
    to: "      const mappings = [];",
    tests: ["test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js"]
  },
  {
    name: "aggregate CO parent is required as a nonexistent physical CO row",
    target: LIFECYCLE,
    from: "  if (!isAggregateCoGroup(order)) return refs;",
    to: "  if (true) return refs;",
    tests: ["test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js"]
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch CO group mutations require the writable disposable MBT mutation container.");
}

const originals = new Map();
for (const target of new Set(MUTANTS.map((mutant) => mutant.target))) {
  originals.set(target, await readFile(target, "utf8"));
}
const hashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (original === undefined || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(mutant.target, original.replace(mutant.from, mutant.to), "utf8");
    const result = await runNodeTestFilesIsolated([...mutant.tests], {
      environment: process.env,
      label: `Dispatch CO group mutant: ${mutant.name}`
    });
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regressions.`);
    }
    killed += 1;
    process.stdout.write(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}\n`);
    await writeFile(mutant.target, original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
    if (sha256(await readFile(target, "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed: ${target}`);
    }
  }
}

const finalResult = await runNodeTestFilesIsolated([...TESTS], {
  environment: process.env,
  label: "Dispatch CO group post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Dispatch CO group tests failed after restoring mutation sources.");
}
process.stdout.write(`Dispatch CO group mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.\n`);
