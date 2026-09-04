// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/dispatch/unit/scm-purchase-order-catalog-status.test.js",
  "test/dispatch/property/scm-purchase-order-catalog-status.property.test.js"
]);
const LINKED_STATUS_TESTS = Object.freeze([
  "test/dispatch/integration/scm-po-split-status-consistency.red.test.js"
]);
const PICKUP_TESTS = Object.freeze([
  "--test-name-pattern=split pickup update returns",
  "test/dispatch/integration/scm-po-split-editing.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "a PO without status defaults to Queued instead of Hold",
    from: "  return text(order.scm?.status) || \"Hold\";",
    to: "  return text(order.scm?.status) || \"Queued\";"
  },
  {
    name: "the live saved schedule status is ignored",
    from: "  const saved = text(evidence.schedule_status);",
    to: "  const saved = \"\";"
  },
  {
    name: "the current source PO initial status is ignored",
    from: "  const sourceInitial = text(evidence.source_initial_status);",
    to: "  const sourceInitial = \"\";"
  },
  {
    name: "manual operational statuses are overwritten by planning",
    from: "  if (MANUALLY_PRESERVED_STATUSES.has(baseline.toLowerCase())) {",
    to: "  if (false && MANUALLY_PRESERVED_STATUSES.has(baseline.toLowerCase())) {"
  },
  {
    name: "an active assignment never produces Planned",
    from: "  return order.dispatchPlanned === true ? \"Planned\" : baseline;",
    to: "  return baseline;"
  },
  {
    name: "Driver completion evidence is ignored",
    from: "  if (evidence.completion_event_id || order.dispatchCompleted === true) return \"Completed\";",
    to: "  if (false || order.dispatchCompleted === true) return \"Completed\";"
  },
  {
    name: "catalog completion evidence is ignored",
    from: "  if (evidence.completion_event_id || order.dispatchCompleted === true) return \"Completed\";",
    to: "  if (evidence.completion_event_id || false) return \"Completed\";"
  },
  {
    name: "an absent schedule identity applies unrelated reconciliation evidence",
    from: "  if (!evidence.schedule_id && !text(evidence.source_initial_status)) return stored;",
    to: "  if (false) return stored;"
  },
  {
    name: "schedule update time is replaced with reconciliation time",
    from: "    scheduleUpdatedAt: evidence.schedule_updated_at,",
    to: "    scheduleUpdatedAt: evidence.reconciled_at,"
  },
  {
    name: "blocking reconciliation review is ignored",
    from: "    blockingReview: evidence.reconciliation_blocked === true",
    to: "    blockingReview: false"
  },
  {
    name: "reconciliation status is ignored",
    from: "    reconciliationStatus: evidence.reconciliation_status,",
    to: "    reconciliationStatus: \"\","
  },
  {
    name: "reconciliation application status is ignored",
    from: "    reconciliationApplicationStatus: evidence.reconciliation_application_status,",
    to: "    reconciliationApplicationStatus: \"\","
  }
]);

const target = "src/scm-purchase-order-catalog-status.js";
const linkedStatusTarget = "src/scm-purchase-order-catalog-repository.js";
const pickupTarget = "src/dispatch-repository.js";
const LINKED_STATUS_MUTANTS = Object.freeze([
  {
    name: "family and search links regain status and completion authority",
    from: "  const refsByOrder = orders.map((order) => statusEvidenceRefs(order));",
    to: "  const refsByOrder = orders.map((order) => linkedRefs(order));"
  },
  {
    name: "a linked current status can no longer replace a queued display alias",
    from: "    const linkedCurrentEvidence = !exactSplitStatusEvidence && initialStatus.toLowerCase() === \"queued\"",
    to: "    const linkedCurrentEvidence = false && initialStatus.toLowerCase() === \"queued\""
  },
  {
    name: "a linked initial Hold can downgrade an exact Planned schedule",
    from: "    const linkedCurrentEvidence = !exactSplitStatusEvidence && initialStatus.toLowerCase() === \"queued\"",
    to: "    const linkedCurrentEvidence = [\"queued\", \"planned\"].includes(initialStatus.toLowerCase())"
  },
  {
    name: "a split identity regains its completed parent as status evidence",
    from: "    split ? \"\" : order.sourcePoRef",
    to: "    order.sourcePoRef"
  },
  {
    name: "the indexed catalog keeps its stale split lock snapshot",
    from: `      scmSplitLocked: order.isScmSplit === true && liveSplitLock !== undefined
        ? liveSplitLock
        : order.scmSplitLocked === true,`,
    to: "      scmSplitLocked: order.scmSplitLocked === true,"
  },
  {
    name: "indexed PO Split treats raw Partially Done text as an active plan",
    from: `                 JOIN dispatch_plans plan
                   ON plan.id = schedule.dispatch_plan_id
                  AND plan.status <> 'cancelled'
                WHERE schedule.order_kind = 'PO'
                  AND lower(schedule.order_ref) = lower(split.split_po_ref)`,
    to: `                 LEFT JOIN dispatch_plans plan
                   ON plan.id = schedule.dispatch_plan_id
                WHERE schedule.order_kind = 'PO'
                  AND lower(schedule.order_ref) = lower(split.split_po_ref)
                  AND (
                    plan.status <> 'cancelled'
                    OR lower(COALESCE(schedule.status, '')) = 'partially done'
                  )`
  },
  {
    name: "linked aliases no longer read the current source PO initial status",
    from: "            purchase.initial_scm_status AS source_initial_status,",
    to: "            NULL::text AS source_initial_status,"
  },
  {
    name: "PO Split ignores the exact live schedule method",
    from: '          method: text(exactScheduleEvidence.schedule_method) || "MBT",',
    to: '          method: order.scm?.method || "MBT",'
  },
  {
    name: "PO Split ignores the current assignment ETA date fallback",
    from: "            || text(order.dispatchPlanDate) || text(order.scm?.etaDate),",
    to: "            || text(order.scm?.etaDate),"
  },
  {
    name: "PO Split ignores the current assignment ETA time fallback",
    from: "            || text(order.dispatchEtaTime) || text(order.scm?.etaTime),",
    to: "            || text(order.scm?.etaTime),"
  },
  {
    name: "PO Split ignores the current assignment driver fallback",
    from: "            || text(order.dispatchDriverName) || text(order.dispatchDriverLogin)",
    to: "            || false"
  },
  {
    name: "PO Split ignores the current assignment load-note fallback",
    from: "            || assignmentScheduleNotes(order) || text(order.scm?.notes),",
    to: "            || text(order.scm?.notes),"
  },
  {
    name: "PO Split loses exact microsecond schedule revisions",
    from: "          ? exactScheduleEvidence.schedule_concurrency_updated_at",
    to: "          ? exactScheduleEvidence.schedule_updated_at"
  },
  {
    name: "PO Split borrows editable schedule state from a linked PO identity",
    from: "    const exactScheduleEvidence = evidenceByRef.get(exactRef) || {};",
    to: "    const exactScheduleEvidence = evidenceByRef.get(text(refsByOrder[index].at(-1)).toLowerCase()) || {};"
  }
]);
const PICKUP_MUTANTS = Object.freeze([
  {
    name: "split pickup mutation omits its authoritative schedule revision",
    from: `      pickupAddress: selected.address || "",
      scheduleUpdatedAt: scheduleUpdate.rows[0]?.concurrency_updated_at || scheduleUpdate.rows[0]?.updated_at || null,
      revision: change.revision`,
    to: `      pickupAddress: selected.address || "",
      scheduleUpdatedAt: null,
      revision: change.revision`
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

/**
 * @param {string} label
 * @param {readonly string[]} [tests]
 */
function runTests(label, tests = TESTS) {
  process.stdout.write(`\n[PO Split status mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
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
  throw new Error("PO Split status mutations require the writable disposable mutation container.");
}

const original = await readFile(path.resolve(target), "utf8");
const originalHash = hash(original);
const linkedStatusOriginal = await readFile(path.resolve(linkedStatusTarget), "utf8");
const linkedStatusOriginalHash = hash(linkedStatusOriginal);
const pickupOriginal = await readFile(path.resolve(pickupTarget), "utf8");
const pickupOriginalHash = hash(pickupOriginal);
if (runTests("baseline") !== 0) {
  throw new Error("Focused mutation tests do not start green.");
}
if (runTests("linked status baseline", LINKED_STATUS_TESTS) !== 0) {
  throw new Error("Linked-status mutation tests do not start green.");
}
if (runTests("split pickup baseline", PICKUP_TESTS) !== 0) {
  throw new Error("Split-pickup mutation tests do not start green.");
}

let killed = 0;
const mutationCount = MUTANTS.length + LINKED_STATUS_MUTANTS.length + PICKUP_MUTANTS.length;
try {
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutationCount}: ${mutant.name}`);
    await writeFile(path.resolve(target), original, "utf8");
  }
  for (const mutant of LINKED_STATUS_MUTANTS) {
    if (occurrenceCount(linkedStatusOriginal, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(
      path.resolve(linkedStatusTarget),
      linkedStatusOriginal.replace(mutant.from, mutant.to),
      "utf8"
    );
    if (runTests(mutant.name, LINKED_STATUS_TESTS) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutationCount}: ${mutant.name}`);
    await writeFile(path.resolve(linkedStatusTarget), linkedStatusOriginal, "utf8");
  }
  for (const mutant of PICKUP_MUTANTS) {
    if (occurrenceCount(pickupOriginal, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(
      path.resolve(pickupTarget),
      pickupOriginal.replace(mutant.from, mutant.to),
      "utf8"
    );
    if (runTests(mutant.name, PICKUP_TESTS) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutationCount}: ${mutant.name}`);
    await writeFile(path.resolve(pickupTarget), pickupOriginal, "utf8");
  }
} finally {
  await writeFile(path.resolve(target), original, "utf8");
  await writeFile(path.resolve(linkedStatusTarget), linkedStatusOriginal, "utf8");
  await writeFile(path.resolve(pickupTarget), pickupOriginal, "utf8");
  if (hash(await readFile(path.resolve(target), "utf8")) !== originalHash) {
    throw new Error(`Mutation source restoration failed for ${target}.`);
  }
  if (hash(await readFile(path.resolve(linkedStatusTarget), "utf8")) !== linkedStatusOriginalHash) {
    throw new Error(`Mutation source restoration failed for ${linkedStatusTarget}.`);
  }
  if (hash(await readFile(path.resolve(pickupTarget), "utf8")) !== pickupOriginalHash) {
    throw new Error(`Mutation source restoration failed for ${pickupTarget}.`);
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
if (runTests("post-mutation linked status restored source", LINKED_STATUS_TESTS) !== 0) {
  throw new Error("Linked-status tests failed after mutation source restoration.");
}
if (runTests("post-mutation split pickup restored source", PICKUP_TESTS) !== 0) {
  throw new Error("Split-pickup tests failed after mutation source restoration.");
}
console.log(`PO Split status mutation score: ${killed}/${mutationCount} killed (100%); sources restored.`);
