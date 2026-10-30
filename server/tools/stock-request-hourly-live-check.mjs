// Read-only operational check. Run through stdin with cwd /app in the live app.
import {query,withTransaction,closeDb} from './src/db.js';
import {STOCK_REQUEST_SO_REFRESH_INTERVAL_MS} from './src/stock-request-so-refresh-domain.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='20s'");
  const start=(await query("SELECT created_at FROM delivery_audit_log WHERE action='stock_request.so_refresh.started' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0];
  if(!start)return {intervalMinutes:60,started:false};
  const audit=(await query("SELECT action,order_id,details,created_at FROM delivery_audit_log WHERE action LIKE 'stock_request.so_refresh.%' AND created_at>=$1 ORDER BY created_at,id",[start.created_at])).rows;
  const finished=audit.find(row=>row.action==='stock_request.so_refresh.finished');
  return {intervalMinutes:STOCK_REQUEST_SO_REFRESH_INTERVAL_MS/60000,startedAt:start.created_at,
   nextDueAt:new Date(+new Date(start.created_at)+STOCK_REQUEST_SO_REFRESH_INTERVAL_MS).toISOString(),
   finished:Boolean(finished),summary:finished?.details || null,
   observed:audit.filter(row=>row.action==='stock_request.so_refresh.observed').map(row=>({orderId:row.order_id,ref:row.details.ref,completed:row.details.completed,requests:row.details.requestIds})),
   failures:audit.filter(row=>row.action==='stock_request.so_refresh.failed').map(row=>row.details),readOnly:true};
 });
 console.log(JSON.stringify(result));
} finally {await closeDb();}
