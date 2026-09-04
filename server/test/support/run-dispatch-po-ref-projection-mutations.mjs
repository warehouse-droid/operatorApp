// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";
import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";

const UNIT_TEST = "test/dispatch/unit/dispatch-assignment-projection-self-heal.contract.test.js";
const PO_REWRITE_TEST = "test/dispatch/integration/dispatch-po-ref-projection-consistency.red.test.js";
const INVARIANT_TEST = "test/dispatch/integration/dispatch-assignment-readiness-invariant.red.test.js";
const COMMAND_TEST = "test/dispatch/integration/dispatch-v2-command-flow.red.test.js";
const SPLIT_SEARCH_TEST = "test/dispatch/integration/dispatch-po-split-link-target.test.js";
const MUTANTS = Object.freeze([
  {
    name: "source-PO search drops an active held split",
    target: "src/dispatch-repository.js",
    from: `          OR (
            $7::boolean
            AND o.order_type = 'purchase_order'
            AND LOWER(BTRIM(COALESCE(scm.status, o.initial_scm_status, 'Hold'))) = 'hold'`,
    to: `          OR (
            false
            AND o.order_type = 'purchase_order'
            AND LOWER(BTRIM(COALESCE(scm.status, o.initial_scm_status, 'Hold'))) = 'hold'`,
    tests: [SPLIT_SEARCH_TEST]
  },
  {
    name: "source-PO search reopens a terminal split",
    target: "src/dispatch-repository.js",
    from: "            AND LOWER(BTRIM(COALESCE(scm.status, o.initial_scm_status, 'Hold'))) = 'hold'",
    to: "            AND LOWER(BTRIM(COALESCE(scm.status, o.initial_scm_status, 'Hold'))) <> 'cancelled'",
    tests: [SPLIT_SEARCH_TEST]
  },
  {
    name: "PO ref rewrite skips the fleet-planning lock",
    target: "src/dispatch-repository.js",
    from: "  await runQuery(\"SELECT pg_advisory_xact_lock(hashtext($1))\", [DISPATCH_FLEET_PLANNING_LOCK]);",
    to: "  await Promise.resolve();",
    tests: [PO_REWRITE_TEST]
  },
  {
    name: "PO ref rewrite leaves assignment rows and projection revision stale",
    target: "src/dispatch-repository.js",
    from: "      await syncDispatchPlanOrderAssignments(plan, { execute: runQuery });",
    to: "      await Promise.resolve();",
    tests: [PO_REWRITE_TEST]
  },
  {
    name: "PO ref rewrite leaves relation edges on the old identity",
    target: "src/dispatch-repository.js",
    from: "      await syncDispatchPlanRelationEdges(plan, { execute: runQuery });",
    to: "      await Promise.resolve();",
    tests: [PO_REWRITE_TEST]
  },
  {
    name: "PO ref rewrite retains the stale snapshot digest",
    target: "src/dispatch-repository.js",
    from: "              plan_digest = $4,",
    to: "              plan_digest = COALESCE(plan_digest, $4),",
    tests: [PO_REWRITE_TEST]
  },
  {
    name: "idle catalog maintenance skips projection repair",
    target: "src/server.js",
    from: "      await backfillDispatchPlanProjections({ batchSize: 25 });",
    to: "      if (false) {await backfillDispatchPlanProjections({ batchSize: 25 });}",
    tests: [INVARIANT_TEST]
  },
  {
    name: "catalog state trusts the cached assignment-ready bit",
    target: "src/dispatch-order-catalog-repository.js",
    from: "    assignmentsReady: row.assignments_ready === true && row.actual_assignments_ready === true,",
    to: "    assignmentsReady: row.assignments_ready === true || row.actual_assignments_ready === true,",
    tests: [INVARIANT_TEST]
  },
  {
    name: "projection sync does not restore verified global readiness",
    target: "src/dispatch-planner-v2-repository.js",
    from: "  await refreshDispatchAssignmentProjectionReadiness(runQuery);",
    to: "  await Promise.resolve();",
    tests: [INVARIANT_TEST]
  },
  {
    name: "Confirm leaves its assignment projection stale",
    target: "src/dispatch-plan-repository.js",
    from: "    await syncDispatchPlanLoadAssignments(plan, { allowBin: binBoundary !== null });\n    await syncDispatchPlannerReadProjections(plan);",
    to: "    await syncDispatchPlanLoadAssignments(plan, { allowBin: binBoundary !== null });\n    await Promise.resolve(plan);",
    tests: [INVARIANT_TEST]
  },
  {
    name: "Reopen leaves its assignment projection stale",
    target: "src/dispatch-plan-repository.js",
    from: "    const plan = await getDispatchPlan(planId);\n    await syncDispatchPlannerReadProjections(plan);\n    return plan;\n  });\n}",
    to: "    const plan = await getDispatchPlan(planId);\n    await Promise.resolve(plan);\n    return plan;\n  });\n}",
    tests: [INVARIANT_TEST]
  },
  {
    name: "grouped reconciliation leaves its assignment projection stale",
    target: "src/dispatch-plan-repository.js",
    from: "      await syncDispatchPlannerReadProjections(cleanPlan);",
    to: "      await Promise.resolve(cleanPlan);",
    tests: [INVARIANT_TEST]
  },
  {
    name: "projection backfill does not lock mutable snapshot rows",
    target: "src/dispatch-planner-v2-repository.js",
    from: "          FOR UPDATE OF p, s`,",
    to: "          `,",
    tests: [INVARIANT_TEST]
  },
  {
    name: "future plan writers no longer invalidate readiness",
    target: "migrations/193_dispatch_assignment_projection_invariant.sql",
    from: "AFTER INSERT OR DELETE OR UPDATE OF revision, status",
    to: "AFTER INSERT OR DELETE",
    tests: [INVARIANT_TEST]
  },
  {
    name: "command-time projection repair is skipped",
    target: "src/dispatch-planner-v2-repository.js",
    from: "    await backfillDispatchPlanProjections({ batchSize: 25 });",
    to: "    await Promise.resolve();",
    tests: [COMMAND_TEST]
  },
  {
    name: "rejected duplicate command rolls back its successful repair",
    target: "src/dispatch-planner-v2-repository.js",
    from: "        deferredAssignmentError = error;\n        return null;",
    to: "        deferredAssignmentError = error;\n        throw error;",
    tests: [COMMAND_TEST]
  }
]);

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch PO-reference mutations require an isolated database and writable disposable source copy.");
}

const databaseUrl = String(process.env.DATABASE_URL || "");
const environment = {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl }),
  DISPATCH_PLANNER_ORDER_POOL_MODE: "on"
};
const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, createHash("sha256").update(source).digest("hex"));
}

/** @param {string} label @param {string[]} tests */
async function runFocused(label, tests) {
  const unit = spawnSync(process.execPath, ["--test", "--test-concurrency=1", UNIT_TEST], {
    cwd: process.cwd(), env: environment, stdio: "inherit"
  });
  if (unit.error) {
    throw unit.error;
  }
  if ((unit.status ?? 1) !== 0) {
    return unit.status ?? 1;
  }
  return runNodeTestFilesIsolated(tests, { environment, label });
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || original.split(mutant.from).length - 1 !== 1) {
      throw new Error(`${mutant.name}: mutation target is not unique.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    const result = await runFocused(`Dispatch PO-reference mutant: ${mutant.name}`, mutant.tests);
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
  }
}
for (const [target, expected] of hashes) {
  const restored = createHash("sha256").update(await readFile(path.resolve(target))).digest("hex");
  if (restored !== expected) {
    throw new Error(`Mutation restore failed for ${target}.`);
  }
}
console.log(`Dispatch PO-reference mutation score: ${killed}/${MUTANTS.length} killed.`);
