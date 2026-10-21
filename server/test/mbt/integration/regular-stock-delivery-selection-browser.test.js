/* global localStorage, sessionStorage, window, salesStockState */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {enqueueDeliveryOperation,runDeliveryOperation,getDeliveryOperation} from '../../../src/regular-stock-delivery-operations.js';

const run=randomUUID(),password=randomUUID()+'-Selection-A1!',itemId=9800000000291;
const out='test-artifacts/delivery-yard-access-20261007/browser';
const actors={},tokens={};
let server,base,browser,sequence=parseInt(run.replaceAll('-','').slice(0,10),16);
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await mkdir(out,{recursive:true});
  for(const yard of [15,0]) actors[yard]=await createOperator({username:'selection-browser-'+yard+'-'+run,displayName:'Selection fixture '+yard,password,role:'sales',roles:['sales'],yardLocationIds:yard===0?[]:[yard]});
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'Selection material','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',1000000,1000000,now()) ON CONFLICT DO NOTHING",[itemId]);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const yard of [15,0]) {const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:actors[yard].username,password})});assert.equal(login.status,200);tokens[yard]=(await login.json()).token;}
  browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});

test('browser can uncheck either backordered line, recalculate and submit only the checked line on desktop and mobile',async()=>{
  for(const width of [1440,390]) {
    const yard=width===1440?15:0,actor=actors[yard],token=tokens[yard];
    const id=++sequence,ref='SOA09883-FIXTURE-'+id,commands=[],errors=[];
    const order={id,ref,locationId:1,lines:[
      {remoteLineId:11,itemId,itemName:'First backordered line',quantity:100,backorderedQuantity:10,uom:'EA',locationId:1,open:true},
      {remoteLineId:22,itemId,itemName:'Second backordered line',quantity:200,backorderedQuantity:20,uom:'EA',locationId:1,open:true}
    ]};
    const dependencies={readOrder:async()=>structuredClone(order),refreshAvailability:async()=>{},liveExecutionEnabled:true,
      hydrateOrder:async()=>{},linkTransferDependency:async()=>{},confirmTransfer:async transfer=>{await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",[transfer.id,1900000000+transfer.id,'TO-SELECT-'+transfer.id]);}};
    const ctx={operatorId:actor.id,audience:'sales',authorizedDestinationLocationIds:yard===0?[]:[yard]};
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
    await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    // Inject only external order/inventory/printing boundaries; real operation,
    // authorization, selection, database and transfer logic execute unchanged.
    await page.route('**/api/sales/stock-requests/delivery/operations',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const command=route.request().postDataJSON();commands.push(command);
      try{
        const op=await enqueueDeliveryOperation(command,ctx);await runDeliveryOperation(op.id,dependencies);
        await route.fulfill({status:200,json:await getDeliveryOperation(op.id,ctx)});
      }catch(error){await route.fulfill({status:error.status||500,json:{error:error.message,code:error.code}});}
    });
    try{
      await page.goto(base+'/sales/stock-requests?tab=regular');
      await page.locator('[data-sales-stock-action="new"]').click();
      await page.locator('[data-regular-field="deliveryMethod"]').selectOption('delivery');
      await page.locator('[data-regular-field="sourceLocationId"]').selectOption('28');
      await page.locator('[data-regular-field="salesOrderRef"]').fill(ref);
      await page.locator('[data-regular-field="salesOrderRef"]').blur();
      const first=page.locator('[data-delivery-line-id="11"]'),second=page.locator('[data-delivery-line-id="22"]');
      await expect(first).toBeChecked();await expect(second).toBeChecked();
      await expect(page.locator('[data-delivery-calculation]')).toContainText('PALLET: 3');
      await first.uncheck();await expect(first).not.toBeChecked();await expect(second).toBeChecked();
      await expect(page.locator('[data-delivery-calculation]')).toContainText('PALLET: 2');
      const pending={operationId:randomUUID(),action:'preview',input:{salesOrderRef:ref,sourceLocationId:'28',selectedRemoteLineIds:[22]},requestId:null};
      await page.evaluate(({pending,actorId})=>{
        const signature=JSON.stringify({action:pending.action,input:pending.input,requestId:pending.requestId});
        sessionStorage.setItem('mbbs.regularDelivery.operation.sales.'+actorId,JSON.stringify({command:pending,signature}));
      },{pending,actorId:actor.id});
      await page.reload();await expect(first).not.toBeChecked();await expect(second).toBeChecked();
      await expect(page.locator('[data-delivery-calculation]')).toContainText('PALLET: 2');
      const commandCount=commands.length;
      await page.evaluate(()=>window.RegularStockDelivery.selectLine(salesStockState.composer,999,false,()=>{throw Error('Forged checkbox must not call API');},()=>{}));
      assert.equal(commands.length,commandCount);await expect(second).toBeChecked();
      await second.uncheck();await expect(page.locator('[data-sales-stock-form] button[type="submit"]')).toBeDisabled();
      await second.check();await expect(page.locator('[data-delivery-calculation]')).toContainText('PALLET: 2');
      await expect(page.locator('[data-sales-stock-form] button[type="submit"]')).toBeEnabled();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
      await page.screenshot({path:out+'/selection-'+width+'.png',fullPage:true});
      await page.locator('[data-sales-stock-form] button[type="submit"]').click();
      await expect(page.locator('.regular-delivery-result')).toContainText('Transfer Order created');
      const submitted=commands.filter(command=>command.action==='submit');assert.equal(submitted.length,1);
      assert.deepEqual(submitted[0].input.selectedRemoteLineIds,[22]);
      const saved=(await query('SELECT request_id,plan FROM regular_stock_handoffs WHERE sales_order_id=$1',[id])).rows[0];
      assert.deepEqual(saved.plan.materialLineIds,[22]);
      assert.deepEqual((await query('SELECT sales_qty FROM sales_stock_request_lines WHERE request_id=$1',[saved.request_id])).rows.map(row=>Number(row.sales_qty)),[200]);
      assert.deepEqual(errors,[]);
      const coverage=await page.coverage.stopJSCoverage();
      await writeFile(out+'/coverage-'+width+'.json',JSON.stringify(coverage.filter(entry=>/regular-stock-delivery\.js|sales-stock-requests\.js/.test(entry.url))));
    }finally{await context.close();}
  }
});
