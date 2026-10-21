import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {chooseRegularStatuses} from '../../support/regular-stock-status-browser.mjs';
let f,browser,sequence=0;const ids=[],out='test-artifacts/already-ordered-arrival-20261020';
before(async()=>{f=await fixture({sku:88999552});mkdirSync(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();if(f){await f.query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[ids]);await f.close();}});
async function ordered(){
  const id=8899956000+(++sequence),ref='TEST-ARRIVAL-UI-'+id;ids.push(id);
  await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text) VALUES($1,$2,true,'Pending Receipt')",[id,ref]);
  return {d:await f.ordered(await f.create(1),0,{poNumber:ref}),id,ref};
}
async function open(role,d,width=1440){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.goto(`${f.base}/${role}/stock-requests?tab=regular&requestId=${d.id}`);
  await expect(page.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(d.id));
  return {page,async close(){
    const coverage=await page.coverage.stopJSCoverage(),key=`${role}-${++sequence}`;
    writeFileSync(`${out}/${key}-browser.json`,JSON.stringify(coverage));
    if(process.env.NODE_V8_COVERAGE)writeFileSync(`${process.env.NODE_V8_COVERAGE}/arrival-${key}.json`,JSON.stringify({result:coverage.filter(row=>row.url.startsWith(f.base)).map(row=>({...row,url:'file:///app/public'+new URL(row.url).pathname}))}));
    await context.close();assert.deepEqual(errors,[]);
  }};
}
test('Sales replaces the quotation with an SO on mobile; Completed and Waiting for arrival persist in both queues',async()=>{
  const {d}=await ordered(),ui=await open('sales',d,390);
  try{
    const p=ui.page,detail=p.locator('[data-backorder-detail]'),form=detail.locator('[data-action="already-ordered/sales-order"]');
    await expect(form).toBeVisible();await expect(detail.locator('[name="quotationNumber"]')).toHaveCount(0);
    await form.getByLabel('Sales order number',{exact:true}).fill('SO-ARRIVAL-UI');
    await form.getByRole('button',{name:'Save sales order number',exact:true}).click();
    await expect(detail).toContainText('Waiting for arrival');await expect(detail).toContainText('Completed');
    await p.reload();await expect(form.getByLabel('Sales order number',{exact:true})).toHaveValue('SO-ARRIVAL-UI');
    await expect(detail.locator('[data-backorder-line]')).toContainText('Waiting for arrival');
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await p.screenshot({path:out+'/sales-waiting-mobile.png',fullPage:true});
  }finally{await ui.close();}
  const scm=await open('scm',d);
  try{
    await chooseRegularStatuses(scm.page,'scm','completed');
    await scm.page.locator('[data-scm-stock-filter="waitingReason"]').selectOption('arrival');
    await expect(scm.page.locator('.stock-request-list')).toContainText(d.requestRef);
    await expect(scm.page.locator('[data-backorder-detail]')).toContainText('SO-ARRIVAL-UI');
    await expect(scm.page.locator('[data-action="already-ordered/sales-order"]')).toHaveCount(0);
  }finally{await scm.close();}
});
test('a full PO receipt alerts Sales after an earlier read, opens the Arrived request and stays acknowledged',async()=>{
  const row=await ordered();let d=await f.action(row.d,'sales','already-ordered/sales-order',{salesOrderRef:'SO-RECEIVED-UI'});
  const ui=await open('sales',d);
  try{
    const p=ui.page;
    await expect.poll(async()=>Number((await f.query('SELECT event_id FROM regular_stock_decision_reads WHERE request_id=$1',[d.id])).rows[0]?.event_id||0)).toBe(d.revision);
    await p.goto(f.base+'/sales');
    await f.query("UPDATE purchase_orders SET status_text='Partially Received' WHERE netsuite_id=$1",[row.id]);
    await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(p.locator('.regular-stock-popup')).toHaveCount(0);
    await f.query("UPDATE purchase_orders SET status_text='Fully Received' WHERE netsuite_id=$1",[row.id]);
    await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());
    const popup=p.locator('.regular-stock-popup');await expect(popup).toBeVisible();await expect(popup.getByRole('heading')).toHaveText('Stock arrived');await expect(popup).toContainText(row.ref);await expect(popup).toContainText('SO-RECEIVED-UI');
    await p.screenshot({path:out+'/sales-arrival-alert.png',fullPage:true});
    await popup.getByRole('link',{name:'Open request',exact:true}).click();
    const detail=p.locator('[data-backorder-detail]');await expect(detail).toHaveAttribute('data-backorder-id',String(d.id));await expect(detail).toContainText('Arrived');await expect(detail).toContainText('Completed');
    d=await f.detail(d);
    await expect.poll(async()=>(await f.query('SELECT backorder_arrival_key FROM regular_stock_decision_reads WHERE request_id=$1',[d.id])).rows[0]?.backorder_arrival_key).toBe(d.alreadyOrderedArrival.key);
    await p.reload();await p.evaluate(()=>window.MBBSRegularStockAlert.refresh());await expect(p.locator('.regular-stock-popup')).toHaveCount(0);
    await chooseRegularStatuses(p,'sales','completed');await p.locator('[data-sales-stock-filter="waitingReason"]').selectOption('arrived');await expect(p.locator('.stock-request-list')).toContainText(d.requestRef);
    assert(!(await f.http('sales','/api/sales/stock-requests/alerts')).body.requests.some(row=>row.id===d.id&&row.action==='arrival'));
  }finally{await ui.close();}
});
