import assert from "node:assert/strict";
import test,{after} from "node:test";
import {query,closeDb} from "../../../src/db.js";
import {getDeliveryOrder} from "../../../src/delivery-repository.js";
import {scenario,seedSalesOrder} from "../support/fulfilled-so-fixture.js";
import {readCoCleanupState,createCoCleanupManifest,applyCoCleanupManifest} from "../../../tools/co-source-cleanup-repository.mjs";
after(closeDb);
const sourceId=817156101,sourceRef="SO-CO-CLEANUP-SOURCE",coId=817156102;
const remote={mode:"netsuite-read-only-select",completedAt:new Date().toISOString(),rows:[{id:String(sourceId),tranid:sourceRef,status:"F",status_text:"Sales Order : Pending Billing"}]};
async function seed() {
  await seedSalesOrder(sourceId,sourceRef,{status:"B"});
  await query("INSERT INTO local_co_orders(id,co_ref,source_order_ref,status,delivery_order_id) VALUES($1,'CO-CLEANUP-SOURCE',$2,'pending_load',$3)",[coId,sourceRef,-coId]);
  await query("INSERT INTO local_co_order_lines(id,co_id,line_id,item_id,item_name,item_type,quantity,unit,received_sales_qty) VALUES($1,$1,1,8123,'CO cargo','InvtPart',4,'EA',1)",[coId]);
}
test("a CO with a verified complete source becomes Loaded without changing cargo or receiving quantities",()=>scenario(async()=>{
  await seed();
  const before=await readCoCleanupState();
  const plan=createCoCleanupManifest(before,remote,{candidateIds:[String(coId)]});
  assert.equal(plan.entries.length,1);
  const result=await applyCoCleanupManifest(plan);
  assert.equal(result.changedCos,1);
  const order=await getDeliveryOrder("CO-CLEANUP-SOURCE");
  assert.equal(order.operator_status,"loaded");
  assert.equal(order.local_yard_order_status,"Loaded");
  assert.equal(order.lines[0].loaded_qty,4);
  const after=await readCoCleanupState();
  assert.deepEqual(after.lines,before.lines);
  assert.deepEqual(after.so.protected,before.so.protected);
  assert.equal((await applyCoCleanupManifest(plan)).changedCos,0);
}));
test("incomplete, skipped, and actively prepared CO sources remain untouched; stale COs abort",()=>scenario(async()=>{
  await seed();
  const before=await readCoCleanupState();
  assert.equal(createCoCleanupManifest(before,{...remote,rows:[]},{candidateIds:[String(coId)]}).entries.length,0);
  assert.equal(createCoCleanupManifest(before,remote,{candidateIds:[String(coId)],skipSourceRefs:[sourceRef]}).entries.length,0);
  const plan=createCoCleanupManifest(before,remote,{candidateIds:[String(coId)]});
  await query("UPDATE local_co_order_lines SET quantity=5 WHERE co_id=$1",[coId]);
  await assert.rejects(applyCoCleanupManifest(plan),/stale|changed/i);
  assert.equal((await query("SELECT status FROM local_co_orders WHERE id=$1",[coId])).rows[0].status,"pending_load");
}));
