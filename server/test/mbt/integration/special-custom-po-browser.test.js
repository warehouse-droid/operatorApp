/* global localStorage, document */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

const out=process.env.SPECIAL_CUSTOM_PO_BROWSER_OUTPUT||'test-artifacts/special-delivery-fee-20261001/custom-po-browser';
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture(width=1440) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-custom-po'));
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const record={id:1,requestRef:'SPREQ-000024',revision:1,stage:'so_approved',storeLocationId:1,storeName:'3445',customerName:'TEST Customer',vendorName:'TEST Vendor',vendorId:331,
    fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',deliveryFeeRate:235,palletTotal:0,salesOrderId:1033108,salesOrderRef:'SOB121882',salesOrderApproved:true,closeStatus:'active',purchaseOrderOperationStatus:'idle',
    lines:[{id:36,lineNumber:1,productName:'SO stone',quantity:144,uom:'SQFT',salesDecision:'accepted',supplyStatus:'in_stock'}],
    salesOrderLines:[{id:59,caseLineId:36,itemId:2055,description:'SO description',quantity:144,uom:'SQFT',rate:17.95}],
    purchaseOrderLines:[{id:60,caseLineId:36,itemId:2055,description:'Independent PO description',quantity:12,uom:'PC'}],events:[],media:[],readinessAlerts:[]};
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
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-custom-po',display_name:'TEST SCM',role:'scm',roles:['scm']}}});
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      if(path.endsWith('/special-stock-requests/1'))return route.fulfill({json:record});
      if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],requests:[record]}});
      return route.fulfill({json:{requests:[],yards:[],total:0}});
    }
    const file=path==='/scm/stock-requests'?'/scm-stock-requests.html':path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://localhost/scm/stock-requests?tab=special');await expect(page.locator('[data-special-po-form]')).toBeVisible();
  return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
test('desktop and phone link existing PO beside Create PO without requiring new-PO costs, preserving input on refresh',async()=>{
  for(const width of [1440,390]) {
    const {page,state,close}=await fixture(width);try {
      const form=page.locator('[data-special-po-form]'),input=form.locator('[name=purchaseOrderRef]');await expect(input).toBeVisible();
      await form.getByRole('button',{name:'Create PO in NetSuite',exact:true}).click();assert.equal(state.posts.length,0);
      const original=JSON.stringify(state.record.salesOrderLines);await input.fill('PO-CUSTOM-001');
      await page.locator('[data-special-scm-action=refresh]').click();await expect(input).toHaveValue('PO-CUSTOM-001');
      await form.locator('.stock-request-actions').screenshot({path:`${out}/custom-po-${width}.png`});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
      await form.getByRole('button',{name:'Link PO',exact:true}).click();await expect(input).toHaveCount(0);
      assert.deepEqual(state.posts,[{path:'/api/scm/special-stock-requests/1/purchase-order/link',body:{expectedRevision:1,purchaseOrderRef:'PO-CUSTOM-001',customLinkage:true}}]);
      assert.equal(JSON.stringify(state.record.salesOrderLines),original);await expect(page.getByText(/Custom PO linkage: SO and PO details are independent/)).toBeVisible();
    }finally{await close();}
  }
});
test('empty linkage fails locally and Enter links the PO; server errors retain the entered number for retry',async()=>{
  const {page,state,close}=await fixture();try {
    const form=page.locator('[data-special-po-form]'),input=form.locator('[name=purchaseOrderRef]');
    await form.getByRole('button',{name:'Link PO',exact:true}).click();await expect(page.getByText('Enter an existing PO number to link.',{exact:true})).toBeVisible();assert.equal(state.posts.length,0);
    await input.fill('PO-CUSTOM-002');state.fail=true;await input.press('Enter');await expect(page.getByText('PO was not found. Check the number.',{exact:true})).toBeVisible();await expect(input).toHaveValue('PO-CUSTOM-002');
    state.fail=false;await input.press('Enter');await expect(input).toHaveCount(0);assert.equal(state.posts.length,2);assert.ok(state.posts.every(post=>post.path.endsWith('/purchase-order/link')&&post.body.customLinkage===true));
  }finally{await close();}
});
test('Create PO retains the normal reviewed-line submission even when custom number is filled',async()=>{
  const {page,state,close}=await fixture();try {
    const form=page.locator('[data-special-po-form]');await form.locator('[name=purchaseOrderRef]').fill('IGNORED-FOR-CREATE');
    await form.locator('[name=unitPurchaseCost]').fill('5');await form.locator('[name=vendorDiscountPercent]').fill('0');
    await form.getByRole('button',{name:'Create PO in NetSuite',exact:true}).click();await expect(form).toHaveCount(0);
    assert.equal(state.posts.length,1);assert.equal(state.posts[0].path,'/api/scm/special-stock-requests/1/purchase-order/create');assert.equal(state.posts[0].body.customLinkage,undefined);
    assert.equal(state.posts[0].body.lines[0].description,'Independent PO description');assert.equal(Number(state.posts[0].body.lines[0].quantity),12);assert.equal(state.posts[0].body.lines[0].uom,'PC');
  }finally{await close();}
});
