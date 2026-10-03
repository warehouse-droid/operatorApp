import {createHash} from 'node:crypto';
import {query,withTransaction} from './db.js';
import {inventoryError,inventoryId} from './inventory-workflow-domain.js';
import {validateRows} from './count-sheet-stock-refresh.js';
import {packedInventorySnapshot} from './inventory-packed-stock.js';

export async function countSheetReconstructionState(sheetId,{lock=false}={}) {
  const sheet=(await query(`SELECT * FROM inventory_count_sheets WHERE id=$1 ${lock?'FOR UPDATE':''}`,[inventoryId(sheetId)])).rows[0];
  if(!sheet) {throw inventoryError('Reconstruction target not found.',404);}
  const items=(await query('SELECT to_jsonb(c) AS count FROM inventory_count_sheet_counts c WHERE sheet_id=$1 AND attempt=$2 ORDER BY item_id',[sheet.id,sheet.attempt])).rows.map(row=>row.count);
  const assigned=(await query('SELECT item_id FROM inventory_count_sheet_items WHERE sheet_id=$1 ORDER BY item_id',[sheet.id])).rows.map(row=>Number(row.item_id));
  const fingerprint=createHash('sha256').update(JSON.stringify({sheet,items,assigned})).digest('hex');
  return {sheet,items,assigned,fingerprint};
}

// Maintenance-only operation. Callers must review a preview fingerprint first;
// there is no HTTP route that can rewrite submitted count comparisons.
export async function reconstructCountSheetComparison({sheetId,expectedTitle,expectedFingerprint,balances,observedAt,rollback=false}) {
  if(!Number.isFinite(new Date(observedAt).getTime())) {throw inventoryError('A valid stock observation time is required.');}
  return withTransaction(async()=>{
    const state=await countSheetReconstructionState(sheetId,{lock:true}),{sheet,items,assigned}=state;
    if(sheet.title!==expectedTitle) {throw inventoryError('Reconstruction target does not match.',409);}
    if(sheet.status!=='submitted') {throw inventoryError('Only submitted sheets can be reconstructed.',409);}
    if(state.fingerprint!==expectedFingerprint) {throw inventoryError('The sheet changed after the reconstruction preview.',409);}
    if(items.length!==assigned.length || !assigned.length) {throw inventoryError('Every assigned SKU needs a recorded count.',409);}
    validateRows(balances,assigned,Number(sheet.location_id));
    const packed=await packedInventorySnapshot(assigned,Number(sheet.location_id));
    for(const count of items) {
      const balance=balances.find(row=>Number(row.item_id)===Number(count.item_id));
      await query(`UPDATE inventory_count_sheet_counts SET system_on_hand=$4,system_available=$5,
        packed_qty=$6,actual_on_hand=$4::numeric-$6::numeric,variance=quantity-($4::numeric-$6::numeric),
        inventory_synced_at=$7,packed_snapshot_at=clock_timestamp(),comparison_basis='reconstructed_current'
        WHERE sheet_id=$1 AND attempt=$2 AND item_id=$3`,
      [sheet.id,sheet.attempt,count.item_id,balance.quantity_on_hand,balance.quantity_available,packed.get(Number(count.item_id)).quantity,observedAt]);
    }
    const after=await countSheetReconstructionState(sheet.id);
    await query(`INSERT INTO inventory_count_sheet_events(sheet_id,actor_id,action,attempt,details)
      VALUES($1,NULL,'comparison_reconstructed',$2,$3)`,[sheet.id,sheet.attempt,JSON.stringify({
      basis:'current_stock',observedAt,previousFingerprint:state.fingerprint,before:items,after:after.items,
      packedSources:Object.fromEntries(packed),reason:'Requested reconstruction: actual on hand = on hand - packed; variance = counted - actual on hand.'
    })]);
    await query('UPDATE inventory_count_sheets SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[sheet.id]);
    return {...after,rollback};
  },{rollback});
}
