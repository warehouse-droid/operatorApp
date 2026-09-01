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

/** @param {unknown} value @param {string} label */
function optionalNonNegativeQuantity(value, label) {
  if (value === null || value === undefined || value === "") {return null;}
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw inputError(`${label} must be a non-negative finite quantity.`);
  }
  return Number(normalized.toFixed(6));
}

/** @param {unknown} value */
function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** @param {unknown[]} values */
function normalizedAliases(values) {
  return [...new Set(values
    .flat()
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/** @param {unknown} value */
function normalizedLinkedTransactions(value) {
  if (!Array.isArray(value)) {return [];}
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {throw inputError("Linked NetSuite transaction evidence must be an object.");}
    const id = positiveInteger(entry.id, "Linked NetSuite transaction ID");
    const ref = requiredText(entry.ref ?? id, "Linked NetSuite transaction reference");
    const type = requiredText(entry.type, "Linked NetSuite transaction type").toUpperCase();
    if (!["IF", "IR"].includes(type)) {throw inputError("Linked NetSuite transaction evidence must be IF or IR.");}
    const quantity = positiveQuantity(entry.quantity);
    return { id, ref, type, quantity };
  }).sort((left, right) => left.id - right.id || left.ref.localeCompare(right.ref));
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
  const sourceLineKey = optionalText(line.sourceLineKey);
  return {
    orderLine: positiveInteger(line.orderLine, "NetSuite order line"),
    quantity: positiveQuantity(line.quantity),
    location: optionalLocation(line.location),
    localOrderKey: requiredText(line.localOrderKey, "Local order key"),
    localLineId: requiredText(line.localLineId, "Local line ID"),
    ...(sourceLineKey ? { sourceLineKey } : {})
  };
}

/** @param {Record<string, unknown>} line */
function normalizedAvailableLine(line) {
  const sourceLineKey = optionalText(line.sourceLineKey) || String(positiveInteger(line.orderLine, "Available NetSuite order line"));
  const sourceLineAliases = normalizedAliases([line.sourceLineAliases || [], sourceLineKey]);
  return {
    orderLine: positiveInteger(line.orderLine, "Available NetSuite order line"),
    location: optionalLocation(line.location),
    sourceLineKey,
    sourceLineAliases,
    orderedQuantity: optionalNonNegativeQuantity(line.orderedQuantity, "Ordered NetSuite quantity"),
    completedQuantity: optionalNonNegativeQuantity(line.completedQuantity, "Completed NetSuite quantity"),
    remainingQuantity: optionalNonNegativeQuantity(line.remainingQuantity, "Remaining NetSuite quantity"),
    linkedTransactions: normalizedLinkedTransactions(line.linkedTransactions)
  };
}

/** @param {number | null} left @param {number | null} right @param {string} label */
function mergeOptionalQuantity(left, right, label) {
  if (left !== null && right !== null && Math.abs(left - right) > 0.000001) {
    throw inputError(`One NetSuite order line cannot use conflicting ${label}.`);
  }
  return left ?? right;
}

/** @param {Record<string, any>[]} left @param {Record<string, any>[]} right */
function mergeLinkedTransactions(left, right) {
  const merged = new Map();
  for (const entry of [...left, ...right]) {
    const key = `${entry.type}:${entry.id}:${entry.ref}`;
    const current = merged.get(key);
    if (current && Math.abs(current.quantity - entry.quantity) > 0.000001) {
      throw inputError("One linked NetSuite transaction cannot use conflicting quantities.");
    }
    merged.set(key, entry);
  }
  return [...merged.values()].sort((a, b) => a.id - b.id || a.ref.localeCompare(b.ref));
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
      if (current
          && current.sourceLineKey !== line.sourceLineKey
          && !current.sourceLineAliases.some((/** @type {string} */ alias) => line.sourceLineAliases.includes(alias))) {
        throw inputError("One NetSuite REST line cannot use conflicting stable source-line identities.");
      }
      group.availableByLine.set(line.orderLine, {
        orderLine: line.orderLine,
        location: current ? mergeLocation(current.location, line.location) : line.location,
        sourceLineKey: current?.sourceLineKey || line.sourceLineKey,
        sourceLineAliases: normalizedAliases([current?.sourceLineAliases || [], line.sourceLineAliases]),
        orderedQuantity: current
          ? mergeOptionalQuantity(current.orderedQuantity, line.orderedQuantity, "ordered quantities")
          : line.orderedQuantity,
        completedQuantity: current
          ? mergeOptionalQuantity(current.completedQuantity, line.completedQuantity, "completed quantities")
          : line.completedQuantity,
        remainingQuantity: current
          ? mergeOptionalQuantity(current.remainingQuantity, line.remainingQuantity, "remaining quantities")
          : line.remainingQuantity,
        linkedTransactions: current
          ? mergeLinkedTransactions(current.linkedTransactions, line.linkedTransactions)
          : line.linkedTransactions
      });
    }
    for (const rawLine of selectedLines) {
      const line = normalizedSelectedLine(rawLine);
      if (!group.availableByLine.has(line.orderLine)) {
        throw inputError("A selected NetSuite line is absent from the available source lines.");
      }
      const available = group.availableByLine.get(line.orderLine);
      if (line.sourceLineKey && !available.sourceLineAliases.includes(line.sourceLineKey)) {
        throw inputError("A selected stable source-line identity does not match its NetSuite REST line.");
      }
      const current = group.selectedByLine.get(line.orderLine);
      group.selectedByLine.set(line.orderLine, {
        orderLine: line.orderLine,
        quantity: Number(((current?.quantity || 0) + line.quantity).toFixed(6)),
        location: current ? mergeLocation(current.location, line.location) : line.location,
        sourceLineKey: current?.sourceLineKey || line.sourceLineKey || available.sourceLineKey
      });
      group.lineSnapshot.push(line);
    }
  }

  const sortedGroups = [...grouped.values()].sort((left, right) => (
    left.sourceOrderKind.localeCompare(right.sourceOrderKind)
      || left.sourceNetSuiteId - right.sourceNetSuiteId
  ));
  const plannedGroups = sortedGroups.map((group) => {
    const reconciliationLines = [];
    const postedByLine = new Map();
    for (const available of group.availableByLine.values()) {
      const selected = group.selectedByLine.get(available.orderLine);
      if (!selected) {continue;}
      const requestedQuantity = selected.quantity;
      if (available.orderedQuantity !== null
          && requestedQuantity > available.orderedQuantity + 0.000001) {
        throw inputError("A selected quantity exceeds the authoritative NetSuite source-line quantity.");
      }
      const authoritative = available.remainingQuantity !== null;
      const postedQuantity = Number((authoritative
        ? Math.min(requestedQuantity, available.remainingQuantity)
        : requestedQuantity).toFixed(6));
      const reconciledQuantity = Number(Math.max(requestedQuantity - postedQuantity, 0).toFixed(6));
      postedByLine.set(available.orderLine, postedQuantity);
      const localLines = group.lineSnapshot
        .filter((/** @type {Record<string, any>} */ line) => line.orderLine === available.orderLine)
        .map((/** @type {Record<string, any>} */ line) => ({
          localOrderKey: line.localOrderKey,
          localLineId: line.localLineId,
          quantity: line.quantity,
          ...(line.sourceLineKey ? { sourceLineKey: line.sourceLineKey } : {})
        })).sort((/** @type {Record<string, any>} */ left, /** @type {Record<string, any>} */ right) => left.localOrderKey.localeCompare(right.localOrderKey)
          || left.localLineId.localeCompare(right.localLineId));
      reconciliationLines.push({
        sourceOrderKind: group.sourceOrderKind,
        sourceNetSuiteId: group.sourceNetSuiteId,
        sourceOrderRef: group.sourceOrderRef,
        orderLine: available.orderLine,
        sourceLineKey: available.sourceLineKey,
        sourceLineAliases: available.sourceLineAliases,
        requestedQuantity,
        postedQuantity,
        reconciledQuantity,
        authoritative,
        orderedQuantity: available.orderedQuantity,
        completedQuantity: available.completedQuantity,
        remainingQuantityBefore: available.remainingQuantity,
        remainingQuantityAfter: authoritative
          ? Number(Math.max(available.remainingQuantity - postedQuantity, 0).toFixed(6))
          : null,
        linkedTransactions: available.linkedTransactions,
        localLines
      });
    }
    const payloadLines = [...group.availableByLine.values()]
      .sort((left, right) => left.orderLine - right.orderLine)
      .map((available) => {
        const selected = group.selectedByLine.get(available.orderLine);
        const postedQuantity = postedByLine.get(available.orderLine) || 0;
        return payloadItem(selected && postedQuantity > 0
          ? {
              ...selected,
              quantity: postedQuantity,
              selected: true,
              location: mergeLocation(selected.location, available.location)
            }
          : { ...available, selected: false });
      });
    const lineSnapshot = [...group.lineSnapshot].sort((left, right) => (
      left.orderLine - right.orderLine
        || left.localOrderKey.localeCompare(right.localOrderKey)
        || left.localLineId.localeCompare(right.localLineId)
    ));
    return {
      group,
      payloadLines,
      lineSnapshot,
      reconciliationLines,
      hasPost: [...postedByLine.values()].some((quantity) => quantity > 0)
    };
  });
  const postingPlans = plannedGroups.filter((plan) => plan.hasPost);
  const steps = postingPlans.map((plan, index) => {
    const { group, payloadLines, lineSnapshot } = plan;
    const stepIndex = index + 1;
    const externalId = operatorNetSuiteExternalId(requestId, stepIndex);
    const payload = { externalId, item: { items: payloadLines } };
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
  const lineReconciliation = {
    schemaVersion: "operator-netsuite-line-reconciliation-v1",
    lines: plannedGroups.flatMap((plan) => plan.reconciliationLines).sort((left, right) => (
      left.sourceOrderKind.localeCompare(right.sourceOrderKind)
        || left.sourceNetSuiteId - right.sourceNetSuiteId
        || left.orderLine - right.orderLine
        || left.sourceLineKey.localeCompare(right.sourceLineKey, undefined, { numeric: true })
    ))
  };
  const localPayload = input.localPayload === undefined || input.localPayload === null
    ? null
    : canonicalValue(input.localPayload);
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
    localPayload,
    lineReconciliation,
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
    localPayload,
    lineReconciliation,
    steps,
    inputHash: hash(inputSnapshot),
    inputSnapshot
  };
}
