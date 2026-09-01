const DISPATCH_PLANNER_MODES = new Set(["off", "shadow", "on"]);
const CARD_ITEM_LIMIT = 8;

function text(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  if (value === undefined) {return undefined;}
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (value instanceof Date) {return value.toJSON();}
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (!value || typeof value !== "object") {return value;}
  return Object.fromEntries(Object.entries(value)
    .filter(([, candidate]) => candidate !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, stableValue(candidate)]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function identity(value = {}, fallback = "") {
  return text(value.id || value.orderId || value.orderRef || value.tranid || value.refNumber || value.plate || fallback);
}

function keyed(values = []) {
  const result = new Map();
  for (const value of values || []) {
    const key = identity(value);
    if (key) {result.set(key, value);}
  }
  return result;
}

function nonEnumerableAlias(target, name, value) {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: false,
    value
  });
}

export function normalizeDispatchPlannerMode(value) {
  const mode = text(value).toLowerCase();
  return DISPATCH_PLANNER_MODES.has(mode) ? mode : "off";
}

function compactCardItem(item = {}) {
  const fields = [
    "id", "lineId", "lineUniqueKey", "sku", "itemName", "description", "quantity",
    "pallets", "layers", "sections", "pieces", "salesQty", "unit", "uom", "location",
    "locationId", "sourceYard", "destinationYard"
  ];
  return Object.fromEntries(fields
    .filter((key) => item[key] !== undefined && item[key] !== null && item[key] !== "")
    .map((key) => [key, typeof item[key] === "string" ? text(item[key]).slice(0, 240) : item[key]]));
}

function compactTransitCo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {return undefined;}
  const id = text(value.id || value.coRef).slice(0, 240);
  if (!id) {return undefined;}
  const result = { id };
  for (const key of ["fromYard", "toYard", "status", "sourceOrderId", "source", "createdAt", "updatedAt"]) {
    const candidate = text(value[key]).slice(0, 240);
    if (candidate) {result[key] = candidate;}
  }
  return result;
}

export function compactDispatchOrderCard(order = {}) {
  const fields = [
    "id", "orderId", "orderRef", "tranid", "refNumber", "type", "orderKind", "sourceTable",
    "customer", "customerName", "address", "dropAddress", "destinationAddress", "pickupAddress",
    "pickupAddressOverride", "sourceAddress", "dropoffLocation", "pickupLocation", "pickupLocations",
    "sourceYard", "destinationYard", "destinationLocationId", "expectedDeliveryDate", "windowStart",
    "windowEnd", "pallets", "layers", "salesQty", "weight", "totalWeightLbs", "status", "statusText",
    "localDispatchStatus", "dispatchRef", "originalPoRef", "sourcePoRef", "sourcePoRefs",
    "correspondingPoRefs", "originalOrderId", "sourceOrderId",
    "relatedSoId", "childOrders", "groupAliases", "groupPlanId", "groupPlanDate", "planOwned",
    "globalGroupDefinition", "globalGroupSourcePlanId", "globalGroupSourcePlanDate",
    "globalOrderDefinition", "globalOrderDefinitionKind", "globalOrderSourcePlanId", "globalOrderSourcePlanDate",
    "isSplit", "isGrouped", "dependencyDirectPickup", "dependencyWaitingForTransfer",
    "dependencyAttention", "dependencyUncovered", "dependencyUncoveredQuantity",
    "historicalReconciliationComplete", "historicalPlanDate", "reconciliationStatus",
    "reconciliationReason", "reconciliationBlocked", "completionStatus", "dispatchCompletionStatus"
  ];
  const card = Object.fromEntries(fields
    .filter((key) => order[key] !== undefined)
    .map((key) => [key, clone(order[key])]));
  const transitCo = compactTransitCo(order.transitCo);
  if (transitCo) {card.transitCo = transitCo;}
  card.id = identity(order);
  card.type = text(order.type).toUpperCase();
  card.items = (Array.isArray(order.items) ? order.items : [])
    .slice(0, CARD_ITEM_LIMIT)
    .map(compactCardItem);
  card.itemCount = Array.isArray(order.items) ? order.items.length : 0;
  card.catalogHydrated = false;
  return card;
}

function safeSearchValues(order = {}) {
  const itemValues = (Array.isArray(order.items) ? order.items : []).flatMap((item) => [
    item?.id,
    item?.lineId,
    item?.lineUniqueKey,
    item?.sku,
    item?.itemName,
    item?.description
  ]);
  const childValues = (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []).flatMap((child) => [
    child?.id,
    child?.originalOrderId,
    child?.customer,
    ...(Array.isArray(child?.items) ? child.items.flatMap((item) => [item?.sku, item?.itemName]) : [])
  ]);
  return [
    order.id,
    order.orderId,
    order.orderRef,
    order.tranid,
    order.refNumber,
    order.type,
    order.dispatchRef,
    order.originalPoRef,
    order.sourcePoRef,
    ...(Array.isArray(order.sourcePoRefs) ? order.sourcePoRefs : []),
    ...(Array.isArray(order.correspondingPoRefs) ? order.correspondingPoRefs : []),
    order.originalOrderId,
    order.sourceOrderId,
    order.relatedSoId,
    order.customer,
    order.customerName,
    order.address,
    order.dropAddress,
    order.destinationAddress,
    order.pickupAddress,
    order.pickupAddressOverride,
    order.sourceAddress,
    order.sourceYard,
    order.destinationYard,
    order.expectedDeliveryDate,
    order.notes,
    ...(Array.isArray(order.childOrders) ? order.childOrders : []),
    ...(Array.isArray(order.groupAliases) ? order.groupAliases : []),
    ...childValues,
    ...itemValues
  ];
}

export function dispatchOrderSearchText(order = {}) {
  return safeSearchValues(order)
    .map(text)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .slice(0, 100_000);
}

function relationMetadata(value = {}, omittedKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {return {};}
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, candidate]) => !omitted.has(key) && candidate !== undefined)
    .map(([key, candidate]) => [key, clone(candidate)]));
}

export function extractDispatchOrderRelationEdges(plan = {}) {
  const edges = [];
  const seenEdges = new Set();
  const visitedObjects = new Set();
  const add = (relationType, ownerRef, memberRef, metadata = {}) => {
    const owner = text(ownerRef);
    const member = text(memberRef);
    if (!owner || !member) {return;}
    const key = `${relationType}\u0000${owner.toLowerCase()}\u0000${member.toLowerCase()}`;
    if (seenEdges.has(key)) {return;}
    seenEdges.add(key);
    edges.push({ relationType, ownerRef: owner, memberRef: member, metadata: clone(metadata) || {} });
  };
  const visit = (order, groupOwner = "") => {
    if (!order || typeof order !== "object" || visitedObjects.has(order)) {return;}
    visitedObjects.add(order);
    const ref = identity(order);
    if (!ref) {return;}
    if (groupOwner && groupOwner.toLowerCase() !== ref.toLowerCase()) {
      add("group_member", groupOwner, ref);
    }
    const childDetails = new Map((Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
      .map((child) => [identity(child).toLowerCase(), child])
      .filter(([childRef]) => childRef));
    const childRefs = [...new Set([
      ...(Array.isArray(order.childOrders) ? order.childOrders : []),
      ...childDetails.values()
    ].map((child) => typeof child === "object" ? identity(child) : text(child)).filter(Boolean))];
    for (const childRef of childRefs) {add("group_member", ref, childRef);}

    const parentRef = text(order.originalOrderId || order.parentOrderRef);
    if (parentRef && parentRef.toLowerCase() !== ref.toLowerCase()) {
      add("split_child", parentRef, ref);
    }
    for (const manifest of Array.isArray(order.poPickupManifest) ? order.poPickupManifest : []) {
      const poRef = text(manifest?.poOrderRef || manifest?.orderRef || manifest?.id);
      add("po_link", ref, poRef, relationMetadata(manifest, ["poOrderRef", "orderRef", "id"]));
    }
    for (const dependency of Array.isArray(order.orderDependencies) ? order.orderDependencies : []) {
      const toRef = text(dependency?.transferOrderRef || dependency?.orderRef);
      if (!toRef) {continue;}
      const metadata = relationMetadata(dependency, ["transferOrderRef", "orderRef"]);
      add("to_link", ref, toRef, metadata);
      if (text(dependency?.mode).toLowerCase() === "direct_to_customer") {
        add("direct_ship", ref, toRef, metadata);
      }
    }
    const coRef = text(order.transitCo?.id || order.transitCo?.coRef);
    if (coRef) {
      add("co_source", coRef, text(order.transitCo?.sourceOrderId) || ref,
        relationMetadata(order.transitCo, ["id", "coRef", "sourceOrderId"]));
    }
    for (const childRef of childRefs) {
      const child = childDetails.get(childRef.toLowerCase());
      if (child) {visit(child, ref);}
    }
  };
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) {visit(order);}
  return edges;
}

function changedValues(beforeValues = [], afterValues = []) {
  const before = keyed(beforeValues);
  const after = keyed(afterValues);
  return {
    upserts: [...after.entries()]
      .filter(([key, value]) => stableJson(before.get(key)) !== stableJson(value))
      .map(([, value]) => clone(value)),
    removals: [...before.keys()].filter((key) => !after.has(key)),
    order: [...after.keys()]
  };
}

function deltaAliases(delta, aliases = {}) {
  const orderRefsRemoved = clone(aliases.orderRefsRemoved || delta.or || []);
  const truckIdsRemoved = clone(aliases.truckIdsRemoved || delta.tr || []);
  const orderOrder = clone(aliases.orderOrder || delta.oo || (delta.orders || []).map(identity));
  const truckOrder = clone(aliases.truckOrder || delta.to || (delta.trucks || []).map(identity));
  nonEnumerableAlias(delta, "orderRefsRemoved", orderRefsRemoved);
  nonEnumerableAlias(delta, "truckIdsRemoved", truckIdsRemoved);
  nonEnumerableAlias(delta, "orderOrder", orderOrder);
  nonEnumerableAlias(delta, "truckOrder", truckOrder);
  return delta;
}

export function buildDispatchPlanDelta(beforePlan = {}, afterPlan = {}) {
  const orders = changedValues(beforePlan.orders || [], afterPlan.orders || []);
  const trucks = changedValues(beforePlan.trucks || [], afterPlan.trucks || []);
  const beforeMetadata = Object.fromEntries(Object.entries(beforePlan)
    .filter(([key]) => !["orders", "trucks", "summary"].includes(key)));
  const afterMetadata = Object.fromEntries(Object.entries(afterPlan)
    .filter(([key]) => !["orders", "trucks", "summary"].includes(key)));
  const compact = {};
  if (orders.upserts.length) {compact.o = orders.upserts;}
  if (orders.removals.length) {compact.or = orders.removals;}
  if (stableJson([...keyed(beforePlan.orders || []).keys()]) !== stableJson(orders.order)) {compact.oo = orders.order;}
  if (trucks.upserts.length) {compact.t = trucks.upserts;}
  if (trucks.removals.length) {compact.tr = trucks.removals;}
  if (stableJson([...keyed(beforePlan.trucks || []).keys()]) !== stableJson(trucks.order)) {compact.to = trucks.order;}
  if (stableJson(beforePlan.summary || {}) !== stableJson(afterPlan.summary || {})) {compact.s = clone(afterPlan.summary || {});}
  if (stableJson(beforeMetadata) !== stableJson(afterMetadata)) {compact.m = clone(afterMetadata);}

  const replacement = {
    orders: clone(afterPlan.orders || []),
    trucks: clone(afterPlan.trucks || []),
    summary: clone(afterPlan.summary || {})
  };
  if (stableJson(beforeMetadata) !== stableJson(afterMetadata)) {replacement.m = clone(afterMetadata);}
  const delta = JSON.stringify(replacement).length < JSON.stringify(compact).length ? replacement : compact;
  return deltaAliases(delta, {
    orderRefsRemoved: orders.removals,
    truckIdsRemoved: trucks.removals,
    orderOrder: orders.order,
    truckOrder: trucks.order
  });
}

function applyKeyedDelta(currentValues = [], upserts = [], removals = [], requestedOrder = null) {
  const map = keyed(currentValues);
  for (const ref of removals || []) {map.delete(text(ref));}
  for (const value of upserts || []) {
    const key = identity(value);
    if (key) {map.set(key, clone(value));}
  }
  const order = Array.isArray(requestedOrder) ? requestedOrder.map(text).filter(Boolean) : [...map.keys()];
  const emitted = new Set();
  const result = [];
  for (const key of order) {
    if (!map.has(key) || emitted.has(key)) {continue;}
    emitted.add(key);
    result.push(map.get(key));
  }
  for (const [key, value] of map) {
    if (!emitted.has(key)) {result.push(value);}
  }
  return result;
}

export function applyDispatchPlanDelta(plan = {}, delta = {}) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    throw new TypeError("Dispatch plan delta must be an object.");
  }
  if (Array.isArray(delta.orders) && Array.isArray(delta.trucks)) {
    return {
      ...clone(plan),
      ...(delta.m && typeof delta.m === "object" ? clone(delta.m) : {}),
      orders: clone(delta.orders),
      trucks: clone(delta.trucks),
      summary: clone(delta.summary && typeof delta.summary === "object" ? delta.summary : {})
    };
  }
  return {
    ...clone(plan),
    ...(delta.m && typeof delta.m === "object" ? clone(delta.m) : {}),
    orders: applyKeyedDelta(plan.orders || [], delta.o || [], delta.or || [], delta.oo),
    trucks: applyKeyedDelta(plan.trucks || [], delta.t || [], delta.tr || [], delta.to),
    summary: delta.s && typeof delta.s === "object" ? clone(delta.s) : clone(plan.summary || {})
  };
}

export function dispatchCheckpointDecision({
  commandsSinceCheckpoint = 0,
  lastCheckpointAt = "",
  now = new Date(),
  commandLimit = 25,
  elapsedMinutes = 5
} = {}) {
  const commands = Math.max(0, Number(commandsSinceCheckpoint) || 0);
  if (commands >= Math.max(1, Number(commandLimit) || 25)) {return { due: true, trigger: "command_count" };}
  const nowMs = new Date(now).getTime();
  const lastMs = new Date(lastCheckpointAt).getTime();
  const elapsedMs = Math.max(1, Number(elapsedMinutes) || 5) * 60 * 1000;
  if (commands > 0 && Number.isFinite(nowMs) && Number.isFinite(lastMs) && nowMs - lastMs >= elapsedMs) {
    return { due: true, trigger: "elapsed_time" };
  }
  return { due: false, trigger: "" };
}

export function dispatchCheckpointRetention({ kind = "periodic", resolvedAt = null } = {}) {
  const normalized = text(kind).toLowerCase();
  if (normalized === "recovery" && !resolvedAt) {return null;}
  if (["manual", "lifecycle", "recovery"].includes(normalized)) {return 90;}
  return 7;
}

export function classifyDispatchReplayEvidence(event = {}) {
  if (Object.hasOwn(event, "payload") && event.payload !== null && typeof event.payload === "object") {return "exact";}
  if (Object.hasOwn(event, "before") && Object.hasOwn(event, "after")) {return "state-derived";}
  return "gap";
}

function replayTimestamp(event = {}) {
  const parsed = Date.parse(text(event.serverAt || event.createdAt || event.at));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function mergeDispatchReplayEvents(streams = []) {
  const events = (Array.isArray(streams) ? streams.flat(Infinity) : [])
    .filter((event) => event && typeof event === "object")
    .map((event, inputIndex) => ({
      ...clone(event),
      evidence: classifyDispatchReplayEvidence(event),
      inputIndex
    }));
  events.sort((left, right) => {
    const serverDifference = replayTimestamp(left) - replayTimestamp(right);
    if (serverDifference) {return serverDifference;}
    const sequenceDifference = (Number(left.sourceSequence) || 0) - (Number(right.sourceSequence) || 0);
    if (sequenceDifference) {return sequenceDifference;}
    if (left.stream === "driver" && right.stream === "driver") {
      const deviceDifference = Date.parse(text(left.deviceAt || left.occurredAt)) - Date.parse(text(right.deviceAt || right.occurredAt));
      if (Number.isFinite(deviceDifference) && deviceDifference) {return deviceDifference;}
    }
    return left.inputIndex - right.inputIndex;
  });
  return events.map(({ inputIndex: _inputIndex, ...event }) => event);
}
