import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';

const source=readFileSync('public/operator.js','utf8');
const functions=source.slice(source.indexOf('async function confirmFulfillment('),source.indexOf('async function pollFulfillmentJob('));
const polling=source.slice(source.indexOf('async function pollOperatorNetSuitePostingJob('),source.indexOf('async function editReloadPacking('));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
const failed={status:'error',error:'NetSuite rejected the transfer line',posting:{id:'failed-request',status:'failed',steps:[]}};
try{
for(const mode of ['immediate-failed','polled-failed','uncertain','reopened-failed','local-loaded']){
 const page=await browser.newPage();const requests=[];
 await page.route('https://to-line.test/**',async route=>{
  const request=route.request();
  if(request.url().endsWith('/'))return route.fulfill({contentType:'text/html',body:'<main id="result"></main>'});
  if(request.method()==='POST')requests.push(request.postDataJSON());
  if(mode==='local-loaded')return route.fulfill({json:{localYardOrderStatus:'Loaded'}});
  const payload=request.method()==='GET'?{...failed.posting,lastError:failed.error}:
    mode==='polled-failed'?{status:'running',jobId:'failed-request'}:
    mode==='uncertain'?{status:'running',jobId:'pending-request'}:failed;
  if(mode==='uncertain'&&request.method()==='GET')return route.abort('failed');
  await route.fulfill({json:payload});
 });
 await page.goto('https://to-line.test/');
 await page.evaluate(()=>{
  Object.assign(window,{fulfillmentOrder:{netsuite_id:1036611,order_type:'transfer_order'},fulfillmentSubmitting:false,
    fulfillmentPhotoDataUrls:['r2://fixture/a','r2://fixture/b'],fulfillmentNetSuitePolicy:{effective:true,gateKey:'test',revision:4},
    currentModule:'delivery',fulfillmentLoadRequestId:'failed-request',locationId:1,deliveryOrderType:'transfer_order',fulfillmentProgressTimer:null,
    operator:{id:'fixture'},operatorPostingPollWakeups:new Map(),__renders:[],__toasts:[],
    render:()=>{window.__renders.push({submitting:window.fulfillmentSubmitting,stage:window.fulfillmentJobStage,blocked:window.fulfillmentOrder?.posting?.loadBlocked});},
    showToast:message=>window.__toasts.push(message),operatorNetSuitePostingIsLocalOnly:()=>false,fulfillmentRequiredPhotoCount:()=>2,
    loadOperatorNetSuitePostingPolicy:async()=>({effective:true,gateKey:'test',revision:4}),operatorNetSuitePolicyToken:x=>x,
    stopFulfillmentCamera:()=>{},prepareOperatorBackgroundPhotos:async()=>({photoDataUrls:['r2://fixture/a','r2://fixture/b']}),resumeOperatorBackgroundPhotos:()=>{},
    createOperatorUuid:()=>crypto.randomUUID(),t:(_key,fallback)=>fallback,
    api:async(path,options={})=>{const response=await fetch(path,{...options,headers:{'Content-Type':'application/json'}});return response.json();}});
 });
 await page.addScriptTag({content:polling+'\n'+functions});
 if(mode==='local-loaded'){
  await page.addScriptTag({content:source.slice(source.indexOf('function operatorNetSuitePostingIsLocalOnly('),source.indexOf('async function loadOperatorNetSuitePostingPolicy('))});
  await page.evaluate(()=>{window.loadOperatorNetSuitePostingPolicy=async()=>{throw new Error('NetSuite unavailable');};});
 }
 try{
  if(mode==='reopened-failed')await page.evaluate(async()=>{
    localStorage.setItem(loadPostingJournalKey(fulfillmentOrder),JSON.stringify({requestId:'failed-request',status:'submitting',loadBlocked:true}));
    await resumePreviousLoadJournal(fulfillmentOrder);
  });else await page.evaluate(()=>confirmFulfillment());
  const state=await page.evaluate(()=>({submitting:fulfillmentSubmitting,stage:window.fulfillmentJobStage,
    blocked:!!fulfillmentOrder.posting?.loadBlocked,requestId:fulfillmentLoadRequestId,journal:loadPostingJournal(fulfillmentOrder),toasts:window.__toasts}));
  assert.equal(state.submitting,false,'A settled failure must stop Saving');
  if(mode==='local-loaded'){
    assert.equal(state.blocked,false);assert.equal(state.journal,null);assert.equal(requests.length,1);
    assert.ok(state.toasts.includes('Order loaded locally'));
    assert.equal(await page.evaluate(()=>fulfillmentResult.localYardOrderStatus),'Loaded');
    assert.equal(requests[0].netSuitePostingPolicy,null);
  }else if(mode==='uncertain'){
    assert.equal(state.blocked,true);assert.equal(state.requestId,'failed-request');assert.ok(state.journal);
    await page.evaluate(()=>confirmFulfillment());assert.equal(requests.length,1,'Unknown outcome must not create another request');
  }else{
    assert.equal(state.blocked,false,'A definitive failed attempt must not remain Verification pending');
    assert.equal(state.journal,null,'A definitive failed attempt must clear the pending journal');
    if(mode!=='reopened-failed'){
      assert.equal(state.stage,'Load failed');assert.notEqual(state.requestId,'failed-request','Retry requires a fresh request ID');
      await page.evaluate(()=>confirmFulfillment());
      assert.equal(requests.length,2);assert.notEqual(requests[1].requestId,requests[0].requestId);
    }
  }
  results.push({mode,passed:true,state,requests:requests.map(r=>r.requestId)});
 }catch(error){results.push({mode,passed:false,error:error.message,state:await page.evaluate(()=>({submitting:fulfillmentSubmitting,stage:window.fulfillmentJobStage,blocked:!!fulfillmentOrder.posting?.loadBlocked,requestId:fulfillmentLoadRequestId}))});}
 await page.close();
}
}finally{await browser.close();}
writeFileSync('test-artifacts/to-line-reference-20261003/browser.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
assert.ok(results.every(r=>r.passed),'Stale failed-attempt browser reproduction failed its expected behavior');
