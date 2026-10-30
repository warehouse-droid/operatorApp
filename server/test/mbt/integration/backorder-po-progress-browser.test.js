import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {poProgressFixture} from '../helpers/backorder-po-progress.js';
let f,browser;
after(async()=>{await browser?.close();await f?.close();});
before(async()=>{f=await poProgressFixture(88999352);browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
async function open(role,path) {
  const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.goto(f.base+path);
  return {page,async close(){await context.close();assert.deepEqual(errors,[]);}};
}

test('Sales receives distinct reference/planned popups, sees native / live ref on the line, and opening acknowledges across sessions',async()=>{
  const p=await f.po(),d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  const path=role=>`/${role}/stock-requests?tab=regular&requestId=${d.id}`;
  const initial=await open('sales',path('sales'));
  try {
    await expect(initial.page.locator('[data-backorder-line]')).toContainText(p.ref);
    await expect.poll(async()=>Number((await f.query('SELECT event_id FROM regular_stock_decision_reads WHERE request_id=$1',[d.id])).rows[0]?.event_id||0)).toBe(d.revision);
  } finally {await initial.close();}
  const reference='REF-<AVAILABLE>-040951',refUI=await open('sales','/sales');
  try {
    const page=refUI.page;
    await expect.poll(()=>page.evaluate(()=>!!window.MBBSRegularStockAlert)).toBe(true);
    await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(page.locator('.regular-stock-popup')).toHaveCount(0);
    await f.query('UPDATE purchase_orders SET dispatch_ref=$2 WHERE netsuite_id=$1',[p.id,reference]);
    await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    const popup=page.locator('.regular-stock-popup');await expect(popup).toBeVisible();await expect(popup.getByRole('heading')).toHaveText('PO reference available');
    await expect(popup).toContainText(p.ref+' / '+reference);
    await popup.getByRole('link',{name:'Open request',exact:true}).click();
    const line=page.locator('[data-backorder-line]');await expect(line).toContainText(p.ref+' / '+reference);await expect(line.locator('available')).toHaveCount(0);
    await expect.poll(async()=>(await f.alerts(d)).filter(n=>n.action==='po_reference').length).toBe(0);
  } finally {await refUI.close();}
  const plannedUI=await open('sales','/sales');
  try {
    const page=plannedUI.page;
    await expect.poll(()=>page.evaluate(()=>!!window.MBBSRegularStockAlert)).toBe(true);
    await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(page.locator('.regular-stock-popup')).toHaveCount(0);
    const plan=await f.plan(p.ref,{alias:reference,group:true});
    await page.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    const popup=page.locator('.regular-stock-popup');await expect(popup).toBeVisible();await expect(popup.getByRole('heading')).toHaveText('PO planned');
    await expect(popup).toContainText(plan.plan_date);
    await popup.getByRole('link',{name:'Open request',exact:true}).click();
    const line=page.locator('[data-backorder-line]');await expect(line).toContainText(p.ref+' / '+reference);await expect(line).toContainText('PO planned · '+plan.plan_date);
    await expect.poll(async()=>(await f.alerts(d)).length).toBe(0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  } finally {await plannedUI.close();}
  // No local popup history in this session: durable acknowledgment must still win.
  const reopened=await open('sales',path('sales'));
  try {
    await expect(reopened.page.locator('[data-backorder-line]')).toContainText(p.ref+' / '+reference);
    await reopened.page.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(reopened.page.locator('.regular-stock-popup')).toHaveCount(0);
  } finally {await reopened.close();}
  const scm=await open('scm',path('scm'));
  try {
    await expect(scm.page.locator('[data-backorder-line]')).toContainText(p.ref+' / '+reference);
    await expect(scm.page.locator('[data-backorder-line]')).toContainText('PO planned');
  } finally {await scm.close();}
});
