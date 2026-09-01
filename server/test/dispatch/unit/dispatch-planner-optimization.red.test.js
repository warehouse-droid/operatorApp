import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDispatchPlanDelta,
  buildDispatchPlanDelta,
  classifyDispatchReplayEvidence,
  compactDispatchOrderCard,
  dispatchCheckpointDecision,
  dispatchCheckpointRetention,
  dispatchOrderSearchText,
  extractDispatchOrderRelationEdges,
  mergeDispatchReplayEvents,
  normalizeDispatchPlannerMode
} from "../../../src/dispatch-planner-optimization.js";

test("DPO-01 runtime modes fail closed", () => {
  assert.equal(normalizeDispatchPlannerMode("on"), "on");
  assert.equal(normalizeDispatchPlannerMode(" SHADOW "), "shadow");
  assert.equal(normalizeDispatchPlannerMode("off"), "off");
  assert.equal(normalizeDispatchPlannerMode("enabled"), "off");
  assert.equal(normalizeDispatchPlannerMode(undefined), "off");
});

test("DPO-02 compact cards retain planning identity and bound item/raw detail", () => {
  const order = {
    id: "SOA10001",
    type: "SO",
    customer: "Cedar Customer",
    address: "100 Main Street, Toronto",
    sourceYard: "2967",
    destinationYard: "12441",
    expectedDeliveryDate: "2026-08-20",
    pallets: 12,
    layers: 3,
    weight: 34000,
    childOrders: ["SOA10001-A"],
    originalOrderId: "SOA10000",
    raw: { giant: "x".repeat(50_000), credential: "must-not-leak" },
    items: Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      sku: `SKU-${index + 1}`,
      itemName: `Item ${index + 1}`,
      description: "description ".repeat(50),
      quantity: index + 1,
      raw: { giant: "y".repeat(1_000) }
    }))
  };

  const card = compactDispatchOrderCard(order);
  assert.equal(card.id, order.id);
  assert.equal(card.type, "SO");
  assert.equal(card.customer, order.customer);
  assert.equal(card.address, order.address);
  assert.deepEqual(card.childOrders, order.childOrders);
  assert.equal(card.originalOrderId, order.originalOrderId);
  assert.equal(card.catalogHydrated, false);
  assert.ok(card.items.length <= 8);
  assert.equal(Object.hasOwn(card, "raw"), false);
  assert.ok(JSON.stringify(card).length < 8_000);
  const search = dispatchOrderSearchText(order);
  assert.match(search, /soa10001/u);
  assert.match(search, /cedar customer/u);
  assert.match(search, /sku-40/u, "search indexes all item identities even when the card truncates display items");
  assert.doesNotMatch(search, /must-not-leak/u);
});

test("DPO-02b compact PO cards retain source-to-ref identities for indexed search", () => {
  const order = {
    id: "SN1398449",
    type: "PO",
    originalPoRef: "SN1398449",
    sourcePoRef: "POB03321",
    sourcePoRefs: ["POB03321"],
    correspondingPoRefs: ["SN1398449"]
  };

  const card = compactDispatchOrderCard(order);
  assert.equal(card.sourcePoRef, "POB03321");
  assert.deepEqual(card.sourcePoRefs, ["POB03321"]);
  assert.deepEqual(card.correspondingPoRefs, ["SN1398449"]);
  assert.match(dispatchOrderSearchText(order), /pob03321/u);
  assert.match(dispatchOrderSearchText(order), /sn1398449/u);
});

test("DPO-02c compact cards retain bounded completed transit CO evidence", () => {
  const card = compactDispatchOrderCard({
    id: "SOA07512",
    type: "SO",
    sourceYard: "2967",
    pickupLocations: ["12441"],
    transitCo: {
      id: "CO-SOA07512",
      fromYard: "2967",
      toYard: "12441",
      status: "completed",
      source: "local-db",
      raw: { giant: "x".repeat(50_000), credential: "must-not-leak" }
    }
  });

  assert.deepEqual(card.transitCo, {
    id: "CO-SOA07512",
    fromYard: "2967",
    toYard: "12441",
    status: "completed",
    source: "local-db"
  });
  assert.deepEqual(card.pickupLocations, ["12441"]);
  assert.doesNotMatch(JSON.stringify(card), /must-not-leak/u);
  assert.ok(JSON.stringify(card).length < 2_000);
});

test("DPO-02d compact cards retain global derived-order provenance", () => {
  const card = compactDispatchOrderCard({
    id: "TO-DRAFT-GLOBAL-1",
    type: "TO",
    globalOrderDefinition: true,
    globalOrderDefinitionKind: "consolidation",
    globalOrderSourcePlanId: "41",
    globalOrderSourcePlanDate: "2026-08-31"
  });

  assert.equal(card.globalOrderDefinition, true);
  assert.equal(card.globalOrderDefinitionKind, "consolidation");
  assert.equal(card.globalOrderSourcePlanId, "41");
  assert.equal(card.globalOrderSourcePlanDate, "2026-08-31");
});

test("DPO-03 keyed plan delta round-trips and is idempotent", () => {
  const before = {
    planDate: "2026-08-20",
    orders: [
      { id: "SO-1", type: "SO", pallets: 1 },
      { id: "SO-2", type: "SO", pallets: 2 }
    ],
    trucks: [
      { id: "T-1", plate: "AAA", loads: [{ id: "L-1", stops: [{ id: "S-1", orderId: "SO-1" }] }] },
      { id: "T-2", plate: "BBB", loads: [] }
    ],
    summary: { driverLaneOrder: ["d1", "d2"], retained: true }
  };
  const after = {
    ...before,
    orders: [
      { id: "SO-2", type: "SO", pallets: 3 },
      { id: "GROUP-1", type: "GROUP", childOrders: ["SO-1", "SO-3"] }
    ],
    trucks: [
      { id: "T-2", plate: "BBB", loads: [{ id: "L-2", stops: [] }] },
      { id: "T-1", plate: "AAA", loads: [{ id: "L-1", stops: [{ id: "S-G", orderId: "GROUP-1" }] }] }
    ],
    summary: { driverLaneOrder: ["d2", "d1"], retained: true, changed: 1 }
  };
  const delta = buildDispatchPlanDelta(before, after);
  assert.deepEqual(applyDispatchPlanDelta(before, delta), after);
  assert.deepEqual(applyDispatchPlanDelta(after, delta), after);
  assert.deepEqual(delta.orderRefsRemoved, ["SO-1"]);
  assert.deepEqual(delta.truckOrder, ["T-2", "T-1"]);
  assert.ok(JSON.stringify(delta).length < JSON.stringify(after).length);
});

test("DPO-04 checkpoint cadence and retention distinguish recovery evidence", () => {
  const now = new Date("2026-08-20T12:05:00.000Z");
  assert.deepEqual(dispatchCheckpointDecision({
    commandsSinceCheckpoint: 25,
    lastCheckpointAt: "2026-08-20T12:04:59.000Z",
    now
  }), { due: true, trigger: "command_count" });
  assert.deepEqual(dispatchCheckpointDecision({
    commandsSinceCheckpoint: 1,
    lastCheckpointAt: "2026-08-20T12:00:00.000Z",
    now
  }), { due: true, trigger: "elapsed_time" });
  assert.deepEqual(dispatchCheckpointDecision({
    commandsSinceCheckpoint: 24,
    lastCheckpointAt: "2026-08-20T12:00:01.000Z",
    now
  }), { due: false, trigger: "" });
  assert.equal(dispatchCheckpointRetention({ kind: "periodic" }), 7);
  assert.equal(dispatchCheckpointRetention({ kind: "manual" }), 90);
  assert.equal(dispatchCheckpointRetention({ kind: "lifecycle" }), 90);
  assert.equal(dispatchCheckpointRetention({ kind: "recovery", resolvedAt: null }), null);
  assert.equal(dispatchCheckpointRetention({ kind: "recovery", resolvedAt: "2026-08-20T12:00:00Z" }), 90);
});

test("DPO-05 causal replay retains gaps and uses deterministic ordering", () => {
  const events = mergeDispatchReplayEvents([
    { stream: "driver", id: "d2", serverAt: "2026-08-20T12:00:03Z", sourceSequence: 2, payload: { eventId: "offline-2" } },
    { stream: "dispatch", id: "p1", serverAt: "2026-08-20T12:00:01Z", sourceSequence: 4, payload: { commandId: "cmd-1" } },
    { stream: "scm", id: "s1", serverAt: "2026-08-20T12:00:03Z", sourceSequence: 1, before: {}, after: { status: "Queued" } },
    { stream: "netsuite", id: "n1", serverAt: "2026-08-20T12:00:02Z" }
  ]);
  assert.deepEqual(events.map((event) => event.id), ["p1", "n1", "s1", "d2"]);
  assert.equal(events[0].evidence, "exact");
  assert.equal(events[1].evidence, "gap");
  assert.equal(events[2].evidence, "state-derived");
  assert.equal(events[3].evidence, "exact");
  assert.equal(classifyDispatchReplayEvidence({ payload: {} }), "exact");
  assert.equal(classifyDispatchReplayEvidence({ before: {}, after: {} }), "state-derived");
  assert.equal(classifyDispatchReplayEvidence({}), "gap");
});

test("DPO-07 relationship projection preserves interacting group, split, PO, TO, direct-ship, and CO identities", () => {
  const edges = extractDispatchOrderRelationEdges({
    orders: [{
      id: "GOA-100-101",
      type: "GROUP",
      childOrders: ["SOA100-S1", "SOA101"],
      childOrderDetails: [{
        id: "SOA100-S1",
        type: "SO",
        originalOrderId: "SOA100",
        poPickupManifest: [{ poOrderRef: "POB500", location: "Vendor Yard" }],
        orderDependencies: [{ transferOrderRef: "TOB700", mode: "direct_to_customer", status: "active" }],
        transitCo: { id: "CO-SOA100", sourceOrderId: "SOA100-S1" }
      }, {
        id: "SOA101",
        type: "SO"
      }],
      poPickupManifest: [{ poOrderRef: "POB501", location: "Second Vendor" }],
      orderDependencies: [{ transferOrderRef: "TOB701", mode: "replenishment", status: "active" }]
    }]
  });
  const identities = edges.map((edge) => `${edge.relationType}:${edge.ownerRef}->${edge.memberRef}`);
  assert.deepEqual(identities, [
    "group_member:GOA-100-101->SOA100-S1",
    "group_member:GOA-100-101->SOA101",
    "po_link:GOA-100-101->POB501",
    "to_link:GOA-100-101->TOB701",
    "split_child:SOA100->SOA100-S1",
    "po_link:SOA100-S1->POB500",
    "to_link:SOA100-S1->TOB700",
    "direct_ship:SOA100-S1->TOB700",
    "co_source:CO-SOA100->SOA100-S1"
  ]);
  assert.equal(edges.find((edge) => edge.relationType === "direct_ship")?.metadata.mode, "direct_to_customer");
  assert.equal(new Set(identities).size, identities.length, "projection must not duplicate nested aliases");
});

test("DPO-15 defensive delta, search, relation, checkpoint, and replay boundaries fail closed", () => {
  assert.equal(compactDispatchOrderCard({ orderId: "ORDER-ID", items: null }).id, "ORDER-ID");
  assert.equal(compactDispatchOrderCard({ refNumber: "REF-ID", items: "invalid" }).id, "REF-ID");
  assert.deepEqual(compactDispatchOrderCard().items, []);
  assert.match(dispatchOrderSearchText({
    childOrderDetails: [{ id: "CHILD-ALT", customer: "Nested", items: null }],
    childOrders: null,
    groupAliases: null,
    items: [{ id: "ITEM-ALT", sku: null, itemName: "Visible" }]
  }), /child-alt nested item-alt visible/u);
  assert.equal(dispatchOrderSearchText(), "");

  const nested = {
    orderId: "GROUP-ALT",
    childOrders: [{ orderId: "CHILD-OBJECT" }, "CHILD-DETAIL", ""],
    childOrderDetails: [{
      orderId: "CHILD-DETAIL",
      parentOrderRef: "PARENT-ALT",
      poPickupManifest: [{ orderRef: "PO-ALT" }, { id: "PO-ID" }, {}],
      orderDependencies: [
        { orderRef: "TO-ALT", mode: "direct_to_customer", status: "active" },
        { mode: "yard_replenishment" }
      ],
      transitCo: { coRef: "CO-ALT" }
    }, {}],
    poPickupManifest: [{ poOrderRef: "PO-ROOT", extra: undefined }, { poOrderRef: "PO-ROOT" }],
    orderDependencies: [{ transferOrderRef: "TO-ROOT" }, { transferOrderRef: "TO-ROOT" }]
  };
  const sparseEdges = extractDispatchOrderRelationEdges({ orders: [nested, nested, null, {}] });
  assert.ok(sparseEdges.some((edge) => edge.relationType === "direct_ship" && edge.memberRef === "TO-ALT"));
  assert.ok(sparseEdges.some((edge) => edge.relationType === "co_source" && edge.memberRef === "CHILD-DETAIL"));
  assert.equal(sparseEdges.filter((edge) => edge.memberRef === "PO-ROOT").length, 1);
  assert.deepEqual(extractDispatchOrderRelationEdges({ orders: null }), []);

  const metadataDelta = buildDispatchPlanDelta(
    { id: "P", status: "draft", orders: [], trucks: [], summary: {} },
    { id: "P", status: "confirmed", orders: [], trucks: [], summary: { ready: true } }
  );
  assert.equal(applyDispatchPlanDelta({ id: "P", status: "draft", orders: [], trucks: [], summary: {} }, metadataDelta).status, "confirmed");
  const replacementDelta = buildDispatchPlanDelta({
    orders: Array.from({ length: 20 }, (_, index) => ({ id: `REMOVE-${index}` })),
    trucks: Array.from({ length: 20 }, (_, index) => ({ id: `TRUCK-${index}` })),
    summary: { large: true }
  }, { orders: [], trucks: [], summary: {} });
  assert.equal(Array.isArray(replacementDelta.orders), true, "A shorter full replacement remains a valid wire form.");
  assert.deepEqual(applyDispatchPlanDelta({}, {
    o: [{ orderId: "ORDER-ALT" }, { refNumber: "REF-ALT" }, { plate: "PLATE-ALT" }, {}],
    or: null,
    oo: ["missing", "REF-ALT", "REF-ALT"],
    t: null,
    tr: null,
    to: [],
    m: [],
    s: null
  }).orders.map((order) => order.orderId || order.refNumber || order.plate), ["REF-ALT", "ORDER-ALT", "PLATE-ALT"]);
  assert.deepEqual(applyDispatchPlanDelta({ summary: { keep: true } }, {
    orders: [], trucks: [], summary: null, m: { status: "restored" }
  }), { summary: {}, status: "restored", orders: [], trucks: [] });
  for (const invalid of [null, [], "delta"]) {
    assert.throws(() => applyDispatchPlanDelta({}, invalid), TypeError);
  }

  assert.deepEqual(dispatchCheckpointDecision(), { due: false, trigger: "" });
  assert.deepEqual(dispatchCheckpointDecision({
    commandsSinceCheckpoint: -2,
    commandLimit: 0,
    elapsedMinutes: 0,
    lastCheckpointAt: "invalid",
    now: "invalid"
  }), { due: false, trigger: "" });
  assert.equal(dispatchCheckpointRetention(), 7);
  assert.equal(dispatchCheckpointRetention({ kind: "unknown" }), 7);
  assert.equal(classifyDispatchReplayEvidence({ payload: null, before: {} }), "gap");
  assert.equal(classifyDispatchReplayEvidence({ payload: "invalid", before: {}, after: {} }), "state-derived");
  assert.deepEqual(mergeDispatchReplayEvents("invalid"), []);
  const tied = mergeDispatchReplayEvents([
    null,
    "invalid",
    { id: "fallback-at", stream: "dispatch", at: "2026-01-01T00:00:00Z", sourceSequence: 0 },
    { id: "driver-late", stream: "driver", serverAt: "2026-01-01T00:00:01Z", sourceSequence: 1, deviceAt: "2026-01-01T00:00:02Z" },
    { id: "driver-early", stream: "driver", serverAt: "2026-01-01T00:00:01Z", sourceSequence: 1, occurredAt: "2026-01-01T00:00:01Z" },
    { id: "invalid-time", stream: "scm", serverAt: "invalid", sourceSequence: 0 }
  ]);
  assert.deepEqual(tied.map((event) => event.id), ["fallback-at", "driver-early", "driver-late", "invalid-time"]);
});

test("DPO-16 legacy sparse values exercise every safe compact-delta fallback", () => {
  const card = compactDispatchOrderCard({
    orderRef: "ORDER-FALLBACK",
    type: null,
    items: [
      undefined,
      { sku: "", itemName: null, quantity: 0, description: "x".repeat(300) }
    ]
  });
  assert.equal(card.id, "ORDER-FALLBACK");
  assert.deepEqual(card.items[0], {});
  assert.equal(card.items[1].quantity, 0);
  assert.equal(card.items[1].description.length, 240);
  assert.match(dispatchOrderSearchText({
    groupAliases: ["LEGACY ALIAS"],
    childOrderDetails: [{ items: [undefined, { sku: "NESTED-SKU" }] }]
  }), /legacy alias nested-sku/u);

  const arrayManifest = [];
  arrayManifest.poOrderRef = "PO-ARRAY-METADATA";
  const selfDetail = { id: "SELF-GROUP" };
  const edges = extractDispatchOrderRelationEdges({
    orders: [{
      id: "SELF-GROUP",
      originalOrderId: "SELF-GROUP",
      childOrders: ["SELF-GROUP"],
      childOrderDetails: [selfDetail],
      poPickupManifest: [arrayManifest]
    }]
  });
  assert.deepEqual(edges.map((edge) => edge.relationType), ["group_member", "po_link"]);
  assert.deepEqual(edges.find((edge) => edge.relationType === "po_link")?.metadata, {});

  const emptyDelta = buildDispatchPlanDelta(
    { updatedAt: new Date("2026-08-19T00:00:00.000Z"), orders: null, trucks: null, summary: null },
    { updatedAt: new Date("2026-08-20T00:00:00.000Z"), orders: null, trucks: null, summary: null }
  );
  assert.equal(applyDispatchPlanDelta({ orders: null, trucks: null, summary: null }, emptyDelta).updatedAt,
    "2026-08-20T00:00:00.000Z");
  assert.deepEqual(applyDispatchPlanDelta(), { orders: [], trucks: [], summary: {} });
  assert.deepEqual(applyDispatchPlanDelta({ trucks: [{ id: "KEEP-TRUCK" }] }, { orders: [] }), {
    orders: [],
    trucks: [{ id: "KEEP-TRUCK" }],
    summary: {}
  });

  const unordered = mergeDispatchReplayEvents([
    { id: "created", stream: "scm", createdAt: "2026-08-19T00:00:00Z" },
    { id: "missing-a", stream: "dispatch" },
    { id: "missing-b", stream: "dispatch" },
    { id: "driver-a", stream: "driver", serverAt: "2026-08-20T00:00:00Z" },
    { id: "driver-b", stream: "driver", serverAt: "2026-08-20T00:00:00Z" }
  ]);
  assert.deepEqual(unordered.map((event) => event.id), [
    "created", "driver-a", "driver-b", "missing-a", "missing-b"
  ]);
});
