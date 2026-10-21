// Run from /app via: node --input-type=module - [--apply] < this-file
// The default rehearses the complete correction in a rolled-back transaction.
import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./src/dispatch-fleet-status.js";
import { driverPwaStopStateHash, reopenDriverPwaStop, mapDriverPwaStopRecord } from "./src/driver-pwa-repository.js";
import { setPurchaseOrderVendorYard, enrichDispatchOrdersWithPoTargetAllocations } from "./src/dispatch-repository.js";
import { stripDispatchRelationshipProjection, invalidateLoadRoute } from "./src/dispatch-plan-order-projection.js";
import { saveDispatchPlanSnapshot } from "./src/dispatch-plan-repository.js";
import { getDriverDayJobs } from "./src/driver-repository.js";
import { writeDispatchAudit } from "./src/dispatch-audit-repository.js";

const target = {
  planId: 340, revision: 49, date: "2026-09-28", recordId: 5017,
  poRef: "LOINC-035516", poId: 1007015, orderRef: "SOM06647",
  loadId: "T5-L1790536547849-148fc44040356",
  stopId: "stop-02e9ef23-1301-4b99-88c1-1c2178821c59",
  driver: "li", plate: "CC46868", yard: "TECHO BLOC Vaughan",
  address: "720 Arrow Rd. North York, ON M9M 2M1",
  reopenId: "c99d6944-a6d0-46f7-a0a3-1169b275bfef",
  mapId: "f7267d36-b73f-4cb3-822d-76f6812f6b2c"
};
const actor = "support:loinc-035516-pickup-correction";
const note = "User confirmed Vaughan pickup is still pending and explicitly requested reopening and correcting the stop so the driver can complete it.";
const apply = process.argv.includes("--apply");

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const previousCorrection = (await query("SELECT result FROM driver_job_corrections WHERE idempotency_id=$1::uuid", [target.mapId])).rows[0];
    if (previousCorrection) return { alreadyApplied: true, ...previousCorrection.result };
    const before = (await query(`SELECT p.id,p.plan_date::text,p.status,p.revision,s.orders,s.trucks,s.summary
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
      WHERE p.id=$1 FOR UPDATE OF p,s`, [target.planId])).rows[0];
    assert.equal(before.plan_date, target.date);
    assert.equal(before.status, "confirmed");
    assert.equal(Number(before.revision), target.revision, "Plan changed; inspect before retrying.");
    const record = (await query("SELECT * FROM driver_job_records WHERE id=$1 FOR UPDATE", [target.recordId])).rows[0];
    assert.equal(record.status, "in_progress");
    assert.equal(record.driver_login, target.driver);
    assert.equal(record.truck_plate, target.plate);
    assert.equal(record.load_id, target.loadId);
    assert.equal(record.stop_id, target.stopId);
    assert.equal(Number(record.plan_id), target.planId);
    assert.equal(record.completed_at, null);
    assert.deepEqual(record.order_refs, [target.orderRef]);
    const source = (await query("SELECT * FROM purchase_orders WHERE netsuite_id=$1 FOR UPDATE", [target.poId])).rows[0];
    assert.equal(source.dispatch_ref, target.poRef);
    const schedule = (await query("SELECT pickup_point FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref=$1 FOR SHARE", [target.poRef])).rows[0];
    assert.equal(schedule.pickup_point, target.yard);
    const yard = (await query("SELECT id,address FROM dispatch_vendor_yards WHERE yard=$1 AND active=true ORDER BY CASE WHEN day_label='Mon-Fri' THEN 0 ELSE 1 END,id LIMIT 1", [target.yard])).rows[0];
    assert.equal(yard.address, target.address);
    const otherRecords = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1 AND id<>$2 ORDER BY id", [target.planId, target.recordId])).rows;
    const reopened = await reopenDriverPwaStop({ recordId: target.recordId,
      expectedStateHash: driverPwaStopStateHash(record), auditNote: note,
      idempotencyId: target.reopenId, reopenedBy: actor });
    assert.equal(reopened.status, "pending");
    await setPurchaseOrderVendorYard(target.poRef, yard.id);
    const oldOrder = before.orders.find(order => order.id === target.orderRef);
    assert.ok(oldOrder);
    const [order] = await enrichDispatchOrdersWithPoTargetAllocations([stripDispatchRelationshipProjection(oldOrder)]);
    assert.deepEqual(order.poPickupManifest.map(entry => [entry.poOrderRef, entry.location, entry.address]),
      [[target.poRef, target.yard, target.address]]);
    const trucks = structuredClone(before.trucks);
    const truck = trucks.find(row => row.plate === target.plate);
    const loadIndex = truck.loads.findIndex(load => load.id === target.loadId);
    assert.ok(loadIndex >= 0);
    const load = truck.loads[loadIndex];
    assert.equal(load.driverLogin, target.driver);
    const stop = load.stops.find(row => row.id === target.stopId);
    assert.equal(stop.location, "TECHO BLOC Ayr");
    stop.location = target.yard;
    truck.loads[loadIndex] = invalidateLoadRoute(load);
    const saved = await saveDispatchPlanSnapshot(target.planId, {
      orders: before.orders.map(candidate => candidate.id === target.orderRef ? order : candidate),
      trucks, summary: before.summary, baseRevision: target.revision, planDate: target.date,
      sessionId: actor
    });
    const pending = (await query("SELECT * FROM driver_job_records WHERE id=$1", [target.recordId])).rows[0];
    assert.equal(pending.status, "pending");
    const mapped = await mapDriverPwaStopRecord({ recordId: target.recordId,
      targetLocation: target.yard, targetAddress: target.address,
      expectedStateHash: driverPwaStopStateHash(pending), auditNote: note,
      idempotencyId: target.mapId, correctedBy: actor });
    const stored = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [target.planId])).rows[0];
    const otherLoads = value => value.trucks.flatMap(row => row.loads || []).filter(row => row.id !== target.loadId);
    assert.deepEqual(otherLoads(stored), otherLoads(before), "Unrelated loads must remain unchanged.");
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1 AND id<>$2 ORDER BY id", [target.planId, target.recordId])).rows,
      otherRecords, "Unrelated driver records must remain unchanged.");
    const route = await getDriverDayJobs(target.driver, { date: target.date });
    const job = route.jobs.find(row => row.stopId === target.stopId);
    assert.ok(job, "Original pickup identity must remain assigned to the driver.");
    assert.equal(job.status, "pending");
    assert.equal(job.location || job.pickupLocation, target.yard);
    assert.equal(job.address, target.address);
    const afterRecord = (await query("SELECT * FROM driver_job_records WHERE id=$1", [target.recordId])).rows[0];
    assert.equal(afterRecord.started_at, null);
    assert.equal(afterRecord.completed_at, null);
    assert.deepEqual(afterRecord.photo_data_urls, record.photo_data_urls);
    const audit = await writeDispatchAudit({ action: "dispatch_pickup_yard_corrected", entityType: "order",
      entityId: target.poRef, orderId: target.orderRef, loadId: target.loadId, truckId: truck.id,
      planId: target.planId, planDate: target.date, operatorName: actor, source: "support-fix",
      before: { revision: target.revision, poYard: source.dispatch_vendor_yard, order: oldOrder },
      after: { revision: saved.revision, poYard: target.yard, order },
      details: { note, reopenCorrectionId: reopened.correctionId, locationCorrectionId: mapped.correctionId } });
    return { applied: apply, rolledBack: !apply, planId: target.planId, revision: saved.revision,
      orderRef: target.poRef, linkedOrderRef: target.orderRef, driver: target.driver, truck: target.plate,
      stopId: target.stopId, status: job.status, pickup: job.location, address: job.address,
      auditId: audit.id, reopenCorrectionId: reopened.correctionId, locationCorrectionId: mapped.correctionId,
      otherLoadsPreserved: true, otherDriverRecordsPreserved: true };
  }, { rollback: !apply });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
