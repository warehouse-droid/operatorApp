// Scoped operational repair. Posting uses the application's durable native worker.
import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {writeAudit} from '../src/auth-repository.js';
import {completeDirectTransfer} from '../src/direct-to-completion-repository.js';
import {prepareTransferPostingJob,retryTransferPostingJob} from '../src/transfer-order-posting-service.js';
import {getOperatorNetSuitePostingCommand} from '../src/operator-netsuite-posting-repository.js';
import {operatorNetSuitePostingRuntime} from '../src/operator-netsuite-posting-runtime.js';
import {operatorNetSuiteRequestPool} from '../src/operator-netsuite-request-pool.js';
import {verifyOperatorNetSuitePostingRecord} from '../src/operator-netsuite-posting-adapter.js';
import {reconcileOrderDependency} from '../src/order-dependency-repository.js';
import {verifyExistingTransferPosting} from './operator-to-yard-flow-reconciliation-proof.mjs';

const orderId=1045195,orderRef='TOB01208';
function currentSource(evidence) {
  assert.ok(Date.now()-new Date(evidence.at).valueOf()<15*60*1000,'Refresh NetSuite evidence before the repair.');
  const sources=evidence.sources.filter(source=>Number(source.id)===orderId && source.tranid===orderRef);
  assert.equal(sources.length,1,'The current Transfer Order identity must be unique.');return sources[0];
}
async function linkedPickupProof() {
  const dependencies=(await query("SELECT * FROM order_dependencies WHERE transfer_order_id=$1 AND status<>'cancelled'",[orderId])).rows;
  assert.equal(dependencies.length,1);assert.equal(dependencies[0].dependency_mode,'direct_to_customer');
  assert.equal(dependencies[0].sales_order_ref,'SOA09895');assert.equal(dependencies[0].status,'received_local');
  const pickup=(await query(`SELECT pickup.job_id,pickup.completed_at FROM driver_job_records pickup
    JOIN order_dependencies d ON d.transfer_order_id=$1
    JOIN driver_job_records delivered ON delivered.job_id=d.direct_receipt_job_id
    WHERE pickup.plan_id=d.planned_plan_id AND pickup.load_id=d.planned_load_id AND pickup.plan_date=d.planned_date
      AND pickup.order_refs ? $2 AND pickup.status='complete' AND pickup.stop_type='pickup'
      AND pickup.completed_at IS NOT NULL AND pickup.completed_at<=delivered.completed_at
      AND pickup.mbt_assignment_withdrawn_at IS NULL`,[orderId,orderRef])).rows;
  assert.equal(pickup.length,1,'The matching completed TO pickup must remain effective.');
  return {dependencies,pickup:pickup[0]};
}
export async function reconcileCompletedDirectTransfer(evidence,{apply=false}={}) {
  const source=currentSource(evidence);await linkedPickupProof();
  const lines=(await query('SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id',[orderId])).rows;
  const selected=lines.filter(line=>line.line_stage==='outbound' && line.netsuite_active && Number(line.quantity)>0)
    .map(line=>({lineId:String(line.id),sourceLineKey:String(line.line_id),itemId:Number(line.item_id),quantity:Number(line.quantity)}));
  const verified=verifyExistingTransferPosting({job:{transaction_type:'IF',snapshot:{lines:selected}},source,localLines:lines,
    records:evidence.records,linked:evidence.linked});
  const verifiedFulfillment={...verified,lines:selected};
  const previous=(await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[orderId])).rows;
  if(previous[0]?.status==='completed'){return {status:'already_completed',jobId:previous[0].id,result:previous[0].result};}
  assert.equal(evidence.records.filter(record=>record.type==='ItemRcpt').length,0,'An existing IR must be verified before any submission.');
  const local=await completeDirectTransfer(orderId,{verifiedFulfillment,apply});
  assert.equal(local.status,'completed_local',JSON.stringify(local));
  if(!apply){return {...local,verifiedFulfillment,netSuiteWrites:0};}
  assert.equal((await query("SELECT 1 FROM schema_migrations WHERE filename='280_direct_transfer_system_receipts.sql'")).rowCount,1);
  if(previous[0]?.status==='attention') {
    assert.equal(previous.length,1);assert.equal(previous[0].id,local.jobId);assert.equal(previous[0].command_id,null);
    assert.match(previous[0].last_error,/operator_posting_actor_or_direct_receipt/u);
    await writeAudit({actorType:'system',source:'admin',action:'operator.to.direct_posting_retry',orderId,
      details:{orderRef,jobId:local.jobId,reason:'Apply the missing verified migration, then resume the same unsubmitted IR job.'}});
    await retryTransferPostingJob(local.jobId);
  }
  const fulfillment=verified.transactions[0];
  await query(`UPDATE transfer_orders SET last_item_fulfillment_id=$2,last_item_fulfillment_tranid=$3,
    fulfillment_status='fulfilled' WHERE netsuite_id=$1`,[orderId,fulfillment.transactionId,fulfillment.transactionRef]);
  const admitted=await operatorNetSuiteRequestPool.run(()=>prepareTransferPostingJob(local.jobId));
  if(admitted?.command){await operatorNetSuitePostingRuntime.enqueue(admitted.command.id);}
  const job=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1',[local.jobId])).rows[0];
  return {...local,status:job.status,commandId:job.command_id,result:job.result,lastError:job.last_error,
    verifiedFulfillment,command:job.command_id?await getOperatorNetSuitePostingCommand(job.command_id):null};
}
export async function verifyAndReconcileDirectReceipt(evidence) {
  const source=currentSource(evidence),header=evidence.headers.find(row=>Number(row.id)===orderId && row.tranid===orderRef);
  assert.equal(header?.status,'G','NetSuite must confirm full receipt before accounting reconciliation.');
  const job=(await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'",[orderId])).rows[0];
  assert.equal(job?.status,'completed');
  const command=await getOperatorNetSuitePostingCommand(job.command_id);
  assert.equal(command.status,'completed');assert.equal(command.steps.length,1);assert.equal(command.steps[0].status,'posted');
  const step=command.steps[0],record=evidence.records.find(entry=>entry.type==='ItemRcpt' && entry.id===Number(step.netSuiteTransactionId));
  assert.ok(record,'Read the posted IR back from NetSuite.');
  const verified=verifyOperatorNetSuitePostingRecord(step,{...record.record,transactionType:'IR'});
  const localLines=(await query("SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving' ORDER BY id",[orderId])).rows;
  for(const selected of job.snapshot.lines) {
    const local=localLines.find(line=>String(line.id)===String(selected.lineId));assert.ok(local);
    const current=source.lines.filter(line=>line.stage==='receiving' && Number(line.itemId)===Number(selected.itemId)
      && [line.sourceLineKey,...(line.sourceLineAliases || [])].map(String).includes(String(selected.sourceLineKey)));
    assert.equal(current.length,1);assert.equal(Number(current[0].cumulativeProgressQuantity),Number(selected.quantity));
    assert.equal(String(current[0].unit).toUpperCase(),String(local.unit).toUpperCase());
  }
  return withTransaction(async()=>{
    for(const line of source.lines.filter(row=>row.stage==='receiving')) {
      await query(`UPDATE transfer_order_lines SET netsuite_received_qty=$3
        WHERE transfer_order_id=$1 AND line_stage='receiving' AND line_id::text=ANY($2::text[])
          AND netsuite_received_qty IS DISTINCT FROM $3`,[orderId,[line.sourceLineKey,...(line.sourceLineAliases || [])].map(String),Number(line.cumulativeProgressQuantity)]);
    }
    const updated=await query(`UPDATE transfer_orders SET status=$2,status_text=$3,fulfillment_status='fulfilled',
      outbound_operator_status='loaded',receiving_status='received',local_yard_order_status='Received',
      last_item_receipt_id=$4,last_item_receipt_tranid=$5,status_updated_at=now(),synced_at=now()
      WHERE netsuite_id=$1 AND (status IS DISTINCT FROM $2 OR status_text IS DISTINCT FROM $3
        OR fulfillment_status IS DISTINCT FROM 'fulfilled' OR last_item_receipt_id IS DISTINCT FROM $4)`,
    [orderId,header.status,header.status_text,verified.id,verified.transactionRef]);
    const dependencies=(await query("SELECT id,reconciliation_status FROM order_dependencies WHERE transfer_order_id=$1 AND dependency_mode='direct_to_customer' AND status<>'cancelled'",[orderId])).rows;
    for(const dependency of dependencies) {
      if(dependency.reconciliation_status!=='reconciled'){assert.equal((await reconcileOrderDependency(dependency.id)).reconciled,true);}
    }
    if(updated.rowCount){await writeAudit({actorType:'system',source:'admin',action:'operator.to.direct_reconciled',orderId,
      details:{orderRef,commandId:command.id,ifTransactions:job.snapshot.verifiedFulfillment.transactions,
        itemReceiptId:verified.id,itemReceiptRef:verified.transactionRef,reason:'Verified complete direct customer delivery and NetSuite IF/IR.'}});}
    return {orderRef,localStatus:'completed',netSuiteStatus:header.status_text,itemReceiptId:verified.id,itemReceiptRef:verified.transactionRef,
      fulfillment:job.snapshot.verifiedFulfillment.transactions,directLink:'SOA09895',reconciliation:'reconciled',newPhysicalRecords:0};
  });
}
