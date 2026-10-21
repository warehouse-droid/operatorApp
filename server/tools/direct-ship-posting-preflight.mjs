import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {createDirectPoSourceFetcher} from './src/direct-po-auto-receipt.js';
import {buildDirectPoReceiptDraft} from './src/direct-po-auto-receipt-domain.js';
import {fetchSalesOrderFulfillmentStateFromNetSuite} from './src/netsuite.js';
import {getOperatorNetSuitePostingPolicy} from './src/operator-netsuite-posting-policy-repository.js';
import {isCompletedNetSuitePostingOrder} from './src/netsuite-fulfillable-items.js';
const receiptSources=createDirectPoSourceFetcher();
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const receipts=[];
  for(const id of [1009063,1025437]){
   const order=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[id])).rows[0];
   const event=(await query("SELECT * FROM dispatch_effective_order_completion_events WHERE order_kind='PO' AND metadata->>'poOrderId'=$1 AND metadata->>'directShipCoverageVerified'='true' ORDER BY id DESC LIMIT 1",[String(id)])).rows[0];
   assert.ok(order&&event,'PO must have an effective verified completion');
   const lines=(await query('SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1 AND COALESCE(netsuite_active,true) AND quantity>0',[id])).rows;
   const source=await receiptSources({sourceOrderKind:'PO',sourceNetSuiteId:id});
   if(isCompletedNetSuitePostingOrder('PO',source)){receipts.push({id,skip:'live_order_complete'});continue;}
   const policy=await getOperatorNetSuitePostingPolicy({functionKey:'receiving',locationId:Number(order.destination_location_id)});
   const draft=buildDirectPoReceiptDraft({requestId:'27182026-1001-4000-8000-000000000001',order,lines,source,policy,
    evidence:{completionEventId:Number(event.id),sourcePoId:id,pickupJobIds:['read-only-preflight'],deliveryJobId:event.completion_evidence_id},photoRefs:[]});
   assert.equal(draft.steps.length,1);
   receipts.push({id,ref:order.tranid,dispatchRef:order.dispatch_ref,payload:draft.steps[0].payload,sourceLines:source.lines});
  }
  const fulfillments=[];
  for(const id of [1008824,1008937]){
   const source=await fetchSalesOrderFulfillmentStateFromNetSuite(id);assert.ok(source);
   fulfillments.push(source);
  }
  return {passed:true,readOnly:true,checkedAt:new Date().toISOString(),receipts,fulfillments};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
