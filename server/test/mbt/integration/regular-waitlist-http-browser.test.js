/* global localStorage,window */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {getWaitlistRequest,finishWaitlistConversion,getWaitlistPool,submitWaitlistRequest} from '../../../src/regular-waitlist-repository.js';
let f,server,base,browser;const users={},out='test-artifacts/regular-waitlist/browser',times=[];
before(async()=>{
  f=await createWaitlistFixture();await mkdir(out,{recursive:true});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [role,yards] of [['sales',[1]],['scm',[]],['operator',[1]]]){
    const username='waitlist-ui-'+role+'-'+randomUUID(),password=randomUUID();const actor=await createOperator({username,displayName:username,password,role,roles:[role],yardLocationIds:yards});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);
    users[role]={id:actor.id,token:(await response.json()).token};
  }
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
async function api(role,path,body){const start=performance.now();const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+users[role].token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();return {status:response.status,data,ms:performance.now()-start};}
async function pageFor(role,path,width=1440){const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),users[role].token);const page=await context.newPage();page.setDefaultTimeout(8000);await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(base+path);return {page,close:async label=>{await writeFile(`${out}/${label}-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};}
test('real local submission completes below one second, is idempotent, and enforces Sales and SCM boundaries',async()=>{
  const s=await f.supply(),body={deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:1000}],operationKey:randomUUID()};
  const first=await api('sales','/api/sales/stock-requests',body);assert.equal(first.status,201);assert(first.ms<1000);times.push(first.ms);
  const repeated=await api('sales','/api/sales/stock-requests',body);assert.equal(repeated.data.id,first.data.id);
  assert.equal((await api('sales','/api/sales/stock-requests',{...body,operationKey:randomUUID(),destinationLocationId:28})).status,403);
  assert.equal((await api('operator','/api/sales/stock-requests',body)).status,403);
  assert.equal((await api('sales','/api/scm/waitlist/pools',{purchaseOrderRef:s.poRef,itemId:s.itemId,operationKey:randomUUID()})).status,403);
  assert.equal((await api('scm',`/api/scm/stock-requests/${first.data.id}/line-decisions`,{expectedRevision:first.data.revision,decision:'reject',lineIds:[first.data.lines[0].id]})).data.code,'WAITLIST_WORKFLOW_ONLY');
  await writeFile(out+'/latency.json',JSON.stringify(times));
});
test('Sales Waitlist form requires an existing customer and one item, with no availability refresh',async()=>{
  const s=await f.supply(),{page,close}=await pageFor('sales','/sales/stock-requests?tab=regular',390),refreshes=[];
  page.on('request',request=>{if(request.url().includes('/availability/refresh'))refreshes.push(request.url());});
  try{
    await page.locator('[data-sales-stock-action="new"]').click();await page.locator('[data-regular-field=deliveryMethod]').selectOption('waitlist');
    await expect(page.getByText('Type *',{exact:true})).toBeVisible();await expect(page.locator('[data-sales-stock-action=add-line]')).toHaveCount(0);
    await page.locator('[data-waitlist-customer-query]').fill('TEST Waitlist');await page.locator('[data-waitlist-customer]').first().click();
    await page.locator('[data-sales-stock-field=itemSearch]').fill('UNI-EXTRA-2');await page.locator(`[data-sales-stock-action=choose-item][data-item-id="${s.itemId}"]`).click();
    await expect(page.locator('[data-sales-stock-field=sourceLocationId]')).toHaveCount(0);await expect(page.locator('[data-sales-stock-field=pallets]')).toHaveCount(0);
    await page.locator('[data-sales-stock-field=salesQty]').fill('700');await page.locator('[data-sales-stock-form]').screenshot({path:out+'/sales-waitlist-phone.png'});
    await page.locator('[data-sales-stock-form] button[type=submit]').click();await expect(page.locator('[data-waitlist-close-form]')).toBeVisible();
    assert.equal(refreshes.length,0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  }finally{await close('sales-form');}
});
test('SCM selects PO demand, confirms partial allocation, and Sales converts only that quantity',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:1000}],operationKey:randomUUID()});
  const {page,close}=await pageFor('scm',`/scm/stock-requests?tab=waitlist&poolId=${s.pool.id}`);
  try{
    await expect(page.getByRole('heading',{name:'Regular waitlist'})).toBeVisible();await expect(page.getByRole('heading',{name:s.poRef+' · UNI-EXTRA-3'})).toBeVisible();
    await page.locator(`[data-waitlist-select="${created.data.id}"]`).check();await page.locator(`[data-waitlist-quantity="${created.data.id}"]`).fill('600');
    await page.locator('[data-waitlist-allocation-form]').screenshot({path:out+'/scm-allocation-desktop.png'});await page.getByRole('button',{name:'Confirm allocation',exact:true}).click();
    await expect(page.locator('[data-waitlist-allocation-form] [data-waitlist-selected-total]')).toHaveText('0');assert.equal((await getWaitlistRequest(created.data.id)).waitlist.heldQty,600);
  }finally{await close('scm-allocation');}
  const sales=await pageFor('sales',`/sales/stock-requests?tab=regular&requestId=${created.data.id}`);
  try{
    await expect(sales.page.locator('[data-waitlist-conversion-form]')).toBeVisible();await expect(sales.page.getByText('NetSuite applies the customer’s item price automatically.',{exact:false})).toBeVisible();
    await sales.page.getByRole('button',{name:'Convert to Sales Order',exact:true}).click();await expect(sales.page.getByText('Creating the Sales Order…',{exact:true})).toBeVisible();
    const operation=(await query('SELECT * FROM regular_waitlist_conversions WHERE request_id=$1',[created.data.id])).rows[0];assert.equal(Number(operation.quantity),600);
    await finishWaitlistConversion(operation.id,{salesOrderId:995101,salesOrderRef:'SO-BROWSER-CONVERT'});
    await sales.page.reload();await expect(sales.page.getByText('SO-BROWSER-CONVERT',{exact:true})).toBeVisible();
    const request=await getWaitlistRequest(created.data.id);assert.equal(request.waitlist.waitingQty,400);assert.equal((await getWaitlistPool(s.pool.id)).availableQty,4400);
  }finally{await sales.close('sales-convert');}
});
test('SCM finds an existing PO, opens its item pool, releases a mature hold and acknowledges returned stock',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:1000}],operationKey:randomUUID()});
  const view=await pageFor('scm','/scm/stock-requests?tab=waitlist',390);
  try{
    await view.page.locator('[data-waitlist-po-search]').fill(s.poRef);await expect(view.page.locator('[data-waitlist-po] option')).toHaveCount(2);
    await view.page.locator('[data-waitlist-po]').selectOption(String(s.poId));await view.page.locator('[name=itemId]').selectOption(String(s.itemId));
    await view.page.getByRole('button',{name:'Open pool',exact:true}).click();await expect(view.page.locator(`[data-waitlist-select="${created.data.id}"]`)).toBeVisible();
    await view.page.locator(`[data-waitlist-select="${created.data.id}"]`).check();await view.page.locator(`[data-waitlist-quantity="${created.data.id}"]`).fill('600');await view.page.getByRole('button',{name:'Confirm allocation',exact:true}).click();
    await expect(view.page.locator('[data-waitlist-selected-total]')).toHaveText('0');
    await view.page.getByRole('button',{name:/All waiting requests/}).click();await expect(view.page.locator('.waitlist-table')).toContainText(created.data.requestRef);await view.page.getByRole('button',{name:'PO pools',exact:true}).click();
    const pool=await getWaitlistPool(s.pool.id),allocation=pool.allocations[0];await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '31 minutes' WHERE id=$1",[allocation.id]);
    await view.page.getByRole('button',{name:'Refresh',exact:true}).click();const form=view.page.locator(`[data-waitlist-release-form="${allocation.id}"]`);await expect(form).toBeVisible();
    await form.locator('[name=reason]').fill('Customer unavailable');await form.getByRole('button').click();await expect(view.page.locator('.waitlist-returned')).toContainText(s.poRef);
    await view.page.locator(`.waitlist-returned [data-waitlist-pool="${s.pool.id}"]`).click();await expect(view.page.locator('.waitlist-returned')).toHaveCount(0);
    assert.equal((await api('scm','/api/scm/stock-requests/alerts')).data.returnedPools.some(p=>p.id===s.pool.id),false);
    await view.page.locator('[data-stock-request-tab=waitlist]').focus();await view.page.keyboard.press('ArrowRight');await view.page.keyboard.press('ArrowLeft');await expect(view.page.getByRole('heading',{name:'Regular waitlist'})).toBeVisible();
    await view.page.screenshot({path:out+'/scm-returned-phone.png',fullPage:true});
    assert(await view.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),JSON.stringify(await view.page.evaluate(()=>({scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>window.innerWidth).map(e=>({tag:e.tagName,classes:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,parent:e.parentElement.className,parentWidth:e.parentElement.getBoundingClientRect().width,parentOverflow:getComputedStyle(e.parentElement).overflowX})).slice(0,15)}))));
  }finally{await view.close('scm-returned-phone');}
});
test('Sales Close releases fresh allocations and the SCM notice deep-links the same PO pool',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:600}],operationKey:randomUUID()});
  await api('scm',`/api/scm/waitlist/pools/${s.pool.id}/allocations`,{operationKey:randomUUID(),expectedRevision:s.pool.revision,selections:[{requestId:created.data.id,expectedRevision:created.data.revision,quantity:600}]});
  const view=await pageFor('sales',`/sales/stock-requests?tab=regular&requestId=${created.data.id}`);
  try{await view.page.locator('[data-waitlist-close-form] [name=reason]').fill('Customer cancelled today');await view.page.getByRole('button',{name:'Close waitlist request',exact:true}).click();
    await expect(view.page.getByText('Closed: Customer cancelled today',{exact:true})).toBeVisible();assert.equal((await getWaitlistPool(s.pool.id)).availableQty,5000);
    assert((await api('scm','/api/scm/stock-requests/alerts')).data.returnedPools.some(p=>p.id===s.pool.id));
  }finally{await view.close('sales-close');}
});
test('Delivery conversion persists fulfillment details and closing the remainder retains SO quantity',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:1000}],operationKey:randomUUID()});
  await api('scm',`/api/scm/waitlist/pools/${s.pool.id}/allocations`,{operationKey:randomUUID(),expectedRevision:s.pool.revision,selections:[{requestId:created.data.id,expectedRevision:created.data.revision,quantity:500}]});
  const view=await pageFor('sales',`/sales/stock-requests?tab=regular&requestId=${created.data.id}`);
  try{
    const form=view.page.locator('[data-waitlist-conversion-form]');await form.locator('[name=fulfillmentMethod]').selectOption('delivery');
    await expect(form.locator('[name=deliveryAddress],[name=deliveryInstructions],[name=deliveryContactName],[name=deliveryContactPhone],[name=windowStart],[name=windowEnd]')).toHaveCount(0);
    await form.locator('[name=deliveryDate]').fill('2026-10-10');await form.locator('[name=remainderAction]').selectOption('close');
    await form.getByRole('button',{name:'Convert to Sales Order',exact:true}).click();await expect(view.page.getByText('Creating the Sales Order…',{exact:true})).toBeVisible();
    const operation=(await query('SELECT * FROM regular_waitlist_conversions WHERE request_id=$1',[created.data.id])).rows[0];assert.deepEqual(operation.fulfillment,{fulfillmentMethod:'delivery',deliveryDate:'2026-10-10'});
    const read=await api('sales',`/api/sales/stock-requests/${created.data.id}/waitlist/conversions/${operation.id}`);assert.equal(read.status,200);assert.equal(read.data.quantity,500);
    await finishWaitlistConversion(operation.id,{salesOrderId:995120,salesOrderRef:'SO-DELIVERY-BROWSER'});await finishWaitlistConversion(operation.id,{salesOrderId:995120,salesOrderRef:'SO-CHANGED-LATER'});
    await assert.rejects(()=>finishWaitlistConversion(operation.id,{salesOrderId:995121,salesOrderRef:'OTHER-SO'}),error=>error.code==='WAITLIST_CONVERSION_CONFLICT');
    const saved=await getWaitlistRequest(created.data.id);assert.equal(saved.waitlist.closedQty,500);assert.equal(saved.waitlist.conversions[0].salesOrderRef,'SO-DELIVERY-BROWSER');assert.equal((await getWaitlistPool(s.pool.id)).availableQty,4500);
  }finally{await view.close('sales-delivery');}
});
test('legacy Sales actions enforce selling-yard access before revealing a waitlist workflow',async()=>{
  const s=await f.supply(),other=await s.demand(1000,28);
  for(const path of ['cancel','resubmit'])assert.equal((await api('sales',`/api/sales/stock-requests/${other.id}/${path}`,{expectedRevision:other.revision})).status,403);
});
test('an invalid delivery date shows the error, preserves the draft and creates no conversion',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:600}],operationKey:randomUUID()});
  await api('scm',`/api/scm/waitlist/pools/${s.pool.id}/allocations`,{operationKey:randomUUID(),expectedRevision:s.pool.revision,selections:[{requestId:created.data.id,expectedRevision:created.data.revision,quantity:600}]});
  const view=await pageFor('sales',`/sales/stock-requests?tab=regular&requestId=${created.data.id}`);
  try{
    const form=view.page.locator('[data-waitlist-conversion-form]');await form.locator('[name=fulfillmentMethod]').selectOption('delivery');
    await form.locator('[name=deliveryDate]').fill('2026-10-10');
    await view.page.route('**/waitlist/conversions',route=>route.continue({postData:JSON.stringify({...route.request().postDataJSON(),deliveryDate:'2026-02-30'})}));
    await form.getByRole('button',{name:'Convert to Sales Order',exact:true}).click();await expect(form.locator('[data-waitlist-error]')).toContainText('valid delivery date');
    await expect(form.locator('[name=deliveryDate]')).toHaveValue('2026-10-10');await expect(form.getByRole('button')).toBeEnabled();
    assert.equal((await query('SELECT id FROM regular_waitlist_conversions WHERE request_id=$1',[created.data.id])).rowCount,0);assert.equal((await getWaitlistRequest(created.data.id)).waitlist.heldQty,600);
  }finally{await view.close('sales-delivery-validation');}
});

test('SCM combines four filters, sorts numerically, keeps filters on refresh and sees queued PO evidence',async()=>{
  const a=await f.supply(),b=await f.supply(),customerB=9144026002;
  await query("UPDATE inventory_items SET vendor_id=$2,vendor=$3 WHERE item_id=$1",[a.itemId,9951,'Enhancement Vendor A']);
  await query("UPDATE inventory_items SET vendor_id=$2,vendor=$3 WHERE item_id=$1",[b.itemId,9952,'Enhancement Vendor B']);
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,display_name,legal_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'ENH-B','Enhancement Customer B','Enhancement Customer B','CAD',true,now(),'test',repeat('a',64))",[customerB]);
  const demand=(itemId,qty,yard,customerId)=>submitWaitlistRequest({operationKey:randomUUID(),customerId,destinationLocationId:yard,lines:[{itemId,salesQty:qty}]},f.context);
  const r1=await demand(a.itemId,9,1,f.customerId),r2=await demand(a.itemId,10,1,customerB),r3=await demand(a.itemId,5,28,f.customerId);await demand(b.itemId,100,28,customerB);
  await query("INSERT INTO scm_transport_schedule(order_kind,source_table,source_id,order_ref,status,created_at,eta_date) VALUES('PO','purchase_orders',$1,$2,'Queued','2026-10-02','2026-10-15')",[a.poId,a.poRef]);
  const view=await pageFor('scm','/scm/stock-requests?tab=waitlist',390);
  try{
    await view.page.getByRole('button',{name:/All waiting requests/}).click();
    await view.page.getByLabel('Vendor',{exact:true}).selectOption('9951');await view.page.getByLabel('Sort by',{exact:true}).selectOption('waitingQty');await view.page.getByLabel('Sort direction',{exact:true}).selectOption('desc');
    await expect(view.page.locator('[data-waitlist-request-row]')).toHaveCount(3);
    assert.deepEqual(await view.page.locator('[data-waitlist-request-row]').evaluateAll(rows=>rows.map(row=>Number(row.getAttribute('data-waitlist-request-row')))),[r2.id,r1.id,r3.id]);
    await view.page.locator('[data-waitlist-sort="waitingQty"]').click();await expect(view.page.getByLabel('Sort direction',{exact:true})).toHaveValue('asc');
    assert.deepEqual(await view.page.locator('[data-waitlist-request-row]').evaluateAll(rows=>rows.map(row=>Number(row.getAttribute('data-waitlist-request-row')))),[r3.id,r1.id,r2.id]);
    await view.page.getByLabel('Selling yard',{exact:true}).selectOption('1');await view.page.getByLabel('Item',{exact:true}).selectOption(String(a.itemId));await view.page.getByLabel('Customer',{exact:true}).selectOption(String(f.customerId));
    await expect(view.page.locator('[data-waitlist-request-row]')).toHaveCount(1);await expect(view.page.locator('[data-waitlist-request-row]')).toContainText(r1.requestRef);
    await expect(view.page.locator('[data-waitlist-request-row]')).toContainText(a.poRef);await expect(view.page.locator('[data-waitlist-request-row]')).toContainText('2026-10-15');
    await view.page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(view.page.getByLabel('Vendor',{exact:true})).toHaveValue('9951');await expect(view.page.locator('[data-waitlist-request-row]')).toHaveCount(1);
    await view.page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(view.page.getByLabel('Vendor',{exact:true})).toHaveValue('');assert(await view.page.locator('[data-waitlist-request-row]').count()>3);
    assert(await view.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await view.page.screenshot({path:out+'/scm-filtered-phone.png',fullPage:true});
  }finally{await view.close('scm-filtered');}
});
test('SCM Reject requires write access and returns the pool while Sales sees the rejection reason',async()=>{
  const s=await f.supply(),created=await api('sales','/api/sales/stock-requests',{deliveryMethod:'waitlist',customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:600}],operationKey:randomUUID()});
  await api('scm',`/api/scm/waitlist/pools/${s.pool.id}/allocations`,{operationKey:randomUUID(),expectedRevision:s.pool.revision,selections:[{requestId:created.data.id,expectedRevision:created.data.revision,quantity:600}]});
  const request=await getWaitlistRequest(created.data.id),url=`/api/scm/waitlist/requests/${request.id}/reject`,body={operationKey:randomUUID(),expectedRevision:request.revision,reason:'Not being produced <soon>'};
  for(const role of ['sales','operator'])assert.equal((await api(role,url,body)).status,403);
  assert.equal((await api('scm',url,{...body,reason:''})).status,400);assert.equal((await getWaitlistPool(s.pool.id)).availableQty,4400);
  const view=await pageFor('scm','/scm/stock-requests?tab=waitlist');
  try{
    await view.page.getByRole('button',{name:/All waiting requests/}).click();const row=view.page.locator(`[data-waitlist-request-row="${request.id}"]`);
    await row.getByRole('button',{name:'Reject',exact:true}).click();await row.locator('[name=reason]').fill('Not confirmed');await row.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await getWaitlistRequest(request.id)).revision,request.revision);assert.equal((await getWaitlistPool(s.pool.id)).availableQty,4400);
    await row.getByRole('button',{name:'Reject',exact:true}).click();await row.locator('[name=reason]').fill(body.reason);await row.getByRole('button',{name:'Confirm rejection',exact:true}).click();
    await expect(row).toHaveCount(0);assert.equal((await getWaitlistPool(s.pool.id)).availableQty,5000);
    assert.equal((await query("SELECT count(*) AS count FROM sales_stock_request_events WHERE request_id=$1 AND event_type='waitlist_rejected'",[request.id])).rows[0].count,'1');
    const sales=await pageFor('sales',`/sales/stock-requests?tab=regular&requestId=${request.id}`);
    try{await expect(sales.page.getByText('Rejected: '+body.reason,{exact:true})).toBeVisible();await expect(sales.page.locator('[data-waitlist-conversion-form]')).toHaveCount(0);}
    finally{await sales.close('sales-rejected');}
  }finally{await view.close('scm-rejection');}
});
