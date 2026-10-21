import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {runDeliveryOperation} from '../src/regular-stock-delivery-operations.js';
import {getScmStockRequest} from '../src/stock-request-repository.js';
import {confirmStockTransferWorkflow} from '../src/stock-request-service.js';
const itemId=9800000000123,run=randomUUID(),errors=[],checks=[];
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES(9800000000182,'PALLET','EA',1,1) ON CONFLICT DO NOTHING");
await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'DELIVERY BROWSER MATERIAL','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
for(const id of [1,28,15])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now()) ON CONFLICT DO NOTHING",[itemId,id,String(id)]);
const server=app.listen(3000,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const fixtures=new Map(),workers=new Set(),browserCoverage=[];let nextId=1500000000,writes=0,held=null,failPreview=false,release,dropAccept=false,heldCreate=null,releaseCreate;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(input){
 if(fixtures.has(input.salesOrderRef))return fixtures.get(input.salesOrderRef);
 const base=input.salesOrderRef==='SO-BROWSER-BASE-3445'?1:28;
 const order={id:++nextId,ref:input.salesOrderRef,locationId:15,lines:[{remoteLineId:1,itemId,quantity:200,backorderedQuantity:20,uom:'EA',locationId:base,open:true}]};
 const result={liveExecutionEnabled:true,readOrder:async()=>{if(input.salesOrderRef==='SO-BROWSER-RETRY'){if(held)await held;if(failPreview)throw Error('NetSuite temporarily unavailable');}return order;},refreshAvailability:async()=>{await query('UPDATE inventory_balances SET quantity_available=$2 WHERE item_id=$1',[itemId,input.salesOrderRef==='SO-BROWSER-SHORTAGE'?10:input.salesOrderRef==='SO-BROWSER-FALLBACK'?50:1000]);},hydrateOrder:async()=>{},linkTransferDependency:async()=>{},
  confirmTransfer:async transfer=>confirmStockTransferWorkflow({transfer,requestId:`browser:${transfer.id}`},{
    ensurePrinter:async()=>{},resolveLocations:async()=>({source:{netsuiteLocationId:transfer.sourceLocationId,subsidiaryId:2},destination:{netsuiteLocationId:transfer.destinationLocationId,subsidiaryId:2},intercompany:false}),
    findRemoteByMarker:async()=>[],createRemote:async()=>{if(heldCreate)await heldCreate;writes++;await pause(1000);return {id:1600000000+transfer.id,tranid:`TO-BROWSER-${transfer.id}`};},
    recordRemote:async(id,remote)=>query('UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3 WHERE id=$1',[id,remote.id,remote.tranid]),
    approveRemote:async()=>{await pause(1000);},hydrateRemote:async()=>({tranid:`TO-BROWSER-${transfer.id}`,pendingFulfillment:true}),
    recordApproved:async()=>query("UPDATE sales_stock_transfers SET status='pending_fulfillment' WHERE id=$1",[transfer.id]),
    fetchTicket:async()=>{await pause(1000);return {};},claimPrint:async()=>({generation:1}),queuePrint:async()=>{await pause(1000);return (await query("INSERT INTO scm_print_jobs(job_key,location_id,document_name,document_path,document_sha256) VALUES($1,$2,'isolated.pdf','/tmp/isolated.pdf',$3) ON CONFLICT(job_key) DO UPDATE SET job_key=EXCLUDED.job_key RETURNING id,status",[`browser:${run}:${transfer.id}`,transfer.sourceLocationId,'0'.repeat(64)])).rows[0];},
    complete:async(id,{printJobId})=>query("UPDATE sales_stock_transfers SET confirmation_status='complete',print_job_id=$2 WHERE id=$1",[id,printJobId]),fail:async()=>{}
  })};
 fixtures.set(input.salesOrderRef,result);return result;
}
async function pageFor(role){
 const username=`delivery-${role}-${run}`;
 const actor=await createOperator({username,displayName:username,password:'Disposable-Regular-2026!',role,roles:[role],yardLocationIds:role==='sales'?[1,28]:[]});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const login=await context.request.post('http://127.0.0.1:3000/api/auth/login',{data:{username,password:'Disposable-Regular-2026!'}});assert.equal(login.status(),200);
 const {token}=await login.json();await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),token);
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.coverage.startJSCoverage({resetOnNavigation:false});
 return {page,actor};
}
async function transport(page,audience,onCommand=()=>{}){
 await page.route(`**/api/${audience}/stock-requests/delivery/operations`,async route=>{
  const command=route.request().postDataJSON();onCommand(command);
  const response=await route.fetch();
  if(response.status()!==202){await route.fulfill({response});return;}
  const input=command.requestId?{salesOrderRef:(await getScmStockRequest(command.requestId)).regular.salesOrderRef}:command.input;
  const worker=runDeliveryOperation(command.operationId,fixture(input));workers.add(worker);worker.finally(()=>workers.delete(worker));
  if(dropAccept){dropAccept=false;await route.abort('failed');}else await route.fulfill({response});
 });
}
try{
 const {page:sales}=await pageFor('sales');
 const submissions=[];
 await transport(sales,'sales',command=>{
  if(command.action==='submit'){
    submissions.push(command.input);
    assert.deepEqual(Object.keys(command.input).sort(),['deliveryMethod','sourceLocationId','destinationLocationId','salesOrderRef'].sort());
  }
 });
 await sales.goto('http://127.0.0.1:3000/sales/stock-requests?tab=regular');
 await sales.locator('[data-sales-stock-action="new"]').click();
 for(const method of ['pickup','stocking','delivery']){
  await sales.locator('[data-regular-field="deliveryMethod"]').selectOption(method);
  assert.equal(await sales.locator('[data-regular-field="arrivalDate"], [data-regular-field="arrivalTime"]').count(),0);
  assert.equal(await sales.locator('[data-sales-stock-field="itemSearch"]').count(),method==='delivery'?0:1);
 }
 assert.equal(await sales.locator('[data-sales-stock-form] input, [data-sales-stock-form] select').count(),4);
 assert.equal(await sales.locator('[data-regular-field="customerName"], [data-sales-stock-remarks], [data-sales-stock-action="add-line"]').count(),0);
 assert.match(await sales.locator('[data-sales-stock-form]').innerText(),/Base Yard/);
 assert.match(await sales.locator('[data-sales-stock-form]').innerText(),/Target Yard/);
 assert.equal(await sales.locator('[data-delivery-base]').getAttribute('readonly'),'');
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('1');
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-BASE-3445');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.waitForFunction(()=>document.querySelector('[data-delivery-base]')?.value==='3445');
 assert.equal(await sales.locator('[data-regular-field="sourceLocationId"]').inputValue(),'');
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-SHORTAGE');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.waitForFunction(()=>document.querySelector('[data-delivery-base]')?.value==='2967');
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('1');
 await sales.locator('[data-delivery-calculation] .stock-request-error').waitFor();
 assert.match(await sales.locator('[data-delivery-calculation]').innerText(),/shortage/);
 assert.equal(await sales.locator('[data-sales-stock-form] button[type="submit"]').isDisabled(),true);
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-FALLBACK');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 1'}).waitFor();
 assert.match(await sales.locator('[data-delivery-calculation]').innerText(),/20 EA/);
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-AUTO');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
 assert.match(await sales.locator('[data-delivery-calculation]').innerText(),/200 EA/);
 checks.push('SO line locations derive Base Yard; full-line, backorder fallback and shortage previews calculate units and PALLET');
 await sales.screenshot({path:'test-artifacts/delivery-desktop.png',fullPage:true});
 await sales.locator('[data-sales-stock-form] button[type="submit"]').click();
 for(const phase of ['Creating TO in NetSuite','Approving TO in NetSuite','Preparing TO picking ticket','Queueing TO for yard printing']){
  await sales.locator('#regularStockDialogMessage').filter({hasText:phase}).waitFor();
  assert.equal(await sales.locator('button:enabled').count(),0);
 }
 await sales.locator('.regular-delivery-result').waitFor();
 assert.equal(writes,1);assert.match(await sales.locator('.regular-delivery-result').innerText(),/Transfer Order created/);
 assert.match(await sales.locator('.regular-delivery-result').innerText(),/Print queued/);
 const autoTransfer=(await query("SELECT t.id FROM sales_stock_transfers t JOIN regular_stock_handoffs h ON h.request_id=t.request_id WHERE h.sales_order_ref='SO-BROWSER-AUTO'")).rows[0].id;
 await query("UPDATE scm_print_jobs SET status='printing' WHERE job_key=$1",[`browser:${run}:${autoTransfer}`]);
 await sales.locator('.regular-delivery-result').filter({hasText:'Printing TO'}).waitFor();
 await query("UPDATE scm_print_jobs SET status='printed' WHERE job_key=$1",[`browser:${run}:${autoTransfer}`]);
 await sales.locator('.regular-delivery-result').filter({hasText:'Printed'}).waitFor();
 checks.push('Sales refreshes actual print-agent status from queued to printing to printed');
 assert.equal(await sales.locator('[data-regular-so]').count(),0);checks.push('Three Delivery inputs; automatic submission creates the TO without a second SO entry');
 await sales.locator('[data-sales-stock-action="new"]').click();
 await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('15');
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-MANUAL');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
 await sales.setViewportSize({width:390,height:844});
 await sales.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth);
 await sales.evaluate(()=>window.dispatchEvent(new Event('mbbs-language-changed')));
 assert.equal(await sales.locator('[data-regular-field="salesOrderRef"]').inputValue(),'SO-BROWSER-MANUAL');
 assert.equal(await sales.locator('[data-regular-field="sourceLocationId"]').inputValue(),'15');
 await sales.screenshot({path:'test-artifacts/delivery-mobile.png',fullPage:true});
 await writeFile('test-artifacts/mobile-layout.json',JSON.stringify(await sales.evaluate(()=>({bodyClass:document.body.className,width:window.innerWidth,scroll:document.documentElement.scrollWidth,
  overflowing:[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>window.innerWidth).slice(0,15).map(node=>({tag:node.tagName,className:node.className,right:node.getBoundingClientRect().right}))})),null,2));
 assert.equal(await sales.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await sales.locator('[data-sales-stock-form] button[type="submit"]').click();
 await sales.locator('.regular-delivery-summary').filter({hasText:'SO-BROWSER-MANUAL'}).waitFor();
 const manualId=Number((await query("SELECT request_id FROM regular_stock_handoffs WHERE sales_order_ref='SO-BROWSER-MANUAL'")).rows[0].request_id);
 assert.match(await sales.locator('.regular-delivery-summary').innerText(),/Waiting for SCM approval/);assert.equal(writes,1);
 checks.push('150/12441 route waits for SCM; mobile form preserves entered values');
 const {page:scm}=await pageFor('scm');
 const manualBoundary=fixtures.get('SO-BROWSER-MANUAL'),confirmTransfer=manualBoundary.confirmTransfer;
 let printerBlocked=true;
 manualBoundary.confirmTransfer=async transfer=>{
  await confirmTransfer(transfer);
  if(printerBlocked){await query("UPDATE sales_stock_transfers SET confirmation_status='attention' WHERE id=$1",[transfer.id]);throw Error('Printer unavailable');}
 };
 await transport(scm,'scm');
 await scm.goto('http://127.0.0.1:3000/scm/stock-requests?tab=regular');
 await scm.locator(`[data-scm-stock-action="select"][data-id="${manualId}"]`).click();
 await scm.locator('[data-scm-stock-action="approve-stock"]').waitFor();
 assert.equal(await scm.locator('[data-scm-stock-action="approve-po"], [data-scm-stock-action="save-line"]').count(),0);
 assert.match(await scm.locator('.stock-request-detail').innerText(),/12441/);
 await scm.screenshot({path:'test-artifacts/delivery-scm-review.png',fullPage:true});
 await scm.locator('[data-scm-stock-action="approve-stock"]').click();
 await scm.locator('[data-scm-stock-action="confirm-decision"]').click();
 await scm.locator('.regular-delivery-result').waitFor();assert.equal(writes,2);
 checks.push('SCM approves the whole SO-based Delivery and automatically creates the TO');
 assert.match(await scm.locator('.regular-delivery-result').innerText(),/processing/);
 printerBlocked=false;
 await scm.locator('[data-scm-stock-action="delivery-retry"]').click();
 await scm.locator('.regular-delivery-result').filter({hasText:'Transfer Order created'}).waitFor();assert.equal(writes,2);
 checks.push('SCM printing retry reuses the committed TO and clears the attention state');
 const manualTransfer=(await getScmStockRequest(manualId)).transfers[0].id;
 await query("UPDATE scm_print_jobs SET status='printing' WHERE job_key=$1",[`browser:${run}:${manualTransfer}`]);
 await scm.locator('.regular-delivery-result').filter({hasText:'Printing TO'}).waitFor();
 await query("UPDATE scm_print_jobs SET status='printed' WHERE job_key=$1",[`browser:${run}:${manualTransfer}`]);
 await scm.locator('.regular-delivery-result').filter({hasText:'Printed'}).waitFor();
 checks.push('SCM refreshes actual printing and printed status without locking unrelated actions');
 // A failed SO lookup stays editable and retries without changing its value.
 await sales.setViewportSize({width:1440,height:1000});
 await sales.locator('[data-sales-stock-action="new"]').click();
 await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('1');
 held=new Promise(resolve=>{release=resolve;});failPreview=true;
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-RETRY');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
 assert.equal(await sales.locator('button:enabled,input:enabled,select:enabled,textarea:enabled').count(),0);
 await sales.evaluate(()=>{const button=document.createElement('button');button.id='dynamic-button';button.textContent='Temporary';document.body.append(button);});
 await sales.waitForFunction(()=>document.getElementById('dynamic-button').disabled);
 await sales.screenshot({path:'test-artifacts/delivery-busy.png',fullPage:true});
 release();held=null;
 await sales.locator('[data-sales-stock-action="delivery-preview-retry"]').waitFor();
 assert.equal(await sales.locator('#dynamic-button').isDisabled(),false);await sales.locator('#dynamic-button').evaluate(button=>button.remove());
 assert.equal(await sales.locator('[data-regular-field="salesOrderRef"]').inputValue(),'SO-BROWSER-RETRY');
 failPreview=false;dropAccept=true;
 await sales.locator('[data-sales-stock-action="delivery-preview-retry"]').click();
 await sales.locator('#regularStockDialogMessage').filter({hasText:'Reconnecting'}).waitFor();
 assert.equal(await sales.locator('button:enabled').count(),0);
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
 assert.equal(await sales.locator('[data-sales-stock-form] button[type="submit"]').isEnabled(),true);
 checks.push('Failed check retries unchanged SO; all existing and newly rendered controls disable then restore');
 // Failed remote creation is visible to Sales; dedicated retry uses saved SO.
 const retryFixture=fixtures.get('SO-BROWSER-RETRY'),originalConfirm=retryFixture.confirmTransfer;
 retryFixture.confirmTransfer=async()=>{throw Error('NetSuite create temporarily unavailable');};
 await sales.locator('[data-sales-stock-form] button[type="submit"]').click();
 await sales.locator('[data-sales-stock-action="delivery-retry"]').waitFor();
 assert.match(await sales.locator('.stock-request-detail').innerText(),/NetSuite create temporarily unavailable/);
 retryFixture.confirmTransfer=originalConfirm;
 const beforeWrites=writes;heldCreate=new Promise(resolve=>{releaseCreate=resolve;});
 await sales.locator('[data-sales-stock-action="delivery-retry"]').click();
 await sales.locator('#regularStockDialogMessage').filter({hasText:'Creating TO in NetSuite'}).waitFor();
 browserCoverage.push(...await sales.coverage.stopJSCoverage());await sales.coverage.startJSCoverage({resetOnNavigation:false});
 await sales.reload();await sales.locator('#regularStockDialogMessage').filter({hasText:'Creating TO in NetSuite'}).waitFor();
 releaseCreate();heldCreate=null;
 await sales.locator('.regular-delivery-result').filter({hasText:'Transfer Order created'}).waitFor();assert.equal(writes,beforeWrites+1);
 checks.push('Sales retry reuses the saved SO and creates exactly one TO');
 // Reload discovers the same persisted preview and retains its inputs.
 await sales.locator('[data-sales-stock-action="new"]').click();
 await sales.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('1');
 held=new Promise(resolve=>{release=resolve;});
 await sales.locator('[data-regular-field="salesOrderRef"]').fill('SO-BROWSER-RETRY');
 await sales.locator('[data-regular-field="salesOrderRef"]').blur();
 await sales.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
 browserCoverage.push(...await sales.coverage.stopJSCoverage());await sales.coverage.startJSCoverage({resetOnNavigation:false});
 await sales.reload();await sales.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
 assert.equal(await sales.locator('button:enabled').count(),0);release();held=null;
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
 assert.equal(await sales.locator('[data-regular-field="salesOrderRef"]').inputValue(),'SO-BROWSER-RETRY');
 checks.push('Reload reconnects to the saved operation and restores the preview inputs');
 // If the read fails after reload, keep the same form and make Retry available.
 held=new Promise(resolve=>{release=resolve;});failPreview=true;
 await sales.locator('[data-regular-field="sourceLocationId"]').selectOption('15');
 await sales.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
 browserCoverage.push(...await sales.coverage.stopJSCoverage());await sales.coverage.startJSCoverage({resetOnNavigation:false});
 await sales.reload();await sales.locator('#regularStockDialogMessage').filter({hasText:'Checking SO quantities'}).waitFor();
 release();held=null;
 await sales.locator('[data-sales-stock-action="delivery-preview-retry"]').waitFor();
 assert.equal(await sales.locator('[data-regular-field="salesOrderRef"]').inputValue(),'SO-BROWSER-RETRY');
 failPreview=false;await sales.locator('[data-sales-stock-action="delivery-preview-retry"]').click();
 await sales.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 2'}).waitFor();
 checks.push('Lost acceptance response resumes the same command; failed resumed preview retains inputs and Retry');
 const chinese=await sales.evaluate(()=>{
  const saved=window.MBBS_I18N.language;window.MBBS_I18N.language=()=> 'zh-CN';
  const html=window.RegularStockDelivery.composer({deliveryMethod:'delivery',destinationLocationId:28},[{locationId:28,yardCode:'2967'}],false);
  window.MBBS_I18N.language=saved;return html;
 });
 assert.match(chinese,/销售订单号/);assert.match(chinese,/基础货场/);assert.match(chinese,/目标货场/);checks.push('Chinese labels for the simplified Delivery form');
 browserCoverage.push(...await sales.coverage.stopJSCoverage(),...await scm.coverage.stopJSCoverage());
 await writeFile('test-artifacts/browser-coverage.json',JSON.stringify(browserCoverage));
 assert.deepEqual(errors,[]);await writeFile('test-artifacts/browser.json',JSON.stringify({checks,submissions:submissions.length,errors},null,2));
 console.log(JSON.stringify({checks:checks.length,errors}));
}catch(error){for(const context of browser.contexts())for(const page of context.pages())console.error((await page.locator('body').innerText()).slice(-5000));throw error;}finally{release?.();releaseCreate?.();await Promise.allSettled(workers);await browser.close();await new Promise(resolve=>server.close(resolve));await closeDb();}
