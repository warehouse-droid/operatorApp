import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";

test("selected receiving order card counts the same current remaining lines as its detail", async () => {
  const source = readFileSync("public/operator.js", "utf8");
  const order = { netsuite_id: 945685, order_type: "purchase_order", line_count: 16 };
  const lines = [
    { item_type: "InvtPart", original_quantity: 456, quantity: 228, netsuite_active: true },
    { item_type: "InvtPart", original_quantity: 108, quantity: 108, netsuite_active: true },
    { item_type: "InvtPart", original_quantity: 304, quantity: 304, netsuite_active: true },
    { item_type: "InvtPart", original_quantity: 100, quantity: 0, netsuite_active: true, received_pallet_qty: 1 },
    { item_type: "InvtPart", original_quantity: 100, quantity: 100, netsuite_active: false },
    { item_type: "InvtPart", original_quantity: 100, quantity: 100, netsuite_active: true, sync_exception: "line_deleted" },
    { item_type: "NonInvtPart", sku: "DELIVERY CHARGE", quantity: 1 }
  ];
  const context = vm.createContext({ receivingOrders: [order], receivingOrderType: "purchase_order",
    receivingDetailRequest: 0, receivingSelectedId: null, receivingSelectedOrder: null,
    invalidateReceivingRequests() {}, receivingRequestContext: () => ({}), receivingRequestIsCurrent: () => true,
    api: async () => ({ ...order, lines }), PICKABLE_ITEM_TYPES: new Set(["InvtPart"]), render() {} });
  for (const name of ["qty", "isPickableLine", "receivingRemainingSalesQty", "hasReceivingRemainingQty", "loadReceivingDetail"]) {
    const start = source.indexOf(`${name === "loadReceivingDetail" ? "async " : ""}function ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf("\n}", start) + 2;
    const executable = source.slice(0, start).replace(/[^\n]/g, " ") + source.slice(start, end)
      + source.slice(end).replace(/[^\n]/g, " ");
    new vm.Script(executable, { filename: path.resolve("public/operator.js") }).runInContext(context);
  }
  await context.loadReceivingDetail(945685);
  assert.equal(order.line_count, 3);
  context.receivingRequestIsCurrent = () => false;
  order.line_count = 16;
  assert.equal(await context.loadReceivingDetail(945685), null);
  assert.equal(order.line_count, 16, "Stale responses cannot overwrite the current order list");
});
