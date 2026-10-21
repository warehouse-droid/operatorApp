import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {getStockRequestItemAvailability,getScmStockRequest} from '../src/stock-request-repository.js';
import {getPurchaseStockEvidence} from '../src/regular-stock-purchase-repository.js';
import {completeSmartScmPurchaseExecution} from '../src/smart-scm-vendor-repository.js';
import {upsertPurchaseOrderLines} from '../src/order-sync-repository.js';
import {persistPurchaseStockDrafts} from '../src/smart-scm-planning-repository.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-purchase';
await mkdir(out,{recursive:true});
const suffix=randomUUID(),itemId=9800000000000+Date.now()%1000000000,source=910003,checks=[],errors=[],refreshes=[];
await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'Purchase browser vendor','Purchase browser pickup') ON CONFLICT(id) DO NOTHING",[source]);
await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor,purchase_unit,last_purchase_price)
 VALUES($1,'PURCHASE-BROWSER-MATERIAL','EA',1,100,10,$2,'Purchase browser vendor','EA',1) ON CONFLICT(item_id) DO UPDATE SET to_plt=100,vendor_id=$2`,[itemId,source]);
await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at)
 VALUES($1,28,'2967',50,70,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=50,quantity_on_hand=70,synced_at=now()`,[itemId]);
await query(`INSERT INTO scm_smart_item_policies(item_id,item_name,to_plt,planning_enabled,pallet_weight_lbs,vendor_yard_id,vendor_yard,vendor)
 VALUES($1,'PURCHASE-BROWSER-MATERIAL',100,false,1000,$2,'Purchase browser pickup','Purchase browser vendor')
 ON CONFLICT(item_id) DO UPDATE SET planning_enabled=false,vendor_yard_id=$2,inactive=false,discontinued=false`,[itemId,source]);
await query(`INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,capacity_pallets,minimum_safety_pallets)
 VALUES($1,28,'2967',true,50,10) ON CONFLICT(item_id,location_id) DO UPDATE SET eligible=true,capacity_pallets=50,minimum_safety_pallets=10`,[itemId]);

const server=app.listen(3000,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const pages=[];
async function pageFor(role,width=1440){
  const username=`purchase-browser-${role}-${suffix}`;
  await createOperator({username,displayName:username,password:'test-disposable-purchase-2026!',role,roles:[role],yardLocationIds:role==='sales'?[28,26]:[]});
  const context=await browser.newContext({viewport:{width,height:1000}});
  // Avoid exhausting Chromium's HTTP/1 event-stream connections across the
  // workflow pages. UI actions and refreshes still use the real HTTP backend.
  await context.route('**/api/events?*',route=>route.fulfill({contentType:'text/event-stream',body:'retry: 3600000\n\n'}));
  const response=await context.request.post('http://127.0.0.1:3000/api/auth/login',{data:{username,password:'test-disposable-purchase-2026!'}});
  assert.equal(response.status(),200);const {token}=await response.json();
  await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.scm.stockRequests.queue','request');},token);
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{errors.push(`Unexpected default dialog: ${dialog.message()}`);await dialog.dismiss();});
  await page.coverage.startJSCoverage({resetOnNavigation:false});pages.push({page,role});
  return {page,context,token};
}
async function api(context,token,path,data){
  return context.request.post(`http://127.0.0.1:3000${path}`,{headers:{Authorization:`Bearer ${token}`},data});
}
async function captured(page,name){
  await writeFile(`${out}/browser-coverage-${name}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
}
try{
  const salesSession=await pageFor('sales'),{page:sales}=salesSession;
  // Only the external inventory-read boundary is simulated. Submission,
  // authorization, manual review and proposal creation use the real HTTP app.
  await sales.route('**/api/sales/stock-request-items/*/availability/refresh',async route=>{
    const body=route.request().postDataJSON();refreshes.push(body);
    const availability=await getStockRequestItemAvailability(itemId,body.stockingType==='purchase'?{locationId:body.destinationLocationId}:{});
    if(body.stockingType==='purchase')availability.yards[0].preferredStock=(await getPurchaseStockEvidence(itemId,body.destinationLocationId)).preferredStock;
    await route.fulfill({json:availability});
  });
  await sales.goto('http://127.0.0.1:3000/sales/stock-requests?tab=regular');
  await sales.locator('[data-sales-stock-action="new"]').click();
  await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('stocking');
  assert.deepEqual(await sales.locator('[data-regular-field="stockingType"] option').allTextContents(),['Transfer','Purchase']);
  await sales.locator('[data-regular-field="stockingType"]').selectOption('purchase');
  assert.equal(await sales.locator('[data-sales-stock-field="sourceLocationId"]').count(),0);
  assert.equal(await sales.locator('[data-regular-field="arrivalDate"]').count(),0);
  await sales.locator('[data-sales-stock-field="itemSearch"]').fill('PURCHASE-BROWSER-MATERIAL');
  await sales.locator(`[data-sales-stock-action="choose-item"][data-item-id="${itemId}"]`).click();
  await sales.locator('.regular-stock-safety').waitFor();
  assert.deepEqual(refreshes,[{stockingType:'purchase',destinationLocationId:28}]);
  assert.equal(await sales.locator('.regular-stock-safety span').count(),3);
  assert.match(await sales.locator('.regular-stock-safety').innerText(),/On hand[\s\S]*70[\s\S]*Available[\s\S]*50[\s\S]*Preferred stock level/i);
  await sales.locator('[data-sales-stock-destination]').selectOption('26');
  await sales.waitForFunction(()=>document.querySelector('.regular-stock-safety')?.innerText.includes('Unavailable'));
  assert.equal(refreshes.at(-1).destinationLocationId,26);
  await sales.locator('[data-sales-stock-destination]').selectOption('28');
  await sales.waitForFunction(()=>document.querySelector('.regular-stock-safety')?.innerText.includes('70 EA'));
  assert.equal(refreshes.at(-1).destinationLocationId,28);
  await sales.locator('[data-sales-stock-field="pieces"]').fill('150');
  await sales.setViewportSize({width:390,height:844});
  await sales.screenshot({path:`${out}/purchase-composer-mobile.png`,fullPage:true});
  const submitted=sales.waitForResponse(response=>response.url().endsWith('/api/sales/stock-requests')&&response.request().method()==='POST');
  await sales.locator('[data-sales-stock-form] button[type="submit"]').click();
  const response=await submitted;assert.equal(response.status(),201);const request=await response.json();
  assert.equal(request.bucket,'pending');assert.equal(request.lines[0].sourceLocationId,null);assert.equal(request.regular.approval.automatic,false);
  checks.push('Stocking Purchase/Transfer choice; source-less current-yard metrics; mobile submission above available stock stays manual');
  await sales.getByRole('heading',{name:request.requestRef,exact:true}).waitFor();
  assert.equal(await sales.locator('[data-regular-so]').count(),0);
  await sales.locator('[data-sales-stock-action="edit"]').click();
  assert.equal(await sales.locator('[data-regular-field="stockingType"]').inputValue(),'purchase');
  assert.equal(await sales.locator('[data-sales-stock-field="sourceLocationId"]').count(),0);
  await sales.locator('[data-sales-stock-field="pieces"]').fill('175');
  const edited=sales.waitForResponse(response=>response.url().endsWith(`/api/sales/stock-requests/${request.id}`)&&response.request().method()==='PATCH');
  await sales.locator('[data-sales-stock-form] button[type="submit"]').click();
  assert.equal((await edited).status(),200);
  await sales.getByRole('heading',{name:request.requestRef,exact:true}).waitFor();
  checks.push('Changing the current yard fetches that yard alone; unknown stock stays unavailable; editing preserves Purchase mode');
  await captured(sales,'composer');
  assert.equal((await api(salesSession.context,salesSession.token,`/api/scm/stock-requests/${request.id}/purchase-proposals`,{expectedRevision:request.revision,lines:[{lineId:request.lines[0].id}]})).status(),403);
  const forbidden=await api(salesSession.context,salesSession.token,'/api/sales/stock-requests',{deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:1,lines:[{itemId,pieces:1}]});
  assert.equal(forbidden.status(),403);
  assert.equal((await api(salesSession.context,salesSession.token,`/api/sales/stock-request-items/${itemId}/availability/refresh`,{stockingType:'purchase',destinationLocationId:1})).status(),403);
  checks.push('Sales cannot accept Purchase demand or create a request for an unauthorized yard');

  const scmSession=await pageFor('scm'),{page:scm}=scmSession;
  await scm.goto('http://127.0.0.1:3000/scm/stock-requests?tab=regular&review=1');
  await scm.locator(`[data-scm-stock-action="select"][data-id="${request.id}"]`).click();
  await scm.getByRole('heading',{name:request.requestRef,exact:true}).waitFor();
  const review=scm.locator(`[data-purchase-review-line="${request.lines[0].id}"]`);
  await review.waitFor();
  assert.match(await scm.locator('.regular-stock-safety').innerText(),/On hand[\s\S]*70[\s\S]*Available[\s\S]*50[\s\S]*Preferred stock level[\s\S]*1,000/i);
  assert.equal(await scm.locator('[data-scm-stock-action="pickup-convert"]').count(),0);
  await review.fill('125');
  await scm.locator('[data-scm-stock-action="select-all"]').click();
  assert.equal(await review.inputValue(),'125');
  assert.match(await scm.locator('[data-purchase-rounded-line]').innerText(),/200 EA/);
  await scm.screenshot({path:`${out}/scm-purchase-review-desktop.png`,fullPage:true});
  const added=scm.waitForResponse(response=>response.url().endsWith(`/api/scm/stock-requests/${request.id}/purchase-proposals`));
  await scm.locator('[data-scm-stock-action="purchase-add"]').click();
  const acceptance=await added;assert.equal(acceptance.status(),200);const accepted=await acceptance.json();
  assert.equal(accepted.bucket,'accepted');assert.equal(accepted.lines[0].purchase.reviewedQuantity,125);assert.equal(accepted.lines[0].purchase.approvedQuantity,200);
  await scm.locator('[data-scm-stock-action="queue"][data-queue="approved"][aria-selected="true"]').waitFor();
  await scm.getByRole('heading',{name:request.requestRef,exact:true}).waitFor();
  let link=accepted.lines[0].purchase.proposals[0];assert(link);
  checks.push('SCM adjusts quantity, previews upward rounding and adds a real proposal; request remains selected in Accepted');
  await captured(scm,'review');

  const purchase=(await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[link.proposalId])).rows[0];
  const ordinaryKey=`purchase-browser-ordinary-${request.id}`;
  const ordinaryLine={itemId,itemName:'PURCHASE-BROWSER-MATERIAL',itemDescription:'',unit:'EA',requiredPallets:1,proposedPallets:1,confirmedPallets:0,residualPallets:1,salesQuantity:100,palletWeight:1000,lineWeight:1000,toPlt:100,toLyr:0,toSec:0,toPcs:1,destinationLocationId:28,destinationName:'2967',manualPlanningRequired:false,reason:{}};
  await persistPurchaseStockDrafts(purchase.run_id,[{proposalKey:ordinaryKey,proposalType:'PO',phase:'direct_vendor',sourceKind:'vendor',sourceVendorYardId:source,sourceName:purchase.source_name,plant:purchase.plant,vendor:purchase.vendor,destinationLocationId:28,destinationName:'2967',status:'held',totalPallets:1,totalWeight:1000,utilization:1000/78000,memo:'Ordinary browser load',urgent:false,provisional:false,lines:[ordinaryLine]}]);
  const ordinaryId=Number((await query('SELECT id FROM scm_smart_proposals WHERE proposal_key=$1',[ordinaryKey])).rows[0].id);
  const smart=await scmSession.context.newPage();pages.push({page:smart,role:'smart'});
  smart.setDefaultTimeout(15000);smart.on('pageerror',error=>errors.push(error.message));
  smart.on('dialog',async dialog=>{
    if(dialog.type()==='confirm'&&dialog.message().includes('Purchase quantities and request links will be preserved'))await dialog.accept();
    else{errors.push(`Unexpected proposal dialog: ${dialog.message()}`);await dialog.dismiss();}
  });
  await smart.coverage.startJSCoverage({resetOnNavigation:false});
  await smart.goto('http://127.0.0.1:3000/scm/smart',{waitUntil:'domcontentloaded'});await smart.locator('[data-smart-tab="plans"]').click();
  await smart.locator(`[data-smart-proposal-select="${link.proposalId}"]`).check();
  await smart.locator(`[data-smart-proposal-select="${ordinaryId}"]`).check();
  const grouped=smart.waitForResponse(response=>response.url().endsWith('/api/scm/smart/proposals/group'),{timeout:60000});
  await smart.locator('[data-smart-action="group-proposals"]').click();assert.equal((await grouped).status(),200);
  link=(await getScmStockRequest(request.id)).lines[0].purchase.proposals[0];
  await smart.getByText('Stocking Purchase',{exact:false}).first().waitFor();
  await smart.screenshot({path:`${out}/purchase-merged-proposal-desktop.png`,fullPage:true});
  await captured(smart,'merged-proposals');checks.push('Real PO/TO proposal UI groups Purchase with an ordinary load and retains the request banner and allocated quantity');

  const poId=9903000000000+Date.now()%1000000000;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_reference,status_text,netsuite_active,destination_location_id) VALUES($1,'PO-PURCHASE-BROWSER','PURCHASE-REF-BROWSER','Pending Receipt',true,28)",[poId]);
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:itemId,quantity:300,netsuite_received_qty:50,unit:'EA',to_plt:100,pallet_qty:3,location_id:28,netsuite_active:true}]);
  await completeSmartScmPurchaseExecution(link.proposalId,{purchaseOrderId:poId,purchaseOrderRef:'PO-PURCHASE-BROWSER'},null);
  const otherId=poId+1;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_reference,status_text,netsuite_active,destination_location_id) VALUES($1,'PO-OTHER-BROWSER','OTHER-REF','Pending Receipt',true,28)",[otherId]);
  await upsertPurchaseOrderLines(otherId,[{line_id:1,item_id:itemId,quantity:500,netsuite_received_qty:0,unit:'EA',to_plt:100,pallet_qty:5,location_id:28,netsuite_active:true}]);
  assert.equal((await getScmStockRequest(request.id)).lines[0].purchase.orderedQuantity,200);
  await scm.locator('[data-scm-stock-action="refresh"]').click();
  await scm.getByText('PO-OTHER-BROWSER',{exact:true}).waitFor();
  assert.match(await scm.locator('.stock-request-lines table').innerText(),/Directly linked[\s\S]*PURCHASE-REF-BROWSER[\s\S]*Other incoming[\s\S]*PO-OTHER-BROWSER/);
  assert.equal((await getScmStockRequest(request.id)).bucket,'accepted');
  await scm.setViewportSize({width:390,height:844});
  assert(await scm.locator('.regular-purchase-orders').evaluate(element=>{
    element.scrollLeft=element.scrollWidth;return element.scrollLeft>0;
  }),'The mobile PO table must scroll to its quantity and arrival columns');
  await scm.screenshot({path:`${out}/purchase-po-trace-mobile.png`,fullPage:true});
  assert(await scm.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'Purchase PO trace must not overflow the mobile page');
  await sales.goto(`http://127.0.0.1:3000/sales/stock-requests?tab=regular&requestId=${request.id}`);
  await sales.getByText('PO-PURCHASE-BROWSER',{exact:true}).waitFor();
  assert.equal(await sales.locator('[data-regular-so]').count(),0);
  await sales.evaluate(()=>window.MBBS_I18N.setLanguage('zh-CN'));
  await sales.getByText('直接关联',{exact:false}).waitFor();
  await sales.screenshot({path:`${out}/purchase-po-trace-chinese-mobile.png`,fullPage:true});
  checks.push('SCM and Sales trace direct PO number/reference plus separate informational incoming orders; partial receipt remains Accepted; Chinese mobile view');
  await captured(sales,'trace');
  await captured(scm,'trace');
  await upsertPurchaseOrderLines(poId,[{line_id:1,item_id:itemId,quantity:300,netsuite_received_qty:200,unit:'EA',to_plt:100,pallet_qty:3,location_id:28,netsuite_active:true}]);
  assert.equal((await getScmStockRequest(request.id)).bucket,'completed');
  checks.push('Receipt of the full allocated request quantity completes it while ordinary PO quantity remains open');

  const releaseResponse=await api(salesSession.context,salesSession.token,'/api/sales/stock-requests',{deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:28,lines:[{itemId,pieces:60}]});
  assert.equal(releaseResponse.status(),201);const releaseRequest=await releaseResponse.json();
  await scm.locator('[data-scm-stock-action="queue"][data-queue="request"]').click();
  await scm.locator(`[data-scm-stock-action="select"][data-id="${releaseRequest.id}"]`).click();
  await scm.getByRole('heading',{name:releaseRequest.requestRef,exact:true}).waitFor();
  await scm.locator('[data-scm-stock-action="select-all"]').click();
  const releaseAccepted=scm.waitForResponse(response=>response.url().endsWith(`/api/scm/stock-requests/${releaseRequest.id}/purchase-proposals`));
  await scm.locator('[data-scm-stock-action="purchase-add"]').click();assert.equal((await releaseAccepted).status(),200);
  await scm.waitForFunction(()=>!window.RegularStockDialog.isBusy());
  await scm.getByRole('heading',{name:releaseRequest.requestRef,exact:true}).waitFor();
  await scm.locator(`[data-purchase-release-reason="${releaseRequest.lines[0].id}"]`).fill('Requirement cancelled');
  await scm.locator('[data-scm-stock-action="select-all"]').click();
  assert.equal(await scm.locator(`[data-purchase-release-reason="${releaseRequest.lines[0].id}"]`).inputValue(),'Requirement cancelled');
  const released=scm.waitForResponse(response=>response.url().endsWith(`/api/scm/stock-requests/${releaseRequest.id}/purchase-release`));
  await scm.locator('[data-scm-stock-action="purchase-release"]').click();const releasedResponse=await released;assert.equal(releasedResponse.status(),200);
  const releasedRequest=await releasedResponse.json();assert.equal(releasedRequest.bucket,'completed');assert.equal(releasedRequest.lines[0].purchase.releasedQuantity,100);assert.equal(releasedRequest.lines[0].purchase.receivedQuantity,0);
  await scm.locator('[data-scm-stock-action="queue"][data-queue="closed"][aria-selected="true"]').waitFor();
  await captured(scm,'release');checks.push('SCM explicitly releases the unordered quantity, records its reason and moves the request to Closed without a fabricated receipt');

  await sales.evaluate(()=>window.MBBS_I18N.setLanguage('en'));
  await sales.locator('[data-sales-stock-action="new"]').click();
  await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('stocking');
  assert.equal(await sales.locator('[data-regular-field="stockingType"]').inputValue(),'transfer');
  assert.equal(await sales.locator('[data-sales-stock-field="sourceLocationId"]').count(),1);
  await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('pickup');
  assert.equal(await sales.locator('[data-regular-field="stockingType"]').count(),0);
  checks.push('Transfer remains the default with its source selector; Pickup does not show a Purchase option');
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/browser-report.json`,JSON.stringify({ok:true,checks,errors,refreshes},null,2));
  console.log(JSON.stringify({ok:true,checks:checks.length,errors}));
}catch(error){
  await writeFile(`${out}/browser-failure.json`,JSON.stringify({message:error.message,stack:error.stack,checks,errors},null,2));
  for(const {page,role} of pages)await page.screenshot({path:`${out}/failure-${role}.png`,fullPage:true}).catch(()=>{});
  throw error;
}finally{
  for(const {page,role} of pages)await writeFile(`${out}/browser-coverage-final-${role}.json`,JSON.stringify(await page.coverage.stopJSCoverage())).catch(()=>{});
  await browser.close();await new Promise(resolve=>server.close(resolve));await closeDb();
}
