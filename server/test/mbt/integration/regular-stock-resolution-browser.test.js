/* global localStorage, document, window, Event, scmStockState */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {chooseRegularStatuses} from '../../support/regular-stock-status-browser.mjs';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';

const run=randomUUID(),out='test-artifacts/regular-stock-resolve-20261002/browser',actors={},tokens={};
const fixturePassword=randomUUID()+'-Resolve-A1!';
const itemId=9800000000111,poId=9800000000111,poRef=`RESOLVE-UI-${run.slice(0,8)}`;
let server,base,browser,capture=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  await mkdir(out,{recursive:true});
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'Resolve browser material','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,destination_location_id,status_text) VALUES($1,$2,true,28,'Pending Receipt') ON CONFLICT(netsuite_id) DO UPDATE SET tranid=EXCLUDED.tranid,netsuite_active=true",[poId,poRef]);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const role of ['sales','scm']){
    const username=`resolve-ui-${role}-${run}`;await createOperator({username,displayName:username,password:fixturePassword,role,roles:[role],yardLocationIds:role==='sales'?[28]:[]});
    actors[role]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0];
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:fixturePassword})});assert.equal(login.status,200);tokens[role]=(await login.json()).token;
  }
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
async function fixture(type='transfer',width=1440){
  const record=await submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'stocking',stockingType:type,
    lines:[{itemId,...(type==='purchase'?{}:{sourceLocationId:1}),pieces:20}]},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[28],allowOverAvailability:true},
  {refreshAvailability:async()=>{},loadPolicies:async()=>[],loadPurchaseStock:async()=>({onHand:1000,available:1000,preferredStock:1000})});
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(token=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.scm.stockRequests.queue','request');},tokens.scm);
  const page=await context.newPage(),errors=[],posts=[];page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/resolve'))posts.push(request.postDataJSON());});
  await page.goto(base+'/scm/stock-requests?tab=regular&review=1');
  await page.locator(`[data-scm-stock-action=select][data-id="${record.id}"]`).click();
  await expect(page.locator('[data-scm-stock-action=resolve]')).toBeVisible();
  return {page,context,record,errors,posts,close:async()=>{assert.deepEqual(errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}

test('desktop and phone Resolve require PO and ETA, retain the reply through refresh, and close both Stocking types',async()=>{
  for(const [type,width] of [['transfer',1440],['purchase',390]]){
    const {page,record,posts,close}=await fixture(type,width);try{
      await page.locator('[data-scm-stock-action=resolve]').click();
      const form=page.locator('[data-regular-resolution-form]'),po=form.getByLabel('Existing PO number',{exact:true}),eta=form.getByLabel('ETA',{exact:true});
      await form.getByRole('button',{name:'Resolve material',exact:true}).click();assert.equal(posts.length,0);
      await po.fill(poRef);await form.getByRole('button',{name:'Resolve material',exact:true}).click();assert.equal(posts.length,0);
      await eta.fill('2026-10-15');await po.focus();await page.evaluate(()=>window.dispatchEvent(new Event('mbbs-language-changed')));
      await expect(po).toHaveValue(poRef);await expect(po).toBeFocused();
      await page.locator('[data-scm-stock-action=refresh]').click();await expect.poll(()=>page.evaluate(()=>scmStockState.loading)).toBe(false);await expect(po).toHaveValue(poRef);await expect(eta).toHaveValue('2026-10-15');
      await form.screenshot({path:`${out}/resolve-${width}.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
      await po.press('Enter');await expect(form).toHaveCount(0);
      await chooseRegularStatuses(page,'scm','completed');
      await expect(page.getByRole('heading',{name:record.requestRef,exact:true})).toBeVisible();
      await expect(page.locator('[data-regular-resolution-result]')).toContainText(poRef);
      await expect(page.locator('[data-regular-resolution-result]')).toContainText('2026-10-15');await expect(page.locator('[data-scm-stock-action=resolve]')).toHaveCount(0);
      assert.deepEqual(posts,[{lineId:record.lines[0].id,expectedRevision:record.revision,purchaseOrderRef:poRef,eta:'2026-10-15'}]);
      const saved=(await query('SELECT status,regular_details FROM sales_stock_requests WHERE id=$1',[record.id])).rows[0];assert.equal(saved.status,'completed');assert.equal(saved.regular_details.resolution.purchaseOrderRef,poRef);
    }finally{await close();}
  }
});

test('unknown PO errors retain entered PO/ETA, and Cancel does not close the case',async()=>{
  const {page,record,posts,close}=await fixture();try{
    await page.locator('[data-scm-stock-action=resolve]').click();const form=page.locator('[data-regular-resolution-form]');
    await form.getByLabel('Existing PO number',{exact:true}).fill('UNKNOWN-RESOLVE-PO');await form.getByLabel('ETA',{exact:true}).fill('2026-10-15');
    await form.getByRole('button',{name:'Resolve material',exact:true}).click();
    await expect(page.locator('.stock-request-feedback .stock-request-error')).toContainText('PO');
    await expect(form.getByLabel('Existing PO number',{exact:true})).toHaveValue('UNKNOWN-RESOLVE-PO');await expect(form.getByLabel('ETA',{exact:true})).toHaveValue('2026-10-15');
    await form.getByRole('button',{name:'Cancel',exact:true}).click();await expect(form).toHaveCount(0);assert.equal(posts.length,1);
    assert.equal((await query('SELECT status FROM sales_stock_requests WHERE id=$1',[record.id])).rows[0].status,'submitted');
  }finally{await close();}
});

test('changing unified statuses discards an unfinished Resolve reply without submitting or closing the case',async()=>{
  const {page,record,posts,close}=await fixture();try{
    await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==='/api/scm/stock-requests'&&new URL(response.url()).searchParams.get('search')===record.requestRef),
      page.locator('[data-scm-stock-search]').fill(record.requestRef)
    ]);
    await page.locator('[data-scm-stock-action=resolve]').click();
    const form=page.locator('[data-regular-resolution-form]');
    await form.getByLabel('Existing PO number',{exact:true}).fill(poRef);
    await form.getByLabel('ETA',{exact:true}).fill('2026-10-15');
    await chooseRegularStatuses(page,'scm','closed');
    await expect(form).toHaveCount(0);
    await expect(page.locator('.stock-request-list')).not.toContainText(record.requestRef);
    await chooseRegularStatuses(page,'scm','active');
    await expect(page.getByRole('heading',{name:record.requestRef,exact:true})).toBeVisible();
    await chooseRegularStatuses(page,'scm','pending_scm');
    await expect(page.getByRole('heading',{name:record.requestRef,exact:true})).toBeVisible();
    await expect(form).toHaveCount(0);
    await page.locator('[data-scm-stock-action=resolve]').click();
    await expect(form.getByLabel('Existing PO number',{exact:true})).toHaveValue('');
    await expect(form.getByLabel('ETA',{exact:true})).toHaveValue('');
    assert.equal(posts.length,0);
    assert.equal((await query('SELECT status FROM sales_stock_requests WHERE id=$1',[record.id])).rows[0].status,'submitted');
  }finally{await close();}
});

test('Sales notification opens the resolved case and its PO/ETA once, and remains dismissed after refresh',async()=>{
  const {page,context,record,close}=await fixture('purchase');try{
    await page.locator('[data-scm-stock-action=resolve]').click();const form=page.locator('[data-regular-resolution-form]');
    await form.getByLabel('Existing PO number',{exact:true}).fill(poRef);await form.getByLabel('ETA',{exact:true}).fill('2026-10-15');
    await form.getByRole('button',{name:'Resolve material',exact:true}).click();await expect(form).toHaveCount(0);
    const salesContext=await browser.newContext({viewport:{width:1440,height:1000}});
    try{
      await salesContext.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),tokens.sales);
      const sales=await salesContext.newPage();sales.setDefaultTimeout(8000);await sales.goto(base+'/sales');
      await sales.evaluate(()=>window.MBBSRegularStockAlert.refresh());
      const alert=sales.locator('.regular-stock-alert[data-audience=sales]');await expect(alert).toBeVisible();
      await expect(alert).toHaveAttribute('href',`/sales/stock-requests?tab=regular&requestId=${record.id}`);
      const popup=sales.locator('dialog.regular-stock-popup');await expect(popup).toBeVisible();await expect(popup).toContainText(poRef);await expect(popup).toContainText('2026-10-15');
      const notifications=await context.request.get(base+'/api/sales/stock-requests/alerts',{headers:{Authorization:`Bearer ${tokens.sales}`}});
      const pending=(await notifications.json()).requests.filter(row=>['reply','resolve'].includes(row.action)).length;
      for(let index=0;index<pending;index++)await popup.getByRole('button',{name:'Close',exact:true}).click();
      await expect(popup).toHaveCount(0);await alert.click();
      await expect(sales.locator('[data-regular-resolution-result]')).toContainText(poRef);await expect(sales.locator('[data-regular-resolution-result]')).toContainText('2026-10-15');
      await expect.poll(async()=>Number((await query('SELECT event_id FROM regular_stock_decision_reads WHERE request_id=$1 AND operator_id=$2',[record.id,actors.sales.id])).rows[0]?.event_id||0)).toBeGreaterThan(0);
      await sales.reload();await expect(sales.locator('[data-regular-resolution-result]')).toContainText(poRef);
      const unread=await context.request.get(base+'/api/sales/stock-requests/alerts',{headers:{Authorization:`Bearer ${tokens.sales}`}});
      assert.ok(!(await unread.json()).requests.some(row=>row.id===record.id));
    }finally{await salesContext.close();}
  }finally{await close();}
});
