import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';

let f,browser;
before(async()=>{f=await fixture({sku:88999515});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();await f?.close();});
for(const width of [1440,390])test(`Backorder Add item uses Special Order styling and saves native material fields at ${width}px`,async()=>{
  let d=await f.create(1);d=await f.review(d,0);d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'});
  try {
    await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.appSidebar.collapsed','true');window.EventSource=class{addEventListener(){}removeEventListener(){}close(){}};},f.users.sales.token);
    const p=await context.newPage(),errors=[];p.setDefaultTimeout(10000);p.on('pageerror',error=>errors.push(error.message));
    await p.addLocatorHandler(p.locator('dialog.regular-stock-popup[open]'),async dialog=>{
      await dialog.getByRole('button',{name:'Close',exact:true}).click();
    },{noWaitAfter:true});
    await p.goto(`${f.base}/sales/stock-requests?tab=regular&requestId=${d.id}`);
    const button=p.getByRole('button',{name:'Add item',exact:true});await expect(button).toBeVisible();
    await expect(button).toHaveCSS('background-color','rgb(124, 58, 237)');
    await button.click();const dialog=p.getByRole('dialog');await expect(dialog).toContainText('New enquiry');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await f.detail(d)).revision,d.revision);
    await button.click();await expect(dialog).toBeVisible();await p.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    await button.click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    await p.getByRole('button',{name:'Add another item',exact:true}).click();await expect(p.locator('[data-sales-stock-line]')).toHaveCount(2);
    await p.locator('[data-sales-stock-action="remove-line"]').last().click();
    await p.locator('[data-sales-stock-field="itemSearch"]').fill('TEST-ALREADY-ORDERED');
    await p.locator('[data-sales-stock-action="choose-item"]').click();
    await p.locator('[data-sales-stock-field="salesQty"]').fill('7');
    await p.locator('[data-sales-stock-field="vendorName"]').fill('Added Vendor');
    await p.locator('[data-sales-stock-field="customerNote"]').fill('Added material note');
    await expect(p.locator('[data-sales-stock-field="destinationLocationId"]')).toHaveValue('1');
    const submit=p.getByRole('button',{name:'Submit new items to SCM',exact:true});
    await p.route(`**/api/sales/stock-requests/${d.id}/backorder/items`,route=>route.fulfill({status:503,json:{error:'Temporary save failure'}}),{times:1});
    await submit.click();await expect(p.locator('[data-sales-stock-field="salesQty"]')).toHaveValue('7');
    await expect(p.locator('[data-sales-stock-field="vendorName"]')).toHaveValue('Added Vendor');
    await submit.click();await expect(p.locator('[data-sales-stock-form]')).toHaveCount(0);
    await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Pending SCM');
    const saved=await f.detail(d);assert.equal(saved.lines.length,2);assert.equal(saved.stage,'new_enquiry');
    assert.equal(saved.lines[0].salesDecision,'accepted');assert.equal(saved.lines[1].quantity,7);assert.equal(saved.lines[1].vendorName,'Added Vendor');
    assert.equal(saved.lines[1].customerNote,'Added material note');assert.deepEqual(errors,[]);
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  } finally {await context.close();}
});
