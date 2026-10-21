import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {parse} from 'espree';

const filename='public/operator.js';
const source=fs.readFileSync(filename,'utf8');
const tree=parse(source,{ecmaVersion:'latest',sourceType:'script',range:true});
let cursor=0,functions='';
for(const node of tree.body.filter(node=>node.type==='FunctionDeclaration')){
  functions+=source.slice(cursor,node.start).replace(/[^\n]/gu,' ')+source.slice(node.start,node.end);cursor=node.end;
}
functions+=source.slice(cursor).replace(/[^\n]/gu,' ');
const flush=async()=>{for(let index=0;index<20;index++){await Promise.resolve();}};
function harness(module='customer-pickup-load'){
  let now=120000,resolvePosting;
  const intervals=new Map(),storage=new Map(),calls=[],timer={textContent:''};
  const context=vm.createContext({console,Math,JSON,Promise,Map,Set,
    Date:class extends Date{static now(){return now;}},
    currentModule:module,locationId:1,operator:{id:'operator',display_name:'Operator'},
    selectedOrder:null,fulfillmentOrder:{netsuite_id:42,tranid:'SO42',order_type:'sales_order',lines:[{id:1}]},
    fulfillmentPhotoDataUrls:[],fulfillmentActivePhotoSlot:0,fulfillmentCameraActive:false,
    fulfillmentSubmitting:false,fulfillmentResult:null,fulfillmentJobStage:'',fulfillmentStatusText:'',
    fulfillmentStartedAt:0,fulfillmentProgressTimer:null,fulfillmentValidation:null,fulfillmentLoadRequestId:'request-42',
    fulfillmentNetSuitePolicy:{effective:true,functionKey:'customer_pickup',transactionType:'IF',gateKey:'pickup',revision:1},
    fulfillmentNetSuitePolicyError:'',operatorPhotoCamera:{},consolidationLoadState:{batch:null},
    app:{innerHTML:'',querySelector:()=>timer},
    window:{setInterval:callback=>{intervals.set(1,callback);return 1;},clearInterval:id=>intervals.delete(id),
      localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}}});
  vm.runInContext(functions,context,{filename});
  Object.assign(context,{
    shell:(_title,_subtitle,body,actions='')=>{context.app.innerHTML=body+actions;return context.app.innerHTML;},
    t:(_key,fallback)=>fallback,tf:(_key,fallback)=>fallback,localizeMessage:value=>value,
    escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    visibleLines:order=>order.lines,hasPackedQty:()=>true,currentLocation:()=>({text:'3445'}),
    customerPickupRequiredPhotoCount:()=>0,renderCameraSwitchButton:()=>'<button data-action="switch-fulfillment-camera">Switch</button>',
    cameraOpenLabel:()=>'Open camera',renderCompactLoadSummary:()=>'<div class="fulfillment-summary-card">SO42 · 26 PC</div>',
    renderLoadValidation:()=>'',stopFulfillmentCamera(){},refreshCustomerPickupPhotoRequirement:async()=>{},
    loadOperatorNetSuitePostingPolicy:async()=>context.fulfillmentNetSuitePolicy,
    prepareOperatorBackgroundPhotos:async()=>({backgroundPhotos:[]}),resumeOperatorBackgroundPhotos(){},showToast(){},
    api:async(url,options)=>{calls.push({url,method:options?.method});return {status:'running',jobId:'request-42'};},
    pollOperatorNetSuitePostingJob:async(_id,progress)=>{
      progress({stage:'Posting to NetSuite',message:'0/1 NetSuite transaction(s) verified. 8s'});
      return new Promise(resolve=>{resolvePosting=resolve;});
    },render:()=>context.renderFulfillmentScreen()});
  return {context,calls,storage,intervals,timer,advance:seconds=>{now+=seconds*1000;for(const tick of intervals.values()){tick();}},
    complete:()=>resolvePosting({pickupStatus:'loaded',remainingLines:0,operatorNetSuitePosting:{transactions:[]}})};
}

test('customer pickup keeps the truck-load form and one elapsed message while its IF is pending',async()=>{
  const h=harness();const done=h.context.confirmFulfillment();await flush();
  const html=h.context.app.innerHTML;
  assert.match(html,/fulfillment-load-screen/u);assert.match(html,/fulfillment-photo-card/u);
  assert.match(html,/SO42 · 26 PC/u);assert.match(html,/Loaded on truck/u);
  assert.doesNotMatch(html,/data-load-posting-status|transaction\(s\) verified|Verification pending/u);
  assert.equal((html.match(/data-fulfillment-upload-elapsed/gu)||[]).length,1);
  assert.match(html,/data-action="confirm-fulfill"[^>]*disabled/u);
  h.advance(12);assert.equal(h.timer.textContent,' (12s)');
  await h.context.confirmFulfillment();assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  h.complete();await done;
});
test('waiting pickup locks photo changes and retains the saved request through completion',async()=>{
  const h=harness();const done=h.context.confirmFulfillment();await flush();
  assert.match(h.context.app.innerHTML,/data-action="start-camera"[^>]*disabled/u);
  assert.match(h.context.app.innerHTML,/data-action="add-fulfillment-photo"[^>]*disabled/u);
  assert.match(h.context.app.innerHTML,/data-action="select-fulfillment-photo-slot"[^>]*disabled/u);
  assert.equal(h.context.fulfillmentLoadRequestId,'request-42');assert.equal(h.storage.size,1);
  h.complete();await done;
  assert.match(h.context.app.innerHTML,/Back to Scan/u);assert.equal(h.context.fulfillmentResult.pickupStatus,'loaded');
  assert.equal(h.storage.size,0);assert.equal(h.intervals.size,0);
});
test('pickup attention stays on the load page with the existing message and status-check action',()=>{
  const h=harness();h.context.fulfillmentOrder.posting={status:'attention',loadBlocked:true,reason:'Review this saved load'};
  h.context.fulfillmentStatusText='Review this saved load';h.context.fulfillmentStartedAt=100000;
  const html=h.context.renderFulfillmentScreen();
  assert.match(html,/fulfillment-load-screen/u);assert.match(html,/Review this saved load/u);
  assert.match(html,/data-action="refresh-load-posting"/u);assert.doesNotMatch(html,/data-load-posting-status/u);
  assert.match(html,/data-action="confirm-fulfill"[^>]*disabled/u);
});
test('ordinary delivery retains its existing held-load verification screen',()=>{
  const h=harness('delivery-fulfill');h.context.fulfillmentOrder.posting={status:'attention',loadBlocked:true};
  assert.match(h.context.renderFulfillmentScreen(),/data-load-posting-status/u);
  assert.doesNotMatch(h.context.app.innerHTML,/fulfillment-load-screen/u);
});
test('idle customer pickup has its normal controls and no waiting timer',()=>{
  const h=harness();const html=h.context.renderFulfillmentScreen();
  assert.match(html,/data-action="confirm-fulfill"\s*type/u);
  assert.doesNotMatch(html,/data-fulfillment-upload-elapsed/u);
});
