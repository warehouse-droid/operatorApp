import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {listDeliveryOrders} from '../src/delivery-repository.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='20s'");
    const orders=[];
    for(const type of ['sales_order','transfer_order']) {
      for(const order of await listDeliveryOrders({orderType:type,status:'active'})) {
        orders.push({id:String(order.netsuite_id),ref:order.tranid,type});
      }
    }
    assert.ok(!orders.some(order=>order.ref==='TOB00025'));
    if(process.argv[2]!=='--baseline') assert.ok(!orders.some(order=>order.ref==='SOA08404'));
    const allowedRemoved=[];
    for(const table of ['sales_orders','transfer_orders']) {
      const rows=await query(`SELECT netsuite_id::text AS id FROM ${table} parent
        WHERE parent.tranid NOT LIKE '%-S%' AND EXISTS (SELECT 1 FROM ${table} child
          WHERE child.tranid LIKE parent.tranid||'-S%' AND child.netsuite_active)
        AND NOT EXISTS (SELECT 1 FROM ${table} child WHERE child.tranid LIKE parent.tranid||'-S%'
          AND child.netsuite_active AND COALESCE(child.local_yard_order_status,'Open')<>'Loaded')`);
      allowedRemoved.push(...rows.rows.map(row=>row.id));
    }
    const protectedState=(await query(`SELECT
      (SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY netsuite_id)::text) FROM sales_orders o
        WHERE tranid IN ('SOA08404','SOA08404-S1','SOA08404-S2')) AS headers,
      (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY l.id)::text) FROM sales_order_lines l JOIN sales_orders o
        ON o.netsuite_id=l.sales_order_id WHERE o.tranid IN ('SOA08404','SOA08404-S1','SOA08404-S2')) AS lines,
      (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM driver_job_records j
        WHERE order_refs ?| ARRAY['SOA08404','SOA08404-S1','SOA08404-S2']) AS driver`)).rows[0];
    return {passed:true,readOnly:true,orders,allowedRemoved,protectedState};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
