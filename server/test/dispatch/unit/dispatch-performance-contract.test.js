import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDispatchPlanCommand,
  buildCompactDispatchSnapshot,
  clearCancelledTransitCoMetadata,
  createDispatchCommandReceiptStore,
  digestDispatchPlan
} from "../../../src/dispatch-planner-performance.js";

function order(id, extra = {}) {
  return {
    id,
    type: "SO",
    address: `${id} destination`,
    items: [{ itemId: `${id}-ITEM`, quantity: 1 }],
    ...extra
  };
}

function planWithOrders(orders, stops) {
  return {
    id: "plan-2026-08-06",
    planDate: "2026-08-06",
    revision: 17,
    summary: { operatorNote: "keep me" },
    orders,
    trucks: [{
      id: "truck-1",
      plate: "MBT-1",
      loads: [{
        id: "load-1",
        name: "Load 1",
        stops
      }]
    }]
  };
}

test("DP-04 compact snapshot contains assigned and plan-owned identities but never the unassigned pool", () => {
  const assigned = order("SO-ASSIGNED");
  const co = order("CO-44", { type: "CO", transitCo: { sourceOrderId: "SO-ASSIGNED" } });
  const split = order("SO-ASSIGNED-S1", { originalOrderId: "SO-ASSIGNED" });
  const custom = order("CUSTOM-1", { type: "CUSTOM" });
  const unassigned = Array.from({ length: 609 }, (_, index) => order(`POOL-${index}`));
  const unassignedGroup = order("GROUP-UNASSIGNED", {
    type: "GROUP",
    childOrders: ["POOL-2", "POOL-3"],
    planOwned: true
  });
  const source = planWithOrders(
    [assigned, co, split, custom, unassignedGroup, ...unassigned],
    [
      { id: "pick-assigned", type: "pick", orderId: "SO-ASSIGNED" },
      { id: "drop-assigned", type: "drop", orderId: "SO-ASSIGNED" },
      { id: "drop-co", type: "drop", orderId: "CO-44" }
    ]
  );
  const before = structuredClone(source);

  const compact = buildCompactDispatchSnapshot(source);
  const refs = new Set(compact.orders.map((candidate) => candidate.id));

  assert.deepEqual(refs, new Set([
    "SO-ASSIGNED", "CO-44", "SO-ASSIGNED-S1", "CUSTOM-1",
    "GROUP-UNASSIGNED", "POOL-2", "POOL-3"
  ]));
  assert.equal(compact.orders.some((candidate) => candidate.id === "POOL-608"), false);
  assert.equal(compact.trucks[0].loads[0].stops.length, 3);
  assert.equal(JSON.stringify(compact).length < 250_000, true);
  assert.deepEqual(source, before, "compaction must not mutate the live planner state");
});

test("DP-04 plan digest is canonical, includes the compact board, and excludes unassigned source-pool noise", () => {
  const base = planWithOrders(
    [order("SO-1"), order("POOL-1", { address: "old" })],
    [{ id: "drop-1", type: "drop", orderId: "SO-1" }]
  );
  const differentObjectKeyOrder = {
    trucks: structuredClone(base.trucks),
    orders: structuredClone(base.orders),
    summary: structuredClone(base.summary),
    revision: base.revision,
    planDate: base.planDate,
    id: base.id
  };
  const poolChange = structuredClone(base);
  poolChange.orders[1].address = "new but unassigned";
  const scheduledChange = structuredClone(base);
  scheduledChange.trucks[0].loads[0].stops[0].address = "new scheduled address";

  assert.equal(digestDispatchPlan(base), digestDispatchPlan(differentObjectKeyOrder));
  assert.equal(digestDispatchPlan(base), digestDispatchPlan(poolChange));
  assert.notEqual(digestDispatchPlan(base), digestDispatchPlan(scheduledChange));
});

test("DP-28 a grouped source order remains in the compact plan after its cancelled CO metadata is cleared", () => {
  const grouped = order("GOA-6486-6489", {
    type: "SO",
    childOrders: ["SOA06486", "SOA06489"],
    childOrderDetails: [
      order("SOA06486", {
        items: [{ sku: "GROUP-SKU", pieces: 8, poAllocatedPieces: 8, poAllocatedSalesQty: 8 }]
      }),
      order("SOA06489")
    ],
    pickupLocations: ["2967", "Vendor Yard"],
    sourceYard: "2967",
    localDispatchStatus: "open",
    poPickupManifest: [{
      poOrderRef: "POB03597",
      location: "Vendor Yard",
      items: [{ sku: "GROUP-SKU", pieces: 8, quantity: 8 }]
    }],
    orderDependencies: [{
      id: 912,
      transferOrderRef: "TOB00762",
      mode: "direct_to_customer",
      status: "active"
    }]
  });
  const source = planWithOrders([grouped], []);

  const compact = buildCompactDispatchSnapshot(source);

  assert.deepEqual(compact.orders.map((candidate) => candidate.id), [grouped.id]);
  assert.deepEqual(compact.orders[0].childOrders, grouped.childOrders);
  assert.equal(compact.orders[0].transitCo, undefined);
  assert.deepEqual(compact.orders[0].poPickupManifest, grouped.poPickupManifest);
  assert.deepEqual(compact.orders[0].orderDependencies, grouped.orderDependencies);
  assert.equal(compact.orders[0].childOrderDetails[0].items[0].poAllocatedSalesQty, 8);
});

test("DP-29 a cancelled local CO cannot be resurrected by a grouped snapshot-derived order", () => {
  const grouped = order("GOA-6486-6489", {
    transitCo: { id: "CO-GOA-6486-6489", fromYard: "2967", toYard: "12441" },
    transitOriginalPickupLocations: ["2967"],
    transitOriginalSourceYard: "2967",
    pickupLocations: ["12441"],
    sourceYard: "12441",
    notes: "Transit via 12441. Grouped orders",
    poPickupManifest: [{ poOrderRef: "POB03597", location: "Vendor Yard", items: [] }],
    orderDependencies: [{ id: 912, transferOrderRef: "TOB00762" }],
    childOrders: ["SOA06486"],
    childOrderDetails: [order("SOA06486", {
      transitCo: { id: "CO-GOA-6486-6489", fromYard: "2967", toYard: "12441" },
      transitOriginalPickupLocations: ["2967"],
      pickupLocations: ["12441"],
      items: [{ sku: "GROUP-SKU", poAllocatedSalesQty: 8 }]
    })]
  });

  const cleared = clearCancelledTransitCoMetadata(grouped, [{
    coRef: "CO-GOA-6486-6489",
    fromYard: "2967",
    toYard: "12441"
  }]);

  assert.equal(cleared.transitCo, null);
  assert.deepEqual(cleared.pickupLocations, ["2967", "Vendor Yard"]);
  assert.equal(cleared.sourceYard, "2967");
  assert.equal(cleared.childOrderDetails[0].transitCo, null);
  assert.deepEqual(cleared.orderDependencies, grouped.orderDependencies);
  assert.deepEqual(cleared.poPickupManifest, grouped.poPickupManifest);
  assert.equal(cleared.childOrderDetails[0].items[0].poAllocatedSalesQty, 8);
  assert.doesNotMatch(cleared.notes, /^Transit via /iu);

  const active = clearCancelledTransitCoMetadata(grouped, [{
    coRef: "CO-ANOTHER-GROUP",
    fromYard: "3445",
    toYard: "12441"
  }]);
  assert.deepEqual(active.transitCo, grouped.transitCo);
  assert.deepEqual(active.pickupLocations, grouped.pickupLocations);
});

test("DP-06 exact command retries return the stored acknowledgement without a second revision or side effect", () => {
  const initial = planWithOrders(
    [order("A"), order("B"), order("C")],
    [
      { id: "drop-a", type: "drop", orderId: "A" },
      { id: "drop-b", type: "drop", orderId: "B" },
      { id: "drop-c", type: "drop", orderId: "C" }
    ]
  );
  const store = createDispatchCommandReceiptStore();
  const command = {
    commandId: "remove-A-once",
    baseRevision: 17,
    type: "remove_order",
    payload: { orderRef: "A" }
  };

  const first = applyDispatchPlanCommand({ plan: initial, command, receiptStore: store });
  const replay = applyDispatchPlanCommand({ plan: first.plan, command, receiptStore: store });

  assert.equal(first.replay, false);
  assert.equal(first.revision, 18);
  assert.equal(first.plan.trucks[0].loads[0].stops.some((stop) => stop.orderId === "A"), false);
  assert.equal(replay.replay, true);
  assert.equal(replay.revision, 18);
  assert.deepEqual(replay.acknowledgement, first.acknowledgement);
  assert.deepEqual(replay.plan, first.plan);
});

test("DP-06 command ID reuse with a different body is rejected before changing the plan", () => {
  const initial = planWithOrders(
    [order("A"), order("B")],
    [{ id: "drop-a", type: "drop", orderId: "A" }, { id: "drop-b", type: "drop", orderId: "B" }]
  );
  const store = createDispatchCommandReceiptStore();
  const first = applyDispatchPlanCommand({
    plan: initial,
    receiptStore: store,
    command: { commandId: "same-id", baseRevision: 17, type: "remove_order", payload: { orderRef: "A" } }
  });

  assert.throws(
    () => applyDispatchPlanCommand({
      plan: first.plan,
      receiptStore: store,
      command: { commandId: "same-id", baseRevision: 18, type: "remove_order", payload: { orderRef: "B" } }
    }),
    (error) => error?.code === "DISPATCH_COMMAND_ID_REUSED" && error?.status === 409
  );
  assert.equal(first.plan.trucks[0].loads[0].stops.some((stop) => stop.orderId === "B"), true);
});

test("DP-10 a stale digest is rejected even when the numeric revision still matches", () => {
  const initial = planWithOrders(
    [order("A")],
    [{ id: "drop-a", type: "drop", orderId: "A" }]
  );
  const baseDigest = digestDispatchPlan(initial);
  const outOfBand = structuredClone(initial);
  outOfBand.summary.outOfBandChange = true;

  assert.throws(
    () => applyDispatchPlanCommand({
      plan: outOfBand,
      receiptStore: createDispatchCommandReceiptStore(),
      command: {
        commandId: "stale-digest",
        baseRevision: initial.revision,
        baseDigest,
        type: "remove_order",
        payload: { orderRef: "A" }
      }
    }),
    (error) => error?.code === "STALE_DISPATCH_PLAN"
      && error?.expectedDigest === baseDigest
      && error?.currentDigest === digestDispatchPlan(outOfBand)
  );
});

test("DP-27 an acknowledged command digest remains valid after PostgreSQL-style JSON persistence", () => {
  const createdAt = new Date("2026-08-05T14:30:00.000Z");
  const initial = planWithOrders(
    [order("CUSTOM-1", {
      type: "CUSTOM",
      customOrderId: "81",
      createdAt,
      raw: { custom_order_id: "81", created_at: createdAt }
    })],
    [{ id: "drop-custom-1", type: "drop", orderId: "CUSTOM-1" }]
  );
  const first = applyDispatchPlanCommand({
    plan: initial,
    command: {
      commandId: "persist-custom-date",
      baseRevision: initial.revision,
      baseDigest: digestDispatchPlan(initial),
      type: "replace_plan",
      payload: {
        planDate: initial.planDate,
        orders: initial.orders,
        trucks: initial.trucks,
        summary: { ...initial.summary, savedOnce: true }
      }
    }
  });

  // jsonb receives the JSON representation and the pg client parses that value
  // again on the next command. The acknowledgement must survive that boundary.
  const reloaded = JSON.parse(JSON.stringify(first.plan));
  const second = applyDispatchPlanCommand({
    plan: reloaded,
    command: {
      commandId: "remove-custom-after-reload",
      baseRevision: first.revision,
      baseDigest: first.acknowledgement.digest,
      type: "remove_order",
      payload: { orderRef: "CUSTOM-1" }
    }
  });

  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.plan.trucks[0].loads[0].stops.length, 0);
});

test("DP-05/DP-16 replace_plan atomically acknowledges the browser's already-validated compact board", () => {
  const initial = planWithOrders(
    [order("A"), order("B")],
    [
      { id: "drop-a", type: "drop", orderId: "A" },
      { id: "drop-b", type: "drop", orderId: "B" }
    ]
  );
  const replacement = structuredClone(initial);
  replacement.trucks[0].loads[0].stops = [
    { id: "drop-b", type: "drop", orderId: "B" },
    { id: "drop-a", type: "drop", orderId: "A" }
  ];
  replacement.summary = { operatorNote: "edited locally" };

  const result = applyDispatchPlanCommand({
    plan: initial,
    command: {
      commandId: "replace-validated-board",
      baseRevision: initial.revision,
      baseDigest: digestDispatchPlan(initial),
      type: "replace_plan",
      payload: {
        planDate: initial.planDate,
        orders: replacement.orders,
        trucks: replacement.trucks,
        summary: replacement.summary,
        affectedOrderRefs: ["A", "B"],
        actionName: "group_order"
      }
    }
  });

  assert.equal(result.revision, 18);
  assert.deepEqual(result.plan.trucks, replacement.trucks);
  assert.deepEqual(result.plan.summary, replacement.summary);
  assert.deepEqual(result.patch.affectedOrderRefs, ["A", "B"]);
  assert.equal(result.patch.actionName, "group_order");
});
