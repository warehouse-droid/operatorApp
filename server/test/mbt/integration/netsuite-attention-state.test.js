import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import crypto from 'node:crypto';
import {beginRollbackContext,closeDb,query} from '../../../src/db.js';
import {prepareSalesOrderAutoFulfillmentCandidate,markSalesOrderAutoFulfillmentAttention,listRunnableSalesOrderAutoFulfillmentCandidateIds}
  from '../../../src/sales-order-auto-fulfillment-repository.js';
after(closeDb);
async function fixture(work) {
 const rollback=await beginRollbackContext();
 try {await rollback.run(async()=>{
  const id=9800000000+Math.floor(Math.random()*1000000),ref=`SO-ATTN-${crypto.randomUUID()}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active)
    VALUES($1,$2,NULL,true)`,[id,ref]);
  const event=(await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
    completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
    VALUES('SO',$1,now(),'driver_job',$2,'driver','attention-test','') RETURNING id`,[ref,crypto.randomUUID()])).rows[0];
  const candidate=(await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE completion_event_id=$1',[event.id])).rows[0];
  await work(candidate.id);
 });}finally{await rollback.rollback();}
}
test('unsupported yard attention retains the exact actionable reason',async()=>fixture(async id=>{
 const result=await prepareSalesOrderAutoFulfillmentCandidate(id);
 assert.equal(result.status,'attention');
 assert.equal(result.lastError,'The completed SO has no supported outbound yard.');
}));
for(const state of ['queued','uncertain']) {
 test(`unverified recovery from ${state} retains uncertainty and payload`,async()=>fixture(async id=>{
  await query(`UPDATE dispatch_sales_order_if_candidates SET status=$2,payload='{"externalId":"retained"}' WHERE id=$1`,[id,state]);
  const result=await markSalesOrderAutoFulfillmentAttention({candidateId:id,recoveryRequired:true,error:'Lookup unavailable'});
  assert.equal(result.status,'uncertain');
  assert.deepEqual(result.payload,{externalId:'retained'});
  assert.equal(result.lastError,'Lookup unavailable');
  const events=(await query('SELECT action FROM dispatch_sales_order_if_audit_events WHERE candidate_id=$1 ORDER BY id DESC',[id])).rows;
  assert.equal(events[0].action,'recovery_unverified');
 }));
}
test('late recovery lookup failure cannot overwrite a completed or leased candidate',async()=>fixture(async id=>{
 for(const state of ['completed','posting']) {
  await query(`UPDATE dispatch_sales_order_if_candidates SET status=$2,
    netsuite_transaction_id=9001,completed_at=CASE WHEN $2='completed' THEN now() END,
    lease_owner=CASE WHEN $2='posting' THEN 'other-worker' END,
    lease_token=CASE WHEN $2='posting' THEN gen_random_uuid() END,
    lease_expires_at=CASE WHEN $2='posting' THEN now()+interval '3 minutes' END WHERE id=$1`,[id,state]);
  const result=await markSalesOrderAutoFulfillmentAttention({candidateId:id,recoveryRequired:true,error:'late lookup failure'});
  assert.equal(result.status,state);
 }
}));

test('waiting work cannot starve newly ready candidates behind the polling limit',async()=>fixture(async id=>{
 await query(`UPDATE dispatch_sales_order_if_candidates SET status='skipped',completed_at=NULL,
   lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL`);
 await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
   completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
   SELECT 'SO','SO-WAIT-'||n,now(),'driver_job',gen_random_uuid()::text,'driver','attention-test',''
   FROM generate_series(1,30) n`);
 await query(`UPDATE dispatch_sales_order_if_candidates SET status='waiting_evidence',created_at=now()-interval '1 day',updated_at=now()-interval '1 day'
   WHERE status='discovered'`);
 await query(`UPDATE dispatch_sales_order_if_candidates SET status='queued',created_at=now(),updated_at=now() WHERE id=$1`,[id]);
 const selected=await listRunnableSalesOrderAutoFulfillmentCandidateIds({limit:3});
 assert.equal(selected[0],id);
}));

test('registered first split uses its bounded planned quantity and resumes only after Operator proof',async()=>fixture(async baseId=>{
 const source=(await query(`SELECT o.netsuite_id,o.tranid FROM dispatch_sales_order_if_candidates c
   JOIN dispatch_order_completion_events e ON e.id=c.completion_event_id JOIN sales_orders o ON o.tranid=e.order_ref WHERE c.id=$1`,[baseId])).rows[0];
 await query(`UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1`,[source.netsuite_id]);
 await query(`UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='dispatch_netsuite_sales_order_if_3445'`);
 const line=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,
   quantity,unit,location_id,loaded_qty,netsuite_active) VALUES($1,5001,1,1784,'PALLET','PALLET','InvtPart',41,'EACH',1,0,true) RETURNING id`,[source.netsuite_id])).rows[0];
 const ref=source.tranid+'-S1';
 const definition={items:[{lineId:5001,lineRowId:Number(line.id),itemId:1784,itemType:'InvtPart',quantity:19,splitQty:19}]};
 await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card)
   VALUES($1,'SO',$2,current_date,$3::jsonb,'{}')`,[ref,source.tranid,JSON.stringify(definition)]);
 const event=(await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
   completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
   VALUES('SO',$1,now(),'driver_job',$2,'driver','test','') RETURNING id`,[ref,crypto.randomUUID()])).rows[0];
 const candidate=(await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE completion_event_id=$1',[event.id])).rows[0];
 const waiting=await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
 assert.equal(waiting.status,'waiting_evidence');
 assert.equal(waiting.sourceSalesOrderId,Number(source.netsuite_id));
 await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,line_snapshot,response)
   VALUES('sales_order_delivery_load','sales_order',$1,$2,'[{"lineId":5001,"loadedQty":19}]','{}')`,[source.netsuite_id,source.tranid]);
 const ready=await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
 assert.equal(ready.status,'queued');assert.equal(ready.isSplit,true);
 assert.equal(ready.lineSnapshot[0].targetQuantity,19);assert.equal(ready.lineSnapshot[0].deliveredQuantity,19);
 await query(`UPDATE dispatch_sales_order_if_gate_watermarks SET activation_event_id=$1 WHERE gate_key='dispatch_netsuite_sales_order_if_3445'`,[event.id]);
 await query(`UPDATE dispatch_sales_order_if_candidates SET resolution_action='custom',resolution_reason='Reviewed exact remaining quantity' WHERE id=$1`,[candidate.id]);
 assert.equal((await prepareSalesOrderAutoFulfillmentCandidate(candidate.id)).status,'queued',
  'An audited Admin action has the same historical authorization in preparation and claim');
}));
