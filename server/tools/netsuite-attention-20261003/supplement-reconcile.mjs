// Supplied APPLY/REVIEW constants select rollback rehearsal or audited local repair.
// No NetSuite transform or posting adapter is imported.
import assert from 'node:assert/strict';
import {query,withTransaction,beginRollbackContext,closeDb} from '../../src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite,fetchSalesOrderFulfillmentStateFromNetSuite} from '../../src/netsuite.js';
import {prepareSalesOrderAutoFulfillmentCandidate} from '../../src/sales-order-auto-fulfillment-repository.js';
import {writeAudit} from '../../src/auth-repository.js';
const actor='maintenance:netsuite-attention-20261003';
try {
 const source=await fetchSalesOrderFulfillmentStateFromNetSuite(1037330);
 assert.deepEqual(source,REVIEW.source,'Source changed since review');
 const existing=await suiteqlAll(`SELECT DISTINCT t.id,t.tranid,t.type FROM transaction t LEFT JOIN NextTransactionLineLink l ON l.nextdoc=t.id
  WHERE (l.previousdoc=1037330 AND t.type IN ('ItemShip','ItemRcpt')) OR t.externalid='MBBS-SOIF-236e4f20-3e14-4b94-b31c-a6519135bf6a'`);
 assert.equal(existing.length,0,'New existing transaction requires review');
 const headers=await suiteqlAll("SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id=1036611 AND type='TrnfrOrd'");
 assert.equal(headers.length,1);assert.equal(headers[0].tranid,'TOB01189');assert.equal(headers[0].status,'F');
 const transferIf=await fetchItemFulfillmentFromNetSuite(1037916);
 assert.equal(transferIf.tranId,'IF156491');assert.equal(String(transferIf.createdFrom.id),'1036611');
 const lines=transferIf.item.items.map(l=>({line:Number(l.orderLine),item:Number(l.item.id),quantity:Number(l.quantity)})).sort((a,b)=>a.line-b.line);
 assert.deepEqual(lines,[{line:2,item:2299,quantity:5},{line:5,item:2298,quantity:1},{line:8,item:1784,quantity:4}]);
 const operation=async()=>{
  const id=REVIEW.candidate.id;
  const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert.equal(row.status,'attention');assert.equal(row.attempt_count,0);assert.equal(row.lease_token,null);
  assert.equal(row.updated_at.toISOString(),REVIEW.candidate.updated_at);
  assert.equal(row.snapshot_hash,null);assert.equal(row.dispatch_order_ref,'SOA09706');
  await query("UPDATE dispatch_sales_order_if_candidates SET status='discovered',last_error=NULL,updated_at=now() WHERE id=$1",[id]);
  const prepared=await prepareSalesOrderAutoFulfillmentCandidate(id);
  assert.equal(prepared.status,'waiting_evidence');assert.equal(prepared.sourceSalesOrderId,1037330);assert.equal(prepared.attemptCount,0);
  await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
   VALUES($1,'verified_existing_maintenance',$2,$3,$4::jsonb)`,[id,actor,
   'Verified NetSuite source and absence of linked/external-ID IF/IR. Restore required Operator evidence waiting state without posting.',
   JSON.stringify({beforeStatus:row.status,previousError:row.last_error,status:prepared.status,source,existing,netSuitePosts:0})]);
  const before=(await query(`SELECT netsuite_id,tranid,status,status_text,fulfillment_status,local_yard_order_status FROM transfer_orders WHERE netsuite_id=1036611 FOR UPDATE`)).rows[0];
  assert.equal(before.tranid,'TOB01189');assert.equal(before.status,'B');
  await query(`UPDATE transfer_orders SET status=$1,status_text=$2,fulfillment_status='fulfilled',status_updated_at=now() WHERE netsuite_id=1036611`,[headers[0].status,headers[0].status_text]);
  await writeAudit({actorType:'system',source:'admin',action:'netsuite.transfer_header.verified_existing_reconciled',orderId:1036611,
   details:{actor,before,source:headers[0],transaction:{id:1037916,reference:'IF156491',lines},reason:'Refresh stale cached header after live fulfillment verification; no physical load or receipt recorded.'}});
  return {sales:{reference:'SOA09706',status:prepared.status,reason:prepared.lastError},transfer:{reference:'TOB01189',status:headers[0].status_text,transaction:'IF156491'},netSuitePosts:0};
 };
 let result;
 if(APPLY)result=await withTransaction(operation);
 else {const rollback=await beginRollbackContext();try{result=await rollback.run(operation);}finally{await rollback.rollback();}}
 console.log(JSON.stringify({apply:APPLY,at:new Date().toISOString(),...result},null,2));
}finally{await closeDb();}
