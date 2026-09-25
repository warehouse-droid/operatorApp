import {query,withTransaction,hasActiveTransaction,afterTransactionCommit} from './db.js';
import {isSorFeatureEnabled} from './sor-feature-gate.js';
import {config} from './config.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from './dispatch-fleet-status.js';
import {suiteqlAll} from './netsuite.js';
import {isSorDeliveryRef,sorReturnDraft} from './sor-rental-policy.js';
import {decorateSorOrders,reconcileSorReturnDrafts,upsertSorItemMetadata} from './sor-rental-repository.js';

let metadataRefreshedAt=0;
export async function refreshSorItemMetadata({force=false}={}) {
  if(!await isSorFeatureEnabled()){return;}
  const missing=(await query(`SELECT DISTINCT l.item_id AS id,l.item_name,l.item_type FROM sales_order_lines l
    JOIN sales_orders o ON o.netsuite_id=l.sales_order_id LEFT JOIN sor_item_policies p ON p.item_id=l.item_id
    WHERE o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$' AND l.item_id>0 AND p.item_id IS NULL LIMIT 500`)).rows;
  if(!force && !missing.length && Date.now()-metadataRefreshedAt<15*60*1000){return;}
  if(config.netsuite.directAccessEnabled) {
    const known=(await query("SELECT DISTINCT l.item_id AS id FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$' AND l.item_id>0")).rows;
    const ids=known.map(row=>Number(row.id)).filter(Number.isSafeInteger);
    const rows=await suiteqlAll(`SELECT id,itemid,fullname,itemtype FROM item WHERE (isinactive='F' AND (
      fullname LIKE '01 MBBS%' OR fullname LIKE '02 MBT%' OR fullname LIKE '03 MBR - Repair%'
      OR fullname LIKE '05 MBR Equip%' OR fullname LIKE '06 TM%'
      OR LOWER(itemid) LIKE '%/day' OR LOWER(itemid) LIKE '%/month'))
      ${ids.length?`OR id IN (${ids.join(',')})`:''}`);
    await upsertSorItemMetadata(rows);
  } else {await upsertSorItemMetadata(missing.map(row=>({id:row.id,itemName:row.item_name,fullName:row.item_name,itemType:row.item_type})));}
  metadataRefreshedAt=Date.now();
}

export async function sorSourceDrafts(baseRef,orders=[]) {
  const headers=(await query(`SELECT netsuite_id,tranid,sales_order_type,netsuite_active,status_text,operator_status
    FROM sales_orders WHERE regexp_replace(tranid,'-S[0-9]+$','')=$1`,[baseRef])).rows;
  const byRef=new Map(headers.map(row=>[row.tranid,row]));
  const base=byRef.get(baseRef);
  const definitions=(await query(`SELECT split_ref,full_order,active FROM dispatch_global_order_splits
    WHERE parent_order_ref=$1 AND definition_kind='split' AND order_type='SO'
      AND split_ref ~ '^SOR[0-9]+-S[0-9]+$'`,[baseRef])).rows;
  const leaves=new Map();
  function collect(order){
    if(order.childOrderDetails?.length){order.childOrderDetails.forEach(collect);return;}
    if(isSorDeliveryRef(order.id) && order.id.replace(/-S\d+$/u,'')===baseRef){leaves.set(order.id,order);}
  }
  orders.forEach(collect);
  for(const split of definitions) {
    if(split.active){leaves.set(split.split_ref,split.full_order);}
    else {leaves.delete(split.split_ref);}
  }
  if(definitions.some(row=>row.active)){leaves.delete(baseRef);}
  const drafts=[];
  for(const order of await decorateSorOrders([...leaves.values()])) {
    if(order.deliveryMethod==='Pick-Up'){continue;}
    const header=byRef.get(order.id) || base;
    if(!header || header.sales_order_type!=='Delivery' || !header.netsuite_active || header.operator_status==='cancelled'
      || /(?:^|:\s*)(?:Billed|Closed|Cancelled|Pending Approval)$/iu.test(header.status_text || '')){continue;}
    const completed=(await query(`SELECT 1 FROM driver_job_records WHERE stop_type='dropoff'
      AND status='complete' AND order_refs @> jsonb_build_array($1::text) LIMIT 1`,[order.id])).rowCount;
    if(completed){continue;}
    const draft=sorReturnDraft({...order,netsuiteId:header.netsuite_id,deliveryMethod:header.sales_order_type});
    if(draft){drafts.push(draft);}
  }
  return {drafts,preserveMissing:Boolean(base && /(?:^|:\s*)(?:Billed|Closed)$/iu.test(base.status_text || ''))};
}

/** @param {{loadOrders: (options: {type:string,exactOrderRefs:string[]}) => Promise<any[]>, refreshRefs?: (refs:string[])=>Promise<void>, limit?:number}} options */
export async function runSorReturnQueue({loadOrders,refreshRefs=async(_refs)=>{},limit=20}) {
  if(!await isSorFeatureEnabled()){return {disabled:true,processed:0};}
  if(hasActiveTransaction()) {
    afterTransactionCommit(()=>runSorReturnQueue({loadOrders,refreshRefs,limit}));
    return {deferred:true,processed:0};
  }
  await refreshSorItemMetadata();
  let processed=0;
  for(let index=0;index<limit;index++) {
    if(!await isSorFeatureEnabled()){break;}
    const item=await withTransaction(async()=>{
      await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
      if(!await isSorFeatureEnabled()){return null;}
      const row=(await query(`SELECT * FROM sor_return_reconcile_queue WHERE attempts<5
        ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row){return null;}
      try {
        return await withTransaction(async()=>{
          const orders=await loadOrders({type:'SO',exactOrderRefs:[row.source_ref]});
          const source=await sorSourceDrafts(row.source_ref,orders);
          // Completed deliveries still need their previously created collection.
          const existing=(await query(`SELECT * FROM dispatch_custom_orders WHERE order_kind='sor_rental_return'
            AND regexp_replace(parent_order_ref,'-S[0-9]+$','')=$1 AND status='open'`,[row.source_ref])).rows;
          for(const saved of existing) {
            if(source.drafts.some(draft=>draft.refNumber===saved.ref_number)){continue;}
            const delivered=(await query(`SELECT 1 FROM driver_job_records WHERE stop_type='dropoff' AND status='complete'
              AND order_refs @> jsonb_build_array($1::text) LIMIT 1`,[saved.parent_order_ref])).rowCount;
            if(delivered || source.preserveMissing) {
              const [order]=await decorateSorOrders([{id:saved.parent_order_ref,type:'SO',netsuiteId:saved.parent_sales_order_id,
                address:saved.pickup_location,items:saved.line_snapshot,customer:saved.sor_customer}]);
              const selected=sorReturnDraft(order);
              if(selected){source.drafts.push(selected);}
            }
          }
          const result=await reconcileSorReturnDrafts(row.source_ref,source.drafts);
          const refs=[...new Set([...source.drafts.map(draft=>draft.refNumber),...existing.map(value=>value.ref_number)])];
          return {sourceRef:row.source_ref,version:row.version,result,refs};
        });
      } catch(error) {
        await query('UPDATE sor_return_reconcile_queue SET attempts=attempts+1,last_error=$2,requested_at=now() WHERE source_ref=$1',[row.source_ref,String(error.message).slice(0,1000)]);
        return {sourceRef:row.source_ref,error:String(error.message)};
      }
    });
    if(!item){break;}
    if(item.error){console.error('SOR return reconciliation:',item.sourceRef,item.error);continue;}
    // Catalog refresh can wait for another task that needs the fleet lock.
    // Commit the return and release that lock before entering its executor.
    // Keep the queue row until refresh succeeds so failures/crashes are retried.
    try {
      await refreshRefs(item.refs);
      await query('DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1 AND version=$2',[item.sourceRef,item.version]);
      processed++;
    } catch(error) {
      await query(`UPDATE sor_return_reconcile_queue SET attempts=attempts+1,last_error=$2,requested_at=now()
        WHERE source_ref=$1 AND version=$3`,[item.sourceRef,String(error.message).slice(0,1000),item.version]);
      console.error('SOR return catalog refresh:',item.sourceRef,error.message);
    }
  }
  return {processed};
}
