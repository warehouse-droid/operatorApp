/* global selectedOrder, selectedId, currentModule, viewMode, render, operator, fulfillmentOrder, fulfillmentPhotoDataUrls, fulfillmentLoadRequestId, fulfillmentNetSuitePolicy, confirmationSummaries, consolidationLoadState, prepareConsolidationLoadProof, fulfillmentRequiredPhotoCount, localStorage, window */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium,expect} from '@playwright/test';
const root=path.resolve(process.env.LOAD_FOLLOWUP_PUBLIC||'public'),artifact='test-artifacts/load-followup';
const order={netsuite_id:'995451',tranid:'SOB120541',order_type:'sales_order',customer:'Fixture',outbound_location_id:1,outbound_location:'3445',operator_status:'packed',status:'B',status_text:'Pending Fulfillment',delivery_method:'Pick-Up',netsuite_active:true,
 lines:[1,2,3,4].map(id=>({id:String(id),line_id:id,item_id:id,sku:id===4?'PALLET':`PRODUCT-${id}`,item_name:`Item ${id}`,item_type:'InvtPart',quantity:2,unit:'PC',loaded_qty:0,packed_sales_qty:id===4?0:2,netsuite_active:true})),
 confirmationSummary:{orderId:'995451',orderRef:'SOB120541',total:4,confirmed:3,missing:[{id:'4',sku:'PALLET'}]}};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[],coverage=[];
try{
 for(const mode of ['pickup','delivery','blocked','attention','consolidation','all-confirmed','remaining-only','recovered-partial','lost-response','complete','failed','claim-race','confirmation-change','refresh-complete','detail-error','corrupt-journal','refresh-empty']){
  console.log(JSON.stringify({mode}));
  const page=await browser.newPage({viewport:{width:1024,height:768},serviceWorkers:'block'}),errors=[],posts=[];
  let current=structuredClone(order),detailError=false,jobComplete=false;
  if(mode==='all-confirmed'){current.lines[3].packed_sales_qty=2;current.confirmationSummary={...current.confirmationSummary,confirmed:4,missing:[]};}
  if(['remaining-only','recovered-partial'].includes(mode)){current.lines=current.lines.map((line,i)=>({...line,loaded_qty:i<3?2:0,packed_sales_qty:i===3&&mode==='recovered-partial'?2:0}));current.confirmationSummary={...current.confirmationSummary,total:1,confirmed:mode==='recovered-partial'?1:0,missing:mode==='recovered-partial'?[]:[{id:'4',sku:'PALLET'}]};}
  if(mode==='blocked')current.posting={jobId:'job-one',status:'attention',loadBlocked:true,transactions:[{id:996410,ref:'IF153890',verified:false}],reason:'NetSuite verification needs review.'};
  await page.coverage.startJSCoverage();page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:32189/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/api/')){
    if(route.request().method()!=='GET')posts.push(url.pathname);
    let value={};
    if(url.pathname==='/api/auth/me')value={operator:{id:'load-browser',display_name:'Load test',role:'operator',roles:['operator'],operatorYardLocationIds:[1]}};
    else if(url.pathname==='/api/delivery/current-draft')value=null;
    else if(url.pathname==='/api/delivery/notifications')value={total:0,items:[]};
    else if(url.pathname==='/api/delivery/orders')value=[current];
    else if(url.pathname===`/api/delivery/orders/${order.netsuite_id}`){if(detailError)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture detail unavailable'})});value=current;}
    else if(url.pathname==='/api/operator/netsuite-posting-policy')value={effective:true,gateKey:'fixture',revision:1};
    else if(url.pathname==='/api/delivery/consolidation-loads/batch-one')value={id:'batch-one',status:'draft',photoRefs:[],snapshot:{assignment:{planDate:'2026-09-17',truckPlate:'TEST',loadName:'1'},orders:[{...current,lines:current.lines.slice(0,3)}]},confirmationSummaries:[current.confirmationSummary]};
    else if(url.pathname.includes('photo'))value={required:false,requiredPhotoCount:0};
    else if(url.pathname.endsWith('/load')){if(mode==='lost-response'){current.posting={jobId:'job-one',status:'attention',loadBlocked:true,transactions:[{id:996410,ref:'IF153890',verified:false}],reason:'Needs review'};return route.abort('failed');}value=mode==='complete'?{status:'complete',result:{remainingLines:1,pickupStatus:'partial_loaded'}}:{status:'running',jobId:'job-one'};}
    else if(url.pathname==='/api/operator/netsuite-posting-jobs/completed-old')value={id:'completed-old',status:'completed',result:{localFinalization:{remainingLines:1}}};
    else if(url.pathname==='/api/operator/netsuite-posting-jobs/job-one')value=jobComplete?{id:'job-one',status:'completed',result:{localFinalization:{remainingLines:1,pickupStatus:'partial_loaded'}}}:mode==='failed'?{id:'job-one',status:'failed',lastError:'Fixture rejected quantity'}:{id:'job-one',status:'attention',steps:[{status:'uncertain',observedTransaction:{id:996410,tranId:'IF153890'}}]};
    else if(url.pathname.startsWith('/api/operator/netsuite-posting-jobs/'))return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Posting job not found'})});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
   }
   const file=url.pathname==='/operator'?'operator.html':url.pathname.slice(1);
   if(file.startsWith('vendor/'))return route.fulfill({contentType:'application/javascript',body:''});
   let body;try{body=readFileSync(path.join(root,file));}catch{body=readFileSync(path.join('public',file));}
   return route.fulfill({body,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}};localStorage.setItem('mbbs.staff.token','load-browser-token');localStorage.setItem('mbbs.operator.token','load-browser-token');localStorage.setItem('mbbs.operator.locationId','1');localStorage.setItem('mbbs.ui.language','en');});
  await page.goto('http://localhost:32189/operator');await page.waitForFunction(()=>typeof operator!=='undefined'&&operator);
  await page.evaluate(({order,mode})=>{selectedOrder=order;selectedId=order.netsuite_id;currentModule=mode==='delivery'?'delivery':'customer-pickup';viewMode='packed';render();},{order:current,mode});
  if(mode==='corrupt-journal')await page.evaluate(()=>localStorage.setItem('mbbs.operator.posting:load-browser:sales_order:995451','invalid-json'));
  if(mode==='blocked')await page.evaluate(()=>updatePageConfirmControls());
  if(mode==='remaining-only'){await expect(page.locator('.line-card')).toHaveCount(1);await expect(page.locator('[data-action="start-fulfill"]').first()).toBeDisabled();}
  else if(['all-confirmed','recovered-partial'].includes(mode)){
   if(mode==='recovered-partial')await page.evaluate(()=>localStorage.setItem('mbbs.operator.posting:load-browser:sales_order:995451',JSON.stringify({requestId:'completed-old',jobId:'completed-old',status:'posting',loadBlocked:true})));
   await page.locator('[data-action="start-fulfill"]').first().click();await expect(page.locator('[data-action="confirm-fulfill"]')).toBeVisible();await expect(page.locator('[data-load-partial-confirmation]')).toHaveCount(0);
   if(mode==='recovered-partial')assert.notEqual(await page.evaluate(()=>fulfillmentLoadRequestId),'completed-old');
  }else if(mode==='blocked'){
   await expect(page.locator('[data-action="start-fulfill"]').first()).toBeDisabled();
   await expect(page.locator('[data-load-posting-status]')).toContainText('IF153890');
   await page.screenshot({path:`${artifact}/browser-blocked.png`});
   await page.reload();await page.waitForFunction(()=>typeof operator!=='undefined'&&operator);
   await page.evaluate(order=>{selectedOrder=order;selectedId=order.netsuite_id;currentModule='customer-pickup';render();},current);
   await expect(page.locator('[data-action="start-fulfill"]').first()).toBeDisabled();
   await page.evaluate(()=>updatePageConfirmControls());
   await expect(page.locator('[data-action="start-fulfill"]').first()).toBeDisabled();
   await page.evaluate(()=>{selectedOrder={...selectedOrder,reload_authorized:true,reload_cycle:{status:'packed'}};currentModule='delivery';render();});
   await expect(page.locator('[data-action="start-fulfill"]')).toHaveCount(2);
   for(const button of await page.locator('[data-action="start-fulfill"]').all())await expect(button).toBeDisabled();
  }else if(mode==='consolidation'){
   await page.evaluate(order=>prepareConsolidationLoadProof({id:'batch-one',status:'draft',photoRefs:[],snapshot:{assignment:{planDate:'2026-09-17',truckPlate:'TEST',loadName:'1'},orders:[{...order,lines:order.lines.slice(0,3)}]},confirmationSummaries:[order.confirmationSummary]}),current);
   await page.evaluate(()=>{fulfillmentPhotoDataUrls=['data:image/jpeg;base64,cGhvdG8x','data:image/jpeg;base64,cGhvdG8y'];render();});
   await page.locator('[data-action="confirm-fulfill"]').click();
   await expect(page.locator('[data-load-partial-confirmation]')).toContainText('PALLET');
   await page.keyboard.press('Escape');await expect(page.locator('[data-load-partial-confirmation]')).toHaveCount(0);assert.ok(!posts.some(p=>p.endsWith('/submit')));
  }else{
   await page.locator('[data-action="start-fulfill"]').first().click();
   const dialog=page.locator('[data-load-partial-confirmation]');
   await expect(dialog).toBeVisible();await expect(dialog).toContainText('3 of 4 lines');await expect(dialog).toContainText('PALLET');
   if(mode==='pickup')await page.screenshot({path:`${artifact}/browser-partial.png`});
   await dialog.getByRole('button',{name:'Go back',exact:true}).click();
   assert.ok(!posts.some(p=>p.endsWith('/load')));
   await page.locator('[data-action="start-fulfill"]').first().click();await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
   await page.locator('[data-action="start-fulfill"]').first().click();
   await dialog.getByRole('button',{name:'Load confirmed lines',exact:true}).click();
   await expect(page.locator('[data-action="confirm-fulfill"]')).toBeVisible();
   if(['claim-race','confirmation-change','detail-error','refresh-empty'].includes(mode)){
    if(mode==='claim-race')current.posting={jobId:'job-one',status:'attention',loadBlocked:true,transactions:[{id:996410,ref:'IF153890',verified:false}],reason:'Other operator has submitted this load'};
    if(mode==='confirmation-change')current.confirmationSummary={...current.confirmationSummary,total:5,missing:[...current.confirmationSummary.missing,{id:'5',sku:'LATE-LINE'}]};
    if(mode==='detail-error')detailError=true;
    if(mode==='refresh-empty'){
     current={...current,lines:current.lines.map(line=>({...line,packed_sales_qty:0,loaded_qty:2})),confirmationSummary:{...current.confirmationSummary,total:0,confirmed:0,missing:[]}};
     await page.evaluate(()=>{rememberFulfillmentPosting({status:'submitting',loadBlocked:true});render();});
     await page.locator('[data-action="refresh-load-posting"]').click();await page.waitForFunction(()=>fulfillmentOrder===null);
    }else{
     await page.locator('[data-action="confirm-fulfill"]').click();
     if(mode==='claim-race')await expect(page.locator('[data-load-posting-status]')).toContainText('IF153890');
     if(mode==='confirmation-change'){await expect(dialog).toContainText('LATE-LINE');await dialog.getByRole('button',{name:'Go back',exact:true}).click();await page.waitForFunction(()=>fulfillmentSubmitting===false);}
     if(mode==='detail-error'){await page.waitForFunction(()=>fulfillmentSubmitting===false);await expect(page.locator('[data-action="confirm-fulfill"]')).toBeEnabled();}
    }
    assert.equal(posts.filter(p=>p.endsWith('/load')).length,0);
   }
   if(['attention','lost-response','complete','failed','refresh-complete'].includes(mode)){
    await page.evaluate(()=>{fulfillmentPhotoDataUrls=['data:image/jpeg;base64,cGhvdG8x','data:image/jpeg;base64,cGhvdG8y'];render();});
    await page.locator('[data-action="confirm-fulfill"]').click();
    if(mode==='complete')await expect(page.locator('.fulfillment-card.success')).toBeVisible();
    else if(mode==='failed'){await page.waitForFunction(()=>fulfillmentJobStage==='Load failed');await expect(page.locator('[data-action="confirm-fulfill"]')).toBeEnabled();await expect(page.locator('[data-load-posting-status]')).toHaveCount(0);}
    else{
     if(mode==='lost-response'){await expect(page.locator('[data-load-posting-status]')).toBeVisible();await page.locator('[data-action="refresh-load-posting"]').click();}
     await expect(page.locator('[data-load-posting-status]')).toContainText('IF153890');
     await expect(page.locator('[data-action="confirm-fulfill"]')).toBeDisabled();
     if(mode==='refresh-complete'){jobComplete=true;await page.locator('[data-action="refresh-load-posting"]').click();await expect(page.locator('.fulfillment-card.success')).toBeVisible();}
    }
    assert.equal(posts.filter(p=>p.endsWith('/load')).length,1);
    if(['complete','failed','refresh-complete'].includes(mode))assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.operator.posting:load-browser:sales_order:995451')),null);
   }
  }
  assert.deepEqual(errors,[]);coverage.push(...await page.coverage.stopJSCoverage());results.push({mode,errors,loadSubmissions:posts.filter(p=>p.endsWith('/load')).length});await page.close();
 }
 const sourceHashes=Object.fromEntries(['operator.js','operator.html','service-worker.js'].map(file=>['public/'+file,crypto.createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')]));
 writeFileSync(`${artifact}/browser.json`,JSON.stringify({results,sourceHashes},null,2));writeFileSync(`${artifact}/browser-coverage.json`,JSON.stringify(coverage));console.log(JSON.stringify(results));
}finally{await browser.close();}
