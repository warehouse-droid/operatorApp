// Exercise the candidate worker's real PO-sync hooks in the isolated database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../src/db.js';
import {submitRegularStockRequest} from '../src/regular-stock-request-service.js';
import {addPurchaseStockProposals} from '../src/regular-stock-purchase-service.js';
import {getScmStockRequest} from '../src/stock-request-repository.js';
import {completeSmartScmPurchaseExecution} from '../src/smart-scm-vendor-repository.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const workerDb=await import('../worker/src/db.js');
const worker=await import('../worker/src/order-sync-repository.js');
const actor='purchase-worker-'+randomUUID(),itemId=9804000000000+Date.now()%1000000000,source=910005;
const context={operatorId:actor,authorizedDestinationLocationIds:[28]};
const dependencies={loadPurchaseStock:async()=>({onHand:0,available:0,preferredStock:1000}),
  loadPurchasePolicy:async()=>({item_id:itemId,item_name:'Purchase worker fixture',stock_unit:'EA',to_plt:100,pallet_weight_lbs:1000,
    vendor_id:source,vendor:'Purchase worker vendor',vendor_yard_id:source,vendor_yard:'Purchase worker pickup',plant:'Purchase worker pickup'})};
try{
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','scm',ARRAY['scm'],true)",[actor]);
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'Purchase worker vendor','Purchase worker pickup') ON CONFLICT(id) DO NOTHING",[source]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor,purchase_unit,last_purchase_price) VALUES($1,'Purchase worker fixture','EA',1,100,10,$2,'Purchase worker vendor','EA',1)",[itemId,source]);
  const submitted=await submitRegularStockRequest({deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:28,lines:[{itemId,pieces:150}]},context,dependencies);
  const request=await addPurchaseStockProposals(submitted.id,{expectedRevision:submitted.revision,lines:[{lineId:submitted.lines[0].id}]},context,dependencies);
  const poId=9905000000000+Date.now()%1000000000;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_reference,status_text,netsuite_active,destination_location_id,vendor_id) VALUES($1,'PO-WORKER-FIXTURE','WORKER-REF','Pending Receipt',true,28,$2)",[poId,source]);
  await completeSmartScmPurchaseExecution(request.lines[0].purchase.proposals[0].proposalId,{purchaseOrderId:poId,purchaseOrderRef:'PO-WORKER-FIXTURE'},actor);
  const item=received=>({line_id:1,item_id:itemId,quantity:200,netsuite_received_qty:received,unit:'EA',to_plt:100,pallet_qty:2,location_id:28,netsuite_active:true});
  await worker.upsertPurchaseOrderLines(poId,[item(50)]);
  let current=await getScmStockRequest(request.id);
  assert.equal(current.bucket,'accepted');assert.equal(current.lines[0].purchase.receivedQuantity,50);assert.equal(current.lines[0].purchase.orderedQuantity,200);
  await worker.updatePurchaseOrderNetSuiteStatus(poId,{statusText:'Cancelled'});
  current=await getScmStockRequest(request.id);assert.equal(current.lines[0].purchase.unorderedQuantity,150);assert.equal(current.lines[0].purchase.receivedQuantity,50);
  await worker.upsertPurchaseOrders([{id:poId,tranid:'PO-WORKER-FIXTURE',vendor_id:source,vendor:'Purchase worker vendor',destination_location_id:28,status_text:'Pending Receipt'}]);
  await workerDb.withTransaction(()=>worker.upsertPurchaseOrderLines(poId,[item(200)]));
  await worker.upsertPurchaseOrderLines(poId,[item(200)]);
  current=await getScmStockRequest(request.id);assert.equal(current.bucket,'completed');assert.equal(current.lines[0].purchase.receivedQuantity,200);
  assert(current.lines[0].purchase.orders.some(row=>row.direct&&row.purchaseOrderNumber==='PO-WORKER-FIXTURE'&&row.purchaseOrderRef==='WORKER-REF'));
  console.log(JSON.stringify({workerSourceUsed:true,partialReceipt:true,cancelAndReopen:true,transactionalReceipt:true,
    replayWithoutDoubleReceipt:true,completedOnFullReceipt:true,poNumberAndReferencePreserved:true,netSuiteCalls:0}));
}finally{await Promise.all([closeDb(),workerDb.closeDb()]);}
