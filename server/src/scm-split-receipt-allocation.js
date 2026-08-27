import {
  allocateReconciliationProgress,
  reconciliationQuantity,
  roundReconciliationQuantity
} from "./scm-reconciliation.js";

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
    conflict ||= bucket.conflict || bucket.overflowQty > EPSILON;
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
    conflict ||= fallback.conflict || fallback.overflowQty > EPSILON;
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
