/* global localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {submitBackorderRequest,getBackorderRequest,runBackorderAction} from '../../../src/backorder-request-service.js';
const out='test-artifacts/transfer-eta-20261016',users={},coverage=[],ids=[];
let browser,server,base;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');mkdirSync(out,{recursive:true});
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES(8899261,'TEST-TRANSFER-BROWSER','TEST browser material','EA','TEST Vendor',8899200)");
 await query("INSERT INTO sales_orders(netsuite_id,tranid,trandate,status_text,netsuite_active) VALUES(8899262,'TEST-TRANSFER-BROWSER-SO','2026-10-09','Pending Fulfillment',true)");
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
 for(const role of ['sales','scm']) {
  const username='transfer-browser-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();
  users[role]=await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:role==='sales'?[1]:[]});
  const result=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(result.status,200);users[role].token=(await result.json()).token;
 }
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{
 await browser?.close();writeFileSync(out+'/transfer-browser-coverage.json',JSON.stringify(coverage));
 server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
 try{await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);}finally{await closeDb();}
});
async function pageFor(role,kind,id) {
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');localStorage.setItem('mbbs.scm.stockRequests.queue','request');},users[role].token);
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
 await page.route('**/stock-requests/backorder/vendors?*',route=>route.fulfill({json:{vendors:[]}}));
 await page.goto(`${base}/${role}/stock-requests?tab=${kind==='special'?'special':'regular'}&requestId=${id}`);
 return {page,errors,async reload(){coverage.push(...await page.coverage.stopJSCoverage());await page.coverage.startJSCoverage({resetOnNavigation:false});await page.reload();},async close(){coverage.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
for(const kind of ['special','backorder'])test(`${kind} browser: transfer without date, Sales acceptance, then actual SO ETA`,async()=>{
 const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};
 let d=kind==='special'?await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST transfer browser',vendorId:8899200,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
  lines:[{productName:'TEST browser slab',quantity:2,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]},context)
  :await submitBackorderRequest({destinationLocationId:1,vendorName:'TEST Vendor',vendorId:8899200,fulfillmentMethod:'yard_pickup',lines:[{itemId:8899261,salesQty:2,quantityMode:'direct',requiredDate:'2099-02-01'}]},
  {operatorId:users.sales.id,authorizedDestinationLocationIds:[1]});
 ids.push(d.id);const lineId=d.lines[0].id;
 const get=()=>kind==='special'?repo.getSpecialStockCase(d.id,{audience:'scm'}):getBackorderRequest(d.id,{audience:'scm'});
 const scm=await pageFor('scm',kind,d.id);let sales;
 try {
  const response=scm.page.locator(kind==='special'?`[data-special-stock-line="${lineId}"]`:`[data-backorder-line="${lineId}"] [data-action$="/response"]`);
  await response.locator('[name=supplyStatus]').selectOption('production');await expect(response.locator('[name=availableDate]')).toBeVisible();
  await response.locator('[name=availableDate]').fill('2099-02-01');
  await response.locator('[name=supplyStatus]').selectOption('vendor_transfer');await expect(response.locator('[name=availableDate]')).toBeHidden();
  await expect(response.locator(kind==='special'?'[data-special-transfer-eta]':'[data-backorder-transfer-eta]')).toContainText('SO placement +5 working days');
  await response.locator('[name=vendorYard]').fill('TEST transfer dock');
  const saved=scm.page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith(kind==='special'?'/stock-check':'/response'));
  await scm.page.getByRole('button',{name:kind==='special'?'Save stock check':'Save material review',exact:true}).click();
  assert.equal((await saved).status(),200);d=await get();assert.equal(d.lines[0].availabilityMode,'so_placement');assert.equal(d.lines[0].availableDate,null);
  await scm.page.screenshot({path:`${out}/${kind}-relative-eta.png`,fullPage:true});
  sales=await pageFor('sales',kind,d.id);
  const decision=sales.page.locator(kind==='special'?`[data-special-decision-line="${lineId}"]`:`[data-backorder-line="${lineId}"] [data-action$="/decision"]`);
  await expect(sales.page.locator(kind==='special'?'[data-special-supply-status]':'[data-backorder-line]').first()).toContainText('SO placement +5 working days');
  await decision.locator('[name=decision]').selectOption('accepted');
  const decided=sales.page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.endsWith(kind==='special'?'/customer-decisions':'/decision'));
  await sales.page.getByRole('button',{name:kind==='special'?'Save customer decisions':'Save Sales confirmation',exact:true}).click();
  assert.equal((await decided).status(),200);d=await get();assert.equal(d.lines[0].salesDecision,'accepted');
  await scm.reload();
  if(kind==='special') {
   const readiness=scm.page.locator(`[data-special-stock-line="${lineId}"]`);
   await expect(readiness.locator('[name=eta]')).toBeHidden();await expect(readiness.locator('[data-special-transfer-eta]')).toBeVisible();
   await readiness.locator('[name=ready]').selectOption('true');await expect(readiness.locator('[data-special-transfer-eta]')).toBeHidden();
   await readiness.locator('[name=ready]').selectOption('false');
  }else {
   await scm.page.getByText('Check readiness',{exact:true}).first().click();
   await expect(scm.page.locator('[data-backorder-readiness-eta]')).toBeHidden();
   await expect(scm.page.locator('[data-backorder-readiness-transfer]')).toBeVisible();
   const ready=scm.page.locator('[data-action$="/readiness"] [name=ready]');
   await ready.selectOption('true');await expect(scm.page.locator('[data-backorder-readiness-transfer]')).toBeHidden();
   await ready.selectOption('false');await expect(scm.page.locator('[data-backorder-readiness-transfer]')).toBeVisible();
  }
  const checked=scm.page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith(kind==='special'?'/stock-check':'/readiness'));
  if(kind==='special')await scm.page.getByRole('button',{name:'Save stock check',exact:true}).click();
  else await scm.page.locator('[data-action$="/readiness"]').getByRole('button',{name:'Check readiness',exact:true}).click();
  assert.equal((await checked).status(),200);d=await get();assert.equal(d.lines[0].availableDate,null);assert.equal(d.lines[0].availabilityMode,'so_placement');
  if(kind==='backorder') {
   await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8899263,'TEST-TRANSFER-BROWSER-PO','Pending Receipt',true)");
   d=await runBackorderAction(d.id,'purchase-order/link',{expectedRevision:d.revision,purchaseOrderRef:'TEST-TRANSFER-BROWSER-PO'},{...context,audience:'scm'});
   const plan=(await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-04-11','draft') RETURNING id")).rows[0].id;
   await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan,
    JSON.stringify([{id:'TEST-TRANSFER-BROWSER-PO',type:'PO'}]),JSON.stringify([{plate:'TEST TRANSFER',loads:[{stops:[{type:'pickup',orderId:'TEST-TRANSFER-BROWSER-PO'}]}]}])]);
  }
  d=kind==='special'?await repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderRef:'TEST-TRANSFER-BROWSER-SO'},context)
   :await runBackorderAction(d.id,'sales-order/link',{expectedRevision:d.revision,salesOrderRef:'TEST-TRANSFER-BROWSER-SO'},{...context,audience:'sales'});
  assert.equal(d.lines[0].availableDate,'2026-10-19');
  await scm.reload();await sales.reload();
  await expect(scm.page.locator('.stock-live-summary').first()).toContainText('2026-10-19');
  await expect(sales.page.locator(kind==='special'?'[data-special-supply-status]':'[data-backorder-line]').first()).toContainText('2026-10-19');
  await sales.page.screenshot({path:`${out}/${kind}-placed-eta.png`,fullPage:true});
  assert.deepEqual(scm.errors,[]);assert.deepEqual(sales.errors,[]);
 }finally{await scm.close();await sales?.close();}
});
