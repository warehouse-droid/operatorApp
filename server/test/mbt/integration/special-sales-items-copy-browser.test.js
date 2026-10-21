/* global localStorage, getComputedStyle, Node, structuredClone */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const out=process.env.SPECIAL_SALES_ACTIONS_BROWSER_OUTPUT||'test-artifacts/special-sales-items-copy-20261001/browser';let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture({width=1440,patch={}}={}){
 const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','test-items-copy'));
 const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
 const record={id:1,requestRef:'SPREQ-000001',revision:3,stage:'await_customer_confirmation',storeName:'3445',storeLocationId:1,
 customerId:77,customerName:'Customer <One>',customerPhone:'555-0100',vendorId:331,vendorName:'Vendor One',netsuiteSalesRepId:123,netsuiteSalesRepName:'Chosen Rep',
 inquiryDate:'2026-09-01',expiresOn:'2099-03-01',closeStatus:'active',fulfillmentMethod:'mbt_delivery',deliveryAddress:'10 Main',deliveryContactName:'Sam',deliveryContactPhone:'555-0101',
 deliveryDate:'2099-02-01',windowStart:'09:00',windowEnd:'12:00',deliveryInstructions:'Use side gate',remarks:'Keep gate closed',
 lines:[{id:1,lineNumber:1,brand:'Vendor One',productName:'Stone <paver>',color:'Buff',size:'12',detailSpec:'Honed edge',quantity:2,uom:'PLT',originalRate:12.25,discountPercent:10,
 pricingSource:'enquiry',rateUom:'PLT',palletQty:2,layerQty:3,sectionQty:4,pieceQty:5,requiredDate:'2099-02-01',customerNote:'Ask first',supplyStatus:'in_stock',salesDecision:'pending'}],
 salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[],...patch};
 const state={record,posts:[],errors:[],rejectNext:false};page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;if(url.hostname!=='localhost')return route.abort();
  if(path.startsWith('/api/')){
   if(['POST','PUT'].includes(req.method())){
    const body=req.postDataJSON();state.posts.push({path,body});
    if(state.rejectNext){state.rejectNext=false;return route.fulfill({status:409,json:{error:'Request changed. Review the refreshed request and retry.',code:'SPECIAL_REVISION_CONFLICT'}});}
    if(path.endsWith('/items')){
     record.lines.push(...body.lines.map((line,i)=>({...line,id:10+i,lineNumber:record.lines.length+i+1,originalRate:Number(line.rate),supplyStatus:null,salesDecision:'pending'})));
     record.revision++;record.stage='new_enquiry';record.salesOrderLines=[];
    }
    if(path.endsWith('/customer-decisions')){for(const decision of body.lines)record.lines.find(line=>line.id===decision.lineId).salesDecision=decision.decision;record.revision++;}
    return route.fulfill({json:path.endsWith('/special-stock-requests')?{...record,id:2,requestRef:'SPREQ-000002',stage:'new_enquiry',closeStatus:'active',lines:body.lines}:record});
   }
   if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test-items-copy',display_name:'TEST Sales',role:'sales',roles:['sales'],yard_location_ids:[1,28]}}});
   if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
   if(path.endsWith('/sales-reps'))return route.fulfill({json:{salesReps:[{id:123,name:'Chosen Rep'},{id:456,name:'Second Rep'}]}});
   if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'}],vendors:['Vendor One'],requests:[record]}});
   if(path.endsWith('/special-stock-requests/1'))return route.fulfill({json:record});
   return route.fulfill({json:{requests:[],yards:[],total:0}});
  }
  const file=path==='/sales/stock-requests'?'/sales-stock-requests.html':path;
  try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}
  catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/sales/stock-requests?tab=special');await expect(page.locator('.stock-request-card[data-id="1"]')).toBeVisible();
 return {page,state,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
async function openItems(page){await page.getByRole('button',{name:'Add item',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Continue',exact:true}).click();return page.locator('[data-special-add-items-form]');}
async function fillItem(form,name='New item'){
 const line=form.locator('[data-special-composer-line]').last();await line.locator('[name=productName]').fill(name);await line.locator('[name=quantity]').fill('3');await line.locator('[name=uom]').selectOption('PCS');await line.locator('[name=rate]').fill('12.25');await line.locator('[name=requiredDate]').fill('2099-02-01');
}
async function checkActionRow(page,width){
 const row=page.locator('.special-case-line-actions'),save=page.getByRole('button',{name:'Save customer decisions',exact:true}),add=page.getByRole('button',{name:'Add item',exact:true});
 await expect(save).toBeVisible();await expect(add).toBeVisible();
 const [rowBox,saveBox,addBox]=await Promise.all([row.boundingBox(),save.boundingBox(),add.boundingBox()]);
 assert.ok(Math.abs(saveBox.y+saveBox.height/2-addBox.y-addBox.height/2)<1,'actions share a row');
 assert.ok(Math.abs(saveBox.x-rowBox.x)<1,'Save stays on the left');
 assert.ok(Math.abs(addBox.x+addBox.width-rowBox.x-rowBox.width)<1,'Add item stays on the right');
 assert.ok(addBox.x-saveBox.x-saveBox.width>=15,'actions have a clear gap');
 assert.ok(addBox.x+addBox.width<=width,'actions fit the viewport');
 assert.ok(await add.evaluate(node=>Boolean(node.closest('form').querySelector('.stock-request-lines').compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)));
 return {width,row:rowBox,save:saveBox,add:addBox};
}
test('purple Add item shares the Save decisions row after Case lines before Close; centered warning can be cancelled or escaped without writing',async()=>{
 const {page,state,close}=await fixture();try{
 const add=page.getByRole('button',{name:'Add item',exact:true});await expect(add).toBeVisible();
 assert.equal(await add.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(124, 58, 237)');
 await checkActionRow(page,1440);
 assert.ok(await add.evaluate(node=>Boolean(node.compareDocumentPosition(document.querySelector('[data-special-close-form]'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 await add.click();const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Adding new items will make this request become a new request again.');await expect(dialog).toContainText('before creating a Sales Order');
 const box=await dialog.boundingBox();assert.ok(Math.abs(box.x+box.width/2-720)<2);assert.ok(Math.abs(box.y+box.height/2-500)<2);
 await page.screenshot({path:out+'/centered-warning.png',fullPage:true});await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);
 await add.click();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);assert.equal(state.posts.length,0);await expect(page.locator('[data-special-add-items-form]')).toHaveCount(0);
 }finally{await close();}
});
test('Save customer decisions stays left and Add item right on one row across desktop and phone widths',async()=>{
 const layouts=[];
 for(const width of [1440,1280,1024,390,360]){
  const {page,state,close}=await fixture({width});try{
   layouts.push(await checkActionRow(page,width));assert.equal(state.posts.length,0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
   await page.locator('.special-case-line-actions').scrollIntoViewIfNeeded();
   if(width===1440||width===390)await page.screenshot({path:`${out}/actions-${width}.png`,fullPage:true});
  }finally{await close();}
 }
 await writeFile(`${out}/action-layout.json`,JSON.stringify(layouts,null,2));
});
test('add item editor submits only new lines, retains inputs on failure and returns New enquiry while old items stay visible',async()=>{
 const {page,state,close}=await fixture();const original=structuredClone(state.record.lines);try{
 let form=await openItems(page);await fillItem(form);await form.getByRole('button',{name:'Add another item'}).click();await fillItem(form,'Second new item');
 await expect(form.locator('[name=productName]').first()).toHaveValue('New item');state.rejectNext=true;
 await form.getByRole('button',{name:'Submit new items to SCM'}).click();await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');
 form=page.locator('[data-special-add-items-form]');await expect(form.locator('[name=productName]').first()).toHaveValue('New item');await expect(form.locator('[name=productName]').last()).toHaveValue('Second new item');
 await form.getByRole('button',{name:'Submit new items to SCM'}).click();await expect(form).toHaveCount(0);await expect(page.locator('.stock-request-detail')).toContainText('New enquiry');
 assert.equal(state.posts.length,2);assert.equal(state.posts[1].path,'/api/sales/special-stock-requests/1/items');assert.equal(state.posts[1].body.expectedRevision,3);
 assert.deepEqual(state.posts[1].body.lines.map(line=>line.productName),['New item','Second new item']);assert.deepEqual(state.record.lines.slice(0,1),original);
 await expect(page.locator('.stock-request-detail')).toContainText('Stone <paver>');assert.equal(state.record.lines.length,3);
 }finally{await close();}
});
test('copy beside SPREQ includes closed request fields and all items, makes no POST until explicit Submit to SCM',async()=>{
 const {page,state,close}=await fixture({patch:{closeStatus:'closed',stage:'closed',salesOrderId:42,salesOrderRef:'SOB42',purchaseOrderId:43,purchaseOrderRef:'POB43'}});
 const original=structuredClone(state.record);try{
 const copy=page.getByRole('button',{name:'Copy the request',exact:true});await expect(copy).toBeVisible();assert.ok(await copy.evaluate(node=>node.closest('.stock-request-heading').querySelector('h2').textContent.includes('SPREQ-000001')));
 await copy.click();const form=page.locator('[data-special-case-form]');await expect(form).toBeVisible();assert.equal(state.posts.length,0);
 for(const [name,value] of Object.entries({storeLocationId:'1',customerName:'Customer <One>',customerPhone:'555-0100',vendorName:'Vendor One',salesRepId:'123',fulfillmentMethod:'mbt_delivery',deliveryAddress:'10 Main',deliveryContactName:'Sam',deliveryContactPhone:'555-0101',deliveryDate:'2099-02-01',windowStart:'09:00',windowEnd:'12:00',deliveryInstructions:'Use side gate',remarks:'Keep gate closed',productName:'Stone <paver>',color:'Buff',size:'12',detailSpec:'Honed edge',quantity:'2',uom:'PLT',rate:'12.25',discountPercent:'10',palletQty:'2',layerQty:'3',sectionQty:'4',pieceQty:'5',customerNote:'Ask first'}))await expect(form.locator('[name='+name+']')).toHaveValue(value);
 assert.notEqual(await form.locator('[name=inquiryDate]').inputValue(),original.inquiryDate);assert.notEqual(await form.locator('[name=expiresOn]').inputValue(),original.expiresOn);
 await form.locator('[name=productName]').fill('Copied edited item');assert.deepEqual(state.record,original);assert.equal(state.posts.length,0);
 // Complete the new Sales-entered fee when checking the upgraded form; keep the old-source comparison runnable.
 if(await form.locator('[name=deliveryFeeRate]').count())await form.locator('[name=deliveryFeeRate]').fill('0');
 await form.getByRole('button',{name:'Submit to SCM',exact:true}).click();await expect(form).toHaveCount(0);assert.equal(state.posts.length,1);
 const payload=state.posts[0].body;assert.equal(state.posts[0].path,'/api/sales/special-stock-requests');assert.equal(payload.customerId,77);assert.equal(payload.vendorId,331);assert.equal(payload.salesRepId,'123');assert.equal(payload.lines[0].productName,'Copied edited item');assert.equal(payload.lines[0].rate,12.25);
 for(const key of ['id','salesOrderId','purchaseOrderId','closeStatus','stage'])assert.equal(Object.hasOwn(payload,key),false,key);
 assert.equal(Object.hasOwn(payload.lines[0],'supplyStatus'),false);assert.deepEqual(state.record,original);
 }finally{await close();}
});
test('copy cancellation and add-item cancellation keep source unchanged and new draft removal never removes old lines',async()=>{
 const {page,state,close}=await fixture();const original=structuredClone(state.record);try{
 await page.getByRole('button',{name:'Copy the request'}).click();await page.locator('[data-special-case-form]').getByRole('button',{name:'Close',exact:true}).click();
 // Cancellation returns to the source request so Sales can continue working.
 await expect(page.locator('.stock-request-detail h2')).toHaveText(original.requestRef);
 const form=await openItems(page);await fillItem(form);await form.getByRole('button',{name:'Add another item'}).click();await fillItem(form,'Remove me');await form.getByRole('button',{name:'Remove',exact:true}).last().click();
 await expect(form.locator('[name=productName]')).toHaveValue('New item');await form.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(state.posts.length,0);assert.deepEqual(state.record,original);
 }finally{await close();}
});
test('Add item is hidden after SO, skipped SO, closure or remote submission; Copy remains available for closed cases',async()=>{
 for(const patch of [{salesOrderId:42,salesOrderRef:'SOB42'},{salesOrderSkipped:true},{closeStatus:'closed',stage:'closed'},{salesOrderSubmissionStartedAt:'2026-10-01'},{quantityReviewPending:true}]){
  const {page,state,close}=await fixture({patch});try{await expect(page.getByRole('button',{name:'Add item',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Copy the request'})).toBeVisible();assert.equal(state.posts.length,0);}finally{await close();}
 }
});
test('phone warning, append form and copy draft remain usable at 390 pixels',async()=>{
 const {page,state,close}=await fixture({width:390});try{
 await page.getByRole('button',{name:'Add item',exact:true}).click();const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
 await page.getByRole('dialog').getByRole('button',{name:'Continue'}).click();await fillItem(page.locator('[data-special-add-items-form]'));await page.locator('[data-special-add-items-form]').getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Copy the request'}).click();await expect(page.locator('[data-special-case-form]')).toBeVisible();assert.equal(state.posts.length,0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:out+'/copy-phone.png',fullPage:true});
 }finally{await close();}
});
test('SO created in another session blocks append without hiding unsaved items or trapping the user',async()=>{
 const {page,state,close}=await fixture();try{
 const form=await openItems(page);await fillItem(form,'Keep this entered item');
 Object.assign(state.record,{salesOrderId:42,salesOrderRef:'SOB42',revision:4,stage:'confirmed'});state.rejectNext=true;
 await form.getByRole('button',{name:'Submit new items to SCM'}).click();
 await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');
 await expect(form.locator('[name=productName]')).toHaveValue('Keep this entered item');await expect(form.getByRole('button',{name:'Submit new items to SCM'})).toBeDisabled();
 await form.getByRole('button',{name:'Cancel',exact:true}).click();await expect(form).toHaveCount(0);await expect(page.getByRole('button',{name:'Copy the request'})).toBeEnabled();assert.equal(state.posts.length,1);
 }finally{await close();}
});
test('existing post-SO quantity adjustment still submits material quantity, discount and PALLET review while Add item stays unavailable',async()=>{
 const {page,state,close}=await fixture({patch:{salesOrderId:42,salesOrderRef:'SOB42',stage:'confirmed',palletTotal:0,palletRate:null,
 lines:[{id:1,productName:'Existing stone',quantity:2,packageQuantity:2,uom:'PLT',rateUom:'PLT',originalRate:12.25,discountPercent:10,pricingSource:'enquiry',supplyStatus:'in_stock',salesDecision:'accepted'}]}});
 try{
 await page.locator('[data-special-adjustment-section]').getByRole('button',{name:'Edit',exact:true}).click();
 const form=page.locator('[data-special-quantity-form]');await expect(form).toBeVisible();await expect(page.getByRole('button',{name:'Add item',exact:true})).toHaveCount(0);
 await form.locator('[name=quantity]').fill('4');await form.locator('[name=discountPercent]').fill('5');await form.locator('[name=palletTotal]').fill('3');await form.locator('[name=palletRate]').fill('40');await form.locator('button[type=submit]').click();
 assert.equal(state.posts.length,1);assert.equal(state.posts[0].path,'/api/sales/special-stock-requests/1/quantity-change');
 assert.deepEqual(state.posts[0].body,{expectedRevision:3,palletTotal:'3',palletRate:'40',lines:[{caseLineId:1,quantity:'4',discountPercent:'5'}]});
 }finally{await close();}
});
test('Sales can accept the old item and then add a new item without losing the old decision, name, price or stock',async()=>{
 const {page,state,close}=await fixture();try{
 const decisions=page.locator('[data-special-decisions-form]');await decisions.locator('[name=decision]').selectOption('accepted');await decisions.getByRole('button',{name:'Save customer decisions'}).click();
 await expect.poll(()=>state.posts.length).toBe(1);assert.equal(state.posts[0].path,'/api/sales/special-stock-requests/1/customer-decisions');assert.equal(state.posts[0].body.lines[0].lineId,1);assert.equal(state.posts[0].body.lines[0].decision,'accepted');
 const original=structuredClone(state.record.lines[0]),form=await openItems(page);await fillItem(form);await form.getByRole('button',{name:'Submit new items to SCM'}).click();await expect(form).toHaveCount(0);
 assert.deepEqual(state.record.lines[0],original);assert.equal(state.record.lines[0].salesDecision,'accepted');assert.equal(state.record.stage,'new_enquiry');await expect(page.locator('[data-special-so-form]')).toHaveCount(0);
 }finally{await close();}
});
