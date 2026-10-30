// Operational diagnostic: execute inside the live app with stdin, never log order data.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {query,withTransaction,closeDb} from './src/db.js';
import {listYardMovements,getYardMovementDetail} from './src/yard-movement-repository.js';
async function readOnly(action){return withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='4s'");await query("SET LOCAL lock_timeout='500ms'");
  return action();
});}
try {
  const selected=await readOnly(async()=>{const {rows}=await query("SELECT so.netsuite_id,so.tranid FROM operator_load_records r JOIN sales_orders so ON so.netsuite_id=r.order_id WHERE r.order_family='sales_order' ORDER BY r.created_at DESC LIMIT 1");return rows[0];});
  if(!selected) throw new Error('No loaded order available');
  const range={from:'2000-01-01',to:'2099-12-31'},day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date());
  const results=[];
  for(const [name,action] of [
    ['recentDayList',()=>listYardMovements({from:day,to:day,direction:'outbound',orderType:'sales_order'})],
    ['globalSearch',()=>listYardMovements({...range,search:selected.tranid})],
    ['selectedDetail',()=>getYardMovementDetail({...range,direction:'outbound',orderType:'sales_order',orderId:selected.netsuite_id})]
  ]){
    const start=performance.now();
    try{const value=await readOnly(action);results.push({name,ms:Math.round(performance.now()-start),ok:true,rows:Array.isArray(value)?value.length:value?1:0});}
    catch(error){results.push({name,ms:Math.round(performance.now()-start),ok:false,code:error.code});}
  }
  console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,orderHash:createHash('sha256').update(String(selected.netsuite_id)).digest('hex'),results}));
} finally {await closeDb();}
