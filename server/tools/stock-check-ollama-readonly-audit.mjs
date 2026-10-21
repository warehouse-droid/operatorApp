// Read-only operational audit. Output contains hashes and counts, never customer data.
import crypto from 'node:crypto';
import {query,withTransaction,closeDb} from '/app/src/db.js';
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const audit=await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const tables={};
    for(const name of ['sales_stock_requests','sales_special_stock_cases','sales_special_stock_lines','scm_stock_check_jobs','scm_stock_check_products']) {
      const {rows}=await query('SELECT * FROM '+name+' AS r ORDER BY to_jsonb(r)::text');
      tables[name]={rows:rows.length,sha256:digest(rows)};
    }
    return {at:new Date().toISOString(),readOnly:(await query('SHOW transaction_read_only')).rows[0].transaction_read_only,tables};
  });
  console.log(JSON.stringify(audit));
} finally {await closeDb();}
