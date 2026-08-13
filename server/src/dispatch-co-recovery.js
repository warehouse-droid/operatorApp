import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";

export const ORIGINAL_GOA_CO_RECOVERY = Object.freeze({
  coId: 102,
  coRef: "CO-GOA-3464-3470-6922",
  sourceOrderRef: "GOA-3464-3470-6922",
  deliveryOrderId: -102,
  sourcePlanId: 48,
  sourcePlanDate: "2026-07-14",
  sourcePlanRevision: 326,
  truckPlate: "BC71838",
  loadName: "Load 2",
  fromLocationId: 28,
  fromYard: "2967",
  cancelledToLocationId: 15,
  cancelledToYard: "12441",
  originalToLocationId: 26,
  originalToYard: "150",
  originalAddress: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada",
  lineIds: [327, 328],
  sourceLineIds: [4438672, 4438982]
});

function text(value) {
  return String(value ?? "").trim();
}

function dateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return text(value).slice(0, 10);
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, stableValue(candidate)]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function planOrderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function stopRefs(stop = {}) {
  return [...new Set([
    stop.orderId,
    stop.order_id,
    stop.orderRef,
    stop.order_ref,
    ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : []),
    ...(Array.isArray(stop.order_refs) ? stop.order_refs : [])
  ].map(text).filter(Boolean))];
}

function restoredDetails(value, recoveredAt, requestedBy) {
  const expected = ORIGINAL_GOA_CO_RECOVERY;
  const visit = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!candidate || typeof candidate !== "object") return candidate;
    const next = Object.fromEntries(Object.entries(candidate).map(([key, nested]) => [key, visit(nested)]));
    if (text(next.transitCo?.id).toLowerCase() === expected.coRef.toLowerCase()) {
      next.transitCo = {
        ...next.transitCo,
        fromYard: expected.fromYard,
        toYard: expected.originalToYard
      };
      next.transitOriginalPickupLocations = [expected.fromYard];
      next.transitOriginalSourceYard = expected.fromYard;
      next.pickupLocations = [expected.originalToYard];
      next.sourceYard = expected.originalToYard;
    }
    return next;
  };
  const details = visit(value && typeof value === "object" ? value : {});
  delete details.cancelledAt;
  delete details.cancelledBy;
  details.dispatchCoRecovery = {
    version: 1,
    recoveredAt,
    recoveredBy: text(requestedBy) || "dispatch-co-recovery",
    sourcePlanId: String(expected.sourcePlanId),
    sourcePlanDate: expected.sourcePlanDate,
    sourcePlanRevision: expected.sourcePlanRevision,
    restoredFromYard: expected.fromYard,
    restoredToYard: expected.originalToYard
  };
  return details;
}

function recoveryError(mismatches) {
  const error = new Error(`CO recovery refused: ${mismatches.join("; ")}`);
  error.name = "DispatchCoRecoveryPredicateError";
  error.code = "DISPATCH_CO_RECOVERY_PREDICATE_FAILED";
  error.status = 409;
  error.mismatches = mismatches;
  return error;
}

function rowSummary(row = {}) {
  return {
    id: Number(row.id),
    coRef: text(row.co_ref),
    sourceOrderRef: text(row.source_order_ref),
    status: text(row.status),
    fromLocationId: Number(row.from_location_id),
    fromYard: text(row.from_location),
    toLocationId: Number(row.to_location_id),
    toYard: text(row.to_location),
    deliveryOrderId: Number(row.delivery_order_id),
    dispatchPlanId: Number(row.dispatch_plan_id),
    dispatchPlanDate: dateKey(row.dispatch_plan_date),
    truckPlate: text(row.dispatch_truck_plate),
    loadName: text(row.dispatch_load_name),
    updatedAt: row.updated_at || null
  };
}

function sourceEvidence(plan = {}) {
  const expected = ORIGINAL_GOA_CO_RECOVERY;
  const order = (Array.isArray(plan.orders) ? plan.orders : [])
    .find((candidate) => planOrderRef(candidate).toLowerCase() === expected.coRef.toLowerCase());
  let ownership = null;
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      const stops = (Array.isArray(load?.stops) ? load.stops : [])
        .filter((stop) => stopRefs(stop).some((ref) => ref.toLowerCase() === expected.coRef.toLowerCase()));
      if (!stops.length) continue;
      ownership = {
        truckId: text(truck.id || truck.truckId),
        truckPlate: text(truck.plate || truck.truckPlate || load.truckPlate),
        loadId: text(load.id || load.loadId),
        loadName: text(load.name || load.loadName),
        stopTypes: stops.map((stop) => text(stop.type).toLowerCase()).sort()
      };
      break;
    }
    if (ownership) break;
  }
  return { order, ownership };
}

function validateRecoveryState({ co, lines, plan }) {
  const expected = ORIGINAL_GOA_CO_RECOVERY;
  const mismatches = [];
  const alreadyRecovered = text(co?.status).toLowerCase() === "pending_load"
    && Number(co?.from_location_id) === expected.fromLocationId
    && text(co?.from_location) === expected.fromYard
    && Number(co?.to_location_id) === expected.originalToLocationId
    && text(co?.to_location) === expected.originalToYard
    && Number(co?.details?.dispatchCoRecovery?.version) === 1
    && Number(co?.details?.dispatchCoRecovery?.sourcePlanId) === expected.sourcePlanId;

  if (Number(co?.id) !== expected.coId) mismatches.push(`target row id must be ${expected.coId}`);
  if (text(co?.co_ref) !== expected.coRef) mismatches.push(`CO ref must be ${expected.coRef}`);
  if (text(co?.source_order_ref) !== expected.sourceOrderRef) mismatches.push(`source order must be ${expected.sourceOrderRef}`);
  if (Number(co?.delivery_order_id) !== expected.deliveryOrderId) mismatches.push(`delivery order id must be ${expected.deliveryOrderId}`);
  if (!alreadyRecovered && text(co?.status).toLowerCase() !== "cancelled") mismatches.push("target status must be cancelled or an idempotently recovered pending_load");
  if (!alreadyRecovered && (
    Number(co?.from_location_id) !== expected.fromLocationId
    || text(co?.from_location) !== expected.fromYard
  )) mismatches.push(`cancelled source must still be ${expected.fromYard}`);
  if (!alreadyRecovered && (
    Number(co?.to_location_id) !== expected.cancelledToLocationId
    || text(co?.to_location) !== expected.cancelledToYard
  )) mismatches.push(`observed cancelled destination must still be ${expected.cancelledToYard}`);
  if (Number(co?.dispatch_plan_id) !== expected.sourcePlanId) mismatches.push(`assignment plan must be ${expected.sourcePlanId}`);
  if (dateKey(co?.dispatch_plan_date) !== expected.sourcePlanDate) mismatches.push(`assignment date must be ${expected.sourcePlanDate}`);
  if (text(co?.dispatch_truck_plate) !== expected.truckPlate) mismatches.push(`assignment truck must be ${expected.truckPlate}`);
  if (text(co?.dispatch_load_name) !== expected.loadName) mismatches.push(`assignment load must be ${expected.loadName}`);
  if (co?.received_at || co?.loaded_at || co?.preparing_started_at) mismatches.push("received, loaded, and preparing timestamps must remain empty");

  const lineIds = (lines || []).map((line) => Number(line.id)).sort((a, b) => a - b);
  const sourceLineIds = (lines || []).map((line) => Number(line.line_id)).sort((a, b) => a - b);
  if (JSON.stringify(lineIds) !== JSON.stringify(expected.lineIds)) mismatches.push(`line row ids must be ${expected.lineIds.join(",")}`);
  if (JSON.stringify(sourceLineIds) !== JSON.stringify(expected.sourceLineIds)) mismatches.push(`source line ids must be ${expected.sourceLineIds.join(",")}`);

  if (Number(plan?.id) !== expected.sourcePlanId) mismatches.push(`source plan id must be ${expected.sourcePlanId}`);
  if (String(plan?.plan_date || "").slice(0, 10) !== expected.sourcePlanDate) mismatches.push(`source plan date must be ${expected.sourcePlanDate}`);
  if (text(plan?.status).toLowerCase() !== "confirmed") mismatches.push("source plan must remain confirmed");
  if (Number(plan?.revision) !== expected.sourcePlanRevision) mismatches.push(`source plan revision must remain ${expected.sourcePlanRevision}`);
  const evidence = sourceEvidence(plan);
  if (!evidence.order) {
    mismatches.push("source plan must retain the CO order snapshot");
  } else {
    if (text(evidence.order.sourceYard) !== expected.fromYard) mismatches.push(`source plan CO pickup must be ${expected.fromYard}`);
    if (text(evidence.order.destinationYard) !== expected.originalToYard) mismatches.push(`source plan CO destination must be ${expected.originalToYard}`);
    if (text(evidence.order.address) !== expected.originalAddress) mismatches.push("source plan CO destination address changed");
    if (JSON.stringify(evidence.order.pickupLocations || []) !== JSON.stringify([expected.fromYard])) {
      mismatches.push(`source plan CO pickup locations must be [${expected.fromYard}]`);
    }
  }
  if (!evidence.ownership) {
    mismatches.push("source plan must retain the CO truck/load stop");
  } else {
    if (evidence.ownership.truckPlate !== expected.truckPlate) mismatches.push(`source plan owner truck must be ${expected.truckPlate}`);
    if (evidence.ownership.loadName !== expected.loadName) mismatches.push(`source plan owner load must be ${expected.loadName}`);
    if (JSON.stringify(evidence.ownership.stopTypes) !== JSON.stringify(["drop", "pick"])) {
      mismatches.push("source plan must retain one pick and one drop CO stop");
    }
  }
  return { alreadyRecovered, evidence, mismatches };
}

export async function recoverOriginalGoaCo({
  apply = false,
  requestedBy = "dispatch-co-recovery",
  now = () => new Date()
} = {}) {
  const expected = ORIGINAL_GOA_CO_RECOVERY;
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const coResult = await query("SELECT * FROM local_co_orders WHERE co_ref = $1 FOR UPDATE", [expected.coRef]);
    const lineResult = await query(
      `SELECT *
         FROM local_co_order_lines
        WHERE co_id = $1
        ORDER BY id
        FOR SHARE`,
      [expected.coId]
    );
    const planResult = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision, s.orders, s.trucks, s.summary
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR SHARE OF p, s`,
      [expected.sourcePlanId]
    );
    if (coResult.rowCount !== 1) throw recoveryError([`expected exactly one ${expected.coRef} row`]);
    if (planResult.rowCount !== 1) throw recoveryError([`expected exactly one source plan ${expected.sourcePlanId}`]);
    const co = coResult.rows[0];
    const lines = lineResult.rows;
    const plan = planResult.rows[0];
    const validation = validateRecoveryState({ co, lines, plan });
    if (validation.mismatches.length) throw recoveryError(validation.mismatches);
    const lineFingerprint = fingerprint(lines);
    const before = rowSummary(co);
    const after = {
      ...before,
      status: "pending_load",
      fromLocationId: expected.fromLocationId,
      fromYard: expected.fromYard,
      toLocationId: expected.originalToLocationId,
      toYard: expected.originalToYard
    };
    const base = {
      target: expected.coRef,
      sourceOrderRef: expected.sourceOrderRef,
      mode: apply ? "apply" : "dry-run",
      applied: false,
      alreadyRecovered: validation.alreadyRecovered,
      before,
      after,
      lineCount: lines.length,
      lineFingerprint,
      sourcePlan: {
        id: String(plan.id),
        planDate: String(plan.plan_date).slice(0, 10),
        revision: Number(plan.revision),
        status: plan.status,
        ownership: validation.evidence.ownership
      }
    };
    if (!apply || validation.alreadyRecovered) return base;

    const recoveredAt = now().toISOString();
    const nextDetails = restoredDetails(co.details, recoveredAt, requestedBy);
    const updated = await query(
      `UPDATE local_co_orders
          SET status = 'pending_load',
              from_location_id = $2,
              from_location = $3,
              to_location_id = $4,
              to_location = $5,
              details = $6::jsonb,
              updated_at = now()
        WHERE id = $1
          AND status = 'cancelled'
        RETURNING *`,
      [
        expected.coId,
        expected.fromLocationId,
        expected.fromYard,
        expected.originalToLocationId,
        expected.originalToYard,
        JSON.stringify(nextDetails)
      ]
    );
    if (updated.rowCount !== 1) throw recoveryError(["target changed after validation"]);
    const updatedLines = await query(
      `SELECT *
         FROM local_co_order_lines
        WHERE co_id = $1
        ORDER BY id`,
      [expected.coId]
    );
    if (fingerprint(updatedLines.rows) !== lineFingerprint) throw recoveryError(["CO line rows changed during recovery"]);
    await writeDispatchAudit({
      action: "co_recovered_from_confirmed_plan",
      entityType: "order",
      entityId: expected.coRef,
      orderId: expected.coRef,
      sessionId: text(requestedBy),
      source: "dispatch-co-recovery",
      planId: expected.sourcePlanId,
      planDate: expected.sourcePlanDate,
      before: co,
      after: updated.rows[0],
      details: {
        sourceOrderRef: expected.sourceOrderRef,
        sourcePlanRevision: expected.sourcePlanRevision,
        lineCount: lines.length,
        lineFingerprint,
        recoveryVersion: 1
      }
    });
    return {
      ...base,
      applied: true,
      after: rowSummary(updated.rows[0]),
      recoveredAt
    };
  });
}
