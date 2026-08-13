// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const PLAN_REPOSITORY = path.resolve("src/dispatch-plan-repository.js");
const V2_REPOSITORY = path.resolve("src/dispatch-planner-v2-repository.js");
const TESTS = Object.freeze([
  "test/dispatch/property/dispatch-v2-summary-marker.property.test.js",
  "test/dispatch/integration/dispatch-v2-summary-marker.red.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "summary marker regresses to version one",
    target: PLAN_REPOSITORY,
    from: "const DISPATCH_PLAN_V2_VERSION = 2;",
    to: "const DISPATCH_PLAN_V2_VERSION = 1;"
  },
  {
    name: "new schema-v2 snapshots persist an empty summary",
    target: PLAN_REPOSITORY,
    from: "[plan.id, JSON.stringify(initialSummary), initialDigest]",
    to: "[plan.id, JSON.stringify({}), initialDigest]"
  },
  {
    name: "bootstrap skips schema-v2 summary normalization",
    target: V2_REPOSITORY,
    from: "summary: Number(row.schema_version || 1) >= SNAPSHOT_SCHEMA_VERSION",
    to: "summary: Number(row.schema_version || 1) < SNAPSHOT_SCHEMA_VERSION"
  },
  {
    name: "replace-plan command can erase its marker",
    target: V2_REPOSITORY,
    from: `    result.plan.summary = dispatchPlanV2Summary(result.plan.summary || {}, {
      previousSummary: plan.summary || {},
      source: SNAPSHOT_SUMMARY_SAVE_SOURCE
    });`,
    to: "    result.plan.summary = result.plan.summary || {};"
  },
  {
    name: "startup repair leaves the old digest behind",
    target: V2_REPOSITORY,
    from: "          digestDispatchPlan(repairedPlan),",
    to: "          digestDispatchPlan({ ...repairedPlan, summary: {} }),"
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch V2 marker mutations require the writable disposable MBT test container.");
}

const originals = new Map();
for (const target of new Set(MUTANTS.map((mutant) => mutant.target))) {
  originals.set(target, await readFile(target, "utf8"));
}
const originalHashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (original === undefined || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(mutant.target, original.replace(mutant.from, mutant.to), "utf8");
    const result = await runNodeTestFilesIsolated([...TESTS], {
      environment: process.env,
      label: `Dispatch V2 summary-marker mutant: ${mutant.name}`
    });
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regressions.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(mutant.target, original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
    if (sha256(await readFile(target, "utf8")) !== originalHashes.get(target)) {
      throw new Error(`Mutation source restoration failed: ${target}`);
    }
  }
}

const finalResult = await runNodeTestFilesIsolated([...TESTS], {
  environment: process.env,
  label: "Dispatch V2 summary-marker post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Dispatch V2 summary-marker tests failed after restoring mutation sources.");
}
console.log(`Dispatch V2 summary-marker mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
