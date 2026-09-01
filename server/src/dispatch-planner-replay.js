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
    ...(text(order.originalOrderId || order.parentOrderRef)
      ? { originalOrderId: token("ORDER", order.originalOrderId || order.parentOrderRef, salt) }
      : {}),
    ...(text(order.sourceOrderId) ? { sourceOrderId: token("ORDER", order.sourceOrderId, salt) } : {}),
    childOrders: (Array.isArray(order.childOrders) ? order.childOrders : [])
      .map((child) => token("ORDER", typeof child === "object" ? identity(child) : child, salt))
      .filter(Boolean),
    childOrderDetails: childDetails,
    poPickupManifest: (Array.isArray(order.poPickupManifest) ? order.poPickupManifest : [])
      .map((entry) => ({ poOrderRef: token("ORDER", entry?.poOrderRef || entry?.orderRef || entry?.id, salt) }))
      .filter((entry) => entry.poOrderRef),
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
    orders: sourceOrders.map((order) => sanitizeOrder(order, salt)).filter((order) => order.id),
    trucks: (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
      id: token("TRUCK", truck?.id || truck?.plate || truck?.truckPlate, salt),
      loads: (Array.isArray(truck?.loads) ? truck.loads : []).map((load, loadIndex) => ({
        id: token("LOAD", load?.id || `${truck?.id || truck?.plate}:${loadIndex}`, salt),
        returnOnly: load?.returnOnly === true,
        stops: (Array.isArray(load?.stops) ? load.stops : []).map((stop, stopIndex) => ({
          id: token("STOP", stop?.id || `${load?.id}:${stopIndex}`, salt),
          type: text(stop?.type).toLowerCase(),
          orderId: token("ORDER", stop?.orderId || stop?.order_id || stop?.orderRef, salt),
          orderRefs: (Array.isArray(stop?.orderRefs) ? stop.orderRefs : [])
            .map((ref) => token("ORDER", ref, salt)).filter(Boolean)
        }))
      }))
    }))
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
