import crypto from 'node:crypto';
import {query,withTransaction} from './db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from './dispatch-fleet-status.js';
import {projectSorOrder,rentalItemDecision,isSorDeliveryRef} from './sor-rental-policy.js';

const conflict = () => Object.assign(new Error('This setting changed. Refresh before saving.'),{status:409,code:'SOR_SETTING_STALE'});
function policy(row) {
  return {itemId:Number(row.item_id),itemName:row.item_name,fullName:row.full_name,itemType:row.item_type,
    override:row.auto_return_override,revision:Number(row.revision),updatedBy:row.updated_by,updatedAt:row.updated_at};
}
export async function upsertSorItemMetadata(rows=[]) {
  for(const row of rows) {await query(`WITH changed AS (INSERT INTO sor_item_policies(item_id,item_name,full_name,item_type,metadata_synced_at)
    VALUES($1,$2,$3,$4,now()) ON CONFLICT(item_id) DO UPDATE SET item_name=EXCLUDED.item_name,
    full_name=CASE WHEN EXCLUDED.full_name<>'' THEN EXCLUDED.full_name ELSE sor_item_policies.full_name END,
    item_type=EXCLUDED.item_type,metadata_synced_at=now()
    WHERE (sor_item_policies.item_name,sor_item_policies.item_type,sor_item_policies.full_name) IS DISTINCT FROM
      (EXCLUDED.item_name,EXCLUDED.item_type,CASE WHEN EXCLUDED.full_name<>'' THEN EXCLUDED.full_name ELSE sor_item_policies.full_name END)
    RETURNING item_id)
    INSERT INTO sor_return_reconcile_queue(source_ref)
    SELECT DISTINCT regexp_replace(upper(o.tranid),'-S[0-9]+$','') FROM sales_orders o
    JOIN sales_order_lines l ON l.sales_order_id=o.netsuite_id JOIN changed c ON c.item_id=l.item_id
    WHERE o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'
    ON CONFLICT(source_ref) DO UPDATE SET version=sor_return_reconcile_queue.version+1,requested_at=now(),attempts=0,last_error=''`,
  [row.id || row.itemId,row.itemid || row.itemName || '',row.fullname || row.fullName || '',row.itemtype || row.itemType || '']);}
}
export async function listSorItems({search='',filter='',limit=100,offset=0}={}) {
  const rows=(await query(`SELECT * FROM sor_item_policies WHERE concat_ws(' ',item_id,item_name,full_name) ILIKE '%'||$1||'%'
    ORDER BY item_name,item_id`,[String(search).slice(0,120)])).rows.map(row=>{
    const value=policy(row);return {...value,...rentalItemDecision({},value)};
  }).filter(row=>filter==='overridden'?row.override!==null:filter==='enabled'?row.autoReturn:filter==='disabled'?!row.autoReturn:true);
  const start=Math.max(0,Math.trunc(Number(offset)||0));
  return {items:rows.slice(start,start+Math.min(200,Math.max(1,Number(limit)||100))),total:rows.length};
}
export async function sorItemImpact(itemId) {
  return (await query(`SELECT DISTINCT o.tranid AS "orderRef",r.ref_number AS "returnRef",r.status,
    r.sor_review_reason AS "reviewReason",EXISTS(SELECT 1 FROM dispatch_plan_order_assignments a
      JOIN dispatch_plans p ON p.id=a.plan_id AND p.status<>'cancelled'
      WHERE lower(a.order_ref)=lower(r.ref_number)) AS assigned
    FROM sales_orders o JOIN sales_order_lines l ON l.sales_order_id=o.netsuite_id
    LEFT JOIN dispatch_custom_orders r ON r.parent_sales_order_id=o.netsuite_id AND r.order_kind='sor_rental_return'
    WHERE o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$' AND l.item_id=$1 ORDER BY o.tranid`,[itemId])).rows;
}
/** @param {number|string} itemId @param {{override?: boolean|null, expectedRevision?: number, actor?: string}} options */
export async function updateSorItemPolicy(itemId,{override,expectedRevision,actor}={}) {
  if(!Number.isSafeInteger(Number(itemId)) || Number(itemId)<=0 || ![true,false,null].includes(override))
    {throw Object.assign(new Error('Select Default, Create return, or Do not create return.'),{status:400});}
  return withTransaction(async()=>{
    const before=(await query('SELECT * FROM sor_item_policies WHERE item_id=$1 FOR UPDATE',[itemId])).rows[0];
    if(!before) {throw Object.assign(new Error('Item was not found.'),{status:404});}
    if(Number(before.revision)!==Number(expectedRevision)) {throw conflict();}
    if(before.auto_return_override===override){return policy(before);}
    const after=(await query(`UPDATE sor_item_policies SET auto_return_override=$2,revision=revision+1,
      updated_at=now(),updated_by=$3 WHERE item_id=$1 RETURNING *`,[itemId,override,actor])).rows[0];
    await query('INSERT INTO sor_configuration_audit(actor,subject,before_state,after_state) VALUES($1,$2,$3,$4)',
      [actor,`item:${itemId}`,JSON.stringify(policy(before)),JSON.stringify(policy(after))]);
    await query(`INSERT INTO sor_return_reconcile_queue(source_ref)
      SELECT DISTINCT regexp_replace(upper(o.tranid),'-S[0-9]+$','') FROM sales_orders o
      JOIN sales_order_lines l ON l.sales_order_id=o.netsuite_id WHERE l.item_id=$1 AND o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'
      ON CONFLICT(source_ref) DO UPDATE SET version=sor_return_reconcile_queue.version+1,requested_at=now(),attempts=0,last_error=''`,[itemId]);
    return policy(after);
  });
}
export async function getSorSignatureSettings() {
  const row=(await query('SELECT * FROM sor_signature_settings WHERE singleton=true')).rows[0];
  return {terms:row.terms,revision:Number(row.revision),returnsEnabled:row.returns_enabled,updatedAt:row.updated_at,updatedBy:row.updated_by};
}
/** @param {{terms?: string, expectedRevision?: number, actor?: string}} options */
export async function updateSorSignatureSettings({terms,expectedRevision,actor}={}) {
  if(typeof terms!=='string' || !terms.trim() || terms.length>10000)
    {throw Object.assign(new Error('T&C must contain 1 to 10,000 characters.'),{status:400});}
  return withTransaction(async()=>{
    await query('SELECT singleton FROM sor_signature_settings WHERE singleton=true FOR UPDATE');
    const before=await getSorSignatureSettings();
    if(before.revision!==Number(expectedRevision)){throw conflict();}
    if(before.terms===terms.trim()){return before;}
    await query(`UPDATE sor_signature_settings SET terms=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton=true`,[terms.trim(),actor]);
    await query('INSERT INTO sor_signature_terms_history SELECT revision,terms,updated_at,updated_by FROM sor_signature_settings');
    const after=await getSorSignatureSettings();
    await query('INSERT INTO sor_configuration_audit(actor,subject,before_state,after_state) VALUES($1,$2,$3,$4)',
      [actor,'signature_terms',JSON.stringify(before),JSON.stringify(after)]);
    return after;
  });
}
export async function decorateSorOrders(orders=[]) {
  const ids=new Set();
  function collect(order){if(isSorDeliveryRef(order.id)){for(const item of order.items || []) {if(Number(item.itemId)>0){ids.add(String(item.itemId));}}}for(const child of order.childOrderDetails || []){collect(child);}}
  orders.forEach(collect);
  if(!ids.size){return orders.map(order=>projectSorOrder(order));}
  const rows=(await query('SELECT * FROM sor_item_policies WHERE item_id=ANY($1::bigint[])',[[...ids]])).rows;
  const policies=new Map(rows.map(row=>[String(row.item_id),policy(row)]));
  return orders.map(order=>projectSorOrder(order,policies));
}
export async function sorReturnActivity(ref) {
  const row=(await query(`SELECT EXISTS(SELECT 1 FROM dispatch_plan_order_assignments a
      JOIN dispatch_plans p ON p.id=a.plan_id WHERE p.status<>'cancelled' AND lower(a.order_ref)=lower($1)) AS assigned,
    EXISTS(SELECT 1 FROM driver_job_records j WHERE j.order_refs @> jsonb_build_array($1::text)
      AND (j.started_at IS NOT NULL OR j.status='complete')) AS started`,[ref])).rows[0];
  return row.assigned || row.started;
}
export async function reconcileSorReturnDrafts(baseRef,drafts=[],{preserveMissing=false}={}) {
  return withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
    const existing=(await query(`SELECT * FROM dispatch_custom_orders WHERE order_kind='sor_rental_return'
      AND regexp_replace(parent_order_ref,'-S[0-9]+$','')=$1 FOR UPDATE`,[baseRef])).rows;
    const byRef=new Map(existing.map(row=>[row.ref_number,row]));
    const requested=new Map(drafts.map(draft=>[draft.refNumber,draft]));
    const result={created:0,updated:0,review:0,cancelled:0};
    for(const ref of new Set([...byRef.keys(),...requested.keys()])) {
      const previous=byRef.get(ref); const draft=requested.get(ref);
      if(previous?.status==='completed' || (!draft && (!previous || preserveMissing))){continue;}
      const fingerprint=draft?crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex'):'';
      if(previous?.sor_source_fingerprint===fingerprint && previous.status===(draft?'open':'cancelled') && !previous.sor_review_reason){continue;}
      if(previous && await sorReturnActivity(ref)) {
        await query("UPDATE dispatch_custom_orders SET sor_review_reason=$2 WHERE id=$1",[previous.id,'Source items, address, or auto-return policy changed. Unassign untouched work to refresh.']);
        result.review++;continue;
      }
      if(!draft) {
        await query("UPDATE dispatch_custom_orders SET status='cancelled',cancelled_at=now(),cancelled_by='sor-automation',sor_source_fingerprint='',sor_review_reason='',updated_at=now() WHERE id=$1",[previous.id]);
        result.cancelled++;continue;
      }
      const totals=['pallets','layers','sections','pieces'].map(key=>draft.lineSnapshot.reduce((sum,line)=>sum+Number(line[key]||0),0));
      const written = await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,weight_lbs,
        order_kind,system_managed,parent_sales_order_id,parent_order_ref,line_snapshot,sales_qty,pallet_qty,layer_qty,section_qty,piece_qty,
        billing_disposition,sor_source_fingerprint,sor_customer,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,'sor_rental_return',true,$6,$7,$8,$9,$10,$11,$12,$13,'linked_parent_no_charge',$14,$15,'sor-automation','sor-automation')
        ON CONFLICT(lower(btrim(ref_number))) DO UPDATE SET pickup_location=EXCLUDED.pickup_location,
        dropoff_location=EXCLUDED.dropoff_location,order_details=EXCLUDED.order_details,weight_lbs=EXCLUDED.weight_lbs,
        line_snapshot=EXCLUDED.line_snapshot,sales_qty=EXCLUDED.sales_qty,pallet_qty=EXCLUDED.pallet_qty,layer_qty=EXCLUDED.layer_qty,
        section_qty=EXCLUDED.section_qty,piece_qty=EXCLUDED.piece_qty,sor_source_fingerprint=EXCLUDED.sor_source_fingerprint,
        sor_customer=EXCLUDED.sor_customer,status='open',cancelled_at=null,sor_review_reason='',updated_at=now(),updated_by='sor-automation'
        WHERE dispatch_custom_orders.order_kind='sor_rental_return' AND dispatch_custom_orders.parent_order_ref=EXCLUDED.parent_order_ref
        AND dispatch_custom_orders.status<>'completed' RETURNING id`,
      [ref,draft.pickupLocation,draft.dropoffLocation,draft.orderDetails,draft.weightLbs,draft.parentSalesOrderId,draft.parentOrderRef,
        JSON.stringify(draft.lineSnapshot),draft.salesQty,...totals,fingerprint,draft.customer]);
      if(!written.rowCount){throw new Error(`Return reference ${ref} already exists for another order. Review the collision in Dispatch.`);}
      if(!previous){result.created++;}else {result.updated++;}
    }
    if(Object.values(result).some(Boolean)){await query('INSERT INTO sor_configuration_audit(actor,subject,before_state,after_state) VALUES($1,$2,$3,$4)',
      ['sor-automation',baseRef,JSON.stringify(existing),JSON.stringify({result,drafts})]);}
    return result;
  });
}
