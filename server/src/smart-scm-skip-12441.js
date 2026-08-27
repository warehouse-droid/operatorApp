const SKIPPED_LOCATION_ID = 15;
const SKIPPED_YARD_CODE = "12441";
const REDISTRIBUTION_LOCATIONS = Object.freeze({ SOB: 1, SOA: 28 });

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundQuantity(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function firstPresent(values = []) {
  return values.find((value) => value !== undefined && value !== null);
}

function itemIdOf(row) {
  const value = firstPresent([row?.itemId, row?.item_id]);
  return value === undefined ? null : value;
}

function locationIdOf(row) {
  const value = firstPresent([row?.locationId, row?.location_id]);
  return value === undefined ? null : value;
}

function quantityOf(row) {
  return finiteNumber(firstPresent([row?.quantity, row?.demandQuantity, row?.demand_quantity]));
}

function documentPrefix(row) {
  const reference = String(firstPresent([row?.documentRef, row?.document_ref]) || "").trim().toUpperCase();
  if (reference.startsWith("SOB")) {
    return "SOB";
  }
  if (reference.startsWith("SOA")) {
    return "SOA";
  }
  return null;
}

function ratioFrom(bucket) {
  const sob = finiteNumber(bucket?.SOB);
  const soa = finiteNumber(bucket?.SOA);
  const attributed = sob + soa;
  return attributed > 0 ? sob / attributed : null;
}

function projectedFact(template, { locationId, quantity, itemId, sequence }) {
  const row = { ...template };
  if (Object.hasOwn(row, "location_id")) {
    row.location_id = locationId;
  } else {
    row.locationId = locationId;
  }
  if (Object.hasOwn(row, "demand_quantity")) {
    row.demand_quantity = quantity;
  } else if (Object.hasOwn(row, "demandQuantity")) {
    row.demandQuantity = quantity;
  } else {
    row.quantity = quantity;
  }
  if (Object.hasOwn(row, "delivery_method")) {
    row.delivery_method = "pickup";
  } else if (Object.hasOwn(row, "deliveryMethod")) {
    row.deliveryMethod = "pickup";
  }
  const generatedRef = `SKIP12441-${itemId}-${sequence}`;
  if (Object.hasOwn(row, "document_ref")) {
    row.document_ref = generatedRef;
  } else if (Object.hasOwn(row, "documentRef")) {
    row.documentRef = generatedRef;
  }
  row.skip12441Projection = true;
  return row;
}

function skippedLocation(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return Number(value) === SKIPPED_LOCATION_ID || normalized === SKIPPED_YARD_CODE;
}

function collectProjectionInputs(input = []) {
  const itemAttribution = new Map();
  const companyAttribution = { SOB: 0, SOA: 0 };
  const groups = new Map();
  const preserved = [];
  for (const row of input) {
    if (!skippedLocation(locationIdOf(row))) {
      preserved.push(row);
      continue;
    }
    const itemId = itemIdOf(row);
    const quantity = quantityOf(row);
    const prefix = documentPrefix(row);
    if (prefix) {
      const bucket = itemAttribution.get(String(itemId)) || { SOB: 0, SOA: 0 };
      bucket[prefix] += quantity;
      companyAttribution[prefix] += quantity;
      itemAttribution.set(String(itemId), bucket);
    }
    const key = String(itemId);
    const group = groups.get(key) || { itemId, quantity: 0, rows: [] };
    group.quantity += quantity;
    group.rows.push(row);
    groups.set(key, group);
  }
  return { itemAttribution, companyAttribution, groups, preserved };
}

function redistributionRatio(itemAttribution, companyRatio, itemId) {
  const itemRatio = ratioFrom(itemAttribution.get(String(itemId)));
  if (itemRatio !== null) {
    return { sobRatio: itemRatio, ratioSource: "item" };
  }
  if (companyRatio !== null) {
    return { sobRatio: companyRatio, ratioSource: "company" };
  }
  return { sobRatio: 0.5, ratioSource: "equal" };
}

function projectDemandGroup({ group, itemAttribution, companyRatio, preserved, sequence }) {
  const { sobRatio, ratioSource } = redistributionRatio(itemAttribution, companyRatio, group.itemId);
  const originalQuantity = roundQuantity(group.quantity);
  const sobQuantity = roundQuantity(originalQuantity * sobRatio);
  const soaQuantity = roundQuantity(originalQuantity - sobQuantity);
  let allocatedSob = 0;
  let cumulativeQuantity = 0;
  let nextSequence = sequence;
  for (const [index, row] of group.rows.entries()) {
    const rowQuantity = quantityOf(row);
    cumulativeQuantity = roundQuantity(cumulativeQuantity + rowQuantity);
    const cumulativeSob = index === group.rows.length - 1
      ? sobQuantity
      : roundQuantity(cumulativeQuantity * sobRatio);
    const rowSob = roundQuantity(cumulativeSob - allocatedSob);
    const rowSoa = roundQuantity(rowQuantity - rowSob);
    allocatedSob = roundQuantity(allocatedSob + rowSob);
    nextSequence += 1;
    preserved.push(projectedFact(row, {
      locationId: REDISTRIBUTION_LOCATIONS.SOB,
      quantity: rowSob,
      itemId: group.itemId,
      sequence: `${nextSequence}-SOB`
    }));
    preserved.push(projectedFact(row, {
      locationId: REDISTRIBUTION_LOCATIONS.SOA,
      quantity: rowSoa,
      itemId: group.itemId,
      sequence: `${nextSequence}-SOA`
    }));
  }
  return {
    allocation: {
      itemId: group.itemId,
      originalQuantity,
      sobQuantity,
      soaQuantity,
      sobRatio: roundQuantity(sobRatio),
      ratioSource
    },
    sequence: nextSequence
  };
}

/**
 * Replaces demand attributed to 12441 with a deterministic 3445/2967
 * projection. The split is based on SOB:SOA demand for the item, then on the
 * same-window company mix, and finally on an even split. The final allocation
 * is calculated as a remainder so demand cannot disappear through rounding.
 */
export function smartScmBuild12441DemandProjection({ enabled = false, facts = [] } = {}) {
  if (!enabled) {
    return { facts, allocations: [] };
  }

  const input = Array.isArray(facts) ? facts : [];
  const { itemAttribution, companyAttribution, groups, preserved } = collectProjectionInputs(input);
  const companyRatio = ratioFrom(companyAttribution);
  const allocations = [];
  let sequence = 0;
  for (const group of groups.values()) {
    const projection = projectDemandGroup({
      group,
      itemAttribution,
      companyRatio,
      preserved,
      sequence
    });
    allocations.push(projection.allocation);
    sequence = projection.sequence;
  }

  return { facts: preserved, allocations };
}

function policyLocation(state) {
  const policy = Object(state?.policy);
  const direct = Object(state);
  return firstPresent([
    policy.location_id,
    policy.locationId,
    policy.yard_code,
    policy.yardCode,
    direct.locationId,
    direct.location_id,
    direct.yardCode,
    direct.yard_code
  ]);
}

export function smartScmApplySkip12441Policy(state, { enabled = false } = {}) {
  if (!enabled || !state) {
    return state;
  }
  if (!skippedLocation(policyLocation(state))) {
    return state;
  }

  return {
    ...state,
    safety: 0,
    rop: 0,
    preferred: 0,
    baseRop: 0,
    basePreferred: 0,
    requiredPallets: 0,
    sourceProtectedFloorPallets: 0,
    weeklyDemandPallets: 0,
    weeklyDemandSdPallets: 0,
    configuredMinimumSafetyPallets: 0,
    effectiveMinimumSafetyPallets: 0,
    standardSafetyStockPallets: 0,
    safetyStockPallets: 0,
    standardReorderPointPallets: 0,
    baseReorderPointPallets: 0,
    reorderPointPallets: 0,
    standardPreferredPallets: 0,
    basePreferredPallets: 0,
    preferredPallets: 0,
    coverageFloorPallets: 0,
    zeroDemandCoverageApplied: false,
    lowerStockPolicyApplied: false
  };
}

export function smartScmAutomaticDestinationAllowed(location, { skip12441Enabled = false } = {}) {
  return !skip12441Enabled || !skippedLocation(location);
}
