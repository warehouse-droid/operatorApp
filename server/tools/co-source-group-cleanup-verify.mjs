import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {pool,query,withTransaction,closeDb} from "../src/db.js";
import {getDeliveryOrder,listDeliveryOrders} from "../src/delivery-repository.js";
import {readCoCleanupState} from "./co-source-cleanup-repository.mjs";
pool.options.options="-c jit=off -c default_transaction_read_only=on -c statement_timeout=60000";
const directory="test-artifacts/so-delivery-cleanup-grouped-co-20260915";
const manifest=JSON.parse(readFileSync(`${directory}/co-manifest.json`,"utf8"));
const before=JSON.parse(readFileSync(`${directory}/co-before.json`,"utf8"));
try {
  const report=await withTransaction(async()=>{
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const state=await readCoCleanupState(),details=[];
    for(const entry of manifest.entries) {
      const order=state.cos.find(co=>String(co.id)===entry.id);
      assert.deepEqual(order,entry.after.order,entry.ref);
      assert.deepEqual(state.lines.filter(line=>String(line.co_id)===entry.id),entry.before.lines,entry.ref);
      const detail=await getDeliveryOrder(entry.ref);
      assert(detail,entry.ref);
      assert.equal(detail.operator_status,"loaded",entry.ref);
      assert.equal(detail.local_yard_order_status,"Loaded",entry.ref);
      details.push({ref:entry.ref,status:detail.operator_status,yardStatus:detail.local_yard_order_status});
    }
    const active=await listDeliveryOrders({status:"active",orderType:"sales_order"});
    const remaining=active.filter(order=>manifest.entries.some(entry=>entry.ref===order.tranid));
    assert.equal(remaining.length,0,"Corrected grouped COs must not remain in the active Operator feed");
    const heldRefs=new Set(manifest.skipSourceRefs),orders=new Map(state.so.orders.map(order=>[String(order.netsuite_id),order]));
    for(const order of before.so.orders) if(heldRefs.has(order.tranid)) assert.deepEqual(orders.get(String(order.netsuite_id)),order,order.tranid);
    return {verifiedAt:new Date().toISOString(),verifiedCos:details.length,activeFeedRemaining:0,
      cargoAndReceiptsUnchanged:true,reviewSOsUnchanged:true,details};
  },{rollback:true});
  writeFileSync(`${directory}/live-verification.json`,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally {await closeDb();}
