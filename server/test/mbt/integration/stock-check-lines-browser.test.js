import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {submitBackorderRequest} from '../../../src/backorder-request-service.js';
import {createStockCheckRuntime} from '../../../src/stock-check/runtime.js';
import {createRequestStockChecks} from '../../../src/stock-check/request-checks.js';
let browser,http,base,token,actor,runtime,product;
const coverage=[];
const sample={sku:'177ECS0163703-0',name:'Endura Coping 24x14 Cham Oat Beige',colour:'OAT BEIGE',size:'24 x 14',pickupLocation:'Pickering',url:'https://ontario.order.unilock.com/products/products/endura-coping?child=177ECS0163703-0'};
test.before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  const username='live-line-browser-'+crypto.randomUUID(),password=crypto.randomUUID();
  actor=(await createOperator({username,password,displayName:'TEST Live Lines',role:'scm'})).id;
  http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));base='http://127.0.0.1:'+http.address().port;
  token=(await (await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})).json()).token;
  runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:path.resolve('data'),adapters:{stock:async options=>{
    const filename=await options.onScreenshot('availability_check',Buffer.from([255,216,255,217]));
    await options.onStep({key:'availability_check',status:'info',detail:'Fixture vendor low inventory',screenshot:filename});
    return {status:'low_stock',availabilityEvidenceVersion:2,availabilityText:'Available - Low in Stock',quantityVerified:false};
  }}});
  product=await runtime.repo.upsertScrapedProduct(1,sample);
  await runtime.repo.saveAccount(1,{label:'Fixture login',username:'fixture-user',password:'fixture-secret'},actor);
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES(88997702,'TEST-LIVE-UI',$1,'SQFT','Unilock Ltd',331) ON CONFLICT DO NOTHING",[sample.name]);
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await fs.writeFile('test-artifacts/stock-check/lines-browser-coverage.json',JSON.stringify(coverage));await browser?.close();if(http) {http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}await closeDb();});
async function fixture(kind='special',vendorName='Unilock Ltd',exact=true) {
  if(kind==='backorder') {
    return submitBackorderRequest({destinationLocationId:1,vendorId:331,vendorName,fulfillmentMethod:'yard_pickup',lines:[{itemId:88997702,salesQty:5,quantityMode:'direct',detailSpec:sample.sku}]},
      {operatorId:actor,authorizedDestinationLocationIds:[1]});
  }
  return createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Live Stock',vendorId:331,vendorName,fulfillmentMethod:'yard_pickup',
    lines:[{productName:exact?sample.name:'Endura Coping',color:sample.colour,size:exact?sample.size:'',quantity:5,uom:'SQFT',rate:10,requiredDate:'2099-02-01'}]},
    {operatorId:actor,authorizedStoreLocationIds:[1]});
}
async function pageFor(t,d,kind='special',width=1440) {
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addInitScript(({token,id})=>{localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.appSidebar.collapsed','true');localStorage.setItem('mbbs.scm.stockRequests.queue','request');localStorage.setItem('mbbs.scm.stockRequests.selected',String(id));}, {token,id:d.id});
  const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  page.on('pageerror',error=>console.log('Live line browser error: '+error.message));
  page.on('crash',()=>{void fs.readFile('/sys/fs/cgroup/memory.events','utf8').then(value=>console.log('Browser crash memory: '+value));});
  const calls=[];
  page.on('response',async response=>{if(response.url().includes('/api/scm/stock-check/requests/')) {calls.push({method:response.request().method(),status:response.status(),data:await response.json()});}});
  t.after(async()=>{try {coverage.push(...(await page.coverage.stopJSCoverage()).filter(row=>/\/(?:scm-stock-check(?:-lines)?|scm-special-stock-requests|scm-stock-requests|backorder-stock-requests)\.js(?:\?|$)/u.test(row.url)));await fs.writeFile('test-artifacts/stock-check/live-lines-diagnostic-'+d.id+'.json',JSON.stringify({calls,feedback:await page.locator('[data-live-stock-feedback]').allTextContents(),dialogs:await page.locator('.stock-live-dialog').allTextContents()}));}finally {await context.close();}});
  await page.goto(base+'/scm/stock-requests?tab='+(kind==='backorder'?'regular':kind));
  if(kind==='special') {await page.locator('[data-special-scm-action="select"][data-id="'+d.id+'"]').click();}
  else {await expect(page.locator('[data-backorder-detail]')).toHaveAttribute('data-backorder-id',String(d.id));}
  return page;
}
for(const kind of ['special','backorder']) {
  test(kind+' Unilock request checks inline, persists results and opens its exact private evidence',async t=>{
    const d=await fixture(kind),page=await pageFor(t,d,kind),button=page.getByRole('button',{name:'Live Stock Check',exact:true});
    await expect(button).toBeVisible();
    const heading=page.getByRole('heading',{name:'Line responses',exact:true});await expect(heading).toBeVisible();
    const [a,b]=await Promise.all([heading.boundingBox(),button.boundingBox()]);assert.ok(b.x>a.x+a.width);
    await button.click();await expect(page.locator('[data-live-stock-line]')).toContainText(/Queued|Checking/);
    await runtime.tick();await expect(page.locator('[data-live-stock-line]')).toContainText('Low inventory',{timeout:12000});
    const eta=await page.locator('.stock-live-summary > span').first().boundingBox(),live=await page.locator('[data-live-stock-line]').boundingBox();
    assert.ok(Math.abs(eta.y-live.y)<10,'The live result belongs to the right of the ETA/pickup row on desktop.');
    assert.ok(live.x>=eta.x+eta.width);
    const link=page.locator('[data-live-stock-line] a'),url=await link.getAttribute('href');assert.match(url,/history\?vendorId=1&job=/u);
    await page.reload();await expect(page.locator('[data-live-stock-line]')).toContainText('Low inventory');
    const popupPromise=page.waitForEvent('popup');await page.locator('[data-live-stock-line] a').click();const popup=await popupPromise;
    await expect(popup).toHaveURL(base+url);await expect(popup.locator('#stockJob')).toContainText('Fixture vendor low inventory');
    await expect(popup.locator('#stockEvidence img')).toHaveAttribute('src',/^blob:/u);
    await page.screenshot({path:'test-artifacts/stock-check/ui-live-'+kind+'.png',fullPage:true});
    const axe=await new AxeBuilder({page}).include('.stock-live-heading').include('[data-live-stock-line]').withTags(['wcag2a','wcag2aa']).analyze();assert.deepEqual(axe.violations,[]);
  });
}
test('unmatched variant selection supports catalogue search and safe skip on a narrow screen',async t=>{
  const d=await fixture('special','Unilock Ltd',false),page=await pageFor(t,d,'special',390);
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Select Unilock variants'});await expect(dialog).toBeVisible();
  await dialog.getByLabel('Search catalogue').fill(sample.sku);await dialog.getByRole('button',{name:'Search',exact:true}).click();
  await dialog.getByLabel('Exact vendor variant').selectOption(String(product.id));
  await dialog.getByRole('button',{name:'Check selected lines'}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-live-stock-line]')).toContainText('Queued');
  await runtime.tick();await expect(page.locator('[data-live-stock-line]')).toContainText('Low inventory',{timeout:12000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'test-artifacts/stock-check/ui-live-mobile.png',fullPage:true});
});
test('ambiguous descriptions use Ollama on click and a confirmed match queues the exact variant without a dialog',async t=>{
  const d=await fixture('special','Unilock Ltd',false),page=await pageFor(t,d),checks=createRequestStockChecks(runtime.repo);
  let matches=0;
  await page.route('**/api/scm/stock-check/requests/'+d.id+'/match',async route=>{
    matches++;const data=await checks.get(d.id);data.lines[0].product=product;data.lines[0].aiMatch={status:'matched',reason:'Exact catalogue variant',confidence:.99};
    await route.fulfill({json:data});
  });
  assert.equal(matches,0);await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  await expect(page.locator('[data-live-stock-line]')).toContainText(/Queued|Checking/);assert.equal(matches,1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved=(await checks.get(d.id)).lines[0];assert.equal(saved.job.productId,product.id);
  await runtime.tick();await expect(page.locator('[data-live-stock-line]')).toContainText('Low inventory',{timeout:12000});
});
test('uncertain Ollama results show their reason and manual selection; a late match cannot affect another request',async t=>{
  const d=await fixture('special','Unilock Ltd',false),page=await pageFor(t,d),checks=createRequestStockChecks(runtime.repo);
  const data=await checks.get(d.id);data.lines[0].aiMatch={status:'review',reason:'The finish is unclear. Please select the exact variant.'};
  await page.route('**/api/scm/stock-check/requests/'+d.id+'/match',route=>route.fulfill({json:data}));
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Select Unilock variants'});await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('The finish is unclear.');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  let release,entered;
  const waiting=new Promise(done=>{release=done;}),started=new Promise(done=>{entered=done;});
  await page.unroute('**/api/scm/stock-check/requests/'+d.id+'/match');
  await page.route('**/api/scm/stock-check/requests/'+d.id+'/match',async route=>{entered();await waiting;await route.fulfill({json:data});});
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();await started;
  await expect(page.locator('[data-live-stock-feedback]')).toContainText('Matching');
  const other=await fixture('special','Other Vendor');
  await page.locator('[data-special-scm-action="select"][data-id="'+other.id+'"]').count().then(async count=>{
    if(count) {await page.locator('[data-special-scm-action="select"][data-id="'+other.id+'"]').click();}
    else {await page.goto(base+'/scm/stock-requests?tab=regular');}
  });
  release();await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal((await checks.get(d.id)).lines[0].job,null);
});
test('matching outages allow manual selection and matching conflicts stop before stock jobs are queued',async t=>{
  const d=await fixture('special','Unilock Ltd',false),page=await pageFor(t,d),checks=createRequestStockChecks(runtime.repo);
  await page.route('**/api/scm/stock-check/requests/'+d.id+'/match',route=>route.abort());
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Select Unilock variants'});await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Select a catalogue variant to continue.');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.unroute('**/api/scm/stock-check/requests/'+d.id+'/match');
  await page.route('**/api/scm/stock-check/requests/'+d.id+'/match',route=>route.fulfill({status:409,json:{error:'The request changed while matching.'}}));
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  await expect(page.locator('[data-live-stock-feedback]')).toContainText('The request changed while matching.');
  await expect(dialog).toHaveCount(0);assert.equal((await checks.get(d.id)).lines[0].job,null);
});
test('other vendors have no Live Stock Check button or line result',async t=>{
  const d=await fixture('special','Other Vendor'),page=await pageFor(t,d);
  await expect(page.getByRole('heading',{name:'Line responses'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Live Stock Check'})).toHaveCount(0);await expect(page.locator('[data-live-stock-line]')).toHaveCount(0);
});
async function queueLine(d) {
  const checks=createRequestStockChecks(runtime.repo),data=await checks.get(d.id);
  const saved=await checks.start(d.id,{lines:[{lineId:d.lines[0].id,productId:product.id,fingerprint:data.lines[0].fingerprint}]},actor);
  return saved.lines[0].job;
}
test('inline results distinguish in-stock, dated production, unavailable, failure and changed material',async t=>{
  const d=await fixture();
  for(const [status,text,jobStatus] of [['stock_available','In stock','completed'],['in_production','Next Production · 2099-02-20','completed'],['insufficient_stock','Unavailable','completed'],['scrape_failure','Check failed · retry','failed']]) {
    await t.test(status,async child=>{
    const job=await queueLine(d);await runtime.repo.finishJob(job.id,{status,eta:status==='in_production'?'2099-02-20':null,availabilityEvidenceVersion:2},jobStatus);
    const page=await pageFor(child,d);await page.reload();await expect(page.locator('[data-live-stock-line]')).toContainText(text);
    await expect(page.locator('[data-live-stock-line] a')).toHaveAttribute('href',new RegExp(job.id+'$','u'));
    });
  }
  await query('UPDATE sales_special_stock_lines SET requested_quantity=6 WHERE id=$1',[d.lines[0].id]);
  const page=await pageFor(t,d);await page.reload();await expect(page.locator('[data-live-stock-line]')).toContainText('Recheck required');
});
test('switching requests discards a held earlier response without applying its result to the new lines',async t=>{
  const a=await fixture(),b=await fixture(),job=await queueLine(a);
  await runtime.repo.finishJob(job.id,{status:'low_stock',availabilityEvidenceVersion:2},'completed');
  const page=await pageFor(t,a);await expect(page.locator('[data-live-stock-line]')).toContainText('Low inventory');
  let release,entered,finished;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),handled=new Promise(resolve=>{finished=resolve;});
  await page.route('**/api/scm/stock-check/requests/'+a.id,async route=>{entered();try {await gate;await route.continue();}finally {finished();}});
  try {
    await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();await started;
    await page.locator('[data-special-scm-action="select"][data-id="'+b.id+'"]').click();
    await expect(page.locator('[data-live-stock-line]')).toHaveAttribute('data-live-stock-request',String(b.id));
    release();await handled;await page.unroute('**/api/scm/stock-check/requests/'+a.id);
    await expect(page.locator('[data-live-stock-line]')).toContainText('Not checked');
    await expect(page.locator('[data-live-stock-line] a')).toHaveCount(0);
    await expect(page.getByRole('dialog',{name:'Select Unilock variants'})).toHaveCount(0);
  } finally {release();}
});
test('queue errors remain visible and allow retry without changing manual response drafts',async t=>{
  const d=await fixture(),page=await pageFor(t,d);
  const draft=page.getByLabel('Sales-visible reply',{exact:true});
  await draft.fill('Draft reply stays here');
  await page.route('**/api/scm/stock-check/requests/'+d.id,async route=>{
    if(route.request().method()==='POST') {await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary check service failure'})});}
    else {await route.continue();}
  });
  await page.getByRole('button',{name:'Live Stock Check',exact:true}).click();
  await expect(page.locator('[data-live-stock-feedback]')).toHaveText('Temporary check service failure');
  await expect(page.getByRole('button',{name:'Live Stock Check',exact:true})).toBeEnabled();
  await expect(draft).toHaveValue('Draft reply stays here');
  await page.unroute('**/api/scm/stock-check/requests/'+d.id);
});
test('an older evidence deep link still opens after more than 30 later checks',async t=>{
  const job=await runtime.repo.createJob(1,{kind:'stock_test',productId:product.id,quantity:1},actor);
  await runtime.repo.finishJob(job.id,{status:'in_production',eta:'2099-02-20',reason:'Older production evidence',availabilityEvidenceVersion:2},'completed');
  for(let index=0;index<31;index++) {const later=await runtime.repo.createJob(1,{kind:'stock_test',productId:product.id,quantity:1},actor);await runtime.repo.finishJob(later.id,{status:'stock_available',availabilityEvidenceVersion:2},'completed');}
  const context=await browser.newContext();t.after(()=>context.close());await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  const page=await context.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(base+'/scm/stock-check/history?vendorId=1&job='+job.id);
  await expect(page.locator('#stockJob')).toContainText('Older production evidence');await expect(page.locator('#stockJob')).toContainText('2099-02-20');
  await fs.writeFile('test-artifacts/stock-check/live-lines-old-link.json',JSON.stringify({jobId:job.id,selected:await page.locator('#stockHistory [aria-pressed=true]').getAttribute('data-job')}));
  coverage.push(...(await page.coverage.stopJSCoverage()).filter(row=>/\/(?:scm-stock-check(?:-lines)?|scm-special-stock-requests|scm-stock-requests|backorder-stock-requests)\.js(?:\?|$)/u.test(row.url)));
});
