import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../../src/db.js';
after(closeDb);
test('additive upgrade preserves legacy rows and its transactional rollback leaves no schema changes',async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 const schema=`regular_upgrade_${randomUUID().replaceAll('-','')}`;
 const migration=await readFile(new URL('../../../migrations/239_regular_stock_approval_workflow.sql',import.meta.url),'utf8');
 await withTransaction(async()=>{
  await query(`CREATE SCHEMA "${schema}"`);await query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
  await query(`CREATE TABLE scm_smart_settings(id integer PRIMARY KEY);
   CREATE TABLE operators(id text PRIMARY KEY);
   CREATE TABLE inventory_items(item_id bigint PRIMARY KEY);
   CREATE TABLE sales_stock_requests(id bigint PRIMARY KEY,status text);
   CREATE TABLE sales_stock_request_lines(id bigint PRIMARY KEY,status text CONSTRAINT sales_stock_request_lines_status_check CHECK(status IN ('submitted','converted')));
   CREATE TABLE scm_smart_proposals(id bigint PRIMARY KEY);
   CREATE TABLE scm_smart_planning_runs(id bigint PRIMARY KEY);
   INSERT INTO scm_smart_settings VALUES(1);INSERT INTO sales_stock_requests VALUES(1,'submitted');INSERT INTO sales_stock_request_lines VALUES(1,'submitted');`);
  await query(migration);
  assert.equal((await query('SELECT workflow_version FROM sales_stock_requests WHERE id=1')).rows[0].workflow_version,1);
  assert.equal(Number((await query('SELECT regular_stock_lead_hours FROM scm_smart_settings WHERE id=1')).rows[0].regular_stock_lead_hours),5);
  await query("UPDATE sales_stock_request_lines SET status='approved',regular_decision='stock' WHERE id=1");
  await assert.rejects(()=>withTransaction(()=>query('UPDATE scm_smart_settings SET regular_stock_lead_hours=-1')),e=>e.code==='23514');
 },{rollback:true});
 assert.equal((await query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);
});
