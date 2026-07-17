import { query, withTransaction } from "./db.js";
import { syncDispatchDeliveryGroupsFromPlan } from "./dispatch-delivery-group-repository.js";

const CUSTOMER_PICKUP_DELIVERY_METHOD = "Pick-Up";

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function cleanPlanDate(value) {
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
          dispatchTruckPlate: truck.plate || "",
          dispatchLoadName: load.name || "",
          dispatchParkingSpot: truck.parkingSpot || ""
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
  const trucks = Array.isArray(row.trucks) ? row.trucks : [];
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
  const pickupRefs = await pickupSalesOrderRefs(plan);
  const enrichedPlan = await enrichDispatchPlanWeights(plan);
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
    return { ...snapshotSummary(row, { current: true }), orders: row.orders || [], rawTrucks: row.trucks || [] };
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
  return { ...snapshotSummary(row), orders: row.orders || [], rawTrucks: row.trucks || [] };
}

export async function saveDispatchPlanSnapshot(planId, { orders = [], trucks = [], summary = {}, baseRevision = null, planDate = "", sessionId = "" } = {}) {
  return withTransaction(async () => {
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
    const cleanPlan = await sanitizeDispatchPlan({
      id: String(planId),
      revision: Number(result.rows[0].revision || 0),
      orders: Array.isArray(orders) ? orders : [],
      trucks: Array.isArray(trucks) ? trucks : [],
      summary: summary || {}
    });
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
    return getDispatchPlan(planId);
  });
}

export async function restoreDispatchPlanSnapshot(snapshotId, { sessionId = "" } = {}) {
  return withTransaction(async () => {
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
    const cleanPlan = await sanitizeDispatchPlan({
      id: String(source.plan_id),
      orders: source.orders || [],
      trucks: source.trucks || [],
      summary: source.summary || {}
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
    return {
      plan: await getDispatchPlan(source.plan_id),
      restoredSnapshot: snapshotSummary(source),
      previousRevision: Number(current.revision || 0)
    };
  });
}

export async function confirmDispatchPlan(planId, { note = "" } = {}) {
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
  return getDispatchPlan(planId);
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
