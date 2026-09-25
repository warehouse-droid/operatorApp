import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {upsertSalesOrderLines} from '../src/order-sync-repository.js';
import {writeAudit} from '../src/auth-repository.js';
import {verifyOperatorNetSuitePostingRecord} from '../src/operator-netsuite-posting-adapter.js';
import {finalizeOperatorNetSuitePosting} from '../src/operator-netsuite-posting-finalizer.js';
import {enqueueDispatchOrderCatalogRefresh} from '../src/dispatch-order-catalog-repository.js';
import * as repository from '../src/operator-netsuite-posting-repository.js';

export const REPAIR_COMMAND_ID='8574bd86-a8fb-48ee-aba5-042d85734d4f';
const expected=[
 {orderLine:1,key:4967884,item:1354,quantity:156.75},
 {orderLine:2,key:4967885,item:1501,quantity:24.6},
 {orderLine:3,key:4967886,item:1784,quantity:2},
 {orderLine:8,key:4967891,item:602,quantity:2}
];
const reason='User explicitly confirmed all four SOB120541 lines were physically loaded; reconcile the missed same-timestamp webhook line to existing IF153890.';

function verifyRepairEvidence(command,record,sourceLines){
 assert.equal(Number(record.id),996410);assert.equal(record.tranId,'IF153890');
 assert.equal(command.steps.length,1);const step=command.steps[0];
 assert.equal(step.sourceNetSuiteId,995451);assert.equal(step.transactionType,'IF');
 assert.equal(step.externalId,`MBBS-OP-${REPAIR_COMMAND_ID}-1`);
 const selected=step.payload.item.items.filter(line=>line.itemReceive!==false&&Number(line.quantity)>0);
 assert.deepEqual(selected.map(line=>[Number(line.orderLine),Number(line.quantity)]).sort((a,b)=>a[0]-b[0]),expected.slice(0,3).map(line=>[line.orderLine,line.quantity]));
 const approvedPayload={...step.payload,item:{items:expected.map(line=>({orderLine:line.orderLine,quantity:line.quantity,location:1,itemReceive:true}))}};
 verifyOperatorNetSuitePostingRecord({...step,payload:approvedPayload},{...record,transactionType:record.transactionType||'IF'});
 const actual=record.item.items.filter(line=>line.itemReceive!==false&&Number(line.quantity)>0);
 for(const line of expected){
  assert.equal(Number(actual.find(row=>Number(row.orderLine)===line.orderLine)?.item?.id),line.item,'IF item must match the approved line');
  const source=sourceLines.find(row=>Number(row.netsuite_order_line)===line.orderLine);
  assert.ok(source,'Current source line must exist');
  assert.equal(Number(source.line_id),line.key);assert.equal(Number(source.item_id),line.item);
  assert.equal(Number(source.quantity),line.quantity);assert.equal(Number(source.location_id),1);
 }
 assert.equal(sourceLines.filter(line=>['InvtPart','NonInvtPart'].includes(line.item_type)&&!/^(?:DELIVERY CHARGE|SALES CREDIT)/i.test(line.item_name||'')).length,4);
 return {reason,approvedLines:expected,transactionId:996410,transactionRef:'IF153890',originalInputHash:command.inputHash,originalPayloadHash:step.payloadHash};
}

async function assertCompletedState(){
 const rows=(await query('SELECT line_id,loaded_qty FROM sales_order_lines WHERE sales_order_id=995451 ORDER BY line_id')).rows;
 assert.deepEqual(rows.map(row=>[Number(row.line_id),Number(row.loaded_qty)]),expected.map(line=>[line.key,line.quantity]));
 assert.equal((await query('SELECT count(*)::int n FROM operator_load_records WHERE order_id=995451')).rows[0].n,1);
}

/** This deliberately scoped repair has no remote mutation or transform capability. */
export async function reconcileSob120541({record,sourceLines},{apply=false}={}){
 return withTransaction(async()=>{
  await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[REPAIR_COMMAND_ID]);
  await query('SELECT netsuite_id FROM sales_orders WHERE netsuite_id=995451 FOR UPDATE');
  const before=await repository.getOperatorNetSuitePostingCommand(REPAIR_COMMAND_ID);assert.ok(before);
  const reconciliation=verifyRepairEvidence(before,record,sourceLines);
  if(before.status==='completed'){
   assert.equal(before.steps[0].netSuiteTransactionId,996410);await assertCompletedState();
   return {completed:true,alreadyCompleted:true,applied:false,transactionRef:'IF153890'};
  }
  assert.equal(before.status,'attention');assert.ok(before.activeClaims.length>0);
  assert.equal((await query('SELECT count(*)::int n FROM operator_load_records WHERE order_id=995451')).rows[0].n,0,'Existing load history requires separate review');
  const local=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=995451 FOR UPDATE')).rows;
  assert.equal(local.length,3,'Repair applies only to the verified missing-line incident');
  for(const line of local){
   const target=expected.find(row=>row.key===Number(line.line_id));assert.ok(target);
   assert.equal(Number(line.item_id),target.item);assert.equal(Number(line.quantity),target.quantity);assert.equal(Number(line.loaded_qty),0);
  }
  // Import only the missing source line. Completion is recorded by the original
  // local finalizer, not by importing NetSuite's already fulfilled quantity.
  const missing=sourceLines.find(line=>Number(line.line_id)===4967891);
  await upsertSalesOrderLines(995451,[{...missing,netsuite_received_qty:0}]);
  await query('UPDATE sales_order_lines SET packed_piece_qty=2,confirmed=true,confirmed_at=now() WHERE sales_order_id=995451 AND line_id=4967891');
  await repository.resumeOperatorNetSuitePostingCommand(REPAIR_COMMAND_ID);
  const lease=await repository.claimOperatorNetSuitePostingCommand({commandId:REPAIR_COMMAND_ID,workerId:'sob120541-approved-reconciliation',leaseSeconds:180});assert.ok(lease);
  const step=before.steps[0],attempt=await repository.startOperatorNetSuitePostingAttempt({commandId:REPAIR_COMMAND_ID,stepId:step.id,leaseToken:lease.leaseToken});
  await repository.recordOperatorNetSuitePostingStepSuccess({commandId:REPAIR_COMMAND_ID,stepId:step.id,leaseToken:lease.leaseToken,attemptNumber:attempt.attemptNumber,
   transactionId:996410,transactionRef:'IF153890',recovered:true,response:{reconciliation}});
  const verified=await repository.getOperatorNetSuitePostingCommand(REPAIR_COMMAND_ID);
  await repository.completeOperatorNetSuitePostingCommand({commandId:REPAIR_COMMAND_ID,leaseToken:lease.leaseToken,result:{reconciliation},finalize:()=>finalizeOperatorNetSuitePosting(verified)});
  await query("UPDATE operator_load_records SET response=response||jsonb_build_object('approvedReconciliation',$1::jsonb) WHERE order_id=995451",[JSON.stringify(reconciliation)]);
  await writeAudit({actorType:'system',source:'approved-repair',action:'customer_pickup.existing_if_reconciled',orderId:995451,details:{commandId:REPAIR_COMMAND_ID,...reconciliation}});
  await enqueueDispatchOrderCatalogRefresh({orderRef:'SOB120541',orderType:'SO',source:'approved-existing-if-reconciliation'});
  const after=await repository.getOperatorNetSuitePostingCommand(REPAIR_COMMAND_ID);
  assert.equal(after.inputHash,before.inputHash);assert.deepEqual(after.inputSnapshot,before.inputSnapshot);assert.deepEqual(after.steps[0].payload,before.steps[0].payload);
  assert.equal(after.activeClaims.length,0);await assertCompletedState();
  return {completed:true,alreadyCompleted:false,applied:apply,orderRef:'SOB120541',transactionRef:'IF153890',lines:expected,immutableSubmissionPreserved:true};
 },{rollback:!apply});
}
