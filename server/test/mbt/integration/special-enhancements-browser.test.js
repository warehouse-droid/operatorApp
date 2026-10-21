/* global document, localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const out=process.env.SPECIAL_ENHANCEMENTS_BROWSER_OUTPUT || 'test-artifacts/special-workflow-review/request-enhancements-20260928';
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture(audience='sales',width=1600,configure=()=>{}){
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-enhancements'));
 const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
 const state={posts:[],queries:[],errors:[],record:{id:1,requestRef:'SPREQ-TEST',stage:'new_enquiry',revision:1,storeName:'3445',storeLocationId:1,customerId:77,customerName:'Original Customer',customerPhone:'555-0199',netsuiteCustomerId:88,netsuiteCustomerName:'Account Lender',netsuiteSalesRepId:123,netsuiteSalesRepName:'Chosen Rep',vendorName:'Vendor A',vendorId:99,inquiryDate:'2026-09-28',expiresOn:'2026-10-28',closeStatus:'active',fulfillmentMethod:'yard_pickup',lines:[{id:1,productName:'Stone',color:'Buff',detailSpec:'Honed edge',quantity:2,uom:'SQFT',originalRate:10,rateUom:'SQFT',pricingSource:'enquiry',supplyStatus:'in_stock',salesDecision:'pending',palletQty:1,layerQty:2,sectionQty:3,pieceQty:4}],salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[]}};
 configure(state.record);page.on('pageerror',error=>state.errors.push(error.message));
 await page.route('**/*',async route=>{
 const url=new URL(route.request().url()),path=url.pathname;if(url.hostname!=='localhost')return route.abort();
 if(path.startsWith('/api/')){
 if(['POST','PUT'].includes(route.request().method())){const body=route.request().postDataJSON();state.posts.push({path,body});return route.fulfill({json:state.record});}
 if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-enhancements',display_name:'TEST Sales',role:audience,roles:[audience]}}});
 if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
 if(path.endsWith('/sales-reps'))return route.fulfill({json:{salesReps:[{id:123,name:'Chosen Rep'},{id:456,name:'Second Rep'}]}});
 if(path.endsWith('/customers'))return route.fulfill({json:{customers:[{id:88,displayName:'Account Lender',entityNumber:'ACCOUNT88',phone:'555-0188'}]}});
 if(path==='/api/sales/special-stock-requests/alerts')return route.fulfill({json:{awaitCustomerConfirmation:1,dispatchArrangement:2,waitForProduction:3,total:6}});
 if(path.endsWith('/special-stock-requests')){state.queries.push(url.searchParams.toString());return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],vendors:['Vendor A','B, Inc.','<Vendor>'],requests:[state.record]}});}
 if(path.endsWith('/special-stock-requests/1'))return route.fulfill({json:state.record});
 return route.fulfill({json:{requests:[],yards:[],total:0}});
 }
 const file=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path]||path;
 try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);await expect(page.locator('.stock-request-card[data-id="1"]')).toBeVisible();
 return {page,state,close:async()=>{await writeFile(`${out}/browser-coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
test('new request has required rep, calendar expiry and three proportional item rows with persistent values',async()=>{
 const {page,state,close}=await fixture();try{
 await page.getByRole('button',{name:'New Special case',exact:true}).click();const form=page.locator('[data-special-case-form]');
 await expect(form.locator('[name=salesRepId]')).toBeVisible();await form.locator('[name=salesRepId]').selectOption('456');
 await form.locator('[name=customerName]').fill('Actual End Customer');await form.locator('[name=vendorName]').fill('Vendor A');await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup');
 await form.locator('[name=productName]').fill('Stone');await form.locator('[name=detailSpec]').fill('Honed edge');await form.locator('[name=quantity]').fill('2');await form.locator('[name=uom]').selectOption('SQFT');await form.locator('[name=rate]').fill('10');await form.locator('[name=pieceQty]').fill('4');
 const sizes=await form.locator('.special-case-product-row input').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));assert.ok(Math.abs(sizes[0]/sizes[1]-2)<0.06);assert.ok(Math.abs(sizes[3]/sizes[2]-2)<0.06);
 const packs=await form.locator('.special-case-delivery-row input').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));assert.ok(Math.abs(packs[0]/packs[2]-3)<0.06);assert.ok(Math.abs(packs[1]/packs[2]-4)<0.06);
 const row=await form.locator('.special-case-pricing-row [name]').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));assert.ok(row.every(y=>y===row[0]));
 await form.getByRole('button',{name:'Refresh reps'}).click();await expect(form.locator('[name=detailSpec]')).toHaveValue('Honed edge');await expect(form.locator('[name=salesRepId]')).toHaveValue('456');
 await page.screenshot({path:`${out}/new-request-desktop.png`});await form.getByRole('button',{name:'Submit to SCM'}).click();await expect.poll(()=>state.posts.length).toBe(1);
 const saved=state.posts[0].body;assert.equal(Number(saved.salesRepId),456);assert.equal(saved.lines[0].detailSpec,'Honed edge');assert.equal(saved.lines[0].uom,'SQFT');assert.equal(Number(saved.lines[0].pieceQty),4);assert.match(saved.expiresOn,/^\d{4}-\d{2}-\d{2}$/);assert.deepEqual(state.errors,[]);
 }finally{await close();}
});
for(const audience of ['sales','scm'])test(`${audience} supports multiple vendors and preserves selections on refresh`,async()=>{
 const {page,state,close}=await fixture(audience);try{
 const menu=page.locator('.special-vendor-filter');await menu.locator('summary').click();await menu.getByLabel('Vendor A',{exact:true}).check();await menu.getByLabel('B, Inc.',{exact:true}).check();
 await expect.poll(()=>new URLSearchParams(state.queries.at(-1)).get('vendorNames')).toBe('["Vendor A","B, Inc."]');
 const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/${audience}/special-stock-requests`);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await (await refreshed).finished();
 if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click();
 await expect(menu.getByLabel('Vendor A',{exact:true})).toBeChecked();
 await menu.getByRole('button',{name:'Clear selection'}).click();await expect.poll(()=>new URLSearchParams(state.queries.at(-1)).get('vendorNames')).toBe('[]');assert.deepEqual(state.errors,[]);
 }finally{await close();}
});
test('SO account stays separate from original customer and Sales alert links to own queue',async()=>{
 const {page,state,close}=await fixture('sales',1600,d=>{d.lines[0].salesDecision='accepted';d.lines[0].brand='Vendor A';d.lines[0].size='12';d.stage='confirmed';});try{
 const form=page.locator('[data-special-so-form]');await expect(form.getByText('NetSuite customer account *',{exact:true})).toBeVisible();await expect(form.locator('[name=customerSearch]')).toHaveValue('Account Lender');await expect(page.locator('.stock-request-detail')).toContainText('Original Customer');await expect(page.locator('.stock-request-detail')).toContainText('555-0199');
 await expect(form.locator('[name=description]')).toHaveValue('Stone Buff 12 Honed edge');
 const alert=page.locator('a.sales-special-alert');await expect(alert).toBeVisible();await expect(alert).toHaveAttribute('href',/mine=1/);await expect(alert).toHaveAttribute('title',/production.*Transfer/);
 await form.locator('[name=customerSearch]').fill('Account');await page.locator('[data-special-sales-action="choose-customer"]').click();await form.locator('[name=palletTotal]').fill('0');await form.getByRole('button',{name:'Save SO draft'}).click();await expect.poll(()=>state.posts.length).toBe(1);assert.equal(Number(state.posts[0].body.customerId),88);assert.equal(state.record.customerId,77);
 assert.equal(state.posts[0].body.materialLines[0].description,'Stone Buff 12 Honed edge');
 await alert.click();await expect(page.locator('[data-special-mine]')).toBeChecked();for(const stage of ['await_customer_confirmation','dispatch_arrangement','wait_for_production'])await expect(page.locator(`[data-special-stage][value="${stage}"]`)).toBeChecked();assert.equal(new URLSearchParams(state.queries.at(-1)).get('mine'),'1');
 }finally{await close();}
});
test('mobile composer stays within the page and shows specification and expiry controls',async()=>{
 const {page,close}=await fixture('sales',390);try{
 await page.getByRole('button',{name:'New Special case',exact:true}).click();await expect(page.locator('[name=detailSpec]')).toBeVisible();await expect(page.locator('[name=expiresOn]')).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));await page.screenshot({path:`${out}/new-request-mobile.png`,fullPage:true});
 }finally{await close();}
});
