import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_RISKY_INTERACTION_KEYS,
  buildDispatchHistoricalReplayReport,
  compareDispatchReplayProjections,
  sanitizeDispatchReplayPlan
} from "../../../src/dispatch-planner-replay.js";

function interactingPlan() {
  return {
    id: "REAL-PLAN-SECRET",
    planDate: "2026-08-12",
    revision: 17,
    status: "draft",
    orders: [{
      id: "GOA-SECRET-1-2",
      type: "GROUP",
      customer: "Must Not Survive",
      address: "123 Private Road",
      childOrders: ["SOA-SECRET-S1", "SOA-SECRET-2"],
      childOrderDetails: [{
        id: "SOA-SECRET-S1",
        type: "SO",
        originalOrderId: "SOA-SECRET",
        poPickupManifest: [{ poOrderRef: "POB-SECRET", location: "Vendor Private Yard" }],
        orderDependencies: [{ transferOrderRef: "TOB-SECRET", mode: "direct_to_customer" }]
      }, {
        id: "SOA-SECRET-2",
        type: "SO",
        poPickupManifest: [{ poOrderRef: "POB-SECRET-2" }],
        orderDependencies: [{ transferOrderRef: "TOB-SECRET-2", mode: "replenishment" }]
      }]
    }],
    trucks: [{
      id: "TRUCK-PRIVATE",
      plate: "PLATE-PRIVATE",
      driverName: "Private Driver",
      loads: [{
        id: "LOAD-PRIVATE",
        name: "Private Load Name",
        stops: [{ id: "STOP-PRIVATE", type: "drop", orderId: "GOA-SECRET-1-2", address: "Customer Secret" }]
      }]
    }]
  };
}

test("DPO-14 replay sanitizer removes PII while retaining every risky relationship identity", () => {
  const sanitized = sanitizeDispatchReplayPlan(interactingPlan(), { salt: "adversarial-test" });
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    "REAL-PLAN-SECRET", "GOA-SECRET", "SOA-SECRET", "POB-SECRET", "TOB-SECRET",
    "Must Not Survive", "123 Private Road", "Private Driver", "Customer Secret", "PLATE-PRIVATE"
  ]) {assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));}

  const comparison = compareDispatchReplayProjections(sanitized);
  assert.equal(comparison.equal, true, JSON.stringify(comparison));
  assert.deepEqual(comparison.relationTypes, ["direct_ship", "group_member", "po_link", "split_child", "to_link"]);
  assert.deepEqual(comparison.relationshipInteractions, {
    splitPoLink: true,
    splitPoDirectShip: true,
    groupPoLink: true,
    groupToLink: true
  });
});

test("DPO-14 causal replay compares after every cross-system event and keeps evidence gaps visible", () => {
  const plan = sanitizeDispatchReplayPlan(interactingPlan(), { salt: "causal-test" });
  const events = [
    {
      stream: "dispatch",
      id: "dispatch-before",
      serverAt: "2026-08-12T12:00:00.000Z",
      sourceSequence: 1,
      action: "orders_grouped",
      before: { revision: 16 },
      after: { revision: 17 },
      planState: plan
    },
    {
      stream: "scm",
      id: "scm-po-split",
      serverAt: "2026-08-12T12:00:01.000Z",
      sourceSequence: 1,
      action: "dispatch.scm_po_split_created",
      payload: { changed: true }
    },
    {
      stream: "netsuite",
      id: "netsuite-gap",
      serverAt: "2026-08-12T12:00:02.000Z",
      sourceSequence: 1,
      action: "coverage_gap:netsuite_mirror_events"
    },
    {
      stream: "driver",
      id: "driver-offline",
      serverAt: "2026-08-12T12:00:03.000Z",
      deviceAt: "2026-08-12T11:59:59.000Z",
      sourceSequence: 2,
      action: "job_completed",
      payload: { eventType: "job_completed" }
    },
    {
      stream: "dispatch",
      id: "dispatch-restore",
      serverAt: "2026-08-12T12:00:04.000Z",
      sourceSequence: 2,
      action: "dispatch_plan_snapshot_restored",
      payload: { revision: 18 },
      planState: { ...plan, revision: 18 }
    }
  ];
  const first = buildDispatchHistoricalReplayReport({ events, window: { from: "a", to: "b" } });
  const second = buildDispatchHistoricalReplayReport({ events, window: { from: "a", to: "b" } });
  assert.equal(first.eventsProcessed, events.length);
  assert.equal(first.projectionComparisons, events.length);
  assert.equal(first.mismatchCount, 0);
  assert.equal(first.gapCount, 1);
  assert.deepEqual(first.gapSamples.map((gap) => gap.id), ["netsuite-gap"]);
  assert.equal(first.crossStreamTransitions, 4);
  assert.equal(first.interactionCoverage.splitPoLink > 0, true);
  assert.equal(first.interactionCoverage.splitPoDirectShip > 0, true);
  assert.equal(first.interactionCoverage.groupPoLink > 0, true);
  assert.equal(first.interactionCoverage.groupToLink > 0, true);
  assert.equal(first.interactionCoverage.restore, 1);
  assert.deepEqual(first.historicalInteractionGaps, [], "The synthetic counterfactual covers every risky interaction.");
  assert.equal(first.causalDigest, second.causalDigest, "Identical evidence must produce an identical replay digest.");
});

test("DPO-14 sparse historical shapes remain private, deterministic, and visibly incomplete", () => {
  const sanitized = sanitizeDispatchReplayPlan({
    planId: "SPARSE-PLAN",
    plan_date: "2026-08-11T19:00:00Z",
    assignedOrderSnapshots: [{
      orderId: "SPARSE-ROOT",
      parentOrderRef: "SPARSE-PARENT",
      sourceOrderId: "SPARSE-SOURCE",
      childOrders: [{ orderRef: "SPARSE-OBJECT-CHILD" }, "", "SPARSE-CHILD"],
      childOrderDetails: null,
      poPickupManifest: [{ orderRef: "SPARSE-PO-A" }, { id: "SPARSE-PO-B" }, {}],
      orderDependencies: [{ orderRef: "SPARSE-TO", mode: "DIRECT_TO_CUSTOMER" }, {}],
      transitCo: { coRef: "SPARSE-CO" }
    }, { tranid: "SPARSE-TRAN" }, { refNumber: "SPARSE-REF" }, { plate: "SPARSE-PLATE" }, {}],
    trucks: [{
      truckPlate: "SPARSE-TRUCK",
      loads: [{
        stops: [
          { type: "drop", order_id: "SPARSE-ROOT", orderRefs: null },
          { type: "drop", orderRef: "SPARSE-CHILD", orderRefs: ["", "SPARSE-CHILD"] },
          { type: "travel" }
        ]
      }, { returnOnly: true, stops: null }]
    }]
  }, { salt: "sparse-boundary" });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /SPARSE-/u);
  assert.equal(sanitized.orders.length, 4, "An identity-less malformed order is discarded.");
  assert.equal(sanitized.trucks[0].loads[0].stops.length, 3);
  assert.equal(compareDispatchReplayProjections(sanitizeDispatchReplayPlan()).equal, true);

  const duplicateIdentityPlan = {
    id: "DUPLICATE-PLAN",
    orders: [
      { id: "DUPLICATE-ROOT", childOrders: ["DUPLICATE-CHILD"], childOrderDetails: [{ id: "DUPLICATE-CHILD" }] },
      { id: "DUPLICATE-ROOT" }
    ],
    trucks: [{ id: "T", loads: [{ id: "L", stops: [{ id: "S", type: "drop", orderId: "DUPLICATE-ROOT" }] }] }]
  };
  const mismatch = compareDispatchReplayProjections(duplicateIdentityPlan);
  assert.equal(mismatch.equal, false);
  assert.ok(mismatch.differences.includes("assignments"));

  const empty = buildDispatchHistoricalReplayReport();
  assert.equal(empty.eventsProcessed, 0);
  assert.equal(empty.gapCount, 0);
  assert.deepEqual(empty.historicalInteractionGaps, DISPATCH_RISKY_INTERACTION_KEYS);
  const candidateOnly = buildDispatchHistoricalReplayReport({ events: [{
    id: "candidate",
    stream: "dispatch",
    serverAt: "2026-08-11T00:00:00Z",
    action: "",
    payload: { action: "po_link_dependency_direct_split_group_restore" },
    planState: duplicateIdentityPlan,
    candidateOnly: true
  }, {
    id: "mismatch",
    stream: "dispatch",
    serverAt: "2026-08-11T00:00:01Z",
    before: {},
    after: {},
    planState: duplicateIdentityPlan
  }] });
  assert.equal(candidateOnly.planStateTransitions, 1);
  assert.equal(candidateOnly.mismatchCount, 1);
  assert.equal(candidateOnly.mismatchSamples.length, 1);
  assert.equal(candidateOnly.interactionCoverage.restore, 1);
  assert.equal(candidateOnly.interactionCoverage.linkPo, 1);
  assert.equal(candidateOnly.interactionCoverage.linkTo, 1);
});

test("DPO-17 replay projections expose malformed legacy ambiguity instead of hiding it", () => {
  const defensive = compareDispatchReplayProjections({
    orders: [
      {},
      { id: "CO-ROOT", type: "CO", childOrders: ["IGNORED-CO-CHILD"] },
      {
        id: "CYCLIC",
        childOrders: ["CYCLIC", "UNKNOWN", "UNKNOWN"],
        childOrderDetails: [{ id: "DETAIL", childOrders: ["CYCLIC"] }],
        poPickupManifest: [{ orderRef: "PO-ORDER-REF" }, { id: "PO-ID" }, {}],
        orderDependencies: [{ orderRef: "TO-ORDER-REF" }, {}],
        transitCo: { coRef: "CO-ALIAS" }
      }
    ],
    trucks: [{
      plate: "TRUCK-PLATE-FALLBACK",
      loads: [
        { id: "EMPTY-STOPS", stops: null },
        { returnOnly: true, stops: [{ type: "drop", orderId: "IGNORED-RETURN" }] },
        {
          loadId: "LOAD-ID-FALLBACK",
          stops: [
            { stopId: "NON-DROP", type: "pickup", orderId: "CYCLIC" },
            { stopId: "NO-ORDER", type: "drop" },
            { stopId: "UNKNOWN-DROP", type: "drop", orderId: "UNKNOWN-DROP" },
            { stopId: "CO-DROP", type: "drop", orderId: "CO-ROOT" },
            { stopId: "CYCLIC-A", type: "drop", orderId: "CYCLIC" },
            { stopId: "CYCLIC-B", type: "drop", orderId: "CYCLIC" }
          ]
        }
      ]
    }]
  });
  assert.equal(typeof defensive.equal, "boolean");
  assert.ok(defensive.assignmentCount >= 3);

  const splitAliasMismatch = compareDispatchReplayProjections({
    orders: [
      { id: "DUPLICATE-SPLIT", originalOrderId: "PARENT" },
      { id: "DUPLICATE-SPLIT" }
    ],
    trucks: [{ id: "T", loads: [{ id: "L", stops: [{ id: "S", type: "drop", orderId: "DUPLICATE-SPLIT" }] }] }]
  });
  assert.equal(splitAliasMismatch.splitAliasCount, 1,
    "Duplicate persisted identities still resolve one deterministic split alias in both projections.");

  const relationMismatch = compareDispatchReplayProjections({
    orders: [{ id: "CASE-GROUP", childOrders: ["CHILD", "child"] }],
    trucks: [{ id: "T", loads: [{ id: "L", stops: [{ id: "S", type: "drop", orderId: "CASE-GROUP" }] }] }]
  });
  assert.ok(relationMismatch.differences.includes("relations"));

  const alternateIdentifiers = sanitizeDispatchReplayPlan({
    orders: [{ id: "O" }],
    trucks: [{
      plate: "PLATE-ONLY",
      loads: [{
        loadId: "LOAD-ONLY",
        stops: [{ stopId: "STOP-ONLY", type: "drop", orderRef: "O" }]
      }]
    }]
  });
  assert.equal(alternateIdentifiers.trucks[0].loads[0].stops[0].orderId.startsWith("ORDER_"), true);
});
