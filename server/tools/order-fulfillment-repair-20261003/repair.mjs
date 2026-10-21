import assert from 'node:assert/strict';
import {query,withTransaction} from '/app/src/db.js';
import * as repository from '/app/src/operator-netsuite-posting-repository.js';
import {finalizeOperatorNetSuitePosting} from '/app/src/operator-netsuite-posting-finalizer.js';
import {lockConsolidatedLoadOrders} from '/app/src/consolidation-load-locks.js';
import {updateSalesOrderNetSuiteStatus,updateTransferOrderNetSuiteStatus} from '/app/src/order-sync-repository.js';
import {enqueueDispatchOrderCatalogRefresh} from '/app/src/dispatch-order-catalog-repository.js';
import {writeAudit} from '/app/src/auth-repository.js';
import {incidents,verifyIncidentEvidence} from './evidence.mjs';

export async function snapshotIncident(kind) {
  const t=incidents[kind], table=kind==='TO'?'transfer_orders':'sales_orders';
  const lines=kind==='TO'?'transfer_order_lines':'sales_order_lines', foreign=kind==='TO'?'transfer_order_id':'sales_order_id';
  return {
    order:(await query(`SELECT * FROM ${table} WHERE netsuite_id=$1`,[t.id])).rows,
    lines:(await query(`SELECT * FROM ${lines} WHERE ${foreign}=$1 ORDER BY id`,[t.id])).rows,
    commands:(await query('SELECT * FROM operator_netsuite_posting_commands WHERE input_snapshot::text LIKE $1 ORDER BY id',[`%${t.ref}%`])).rows,
    steps:(await query('SELECT * FROM operator_netsuite_posting_steps WHERE source_netsuite_id=$1 ORDER BY id',[t.id])).rows,
    claims:(await query('SELECT * FROM operator_netsuite_posting_order_claims WHERE local_order_key LIKE $1 ORDER BY command_id,local_order_key',[`%:${t.id}`])).rows,
    loads:(await query('SELECT * FROM operator_load_records WHERE order_id=$1 ORDER BY id',[t.id])).rows,
    audit:(await query('SELECT * FROM delivery_audit_log WHERE order_id=$1 ORDER BY id',[t.id])).rows,
    completionEvents:(await query('SELECT to_jsonb(e) AS row FROM dispatch_order_completion_events e WHERE to_jsonb(e)::text LIKE $1 ORDER BY id',[`%${t.ref}%`])).rows
  };
}

async function assertCompleted(kind,before) {
  const t=incidents[kind], after=await snapshotIncident(kind);
  const command=await repository.getOperatorNetSuitePostingCommand(t.commandId);
  assert.equal(command.status,'completed');assert.equal(command.activeClaims.length,0);
  assert.equal(command.steps[0].netSuiteTransactionId,t.transactionId);
  assert.equal(after.loads.length,1);assert.equal(after.loads[0].line_snapshot.length,2);
  const lines=after.lines.filter(l=>kind!=='TO'||l.line_stage==='outbound');
  for(const expected of t.lines) {
    const local=lines.find(l=>Number(l.line_id)===expected.key);assert(local);
    assert.equal(Number(local.loaded_qty),expected.quantity);
    assert.equal(local.confirmed,false);
    for(const field of ['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','packed_sales_qty']) assert.equal(Number(local[field]),0);
  }
  assert.equal(after.order[0][kind==='TO'?'outbound_operator_status':'operator_status'],'loaded');
  assert.equal(after.order[0].status,'F');assert.equal(after.order[0].fulfillment_status,'fulfilled');
  assert.equal(Number(after.order[0].last_item_fulfillment_id),t.transactionId);
  if(before) {
    const original=before.commands.find(c=>c.id===t.commandId), saved=after.commands.find(c=>c.id===t.commandId);
    for(const field of ['input_hash','input_snapshot','photo_refs','actor_operator_id','request_id']) assert.deepEqual(saved[field],original[field],`Preserve ${field}`);
    const oldStep=before.steps.find(s=>s.command_id===t.commandId), newStep=after.steps.find(s=>s.command_id===t.commandId);
    for(const field of ['payload','payload_hash','line_snapshot','external_id']) assert.deepEqual(newStep[field],oldStep[field]);
    for(const event of before.completionEvents) assert.deepEqual(after.completionEvents.find(e=>e.row.id===event.row.id),event);
    const added=after.completionEvents.filter(e=>!before.completionEvents.some(b=>b.row.id===e.row.id));
    assert(added.length<=1,'Only the source-derived completion event is permitted');
    for(const {row:event} of added) {
      assert.equal(event.completion_evidence_type,'netsuite_fulfillment');
      assert.equal(event.order_ref,t.ref);assert.equal(event.order_kind,kind);
      assert.equal(event.dispatch_completion_status,'completed');
      assert.equal(event.actor_type,'system');assert.equal(event.load_id,null);assert.equal(event.plan_id,null);
      assert.equal(Date.parse(event.dispatch_completed_at),Date.parse(after.order[0].fulfilled_at));
    }
    if(kind==='TO') {
      assert.deepEqual(after.lines.filter(l=>l.line_stage==='receiving'),before.lines.filter(l=>l.line_stage==='receiving'));
      for(const field of ['receiving_status','received_at','last_item_receipt_id','last_item_receipt_tranid']) assert.deepEqual(after.order[0][field],before.order[0][field]);
      assert.deepEqual(after.commands.filter(c=>c.id!==t.commandId),before.commands.filter(c=>c.id!==t.commandId));
    }
  }
  return {orderRef:t.ref,transactionRef:t.transactionRef,commandStatus:command.status,activeClaims:0,loadRecords:1,loadedLines:lines.map(l=>({itemId:Number(l.item_id),quantity:Number(l.loaded_qty)}))};
}

async function recoverOne(kind,remote) {
  const t=incidents[kind], table=kind==='TO'?'transfer_orders':'sales_orders';
  const lines=kind==='TO'?'transfer_order_lines':'sales_order_lines',foreign=kind==='TO'?'transfer_order_id':'sales_order_id';
  await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE',[t.commandId]);
  await query(`SELECT netsuite_id FROM ${table} WHERE netsuite_id=$1 FOR UPDATE`,[t.id]);
  await query(`SELECT id FROM ${lines} WHERE ${foreign}=$1 ORDER BY id FOR UPDATE`,[t.id]);
  const before=await snapshotIncident(kind), command=await repository.getOperatorNetSuitePostingCommand(t.commandId);
  if(command.status==='completed') return {...await assertCompleted(kind),alreadyApplied:true};
  const proof=verifyIncidentEvidence({kind,command,...remote,localLines:before.lines.filter(l=>kind!=='TO'||l.line_stage==='outbound')});
  assert.equal(before.loads.length,0,'A prior local load needs separate investigation');
  assert.equal(command.status,kind==='TO'?'failed':'attention');
  assert.equal(command.steps[0].status,kind==='TO'?'failed':'uncertain');
  assert.equal(before.claims.filter(c=>c.active&&c.command_id!==t.commandId).length,0,'Another command owns this order');
  if(kind==='TO') {
    // Reopen only the verified failed command inside this transaction. It never
    // becomes visible to background workers in a runnable state.
    assert.equal(command.activeClaims.length,0);
    const claims=await query('UPDATE operator_netsuite_posting_order_claims SET active=true,released_at=NULL WHERE command_id=$1 RETURNING local_order_key',[t.commandId]);
    assert.equal(claims.rowCount,2);
    const queued=await query("UPDATE operator_netsuite_posting_commands SET status='queued',last_error=NULL,updated_at=now() WHERE id=$1 AND status='failed' RETURNING id",[t.commandId]);
    assert.equal(queued.rowCount,1);
  } else await repository.resumeOperatorNetSuitePostingCommand(t.commandId);
  const lease=await repository.claimOperatorNetSuitePostingCommand({commandId:t.commandId,workerId:'incident-reconciliation-20261003',leaseSeconds:120});assert(lease);
  const attempt=await repository.startOperatorNetSuitePostingAttempt({commandId:t.commandId,stepId:command.steps[0].id,leaseToken:lease.leaseToken});
  await repository.recordOperatorNetSuitePostingStepSuccess({commandId:t.commandId,stepId:command.steps[0].id,leaseToken:lease.leaseToken,
    attemptNumber:attempt.attemptNumber,transactionId:t.transactionId,transactionRef:t.transactionRef,recovered:true,response:{supportReconciliation:proof}});
  const verified=await repository.getOperatorNetSuitePostingCommand(t.commandId);
  await repository.completeOperatorNetSuitePostingCommand({commandId:t.commandId,leaseToken:lease.leaseToken,result:{supportReconciliation:proof},finalize:()=>finalizeOperatorNetSuitePosting(verified)});
  const update=kind==='TO'?updateTransferOrderNetSuiteStatus:updateSalesOrderNetSuiteStatus;
  await update(t.id,{status:proof.sourceStatus,statusText:proof.sourceStatusText});
  await query(`UPDATE ${table} SET fulfillment_status='fulfilled',last_item_fulfillment_id=$2,last_item_fulfillment_tranid=$3,fulfilled_at=$4 WHERE netsuite_id=$1`,
    [t.id,t.transactionId,t.transactionRef,remote.record.createdDate]);
  await query("UPDATE operator_load_records SET response=response||jsonb_build_object('supportReconciliation',$2::jsonb) WHERE order_id=$1",[t.id,JSON.stringify(proof)]);
  await writeAudit({actorType:'system',source:'user-requested-incident-repair',action:'operator.existing_fulfillment.reconciled',orderId:t.id,
    details:{...proof,commandId:t.commandId,originalInputHash:command.inputHash,originalError:command.lastError,netSuiteRecordWrites:0}});
  await enqueueDispatchOrderCatalogRefresh({orderRef:t.ref,orderType:kind,source:'verified-existing-fulfillment-repair'});
  return {...await assertCompleted(kind,before),alreadyApplied:false};
}

export async function reconcileIncidents(evidence,{apply=false}={}) {
  assert(Date.now()-Date.parse(evidence.checkedAt)<180000,'Fresh remote evidence is required');
  return withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
    await lockConsolidatedLoadOrders([1023363,1032550]);
    const results=[];
    for(const kind of ['SO','TO']) results.push(await recoverOne(kind,evidence[kind]));
    return {applied:apply,rolledBack:!apply,netSuiteRecordWrites:0,results};
  },{rollback:!apply});
}
