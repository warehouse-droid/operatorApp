import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const tables=['inventory_damage_events','inventory_damage_photos','inventory_damage_reports','inventory_damage_months',
  'inventory_count_sheet_events','inventory_count_sheet_counts','inventory_count_sheet_items','inventory_count_sheets'];
async function counts() {
  const rows=[];
  for(const table of tables) {rows.push([table,(await query(`SELECT count(*) FROM ${table}`)).rows[0].count]);}
  return rows;
}
const before=await counts();
await withTransaction(async()=>{
  for(const table of tables) {await query(`DROP TABLE ${table}`);}
  await query(readFileSync('migrations/220_operator_inventory_workflows.sql','utf8'));
  for(const [,count] of await counts()) {assert.equal(count,'0');}
},{rollback:true});
assert.deepEqual(await counts(),before,'Rollback must preserve all existing rows');
await closeDb();console.log(JSON.stringify({additiveMigration:'pass',transactionalRollback:'pass',tables:tables.length}));
