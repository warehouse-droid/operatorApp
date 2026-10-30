// @ts-check
import {query} from './db.js';
import {isFulfillableNetSuiteLine} from './netsuite-fulfillable-items.js';

/** @param {Record<string,any>} candidate */
export async function salesOrderLoadSource(candidate) {
  const result=await query(`SELECT load.id AS operator_load_record_id,load.order_ref,
    so.netsuite_id AS local_order_id,so.tranid AS local_order_ref,so.outbound_location_id,so.outbound_location,
    COALESCE(split.source_so_id,so.netsuite_id) AS source_order_id,
    COALESCE(split.source_so_ref,so.tranid) AS source_order_ref
    FROM operator_load_records load JOIN sales_orders so ON so.netsuite_id=load.order_id
    LEFT JOIN dispatch_scm_so_splits split ON split.split_so_id=so.netsuite_id AND split.status='active'
    WHERE load.id=$1 AND load.load_type='sales_order_delivery_load' AND load.order_family='sales_order'
      AND load.reload_cycle_id IS NULL AND COALESCE(split.source_so_id,so.netsuite_id)=$2`,
  [candidate.operator_load_record_id,candidate.source_sales_order_id]);
  return result.rows[0] || null;
}

/** @param {Record<string,any>} retained @param {Record<string,any>} line @param {Record<string,any>} source */
function assertSavedLoadIdentity(retained,line,source) {
  if((retained.orderLine !== undefined && Number(retained.orderLine)!==Number(line.source_order_line))
    || (retained.sourceLineId !== undefined && String(retained.sourceLineId)!==String(line.source_line_id))
    || (retained.locationId !== undefined && Number(retained.locationId)!==Number(line.location_id || source.outbound_location_id))) {
    throw new Error('The saved Operator load source line or yard changed.');
  }
}

/** Build only the exact saved load quantities, validating identity before use.
 * @param {Record<string,any>} row @param {Record<string,any>} source
 * @param {Record<string,any>[]} lines
 */
export function salesOrderLoadSnapshotLines(row,source,lines) {
  const saved=Array.isArray(row.operator_load_snapshot)?row.operator_load_snapshot:[];
  return saved.flatMap((/** @type {Record<string,any>} */ retained)=>{
    const amount=Number(retained.quantity);
    if(!Number.isFinite(amount) || amount<0) {throw new Error('The saved Operator load quantity is invalid.');}
    if(amount===0) {return [];}
    const matches=lines.filter(line=>String(line.local_order_line)===String(retained.lineId)
      && Number(line.item_id)===Number(retained.itemId));
    if(matches.length!==1) {throw new Error('The saved Operator load line no longer matches one source item.');}
    const line=matches[0];
    if(!isFulfillableNetSuiteLine(line)) {return [];}
    assertSavedLoadIdentity(retained,line,source);
    return [{localLineId:String(line.local_line_id),sourceLineId:String(line.source_line_id),
      orderLine:Number(line.source_order_line),itemId:Number(retained.itemId),
      location:Number(line.location_id || source.outbound_location_id),targetQuantity:amount,
      operatorLoadedQuantity:amount,operatorLoadRecordId:String(row.operator_load_record_id),
      completedPoQuantity:0,completedDirectToQuantity:0,poEvidence:[],toEvidence:[]}];
  });
}
