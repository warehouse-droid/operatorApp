import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fc from "fast-check";
import { buildOperatorNetSuitePostingDraft, stableCanonicalJson } from "../../../src/operator-netsuite-posting-domain.js";
import {
  createOperatorNetSuitePostingLiveSourceFetcher,
  createOperatorNetSuitePostingRealSourceResolver,
  createOperatorNetSuitePostingTargetResolver
} from "../../../src/operator-netsuite-posting-targets.js";
import { createOperatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";

const requestId = "f9f45e36-c256-4d33-b4e0-9c97c97a4b82";
const splitId = -74756816273767;
const orderKey = `receiving:purchase_order:${splitId}`;
const selections = [[15, 1305.6], [18, 629.46], [23, 930], [38, 32]];
const completed = [9, 16, 20, 29, 37];

function available(orderLine, orderedQuantity = 4000, completedQuantity = 0) {
  return { orderLine, sourceLineKey: String(4724987 + orderLine), location: 1,
    orderedQuantity, completedQuantity, remainingQuantity: orderedQuantity - completedQuantity };
}

function selected(orderLine, quantity) {
  return { orderLine, quantity, location: 1, localOrderKey: orderKey,
    localLineId: String(-orderLine), sourceLineKey: String(4724987 + orderLine) };
}

function target(overrides = {}) {
  return { sourceOrderKind: "PO", sourceNetSuiteId: 936958, sourceOrderRef: "POB03658",
    memo: "SN1400333", selectedLines: selections.map(([line, quantity]) => selected(line, quantity)),
    availableLines: Array.from({ length: 39 }, (_, index) => {
      const line = index === 38 ? 63 : index + 1;
      return available(line, 4000, completed.includes(line) ? 4000 : 0);
    }), ...overrides };
}

function input(targets = [target()], transactionType = "IR") {
  const receiving = transactionType === "IR";
  const functionKey = receiving ? "receiving" : "delivery_prep";
  return { requestId, actorOperatorId: "receiving-test", functionKey, transactionType,
    policy: { gateKey: `operator_netsuite_${functionKey}_${transactionType.toLowerCase()}_3445`,
      revision: 1, effective: true, functionKey, transactionType, locationId: 1, yardCode: "3445" },
    localOrderKeys: [orderKey], photoRefs: [], targets,
    localOperation: { kind: receiving ? "receiving_receipt" : "delivery_prep_load",
      orderId: String(splitId), orderType: receiving ? "purchase_order" : "transfer_order" } };
}

test("SN1400333 omits the five completed PO lines and explicitly deselects every other open line", () => {
  const draft = buildOperatorNetSuitePostingDraft(input());
  const step = draft.steps[0];
  assert.equal(step.sourceNetSuiteId, 936958);
  assert.equal(step.sourceOrderRef, "POB03658");
  const expected = target().availableLines.filter(line => !completed.includes(line.orderLine)).map(line => {
    const selection = selections.find(([id]) => id === line.orderLine);
    return { orderLine: line.orderLine, location: 1, itemReceive: Boolean(selection),
      ...(selection ? { quantity: selection[1] } : {}) };
  });
  assert.equal(step.payload.item.items.length, 34);
  assert.deepEqual(step.payload.item.items, expected);
});

test("receipt memo survives canonical payload construction and changes both immutable hashes", () => {
  const first = buildOperatorNetSuitePostingDraft(input());
  const second = buildOperatorNetSuitePostingDraft(input([target({ memo: "SN1400334" })]));
  assert.equal(first.steps[0].payload.memo, "SN1400333");
  assert.equal(second.steps[0].payload.memo, "SN1400334");
  assert.notEqual(first.inputHash, second.inputHash);
  assert.notEqual(first.steps[0].payloadHash, second.steps[0].payloadHash);
  assert.equal(first.steps[0].payloadHash,
    createHash("sha256").update(stableCanonicalJson(first.steps[0].payload)).digest("hex"));
});

test("a completed selected line stays in reconciliation but is absent from a partial receipt", () => {
  const draft = buildOperatorNetSuitePostingDraft(input([target({
    selectedLines: [selected(9, 2), selected(15, 1305.6)]
  })]));
  assert.equal(draft.steps[0].payload.item.items.some(line => line.orderLine === 9), false);
  const evidence = draft.lineReconciliation.lines.find(line => line.orderLine === 9);
  assert.equal(evidence.postedQuantity, 0);
  assert.equal(evidence.reconciledQuantity, 2);
  assert.equal(evidence.requestedQuantity, 2);
  const allCompleted = buildOperatorNetSuitePostingDraft(input([target({ selectedLines: [selected(9, 2)] })]));
  assert.equal(allCompleted.steps.length, 0);
  assert.equal(allCompleted.lineReconciliation.lines[0].reconciledQuantity, 2);
});

test("conflicting shipment memo references for one receipt parent are rejected", () => {
  assert.throws(() => buildOperatorNetSuitePostingDraft(input([
    target(), target({ memo: "SN1400334" })
  ])), { code: "OPERATOR_NETSUITE_POSTING_INPUT_INVALID" });
});

test("identical and blank receipt memos aggregate deterministically without a blank memo field", () => {
  const same = buildOperatorNetSuitePostingDraft(input([target(), target()]));
  assert.equal(same.steps[0].payload.memo, "SN1400333");
  assert.equal(same.steps[0].payload.item.items.find(line => line.orderLine === 15).quantity, 2611.2);
  for (const memo of [undefined, null, "", "   "]) {
    const single = buildOperatorNetSuitePostingDraft(input([target({ memo })]));
    assert.equal(Object.hasOwn(single.steps[0].payload, "memo"), false);
    const withMemo = buildOperatorNetSuitePostingDraft(input([target({ memo }), target()]));
    const reversed = buildOperatorNetSuitePostingDraft(input([target(), target({ memo })]));
    assert.equal(withMemo.steps[0].payload.memo, "SN1400333");
    assert.equal(withMemo.inputHash, reversed.inputHash);
  }
});

test("unknown receipt remaining quantities and fulfillment deselections preserve existing behavior", () => {
  const unknown = available(7);
  delete unknown.remainingQuantity;
  const receipt = buildOperatorNetSuitePostingDraft(input([target({
    availableLines: [unknown, available(8)], selectedLines: [selected(8, 2)]
  })]));
  assert.deepEqual(receipt.steps[0].payload.item.items, [
    { orderLine: 7, itemReceive: false, location: 1 },
    { orderLine: 8, itemReceive: true, quantity: 2, location: 1 }
  ]);
  for (const sourceOrderKind of ["SO", "TO"]) {
    const fulfillment = buildOperatorNetSuitePostingDraft(input([target({ sourceOrderKind })], "IF"));
    assert.equal(fulfillment.steps[0].payload.item.items.length, 39);
    assert.equal(Object.hasOwn(fulfillment.steps[0].payload, "memo"), false);
  }
});

async function resolvedSplit(reference = "SN1400333") {
  const localLines = selections.map(([line, quantity]) => ({ id: -line, line_id: 4724987 + line,
    item_type: "InvtPart", netsuite_active: true, quantity, received_sales_qty: quantity,
    location_id: 1, netsuite_received_qty: 0, netsuite_received_baseline_qty: 0 }));
  const order = { netsuite_id: splitId, tranid: reference, order_type: "purchase_order",
    memo: "Original vendor PO memo", destination_location_id: 1, lines: localLines, receivableLines: localLines };
  const source = target();
  const fetchLiveSource = createOperatorNetSuitePostingLiveSourceFetcher({
    fetchReconciliationOrders: async ({ orderIds, kind }) => {
      assert.deepEqual(orderIds, [936958]);
      assert.equal(kind, "PO");
      return [{ id: 936958, kind: "PO", tranid: "POB03658", destinationLocationId: 1,
        lines: source.availableLines.map(line => ({ ...line, quantity: line.orderedQuantity,
          cumulativeProgressQuantity: line.completedQuantity, stage: "receiving", identityStatus: "exact" })) }];
    },
    fetchSourceItemLines: async (kind, id) => {
      assert.equal(kind, "PO");
      assert.equal(id, 936958);
      return source.availableLines.map(line => ({ line: line.orderLine }));
    },
    fetchLinkedTransactions: async () => []
  });
  const resolveRealSource = createOperatorNetSuitePostingRealSourceResolver({ fetchLiveSource,
    query: async (sql, params) => {
      if (sql.includes("SELECT source_po_id AS source_id")) {
        assert.deepEqual(params, [splitId]);
        return { rows: [{ source_id: 936958, source_ref: "POB03658" }] };
      }
      assert.match(sql, /FROM purchase_order_lines/);
      assert.deepEqual(params, [936958, splitId]);
      return { rows: localLines.map(line => ({ source_line_key: line.line_id,
        local_line_key: line.line_id, local_line_id: line.id, location_id: 1 })) };
    } });
  const resolve = createOperatorNetSuitePostingTargetResolver({
    getDeliveryOrder: async () => null, getReceivableReceivingOrder: async () => order, resolveRealSource
  });
  return resolve({ functionKey: "receiving", orderId: splitId, clientLocationId: 1 });
}

test("stored SN1400333 travels through real lineage, draft and adapter as memo on source PO 936958", async () => {
  const resolution = await resolvedSplit();
  const draft = buildOperatorNetSuitePostingDraft({ ...input(), ...resolution });
  const calls = [];
  const unexpected = async () => { throw new Error("Unexpected remote boundary"); };
  const adapter = createOperatorNetSuitePostingAdapter({ findTransactionByExternalId: unexpected,
    transformSalesOrderToItemFulfillment: unexpected, transformTransferOrderToItemFulfillment: unexpected,
    transformTransferOrderToItemReceipt: unexpected, fetchItemFulfillment: unexpected, fetchItemReceipt: unexpected,
    transformPurchaseOrderToItemReceipt: async (id, payload) => { calls.push({ id, payload }); return { id: 123 }; } });
  await adapter.transform(draft.steps[0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 936958);
  assert.equal(calls[0].payload.memo, "SN1400333");
  assert.deepEqual(calls[0].payload.item.items.filter(line => line.itemReceive)
    .map(line => [line.orderLine, line.quantity]), selections);
  assert.equal(calls[0].payload.item.items.length, 34);
});

test("a missing stored receiving reference never substitutes the vendor PO memo", async () => {
  for (const reference of [null, "", "   "]) {
    const resolution = await resolvedSplit(reference);
    const draft = buildOperatorNetSuitePostingDraft({ ...input(), ...resolution });
    assert.equal(Object.hasOwn(draft.steps[0].payload, "memo"), false);
    assert.equal(draft.steps[0].sourceNetSuiteId, 936958);
  }
});

test("property: only eligible receipt lines are sent with exact quantities, identities and memo", () => {
  fc.assert(fc.property(fc.array(fc.record({
    quantity: fc.integer({ min: 1, max: 5000 }),
    remaining: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5000 })),
    receive: fc.boolean()
  }), { minLength: 1, maxLength: 20 }), fc.constantFrom("PO", "TO"),
  fc.string({ minLength: 1, maxLength: 30 }).filter(text => text.trim().length > 0), (values, sourceOrderKind, memo) => {
    const lines = values.map((value, index) => available(index * 3 + 1, 5000, 5000 - value.remaining));
    const selectedLines = values.flatMap((value, index) => value.receive ? [selected(index * 3 + 1, value.quantity)] : []);
    if (!selectedLines.length) { selectedLines.push(selected(1, values[0].quantity)); }
    const draft = buildOperatorNetSuitePostingDraft(input([target({ sourceOrderKind, memo,
      availableLines: lines, selectedLines })]));
    const expected = lines.filter(line => line.remainingQuantity > 0).map(line => {
      const selection = selectedLines.find(value => value.orderLine === line.orderLine);
      return { orderLine: line.orderLine, location: 1, itemReceive: Boolean(selection),
        ...(selection ? { quantity: Math.min(selection.quantity, line.remainingQuantity) } : {}) };
    });
    const hasPost = expected.some(line => line.itemReceive);
    assert.equal(draft.steps.length, hasPost ? 1 : 0);
    if (hasPost) {
      assert.equal(draft.steps[0].payload.memo, memo.trim());
      assert.equal(draft.steps[0].sourceNetSuiteId, 936958);
      assert.deepEqual(draft.steps[0].payload.item.items, expected);
    }
  }), { seed: 1400333, numRuns: 160 });
});
