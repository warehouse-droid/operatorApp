import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";

const TARGET = Object.freeze({
  planId: 267,
  planDate: "2026-09-03",
  expectedRevision: 34,
  sourceSnapshotId: 16732,
  sourceRevision: 31,
  orderRef: "GOB-118968-119023",
  coRef: "CO-GOB-118968-119023",
  poRef: "LOINC-030542",
  pickupLocation: "TECHO BLOC Vaughan",
  loadId: "T3-L1788382684125-4cd619c5c20b48",
  actor: "system:dispatch-plan-267-rejected-readd-repair",
  repairCode: "DISPATCH_PLAN_267_REJECTED_READD_RESTORED"
});

const INVALID_ROUTE_LOAD_FIELDS = Object.freeze([
  "routeEstimate",
  "routeEstimateId",
  "routeSignature",
  "plannedFinishMinute",
  "finish",
  "finishTime",
  "timing"
]);

const INVALID_ROUTE_STOP_FIELDS = Object.freeze([
  "arriveTime",
  "departTime",
  "plannedArrive",
  "plannedDepart",
  "plannedArrival",
  "plannedDeparture",
  "timing"
]);

function text(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function assertRepair(condition, message) {
  if (condition) return;
  throw Object.assign(new Error(message), {
    code: "DISPATCH_PLAN_267_REJECTED_READD_REPAIR_ASSERTION_FAILED"
  });
}

function oneOrder(orders = [], orderRef = "") {
  const matches = orders.filter((order) => text(order?.id) === orderRef);
  assertRepair(matches.length === 1, `Expected ${orderRef} exactly once, found ${matches.length}.`);
  return matches[0];
}

function findLoad(trucks = [], loadId = "") {
  const matches = [];
  for (const truck of trucks) {
    for (const load of truck?.loads || []) {
      if (text(load?.id || load?.loadId) === loadId) matches.push({ truck, load });
    }
  }
  assertRepair(matches.length === 1, `Expected load ${loadId} exactly once, found ${matches.length}.`);
  return matches[0];
}

function isRestoredStop(stop = {}) {
  return (
    text(stop.type).toLowerCase() === "pick"
    && text(stop.location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
  ) || (
    text(stop.type).toLowerCase() === "drop"
    && text(stop.orderId || stop.orderRef) === TARGET.orderRef
  );
}

function routeInvalidated(load = {}) {
  const next = clone(load);
  for (const field of INVALID_ROUTE_LOAD_FIELDS) delete next[field];
  next.routeProjectionRefreshRequired = true;
  next.stops = (next.stops || []).map((stop) => {
    const clean = { ...stop };
    for (const field of INVALID_ROUTE_STOP_FIELDS) delete clean[field];
    return clean;
  });
  return next;
}

function mergeExactRestoredStops(currentLoad = {}, sourceLoad = {}) {
  const sourceStops = sourceLoad.stops || [];
  const currentStops = currentLoad.stops || [];
  const restored = sourceStops.filter(isRestoredStop);
  assertRepair(restored.length === 2, "The protected source snapshot does not contain exactly the Techo pickup and GOB drop.");
  assertRepair(currentStops.every((stop) => !isRestoredStop(stop)), "The active snapshot already contains part of the target route.");
  const currentById = new Map(currentStops.map((stop) => [text(stop.id), stop]));
  const sourceNonTargetIds = sourceStops.filter((stop) => !isRestoredStop(stop)).map((stop) => text(stop.id));
  const currentIds = currentStops.map((stop) => text(stop.id));
  assertRepair(
    stableJson(sourceNonTargetIds) === stableJson(currentIds),
    "The target load changed beyond the rejected GOB delete/re-add; refusing a partial restore."
  );
  const merged = sourceStops.map((stop) => (
    isRestoredStop(stop) ? clone(stop) : clone(currentById.get(text(stop.id)))
  ));
  return routeInvalidated({ ...currentLoad, stops: merged });
}

function targetEvidence(plan = {}) {
  const order = oneOrder(plan.orders || [], TARGET.orderRef);
  const { truck, load } = findLoad(plan.trucks || [], TARGET.loadId);
  const stops = load.stops || [];
  const pickupIndexes = stops.flatMap((stop, index) => (
    text(stop.type).toLowerCase() === "pick"
      && text(stop.location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
      ? [index]
      : []
  ));
  const dropIndexes = stops.flatMap((stop, index) => (
    text(stop.type).toLowerCase() === "drop"
      && text(stop.orderId || stop.orderRef) === TARGET.orderRef
      ? [index]
      : []
  ));
  const manifest = (order.poPickupManifest || []).filter((entry) => (
    text(entry?.poOrderRef) === TARGET.poRef
    && text(entry?.location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
  ));
  return { order, truck, load, pickupIndexes, dropIndexes, manifest };
}

function assertTargetEvidence(evidence) {
  assertRepair(evidence.pickupIndexes.length === 1, "The restored plan does not contain exactly one Techo pickup.");
  assertRepair(evidence.dropIndexes.length === 1, "The restored plan does not contain exactly one GOB drop.");
  assertRepair(evidence.pickupIndexes[0] < evidence.dropIndexes[0], "The restored Techo pickup is not before the GOB drop.");
  assertRepair(evidence.manifest.length === 1, "The current LOINC-030542 manifest is missing or duplicated.");
  assertRepair(
    (evidence.order.pickupLocations || []).some((location) => (
      text(location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
    )),
    "The restored GOB order projection does not require the Techo pickup."
  );
  assertRepair(evidence.load.routeProjectionRefreshRequired === true, "The restored load was not marked for route refresh.");
  assertRepair(!evidence.load.routeEstimate, "A stale route estimate survived the restored physical route.");
}

async function repair() {
  const dryRun = process.env.DISPATCH_PLAN_267_REJECTED_READD_APPLY !== "1";
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await query("LOCK TABLE dispatch_plan_edit_leases IN SHARE ROW EXCLUSIVE MODE");

    const planResult = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR UPDATE OF p, s`,
      [TARGET.planId]
    );
    const sourceResult = await query(
      `SELECT id, plan_id, plan_date::text AS plan_date, revision,
              archive_reason, orders, trucks
         FROM dispatch_plan_snapshot_history
        WHERE id = $1
        FOR SHARE`,
      [TARGET.sourceSnapshotId]
    );
    const activityResult = await query(
      `SELECT id, job_id, status
         FROM driver_job_records
        WHERE plan_id = $1
          AND load_id = $2
          AND status IN ('in_progress', 'complete', 'completed')
        FOR SHARE`,
      [TARGET.planId, TARGET.loadId]
    );

    assertRepair(planResult.rowCount === 1, "The active plan 267 snapshot was not found.");
    assertRepair(sourceResult.rowCount === 1, "The protected revision-31 snapshot was not found.");
    assertRepair(activityResult.rowCount === 0, "The Sep-3 target load now has protected Driver execution activity.");

    const current = planResult.rows[0];
    const source = sourceResult.rows[0];
    assertRepair(text(current.plan_date) === TARGET.planDate, "Plan 267 moved off Sep-3.");
    assertRepair(text(current.status).toLowerCase() === "confirmed", "Plan 267 is no longer confirmed.");
    assertRepair(Number(current.revision) === TARGET.expectedRevision, `Plan 267 changed from revision ${TARGET.expectedRevision} to ${current.revision}.`);
    assertRepair(Number(source.plan_id) === TARGET.planId, "The protected snapshot belongs to another plan.");
    assertRepair(Number(source.revision) === TARGET.sourceRevision, "The protected snapshot is not revision 31.");
    assertRepair(text(source.archive_reason) === "before_incremental_command", "The protected source is not the pre-delete checkpoint.");

    const sourceOrder = oneOrder(source.orders || [], TARGET.orderRef);
    const sourceLoad = findLoad(source.trucks || [], TARGET.loadId).load;
    assertRepair(!(current.orders || []).some((order) => text(order?.id) === TARGET.orderRef), "The active snapshot already contains the GOB order.");
    oneOrder(current.orders || [], TARGET.coRef);

    const currentTarget = findLoad(current.trucks || [], TARGET.loadId);
    const restoredLoad = mergeExactRestoredStops(currentTarget.load, sourceLoad);
    const restoredOrders = clone(current.orders || []);
    const sourceIndex = Math.max(0, (source.orders || []).findIndex((order) => text(order?.id) === TARGET.orderRef));
    restoredOrders.splice(Math.min(sourceIndex, restoredOrders.length), 0, clone(sourceOrder));
    const restoredTrucks = clone(current.trucks || []);
    const mutableTargetLoad = findLoad(restoredTrucks, TARGET.loadId).load;
    for (const field of Object.keys(mutableTargetLoad)) delete mutableTargetLoad[field];
    Object.assign(mutableTargetLoad, restoredLoad);

    const saved = await saveDispatchPlanSnapshot(TARGET.planId, {
      orders: restoredOrders,
      trucks: restoredTrucks,
      summary: clone(current.summary || {}),
      baseRevision: TARGET.expectedRevision,
      planDate: TARGET.planDate,
      sessionId: TARGET.actor,
      reactivatedGlobalOrderRefs: [TARGET.orderRef]
    });
    assertRepair(Number(saved.revision) === TARGET.expectedRevision + 1, "The guarded restore returned an unexpected revision.");
    const evidence = targetEvidence(saved);
    if (dryRun) {
      console.log(JSON.stringify({
        dryRunProbe: {
          pickupLocations: evidence.order.pickupLocations || [],
          poPickupManifest: evidence.order.poPickupManifest || [],
          routeProjectionRefreshRequired: evidence.load.routeProjectionRefreshRequired,
          routeEstimate: evidence.load.routeEstimate || null,
          stops: (evidence.load.stops || []).map((stop) => ({
            id: stop.id,
            type: stop.type,
            orderId: stop.orderId,
            location: stop.location
          }))
        }
      }, null, 2));
    }
    assertTargetEvidence(evidence);

    await writeDispatchAudit({
      action: "dispatch_plan_rejected_readd_restored",
      entityType: "dispatch_order",
      entityId: TARGET.orderRef,
      orderId: TARGET.orderRef,
      loadId: TARGET.loadId,
      truckId: text(evidence.truck?.id),
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      sessionId: TARGET.actor,
      operatorName: TARGET.actor,
      source: "dispatch_live_repair",
      before: {
        revision: TARGET.expectedRevision,
        targetOrderPresent: false,
        stopIds: (currentTarget.load.stops || []).map((stop) => text(stop.id))
      },
      after: {
        revision: TARGET.expectedRevision + 1,
        pickupLocations: evidence.order.pickupLocations || [],
        stopIds: (evidence.load.stops || []).map((stop) => text(stop.id))
      },
      details: {
        repairCode: TARGET.repairCode,
        sourceSnapshotId: TARGET.sourceSnapshotId,
        sourceRevision: TARGET.sourceRevision,
        poRef: TARGET.poRef,
        reason: "The browser autosaved the delete before the false completed-pickup guard rejected the re-add."
      }
    });

    return {
      dryRun,
      planId: TARGET.planId,
      priorRevision: TARGET.expectedRevision,
      nextRevision: TARGET.expectedRevision + 1,
      sourceSnapshotId: TARGET.sourceSnapshotId,
      pickupLocations: evidence.order.pickupLocations,
      stopSequence: evidence.load.stops.map((stop) => ({
        id: stop.id,
        type: stop.type,
        orderId: stop.orderId,
        location: stop.location
      }))
    };
  }, { rollback: dryRun });
  return result;
}

try {
  console.log(JSON.stringify(await repair(), null, 2));
} finally {
  await closeDb();
}
