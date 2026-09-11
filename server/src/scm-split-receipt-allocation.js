import {
  allocateReconciliationProgress,
  reconciliationQuantity,
  roundReconciliationQuantity
} from "./scm-reconciliation.js";
import { allocateScmReceiptRowsBySplitReference } from "./scm-ir-split-reference.js";

const EPSILON = 0.000001;

function positiveLocationId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function receiptLocationId(row = {}) {
  return positiveLocationId(
    row.actualLocationId
    ?? row.lineActualLocationId
    ?? row.line_actual_location_id
    ?? row.actual_location_id
    ?? row.locationId
    ?? row.location_id
  );
}

function mergeAllocationMethod(current, next) {
  if (!current) return next;
  return current === next ? current : "inferred";
}

function remainingTargets(targets, allocations, predicate = () => true) {
  return targets
    .filter((target) => predicate(target))
    .map((target) => {
      const allocatedQty = allocations[target._allocationIndex].allocatedQty;
      return {
        ...target,
        requestedQty: roundReconciliationQuantity(Math.max(
          reconciliationQuantity(target.requestedQty) - allocatedQty,
          0
        )),
        exactReceivedQty: roundReconciliationQuantity(Math.max(
          reconciliationQuantity(target.exactReceivedQty) - allocatedQty,
          0
        ))
      };
    })
    .filter((target) => target.requestedQty > EPSILON);
}

function applyAllocation(result, allocations) {
  for (const row of result.allocations) {
    if (reconciliationQuantity(row.allocatedQty) <= EPSILON) continue;
    const target = allocations[row._allocationIndex];
    target.allocatedQty = roundReconciliationQuantity(
      target.allocatedQty + reconciliationQuantity(row.allocatedQty)
    );
    target.allocationMethod = mergeAllocationMethod(
      target.allocationMethod,
      row.allocationMethod
    );
  }
}

function unallocatedExactQuantity(targets, allocations) {
  return roundReconciliationQuantity(targets.reduce((sum, target) => {
    const required = Math.min(
      reconciliationQuantity(target.exactReceivedQty),
      reconciliationQuantity(target.requestedQty)
    );
    return sum + Math.max(required - allocations[target._allocationIndex].allocatedQty, 0);
  }, 0));
}

function dateKey(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function receiptDateKey(row = {}) {
  return dateKey(
    row.transactionDate
    ?? row.transaction_date
    ?? row.trandate
    ?? row.snapshot?.transactionDate
    ?? row.snapshot?.transaction_date
    ?? row.snapshot?.trandate
    ?? row.netsuiteModifiedAt
    ?? row.netsuite_modified_at
  );
}

function targetExistedForReceipt(target, receiptDate) {
  if (target.isParent === true || !receiptDate) return true;
  const createdDate = dateKey(target.createdAt);
  return !createdDate || createdDate <= receiptDate;
}

function remainingExactTargets(targets, allocations, predicate = () => true) {
  return remainingTargets(targets, allocations, predicate)
    .map((target) => ({
      ...target,
      requestedQty: Math.min(target.requestedQty, target.exactReceivedQty)
    }))
    .filter((target) => target.requestedQty > EPSILON);
}

function exactQuantityRemaining(target, allocations) {
  const required = Math.min(
    reconciliationQuantity(target.exactReceivedQty),
    reconciliationQuantity(target.requestedQty)
  );
  return roundReconciliationQuantity(Math.max(
    required - reconciliationQuantity(allocations[target._allocationIndex]?.allocatedQty),
    0
  ));
}

function applyStage(quantity, candidates, allocations, parentRef, {
  inferredOnly = false
} = {}) {
  const available = roundReconciliationQuantity(quantity);
  if (available <= EPSILON || !candidates.length) return available;
  const stageTargets = inferredOnly
    ? candidates.map((target) => ({ ...target, exactReceivedQty: 0, pinned: false }))
    : candidates;
  const result = allocateReconciliationProgress(available, stageTargets, {
    exactField: "exactReceivedQty",
    parentRef
  });
  applyAllocation(result, allocations);
  return roundReconciliationQuantity(result.overflowQty);
}

function usesEvidenceProtectedAllocation(targets) {
  return targets.some((target) => (
    Object.prototype.hasOwnProperty.call(target, "allowInferredReceipt")
    || Object.prototype.hasOwnProperty.call(target, "operationallyCompleted")
  ));
}

function allocateEvidenceProtectedReceipts({
  total,
  normalizedTargets,
  allocations,
  receiptRows,
  parentRef
}) {
  const allReceiptRows = Array.isArray(receiptRows) ? receiptRows : [];
  const referenceAllocation = allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: total,
    targets: normalizedTargets,
    receiptRows: allReceiptRows
  });
  for (const [index, allocatedQty] of referenceAllocation.allocations.entries()) {
    if (reconciliationQuantity(allocatedQty) <= EPSILON) continue;
    allocations[index].allocatedQty = roundReconciliationQuantity(allocatedQty);
    allocations[index].allocationMethod = "exact";
  }

  const observedRows = allReceiptRows
    .map((row, index) => ({
      row,
      index,
      quantity: roundReconciliationQuantity(row?.quantity),
      locationId: receiptLocationId(row),
      receiptDate: receiptDateKey(row)
    }))
    .filter((entry) => entry.quantity > EPSILON);
  const observedRowTotal = roundReconciliationQuantity(
    observedRows.reduce((sum, entry) => sum + entry.quantity, 0)
  );
  const rows = referenceAllocation.remainingReceiptRows
    .map((row, index) => ({
      row,
      index,
      quantity: roundReconciliationQuantity(row?.quantity),
      locationId: receiptLocationId(row),
      receiptDate: receiptDateKey(row)
    }))
    .filter((entry) => entry.quantity > EPSILON);
  const knownRows = rows
    .filter((entry) => entry.locationId)
    .sort((left, right) => (
      (left.receiptDate || "9999-12-31").localeCompare(right.receiptDate || "9999-12-31")
      || left.locationId - right.locationId
      || String(left.row?.transactionRef || left.row?.transaction_ref || "").localeCompare(
        String(right.row?.transactionRef || right.row?.transaction_ref || ""),
        undefined,
        { numeric: true, sensitivity: "base" }
      )
      || left.index - right.index
    ));

  let knownQuantityBudget = referenceAllocation.remainingTotalQty;
  let allocatedKnownBudget = 0;
  let unallocatedKnownBudget = 0;
  const unexplainedByLocation = new Map();
  const preparedRows = knownRows.map((entry) => {
    const budget = roundReconciliationQuantity(Math.min(
      entry.quantity,
      Math.max(knownQuantityBudget, 0)
    ));
    knownQuantityBudget = roundReconciliationQuantity(Math.max(knownQuantityBudget - budget, 0));
    allocatedKnownBudget = roundReconciliationQuantity(allocatedKnownBudget + budget);
    return { ...entry, budget, remaining: budget };
  });
  const rowsByDate = new Map();
  for (const entry of preparedRows) {
    const key = entry.receiptDate || "unknown";
    if (!rowsByDate.has(key)) rowsByDate.set(key, []);
    rowsByDate.get(key).push(entry);
  }

  for (const entries of rowsByDate.values()) {
    for (const entry of entries) {
      entry.remaining = applyStage(
        entry.remaining,
        remainingExactTargets(
          normalizedTargets,
          allocations,
          (target) => target.destinationLocationId === entry.locationId
        ),
        allocations,
        parentRef
      );
    }

    const completedForReceipt = (target) => (
      target.operationallyCompleted === true
      && target.allowInferredReceipt !== false
      && exactQuantityRemaining(target, allocations) <= EPSILON
    );
    for (const entry of entries) {
      entry.remaining = applyStage(
        entry.remaining,
        remainingTargets(
          normalizedTargets,
          allocations,
          (target) => target.destinationLocationId === entry.locationId
            && completedForReceipt(target)
        ),
        allocations,
        parentRef,
        { inferredOnly: true }
      );
    }

    const groupAvailable = roundReconciliationQuantity(
      entries.reduce((sum, entry) => sum + entry.remaining, 0)
    );
    const groupRemaining = applyStage(
      groupAvailable,
      remainingTargets(normalizedTargets, allocations, completedForReceipt),
      allocations,
      parentRef,
      { inferredOnly: true }
    );
    let crossLocationApplied = roundReconciliationQuantity(groupAvailable - groupRemaining);
    for (const entry of entries) {
      if (crossLocationApplied <= EPSILON) break;
      const consumed = Math.min(entry.remaining, crossLocationApplied);
      entry.remaining = roundReconciliationQuantity(entry.remaining - consumed);
      crossLocationApplied = roundReconciliationQuantity(crossLocationApplied - consumed);
    }

    for (const entry of entries) {
      const unfinishedAtLocation = remainingTargets(
        normalizedTargets,
        allocations,
        (target) => target.destinationLocationId === entry.locationId
          && target.allowInferredReceipt !== false
          && target.operationallyCompleted !== true
          && (
            target.requireUniqueLocationReceipt === true
            || targetExistedForReceipt(target, entry.receiptDate)
          )
          && exactQuantityRemaining(target, allocations) <= EPSILON
      );
      const locationCandidates = unfinishedAtLocation.some(
        (target) => target.requireUniqueLocationReceipt === true
      ) && unfinishedAtLocation.length !== 1
        ? []
        : unfinishedAtLocation;
      entry.remaining = applyStage(
        entry.remaining,
        locationCandidates,
        allocations,
        parentRef,
        { inferredOnly: true }
      );
    }

    const sourceResidualAvailable = roundReconciliationQuantity(
      entries.reduce((sum, entry) => sum + entry.remaining, 0)
    );
    const sourceResidualRemaining = applyStage(
      sourceResidualAvailable,
      remainingTargets(
        normalizedTargets,
        allocations,
        (target) => target.isParent === true
          && target.allowInferredReceipt !== false
          && exactQuantityRemaining(target, allocations) <= EPSILON
      ),
      allocations,
      parentRef,
      { inferredOnly: true }
    );
    let sourceResidualApplied = roundReconciliationQuantity(
      sourceResidualAvailable - sourceResidualRemaining
    );
    for (const entry of entries) {
      if (sourceResidualApplied <= EPSILON) break;
      const consumed = Math.min(entry.remaining, sourceResidualApplied);
      entry.remaining = roundReconciliationQuantity(entry.remaining - consumed);
      sourceResidualApplied = roundReconciliationQuantity(sourceResidualApplied - consumed);
    }
  }

  for (const entry of preparedRows) {
    unallocatedKnownBudget = roundReconciliationQuantity(
      unallocatedKnownBudget + entry.remaining
    );
    const unexplained = roundReconciliationQuantity(
      entry.quantity - (entry.budget - entry.remaining)
    );
    if (unexplained <= EPSILON) continue;
    unexplainedByLocation.set(
      entry.locationId,
      roundReconciliationQuantity((unexplainedByLocation.get(entry.locationId) || 0) + unexplained)
    );
  }

  let unlocatedQty = roundReconciliationQuantity(Math.max(
    referenceAllocation.remainingTotalQty - allocatedKnownBudget,
    0
  ));
  unlocatedQty = applyStage(
    unlocatedQty,
    remainingExactTargets(normalizedTargets, allocations),
    allocations,
    parentRef
  );
  unlocatedQty = applyStage(
    unlocatedQty,
    remainingTargets(
      normalizedTargets,
      allocations,
      (target) => target.operationallyCompleted === true
        && target.allowInferredReceipt !== false
        && exactQuantityRemaining(target, allocations) <= EPSILON
    ),
    allocations,
    parentRef,
    { inferredOnly: true }
  );
  unlocatedQty = applyStage(
    unlocatedQty,
    remainingTargets(
      normalizedTargets,
      allocations,
      (target) => target.allowInferredReceipt !== false
        && target.operationallyCompleted !== true
        && exactQuantityRemaining(target, allocations) <= EPSILON
    ),
    allocations,
    parentRef,
    { inferredOnly: true }
  );

  const unallocatedExactQty = unallocatedExactQuantity(normalizedTargets, allocations);
  const overflowQty = roundReconciliationQuantity(
    Math.max(observedRowTotal - total, 0)
    + referenceAllocation.referenceOverflowQty
    + unallocatedKnownBudget
    + unlocatedQty
  );
  return {
    total,
    exactTotal: roundReconciliationQuantity(normalizedTargets.reduce(
      (sum, target) => sum + Math.min(target.exactReceivedQty, target.requestedQty),
      0
    )),
    unallocatedExactQty,
    overflowQty,
    conflict: overflowQty > EPSILON || unallocatedExactQty > EPSILON,
    allocations: allocations.map(({ _allocationIndex, ...allocation }) => allocation),
    locationAware: knownRows.length > 0,
    referenceAware: referenceAllocation.referencedRowCount > 0,
    referencedRowCount: referenceAllocation.referencedRowCount,
    unexplainedReferences: referenceAllocation.unexplainedReferences,
    unexplainedLocations: [...unexplainedByLocation.entries()]
      .map(([locationId, quantity]) => ({ locationId, quantity }))
      .sort((left, right) => left.locationId - right.locationId)
  };
}

/**
 * Allocates source-PO receipt progress without allowing a known receipt yard
 * to consume a split child's capacity at a different yard. Unknown-location
 * quantity deliberately retains the existing conservative aggregate policy.
 */
export function allocateSplitReceiptsByDestination({
  totalReceivedQty = 0,
  targets = [],
  receiptRows = [],
  exactField = "exactReceivedQty",
  parentRef = ""
} = {}) {
  const total = roundReconciliationQuantity(totalReceivedQty);
  const normalizedTargets = (Array.isArray(targets) ? targets : []).map((target, index) => ({
    ...target,
    _allocationIndex: index,
    requestedQty: roundReconciliationQuantity(target.requestedQty),
    exactReceivedQty: roundReconciliationQuantity(target[exactField]),
    destinationLocationId: positiveLocationId(target.destinationLocationId)
  }));
  const allocations = normalizedTargets.map((target) => ({
    ...target,
    allocatedQty: 0,
    allocationMethod: ""
  }));

  if (usesEvidenceProtectedAllocation(normalizedTargets)) {
    return allocateEvidenceProtectedReceipts({
      total,
      normalizedTargets,
      allocations,
      receiptRows,
      parentRef
    });
  }

  const quantitiesByLocation = new Map();
  let observedRowTotal = 0;
  for (const row of Array.isArray(receiptRows) ? receiptRows : []) {
    const quantity = roundReconciliationQuantity(row?.quantity);
    if (quantity <= EPSILON) continue;
    observedRowTotal = roundReconciliationQuantity(observedRowTotal + quantity);
    const locationId = receiptLocationId(row);
    if (!locationId) continue;
    quantitiesByLocation.set(
      locationId,
      roundReconciliationQuantity((quantitiesByLocation.get(locationId) || 0) + quantity)
    );
  }

  if (!quantitiesByLocation.size) {
    const legacy = allocateReconciliationProgress(total, normalizedTargets, {
      exactField: "exactReceivedQty",
      parentRef
    });
    const legacyAllocations = legacy.allocations.map(({ _allocationIndex, ...allocation }) => allocation);
    return {
      ...legacy,
      allocations: legacyAllocations,
      unallocatedExactQty: roundReconciliationQuantity(normalizedTargets.reduce((sum, target, index) => {
        const required = Math.min(target.exactReceivedQty, target.requestedQty);
        return sum + Math.max(required - legacy.allocations[index].allocatedQty, 0);
      }, 0)),
      locationAware: false,
      unexplainedLocations: []
    };
  }

  let knownQuantityBudget = total;
  let allocatedKnownBudget = 0;
  let overflowQty = roundReconciliationQuantity(Math.max(observedRowTotal - total, 0));
  let conflict = overflowQty > EPSILON;
  const unexplainedLocations = [];

  for (const [locationId, observedQuantity] of [...quantitiesByLocation.entries()]
    .sort(([left], [right]) => left - right)) {
    const bucketQty = roundReconciliationQuantity(Math.min(
      observedQuantity,
      Math.max(knownQuantityBudget, 0)
    ));
    knownQuantityBudget = roundReconciliationQuantity(Math.max(knownQuantityBudget - bucketQty, 0));
    allocatedKnownBudget = roundReconciliationQuantity(allocatedKnownBudget + bucketQty);
    const eligible = remainingTargets(
      normalizedTargets,
      allocations,
      (target) => target.destinationLocationId === locationId
    );
    const bucket = allocateReconciliationProgress(bucketQty, eligible, {
      exactField: "exactReceivedQty",
      parentRef
    });
    applyAllocation(bucket, allocations);
    const unexplained = roundReconciliationQuantity(
      Math.max(observedQuantity - (bucketQty - bucket.overflowQty), 0)
    );
    if (unexplained > EPSILON) {
      unexplainedLocations.push({ locationId, quantity: unexplained });
    }
    overflowQty = roundReconciliationQuantity(overflowQty + bucket.overflowQty);
    // An exact child quantity can be larger than the linked rows currently
    // available for its yard. The remaining authoritative parent progress is
    // allocated below, so a bucket-level exact shortfall is only provisional.
    // Final unallocatedExactQty is the family-wide fail-closed check.
    conflict ||= bucket.overflowQty > EPSILON;
  }

  const unlocatedQty = roundReconciliationQuantity(Math.max(total - allocatedKnownBudget, 0));
  if (unlocatedQty > EPSILON) {
    const fallbackTargets = remainingTargets(normalizedTargets, allocations);
    const fallback = allocateReconciliationProgress(unlocatedQty, fallbackTargets, {
      exactField: "exactReceivedQty",
      parentRef
    });
    applyAllocation(fallback, allocations);
    overflowQty = roundReconciliationQuantity(overflowQty + fallback.overflowQty);
    conflict ||= fallback.overflowQty > EPSILON;
  }

  const unallocatedExactQty = unallocatedExactQuantity(normalizedTargets, allocations);
  conflict ||= unallocatedExactQty > EPSILON;

  return {
    total,
    exactTotal: roundReconciliationQuantity(normalizedTargets.reduce(
      (sum, target) => sum + Math.min(target.exactReceivedQty, target.requestedQty),
      0
    )),
    unallocatedExactQty,
    overflowQty,
    conflict,
    allocations: allocations.map(({ _allocationIndex, ...allocation }) => allocation),
    locationAware: true,
    unexplainedLocations
  };
}
