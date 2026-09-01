import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  assertActiveDispatchCosForPlan,
  reconcileDispatchPlanLocalCos
} from "../../../src/dispatch-co-lifecycle.js";
import { repairDispatchCoGroupIdentities } from "../../../src/dispatch-co-group-identity-repository.js";
import {
  createDispatchPlan,
  getDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import {
  syncDispatchPlanOrderAssignments,
  syncDispatchPlanRelationEdges
} from "../../../src/dispatch-planner-v2-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function fixture() {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const oldRef = `GOA-CO-RENAME-${suffix}`;
  const newRef = `CO-${oldRef}`;
  const children = [`CO-SOA-RENAME-A-${suffix}`, `CO-SOA-RENAME-B-${suffix}`];
  const stableStopId = `stable-stop-${oldRef}-driver-evidence`;
  const orders = [{
    id: oldRef,
    orderId: oldRef,
    type: "CO",
    childOrders: children,
    childOrderDetails: children.map((id) => ({ id, type: "CO" })),
    planOwned: true
  }];
  const trucks = [{
    id: `TRUCK-${suffix}`,
    plate: `TRUCK-${suffix}`,
    loads: [{
      id: `LOAD-${suffix}`,
      name: "CO group identity repair",
      stops: [{
        id: stableStopId,
        type: "drop",
        orderId: oldRef,
        orderRefs: [oldRef]
      }]
    }]
  }];
  return { oldRef, newRef, children, stableStopId, orders, trucks };
}

test("startup repair atomically renames the current CO group while preserving immutable evidence and archived bytes", async () => {
  await inRollback(async () => {
    const data = fixture();
    const planDate = "2040-04-12";
    const plan = await createDispatchPlan({ planDate, note: "CO identity repair fixture" });
    await query("UPDATE dispatch_plans SET status = 'confirmed' WHERE id = $1", [plan.id]);
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              summary = '{}'::jsonb,
              plan_digest = $4,
              saved_at = now()
        WHERE plan_id = $1`,
      [plan.id, JSON.stringify(data.orders), JSON.stringify(data.trucks), "legacy-digest"]
    );
    const projectedPlan = {
      id: String(plan.id),
      planDate,
      status: "confirmed",
      orders: data.orders,
      trucks: data.trucks,
      summary: {}
    };
    await syncDispatchPlanOrderAssignments(projectedPlan);
    await syncDispatchPlanRelationEdges(projectedPlan);
    for (const [index, coRef] of data.children.entries()) {
      await query(
        `INSERT INTO local_co_orders (
           co_ref, source_order_ref, from_location_id, from_location,
           to_location_id, to_location, status, delivery_order_id,
           created_by, details
         ) VALUES ($1, $2, 28, '2967', 15, '12441', 'completed', $3, 'co-identity-test', $4::jsonb)`,
        [coRef, `SOA-RENAME-${index}-${data.oldRef}`, -9_700_000_000 - index, JSON.stringify({ testOnly: true })]
      );
    }
    const reconciled = await reconcileDispatchPlanLocalCos(projectedPlan);
    assert.equal(reconciled.orders[0].id, data.newRef,
      "the canonical aggregate must survive reconciliation without requiring a synthetic parent CO row");
    await assertActiveDispatchCosForPlan(reconciled);
    const history = await query(
      `INSERT INTO dispatch_plan_snapshot_history (
         plan_id, plan_date, revision, orders, trucks, summary,
         original_saved_at, archive_reason, session_id,
         schema_version, plan_digest, order_count, truck_count, load_count, stop_count
       ) VALUES (
         $1, $2::date, 7, $3::jsonb, $4::jsonb, '{}'::jsonb,
         now(), 'co_identity_test', 'co-identity-test',
         2, 'immutable-legacy-digest', 1, 1, 1, 1
       ) RETURNING id::text`,
      [plan.id, planDate, JSON.stringify(data.orders), JSON.stringify(data.trucks)]
    );

    const first = await repairDispatchCoGroupIdentities({ planIds: [plan.id] });
    assert.equal(first.repaired, 1);
    assert.deepEqual(first.planIds, [String(plan.id)]);
    assert.deepEqual(first.mappings, [{
      planId: String(plan.id),
      oldRef: data.oldRef,
      newRef: data.newRef
    }]);

    const current = (await query(
      `SELECT orders, trucks, plan_digest
         FROM dispatch_plan_snapshots
        WHERE plan_id = $1`,
      [plan.id]
    )).rows[0];
    assert.equal(current.orders[0].id, data.newRef);
    assert.equal(current.trucks[0].loads[0].stops[0].orderId, data.newRef);
    assert.deepEqual(current.trucks[0].loads[0].stops[0].orderRefs, [data.newRef]);
    assert.equal(current.trucks[0].loads[0].stops[0].id, data.stableStopId);
    assert.match(current.plan_digest, /^[0-9a-f]{64}$/u);
    assert.notEqual(current.plan_digest, "legacy-digest");

    const assignments = await query(
      `SELECT order_ref, planned_order_ref, stop_id
         FROM dispatch_plan_order_assignments
        WHERE plan_id = $1`,
      [plan.id]
    );
    assert.deepEqual(assignments.rows, [{
      order_ref: data.newRef,
      planned_order_ref: data.newRef,
      stop_id: data.stableStopId
    }]);
    const edges = await query(
      `SELECT relation_type, owner_ref, member_ref
         FROM dispatch_order_relation_edges
        WHERE plan_id = $1
        ORDER BY member_ref`,
      [plan.id]
    );
    assert.deepEqual(edges.rows, data.children.map((memberRef) => ({
      relation_type: "group_member",
      owner_ref: data.newRef,
      member_ref: memberRef
    })));
    assert.deepEqual((await query(
      "SELECT status FROM local_co_orders WHERE co_ref = ANY($1::text[]) ORDER BY co_ref",
      [data.children]
    )).rows.map((row) => row.status), ["completed", "completed"]);

    const rawHistory = (await query(
      "SELECT orders, trucks, plan_digest FROM dispatch_plan_snapshot_history WHERE id = $1",
      [history.rows[0].id]
    )).rows[0];
    assert.equal(rawHistory.orders[0].id, data.oldRef,
      "archived evidence bytes must remain immutable");
    assert.equal(rawHistory.trucks[0].loads[0].stops[0].id, data.stableStopId);
    assert.equal(rawHistory.plan_digest, "immutable-legacy-digest");
    const historicalView = await getDispatchPlanSnapshot(history.rows[0].id);
    assert.equal(historicalView.orders[0].id, data.newRef,
      "history reads must present the canonical identity without rewriting archived evidence");

    const auditCount = async () => Number((await query(
      `SELECT count(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'dispatch_co_group_identity_repaired'
          AND plan_id = $1
          AND order_id = $2`,
      [plan.id, data.newRef]
    )).rows[0].count);
    assert.equal(await auditCount(), 1);

    const repeated = await repairDispatchCoGroupIdentities({ planIds: [plan.id] });
    assert.equal(repeated.repaired, 0);
    assert.deepEqual(repeated.mappings, []);
    assert.equal(await auditCount(), 1);
  });
});
