import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createDispatchPlan,
  reconcileSalesOrderFamilyInDispatchPlans,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import {
  getDriverNextJobContext,
  recordDriverJobPhotos,
  startDriverJob
} from "../../../src/driver-repository.js";

after(closeDb);

async function seedLivePlan(label) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const login = `prefix-${label}-${suffix}`;
  const driver = (await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING id::text, login",
    [`Prefix ${label}`, login]
  )).rows[0];
  const truck = (await query(
    "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
    [`PX-${suffix}`]
  )).rows[0];
  const plan = await createDispatchPlan({ planDate: "2098-09-10", note: `prefix ${label}` });
  const trucks = [{
    id: truck.id,
    plate: truck.plate,
    driverLogin: driver.login,
    driver: `Prefix ${label}`,
    loads: [
      {
        id: `empty-${suffix}`,
        name: "Load 1",
        driverLogin: driver.login,
        driverSequence: 0,
        plannedStartMinute: 420,
        plannedFinishMinute: 450,
        stops: [],
        orders: []
      },
      {
        id: `active-${suffix}`,
        name: "Load 2",
        driverLogin: driver.login,
        driverSequence: 1,
        plannedStartMinute: 480,
        plannedFinishMinute: 520,
        switchYard: "12441",
        stops: [],
        orders: []
      },
      {
        id: `future-${suffix}`,
        name: "Load 3",
        driverLogin: driver.login,
        driverSequence: 2,
        plannedStartMinute: 560,
        plannedFinishMinute: 600,
        stops: [],
        orders: []
      }
    ]
  }];
  const saved = await saveDispatchPlanSnapshot(plan.id, {
    planDate: plan.planDate,
    baseRevision: plan.revision,
    orders: [],
    trucks,
    summary: {}
  });
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
       load_id, load_name, stop_id, stop_type, order_refs, status,
       started_at, completed_at, job_details
     ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'Load 2', $8,
       'truck_switch', '[]'::jsonb, 'in_progress', now(), NULL, $9::jsonb)`,
    [
      `switch-${suffix}`,
      plan.id,
      plan.planDate,
      driver.login,
      truck.id,
      truck.plate,
      `active-${suffix}`,
      `truck-switch-active-${suffix}`,
      JSON.stringify({ switchYard: "12441", nextTruckPlate: truck.plate })
    ]
  );
  return { saved, trucks };
}

test("a rejected cross-load edit changes neither revision nor snapshot, while a later load still saves", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const { saved, trucks } = await seedLivePlan("atomic");
      const before = (await query(
        `SELECT p.revision, s.orders, s.trucks, s.summary
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = $1`,
        [saved.id]
      )).rows[0];
      const unsafe = structuredClone(trucks);
      unsafe[0].loads.shift();
      await assert.rejects(
        saveDispatchPlanSnapshot(saved.id, {
          planDate: saved.planDate,
          baseRevision: saved.revision,
          orders: [],
          trucks: unsafe,
          summary: {}
        }),
        (error) => error?.status === 409 && error?.code === "DISPATCH_ROUTE_PREFIX_LOCKED"
      );
      const afterSnapshot = (await query(
        `SELECT p.revision, s.orders, s.trucks, s.summary
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = $1`,
        [saved.id]
      )).rows[0];
      assert.deepEqual(afterSnapshot, before, "the rejected plan mutation must be atomic");

      const safe = structuredClone(trucks);
      safe[0].loads[2].name = "Load 3 replanned";
      const updated = await saveDispatchPlanSnapshot(saved.id, {
        planDate: saved.planDate,
        baseRevision: saved.revision,
        orders: [],
        trucks: safe,
        summary: {}
      });
      assert.equal(updated.revision, saved.revision + 1);
      assert.equal(updated.trucks[0].loads[2].name, "Load 3 replanned");
    });
  } finally {
    await rollback.rollback();
  }
});

test("automated billed reconciliation defers instead of deleting a completed route prefix", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const orderRef = `TST-SO-PREFIX-${suffix}`.toUpperCase();
      const driver = (await query(
        "INSERT INTO dispatch_drivers (name, login, active) VALUES ('Reconciliation Driver', $1, true) RETURNING id::text, login",
        [`reconcile-${suffix}`]
      )).rows[0];
      const truck = (await query(
        "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
        [`RC-${suffix}`]
      )).rows[0];
      const plan = await createDispatchPlan({ planDate: "2098-09-11", note: "protected reconciliation" });
      const loadId = `reconcile-load-${suffix}`;
      const stopId = `reconcile-pick-${suffix}`;
      const orders = [{ id: orderRef, type: "SO", sourceYard: "12441", items: [] }];
      const trucks = [{
        id: truck.id,
        plate: truck.plate,
        driverLogin: driver.login,
        loads: [{
          id: loadId,
          name: "Completed route",
          driverLogin: driver.login,
          driverSequence: 0,
          stops: [{ id: stopId, type: "pick", orderId: orderRef, location: "12441" }]
        }]
      }];
      await query(
        `UPDATE dispatch_plan_snapshots
            SET orders = $2::jsonb, trucks = $3::jsonb, summary = '{}'::jsonb
          WHERE plan_id = $1`,
        [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]
      );
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
           load_id, load_name, stop_id, stop_type, order_refs, status,
           started_at, completed_at, job_details
         ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'Completed route', $8,
           'pickup', $9::jsonb, 'complete', now() - interval '5 minutes', now(), '{}'::jsonb)`,
        [
          `reconcile-job-${suffix}`,
          plan.id,
          plan.planDate,
          driver.login,
          truck.id,
          truck.plate,
          loadId,
          stopId,
          JSON.stringify([orderRef])
        ]
      );
      const before = (await query(
        `SELECT p.revision, s.orders, s.trucks,
                (SELECT count(*)::int FROM dispatch_plan_snapshot_history h WHERE h.plan_id = p.id) AS history_count
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = $1`,
        [plan.id]
      )).rows[0];

      const cleanup = await reconcileSalesOrderFamilyInDispatchPlans({
        canonicalRef: orderRef,
        familyRefs: [orderRef],
        billed: true,
        actor: "driver-route-prefix-test"
      });
      assert.equal(cleanup.deferred, true);
      assert.deepEqual(cleanup.changedPlans, []);
      assert.equal(cleanup.deferredPlans.length, 1);
      assert.equal(cleanup.deferredPlans[0].planId, String(plan.id));
      assert.ok(cleanup.deferredPlans[0].conflicts.some((conflict) =>
        ["DISPATCH_ACTIVE_LOAD_LOCKED", "DISPATCH_ROUTE_PREFIX_LOCKED"].includes(conflict.code)
      ));

      const persistedAfterCleanup = (await query(
        `SELECT p.revision, s.orders, s.trucks,
                (SELECT count(*)::int FROM dispatch_plan_snapshot_history h WHERE h.plan_id = p.id) AS history_count
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = $1`,
        [plan.id]
      )).rows[0];
      assert.deepEqual(
        persistedAfterCleanup,
        before,
        "deferred cleanup must not partially mutate the protected plan"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("the online cursor keeps a later active visit completable with photo evidence, then advances past old gaps", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const login = `cursor-${suffix}`;
      const driver = (await query(
        "INSERT INTO dispatch_drivers (name, login, active) VALUES ('Cursor Driver', $1, true) RETURNING login",
        [login]
      )).rows[0];
      const truck = (await query(
        "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
        [`CR-${suffix}`]
      )).rows[0];
      const planDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
      const plan = await createDispatchPlan({ planDate, note: "cursor repository" });
      const orders = ["OLD", "CURRENT", "FUTURE"].map((name) => ({
        id: `${name}-${suffix}`,
        type: "CUSTOM",
        sourceYard: "12441",
        address: `${name} Customer Road`,
        items: []
      }));
      const trucks = [{
        id: truck.id,
        plate: truck.plate,
        base: "12441",
        driverLogin: driver.login,
        driver: "Cursor Driver",
        loads: [
          {
            id: `old-load-${suffix}`,
            name: "Old load",
            driverLogin: driver.login,
            driverSequence: 0,
            plannedStartMinute: 420,
            stops: [
              { id: `old-pick-${suffix}`, type: "pick", orderId: orders[0].id, location: "12441" },
              { id: `old-drop-${suffix}`, type: "drop", orderId: orders[0].id, location: orders[0].address }
            ]
          },
          {
            id: `live-load-${suffix}`,
            name: "Live load",
            driverLogin: driver.login,
            driverSequence: 1,
            plannedStartMinute: 520,
            stops: [
              { id: `current-pick-${suffix}`, type: "pick", orderId: orders[1].id, location: "12441" },
              { id: `current-drop-${suffix}`, type: "drop", orderId: orders[1].id, location: orders[1].address },
              { id: `future-drop-${suffix}`, type: "drop", orderId: orders[2].id, location: orders[2].address }
            ]
          }
        ]
      }];
      await query(
        `UPDATE dispatch_plan_snapshots
            SET orders = $2::jsonb, trucks = $3::jsonb, summary = '{}'::jsonb
          WHERE plan_id = $1`,
        [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]
      );
      await query(
        "UPDATE dispatch_plans SET status = 'confirmed', confirmed_at = now() WHERE id = $1",
        [plan.id]
      );
      const initial = await getDriverNextJobContext(driver.login, { date: plan.planDate });
      assert.ok(initial.jobs.length >= 6, "the fixture must contain earlier, current, and future route work");
      const targetIndex = initial.jobs.findIndex((job) => job.stopId === `current-drop-${suffix}`);
      assert.ok(targetIndex > 0 && targetIndex < initial.jobs.length - 1);
      const target = { ...initial.jobs[targetIndex], requiredPhotos: 0 };
      await startDriverJob(driver.login, target.jobId, { job: target });

      const active = await getDriverNextJobContext(driver.login, { date: plan.planDate });
      assert.equal(active.job?.jobId, target.jobId);
      assert.ok(active.passedPendingJobIds.length > 0);
      const photo = `r2://driver-route-prefix/${suffix}/completion.jpg`;
      await recordDriverJobPhotos(driver.login, target.jobId, {
        job: { ...active.job, requiredPhotos: 0 },
        photoDataUrls: [photo]
      });
      const completed = (await query(
        "SELECT status, photo_data_urls FROM driver_job_records WHERE job_id = $1",
        [target.jobId]
      )).rows[0];
      assert.equal(completed.status, "complete");
      assert.deepEqual(completed.photo_data_urls, [photo]);

      const advanced = await getDriverNextJobContext(driver.login, { date: plan.planDate });
      assert.equal(advanced.job?.jobId, initial.jobs[targetIndex + 1].jobId);
      assert.ok(advanced.passedPendingJobIds.includes(initial.jobs[0].jobId));

      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, stop_type, status,
           started_at, completed_at, job_details
         ) VALUES ($1, $2, $3::date, $4, 'dropoff', 'in_progress', now(), NULL, '{}'::jsonb)`,
        [`orphan-${suffix}`, plan.id, plan.planDate, driver.login]
      );
      await assert.rejects(
        getDriverNextJobContext(driver.login, { date: plan.planDate }),
        (error) => error?.code === "DRIVER_ACTIVE_ROUTE_CONFLICT"
          && error?.activeJobIds?.includes(`orphan-${suffix}`)
      );
    });
  } finally {
    await rollback.rollback();
  }
});
