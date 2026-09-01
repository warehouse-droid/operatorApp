// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TEST = "test/dispatch/frontend/dispatch-unplan-freshness.red.test.js";
/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string}>} */
const MUTANTS = Object.freeze([
  {
    name: "same-plan assignment metadata drag-locks an unplanned order",
    target: "public/dispatch.js",
    from: "  if (assignmentPlanId && activePlanId && assignmentPlanId === activePlanId) return false;",
    to: "  if (false && assignmentPlanId && activePlanId && assignmentPlanId === activePlanId) return false;"
  },
  {
    name: "legacy same-day metadata drag-locks an unplanned order",
    target: "public/dispatch.js",
    from: "  if (!assignmentPlanId && assignmentPlanDate && assignmentPlanDate === activePlanDate) return false;",
    to: "  if (false && !assignmentPlanId && assignmentPlanDate && assignmentPlanDate === activePlanDate) return false;"
  },
  {
    name: "snapshot save skips its assignment projection",
    target: "src/dispatch-plan-repository.js",
    from: "    await syncDispatchPlannerReadProjections({\n      ...storedPlan,",
    to: "    void ({\n      ...storedPlan,"
  },
  {
    name: "Dispatch serves a stale browser generation",
    target: "public/dispatch.html",
    from: "dispatch.js?v=20260831-po-link-uom-service-v2",
    to: "dispatch.js?v=stale-unplan-client"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTest(label) {
  process.stdout.write(`\n[dispatch unplan mutation] ${label}\n`);
  return spawnSync(process.execPath, ["--test", TEST], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 60_000
  });
}

/**
 * @param {string} label
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 */
function assertPassed(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return;
  }
  process.stderr.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  throw new Error(`${label} did not pass.`);
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch unplan mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

assertPassed("baseline", runTest("baseline"));
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    const result = runTest(mutant.name);
    await writeFile(path.resolve(mutant.target), original, "utf8");
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      throw new Error(`SURVIVED: ${mutant.name}`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

assertPassed("restored source", runTest("restored source"));
console.log(`Dispatch unplan mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
