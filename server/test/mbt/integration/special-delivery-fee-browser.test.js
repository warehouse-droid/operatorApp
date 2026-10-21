/* global localStorage */
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {normalizeSpecialCaseDraft} from '../../../src/special-stock-request-domain.js';
import {buildSpecialQuote} from '../../../src/special-stock-documents.js';
import {quotePdf} from '../../../src/field-sales/pdf.js';
import {pdfText} from '../../field-sales/pdf-text.js';

const out=process.env.SPECIAL_DELIVERY_FEE_BROWSER_OUTPUT||'test-artifacts/special-delivery-fee-20261001/browser';
const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture({width=1440,patch={}}={}){
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
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;if(url.hostname!=='localhost')return route.abort();
  if(path.startsWith('/api/')){
   if(req.method()==='POST'){
    const body=req.postDataJSON();state.posts.push({path,body});
    if(path.endsWith('/quote-preview'))return route.fulfill({body:await pdf(normalizeSpecialCaseDraft(body,{authorizedStoreLocationIds:[1]}),true),contentType:'application/pdf',headers:{'content-disposition':'inline; filename="draft.pdf"'}});
    if(path==='/api/sales/special-stock-requests'){
     const lines=body.lines.map((line,index)=>({...line,id:10+index,lineNumber:index+1,originalRate:Number(line.rate),packageQuantity:Number(line.quantity),rateUom:line.uom,pricingSource:'enquiry',salesDecision:'pending',supplyStatus:null}));
     Object.assign(record,body,{lines,id:2,requestRef:'SPREQ-000002',stage:'new_enquiry',revision:1,closeStatus:'active'});return route.fulfill({status:201,json:record});
    }
    return route.fulfill({json:record});
   }
   if(path.endsWith('/quote.pdf'))return route.fulfill({body:await pdf(record,false),contentType:'application/pdf',headers:{'content-disposition':'inline; filename="saved.pdf"'}});
   if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-quote-pallet',display_name:'TEST Sales',role:'sales',roles:['sales'],yard_location_ids:[1]}}});
   if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
   if(path.endsWith('/sales-reps'))return route.fulfill({json:{salesReps:[{id:123,name:'TEST Rep'}]}});
   if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],vendors:['TEST Vendor'],requests:[record]}});
   if(path.endsWith('/special-stock-requests/1')||path.endsWith('/special-stock-requests/2'))return route.fulfill({json:record});
   return route.fulfill({json:{requests:[],yards:[],total:0}});
  }
  const file=path==='/sales/stock-requests'?'/sales-stock-requests.html':path;
  try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/sales/stock-requests?tab=special');await expect(page.locator('.stock-request-card[data-id="1"]')).toBeVisible();
 return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
async function newDraft(page){
 await page.getByRole('button',{name:'New Special case',exact:true}).click();const form=page.locator('[data-special-case-form]');
 await form.locator('[name=customerName]').fill('TEST Customer');await form.locator('[name=vendorName]').fill('TEST Vendor');await form.locator('[name=salesRepId]').selectOption('123');
 await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup');
 const line=form.locator('[data-special-composer-line]').first();await line.locator('[name=productName]').fill('TEST Stone');await line.locator('[name=quantity]').fill('2');await line.locator('[name=uom]').selectOption('PCS');await line.locator('[name=rate]').fill('100');await line.locator('[name=discountPercent]').fill('10');await line.locator('[name=requiredDate]').fill('2099-02-01');return form;
}

test('Sales enters Delivery fee below PALLET; rerenders, quote preview and submission retain it',async()=>{
 const {page,state,close}=await fixture();try{
  const form=await newDraft(page);await expect(form.locator('[name=deliveryFeeRate]')).toHaveCount(0);
  await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');await form.locator('[name=deliveryAddress]').fill('TEST Address');
  const rate=form.locator('[name=deliveryFeeRate]');await expect(rate).toHaveValue('');await expect(rate).toHaveAttribute('required','');
  const pallet=await form.locator('[data-special-quote-pallet]').boundingBox(),fee=await form.locator('[data-special-delivery-fee]').boundingBox();assert.ok(fee.y>=pallet.y+pallet.height);
  await form.getByRole('button',{name:'Submit to SCM',exact:true}).click();assert.equal(state.posts.length,0);
  await rate.fill('235');await form.getByRole('button',{name:'Add line',exact:true}).click();await expect(rate).toHaveValue('235');await form.getByRole('button',{name:'Remove',exact:true}).last().click();
  await form.getByRole('button',{name:'Preview quote',exact:true}).click();await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.match(state.quotes[0].text,/Delivery Charge/);assert.equal(state.posts[0].body.deliveryFeeRate,'235');
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await form.locator('[data-special-delivery-fee]').screenshot({path:out+'/sales-delivery-fee.png'});
  await form.getByRole('button',{name:'Submit to SCM',exact:true}).click();await expect(form).toHaveCount(0,{timeout:1000});assert.equal(state.posts[1].body.deliveryFeeRate,'235');await expect(page.locator('[data-special-delivery-fee-line]')).toContainText('$235.00');
 }finally{await close();}
});
test('phone form supports free delivery, hides the fee for pickup and preserves it when switching back',async()=>{
 const {page,state,close}=await fixture({width:390});try{
  const form=await newDraft(page);await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');await form.locator('[name=deliveryAddress]').fill('TEST Address');await form.locator('[name=deliveryFeeRate]').fill('0');
  await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup');await expect(form.locator('[name=deliveryFeeRate]')).toHaveCount(0);
  await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');await expect(form.locator('[name=deliveryFeeRate]')).toHaveValue('0');
  await form.getByRole('button',{name:'Preview quote',exact:true}).click();await expect(page.getByRole('dialog').locator('iframe')).toBeVisible();assert.doesNotMatch(state.quotes[0].text,/Delivery Charge/);assert.equal(state.quotes[0].quote.snapshot.totalMinor,20340);await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 }finally{await close();}
});
test('quoted and manually added delivery fees prefill SO preparation and request copies',async()=>{
 for(const legacy of [false,true]){
  const patch={fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',deliveryFeeRate:legacy?null:235,salesOrderLines:legacy?[{ancillary:true,itemId:1987,quantity:1,rate:235}]:[],lines:[{id:10,lineNumber:1,productName:'TEST Stone',quantity:2,packageQuantity:2,uom:'PCS',rateUom:'PCS',originalRate:100,rate:100,discountPercent:10,pricingSource:'enquiry',requiredDate:'2099-02-01',supplyStatus:'in_stock',salesDecision:'accepted'}]};
  const {page,close}=await fixture({patch});try{
   await expect(page.locator('[data-special-so-form] [name=deliveryFeeRate]')).toHaveValue('235');await expect(page.locator('[data-special-ancillary]')).toHaveCount(0);
   await page.getByRole('button',{name:'Copy the request',exact:true}).click();await expect(page.locator('[data-special-case-form] [name=deliveryFeeRate]')).toHaveValue('235');
  }finally{await close();}
 }
});
