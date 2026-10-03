import { createHash } from "node:crypto";
import { driverLoadLanes } from "./dispatch-load-assignment.js";

const text = value => String(value ?? "").trim();
const identity = order => text(order?.id || order?.orderRef || order?.tranid);
const loadRef = load => text(load.id || load.loadId);
const key = value => text(value).toUpperCase();
const physical = stop => ["pick", "pickup", "drop", "dropoff", "delivery", "return", "yard", "bin_delivery", "bin_exchange", "bin_collection"].includes(text(stop.type || stop.stopType).toLowerCase());
const refs = stop => [...new Set([stop.orderId, stop.orderRef, stop.order_id, ...(stop.orderRefs || [])].map(text).filter(Boolean))];
const sourceFields = ["address", "destinationAddress", "dropAddress", "sourceYard", "sourceAddress", "pickupLocations", "destinationYard", "destinationLocationId", "toLocation", "pallets", "layers", "sections", "pieces", "salesQty", "weight", "committedQty"];
const measures = ["quantity", "pallets", "layers", "sections", "pieces", "splitQty"];
const measureAliases = {
  quantity: ["quantity", "salesQty", "sales_qty"], pallets: ["pallets", "palletQty", "pallet_qty"],
  layers: ["layers", "layerQty", "layer_qty"], sections: ["sections", "sectionQty", "section_qty"],
  pieces: ["pieces", "pieceQty", "piece_qty"], splitQty: ["splitQty", "split_qty"]
};
const stable = value => JSON.stringify(value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]) || "null")]))
  : Array.isArray(value) ? value.map(v => JSON.parse(stable(v) || "null")) : value);
const same = (a, b) => stable(a) === stable(b);

function boundary(load, records) {
  const stops = (load.stops || []).filter(physical);
  return records.reduce((maximum, record) => {
    const type = text(record.stop_type || record.stopType).toLowerCase();
    if (type === "truck_switch") {return maximum;}
    let details = record.job_details || record.jobDetails || {};
    if (typeof details === "string") { try { details = JSON.parse(details); } catch { details = {}; } }
    const stopId = text(record.stop_id || record.stopId);
    let index = stops.findIndex(stop => text(stop.id || stop.stopId) === (type === "travel" ? text(details.toStopId || details.to_stop_id) : stopId));
    if (type === "travel") {
      if (index < 0) {index = stops.findIndex(stop => stopId.endsWith(`-${text(stop.id || stop.stopId)}`));}
      return Math.max(maximum, index - 1);
    }
    if (index < 0 && record.orderRef) {index = stops.findIndex(stop => refs(stop).includes(text(record.orderRef)));}
    return Math.max(maximum, index < 0 ? stops.length - 1 : index);
  }, -1);
}

export function executedOrderContexts(plan = {}, activity = []) {
  const records = (activity || []).filter(record => ["complete", "in_progress"].includes(text(record.status).toLowerCase())
    && (!text(record.stop_type || record.stopType) || ["travel", "truck_switch"].includes(text(record.stop_type || record.stopType)) || physical({ type: record.stop_type || record.stopType })));
  const contexts = [];
  const add = (row, through) => (row.load.stops || []).filter(physical).slice(0, through + 1).forEach(stop => {
    for (const orderRef of refs(stop)) {contexts.push({ orderRef, loadId: text(row.load.id || row.load.loadId),
      loadName: text(row.load.name || row.load.loadName || row.load.id), driverLogin: row.driverLogin,
      driverName: row.driverName || row.driverLogin, truckPlate: row.truckPlate || row.truckId,
      stopId: text(stop.id || stop.stopId), stopType: text(stop.type || stop.stopType) });}
  });
  const visited = new Set();
  for (const lane of driverLoadLanes(plan)) {
    const last = lane.loads.reduce((found, row, index) => records.some(record => text(record.load_id || record.loadId) === loadRef(row.load)) ? index : found, -1);
    lane.loads.slice(0, last + 1).forEach((row, index) => {
      visited.add(loadRef(row.load));
      add(row, index < last ? (row.load.stops || []).filter(physical).length - 1 : boundary(row.load, records.filter(record => text(record.load_id || record.loadId) === loadRef(row.load))));
    });
  }
  // Legacy plans can have driver activity without a driver lane assignment.
  for (const truck of plan.trucks || []) {for (const load of truck.loads || []) {
    const own = records.filter(record => text(record.load_id || record.loadId) === loadRef(load));
    if (own.length && !visited.has(loadRef(load))) {add({ load, driverLogin: load.driverLogin || truck.driverLogin || "", driverName: load.driverName || truck.driverName || "", truckPlate: load.truckPlate || truck.plate || truck.id }, boundary(load, own));}
  }}
  return contexts;
}

function itemRows(items = []) {
  const rows = new Map();
  for (const item of items) {
    const id = text(item.lineId || item.line_id) || [item.itemId || item.item_id || item.sku || item.itemName, item.unit || item.uom, item.destinationLocationId || item.destinationYard].map(text).join("|");
    const value = { id, item: text(item.sku || item.itemName || item.item_name || item.itemId), unit: text(item.unit ?? item.uom ?? item.uomName ?? item.uom_name),
      itemId: text(item.itemId ?? item.item_id),
      destinationLocationId: text(item.destinationLocationId ?? item.destination_location_id ?? item.locationId ?? item.location_id),
      destinationYard: text(item.destinationYard ?? item.destination_yard ?? item.toLocation ?? item.to_location),
      splitUnit: text(item.splitUnit ?? item.split_unit),
      ...Object.fromEntries(measures.map(field => [field, Number(measureAliases[field].map(alias => item[alias]).find(measure => measure !== undefined && measure !== null) ?? 0)])) };
    if (rows.has(id)) {for (const field of measures) {value[field] += rows.get(id)[field];}}
    rows.set(id, value);
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function orderProjection(order) {
  return { items: itemRows(order.items || []), ...Object.fromEntries(sourceFields.filter(field => Object.hasOwn(order, field)).map(field => [field, order[field]])) };
}

export function executedSourceDigest(order) {
  return createHash("sha256").update(stable(orderProjection(order))).digest("hex");
}

export function executedOrderChanges(before = {}, after = {}) {
  const changes = [];
  const oldItems = new Map(itemRows(before.items || []).map(item => [item.id, item]));
  const newItems = new Map(itemRows(after.items || []).map(item => [item.id, item]));
  for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
    const old = oldItems.get(id); const next = newItems.get(id);
    if (!old || !next) {
      changes.push({ field: old ? "item_removed" : "item_added", item: (old || next).item, lineId: id,
        before: old ? { quantity: old.quantity, unit: old.unit } : null, after: next ? { quantity: next.quantity, unit: next.unit } : null });
    } else {
      for (const field of ["itemId", "destinationLocationId", "destinationYard", "splitUnit", "unit", ...measures]) {if (!same(old[field], next[field])) {changes.push({ field: field === "pallets" ? "calculated_item_pallets" : field, item: old.item, lineId: id, before: old[field], after: next[field], unit: next.unit });}}
    }
  }
  for (const field of sourceFields) {
    if (!Object.hasOwn(before, field) || !Object.hasOwn(after, field) || same(before[field] ?? "", after[field] ?? "")) {continue;}
    changes.push({ field: field === "pallets" ? "calculated_pallets" : field, before: before[field] ?? "", after: after[field] });
  }
  return changes;
}

function leafOrders(order) {
  return order.childOrderDetails?.length ? order.childOrderDetails.flatMap(leafOrders) : [order];
}

export function plannedOrderContexts(plan = {}) {
  return (plan.trucks || []).flatMap(truck => (truck.loads || []).flatMap(load =>
    (load.stops || []).filter(physical).flatMap(stop => refs(stop).map(orderRef => ({
      orderRef, loadId: loadRef(load), loadName: text(load.name || load.loadName || load.id),
      driverLogin: text(load.driverLogin || truck.driverLogin), driverName: text(load.driverName || truck.driverName || load.driverLogin || truck.driverLogin),
      truckPlate: text(load.truckPlate || truck.plate || truck.id), stopId: text(stop.id || stop.stopId), stopType: text(stop.type || stop.stopType)
    })))
  ));
}

function buildOrderSourceReviews(previousPlan, contexts, sourceOrders) {
  const sources = new Map(sourceOrders.map(order => [key(identity(order)), order]));
  const reviews = new Map();
  for (const order of previousPlan.orders || []) {
    const own = contexts.filter(context => key(context.orderRef) === key(identity(order)));
    if (!own.length) {continue;}
    for (const leaf of leafOrders(order)) {
      const source = sources.get(key(identity(leaf)));
      if (!source) {continue;}
      const changes = executedOrderChanges(leaf, source);
      if (!changes.length) {continue;}
      const orderRef = identity(leaf);
      const token = createHash("sha256").update(stable({ planId: String(previousPlan.id || previousPlan.planId || ""), orderRef: key(orderRef), before: orderProjection(leaf), after: orderProjection(source) })).digest("hex");
      const existing = reviews.get(token);
      if (existing) { existing.contexts.push(...own); continue; }
      reviews.set(token, { token, orderRef, groupRef: identity(order) === orderRef ? "" : identity(order), contexts: own, changes,
        code: "DISPATCH_EXECUTED_SOURCE_REVIEW_REQUIRED", acknowledged: false,
        message: `${orderRef}: source information differs from the recorded plan for executed work. Review and confirm the updated information. Driver execution records remain unchanged.`,
        source: "server_order_mirror", sourceLabel: "Current source order (NetSuite / Dispatch details)",
        beforeOrder: leaf, sourceOrder: source });
    }
  }
  return [...reviews.values()];
}

export function buildExecutedOrderReviews({ previousPlan = {}, activity = [], sourceOrders = [] } = {}) {
  return buildOrderSourceReviews(previousPlan, executedOrderContexts(previousPlan, activity), sourceOrders);
}

export function reviewableSourceChanges(changes = []) {
  return changes.filter(change => change.field !== "weight");
}

export function sourceReviewChangesDigest(changes = []) {
  return createHash("sha256").update(stable(reviewableSourceChanges(changes)
    .map(({ message: _message, ...change }) => change))).digest("hex");
}

export function buildPlannedOrderReviews({ previousPlan = {}, activity = [], sourceOrders = [] } = {}) {
  const executed = executedOrderContexts(previousPlan, activity);
  return buildOrderSourceReviews(previousPlan, plannedOrderContexts(previousPlan), sourceOrders).map(review => ({
    ...review,
    changes: reviewableSourceChanges(review.changes),
    message: `${review.orderRef}: source information differs from the saved plan. Review the changes and re-plan remaining work where needed. Source updates and planning saves continue.`,
    replanRequested: review.contexts.some(context => !executed.some(recorded => recorded.loadId === context.loadId
      && recorded.stopId === context.stopId && key(recorded.orderRef) === key(context.orderRef)))
  })).filter(review => review.changes.length);
}

function compareOrder(before, next, reviews) {
  if (!next) {return before;}
  const result = { ...before };
  const review = reviews.find(candidate => key(candidate.orderRef) === key(identity(before)));
  if (review) {
    if (same(itemRows(next.items || []), itemRows(review.sourceOrder.items || []))) {result.items = next.items;}
    for (const field of sourceFields) {if (Object.hasOwn(review.sourceOrder, field) && same(next[field], review.sourceOrder[field])) {result[field] = next[field];}}
  }
  if (before.childOrderDetails?.length) {
    result.childOrderDetails = before.childOrderDetails.map(child => compareOrder(child, next.childOrderDetails?.find(value => key(identity(value)) === key(identity(child))), reviews));
    if (same(result.childOrderDetails, before.childOrderDetails)) {return result;}
    const aggregateItems = result.childOrderDetails.flatMap(child => child.items || []);
    if (same(itemRows(next.items || []), itemRows(aggregateItems))) {result.items = next.items;}
    const first = result.childOrderDetails[0];
    for (const field of ["address", "destinationAddress"]) {
      if (same(before[field], before.childOrderDetails[0]?.[field] ?? before.childOrderDetails[0]?.address) && same(next[field], first?.[field] ?? first?.address)) {result[field] = next[field];}
    }
  }
  return result;
}

export function reviewedExecutionComparison({ previousPlan = {}, nextPlan = {}, reviews = [] } = {}) {
  if (!reviews.length) {return previousPlan;}
  return { ...previousPlan, orders: (previousPlan.orders || []).map(order => compareOrder(order, (nextPlan.orders || []).find(next => key(identity(next)) === key(identity(order))), reviews)) };
}

function restoreReviewedOrder(before, submitted, approved) {
  if (!before || !approved) {return submitted;}
  const result = { ...submitted };
  for (const field of ["items", ...sourceFields]) {
    if (same(before[field], approved[field])) {continue;}
    if (Object.hasOwn(before, field)) {result[field] = structuredClone(before[field]);}
    else {delete result[field];}
  }
  if (Array.isArray(submitted.childOrderDetails)) {
    result.childOrderDetails = submitted.childOrderDetails.map(child => restoreReviewedOrder(
      before.childOrderDetails?.find(value => key(identity(value)) === key(identity(child))), child,
      approved.childOrderDetails?.find(value => key(identity(value)) === key(identity(child)))
    ));
  }
  return result;
}

function stopSourceFields(stop) {
  const cargo = Object.fromEntries(["Pallets", "Layers", "Sections", "Pieces", "SalesQty", "Weight"]
    .flatMap(name => [[`drop${name}`, [name[0].toLowerCase() + name.slice(1)]], [name[0].toLowerCase() + name.slice(1), [name[0].toLowerCase() + name.slice(1)]]]));
  if (["pick", "pickup"].includes(text(stop.type || stop.stopType))) {
    return { location: ["sourceYard"], yard: ["sourceYard"], address: ["sourceAddress"] };
  }
  return { ...cargo, address: ["address", "dropAddress", "destinationAddress"], dropAddress: ["address", "dropAddress", "destinationAddress"],
    location: ["destinationYard", "toLocation"], yard: ["destinationYard", "toLocation"], dropLocation: ["destinationYard", "toLocation"],
    destinationYard: ["destinationYard"], destinationLocationId: ["destinationLocationId"] };
}

function restoreReviewedStop(before, submitted, reviews) {
  if (!before) {return submitted;}
  const result = { ...submitted };
  for (const [field, sourceNames] of Object.entries(stopSourceFields(before))) {
    const verified = reviews.some(review => sourceNames.some(sourceName => {
      const oldValue = review.beforeOrder[sourceName];
      const sourceValue = review.sourceOrder[sourceName];
      return oldValue !== undefined && sourceValue !== undefined && !same(oldValue, sourceValue)
        && (before[field] === undefined || same(before[field], oldValue)) && same(submitted[field], sourceValue);
    }));
    if (!verified) {continue;}
    if (Object.hasOwn(before, field)) {result[field] = structuredClone(before[field]);}
    else {delete result[field];}
  }
  return result;
}

function restoreReviewedStops(previousPlan, nextPlan, reviews) {
  const oldLoads = new Map((previousPlan.trucks || []).flatMap(truck => (truck.loads || []).map(load => [loadRef(load), load])));
  return (nextPlan.trucks || []).map(truck => ({ ...truck, loads: (truck.loads || []).map(load => ({ ...load,
    stops: (load.stops || []).map(stop => {
      const own = reviews.filter(review => review.contexts.some(context => context.loadId === loadRef(load) && context.stopId === text(stop.id || stop.stopId)));
      if (!own.length) {return stop;}
      const before = oldLoads.get(loadRef(load))?.stops?.find(candidate => text(candidate.id || candidate.stopId) === text(stop.id || stop.stopId));
      return restoreReviewedStop(before, stop, own);
    })
  })) }));
}

export function reconcileExecutedSourcePlan({ previousPlan = {}, nextPlan = {}, reviews = [] } = {}) {
  if (!reviews.length) {return nextPlan;}
  const approved = reviewedExecutionComparison({ previousPlan, nextPlan, reviews });
  return { ...nextPlan, orders: (nextPlan.orders || []).map(order => restoreReviewedOrder(
    (previousPlan.orders || []).find(value => key(identity(value)) === key(identity(order))), order,
    (approved.orders || []).find(value => key(identity(value)) === key(identity(order)))
  )), trucks: restoreReviewedStops(previousPlan, nextPlan, reviews) };
}

function display(value) {
  if (value === null || value === undefined || value === "") {return "blank";}
  if (typeof value === "object" && "quantity" in value) {return `${value.quantity} ${value.unit}`.trim();}
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function executedChangeMessage(change) {
  const labels = { item_removed: "item removed", item_added: "item added", calculated_pallets: "calculated pallet total", calculated_item_pallets: "calculated item pallets",
    address: "delivery address", destinationAddress: "delivery address", dropAddress: "stop delivery address", sourceAddress: "pickup address", sourceYard: "pickup yard",
    pickupLocations: "pickup yards", destinationYard: "destination yard", destinationLocationId: "destination", driverLogin: "driver", driverName: "driver name",
    truckId: "truck", truckPlate: "truck plate", driverSequence: "load sequence", plannedStartMinute: "planned load start", plannedFinishMinute: "planned load finish",
    arrival: "planned arrival", depart: "planned departure", stop_sequence: "stop sequence", orderId: "stop order", orderRefs: "stop orders", order_removed: "order removed", load_removed: "load removed", stop_removed: "stop removed" };
  const format = value => {
    if (["arrival", "depart", "plannedStartMinute", "plannedFinishMinute"].includes(change.field) && value !== null && value !== "" && Number.isFinite(Number(value))) {
      return `${String(Math.floor(Number(value) / 60)).padStart(2, "0")}:${String(Math.round(Number(value) % 60)).padStart(2, "0")}`;
    }
    return `${display(value)}${change.field === "quantity" && change.unit ? ` ${change.unit}` : ""}`;
  };
  return `${change.orderRef ? `${change.orderRef}: ` : ""}${change.item ? `${change.item} — ` : ""}${labels[change.field] || change.field}: ${format(change.before)} → ${format(change.after)}`;
}

export function describeExecutedPrefixConflicts(previousPlan, nextPlan, conflicts, activity) {
  if (!conflicts.length) {return conflicts;}
  const contexts = executedOrderContexts(previousPlan, activity);
  const loads = plan => new Map((plan.trucks || []).flatMap(truck => (truck.loads || []).map(load => [text(load.id || load.loadId), { load, truck }])));
  const oldLoads = loads(previousPlan); const newLoads = loads(nextPlan);
  return conflicts.map(conflict => {
    const ids = new Set([conflict.loadId, ...(conflict.lockedLoadIds || [])].filter(Boolean));
    const own = contexts.filter(context => ids.has(context.loadId));
    const changes = [];
    for (const ref of new Set(own.map(context => context.orderRef))) {
      const before = (previousPlan.orders || []).find(order => key(identity(order)) === key(ref));
      const after = (nextPlan.orders || []).find(order => key(identity(order)) === key(ref));
      if (!after) {changes.push({ orderRef: ref, field: "order_removed", before: ref, after: null });}
      else if (before) {
        changes.push(...reviewableSourceChanges(executedOrderChanges(before, after)).map(change => ({ ...change, orderRef: ref })));
        for (const child of leafOrders(before).filter(candidate => candidate !== before)) {
          const updated = leafOrders(after).find(value => key(identity(value)) === key(identity(child)));
          changes.push(...reviewableSourceChanges(updated ? executedOrderChanges(child, updated) : [{ field: "order_removed", before: identity(child), after: null }]).map(change => ({ ...change, orderRef: identity(child) })));
        }
      }
    }
    for (const id of ids) {
      const before = oldLoads.get(id); const after = newLoads.get(id);
      if (!before) {continue;}
      if (!after) { changes.push({ field: "load_removed", loadId: id, before: before.load.name || id, after: null }); continue; }
      for (const field of ["driverLogin", "driverName", "truckId", "truckPlate", "name", "driverSequence", "plannedStartMinute", "plannedFinishMinute", "switchYard", "parkingSpot", "handoffTravelMinutes", "returnOnly", "returnYard"]) {
        if (!same(before.load[field], after.load[field])) {changes.push({ field, loadId: id, before: before.load[field] ?? null, after: after.load[field] ?? null });}
      }
      for (const context of own.filter(value => value.loadId === id)) {
        const oldStop = before.load.stops.find(stop => text(stop.id || stop.stopId) === context.stopId);
        const nextStop = after.load.stops.find(stop => text(stop.id || stop.stopId) === context.stopId);
        if (!nextStop) { changes.push({ orderRef: context.orderRef, field: "stop_removed", before: context.stopId, after: null }); continue; }
        for (const field of ["type", "location", "address", "yard", "dropAddress", "dropLocation", "destinationYard", "destinationLocationId", "orderId", "orderRefs",
          "instructions", "instruction", "notes", "lineRowIds", "dropPallets", "dropLayers", "dropSections", "dropPieces", "dropSalesQty",
          "plannedArrivalMinute", "plannedDepartureMinute"]) {
          if (!same(oldStop[field], nextStop[field])) {changes.push({ orderRef: context.orderRef, stopId: context.stopId, field, before: oldStop[field] ?? null, after: nextStop[field] ?? null });}
        }
        for (const field of ["arrival", "depart"]) {
          if (!same(oldStop.timing?.[field], nextStop.timing?.[field])) {changes.push({ orderRef: context.orderRef, stopId: context.stopId, field, before: oldStop.timing?.[field] ?? null, after: nextStop.timing?.[field] ?? null });}
        }
      }
      const beforeIds = (before.load.stops || []).map(stop => text(stop.id));
      const afterIds = (after.load.stops || []).map(stop => text(stop.id));
      if (!same(beforeIds.slice(0, conflict.throughStopIndex + 1 || beforeIds.length), afterIds.slice(0, conflict.throughStopIndex + 1 || beforeIds.length))) {changes.push({ field: "stop_sequence", loadId: id, before: beforeIds, after: afterIds });}
    }
    const context = own[0];
    const label = context ? `${context.driverName || context.driverLogin}, ${context.truckPlate}, ${context.loadName}` : conflict.driverLogin || conflict.loadId || "Executed route";
    return { ...conflict, orderRefs: [...new Set(own.map(value => value.orderRef))], contexts: own, changes,
      message: `${label}: executed work is protected. ${changes.length ? changes.map(executedChangeMessage).join("; ") : conflict.message} Restore these recorded details before saving later work. Verified source updates are accepted without blocking planning and have a separate review warning.` };
  });
}
