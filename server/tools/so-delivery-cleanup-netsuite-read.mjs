// Read-only NetSuite status verification for Delivery SOs already present locally.
// NetSuite's SuiteQL endpoint uses POST to execute SELECT queries; no records are posted.
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = (name) => pathToFileURL(path.resolve("src",name)).href;
const {pool,query,withTransaction,closeDb} = await import(source("db.js"));
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=45000";
const {fetchTransactionStatusesFromNetSuite} = await import(source("netsuite.js"));
const {listDriverPwaCompletedDispatchRefs} = await import(source("dispatch-history-mode.js"));
const {config} = await import(source("config.js"));
config.netsuite.requestTimeoutMs = 45000;
try {
  const {rows:candidates} = await query(`SELECT netsuite_id,tranid,status,status_text FROM sales_orders
    WHERE sales_order_type='Delivery' AND netsuite_id>0 AND NOT COALESCE(is_test_fixture,false)
    ORDER BY netsuite_id`);
  const locallyDelivered = await listDriverPwaCompletedDispatchRefs({candidateRefs:candidates.map(row=>row.tranid)});
  const requested = candidates.filter(row=>!locallyDelivered.has(String(row.tranid).trim().toLowerCase()));
  const startedAt=new Date().toISOString();
  const rows=[];
  for(let i=0;i<requested.length;i+=500) {
    const batch=requested.slice(i,i+500);
    const result=await withTransaction(async()=>{
      await query("SET TRANSACTION READ ONLY");
      return fetchTransactionStatusesFromNetSuite(batch.map((o)=>o.netsuite_id),"SalesOrd");
    },{rollback:true});
    rows.push(...result);
    process.stderr.write(`Read-only NetSuite status verification: ${Math.min(i+500,requested.length)}/${requested.length} requested; ${rows.length} returned.\n`);
  }
  process.stdout.write(`${JSON.stringify({mode:"netsuite-read-only-select",startedAt,
    completedAt:new Date().toISOString(),locallyDeliveredExcluded:candidates.length-requested.length,requested,rows},null,2)}\n`);
} finally { await closeDb(); }
