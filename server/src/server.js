import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchItemFulfillmentFromNetSuite, transformSalesOrderToItemFulfillment } from "./netsuite.js";
import { upsertDeliveryOrders, upsertDeliveryOrderLines, markMissingDeliveryOrderLines, listExistingDeliveryOrderIds, markDeliveryOrderMissing, listDeliveryOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, listDeliveryFulfillments, resetDeliveryFulfillmentState } from "./delivery-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listOperators, loginOperator, logoutToken, setOperatorActive, updateOperatorPassword, writeAudit } from "./auth-repository.js";
import { confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const deliveryLocations = [1, 13];
const fulfillmentJobs = new Map();

function updateFulfillmentJob(jobId, patch) {
  const current = fulfillmentJobs.get(jobId) || { id: jobId };
  fulfillmentJobs.set(jobId, {
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

async function syncDeliveryLocation(locationId, { includeDetails = true } = {}) {
  const discoveredOrders = await fetchDeliveryOrdersFromNetSuite(locationId);
  await upsertDeliveryOrders(discoveredOrders);

  const existingIds = await listExistingDeliveryOrderIds({ locationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];

  let orderCount = discoveredOrders.length;
  let detailCount = 0;
  let missingCount = 0;
  for (const orderId of orderIds) {
    const trackedOrder = await fetchDeliveryOrderFromNetSuite(orderId, locationId);
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
      const lines = await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      await upsertDeliveryOrderLines(orderId, lines);
      await markMissingDeliveryOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.delivery.sync",
    details: { locationId, discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount }
  });

  return { discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount };
}

let syncRunning = false;
async function syncAllDeliveryLocations() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    for (const locationId of deliveryLocations) {
      await syncDeliveryLocation(locationId);
    }
  } catch (error) {
    console.error("Delivery auto-sync failed:", error.message);
  } finally {
    syncRunning = false;
  }
}

app.use(express.json({ limit: "25mb" }));
app.use(express.static(publicDir));

app.get("/delivery", (req, res) => {
  res.redirect("/operator");
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/control", (req, res) => {
  res.sendFile(path.join(publicDir, "control.html"));
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
app.use("/api/inventory", requireOperator);
app.use("/api/cycle-count", requireOperator);

app.post("/api/delivery/sync", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId || req.query.locationId || 1);
    const synced = await syncDeliveryLocation(locationId);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.manual_sync",
      details: { locationId, synced }
    });
    res.json({ synced });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/sync", async (req, res, next) => {
  try {
    const locationId = req.body?.locationId || req.query.locationId;
    const order = await fetchDeliveryOrderFromNetSuite(req.params.id, locationId);
    if (order) await upsertDeliveryOrders([order]);
    else await markDeliveryOrderMissing(req.params.id);
    const lines = await fetchDeliveryOrderDetailsFromNetSuite(req.params.id, locationId);
    await upsertDeliveryOrderLines(req.params.id, lines);
    await markMissingDeliveryOrderLines(req.params.id, lines.map((line) => line.line_id));
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.manual_order_sync",
      orderId: req.params.id,
      details: { locationId, order: Boolean(order), lines: lines.length }
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
      status: req.query.status
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
        receiveLines: payload.item.items.filter((item) => item.itemreceive !== false).length,
        skipLines: payload.item.items.filter((item) => item.itemreceive === false).length
      }
    });
    const netSuiteResult = await transformSalesOrderToItemFulfillment(orderId, payload);
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
      const syncedOrder = await fetchDeliveryOrderFromNetSuite(orderId, locationId);
      if (syncedOrder) await upsertDeliveryOrders([syncedOrder]);
      else await markDeliveryOrderMissing(orderId);
      const syncedLines = await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
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
