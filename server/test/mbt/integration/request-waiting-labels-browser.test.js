/* global window,localStorage,EventTarget */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let browser;
const out='test-artifacts/browser';
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const line=(id,supplyStatus,salesDecision='accepted')=>({id,itemId:101,itemName:'TEST material',productName:'TEST material',quantity:2,originalRate:25,uom:'PCS',
  supplyStatus,salesDecision,availableDate:'2099-02-01',vendorName:'TEST Vendor',vendorId:331,vendorYard:'TEST Yard',destinationLocationId:1,destinationName:'3445'});
function record(kind,id,lines) {
  return {id,requestRef:'TEST-WAIT-'+id,revision:1,status:'submitted',bucket:'pending',requestType:kind==='special'?'special':'regular',workflowKind:kind,workflowVersion:2,
    regular:{deliveryMethod:kind},stage:'confirmed',closeStatus:'active',storeName:'3445',storeLocationId:1,destinationLocationId:1,destinationName:'3445',
    customerName:'TEST Customer',vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',inquiryDate:'2099-01-01',requestedBy:'test-wait',
    salesOrderId:10+id,salesOrderRef:'TEST-SO-'+id,salesOrderApproved:true,purchaseOrderId:20+id,purchaseOrderRef:'TEST-PO-'+id,purchaseOrderApproved:true,
    purchaseOrderDispatchStatus:'Hold',lines,events:[],salesOrderLines:[],purchaseOrderLines:[],media:[],transfers:[],readinessAlerts:[]};
}
async function fixture(audience,kind,width) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','test-wait');window.EventSource=class extends EventTarget{close(){}};});
  const page=await context.newPage();page.setDefaultTimeout(7000);
  const records=[record(kind,1,[line(1,'vendor_transfer'),line(2,'production'),line(3,'vendor_transfer')]),
    record(kind,2,[line(4,'vendor_transfer','declined'),line(5,'production','closed'),{...line(6,'production'),removedAt:'2026-10-16T12:00:00Z'}]),
    record(kind,3,[line(7,'vendor_transfer')]),record(kind,4,[line(8,'production')])];
  if(audience==='scm'&&kind==='special')records[0].lines[0]=line(1,'production','pending');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const collection=`/api/${audience}/${kind==='special'?'special-':''}stock-requests`;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(url.hostname!=='localhost')return route.abort();
    if(path.startsWith('/api/')) {
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-wait',role:audience,roles:[audience],yardLocationIds:[1]}}});
      if(path.endsWith('/conversation'))return route.fulfill({json:{messages:[],canSend:true,latestEventId:0}});
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      const selected=records.find(row=>path===collection+'/'+row.id);
      if(selected)return route.fulfill({json:selected});
      if(path===collection)return route.fulfill({json:{requests:records,yards:[{locationId:1,yardCode:'3445'}],vendors:[],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      return route.fulfill({json:{requests:[],vendors:[],count:0,lines:[],alerts:[]}});
    }
    const file=path===`/${audience}/stock-requests`?`/${audience}-stock-requests.html`:path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({html:'text/html',css:'text/css',js:'application/javascript'})[file.split('.').at(-1)]||'application/octet-stream'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=${kind==='special'?'special':'regular'}&requestId=1`);
  return {page,context,records,errors,collection};
}

for(const audience of ['sales','scm'])for(const kind of ['special','backorder'])for(const width of [1920,390]) {
  test(`${audience} ${kind} cards show active waiting labels and clear them at dispatch handoff (${width}px)`,async()=>{
    const {page,context,records,errors,collection}=await fixture(audience,kind,width);
    try {
      const card=id=>page.locator(`.stock-request-card[data-id="${id}"]`),badges=id=>card(id).locator('[data-stock-request-waiting]');
      await expect(badges(1)).toHaveText(['Waiting for Transfer','Waiting for Production']);
      await expect(card(2)).toBeVisible();await expect(badges(2)).toHaveCount(0);
      await expect(badges(3)).toHaveText(['Waiting for Transfer']);await expect(badges(4)).toHaveText(['Waiting for Production']);
      if(audience==='scm'&&kind==='special') {
        for(const id of [1,2])await expect(page.locator(`[data-scm-line-id="${id}"] .stock-live-summary > span`).first())
          .toHaveText('Waiting for Production · ETA: 2099-02-01 · Pickup: TEST Yard');
        await expect(page.locator('[data-scm-line-id="2"] select[name="ready"]')).toHaveValue('false');
        await expect(page.locator('[data-scm-line-id="3"] .stock-live-summary > span').first())
          .toHaveText('Wait for Transfer · ETA: 2099-02-01 · Pickup: TEST Yard');
      }
      const layout=await card(1).evaluate(card=>{
        const heading=card.querySelector('.stock-request-status-line');
        return {width:card.clientWidth,scrollWidth:card.scrollWidth,
          centers:[heading.querySelector('strong'),...card.querySelectorAll('[data-stock-request-waiting]')].map(element=>{
            const rect=element.getBoundingClientRect();return (rect.top+rect.bottom)/2;
          })};
      });
      assert.ok(layout.scrollWidth<=layout.width,'Card labels must not overflow');
      if(width===1920)assert.ok(Math.max(...layout.centers)-Math.min(...layout.centers)<2,'Waiting labels share the heading row when space permits');
      else assert.ok(layout.centers[2]>layout.centers[0],'Waiting labels wrap on a narrow card');
      await page.screenshot({path:`${out}/${audience}-${kind}-${width}-waiting.png`,fullPage:true});
      const action=kind==='special'?`data-special-${audience}-action`:`data-${audience}-stock-action`;
      const refresh=async()=>{
        records[0].revision++;
        const response=page.waitForResponse(value=>new URL(value.url()).pathname===collection&&value.request().method()==='GET');
        await page.locator(`[${action}="refresh"]`).click();
        assert.equal((await (await response).json()).requests.find(row=>row.id===1).revision,records[0].revision);
      };
      records[0].purchaseOrderReference='VENDOR-REF';await refresh();await expect(badges(1)).toHaveCount(2);
      records[0].purchaseOrderReference='';records[0].purchaseOrderDispatchStatus='Queued';await refresh();await expect(badges(1)).toHaveCount(2);
      records[0].purchaseOrderReference='VENDOR-REF';records[0].stage='dispatch_arrangement';await refresh();
      await expect(badges(1)).toHaveCount(0);await expect(card(1)).toContainText(/Dispatch Arrangement|dispatch arrangement/);
      await expect(badges(3)).toHaveText(['Waiting for Transfer']);await expect(badges(4)).toHaveText(['Waiting for Production']);
      await page.reload();await expect(card(1)).toContainText(/Dispatch Arrangement|dispatch arrangement/);await expect(badges(1)).toHaveCount(0);
      await page.screenshot({path:`${out}/${audience}-${kind}-${width}-dispatched.png`,fullPage:true});
      assert.deepEqual(errors,[]);
    }catch(error){await page.screenshot({path:`${out}/${audience}-${kind}-${width}-failure.png`,fullPage:true});throw error;}
    finally{await context.close();}
  });
}
