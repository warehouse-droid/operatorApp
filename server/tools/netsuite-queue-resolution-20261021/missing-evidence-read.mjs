import {query,closeDb} from './src/db.js';
try {
  const keys=['4968409','5129155','5124009','5114839','5114840','5114880','4997418','4997388'];
  const refs=['SOA08855-S1','SOA08855-S2','SOA10270','SOA10205','SOA10103','SOA09143-S1','SOA09143-S3','SOA09140-S1'];
  const loads=(await query(`SELECT id,load_type,order_family,order_id,order_ref,created_at,line_snapshot,response
    FROM operator_load_records r WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(r.line_snapshot) l WHERE l->>'lineId'=ANY($1::text[]))`,[keys])).rows;
  const audit=(await query(`SELECT id,created_at,action,order_id,line_id,details FROM delivery_audit_log
    WHERE order_id IN (1053413,1006341,1006337,1057516,1059786,995611)
    AND (action LIKE '%load%' OR action LIKE '%fulfill%' OR action LIKE '%receive%' OR action LIKE '%reconcil%') ORDER BY id`,[])).rows;
  const pickup=(await query(`SELECT job_id,plan_id,load_id,plan_date,status,stop_type,completed_at,order_refs,job_details
    FROM driver_job_records WHERE stop_type='pickup' AND status='complete' AND (plan_id,load_id) IN
    (SELECT e.plan_id,e.load_id FROM dispatch_order_completion_events e WHERE e.order_ref=ANY($1::text[]))`,[refs])).rows;
  console.log(JSON.stringify({at:new Date().toISOString(),loads,audit,pickup}));
}finally{await closeDb();}
