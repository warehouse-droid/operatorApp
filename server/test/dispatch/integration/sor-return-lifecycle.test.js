import {beforeEach,afterEach} from 'node:test';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {decorateSorOrders,reconcileSorReturnDrafts} from '../../../src/sor-rental-repository.js';
import {sorReturnDraft} from '../../../src/sor-rental-policy.js';
import {sorSourceDrafts,runSorReturnQueue,refreshSorItemMetadata} from '../../../src/sor-rental-service.js';
import {config} from '../../../src/config.js';
import {fetchDeliveryOrdersFromNetSuite} from '../../../src/netsuite.js';
import {getSorReturnReadiness,assertSorReturnReady} from '../../../src/sor-return-readiness.js';
beforeEach(()=>query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'"));
afterEach(()=>query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'"));
after(closeDb);
// Queue processing owns its transaction; these tests must observe real commits.
async function committedQueueFixture(fn) {
 try {return await fn();} finally {
  await query("DELETE FROM dispatch_custom_orders WHERE parent_order_ref='SOR98800901'");
  await query("DELETE FROM driver_job_records WHERE job_id IN ('sor-delivered','sor-return-start')");
  await query('DELETE FROM sales_order_lines WHERE sales_order_id=98800901');
  await query('DELETE FROM sales_orders WHERE netsuite_id=98800901');
  await query("DELETE FROM sor_return_reconcile_queue WHERE source_ref='SOR98800901'");
 }
}
async function fixture(){
 await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text) VALUES(98800901,'SOR98800901','Delivery',true,'Pending Fulfillment')");
 const [order]=await decorateSorOrders([{id:'SOR98800901',type:'SO',netsuiteId:98800901,address:'77 Site Road',items:[{itemId:98800901,itemName:'Lift/Day',itemType:'Service',quantity:4}]}]);
 return {order,draft:sorReturnDraft(order)};
}
test('SOR-6 collision fails without modifying unrelated custom work',async()=>withTransaction(async()=>{
 const {draft}=await fixture();
 await query("INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,weight_lbs) VALUES('SOR98800901-Return','Other site','Other yard','Manual order',100)");
 await assert.rejects(reconcileSorReturnDrafts('SOR98800901',[draft]),/already|collision|exists/i);
 assert.equal((await query("SELECT pickup_location FROM dispatch_custom_orders WHERE ref_number='SOR98800901-Return'")).rows[0].pickup_location,'Other site');
},{rollback:true}));
test('SOR-7 collection is blocked before delivery, allowed after, and blocked for review',async()=>withTransaction(async()=>{
 const {draft}=await fixture();await reconcileSorReturnDrafts('SOR98800901',[draft]);
 const job={stopType:'pickup',orderRefs:[draft.refNumber]};
 assert.equal((await getSorReturnReadiness(job.orderRefs))[0].allowed,false);
 await assert.rejects(assertSorReturnReady(job),error=>error.code==='SOR_RETURN_NOT_READY');
 await query("INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status) VALUES('sor-parent-done','driver','dropoff','[\"SOR98800901\"]','complete')");
 assert.equal((await getSorReturnReadiness(job.orderRefs))[0].allowed,true);
 await assertSorReturnReady(job);
 await query("UPDATE dispatch_custom_orders SET sor_review_reason='Quantity changed' WHERE ref_number=$1",[draft.refNumber]);
 await assert.rejects(assertSorReturnReady(job),error=>error.status===409);
 assert.equal((await getSorReturnReadiness(['SOB120921'])).length,0);
},{rollback:true}));
test('SOR-6 started return freezes quantities and raises review',async()=>withTransaction(async()=>{
 const {draft}=await fixture();await reconcileSorReturnDrafts('SOR98800901',[draft]);
 await query("INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at) VALUES('sor-return-start','driver','pickup','[\"SOR98800901-Return\"]','in_progress',now())");
 const result=await reconcileSorReturnDrafts('SOR98800901',[]);assert.equal(result.review,1);
 const saved=(await query("SELECT * FROM dispatch_custom_orders WHERE ref_number=$1",[draft.refNumber])).rows[0];
 assert.equal(saved.status,'open');assert.equal(saved.sales_qty,'4');assert.ok(saved.sor_review_reason);
},{rollback:true}));
test('SOR-5 active splits retain exact quantities and inactive split does not reappear',async()=>withTransaction(async()=>{
 const {order}=await fixture();
 for(const n of [1,2]){
  const split={...order,id:`${order.id}-S${n}`,originalOrderId:order.id,items:order.items.map(item=>({...item,quantity:n}))};
  await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card,active) VALUES($1,'SO',$2,'2026-09-24',$3,$3,$4)",[split.id,order.id,JSON.stringify(split),n===1]);
 }
 const source=await sorSourceDrafts(order.id,[order]);
 assert.deepEqual(source.drafts.map(d=>[d.refNumber,d.salesQty]),[['SOR98800901-S1-Return',1]]);
 await query("UPDATE sales_orders SET sales_order_type='Pick-Up' WHERE netsuite_id=98800901");
 assert.equal((await sorSourceDrafts(order.id,[order])).drafts.length,0);
},{rollback:true}));
test('SOR-6 durable queue retries failed catalog refresh and records exhausted errors',async()=>committedQueueFixture(async()=>{
 const {order}=await fixture();await query('UPDATE sor_signature_settings SET returns_enabled=true');
 await query("DELETE FROM sor_return_reconcile_queue WHERE source_ref<>'SOR98800901'");
 await runSorReturnQueue({loadOrders:async()=>[order],refreshRefs:async()=>{throw new Error('Catalog unavailable');},limit:1});
 const queued=(await query("SELECT * FROM sor_return_reconcile_queue WHERE source_ref='SOR98800901'")).rows[0];
 assert.ok(queued);assert.match(queued.last_error,/Catalog unavailable/);
 await runSorReturnQueue({loadOrders:async()=>[order],limit:1});
 assert.equal((await query("SELECT * FROM sor_return_reconcile_queue WHERE source_ref='SOR98800901'")).rowCount,0);
 assert.equal((await query("SELECT * FROM dispatch_custom_orders WHERE ref_number='SOR98800901-Return'")).rowCount,1);
}));
test('SOR-6 delivered and billed equipment keeps its outstanding return, without backfilling historical sales',async()=>committedQueueFixture(async()=>{
 const {order,draft}=await fixture();await reconcileSorReturnDrafts(order.id,[draft]);
 await query('UPDATE sor_signature_settings SET returns_enabled=true');
 await query("DELETE FROM sor_return_reconcile_queue WHERE source_ref<>'SOR98800901'");
 await query("INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status) VALUES('sor-delivered','driver','dropoff','[\"SOR98800901\"]','complete')");
 await query("UPDATE sales_orders SET status_text='Billed' WHERE netsuite_id=98800901");
 await runSorReturnQueue({loadOrders:async()=>[],limit:1});
 assert.equal((await query('SELECT status FROM dispatch_custom_orders WHERE ref_number=$1',[draft.refNumber])).rows[0].status,'open');
 assert.equal((await sorSourceDrafts(order.id,[order])).drafts.length,0);
 await query("DELETE FROM driver_job_records WHERE job_id='sor-delivered'");
 await query("INSERT INTO sor_return_reconcile_queue(source_ref) VALUES('SOR98800901') ON CONFLICT(source_ref) DO UPDATE SET version=sor_return_reconcile_queue.version+1");
 await runSorReturnQueue({loadOrders:async()=>[],limit:1});
 assert.equal((await query('SELECT status FROM dispatch_custom_orders WHERE ref_number=$1',[draft.refNumber])).rows[0].status,'open');
 await query('DELETE FROM dispatch_custom_orders WHERE ref_number=$1',[draft.refNumber]);
 await query("INSERT INTO sor_return_reconcile_queue(source_ref) VALUES('SOR98800901')");
 await runSorReturnQueue({loadOrders:async()=>[order],limit:1});
 assert.equal((await query('SELECT 1 FROM dispatch_custom_orders WHERE ref_number=$1',[draft.refNumber])).rowCount,0);
}));
test('SOR-2 metadata sync reads hierarchy and item type from SuiteQL and keeps explicit overrides',async(t)=>withTransaction(async()=>{
 await fixture();
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity) VALUES(98800901,1,98800901,'Lift','Service',4)");
 await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-test-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
 const original={directAccessEnabled:config.netsuite.directAccessEnabled,restBaseUrl:config.netsuite.restBaseUrl};
 const statements=[];
 const boundary=t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(new URL(url).hostname,'sor-metadata.invalid');
  const {q}=JSON.parse(options.body);statements.push(q);
  return new Response(JSON.stringify({items:[{id:98800901,itemid:'Lift',fullname:'05 MBR Equip : Lift',itemtype:'Service'}],hasMore:false}),{status:200});
 });
 try {
  Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'https://sor-metadata.invalid/services/rest'});
  await refreshSorItemMetadata({force:true});
  const saved=(await query('SELECT * FROM sor_item_policies WHERE item_id=98800901')).rows[0];
  assert.equal(saved.full_name,'05 MBR Equip : Lift');assert.equal(saved.item_type,'Service');
  assert.equal(statements.length,1);assert.match(statements[0],/OR id IN \([^)]*98800901/);
  assert.equal((await decorateSorOrders([{id:'SOR98800901',type:'SO',items:[{itemId:98800901,itemName:'Lift',quantity:4}]}]))[0].items[0].sorAutoReturn,true);
  await fetchDeliveryOrdersFromNetSuite(50);
  const deliveryQueries=()=>statements.filter(statement=>statement.includes('FROM transaction t'));
  assert.equal(deliveryQueries().length,1);
  assert.match(deliveryQueries()[0],/tl\.location IN \(50\)/);assert.match(deliveryQueries()[0],/UPPER\(t\.tranid\) LIKE 'SOR%'/);
  await fetchDeliveryOrdersFromNetSuite(1);
  assert.equal(deliveryQueries().length,2);assert.doesNotMatch(deliveryQueries()[1],/UPPER\(t\.tranid\) LIKE 'SOR%'/);
 } finally {Object.assign(config.netsuite,original);boundary.mock.restore();}
},{rollback:true}));
test('SOR-6 unassigning untouched work clears review even when source data has reverted',async()=>withTransaction(async()=>{
 const {order,draft}=await fixture();await reconcileSorReturnDrafts(order.id,[draft]);
 await query("UPDATE dispatch_custom_orders SET sor_review_reason='Changed while assigned' WHERE ref_number=$1",[draft.refNumber]);
 const result=await reconcileSorReturnDrafts(order.id,[draft]);
 assert.equal(result.updated,1);
 assert.equal((await query('SELECT sor_review_reason FROM dispatch_custom_orders WHERE ref_number=$1',[draft.refNumber])).rows[0].sor_review_reason,'');
},{rollback:true}));
