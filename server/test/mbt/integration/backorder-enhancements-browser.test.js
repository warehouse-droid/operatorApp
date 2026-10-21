import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';

const users={},out=process.env.BACKORDER_BROWSER_OUTPUT || 'test-artifacts/backorder-enhancements-20261007/browser',sku=88999501,other=88999502;
let browser,server,base;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');mkdirSync(out,{recursive:true});
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES($1,'TEST-ENHANCE-A','Enhanced A','EA','TEST Vendor Alpha',331),($2,'TEST-ENHANCE-B','Enhanced B','BAG','TEST Vendor Beta',332)",[sku,other]);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']){
    const username='enhance-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:role==='sales'?[1,28]:[]});
    const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);users[role]=(await r.json()).token;
  }
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await closeDb();});
async function pageFor(role,id){
  const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');localStorage.setItem('mbbs.scm.stockRequests.queue','request');},users[role]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/stock-requests/backorder/vendors?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"TEST directory outage"}'}));
  await page.goto(`${base}/${role}/stock-requests?tab=regular${id?'&requestId='+id:''}`);
  return {page,errors,async close(){writeFileSync(out+'/'+role+'-'+Date.now()+'.coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
async function api(role,path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+users[role],'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json();}

test('Backorder composer has conditional delivery, three-column inputs, paired notes and independent unpriced vendor/yard lines',async()=>{
  const f=await pageFor('sales');try{
    const p=f.page;await p.locator('[data-sales-stock-action="new"]').click();await p.locator('[data-regular-field="deliveryMethod"]').selectOption('backorder');
    assert.deepEqual(await p.locator('[data-regular-field="fulfillmentMethod"] option').evaluateAll(rows=>rows.map(r=>[r.value,r.textContent])),[['yard_pickup','Pickup'],['mbt_delivery','Delivery']]);
    await expect(p.locator('[data-regular-field="deliveryAddress"]')).toBeHidden();
    await expect(p.locator('[data-sales-stock-field="rate"],[data-sales-stock-field="discountPercent"]')).toHaveCount(0);
    await p.locator('[data-regular-field="fulfillmentMethod"]').selectOption('mbt_delivery');await expect(p.locator('[data-regular-field="deliveryAddress"]')).toBeVisible();
    for(const [name,value] of Object.entries({deliveryAddress:'123 TEST delivery',deliveryDate:'2099-02-10',windowStart:'09:00',windowEnd:'12:00',deliveryInstructions:'TEST use side entrance',salesInternalRemark:'TEST private note'}))await p.locator(`[data-regular-field="${name}"]`).fill(value);
    await p.locator('[data-sales-stock-remarks]').fill('TEST request remark');
    const notes=await p.locator('[data-regular-field="salesInternalRemark"],[data-sales-stock-remarks]').evaluateAll(rows=>rows.map(r=>({x:r.getBoundingClientRect().x,y:r.getBoundingClientRect().y,width:r.getBoundingClientRect().width})));
    assert.equal(notes[0].y,notes[1].y);assert.notEqual(notes[0].x,notes[1].x);assert.ok(Math.abs(notes[0].width-notes[1].width)<1);
    const dateRow=await p.locator('[data-regular-field="deliveryDate"],[data-regular-field="windowStart"],[data-regular-field="windowEnd"]').evaluateAll(rows=>rows.map(r=>r.getBoundingClientRect().y));assert.equal(new Set(dateRow).size,1);
    await p.locator('[data-regular-field="fulfillmentMethod"]').selectOption('yard_pickup');await expect(p.locator('[data-regular-field="deliveryAddress"]')).toBeHidden();await expect(p.locator('[data-regular-field="salesInternalRemark"]')).toHaveValue('TEST private note');
    await p.locator('[data-regular-field="fulfillmentMethod"]').selectOption('mbt_delivery');await expect(p.locator('[data-regular-field="deliveryAddress"]')).toHaveValue('123 TEST delivery');
    await p.locator('[data-sales-stock-field="itemSearch"]').fill('TEST-ENHANCE-A');await p.locator('[data-sales-stock-action="choose-item"]').click();
    await p.locator('[data-sales-stock-field="salesQty"]').fill('4');await p.locator('[data-sales-stock-field="vendorName"]').fill('TEST Vendor Alpha');await p.locator('[data-sales-stock-field="destinationLocationId"]').selectOption('1');
    await p.locator('[data-sales-stock-action="add-line"]').click();await p.locator('[data-sales-stock-field="itemSearch"]').nth(1).fill('TEST-ENHANCE-B');await p.locator('[data-sales-stock-action="choose-item"]').click();
    await p.locator('[data-sales-stock-field="salesQty"]').nth(1).fill('6');await p.locator('[data-sales-stock-field="vendorName"]').nth(1).fill('TEST Vendor Beta');await p.locator('[data-sales-stock-field="destinationLocationId"]').nth(1).selectOption('28');
    await p.screenshot({path:out+'/composer.png',fullPage:true});const creation=p.waitForResponse(r=>r.url().endsWith('/api/sales/stock-requests')&&r.request().method()==='POST');await p.locator('[data-sales-stock-form] button[type="submit"]').click();const created=await creation;assert.equal(created.status(),201);const id=(await created.json()).id;await expect(p.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(id));
    const d=await api('sales','/api/sales/stock-requests/'+id);
    assert.deepEqual(d.lines.map(l=>[l.vendorName,l.destinationLocationId,l.originalRate]),[['TEST Vendor Alpha',1,null],['TEST Vendor Beta',28,null]]);assert.equal(d.salesInternalRemark,'TEST private note');assert.equal(d.remarks,'TEST request remark');assert.equal(d.windowStart,'09:00');assert.equal(d.windowEnd,'12:00');assert.equal(d.deliveryInstructions,'TEST use side entrance');
    await expect(p.locator('[data-backorder-document="quote.pdf"]')).toHaveCount(0);
    await p.getByText('Edit request header',{exact:true}).click();const header=p.locator('[data-backorder-form][data-action="header"]');await header.locator('[name="remarks"]').fill('TEST changed remark');await header.locator('[name="fulfillmentMethod"]').selectOption('yard_pickup');await expect(header.locator('[name="deliveryAddress"]')).toBeHidden();await expect(header.locator('[name="remarks"]')).toHaveValue('TEST changed remark');await header.locator('[name="fulfillmentMethod"]').selectOption('mbt_delivery');await expect(header.locator('[name="deliveryAddress"]')).toHaveValue('123 TEST delivery');
    await p.getByText('Edit request material',{exact:true}).first().click();const edit=p.locator('[data-backorder-form][data-action$="/edit"]').first();await expect(edit.locator('[name="rate"],[name="discountPercent"]')).toHaveCount(0);await edit.locator('[name="vendorName"]').fill('TEST Updated vendor');await edit.locator('[name="destinationLocationId"]').selectOption('28');await edit.locator('button').click();await expect(p.locator('[data-backorder-line]').first()).toContainText('TEST Updated vendor');
    await p.reload();await expect(p.locator('[data-backorder-line]').first()).toContainText('TEST Updated vendor');const updated=await api('sales','/api/sales/stock-requests/'+id);assert.deepEqual(updated.lines.map(l=>l.destinationLocationId),[28,28]);assert.equal(updated.lines[1].vendorName,'TEST Vendor Beta');
    await p.setViewportSize({width:480,height:900});await p.getByText('Edit request header',{exact:true}).click();assert.ok(await header.evaluate(el=>el.getBoundingClientRect().right<=document.documentElement.clientWidth));await p.screenshot({path:out+'/mobile.png',fullPage:true});assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
test('SCM shows the vendor and receiving yard for each line even when the vendor directory is unavailable',async()=>{
  await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,quantity_on_order,synced_at)
    VALUES($1,1,'3445',125.5,87.25,33.5,now()),($1,28,'2967',999,998,997,now()),($2,28,'2967',0,0,0,now())
    ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_on_hand=EXCLUDED.quantity_on_hand,
      quantity_available=EXCLUDED.quantity_available,quantity_on_order=EXCLUDED.quantity_on_order,synced_at=EXCLUDED.synced_at`,[sku,other]);
  const d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2,destinationLocationId:1},{itemId:other,salesQty:3,destinationLocationId:28}]});
  assert.deepEqual(d.lines.map(line=>[line.stockEvidence.onHand,line.stockEvidence.available,line.stockEvidence.onOrder]),[[125.5,87.25,33.5],[0,0,0]]);
  const f=await pageFor('scm',d.id);try{
    const p=f.page;await expect(p.locator('[data-backorder-line]')).toHaveCount(2);
    for(const [index,vendor] of ['331','332'].entries()){const line=p.locator('[data-backorder-line]').nth(index);await expect(line.locator('[name="vendorId"]')).toHaveValue(vendor);await expect(line).toContainText(index?'TEST Vendor Beta':'TEST Vendor Alpha');await expect(line).toContainText(index?'2967':'3445');}
    await expect(p.locator('[data-backorder-line]').first().locator('.backorder-material-stock')).toContainText('125.5 EA');
    await expect(p.locator('[data-backorder-line]').first().locator('.backorder-material-stock')).toContainText('87.25 EA');
    await expect(p.locator('[data-backorder-line]').first().locator('.backorder-material-stock')).toContainText('33.5 EA');
    for(const form of await p.locator('[data-action$="/response"]').all()){
      await expect(form.locator('[name="availabilityMode"]')).toBeHidden();await expect(form.locator('[name="availableDate"]')).toBeHidden();
      await expect(form.locator('[name="vendorReference"]')).toHaveCount(0);
      const rows=await form.locator('[name="supplyStatus"],[name="vendorId"],[name="vendorYard"],[name="salesVisibleNote"],[name="scmInternalNote"]').evaluateAll(fields=>fields.map(field=>Math.round(field.getBoundingClientRect().top)));
      assert.equal(new Set(rows).size,2,'In-stock material review fits two rows on desktop');
    }
    const review=p.locator('[data-action$="/response"]').first();
    await review.locator('[name="vendorYard"]').fill('TEST dock');
    await review.locator('[name="supplyStatus"]').selectOption('production');
    await expect(review.locator('[name="availabilityMode"]')).toBeVisible();await expect(review.locator('[name="availableDate"]')).toBeVisible();
    await review.locator('[name="availabilityMode"]').selectOption('dated');await review.locator('[name="availableDate"]').fill('2099-02-10');
    await review.locator('button').click();await expect(p.locator('[data-backorder-line]').first()).toContainText('ETA 2099-02-10');
    await review.locator('[name="supplyStatus"]').selectOption('in_stock');
    await expect(review.locator('[name="availabilityMode"]')).toBeHidden();await expect(review.locator('[name="availableDate"]')).toBeHidden();
    for(let i=0;i<2;i++){
      const form=p.locator('[data-backorder-form][data-action$="/response"]').nth(i);
      await form.locator('[name="vendorYard"]').fill('TEST dock');
      const response=p.waitForResponse(r=>r.url().endsWith(`/lines/${d.lines[i].id}/response`) && r.request().method()==='POST');
      await form.locator('button').click();const result=await response;assert.equal(result.status(),200);
      await expect(form).toHaveAttribute('data-revision',String((await result.json()).revision));
      await expect(p.locator('[data-backorder-line]').nth(i).locator('.backorder-material-summary')).toContainText('In stock');
    }
    const saved=await api('scm','/api/scm/stock-requests/'+d.id);assert.deepEqual(saved.lines.map(l=>[l.vendorId,l.destinationLocationId]),[[331,1],[332,28]]);await p.screenshot({path:out+'/scm-lines.png',fullPage:true});assert.deepEqual(f.errors,[]);
    assert.deepEqual(saved.lines.map(line=>[line.availabilityMode,line.availableDate]),[['no_projection',null],['no_projection',null]]);
    await p.reload();await expect(p.locator('[data-backorder-line] [name="availableDate"]').first()).toBeHidden();
    await p.setViewportSize({width:480,height:900});
    assert.ok(await p.locator('[data-backorder-line]').first().evaluate(el=>el.getBoundingClientRect().right<=document.documentElement.clientWidth));
    await p.screenshot({path:out+'/scm-lines-mobile.png',fullPage:true});
  }finally{await f.close();}
});
