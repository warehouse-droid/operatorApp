import crypto from "node:crypto";

const PLAN_OWNED_TYPES = new Set(["CO", "CUSTOM", "GROUP", "SPLIT"]);
const PHYSICAL_STOP_TYPES = new Set([
  "pick",
  "pickup",
  "drop",
  "dropoff",
  "delivery",
  "return",
  "yard",
  "bin_delivery",
  "bin_exchange",
  "bin_collection"
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value) {
  return String(value ?? "").trim();
}

function orderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function stopRefs(stop = {}) {
  return [...new Set([
    stop.orderId,
    stop.order_id,
    stop.orderRef,
    stop.tranid,
    ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : [])
  ].map(text).filter(Boolean))];
}

function referencedOrderRefs(trucks = []) {
  const refs = new Set();
  for (const truck of trucks || []) {
    for (const load of truck?.loads || []) {
      for (const order of load?.orders || []) {
        const ref = orderRef(order);
        if (ref) {refs.add(ref);}
      }
      for (const stop of load?.stops || []) {
        for (const ref of stopRefs(stop)) {refs.add(ref);}
      }
    }
  }
  return refs;
}

function relatedOrderRefs(order = {}) {
  return [...new Set([
    order.originalOrderId,
    order.sourceOrderId,
    order.parentOrderId,
    order.transitCo?.sourceOrderId,
    ...(Array.isArray(order.childOrders) ? order.childOrders : []),
    ...(Array.isArray(order.orderRefs) ? order.orderRefs : []),
    ...(Array.isArray(order.childOrderDetails)
      ? order.childOrderDetails.flatMap((child) => [orderRef(child), ...relatedOrderRefs(child)])
      : [])
  ].map(text).filter(Boolean))];
}

function planOwnedOrder(order = {}) {
  const type = text(order.type).toUpperCase();
  return PLAN_OWNED_TYPES.has(type)
    || Boolean(order.originalOrderId)
    || Boolean(order.transitCo)
    || Boolean(order.planOwned)
    || Boolean(order.isSplit)
    || Boolean(order.isGrouped);
}

function compactOrderRefs(plan = {}) {
  const orders = Array.isArray(plan.orders) ? plan.orders : [];
  const byRef = new Map(orders.map((order) => [orderRef(order), order]).filter(([ref]) => ref));
  const included = referencedOrderRefs(plan.trucks || []);
  for (const order of orders) {
    const ref = orderRef(order);
    if (ref && planOwnedOrder(order)) {included.add(ref);}
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const order of orders) {
      const ref = orderRef(order);
      if (!ref) {continue;}
      const related = relatedOrderRefs(order);
      const touchesIncluded = included.has(ref) || related.some((candidate) => included.has(candidate));
      if (!touchesIncluded || (!included.has(ref) && !planOwnedOrder(order))) {continue;}
      for (const candidate of related) {
        if (byRef.has(candidate) && !included.has(candidate)) {
          included.add(candidate);
          changed = true;
        }
      }
    }
  }
  return included;
}

function stableValue(value) {
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (!value || typeof value !== "object") {return value;}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, candidate]) => candidate !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => [key, stableValue(candidate)])
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function boardOrderRefs(plan = {}) {
  const result = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck?.loads || []) {
      for (const stop of load?.stops || []) {
        for (const ref of stopRefs(stop)) {
          if (!result.includes(ref)) {result.push(ref);}
        }
      }
    }
  }
  return result;
}

function planWithoutVolatileFields(plan = {}) {
  const compact = buildCompactDispatchSnapshot(plan);
  return {
    id: text(compact.id || compact.planId),
    planDate: text(compact.planDate).slice(0, 10),
    status: compact.status,
    note: compact.note,
    orders: compact.orders || [],
    trucks: compact.trucks || [],
    summary: compact.summary || {}
  };
}

export function buildCompactDispatchSnapshot(plan = {}) {
  const refs = compactOrderRefs(plan);
  return {
    ...clone(plan),
    orders: (plan.orders || []).filter((order) => refs.has(orderRef(order))).map(clone),
    trucks: (plan.trucks || []).map(clone)
  };
}

export function digestDispatchPlan(plan = {}) {
  return crypto.createHash("sha256").update(stableJson(planWithoutVolatileFields(plan))).digest("hex");
}

function commandError(message, code, status = 409, details = {}) {
  return Object.assign(new Error(message), { code, status, ...details });
}

export function createDispatchCommandReceiptStore() {
  const receipts = new Map();
  return {
    get(commandId) {
      const receipt = receipts.get(text(commandId));
      return receipt ? clone(receipt) : null;
    },
    set(commandId, receipt) {
      receipts.set(text(commandId), clone(receipt));
      return clone(receipt);
    },
    has(commandId) {
      return receipts.has(text(commandId));
    }
  };
}

function locateLoad(plan, loadId, truckId = "") {
  const cleanLoadId = text(loadId);
  const cleanTruckId = text(truckId);
  for (const truck of plan.trucks || []) {
    if (cleanTruckId && ![truck.id, truck.plate, truck.truckPlate].map(text).includes(cleanTruckId)) {continue;}
    const load = (truck.loads || []).find((candidate) => text(candidate.id) === cleanLoadId);
    if (load) {return { truck, load };}
  }
  return null;
}

function removeRefFromStop(stop, ref) {
  const refs = stopRefs(stop);
  if (!refs.includes(ref)) {return clone(stop);}
  if (Array.isArray(stop.orderRefs)) {
    const remaining = stop.orderRefs.map(text).filter((candidate) => candidate && candidate !== ref);
    if (!remaining.length) {return null;}
    return { ...clone(stop), orderRefs: remaining };
  }
  return null;
}

function removeOrderFromBoard(plan, ref) {
  let removed = false;
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      const nextStops = [];
      for (const stop of load.stops || []) {
        const nextStop = removeRefFromStop(stop, ref);
        if (!nextStop) {
          removed = true;
          continue;
        }
        if (stableJson(nextStop) !== stableJson(stop)) {removed = true;}
        nextStops.push(nextStop);
      }
      load.stops = nextStops;
      if (Array.isArray(load.orders)) {
        const before = load.orders.length;
        load.orders = load.orders.filter((candidate) => orderRef(candidate) !== ref);
        if (load.orders.length !== before) {removed = true;}
      }
    }
  }
  return removed;
}

function defaultAssignedStop(plan, ref, payload = {}) {
  const snapshot = (plan.orders || []).find((order) => orderRef(order) === ref) || {};
  return {
    id: text(payload.stopId) || `dispatch-${ref}-${crypto.randomUUID()}`,
    type: text(payload.stopType) || "delivery",
    orderRefs: [ref],
    orderId: ref,
    location: payload.location || snapshot.dropoffLocation || snapshot.address || ""
  };
}

function assignOrder(plan, payload = {}) {
  const ref = text(payload.orderRef);
  if (!ref) {throw commandError("An order reference is required.", "DISPATCH_COMMAND_INVALID", 400);}
  if (boardOrderRefs(plan).includes(ref)) {
    throw commandError(`${ref} is already planned.`, "DISPATCH_ORDER_ALREADY_PLANNED");
  }
  const located = locateLoad(plan, payload.loadId, payload.truckId);
  if (!located) {throw commandError("The target Dispatch load no longer exists.", "DISPATCH_LOAD_NOT_FOUND", 404);}
  const stop = payload.stop ? clone(payload.stop) : defaultAssignedStop(plan, ref, payload);
  const stops = located.load.stops || (located.load.stops = []);
  const afterIndex = payload.afterStopId
    ? stops.findIndex((candidate) => text(candidate.id) === text(payload.afterStopId))
    : -1;
  stops.splice(afterIndex >= 0 ? afterIndex + 1 : stops.length, 0, stop);
  return { assignedOrderRefs: [ref], stop: clone(stop) };
}

function groupOrders(plan, payload = {}) {
  const refs = [...new Set((payload.orderRefs || []).map(text).filter(Boolean))];
  if (refs.length < 2) {throw commandError("Select at least two orders to group.", "DISPATCH_GROUP_INVALID", 400);}
  const positions = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const [index, stop] of (load.stops || []).entries()) {
        if (stopRefs(stop).some((ref) => refs.includes(ref))) {positions.push({ truck, load, index, stop });}
      }
    }
  }
  if (!positions.length) {throw commandError("The selected orders are no longer on this plan.", "DISPATCH_ORDER_NOT_PLANNED", 409);}
  const first = positions[0];
  if (positions.some((position) => position.load !== first.load)) {
    throw commandError("Grouped orders must be on the same load.", "DISPATCH_GROUP_LOAD_MISMATCH", 409);
  }
  const ref = text(payload.groupRef) || `GROUP-${crypto.createHash("sha1").update(refs.slice().sort().join("|")).digest("hex").slice(0, 12).toUpperCase()}`;
  const sourceOrders = refs.map((candidate) => (plan.orders || []).find((order) => orderRef(order) === candidate)).filter(Boolean);
  const group = {
    ...(sourceOrders[0] ? clone(sourceOrders[0]) : {}),
    id: ref,
    orderId: ref,
    refNumber: ref,
    type: "GROUP",
    childOrders: refs,
    childOrderDetails: sourceOrders.map(clone),
    planOwned: true
  };
  plan.orders = [...(plan.orders || []).filter((order) => orderRef(order) !== ref), group];
  const insertion = Math.min(...positions.map(({ index }) => index));
  first.load.stops = (first.load.stops || []).filter((stop) => !stopRefs(stop).some((candidate) => refs.includes(candidate)));
  first.load.stops.splice(insertion, 0, {
    ...clone(first.stop),
    id: text(payload.stopId) || `dispatch-${ref}`,
    orderId: ref,
    orderRefs: [ref],
    groupedOrderRefs: refs
  });
  return { group: { ref, orderRefs: refs } };
}

function ungroupOrders(plan, payload = {}) {
  const ref = text(payload.groupRef);
  const group = (plan.orders || []).find((order) => orderRef(order) === ref);
  if (!group) {throw commandError("The group no longer exists.", "DISPATCH_GROUP_NOT_FOUND", 404);}
  const refs = [...new Set((group.childOrders || payload.orderRefs || []).map(text).filter(Boolean))];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      const index = (load.stops || []).findIndex((stop) => stopRefs(stop).includes(ref));
      if (index < 0) {continue;}
      const source = load.stops[index];
      const replacements = refs.map((candidate, offset) => ({
        ...clone(source),
        id: `dispatch-${candidate}-${offset + 1}`,
        orderId: candidate,
        orderRefs: [candidate],
        groupedOrderRefs: undefined
      }));
      load.stops.splice(index, 1, ...replacements);
    }
  }
  plan.orders = (plan.orders || []).filter((order) => orderRef(order) !== ref);
  return { ungroupedOrderRefs: refs };
}

function splitOrder(plan, payload = {}) {
  const sourceRef = text(payload.sourceOrderRef || payload.orderRef);
  const source = (plan.orders || []).find((order) => orderRef(order) === sourceRef);
  if (!source) {throw commandError("The source order no longer exists.", "DISPATCH_ORDER_NOT_FOUND", 404);}
  const requestedParts = Array.isArray(payload.parts) && payload.parts.length ? payload.parts : [{}, {}];
  const parts = requestedParts.map((part, index) => {
    const refNumber = text(part.refNumber || part.orderRef) || `${sourceRef}-S${index + 1}`;
    return {
      ...clone(source),
      ...clone(part),
      id: refNumber,
      orderId: refNumber,
      refNumber,
      originalOrderId: sourceRef,
      type: source.type || "SO",
      isSplit: true,
      planOwned: true
    };
  });
  const splitRefs = new Set(parts.map(orderRef));
  plan.orders = [
    ...(plan.orders || []).filter((order) => !splitRefs.has(orderRef(order))),
    ...parts
  ];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      const index = (load.stops || []).findIndex((stop) => stopRefs(stop).includes(sourceRef));
      if (index < 0) {continue;}
      const stop = load.stops[index];
      load.stops.splice(index, 1, ...parts.map((part, partIndex) => ({
        ...clone(stop),
        id: `dispatch-${orderRef(part)}-${partIndex + 1}`,
        orderId: orderRef(part),
        orderRefs: [orderRef(part)]
      })));
    }
  }
  return { split: { sourceOrderRef: sourceRef, parts: parts.map((part) => ({ refNumber: orderRef(part) })) } };
}

function unsplitOrder(plan, payload = {}) {
  const sourceRef = text(payload.sourceOrderRef || payload.orderRef);
  const parts = (plan.orders || []).filter((order) => text(order.originalOrderId) === sourceRef);
  if (!parts.length) {throw commandError("The split no longer exists.", "DISPATCH_SPLIT_NOT_FOUND", 404);}
  for (const part of parts) {removeOrderFromBoard(plan, orderRef(part));}
  plan.orders = (plan.orders || []).filter((order) => text(order.originalOrderId) !== sourceRef);
  const target = locateLoad(plan, payload.loadId, payload.truckId);
  if (target) {target.load.stops.push(defaultAssignedStop(plan, sourceRef, payload));}
  return { unsplit: { sourceOrderRef: sourceRef, removedPartRefs: parts.map(orderRef) } };
}

function upsertCo(plan, payload = {}) {
  const sourceRef = text(payload.sourceOrderRef);
  const source = (plan.orders || []).find((order) => orderRef(order) === sourceRef);
  if (!source) {throw commandError("The source order no longer exists.", "DISPATCH_ORDER_NOT_FOUND", 404);}
  const candidate = clone(payload.co || {});
  const ref = text(candidate.refNumber || candidate.id || payload.coRef);
  if (!ref) {throw commandError("A CO reference is required.", "DISPATCH_CO_INVALID", 400);}
  const co = {
    ...candidate,
    id: ref,
    orderId: ref,
    refNumber: ref,
    type: "CO",
    transitCo: { ...(candidate.transitCo || {}), sourceOrderId: sourceRef },
    planOwned: true
  };
  plan.orders = [...(plan.orders || []).filter((order) => orderRef(order) !== ref), co];
  return { sourceOrder: clone(source), co: clone(co) };
}

function replacePlan(plan, payload = {}) {
  if (!Array.isArray(payload.orders) || !Array.isArray(payload.trucks)) {
    throw commandError("A compact order list and truck board are required.", "DISPATCH_COMMAND_INVALID", 400);
  }
  const requestedDate = text(payload.planDate).slice(0, 10);
  const currentDate = text(plan.planDate).slice(0, 10);
  if (requestedDate && currentDate && requestedDate !== currentDate) {
    throw commandError("The replacement board belongs to a different plan date.", "DISPATCH_PLAN_DATE_MISMATCH", 409, {
      expectedPlanDate: currentDate,
      payloadPlanDate: requestedDate
    });
  }
  plan.orders = clone(payload.orders);
  plan.trucks = clone(payload.trucks);
  plan.summary = clone(payload.summary && typeof payload.summary === "object" ? payload.summary : {});
  return {
    replaced: true,
    actionName: text(payload.actionName) || "dispatch_plan_autosaved",
    affectedOrderRefs: [...new Set((payload.affectedOrderRefs || []).map(text).filter(Boolean))],
    operatorAlertRefs: [...new Set((payload.operatorAlertRefs || []).map(text).filter(Boolean))],
    refreshOrderPool: payload.refreshOrderPool === true,
    safeUngroupTargets: clone(Array.isArray(payload.safeUngroupTargets) ? payload.safeUngroupTargets : [])
  };
}

function commandPatch(plan, command = {}) {
  const payload = command.payload || {};
  switch (text(command.type || command.commandType)) {
    case "remove_order": {
      const ref = text(payload.orderRef);
      if (!removeOrderFromBoard(plan, ref)) {
        throw commandError(`${ref || "The order"} is no longer on this plan.`, "DISPATCH_ORDER_NOT_PLANNED", 409);
      }
      return { removedOrderRefs: [ref] };
    }
    case "assign_order": return assignOrder(plan, payload);
    case "group_orders": return groupOrders(plan, payload);
    case "ungroup_orders": return ungroupOrders(plan, payload);
    case "split_order": return splitOrder(plan, payload);
    case "unsplit_order": return unsplitOrder(plan, payload);
    case "upsert_co": return upsertCo(plan, payload);
    case "replace_plan": return replacePlan(plan, payload);
    default:
      throw commandError("Unsupported Dispatch command.", "DISPATCH_COMMAND_UNSUPPORTED", 400);
  }
}

export function applyDispatchPlanCommand({ plan = {}, command = {}, receiptStore = createDispatchCommandReceiptStore() } = {}) {
  const commandId = text(command.commandId);
  if (!commandId) {throw commandError("A command ID is required.", "DISPATCH_COMMAND_INVALID", 400);}
  const bodyDigest = crypto.createHash("sha256").update(stableJson({
    baseRevision: Number(command.baseRevision),
    baseDigest: text(command.baseDigest),
    type: text(command.type || command.commandType),
    payload: command.payload || {}
  })).digest("hex");
  const stored = receiptStore.get(commandId);
  if (stored) {
    if (stored.bodyDigest !== bodyDigest) {
      throw commandError("This command ID was already used for a different change.", "DISPATCH_COMMAND_ID_REUSED", 409);
    }
    return { ...clone(stored.result), replay: true };
  }
  const currentRevision = Number(plan.revision || 0);
  if (Number(command.baseRevision) !== currentRevision) {
    throw commandError("Dispatch plan changed before this command was applied.", "STALE_DISPATCH_PLAN", 409, {
      expectedRevision: Number(command.baseRevision),
      currentRevision
    });
  }
  const currentDigest = digestDispatchPlan(plan);
  if (text(command.baseDigest) && text(command.baseDigest) !== currentDigest) {
    throw commandError("Dispatch plan content changed before this command was applied.", "STALE_DISPATCH_PLAN", 409, {
      expectedDigest: text(command.baseDigest),
      currentDigest
    });
  }
  const nextPlan = clone(plan);
  const patch = commandPatch(nextPlan, command);
  nextPlan.revision = currentRevision + 1;
  const digest = digestDispatchPlan(nextPlan);
  const acknowledgement = { commandId, revision: nextPlan.revision, digest, patch: clone(patch) };
  const result = {
    plan: nextPlan,
    revision: nextPlan.revision,
    digest,
    patch,
    acknowledgement,
    replay: false
  };
  receiptStore.set(commandId, { bodyDigest, result });
  return clone(result);
}

function physicalStop(stop = {}) {
  return PHYSICAL_STOP_TYPES.has(text(stop.type || stop.stopType).toLowerCase());
}

function loadIdentity(load = {}) {
  return text(load.id || load.loadId);
}

function driverIdentity(truck = {}, load = {}) {
  return text(load.driverLogin || load.driver || truck.driverLogin || truck.driver).toLowerCase();
}

function truckIdentity(truck = {}, load = {}) {
  return [
    text(load.truckId || truck.id),
    text(load.truckPlate || truck.plate || truck.truckPlate)
  ].join("|").toLowerCase();
}

function planLoads(plan = {}) {
  const map = new Map();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {map.set(loadIdentity(load), { truck, load });}
  }
  return map;
}

function stopIdentity(stop = {}) {
  return text(stop.id || stop.stopId) || `${text(stop.type)}:${stopRefs(stop).join("|")}`;
}

export function evaluateExecutedPrefixPolicy({ previousPlan = {}, nextPlan = {}, activity = [] } = {}) {
  const previousLoads = planLoads(previousPlan);
  const nextLoads = planLoads(nextPlan);
  const conflicts = [];
  const protectedByLoad = new Map();
  for (const record of activity || []) {
    if (!["in_progress", "complete"].includes(text(record.status).toLowerCase())) {continue;}
    const type = text(record.stopType || record.stop_type).toLowerCase();
    if (type && !PHYSICAL_STOP_TYPES.has(type)) {continue;}
    const loadId = text(record.loadId || record.load_id);
    const previous = previousLoads.get(loadId);
    if (!previous) {continue;}
    const physical = (previous.load.stops || []).filter(physicalStop);
    let index = physical.findIndex((stop) => stopIdentity(stop) === text(record.stopId || record.stop_id));
    if (index < 0 && record.orderRef) {
      index = physical.findIndex((stop) => stopRefs(stop).includes(text(record.orderRef)));
    }
    if (index < 0) {index = physical.length - 1;}
    protectedByLoad.set(loadId, Math.max(protectedByLoad.get(loadId) ?? -1, index));
  }
  for (const [loadId, throughIndex] of protectedByLoad) {
    const previous = previousLoads.get(loadId);
    const next = nextLoads.get(loadId);
    const beforePrefix = (previous?.load?.stops || []).filter(physicalStop).slice(0, throughIndex + 1);
    const afterPrefix = (next?.load?.stops || []).filter(physicalStop).slice(0, throughIndex + 1);
    const assignmentChanged = !next
      || driverIdentity(previous.truck, previous.load) !== driverIdentity(next.truck, next.load)
      || truckIdentity(previous.truck, previous.load) !== truckIdentity(next.truck, next.load);
    const prefixChanged = stableJson(beforePrefix.map(stopIdentity)) !== stableJson(afterPrefix.map(stopIdentity));
    if (assignmentChanged || prefixChanged) {
      conflicts.push({
        code: "DISPATCH_ACTIVE_LOAD_LOCKED",
        loadId,
        throughStopIndex: throughIndex,
        message: "Driver activity protects the executed physical prefix; later stops remain editable."
      });
    }
  }
  return { allowed: conflicts.length === 0, conflicts };
}

export function resolveHistoricalPlanOrderIdentity({ plan = {}, orderRef: requestedRef = "" } = {}) {
  const ref = text(requestedRef);
  const exact = (plan.orders || []).find((order) => orderRef(order) === ref);
  const related = exact || (plan.orders || []).find((order) => relatedOrderRefs(order).includes(ref));
  return {
    orderRef: related ? orderRef(related) : ref,
    planId: text(plan.id || plan.planId),
    planDate: text(plan.planDate).slice(0, 10),
    source: "historical_plan"
  };
}

export function selectExpiredDispatchCheckpointIds({ entries = [], now = new Date(), retentionDays = 7 } = {}) {
  const cutoff = new Date(now).getTime() - Number(retentionDays || 7) * 24 * 60 * 60 * 1000;
  return (entries || [])
    .filter((entry) => entry?.kind === "checkpoint" && entry.current !== true)
    .filter((entry) => {
      const timestamp = new Date(entry.archivedAt || entry.archived_at || "").getTime();
      return Number.isFinite(timestamp) && timestamp < cutoff;
    })
    .map((entry) => text(entry.id))
    .filter(Boolean);
}

export function dispatchPlanBoard(plan = {}) {
  return {
    orderRefs: boardOrderRefs(plan),
    truckCount: (plan.trucks || []).length,
    loadCount: (plan.trucks || []).reduce((sum, truck) => sum + (truck.loads || []).length, 0),
    stopCount: (plan.trucks || []).reduce(
      (sum, truck) => sum + (truck.loads || []).reduce((loadSum, load) => loadSum + (load.stops || []).length, 0),
      0
    )
  };
}
