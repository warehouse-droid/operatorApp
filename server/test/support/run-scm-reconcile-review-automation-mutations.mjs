// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const POLICY_TESTS = Object.freeze([
  "test/dispatch/unit/scm-reconcile-review-policy.test.js",
  "test/dispatch/property/scm-reconcile-review-automation.property.test.js"
]);
const INTEGRATION_TESTS = Object.freeze([
  "test/mbt/integration/scm-reconcile-review-automation.red.test.js"
]);
const PLANNING_TESTS = Object.freeze([
  "test/dispatch/unit/scm-reconcile-planning-isolation.red.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, tests: readonly string[]}>} */
const MUTANTS = Object.freeze([
  {
    name: "source header planning evidence is ignored",
    target: "src/scm-reconcile-review-policy.js",
    from: "  if (sourceDispatchPlanned === true) {\n    return true;\n  }",
    to: "  if (false) {\n    return true;\n  }",
    tests: POLICY_TESTS
  },
  {
    name: "a missing schedule identity can still look planned",
    target: "src/scm-reconcile-review-policy.js",
    from: "  if (!positiveId(scheduleId)) {\n    return false;\n  }",
    to: "  if (false && !positiveId(scheduleId)) {\n    return false;\n  }",
    tests: POLICY_TESTS
  },
  {
    name: "dispatch plan identity is not planning evidence",
    target: "src/scm-reconcile-review-policy.js",
    from: "  return positiveId(scheduleDispatchPlanId) !== null",
    to: "  return false",
    tests: POLICY_TESTS
  },
  {
    name: "schedule ETA is not planning evidence",
    target: "src/scm-reconcile-review-policy.js",
    from: "    || validDate(scheduleEtaDate)",
    to: "    || false",
    tests: POLICY_TESTS
  },
  {
    name: "operational schedule lifecycle is not planning evidence",
    target: "src/scm-reconcile-review-policy.js",
    from: "    || OPERATIONAL_SCHEDULE_STATUSES.has(text(scheduleStatus));",
    to: "    || false;",
    tests: POLICY_TESTS
  },
  {
    name: "planned TO increases are auto-applied",
    target: "src/scm-reconcile-review-policy.js",
    from: "    ? authoritative > local + EPSILON",
    to: "    ? false",
    tests: POLICY_TESTS
  },
  {
    name: "planned PO changes inherit TO automation",
    target: "src/scm-reconcile-review-policy.js",
    from: "    : Math.abs(authoritative - local) > EPSILON;",
    to: "    : false;",
    tests: POLICY_TESTS
  },
  {
    name: "active split overflow is accepted",
    target: "src/scm-reconcile-review-policy.js",
    from: "  return quantity(activeSplitQuantity) > quantity(authoritativeSourceQuantity) + EPSILON;",
    to: "  return false;",
    tests: POLICY_TESTS
  },
  {
    name: "repository treats any TO schedule row as a plan",
    target: "src/scm-reconciliation-repository.js",
    from: "    dispatchPlanned: scmScheduleHasOperationalPlanningEvidence({",
    to: "    dispatchPlanned: Boolean(row.schedule_id) || scmScheduleHasOperationalPlanningEvidence({",
    tests: INTEGRATION_TESTS
  },
  {
    name: "repository bypasses planned quantity safety policy",
    target: "src/scm-reconciliation-repository.js",
    from: "      const plannedQuantityRequiresReview = scmPlannedQuantityChangeRequiresReview({",
    to: "      const plannedQuantityRequiresReview = false && scmPlannedQuantityChangeRequiresReview({",
    tests: INTEGRATION_TESTS
  },
  {
    name: "repository bypasses active split capacity policy",
    target: "src/scm-reconciliation-repository.js",
    from: "    if (scmActiveSplitExceedsSource({",
    to: "    if (false && scmActiveSplitExceedsSource({",
    tests: INTEGRATION_TESTS
  },
  {
    name: "one Dispatch save stops using placed assignment deltas",
    target: "src/server.js",
    from: "  const changedScmRefs = changedPlacedDispatchScmAssignmentRefs(previousPlan, candidate);",
    to: "  const changedScmRefs = operationalPlanOrderRefs(candidate);",
    tests: PLANNING_TESTS
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label @param {readonly string[]} tests */
function runTests(label, tests) {
  process.stdout.write(`\n[reconcile review mutation] ${label}\n`);
  return spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 180_000
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
  throw new Error("Reconcile Review mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

for (const [label, tests] of [
  ["policy baseline", POLICY_TESTS],
  ["integration baseline", INTEGRATION_TESTS],
  ["planning baseline", PLANNING_TESTS]
]) {
  assertPassed(String(label), runTests(String(label), /** @type {readonly string[]} */ (tests)));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(
      path.resolve(mutant.target),
      original.replace(mutant.from, mutant.to),
      "utf8"
    );
    const result = runTests(mutant.name, mutant.tests);
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

for (const [label, tests] of [
  ["restored policy", POLICY_TESTS],
  ["restored integration", INTEGRATION_TESTS],
  ["restored planning", PLANNING_TESTS]
]) {
  assertPassed(String(label), runTests(String(label), /** @type {readonly string[]} */ (tests)));
}
console.log(`Reconcile Review mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
