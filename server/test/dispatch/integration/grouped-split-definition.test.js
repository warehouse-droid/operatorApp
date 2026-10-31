import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { syncDispatchGlobalOrderSplitsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { getNextDispatchSplitSuffix } from "../../../src/delivery-repository.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

const parentRef = "SO-SUFFIX-1";
const split = (suffix) => ({ id: `${parentRef}-S${suffix}`, type: "SO", originalOrderId: parentRef, isSplit: true,
  planOwned: true, address: "1 Suffix Road", items: [{ itemId: 1, sku: "SUFFIX", quantity: 1 }] });

// S2 was grouped before the plan's first save. It still owns the -S2 suffix,
// so a later split of the same parent must not hand out -S2 again.
test("a split grouped before its first save keeps its definition and suffix", () => isolated(async () => {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,fulfillment_status,
    outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,netsuite_active)
    VALUES(8800001,$1,'Suffix','B','Pending Fulfillment','not_fulfilled',1,'3445','Delivery','open','Open',true)`, [parentRef]);
  const planId = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2097-03-01','draft') RETURNING id")).rows[0].id;
  const group = { id: "GSO-SUFFIX", type: "SO", planOwned: true, childOrders: [split(2).id], childOrderDetails: [split(2)],
    items: split(2).items, address: "1 Suffix Road" };
  await syncDispatchGlobalOrderSplitsFromPlan({ id: String(planId), planDate: "2097-03-01", revision: 1,
    orders: [split(1), group], trucks: [] });
  const definitions = (await query(`SELECT split_ref FROM dispatch_global_order_splits
    WHERE parent_order_ref = $1 AND active ORDER BY split_ref`, [parentRef])).rows.map((row) => row.split_ref);
  assert.deepEqual(definitions, [split(1).id, split(2).id]);
  assert.equal((await getNextDispatchSplitSuffix({ originalOrderId: parentRef, orderType: "SO" })).nextSuffix, 3);
}));
