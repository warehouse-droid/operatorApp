// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { findOperatorNetSuitePostingTransactionByExternalId } from "../../../src/netsuite.js";
import { createOperatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";
import {
  configureOperatorNetSuitePostingCompletionEvents,
  createOperatorNetSuitePostingFinalizer,
  publishOperatorNetSuitePostingCompletionEvents
} from "../../../src/operator-netsuite-posting-finalizer.js";

function sourceStep(sourceOrderKind, transactionType = "IF") {
  return {
    id: 1,
    sourceOrderKind,
    sourceNetSuiteId: 991,
    transactionType,
    externalId: "MBBS-OP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1",
    payload: { externalId: "MBBS-OP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1", item: { items: [] } }
  };
}

test("P1-P3 the runtime adapter selects only the allowed transform and read type", async () => {
  const calls = [];
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => null,
    transformSalesOrderToItemFulfillment: async (id, payload) => { calls.push(["so-if", id, payload]); return { id: 1 }; },
    transformTransferOrderToItemFulfillment: async (id, payload) => { calls.push(["to-if", id, payload]); return { id: 2 }; },
    transformPurchaseOrderToItemReceipt: async (id, payload) => { calls.push(["po-ir", id, payload]); return { id: 3 }; },
    transformTransferOrderToItemReceipt: async (id, payload) => { calls.push(["to-ir", id, payload]); return { id: 4 }; },
    fetchItemFulfillment: async (id) => ({ id, kind: "if" }),
    fetchItemReceipt: async (id) => ({ id, kind: "ir" })
  });
  assert.deepEqual(await adapter.transform(sourceStep("SO")), { id: 1 });
  assert.deepEqual(await adapter.transform(sourceStep("TO")), { id: 2 });
  assert.deepEqual(await adapter.transform(sourceStep("PO", "IR")), { id: 3 });
  assert.deepEqual(await adapter.transform(sourceStep("TO", "IR")), { id: 4 });
  assert.deepEqual(calls.map(([name, id]) => [name, id]), [
    ["so-if", 991], ["to-if", 991], ["po-ir", 991], ["to-ir", 991]
  ]);
  assert.deepEqual(await adapter.fetchById(sourceStep("SO"), 41), { id: 41, kind: "if" });
  assert.deepEqual(await adapter.fetchById(sourceStep("PO", "IR"), 42), { id: 42, kind: "ir" });
  await assert.rejects(
    adapter.transform(sourceStep("PO", "IF")),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_TRANSFORM_UNSUPPORTED"
  );
});

test("P6 the runtime adapter resolves an external ID into a complete readable record", async () => {
  const target = sourceStep("SO");
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => ({ id: "77", tranid: "IF77", externalid: target.externalId, createdfrom: 991 }),
    transformSalesOrderToItemFulfillment: async () => ({ id: 1 }),
    transformTransferOrderToItemFulfillment: async () => ({ id: 2 }),
    transformPurchaseOrderToItemReceipt: async () => ({ id: 3 }),
    transformTransferOrderToItemReceipt: async () => ({ id: 4 }),
    fetchItemFulfillment: async () => ({ id: 77, item: { items: [] } }),
    fetchItemReceipt: async () => ({ id: 78, item: { items: [] } })
  });
  assert.deepEqual(await adapter.findByExternalId(target), {
    id: 77,
    tranId: "IF77",
    externalId: target.externalId,
    createdFromId: 991,
    transactionType: "IF",
    item: { items: [] }
  });

  const missing = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => null,
    transformSalesOrderToItemFulfillment: async () => ({}),
    transformTransferOrderToItemFulfillment: async () => ({}),
    transformPurchaseOrderToItemReceipt: async () => ({}),
    transformTransferOrderToItemReceipt: async () => ({}),
    fetchItemFulfillment: async () => null,
    fetchItemReceipt: async () => null
  });
  assert.equal(await missing.findByExternalId(target), null);

  const unreadable = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => ({ id: 79 }),
    transformSalesOrderToItemFulfillment: async () => ({}),
    transformTransferOrderToItemFulfillment: async () => ({}),
    transformPurchaseOrderToItemReceipt: async () => ({}),
    transformTransferOrderToItemReceipt: async () => ({}),
    fetchItemFulfillment: async () => null,
    fetchItemReceipt: async () => null
  });
  await assert.rejects(
    unreadable.findByExternalId(target),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED" && error?.ambiguous === true
  );
});

test("R2 external-ID recovery is scoped to the exact source transaction", async () => {
  const target = sourceStep("SO");
  const lookups = [];
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async (...args) => {
      lookups.push(args);
      return null;
    },
    transformSalesOrderToItemFulfillment: async () => ({}),
    transformTransferOrderToItemFulfillment: async () => ({}),
    transformPurchaseOrderToItemReceipt: async () => ({}),
    transformTransferOrderToItemReceipt: async () => ({}),
    fetchItemFulfillment: async () => null,
    fetchItemReceipt: async () => null
  });

  assert.equal(await adapter.findByExternalId(target), null);
  assert.deepEqual(lookups, [[target.externalId, target.transactionType, target.sourceNetSuiteId]],
    "Recovery must provide the source order ID so NetSuite can use transaction links instead of its failing transaction.createdfrom/externalid query.");
});

test("R2 NetSuite recovery traverses source links, deduplicates lines, and reads the exact IF", async () => {
  const externalId = "MBBS-OP-68c0dde1-9741-4a35-a8aa-dedbb23ba6a2-1";
  const queries = [];
  const reads = [];
  const exact = {
    id: "973910",
    tranId: "IF150757",
    externalId,
    createdFrom: { id: "972607" },
    item: { items: [] }
  };
  const found = await findOperatorNetSuitePostingTransactionByExternalId(externalId, "IF", 972607, {
    queryAll: async (query) => {
      queries.push(query);
      return [
        { id: "973910", tranid: "IF150757" },
        { id: "973910", tranid: "IF150757" },
        { id: "973000", tranid: "IF150700" }
      ];
    },
    fetchItemFulfillment: async (id) => {
      reads.push(id);
      return id === 973910 ? exact : { id, externalId: "another-command" };
    },
    fetchItemReceipt: async () => { throw new Error("IF recovery must not read Item Receipts."); }
  });

  assert.match(queries[0], /NextTransactionLineLink/u);
  assert.match(queries[0], /previousdoc = 972607/u);
  assert.doesNotMatch(queries[0], /\.externalid/u);
  assert.deepEqual(reads, [973910, 973000]);
  assert.equal(found?.id, 973910);
  assert.equal(found?.tranid, "IF150757");
  assert.equal(found?.externalid, externalId);
  assert.equal(found?.createdfrom, 972607);
  assert.equal(found?.record, exact);
});

test("P1-P4 local finalization reuses existing flows and attaches command evidence", async () => {
  const calls = [];
  const finalizer = createOperatorNetSuitePostingFinalizer({
    recordCustomerPickupLoad: async (...args) => { calls.push(["pickup", ...args]); return { id: 10, pickupStatus: "loaded" }; },
    recordDeliveryLoad: async (...args) => { calls.push(["delivery", ...args]); return { id: 11, localYardOrderStatus: "Loaded" }; },
    recordReceivingReceipt: async (...args) => { calls.push(["receiving", ...args]); return { receiptStatus: "received" }; },
    syncDirectDependencyOperatorProgress: async (...args) => { calls.push(["direct-dependency", ...args]); return { changed: true }; },
    syncOrderDependenciesForTransferOrder: async (...args) => { calls.push(["dependency", ...args]); },
    attachLoadEvidence: async (...args) => { calls.push(["evidence", ...args]); },
    publishCompletionEvents: async (...args) => { calls.push(["completion-events", ...args]); }
  });
  const base = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actorOperatorId: "operator-one",
    photoRefs: ["r2://operator/a.jpg", "r2://operator/b.jpg"],
    inputSnapshot: {},
    steps: [{
      id: 1,
      payload: { externalId: "one", item: { items: [{ orderLine: 1, quantity: 2, itemReceive: true }] } },
      netSuiteTransactionId: 7001,
      netSuiteTransactionRef: "IF7001",
      transactionType: "IF",
      sourceOrderRef: "SOA1"
    }]
  };

  const pickup = structuredClone(base);
  pickup.inputSnapshot.localOperation = { kind: "customer_pickup_load", orderId: "101", orderType: "sales_order" };
  assert.equal((await finalizer(pickup)).pickupStatus, "loaded");
  assert.equal(calls[0][0], "pickup");
  assert.equal(calls[1][0], "evidence");
  assert.equal(calls[2][0], "completion-events");

  calls.length = 0;
  const delivery = structuredClone(base);
  delivery.inputSnapshot.localOperation = { kind: "delivery_prep_load", orderId: "GROUP:1", orderType: "group_order" };
  assert.equal((await finalizer(delivery)).localYardOrderStatus, "Loaded");
  assert.equal(calls[0][0], "delivery");
  assert.equal(calls[0][3].requestId, base.requestId);
  assert.equal(calls[1][0], "evidence");
  assert.equal(calls[2][0], "direct-dependency");
  assert.equal(calls[3][0], "completion-events");

  calls.length = 0;
  const receiving = structuredClone(base);
  receiving.steps[0].transactionType = "IR";
  receiving.steps[0].netSuiteTransactionRef = "IR7001";
  receiving.inputSnapshot.localOperation = { kind: "receiving_receipt", orderId: "303", orderType: "transfer_order" };
  assert.equal((await finalizer(receiving)).receiptStatus, "received");
  assert.equal(calls[0][0], "receiving");
  assert.equal(calls[0][3].itemReceiptId, 7001);
  assert.equal(calls[1][0], "dependency");
  assert.equal(calls[2][0], "completion-events");

  calls.length = 0;
  const purchaseReceiving = structuredClone(receiving);
  purchaseReceiving.inputSnapshot.localOperation.orderType = "purchase_order";
  await finalizer(purchaseReceiving);
  assert.equal(calls.some(([name]) => name === "dependency"), false);

  const invalidReceiving = structuredClone(base);
  invalidReceiving.inputSnapshot.localOperation = { kind: "receiving_receipt", orderId: "303", orderType: "purchase_order" };
  await assert.rejects(
    finalizer(invalidReceiving),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
  );

  const invalid = structuredClone(base);
  invalid.inputSnapshot.localOperation = { kind: "arbitrary", orderId: "1", orderType: "sales_order" };
  await assert.rejects(
    finalizer(invalid),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
  );
});

test("P9 verified local finalization publishes the same operational refresh events as gate-off", () => {
  const events = [];
  configureOperatorNetSuitePostingCompletionEvents((...args) => events.push(args));
  const command = { id: "job-1", actorOperatorId: "operator-one" };
  publishOperatorNetSuitePostingCompletionEvents(
    command,
    { kind: "customer_pickup_load", orderId: "SO1" },
    { id: 1 }
  );
  publishOperatorNetSuitePostingCompletionEvents(
    command,
    { kind: "receiving_receipt", orderId: "PO1", orderType: "purchase_order" },
    { itemReceiptTranid: "IR1" }
  );
  publishOperatorNetSuitePostingCompletionEvents(
    command,
    { kind: "delivery_prep_load", orderId: "SO2" },
    { id: 2, activatedCo: ["CO-1"] }
  );
  assert.deepEqual(events.map(([name]) => name), [
    "delivery.order.loaded",
    "receiving.order.received",
    "delivery.order.loaded",
    "receiving.order.updated",
    "dispatch.co.updated"
  ]);
  assert.throws(
    () => configureOperatorNetSuitePostingCompletionEvents(null),
    /event emitter is required/u
  );
});

test("R1 an authoritative already-received command finalizes the stable local receipt with zero transform steps", async () => {
  const calls = [];
  const finalizer = createOperatorNetSuitePostingFinalizer({
    recordCustomerPickupLoad: async () => ({}),
    recordDeliveryLoad: async () => ({}),
    recordReceivingReceipt: async (...args) => {
      calls.push(args);
      return { receiptStatus: "received", itemReceiptId: args[2].itemReceiptId };
    },
    syncDirectDependencyOperatorProgress: async () => ({}),
    syncOrderDependenciesForTransferOrder: async () => {},
    attachLoadEvidence: async () => {},
    publishCompletionEvents: async () => {}
  });
  const localPayload = {
    item: { items: [{ orderLine: 4850690, quantity: 5, itemReceive: true, location: 1 }] }
  };
  const command = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actorOperatorId: "operator-one",
    photoRefs: ["r2://operator/a.jpg", "r2://operator/b.jpg"],
    steps: [],
    inputSnapshot: {
      localOperation: { kind: "receiving_receipt", orderId: "968798", orderType: "purchase_order" },
      localPayload,
      lineReconciliation: {
        schemaVersion: "operator-netsuite-line-reconciliation-v1",
        lines: [{
          sourceLineKey: "4850690",
          requestedQuantity: 5,
          postedQuantity: 0,
          reconciledQuantity: 5,
          linkedTransactions: [{ id: 991, ref: "IR991", type: "IR", quantity: 5 }]
        }]
      }
    }
  };

  const result = await finalizer(command);
  assert.equal(result.itemReceiptId, 991);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2].payload, localPayload);
  assert.equal(calls[0][2].itemReceiptId, 991);
  assert.equal(calls[0][2].itemReceiptTranid, "IR991");
  assert.equal(calls[0][2].allowNetSuiteCompleted, true);
  assert.deepEqual(
    calls[0][2].response.operatorNetSuitePosting.lineReconciliation,
    command.inputSnapshot.lineReconciliation
  );
});

test("E1 zero-step receiving rejects incomplete evidence and never invents one receipt from multiple IRs", async () => {
  const calls = [];
  const finalizer = createOperatorNetSuitePostingFinalizer({
    recordCustomerPickupLoad: async () => ({}),
    recordDeliveryLoad: async () => ({}),
    recordReceivingReceipt: async (...args) => {
      calls.push(args);
      return { receiptStatus: "received", itemReceiptId: args[2].itemReceiptId };
    },
    syncDirectDependencyOperatorProgress: async () => ({}),
    syncOrderDependenciesForTransferOrder: async () => {},
    attachLoadEvidence: async () => {},
    publishCompletionEvents: async () => {}
  });
  const base = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    actorOperatorId: "operator-one",
    photoRefs: ["r2://operator/a.jpg", "r2://operator/b.jpg"],
    steps: [],
    inputSnapshot: {
      localOperation: { kind: "receiving_receipt", orderId: "303", orderType: "purchase_order" },
      localPayload: { item: { items: [{ orderLine: 10, quantity: 2, itemReceive: true }] } },
      lineReconciliation: {
        lines: [{
          authoritative: true,
          reconciledQuantity: 2,
          linkedTransactions: [
            { id: 91, ref: "IR91", type: "IR" },
            { id: 92, ref: "IR92", type: "IR" }
          ]
        }]
      }
    }
  };
  const result = await finalizer(structuredClone(base));
  assert.equal(result.itemReceiptId, null);
  assert.equal(calls[0][2].itemReceiptTranid, null);

  const incomplete = structuredClone(base);
  incomplete.inputSnapshot.lineReconciliation.lines[0].authoritative = false;
  await assert.rejects(
    finalizer(incomplete),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
  );

  const missingPayload = structuredClone(base);
  delete missingPayload.inputSnapshot.localPayload;
  await assert.rejects(
    finalizer(missingPayload),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
  );
});
