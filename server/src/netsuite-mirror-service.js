import crypto from "node:crypto";
import { config } from "./config.js";
import { withTransaction } from "./db.js";
import { upsertInventoryBalances } from "./inventory-repository.js";
import {
  markMissingInboundOrderLines,
  markMissingOutboundOrderLines,
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders,
  upsertPurchaseOrderLines,
  upsertPurchaseOrders,
  upsertSalesOrderLines,
  upsertSalesOrders
} from "./order-sync-repository.js";
import {
  acceptNetSuiteMirrorEvents,
  getNetSuiteMirrorCursor,
  getNetSuiteMirrorInventorySnapshot,
  getNetSuiteMirrorOrderSnapshot,
  getNextNetSuiteMirrorInboxEvent,
  isNetSuiteMirrorConsumer,
  initializeNetSuiteMirrorCursor,
  isNetSuiteMirrorSource,
  listNetSuiteMirrorEvents,
  listPendingNetSuiteMirrorEvents,
  markMirroredOrderInactive,
  markNetSuiteMirrorEventsDelivered,
  markNetSuiteMirrorEventsFailed,
  markNetSuiteMirrorInboxApplied,
  markNetSuiteMirrorInboxFailed,
  markNetSuiteMirrorReconciled,
  recordNetSuiteMirrorSourceHighWater,
  pruneNetSuiteMirrorEvents
} from "./netsuite-mirror-repository.js";

let sourceRelayRunning = false;
let consumerTickRunning = false;
let consumerReconcileRunning = false;
let lastPrunedAt = 0;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signaturePayload({ timestamp, method, path, bodyText }) {
  return [String(timestamp), String(method || "GET").toUpperCase(), path, sha256(bodyText || "")].join(".");
}

export function createNetSuiteMirrorSignature({
  secret,
  timestamp,
  method = "GET",
  path,
  bodyText = ""
}) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(signaturePayload({ timestamp, method, path, bodyText }))
    .digest("hex");
}

export function verifyNetSuiteMirrorRequest(req) {
  const secret = String(config.netSuiteMirror?.sharedSecret || "");
  if (!secret) return { ok: false, status: 503, error: "NetSuite mirror shared secret is not configured." };
  const timestamp = String(req.get("x-mbbs-mirror-timestamp") || "");
  const provided = String(req.get("x-mbbs-mirror-signature") || "");
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return { ok: false, status: 401, error: "Invalid mirror timestamp." };
  const maxAgeMs = Number(config.netSuiteMirror?.signatureMaxAgeSeconds || 300) * 1000;
  if (Math.abs(Date.now() - timestampMs) > maxAgeMs) {
    return { ok: false, status: 401, error: "Expired mirror request." };
  }
  const bodyText = ["GET", "HEAD"].includes(req.method)
    ? ""
    : typeof req.rawBody === "string"
      ? req.rawBody
      : JSON.stringify(req.body || {});
  const expected = createNetSuiteMirrorSignature({
    secret,
    timestamp,
    method: req.method,
    path: req.originalUrl,
    bodyText
  });
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, status: 401, error: "Invalid mirror signature." };
  }
  return { ok: true };
}

export function requireNetSuiteMirrorSignature(req, res, next) {
  const verified = verifyNetSuiteMirrorRequest(req);
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });
  return next();
}

async function signedMirrorFetch(baseUrl, path, { method = "GET", body = null } = {}) {
  if (!baseUrl) throw new Error("NetSuite mirror peer URL is not configured.");
  const secret = String(config.netSuiteMirror?.sharedSecret || "");
  if (!secret) throw new Error("NetSuite mirror shared secret is not configured.");
  const bodyText = body === null ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createNetSuiteMirrorSignature({ secret, timestamp, method, path, bodyText });
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-mbbs-mirror-timestamp": timestamp,
      "x-mbbs-mirror-signature": signature,
      ...(body !== null ? { "content-type": "application/json" } : {})
    },
    ...(body !== null ? { body: bodyText } : {}),
    signal: AbortSignal.timeout
      ? AbortSignal.timeout(Number(config.netSuiteMirror?.requestTimeoutMs || 15000))
      : undefined
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(payload.error || `Mirror peer request failed: ${response.status} ${response.statusText}`);
  }
  return payload;
}

export async function relayPendingNetSuiteMirrorEvents() {
  if (!isNetSuiteMirrorSource() || sourceRelayRunning) return { skipped: true };
  sourceRelayRunning = true;
  try {
    const events = await listPendingNetSuiteMirrorEvents(config.netSuiteMirror?.pageSize || 100);
    if (!events.length) return { relayed: 0 };
    try {
      await signedMirrorFetch(
        config.netSuiteMirror.consumerBaseUrl,
        "/api/internal/netsuite-sync/events",
        { method: "POST", body: { contract: "netsuite-mirror/v1", events } }
      );
      await markNetSuiteMirrorEventsDelivered(events.map((event) => event.eventUuid));
      return { relayed: events.length };
    } catch (error) {
      await markNetSuiteMirrorEventsFailed(events.map((event) => event.eventUuid), error.message);
      throw error;
    }
  } finally {
    sourceRelayRunning = false;
  }
}

async function fetchSourceOrderSnapshot(entityType, entityId) {
  return signedMirrorFetch(
    config.netSuiteMirror.sourceBaseUrl,
    `/api/internal/netsuite-sync/orders/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`
  );
}

async function applyOrderSnapshot(snapshot, fallbackEntityType, fallbackEntityId) {
  const entityType = snapshot?.entityType || fallbackEntityType;
  const header = snapshot?.header;
  if (!header || header.netsuite_active === false) {
    await markMirroredOrderInactive(entityType, fallbackEntityId);
    return;
  }

  if (entityType === "sales_order") {
    const lines = snapshot.stages?.outbound || [];
    await upsertSalesOrders([header]);
    await upsertSalesOrderLines(header.id, lines);
    await markMissingOutboundOrderLines(header.id, lines.map((line) => line.line_id));
    return;
  }

  if (entityType === "purchase_order") {
    const lines = snapshot.stages?.receiving || [];
    await upsertPurchaseOrders([header]);
    await upsertPurchaseOrderLines(header.id, lines);
    await markMissingInboundOrderLines(header.id, lines.map((line) => line.line_id));
    return;
  }

  if (entityType === "transfer_order") {
    if (header.has_outbound) {
      const outbound = snapshot.stages?.outbound || [];
      await upsertOutboundTransferOrders([header]);
      await upsertOutboundTransferOrderLines(header.id, outbound);
      await markMissingOutboundOrderLines(header.id, outbound.map((line) => line.line_id));
    }
    if (header.has_receiving) {
      const receiving = snapshot.stages?.receiving || [];
      await upsertInboundTransferOrders([header]);
      await upsertInboundTransferOrderLines(header.id, receiving);
      await markMissingInboundOrderLines(header.id, receiving.map((line) => line.line_id));
    }
  }
}

async function applyNetSuiteMirrorInboxEvent(event) {
  if (event.entity_type === "inventory") {
    const itemIds = Array.isArray(event.payload?.itemIds) ? event.payload.itemIds : [];
    if (itemIds.length) {
      const snapshot = await signedMirrorFetch(
        config.netSuiteMirror.sourceBaseUrl,
        "/api/internal/netsuite-sync/inventory-snapshot",
        { method: "POST", body: { itemIds } }
      );
      await upsertInventoryBalances(snapshot.rows || []);
    }
    return;
  }
  const snapshot = await fetchSourceOrderSnapshot(event.entity_type, event.entity_id);
  await applyOrderSnapshot(snapshot, event.entity_type, event.entity_id);
}

async function pollSourceEvents() {
  const cursor = await getNetSuiteMirrorCursor();
  const query = new URLSearchParams({
    after: String(cursor.sequence),
    limit: String(config.netSuiteMirror?.pageSize || 100)
  });
  const page = await signedMirrorFetch(
    config.netSuiteMirror.sourceBaseUrl,
    `/api/internal/netsuite-sync/events?${query.toString()}`
  );
  if (page.cursorExpired) {
    const error = new Error("NetSuite mirror cursor expired; starting full reconciliation.");
    error.code = "NETSUITE_MIRROR_CURSOR_EXPIRED";
    throw error;
  }
  await acceptNetSuiteMirrorEvents(page.events || []);
  await recordNetSuiteMirrorSourceHighWater(page.highWaterSequence);
  return page;
}

export async function runNetSuiteMirrorConsumerTick() {
  if (!isNetSuiteMirrorConsumer() || consumerTickRunning || consumerReconcileRunning) {
    return { skipped: true, reason: consumerReconcileRunning ? "reconciliation_running" : "consumer_tick_running" };
  }
  consumerTickRunning = true;
  let applied = 0;
  let recoveryNeeded = false;
  try {
    await pollSourceEvents();
    while (true) {
      const { event } = await getNextNetSuiteMirrorInboxEvent();
      if (!event) break;
      try {
        await withTransaction(async () => {
          await applyNetSuiteMirrorInboxEvent(event);
          await markNetSuiteMirrorInboxApplied(event);
        });
        applied += 1;
      } catch (error) {
        await markNetSuiteMirrorInboxFailed(event.event_uuid, error.message);
        throw error;
      }
    }
    return { applied };
  } catch (error) {
    if (error.code === "NETSUITE_MIRROR_CURSOR_EXPIRED") recoveryNeeded = true;
    else throw error;
  } finally {
    consumerTickRunning = false;
  }
  if (recoveryNeeded) return runNetSuiteMirrorReconciliation({ full: true });
  return { applied };
}

export async function runNetSuiteMirrorReconciliation({ full = false } = {}) {
  if (!isNetSuiteMirrorConsumer()) throw new Error("Reconciliation runs only on the NetSuite mirror consumer.");
  if (consumerReconcileRunning || consumerTickRunning) {
    return { skipped: true, reason: consumerTickRunning ? "consumer_tick_running" : "reconciliation_running" };
  }
  consumerReconcileRunning = true;
  const startedAt = new Date().toISOString();
  let cursor = "";
  let pages = 0;
  let orders = 0;
  let inventoryItems = 0;
  try {
    const state = await getNetSuiteMirrorCursor();
    const fullBaselineSequence = full
      ? Number((
        await signedMirrorFetch(config.netSuiteMirror.sourceBaseUrl, "/api/internal/netsuite-sync/status")
      )?.source?.highWaterSequence || 0)
      : null;
    const updatedAfter = full ? null : state.lastReconciledAt;
    do {
      const params = new URLSearchParams({
        cursor,
        limit: String(config.netSuiteMirror?.pageSize || 100)
      });
      if (updatedAfter) params.set("updatedAfter", updatedAfter);
      const page = await signedMirrorFetch(
        config.netSuiteMirror.sourceBaseUrl,
        `/api/internal/netsuite-sync/manifest?${params.toString()}`
      );
      if (page.contract !== "netsuite-mirror/v1") throw new Error("Unexpected mirror manifest contract.");
      const entities = Array.isArray(page.entities) ? page.entities : [];
      const inventoryIds = entities
        .filter((entity) => entity.entityType === "inventory")
        .map((entity) => entity.entityId);
      for (const entity of entities.filter((row) => row.entityType !== "inventory")) {
        const snapshot = await fetchSourceOrderSnapshot(entity.entityType, entity.entityId);
        await withTransaction(() => applyOrderSnapshot(snapshot, entity.entityType, entity.entityId));
        orders += 1;
      }
      if (inventoryIds.length) {
        const snapshot = await signedMirrorFetch(
          config.netSuiteMirror.sourceBaseUrl,
          "/api/internal/netsuite-sync/inventory-snapshot",
          { method: "POST", body: { itemIds: inventoryIds } }
        );
        await withTransaction(() => upsertInventoryBalances(snapshot.rows || []));
        inventoryItems += inventoryIds.length;
      }
      pages += 1;
      if (pages > 100000) throw new Error("Mirror reconciliation exceeded its page safety limit.");
      cursor = page.hasMore ? String(page.nextCursor || "") : "";
    } while (cursor);
    if (full) {
      await initializeNetSuiteMirrorCursor(fullBaselineSequence, { lastReconciledAt: startedAt });
    } else {
      await markNetSuiteMirrorReconciled(startedAt);
    }
    return {
      full,
      pages,
      orders,
      inventoryItems,
      baselineSequence: fullBaselineSequence,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } finally {
    consumerReconcileRunning = false;
  }
}

export function kickNetSuiteMirrorConsumer() {
  if (!isNetSuiteMirrorConsumer()) return;
  setTimeout(() => {
    runNetSuiteMirrorConsumerTick().catch((error) => {
      console.error("NetSuite mirror consumer failed:", error.message);
    });
  }, 0);
}

export function startNetSuiteMirrorWorkers() {
  if (isNetSuiteMirrorSource()) {
    const sourceTick = () => {
      relayPendingNetSuiteMirrorEvents().catch((error) => {
        console.error("NetSuite mirror relay failed:", error.message);
      });
      if (Date.now() - lastPrunedAt > 60 * 60 * 1000) {
        lastPrunedAt = Date.now();
        pruneNetSuiteMirrorEvents().catch((error) => {
          console.error("NetSuite mirror retention cleanup failed:", error.message);
        });
      }
    };
    sourceTick();
    const timer = setInterval(sourceTick, Number(config.netSuiteMirror?.relayIntervalMs || 5000));
    timer.unref?.();
  }
  if (isNetSuiteMirrorConsumer()) {
    const consumerTick = () => {
      runNetSuiteMirrorConsumerTick().catch((error) => {
        console.error("NetSuite mirror consumer failed:", error.message);
      });
    };
    consumerTick();
    const timer = setInterval(consumerTick, Number(config.netSuiteMirror?.pollIntervalMs || 30000));
    timer.unref?.();
    const reconcileTimer = setInterval(() => {
      runNetSuiteMirrorReconciliation().catch((error) => {
        console.error("NetSuite mirror reconciliation failed:", error.message);
      });
    }, Number(config.netSuiteMirror?.reconcileIntervalMs || 21600000));
    reconcileTimer.unref?.();
  }
}

export async function localNetSuiteMirrorOrderSnapshot(entityType, entityId) {
  return getNetSuiteMirrorOrderSnapshot(entityType, entityId);
}

export async function localNetSuiteMirrorInventorySnapshot(itemIds) {
  return getNetSuiteMirrorInventorySnapshot(itemIds);
}

export async function localNetSuiteMirrorEventPage(options) {
  return listNetSuiteMirrorEvents(options);
}
