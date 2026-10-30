import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {beginRollbackContext,closeDb,query,withIndependentTransaction} from '../../../src/db.js';
import {repairGob122647EmptyPickup} from '../../../tools/repair-gob122647-empty-pickup.mjs';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../../../src/dispatch-fleet-status.js';
after(closeDb);
const ref='GOB-122647-122650-122835-123218';
const loadId='T5-L1792753570068-aa81f1d2f81b98';
const emptyId='stop-cbbe6b8f-7721-46bc-aac0-e04d671257fd';
async function fixture(fn){
 const rollback=await beginRollbackContext();
 try{return await rollback.run(async()=>{
  const refs=['SOB122647','SOB122650','SOB122835','SOB123218'];
  const children=[];
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,dispatch_vendor_yard,dispatch_address,netsuite_active) VALUES(9800000001,'PO-GOB-FIXTURE','Techo','TECHO BLOC Vaughan','Test vendor',true)");
  for(const [i,id] of refs.entries()){
   const ns=9800000010+i;
   await query("INSERT INTO sales_orders(netsuite_id,tranid,customer,status,netsuite_active,sales_order_type) VALUES($1,$2,'Test customer','B',true,'Delivery')",[ns,id]);
   const line=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,pallet_qty,netsuite_active) VALUES($1,1,2055,'MBBS-Special Order',100,'SQFT',5,true) RETURNING id",[ns])).rows[0];
   const poLine=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES(9800000001,$1,2055,'MBBS-Special Order',100,'SQFT',true) RETURNING id",[i+1])).rows[0];
   await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,status,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
    VALUES($1,$2,$3,9800000001,'PO-GOB-FIXTURE',$4,2055,'MBBS-Special Order','MBBS-Special Order',100,'active',$5,'group',$6)`,[ns,id,line.id,poLine.id,ref,`${ref}::${id}::${line.id}`]);
   children.push({id,type:'SO',sourceYard:'3445',sourceTable:'sales_orders',pickupLocations:['3445','TECHO BLOC Vaughan'],address:'Test customer',items:[{lineRowId:line.id,itemId:2055,sku:'MBBS-Special Order',quantity:100,unit:'SQFT',pallets:5,poAllocatedSalesQty:100,poAllocatedPallets:0}]});
  }
  const group={...children[0],id:ref,childOrders:refs,childOrderDetails:children,items:children.flatMap(c=>c.items)};
  const stops=[{id:'vendor',type:'pick',orderId:ref,orderRefs:[ref],location:'TECHO BLOC Vaughan'},
   {id:emptyId,type:'pick',orderId:ref,orderRefs:[ref],location:'3445'},
   {id:'customer',type:'drop',orderId:ref,location:'Test customer'}];
  const trucks=[{id:'T5',loads:[{id:loadId,driverLogin:'fixture',stops}]}];
  await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES(367,'2026-10-23','confirmed',104)");
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES(367,$1::jsonb,$2::jsonb,'{}')",[JSON.stringify([group]),JSON.stringify(trucks)]);
  await query("INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card) VALUES($1,'SO',367,'2026-10-23',$2::jsonb,$2::jsonb)",[ref,JSON.stringify(group)]);
  for(const [i,id] of refs.entries())await query('INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)',[ref,id,i]);
  const jobs=[
   ['vendor','pickup','complete',[{orderRef:refs[0],items:[{sku:'Special',units:[{unit:'SQFT',value:400}]}]}]],
   [emptyId,'pickup','complete',refs.map(orderRef=>({orderRef,items:[]}))],
   ['customer','dropoff','in_progress',[]]
  ];
  for(const [stop,type,status,orders] of jobs){
   await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES($1,367,'2026-10-23','fixture','T5','TEST',$2,$3,$4,$5::jsonb,$6,now(),CASE WHEN $6='complete' THEN now() ELSE NULL END,$7::jsonb)`,['fixture-'+stop,loadId,stop,type,JSON.stringify(refs),status,JSON.stringify({location:stop===emptyId?'3445':stop,orders})]);
  }
  const snapshot=async()=>({plan:(await query('SELECT p.revision,s.orders,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=367')).rows[0],jobs:(await query('SELECT * FROM driver_job_records WHERE plan_id=367 ORDER BY id')).rows});
  return fn({snapshot});
 });}finally{await rollback.rollback();}
}
test('authorized empty pickup repair removes only that stop and retains original driver evidence',()=>fixture(async({snapshot})=>{
 const before=await snapshot();
 const result=await repairGob122647EmptyPickup({apply:true,expectedRevision:104});
 assert.equal(result.applied,true);
 const after=await snapshot();
 assert.equal(Number(after.plan.revision),105);
 assert.deepEqual(after.plan.trucks[0].loads[0].stops,before.plan.trucks[0].loads[0].stops.filter(s=>s.id!==emptyId));
 assert.deepEqual(after.jobs.filter(j=>j.stop_id!==emptyId),before.jobs.filter(j=>j.stop_id!==emptyId));
 const job=after.jobs.find(j=>j.stop_id===emptyId),prior=before.jobs.find(j=>j.stop_id===emptyId);
 assert.equal(job.status,'superseded');assert.deepEqual(job.started_at,prior.started_at);assert.deepEqual(job.completed_at,prior.completed_at);
 assert.deepEqual(job.job_details.orders,prior.job_details.orders);
 assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE action='dispatch.empty_pickup_corrected'")).rows[0].n,1);
 const lock=await withIndependentTransaction(async execute=>(await execute('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held',[DISPATCH_FLEET_PLANNING_LOCK])).rows[0]);
 assert.equal(lock.held,false);
 assert.equal((await repairGob122647EmptyPickup({apply:true})).alreadyCorrect,true);
 assert.deepEqual(await snapshot(),after);
}));
test('preview and stale revisions leave route and execution unchanged',()=>fixture(async({snapshot})=>{
 const before=await snapshot();assert.equal((await repairGob122647EmptyPickup()).rolledBack,true);assert.deepEqual(await snapshot(),before);
 await assert.rejects(repairGob122647EmptyPickup({apply:true,expectedRevision:103}),/revision/iu);assert.deepEqual(await snapshot(),before);
}));
test('a real residual source quantity or recorded cargo refuses the one-off removal',()=>fixture(async({snapshot})=>{
 await query('UPDATE dispatch_so_po_allocations SET allocated_sales_qty=50 WHERE id=(SELECT min(id) FROM dispatch_so_po_allocations)');
 const before=await snapshot();await assert.rejects(repairGob122647EmptyPickup({apply:true}),/cargo|pickup/iu);assert.deepEqual(await snapshot(),before);
 await query('UPDATE dispatch_so_po_allocations SET allocated_sales_qty=100');
 await query("UPDATE driver_job_records SET job_details=jsonb_set(job_details,'{orders}', '[{\"items\":[{\"units\":[{\"value\":1}]}]}]') WHERE stop_id=$1",[emptyId]);
 await assert.rejects(repairGob122647EmptyPickup({apply:true}),/recorded cargo/iu);
}));
test('audit failure rolls back stop, driver status, catalog and plan revision together',()=>fixture(async({snapshot})=>{
 const before=await snapshot();
 await query("CREATE FUNCTION pg_temp.fail_pickup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='dispatch.empty_pickup_corrected' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$");
 await query('CREATE TRIGGER fail_pickup_audit BEFORE INSERT ON dispatch_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_pickup_audit()');
 await assert.rejects(repairGob122647EmptyPickup({apply:true}),/injected audit failure/iu);assert.deepEqual(await snapshot(),before);
}));
