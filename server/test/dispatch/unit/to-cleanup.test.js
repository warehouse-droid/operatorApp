import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectTransferCleanup, transferProof } from "../../../tools/to-cleanup-domain.mjs";
import { fulfilledTransferState, annotateFulfilledTransferOrders, isNetSuiteTransferFulfilled } from "../../../src/dispatch-fulfilled-to-policy.js";

const order = { netsuite_id: "1", tranid: "TO-TEST", status: "B", status_text: "Transfer Order : Pending Fulfillment", receiving_status: "not_received",
  outbound_operator_status: "open", local_yard_order_status: "Open", received_at: null, last_item_receipt_id: "receipt-preserve", fulfilled_at: null };
const line = stage => ({ id: "1", transfer_order_id: "1", line_stage: stage, item_type: "InvtPart", quantity: 40, unit: "EA", pallet_qty: 4,
  to_plt: 10, netsuite_active: true, loaded_qty: 0, loaded_uom: null, confirmed: true, netsuite_received_qty: 3,
  packed_pallet_qty: 1, packed_layer_qty: 0, packed_section_qty: 0, packed_piece_qty: 0, packed_sales_qty: 0,
  received_pallet_qty: 1, received_layer_qty: 0, received_section_qty: 0, received_piece_qty: 0, received_sales_qty: 0 });
const proof = status => ({ id: "1", tranid: "TO-TEST", status, status_text: `Transfer Order : ${status === "G" ? "Received" : "Pending Receipt"}` });
const options = status => ({ verified: proof(status), identityCount: 1, sourceIdentityCount: 1 });

test("TO shipment and receipt are distinct; local delivery does not reconcile NetSuite", () => {
  const lines = [line("outbound"), line("receiving")];
  const shipped = projectTransferCleanup(order, lines, options("F"));
  assert.equal(shipped.order.outbound_operator_status, "loaded");
  assert.equal(shipped.order.receiving_status, "not_received");
  assert.equal(shipped.lines[0].loaded_qty, 40);
  assert.deepEqual(shipped.lines[1], lines[1]);
  const received = projectTransferCleanup(order, lines, options("G"));
  assert.equal(received.order.receiving_status, "received");
  assert.equal(received.lines[1].netsuite_received_qty, 40);
  assert.equal(received.lines[1].received_pallet_qty, 0);
  assert.equal(received.lines[0].netsuite_received_qty, 3, "Outbound receipt fields are preserved");
  assert.equal(received.lines[1].loaded_qty, 0, "Receiving loaded fields are preserved");
  assert.equal(received.order.received_at, null);
  assert.equal(received.order.last_item_receipt_id, "receipt-preserve");
  const local = projectTransferCleanup(order, lines, { ...options("G"), locallyCompleted: true });
  assert.equal(local.order.status, "B"); assert.equal(local.order.status_text, order.status_text);
  assert.equal(local.order.receiving_status, "received", "Independent verified receipt may clean Receiving");
  assert.equal(local.addCompletion, false);
  const unreceivedLocal = projectTransferCleanup(order, lines, { identityCount: 1, sourceIdentityCount: 1, locallyCompleted: true });
  assert.equal(unreceivedLocal.order.outbound_operator_status, "loaded");
  assert.equal(unreceivedLocal.order.receiving_status, "not_received");
});

test("TO status, identity and active split authority are exact", () => {
  for (const status of ["B", "C", "D", "E", "H"]) {
    assert.equal(transferProof(order, options(status)), null);
    assert.equal(isNetSuiteTransferFulfilled(proof(status)), false);
  }
  for (const verified of [{ ...proof("G"), id: "2" }, { ...proof("G"), tranid: "TO-OTHER" }, { ...proof("F"), status_text: "Partially Fulfilled" }]) {
    assert.equal(transferProof(order, { verified }), null);
  }
  const child = { ...order, netsuite_id: "-1", tranid: "TO-TEST-S1" };
  const split = { source_to_id: "1", split_to_id: "-1", status: "active" };
  assert.equal(transferProof(child, { ...options("G"), parent: order, split }).inherited, true);
  assert.equal(transferProof(child, { ...options("G"), parent: order, split: { ...split, status: "cancelled" } }), null);
  assert.equal(transferProof(child, { ...options("G"), parent: order }), null);
});

test("unsafe drafts, units, identities and review flags skip the whole TO", () => {
  const cases = [
    [{ ...order, preparing_operator_id: "operator" }, [line("outbound")], options("G")],
    [order, [line("outbound")], { ...options("G"), claimed: true }],
    [order, [line("outbound")], { ...options("G"), identityCount: 2 }],
    [order, [line("outbound")], { ...options("G"), restricted: true }],
    [order, [{ ...line("outbound"), loaded_qty: 1, loaded_uom: "PLT" }], options("G")],
    [order, [{ ...line("receiving"), sync_exception: "line missing" }], options("G")]
  ];
  for (const [header, lines, input] of cases) {
    const result = projectTransferCleanup(header, lines, input);
    assert.equal(result.eligible, false); assert.ok(result.reasons.length);
    assert.deepEqual(result.order, header); assert.deepEqual(result.lines, lines);
  }
});

test("property: TO receipt projection is idempotent, stage-isolated and preserves overages", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 8000 }), fc.boolean(), (quantity, loaded, received) => {
    const lines = [line("outbound"), line("receiving")].map(value => ({ ...value, quantity, loaded_qty: loaded, loaded_uom: "EA" }));
    const before = structuredClone(lines), input = options(received ? "G" : "F");
    const result = projectTransferCleanup(order, lines, input);
    assert.deepEqual(lines, before);
    assert.equal(result.order.receiving_status, received ? "received" : "not_received");
    assert.equal(result.lines[0].loaded_qty, Math.max(quantity, loaded));
    assert.equal(result.lines[1].loaded_qty, loaded);
    assert.equal(result.lines[0].netsuite_received_qty, before[0].netsuite_received_qty);
    assert.equal(result.lines[1].netsuite_received_qty, received ? Math.max(quantity, 3) : 3);
    const again = projectTransferCleanup(result.order, result.lines, input);
    assert.deepEqual(again.order, result.order); assert.deepEqual(again.lines, result.lines);
  }), { numRuns: 400 });
});

test("property: only exact complete TO lifecycle status pairs prove fulfillment", () => {
  fc.assert(fc.property(fc.constantFrom("B", "C", "D", "E", "F", "G", "H"), fc.constantFrom("Received", "Pending Receipt", "Partially Fulfilled", "Pending Receipt/Partially Fulfilled"), (status, label) => {
    const expected = (status === "G" && label === "Received") || (status === "F" && label === "Pending Receipt");
    assert.equal(isNetSuiteTransferFulfilled({ status, status_text: `Transfer Order : ${label}` }), expected);
    assert.equal(Boolean(transferProof(order, { verified: { id: "1", tranid: "TO-TEST", status, status_text: `Transfer Order : ${label}` } })), expected);
  }), { numRuns: 240 });
});

test("property: current local delivery always blocks transfer and grouped transfer planning", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (driver, blocked, activeSplit) => {
    const state = fulfilledTransferState({ ...proof("G"), netsuite_id: "-1", identity_count: 1, source_identity_count: 1,
      split_status: activeSplit ? "active" : "cancelled", lifecycle_restricted: blocked }, { driverCompleted: driver });
    assert.equal(state.eligible, !driver && !blocked && activeSplit);
    const states = new Map([["to-1", state], ["to-2", { fulfilled: true, eligible: true }]]);
    const grouped = annotateFulfilledTransferOrders([{ id: "GTO-1-2", type: "TO", childOrders: ["TO-1", "TO-2"], dispatchFulfilledTransferPlanningEligible: true }], states)[0];
    assert.equal(grouped.dispatchFulfilledTransferPlanningEligible, state.eligible);
    if (driver) assert.equal(grouped.dispatchPlanningRestricted, true);
  }), { numRuns: 240 });
});
