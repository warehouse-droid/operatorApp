import crypto from "node:crypto";

export const DISPATCH_RISKY_INTERACTION_KEYS = Object.freeze([
  "linkPo",
  "linkTo",
  "directShip",
  "splitOrder",
  "groupOrder",
  "splitPoLink",
  "splitPoDirectShip",
  "groupPoLink",
  "groupToLink",
  "restore"
]);

import {
  extractDispatchOrderRelationEdges,
  mergeDispatchReplayEvents
} from "./dispatch-planner-optimization.js";
import {
  insertDispatchLateOrder,
  materializeDispatchPickupVisits,
  resolveDispatchPickupVisit,
  validateDispatchPickupVisits
} from "./dispatch-pickup-visits.js";
import { evaluateExecutedPrefixPolicy } from "./dispatch-planner-performance.js";

function text(value) {
  return String(value ?? "").trim();
}

function identity(value = {}) {
  return text(value.id || value.orderId || value.orderRef || value.tranid || value.refNumber || value.plate);
}

function token(namespace, value, salt) {
  const clean = text(value);
  if (!clean) {return "";}
  return `${namespace}_${crypto.createHash("sha256").update(`${salt}\0${namespace}\0${clean}`).digest("hex").slice(0, 16)}`;
}

function stableValue(value) {
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

function replayLocalDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localDayOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text(value));
  if (!match) {return Number.NaN;}
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function normalizeReplayWindow(window = {}) {
  if (!window || typeof window !== "object") {return {};}
  const fromTime = Date.parse(window.from);
  const toTime = Date.parse(window.to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) {return window;}
  const timezone = text(window.timezone) || "America/Toronto";
  try {
    const localDates = [
      replayLocalDate(new Date(fromTime), timezone),
      replayLocalDate(new Date(toTime - 1), timezone)
    ];
    const firstDay = localDayOrdinal(localDates[0]);
    const lastDay = localDayOrdinal(localDates[1]);
    return {
      ...window,
      timezone,
      localDates,
      localDayCount: Number.isFinite(firstDay) && Number.isFinite(lastDay) ? lastDay - firstDay + 1 : 0
    };
  } catch {
    return window;
  }
}

function sanitizeOrder(order = {}, salt) {
  const ref = identity(order);
  const childDetails = (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
    .map((child) => sanitizeOrder(child, salt));
  return {
    id: token("ORDER", ref, salt),
    type: text(order.type).toUpperCase(),
    pickupLocations: (Array.isArray(order.pickupLocations) ? order.pickupLocations : [])
      .map((location) => token("LOCATION", location, salt)).filter(Boolean),
    ...(text(order.sourceYard || order.outboundLocation) ? {
      sourceYard: token("LOCATION", order.sourceYard || order.outboundLocation, salt)
    } : {}),
    ...(text(order.address || order.dropAddress || order.defaultDestinationAddress) ? {
      address: token("ADDRESS", order.address || order.dropAddress || order.defaultDestinationAddress, salt)
    } : {}),
    items: (Array.isArray(order.items) ? order.items : []).map((item, index) => ({
      lineRowId: token("LINE", item?.lineRowId || item?.lineId || `${ref}:${index}`, salt),
      pallets: Number(item?.pallets || item?.pallet_qty || 0),
      layers: Number(item?.layers || item?.layer_qty || 0),
      sections: Number(item?.sections || item?.section_qty || 0),
      pieces: Number(item?.pieces || item?.piece_qty || 0),
      quantity: Number(item?.quantity || item?.salesQty || item?.sales_qty || 0)
    })),
    ...(text(order.originalOrderId || order.parentOrderRef)
      ? { originalOrderId: token("ORDER", order.originalOrderId || order.parentOrderRef, salt) }
      : {}),
    ...(text(order.sourceOrderId) ? { sourceOrderId: token("ORDER", order.sourceOrderId, salt) } : {}),
    childOrders: (Array.isArray(order.childOrders) ? order.childOrders : [])
      .map((child) => token("ORDER", typeof child === "object" ? identity(child) : child, salt))
      .filter(Boolean),
    childOrderDetails: childDetails,
    poPickupManifest: (Array.isArray(order.poPickupManifest) ? order.poPickupManifest : [])
      .map((entry) => ({
        poOrderRef: token("ORDER", entry?.poOrderRef || entry?.orderRef || entry?.id, salt),
        location: token("LOCATION", entry?.location, salt)
      }))
      .filter((entry) => entry.poOrderRef),
    directPickupManifest: (Array.isArray(order.directPickupManifest) ? order.directPickupManifest : [])
      .map((entry) => ({
        transferOrderRef: token("ORDER", entry?.transferOrderRef || entry?.orderRef || entry?.id, salt),
        location: token("LOCATION", entry?.location, salt)
      })).filter((entry) => entry.transferOrderRef || entry.location),
    orderDependencies: (Array.isArray(order.orderDependencies) ? order.orderDependencies : [])
      .map((entry) => ({
        transferOrderRef: token("ORDER", entry?.transferOrderRef || entry?.orderRef, salt),
        mode: text(entry?.mode).toLowerCase(),
        status: text(entry?.status).toLowerCase()
      }))
      .filter((entry) => entry.transferOrderRef),
    ...(text(order.transitCo?.id || order.transitCo?.coRef) ? {
      transitCo: {
        id: token("ORDER", order.transitCo?.id || order.transitCo?.coRef, salt),
        sourceOrderId: token("ORDER", order.transitCo?.sourceOrderId || ref, salt)
      }
    } : {})
  };
}

export function sanitizeDispatchReplayPlan(plan = {}, { salt = "dispatch-planner-replay-v1" } = {}) {
  const sourceOrders = Array.isArray(plan.orders)
    ? plan.orders
    : Array.isArray(plan.assignedOrderSnapshots) ? plan.assignedOrderSnapshots : [];
  return {
    id: token("PLAN", plan.id || plan.planId, salt),
    planDate: text(plan.planDate || plan.plan_date).slice(0, 10),
    status: text(plan.status),
    revision: Number(plan.revision || 0),
    pickupVisitSchemaVersion: Number(plan.pickupVisitSchemaVersion || 0),
    orders: sourceOrders.map((order) => sanitizeOrder(order, salt)).filter((order) => order.id),
    trucks: (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
      id: token("TRUCK", truck?.id || truck?.plate || truck?.truckPlate, salt),
      plate: token("TRUCK", truck?.plate || truck?.truckPlate || truck?.id, salt),
      driverLogin: token("DRIVER", truck?.driverLogin || truck?.driver || truck?.id, salt),
      loads: (Array.isArray(truck?.loads) ? truck.loads : []).map((load, loadIndex) => ({
        id: token("LOAD", load?.id || `${truck?.id || truck?.plate}:${loadIndex}`, salt),
        returnOnly: load?.returnOnly === true,
        pickupVisitSchemaVersion: Number(load?.pickupVisitSchemaVersion || 0),
        stops: (Array.isArray(load?.stops) ? load.stops : []).map((stop, stopIndex) => ({
          id: token("STOP", stop?.id || `${load?.id}:${stopIndex}`, salt),
          type: text(stop?.type).toLowerCase(),
          orderId: token("ORDER", stop?.orderId || stop?.order_id || stop?.orderRef, salt),
          ...(Array.isArray(stop?.orderRefs) ? {
            orderRefs: stop.orderRefs.map((ref) => token("ORDER", ref, salt)).filter(Boolean)
          } : {}),
          ...(text(stop?.location || stop?.yard) ? {
            location: token("LOCATION", stop?.location || stop?.yard, salt)
          } : {}),
          ...(text(stop?.dropAddress || stop?.address) ? {
            dropAddress: token("ADDRESS", stop?.dropAddress || stop?.address, salt)
          } : {})
        }))
      }))
    }))
  };
}

function replayStopType(value = {}) {
  return text(value.stopType || value.stop_type || value.type).toLowerCase();
}

function replayStopId(value = {}) {
  return text(value.stopId || value.stop_id || value.id);
}

function replayLoadId(value = {}) {
  return text(value.loadId || value.load_id || value.id);
}

function replayPlanId(value = {}) {
  return text(value.planId || value.plan_id || value.id);
}

function replayOrderMap(plan = {}) {
  const result = new Map();
  const visit = (order) => {
    const ref = identity(order);
    if (!ref || result.has(ref.toLowerCase())) {return;}
    result.set(ref.toLowerCase(), order);
    for (const child of order.childOrderDetails || []) {visit(child);}
  };
  for (const order of plan.orders || []) {visit(order);}
  return result;
}

function normalizedReplayActivity(activity = {}) {
  return {
    status: text(activity.status).toLowerCase(),
    plan_id: replayPlanId(activity),
    load_id: replayLoadId(activity),
    stop_id: replayStopId(activity),
    stop_type: replayStopType(activity),
    order_refs: (activity.orderRefs || activity.order_refs || []).map(String),
    job_details: activity.jobDetails || activity.job_details || {}
  };
}

function deterministicReplayStopId(planId, loadId, sequence, kind, ordinal) {
  const digest = crypto.createHash("sha256")
    .update(`${planId}\0${loadId}\0${sequence}\0${kind}\0${ordinal}`)
    .digest("hex").slice(0, 20);
  return `REPLAY_${kind.toUpperCase()}_${digest}`;
}

function replayDriverPickupJobs(plan = {}, selectedTruck = {}) {
  const selectedTruckId = identity(selectedTruck);
  const selectedDriver = text(selectedTruck.driverLogin || selectedTruck.driver).toLowerCase();
  const jobs = [];
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    const sameTruck = selectedTruckId && identity(truck) === selectedTruckId;
    const sameDriver = selectedDriver
      && text(truck.driverLogin || truck.driver).toLowerCase() === selectedDriver;
    if (!sameTruck && !sameDriver) {continue;}
    for (const load of Array.isArray(truck.loads) ? truck.loads : []) {
      for (const stop of Array.isArray(load.stops) ? load.stops : []) {
        if (!["pick", "pickup"].includes(replayStopType(stop))) {continue;}
        const allocation = resolveDispatchPickupVisit({ plan, load, stop });
        jobs.push({
          stopType: "pickup",
          stopId: replayStopId(stop),
          orderRefs: allocation.orderRefs
        });
      }
    }
  }
  return jobs;
}

function legacyPickupLoadState(plan = {}) {
  return (Array.isArray(plan.trucks) ? plan.trucks : []).flatMap((truck, truckIndex) =>
    (Array.isArray(truck?.loads) ? truck.loads : []).flatMap((load, loadIndex) =>
      Number(load?.pickupVisitSchemaVersion || 0) >= 1
        ? []
        : [{ truckIndex, loadIndex, load }]
    )
  );
}

export function buildDispatchPickupRevisitReplay({ capture = {}, maxInjections = Number.POSITIVE_INFINITY } = {}) {
  const planEvents = (Array.isArray(capture.events) ? capture.events : [])
    .filter((event) => event?.planState && event.candidateOnly !== true);
  const capturedActivity = (Array.isArray(capture.driverActivity) ? capture.driverActivity : [])
    .map(normalizedReplayActivity);
  const failures = [];
  let eligibleLoadCount = 0;
  let fakeOrdersInjected = 0;
  let revisitPickupsCreated = 0;
  let futurePickupsReused = 0;
  let secondCustomerVisits = 0;
  let compatibilityPlanStatesChecked = 0;
  let legacyPassthroughConflictCount = 0;
  let legacyPassthroughRouteMutationCount = 0;
  let sourcePlanStatesEligibleForInjection = 0;
  let sourceConflictCount = 0;
  let validationFailureCount = 0;
  let prefixViolationCount = 0;
  let driverScopeFailureCount = 0;
  let syntheticActivityCount = 0;
  let pwaJobsGenerated = 0;

  for (const [planSequence, event] of planEvents.entries()) {
    if (fakeOrdersInjected >= maxInjections) {break;}
    const legacyBefore = stableJson(legacyPickupLoadState(event.planState));
    const passthrough = materializeDispatchPickupVisits(event.planState, {
      allowLegacyPassthrough: true
    });
    const legacyAfter = stableJson(legacyPickupLoadState(passthrough.plan));
    compatibilityPlanStatesChecked += 1;
    if (passthrough.conflicts.length) {
      legacyPassthroughConflictCount += passthrough.conflicts.length;
      if (failures.length < 500) {
        failures.push({
          stage: "legacy_passthrough_validation",
          eventId: text(event.id),
          code: passthrough.conflicts[0].code
        });
      }
    }
    if (legacyBefore !== legacyAfter) {
      legacyPassthroughRouteMutationCount += 1;
      if (failures.length < 500) {
        failures.push({
          stage: "legacy_passthrough_mutation",
          eventId: text(event.id),
          code: "DISPATCH_LEGACY_PICKUP_ROUTE_MUTATED"
        });
      }
    }
    const materialized = materializeDispatchPickupVisits(event.planState);
    if (materialized.conflicts.length) {
      sourceConflictCount += materialized.conflicts.length;
      if (failures.length < 500) {
        failures.push({
          stage: "source_materialization",
          eventId: text(event.id),
          code: materialized.conflicts[0].code
        });
      }
      continue;
    }
    sourcePlanStatesEligibleForInjection += 1;
    const sourcePlan = materialized.plan;
    const orders = replayOrderMap(sourcePlan);
    for (const truck of sourcePlan.trucks || []) {
      if (!text(truck.driverLogin || truck.driver)) {continue;}
      for (const load of truck.loads || []) {
        if (fakeOrdersInjected >= maxInjections || load.returnOnly === true) {continue;}
        const stops = Array.isArray(load.stops) ? load.stops : [];
        const pickups = stops.filter((stop) => ["pick", "pickup"].includes(replayStopType(stop)));
        const drops = stops.filter((stop) => ["drop", "dropoff", "delivery"].includes(replayStopType(stop)));
        if (!pickups.length || !drops.length) {continue;}
        const planActivity = capturedActivity.filter((record) =>
          record.plan_id === replayPlanId(sourcePlan) && record.load_id === replayLoadId(load)
        );
        const completedPickupRecord = [...planActivity].reverse().find((record) =>
          ["complete", "completed"].includes(record.status)
          && ["pick", "pickup"].includes(record.stop_type)
          && pickups.some((stop) => replayStopId(stop) === record.stop_id)
        );
        const completedPickup = pickups.find((stop) => replayStopId(stop) === completedPickupRecord?.stop_id)
          || pickups[0];
        const completedPickupIndex = stops.indexOf(completedPickup);
        const activity = [...planActivity];
        if (!completedPickupRecord) {
          activity.push({
            status: "complete",
            plan_id: replayPlanId(sourcePlan),
            load_id: replayLoadId(load),
            stop_id: replayStopId(completedPickup),
            stop_type: "pickup",
            order_refs: completedPickup.orderRefs || [completedPickup.orderId].filter(Boolean),
            job_details: {}
          });
          syntheticActivityCount += 1;
        }
        const activeTravel = activity.find((record) =>
          record.status === "in_progress" && record.stop_type === "travel"
        );
        if (!activeTravel && stops[completedPickupIndex + 1]) {
          activity.push({
            status: "in_progress",
            plan_id: replayPlanId(sourcePlan),
            load_id: replayLoadId(load),
            stop_id: `travel-${replayStopId(completedPickup)}-${replayStopId(stops[completedPickupIndex + 1])}`,
            stop_type: "travel",
            order_refs: [],
            job_details: {
              fromStopId: replayStopId(completedPickup),
              toStopId: replayStopId(stops[completedPickupIndex + 1])
            }
          });
          syntheticActivityCount += 1;
        }
        const activityBoundary = activity.reduce((maximum, record) => {
          if (record.stop_type === "travel") {
            const target = text(record.job_details?.toStopId || record.job_details?.to_stop_id);
            return Math.max(maximum, stops.findIndex((stop) => replayStopId(stop) === target));
          }
          return Math.max(maximum, stops.findIndex((stop) => replayStopId(stop) === record.stop_id));
        }, -1);
        const templateDrop = drops.find((stop) => stops.indexOf(stop) > activityBoundary && orders.get(text(stop.orderId).toLowerCase())?.address)
          || drops.find((stop) => orders.get(text(stop.orderId).toLowerCase())?.address);
        const templateOrder = templateDrop ? orders.get(text(templateDrop.orderId).toLowerCase()) : null;
        const pickupLocation = text(completedPickup.location || completedPickup.yard);
        if (!templateOrder?.address || !pickupLocation) {continue;}
        eligibleLoadCount += 1;
        const fakeRef = `ORDER_FAKE_${crypto.createHash("sha256")
          .update(`${replayPlanId(sourcePlan)}\0${replayLoadId(load)}\0${planSequence}`)
          .digest("hex").slice(0, 20)}`;
        try {
          const inserted = insertDispatchLateOrder({
            plan: sourcePlan,
            loadId: replayLoadId(load),
            order: {
              id: fakeRef,
              type: "SO",
              pickupLocations: [pickupLocation],
              sourceYard: pickupLocation,
              address: templateOrder.address,
              items: [{ lineRowId: `${fakeRef}_LINE`, pallets: 1 }]
            },
            activity,
            makeStopId: (kind, ordinal) => deterministicReplayStopId(
              replayPlanId(sourcePlan), replayLoadId(load), planSequence, kind, ordinal
            )
          });
          fakeOrdersInjected += 1;
          revisitPickupsCreated += inserted.createdPickupStopIds.length;
          futurePickupsReused += inserted.reusedPickupStopIds.length;
          if (inserted.secondDeliveryVisit) {secondCustomerVisits += 1;}
          const validation = validateDispatchPickupVisits(inserted.plan, { previousPlan: sourcePlan });
          if (validation.length) {
            validationFailureCount += 1;
            if (failures.length < 500) {
              failures.push({
                stage: "post_injection_validation",
                eventId: text(event.id),
                loadId: replayLoadId(load),
                code: validation[0].code
              });
            }
          }
          const prefixPolicy = evaluateExecutedPrefixPolicy({
            previousPlan: sourcePlan,
            nextPlan: inserted.plan,
            activity
          });
          if (!prefixPolicy.allowed) {
            prefixViolationCount += 1;
            if (failures.length < 500) {
              failures.push({
                stage: "executed_prefix",
                eventId: text(event.id),
                loadId: replayLoadId(load),
                code: prefixPolicy.conflicts[0]?.code || "DISPATCH_ACTIVE_LOAD_LOCKED"
              });
            }
          }
          const jobs = replayDriverPickupJobs(inserted.plan, truck);
          pwaJobsGenerated += jobs.length;
          const fakePickupJobs = jobs.filter((job) =>
            job.stopType === "pickup" && (job.orderRefs || []).map(String).includes(fakeRef)
          );
          if (fakePickupJobs.length !== 1 || fakePickupJobs[0].orderRefs.filter((ref) => ref === fakeRef).length !== 1) {
            driverScopeFailureCount += 1;
            if (failures.length < 500) {
              failures.push({
                stage: "driver_scope",
                eventId: text(event.id),
                loadId: replayLoadId(load),
                truckId: identity(truck),
                driverLogin: text(truck.driverLogin || truck.driver),
                matchingJobs: fakePickupJobs.length,
                matchingStops: fakePickupJobs.map((job) => job.stopId)
              });
            }
          }
        } catch (error) {
          validationFailureCount += 1;
          if (failures.length < 500) {
            failures.push({
              stage: "injection",
              eventId: text(event.id),
              loadId: replayLoadId(load),
              code: text(error?.code) || "REPLAY_INJECTION_FAILED",
              message: text(error?.message)
            });
          }
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    planStatesExamined: planEvents.length,
    capturedDriverActivityCount: capturedActivity.length,
    syntheticActivityCount,
    eligibleLoadCount,
    fakeOrdersInjected,
    revisitPickupsCreated,
    futurePickupsReused,
    secondCustomerVisits,
    pwaJobsGenerated,
    compatibilityPlanStatesChecked,
    legacyPassthroughConflictCount,
    legacyPassthroughRouteMutationCount,
    sourcePlanStatesEligibleForInjection,
    sourceConflictCount,
    validationFailureCount,
    prefixViolationCount,
    driverScopeFailureCount,
    failures,
    assertions: {
      planStatesPresent: planEvents.length > 0,
      driverActivityPresent: capturedActivity.length > 0,
      everyHistoricalPlanCheckedForCompatibility: compatibilityPlanStatesChecked === planEvents.length,
      untouchedLegacyPlansRemainSaveCompatible: legacyPassthroughConflictCount === 0,
      untouchedLegacyRoutesRemainUnchanged: legacyPassthroughRouteMutationCount === 0,
      eligibleHistoricalLoadPresent: eligibleLoadCount > 0,
      everyEligibleLoadInjected: fakeOrdersInjected === eligibleLoadCount,
      everyInjectionHasPickup: revisitPickupsCreated + futurePickupsReused >= fakeOrdersInjected,
      noPostInjectionValidationFailure: validationFailureCount === 0,
      executedPrefixPreserved: prefixViolationCount === 0,
      driverPickupScopeExact: driverScopeFailureCount === 0
    }
  };
}

function nestedOrderMap(plan = {}) {
  const map = new Map();
  const visit = (order) => {
    const ref = identity(order);
    if (!ref || map.has(ref)) {return;}
    map.set(ref, order);
    for (const child of order.childOrderDetails || []) {visit(child);}
  };
  for (const order of plan.orders || []) {visit(order);}
  return map;
}

function physicalDrops(plan = {}) {
  const drops = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) {continue;}
      for (const stop of load.stops || []) {
        if (text(stop.type).toLowerCase() !== "drop" || !text(stop.orderId)) {continue;}
        drops.push({ truckId: identity(truck), loadId: identity(load), stopId: identity(stop), orderRef: text(stop.orderId) });
      }
    }
  }
  return drops;
}

function legacyAssignmentProjection(plan = {}) {
  const topLevel = new Map((plan.orders || []).map((order) => [identity(order), order]).filter(([ref]) => ref));
  const assignments = new Map();
  const visit = (ref, rootRef, location, snapshot = null, visited = new Set()) => {
    if (!ref || visited.has(ref)) {return;}
    visited.add(ref);
    if (!assignments.has(ref)) {assignments.set(ref, { ref, rootRef, ...location });}
    const order = snapshot || topLevel.get(ref);
    if (!order || text(order.type).toUpperCase() === "CO") {return;}
    const childDetails = new Map((order.childOrderDetails || [])
      .map((child) => [identity(child), child]).filter(([childRef]) => childRef));
    const children = new Set([...(order.childOrders || []).map(text), ...childDetails.keys()]);
    for (const childRef of children) {visit(childRef, rootRef, location, topLevel.get(childRef) || childDetails.get(childRef), visited);}
  };
  for (const drop of physicalDrops(plan)) {visit(drop.orderRef, drop.orderRef, drop);}
  return assignments;
}

function optimizedAssignmentProjection(plan = {}) {
  const orders = nestedOrderMap(plan);
  const rows = new Map();
  const add = (ref, rootRef, kind, location) => {
    if (!ref || rows.has(ref)) {return;}
    rows.set(ref, { ref, rootRef, kind, ...location });
  };
  for (const drop of physicalDrops(plan)) {
    const queue = [{ ref: drop.orderRef, kind: "direct" }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current?.ref || visited.has(current.ref)) {continue;}
      visited.add(current.ref);
      add(current.ref, drop.orderRef, current.kind, drop);
      const order = orders.get(current.ref);
      if (!order || text(order.type).toUpperCase() === "CO") {continue;}
      const detailRefs = (order.childOrderDetails || []).map(identity).filter(Boolean);
      for (const childRef of new Set([...(order.childOrders || []).map(text), ...detailRefs])) {
        queue.push({ ref: childRef, kind: "group_member" });
      }
    }
  }
  const aliases = new Set();
  for (const row of rows.values()) {
    const order = orders.get(row.ref);
    const parent = text(order?.originalOrderId || order?.parentOrderRef);
    if (parent && parent !== row.ref) {aliases.add(`${parent}->${row.ref}`);}
  }
  return { rows, aliases };
}

function legacySplitAliases(plan, assignments) {
  const orders = nestedOrderMap(plan);
  const aliases = new Set();
  for (const ref of assignments.keys()) {
    const order = orders.get(ref);
    const parent = text(order?.originalOrderId || order?.parentOrderRef);
    if (parent && parent !== ref) {aliases.add(`${parent}->${ref}`);}
  }
  return aliases;
}

function legacyRelationEdges(plan = {}) {
  const edges = new Set();
  const visit = (order, groupOwner = "") => {
    const ref = identity(order);
    if (!ref) {return;}
    if (groupOwner && groupOwner !== ref) {edges.add(`group_member:${groupOwner}->${ref}`);}
    const details = new Map((order.childOrderDetails || []).map((child) => [identity(child), child]).filter(([key]) => key));
    const childRefs = new Set([...(order.childOrders || []).map(text), ...details.keys()]);
    for (const childRef of childRefs) {edges.add(`group_member:${ref}->${childRef}`);}
    const parent = text(order.originalOrderId || order.parentOrderRef);
    if (parent && parent !== ref) {edges.add(`split_child:${parent}->${ref}`);}
    for (const manifest of order.poPickupManifest || []) {
      const poRef = text(manifest?.poOrderRef || manifest?.orderRef || manifest?.id);
      if (poRef) {edges.add(`po_link:${ref}->${poRef}`);}
    }
    for (const dependency of order.orderDependencies || []) {
      const toRef = text(dependency?.transferOrderRef || dependency?.orderRef);
      if (!toRef) {continue;}
      edges.add(`to_link:${ref}->${toRef}`);
      if (text(dependency.mode).toLowerCase() === "direct_to_customer") {edges.add(`direct_ship:${ref}->${toRef}`);}
    }
    const coRef = text(order.transitCo?.id || order.transitCo?.coRef);
    if (coRef) {edges.add(`co_source:${coRef}->${text(order.transitCo?.sourceOrderId) || ref}`);}
    for (const childRef of childRefs) {if (details.has(childRef)) {visit(details.get(childRef), ref);}}
  };
  for (const order of plan.orders || []) {visit(order);}
  return edges;
}

export function compareDispatchReplayProjections(plan = {}) {
  const legacyAssignments = legacyAssignmentProjection(plan);
  const optimized = optimizedAssignmentProjection(plan);
  const normalizedLegacyAssignments = [...legacyAssignments.values()]
    .map(({ ref, rootRef, truckId, loadId, stopId }) => ({ ref, rootRef, truckId, loadId, stopId }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const normalizedOptimizedAssignments = [...optimized.rows.values()]
    .map(({ ref, rootRef, truckId, loadId, stopId }) => ({ ref, rootRef, truckId, loadId, stopId }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const legacyAliases = [...legacySplitAliases(plan, legacyAssignments)].sort();
  const optimizedAliases = [...optimized.aliases].sort();
  const legacyRelations = [...legacyRelationEdges(plan)].sort();
  const optimizedRelations = extractDispatchOrderRelationEdges(plan)
    .map((edge) => `${edge.relationType}:${edge.ownerRef}->${edge.memberRef}`).sort();
  const relationEdges = extractDispatchOrderRelationEdges(plan);
  const ownersByType = (type) => new Set(relationEdges.filter((edge) => edge.relationType === type).map((edge) => edge.ownerRef));
  const splitChildren = new Set(relationEdges.filter((edge) => edge.relationType === "split_child").map((edge) => edge.memberRef));
  const groupMembers = new Set(relationEdges.filter((edge) => edge.relationType === "group_member").map((edge) => edge.memberRef));
  const poOwners = ownersByType("po_link");
  const toOwners = ownersByType("to_link");
  const directOwners = ownersByType("direct_ship");
  const relationshipInteractions = {
    splitPoLink: [...splitChildren].some((ref) => poOwners.has(ref)),
    splitPoDirectShip: [...splitChildren].some((ref) => poOwners.has(ref) && directOwners.has(ref)),
    groupPoLink: [...groupMembers].some((ref) => poOwners.has(ref)),
    groupToLink: [...groupMembers].some((ref) => toOwners.has(ref))
  };
  const differences = [];
  if (stableJson(normalizedLegacyAssignments) !== stableJson(normalizedOptimizedAssignments)) {differences.push("assignments");}
  if (stableJson(legacyAliases) !== stableJson(optimizedAliases)) {differences.push("split_aliases");}
  if (stableJson(legacyRelations) !== stableJson(optimizedRelations)) {differences.push("relations");}
  return {
    equal: differences.length === 0,
    differences,
    digest: crypto.createHash("sha256").update(stableJson({
      assignments: normalizedOptimizedAssignments,
      aliases: optimizedAliases,
      relations: optimizedRelations
    })).digest("hex"),
    assignmentCount: normalizedOptimizedAssignments.length,
    splitAliasCount: optimizedAliases.length,
    relationCount: optimizedRelations.length,
    relationTypes: [...new Set(optimizedRelations.map((entry) => entry.split(":", 1)[0]))].sort(),
    relationshipInteractions
  };
}

function interactionFlags(event = {}, comparisons = []) {
  const action = text(event.action || event.payload?.action).toLowerCase();
  const relationTypes = new Set(comparisons.flatMap((comparison) => comparison.relationTypes || []));
  return {
    linkPo: action.includes("po_link") || relationTypes.has("po_link"),
    linkTo: action.includes("to_link") || action.includes("dependency") || relationTypes.has("to_link"),
    directShip: action.includes("direct") || relationTypes.has("direct_ship"),
    splitOrder: action.includes("split") || relationTypes.has("split_child"),
    groupOrder: action.includes("group") || relationTypes.has("group_member"),
    splitPoLink: comparisons.some((comparison) => comparison.relationshipInteractions?.splitPoLink),
    splitPoDirectShip: comparisons.some((comparison) => comparison.relationshipInteractions?.splitPoDirectShip),
    groupPoLink: comparisons.some((comparison) => comparison.relationshipInteractions?.groupPoLink),
    groupToLink: comparisons.some((comparison) => comparison.relationshipInteractions?.groupToLink),
    restore: action.includes("restore"),
    driver: event.stream === "driver",
    scm: event.stream === "scm",
    netsuiteDerived: event.stream === "netsuite"
  };
}

export function buildDispatchHistoricalReplayReport({ events = [], window = {}, sourceCounts = {} } = {}) {
  const ordered = mergeDispatchReplayEvents(events);
  const activePlans = new Map();
  const cachedComparisons = new Map();
  const evidenceCounts = { exact: 0, "state-derived": 0, gap: 0 };
  const streamCounts = {};
  const interactionCoverage = {
    linkPo: 0,
    linkTo: 0,
    directShip: 0,
    splitOrder: 0,
    groupOrder: 0,
    splitPoLink: 0,
    splitPoDirectShip: 0,
    groupPoLink: 0,
    groupToLink: 0,
    restore: 0,
    driver: 0,
    scm: 0,
    netsuiteDerived: 0
  };
  const gapSamples = [];
  const mismatchSamples = [];
  let projectionComparisons = 0;
  let mismatchCount = 0;
  let planStateTransitions = 0;
  let crossStreamTransitions = 0;
  let previousStream = "";
  let causalDigest = "dispatch-planner-replay-v1";

  for (const event of ordered) {
    evidenceCounts[event.evidence] = (evidenceCounts[event.evidence] || 0) + 1;
    streamCounts[event.stream] = (streamCounts[event.stream] || 0) + 1;
    if (previousStream && previousStream !== event.stream) {crossStreamTransitions += 1;}
    previousStream = event.stream;
    if (event.evidence === "gap" && gapSamples.length < 100) {
      gapSamples.push({ id: text(event.id), stream: text(event.stream), serverAt: text(event.serverAt), action: text(event.action) });
    }
    if (event.planState && event.candidateOnly !== true) {
      activePlans.set(event.planState.id, event.planState);
      cachedComparisons.set(event.planState.id, compareDispatchReplayProjections(event.planState));
      planStateTransitions += 1;
    }
    const comparisons = [...cachedComparisons.entries()].map(([planId, comparison]) => ({ planId, ...comparison }));
    projectionComparisons += 1;
    for (const comparison of comparisons) {
      if (!comparison.equal && mismatchSamples.length < 100) {
        mismatchSamples.push({
          eventId: text(event.id),
          stream: text(event.stream),
          planId: comparison.planId,
          differences: comparison.differences
        });
      }
      if (!comparison.equal) {mismatchCount += 1;}
    }
    const flags = interactionFlags(event, comparisons);
    for (const [key, covered] of Object.entries(flags)) {if (covered) {interactionCoverage[key] += 1;}}
    causalDigest = crypto.createHash("sha256").update(stableJson({
      previous: causalDigest,
      id: text(event.id),
      stream: text(event.stream),
      serverAt: text(event.serverAt),
      sourceSequence: Number(event.sourceSequence || 0),
      evidence: event.evidence,
      comparisons: comparisons.map(({ planId, digest, equal }) => ({ planId, digest, equal }))
    })).digest("hex");
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window: normalizeReplayWindow(window),
    privacy: {
      identifiers: "sha256-pseudonymized",
      names: "excluded",
      addresses: "excluded",
      photos: "excluded",
      rawPayloads: "excluded"
    },
    sourceCounts,
    streamCounts,
    evidenceCounts,
    eventsProcessed: ordered.length,
    planStateTransitions,
    finalPlanCount: activePlans.size,
    projectionComparisons,
    mismatchCount,
    mismatchSamples,
    gapCount: evidenceCounts.gap || 0,
    gapSamples,
    crossStreamTransitions,
    interactionCoverage,
    historicalInteractionGaps: DISPATCH_RISKY_INTERACTION_KEYS
      .filter((key) => Number(interactionCoverage[key] || 0) === 0),
    causalDigest
  };
}

const REPLAY_SOURCE_STREAMS = Object.freeze({
  dispatch_plan_commands: "dispatch",
  dispatch_plan_snapshot_history: "dispatch",
  dispatch_plan_snapshots: "dispatch",
  dispatch_audit_log: "dispatch",
  scm_netsuite_po_history_changes: "scm",
  scm_reconciliation_audit_events: "netsuite",
  netsuite_mirror_events: "netsuite",
  driver_offline_events: "driver",
  driver_job_records: "driver",
  dispatch_order_completion_events: "driver",
  driver_job_corrections: "driver"
});

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : Number.NaN;
}

export function buildDispatchHistoricalReplayArtifact({ capture = {}, expectedLocalDayCount = 0 } = {}) {
  const events = Array.isArray(capture?.events) ? capture.events : [];
  const sourceCounts = capture?.sourceCounts && typeof capture.sourceCounts === "object"
    ? capture.sourceCounts : {};
  const report = buildDispatchHistoricalReplayReport({
    events,
    window: capture?.window || {},
    sourceCounts
  });
  const entries = Object.entries(sourceCounts);
  const countsValid = entries.length > 0 && entries.every(([, value]) => Number.isFinite(nonNegativeCount(value)));
  const sourceRecordCount = countsValid
    ? entries.reduce((total, [, value]) => total + nonNegativeCount(value), 0) : 0;
  const zeroSourceCount = countsValid
    ? entries.filter(([, value]) => nonNegativeCount(value) === 0).length : 0;
  const expectedEventCount = sourceRecordCount + zeroSourceCount;
  const sourceStreamCounts = { dispatch: 0, scm: 0, netsuite: 0, driver: 0 };
  for (const [source, value] of entries) {
    const stream = REPLAY_SOURCE_STREAMS[source];
    const count = nonNegativeCount(value);
    if (stream && Number.isFinite(count)) {sourceStreamCounts[stream] += count;}
  }
  const fromTime = Date.parse(report.window?.from);
  const toTime = Date.parse(report.window?.to);
  const eventsWithinWindow = Number.isFinite(fromTime) && Number.isFinite(toTime)
    && events.every((event) => {
      const eventTime = Date.parse(event?.serverAt);
      return Number.isFinite(eventTime) && eventTime >= fromTime && eventTime < toTime;
    });
  const eventIds = events.map((event) => text(event?.id)).filter(Boolean);
  const requestedDays = Number(expectedLocalDayCount || 0);
  const exactLocalDayWindow = requestedDays > 0
    ? report.window?.localDayCount === requestedDays
    : Number(report.window?.localDayCount || 0) > 0;

  return {
    ...report,
    historicalActionCounts: stableValue(capture?.historicalActionCounts || {}),
    captureDigest: crypto.createHash("sha256").update(stableJson({
      schemaVersion: capture?.schemaVersion,
      window: capture?.window,
      sourceCounts,
      events
    })).digest("hex"),
    captureValidation: {
      sourceRecordCount,
      zeroSourceCount,
      expectedEventCount,
      capturedEventCount: events.length,
      sourceStreamCounts
    },
    assertions: {
      captureSchemaSupported: Number(capture?.schemaVersion) === 1,
      sourceCountsValid: countsValid,
      exactLocalDayWindow,
      everySourceRowAccountedFor: countsValid && events.length === expectedEventCount,
      eventsWithinWindow,
      eventIdsUnique: eventIds.length === events.length && new Set(eventIds).size === events.length,
      everyEventCompared: report.projectionComparisons === report.eventsProcessed,
      noProjectionMismatch: report.mismatchCount === 0,
      hasDispatchEvidence: sourceStreamCounts.dispatch > 0,
      hasScmEvidence: sourceStreamCounts.scm > 0,
      hasNetSuiteDerivedEvidence: sourceStreamCounts.netsuite > 0,
      hasDriverEvidence: sourceStreamCounts.driver > 0,
      gapsExplicit: report.gapCount === 0 || report.gapSamples.length > 0
    }
  };
}
