import {specialSalesReps} from '../../../src/special-stock-sales-reps.js';
const originalRepSelection=specialSalesReps.select;
/* global Response */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb, pool, withTransaction } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { app } from '../../../src/server.js';
import { pdfText } from '../../field-sales/pdf-text.js';
import { config } from '../../../src/config.js';
import { assertSpecialStockHandoffPlanning } from '../../../src/dispatch-plan-repository.js';

const run = crypto.randomUUID().replaceAll('-', '');
const gate = 'special_stock_request_test_skip_orders';
const tokens = {}, ids = [], users = [];
const originalFetch = globalThis.fetch;
let nativeFetches = 0, nativeVersion = 1;
let nativeHook = null, nativeFailure = false;
const nativeBytes = kind => Buffer.from(`%PDF-NETSUITE-${kind}-version-${nativeVersion}`);
let originalRestletUrl, originalRestBaseUrl, originalDirectAccess, originalToken;
let server, base, original, originalWorkflow, context;
async function request(path, { role, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}
async function draft() {
  let detail = await repository.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899410,
    customerName: 'TEST Pricing HTTP', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 50, discountPercent: 10, requiredDate: '2099-02-01' }] }, context);
  ids.push(detail.id);
  detail = await repository.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision,
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST yard' }, context);
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  return repository.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision, customerId: 8899410,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST product', quantity: 20, packageQuantity: 2, conversionToPc: 10, uom: 'PC', rate: 50, discountPercent: 10 }] }, context);
}
const endpoint = (detail, order = 'sales') => `/api/${order === 'sales' ? 'sales' : 'scm'}/special-stock-requests/${detail.id}/${order}-order/skip`;

before(async () => {
  specialSalesReps.select=async id=>{assert.equal(Number(id),123);return {id:123,name:"TEST Selected Rep"};};
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  originalRestletUrl = config.smartScm.pickingTicketRestletUrl; originalDirectAccess = config.netsuite.directAccessEnabled;
  originalRestBaseUrl=config.netsuite.restBaseUrl;
  originalToken = (await query('SELECT * FROM netsuite_tokens WHERE id=1')).rows[0];
  await query("INSERT INTO netsuite_tokens(id,access_token) VALUES(1,'TEST_NATIVE_PDF') ON CONFLICT(id) DO UPDATE SET access_token='TEST_NATIVE_PDF'");
  config.smartScm.pickingTicketRestletUrl = 'https://native-pdf.test/restlet'; config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl='https://closed-order-header.test';
  globalThis.fetch = async (url, options) => {
    if(String(url).startsWith('https://closed-order-header.test/query/v1/suiteql')) {
      assert.equal(options.method,'POST');const sql=JSON.parse(options.body).q;
      const id=Number(/t.id = (\d+)/.exec(sql)[1]);assert.ok([8899494,8899495].includes(id));
      return new Response(JSON.stringify({items:[{id:String(id),tranid:id===8899494?'TEST-CLOSE-SO':'TEST-CLOSE-PO',
        type:id===8899494?'SalesOrd':'PurchOrd',status:id===8899494?'B':'E',status_text:id===8899494?'Sales Order : Pending Fulfillment':'Purchase Order : Pending Receipt'}],hasMore:false,count:1}),
        {headers:{'content-type':'application/json'}});
    }
    if (String(url) !== config.smartScm.pickingTicketRestletUrl) return originalFetch(url, options);
    nativeFetches++; const request = JSON.parse(options.body);
    assert.ok(['salesOrderPdf','purchaseOrderPdf'].includes(request.action));
    if (nativeHook) await nativeHook();
    if (nativeFailure) return new Response(JSON.stringify({error:{code:'MBBS_UNSUPPORTED_ACTION'}}),{status:400});
    return new Response(JSON.stringify({ ok: true, ...request, contentType: 'application/pdf', contentEncoding: 'base64',
      contentBase64: nativeBytes(request.action).toString('base64'), filename: 'NetSuite.pdf' }), { headers: { 'content-type': 'application/json' } });
  };
  original = (await query('SELECT enabled FROM mbt_feature_flags WHERE flag_key=$1', [gate])).rows[0].enabled;
  originalWorkflow = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ($1,'special_stock_request_workflow')", [gate]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899410,'TEST-PRICING','TEST Pricing HTTP','TEST Pricing HTTP','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
  for (const [name, role, yards] of [['sales','sales',[1]],['other','sales',[28]],['scm','scm',[]],['dispatch','dispatcher',[]]]) {
    const username = `pricing-${name}-${run}`;
    await createOperator({ username, displayName: `TEST ${name}`, password: 'test-pricing-isolated-only', role, roles: [role], yardLocationIds: yards });
    users.push(username);
  }
  context = { operatorId: (await query('SELECT id FROM operators WHERE username=$1', [users[0]])).rows[0].id, authorizedStoreLocationIds: [1] };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['sales','other','scm','dispatch']) {
    const login = await request('/api/auth/login', { body: { username: `pricing-${name}-${run}`, password: 'test-pricing-isolated-only' } });
    assert.equal(login.status, 200);
    tokens[name] = login.payload.token;
  }
});
after(async () => {
  specialSalesReps.select=originalRepSelection;
  globalThis.fetch = originalFetch; config.smartScm.pickingTicketRestletUrl = originalRestletUrl; config.netsuite.directAccessEnabled = originalDirectAccess;
  config.netsuite.restBaseUrl=originalRestBaseUrl;
  if (originalToken) await query('UPDATE netsuite_tokens SET access_token=$1 WHERE id=1', [originalToken.access_token]);
  else await query('DELETE FROM netsuite_tokens WHERE id=1');
  if (original !== undefined) await query('UPDATE mbt_feature_flags SET enabled=$2 WHERE flag_key=$1', [gate, original]);
  if (originalWorkflow !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [originalWorkflow]);
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  await closeDb();
});


const changePath=d=>`/api/sales/special-stock-requests/${d.id}/quantity-change`;
const reviewPath=d=>`/api/scm/special-stock-requests/${d.id}/quantity-review`;
test('local issued request removal enforces Sales and SCM roles and never accesses NetSuite',async()=>{
 let d=await draft();
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899888,sales_order_ref='TEST-LOCAL-HTTP-SO',sales_order_approved=true WHERE request_id=$1",[d.id]);
 d=await repository.getSpecialStockCase(d.id);const before=nativeFetches;
 const body={expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,remove:true}]};
 assert.equal((await request(changePath(d),{body})).status,401);
 for(const role of ['other','dispatch','scm'])assert.equal((await request(changePath(d),{role,body})).status,403);
 const pending=await request(changePath(d),{role:'sales',body});assert.equal(pending.status,200);
 assert.equal(pending.payload.lines.length,1);assert.equal(pending.payload.quantityReview.localOnly,true);
 const confirm={expectedRevision:pending.payload.revision,reviewId:pending.payload.quantityReview.id,decision:'approve'};
 assert.equal((await request(reviewPath(d),{role:'sales',body:confirm})).status,403);
 const approved=await request(reviewPath(d),{role:'scm',body:confirm});assert.equal(approved.status,200);
 assert.equal(approved.payload.lines.length,0);assert.equal(approved.payload.salesOrderRef,'TEST-LOCAL-HTTP-SO');
 assert.equal(approved.payload.quantityReview.status,'approved');assert.equal(nativeFetches,before);
});
async function documentRequest(path, role = 'sales') {
  const r = await fetch(base + path, { headers: role ? { authorization: `Bearer ${tokens[role]}` } : {} });
  return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
}
test('unprepared delivery failure allows request removal over HTTP without remote writes',async()=>{
 let d=await draft();
 const journal={id:'test-preparation-failed',status:'attention',error:'A complete, distinct NetSuite order is required.',target:{fulfillmentMethod:'mbt_delivery'}};
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899889,sales_order_ref='TEST-FAILED-DELIVERY-SO',sales_order_approved=true,fulfillment_change=$2::jsonb WHERE request_id=$1",[d.id,JSON.stringify(journal)]);
 d=await repository.getSpecialStockCase(d.id);const before=nativeFetches;
 const pending=await request(changePath(d),{role:'sales',body:{expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,remove:true}]}});
 assert.equal(pending.status,200);assert.equal(pending.payload.lines.length,1);
 const approved=await request(reviewPath(d),{role:'scm',body:{expectedRevision:pending.payload.revision,reviewId:pending.payload.quantityReview.id,decision:'approve'}});
 assert.equal(approved.status,200);assert.equal(approved.payload.lines.length,0);
 assert.equal(approved.payload.quantityReview.status,'approved');assert.equal(nativeFetches,before);
 assert.deepEqual((await query('SELECT fulfillment_change FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].fulfillment_change,journal);
});
test('saved quotes enforce login, role, yard and workflow scope and end only when a real SO is linked', async () => {
  const d = await draft(), path = `/api/sales/special-stock-requests/${d.id}/quote.pdf`;
  assert.equal((await documentRequest(path, null)).status, 401);
  assert.equal((await documentRequest(path, 'dispatch')).status, 403);
  assert.equal((await documentRequest(path, 'other')).status, 403);
  const quote = await documentRequest(path);
  assert.equal(quote.status, 200); assert.match(pdfText(quote.buffer), /TEST product/);
  const scmQuote = await documentRequest(path.replace('/sales/', '/scm/'), 'scm'); assert.equal(scmQuote.status, 200);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try { assert.equal((await documentRequest(path)).status, 404); }
  finally { await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'"); }
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899490,sales_order_ref='TEST-SO' WHERE request_id=$1", [d.id]);
  assert.equal((await documentRequest(path)).status, 409);
  assert.equal((await documentRequest(path.replace('/sales/', '/scm/'), 'scm')).status, 409);
});

test('native SO/PO PDFs persist exact bytes, enforce Sales/SCM roles, and refresh after local changes', async () => {
  const d = await draft();
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899491,sales_order_ref='TEST-SO',purchase_order_netsuite_id=8899492,purchase_order_ref='TEST-PO',sales_order_status='Pending Fulfillment',purchase_order_status='Pending Receipt' WHERE request_id=$1", [d.id]);
  await query("UPDATE sales_special_stock_order_lines SET unit_purchase_cost=4 WHERE request_id=$1 AND order_kind='purchase_order'", [d.id]);
  const path = kind => `/api/sales/special-stock-requests/${d.id}/orders/${kind}.pdf`;
  const [a,b] = await Promise.all([documentRequest(path('sales_order')), documentRequest(path('sales_order'))]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual([a.headers.get('x-mbbs-document-cache'),b.headers.get('x-mbbs-document-cache')].sort(), ['hit','miss']);
  assert.deepEqual(a.buffer, b.buffer); assert.deepEqual(a.buffer, nativeBytes('salesOrderPdf')); assert.equal(nativeFetches, 1);
  assert.equal((await documentRequest(path('sales_order'), 'other')).status, 403);
  assert.equal((await documentRequest(path('sales_order'), null)).status, 401);
  assert.equal((await documentRequest(path('sales_order'), 'dispatch')).status, 403);
  const poSales = await documentRequest(path('purchase_order'));
  const poScm = await documentRequest(path('purchase_order').replace('/sales/', '/scm/'), 'scm');
  assert.equal((await documentRequest(path('purchase_order').replace('/sales/', '/scm/'), 'sales')).status, 403);
  assert.equal(poSales.status, 403); assert.equal(poScm.status, 200);
  assert.deepEqual(poScm.buffer, nativeBytes('purchaseOrderPdf'));
  assert.equal((await documentRequest(path('purchase_order'))).status, 403, 'Sales remains forbidden after SCM populated the cache');
  const soScm = await documentRequest(path('sales_order').replace('/sales/', '/scm/'), 'scm'); assert.equal(soScm.status, 200);
  await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1', [d.id]);
  const auditOnly = await documentRequest(path('sales_order')); assert.equal(auditOnly.headers.get('x-mbbs-document-cache'), 'hit'); assert.deepEqual(auditOnly.buffer, a.buffer);
  await query("UPDATE sales_special_stock_order_lines SET description='Locally corrected description',quantity=21 WHERE request_id=$1 AND order_kind='sales_order'", [d.id]);
  nativeVersion++;
  const changed = await documentRequest(path('sales_order')); assert.equal(changed.headers.get('x-mbbs-document-cache'), 'miss'); assert.deepEqual(changed.buffer, nativeBytes('salesOrderPdf')); assert.notDeepEqual(changed.buffer, a.buffer);
  const reopened = await documentRequest(path('sales_order')); assert.equal(reopened.headers.get('x-mbbs-document-cache'), 'hit'); assert.deepEqual(reopened.buffer, changed.buffer);
  assert.equal((await query('SELECT * FROM sales_special_stock_document_cache WHERE request_id=$1', [d.id])).rowCount, 3);
  assert.equal((await documentRequest(path('anything'))).status, 400);
  await query('UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=null,purchase_order_ref=null WHERE request_id=$1', [d.id]);
  assert.equal((await documentRequest(path('purchase_order').replace('/sales/', '/scm/'), 'scm')).status, 409);
});
test('native PDF fetch does not lock order edits and rejects a file fetched for a changed snapshot', async () => {
  const d=await draft();
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899493,sales_order_ref='TEST-RACE-PDF' WHERE request_id=$1",[d.id]);
  const path=`/api/sales/special-stock-requests/${d.id}/orders/sales_order.pdf`;
  nativeHook=async()=>{
    const client=await pool.connect();
    try {await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='500ms'");
      await client.query("UPDATE sales_special_stock_cases SET delivery_address='Changed while loading' WHERE request_id=$1",[d.id]);await client.query('COMMIT');
    } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  try {assert.equal((await documentRequest(path)).status,409);}finally{nativeHook=null;}
  assert.equal((await query('SELECT 1 FROM sales_special_stock_document_cache WHERE request_id=$1',[d.id])).rowCount,0);
  nativeFailure=true;
  try {const failure=await documentRequest(path);assert.equal(failure.status,502);assert.match(failure.buffer.toString(),/updated order PDF script/);}finally{nativeFailure=false;}
  const ok=await documentRequest(path);assert.equal(ok.status,200);assert.deepEqual(ok.buffer,nativeBytes('salesOrderPdf'));
});

test('issued PO closure HTTP requires Sales scope and SCM confirmation, and permits SCM rejection',async()=>{
  const d=await draft();await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899494,sales_order_ref='TEST-CLOSE-SO',purchase_order_netsuite_id=8899495,purchase_order_ref='TEST-CLOSE-PO' WHERE request_id=$1",[d.id]);
  const close=`/api/sales/special-stock-requests/${d.id}/close`,review=`/api/scm/special-stock-requests/${d.id}/closure-review`;
  const body={expectedRevision:d.revision,reason:'Customer cancelled'};
  assert.equal((await request(close,{role:'other',body})).status,403);
  assert.equal((await request(close,{role:'dispatch',body})).status,403);
  const pending=await request(close,{role:'sales',body});assert.equal(pending.status,200);assert.equal(pending.payload.closureReview.status,'pending');
  assert.equal(pending.payload.closureReviewPlan,undefined);
  const decision={expectedRevision:pending.payload.revision,reviewId:pending.payload.closureReview.id,decision:'reject',reason:'Keep order'};
  assert.equal((await request(review,{body:decision})).status,401);
  assert.equal((await request(review,{role:'sales',body:decision})).status,403);
  assert.equal((await request(review,{role:'dispatch',body:decision})).status,403);
  const rejected=await request(review,{role:'scm',body:decision});assert.equal(rejected.status,200);assert.equal(rejected.payload.closeStatus,'active');
});

test('Special closure review does not block planning or require a case lock',async()=>{
  const d=await draft();await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899496,sales_order_ref='TEST-CLOSE-RACE',purchase_order_netsuite_id=8899497,purchase_order_ref='TEST-CLOSE-RACE-PO' WHERE request_id=$1",[d.id]);
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const closing=withTransaction(async()=>{const result=await repository.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context);entered();await gate;return result;});
  await started;
  const planning=withTransaction(async()=>{await query("SET LOCAL lock_timeout='250ms'");await assertSpecialStockHandoffPlanning({trucks:[{loads:[{stops:[{type:'drop',orderId:'TEST-CLOSE-RACE'}]}]}]});});
  try { await planning; } finally { release(); }
  await closing;
  assert.equal((await repository.getSpecialStockCase(d.id)).closeStatus,'closure_pending');
});

test('local MBBS quote is available before SO creation without writing a case or requiring NetSuite', async () => {
  const payload = { storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Local quote', vendorName: 'TEST Vendor',
    fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST Endura Coping', quantity: 2, uom: 'PLT', rate: 50, discountPercent: 10, requiredDate: '2099-02-01' }] };
  const before = (await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count;
  const response = await fetch(`${base}/api/sales/special-stock-requests/quote-preview`, { method: 'POST',
    headers: { authorization: `Bearer ${tokens.sales}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count, before);
  assert.equal((await request('/api/sales/special-stock-requests/quote-preview', { body: payload })).status, 401);
  assert.equal((await request('/api/sales/special-stock-requests/quote-preview', { role: 'other', body: payload })).status, 403);
  assert.equal((await request('/api/sales/special-stock-requests/quote-preview', { role: 'scm', body: payload })).status, 403);
  assert.equal((await request('/api/sales/special-stock-requests/quote-preview', { role: 'sales', body: { ...payload, lines: [] } })).status, 400);
});
async function pendingDraft() {
  let d=await draft();
  d=await repository.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899410,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:0,
    materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'TEST product',quantity:30,packageQuantity:3,conversionToPc:10,uom:'PC',rate:50,discountPercent:10}]},context);
  return d;
}
test('quantity endpoints enforce login, SCM-only approval, Sales role, yard scope and workflow gate',async()=>{
  const d=await pendingDraft(),body={expectedRevision:d.revision,reviewId:d.quantityReview.id,decision:'approve',lines:[{caseLineId:d.lines[0].id,quantity:4}]};
  assert.equal((await request(reviewPath(d),{body})).status,401);
  assert.equal((await request(reviewPath(d),{body,role:'sales'})).status,403);
  assert.equal((await request(reviewPath(d),{body,role:'dispatch'})).status,403);
  assert.equal((await request(changePath(d),{body,role:'scm'})).status,403);
  assert.equal((await request(changePath(d),{body,role:'other'})).payload.code,'SPECIAL_CASE_STORE_FORBIDDEN');
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  const disabled=await request(reviewPath(d),{body,role:'scm'});
  assert.equal(disabled.status,404);assert.equal(disabled.payload.code,'SPECIAL_STOCK_DISABLED');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
});
test('simultaneous SCM approvals commit once and Sales cannot bypass the review through test skips',async()=>{
  let d=await pendingDraft();
  assert.equal((await request(endpoint(d),{role:'sales',body:{expectedRevision:d.revision}})).payload.code,'SPECIAL_QUANTITY_REVIEW_REQUIRED');
  const body={expectedRevision:d.revision,reviewId:d.quantityReview.id,decision:'approve',verifiedOrderIds:[999999],plan:{orders:[]}};
  const results=await Promise.all([1,2].map(()=>request(reviewPath(d),{role:'scm',body})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  d=results.find(result=>result.status===200).payload;
  assert.equal(d.quantityReviewPending,false);assert.equal(d.salesOrderLines[0].quantity,30);assert.equal(d.salesOrderLines[0].rate,5);
  assert.equal(d.events.filter(event=>event.eventType==='special_quantity_review_approved').length,1);
  assert.equal((await request(reviewPath(d),{role:'scm',body})).payload.code,'SPECIAL_REVISION_CONFLICT');
});
test('new enquiry rejects a missing line rate and calculates each line discount independently',async()=>{
  const body={salesRepId:123,storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST priced HTTP',vendorName:'TEST vendor',fulfillmentMethod:'yard_pickup',
    lines:[{productName:'TEST A',quantity:2,uom:'PLT',requiredDate:'2099-02-01',discountPercent:10}]};
  assert.equal((await request('/api/sales/special-stock-requests',{role:'sales',body})).payload.code,'SPECIAL_RATE_INVALID');
  body.lines[0].rate=120;body.lines.push({...body.lines[0],productName:'TEST B',rate:20,quantity:3,discountPercent:25});
  const response=await request('/api/sales/special-stock-requests',{role:'sales',body});assert.equal(response.status,201);ids.push(response.payload.id);
  assert.deepEqual(response.payload.lines.map(line=>line.subtotal),[216,45]);
});


test('yard queue HTTP access cannot be widened by query parameters; SCM gets all-yard filters', async () => {
  const d=await draft();
  const basePath='/api/sales/special-stock-requests';
  const own=await request(`${basePath}?storeLocationId=1&authorizedStoreLocationIds=28&audience=scm`,{role:'sales'});
  assert.equal(own.status,200);assert.ok(own.payload.requests.some(row=>row.id===d.id));
  assert.deepEqual(own.payload.yards.map(yard=>yard.locationId),[1]);
  assert.ok(own.payload.requests.every(row=>row.storeLocationId===1));
  const other=await request(`${basePath}?storeLocationId=1&authorizedStoreLocationIds=1&audience=scm`,{role:'other'});
  assert.equal(other.status,200);assert.deepEqual(other.payload.requests,[]);
  assert.equal((await request(`${basePath}/${d.id}`,{role:'other'})).status,403);
  assert.equal((await documentRequest(`${basePath}/${d.id}/orders/sales_order.pdf`,'other')).status,403);
  assert.equal((await request('/api/scm/special-stock-requests',{role:'sales'})).status,403);
  const scm=await request('/api/scm/special-stock-requests?storeLocationId=1&authorizedStoreLocationIds=28',{role:'scm'});
  assert.equal(scm.status,200);assert.ok(scm.payload.requests.some(row=>row.id===d.id));assert.ok(scm.payload.yards.length>1);
  assert.equal((await request(`${basePath}?storeLocationId=bad`,{role:'sales'})).status,400);
});

test('delivery recovery HTTP keeps Sales authorization, scope, revisions and operation ownership while releasing an unapplied lock',async()=>{
 let d=await draft();
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899888,sales_order_ref='TEST-DELIVERY-HTTP-SO',sales_order_approved=true WHERE request_id=$1",[d.id]);
 d=await repository.getSpecialStockCase(d.id);
 d=await repository.claimSpecialFulfillmentChange(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 await repository.failSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,'Preparation unavailable',context);
 d=await repository.getSpecialStockCase(d.id);const before=nativeFetches,path=`/api/sales/special-stock-requests/${d.id}/fulfillment`;
 const body={expectedRevision:d.revision,changeId:d.fulfillmentChange.id,action:'discard'};
 assert.equal((await request(path,{body})).status,401);
 for(const role of ['other','dispatch','scm'])assert.equal((await request(path,{role,body})).status,403);
 assert.equal((await request(path,{role:'sales',body:{...body,expectedRevision:d.revision-1}})).payload.code,'SPECIAL_REVISION_CONFLICT');
 assert.equal((await request(path,{role:'sales',body:{...body,changeId:'foreign'}})).payload.code,'SPECIAL_FULFILLMENT_STALE');
 const replies=await Promise.all([1,2].map(()=>request(path,{role:'sales',body})));
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 const cancelled=replies.find(r=>r.status===200).payload;
 assert.equal(cancelled.fulfillmentChange.status,'cancelled');assert.equal(cancelled.attention,false);assert.equal(cancelled.fulfillmentMethod,'yard_pickup');
 const edited=await request(path,{role:'sales',body:{expectedRevision:cancelled.revision,fulfillmentMethod:'vendor_pickup'}});
 assert.equal(edited.status,200);assert.equal(edited.payload.fulfillmentChange.status,'complete');assert.equal(edited.payload.fulfillmentMethod,'vendor_pickup');
 assert.equal(nativeFetches,before);
});
