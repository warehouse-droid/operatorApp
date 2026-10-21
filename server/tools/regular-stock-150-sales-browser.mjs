/* global localStorage, salesStockState, salesStockLoad */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {runDeliveryOperation} from '../src/regular-stock-delivery-operations.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const run=randomUUID(),itemId=9800000000282,password=randomUUID()+'-Browser-A1!';
const errors=[],checks=[],workers=new Set(),fixtures=new Map(),saved=[];
let writes=0,sequence=parseInt(run.replaceAll('-','').slice(0,10),16),token;
await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'150 BROWSER MATERIAL','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
for (const id of [1,28]) {
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000000,1000000,now()) ON CONFLICT DO NOTHING",[itemId,id,String(id)]);
}
const username='150-delivery-browser-'+run;
const actor=await createOperator({username,displayName:'150 Sales',password,role:'sales',roles:['sales'],yardLocationIds:[26]});
const server=app.listen(3000,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const login=await context.request.post('http://127.0.0.1:3000/api/auth/login',{data:{username,password}});
  assert.equal(login.status(),200);({token}=await login.json());
  await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  function fixture(input) {
    if (fixtures.has(input.salesOrderRef)) {return fixtures.get(input.salesOrderRef);}
    const destination=Number(input.salesOrderRef.split('-').at(-1));
    const order={id:++sequence,ref:input.salesOrderRef,locationId:26,
      lines:[{remoteLineId:1,itemId,quantity:100,backorderedQuantity:10,uom:'EA',locationId:destination,open:true}]};
    const dependencies={readOrder:async()=>structuredClone(order),refreshAvailability:async()=>{},liveExecutionEnabled:true,
      hydrateOrder:async()=>{},linkTransferDependency:async()=>{},confirmTransfer:async transfer=>{
        if (!transfer.netsuiteTransferOrderId) {writes++;}
        await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",
          [transfer.id,1800000000+transfer.id,'TO-150-BROWSER-'+transfer.id]);
      }};
    fixtures.set(input.salesOrderRef,dependencies);return dependencies;
  }
  await page.route('**/api/sales/stock-requests/delivery/operations',async route=>{
    const command=route.request().postDataJSON(),response=await route.fetch();
    await route.fulfill({response});
    if (response.status()!==202) {return;}
    const worker=runDeliveryOperation(command.operationId,fixture(command.input));workers.add(worker);
    worker.then(result=>console.log(JSON.stringify({action:command.action,resultId:result?.id,
      handoffStatus:result?.regular?.handoffStatus,error:result?.regular?.handoffError}))).finally(()=>workers.delete(worker));
  });
  await page.goto('http://127.0.0.1:3000/sales/stock-requests?tab=regular');
  await page.locator('[data-sales-stock-action="new"]').waitFor();
  await page.waitForFunction(()=>!salesStockState.loading && salesStockState.yards.length===1);
  assert.deepEqual(await page.evaluate(()=>salesStockState.yards.map(yard=>yard.locationId)),[26]);
  checks.push('Actual authenticated Sales account has only yard 150 assigned');
  for (const [source,destination] of [[1,28],[28,1]]) {
    await page.locator('[data-sales-stock-action="new"]').click();
    await page.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
    const reference='SO-150-BROWSER-'+run+'-'+destination;
    await page.locator('[data-regular-field="salesOrderRef"]').fill(reference);
    await page.locator('[data-regular-field="salesOrderRef"]').blur();
    await page.waitForFunction(expected=>document.querySelector('[data-delivery-base]')?.value===expected,destination===1?'3445':'2967');
    await page.evaluate(()=>salesStockLoad({preserveSelection:true}));
    assert.equal(await page.evaluate(()=>Number(salesStockState.composer.destinationLocationId)),destination);
    assert.equal(await page.locator('[data-delivery-base]').inputValue(),destination===1?'3445':'2967');
    checks.push(`SO Base Yard ${destination} survives a list refresh request before selecting Target Yard`);
    await page.locator('[data-regular-field="sourceLocationId"]').selectOption(String(source));
    await page.locator('[data-delivery-calculation]').filter({hasText:'PALLET: 1'}).waitFor();
    if (destination===1) {
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    }
    assert.equal(await page.locator('[data-sales-stock-form] button[type="submit"]').isDisabled(),false);
    await page.locator('[data-sales-stock-form] button[type="submit"]').click();
    await page.locator('.regular-delivery-result').filter({hasText:'Transfer Order created'}).waitFor();
    const id=await page.evaluate(()=>salesStockState.selectedId);saved.push(id);
    assert.equal(await page.evaluate(()=>salesStockState.detail.regular.approval.automatic),true);
    assert.equal(await page.evaluate(()=>salesStockState.detail.transfers.length),1);
    await page.reload();
    // The existing page restores the tab last selected with its navigation buttons.
    await page.locator('[data-sales-stock-action="bucket"][data-bucket="accepted"]').click();
    await page.locator('.regular-delivery-result').filter({hasText:'Transfer Order created'}).waitFor();
    assert.equal(await page.evaluate(()=>salesStockState.selectedId),id);
    checks.push(`150-only Sales submits ${source} → ${destination} and retains access after reloading`);
    if (destination===28) {
      await page.locator('[data-sales-stock-action="new"]').click();
      await page.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
      await page.locator('[data-regular-field="salesOrderRef"]').fill(reference);
      await page.locator('[data-regular-field="salesOrderRef"]').blur();
      await page.waitForFunction(()=>document.querySelector('[data-delivery-base]')?.value==='2967');
      for (const method of ['pickup','stocking']) {
        await page.locator('[data-regular-field="deliveryMethod"]').selectOption(method);
        assert.equal(await page.locator('[data-sales-stock-destination]').inputValue(),'26');
      }
      await page.locator('[data-sales-stock-action="close-composer"]').click();
      checks.push('Changing from Delivery to Pickup or Stocking restores the assigned destination 150');
    }
  }
  assert.equal(writes,2);
  await page.screenshot({path:'test-artifacts/150-sales-delivery-mobile.png',fullPage:true});
  const coverage=await page.coverage.stopJSCoverage();
  await writeFile('test-artifacts/browser-coverage.json',JSON.stringify(coverage));
  assert.deepEqual(errors,[]);
  // End the UI session before revoking access so background refreshes stop.
  await page.close();
  await query('UPDATE operators SET yard_location_ids=ARRAY[15] WHERE id=$1',[actor.id]);
  const revoked=await context.request.get('http://127.0.0.1:3000/api/sales/stock-requests/'+saved[0],{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(revoked.status(),403);checks.push('Removing 150 access blocks an actual authenticated HTTP request');
  await writeFile('test-artifacts/browser.json',JSON.stringify({checks,pageErrors:errors,transfers:writes},null,2));
  console.log(JSON.stringify({checks:checks.length,pageErrors:errors.length,transfers:writes}));
} catch (error) {
  const failedPage=browser.contexts()[0]?.pages()[0];
  if (failedPage) {
    await writeFile('test-artifacts/browser-failure.json',JSON.stringify(await failedPage.evaluate(()=>({
      text:document.body.innerText,state:{yards:salesStockState.yards,bucket:salesStockState.bucket,selectedId:salesStockState.selectedId,
        composer:salesStockState.composer,detail:salesStockState.detail,error:salesStockState.error}})),null,2));
    await failedPage.screenshot({path:'test-artifacts/browser-failure.png',fullPage:true});
    const operations=(await query("SELECT action,status,phase,result->>'bucket' AS bucket,result->'regular' AS regular,error FROM regular_stock_delivery_operations WHERE actor_id=$1",[actor.id])).rows;
    const response=await browser.contexts()[0].request.get('http://127.0.0.1:3000/api/sales/stock-requests?bucket=accepted',{headers:{Authorization:`Bearer ${token}`}});
    const list=await response.json();
    console.log(JSON.stringify({operations:operations.map(row=>({action:row.action,status:row.status,error:row.error,bucket:row.bucket})),
      listStatus:response.status(),requests:list.requests?.map(row=>({id:row.id,bucket:row.bucket,destinationLocationId:row.destinationLocationId}))}));
  }
  throw error;
} finally {
  await Promise.allSettled([...workers]);await browser.close();
  await new Promise(resolve=>server.close(resolve));await closeDb();
}
