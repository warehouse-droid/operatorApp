// Read-only postcheck of the user-requested S2 -> S1 correction.
import assert from "node:assert/strict";
import {query,withTransaction,closeDb} from "/app/src/db.js";
import {listDispatchOrders} from "/app/src/dispatch-repository.js";
import {getDispatchOrderCatalogOrder,listDispatchOrderPool} from "/app/src/dispatch-order-catalog-repository.js";
import {listControlLoadedOrders} from "/app/src/delivery-repository.js";
const targets = [{parent:"SOM06255",record:"1098",qty:1489.29},{parent:"SOM06256",record:"1097",qty:211}];
try {
  const result = await withTransaction(async()=>{
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await query("SET LOCAL statement_timeout='30s'");
    const orders = await listDispatchOrders({type:"SO",exactOrderRefs:targets.map(t=>t.parent)});
    const verified = [];
    for (const t of targets) {
      const ref = `${t.parent}-S2`, first = `${t.parent}-S1`;
      const canonical = orders.find(o=>o.id===ref), detail = await getDispatchOrderCatalogOrder(ref);
      for (const order of [canonical,detail]) {
        assert.ok(order); assert.equal(order.operatorStatus,"open"); assert.equal(order.localYardOrderStatus,"Open");
      }
      const pool = await listDispatchOrderPool({type:"SO",search:ref,limit:20});
      const poolOrder = pool.orders.find(o=>o.id===ref || o.childOrders?.includes(ref));
      assert.ok(poolOrder,"Reopened split must be available directly or in its existing group");
      assert.notEqual(poolOrder.dispatchPlanningRestricted,true);
      const lines = (await query(`SELECT l.* FROM sales_order_lines l JOIN sales_orders s ON s.netsuite_id=l.sales_order_id WHERE s.tranid=$1`,[ref])).rows;
      for (const line of lines) {
        for (const field of ["loaded_qty","packed_sales_qty","packed_pallet_qty","packed_layer_qty","packed_section_qty","packed_piece_qty"]) { assert.equal(Number(line[field]),0); }
        assert.equal(line.confirmed,false);
      }
      const loaded = await listControlLoadedOrders({from:"2026-09-15",to:"2026-09-15",search:t.parent});
      assert.deepEqual(loaded.map(o=>o.tranid),[first]);
      assert.equal(loaded[0].load_count,1); assert.equal(loaded[0].photo_count,2);
      const records = (await query("SELECT id,order_ref,line_snapshot FROM operator_load_records WHERE id=$1",[t.record])).rows;
      assert.equal(records[0].order_ref,first); assert.equal(Number(records[0].line_snapshot[0].loadedQty),t.qty);
      const sibling = await getDispatchOrderCatalogOrder(first);
      assert.equal(sibling.dispatchCompletionStatus,"completed");
      verified.push({reopened:ref,status:detail.operatorStatus,loadedQuantity:0,packedQuantity:0,
        availableInDispatch:true,poolOrder:poolOrder.id,loadRecord:t.record,movedTo:first,loadedQuantityOnS1:t.qty,photoCount:loaded[0].photo_count,s1Completion:"completed"});
    }
    return {mode:"live-read-only-postcheck",verified};
  },{rollback:true});
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
