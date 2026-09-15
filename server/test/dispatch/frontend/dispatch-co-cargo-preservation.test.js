import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";
import { coCargoFrontend, coFixture, staleCoFixture, productionFunctions } from "../../support/co-cargo-fixture.mjs";

const ui = coCargoFrontend();

test("compact CO cards retain source SO identity without empty CO children", () => {
  const full = coFixture();
  const card = compactDispatchOrderCard(full);
  const members = ui.flattenDispatchGroupMembers(card);
  assert.deepEqual(members.childOrderDetails.map((c) => c.type), ["SO", "SO"]);
  assert.equal(ui.isAggregateDispatchCoGroup({ ...card, ...members }), false);
  assert.equal(ui.effectiveOrderPalletQuantity(card, card.items, members.childOrderDetails), 6);
});

test("full CO hydration replaces stale empty child details and group flags", () => {
  const full = coFixture();
  const stale = staleCoFixture();
  const merged = ui.preserveDispatchPlanningFields(stale, full);
  assert.deepEqual(merged.items, full.items);
  assert.deepEqual(merged.childOrderDetails, full.childOrderDetails);
  assert.equal(Boolean(merged.globalGroupDefinition), false);
});

test("an empty compact card cannot overwrite already hydrated CO cargo", () => {
  const full = coFixture();
  const staleCard = compactDispatchOrderCard(staleCoFixture());
  const merged = ui.preserveDispatchPlanningFields(full, staleCard);
  assert.deepEqual(merged.items, full.items);
  assert.equal(merged.pallets, 6);
  assert.deepEqual(merged.childOrderDetails, full.childOrderDetails);
});

test("CO cargo is conserved through 1000 partial and full refresh interleavings", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 100 }),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
    (pallets, partials) => {
      const full = coFixture();
      full.pallets = pallets;
      full.items[0].pallets = pallets;
      full.childOrderDetails[0].pallets = pallets;
      let current = staleCoFixture();
      for (const partial of partials) {
        const incoming = partial ? compactDispatchOrderCard(full) : full;
        const card = { ...incoming, ...ui.flattenDispatchGroupMembers(incoming) };
        assert.equal(ui.isAggregateDispatchCoGroup(card), false);
        current = ui.preserveDispatchPlanningFields(current, card);
        current = ui.preserveDispatchPlanningFields(current, full);
        assert.deepEqual(current.items, full.items);
        assert.deepEqual(current.childOrderDetails, full.childOrderDetails);
        assert.equal(ui.isAggregateDispatchCoGroup(current), false);
        assert.equal(ui.effectiveOrderPalletQuantity(current, current.items, current.childOrderDetails), pallets);
      }
    }
  ), { seed: 74537455, numRuns: 1000 });
});

test("real CO member groups keep their CO identities and planning structure", () => {
  const children = [coFixture("A"), coFixture("B")];
  const group = { id: "CO-GOA-A-B", type: "CO", childOrders: children.map((c) => c.id), childOrderDetails: children };
  assert.equal(ui.isAggregateDispatchCoGroup(group), true);
  const members = ui.flattenDispatchGroupMembers(compactDispatchOrderCard(group));
  assert.deepEqual(members.childOrderDetails.map((c) => c.type), ["CO", "CO"]);
  assert.deepEqual(ui.preserveDispatchPlanningFields(group, { ...group, childOrders: [] }).childOrders, group.childOrders);
});

// UI/event/normalization boundaries are inert here. The production feed/save
// orchestration and merge policy are executed, with their output inspected.
function refreshBoundary(full, stale, normalized) {
  const identity = (value) => value;
  const noOp = () => {};
  const empty = () => [];
  const falseValue = () => false;
  return {
    orders: [stale], orderCatalog: [full], currentPlan: {}, appliedPlanStructure: {},
    dispatchSessionPoolOrders: new Map(), dispatchOrderPoolScope: () => "live",
    dispatchOrderRefKey: (ref) => String(ref || "").trim().toUpperCase(),
    selectedOrderId: "", selectedOrderIds: new Set(), selectedLoadId: "", trucks: [],
    lastAcknowledgedPlanState: null, lastSavedAt: "", lastServerSavedAt: "", lastSavedPlanHash: "",
    captureOperationalLoadSignatures: empty, activePhysicalOrderEvidence: () => ({ all: new Set() }),
    withoutAuthoritativelyRetiredOrders: identity, withoutAuthoritativelyRetiredStops: identity,
    filterDispatchOrderFeedForAppliedPlan: identity, orderMatchesActivityRefs: falseValue,
    isAuthoritativelyRetiredOrderRef: falseValue, isOrderAssignedInCurrentPlan: () => true,
    shouldPreserveDuringFeedRefresh: () => true, normalizeOrder: (order) => { normalized.push(order); return order; },
    preserveActiveOrderEvidence: (_old, fresh) => fresh, reapplyActiveOrderEvidence: identity,
    reconcileTransitCoSourceOrders: noOp, reconcilePickupStopRepresentatives: noOp,
    invalidateRoutesChangedByOrderFeed: noOp, resetPendingGlobalOrderLifecycle: noOp,
    applyPendingRemoteStructuralRetirements: noOp, assignedOrderIdsForTrucks: () => new Set([full.id]),
    savedGroupStructureConflictsWithPlan: falseValue, dispatchPlanWireState: identity,
    rememberAssignedOrderEvidence: noOp, clearActiveRouteEstimates: noOp,
    isLocalDispatchOrder: () => true, isNetSuiteDispatchOrder: falseValue, splitParentOrderId: () => "",
    groupedChildOrderIds: empty, splitParentOrderIds: empty, catalogStructureConflictsWithSavedPlan: falseValue,
    trucksFromFleetAndSavedPlan: identity, normalizeLoadAssignments: noOp, ensureDriverLaneOrder: noOp,
    defaultDriverLaneOrder: empty, expandScmGroupedPoStops: noOp, collapseGroupedOrderStops: noOp,
    syncPickupStops: noOp, cleanupOrphanPickupStops: noOp, forecastMatchesCurrentPlan: () => true,
    clearDispatchForecast: noOp, savedPlanHash: () => "fixture"
  };
}

test("feed application preserves hydrated CO cargo when a stale compact card arrives", () => {
  const full = coFixture();
  const normalized = [];
  const functions = productionFunctions("../../public/dispatch.js", ["applyDispatchOrderFeed", "preserveDispatchPlanningFields"],
    refreshBoundary(full, full, normalized));
  functions.applyDispatchOrderFeed([compactDispatchOrderCard(staleCoFixture())]);
  assert.deepEqual(normalized.at(-1).items, full.items);
  assert.deepEqual(normalized.at(-1).childOrderDetails, full.childOrderDetails);
});

test("saved-plan application replaces stale CO source children from a hydrated catalog", () => {
  const full = coFixture();
  const normalized = [];
  const functions = productionFunctions("../../public/dispatch.js", ["applySavedPlan", "preserveDispatchPlanningFields"],
    refreshBoundary(full, staleCoFixture(), normalized));
  assert.equal(functions.applySavedPlan({ id: "310", orders: [staleCoFixture()], trucks: [], summary: {} }), true);
  assert.deepEqual(normalized.at(-1).items, full.items);
  assert.deepEqual(normalized.at(-1).childOrderDetails, full.childOrderDetails);
});
