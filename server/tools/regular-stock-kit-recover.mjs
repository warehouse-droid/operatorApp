// User-authorized SOB121863 recovery through the application's durable operation queue.
import assert from 'node:assert/strict';
import {query,closeDb} from '../src/db.js';
import {enqueueDeliveryOperation,runDeliveryOperation,getDeliveryOperation} from '../src/regular-stock-delivery-operations.js';
import {recordStockRequestEvent} from '../src/stock-request-repository.js';
import {suiteqlAll} from '../src/netsuite.js';
import {withOperatorNetSuitePriority} from '../src/operator-netsuite-request-pool.js';

const operationId=process.argv[2];
assert.match(operationId,/^[0-9a-f-]{36}$/);
try{
 const admin=(await query("SELECT id FROM operators WHERE username='admin' AND role='admin' AND active")).rows[0];
 assert(admin,'Active application maintenance account is required');
 const context={operatorId:admin.id,audience:'sales',authorizedDestinationLocationIds:[1,28,15,26]};
 const existing=(await query("SELECT request_id FROM regular_stock_handoffs WHERE sales_order_ref='SOB121863'")).rows[0];
 const command=existing
  ? {operationId,action:'retry',requestId:Number(existing.request_id),input:{}}
  : {operationId,action:'submit',input:{salesOrderRef:'SOB121863',sourceLocationId:1,destinationLocationId:28,deliveryMethod:'delivery'}};
 let operation=await enqueueDeliveryOperation(command,context);
 await runDeliveryOperation(operation.id);
 operation=await getDeliveryOperation(operation.id,context);
 const request=operation.result;
 const saved=(await query(`SELECT r.id,r.request_ref,h.status,h.error,t.id AS transfer_id,t.transfer_ref,
  t.netsuite_transfer_order_id,t.netsuite_transfer_order_ref,t.confirmation_status,t.confirmation_error,
  t.source_location_id,t.destination_location_id
  FROM regular_stock_handoffs h JOIN sales_stock_requests r ON r.id=h.request_id
  LEFT JOIN sales_stock_transfers t ON t.request_id=r.id WHERE h.sales_order_ref='SOB121863' ORDER BY t.id`)).rows;
 const verification=[];
 await withOperatorNetSuitePriority(async()=>{
  for(const transfer of saved.filter(row=>row.netsuite_transfer_order_id)){
   const remote=await suiteqlAll(`SELECT t.id,t.tranid,t.type,t.status,t.externalid,t.memo FROM transaction t
    WHERE t.type='TrnfrOrd' AND t.id=${Number(transfer.netsuite_transfer_order_id)}`);
   assert.equal(remote.length,1,'Created transfer must exist in NetSuite');
   assert.equal(remote[0].tranid,transfer.netsuite_transfer_order_ref);
   assert.equal(String(remote[0].externalid).toUpperCase(),`MBBS_REGULAR_STOCK_${transfer.id}_${transfer.transfer_id}`);
   assert.equal(remote[0].memo,'SOB121863');
   verification.push(remote[0]);
  }
 });
 if(request?.id){
  const audit=(await query("SELECT 1 FROM sales_stock_request_events WHERE request_id=$1 AND event_type='support_recovery' AND details->>'operationId'=$2",[request.id,operationId])).rowCount;
  if(!audit)await recordStockRequestEvent({requestId:request.id,eventType:'support_recovery',actorId:admin.id,
   details:{operationId,salesOrderRef:'SOB121863',source:'user-authorized Codex recovery after general kit fix',route:'3445 to 2967'}});
 }
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),operationId,status:operation.status,phase:operation.phase,
  error:operation.error,code:operation.code,requestId:operation.requestId,requestRef:request?.requestRef,
  handoffStatus:request?.regular?.handoffStatus,handoffError:request?.regular?.handoffError,
  lines:request?.lines.map(line=>({itemId:line.itemId,itemName:line.itemName,quantity:line.salesQty,unit:line.salesUom})),
  saved,verifiedNetSuiteTransfers:verification}));
}finally{await closeDb();}
