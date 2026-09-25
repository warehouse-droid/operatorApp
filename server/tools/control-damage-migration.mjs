import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const fixtureId=randomUUID();
try {
 const month=(await query('SELECT id FROM inventory_damage_months ORDER BY id LIMIT 1')).rows[0];
 const actor=(await query("SELECT id FROM operators WHERE role='yard_manager' ORDER BY id LIMIT 1")).rows[0];
 assert.ok(month && actor,'Run the focused fixtures before the migration rehearsal');
 await query(`INSERT INTO inventory_damage_adjustments(id,month_id,transfer_id,actor_id,request_hash,plan,status,safe_to_retry)
   VALUES($1,$2,998187,$3,'rollback-fixture',$4,'posted',false)`,[fixtureId,month.id,actor.id,JSON.stringify({note:'Preserve this saved adjustment',before:[{line:1,adjustQtyBy:3}],updated:[],removed:[],added:[]})]);
 const existing=(await query('SELECT * FROM inventory_damage_adjustments ORDER BY id')).rows;
 const reports=(await query('SELECT id,status,quantity FROM inventory_damage_reports ORDER BY id')).rows;
 await withTransaction(async()=>{
  await query('DROP TABLE inventory_damage_adjustments');
  await query(readFileSync('migrations/221_control_damage_adjustments.sql','utf8'));
  assert.equal(Number((await query('SELECT count(*) FROM inventory_damage_adjustments')).rows[0].count),0);
 },{rollback:true});
 assert.deepEqual((await query('SELECT * FROM inventory_damage_adjustments ORDER BY id')).rows,existing);
 assert.deepEqual((await query('SELECT id,status,quantity FROM inventory_damage_reports ORDER BY id')).rows,reports);
 assert.ok(existing.some(row=>row.id===fixtureId));
 console.log(JSON.stringify({additiveMigration:'pass',rollbackPreservesAdjustmentsAndReports:true,savedAdjustments:existing.length}));
} finally {await query('DELETE FROM inventory_damage_adjustments WHERE id=$1',[fixtureId]);await closeDb();}
