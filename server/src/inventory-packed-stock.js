import {query} from './db.js';
import {netSuiteClosedOrderFamilySql} from './netsuite-closed-order-policy.js';

const positive=value=>Math.max(0,Number(value)||0);
const round=value=>Number(value.toFixed(6));
const units=[['pallet','plt'],['layer','lyr'],['section','sec'],['piece','pcs']];

export function packedStockQuantity(line) {
  const converted=units.some(([,factor])=>positive(line[`to_${factor}`])>0);
  const physical=prefix=>units.reduce((sum,[unit,factor])=>sum+positive(line[`${prefix}_${unit}_qty`])*positive(line[`to_${factor}`]),0);
  const legacy=prefix=>['piece','section','layer','pallet'].map(unit=>positive(line[`${prefix}_${unit}_qty`])).find(Boolean)||0;
  const salesOnly=String(line.sku||line.item_name||'').toUpperCase()==='PALLET' || !units.some(([unit])=>positive(line[`${unit}_qty`])>0);
  const packed=converted ? physical('packed') : positive(line.packed_sales_qty) || (salesOnly ? legacy('packed') : 0);
  const fulfilled=converted ? physical('fulfilled') : salesOnly ? legacy('fulfilled') : 0;
  // Local loads clear packed fields. Only fulfillment without a corresponding
  // local load can still be included in the current packing snapshot.
  return round(Math.max(0,packed-Math.max(0,fulfilled-positive(line.loaded_qty))));
}

export async function packedInventorySnapshot(itemIds,locationId) {
  const result=new Map(itemIds.map(id=>[Number(id),{quantity:0,lines:[]}]));
  const yardCode=({1:'3445',28:'2967',15:'12441',26:'150'})[locationId]||'';
  // Canonical lines only: group/consolidation projections repeat these lines.
  // One SQL statement observes all packing sources at the same DB snapshot.
  const rows=(await query(`
    SELECT 'SO' AS source,o.tranid AS order_ref,l.id,l.item_id,to_jsonb(l) AS line
      FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id
      WHERE l.item_id=ANY($1::bigint[]) AND COALESCE(l.location_id,o.outbound_location_id)=$2
        AND l.netsuite_active IS NOT FALSE AND o.netsuite_active IS NOT FALSE
        AND COALESCE(o.fulfillment_status,'')<>'fulfilled'
        AND COALESCE(o.operator_status,'') NOT IN ('loaded','fulfilled','completed','cancelled')
        AND COALESCE(o.status,'') NOT IN ('C','F','G') AND NOT ${netSuiteClosedOrderFamilySql('o','SO')}
    UNION ALL
    SELECT 'TO',o.tranid,l.id,l.item_id,to_jsonb(l)
      FROM transfer_order_lines l JOIN transfer_orders o ON o.netsuite_id=l.transfer_order_id
      WHERE l.item_id=ANY($1::bigint[]) AND o.from_location_id=$2 AND l.line_stage='outbound'
        AND l.netsuite_active IS NOT FALSE AND o.netsuite_active IS NOT FALSE
        AND COALESCE(o.fulfillment_status,'')<>'fulfilled'
        AND COALESCE(o.outbound_operator_status,'') NOT IN ('loaded','fulfilled','completed','cancelled')
        AND NOT ${netSuiteClosedOrderFamilySql('o','TO')}
    UNION ALL
    SELECT 'CO',o.co_ref,l.id,l.item_id,to_jsonb(l)
      FROM local_co_order_lines l JOIN local_co_orders o ON o.id=l.co_id
      WHERE l.item_id=ANY($1::bigint[]) AND o.from_location_id=$2
        AND o.status NOT IN ('loaded','completed','received','cancelled') AND o.received_at IS NULL
        AND NOT (o.status='planned' AND (o.loaded_at IS NOT NULL OR COALESCE(o.details->>'sourceCompletionCleanup','') NOT IN ('','false','null')))
    UNION ALL
    SELECT 'VRMA',o.vrma_ref,l.id,l.item_id,to_jsonb(l)
      FROM scm_vrma_order_lines l JOIN scm_vrma_orders o ON o.id=l.vrma_order_id
      WHERE l.item_id=ANY($1::bigint[]) AND o.pickup_location=$3 AND $3<>''
        AND o.loaded_at IS NULL AND o.completed_at IS NULL AND o.cancelled_at IS NULL
        AND lower(COALESCE(o.operator_status,'')) NOT IN ('loaded','completed','cancelled')
        AND lower(o.status) NOT IN ('loaded','completed','cancelled')
    UNION ALL
    SELECT 'RELOAD',o.order_ref,l.id,l.item_id,to_jsonb(l)
      FROM operator_reload_cycle_lines l JOIN operator_reload_cycles o ON o.id=l.cycle_id
      WHERE l.item_id=ANY($1::bigint[]) AND o.outbound_location_id=$2
        AND o.status IN ('authorized','preparing','packed','in_progress')
    ORDER BY source,order_ref,id`,[itemIds,locationId,yardCode])).rows;
  for(const row of rows) {
    const quantity=packedStockQuantity(row.line);
    if(quantity<=0) {continue;}
    const item=result.get(Number(row.item_id));
    item.quantity=round(item.quantity+quantity);
    item.lines.push({source:row.source,orderRef:row.order_ref,lineId:Number(row.id),quantity});
  }
  return result;
}
