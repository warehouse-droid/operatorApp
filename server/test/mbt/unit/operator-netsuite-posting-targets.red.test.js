// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import {
  createOperatorNetSuitePostingRealSourceResolver,
  createOperatorNetSuitePostingTargetResolver,
  createOperatorNetSuiteReceivingOrderReader
} from "../../../src/operator-netsuite-posting-targets.js";

const POLICY = Object.freeze({
  gateKey: "operator_netsuite_delivery_prep_if_12441",
  revision: 7,
  effective: true,
  functionKey: "delivery_prep",
  transactionType: "IF",
  locationId: 15,
  yardCode: "12441"
});

function line({ id, lineId, quantity = 10, packed = 2, locationId = 15 } = {}) {
  return {
    id,
    line_id: lineId,
    item_type: "InvtPart",
    netsuite_active: true,
    quantity,
    unit: "EA",
    location_id: locationId,
    packed_sales_qty: packed,
    packed_pallet_qty: 0,
    packed_layer_qty: 0,
    packed_section_qty: 0,
    packed_piece_qty: 0,
    fulfilled_pallet_qty: 0,
    fulfilled_layer_qty: 0,
    fulfilled_section_qty: 0,
    fulfilled_piece_qty: 0,
    loaded_qty: 0,
    to_plt: 0,
    to_lyr: 0,
    to_sec: 0,
    to_pcs: 0
  };
}

function salesOrder({ id = 101, ref = "SOA101", locationId = 15, lines = [line({ id: 1001, lineId: 1 })], ...rest } = {}) {
  return {
    netsuite_id: id,
    tranid: ref,
    order_type: "sales_order",
    delivery_method: "Delivery",
    outbound_location_id: locationId,
    operator_status: "packed",
    lines,
    ...rest
  };
}

function transferOrder({ id = 202, ref = "TOB202", locationId = 15, lines = [line({ id: 2001, lineId: 4 })], ...rest } = {}) {
  return {
    netsuite_id: id,
    tranid: ref,
    order_type: "transfer_order",
    outbound_location_id: locationId,
    source_location_id: locationId,
    destination_location_id: 28,
    operator_status: "packed",
    lines,
    ...rest
  };
}

function purchaseOrder({ id = 303, ref = "POB303", locationId = 15 } = {}) {
  const receivingLine = {
    ...line({ id: 3001, lineId: 8, packed: 0, locationId }),
    received_sales_qty: 3,
    received_pallet_qty: 0,
    received_layer_qty: 0,
    received_section_qty: 0,
    received_piece_qty: 0,
    netsuite_received_qty: 0,
    netsuite_received_baseline_qty: 0
  };
  return {
    netsuite_id: id,
    tranid: ref,
    order_type: "purchase_order",
    destination_location_id: locationId,
    lines: [receivingLine],
    receivableLines: [receivingLine]
  };
}

function source(order) {
  const isTransfer = order.order_type === "transfer_order";
  return {
    sourceOrderKind: isTransfer ? "TO" : order.order_type === "purchase_order" ? "PO" : "SO",
    sourceNetSuiteId: Number(order.netsuite_id),
    sourceOrderRef: order.tranid,
    availableLines: order.lines.map((entry) => ({
      orderLine: Number(entry.line_id) + (isTransfer ? 1 : 0),
      location: isTransfer ? null : Number(entry.location_id || order.outbound_location_id || order.destination_location_id)
    }))
  };
}

function resolver({ orders, sources = new Map() }) {
  return createOperatorNetSuitePostingTargetResolver({
    getDeliveryOrder: async (id) => orders.get(String(id)) || null,
    getReceivableReceivingOrder: async (id) => orders.get(String(id)) || null,
    resolveRealSource: async (order) => sources.get(String(order.netsuite_id)) || (Number(order.netsuite_id) > 0 ? source(order) : null)
  });
}

test("P1 customer pickup resolves a partial SO IF and rejects a forged browser yard", async () => {
  const order = salesOrder({
    id: 101,
    ref: "SOA101",
    lines: [line({ id: 1001, lineId: 1, packed: 2 }), line({ id: 1002, lineId: 2, packed: 0 })],
    delivery_method: "Pick-Up"
  });
  const resolve = resolver({ orders: new Map([["101", order]]) });
  const result = await resolve({ functionKey: "customer_pickup", orderId: 101, clientLocationId: 15 });
  assert.equal(result.localOnly, false);
  assert.equal(result.canonicalLocationId, 15);
  assert.deepEqual(result.localOperation, {
    kind: "customer_pickup_load",
    orderId: "101",
    orderType: "sales_order"
  });
  assert.deepEqual(result.targets[0].selectedLines.map(({ orderLine, quantity }) => ({ orderLine, quantity })), [
    { orderLine: 1, quantity: 2 }
  ]);
  assert.deepEqual(result.targets[0].availableLines.map(({ orderLine }) => orderLine), [1, 2]);

  await assert.rejects(
    resolve({ functionKey: "customer_pickup", orderId: 101, clientLocationId: 28 }),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_LOCATION_MISMATCH"
  );
});

test("P2 receiving uses the effective PO destination and local CO never creates a target", async () => {
  const po = purchaseOrder({ locationId: 28 });
  const localCo = {
    netsuite_id: -404,
    tranid: "CO-404",
    order_type: "co_order",
    destination_location_id: 28,
    lines: []
  };
  const resolve = resolver({ orders: new Map([["303", po], ["CO-404", localCo]]) });
  const remote = await resolve({ functionKey: "receiving", orderId: 303, clientLocationId: 13 });
  assert.equal(remote.canonicalLocationId, 28, "Legacy location 13 must normalize to canonical 2967/28.");
  assert.equal(remote.transactionType, "IR");
  assert.equal(remote.targets[0].sourceOrderKind, "PO");
  assert.deepEqual(remote.targets[0].selectedLines.map(({ orderLine, quantity, location }) => ({ orderLine, quantity, location })), [
    { orderLine: 8, quantity: 3, location: 28 }
  ]);

  const local = await resolve({ functionKey: "receiving", orderId: "CO-404", clientLocationId: 28 });
  assert.equal(local.localOnly, true);
  assert.deepEqual(local.targets, []);
});

test("P4 grouped split children aggregate by positive parent while re-attempts remain local-only", async () => {
  const splitOne = salesOrder({ id: -11, ref: "SOA900-S1", lines: [line({ id: -111, lineId: 1, packed: 2 })] });
  const splitTwo = salesOrder({ id: -12, ref: "SOA900-S2", lines: [line({ id: -121, lineId: 1, packed: 3 })] });
  const nativeTo = transferOrder({ id: 202, lines: [line({ id: 2001, lineId: 4, packed: 1 })] });
  const reattempt = salesOrder({ id: 777, ref: "SOA777-R1", reload_authorized: true, sales_order_reattempt: true });
  const group = salesOrder({
    id: "GROUP:one",
    ref: "SOA900-S1+SOA900-S2+TOB202+SOA777-R1",
    is_dispatch_group: true,
    child_orders: [splitOne, splitTwo, nativeTo, reattempt],
    child_order_ids: [-11, -12, 202, 777]
  });
  const parent = salesOrder({
    id: 900,
    ref: "SOA900",
    lines: [line({ id: 9001, lineId: 1, packed: 0 }), line({ id: 9002, lineId: 3, packed: 0 })]
  });
  const splitSource = source(parent);
  const sources = new Map([["-11", splitSource], ["-12", splitSource]]);
  const resolve = resolver({ orders: new Map([["GROUP:one", group]]), sources });
  const result = await resolve({ functionKey: "delivery_prep", orderId: "GROUP:one", clientLocationId: 15 });
  assert.equal(result.localOnly, false);
  assert.equal(result.targets.length, 3);
  assert.ok(result.localOrderKeys.some((key) => key.includes("777")), "The local re-attempt is frozen with the group.");
  assert.equal(result.targets.some((target) => target.sourceNetSuiteId === 777), false);

  const draft = buildOperatorNetSuitePostingDraft({
    requestId: "b5c5d3fe-8fe5-4da5-967c-68178d7aaab1",
    actorOperatorId: "operator-one",
    functionKey: result.functionKey,
    transactionType: result.transactionType,
    policy: POLICY,
    photoRefs: ["r2://operator/load/a.jpg", "r2://operator/load/b.jpg"],
    localOrderKeys: result.localOrderKeys,
    localOperation: result.localOperation,
    targets: result.targets
  });
  assert.equal(draft.steps.length, 2);
  assert.deepEqual(
    draft.steps.map((step) => [step.sourceOrderKind, step.sourceNetSuiteId]),
    [["SO", 900], ["TO", 202]]
  );
  assert.equal(draft.steps[0].payload.item.items.find((item) => item.orderLine === 1).quantity, 5);
  assert.equal(draft.steps[0].payload.item.items.find((item) => item.orderLine === 3).itemReceive, false);
  assert.equal(draft.steps[1].payload.item.items[0].orderLine, 5, "TO transform lines use the NetSuite +1 offset.");
});

test("P4/P7 missing split lineage and mixed-yard groups fail before any command exists", async () => {
  const missingSplit = salesOrder({ id: -99, ref: "SOA99-S1" });
  const first = salesOrder({ id: 501, locationId: 15 });
  const second = salesOrder({ id: 502, locationId: 28 });
  const mixed = salesOrder({
    id: "GROUP:mixed",
    is_dispatch_group: true,
    child_orders: [first, second],
    child_order_ids: [501, 502]
  });
  const resolve = resolver({ orders: new Map([["-99", missingSplit], ["GROUP:mixed", mixed]]) });
  await assert.rejects(
    resolve({ functionKey: "delivery_prep", orderId: -99, clientLocationId: 15 }),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED"
  );
  await assert.rejects(
    resolve({ functionKey: "delivery_prep", orderId: "GROUP:mixed", clientLocationId: 15 }),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_MIXED_YARDS"
  );
});

test("P1-P4 invalid functions, missing orders, unsupported pickup, empty groups, and empty quantities fail closed", async () => {
  const delivery = salesOrder({ id: 601, lines: [line({ id: 6001, lineId: 1, packed: 0 })] });
  const nonPickup = salesOrder({ id: 602, delivery_method: "Delivery" });
  const emptyGroup = salesOrder({ id: "GROUP:empty", is_dispatch_group: true, child_orders: [] });
  const unresolved = salesOrder({ id: 603 });
  const localReload = salesOrder({ id: 604, reload_authorized: true });
  const resolve = resolver({
    orders: new Map([
      ["601", delivery],
      ["602", nonPickup],
      ["GROUP:empty", emptyGroup],
      ["603", unresolved],
      ["604", localReload]
    ]),
    sources: new Map([["603", { sourceOrderKind: "SO", sourceNetSuiteId: 603, sourceOrderRef: "SOA603", availableLines: [] }]])
  });

  await assert.rejects(resolve({ functionKey: "arbitrary", orderId: 601 }), (error) => error?.status === 400);
  await assert.rejects(resolve({ functionKey: "delivery_prep", orderId: 999 }), (error) => error?.status === 404);
  await assert.rejects(
    resolve({ functionKey: "customer_pickup", orderId: 602, clientLocationId: 15 }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_ORDER_UNSUPPORTED"
  );
  await assert.rejects(
    resolve({ functionKey: "delivery_prep", orderId: "GROUP:empty", clientLocationId: 15 }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED"
  );
  await assert.rejects(
    resolve({ functionKey: "delivery_prep", orderId: 601, clientLocationId: 15 }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_NO_LINES"
  );
  await assert.rejects(
    resolve({ functionKey: "delivery_prep", orderId: 603, clientLocationId: 15 }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED"
  );
  assert.equal((await resolve({ functionKey: "delivery_prep", orderId: 604, clientLocationId: 15 })).localOnly, true);
});

test("G1 a deferred gate lookup does not require posting-only packed line evidence", async () => {
  const delivery = salesOrder({ id: 605, lines: [line({ id: 6005, lineId: 1, packed: 0 })] });
  const resolve = resolver({ orders: new Map([["605", delivery]]) });
  const deferred = await resolve({
    functionKey: "delivery_prep",
    orderId: 605,
    clientLocationId: 15,
    deferTargets: true
  });
  assert.equal(deferred.canonicalLocationId, 15);
  assert.equal(deferred.localOnly, false);
  assert.deepEqual(deferred.targets, []);
  await assert.rejects(
    deferred.materializeTargets(),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_NO_LINES"
  );
});

test("P4 production lineage adapter chooses SO, PO, TO, and split parents with the exact line offset", async () => {
  const calls = [];
  const resolveSource = createOperatorNetSuitePostingRealSourceResolver({
    query: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.includes("dispatch_scm_so_splits")) {return { rows: [{ source_id: 900, source_ref: "SOA900" }] };}
      if (sql.includes("dispatch_scm_to_splits")) {return { rows: [{ source_id: 901, source_ref: "TOB901" }] };}
      if (sql.includes("sales_order_lines")) {return { rows: [{ order_line: 1, location_id: 15 }] };}
      if (sql.includes("purchase_order_lines")) {return { rows: [{ order_line: 2, location_id: 28 }] };}
      if (sql.includes("transfer_order_lines")) {return { rows: [{ order_line: 3, location_id: null }] };}
      return { rows: [] };
    }
  });

  assert.deepEqual(await resolveSource(salesOrder({ id: 701 }), { functionKey: "delivery_prep" }), {
    sourceOrderKind: "SO", sourceNetSuiteId: 701, sourceOrderRef: "SOA101", availableLines: [{ orderLine: 1, location: 15 }]
  });
  assert.deepEqual(await resolveSource(purchaseOrder({ id: 702 }), { functionKey: "receiving" }), {
    sourceOrderKind: "PO", sourceNetSuiteId: 702, sourceOrderRef: "POB303", availableLines: [{ orderLine: 2, location: 28 }]
  });
  assert.deepEqual((await resolveSource(transferOrder({ id: 703 }), { functionKey: "delivery_prep" })).availableLines, [{ orderLine: 4, location: null }]);
  assert.deepEqual((await resolveSource(transferOrder({ id: 704 }), { functionKey: "receiving" })).availableLines, [{ orderLine: 3, location: null }]);

  const splitSo = salesOrder({ id: -11, ref: "SOA900-S1" });
  assert.equal((await resolveSource(splitSo, { functionKey: "delivery_prep" })).sourceNetSuiteId, 900);
  const splitTo = transferOrder({ id: -12, ref: "TOB901-S1" });
  assert.equal((await resolveSource(splitTo, { functionKey: "delivery_prep" })).sourceNetSuiteId, 901);
  assert.ok(calls.some(([sql]) => sql.includes("line_stage = $2")));
});

test("P4 production lineage and receiving adapters return null or local CO without guessing", async () => {
  const resolveSource = createOperatorNetSuitePostingRealSourceResolver({ query: async () => ({ rows: [] }) });
  assert.equal(await resolveSource(salesOrder({ id: -81 }), { functionKey: "delivery_prep" }), null);
  assert.equal(await resolveSource(salesOrder({ id: 0 }), { functionKey: "delivery_prep" }), null);

  const calls = [];
  const readReceivingOrder = createOperatorNetSuiteReceivingOrderReader({
    getLocalCoReceivingOrder: async (id) => { calls.push(["co", id]); return { id }; },
    getReceivableReceivingOrder: async (id) => { calls.push(["remote", id]); return { id }; }
  });
  assert.deepEqual(await readReceivingOrder("CO-81", "co_order"), { id: "CO-81" });
  assert.deepEqual(await readReceivingOrder(82, "purchase_order"), { id: 82 });
  assert.deepEqual(calls.map(([kind]) => kind), ["co", "remote"]);
});
