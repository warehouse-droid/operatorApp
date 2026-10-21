// Independent read-back of the complete authorized retry and created records.
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {fetchTransactionStatusesFromNetSuite,fetchTransactionProgressFromNetSuite} from './src/netsuite.js';
import {isCompletedNetSuitePostingOrder} from './src/netsuite-fulfillable-items.js';
import {getSalesOrderAutoFulfillmentCandidate} from './src/sales-order-auto-fulfillment-repository.js';
import {salesOrderAutoFulfillmentNetSuiteAdapter} from './src/sales-order-auto-fulfillment-netsuite-adapter.js';
import {getOperatorNetSuitePostingCommand} from './src/operator-netsuite-posting-repository.js';
import {operatorNetSuitePostingAdapter} from './src/operator-netsuite-posting-netsuite-adapter.js';
const snapshot=/* AUDIT_SNAPSHOT */null;
const newFulfillments=[
 {id:'120ffd31-ea2c-44a1-b554-b26605851c78',ref:'SOA09523',transactionId:1033518,transactionRef:'IF156234'},
 {id:'823e261c-eb51-4881-b969-fd255912b917',ref:'SOM06663',transactionId:1033616,transactionRef:'IF156235'},
 {id:'8407c3c1-8538-4e39-a922-cf004621e49e',ref:'SOM06662',transactionId:1033519,transactionRef:'IF156236'}
];
const report={readOnly:true,verifiedAt:new Date().toISOString(),gates:[],fulfillments:[],receipts:[],verifiedTransactions:[]};
const recordLines=record=>(record.item?.items||record.items||[]).filter(line=>line.itemReceive!==false&&Number(line.quantity)>0)
 .map(line=>({orderLine:Number(line.orderLine??line.orderline??line.line),itemId:Number(line.item?.id??line.item),quantity:Number(line.quantity),location:Number(line.location?.id??line.location)}));
try{
 assert(snapshot?.readOnly&&snapshot.candidates.length===512);
 const keys=['dispatch_netsuite_sales_order_if_150','dispatch_netsuite_sales_order_if_2967','dispatch_netsuite_sales_order_if_12441','operator_netsuite_receiving_ir_2967'];
 report.gates=(await query('SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key=ANY($1::text[]) ORDER BY flag_key',[keys])).rows;
 assert.equal(report.gates.length,4);assert(report.gates.every(gate=>gate.enabled));
 const rows=(await query(`SELECT id,dispatch_order_ref,status,source_sales_order_id,source_sales_order_ref,attempt_count,
  netsuite_transaction_id,netsuite_transaction_ref,last_error,completed_at,updated_at,line_snapshot
  FROM dispatch_sales_order_if_candidates WHERE id=ANY($1::uuid[]) ORDER BY dispatch_order_ref`,[snapshot.candidates.map(row=>row.id)])).rows;
 assert.equal(rows.length,512);
 const parentIds=[...new Set(snapshot.candidates.map(row=>Number(row.source_order_id)))];
 const headers=new Map((await fetchTransactionStatusesFromNetSuite(parentIds,'SalesOrd')).map(header=>[Number(header.id),header]));
 for(const row of rows){
  const initial=snapshot.candidates.find(entry=>entry.id===row.id);
  const live=headers.get(Number(initial.source_order_id));assert(live);
  if(initial.disposition==='live_order_complete_skip'){
   assert(['reconciled','closed'].includes(row.status));assert.equal(row.netsuite_transaction_id,null);
  }
  report.fulfillments.push({...row,sourceOrderId:Number(initial.source_order_id),liveHeader:live,
   liveOrderComplete:isCompletedNetSuitePostingOrder('SO',live),initialDisposition:initial.disposition});
 }
 assert(rows.every(row=>['reconciled','closed','completed','waiting_evidence','attention'].includes(row.status)));
 for(const expected of newFulfillments){
  const candidate=await getSalesOrderAutoFulfillmentCandidate(expected.id);
  assert.equal(candidate.dispatchOrderRef,expected.ref);assert(['completed','reconciled'].includes(candidate.status));
  assert.equal(candidate.netSuiteTransactionId,expected.transactionId);assert.equal(candidate.attemptCount,1);
  const record=await salesOrderAutoFulfillmentNetSuiteAdapter.fetchById(candidate,expected.transactionId);
  const verified=salesOrderAutoFulfillmentNetSuiteAdapter.verify(candidate,record,candidate.payload);
  assert.equal(verified.id,expected.transactionId);assert.equal(verified.transactionRef,expected.transactionRef);
  const live=await fetchTransactionProgressFromNetSuite(candidate.sourceSalesOrderId,'SalesOrd');
  assert(isCompletedNetSuitePostingOrder('SO',live));
  for(const selected of candidate.lineSnapshot){
   const matches=live.lines.filter(line=>Number(line.order_line_number)===Number(selected.orderLine)&&Number(line.item_id)===Number(selected.itemId));
   assert.equal(matches.length,1);assert(Math.abs(Number(matches[0].quantity))-Math.abs(Number(matches[0].netsuite_received_qty))<=1e-6);
  }
  report.verifiedTransactions.push({type:'IF',orderRef:expected.ref,parentId:candidate.sourceSalesOrderId,
   transactionId:verified.id,transactionRef:verified.transactionRef,externalId:candidate.externalId,
   verifiedIdentityAndQuantity:true,lines:recordLines(record),liveOrder:live});
 }
 const poHeaders=new Map((await fetchTransactionStatusesFromNetSuite(snapshot.directEvents.map(event=>Number(event.source_order_id)),'PurchOrd')).map(header=>[Number(header.id),header]));
 for(const event of snapshot.directEvents){
  const job=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE completion_event_id=$1',[event.id])).rows[0];assert(job);
  const command=job.command_id?await getOperatorNetSuitePostingCommand(job.command_id):null;
  const local=(await query('SELECT netsuite_id,tranid,receipt_status,received_at,last_item_receipt_id,last_item_receipt_tranid FROM purchase_orders WHERE netsuite_id=$1',[job.local_po_id])).rows[0];
  const liveHeader=poHeaders.get(Number(event.source_order_id));assert(liveHeader);assert(isCompletedNetSuitePostingOrder('PO',liveHeader));
  const receipt={orderRef:event.order_ref,parentId:Number(event.source_order_id),jobId:job.id,jobStatus:job.status,
   commandId:job.command_id,status:command?.status||job.status,error:command?.lastError||job.last_error||null,liveHeader,local,
   transactions:command?.steps.map(step=>({id:step.netSuiteTransactionId,ref:step.netSuiteTransactionRef,status:step.status}))||[]};
  assert(['completed','reconciled'].includes(receipt.status));report.receipts.push(receipt);
  if(!command){continue;}
  assert.equal(command.status,'completed');assert.equal(command.steps.length,1);
  assert.equal(local.receipt_status,'received');assert(local.received_at);
  for(const step of command.steps){
   assert.equal(step.status,'posted');assert.equal(step.attemptCount,1);
   const record=await operatorNetSuitePostingAdapter.fetchById(step,step.netSuiteTransactionId);
   const verified=operatorNetSuitePostingAdapter.verify(step,record);
   assert.equal(verified.id,step.netSuiteTransactionId);
   const live=await fetchTransactionProgressFromNetSuite(step.sourceNetSuiteId,'PurchOrd');
   for(const selected of step.lineSnapshot){
    const matches=live.lines.filter(line=>Number(line.order_line_number)===Number(selected.orderLine)&&Number(line.item_id)===Number(selected.itemId));
    assert.equal(matches.length,1);assert(Math.abs(Number(matches[0].quantity))-Math.abs(Number(matches[0].netsuite_received_qty))<=1e-6);
   }
   report.verifiedTransactions.push({type:'IR',orderRef:event.order_ref,parentId:step.sourceNetSuiteId,
    transactionId:verified.id,transactionRef:verified.transactionRef,externalId:step.externalId,
    verifiedIdentityAndQuantity:true,lines:recordLines(record),liveOrder:live});
  }
 }
 report.remainingGateDisabled=(await query(`SELECT count(*)::integer AS count FROM dispatch_sales_order_if_candidates c
  JOIN dispatch_effective_order_completion_events e ON e.id=c.completion_event_id WHERE c.status='gate_disabled'`)).rows[0].count;
 assert.equal(report.remainingGateDisabled,0);
 const statuses={};for(const order of report.fulfillments){statuses[order.status]=(statuses[order.status]||0)+1;}
 report.heldOrders=report.fulfillments.filter(order=>['waiting_evidence','attention'].includes(order.status));
 report.summary={completedCandidatesChecked:rows.length,fulfillmentStatuses:statuses,
  reconciledWithoutNewFulfillment:report.fulfillments.filter(order=>['reconciled','closed'].includes(order.status)&&!order.netsuite_transaction_id).length,
  heldOrders:report.heldOrders.length,completedDirectPoEventsChecked:report.receipts.length,
  verifiedNewFulfillments:report.verifiedTransactions.filter(tx=>tx.type==='IF').length,
  verifiedNewReceipts:report.verifiedTransactions.filter(tx=>tx.type==='IR').length,remainingGateDisabled:report.remainingGateDisabled,
  allFourGatesEnabled:true,netSuiteWrites:0};
 console.log(JSON.stringify(report));
}finally{await closeDb();}
