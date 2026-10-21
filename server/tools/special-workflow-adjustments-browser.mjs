import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const out='/app/test-artifacts/special-workflow-review/adjustments';
const pdf=await readFile('/app/test-artifacts/special-workflow-review/native-documents/quote.pdf');
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const detail=linked=>({id:7100,requestRef:'SPREQ-TEST-7100',revision:7,stage:linked?'confirmed':'ready_to_order',customerId:8899100,customerName:'TEST Customer',vendorName:'TEST Vendor',
  storeLocationId:1,storeName:'3445',operationalYardLocationId:1,inquiryDate:'2099-01-01',fulfillmentMethod:'yard_pickup',closeStatus:'active',
  salesOrderId:linked?101:null,salesOrderRef:linked?'TEST-SO-121380':null,salesOrderStatus:'Pending Fulfillment',salesOrderApproved:linked,
  purchaseOrderId:linked?102:null,purchaseOrderRef:linked?'TEST-PO':null,purchaseOrderStatus:'Pending Receipt',
  lines:[{id:1,productName:'TEST Coping',quantity:2,packageQuantity:2,uom:'PLT',rateUom:'PLT',originalRate:50,discountPercent:10,pricingSource:'enquiry',conversionToPc:10,
    salesDecision:'accepted',supplyStatus:'in_stock',itemResolution:{itemId:2055,description:'TEST Coping',salesQuantity:20,salesUom:'PC'}}],
  salesOrderLines:linked?[{caseLineId:1,itemId:2055,description:'TEST Coping',quantity:20,uom:'PC',rate:4.5}]:[],
  purchaseOrderLines:linked?[{caseLineId:1,itemId:2055,description:'TEST Coping',quantity:20,uom:'PC',unitPurchaseCost:4}]:[],palletTotal:2,palletRate:40,media:[],events:[]});
const results=[];
try{
 const login=await browser.newContext(),page=await login.newPage();
 await page.goto('http://127.0.0.1:3000/sales/stock-requests');
 await page.locator('[name=username]').fill('review-sales');
 await page.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
 await page.locator('[data-form=dispatch-login] button[type=submit]').click();await page.locator('[data-sales-stock-action=special]').waitFor();
 const storageState=await login.storageState();await login.close();
 for(const width of [1440,1024,390]){
  const context=await browser.newContext({storageState,viewport:{width,height:960}}),page=await context.newPage();let current=detail(false),submitted=null;const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/api/sales/special-stock-requests**',async route=>{
   const path=new URL(route.request().url()).pathname.split('/special-stock-requests')[1];
   if(path.endsWith('/quantity-change'))submitted=route.request().postDataJSON();
   if(path.endsWith('.pdf'))return route.fulfill({contentType:'application/pdf',body:pdf});
   const payload=path==='/policy'?{enabled:true}:!path?{requests:[current],yards:[{locationId:1,yardCode:'3445'}]}:current;
   return route.fulfill({contentType:'application/json',body:JSON.stringify(payload)});
  });
  await page.goto('http://127.0.0.1:3000/sales/stock-requests');await page.locator('[data-sales-stock-action=special]').click();
  const row=()=>page.locator('[data-special-so-form] .special-sales-pricing-row');
  await row().waitFor();assert.equal(await row().locator('[name=rate]').getAttribute('type'),'hidden');
  assert.equal(await row().locator('.special-fixed-value').textContent(),'50.00');
  await row().locator('[name=quantity]').fill('3');assert.equal(await row().locator('[data-special-subtotal]').textContent(),'135.00');
  async function sameRow(locator){const bounds=await locator.locator(':scope > label').evaluateAll(labels=>labels.map(el=>({y:el.getBoundingClientRect().y,x:el.getBoundingClientRect().x,width:el.getBoundingClientRect().width})));assert.equal(bounds.length,4);assert.ok(bounds.every(b=>Math.abs(b.y-bounds[0].y)<1));}
  await sameRow(row());await row().scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/create-so-${width}.png`});
  await page.locator('[data-special-sales-action=new]').click();
  const initial=page.locator('[data-special-composer-line] .special-sales-pricing-row');await initial.waitFor();await sameRow(initial);
  await initial.locator('[name=quantity]').fill('2');await initial.locator('[name=rate]').fill('50');await initial.locator('[name=discountPercent]').fill('10');
  assert.equal(await initial.locator('[data-special-subtotal]').textContent(),'90.00');
  await page.locator('[data-special-sales-action=cancel-compose]').click();
  current=detail(true);await page.locator('[data-special-sales-action=refresh]').click();
  const preview=page.locator('.special-sales-order-summary > span:first-child [data-special-document=sales_order]');await preview.waitFor();
  assert.equal(await page.locator('[data-special-document=purchase_order]').count(),0);
  assert.equal(await page.locator('[data-special-document=sales_order]').count(),1);
  assert.equal(await page.getByRole('heading',{name:'Case lines',exact:true}).count(),0);
  const quantity=page.locator('[data-special-quantity-form] .special-sales-pricing-row');await sameRow(quantity);
  assert.equal(await quantity.locator('[name=rate]').getAttribute('type'),'hidden');assert.equal(await quantity.locator('[name=discountPercent]').getAttribute('type'),'number');
  await quantity.locator('[name=quantity]').fill('4');await quantity.locator('[name=discountPercent]').fill('25');assert.equal(await quantity.locator('[data-special-subtotal]').textContent(),'150.00');
  assert.equal(await page.locator('[data-special-sales-action=refresh-so]').count(),0);
  await page.locator('[data-special-quantity-form] [name=palletTotal]').fill('5');
  await preview.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/linked-${width}.png`});
  const positions=await preview.evaluate(button=>{const text=button.previousElementSibling.getBoundingClientRect(),box=button.getBoundingClientRect();return{textX:text.x,textRight:text.right,buttonX:box.x,yGap:Math.abs((text.top+text.bottom-box.top-box.bottom)/2)};});
  assert.ok(positions.buttonX>=positions.textRight);assert.ok(positions.yGap<2);
  await preview.click();await page.locator('dialog.special-document-dialog iframe').waitFor();await page.locator('[data-document-close]').click();
  await page.locator('[data-special-quantity-form] button[type=submit]').click();
  await page.getByText('Order adjustment sent to SCM for confirmation.').waitFor();
  assert.equal(submitted.palletTotal,'5');assert.deepEqual(submitted.lines,[{caseLineId:1,quantity:'4',discountPercent:'25'}]);
  current={...current,quantityReviewPending:true,quantityReview:{id:'TEST',status:'pending',lines:[{caseLineId:1,productName:'TEST Coping',fromPackageQuantity:2,toPackageQuantity:4,packageUom:'PLT',fromQuantity:20,toQuantity:40,salesUom:'PC',fromDiscountPercent:10,toDiscountPercent:25}],pallets:{fromQuantity:2,toQuantity:5,rate:40}}};
  await page.locator('[data-special-sales-action=refresh]').click();await page.getByText('TEST Coping discount: 10% → 25%',{exact:true}).waitFor();
  assert.match(await page.locator('[data-special-quantity-form]').innerText(),/Request an order adjustment/);
  current={...current,closeStatus:'closed',stage:'closed'};await page.locator('[data-special-sales-action=refresh]').click();await preview.waitFor();
  await page.locator('[data-special-quantity-form]').waitFor({state:'hidden'});assert.equal(await page.locator('[data-special-quantity-form]').count(),0);assert.deepEqual(errors,[]);
  results.push({width,passed:true,previewBesideSo:true,noSalesPoPreview:true,onePricingRow:true,fixedRateLabel:true,caseLinesHidden:true,closedSoPreview:true,editableDiscount:true,editablePalletQuantity:true,submittedAdjustment:true,noStatusRefresh:true});await writeFile(`${out}/browser-coverage-sales-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();
 }
 await writeFile(`${out}/browser.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
