import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {parse} from 'espree';

const source=fs.readFileSync(process.env.OPERATOR_REVIEW_SOURCE||'public/operator.js','utf8');
const tree=parse(source,{ecmaVersion:'latest',range:true});
const functions=tree.body.filter(n=>n.type==='FunctionDeclaration').map(n=>source.slice(n.start,n.end)).join('\n');
const click=tree.body.find(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'&&n.expression.callee.object?.name==='app'&&n.expression.callee.property?.name==='addEventListener'&&n.expression.arguments[0]?.value==='click');

function harness(kind='pickup') {
  const store=new Map(), calls=[], timers=[];
  const order={netsuite_id:7,tranid:'ORDER7',order_type:kind==='delivery'?'transfer_order':'sales_order',lines:[]};
  const context=vm.createContext({console,Date,Set,Map,JSON,Math,Promise,
    operator:{id:'actor'},locationId:1,currentModule:kind==='receipt'?'receiving-receipt':kind==='pickup'?'customer-pickup-load':'delivery-fulfill',
    fulfillmentOrder:order,selectedOrder:order,selectedId:7,selectedLineId:null,receiptOrder:{...order,order_type:'purchase_order'},
    fulfillmentSubmitting:false,receiptSubmitting:false,fulfillmentResult:null,receiptResult:null,
    fulfillmentLoadRequestId:'request-7',receiptRequestId:'receipt-7',
    fulfillmentPhotoDataUrls:['photo1','photo2'],receiptPhotoDataUrls:['photo1','photo2'],
    fulfillmentProgressTimer:41,receiptProgressTimer:42,fulfillmentReturnModule:'delivery',
    fulfillmentNetSuitePolicy:{effective:true},receiptNetSuitePolicy:{effective:true},fulfillmentNetSuitePolicyError:'',receiptNetSuitePolicyError:'',
    fulfillmentJobStage:'',fulfillmentStatusText:'',receiptJobStage:'',receiptStatusText:'',fulfillmentValidation:null,
    fulfillmentActivePhotoSlot:0,receiptActivePhotoSlot:0,fulfillmentCameraActive:false,receiptCameraActive:false,
    receiptStartedAt:0,fulfillmentStartedAt:0,receivingOrderType:'purchase_order',deliveryOrderType:'transfer_order',receivingSelectedSourceId:null,
    receivingSelectedId:7,receivingSelectedOrder:order,receivingSelectedLineId:null,receivingStep:'orders',
    customerPickupScan:'ORDER7',operatorPhotoCamera:{},
    window:{localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
      clearInterval:id=>timers.push(id),setInterval:()=>43},
    app:{addEventListener:(_event,handler)=>{context.clickHandler=handler;}},
    document:{querySelector:()=>null},setTimeout,clearTimeout
  });
  vm.runInContext(functions+'\n'+source.slice(click.start,click.end),context);
  Object.assign(context,{render:()=>calls.push('render'),showToast:m=>calls.push(m),saveOperatorState:()=>calls.push('save'),
    stopFulfillmentCamera(){},stopReceiptCamera(){},invalidateReceivingRequests(){},
    loadReceivingOrders:async()=>calls.push('receive-list'),loadOrders:async()=>calls.push('delivery-list'),
    api:async()=>{throw new Error('Unexpected API request');},
    t:(_key,fallback)=>fallback,tf:(_key,fallback)=>fallback,escapeHtml:x=>String(x||''),localizeMessage:x=>x,
    shell:(_title,_subtitle,body,actions)=>body+(actions||''),visibleLines:()=>[],hasPackedQty:()=>false,
    customerPickupRequiredPhotoCount:()=>0,fulfillmentRequiredPhotoCount:()=>2,fulfillmentPhotoSlotFloor:()=>2,
    operatorNetSuitePostingIsLocalOnly:()=>false,currentLocation:()=>({text:'3445'}),renderCameraSwitchButton:()=>'',
    renderCompactLoadSummary:()=>'',cameraOpenLabel:()=>'',renderLoadValidation:()=>'',
    refreshCustomerPickupPhotoRequirement:async()=>{},loadOperatorNetSuitePostingPolicy:async()=>({effective:true}),
    prepareOperatorBackgroundPhotos:async()=>({backgroundPhotos:[{id:'p1'},{id:'p2'}]}),resumeOperatorBackgroundPhotos(){},
    createOperatorUuid:()=> 'new-request',confirmMissingReceivingLines:async()=>true
  });
  return {context,store,calls,timers,async click(){await context.clickHandler({target:{closest:selector=>selector==='button'?{dataset:{action:'continue-operator-work'}}:null}});}};
}

for(const kind of ['pickup','delivery','receipt']) test(`${kind}: review can continue with another order without losing the held job`,async()=>{
  const h=harness(kind), c=h.context;
  if(kind==='receipt') c.rememberReceiptPosting({jobId:'receipt-7',status:'attention',receiveBlocked:true,transactions:[{id:9,ref:'IR9'}]});
  else c.rememberFulfillmentPosting({jobId:'request-7',status:'attention',loadBlocked:true,transactions:[{id:9,ref:'IF9'}]});
  const before=new Map(h.store);
  const html=kind==='receipt'?c.renderReceiptScreen():c.renderFulfillmentScreen();
  assert.match(html,/data-action="continue-operator-work"/);
  assert.match(html,/other orders/i);
  assert.doesNotMatch(html,/data-action="confirm-(?:fulfill|receive)"/);
  assert.doesNotMatch(html,/data-action="start-(?:receipt-)?camera"/);
  await h.click();
  assert.equal(c.currentModule,kind==='pickup'?'customer-pickup-scan':kind==='receipt'?'receiving':'delivery');
  assert.equal(c.fulfillmentSubmitting,false);assert.equal(c.receiptSubmitting,false);
  assert.deepEqual(h.store,before);
  if(kind==='receipt') {assert.equal(c.receiptOrder,null);assert.equal(c.receivingSelectedId,null);}
  else {assert.equal(c.fulfillmentOrder,null);assert.equal(c.selectedId,null);}
});

test('a failed load rotates confirmation identity before retaking photos',async()=>{
  const h=harness(),c=h.context;
  c.api=async()=>({status:'running',jobId:'request-7'});
  c.pollOperatorNetSuitePostingJob=async()=>{throw Object.assign(new Error('Rejected'),{payload:{posting:{id:'request-7',status:'failed'}}});};
  await c.confirmFulfillment();
  assert.equal(c.fulfillmentLoadRequestId,'new-request');assert.equal(c.fulfillmentSubmitting,false);
});
test('a failed receipt rotates identity after releasing the screen busy state',async()=>{
  const h=harness('receipt'),c=h.context;
  c.api=async()=>({status:'running',posting:true,jobId:'receipt-7'});
  c.pollOperatorNetSuitePostingJob=async()=>{throw Object.assign(new Error('Rejected'),{payload:{posting:{id:'receipt-7',functionKey:'receiving',status:'failed',steps:[]}}});};
  await c.confirmReceipt();
  assert.equal(c.receiptRequestId,'new-request');assert.equal(c.receiptSubmitting,false);
});
test('attention retains confirmation identity and holds the order',async()=>{
  const h=harness(),c=h.context;
  c.api=async()=>({status:'running',jobId:'request-7'});
  c.pollOperatorNetSuitePostingJob=async()=>{throw Object.assign(new Error('Review'),{payload:{posting:{id:'request-7',status:'attention',steps:[]}}});};
  await c.confirmFulfillment();
  assert.equal(c.fulfillmentLoadRequestId,'request-7');assert.equal(c.fulfillmentOrder.posting.loadBlocked,true);
});
test('late load completion cannot overwrite another order after leaving review screen',async()=>{
  const h=harness(),c=h.context;
  let resolvePost;
  c.api=async()=>new Promise(resolve=>{resolvePost=resolve;});
  const pending=c.confirmFulfillment();
  for(let i=0;i<20&&!resolvePost;i++) await Promise.resolve();
  assert(resolvePost);
  await h.click();
  assert.equal(c.fulfillmentSubmitting,false);
  c.fulfillmentOrder={netsuite_id:8,tranid:'ORDER8'};c.fulfillmentLoadRequestId='request-8';
  c.fulfillmentSubmitting=true;c.fulfillmentResult={newer:true};c.fulfillmentProgressTimer=99;
  resolvePost({status:'complete',result:{old:true}});await pending;
  assert.deepEqual(c.fulfillmentResult,{newer:true});assert.equal(c.fulfillmentSubmitting,true);
  assert.equal(c.fulfillmentProgressTimer,99);assert.equal(c.fulfillmentOrder.netsuite_id,8);
});
test('late status refresh cannot reopen a reviewed order over a newer selection',async()=>{
  const h=harness(),c=h.context;
  let resolveRead;
  c.api=async()=>new Promise(resolve=>{resolveRead=resolve;});
  const pending=c.refreshLoadPostingStatus();
  await h.click();
  c.fulfillmentOrder={netsuite_id:8,tranid:'ORDER8'};c.fulfillmentLoadRequestId='request-8';
  resolveRead({netsuite_id:7,tranid:'ORDER7',posting:{loadBlocked:true}});
  await pending;
  assert.equal(c.fulfillmentOrder.netsuite_id,8);assert.equal(c.fulfillmentLoadRequestId,'request-8');
});
