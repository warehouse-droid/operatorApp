import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fixture} from '../helpers/backorder-already-ordered.js';

let f,browser;const out=process.env.BACKORDER_BROWSER_OUTPUT || 'test-artifacts/already-ordered-browser';
before(async()=>{f=await fixture({sku:88999702});mkdirSync(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();await f?.close();});
async function pageFor(role,d,width=1440) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(({token,completed})=>{
    localStorage.setItem('mbbs.staff.token',token);
    localStorage.setItem('mbbs.sales.stockRequests.bucket',completed?'completed':'pending');
    localStorage.setItem('mbbs.scm.stockRequests.queue',completed?'closed':'request');
  },{token:f.users[role].token,completed:['closed','completed'].includes(d.stage)});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/stock-requests/backorder/vendors?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"TEST vendor directory unavailable"}'}));
  await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${d.id}`);
  await expect(page.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(d.id));
  const capture=async()=>{writeFileSync(`${out}/${role}-${Date.now()}.coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));};
  return {page,async capture(){await capture();await page.coverage.startJSCoverage({resetOnNavigation:false});},async close(){await capture();await context.close();assert.deepEqual(errors,[]);}};
}
test('SCM can complete Already Ordered with required PO, optional ref and no vendor; Sales sees completion after reload',async()=>{
  const d=await f.create(),ui=await pageFor('scm',d);
  try {
    const p=ui.page,line=p.locator(`[data-backorder-line="${d.lines[0].id}"]`),form=line.locator('[data-action$="/response"]');
    assert.ok((await form.locator('[name="supplyStatus"] option').allTextContents()).includes('Already Ordered'));
    await expect(form.locator('[name="poNumber"]')).toBeHidden();
    await form.locator('[name="supplyStatus"]').selectOption('already_ordered');
    await expect(form.locator('[name="poNumber"]')).toBeVisible();await expect(form.locator('[name="poRefNumber"]')).toBeVisible();
    await expect(form.locator('[name="vendorId"]')).toBeDisabled();await expect(form.locator('[name="vendorId"]')).toBeHidden();
    assert.equal(await form.evaluate(el=>el.checkValidity()),false);await expect(form).toContainText('complete');
    await form.locator('[name="poNumber"]').fill('PO-<browser>');await form.locator('[name="poRefNumber"]').fill('REF-"browser"');
    assert.equal(await form.evaluate(el=>el.checkValidity()),true);
    await form.locator('[name="supplyStatus"]').selectOption('in_stock');await expect(form.locator('[name="poNumber"]')).toBeHidden();await expect(form.locator('[name="vendorId"]')).toBeEnabled();
    await form.locator('[name="supplyStatus"]').selectOption('already_ordered');await expect(form.locator('[name="poNumber"]')).toHaveValue('PO-<browser>');
    await p.screenshot({path:out+'/scm-already-ordered-fields.png',fullPage:true});
    const response=p.waitForResponse(r=>r.url().endsWith(`/lines/${d.lines[0].id}/response`)&&r.request().method()==='POST');
    await form.locator('button[type="submit"]').click();assert.equal((await response).status(),200);
    await expect(line).toContainText('Already Ordered · Completed');await expect(line).toContainText('PO-<browser>');await expect(line.locator('form')).toHaveCount(0);
    await expect(p.locator(`[data-backorder-line="${d.lines[1].id}"] form`)).toHaveCount(1);
    await ui.capture();await p.reload();await expect(line).toContainText('PO-<browser>');
  }finally{await ui.close();}
  const sales=await pageFor('sales',d,480);
  try {
    const line=sales.page.locator(`[data-backorder-line="${d.lines[0].id}"]`);
    await expect(line).toContainText('Already Ordered · Completed');await expect(line).toContainText('PO-<browser>');await expect(line).toContainText('REF-"browser"');await expect(line.locator('form')).toHaveCount(0);
    assert.ok(await line.evaluate(el=>el.getBoundingClientRect().right<=document.documentElement.clientWidth));
    await sales.page.screenshot({path:out+'/sales-completed-line-mobile.png',fullPage:true});
  }finally{await sales.close();}
});
test('All Already Ordered request shows Completed and no remaining SO/PO steps',async()=>{
  const d=await f.ordered(await f.create(1)),ui=await pageFor('scm',d);
  try {
    const detail=ui.page.locator('[data-backorder-detail]');await expect(detail).toContainText('Completed');
    await expect(detail.locator('form')).toHaveCount(0);await expect(detail).not.toContainText('SO link → Completed');
    await expect(detail).toContainText('Not required');await expect(detail).not.toContainText('PO planning');
    await ui.page.screenshot({path:out+'/scm-completed-request.png',fullPage:true});
  }finally{await ui.close();}
});
test('Already Ordered completion removes an outstanding information reply from Sales actions',async()=>{
  let d=await f.create(1);d=await f.action(d,'scm','information/request',{question:'TEST confirm stock requirements'});
  assert.equal(d.stage,'pending_update');d=await f.ordered(d);assert.equal(d.stage,'completed');
  const ui=await pageFor('sales',d);
  try {
    await expect(ui.page.locator('[data-action="information/submit"]')).toHaveCount(0);
    await expect(ui.page.locator('[data-backorder-line] form')).toHaveCount(0);
  }finally{await ui.close();}
});
test('Completing the last material after a PO was linked removes its remaining planning prompt',async()=>{
  let d=await f.review(await f.create(1));d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,netsuite_active) VALUES(88999721,'TEST-ALREADY-BROWSER-PO',331,1,true)");
  try {
    d=await f.action(d,'scm','purchase-order/link',{purchaseOrderRef:'TEST-ALREADY-BROWSER-PO'});
    d=await f.ordered(d);assert.equal(d.stage,'completed');const ui=await pageFor('scm',d);
    try {
      await expect(ui.page.locator('[data-backorder-detail]')).not.toContainText('Not planned');
      await expect(ui.page.locator('[data-backorder-detail] form')).toHaveCount(0);
      await expect(ui.page.locator('[data-backorder-line]')).toContainText('Already Ordered · Completed');
    }finally{await ui.close();}
  }finally{await f.query('DELETE FROM sales_stock_requests WHERE id=$1',[d.id]);await f.query('DELETE FROM purchase_orders WHERE netsuite_id=88999721');}
});
