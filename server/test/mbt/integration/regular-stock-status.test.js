import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {chooseRegularStatuses,expectRegularStatuses,dismissRegularAlerts} from '../../support/regular-stock-status-browser.mjs';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest,convertSalesStockRequestLines} from '../../../src/stock-request-repository.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {getWaitlistRequest,rejectWaitlistRequest} from '../../../src/regular-waitlist-repository.js';
import {randomUUID} from 'node:crypto';
let f,w,records={},ids=[],browser;
const out='test-artifacts/unified-stock-status';
let coverageSequence=0;
async function startCoverage(page){
  if(process.env.UNIFIED_STATUS_UI_MUTANT==='1'){
    const source=readFileSync('public/regular-stock-status-ui.js','utf8');
    assert(source.includes('function render(request) {'));
    await page.route('**/regular-stock-status-ui.js?*',route=>route.fulfill({contentType:'application/javascript',body:source.replace('function render(request) {',"function render(request) { return ''; ")}));
  }
  await page.coverage.startJSCoverage({resetOnNavigation:true});
}
async function captureCoverage(page,name,restart=false){
  const coverage=await page.coverage.stopJSCoverage(),key=`${name}-${++coverageSequence}`;
  writeFileSync(`${out}/${key}-coverage.json`,JSON.stringify(coverage));
  if(process.env.NODE_V8_COVERAGE)writeFileSync(`${process.env.NODE_V8_COVERAGE}/browser-${key}.json`,JSON.stringify({result:coverage.filter(e=>e.url.startsWith(f.base)).map(e=>({...e,url:'file:///app/public'+new URL(e.url).pathname}))}));
  if(restart)await page.coverage.startJSCoverage({resetOnNavigation:true});
}
before(async()=>{
  mkdirSync(out,{recursive:true});f=await fixture({sku:88999789});
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999789,28,'2967',1000,1000,now()),(88999789,1,'3445',1000,1000,now())");
  async function create(name,method,status='submitted',regular={},yard=1){
    const d=await createSalesStockRequest({destinationLocationId:yard,lines:[{itemId:88999789,sourceLocationId:yard===1?28:1,salesQty:2}]},
      {operatorId:f.users.sales.id,authorizedDestinationLocationIds:[yard]});ids.push(d.id);
    await f.query('UPDATE sales_stock_request_lines SET status=$2 WHERE request_id=$1',[d.id,status]);
    await f.query('UPDATE sales_stock_requests SET request_ref=$2,workflow_version=2,regular_details=$3,status=$4 WHERE id=$1',
      [d.id,'UNIFIED-'+name+'-'+d.id,JSON.stringify({deliveryMethod:method,approval:{leadHours:0,leadTimeApplies:false,automatic:false,lines:[]},...regular}),['closed','rejected','received','fulfilled'].includes(status)?'completed':status==='cancelled'?'cancelled':'active']);
    records[name]=await f.detail(d,yard===1?'sales':'scm');return records[name];
  }
  await create('pickup','pickup','approved',{approvalExpiresAt:'2099-01-01T00:00:00Z'});
  await create('pickup2','pickup','approved',{approvalExpiresAt:'2099-01-01T00:00:00Z'});
  await create('stocking','stocking');
  await create('purchase','stocking','approved',{stockingType:'purchase'});
  await create('delivery','delivery','approved',{deliveryVersion:1,deliveryApproval:'approved',handoffStatus:'attention',handoffError:'Test failure'});
  await create('resolved','stocking','closed',{resolution:{purchaseOrderRef:'PO-TEST',eta:'2099-01-01'}});
  await create('rejected','stocking','rejected');await create('cancelled','pickup','cancelled');
  await create('foreign','pickup','approved',{},28);
  const local=await createSalesStockRequest({destinationLocationId:1,lines:[{itemId:88999789,sourceLocationId:28,salesQty:2}]},{operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1]});
  ids.push(local.id);
  records.transfer=(await convertSalesStockRequestLines(local.id,{expectedRevision:local.revision,lineIds:[local.lines[0].id]},{operatorId:f.users.scm.id})).request;
  await f.query("UPDATE sales_stock_requests SET request_ref='UNIFIED-TRANSFER-'||id WHERE id=$1",[local.id]);
  records.backorder=await f.create(2);
  await f.query("UPDATE sales_special_stock_lines SET supply_status=CASE WHEN id=$2 THEN 'production' ELSE 'vendor_transfer' END,sales_decision='pending',stock_checked_at=now() WHERE request_id=$1",[records.backorder.id,records.backorder.lines[0].id]);
  await f.query("UPDATE sales_stock_requests SET request_ref='UNIFIED-BACKORDER-'||id WHERE id=$1",[records.backorder.id]);
  w=await createWaitlistFixture();const s=await w.supply();records.waiting=await s.demand(20);records.allocated=await s.demand(10);records.waitlistClosed=await s.demand(5);
  await w.allocate(s.pool,[[records.allocated,5]],'Status test');
  records.allocated=await getWaitlistRequest(records.allocated.id);
  records.waitlistClosed=await rejectWaitlistRequest(records.waitlistClosed.id,{operationKey:randomUUID(),expectedRevision:records.waitlistClosed.revision,reason:'Test rejected'},w.context);
  for(const d of [records.waiting,records.allocated,records.waitlistClosed]){
    await f.query("UPDATE sales_stock_requests SET request_ref='UNIFIED-WAITLIST-'||id WHERE id=$1",[d.id]);d.requestRef='UNIFIED-WAITLIST-'+d.id;
  }
  // Put more than one scan page of nonmatches ahead of the matching old Pickup rows.
  for(let i=0;i<105;i++)await create('archive'+i,'pickup','rejected');
});
after(async()=>{
  await browser?.close();
  if(f){
    try{
      await f.query('DELETE FROM sales_stock_transfers WHERE request_id=ANY($1::bigint[])',[ids]);
      await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);
    }finally{await f.close();}
  }
});
const list=async(role,query)=>{const r=await f.http(role,`/api/${role}/stock-requests?search=UNIFIED&${query}`);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.requests;};

test('real APIs expose the same summaries and filter before pagination while retaining yard and type scope',async()=>{
  const sales=await list('sales','unifiedStatus=pending_sales&type=pickup&limit=1');
  assert.equal(sales.length,1);assert.equal(sales[0].statusSummary?.status,'pending_sales');assert.equal(sales[0].id,records.pickup2.id);
  const next=await list('sales','unifiedStatus=pending_sales&type=pickup&limit=1&offset=1');assert.equal(next[0].id,records.pickup.id);
  const scm=await list('scm','unifiedStatus=pending_sales&type=pickup&queue=&limit=10');
  assert(scm.some(d=>d.id===records.foreign.id));assert(!sales.some(d=>d.id===records.foreign.id));
  for(const d of [...sales,...next])assert.deepEqual(d.statusSummary,scm.find(r=>r.id===d.id).statusSummary);
  const legacy=await list('sales','bucket=accepted&limit=200');assert(legacy.some(d=>d.id===records.pickup.id));
});
test('independent supply badges combine with statuses and clear on dispatch readiness',async()=>{
  const rows=await list('sales','unifiedStatus=pending_sales&waitingReason=production');assert.deepEqual(rows.map(d=>d.id),[records.backorder.id]);
  assert.deepEqual(rows[0].statusSummary.waitingReasons,['vendor_transfer','production']);
  assert.deepEqual((await list('scm','queue=&unifiedStatus=pending_scm&waitingReason=production')).map(d=>d.id),[]);
  assert.equal((await list('sales','unifiedStatus=closed&outcome=cancelled'))[0].id,records.cancelled.id);
  const resolved=await list('sales','unifiedStatus=completed&outcome=resolved_po');assert.equal(resolved[0].id,records.resolved.id);
  assert.deepEqual((await list('scm','queue=&unifiedStatus=pending_sales&type=backorder&stage=new_enquiry')).map(d=>d.id),[]);
  assert.deepEqual((await list('scm','queue=&unifiedStatus=pending_sales&type=backorder&stage=await_customer_confirmation')).map(d=>d.id),[records.backorder.id]);
});
test('Waitlist summaries and filters agree between Sales and the SCM allocation workspace, including closed history',async()=>{
  for(const [name,status] of [['waiting','waiting_stock'],['allocated','pending_sales'],['waitlistClosed','closed']]){
    const id=records[name].id,sales=await f.http('sales',`/api/sales/stock-requests/${id}`),scm=await f.http('scm',`/api/scm/waitlist/requests/${id}`);
    assert.equal(sales.status,200);assert.equal(scm.status,200);assert.equal(sales.body.statusSummary?.status,status);assert.deepEqual(sales.body.statusSummary,scm.body.statusSummary);
    const list=await f.http('scm',`/api/scm/waitlist/requests?unifiedStatus=${status}`);assert.equal(list.status,200);assert(list.body.requests.some(d=>d.id===id));
  }
  const closed=await f.http('scm','/api/scm/waitlist/requests?unifiedStatus=closed&outcome=rejected');assert(closed.body.requests.some(d=>d.id===records.waitlistClosed.id));
});
test('invalid filters fail at HTTP boundaries, and read projections leave workflow records untouched',async()=>{
  for(const role of ['sales','scm'])for(const value of ['unifiedStatus=invalid','outcome=__proto__','waitingReason=invalid','unifiedStatus=closed&unifiedStatus=active']){
    const r=await f.http(role,`/api/${role}/stock-requests?${value}`);assert.equal(r.status,400,JSON.stringify(r.body));
  }
  const before=(await f.query('SELECT status,revision,regular_details FROM sales_stock_requests WHERE id=$1',[records.pickup.id])).rows;
  await list('sales','unifiedStatus=all');await list('scm','unifiedStatus=active&queue=');
  assert.deepEqual((await f.query('SELECT status,revision,regular_details FROM sales_stock_requests WHERE id=$1',[records.pickup.id])).rows,before);
});
test('browser main badges, supply badges and filters agree in Sales and SCM on desktop and mobile',async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const role of ['sales','scm']){
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),errors=[];
    let page=await context.newPage();await dismissRegularAlerts(page);
    let tracking=true;
    page.on('crash',()=>{let memory='';try{memory=readFileSync('/sys/fs/cgroup/memory.events','utf8');}catch{}writeFileSync(`${out}/${role}-crash.json`,JSON.stringify({url:page.url(),errors,memory},null,2));});
    await context.addInitScript(({token,role})=>{
      localStorage.setItem('mbbs.staff.token',token);
      const key=`mbbs.${role}.regularStatusFilters`;
      if(localStorage.getItem(key)===null)localStorage.setItem(key,'{broken');
    },{token:f.users[role].token,role});page.on('pageerror',e=>errors.push(e.message));
    await startCoverage(page);
    try{
      await page.goto(f.base+`/${role}/stock-requests?tab=regular`,{waitUntil:'domcontentloaded'});
      const card=page.locator(`.stock-request-card[data-id="${records.backorder.id}"]`);
      await expect(card.locator('[data-regular-main-status]')).toHaveText('Pending Sales');
      await expect(card.locator('[data-stock-request-waiting]')).toHaveText(['Waiting for Transfer','Waiting for Production']);
      await expectRegularStatuses(page,role,'active');
      await expect(page.locator(`.stock-request-card[data-id="${records.rejected.id}"]`)).toHaveCount(0);
      await page.locator(`[data-${role}-stock-filter="waitingReason"]`).selectOption('production');
      await expect(page.locator('.stock-request-card')).toHaveCount(1);
      await card.click();await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveText('Pending Sales');
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      await page.screenshot({path:`${out}/${role}-desktop.png`,fullPage:true});
      await page.setViewportSize({width:390,height:844});
      await expect(card.locator('[data-regular-main-status]')).toBeVisible();
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      await page.screenshot({path:`${out}/${role}-mobile.png`,fullPage:true});
      await page.locator(`[data-${role}-stock-filter="waitingReason"]`).selectOption('');
      await chooseRegularStatuses(page,role,'closed');
      await page.locator(`[data-${role}-stock-filter="outcome"]`).selectOption('cancelled');
      await expect(page.locator(`.stock-request-card[data-id="${records.cancelled.id}"] [data-regular-main-status]`)).toHaveText('Closed');
      await captureCoverage(page,role,true);await page.reload();
      await expectRegularStatuses(page,role,'closed');
      await expect(page.locator(`[data-${role}-stock-filter="outcome"]`)).toHaveValue('cancelled');
      await page.evaluate(()=>window.MBBS_I18N.setLanguage('zh-CN'));
      await captureCoverage(page,role,true);await page.reload();
      await expect(page.locator(`.stock-request-card[data-id="${records.cancelled.id}"] [data-regular-main-status]`)).toHaveText('已关闭');
      await page.locator(`[data-${role}-stock-action="clear-filters"]`).click();
      await expectRegularStatuses(page,role,'active');
      await expect(page.locator(`[data-${role}-stock-filter="outcome"]`)).toHaveValue('');
      await expect(page.locator(`.stock-request-card[data-id="${records.backorder.id}"] [data-regular-main-status]`)).toBeVisible();
      await captureCoverage(page,role);tracking=false;
      await page.close();page=await context.newPage();await dismissRegularAlerts(page);page.on('pageerror',e=>errors.push(e.message));
      await page.setViewportSize({width:390,height:844});
      await page.goto(f.base+`/${role}/stock-requests?tab=regular&requestId=${records.rejected.id}`);
      await expect(page.locator('.stock-request-detail h2')).toContainText(records.rejected.requestRef);
      await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status','closed');
      assert.deepEqual(errors,[]);
    }catch(error){
      await page.screenshot({path:`${out}/${role}-failure.png`,fullPage:true});
      writeFileSync(`${out}/${role}-errors.json`,JSON.stringify({errors,body:await page.locator('body').innerText()},null,2));
      writeFileSync(`${out}/${role}-overflow.json`,JSON.stringify(await page.locator('body *').evaluateAll(elements=>elements.filter(el=>el.getBoundingClientRect().right>window.innerWidth+1).slice(0,30).map(el=>({tag:el.tagName,classes:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,text:el.textContent.slice(0,120)}))),null,2));
      throw error;
    }finally{
      if(tracking)await captureCoverage(page,role);
      await context.close();
    }
  }
});
test('SCM Waitlist closed history has the shared status and no rejection control',async()=>{
  browser ||= await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users.scm.token);
  await startCoverage(page);
  try{
    await page.goto(f.base+'/scm/stock-requests?tab=waitlist');
    await page.locator('[data-waitlist-view="requests"]').click();
    await expect(page.locator('[data-waitlist-status-filter="unifiedStatus"]')).toHaveValue('active');
    await expect(page.locator(`[data-waitlist-request-row="${records.waiting.id}"] [data-regular-main-status]`)).toHaveText('Waiting for Stock');
    await page.locator('[data-waitlist-status-filter="outcome"]').selectOption('rejected');
    await expect(page.locator('[data-waitlist-status-filter="unifiedStatus"]')).toHaveValue('closed');
    const row=page.locator(`[data-waitlist-request-row="${records.waitlistClosed.id}"]`);
    await expect(row.locator('[data-regular-main-status]')).toHaveText('Closed');
    await expect(row.locator('[data-waitlist-reject]')).toHaveCount(0);
    const background=await page.waitForResponse(response=>response.url().includes('/api/scm/waitlist/requests?')&&response.request().method()==='GET',{timeout:20000});
    assert.equal(new URL(background.url()).searchParams.get('unifiedStatus'),'closed');
    assert.equal(new URL(background.url()).searchParams.get('outcome'),'rejected');
    await page.screenshot({path:`${out}/scm-waitlist-closed.png`,fullPage:true});
  }finally{
    const coverage=await page.coverage.stopJSCoverage();writeFileSync(`${out}/waitlist-coverage.json`,JSON.stringify(coverage));
    if(process.env.NODE_V8_COVERAGE)writeFileSync(`${process.env.NODE_V8_COVERAGE}/browser-waitlist.json`,JSON.stringify({result:coverage.filter(e=>e.url.startsWith(f.base)).map(e=>({...e,url:'file:///app/public'+new URL(e.url).pathname}))}));
    await context.close();
  }
});
test('Pickup, Delivery, Stocking Purchase and Waitlist detail headers use the same main-status vocabulary',async()=>{
  browser ||= await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const [name,role,status] of [['pickup','sales','pending_sales'],['delivery','scm','in_progress'],['purchase','scm','pending_scm'],['waiting','sales','waiting_stock']]){
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
    await startCoverage(page);
    try{
      await page.goto(f.base+`/${role}/stock-requests?tab=regular&requestId=${records[name].id}`);
      await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveAttribute('data-regular-main-status',status);
      await expect(page.locator('.stock-request-detail h2')).toContainText(records[name].requestRef);
      assert.deepEqual(errors,[]);
    }finally{await captureCoverage(page,name);await context.close();}
  }
});
test('SCM transfer controls remain available from unified statuses and terminal transfers cannot be rejected',async()=>{
  browser ||= await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users.scm.token);
  await startCoverage(page);
  try{
    await page.goto(f.base+`/scm/stock-requests?tab=regular&requestId=${records.transfer.id}`);
    await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveText('In Progress');
    await expect(page.locator('[data-scm-stock-action="reject-pending-to"]')).toBeEnabled();
    await expect(page.locator('[data-scm-stock-action="confirm-print"]')).toBeEnabled();
    await f.query("UPDATE sales_stock_transfers SET status='closed' WHERE request_id=$1",[records.transfer.id]);
    await f.query("UPDATE sales_stock_request_lines SET status='closed' WHERE request_id=$1",[records.transfer.id]);
    await f.query("UPDATE sales_stock_requests SET status='completed' WHERE id=$1",[records.transfer.id]);
    await captureCoverage(page,'transfer',true);await page.reload();
    await expect(page.locator('.stock-request-detail [data-regular-main-status]')).toHaveText('Closed');
    await expect(page.locator('[data-scm-stock-action="reject-pending-to"]')).toHaveCount(0);
    assert.deepEqual(errors,[]);
  }finally{
    const coverage=await page.coverage.stopJSCoverage();writeFileSync(`${out}/transfer-coverage.json`,JSON.stringify(coverage));
    if(process.env.NODE_V8_COVERAGE)writeFileSync(`${process.env.NODE_V8_COVERAGE}/browser-transfer.json`,JSON.stringify({result:coverage.filter(e=>e.url.startsWith(f.base)).map(e=>({...e,url:'file:///app/public'+new URL(e.url).pathname}))}));
    await context.close();
  }
});
