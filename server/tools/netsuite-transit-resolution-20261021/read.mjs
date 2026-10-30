// NetSuite reads and local SELECTs only. No posting or reconciliation mutations.
import {query,closeDb} from './src/db.js';
import {listScmSchedule} from './src/dispatch-repository.js';
import {fetchPoToReconciliationOrdersFromNetSuite,fetchPoToLinkedTransactionsFromNetSuite} from './src/netsuite.js';
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
try {
  const schedule=await listScmSchedule({kind:['PO','TO'],status:'In Transit'});
  const raw=(await query(`SELECT order_kind,order_ref FROM scm_transport_schedule WHERE order_kind IN ('PO','TO') AND status='In Transit'
    UNION SELECT order_kind,source_order_ref FROM scm_reconciliation_order_state WHERE order_kind IN ('PO','TO') AND application_status='In Transit'`)).rows;
  const refs=[...new Set([...raw.map(r=>r.order_ref),...schedule.flatMap(r=>[r.orderRef,r.sourceRef])].filter(Boolean))];
  const splits=(await query(`SELECT * FROM dispatch_scm_po_splits WHERE split_po_ref=ANY($1::text[]) OR source_po_ref=ANY($1::text[])`,[refs])).rows;
  const poIds=splits.flatMap(s=>[Number(s.split_po_id),Number(s.source_po_id)]);
  const purchase=(await query(`SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) OR tranid=ANY($2::text[]) OR dispatch_ref=ANY($2::text[])`,[poIds,refs])).rows;
  const transfer=(await query('SELECT * FROM transfer_orders WHERE tranid=ANY($1::text[])',[refs])).rows;
  const ids=[...new Set([...purchase,...transfer].map(o=>Number(o.netsuite_id)))];
  const allRefs=[...new Set([...refs,...purchase.flatMap(o=>[o.tranid,o.dispatch_ref]),...transfer.map(o=>o.tranid)].filter(Boolean))];
  const evidence={};
  for(const [key,sql] of Object.entries({
    purchaseLines:'SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])',
    transferLines:'SELECT * FROM transfer_order_lines WHERE transfer_order_id=ANY($1::bigint[])',
    loads:'SELECT id,load_type,order_family,order_id,order_ref,loaded_qty,loaded_uom,line_snapshot,response,created_at FROM operator_load_records WHERE order_id=ANY($1::bigint[])',
    receipts:'SELECT id,order_id,item_receipt_id,item_receipt_tranid,receipt_status,payload,response,created_at FROM receiving_receipt_records WHERE order_id=ANY($1::bigint[])'
  })) evidence[key]=(await query(sql,[ids])).rows;
  evidence.completions=(await query('SELECT * FROM dispatch_effective_order_completion_events WHERE order_ref=ANY($1::text[])',[allRefs])).rows;
  evidence.drivers=(await query(`SELECT id,job_id,plan_id,plan_date,load_id,stop_id,stop_type,order_refs,status,completed_at,started_at,job_details,mbt_assignment_withdrawn_at
    FROM driver_job_records WHERE order_refs ?| $1::text[] ORDER BY id`,[allRefs])).rows;
  emit({event:'local',refs:allRefs,schedule,splits,purchase,transfer,evidence});
  const positiveIds=ids.filter(id=>id>0);
  const orders=await fetchPoToReconciliationOrdersFromNetSuite({orderIds:positiveIds,targetOnly:true,includeOpen:false});
  emit({event:'orders',orders});
  for(let i=0;i<positiveIds.length;i+=12) {
    const batch=positiveIds.slice(i,i+12);
    emit({event:'linked',ids:batch,rows:await fetchPoToLinkedTransactionsFromNetSuite(batch)});
  }
} finally {await closeDb();}
