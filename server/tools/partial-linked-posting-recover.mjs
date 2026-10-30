// Run through docker exec -i ... node --input-type=module; imports use the live runtime.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {createDirectPoSourceFetcher,prepareDirectPoReceiptJob} from '/app/src/direct-po-auto-receipt.js';
import {operatorNetSuitePostingRuntime} from '/app/src/operator-netsuite-posting-runtime.js';
import {fetchTransactionStatusFromNetSuite,fetchItemReceiptFromNetSuite} from '/app/src/netsuite.js';

const mode=process.env.PARTIAL_RECEIPT_MODE || 'inspect';
const targets=[{id:1082483,ref:'LOINC-040951',allocations:[[428,561981,92.31]],lines:[[1,92.31]],pallet:1},
  {id:1080498,ref:'LOINC-040807',allocations:[[426,560186,93],[427,560187,1]],lines:[[1,93],[2,1]],pallet:3}];
const fetchSource=createDirectPoSourceFetcher();
function summarize(source) {
  return {sourceNetSuiteId:source.sourceNetSuiteId,status:source.status,statusText:source.statusText,
    lines:source.lines.map(line=>({key:line.sourceLineKey,line:line.restOrderLine,item:line.itemId,unit:line.unit,
      ordered:line.orderedQuantity,received:line.completedQuantity,remaining:line.remainingQuantity,location:line.location}))};
}
try {
  const sources=[];
  for(const target of targets) {sources.push(await fetchSource({sourceOrderKind:'PO',sourceNetSuiteId:target.id}));}
  const sales=[];for(const id of [1082694,1068795]) {
    const header=await fetchTransactionStatusFromNetSuite(id,'SalesOrd');
    sales.push({id,status:header?.status,statusText:header?.statusText});
    assert(['F','G','H'].includes(header?.status),'Existing SO fulfillment must not be reposted');
  }
  console.log(JSON.stringify({event:'live-before',mode,sources:sources.map(summarize),sales}));
  if(mode==='recover') {
    const prepared=await withTransaction(async()=>{
      const jobs=[];
      for(const [index,target] of targets.entries()) {
        const order=(await query('SELECT dispatch_ref FROM purchase_orders WHERE netsuite_id=$1 FOR UPDATE',[target.id])).rows[0];
        assert.equal(order.dispatch_ref,target.ref);
        const allocations=(await query(`SELECT id,po_line_id,allocated_sales_qty FROM dispatch_so_po_allocations
          WHERE po_order_id=$1 AND status='active' ORDER BY id`,[target.id])).rows;
        assert.deepEqual(allocations.map(row=>[Number(row.id),Number(row.po_line_id),Number(row.allocated_sales_qty)]),target.allocations);
        const live=sources[index];
        for(const [line,amount] of target.lines) {
          const current=live.lines.find(row=>Number(row.restOrderLine)===line);
          assert.equal(current?.itemId,2055);assert(Math.abs(current.remainingQuantity-amount)<0.01);
        }
        assert.equal(live.lines.find(row=>Number(row.itemId)===1784)?.remainingQuantity,target.pallet);
        const job=(await query(`INSERT INTO dispatch_direct_po_ir_jobs(local_po_id,delivery_job_record_id,allocation_scoped)
          VALUES($1,7300,true) ON CONFLICT(local_po_id,delivery_job_record_id) WHERE allocation_scoped
          DO UPDATE SET updated_at=dispatch_direct_po_ir_jobs.updated_at RETURNING id`,[target.id])).rows[0];
        const ready=await prepareDirectPoReceiptJob(job.id,{fetchSource:async()=>sources[index]});
        assert(ready?.command,'Receipt must be admitted through the durable posting pipeline');
        const items=ready.command.steps.flatMap(step=>step.payload.item.items).filter(item=>item.itemReceive);
        assert.equal(items.length,target.lines.length);
        for(const [line,amount] of target.lines) {
          assert(Math.abs(items.find(item=>Number(item.orderLine)===line)?.quantity-amount)<0.01);
        }
        assert.equal(ready.command.inputSnapshot.directDeliveryEvidence.deliveryJobRecordId,7300);
        jobs.push({po:target.id,jobId:job.id,commandId:ready.command.id,
          evidence:ready.command.inputSnapshot.directDeliveryEvidence,payload:ready.command.steps.map(step=>step.payload)});
      }
      console.log(JSON.stringify({event:'admitted',jobs}));return jobs;
    });
    for(const job of prepared) {await operatorNetSuitePostingRuntime.enqueue(job.commandId);}
    for(let attempt=0;attempt<30;attempt++) {
      const pending=(await query(`SELECT c.id FROM operator_netsuite_posting_commands c JOIN dispatch_direct_po_ir_jobs j ON j.command_id=c.id
        WHERE j.local_po_id=ANY($1::bigint[]) AND c.status IN('queued','posting','finalizing','retry_wait')`,[targets.map(target=>target.id)])).rowCount;
      if(!pending) {break;}await delay(1000);
    }
  }
  if(['recover','verify'].includes(mode)) {
    const rows=(await query(`SELECT j.local_po_id,j.id AS job_id,j.status AS job_status,c.id AS command_id,c.status,c.last_error,
      s.netsuite_transaction_id,s.netsuite_transaction_ref,s.payload,po.receipt_status
      FROM dispatch_direct_po_ir_jobs j JOIN operator_netsuite_posting_commands c ON c.id=j.command_id
      JOIN operator_netsuite_posting_steps s ON s.command_id=c.id JOIN purchase_orders po ON po.netsuite_id=j.local_po_id
      WHERE j.local_po_id=ANY($1::bigint[]) ORDER BY j.local_po_id`,[targets.map(target=>target.id)])).rows;
    console.log(JSON.stringify({event:'local-after',rows}));
    assert.equal(rows.length,2);
    for(const row of rows) {
      assert.equal(row.status,'completed',row.last_error);assert.equal(row.receipt_status,'partial_received');
      const receipt=await fetchItemReceiptFromNetSuite(row.netsuite_transaction_id);
      const lines=(receipt.item?.items||[]).filter(line=>line.itemReceive!==false && Number(line.quantity)>0);
      assert(lines.every(line=>Number(line.item?.id)===2055),'An unallocated pallet must not be received');
      console.log(JSON.stringify({event:'verified-receipt',po:row.local_po_id,id:receipt.id,tranid:receipt.tranId,
        createdFrom:receipt.createdFrom,lines:lines.map(line=>({line:line.orderLine,item:line.item?.id,quantity:line.quantity,units:line.units}))}));
      console.log(JSON.stringify({event:'live-after',po:row.local_po_id,source:summarize(await fetchSource({sourceOrderKind:'PO',sourceNetSuiteId:Number(row.local_po_id)}))}));
    }
  }
} finally {await closeDb();}
