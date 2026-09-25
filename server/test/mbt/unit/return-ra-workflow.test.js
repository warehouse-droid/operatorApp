import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { confirmedReturnPolicy, buildPalletReturnAuthorizationPayload,
  verifyReturnAuthorizationSnapshot, remainingPalletReservation } from "../../../src/return-ra-workflow.js";
import { materializeOperatorNetSuitePostingPolicy } from "../../../src/operator-netsuite-posting-policy.js";

const stock = () => ({ workflowVersion: 2, recordType: "stock", externalId: "MBBS-SR-1",
  customerId: 7, sourceSalesOrderId: 8, receivingLocationId: 28,
  lines: [
    { netSuiteOrderLine: 2, itemId: 11, returnedSalesQuantity: 2, rate: 12.5, reasonId: 5 },
    { netSuiteOrderLine: 2, itemId: 11, returnedSalesQuantity: 3, rate: 12.5, reasonId: 7 }
  ] });
const snapshot = (record = stock()) => ({ id: "44", externalId: record.externalId,
  entity: { id: "7" }, createdFrom: { id: "8" }, location: { id: "28" }, status: { refName: "Pending Receipt" },
  item: { items: record.lines.map((line, index) => ({ line: index + 1, orderLine: line.netSuiteOrderLine,
    item: { id: String(line.itemId) }, quantity: line.returnedSalesQuantity, rate: line.rate,
    custcol_atlas_rc_so: { id: String(line.reasonId) } })) } });

test("G1/G2 all eight RA policies resolve independently and obey the direct-access ceiling", () => {
  for (const [locationId, yard] of [[1, "3445"], [28, "2967"], [15, "12441"], [26, "150"]]) {
    for (const kind of ["stock", "pallet"]) {
      const input = { functionKey: `${kind}_return`, locationId, flag: { enabled: true, revision: 3 } };
      const enabled = materializeOperatorNetSuitePostingPolicy({ ...input, directAccessEnabled: true });
      assert.equal(enabled.gateKey, `operator_netsuite_${kind}_return_ra_${yard}`);
      assert.equal(enabled.transactionType, "RA");
      assert.equal(enabled.effective, true);
      assert.equal(materializeOperatorNetSuitePostingPolicy({ ...input, directAccessEnabled: false }).effective, false);
    }
  }
});

test("V1 confirmation removes approval only for the new workflow and keeps blocked policy", () => {
  const policy = { effective: "APPROVAL_REQUIRED", default: "APPROVAL_REQUIRED", override: null, source: "DEFAULT" };
  assert.equal(confirmedReturnPolicy(policy, 2).effective, "ALLOWED");
  assert.equal(confirmedReturnPolicy(policy, 1).effective, "APPROVAL_REQUIRED");
  assert.equal(confirmedReturnPolicy({ effective: "NOT_RETURNABLE" }, 2).effective, "NOT_RETURNABLE");
  assert.equal(policy.effective, "APPROVAL_REQUIRED");
});

test("R2 pallet RA retains customer, yard, quantity, rate and GD reason", () => {
  const payload = buildPalletReturnAuthorizationPayload({ customerId: 7, palletItemId: 12,
    receivingLocationId: 28, palletQuantity: 4, externalId: "MBBS-PR-1", submittedDate: "2026-09-17", memo: "PR-1" });
  assert.deepEqual(payload, { entity: { id: "7" }, location: { id: "28" }, externalId: "MBBS-PR-1",
    tranDate: "2026-09-17", memo: "PR-1", item: { items: [
      { item: { id: "12" }, quantity: 4, rate: 40, custcol_atlas_rc_so: { id: "10" } }
    ] } });
});

test("R1/R3 one RA verifies two separately reason-coded rows from the same source line", () => {
  assert.equal(verifyReturnAuthorizationSnapshot(stock(), snapshot()).id, "44");
  const reversed = snapshot(); reversed.item.items.reverse();
  assert.equal(verifyReturnAuthorizationSnapshot(stock(), reversed).id, "44");
});

test("R3 source units and the discovered RA identity must survive readback", () => {
  const record = stock();
  record.netsuiteTransactionId = 44;
  for (const line of record.lines) {line.salesUomId = 3;}
  const actual = snapshot(record);
  for (const line of actual.item.items) {line.units = { id: "3" };}
  assert.equal(verifyReturnAuthorizationSnapshot(record, actual).id, "44");
  actual.item.items[1].units.id = "1";
  assert.throws(() => verifyReturnAuthorizationSnapshot(record, actual), { code: "RETURN_RA_VERIFICATION_FAILED" });
  actual.item.items[1].units.id = "3";
  actual.id = "45";
  assert.throws(() => verifyReturnAuthorizationSnapshot(record, actual), { code: "RETURN_RA_VERIFICATION_FAILED" });
});

test("R3 merged/missing/extra/reason-changed rows and wrong identities cannot report success", () => {
  const changes = [
    s => { s.item.items[0].quantity = 5; s.item.items.pop(); },
    s => { s.item.items.push({ ...s.item.items[0], line: 3 }); },
    s => { s.item.items[1].custcol_atlas_rc_so.id = "5"; },
    s => { s.item.items[1].orderLine = 3; },
    s => { s.item.items[1].rate = null; },
    s => { s.entity.id = "9"; }, s => { s.location.id = "1"; },
    s => { s.createdFrom.id = "9"; }, s => { s.externalId = "unrelated"; },
    s => { s.status.refName = "Cancelled"; }
  ];
  for (const change of changes) {
    const actual = snapshot(); change(actual);
    assert.throws(() => verifyReturnAuthorizationSnapshot(stock(), actual), { code: "RETURN_RA_VERIFICATION_FAILED" });
  }
});

test("Q1 partial observed credits release only their PALLET quantity from the RA reservation", () => {
  const record = { palletQuantity: 10, netSuiteTransactionId: 44 };
  const credits = [ { returnAuthorizationId: 44, transactionId: 71, quantity: 3 },
    { returnAuthorizationId: 44, transactionId: 72, quantity: 2 },
    { returnAuthorizationId: 55, transactionId: 73, quantity: 7 } ];
  assert.equal(remainingPalletReservation(record, credits, [71, 73]), 7);
  assert.equal(remainingPalletReservation(record, credits, [71, 72, 73]), 5);
  assert.equal(remainingPalletReservation(record, credits, []), 10);
});

test("property: verified split rows conserve quantities and reject a changed reason", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 }), (left, right) => {
    const record = stock(); record.lines[0].returnedSalesQuantity = left; record.lines[1].returnedSalesQuantity = right;
    assert.equal(verifyReturnAuthorizationSnapshot(record, snapshot(record)).id, "44");
    const bad = snapshot(record); bad.item.items[1].custcol_atlas_rc_so.id = "6";
    assert.throws(() => verifyReturnAuthorizationSnapshot(record, bad));
  }), { numRuns: 100, seed: 91726 });
});

test("property: credited plus reserved equals the return quantity until fully credited", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 10000 }), (quantity, credited) => {
    const reserved = remainingPalletReservation({ palletQuantity: quantity, netSuiteTransactionId: 44 },
      [{ returnAuthorizationId: 44, transactionId: 71, quantity: credited }], [71]);
    assert.equal(reserved, Math.max(0, quantity - credited));
  }), { numRuns: 100, seed: 91727 });
});
