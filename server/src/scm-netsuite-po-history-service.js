import { writeAudit } from "./auth-repository.js";
import {
  fetchPurchaseOrderHistorySnapshotFromNetSuite,
  fetchPurchaseOrderHistorySnapshotsFromNetSuite,
  fetchPurchaseOrderPdfFromNetSuite,
  updatePurchaseOrderHistoryInNetSuite
} from "./netsuite.js";
import { markMissingInboundOrderLines, upsertPurchaseOrderLines, upsertPurchaseOrders } from "./order-sync-repository.js";
import {
  findScmNetSuitePoHistoryByNetSuiteId,
  getScmNetSuitePoHistory,
  listScmNetSuitePoHistoryReconciliationCandidates,
  markScmNetSuitePoHistorySyncError,
  persistScmNetSuitePoSnapshot,
  recordScmNetSuitePoCreation
} from "./scm-netsuite-po-history-repository.js";
import { convertPurchaseOrderPalletQuantity } from "./scm-netsuite-po-unit-conversion.js";

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function sameInstant(left, right) {
  const a = new Date(left || 0).getTime();
  const b = new Date(right || 0).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1000;
}

function date(value, fieldName, nullable = true) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const normalized = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw Object.assign(new Error(`${fieldName} must use YYYY-MM-DD.`), { status: 400 });
  return normalized;
}

function number(value, fieldName, { positive = false } = {}) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || (positive ? normalized <= 0 : normalized < 0)) {
    throw Object.assign(new Error(`${fieldName} is invalid.`), { status: 400 });
  }
  return normalized;
}

function comparableDate(value) {
  const normalized = text(value, 40);
  if (!normalized) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const match = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : normalized.slice(0, 10);
}

function snapshotReflectsChanges(snapshot, { header = {}, lines = [] } = {}) {
  if (!snapshot) return false;
  const headerChecks = {
    transactionDate: () => comparableDate(snapshot.trandate) === comparableDate(header.transactionDate),
    expectedDeliveryDate: () => comparableDate(snapshot.expectedDeliveryDate) === comparableDate(header.expectedDeliveryDate),
    memo: () => text(snapshot.memo) === text(header.memo),
    vendorReference: () => text(snapshot.vendorReference, 300) === text(header.vendorReference, 300)
  };
  for (const field of Object.keys(header)) {
    if (!headerChecks[field]?.()) return false;
  }
  const remoteByLine = new Map((snapshot.lines || []).map((line) => [Number(line.lineId), line]));
  for (const requested of lines) {
    const remote = remoteByLine.get(Number(requested.lineId));
    if (!remote) return false;
    if (Object.prototype.hasOwnProperty.call(requested, "quantity") && Math.abs(Number(remote.quantity) - Number(requested.quantity)) > 0.000001) return false;
    if (requested.updatePalletColumn === true
      && Object.prototype.hasOwnProperty.call(requested, "palletQuantity")
      && Math.abs(Number(remote.palletQuantity) - Number(requested.palletQuantity)) > 0.000001) return false;
    if (Object.prototype.hasOwnProperty.call(requested, "rate") && Math.abs(Number(remote.rate || 0) - Number(requested.rate)) > 0.000001) return false;
    if (Object.prototype.hasOwnProperty.call(requested, "locationId") && Number(remote.locationId) !== Number(requested.locationId)) return false;
  }
  return true;
}

function sameOptionalNumber(left, right) {
  const leftMissing = left === null || left === undefined || left === "";
  const rightMissing = right === null || right === undefined || right === "";
  if (leftMissing || rightMissing) return leftMissing && rightMissing;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

function canonicalSnapshotMatchesHistory(history, snapshot) {
  const current = history.current || {};
  if (text(current.tranid) !== text(snapshot.tranid)
      || comparableDate(current.transactionDate) !== comparableDate(snapshot.trandate)
      || Number(current.vendorId || 0) !== Number(snapshot.vendorId || 0)
      || text(current.vendor) !== text(snapshot.vendor)
      || text(current.status) !== text(snapshot.status)
      || text(current.statusText) !== text(snapshot.statusText)
      || text(current.memo) !== text(snapshot.memo)
      || text(current.vendorReference, 300) !== text(snapshot.vendorReference, 300)
      || comparableDate(current.expectedDeliveryDate) !== comparableDate(snapshot.expectedDeliveryDate)
      || !sameOptionalNumber(current.total, snapshot.foreignTotal)) return false;
  const currentLines = current.lines || [];
  const snapshotLines = snapshot.lines || [];
  if (currentLines.length !== snapshotLines.length) return false;
  const byLine = new Map(currentLines.map((line) => [Number(line.lineId), line]));
  return snapshotLines.every((line) => {
    const stored = byLine.get(Number(line.lineId));
    return stored
      && Number(stored.itemId || 0) === Number(line.itemId || 0)
      && text(stored.itemName) === text(line.itemName)
      && text(stored.description) === text(line.description)
      && sameOptionalNumber(stored.quantity, line.quantity)
      && sameOptionalNumber(stored.receivedQuantity, line.receivedQuantity)
      && sameOptionalNumber(stored.rate, line.rate)
      && sameOptionalNumber(stored.amount, line.amount)
      && Number(stored.destinationLocationId || 0) === Number(line.locationId || 0)
      && text(stored.destination) === text(line.location)
      && Boolean(stored.closed) === Boolean(line.closed);
  });
}

function canonicalOrder(snapshot) {
  const destinations = [...new Map((snapshot.lines || []).filter((line) => line.locationId).map((line) => [Number(line.locationId), line.location])).entries()];
  return {
    id: snapshot.id,
    tranid: snapshot.tranid,
    trandate: snapshot.trandate,
    vendor_id: snapshot.vendorId,
    vendor: snapshot.vendor,
    status: snapshot.status,
    status_text: snapshot.statusText,
    memo: snapshot.memo,
    expected_delivery_date: snapshot.expectedDeliveryDate,
    foreigntotal: snapshot.foreignTotal,
    destination_location_id: destinations.length === 1 ? destinations[0][0] : null,
    destination_location: destinations.length === 1 ? destinations[0][1] : "Multiple destinations",
    netsuite_active: true
  };
}

function canonicalLines(snapshot) {
  return (snapshot.lines || []).map((line) => ({
    line_id: line.lineId,
    item_id: line.itemId,
    item_name: line.itemName,
    item_type: line.itemType || null,
    item_type_text: line.itemTypeText || null,
    item_description: line.description || "",
    sku: line.itemName,
    quantity: line.quantity,
    netsuite_received_qty: line.receivedQuantity,
    unit: line.unit,
    item_weight: line.itemWeight,
    location_id: line.locationId,
    location: line.location,
    pallet_qty: line.palletQuantity,
    layer_qty: line.layerQuantity,
    section_qty: line.sectionQuantity,
    piece_qty: line.pieceQuantity,
    to_plt: line.toPlt,
    to_lyr: line.toLyr,
    to_sec: line.toSec,
    to_pcs: line.toPcs,
    rate: line.rate,
    amount: line.amount,
    netsuite_closed: line.closed,
    raw: line
  }));
}

async function persistCanonicalSnapshot(history, snapshot, { source, operatorId = null, requestedChanges = {} } = {}) {
  await upsertPurchaseOrders([canonicalOrder(snapshot)]);
  const lines = canonicalLines(snapshot);
  await upsertPurchaseOrderLines(history.purchaseOrderId, lines);
  await markMissingInboundOrderLines(history.purchaseOrderId, lines.map((line) => line.line_id));
  return persistScmNetSuitePoSnapshot(history.id, snapshot, { source, operatorId, requestedChanges });
}

export async function refreshScmNetSuitePoHistory(historyId, { source = "reconciliation", operatorId = null } = {}) {
  const history = await getScmNetSuitePoHistory(historyId);
  const candidates = await listScmNetSuitePoHistoryReconciliationCandidates({
    preferredHistoryId: history.id,
    limit: 25
  });
  try {
    const snapshots = await fetchPurchaseOrderHistorySnapshotsFromNetSuite(candidates.map((candidate) => candidate.purchaseOrderId));
    const byOrderId = new Map(snapshots.map((snapshot) => [Number(snapshot.id), snapshot]));
    let requestedError = null;
    for (const candidate of candidates) {
      const candidateHistory = candidate.historyId === history.id
        ? history
        : await getScmNetSuitePoHistory(candidate.historyId);
      const snapshot = byOrderId.get(candidate.purchaseOrderId);
      if (!snapshot) {
        const error = Object.assign(new Error("The purchase order no longer exists in NetSuite."), { status: 404 });
        await markScmNetSuitePoHistorySyncError(candidate.historyId, error).catch(() => {});
        if (candidate.historyId === history.id) requestedError = error;
        continue;
      }
      try {
        const canonicalAlreadyCurrent = Boolean(candidateHistory.remoteLastModifiedAt && snapshot.lastModifiedAt)
          && sameInstant(candidateHistory.remoteLastModifiedAt, snapshot.lastModifiedAt)
          && !candidateHistory.lastSyncError
          && canonicalSnapshotMatchesHistory(candidateHistory, snapshot);
        if (canonicalAlreadyCurrent) {
          await persistScmNetSuitePoSnapshot(candidateHistory.id, snapshot, { source, operatorId });
        } else {
          await persistCanonicalSnapshot(candidateHistory, snapshot, { source, operatorId });
        }
      } catch (error) {
        await markScmNetSuitePoHistorySyncError(candidate.historyId, error).catch(() => {});
        if (candidate.historyId === history.id) requestedError = error;
      }
    }
    if (requestedError) throw requestedError;
    return await getScmNetSuitePoHistory(history.id);
  } catch (error) {
    await markScmNetSuitePoHistorySyncError(history.id, error).catch(() => {});
    throw error;
  }
}

export async function registerScmNetSuitePoHistoryCreation(creation, operatorId = null) {
  const history = await recordScmNetSuitePoCreation(creation, operatorId);
  try {
    return await refreshScmNetSuitePoHistory(history.id, { source: "reconciliation", operatorId });
  } catch (error) {
    // NetSuite creation is already durable. A readback outage must not turn a
    // successful create into a retry that could duplicate the accounting PO.
    return { ...history, lastSyncError: error.message, readbackPending: true };
  }
}

export async function updateScmNetSuitePoHistory(historyId, body = {}, operatorId = null) {
  const history = await getScmNetSuitePoHistory(historyId, { includeUnarchived: false });
  const remote = await fetchPurchaseOrderHistorySnapshotFromNetSuite(history.purchaseOrderId);
  if (!remote) throw Object.assign(new Error("The purchase order no longer exists in NetSuite."), { status: 404 });
  const terminal = /closed|cancelled|canceled|fully received|fully billed/i.test(`${remote.status || ""} ${remote.statusText || ""}`);
  const hasReceiptOrClosedLine = (remote.lines || []).some((line) => line.closed || Number(line.receivedQuantity || 0) > 0);
  if (terminal || hasReceiptOrClosedLine || history.current.active === false) {
    throw Object.assign(new Error("This purchase order is received, closed, cancelled, or inactive and is read-only."), { status: 409 });
  }
  const expected = text(body.expectedLastModifiedAt, 100);
  if (!expected || !sameInstant(expected, remote.lastModifiedAt)) {
    const conflict = Object.assign(new Error("This purchase order changed in NetSuite. Refresh and review the latest values before saving."), { status: 409 });
    conflict.current = remote;
    throw conflict;
  }

  const requestedHeader = body.header && typeof body.header === "object" ? body.header : {};
  const header = {};
  if (Object.prototype.hasOwnProperty.call(requestedHeader, "transactionDate")) header.transactionDate = date(requestedHeader.transactionDate, "Transaction date", false);
  if (Object.prototype.hasOwnProperty.call(requestedHeader, "expectedDeliveryDate")) header.expectedDeliveryDate = date(requestedHeader.expectedDeliveryDate, "Expected delivery date");
  if (Object.prototype.hasOwnProperty.call(requestedHeader, "memo")) header.memo = text(requestedHeader.memo, 4000);
  if (Object.prototype.hasOwnProperty.call(requestedHeader, "vendorReference")) header.vendorReference = text(requestedHeader.vendorReference, 300);

  const remoteByLine = new Map((remote.lines || []).map((line) => [Number(line.lineId), line]));
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((requested, index) => {
    const lineId = Number(requested.lineId);
    const current = remoteByLine.get(lineId);
    if (!current) throw Object.assign(new Error(`Purchase-order line ${lineId || index + 1} no longer exists.`), { status: 409 });
    if (requested.itemId !== undefined && Number(requested.itemId) !== Number(current.itemId)) {
      throw Object.assign(new Error(`Item identity on line ${lineId} is locked.`), { status: 400 });
    }
    if (current.closed || Number(current.receivedQuantity || 0) > 0) {
      throw Object.assign(new Error(`${current.itemName || `Line ${lineId}`} is received or closed and cannot be edited.`), { status: 409 });
    }
    const clean = { lineId, restLineId: current.restLineId, itemId: current.itemId };
    const hasPalletQuantity = Object.prototype.hasOwnProperty.call(requested, "palletQuantity");
    const hasNativeQuantity = Object.prototype.hasOwnProperty.call(requested, "quantity");
    if (hasPalletQuantity && hasNativeQuantity) {
      throw Object.assign(new Error("PLT quantity and native quantity cannot both be provided."), { status: 400 });
    }
    if (hasPalletQuantity) {
      const converted = convertPurchaseOrderPalletQuantity(current, requested.palletQuantity);
      clean.palletQuantity = converted.palletQuantity;
      clean.quantity = converted.nativeQuantity;
      clean.updatePalletColumn = converted.updatePalletColumn;
    } else if (hasNativeQuantity) {
      clean.quantity = number(requested.quantity, `Quantity for ${current.itemName}`, { positive: true });
    }
    if (Object.prototype.hasOwnProperty.call(requested, "rate")) clean.rate = number(requested.rate, `Rate for ${current.itemName}`);
    if (Object.prototype.hasOwnProperty.call(requested, "destinationLocationId")) {
      const location = Number(requested.destinationLocationId);
      if (!Number.isInteger(location) || location <= 0) throw Object.assign(new Error(`Destination for ${current.itemName} is invalid.`), { status: 400 });
      clean.locationId = location;
    }
    return clean;
  }).filter((line) => Object.keys(line).length > 3);

  if (!Object.keys(header).length && !lines.length) throw Object.assign(new Error("No editable purchase-order changes were provided."), { status: 400 });
  const requestedChanges = { header, lines };
  try {
    await updatePurchaseOrderHistoryInNetSuite(history.purchaseOrderId, {
      expectedLastModifiedAt: remote.lastModifiedAt,
      header,
      lines
    });
    let updated = null;
    let readbackConfirmed = false;
    for (const delayMs of [0, 250, 750, 1500, 2500]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      updated = await fetchPurchaseOrderHistorySnapshotFromNetSuite(history.purchaseOrderId);
      readbackConfirmed = snapshotReflectsChanges(updated, requestedChanges);
      if (readbackConfirmed) break;
    }
    if (!readbackConfirmed) {
      const message = "NetSuite accepted the PO update, but the changed values are not visible in readback yet. Automatic reconciliation will continue.";
      await markScmNetSuitePoHistorySyncError(history.id, message).catch(() => {});
      await writeAudit({
        actorOperatorId: operatorId,
        source: "smart_scm",
        action: "smart_scm.netsuite_po.update_readback_pending",
        orderId: history.purchaseOrderId,
        details: { historyId: history.id, requestedChanges, remoteLastModifiedBefore: remote.lastModifiedAt }
      });
      return { ...await getScmNetSuitePoHistory(history.id), readbackPending: true, lastSyncError: message };
    }
    const saved = await persistCanonicalSnapshot(history, updated, { source: "application", operatorId, requestedChanges });
    await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: "smart_scm.netsuite_po.updated", orderId: history.purchaseOrderId, details: { historyId: history.id, requestedChanges, remoteLastModifiedBefore: remote.lastModifiedAt, remoteLastModifiedAfter: updated.lastModifiedAt } });
    return saved;
  } catch (error) {
    if (/MBBS_PO_VERSION_CONFLICT|changed in NetSuite/i.test(error.message)) error.status = 409;
    await markScmNetSuitePoHistorySyncError(history.id, error).catch(() => {});
    throw error;
  }
}

export async function getScmNetSuitePoHistoryPdf(historyId) {
  const history = await getScmNetSuitePoHistory(historyId, { includeUnarchived: true });
  return fetchPurchaseOrderPdfFromNetSuite(history.purchaseOrderId, { filenamePrefix: history.purchaseOrderRef || "PO" });
}

export async function processScmNetSuitePoHistoryWebhook(payload = {}) {
  const recordType = text(payload.recordType || payload.type).toLowerCase().replace(/[^a-z]/g, "");
  if (recordType !== "purchaseorder") return { matched: false, event: null };
  const history = await findScmNetSuitePoHistoryByNetSuiteId(payload.id);
  if (!history) return { matched: false, event: null };
  const snapshot = {
    id: Number(payload.id),
    tranid: payload.tranid,
    trandate: payload.trandate,
    createdAt: payload.createdDate || payload.createdAt,
    lastModifiedAt: payload.lastModifiedDate || payload.lastModifiedAt,
    vendorId: Number(payload.entityId) || null,
    vendor: payload.entityText || "",
    status: payload.status || "",
    statusText: payload.statusText || "",
    memo: payload.memo || "",
    vendorReference: payload.vendorReference || payload.otherrefnum || "",
    expectedDeliveryDate: payload.expectedDeliveryDate || null,
    foreignTotal: payload.foreignTotal === null || payload.foreignTotal === undefined ? null : Number(payload.foreignTotal),
    lines: (payload.lines || []).map((line) => ({
      lineId: Number(line.lineUniqueKey || line.lineId),
      itemId: Number(line.itemId),
      itemName: line.itemName || "",
      description: line.itemDescription || "",
      quantity: Number(line.quantity || 0),
      receivedQuantity: Number(line.quantityReceived || line.quantityShipRecv || 0),
      rate: line.rate === null || line.rate === undefined ? null : Number(line.rate),
      amount: line.amount === null || line.amount === undefined ? null : Number(line.amount),
      closed: /^(t|true|yes|1)$/i.test(String(line.closed || "")),
      unit: line.unit || "",
      locationId: Number(line.locationId) || null,
      location: line.locationText || ""
    }))
  };
  // The generic order webhook synchronizes the canonical order and line rows in
  // the same database transaction before this history-specific snapshot runs.
  const current = await persistScmNetSuitePoSnapshot(history.id, snapshot, { source: "netsuite_webhook" });
  return {
    matched: true,
    history: current,
    event: {
      name: "scm.smart.updated",
      data: { source: "netsuite-po-history-webhook", historyId: history.id, purchaseOrderId: history.purchaseOrderId, purchaseOrderRef: history.purchaseOrderRef }
    }
  };
}
