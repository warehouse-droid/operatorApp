import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';

const out='test-artifacts/stocking-backorder-conversion-20261007/browser',users={},sku=88999821;
let browser,server,base;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');mkdirSync(out,{recursive:true});
  await query("INSERT INTO inventory_items(item_id,item_name,item_description,stock_unit,vendor,vendor_id,to_pcs,to_plt) VALUES($1,'BROWSER-STOCK-CONVERT','Material <script>literal</script>','EA','Browser vendor',331,1,100)",[sku]);
  for(const yard of [1,28])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now())",[sku,yard,String(yard)]);
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
  for(const role of ['sales','scm']){const username='convert-browser-'+role+'-'+randomUUID(),password=randomUUID();await createOperator({username,password,displayName:role,role,roles:[role],yardLocationIds:role==='sales'?[26]:[]});const r=await api(null,'/api/auth/login',{username,password});users[role]=r.token;}
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await closeDb();});
async function api(role,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(role?{authorization:'Bearer '+users[role]}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();}
const create=type=>api('sales','/api/sales/stock-requests',{workflowVersion:2,deliveryMethod:'stocking',stockingType:type,destinationLocationId:28,remarks:'Keep remark <b>text</b>',customerName:'Keep customer',lines:[{itemId:sku,...(type==='transfer'?{sourceLocationId:1}:{}),pieces:31},{itemId:sku,...(type==='transfer'?{sourceLocationId:1}:{}),pieces:19}]});
async function pageFor(role,d){const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.scm.stockRequests.queue','request');},users[role]);const page=await context.newPage(),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/backorder-conversion'))calls.push(r.postDataJSON());});page.setDefaultTimeout(10000);await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(`${base}/${role}/stock-requests?tab=regular&requestId=${d.id}`);await expect(page.locator('.stock-request-detail')).toContainText(d.requestRef);return {page,errors,calls,async close(){writeFileSync(out+'/'+role+'-'+d.id+'.coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};}

test('SCM converts the whole Transfer or Purchase through a confirmation dialog and opens the same Backorder',async()=>{
  for(const type of ['transfer','purchase']){const d=await create(type),f=await pageFor('scm',d);try{
    const p=f.page;await p.locator('[data-scm-stock-action="backorder-convert"]').click();const dialog=p.locator('[data-stocking-backorder-dialog]');await expect(dialog).toBeVisible();await expect(dialog).toContainText(d.requestRef);await expect(dialog).toContainText('31 EA');await expect(dialog).toContainText('19 EA');await expect(dialog.locator('script')).toHaveCount(0);
    await dialog.locator('[data-stocking-backorder-cancel]').click();await expect(dialog).toHaveCount(0);assert.equal(f.calls.length,0);
    await p.locator('[data-scm-stock-action="backorder-convert"]').click();await dialog.locator('[name="fulfillmentMethod"]').selectOption('mbt_delivery');await expect(dialog.locator('[name="deliveryAddress"]')).toBeVisible();await dialog.locator('[name="deliveryAddress"]').fill('200 Conversion Road');await dialog.locator('[name="deliveryDate"]').fill('2099-10-08');await dialog.locator('[name="windowStart"]').fill('08:00');await dialog.locator('[name="windowEnd"]').fill('12:00');await dialog.locator('[name="deliveryInstructions"]').fill('Call first');await dialog.locator('[name="requiredDate"]').fill('2099-10-08');
    await dialog.locator('[data-stocking-backorder-confirm]').click();await expect(p.locator('[data-backorder-detail]')).toContainText(d.requestRef);await expect(p.locator('[data-backorder-detail]')).toContainText('Backorder');await expect(p.locator('[data-backorder-detail]')).toContainText('200 Conversion Road');await expect(p.locator('[data-backorder-detail]')).toContainText('Keep remark <b>text</b>');assert.equal(f.calls.length,1);assert.deepEqual(f.errors,[]);
    const saved=await api('sales','/api/sales/stock-requests/'+d.id);assert.equal(saved.workflowKind,'backorder');assert.equal(saved.lines.length,2);await p.screenshot({path:out+'/'+type+'-converted.png',fullPage:true});
  }finally{await f.close();}}
});
test('conversion retains form values on revision conflicts, prevents duplicate posts, and Sales has no action',async()=>{
  const d=await create('purchase'),f=await pageFor('scm',d);try{
    const p=f.page;await p.locator('[data-scm-stock-action="backorder-convert"]').click();const dialog=p.locator('[data-stocking-backorder-dialog]');await expect(dialog).toBeVisible();await dialog.locator('[data-stocking-backorder-vendor]').first().fill('Confirmed vendor');
    await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1',[d.id]);await dialog.locator('[data-stocking-backorder-confirm]').click();await expect(dialog.locator('[data-stocking-backorder-error]')).toContainText('changed');await expect(dialog.locator('[data-stocking-backorder-vendor]').first()).toHaveValue('Confirmed vendor');await expect(dialog.locator('[data-stocking-backorder-confirm]')).toBeEnabled();await dialog.locator('[data-stocking-backorder-cancel]').click();assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
  const sales=await pageFor('sales',d);try{await expect(sales.page.locator('[data-scm-stock-action="backorder-convert"]')).toHaveCount(0);assert.deepEqual(sales.errors,[]);}finally{await sales.close();}
});
test('Sales sees the original receiving yard when editing a converted material instead of silently choosing the inquiry yard',async()=>{
  const source=await create('purchase');const d=await api('scm',`/api/scm/stock-requests/${source.id}/backorder-conversion`,{expectedRevision:source.revision,fulfillmentMethod:'yard_pickup'});
  const f=await pageFor('sales',d);try{
    const card=f.page.locator(`[data-backorder-line="${d.lines[0].id}"]`);await card.locator('summary').click();await expect(card.locator('[name="destinationLocationId"]')).toHaveValue('28');
    await card.locator('[name="quantity"]').fill('32');await card.locator('[data-action$="/edit"] button[type="submit"]').click();await expect(card).toContainText('32 EA');await expect(card).toContainText('Destination yard: 2967');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
test('a pending conversion disables controls and ignores duplicate submits or Escape until its real response arrives',async()=>{
  const d=await create('purchase'),f=await pageFor('scm',d);
  let release;const gate=new Promise(done=>release=done);let held;const responseHeld=new Promise(done=>held=done);
  try{
    const p=f.page;await p.route(`**/api/scm/stock-requests/${d.id}/backorder-conversion`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const response=await route.fetch();held();await gate;await route.fulfill({response});
    });
    await p.locator('[data-scm-stock-action="backorder-convert"]').click();const dialog=p.locator('[data-stocking-backorder-dialog]');await expect(dialog.locator('[data-stocking-backorder-confirm]')).toBeEnabled();
    await dialog.locator('[data-stocking-backorder-confirm]').click();await responseHeld;
    await expect(dialog.locator('[data-stocking-backorder-confirm]')).toBeDisabled();await expect(dialog.locator('[data-stocking-backorder-cancel]')).toBeDisabled();await expect(dialog.locator('[data-stocking-backorder-vendor]').first()).toBeDisabled();
    await dialog.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await p.keyboard.press('Escape');await expect(dialog).toBeVisible();
    release();await expect(p.locator('[data-backorder-detail]')).toContainText(d.requestRef);await expect(dialog).toHaveCount(0);assert.equal(f.calls.length,1);assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});
test('a failed or cancelled preview cannot create a request or reopen its dismissed conversion dialog',async()=>{
  const d=await create('transfer'),f=await pageFor('scm',d);
  let release;const gate=new Promise(done=>release=done);let held;const responseHeld=new Promise(done=>held=done);
  try{
    const p=f.page,path=`**/api/scm/stock-requests/${d.id}/backorder-conversion`,dialog=p.locator('[data-stocking-backorder-dialog]');
    await p.route(path,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Preview temporarily unavailable'})}));
    await p.locator('[data-scm-stock-action="backorder-convert"]').click();await expect(dialog.locator('[data-stocking-backorder-error]')).toContainText('Preview temporarily unavailable');await expect(dialog.locator('[data-stocking-backorder-confirm]')).toHaveCount(0);await dialog.locator('[data-stocking-backorder-cancel]').click();
    await p.unroute(path);await p.route(path,async route=>{const response=await route.fetch();held();await gate;await route.fulfill({response});});
    await p.locator('[data-scm-stock-action="backorder-convert"]').click();await responseHeld;await expect(dialog).toContainText('Loading request materials');await p.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    const completed=p.waitForResponse(response=>response.url().endsWith('/backorder-conversion'));release();await completed;await expect(dialog).toHaveCount(0);assert.equal(f.calls.length,0);assert.equal((await api('sales','/api/sales/stock-requests/'+d.id)).regular.deliveryMethod,'stocking');assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});
