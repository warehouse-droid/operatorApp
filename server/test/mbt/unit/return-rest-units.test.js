import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { buildReturnBatchPayload, verifyReturnBatchSnapshot } from "../../../src/return-batch-ra-domain.js";
import { buildReturnAuthorizationPayload } from "../../../src/return-netsuite.js";

function intent(unit = 483) {
  return { externalId: "MBBS-RB-000006", customerId: 10, receivingLocationId: 26,
    sourceSalesOrderId: 1006905, submittedDate: "2026-09-30", lines: [{ kind: "stock",
      sourceSalesOrderLineId: 4998676, netSuiteOrderLine: 1, itemId: 3026,
      returnedSalesQuantity: 71.47, rate: 3.98, reasonId: 6, salesUomId: unit }] };
}

test("U1 RA REST units are scalar native IDs, preserving source line, amount and rate", () => {
  const value = intent();
  for (const payload of [buildReturnBatchPayload(value), buildReturnAuthorizationPayload(value)]) {
    const row = payload.item.items[0];
    assert.equal(row.units, "483");
    assert.equal(row.orderLine, 1);
    assert.equal(row.quantity, 71.47);
    assert.equal(row.rate, 3.98);
  }
});

test("U2 unit verification accepts scalar readback and rejects a changed unit", () => {
  const value = intent();
  const snapshot = { ...buildReturnBatchPayload(value), id: 123, tranId: "RMA123",
    entity: { id: "10" }, createdFrom: { id: "1006905" } };
  for (const units of ["483", 483, { id: "483" }]) {
    snapshot.item.items[0].units = units;
    assert.equal(verifyReturnBatchSnapshot(value, snapshot), snapshot);
  }
  snapshot.item.items[0].units = "486";
  assert.throws(() => verifyReturnBatchSnapshot(value, snapshot), { code: "RETURN_RA_VERIFICATION_FAILED" });
});

test("U3 arbitrary native unit IDs remain scalar and mismatches fail", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 999999 }), unit => {
    const value = intent(unit);
    const payload = buildReturnBatchPayload(value);
    assert.equal(payload.item.items[0].units, String(unit));
    const snapshot = { ...payload, id: 123, tranId: "RMA123", entity: { id: "10" },
      createdFrom: { id: "1006905" } };
    assert.equal(verifyReturnBatchSnapshot(value, snapshot), snapshot);
    snapshot.item.items[0].units = String(unit + 1);
    assert.throws(() => verifyReturnBatchSnapshot(value, snapshot), { code: "RETURN_RA_VERIFICATION_FAILED" });
  }), { seed: 6642005, numRuns: 100 });
});
