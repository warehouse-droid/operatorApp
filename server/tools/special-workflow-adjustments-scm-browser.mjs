import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const out='/app/test-artifacts/special-workflow-review/adjustments';
const pdf=await readFile('/app/test-artifacts/special-workflow-review/native-documents/quote.pdf');
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const fixture=()=>({id:7100,requestRef:'SPREQ-TEST-7100',revision:7,stage:'confirmed',customerName:'TEST Customer',vendorName:'TEST Vendor',storeName:'3445',
  inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',closeStatus:'active',salesOrderId:101,salesOrderRef:'SOB121380',salesOrderStatus:'Pending Fulfillment',salesOrderApproved:true,
  purchaseOrderId:102,purchaseOrderRef:'POB03934',purchaseOrderStatus:'Pending Receipt',dispatchPlanning:{anyPlanned:true,salesOrder:{planned:false,plans:[]},purchaseOrder:{planned:true,plans:[{planDate:'2099-02-01'}]}},
  lines:[{id:1,productName:'TEST Coping',quantity:2,uom:'PLT',salesDecision:'accepted',supplyStatus:'in_stock'}],salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[],quantityReviewPending:true,quantityReview:{id:'TEST',mode:'issued',status:'pending',pallets:{fromQuantity:2,toQuantity:5,rate:40},lines:[{productName:'TEST Coping',fromPackageQuantity:2,toPackageQuantity:2,fromQuantity:20,toQuantity:20,fromPurchaseQuantity:20,toPurchaseQuantity:20,packageUom:'PLT',salesUom:'PC',purchaseUom:'PC',fromDiscountPercent:10,toDiscountPercent:25}]}});
const results=[];
try{
 const login=await browser.newContext(),auth=await login.newPage();await auth.goto('http://127.0.0.1:3000/scm/stock-requests');
 await auth.locator('[name=username]').fill('review-scm');await auth.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
 await auth.locator('[data-form=dispatch-login] button[type=submit]').click();await auth.locator('[data-stock-request-tab=special]').waitFor();
 const storageState=await login.storageState();await login.close();
 for(const width of [1440,1024,390]){
  const context=await browser.newContext({storageState,viewport:{width,height:960}}),page=await context.newPage();let current=fixture();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/api/scm/special-stock-requests**',async route=>{
   const path=new URL(route.request().url()).pathname.split('/special-stock-requests')[1];
   if(path.endsWith('.pdf'))return route.fulfill({contentType:'application/pdf',body:pdf});
   return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/policy'?{enabled:true}:!path?{requests:[current]}:current)});
  });
  await page.goto('http://127.0.0.1:3000/scm/stock-requests');await page.locator('[data-stock-request-tab=special]').click();
  const planning=page.locator('.stock-request-detail .special-planning-status');await planning.locator('[data-special-document=sales_order]').waitFor();
  const review=page.locator('[data-special-quantity-review-form]');assert.match(await review.innerText(),/10% → 25%/);assert.match(await review.innerText(),/PALLET: 2 → 5 EACH/);
  assert.match(await planning.innerText(),/SOB121380/);assert.match(await planning.innerText(),/POB03934/);assert.match(await planning.innerText(),/2099-02-01/);
  const detailText=await page.locator('.stock-request-detail').innerText();assert.equal(detailText.split('SOB121380').length-1,1);assert.equal(detailText.split('POB03934').length-1,1);
  assert.equal(await page.locator('[data-special-readiness-form] button[type=submit]').textContent(),'Save');
  assert.equal(await page.locator('.stock-request-card button').count(),0);
  await planning.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/scm-${width}.png`});
  for(const kind of ['sales_order','purchase_order']){
   assert.equal(await page.locator(`[data-special-document=${kind}]`).count(),1);
   await planning.locator(`[data-special-document=${kind}]`).click();await page.locator('dialog.special-document-dialog iframe').waitFor();await page.locator('[data-document-close]').click();
  }
  current={...current,quantityReviewPending:false,purchaseOrderId:null,purchaseOrderRef:null};await page.locator('[data-special-scm-action=refresh]').click();await planning.locator('[data-special-document=sales_order]').waitFor();
  await page.locator('[data-special-document=purchase_order]').waitFor({state:'hidden'});assert.equal(await page.locator('[data-special-document=purchase_order]').count(),0);assert.equal((await page.locator('.stock-request-detail').innerText()).split('SOB121380').length-1,1);
  current={...current,salesOrderId:null,salesOrderRef:null};await page.locator('[data-special-scm-action=refresh]').click();await page.locator('[data-special-document=quote]').waitFor();
  assert.equal(await page.locator('[data-special-document=sales_order]').count(),0);assert.deepEqual(errors,[]);
  results.push({width,passed:true,bothPreviewsInPlanning:true,referencesShownOnce:true,readinessButton:'Save',preSoQuotePreserved:true});await writeFile(`${out}/browser-coverage-scm-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();
 }
 await writeFile(`${out}/scm-browser.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
