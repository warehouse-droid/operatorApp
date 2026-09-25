import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { buildReturnBatchIntent, buildReturnBatchPayload, verifyReturnBatchSnapshot } from "../../../src/return-batch-ra-domain.js";

function records(locationId = 28) {
  const base = { batchId: 4, batchReference: "RB-000004", customerId: 100, receivingLocationId: locationId,
    sourceSalesOrderId: 987342, sourceSalesOrderRef: "SOA08504", submittedDate: "2026-09-18", vehiclePlate: "TEST",
    status: "accepted", hasPendingApproval: false, note: "Return note" };
  return [{ ...base, id: 26, recordReference: "SR-000004", recordType: "stock", lines: [
    { sourceSalesOrderLineId: 4932267, netSuiteOrderLine: 1, itemId: 2874, returnedSalesQuantity: 18.18, rate: 0, reasonId: 6, salesUomId: 7 },
    { sourceSalesOrderLineId: 4932267, netSuiteOrderLine: 1, itemId: 2874, returnedSalesQuantity: 18.18, rate: 0, reasonId: 7, salesUomId: 7 },
    { sourceSalesOrderLineId: 4932267, netSuiteOrderLine: 1, itemId: 2874, returnedSalesQuantity: 9.09, rate: 0, reasonId: 8, salesUomId: 7 }
  ] }, { ...base, id: 27, recordReference: "PR-000001", recordType: "pallet", palletQuantity: 2, palletItemId: 1784, lines: [] }];
}

function snapshot(intent) {
  const payload = buildReturnBatchPayload(intent);
  return { ...payload, id: "400", tranId: "RMA00400", entity: { id: "100" }, createdFrom: { id: "987342" },
    status: { refName: "Pending Receipt" } };
}

test("B1 mixed return has one SO-linked payload retaining all three reasons and a PALLET row", () => {
  const intent = buildReturnBatchIntent(records());
  const payload = buildReturnBatchPayload(intent);
  assert.equal(intent.externalId, "MBBS-RB-000004");
  assert.deepEqual(intent.recordIds, [26, 27]);
  assert.equal(intent.sourceSalesOrderId, 987342);
  assert.equal(payload.item.items.length, 4);
  assert.deepEqual(payload.item.items.map(line => [line.item.id, line.quantity, line.rate, line.custcol_atlas_rc_so.id]), [
    ["2874", 18.18, 0, "6"], ["2874", 18.18, 0, "7"], ["2874", 9.09, 0, "8"], ["1784", 2, 40, "10"]
  ]);
  assert.deepEqual(payload.item.items.slice(0, 3).map(line => line.orderLine), [1, undefined, undefined]);
  assert.match(payload.item.items[1].description, /SO 987342.*source line 4932267.*reason 7/);
  assert.equal(payload.item.items[3].orderLine, undefined);
  assert.match(payload.memo, /SR-000004/);
  assert.match(payload.memo, /PR-000001/);
});

test("B2 header and every line use the operator receiving yard, independently of source order location", () => {
  for (const yard of [1, 28, 15, 26]) {
    const payload = buildReturnBatchPayload(buildReturnBatchIntent(records(yard)));
    assert.equal(payload.location.id, String(yard));
    assert.ok(payload.item.items.every(line => line.location.id === String(yard)));
  }
  for (const field of ["customerId", "receivingLocationId", "batchId", "sourceSalesOrderId"]) {
    const input = records();
    input[1][field] += 1;
    assert.throws(() => buildReturnBatchIntent(input), { code: "RETURN_BATCH_INTENT_INVALID" });
  }
});

test("B1 standalone stock and PALLET returns each produce a single correctly typed intent", () => {
  const [stock, pallet] = records();
  assert.equal(buildReturnBatchPayload(buildReturnBatchIntent([stock])).item.items.length, 3);
  const intent = buildReturnBatchIntent([pallet]);
  assert.equal(intent.sourceSalesOrderId, null);
  assert.equal(buildReturnBatchPayload(intent).entity.id, "100");
  assert.equal(buildReturnBatchPayload(intent).item.items.length, 1);
});

test("D2 exact readback accepts reordered rows and rejects identity, yard, quantity, reason, rate, units and missing RMA", () => {
  const intent = buildReturnBatchIntent(records());
  const valid = snapshot(intent);
  valid.item.items.reverse();
  assert.equal(verifyReturnBatchSnapshot(intent, valid).tranId, "RMA00400");
  const changes = [
    value => { value.entity.id = "101"; }, value => { value.location.id = "1"; },
    value => { value.externalId = "OTHER"; }, value => { value.createdFrom.id = "999"; },
    value => { value.item.items[1].quantity += 1; }, value => { value.item.items[1].rate = 1; },
    value => { value.item.items[1].custcol_atlas_rc_so.id = "10"; },
    value => { value.item.items[1].units.id = "9"; }, value => { value.item.items[1].location.id = "1"; },
    value => { value.item.items.pop(); }, value => { value.tranId = ""; },
    value => { value.status.refName = "Cancelled"; }, value => { value.item.items.find(line => line.orderLine === 1).orderLine = 2; },
    value => { value.item.items[1].description = "wrong source"; }
  ];
  for (const change of changes) {
    const invalid = structuredClone(valid);
    change(invalid);
    assert.throws(() => verifyReturnBatchSnapshot(intent, invalid), { code: "RETURN_RA_VERIFICATION_FAILED" });
  }
  const inactive = snapshot(intent);
  inactive.status.refName = "Cancelled";
  assert.doesNotThrow(() => verifyReturnBatchSnapshot(intent, inactive, { allowInactive: true }));
  assert.throws(() => verifyReturnBatchSnapshot({ ...intent, netSuiteTransactionId: 401 }, valid), { code: "RETURN_RA_VERIFICATION_FAILED" });
});

test("D2 generated mixed intents preserve all quantities and detect changes to either stock or pallet", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 1000 }),
    fc.integer({ min: 0, max: 10000 }), (stockQuantity, palletQuantity, cents) => {
      const input = records();
      input[0].lines[0].returnedSalesQuantity = stockQuantity / 1000;
      input[0].lines[0].rate = cents / 100;
      input[1].palletQuantity = palletQuantity;
      const intent = buildReturnBatchIntent(input);
      const actual = snapshot(intent);
      assert.doesNotThrow(() => verifyReturnBatchSnapshot(intent, actual));
      assert.equal(actual.item.items[0].quantity, stockQuantity / 1000);
      assert.equal(actual.item.items[3].quantity, palletQuantity);
      actual.item.items[3].quantity += 1;
      assert.throws(() => verifyReturnBatchSnapshot(intent, actual), { code: "RETURN_RA_VERIFICATION_FAILED" });
    }), { seed: 9182026, numRuns: 100 });
});
