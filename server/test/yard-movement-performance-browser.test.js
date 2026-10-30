/* global window,document,localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {chromium,expect as playwrightExpect} from '@playwright/test';
const expect=playwrightExpect.configure({timeout:process.env.YARD_PERF_BASELINE==='1'?60000:15000});
import {app} from '../src/server.js';
import {closeDb,query} from '../src/db.js';
import {yardPerformanceFixture} from './support/yard-movement-performance-fixture.mjs';
let browser,server,base,fixture;
const coverage=[],metrics=[];
before(async()=>{
  fixture=await yardPerformanceFixture();
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{
  await writeFile('test-artifacts/yard-performance-browser-coverage.json',JSON.stringify(coverage));
  await writeFile('test-artifacts/yard-performance-browser-metrics.json',JSON.stringify(metrics));
  await browser?.close();if(server) await new Promise(resolve=>server.close(resolve));await fixture?.cleanup();await closeDb();
});
const surfaces={
  control:{path:'/control/yard-in-outbound',search:'#loadedSearch',detail:'#loadedDetailPanel',api:'/api/control/loaded-orders'},
  sales:{path:'/sales/in-outbound-record',search:'#dispatchLoadedSearch',detail:'#dispatchLoadedDetail',api:'/api/sales/in-outbound-records'},
  dispatch:{path:'/dispatch/loaded-export',search:'#dispatchLoadedSearch',detail:'#dispatchLoadedDetail',api:'/api/dispatch/loaded-orders'}
};
async function open(surface) {
  const config=surfaces[surface],context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),calls=[],errors=[];
  page.setDefaultTimeout(process.env.YARD_PERF_BASELINE==='1'?60000:15000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({token,operator})=>{
    for(const key of ['mbbs.staff.token','mbbs.control.token','mbbs.dispatch.token']) localStorage.setItem(key,token);
    localStorage.setItem('mbbs.staff.role',operator.role);localStorage.setItem('mbbs.staff.roles',JSON.stringify(operator.roles||[operator.role]));
  },fixture.sessions[surface]);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base) return route.abort();
    if(url.pathname.startsWith('/api/')) calls.push(url.pathname);
    return route.continue();
  });
  const start=performance.now();await page.goto(base+config.path);
  await expect(page.locator(config.detail)).toContainText(fixture.refs[0]);
  const initialMs=performance.now()-start;
  return {page,config,calls,errors,initialMs,finish:async()=>{coverage.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
function p95(values){return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];}
for(const surface of Object.keys(surfaces)) {
  test(`P3: Playwright measures ${surface} initial, search and order-detail latency`,async()=>{
    const f=await open(surface),samples=[];
    try {
      for(let i=0;i<Number(process.env.YARD_PERF_SAMPLES||5);i++) {
        const term=i%2?fixture.prefix.toLowerCase():fixture.prefix;
        const searchStart=performance.now();
        await f.page.locator(f.config.search).fill(term);
        const card=f.page.locator(`[data-action="select-loaded-order"][data-key="outbound:sales_order:${fixture.ids[1]}"]`);
        await expect(card).toBeVisible();
        await expect.poll(async()=>f.page.locator(f.config.search).evaluate(input=>input.value)).toBe(term);
        // Wait for the search request itself; old list cards may already exist.
        await expect.poll(async()=>f.page.evaluate(({term,api})=>performance.getEntriesByType('resource').filter(r=>r.name.includes(api+'?')&&new URL(r.name).searchParams.get('search')===term).length,{term,api:f.config.api}),{intervals:[10]}).toBeGreaterThan(Math.floor(i/2));
        await expect(card).toBeVisible();
        const searchMs=performance.now()-searchStart;
        await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
        const searchDetailMs=performance.now()-searchStart;
        const clickStart=performance.now();await card.click();
        await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[1]);
        samples.push({searchMs,searchDetailMs,clickMs:performance.now()-clickStart});
        if(i+1<Number(process.env.YARD_PERF_SAMPLES||5)) {
          await f.page.locator(`[data-action="select-loaded-order"][data-key="outbound:sales_order:${fixture.ids[0]}"]`).click();
          await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
        }
      }
      const result={surface,initialMs:f.initialMs,samples,searchP95:p95(samples.map(s=>s.searchMs)),detailP95:p95(samples.map(s=>s.clickMs))};
      metrics.push(result);console.log('YARD_BROWSER_TIMING '+JSON.stringify(result));
      assert.deepEqual(f.errors,[]);
      if(process.env.YARD_PERF_BASELINE!=='1') {assert.ok(result.searchP95<1000,JSON.stringify(result));assert.ok(result.detailP95<1000,JSON.stringify(result));}
    } finally {await f.finish();}
  });
  test(`U1: ${surface} shows loading immediately, deduplicates clicks and rejects stale detail`,async()=>{
    const f=await open(surface);let release,started=0;
    const gate=new Promise(resolve=>{release=resolve;});
    try {
      // Keep the delayed HTTP response alive even when the client aborts: the
      // sequence guard must also protect against already-completed requests.
      await f.page.evaluate(()=>{const native=window.fetch;window.fetch=(url,options={})=>native(url,{...options,signal:undefined});});
      await f.page.route('**'+f.config.api+'/detail?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('orderId')!==String(fixture.ids[1])) return route.continue();
        started++;const response=await route.fetch();await gate;await route.fulfill({response});
      });
      const second=f.page.locator(`[data-action="select-loaded-order"][data-key="outbound:sales_order:${fixture.ids[1]}"]`);
      await second.click();await expect.poll(()=>started).toBe(1);
      await expect(second).toHaveClass(/active/);
      await expect(f.page.locator(f.config.detail)).toContainText('Loading');
      await second.click();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(started,1);
      await f.page.locator(`[data-action="select-loaded-order"][data-key="outbound:sales_order:${fixture.ids[0]}"]`).click();
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      release();await new Promise(resolve=>setTimeout(resolve,150));
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      await expect(f.page.locator(f.config.detail)).not.toContainText(fixture.refs[1]);
    } finally {release();await f.finish();}
  });
  test(`U2: ${surface} displays a detail error and can retry without stale data`,async()=>{
    const f=await open(surface);let failed=false;
    f.page.on('dialog',dialog=>dialog.dismiss());
    try {
      await f.page.route('**'+f.config.api+'/detail?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('orderId')!==String(fixture.ids[1]) || failed) return route.continue();
        failed=true;return route.fulfill({status:503,json:{error:'Temporary detail read failure'}});
      });
      const second=f.page.locator(`[data-action="select-loaded-order"][data-key="outbound:sales_order:${fixture.ids[1]}"]`);
      await second.click();await expect.poll(()=>failed).toBe(true);
      await expect(f.page.locator(f.config.detail)).not.toContainText(fixture.refs[0]);
      await expect(f.page.locator(f.config.detail)).not.toContainText('Loading');
      await second.click();await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[1]);
    } finally {await f.finish();}
  });
  test(`U2: ${surface} cancels an older search as soon as the input changes`,async()=>{
    const f=await open(surface);let release,started=false,aborted=false;
    const gate=new Promise(resolve=>{release=resolve;});
    try {
      f.page.on('requestfailed',request=>{if(new URL(request.url()).searchParams.get('search')===fixture.refs[1]) aborted=true;});
      await f.page.route('**'+f.config.api+'?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('search')!==fixture.refs[1]) return route.continue();
        started=true;const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>{});
      });
      await f.page.locator(f.config.search).fill(fixture.refs[1]);await expect.poll(()=>started).toBe(true);
      await f.page.locator(f.config.search).fill('NO-MATCH-'+fixture.prefix);
      await expect.poll(()=>aborted,{timeout:1000}).toBe(true);
      await expect(f.page.locator('[data-action="select-loaded-order"]')).toHaveCount(0);
      release();await new Promise(resolve=>setTimeout(resolve,100));
      await expect(f.page.locator('[data-action="select-loaded-order"]')).toHaveCount(0);
      await f.page.locator(f.config.search).fill('');
      await expect(f.page.locator('[data-action="select-loaded-order"]')).toHaveCount(2);
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
    } finally {release();await f.finish();}
  });
  test(`U2: ${surface} reports a failed refresh and successfully retries`,async()=>{
    const f=await open(surface);let failed=false;const dialogs=[];
    f.page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    try {
      await f.page.route('**'+f.config.api+'?**',async route=>{
        if(failed) return route.continue();
        failed=true;return route.fulfill({status:503,json:{error:'Temporary list read failure'}});
      });
      await f.page.locator('[data-action="refresh-loaded-orders"]').click();
      if(surface==='control') await expect.poll(()=>dialogs).toContain('Temporary list read failure');
      else await expect(f.page.locator('.dispatch-loaded-error')).toContainText('Temporary list read failure');
      await f.page.locator('[data-action="refresh-loaded-orders"]').click();
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      assert.deepEqual(f.errors,[]);
    } finally {await f.finish();}
  });
  test(`U2: ${surface} item search, refresh, filters and tabs retain fresh selection`,async()=>{
    const f=await open(surface);
    try {
      const item=f.page.locator(surface==='control'?'#loadedItemSearch':'#dispatchLoadedItemSearch');
      await item.fill(fixture.prefix);await expect(f.page.locator('[data-action="select-loaded-order"]')).toHaveCount(2);
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      await query('UPDATE sales_orders SET customer=$2 WHERE netsuite_id=$1',[fixture.ids[0],'Fresh '+surface]);
      await f.page.locator('[data-action="refresh-loaded-orders"]').click();
      await expect(f.page.locator(f.config.detail)).toContainText('Fresh '+surface);
      await f.page.locator('[data-action="apply-loaded-filters"]').click();
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      // Switch while a new search is still debouncing; it must not restore old results.
      await item.fill('NO-MATCH-'+fixture.prefix);
      await f.page.locator('[data-action="yard-direction"][data-direction="inbound"]').click();
      await expect(item).toHaveValue('');
      await expect(f.page.locator(f.config.detail)).not.toContainText(fixture.refs[0]);
      await f.page.locator('[data-action="yard-direction"][data-direction="outbound"]').click();
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      await f.page.locator('[data-action="yard-type"][data-order-type="transfer_order"]').click();
      await expect(f.page.locator('[data-action="select-loaded-order"]')).toHaveCount(0);
      await f.page.locator('[data-action="yard-type"][data-order-type="sales_order"]').click();
      await expect(f.page.locator(f.config.detail)).toContainText(fixture.refs[0]);
      assert.deepEqual(f.errors,[]);
    } finally {await query("UPDATE sales_orders SET customer='Performance Customer' WHERE netsuite_id=$1",[fixture.ids[0]]);await f.finish();}
  });
}
test('U3: Control history starts without loading unrelated sections',async()=>{
  const f=await open('control');
  // The shared sidebar independently loads navigation, alerts and its event stream.
  const shellPaths=new Set(['/api/navigation/menu-order','/api/scm/stock-requests/alerts','/api/events']);
  try{assert.deepEqual(f.calls.filter(path=>!shellPaths.has(path)&&!path.startsWith('/api/auth/')&&!path.startsWith('/api/control/loaded-orders')),[]);}
  finally{await f.finish();}
});
test('A1: real HTTP keeps Sales store and Dispatch Sales-user yard permissions',async()=>{
  const params=new URLSearchParams({...fixture.range,direction:'inbound',orderType:'purchase_order',orderId:String(fixture.ids[0]+11)});
  for(const api of [surfaces.sales.api,surfaces.dispatch.api]) {
    const url=base+api+'/detail?'+params;
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+fixture.sessions.sales.token}})).status,404);
  }
  const salesParams=new URLSearchParams({...fixture.range,direction:'outbound',orderType:'sales_order',orderId:String(fixture.ids[0])});
  const allowed=await fetch(base+surfaces.sales.api+'/detail?'+salesParams,{headers:{Authorization:'Bearer '+fixture.sessions.sales.token}});
  assert.equal(allowed.status,200);assert.equal((await allowed.json()).order.tranid,fixture.refs[0]);
});
