// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const LIFECYCLE = path.resolve("src/dispatch-co-lifecycle.js");
const PLAN_REPOSITORY = path.resolve("src/dispatch-plan-repository.js");
const RECOVERY = path.resolve("src/dispatch-co-recovery.js");
const DISPATCH_REPOSITORY = path.resolve("src/dispatch-repository.js");
const DISPATCH_CLIENT = path.resolve("public/dispatch.js");
const TESTS = Object.freeze([
  "test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js",
  "test/dispatch/unit/dispatch-co-lifecycle-wiring.test.js",
  "test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js",
  "test/dispatch/integration/dispatch-co-recovery.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "global snapshot ownership is ignored during cancellation",
    target: LIFECYCLE,
    from: "    const conflicts = planConflictRows(rows, cleanRef);",
    to: "    const conflicts = [];"
  },
  {
    name: "stale snapshot bypasses assignment-metadata protection",
    target: LIFECYCLE,
    from: "    if (assignedPlanId && !conflicts.some((conflict) => conflict.planId === assignedPlanId)) {",
    to: "    if (false && assignedPlanId && !conflicts.some((conflict) => conflict.planId === assignedPlanId)) {"
  },
  {
    name: "active global CO metadata is not rehydrated",
    target: LIFECYCLE,
    from: `  const orders = (plan.orders || []).map((order) => applyActiveTransitCoMetadata(
    clearCancelledTransitCoMetadata(order, cancelledByRef),
    activeBySource
  ));`,
    to: `  const orders = (plan.orders || []).map((order) =>
    clearCancelledTransitCoMetadata(order, cancelledByRef));`
  },
  {
    name: "legacy save omits the inactive-CO race assertion",
    target: PLAN_REPOSITORY,
    from: `    await assertActiveDispatchCosForPlan({
      ...canonicalPlan,
      id: String(planId),
      planDate: expectedPlanDate
    });`,
    to: "    // mutation: inactive CO assertion removed from legacy save"
  },
  {
    name: "recovery selects the later incorrect depot",
    target: RECOVERY,
    from: "  originalToYard: \"150\",",
    to: "  originalToYard: \"12441\","
  },
  {
    name: "recovery omits its durable audit event",
    target: RECOVERY,
    from: "    await writeDispatchAudit({",
    to: "    if (false) await writeDispatchAudit({"
  },
  {
    name: "browser clears CO state before server cancellation succeeds",
    target: DISPATCH_CLIENT,
    from: `      const payload = await cancelTransitCoOnServer(coId);
      mergeTargetedDispatchMutationOrders(payload);
      const cancelled = cancelTransitCoForOrder(order.id);`,
    to: `      const cancelled = cancelTransitCoForOrder(order.id);
      const payload = await cancelTransitCoOnServer(coId);
      mergeTargetedDispatchMutationOrders(payload);`
  },
  {
    name: "repository bypasses the global cancellation service",
    target: DISPATCH_REPOSITORY,
    from: "  return cancelDispatchCoGlobally(coRef, { requestedBy });",
    to: "  return null;"
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
  throw new Error("Dispatch CO mutations require the writable disposable MBT mutation container.");
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
    const result = await runNodeTestFilesIsolated([...TESTS], {
      environment: process.env,
      label: `Dispatch CO mutant: ${mutant.name}`
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
  label: "Dispatch CO post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Dispatch CO tests failed after restoring mutation sources.");
}
process.stdout.write(`Dispatch CO mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.\n`);
