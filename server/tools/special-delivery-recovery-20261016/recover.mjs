import assert from 'node:assert/strict';
import {closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {updateSpecialFulfillment} from './src/special-stock-fulfillment.js';
import {reviewSpecialClosure} from './src/special-stock-closure-service.js';
import {prepareSpecialClosurePlanInNetSuite,prepareSpecialFulfillmentInNetSuite,suiteqlAll} from './src/netsuite.js';
import {readSpecialClosedOrders} from './src/special-stock-closed-orders.js';
const apply=process.argv.includes('--apply');
const reviewId='36c0258f-c74a-4612-a8b0-ffb108d463b0',changeId='71f05e95-1a39-4f93-a505-1f38e757e920';
const nativeFetch=globalThis.fetch;
let recordWrites=0;
globalThis.fetch=async(url,options)=>{
 if(String(url).includes('/record/v1/') && options?.method && options.method!=='GET') {
  assert.equal(apply,true,'Read-only preflight cannot write to NetSuite');
  assert.match(String(url),/\/record\/v1\/(?:salesOrder\/1052059|purchaseOrder\/1055764)(?:\?|$)/);
  assert.equal(options.method,'PATCH');
  const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['item']);
  for(const line of body.item.items){assert.deepEqual(Object.keys(line).sort(),['isClosed','line']);assert.equal(line.isClosed,true);}
  recordWrites++;
 }
 return nativeFetch(url,options);
};
try {
 const delivery=await getSpecialStockCase(162,{audience:'scm'}),closure=await getSpecialStockCase(90,{audience:'scm'});
 assert.equal(delivery.requestRef,'SPREQ-000063');assert.equal(closure.requestRef,'SPREQ-000021');
 assert.equal(closure.salesOrderId,1052059);assert.equal(closure.purchaseOrderId,1055764);
 assert.equal(closure.closureReview.id,reviewId);
 console.log(JSON.stringify({event:'before',at:new Date().toISOString(),delivery:{revision:delivery.revision,method:delivery.fulfillmentMethod,journal:delivery.fulfillmentChange},closure:{revision:closure.revision,closeStatus:closure.closeStatus,review:closure.closureReview,readinessAlerts:closure.readinessAlerts}}));
 if(delivery.fulfillmentChange?.id===changeId && !delivery.fulfillmentChange.hasPlan && ['attention','failed'].includes(delivery.fulfillmentChange.status)) {
  const plan=await prepareSpecialFulfillmentInNetSuite({salesOrderId:delivery.salesOrderId,...delivery.fulfillmentChange.target});
  console.log(JSON.stringify({event:'delivery-preflight',passed:true,materialLines:plan.before.commercial.lines.length,headerDiscount:plan.before.commercial.header.discountItem}));
 }
 const plan=await prepareSpecialClosurePlanInNetSuite({orders:[{id:closure.salesOrderId,kind:'sales_order'},{id:closure.purchaseOrderId,kind:'purchase_order'}],closeRemaining:true});
 console.log(JSON.stringify({event:'closure-preflight',plan}));
 if(!apply) {
  console.log(JSON.stringify({event:'result',preflight:true,recordWrites}));
 } else {
  if(delivery.fulfillmentChange?.id===changeId && !delivery.fulfillmentChange.hasPlan && ['applying','attention','failed'].includes(delivery.fulfillmentChange.status)) {
   const result=await updateSpecialFulfillment(delivery.id,{expectedRevision:delivery.revision,changeId,action:'discard'},
    {operatorId:null,authorizedStoreLocationIds:[delivery.storeLocationId]});
   assert.equal(result.fulfillmentChange.status,'cancelled');assert.equal(result.fulfillmentMethod,delivery.fulfillmentMethod);
   console.log(JSON.stringify({event:'delivery-recovered',requestRef:result.requestRef,revision:result.revision,status:result.fulfillmentChange.status,headerPreserved:true}));
  }
  const result=await reviewSpecialClosure(closure.id,{expectedRevision:closure.revision,reviewId,decision:'approve'},{operatorId:null});
  assert.equal(result.closeStatus,'closed');assert.equal(result.closureReview.status,'approved');assert.deepEqual(result.readinessAlerts,[]);
  const remote=await readSpecialClosedOrders(result,{queryAll:suiteqlAll});assert.ok(remote,'Both linked NetSuite orders must be verified closed');
  const posted=[];
  for(const order of plan.orders){
   const rows=await suiteqlAll(`SELECT tl.uniquekey,ABS(NVL(tl.quantityshiprecv,0)) AS executed,ABS(NVL(tl.quantitybilled,0)) AS billed FROM transactionline tl WHERE tl.transaction=${order.id} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`);
   for(const line of order.lines){const row=rows.find(r=>Number(r.uniquekey)===line.remoteLineId);assert.ok(row);assert.equal(Number(row.executed),line.executedQuantity);assert.equal(Number(row.billed),line.billedQuantity);}
   posted.push({id:order.id,lines:rows.length,postedQuantitiesPreserved:true});
  }
  console.log(JSON.stringify({event:'posted-history-verification',posted}));
  console.log(JSON.stringify({event:'result',closed:true,requestRef:result.requestRef,revision:result.revision,readinessAlerts:result.readinessAlerts,remote,recordWrites,delivery:(await getSpecialStockCase(162,{audience:'scm'})).fulfillmentChange}));
 }
} finally {globalThis.fetch=nativeFetch;await closeDb();}
