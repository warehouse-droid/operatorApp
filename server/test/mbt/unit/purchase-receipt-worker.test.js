import assert from 'node:assert/strict';
import test from 'node:test';
import {createDelayedStatusRefreshWorker} from '../../../src/netsuite-delayed-status-refresh-service.js';
test('PO receipt quantities are applied before linked status reconciliation and emitted only after commit',async()=>{
  const calls=[];
  const lines=[{line_id:71,quantity:10,netsuite_received_qty:10}];
  const worker=createDelayedStatusRefreshWorker({claimJobs:async()=>[],lockLease:async()=>true,finishAttempt:async()=>true,
    fetchTransactionStatus:async()=>({status:'F',status_text:'Pending Bill'}),fetchSalesOrderLines:async()=>[],
    fetchPurchaseOrderLines:async()=>lines,applyPurchaseOrderWeights:async()=>calls.push('weights'),
    applyPurchaseOrderLines:async input=>{assert.deepEqual(input.lines,lines);calls.push('received');},
    applyStatus:async()=>calls.push('status'),applySalesOrderLines:async()=>{},withTransaction:async fn=>{const r=await fn();calls.push('commit');return r;},
    writeAudit:async()=>{},emitEvents:()=>calls.push('event')});
  const result=await worker.processJob({jobId:1,orderType:'purchase_order',netsuiteOrderId:7,attemptNumber:1,leaseToken:'receipt-token'});
  assert.equal(result.outcome,'succeeded');
  assert(calls.includes('received'));assert(calls.indexOf('received')<calls.indexOf('status'));assert(calls.indexOf('commit')<calls.indexOf('event'));
});
