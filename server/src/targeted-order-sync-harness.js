import assert from "node:assert/strict";
import { parseTargetedOrderReference, syncTargetedNetSuiteOrder } from "./targeted-order-sync.js";

function fakeDependencies(overrides = {}) {
  const calls = [];
  const events = [];
  const audits = [];
  const record = (name, value) => {
    calls.push({ name, value });
    return value;
  };
  return {
    calls,
    events,
    audits,
    dependencies: {
      findLocalOrder: async () => null,
      findNetSuiteOrder: async () => null,
      fetchSalesOrder: async (id) => record("fetchSalesOrder", { id, tranid: "SOA00001", status_text: "Pending Fulfillment" }),
      fetchSalesOrderLines: async () => record("fetchSalesOrderLines", [{ line_id: 11 }]),
      upsertSalesOrders: async (rows) => record("upsertSalesOrders", rows),
      upsertSalesOrderLines: async (id, rows) => record("upsertSalesOrderLines", { id, rows }),
      markMissingOutboundOrderLines: async (id, lineIds) => record("markMissingOutboundOrderLines", { id, lineIds }),
      fetchPurchaseOrder: async (id) => record("fetchPurchaseOrder", { id, tranid: "POB00001", status_text: "Pending Receipt" }),
      fetchPurchaseOrderLines: async () => record("fetchPurchaseOrderLines", [{ line_id: 21 }, { line_id: 22 }]),
      upsertPurchaseOrders: async (rows) => record("upsertPurchaseOrders", rows),
      upsertPurchaseOrderLines: async (id, rows) => record("upsertPurchaseOrderLines", { id, rows }),
      markMissingInboundOrderLines: async (id, lineIds) => record("markMissingInboundOrderLines", { id, lineIds }),
      fetchTransferOrder: async (id) => record("fetchTransferOrder", {
        id,
        tranid: "TOB00001",
        status_text: "Pending Fulfillment",
        source_location_id: 1,
        destination_location_id: 26
      }),
      fetchTransferOrderLines: async (id, locationId, options) => record(
        `fetchTransferOrderLines:${options.direction}`,
        [{ line_id: options.direction === "source" ? 31 : 32, id, locationId }]
      ),
      upsertOutboundTransferOrders: async (rows) => record("upsertOutboundTransferOrders", rows),
      upsertInboundTransferOrders: async (rows) => record("upsertInboundTransferOrders", rows),
      upsertOutboundTransferOrderLines: async (id, rows) => record("upsertOutboundTransferOrderLines", { id, rows }),
      upsertInboundTransferOrderLines: async (id, rows) => record("upsertInboundTransferOrderLines", { id, rows }),
      writeAudit: async (entry) => audits.push(entry),
      emitEvent: (name, payload) => events.push({ name, payload }),
      now: () => new Date("2026-07-23T12:00:00.000Z"),
      ...overrides
    }
  };
}

assert.deepEqual(parseTargetedOrderReference(" pob03581 "), {
  orderRef: "POB03581",
  prefix: "PO",
  orderType: "purchase_order",
  netSuiteType: "PurchOrd",
  eventNames: ["dispatch.orders.updated", "receiving.order.updated"]
});
assert.equal(parseTargetedOrderReference("soa05632").orderType, "sales_order");
assert.equal(parseTargetedOrderReference("tob00690").orderType, "transfer_order");
assert.throws(
  () => parseTargetedOrderReference("INV100"),
  (error) => error.status === 400 && /must start with SO, PO, or TO/.test(error.message)
);
assert.throws(
  () => parseTargetedOrderReference("SOT123"),
  (error) => error.status === 400 && /cross-charge/.test(error.message)
);

{
  let lookupCalled = false;
  const fixture = fakeDependencies({
    findLocalOrder: async () => ({
      id: 918190,
      tranid: "POB03581",
      status_text: "Pending Supervisor Approval"
    }),
    findNetSuiteOrder: async () => {
      lookupCalled = true;
      return null;
    },
    fetchPurchaseOrder: async (id) => ({
      id,
      tranid: "POB03581",
      status_text: "Pending Receipt"
    })
  });
  const result = await syncTargetedNetSuiteOrder(
    { orderRef: "POB03581", actorOperatorId: 7 },
    fixture.dependencies
  );
  assert.equal(lookupCalled, false, "A locally tracked order must reuse its known NetSuite ID.");
  assert.equal(result.netSuiteId, 918190);
  assert.equal(result.previousStatus, "Pending Supervisor Approval");
  assert.equal(result.status, "Pending Receipt");
  assert.equal(result.statusChanged, true);
  assert.deepEqual(result.lines, { receiving: 2 });
  assert.deepEqual(
    fixture.calls.filter((entry) => entry.name.startsWith("upsert") || entry.name.startsWith("mark")).map((entry) => entry.name),
    ["upsertPurchaseOrders", "upsertPurchaseOrderLines", "markMissingInboundOrderLines"]
  );
  assert.equal(fixture.audits[0].action, "netsuite.order.targeted_sync");
  assert.deepEqual(fixture.events.map((entry) => entry.name), [
    "dispatch.orders.updated",
    "receiving.order.updated"
  ]);
}

{
  const fixture = fakeDependencies({
    findNetSuiteOrder: async ({ orderRef, netSuiteType }) => {
      assert.equal(orderRef, "SOA00001");
      assert.equal(netSuiteType, "SalesOrd");
      return { id: 700001, tranid: orderRef };
    }
  });
  const result = await syncTargetedNetSuiteOrder({ orderRef: "SOA00001" }, fixture.dependencies);
  assert.equal(result.foundLocally, false);
  assert.deepEqual(result.lines, { outbound: 1 });
  assert.deepEqual(fixture.events.map((entry) => entry.name), [
    "dispatch.orders.updated",
    "delivery.order.updated"
  ]);
}

{
  const fixture = fakeDependencies({
    findLocalOrder: async () => ({ id: 800001, tranid: "TOB00001", status_text: "Pending Fulfillment" })
  });
  const result = await syncTargetedNetSuiteOrder({ orderRef: "TOB00001" }, fixture.dependencies);
  assert.deepEqual(result.lines, { outbound: 1, receiving: 1 });
  assert.deepEqual(
    fixture.calls.filter((entry) => entry.name.startsWith("fetchTransferOrderLines")).map((entry) => entry.name),
    ["fetchTransferOrderLines:source", "fetchTransferOrderLines:destination"]
  );
  assert.deepEqual(fixture.events.map((entry) => entry.name), [
    "dispatch.orders.updated",
    "delivery.order.updated",
    "receiving.order.updated"
  ]);
}

{
  const fixture = fakeDependencies();
  await assert.rejects(
    () => syncTargetedNetSuiteOrder({ orderRef: "POB99999" }, fixture.dependencies),
    (error) => error.status === 404 && /not found in NetSuite/.test(error.message)
  );
  assert.equal(fixture.calls.length, 0, "A missing transaction must not write local data.");
}

console.log("Targeted SO/PO/TO sync harness passed.");
