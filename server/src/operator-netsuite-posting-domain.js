// @ts-check

import crypto from "node:crypto";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_ORDER_KINDS = new Set(["SO", "PO", "TO"]);
/** @type {Readonly<Record<string, Set<string>>>} */
const LOCAL_OPERATION_TYPES = Object.freeze({
  customer_pickup_load: new Set(["sales_order"]),
  receiving_receipt: new Set(["purchase_order", "transfer_order"]),
  delivery_prep_load: new Set(["sales_order", "transfer_order", "group_order"])
});

/** @param {string} message */
function inputError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "OPERATOR_NETSUITE_POSTING_INPUT_INVALID"
  });
}

/** @param {Record<string, unknown>} value @returns {Record<string, unknown>} */
function canonicalObject(value) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      throw inputError("Operator posting input must be JSON-safe.");
    }
    result[key] = canonicalValue(entry);
  }
  return result;
}

/** @param {unknown} value @returns {unknown} */
function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {return value;}
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {throw inputError("Operator posting input requires a finite JSON number.");}
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {return value.map((entry) => canonicalValue(entry));}
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw inputError("Operator posting input must be JSON-safe.");
  }
  return canonicalObject(/** @type {Record<string, unknown>} */ (value));
}

/** @param {unknown} value */
export function stableCanonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/** @param {unknown} requestId @param {unknown} stepIndex */
export function operatorNetSuiteExternalId(requestId, stepIndex) {
  const normalizedRequestId = String(requestId || "").trim().toLowerCase();
  const normalizedStep = Number(stepIndex);
  if (!REQUEST_ID_PATTERN.test(normalizedRequestId)
      || !Number.isSafeInteger(normalizedStep)
      || normalizedStep <= 0) {
    throw inputError("A UUID request ID and positive step index are required.");
  }
  return `MBBS-OP-${normalizedRequestId}-${normalizedStep}`;
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {throw inputError(`${label} is required.`);}
  return normalized;
}

/** @param {unknown} value */
function normalizedLocalOperation(value) {
  const operation = value && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
  if (!operation) {throw inputError("A durable local finalization operation is required.");}
  const kind = requiredText(operation.kind, "Local operation kind").toLowerCase();
  const orderId = requiredText(operation.orderId, "Local operation order ID");
  const orderType = requiredText(operation.orderType, "Local operation order type").toLowerCase();
  if (!LOCAL_OPERATION_TYPES[kind]?.has(orderType)) {
    throw inputError("The local finalization operation is not supported.");
  }
  return { kind, orderId, orderType };
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw inputError(`${label} must be a positive integer.`);
  }
  return normalized;
}

/** @param {unknown} value */
function optionalLocation(value) {
  if (value === null || value === undefined || value === "") {return null;}
  return positiveInteger(value, "Line location");
}

/** @param {unknown} value */
function positiveQuantity(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw inputError("Every selected NetSuite line requires a positive finite quantity.");
  }
  return Number(normalized.toFixed(6));
}

/** @param {unknown} value */
function hash(value) {
  return crypto.createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

/** @param {string} kind @param {string} transactionType */
function assertKindForTransaction(kind, transactionType) {
  if (!SOURCE_ORDER_KINDS.has(kind)
      || (transactionType === "IF" && !["SO", "TO"].includes(kind))
      || (transactionType === "IR" && !["PO", "TO"].includes(kind))) {
    throw inputError(`Source order kind ${kind || "(missing)"} cannot create ${transactionType}.`);
  }
}

/** @param {Record<string, unknown>} line */
function normalizedSelectedLine(line) {
  return {
    orderLine: positiveInteger(line.orderLine, "NetSuite order line"),
    quantity: positiveQuantity(line.quantity),
    location: optionalLocation(line.location),
    localOrderKey: requiredText(line.localOrderKey, "Local order key"),
    localLineId: requiredText(line.localLineId, "Local line ID")
  };
}

/** @param {Record<string, unknown>} line */
function normalizedAvailableLine(line) {
  return {
    orderLine: positiveInteger(line.orderLine, "Available NetSuite order line"),
    location: optionalLocation(line.location)
  };
}

/** @param {number | null} left @param {number | null} right */
function mergeLocation(left, right) {
  if (left !== null && right !== null && left !== right) {
    throw inputError("One NetSuite order line cannot use conflicting locations.");
  }
  return left ?? right;
}

/** @param {Record<string, unknown>} item */
function payloadItem(item) {
  const result = {
    orderLine: item.orderLine,
    ...(item.selected ? { quantity: item.quantity, itemReceive: true } : { itemReceive: false }),
    ...(item.location === null ? {} : { location: item.location })
  };
  return result;
}

/**
 * Build a canonical, immutable command draft. Callers must resolve every source
 * identity and transform line number from server-owned records first.
 *
 * @param {Record<string, any>} input
 */
// Canonicalization stays in one transaction-shaping function so the payload,
// input hash, line snapshot, and deterministic step order cannot drift apart.
// eslint-disable-next-line complexity
export function buildOperatorNetSuitePostingDraft(input = {}) {
  const requestId = String(input.requestId || "").trim().toLowerCase();
  operatorNetSuiteExternalId(requestId, 1);
  const actorOperatorId = requiredText(input.actorOperatorId, "Operator ID");
  const functionKey = requiredText(input.functionKey, "Operator function").toLowerCase();
  const transactionType = requiredText(input.transactionType, "NetSuite transaction type").toUpperCase();
  if (!['IF', 'IR'].includes(transactionType)) {throw inputError("NetSuite transaction type must be IF or IR.");}
  const policy = input.policy && typeof input.policy === "object" ? input.policy : null;
  if (!policy
      || policy.effective !== true
      || policy.functionKey !== functionKey
      || policy.transactionType !== transactionType
      || !requiredText(policy.gateKey, "Posting gate")
      || !Number.isSafeInteger(Number(policy.revision))
      || Number(policy.revision) <= 0) {
    throw inputError("An effective, matching Operator NetSuite posting policy is required.");
  }
  const claims = [...new Set((Array.isArray(input.localOrderKeys) ? input.localOrderKeys : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
  if (!claims.length) {throw inputError("At least one local order claim is required.");}
  const localOperation = normalizedLocalOperation(input.localOperation);
  if (!Array.isArray(input.targets) || !input.targets.length) {
    throw inputError("At least one NetSuite source target is required.");
  }

  const grouped = new Map();
  for (const rawTarget of input.targets) {
    if (!rawTarget || typeof rawTarget !== "object") {throw inputError("Every NetSuite target must be an object.");}
    const sourceOrderKind = requiredText(rawTarget.sourceOrderKind, "Source order kind").toUpperCase();
    assertKindForTransaction(sourceOrderKind, transactionType);
    const sourceNetSuiteId = positiveInteger(rawTarget.sourceNetSuiteId, "Source NetSuite ID");
    const sourceOrderRef = requiredText(rawTarget.sourceOrderRef, "Source order reference");
    const key = `${sourceOrderKind}:${sourceNetSuiteId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        sourceOrderKind,
        sourceNetSuiteId,
        sourceOrderRef,
        selectedByLine: new Map(),
        availableByLine: new Map(),
        lineSnapshot: []
      });
    }
    const group = grouped.get(key);
    if (group.sourceOrderRef !== sourceOrderRef) {
      throw inputError("One NetSuite source ID cannot use conflicting order references.");
    }
    const availableLines = Array.isArray(rawTarget.availableLines) ? rawTarget.availableLines : [];
    const selectedLines = Array.isArray(rawTarget.selectedLines) ? rawTarget.selectedLines : [];
    if (!availableLines.length || !selectedLines.length) {
      throw inputError("Every NetSuite target requires available and selected lines.");
    }
    for (const rawLine of availableLines) {
      const line = normalizedAvailableLine(rawLine);
      const current = group.availableByLine.get(line.orderLine);
      group.availableByLine.set(line.orderLine, {
        orderLine: line.orderLine,
        location: current ? mergeLocation(current.location, line.location) : line.location
      });
    }
    for (const rawLine of selectedLines) {
      const line = normalizedSelectedLine(rawLine);
      if (!group.availableByLine.has(line.orderLine)) {
        throw inputError("A selected NetSuite line is absent from the available source lines.");
      }
      const current = group.selectedByLine.get(line.orderLine);
      group.selectedByLine.set(line.orderLine, {
        orderLine: line.orderLine,
        quantity: Number(((current?.quantity || 0) + line.quantity).toFixed(6)),
        location: current ? mergeLocation(current.location, line.location) : line.location
      });
      group.lineSnapshot.push(line);
    }
  }

  const sortedGroups = [...grouped.values()].sort((left, right) => (
    left.sourceOrderKind.localeCompare(right.sourceOrderKind)
      || left.sourceNetSuiteId - right.sourceNetSuiteId
  ));
  const steps = sortedGroups.map((group, index) => {
    const stepIndex = index + 1;
    const externalId = operatorNetSuiteExternalId(requestId, stepIndex);
    const payloadLines = [...group.availableByLine.values()]
      .sort((left, right) => left.orderLine - right.orderLine)
      .map((available) => {
        const selected = group.selectedByLine.get(available.orderLine);
        return payloadItem(selected
          ? {
              ...selected,
              selected: true,
              location: mergeLocation(selected.location, available.location)
            }
          : { ...available, selected: false });
      });
    const payload = { externalId, item: { items: payloadLines } };
    const lineSnapshot = [...group.lineSnapshot].sort((left, right) => (
      left.orderLine - right.orderLine
        || left.localOrderKey.localeCompare(right.localOrderKey)
        || left.localLineId.localeCompare(right.localLineId)
    ));
    return {
      stepIndex,
      sourceOrderKind: group.sourceOrderKind,
      sourceNetSuiteId: group.sourceNetSuiteId,
      sourceOrderRef: group.sourceOrderRef,
      transactionType,
      externalId,
      payloadHash: hash(payload),
      payload,
      lineSnapshot
    };
  });
  const photoRefs = [...new Set((Array.isArray(input.photoRefs) ? input.photoRefs : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
  const normalizedPolicy = {
    gateKey: String(policy.gateKey),
    revision: Number(policy.revision),
    effective: true,
    functionKey,
    transactionType,
    locationId: positiveInteger(policy.locationId, "Canonical posting location"),
    yardCode: requiredText(policy.yardCode, "Canonical yard code")
  };
  const inputSnapshot = {
    requestId,
    actorOperatorId,
    functionKey,
    transactionType,
    policy: normalizedPolicy,
    photoRefs,
    claims,
    localOperation,
    steps
  };
  return {
    requestId,
    actorOperatorId,
    functionKey,
    transactionType,
    policy: normalizedPolicy,
    photoRefs,
    claims,
    localOperation,
    steps,
    inputHash: hash(inputSnapshot),
    inputSnapshot
  };
}
