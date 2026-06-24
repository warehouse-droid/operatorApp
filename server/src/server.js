import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchTransferDeliveryOrdersFromNetSuite, fetchTransferDeliveryOrderFromNetSuite, fetchTransferOrderDetailsFromNetSuite, fetchPurchaseOrdersFromNetSuite, fetchPurchaseOrderFromNetSuite, fetchPurchaseOrderDetailsFromNetSuite, fetchTransferReceivingOrdersFromNetSuite, fetchTransferReceivingOrderFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt } from "./netsuite.js";
import { upsertDeliveryOrders, upsertDeliveryOrderLines, markMissingDeliveryOrderLines, listExistingDeliveryOrderIds, markDeliveryOrderMissing, listDeliveryOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, recordDeliveryLoad, listDeliveryFulfillments, resetDeliveryFulfillmentState, applyConfirmedDispatchPlanToDelivery } from "./delivery-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listOperators, loginOperator, logoutToken, setOperatorActive, updateOperatorPassword, writeAudit } from "./auth-repository.js";
import { applyInventoryClassificationRules, confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";
import { upsertReceivingOrders, upsertReceivingOrderLines, markMissingReceivingOrders, markMissingReceivingOrderLines, listExistingReceivingOrderIds, listReceivingVendors, listReceivingSources, listReceivingOrders, getReceivingOrder, searchReceivingItems, confirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt, recordReceivingReceiptFailure, listReceivingReceipts, listLocalCoSources, listLocalCoReceivingOrders, searchLocalCoItems, getLocalCoReceivingOrder, confirmLocalCoReceivingLine, receiveLocalCoOrder } from "./receiving-repository.js";
import { listOperatorHistory, listRecordWarnings, reportOperatorRecordError, resolveRecordWarning } from "./history-repository.js";
import { listDispatchOrders, refreshDispatchEnrichment, setPurchaseOrderVendorYard, updateDispatchOrderDetails, createDispatchOperatorRequest, upsertLocalCoOrder, cancelLocalCoOrder, listDispatchOperatorRequests, resolveDispatchOperatorRequestsForOrder } from "./dispatch-repository.js";
import { listDispatchVendorYards, updateDispatchVendorYard, upsertDispatchVendorYard, listDispatchParserRules, updateDispatchParserRule, listOllamaAudit } from "./dispatch-enrichment.js";
import { listDispatchAudit, writeDispatchAudit } from "./dispatch-audit-repository.js";
import { confirmDispatchPlan, createDispatchPlan, getCurrentDispatchPlan, getDispatchPlan, listDispatchPlans, reopenDispatchPlan, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { getNextDriverJob, listDriverJobStatuses, recordDriverJobPhotos, startDriverJob } from "./driver-repository.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const dataDir = path.resolve(dirname, "../data");
const dispatchPlanPath = path.join(dataDir, "dispatch-plan.json");
const dispatchSetupPath = path.join(dataDir, "dispatch-setup.json");
const deliveryLocations = [1, 13, 15];
const fulfillmentJobs = new Map();
const receivingJobs = new Map();
const driverSessions = new Map();
const eventClients = new Set();
let eventSeq = 0;
const defaultDispatchSetup = {
  drivers: [
    { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
    { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
  ],
  trucks: [
    { plate: "MBBS-101", capacityLbs: 48000 },
    { plate: "MBBS-205", capacityLbs: 44000 },
    { plate: "MBBS-318", capacityLbs: 52000 }
  ],
  sync: {
    mode: "manual",
    intervalSeconds: 60,
    running: false,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastSource: "",
    lastStatus: "idle",
    lastError: ""
  }
};

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function orderTransactionType(orderRef, order = {}) {
  const type = order.type || (String(orderRef).startsWith("PO") ? "PO" : String(orderRef).startsWith("TO") ? "TO" : "SO");
  return {
    SO: "Sales Order",
    TO: "Transfer Order",
    PO: "Purchase Order"
  }[type] || "Sales Order";
}

function dispatchPlanStopIds(plan) {
  return new Set((plan?.trucks || []).flatMap((truck) =>
    (truck.loads || []).flatMap((load) => (load.stops || []).map((stop) => String(stop.id || "")))
  ));
}

function sanitizeDispatchPlanOrders(orders = []) {
  const groupedChildren = new Set();
  for (const order of orders || []) {
    for (const childId of order?.childOrders || []) {
      if (childId) groupedChildren.add(String(childId));
    }
  }
  return (orders || []).filter((order) => !groupedChildren.has(String(order?.id || "")));
}

function shippedDispatchCsv(plan, driverJobStatuses = []) {
  const ordersById = new Map((plan.orders || []).map((order) => [String(order.id || ""), order]));
  const currentStopIds = dispatchPlanStopIds(plan);
  const rows = [["Order Number", "Transaction Type", "Weight", "Tracking Number", "Label Integration"]];
  const exported = new Set();
  const completedRefs = new Set();

  for (const record of driverJobStatuses) {
    if (record.status !== "complete" || record.stop_type !== "dropoff") continue;
    if (!currentStopIds.has(String(record.stop_id || ""))) continue;
    for (const ref of record.order_refs || []) {
      const orderRef = String(ref || "").trim();
      if (!orderRef || orderRef.startsWith("CO-")) continue;
      completedRefs.add(orderRef);
    }
  }

  for (const orderRef of completedRefs) {
    const order = ordersById.get(orderRef) || {};
    const originalRef = order.originalOrderId || "";
    if (originalRef) {
      const splitRefs = (plan.orders || [])
        .filter((item) => String(item.originalOrderId || "") === String(originalRef))
        .map((item) => String(item.id || ""))
        .filter(Boolean);
      if (!splitRefs.length || splitRefs.some((ref) => !completedRefs.has(ref))) continue;
    }
    const exportRef = order.sourceOrderId || order.relatedSoId || originalRef || orderRef;
    const key = `${exportRef}|${orderTransactionType(orderRef, order)}`;
    if (exported.has(key)) continue;
    exported.add(key);
    rows.push([exportRef, orderTransactionType(orderRef, order), "", "", ""]);
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function emitAppEvent(type, payload = {}) {
  const event = {
    id: ++eventSeq,
    type,
    at: new Date().toISOString(),
    payload
  };
  const body = `id: ${event.id}\nevent: app-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    try {
      client.res.write(body);
    } catch {
      eventClients.delete(client);
    }
  }
}

function updateFulfillmentJob(jobId, patch) {
  const current = fulfillmentJobs.get(jobId) || { id: jobId };
  fulfillmentJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function updateReceivingJob(jobId, patch) {
  const current = receivingJobs.get(jobId) || { id: jobId };
  receivingJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function bearerToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

function operatorId(req) {
  return req.operator?.id || "";
}

function publicDriver(driver) {
  if (!driver) return null;
  return {
    login: driver.login,
    name: driver.name,
    license: driver.license,
    number: driver.number
  };
}

function driverToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

async function requireDriver(req, res, next) {
  try {
    const token = driverToken(req);
    const session = driverSessions.get(token);
    if (!session) return res.status(401).json({ error: "Driver login required" });
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === session.login);
    if (!driver) {
      driverSessions.delete(token);
      return res.status(401).json({ error: "Driver login required" });
    }
    req.driver = driver;
    req.driverLogin = session.login;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireOperator(req, res, next) {
  try {
    const operator = await getOperatorByToken(bearerToken(req));
    if (!operator) return res.status(401).json({ error: "Login required" });
    req.operator = operator;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.operator?.role !== "admin") return res.status(403).json({ error: "Admin account required" });
  next();
}

function requireDispatcher(req, res, next) {
  if (!["dispatcher", "admin"].includes(req.operator?.role)) {
    return res.status(403).json({ error: "Dispatcher account required" });
  }
  next();
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const result = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    timeout
  ]);
  clearTimeout(timer);
  return result;
}

async function readDispatchSetup() {
  const text = await fs.readFile(dispatchSetupPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!text) return defaultDispatchSetup;
  const saved = JSON.parse(text);
  return {
    drivers: Array.isArray(saved.drivers) ? saved.drivers : defaultDispatchSetup.drivers,
    trucks: Array.isArray(saved.trucks) ? saved.trucks : defaultDispatchSetup.trucks,
    sync: normalizeSyncSettings(saved.sync)
  };
}

function normalizeSyncSettings(sync = {}) {
  const mode = sync.mode === "auto" ? "auto" : "manual";
  const intervalSeconds = Number(sync.intervalSeconds || defaultDispatchSetup.sync.intervalSeconds);
  return {
    ...defaultDispatchSetup.sync,
    ...sync,
    mode,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? Math.round(intervalSeconds) : defaultDispatchSetup.sync.intervalSeconds,
    running: Boolean(sync.running)
  };
}

async function writeDispatchSetup(patch = {}) {
  const current = await readDispatchSetup();
  const payload = {
    drivers: Array.isArray(patch.drivers) ? patch.drivers : current.drivers,
    trucks: Array.isArray(patch.trucks) ? patch.trucks : current.trucks,
    sync: patch.sync ? normalizeSyncSettings({ ...current.sync, ...patch.sync }) : current.sync
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dispatchSetupPath, JSON.stringify(payload, null, 2));
  return payload;
}

function normalizeOrderType(value) {
  return value === "transfer_order" || value === "transfer" ? "transfer_order" : "sales_order";
}

async function syncDeliveryLocation(locationId, { includeDetails = true, orderType = "sales_order" } = {}) {
  const normalizedOrderType = normalizeOrderType(orderType);
  const discoveredOrders = normalizedOrderType === "transfer_order"
    ? await fetchTransferDeliveryOrdersFromNetSuite(locationId)
    : await fetchDeliveryOrdersFromNetSuite(locationId);
  await upsertDeliveryOrders(discoveredOrders);

  const existingIds = await listExistingDeliveryOrderIds({ locationId, orderType: normalizedOrderType });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];

  let orderCount = discoveredOrders.length;
  let detailCount = 0;
  let missingCount = 0;
  for (const orderId of orderIds) {
    const trackedOrder = normalizedOrderType === "transfer_order"
      ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
      : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
    if (!trackedOrder) {
      await markDeliveryOrderMissing(orderId);
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: "netsuite.order.missing",
        orderId,
        details: { locationId }
      });
      missingCount += 1;
      continue;
    }

    await upsertDeliveryOrders([trackedOrder]);
    if (!discoveredOrders.some((order) => String(order.id) === String(orderId))) orderCount += 1;

    if (includeDetails) {
      const lines = normalizedOrderType === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      await upsertDeliveryOrderLines(orderId, lines);
      await markMissingDeliveryOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.delivery.sync",
    details: { locationId, orderType: normalizedOrderType, discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount }
  });

  return { discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount };
}

let syncRunning = false;
async function runDispatchSync({ source = "manual", actorOperatorId = null } = {}) {
  if (syncRunning) {
    return { skipped: true, reason: "sync_running" };
  }
  syncRunning = true;
  const startedAt = new Date().toISOString();
  await writeDispatchSetup({
    sync: {
      running: true,
      lastStartedAt: startedAt,
      lastSource: source,
      lastStatus: "running",
      lastError: ""
    }
  });
  try {
    const synced = await syncDispatchOrderFeed();
    const enriched = await refreshDispatchEnrichment();
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: "success",
        lastError: ""
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: source === "auto" ? "netsuite.auto_sync" : "netsuite.manual_sync",
      details: { synced, enriched }
    });
    emitAppEvent("dispatch.orders.updated", { source, syncedAt: finishedAt });
    return { synced, enriched, startedAt, finishedAt };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: "failed",
        lastError: error.message
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: source === "auto" ? "netsuite.auto_sync_failed" : "netsuite.manual_sync_failed",
      details: { error: error.message }
    });
    throw error;
  } finally {
    syncRunning = false;
  }
}

async function autoSyncTick() {
  try {
    const setup = await readDispatchSetup();
    if (setup.sync?.mode !== "auto") return;
    await runDispatchSync({ source: "auto" });
  } catch (error) {
    console.error("Dispatch auto-sync failed:", error.message);
  }
}

async function syncDispatchOrderFeed() {
  const deliveryResults = [];
  const receivingResults = [];
  for (const locationId of deliveryLocations) {
    deliveryResults.push({
      locationId,
      orderType: "sales_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "sales_order" })
    });
    deliveryResults.push({
      locationId,
      orderType: "transfer_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "transfer_order" })
    });
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "purchase_order",
      synced: await syncPurchaseReceiving({ locationId })
    });
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "transfer_order",
      synced: await syncTransferReceiving({ destinationLocationId: locationId })
    });
  }
  return { delivery: deliveryResults, receiving: receivingResults };
}

async function syncPurchaseReceiving({ locationId = 1, includeDetails = true } = {}) {
  const discoveredOrders = await fetchPurchaseOrdersFromNetSuite(locationId);
  await upsertReceivingOrders(discoveredOrders);
  const existingIds = await listExistingReceivingOrderIds({ orderType: "purchase_order", destinationLocationId: locationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    const trackedOrder = await fetchPurchaseOrderFromNetSuite(orderId, locationId);
    if (!trackedOrder) continue;
    await upsertReceivingOrders([trackedOrder]);
    if (includeDetails) {
      const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, locationId);
      await upsertReceivingOrderLines(orderId, lines);
      await markMissingReceivingOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingReceivingOrders({ orderType: "purchase_order", activeOrderIds: discoveredOrders.map((order) => order.id), destinationLocationId: locationId });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.purchase_order.sync",
    details: { locationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncTransferReceiving({ sourceLocationId = null, destinationLocationId = null, includeDetails = true } = {}) {
  const discoveredOrders = await fetchTransferReceivingOrdersFromNetSuite({ sourceLocationId, destinationLocationId });
  await upsertReceivingOrders(discoveredOrders);
  const existingIds = await listExistingReceivingOrderIds({ orderType: "transfer_order", sourceLocationId, destinationLocationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    const trackedOrder = await fetchTransferReceivingOrderFromNetSuite(orderId);
    if (!trackedOrder) continue;
    await upsertReceivingOrders([trackedOrder]);
    if (includeDetails) {
      const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, destinationLocationId || null, { direction: "destination" });
      await upsertReceivingOrderLines(orderId, lines);
      await markMissingReceivingOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingReceivingOrders({
    orderType: "transfer_order",
    activeOrderIds: discoveredOrders.map((order) => order.id),
    sourceLocationId,
    destinationLocationId
  });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.transfer_order.sync",
    details: { sourceLocationId, destinationLocationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncReceivingOrderDetails(orderId, { orderType = null, locationId = null, sourceLocationId = null } = {}) {
  const existing = await getReceivingOrder(orderId);
  const normalizedOrderType = orderType || existing?.order_type || "purchase_order";
  if (normalizedOrderType === "transfer_order") {
    const effectiveDestinationLocationId = locationId || existing?.destination_location_id || null;
    const storedSourceLocationId = existing?.source_location_id && String(existing.source_location_id) !== String(effectiveDestinationLocationId)
      ? existing.source_location_id
      : null;
    const effectiveSourceLocationId = sourceLocationId || storedSourceLocationId;
    const order = await fetchTransferReceivingOrderFromNetSuite(orderId, effectiveSourceLocationId);
    if (!order) return { order: false, lines: 0 };
    await upsertReceivingOrders([order]);
    const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, effectiveDestinationLocationId || order.destination_location_id, { direction: "destination" });
    await upsertReceivingOrderLines(orderId, lines);
    await markMissingReceivingOrderLines(orderId, lines.map((line) => line.line_id));
    return { order: true, orderType: "transfer_order", lines: lines.length };
  }

  const effectiveLocationId = locationId || existing?.destination_location_id || null;
  const order = await fetchPurchaseOrderFromNetSuite(orderId, effectiveLocationId);
  if (!order) return { order: false, lines: 0 };
  await upsertReceivingOrders([order]);
  const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, effectiveLocationId);
  await upsertReceivingOrderLines(orderId, lines);
  await markMissingReceivingOrderLines(orderId, lines.map((line) => line.line_id));
  return { order: true, orderType: "purchase_order", lines: lines.length };
}

app.use(express.json({ limit: "25mb" }));

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const client = {
    id: crypto.randomUUID(),
    client: req.query.client || "unknown",
    res
  };
  eventClients.add(client);
  res.write(`retry: 3000\n`);
  res.write(`event: app-event\ndata: ${JSON.stringify({ id: eventSeq, type: "connected", at: new Date().toISOString(), payload: { client: client.client } })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      eventClients.delete(client);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
  });
});

app.use(express.static(publicDir));

app.use("/api/dispatch", requireOperator, requireDispatcher);

app.get("/api/dispatch/config", (req, res) => {
  res.json({
    googleMapsApiKey: config.googleMapsApiKey
  });
});

app.get("/api/dispatch/plans", async (req, res, next) => {
  try {
    res.json(await listDispatchPlans({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans", async (req, res, next) => {
  try {
    const plan = await createDispatchPlan({
      planDate: req.body?.planDate,
      note: req.body?.note || ""
    });
    await writeDispatchAudit({
      action: "dispatch_plan_created",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { planDate: plan.planDate }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.created", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/current", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    res.json(plan || { savedAt: "", orders: [], trucks: [], planDate: req.query.date || new Date().toISOString().slice(0, 10) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id/shipped-orders.csv", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    const statuses = await listDriverJobStatuses({ planId: plan.id });
    const csv = shippedDispatchCsv(plan, statuses);
    const safeDate = String(plan.planDate || "dispatch").replaceAll(/[^0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipped-orders-${safeDate || plan.id}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plans/:id", async (req, res, next) => {
  try {
    const cleanOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const plan = await saveDispatchPlanSnapshot(req.params.id, {
      orders: cleanOrders,
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : [],
      summary: req.body?.summary || {}
    });
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(plan.id),
        planId: plan.id,
        planDate: plan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: plan.orders.length,
          truckCount: plan.trucks.length
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: plan.id, planDate: plan.planDate, savedAt: plan.savedAt, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/confirm", async (req, res, next) => {
  try {
    const plan = await confirmDispatchPlan(req.params.id, { note: req.body?.note || "" });
    const operatorFlags = await applyConfirmedDispatchPlanToDelivery(plan);
    await writeDispatchAudit({
      action: "dispatch_plan_confirmed",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { status: plan.status, operatorFlags }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.confirmed", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, operatorFlags });
    res.json({ ...plan, operatorFlags });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/reopen", async (req, res, next) => {
  try {
    const plan = await reopenDispatchPlan(req.params.id, { note: req.body?.note || "" });
    await writeDispatchAudit({
      action: "dispatch_plan_reopened",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { status: plan.status }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.reopened", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    if (plan) return res.json(plan);
    const text = await fs.readFile(dispatchPlanPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text) return res.json({ savedAt: "", orders: [], trucks: [] });
    res.json(JSON.parse(text));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/setup", async (req, res, next) => {
  try {
    res.json(await readDispatchSetup());
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/setup", async (req, res, next) => {
  try {
    const payload = await writeDispatchSetup({
      drivers: Array.isArray(req.body?.drivers) ? req.body.drivers : [],
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : []
    });
    emitAppEvent("dispatch.setup.updated", { driverCount: payload.drivers.length, truckCount: payload.trucks.length });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    res.json(await listDispatchOrders({ type }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/sync", async (req, res, next) => {
  try {
    const result = await runDispatchSync({ source: "dispatch_manual" });
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    res.json({
      synced: result.synced,
      enriched: result.enriched,
      skipped: result.skipped || false,
      orders: await listDispatchOrders({ type })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/enrich", async (req, res, next) => {
  try {
    const enriched = await refreshDispatchEnrichment({ force: req.body?.force === true || req.query.force === "true" });
    emitAppEvent("dispatch.orders.updated", { source: "enrich", type: req.query.type ? String(req.query.type).toUpperCase() : null });
    res.json({ enriched, orders: await listDispatchOrders({ type: req.query.type ? String(req.query.type).toUpperCase() : null }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    res.json(await listDispatchVendorYards());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/parser-rules", async (req, res, next) => {
  try {
    res.json(await listDispatchParserRules());
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/parser-rules/:key", async (req, res, next) => {
  try {
    const updated = await updateDispatchParserRule(req.params.key, req.body?.value);
    if (!updated) return res.status(404).json({ error: "Parser rule not found" });
    emitAppEvent("dispatch.setup.updated", { parserRule: req.params.key });
    res.json({ updated });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/ollama-audit", async (req, res, next) => {
  try {
    res.json(await listOllamaAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/audit", async (req, res, next) => {
  try {
    res.json(await listDispatchAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/audit", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const written = await writeDispatchAudit({
      ...(req.body || {}),
      operatorId: operator?.id || req.body?.operatorId,
      operatorName: operator?.display_name || operator?.username || req.body?.operatorName,
      source: req.body?.source || "dispatch"
    });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/vendor-yards/:id", async (req, res, next) => {
  try {
    const updated = await updateDispatchVendorYard(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Vendor yard row not found" });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: req.params.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    const updated = await upsertDispatchVendorYard(req.body || {});
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: updated?.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/vendor-yard", async (req, res, next) => {
  try {
    const updated = await setPurchaseOrderVendorYard(req.params.id, req.body?.vendorYardId);
    await writeDispatchAudit({
      action: "po_vendor_yard_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: { vendorYardId: req.body?.vendorYardId }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, type: "PO", change: "vendor_yard", sourceSessionId: req.body?.audit?.sessionId });
    res.json({ updated, orders: await listDispatchOrders({ type: "PO" }) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/details", async (req, res, next) => {
  try {
    const updated = await updateDispatchOrderDetails(req.params.id, req.body || {});
    await writeDispatchAudit({
      action: "dispatch_info_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: {
        type: req.body?.type,
        sourceTable: req.body?.sourceTable,
        address: req.body?.address,
        expectedDeliveryDate: req.body?.expectedDeliveryDate,
        windowStart: req.body?.windowStart,
        windowEnd: req.body?.windowEnd
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, change: "details", sourceSessionId: req.body?.audit?.sessionId });
    res.json({ updated, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/co-orders", async (req, res, next) => {
  try {
    const co = await upsertLocalCoOrder({
      sourceOrderRef: req.body?.sourceOrderRef,
      fromYard: req.body?.fromYard,
      toYard: req.body?.toYard,
      order: req.body?.order || {},
      plan: {
        id: req.body?.planId,
        planDate: req.body?.planDate,
        truckPlate: req.body?.truckPlate,
        loadName: req.body?.loadName,
        parkingSpot: req.body?.parkingSpot
      },
      requestedBy: req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "co_saved_to_local_db",
      entityType: "order",
      entityId: co.co_ref,
      orderId: co.co_ref,
      sessionId: req.body?.audit?.sessionId,
      after: co,
      details: { sourceOrderRef: co.source_order_ref, fromYard: co.from_location, toYard: co.to_location }
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: co.co_ref, sourceOrderRef: co.source_order_ref, sourceSessionId: req.body?.audit?.sessionId });
    res.json({ co, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/co-orders/:coRef", async (req, res, next) => {
  try {
    const cancelled = await cancelLocalCoOrder(req.params.coRef, { requestedBy: req.query.sessionId || "" });
    if (!cancelled) return res.status(409).json({ error: "CO cannot be cancelled after it is received or loaded." });
    await writeDispatchAudit({
      action: "co_cancelled_in_local_db",
      entityType: "order",
      entityId: req.params.coRef,
      orderId: req.params.coRef,
      sessionId: req.query.sessionId,
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: req.params.coRef, cancelled: true, sourceSessionId: req.query.sessionId });
    res.json({ cancelled, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/operator-requests", async (req, res, next) => {
  try {
    const written = await createDispatchOperatorRequest({
      requestType: req.body?.requestType,
      orderRef: req.body?.orderRef,
      sourceOrderType: req.body?.sourceOrderType,
      requestedBy: req.body?.requestedBy || req.body?.audit?.sessionId || "",
      details: req.body?.details || {}
    });
    await writeDispatchAudit({
      action: "operator_request_created",
      entityType: "operator_request",
      entityId: String(written.id),
      orderId: written.order_ref,
      sessionId: req.body?.audit?.sessionId,
      after: written,
      details: { requestType: written.request_type, orderRef: written.order_ref }
    }).catch(() => null);
    emitAppEvent("dispatch.operator_request.created", { requestId: written.id, requestType: written.request_type, orderRef: written.order_ref, sourceSessionId: req.body?.audit?.sessionId });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plan", async (req, res, next) => {
  try {
    const cleanOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const payload = {
      savedAt: new Date().toISOString(),
      orders: cleanOrders,
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : []
    };
    const planDate = req.body?.planDate || req.body?.date || new Date().toISOString().slice(0, 10);
    let plan = req.body?.planId ? await getDispatchPlan(req.body.planId) : await getCurrentDispatchPlan({ planDate });
    if (!plan) plan = await createDispatchPlan({ planDate });
    const savedPlan = await saveDispatchPlanSnapshot(plan.id, {
      orders: payload.orders,
      trucks: payload.trucks,
      summary: req.body?.summary || {}
    });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dispatchPlanPath, JSON.stringify(payload, null, 2));
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(savedPlan.id),
        planId: savedPlan.id,
        planDate: savedPlan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: payload.orders.length,
          truckCount: payload.trucks.length
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: savedPlan.id, planDate: savedPlan.planDate, savedAt: savedPlan.savedAt, sourceSessionId: req.body?.audit?.sessionId });
    res.json(savedPlan);
  } catch (error) {
    next(error);
  }
});

app.get("/delivery", (req, res) => {
  res.redirect("/operator");
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(publicDir, "driver.html"));
});

app.get("/control", (req, res) => {
  res.sendFile(path.join(publicDir, "control.html"));
});

app.get("/dispatch", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-menu.html"));
});

app.get("/dispatch/planning", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch.html"));
});

app.get("/dispatch/setup", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-setup.html"));
});

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>MBBS Yard Server</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; line-height: 1.5; color: #111; }
          button, input { font: inherit; }
          button { min-height: 42px; padding: 0 14px; margin: 4px; font-weight: 700; cursor: pointer; }
          input { min-height: 38px; padding: 0 10px; min-width: 180px; }
          code, a { font-size: 16px; }
          li { margin: 8px 0; }
          .panel { border: 1px solid #bbb; border-radius: 8px; padding: 16px; margin: 16px 0; }
          .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
          pre { background: #f5f5f5; border: 1px solid #ddd; border-radius: 8px; padding: 14px; max-height: 420px; overflow: auto; }
        </style>
      </head>
      <body>
        <h1>MBBS Yard Server</h1>
        <p>The local delivery API server is running.</p>
        <div class="panel">
          <h2>Connection</h2>
          <div class="row">
            <button onclick="callApi('GET', '/health')">Test health</button>
            <button onclick="location.href='/api/auth/netsuite/start'">Connect NetSuite</button>
            <button onclick="location.href='/control'">Open control panel</button>
          </div>
        </div>
        <div class="panel">
          <h2>Delivery Test</h2>
          <div class="row">
            <button onclick="callApi('POST', '/api/delivery/sync')">Sync order list from NetSuite</button>
            <button onclick="callApi('GET', '/api/delivery/orders')">Show local order list</button>
            <button onclick="location.href='/operator'">Open tablet operator app</button>
          </div>
          <div class="row">
            <input id="orderId" placeholder="NetSuite order ID" />
            <button onclick="syncDetails()">Sync details by ID</button>
            <button onclick="showDetails()">Show details by ID</button>
          </div>
        </div>
        <pre id="output">Ready.</pre>
        <script>
          const output = document.getElementById("output");
          const orderId = document.getElementById("orderId");

          function print(value) {
            output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          }

          async function callApi(method, url) {
            print(method + " " + url + " ...");
            try {
              const response = await fetch(url, { method, headers: { "Content-Type": "application/json" } });
              const text = await response.text();
              const data = text ? JSON.parse(text) : {};
              print(data);
              if (Array.isArray(data) && data[0]?.netsuite_id) orderId.value = data[0].netsuite_id;
            } catch (error) {
              print(error.message);
            }
          }

          function syncDetails() {
            if (!orderId.value.trim()) return print("Enter a NetSuite order ID first.");
            callApi("POST", "/api/delivery/orders/" + encodeURIComponent(orderId.value.trim()) + "/sync");
          }

          function showDetails() {
            if (!orderId.value.trim()) return print("Enter a NetSuite order ID first.");
            callApi("GET", "/api/delivery/orders/" + encodeURIComponent(orderId.value.trim()));
          }
        </script>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "MBBS Yard Server" });
});

app.get("/api/auth/bootstrap-needed", async (req, res, next) => {
  try {
    res.json({ needed: !(await hasOperators()) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/bootstrap", async (req, res, next) => {
  try {
    if (await hasOperators()) return res.status(409).json({ error: "Operator accounts already exist." });
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: "admin"
    });
    await writeAudit({
      actorType: "system",
      source: "control",
      action: "operator.bootstrap_admin",
      actorOperatorId: operator.id,
      details: { username: operator.username }
    });
    res.json({ operator });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const result = await loginOperator(req.body?.username, req.body?.password);
    await writeAudit({
      actorOperatorId: result.operator.id,
      source: "auth",
      action: "operator.login"
    });
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get("/api/auth/me", requireOperator, (req, res) => {
  res.json({ operator: req.operator });
});

app.post("/api/auth/logout", requireOperator, async (req, res, next) => {
  try {
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "auth",
      action: "operator.logout"
    });
    await logoutToken(bearerToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/login", async (req, res, next) => {
  try {
    const login = String(req.body?.username || req.body?.login || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === login);
    if (!driver) return res.status(401).json({ error: "Invalid driver login." });
    if (driver.password && String(driver.password) !== password) return res.status(401).json({ error: "Invalid driver login." });
    if (!driver.password && password) return res.status(401).json({ error: "Password is not set for this driver. Leave password blank or update it in Dispatch Setup." });
    const token = crypto.randomBytes(32).toString("base64url");
    driverSessions.set(token, { login, createdAt: new Date().toISOString() });
    res.json({ token, driver: publicDriver(driver) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/me", requireDriver, (req, res) => {
  res.json({ driver: publicDriver(req.driver) });
});

app.post("/api/driver/logout", requireDriver, (req, res) => {
  driverSessions.delete(driverToken(req));
  res.json({ ok: true });
});

app.get("/api/dispatch/driver-job-statuses", async (req, res, next) => {
  try {
    res.json(await listDriverJobStatuses({
      planId: req.query.planId || null,
      planDate: req.query.planDate || null
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/next-job", requireDriver, async (req, res, next) => {
  try {
    res.json({ job: await getNextDriverJob(req.driverLogin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/start", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    const record = await startDriverJob(req.driverLogin, req.params.jobId, { job });
    emitAppEvent("driver.job.started", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, orderRefs: job.orderRefs || [] });
    res.json({ record, job: await getNextDriverJob(req.driverLogin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/photos", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    const record = await recordDriverJobPhotos(req.driverLogin, req.params.jobId, {
      photoDataUrls: req.body?.photoDataUrls,
      job
    });
    const nextJob = await getNextDriverJob(req.driverLogin);
    emitAppEvent("driver.job.completed", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, nextJobId: nextJob?.jobId || null });
    res.json({ record, nextJob });
  } catch (error) {
    next(error);
  }
});

app.get("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listOperators());
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: req.body?.role || "operator"
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.create",
      details: { operatorId: operator.id, username: operator.username, role: operator.role }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/active", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.set_active",
      details: { operatorId: req.params.id, active: Boolean(req.body?.active) }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/password", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await updateOperatorPassword(req.params.id, req.body?.password);
    if (!operator) return res.status(404).json({ error: "Operator not found" });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.password_reset",
      details: { operatorId: req.params.id, username: operator.username }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const setup = await readDispatchSetup();
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const mode = req.body?.mode === "auto" ? "auto" : "manual";
    const setup = await writeDispatchSetup({ sync: { mode } });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "sync.mode_update",
      details: { mode }
    });
    emitAppEvent("dispatch.sync.settings.updated", { mode });
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-now", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const result = await runDispatchSync({ source: "control_manual", actorOperatorId: req.operator.id });
    res.json({
      ...result,
      settings: (await readDispatchSetup()).sync
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/audit", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listAudit({
      limit: req.query.limit,
      orderId: req.query.orderId,
      operatorId: req.query.operatorId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/fulfillments", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listDeliveryFulfillments({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/history", requireOperator, async (req, res, next) => {
  try {
    res.json(await listOperatorHistory({
      operatorId: req.operator.id,
      date: req.query.date || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/requests", requireOperator, async (req, res, next) => {
  try {
    res.json(await listDispatchOperatorRequests({
      status: req.query.status || "open",
      locationId: req.query.locationId || null,
      orderType: req.query.orderType || null
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/operator/history/report-error", requireOperator, async (req, res, next) => {
  try {
    res.json(await reportOperatorRecordError({
      operatorId: req.operator.id,
      recordId: req.body?.recordId,
      reason: req.body?.reason
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/record-warnings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listRecordWarnings({
      status: req.query.status || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/record-warnings/:id/resolve", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await resolveRecordWarning({
      warningId: req.params.id,
      handledBy: req.operator.id,
      resolution: req.body?.resolution
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/start", (req, res, next) => {
  try {
    const { url } = buildAuthorizationUrl();
    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`NetSuite authorization failed: ${req.query.error}`);
    }
    await exchangeCodeForToken(req.query.code);
    res.send("NetSuite connected. You can close this tab and return to the yard app.");
  } catch (error) {
    next(error);
  }
});

app.use("/api/delivery", requireOperator);
app.use("/api/receiving", requireOperator);
app.use("/api/inventory", requireOperator);
app.use("/api/cycle-count", requireOperator);

app.post("/api/delivery/sync", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId || req.query.locationId || 1);
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const synced = await syncDeliveryLocation(locationId, { orderType });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.manual_sync",
      details: { locationId, orderType, synced }
    });
    res.json({ synced });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/sync", async (req, res, next) => {
  try {
    const locationId = req.body?.locationId || req.query.locationId;
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const order = orderType === "transfer_order"
      ? await fetchTransferDeliveryOrderFromNetSuite(req.params.id, locationId)
      : await fetchDeliveryOrderFromNetSuite(req.params.id, locationId);
    if (order) await upsertDeliveryOrders([order]);
    else await markDeliveryOrderMissing(req.params.id);
    const lines = orderType === "transfer_order"
      ? await fetchTransferOrderDetailsFromNetSuite(req.params.id, locationId)
      : await fetchDeliveryOrderDetailsFromNetSuite(req.params.id, locationId);
    await upsertDeliveryOrderLines(req.params.id, lines);
    await markMissingDeliveryOrderLines(req.params.id, lines.map((line) => line.line_id));
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.manual_order_sync",
      orderId: req.params.id,
      details: { locationId, orderType, order: Boolean(order), lines: lines.length }
    });
    res.json({ order: Boolean(order), synced: lines.length });
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders", async (req, res, next) => {
  try {
    res.json(await listDeliveryOrders({
      locationId: req.query.locationId,
      status: req.query.status,
      orderType: normalizeOrderType(req.query.orderType)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders/:id", async (req, res, next) => {
  try {
    const order = await getDeliveryOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Delivery order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/sync", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order") {
      await writeAudit({
        actorOperatorId: req.operator.id,
        source: "receiving",
        action: "operator.local_co_refresh",
        details: { locationId: req.body?.destinationLocationId || req.body?.locationId || null }
      });
      return res.json({ synced: { localCo: true } });
    }
    const orderType = req.body?.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    const synced = orderType === "transfer_order"
      ? await syncTransferReceiving({
          sourceLocationId: req.body?.sourceLocationId || null,
          destinationLocationId: req.body?.destinationLocationId || req.body?.locationId || null
        })
      : await syncPurchaseReceiving({ locationId: req.body?.destinationLocationId || req.body?.locationId || 1 });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_sync",
      details: { orderType, synced }
    });
    res.json({ synced });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/vendors", async (req, res, next) => {
  try {
    res.json(await listReceivingVendors({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/sources", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
    }
    res.json(await listReceivingSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoReceivingOrders({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || null,
        itemSearch: req.query.itemSearch || null
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await listReceivingOrders({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || null,
      itemSearch: req.query.itemSearch || null
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/items", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await searchLocalCoItems({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || ""
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await searchReceivingItems({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/sync", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || req.query.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      return res.json({ synced: { order: true, orderType: "co_order", lines: 0 } });
    }
    const synced = await syncReceivingOrderDetails(req.params.id, {
      orderType: req.body?.orderType || req.query.orderType || null,
      locationId: req.body?.locationId || req.query.locationId || req.body?.destinationLocationId || req.query.destinationLocationId || null,
      sourceLocationId: req.body?.sourceLocationId || req.query.sourceLocationId || null
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_order_sync",
      details: { receivingOrderId: req.params.id, synced }
    });
    res.json({ synced });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders/:id", async (req, res, next) => {
  try {
    if (String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const localOrder = await getLocalCoReceivingOrder(req.params.id);
      if (!localOrder) return res.status(404).json({ error: "Local CO not found" });
      return res.json(localOrder);
    }
    const order = await getReceivingOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Receiving order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const result = await confirmLocalCoReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
      emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: "co_order", operatorId: operatorId(req) });
      return res.json(result);
    }
    const result = await confirmReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: req.body?.orderType || null, operatorId: operatorId(req) });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/receive", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const result = await receiveLocalCoOrder(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: "co_order", operatorId: operatorId(req) });
      return res.json({ jobId: null, status: "complete", result });
    }
    const jobId = crypto.randomUUID();
    receivingJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Receiving request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runReceivingReceipt(req.params.id, req.body || {}, operatorId(req), jobId);
      updateReceivingJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemReceiptTranid ? `Created ${result.itemReceiptTranid}.` : "Item Receipt created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: req.body?.orderType || null, operatorId: operatorId(req), jobId, itemReceiptTranid: result.itemReceiptTranid || null });
    }).catch(async (error) => {
      const job = receivingJobs.get(jobId);
      await recordReceivingReceiptFailure(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateReceivingJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.receive_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/receipt-jobs/:jobId", async (req, res, next) => {
  try {
    const job = receivingJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Receiving job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/prepared", async (req, res, next) => {
  try {
    await markDeliveryPrepared(req.params.id, req.body || {});
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, change: "prepared" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/status", async (req, res, next) => {
  try {
    await updateDeliveryStatus(req.params.id, req.body?.status, operatorId(req));
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, status: req.body?.status, operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/packed-quantity", async (req, res, next) => {
  try {
    await setDeliveryLinePackedQuantity(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.updated", { orderId: req.params.id, lineId: req.params.lineId, change: "packed_quantity", operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryOrder(req.params.id, operatorId(req));
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/fulfill", async (req, res, next) => {
  try {
    const jobId = crypto.randomUUID();
    fulfillmentJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Fulfillment request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runDeliveryFulfillment(req.params.id, req.body || {}, operatorId(req), jobId);
      updateFulfillmentJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemFulfillmentTranid ? `Created ${result.itemFulfillmentTranid}.` : "Item Fulfillment created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfilled", { orderId: req.params.id, operatorId: operatorId(req), jobId, itemFulfillmentTranid: result.itemFulfillmentTranid || null });
    }).catch(async (error) => {
      const job = fulfillmentJobs.get(jobId);
      await recordDeliveryFulfillmentFailure(req.params.id, operatorId(req), {
        photoDataUrl: req.body?.photoDataUrl,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateFulfillmentJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfill_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/load", async (req, res, next) => {
  try {
    const result = await recordDeliveryLoad(req.params.id, operatorId(req), {
      photoDataUrl: req.body?.photoDataUrl
    });
    emitAppEvent("delivery.order.loaded", { orderId: req.params.id, operatorId: operatorId(req), resultId: result?.id || null });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/fulfillment-jobs/:jobId", async (req, res, next) => {
  try {
    const job = fulfillmentJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Fulfillment job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

async function runReceivingReceipt(orderId, body, currentOperatorId, jobId) {
  updateReceivingJob(jobId, { stage: "sync", message: "Checking latest received quantity from NetSuite." });
  await syncReceivingOrderDetails(orderId, {
    orderType: body?.orderType || null,
    locationId: body?.locationId || body?.destinationLocationId || null,
    sourceLocationId: body?.sourceLocationId || null
  });
  updateReceivingJob(jobId, { stage: "validating", message: "Checking confirmed receiving lines." });
  const order = await getReceivableReceivingOrder(orderId);
  updateReceivingJob(jobId, {
    stage: "payload",
    message: `Building item receipt for ${order.receivableLines.length} confirmed line(s).`
  });
  const payload = buildItemReceiptPayload(order, order.receivableLines);
  updateReceivingJob(jobId, {
    stage: "netsuite_post",
    message: "Posting Item Receipt to NetSuite.",
    payload,
    payloadSummary: {
      receiveLines: payload.item.items.filter((item) => item.itemReceive !== false).length,
      skipLines: payload.item.items.filter((item) => item.itemReceive === false).length
    }
  });
  const netSuiteResult = order.order_type === "transfer_order"
    ? await transformTransferOrderToItemReceipt(orderId, payload)
    : await transformPurchaseOrderToItemReceipt(orderId, payload);
  updateReceivingJob(jobId, {
    stage: "netsuite_read",
    message: "Reading IR number from NetSuite.",
    itemReceiptId: netSuiteResult.id
  });
  const receipt = netSuiteResult.id ? await fetchItemReceiptFromNetSuite(netSuiteResult.id) : null;
  const itemReceiptTranid = receipt?.tranId || receipt?.tranid || receipt?.id || null;
  updateReceivingJob(jobId, {
    stage: "recording",
    message: itemReceiptTranid ? `Recording ${itemReceiptTranid} locally.` : "Recording item receipt locally.",
    itemReceiptId: netSuiteResult.id,
    itemReceiptTranid
  });
  const record = await recordReceivingReceipt(orderId, currentOperatorId, {
    photoDataUrls: body?.photoDataUrls,
    payload,
    response: { netSuiteResult, receipt },
    itemReceiptId: netSuiteResult.id,
    itemReceiptTranid
  });
  updateReceivingJob(jobId, {
    stage: "sync_deferred",
    message: "Receipt recorded. Order sync is continuing in background.",
    itemReceiptId: record.itemReceiptId,
    itemReceiptTranid: record.itemReceiptTranid
  });
  Promise.resolve().then(async () => {
    await syncReceivingOrderDetails(orderId, {
      orderType: order.order_type,
      locationId: order.destination_location_id,
      sourceLocationId: order.source_location_id
    });
  }).catch((error) => {
    console.error("Receiving follow-up sync failed:", error.message);
  });
  return record;
}

async function runDeliveryFulfillment(orderId, body, currentOperatorId, jobId) {
    updateFulfillmentJob(jobId, { stage: "validating", message: "Checking packed lines." });
    let order;
    try {
      order = await getFulfillableDeliveryOrder(orderId);
    } catch (error) {
      if (!String(error.message).includes("No packed lines to fulfill.")) throw error;
      updateFulfillmentJob(jobId, {
        stage: "netsuite_check",
        message: "No local pack delta. Checking whether previous NetSuite IF still exists."
      });
      const currentOrder = await getDeliveryOrder(orderId);
      if (!currentOrder?.last_item_fulfillment_id) throw error;
      const existingFulfillment = await fetchItemFulfillmentFromNetSuite(currentOrder.last_item_fulfillment_id);
      if (existingFulfillment) {
        throw new Error(`Already fulfilled by ${existingFulfillment.tranId || existingFulfillment.tranid || currentOrder.last_item_fulfillment_tranid || currentOrder.last_item_fulfillment_id}.`);
      }
      updateFulfillmentJob(jobId, {
        stage: "resetting",
        message: "Previous IF is missing in NetSuite. Resetting local fulfilled qty for resend."
      });
      await resetDeliveryFulfillmentState(orderId, currentOperatorId, "netsuite_if_missing_before_resend");
      order = await getFulfillableDeliveryOrder(orderId);
    }
    updateFulfillmentJob(jobId, {
      stage: "payload",
      message: `Building payload for ${order.fulfillableLines.length} packed line(s).`
    });
    const payload = buildItemFulfillmentPayload(order, order.fulfillableLines);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_post",
      message: "Posting Item Fulfillment to NetSuite.",
      payload,
      payloadSummary: {
        receiveLines: payload.item.items.filter((item) => item.itemReceive !== false && item.itemreceive !== false).length,
        skipLines: payload.item.items.filter((item) => item.itemReceive === false || item.itemreceive === false).length
      }
    });
    const netSuiteResult = order.order_type === "transfer_order"
      ? await transformTransferOrderToItemFulfillment(orderId, payload)
      : await transformSalesOrderToItemFulfillment(orderId, payload);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_read",
      message: "Reading IF number from NetSuite.",
      itemFulfillmentId: netSuiteResult.id
    });
    const fulfillment = netSuiteResult.id ? await fetchItemFulfillmentFromNetSuite(netSuiteResult.id) : null;
    const itemFulfillmentTranid = fulfillment?.tranId || fulfillment?.tranid || fulfillment?.id || null;
    updateFulfillmentJob(jobId, {
      stage: "recording",
      message: itemFulfillmentTranid ? `Recording ${itemFulfillmentTranid} locally.` : "Recording fulfillment locally.",
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const record = await recordDeliveryFulfillment(orderId, currentOperatorId, {
      photoDataUrl: body?.photoDataUrl,
      payload,
      response: { netSuiteResult, fulfillment },
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const locationId = order.outbound_location_id || body?.locationId;
    updateFulfillmentJob(jobId, {
      stage: "sync_deferred",
      message: "Fulfillment recorded. Order sync is continuing in background.",
      itemFulfillmentId: record.itemFulfillmentId,
      itemFulfillmentTranid: record.itemFulfillmentTranid
    });
    Promise.resolve().then(async () => {
      const syncedOrder = order.order_type === "transfer_order"
        ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
      if (syncedOrder) await upsertDeliveryOrders([syncedOrder]);
      else await markDeliveryOrderMissing(orderId);
      const syncedLines = order.order_type === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      await upsertDeliveryOrderLines(orderId, syncedLines);
      await markMissingDeliveryOrderLines(orderId, syncedLines.map((line) => line.line_id));
    }).catch((error) => {
      console.error("Delivery fulfillment follow-up sync failed:", error.message);
    });
    return record;
}

app.post("/api/inventory/sync", async (req, res, next) => {
  try {
    const locationIds = req.body?.locationIds || deliveryLocations;
    const rows = await fetchInventoryBalancesFromNetSuite(locationIds);
    const synced = await upsertInventoryBalances(rows);
    const classified = await applyInventoryClassificationRules();
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "inventory",
      action: "inventory.manual_sync",
      details: { locationIds, rows: rows.length, synced, classified }
    });
    res.json({ synced, classified });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/facets", async (req, res, next) => {
  try {
    res.json(await listInventoryFacets({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/items", async (req, res, next) => {
  try {
    res.json(await listInventoryItems({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand,
      series: req.query.series,
      search: req.query.search
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/classifications", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listInventoryClassifications({
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/inventory/classifications/:itemId", requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateInventoryClassification(req.operator.id, req.params.itemId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/draft", async (req, res, next) => {
  try {
    res.json(await getCycleCountDraft(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/records", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listCycleCountRecords({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/lines", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId);
    const itemId = Number(req.body?.itemId);
    if (Number.isInteger(locationId) && locationId > 0 && Number.isInteger(itemId) && itemId > 0) {
      const syncPromise = fetchInventoryBalanceForItemFromNetSuite(itemId, locationId)
        .then(async (rows) => {
          const synced = await upsertInventoryBalances(rows);
          const classified = await applyInventoryClassificationRules();
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync",
            details: { itemId, locationId, rows: rows.length, synced, classified, mode: "before_confirm" }
          });
          return rows;
        })
        .catch(async (error) => {
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync_failed",
            details: { itemId, locationId, error: error.message }
          });
          return [];
        });
      const syncResult = await withTimeout(syncPromise, 2500);
      if (syncResult.timedOut) {
        syncPromise.catch(() => {});
        await writeAudit({
          actorOperatorId: req.operator.id,
          source: "cycle_count",
          action: "cycle_count.confirm_line_inventory_sync_deferred",
          details: { itemId, locationId, timeoutMs: 2500 }
        });
      }
    }
    res.json(await confirmCycleCountLine(req.operator.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/submit", async (req, res, next) => {
  try {
    res.json(await submitCycleCount(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

app.listen(config.port, () => {
  console.log(`MBBS Yard Server listening on ${config.appBaseUrl}`);
  autoSyncTick();
  setInterval(autoSyncTick, 60000);
});
