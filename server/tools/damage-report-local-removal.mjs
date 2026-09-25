// User-authorized removal of exactly the original report after its NetSuite line
// was manually deleted. Default is a read-only backup. No NetSuite writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool} from '../src/db.js';
import {damageNetSuite} from '../src/inventory-damage-netsuite.js';
const id='c419bbbe-fde7-4263-b97a-d3cf44449c44';
const client=await pool.connect();
let locked=false;
try {
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',['damage-month:1'])).rows[0].locked;
  assert.equal(locked,true,'Monthly transfer is busy; nothing was removed.');
  await client.query('BEGIN');
  const report=(await client.query('SELECT * FROM inventory_damage_reports WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert.ok(report,'The original report no longer exists.');
  assert.equal(report.month_id,'1');assert.equal(report.item_id,'5020');
  assert.equal(report.item_name,'UNI-WIN70S-0714-DC');assert.equal(Number(report.quantity),275.64);assert.equal(report.unit,'SQFT');
  assert.equal(report.status,'attention');assert.equal(report.safe_to_retry,false);
  const month=(await client.query('SELECT * FROM inventory_damage_months WHERE id=$1',[report.month_id])).rows[0];
  assert.equal(month.transfer_id,'998187');assert.equal(month.transfer_ref,'IT00551');
  assert.equal(month.location_id,'1');assert.equal(month.month,'2026-09');
  const photos=(await client.query('SELECT * FROM inventory_damage_photos WHERE report_id=$1 ORDER BY position',[id])).rows;
  const events=(await client.query('SELECT * FROM inventory_damage_events WHERE report_id=$1 ORDER BY id',[id])).rows;
  const snapshot={report,month,photos,events};
  const sha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const transfer=await damageNetSuite.get(month.transfer_id);
  assert.equal(transfer.id,'998187');assert.equal(transfer.tranId,'IT00551');
  assert.equal(transfer.location?.id,'1');assert.equal(transfer.transferLocation?.id,'10');
  assert.notEqual(transfer.inventory.hasMore,true);
  assert.equal(transfer.inventory.items.length,transfer.inventory.totalResults);
  assert.ok(transfer.inventory.items.every(line=>String(line.item?.id)!=='5020' && !String(line.description).includes(id)),
    'The item or report marker still exists in NetSuite; nothing was removed.');
  if(process.argv.includes('--remove')) {
    const expected=process.argv.find(arg=>arg.startsWith('--expected-sha256='))?.split('=')[1];
    assert.equal(sha256,expected,'Local data changed since the backup; nothing was removed.');
    const beforeCount=Number((await client.query('SELECT count(*) FROM inventory_damage_reports')).rows[0].count);
    const removedEvents=(await client.query('DELETE FROM inventory_damage_events WHERE report_id=$1',[id])).rowCount;
    const removedPhotos=(await client.query('DELETE FROM inventory_damage_photos WHERE report_id=$1',[id])).rowCount;
    const removedReports=(await client.query('DELETE FROM inventory_damage_reports WHERE id=$1',[id])).rowCount;
    assert.equal(removedEvents,events.length);assert.equal(removedPhotos,photos.length);assert.equal(removedReports,1);
    assert.equal(Number((await client.query('SELECT count(*) FROM inventory_damage_reports')).rows[0].count),beforeCount-1);
    assert.deepEqual((await client.query('SELECT * FROM inventory_damage_months WHERE id=$1',[month.id])).rows[0],month);
    await client.query('COMMIT');
    console.log(JSON.stringify({removed:true,id,item:report.item_name,quantity:Number(report.quantity),unit:report.unit,
      removedReports,removedPhotos,removedEvents,transfer:month.transfer_ref,netSuiteWrites:0,backupSha256:sha256},null,2));
  } else {
    await client.query('ROLLBACK');
    console.log(JSON.stringify({sha256,snapshot},null,2));
  }
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});throw error;
} finally {
  if(locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['damage-month:1']);
  client.release();await pool.end();
}
