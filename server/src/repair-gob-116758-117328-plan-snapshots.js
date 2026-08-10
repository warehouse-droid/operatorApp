import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";

const TARGET = Object.freeze({
  groupRef: "GOB-116758-117328",
  childRefs: ["SOB116758", "SOB117328"],
  ownerPlanId: "215",
  ownerPlanDate: "2026-08-09",
  copiedFromPlanId: "216",
  plans: [
    { id: "214", date: "2026-08-08" },
    { id: "216", date: "2026-08-10" }
  ],
  sessionId: "repair:GOB-116758-117328:2026-08-10",
  actor: "system:gob-116758-117328-repair"
});

function text(value) {
  return String(value ?? "").trim();
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return text(value).slice(0, 10);
}

function assertRepair(condition, message) {
  if (condition) return;
  throw Object.assign(new Error(message), { code: "GOB_PLAN_SNAPSHOT_REPAIR_ASSERTION_FAILED" });
}

function sameRef(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

function sortedRefs(values = []) {
  return [...new Set(values.map(text).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function validateTargetGroup(order, plan) {
  assertRepair(String(order?.type || "").toUpperCase() === "SO",
    `Plan ${plan.id} target is no longer a grouped Sales Order.`);
  assertRepair(
    JSON.stringify(sortedRefs(order.childOrders)) === JSON.stringify(sortedRefs(TARGET.childRefs)),
    `Plan ${plan.id} target group members changed.`
  );
  assertRepair(text(order.groupPlanId) === TARGET.ownerPlanId,
    `Plan ${plan.id} target group owner changed from plan ${TARGET.ownerPlanId}.`);
  assertRepair(dateOnly(order.groupPlanDate) === TARGET.ownerPlanDate,
    `Plan ${plan.id} target group owner date changed from ${TARGET.ownerPlanDate}.`);
  assertRepair(text(order.dispatchSnapshotSourcePlanId) === TARGET.copiedFromPlanId,
    `Plan ${plan.id} target group no longer has the verified copied-snapshot provenance.`);
  assertRepair(!JSON.stringify(plan.trucks || []).toLowerCase().includes(TARGET.groupRef.toLowerCase()),
    `Plan ${plan.id} still assigns ${TARGET.groupRef} to a truck; refusing to remove it.`);
}

async function repair() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const planIds = TARGET.plans.map((plan) => plan.id);
    const current = await query(
      `SELECT p.id::text, p.plan_date::text AS plan_date, p.revision, p.status, p.note,
              s.orders, s.trucks, s.summary
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = ANY($1::bigint[])
        ORDER BY p.id
        FOR UPDATE OF p, s`,
      [planIds]
    );
    assertRepair(current.rowCount === TARGET.plans.length,
      `Expected ${TARGET.plans.length} target plans, found ${current.rowCount}.`);

    const projection = await query(
      `SELECT group_ref, plan_id::text, plan_date::text AS plan_date, active
         FROM dispatch_delivery_groups
        WHERE lower(group_ref) = lower($1)
        FOR UPDATE`,
      [TARGET.groupRef]
    );
    assertRepair(projection.rowCount <= 1, "Target delivery-group projection is duplicated.");
    if (projection.rowCount === 1) {
      const row = projection.rows[0];
      assertRepair(text(row.plan_id) === TARGET.ownerPlanId, "Target delivery-group projection owner changed.");
      assertRepair(dateOnly(row.plan_date) === TARGET.ownerPlanDate, "Target delivery-group projection date changed.");
    }

    const assignments = await query(
      `SELECT plan_id::text, order_ref
         FROM dispatch_plan_order_assignments
        WHERE lower(order_ref) = lower($1)
          AND plan_id = ANY($2::bigint[])
        FOR SHARE`,
      [TARGET.groupRef, planIds]
    );
    assertRepair(assignments.rowCount === 0,
      `${TARGET.groupRef} has an assignment in a copied target plan; refusing to remove it.`);

    const planById = new Map(current.rows.map((row) => [text(row.id), row]));
    const changed = [];
    for (const expected of TARGET.plans) {
      const plan = planById.get(expected.id);
      assertRepair(plan, `Plan ${expected.id} was not found.`);
      assertRepair(dateOnly(plan.plan_date) === expected.date,
        `Plan ${expected.id} moved from ${expected.date}.`);
      const orders = Array.isArray(plan.orders) ? structuredClone(plan.orders) : [];
      const matches = orders.filter((order) => sameRef(order?.id, TARGET.groupRef));
      assertRepair(matches.length <= 1, `Plan ${expected.id} contains duplicate target groups.`);
      if (!matches.length) continue;
      validateTargetGroup(matches[0], plan);
      const retainedOrders = orders.filter((order) => !sameRef(order?.id, TARGET.groupRef));
      const retainedRefs = sortedRefs(retainedOrders.map((order) => order?.id));
      const saved = await saveDispatchPlanSnapshot(expected.id, {
        orders: retainedOrders,
        trucks: structuredClone(plan.trucks || []),
        summary: structuredClone(plan.summary || {}),
        baseRevision: Number(plan.revision),
        planDate: expected.date,
        sessionId: TARGET.sessionId
      });
      assertRepair(!(saved.orders || []).some((order) => sameRef(order?.id, TARGET.groupRef)),
        `Plan ${expected.id} still contains the target group after save.`);
      assertRepair(
        JSON.stringify(sortedRefs((saved.orders || []).map((order) => order?.id))) === JSON.stringify(retainedRefs),
        `Plan ${expected.id} changed an unrelated order identity; rolling back the repair.`
      );
      await writeDispatchAudit({
        action: "dispatch_plan_stale_group_removed",
        entityType: "dispatch_plan",
        entityId: expected.id,
        orderId: TARGET.groupRef,
        planId: Number(expected.id),
        planDate: expected.date,
        sessionId: TARGET.sessionId,
        operatorName: TARGET.actor,
        source: "dispatch_plan_snapshot_repair",
        before: { revision: Number(plan.revision), groupPresent: true },
        after: { revision: Number(saved.revision), groupPresent: false },
        details: {
          ownerPlanId: TARGET.ownerPlanId,
          ownerPlanDate: TARGET.ownerPlanDate,
          copiedFromPlanId: TARGET.copiedFromPlanId,
          childRefs: TARGET.childRefs
        }
      });
      changed.push({
        planId: expected.id,
        planDate: expected.date,
        fromRevision: Number(plan.revision),
        toRevision: Number(saved.revision)
      });
    }

    const remaining = await query(
      `SELECT p.id::text, p.plan_date::text AS plan_date
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = ANY($1::bigint[])
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(s.orders, '[]'::jsonb)) AS item(value)
             WHERE lower(item.value->>'id') = lower($2)
          )
        ORDER BY p.id`,
      [planIds, TARGET.groupRef]
    );
    assertRepair(remaining.rowCount === 0, "Target group remains in a repaired plan snapshot.");
    return { groupRef: TARGET.groupRef, changed, alreadyClean: changed.length === 0 };
  }, { rollback: dryRun });
  return { ...result, dryRun };
}

try {
  console.log(JSON.stringify(await repair(), null, 2));
} finally {
  await closeDb();
}
