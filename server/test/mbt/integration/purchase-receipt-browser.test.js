import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {applyPurchaseReceiptProgress} from '../../../src/purchase-receipt-refresh-repository.js';
let f,browser;
before(async()=>{f=await fixture({sku:985701});});
after(async()=>{await browser?.close();if(f){await f.query('DELETE FROM purchase_orders WHERE netsuite_id IN (985701,985702)');await f.close();}});
test('fully received multiple POs complete the request in Sales and SCM while a mixed production request stays active',async()=>{
  let complete=await f.create(2),mixed=await f.create(2);
  for(const id of [985701,985702]) await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,$2,'Pending Bill',true)",[id,`PO-${id}`]);
  complete=await f.ordered(complete,0,{poNumber:'PO-985701'});complete=await f.ordered(complete,1,{poNumber:'PO-985702'});
  complete=await f.action(complete,'sales','already-ordered/sales-order',{salesOrderRef:'SO-STILL-OPEN'});
  mixed=await f.ordered(mixed,0,{poNumber:'PO-985701'});mixed=await f.review(mixed,1);
  const before=(await f.query('SELECT status,revision FROM sales_stock_requests WHERE id=$1',[complete.id])).rows;
  for(const id of [985701,985702]) await applyPurchaseReceiptProgress({netsuiteOrderId:id,lines:[{line_id:1,item_id:985701,item_name:'Material',item_type:'InvtPart',quantity:10,netsuite_received_qty:10,unit:'EA'}]});
  for(const role of ['sales','scm']) {
    const detail=await f.detail(complete,role);assert.equal(detail.statusSummary.status,'completed');
    const list=await f.http(role,'/api/'+role+'/stock-requests?'+new URLSearchParams({search:complete.requestRef,unifiedStatus:'completed',queue:''}));
    assert.equal(list.status,200);assert(list.body.requests.some(r=>r.id===complete.id));
    assert.notEqual((await f.detail(mixed,role)).statusSummary.status,'completed');
  }
  assert.deepEqual((await f.query('SELECT status,revision FROM sales_stock_requests WHERE id=$1',[complete.id])).rows,before);
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const role of ['sales','scm']) {
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    try {
      await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);window.MBBSOSNotifications={allowsRole:()=>false,notify:async()=>false};},f.users[role].token);
      await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${complete.id}`);
      await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status','completed');
      await expect(page.locator('.stock-request-detail [data-stock-request-waiting="arrived"]')).toBeVisible();
    } finally {await context.close();}
  }
});
