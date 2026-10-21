// Authorized follow-up: reconcile verified zero-remaining split lines, and hold
// the unreadable workflow-locked order. This script issues no NetSuite writes.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {fetchTransactionProgressFromNetSuite,fetchSalesOrderFulfillmentStateFromNetSuite} from './src/netsuite.js';
import {getSalesOrderAutoFulfillmentCandidate,markSalesOrderAutoFulfillmentReconciled,
 markSalesOrderAutoFulfillmentAttention} from './src/sales-order-auto-fulfillment-repository.js';
const actor='codex-direct-ship-retry-20261001';
const expected=[
 {id:'0bf75655-0b54-430d-b364-9e0450ccd97a',ref:'SOM06256-S1',parent:980542},
 {id:'4cde2966-c55d-4bb1-ae1c-647395e4260a',ref:'SOM06255-S1',parent:980538}
];
assert.equal(process.env.DIRECT_SHIP_POSTING_APPLY,'1');
const report={startedAt:new Date().toISOString(),netSuiteWrites:0,reconciled:[],held:[]};
async function lockUnposted(before){
 const current=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[before.id])).rows[0];
 assert(current&&current.status==='queued'&&Number(current.attempt_count)===0&&!current.lease_token&&!current.netsuite_transaction_id,
  'The candidate must still be unposted and unleased.');
 assert.equal(JSON.stringify(current.line_snapshot),JSON.stringify(before.lineSnapshot),'The delivered snapshot changed.');
 assert.equal(Number(current.source_sales_order_id),before.sourceSalesOrderId);
 assert.equal((await query('SELECT id FROM dispatch_effective_order_completion_events WHERE id=$1',[current.completion_event_id])).rowCount,1);
 return current;
}
try{
 for(const entry of expected){
  const before=await getSalesOrderAutoFulfillmentCandidate(entry.id);
  assert.equal(before.dispatchOrderRef,entry.ref);assert.equal(before.sourceSalesOrderId,entry.parent);
  if(before.status==='reconciled'){report.reconciled.push({orderRef:entry.ref,status:'reconciled',alreadyReconciled:true});continue;}
  const live=await fetchTransactionProgressFromNetSuite(entry.parent,'SalesOrd');
  assert.equal(Number(live?.id),entry.parent);assert(before.lineSnapshot.length>0);
  const checks=[];
  for(const selected of before.lineSnapshot){
   const local=(await query('SELECT sales_order_id,line_id,netsuite_order_line,item_id,location_id FROM sales_order_lines WHERE id=$1',[selected.sourceLineId])).rows[0];
   assert(local);assert.equal(Number(local.sales_order_id),entry.parent);
   assert.equal(Number(local.netsuite_order_line),Number(selected.orderLine));
   assert.equal(Number(local.item_id),Number(selected.itemId));assert.equal(Number(local.location_id),Number(selected.location));
   const matches=live.lines.filter(line=>Number(line.line_id)===Number(local.line_id));
   assert.equal(matches.length,1);const line=matches[0];
   assert.equal(Number(line.order_line_number),Number(selected.orderLine));
   assert.equal(Number(line.item_id),Number(selected.itemId));assert.equal(Number(line.location_id),Number(selected.location));
   const quantity=Math.abs(Number(line.quantity)),fulfilled=Math.abs(Number(line.netsuite_received_qty));
   assert(Number.isFinite(quantity)&&quantity>0&&Number.isFinite(fulfilled));
   const remaining=Math.max(0,quantity-fulfilled);
   assert(remaining<=1e-6&&fulfilled+1e-6>=Number(selected.deliveredQuantity),'Selected line still has remaining quantity.');
   checks.push({lineKey:Number(line.line_id),orderLine:Number(line.order_line_number),itemId:Number(line.item_id),quantity,fulfilled,remaining});
  }
  await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='5s'");await lockUnposted(before);
   await markSalesOrderAutoFulfillmentReconciled({candidateId:entry.id,liveOrder:live});
   await query('UPDATE dispatch_sales_order_if_candidates SET live_snapshot=$2::jsonb WHERE id=$1',[entry.id,JSON.stringify(live)]);
   await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,details)
    VALUES($1,'retry_live_lines_already_fulfilled',$2,$3::jsonb)`,[entry.id,actor,JSON.stringify({reason:'User required no duplicate posting; every selected line has zero live remaining quantity.',checks})]);
  });
  report.reconciled.push({orderRef:entry.ref,parent:entry.parent,status:'reconciled',checks});
 }
 const id='59076d3b-3d03-4d55-bd2a-91d0699f5b64';
 const before=await getSalesOrderAutoFulfillmentCandidate(id);assert.equal(before.dispatchOrderRef,'SOA09128');
 if(before.status==='attention'){report.held.push({orderRef:before.dispatchOrderRef,status:before.status,error:before.lastError});}
 else{
  let failure;try{await fetchSalesOrderFulfillmentStateFromNetSuite(1005850);}catch(error){failure=error;}
  assert(failure&&/workflow/i.test(failure.message)&&/lock/i.test(failure.message),'The source is no longer workflow-locked; use the normal guarded retry instead.');
  const live=await fetchTransactionProgressFromNetSuite(1005850,'SalesOrd');
  const reason='NetSuite source Sales Order is locked by a user-defined workflow; exact REST source verification failed. No fulfillment was sent.';
  await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='5s'");await lockUnposted(before);
   await markSalesOrderAutoFulfillmentAttention({candidateId:id,liveOrder:live,issues:[{code:'NETSUITE_SOURCE_WORKFLOW_LOCKED',reason}]});
   await query('UPDATE dispatch_sales_order_if_candidates SET last_error=$2,live_snapshot=$3::jsonb WHERE id=$1',[id,reason,JSON.stringify(live)]);
   await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,details)
    VALUES($1,'retry_source_workflow_locked',$2,$3::jsonb)`,[id,actor,JSON.stringify({reason,error:failure.message})]);
  });
  report.held.push({orderRef:before.dispatchOrderRef,status:'attention',error:reason,liveOrder:live});
 }
 report.finishedAt=new Date().toISOString();report.summary={reconciled:report.reconciled.length,held:report.held.length,netSuiteWrites:0};
 console.log(JSON.stringify(report));
}finally{await closeDb();}
