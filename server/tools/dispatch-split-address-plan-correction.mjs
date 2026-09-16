// Run from /app via stdin; default rehearses the real save and rolls it back.
import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./src/db.js";
import { getDispatchPlan, saveDispatchPlanSnapshot } from "./src/dispatch-plan-repository.js";
import { getDriverPlanRoutesForDate } from "./src/driver-repository.js";
import { writeDispatchAudit } from "./src/dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./src/dispatch-fleet-status.js";

const targets = new Map([
  ["SOA08748-S1", "94 Mossbrook Crescent, Scarborough, ON M1W 2W9"],
  ["SOA08748-S2", "76 Heatherside Dr, Scarborough, ON M1W 1T7"]
]);
const apply = process.argv.includes("--apply");
function routeStructure(trucks) {
  return trucks.map(truck => ({ id: truck.id, driverLogin: truck.driverLogin, loads: (truck.loads || []).map(load => ({
    id: load.id, driverLogin: load.driverLogin, truckId: load.truckId,
    stops: (load.stops || []).map(stop => ({ id: stop.id, type: stop.type, orderId: stop.orderId,
      orderIds: stop.orderIds || [], orderRefs: stop.orderRefs || [], location: stop.location || "",
      dropLocation: stop.dropLocation || "", dropAddress: stop.dropAddress || "" }))
  })) }));
}
try {
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const current = await getDispatchPlan(327);
    assert.equal(Number(current.revision), 45, "Recheck if dispatch has edited this plan.");
    assert.equal(current.planDate, "2026-09-15");
    for (const [ref, address] of targets) assert.equal(current.orders.find(order => order.id === ref)?.destinationAddress, address);
    const activity = await query(`SELECT id FROM driver_job_records WHERE plan_id=327
      AND status IN ('in_progress','complete') AND stop_type IN ('drop','dropoff','delivery')
      AND (order_refs::text LIKE '%SOA08748-S1%' OR order_refs::text LIKE '%SOA08748-S2%')`);
    assert.equal(activity.rowCount, 0);
    const saved = await saveDispatchPlanSnapshot(327, { orders: current.orders, trucks: current.trucks,
      summary: current.summary, baseRevision: 45, planDate: current.planDate, sessionId: "split-address-support-correction" });
    assert.equal(saved.revision, 46);
    assert.deepEqual(routeStructure(saved.trucks), routeStructure(current.trucks));
    for (const order of current.orders) {
      const after = saved.orders.find(candidate => candidate.id === order.id);
      assert.ok(after, order.id);
      assert.deepEqual(after.items, order.items, `Cargo unchanged for ${order.id}`);
    }
    const driverDay = await getDriverPlanRoutesForDate(current.planDate);
    const deliveries = driverDay.routes.flatMap(route => route.jobs).filter(job => job.stopType === "dropoff");
    for (const [ref, address] of targets) assert.equal(deliveries.find(job => job.orderRefs.includes(ref))?.address, address);
    const archive = (await query("SELECT id FROM dispatch_plan_snapshot_history WHERE plan_id=327 AND revision=45 ORDER BY id DESC LIMIT 1")).rows[0];
    assert.ok(archive);
    const audit = await writeDispatchAudit({ action: "dispatch_plan_address_corrected", entityType: "plan", entityId: "327",
      planId: 327, planDate: current.planDate, source: "support-fix",
      before: { revision: 45 }, after: { revision: 46, addresses: Object.fromEntries(targets) },
      details: { reason: "Publish the user-confirmed split destinations to the driver plan after saving their persistent overrides.",
        archiveId: archive.id, routeSequenceUnchanged: true, cargoUnchanged: true } });
    return { applied: apply, rolledBack: !apply, revision: saved.revision, archiveId: archive.id,
      auditId: audit.id, routeSequenceUnchanged: true, cargoUnchanged: true,
      deliveries: deliveries.filter(job => job.orderRefs.some(ref => targets.has(ref))).map(job => ({ orderRefs: job.orderRefs, address: job.address })) };
  }, { rollback: !apply });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
