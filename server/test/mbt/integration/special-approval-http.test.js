import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { app } from '../../../src/server.js';

const run = crypto.randomUUID().replaceAll('-', '');
const gate = 'special_stock_request_test_skip_orders';
const tokens = {}, ids = [], users = [];
let server, base, original, originalWorkflow, context;
const plans=[];
async function request(path, { role, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}
async function draft() {
  let detail = await repository.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899310,
    customerName: 'TEST Polish HTTP', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 50, requiredDate: '2099-02-01' }] }, context);
  ids.push(detail.id);
  detail = await repository.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision,
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST yard' }, context);
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  return repository.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision, customerId: 8899310,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST product', quantity: 20, packageQuantity: 2, conversionToPc: 10, uom: 'PC', rate: 50 }] }, context);
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  original = (await query('SELECT enabled FROM mbt_feature_flags WHERE flag_key=$1', [gate])).rows[0].enabled;
  originalWorkflow = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ($1,'special_stock_request_workflow')", [gate]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899310,'TEST-POLISH','TEST Polish HTTP','TEST Polish HTTP','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
  for (const [name, role, yards] of [['sales','sales',[1]],['other','sales',[28]],['scm','scm',[]],['dispatch','dispatcher',[]]]) {
    const username = `approval-${name}-${run}`;
    await createOperator({ username, displayName: `TEST ${name}`, password: 'test-approval-isolated-only', role, roles: [role], yardLocationIds: yards });
    users.push(username);
  }
  context = { operatorId: (await query('SELECT id FROM operators WHERE username=$1', [users[0]])).rows[0].id, authorizedStoreLocationIds: [1] };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['sales','other','scm','dispatch']) {
    const login = await request('/api/auth/login', { body: { username: `approval-${name}-${run}`, password: 'test-approval-isolated-only' } });
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
  await query('DELETE FROM dispatch_plans WHERE id=ANY($1::bigint[])',[plans]);
  await query('DELETE FROM purchase_orders WHERE netsuite_id IN (8899952,8899954)');
  await query('DELETE FROM sales_orders WHERE netsuite_id=8899951');
  await closeDb();
});


test('delivery and PO reference endpoints enforce roles, yard and revision; SCM sees saved Sales delivery details',async()=>{
 let d=await draft();const path=`/api/sales/special-stock-requests/${d.id}/fulfillment`,body={expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST safe site',deliveryDate:'2099-02-01'};
 assert.equal((await request(path,{body})).status,401);
 for(const role of ['scm','dispatch']) assert.equal((await request(path,{role,body})).status,403);
 assert.equal((await request(path,{role:'other',body})).payload.code,'SPECIAL_CASE_STORE_FORBIDDEN');
 const saved=await request(path,{role:'sales',body});assert.equal(saved.status,200);d=saved.payload;assert.equal(d.fulfillmentMethod,'mbt_delivery');
 assert.equal((await request(`/api/scm/special-stock-requests/${d.id}`,{role:'scm'})).payload.deliveryAddress,'TEST safe site');
 assert.equal((await request(path,{role:'sales',body})).payload.code,'SPECIAL_REVISION_CONFLICT');
 await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES(8899952,'TEST-HTTP-PO','B','Pending Receipt',true)");
 await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=8899952,purchase_order_ref='TEST-HTTP-PO' WHERE request_id=$1",[d.id]);
 const refPath=`/api/scm/special-stock-requests/${d.id}/purchase-order/reference`,refBody={expectedRevision:d.revision,reference:'HTTP-REF',previousReference:''};
 for(const role of ['sales','other','dispatch']) assert.equal((await request(refPath,{role,body:refBody})).status,403);
 const refSaved=await request(refPath,{role:'scm',body:refBody});assert.equal(refSaved.status,200);assert.equal(refSaved.payload.purchaseOrderReference,'HTTP-REF');
});
test('planning does not hold a Special case lock or prevent an unplanned delivery claim',async()=>{
 const {assertSpecialStockHandoffPlanning}=await import('../../../src/dispatch-plan-repository.js');
 const d=await draft();await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,netsuite_active) VALUES(8899954,'TEST-PLAN-PO','PLAN-REF','B','Pending Receipt',true)");await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES(8899951,'TEST-HTTP-SO','B','Pending Fulfillment',true)");
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899951,sales_order_ref='TEST-HTTP-SO',purchase_order_netsuite_id=8899954,purchase_order_ref='TEST-PLAN-PO' WHERE request_id=$1",[d.id]);
 await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id) VALUES($1,'direct','ready',8899951,8899954,'TEST vendor','TEST site',1)",[d.id]);
 const plan={orders:[{id:'PLAN-REF',type:'PO'}],trucks:[{plate:'TEST',loads:[{name:'TEST',stops:[{type:'pickup',orderId:'PLAN-REF'}]}]}]};
 let allowCommit,locked;const gate=new Promise(resolve=>allowCommit=resolve),ready=new Promise(resolve=>locked=resolve);
 const planning=withTransaction(async()=>{
  await assertSpecialStockHandoffPlanning(plan);locked();await gate;
  const result=await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2198-01-02','draft') RETURNING id");const id=result.rows[0].id;plans.push(id);
  await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks) VALUES($1,$2::jsonb,$3::jsonb)',[id,JSON.stringify(plan.orders),JSON.stringify(plan.trucks)]);
 });
 await ready;
 try {
  const changed=await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='250ms'");
   return repository.claimSpecialFulfillmentChange(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
  });
  assert.equal(changed.fulfillmentChange.status,'applying');
  assert.equal(changed.fulfillmentChange.target.fulfillmentMethod,'vendor_pickup');
 } finally { allowCommit(); await planning; }
 const current=await repository.getSpecialStockCase(d.id);
 assert.equal(current.fulfillmentChange.status,'applying');assert.equal(current.fulfillmentMethod,'yard_pickup');
});
