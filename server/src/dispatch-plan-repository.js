import { query, withTransaction } from "./db.js";
import { assertActiveDispatchCosForPlan } from "./dispatch-co-lifecycle.js";
import { canonicalizeDispatchCustomOrdersInPlan } from "./dispatch-custom-order-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "./dispatch-delivery-group-repository.js";
import {
  dispatchLoadAssignment,
  dispatchLoadAssignmentDefaults,
  normalizeDispatchPlanLoadAssignments
} from "./dispatch-load-assignment.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";
import { assertBinDispatchCapability } from "./mbt/dispatch-bin-safety.js";
import {
  DISPATCH_FLEET_PLANNING_LOCK,
  dispatchFleetAssignmentStatusConflicts,
  unchangedCompletedDispatchLoadIds
} from "./dispatch-fleet-status.js";
import {
  refreshGroupedSalesOrderReconciliationInPlan,
  scrubBilledSalesOrderFamilyFromPlan
} from "./sales-order-reconciliation.js";
import { scrubClosedNetSuiteOrdersFromOperationalPlan } from "./netsuite-closed-order-repository.js";
import {
  buildCompactDispatchSnapshot,
  digestDispatchPlan,
  dispatchPlanBoard,
  evaluateExecutedPrefixPolicy
} from "./dispatch-planner-performance.js";

const CUSTOMER_PICKUP_DELIVERY_METHOD = "Pick-Up";
const DISPATCH_PLAN_V2_VERSION = 2;
const DISPATCH_PLAN_V2_BACKFILL_SOURCE = "dockerVer-backfill";
const DISPATCH_PLAN_V2_SAVE_SOURCE = "dispatchV2-save";

export class DisabledDispatchFleetAssignmentError extends Error {
  constructor(conflicts = []) {
    const first = conflicts[0] || {};
    super(first.message || "Driver or truck assignment uses a disabled resource.");
    this.name = "DisabledDispatchFleetAssignmentError";
    this.code = first.code || "DISPATCH_FLEET_DISABLED";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

async function lockDispatchFleetPlanning() {
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
}

async function syncDispatchPlannerReadProjections(plan = {}) {
  // Dynamic import avoids a module-initialization cycle: the v2 repository
  // already imports this repository for canonical assignment semantics.
  const projections = await import("./dispatch-planner-v2-repository.js");
  await projections.syncDispatchPlanOrderAssignments(plan);
  await projections.syncDispatchPlanRelationEdges(plan);
}

async function assertActiveDispatchFleetAssignments(plan = {}, { previousPlan = null } = {}) {
  const driverResult = await query("SELECT id::text, name, login, active FROM dispatch_drivers ORDER BY id");
  const truckResult = await query("SELECT id::text, plate, active FROM dispatch_trucks ORDER BY id");
  let allowedInactiveLoadIds = new Set();
  const planId = String(plan?.id || plan?.planId || previousPlan?.id || previousPlan?.planId || "").trim();
  if (previousPlan && planId) {
    const completedResult = await query(
      `SELECT load_id
         FROM dispatch_plan_load_assignments
        WHERE plan_id = $1
          AND completed = true`,
      [planId]
    );
    allowedInactiveLoadIds = unchangedCompletedDispatchLoadIds(
      previousPlan,
      plan,
      completedResult.rows.map((row) => row.load_id)
    );
  }
  const conflicts = dispatchFleetAssignmentStatusConflicts(plan, {
    drivers: driverResult.rows,
    trucks: truckResult.rows
  }, {
    allowedInactiveLoadIds
  });
  if (conflicts.length) throw new DisabledDispatchFleetAssignmentError(conflicts);
}

function uniqueTextValues(values = []) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function isDispatchV2Plan(plan = {}) {
  return Number(plan?.summary?.dispatchPlanFormat?.version || 0) >= DISPATCH_PLAN_V2_VERSION;
}

export function dispatchPlanV2Summary(summary = {}, {
  previousSummary = {},
  source = DISPATCH_PLAN_V2_SAVE_SOURCE,
  migratedAt = new Date().toISOString(),
  ownYardCodes = null
} = {}) {
  const previousFormat = previousSummary?.dispatchPlanFormat || {};
  const resolvedOwnYardCodes = uniqueTextValues(
    (Array.isArray(ownYardCodes) && ownYardCodes.length && ownYardCodes)
    || (Array.isArray(summary?.ownYardCodes) && summary.ownYardCodes.length && summary.ownYardCodes)
    || (Array.isArray(previousSummary?.ownYardCodes) && previousSummary.ownYardCodes.length && previousSummary.ownYardCodes)
    || (Array.isArray(previousFormat?.ownYardCodes) && previousFormat.ownYardCodes.length && previousFormat.ownYardCodes)
    || dispatchLoadAssignmentDefaults.ownYards
  );
  const existingV2Format = Number(summary?.dispatchPlanFormat?.version || 0) >= DISPATCH_PLAN_V2_VERSION
    ? summary.dispatchPlanFormat
    : Number(previousFormat?.version || 0) >= DISPATCH_PLAN_V2_VERSION
      ? previousFormat
      : null;
  return {
    ...(summary || {}),
    ownYardCodes: resolvedOwnYardCodes,
    dispatchPlanFormat: existingV2Format
      ? { ...existingV2Format, ownYardCodes: resolvedOwnYardCodes }
      : {
          version: DISPATCH_PLAN_V2_VERSION,
          source,
          migratedAt: migratedAt instanceof Date
            ? migratedAt.toISOString()
            : String(migratedAt || new Date().toISOString()),
          ownYardCodes: resolvedOwnYardCodes
        }
  };
}

export function convertLegacyDispatchPlanToV2(plan = {}, {
  migratedAt = new Date().toISOString(),
  ownYardCodes = dispatchLoadAssignmentDefaults.ownYards
} = {}) {
  const normalized = normalizeDispatchPlanLoadAssignments(plan);
  const loadRows = [];
  for (const [truckIndex, truck] of (normalized.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const assignment = dispatchLoadAssignment(truck, load, { driverSequence: loadIndex });
      loadRows.push({ truckIndex, loadIndex, assignment });
    }
  }

  const rowsByDriver = new Map();
  for (const row of loadRows) {
    const driverKey = row.assignment.driverLogin;
    if (!rowsByDriver.has(driverKey)) rowsByDriver.set(driverKey, []);
    rowsByDriver.get(driverKey).push(row);
  }
  const sequenceByLoad = new Map();
  for (const rows of rowsByDriver.values()) {
    rows.sort((left, right) => {
      const leftStart = left.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.assignment.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart
        || left.truckIndex - right.truckIndex
        || left.loadIndex - right.loadIndex;
    });
    rows.forEach((row, driverSequence) => {
      sequenceByLoad.set(`${row.truckIndex}:${row.loadIndex}`, driverSequence);
    });
  }

  return {
    ...normalized,
    trucks: (normalized.trucks || []).map((truck, truckIndex) => ({
      ...truck,
      loads: (truck.loads || []).map((load, loadIndex) => ({
        ...load,
        ...dispatchLoadAssignment(truck, load, { driverSequence: loadIndex }),
        driverSequence: sequenceByLoad.get(`${truckIndex}:${loadIndex}`) ?? loadIndex
      }))
    })),
    summary: {
      ...dispatchPlanV2Summary(normalized.summary || {}, {
        source: DISPATCH_PLAN_V2_BACKFILL_SOURCE,
        migratedAt,
        ownYardCodes
      })
    }
  };
}

function normalizedSnapshotTrucks(row = {}) {
  return normalizeDispatchPlanLoadAssignments({
    trucks: Array.isArray(row.trucks) ? row.trucks : []
  }).trucks;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function cleanPlanDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayDate();
}

function planRow(row) {
  if (!row) return null;
  const plan = {
    id: row.id,
    revision: Number(row.revision || 0),
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date || "").slice(0, 10),
    status: row.status,
    note: row.note || "",
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    savedAt: row.saved_at || row.updated_at,
    orders: row.orders || [],
    trucks: row.trucks || [],
    summary: row.summary || {}
  };
  return { ...plan, digest: digestDispatchPlan(plan) };
}

function countPlanLoads(trucks = []) {
  return (trucks || []).reduce((sum, truck) => sum + (truck.loads || []).length, 0);
}

function countPlanStops(trucks = []) {
  return (trucks || []).reduce((sum, truck) => sum + (truck.loads || []).reduce((loadSum, load) => loadSum + (load.stops || []).length, 0), 0);
}

function countLoadOrders(load = {}) {
  return loadOrderRefs(load).length;
}

function loadOrderRefs(load = {}) {
  if (Array.isArray(load.orders) && load.orders.length) {
    return [
      ...new Set(
        load.orders
          .map((order) => order.tranid || order.orderNumber || order.orderId || order.id || "")
          .filter(Boolean)
      )
    ];
  }
  const orderIds = new Set(
    (load.stops || [])
      .map((stop) => stop.orderId || stop.order_id || stop.tranid || stop.orderNumber || "")
      .filter(Boolean)
  );
  return [...orderIds];
}

export function dispatchPlannedAssignmentMap(plan = {}) {
  const orderById = new Map((plan.orders || []).map((order) => [String(order?.id || ""), order]));
  const assignments = new Map();
  const addRef = (value, details) => {
    const ref = String(value || "").trim();
    if (ref && !assignments.has(ref)) assignments.set(ref, details);
  };
  const addOrderRefs = (orderId, details) => {
    const order = orderById.get(String(orderId || ""));
    const plannedDetails = {
      ...details,
      plannedOrderRef: String(orderId || "").trim()
    };
    if (order?.childOrders?.length || order?.originalOrderId) {
      plannedDetails.plannedOrderSnapshot = order;
    }
    const visited = new Set();
    const addExactOrderRefs = (value, snapshot = null) => {
      const ref = String(value || "").trim();
      if (!ref || visited.has(ref)) return;
      visited.add(ref);
      addRef(ref, plannedDetails);
      const resolved = snapshot || orderById.get(ref);
      if (!resolved || resolved.type === "CO") return;
      const childDetails = new Map(
        (resolved.childOrderDetails || [])
          .map((child) => [String(child?.id || "").trim(), child])
          .filter(([childId]) => childId)
      );
      const childIds = new Set([
        ...(resolved.childOrders || []).map((childId) => String(childId || "").trim()),
        ...childDetails.keys()
      ]);
      for (const childId of childIds) {
        if (!childId) continue;
        addExactOrderRefs(childId, orderById.get(childId) || childDetails.get(childId) || null);
      }
    };
    addExactOrderRefs(orderId, order);
  };
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || !stop.orderId) continue;
        addOrderRefs(stop.orderId, {
          dispatchPlanned: true,
          dispatchPlanId: plan.id ? String(plan.id) : "",
          dispatchPlanDate: String(plan.planDate || "").slice(0, 10),
          dispatchTruckPlate: dispatchLoadAssignment(truck, load).truckPlate,
          dispatchLoadName: load.name || "",
          dispatchParkingSpot: dispatchLoadAssignment(truck, load).parkingSpot,
          dispatchDriverLogin: dispatchLoadAssignment(truck, load).driverLogin,
          dispatchDriverName: dispatchLoadAssignment(truck, load).driverName
        });
      }
    }
  }
  return assignments;
}

export function dispatchPlannedOrderRefs(plan = {}) {
  return new Set(dispatchPlannedAssignmentMap(plan).keys());
}

function dispatchPlanOrderSnapshotMap(plan = {}) {
  const snapshots = new Map();
  const visit = (order) => {
    const ref = String(order?.id || "").trim();
    if (!ref) return;
    if (!snapshots.has(ref)) snapshots.set(ref, order);
    for (const child of order.childOrderDetails || []) visit(child);
  };
  for (const order of plan.orders || []) visit(order);
  return snapshots;
}

function splitParentRef(order = {}) {
  if (String(order?.type || "").trim().toUpperCase() === "CUSTOM") return "";
  const explicit = String(order?.originalOrderId || "").trim();
  if (explicit) return explicit;
  const ref = String(order?.id || "").trim();
  return /-S\d+$/i.test(ref) ? ref.replace(/-S\d+$/i, "") : "";
}

export function dispatchPlannedOrderConflictRefs(currentPlan = {}, otherPlan = {}) {
  const currentRefs = dispatchPlannedOrderRefs(currentPlan);
  const otherRefs = dispatchPlannedOrderRefs(otherPlan);
  const currentSnapshots = dispatchPlanOrderSnapshotMap(currentPlan);
  const otherSnapshots = dispatchPlanOrderSnapshotMap(otherPlan);
  const conflicts = new Set([...currentRefs].filter((ref) => otherRefs.has(ref)));

  for (const ref of currentRefs) {
    const parentRef = splitParentRef(currentSnapshots.get(ref));
    if (parentRef && otherRefs.has(parentRef)) conflicts.add(ref);
  }
  for (const ref of otherRefs) {
    const parentRef = splitParentRef(otherSnapshots.get(ref));
    if (parentRef && currentRefs.has(parentRef)) conflicts.add(parentRef);
  }
  return conflicts;
}

export function applyDispatchPlannedAssignment(order = {}, assignment = null) {
  return {
    ...order,
    dispatchPlanned: Boolean(assignment),
    dispatchPlanId: assignment?.dispatchPlanId || "",
    dispatchPlanDate: assignment?.dispatchPlanDate || "",
    dispatchTruckPlate: assignment?.dispatchTruckPlate || "",
    dispatchLoadName: assignment?.dispatchLoadName || "",
    dispatchParkingSpot: assignment?.dispatchParkingSpot || "",
    dispatchDriverLogin: assignment?.dispatchDriverLogin || "",
    dispatchDriverName: assignment?.dispatchDriverName || "",
    plannedOrderRef: assignment?.plannedOrderRef || ""
  };
}

function countPlanLoadOrders(trucks = []) {
  return (trucks || []).reduce((sum, truck) => sum + (truck.loads || []).reduce((loadSum, load) => loadSum + countLoadOrders(load), 0), 0);
}

function truckSnapshotSummary(trucks = []) {
  return (trucks || []).map((truck) => ({
    id: truck.id || "",
    plate: truck.plate || truck.truckPlate || "",
    driver: truck.driver || truck.driverName || "",
    loadCount: (truck.loads || []).length,
    orderCount: (truck.loads || []).reduce((sum, load) => sum + countLoadOrders(load), 0),
    stopCount: (truck.loads || []).reduce((sum, load) => sum + (load.stops || []).length, 0),
    loads: (truck.loads || []).map((load) => ({
      ...dispatchLoadAssignment(truck, load),
      id: load.id || "",
      name: load.name || "",
      type: load.type || "",
      orderCount: countLoadOrders(load),
      orderRefs: loadOrderRefs(load),
      stopCount: (load.stops || []).length,
      startTime: load.startTime || load.timing?.start || "",
      finishTime: load.finishTime || load.timing?.finish || ""
    }))
  }));
}

function snapshotSummary(row, { current = false } = {}) {
  const orders = Array.isArray(row.orders) ? row.orders : [];
  const trucks = normalizedSnapshotTrucks(row);
  const hasStoredMetadata = row.schema_version !== undefined && row.schema_version !== null;
  return {
    id: current ? `current-${row.plan_id || row.id}` : String(row.id),
    snapshotId: current ? null : String(row.id),
    planId: String(row.plan_id || row.id || ""),
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date || "").slice(0, 10),
    current,
    label: current ? "Current Active Version" : `Archived ${row.archived_at || ""}`,
    revision: Number(row.revision || 0),
    status: row.status || "",
    savedAt: row.saved_at || row.original_saved_at || "",
    originalSavedAt: row.original_saved_at || row.saved_at || "",
    archivedAt: row.archived_at || "",
    archiveReason: row.archive_reason || (current ? "current" : ""),
    sessionId: row.session_id || "",
    schemaVersion: Number(row.schema_version || 1),
    digest: row.plan_digest || "",
    orderCount: hasStoredMetadata ? Number(row.order_count || 0) : orders.length,
    truckCount: hasStoredMetadata ? Number(row.truck_count || 0) : trucks.length,
    loadCount: hasStoredMetadata ? Number(row.load_count || 0) : countPlanLoads(trucks),
    loadOrderCount: hasStoredMetadata ? Number(row.order_count || 0) : countPlanLoadOrders(trucks),
    stopCount: hasStoredMetadata ? Number(row.stop_count || 0) : countPlanStops(trucks),
    summary: row.summary || {},
    trucks: truckSnapshotSummary(trucks)
  };
}

export class StaleDispatchPlanSaveError extends Error {
  constructor({ planId, expectedRevision, currentRevision }) {
    super("Dispatch plan changed on the server before this save completed.");
    this.name = "StaleDispatchPlanSaveError";
    this.code = "STALE_DISPATCH_PLAN";
    this.planId = planId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
    this.status = 409;
  }
}

export class DispatchPlanDateMismatchError extends Error {
  constructor({ planId, expectedPlanDate, payloadPlanDate }) {
    super(`Dispatch plan date mismatch. Plan ${planId} is ${expectedPlanDate}, but payload was ${payloadPlanDate}.`);
    this.name = "DispatchPlanDateMismatchError";
    this.code = "DISPATCH_PLAN_DATE_MISMATCH";
    this.planId = planId;
    this.expectedPlanDate = expectedPlanDate;
    this.payloadPlanDate = payloadPlanDate;
    this.status = 409;
  }
}

export class DispatchCustomOrderDateConflictError extends Error {
  constructor(conflicts = []) {
    const first = conflicts[0] || {};
    super(first.orderRef
      ? `${first.orderRef} is already planned on ${first.planDate}.`
      : "A Custom Order is already planned on another date.");
    this.name = "DispatchCustomOrderDateConflictError";
    this.code = "DISPATCH_ORDER_ALREADY_PLANNED";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

function plannedCustomOrderRefs(plan = {}) {
  const plannedRefs = dispatchPlannedOrderRefs(plan);
  return new Set((plan.orders || [])
    .filter((order) => String(order?.type || "").trim().toUpperCase() === "CUSTOM")
    .map((order) => String(order?.id || "").trim())
    .filter((ref) => ref && plannedRefs.has(ref)));
}

async function assertCustomOrderPlanDateExclusivity(plan = {}, { previousPlan = null } = {}) {
  const previousRefs = previousPlan ? plannedCustomOrderRefs(previousPlan) : new Set();
  const customRefs = [...plannedCustomOrderRefs(plan)].filter((ref) => !previousRefs.has(ref));
  if (!customRefs.length) return;
  const result = await query(
    `SELECT DISTINCT p.id, p.plan_date::text AS plan_date, p.status,
            candidate.ref AS order_ref
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.trucks, '[]'::jsonb)) truck(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
       CROSS JOIN LATERAL unnest($3::text[]) candidate(ref)
      WHERE p.id <> $1
        AND p.status <> 'cancelled'
        AND p.plan_date <> $2::date
        AND lower(COALESCE(load.value ->> 'returnOnly', 'false')) <> 'true'
        AND stop.value ->> 'type' = 'drop'
        AND lower(stop.value ->> 'orderId') = lower(candidate.ref)`,
    [plan.id || plan.planId || 0, cleanPlanDate(plan.planDate), customRefs]
  );
  const conflicts = result.rows.map((row) => ({
    orderRef: String(row.order_ref || ""),
    planId: String(row.id),
    planDate: String(row.plan_date || "").slice(0, 10),
    status: row.status || ""
  }));
  if (conflicts.length) throw new DispatchCustomOrderDateConflictError(conflicts);
}

async function assertSpecialStockHandoffPlanning(plan = {}, { previousPlan = null } = {}) {
  const previousRefs = previousPlan ? dispatchPlannedOrderRefs(previousPlan) : new Set();
  const refs = [...dispatchPlannedOrderRefs(plan)].filter((ref) => !previousRefs.has(ref));
  if (!refs.length) return;
  const result = await query(
    `SELECT special.request_id, special.sales_order_ref, special.purchase_order_ref,
            special.post_po_change_pending, special.attention,
            handoff.route, handoff.status,
            purchase.status AS purchase_status,
            purchase.status_text AS purchase_status_text,
            purchase.receipt_status,
            purchase.received_at
       FROM sales_special_stock_cases special
       LEFT JOIN sales_special_stock_handoffs handoff ON handoff.request_id = special.request_id
       LEFT JOIN purchase_orders purchase ON purchase.netsuite_id = special.purchase_order_netsuite_id
      WHERE lower(btrim(special.sales_order_ref)) = ANY($1::text[])`,
    [refs.map((ref) => ref.trim().toLowerCase())]
  );
  for (const row of result.rows) {
    if (row.attention === true || row.post_po_change_pending === true) {
      throw Object.assign(new Error(`${row.sales_order_ref} has an unresolved Special Item Attention state.`), {
        status: 409,
        code: "SPECIAL_PLAN_ATTENTION"
      });
    }
    if (!row.route || !["ready", "planned", "in_progress", "completed"].includes(row.status)) {
      throw Object.assign(new Error(`${row.sales_order_ref} needs a Special Item Direct or Via Yard route before planning.`), {
        status: 409,
        code: "SPECIAL_PLAN_ROUTE_REQUIRED"
      });
    }
    if (row.route === "via_yard") {
      const purchaseState = `${row.purchase_status || ""} ${row.purchase_status_text || ""} ${row.receipt_status || ""}`;
      const received = Boolean(row.received_at) || /\b(?:received|fully received|closed|fully billed)\b/i.test(purchaseState);
      if (!received) {
        throw Object.assign(new Error(`${row.sales_order_ref} must wait until ${row.purchase_order_ref} is received at the selected yard.`), {
          status: 409,
          code: "SPECIAL_PLAN_PO_RECEIPT_REQUIRED"
        });
      }
    }
  }
}

function collectPlanOrderRefs(plan) {
  const refs = new Set();
  const add = (value) => {
    const ref = String(value || "").trim();
    if (ref) refs.add(ref);
  };
  const visitOrder = (order = {}) => {
    add(order.id);
    add(order.tranid);
    add(order.orderId);
    add(order.orderRef);
    add(order.originalOrderId);
    for (const ref of order.childOrders || []) add(ref);
    for (const child of order.childOrderDetails || []) visitOrder(child);
  };
  for (const order of plan?.orders || []) visitOrder(order);
  for (const truck of plan?.trucks || []) {
    for (const load of truck?.loads || []) {
      for (const ref of loadOrderRefs(load)) add(ref);
      for (const stop of load?.stops || []) {
        add(stop?.orderId);
        for (const ref of stop?.orderRefs || []) add(ref);
      }
    }
  }
  return [...refs];
}

function exactBilledSalesOrderSql(alias) {
  return `(
    UPPER(BTRIM(COALESCE(${alias}.status, ''))) = 'G'
    OR UPPER(REGEXP_REPLACE(
         REGEXP_REPLACE(BTRIM(COALESCE(${alias}.status_text, '')), '\\s*:\\s*', ':', 'g'),
         '\\s+', ' ', 'g'
       ))
       IN ('BILLED', 'SALES ORDER:BILLED')
  )`;
}

async function billedSalesOrderFamiliesInPlan(plan = {}) {
  const refs = collectPlanOrderRefs(plan).map((ref) => ref.toUpperCase());
  if (!refs.length) return [];
  const result = await query(
    `WITH matched_canonical AS (
       SELECT DISTINCT COALESCE(own_split.source_so_id, candidate.netsuite_id) AS source_so_id
         FROM sales_orders candidate
         LEFT JOIN dispatch_scm_so_splits own_split
           ON own_split.split_so_id = candidate.netsuite_id
        WHERE upper(candidate.tranid) = ANY($1::text[])
          AND (candidate.netsuite_id > 0 OR own_split.source_so_id IS NOT NULL)
     ),
     billed_canonical AS (
       SELECT source_order.netsuite_id AS source_so_id,
              source_order.tranid AS source_so_ref
         FROM matched_canonical matched
         JOIN sales_orders source_order
           ON source_order.netsuite_id = matched.source_so_id
        WHERE ${exactBilledSalesOrderSql("source_order")}
           OR EXISTS (
             SELECT 1
               FROM dispatch_scm_so_splits billed_split
               JOIN sales_orders split_order
                 ON split_order.netsuite_id = billed_split.split_so_id
              WHERE billed_split.source_so_id = source_order.netsuite_id
                AND ${exactBilledSalesOrderSql("split_order")}
           )
     )
     SELECT billed.source_so_id,
            billed.source_so_ref,
            child.split_so_ref
       FROM billed_canonical billed
       LEFT JOIN dispatch_scm_so_splits child
         ON child.source_so_id = billed.source_so_id
      ORDER BY billed.source_so_id, child.created_at, child.id`,
    [refs]
  );
  const families = new Map();
  for (const row of result.rows) {
    const key = String(row.source_so_id);
    if (!families.has(key)) {
      families.set(key, {
        canonicalRef: String(row.source_so_ref || "").toUpperCase(),
        familyRefs: []
      });
    }
    const family = families.get(key);
    family.familyRefs = uniqueTextValues([
      ...family.familyRefs,
      row.source_so_ref,
      row.split_so_ref
    ]).map((ref) => ref.toUpperCase());
  }
  return [...families.values()];
}

async function activeDriverJobsForSalesOrderFamily(refs = []) {
  const familyRefs = uniqueTextValues(refs).map((ref) => ref.toUpperCase());
  if (!familyRefs.length) return [];
  const result = await query(
    `SELECT job.job_id, job.plan_id, job.load_id, job.stop_id, job.order_refs
       FROM driver_job_records job
      WHERE job.status = 'in_progress'
        AND (
          EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(COALESCE(job.order_refs, '[]'::jsonb)) ref(value)
             WHERE upper(BTRIM(ref.value)) = ANY($1::text[])
          )
          OR EXISTS (
            SELECT 1
              FROM dispatch_plan_snapshots snapshot,
                   LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck,
                   LATERAL jsonb_array_elements(COALESCE(truck->'loads', '[]'::jsonb)) load
             WHERE snapshot.plan_id::text = job.plan_id::text
               AND NULLIF(BTRIM(job.load_id), '') IS NOT NULL
               AND upper(BTRIM(COALESCE(load->>'id', ''))) = upper(BTRIM(job.load_id))
               AND EXISTS (
                 SELECT 1
                   FROM unnest($2::text[]) token(value)
                  WHERE strpos(upper(load::text), token.value) > 0
               )
          )
        )
      ORDER BY job.started_at, job.id`,
    [familyRefs, familyRefs.map((ref) => JSON.stringify(ref).toUpperCase())]
  );
  return result.rows;
}

async function scrubBilledSalesOrderFamiliesFromPlan(plan = {}) {
  let cleanPlan = plan;
  for (const family of await billedSalesOrderFamiliesInPlan(plan)) {
    const activeJobs = await activeDriverJobsForSalesOrderFamily(family.familyRefs);
    const scrubbed = scrubBilledSalesOrderFamilyFromPlan(cleanPlan, {
      canonicalRef: family.canonicalRef,
      familyRefs: family.familyRefs,
      inProgressOrderRefs: activeJobs.length ? family.familyRefs : []
    });
    cleanPlan = scrubbed.plan;
  }
  return cleanPlan;
}

async function pickupSalesOrderRefs(plan) {
  const refs = collectPlanOrderRefs(plan);
  if (!refs.length) return new Set();
  const result = await query(
    `SELECT tranid
       FROM sales_orders
      WHERE sales_order_type = $1
        AND tranid = ANY($2::text[])`,
    [CUSTOMER_PICKUP_DELIVERY_METHOD, refs]
  );
  return new Set(result.rows.map((row) => String(row.tranid || "")));
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function collectPlanItemIds(plan) {
  const ids = new Set();
  const visitOrder = (order) => {
    for (const item of order?.items || []) {
      const itemId = Number(item?.itemId ?? item?.item_id);
      if (Number.isInteger(itemId) && itemId > 0) ids.add(itemId);
    }
    for (const child of order?.childOrderDetails || []) visitOrder(child);
  };
  for (const order of plan?.orders || []) visitOrder(order);
  return [...ids];
}

async function inventoryWeightLookup(itemIds) {
  if (!itemIds.length) return new Map();
  const result = await query(
    `SELECT item_id, item_weight, to_plt, to_lyr, to_sec, to_pcs
       FROM inventory_items
      WHERE item_id = ANY($1::bigint[])`,
    [itemIds]
  );
  return new Map(result.rows.map((row) => [Number(row.item_id), row]));
}

function enrichOrderWeights(order, inventoryByItemId) {
  if (!order) return order;
  const items = (order.items || []).map((item) => {
    const itemId = Number(item.itemId ?? item.item_id);
    const inventory = inventoryByItemId.get(itemId);
    const itemWeight = numberValue(item.itemWeight ?? item.item_weight) || numberValue(inventory?.item_weight);
    const quantity = numberValue(item.quantity ?? item.salesQty);
    const lineWeight = itemWeight && quantity ? quantity * itemWeight : numberValue(item.lineWeight);
    return {
      ...item,
      itemWeight,
      lineWeight,
      toPlt: item.toPlt ?? item.to_plt ?? inventory?.to_plt ?? null,
      toLyr: item.toLyr ?? item.to_lyr ?? inventory?.to_lyr ?? null,
      toSec: item.toSec ?? item.to_sec ?? inventory?.to_sec ?? null,
      toPcs: item.toPcs ?? item.to_pcs ?? inventory?.to_pcs ?? null
    };
  });
  const calculatedWeight = items.reduce((sum, item) => sum + numberValue(item.lineWeight), 0);
  const childOrderDetails = (order.childOrderDetails || []).map((child) => enrichOrderWeights(child, inventoryByItemId));
  const raw = order.raw ? {
    ...order.raw,
    items: Array.isArray(order.raw.items) ? items : order.raw.items,
    total_weight_lbs: calculatedWeight > 0 ? String(calculatedWeight) : order.raw.total_weight_lbs
  } : order.raw;
  return {
    ...order,
    items,
    raw,
    childOrderDetails,
    weight: calculatedWeight > 0 ? calculatedWeight : numberValue(order.weight)
  };
}

async function enrichDispatchPlanWeights(plan) {
  if (!plan) return null;
  const inventoryByItemId = await inventoryWeightLookup(collectPlanItemIds(plan));
  if (!inventoryByItemId.size) return plan;
  return {
    ...plan,
    orders: (plan.orders || []).map((order) => enrichOrderWeights(order, inventoryByItemId))
  };
}

async function sanitizeDispatchPlan(plan) {
  if (!plan) return null;
  const normalizedPlan = normalizeDispatchPlanLoadAssignments(plan);
  const closedSanitizedPlan = (await scrubClosedNetSuiteOrdersFromOperationalPlan(normalizedPlan)).plan;
  const pickupRefs = await pickupSalesOrderRefs(closedSanitizedPlan);
  const enrichedPlan = await enrichDispatchPlanWeights(closedSanitizedPlan);
  const pickupSanitizedPlan = !pickupRefs.size ? enrichedPlan : {
    ...enrichedPlan,
    orders: (enrichedPlan.orders || []).filter((order) => !pickupRefs.has(String(order?.id || ""))),
    trucks: (enrichedPlan.trucks || []).map((truck) => ({
      ...truck,
      loads: (truck.loads || []).map((load) => ({
        ...load,
        stops: (load.stops || []).filter((stop) => !pickupRefs.has(String(stop?.orderId || "")))
      }))
    })),
    summary: {
      ...(enrichedPlan.summary || {}),
      removedPickupOrderRefs: [
        ...new Set([...(enrichedPlan.summary?.removedPickupOrderRefs || []), ...pickupRefs])
      ]
    }
  };
  const billedSanitizedPlan = await scrubBilledSalesOrderFamiliesFromPlan(pickupSanitizedPlan);
  const groupedRefs = groupedSalesOrderChildRefs(billedSanitizedPlan);
  if (!groupedRefs.length) return billedSanitizedPlan;
  return refreshGroupedSalesOrderReconciliationInPlan(billedSanitizedPlan, {
    childSnapshots: await groupedSalesOrderChildSnapshots(billedSanitizedPlan),
    targetRefs: groupedRefs
  }).plan;
}

async function sanitizedSnapshotDetail(row, { current = false } = {}) {
  const rawTrucks = normalizedSnapshotTrucks(row);
  const sanitized = await sanitizeDispatchPlan({
    id: String(row.plan_id || row.id || ""),
    planDate: row.plan_date,
    status: row.status || "",
    revision: Number(row.revision || 0),
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: rawTrucks,
    summary: row.summary || {}
  });
  const orders = sanitized?.orders || [];
  const trucks = sanitized?.trucks || [];
  return {
    ...snapshotSummary(row, { current }),
    orderCount: orders.length,
    truckCount: trucks.length,
    loadCount: countPlanLoads(trucks),
    loadOrderCount: countPlanLoadOrders(trucks),
    stopCount: countPlanStops(trucks),
    summary: sanitized?.summary || row.summary || {},
    trucks: truckSnapshotSummary(trucks),
    orders,
    rawTrucks: trucks
  };
}

export async function listDispatchPlans({ limit = 80 } = {}) {
  const cleanLimit = Math.min(Math.max(Number(limit) || 80, 1), 300);
  const result = await query(
    `SELECT p.*, s.saved_at, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      ORDER BY p.plan_date DESC, p.updated_at DESC
      LIMIT $1`,
    [cleanLimit]
  );
  return result.rows.map(planRow);
}

export async function createDispatchPlan({ planDate, note = "", status = "draft" } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const result = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (plan_date) DO UPDATE
       SET updated_at = dispatch_plans.updated_at
     RETURNING *`,
    [cleanDate, status, note || ""]
  );
  const plan = result.rows[0];
  const initialSummary = dispatchPlanV2Summary({}, {
    migratedAt: plan.created_at,
    source: DISPATCH_PLAN_V2_SAVE_SOURCE
  });
  const initialDigest = digestDispatchPlan({
    id: String(plan.id),
    planDate: cleanDate,
    status: plan.status || status,
    note: plan.note || note || "",
    revision: Number(plan.revision || 0),
    orders: [],
    trucks: [],
    summary: initialSummary
  });
  await query(
    `INSERT INTO dispatch_plan_snapshots (
       plan_id, orders, trucks, summary, schema_version, plan_digest,
       order_count, truck_count, load_count, stop_count
     )
     VALUES ($1, '[]'::jsonb, '[]'::jsonb, $2::jsonb, 2, $3, 0, 0, 0, 0)
     ON CONFLICT (plan_id) DO NOTHING`,
    [plan.id, JSON.stringify(initialSummary), initialDigest]
  );
  return getDispatchPlan(plan.id);
}

export async function getDispatchPlan(planId) {
  const result = await query(
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary, s.plan_digest
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  return sanitizeDispatchPlan(planRow(result.rows[0]));
}

export async function getDispatchPlanRevision(planId) {
  const result = await query(
    `SELECT p.id, p.revision, p.updated_at, s.saved_at
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    revision: Number(row.revision || 0),
    savedAt: row.saved_at || row.updated_at,
    updatedAt: row.updated_at,
    updatedBySessionId: ""
  };
}

export async function getCurrentDispatchPlan({ planDate } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const result = await query(
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary, s.plan_digest
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date = $1
      LIMIT 1`,
    [cleanDate]
  );
  return sanitizeDispatchPlan(planRow(result.rows[0]));
}

function groupedSalesOrderChildRefs(plan = {}) {
  const refs = new Set();
  const visit = (order = {}) => {
    if (String(order?.type || "").trim().toUpperCase() !== "SO") return;
    const detailById = new Map((order.childOrderDetails || [])
      .map((child) => [String(child?.id || "").trim(), child])
      .filter(([ref]) => ref));
    for (const childRef of order.childOrders || []) {
      const ref = String(childRef || "").trim();
      const detail = detailById.get(ref);
      if (detail?.childOrders?.length) visit(detail);
      else if (ref) refs.add(ref.toUpperCase());
    }
  };
  for (const order of plan.orders || []) visit(order);
  return [...refs];
}

async function groupedSalesOrderChildSnapshots(plan = {}, {
  targetRefs = [],
  reconciliationStatus = "",
  reconciliationReason = "",
  reconciliationApplicationStatus = ""
} = {}) {
  const refs = groupedSalesOrderChildRefs(plan);
  if (!refs.length) return new Map();
  const result = await query(
    `SELECT netsuite_id, tranid, status, status_text, fulfillment_status,
            netsuite_active, operator_status, local_yard_order_status,
            preparing_operator_id,
            reconciliation_state.application_status AS reconciliation_application_status,
            reconciliation_state.reconciliation_status AS calculation_reconciliation_status,
            reconciliation_state.reconciliation_reason AS calculation_reconciliation_reason,
            EXISTS (
              SELECT 1
                FROM sales_order_lines line
               WHERE line.sales_order_id = sales_order.netsuite_id
                 AND (
                   COALESCE(line.confirmed, false) = true
                   OR COALESCE(line.packed_pallet_qty, 0) > 0
                   OR COALESCE(line.packed_layer_qty, 0) > 0
                   OR COALESCE(line.packed_section_qty, 0) > 0
                   OR COALESCE(line.packed_piece_qty, 0) > 0
                   OR COALESCE(line.packed_sales_qty, 0) > 0
                 )
            ) AS has_unsubmitted_line_progress
       FROM sales_orders sales_order
       LEFT JOIN scm_reconciliation_order_state reconciliation_state
         ON reconciliation_state.order_kind = 'SO'
        AND reconciliation_state.source_order_netsuite_id = sales_order.netsuite_id
      WHERE upper(tranid) = ANY($1::text[])`,
    [refs]
  );
  const snapshots = new Map(result.rows.map((row) => {
    const ref = String(row.tranid || "").trim().toUpperCase();
    const fulfillmentStatus = String(row.fulfillment_status || "not_fulfilled").trim().toLowerCase();
    const localStatus = String(row.local_yard_order_status || "Open").trim().toLowerCase();
    const operatorStatus = String(row.operator_status || "").trim().toLowerCase();
    const calculationReconciliationStatus = String(
      row.calculation_reconciliation_status || ""
    ).trim().toLowerCase();
    const calculationReview = ["review", "missing", "error"].includes(
      calculationReconciliationStatus
    );
    const activeDraft = !["loaded", "shipped", "fulfilled"].includes(localStatus)
      && fulfillmentStatus !== "fulfilled"
      && (
        row.preparing_operator_id != null
        || ["preparing", "packed"].includes(operatorStatus)
        || row.has_unsubmitted_line_progress === true
      );
    return [ref, {
      id: row.tranid || "",
      netsuiteId: Number(row.netsuite_id),
      status: row.status || "",
      statusText: row.status_text || "",
      netsuiteStatus: row.status || "",
      netsuiteStatusText: row.status_text || "",
      fulfillmentStatus: row.fulfillment_status || "not_fulfilled",
      netsuiteActive: row.netsuite_active !== false,
      operatorStatus: row.operator_status || "",
      localYardOrderStatus: row.local_yard_order_status || "Open",
      reconciliationApplicationStatus: activeDraft || calculationReview
        ? "Reconcile Review"
        : row.reconciliation_application_status || "",
      reconciliationStatus: activeDraft || calculationReview
        ? "review"
        : calculationReconciliationStatus || "current",
      reconciliationBlocked: activeDraft || calculationReview,
      reconciliationReason: activeDraft
        ? `Sales Order family reconciliation is blocked by an active operator packing draft on ${row.tranid || ref}.`
        : calculationReview
          ? row.calculation_reconciliation_reason || ""
          : "",
      raw: {
        status: row.status || "",
        status_text: row.status_text || "",
        fulfillment_status: row.fulfillment_status || "not_fulfilled",
        netsuite_active: row.netsuite_active !== false
      }
    }];
  }));
  const groupRefs = new Set(refs);
  const normalizedReconciliationStatus = String(reconciliationStatus || "").trim().toLowerCase();
  const normalizedApplicationStatus = String(reconciliationApplicationStatus || "").trim();
  for (const targetRef of targetRefs) {
    const ref = String(targetRef || "").trim().toUpperCase();
    if (!ref || !groupRefs.has(ref)) continue;
    const snapshot = snapshots.get(ref) || { id: targetRef, type: "SO", raw: {} };
    const review = ["review", "missing", "error"].includes(normalizedReconciliationStatus);
    snapshots.set(ref, {
      ...snapshot,
      reconciliationApplicationStatus: review
        ? "Reconcile Review"
        : normalizedApplicationStatus || snapshot.reconciliationApplicationStatus || "",
      reconciliationStatus: normalizedReconciliationStatus || "current",
      reconciliationBlocked: review,
      reconciliationReason: review ? String(reconciliationReason || "").trim() : ""
    });
  }
  return snapshots;
}

export async function reconcileSalesOrderFamilyInDispatchPlans({
  canonicalRef = "",
  familyRefs = [],
  billed = false,
  closed = false,
  reconciliationStatus = "current",
  reconciliationReason = "",
  reconciliationApplicationStatus = "",
  actor = "scm-reconciliation"
} = {}) {
  const refs = uniqueTextValues([canonicalRef, ...(familyRefs || [])]).map((ref) => ref.toUpperCase());
  if (!refs.length) return { changedPlans: [], deferred: false, familyRefs: [] };
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const activeJobs = billed && !closed ? await activeDriverJobsForSalesOrderFamily(refs) : [];
    if (billed && activeJobs.length) {
      return {
        changedPlans: [],
        deferred: true,
        familyRefs: refs,
        activeJobs: activeJobs.map((row) => ({
          jobId: row.job_id,
          planId: row.plan_id,
          loadId: row.load_id,
          stopId: row.stop_id,
          orderRefs: row.order_refs || []
        }))
      };
    }

    const snapshots = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.status <> 'cancelled'
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(s.orders, '[]'::jsonb)) plan_order(value)
             WHERE upper(BTRIM(COALESCE(plan_order.value->>'id', ''))) = ANY($1::text[])
                OR upper(BTRIM(COALESCE(plan_order.value->>'originalOrderId', ''))) = ANY($1::text[])
                OR EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(
                      CASE
                        WHEN jsonb_typeof(plan_order.value->'childOrders') = 'array'
                        THEN plan_order.value->'childOrders'
                        ELSE '[]'::jsonb
                      END
                    ) child_ref(value)
                   WHERE upper(BTRIM(child_ref.value)) = ANY($1::text[])
                )
          )
        ORDER BY p.plan_date, p.id
        FOR UPDATE OF p, s`,
      [refs]
    );
    const changedPlans = [];
    for (const row of snapshots.rows) {
      const originalPlan = {
        id: String(row.id),
        planDate: row.plan_date,
        orders: row.orders || [],
        trucks: row.trucks || [],
        summary: row.summary || {}
      };
      const refreshed = refreshGroupedSalesOrderReconciliationInPlan(originalPlan, {
        childSnapshots: await groupedSalesOrderChildSnapshots(originalPlan, {
          targetRefs: refs,
          reconciliationStatus,
          reconciliationReason,
          reconciliationApplicationStatus
        }),
        targetRefs: refs
      });
      const scrubbed = billed || closed
        ? scrubBilledSalesOrderFamilyFromPlan(refreshed.plan, {
            canonicalRef,
            familyRefs: refs
          })
        : {
            plan: refreshed.plan,
            changed: false,
            removedOrderRefs: []
          };
      if (!refreshed.changed && !scrubbed.changed) continue;
      await query(
        `INSERT INTO dispatch_plan_snapshot_history (
           plan_id, plan_date, revision, orders, trucks, summary,
           original_saved_at, archive_reason, session_id
         ) VALUES (
           $1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb,
           $7, $8, $9
         )`,
        [
          row.id,
          row.plan_date,
          row.revision,
          JSON.stringify(row.orders || []),
          JSON.stringify(row.trucks || []),
          JSON.stringify(row.summary || {}),
          row.saved_at,
          closed
            ? "before_closed_so_reconciliation"
            : billed ? "before_billed_so_reconciliation" : "before_grouped_so_reconciliation",
          String(actor || "scm-reconciliation")
        ]
      );
      const updated = await query(
        `UPDATE dispatch_plans
            SET revision = revision + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING revision`,
        [row.id]
      );
      await query(
        `UPDATE dispatch_plan_snapshots
            SET orders = $2::jsonb,
                trucks = $3::jsonb,
                summary = $4::jsonb,
                saved_at = now()
          WHERE plan_id = $1`,
        [
          row.id,
          JSON.stringify(scrubbed.plan.orders || []),
          JSON.stringify(scrubbed.plan.trucks || []),
          JSON.stringify(scrubbed.plan.summary || {})
        ]
      );
      const cleanPlan = {
        ...scrubbed.plan,
        id: row.id,
        planDate: row.plan_date,
        revision: Number(updated.rows[0]?.revision || row.revision || 0)
      };
      await syncDispatchDeliveryGroupsFromPlan(cleanPlan);
      await syncDispatchPlanLoadAssignments(cleanPlan);
      changedPlans.push({
        planId: String(row.id),
        planDate: row.plan_date,
        revision: cleanPlan.revision,
        removedOrderRefs: scrubbed.removedOrderRefs,
        updatedGroupRefs: refreshed.updatedGroupRefs
      });
    }
    return { changedPlans, deferred: false, familyRefs: refs };
  });
}

export async function cleanupBilledSalesOrderFamilyFromDispatchPlans({
  canonicalRef = "",
  familyRefs = [],
  actor = "scm-reconciliation"
} = {}) {
  return reconcileSalesOrderFamilyInDispatchPlans({
    canonicalRef,
    familyRefs,
    billed: true,
    actor
  });
}

export async function cleanupBilledSalesOrderFamiliesFromDispatchPlan({
  planId,
  actor = "driver-completion"
} = {}) {
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
            s.orders, s.trucks, s.summary, s.saved_at
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1
      LIMIT 1`,
    [planId]
  );
  const plan = planRow(result.rows[0]);
  if (!plan) return { changedPlans: [], deferredFamilies: [], familyCount: 0 };
  const families = await billedSalesOrderFamiliesInPlan(plan);
  const changedPlans = [];
  const deferredFamilies = [];
  for (const family of families) {
    const cleanup = await cleanupBilledSalesOrderFamilyFromDispatchPlans({
      canonicalRef: family.canonicalRef,
      familyRefs: family.familyRefs,
      actor
    });
    changedPlans.push(...(cleanup.changedPlans || []));
    if (cleanup.deferred) deferredFamilies.push(family.familyRefs);
  }
  return {
    changedPlans,
    deferredFamilies,
    familyCount: families.length
  };
}

export async function listDispatchPlanSnapshots({ planDate } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const current = await query(
    `SELECT p.id AS plan_id, p.plan_date::text AS plan_date, p.status, p.revision,
            NULL::jsonb AS orders, NULL::jsonb AS trucks, s.summary, s.saved_at,
            s.schema_version, s.plan_digest, s.order_count, s.truck_count,
            s.load_count, s.stop_count,
            NULL::bigint AS id, NULL::timestamptz AS archived_at,
            NULL::text AS archive_reason, NULL::text AS session_id,
            NULL::timestamptz AS original_saved_at
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date = $1::date
      LIMIT 1`,
    [cleanDate]
  );
  const history = await query(
    `SELECT h.id, h.plan_id, h.plan_date::text AS plan_date, p.status, h.revision,
            NULL::jsonb AS orders, NULL::jsonb AS trucks, h.summary, h.original_saved_at, h.archived_at,
            h.schema_version, h.plan_digest, h.order_count, h.truck_count,
            h.load_count, h.stop_count,
            h.archive_reason, h.session_id, NULL::timestamptz AS saved_at
       FROM dispatch_plan_snapshot_history h
       JOIN dispatch_plans p ON p.id = h.plan_id
      WHERE h.plan_date = $1::date
      ORDER BY h.archived_at DESC, h.id DESC
      LIMIT 200`,
    [cleanDate]
  );
  return {
    planDate: cleanDate,
    snapshots: [
      ...current.rows.map((row) => snapshotSummary(row, { current: true })),
      ...history.rows.map((row) => snapshotSummary(row))
    ]
  };
}

export async function getDispatchPlanSnapshot(snapshotId) {
  const text = String(snapshotId || "");
  if (text.startsWith("current-")) {
    const planId = text.replace(/^current-/, "");
    const result = await query(
      `SELECT p.id AS plan_id, p.plan_date::text AS plan_date, p.status, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at,
              NULL::bigint AS id, NULL::timestamptz AS archived_at,
              NULL::text AS archive_reason, NULL::text AS session_id,
              NULL::timestamptz AS original_saved_at
         FROM dispatch_plans p
         LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        LIMIT 1`,
      [planId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return sanitizedSnapshotDetail(row, { current: true });
  }
  const result = await query(
    `SELECT h.id, h.plan_id, h.plan_date::text AS plan_date, p.status, h.revision,
            h.orders, h.trucks, h.summary, h.original_saved_at, h.archived_at,
            h.archive_reason, h.session_id, NULL::timestamptz AS saved_at
       FROM dispatch_plan_snapshot_history h
       JOIN dispatch_plans p ON p.id = h.plan_id
      WHERE h.id = $1
      LIMIT 1`,
    [snapshotId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return sanitizedSnapshotDetail(row);
}

export async function saveDispatchPlanRecoveryDraft(planId, {
  orders = [],
  trucks = [],
  summary = {},
  baseRevision = null,
  planDate = "",
  sessionId = "",
  validationIssues = []
} = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const currentResult = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision, p.confirmed_at,
              s.saved_at
         FROM dispatch_plans p
         LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [planId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error("Dispatch plan not found.");

    const activeRevision = Number(current.revision || 0);
    const activeStatus = String(current.status || "draft");
    const activePlanDate = cleanPlanDate(current.plan_date);
    const requestedPlanDate = cleanPlanDate(planDate || activePlanDate);
    const cleanSummary = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
    const recoveryPlan = buildCompactDispatchSnapshot({
      id: String(planId),
      planDate: activePlanDate,
      status: "recovery",
      orders: Array.isArray(orders) ? orders : [],
      trucks: Array.isArray(trucks) ? trucks : [],
      summary: {
        ...cleanSummary,
        saveRecovery: {
          version: 1,
          applied: false,
          activeStatus,
          activeRevision,
          baseRevision: baseRevision === null || baseRevision === undefined || baseRevision === ""
            ? null
            : Number(baseRevision),
          requestedPlanDate,
          validationIssues: Array.isArray(validationIssues) ? validationIssues : []
        }
      }
    });
    const recoveryDigest = digestDispatchPlan(recoveryPlan);
    const recoveryCounts = dispatchPlanBoard(recoveryPlan);
    const cleanSessionId = String(sessionId || "");
    const existing = await query(
      `SELECT id::text, archived_at
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'save_recovery'
          AND revision = $2
          AND session_id = $3
          AND plan_digest = $4
        ORDER BY id DESC
        LIMIT 1`,
      [planId, activeRevision, cleanSessionId, recoveryDigest]
    );
    const existingRecovery = existing.rows[0];
    if (existingRecovery) {
      return {
        id: String(existingRecovery.id),
        planId: String(planId),
        planDate: activePlanDate,
        activeStatus,
        activeRevision,
        activeConfirmedAt: current.confirmed_at || null,
        digest: recoveryDigest,
        archivedAt: existingRecovery.archived_at,
        deduplicated: true
      };
    }

    const inserted = await query(
       `INSERT INTO dispatch_plan_snapshot_history (
         plan_id, plan_date, revision, orders, trucks, summary,
         original_saved_at, archive_reason, session_id,
         schema_version, plan_digest, order_count, truck_count, load_count, stop_count,
         checkpoint_kind, retention_until
       ) VALUES (
         $1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb,
         $7, 'save_recovery', $8,
         2, $9, $10, $11, $12, $13,
         'recovery', NULL
       )
       RETURNING id::text, archived_at`,
      [
        planId,
        activePlanDate,
        activeRevision,
        JSON.stringify(recoveryPlan.orders || []),
        JSON.stringify(recoveryPlan.trucks || []),
        JSON.stringify(recoveryPlan.summary || {}),
        current.saved_at || null,
        cleanSessionId,
        recoveryDigest,
        (recoveryPlan.orders || []).length,
        recoveryCounts.truckCount,
        recoveryCounts.loadCount,
        recoveryCounts.stopCount
      ]
    );
    return {
      id: String(inserted.rows[0].id),
      planId: String(planId),
      planDate: activePlanDate,
      activeStatus,
      activeRevision,
      activeConfirmedAt: current.confirmed_at || null,
      digest: recoveryDigest,
      archivedAt: inserted.rows[0].archived_at,
      deduplicated: false
    };
  });
}

export async function saveDispatchPlanSnapshot(planId, { orders = [], trucks = [], summary = {}, baseRevision = null, planDate = "", sessionId = "" } = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const currentPlan = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at
         FROM dispatch_plans p
         LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [planId]
    );
    const existingPlan = currentPlan.rows[0];
    if (!existingPlan) throw new Error("Dispatch plan not found.");
    const previousPlan = {
      id: String(planId),
      planDate: cleanPlanDate(existingPlan.plan_date),
      orders: existingPlan.orders || [],
      trucks: existingPlan.trucks || [],
      summary: existingPlan.summary || {}
    };
    const payloadPlanDate = cleanPlanDate(planDate || existingPlan.plan_date);
    const expectedPlanDate = cleanPlanDate(existingPlan.plan_date);
    if (payloadPlanDate !== expectedPlanDate) {
      throw new DispatchPlanDateMismatchError({
        planId,
        expectedPlanDate,
        payloadPlanDate
      });
    }
    assertBinDispatchCapability({
      orders: [...(previousPlan.orders || []), ...(Array.isArray(orders) ? orders : [])],
      trucks: [...(previousPlan.trucks || []), ...(Array.isArray(trucks) ? trucks : [])]
    }, { operation: "save" });
    const canonicalPlan = await canonicalizeDispatchCustomOrdersInPlan({
      id: String(planId),
      planDate: expectedPlanDate,
      orders: Array.isArray(orders) ? orders : [],
      trucks: Array.isArray(trucks) ? trucks : [],
      summary: summary || {}
    }, {
      previousPlan,
      lockRows: true
    });
    await assertCustomOrderPlanDateExclusivity(canonicalPlan, {
      previousPlan
    });
    await assertSpecialStockHandoffPlanning(canonicalPlan, {
      previousPlan
    });
    await assertActiveDispatchFleetAssignments({
      id: planId,
      planDate: expectedPlanDate,
      orders: canonicalPlan.orders || [],
      trucks: canonicalPlan.trucks || []
    }, {
      previousPlan
    });
    await assertActiveDispatchCosForPlan({
      ...canonicalPlan,
      id: String(planId),
      planDate: expectedPlanDate
    });
    const hasBaseRevision = baseRevision !== null && baseRevision !== undefined && baseRevision !== "";
    const expectedRevision = Number(baseRevision);
    const result = hasBaseRevision && Number.isFinite(expectedRevision)
      ? await query(
          `UPDATE dispatch_plans
              SET updated_at = now(),
                  revision = revision + 1
            WHERE id = $1
              AND revision = $2
            RETURNING *`,
          [planId, expectedRevision]
        )
      : await query(
          `UPDATE dispatch_plans
              SET updated_at = now(),
                  revision = revision + 1
            WHERE id = $1
            RETURNING *`,
          [planId]
        );
    if (!result.rows[0]) {
      if (existingPlan && hasBaseRevision) {
        throw new StaleDispatchPlanSaveError({
          planId,
          expectedRevision,
          currentRevision: Number(existingPlan.revision || 0)
        });
      }
      throw new Error("Dispatch plan not found.");
    }
    const sanitizedPlan = await sanitizeDispatchPlan({
      id: String(planId),
      revision: Number(result.rows[0].revision || 0),
      orders: canonicalPlan.orders || [],
      trucks: canonicalPlan.trucks || [],
      summary: summary || {}
    });
    const cleanPlan = {
      ...sanitizedPlan,
      id: String(planId),
      planDate: expectedPlanDate,
      status: result.rows[0].status || "draft",
      note: result.rows[0].note || "",
      revision: Number(result.rows[0].revision || 0),
      summary: dispatchPlanV2Summary(sanitizedPlan.summary || {}, {
        previousSummary: existingPlan.summary || {},
        source: DISPATCH_PLAN_V2_SAVE_SOURCE
      })
    };
    const storedPlan = buildCompactDispatchSnapshot(cleanPlan);
    const storedDigest = digestDispatchPlan(storedPlan);
    const storedCounts = dispatchPlanBoard(storedPlan);
    if (existingPlan.saved_at) {
      const previousCounts = dispatchPlanBoard(previousPlan);
      await query(
        `INSERT INTO dispatch_plan_snapshot_history (
           plan_id, plan_date, revision, orders, trucks, summary,
           original_saved_at, archive_reason, session_id,
           schema_version, plan_digest, order_count, truck_count, load_count, stop_count
         )
         VALUES ($1, $2::date, $3, COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::jsonb, '[]'::jsonb),
                 COALESCE($6::jsonb, '{}'::jsonb), $7, 'before_save', $8,
                 2, $9, $10, $11, $12, $13)`,
        [
          planId,
          expectedPlanDate,
          existingPlan.revision,
          JSON.stringify(existingPlan.orders || []),
          JSON.stringify(existingPlan.trucks || []),
          JSON.stringify(existingPlan.summary || {}),
          existingPlan.saved_at,
          sessionId || "",
          digestDispatchPlan(previousPlan),
          (previousPlan.orders || []).length,
          previousCounts.truckCount,
          previousCounts.loadCount,
          previousCounts.stopCount
        ]
      );
    }
    await query(
      `INSERT INTO dispatch_plan_snapshots (
         plan_id, orders, trucks, summary, saved_at, schema_version, plan_digest,
         order_count, truck_count, load_count, stop_count
       )
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now(), 2, $5, $6, $7, $8, $9)
       ON CONFLICT (plan_id) DO UPDATE
         SET orders = EXCLUDED.orders,
             trucks = EXCLUDED.trucks,
             summary = EXCLUDED.summary,
             schema_version = EXCLUDED.schema_version,
             plan_digest = EXCLUDED.plan_digest,
             order_count = EXCLUDED.order_count,
             truck_count = EXCLUDED.truck_count,
             load_count = EXCLUDED.load_count,
             stop_count = EXCLUDED.stop_count,
             saved_at = now()`,
      [
        planId,
        JSON.stringify(storedPlan.orders),
        JSON.stringify(storedPlan.trucks),
        JSON.stringify(storedPlan.summary || {}),
        storedDigest,
        (storedPlan.orders || []).length,
        storedCounts.truckCount,
        storedCounts.loadCount,
        storedCounts.stopCount
      ]
    );
    await syncDispatchDeliveryGroupsFromPlan({
      id: planId,
      planDate: expectedPlanDate,
      orders: storedPlan.orders,
      trucks: storedPlan.trucks
    });
    await syncDispatchPlannerReadProjections({
      ...storedPlan,
      id: planId,
      planDate: expectedPlanDate,
      revision: cleanPlan.revision
    });
    await syncDispatchPlanLoadAssignments({
      ...storedPlan,
      id: planId,
      planDate: expectedPlanDate
    });
    return getDispatchPlan(planId);
  });
}

export async function restoreDispatchPlanSnapshot(snapshotId, { sessionId = "" } = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const sourceResult = await query(
      `SELECT h.*
         FROM dispatch_plan_snapshot_history h
        WHERE h.id = $1
        FOR UPDATE`,
      [snapshotId]
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error("Dispatch snapshot was not found.");
    const currentResult = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at
         FROM dispatch_plans p
         LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [source.plan_id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error("Dispatch plan was not found.");
    assertBinDispatchCapability({
      orders: [...(current.orders || []), ...(source.orders || [])],
      trucks: [...(current.trucks || []), ...(source.trucks || [])]
    }, { operation: "restore" });
    const sourceDate = cleanPlanDate(source.plan_date);
    const currentDate = cleanPlanDate(current.plan_date);
    if (sourceDate !== currentDate) {
      throw new DispatchPlanDateMismatchError({
        planId: source.plan_id,
        expectedPlanDate: currentDate,
        payloadPlanDate: sourceDate
      });
    }
    if (current.saved_at) {
      await query(
        `INSERT INTO dispatch_plan_snapshot_history (
           plan_id, plan_date, revision, orders, trucks, summary,
           original_saved_at, archive_reason, session_id,
           checkpoint_kind, checkpoint_key, retention_until
         )
         VALUES ($1, $2::date, $3, COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::jsonb, '[]'::jsonb),
                 COALESCE($6::jsonb, '{}'::jsonb), $7, 'before_restore', $8,
                 'lifecycle', $9, now() + interval '90 days')`,
        [
          current.id,
          currentDate,
          current.revision,
          JSON.stringify(current.orders || []),
          JSON.stringify(current.trucks || []),
          JSON.stringify(current.summary || {}),
          current.saved_at,
          sessionId || "",
          `restore:${snapshotId}:${current.revision}`
        ]
      );
    }
    await query(
      `UPDATE dispatch_plans
          SET revision = revision + 1,
              updated_at = now()
        WHERE id = $1`,
      [source.plan_id]
    );
    const sourcePlan = {
      id: String(source.plan_id),
      orders: source.orders || [],
      trucks: source.trucks || [],
      summary: source.summary || {}
    };
    const sanitizedPlan = await sanitizeDispatchPlan(
      isDispatchV2Plan(sourcePlan)
        ? sourcePlan
        : convertLegacyDispatchPlanToV2(sourcePlan, {
            ownYardCodes: current.summary?.ownYardCodes
              || current.summary?.dispatchPlanFormat?.ownYardCodes
              || dispatchLoadAssignmentDefaults.ownYards
          })
    );
    const canonicalPlan = await canonicalizeDispatchCustomOrdersInPlan({
      ...sanitizedPlan,
      planDate: currentDate
    }, {
      previousPlan: {
        id: current.id,
        planDate: currentDate,
        orders: current.orders || [],
        trucks: current.trucks || []
      },
      lockRows: true
    });
    await assertCustomOrderPlanDateExclusivity(canonicalPlan, {
      previousPlan: {
        id: current.id,
        planDate: currentDate,
        orders: current.orders || [],
        trucks: current.trucks || []
      }
    });
    await assertSpecialStockHandoffPlanning(canonicalPlan, {
      previousPlan: {
        id: current.id,
        planDate: currentDate,
        orders: current.orders || [],
        trucks: current.trucks || []
      }
    });
    const cleanPlan = {
      ...canonicalPlan,
      summary: dispatchPlanV2Summary(canonicalPlan.summary || {}, {
        previousSummary: current.summary || {},
        source: isDispatchV2Plan(sourcePlan)
          ? sourcePlan.summary?.dispatchPlanFormat?.source || DISPATCH_PLAN_V2_SAVE_SOURCE
          : DISPATCH_PLAN_V2_BACKFILL_SOURCE
      })
    };
    const activity = await query(
      `SELECT status, load_id, stop_id, stop_type, order_refs
         FROM driver_job_records
        WHERE plan_id = $1
          AND status IN ('in_progress', 'complete')
        ORDER BY id`,
      [current.id]
    );
    const executionPolicy = evaluateExecutedPrefixPolicy({
      previousPlan: {
        id: String(current.id),
        planDate: currentDate,
        orders: current.orders || [],
        trucks: current.trucks || []
      },
      nextPlan: {
        ...cleanPlan,
        id: String(current.id),
        planDate: currentDate
      },
      activity: activity.rows
    });
    if (!executionPolicy.allowed) {
      const first = executionPolicy.conflicts[0] || {};
      throw Object.assign(
        new Error(first.message || "Driver activity protects the executed physical prefix."),
        {
          code: first.code || "DISPATCH_ACTIVE_LOAD_LOCKED",
          status: 409,
          conflicts: executionPolicy.conflicts
        }
      );
    }
    await assertActiveDispatchFleetAssignments({
      ...cleanPlan,
      planDate: currentDate
    }, {
      previousPlan: {
        id: current.id,
        planDate: currentDate,
        orders: current.orders || [],
        trucks: current.trucks || []
      }
    });
    await assertActiveDispatchCosForPlan({
      ...cleanPlan,
      id: String(source.plan_id),
      planDate: currentDate
    });
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (plan_id) DO UPDATE
         SET orders = EXCLUDED.orders,
             trucks = EXCLUDED.trucks,
             summary = EXCLUDED.summary,
             saved_at = now()`,
      [source.plan_id, JSON.stringify(cleanPlan.orders), JSON.stringify(cleanPlan.trucks), JSON.stringify(cleanPlan.summary || {})]
    );
    await syncDispatchDeliveryGroupsFromPlan({
      id: source.plan_id,
      planDate: currentDate,
      orders: cleanPlan.orders,
      trucks: cleanPlan.trucks
    });
    await syncDispatchPlannerReadProjections({
      ...cleanPlan,
      id: source.plan_id,
      planDate: currentDate,
      revision: Number(current.revision || 0) + 1
    });
    await syncDispatchPlanLoadAssignments({
      ...cleanPlan,
      id: source.plan_id,
      planDate: currentDate
    });
    return {
      plan: await getDispatchPlan(source.plan_id),
      restoredSnapshot: snapshotSummary(source),
      previousRevision: Number(current.revision || 0)
    };
  });
}

/**
 * Keep the legacy/default confirmation seam fail-closed for BIN snapshots.
 * The only opt-in is the dedicated service callback, which executes after the
 * existing plan lock and before any status/snapshot write in this transaction.
 *
 * @param {string | number} planId
 * @param {object} [options]
 * @param {string} [options.note]
 * @param {null | {validate: Function, hooks?: Record<string, Function>}} [options.binBoundary]
 */
async function confirmDispatchPlanTransaction(planId, { note = "", binBoundary = null } = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const currentResult = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
              s.orders, s.trucks, s.summary, s.saved_at
         FROM dispatch_plans p
         LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [planId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error("Dispatch plan not found.");
    const currentPlan = {
      id: String(current.id),
      planDate: cleanPlanDate(current.plan_date),
      status: String(current.status),
      revision: Number(current.revision),
      orders: current.orders || [],
      trucks: current.trucks || [],
      summary: current.summary || {}
    };
    if (binBoundary === null) {
      assertBinDispatchCapability(currentPlan, { operation: "confirm" });
    } else {
      if (typeof binBoundary.validate !== "function") {
        throw new TypeError("A locked BIN confirmation validator is required.");
      }
      await binBoundary.validate({
        plan: currentPlan,
        status: String(current.status),
        revision: Number(current.revision)
      });
      if (String(current.status) === "confirmed") {
        return getDispatchPlan(planId);
      }
    }
    const canonicalPlan = await canonicalizeDispatchCustomOrdersInPlan(currentPlan, {
      previousPlan: currentPlan,
      lockRows: true
    });
    await assertCustomOrderPlanDateExclusivity(canonicalPlan, { previousPlan: currentPlan });
    await assertSpecialStockHandoffPlanning(canonicalPlan);
    const sanitizedPlan = await sanitizeDispatchPlan(canonicalPlan);
    await assertActiveDispatchFleetAssignments(sanitizedPlan, { previousPlan: currentPlan });
    await assertActiveDispatchCosForPlan({
      ...sanitizedPlan,
      id: String(planId),
      planDate: currentPlan.planDate
    });
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              summary = $4::jsonb
        WHERE plan_id = $1`,
      [
        planId,
        JSON.stringify(sanitizedPlan.orders || []),
        JSON.stringify(sanitizedPlan.trucks || []),
        JSON.stringify(sanitizedPlan.summary || {})
      ]
    );
    const result = await query(
      `UPDATE dispatch_plans
          SET status = 'confirmed',
              note = COALESCE(NULLIF($2, ''), note),
              confirmed_at = COALESCE(confirmed_at, now()),
              revision = revision + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [planId, note || ""]
    );
    if (!result.rows[0]) throw new Error("Dispatch plan not found.");
    if (typeof binBoundary?.hooks?.afterStatusUpdate === "function") {
      await binBoundary.hooks.afterStatusUpdate({
        planId: String(planId),
        revision: Number(result.rows[0].revision)
      });
    }
    const plan = await getDispatchPlan(planId);
    await syncDispatchPlanLoadAssignments(plan, { allowBin: binBoundary !== null });
    return plan;
  });
}

export async function confirmDispatchPlan(planId, { note = "" } = {}) {
  return confirmDispatchPlanTransaction(planId, { note });
}

/**
 * Internal repository seam for the capability-authorized BIN confirmation
 * service. Callers cannot bypass validation: omission of the locked validator
 * fails before any plan mutation, while all legacy callers retain the default
 * path above.
 *
 * @param {string | number} planId
 * @param {{note?: string, validate: Function, hooks?: Record<string, Function>}} options
 */
export async function confirmValidatedBinDispatchPlan(planId, {
  note = "",
  validate,
  hooks = {}
} = /** @type {any} */ ({})) {
  if (typeof validate !== "function") {
    throw new TypeError("A locked BIN confirmation validator is required.");
  }
  return confirmDispatchPlanTransaction(planId, {
    note,
    binBoundary: { validate, hooks }
  });
}

export async function reopenDispatchPlan(planId, { note = "" } = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
    const result = await query(
      `UPDATE dispatch_plans
          SET status = 'draft',
              note = COALESCE(NULLIF($2, ''), note),
              confirmed_at = NULL,
              revision = revision + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [planId, note || ""]
    );
    if (!result.rows[0]) throw new Error("Dispatch plan not found.");
    return getDispatchPlan(planId);
  });
}
