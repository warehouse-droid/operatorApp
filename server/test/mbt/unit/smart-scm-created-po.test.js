import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectSmartScmCreatedPo } from "../../../src/smart-scm-created-po.js";

const original = {
  id: 34357, totalPallets: 23, vendor: "PERMACON", destinationName: "2967",
  lines: [
    { id: 119163, itemId: 4778, proposedPallets: 8, confirmedPallets: 8, salesQuantity: 746.24 },
    { id: 119182, itemId: 4775, proposedPallets: 5, confirmedPallets: 5, salesQuantity: 466.4 },
    { id: 119183, itemId: 5055, proposedPallets: 10, confirmedPallets: 10, salesQuantity: 420 }
  ],
  physicalPalletLines: [{ itemId: 1784, quantity: 23 }]
};
const row = (lineId, itemId, name, quantity, pallets, rate, amount, units, weight = 1) => ({
  line_id: lineId, item_id: itemId, item_name: name, quantity,
  pallet_qty: pallets, rate, amount, to_plt: units, item_weight: weight,
  location_id: 28, location: "2967", unit: itemId === 1784 ? "EACH" : "SQFT",
  netsuite_active: true, netsuite_closed: false
});
const current = {
  header: { netsuite_id: 991607, tranid: "POB03875", history_id: 55, vendor: "PERMACON", truck_capacity_lbs: 78000,
    status_text: "Purchase Order : Pending Receipt", vendor_reference: "UPDATED",
    expected_delivery_date: "2026-09-18", memo: "Updated in NetSuite", synced_at: "2026-09-15T14:42:52Z" },
  lines: [
    row(4953527, 4778, "PER-MEL80S-RDM-NG", 932.8, 10, 4.56, 4253.57, 93.28, 40.55),
    row(4953528, 4775, "PER-MEL80S-RDM-AB", 466.4, 5, 4.96, 2313.34, 93.28, 40.55),
    row(4953529, 4795, "PER-MEL60S-RDM-AB", 932.8, 8, 3.67, 3423.38, 116.6, 29.08),
    row(4953530, 1784, "PALLET", 23, 0, 35, 805, null, 40)
  ]
};

test("POB03875 reflects quantity changes, replacement items and the explicit PALLET line", () => {
  const before = structuredClone(original);
  const result = projectSmartScmCreatedPo(original, current);
  assert.deepEqual(result.lines.map((line) => [line.itemId, line.confirmedPallets, line.salesQuantity]), [
    [4778, 10, 932.8], [4775, 5, 466.4], [4795, 8, 932.8]
  ]);
  assert.equal(result.physicalPalletLines[0].quantity, 23);
  assert.equal(result.lines[2].purchaseAmount, 3423.38);
  assert.equal(result.totalPallets, 23);
  assert.equal(result.totalWeightLbs, 84783.384);
  assert.equal(result.materialWeightLbs, 83863.384);
  assert.equal(result.physicalPalletWeightLbs, 920);
  assert.ok(result.utilization > 1);
  assert.equal(result.vendorReference, "UPDATED");
  assert.equal(result.vendorReadyDate, "2026-09-18");
  assert.equal(result.purchaseOrderHistoryId, 55);
  assert.equal(result.currentPurchaseOrder, true);
  assert.deepEqual(original, before);
});

test("an empty mirror removes old lines; an unavailable mirror retains the proposal", () => {
  assert.deepEqual(projectSmartScmCreatedPo(original, { ...current, lines: [] }).lines, []);
  assert.deepEqual(projectSmartScmCreatedPo(original, null), original);
});

test("missing prices stay unknown and inactive rows stay absent", () => {
  const result = projectSmartScmCreatedPo(original, { ...current, lines: [
    { ...current.lines[0], rate: null, amount: null },
    { ...current.lines[1], netsuite_active: false }
  ] });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].lastPurchasePrice, null);
  assert.equal(result.lines[0].purchaseAmount, null);
  assert.equal(result.lines[0].confirmedPallets, 10);
});

test("missing weight and malformed financial metadata remain unknown", () => {
  const result = projectSmartScmCreatedPo(original, { ...current, lines: [
    { ...current.lines[0], rate: "invalid", amount: "", item_weight: null }
  ] });
  assert.equal(result.lines[0].lastPurchasePrice, null);
  assert.equal(result.lines[0].purchaseAmount, null);
  assert.equal(result.totalWeightLbs, null);
  assert.equal(result.utilization, null);
});

test("duplicate items, moved destinations, closed lines and absent pallet conversion retain their identity", () => {
  const result = projectSmartScmCreatedPo(original, { ...current, lines: [
    { ...current.lines[0], line_id: 100, pallet_qty: 0, to_plt: 0, netsuite_closed: true },
    { ...current.lines[0], line_id: 101, location_id: 1, location: "3445" }
  ] });
  assert.deepEqual(result.lines.map((line) => line.netsuitePurchaseOrderLineId), [100, 101]);
  assert.equal(result.lines[0].confirmedPallets, null);
  assert.equal(result.lines[0].netsuiteClosed, true);
  assert.equal(result.lines[1].destinationLocationId, 1);
  assert.equal(result.destinationName, "2967, 3445");
});

test("projection is idempotent and conserves every active NetSuite line and native quantity", () => {
  fc.assert(fc.property(fc.array(fc.record({
    quantity: fc.integer({ min: 0, max: 100000 }),
    netsuite_active: fc.boolean(),
    item_id: fc.integer({ min: 1, max: 20 })
  }), { maxLength: 30 }), (input) => {
    const snapshot = { ...current, lines: input.map((line, i) => ({
      ...row(i + 1, line.item_id, "Material", line.quantity, 0, 2, line.quantity * 2, 10),
      ...line
    })) };
    const result = projectSmartScmCreatedPo(original, snapshot);
    assert.deepEqual(result.lines.map((line) => [line.netsuitePurchaseOrderLineId, line.salesQuantity]),
      snapshot.lines.filter((line) => line.netsuite_active).map((line) => [line.line_id, line.quantity]));
    assert.deepEqual(projectSmartScmCreatedPo(result, snapshot), result);
  }), { numRuns: 150, seed: 3875 });
});
