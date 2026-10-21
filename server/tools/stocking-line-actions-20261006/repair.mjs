import assert from 'node:assert/strict';
import {query,withTransaction} from '../../src/db.js';
import {lockPurchaseStock} from '../../src/regular-stock-purchase-repository.js';

export async function repairStockingResolutionScope(input,{rollback=false}={}) {
  const {requestId,requestRef,lineName,expectedRevision,purchaseOrderRef,eta}=input;
  return withTransaction(async()=>{
    await lockPurchaseStock();
    const row=(await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    assert.equal(row?.request_ref,requestRef);assert.equal(row.request_type,'regular');assert.equal(row.workflow_version,2);
    assert.equal(row.regular_details.deliveryMethod,'stocking');
    const lines=(await query('SELECT * FROM sales_stock_request_lines WHERE request_id=$1 ORDER BY id FOR UPDATE',[requestId])).rows;
    const matches=lines.filter(line=>line.item_name===lineName);assert.equal(matches.length,1);assert.equal(lines.length,4);
    const target=matches[0],others=lines.filter(line=>line.id!==target.id),existing=row.regular_details.stockingLines?.[target.id]?.resolution;
    if(existing?.purchaseOrderRef===purchaseOrderRef&&existing.eta===eta&&target.status==='closed'&&others.every(line=>line.status==='submitted')&&!row.regular_details.resolution) {
      return {changed:false,requestId,targetLineId:Number(target.id),pendingLineIds:others.map(line=>Number(line.id))};
    }
    assert.equal(row.revision,expectedRevision);assert.equal(row.status,'completed');
    const resolution=row.regular_details.resolution;assert.equal(resolution?.purchaseOrderRef,purchaseOrderRef);assert.equal(resolution.eta,eta);
    assert.ok(lines.every(line=>line.status==='closed'&&line.regular_decision==='po'&&line.decision_reason===`Resolved with ${purchaseOrderRef}; ETA ${eta}.`));
    const original=(await query("SELECT * FROM sales_stock_request_events WHERE id=$1 AND request_id=$2 AND event_type='regular_manual_decision' AND request_line_id IS NULL",[row.manual_decision_event_id,requestId])).rows[0];
    assert.equal(original?.details.decision,'resolve');assert.equal(original.details.purchaseOrderRef,purchaseOrderRef);assert.equal(original.details.eta,eta);
    const commitments=await query(`SELECT 1 FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.request_id=$1
      UNION ALL SELECT 1 FROM sales_stock_transfers WHERE request_id=$1 UNION ALL SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1 LIMIT 1`,[requestId]);
    assert.equal(commitments.rowCount,0,'The request acquired purchasing/transfer commitments');
    await query("UPDATE sales_stock_request_lines SET status='submitted',regular_decision=NULL,decision_reason='',decided_by=NULL,decided_at=NULL,updated_at=now() WHERE id=ANY($1::bigint[])",[others.map(line=>line.id)]);
    const details={decision:'resolve',lineId:Number(target.id),itemName:target.item_name,...resolution,correctionOfEventId:Number(original.id),
      pendingLineIds:others.map(line=>Number(line.id)),reason:'User clarified that the saved PO and ETA apply only to this material.'};
    const event=(await query("INSERT INTO sales_stock_request_events(request_id,request_line_id,event_type,details) VALUES($1,$2,'regular_manual_decision',$3::jsonb) RETURNING id",[requestId,target.id,JSON.stringify(details)])).rows[0];
    const regular={...row.regular_details,stockingLines:{...row.regular_details.stockingLines,[target.id]:{resolution,replyStatus:null}},replyStatus:null};delete regular.resolution;
    await query("UPDATE sales_stock_requests SET status='active',revision=revision+1,regular_details=$2::jsonb,manual_decision_event_id=$3,updated_at=now() WHERE id=$1",[requestId,JSON.stringify(regular),event.id]);
    return {changed:true,requestId,revision:expectedRevision+1,targetLineId:Number(target.id),pendingLineIds:others.map(line=>Number(line.id)),correctionEventId:Number(event.id),resolution};
  },{rollback});
}
