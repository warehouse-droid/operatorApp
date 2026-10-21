import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const out='/app/test-artifacts/special-workflow-review/queue-access';
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const fixture=(id,yard)=>({id,requestRef:`SPREQ-TEST-${id}`,revision:1,storeLocationId:yard,storeName:yard===1?'3445':'3551',stage:'new_enquiry',customerName:'TEST Customer',vendorName:'TEST Vendor',closeStatus:'active',fulfillmentMethod:'yard_pickup',inquiryDate:'2099-01-01',lines:[{id,productName:'TEST Material',quantity:2,uom:'PCS',rate:100,salesDecision:'pending'}],salesOrderLines:[],purchaseOrderLines:[],events:[],media:[],readinessAlerts:[]});
const results=[];
try{
 for(const role of ['sales','scm']){
  const login=await browser.newContext(),auth=await login.newPage();await auth.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
  await auth.locator('[name=username]').fill(`review-${role}`);await auth.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
  await auth.locator('[data-form=dispatch-login] button[type=submit]').click();await auth.locator('.special-stock-page').waitFor();
  const storageState=await login.storageState();await login.close();
  for(const width of [1440,390]){
   const context=await browser.newContext({storageState,viewport:{width,height:960}}),page=await context.newPage(),errors=[];
   await page.coverage.startJSCoverage({resetOnNavigation:false});page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{
    window.specialTestSources=[];
    class Source extends EventTarget {constructor(url){super();this.url=url;window.specialTestSources.push(this);}close(){}}
    window.EventSource=Source;
   });
   let calls=0,details=0,delayed=null,enabled=true,fail=false;const cases=[fixture(1,1),fixture(2,28),fixture(3,1)],yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'3551'}];
   await page.route(`**/api/${role}/special-stock-requests**`,async route=>{
    const url=new URL(route.request().url()),path=url.pathname.split('/special-stock-requests')[1];
    if(path==='/policy')return route.fulfill({json:{enabled}});
    if(path==='/vendors')return route.fulfill({json:{vendors:[{id:88,name:'TEST Vendor'}]}});
    if(path==='/customers')return route.fulfill({json:{customers:[]}});
    if(route.request().method()==='POST'){
     if(!path){const row=fixture(4,1);cases.unshift(row);return route.fulfill({json:row});}
     const row=cases.find(row=>row.id===Number(path.split('/')[1]));row.revision++;row.lines[0].supplyStatus='in_stock';return route.fulfill({json:row});
    }
    if(!path){calls++;if(fail)return route.fulfill({status:503,json:{error:'Queue temporarily unavailable'}});if(delayed)await delayed;const yard=Number(url.searchParams.get('storeLocationId'));return route.fulfill({json:{yards,requests:cases.filter(row=>!yard||row.storeLocationId===yard)}});}
    details++;return route.fulfill({json:cases.find(row=>row.id===Number(path.slice(1)))});
   });
   await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);await page.locator('.stock-request-card').first().waitFor();
   assert.equal(await page.locator('.stock-request-page > .stock-request-tabs button').first().innerText(),'Special');assert.equal(calls,1);assert.equal(details,0);
   const action=role==='scm'?'data-special-scm-action':'data-special-sales-action';
   await page.locator('.stock-request-card[data-id="3"]').click();await page.locator('.stock-request-card[data-id="2"]').click();
   assert.match(await page.locator('.stock-request-detail h2').innerText(),/TEST-2/);assert.equal(details,0);
   await page.locator('[data-special-yard]').selectOption('1');await page.waitForFunction(()=>document.querySelectorAll('.stock-request-card').length===2);
   assert.equal(await page.locator('.stock-request-card[data-id="2"]').count(),0);assert.match(await page.locator('.stock-request-card').first().innerText(),/3445/);
   await page.locator('[data-special-yard]').selectOption('');await page.waitForFunction(()=>document.querySelectorAll('.stock-request-card').length===3);
   await page.locator('.stock-request-card').first().evaluate(node=>{window.savedCard=node;});
   const previous=calls,refreshed=page.waitForResponse(r=>r.url().includes(`/api/${role}/special-stock-requests?`));await page.locator(`[${action}=refresh]`).click();await page.waitForFunction(()=>!document.querySelector('.stock-request-list')?.textContent.includes('Loading'));
   await refreshed;
   assert.equal(calls,previous+1);assert.equal(await page.evaluate(()=>window.savedCard===document.querySelector('.stock-request-card')),true);
   // Cards stay usable while a quiet refresh is in flight and the selected case wins.
   let release;delayed=new Promise(resolve=>{release=resolve;});const next=page.waitForRequest(r=>r.url().includes(`/api/${role}/special-stock-requests?`));
   await page.locator(`[${action}=refresh]`).click();await next;await page.locator('.stock-request-card[data-id="3"]').click();
   release();delayed=null;await page.waitForFunction(()=>document.querySelector('.stock-request-detail h2')?.textContent.includes('TEST-3'));
   // Regular refresh events must not replace Special, and unrelated order events do not reload it.
   const beforeEvent=calls;await page.evaluate(()=>{for(const source of window.specialTestSources)source.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type:'dispatch.orders.updated',payload:{orderId:999999}})}));});
   await page.waitForTimeout(550);assert.equal(calls,beforeEvent);assert.equal(await page.locator('.special-stock-page').count(),1);
   // Switching tabs keeps loaded queue data; an unsaved SCM response/Sales composer survives events.
   const regular=role==='scm'?'[data-stock-request-tab=regular]':'[data-special-sales-action=regular]';await page.locator(regular).click();
   const special=role==='scm'?'[data-stock-request-tab=special]':'[data-sales-stock-action=special]';await page.locator(special).click();await page.locator('.special-stock-page').waitFor();assert.equal(calls,beforeEvent);
   if(role==='sales'){await page.locator('[data-special-sales-action=new]').click();await page.locator('[name=remarks]').fill('Keep this draft');}
   else await page.locator('[name=vendorName]').fill('Keep this draft');
   const beforeEdit=calls;await page.evaluate(()=>{for(const source of window.specialTestSources)source.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type:'special-stock-request.updated',payload:{requestId:1}})}));});
   await page.waitForTimeout(550);assert.equal(calls,beforeEdit);assert.equal(await page.locator(role==='sales'?'[name=remarks]':'[name=vendorName]').inputValue(),'Keep this draft');
   await page.locator(`[${action}=refresh]`).click();assert.equal(calls,beforeEdit);assert.match(await page.locator('.stock-request-feedback').innerText(),/Finish your current edits/);
   if(role==='sales'){
    await page.locator('[name=customerName]').fill('TEST Customer');await page.locator('[name=vendorName]').fill('TEST Vendor');
    await page.locator('[data-special-initial-fulfillment]').selectOption('yard_pickup');
    await page.locator('[name=productName]').fill('TEST product');await page.locator('[name=quantity]').fill('2');await page.locator('[name=rate]').fill('100');
    await page.locator('[data-special-case-form] button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('.stock-request-detail h2')?.textContent.includes('TEST-4'));
    assert.equal(await page.locator('.stock-request-card[data-id="4"]').count(),1);
   }else{
    await page.locator('[name=vendorName]').fill('TEST Vendor');await page.locator('[data-special-scm-action=choose-vendor]').click();
    await page.locator('[name=vendorYard]').fill('TEST Pickup');await page.locator('[data-special-response-form] button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('.stock-request-summary')?.textContent.includes('2'));
   }
   fail=true;const failed=page.waitForResponse(r=>r.url().includes(`/api/${role}/special-stock-requests?`)&&r.status()===503);
   await page.locator(`[${action}=refresh]`).click();await failed;await page.getByText('Queue temporarily unavailable',{exact:true}).waitFor();
   fail=false;await page.locator(`[${action}=refresh]`).click();await page.waitForFunction(()=>!document.querySelector('.stock-request-feedback')?.textContent.includes('Queue temporarily unavailable'));
   await page.screenshot({path:`${out}/queue-${role}-${width}.png`});assert.deepEqual(errors,[]);
   await page.goto(`http://127.0.0.1:3000/${role}/stock-requests?tab=regular`);await page.locator(special).waitFor();
   assert.equal(await page.locator('.stock-request-page > .stock-request-tabs button').first().innerText(),'Special');
   enabled=false;await page.locator(special).click();await page.getByText('Special Item workflow is off',{exact:true}).waitFor();

   await writeFile(`${out}/browser-coverage-${role}-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));results.push({role,width,passed:true,cardsUseLoadedData:true,stableRefresh:true,filter:true});await context.close();
  }
 }
 console.log(JSON.stringify(results));await writeFile(`${out}/browser.json`,JSON.stringify(results,null,2));
}finally{await browser.close();}
