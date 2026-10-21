import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('public/regular-stock-delivery.js','utf8');
function browser(){
 const window={RegularStockUI:{t:en=>en,esc:String,number:String}};
 vm.runInNewContext(source,{window});return window.RegularStockDelivery;
}
test('failed composer exposes an explicit retry without requiring input changes',()=>{
 assert.match(browser().composer({salesOrderRef:'SOB121732',deliveryError:'Request failed (524)'},[],false),/data-sales-stock-action="delivery-preview-retry"/);
});
test('Sales retry uses Delivery action and print agent state is rendered truthfully',()=>{
 const api=browser(),request={regular:{deliveryVersion:1,deliveryApproval:'approved',handoffStatus:'attention'},transfers:[]};
 assert.match(api.progress(request),/data-sales-stock-action="delivery-retry"/);
 request.regular.handoffStatus='complete';request.transfers=[{printJobId:1,printStatus:'printing'}];
 assert.match(api.progress(request),/Printing TO/);assert.doesNotMatch(api.progress(request),/>Printed</);
});

// External boundaries are replaced; production progress and TO orchestration run.
import fc from 'fast-check';
import {withDeliveryProgress,deliveryProgress} from '../../../src/regular-stock-delivery-progress.js';
import {confirmStockTransferWorkflow} from '../../../src/stock-request-service.js';
const transfer={id:42,sourceLocationId:1,destinationLocationId:28,palletQuantity:1,palletItemId:999,lines:[{itemId:10,salesQty:5}]};
const locations={source:{netsuiteLocationId:1,subsidiaryId:2},destination:{netsuiteLocationId:28,subsidiaryId:2},intercompany:false};
test('property: concurrent progress contexts never report another operation stage',async()=>{
 await fc.assert(fc.asyncProperty(fc.array(fc.array(fc.string({minLength:1,maxLength:20}),{minLength:1,maxLength:8}),{minLength:2,maxLength:8}),async groups=>{
  const reports=groups.map(()=>[]);
  await Promise.all(groups.map((phases,i)=>withDeliveryProgress(async phase=>{reports[i].push(phase);},async()=>{
   for(const phase of phases){await Promise.resolve();await deliveryProgress(phase);}
  })));
  assert.deepEqual(reports,groups);
 }),{numRuns:40,seed:34452967});
});
test('property: real TO workflow reports each external stage before its side effect and stops at failure',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:0,max:5}),async failure=>{
  const phases=[],effects=[];
  const stages=['checking_to','creating_to','approving_to','preparing_print','queueing_print'];
  function effect(stage){assert.equal(phases.at(-1),stage);effects.push(stage);if(effects.length===failure)throw Error('external boundary failure');}
  const dependencies={ensurePrinter:async()=>effect('checking_to'),resolveLocations:async()=>locations,findRemoteByMarker:async()=>[],recoveryAttempts:1,recoveryDelayMs:0,
   createRemote:async()=>{effect('creating_to');return {id:9};},recordRemote:async()=>{},approveRemote:async()=>effect('approving_to'),
   hydrateRemote:async()=>({tranid:'TO9',pendingFulfillment:true}),recordApproved:async()=>{},
   fetchTicket:async()=>{effect('preparing_print');return {};},claimPrint:async()=>({generation:1}),queuePrint:async()=>{effect('queueing_print');return {id:7,status:'queued'};},complete:async()=>{},fail:async()=>{}};
  const work=()=>withDeliveryProgress(async phase=>{phases.push(phase);},()=>confirmStockTransferWorkflow({transfer,requestId:'same-command'},dependencies));
  if(failure)await assert.rejects(work,/external boundary failure/);else {const result=await work();assert.equal(result.printJob.status,'queued');}
  assert.deepEqual(effects,stages.slice(0,failure||stages.length));assert.deepEqual(phases,effects);
 }),{numRuns:30,seed:29673445});
});

test('recovery storage is isolated between staff accounts sharing a browser tab',async()=>{
 const command={operationId:'a36684cb-de70-404c-ae7b-700587e6b0ef',action:'retry',input:{},requestId:8};
 const key='mbbs.regularDelivery.operation.sales.actor-a',stored=new Map([[key,JSON.stringify({command,signature:JSON.stringify({action:'retry',input:{},requestId:8})})]]);
 const window={RegularStockUI:{t:en=>en},sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},
  setTimeout,clearTimeout,RegularStockDialog:{begin:()=>({wait(){},close(){}})}};
 vm.runInNewContext(source,{window,AbortController,crypto:{randomUUID:()=>assert.fail('Must reuse the saved ID')}});
 const api=window.RegularStockDelivery;api.configure('actor-b');
 assert.equal(await api.resume(async()=>({operation:null}),'sales'),null);assert.equal(stored.has(key),true);
 api.configure('actor-a');
 const result=await api.resume(async(url,options)=>{
  if(url.endsWith('/active'))return {operation:null};
  assert.deepEqual(JSON.parse(options.body),command);return {status:'succeeded',result:{id:8}};
 },'sales');
 assert.equal(result.id,8);assert.equal(stored.size,0);
});
