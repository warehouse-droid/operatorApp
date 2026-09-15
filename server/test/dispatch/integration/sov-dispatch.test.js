import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, pool, query } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { saveDispatchPlanSnapshot, restoreDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { repairSovDispatchPlan } from "../../../src/sov-dispatch-repair.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";

after(closeDb);

async function seed({ started = false } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ref = `SOV${suffix.toUpperCase()}`;
  const sourceId = 9_500_000_000 + Number.parseInt(suffix, 16);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,
    outbound_location_id,outbound_location,netsuite_active,dispatch_address)
    VALUES($1,$2,'B','Pending Fulfillment','Delivery',4,'195',true,'20 Isolated Customer Road')`, [sourceId, ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,
    location_id,location,netsuite_active) VALUES($1,1,2836,'STONE','InvtPart',39,4,'195',true)`, [sourceId]);
  const orders = await listDispatchOrders({ type: "SO", exactOrderRefs: [ref] });
  assert.equal(orders.length, 1);
  const driver = `sov-${suffix}`;
  await query("INSERT INTO dispatch_drivers(name,login,active) VALUES($1,$1,true)", [driver]);
  const truck = (await query("INSERT INTO dispatch_trucks(plate,active) VALUES($1,true) RETURNING id::text,plate", [`SOV-${suffix}`])).rows[0];
  const p = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('2196-09-14','confirmed',7) RETURNING id::text,plan_date::text")).rows[0];
  const trucks = [{ id: truck.id, plate: truck.plate, base: "3445", driverLogin: driver, loads: [{
    id: `load-${suffix}`, name: "SOV repair load", driverLogin: driver,
    stops: [{ id: `drop-${suffix}`, type: "drop", orderId: ref, location: "195" }]
  }] }];
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')", [p.id, JSON.stringify(orders), JSON.stringify(trucks)]);
  if (started) {
    await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,
      load_id,load_name,stop_id,stop_type,order_refs,status,started_at,job_details)
      VALUES($1,$2,$3,$4,$5,$6,$7,'SOV repair load',$8,'dropoff',$9,'in_progress',now(),'{}')`,
    [`${p.id}:sov-drop`, p.id, p.plan_date, driver, truck.id, truck.plate, trucks[0].loads[0].id,
      trucks[0].loads[0].stops[0].id, JSON.stringify([ref])]);
  }
  return { id: p.id, ref, driver, sourceId, trucks, orders, planDate: p.plan_date };
}

async function witness(id) {
  return (await query(`SELECT
    (SELECT to_jsonb(p) FROM dispatch_plans p WHERE id=$1) AS plan,
    (SELECT to_jsonb(s) FROM dispatch_plan_snapshots s WHERE plan_id=$1) AS snapshot,
    (SELECT coalesce(jsonb_agg(j ORDER BY id),'[]') FROM driver_job_records j WHERE plan_id=$1) AS jobs,
    (SELECT count(*) FROM dispatch_plan_snapshot_history WHERE plan_id=$1) AS history`, [id])).rows[0];
}

test("SOV-14 repair rehearses and rolls back, commits once, then is a no-op", async () => {
  const context = await beginRollbackContext();
  const backupPath = `/tmp/sov-${crypto.randomUUID()}.json`;
  try {
    await context.run(async () => {
      const fixture = await seed();
      const before = await witness(fixture.id);
      const preview = await repairSovDispatchPlan({ planId: fixture.id });
      assert.equal(preview.changed, true);
      assert.equal(preview.addedPickupCount, 1);
      assert.equal(preview.rolledBack, true);
      assert.deepEqual(await witness(fixture.id), before);
      await assert.rejects(repairSovDispatchPlan({ planId: fixture.id, apply: true,
        expectedFingerprint: "stale", backupPath }), error => error.code === "SOV_REPAIR_STALE");
      assert.deepEqual(await witness(fixture.id), before);
      const applied = await repairSovDispatchPlan({ planId: fixture.id, apply: true,
        expectedFingerprint: preview.fingerprint, backupPath });
      assert.equal(applied.applied, true);
      const current = await witness(fixture.id);
      assert.equal(Number(current.plan.revision), 8);
      assert.equal(Number(current.history), 1);
      assert.deepEqual(current.jobs, before.jobs);
      assert.deepEqual(current.snapshot.trucks[0].loads[0].stops.map(stop => stop.type), ["pick", "drop"]);
      assert.equal(JSON.parse(await fs.readFile(backupPath, "utf8")).plan.revision, 7);
      assert.equal((await repairSovDispatchPlan({ planId: fixture.id })).changed, false);
      assert.deepEqual(await witness(fixture.id), current);
      const jobs = await getDriverDayJobs(fixture.driver, { date: fixture.planDate });
      const pickup = jobs.jobs.find(job => ["pick", "pickup"].includes(job.stopType));
      assert.ok(pickup);
      assert.equal(pickup.address, "195 Milner Ave Unit 5, Scarborough, ON M1S 4P4");
      assert.ok(jobs.jobs.some(job => ["drop", "dropoff"].includes(job.stopType)));
    });
  } finally { await context.rollback(); await fs.rm(backupPath, { force: true }); }
});

test("SOV-15 an already started delivery is reported and unrelated saves preserve it", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed({ started: true });
      const before = await witness(fixture.id);
      const result = await repairSovDispatchPlan({ planId: fixture.id });
      assert.equal(result.changed, false);
      assert.ok(result.protectedOrderRefs.includes(fixture.ref));
      assert.deepEqual(await witness(fixture.id), before);
      const saved = await saveDispatchPlanSnapshot(fixture.id, { planDate: fixture.planDate,
        baseRevision: 7, orders: fixture.orders, trucks: fixture.trucks, summary: { userNote: "Unrelated edit" } });
      assert.deepEqual(saved.trucks[0].loads[0].stops, fixture.trucks[0].loads[0].stops);
      assert.deepEqual((await witness(fixture.id)).jobs, before.jobs);
    });
  } finally { await context.rollback(); }
});

test("SOV-16 terminal and customer-pickup orders are not repaired", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed();
      for (const [status, method, active] of [["G", "Delivery", true], ["B", "Pick-Up", true], ["B", "Delivery", false]]) {
        await query("UPDATE sales_orders SET status=$2,sales_order_type=$3,netsuite_active=$4 WHERE netsuite_id=$1", [fixture.sourceId, status, method, active]);
        const before = await witness(fixture.id);
        assert.equal((await repairSovDispatchPlan({ planId: fixture.id })).changed, false);
        assert.deepEqual(await witness(fixture.id), before);
      }
    });
  } finally { await context.rollback(); }
});

test("SOV-15b a legacy strict load with a started missing pickup still allows unrelated saves", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed({ started: true });
      fixture.trucks[0].loads[0].pickupVisitSchemaVersion = 1;
      await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [fixture.id, JSON.stringify(fixture.trucks)]);
      const before = await witness(fixture.id);
      const saved = await saveDispatchPlanSnapshot(fixture.id, { planDate: fixture.planDate,
        baseRevision: 7, orders: fixture.orders, trucks: fixture.trucks, summary: { userNote: "Keep driving" } });
      assert.deepEqual(saved.trucks[0].loads[0].stops, fixture.trucks[0].loads[0].stops);
      assert.deepEqual((await witness(fixture.id)).jobs, before.jobs);
    });
  } finally { await context.rollback(); }
});

test("SOV-17 repair serializes with the same fleet lock used by driver commands", async () => {
  const fixture = await seed();
  const blocker = await pool.connect();
  let operation;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    let settled = false;
    operation = repairSovDispatchPlan({ planId: fixture.id }).finally(() => { settled = true; });
    operation.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, "repair must wait behind driver activity");
    await blocker.query("ROLLBACK");
    assert.equal((await operation).addedPickupCount, 1);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
    await operation?.catch(() => {});
    await query("DELETE FROM dispatch_plans WHERE id=$1", [fixture.id]);
  }
});

test("SOV-18 completed load assignments stay intact while another load gains its pickup", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed();
      const completedLoad = fixture.trucks[0].loads[0];
      await query(`INSERT INTO dispatch_plan_load_assignments(plan_id,plan_date,load_id,completed)
        VALUES($1,$2,$3,true)`, [fixture.id, fixture.planDate, completedLoad.id]);
      const pendingRef = `${fixture.ref}P`;
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,
        outbound_location_id,outbound_location,netsuite_active,dispatch_address)
        VALUES($1,$2,'B','Pending Fulfillment','Delivery',4,'195',true,'30 Isolated Customer Road')`, [fixture.sourceId + 1, pendingRef]);
      await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,
        location_id,location,netsuite_active) VALUES($1,1,2836,'STONE','InvtPart',12,4,'195',true)`, [fixture.sourceId + 1]);
      const orders = await listDispatchOrders({ type: "SO", exactOrderRefs: [fixture.ref, pendingRef] });
      fixture.trucks[0].loads.push({ ...completedLoad, id: `${completedLoad.id}-pending`,
        stops: [{ id: "pending-drop", type: "drop", orderId: pendingRef, location: "195" }] });
      await query("UPDATE dispatch_plan_snapshots SET orders=$2,trucks=$3 WHERE plan_id=$1",
        [fixture.id, JSON.stringify(orders), JSON.stringify(fixture.trucks)]);
      const before = await witness(fixture.id);
      const result = await repairSovDispatchPlan({ planId: fixture.id });
      assert.equal(result.addedPickupCount, 1);
      assert.deepEqual(result.changedLoadIds, [`${completedLoad.id}-pending`]);
      assert.ok(result.protectedOrderRefs.includes(fixture.ref));
      assert.deepEqual(await witness(fixture.id), before);
    });
  } finally { await context.rollback(); }
});

test("SOV-20 repair rejects invalid identities and honors fresh NetSuite eligibility", async () => {
  await assert.rejects(repairSovDispatchPlan({ planId: "-1" }), /positive dispatch plan ID/u);
  await assert.rejects(repairSovDispatchPlan({ planId: "2147483647" }), /plan was not found/u);
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed();
      const before = await witness(fixture.id);
      assert.equal((await repairSovDispatchPlan({ planId: fixture.id, eligibleOrderRefs: [] })).changed, false);
      const preview = await repairSovDispatchPlan({ planId: fixture.id, eligibleOrderRefs: [fixture.ref] });
      assert.equal(preview.addedPickupCount, 1);
      await assert.rejects(repairSovDispatchPlan({ planId: fixture.id, apply: true,
        eligibleOrderRefs: [fixture.ref], expectedFingerprint: preview.fingerprint }), /private backup path/u);
      assert.deepEqual(await witness(fixture.id), before);
    });
  } finally { await context.rollback(); }
});

test("SOV-22 restoring an unchanged started SOV snapshot retains the historical route", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed({ started: true });
      fixture.trucks[0].loads[0].pickupVisitSchemaVersion = 1;
      await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [fixture.id, JSON.stringify(fixture.trucks)]);
      await saveDispatchPlanSnapshot(fixture.id, { planDate: fixture.planDate, baseRevision: 7,
        orders: fixture.orders, trucks: fixture.trucks, summary: { userNote: "Unrelated edit" } });
      const before = await witness(fixture.id);
      const history = (await query("SELECT id FROM dispatch_plan_snapshot_history WHERE plan_id=$1 ORDER BY id DESC LIMIT 1", [fixture.id])).rows[0];
      await restoreDispatchPlanSnapshot(history.id, { sessionId: "sov-test" });
      const restored = await witness(fixture.id);
      assert.deepEqual(restored.jobs, before.jobs);
      assert.deepEqual(restored.snapshot.trucks[0].loads[0].stops, before.snapshot.trucks[0].loads[0].stops);
    });
  } finally { await context.rollback(); }
});
