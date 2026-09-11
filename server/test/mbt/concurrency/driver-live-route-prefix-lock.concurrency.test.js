import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";

after(closeDb);

const isolated = process.env.MBT_TEST_ISOLATED === "1";

test("a Driver start committed under the fleet lock makes a waiting prefix deletion fail atomically", { skip: !isolated }, async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const login = `prefix-race-${suffix}`;
  const driver = (await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING id::text, login",
    ["Prefix race", login]
  )).rows[0];
  const truck = (await query(
    "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
    [`PR-${suffix}`]
  )).rows[0];
  const plan = await createDispatchPlan({ planDate: "2098-09-11", note: "prefix race" });
  const trucks = [{
    id: truck.id,
    plate: truck.plate,
    driverLogin: driver.login,
    loads: [
      { id: `empty-${suffix}`, name: "Load 1", driverLogin: driver.login, driverSequence: 0, plannedStartMinute: 420, stops: [] },
      { id: `active-${suffix}`, name: "Load 2", driverLogin: driver.login, driverSequence: 1, plannedStartMinute: 480, switchYard: "12441", stops: [] }
    ]
  }];
  try {
    const saved = await saveDispatchPlanSnapshot(plan.id, {
      planDate: plan.planDate,
      baseRevision: plan.revision,
      orders: [],
      trucks,
      summary: {}
    });
    let releaseDriver;
    let driverHasLock;
    const locked = new Promise((resolve) => { driverHasLock = resolve; });
    const release = new Promise((resolve) => { releaseDriver = resolve; });
    const driverStart = withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
           load_id, load_name, stop_id, stop_type, order_refs, status,
           started_at, completed_at, job_details
         ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'Load 2', $8,
           'truck_switch', '[]'::jsonb, 'in_progress', now(), NULL, '{}'::jsonb)`,
        [`race-job-${suffix}`, plan.id, plan.planDate, driver.login, truck.id, truck.plate,
          `active-${suffix}`, `truck-switch-${suffix}`]
      );
      driverHasLock();
      await release;
    });
    await locked;
    const unsafe = structuredClone(trucks);
    unsafe[0].loads.shift();
    const waitingSave = saveDispatchPlanSnapshot(saved.id, {
      planDate: saved.planDate,
      baseRevision: saved.revision,
      orders: [],
      trucks: unsafe,
      summary: {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseDriver();
    await driverStart;
    await assert.rejects(
      waitingSave,
      (error) => error?.code === "DISPATCH_ROUTE_PREFIX_LOCKED"
    );
    assert.equal(
      Number((await query("SELECT revision FROM dispatch_plans WHERE id = $1", [plan.id])).rows[0].revision),
      saved.revision
    );
  } finally {
    await query("DELETE FROM driver_job_records WHERE plan_id = $1", [plan.id]);
    await query("DELETE FROM dispatch_plans WHERE id = $1", [plan.id]);
    await query("DELETE FROM dispatch_trucks WHERE id = $1", [truck.id]);
    await query("DELETE FROM dispatch_drivers WHERE id = $1", [driver.id]);
  }
});
