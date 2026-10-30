import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';

for(const abortSupported of [true,false]) test(`customer and contract selection: immediate feedback, summary payload, one detail request, stale responses ignored and failures retryable (transport abort ${abortSupported})`,async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const gates=new Map(),requests=[];
  const hold=path=>{let release;const promise=new Promise(resolve=>{release=resolve;});gates.set(path,promise);return ()=>{gates.delete(path);release();};};
  try {
    const page=await browser.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage();
    if(!abortSupported) await page.addInitScript(()=>{
      // Simulate a transport that has already received a response when cancellation arrives.
      const originalFetch=window.fetch;
      window.fetch=(url,options={})=>originalFetch(url,{...options,signal:undefined});
    });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const customers=[{customerNetsuiteId:'1',displayName:'Alpha'},{customerNetsuiteId:'2',displayName:'Beta'}];
    const contract=id=>({contractId:id,contractNumber:`Contract ${id}`,status:'active',revision:1,
      pricing:{currency:'CAD',totalMinor:10000,subtotalMinor:10000,taxMinor:0,lines:[]},customer:{displayName:'Beta'}});
    let fail=false,failCustomer=false;
    await page.route('http://frontdesk.test/**',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(!path.startsWith('/api/')) {
        if(['/app-sidebar.js','/mbt-shell.js'].includes(path)) return route.fulfill({contentType:'text/javascript',body:''});
        const file=path==='/mbt/frontdesk'?'public/mbt-frontdesk.html':`public${path}`;
        try {return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:readFileSync(file)});}
        catch {return route.fulfill({status:404,body:''});}
      }
      requests.push(url);
      if(gates.has(path)) await gates.get(path);
      let body={};
      if(path.endsWith('/status')) body={enabled:true};
      else if(path.endsWith('/configuration')) body={services:[],binItems:[],deliveryItems:[]};
      else if(path.endsWith('/overdue-bins')) body={items:[]};
      else if(path.endsWith('/customers')) body={items:customers.filter(c=>c.displayName.toLowerCase().includes(url.searchParams.get('query').toLowerCase()))};
      else if(path.includes('/customers/')) {
        if(failCustomer) return route.fulfill({status:503,json:{error:'Unable to load customer contracts'}}).catch(()=>{});
        body={items:(path.includes('/1/')?['A1']:['B1','B2']).map(id=>({...contract(id),openServiceLineCount:0}))};
      }
      else if(path.endsWith('/charge-requests')) body={items:[]};
      else if(path.includes('/contracts/')) {
        if(fail) return route.fulfill({status:503,json:{error:'Unable to load this contract'}}).catch(()=>{});
        body={contract:contract(path.split('/').at(-1)),serviceLines:[],visits:[],amendments:[],chargeRequests:[],dumpCharges:[]};
      }
      await route.fulfill({json:body}).catch(()=>{});
    });
    await page.goto('http://frontdesk.test/mbt/frontdesk');await expect(page.locator('#frontdeskMessage')).toContainText('ready');
    const resumeAlpha=hold('/api/mbt/frontdesk/customers/1/contracts');
    await page.locator('#customerSearch').fill('Alpha');await page.locator('#customerResults button').click();
    await expect(page.locator('#contractMaster')).toHaveAttribute('aria-busy','true');
    await expect(page.locator('#contractMaster')).toContainText('Loading');
    await page.locator('#customerSearch').fill('Beta');await page.locator('#customerResults button').filter({hasText:'Beta'}).click();
    await expect(page.locator('#contractMaster')).toContainText('Contract B2');resumeAlpha();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    await expect(page.locator('#contractMaster')).not.toContainText('Contract A1');
    assert(requests.filter(url=>url.pathname.includes('/customers/')).every(url=>url.searchParams.get('summary')==='true'));
    const resumeB1=hold('/api/mbt/frontdesk/contracts/B1'),resumeB2=hold('/api/mbt/frontdesk/contracts/B2');
    await page.getByRole('button',{name:/Contract B1/}).click();
    await expect(page.locator('#contractCard')).toHaveAttribute('aria-busy','true');
    await expect(page.getByRole('button',{name:/Contract B1/})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:/Contract B2/}).dblclick();
    await expect.poll(()=>requests.filter(url=>url.pathname.endsWith('/contracts/B2')).length).toBe(1);
    resumeB2();await expect(page.locator('#contractCard')).toContainText('Contract B2');resumeB1();
    await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(page.locator('#contractCard')).not.toContainText('Contract B1');
    assert.equal(requests.filter(url=>url.pathname.endsWith('/charge-requests')).length,0);
    fail=true;await page.getByRole('button',{name:/Contract B1/}).click();
    await expect(page.locator('#frontdeskMessage')).toContainText('Unable to load this contract');
    await expect(page.locator('#contractCard')).not.toContainText('Contract B2');
    fail=false;await page.getByRole('button',{name:/Contract B1/}).click();await expect(page.locator('#contractCard')).toContainText('Contract B1');
    failCustomer=true;await page.locator('#customerSearch').fill('Alpha');await page.locator('#customerResults button').filter({hasText:'Alpha'}).click();
    await expect(page.locator('#contractMaster')).toContainText('Unable to load customer contracts');
    await expect(page.locator('#contractCard')).not.toBeVisible();
    failCustomer=false;await page.getByRole('button',{name:'Retry contracts',exact:true}).click();
    await expect(page.locator('#contractMaster')).toContainText('Contract A1');
    await expect(page.locator('#frontdeskMessage')).not.toContainText('Unable to load customer contracts');
    await page.locator('#openNewContractOrder').click();await page.locator('#orderKind').selectOption('bin');
    await page.locator('#createQuoteButton').click();
    await expect(page.locator('#frontdeskMessage')).toContainText('Activate an MBT rate card');
    await expect(page.locator('#customerChargeDialog')).not.toBeVisible();
    assert.deepEqual(errors,[]);
    writeFileSync(`test-artifacts/frontdesk-selection-${abortSupported}-browser-v8.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally {await browser.close();}
});
