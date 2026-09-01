import { query, withTransaction } from "./db.js";
import { canonicalizeDispatchCoGroupIdentities } from "./dispatch-co-group-identity.js";
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
    for (const childRef of Array.isArray(candidate.childOrders) ? candidate.childOrders : []) {
      if (text(childRef)) refs.add(text(childRef));
    }
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
    ...(Array.isArray(stop.order_refs) ? stop.order_refs : []),
    ...(Array.isArray(stop.groupedOrderRefs) ? stop.groupedOrderRefs : []),
    ...(Array.isArray(stop.grouped_order_refs) ? stop.grouped_order_refs : [])
  ].map(text).filter(Boolean))];
}

function isCoRef(value) {
  return text(value).toUpperCase().startsWith("CO-");
}

function isAggregateCoGroup(order = {}) {
  if (text(order.type).toUpperCase() !== "CO") return false;
  return (Array.isArray(order.childOrders) ? order.childOrders : []).some(isCoRef)
    || (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []).some((child) =>
      text(child?.type).toUpperCase() === "CO" || isCoRef(orderRef(child))
    );
}

function coRefsInOrder(order = {}) {
  const refs = [...orderRefs(order)].filter(isCoRef);
  if (!isAggregateCoGroup(order)) return refs;
  const aggregateRef = orderRef(order).toLowerCase();
  return refs.filter((ref) => ref.toLowerCase() !== aggregateRef);
}

function coMembershipByOrder(plan = {}) {
  return new Map((Array.isArray(plan.orders) ? plan.orders : [])
    .map((order) => [orderRef(order).toLowerCase(), coRefsInOrder(order)])
    .filter(([ref]) => ref));
}

function assignedCoRefs(plan = {}) {
  const refs = new Set();
  const membership = coMembershipByOrder(plan);
  const add = (candidate) => {
    const ref = text(candidate);
    if (!ref) return;
    const memberRefs = membership.get(ref.toLowerCase()) || [];
    if (memberRefs.length) {
      for (const childRef of memberRefs) refs.add(childRef);
    } else if (isCoRef(ref)) {
      refs.add(ref);
    }
  };
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      for (const candidate of Array.isArray(load?.orders) ? load.orders : []) {
        const ref = typeof candidate === "string" ? text(candidate) : orderRef(candidate);
        add(ref);
      }
      for (const stop of Array.isArray(load?.stops) ? load.stops : []) {
        for (const ref of stopOrderRefs(stop)) {
          add(ref);
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
    const membership = coMembershipByOrder(row);
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
        const containsTarget = [...loadRefs].some((ref) =>
          ref === target || (membership.get(ref) || []).some((childRef) => childRef.toLowerCase() === target)
        );
        if (!containsTarget) continue;
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
    `SELECT p.id::text, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
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
    if (!co || ["received", "loaded", "completed"].includes(String(co.status || "").toLowerCase())) return null;

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
  plan = canonicalizeDispatchCoGroupIdentities(plan);
  const sourceRefs = new Set();
  const coRefs = new Set();
  const transitFallbackByRef = new Map();
  const collect = (order = {}) => {
    const ref = orderRef(order);
    if (ref && !(isCoRef(ref) && isAggregateCoGroup(order))) {
      (isCoRef(ref) ? coRefs : sourceRefs).add(ref);
    }
    const transitRef = text(order.transitCo?.id);
    if (transitRef) {
      coRefs.add(transitRef);
      transitFallbackByRef.set(transitRef.toLowerCase(), {
        coRef: transitRef,
        sourceOrderRef: ref,
        fromYard: text(order.transitCo?.fromYard || order.transitOriginalSourceYard),
        toYard: text(order.transitCo?.toYard)
      });
    }
    for (const childRef of Array.isArray(order.childOrders) ? order.childOrders : []) {
      const cleanRef = text(childRef);
      if (cleanRef) (isCoRef(cleanRef) ? coRefs : sourceRefs).add(cleanRef);
    }
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) collect(child);
  };
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) {
    collect(order);
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
  const activeByRef = new Map();
  const activeBySource = new Map();
  for (const row of result.rows) {
    const record = {
      coRef: text(row.co_ref),
      sourceOrderRef: text(row.source_order_ref),
      fromYard: text(row.from_location),
      toYard: text(row.to_location),
      status: text(row.status),
      createdAt: row.created_at || null
    };
    if (String(row.status || "").toLowerCase() === "cancelled") {
      cancelledByRef.set(record.coRef.toLowerCase(), record);
    } else {
      activeByRef.set(record.coRef.toLowerCase(), record);
      if (!activeBySource.has(record.sourceOrderRef.toLowerCase())) {
        activeBySource.set(record.sourceOrderRef.toLowerCase(), record);
      }
    }
  }
  const invalidCoRefs = new Set([...coRefs]
    .map((ref) => ref.toLowerCase())
    .filter((ref) => !activeByRef.has(ref)));
  for (const ref of invalidCoRefs) {
    if (!cancelledByRef.has(ref)) {
      cancelledByRef.set(ref, transitFallbackByRef.get(ref) || { coRef: ref, fromYard: "", toYard: "" });
    }
  }

  const removedOrderRefs = new Set([...invalidCoRefs].filter(isCoRef));
  const aggregateGroup = (order, childOrderDetails) => {
    const sum = (field) => childOrderDetails.reduce((total, child) => total + Number(child?.[field] || 0), 0);
    return {
      ...order,
      childOrders: childOrderDetails.map(orderRef).filter(Boolean),
      childOrderDetails,
      items: childOrderDetails.flatMap((child) => Array.isArray(child.items) ? child.items : []),
      pallets: sum("pallets"),
      layers: sum("layers"),
      sections: sum("sections"),
      pieces: sum("pieces"),
      salesQty: sum("salesQty"),
      weight: sum("weight"),
      unloadMinutes: sum("unloadMinutes"),
      travelMinutes: Math.max(0, ...childOrderDetails.map((child) => Number(child?.travelMinutes || 0))),
      pickupLocations: [...new Set(childOrderDetails.flatMap((child) => child.pickupLocations || []).map(text).filter(Boolean))],
      customer: `${childOrderDetails.length} orders grouped`,
      sourceOrderId: "",
      relatedSoId: "",
      relatedToId: "",
      relatedCustomOrderId: "",
      transitCo: null
    };
  };
  const reconcileOrder = (order) => {
    const ref = orderRef(order);
    if (isCoRef(ref) && !isAggregateCoGroup(order) && invalidCoRefs.has(ref.toLowerCase())) return null;
    let next = applyActiveTransitCoMetadata(
      clearCancelledTransitCoMetadata(order, cancelledByRef),
      activeBySource
    );
    const originalChildren = Array.isArray(next.childOrderDetails) ? next.childOrderDetails : [];
    const childOrderDetails = originalChildren.map(reconcileOrder).filter(Boolean);
    const listedChildren = Array.isArray(next.childOrders) ? next.childOrders.map(text).filter(Boolean) : [];
    const retainedListed = listedChildren.filter((childRef) =>
      !isCoRef(childRef) || !invalidCoRefs.has(childRef.toLowerCase())
    );
    const isCoGroup = text(next.type).toUpperCase() === "CO" && listedChildren.some(isCoRef);
    if (isCoGroup) {
      const retainedByRef = new Map(childOrderDetails.map((child) => [orderRef(child).toLowerCase(), child]));
      const retainedDetails = retainedListed.map((childRef) => retainedByRef.get(childRef.toLowerCase())).filter(Boolean);
      if (!retainedListed.length) {
        if (ref) removedOrderRefs.add(ref.toLowerCase());
        return null;
      }
      next = retainedDetails.length === retainedListed.length
        ? aggregateGroup(next, retainedDetails)
        : {
            ...next,
            childOrders: retainedListed,
            childOrderDetails: retainedDetails,
            sourceOrderId: "",
            relatedSoId: "",
            relatedToId: "",
            relatedCustomOrderId: "",
            transitCo: null
          };
    } else if (childOrderDetails.some((child, index) => child !== originalChildren[index])
      || childOrderDetails.length !== originalChildren.length) {
      next = { ...next, childOrderDetails };
    }
    return next;
  };
  const orders = (plan.orders || []).map(reconcileOrder).filter(Boolean);
  const cleanReferenceList = (values = []) => values.map(text)
    .filter((ref) => ref && !removedOrderRefs.has(ref.toLowerCase()));
  const trucks = (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
    ...truck,
    loads: (Array.isArray(truck?.loads) ? truck.loads : []).map((load) => ({
      ...load,
      ...(Array.isArray(load.orders) ? {
        orders: load.orders.filter((candidate) => {
          const ref = typeof candidate === "string" ? text(candidate) : orderRef(candidate);
          return !ref || !removedOrderRefs.has(ref.toLowerCase());
        })
      } : {}),
      stops: (Array.isArray(load.stops) ? load.stops : []).flatMap((stop) => {
        const refs = stopOrderRefs(stop);
        if (!refs.some((ref) => removedOrderRefs.has(ref.toLowerCase()))) return [stop];
        const retained = cleanReferenceList(refs);
        if (!retained.length) return [];
        const next = { ...stop };
        for (const key of ["orderRefs", "order_refs", "groupedOrderRefs", "grouped_order_refs"]) {
          if (Array.isArray(next[key])) next[key] = cleanReferenceList(next[key]);
        }
        for (const key of ["orderId", "order_id", "orderRef", "order_ref", "tranid"]) {
          if (next[key] && removedOrderRefs.has(text(next[key]).toLowerCase())) next[key] = retained[0];
        }
        return [next];
      })
    }))
  }));
  return { ...plan, orders, trucks };
}
