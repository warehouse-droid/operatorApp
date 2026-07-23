import { query, withTransaction } from "./db.js";
import { syncDispatchDeliveryGroupsFromPlan } from "./dispatch-delivery-group-repository.js";
import {
  dispatchLoadAssignment,
  dispatchLoadAssignmentDefaults,
  normalizeDispatchPlanLoadAssignments
} from "./dispatch-load-assignment.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";
import {
  DISPATCH_FLEET_PLANNING_LOCK,
  dispatchFleetAssignmentStatusConflicts,
  unchangedCompletedDispatchLoadIds
} from "./dispatch-fleet-status.js";

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

function dispatchPlanV2Summary(summary = {}, {
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
          migratedAt: String(migratedAt || new Date().toISOString()),
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
  return {
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
    addRef(orderId, plannedDetails);
    if (!order || order.type === "CO") return;
    addRef(order.originalOrderId, plannedDetails);
    for (const childId of order.childOrders || []) addRef(childId, plannedDetails);
    for (const child of order.childOrderDetails || []) {
      addRef(child?.id, plannedDetails);
      addRef(child?.originalOrderId, plannedDetails);
    }
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
    orderCount: orders.length,
    truckCount: trucks.length,
    loadCount: countPlanLoads(trucks),
    loadOrderCount: countPlanLoadOrders(trucks),
    stopCount: countPlanStops(trucks),
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

function collectPlanOrderRefs(plan) {
  const refs = new Set();
  for (const order of plan?.orders || []) {
    const id = String(order?.id || "").trim();
    if (id) refs.add(id);
  }
  for (const truck of plan?.trucks || []) {
    for (const load of truck?.loads || []) {
      for (const stop of load?.stops || []) {
        const id = String(stop?.orderId || "").trim();
        if (id) refs.add(id);
      }
    }
  }
  return [...refs];
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
  const pickupRefs = await pickupSalesOrderRefs(normalizedPlan);
  const enrichedPlan = await enrichDispatchPlanWeights(normalizedPlan);
  if (!pickupRefs.size) return enrichedPlan;

  return {
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
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     ON CONFLICT (plan_id) DO NOTHING`,
    [plan.id]
  );
  return getDispatchPlan(plan.id);
}

export async function getDispatchPlan(planId) {
  const result = await query(
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary
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
    `SELECT p.*, s.saved_at, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date = $1
      LIMIT 1`,
    [cleanDate]
  );
  return sanitizeDispatchPlan(planRow(result.rows[0]));
}

export async function listDispatchPlanSnapshots({ planDate } = {}) {
  const cleanDate = cleanPlanDate(planDate);
  const current = await query(
    `SELECT p.id AS plan_id, p.plan_date::text AS plan_date, p.status, p.revision,
            s.orders, s.trucks, s.summary, s.saved_at,
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
            h.orders, h.trucks, h.summary, h.original_saved_at, h.archived_at,
            h.archive_reason, h.session_id, NULL::timestamptz AS saved_at
       FROM dispatch_plan_snapshot_history h
       JOIN dispatch_plans p ON p.id = h.plan_id
      WHERE h.plan_date = $1::date
      ORDER BY h.archived_at DESC, h.id DESC`,
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
    return { ...snapshotSummary(row, { current: true }), orders: row.orders || [], rawTrucks: normalizedSnapshotTrucks(row) };
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
  return { ...snapshotSummary(row), orders: row.orders || [], rawTrucks: normalizedSnapshotTrucks(row) };
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
    const payloadPlanDate = cleanPlanDate(planDate || existingPlan.plan_date);
    const expectedPlanDate = cleanPlanDate(existingPlan.plan_date);
    if (payloadPlanDate !== expectedPlanDate) {
      throw new DispatchPlanDateMismatchError({
        planId,
        expectedPlanDate,
        payloadPlanDate
      });
    }
    await assertActiveDispatchFleetAssignments({
      id: planId,
      planDate: expectedPlanDate,
      orders: Array.isArray(orders) ? orders : [],
      trucks: Array.isArray(trucks) ? trucks : []
    }, {
      previousPlan: {
        id: planId,
        planDate: expectedPlanDate,
        orders: existingPlan.orders || [],
        trucks: existingPlan.trucks || []
      }
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
      orders: Array.isArray(orders) ? orders : [],
      trucks: Array.isArray(trucks) ? trucks : [],
      summary: summary || {}
    });
    const cleanPlan = {
      ...sanitizedPlan,
      summary: dispatchPlanV2Summary(sanitizedPlan.summary || {}, {
        previousSummary: existingPlan.summary || {},
        source: DISPATCH_PLAN_V2_SAVE_SOURCE
      })
    };
    if (existingPlan.saved_at) {
      await query(
        `INSERT INTO dispatch_plan_snapshot_history (
           plan_id, plan_date, revision, orders, trucks, summary,
           original_saved_at, archive_reason, session_id
         )
         VALUES ($1, $2::date, $3, COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::jsonb, '[]'::jsonb),
                 COALESCE($6::jsonb, '{}'::jsonb), $7, 'before_save', $8)`,
        [
          planId,
          expectedPlanDate,
          existingPlan.revision,
          JSON.stringify(existingPlan.orders || []),
          JSON.stringify(existingPlan.trucks || []),
          JSON.stringify(existingPlan.summary || {}),
          existingPlan.saved_at,
          sessionId || ""
        ]
      );
    }
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
       ON CONFLICT (plan_id) DO UPDATE
         SET orders = EXCLUDED.orders,
             trucks = EXCLUDED.trucks,
             summary = EXCLUDED.summary,
             saved_at = now()`,
      [planId, JSON.stringify(cleanPlan.orders), JSON.stringify(cleanPlan.trucks), JSON.stringify(cleanPlan.summary || {})]
    );
    await syncDispatchDeliveryGroupsFromPlan({
      id: planId,
      planDate: expectedPlanDate,
      orders: cleanPlan.orders,
      trucks: cleanPlan.trucks
    });
    await syncDispatchPlanLoadAssignments({
      ...cleanPlan,
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
           original_saved_at, archive_reason, session_id
         )
         VALUES ($1, $2::date, $3, COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::jsonb, '[]'::jsonb),
                 COALESCE($6::jsonb, '{}'::jsonb), $7, 'before_restore', $8)`,
        [
          current.id,
          currentDate,
          current.revision,
          JSON.stringify(current.orders || []),
          JSON.stringify(current.trucks || []),
          JSON.stringify(current.summary || {}),
          current.saved_at,
          sessionId || ""
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
    const cleanPlan = {
      ...sanitizedPlan,
      summary: dispatchPlanV2Summary(sanitizedPlan.summary || {}, {
        previousSummary: current.summary || {},
        source: isDispatchV2Plan(sourcePlan)
          ? sourcePlan.summary?.dispatchPlanFormat?.source || DISPATCH_PLAN_V2_SAVE_SOURCE
          : DISPATCH_PLAN_V2_BACKFILL_SOURCE
      })
    };
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

export async function confirmDispatchPlan(planId, { note = "" } = {}) {
  return withTransaction(async () => {
    await lockDispatchFleetPlanning();
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
    const plan = await getDispatchPlan(planId);
    await assertActiveDispatchFleetAssignments(plan, { previousPlan: plan });
    await syncDispatchPlanLoadAssignments(plan);
    return plan;
  });
}

export async function reopenDispatchPlan(planId, { note = "" } = {}) {
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
}
