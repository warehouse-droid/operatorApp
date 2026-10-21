import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import { persistSpecialOrderStatusObservation } from '../../../src/special-stock-status-refresh.js';
import { getSpecialStockCase } from '../../../src/special-stock-request-repository.js';
import { app } from '../../../src/server.js';
import { config } from '../../../src/config.js';
import { readSpecialDriverProgress } from '../../../src/special-stock-logistics.js';

const so = 8800101, po = 8800102, stamp = '2026-10-02 18:33:06.937123+00';
let caseId, server, base, token;
const observation = type => ({ orderType: type, netsuiteOrderId: type === 'sales_order' ? so : po,
  tranid: type === 'sales_order' ? 'TEST-STATUS-SO' : 'TEST-STATUS-PO', status: 'F',
  statusText: type === 'sales_order' ? 'Sales Order : Pending Billing' : 'Purchase Order : Pending Bill', syncedAt: stamp });
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  const user = await createOperator({ username: 'special-status-test', displayName: 'TEST', password: 'test-status-only',
    role: 'admin', roles: ['admin','sales','scm'], yardLocationIds: [1] });
  const operator = (await query("SELECT id FROM operators WHERE username='special-status-test'")).rows[0];
  assert.ok(user); assert.ok(operator);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,synced_at,foreign_total,netsuite_active,fulfillment_status)
    VALUES($1,'TEST-STATUS-SO','B','Sales Order : Pending Fulfillment',$2,123.45,true,'not_fulfilled')`, [so, stamp]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,synced_at,foreign_total,netsuite_active,receipt_status)
    VALUES($1,'TEST-STATUS-PO','B','Purchase Order : Pending Receipt',$2,67.89,true,'received')`, [po, stamp]);
  caseId = Number((await query(`INSERT INTO sales_stock_requests(request_ref,request_type,destination_location_id,destination_name,requested_by)
    VALUES('SPREQ-TEST-STATUS','special',1,'3445',$1) RETURNING id`, [operator.id])).rows[0].id);
  await query(`INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,
    fulfillment_method,operational_yard_location_id,delivery_address,delivery_date,delivery_window_start,delivery_window_end,delivery_instructions,
    sales_order_netsuite_id,sales_order_ref,sales_order_status,sales_order_approved,purchase_order_netsuite_id,purchase_order_ref,purchase_order_status,
    operationally_complete,operational_completion_source)
    VALUES($1,'2026-10-01','TEST Customer','TEST Vendor','mbt_delivery',1,'TEST Address','2026-10-05','09:00','10:00','TEST Instructions',
    $2,'TEST-STATUS-SO','Old SO',false,$3,'TEST-STATUS-PO','Old PO',true,'dispatch_completion')`, [caseId, so, po]);
  await query("UPDATE purchase_orders SET dispatch_ref='TEST-STATUS-ALIAS' WHERE netsuite_id=$1",[po]);
  for (const [job,ref,kind,stop,status,time] of [
    ['so-pick','TEST-STATUS-SO','SO','pickup','complete','2026-10-05T11:01:47.688Z'],
    ['po-pick','TEST-STATUS-ALIAS','PO','pickup','complete','2026-10-02T20:52:07.060Z'],
    ['po-drop','TEST-STATUS-ALIAS','PO','dropoff','complete','2026-10-02T23:00:11.110Z'],
    ['so-drop','TEST-STATUS-SO','SO','dropoff','complete','2026-10-05T13:34:03.290Z'],
    ['unfinished','TEST-STATUS-SO','SO','pickup','in_progress','2099-10-05T11:00:00Z'],
    ['wrong-kind','TEST-STATUS-SO','PO','pickup','complete','2099-10-05T11:00:00Z']
  ]) await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,status,completed_at,order_refs,job_details)
    VALUES($1,'TEST',$2,$3,$4,$5::jsonb,$6::jsonb)`,[job,stop,status,time,JSON.stringify([ref]),JSON.stringify({orderTypes:[kind]})]);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'special-status-test', password: 'test-status-only' }) });
  assert.equal(login.status, 200); token = (await login.json()).token;
});
beforeEach(async () => {
  for (const [table, id, label] of [['sales_orders',so,'Sales Order : Pending Fulfillment'],['purchase_orders',po,'Purchase Order : Pending Receipt']]) {
    await query(`UPDATE ${table} SET status='B',status_text=$2,synced_at=$3 WHERE netsuite_id=$1`, [id,label,stamp]);
  }
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await closeDb(); });
async function business() {
  return (await query(`SELECT jsonb_build_object('request',(SELECT to_jsonb(r) FROM sales_stock_requests r WHERE id=$1),
    'case',(SELECT to_jsonb(s) FROM sales_special_stock_cases s WHERE request_id=$1),
    'sales',(SELECT to_jsonb(s)-'status'-'status_text'-'synced_at'-'status_updated_at' FROM sales_orders s WHERE netsuite_id=$2),
    'purchase',(SELECT to_jsonb(p)-'status'-'status_text'-'synced_at'-'status_updated_at' FROM purchase_orders p WHERE netsuite_id=$3)) AS data`, [caseId,so,po])).rows[0].data;
}
async function counts() {
  return (await query(`SELECT (SELECT count(*) FROM delivery_audit_log WHERE action='special.order_status.refreshed')::int AS audit,
    (SELECT count(*) FROM netsuite_mirror_events WHERE change_type='status')::int AS mirror`)).rows[0];
}
test('actual PostgreSQL refresh preserves all business fields and projects latest SO/PO statuses with microsecond fencing', async () => {
  const before = await business(), count = await counts();
  for (const kind of ['sales_order','purchase_order']) assert.equal(await persistSpecialOrderStatusObservation(observation(kind)), true);
  assert.deepEqual(await business(), before);
  assert.deepEqual(await counts(), { audit: count.audit + 2, mirror: count.mirror + 2 });
  const detail = await getSpecialStockCase(caseId, { audience: 'scm', dispatchPlans: [] });
  assert.equal(detail.salesOrderStatus, 'Sales Order : Pending Billing');
  assert.equal(detail.purchaseOrderStatus, 'Purchase Order : Pending Bill');
  assert.equal(detail.purchaseOrderReceiptStatus, 'received'); assert.equal(detail.operationallyComplete, true);
  assert.equal(detail.salesOrderApproved, true); assert.equal(detail.stage, 'completed');
  const raw = (await query('SELECT synced_at::text AS value FROM sales_orders WHERE netsuite_id=$1', [so])).rows[0].value;
  assert.equal(detail.salesOrderStatusSyncedAt, raw);
});
test('driver evidence matches the PO alias, rejects unfinished/foreign-kind records and carries actual completion times',async()=>{
 assert.equal((await readSpecialDriverProgress([])).size,0);
 const detail=await getSpecialStockCase(caseId,{audience:'sales',dispatchPlans:[]});
 assert.equal(detail.salesOrderPickedUpAt.toISOString(),'2026-10-05T11:01:47.688Z');
 assert.equal(detail.purchaseOrderPickedUpAt.toISOString(),'2026-10-02T20:52:07.060Z');
 assert.equal(detail.purchaseOrderDropoffAt.toISOString(),'2026-10-02T23:00:11.110Z');
 assert.equal(detail.operationallyCompletedAt.toISOString(),'2026-10-05T13:34:03.290Z');
});
test('real list/detail handlers refresh both native headers once, preserve business data and serve cached state during remote failure',async()=>{
 const originalFetch=globalThis.fetch,originalConfig={...config.netsuite};
 const calls=[];let outage=false;
 await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-status-test',now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
 Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'https://special-status.invalid/services/rest'});
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith(base+'/'))return originalFetch(url,options);
  assert.equal(String(url),'https://special-status.invalid/services/rest/query/v1/suiteql');
  const q=JSON.parse(options.body).q,kind=q.includes("'PurchOrd'")?'purchase_order':'sales_order';
  assert.match(q,new RegExp(`t\\.id (?:IN \\(\\s*|= )${kind==='sales_order'?so:po}`));
  calls.push(kind);if(outage)throw Error('TEST status transport unavailable');
  const observed=observation(kind);
  return new globalThis.Response(JSON.stringify({items:[{id:String(observed.netsuiteOrderId),tranid:observed.tranid,status:observed.status,status_text:observed.statusText}]}),{headers:{'content-type':'application/json'}});
 };
 try{
  const before=await business();
  const url=base+`/api/sales/special-stock-requests/${caseId}`;
  assert.equal((await fetch(url)).status,401);assert.equal(calls.length,0);
  const response=await fetch(url,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);
  const detail=await response.json();assert.equal(detail.salesOrderStatus,'Sales Order : Pending Billing');assert.equal(detail.purchaseOrderStatus,'Purchase Order : Pending Bill');
  assert.deepEqual(calls,['sales_order','purchase_order']);assert.deepEqual(await business(),before);
  for(const audience of ['sales','scm'])for(const path of [`/${caseId}`,'?search=SPREQ-TEST-STATUS']){
   const fresh=await fetch(base+`/api/${audience}/special-stock-requests${path}`,{headers:{authorization:`Bearer ${token}`}});
   assert.equal(fresh.status,200);assert.equal(calls.length,2);
  }
  for(const [table,id] of [['sales_orders',so],['purchase_orders',po]])await query(`UPDATE ${table} SET synced_at=$1 WHERE netsuite_id=$2`,[stamp,id]);
  outage=true;
  const cached=await fetch(url,{headers:{authorization:`Bearer ${token}`}});assert.equal(cached.status,200);
  assert.equal((await cached.json()).salesOrderStatus,'Sales Order : Pending Billing');assert.deepEqual(await business(),before);
  outage=false;
  for(const audience of ['sales','scm']){
   const forced=await fetch(base+`/api/${audience}/special-stock-requests/${caseId}/sales-order/refresh`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});
   assert.equal(forced.status,200);assert.equal((await forced.json()).purchaseOrderStatus,'Purchase Order : Pending Bill');
  }
  assert.deepEqual(calls.slice(-6),['sales_order','purchase_order','sales_order','sales_order','purchase_order','sales_order']);
 }finally{globalThis.fetch=originalFetch;Object.assign(config.netsuite,originalConfig);await query('DELETE FROM netsuite_tokens WHERE id=1');}
});
test('an intervening webhook and two concurrent refreshes cannot overwrite a newer header', async () => {
  const count = await counts();
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed',synced_at=now() WHERE netsuite_id=$1", [so]);
  assert.equal(await persistSpecialOrderStatusObservation(observation('sales_order')), false);
  assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1', [so])).rows[0].status, 'G');
  assert.deepEqual(await counts(), count);
  const concurrent = await Promise.all([1,2].map(() => persistSpecialOrderStatusObservation(observation('purchase_order'))));
  assert.deepEqual(concurrent.sort(), [false,true]);
  assert.deepEqual(await counts(), { audit: count.audit + 1, mirror: count.mirror + 1 });
});
test('audit failure rolls back the header and mirror outbox transaction', async () => {
  const before = await business(), count = await counts();
  await query("ALTER TABLE delivery_audit_log ADD CONSTRAINT status_test_rejection CHECK (action <> 'special.order_status.refreshed') NOT VALID");
  try { await assert.rejects(persistSpecialOrderStatusObservation(observation('sales_order')), { code: '23514' }); }
  finally { await query('ALTER TABLE delivery_audit_log DROP CONSTRAINT status_test_rejection'); }
  assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1', [so])).rows[0].status, 'B');
  assert.deepEqual(await business(), before); assert.deepEqual(await counts(), count);
});
test('invalid kind, mismatched ref and unlinked identities do not persist', async () => {
  const count = await counts();
  await assert.rejects(persistSpecialOrderStatusObservation({ ...observation('sales_order'), orderType: 'unknown' }));
  assert.equal(await persistSpecialOrderStatusObservation({ ...observation('sales_order'), tranid: 'FOREIGN' }), false);
  assert.equal(await persistSpecialOrderStatusObservation({ ...observation('sales_order'), netsuiteOrderId: so + 10 }), false);
  assert.deepEqual(await counts(), count);
});
test('authenticated Sales/SCM list and detail endpoints expose separate local and latest NetSuite status', async () => {
  for (const kind of ['sales_order','purchase_order']) await persistSpecialOrderStatusObservation(observation(kind));
  for (const audience of ['sales','scm']) for (const path of [`/${caseId}`, '?search=SPREQ-TEST-STATUS']) {
    const url = `${base}/api/${audience}/special-stock-requests${path}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); const payload = await response.json(), detail = path.startsWith('?') ? payload.requests[0] : payload;
    assert.equal(detail.salesOrderStatus, 'Sales Order : Pending Billing'); assert.equal(detail.purchaseOrderStatus, 'Purchase Order : Pending Bill');
    assert.equal(detail.operationallyComplete, true); assert.equal(detail.purchaseOrderReceiptStatus, 'received');
  }
});
