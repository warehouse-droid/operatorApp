import {query,closeDb} from './src/db.js';
const roots=['SOA08855','SOA08854','SOA10270','SOA10205','SOA10103','SOA09143','SOA06143','SOA09140'];
try {
  const orders=(await query(`SELECT o.netsuite_id,o.tranid,o.status,o.status_text,o.operator_status,o.local_yard_order_status,
    o.outbound_location_id,o.fulfillment_status,
    (SELECT jsonb_agg(to_jsonb(l)) FROM sales_order_lines l WHERE l.sales_order_id=o.netsuite_id) AS lines,
    (SELECT jsonb_agg(to_jsonb(r)) FROM operator_load_records r WHERE r.order_id=o.netsuite_id OR r.order_ref=o.tranid) AS loads
    FROM sales_orders o WHERE regexp_replace(o.tranid,'-S[0-9]+$','')=ANY($1::text[])`,[roots])).rows;
  const splits=(await query('SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=ANY($1::text[])',[roots])).rows;
  const scmSplits=(await query('SELECT * FROM dispatch_scm_so_splits WHERE source_so_ref=ANY($1::text[])',[roots])).rows;
  const events=(await query(`SELECT to_jsonb(e) AS event,to_jsonb(j) AS driver_job,(eff.id IS NOT NULL) AS effective
    FROM dispatch_order_completion_events e LEFT JOIN driver_job_records j ON j.job_id=e.completion_evidence_id
    LEFT JOIN dispatch_effective_order_completion_events eff ON eff.id=e.id
    WHERE regexp_replace(e.order_ref,'-S[0-9]+$','')=ANY($1::text[]) ORDER BY e.id`,[roots])).rows;
  const allocations=(await query(`SELECT to_jsonb(a) AS allocation,
    (SELECT jsonb_agg(to_jsonb(e)) FROM dispatch_so_po_allocation_execution_events e WHERE e.allocation_id=a.id) AS execution
    FROM dispatch_so_po_allocations a WHERE regexp_replace(a.sales_order_ref,'-S[0-9]+$','')=ANY($1::text[])
    OR regexp_replace(a.dispatch_target_ref,'-S[0-9]+$','')=ANY($1::text[])`,[roots])).rows;
  const dependencies=(await query(`SELECT to_jsonb(d) AS dependency,
    (SELECT jsonb_agg(to_jsonb(l)) FROM order_dependency_lines l WHERE l.dependency_id=d.id) AS lines
    FROM order_dependencies d WHERE regexp_replace(d.sales_order_ref,'-S[0-9]+$','')=ANY($1::text[])
    OR regexp_replace(d.dispatch_target_ref,'-S[0-9]+$','')=ANY($1::text[])`,[roots])).rows;
  console.log(JSON.stringify({at:new Date().toISOString(),orders,splits,scmSplits,events,allocations,dependencies}));
}finally{await closeDb();}
