// Data-only support correction. Default: rehearse and roll back. --verify: read only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { query,withTransaction,closeDb } from "/app/src/db.js";
import { lockConsolidatedLoadOrders } from "/app/src/consolidation-load-locks.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "/app/src/dispatch-fleet-status.js";
import { writeAudit } from "/app/src/auth-repository.js";
import { listDispatchOrders } from "/app/src/dispatch-repository.js";
import { listControlLoadedOrders } from "/app/src/delivery-repository.js";
import { movementRecordEvidence } from "/app/src/movement-record-evidence.js";
import { upsertDispatchOrderCatalog,getDispatchOrderCatalogOrder,enqueueDispatchOrderCatalogRefresh } from "/app/src/dispatch-order-catalog-repository.js";
const repairId="som06257-reopen-20261001", ref="SOM06257", orderId="980546", recordId="1099";
const rows=async(sql,params=[]) => (await query(sql,params)).rows;
const omit=(row,fields)=>Object.fromEntries(Object.entries(row).filter(([key])=>!fields.includes(key)));
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function capture(lock=false) {
  const suffix=lock?" FOR UPDATE NOWAIT":"";
  return {
    order:(await rows(`SELECT * FROM sales_orders WHERE netsuite_id=$1${suffix}`,[orderId]))[0],
    lines:await rows(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id${suffix}`,[orderId]),
    loads:await rows(`SELECT * FROM operator_load_records WHERE order_id=$1 ORDER BY id${suffix}`,[orderId]),
    completions:await rows("SELECT * FROM dispatch_order_completion_status WHERE order_ref=$1 ORDER BY completion_event_id",[ref]),
    assignments:await rows("SELECT * FROM dispatch_plan_order_assignments WHERE order_ref=$1 ORDER BY plan_id",[ref]),
    drivers:await rows("SELECT id,md5(row_to_json(r)::text) hash FROM driver_job_records r WHERE order_refs::text LIKE '%SOM06257%' ORDER BY id"),
    groups:await rows("SELECT g.group_ref,g.active,m.member_order_ref FROM dispatch_global_order_groups g JOIN dispatch_global_order_group_members m ON m.group_ref=g.group_ref WHERE m.member_order_ref=$1 ORDER BY g.group_ref",[ref])
  };
}
async function acquireLocks() {
  await query("SET LOCAL statement_timeout='30s'");
  await query("SET LOCAL lock_timeout='25s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
  await query("SET LOCAL lock_timeout='5s'");
  await query("SELECT order_ref FROM dispatch_order_catalog_entries WHERE order_ref=$1 FOR UPDATE NOWAIT",[ref]);
  await query("SELECT singleton FROM dispatch_order_catalog_state WHERE singleton=true FOR UPDATE NOWAIT");
  await lockConsolidatedLoadOrders([orderId]);
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`dispatch-global-source-refresh:${ref.toLowerCase()}`]);
}
async function validate(before) {
  assert.equal(before.order.tranid,ref); assert.equal(before.order.operator_status,"loaded");
  assert.equal(before.order.fulfillment_status,"not_fulfilled"); assert.equal(before.order.preparing_operator_id,null);
  assert.equal(before.order.last_item_fulfillment_id,null); assert.equal(before.completions.length,0);
  assert.equal(before.assignments.length,0); assert.equal(before.loads.length,1);
  assert.equal(before.loads[0].id,recordId); assert.equal(before.loads[0].load_type,"sales_order_delivery_load");
  assert.equal(before.loads[0].order_ref,ref); assert.equal(before.loads[0].reload_cycle_id,null);
  assert.equal(before.lines.length,2); assert.equal(Number(before.lines.find(l=>l.id==="412420").loaded_qty),29);
  for(const line of before.lines) {
    for(const field of ["packed_sales_qty","packed_pallet_qty","packed_layer_qty","packed_piece_qty","packed_section_qty"]) { assert.equal(Number(line[field]),0); }
  }
  assert.equal((await rows("SELECT id FROM operator_reload_cycles WHERE source_load_record_id=$1 OR (sales_order_id=$2 AND status IN ('authorized','preparing','packed','in_progress'))",[recordId,orderId])).length,0);
  assert.equal((await rows("SELECT local_order_key FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=ANY($1::text[])",[[orderId,`sales_order:${orderId}`]])).length,0);
  assert.equal((await rows("SELECT id FROM operator_netsuite_posting_commands WHERE status IN ('pending','posting','finalizing') AND input_snapshot::text LIKE '%SOM06257%'")).length,0);
}
async function verify(before=null) {
  const after=await capture();
  assert.equal(after.order.operator_status,"open"); assert.equal(after.order.local_yard_order_status,"Open");
  assert.ok(after.lines.every(l=>Number(l.loaded_qty)===0));
  assert.equal(after.loads[0].load_type,"voided_sales_order_delivery_load");
  assert.equal(after.loads[0].response.localYardOrderStatus,"Voided");
  assert.equal(after.loads[0].response.supportCorrection.repairId,repairId);
  if(before) {
    assert.deepEqual(omit(after.order,["operator_status","local_yard_order_status","status_updated_at"]),omit(before.order,["operator_status","local_yard_order_status","status_updated_at"]));
    assert.deepEqual(after.lines.map(l=>omit(l,["loaded_qty"])),before.lines.map(l=>omit(l,["loaded_qty"])));
    assert.deepEqual(omit(after.loads[0],["load_type","response"]),omit(before.loads[0],["load_type","response"]));
    for(const field of ["completions","assignments","drivers","groups"]) { assert.deepEqual(after[field],before[field]); }
  }
  const source=(await listDispatchOrders({type:"SO",exactOrderRefs:[ref]})).find(o=>o.id===ref);
  const detail=await getDispatchOrderCatalogOrder(ref);
  for(const order of [source,detail]) { assert.ok(order);assert.equal(order.operatorStatus,"open");assert.equal(order.localYardOrderStatus,"Open"); }
  assert.equal((await listControlLoadedOrders({from:"2026-09-15",to:"2026-09-15",search:ref})).length,0);
  const evidence=await movementRecordEvidence({loadIds:[recordId]});
  assert.equal(evidence.get(`load-${recordId}`).waitingForDriverCompletion,false);
  return {orderRef:ref,status:"open",loadedQuantity:0,voidedRecordId:recordId,originalPhotosRetained:after.loads[0].photo_data_urls.length,sourceAndCatalogVerified:true,absentFromLoadedOrders:true};
}
const apply=process.argv.includes("--apply"), readOnly=process.argv.includes("--verify");
try {
  const result=await withTransaction(async()=>{
    if(readOnly) { await query("SET TRANSACTION READ ONLY");return {mode:"live-read-only-postcheck",...await verify()}; }
    await acquireLocks();
    const before=await capture(true);
    await validate(before);
    const beforeHash=digest(before);
    if(apply) { assert.equal(beforeHash,process.argv[process.argv.indexOf("--apply")+1],"Target data changed since rehearsal"); }
    let backup=null;
    if(apply) {
      await mkdir("/app/data/support-fixes",{recursive:true,mode:0o700});
      backup=`/app/data/support-fixes/${repairId}-${Date.now()}.json`;
      await writeFile(backup,JSON.stringify({repairId,beforeHash,before},null,2),{mode:0o600,flag:"wx"});
    }
    const correction={repairId,reason:"User confirmed SOM06257 is not loaded and requested reopening",originalLoadType:before.loads[0].load_type};
    await query(`UPDATE operator_load_records SET load_type='voided_sales_order_delivery_load',
      response=response||jsonb_build_object('localYardOrderStatus','Voided','supportCorrection',$2::jsonb)
      WHERE id=$1 AND order_id=$3`,[recordId,JSON.stringify(correction),orderId]);
    await query("UPDATE sales_order_lines SET loaded_qty=0 WHERE sales_order_id=$1",[orderId]);
    await query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',status_updated_at=now() WHERE netsuite_id=$1",[orderId]);
    const orders=await listDispatchOrders({type:"SO",exactOrderRefs:[ref]});
    await upsertDispatchOrderCatalog({orders,source:repairId});
    const checked=await verify(before);
    await writeAudit({actorType:"system",source:"user-confirmed-correction",action:"delivery.order.load.voided_and_reopened",orderId,
      details:{...correction,backup,originalRecord:before.loads[0],beforeOrder:before.order,beforeLines:before.lines,after:checked}});
    return {mode:apply?"applied":"rehearsed-and-rolled-back",beforeHash,backup,...checked};
  },{rollback:!apply});
  if(apply) { result.refresh=await enqueueDispatchOrderCatalogRefresh({orderRef:ref,orderType:"SO",source:repairId}); }
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
