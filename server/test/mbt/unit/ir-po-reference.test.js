import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fc from "fast-check";
import { buildOperatorNetSuitePostingDraft, stableCanonicalJson } from "../../../src/operator-netsuite-posting-domain.js";
import { createOperatorNetSuitePostingTargetResolver } from "../../../src/operator-netsuite-posting-targets.js";
import { createOperatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";

const requestId = "8abc5871-69b7-4b19-82f1-ac28180120e8";
const selections = [[15, 1305.6], [18, 629.46], [23, 930], [38, 32]];

function target(memo = "SN1400333", sourceOrderKind = "PO") {
  return { sourceOrderKind, sourceNetSuiteId: 936958, sourceOrderRef: "POB03658", memo,
    selectedLines: selections.map(([orderLine, quantity]) => ({ orderLine, quantity, location: 1,
      localOrderKey: "receiving:split", localLineId: String(-orderLine) })),
    availableLines: [...selections.map(([orderLine]) => ({ orderLine, location: 1, remainingQuantity: 5000 })),
      { orderLine: 2, location: 1, remainingQuantity: 1 }, { orderLine: 9, location: 1, remainingQuantity: 0 }] };
}

function input(targets = [target()], transactionType = "IR") {
  const functionKey = transactionType === "IR" ? "receiving" : "delivery_prep";
  return { requestId, actorOperatorId: "reference-test", functionKey, transactionType,
    policy: { gateKey: `operator_netsuite_${functionKey}_${transactionType.toLowerCase()}_3445`,
      revision: 1, effective: true, functionKey, transactionType, locationId: 1, yardCode: "3445" },
    localOrderKeys: ["receiving:split"], photoRefs: [], targets,
    localOperation: { kind: transactionType === "IR" ? "receiving_receipt" : "delivery_prep_load",
      orderId: "-74756816273767", orderType: transactionType === "IR" ? "purchase_order" : "sales_order" } };
}

function receipt(memo, kind = "PO") {
  return buildOperatorNetSuitePostingDraft(input([target(memo, kind)]));
}

async function resolvedReceipt(reference, id) {
  const lines = selections.map(([orderLine, quantity]) => ({ id: -orderLine, line_id: orderLine,
    item_type: "InvtPart", netsuite_active: true, quantity, received_sales_qty: quantity,
    location_id: 1, netsuite_received_qty: 0, netsuite_received_baseline_qty: 0 }));
  const order = { netsuite_id: id, tranid: reference, order_type: "purchase_order",
    memo: "Vendor memo must not replace PO reference", destination_location_id: 1, lines, receivableLines: lines };
  const resolve = createOperatorNetSuitePostingTargetResolver({
    getDeliveryOrder: async () => null, getReceivableReceivingOrder: async () => order,
    resolveRealSource: async () => target() });
  return buildOperatorNetSuitePostingDraft({ ...input(),
    ...await resolve({ functionKey: "receiving", orderId: id, clientLocationId: 1 }) });
}

test("split and normal PO references reach both Memo and Ref No through resolver, draft and adapter", async () => {
  for (const [reference, id] of [["SN1400333", -74756816273767], ["POB03658", 936958]]) {
    const draft = await resolvedReceipt(reference, id);
    const calls = [];
    const unexpected = async () => { throw new Error("Unexpected NetSuite boundary"); };
    const adapter = createOperatorNetSuitePostingAdapter({ findTransactionByExternalId: unexpected,
      transformSalesOrderToItemFulfillment: unexpected, transformTransferOrderToItemFulfillment: unexpected,
      transformTransferOrderToItemReceipt: unexpected, fetchItemFulfillment: unexpected, fetchItemReceipt: unexpected,
      transformPurchaseOrderToItemReceipt: async (parent, payload) => { calls.push({ parent, payload }); return { id: 123 }; } });
    await adapter.transform(draft.steps[0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parent, 936958);
    assert.equal(draft.steps[0].sourceOrderRef, "POB03658");
    assert.equal(calls[0].payload.memo, reference);
    assert.equal(calls[0].payload.custbody9, reference);
    assert.deepEqual(calls[0].payload.item.items.filter(line => line.itemReceive).map(line => [line.orderLine, line.quantity]), selections);
    assert.deepEqual(calls[0].payload.item.items.find(line => line.orderLine === 2), { orderLine: 2, location: 1, itemReceive: false });
    assert.equal(calls[0].payload.item.items.some(line => line.orderLine === 9), false);
  }
});

test("receipt fields normalize together, omit blank values, and leave IF untouched", () => {
  for (const kind of ["PO", "TO"]) {
    const draft = receipt("  SN1400333\n", kind);
    assert.equal(draft.steps[0].payload.memo, "SN1400333");
    assert.equal(draft.steps[0].payload.custbody9, "SN1400333");
    for (const memo of [null, "", "   "]) {
      const payload = receipt(memo, kind).steps[0].payload;
      assert.equal(Object.hasOwn(payload, "memo"), false);
      assert.equal(Object.hasOwn(payload, "custbody9"), false);
    }
  }
  for (const kind of ["SO", "TO"]) {
    const payload = buildOperatorNetSuitePostingDraft(input([{ ...target("injected", kind), custbody9: "injected" }], "IF")).steps[0].payload;
    assert.equal(Object.hasOwn(payload, "memo"), false);
    assert.equal(Object.hasOwn(payload, "custbody9"), false);
    assert.equal(payload.item.items.length, 6);
  }
});

test("both receipt fields participate in immutable hashes and same-parent conflict checks", () => {
  const first = receipt("SN1400333"), second = receipt("SN1400334");
  assert.notEqual(first.inputHash, second.inputHash);
  assert.notEqual(first.steps[0].payloadHash, second.steps[0].payloadHash);
  for (const draft of [first, second]) {
    const step = draft.steps[0];
    assert.equal(step.payload.custbody9, step.payload.memo);
    assert.equal(step.payloadHash, createHash("sha256").update(stableCanonicalJson(step.payload)).digest("hex"));
    const { custbody9: _reference, ...withoutReference } = step.payload;
    assert.notEqual(step.payloadHash, createHash("sha256").update(stableCanonicalJson(withoutReference)).digest("hex"));
  }
  assert.throws(() => buildOperatorNetSuitePostingDraft(input([target("SN1400333"), target("SN1400334")])),
    { code: "OPERATOR_NETSUITE_POSTING_INPUT_INVALID" });
  const grouped = buildOperatorNetSuitePostingDraft(input([target(null), target()]));
  const reversed = buildOperatorNetSuitePostingDraft(input([target(), target(null)]));
  assert.equal(grouped.inputHash, reversed.inputHash);
  assert.equal(grouped.steps[0].payload.custbody9, "SN1400333");
  assert.equal(grouped.steps[0].payload.item.items.find(line => line.orderLine === 15).quantity, 2611.2);
});

test("property: arbitrary receiving references mirror exactly without affecting source, lines or IF", () => {
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 120 }),
    fc.constantFrom('SN"},"item":{"items":[]}', "<script>SN1400333</script>", "SN\n1400333", "SN雪🔔1400333")),
  fc.constantFrom("PO", "TO"), (reference, kind) => {
    const draft = buildOperatorNetSuitePostingDraft(input([{ ...target(reference, kind), custbody9: "hostile override" }]));
    const step = draft.steps[0], payload = JSON.parse(JSON.stringify(step.payload));
    assert.equal(step.sourceNetSuiteId, 936958);
    assert.equal(step.sourceOrderRef, "POB03658");
    assert.equal(payload.externalId, `MBBS-OP-${requestId}-1`);
    if (reference.trim()) {
      assert.equal(payload.memo, reference.trim());
      assert.equal(payload.custbody9, reference.trim());
    } else {
      assert.equal(Object.hasOwn(payload, "memo"), false);
      assert.equal(Object.hasOwn(payload, "custbody9"), false);
    }
    assert.deepEqual(payload.item.items.filter(line => line.itemReceive).map(line => [line.orderLine, line.quantity]), selections);
    const fulfillment = buildOperatorNetSuitePostingDraft(input([target(reference, "TO")], "IF")).steps[0].payload;
    assert.equal(Object.hasOwn(fulfillment, "custbody9"), false);
    assert.equal(Object.hasOwn(fulfillment, "memo"), false);
  }), { seed: 14634, numRuns: 200 });
});
