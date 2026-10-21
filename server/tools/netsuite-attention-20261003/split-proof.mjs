import {query,closeDb} from '../../src/db.js';
try{
 const refs=['SOA09223-S1','SOA09143-S1','SOA09140-S1'];
 const splits=(await query('SELECT * FROM dispatch_global_order_splits WHERE split_ref=ANY($1::text[])',[refs])).rows;
 const roots=splits.map(s=>s.parent_order_ref);
 const orders=(await query(`SELECT o.netsuite_id,o.tranid,o.outbound_location_id,o.operator_status,
  (SELECT jsonb_agg(to_jsonb(l)) FROM sales_order_lines l WHERE l.sales_order_id=o.netsuite_id) AS lines,
  (SELECT jsonb_agg(to_jsonb(r)) FROM operator_load_records r WHERE r.order_id=o.netsuite_id) AS loads
  FROM sales_orders o WHERE o.tranid=ANY($1::text[])`,[roots])).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),splits,orders},null,2));
}finally{await closeDb();}
