import { closeDb, query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { driverPwaStopStateHash, mapDriverPwaStopRecord } from "./driver-pwa-repository.js";

const TARGET = Object.freeze({
  planId: 183,
  expectedRevision: 36,
  planDate: "2026-07-31",
  recordId: 291,
  driverLogin: "sety",
  truckPlate: "CE94489",
  loadId: "T5-L1785447591839-95b64a1ce3d9c8",
  stopId: "stop-91bf2bf1-b986-4f38-947f-f66de2a81ebe",
  orderRef: "RP-BWS-WOODBRIGE-0730-2-v2",
  previousLocation: "3445",
  targetLocation: "12441",
  targetAddress: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  idempotencyId: "7d2ad4da-0a0d-4a43-9b6c-0d1ed0b81644",
  actor: "system:ce94489-20260731-repair",
  auditNote: "Map CE94489 Load 3 pickup evidence to 12441 after the live VRMA pickup changed before driver arrival but confirmed plan 183 retained 3445."
});

function assertRepair(condition, message) {
  if (!condition) {
    throw Object.assign(new Error(message), { code: "CE94489_REPAIR_ASSERTION_FAILED" });
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function dateValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return text(value).slice(0, 10);
}

function patchPlanOrder(order) {
  return {
    ...order,
    sourceYard: TARGET.targetLocation,
    pickupLocations: [TARGET.targetLocation],
    sourceAddress: TARGET.targetAddress,
    defaultSourceAddress: TARGET.targetAddress,
    raw: {
      ...(order.raw || {}),
      pickup_location: TARGET.targetLocation,
      source_address: TARGET.targetAddress
    }
  };
}

async function repair() {
  const dryRun = process.env.CE94489_REPAIR_DRY_RUN === "1";
  const result = await withTransaction(async () => {
    const prior = await query(
      `SELECT result
         FROM driver_job_corrections
        WHERE idempotency_id = $1::uuid
        LIMIT 1`,
      [TARGET.idempotencyId]
    );
    if (prior.rowCount) return { ...(prior.rows[0].result || {}), exactRetry: true };

    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const planResult = await query("SELECT * FROM dispatch_plans WHERE id = $1 FOR UPDATE", [TARGET.planId]);
    const snapshotResult = await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id = $1 FOR UPDATE", [TARGET.planId]);
    const vrmaResult = await query(
      `SELECT * FROM scm_vrma_orders
        WHERE lower(vrma_ref) = lower($1)
          AND cancelled_at IS NULL
        FOR SHARE`,
      [TARGET.orderRef]
    );
    const scheduleResult = await query(
      `SELECT * FROM scm_transport_schedule
        WHERE lower(order_ref) = lower($1)
        FOR SHARE`,
      [TARGET.orderRef]
    );
    const recordResult = await query(
      "SELECT * FROM driver_job_records WHERE id = $1 FOR UPDATE",
      [TARGET.recordId]
    );
    assertRepair(planResult.rowCount === 1, "Target dispatch plan 183 was not found.");
    assertRepair(snapshotResult.rowCount === 1, "Target dispatch plan snapshot 183 was not found.");
    assertRepair(vrmaResult.rowCount === 1, "Target VRMA source row was not found exactly once.");
    assertRepair(scheduleResult.rowCount === 1, "Target transport schedule row was not found exactly once.");
    assertRepair(recordResult.rowCount === 1, "Target Driver PWA stop record 291 was not found.");

    const plan = planResult.rows[0];
    const snapshot = snapshotResult.rows[0];
    const vrma = vrmaResult.rows[0];
    const schedule = scheduleResult.rows[0];
    const record = recordResult.rows[0];
    assertRepair(text(plan.status).toLowerCase() === "confirmed", "Plan 183 is no longer confirmed.");
    assertRepair(dateValue(plan.plan_date) === TARGET.planDate, "Plan 183 date changed.");
    assertRepair(Number(plan.revision) === TARGET.expectedRevision, `Plan 183 revision is ${plan.revision}, expected 36.`);
    assertRepair(text(vrma.pickup_location) === TARGET.targetLocation, "Live VRMA pickup is no longer 12441.");
    assertRepair(text(schedule.pickup_point) === TARGET.targetLocation, "Transport schedule pickup is no longer 12441.");
    assertRepair(Number(record.plan_id) === TARGET.planId, "Driver stop record plan changed.");
    assertRepair(text(record.driver_login).toLowerCase() === TARGET.driverLogin, "Driver stop owner changed.");
    assertRepair(text(record.load_id) === TARGET.loadId, "Driver stop load changed.");
    assertRepair(text(record.stop_id) === TARGET.stopId, "Driver stop identity changed.");
    assertRepair(text(record.status).toLowerCase() === "complete", "Driver stop is no longer complete.");
    assertRepair(text(record.job_details?.location) === TARGET.previousLocation, "Recorded pickup is no longer the expected stale 3445 value.");
    assertRepair(record.started_at && record.completed_at, "Recorded arrival/leave timestamps are missing.");
    assertRepair(Array.isArray(record.photo_data_urls) && record.photo_data_urls.length === 2, "Expected two durable pickup photos.");

    const orders = Array.isArray(snapshot.orders) ? structuredClone(snapshot.orders) : [];
    const orderIndexes = orders
      .map((order, index) => text(order?.id).toLowerCase() === TARGET.orderRef.toLowerCase() ? index : -1)
      .filter((index) => index >= 0);
    assertRepair(orderIndexes.length === 1, "Target order is not present exactly once in plan 183.");
    const orderIndex = orderIndexes[0];
    assertRepair(text(orders[orderIndex].sourceYard) === TARGET.previousLocation, "Confirmed plan order pickup is no longer the expected stale 3445 value.");
    orders[orderIndex] = patchPlanOrder(orders[orderIndex]);

    const trucks = Array.isArray(snapshot.trucks) ? structuredClone(snapshot.trucks) : [];
    const matchingStops = [];
    trucks.forEach((truck, truckIndex) => {
      (truck.loads || []).forEach((load, loadIndex) => {
        (load.stops || []).forEach((stop, stopIndex) => {
          if (text(stop?.id) === TARGET.stopId) matchingStops.push({ truck, load, stop, truckIndex, loadIndex, stopIndex });
        });
      });
    });
    assertRepair(matchingStops.length === 1, "Target pickup stop is not present exactly once in plan 183.");
    const match = matchingStops[0];
    assertRepair(text(match.truck.plate).toUpperCase() === TARGET.truckPlate, "Target stop truck changed.");
    assertRepair(text(match.load.id) === TARGET.loadId, "Target plan stop load changed.");
    assertRepair(text(match.stop.type).toLowerCase() === "pick", "Target stop is no longer a pickup.");
    assertRepair(text(match.stop.location) === TARGET.previousLocation, "Target plan stop is no longer at the expected stale 3445 value.");
    match.stop.location = TARGET.targetLocation;

    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              saved_at = now()
        WHERE plan_id = $1`,
      [TARGET.planId, JSON.stringify(orders), JSON.stringify(trucks)]
    );
    await query(
      `UPDATE dispatch_plans
          SET revision = revision + 1,
              updated_at = now()
        WHERE id = $1`,
      [TARGET.planId]
    );

    const mapped = await mapDriverPwaStopRecord({
      recordId: TARGET.recordId,
      targetLocation: TARGET.targetLocation,
      targetAddress: TARGET.targetAddress,
      expectedStateHash: driverPwaStopStateHash(record),
      auditNote: TARGET.auditNote,
      idempotencyId: TARGET.idempotencyId,
      correctedBy: TARGET.actor
    });
    await writeDispatchAudit({
      action: "dispatch_plan_driver_pickup_location_corrected",
      entityType: "dispatch_plan",
      entityId: String(TARGET.planId),
      orderId: TARGET.orderRef,
      loadId: TARGET.loadId,
      truckId: text(match.truck.id),
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      operatorName: TARGET.actor,
      source: "driver_pwa_repair",
      before: {
        revision: TARGET.expectedRevision,
        orderLocation: TARGET.previousLocation,
        stopLocation: TARGET.previousLocation
      },
      after: {
        revision: TARGET.expectedRevision + 1,
        orderLocation: TARGET.targetLocation,
        stopLocation: TARGET.targetLocation
      },
      details: {
        correctionId: mapped.correctionId,
        auditNote: TARGET.auditNote,
        preservedArrivalTime: record.started_at,
        preservedLeaveTime: record.completed_at,
        preservedPhotoCount: record.photo_data_urls.length,
        preservedOfflineEventId: record.source_offline_event_id
      }
    });
    return { ...mapped, planId: TARGET.planId, planRevision: TARGET.expectedRevision + 1 };
  }, { rollback: dryRun });
  return { ...result, dryRun };
}

try {
  const result = await repair();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
