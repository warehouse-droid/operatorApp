// @ts-check

import crypto from "node:crypto";

import { stableCanonicalJson } from "./operator-netsuite-posting-domain.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EPSILON = 0.000001;
/** @typedef {Record<string, any>} LooseRecord */

/** @param {string} code @param {string} message @param {number} [status] */
function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** @param {unknown} value @param {string} label */
function text(value, label) {
  const retained = String(value ?? "").trim();
  if (!retained) {throw failure("SALES_ORDER_IF_INPUT_INVALID", `${label} is required.`, 400);}
  return retained;
}

/** @param {unknown} value */
function optionalText(value) {
  const retained = String(value ?? "").trim();
  return retained || null;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  const retained = Number(value);
  if (!Number.isSafeInteger(retained) || retained <= 0) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", `${label} must be a positive integer.`, 400);
  }
  return retained;
}

/** @param {unknown} value @param {string} label */
function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === "") {return null;}
  return positiveInteger(value, label);
}

/** @param {unknown} value @param {string} label @param {{positive?: boolean}} [options] */
function quantity(value, label, { positive = false } = {}) {
  const retained = Number(value ?? 0);
  if (!Number.isFinite(retained) || retained < 0 || (positive && retained <= 0)) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", `${label} must be a finite ${positive ? "positive" : "nonnegative"} quantity.`, 400);
  }
  return Number(retained.toFixed(6));
}

/** @param {unknown} value */
function hash(value) {
  return crypto.createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

/** @param {unknown} value */
function requireReason(value) {
  const retained = String(value ?? "").trim();
  if (!retained) {throw failure("SALES_ORDER_IF_REASON_REQUIRED", "An audit reason is required.", 400);}
  if (retained.length > 1000) {throw failure("SALES_ORDER_IF_INPUT_INVALID", "The audit reason must be 1000 characters or fewer.", 400);}
  return retained;
}

/** @param {unknown} candidateId */
export function salesOrderAutoFulfillmentExternalId(candidateId) {
  const normalized = String(candidateId || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", "A UUID fulfillment candidate ID is required.", 400);
  }
  return `MBBS-SOIF-${normalized}`;
}

/** @param {any} values @param {number} expectedQuantity */
function normalizedPoEvidence(values, expectedQuantity) {
  const rows = Array.isArray(values) ? values : [];
  if (expectedQuantity <= EPSILON) {return [];}
  if (!rows.length) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "Completed Link PO quantity requires allocation-scoped pickup and delivery evidence.");
  }
  // Evidence-field validation is deliberately kept at the immutable boundary.
  // eslint-disable-next-line complexity
  const normalized = rows.map((row) => {
    if (!String(row?.allocationId || "").trim()
        || !String(row?.pickupJobId || "").trim()
        || !String(row?.deliveryJobId || "").trim()) {
      throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "Every PO allocation requires exact pickup and delivery Driver jobs.");
    }
    return {
      allocationId: text(row?.allocationId, "PO allocation ID"),
      quantity: quantity(row?.quantity, "PO evidence quantity", { positive: true }),
      pickupJobId: text(row?.pickupJobId, "PO pickup Driver job"),
      deliveryJobId: text(row?.deliveryJobId, "PO delivery Driver job"),
      pickupPlanId: optionalPositiveInteger(row?.pickupPlanId, "PO pickup plan"),
      pickupLoadId: optionalText(row?.pickupLoadId),
      deliveryPlanId: optionalPositiveInteger(row?.deliveryPlanId, "PO delivery plan"),
      deliveryLoadId: optionalText(row?.deliveryLoadId)
    };
  });
  if (new Set(normalized.map((row) => row.allocationId)).size !== normalized.length) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "A PO allocation appears more than once in completion evidence.");
  }
  const total = normalized.reduce((sum, row) => sum + row.quantity, 0);
  if (Math.abs(total - expectedQuantity) > EPSILON) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "PO execution evidence does not equal the completed PO quantity.");
  }
  return normalized.sort((left, right) => left.allocationId.localeCompare(right.allocationId));
}

/** @param {any} values @param {number} expectedQuantity */
function normalizedToEvidence(values, expectedQuantity) {
  const rows = Array.isArray(values) ? values : [];
  if (expectedQuantity <= EPSILON) {return [];}
  if (!rows.length) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "Completed direct Link TO quantity requires dependency completion evidence.");
  }
  // Evidence-field validation is deliberately kept at the immutable boundary.
  // eslint-disable-next-line complexity
  const normalized = rows.map((row) => {
    if (!String(row?.dependencyId || "").trim()
        || !String(row?.pickupJobId || "").trim()
        || !String(row?.deliveryJobId || "").trim()) {
      throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "Every direct TO dependency requires exact pickup and delivery Driver jobs.");
    }
    return {
      dependencyId: text(row?.dependencyId, "TO dependency ID"),
      quantity: quantity(row?.quantity, "TO evidence quantity", { positive: true }),
      pickupJobId: text(row?.pickupJobId, "TO pickup Driver job"),
      deliveryJobId: text(row?.deliveryJobId, "TO delivery Driver job"),
      planId: optionalPositiveInteger(row?.planId, "TO execution plan"),
      loadId: optionalText(row?.loadId)
    };
  });
  if (new Set(normalized.map((row) => row.dependencyId)).size !== normalized.length) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "A direct TO dependency appears more than once in completion evidence.");
  }
  const total = normalized.reduce((sum, row) => sum + row.quantity, 0);
  if (Math.abs(total - expectedQuantity) > EPSILON) {
    throw failure("SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE", "TO execution evidence does not equal the completed direct TO quantity.");
  }
  return normalized.sort((left, right) => left.dependencyId.localeCompare(right.dependencyId));
}

/** @param {LooseRecord} [input] */
export function buildSalesOrderCompletionSnapshot(input = {}) {
  const candidateId = String(input.candidateId || "").trim().toLowerCase();
  const externalId = salesOrderAutoFulfillmentExternalId(candidateId);
  const dispatchOrderRef = text(input.dispatchOrderRef, "Dispatch order reference");
  const sourceSalesOrderId = positiveInteger(input.sourceSalesOrderId, "Source NetSuite Sales Order ID");
  const sourceSalesOrderRef = text(input.sourceSalesOrderRef, "Source NetSuite Sales Order reference");
  const locationId = positiveInteger(input.locationId, "Fulfillment location");
  if (!Array.isArray(input.lines) || !input.lines.length) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", "At least one delivered Sales Order line is required.", 400);
  }
  const seenOrderLines = new Set();
  // A line snapshot owns identity, conservation, and all direct-supply evidence.
  // eslint-disable-next-line complexity
  const lines = input.lines.map((line) => {
    const localLineId = text(line?.localLineId, "Local line ID");
    const sourceLineId = text(line?.sourceLineId, "Source line ID");
    const orderLine = positiveInteger(line?.orderLine, "NetSuite order line");
    if (seenOrderLines.has(orderLine)) {
      throw failure("SALES_ORDER_IF_INPUT_INVALID", "A NetSuite order line appears more than once in the delivered snapshot.", 400);
    }
    seenOrderLines.add(orderLine);
    const targetQuantity = quantity(line?.targetQuantity, "Dispatch target quantity", { positive: true });
    const operatorLoadedQuantity = quantity(line?.operatorLoadedQuantity, "Operator loaded quantity");
    const completedPoQuantity = quantity(line?.completedPoQuantity, "Completed PO quantity");
    const completedDirectToQuantity = quantity(line?.completedDirectToQuantity, "Completed direct TO quantity");
    const deliveredQuantity = Number((operatorLoadedQuantity + completedPoQuantity + completedDirectToQuantity).toFixed(6));
    if (Math.abs(deliveredQuantity - targetQuantity) > EPSILON) {
      throw failure(
        "SALES_ORDER_IF_CONSERVATION_FAILED",
        `Delivered quantity for NetSuite line ${orderLine} does not conserve the Dispatch target.`
      );
    }
    return {
      localLineId,
      sourceLineId,
      orderLine,
      itemId: positiveInteger(line?.itemId, "NetSuite item ID"),
      location: optionalPositiveInteger(line?.location ?? locationId, "Line location"),
      targetQuantity,
      operatorLoadedQuantity,
      operatorLoadRecordId: optionalText(line?.operatorLoadRecordId),
      completedPoQuantity,
      completedDirectToQuantity,
      deliveredQuantity,
      poEvidence: normalizedPoEvidence(line?.poEvidence, completedPoQuantity),
      toEvidence: normalizedToEvidence(line?.toEvidence, completedDirectToQuantity)
    };
  }).sort((left, right) => left.orderLine - right.orderLine);
  const snapshot = {
    schemaVersion: "sales-order-auto-fulfillment-v1",
    candidateId,
    externalId,
    dispatchOrderRef,
    sourceSalesOrderId,
    sourceSalesOrderRef,
    locationId,
    lines
  };
  return { ...snapshot, snapshotHash: hash(snapshot) };
}

/** @param {any} lines */
function liveLineMap(lines) {
  const map = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const orderLine = positiveInteger(line?.orderLine, "Live NetSuite order line");
    if (map.has(orderLine)) {throw failure("SALES_ORDER_IF_INPUT_INVALID", "A live NetSuite line appears more than once.", 400);}
    map.set(orderLine, {
      orderLine,
      itemId: positiveInteger(line?.itemId, "Live NetSuite item ID"),
      remainingQuantity: quantity(line?.remainingQuantity, "Live remaining quantity"),
      fulfilledQuantity: quantity(line?.fulfilledQuantity, "Live fulfilled quantity"),
      location: optionalPositiveInteger(line?.location, "Live line location")
    });
  }
  return map;
}

// The explicit branches are the fail-closed drift state machine.
/** @param {{snapshotLines?: any[], liveOrder?: LooseRecord}} [input] */
// eslint-disable-next-line complexity
export function compareSalesOrderFulfillmentSnapshot({ snapshotLines = [], liveOrder = {} } = {}) {
  if (liveOrder?.closed === true) {return { state: "closed", issues: [{ code: "SOURCE_ORDER_CLOSED" }] };}
  const live = liveLineMap(liveOrder?.lines);
  const snapshotKeys = new Set();
  const issues = [];
  let reconciled = 0;
  for (const snapshot of Array.isArray(snapshotLines) ? snapshotLines : []) {
    const orderLine = positiveInteger(snapshot?.orderLine, "Snapshot NetSuite order line");
    const itemId = positiveInteger(snapshot?.itemId, "Snapshot NetSuite item ID");
    const delivered = quantity(snapshot?.deliveredQuantity, "Snapshot delivered quantity", { positive: true });
    snapshotKeys.add(orderLine);
    const current = live.get(orderLine);
    if (!current) {
      issues.push({ code: "LIVE_LINE_MISSING", orderLine });
      continue;
    }
    if (current.itemId !== itemId) {
      issues.push({ code: "LIVE_ITEM_CHANGED", orderLine, snapshotItemId: itemId, liveItemId: current.itemId });
      continue;
    }
    if (current.remainingQuantity + EPSILON >= delivered) {continue;}
    if (current.remainingQuantity <= EPSILON && current.fulfilledQuantity + EPSILON >= delivered) {
      reconciled += 1;
      continue;
    }
    issues.push({
      code: "LIVE_QUANTITY_CHANGED",
      orderLine,
      deliveredQuantity: delivered,
      liveRemainingQuantity: current.remainingQuantity,
      liveFulfilledQuantity: current.fulfilledQuantity
    });
  }
  for (const orderLine of live.keys()) {
    if (!snapshotKeys.has(orderLine)) {issues.push({ code: "LIVE_LINE_ADDED", orderLine });}
  }
  if (issues.length) {return { state: "attention", issues };}
  return { state: reconciled === snapshotKeys.size ? "reconciled" : "ready", issues: [] };
}

// Admin choices intentionally converge through one bounded line-selection policy.
/** @param {{action?: any, snapshotLines?: any[], liveLines?: any[], customLines?: any[], reason?: any}} [input] */
// eslint-disable-next-line complexity
export function resolveSalesOrderFulfillmentLines({ action, snapshotLines = [], liveLines = [], customLines = [], reason } = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const live = liveLineMap(liveLines);
  if (["custom", "skip"].includes(normalizedAction)) {requireReason(reason);}
  if (normalizedAction === "skip") {return [];}
  let requested;
  if (normalizedAction === "snapshot") {
    requested = snapshotLines.map((line) => ({
      orderLine: positiveInteger(line?.orderLine, "Snapshot NetSuite order line"),
      quantity: quantity(line?.deliveredQuantity, "Snapshot delivered quantity", { positive: true })
    })).filter((request) => {
      const current = live.get(request.orderLine);
      return !current
        || current.remainingQuantity > EPSILON
        || current.fulfilledQuantity + EPSILON < request.quantity;
    });
  } else if (normalizedAction === "all_live_remaining") {
    requested = [...live.values()]
      .filter((line) => line.remainingQuantity > EPSILON)
      .map((line) => ({ orderLine: line.orderLine, quantity: line.remainingQuantity }));
  } else if (normalizedAction === "custom") {
    requested = (Array.isArray(customLines) ? customLines : []).map((line) => ({
      orderLine: positiveInteger(line?.orderLine, "Custom NetSuite order line"),
      quantity: quantity(line?.quantity, "Custom fulfillment quantity", { positive: true })
    }));
  } else {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", "Choose snapshot, all live remaining, custom, or skip.", 400);
  }
  if (!requested.length) {throw failure("SALES_ORDER_IF_INPUT_INVALID", "At least one fulfillment line is required.", 400);}
  const seen = new Set();
  return requested.map((request) => {
    if (seen.has(request.orderLine)) {throw failure("SALES_ORDER_IF_INPUT_INVALID", "A fulfillment line was selected more than once.", 400);}
    seen.add(request.orderLine);
    const current = live.get(request.orderLine);
    if (!current || request.quantity > current.remainingQuantity + EPSILON) {
      throw failure("SALES_ORDER_IF_QUANTITY_OUT_OF_BOUNDS", `Fulfillment quantity for NetSuite line ${request.orderLine} exceeds its live remainder.`);
    }
    return {
      orderLine: request.orderLine,
      itemId: current.itemId,
      quantity: request.quantity,
      location: current.location
    };
  }).sort((left, right) => left.orderLine - right.orderLine);
}

// Payload construction validates both positive selections and explicit negative lines.
/** @param {{selectedLines?: any[], availableLines?: any[], externalId?: any}} [input] */
// eslint-disable-next-line complexity
export function buildSalesOrderItemFulfillmentPayload({ selectedLines = [], availableLines = [], externalId } = {}) {
  const retainedExternalId = text(externalId, "NetSuite external ID");
  if (!/^MBBS-SOIF-[0-9a-f-]{36}$/u.test(retainedExternalId)) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", "A deterministic SO fulfillment external ID is required.", 400);
  }
  const selected = new Map();
  for (const line of selectedLines) {
    const orderLine = positiveInteger(line?.orderLine, "Selected NetSuite order line");
    if (selected.has(orderLine)) {throw failure("SALES_ORDER_IF_INPUT_INVALID", "A selected NetSuite line appears more than once.", 400);}
    selected.set(orderLine, {
      orderLine,
      quantity: quantity(line?.quantity, "Selected fulfillment quantity", { positive: true }),
      location: optionalPositiveInteger(line?.location, "Selected line location")
    });
  }
  const available = (Array.isArray(availableLines) ? availableLines : []).map((line) => ({
    orderLine: positiveInteger(line?.orderLine, "Available NetSuite order line"),
    location: optionalPositiveInteger(line?.location, "Available line location")
  })).sort((left, right) => left.orderLine - right.orderLine);
  const availableKeys = new Set(available.map((line) => line.orderLine));
  if (!selected.size || [...selected.keys()].some((line) => !availableKeys.has(line))) {
    throw failure("SALES_ORDER_IF_INPUT_INVALID", "Every selected line must exist in the live available lines.", 400);
  }
  return {
    externalId: retainedExternalId,
    item: {
      items: available.map((line) => {
        const retained = selected.get(line.orderLine);
        const location = retained?.location ?? line.location;
        return retained
          ? { orderLine: line.orderLine, quantity: retained.quantity, itemReceive: true, ...(location ? { location } : {}) }
          : { orderLine: line.orderLine, itemReceive: false, ...(location ? { location } : {}) };
      })
    }
  };
}
