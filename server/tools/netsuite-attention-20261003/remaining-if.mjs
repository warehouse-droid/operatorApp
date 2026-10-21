// One reviewed remaining line, with a durable snapshot and normal worker lease.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite,findOperatorNetSuitePostingTransactionByExternalId} from '../../src/netsuite.js';
import {fetchLiveSalesOrderAutoFulfillmentState} from '../../src/sales-order-auto-fulfillment-netsuite-adapter.js';
import {buildSalesOrderCompletionSnapshot,buildSalesOrderItemFulfillmentPayload} from '../../src/sales-order-auto-fulfillment-domain.js';
import {getSalesOrderAutoFulfillmentCandidate} from '../../src/sales-order-auto-fulfillment-repository.js';
import {enqueueSalesOrderAutoFulfillmentCandidate} from '../../src/sales-order-auto-fulfillment-runtime.js';
const id='f7d86119-7b12-4f1d-9ab7-2dc56ac5196a',sourceId=990873,reference='SOA08709';
const reason='User requested resolving all fulfillment attention after verifying existing IF/IR. IF154003 covers earlier lines; exactly 10 PC on source line 12 remain, matching immutable Operator load 1170 and effective Driver drop-off. Fulfill only that verified remainder.';
try {
 const candidate=await getSalesOrderAutoFulfillmentCandidate(id);
 assert.equal(candidate.dispatchOrderRef,reference);assert.equal(candidate.status,'attention');assert.equal(candidate.attemptCount,0);
 const evidence=(await query(`SELECT e.id,e.plan_id,e.load_id,j.stop_type,j.status,j.completed_at,j.job_details
  FROM dispatch_effective_order_completion_events e JOIN driver_job_records j ON j.job_id=e.completion_evidence_id
  WHERE e.id=$1 AND e.order_ref=$2 AND j.plan_id=e.plan_id AND j.load_id=e.load_id`,[candidate.completionEventId,reference])).rows;
 assert.equal(evidence.length,1);const driver=evidence[0];assert.equal(driver.stop_type,'dropoff');assert.equal(driver.status,'complete');assert.ok(driver.completed_at);
 const delivered=driver.job_details.orders.filter(o=>o.orderRef===reference&&Number(o.orderId)===sourceId);
 assert.equal(delivered.length,1);
 assert.equal(delivered[0].items.filter(i=>i.sku==='PER-MEL60-COP-SCG'&&i.units.length===1&&i.units[0].unit==='PCS'&&i.units[0].value===10).length,1);
 const record=(await query(`SELECT * FROM operator_load_records WHERE id=1170 AND order_id=$1 AND order_ref=$2 AND load_type='sales_order_delivery_load'`,[sourceId,reference])).rows[0];assert.ok(record);
 const loaded=record.line_snapshot.filter(l=>String(l.lineId)==='4955112');assert.equal(loaded.length,1);
 assert.equal(Number(loaded[0].itemId),5056);assert.equal(loaded[0].loadedQty,10);assert.equal(loaded[0].loadedUom,'PC');
 const line=(await query(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=4955112 AND item_id=5056`,[sourceId])).rows;
 assert.equal(line.length,1);assert.equal(Number(line[0].netsuite_order_line),12);assert.equal(Number(line[0].location_id),28);
 const snapshot=buildSalesOrderCompletionSnapshot({candidateId:id,dispatchOrderRef:reference,sourceSalesOrderId:sourceId,
  sourceSalesOrderRef:reference,locationId:28,lines:[{localLineId:String(line[0].id),sourceLineId:String(line[0].id),
   orderLine:12,itemId:5056,location:28,targetQuantity:10,operatorLoadedQuantity:10,operatorLoadRecordId:'1170',
   completedPoQuantity:0,completedDirectToQuantity:0,poEvidence:[],toEvidence:[]}]});
 const prepared={...candidate,sourceSalesOrderId:sourceId,sourceSalesOrderRef:reference,canonicalLocationId:28,lineSnapshot:snapshot.lines};
 const existing=await findOperatorNetSuitePostingTransactionByExternalId(candidate.externalId,'IF',sourceId,{direct:true});
 assert.equal(existing,null,'An existing candidate IF must be recovered instead of creating another');
 const links=await suiteqlAll(`SELECT link.previousline AS source_line,t.id,t.tranid,tl.item,tl.quantity
  FROM NextTransactionLineLink link JOIN transaction t ON t.id=link.nextdoc
  JOIN transactionline tl ON tl.transaction=t.id AND tl.id=link.nextline
  WHERE link.previousdoc=${sourceId} AND t.type='ItemShip' AND tl.item IS NOT NULL`);
 assert.ok(links.length>0);assert.ok(!links.some(l=>Number(l.source_line)===12&&Math.abs(Number(l.quantity))>0),'Remaining line already has an IF movement');
 const existingRecords=[];
 for(const linkedId of new Set(links.map(l=>Number(l.id)))) {
  const remote=await fetchItemFulfillmentFromNetSuite(linkedId);assert.equal(Number(remote.createdFrom.id),sourceId);
  existingRecords.push({id:linkedId,reference:remote.tranId});
 }
 const live=await fetchLiveSalesOrderAutoFulfillmentState(prepared);
 const remaining=live.lines.filter(l=>l.remainingQuantity>0.000001);
 assert.equal(remaining.length,1);assert.equal(remaining[0].orderLine,12);assert.equal(remaining[0].itemId,5056);
 assert.equal(remaining[0].remainingQuantity,10);assert.equal(remaining[0].location,28);
 const payload=buildSalesOrderItemFulfillmentPayload({selectedLines:[{orderLine:12,itemId:5056,quantity:10,location:28}],
  availableLines:[...live.lines,...(live.excludedLines||[])],externalId:candidate.externalId});
 const proof={at:new Date().toISOString(),sourceId,reference,loadRecordId:1170,completionEventId:candidate.completionEventId,existingRecords,remaining,snapshot,payload};
 if(!APPLY){console.log(JSON.stringify({apply:false,proof},null,2));}
 else {
  await withTransaction(async()=>{
   const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1 FOR UPDATE',[id])).rows[0];
   assert.equal(row.status,'attention');assert.equal(row.attempt_count,0);assert.equal(row.updated_at.toISOString(),new Date(candidate.updatedAt).toISOString());
   const gate=(await query(`SELECT f.revision,w.activation_event_id FROM mbt_feature_flags f
    JOIN dispatch_sales_order_if_gate_watermarks w ON w.gate_key=f.flag_key
    WHERE f.flag_key='dispatch_netsuite_sales_order_if_2967' AND f.enabled FOR SHARE OF f,w`)).rows[0];assert.ok(gate);
   await query(`INSERT INTO dispatch_sales_order_if_line_claims(candidate_id,source_sales_order_id,source_line_id,order_line,claimed_quantity)
    VALUES($1,$2,$3,12,10)`,[id,sourceId,line[0].id]);
   await query(`UPDATE dispatch_sales_order_if_candidates SET status='queued',source_sales_order_id=$2,source_sales_order_ref=$3,
    canonical_location_id=28,gate_key='dispatch_netsuite_sales_order_if_2967',gate_revision=$4,activation_event_id=$5,
    snapshot_hash=$6,line_snapshot=$7::jsonb,resolution_action='custom',resolution_lines='[{"orderLine":12,"quantity":10}]',
    resolution_reason=$8,resolved_by='maintenance:netsuite-attention-20261003',resolved_at=now(),last_error=NULL,updated_at=now()
    WHERE id=$1`,[id,sourceId,reference,gate.revision,gate.activation_event_id,snapshot.snapshotHash,JSON.stringify(snapshot.lines),reason]);
   await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
    VALUES($1,'admin_custom_verified_remaining','maintenance:netsuite-attention-20261003',$2,$3::jsonb)`,[id,reason,JSON.stringify(proof)]);
  });
  const result=await enqueueSalesOrderAutoFulfillmentCandidate(id);
  console.log(JSON.stringify({apply:true,proof,result},null,2));
 }
}finally{await closeDb();}
