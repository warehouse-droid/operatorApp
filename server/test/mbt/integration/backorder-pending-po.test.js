import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {regularStockAlerts} from '../../../src/regular-stock-request-service.js';
import {chooseRegularStatuses,dismissRegularAlerts} from '../../support/regular-stock-status-browser.mjs';

const out='test-artifacts/backorder-pending-po-20261021';
const so=88999680,po=88999681;
let f,d,browser;
before(async()=>{
  mkdirSync(out,{recursive:true});f=await fixture({sku:88999682});
  await f.query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status_text,netsuite_active) VALUES($1,'TEST-PENDING-PO-SO',18,1,'Pending Fulfillment',true)",[so]);
  await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-PENDING-PO-PO',331,1,'Pending Receipt',true)",[po]);
  d=await f.review(await f.create(2));
  d=await f.action(d,'scm',`lines/${d.lines[1].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-02',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST yard'});
  for(const line of d.lines)d=await f.action(d,'sales',`lines/${line.id}/decision`,{decision:'accepted'});
  assert.equal(d.statusSummary.status,'pending_sales');assert.equal(d.statusSummary.detail,'awaiting_so');
  d=await f.action(d,'sales','sales-order/link',{salesOrderRef:'TEST-PENDING-PO-SO'});
});
after(async()=>{
  await browser?.close();
  if(f)await f.close();
});

test('Sales and SCM APIs filter SO-linked requests by Pending SCM and retain production waiting',async()=>{
  const snapshot=async()=>(await f.query('SELECT status,revision,regular_details FROM sales_stock_requests WHERE id=$1',[d.id])).rows;
  const before=await snapshot();
  for(const role of ['sales','scm']){
    const detail=await f.detail(d,role);
    assert.equal(detail.statusSummary.status,'pending_scm');assert.equal(detail.statusSummary.detail,'awaiting_po');
    assert.deepEqual(detail.statusSummary.waitingReasons,['production']);
    for(const [status,included] of [['pending_scm',true],['pending_sales',false],['in_progress',false],['pending_scm,completed',true]]){
      const result=await f.http(role,`/api/${role}/stock-requests?type=backorder&queue=&search=${d.requestRef}&unifiedStatus=${status}&waitingReason=production`);
      assert.equal(result.status,200);assert.equal(result.body.requests.some(row=>row.id===d.id),included);
    }
  }
  const alerts=await regularStockAlerts({operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1]});
  assert(!alerts.requests.some(row=>row.id===d.id&&row.action==='input_required'));
  assert.deepEqual(await snapshot(),before);
});

test('Sales and SCM browsers show Pending SCM and Awaiting PO in the list, filter and detail',async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const role of ['sales','scm']){
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
    await dismissRegularAlerts(page);page.on('pageerror',error=>errors.push(error.message));
    try{
      await page.goto(f.base+`/${role}/stock-requests?tab=regular`);
      const card=page.locator(`.stock-request-card[data-id="${d.id}"]`);
      await expect(card.locator('[data-regular-main-status]')).toHaveText('Pending SCM');
      await expect(card.locator('.regular-status-detail')).toHaveText('Awaiting PO');
      await expect(card.locator('[data-stock-request-waiting]')).toHaveText('Waiting for Production');
      await chooseRegularStatuses(page,role,'pending_scm');await expect(card).toBeVisible();
      await chooseRegularStatuses(page,role,'in_progress');await expect(card).toHaveCount(0);
      await chooseRegularStatuses(page,role,'pending_scm');await card.click();
      const detail=page.locator('.stock-request-detail');
      await expect(detail.locator('[data-regular-main-status]')).toHaveText('Pending SCM');
      await expect(detail.locator('.regular-status-detail')).toHaveText('Awaiting PO');
      await page.screenshot({path:`${out}/${role}-pending-po.png`,fullPage:true});
      await page.setViewportSize({width:390,height:844});
      await expect(detail.locator('[data-regular-main-status]')).toBeVisible();
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  }
});

test('linking the PO clears Pending SCM and a production-only request then waits for stock',async()=>{
  d=await f.action(d,'scm','purchase-order/link',{purchaseOrderRef:'TEST-PENDING-PO-PO'});
  assert.equal(d.purchaseOrderId,po);assert.equal(d.statusSummary.status,'in_progress');
  assert.equal(d.statusSummary.detail,'processing');assert.deepEqual(d.statusSummary.waitingReasons,['production']);
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'closed',reason:'Material no longer required'});
  assert.equal(d.statusSummary.status,'waiting_stock');assert.equal(d.statusSummary.detail,'supply_wait');
});
