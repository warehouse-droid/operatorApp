import assert from 'node:assert/strict';import {query,withTransaction,closeDb} from '/app/src/db.js';
import {fetchDeliveryOrderDetailsBatchFromNetSuite} from '/app/src/netsuite.js';
import {lockConsolidatedLoadOrders} from '/app/src/consolidation-load-locks.js';import {writeAudit} from '/app/src/auth-repository.js';
import {enqueueDispatchOrderCatalogRefresh} from '/app/src/dispatch-order-catalog-repository.js';
const mode=process.env.UOM_CACHE_MODE;assert(['rehearse','apply'].includes(mode));
const selector=`SELECT l.*,s.tranid FROM sales_orders s JOIN sales_order_lines l ON l.sales_order_id=s.netsuite_id WHERE s.trandate>='2026-10-01' AND s.netsuite_id>0 AND s.netsuite_active AND l.netsuite_active AND s.status IN ('A','B','D','E') AND s.operator_status='open' AND s.preparing_operator_id IS NULL AND l.item_id IN (2777,2778,2781,2782,2786,2797,2829,9910,9912,9913,9914,9915,9916,9917) AND l.confirmed IS DISTINCT FROM true AND l.loaded_qty=0 AND COALESCE(l.packed_sales_qty,0)+COALESCE(l.packed_pallet_qty,0)+COALESCE(l.packed_layer_qty,0)+COALESCE(l.packed_section_qty,0)+COALESCE(l.packed_piece_qty,0)=0 AND NOT EXISTS(SELECT 1 FROM operator_netsuite_posting_order_claims c WHERE c.active AND c.local_order_key LIKE '%:'||s.netsuite_id::text) ORDER BY l.id`;
try{
 const before=(await query(selector)).rows;assert(before.length<=50,'Review broader scopes separately');
 const ids=[...new Set(before.map(l=>Number(l.sales_order_id)))];const rows=await fetchDeliveryOrderDetailsBatchFromNetSuite(ids);
 const patches=[];
 for(const local of before){const matches=(rows.get(Number(local.sales_order_id))||[]).filter(r=>String(r.line_id)===String(local.line_id)&&Number(r.item_id)===Number(local.item_id));if(matches.length!==1)continue;const remote=matches[0],factor=Number(remote.unit_conversion_rate),native=Number(remote.quantity),old=Number(local.quantity);
  if(factor===1||!Number.isFinite(factor)||factor<=0||String(remote.unit)!==local.unit||!(native>0)||Math.abs(native-old)<1e-6)continue;
  if(Math.abs(old-native*factor)>1e-6)continue;
  assert.equal(local.pack_quantity_source,'sales_only');for(const key of ['to_plt','to_lyr','to_sec','to_pcs'])assert.equal(Number(local[key]||0),0);
  patches.push({id:Number(local.id),orderId:Number(local.sales_order_id),ref:local.tranid,oldQuantity:old,quantity:native,unit:remote.unit,factor,committed:Number(remote.netsuite_committed_qty||0),backordered:Number(remote.netsuite_backordered_qty||0)});
 }
 const result=await withTransaction(async()=>{await query("SET LOCAL lock_timeout='5s'");await lockConsolidatedLoadOrders(ids);
  await query('SELECT id FROM sales_order_lines WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[before.map(l=>l.id)]);assert.deepEqual((await query(selector)).rows,before,'Operator activity changed during refresh');
  for(const p of patches){const r=await query('UPDATE sales_order_lines SET quantity=$2,netsuite_committed_qty=$3,netsuite_backordered_qty=$4,synced_at=now() WHERE id=$1 AND quantity=$5 RETURNING id',[p.id,p.quantity,p.committed,p.backordered,p.oldQuantity]);assert.equal(r.rowCount,1);
   await writeAudit({actorType:'system',source:'user-requested-native-uom-repair',action:'operator.native_uom.cache_refreshed',orderId:p.orderId,details:p});
   await enqueueDispatchOrderCatalogRefresh({orderRef:p.ref,orderType:'SO',source:'native-uom-refresh'});
  }
  return {applied:mode==='apply',lines:patches.length,orders:new Set(patches.map(p=>p.orderId)).size,patches};
 },{rollback:mode==='rehearse'});
 if(mode==='rehearse')assert.deepEqual((await query(selector)).rows,before);
 console.log(JSON.stringify({mode,result,before,after:(await query(selector)).rows}));
}finally{await closeDb();}
