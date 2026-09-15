import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const starts = [
    dispatchSource.indexOf(`function ${name}(`),
    dispatchSource.indexOf(`async function ${name}(`)
  ].filter((index) => index >= 0);
  assert.ok(starts.length, `Expected ${name} to be implemented in dispatch.js.`);
  const start = Math.min(...starts);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {parameterDepth += 1;}
    if (dispatchSource[index] === ")") {parameterDepth -= 1;}
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {depth += 1;}
    if (dispatchSource[index] === "}") {depth -= 1;}
    if (!depth) {return dispatchSource.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

const extractedFunctions = [
  "orderById",
  "canonicalDispatchOrderType",
  "invalidateRoutesChangedByOrderFeed",
  "dispatchOrderRefKey",
  "isAuthoritativelyRetiredOrderRef",
  "setAuthoritativeOrderRetirement",
  "deleteDispatchOrderRefFromSet",
  "withoutAuthoritativelyRetiredOrders",
  "withoutAuthoritativelyRetiredStops",
  "isRetirableDispatchStructure",
  "queueGlobalOrderRetirement",
  "queueGlobalOrderReactivation",
  "reconcileGlobalOrderLifecycleTransition",
  "resetPendingGlobalOrderLifecycle",
  "queueRemoteStructuralRetirement",
  "applyPendingRemoteStructuralRetirements",
  "applyCancelledCoLiveEvent",
  "applyRetiredStructuralLiveEvent",
  "applyDispatchOrderFeed",
  "dispatchOrderPoolScope",
  "rememberDispatchPoolOrders",
  "preserveDispatchPlanningFields",
  "mergeFreshDispatchOperationalOrder",
  "mergeDispatchOrderSearchFeed",
  "applyPlannedAssignments",
  "planPayload",
  "applySavedPlan",
  "resetPlanningBoard",
  "resetUndoHistory",
  "applyHistorySnapshot",
  "removeStopsForOrders",
  "saveTransitCoToServer",
  "clearTransitCoFromOrderSnapshot",
  "cancelTransitCoForOrder"
].map(functionBody).join("\n\n");

function createHarness(seed = {}) {
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Map,
    Set,
    String,
    structuredClone,
    encodeURIComponent
  });
  const source = `
    "use strict";
    const deepClone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    let authoritativeRetiredOrderRefs = new Set();
    const dispatchSessionPoolOrders = new Map();
    const isDispatchHistoryEditMode = () => false;
    let pendingRemoteStructuralLifecycleByRef = new Map();
    let pendingGlobalOrderRetireRefs = new Set();
    let pendingGlobalOrderReactivateRefs = new Set();
    let plannedAssignmentRefs = new Set();
    let plannedAssignmentsByRef = new Map();
    let assignedOrderEvidenceById = new Map();
    let orders = [];
    let orderCatalog = [];
    let trucks = [];
    let fleet = [];
    let currentPlan = null;
    let currentPlanDate = "2096-09-01";
    let appliedPlanStructure = { planId: "", planDate: "", orderIds: new Set() };
    let activeOrderType = "SO";
    let selectedOrderId = "";
    let selectedOrderIds = new Set();
    let selectedLoadId = "";
    let driverLaneOrder = [];
    let loadPreviewOpen = false;
    let modalType = "";
    let modalOrderId = "";
    let modalLoadId = "";
    let poAllocationOptions = null;
    let poAllocationLoading = false;
    let poAllocationError = "";
    let orderDependencyOptions = null;
    let orderDependencyLoading = false;
    let orderDependencyError = "";
    let undoStack = [];
    let redoStack = [];
    let historyCurrentState = "";
    let historyCurrentSnapshot = null;
    let historyReady = false;
    let nextPlanSaveMode = "";
    let nextSaveNeedsOrderPoolRefresh = false;
    let pendingPlanMutationAction = "dispatch_plan_autosaved";
    let planEditLeaseToken = "test-lease";
    const dispatchSessionId = "same-session-test";
    let lastAcknowledgedPlanState = null;
    let lastSavedAt = "";
    let lastServerSavedAt = "";
    let lastSavedPlanHash = "";
    let invalidatedLoadIds = [];
    let fetchCalls = [];

    function normalizeOrder(order = {}) {
      const next = deepClone(order || {});
      next.id = String(next.id || next.orderId || next.orderRef || "").trim();
      next.type = String(next.type || (next.id.toUpperCase().startsWith("CO-") ? "CO" : "SO")).toUpperCase();
      next.childOrders = Array.isArray(next.childOrders) ? next.childOrders : [];
      next.childOrderDetails = Array.isArray(next.childOrderDetails) ? next.childOrderDetails : [];
      next.pickupLocations = Array.isArray(next.pickupLocations) ? next.pickupLocations : [];
      return next;
    }

    function splitParentOrderId(order = {}) {
      return String(order.originalOrderId || "").trim();
    }

    function assignedOrderIdsForTrucks(truckList = []) {
      return new Set((truckList || []).flatMap((truck) => (truck.loads || [])
        .flatMap((load) => (load.stops || []).map((stop) => String(stop.orderId || "")).filter(Boolean))));
    }

    function groupedChildOrderIds(orderList = orders) {
      return new Set((orderList || []).flatMap((order) => order.childOrders || []).map(String));
    }

    function splitParentOrderIds(orderList = orders) {
      return new Set((orderList || []).map(splitParentOrderId).filter(Boolean));
    }

    function captureOperationalLoadSignatures() {
      const signatures = new Map();
      for (const truck of trucks || []) {
        for (const load of truck.loads || []) {
          const signature = (load.stops || []).map((stop) => {
            const key = String(stop.orderId || "").trim().toUpperCase();
            const order = orders.find((candidate) => String(candidate.id || "").trim().toUpperCase() === key);
            return [key, stop.type || "", order?.sourceYard || "", order?.destinationYard || "",
              ...(order?.pickupLocations || [])].join(":");
          }).join(">");
          signatures.set(String(load.id || ""), signature);
        }
      }
      return signatures;
    }

    function invalidateDriverRoutesFromLoad(loadId) {
      invalidatedLoadIds.push(String(loadId || ""));
    }

    function activePhysicalOrderEvidence() {
      return { all: new Set(), pickups: new Set(), drops: new Set() };
    }

    function filterDispatchOrderFeedForAppliedPlan(list) { return list; }
    function orderMatchesActivityRefs() { return false; }
    function preserveActiveOrderEvidence(_previous, fresh) { return fresh; }
    function reapplyActiveOrderEvidence(list) { return list; }
    function reconcileTransitCoSourceOrders() {}
    function reconcilePickupStopRepresentatives() {}
    function isOrderAssignedInCurrentPlan(ref) {
      return assignedOrderIdsForTrucks(trucks).has(String(ref || ""));
    }
    function shouldPreserveDuringFeedRefresh(order) { return order?.type === "CO"; }
    function summarizeStop(stop) { return deepClone(stop); }
    function summarizeOrder(order) { return deepClone(order); }
    function cleanupOrphanPickupStops() {}
    function logDispatchAudit() {}
    function clearActiveRouteEstimates() {}
    function driverOrientedPlanningEnabled() { return false; }
    function makeTruckFromFleet(vehicle) { return deepClone(vehicle); }
    function normalizePlanBeforeSave() {}
    function trucksWithTimingMetadata() { return deepClone(trucks); }
    function planSummary() { return {}; }
    function isDispatchPlanOwnedOrder(order) {
      return order?.planOwned === true || order?.type === "CO" || isRetirableDispatchStructure(order);
    }
    function dispatchPlanWireState(plan) { return deepClone(plan); }
    function savedGroupStructureConflictsWithPlan() { return false; }
    function catalogStructureConflictsWithSavedPlan() { return false; }
    function isLocalDispatchOrder(order) { return ["CO", "CUSTOM"].includes(String(order?.type || "").toUpperCase()); }
    function isNetSuiteDispatchOrder(order) { return !isLocalDispatchOrder(order); }
    function trucksFromFleetAndSavedPlan(savedTrucks) { return deepClone(savedTrucks || []); }
    function normalizeLoadAssignments() {}
    function defaultDriverLaneOrder() { return []; }
    function ensureDriverLaneOrder(next) { driverLaneOrder = [...(next || [])]; }
    function expandScmGroupedPoStops() {}
    function collapseGroupedOrderStops() {}
    function syncPickupStops() {}
    function forecastMatchesCurrentPlan() { return true; }
    function savedPlanHash(plan) { return JSON.stringify(plan); }
    function rememberAssignedOrderEvidence(orderList = []) {
      assignedOrderEvidenceById = new Map();
      const visit = (order) => {
        if (!order?.id) return;
        assignedOrderEvidenceById.set(String(order.id), normalizeOrder(order));
        for (const child of order.childOrderDetails || []) visit(child);
      };
      for (const order of orderList || []) visit(order);
    }

    async function fetch(url, options = {}) {
      fetchCalls.push({ url: String(url), options: deepClone(options) });
      return {
        ok: true,
        async json() { return { co: { status: "pending_load" } }; },
        async text() { return ""; }
      };
    }

    ${extractedFunctions}

    function installState(state = {}) {
      authoritativeRetiredOrderRefs = new Set((state.retired || []).map(dispatchOrderRefKey));
      pendingRemoteStructuralLifecycleByRef = new Map();
      pendingGlobalOrderRetireRefs = new Set(state.pendingGlobalRetireRefs || []);
      pendingGlobalOrderReactivateRefs = new Set(state.pendingGlobalReactivateRefs || []);
      orders = (state.orders || []).map(normalizeOrder);
      orderCatalog = (state.orderCatalog || state.orders || []).map(normalizeOrder);
      trucks = deepClone(state.trucks || []);
      fleet = deepClone(state.fleet || []);
      currentPlan = deepClone(state.currentPlan || { id: "265", planDate: currentPlanDate, revision: 1 });
      appliedPlanStructure = { planId: String(currentPlan?.id || ""), planDate: currentPlanDate, orderIds: new Set() };
      plannedAssignmentRefs = new Set(state.plannedAssignmentRefs || []);
      plannedAssignmentsByRef = new Map((state.plannedAssignments || []).map((assignment) => [
        dispatchOrderRefKey(assignment.orderRef), deepClone(assignment)
      ]));
      assignedOrderEvidenceById = new Map(Object.entries(state.evidence || {}).map(([ref, order]) => [ref, normalizeOrder(order)]));
      activeOrderType = state.activeOrderType || "SO";
      selectedOrderId = state.selectedOrderId || orders[0]?.id || "";
      selectedOrderIds = new Set(state.selectedOrderIds || (selectedOrderId ? [selectedOrderId] : []));
      selectedLoadId = state.selectedLoadId || trucks[0]?.loads?.[0]?.id || "";
      driverLaneOrder = [];
      undoStack = [...(state.undoStack || ["old-state"] )];
      redoStack = [...(state.redoStack || ["future-state"] )];
      historyCurrentState = "old";
      historyCurrentSnapshot = "old";
      historyReady = true;
      invalidatedLoadIds = [];
      fetchCalls = [];
      lastAcknowledgedPlanState = null;
      lastSavedAt = "";
      lastServerSavedAt = "";
      lastSavedPlanHash = "";
    }

    function stateSnapshot() {
      return deepClone({
        retired: [...authoritativeRetiredOrderRefs].sort(),
        pendingGlobalRetireRefs: [...pendingGlobalOrderRetireRefs].sort(),
        pendingGlobalReactivateRefs: [...pendingGlobalOrderReactivateRefs].sort(),
        pendingStructural: [...pendingRemoteStructuralLifecycleByRef.keys()].sort(),
        pendingStructuralPlanId: [...new Set([...pendingRemoteStructuralLifecycleByRef.values()]
          .map((lifecycle) => lifecycle.planId))].join(","),
        orders,
        orderCatalog,
        trucks,
        evidence: Object.fromEntries(assignedOrderEvidenceById),
        plannedAssignmentRefs: [...plannedAssignmentRefs],
        plannedAssignmentKeys: [...plannedAssignmentsByRef.keys()],
        activeOrderType,
        selectedOrderId,
        selectedOrderIds: [...selectedOrderIds],
        undoCount: undoStack.length,
        redoCount: redoStack.length,
        invalidatedLoadIds,
        fetchCalls
      });
    }

    globalThis.frontendRetirementHarness = {
      installState,
      stateSnapshot,
      remoteCancel(input) { applyCancelledCoLiveEvent(deepClone(input)); return stateSnapshot(); },
      remoteRetire(refs) { applyRetiredStructuralLiveEvent(deepClone(refs)); return stateSnapshot(); },
      applyFull(feed) { applyDispatchOrderFeed(deepClone(feed)); return stateSnapshot(); },
      mergeSearch(feed) { mergeDispatchOrderSearchFeed(deepClone(feed)); return stateSnapshot(); },
      applySaved(saved) { return { applied: applySavedPlan(deepClone(saved)), state: stateSnapshot() }; },
      switchToSavedPlan(saved) {
        const next = deepClone(saved);
        const applied = applySavedPlan(next);
        currentPlan = deepClone(next);
        currentPlanDate = String(next.planDate || currentPlanDate);
        return { applied, state: stateSnapshot() };
      },
      applyAssignments(assignments) { applyPlannedAssignments(deepClone(assignments)); return stateSnapshot(); },
      applyHistory(snapshot) { applyHistorySnapshot(deepClone(snapshot)); return stateSnapshot(); },
      retireGlobal(ref) { queueGlobalOrderRetirement(ref); return stateSnapshot(); },
      reactivateGlobal(ref) { queueGlobalOrderReactivation(ref); return stateSnapshot(); },
      transition(beforeOrders, afterOrders) {
        reconcileGlobalOrderLifecycleTransition(deepClone(beforeOrders), deepClone(afterOrders));
        return stateSnapshot();
      },
      resetLifecycle() { resetPendingGlobalOrderLifecycle(); return stateSnapshot(); },
      planPayload() { return deepClone(planPayload(new Date("2096-09-01T12:00:00.000Z"))); },
      queueStructural(payload) { queueRemoteStructuralRetirement(deepClone(payload)); return stateSnapshot(); },
      applyPending(saved) { applyPendingRemoteStructuralRetirements(deepClone(saved)); return stateSnapshot(); },
      filterOrders(list) { return deepClone(withoutAuthoritativelyRetiredOrders(deepClone(list))); },
      isRetired(ref) { return isAuthoritativelyRetiredOrderRef(ref); },
      localCancel(coRef, sourceOrderRef) {
        setAuthoritativeOrderRetirement(coRef, true);
        const cancelled = cancelTransitCoForOrder(sourceOrderRef);
        plannedAssignmentRefs = new Set([...plannedAssignmentRefs]
          .filter((ref) => dispatchOrderRefKey(ref) !== dispatchOrderRefKey(coRef)));
        plannedAssignmentsByRef.delete(dispatchOrderRefKey(coRef));
        resetUndoHistory();
        return { cancelled: deepClone(cancelled), state: stateSnapshot() };
      },
      async acceptedReinitialize(sourceOrder, coOrder) {
        const result = await saveTransitCoToServer(deepClone(sourceOrder), deepClone(coOrder));
        return { result: deepClone(result), state: stateSnapshot() };
      }
    };
  `;
  vm.runInContext(source, context, { filename: "dispatch-authoritative-retirement.vm.js" });
  context.frontendRetirementHarness.installState(structuredClone(seed));
  return context.frontendRetirementHarness;
}

const SOURCE_REF = "GOA-7894-7895";
const CO_REF = `CO-${SOURCE_REF}`;
const UNRELATED_REF = "SOA09999";
const SPLIT_REF = "SOA07894-S1";

function rawOrder(ref, sourceYard = "2967") {
  return {
    id: ref,
    type: "SO",
    sourceYard,
    pickupLocations: [sourceYard]
  };
}

function groupedOrder(ref = SOURCE_REF) {
  return {
    id: ref,
    type: "SO",
    planOwned: true,
    childOrders: ["SOA07894", "SOA07895"],
    childOrderDetails: [rawOrder("SOA07894"), rawOrder("SOA07895")]
  };
}

function splitOrder(ref = SPLIT_REF) {
  return {
    id: ref,
    type: "SO",
    planOwned: true,
    originalOrderId: "SOA07894"
  };
}

function upperRefs(refs = []) {
  return refs.map((ref) => String(ref).toUpperCase()).sort();
}

function sourceOrder() {
  return {
    id: SOURCE_REF,
    type: "SO",
    planOwned: true,
    childOrders: ["SOA07894", "SOA07895"],
    childOrderDetails: [{ id: "SOA07894" }, { id: "SOA07895" }],
    sourceYard: "12441",
    pickupLocations: ["12441"],
    transitCo: { id: CO_REF, fromYard: "2967", toYard: "12441" },
    transitOriginalPickupLocations: ["2967"],
    transitOriginalSourceYard: "2967",
    notes: "Transit via 12441. Grouped sales orders"
  };
}

function coOrder() {
  return {
    id: CO_REF,
    type: "CO",
    planOwned: true,
    sourceOrderId: SOURCE_REF,
    sourceYard: "2967",
    destinationYard: "12441",
    pickupLocations: ["2967"],
    childOrders: ["SOA07894", "SOA07895"],
    childOrderDetails: [{ id: "SOA07894" }, { id: "SOA07895" }]
  };
}

function unrelatedOrder() {
  return {
    id: UNRELATED_REF,
    type: "SO",
    sourceYard: "3445",
    pickupLocations: ["3445"],
    marker: { mustSurvive: true }
  };
}

function cancellationSeed() {
  const source = sourceOrder();
  const co = coOrder();
  const unrelated = unrelatedOrder();
  return {
    orders: [source, co, unrelated],
    orderCatalog: [source, co, unrelated],
    trucks: [{ id: "truck-1", loads: [{ id: "load-1", stops: [
      { id: "stop-co", orderId: CO_REF.toLowerCase(), type: "drop" },
      { id: "stop-source", orderId: SOURCE_REF, type: "drop" },
      { id: "stop-unrelated", orderId: UNRELATED_REF, type: "drop" }
    ] }] }],
    evidence: {
      [SOURCE_REF]: source,
      [CO_REF.toLowerCase()]: co,
      [UNRELATED_REF]: unrelated
    },
    plannedAssignmentRefs: [CO_REF.toLowerCase(), UNRELATED_REF],
    plannedAssignments: [
      { orderRef: CO_REF.toLowerCase(), plannedOrderSnapshot: co },
      { orderRef: UNRELATED_REF, plannedOrderSnapshot: unrelated }
    ],
    activeOrderType: "CO",
    selectedOrderId: CO_REF.toLowerCase(),
    selectedOrderIds: [CO_REF.toLowerCase(), UNRELATED_REF]
  };
}

function assertNoRetiredCo(state, label) {
  assert.equal(state.orders.some((order) => order.id.toUpperCase() === CO_REF), false, `${label}: orders`);
  assert.equal(state.orderCatalog.some((order) => order.id.toUpperCase() === CO_REF), false, `${label}: catalog`);
  assert.equal(
    state.trucks.some((truck) => truck.loads.some((load) => load.stops.some((stop) => stop.orderId.toUpperCase() === CO_REF))),
    false,
    `${label}: stops`
  );
  const source = state.orders.find((order) => order.id === SOURCE_REF);
  if (source) {
    assert.equal(source.transitCo, undefined, `${label}: source transit relationship`);
    assert.deepEqual(source.pickupLocations, ["2967"], `${label}: source pickup restoration`);
  }
}

test("remote CO cancellation is case-insensitive, preserves unrelated evidence, and fences delayed frontend ingress", () => {
  const seed = cancellationSeed();
  const harness = createHarness(seed);
  let state = harness.remoteCancel({
    coRef: CO_REF.toLowerCase(),
    sourceOrderRef: SOURCE_REF.toLowerCase()
  });

  assertNoRetiredCo(state, "live event");
  assert.deepEqual(state.retired, [CO_REF]);
  assert.equal(state.evidence[UNRELATED_REF].sourceYard, "3445");
  assert.deepEqual(state.evidence[UNRELATED_REF].pickupLocations, ["3445"]);
  assert.deepEqual(state.evidence[UNRELATED_REF].marker, { mustSurvive: true });
  assert.equal(state.evidence[UNRELATED_REF].transitCo, undefined);
  assert.equal(state.evidence[CO_REF.toLowerCase()], undefined);
  assert.equal(state.evidence[SOURCE_REF].transitCo, undefined);
  assert.deepEqual(state.plannedAssignmentRefs, [UNRELATED_REF]);
  assert.deepEqual(state.plannedAssignmentKeys, [UNRELATED_REF]);
  assert.deepEqual(state.invalidatedLoadIds, ["load-1"]);
  assert.equal(state.undoCount, 0);
  assert.equal(state.redoCount, 0);
  assert.equal(state.activeOrderType, "SO");
  assert.ok(state.selectedOrderIds.some((ref) => ref.toUpperCase() === SOURCE_REF));

  state = harness.applyFull([sourceOrder(), coOrder(), unrelatedOrder()]);
  assertNoRetiredCo(state, "delayed full feed");

  state = harness.mergeSearch([coOrder(), sourceOrder()]);
  assertNoRetiredCo(state, "delayed search feed");

  state = harness.applyAssignments([
    { orderRef: CO_REF, plannedOrderRef: CO_REF, plannedOrderSnapshot: coOrder(), dispatchPlanDate: "2096-09-01" },
    { orderRef: UNRELATED_REF, plannedOrderSnapshot: unrelatedOrder(), dispatchPlanDate: "2096-09-01" }
  ]);
  assertNoRetiredCo(state, "stale planned assignment");
  assert.deepEqual(state.plannedAssignmentRefs, [UNRELATED_REF]);

  state = harness.applyHistory({
    orders: [sourceOrder(), coOrder(), unrelatedOrder()],
    trucks: seed.trucks,
    selectedOrderId: CO_REF,
    selectedOrderIds: [CO_REF],
    activeOrderType: "CO"
  });
  assertNoRetiredCo(state, "stale undo history");

  const payload = harness.planPayload();
  assert.equal(payload.orders.some((order) => order.id.toUpperCase() === CO_REF), false, "save payload orders");
  assert.equal(
    payload.trucks.some((truck) => truck.loads.some((load) => load.stops.some((stop) => stop.orderId.toUpperCase() === CO_REF))),
    false,
    "save payload stops"
  );
});

test("an aggregate-shaped stale saved-plan CO cannot clear its own cancellation tombstone", () => {
  const seed = cancellationSeed();
  const harness = createHarness(seed);
  harness.remoteCancel({ coRef: CO_REF, sourceOrderRef: SOURCE_REF });

  const replay = harness.applySaved({
    id: "265",
    planDate: "2096-09-01",
    savedAt: "2096-09-01T12:00:00.000Z",
    orders: [sourceOrder(), coOrder(), unrelatedOrder()],
    trucks: seed.trucks,
    summary: {}
  });

  assert.equal(replay.applied, true);
  assertNoRetiredCo(replay.state, "stale saved plan");
  assert.equal(harness.isRetired(CO_REF), true);
});

test("the initiating session tombstones a cancelled CO and accepted same-ref reinitialization releases it", async () => {
  const harness = createHarness(cancellationSeed());
  const local = harness.localCancel(CO_REF, SOURCE_REF);
  assert.equal(harness.isRetired(CO_REF.toLowerCase()), true);
  assertNoRetiredCo(local.state, "same-session cancellation");

  const delayed = harness.filterOrders([coOrder()]);
  assert.deepEqual(delayed, []);

  const accepted = await harness.acceptedReinitialize(sourceOrder(), {
    ...coOrder(),
    destinationYard: "150"
  });
  assert.equal(accepted.state.fetchCalls.length, 1);
  assert.equal(harness.isRetired(CO_REF.toLowerCase()), false);
  assert.deepEqual(harness.filterOrders([{ ...coOrder(), destinationYard: "150" }]).map((order) => order.id), [CO_REF]);

  const cancellationStart = dispatchSource.indexOf('if (action === "cancel-transit-co")');
  const cancellationEnd = dispatchSource.indexOf('if (action === "undo-plan")', cancellationStart);
  const cancellationBranch = dispatchSource.slice(cancellationStart, cancellationEnd);
  assert.match(cancellationBranch, /await\s+cancelTransitCoOnServer\(coId\)[\s\S]*setAuthoritativeOrderRetirement\(coId,\s*true\)/u);
});

test("latest local lifecycle intent wins case-insensitively and is the only intent serialized", () => {
  const group = groupedOrder();
  const harness = createHarness({
    currentPlan: { id: "265", planDate: "2096-09-01", revision: 10 },
    orders: [group, unrelatedOrder()],
    orderCatalog: [group, unrelatedOrder()]
  });

  let state = harness.retireGlobal(SOURCE_REF.toLowerCase());
  assert.deepEqual(upperRefs(state.pendingGlobalRetireRefs), [SOURCE_REF]);
  assert.deepEqual(state.pendingGlobalReactivateRefs, []);
  assert.equal(harness.isRetired(SOURCE_REF), true);

  state = harness.reactivateGlobal(SOURCE_REF);
  assert.deepEqual(state.pendingGlobalRetireRefs, [], "reactivation supersedes an unsaved retirement");
  assert.deepEqual(upperRefs(state.pendingGlobalReactivateRefs), [SOURCE_REF]);
  assert.equal(harness.isRetired(SOURCE_REF), false);
  let payload = harness.planPayload();
  assert.deepEqual(payload.retiredGlobalOrderRefs, []);
  assert.deepEqual(upperRefs(payload.reactivatedGlobalOrderRefs), [SOURCE_REF]);

  state = harness.retireGlobal(SOURCE_REF.toLowerCase());
  assert.deepEqual(upperRefs(state.pendingGlobalRetireRefs), [SOURCE_REF]);
  assert.deepEqual(state.pendingGlobalReactivateRefs, [], "retirement supersedes an unsaved reactivation");
  assert.equal(harness.isRetired(SOURCE_REF), true);
  payload = harness.planPayload();
  assert.deepEqual(upperRefs(payload.retiredGlobalOrderRefs), [SOURCE_REF]);
  assert.deepEqual(payload.reactivatedGlobalOrderRefs, []);
});

test("group then ungroup before autosave leaves one retirement intent and no reactivation leak", () => {
  const group = groupedOrder();
  const harness = createHarness({
    orders: [group, unrelatedOrder()],
    orderCatalog: [group, unrelatedOrder()]
  });

  harness.reactivateGlobal(SOURCE_REF);
  const state = harness.retireGlobal(SOURCE_REF);

  assert.deepEqual(upperRefs(state.pendingGlobalRetireRefs), [SOURCE_REF]);
  assert.deepEqual(state.pendingGlobalReactivateRefs, []);
  assert.deepEqual(upperRefs(harness.planPayload().retiredGlobalOrderRefs), [SOURCE_REF]);

  const ungroupBranch = dispatchSource.slice(
    dispatchSource.indexOf('if (action === "ungroup-order")'),
    dispatchSource.indexOf('if (action === "unsplit-order")')
  );
  assert.match(ungroupBranch, /queueGlobalOrderRetirement\(actionOrderId\)/u);

  const groupBranch = dispatchSource.slice(
    dispatchSource.indexOf('if (action === "confirm-group")'),
    dispatchSource.indexOf('if (action === "request-unpack-for-split")')
  );
  assert.match(groupBranch, /replacedGroupRefs\.forEach\((?:queueGlobalOrderRetirement|\(ref\)\s*=>\s*queueGlobalOrderRetirement\(ref\))\)/u);
  assert.match(groupBranch, /queueGlobalOrderReactivation\(selectedOrderId\)/u);
});

test("an unassigned new group is plan-owned so its explicit reactivation includes the definition snapshot", () => {
  const group = groupedOrder();
  const harness = createHarness({
    currentPlan: { id: "265", planDate: "2096-09-01", revision: 10 },
    orders: [group, unrelatedOrder()],
    orderCatalog: [group, unrelatedOrder()],
    trucks: []
  });
  harness.reactivateGlobal(group.id);

  const payload = harness.planPayload();
  assert.ok(payload.orders.some((order) => order.id === group.id), "server receives the group definition even before assignment");
  assert.deepEqual(upperRefs(payload.reactivatedGlobalOrderRefs), [group.id.toUpperCase()]);

  assert.match(functionBody("groupOrder"), /groupPlanDate:\s*currentPlanDate,[\s\S]{0,120}planOwned:\s*true/u);
});

test("split then unsplit before autosave leaves retirement intents for every split and no reactivation leak", () => {
  const first = splitOrder();
  const second = splitOrder("SOA07894-S2");
  const harness = createHarness({
    orders: [first, second, unrelatedOrder()],
    orderCatalog: [first, second, unrelatedOrder()]
  });

  harness.reactivateGlobal(first.id);
  harness.reactivateGlobal(second.id);
  harness.retireGlobal(first.id);
  const state = harness.retireGlobal(second.id);

  assert.deepEqual(upperRefs(state.pendingGlobalRetireRefs), upperRefs([first.id, second.id]));
  assert.deepEqual(state.pendingGlobalReactivateRefs, []);
  assert.deepEqual(
    upperRefs(harness.planPayload().retiredGlobalOrderRefs),
    upperRefs([first.id, second.id])
  );

  const unsplitBranch = dispatchSource.slice(
    dispatchSource.indexOf('if (action === "unsplit-order")'),
    dispatchSource.indexOf('if (action === "open-split-modal")')
  );
  assert.match(unsplitBranch, /prepared\.siblingIds\.forEach\((?:queueGlobalOrderRetirement|\(ref\)\s*=>\s*queueGlobalOrderRetirement\(ref\))\)/u);

  const splitBranch = dispatchSource.slice(
    dispatchSource.indexOf('if (action === "confirm-split")'),
    dispatchSource.indexOf('if (action === "confirm-consolidate")')
  );
  assert.match(splitBranch, /if\s*\(ref\)\s*queueGlobalOrderReactivation\(ref\)/u);
});

test("undo and redo derive explicit lifecycle transitions for groups and splits", () => {
  const scenarios = [
    {
      label: "group",
      structure: groupedOrder(),
      restored: [rawOrder("SOA07894"), rawOrder("SOA07895"), unrelatedOrder()]
    },
    {
      label: "split",
      structure: splitOrder(),
      restored: [rawOrder("SOA07894"), unrelatedOrder()]
    }
  ];

  for (const { label, structure, restored } of scenarios) {
    const undoHarness = createHarness({
      orders: [structure, unrelatedOrder()],
      orderCatalog: [structure, ...restored]
    });
    const undone = undoHarness.applyHistory({
      orders: restored,
      trucks: [],
      selectedOrderId: restored[0].id,
      selectedOrderIds: [restored[0].id],
      activeOrderType: "SO"
    });
    assert.deepEqual(
      upperRefs(undone.pendingGlobalRetireRefs),
      [structure.id.toUpperCase()],
      `${label} undo retires the removed derived definition`
    );
    assert.deepEqual(undone.pendingGlobalReactivateRefs, [], `${label} undo has no opposite intent`);
    assert.equal(undoHarness.isRetired(structure.id), true, `${label} undo installs a tombstone`);

    const redoHarness = createHarness({
      retired: [structure.id],
      orders: restored,
      orderCatalog: [structure, ...restored]
    });
    const redone = redoHarness.applyHistory({
      orders: [structure, unrelatedOrder()],
      trucks: [],
      selectedOrderId: structure.id,
      selectedOrderIds: [structure.id],
      activeOrderType: "SO"
    });
    assert.deepEqual(redone.pendingGlobalRetireRefs, [], `${label} redo has no opposite intent`);
    assert.deepEqual(
      upperRefs(redone.pendingGlobalReactivateRefs),
      [structure.id.toUpperCase()],
      `${label} redo explicitly reactivates the restored definition`
    );
    assert.equal(redoHarness.isRetired(structure.id), false, `${label} redo releases the tombstone before filtering history`);
    assert.ok(redone.orders.some((order) => order.id === structure.id), `${label} redo restores the derived card`);
  }
});

test("an actual saved-plan switch drops both lifecycle directions before the new plan can serialize them", () => {
  const group = groupedOrder();
  const split = splitOrder();
  const harness = createHarness({
    currentPlan: { id: "265", planDate: "2096-09-01", revision: 10 },
    orders: [group, split, unrelatedOrder()],
    orderCatalog: [group, split, unrelatedOrder()]
  });
  harness.retireGlobal(SOURCE_REF);
  harness.reactivateGlobal(SPLIT_REF);

  const switched = harness.switchToSavedPlan({
    id: "266",
    planDate: "2096-09-02",
    revision: 1,
    savedAt: "2096-09-01T13:00:00.000Z",
    orders: [unrelatedOrder()],
    trucks: [],
    summary: {}
  });
  assert.equal(switched.applied, true);
  assert.deepEqual(switched.state.pendingGlobalRetireRefs, []);
  assert.deepEqual(switched.state.pendingGlobalReactivateRefs, []);
  assert.deepEqual(harness.planPayload().retiredGlobalOrderRefs, []);
  assert.deepEqual(harness.planPayload().reactivatedGlobalOrderRefs, []);

  assert.match(functionBody("applySavedPlan"), /appliedPlanStructure\.planId[\s\S]*resetPendingGlobalOrderLifecycle\(\)/u);
  assert.match(functionBody("resetPlanningBoard"), /resetPendingGlobalOrderLifecycle\(\)/u);
});

test("a cross-computer unsplit retirement event removes stale structures immediately from every frontend ingress", () => {
  const group = groupedOrder();
  const split = splitOrder();
  const unrelated = unrelatedOrder();
  const harness = createHarness({
    orders: [group, split, unrelated],
    orderCatalog: [group, split, unrelated],
    trucks: [{ id: "truck-1", loads: [{ id: "load-1", stops: [
      { id: "group-stop", orderId: group.id.toLowerCase(), type: "drop" },
      { id: "split-stop", orderId: split.id, type: "drop" },
      { id: "unrelated-stop", orderId: unrelated.id, type: "drop" }
    ] }] }],
    evidence: { [group.id]: group, [split.id]: split, [unrelated.id]: unrelated },
    plannedAssignmentRefs: [group.id.toLowerCase(), split.id, unrelated.id],
    plannedAssignments: [
      { orderRef: group.id.toLowerCase(), plannedOrderSnapshot: group },
      { orderRef: split.id, plannedOrderSnapshot: split },
      { orderRef: unrelated.id, plannedOrderSnapshot: unrelated }
    ],
    selectedOrderId: group.id,
    selectedOrderIds: [group.id, split.id, unrelated.id]
  });

  let state = harness.remoteRetire([group.id.toLowerCase(), split.id, split.id]);
  assert.deepEqual(state.retired, upperRefs([group.id, split.id]));
  assert.deepEqual(state.orders.map((order) => order.id), [unrelated.id]);
  assert.deepEqual(state.orderCatalog.map((order) => order.id), [unrelated.id]);
  assert.deepEqual(state.trucks[0].loads[0].stops.map((stop) => stop.orderId), [unrelated.id]);
  assert.deepEqual(state.plannedAssignmentRefs, [unrelated.id]);
  assert.deepEqual(state.plannedAssignmentKeys, [unrelated.id]);
  assert.deepEqual(Object.keys(state.evidence), [unrelated.id]);
  assert.deepEqual(state.selectedOrderIds, [unrelated.id]);
  assert.equal(state.undoCount, 0);
  assert.equal(state.redoCount, 0);

  state = harness.applyFull([group, split, unrelated]);
  assert.deepEqual(state.orders.map((order) => order.id), [unrelated.id], "a delayed full feed cannot resurrect retired structures");
  state = harness.mergeSearch([group, split]);
  assert.deepEqual(state.orders.map((order) => order.id), [unrelated.id], "a delayed search cannot resurrect retired structures");

  const eventHandler = functionBody("connectEvents");
  assert.match(eventHandler, /dispatch\.orders\.updated[\s\S]*payload\.retiredGlobalOrderRefs[\s\S]*applyRetiredStructuralLiveEvent\(payload\.retiredGlobalOrderRefs\)/u);
});

test("remote lifecycle events are explicit, revision-fenced, and never broadly retire unrelated structures", () => {
  const groupRef = "GOA-7894-7895";
  const splitRef = "SOA07894-S1";
  const group = groupedOrder(groupRef);
  const split = splitOrder(splitRef);
  const unrelatedGroup = {
    ...groupedOrder("GOA-9001-9002"),
    globalGroupDefinition: true,
    globalGroupSourcePlanId: "999"
  };
  const unrelated = unrelatedOrder();
  const harness = createHarness({
    currentPlan: { id: "265", planDate: "2096-09-01", revision: 10 },
    orders: [group, split, unrelatedGroup, unrelated],
    orderCatalog: [group, split, unrelatedGroup, unrelated]
  });

  let state = harness.queueStructural({
    planId: "265",
    revision: 11,
    refreshOrderPool: true,
    retiredGlobalOrderRefs: [groupRef.toLowerCase(), splitRef.toLowerCase()]
  });
  assert.deepEqual(state.pendingStructural, [groupRef, splitRef].sort());

  state = harness.applyPending({
    id: "265",
    revision: 10,
    orders: [{ id: "SOA07894", type: "SO" }, { id: "SOA07895", type: "SO" }, unrelated],
    trucks: []
  });
  assert.equal(harness.isRetired(groupRef), false, "an older snapshot cannot acknowledge the event");
  assert.equal(harness.isRetired(splitRef), false, "an older snapshot cannot acknowledge the event");
  assert.deepEqual(state.pendingStructural, [groupRef, splitRef].sort(), "the revision-fenced work remains queued");

  state = harness.applyPending({
    id: "265",
    revision: 11,
    orders: [{ id: "SOA07894", type: "SO" }, { id: "SOA07895", type: "SO" }, unrelated],
    trucks: []
  });
  assert.equal(harness.isRetired(groupRef.toLowerCase()), true);
  assert.equal(harness.isRetired(splitRef.toLowerCase()), true);
  assert.equal(harness.isRetired(unrelatedGroup.id), false, "pool refresh is not a wildcard structural retirement");
  assert.deepEqual(harness.filterOrders([group, split, unrelated]).map((order) => order.id), [UNRELATED_REF]);
  assert.deepEqual(state.pendingStructural, []);

  harness.applyFull([unrelatedGroup, unrelated]);
  state = harness.queueStructural({
    planId: "265",
    revision: 12,
    reactivatedGlobalOrderRefs: [groupRef.toLowerCase(), splitRef.toLowerCase()]
  });
  assert.deepEqual(state.pendingStructural, [groupRef, splitRef].sort(), "explicit reactivation queues refs absent behind tombstones");

  harness.applyPending({ id: "265", revision: 11, orders: [group, split, unrelated], trucks: [] });
  assert.equal(harness.isRetired(groupRef), true, "an older regroup snapshot cannot release the tombstone");
  assert.equal(harness.isRetired(splitRef), true, "an older resplit snapshot cannot release the tombstone");

  harness.applyPending({ id: "265", revision: 12, orders: [group, split, unrelated], trucks: [] });
  assert.equal(harness.isRetired(groupRef), false, "regroup reactivates the ref");
  assert.equal(harness.isRetired(splitRef), false, "resplit reactivates the ref");
  assert.deepEqual(harness.filterOrders([group, split]).map((order) => order.id), [groupRef, splitRef]);

  const explicitReactivation = createHarness({
    currentPlan: { id: "265", planDate: "2096-09-01", revision: 11 },
    orders: [group, split, unrelated],
    orderCatalog: [group, split, unrelated],
    pendingGlobalReactivateRefs: [groupRef, splitRef]
  }).planPayload();
  assert.deepEqual(
    [...explicitReactivation.reactivatedGlobalOrderRefs].sort(),
    [groupRef, splitRef].sort(),
    "the next client save explicitly authorizes only the newly regrouped/resplit refs"
  );

  const eventHandler = functionBody("connectEvents");
  assert.match(eventHandler, /dispatch\.plan\.saved[\s\S]*queueRemoteStructuralRetirement\(payload\)/u);
});
