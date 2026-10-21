/* global localStorage */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

const out=process.env.SPECIAL_CUSTOM_PO_BROWSER_OUTPUT||'test-artifacts/special-po-reference-only-20261006/browser';
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture(width=1440,patch={},role='scm') {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-custom-po'));
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const record={id:1,requestRef:'SPREQ-000024',revision:1,stage:'so_approved',storeLocationId:1,storeName:'3445',customerName:'TEST Customer',vendorName:'TEST Vendor',vendorId:331,
    fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',deliveryFeeRate:235,palletTotal:0,salesOrderId:1033108,salesOrderRef:'SOB121882',salesOrderApproved:true,closeStatus:'active',purchaseOrderOperationStatus:'idle',
    lines:[{id:36,lineNumber:1,productName:'SO stone',quantity:144,uom:'SQFT',salesDecision:'accepted',supplyStatus:'in_stock'}],
    salesOrderLines:[{id:59,caseLineId:36,itemId:2055,description:'SO description',quantity:144,uom:'SQFT',rate:17.95}],
    purchaseOrderLines:[{id:60,caseLineId:36,itemId:2055,description:'Independent PO description',quantity:12,uom:'PC'}],events:[],media:[],readinessAlerts:[]};
  record.salesOrderSource='manual_link';record.salesOrderLines=[];record.purchaseOrderLines=[];Object.assign(record,patch);
  const state={record,posts:[],errors:[],fail:false};page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),{pathname:path,hostname}=new URL(request.url());if(hostname!=='localhost')return route.abort();
    if(path.startsWith('/api/')) {
      if(request.method()==='POST') {
        const body=request.postDataJSON();state.posts.push({path,body});
        if(state.fail)return route.fulfill({status:409,json:{error:'PO was not found. Check the number.'}});
        record.purchaseOrderId=20;record.purchaseOrderRef=body.purchaseOrderRef||'NEW-PO';record.purchaseOrderCustomLinkage=body.customLinkage===true;record.revision++;
        return route.fulfill({json:record});
      }
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-custom-po',display_name:'TEST SCM',role,roles:[role]}}});
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      if(path.endsWith('/special-stock-requests/1'))return route.fulfill({json:record});
      if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],requests:[record]}});
      return route.fulfill({json:{requests:[],yards:[],total:0}});
    }
    const file=path===`/${role}/stock-requests`?`/${role}-stock-requests.html`:path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${role}/stock-requests?tab=special`);await expect(page.locator(role==='sales'?'[data-special-link-so-form]':'[data-special-po-form]')).toBeVisible();
  return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
test('reference-only SO displays accepted material purchase review on desktop and phone',async()=>{
  for(const width of [1440,390]){
    const {page,state,close}=await fixture(width);try{
      const form=page.locator('[data-special-po-form]'),material=form.locator('[data-special-po-line="36"]');
      await expect(material).toBeVisible();await expect(material.locator('[name=quantity]')).toHaveValue('144');
      await expect(material.locator('[name=uom]')).toHaveValue('SQFT');await expect(material.locator('[name=description]')).toHaveValue('SO stone');
      await material.locator('[name=unitPurchaseCost]').fill('6');await material.locator('[name=vendorDiscountPercent]').fill('0');
      await form.getByRole('button',{name:'Create PO in NetSuite',exact:true}).click();await expect(form).toHaveCount(0);
      assert.equal(state.posts.length,1);assert.equal(state.posts[0].path,'/api/scm/special-stock-requests/1/purchase-order/create');
      assert.deepEqual(state.posts[0].body.lines,[{caseLineId:36,description:'SO stone',quantity:'144',uom:'SQFT',unitPurchaseCost:'6',vendorDiscountPercent:'0'}]);
      assert.equal(state.posts[0].body.customLinkage,undefined);assert.deepEqual(state.record.salesOrderLines,[]);
    }finally{await close();}
  }
});

test('any manual SO defaults to request materials despite approval and unrelated saved order drafts',async()=>{
  const {page,state,close}=await fixture(1440,{salesOrderApproved:false,stage:'so_linked',salesOrderLines:[{caseLineId:36,itemId:2055,description:'Old SO draft',quantity:3,uom:'PC'}],purchaseOrderLines:[{caseLineId:36,itemId:2055,description:'Old PO draft',quantity:3,uom:'PC'}]});
  try{
    const material=page.locator('[data-special-po-line="36"]');await expect(material.locator('[name=quantity]')).toHaveValue('144');await expect(material.locator('[name=uom]')).toHaveValue('SQFT');await expect(material.locator('[name=description]')).toHaveValue('SO stone');
    await expect(page.getByText('The reviewed quantity, UOM and description will update the SO first',{exact:false})).toHaveCount(0);
    await material.locator('[name=unitPurchaseCost]').fill('6');await material.locator('[name=vendorDiscountPercent]').fill('0');await page.getByRole('button',{name:'Create PO in NetSuite',exact:true}).click();
    assert.equal(state.posts[0].body.lines[0].quantity,'144');assert.equal(state.record.salesOrderLines[0].quantity,3);
  }finally{await close();}
});
test('manual PO number can be linked before the request has an SO or stock decisions',async()=>{
  const {page,state,close}=await fixture(390,{salesOrderId:null,salesOrderApproved:false,stage:'awaiting_stock',lines:[{id:36,salesDecision:'pending',supplyStatus:'no_stock'}]});
  try{await page.locator('[name=purchaseOrderRef]').fill('PO-EXISTING');await page.getByRole('button',{name:'Link PO',exact:true}).click();
    assert.deepEqual(state.posts[0].body,{expectedRevision:1,purchaseOrderRef:'PO-EXISTING',customLinkage:true});assert.equal(state.posts[0].path,'/api/scm/special-stock-requests/1/purchase-order/link');
  }finally{await close();}
});
test('manual SO number can be linked before stock decisions or requested information are complete',async()=>{
  const {page,state,close}=await fixture(1440,{salesOrderId:null,salesOrderApproved:false,stage:'awaiting_stock',informationRequest:{status:'pending'},lines:[{id:36,productName:'SO stone',quantity:144,uom:'SQFT',salesDecision:'pending',supplyStatus:'no_stock'}]},'sales');
  try{await page.locator('[data-special-link-so-form] [name=salesOrderRef]').fill('SO-EXISTING');await page.getByRole('button',{name:'Link existing SO',exact:true}).click();
    assert.equal(state.posts[0].body.salesOrderRef,'SO-EXISTING');assert.equal(state.posts[0].path,'/api/sales/special-stock-requests/1/sales-order/link');
  }finally{await close();}
});

test('manual SO purchase review retains SCM-confirmed quantities, units, descriptions, costs and discounts',async()=>{
  const {page,state,close}=await fixture(390,{vendorDiscountReview:{mode:'per_line',lines:[{caseLineId:36,grossUnitCost:7,vendorDiscountPercent:0}],pallet:{quantity:0}},purchaseOrderLines:[{caseLineId:36,itemId:2055,description:'SCM reviewed material',quantity:22,uom:'PC',unitPurchaseCost:7}]});
  try{const material=page.locator('[data-special-po-line="36"]');
    for(const [name,value] of [['description','SCM reviewed material'],['quantity','22'],['uom','PC'],['unitPurchaseCost','7'],['vendorDiscountPercent','0']])await expect(material.locator(`[name=${name}]`)).toHaveValue(value);
    await page.getByRole('button',{name:'Create PO in NetSuite',exact:true}).click();assert.equal(state.posts[0].body.lines[0].quantity,'22');assert.equal(state.posts[0].body.lines[0].description,'SCM reviewed material');
  }finally{await close();}
});
