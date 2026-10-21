// Stream into the deployed application with docker exec -i APP node --input-type=module.
import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { lookupReturnSalesOrder } from "./src/return-repository.js";

const transport = globalThis.fetch;
let sourceRecordGets = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = String(url?.url || url);
  if ((options.method || "GET") === "GET" && /\/record\/v1\/salesOrder\//i.test(address)) {
    sourceRecordGets += 1;
    throw new Error("The stored return mapping must not reload a source Sales Order through REST.");
  }
  return transport(url, options);
};
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    const data = await lookupReturnSalesOrder({ code: "SOM06642", receivingLocationId: 26,
      includeStockReturns: true, includeNetSuiteOrderLines: true, includePalletBalance: false });
    assert.equal(data.order.id, 1006905);
    assert.equal(data.receivingLocation.locationId, 26);
    assert.equal(data.crossYardAllowed, true);
    assert.equal(sourceRecordGets, 0);
    assert.ok(data.lines.length > 0);
    const saved = await query("SELECT line_id,item_id,netsuite_order_line FROM sales_order_lines WHERE sales_order_id=$1 AND netsuite_active=true", [data.order.id]);
    for (const line of data.lines) {
      const row = saved.rows.find(value => Number(value.line_id) === line.sourceLineId && Number(value.item_id) === line.itemId);
      assert.ok(row);
      assert.equal(line.netSuiteOrderLine, Number(row.netsuite_order_line));
      assert.equal(line.netSuiteOrderLineSource, "stored_order_line_v1");
    }
    return { passed: true, orderId: data.order.id, orderRef: data.order.tranid,
      status: data.order.statusText, receivingYard: data.receivingLocation.yardCode, sourceRecordGets,
      lines: data.lines.map(line => ({ sourceLineId: line.sourceLineId, itemId: line.itemId,
        restOrderLine: line.netSuiteOrderLine, remainingReturnable: line.remainingReturnable, salesUom: line.salesUom })) };
  });
  console.log(JSON.stringify(result));
} finally {
  globalThis.fetch = transport;
  await closeDb();
}
