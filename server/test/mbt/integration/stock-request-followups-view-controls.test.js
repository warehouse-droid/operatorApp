import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
let f,browser;const ids=[],itemId=985721;
before(async()=>{f=await fixture({sku:itemId});browser=await chromium.launch({args:['--no-sandbox']});await f.query('UPDATE scm_smart_settings SET regular_stock_auto_approval_enabled=true WHERE id=1');await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',10000,10000,now())",[itemId]);});
after(async()=>{await browser?.close();if(f){await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await f.close();}});
async function create(method){
 const r=await submitRegularStockRequest({deliveryMethod:method,destinationLocationId:1,lines:[{itemId,sourceLocationId:28,salesQty:20}]},
  {operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true},
  {refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:28,availableQuantity:10000,safetyQuantity:0}]});ids.push(r.id);return r;
}
async function pageFor(t,id){
 const context=await browser.newContext({timezoneId:'Pacific/Honolulu',serviceWorkers:'block'});t.after(()=>context.close());
 await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users.scm.token);
 const page=await context.newPage();page.setDefaultTimeout(6000);await page.goto(`${f.base}/scm/stock-requests?tab=regular&requestId=${id}`);return page;
}
test('expired approval can be selected and rejected in the SCM screen without re-raising',async t=>{
 const r=await create('pickup');await f.query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}' WHERE id=$1",[r.id]);
 const page=await pageFor(t,r.id),button=page.locator('[data-scm-stock-action="reject"]').first();
 await expect(button).toBeEnabled();await button.click();await page.locator('[data-scm-stock-decision-reason]').fill('Expired request no longer required');
 await page.locator('[data-scm-stock-action="confirm-decision"]').click();
 await expect(page.locator('.stock-request-detail')).toContainText('Expired request no longer required');
 assert.equal((await f.query('SELECT status FROM sales_stock_request_lines WHERE request_id=$1',[r.id])).rows[0].status,'rejected');
});
test('SCM manually confirms destination-yard stock in the regular Stocking screen',async t=>{
 const r=await create('stocking'),page=await pageFor(t,r.id);
 await page.getByRole('button',{name:'Stock available at destination yard',exact:true}).click();
 await expect(page.locator('.stock-request-decision-editor')).toContainText('Stock available at destination yard');
 await page.locator('[data-scm-stock-action="confirm-decision"]').click();
 await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status','completed');
 await expect(page.locator('.stock-request-detail')).toContainText('Stock available at destination yard');
});
test('admin activity timestamps stay in Toronto on a Honolulu device',async t=>{
 const r=await f.create(1),page=await pageFor(t,r.id);
 await page.addScriptTag({url:f.base+'/admin-dispatch-editors.js'});
 await page.evaluate(()=>{const div=document.createElement('div');div.id='clock-fixture';document.body.append(div);window.AdminDispatchEditors.mount(div,async()=>({editors:[{planDate:'2026-01-15',operatorName:'Test editor',heartbeatAt:'2026-01-15T18:30:00Z',expiresAt:'2026-07-15T18:30:00Z'}]}));});
 await expect(page.locator('#clock-fixture')).toContainText('1:30:00 PM');await expect(page.locator('#clock-fixture')).toContainText('2:30:00 PM');
});
