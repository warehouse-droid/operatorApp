import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import {
  getDispatchPlan,
  saveDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";

const TARGET = Object.freeze({
  planId: 267,
  planDate: "2026-09-03",
  expectedRevision: 30,
  orderRef: "GOB-118968-119023",
  poRef: "LOINC-030542",
  pickupLocation: "TECHO BLOC Vaughan",
  loadId: "T3-L1788382684125-4cd619c5c20b48",
  driverLogin: "dao",
  actor: "system:dispatch-plan-267-authoritative-projection-repair",
  repairCode: "DISPATCH_PLAN_267_AUTHORITATIVE_PROJECTION_REPAIRED"
});

const ALLOWED_AUTHORITATIVE_ORDER_FIELDS = new Set([
  "childOrderDetails",
  "dependencyHidden",
  "dependentSalesOrderRef",
  "directPickupManifest",
  "items",
  "orderDependencies",
  "orderDependency",
  "pickupLocations",
  "poPickupManifest",
  "poRouteProjection",
  "raw"
]);

function text(value) {
  return String(value ?? "").trim();
}

function dateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10);
}

function assertRepair(condition, message) {
  if (!condition) {
    throw Object.assign(new Error(message), {
      code: "DISPATCH_PLAN_267_PROJECTION_REPAIR_ASSERTION_FAILED"
    });
  }
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

function oneOrder(orders, orderRef) {
  const matches = (orders || []).filter((order) => text(order?.id) === orderRef);
  assertRepair(matches.length === 1, `Expected ${orderRef} exactly once, found ${matches.length}.`);
  return matches[0];
}

function loadMap(trucks) {
  const result = new Map();
  for (const truck of trucks || []) {
    for (const load of truck?.loads || []) {
      const loadId = text(load?.id || load?.loadId);
      assertRepair(loadId, "Every live plan load must have an identity before repair.");
      assertRepair(!result.has(loadId), `Load ${loadId} occurs more than once.`);
      result.set(loadId, { truck, load });
    }
  }
  return result;
}

function oneLoad(trucks, loadId) {
  const match = loadMap(trucks).get(loadId);
  assertRepair(match, `Expected load ${loadId} exactly once.`);
  return match;
}

function changedOrderRefs(beforeOrders, afterOrders) {
  const before = new Map((beforeOrders || []).map((order) => [text(order?.id), order]));
  const after = new Map((afterOrders || []).map((order) => [text(order?.id), order]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => stableJson(before.get(ref)) !== stableJson(after.get(ref)))
    .sort();
}

function changedLoadIds(beforeTrucks, afterTrucks) {
  const before = loadMap(beforeTrucks);
  const after = loadMap(afterTrucks);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((loadId) => stableJson(before.get(loadId)?.load) !== stableJson(after.get(loadId)?.load))
    .sort();
}

function changedTopLevelFields(before = {}, after = {}) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => stableJson(before?.[field]) !== stableJson(after?.[field]))
    .sort();
}

function changedOrderDetails(beforeOrders, afterOrders, changedRefs) {
  const before = new Map((beforeOrders || []).map((order) => [text(order?.id), order]));
  const after = new Map((afterOrders || []).map((order) => [text(order?.id), order]));
  return changedRefs.map((orderRef) => ({
    orderRef,
    fields: changedTopLevelFields(before.get(orderRef), after.get(orderRef))
  }));
}

function changedLoadDetails(beforeTrucks, afterTrucks, changedIds) {
  const before = loadMap(beforeTrucks);
  const after = loadMap(afterTrucks);
  return changedIds.map((loadId) => ({
    loadId,
    fields: changedTopLevelFields(before.get(loadId)?.load, after.get(loadId)?.load)
  }));
}

function physicalLoadEvidence(load = {}) {
  return (load.stops || []).map((stop) => ({
    id: text(stop?.id || stop?.stopId),
    type: text(stop?.type || stop?.stopType),
    orderId: text(stop?.orderId || stop?.orderRef),
    orderRefs: stop?.orderRefs || [],
    groupedOrderRefs: stop?.groupedOrderRefs || [],
    location: text(stop?.location),
    dropLocation: text(stop?.dropLocation ?? stop?.drop_location),
    dropAddress: text(stop?.dropAddress ?? stop?.drop_address),
    dropoffKey: text(stop?.dropoffKey ?? stop?.dropoff_key),
    dependencyTargetRefs: stop?.dependencyTargetRefs || []
  }));
}

function changedPhysicalLoadIds(beforeTrucks, afterTrucks) {
  const before = loadMap(beforeTrucks);
  const after = loadMap(afterTrucks);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((loadId) => (
      stableJson(physicalLoadEvidence(before.get(loadId)?.load))
      !== stableJson(physicalLoadEvidence(after.get(loadId)?.load))
    ))
    .sort();
}

function projectionEvidence(orders, trucks) {
  const order = oneOrder(orders, TARGET.orderRef);
  const { truck, load } = oneLoad(trucks, TARGET.loadId);
  const stops = Array.isArray(load.stops) ? load.stops : [];
  const pickupIndexes = stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => (
      text(stop?.type).toLowerCase() === "pick"
      && text(stop?.location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
    ));
  const dropIndexes = stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => (
      text(stop?.type).toLowerCase() === "drop"
      && text(stop?.orderId || stop?.orderRef) === TARGET.orderRef
    ));
  const manifest = (order.poPickupManifest || []).filter((entry) => (
    text(entry?.poOrderRef) === TARGET.poRef
    && text(entry?.location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
  ));
  return {
    order,
    truck,
    load,
    pickupIndexes,
    dropIndexes,
    manifest,
    summary: {
      pickupLocations: order.pickupLocations || [],
      manifest: manifest.map((entry) => ({
        poOrderRef: entry.poOrderRef,
        location: entry.location,
        address: entry.address || ""
      })),
      truckId: text(truck?.id),
      truckPlate: text(truck?.plate),
      driverLogin: text(load?.driverLogin || load?.driver?.login),
      loadId: text(load?.id),
      routeProjectionRefreshRequired: load.routeProjectionRefreshRequired === true,
      routeEstimatePresent: Boolean(load.routeEstimate),
      stopSequence: (load.stops || []).map((stop) => ({
        id: text(stop?.id),
        type: text(stop?.type),
        orderId: text(stop?.orderId || stop?.orderRef),
        location: text(stop?.location),
        dependencyManaged: stop?.dependencyManaged === true
      }))
    }
  };
}

function assertCurrentProjection(evidence) {
  assertRepair(
    (evidence.order.pickupLocations || []).some((location) => (
      text(location).toLowerCase() === TARGET.pickupLocation.toLowerCase()
    )),
    `${TARGET.orderRef} does not contain the authoritative Techo pickup location.`
  );
  assertRepair(evidence.manifest.length === 1, "The current LOINC-to-Techo manifest is not unique.");
  assertRepair(evidence.pickupIndexes.length === 1, "The Techo route pickup is missing or duplicated.");
  assertRepair(evidence.dropIndexes.length === 1, "The GOB delivery stop is missing or duplicated.");
  assertRepair(
    evidence.pickupIndexes[0].index < evidence.dropIndexes[0].index,
    "The Techo pickup must occur before the GOB delivery."
  );
}

async function repair() {
  const dryRun = process.env.DISPATCH_PLAN_267_PROJECTION_REPAIR_APPLY !== "1";
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      TARGET.driverLogin,
      TARGET.planDate
    ]);
    // Block a browser from entering Edit Mode while the guarded save runs.
    await query("LOCK TABLE dispatch_plan_edit_leases IN SHARE ROW EXCLUSIVE MODE");

    const lease = await query(
      `SELECT operator_name, session_id, expires_at
         FROM dispatch_plan_edit_leases
        WHERE plan_date = $1::date
          AND expires_at > now()`,
      [TARGET.planDate]
    );
    assertRepair(lease.rowCount === 0, "A dispatcher currently holds the Sep-3 edit lease.");

    const planResult = await query("SELECT * FROM dispatch_plans WHERE id = $1 FOR UPDATE", [TARGET.planId]);
    const snapshotResult = await query(
      "SELECT * FROM dispatch_plan_snapshots WHERE plan_id = $1 FOR UPDATE",
      [TARGET.planId]
    );
    const assignmentResult = await query(
      `SELECT *
         FROM dispatch_plan_load_assignments
        WHERE plan_id = $1 AND load_id = $2
        FOR UPDATE`,
      [TARGET.planId, TARGET.loadId]
    );
    const activityResult = await query(
      `SELECT id, job_id, status, started_at, completed_at
         FROM driver_job_records
        WHERE plan_id = $1
          AND load_id = $2
          AND status IN ('in_progress', 'complete')
        FOR SHARE`,
      [TARGET.planId, TARGET.loadId]
    );

    assertRepair(planResult.rowCount === 1, "Dispatch plan 267 was not found.");
    assertRepair(snapshotResult.rowCount === 1, "Dispatch plan 267 snapshot was not found.");
    assertRepair(assignmentResult.rowCount === 1, "DAO Load 1 assignment was not found exactly once.");
    assertRepair(activityResult.rowCount === 0, "DAO Load 1 already has protected driver execution activity.");

    const planRow = planResult.rows[0];
    const snapshotBefore = snapshotResult.rows[0];
    const assignment = assignmentResult.rows[0];
    assertRepair(dateValue(planRow.plan_date) === TARGET.planDate, "Plan 267 moved off Sep-3.");
    assertRepair(text(planRow.status).toLowerCase() === "confirmed", "Plan 267 is no longer confirmed.");
    assertRepair(
      Number(planRow.revision) === TARGET.expectedRevision,
      `Plan 267 revision changed from ${TARGET.expectedRevision} to ${planRow.revision}.`
    );
    assertRepair(
      text(assignment.driver_login).toLowerCase() === TARGET.driverLogin,
      "DAO Load 1 is no longer assigned to dao."
    );

    const staleEvidence = projectionEvidence(snapshotBefore.orders, snapshotBefore.trucks);
    assertRepair(staleEvidence.pickupIndexes.length === 0, "The target route is already repaired; refusing to resave.");
    assertRepair(staleEvidence.manifest.length === 1, "The stale order no longer has the expected LOINC manifest.");

    const refreshed = await getDispatchPlan(TARGET.planId);
    const refreshedEvidence = projectionEvidence(refreshed.orders, refreshed.trucks);
    assertCurrentProjection(refreshedEvidence);

    const saved = await saveDispatchPlanSnapshot(TARGET.planId, {
      orders: refreshed.orders,
      trucks: refreshed.trucks,
      summary: refreshed.summary,
      baseRevision: TARGET.expectedRevision,
      planDate: TARGET.planDate,
      sessionId: TARGET.actor
    });
    assertRepair(saved.revision === TARGET.expectedRevision + 1, "The guarded save produced an unexpected revision.");

    const snapshotAfterResult = await query(
      "SELECT * FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [TARGET.planId]
    );
    const groupAfterResult = await query(
      `SELECT full_order, source_revision
         FROM dispatch_global_order_groups
        WHERE lower(group_ref) = lower($1)`,
      [TARGET.orderRef]
    );
    assertRepair(snapshotAfterResult.rowCount === 1, "The repaired snapshot could not be verified.");
    assertRepair(groupAfterResult.rowCount === 1, "The repaired global group could not be verified.");

    const snapshotAfter = snapshotAfterResult.rows[0];
    const repairedEvidence = projectionEvidence(snapshotAfter.orders, snapshotAfter.trucks);
    const groupEvidence = projectionEvidence(
      [groupAfterResult.rows[0].full_order],
      snapshotAfter.trucks
    );
    assertCurrentProjection(repairedEvidence);
    assertCurrentProjection(groupEvidence);

    const changedOrders = changedOrderRefs(snapshotBefore.orders, snapshotAfter.orders);
    const changedLoads = changedLoadIds(snapshotBefore.trucks, snapshotAfter.trucks);
    const physicalLoadChanges = changedPhysicalLoadIds(snapshotBefore.trucks, snapshotAfter.trucks);
    const orderChangeDetails = changedOrderDetails(snapshotBefore.orders, snapshotAfter.orders, changedOrders);
    const loadChangeDetails = changedLoadDetails(snapshotBefore.trucks, snapshotAfter.trucks, changedLoads);
    const unexpectedOrderFields = orderChangeDetails.flatMap(({ orderRef, fields }) => (
      fields
        .filter((field) => !ALLOWED_AUTHORITATIVE_ORDER_FIELDS.has(field))
        .map((field) => `${orderRef}.${field}`)
    ));
    assertRepair(changedOrders.includes(TARGET.orderRef), `${TARGET.orderRef} was not refreshed.`);
    assertRepair(
      unexpectedOrderFields.length === 0,
      `Unexpected order fields changed: ${unexpectedOrderFields.join(", ")}.`
    );
    assertRepair(
      stableJson(changedLoads) === stableJson([TARGET.loadId]),
      `Unexpected load changes: ${changedLoads.join(", ") || "none"}.`
    );
    assertRepair(
      stableJson(physicalLoadChanges) === stableJson([TARGET.loadId]),
      `Unexpected physical route changes: ${physicalLoadChanges.join(", ") || "none"}.`
    );
    assertRepair(
      stableJson(snapshotBefore.summary || {}) === stableJson(snapshotAfter.summary || {}),
      "The repair unexpectedly changed the plan summary."
    );
    assertRepair(
      Number(groupAfterResult.rows[0].source_revision) === TARGET.expectedRevision + 1,
      "The global group projection did not advance to the repaired revision."
    );

    await writeDispatchAudit({
      action: "dispatch_plan_authoritative_projection_repaired",
      entityType: "dispatch_order",
      entityId: TARGET.orderRef,
      orderId: TARGET.orderRef,
      loadId: TARGET.loadId,
      truckId: text(repairedEvidence.truck?.id),
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      sessionId: TARGET.actor,
      operatorName: TARGET.actor,
      source: "dispatch_live_repair",
      before: {
        revision: TARGET.expectedRevision,
        projection: staleEvidence.summary
      },
      after: {
        revision: TARGET.expectedRevision + 1,
        projection: repairedEvidence.summary
      },
      details: {
        repairCode: TARGET.repairCode,
        poRef: TARGET.poRef,
        changedOrderRefs: changedOrders,
        changedLoadIds: changedLoads,
        changedPhysicalLoadIds: physicalLoadChanges,
        reason: "The saved global group projection omitted the current PO-derived Techo pickup."
      }
    });

    return {
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      priorRevision: TARGET.expectedRevision,
      nextRevision: TARGET.expectedRevision + 1,
      changedOrderRefs: changedOrders,
      changedLoadIds: changedLoads,
      changedPhysicalLoadIds: physicalLoadChanges,
      orderChangeDetails,
      loadChangeDetails,
      projection: repairedEvidence.summary
    };
  }, { rollback: dryRun });
  return { ...result, dryRun };
}

try {
  console.log(JSON.stringify(await repair(), null, 2));
} finally {
  await closeDb();
}
