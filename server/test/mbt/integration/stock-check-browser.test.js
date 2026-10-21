import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {closeDb} from '../../../src/db.js';
import {createStockCheckRuntime} from '../../../src/stock-check/runtime.js';
import {checkUnilockStock} from '../../../src/stock-check/unilock-stock.js';
import {stockPortal} from '../../support/stock-check-stock-portal.js';
let browser,http,base,token,product,runtime;
let fixtureAvailability='Available';
const coverage=[];
const sample={sku:'177ECS0163703-0',name:'Endura™ Coping 24x14 Cham Oat Beige',series:'Endura Coping',colour:'OAT BEIGE',finish:'SMOOTH',shape:'COPING',size:'24 x 14',pickupLocation:'Pickering',url:'https://ontario.order.unilock.com/products/products/endura-coping?child=177ECS0163703-0'};
async function api(url,method='GET',body) {
  const response=await fetch(base+'/api/scm/stock-check'+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.ok,true,JSON.stringify(data));return data;
}
test.before(async()=>{
  http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));base='http://127.0.0.1:'+http.address().port;
  const username='stock-browser-'+crypto.randomUUID();await createOperator({username,displayName:'SCM Fixture',password:'fixture-staff-password',role:'scm'});
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'fixture-staff-password'})});token=(await login.json()).token;
  runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:path.resolve('data'),adapters:{stock:async options=>{
    const portal=await stockPortal({productAvailability:fixtureAvailability});try {return await checkUnilockStock({...options,baseUrl:portal.baseUrl,allowTestOrigin:true,product:{...options.product,url:portal.baseUrl+'/products/products/endura-coping?child='+options.product.sku}});}finally {await portal.close();}
  }}});
  product=await runtime.repo.upsertScrapedProduct(1,sample);
  await api('/vendors/1/accounts','POST',{label:'Main Stock Login',username:'fixture-vendor-user',password:'fixture-vendor-password'});
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await fs.writeFile('test-artifacts/stock-check/browser-coverage.json',JSON.stringify(coverage));await browser?.close();if(http) {http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}await closeDb();});
async function pageFor(t,url,viewport={width:1440,height:1000},collapsed=null) {
  const context=await browser.newContext({viewport,serviceWorkers:'block'});
  await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  if(collapsed!==null) {await context.addInitScript(value=>localStorage.setItem('mbbs.appSidebar.collapsed',String(value)),collapsed);}
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  t.after(async()=>{coverage.push(...(await page.coverage.stopJSCoverage()).filter(row=>row.url.includes('/scm-stock-check.js')));await context.close();});
  await page.goto(base+url);return page;
}
test('SCM can edit and reset pickup data, refresh preserves corrections, and catalog controls are accessible',async t=>{
  const page=await pageFor(t,'/scm/stock-check');await page.getByLabel('Product name or vendor SKU').fill('Endura');await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Major Pickup Point', {exact:true}).fill('Gormley');await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('#stockRows')).toContainText('Gormley');
  await runtime.repo.upsertScrapedProduct(1,{...sample,pickupLocation:'Ayr'});await page.reload();await expect(page.locator('#stockRows')).toContainText('Gormley');
  await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByRole('button',{name:'Use Vendor Values'}).click();await expect(page.locator('#stockRows')).toContainText('Ayr');
  await page.screenshot({path:'test-artifacts/stock-check/ui-catalog.png',fullPage:true});
  const axe=await new AxeBuilder({page}).include('.stock-shell').withTags(['wcag2a','wcag2aa']).analyze();assert.deepEqual(axe.violations,[]);
  product=await runtime.repo.upsertScrapedProduct(1,sample);
});
test('Vendor Setup saves multiple named logins per vendor without rendering saved passwords or injected HTML',async t=>{
  const page=await pageFor(t,'/scm/stock-check/setup');await expect(page.getByRole('cell',{name:'Main Stock Login Selected'})).toBeVisible();
  await page.getByRole('button',{name:'Add Login',exact:true}).click();await page.getByLabel('Account Label').fill('Second Login');await page.getByLabel('Login ID',{exact:true}).fill('fixture-second-login');await page.getByLabel('Password',{exact:true}).fill('fixture-second-secret');await page.getByRole('button',{name:'Save Login'}).click();
  await expect(page.getByText('Second Login',{exact:true})).toBeVisible();assert.equal(await page.locator('input[type=password]').count(),0);assert.equal((await api('/vendors/1/accounts')).length,2);
  const row=page.locator('tr').filter({hasText:'Second Login'});await row.getByRole('button',{name:'Use Account'}).click();await expect(row).toContainText('Selected');
  await row.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Add Vendor',exact:true}).click();await page.getByLabel('Vendor Name',{exact:true}).fill('<img src=x onerror=window.stockInjected=1>');await page.getByRole('button',{name:'Save Vendor'}).click();
  await expect(page.getByText('No logins saved for this vendor.')).toBeVisible();assert.equal(await page.evaluate(()=>window.stockInjected),undefined);assert.equal(await page.locator('#stockContent img').count(),0);
  await page.screenshot({path:'test-artifacts/stock-check/ui-setup.png',fullPage:true});
});
test('test page searches exact variants, runs a five-bundle check and displays real authenticated screenshot evidence',async t=>{
  const page=await pageFor(t,'/scm/stock-check/test');await page.getByLabel('Vendor',{exact:true}).selectOption('1');await page.getByLabel('Item Name or Vendor SKU').fill(sample.sku);await page.getByRole('button',{name:'Find Item'}).click();
  await expect(page.getByRole('heading',{name:'Recent Checks',exact:true})).toHaveCount(0);
  await page.locator('[data-product="'+product.id+'"]').click();await page.getByLabel('Bundles (Pallets)').fill('5');await page.getByRole('button',{name:'Run Stock Check'}).click();
  await expect(page).toHaveURL(/\/scm\/stock-check\/history\?/u);await expect(page.locator('#stockJob')).toBeVisible();await runtime.tick();await expect(page.locator('.stock-status')).toHaveText('Available',{timeout:15000});
  await expect(page.locator('#stockJob')).toContainText('Bundles (reference)');await expect(page.locator('#stockJob')).toContainText('add to cart skipped');
  await expect(page.locator('#stockHistory [aria-pressed=true]')).toHaveCount(1);
  await expect(page.locator('#stockEvidence img').first()).toBeVisible();assert.match(await page.locator('#stockEvidence img').first().getAttribute('src'),/^blob:/);
  const jobs=await api('/jobs?vendorId=1'),job=await api('/jobs/'+jobs[0].id);assert.equal(job.result.verifiedQuantity,null);assert.equal(job.result.cartAcceptanceVerified,false);
  await expect(page.locator('#stockJob')).toContainText('requested bundle quantity was not tested');
  assert.equal((await fetch(base+'/api/scm/stock-check/jobs/'+job.id+'/evidence/'+job.steps.find(step=>step.screenshot).screenshot)).status,401);
  await page.screenshot({path:'test-artifacts/stock-check/ui-test.png',fullPage:true});
});
let scrollingFixturesReady=false;
async function scrollingFixtures() {
  if(scrollingFixturesReady) {return;}
  for(let index=0;index<120;index++) {
    const sku='SCROLL-'+String(index).padStart(3,'0');
    await runtime.repo.upsertScrapedProduct(1,{...sample,sku,name:'Scroll Fixture '+index,
      url:'https://ontario.order.unilock.com/products/products/endura-coping?child='+sku});
  }
  for(let index=0;index<30;index++) {
    await api('/vendors/1/accounts','POST',{label:'Scroll Login '+index,username:'fixture-scroll-'+index,password:'fixture-scroll-secret'});
  }
  scrollingFixturesReady=true;
}
for(const viewport of [{width:1440,height:720},{width:390,height:600}]) {
  test('all Stock Check pages allow wheel scrolling to their final controls at '+viewport.width+' pixels',async t=>{
    await scrollingFixtures();
    for(const route of ['/scm/stock-check','/scm/stock-check/test','/scm/stock-check/setup']) {
      const page=await pageFor(t,route,viewport);
      await expect(page.locator('#stockContent')).not.toBeEmpty();
      await page.getByLabel('Vendor',{exact:true}).selectOption('1');
      if(!route.endsWith('/setup')) {
        const search=route.endsWith('/test')?'Item Name or Vendor SKU':'Product name or vendor SKU';
        await page.getByLabel(search).fill('Scroll Fixture');
        await page.getByRole('button',{name:route.endsWith('/test')?'Find Item':'Search',exact:true}).click();
      }
      const end=route.endsWith('/setup')?page.locator('#stockContent tbody tr').last():
        route.endsWith('/test')?page.locator('#stockRun'):page.locator('#stockNext');
      await expect(end).toBeAttached();
      await page.mouse.move(viewport.width-35,Math.round(viewport.height/2));await page.mouse.wheel(0,1000);
      await expect.poll(()=>page.evaluate(()=>window.scrollY),{message:route+' must respond to wheel scrolling'}).toBeGreaterThan(100);
      for(let attempt=0;attempt<18;attempt++) {
        const visible=await end.evaluate(node=>{const box=node.getBoundingClientRect();return box.bottom<=window.innerHeight&&box.bottom>0;});
        if(visible) {break;}
        await page.mouse.wheel(0,2000);await page.waitForTimeout(70);
      }
      await expect(end).toBeInViewport();
      const layout=await page.evaluate(()=>({viewport:window.innerWidth,documentWidth:document.documentElement.scrollWidth,
        sidebar:document.body.style.getPropertyValue('--app-sidebar-width'),
        overflow:[...document.querySelectorAll('#stockCheckApp *')].map(node=>({tag:node.tagName,id:node.id,className:node.className,
          right:Math.round(node.getBoundingClientRect().right),width:Math.round(node.getBoundingClientRect().width)}))
          .filter(node=>node.right>window.innerWidth).slice(0,12)}));
      await fs.writeFile('test-artifacts/stock-check/ui-scroll-layout-'+viewport.width+'-'+route.split('/').at(-1)+'.json',JSON.stringify(layout));
      await page.screenshot({path:'test-artifacts/stock-check/ui-scroll-'+viewport.width+'-'+(route.split('/').at(-1)||'catalog')+'.png'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,route+' must fit the viewport');
    }
  });
}
test('accepted production inventory displays In production and its ETA instead of Stock confirmed',async t=>{
  fixtureAvailability='Production Scheduled for - 2026-10-20';t.after(()=>{fixtureAvailability='Available';});
  const page=await pageFor(t,'/scm/stock-check/test');await page.getByLabel('Vendor',{exact:true}).selectOption('1');
  await page.getByLabel('Item Name or Vendor SKU').fill(sample.sku);await page.getByRole('button',{name:'Find Item'}).click();await page.locator('[data-product="'+product.id+'"]').click();
  await page.getByLabel('Bundles (Pallets)').fill('5');await page.getByRole('button',{name:'Run Stock Check'}).click();await expect(page).toHaveURL(/\/scm\/stock-check\/history\?/u);await expect(page.locator('#stockJob')).toBeVisible();await runtime.tick();
  await expect(page.locator('.stock-status')).toHaveText('In production',{timeout:15000});await expect(page.locator('#stockJob')).toContainText('2026-10-20');
  await expect(page.locator('#stockJob')).toContainText('Production Scheduled for');await expect(page.locator('#stockEvidence img').first()).toBeVisible();
  const jobs=await api('/jobs?vendorId=1');assert.equal(jobs[0].result.status,'in_production');assert.equal(jobs[0].result.verifiedQuantity,null);
  await page.screenshot({path:'test-artifacts/stock-check/ui-production-eta.png',fullPage:true});
});

let recentFixtures;
async function historyFixtures() {
  if(recentFixtures) {return recentFixtures;}
  const jobs=await api('/jobs?vendorId=1'),saved=await api('/jobs/'+jobs.find(job=>job.kind==='stock_test').id);
  const other=await runtime.repo.upsertScrapedProduct(1,{...sample,sku:'RECENT-URBAN',name:'Urban Indiana Buff',colour:'INDIANA BUFF',size:'18 x 36',
    url:'https://ontario.order.unilock.com/products/products/urban?child=RECENT-URBAN'});
  const created=await api('/vendors/1/jobs','POST',{kind:'stock_test',productId:other.id,quantity:2});
  await runtime.repo.finishJob(created.id,{status:'low_stock',reason:'Available before Add to Cart.',availabilityText:'Available - Low in Stock',sku:other.sku,verifiedQuantity:null,cartAcceptanceVerified:false});
  const shot=saved.steps.find(step=>step.screenshot).screenshot;
  await fs.mkdir(path.join(runtime.evidenceDir,created.id),{recursive:true});
  await fs.copyFile(path.join(runtime.evidenceDir,saved.id,shot),path.join(runtime.evidenceDir,created.id,'history-evidence.jpg'));
  await runtime.repo.addStep(created.id,{key:'availability_check',status:'info',detail:'Available - Low in Stock',screenshot:'history-evidence.jpg'});
  const empty=await api('/vendors','POST',{name:'History Empty Vendor',methodKey:'pending'});
  recentFixtures={older:saved.id,newer:created.id,emptyVendorId:empty.id};return recentFixtures;
}

test('Recent Checks selects a master row, shows matching details and evidence, searches, and preserves the selection on refresh and reload',async t=>{
  const fixtures=await historyFixtures();const page=await pageFor(t,'/scm/stock-check/history?vendorId=1');
  await expect(page.getByRole('link',{name:'Recent Checks',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('#stockHistory [aria-pressed=true]')).toHaveAttribute('data-job',fixtures.newer);
  await expect(page.locator('#stockJob .stock-status')).toHaveText('Low stock');
  await expect(page.locator('#stockJob')).toContainText('RECENT-URBAN');
  await expect(page.locator('#stockEvidence img')).toBeVisible();
  await page.locator('[data-job="'+fixtures.older+'"]').click();
  await expect(page.locator('#stockJob .stock-status')).toHaveText('In production');
  await expect(page.locator('#stockJob')).toContainText(sample.sku);await expect(page.locator('#stockJob')).toContainText('2026-10-20');
  await expect(page).toHaveURL(new RegExp('job='+fixtures.older,'u'));
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.locator('#stockHistory [aria-pressed=true]')).toHaveAttribute('data-job',fixtures.older);
  await page.reload();await expect(page.locator('#stockJob .stock-status')).toHaveText('In production');
  await page.getByLabel('Search recent checks').fill('RECENT-URBAN');
  await expect(page.locator('#stockHistory [data-job]')).toHaveCount(1);
  await page.locator('#stockHistory [data-job]').click();await expect(page.locator('#stockJob')).toContainText('RECENT-URBAN');
  await page.getByLabel('Search recent checks').fill('no-matching-check');await expect(page.locator('#stockHistory')).toContainText('No matching checks.');
  await page.getByLabel('Search recent checks').fill('');
  const axe=await new AxeBuilder({page}).include('.stock-history-layout').withTags(['wcag2a','wcag2aa']).analyze();assert.deepEqual(axe.violations,[]);
});

test('switching rows or vendors discards an earlier detail response and clears old evidence for an empty vendor',async t=>{
  const fixtures=await historyFixtures();const page=await pageFor(t,'/scm/stock-check/history?vendorId=1&job='+fixtures.newer);
  await expect(page.locator('#stockJob')).toContainText('RECENT-URBAN');await expect(page.locator('#stockEvidence img')).toBeVisible();
  let release,started;
  const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{started=resolve;});
  t.after(()=>release());
  await page.route('**/api/scm/stock-check/jobs/'+fixtures.older,async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});});
  await page.locator('[data-job="'+fixtures.older+'"]').click();await waiting;
  await page.locator('[data-job="'+fixtures.newer+'"]').click();await expect(page.locator('#stockJob .stock-status')).toHaveText('Low stock');
  const delayed=page.waitForResponse(response=>response.url().endsWith('/jobs/'+fixtures.older));
  release();await delayed;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.locator('#stockJob .stock-status')).toHaveText('Low stock');await expect(page.locator('#stockJob')).toContainText('RECENT-URBAN');
  let releaseVendor,startedVendor;
  const heldVendor=new Promise(resolve=>{releaseVendor=resolve;}),waitingVendor=new Promise(resolve=>{startedVendor=resolve;});
  t.after(()=>releaseVendor());
  await page.route('**/api/scm/stock-check/vendors/'+fixtures.emptyVendorId+'/accounts',async route=>{const response=await route.fetch();startedVendor();await heldVendor;await route.fulfill({response});});
  await page.getByLabel('Vendor',{exact:true}).selectOption(String(fixtures.emptyVendorId));await waitingVendor;
  await expect(page.locator('#stockHistory [data-job]')).toHaveCount(0);await expect(page.locator('#stockJob img')).toHaveCount(0);
  releaseVendor();
  await expect(page.locator('#stockHistory')).toContainText('No checks recorded for this vendor.');
  await expect(page.locator('#stockJob')).toContainText('No checks recorded for this vendor.');await expect(page.locator('#stockJob img')).toHaveCount(0);
  await expect(page.locator('#stockJob')).not.toContainText('RECENT-URBAN');
});

for(const viewport of [{width:1440,height:900},{width:390,height:700}]) {
  test('Recent Checks uses readable master and detail panels at '+viewport.width+' pixels',async t=>{
    const fixtures=await historyFixtures();const page=await pageFor(t,'/scm/stock-check/history?vendorId=1&job='+fixtures.newer,viewport,viewport.width<1100?true:null);
    await expect(page.locator('#stockJob .stock-status')).toHaveText('Low stock');await expect(page.locator('#stockEvidence img')).toBeVisible();
    const master=await page.locator('.stock-history-master').boundingBox(),detail=await page.locator('#stockJob').boundingBox();
    if(viewport.width>1100) {assert.ok(detail.x>=master.x+master.width);}else {assert.ok(detail.y>=master.y+master.height);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:'test-artifacts/stock-check/ui-history-'+viewport.width+'.png',fullPage:true});
    if(viewport.width<1100) {
      await expect(page.locator('body')).toHaveClass(/app-sidebar-collapsed/u);
      await page.locator('[data-sidebar-toggle]').click();
      await expect(page.locator('body')).not.toHaveClass(/app-sidebar-collapsed/u);
      const refresh=await page.locator('#stockHistoryRefresh').boundingBox(),panel=await page.locator('.stock-history-master').boundingBox();
      assert.ok(refresh.x+refresh.width<=panel.x+panel.width,'Refresh must fit even when the sidebar is expanded.');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.locator('[data-sidebar-toggle]').click();
      await page.locator('[data-job="'+fixtures.older+'"]').click();await expect(page.locator('#stockJob .stock-status')).toHaveText('In production');
      await expect(page.locator('#stockJob h2')).toBeInViewport();
    }
  });
}
