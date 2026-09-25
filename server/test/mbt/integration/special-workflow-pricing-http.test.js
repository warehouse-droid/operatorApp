import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { createOperator } from '../../../src/auth-repository.js';
import { query, pool, closeDb } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { app } from '../../../src/server.js';

const run = crypto.randomUUID().replaceAll('-', '');
const gate = 'special_stock_request_test_skip_orders';
const tokens = {}, ids = [], users = [];
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
const poLines = detail => detail.purchaseOrderLines.map(line => ({ caseLineId: line.caseLineId, description: 'TEST PO', quantity: 2, uom: 'PC', unitPurchaseCost: 4 }));

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
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
  if (original !== undefined) await query('UPDATE mbt_feature_flags SET enabled=$2 WHERE flag_key=$1', [gate, original]);
  if (originalWorkflow !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [originalWorkflow]);
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  await closeDb();
});


const changePath=d=>`/api/sales/special-stock-requests/${d.id}/quantity-change`;
const reviewPath=d=>`/api/scm/special-stock-requests/${d.id}/quantity-review`;
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
  assert.equal(d.quantityReviewPending,false);assert.equal(d.salesOrderLines[0].quantity,30);assert.equal(d.salesOrderLines[0].rate,4.5);
  assert.equal(d.events.filter(event=>event.eventType==='special_quantity_review_approved').length,1);
  assert.equal((await request(reviewPath(d),{role:'scm',body})).payload.code,'SPECIAL_REVISION_CONFLICT');
});
test('new enquiry rejects a missing line rate and calculates each line discount independently',async()=>{
  const body={storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST priced HTTP',vendorName:'TEST vendor',fulfillmentMethod:'yard_pickup',
    lines:[{productName:'TEST A',quantity:2,uom:'PLT',requiredDate:'2099-02-01',discountPercent:10}]};
  assert.equal((await request('/api/sales/special-stock-requests',{role:'sales',body})).payload.code,'SPECIAL_RATE_INVALID');
  body.lines[0].rate=120;body.lines.push({...body.lines[0],productName:'TEST B',rate:20,quantity:3,discountPercent:25});
  const response=await request('/api/sales/special-stock-requests',{role:'sales',body});assert.equal(response.status,201);ids.push(response.payload.id);
  assert.deepEqual(response.payload.lines.map(line=>line.subtotal),[216,45]);
});
