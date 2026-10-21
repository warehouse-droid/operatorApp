import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {query,closeDb,withTransaction} from '../../../src/db.js';
test.after(()=>closeDb());
test('Stock Check migration creates only its own tables and a transaction rollback restores all prior records',async()=>{
  const before=await query("SELECT count(*)::int AS count FROM scm_stock_check_vendors");
  const existing=await query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'scm_stock_check_%' ORDER BY tablename");
  await withTransaction(async()=>{
    await query('DROP TABLE scm_stock_check_steps,scm_stock_check_jobs,scm_stock_check_audit,scm_stock_check_products,scm_stock_check_accounts,scm_stock_check_vendors CASCADE');
    await query(await fs.readFile('migrations/288_stock_check_module.sql','utf8'));
    const seeds=await query('SELECT name,method_key FROM scm_stock_check_vendors');assert.deepEqual(seeds.rows,[{name:'Unilock',method_key:'unilock-ontario-v1'}]);
    const after=await query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'scm_stock_check_%' ORDER BY tablename");assert.deepEqual(after.rows,existing.rows);
  },{rollback:true});
  assert.equal((await query('SELECT count(*)::int AS count FROM scm_stock_check_vendors')).rows[0].count,before.rows[0].count);
});
