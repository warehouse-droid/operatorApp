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

function remainingQuantity(row) {
  const explicit = firstPresent([row?.remainingQuantity, row?.remaining_quantity]);
  if (explicit !== undefined) {
    return roundQuantity(explicit);
  }
  return roundQuantity(
    finiteNumber(row?.quantity)
      - finiteNumber(firstPresent([row?.receivedQuantity, row?.received_quantity]))
      - finiteNumber(firstPresent([row?.cancelledQuantity, row?.cancelled_quantity]))
  );
}

export function smartScmPlanningPhaseOneDrafts(drafts, { mode = "integrated" } = {}) {
  if (mode !== "po_then_transfer") {
    return drafts;
  }
  return (Array.isArray(drafts) ? drafts : []).filter((draft) => (
    String(firstPresent([draft?.proposalType, draft?.proposal_type]) || "").toUpperCase() === "PO"
      && String(draft?.phase || "").toLowerCase() === "direct_vendor"
  ));
}

function expectedPoOrderRef(row) {
  const value = firstPresent([row.orderRef, row.order_ref, row.splitRef, row.split_ref]);
  return String(value === undefined ? "" : value).trim();
}

function expectedPoInactive(row) {
  return [row.orderActive, row.order_active, row.lineActive, row.line_active]
    .some((value) => value === false);
}

export function smartScmExpectedPoLineEligible(row) {
  if (!row) {
    return false;
  }
  if (!expectedPoOrderRef(row) || expectedPoInactive(row)) {
    return false;
  }
  if (row.closed === true || row.cancelled === true) {
    return false;
  }
  const status = String(firstPresent([row.orderStatus, row.order_status]) || "").trim().toLowerCase();
  if (/(closed|cancelled|fully received)/.test(status)) {
    return false;
  }
  return remainingQuantity(row) > 0;
}

function addInboundDelta(deltaMap, itemId, locationId, quantity) {
  const key = `${itemId}:${locationId}`;
  const current = deltaMap.get(key);
  if (current) {
    current.quantity = roundQuantity(current.quantity + quantity);
  } else {
    deltaMap.set(key, { itemId, locationId, quantity: roundQuantity(quantity) });
  }
}

function splitInboundLineEligible(line) {
  const active = firstPresent([line.active, line.lineActive, line.line_active]);
  if (active === false || line.closed === true || line.cancelled === true) {
    return false;
  }
  const status = String(firstPresent([line.status, line.orderStatus, line.order_status]) || "").toLowerCase();
  return !/(closed|cancelled|fully received)/.test(status);
}

function splitInboundRoute(line) {
  return {
    itemId: itemIdOf(line),
    sourceLocationId: firstPresent([line.sourceLocationId, line.source_location_id]),
    destinationLocationId: firstPresent([line.destinationLocationId, line.destination_location_id]),
    quantity: remainingQuantity(line)
  };
}

function splitInboundRouteValid(route, { sourceAlreadyExcluded = false } = {}) {
  const identifiers = [route.itemId, route.sourceLocationId, route.destinationLocationId];
  if (identifiers.some((value) => value === null || value === undefined)) {
    return false;
  }
  return route.quantity > 0 && (
    sourceAlreadyExcluded
    || String(route.sourceLocationId) !== String(route.destinationLocationId)
  );
}

export function smartScmSplitInboundOverlay({ lines = [] } = {}) {
  const deltaMap = new Map();
  const authoritativeDeltaMap = new Map();
  const releasedSplitInboundMap = new Map();
  const evidence = [];

  for (const line of Array.isArray(lines) ? lines : []) {
    if (!splitInboundLineEligible(line)) {
      continue;
    }
    const route = splitInboundRoute(line);
    const sourceAlreadyExcluded = line.sourceAlreadyExcluded === true
      || line.source_already_excluded === true;
    if (!splitInboundRouteValid(route, { sourceAlreadyExcluded })) {
      continue;
    }
    if (!sourceAlreadyExcluded) {
      addInboundDelta(deltaMap, route.itemId, route.sourceLocationId, -route.quantity);
      addInboundDelta(authoritativeDeltaMap, route.itemId, route.sourceLocationId, -route.quantity);
      addInboundDelta(authoritativeDeltaMap, route.itemId, route.destinationLocationId, route.quantity);
    } else {
      addInboundDelta(releasedSplitInboundMap, route.itemId, route.destinationLocationId, route.quantity);
    }
    addInboundDelta(deltaMap, route.itemId, route.destinationLocationId, route.quantity);
    evidence.push({
      splitRef: firstPresent([line.splitRef, line.split_ref, line.split_po_ref]) || null,
      ...route,
      sourceAlreadyExcluded
    });
  }

  return {
    deltas: [...deltaMap.values()].filter((row) => row.quantity !== 0),
    authoritativeDeltas: [...authoritativeDeltaMap.values()].filter((row) => row.quantity !== 0),
    releasedSplitInboundDeltas: [...releasedSplitInboundMap.values()].filter((row) => row.quantity !== 0),
    evidence
  };
}

export function smartScmApplyInboundOverlay({ balances = [], deltas = [] } = {}) {
  const result = (Array.isArray(balances) ? balances : []).map((row) => ({ ...row }));
  const byKey = new Map(result.map((row, index) => [`${itemIdOf(row)}:${locationIdOf(row)}`, index]));
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const itemId = itemIdOf(delta);
    const locationId = locationIdOf(delta);
    if (itemId === null || locationId === null) {
      continue;
    }
    const key = `${itemId}:${locationId}`;
    let index = byKey.get(key);
    if (index === undefined) {
      index = result.length;
      result.push({ itemId, locationId, quantityOnOrder: 0 });
      byKey.set(key, index);
    }
    const row = result[index];
    const current = finiteNumber(firstPresent([row.quantityOnOrder, row.quantity_on_order]));
    const next = roundQuantity(current + finiteNumber(delta.quantity));
    if (Object.hasOwn(row, "quantity_on_order")) {
      row.quantity_on_order = next;
    } else {
      row.quantityOnOrder = next;
    }
  }
  return result;
}
