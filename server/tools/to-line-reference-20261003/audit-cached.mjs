import crypto from 'node:crypto';
import {query,closeDb} from '../../src/db.js';
import {transferPostingOrderLine} from '../../src/netsuite-transfer-posting-line.js';
try {
 const rows=(await query(`SELECT o.tranid,l.* FROM transfer_order_lines l JOIN transfer_orders o ON o.netsuite_id=l.transfer_order_id
  WHERE COALESCE(l.netsuite_active,true) AND l.line_stage IN ('outbound','receiving') AND l.item_type IN ('InvtPart','NonInvtPart')
  ORDER BY l.transfer_order_id,l.line_stage,l.id`)).rows;
 const mappings=[],missing=[],unresolved=[];
 for(const row of rows) {
  let evidence=row;
  if(Number(row.transfer_order_id)<0) {
   const mapped=(await query(`SELECT parent.* FROM dispatch_scm_to_split_lines ledger
    JOIN dispatch_scm_to_splits split ON split.id=ledger.split_id AND split.status='active'
    JOIN transfer_order_lines parent ON parent.id=ledger.source_line_id AND parent.line_stage=ledger.source_line_stage
      AND parent.transfer_order_id=split.source_to_id
    WHERE ledger.split_line_id=$1 AND ledger.split_line_stage=$2 AND split.split_to_id=$3`,[row.id,row.line_stage,row.transfer_order_id])).rows;
   if(mapped.length!==1||String(mapped[0].item_id)!==String(row.item_id)) {
    unresolved.push({order:row.tranid,lineId:row.id,error:'No unique active split-parent item mapping'});continue;
   }
   evidence=mapped[0];
  }
  if(!Array.isArray(evidence.raw?.physicalRows)){missing.push({order:row.tranid,lineId:row.id,sourceId:evidence.transfer_order_id});continue;}
  try{mappings.push({order:row.tranid,lineId:row.id,stage:row.line_stage,itemId:row.item_id,
   postingLine:transferPostingOrderLine(evidence,{sourceNetSuiteId:Number(evidence.transfer_order_id),stage:row.line_stage}),
   quantity:row.quantity,pallets:row.pallet_qty,pieces:row.piece_qty,packedPallets:row.packed_pallet_qty,packedPieces:row.packed_piece_qty,
   loaded:row.loaded_qty,split:Number(row.transfer_order_id)<0});}
  catch(error){unresolved.push({order:row.tranid,lineId:row.id,error:error.message});}
 }
 const quantities=rows.map(r=>[r.id,r.item_id,r.quantity,r.pallet_qty,r.piece_qty,r.packed_pallet_qty,r.packed_piece_qty,r.loaded_qty,r.received_pallet_qty,r.received_piece_qty]);
 const state=(await query("SELECT tranid,outbound_operator_status,fulfillment_status,receiving_status FROM transfer_orders WHERE tranid='TOB01189'")).rows[0];
 console.log(JSON.stringify({at:new Date().toISOString(),total:rows.length,verified:mappings.length,verifiedSplits:mappings.filter(m=>m.split).length,
  missing,unresolved,quantityHash:crypto.createHash('sha256').update(JSON.stringify(quantities)).digest('hex'),
  tob01189:mappings.filter(m=>m.order==='TOB01189'),state},null,2));
}finally{await closeDb();}
