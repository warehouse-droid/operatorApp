import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.DISPATCH_PLANNER_ORDER_POOL_MODE = "on";

const { beginRollbackContext, closeDb, query } = await import("../../../src/db.js");
const { getDispatchOrderCatalogState } = await import("../../../src/dispatch-order-catalog-repository.js");
const {
  backfillDispatchPlanProjections,
  syncDispatchPlanOrderAssignments
} = await import("../../../src/dispatch-planner-v2-repository.js");
const {
  confirmDispatchPlan,
  createDispatchPlan,
  reconcileSalesOrderFamilyInDispatchPlans,
  saveDispatchPlanSnapshot,
  reopenDispatchPlan
} = await import("../../../src/dispatch-plan-repository.js");
const { dispatchOrderCatalogTick } = await import("../../../src/server.js");

after(closeDb);

async function projectionRevision(planId) {
  return (await query(
    `SELECT plan.revision::int AS revision,
            projection.source_revision::int AS source_revision
       FROM dispatch_plans plan
       LEFT JOIN dispatch_plan_projection_state projection ON projection.plan_id = plan.id
      WHERE plan.id = $1`,
    [planId]
  )).rows[0];
}

test("the database invalidates cached assignment readiness for an unknown revision writer", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await createDispatchPlan({
        planDate: "2097-10-01",
        note: "assignment readiness trigger regression"
      });
      await query(
        "UPDATE dispatch_order_catalog_state SET status = 'ready', assignments_ready = true WHERE singleton = true"
      );
      await query("UPDATE dispatch_plans SET revision = revision + 1 WHERE id = $1", [plan.id]);

      const state = (await query(
        "SELECT assignments_ready FROM dispatch_order_catalog_state WHERE singleton = true"
      )).rows[0];
      assert.equal(
        state.assignments_ready,
        false,
        "a direct or future writer must invalidate readiness before its transaction can commit"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("catalog state never reports ready assignments when real plan revisions disagree", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await createDispatchPlan({
        planDate: "2097-10-02",
        note: "assignment readiness live-state regression"
      });
      await query("UPDATE dispatch_plans SET revision = revision + 1 WHERE id = $1", [plan.id]);
      await query(
        "UPDATE dispatch_order_catalog_state SET status = 'ready', assignments_ready = true WHERE singleton = true"
      );

      const state = await getDispatchOrderCatalogState();
      assert.equal(state.assignmentsReady, false);
    });
  } finally {
    await rollback.rollback();
  }
});

test("an idle catalog maintenance tick repairs projection drift without an outbox request", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await createDispatchPlan({
        planDate: "2097-10-03",
        note: "assignment readiness idle tick regression"
      });
      await query("DELETE FROM dispatch_order_catalog_refresh_outbox");
      await query("UPDATE dispatch_plans SET revision = revision + 1 WHERE id = $1", [plan.id]);
      await query(
        "UPDATE dispatch_order_catalog_state SET status = 'ready', assignments_ready = true WHERE singleton = true"
      );

      const tick = await dispatchOrderCatalogTick();
      assert.equal(tick.skipped, false);
      assert.equal(tick.claimed, 0);
      assert.deepEqual(await projectionRevision(plan.id), { revision: 1, source_revision: 1 });
      assert.equal((await getDispatchOrderCatalogState()).assignmentsReady, true);
    });
  } finally {
    await rollback.rollback();
  }
});

test("projection backfill restores a missing Driver load row before marking the plan current", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await createDispatchPlan({
        planDate: "2097-10-06",
        note: "load assignment projection regression"
      });
      const trucks = [{
        id: "LOAD-PROJECTION-TRUCK",
        plate: "LOAD-PROJECTION-TRUCK",
        loads: [{
          id: "load-projection-1",
          name: "Load projection 1",
          stops: []
        }]
      }];
      await query(
        `UPDATE dispatch_plan_snapshots
            SET trucks = $2::jsonb,
                schema_version = 2,
                truck_count = 1,
                load_count = 1,
                stop_count = 0
          WHERE plan_id = $1`,
        [plan.id, JSON.stringify(trucks)]
      );
      await syncDispatchPlanOrderAssignments({ ...plan, trucks });
      await query("DELETE FROM dispatch_plan_load_assignments WHERE plan_id = $1", [plan.id]);
      await query("DELETE FROM dispatch_plan_projection_state WHERE plan_id = $1", [plan.id]);

      const repaired = await backfillDispatchPlanProjections({ batchSize: 25 });
      assert.ok(repaired.projected >= 1);
      assert.deepEqual(
        (await query(
          `SELECT load_id, truck_plate, started, completed
             FROM dispatch_plan_load_assignments
            WHERE plan_id = $1`,
          [plan.id]
        )).rows,
        [{
          load_id: "load-projection-1",
          truck_plate: "LOAD-PROJECTION-TRUCK",
          started: false,
          completed: false
        }]
      );
      assert.deepEqual(await projectionRevision(plan.id), { revision: 0, source_revision: 0 });
    });
  } finally {
    await rollback.rollback();
  }
});

test("Confirm and Reopen commit their projection revision before returning", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const created = await createDispatchPlan({
        planDate: "2097-10-04",
        note: "assignment readiness lifecycle regression"
      });

      const confirmed = await confirmDispatchPlan(created.id);
      assert.equal(confirmed.status, "confirmed");
      assert.deepEqual(await projectionRevision(created.id), { revision: 1, source_revision: 1 });
      assert.equal((await getDispatchOrderCatalogState()).assignmentsReady, true);

      const reopened = await reopenDispatchPlan(created.id);
      assert.equal(reopened.status, "draft");
      assert.deepEqual(await projectionRevision(created.id), { revision: 2, source_revision: 2 });
      assert.equal((await getDispatchOrderCatalogState()).assignmentsReady, true);
    });
  } finally {
    await rollback.rollback();
  }
});

test("grouped sales-order reconciliation commits its projection revision before returning", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await createDispatchPlan({
        planDate: "2097-10-05",
        note: "assignment readiness reconciliation regression"
      });
      const childRefs = ["SO-READINESS-A", "SO-READINESS-B"];
      const groupRef = "GOA-READINESS-A-B";
      const saved = await saveDispatchPlanSnapshot(plan.id, {
        baseRevision: plan.revision,
        planDate: plan.planDate,
        orders: [{
          id: groupRef,
          type: "SO",
          childOrders: childRefs,
          childOrderDetails: childRefs.map((id) => ({
            id,
            type: "SO",
            reconciliationStatus: "current",
            reconciliationApplicationStatus: "Queued"
          }))
        }],
        trucks: []
      });

      const result = await reconcileSalesOrderFamilyInDispatchPlans({
        canonicalRef: childRefs[0],
        familyRefs: childRefs,
        reconciliationStatus: "review",
        reconciliationReason: "readiness regression",
        reconciliationApplicationStatus: "Reconcile Review"
      });

      assert.equal(result.changedPlans.length, 1);
      assert.deepEqual(await projectionRevision(plan.id), {
        revision: saved.revision + 1,
        source_revision: saved.revision + 1
      });
      assert.equal((await getDispatchOrderCatalogState()).assignmentsReady, true);
    });
  } finally {
    await rollback.rollback();
  }
});
