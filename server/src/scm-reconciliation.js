const EPSILON = 0.000001;

export function reconciliationQuantity(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function roundReconciliationQuantity(value) {
  return Number(reconciliationQuantity(value).toFixed(6));
}

function normalizedStatusText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function classifyNetSuiteLifecycle(statusText = "") {
  const text = normalizedStatusText(statusText);
  return {
    text,
    cancelled: /\b(cancelled|canceled|voided|void)\b/.test(text),
    closed: /\bclosed\b/.test(text) || /\bfully billed\b/.test(text),
    partiallyReceived: /\bpartially received\b/.test(text),
    partiallyFulfilled: /\bpartially fulfilled\b/.test(text),
    pendingReceipt: /\bpending receipt\b/.test(text),
    pendingFulfillment: /\bpending fulfillment\b/.test(text)
  };
}

function quantitiesConflict({ kind, ordered, fulfilled, received, fullyReceived }) {
  return received > ordered + EPSILON
    || fulfilled > ordered + EPSILON
    || (kind === "TO" && !fullyReceived && received > fulfilled + EPSILON);
}

function preservedQueueStatus(status = "Queued") {
  const value = String(status || "").trim();
  if (["Completed", "Cancelled", "Partially Done", "In Transit", "Reconcile Review"].includes(value)) {
    return "Queued";
  }
  return value || "Queued";
}

export function derivePoToReconciliationState({
  kind,
  statusText = "",
  orderedQty = 0,
  fulfilledQty = 0,
  receivedQty = 0,
  previousStatus = "Queued",
  previousReceivedQty = 0,
  hasActivePlan = false,
  hasOperationalActivity = false,
  explicitReviewReason = ""
} = {}) {
  const orderKind = String(kind || "").trim().toUpperCase();
  if (!["PO", "TO"].includes(orderKind)) {
    throw new Error("PO or TO reconciliation kind is required.");
  }

  const ordered = roundReconciliationQuantity(orderedQty);
  const fulfilled = orderKind === "TO" ? roundReconciliationQuantity(fulfilledQty) : 0;
  const received = roundReconciliationQuantity(receivedQty);
  const previousReceived = roundReconciliationQuantity(previousReceivedQty);
  const lifecycle = classifyNetSuiteLifecycle(statusText);
  const hasProgress = fulfilled > EPSILON || received > EPSILON || hasOperationalActivity;
  const fullyReceived = ordered > EPSILON && received + EPSILON >= ordered;
  const fullyFulfilled = orderKind === "TO" && ordered > EPSILON && fulfilled + EPSILON >= ordered;
  const queueRemaining = lifecycle.closed || lifecycle.cancelled || fullyReceived
    ? 0
    : Math.max(ordered - (orderKind === "TO" ? fulfilled : received), 0);
  const destinationRemaining = lifecycle.closed || lifecycle.cancelled
    ? 0
    : Math.max(ordered - received, 0);
  const abandoned = lifecycle.closed
    ? Math.max(ordered - received, 0)
    : 0;

  let applicationStatus = preservedQueueStatus(previousStatus);
  let reconciliationStatus = "ok";
  let reason = "";

  if (explicitReviewReason) {
    applicationStatus = "Reconcile Review";
    reconciliationStatus = "review";
    reason = String(explicitReviewReason);
  } else if (quantitiesConflict({
    kind: orderKind,
    ordered,
    fulfilled,
    received,
    fullyReceived
  })) {
    applicationStatus = "Reconcile Review";
    reconciliationStatus = "review";
    reason = "NetSuite progress exceeds the current ordered quantity or destination receipt exceeds fulfillment.";
  } else if (
    String(previousStatus) === "Completed"
    && previousReceived > received + EPSILON
    && !fullyReceived
  ) {
    applicationStatus = "Reconcile Review";
    reconciliationStatus = "review";
    reason = "A previously completed order lost destination receipt evidence.";
  } else if (lifecycle.cancelled) {
    if (fullyReceived) {
      applicationStatus = "Completed";
    } else if (hasProgress) {
      applicationStatus = "Reconcile Review";
      reconciliationStatus = "review";
      reason = "NetSuite cancelled or voided an order that has partial operational progress.";
    } else {
      applicationStatus = "Cancelled";
    }
  } else if (lifecycle.closed) {
    if (orderKind === "TO" && fulfilled > EPSILON && received <= EPSILON) {
      applicationStatus = "Reconcile Review";
      reconciliationStatus = "review";
      reason = "The closed transfer has source fulfillment but no destination receipt.";
    } else if (received > EPSILON || fullyReceived) {
      applicationStatus = "Completed";
    } else {
      applicationStatus = "Cancelled";
    }
  } else if (fullyReceived) {
    applicationStatus = "Completed";
  } else if (String(previousStatus) === "Cancelled" && hasProgress) {
    applicationStatus = "Reconcile Review";
    reconciliationStatus = "review";
    reason = "A locally cancelled order has partial NetSuite progress.";
  } else if (orderKind === "TO" && fullyFulfilled && received <= EPSILON) {
    applicationStatus = "In Transit";
  } else if (hasProgress) {
    applicationStatus = "Partially Done";
  }

  return {
    applicationStatus,
    reconciliationStatus,
    reason,
    quantities: {
      ordered,
      fulfilled,
      received,
      abandoned: roundReconciliationQuantity(abandoned),
      remaining: roundReconciliationQuantity(queueRemaining),
      destinationRemaining: roundReconciliationQuantity(destinationRemaining)
    },
    lifecycle
  };
}

function allocationSortValue(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function compareReconciliationAllocationPriority(left = {}, right = {}) {
  if (Boolean(left.isParent) !== Boolean(right.isParent)) return left.isParent ? 1 : -1;
  const leftDispatched = allocationSortValue(left.actualDispatchAt, Number.MAX_SAFE_INTEGER);
  const rightDispatched = allocationSortValue(right.actualDispatchAt, Number.MAX_SAFE_INTEGER);
  if (leftDispatched !== rightDispatched) return leftDispatched - rightDispatched;

  const leftEta = allocationSortValue(left.plannedEta, Number.MAX_SAFE_INTEGER);
  const rightEta = allocationSortValue(right.plannedEta, Number.MAX_SAFE_INTEGER);
  if (leftEta !== rightEta) return leftEta - rightEta;

  const leftCreated = allocationSortValue(left.createdAt, Number.MAX_SAFE_INTEGER);
  const rightCreated = allocationSortValue(right.createdAt, Number.MAX_SAFE_INTEGER);
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;

  return String(left.ref || "").localeCompare(String(right.ref || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

export function allocateReconciliationProgress(totalQty, children = [], {
  exactField = "exactQty",
  parentRef = ""
} = {}) {
  const total = roundReconciliationQuantity(totalQty);
  const normalized = children.map((child, index) => ({
    ...child,
    index,
    requestedQty: roundReconciliationQuantity(child.requestedQty),
    exactQty: roundReconciliationQuantity(child[exactField])
  }));
  const allocations = new Map(normalized.map((child) => [child.index, {
    ...child,
    allocatedQty: 0,
    allocationMethod: ""
  }]));

  let remaining = total;
  let exactTotal = 0;
  for (const child of normalized) {
    const exact = Math.min(child.exactQty, child.requestedQty);
    if (exact <= EPSILON) continue;
    const applied = Math.min(exact, remaining);
    const allocation = allocations.get(child.index);
    allocation.allocatedQty = roundReconciliationQuantity(applied);
    allocation.allocationMethod = child.pinned ? "pinned" : "exact";
    remaining = roundReconciliationQuantity(Math.max(remaining - applied, 0));
    exactTotal = roundReconciliationQuantity(exactTotal + exact);
  }

  const candidates = normalized
    .filter((child) => child.requestedQty - allocations.get(child.index).allocatedQty > EPSILON)
    .sort(compareReconciliationAllocationPriority);
  for (const child of candidates) {
    if (remaining <= EPSILON) break;
    const allocation = allocations.get(child.index);
    const capacity = Math.max(child.requestedQty - allocation.allocatedQty, 0);
    const applied = Math.min(capacity, remaining);
    if (applied <= EPSILON) continue;
    allocation.allocatedQty = roundReconciliationQuantity(allocation.allocatedQty + applied);
    allocation.allocationMethod = allocation.allocationMethod || "inferred";
    remaining = roundReconciliationQuantity(Math.max(remaining - applied, 0));
  }

  return {
    total,
    exactTotal,
    overflowQty: roundReconciliationQuantity(remaining),
    conflict: exactTotal > total + EPSILON,
    allocations: normalized
      .sort((left, right) => left.index - right.index)
      .map((child) => allocations.get(child.index))
  };
}

export function rollupReconciliationGroup(members = []) {
  const active = members.filter((member) => String(member.status || "") !== "Cancelled");
  if (members.some((member) => String(member.reconciliationStatus || "") === "review")) {
    return { applicationStatus: "Reconcile Review", reconciliationStatus: "review" };
  }
  if (!active.length || active.every((member) => String(member.status || "") === "Completed")) {
    return { applicationStatus: "Completed", reconciliationStatus: "ok" };
  }
  const hasProgress = active.some((member) =>
    ["Completed", "Partially Done", "In Transit"].includes(String(member.status || ""))
  );
  return {
    applicationStatus: hasProgress ? "Partially Done" : "Queued",
    reconciliationStatus: "ok"
  };
}
