import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';

let browser;
before(async () => {browser = await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async () => {await browser?.close();});

function record(id, tab) {
  const closed = id === 106;
  const common = {id,requestRef:`${tab === 'special' ? 'SPREQ' : 'STREQ'}-${id}`,revision:1,requestedBy:'viewer',requestedByName:'Viewer',
    stage:closed ? 'closed' : 'new_enquiry',closeStatus:closed ? 'closed' : 'active',vendorName:'Vendor',storeLocationId:1,storeName:'3445',
    customerName:'Customer',fulfillmentMethod:'yard_pickup',inquiryDate:'2099-01-01',events:[],media:[],readinessAlerts:[],salesOrderLines:[],purchaseOrderLines:[]};
  if (tab === 'special') return {...common,lines:[{id:id*10,productName:'Material',quantity:2,uom:'PCS',salesDecision:'pending',requiredDate:'2099-02-01'}]};
  return {...common,workflowVersion:2,requestType:'regular',status:closed ? 'closed' : 'submitted',bucket:closed ? 'completed' : 'pending',
    destinationLocationId:1,destinationName:'3445',regular:{deliveryMethod:'pickup'},transfers:[],availability:[],
    lines:[{id:id*10,itemId:1000+id,itemName:'Material',sourceLocationId:1,sourceName:'3445',destinationLocationId:1,destinationName:'3445',
      salesQty:2,salesUom:'PCS',quantityMode:'conversion',toPcs:1,pieces:2,pallets:0,layers:0,sections:0,status:closed ? 'closed' : 'submitted'}]};
}

async function fixture(audience, tab, {alerts=true, count=105, failure=false, returnedPools=[]}={}) {
  const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
  const prefs = tab === 'special' ? {stages:['closed'],storeLocationIds:[1],vendorNames:['Vendor'],...(audience === 'sales' ? {mine:true} : {})}
    : {unifiedStatus:'closed',outcome:'',waitingReason:'',requestTypeFilter:audience === 'sales' ? ['pickup'] : 'pickup',
      vendorFilter:audience === 'sales' ? ['Vendor'] : 'Vendor',sourceLocationFilter:'1'};
  const key = `mbbs.${audience}.${tab}.requestFilters.viewer`;
  await context.addInitScript(({key,prefs}) => {
    localStorage.setItem('mbbs.staff.token','alert-search-session');
    if (!localStorage.getItem(key)) localStorage.setItem(key,JSON.stringify(prefs));
    localStorage.setItem(key.replace('.viewer','.other-user'),JSON.stringify({sentinel:'another account'}));
    window.MBBSOSNotifications = {allowsRole:()=>false,notify:async()=>false};
    window.EventSource = class extends EventTarget {close() {}};
  }, {key,prefs});
  const page = await context.newPage();page.setDefaultTimeout(10000);
  const state = {rows:Array.from({length:106},(_,i)=>record(i+1,tab)),calls:[],errors:[],failure,hold:null};
  page.on('pageerror', error => state.errors.push(error.message));
  const prefix = `/api/${audience}/${tab === 'special' ? 'special-stock-requests' : 'stock-requests'}`;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      state.calls.push({path,params:Object.fromEntries(url.searchParams),method:route.request().method()});
      if (path === '/api/auth/me') return route.fulfill({json:{operator:{id:'viewer',display_name:'Viewer',role:audience,roles:[audience],yardLocationIds:[1]}}});
      if (path === prefix + '/alerts') {
        if (url.searchParams.get('includeRequests') === '1') {
          await state.hold;
          if (state.failure) return route.fulfill({status:503,json:{error:'Updates temporarily unavailable'}});
        }
        const requests = state.rows.slice(0,count);
        return route.fulfill({json:{total:count,newRequests:count,confirmedOrders:0,pendingUpdate:count,awaitCustomerConfirmation:0,dispatchArrangement:0,waitForProduction:0,requests,returnedPools}});
      }
      if (path.endsWith('/policy')) return route.fulfill({json:{enabled:true,revision:1,allowOverAvailability:false}});
      if (path === prefix) {
        let rows = state.rows;
        if (url.searchParams.get('search')) {
          const refs = url.searchParams.get('search').split(/[,\s]+/);
          rows = rows.filter(row => refs.includes(row.requestRef));
        }
        if (url.searchParams.get('stages') === 'closed' || url.searchParams.get('unifiedStatus') === 'closed') rows = rows.filter(row => row.id === 106);
        rows = rows.slice(0,Number(url.searchParams.get('limit') || (tab === 'special' ? 60 : 100)));
        return route.fulfill({json:{requests:rows,yards:[{locationId:1,yardCode:'3445'}],vendors:['Vendor'],filterOptions:{vendors:['Vendor'],sourceYards:[{locationId:1,yardCode:'3445'}],destinationYards:[]}}});
      }
      if (new RegExp(`^${prefix}/\\d+$`).test(path)) return route.fulfill({json:state.rows.find(row=>row.id === Number(path.split('/').at(-1)))});
      return route.fulfill({json:{requests:[],yards:[],vendors:[],orders:[],salesReps:[],total:0,count:0,alerts:[]}});
    }
    const file = path === `/${audience}/stock-requests` ? `/${audience}-stock-requests.html` : path;
    try {return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)] || 'application/octet-stream'});}
    catch {return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=${tab}${alerts ? '&alerts=1' : ''}`);
  const search = page.locator(tab === 'special' ? (audience === 'sales' ? '[data-special-search]' : '[data-special-scm-search]') : `[data-${audience}-stock-search]`);
  return {page,context,state,key,prefs,prefix,search,async close(){await context.close();}};
}

for (const audience of ['sales','scm']) for (const tab of ['special','regular']) {
  test(`${audience} ${tab}: all alert requests appear in search; clearing restores account filters`, async () => {
    const f = await fixture(audience,tab);
    try {
      await expect(f.search).toHaveValue(f.state.rows.slice(0,105).map(row=>row.requestRef).join(', '));
      await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(105);
      await expect(f.page.locator('[data-stock-request-alert-list],dialog[open]')).toHaveCount(0);
      const queries = f.state.calls.filter(call=>call.path===f.prefix);
      assert.ok(queries.length >= 2);
      assert.ok(queries.every(call=>Number(call.params.limit) <= 100));
      if (tab === 'special') {
        await expect(f.page.locator(`[data-special${audience === 'scm' ? '-scm' : ''}-stage][value=closed]`)).toBeChecked();
        if (audience === 'sales') await expect(f.page.locator('[data-special-mine]')).toBeChecked();
      } else await expect(f.page.locator(`[data-${audience}-stock-filter=unifiedStatus][value=closed]`)).toBeChecked();
      const saved = await f.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),f.key);
      for (const [key,value] of Object.entries(f.prefs)) assert.deepEqual(saved[key],value);
      await f.search.fill('');
      await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
      await expect(f.page.locator('.stock-request-list')).toContainText(f.state.rows[105].requestRef);
      const last = f.state.calls.filter(call=>call.path===f.prefix).at(-1).params;
      assert.equal(last[tab === 'special' ? 'stages' : 'unifiedStatus'],'closed');
      assert.equal(last.search || '','');
      assert.equal(new URL(f.page.url()).searchParams.has('alerts'),false);
      assert.deepEqual(await f.page.evaluate(key=>JSON.parse(localStorage.getItem(key.replace('.viewer','.other-user'))),f.key),{sentinel:'another account'});
      await f.page.reload();
      await expect(f.search).toHaveValue('');
      await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
      assert.deepEqual(f.state.errors,[]);
    } finally {await f.close();}
  });
}

test('Opening the badge from the request page keeps current filters through navigation', async () => {
  const f = await fixture('sales','special',{alerts:false,count:2});
  try {
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
    await f.page.locator('.sales-special-alert').click();
    await expect(f.search).toHaveValue('SPREQ-1, SPREQ-2');
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(2);
    await f.search.fill('');
    await expect(f.page.locator('[data-special-stage][value=closed]')).toBeChecked();
    await expect(f.page.locator('[data-special-mine]')).toBeChecked();
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.close();}
});

test('A failed alert lookup displays an inline error and never substitutes an unfiltered queue', async () => {
  const f = await fixture('scm','special',{failure:true});
  try {
    await expect(f.page.locator('.stock-request-error')).toContainText('Updates temporarily unavailable');
    assert.equal(f.state.calls.filter(call=>call.path===f.prefix).length,0);
    await expect(f.page.locator('[data-stock-request-alert-list]')).toHaveCount(0);
    f.state.failure = false;
    await f.page.reload();
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(105);
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.close();}
});

for (const audience of ['sales','scm']) test(`${audience} direct request alerts also preserve saved filters after clearing`, async () => {
  const f = await fixture(audience,'regular',{alerts:false,count:2});
  try {
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
    await f.page.goto(`http://localhost/${audience}/stock-requests?tab=regular&requestId=1`);
    await expect(f.search).toHaveValue('STREQ-1');
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
    await expect(f.page.locator('.stock-request-list')).toContainText('STREQ-1');
    await f.search.fill('');
    await expect(f.page.locator('.stock-request-list')).toContainText('STREQ-106');
    await expect(f.page.locator(`[data-${audience}-stock-filter=unifiedStatus][value=closed]`)).toBeChecked();
    assert.equal(new URL(f.page.url()).searchParams.has('requestId'),false);
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.close();}
});

test('A cleared alert queue returns to the saved filter view', async () => {
  const f = await fixture('sales','special',{count:0});
  try {
    await expect(f.search).toHaveValue('');
    await expect(f.page.locator('.stock-request-list .stock-request-card')).toHaveCount(1);
    await expect(f.page.locator('[data-special-stage][value=closed]')).toBeChecked();
    assert.equal(new URL(f.page.url()).searchParams.has('alerts'),false);
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.close();}
});

test('Returned waitlist alerts remain accessible from the regular request page', async () => {
  const f = await fixture('scm','regular',{count:0,returnedPools:[{id:81,purchaseOrderRef:'PO-81',itemCode:'Stone'}]});
  try {
    await expect(f.page.locator('[data-returned-stock-alerts] a')).toHaveAttribute('href','/scm/stock-requests?tab=waitlist&poolId=81');
    await expect(f.page.locator('[data-returned-stock-alerts]')).toContainText('PO-81');
    await expect(f.page.locator('[data-stock-request-alert-list]')).toHaveCount(0);
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.close();}
});
