import {query,withTransaction,closeDb} from './src/db.js';
import {fetchTransactionStatusesFromNetSuite} from './src/netsuite.js';
import {isCompletedNetSuitePostingOrder} from './src/netsuite-fulfillable-items.js';
import {resolveSalesOrderAutoFulfillmentCandidate,getSalesOrderAutoFulfillmentCandidate,
 markSalesOrderAutoFulfillmentReconciled,markSalesOrderAutoFulfillmentClosed} from './src/sales-order-auto-fulfillment-repository.js';
import {enqueueSalesOrderAutoFulfillmentCandidate} from './src/sales-order-auto-fulfillment-runtime.js';
import {prepareDirectPoReceiptJob} from './src/direct-po-auto-receipt.js';
import {operatorNetSuitePostingRuntime} from './src/operator-netsuite-posting-runtime.js';
import {getOperatorNetSuitePostingCommand} from './src/operator-netsuite-posting-repository.js';
const snapshot=/* AUDIT_SNAPSHOT */null;
const actor='codex-direct-ship-retry-20261001';
const reason='User approved enabling all four missing gates and retrying completed gate_disabled orders, subject to live order status and line remaining quantity.';
if(process.env.DIRECT_SHIP_POSTING_APPLY!=='1'||snapshot?.readOnly!==true){throw new Error('Explicit authorized apply mode and the read-only backlog snapshot are required.');}
const result={startedAt:new Date().toISOString(),gateChanges:[],receipts:[],fulfillments:[]};
const terminal=new Set(['completed','reconciled','closed']);
try {
 result.gateChanges=await withTransaction(async()=>{
  const keys=['dispatch_netsuite_sales_order_if_150','dispatch_netsuite_sales_order_if_2967','dispatch_netsuite_sales_order_if_12441','operator_netsuite_receiving_ir_2967'];
  const changed=(await query(`UPDATE mbt_feature_flags SET enabled=true,revision=revision+1,updated_by=$2,updated_at=now()
    WHERE flag_key=ANY($1::text[]) AND enabled=false RETURNING flag_key,enabled,revision`,[keys,actor])).rows;
  const flags=(await query('SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key=ANY($1::text[])',[keys])).rows;
  if(flags.length!==4||flags.some(flag=>flag.enabled!==true)){throw new Error('All four authorized gates must be present and enabled.');}
  return changed;
 });
 const events=snapshot.directEvents.filter(event=>event.dispatch_completed_at);
 for(const event of events){
  const receipt={eventId:event.id,orderRef:event.order_ref,sourceOrderId:event.source_order_id};
  try {
   const job=(await query(`INSERT INTO dispatch_direct_po_ir_jobs(completion_event_id,local_po_id)
      SELECT id,(metadata->>'poOrderId')::bigint FROM dispatch_effective_order_completion_events
       WHERE id=$1 AND metadata->>'directShipCoverageVerified'='true'
      ON CONFLICT(completion_event_id) DO UPDATE SET updated_at=dispatch_direct_po_ir_jobs.updated_at RETURNING *`,[event.id])).rows[0];
   if(!job){throw new Error('The local direct PO completion is no longer effective.');}
   const prepared=await prepareDirectPoReceiptJob(job.id);
   if(prepared?.command){await operatorNetSuitePostingRuntime.enqueue(prepared.command.id);}
   const current=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE id=$1',[job.id])).rows[0];
   const command=current.command_id?await getOperatorNetSuitePostingCommand(current.command_id):null;
   Object.assign(receipt,{jobId:job.id,jobStatus:current.status,status:command?.status||current.status,
    commandId:current.command_id,transactions:command?.steps?.map(step=>({id:step.netSuiteTransactionId,ref:step.netSuiteTransactionRef,status:step.status})),
    error:command?.lastError||current.last_error||null,result:current.result});
  } catch(error){receipt.error=error.message;receipt.status='attention';}
  result.receipts.push(receipt);
  console.error(JSON.stringify({receipt:receipt.orderRef,status:receipt.status,error:receipt.error}));
 }
 const ids=[...new Set(snapshot.candidates.map(row=>Number(row.source_order_id)).filter(id=>Number.isSafeInteger(id)&&id>0))];
 const headers=new Map((await fetchTransactionStatusesFromNetSuite(ids,'SalesOrd')).map(header=>[Number(header.id),header]));
 for(const row of snapshot.candidates){
  const fulfillment={candidateId:row.id,orderRef:row.dispatch_order_ref,sourceOrderId:row.source_order_id};
  try {
   const candidate=await getSalesOrderAutoFulfillmentCandidate(row.id);
   if(!candidate){throw new Error('The requested candidate is missing.');}
   if(terminal.has(candidate.status)){fulfillment.status=candidate.status;}
   else if(candidate.status==='posting'||candidate.status==='uncertain'){
    fulfillment.status=candidate.status;fulfillment.error='Existing in-flight or uncertain posting requires external-ID recovery.';
   }else{
    const effective=(await query('SELECT id FROM dispatch_effective_order_completion_events WHERE id=$1',[row.completion_event_id])).rowCount===1;
    if(!effective){throw new Error('Local completion is no longer effective.');}
    const live=headers.get(Number(row.source_order_id));
    if(!live){throw new Error('A positive live NetSuite SO parent could not be read.');}
    if(isCompletedNetSuitePostingOrder('SO',live)){
     const closed=['C','H'].includes(String(live.status));
     const complete=closed?markSalesOrderAutoFulfillmentClosed:markSalesOrderAutoFulfillmentReconciled;
     await complete({candidateId:row.id,liveOrder:live,issues:[{code:'LIVE_ORDER_ALREADY_COMPLETE',reason}]});
     fulfillment.status=closed?'closed':'reconciled';fulfillment.disposition='live_order_complete_skip';
    }else{
     await resolveSalesOrderAutoFulfillmentCandidate({candidateId:row.id,action:'historical_backfill',actorId:actor,reason});
     await enqueueSalesOrderAutoFulfillmentCandidate(row.id);
    }
   }
   const after=await getSalesOrderAutoFulfillmentCandidate(row.id);
   Object.assign(fulfillment,{status:after.status,transactionId:after.netSuiteTransactionId,transactionRef:after.netSuiteTransactionRef,
    error:fulfillment.error||after.lastError||null,attemptCount:after.attemptCount});
  }catch(error){fulfillment.status='attention';fulfillment.error=error.message;}
  result.fulfillments.push(fulfillment);
  if(fulfillment.disposition!=='live_order_complete_skip'){console.error(JSON.stringify(fulfillment));}
 }
 result.finishedAt=new Date().toISOString();
 const counts={};for(const order of result.fulfillments){counts[order.status]=(counts[order.status]||0)+1;}
 result.summary={checked:result.fulfillments.length,fulfillmentStatuses:counts,receiptStatuses:result.receipts.map(row=>({orderRef:row.orderRef,status:row.status})),gatesEnabled:result.gateChanges.length};
 console.log(JSON.stringify(result));
}finally{await closeDb();}
