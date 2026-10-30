import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {query,beginRollbackContext,closeDb} from '../../../src/db.js';
import {repairLinkedPoPickup} from '../../../tools/linked-po-pickup-repair.mjs';
after(closeDb);
const planId=371,ref='GOM-6894S1-6895S1',loadId='T5-L1793132738472-54642beda6e9b';
const stopId='stop-8ee7d1bd-4c91-4764-97f3-0bcad5954b17';
async function seed() {
 const so=888000001,po=888000002,childRef='SOM06895-S1';
 await query("INSERT INTO sales_orders(netsuite_id,tranid,customer,netsuite_active) VALUES($1,$2,'Test customer',true)",[so,childRef]);
 const line=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,1,1784,'PALLET',21,'EACH',true) RETURNING id",[so])).rows[0];
 await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,dispatch_vendor_yard,netsuite_active) VALUES($1,'LOINC-038227','Test vendor','TECHO BLOC Vaughan',true)",[po]);
 const pl=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,1,1784,'PALLET',21,'EACH',true) RETURNING id",[po])).rows[0];
 await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,allocated_sales_qty,allocated_piece_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
 VALUES($1,$2,$3,$4,'LOINC-038227',$5,1784,'PALLET',21,21,$6,'group',$7)`,[so,childRef,line.id,po,pl.id,ref,`${ref}::${childRef}::${line.id}`]);
 const child={id:childRef,type:'SO',sourceYard:'150',pickupLocations:['150'],items:[{lineRowId:String(line.id),itemId:1784,sku:'PALLET',unit:'EACH',quantity:21,pallets:0,pieces:0}]};
 const order={...child,id:ref,childOrders:[childRef],childOrderDetails:[child],poPickupManifest:[{poOrderRef:'LOINC-038227',location:'TECHO BLOC Vaughan',items:[{itemId:1784,quantity:21,unit:'EACH'}]}]};
 const stops=[{id:'vendor',type:'pick',location:'TECHO BLOC Vaughan',orderId:ref,orderRefs:[ref],arriveTime:500,departTime:530},
  {id:stopId,type:'pick',location:'150',orderId:ref,orderRefs:[ref]},
  {id:'delivery',type:'drop',location:'Customer',orderId:ref},
  {id:'real-transfer',type:'pick',location:'150',orderId:'TOB01269',orderRefs:['TOB01269']},
  {id:'transfer-delivery',type:'drop',location:'2967',orderId:'TOB01269'}];
 await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,'2098-10-28','confirmed',37)",[planId]);
 await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks) VALUES($1,$2::jsonb,$3::jsonb)",[planId,JSON.stringify([order,{id:'TOB01269',type:'TO',sourceYard:'150',pickupLocations:['150'],items:[{quantity:1,unit:'EACH'}]}]),JSON.stringify([{id:'T5',plate:'CC46868',loads:[{id:loadId,name:'Load 2',stops,routeEstimate:{minutes:123}}]}])]);
 await query("INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_date,full_order,card) VALUES($1,'SO','2098-10-28',$2::jsonb,$2::jsonb)",[ref,JSON.stringify(order)]);
 await query("INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,stop_id,stop_type,status,started_at,completed_at) VALUES('fixture-vendor',$1,'2098-10-28','test-driver',$2,'vendor','pickup','in_progress',now(),NULL)",[planId,loadId]);
}
async function snapshot() {
 return {
  plans:(await query('SELECT * FROM dispatch_plans WHERE id=$1',[planId])).rows,
  snapshots:(await query('SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1',[planId])).rows,
  groups:(await query('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1',[ref])).rows,
  records:(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[planId])).rows,
  audits:(await query('SELECT * FROM dispatch_audit_log WHERE plan_id=$1 ORDER BY id',[planId])).rows
 };
}
async function rolledBack(run) {const tx=await beginRollbackContext();try{await tx.run(async()=>{await seed();await run();});}finally{await tx.rollback();}}

test('repair preview rolls back, apply preserves started work and real TO pickup, retry is idempotent',()=>rolledBack(async()=>{
 const before=await snapshot(),preview=await repairLinkedPoPickup({expectedRevision:37});
 assert.equal(preview.rolledBack,true);assert.deepEqual(await snapshot(),before);
 const applied=await repairLinkedPoPickup({apply:true,expectedRevision:37});
 assert.equal(applied.removedStopId,stopId);assert.equal(applied.revision,38);
 const after=await snapshot(),stops=after.snapshots[0].trucks[0].loads[0].stops;
 assert.deepEqual(stops.map(s=>s.id),['vendor','delivery','real-transfer','transfer-delivery']);
 assert.deepEqual(stops[0],before.snapshots[0].trucks[0].loads[0].stops[0]);
 assert.deepEqual(after.records,before.records);assert.equal(after.audits.length,1);
 assert.equal(after.groups[0].full_order.items[0].poAllocatedSalesQty,21);
 assert.equal((await repairLinkedPoPickup({apply:true,expectedRevision:38})).alreadyCorrect,true);
 assert.deepEqual(await snapshot(),after);
}));
test('repair refuses a stale revision or active travel into the target and makes no changes',()=>rolledBack(async()=>{
 const before=await snapshot();await assert.rejects(repairLinkedPoPickup({apply:true,expectedRevision:36}),/revision changed/i);assert.deepEqual(await snapshot(),before);
 await query("INSERT INTO driver_job_records(job_id,plan_id,driver_login,load_id,stop_id,stop_type,status,started_at,completed_at,job_details) VALUES('fixture-travel',$1,'test-driver',$2,'travel-target','travel','in_progress',now(),NULL,$3::jsonb)",[planId,loadId,JSON.stringify({toStopId:stopId})]);
 const active=await snapshot();await assert.rejects(repairLinkedPoPickup({apply:true,expectedRevision:37}),/protected|started/i);assert.deepEqual(await snapshot(),active);
}));
test('audit failure rolls back both the plan correction and the catalog correction',()=>rolledBack(async()=>{
 await query("CREATE FUNCTION fail_linked_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$");
 await query('CREATE TRIGGER fail_linked_repair_audit BEFORE INSERT ON dispatch_audit_log FOR EACH ROW EXECUTE FUNCTION fail_linked_repair_audit()');
 const before=await snapshot();await assert.rejects(repairLinkedPoPickup({apply:true,expectedRevision:37}),/injected audit failure/);assert.deepEqual(await snapshot(),before);
}));
test('concurrent corrections serialize and only one revision and audit are written',async()=>{
 await seed();
 const results=await Promise.allSettled([repairLinkedPoPickup({apply:true,expectedRevision:37}),repairLinkedPoPickup({apply:true,expectedRevision:37})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const after=await snapshot();assert.equal(Number(after.plans[0].revision),38);assert.equal(after.audits.length,1);
});
