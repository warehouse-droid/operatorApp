/* global window, document, localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

const out='test-artifacts/special-request-editing-20261006/scroll';
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());

function record(audience,kind) {
  const events=Array.from({length:20},(_,i)=>({id:i+1,eventType:'audit_entry_'+i,actorName:'TEST Audit '+i,createdAt:'2026-10-06T12:00:00Z',details:{}}));
  if(kind==='special')return {id:1,requestRef:'SPREQ-SCROLL',revision:1,stage:'new_enquiry',closeStatus:'active',
    storeLocationId:1,storeName:'3445',customerName:'TEST Customer',vendorName:'TEST Vendor',vendorId:331,
    inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',remarks:'Long note\n'.repeat(600),lines:Array.from({length:40},(_,i)=>({
      id:i+10,productName:'TEST Product '+i,quantity:2,uom:'PLT',salesDecision:'pending',supplyStatus:null,vendorYard:'TEST Yard'})),
    salesOrderLines:[],purchaseOrderLines:[],events,media:[],readinessAlerts:[]};
  const sales=audience==='sales';
  return {id:1,requestRef:'REQ-SCROLL',revision:1,workflowVersion:sales?2:1,requestedBy:'viewer',requestedByName:'TEST Viewer',
    destinationLocationId:28,destinationName:'150',bucket:sales?'accepted':'pending',status:'active',updatedAt:'2026-10-06T00:00:00Z',
    regular:sales?{deliveryMethod:'pickup',approvalExpiresAt:'2099-01-01T00:00:00Z',approval:{automatic:false,lines:[]}}:{},
    lines:Array.from({length:40},(_,i)=>({id:i+10,itemId:i+1000,itemName:'TEST Product '+i,sourceLocationId:1,sourceName:'3445',
      destinationLocationId:28,destinationName:'150',salesQty:10,salesUom:'PCS',quantityMode:'conversion',toPcs:1,pieces:10,
      pallets:0,layers:0,sections:0,status:sales?'approved':'submitted',decision:sales?'stock':null})),
    transfers:[],events,availability:[]};
}

async function fixture(audience,kind,width,height=800) {
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-audit-scroll'));
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const errors=[],detail=record(audience,kind);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const {pathname:path,hostname}=new URL(route.request().url());if(hostname!=='localhost')return route.abort();
    if(path.startsWith('/api/')) {
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'viewer',display_name:'TEST Viewer',role:audience,roles:[audience],yardLocationIds:[1,28]}}});
      if(path==='/api/navigation/menu-order')return route.fulfill({json:{revision:1,orders:{}}});
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true,allowOverAvailability:false,revision:1}});
      const prefix=`/api/${audience}/${kind==='special'?'special-stock-requests':'stock-requests'}`;
      if(path===prefix)return route.fulfill({json:{requests:[detail],yards:[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'150'}],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      if(path===prefix+'/1')return route.fulfill({json:detail});
      return route.fulfill({json:{requests:[],yards:[],total:0,count:0,unread:0,orders:[],salesReps:[]}});
    }
    const file=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path]||path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=${kind}`);
  await expect(page.locator('.stock-request-detail h2')).toHaveText(kind==='special'?'SPREQ-SCROLL':'REQ-SCROLL');
  await page.waitForLoadState('networkidle');
  return {page,close:async()=>{assert.deepEqual(errors,[]);
    await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}

for(const audience of ['sales','scm'])for(const kind of ['regular','special'])for(const viewport of [
  {width:1440,height:600},{width:1024,height:500},{width:1920,height:800}
]) {
  test(`${audience} ${kind} ${viewport.width}x${viewport.height}: long details remain reachable through repeated wheel round trips`,async()=>{
    const {page,close}=await fixture(audience,kind,viewport.width,viewport.height);
    try{
      const panel=page.locator('.stock-request-detail'),box=await panel.boundingBox();assert.ok(box);
      const metrics=()=>page.evaluate(()=>({top:window.scrollY,max:document.documentElement.scrollHeight-window.innerHeight}));
      const initial=await metrics();await writeFile(`${out}/${audience}-${kind}-${viewport.width}-before.json`,JSON.stringify(initial));
      assert.ok(initial.max>viewport.height*3,`Long details need an accessible page scroll: ${JSON.stringify(initial)}`);
      for(let round=0;round<3;round++){
        // Wheel over the visible workspace, including outside the detail content.
        await page.mouse.move(viewport.width-6,viewport.height/2);
        for(let step=0;step<40&&(await metrics()).top<(await metrics()).max-2;step++){
          const before=(await metrics()).top;await page.mouse.wheel(0,4000);
          await expect.poll(async()=>{const m=await metrics();return m.top>before||m.top>=m.max-2;}).toBe(true);
        }
        await expect.poll(async()=>{const m=await metrics();return m.top>=m.max-2;}).toBe(true);
        const last=page.locator('.stock-request-detail .stock-request-event, .stock-request-detail button, .stock-request-detail strong').last();
        const tail=await last.boundingBox();assert.ok(tail&&tail.y>=0&&tail.y+tail.height<=viewport.height,JSON.stringify(tail));
        const end=(await metrics()).top;
        const reloaded=page.waitForResponse(response=>response.url().includes('/api/'+audience+'/')&&/stock-requests(?:\?|$)/.test(response.url()));
        await page.locator('[data-special-sales-action=refresh], [data-special-scm-action=refresh], [data-sales-stock-action=refresh], [data-scm-stock-action=refresh]').first().evaluate(button=>button.click());
        await reloaded;await page.waitForLoadState('networkidle');
        await expect.poll(async()=>Math.abs((await metrics()).top-end)).toBeLessThanOrEqual(2);
        await page.mouse.wheel(0,8000);await page.mouse.wheel(0,-700);
        await expect.poll(async()=>(await metrics()).top<end-100).toBe(true);
        await page.mouse.wheel(0,-1000000);await expect.poll(async()=>(await metrics()).top<=2).toBe(true);
      }
      await page.screenshot({path:`${out}/${audience}-${kind}-${viewport.width}.png`});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    }finally{await close();}
  });
}
