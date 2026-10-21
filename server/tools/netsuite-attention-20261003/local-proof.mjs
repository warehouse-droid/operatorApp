import {query,closeDb} from '../../src/db.js';
try {
 const refs=['SOB121969','SOB121883','SOM06819','SOM06823','SOM06822','SOM06796','SOM06778','SOB121667',
 'SOA09223-S1','SOA09143-S1','SOA09140-S1','SOA09620','SOA08709','SOA09222-S2'];
 const orders=(await query(`SELECT o.netsuite_id,o.tranid,o.status,o.status_text,o.operator_status,o.local_yard_order_status,
  (SELECT jsonb_agg(to_jsonb(l)) FROM sales_order_lines l WHERE l.sales_order_id=o.netsuite_id) AS lines,
  (SELECT jsonb_agg(to_jsonb(r)) FROM operator_load_records r WHERE r.order_id=o.netsuite_id) AS loads
  FROM sales_orders o WHERE o.tranid=ANY($1::text[])`,[refs])).rows;
 const events=(await query(`SELECT to_jsonb(e) AS event,to_jsonb(j) AS driver_job FROM dispatch_order_completion_events e
  LEFT JOIN driver_job_records j ON j.job_id=e.completion_evidence_id
  WHERE e.order_ref=ANY($1::text[]) ORDER BY e.id`,[refs])).rows;
 const allocations=(await query(`SELECT to_jsonb(a) AS allocation,
  (SELECT jsonb_agg(to_jsonb(e)) FROM dispatch_so_po_allocation_execution_events e WHERE e.allocation_id=a.id) AS execution
  FROM dispatch_so_po_allocations a WHERE a.sales_order_ref=ANY($1::text[]) OR a.dispatch_target_ref=ANY($1::text[])`,[refs])).rows;
 const schema=(await query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('dispatch_plans','dispatch_plan_snapshots','dispatch_order_completion_events') ORDER BY table_name,ordinal_position`)).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),orders,events,allocations,schema},null,2));
}finally{await closeDb();}
