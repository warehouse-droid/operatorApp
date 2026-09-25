// Recovery is restricted to the user's original, definitively rejected report.
// Default is read-only; --retry invokes the normal locked/idempotent posting path.
import assert from 'node:assert/strict';
import {pool,query} from '../src/db.js';
import {damageNetSuite} from '../src/inventory-damage-netsuite.js';
import {processDamageReport} from '../src/inventory-damage-service.js';
const id='c419bbbe-fde7-4263-b97a-d3cf44449c44';
async function saved() {
  return (await query(`SELECT r.*,m.location_id,m.month,m.transfer_id,m.transfer_ref,
    (SELECT count(*) FROM inventory_damage_photos p WHERE p.report_id=r.id) AS photo_count
    FROM inventory_damage_reports r JOIN inventory_damage_months m ON m.id=r.month_id WHERE r.id=$1`,[id])).rows[0];
}
const lineSnapshot=line=>({line:line.line,item:String(line.item?.id),quantity:Number(line.adjustQtyBy),unit:String(line.units),reason:String(line.custcol_atlas_rc_so?.id),description:line.description});
try {
  let report=await saved();
  assert.equal(report.item_id,'5020');assert.equal(Number(report.quantity),275.64);assert.equal(report.unit,'SQFT');
  assert.equal(report.location_id,'1');assert.equal(report.month,'2026-09');assert.equal(report.transfer_id,'998187');
  assert.equal(report.reason_id,8);assert.equal(Number(report.photo_count),1);
  const before=await damageNetSuite.get(report.transfer_id);
  const priorLines=before.inventory.items.map(lineSnapshot);
  if(process.argv.includes('--retry') && report.status!=='posted') {
    assert.equal(report.status,'attention');assert.equal(report.safe_to_retry,true);
    assert.match(report.last_error,/400.*description.*maximum number \( 40 \)/);
    await processDamageReport(id);
    report=await saved();
  }
  const record=await damageNetSuite.get(report.transfer_id);
  assert.equal(record.location.id,'1');assert.equal(record.transferLocation.id,'10');
  assert.equal(record.tranId,'IT00551');assert.equal(record.memo,'3445 2026 Sep Damage');
  const lines=record.inventory.items.map(lineSnapshot);
  for(const line of priorLines) assert.deepEqual(lines.find(row=>row.line===line.line),line,'An existing transfer line changed');
  const matching=lines.filter(line=>line.description===`DMG:${id}` || String(line.description).includes(`[Damage report ${id}]`));
  if(process.argv.includes('--retry') || report.status==='posted') {
    assert.equal(report.status,'posted',report.last_error);assert.equal(matching.length,1);
    assert.equal(matching[0].item,report.item_id);assert.equal(matching[0].quantity,Number(report.quantity));
    assert.equal(matching[0].unit,String(report.unit_id));assert.equal(matching[0].reason,String(report.reason_id));
    assert.equal(matching[0].line,report.transfer_line);assert.equal(Number(report.photo_count),1);
  }
  const units=await damageNetSuite.units(record);
  console.log(JSON.stringify({id,status:report.status,item:report.item_name,quantity:Number(report.quantity),unit:report.unit,
    transfer:record.tranId,transferId:record.id,transferLine:report.transfer_line,postedAt:report.posted_at,
    matchingLines:matching.length,netSuiteUnit:units[String(report.unit_id)],beforeLineCount:priorLines.length,
    afterLineCount:lines.length,photoCount:Number(report.photo_count),lastError:report.last_error},null,2));
} finally {await pool.end();}
