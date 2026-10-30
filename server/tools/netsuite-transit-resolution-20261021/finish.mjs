// Exact existing-receipt linkage for the two displayed stale transit rows.
// No posting adapters; external requests below are GETs only.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {fetchItemReceiptFromNetSuite,fetchPoToReconciliationOrdersFromNetSuite} from './src/netsuite.js';
import {writeAudit} from './src/auth-repository.js';
import {updatePurchaseOrderNetSuiteStatus,updateTransferOrderNetSuiteStatus} from './src/order-sync-repository.js';
import {reconcileScmOrderFamily} from './src/scm-reconciliation-repository.js';
import {getIfirPostingRestletEnabled} from './src/netsuite-ifir-posting-policy.js';
const actor='maintenance:netsuite-transit-resolution-20261021';
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
const equalQty=(a,b)=>Math.abs(Number(a)-Number(b))<0.000001;
const only=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
let po=ORDERS.find(o=>o.id===1049528),to=ORDERS.find(o=>o.id===1053303);
const originals=new Map(RECEIPTS.map(e=>[e.id,e.record]));
const records=new Map();

function verifyReceipt(record,order,ref,rows) {
  assert.equal(record.tranId,ref);assert.equal(Number(record.createdFrom.id),order.id);
  assert.equal(record.lastModifiedDate,originals.get(Number(record.id)).lastModifiedDate,'Receipt changed after review.');
  const received=record.item.items.filter(l=>l.itemReceive!==false&&Number(l.quantity)>0);
  assert.equal(received.length,rows.length,'The complete existing receipt must match the reviewed local target.');
  for(const row of rows) {
    const source=only(order.lines.filter(l=>l.stage==='receiving'&&String(l.sourceLineKey)===String(row.line_id)),'Exact source line');
    assert.equal(Number(row.item_id),source.itemId);assert.equal(row.unit,source.unit);
    assert.ok(equalQty(row.quantity,source.quantity));assert.ok(equalQty(source.quantity,source.cumulativeProgressQuantity));
    const line=only(received.filter(l=>Number(l.orderLine)===Number(source.orderLine)),'Exact existing receipt order line');
    assert.equal(Number(line.item.id),source.itemId);assert.ok(equalQty(line.quantity,row.quantity));
    assert.equal(line.unitsDisplay,row.unit);assert.equal(Number(line.location.id),Number(row.location_id));
    assert.equal(Number(line.orderDoc.id),order.id);
  }
}

try {
  assert.equal(await getIfirPostingRestletEnabled(),false);
  const fresh=await fetchPoToReconciliationOrdersFromNetSuite({orderIds:[po.id,to.id],targetOnly:true,includeOpen:false});
  po=only(fresh.filter(o=>o.id===1049528),'Current source PO');
  to=only(fresh.filter(o=>o.id===1053303),'Current source TO');
  assert.equal(po.status,'F');assert.equal(to.status,'G');
  emit({event:'fresh-sources',orders:fresh});
  for(const id of [1071884,1070038]) {
    const record=await fetchItemReceiptFromNetSuite(id);assert.ok(record);
    records.set(id,record);emit({event:'fresh-existing-receipt',record});
  }
  const result=await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='15s'");
    await query("SET LOCAL statement_timeout='60s'");
    const split=only((await query("SELECT * FROM dispatch_scm_po_splits WHERE id=364 AND status='active' FOR UPDATE")).rows,'Expected active PO split');
    assert.equal(Number(split.source_po_id),po.id);assert.equal(Number(split.split_po_id),-91036187827305);
    assert.equal(split.split_po_ref,'LOINC-039408');assert.equal(String(split.revision),'1');
    const child=only((await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1 FOR UPDATE',[split.split_po_id])).rows,'PO split mirror');
    const childLines=(await query('SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1 AND netsuite_active FOR UPDATE',[split.split_po_id])).rows;
    verifyReceipt(records.get(1071884),po,'IR15167',childLines);
    const ledger=(await query('SELECT * FROM dispatch_scm_po_split_lines WHERE split_id=364 ORDER BY id FOR UPDATE')).rows;
    assert.deepEqual(JSON.parse(JSON.stringify(ledger)),BASELINE.splitLines,'Split ledger must remain unchanged.');
    for(const line of childLines) {
      const original=BEFORE.evidence.purchaseLines.find(l=>l.id===line.id);assert.ok(original);
      for(const key of ['quantity','line_id','item_id','unit','location_id']) assert.equal(line[key],original[key]);
      const link=only(ledger.filter(l=>l.split_line_id===line.id),'Exact split ledger');
      const source=only(BEFORE.evidence.purchaseLines.filter(l=>l.id===link.source_line_id),'Original source line');
      assert.equal(source.line_id,line.line_id);assert.ok(equalQty(link.sales_qty,line.quantity));
      assert.ok(Number(line.netsuite_received_qty)<=Number(line.quantity));
    }
    assert.ok(child.last_item_receipt_id===null||Number(child.last_item_receipt_id)===1071884);
    const schedule=only((await query("SELECT * FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref='LOINC-039408' FOR UPDATE")).rows,'PO schedule');
    const originalSchedule=BASELINE.storedSchedule.find(s=>s.id===schedule.id);
    assert.equal(schedule.status,originalSchedule.status);
    assert.equal(schedule.updated_at.toISOString(),originalSchedule.updated_at,'Concurrent schedule change');
    for(const line of childLines) await query('UPDATE purchase_order_lines SET netsuite_received_qty=quantity,synced_at=now() WHERE id=$1',[line.id]);
    await query(`UPDATE purchase_orders SET receipt_status='received',last_item_receipt_id=1071884,last_item_receipt_tranid='IR15167',
      received_at=COALESCE(received_at,$2::date),status_updated_at=now() WHERE netsuite_id=$1`,[split.split_po_id,records.get(1071884).tranDate]);
    await updatePurchaseOrderNetSuiteStatus(split.split_po_id,{status:po.status,statusText:po.statusText});
    // Saved Queued is normally an intentional manual override. The user's
    // requested completion is supported here by exact full split IR coverage.
    await query(`UPDATE scm_transport_schedule SET status='Completed',updated_by=$1,updated_at=clock_timestamp()
      WHERE id=$2 AND status=$3`,[actor,schedule.id,schedule.status]);
    const reconciledPo=await reconcileScmOrderFamily({kind:'PO',sourceOrderId:po.id,source:'manual',authoritativeOrder:po});
    assert.equal(reconciledPo.applicationStatus,'Completed');assert.equal(reconciledPo.reconciliationStatus,'ok');
    assert.equal(reconciledPo.targets['LOINC-039408'].applicationStatus,'Completed');
    assert.ok(equalQty(reconciledPo.targets['LOINC-039408'].received,954.73));
    assert.equal(reconciledPo.targets['LOINC-039408'].destinationRemaining,0);
    await writeAudit({actorType:'system',source:'admin',action:'netsuite.transit.existing_receipt_linked',orderId:split.split_po_id,
      details:{actor,reason:'User requested resolving in-transit PO/TO; exact existing IR covers the full split at its confirmed destination.',
        postingAttempted:false,sourceOrder:po.tranid,receiptId:1071884,receiptRef:'IR15167',before:{child,childLines,schedule,ledger},reconciliation:reconciledPo}});

    const transfer=only((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1 FOR UPDATE',[to.id])).rows,'TO mirror');
    assert.equal(transfer.status,'G');assert.ok(transfer.last_item_receipt_id===null||Number(transfer.last_item_receipt_id)===1070038);
    const transferLines=(await query("SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving' AND netsuite_active FOR UPDATE",[to.id])).rows;
    verifyReceipt(records.get(1070038),to,'IR15159',transferLines);
    for(const line of transferLines) await query("UPDATE transfer_order_lines SET netsuite_received_qty=quantity,synced_at=now() WHERE id=$1 AND line_stage='receiving'",[line.id]);
    await query(`UPDATE transfer_orders SET receiving_status='received',last_item_receipt_id=1070038,last_item_receipt_tranid='IR15159',
      received_at=COALESCE(received_at,$2::date),status_updated_at=now() WHERE netsuite_id=$1`,[to.id,records.get(1070038).tranDate]);
    await updateTransferOrderNetSuiteStatus(to.id,{status:to.status,statusText:to.statusText});
    await writeAudit({actorType:'system',source:'admin',action:'netsuite.transit.existing_receipt_linked',orderId:to.id,
      details:{actor,postingAttempted:false,sourceOrder:to.tranid,receiptId:1070038,receiptRef:'IR15159',before:{transfer,transferLines}}});
    return {purchase:{ref:split.split_po_ref,receipt:'IR15167',reconciliation:reconciledPo},transfer:{ref:to.tranid,receipt:'IR15159'}};
  },{rollback:MODE==='rehearse'});
  emit({event:MODE==='rehearse'?'rolled-back':'applied',result});
  assert.equal(await getIfirPostingRestletEnabled(),false);
} finally {await closeDb();}
