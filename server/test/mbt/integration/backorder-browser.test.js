/* global Node, scmStockState, requestAnimationFrame */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';

const users={},out=process.env.BACKORDER_BROWSER_OUTPUT || 'test-artifacts/backorder-enhancements-20261007/browser',sku=88999301;
let browser,server,base,requestId,planCount=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');mkdirSync(out,{recursive:true});
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES($1,'TEST-BROWSER-BO','Regular backorder material','EA','TEST Vendor',331)",[sku]);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(88999302,'TEST-BROWSER-SO','Closed',false)");
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(88999303,'TEST-BROWSER-PO','Closed',false)");
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']){
    const username='browser-bo-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();
    await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:role==='sales'?[1,28]:[]});
    const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);users[role]=(await r.json()).token;
  }
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await closeDb();});
async function pageFor(role,id,{vendorFailure=false,home=false}={}){
  // Prior cases can now emit a PO-link alert after their SO link. Acknowledge
  // other fixtures through the real API, keeping the selected case's alert intact.
  if(role==='sales' && id){
    const response=await fetch(base+'/api/sales/stock-requests/alerts',{headers:{authorization:'Bearer '+users.sales}});assert.equal(response.status,200);
    for(const row of (await response.json()).requests||[]){if(row.id===id)continue;const read=await fetch(base+`/api/sales/stock-requests/${row.id}/decisions/read`,{method:'POST',headers:{authorization:'Bearer '+users.sales,'content-type':'application/json'},body:JSON.stringify({eventId:row.eventId})});assert.equal(read.status,200);}
  }
  const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
  await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');if(localStorage.getItem('mbbs.scm.stockRequests.queue')===null)localStorage.setItem('mbbs.scm.stockRequests.queue','request');},users[role]);
  const page=await context.newPage(),errors=[],calls=[],directoryFinished=new Set();page.on('pageerror',e=>{errors.push(e.message);console.log(e.stack);});page.on('request',r=>calls.push({url:r.url(),method:r.method()}));page.setDefaultTimeout(10000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const directoryDone=r=>{if(r.url().includes('/stock-requests/backorder/vendors?'))directoryFinished.add(new URL(r.url()).searchParams.get('search'));};
  page.on('requestfinished',directoryDone);page.on('requestfailed',directoryDone);
  if(vendorFailure)await page.route('**/stock-requests/backorder/vendors?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'TEST directory outage'})}));
  await page.goto(home?`${base}/${role}`:`${base}/${role}/stock-requests?tab=regular${id?'&requestId='+id:''}`);
  if(role==='scm'&&!home){
    await page.waitForFunction(()=>typeof scmStockState!=='undefined'&&!scmStockState.loading);
    const names=await page.evaluate(()=>scmStockState.detail?.workflowKind==='backorder'&&!['closed','completed'].includes(scmStockState.detail.stage)?[...new Set(scmStockState.detail.lines.map(line=>line.vendorName))]:[]);
    await expect.poll(()=>names.every(name=>directoryFinished.has(name))).toBe(true);
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  }
  return {page,errors,calls,async close(){writeFileSync(out+'/'+role+'-'+Date.now()+'.coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
test('Sales creates a Backorder using the Regular picker with optional customer, no sales price and no ancillary controls',async()=>{
  const f=await pageFor('sales');try{
    const p=f.page;await p.locator('[data-sales-stock-action="new"]').click();
    await expect(p.locator('[data-regular-field="deliveryMethod"] option[value="backorder"]')).toHaveText('Backorder');
    await p.locator('[data-regular-field="deliveryMethod"]').selectOption('backorder');
    await p.locator('[data-sales-stock-destination]').selectOption('28');await p.locator('[data-sales-stock-destination]').selectOption('1');
    await expect(p.locator('[data-sales-stock-field="sourceLocationId"]')).toHaveCount(0);
    await expect(p.locator('[name="palletTotal"], [name="deliveryFeeRate"]')).toHaveCount(0);
    await p.locator('[data-sales-stock-field="itemSearch"]').fill('TEST-BROWSER-BO');
    await p.locator('[data-sales-stock-action="choose-item"]').click();
    await p.locator('[data-sales-stock-field="salesQty"]').fill('11');
    await expect(p.locator('[data-sales-stock-field="rate"],[data-sales-stock-field="discountPercent"]')).toHaveCount(0);
    await p.locator('[data-regular-field="fulfillmentMethod"]').selectOption('yard_pickup');
    await p.locator('[data-sales-stock-form] button[type="submit"]').click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('Backorder');
    const rows=(await query("SELECT id FROM sales_stock_requests WHERE regular_details->>'deliveryMethod'='backorder' ORDER BY id DESC LIMIT 1")).rows;requestId=Number(rows[0].id);
    await expect(p.locator('[data-backorder-detail]')).toContainText('11 EA');
    await expect(p.locator('[data-backorder-detail]')).not.toContainText('Create Sales Order');
    assert.ok(!f.calls.some(call=>call.url.includes('/availability/refresh')),'Backorder selection must not depend on live stock checks');
    await p.screenshot({path:out+'/sales-created.png',fullPage:true});assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
async function api(role,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+users[role],'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();}
async function planPurchase(ref){
  const id=(await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-03-10'::date+$1::integer,'draft') RETURNING id",[planCount++])).rows[0].id;
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[id,JSON.stringify([{id:ref,type:'PO'}]),JSON.stringify([{plate:'TEST browser truck',loads:[{name:'TEST load',stops:[{type:'pickup',orderId:ref}]}]}])]);
}
test('Sales attaches the NetSuite quotation number before review and after closure with retained input on conflicts',async()=>{
  const d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]});
  const f=await pageFor('sales',d.id);try{
    const p=f.page,quote=p.locator('[data-backorder-form][data-action="quotation/link"]');
    const save=async()=>{
      const response=p.waitForResponse(r=>r.url().endsWith('/backorder/quotation/link') && r.request().method()==='POST');
      await quote.getByRole('button',{name:'Save quotation number',exact:true}).click();
      const result=await response;assert.equal(result.status(),200);
      await expect(quote).toHaveAttribute('data-revision',String((await result.json()).revision));
    };
    await quote.getByLabel('NetSuite quotation number',{exact:true}).fill('QUOT-BROWSER-INITIAL');
    await save();
    await expect(quote.getByLabel('NetSuite quotation number',{exact:true})).toHaveValue('QUOT-BROWSER-INITIAL');
    assert.equal((await api('sales','/api/sales/stock-requests/'+d.id)).stage,'new_enquiry');
    await p.getByText('Close Backorder',{exact:true}).click();const close=p.locator('[data-backorder-form][data-action="close"]');
    await close.locator('[name="reason"]').fill('Quotation updated after closure');await close.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('Closed');
    await quote.getByLabel('NetSuite quotation number',{exact:true}).fill('QUOT-BROWSER-CLOSED');
    await save();
    await expect(quote.getByLabel('NetSuite quotation number',{exact:true})).toHaveValue('QUOT-BROWSER-CLOSED');
    const latest=await api('sales','/api/sales/stock-requests/'+d.id);
    await api('sales',`/api/sales/stock-requests/${d.id}/backorder/quotation/link`,{expectedRevision:latest.revision,quotationNumber:'QUOT-OTHER-TAB'});
    await quote.getByLabel('NetSuite quotation number',{exact:true}).fill('QUOT-STALE-BROWSER');await quote.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-error]')).toContainText('changed');
    await expect(quote.getByLabel('NetSuite quotation number',{exact:true})).toHaveValue('QUOT-STALE-BROWSER');await expect(quote.locator('button[type="submit"]')).toBeEnabled();
    await p.reload();await expect(quote.getByLabel('NetSuite quotation number',{exact:true})).toHaveValue('QUOT-OTHER-TAB');
    assert.equal((await api('sales','/api/sales/stock-requests/'+d.id)).stage,'closed');
    await expect(p.locator('[data-backorder-form]:not([data-action="quotation/link"])')).toHaveCount(0);
    await p.screenshot({path:out+'/sales-netsuite-quotation-closed.png',fullPage:true});assert.deepEqual(f.errors,[]);
    const scm=await pageFor('scm',d.id);try{
      await scm.page.locator('[data-scm-stock-filter="requestTypeFilter"]').selectOption('backorder');
      await scm.page.locator('[data-scm-stock-filter="backorderStageFilter"]').selectOption('closed');
      await expect(scm.page.locator('[data-backorder-detail]')).toContainText('QUOT-OTHER-TAB');await expect(scm.page.locator('[data-action="quotation/link"]')).toHaveCount(0);
    }finally{await scm.close();}
  }finally{await f.close();}
});
test('SCM and Sales link orders while Confirmed, then queue the PO reference for Dispatch Arrangement',async()=>{
  if(!requestId){const d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:11}]});requestId=d.id;}
  const scm=await pageFor('scm',requestId,{vendorFailure:true});try{
    const p=scm.page;await expect(p.locator('[data-backorder-detail]')).toContainText('Backorder');await expect(p.locator('[data-backorder-detail]')).not.toContainText('Create PO');
    const response=p.locator('[data-backorder-form][data-action$="/response"]');await expect(response.locator('[name="vendorId"]')).toHaveValue('331');await expect(response.locator('[name="unitPurchaseCost"]')).toHaveCount(0);
    await response.locator('[name="vendorYard"]').fill('TEST Vendor yard');await response.locator('button[type="submit"]').click();await expect(p.locator('[data-backorder-line] .backorder-material-summary > p').nth(1)).toContainText('In stock');
    await expect(p.locator('[data-backorder-form][data-action="purchase-order/link"]')).toHaveCount(0);assert.deepEqual(scm.errors,[]);
  }finally{await scm.close();}
  const sales=await pageFor('sales',requestId);try{
    const p=sales.page,decision=p.locator('[data-backorder-form][data-action$="/decision"]');await expect(p.locator('[data-backorder-detail]')).toContainText('Backorder');await expect(p.locator('dialog.regular-stock-popup[open]')).toHaveCount(0);
    await expect(p.locator('[data-backorder-form][data-action="sales-order/link"]')).toHaveCount(0);
    await decision.locator('[name="decision"]').selectOption('accepted');await decision.locator('button[type="submit"]').click();await expect(p.locator('[data-backorder-line]')).toContainText('accepted');await expect(p.locator('[data-backorder-form][data-action="sales-order/link"]')).toHaveCount(1);assert.deepEqual(sales.errors,[]);
    await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Confirmed');
    await expect(p.locator('[data-backorder-detail]')).not.toContainText('after SCM links the PO');
    await p.screenshot({path:out+'/sales-confirmed-so-link.png',fullPage:true});
    const link=p.locator('[data-backorder-form][data-action="sales-order/link"]');await link.locator('[name="salesOrderRef"]').fill('TEST-BROWSER-SO');await link.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('TEST-BROWSER-SO');await expect(link).toHaveCount(0);
    assert.equal((await api('sales','/api/sales/stock-requests/'+requestId)).purchaseOrderId,null);
  }finally{await sales.close();}
  const purchasing=await pageFor('scm',requestId);try{
    const p=purchasing.page,link=p.locator('[data-backorder-form][data-action="purchase-order/link"]');await expect(link).toHaveCount(1);await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Confirmed');
    await p.screenshot({path:out+'/scm-confirmed-po-link.png',fullPage:true});
    await link.locator('[name="purchaseOrderRef"]').fill('TEST-BROWSER-PO');await link.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('TEST-BROWSER-PO');await expect(p.locator('[data-backorder-detail]')).not.toContainText('PO approval');assert.deepEqual(purchasing.errors,[]);
  }finally{await purchasing.close();}
  const final=await pageFor('sales',requestId);try{
    const p=final.page;await expect(p.locator('[data-backorder-detail]')).toContainText('TEST-BROWSER-SO');await expect(p.locator('[data-backorder-detail]')).toContainText('TEST-BROWSER-PO');
    await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Confirmed');await expect(p.locator('[data-backorder-form][data-action="sales-order/link"]')).toHaveCount(0);await expect(p.locator('[data-action="quotation/link"]')).toHaveCount(1);const saved=await api('sales','/api/sales/stock-requests/'+requestId);assert.equal(saved.stage,'confirmed');assert.equal(saved.operationallyComplete,false);
    await query("UPDATE purchase_orders SET dispatch_ref='TEST-BROWSER-REF',initial_scm_status='Queued' WHERE netsuite_id=88999303");
    await p.reload();await expect(p.locator('[data-backorder-detail] .stock-request-heading')).toContainText('Dispatch Arrangement');assert.equal((await api('sales','/api/sales/stock-requests/'+requestId)).stage,'dispatch_arrangement');
    await p.screenshot({path:out+'/sales-dispatch-arrangement.png',fullPage:true});assert.deepEqual(final.errors,[]);
  }finally{await final.close();}
});

test('Sales gets a PO-linked notification with its NetSuite number and Open request acknowledges it',async()=>{
  let d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]});
  d=await api('scm',`/api/scm/stock-requests/${d.id}/backorder/lines/${d.lines[0].id}/response`,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST dock'});
  d=await api('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${d.lines[0].id}/decision`,{expectedRevision:d.revision,decision:'accepted'});
  d=await api('scm',`/api/scm/stock-requests/${d.id}/backorder/purchase-order/link`,{expectedRevision:d.revision,purchaseOrderRef:'TEST-BROWSER-PO'});
  for(const alert of (await api('sales','/api/sales/stock-requests/alerts')).requests){if(alert.id!==d.id)await api('sales',`/api/sales/stock-requests/${alert.id}/decisions/read`,{eventId:alert.eventId});}
  const f=await pageFor('sales',undefined,{home:true});try{
    const p=f.page;await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    const popup=p.locator('dialog.regular-stock-popup[open]');await expect(popup).toContainText(d.requestRef);await expect(popup).toContainText('PO linked: TEST-BROWSER-PO');
    await expect(popup.getByRole('link',{name:'Open request',exact:true})).toHaveAttribute('href',`/sales/stock-requests?tab=regular&requestId=${d.id}`);
    await p.screenshot({path:out+'/sales-po-linked-notification.png',fullPage:true});
    await popup.getByRole('link',{name:'Open request',exact:true}).click();await expect(p.locator('[data-backorder-detail]')).toContainText(d.requestRef);await expect(popup).toHaveCount(0);
    await expect.poll(async()=>(await api('sales','/api/sales/stock-requests/alerts')).requests.some(row=>row.id===d.id)).toBe(false);
    const quote=p.locator('[data-action="quotation/link"]');await quote.locator('[name="quotationNumber"]').fill('QUOT-NOTIFICATION');
    const response=p.waitForResponse(r=>r.url().endsWith('/backorder/quotation/link') && r.request().method()==='POST');await quote.locator('button[type="submit"]').click();const result=await response;assert.equal(result.status(),200);await expect(quote).toHaveAttribute('data-revision',String((await result.json()).revision));await expect(quote.locator('[name="quotationNumber"]')).toHaveValue('QUOT-NOTIFICATION');
    await p.goto(base+'/sales');await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(popup).toHaveCount(0);
    await p.reload();await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(popup).toHaveCount(0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('A pending Backorder save cannot replace another request selected by Sales',async()=>{
  async function create(description){
    const r=await fetch(base+'/api/sales/stock-requests',{method:'POST',headers:{authorization:'Bearer '+users.sales,'content-type':'application/json'},body:JSON.stringify({deliveryMethod:'backorder',destinationLocationId:1,vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',remarks:description,lines:[{itemId:sku,salesQty:2,rate:10}]})});
    assert.equal(r.status,201);return r.json();
  }
  const a=await create('First request'),b=await create('Second request'),f=await pageFor('sales',a.id);
  let release;const gate=new Promise(r=>release=r);let held;const responseHeld=new Promise(r=>held=r);
  try{
    const p=f.page;await expect(p.locator('[data-backorder-detail]')).toContainText(a.requestRef);
    await p.route(`**/api/sales/stock-requests/${a.id}/backorder/header`,async route=>{const response=await route.fetch();held();await gate;await route.fulfill({response});});
    await p.getByText('Edit request header',{exact:true}).click();
    const header=p.locator('[data-backorder-form][data-action="header"]');await header.locator('[name="remarks"]').fill('Saved first request');await header.locator('button[type="submit"]').click();
    await responseHeld;
    await p.locator(`[data-sales-stock-action="select"][data-id="${b.id}"]`).click();await expect(p.locator('[data-backorder-detail]')).toContainText(b.requestRef);
    await p.evaluate(()=>{window.backorderSelections=[];new MutationObserver(()=>{const id=document.querySelector('[data-backorder-detail]')?.getAttribute('data-backorder-id');if(id)window.backorderSelections.push(Number(id));}).observe(document.getElementById('salesStockRequestApp'),{childList:true,subtree:true});});
    const finished=p.waitForResponse(r=>r.url().endsWith(`/api/sales/stock-requests/${a.id}/backorder/header`));release();await finished;
    await p.waitForTimeout(200);await expect(p.locator('[data-backorder-detail]')).toContainText(b.requestRef);
    assert.ok((await p.evaluate(()=>window.backorderSelections)).every(id=>id===b.id),'A stale save must never display the first request over the second');
    assert.equal((await query('SELECT remarks FROM sales_stock_requests WHERE id=$1',[a.id])).rows[0].remarks,'Saved first request');assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});

test('Backorder local editing, quote preview, information replies and closed-stage filters work in the browser',async()=>{
  const r=await fetch(base+'/api/sales/stock-requests',{method:'POST',headers:{authorization:'Bearer '+users.sales,'content-type':'application/json'},body:JSON.stringify({deliveryMethod:'backorder',destinationLocationId:1,vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:5,rate:10}]})});assert.equal(r.status,201);const d=await r.json();
  const scm=await pageFor('scm',d.id);try{
    const p=scm.page,form=p.locator('[data-backorder-form][data-action="information/request"]');
    await form.locator('[name="question"]').fill('Confirm the requested size');await form.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-detail]')).toContainText('Confirm the requested size');assert.deepEqual(scm.errors,[]);
  }finally{await scm.close();}
  const sales=await pageFor('sales',d.id);try{
    const p=sales.page;await expect(p.locator('[data-backorder-detail]')).toContainText(d.requestRef);
    const reply=p.locator('[data-backorder-form][data-action="information/submit"]');await reply.locator('[name="reply"]').fill('Size confirmed');await reply.locator('button[type="submit"]').click();await expect(reply).toHaveCount(0);
    await p.getByText('Edit request material',{exact:true}).click();
    const material=p.locator('[data-backorder-form][data-action$="/edit"]');await material.locator('[name="quantity"]').fill('15');await expect(material.locator('[name="rate"],[name="discountPercent"]')).toHaveCount(0);await material.locator('[name="productName"]').fill('Local quote material');await material.locator('button[type="submit"]').click();
    await expect(p.locator('[data-backorder-line]')).toContainText('15 EA');await expect(p.locator('[data-backorder-line]')).toContainText('Local quote material');
    await p.getByText('Edit request header',{exact:true}).click();const header=p.locator('[data-backorder-form][data-action="header"]');await header.locator('[name="fulfillmentMethod"]').selectOption('mbt_delivery');await header.locator('[name="deliveryAddress"]').fill('123 TEST address');await header.locator('[name="salesInternalRemark"]').fill('Private Sales browser note');const headerSaved=p.waitForResponse(r=>r.url().endsWith(`/backorder/header`)&&r.request().method()==='POST');await header.locator('button[type="submit"]').click();assert.equal((await headerSaved).status(),200);await expect(p.locator('[data-backorder-detail] .stock-request-summary')).toContainText('Delivery');
    await expect(p.locator('[name="palletTotal"],[name="deliveryFeeRate"]')).toHaveCount(0);
    await expect(p.locator('[data-backorder-form][data-action="sales-order/link"]')).toHaveCount(0);
    const latest=await fetch(base+`/api/scm/stock-requests/${d.id}`,{headers:{authorization:'Bearer '+users.scm}});const current=await latest.json();
    const review=await fetch(base+`/api/scm/stock-requests/${d.id}/backorder/lines/${current.lines[0].id}/response`,{method:'POST',headers:{authorization:'Bearer '+users.scm,'content-type':'application/json'},body:JSON.stringify({expectedRevision:current.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST dock'})});assert.equal(review.status,200);
    const accepted=await api('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${current.lines[0].id}/decision`,{expectedRevision:(await review.json()).revision,decision:'accepted'});
    const purchasing=await api('scm',`/api/scm/stock-requests/${d.id}/backorder/purchase-order/link`,{expectedRevision:accepted.revision,purchaseOrderRef:'TEST-BROWSER-PO'});assert.equal(purchasing.salesOrderId,null);await planPurchase('TEST-BROWSER-PO');
    await p.reload();await expect(p.locator('[data-backorder-detail]')).toContainText('In stock');
    const link=p.locator('[data-backorder-form][data-action="sales-order/link"]');await link.locator('[name="salesOrderRef"]').fill('UNKNOWN-BROWSER-SO');await link.locator('button[type="submit"]').click();await expect(p.locator('[data-backorder-error]')).toContainText('not found');await expect(link.locator('[name="salesOrderRef"]')).toHaveValue('UNKNOWN-BROWSER-SO');await expect(link.locator('button[type="submit"]')).toBeEnabled();
    await p.evaluate(()=>{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.backorderPreviewBlob=blob;return create(blob);};});
    const quote=p.waitForResponse(x=>x.url().endsWith('/backorder/quote.pdf'));await p.locator('[data-backorder-document="quote.pdf"]').click();const pdf=await quote;assert.equal(pdf.status(),200);assert.match(pdf.headers()['content-type'],/application\/pdf/);const bytes=await pdf.body();const raw=await fetch(base+`/api/sales/stock-requests/${d.id}/backorder/quote.pdf`,{headers:{authorization:'Bearer '+users.sales}});const actual=Buffer.from(await raw.arrayBuffer());console.log('PDF response evidence:',JSON.stringify({browserHeaders:pdf.headers(),browserLength:bytes.length,httpLength:actual.length,httpPrefix:actual.subarray(0,5).toString()}));writeFileSync(out+'/backorder-quote-http.pdf',actual);await expect.poll(()=>p.evaluate(()=>window.backorderPreviewBlob?.size||0)).toBeGreaterThan(5);const received=Buffer.from(await p.evaluate(async()=>Array.from(new Uint8Array(await window.backorderPreviewBlob.arrayBuffer()))));writeFileSync(out+'/backorder-quote.pdf',received);assert.equal(received.subarray(0,5).toString(),'%PDF-');assert.equal(received.length,actual.length);
    await p.getByText('Close Backorder',{exact:true}).click();const close=p.locator('[data-backorder-form][data-action="close"]');await close.locator('[name="reason"]').fill('No longer required');await close.locator('button[type="submit"]').click();await expect(p.locator('[data-backorder-detail]')).toContainText('Closed');await expect(p.locator('[data-backorder-form]:not([data-action="quotation/link"])')).toHaveCount(0);await expect(p.locator('[data-action="quotation/link"]')).toHaveCount(1);
    await p.locator('[data-sales-multi-filter="requestTypeFilter"] summary').click();await p.locator('[data-sales-stock-filter="requestTypeFilter"][value="backorder"]').check();await p.locator('[data-sales-multi-filter="backorderStageFilter"] summary').click();await p.locator('[data-sales-stock-filter="backorderStageFilter"][value="closed"]').check();await expect(p.locator(`[data-sales-stock-action="select"][data-id="${d.id}"]`)).toBeVisible();
    await p.locator('[data-sales-stock-action="clear-filters"]').click();await expect(p.locator('[data-sales-stock-filter="requestTypeFilter"]:checked')).toHaveCount(0);await expect(p.locator('[data-sales-stock-filter="backorderStageFilter"]:checked')).toHaveCount(0);
    assert.deepEqual(sales.errors,[]);
  }finally{await sales.close();}
});


test('SCM Backorder case-stage and clear filters find closed requests without TO queues',async()=>{
  const complete=await api('sales','/api/sales/stock-requests/'+requestId);assert.equal(complete.stage,'dispatch_arrangement');
  const row=(await query("SELECT id,request_ref FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE c.workflow_kind='backorder' AND c.close_status='closed' ORDER BY r.id DESC LIMIT 1")).rows[0];assert.ok(row);
  const f=await pageFor('scm');try{
    const p=f.page;await p.locator('[data-scm-stock-filter="requestTypeFilter"]').selectOption('backorder');await p.locator('[data-scm-stock-filter="backorderStageFilter"]').selectOption('closed');await expect(p.locator(`[data-scm-stock-action="select"][data-id="${row.id}"]`)).toBeVisible();
    await expect(p.locator(`[data-scm-stock-action="select"][data-id="${requestId}"]`)).toHaveCount(0);
    await p.locator('[data-scm-stock-filter="backorderStageFilter"]').selectOption('dispatch_arrangement');await expect(p.locator(`[data-scm-stock-action="select"][data-id="${requestId}"]`)).toBeVisible();await expect(p.locator(`[data-scm-stock-action="select"][data-id="${row.id}"]`)).toHaveCount(0);
    await expect(p.locator('details[aria-label="Regular stock request queue"]')).toBeVisible();
    await p.locator('[data-scm-stock-action="clear-filters"]').click();await expect(p.locator('[data-scm-stock-filter="requestTypeFilter"]')).toHaveValue('');await expect(p.locator('[data-scm-stock-filter="backorderStageFilter"]')).toHaveCount(0);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('New Backorder enquiry hides order links in Sales and SCM',async()=>{
  const response=await fetch(base+'/api/sales/stock-requests',{method:'POST',headers:{authorization:'Bearer '+users.sales,'content-type':'application/json'},body:JSON.stringify({deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]})});assert.equal(response.status,201);const d=await response.json();
  for(const role of ['sales','scm']){const f=await pageFor(role,d.id);try{await expect(f.page.locator('[data-backorder-detail]')).toContainText('New enquiry');await expect(f.page.locator('[data-backorder-form][data-action$="-order/link"]')).toHaveCount(0);assert.deepEqual(f.errors,[]);}finally{await f.close();}}
});
test('SCM Request information appears before the material lines',async()=>{
  const response=await fetch(base+'/api/sales/stock-requests',{method:'POST',headers:{authorization:'Bearer '+users.sales,'content-type':'application/json'},body:JSON.stringify({deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]})});assert.equal(response.status,201);const d=await response.json();
  const f=await pageFor('scm',d.id);try{
    await expect(f.page.locator('[data-backorder-form][data-action="information/request"]')).toBeVisible();
    assert.ok(await f.page.evaluate(()=>Boolean(document.querySelector('[data-backorder-form][data-action="information/request"]').compareDocumentPosition(document.querySelector('[data-backorder-line]'))&Node.DOCUMENT_POSITION_FOLLOWING)));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('SCM Regular queue filter supports multiple selections, persists them and clears with other filters',async()=>{
  const d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]});
  const f=await pageFor('scm');try{
    const p=f.page,filter=p.locator('details[aria-label="Regular stock request queue"]');await expect(filter).toBeVisible();
    await expect(p.locator(`[data-scm-stock-action="select"][data-id="${d.id}"]`)).toBeVisible();await filter.locator('summary').click();
    await expect(filter.locator('input[type="checkbox"]')).toHaveCount(5);await expect(filter.locator('[value="request"]')).toBeChecked();
    const load=p.waitForResponse(r=>r.url().includes('/api/scm/stock-requests?')&&new URL(r.url()).searchParams.get('queue')==='request,closed');await filter.locator('[value="closed"]').check();assert.equal((await load).status(),200);
    await expect(filter).toHaveAttribute('open','');await expect(filter.locator('[value="request"]')).toBeChecked();await expect(filter.locator('[value="closed"]')).toBeChecked();
    await expect(p.locator(`[data-scm-stock-action="select"][data-id="${d.id}"]`)).toBeVisible();await expect(p.locator(`[data-scm-stock-action="select"][data-id="${requestId}"]`)).toBeVisible();
    await p.reload();await expect(filter).toBeVisible();await expect(p.locator(`[data-scm-stock-action="select"][data-id="${d.id}"]`)).toBeVisible();await filter.locator('summary').click();await expect(filter.locator('[value="closed"]')).toBeChecked();await expect(filter.locator('[value="request"]')).toBeChecked();
    await p.locator('[data-scm-stock-action="clear-filters"]').click();await expect(filter.locator('summary')).toContainText('All');assert.deepEqual(f.errors,[]);
    await p.screenshot({path:out+'/queue-multiselect.png',fullPage:true});
  }finally{await f.close();}
});

test('PO recheck restores the SCM field and button and submits the existing PO in the browser',async()=>{
  let d=await api('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:2}]});
  const action=async(role,name,input)=>{d=await api(role,`/api/${role}/stock-requests/${d.id}/backorder/${name}`,{expectedRevision:d.revision,...input});};
  await action('scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-02',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST yard'});
  await action('sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  await action('sales','sales-order/link',{salesOrderRef:'TEST-BROWSER-SO'});
  const f=await pageFor('scm',d.id);
  try{
    const p=f.page,link=p.locator('[data-backorder-form][data-action="purchase-order/link"]');
    await expect(link.locator('[name="purchaseOrderRef"]')).toBeVisible();
    const response=p.locator('[data-backorder-form][data-action$="/response"]');
    await response.locator('[name="supplyStatus"]').selectOption('in_stock');
    const saved=p.waitForResponse(r=>r.url().endsWith('/response')&&r.request().method()==='POST');
    await response.locator('button[type="submit"]').click();
    const result=await saved;assert.equal(result.status(),200);assert.equal((await result.json()).lines[0].salesDecision,'pending');
    await expect(link.locator('[name="purchaseOrderRef"]')).toBeVisible();
    await expect(link.getByRole('button',{name:'Manual PO link',exact:true})).toBeEnabled();
    await p.reload();
    await expect(link.locator('[name="purchaseOrderRef"]')).toBeVisible();
    await p.screenshot({path:out+'/scm-po-link-after-stock-recheck.png',fullPage:true});
    await link.locator('[name="purchaseOrderRef"]').fill('TEST-BROWSER-PO');
    const linked=p.waitForResponse(r=>r.url().endsWith('/purchase-order/link')&&r.request().method()==='POST');
    await link.getByRole('button',{name:'Manual PO link',exact:true}).click();
    assert.equal((await linked).status(),200);await expect(link).toHaveCount(0);
    const current=await api('scm','/api/scm/stock-requests/'+d.id);
    assert.equal(current.purchaseOrderRef,'TEST-BROWSER-PO');assert.equal(current.salesOrderRef,'TEST-BROWSER-SO');assert.equal(current.lines[0].salesDecision,'pending');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

