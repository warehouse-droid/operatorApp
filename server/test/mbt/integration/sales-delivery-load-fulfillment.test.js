// @ts-check
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import fc from 'fast-check';
import test, {after} from 'node:test';
import {beginRollbackContext, closeDb, query, withTransaction} from '../../../src/db.js';
import {prepareSalesOrderAutoFulfillmentCandidate, claimSalesOrderAutoFulfillmentCandidate,
  listSalesOrderAutoFulfillmentCandidates,queueHistoricalSalesOrderAutoFulfillmentCandidates} from '../../../src/sales-order-auto-fulfillment-repository.js';
import {recordDeliveryLoad} from '../../../src/delivery-repository.js';
import {movementRecordEvidence} from '../../../src/movement-record-evidence.js';

after(closeDb);
async function rollback(work) {
  const context = await beginRollbackContext();
  try {await context.run(work);} finally {await context.rollback();}
}
async function seed() {
  const id = 9_840_000_000 + crypto.randomInt(100_000_000);
  const ref = `SO-LOAD-${crypto.randomUUID()}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,outbound_location_id,
    outbound_location,sales_order_type,operator_status,netsuite_active)
    VALUES($1,$2,'Load fixture','B','Pending Fulfillment',15,'12441','Delivery','loaded',true)`,[id,ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,location_id,loaded_qty,netsuite_active) VALUES($1,10,101,'Stone','STONE','InvtPart',10,'EA',15,10,true)`,[id]);
  await gate(true);
  return {id,ref};
}
async function gate(enabled) {
  await query(`UPDATE mbt_feature_flags SET enabled=$1,revision=revision+1 WHERE flag_key='dispatch_netsuite_sales_order_if_12441'`,[enabled]);
}
async function load(order, quantity, extra = {}) {
  const result = await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,line_snapshot,response)
    VALUES($1,$2,$3,$4,$5::jsonb,'{}') RETURNING id`,
  [extra.type || 'sales_order_delivery_load',extra.family || 'sales_order',order.id,order.ref,
    JSON.stringify([{lineId:10,itemId:101,loadedQty:quantity,loadedUom:'EA'}])]);
  return String(result.rows[0].id);
}
async function candidate(order, recordId) {
  const rows = await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1 ORDER BY created_at,id',[order.ref]);
  const row = recordId ? rows.rows.find(value => String(value.operator_load_record_id) === recordId) : rows.rows[0];
  assert.ok(row,'an Operator load must create a durable IF candidate before any Driver completion');
  return row;
}
async function completeDriver(order) {
  await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_plate,load_id,load_name,stop_id,
    stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,current_date,'load-test','TEST',$2,'Load','stop','dropoff',$3::jsonb,'complete',now(),$4::jsonb)`,
  [crypto.randomUUID(),crypto.randomUUID(),JSON.stringify([order.ref]),JSON.stringify({orders:[{orderType:'SO',orderRef:order.ref}],location:'Customer',dropLocation:'Customer'})]);
  return (await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1 AND completion_event_id IS NOT NULL',[order.ref])).rows[0];
}
const claim = value => claimSalesOrderAutoFulfillmentCandidate({candidateId:value.id,workerId:'load-test',
  payload:{externalId:value.externalId,item:{items:[]}},liveOrder:{lines:[]},selectedLines:[]});

test('load queues IF before Driver completion and keeps its saved quantity after mutable edits',async()=>rollback(async()=>{
  const order=await seed(), recordId=await load(order,4), row=await candidate(order,recordId);
  assert.equal(row.completion_event_id,null);
  await query('UPDATE sales_order_lines SET loaded_qty=9 WHERE sales_order_id=$1',[order.id]);
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
  assert.equal(ready.status,'queued');
  assert.equal(ready.operatorLoadRecordId,recordId);
  assert.equal(ready.lineSnapshot[0].deliveredQuantity,4);
  assert.equal(ready.lineSnapshot[0].operatorLoadRecordId,recordId);
  assert.equal((await claim(ready)).status,'posting');
  assert.equal(await claim(ready),null,'the same queued work has one posting owner');
}));

test('partial loads queue only new quantities and a repeated load has no new IF',async()=>rollback(async()=>{
  const order=await seed();
  const first=await candidate(order,await load(order,4));
  const second=await candidate(order,await load(order,10));
  const repeated=await candidate(order,await load(order,10));
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(first.id);
  assert.equal(ready.lineSnapshot[0].deliveredQuantity,4);
  // A later load waits for the first owner to finish; do not bypass its line claim.
  assert.equal((await prepareSalesOrderAutoFulfillmentCandidate(second.id)).status,'waiting_evidence');
  await query('UPDATE dispatch_sales_order_if_line_claims SET active=false,released_at=now() WHERE candidate_id=$1',[first.id]);
  assert.equal((await prepareSalesOrderAutoFulfillmentCandidate(second.id)).lineSnapshot[0].deliveredQuantity,6);
  assert.equal((await prepareSalesOrderAutoFulfillmentCandidate(repeated.id)).status,'skipped');
}));

test('property: cumulative load sequences never enqueue more or less than their maximum loaded quantity',async()=>{
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({min:0,max:10}),{minLength:1,maxLength:8}),async amounts=>rollback(async()=>{
    const order=await seed();
    let queued=0;
    for(const amount of amounts) {
      const row=await candidate(order,await load(order,amount));
      queued+=row.operator_load_snapshot[0].quantity;
    }
    assert.equal(queued,Math.max(...amounts));
  })),{seed:20261021,numRuns:25});
});

test('concurrent workers claim a saved load once across separate database transactions',async()=>{
  const order=await seed();
  try {
    const row=await candidate(order,await load(order,4));
    const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
    const attempts=await Promise.all(Array.from({length:8},()=>claim(ready)));
    assert.equal(attempts.filter(Boolean).length,1);
    assert.equal(attempts.find(Boolean).status,'posting');
  } finally {await gate(false);}
});

test('Driver completion is evidence only and cannot create a second IF candidate',async()=>rollback(async()=>{
  const order=await seed();
  await candidate(order,await load(order,10));
  const driver=await completeDriver(order);
  assert.equal(driver,undefined);
  assert.equal((await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref])).rowCount,1);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,1);
}));

test('Driver completion without any Operator load creates evidence but no IF work',async()=>rollback(async()=>{
  const order=await seed();
  assert.equal(await completeDriver(order),undefined);
  assert.equal((await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref])).rowCount,1);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,0);
  const events=await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref]);
  await assert.rejects(queueHistoricalSalesOrderAutoFulfillmentCandidates({completionEventIds:[events.rows[0].id],
    actorId:'test-admin',reason:'This new Driver event must remain evidence only'}),/No eligible historical SO completion/);
}));

test('untouched legacy Driver candidates stop without posting and release their line claim',async()=>rollback(async()=>{
  const order=await seed();
  await completeDriver(order);
  const event=(await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref])).rows[0];
  const id=crypto.randomUUID();
  await query(`INSERT INTO dispatch_sales_order_if_candidates(id,completion_event_id,dispatch_order_ref,external_id)
    VALUES($1,$2,$3,$4)`,[id,event.id,order.ref,`MBBS-SOIF-${id}`]);
  const line=(await query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[order.id])).rows[0];
  await query(`INSERT INTO dispatch_sales_order_if_line_claims(candidate_id,source_sales_order_id,source_line_id,order_line,claimed_quantity)
    VALUES($1,$2,$3,10,4)`,[id,order.id,line.id]);
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(id);
  assert.equal(ready.status,'attention');
  assert.equal(ready.result.reason,'driver_completion_evidence_only');
  assert.equal((await query('SELECT active FROM dispatch_sales_order_if_line_claims WHERE candidate_id=$1',[id])).rows[0].active,false);
  assert.equal((await query('SELECT id FROM dispatch_order_completion_events WHERE id=$1',[event.id])).rowCount,1);
}));

test('migration retires only untouched automatic work and preserves attempted transactions and evidence',async()=>rollback(async()=>{
  const fixtures=[];
  for(const [status,attempts,action] of [['queued',0,'automatic'],['uncertain',1,'automatic'],['queued',1,'recover'],['queued',0,'historical_backfill']]) {
    const order=await seed();
    await completeDriver(order);
    const event=(await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref])).rows[0];
    const id=crypto.randomUUID();
    await query(`INSERT INTO dispatch_sales_order_if_candidates(id,completion_event_id,dispatch_order_ref,external_id,status,attempt_count,resolution_action)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,event.id,order.ref,`MBBS-SOIF-${id}`,status,attempts,action]);
    fixtures.push({id,eventId:event.id,status,attempts,action});
  }
  const migration=readFileSync(new URL('../../../migrations/301_sales_order_operator_load_fulfillment.sql',import.meta.url),'utf8');
  await query(migration.slice(migration.indexOf('WITH retired AS'),migration.indexOf('CREATE OR REPLACE FUNCTION operator_enqueue')));
  for(const fixture of fixtures) {
    const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1',[fixture.id])).rows[0];
    assert.equal(row.status,fixture.attempts===0 && fixture.action==='automatic'?'attention':fixture.status);
    assert.equal(Number(row.attempt_count),fixture.attempts);
    assert.equal(row.external_id,`MBBS-SOIF-${fixture.id}`);
    assert.equal((await query('SELECT id FROM dispatch_order_completion_events WHERE id=$1',[fixture.eventId])).rowCount,1);
  }
  assert.equal((await query("SELECT id FROM dispatch_sales_order_if_audit_events WHERE candidate_id=$1 AND action='operator_load_trigger_cutover'",[fixtures[0].id])).rowCount,1);
}));

test('reviewed legacy non-inventory lines are skipped without an IF attempt',async()=>rollback(async()=>{
  const order=await seed();
  await query("UPDATE sales_order_lines SET item_type='NonInvtPart' WHERE sales_order_id=$1",[order.id]);
  await completeDriver(order);
  const event=(await query('SELECT id FROM dispatch_order_completion_events WHERE order_ref=$1',[order.ref])).rows[0];
  const id=crypto.randomUUID();
  await query(`INSERT INTO dispatch_sales_order_if_candidates(id,completion_event_id,dispatch_order_ref,external_id,resolution_action)
    VALUES($1,$2,$3,$4,'snapshot')`,[id,event.id,order.ref,`MBBS-SOIF-${id}`]);
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(id);
  assert.equal(ready.status,'skipped');
  assert.equal(ready.result.reason,'non_inventory_fulfillment_not_required');
  assert.equal(ready.attemptCount,0);
}));

test('real Operator load saves physical quantities and a queue entry atomically',async()=>rollback(async()=>{
  const order=await seed();
  await query("UPDATE sales_orders SET operator_status='packed',local_yard_order_status='Packed' WHERE netsuite_id=$1",[order.id]);
  await query('UPDATE sales_order_lines SET loaded_qty=0,packed_piece_qty=4,to_pcs=1,piece_qty=10 WHERE sales_order_id=$1',[order.id]);
  const result=await recordDeliveryLoad(order.id,null,{photoDataUrls:['data:image/png;base64,dGVzdA==','data:image/png;base64,dHdv']});
  const row=await candidate(order,String(result.id));
  assert.equal((await prepareSalesOrderAutoFulfillmentCandidate(row.id)).lineSnapshot[0].deliveredQuantity,4);
  assert.equal((await query('SELECT loaded_qty FROM sales_order_lines WHERE sales_order_id=$1',[order.id])).rows[0].loaded_qty,'4');
}));

test('a split load queues its exact quantity against the positive NetSuite parent',async()=>rollback(async()=>{
  const parent=await seed(),child={id:-parent.id,ref:`${parent.ref}-S2`};
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,outbound_location_id,
    outbound_location,sales_order_type,operator_status,netsuite_active)
    SELECT $2,$3,customer,status,status_text,outbound_location_id,outbound_location,sales_order_type,operator_status,netsuite_active
    FROM sales_orders WHERE netsuite_id=$1`,[parent.id,child.id,child.ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,loaded_qty,netsuite_active)
    SELECT $2,line_id,item_id,item_name,sku,item_type,3,unit,location_id,3,netsuite_active FROM sales_order_lines WHERE sales_order_id=$1`,[parent.id,child.id]);
  await query('INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref) VALUES($1,$2,$3,$4)',
    [parent.id,parent.ref,child.id,child.ref]);
  const row=await candidate(child,await load(child,3));
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
  assert.equal(ready.status,'queued');
  assert.equal(ready.sourceSalesOrderId,parent.id);
  assert.equal(ready.lineSnapshot[0].deliveredQuantity,3);
  assert.equal(ready.lineSnapshot[0].orderLine,10);
}));

test('changed item identity stops a saved load instead of substituting the current item',async()=>rollback(async()=>{
  const order=await seed(),row=await candidate(order,await load(order,4));
  await query('UPDATE sales_order_lines SET item_id=102 WHERE sales_order_id=$1',[order.id]);
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
  assert.equal(ready.status,'attention');
  assert.match(ready.lastError,/saved Operator load line/);
}));

test('a changed NetSuite line number or yard cannot rewrite saved load identity',async()=>rollback(async()=>{
  for(const update of ['netsuite_order_line=99','location_id=28']) {
    const order=await seed(),row=await candidate(order,await load(order,4));
    await query(`UPDATE sales_order_lines SET ${update} WHERE sales_order_id=$1`,[order.id]);
    const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
    assert.equal(ready.status,'attention');
    assert.match(ready.lastError,/saved Operator load/);
  }
}));

test('reload records preserve physical evidence without queueing another fulfillment',async()=>rollback(async()=>{
  const order=await seed();
  const cycle=(await query(`INSERT INTO operator_reload_cycles(sales_order_id,order_ref,cycle_number,request_id,reason)
    VALUES($1,$2,1,$3,'Reload already fulfilled goods') RETURNING id`,[order.id,order.ref,crypto.randomUUID()])).rows[0];
  await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,reload_cycle_id,line_snapshot)
    VALUES('sales_order_delivery_load','sales_order',$1,$2,$3,'[{"lineId":10,"itemId":101,"loadedQty":4}]')`,[order.id,order.ref,cycle.id]);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,0);
}));

test('yard gate disable and re-enable fence queued loads by load-record watermark',async()=>rollback(async()=>{
  const order=await seed();
  const row=await candidate(order,await load(order,10));
  const ready=await prepareSalesOrderAutoFulfillmentCandidate(row.id);
  assert.equal(ready.status,'queued');
  await gate(false);
  assert.equal(await claim(ready),null);
  await query("UPDATE dispatch_sales_order_if_candidates SET resolution_action='snapshot' WHERE id=$1",[ready.id]);
  assert.equal(await claim(ready),null,'an explicit Admin choice cannot bypass a disabled yard gate');
  await query("UPDATE dispatch_sales_order_if_candidates SET resolution_action='automatic' WHERE id=$1",[ready.id]);
  await gate(true);
  assert.equal(await claim(ready),null,'a gate restart must not release old loads');
}));

test('load queue is atomic with rollback and excludes other movement families',async()=>rollback(async()=>{
  const order=await seed();
  await assert.rejects(withTransaction(async()=>{
    await load(order,10);
    assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,1);
    throw new Error('cancel load');
  }),/cancel load/);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,0);
  for (const [type,family] of [['sales_order_customer_pickup','sales_order'],['transfer_order_load','transfer_order'],['local_co_load','co_order'],['vrma_local_load','vrma_order']]) {
    await load(order,10,{type,family});
  }
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=$1',[order.ref])).rowCount,0);
}));

test('Admin and movement history show loaded SO fulfillment without waiting for a Driver',async()=>rollback(async()=>{
  const order=await seed(),recordId=await load(order,10),row=await candidate(order,recordId);
  await prepareSalesOrderAutoFulfillmentCandidate(row.id);
  assert.ok((await listSalesOrderAutoFulfillmentCandidates()).some(value=>value.id===row.id && value.completionEvidenceType==='operator_load'));
  await query(`UPDATE dispatch_sales_order_if_candidates SET status='completed',completed_at=now(),
    netsuite_transaction_id=987,netsuite_transaction_ref='IF-LOAD-987' WHERE id=$1`,[row.id]);
  const history=(await movementRecordEvidence({loadIds:[recordId]})).get(`load-${recordId}`);
  assert.equal(history.waitingForDriverCompletion,false);
  assert.deepEqual(history.documents,[{type:'IF',ref:'IF-LOAD-987'}]);
}));
