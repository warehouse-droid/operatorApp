/* global localStorage, document, window */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {normalizeSpecialCaseDraft} from '../../../src/special-stock-request-domain.js';
import {buildSpecialQuote} from '../../../src/special-stock-documents.js';
import {quotePdf} from '../../../src/field-sales/pdf.js';
import {pdfText} from '../../field-sales/pdf-text.js';

const out=process.env.SPECIAL_QUOTE_PALLET_BROWSER_OUTPUT||'test-artifacts/special-quote-pallet-20261001/browser';
const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture({width=1440,patch={},audience='sales'}={}){
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-quote-pallet'));
 const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
 const record={id:1,requestRef:'SPREQ-000001',revision:1,stage:'await_customer_confirmation',storeName:'3445',storeLocationId:1,
 customerName:'TEST Customer',customerPhone:'555-0100',vendorName:'TEST Vendor',netsuiteSalesRepId:123,netsuiteSalesRepName:'TEST Rep',
 inquiryDate:'2099-01-01',expiresOn:'2099-03-01',closeStatus:'active',fulfillmentMethod:'yard_pickup',palletTotal:3,palletRate:40,
 lines:[{id:10,lineNumber:1,productName:'TEST Stone',quantity:2,packageQuantity:2,uom:'PCS',rateUom:'PCS',originalRate:100,rate:100,discountPercent:10,
 pricingSource:'enquiry',requiredDate:'2099-02-01',supplyStatus:'in_stock',salesDecision:'pending'}],salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[],...patch};
 const state={posts:[],quotes:[],errors:[],record};page.on('pageerror',e=>state.errors.push(e.message));
 const pdf=async(input,draft)=>{const quote=buildSpecialQuote(input,profile,{draft}),buffer=await quotePdf(quote);state.quotes.push({quote,text:pdfText(buffer)});return buffer;};
 const apiRoute=async(route,path)=>{
   const req=route.request();
   if(req.method()==='POST'){
    const body=req.postDataJSON();state.posts.push({path,body});
    if(path.endsWith('/quote-preview')){return route.fulfill({body:await pdf(normalizeSpecialCaseDraft(body,{authorizedStoreLocationIds:[1]}),true),contentType:'application/pdf',headers:{'content-disposition':'inline; filename="draft.pdf"'}});}
    if(path==='/api/sales/special-stock-requests'){
     const lines=body.lines.map((line,index)=>({...line,id:10+index,lineNumber:index+1,originalRate:Number(line.rate),packageQuantity:Number(line.quantity),rateUom:line.uom,pricingSource:'enquiry',salesDecision:'pending',supplyStatus:null}));
     Object.assign(record,body,{lines,id:2,requestRef:'SPREQ-000002',stage:'new_enquiry',revision:1,closeStatus:'active'});return route.fulfill({status:201,json:record});
    }
    return route.fulfill({json:record});
   }
   if(path.endsWith('/quote.pdf')){return route.fulfill({body:await pdf(record,false),contentType:'application/pdf',headers:{'content-disposition':'inline; filename="saved.pdf"'}});}
   if(path==='/api/auth/me'){return route.fulfill({json:{operator:{id:'test-quote-pallet',display_name:'TEST Viewer',role:audience,roles:[audience],yard_location_ids:[1]}}});}
   if(path.endsWith('/policy')){return route.fulfill({json:{enabled:true}});}
   if(path.endsWith('/sales-reps')){return route.fulfill({json:{salesReps:[{id:123,name:'TEST Rep'}]}});}
   if(path.endsWith('/special-stock-requests')){return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],vendors:['TEST Vendor'],requests:[record]}});}
   if(path.endsWith('/special-stock-requests/1')||path.endsWith('/special-stock-requests/2')){return route.fulfill({json:record});}
   return route.fulfill({json:{requests:[],yards:[],total:0}});
 };
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(url.hostname!=='localhost'){return route.abort();}
  if(path.startsWith('/api/')){return apiRoute(route,path);}
  const file=path===`/${audience}/stock-requests`?`/${audience}-stock-requests.html`:path;
  try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);await expect(page.locator('.stock-request-card[data-id="1"]')).toBeVisible();
 return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
async function newDraft(page){
 await page.getByRole('button',{name:'New Special case',exact:true}).click();const form=page.locator('[data-special-case-form]');
 await form.locator('[name=customerName]').fill('TEST Customer');await form.locator('[name=vendorName]').fill('TEST Vendor');await form.locator('[name=salesRepId]').selectOption('123');
 await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup');
 const line=form.locator('[data-special-composer-line]').first();await line.locator('[name=productName]').fill('TEST Stone');await line.locator('[name=quantity]').fill('2');await line.locator('[name=uom]').selectOption('PCS');await line.locator('[name=rate]').fill('100');await line.locator('[name=discountPercent]').fill('10');await line.locator('[name=requiredDate]').fill('2099-02-01');return form;
}
test('new request PALLET inputs exist before quoting, survive rerenders, and reach both Preview and Submit to SCM',async()=>{
 const {page,state,close}=await fixture();try{
  const form=await newDraft(page);await expect(form.locator('[name=palletTotal]')).toHaveValue('0');
  await form.locator('[name=palletTotal]').fill('3');await form.locator('[name=palletRate]').fill('40');
  await expect(form.locator('[data-special-quote-pallet] [data-special-subtotal]')).toHaveText('$120.00');
  await form.getByRole('button',{name:'Add line',exact:true}).click();await expect(form.locator('[name=palletTotal]')).toHaveValue('3');await expect(form.locator('[name=palletRate]')).toHaveValue('40');
  await form.getByRole('button',{name:'Remove',exact:true}).last().click();await form.getByRole('button',{name:'Preview quote',exact:true}).click();
  await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.equal(state.posts.length,1);assert.equal(state.posts[0].path,'/api/sales/special-stock-requests/quote-preview');assert.equal(state.posts[0].body.palletTotal,'3');assert.equal(state.posts[0].body.palletRate,'40');
  assert.equal(state.quotes[0].text.split('PALLET').length,2);assert.equal(state.quotes[0].quote.snapshot.totalMinor,33900);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await form.locator('[data-special-quote-pallet]').screenshot({path:out+'/pallet-input.png'});
  await form.getByRole('button',{name:'Submit to SCM',exact:true}).click();await expect(form).toHaveCount(0);assert.equal(state.posts.length,2);assert.equal(state.posts[1].body.palletTotal,'3');assert.equal(state.posts[1].body.palletRate,'40');
  await page.getByRole('button',{name:'Preview saved quote',exact:true}).click();await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.equal(state.quotes[1].text.split('PALLET').length,2);
 }finally{await close();}
});
test('completed requests retain a working saved quote preview and download in Sales and SCM',async()=>{
 for(const audience of ['sales','scm']){
  const {page,state,close}=await fixture({audience,patch:{stage:'completed',operationallyComplete:true,
   salesOrderId:42,salesOrderRef:'SO-TEST-42',salesOrderStatus:'Billed',
   purchaseOrderId:43,purchaseOrderRef:'PO-TEST-43',purchaseOrderStatus:'Fully Billed'}});
  try{
   const button=page.getByRole('button',{name:'Preview saved quote',exact:true});
   await expect(button).toHaveCount(1);await expect(button).toBeEnabled();await button.click();
   const dialog=page.getByRole('dialog',{name:'MBBS quote preview'});
   await expect(dialog.locator('iframe')).toBeVisible();
   await expect(dialog.getByRole('link',{name:'Download PDF'})).toHaveAttribute('download','saved.pdf');
   assert.equal(state.quotes.length,1);assert.equal(state.quotes[0].quote.snapshot.totalMinor,33900);
   assert.match(state.quotes[0].text,/TEST Customer/);assert.equal(state.posts.length,0);
   await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(button).toBeFocused();
   await expect(page.locator('[data-special-document="sales_order"]')).toHaveCount(1);
   await expect(page.locator('[data-special-document="purchase_order"]')).toHaveCount(audience==='scm'?1:0);
  }finally{await close();}
 }
});
test('zero quantity omits PALLET from phone quote and positive quantity requires a rate while free PALLET is allowed',async()=>{
 const {page,state,close}=await fixture({width:390});try{
  const form=await newDraft(page),quantity=form.locator('[name=palletTotal]'),rate=form.locator('[name=palletRate]');await expect(quantity).toHaveValue('0');
  await expect(rate).not.toHaveAttribute('required');await form.getByRole('button',{name:'Preview quote',exact:true}).click();await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.doesNotMatch(state.quotes[0].text,/PALLET/);assert.equal(state.quotes[0].quote.snapshot.totalMinor,20340);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await quantity.fill('1');await expect(rate).toHaveAttribute('required','');
  await form.getByRole('button',{name:'Preview quote',exact:true}).click();assert.equal(state.posts.length,1);await expect(page.getByRole('dialog')).toHaveCount(0);
  await rate.fill('0');await form.getByRole('button',{name:'Preview quote',exact:true}).click();await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.equal(state.quotes[1].text.split('PALLET').length,2);assert.equal(state.quotes[1].quote.snapshot.totalMinor,20340);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 }finally{await close();}
});
test('closed request copying and SO draft preparation retain quoted PALLET quantity and sales rate',async()=>{
 for(const closed of [false,true]){
  const patch=closed?{closeStatus:'closed',stage:'closed',salesOrderId:42}:{lines:[{id:10,lineNumber:1,productName:'TEST Stone',quantity:2,packageQuantity:2,uom:'PCS',rateUom:'PCS',originalRate:100,rate:100,discountPercent:10,pricingSource:'enquiry',requiredDate:'2099-02-01',supplyStatus:'in_stock',salesDecision:'accepted'}]};
  const {page,state,close}=await fixture({patch});try{
   if(!closed){await expect(page.locator('[data-special-so-form] [name=palletTotal]')).toHaveValue('3');await expect(page.locator('[data-special-so-form] [name=palletRate]')).toHaveValue('40');}
   await page.getByRole('button',{name:'Copy the request',exact:true}).click();const form=page.locator('[data-special-case-form]');await expect(form.locator('[name=palletTotal]')).toHaveValue('3');await expect(form.locator('[name=palletRate]')).toHaveValue('40');assert.equal(state.posts.length,0);
  }finally{await close();}
 }
});
