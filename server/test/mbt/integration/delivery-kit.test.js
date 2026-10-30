import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/sales-order-auto-fulfillment-repository.js';
import {deliveryKitFixture,deliveryKitProcessor} from '../../support/delivery-kit-fixture.mjs';
after(closeDb);
const repository={prepare:repo.prepareSalesOrderAutoFulfillmentCandidate,get:repo.getSalesOrderAutoFulfillmentCandidate,
  claim:repo.claimSalesOrderAutoFulfillmentCandidate,renew:repo.renewSalesOrderAutoFulfillmentCandidateLease,
  startAttempt:repo.startSalesOrderAutoFulfillmentAttempt,complete:repo.completeSalesOrderAutoFulfillmentCandidate,
  failure:repo.failSalesOrderAutoFulfillmentCandidate,attention:repo.markSalesOrderAutoFulfillmentAttention,
  closed:repo.markSalesOrderAutoFulfillmentClosed,reconciled:repo.markSalesOrderAutoFulfillmentReconciled};

async function seed() {
  const f=deliveryKitFixture(),id=9_730_000_000+crypto.randomInt(100_000_000),ref=`SO-KIT-${crypto.randomUUID()}`;
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='dispatch_netsuite_sales_order_if_3445'");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,netsuite_active,sales_order_type,operator_status,status)
    VALUES($1,$2,1,true,'Delivery','loaded','B')`,[id,ref]);
  for(const row of f.raw.evidence.sourceRows) await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_type,item_name,sku,
    quantity,unit,location_id,loaded_qty,netsuite_active) VALUES($1,$2,$3,$4,$5,'Kit fixture','Kit fixture',$6,'EA',1,$7,true)`,
    [id,row.uniquekey,row.id,row.item,row.itemtype,Math.abs(Number(row.quantity)),row.itemtype==='Kit'?0:Math.abs(Number(row.quantity))]);
  const load=(await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,line_snapshot,response)
    VALUES('sales_order_delivery_load','sales_order',$1,$2,$3::jsonb,'{}') RETURNING id`,[id,ref,JSON.stringify(f.raw.selected.map(line=>({lineId:line.sourceLineKey,itemId:line.itemId,
      quantity:line.quantity,loadedQty:line.quantity,loadedUom:'EA'})))])).rows[0];
  const candidate=(await query('SELECT id FROM dispatch_sales_order_if_candidates WHERE operator_load_record_id=$1',[load.id])).rows[0];
  assert(candidate);f.candidate=await repo.prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(f.candidate.status,'queued',f.candidate.lastError);f.source.id=id;f.id=id;f.loadId=load.id;
  return f;
}

async function loading(f) {
  return (await query(`SELECT (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_order_lines l WHERE sales_order_id=$1) AS lines,
    (SELECT to_jsonb(r) FROM operator_load_records r WHERE id=$2) AS load`,[f.id,f.loadId])).rows[0];
}

test('durable delivery kit posting stores parent evidence and preserves completed physical loading',()=>withTransaction(async()=>{
  const f=await seed(),before=await loading(f),h=deliveryKitProcessor(f,repository);
  const completed=await h.processor.process(f.candidate.id);assert.equal(completed.status,'completed',completed.lastError);
  assert.deepEqual(completed.payload.item.items.map(l=>[l.orderLine,l.quantity]),[[1,95.6],[2,1]]);
  assert.deepEqual(completed.lineSnapshot,f.candidate.lineSnapshot);
  assert.equal(completed.liveSnapshot.kitPostingLines[1].kit.physicalLines[0].itemId,599);
  assert.equal(completed.liveSnapshot.kitPostingLines[1].itemId,10126);
  assert.deepEqual(await loading(f),before);
  await h.processor.process(f.candidate.id);assert.equal(h.posts(),1);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_attempts WHERE candidate_id=$1',[f.candidate.id])).rowCount,1);
  assert.equal((await query('SELECT candidate_id FROM dispatch_sales_order_if_line_claims WHERE candidate_id=$1 AND active',[f.candidate.id])).rowCount,0);
},{rollback:true}));

test('durable timeout recovery retains parent payload and never repeats physical loading',()=>withTransaction(async()=>{
  const f=await seed(),before=await loading(f),h=deliveryKitProcessor(f,repository,{timeout:true});
  const result=await h.processor.process(f.candidate.id);assert.equal(result.status,'completed',result.lastError);assert.equal(h.posts(),1);
  assert.equal(result.result.recovered,true);assert.deepEqual(await loading(f),before);
},{rollback:true}));

test('already fulfilled kit delivery reconciles and releases claims without posting or changing loading',()=>withTransaction(async()=>{
  const f=await seed(),before=await loading(f);f.source={id:f.id,status:'G',fulfillmentComplete:true,lines:[]};
  const h=deliveryKitProcessor(f,repository),result=await h.processor.process(f.candidate.id);
  assert.equal(result.status,'reconciled');assert.equal(h.posts(),0);assert.equal(h.kitReads(),0);
  assert.deepEqual(await loading(f),before);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_audit_events WHERE candidate_id=$1 AND action=$2',[f.candidate.id,'already_fulfilled'])).rowCount,1);
},{rollback:true}));

test('twelve concurrent delivery workers produce one kit fulfillment and one attempt',async()=>{
  const f=await withTransaction(seed),before=await loading(f),h=deliveryKitProcessor(f,repository);
  await Promise.all(Array.from({length:12},()=>h.processor.process(f.candidate.id)));
  const result=await repo.getSalesOrderAutoFulfillmentCandidate(f.candidate.id);
  assert.equal(result.status,'completed',result.lastError);assert.equal(h.posts(),1);
  assert.deepEqual(await loading(f),before);
  assert.equal((await query('SELECT id FROM dispatch_sales_order_if_attempts WHERE candidate_id=$1',[f.candidate.id])).rowCount,1);
});
