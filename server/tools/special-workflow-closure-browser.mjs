import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const out='/app/test-artifacts/special-workflow-review/closure-lock';
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const request=id=>({id,requestRef:`SPREQ-TEST-${id}`,revision:1,stage:'confirmed',customerName:'TEST Customer',vendorName:'TEST Vendor',storeName:'3445',
 inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',closeStatus:'active',salesOrderId:100+id,salesOrderRef:`TEST-SO-${id}`,salesOrderStatus:'Pending Fulfillment',salesOrderApproved:true,
 purchaseOrderId:200+id,purchaseOrderRef:`TEST-PO-${id}`,purchaseOrderStatus:'Pending Receipt',dispatchPlanning:{anyPlanned:false,salesOrder:{planned:false},purchaseOrder:{planned:false}},
 lines:[{id:1,productName:'TEST Material',quantity:50,uom:'PC',salesDecision:'accepted',supplyStatus:'in_stock'}],
 salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[],quantityReviewPending:false});
const results=[];
try{
 const login=await browser.newContext(),auth=await login.newPage();await auth.goto('http://127.0.0.1:3000/scm/stock-requests');
 await auth.locator('[name=username]').fill('review-scm');
 await auth.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
 await auth.locator('[data-form=dispatch-login] button[type=submit]').click();await auth.locator('[data-stock-request-tab=special]').waitFor();
 const storageState=await login.storageState();await login.close();
 for(const width of [1440,390]){
  const context=await browser.newContext({storageState,viewport:{width,height:960}}),page=await context.newPage(),errors=[];
  const cases=[request(3),{...request(2),quantityReviewPending:true,quantityReview:{id:'adjustment',status:'pending',mode:'issued',lines:[]}},
   {...request(1),closeStatus:'closure_pending',closureReason:'Customer cancelled',closureReview:{id:'closure1',status:'pending'}},
   {...request(4),closeStatus:'closure_pending',closureReason:'Customer cancelled',closureReview:{id:'closure4',status:'attention',remoteStarted:true,error:'Retry required'}}];
  page.on('pageerror',error=>errors.push(error.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/api/scm/special-stock-requests**',async route=>{
   const path=new URL(route.request().url()).pathname.split('/special-stock-requests')[1];
   if(path==='/policy')return route.fulfill({json:{enabled:true}});
   if(!path)return route.fulfill({json:{requests:cases}});
   const id=Number(path.split('/')[1]),index=cases.findIndex(item=>item.id===id);
   if(path.endsWith('/closure-review')){
    assert.equal(route.request().method(),'POST');assert.equal(route.request().postDataJSON().decision,'approve');
    cases[index]={...cases[index],revision:2,stage:'closed',closeStatus:'closed',closureReview:{...cases[index].closureReview,status:'approved'}};
   }
   return route.fulfill({json:cases[index]});
  });
  await page.goto('http://127.0.0.1:3000/scm/stock-requests');await page.locator('[data-stock-request-tab=special]').click();
  const banner=page.locator('.stock-request-feedback [role=status]');await banner.waitFor();
  assert.match(await banner.innerText(),/2 closure requests require SCM confirmation/);
  assert.deepEqual(await page.locator('.stock-request-card').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.id))),[1,4,2,3]);
  assert.match(await page.locator('.stock-request-card[data-id="1"]').innerText(),/Closure requested · SCM confirmation required/);
  assert.match(await page.locator('.stock-request-card[data-id="4"]').innerText(),/Closure incomplete · SCM retry required/);
  await page.screenshot({path:`${out}/closure-alert-${width}.png`});
  for(const id of [1,4]){
   await page.locator(`.stock-request-card[data-id="${id}"]`).click();
   await page.locator('[data-special-closure-review-form] [value=approve]').click();
   await page.waitForFunction(target=>document.querySelector(`.stock-request-card[data-id="${target}"] .stock-request-pill.closed`),id);
   assert.doesNotMatch(await page.locator(`.stock-request-card[data-id="${id}"]`).innerText(),/SCM confirmation required|SCM retry required/);
  }
  assert.equal(await banner.count(),0);
  assert.equal(await page.locator('.stock-request-card').first().getAttribute('data-id'),'2');
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/browser-coverage-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  results.push({width,passed:true,closureAlerts:true,priority:true,clearedOnConfirmation:true});await context.close();
 }
 await writeFile(`${out}/browser.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
