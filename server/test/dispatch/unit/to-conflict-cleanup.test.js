import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectAuthoritativeTransferLines } from "../../../tools/to-conflict-domain.mjs";
import { projectTransferCleanup } from "../../../tools/to-cleanup-domain.mjs";

const timestamp = "2026-09-15T18:50:00.000Z";
const order = { netsuite_id: "965944", tranid: "TOB00956" };
const local = (stage, quantity = 1120) => ({ id: stage === "outbound" ? "1" : "2", transfer_order_id: order.netsuite_id,
  line_stage: stage, line_id: stage === "outbound" ? "101" : "103", item_id: "599", item_name: "Alliance Supersand Grey",
  quantity: String(quantity), unit: "EACH", item_type: "InvtPart", pallet_qty: "16", to_plt: "70", netsuite_active: false,
  sync_exception: "line_deleted", sync_exception_at: timestamp, loaded_qty: 0, loaded_uom: "EACH", netsuite_received_qty: 0,
  confirmed: true, confirmed_at: "2026-08-27T12:00:00.000Z", confirmed_by: "preserve", fulfilled_pallet_qty: "3",
  packed_pallet_qty: 1, packed_sales_qty: 0, received_pallet_qty: 2, received_sales_qty: 0 });
const remoteLine = (stage, quantity = 840) => ({ stage, sourceLineKey: stage === "outbound" ? "101" : "103",
  sourceLineAliases: stage === "outbound" ? ["101", "102"] : ["103"], logicalLineIdentity: "transfer-anchor:101",
  identityStatus: "exact", identityIssue: "", itemId: 599, itemName: "Alliance Supersand Grey", itemType: "InvtPart",
  itemDescription: "70 bags / pallet", quantity, unit: "EACH", palletQty: quantity / 70, layerQty: 0, sectionQty: 0, pieceQty: 0,
  toPlt: 70, toLyr: 0, toSec: 0, toPcs: 1, cumulativeProgressQuantity: quantity, locationId: stage === "outbound" ? 1 : 28,
  location: stage === "outbound" ? "3445" : "2967", raw: { source: "verified" } });
const proof = (quantity = 840) => ({ id: 965944, tranid: order.tranid, kind: "TO", recordType: "TrnfrOrd", status: "G", statusText: "Transfer Order : Received",
  lines: [remoteLine("outbound", quantity), remoteLine("receiving", quantity)] });

test("TOB00956 uses NetSuite 840 EACH and reactivates the deleted Receiving line", () => {
  const before = [local("outbound", 840), local("receiving")], original = structuredClone(before);
  const result = projectAuthoritativeTransferLines(order, before, proof(), timestamp);
  assert.deepEqual(before, original);
  const receipt = result.find(row => row.line_stage === "receiving");
  assert.equal(Number(receipt.quantity), 840); assert.equal(Number(receipt.pallet_qty), 12);
  assert.equal(receipt.netsuite_active, true); assert.equal(receipt.sync_exception, null);
  assert.equal(receipt.netsuite_received_qty, 840); assert.equal(receipt.received_pallet_qty, 0);
  assert.equal(receipt.confirmed_at, original[1].confirmed_at); assert.equal(receipt.confirmed_by, "preserve");
  assert.equal(receipt.fulfilled_pallet_qty, "3");
});

test("canonical source rows replace duplicate accounting rows without doubling quantities", () => {
  const source = local("outbound"), mirror = { ...local("outbound"), id: "3", line_id: "102", netsuite_active: true };
  const result = projectAuthoritativeTransferLines(order, [source, mirror, local("receiving")], proof(), timestamp);
  const active = result.filter(row => row.netsuite_active && row.line_stage === "outbound");
  assert.equal(active.length, 1); assert.equal(active[0].id, "1"); assert.equal(Number(active[0].quantity), 840);
  const retired = result.find(row => row.id === "3");
  assert.equal(retired.netsuite_active, false); assert.equal(retired.sync_exception, null); assert.equal(retired.packed_pallet_qty, 0);
});

test("missing exact source and destination lines are represented once for atomic insertion", () => {
  const result = projectAuthoritativeTransferLines(order, [], proof(), timestamp);
  assert.equal(result.length, 2); assert.equal(new Set(result.map(row => row.id)).size, 2);
  assert(result.every(row => row.id.startsWith("new:")));
  assert(result.every(row => Number(row.quantity) === 840 && row.netsuite_active));
});

test("partial status, wrong identities, ambiguous mirrors and invalid quantities reject authority", () => {
  for (const invalid of [{ ...proof(), status: "B" }, { ...proof(), tranid: "TO-OTHER" }, { ...proof(), id: 1 },
    { ...proof(), lines: [] }, { ...proof(), lines: [{ ...remoteLine("outbound"), identityStatus: "ambiguous" }, remoteLine("receiving")] },
    { ...proof(), lines: [remoteLine("outbound", -1), remoteLine("receiving", -1)] },
    { ...proof(), lines: [remoteLine("outbound"), remoteLine("outbound"), remoteLine("receiving")] }]) {
    assert.throws(() => projectAuthoritativeTransferLines(order, [local("outbound"), local("receiving")], invalid, timestamp));
  }
});

test("property: exact NetSuite quantities win, receipt evidence is stage-isolated, and repair is idempotent", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 20000 }), fc.boolean(), (quantity, stale, shippedOnly) => {
    const remote = proof(quantity);
    if (shippedOnly) { remote.status = "F"; remote.statusText = "Transfer Order : Pending Receipt"; remote.lines[1].cumulativeProgressQuantity = 0; }
    const before = [local("outbound", stale), local("receiving", stale)];
    const corrected = projectAuthoritativeTransferLines(order, before, remote, timestamp);
    for (const row of corrected) assert.equal(Number(row.quantity), quantity);
    assert.equal(corrected.find(row => row.line_stage === "outbound").netsuite_received_qty, before[0].netsuite_received_qty);
    assert.equal(corrected.find(row => row.line_stage === "receiving").loaded_qty, before[1].loaded_qty);
    assert.equal(corrected.find(row => row.line_stage === "receiving").netsuite_received_qty, shippedOnly ? 0 : quantity);
    assert.equal(corrected.find(row => row.line_stage === "outbound").packed_pallet_qty, 0);
    assert.equal(corrected.find(row => row.line_stage === "receiving").received_pallet_qty, shippedOnly ? 2 : 0);
    assert.deepEqual(projectAuthoritativeTransferLines(order, corrected, remote, timestamp), corrected);
    const result = projectTransferCleanup({ ...order, receiving_status: "not_received" }, corrected,
      { verified: { ...remote, status_text: remote.statusText }, identityCount: 1, sourceIdentityCount: 1 });
    assert(result.eligible); assert.equal(result.order.receiving_status, shippedOnly ? "not_received" : "received");
    assert.equal(result.lines.find(row => row.line_stage === "outbound").loaded_qty, quantity);
  }), { numRuns: 240, seed: 20260915 });
});

test("property: duplicate accounting rows remain inactive and never add cargo", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.boolean(), (quantity, reverse) => {
    const lines = [local("outbound"), { ...local("outbound"), id: "3", line_id: "102", netsuite_active: true }, local("receiving")];
    const result = projectAuthoritativeTransferLines(order, reverse ? lines.reverse() : lines, proof(quantity), timestamp);
    const active = result.filter(row => row.netsuite_active);
    assert.equal(active.length, 2); assert.equal(active.filter(row => row.line_stage === "outbound").length, 1);
    assert(active.every(row => Number(row.quantity) === quantity));
    const duplicate = result.find(row => row.id === "3"); assert.equal(duplicate.netsuite_active, false); assert.equal(duplicate.packed_pallet_qty, 0);
  }), { numRuns: 200, seed: 20260915 });
});

test("property: partial NetSuite states never authorize the conflict correction", () => {
  fc.assert(fc.property(fc.constantFrom("B", "C", "D", "E", "H"), fc.integer({ min: 1, max: 5000 }), (status, quantity) => {
    const remote = { ...proof(quantity), status };
    assert.throws(() => projectAuthoritativeTransferLines(order, [local("outbound"), local("receiving")], remote, timestamp), /shipment/);
  }), { numRuns: 100, seed: 20260915 });
});
