import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {fetchSalesOrderReferenceFromNetSuite,fetchDeliveryOrderDetailsFromNetSuite} from '../src/netsuite.js';
import {upsertSalesOrders,upsertSalesOrderLines,markMissingOutboundOrderLines} from '../src/order-sync-repository.js';
import {writeAudit} from '../src/auth-repository.js';
import {enqueueDispatchOrderCatalogRefresh} from '../src/dispatch-order-catalog-repository.js';
import {postingOrderKeys} from '../src/operator-load-state.js';
const numeric=['line_id','netsuite_order_line','item_id','quantity','location_id','pallet_qty','layer_qty','piece_qty','section_qty','to_plt','to_lyr','to_pcs','to_sec'];
function linesFingerprint(lines){return JSON.stringify(lines.filter(line=>line.netsuite_active!==false).map(line=>numeric.map(key=>Math.abs(Number(line[key]||0)))).sort((a,b)=>a[0]-b[0]));}
function date(value){if(!value)return '';const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):String(value);}
function headerFingerprint(header,remote=false){return JSON.stringify([header.status,date(header.expected_delivery_date),Number(header.outbound_location_id),String(remote?header.delivery_method:header.sales_order_type)]);}

export async function auditDiscardedOrderUpdates({apply=false,onResult=()=>{},approvedHeaders=null}={}){
 const candidates=(await query(`SELECT DISTINCT later.netsuite_order_id,later.payload->>'tranid' AS ref FROM netsuite_order_webhook_inbox later
  JOIN netsuite_order_webhook_inbox earlier ON earlier.id=later.superseded_by_id
  WHERE later.source_modified_at=earlier.source_modified_at AND later.id>earlier.id
    AND later.received_at>earlier.received_at AND later.payload_hash<>earlier.payload_hash ORDER BY ref`)).rows;
 const results=[];
 for(const candidate of candidates){
  const id=Number(candidate.netsuite_order_id),start=new Date();
  if(approvedHeaders&&!Object.hasOwn(approvedHeaders,String(id)))continue;
  if(candidate.ref.startsWith('SOT')){const row={...candidate,status:'excluded_cross_charge'};results.push(row);onResult(row);continue;}
  const header=await fetchSalesOrderReferenceFromNetSuite(id);
  if(!header){const row={...candidate,status:'source_not_found'};results.push(row);onResult(row);continue;}
  const lines=await fetchDeliveryOrderDetailsFromNetSuite(id);
  const result=await withTransaction(async()=>{
   const local=(await query(`SELECT * FROM sales_orders WHERE netsuite_id=$1${apply?' FOR UPDATE':''}`,[id])).rows[0];
   const before=(await query(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1${apply?' FOR UPDATE':''}`,[id])).rows;
   if(!local)return {...candidate,status:'not_local'};
   const differences=[];
   for(const line of lines){const prior=before.find(row=>Number(row.line_id)===Number(line.line_id)&&row.netsuite_active!==false);if(!prior){differences.push({line:line.line_id,missing:true});continue;}for(const field of numeric){if(Math.abs(Number(prior[field]||0))!==Math.abs(Number(line[field]||0)))differences.push({line:line.line_id,field,local:prior[field]||0,remote:line[field]||0});}}
   if(headerFingerprint(local)!==headerFingerprint(header,true))differences.push({header:true,local:JSON.parse(headerFingerprint(local)),remote:JSON.parse(headerFingerprint(header,true))});
   const stale=linesFingerprint(before)!==linesFingerprint(lines)||headerFingerprint(local)!==headerFingerprint(header,true);
   const claims=(await query('SELECT command_id FROM operator_netsuite_posting_order_claims WHERE active=true AND local_order_key=ANY($1::text[])',[postingOrderKeys({netsuite_id:id,order_type:'sales_order'})])).rows;
   const newer=(await query('SELECT count(*)::int n FROM netsuite_order_webhook_inbox WHERE netsuite_order_id=$1 AND received_at>$2',[String(id),start])).rows[0].n>0;
   const report={...candidate,stale,differences,localLines:before.filter(line=>line.netsuite_active!==false).length,sourceLines:lines.length,status:!stale?'current':claims.length?'held_for_posting':newer?'newer_webhook_pending':'stale',refreshed:false};
   if(!apply||!stale||claims.length||newer)return report;
   if(approvedHeaders){
    assert.equal(linesFingerprint(before),linesFingerprint(lines),'Header-only approval cannot change lines');
    assert.deepEqual(differences,[approvedHeaders[String(id)]],'Current correction must match the reviewed before/after values');
    await query('UPDATE sales_orders SET status=$2,status_text=$3,expected_delivery_date=$4::date WHERE netsuite_id=$1',
      [id,header.status,header.status_text,date(header.expected_delivery_date)||null]);
   }else{
    await upsertSalesOrders([header]);await upsertSalesOrderLines(id,lines);
    await markMissingOutboundOrderLines(id,lines.map(line=>line.line_id));
   }
   const after=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1',[id])).rows;
   if(approvedHeaders)assert.deepEqual(after,before,'Header-only refresh must leave every line field unchanged');
   for(const prior of before){
    const next=after.find(line=>String(line.id)===String(prior.id));assert.ok(next,'Historical rows must remain');
    assert.ok(Number(next.loaded_qty)>=Number(prior.loaded_qty),'Never erase completed quantities');
    for(const field of ['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','packed_sales_qty'])assert.equal(Number(next[field]),Number(prior[field]),'Never erase confirmed quantities');
   }
   assert.equal(linesFingerprint(after),linesFingerprint(lines),'Current source lines must match after sync');
   await writeAudit({actorType:'system',source:'same-timestamp-webhook-repair',action:'netsuite.order.discarded_update_reconciled',orderId:id,details:report});
   await enqueueDispatchOrderCatalogRefresh({orderRef:candidate.ref,orderType:'SO',source:'same-timestamp-webhook-repair'});
   return {...report,status:'refreshed',refreshed:true};
  });
  results.push(result);onResult(result);
 }
 return {observedAt:new Date().toISOString(),apply,results};
}
