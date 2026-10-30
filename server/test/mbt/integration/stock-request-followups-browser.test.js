import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
let f,browser;
before(async()=>{f=await fixture({sku:985712});browser=await chromium.launch({args:['--no-sandbox']});});
after(async()=>{await browser?.close();await f?.close();});
async function open(t,role,r){
 const context=await browser.newContext({timezoneId:'Asia/Tokyo',serviceWorkers:'block'});t.after(()=>context.close());
 await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);window.MBBSOSNotifications={allowsRole:()=>false,notify:async()=>false};},f.users[role].token);
 const page=await context.newPage();page.setDefaultTimeout(6000);
 await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${r.id}`);
 await expect(page.locator('[data-backorder-detail]')).toBeVisible();return page;
}
test('Backorder history displays Toronto winter and summer times on a Tokyo device',async t=>{
 let r=await f.create(1);r=await f.review(r,0);
 await f.query("UPDATE sales_special_stock_events SET created_at='2026-01-15T18:30:00Z' WHERE request_id=$1",[r.id]);
 const page=await open(t,'scm',r),history=page.locator('section').filter({has:page.getByRole('heading',{name:'History',exact:true})}).last();
 await expect(history).toContainText('01:30 PM');assert.equal((await history.innerText()).includes('2026-01-15T18:30'),false);
 await f.query("UPDATE sales_special_stock_events SET created_at='2026-07-15T18:30:00Z' WHERE request_id=$1",[r.id]);
 await page.reload();await expect(history).toContainText('02:30 PM');
});
test('SO and SCM-only PO previews sit inside their spans and use an in-app dialog',async t=>{
 const r=await f.create(1);
 await f.query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=985712,sales_order_ref='SO-PREVIEW',sales_order_source='manual_link',purchase_order_netsuite_id=985713,purchase_order_ref='PO-PREVIEW',purchase_order_custom_linkage=true WHERE request_id=$1",[r.id]);
 for(const role of ['sales','scm']){
  const page=await open(t,role,r);let popups=0;page.on('popup',()=>popups++);
  await page.route('**/backorder/*-order/document.pdf',route=>route.fulfill({status:200,contentType:'application/pdf',body:Buffer.from('%PDF-1.4\n%%EOF')}));
  await expect(page.locator('.stock-request-summary > span').filter({has:page.getByRole('button',{name:'Preview SO',exact:true})})).toContainText('SO-PREVIEW');
  await expect(page.getByRole('button',{name:'Preview PO',exact:true})).toHaveCount(role==='scm'?1:0);
  if(role==='scm')await expect(page.locator('[name="supplyStatus"] option[value="yard_stock"]')).toHaveCount(0);
  for(const name of role==='scm'?['Preview SO','Preview PO']:['Preview SO']){
   await page.getByRole('button',{name,exact:true}).click();
   const dialog=page.locator('dialog.special-document-dialog');await expect(dialog).toBeVisible();await expect(dialog.locator('iframe')).toHaveAttribute('src',/^blob:/);
   await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toHaveCount(0);
  }
  assert.equal(popups,0);
 }
});
test('SCM completes destination-yard stock from Supply status without vendor inputs and Sales sees the result',async t=>{
 const r=await f.create(2),page=await open(t,'scm',r),line=page.locator(`[data-backorder-line="${r.lines[0].id}"]`);
 const review=line.locator('[data-action$="/response"]'),status=review.locator('[name="supplyStatus"]');
 await expect(line.getByRole('button',{name:'Stock available at destination yard',exact:true})).toHaveCount(0);
 await expect(line.locator('[data-action$="/yard-stock"]')).toHaveCount(0);
 await expect(line).not.toContainText('SCM confirms this yard has enough stock.');
 await status.selectOption('yard_stock');
 for(const name of ['vendorId','vendorYard','availableDate','poNumber']){
  await expect(review.locator(`[name="${name}"]`)).toBeHidden();
  await expect(review.locator(`[name="${name}"]`)).toBeDisabled();
 }
 assert.equal(await review.evaluate(form=>form.checkValidity()),true);
 assert.ok(!(await f.detail(r)).lines[0].yardStock,'Selecting a status does not complete the material before saving');
 await status.selectOption('in_stock');
 for(const name of ['vendorId','vendorYard']){
  await expect(review.locator(`[name="${name}"]`)).toBeVisible();
  await expect(review.locator(`[name="${name}"]`)).toBeEnabled();
 }
 await status.selectOption('already_ordered');await expect(review.getByLabel('PO number (required)',{exact:true})).toBeVisible();
 await status.selectOption('yard_stock');await expect(review.getByLabel('PO number (required)',{exact:true})).toBeHidden();
 await page.setViewportSize({width:480,height:900});
 await expect.poll(()=>review.evaluate(form=>form.getBoundingClientRect().right-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
 const response=page.waitForResponse(res=>res.url().endsWith(`/lines/${r.lines[0].id}/yard-stock`)&&res.request().method()==='POST');
 await review.getByRole('button',{name:'Save material review',exact:true}).click();
 const saved=await response;assert.equal(saved.status(),200);assert.deepEqual(saved.request().postDataJSON(),{expectedRevision:r.revision});
 await expect(line).toContainText('Stock available at destination yard · Completed');
 await expect(line.getByRole('button',{name:'Save material review',exact:true})).toHaveCount(0);
 await expect(page.locator(`[data-backorder-line="${r.lines[1].id}"]`).getByRole('button',{name:'Save material review',exact:true})).toBeVisible();
 const sales=await open(t,'sales',r);await expect(sales.locator(`[data-backorder-line="${r.lines[0].id}"]`)).toContainText('Stock available at destination yard · Completed');
 await expect(sales.getByRole('button',{name:'Stock available at destination yard',exact:true})).toHaveCount(0);
});

test('Refresh stock evidence reloads Backorder destination quantities without changing its review',async t=>{
 const r=await f.create(1);
 await f.query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,quantity_on_order,synced_at)
  VALUES(985712,1,'3445',12,8,4,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET
  quantity_on_hand=12,quantity_available=8,quantity_on_order=4,synced_at=now()`);
 const page=await open(t,'scm',r),stock=page.locator(`[data-backorder-line="${r.lines[0].id}"] .backorder-material-stock`);
 await expect(stock.locator('strong')).toHaveText(['12 EA','8 EA','4 EA']);
 await f.query('UPDATE inventory_balances SET quantity_on_hand=25,quantity_available=19,quantity_on_order=6,synced_at=now() WHERE item_id=985712 AND location_id=1');
 const response=page.waitForResponse(res=>res.url().endsWith(`/stock-requests/${r.id}/evidence`)&&res.request().method()==='POST');
 await page.getByRole('button',{name:'Refresh stock evidence',exact:true}).click();
 const saved=await response;assert.equal(saved.status(),200);assert.equal((await saved.json()).revision,r.revision);
 await expect(stock.locator('strong')).toHaveText(['25 EA','19 EA','6 EA']);
 await expect(page.getByRole('button',{name:'Refresh stock evidence',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Save material review',exact:true})).toBeVisible();
 const sales=await open(t,'sales',r);
 await expect(sales.getByRole('button',{name:'Refresh stock evidence',exact:true})).toHaveCount(0);
});

test('unknown pallet conversion shows order quantity and sends the pallets manually entered by SCM',async t=>{
 const r=await f.create(1),repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)});
 const product=await repo.upsertScrapedProduct(1,{sku:'MANUAL-PALLET-UI',name:'Urban Slab',colour:'BUFF',size:'18 x 36',pickupLocation:'Ayr',url:'https://ontario.order.unilock.com/products/products/urban?child=MANUAL-PALLET-UI'});
 await repo.saveAccount(1,{label:'Fixture',username:'fixture',password:'fixture'},f.users.scm.id);
 await f.query("UPDATE sales_special_stock_lines SET requested_quantity=1046.2,scm_reviewed_quantity=1046.2,requested_uom='SQFT',pack_pallet_qty=NULL,brand='Unilock',response_vendor_name='Unilock',detail_spec='MANUAL-PALLET-UI' WHERE request_id=$1",[r.id]);
 const page=await open(t,'scm',r);
 await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
 const dialog=page.locator('dialog.stock-live-dialog');await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('Expected order quantity: 1046.2 SQFT');
 await expect(dialog.locator('select')).toHaveValue(String(product.id));
 const quantity=dialog.locator('[data-live-quantity]');await expect(quantity).toHaveValue('');
 await dialog.getByRole('button',{name:'Check selected lines',exact:true}).click();
 await expect(dialog.locator('[data-live-dialog-error]')).toContainText('whole pallet quantity');
 await quantity.fill('20');
 const response=page.waitForResponse(res=>res.url().endsWith(`/stock-check/requests/${r.id}`)&&res.request().method()==='POST');
 await dialog.getByRole('button',{name:'Check selected lines',exact:true}).click();
 const saved=await response;assert.equal(saved.status(),202);const data=await saved.json();
 assert.equal(data.lines[0].job.payload.quantity,20);assert.equal(data.lines[0].job.payload.requestLine.quantitySource,'manual');
 await expect(page.locator(`[data-live-stock-line="${r.lines[0].id}"]`)).toContainText('Queued');
 await expect(page.locator(`[data-live-stock-line="${r.lines[0].id}"] a`)).toHaveAttribute('title',/20 PLT requested/);
});

test('preview errors stay inside the app and can be closed without opening a new window',async t=>{
 const r=await f.create(1);
 await f.query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=985714,sales_order_ref='SO-PREVIEW-ERROR',sales_order_source='manual_link' WHERE request_id=$1",[r.id]);
 const page=await open(t,'sales',r);let popups=0;page.on('popup',()=>popups++);
 for(const [status,contentType,message] of [[503,'application/json','Document preview is unavailable'],[200,'text/html','did not return a PDF']]){
  await page.route('**/backorder/sales-order/document.pdf',route=>route.fulfill({status,contentType,body:'Unavailable'}));
  await page.getByRole('button',{name:'Preview SO',exact:true}).click();
  const dialog=page.locator('dialog.special-document-dialog');await expect(dialog.locator('[role="alert"]')).toContainText(message);await expect(dialog.locator('iframe')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.unroute('**/backorder/sales-order/document.pdf');
 }
 assert.equal(popups,0);
});
