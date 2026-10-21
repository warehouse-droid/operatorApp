// Run inside the deployed app after release verification. Uses the existing
// successful-status-refresh gate; never directly creates an approval snapshot.
import {query,closeDb} from './src/db.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
const apply=process.argv.includes('--enqueue');
try{
 const rows=(await query("SELECT order_id,snapshot->>'tranid' AS tranid FROM boss_approval_requests WHERE status='pending' ORDER BY id")).rows;
 if(apply){
  for(const row of rows){await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:Number(row.order_id),tranid:row.tranid,availableAt:new Date(Date.now()+10000)});}
  console.log(JSON.stringify({queued:rows.length,initialDelaySeconds:10}));
 }else{
  const requests=(await query(`SELECT r.order_id,r.snapshot->>'tranid' AS tranid,r.snapshot->>'creditLimit' AS credit_limit,
    r.snapshot->>'balance' AS outstanding,r.snapshot->>'unbilledOrders' AS unbilled_orders,
    r.snapshot->>'currentOwed' AS current_owed,r.snapshot->>'creditBalance' AS credit_balance,
    s.generation=s.enriched_generation AS enriched,s.observed_at,
    (SELECT j.status FROM netsuite_delayed_status_refresh_jobs j WHERE j.order_type='sales_order' AND j.netsuite_order_id=r.order_id ORDER BY j.id DESC LIMIT 1) AS refresh_status
    FROM boss_approval_requests r JOIN boss_approval_sources s ON s.order_id=r.order_id
    WHERE r.status='pending' ORDER BY r.id`)).rows;
  console.log(JSON.stringify({pending:requests,allHaveCreditFigures:requests.every(r=>r.current_owed!==null&&r.credit_balance!==null&&r.unbilled_orders!==null&&r.enriched)}));
 }
}finally{await closeDb();}
