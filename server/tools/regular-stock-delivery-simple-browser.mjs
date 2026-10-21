import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {submitDeliveryStockRequest,decideDeliveryStockRequest,retryDeliveryStockRequest,previewDeliveryStockRequest} from '../src/regular-stock-delivery.js';
const itemId=9800000000123,run=randomUUID(),errors=[],checks=[];
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'DELIVERY BROWSER MATERIAL','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
for(const id of [1,28,15])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now()) ON CONFLICT DO NOTHING",[itemId,id,String(id)]);
const server=app.listen(3000,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const fixtures=new Map();let nextId=1500000000,writes=0;
function fixture(input){
 if(fixtures.has(input.salesOrderRef))return fixtures.get(input.salesOrderRef);
 const base=input.salesOrderRef==='SO-BROWSER-BASE-3445'?1:28;
 const order={id:++nextId,ref:input.salesOrderRef,locationId:15,lines:[{remoteLineId:1,itemId,quantity:200,backorderedQuantity:20,uom:'EA',locationId:base,open:true}]};
 const result={liveExecutionEnabled:true,readOrder:async()=>order,refreshAvailability:async()=>{await query('UPDATE inventory_balances SET quantity_available=$2 WHERE item_id=$1',[itemId,input.salesOrderRef==='SO-BROWSER-SHORTAGE'?10:input.salesOrderRef==='SO-BROWSER-FALLBACK'?50:1000]);},hydrateOrder:async()=>{},linkTransferDependency:async()=>{},
  confirmTransfer:async transfer=>{if(!transfer.netsuiteTransferOrderId)writes++;await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",[transfer.id,1600000000+transfer.id,`TO-BROWSER-${transfer.id}`]);}};
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
try{
 const {page:sales,actor:salesActor}=await pageFor('sales');
 const salesContext={operatorId:salesActor.id,authorizedDestinationLocationIds:[1,28]};
 const submissions=[];let manualId;
 await sales.route('**/api/sales/stock-requests/delivery/preview',async route=>{
  const input=route.request().postDataJSON();
  try{await route.fulfill({json:await previewDeliveryStockRequest(input,salesContext,fixture(input))});}
  catch(error){await route.fulfill({status:error.status||500,json:{error:error.message}});}
 });
 await sales.route('**/api/sales/stock-requests',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const input=route.request().postDataJSON();submissions.push(input);
  assert.deepEqual(Object.keys(input).sort(),['deliveryMethod','sourceLocationId','destinationLocationId','salesOrderRef'].sort());
  const saved=await submitDeliveryStockRequest(input,salesContext,fixture(input));
  if(input.salesOrderRef==='SO-BROWSER-MANUAL')manualId=saved.id;
  await route.fulfill({status:201,json:saved});
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
 await sales.locator('.regular-delivery-result').waitFor();
 assert.equal(writes,1);assert.match(await sales.locator('.regular-delivery-result').innerText(),/Transfer Order created/);
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
 assert.match(await sales.locator('.regular-delivery-summary').innerText(),/Waiting for SCM approval/);assert.equal(writes,1);
 checks.push('150/12441 route waits for SCM; mobile form preserves entered values');
 const {page:scm,actor:scmActor}=await pageFor('scm');
 const manualBoundary=fixtures.get('SO-BROWSER-MANUAL'),confirmTransfer=manualBoundary.confirmTransfer;
 let printerBlocked=true;
 manualBoundary.confirmTransfer=async transfer=>{
  await confirmTransfer(transfer);
  if(printerBlocked){await query("UPDATE sales_stock_transfers SET confirmation_status='attention' WHERE id=$1",[transfer.id]);throw Error('Printer unavailable');}
 };
 await scm.route('**/api/scm/stock-requests/*/line-decisions',async route=>{
  const id=Number(new URL(route.request().url()).pathname.split('/').at(-2));
  const result=await decideDeliveryStockRequest(id,route.request().postDataJSON(),{operatorId:scmActor.id},fixtures.get('SO-BROWSER-MANUAL'));
  await route.fulfill({json:result});
 });
 await scm.route('**/api/scm/stock-requests/*/delivery-retry',async route=>{
  const id=Number(new URL(route.request().url()).pathname.split('/').at(-2));
  const result=await retryDeliveryStockRequest(id,{operatorId:scmActor.id,authorizedDestinationLocationIds:[28]},manualBoundary);
  await route.fulfill({json:result});
 });
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
 const chinese=await sales.evaluate(()=>{
  const saved=window.MBBS_I18N.language;window.MBBS_I18N.language=()=> 'zh-CN';
  const html=window.RegularStockDelivery.composer({deliveryMethod:'delivery',destinationLocationId:28},[{locationId:28,yardCode:'2967'}],false);
  window.MBBS_I18N.language=saved;return html;
 });
 assert.match(chinese,/销售订单号/);assert.match(chinese,/基础货场/);assert.match(chinese,/目标货场/);checks.push('Chinese labels for the simplified Delivery form');
 const browserCoverage=[...await sales.coverage.stopJSCoverage(),...await scm.coverage.stopJSCoverage()];
 await writeFile('test-artifacts/browser-coverage.json',JSON.stringify(browserCoverage));
 assert.deepEqual(errors,[]);await writeFile('test-artifacts/browser.json',JSON.stringify({checks,submissions:submissions.length,errors},null,2));
 console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await closeDb();}
