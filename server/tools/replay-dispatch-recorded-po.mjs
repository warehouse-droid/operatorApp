import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDispatchPlan, saveDispatchPlanSnapshot, confirmDispatchPlan } from "../src/dispatch-plan-repository.js";
import { assertDispatchExecutedPrefixPreserved } from "../src/dispatch-executed-prefix-repository.js";
import { retiredConfirmBrowser } from "../test/support/retired-confirm-fixture.mjs";
import { replayRetiredConfirm, retiredConfirmWitness } from "./replay-dispatch-retired-confirm.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(new URL(process.env.DATABASE_URL).hostname, "replay-db");
const events = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
assert.ok(events.length > 0 && events.every(event => String(event.plan_id) === "324"));
const load = plan => plan.trucks.flatMap(truck => truck.loads || []).find(candidate => candidate.id === "T4-L1789349637541-7959d8854096b");
async function witness() {
  return { ...await retiredConfirmWitness(), po: (await query(`SELECT md5(row_to_json(p)::text) digest FROM purchase_orders p WHERE tranid='LOINC-033146'`)).rows,
    allocations: (await query(`SELECT md5(string_agg(row_to_json(a)::text,'|' ORDER BY id)) digest FROM dispatch_so_po_allocations a WHERE po_order_ref='LOINC-033146'`)).rows };
}
try {
  const before = await witness();
  await withTransaction(async () => {
    // Apply only current activity for this plan to the existing isolated copy.
    // The outer rollback restores even these modeled events.
    const known = new Set(events.map(event => event.job_id));
    const old = (await query("SELECT job_id FROM driver_job_records WHERE plan_id=324 AND status IN ('in_progress','complete')")).rows;
    assert.ok(old.every(row => known.has(row.job_id)), "A prior active event disappeared; refresh the scoped replay fixture");
    for (const event of events) {
      await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,job_details,started_at,completed_at)
        VALUES($1,324,$2::date,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,now(),CASE WHEN $11='complete' THEN now() ELSE NULL END)
        ON CONFLICT(job_id) DO UPDATE SET status=EXCLUDED.status,stop_type=EXCLUDED.stop_type,order_refs=EXCLUDED.order_refs,job_details=EXCLUDED.job_details`,
      [event.job_id,event.plan_date,event.driver_login,event.truck_id,event.truck_plate,event.load_id,event.load_name,event.stop_id,event.stop_type,JSON.stringify(event.order_refs),event.status,JSON.stringify(event.job_details)]);
    }
    const raw = { id: "324", ...(await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=324")).rows[0] };
    const current = await getDispatchPlan("324");
    assert.deepEqual(load(current).stops, load(raw).stops);
    assert.equal(load(current).stops.at(-1).dropSalesQty, 1500.29);
    assert.equal(current.orders.find(order => order.id === "LOINC-033146").poRouteProjection, undefined);
    await assertDispatchExecutedPrefixPreserved({ previousPlan: raw, nextPlan: current });
    const edited = structuredClone(current);
    load(edited).stops.at(-1).dropSalesQty = 225.89;
    await assert.rejects(assertDispatchExecutedPrefixPreserved({ previousPlan: raw, nextPlan: edited }), error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED");
    await withTransaction(async () => {
      const payload = retiredConfirmBrowser(current).planPayload();
      await saveDispatchPlanSnapshot("324", payload);
      const confirmed = await confirmDispatchPlan("324");
      assert.deepEqual(load(confirmed).stops, load(raw).stops);
      console.log(JSON.stringify({check:"current_recorded_load_save_confirm",passed:true,quantity:1500.29,activityEvents:events.length,protectedStops:6}));
    }, { rollback: true });
    for (const report of await replayRetiredConfirm({ currentRecordedPoActivity: true })) { console.log(JSON.stringify(report)); }
  }, { rollback: true });
  assert.deepEqual(await witness(), before);
  console.log(JSON.stringify({check:"recorded_po_rollback_postcheck",passed:true,plansDriversSourcePoAndAllocationUnchanged:true}));
} finally { await closeDb(); }
