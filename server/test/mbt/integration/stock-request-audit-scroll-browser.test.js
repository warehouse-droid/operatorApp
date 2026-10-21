/* global window, document, localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

const out='test-artifacts/special-po-000041/scroll';
let browser;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());

function record(audience,kind) {
  const events=Array.from({length:20},(_,i)=>({id:i+1,eventType:'audit_entry_'+i,actorName:'TEST Audit '+i,createdAt:'2026-10-06T12:00:00Z',details:{}}));
  if(kind==='special')return {id:1,requestRef:'SPREQ-SCROLL',revision:1,stage:'new_enquiry',closeStatus:'active',
    storeLocationId:1,storeName:'3445',customerName:'TEST Customer',vendorName:'TEST Vendor',vendorId:331,
    inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',lines:Array.from({length:4},(_,i)=>({
      id:i+10,productName:'TEST Product '+i,quantity:2,uom:'PLT',salesDecision:'pending',supplyStatus:null,vendorYard:'TEST Yard'})),
    salesOrderLines:[],purchaseOrderLines:[],events,media:[],readinessAlerts:[]};
  const sales=audience==='sales';
  return {id:1,requestRef:'REQ-SCROLL',revision:1,workflowVersion:sales?2:1,requestedBy:'viewer',requestedByName:'TEST Viewer',
    destinationLocationId:28,destinationName:'150',bucket:sales?'accepted':'pending',status:'active',updatedAt:'2026-10-06T00:00:00Z',
    regular:sales?{deliveryMethod:'pickup',approvalExpiresAt:'2099-01-01T00:00:00Z',approval:{automatic:false,lines:[]}}:{},
    lines:Array.from({length:6},(_,i)=>({id:i+10,itemId:i+1000,itemName:'TEST Product '+i,sourceLocationId:1,sourceName:'3445',
      destinationLocationId:28,destinationName:'150',salesQty:10,salesUom:'PCS',quantityMode:'conversion',toPcs:1,pieces:10,
      pallets:0,layers:0,sections:0,status:sales?'approved':'submitted',decision:sales?'stock':null})),
    transfers:[],events,availability:[]};
}

async function fixture(audience,kind,width) {
  const context=await browser.newContext({viewport:{width,height:800},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-audit-scroll'));
  const page=await context.newPage();page.setDefaultTimeout(5000);
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
  return {page,close:async()=>{assert.deepEqual(errors,[]);await context.close();}};
}

for(const audience of ['sales','scm'])for(const kind of ['regular','special'])for(const width of [1440,900,390]) {
  test(`${audience} ${kind} ${width}: wheel scrolling reaches the trail or final detail controls and returns without a nested scroll trap`,async()=>{
    const {page,close}=await fixture(audience,kind,width);
    try{
      const hasTrail=await page.locator('.stock-request-event').count()>0;
      const audit=hasTrail?page.locator('.stock-request-event').first():page.locator('.stock-request-detail .stock-request-line').first();
      await expect(audit).toBeAttached();await audit.scrollIntoViewIfNeeded();
      const box=await audit.boundingBox();assert.ok(box);
      await page.mouse.move(box.x+Math.min(20,box.width/2),box.y+box.height/2);
      const position=()=>page.evaluate(()=>({page:window.scrollY,panel:document.querySelector('.stock-request-detail').scrollTop}));
      const before=await position();await page.mouse.wheel(0,220);
      await expect.poll(async()=>{const after=await position();return after.page>before.page+20;}).toBe(true);
      const down=await position();await page.mouse.wheel(0,-220);
      await expect.poll(async()=>{const after=await position();return after.page<down.page-20;}).toBe(true);
      const tail=hasTrail?page.locator('.stock-request-event').last():page.locator('.stock-request-detail button,.stock-request-detail input:not([type=hidden]),.stock-request-detail select,.stock-request-detail strong').last();
      await tail.scrollIntoViewIfNeeded();
      const last=await tail.boundingBox();assert.ok(last&&last.y>=0&&last.y+last.height<=800);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await writeFile(`${out}/${audience}-${kind}-${width}.json`,JSON.stringify({hasTrail,before,down,restored:await position()}));
      await page.screenshot({path:`${out}/${audience}-${kind}-${width}.png`});
    }finally{await close();}
  });
}
