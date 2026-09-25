import {query} from './db.js';
import {assertInventoryYard,inventoryMonth} from './inventory-workflow-domain.js';
import {reviewDamageMonth} from './inventory-damage-service.js';
import {damageTransferRevision} from './control-damage-domain.js';
import {controlDamageNetSuite} from './control-damage-netsuite.js';
export async function reviewControlDamageMonth(actor,locationId,month,{remote=controlDamageNetSuite}={}) {
  const yard=assertInventoryYard(actor,locationId,true);inventoryMonth(month);
  let records=[];
  const review=await reviewDamageMonth(actor,yard,month,{management:true,remote:{...remote,
    findMonthly:async args=>{records=await remote.findMonthly(args);return records;}}});
  const transfers=records.map(record=>({id:String(record.id),ref:record.tranId,memo:record.memo,date:record.tranDate,
    source:record.location?.refName || String(record.location?.id),destination:record.transferLocation?.refName || String(record.transferLocation?.id),
    revision:damageTransferRevision(record),lines:record.inventory.items.map(line=>{
      const report=review.reports.find(row=>!['removed','missing'].includes(row.status) && String(row.transfer_id)===String(record.id) && Number(row.transfer_line)===Number(line.line));
      return {line:Number(line.line),itemId:String(line.item?.id),itemName:line.item?.refName || line.description,quantity:Number(line.adjustQtyBy),
        unitId:String(line.units),unit:report?.unit || `UOM ${line.units}`,reasonId:Number(line.custcol_atlas_rc_so?.id) || null,
        reason:line.custcol_atlas_rc_so?.refName || '',description:line.description,photos:report?.photos || [],
        reportId:report?.legacy?null:report?.id,operatorName:report?.operator_name || null,reportedAt:report?.created_at || null,original:report?.original || null};
    })}));
  const history=(await query(`SELECT a.id,a.actor_id,o.display_name AS actor_name,a.status,a.safe_to_retry,a.last_error,
    a.plan,a.created_at,a.updated_at,a.posted_at FROM inventory_damage_adjustments a
    JOIN inventory_damage_months m ON m.id=a.month_id LEFT JOIN operators o ON o.id=a.actor_id
    WHERE m.location_id=$1 AND m.month=$2 ORDER BY a.created_at DESC,a.id LIMIT 100`,[yard,month])).rows;
  return {...review,transfers,history,historyLimit:100};
}
