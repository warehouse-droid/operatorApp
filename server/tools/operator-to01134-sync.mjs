// Authorized accounting sync after the user completed TOB01134 in NetSuite.
import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {syncTargetedNetSuiteOrder} from '../src/targeted-order-sync.js';
import {upsertOutboundTransferOrders,upsertInboundTransferOrders,upsertOutboundTransferOrderLines,upsertInboundTransferOrderLines,markMissingOutboundOrderLines,markMissingInboundOrderLines} from '../src/order-sync-repository.js';
import {writeAudit} from '../src/auth-repository.js';
import {listReceivingOrders} from '../src/receiving-repository.js';
const normalized=value=>JSON.parse(JSON.stringify(value));
export async function syncCompletedTransfer(evidence) {
  assert.ok(Date.now()-new Date(evidence.at).valueOf()<15*60*1000);
  assert.equal(evidence.order.status,'G');assert.equal(evidence.order.tranid,'TOB01134');
  for(const line of evidence.receiving){assert.equal(Number(line.netsuite_received_qty),Number(line.quantity));}
  return withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");
    const order=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=1008202 FOR UPDATE')).rows[0];
    assert.equal(order.tranid,'TOB01134');
    assert.equal((await query("SELECT 1 FROM transfer_order_posting_jobs WHERE local_to_id=1008202 AND status<>'completed'")).rowCount,0);
    const sync=await syncTargetedNetSuiteOrder({orderRef:'TOB01134'},{
      findLocalOrder:async()=>order,fetchTransferOrder:async()=>evidence.order,
      fetchTransferOrderLines:async(_id,_yard,options)=>options.direction==='source'?evidence.outbound:evidence.receiving,
      upsertOutboundTransferOrders,upsertInboundTransferOrders,upsertOutboundTransferOrderLines,upsertInboundTransferOrderLines,
      markMissingOutboundOrderLines,markMissingInboundOrderLines,writeAudit,emitEvent:()=>{}
    });
    const last=evidence.receipts.find(row=>row.id===1053033);assert.equal(last.record.tranId,'IR15083');
    await query("UPDATE transfer_orders SET outbound_operator_status='loaded',receiving_status='received',local_yard_order_status='Received',fulfillment_status='fulfilled',last_item_receipt_id=$2,last_item_receipt_tranid=$3,status_updated_at=now() WHERE netsuite_id=$1",
      [1008202,last.id,last.record.tranId]);
    await writeAudit({actorType:'system',source:'admin',action:'operator.to.external_completion_synced',orderId:1008202,
      details:{orderRef:'TOB01134',netSuiteEvidenceAt:evidence.at,itemReceiptId:last.id,itemReceiptRef:last.record.tranId,
        receivingLines:evidence.receiving.map(line=>({sourceLineKey:line.line_id,itemId:line.item_id,quantity:line.quantity,unit:line.unit})),
        authorization:'User completed TOB01134 in NetSuite and requested this order sync.',netSuiteWrites:0,newPhysicalRecords:0}});
    const after={order:(await query('SELECT * FROM transfer_orders WHERE netsuite_id=1008202')).rows[0],
      lines:(await query('SELECT * FROM transfer_order_lines WHERE transfer_order_id=1008202 ORDER BY id')).rows,
      receipts:(await query('SELECT * FROM receiving_receipt_records WHERE order_id=1008202')).rows,
      loads:(await query('SELECT * FROM operator_load_records WHERE order_id=1008202')).rows,
      jobs:(await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=1008202')).rows};
    for(const key of ['receipts','loads','jobs']){assert.deepEqual(normalized(after[key]),evidence.before[key]);}
    const fields=['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','packed_sales_qty',
      'received_pallet_qty','received_layer_qty','received_section_qty','received_piece_qty','received_sales_qty',
      'loaded_qty','loaded_uom','confirmed','confirmed_at','confirmed_by'];
    for(const line of evidence.before.lines){
      const current=normalized(after.lines.find(row=>row.id===line.id));assert.ok(current);
      for(const key of fields){assert.equal(current[key],line[key],key);}
    }
    assert.ok(!(await listReceivingOrders({orderType:'transfer_order',destinationLocationId:1,search:'TOB01134'})).some(row=>row.tranid==='TOB01134'));
    return {sync,after,netSuiteWrites:0,newPhysicalRecords:0};
  });
}
