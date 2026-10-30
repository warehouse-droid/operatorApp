import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/backorder-already-ordered.js';

let f,browser;
before(async()=>{f=await fixture({sku:88999442});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();await f?.close();});
async function open(role,d,width=1280) {
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
  const page=await context.newPage(),errors=[];
  const sources=new Map();
  page.on('response',response=>{
    if(response.ok() && /\/(backorder-stock-requests|backorder-review-policy)\.js(?:\?|$)/.test(response.url())) sources.set(response.url(),response.text());
  });
  if(process.env.NODE_V8_COVERAGE) await page.coverage.startJSCoverage({resetOnNavigation:false});
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(6000);
  await page.addLocatorHandler(page.locator('dialog.regular-stock-popup[open]'),async dialog=>{
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
  },{noWaitAfter:true});
  await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${d.id}`);
  await expect(page.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(d.id));
  async function recordCoverage() {
    if(process.env.NODE_V8_COVERAGE) {
      const result=[];
      for(const entry of await page.coverage.stopJSCoverage()) {
        if(!sources.has(entry.url))continue;
        const source=entry.source ?? await sources.get(entry.url);
        assert.equal(typeof source,'string','Coverage must use the actual served source');
        result.push({...entry,source,url:'file:///app/public'+new URL(entry.url).pathname});
      }
      writeFileSync(`${process.env.NODE_V8_COVERAGE}/browser-${randomUUID()}.json`,JSON.stringify({result}));
    }
  }
  return {page,async reload(){
    await recordCoverage();
    if(process.env.NODE_V8_COVERAGE) await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.reload();
  },async close(){await recordCoverage();await context.close();assert.deepEqual(errors,[]);}};
}
async function reviewed() {
  let d=await f.create();
  for(let i=0;i<d.lines.length;i++) d=await f.review(d,i);
  return d;
}

test('Sales attaches an optional SO after all SCM replies on mobile while confirmations remain pending',async()=>{
  const d=await reviewed(),ui=await open('sales',d,390);
  try {
    const p=ui.page,form=p.locator('[data-action="already-ordered/sales-order"]');
    await expect(form).toBeVisible();
    await form.getByLabel('Sales order number',{exact:true}).fill('SO-OPTIONAL-MOBILE');
    await form.getByRole('button',{name:'Save sales order number',exact:true}).click();
    await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Awaiting Sales confirmation');
    await ui.reload();await expect(form.getByLabel('Sales order number',{exact:true})).toHaveValue('SO-OPTIONAL-MOBILE');
    assert.equal((await f.detail(d)).salesOrderId,null);
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  } finally {await ui.close();}
});

test('saved SCM reviews start hidden; Edit restores one material and successful save collapses it',async()=>{
  let d=await reviewed();
  d=await f.action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-02-10',vendorId:331,vendorName:'TEST Vendor',vendorYard:'Saved yard',salesVisibleNote:'Saved SCM note'});
  const ui=await open('scm',d);
  try {
    const p=ui.page,first=p.locator(`[data-backorder-line="${d.lines[0].id}"]`),second=p.locator(`[data-backorder-line="${d.lines[1].id}"]`);
    const form=first.locator('.stock-request-form.backorder-material-review');
    await expect(form).toBeHidden();await expect(second.locator('.backorder-material-review')).toBeHidden();
    const edit=first.getByRole('button',{name:'Edit material review',exact:true});
    await edit.focus();await p.keyboard.press('Enter');
    await expect(form).toBeVisible();await expect(edit).toHaveAttribute('aria-expanded','true');
    await expect(form.locator('[name="supplyStatus"]')).toHaveValue('production');
    await expect(form.locator('[name="availableDate"]')).toHaveValue('2099-02-10');
    await expect(form.locator('[name="vendorYard"]')).toHaveValue('Saved yard');
    await expect(form.locator('[name="salesVisibleNote"]')).toHaveValue('Saved SCM note');
    await expect(second.locator('.backorder-material-review')).toBeHidden();
    await edit.click();await expect(form).toBeHidden();await expect(edit).toHaveAttribute('aria-expanded','false');
    await edit.click();await expect(form).toBeVisible();
    await form.locator('[name="salesVisibleNote"]').fill('Updated SCM note');
    await form.getByRole('button',{name:'Save material review',exact:true}).click();
    await expect(form).toBeHidden();await expect(first).toContainText('Updated SCM note');
    await ui.reload();await expect(form).toBeHidden();
  } finally {await ui.close();}
});

test('saved Sales confirmations start hidden; errors keep edits open and a successful save collapses',async()=>{
  let d=await reviewed();
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted',reason:'Saved reason',customerNote:'Saved Sales note'});
  const ui=await open('sales',d,390);
  try {
    const p=ui.page,first=p.locator(`[data-backorder-line="${d.lines[0].id}"]`),second=p.locator(`[data-backorder-line="${d.lines[1].id}"]`);
    const form=first.locator('[data-action$="/decision"]');
    await expect(form).toBeHidden();await expect(second.locator('[data-action$="/decision"]')).toBeVisible();
    await first.getByRole('button',{name:'Edit Sales confirmation',exact:true}).click();
    await expect(form).toBeVisible();await expect(form.locator('[name="decision"]')).toHaveValue('accepted');
    await expect(form.locator('[name="reason"]')).toHaveValue('Saved reason');
    await expect(form.locator('[name="customerNote"]')).toHaveValue('Saved Sales note');
    await p.route(`**/backorder/lines/${d.lines[0].id}/decision`,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Test stale revision'})}),{times:1});
    await form.locator('[name="customerNote"]').fill('Updated Sales note');
    await form.getByRole('button',{name:'Save Sales confirmation',exact:true}).click();
    await expect(p.locator('[data-backorder-error]')).toContainText('Test stale revision');
    await expect(form).toBeVisible();await expect(form.locator('[name="customerNote"]')).toHaveValue('Updated Sales note');
    await form.getByRole('button',{name:'Save Sales confirmation',exact:true}).click();
    await expect(form).toBeHidden();await expect(second.locator('[data-action$="/decision"]')).toBeVisible();
    const saved=await f.detail(d);assert.equal(saved.lines[0].salesCustomerNote,'Updated Sales note');
    await ui.reload();await expect(form).toBeHidden();
  } finally {await ui.close();}
});

test('an unreviewed SCM form stays open and a changed review requests a fresh visible Sales confirmation',async()=>{
  let d=await f.create(1);const scm=await open('scm',d);
  try {await expect(scm.page.locator('.backorder-material-review')).toBeVisible();await expect(scm.page.getByRole('button',{name:'Edit material review',exact:true})).toHaveCount(0);}
  finally {await scm.close();}
  d=await f.review(d,0);d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  d=await f.action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'allocation',availabilityMode:'dated',availableDate:'2099-02-12',vendorId:331,vendorName:'TEST Vendor',vendorYard:'Changed yard'});
  const sales=await open('sales',d);
  try {await expect(sales.page.locator('[data-action$="/decision"]')).toBeVisible();await expect(sales.page.getByRole('button',{name:'Edit Sales confirmation',exact:true})).toHaveCount(0);}
  finally {await sales.close();}
});
