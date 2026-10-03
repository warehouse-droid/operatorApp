import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelayedStatusRefreshWorker} from '../../../src/netsuite-delayed-status-refresh-service.js';

const job={jobId:91,orderType:'sales_order',netsuiteOrderId:123,tranid:'SOT123',attemptNumber:1,leaseToken:'b0cc2783-d88f-4a8c-92b5-b3c4fbc7d3fa'};
function harness(overrides={}){
 const observed=[];let inTransaction=false;
 const worker=createDelayedStatusRefreshWorker({claimJobs:async()=>[],lockLease:async()=>true,finishAttempt:async()=>true,
  fetchTransactionStatus:async()=>({tranid:'SOT123',status:'A'}),fetchSalesOrderLines:async()=>[],
  applyStatus:async()=>null,applySalesOrderLines:async()=>{},writeAudit:async()=>{},emitEvents:()=>{},logger:{error(){}},
  withTransaction:async fn=>{inTransaction=true;try{return await fn();}finally{inTransaction=false;}},
  onStatusObserved:async o=>{assert(inTransaction);observed.push(o);},...overrides});
 return {worker,observed};
}
test('committed Pending Approval is observed even when the delayed job retries',async()=>{
 const {worker,observed}=harness();const result=await worker.processJob(job);
 assert.equal(result.outcome,'retry');assert.equal(observed.length,1);assert.equal(observed[0].status,'A');
});
test('failed status, missing status, lease loss and failed commit do not publish intake',async()=>{
 for(const overrides of [{fetchTransactionStatus:async()=>{throw new Error('offline');}},
  {fetchTransactionStatus:async()=>null},{lockLease:async()=>false},{finishAttempt:async()=>false},
  {applyStatus:async()=>{throw new Error('rollback');}}]){
  const {worker,observed}=harness(overrides);await worker.processJob(job);assert.equal(observed.length,0);
 }
 // Also prove that the observation hook itself is live in this scenario group.
 const {worker,observed}=harness();await worker.processJob(job);assert.equal(observed.length,1);
});
test('approval-only SOT refresh skips operational sales order line reads',async()=>{
 let lineReads=0;
 const {worker,observed}=harness({shouldRefreshSalesOrderLines:async()=>false,fetchSalesOrderLines:async()=>{lineReads++;return [];}});
 await worker.processJob(job);assert.equal(lineReads,0);assert.equal(observed.length,1);
});
