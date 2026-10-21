/* global window, document, localStorage, EventTarget, Event, MessageEvent, MutationObserver */
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';

const out = 'test-artifacts/stock-request-view-20261006';
let browser;
const timings = [];
const measured=[];
before(async () => {await mkdir(out, {recursive:true});browser = await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async () => {await browser?.close();await writeFile(`${out}/click-timings.json`, JSON.stringify(timings,null,2));await writeFile('test-artifacts/stocking-replies-20261006/view-browser-coverage.json',JSON.stringify(measured));});
const deferred = () => {let resolve;const promise = new Promise(done => {resolve = done;});return {promise,resolve};};

function record(id, audience, kind) {
  if (kind === 'special') return {id,requestRef:`SPREQ-${id}`,revision:1,stage:'new_enquiry',closeStatus:'active',storeLocationId:1,storeName:'3445',
    customerName:`Customer ${id}`,vendorName:'Vendor',vendorId:123,inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',
    lines:[{id:id*10,productName:`Product ${id}`,quantity:2,uom:'PLT',salesDecision:'pending',supplyStatus:null,vendorYard:'Vendor yard'}],
    salesOrderLines:[],purchaseOrderLines:[],events:[],media:[],readinessAlerts:[]};
  const sales = audience === 'sales';
  return {id,requestRef:`REQ-${id}`,revision:1,workflowVersion:sales ? 2 : 1,requestedBy:'viewer',requestedByName:'Viewer',
    destinationLocationId:28,destinationName:'150',bucket:sales ? 'accepted' : 'pending',status:'active',updatedAt:'2026-10-06T00:00:00Z',
    regular:sales ? {deliveryMethod:'pickup',approvalExpiresAt:'2099-01-01T00:00:00Z',approval:{automatic:false,lines:[]}} : {},
    lines:[{id:id*10,itemId:1000+id,itemName:`Product ${id}`,sourceLocationId:1,sourceName:'3445',destinationLocationId:28,destinationName:'150',
      salesQty:10,salesUom:'PCS',quantityMode:'conversion',toPcs:1,pieces:10,pallets:0,layers:0,sections:0,
      status:sales ? 'approved' : 'submitted',decision:sales ? 'stock' : null}],transfers:[],events:[],availability:[]};
}

async function fixture(audience, kind) {
  const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addInitScript(() => {
    localStorage.setItem('mbbs.staff.token','view-test');localStorage.setItem('mbbs.sales.stockRequests.bucket','accepted');
    window.viewEvents = [];window.viewIntervals = [];
    window.EventSource = class extends EventTarget {constructor(url) {super();this.url=url;window.viewEvents.push(this);}close() {this.closed=true;}};
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback,ms,...args) => {window.viewIntervals.push({callback,ms});return interval(callback,ms,...args);};
  });
  const page = await context.newPage();page.setDefaultTimeout(6000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const state = {records:Array.from({length:60},(_,i)=>record(i+1,audience,kind)),calls:[],errors:[],holds:new Map(),fail:false,detailFailures:new Set()};
  state.pools = [1,2,3].map(id=>({id,revision:1,purchaseOrderRef:`PO-${id}`,itemCode:`ITEM-${id}`,itemName:'Waitlist material',salesUom:'PCS',
    capacityQty:100,heldQty:0,convertedQty:0,availableQty:100,allocations:[],requests:[{id:100+id,revision:1,requestRef:`WAIT-${id}`,customerName:'Customer',sellingYard:'3445',waitingQty:10,createdAt:'2026-10-06T00:00:00Z'}]}));
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/*',async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      state.calls.push({path,method:route.request().method()});
      if (path === '/api/auth/me') return route.fulfill({json:{operator:{id:'viewer',display_name:'Viewer',role:audience,roles:[audience],yardLocationIds:[1,28]}}});
      if (path === '/api/navigation/menu-order') return route.fulfill({json:{revision:1,orders:{}}});
      if (path.endsWith('/policy')) return route.fulfill({json:{enabled:true,allowOverAvailability:false,revision:1}});
      if (path.endsWith('/sales-reps')) return route.fulfill({json:{salesReps:[]}});
      if (path === '/api/scm/waitlist/pools') return route.fulfill({json:{pools:state.pools}});
      if (path === '/api/scm/waitlist/requests') return route.fulfill({json:{requests:[]}});
      if (/\/waitlist\/pools\/\d+$/.test(path)) {
        const id=Number(path.split('/').at(-1)),payload=structuredClone(state.pools.find(pool=>pool.id===id));
        await state.holds.get(id)?.promise;
        if(state.detailFailures.has(id))return route.fulfill({status:503,json:{error:'Detail temporarily unavailable'}}).catch(()=>{});
        return route.fulfill({json:payload}).catch(()=>{});
      }
      const prefix = `/api/${audience}/${kind === 'special' ? 'special-stock-requests' : 'stock-requests'}`;
      if (path === prefix) return route.fulfill({status:state.fail ? 503 : 200,json:state.fail ? {error:'Queue temporarily unavailable'} :
        {requests:state.records,yards:[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'150'}],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      if (/\/stock-requests\/\d+$/.test(path) || /\/special-stock-requests\/\d+$/.test(path)) {
        const id = Number(path.split('/').at(-1)), payload = structuredClone(state.records.find(row=>row.id===id));
        await state.holds.get(id)?.promise;
        if(state.detailFailures.has(id))return route.fulfill({status:503,json:{error:'Detail temporarily unavailable'}}).catch(()=>{});
        return route.fulfill({json:payload}).catch(()=>{});
      }
      return route.fulfill({json:{requests:[],yards:[],total:0,count:0,unread:0,orders:[]}});
    }
    const file = ({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path] || path;
    try {return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)] || 'application/octet-stream'});}
    catch {return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=${kind}`);
  if (kind === 'waitlist') {
    await expect(page.locator('.waitlist-pool-list [data-waitlist-pool]')).toHaveCount(3);
    await page.locator('.waitlist-pool-list [data-waitlist-pool="1"]').click();
  } else {
    await expect(page.locator('.stock-request-card')).toHaveCount(60);
    await expect(page.locator('.stock-request-detail h2')).toHaveText(`${kind === 'special' ? 'SPREQ' : 'REQ'}-1`);
  }
  await page.waitForLoadState('networkidle');
  return {page,state,close:async()=>{for(const gate of state.holds.values()) gate.resolve();measured.push(...await page.coverage.stopJSCoverage());await context.close();}};
}

async function emit(page, type, payload = {}) {
  await page.evaluate(({type,payload})=>{
    for(const source of window.viewEvents.filter(source=>!source.closed)) source.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type,payload})}));
  },{type,payload});
}
async function freeze(page) {
  await page.evaluate(()=>{
    const pool=document.querySelector('.stock-request-list'), detail=document.querySelector('.stock-request-detail');
    pool.scrollTop=120;
    window.viewFrozen={pool,detail,child:detail.firstElementChild,cards:[...pool.children],toolbar:document.querySelector('.stock-request-toolbar'),scroll:pool.scrollTop,mutations:0};
    new MutationObserver(entries=>{window.viewFrozen.mutations+=entries.length;}).observe(pool,{childList:true,subtree:true});
    new MutationObserver(entries=>{window.viewFrozen.mutations+=entries.length;}).observe(detail,{childList:true,subtree:true});
  });
}
async function preserved(page) {
  assert.equal(await page.evaluate(()=>{
    const saved=window.viewFrozen;
    return saved.pool===document.querySelector('.stock-request-list') && saved.detail===document.querySelector('.stock-request-detail')
      && saved.child===saved.detail.firstElementChild && saved.toolbar===document.querySelector('.stock-request-toolbar')
      && saved.cards.every((node,i)=>node===saved.pool.children[i]) && saved.scroll===saved.pool.scrollTop && saved.mutations===0;
  }),true,'background updates must retain the actual pool and detail nodes');
}

for (const audience of ['sales','scm']) for (const kind of ['regular','special']) {
  test(`${audience} ${kind}: events, focus and polling preserve the pool, details and edits`,async()=>{
    const f = await fixture(audience,kind), {page,state} = f;
    try {
      const input = page.locator('.stock-request-detail input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=date]):not([type=number]):visible:enabled,.stock-request-detail textarea:visible:enabled').first();
      if (await input.count()) {await input.fill('Unsaved review');await input.focus();}
      await freeze(page);
      const calls=state.calls.filter(row=>/\/(?:special-)?stock-requests(?:\?|$|\/\d+$)/.test(row.path)).length;
      await emit(page,'scm.smart.updated');await emit(page,'dispatch.orders.updated',{orderId:999999});
      await page.waitForTimeout(450);await preserved(page);
      assert.equal(state.calls.filter(row=>/\/(?:special-)?stock-requests(?:\?|$|\/\d+$)/.test(row.path)).length,calls);
      state.records[0].revision++;state.records[0].customerName='Changed customer';
      await emit(page,`${kind === 'special' ? 'special-' : ''}stock-request.updated`,{requestId:1});
      await expect(page.locator('[data-stock-background-update]')).toContainText('Updates available');
      await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));for(const entry of window.viewIntervals.filter(row=>row.ms===60000)) entry.callback();});
      await page.waitForTimeout(450);await preserved(page);
      if (await input.count()) {await expect(input).toHaveValue('Unsaved review');await expect(input).toBeFocused();}
      assert.deepEqual(state.errors,[]);
    } finally {await f.close();}
  });

  test(`${audience} ${kind}: clicking a card paints cached details before any detail response and retains every pool card`,async()=>{
    const f = await fixture(audience,kind), {page,state} = f;
    try {
      const gate=deferred();state.holds.set(2,gate);
      const calls=state.calls.filter(row=>row.path.endsWith(`/${kind === 'special' ? 'special-stock-requests' : 'stock-requests'}`)).length;
      await page.evaluate(()=>{window.clickPool=document.querySelector('.stock-request-list');window.clickCards=[...window.clickPool.children];});
      const timing=await page.evaluate(()=>{
        const start=performance.now();document.querySelector('.stock-request-card[data-id="2"]').click();
        return {milliseconds:performance.now()-start,heading:document.querySelector('.stock-request-detail h2')?.textContent};
      });
      assert.equal(timing.heading,`${kind === 'special' ? 'SPREQ' : 'REQ'}-2`,'detail must be visible synchronously while the response is held');
      timings.push({audience,kind,...timing});
      assert.equal(await page.evaluate(()=>window.clickPool===document.querySelector('.stock-request-list')&&window.clickCards.every((node,i)=>node===window.clickPool.children[i])),true);
      gate.resolve();await page.waitForLoadState('networkidle');
      const after=state.calls.length;await page.locator('.stock-request-card[data-id="2"]').click();await page.waitForTimeout(100);
      assert.equal(state.calls.length,after,'clicking the selected card must be a no-op');
      assert.equal(state.calls.filter(row=>row.path.endsWith(`/${kind === 'special' ? 'special-stock-requests' : 'stock-requests'}`)).length,calls,'selection must not reload the queue');
      assert.deepEqual(state.errors,[]);
    } finally {await f.close();}
  });
}

for (const audience of ['sales','scm']) {
  test(`${audience} Regular: a failed enrichment retains cached detail, pool and an edited field`,async()=>{
    const f=await fixture(audience,'regular'),{page,state}=f;
    try {
      const gate=deferred();state.holds.set(2,gate);state.detailFailures.add(2);
      await page.locator('.stock-request-card[data-id="2"]').click();
      const input=page.locator(audience==='sales'?'[data-regular-so]':'[data-scm-stock-quantity="pieces"]').first();
      await input.fill(audience==='sales'?'DRAFT-SO':'37');await input.focus();await freeze(page);
      gate.resolve();await expect(page.locator('[data-stock-detail-error]')).toContainText('Detail temporarily unavailable');
      await preserved(page);await expect(input).toHaveValue(audience==='sales'?'DRAFT-SO':'37');await expect(input).toBeFocused();
      assert.deepEqual(state.errors,[]);
    }finally{await f.close();}
  });
  test(`${audience} Regular: late detail responses cannot replace a newer selection or an edited input`,async()=>{
    const f = await fixture(audience,'regular'),{page,state}=f;
    try {
      const two=deferred(),three=deferred();state.holds.set(2,two);state.holds.set(3,three);
      await page.locator('.stock-request-card[data-id="2"]').click();await page.locator('.stock-request-card[data-id="3"]').click();
      await expect(page.locator('.stock-request-detail h2')).toHaveText('REQ-3');
      three.resolve();await page.waitForTimeout(150);two.resolve();await page.waitForLoadState('networkidle');
      await expect(page.locator('.stock-request-detail h2')).toHaveText('REQ-3');
      const again=deferred();state.holds.set(2,again);await page.locator('.stock-request-card[data-id="2"]').click();
      const input=page.locator(audience==='sales' ? '[data-regular-so]' : '[data-scm-stock-quantity="pieces"]').first();
      await input.fill(audience==='sales' ? 'DRAFT-SO' : '37');await input.focus();
      await freeze(page);again.resolve();await page.waitForLoadState('networkidle');await preserved(page);
      await expect(input).toHaveValue(audience==='sales' ? 'DRAFT-SO' : '37');await expect(input).toBeFocused();
      assert.deepEqual(state.errors,[]);
    } finally {await f.close();}
  });
}

test('explicit Refresh applies the latest Special case, keeps selection and clears the update notice',async()=>{
  const f=await fixture('scm','special'),{page,state}=f;
  try {
    state.records[0].customerName='Updated customer';state.records[0].revision++;
    await emit(page,'special-stock-request.updated');await expect(page.locator('[data-stock-background-update]')).toBeVisible();
    await page.locator('[data-special-scm-action="refresh"]').click();
    await expect(page.locator('.stock-request-detail')).toContainText('Updated customer');
    await expect(page.locator('[data-stock-background-update]')).toHaveCount(0);
    assert.deepEqual(state.errors,[]);
    await page.screenshot({path:`${out}/scm-refreshed.png`});
  } finally {await f.close();}
});

test('failed Special background checks preserve the last view; a later explicit Refresh recovers',async()=>{
  const f=await fixture('sales','special'),{page,state}=f;
  try {
    await freeze(page);state.fail=true;
    await page.evaluate(()=>{for(const entry of window.viewIntervals.filter(row=>row.ms===60000)) entry.callback();});
    await page.waitForTimeout(150);await preserved(page);
    state.fail=false;state.records[0].customerName='Recovered customer';
    await emit(page,'special-stock-request.updated');await page.locator('[data-special-sales-action="refresh"]').click();
    await expect(page.locator('.stock-request-detail')).toContainText('Recovered customer');assert.deepEqual(state.errors,[]);
  } finally {await f.close();}
});

test('SCM Waitlist: background updates preserve the pool and allocation form, and another pool opens before its response',async()=>{
  const f=await fixture('scm','waitlist'),{page,state}=f;
  try {
    const reason=page.locator('[data-waitlist-override]');await reason.fill('Unsaved priority review');await reason.focus();
    await page.evaluate(()=>{const list=document.querySelector('.waitlist-pool-list'),panel=document.querySelector('.waitlist-layout>div');window.waitlistFrozen={list,panel,child:panel.firstElementChild,cards:[...list.children],reason:document.querySelector('[data-waitlist-override]')};});
    state.pools[0].availableQty=99;
    await page.evaluate(()=>{for(const entry of window.viewIntervals.filter(row=>row.ms===15000)) entry.callback();});
    await expect(page.locator('[data-stock-background-update]')).toBeVisible();
    await emit(page,'stock-request.updated');
    assert.equal(await page.evaluate(()=>{const saved=window.waitlistFrozen;return saved.list===document.querySelector('.waitlist-pool-list')&&saved.panel===document.querySelector('.waitlist-layout>div')&&saved.child===saved.panel.firstElementChild&&saved.reason===document.querySelector('[data-waitlist-override]')&&saved.cards.every((card,i)=>card===saved.list.children[i]);}),true);
    await expect(reason).toHaveValue('Unsaved priority review');await expect(reason).toBeFocused();
    const gate=deferred();state.holds.set(2,gate);
    const timing=await page.evaluate(()=>{const start=performance.now();document.querySelector('.waitlist-pool-list [data-waitlist-pool="2"]').click();return {milliseconds:performance.now()-start,heading:document.querySelector('.waitlist-layout h2').textContent};});
    assert.equal(timing.heading,'PO-2 · ITEM-2');timings.push({audience:'scm',kind:'waitlist',...timing});
    assert.equal(await page.evaluate(()=>window.waitlistFrozen.list===document.querySelector('.waitlist-pool-list')&&window.waitlistFrozen.cards.every((card,i)=>card===window.waitlistFrozen.list.children[i])),true);
    gate.resolve();await page.waitForLoadState('networkidle');
    await page.locator('[data-waitlist-refresh]').click();await expect(page.locator('[data-stock-background-update]')).toHaveCount(0);
    assert.deepEqual(state.errors,[]);
  } finally {await f.close();}
});

test('SCM Waitlist: a failed old pool response cannot disturb the current pool or allocation form',async()=>{
  const f=await fixture('scm','waitlist'),{page,state}=f;
  try {
    const gate=deferred();state.holds.set(2,gate);state.detailFailures.add(2);
    await page.locator('.waitlist-pool-list [data-waitlist-pool="2"]').click();
    await page.locator('.waitlist-pool-list [data-waitlist-pool="3"]').click();
    const reason=page.locator('[data-waitlist-override]');await reason.fill('Current pool review');await reason.focus();
    await page.evaluate(()=>window.lastPoolDetail=document.querySelector('.waitlist-layout>div').firstElementChild);
    gate.resolve();await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(()=>window.lastPoolDetail===document.querySelector('.waitlist-layout>div').firstElementChild),true);
    await expect(page.locator('.waitlist-layout h2')).toHaveText('PO-3 · ITEM-3');await expect(reason).toHaveValue('Current pool review');
    assert.deepEqual(state.errors,[]);
  }finally{await f.close();}
});
