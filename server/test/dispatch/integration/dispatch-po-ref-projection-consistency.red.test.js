import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.DISPATCH_PLANNER_ORDER_POOL_MODE = "on";

const { beginRollbackContext, closeDb, query } = await import("../../../src/db.js");
const { createDispatchPlan } = await import("../../../src/dispatch-plan-repository.js");
const { enqueueDispatchOrderCatalogRefresh } = await import("../../../src/dispatch-order-catalog-repository.js");
const {
  backfillDispatchPlanProjections,
  syncDispatchPlanOrderAssignments,
  syncDispatchPlanRelationEdges
} = await import("../../../src/dispatch-planner-v2-repository.js");
const { digestDispatchPlan } = await import("../../../src/dispatch-planner-performance.js");
const { updatePurchaseOrderDispatchRef } = await import("../../../src/dispatch-repository.js");
const { dispatchOrderCatalogTick } = await import("../../../src/server.js");

after(closeDb);

const OLD_REF = "PO-REF-PROJECTION-OLD";
const NEW_REF = "PO-REF-PROJECTION-NEW";

function poCard(ref) {
  return {
    id: ref,
    orderId: ref,
    refNumber: ref,
    type: "PO",
    status: "Hold",
    pickupLocations: ["Projection Test Vendor"],
    dropoffLocations: ["12441"],
    items: [{ itemName: "PROJECTION-ITEM", quantity: 1, uom: "PLT" }]
  };
}

function linkedSalesOrder(poRef) {
  return {
    id: "SO-REF-PROJECTION-OWNER",
    orderId: "SO-REF-PROJECTION-OWNER",
    refNumber: "SO-REF-PROJECTION-OWNER",
    type: "SO",
    poPickupManifest: [{ poOrderRef: poRef, location: "Projection Test Vendor" }]
  };
}

function routedTruck(ref) {
  return [{
    id: "PROJECTION-TRUCK",
    plate: "PROJECTION-TRUCK",
    loads: [{
      id: "projection-load-2",
      name: "Load 2",
      stops: [{
        id: "projection-stop-po",
        type: "pickup",
        orderId: ref,
        orderRefs: [ref],
        location: "Projection Test Vendor"
      }]
    }]
  }];
}

async function seedProjectedPlan({ planDate, routed }) {
  const created = await createDispatchPlan({ planDate, note: "PO ref projection consistency regression" });
  const current = (await query(
    `SELECT id::text AS id, plan_date::text AS plan_date, status, note, revision::int AS revision
       FROM dispatch_plans
      WHERE id = $1`,
    [created.id]
  )).rows[0];
  const orders = routed ? [poCard(OLD_REF), linkedSalesOrder(OLD_REF)] : [poCard(OLD_REF)];
  const trucks = routed ? routedTruck(OLD_REF) : [];
  const summary = { testOnly: true, scenario: routed ? "routed" : "unassigned" };
  const plan = {
    id: current.id,
    planDate: current.plan_date,
    status: current.status,
    note: current.note,
    revision: current.revision,
    orders,
    trucks,
    summary
  };
  await query(
    `UPDATE dispatch_plan_snapshots
        SET orders = $2::jsonb,
            trucks = $3::jsonb,
            summary = $4::jsonb,
            plan_digest = $5,
            saved_at = now()
      WHERE plan_id = $1`,
    [plan.id, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary), digestDispatchPlan(plan)]
  );
  await syncDispatchPlanOrderAssignments(plan);
  await syncDispatchPlanRelationEdges(plan);
  return plan;
}

test("PO display-reference rewrites keep every Dispatch read projection current in the same transaction", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const uniquePoId = (9_600_000_000_000n + BigInt(Date.now())).toString();
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, status, status_text, netsuite_active, synced_at
         ) VALUES ($1, $2, 'B', 'Purchase Order : Pending Receipt', true, now())`,
        [uniquePoId, OLD_REF]
      );
      const routed = await seedProjectedPlan({ planDate: "2097-09-01", routed: true });
      const unassigned = await seedProjectedPlan({ planDate: "2097-09-02", routed: false });

      const updated = await updatePurchaseOrderDispatchRef({
        poRef: OLD_REF,
        newRef: NEW_REF,
        updatedBy: "dispatch-po-ref-projection-regression"
      });
      assert.deepEqual(
        updated.updatedPlans.map(String).sort(),
        [routed.id, unassigned.id].sort()
      );

      const projectionState = await query(
        `SELECT p.id::text AS id, p.revision::int AS revision,
                projection.source_revision::int AS source_revision
           FROM dispatch_plans p
           LEFT JOIN dispatch_plan_projection_state projection ON projection.plan_id = p.id
          WHERE p.id = ANY($1::bigint[])
          ORDER BY p.id`,
        [[routed.id, unassigned.id]]
      );
      assert.equal(projectionState.rowCount, 2);
      for (const row of projectionState.rows) {
        assert.equal(
          row.source_revision,
          row.revision,
          `plan ${row.id} must not be left behind the assignment readiness fence`
        );
      }

      const assignments = await query(
        `SELECT order_ref, planned_order_ref, load_id, stop_id
           FROM dispatch_plan_order_assignments
          WHERE plan_id = $1
          ORDER BY lower(order_ref)`,
        [routed.id]
      );
      assert.equal(assignments.rows.some((row) => row.order_ref === OLD_REF), false);
      const renamedAssignment = assignments.rows.find((row) => row.order_ref === NEW_REF);
      assert.ok(renamedAssignment, "the routed PO assignment must follow its new identity");
      assert.equal(renamedAssignment.planned_order_ref, NEW_REF);
      assert.equal(renamedAssignment.load_id, "projection-load-2");
      assert.equal(renamedAssignment.stop_id, "projection-stop-po");

      const relation = (await query(
        `SELECT owner_ref, member_ref, source_revision::int AS source_revision
           FROM dispatch_order_relation_edges
          WHERE plan_id = $1 AND relation_type = 'po_link'`,
        [routed.id]
      )).rows[0];
      assert.equal(relation?.owner_ref, "SO-REF-PROJECTION-OWNER");
      assert.equal(relation?.member_ref, NEW_REF);
      assert.equal(relation?.source_revision, projectionState.rows.find((row) => row.id === routed.id)?.revision);

      const storedPlans = await query(
        `SELECT p.id::text AS id, p.plan_date::text AS plan_date, p.status, p.note,
                s.orders, s.trucks, s.summary, s.plan_digest
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = ANY($1::bigint[])
          ORDER BY p.id`,
        [[routed.id, unassigned.id]]
      );
      for (const row of storedPlans.rows) {
        assert.equal(JSON.stringify(row.orders).includes(OLD_REF), false);
        assert.equal(JSON.stringify(row.trucks).includes(OLD_REF), false);
        assert.ok(JSON.stringify(row.orders).includes(NEW_REF));
        assert.equal(row.plan_digest, digestDispatchPlan({
          id: row.id,
          planDate: row.plan_date,
          status: row.status,
          note: row.note,
          orders: row.orders,
          trucks: row.trucks,
          summary: row.summary
        }));
      }

      const noDeferredRepair = await backfillDispatchPlanProjections({ batchSize: 25 });
      assert.equal(noDeferredRepair.projected, 0, "the PO ref rewrite must not defer its own repair");
      assert.equal(noDeferredRepair.remaining, 0);
      assert.equal(noDeferredRepair.ready, true);
    });
  } finally {
    await rollback.rollback();
  }
});

test("a full catalog pass repairs real projection drift even when the cached readiness flag says true", async () => {
  let plan = null;
  try {
    plan = await seedProjectedPlan({ planDate: "2097-09-03", routed: false });
    await query(
      "UPDATE dispatch_plans SET revision = revision + 1, updated_at = now() WHERE id = $1",
      [plan.id]
    );
    await query(
      `UPDATE dispatch_order_catalog_state
          SET status = 'ready', assignments_ready = true, updated_at = now()
        WHERE singleton = true`
    );
    await enqueueDispatchOrderCatalogRefresh({ source: "projection-self-heal-regression" });

    const result = await dispatchOrderCatalogTick();
    assert.equal(result.skipped, false, "the regression runner must enable the indexed Dispatch pool");
    assert.equal(result.failed, 0);
    assert.equal(result.completed, 1);

    const state = (await query(
      `SELECT p.revision::int AS revision,
              projection.source_revision::int AS source_revision,
              catalog.assignments_ready
         FROM dispatch_plans p
         JOIN dispatch_plan_projection_state projection ON projection.plan_id = p.id
         CROSS JOIN dispatch_order_catalog_state catalog
        WHERE p.id = $1 AND catalog.singleton = true`,
      [plan.id]
    )).rows[0];
    assert.equal(state.source_revision, state.revision);
    assert.equal(state.assignments_ready, true);
  } finally {
    if (plan?.id) {
      await query("DELETE FROM dispatch_plans WHERE id = $1", [plan.id]).catch(() => undefined);
    }
    await query(
      "DELETE FROM dispatch_order_catalog_refresh_outbox WHERE source = 'projection-self-heal-regression'"
    ).catch(() => undefined);
  }
});
