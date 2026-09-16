import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("Back to Receiving clears search and invalidates stale requests before reloading", async () => {
  const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
  const start = source.indexOf("async function finishReceipt()");
  const fn = source.slice(start, source.indexOf("async function loadPersonalHistory()", start));
  const calls = [];
  const context = vm.createContext({
    receiptOrder: { order_type: "purchase_order" }, receiptResult: { itemReceiptTranid: "IR14634" }, receivingOrderType: "purchase_order",
    receivingSearch: "SN1400333", receivingItemSearch: "PALLET", receivingSelectedId: "old", receivingSelectedOrder: {}, receivingOrders: [{}], receivingItemSuggestions: [{}], receivingOrderPage: 4,
    stopReceiptCamera: () => {}, invalidateReceivingRequests: () => calls.push("invalidate"), saveOperatorState: () => calls.push("save"),
    loadReceivingOrders: async () => calls.push("reload"), render: () => calls.push("render")
  });
  vm.runInContext(`${fn}\nfinishReceipt()`, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.receivingSearch, "");
  assert.equal(context.receivingItemSearch, "");
  assert.equal(context.receivingSelectedId, null);
  assert.equal(context.receivingSelectedOrder, null);
  assert.equal(context.receivingOrders.length, 0);
  assert.equal(context.receivingItemSuggestions.length, 0);
  assert.equal(context.receivingOrderPage, 0);
  assert.ok(calls.indexOf("invalidate") < calls.indexOf("reload"));
  assert.ok(calls.indexOf("save") >= 0);
});
