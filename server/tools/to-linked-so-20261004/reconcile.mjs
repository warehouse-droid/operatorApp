// Reviewed local-only repair. Runner supplies APPLY and reviewed module imports.
import assert from 'node:assert/strict';
import {query,withTransaction,beginRollbackContext,closeDb} from '../../src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite} from '../../src/netsuite.js';
import {resolveTransferSource} from '../../src/transfer-order-posting-service.js';
import {verifyOperatorNetSuitePostingRecord} from '../../src/operator-netsuite-posting-adapter.js';
import {writeAudit} from '../../src/auth-repository.js';
const cases=[{reference:'TOB01190',sourceId:1037048,ifId:1038301,ifRef:'IF156515',dependencyId:'270',refs:['SOA09690']},
 {reference:'TOB01191',sourceId:1037331,ifId:1038302,ifRef:'IF156516',dependencyId:'271',refs:['SOA09694','SOA09702']}];
const actor='maintenance:to-linked-so-20261004';
async function verify(entry) {
 const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type=\'IF\'',[entry.sourceId])).rows;
 assert.equal(job.length,1);entry.job=job[0];assert.equal(entry.job.command_id,null);assert.ok(['waiting_driver','attention'].includes(entry.job.status));
 const load=(await query('SELECT * FROM operator_load_records WHERE id=$1 AND order_id=$2',[entry.job.operator_record_id,entry.sourceId])).rows[0];assert.ok(load);
 const rows=(await query(`SELECT d.*,p.status<>'cancelled' AS plan_active,
  (SELECT jsonb_agg(DISTINCT so.tranid) FROM order_dependency_lines dl JOIN sales_order_lines sl ON sl.id=dl.sales_line_id
   JOIN sales_orders so ON so.netsuite_id=sl.sales_order_id WHERE dl.dependency_id=d.id) AS source_order_refs
  FROM order_dependencies d JOIN dispatch_plans p ON p.id=d.planned_plan_id WHERE d.transfer_order_id=$1 AND d.status<>'cancelled'`,[entry.sourceId])).rows;
 assert.equal(rows.length,1);const d=rows[0];assert.equal(String(d.id),entry.dependencyId);assert.ok(d.created_at<=load.created_at);
 assert.equal(d.planned_truck_plate,load.response.dispatchTruckPlate);assert.equal(d.planned_load_name,load.response.dispatchLoadName);
 assert.equal(transferPostingDate(d.planned_date),transferPostingDate(load.response.dispatchPlanDate));
 const scope=linkedTransferDriverScope(rows);assert.ok(scope);assert.equal(scope.linkError,null);assert.deepEqual(scope.driverTarget.orderRefs,entry.refs);
 const reviewedJob={...entry.job,snapshot:{...entry.job.snapshot,...scope}};
 const event=transferPostingCompletion(reviewedJob,await readTransferCompletionEvents(reviewedJob));assert.ok(event,'Every linked SO must have effective Driver drop-off evidence');
 const source=await resolveTransferSource(entry.job);assert.equal(source.sourceNetSuiteId,entry.sourceId);assert.equal(source.sourceOrderRef,entry.reference);
 const expected=entry.job.snapshot.lines.map(line=>{
  const matches=source.availableLines.filter(s=>[s.sourceLineKey,...(s.sourceLineAliases||[])].map(String).includes(line.sourceLineKey));
  assert.equal(matches.length,1);const live=matches[0];assert.equal(Number(live.itemId),Number(line.itemId));
  assert.equal(Number(live.remainingQuantity),0);assert.equal(Number(live.orderedQuantity),Number(line.quantity));
  const physical=load.line_snapshot.filter(l=>String(l.lineId)===line.sourceLineKey&&Number(l.itemId)===Number(line.itemId));
  assert.equal(physical.length,1);assert.equal(Number(physical[0].loadedQty),line.quantity);
  return {orderLine:live.orderLine,itemId:line.itemId,quantity:line.quantity,itemReceive:true,location:Number(entry.job.snapshot.locationId),unit:physical[0].unit};
 });
 const links=await suiteqlAll(`SELECT DISTINCT t.id,t.tranid,t.type FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc WHERE l.previousdoc=${entry.sourceId} AND t.type IN ('ItemShip','ItemRcpt')`);
 assert.deepEqual(links.map(l=>[Number(l.id),l.tranid,l.type]),[[entry.ifId,entry.ifRef,'ItemShip']]);
 const record=await fetchItemFulfillmentFromNetSuite(entry.ifId);assert.equal(record.tranId,entry.ifRef);assert.ok(!record.externalId);
 for(const expectedLine of expected) {
  const actual=record.item.items.filter(l=>Number(l.orderLine)===Number(expectedLine.orderLine));assert.equal(actual.length,1);
  assert.equal(String(actual[0].unitsDisplay).toUpperCase(),String(expectedLine.unit).toUpperCase());
 }
 const verified=verifyOperatorNetSuitePostingRecord({sourceOrderKind:'TO',sourceNetSuiteId:entry.sourceId,transactionType:'IF',externalId:'',
  lineSnapshot:expected,payload:{item:{items:expected}}},{...record,transactionType:'IF'});
 const header=(await suiteqlAll(`SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id=${entry.sourceId} AND type='TrnfrOrd'`))[0];
 assert.equal(header.status,'F');assert.equal(header.tranid,entry.reference);
 return {...entry,scope,event,verified,header,expected,load};
}
async function reconcile(entry) {
 const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1 FOR UPDATE',[entry.job.id])).rows[0];
 assert.equal(job.command_id,null);assert.ok(['waiting_driver','attention'].includes(job.status));assert.deepEqual(job.snapshot,entry.job.snapshot);
 const reviewedJob={...job,snapshot:{...job.snapshot,...entry.scope}};
 const event=transferPostingCompletion(reviewedJob,await readTransferCompletionEvents(reviewedJob));assert.ok(event);assert.equal(event.id,entry.event.id);
 const completionEventIds=event.linkedEvents.map(e=>String(e.id)).sort();
 assert.deepEqual(completionEventIds,entry.event.linkedEvents.map(e=>String(e.id)).sort());
 const result={reconciledExisting:true,transactions:[{transactionType:'IF',transactionId:String(entry.verified.id),transactionRef:entry.verified.transactionRef}],
  transferEvidence:{jobId:job.id,operatorRecordId:Number(job.operator_record_id),completionEventId:Number(event.id),completionEventIds,driverTarget:entry.scope.driverTarget},
  verifiedAt:new Date().toISOString(),netSuitePosts:0};
 await query(`UPDATE transfer_order_posting_jobs SET status='completed',last_error=NULL,completion_event_id=$2,
  snapshot=$3::jsonb,result=$4::jsonb,updated_at=now() WHERE id=$1`,[job.id,event.id,JSON.stringify({...reviewedJob.snapshot,completionEventIds}),JSON.stringify(result)]);
 await query(`UPDATE operator_load_records SET response=response||jsonb_build_object('operatorNetSuitePosting',$2::jsonb) WHERE id=$1`,[job.operator_record_id,JSON.stringify(result)]);
 await query(`UPDATE transfer_orders SET status=$2,status_text=$3,fulfillment_status='fulfilled',status_updated_at=now() WHERE netsuite_id=$1`,[entry.sourceId,entry.header.status,entry.header.status_text]);
 await writeAudit({actorType:'system',source:'admin',action:'transfer_posting.linked_so_existing_if_reconciled',orderId:entry.sourceId,
  details:{actor,reason:'Verified existing NetSuite IF before retry; matched saved Operator quantities and every linked SO Driver drop-off. No IF/IR posted.',
   before:{status:job.status,snapshot:job.snapshot},result,verifiedLines:entry.expected}});
 return {reference:entry.reference,status:'completed',linkedSalesOrders:entry.refs,fulfillment:entry.ifRef,quantities:entry.expected.map(l=>l.quantity),netSuitePosts:0};
}
try {
 const verified=[];for(const entry of cases)verified.push(await verify(entry));
 const operation=async()=>{const results=[];for(const entry of verified)results.push(await reconcile(entry));return results;};
 let results;if(APPLY)results=await withTransaction(operation);
 else {const c=await beginRollbackContext();try{results=await c.run(operation);}finally{await c.rollback();}}
 console.log(JSON.stringify({apply:APPLY,at:new Date().toISOString(),results,netSuitePosts:0},null,2));
}finally{await closeDb();}
