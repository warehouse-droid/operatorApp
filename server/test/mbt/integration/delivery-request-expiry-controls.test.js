/* global localStorage, getComputedStyle, window */
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {chromium,expect} from '@playwright/test';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {createDeliveryRequestService} from '../../../src/delivery-request-repository.js';
import {createDeliveryRequestRouter} from '../../../src/delivery-request-router.js';
import {seedDeliveryRates} from '../support/delivery-request-database.js';
import {pricing,window as slot,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';

let service,server,base,browser,now;
const events=[];
const actors={sales,dispatch:dispatcher,other:{...sales,id:'expiry-other',yardLocationIds:[28]},public:{...sales,publicSales:true},
  yardDispatch:{...dispatcher,id:'expiry-yard-dispatch',yardLocationIds:[28]}};
const command=(row,fields={})=>({expectedRevision:row.revision,operationId:crypto.randomUUID(),...fields});
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');await seedDeliveryRates();
  for(const actor of Object.values(actors)) {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$1,$1,'test','test',$2,ARRAY[$2]::text[],true) ON CONFLICT(id) DO NOTHING`,[actor.id,actor.role]);
  }
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
    VALUES(98708161,'SOEXPIRY1',current_date,'Expiry test','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`);
  service=createDeliveryRequestService({now:()=>new Date(now),emit:event=>events.push(event),
    resolveDistance:async()=>({providerMetres:20000,routeHash:'expiry-fixture',originSnapshot:{},destinationSnapshot:{}})});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator=actors[req.headers['x-test-actor'] || req.headers.authorization?.replace('Bearer ','')];next();});
  app.get('/api/auth/me',(req,res)=>res.json({operator:req.operator}));
  for(const audience of ['sales','dispatch']) {
    app.use(`/api/${audience}/delivery-requests`,createDeliveryRequestRouter({service,audience}));
    app.get(`/${audience}/delivery-requests`,(_req,res)=>res.sendFile(new URL('../../../public/delivery-requests.html',import.meta.url).pathname));
  }
  app.use(express.static(new URL('../../../public',import.meta.url).pathname));
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({code:error.code,error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(async()=>{now=clock.now;await query('TRUNCATE delivery_requests CASCADE');events.length=0;});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server){await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function submit() {
  const input=pricing(),quote=await service.quote(input,sales);
  return service.create({...input,requestedWindow:slot(),quoteId:quote.id,operationId:crypto.randomUUID()},sales);
}
async function act(row,action,fields={},actor='dispatch',audience=actor) {
  const response=await fetch(`${base}/api/${audience}/delivery-requests/${row.id}/actions/${action}`,{
    method:'POST',headers:{'Content-Type':'application/json','x-test-actor':actor},body:JSON.stringify(command(row,fields))});
  return {status:response.status,data:await response.json()};
}
async function approve(row=undefined) {return (await act(row || await submit(),'confirm')).data;}
async function pageFor(row,audience='dispatch',width=1200) {
  await service.markRead(row.id,row.revision,actors[audience],audience);
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),audience);
  const page=await context.newPage();page.setDefaultTimeout(5000);
  await page.clock.install({time:new Date(clock.now)});
  if(process.env.DELIVERY_UI_COVERAGE==='1') {
    await page.coverage.startJSCoverage();const close=context.close.bind(context);
    context.close=async()=>{
      const {writeFile}=await import('node:fs/promises');
      await writeFile(`test-artifacts/expiry-browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await close();
    };
  }
  await page.goto(`${base}/${audience}/delivery-requests?request=${row.id}`);
  await expect(page.locator('[data-detail] h2')).toHaveText(row.requestRef);
  return {page,context};
}
test('expiry HTTP: override and update persist only this request and notify Sales once',async()=>{
  const row=await submit(),other=await approve();
  const settings=await service.options(dispatcher,'dispatch');
  let result=await act(row,'confirm',{expiryTime:'530pm'});assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.approvalExpiresAt,'2028-10-01T21:30:00.000Z');
  const original=result.data,operationId=crypto.randomUUID();
  result=await act(original,'set-expiry',{expiryTime:'6pm',operationId});assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.approvalExpiresAt,'2028-10-01T22:00:00.000Z');
  assert.equal(result.data.lastActorId,dispatcher.id);assert.equal(result.data.history[0].actorName,dispatcher.id);assert.match(result.data.history[0].message,/expiry|deadline/i);
  assert.deepEqual(result.data.quote,original.quote);assert.deepEqual(result.data.confirmedWindow,original.confirmedWindow);
  assert.equal((await act(original,'set-expiry',{expiryTime:'6pm',operationId})).data.revision,result.data.revision);
  assert.equal((await service.get(other.id,dispatcher,'dispatch')).approvalExpiresAt,other.approvalExpiresAt);
  assert.deepEqual((await service.options(dispatcher,'dispatch')).settings,settings.settings);
  assert.equal((await service.alerts(sales,'sales')).requests.find(item=>item.id===row.id).action,'set-expiry');
});
test('expiry HTTP: authorization, invalid input, stale revisions and late extension cannot mutate requests',async()=>{
  const row=await approve();
  for(const [actor,audience] of [['sales','sales'],['public','sales'],['other','sales']]) {
    for(const action of ['expire','set-expiry']) {assert.equal((await act(row,action,{expiryTime:'5pm'},actor,audience)).status,403);}
  }
  for(const expiryTime of [null,{},'25pm','garbage','x'.repeat(5000)]) {assert.equal((await act(row,'set-expiry',{expiryTime})).status,400);}
  assert.equal((await act(row,'expire',{expectedRevision:0})).data.code,'DELIVERY_STALE_REVISION');
  assert.equal((await service.get(row.id,dispatcher,'dispatch')).revision,row.revision);
  now=row.approvalExpiresAt;
  assert.equal((await act(row,'set-expiry',{expiryTime:'5pm'})).data.code,'DELIVERY_APPROVAL_EXPIRED');
  assert.equal((await service.get(row.id,sales,'sales')).status,'expired');
});
test('manual expiry HTTP: rollback, idempotency, audit, Sales alert and scheduler do not duplicate expiry',async()=>{
  const row=await approve(),input=command(row),count=events.length;
  await withTransaction(()=>service.act(row.id,'expire',input,dispatcher,'dispatch'),{rollback:true});
  assert.equal((await service.get(row.id,sales,'sales')).status,'preapproved');assert.equal(events.length,count);
  const expired=await service.act(row.id,'expire',input,dispatcher,'dispatch');
  assert.equal(expired.status,'expired');assert.equal(expired.lastActorId,dispatcher.id);assert.equal(expired.history[0].actorName,dispatcher.id);assert.match(expired.history[0].message,/manually expired/i);
  assert.equal((await service.act(row.id,'expire',input,dispatcher,'dispatch')).revision,expired.revision);
  assert.equal(events.length,count+1);assert.equal((await service.alerts(sales,'sales')).requests.find(item=>item.id===row.id).action,'expire');
  now='2028-10-02T12:00Z';await service.tick();
  const saved=await service.get(row.id,sales,'sales');assert.equal(saved.history.filter(event=>event.action==='expire').length,1);
  assert.equal(saved.conversation.length,0);
});
test('expiry races: secure versus expire or deadline update has exactly one winner and consistent order links',async()=>{
  for(const action of ['expire','set-expiry']) {
    const row=await approve(),results=await Promise.all([
      act(row,action,{expiryTime:'5pm'}),act(row,'secure',{salesOrderRefs:['SOEXPIRY1']},'sales')]);
    assert.equal(results.filter(result=>result.status===200).length,1);
    assert.equal(results.find(result=>result.status!==200).data.code,'DELIVERY_STALE_REVISION');
    const saved=await service.get(row.id,sales,'sales');assert.equal(saved.revision,row.revision+1);
    const links=await query('SELECT order_ref FROM delivery_request_sales_orders WHERE request_id=$1',[row.id]);
    assert.equal(links.rowCount,saved.status==='confirmed'?1:0);
  }
});
test('expiry UI: free type formats on change beside preapproval and saves the same deadline',async()=>{
  const row=await submit(),{page,context}=await pageFor(row);
  try {
    const field=page.getByLabel('Override expiry');await expect(field).toHaveAttribute('type','text');
    const button=page.getByRole('button',{name:'OK — preapprove',exact:true});
    const left=await button.boundingBox(),right=await field.boundingBox();assert.ok(right.x>left.x);assert.ok(Math.abs(right.y-left.y)<40);
    for(const value of ['530pm','17:30','until 5:30 PM']) {await field.fill(value);await field.press('Tab');await expect(field).toHaveValue('until 05:30 pm');}
    await field.fill('25pm');await field.press('Tab');await button.click();
    assert.equal((await service.get(row.id,sales,'sales')).status,'submitted');await expect(field).toHaveAttribute('aria-invalid','true');
    await field.fill('530pm');await button.click();await expect(page.locator('[data-approval-clock]')).toContainText('5:30');
    assert.equal((await service.get(row.id,sales,'sales')).approvalExpiresAt,'2028-10-01T21:30:00.000Z');
    await page.getByLabel('Override expiry').fill('6pm');await page.getByRole('button',{name:'Save expiry',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('6:00');
    await page.screenshot({path:'test-artifacts/expiry-controls-desktop.png',fullPage:true});
  } finally {await context.close();}
});
test('expiry UI: proposal uses the override and blank approval retains the default on mobile',async()=>{
  const row=await submit(),{page,context}=await pageFor(row,'dispatch',390);
  try {
    await page.getByLabel('Override expiry').fill('5pm');
    await page.getByRole('button',{name:'Propose another time',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('5:00');
    assert.equal((await service.get(row.id,sales,'sales')).status,'proposed');
    const second=await submit();await service.markRead(second.id,second.revision,dispatcher,'dispatch');await page.goto(`${base}/dispatch/delivery-requests?request=${second.id}`);
    await page.getByRole('button',{name:'OK — preapprove',exact:true}).click();
    await expect(page.locator('[data-approval-clock]')).toContainText('11:00');
    assert.equal((await service.get(second.id,sales,'sales')).approvalExpiresAt,'2028-10-01T15:00:00.000Z');
    await page.screenshot({path:'test-artifacts/expiry-controls-mobile.png',fullPage:true});
  } finally {await context.close();}
});
test('manual expiry UI: red button warns; cancel and Escape preserve request; confirmation expires',async()=>{
  const row=await approve(),{page,context}=await pageFor(row);
  try {
    const button=page.getByRole('button',{name:'Expire request',exact:true});
    assert.equal(await button.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(185, 28, 28)');
    await button.click();const dialog=page.getByRole('dialog',{name:'Expire request?'});
    await expect(dialog).toContainText(row.requestRef);await expect(dialog).toContainText('re-raise');
    await dialog.getByRole('button',{name:'Keep request',exact:true}).click();await expect(dialog).toHaveCount(0);
    assert.equal((await service.get(row.id,sales,'sales')).status,'preapproved');
    await button.click();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    assert.equal((await service.get(row.id,sales,'sales')).status,'preapproved');
    await button.click();await page.screenshot({path:'test-artifacts/expiry-warning.png'});
    await dialog.getByRole('button',{name:'Expire now',exact:true}).click();await expect(page.locator('[data-detail] > p').first()).toHaveText('Expired');
    assert.equal((await service.get(row.id,sales,'sales')).status,'expired');await expect(button).toHaveCount(0);
  } finally {await context.close();}
});
test('expiry UI: Sales and secured requests never offer expiry controls',async()=>{
  const row=await approve();
  for(const audience of ['sales','dispatch']) {
    if(audience==='dispatch') {await act(row,'secure',{salesOrderRefs:['SOEXPIRY1']},'sales');}
    const {page,context}=await pageFor(row,audience);
    try {await expect(page.getByLabel('Override expiry')).toHaveCount(0);await expect(page.getByRole('button',{name:'Expire request',exact:true})).toHaveCount(0);}
    finally {await context.close();}
  }
});
test('expiry alerts: Sales sees the new deadline and manual expiry while the request is open',async()=>{
  const row=await approve(),{page,context}=await pageFor(row,'sales');
  try {
    await page.waitForFunction(()=>Boolean(window.MBBSDeliveryRequestAlerts));
    const updated=await act(row,'set-expiry',{expiryTime:'6pm'});assert.equal(updated.status,200);
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    const dialog=page.locator('.delivery-request-dialog');
    await expect(dialog).toContainText('Dispatch changed the approval deadline');await expect(dialog).toContainText('6:00');
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal((await act(updated.data,'expire')).status,200);
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(dialog).toContainText('Delivery approval expired');await expect(dialog).toContainText('re-raise');
  } finally {await context.close();}
});
