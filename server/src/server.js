import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchTransferDeliveryOrdersFromNetSuite, fetchTransferDeliveryOrderFromNetSuite, fetchTransferOrderDetailsFromNetSuite, fetchPurchaseOrdersFromNetSuite, fetchPurchaseOrderFromNetSuite, fetchPurchaseOrderDetailsFromNetSuite, fetchTransferReceivingOrdersFromNetSuite, fetchTransferReceivingOrderFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt } from "./netsuite.js";
import { upsertDeliveryOrders, upsertDeliveryOrderLines, markMissingDeliveryOrderLines, listExistingDeliveryOrderIds, markDeliveryOrderMissing, listDeliveryOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, listDeliveryFulfillments, resetDeliveryFulfillmentState } from "./delivery-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listOperators, loginOperator, logoutToken, setOperatorActive, updateOperatorPassword, writeAudit } from "./auth-repository.js";
import { confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";
import { upsertReceivingOrders, upsertReceivingOrderLines, markMissingReceivingOrders, markMissingReceivingOrderLines, listExistingReceivingOrderIds, listReceivingVendors, listReceivingSources, listReceivingOrders, getReceivingOrder, searchReceivingItems, confirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt, recordReceivingReceiptFailure, listReceivingReceipts } from "./receiving-repository.js";
import { listOperatorHistory, listRecordWarnings, reportOperatorRecordError, resolveRecordWarning } from "./history-repository.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const deliveryLocations = [1, 13, 15];
const fulfillmentJobs = new Map();
const receivingJobs = new Map();

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
async function syncAllDeliveryLocations() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    for (const locationId of deliveryLocations) {
      await syncDeliveryLocation(locationId, { orderType: "sales_order" });
      await syncDeliveryLocation(locationId, { orderType: "transfer_order" });
    }
  } catch (error) {
    console.error("Delivery auto-sync failed:", error.message);
  } finally {
    syncRunning = false;
  }
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
app.use(express.static(publicDir));

app.get("/api/dispatch/config", (req, res) => {
  res.json({
    googleMapsApiKey: config.googleMapsApiKey
  });
});

app.get("/delivery", (req, res) => {
  res.redirect("/operator");
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/control", (req, res) => {
  res.sendFile(path.join(publicDir, "control.html"));
});

app.get("/dispatch", (req, res) => {
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
    res.json(await listReceivingSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders", async (req, res, next) => {
  try {
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
    const order = await getReceivingOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Receiving order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    res.json(await confirmReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/receive", async (req, res, next) => {
  try {
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
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/status", async (req, res, next) => {
  try {
    await updateDeliveryStatus(req.params.id, req.body?.status, operatorId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/packed-quantity", async (req, res, next) => {
  try {
    await setDeliveryLinePackedQuantity(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryOrder(req.params.id, operatorId(req));
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
    });
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
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "inventory",
      action: "inventory.manual_sync",
      details: { locationIds, rows: rows.length, synced }
    });
    res.json({ synced });
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
          await upsertInventoryBalances(rows);
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync",
            details: { itemId, locationId, rows: rows.length, mode: "before_confirm" }
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
  syncAllDeliveryLocations();
  setInterval(syncAllDeliveryLocations, 60000);
});
