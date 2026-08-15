import assert from "node:assert/strict";

import {
  exactNetSuiteClosedSql,
  isNetSuiteOrderClosed,
  netSuiteClosedOrderFamilySql,
  normalizeNetSuiteOrderRefs,
  operationalPlanOrderRefs,
  scrubOrderRefsFromOperationalPlan
} from "./netsuite-closed-order-policy.js";

for (const order of [
  { kind: "SO", status: "H" },
  { kind: "PO", status: "h" },
  { kind: "TO", statusText: "Transfer Order : Closed" },
  { kind: "PO", status_text: " purchase   order: closed " },
  { kind: "SO", netsuiteStatusText: "Closed" }
]) {
  assert.equal(isNetSuiteOrderClosed(order), true, JSON.stringify(order));
}

for (const order of [
  {},
  { kind: "SO", status: "G", statusText: "Sales Order : Billed" },
  { kind: "PO", statusText: "Not Closed Yet" },
  { kind: "TO", statusText: "Closed for inspection" }
]) {
  assert.equal(isNetSuiteOrderClosed(order), false, JSON.stringify(order));
}

assert.deepEqual(normalizeNetSuiteOrderRefs([
  " soa0001 ", "SOA0001", "tob0002", "", null, 123
]), ["SOA0001", "TOB0002", "123"]);

const sql = exactNetSuiteClosedSql("candidate");
assert.match(sql, /candidate\.status/);
assert.match(sql, /candidate\.status_text/);
assert.match(sql, /SALES ORDER:CLOSED/);
assert.match(sql, /PURCHASE ORDER:CLOSED/);
assert.match(sql, /TRANSFER ORDER:CLOSED/);
assert.match(netSuiteClosedOrderFamilySql("candidate", "SO"), /dispatch_scm_so_splits/);
assert.match(netSuiteClosedOrderFamilySql("candidate", "PO"), /dispatch_scm_po_splits/);
assert.match(netSuiteClosedOrderFamilySql("candidate", "TO"), /dispatch_scm_to_splits/);
assert.throws(() => netSuiteClosedOrderFamilySql("unsafe.alias", "SO"), /safe SQL table alias/);

const stalePlan = {
  orders: [
    { id: "TST-SO-CLOSED", type: "SO" },
    { id: "CO-TST-SO-CLOSED", type: "CO", sourceOrderRef: "TST-SO-CLOSED" },
    {
      id: "GROUP-OPEN-AND-CLOSED",
      type: "GROUP",
      childOrders: ["TST-PO-CLOSED-S1", "TST-PO-OPEN"],
      childOrderDetails: [
        { id: "TST-PO-CLOSED-S1", type: "PO" },
        { id: "TST-PO-OPEN", type: "PO" }
      ]
    }
  ],
  trucks: [{
    loads: [{
      orders: ["TST-SO-CLOSED", "CO-TST-SO-CLOSED", "GROUP-OPEN-AND-CLOSED"],
      stops: [
        { orderId: "TST-SO-CLOSED", orderRefs: ["TST-SO-CLOSED"] },
        { orderId: "CO-TST-SO-CLOSED", orderRefs: ["CO-TST-SO-CLOSED"] },
        {
          orderId: "GROUP-OPEN-AND-CLOSED",
          orderRefs: ["TST-PO-CLOSED-S1", "TST-PO-OPEN"],
          groupedOrderRefs: ["TST-PO-CLOSED-S1", "TST-PO-OPEN"]
        }
      ]
    }]
  }]
};
assert.deepEqual(operationalPlanOrderRefs(stalePlan).sort(), [
  "CO-TST-SO-CLOSED",
  "GROUP-OPEN-AND-CLOSED",
  "TST-PO-CLOSED-S1",
  "TST-PO-OPEN",
  "TST-SO-CLOSED"
]);
const scrubbed = scrubOrderRefsFromOperationalPlan(stalePlan, {
  orderRefs: ["TST-SO-CLOSED", "TST-PO-CLOSED-S1"],
  cleanedAt: "2026-08-14T00:00:00.000Z"
});
assert.equal(scrubbed.changed, true);
assert.deepEqual(scrubbed.plan.orders.map((order) => order.id), ["GROUP-OPEN-AND-CLOSED"]);
assert.deepEqual(scrubbed.plan.orders[0].childOrders, ["TST-PO-OPEN"]);
assert.deepEqual(scrubbed.plan.orders[0].childOrderDetails.map((order) => order.id), ["TST-PO-OPEN"]);
assert.deepEqual(scrubbed.plan.trucks[0].loads[0].orders, ["GROUP-OPEN-AND-CLOSED"]);
assert.equal(scrubbed.plan.trucks[0].loads[0].stops.length, 1);
assert.deepEqual(scrubbed.plan.trucks[0].loads[0].stops[0].orderRefs, ["TST-PO-OPEN"]);
assert.deepEqual(scrubbed.plan.summary.closedNetSuiteOrderCleanup, {
  removedOrderCount: 2,
  cleanedAt: "2026-08-14T00:00:00.000Z"
});

console.log("NetSuite Closed-order policy harness passed.");
