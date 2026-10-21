import assert from 'node:assert/strict';
import fs from 'node:fs';
import {verifyReviewedExisting} from './verify-reviewed-existing.mjs';
const b=JSON.parse(fs.readFileSync(0,'utf8'));
const {inventory,sources,remote,linked,local}=b;
const cases=[];
for(const command of inventory.native) {
 const step=command.steps[0],record=remote.results.find(r=>r.id===command.id)?.record;
 const order=local.orders.find(o=>Number(o.netsuite_id)===step.sourceNetSuiteId);
 const confirmed=(order?.lines||[]).filter(l=>l.item_type==='NonInvtPart'&&l.confirmed===true&&Number(l.packed_sales_qty)===Number(l.quantity)).map(l=>String(l.line_id));
 const proof=verifyReviewedExisting({step,record:{...record,transactionType:'IF'},sourceLines:sources.lines,allowLegacyBase:true,confirmedExtraLines:confirmed});
 cases.push({queue:'native',id:command.id,reference:step.sourceOrderRef,sourceId:step.sourceNetSuiteId,
  expectedUpdatedAt:command.updatedAt,inputHash:command.inputHash,status:'recover_existing',...proof});
}
for(const candidate of inventory.sales) {
 const ref=candidate.dispatchOrderRef;
 const localOrder=sources.local.find(o=>o.tranid===ref);
 const split=sources.localSplits.find(s=>s.split_so_ref===ref);
 const event=local.events.find(e=>e.event.id===Number(candidate.completionEventId));
 const driver=(event?.driver_job?.job_details?.orders||[]).filter(o=>o.orderRef===ref&&Number(o.orderId)>0);
 const sourceId=Number(candidate.sourceSalesOrderId||split?.source_so_id||localOrder?.netsuite_id||driver[0]?.orderId);
 const header=sources.headers.find(h=>Number(h.id)===sourceId);
 const entry={queue:'sales',id:candidate.id,reference:ref,sourceId,sourceRef:header?.tranid,
  expectedStatus:candidate.status,expectedUpdatedAt:candidate.updatedAt,snapshotHash:candidate.snapshotHash};
 if(candidate.status==='uncertain') {
  const record=remote.results.find(r=>r.id===candidate.id)?.record;
  const confirmed=sources.lines.filter(s=>Number(s.source_id)===sourceId&&s.item_type==='NonInvtPart'&&/^Sales Credit|^Delivery Charge/i.test(s.item_name)).map(s=>String(s.source_line_key));
  for(const a of local.allocations) {
   if(a.allocation.sales_order_ref!==ref)continue;
   const delivered=a.execution?.find(e=>e.phase==='delivered'&&e.driver_job_id===candidate.completionEvidenceId);
   const pickup=a.execution?.find(e=>e.phase==='pickup'&&e.load_id===delivered?.load_id&&e.plan_id===delivered?.plan_id);
   const line=local.orders.find(o=>o.tranid===ref)?.lines.find(l=>l.id===a.allocation.sales_line_id);
   if(delivered&&pickup&&line&&Number(a.allocation.allocated_sales_qty)===Number(line.quantity))confirmed.push(String(line.line_id));
  }
  const step={sourceOrderKind:'SO',transactionType:'IF',sourceNetSuiteId:sourceId,externalId:candidate.externalId,
    payload:candidate.payload,lineSnapshot:candidate.lineSnapshot};
  const proof=verifyReviewedExisting({step,record:{...record,transactionType:'IF'},sourceLines:sources.lines,confirmedExtraLines:confirmed});
  cases.push({...entry,status:'recover_existing',...proof});continue;
 }
 if(!header){cases.push({...entry,status:'unresolved_source'});continue;}
 const lines=sources.lines.filter(l=>Number(l.source_id)===sourceId);
 const physical=lines.filter(l=>['InvtPart','NonInvtPart'].includes(l.item_type)&&l.is_fulfillable==='T'&&!/^Sales Credit|^Delivery Charge/i.test(l.item_name)&&l.is_closed!=='T'&&Math.abs(Number(l.quantity))>0);
 const remaining=physical.filter(l=>Math.abs(Number(l.quantity))-Number(l.fulfilled_quantity)>0.000001);
 const ids=[...new Set(sources.linked.filter(l=>Number(l.source_id)===sourceId).map(l=>Number(l.id)))];
 const records=ids.map(id=>linked.results.find(r=>r.id===id));
 assert.ok(records.every(r=>r?.record),'Every linked IF/IR must be read');
 for(const result of records) {
  assert.equal(Number(result.record.createdFrom?.id),sourceId,'Linked source identity');
  assert.equal(result.record.tranId,result.reference,'Linked reference identity');
 }
 entry.remoteRecords=records.map(r=>({id:r.id,reference:r.reference,type:r.type,lastModified:r.record.lastModifiedDate}));
 entry.sourceStatus=header.status;entry.remaining=remaining.map(l=>({orderLine:Number(l.order_line),sourceLineKey:l.source_line_key,
  itemId:Number(l.item_id),quantity:(Math.abs(Number(l.quantity))-Number(l.fulfilled_quantity))/(Number(l.conversion_rate)||1),unit:l.unit,locationId:Number(l.location_id)}));
 if(['F','G'].includes(header.status)&&!remaining.length) {
  for(const line of physical) {
   // Kit member movements are represented in authoritative transaction links,
   // while REST exposes their parent kit. Compare base units at this boundary.
   const movements=[...new Map(sources.linked.filter(l=>Number(l.source_id)===sourceId&&Number(l.source_line)===Number(line.order_line)
     &&Number(l.item_id)===Number(line.item_id)&&l.type==='ItemShip').map(l=>[`${l.id}:${l.transaction_line}`,l])).values()];
   const total=movements.reduce((sum,l)=>sum+Math.abs(Number(l.quantity)),0);
   assert.ok(total+0.000001>=Math.abs(Number(line.quantity)),`Existing IF total ${ref} line ${line.order_line}`);
  }
  cases.push({...entry,status:physical.length?'reconcile_fulfilled':'skip_nonfulfillable'});
 }else if(candidate.lastError==='A valid numeric NetSuite sales order ID is required.') {
  cases.push({...entry,status:'restore_waiting'});
 }else cases.push({...entry,status:'review_remaining'});
}
console.log(JSON.stringify({at:new Date().toISOString(),cases},null,2));
