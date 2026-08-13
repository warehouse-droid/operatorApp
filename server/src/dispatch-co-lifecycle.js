import { query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import {
  applyActiveTransitCoMetadata,
  clearCancelledTransitCoMetadata
} from "./dispatch-planner-performance.js";

function text(value) {
  return String(value ?? "").trim();
}

function planDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return text(value).slice(0, 10);
}

function orderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function orderRefs(order = {}) {
  const refs = new Set();
  const visit = (candidate = {}) => {
    const ref = orderRef(candidate);
    if (ref) refs.add(ref);
    const coRef = text(candidate.transitCo?.id);
    if (coRef) refs.add(coRef);
    for (const child of Array.isArray(candidate.childOrderDetails) ? candidate.childOrderDetails : []) visit(child);
  };
  visit(order);
  return refs;
}

function stopOrderRefs(stop = {}) {
  return [...new Set([
    stop.orderId,
    stop.order_id,
    stop.orderRef,
    stop.order_ref,
    stop.tranid,
    ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : []),
    ...(Array.isArray(stop.order_refs) ? stop.order_refs : [])
  ].map(text).filter(Boolean))];
}

function assignedCoRefs(plan = {}) {
  const refs = new Set();
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      for (const candidate of Array.isArray(load?.orders) ? load.orders : []) {
        const ref = typeof candidate === "string" ? text(candidate) : orderRef(candidate);
        if (ref.toUpperCase().startsWith("CO-")) refs.add(ref);
      }
      for (const stop of Array.isArray(load?.stops) ? load.stops : []) {
        for (const ref of stopOrderRefs(stop)) {
          if (ref.toUpperCase().startsWith("CO-")) refs.add(ref);
        }
      }
    }
  }
  return [...refs];
}

function planConflictRows(planRows = [], coRef = "") {
  const target = text(coRef).toLowerCase();
  const conflicts = [];
  for (const row of planRows || []) {
    if (String(row.status || "").toLowerCase() === "cancelled") continue;
    for (const truck of Array.isArray(row.trucks) ? row.trucks : []) {
      for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
        const loadRefs = new Set();
        for (const candidate of Array.isArray(load?.orders) ? load.orders : []) {
          const ref = typeof candidate === "string" ? text(candidate) : orderRef(candidate);
          if (ref) loadRefs.add(ref.toLowerCase());
        }
        for (const stop of Array.isArray(load?.stops) ? load.stops : []) {
          for (const ref of stopOrderRefs(stop)) loadRefs.add(ref.toLowerCase());
        }
        if (!loadRefs.has(target)) continue;
        conflicts.push({
          planId: text(row.id || row.plan_id),
          planDate: planDate(row.plan_date || row.planDate),
          status: text(row.status) || "draft",
          truckId: text(truck.id || truck.truckId || truck.truck_id),
          truckPlate: text(truck.plate || truck.truckPlate || truck.truck_plate),
          loadId: text(load.id || load.loadId || load.load_id),
          loadName: text(load.name || load.loadName || load.load_name),
          source: "snapshot"
        });
      }
    }
  }
  return conflicts;
}

export function dispatchCoPlanConflicts(planRows = [], coRef = "") {
  return planConflictRows(planRows, coRef);
}

export class DispatchCoAlreadyPlannedError extends Error {
  constructor(coRef, conflicts = []) {
    const first = conflicts[0] || {};
    const ownership = first.planDate
      ? ` It is owned by the ${first.planDate} Dispatch plan${first.loadName ? ` (${first.loadName})` : ""}.`
      : "";
    super(`${text(coRef) || "CO"} cannot be cancelled while it is planned.${ownership}`);
    this.name = "DispatchCoAlreadyPlannedError";
    this.code = "DISPATCH_CO_ALREADY_PLANNED";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

export class DispatchCoNotActiveError extends Error {
  constructor(conflicts = []) {
    const first = conflicts[0] || {};
    super(`${first.coRef || "A CO"} assigned to this plan is missing or cancelled.`);
    this.name = "DispatchCoNotActiveError";
    this.code = "DISPATCH_CO_NOT_ACTIVE";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

async function lockDispatchCoLifecycle() {
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
}

async function activePlanRows() {
  const result = await query(
    `SELECT p.id::text, p.plan_date::text AS plan_date, p.status, s.trucks
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
      ORDER BY p.plan_date, p.id`
  );
  return result.rows;
}

export async function cancelDispatchCoGlobally(coRef, { requestedBy = "" } = {}) {
  const cleanRef = text(coRef);
  return withTransaction(async () => {
    await lockDispatchCoLifecycle();
    const localResult = await query(
      `SELECT *
         FROM local_co_orders
        WHERE co_ref = $1
        FOR UPDATE`,
      [cleanRef]
    );
    const co = localResult.rows[0];
    if (!co || ["received", "loaded"].includes(String(co.status || "").toLowerCase())) return null;

    const rows = await activePlanRows();
    const conflicts = planConflictRows(rows, cleanRef);
    const assignedPlanId = text(co.dispatch_plan_id);
    if (assignedPlanId && !conflicts.some((conflict) => conflict.planId === assignedPlanId)) {
      const owner = rows.find((row) => text(row.id) === assignedPlanId);
      if (owner) {
        conflicts.push({
          planId: assignedPlanId,
          planDate: planDate(owner.plan_date || co.dispatch_plan_date),
          status: text(owner.status) || "draft",
          truckId: "",
          truckPlate: text(co.dispatch_truck_plate),
          loadId: "",
          loadName: text(co.dispatch_load_name),
          source: "assignment"
        });
      }
    }
    if (conflicts.length) throw new DispatchCoAlreadyPlannedError(cleanRef, conflicts);
    if (String(co.status || "").toLowerCase() === "cancelled") return co;

    const result = await query(
      `UPDATE local_co_orders
          SET status = 'cancelled',
              updated_at = now(),
              details = details || $2::jsonb
        WHERE id = $1
        RETURNING *`,
      [co.id, JSON.stringify({ cancelledBy: requestedBy || null, cancelledAt: new Date().toISOString() })]
    );
    return result.rows[0] || null;
  });
}

export async function assertActiveDispatchCosForPlan(plan = {}) {
  const refs = assignedCoRefs(plan);
  if (!refs.length) return plan;
  const result = await query(
    `SELECT co_ref, status
       FROM local_co_orders
      WHERE LOWER(co_ref) = ANY($1::text[])
      FOR SHARE`,
    [refs.map((ref) => ref.toLowerCase())]
  );
  const byRef = new Map(result.rows.map((row) => [text(row.co_ref).toLowerCase(), row]));
  const conflicts = refs.flatMap((coRef) => {
    const row = byRef.get(coRef.toLowerCase());
    if (row && String(row.status || "").toLowerCase() !== "cancelled") return [];
    return [{
      coRef,
      status: row?.status || "missing",
      planId: text(plan.id || plan.planId),
      planDate: planDate(plan.planDate || plan.plan_date)
    }];
  });
  if (conflicts.length) throw new DispatchCoNotActiveError(conflicts);
  return plan;
}

export async function reconcileDispatchPlanLocalCos(plan) {
  if (!plan) return null;
  const sourceRefs = new Set();
  const coRefs = new Set();
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) {
    for (const ref of orderRefs(order)) {
      if (ref.toUpperCase().startsWith("CO-")) coRefs.add(ref);
      else sourceRefs.add(ref);
    }
  }
  if (!sourceRefs.size && !coRefs.size) return plan;
  const result = await query(
    `SELECT co_ref, source_order_ref, from_location, to_location, status, created_at, updated_at
       FROM local_co_orders
      WHERE LOWER(source_order_ref) = ANY($1::text[])
         OR LOWER(co_ref) = ANY($2::text[])
      ORDER BY updated_at DESC, id DESC`,
    [[...sourceRefs].map((ref) => ref.toLowerCase()), [...coRefs].map((ref) => ref.toLowerCase())]
  );
  const cancelledByRef = new Map();
  const activeBySource = new Map();
  for (const row of result.rows) {
    const record = {
      coRef: text(row.co_ref),
      sourceOrderRef: text(row.source_order_ref),
      fromYard: text(row.from_location),
      toYard: text(row.to_location),
      createdAt: row.created_at || null
    };
    if (String(row.status || "").toLowerCase() === "cancelled") {
      cancelledByRef.set(record.coRef.toLowerCase(), record);
    } else if (!activeBySource.has(record.sourceOrderRef.toLowerCase())) {
      activeBySource.set(record.sourceOrderRef.toLowerCase(), record);
    }
  }
  const orders = (plan.orders || []).map((order) => applyActiveTransitCoMetadata(
    clearCancelledTransitCoMetadata(order, cancelledByRef),
    activeBySource
  ));
  return orders.some((order, index) => order !== plan.orders[index]) ? { ...plan, orders } : plan;
}
