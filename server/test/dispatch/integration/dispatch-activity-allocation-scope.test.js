import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, query, closeDb } from "../../../src/db.js";
import { assertDispatchExecutedPrefixPreserved } from "../../../src/dispatch-executed-prefix-repository.js";
import { saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { activityAllocationScopeFixture } from "../../support/dispatch-activity-allocation-scope-fixture.mjs";

after(closeDb);

test("persisted driver activity accepts the suffix edit and rejects real cargo edits atomically", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = activityAllocationScopeFixture();
      const inserted = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('2196-09-13','confirmed',16) RETURNING id::text")).rows[0];
      const login = `scope-li-${inserted.id}`;
      await query("INSERT INTO dispatch_drivers(name,login,active) VALUES('Test Li',$1,true)", [login]);
      const truck = (await query("INSERT INTO dispatch_trucks(plate,active) VALUES($1,true) RETURNING id::text,plate", [`SCOPE-${inserted.id}`])).rows[0];
      await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location,to_location,status)
        VALUES('CO-SOM06255-S1','SOM06255-S1','3445','150','pending_load')`);
      for (const plan of [fixture.previousPlan, fixture.nextPlan]) {
        plan.id = inserted.id;
        plan.planDate = "2196-09-13";
        Object.assign(plan.trucks[0], { id: truck.id, plate: truck.plate, driverLogin: login });
      }
      await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')",
        [inserted.id, JSON.stringify(fixture.previousPlan.orders), JSON.stringify(fixture.previousPlan.trucks)]);
      for (const event of fixture.activity) {
        await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,
          load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
          VALUES($1,$2,'2196-09-13',$8,$9,$10,$3,$4,$5,$6::jsonb,$7,now(),now())`,
        [`scope-${inserted.id}-${event.stop_id}`, inserted.id, event.load_id, event.stop_id,
          event.stop_type, JSON.stringify(event.order_refs), event.status, login, truck.id, truck.plate]);
      }
      const witness = async () => (await query(`SELECT p.revision,s.orders,s.trucks,
        (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM driver_job_records j WHERE plan_id=p.id) AS jobs
        FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [inserted.id])).rows[0];
      const before = await witness();
      assert.deepEqual(await assertDispatchExecutedPrefixPreserved(fixture), { allowed: true, conflicts: [] });
      const edited = structuredClone(fixture.nextPlan);
      edited.orders[0].childOrderDetails[0].items[0].quantity += 1;
      await assert.rejects(assertDispatchExecutedPrefixPreserved({ previousPlan: fixture.previousPlan, nextPlan: edited }),
        error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED" && error.status === 409);
      // The real save path must reject before applying the invalid cargo.
      await assert.rejects(saveDispatchPlanSnapshot(inserted.id, { ...edited, baseRevision: 16 }),
        error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED" && error.status === 409);
      assert.deepEqual(await witness(), before);
      const saved = await saveDispatchPlanSnapshot(inserted.id, { ...fixture.nextPlan, baseRevision: 16 });
      assert.equal(saved.revision, 17);
      assert.equal(saved.trucks[0].loads.at(-1).stops.at(-1).orderId, "CO-SOM06255-S1");
      assert.equal(saved.orders.some(order => order.id === "CO-GOA-8111-8113"), false);
      assert.deepEqual(saved.trucks[0].loads[0].stops, fixture.previousPlan.trucks[0].loads[0].stops);
      assert.deepEqual((await witness()).jobs, before.jobs);
    });
  } finally {
    await rollback.rollback();
  }
});
