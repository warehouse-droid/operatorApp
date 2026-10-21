/* global localStorage */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb,beginRollbackContext} from '../../../src/db.js';
import * as cases from '../../../src/special-stock-request-repository.js';
import {withBackorderWorkflow} from '../../../src/stock-case-workflow.js';
import {submitBackorderRequest} from '../../../src/backorder-request-service.js';
import {updateScmScheduleEntry} from '../../../src/dispatch-repository.js';
const users={},requests=[],orders=[];
let server,base,browser;
const context=()=>({operatorId:users.sales.id,authorizedStoreLocationIds:[1]});
async function call(role,path,body,status=200) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(role?{authorization:'Bearer '+users[role].token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const payload=await response.json();assert.equal(response.status,status,JSON.stringify(payload));return payload;
}
const send=(d,role='scm',extra={},status=200)=>call(role,`/api/scm/special-stock-requests/${d.id}/purchase-order/sent-to-vendor`,{expectedRevision:d.revision,...extra},status);
async function fixture({so=true,po=true,supply='in_stock',method='yard_pickup'}={}) {
  let d=await cases.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Vendor Confirmation '+crypto.randomUUID(),vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:method,deliveryAddress:'TEST Yard',lines:[{productName:'TEST vendor material',quantity:1,uom:'PCS',rate:25,requiredDate:'2099-02-01'}]},context());requests.push(d.id);
  d=await cases.saveSpecialStockChecks(d.id,{expectedRevision:d.revision,lines:[{lineId:d.lines[0].id,kind:'response',supplyStatus:supply,availabilityMode:'dated',availableDate:'2099-02-01',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST Yard'}]},{operatorId:users.scm.id});
  d=await cases.saveSpecialCustomerDecisions(d.id,{expectedRevision:d.revision,lines:[{lineId:d.lines[0].id,decision:'accepted'}]},context());
  const sales=92920000+d.id*2,purchase=sales+1;orders.push({so:sales,po:purchase});
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,fulfillment_status,netsuite_active) VALUES($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',true)",[sales,'TEST-VENDOR-SO-'+d.id]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,receipt_status,netsuite_active,initial_scm_status) VALUES($1,$2,'B','Purchase Order : Pending Receipt','not_received',true,'Hold')",[purchase,'TEST-VENDOR-PO-'+d.id]);
  if(so)d=await call('sales',`/api/sales/special-stock-requests/${d.id}/sales-order/link`,{expectedRevision:d.revision,salesOrderRef:'TEST-VENDOR-SO-'+d.id,manualLink:true});
  if(po)d=await call('scm',`/api/scm/special-stock-requests/${d.id}/purchase-order/link`,{expectedRevision:d.revision,purchaseOrderRef:'TEST-VENDOR-PO-'+d.id,customLinkage:true});
  return d;
}
async function projections(d,stage) {
  assert.equal(d.stage,stage);assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,stage);
  for(const role of ['sales','scm']) {
    assert.equal((await call(role,`/api/${role}/special-stock-requests/${d.id}`)).stage,stage);
    const list=await call(role,`/api/${role}/special-stock-requests?stages=${stage}&search=${d.requestRef}`);
    assert.ok(list.requests.some(row=>row.id===d.id&&row.stage===stage));
  }
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']) {
    const username='vendor-stage-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();
    users[role]=await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:[1]});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);users[role].token=(await response.json()).token;
  }
});
after(async()=>{
  try {
    await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requests]);
    await query("DELETE FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref LIKE 'TEST-VENDOR-%'");
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[orders.map(o=>o.po)]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[orders.map(o=>o.so)]);
    for(const u of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[u.id]);await query('DELETE FROM operators WHERE id=$1',[u.id]);}
  }finally{await closeDb();}
});
test('Special accepted materials and PO alone stay Await Customer Confirmation until the actual SO link',async()=>{
  for(const supply of ['in_stock','production','vendor_transfer']) {
    let d=await fixture({so:false,po:false,supply});await projections(d,'await_customer_confirmation');
    d=await call('scm',`/api/scm/special-stock-requests/${d.id}/purchase-order/link`,{expectedRevision:d.revision,purchaseOrderRef:'TEST-VENDOR-PO-'+d.id,customLinkage:true});await projections(d,'await_customer_confirmation');
    d=await call('sales',`/api/sales/special-stock-requests/${d.id}/sales-order/link`,{expectedRevision:d.revision,salesOrderRef:'TEST-VENDOR-SO-'+d.id,manualLink:true});await projections(d,'confirmed');
  }
});
test('SCM records PO sent once with server time, actor, persisted stage and an audit event',async()=>{
  const original=await fixture();const start=Date.now();
  let d=await send(original,'scm',{purchaseOrderId:999,purchaseOrderSentToVendorAt:'1900-01-01',purchaseOrderSentToVendorBy:'forged'});
  await projections(d,'waiting_vendor_confirmation');assert.equal(d.revision,original.revision+1);assert.equal(d.purchaseOrderSentToVendorBy,users.scm.id);assert.ok(new Date(d.purchaseOrderSentToVendorAt).getTime()>=start);
  const events=()=>query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_purchase_order_sent_to_vendor'",[d.id]);
  assert.equal((await events()).rowCount,1);assert.equal((await events()).rows[0].actor_id,users.scm.id);assert.equal(Number((await events()).rows[0].details.purchaseOrderId),d.purchaseOrderId);
  const again=await send(d);assert.equal(again.revision,d.revision);assert.equal(again.purchaseOrderSentToVendorAt,d.purchaseOrderSentToVendorAt);assert.equal((await events()).rowCount,1);
  assert.equal((await send(original,'scm',{},409)).code,'SPECIAL_REVISION_CONFLICT');
  await updateScmScheduleEntry({orderKind:'PO',orderRef:d.purchaseOrderRef,expectedUpdatedAt:null,patch:{status:'Queued',packingSlipRef:'TEST-VENDOR-REF-'+d.id,method:'MBT'},updatedBy:users.scm.id});
  d=await cases.getSpecialStockCase(d.id);await projections(d,'dispatch_arrangement');
});
test('PO sent before SO is linked preserves customer waiting and later becomes vendor waiting',async()=>{
  let d=await fixture({so:false});d=await send(d);await projections(d,'await_customer_confirmation');assert.ok(d.purchaseOrderSentToVendorAt);
  d=await call('sales',`/api/sales/special-stock-requests/${d.id}/sales-order/link`,{expectedRevision:d.revision,salesOrderRef:'TEST-VENDOR-SO-'+d.id,manualLink:true});await projections(d,'waiting_vendor_confirmation');
});
test('SCM action rejects wrong role, anonymous, missing PO, terminal cases and pending edits',async()=>{
  let d=await fixture();await send(d,'sales',{},403);await send(d,null,{},401);
  await send(d,'scm',{expectedRevision:0},400);
  const missing=await fixture({po:false});assert.equal((await send(missing,'scm',{purchaseOrderId:d.purchaseOrderId},409)).code,'SPECIAL_PO_LINK_REQUIRED');
  for(const [sql,code] of [
    ["close_status='closed'",'SPECIAL_CASE_CLOSED'],["close_status='closure_pending'",'SPECIAL_CASE_CLOSED'],
    ["information_request='{\"status\":\"pending\"}'::jsonb",'SPECIAL_UPDATE_PENDING'],
    ["purchase_order_operation_status='creating'",'SPECIAL_OPERATION_BUSY'],
    ["quantity_review='{\"status\":\"pending\",\"id\":\"TEST\"}'::jsonb",'SPECIAL_QUANTITY_REVIEW_REQUIRED']
  ]) {
    const row=await fixture();await query('UPDATE sales_special_stock_cases SET '+sql+' WHERE request_id=$1',[row.id]);
    const error=await send(row,'scm',{},409);assert.equal(error.code,code);assert.equal((await cases.getSpecialStockCase(row.id)).revision,row.revision);
  }
  const cancelled=await fixture();await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[cancelled.id]);await send(cancelled,'scm',{},409);
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,raw,synced_at) VALUES(92910001,'TEST-VENDOR-BACKORDER','TEST Regular','EA','TEST Vendor','{}',now()) ON CONFLICT DO NOTHING");
  const wrongKind=await submitBackorderRequest({destinationLocationId:1,fulfillmentMethod:'yard_pickup',customerName:'TEST vendor wrong workflow',lines:[{itemId:92910001,salesQty:1}]},{...context(),authorizedDestinationLocationIds:[1]});requests.push(wrongKind.id);
  await send(wrongKind,'scm',{},404);
  await assert.rejects(withBackorderWorkflow(()=>cases.markSpecialPurchaseOrderSentToVendor(wrongKind.id,{expectedRevision:wrongKind.revision},{operatorId:users.scm.id})),e=>e.status===404);
  const completed=await fixture();await query("UPDATE purchase_orders SET receipt_status='received' WHERE netsuite_id=$1",[completed.purchaseOrderId]);await query("UPDATE sales_orders SET status_text='Pending Billing' WHERE netsuite_id=$1",[completed.salesOrderId]);await send(completed,'scm',{},409);
  const dispatched=await fixture();await updateScmScheduleEntry({orderKind:'PO',orderRef:dispatched.purchaseOrderRef,expectedUpdatedAt:null,patch:{status:'Queued',packingSlipRef:'TEST-VENDOR-DISPATCHED-'+dispatched.id,method:'MBT'},updatedBy:users.scm.id});
  assert.equal((await send(dispatched,'scm',{},409)).code,'SPECIAL_PO_ALREADY_DISPATCHED');
});
test('racing SCM acknowledgements save exactly one event and one revision',async()=>{
  const d=await fixture();const responses=await Promise.all([1,2].map(()=>fetch(base+`/api/scm/special-stock-requests/${d.id}/purchase-order/sent-to-vendor`,{method:'POST',headers:{authorization:'Bearer '+users.scm.token,'content-type':'application/json'},body:JSON.stringify({expectedRevision:d.revision})})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);const saved=await cases.getSpecialStockCase(d.id);assert.equal(saved.revision,d.revision+1);assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_purchase_order_sent_to_vendor'",[d.id])).rows[0].n,1);
});
test('same PO relink preserves sent evidence and another PO cannot replace it',async()=>{
  const original=await send(await fixture());
  const d=await call('scm',`/api/scm/special-stock-requests/${original.id}/purchase-order/link`,{expectedRevision:original.revision,purchaseOrderRef:original.purchaseOrderRef,customLinkage:true});
  assert.equal(d.purchaseOrderSentToVendorAt,original.purchaseOrderSentToVendorAt);assert.equal(d.purchaseOrderSentToVendorBy,original.purchaseOrderSentToVendorBy);
  const other=await fixture({so:false,po:false});
  const error=await call('scm',`/api/scm/special-stock-requests/${d.id}/purchase-order/link`,{expectedRevision:d.revision,purchaseOrderRef:'TEST-VENDOR-PO-'+other.id,customLinkage:true},409);
  assert.equal(error.code,'SPECIAL_PO_ALREADY_LINKED');const saved=await cases.getSpecialStockCase(d.id);assert.equal(saved.purchaseOrderId,d.purchaseOrderId);assert.equal(new Date(saved.purchaseOrderSentToVendorAt).toISOString(),d.purchaseOrderSentToVendorAt);await projections(saved,'waiting_vendor_confirmation');
});
test('migration reapply and view rollback preserve sent metadata and order data',async()=>{
  const d=await send(await fixture());const before=(await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0];
  const transaction=await beginRollbackContext();try { await transaction.run(async()=>{
    await query(await readFile('migrations/289_special_po_dispatch_stage.sql','utf8'));
    assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
    await query(await readFile('migrations/296_special_vendor_confirmation.sql','utf8'));
    await query(await readFile('migrations/296_special_vendor_confirmation.sql','utf8'));
    assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'waiting_vendor_confirmation');
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0],before);
  }); }finally{await transaction.rollback();}
});
test('SCM browser button saves the real request and Sales sees the waiting status after reload',async()=>{
  const d=await fixture();browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
  const out=process.env.SPECIAL_VENDOR_BROWSER_OUTPUT||'test-artifacts/browser';await mkdir(out,{recursive:true});
  for(const width of [1440,390]) {
    const record=width===1440?d:await fixture({so:false});
    const ctx=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});const page=await ctx.newPage();page.setDefaultTimeout(10000);
    await ctx.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),users.scm.token);
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    try {
      await page.goto(base+'/scm/stock-requests?tab=special&requestId='+record.id);
      await expect(page.locator('.stock-request-heading h2')).toHaveText(record.requestRef);
      const poCard=page.locator('div.special-planning-order').filter({has:page.getByRole('button',{name:'Preview PO',exact:true})});
      await expect(poCard).toHaveCount(1);
      const sentButton=poCard.getByRole('button',{name:'PO Sent to Vendor',exact:true});
      await expect(sentButton).toBeVisible();
      await expect(page.getByRole('button',{name:'PO Sent to Vendor',exact:true})).toHaveCount(1);
      await expect(page.locator('.stock-request-list [data-special-po-sent-form]')).toHaveCount(0);
      assert.ok(await sentButton.evaluate(button=>{
        const bounds=button.getBoundingClientRect(),card=button.closest('.special-planning-order').getBoundingClientRect();
        return bounds.left>=card.left&&bounds.right<=card.right&&bounds.top>=card.top&&bounds.bottom<=card.bottom
          &&bounds.left>=0&&bounds.right<=button.ownerDocument.documentElement.clientWidth;
      }),'PO action stays inside its card and viewport');
      await page.screenshot({path:out+'/scm-button-'+width+'.png',fullPage:true});
      const sentResponse=page.waitForResponse(response=>response.url().endsWith(`/special-stock-requests/${record.id}/purchase-order/sent-to-vendor`)&&response.request().method()==='POST');
      await sentButton.click();
      const response=await sentResponse;assert.equal(response.status(),200);assert.ok((await response.json()).purchaseOrderSentToVendorAt);
      await expect(page.getByRole('button',{name:'PO Sent to Vendor',exact:true})).toHaveCount(0);
      await expect(poCard.getByRole('status')).toHaveText('PO sent to vendor');
      await page.reload();await expect(poCard.getByRole('status')).toHaveText('PO sent to vendor');await expect(page.getByRole('button',{name:'PO Sent to Vendor',exact:true})).toHaveCount(0);
      const saved=await cases.getSpecialStockCase(record.id);assert.ok(saved.purchaseOrderSentToVendorAt);await projections(saved,record.salesOrderId?'waiting_vendor_confirmation':'await_customer_confirmation');
      await page.screenshot({path:out+'/scm-'+width+'.png',fullPage:true});
      await writeFile(out+'/coverage-'+width+'.json',JSON.stringify(await page.coverage.stopJSCoverage()));
    }catch(error){await page.screenshot({path:out+'/failure-'+width+'.png',fullPage:true});throw error;}finally{await ctx.close();}
  }
  const alerts=await call('sales','/api/sales/special-stock-requests/po-reference-alerts');
  for(const notice of alerts.alerts)await call('sales',`/api/sales/special-stock-requests/po-reference-alerts/${notice.requestId}/ack`,{noticeKey:notice.noticeKey});
  const sales=await browser.newContext({serviceWorkers:'block'});try {
    await sales.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),users.sales.token);
    const page=await sales.newPage();await page.goto(base+'/sales/stock-requests?tab=special&requestId='+d.id);
    await expect(page.locator('.stock-request-heading').getByText('Waiting Vendor Confirmation',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'PO Sent to Vendor',exact:true})).toHaveCount(0);
    await page.locator('.special-stage-filter summary').click();
    await expect(page.getByRole('checkbox',{name:'Waiting Vendor Confirmation',exact:true})).toBeVisible();
    await page.screenshot({path:out+'/sales-waiting.png',fullPage:true});
  }finally{await sales.close();}
});
