import {
  dispatchLocationKey,
  dispatchLocationRoot,
  dispatchLocationsShareYard,
  uniqueDispatchLocations
} from "./dispatch-location.js";

const DEFAULT_SWITCH_MINUTES = 10;
const DEFAULT_OWN_YARDS = ["3445", "2967", "12441", "150"];
const DEFAULT_OWN_YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  "150": "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada"
};

function text(value) {
  return String(value ?? "").trim();
}

function key(value) {
  const normalized = text(value).toLowerCase();
  return normalized === "unassigned" ? "" : normalized;
}

function yardCode(value) {
  if (value && typeof value === "object") {
    return text(value.code || value.name || value.id);
  }
  return text(value);
}

export function dispatchOwnYardCodes(plan = {}, configuredOwnYards = null) {
  const planCandidates = [
    plan.ownYardCodes,
    plan.ownYards,
    plan.summary?.ownYardCodes,
    plan.summary?.ownYards,
    plan.summary?.dispatchPlanFormat?.ownYardCodes
  ];
  const source = Array.isArray(configuredOwnYards) && configuredOwnYards.length
    ? configuredOwnYards
    : planCandidates.find((candidate) => Array.isArray(candidate) && candidate.length)
      || DEFAULT_OWN_YARDS;
  return [...new Set(source.map(yardCode).filter(Boolean))];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function dispatchMinute(value) {
  const direct = finiteNumber(value);
  if (direct !== null) return Math.round(direct);
  const match = text(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function loadHasPlanningContent(load = {}) {
  return Boolean(
    load.returnOnly
    || (Array.isArray(load.stops) && load.stops.length)
    || (Array.isArray(load.orders) && load.orders.length)
  );
}

export function dispatchLoadAssignment(truck = {}, load = {}, { driverSequence = 0 } = {}) {
  const start = dispatchMinute(load.plannedStartMinute ?? load.timing?.start ?? load.start ?? truck.start);
  const finish = dispatchMinute(load.plannedFinishMinute ?? load.timing?.finish ?? load.finish);
  const handoffMinutes = finiteNumber(
    load.handoffTravelMinutes
    ?? load.handoff_travel_minutes
    ?? load.timing?.handoffTravel?.minutes
  );
  return {
    driverLogin: key(load.driverLogin || load.driver_login || load.driver || truck.driverLogin || truck.driver_login || truck.driver),
    driverName: text(load.driverName || load.driver_name || load.driver || truck.driverName || truck.driver),
    truckId: text(load.truckId || load.truck_id || truck.id),
    truckPlate: text(load.truckPlate || load.truck_plate || truck.plate).toUpperCase(),
    switchYard: text(load.switchYard || load.switch_yard || load.startYard || truck.base),
    parkingSpot: text(load.parkingSpot || load.parking_spot || truck.parkingSpot),
    plannedStartMinute: start,
    plannedFinishMinute: finish,
    handoffTravelMinutes: Math.max(0, Math.round(handoffMinutes ?? 0)),
    handoffTravelFrom: text(load.handoffTravelFrom || load.handoff_travel_from || load.timing?.handoffTravel?.from),
    handoffTravelTo: text(load.handoffTravelTo || load.handoff_travel_to || load.timing?.handoffTravel?.to),
    driverSequence: Math.max(0, Math.round(finiteNumber(load.driverSequence ?? load.driver_sequence) ?? driverSequence))
  };
}

export function normalizeDispatchPlanLoadAssignments(plan = {}) {
  const sequenceByDriver = new Map();
  const trucks = (plan.trucks || []).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load, loadIndex) => {
      const fallbackDriver = key(load.driverLogin || load.driver_login || load.driver || truck.driverLogin || truck.driver_login || truck.driver);
      const nextSequence = sequenceByDriver.get(fallbackDriver) ?? loadIndex;
      const assignment = dispatchLoadAssignment(truck, load, { driverSequence: nextSequence });
      sequenceByDriver.set(assignment.driverLogin, Math.max(nextSequence, assignment.driverSequence) + 1);
      return { ...load, ...assignment };
    })
  }));
  return { ...plan, trucks };
}

export function flattenDispatchPlanLoads(plan = {}) {
  const normalized = normalizeDispatchPlanLoadAssignments(plan);
  const rows = [];
  for (const [truckIndex, truck] of (normalized.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      rows.push({
        planId: normalized.id ?? normalized.planId ?? null,
        planDate: text(normalized.planDate || normalized.plan_date).slice(0, 10),
        truck,
        load,
        truckIndex,
        loadIndex,
        ...dispatchLoadAssignment(truck, load, { driverSequence: loadIndex })
      });
    }
  }
  return rows;
}

function dispatchOrderByRef(plan = {}, orderRef = "") {
  const wanted = text(orderRef);
  if (!wanted) return null;
  const visit = (order = {}) => {
    if (text(order.id) === wanted || text(order.originalOrderId) === wanted) return order;
    for (const child of order.childOrderDetails || []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  for (const order of plan.orders || []) {
    const match = visit(order);
    if (match) return match;
  }
  return null;
}

function normalizedPhysicalVisitText(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedYardLocationText(value) {
  return normalizedPhysicalVisitText(dispatchLocationRoot(value));
}

function scopedPurchaseOrderDropLocation(stop = {}, order = {}) {
  const orderType = text(order.type || order.orderType || order.order_type).toUpperCase();
  const purchaseOrder = orderType === "PO" || orderType === "PURCHASE_ORDER";
  const lineRowIds = stop.lineRowIds ?? stop.line_row_ids;
  const lineScoped = Array.isArray(lineRowIds) && lineRowIds.length > 0;
  const dropoffScoped = Boolean(text(stop.dropoffKey || stop.dropoff_key));
  return purchaseOrder && (lineScoped || dropoffScoped) ? text(stop.location) : "";
}

function dispatchDropLocation(stop = {}, order = {}) {
  return text(
    stop.dropLocation
    || stop.drop_location
    || stop.destinationYard
    || stop.destination_yard
    || dispatchDropoffForStop(order, stop)?.destinationYard
    || dispatchDropoffForStop(order, stop)?.destination_yard
    || scopedPurchaseOrderDropLocation(stop, order)
    || order.destinationYard
    || order.destination_yard
    || order.toLocation
    || order.to_location
  );
}

function dispatchStopPhysicalAddress(stop = {}, order = {}) {
  const stopType = text(stop.type).toLowerCase();
  if (["pick", "pickup"].includes(stopType)) {
    return text(
      stop.address
      || order.pickupAddressOverride
      || order.pickup_address_override
      || order.sourceAddress
      || order.source_address
      || order.defaultSourceAddress
      || stop.location
      || stop.yard
    );
  }
  return text(
    stop.dropAddress
    || stop.drop_address
    || stop.address
    || order.destinationAddress
    || order.destination_address
    || order.dropAddress
    || order.drop_address
    || order.address
    || dispatchDropLocation(stop, order)
    || stop.location
    || stop.yard
  );
}

function dispatchStopPhysicalAddressKey(plan = {}, stop = {}, order = {}) {
  const dropLocation = dispatchDropLocation(stop, order);
  const ownYards = new Set(dispatchOwnYardCodes(plan).map((value) => normalizedPhysicalVisitText(value)));
  const rootLocation = dispatchLocationRoot(dropLocation);
  if (ownYards.has(normalizedPhysicalVisitText(rootLocation))) {
    const configuredYards = [
      ...(Array.isArray(plan.ownYards) ? plan.ownYards : []),
      ...(Array.isArray(plan.summary?.ownYards) ? plan.summary.ownYards : []),
      ...(Array.isArray(plan.summary?.dispatchPlanFormat?.ownYards) ? plan.summary.dispatchPlanFormat.ownYards : [])
    ];
    const configuredYard = configuredYards.find((yard) =>
      yard && typeof yard === "object"
      && dispatchLocationsShareYard(yard.code || yard.name || yard.id, dropLocation)
    );
    const address = text(configuredYard?.address || DEFAULT_OWN_YARD_ADDRESSES[rootLocation]);
    return normalizedPhysicalVisitText(address) || `own:${normalizedPhysicalVisitText(rootLocation)}`;
  }
  return normalizedPhysicalVisitText(dispatchStopPhysicalAddress(stop, order));
}

function dispatchDropoffForStop(order = {}, stop = {}) {
  const dropoffs = dispatchRouteDropoffs(order);
  const dropoffKey = text(stop.dropoffKey ?? stop.dropoff_key);
  if (dropoffKey) {
    const exact = dropoffs.find((dropoff) => text(dropoff?.key) === dropoffKey);
    if (exact) return exact;
  }
  const destinationYard = text(stop.dropLocation ?? stop.drop_location);
  if (destinationYard) {
    const exact = dropoffs.find((dropoff) => text(dropoff?.destinationYard ?? dropoff?.destination_yard) === destinationYard);
    if (exact) return exact;
  }
  return dropoffs.length === 1 ? dropoffs[0] : null;
}

function dispatchLineRowId(item = {}) {
  return text(item.lineRowId ?? item.line_row_id ?? item.id);
}

function dispatchDropItemsForStop(order = {}, stop = {}) {
  const stopLineRowIds = Array.isArray(stop.lineRowIds ?? stop.line_row_ids)
    ? (stop.lineRowIds ?? stop.line_row_ids).map(text).filter(Boolean)
    : [];
  const dropoffLineRowIds = dispatchDropoffForStop(order, stop)?.lineRowIds
    ?? dispatchDropoffForStop(order, stop)?.line_row_ids
    ?? [];
  const selectedIds = new Set((stopLineRowIds.length ? stopLineRowIds : dropoffLineRowIds).map(text).filter(Boolean));
  const dropoffs = dispatchRouteDropoffs(order);
  const items = dispatchRouteItems(order);
  if (!selectedIds.size) return dropoffs.length > 1 ? [] : items;
  return items.filter((item) => selectedIds.has(dispatchLineRowId(item)));
}

function dispatchRouteProjection(order = {}) {
  const projection = order.poRouteProjection ?? order.po_route_projection;
  return text(order.type || order.orderType || order.order_type).toUpperCase() === "PO"
    && projection
    && Number(projection.version || 0) >= 1
    ? projection
    : null;
}

function dispatchRouteItems(order = {}) {
  const projection = dispatchRouteProjection(order);
  return Array.isArray(projection?.items) ? projection.items : (order.items || []);
}

function dispatchRouteDropoffs(order = {}) {
  const projection = dispatchRouteProjection(order);
  return Array.isArray(projection?.dropoffs) ? projection.dropoffs : (order.dropoffs || []);
}

function dispatchNumber(value) {
  return finiteNumber(value) ?? 0;
}

function dispatchDropQuantity(order = {}, stop = {}, field = "pallets") {
  const projection = dispatchRouteProjection(order);
  const dropoff = dispatchDropoffForStop(order, stop) || {};
  const names = {
    pallets: ["dropPallets", "drop_pallets", "pallets", "pallet_qty"],
    layers: ["dropLayers", "drop_layers", "layers", "layer_qty"],
    sections: ["dropSections", "drop_sections", "sections", "section_qty"],
    pieces: ["dropPieces", "drop_pieces", "pieces", "piece_qty"]
  }[field] || [];
  const [stopCamel, stopSnake, itemCamel, itemSnake] = names;
  if (projection) {
    const projected = dropoff[itemCamel] ?? dropoff[itemSnake];
    if (projected !== undefined && projected !== null && finiteNumber(projected) !== null) {
      return Math.max(0, Number(projected));
    }
    const itemQuantity = dispatchDropItemsForStop(order, stop)
      .reduce((sum, item) => sum + dispatchNumber(item?.[itemCamel] ?? item?.[itemSnake]), 0);
    if (itemQuantity > 0) return itemQuantity;
    return dispatchRouteDropoffs(order).length > 1
      ? 0
      : dispatchNumber(projection[field] ?? projection[itemSnake]);
  }
  const explicit = stop[stopCamel]
    ?? stop[stopSnake]
    ?? dropoff[itemCamel]
    ?? dropoff[itemSnake];
  if (explicit !== undefined && explicit !== null && finiteNumber(explicit) !== null) {
    return Math.max(0, Number(explicit));
  }
  const itemQuantity = dispatchDropItemsForStop(order, stop)
    .reduce((sum, item) => sum + dispatchNumber(item?.[itemCamel] ?? item?.[itemSnake]), 0);
  if (itemQuantity > 0) return itemQuantity;
  return dispatchRouteDropoffs(order).length > 1
    ? 0
    : dispatchNumber(order[itemCamel] ?? order[itemSnake]);
}

function dispatchDropPallets(order = {}, stop = {}) {
  return dispatchDropQuantity(order, stop, "pallets");
}

function dispatchDropFootprintPallets(order = {}, stop = {}) {
  const pallets = dispatchDropPallets(order, stop);
  const hasLoose = ["layers", "sections", "pieces"]
    .some((field) => dispatchDropQuantity(order, stop, field) > 0);
  return pallets + (hasLoose ? 1 : 0);
}

function normalizedDispatchPickupLocation(value) {
  return dispatchLocationKey(value);
}

function dispatchPickupEntriesForLocation(order = {}, field, location = "") {
  const wanted = normalizedDispatchPickupLocation(location);
  return (Array.isArray(order[field]) ? order[field] : [])
    .filter((entry) => normalizedDispatchPickupLocation(entry?.location) === wanted);
}

function dispatchDirectPickupItemsForLocation(order = {}, location = "") {
  return dispatchPickupEntriesForLocation(order, "directPickupManifest", location)
    .flatMap((entry) => (entry.items || []).map((item) => ({
      ...item,
      pallets: dispatchNumber(item.palletQty ?? item.pallet_qty),
      layers: dispatchNumber(item.layerQty ?? item.layer_qty),
      sections: dispatchNumber(item.sectionQty ?? item.section_qty),
      pieces: dispatchNumber(item.pieceQty ?? item.piece_qty),
      quantity: dispatchNumber(item.quantity),
      salesQty: dispatchNumber(item.quantity)
    })));
}

function dispatchPoPickupItemsForLocation(order = {}, location = "") {
  return dispatchPickupEntriesForLocation(order, "poPickupManifest", location)
    .flatMap((entry) => (entry.items || []).map((item) => ({
      ...item,
      salesQty: dispatchNumber(item.quantity)
    })));
}

function dispatchDirectPickupAllocatedForItem(order = {}, item = {}) {
  const itemId = text(item.itemId ?? item.item_id);
  const sku = text(item.sku || item.itemName || item.name).toLowerCase();
  const matches = (order.directPickupManifest || []).flatMap((entry) => entry.items || []).filter((entry) => {
    if (itemId && text(entry.itemId ?? entry.item_id) === itemId) return true;
    return sku && text(entry.sku || entry.itemName).toLowerCase() === sku;
  });
  return matches.reduce((total, entry) => ({
    pallets: total.pallets + dispatchNumber(entry.palletQty ?? entry.pallet_qty),
    layers: total.layers + dispatchNumber(entry.layerQty ?? entry.layer_qty),
    sections: total.sections + dispatchNumber(entry.sectionQty ?? entry.section_qty),
    pieces: total.pieces + dispatchNumber(entry.pieceQty ?? entry.piece_qty),
    quantity: total.quantity + dispatchNumber(entry.quantity)
  }), { pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: 0 });
}

function dispatchOwnYardLocationKeys(plan = {}) {
  const values = [
    ...dispatchOwnYardCodes(plan),
    ...Object.entries(DEFAULT_OWN_YARD_ADDRESSES).map(([code, address]) => ({ code, address })),
    ...(Array.isArray(plan.ownYards) ? plan.ownYards : []),
    ...(Array.isArray(plan.summary?.ownYards) ? plan.summary.ownYards : [])
  ];
  const keys = new Set();
  for (const value of values) {
    if (value && typeof value === "object") {
      for (const candidate of [value.code, value.name, value.address, value.id]) {
        const candidateKey = normalizedPhysicalVisitText(candidate);
        if (candidateKey) keys.add(candidateKey);
        const rootKey = normalizedYardLocationText(candidate);
        if (rootKey) keys.add(rootKey);
      }
    } else {
      const candidateKey = normalizedPhysicalVisitText(value);
      if (candidateKey) keys.add(candidateKey);
      const rootKey = normalizedYardLocationText(value);
      if (rootKey) keys.add(rootKey);
    }
  }
  return keys;
}

function dispatchItemForPickupLocation(plan = {}, order = {}, item = {}, location = "") {
  if (text(order.type).toUpperCase() === "CUSTOM") return item;
  const ownYard = dispatchOwnYardLocationKeys(plan).has(normalizedYardLocationText(location));
  if (ownYard) {
    const source = text(order.sourceYard || order.outboundLocation);
    const direct = dispatchLocationsShareYard(source, location)
      ? dispatchDirectPickupAllocatedForItem(order, item)
      : { pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: 0 };
    const balance = (value, allocated) => Math.max(dispatchNumber(value) - dispatchNumber(allocated), 0);
    return {
      ...item,
      pallets: balance(item.pallets, dispatchNumber(item.poAllocatedPallets) + direct.pallets),
      layers: balance(item.layers, dispatchNumber(item.poAllocatedLayers) + direct.layers),
      sections: balance(item.sections, dispatchNumber(item.poAllocatedSections) + direct.sections),
      pieces: balance(item.pieces, dispatchNumber(item.poAllocatedPieces) + direct.pieces),
      quantity: balance(item.quantity ?? item.salesQty, dispatchNumber(item.poAllocatedSalesQty) + direct.quantity),
      salesQty: balance(item.salesQty ?? item.quantity, dispatchNumber(item.poAllocatedSalesQty) + direct.quantity)
    };
  }
  return {
    ...item,
    pallets: dispatchNumber(item.poAllocatedPallets),
    layers: dispatchNumber(item.poAllocatedLayers),
    sections: dispatchNumber(item.poAllocatedSections),
    pieces: dispatchNumber(item.poAllocatedPieces),
    quantity: dispatchNumber(item.poAllocatedSalesQty),
    salesQty: dispatchNumber(item.poAllocatedSalesQty)
  };
}

function dispatchItemHasQuantity(item = {}) {
  return Boolean(
    dispatchNumber(item.pallets ?? item.pallet_qty)
    || dispatchNumber(item.layers ?? item.layer_qty)
    || dispatchNumber(item.sections ?? item.section_qty)
    || dispatchNumber(item.pieces ?? item.piece_qty)
    || dispatchNumber(item.quantity ?? item.salesQty ?? item.sales_qty)
  );
}

function dispatchPickupItemsForLocation(plan = {}, order = {}, location = "") {
  if (text(order.type).toUpperCase() === "PO") return dispatchRouteItems(order).filter(dispatchItemHasQuantity);
  const directItems = dispatchDirectPickupItemsForLocation(order, location);
  if (directItems.length && !dispatchLocationsShareYard(order.sourceYard || order.outboundLocation, location)) {
    return directItems.filter(dispatchItemHasQuantity);
  }
  const poItems = dispatchPoPickupItemsForLocation(order, location);
  const ownYard = dispatchOwnYardLocationKeys(plan).has(normalizedYardLocationText(location));
  if (poItems.length && !ownYard) return poItems.filter(dispatchItemHasQuantity);
  return (order.items || [])
    .map((item) => dispatchItemForPickupLocation(plan, order, item, location))
    .filter(dispatchItemHasQuantity);
}

function dispatchPickupFootprintForOrderLocation(plan = {}, order = {}, location = "") {
  const items = dispatchPickupItemsForLocation(plan, order, location);
  if (!items.length) return 0;
  const pallets = items.reduce((sum, item) => sum + dispatchNumber(item.pallets ?? item.pallet_qty), 0);
  const hasLoose = items.some((item) =>
    dispatchNumber(item.layers ?? item.layer_qty) > 0
    || dispatchNumber(item.sections ?? item.section_qty) > 0
    || dispatchNumber(item.pieces ?? item.piece_qty) > 0
  );
  if (pallets || hasLoose) return pallets + (hasLoose ? 1 : 0);
  const directEntries = dispatchPickupEntriesForLocation(order, "directPickupManifest", location);
  if (directEntries.length) {
    return directEntries.reduce((sum, entry) => sum + (entry.items || [])
      .reduce((itemSum, item) => itemSum + dispatchNumber(item.palletQty ?? item.pallet_qty), 0), 0);
  }
  return dispatchNumber(order.pallets ?? order.pallet_qty)
    + (dispatchNumber(order.layers ?? order.layer_qty) > 0 ? 1 : 0);
}

function dispatchRequiredPickupLocations(plan = {}, order = {}) {
  const locations = Array.isArray(order.pickupLocations) && order.pickupLocations.length
    ? order.pickupLocations
    : ["3445"];
  const uniqueLocations = uniqueDispatchLocations(locations);
  const hasPickupAddressOverride = Boolean(text(order.pickupAddressOverride));
  return uniqueLocations.filter((location, index) =>
    (hasPickupAddressOverride && index === 0)
    || dispatchPickupItemsForLocation(plan, order, location).some(dispatchItemHasQuantity)
  );
}

function dispatchPickupFootprintForLocation(plan = {}, load = {}, location = "") {
  const pickupLocation = dispatchLocationKey(location);
  const countedOrders = new Set();
  let total = 0;
  for (const stop of load.stops || []) {
    if (!["drop", "dropoff"].includes(text(stop.type).toLowerCase())) continue;
    const orderId = text(stop.orderId);
    if (!orderId || countedOrders.has(orderId)) continue;
    const order = dispatchOrderByRef(plan, orderId);
    if (!order) continue;
    if (!dispatchRequiredPickupLocations(plan, order)
      .some((candidate) => dispatchLocationKey(candidate) === pickupLocation)) continue;
    countedOrders.add(orderId);
    total += dispatchPickupFootprintForOrderLocation(plan, order, pickupLocation);
  }
  return total;
}

function isLocalDispatchVrmaOrder(order = {}) {
  return text(order.sourceTable || order.source_table).toLowerCase() === "scm_vrma_orders"
    || text(order.parseSource || order.parse_source).toLowerCase() === "scm-vrma";
}

function dispatchCustomOrderStopMinutes(stop = {}, order = {}) {
  const isCustom = text(order.type).toUpperCase() === "CUSTOM"
    || order.customOrder === true
    || text(order.sourceTable || order.source_table).toLowerCase() === "dispatch_custom_orders";
  if (!["drop", "dropoff"].includes(text(stop.type).toLowerCase()) || !isCustom) return null;
  const raw = order.stopMinutes ?? order.stop_minutes ?? order.raw?.stop_minutes;
  if (raw === null || raw === undefined || text(raw) === "") return null;
  const minutes = finiteNumber(raw);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
}

function dispatchStopOverrideState(stop = {}) {
  if (!Object.prototype.hasOwnProperty.call(stop, "stopTimeOverrideMinutes")) {
    return { provided: false, valid: true, value: null };
  }
  const raw = stop.stopTimeOverrideMinutes;
  if (raw === null) return { provided: true, valid: true, value: null };
  return {
    provided: true,
    valid: typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1440,
    value: typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1440 ? raw : null
  };
}

export function isValidDispatchStopTimeOverrideMinutes(value, { allowUndefined = true } = {}) {
  if (value === undefined) return Boolean(allowUndefined);
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440);
}

function dispatchVisitServiceType(plan = {}, entries = []) {
  const ownYards = dispatchOwnYardLocationKeys(plan);
  const types = entries.map(({ stop, order }) => {
    const stopType = text(stop.type).toLowerCase();
    const pickup = stopType === "pick" || stopType === "pickup";
    const pickupAddressOverride = pickup
      ? text(order.pickupAddressOverride || order.pickup_address_override)
      : "";
    const location = pickup
      ? pickupAddressOverride || text(stop.location || stop.yard)
      : dispatchDropLocation(stop, order);
    if (ownYards.has(normalizedYardLocationText(location))) return "own_yard";
    if (pickup || isLocalDispatchVrmaOrder(order)) return "vendor_yard";
    return "delivery";
  });
  if (types.includes("delivery")) return "delivery";
  if (types.includes("vendor_yard")) return "vendor_yard";
  return "own_yard";
}

function dispatchProfileMinute(profile = {}, fields = [], fallback = 0) {
  for (const field of fields) {
    const value = finiteNumber(profile[field]);
    if (value !== null) return value;
  }
  return fallback;
}

function dispatchVisitAutomaticMinutes(serviceType, profile = {}, pallets = 0) {
  if (serviceType === "own_yard") {
    return Math.round(dispatchProfileMinute(profile, ["ownYardFixedMinutes", "loadMinutes"], 40));
  }
  if (serviceType === "vendor_yard") {
    return Math.round(dispatchProfileMinute(profile, ["vendorFixedMinutes", "outsideFixedMinutes", "unloadMinutes"], 35));
  }
  const fixed = dispatchProfileMinute(profile, ["deliveryFixedMinutes", "outsideFixedMinutes", "unloadMinutes"], 35);
  const perPallet = dispatchProfileMinute(profile, ["minutesPerPallet"], 1);
  return Math.round(fixed + (Math.max(0, Number(pallets || 0)) * perPallet));
}

/**
 * Materialize the logical stops in one load as physical visits.
 *
 * Only adjacent drop-offs at the exact normalized address merge. Pickups stay
 * independent because they can represent distinct loading workflows even when
 * their address is shared. The returned planned duration is one driver rule per
 * physical visit, with a dispatcher override taking precedence.
 */
export function dispatchPhysicalStopVisits(plan = {}, parentTruck = {}, load = {}, {
  planningProfile = null
} = {}) {
  const profile = { ...parentTruck, ...load, ...(planningProfile || {}) };
  const visits = [];
  for (const [index, stop] of (load.stops || []).entries()) {
    if (!["pick", "pickup", "drop", "dropoff"].includes(text(stop?.type).toLowerCase())) continue;
    const order = dispatchOrderByRef(plan, stop.orderId) || {};
    const stopType = ["drop", "dropoff"].includes(text(stop.type).toLowerCase()) ? "drop" : "pick";
    const address = dispatchStopPhysicalAddress(stop, order);
    const addressKey = stopType === "drop" ? dispatchStopPhysicalAddressKey(plan, stop, order) : "";
    const entry = {
      stop,
      order,
      index,
      stopId: text(stop.id),
      address,
      addressKey,
      pallets: stopType === "drop"
        ? dispatchDropFootprintPallets(order, stop)
        : dispatchPickupFootprintForLocation(plan, load, stop.location || stop.yard),
      customStopMinutes: dispatchCustomOrderStopMinutes(stop, order),
      override: dispatchStopOverrideState(stop)
    };
    const previous = visits[visits.length - 1];
    if (addressKey && previous?.type === "drop" && previous.addressKey === addressKey) {
      previous.entries.push(entry);
      continue;
    }
    visits.push({
      id: text(stop.id) || `${text(load.id)}-visit-${index}`,
      loadId: text(load.id),
      type: stopType,
      address,
      addressKey,
      entries: [entry]
    });
  }

  return visits.map((visit) => {
    const serviceType = dispatchVisitServiceType(plan, visit.entries);
    const pallets = visit.entries.reduce((sum, entry) => sum + Number(entry.pallets || 0), 0);
    const automaticMinutes = dispatchVisitAutomaticMinutes(serviceType, profile, pallets);
    const customValues = visit.entries.map((entry) => entry.customStopMinutes).filter(Number.isInteger);
    const customMinutes = customValues.length ? Math.max(...customValues) : null;
    const validOverrideValues = visit.entries
      .filter((entry) => entry.override.valid)
      .map((entry) => entry.override.value);
    const distinctOverrideValues = [...new Set(validOverrideValues.map((value) => value === null ? "automatic" : String(value)))];
    const overrideConflict = distinctOverrideValues.length > 1;
    const overrideMinutes = !overrideConflict && distinctOverrideValues.length === 1
      ? (distinctOverrideValues[0] === "automatic" ? null : Number(distinctOverrideValues[0]))
      : null;
    const mixedVisit = visit.entries.length > 1;
    const ruleMinutes = customMinutes === null
      ? automaticMinutes
      : mixedVisit
        ? Math.max(automaticMinutes, customMinutes)
        : customMinutes;
    return {
      ...visit,
      stopIds: visit.entries.map((entry) => entry.stopId).filter(Boolean),
      firstIndex: visit.entries[0]?.index ?? -1,
      lastIndex: visit.entries[visit.entries.length - 1]?.index ?? -1,
      serviceType,
      pallets,
      automaticMinutes,
      customMinutes,
      overrideMinutes,
      overrideConflict,
      invalidOverrideStopIds: visit.entries.filter((entry) => !entry.override.valid).map((entry) => entry.stopId),
      plannedMinutes: overrideMinutes ?? ruleMinutes
    };
  });
}

const LOCKED_LOAD_DERIVED_SCHEDULE_FIELDS = [
  "start",
  "startMode",
  "start_mode",
  "plannedStartMinute",
  "plannedFinishMinute",
  "scheduledStartMinute",
  "handoffTravelMinutes",
  "handoffTravelFrom",
  "handoffTravelTo",
  "ownYardFixedMinutes",
  "vendorFixedMinutes",
  "deliveryFixedMinutes",
  "minutesPerPallet",
  "truckSwitchMinutes",
  "timing"
];

const LOCKED_STOP_DERIVED_SCHEDULE_FIELDS = [
  "arriveTime",
  "departTime",
  "plannedArrive",
  "plannedDepart",
  "plannedArrival",
  "plannedDeparture",
  "timing"
];

const LOCKED_LOAD_EXECUTED_PREFIX_FIELDS = [
  "start",
  "startMode",
  "start_mode",
  "plannedStartMinute",
  "scheduledStartMinute",
  "handoffTravelMinutes",
  "handoffTravelFrom",
  "handoffTravelTo",
  "ownYardFixedMinutes",
  "vendorFixedMinutes",
  "deliveryFixedMinutes",
  "minutesPerPallet",
  "truckSwitchMinutes"
];

const LOCKED_LOAD_TIMING_PREFIX_FIELDS = [
  "start",
  "scheduledStart",
  "previousFinish",
  "restBefore",
  "handoffStart",
  "switchStart",
  "switchMinutes",
  "handoffTravel"
];

function clonedScheduleValue(value) {
  if (Array.isArray(value)) return value.map(clonedScheduleValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).reduce((copy, field) => {
    copy[field] = clonedScheduleValue(value[field]);
    return copy;
  }, {});
}

function overlayFields(target = {}, source = {}, fields = []) {
  const overlaid = { ...target };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      overlaid[field] = clonedScheduleValue(source[field]);
    } else {
      delete overlaid[field];
    }
  }
  return overlaid;
}

function overlayExecutedPrefixLoadFields(target = {}, source = {}) {
  const overlaid = overlayFields(target, source, LOCKED_LOAD_EXECUTED_PREFIX_FIELDS);
  if (source.timing || target.timing) {
    overlaid.timing = overlayFields(target.timing || {}, source.timing || {}, LOCKED_LOAD_TIMING_PREFIX_FIELDS);
  }
  return overlaid;
}

function shiftedDerivedMinute(value, offset) {
  if (value === null || value === undefined || text(value) === "") return value;
  const minute = finiteNumber(value);
  return minute === null ? value : minute + offset;
}

function rebaseExecutedPrefixCandidateLoad(target = {}, source = {}) {
  const candidateStart = dispatchMinute(target.plannedStartMinute ?? target.timing?.start);
  const candidateFinish = dispatchMinute(target.plannedFinishMinute ?? target.timing?.finish);
  const baselineStart = dispatchMinute(source.plannedStartMinute ?? source.timing?.start);
  if (
    candidateStart === null
    || candidateFinish === null
    || baselineStart === null
    || candidateFinish <= candidateStart
  ) return { load: target, offset: 0 };
  const offset = baselineStart - candidateStart;
  if (!offset) return { load: target, offset: 0 };
  const load = { ...target };
  if (Object.prototype.hasOwnProperty.call(target, "plannedFinishMinute")) {
    load.plannedFinishMinute = shiftedDerivedMinute(target.plannedFinishMinute, offset);
  }
  if (target.timing && typeof target.timing === "object") {
    load.timing = { ...target.timing };
    if (Object.prototype.hasOwnProperty.call(target.timing, "finish")) {
      load.timing.finish = shiftedDerivedMinute(target.timing.finish, offset);
    }
  }
  return { load, offset };
}

function rebaseFutureStopTiming(stop = {}, offset = 0) {
  if (!offset || !stop.timing || typeof stop.timing !== "object") return stop;
  const timing = { ...stop.timing };
  for (const field of ["arrival", "depart", "start", "finish"]) {
    if (Object.prototype.hasOwnProperty.call(timing, field)) {
      timing[field] = shiftedDerivedMinute(timing[field], offset);
    }
  }
  return { ...stop, timing };
}

function fixedLoadStart(load = {}) {
  const configured = text(load.startMode || load.start_mode).toLowerCase();
  if (configured === "fixed") return true;
  if (configured === "auto") return false;
  return Boolean(text(load.start));
}

function rebaseMutableLoadDerivedSchedule(load = {}, offset = 0) {
  if (!offset) return load;
  const rebased = { ...load };
  for (const field of ["plannedStartMinute", "plannedFinishMinute"]) {
    if (Object.prototype.hasOwnProperty.call(load, field)) {
      rebased[field] = shiftedDerivedMinute(load[field], offset);
    }
  }
  if (!fixedLoadStart(load) && Object.prototype.hasOwnProperty.call(load, "scheduledStartMinute")) {
    rebased.scheduledStartMinute = shiftedDerivedMinute(load.scheduledStartMinute, offset);
  }
  if (load.timing && typeof load.timing === "object") {
    const timing = { ...load.timing };
    for (const field of ["start", "finish", "previousFinish", "handoffStart", "switchStart"]) {
      if (Object.prototype.hasOwnProperty.call(load.timing, field)) {
        timing[field] = shiftedDerivedMinute(load.timing[field], offset);
      }
    }
    if (!fixedLoadStart(load) && Object.prototype.hasOwnProperty.call(load.timing, "scheduledStart")) {
      timing.scheduledStart = shiftedDerivedMinute(load.timing.scheduledStart, offset);
    }
    if (load.timing.handoffTravel && typeof load.timing.handoffTravel === "object") {
      timing.handoffTravel = { ...load.timing.handoffTravel };
      for (const field of ["start", "finish"]) {
        if (Object.prototype.hasOwnProperty.call(load.timing.handoffTravel, field)) {
          timing.handoffTravel[field] = shiftedDerivedMinute(load.timing.handoffTravel[field], offset);
        }
      }
    }
    rebased.timing = timing;
  }
  rebased.stops = (load.stops || []).map((stop) => rebaseFutureStopTiming(stop, offset));
  return rebased;
}

function loadInterval(load = {}) {
  return {
    start: dispatchMinute(load.plannedStartMinute ?? load.timing?.start),
    finish: dispatchMinute(load.plannedFinishMinute ?? load.timing?.finish)
  };
}

function rebaseMutableLaneSuffixes(plan = {}, restoredLoadIds = new Set(), lockedLoadIds = new Set()) {
  if (!restoredLoadIds.size) return plan;
  const trucks = (plan.trucks || []).map((truck) => ({
    ...truck,
    loads: [...(truck.loads || [])]
  }));
  const lanes = new Map();
  for (const [truckIndex, truck] of trucks.entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const assignment = dispatchLoadAssignment(truck, load, { driverSequence: loadIndex });
      if (!assignment.driverLogin) continue;
      if (!lanes.has(assignment.driverLogin)) lanes.set(assignment.driverLogin, []);
      lanes.get(assignment.driverLogin).push({ truck, truckIndex, loadIndex, load, assignment });
    }
  }

  for (const entries of lanes.values()) {
    entries.sort((left, right) =>
      left.assignment.driverSequence - right.assignment.driverSequence
      || left.truckIndex - right.truckIndex
      || left.loadIndex - right.loadIndex
    );
    let restoredPrefix = false;
    let previous = null;
    for (const entry of entries) {
      const loadId = text(entry.load.id);
      if (restoredLoadIds.has(loadId)) restoredPrefix = true;
      if (restoredPrefix && previous && !lockedLoadIds.has(loadId)) {
        const previousInterval = loadInterval(previous.load);
        const currentInterval = loadInterval(entry.load);
        if (
          previousInterval.finish !== null
          && currentInterval.start !== null
          && currentInterval.finish !== null
          && currentInterval.finish > currentInterval.start
        ) {
          const changedTruck = previous.assignment.truckPlate !== entry.assignment.truckPlate;
          const handoffMinutes = changedTruck ? Math.max(0, Number(entry.assignment.handoffTravelMinutes || 0)) : 0;
          const configuredSwitch = Number(entry.load.truckSwitchMinutes ?? DEFAULT_SWITCH_MINUTES);
          const switchMinutes = changedTruck
            ? Math.max(0, Math.round(Number.isFinite(configuredSwitch) ? configuredSwitch : DEFAULT_SWITCH_MINUTES))
            : 0;
          const requiredStart = previousInterval.finish + handoffMinutes + switchMinutes;
          if (currentInterval.start < requiredStart) {
            const shifted = rebaseMutableLoadDerivedSchedule(entry.load, requiredStart - currentInterval.start);
            entry.truck.loads[entry.loadIndex] = shifted;
            entry.load = shifted;
            entry.assignment = dispatchLoadAssignment(entry.truck, shifted, { driverSequence: entry.assignment.driverSequence });
          }
        }
      }
      previous = entry;
    }
  }
  return { ...plan, trucks };
}

/**
 * Keep the server's already-published schedule for loads with driver activity.
 *
 * Browser route estimates are intentionally not persisted in the plan. A route
 * cache miss can therefore recalculate load and stop timing while the dispatcher
 * is editing an unrelated load. Only derived scheduling fields are restored here;
 * every incoming assignment, stop, order, location, and sequence field remains
 * untouched so changedLockedLoadAssignments can still reject structural edits.
 * With activityStatuses, only the executed physical-visit prefix is restored;
 * callers that omit statuses retain the legacy whole-load overlay.
 */
export function overlayLockedLoadDerivedSchedule(previousPlan = {}, nextPlan = {}, lockedLoadIds = new Set(), {
  activityStatuses = []
} = {}) {
  const lockedSource = lockedLoadIds && typeof lockedLoadIds[Symbol.iterator] === "function"
    ? lockedLoadIds
    : [];
  const locked = new Set([...lockedSource].map(text).filter(Boolean));
  const activityScopes = activityStatuses?.length
    ? activeTimingScopes(previousPlan, activityStatuses)
    : new Map();
  for (const loadId of activityScopes.keys()) locked.add(loadId);
  if (!locked.size) return nextPlan;
  const previousLoads = new Map(flattenDispatchPlanLoads(previousPlan)
    .map((row) => [text(row.load.id), row.load])
    .filter(([loadId]) => loadId));
  const restoredLoadIds = new Set();
  const overlaidPlan = {
    ...nextPlan,
    trucks: (nextPlan.trucks || []).map((truck) => ({
      ...truck,
      loads: (truck.loads || []).map((load) => {
        const loadId = text(load.id);
        const previousLoad = locked.has(loadId) ? previousLoads.get(loadId) : null;
        if (!previousLoad) return load;
        const previousStopsById = new Map((previousLoad.stops || [])
          .map((stop) => [text(stop.id), stop])
          .filter(([stopId]) => stopId));
        const activityScope = activityScopes.get(loadId);
        let activityBoundary = -1;
        if (activityScope && !activityScope.fullLoad) {
          for (const stopId of activityScope.activeStopIds) {
            const visit = activityScope.visitsByStopId.get(stopId);
            if (!visit) {
              activityBoundary = Number.MAX_SAFE_INTEGER;
              break;
            }
            activityBoundary = Math.max(activityBoundary, visit.lastIndex);
          }
        }
        // Recalculate only when the submitted load still has an unexecuted suffix.
        // Once activity reaches the final physical visit, the whole published
        // schedule is historical evidence and an unrelated edit must not drift it.
        const useExecutedPrefix = Boolean(
          activityScope
          && !activityScope.fullLoad
          && activityBoundary < ((load.stops || []).length - 1)
        );
        const rebased = useExecutedPrefix
          ? rebaseExecutedPrefixCandidateLoad(load, previousLoad)
          : { load, offset: 0 };
        const overlaid = useExecutedPrefix
          ? overlayExecutedPrefixLoadFields(rebased.load, previousLoad)
          : overlayFields(load, previousLoad, LOCKED_LOAD_DERIVED_SCHEDULE_FIELDS);
        overlaid.stops = (load.stops || []).map((stop, index) => {
          const stopId = text(stop.id);
          const previousStop = stopId
            ? previousStopsById.get(stopId)
            : (!text(previousLoad.stops?.[index]?.id) ? previousLoad.stops?.[index] : null);
          if (useExecutedPrefix && index > activityBoundary) return rebaseFutureStopTiming(stop, rebased.offset);
          return previousStop
            ? overlayFields(stop, previousStop, LOCKED_STOP_DERIVED_SCHEDULE_FIELDS)
            : stop;
        });
        const submittedInterval = loadInterval(load);
        const restoredInterval = loadInterval(overlaid);
        if (
          submittedInterval.start !== restoredInterval.start
          || submittedInterval.finish !== restoredInterval.finish
        ) restoredLoadIds.add(loadId);
        return overlaid;
      })
    }))
  };
  return rebaseMutableLaneSuffixes(overlaidPlan, restoredLoadIds, locked);
}

export function driverLoadLanes(plan = {}, configuredDrivers = []) {
  const rows = flattenDispatchPlanLoads(plan);
  const laneByLogin = new Map();
  for (const [index, driver] of (configuredDrivers || []).entries()) {
    const login = key(driver.login || driver.driverLogin);
    if (!login) continue;
    laneByLogin.set(login, {
      driverLogin: login,
      driverName: text(driver.name || driver.driverName || login),
      displayOrder: Number(driver.displayOrder ?? index),
      driver,
      loads: []
    });
  }
  for (const row of rows) {
    const login = row.driverLogin;
    if (!laneByLogin.has(login)) {
      laneByLogin.set(login, {
        driverLogin: login,
        driverName: row.driverName || (login ? login : "Unassigned"),
        displayOrder: login ? 100000 : 200000,
        driver: null,
        loads: []
      });
    }
    laneByLogin.get(login).loads.push(row);
  }
  for (const lane of laneByLogin.values()) {
    lane.loads.sort((left, right) => {
      const leftStart = left.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart
        || left.driverSequence - right.driverSequence
        || left.truckIndex - right.truckIndex
        || left.loadIndex - right.loadIndex;
    });
  }
  return [...laneByLogin.values()].sort((left, right) =>
    left.displayOrder - right.displayOrder || left.driverName.localeCompare(right.driverName)
  );
}

function lastRoutedStop(load = {}) {
  return [...(load.stops || [])].reverse().find((stop) => ["pick", "drop", "return"].includes(String(stop?.type || "")));
}

export function loadEndYard(load = {}, ownYards = null, plan = {}) {
  const ownByKey = new Map(dispatchOwnYardCodes(plan, ownYards)
    .map((yard) => [dispatchLocationKey(yard), yard])
    .filter(([yardKey]) => Boolean(yardKey)));
  const ownYardFor = (value) => ownByKey.get(dispatchLocationKey(value)) || "";
  if (load.returnOnly) {
    const yard = text(load.returnYard || load.return_yard);
    return ownYardFor(yard);
  }
  const stop = lastRoutedStop(load);
  const order = stop?.type === "drop"
    ? (plan.orders || []).find((item) => text(item?.id) === text(stop?.orderId)) || {}
    : {};
  const scopedPurchaseDrop = text(order?.type).toUpperCase() === "PO"
    && ((stop?.lineRowIds || []).length > 0 || text(stop?.dropoffKey));
  const candidates = stop?.type === "pick"
    ? [stop?.location, stop?.yard]
    : [
        stop?.dropLocation,
        stop?.drop_location,
        stop?.destinationYard,
        stop?.destination_yard,
        scopedPurchaseDrop ? stop?.location : "",
        stop?.yard,
        order?.destinationYard,
        order?.destination_yard,
        order?.toLocation,
        order?.to_location
  ];
  const normalizedCandidates = candidates.map(text).filter(Boolean);
  return normalizedCandidates.map(ownYardFor).find(Boolean) || "";
}

function conflict(code, message, details = {}) {
  return { code, message, ...details };
}

function intervalsOverlap(left, right) {
  return left.start < right.finish && right.start < left.finish;
}

function visitOverrideSignature(visit = null) {
  if (!visit) return "missing";
  if (visit.invalidOverrideStopIds?.length) return "invalid";
  if (visit.overrideConflict) return "conflict";
  return visit.overrideMinutes === null ? "automatic" : `override:${visit.overrideMinutes}`;
}

function activeTimingScopes(previousPlan = {}, statuses = []) {
  const rowsByLoad = new Map(flattenDispatchPlanLoads(previousPlan).map((row) => [text(row.load.id), row]));
  const scopes = new Map();
  for (const record of statuses || []) {
    if (!ACTIVE_DRIVER_ACTIVITY_STATUSES.has(text(record.status).toLowerCase())) continue;
    const loadId = text(record.load_id || record.loadId);
    if (!loadId) continue;
    const scope = scopes.get(loadId) || { loadId, fullLoad: false, activeStopIds: new Set() };
    const stopType = text(record.stop_type || record.stopType).toLowerCase();
    if (PHYSICAL_DRIVER_STOP_TYPES.has(stopType)) {
      const stopId = text(record.stop_id || record.stopId);
      if (stopId) scope.activeStopIds.add(stopId);
      else scope.fullLoad = true;
    } else if (!SYNTHETIC_DRIVER_STOP_TYPES.has(stopType)) {
      scope.fullLoad = true;
    }
    scopes.set(loadId, scope);
  }
  for (const scope of scopes.values()) {
    const row = rowsByLoad.get(scope.loadId);
    scope.row = row || null;
    scope.visits = row ? dispatchPhysicalStopVisits(previousPlan, row.truck, row.load) : [];
    scope.visitsByStopId = new Map(scope.visits.flatMap((visit) => visit.stopIds.map((stopId) => [stopId, visit])));
    if (!row || [...scope.activeStopIds].some((stopId) => !scope.visitsByStopId.has(stopId))) {
      scope.fullLoad = true;
    }
  }
  return scopes;
}

/**
 * Validate the JSON-only timing metadata added to a dispatch plan.
 *
 * This stays separate from route estimation so old plan snapshots remain valid
 * without a migration. When previousPlan and statuses are supplied, only an
 * already-started physical visit is locked; later untouched visits remain
 * editable even though their load has driver activity.
 */
export function validateDispatchPlanTimingMetadata(plan = {}, {
  previousPlan = null,
  statuses = []
} = {}) {
  const conflicts = [];
  const rows = flattenDispatchPlanLoads(plan);

  for (const row of rows) {
    for (const stop of row.load.stops || []) {
      if (!Object.prototype.hasOwnProperty.call(stop, "stopTimeOverrideMinutes")) continue;
      if (isValidDispatchStopTimeOverrideMinutes(stop.stopTimeOverrideMinutes, { allowUndefined: false })) continue;
      conflicts.push(conflict(
        "DISPATCH_STOP_TIME_OVERRIDE_INVALID",
        `${row.load.name || row.load.id} has a stop-time override that must be a whole number from 0 to 1440, or Automatic.`,
        {
          loadId: text(row.load.id),
          stopId: text(stop.id),
          value: stop.stopTimeOverrideMinutes,
          reason: "invalid_stop_time_override"
        }
      ));
    }
    for (const visit of dispatchPhysicalStopVisits(plan, row.truck, row.load)) {
      if (!visit.overrideConflict) continue;
      conflicts.push(conflict(
        "DISPATCH_GROUPED_STOP_TIME_OVERRIDE_CONFLICT",
        `${row.load.name || row.load.id} has different stop-time overrides within one physical visit.`,
        {
          loadId: text(row.load.id),
          stopIds: visit.stopIds,
          reason: "conflicting_grouped_stop_time_override"
        }
      ));
    }
  }

  const endingByDriver = new Map();
  const laneByLoadId = new Map();
  for (const lane of driverLoadLanes(plan)) {
    const planningLoads = lane.loads.filter((row) => loadHasPlanningContent(row.load));
    for (const row of planningLoads) laneByLoadId.set(text(row.load.id), { lane, planningLoads });
  }
  for (const row of rows) {
    const hasEndingTrip = Object.prototype.hasOwnProperty.call(row.load, "endingTrip");
    if (hasEndingTrip && typeof row.load.endingTrip !== "boolean") {
      conflicts.push(conflict(
        "DISPATCH_ENDING_TRIP_INVALID",
        `${row.load.name || row.load.id} has an invalid Ending trip value.`,
        { loadId: text(row.load.id), reason: "invalid_ending_trip_value" }
      ));
      continue;
    }
    if (row.load.endingTrip !== true) continue;
    const laneInfo = laneByLoadId.get(text(row.load.id));
    const manualReturn = row.load.returnOnly === true && row.load.manual === true;
    if (!manualReturn) {
      conflicts.push(conflict(
        "DISPATCH_ENDING_TRIP_INVALID",
        `${row.load.name || row.load.id} can only be marked Ending trip when it is a manual return.`,
        { loadId: text(row.load.id), driverLogin: row.driverLogin, reason: "not_manual_return" }
      ));
    }
    const finalLoadId = text(laneInfo?.planningLoads?.[laneInfo.planningLoads.length - 1]?.load?.id);
    if (!row.driverLogin || !laneInfo || finalLoadId !== text(row.load.id)) {
      conflicts.push(conflict(
        "DISPATCH_ENDING_TRIP_INVALID",
        `${row.load.name || row.load.id} can only be marked Ending trip when it is the driver's final load.`,
        { loadId: text(row.load.id), driverLogin: row.driverLogin, finalLoadId, reason: "not_final_driver_load" }
      ));
    }
    if (!endingByDriver.has(row.driverLogin)) endingByDriver.set(row.driverLogin, []);
    endingByDriver.get(row.driverLogin).push(text(row.load.id));
  }
  for (const [driverLogin, loadIds] of endingByDriver.entries()) {
    if (!driverLogin || loadIds.length <= 1) continue;
    conflicts.push(conflict(
      "DISPATCH_ENDING_TRIP_INVALID",
      `${driverLogin} can only have one Ending trip.`,
      { driverLogin, loadIds, reason: "multiple_ending_trips" }
    ));
  }

  if (!previousPlan) return conflicts;
  const nextRows = new Map(rows.map((row) => [text(row.load.id), row]));
  for (const scope of activeTimingScopes(previousPlan, statuses).values()) {
    const nextRow = nextRows.get(scope.loadId);
    if (!scope.row || !nextRow) continue;
    const nextVisits = dispatchPhysicalStopVisits(plan, nextRow.truck, nextRow.load);
    const nextVisitsByStopId = new Map(nextVisits.flatMap((visit) => visit.stopIds.map((stopId) => [stopId, visit])));
    const changedVisitIds = new Set();
    const candidates = scope.fullLoad
      ? scope.visits
      : [...scope.activeStopIds].map((stopId) => scope.visitsByStopId.get(stopId)).filter(Boolean);
    for (const previousVisit of candidates) {
      const leadStopId = previousVisit.stopIds[0] || "";
      const currentVisit = previousVisit.stopIds.map((stopId) => nextVisitsByStopId.get(stopId)).find(Boolean) || null;
      if (visitOverrideSignature(previousVisit) === visitOverrideSignature(currentVisit)) continue;
      if (changedVisitIds.has(previousVisit.id)) continue;
      changedVisitIds.add(previousVisit.id);
      conflicts.push(conflict(
        "DISPATCH_STOP_TIME_OVERRIDE_LOCKED",
        `${scope.row.load.name || scope.loadId} cannot change the stop time for a visit with driver activity.`,
        {
          loadId: scope.loadId,
          stopId: leadStopId,
          stopIds: previousVisit.stopIds,
          reason: "active_physical_visit_override"
        }
      ));
    }
  }
  return conflicts;
}

export function validateDispatchLoadAssignments(plan = {}, {
  switchMinutes = DEFAULT_SWITCH_MINUTES,
  ownYards = null,
  requireAssignments = false,
  previousPlan = null,
  activityStatuses = []
} = {}) {
  const rows = flattenDispatchPlanLoads(plan).filter((row) => loadHasPlanningContent(row.load));
  const conflicts = [];
  const parsedSwitchMinutes = Number(switchMinutes);
  const cleanSwitchMinutes = Math.max(0, Math.round(Number.isFinite(parsedSwitchMinutes) ? parsedSwitchMinutes : DEFAULT_SWITCH_MINUTES));
  const resolvedOwnYards = dispatchOwnYardCodes(plan, ownYards);
  const own = new Set(resolvedOwnYards.map(dispatchLocationKey).filter(Boolean));

  for (const row of rows) {
    if (requireAssignments && (!row.driverLogin || !row.truckPlate)) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} requires both a driver and truck before confirmation.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "missing_assignment"
      }));
    }
    if (requireAssignments && (row.plannedStartMinute === null || row.plannedFinishMinute === null)) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} requires a planned start and finish time before confirmation.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "missing_interval"
      }));
    }
    if (row.plannedStartMinute !== null && row.plannedFinishMinute !== null && row.plannedFinishMinute <= row.plannedStartMinute) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} has an invalid planned time interval.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "invalid_interval"
      }));
    }
  }

  const validRows = rows.filter((row) => row.plannedStartMinute !== null && row.plannedFinishMinute !== null && row.plannedFinishMinute > row.plannedStartMinute);
  const byDriver = new Map();
  for (const row of validRows) {
    if (!row.driverLogin) continue;
    if (!byDriver.has(row.driverLogin)) byDriver.set(row.driverLogin, []);
    byDriver.get(row.driverLogin).push(row);
  }

  const occupancy = validRows.map((row) => ({ ...row, start: row.plannedStartMinute, finish: row.plannedFinishMinute }));
  for (const [driverLogin, driverRows] of byDriver.entries()) {
    driverRows.sort((left, right) => left.plannedStartMinute - right.plannedStartMinute || left.driverSequence - right.driverSequence);
    for (let index = 1; index < driverRows.length; index += 1) {
      const previous = driverRows[index - 1];
      const current = driverRows[index];
      const changedTruck = previous.truckPlate !== current.truckPlate;
      const switchStart = changedTruck ? current.plannedStartMinute - cleanSwitchMinutes : current.plannedStartMinute;
      const handoffMinutes = changedTruck ? Math.max(0, Number(current.handoffTravelMinutes || 0)) : 0;
      const activityStart = switchStart - handoffMinutes;
      if (previous.plannedFinishMinute > activityStart) {
        conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${previous.driverName || driverLogin} is assigned to overlapping loads ${previous.load.name || previous.load.id} and ${current.load.name || current.load.id}.`, {
          driverLogin,
          loadIds: [text(previous.load.id), text(current.load.id)],
          handoffMinutes,
          switchMinutes: changedTruck ? cleanSwitchMinutes : 0,
          reason: changedTruck ? "switch_approach_overlap" : "overlap"
        }));
        continue;
      }
      if (!changedTruck) continue;
      const previousEndYard = loadEndYard(previous.load, resolvedOwnYards, plan);
      const switchYard = text(current.switchYard);
      const handoffFrom = text(current.handoffTravelFrom);
      const handoffTo = text(current.handoffTravelTo);
      const hasPlannedApproach = handoffMinutes > 0 && handoffFrom && dispatchLocationsShareYard(handoffTo, switchYard);
      if (requireAssignments && (!own.has(dispatchLocationKey(switchYard)) || ((!previousEndYard || !dispatchLocationsShareYard(previousEndYard, switchYard)) && !hasPlannedApproach))) {
        conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", `Truck switch for ${previous.driverName || driverLogin} needs a travel leg to the same own yard before the switch.`, {
          driverLogin,
          previousLoadId: text(previous.load.id),
          nextLoadId: text(current.load.id),
          previousEndYard,
          switchYard,
          handoffFrom,
          handoffTo,
          handoffMinutes,
          reason: "missing_switch_approach"
        }));
      }
      const currentOccupancy = occupancy.find((item) => item.load === current.load);
      if (currentOccupancy) currentOccupancy.start = switchStart;
      if (hasPlannedApproach) {
        occupancy.push({
          ...current,
          truckId: previous.truckId,
          truckPlate: previous.truckPlate,
          start: activityStart,
          finish: switchStart,
          isHandoffTravel: true
        });
      }
      const previousTargetUse = validRows
        .filter((candidate) => candidate.load !== current.load
          && candidate.truckPlate === current.truckPlate
          && candidate.plannedFinishMinute <= switchStart)
        .sort((left, right) => right.plannedFinishMinute - left.plannedFinishMinute)[0];
      const targetAvailableYard = previousTargetUse
        ? loadEndYard(previousTargetUse.load, resolvedOwnYards, plan)
        : text(current.truck?.base);
      if (requireAssignments && ((previousTargetUse && !targetAvailableYard) || (targetAvailableYard && !dispatchLocationsShareYard(targetAvailableYard, switchYard)))) {
        conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", targetAvailableYard
          ? `${current.truckPlate} is available at ${targetAvailableYard}, not ${switchYard}, for this truck switch.`
          : `${current.truckPlate} did not finish its previous load at an own yard. Add a return load before this truck switch.`, {
          driverLogin,
          previousLoadId: text(previous.load.id),
          nextLoadId: text(current.load.id),
          truckPlate: current.truckPlate,
          targetAvailableYard,
          switchYard,
          reason: "target_truck_yard_mismatch"
        }));
      }
    }
  }

  const byTruck = new Map();
  for (const row of occupancy) {
    if (!row.truckPlate) continue;
    if (!byTruck.has(row.truckPlate)) byTruck.set(row.truckPlate, []);
    byTruck.get(row.truckPlate).push(row);
  }
  for (const [truckPlate, truckRows] of byTruck.entries()) {
    truckRows.sort((left, right) => left.start - right.start || left.finish - right.finish);
    for (let index = 1; index < truckRows.length; index += 1) {
      const previous = truckRows[index - 1];
      const current = truckRows[index];
      if (intervalsOverlap(previous, current)) {
        conflicts.push(conflict("DISPATCH_TRUCK_OCCUPANCY_CONFLICT", `${truckPlate} is assigned to overlapping loads ${previous.load.name || previous.load.id} and ${current.load.name || current.load.id}.`, {
          truckPlate,
          driverLogins: [previous.driverLogin, current.driverLogin],
          loadIds: [text(previous.load.id), text(current.load.id)],
          reason: "overlap"
        }));
        continue;
      }
      if (!previous.isHandoffTravel && !current.isHandoffTravel && previous.driverLogin && current.driverLogin && previous.driverLogin !== current.driverLogin) {
        const previousEndYard = loadEndYard(previous.load, resolvedOwnYards, plan);
        const handoffYard = text(current.switchYard);
        if (requireAssignments && (!previousEndYard || !own.has(dispatchLocationKey(handoffYard)) || !dispatchLocationsShareYard(previousEndYard, handoffYard))) {
          conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", `${truckPlate} must finish at ${handoffYard || "the next start yard"} before it can be handed to ${current.driverName || current.driverLogin}.`, {
            truckPlate,
            driverLogins: [previous.driverLogin, current.driverLogin],
            loadIds: [text(previous.load.id), text(current.load.id)],
            previousEndYard,
            handoffYard,
            reason: "driver_handoff_yard_mismatch"
          }));
        }
      }
    }
  }
  conflicts.push(...validateDispatchPlanTimingMetadata(plan, {
    previousPlan,
    statuses: activityStatuses
  }));
  return conflicts;
}

const ALLOCATION_MEASURE_FIELDS = {
  quantity: ["quantity", "salesQty", "sales_qty"],
  pallets: ["pallets", "palletQty", "pallet_qty"],
  layers: ["layers", "layerQty", "layer_qty"],
  sections: ["sections", "sectionQty", "section_qty"],
  pieces: ["pieces", "pieceQty", "piece_qty"],
  splitQty: ["splitQty", "split_qty"]
};

function allocationItemIdentity(item = {}) {
  const itemId = text(item.itemId ?? item.item_id).toLowerCase();
  const sku = text(item.sku).toLowerCase();
  const itemName = text(item.itemName ?? item.item_name ?? item.name).toLowerCase();
  const unit = text(item.unit ?? item.uom ?? item.uomName ?? item.uom_name).toLowerCase();
  const destinationLocationId = text(
    item.destinationLocationId
    ?? item.destination_location_id
    ?? item.locationId
    ?? item.location_id
  ).toLowerCase();
  const destinationYard = text(
    item.destinationYard
    ?? item.destination_yard
    ?? item.toLocation
    ?? item.to_location
  ).toLowerCase();
  const destination = destinationLocationId
    ? `location:${destinationLocationId}`
    : destinationYard
      ? `yard:${destinationYard}`
      : "";
  const splitUnit = text(item.splitUnit ?? item.split_unit).toLowerCase();
  const businessIdentity = itemId
    ? `item:${itemId}`
    : sku
      ? `sku:${sku}`
      : itemName
        ? `name:${itemName}`
        : "";
  if (businessIdentity) return `${businessIdentity}|unit:${unit}|destination:${destination}|split:${splitUnit}`;
  const rowIdentity = text(
    item.lineRowId
    ?? item.line_row_id
    ?? item.lineId
    ?? item.line_id
    ?? item.id
  ).toLowerCase();
  return `line:${rowIdentity}|unit:${unit}|destination:${destination}|split:${splitUnit}`;
}

function allocationMeasureValue(item = {}, fields = []) {
  const value = fields
    .map((field) => item[field])
    .find((candidate) => candidate !== null && candidate !== undefined && text(candidate) !== "");
  if (value === undefined || text(value) === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : text(value);
}

function aggregateAllocationMeasure(items = [], fields = []) {
  let total = 0;
  const invalidValues = [];
  for (const item of items) {
    const value = allocationMeasureValue(item, fields);
    if (typeof value === "number") total += value;
    else invalidValues.push(value);
  }
  const canonicalTotal = Number(total.toFixed(9));
  return invalidValues.length
    ? { total: canonicalTotal, values: invalidValues.sort() }
    : canonicalTotal;
}

function semanticAllocationItems(items = []) {
  const grouped = new Map();
  for (const item of items || []) {
    const identity = allocationItemIdentity(item);
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(item);
  }
  return [...grouped.entries()]
    .map(([id, rows]) => ({
      id,
      ...Object.fromEntries(Object.entries(ALLOCATION_MEASURE_FIELDS)
        .map(([field, aliases]) => [field, aggregateAllocationMeasure(rows, aliases)]))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function semanticOrderAllocation(order = {}) {
  return {
    id: text(order.id),
    childOrders: [...new Set((order.childOrders || []).map(text).filter(Boolean))].sort(),
    items: semanticAllocationItems(order.items || []),
    children: (order.childOrderDetails || [])
      .map(semanticOrderAllocation)
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function changedLockedLoadAssignments(previousPlan = {}, nextPlan = {}, lockedLoadIds = new Set()) {
  const before = new Map(flattenDispatchPlanLoads(previousPlan).map((row) => [text(row.load.id), row]));
  const after = new Map(flattenDispatchPlanLoads(nextPlan).map((row) => [text(row.load.id), row]));
  const allocationSignature = (plan, row) => {
    const refs = new Set((row?.load?.stops || []).map((stop) => text(stop.orderId)).filter(Boolean));
    return (plan.orders || [])
      .filter((order) => refs.has(text(order.id)))
      .map(semanticOrderAllocation)
      .sort((left, right) => left.id.localeCompare(right.id));
  };
  const stopSignature = (stop = {}) => ({
    id: text(stop.id),
    type: text(stop.type),
    orderId: text(stop.orderId),
    location: text(stop.location),
    address: text(stop.address),
    yard: text(stop.yard),
    dropoffKey: text(stop.dropoffKey),
    dropLocation: text(stop.dropLocation),
    dropAddress: text(stop.dropAddress),
    destinationYard: text(stop.destinationYard || stop.destination_yard),
    destinationLocationId: text(stop.destinationLocationId || stop.destination_location_id),
    lineRowIds: [...new Set((stop.lineRowIds || []).map(text).filter(Boolean))].sort(),
    arriveTime: text(stop.arriveTime || stop.plannedArrive),
    departTime: text(stop.departTime || stop.plannedDepart),
    timing: {
      arrival: dispatchMinute(stop.timing?.arrival),
      depart: dispatchMinute(stop.timing?.depart)
    }
  });
  const stableSignatureValue = (value) => {
    if (Array.isArray(value)) return value.map(stableSignatureValue);
    if (!value || typeof value !== "object") return value;
    return Object.keys(value).sort().reduce((memo, keyName) => {
      memo[keyName] = stableSignatureValue(value[keyName]);
      return memo;
    }, {});
  };
  const lockedSignature = (plan, row) => row ? JSON.stringify({
    driverLogin: row.driverLogin,
    driverName: row.driverName,
    truckId: row.truckId,
    truckPlate: row.truckPlate,
    switchYard: row.switchYard,
    parkingSpot: row.parkingSpot,
    driverSequence: row.driverSequence,
    plannedStartMinute: row.plannedStartMinute,
    plannedFinishMinute: row.plannedFinishMinute,
    handoffTravelMinutes: row.handoffTravelMinutes,
    handoffTravelFrom: row.handoffTravelFrom,
    handoffTravelTo: row.handoffTravelTo,
    returnOnly: row.load.returnOnly === true,
    returnYard: text(row.load.returnYard || row.load.return_yard),
    orders: stableSignatureValue(row.load.orders || []),
    stops: (row.load.stops || []).map(stopSignature),
    allocations: allocationSignature(plan, row)
  }) : "";
  const changes = [];
  for (const loadId of lockedLoadIds || []) {
    const previous = before.get(text(loadId));
    const current = after.get(text(loadId));
    const previousSignature = lockedSignature(previousPlan, previous);
    const currentSignature = lockedSignature(nextPlan, current);
    if (previousSignature !== currentSignature) changes.push({ loadId: text(loadId), previous, current });
  }
  return changes;
}

const ACTIVE_DRIVER_ACTIVITY_STATUSES = new Set(["in_progress", "complete"]);
const PHYSICAL_DRIVER_STOP_TYPES = new Set(["pickup", "dropoff", "pick", "drop"]);
const SYNTHETIC_DRIVER_STOP_TYPES = new Set(["travel", "truck_switch"]);

function activeDriverActivityStatus(record = {}) {
  return ACTIVE_DRIVER_ACTIVITY_STATUSES.has(text(record.status).toLowerCase());
}

function driverActivityStopType(record = {}) {
  return text(record.stop_type || record.stopType).toLowerCase();
}

function driverActivityOrderRefs(record = {}) {
  const refs = record.order_refs ?? record.orderRefs;
  return Array.isArray(refs) ? refs.map(text).filter(Boolean) : [];
}

function driverActivityAssignmentSignature(row = null) {
  if (!row) return "";
  return JSON.stringify({
    driverLogin: row.driverLogin,
    truckId: row.truckId,
    truckPlate: row.truckPlate
  });
}

function driverActivityOrderForRef(plan = {}, orderRef = "") {
  const wanted = text(orderRef);
  if (!wanted) return null;
  const visit = (order = {}) => {
    if (text(order.id) === wanted || text(order.originalOrderId) === wanted) return order;
    for (const child of order.childOrderDetails || []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  for (const order of plan.orders || []) {
    const match = visit(order);
    if (match) return match;
  }
  return null;
}

function driverActivityStopSignature(plan = {}, stop = null) {
  if (!stop) return "";
  const order = driverActivityOrderForRef(plan, stop.orderId) || {};
  const pickup = ["pick", "pickup"].includes(text(stop.type).toLowerCase());
  return JSON.stringify({
    id: text(stop.id),
    type: text(stop.type),
    orderId: text(stop.orderId),
    location: text(stop.location),
    address: text(stop.address),
    yard: text(stop.yard),
    dropoffKey: text(stop.dropoffKey),
    dropLocation: text(stop.dropLocation),
    dropAddress: text(stop.dropAddress),
    destinationYard: text(stop.destinationYard || stop.destination_yard),
    destinationLocationId: text(stop.destinationLocationId || stop.destination_location_id),
    lineRowIds: [...new Set((stop.lineRowIds || []).map(text).filter(Boolean))].sort(),
    dropPallets: stop.dropPallets ?? stop.pallets ?? null,
    dropLayers: stop.dropLayers ?? stop.layers ?? null,
    dropSections: stop.dropSections ?? stop.sections ?? null,
    dropPieces: stop.dropPieces ?? stop.pieces ?? null,
    dropSalesQty: stop.dropSalesQty ?? stop.salesQty ?? null,
    dropWeight: stop.dropWeight ?? stop.weight ?? null,
    effectiveOrderLocation: pickup
      ? text(stop.location || stop.yard || order.sourceYard || order.source_yard)
      : text(
        stop.dropLocation
        || stop.location
        || stop.destinationYard
        || stop.destination_yard
        || order.destinationYard
        || order.destination_yard
        || order.toLocation
        || order.to_location
      ),
    effectiveOrderAddress: pickup
      ? text(stop.address || order.pickupAddressOverride || order.sourceAddress || order.defaultSourceAddress)
      : text(stop.dropAddress || stop.address || order.address || order.dropAddress),
    arriveTime: text(stop.arriveTime || stop.plannedArrive),
    departTime: text(stop.departTime || stop.plannedDepart),
    timing: {
      arrival: dispatchMinute(stop.timing?.arrival),
      depart: dispatchMinute(stop.timing?.depart)
    }
  });
}

function driverActivityOrderReferenceSet(order = {}) {
  const refs = new Set();
  const visit = (candidate = {}) => {
    for (const value of [candidate.id, candidate.originalOrderId]) {
      const ref = text(value);
      if (ref) refs.add(ref);
    }
    for (const value of candidate.childOrders || []) {
      const ref = text(value);
      if (ref) refs.add(ref);
    }
    for (const child of candidate.childOrderDetails || []) visit(child);
  };
  visit(order);
  return refs;
}

function driverActivityAllocationSignature(plan = {}, lockedOrderRefs = new Set()) {
  const wanted = new Set([...(lockedOrderRefs || [])].map(text).filter(Boolean));
  if (!wanted.size) return "[]";
  const allocations = (plan.orders || [])
    .filter((order) => {
      const refs = driverActivityOrderReferenceSet(order);
      return [...wanted].some((ref) => refs.has(ref));
    })
    .map(semanticOrderAllocation)
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify(allocations);
}

/**
 * Report edits that would rewrite evidence already recorded by the Driver PWA.
 *
 * Every active record keeps its load and driver/truck identity stable. Only a
 * physical pickup/drop record locks a plan stop and that stop's order
 * allocation. Synthetic travel and truck-switch records intentionally do not
 * freeze downstream, unstarted stops or orders. Unknown legacy activity fails
 * closed through the existing whole-load comparison.
 */
export function changedDriverActivityAssignments(previousPlan = {}, nextPlan = {}, statuses = []) {
  const scopes = new Map();
  for (const record of statuses || []) {
    if (!activeDriverActivityStatus(record)) continue;
    const loadId = text(record.load_id || record.loadId);
    if (!loadId) continue;
    const scope = scopes.get(loadId) || {
      loadId,
      fullLoad: false,
      stopIds: new Set(),
      orderRefs: new Set()
    };
    const stopType = driverActivityStopType(record);
    if (PHYSICAL_DRIVER_STOP_TYPES.has(stopType)) {
      const stopId = text(record.stop_id || record.stopId);
      if (!stopId) {
        scope.fullLoad = true;
      } else {
        scope.stopIds.add(stopId);
        for (const ref of driverActivityOrderRefs(record)) scope.orderRefs.add(ref);
      }
    } else if (!SYNTHETIC_DRIVER_STOP_TYPES.has(stopType)) {
      scope.fullLoad = true;
    }
    scopes.set(loadId, scope);
  }
  if (!scopes.size) return [];

  const before = new Map(flattenDispatchPlanLoads(previousPlan).map((row) => [text(row.load.id), row]));
  const after = new Map(flattenDispatchPlanLoads(nextPlan).map((row) => [text(row.load.id), row]));
  const fullLoadChanges = new Map(changedLockedLoadAssignments(
    previousPlan,
    nextPlan,
    new Set([...scopes.values()].filter((scope) => scope.fullLoad).map((scope) => scope.loadId))
  ).map((change) => [text(change.loadId), change]));
  const changes = [];

  for (const scope of scopes.values()) {
    const previous = before.get(scope.loadId);
    const current = after.get(scope.loadId);
    const reasons = [];
    const changedStopIds = [];
    const changedOrderRefs = [];

    if (scope.fullLoad) {
      const fullLoadChange = fullLoadChanges.get(scope.loadId);
      if (fullLoadChange) {
        changes.push({
          ...fullLoadChange,
          reasons: ["full_load"],
          stopIds: [...scope.stopIds],
          orderRefs: [...scope.orderRefs]
        });
      }
      continue;
    }

    if (!previous || !current) {
      reasons.push("load");
    } else {
      if (driverActivityAssignmentSignature(previous) !== driverActivityAssignmentSignature(current)) {
        reasons.push("assignment");
      }
      const previousStopList = previous.load.stops || [];
      const currentStopList = current.load.stops || [];
      const previousStops = new Map(previousStopList.map((stop, index) => [text(stop.id), { stop, index }]));
      const currentStops = new Map(currentStopList.map((stop, index) => [text(stop.id), { stop, index }]));
      const previousActivityIndexes = [...scope.stopIds]
        .map((stopId) => previousStops.get(stopId)?.index)
        .filter(Number.isInteger);
      const activityBoundary = previousActivityIndexes.length ? Math.max(...previousActivityIndexes) : -1;
      const previousPrefix = previousStopList.slice(0, activityBoundary + 1).map((stop) => text(stop.id));
      const currentPrefix = currentStopList.slice(0, activityBoundary + 1).map((stop) => text(stop.id));
      const sequenceChanged = activityBoundary >= 0
        && JSON.stringify(previousPrefix) !== JSON.stringify(currentPrefix);
      for (const stopId of scope.stopIds) {
        const previousEntry = previousStops.get(stopId);
        const currentEntry = currentStops.get(stopId);
        const previousStop = previousEntry?.stop;
        const currentStop = currentEntry?.stop;
        if (
          !previousEntry
          || !currentEntry
          || driverActivityStopSignature(previousPlan, previousStop)
            !== driverActivityStopSignature(nextPlan, currentStop)
          || previousEntry?.index !== currentEntry?.index
          || sequenceChanged
        ) {
          changedStopIds.push(stopId);
        }
        const canonicalOrderRef = text(previousStop?.orderId);
        if (canonicalOrderRef) scope.orderRefs.add(canonicalOrderRef);
      }
      if (changedStopIds.length) reasons.push("stop");
      if (
        driverActivityAllocationSignature(previousPlan, scope.orderRefs)
        !== driverActivityAllocationSignature(nextPlan, scope.orderRefs)
      ) {
        changedOrderRefs.push(...scope.orderRefs);
        reasons.push("order_allocation");
      }
    }

    if (reasons.length) {
      changes.push({
        loadId: scope.loadId,
        previous,
        current,
        reasons,
        stopIds: changedStopIds,
        orderRefs: changedOrderRefs
      });
    }
  }
  return changes;
}

export const dispatchLoadAssignmentDefaults = {
  switchMinutes: DEFAULT_SWITCH_MINUTES,
  ownYards: [...DEFAULT_OWN_YARDS]
};
