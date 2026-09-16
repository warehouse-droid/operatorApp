import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { listReceivingOrders, listReceivingVendors, searchReceivingItems, getReceivableReceivingOrder } from "../../../src/receiving-repository.js";
import { submitOperatorNetSuitePostingAction } from "../../../src/operator-netsuite-posting-controller.js";

after(closeDb);
test("received split and ordinary POs stay hidden despite stale NetSuite statuses", async () => {
  const vendor = `completed-${crypto.randomUUID()}`;
  const ids = [-(870000000 + crypto.randomInt(1000000)), 871000000 + crypto.randomInt(1000000), 872000000 + crypto.randomInt(1000000)];
  for (const [index, id] of ids.entries()) {
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor,destination_location_id,netsuite_active,status,status_text,receipt_status)
      VALUES($1,$2,$3,1,true,'E','Purchase Order : Pending Billing/Partially Received',$4)`, [id, `DONE-${id}`, vendor, index < 2 ? "received" : "partial_received"]);
    await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,piece_qty,to_pcs,received_piece_qty,netsuite_active,confirmed_at)
      VALUES($1,1,$2,$3,'InvtPart',10,'EACH',10,1,10,true,now())`, [id, Math.abs(id), `ITEM-${id}`]);
  }
  const list = await listReceivingOrders({ orderType: "purchase_order", destinationLocationId: 1, vendor });
  assert.deepEqual(list.map((row) => Number(row.netsuite_id)), [ids[2]]);
  for (const id of ids.slice(0, 2)) {
    assert.deepEqual(await listReceivingOrders({ orderType: "purchase_order", search: `DONE-${id}` }), []);
    assert.deepEqual(await searchReceivingItems({ orderType: "purchase_order", search: `ITEM-${id}` }), []);
    await assert.rejects(getReceivableReceivingOrder(id, { includeNetSuiteClosed: true }), { code: "RECEIVING_ALREADY_COMPLETED", status: 409 });
    await assert.rejects(submitOperatorNetSuitePostingAction({ requestId: crypto.randomUUID(), functionKey: "receiving", orderId: id, orderType: "purchase_order", clientLocationId: 1 }), { code: "RECEIVING_ALREADY_COMPLETED" });
  }
  assert.equal((await listReceivingVendors({ destinationLocationId: 1 })).find((row) => row.vendor === vendor).order_count, 1);
  assert.ok(await getReceivableReceivingOrder(ids[2]));
});
