import {query,closeDb} from '../../src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite,fetchItemReceiptFromNetSuite} from '../../src/netsuite.js';
const refs=['TOB01190','TOB01191'];
try {
 const orders=(await query('SELECT * FROM transfer_orders WHERE tranid=ANY($1::text[])',[refs])).rows;
 const ids=orders.map(o=>o.netsuite_id);
 const jobs=(await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=ANY($1::bigint[]) ORDER BY created_at',[ids])).rows;
 const dependencies=(await query('SELECT * FROM order_dependencies WHERE transfer_order_id=ANY($1::bigint[]) ORDER BY id',[ids])).rows;
 const dependencyLines=(await query('SELECT * FROM order_dependency_lines WHERE dependency_id=ANY($1::bigint[])',[dependencies.map(d=>d.id)])).rows;
 const targets=[...new Set([...refs,...dependencies.flatMap(d=>[d.sales_order_ref,d.dispatch_target_ref]).filter(Boolean)])];
 const assignments=(await query('SELECT * FROM dispatch_plan_order_assignments WHERE order_ref=ANY($1::text[]) OR planned_order_ref=ANY($1::text[]) ORDER BY plan_id',[targets])).rows;
 const events=(await query('SELECT * FROM dispatch_effective_order_completion_events WHERE order_ref=ANY($1::text[]) ORDER BY id',[targets])).rows;
 const drivers=(await query('SELECT job_id,plan_id,plan_date,load_id,stop_id,stop_type,order_refs,status,completed_at,mbt_assignment_withdrawn_at,job_details FROM driver_job_records WHERE order_refs ?| $1::text[] ORDER BY completed_at',[targets])).rows;
 const loads=(await query('SELECT * FROM operator_load_records WHERE order_id=ANY($1::bigint[]) ORDER BY id',[ids])).rows;
 const localLines=(await query('SELECT id,transfer_order_id,line_id,line_stage,item_id,quantity,loaded_qty,unit,netsuite_order_line,raw FROM transfer_order_lines WHERE transfer_order_id=ANY($1::bigint[])',[ids])).rows;
 const commands=(await query('SELECT id,status,last_error,input_snapshot FROM operator_netsuite_posting_commands WHERE id=ANY($1::uuid[])',[jobs.map(j=>j.command_id).filter(Boolean)])).rows;
 const sqlIds=ids.map(Number);if(!sqlIds.every(Number.isSafeInteger)||!sqlIds.length)throw new Error('Invalid TO identity');
 const remoteHeaders=await suiteqlAll(`SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id IN (${sqlIds.join(',')}) AND type='TrnfrOrd'`);
 const remoteLinks=await suiteqlAll(`SELECT DISTINCT l.previousdoc,t.id,t.tranid,t.type FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc WHERE l.previousdoc IN (${sqlIds.join(',')}) AND t.type IN ('ItemShip','ItemRcpt')`);
 const remoteRecords=[];for(const link of remoteLinks)remoteRecords.push({link,record:await (link.type==='ItemShip'?fetchItemFulfillmentFromNetSuite:fetchItemReceiptFromNetSuite)(link.id)});
 console.log(JSON.stringify({at:new Date().toISOString(),orders,jobs,dependencies,dependencyLines,assignments,events,drivers,loads,localLines,commands,remoteHeaders,remoteLinks,remoteRecords},null,2));
}finally{await closeDb();}
