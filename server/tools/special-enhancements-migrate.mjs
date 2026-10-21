import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const sql=readFileSync('migrations/238_special_request_details_expiry.sql','utf8');
const columns=async()=> (await query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('sales_special_stock_cases','sales_special_stock_lines','sales_special_stock_order_lines') ORDER BY 1,2")).rows;
const before=await columns();await withTransaction(()=>query(sql),{rollback:true});assert.deepEqual(await columns(),before);
await withTransaction(()=>query(sql));await withTransaction(()=>query(sql));console.log('Migration rollback and repeatable apply passed.');await closeDb();
