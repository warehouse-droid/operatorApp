// Scoped recovery authorized by the user: retain one UCARA event in October.
// Default is read-only. --apply confirms existing lines and retries October once.
// --link-september-adjusted additionally requires the user's 9 -> 10 clarification.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pool,query,withTransaction} from '/app/src/db.js';
import {damageNetSuite} from '/app/src/inventory-damage-netsuite.js';
import {retryDamageReport} from '/app/src/inventory-damage-service.js';
import {damageRow,damageEvent} from '/app/src/inventory-damage-repository.js';
import {damageLineMatches,damageLineSnapshot} from '/app/src/inventory-damage-posting-proof.js';
import {damageMemoMonth} from '/app/src/inventory-workflow-domain.js';
import {withOperatorNetSuitePriority} from '/app/src/operator-netsuite-request-pool.js';

const ids={septemberPisa:'63794073-25d1-4911-b2e5-c7fc584fdefb',septemberUcara:'a203380a-4471-4cf4-b57a-4a6413f69227',
  octoberPisa:'bd4d6c99-5431-4dea-b51a-b0d9c86dc46f',octoberUcara:'5f2c9876-8fc8-4ac5-bdc3-9ce8f1e9cce1'};
const apply=process.argv.includes('--apply'),adjusted=process.argv.includes('--link-september-adjusted');
const actor={id:'damage-repair-authorized',role:'admin',roles:['admin']};
const backupPath='/tmp/damage-posting-retry-live-before.json';
const clients=[],locks=[];
let stockWrites=0;
try {
  const saved=await Promise.all(Object.values(ids).map(damageRow));assert.ok(saved.every(Boolean));
  const reports=Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,saved.find(row=>row.id===id)]));
  for(const [name,row] of Object.entries(reports)) {
    assert.equal(Number(row.location_id),1);assert.equal(row.month,name.startsWith('september')?'2026-09':'2026-10');
    assert.equal(Number(row.transfer_id),name.startsWith('september')?998187:1031838);assert.equal(row.photos.length,1);
  }
  assert.equal(reports.octoberPisa.item_name,'UNI-PISAS-COP-SAFARI');assert.equal(Number(reports.octoberPisa.quantity),18);
  assert.equal(reports.septemberPisa.item_name,'UNI-PISAS-COP-CG');assert.equal(Number(reports.septemberPisa.quantity),9);
  for(const [name,row] of [['septemberUcara',reports.septemberUcara],['octoberUcara',reports.octoberUcara]]) {
    assert.equal(row.item_name,'UNI-UCARA-COR-SM-DC');assert.equal(Number(row.quantity),27.09);assert.equal(row.unit,'SQFT');
    assert.equal(Number(row.unit_id),613);assert.equal(Number(row.reason_id),name==='septemberUcara'?8:9);
  }
  assert.equal(String(reports.septemberUcara.item_id),String(reports.octoberUcara.item_id));
  if(apply) {
    const bytes=readFileSync(backupPath);assert.equal(createHash('sha256').update(bytes).digest('hex'),process.env.DAMAGE_RETRY_BACKUP_SHA,'Private backup hash mismatch');
    const backup=JSON.parse(bytes);
    for(const row of saved) {
      const before=backup.reports.find(entry=>entry.id===row.id);assert.ok(before);
      for(const field of ['payload_hash','item_id','quantity','unit_id','reason_id','month_id','operator_id'])assert.equal(String(row[field]),String(before[field]));
      assert.deepEqual(row.photos,before.photos);
    }
    for(const month of [...new Set(saved.map(row=>row.month_id))].sort((a,b)=>Number(a)-Number(b))) {
      const client=await pool.connect();clients.push(client);const key=`damage-month:${month}`;
      assert.equal((await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked,true,'Damage month is busy');locks.push({client,key});
    }
  }
  const records=await withOperatorNetSuitePriority(()=>Promise.all(['998187','1031838'].map(id=>damageNetSuite.get(id))));
  for(const record of records) {
    assert.equal(Number(record.location.id),1);assert.equal(Number(record.transferLocation.id),10);
    assert.equal(damageMemoMonth(record.memo),Number(record.id)===998187?'2026-09':'2026-10');
  }
  const october=records.find(record=>Number(record.id)===1031838),september=records.find(record=>Number(record.id)===998187);
  const candidates=[];
  for(const name of ['octoberPisa',...(adjusted?['septemberPisa']:[])]) {
    const report=reports[name],record=name==='octoberPisa'?october:september;
    const expected=name==='septemberPisa'?{...report,quantity:10,reason_id:7}:report;
    const lines=record.inventory.items.filter(line=>damageLineMatches(line,expected));assert.equal(lines.length,1,`${name} has no unique verified line`);
    const line=lines[0];
    const claims=await query(`SELECT id FROM inventory_damage_reports r WHERE month_id=$1 AND id<>$2
      AND (transfer_line=$3 OR (transfer_line IS NULL AND item_id=$4 AND unit_id=$5 AND status IN ('pending','posting','attention')
        AND NOT EXISTS(SELECT 1 FROM inventory_damage_events e WHERE e.report_id=r.id AND e.action='superseded')))`,[report.month_id,report.id,line.line,report.item_id,report.unit_id]);
    assert.equal(claims.rowCount,0,'Another report owns this line');
    candidates.push({name,report,record,line});
  }
  const ucaraMatches=records.flatMap(record=>record.inventory.items.filter(line=>damageLineMatches(line,{...reports.octoberUcara,reason_id:line.custcol_atlas_rc_so?.id})).map(line=>({record,line})));
  if(reports.octoberUcara.status==='posted') {
    assert.equal(ucaraMatches.length,1);assert.equal(String(ucaraMatches[0].record.id),'1031838');
  } else {
    assert.equal(ucaraMatches.length,0,'UCARA already exists in NetSuite; reconcile before any additional movement');
    assert.equal(reports.octoberUcara.status,'attention');assert.equal(reports.octoberUcara.safe_to_retry,true);assert.equal(reports.octoberUcara.attempt_count,0);
  }
  const plan={existingLines:candidates.map(({report,record,line})=>({sku:report.item_name,transfer:record.tranId,line:line.line,originalQuantity:Number(report.quantity),currentQuantity:Number(line.adjustQtyBy)})),
    supersededReport:ids.septemberUcara,retainedReport:ids.octoberUcara,newTransferQuantity:reports.octoberUcara.status==='posted'?0:27.09,unit:'SQFT',newStockWrites:reports.octoberUcara.status==='posted'?0:1};
  if(!apply) {console.log(JSON.stringify({readOnly:true,plan},null,2));}
  else {
    await withTransaction(async()=>{
      for(const {report,record,line} of candidates) {
        const current=await damageRow(report.id);if(current.status==='posted'){assert.equal(current.transfer_line,Number(line.line));continue;}
        assert.equal(current.status,'attention');assert.equal(current.safe_to_retry,false);assert.equal(current.transfer_line,null);
        const result=await query("UPDATE inventory_damage_reports SET status='posted',safe_to_retry=false,transfer_line=$2,last_error=NULL,posted_at=COALESCE(posted_at,now()),updated_at=now() WHERE id=$1 AND status='attention' AND safe_to_retry=false AND transfer_line IS NULL",[report.id,line.line]);assert.equal(result.rowCount,1);
        await damageEvent(report.id,'reconciled',{authorization:'User requested resolution; existing stock movement verified, no resend',transferId:record.id,transferRef:record.tranId,
          line:line.line,originalQuantity:Number(report.quantity),current:damageLineSnapshot(line),adjusted:nameIsAdjusted(report.id),stockWrites:0});
      }
      const duplicate=await damageRow(ids.septemberUcara);
      if(duplicate.status!=='superseded') {
        assert.equal(duplicate.status,'attention');assert.equal(duplicate.safe_to_retry,true);assert.equal(duplicate.attempt_count,0);
        await query("UPDATE inventory_damage_reports SET safe_to_retry=false,last_error='Same damage event as the October report; superseded without moving stock.',updated_at=now() WHERE id=$1 AND status='attention'",[duplicate.id]);
        await damageEvent(duplicate.id,'superseded',{replacementReportId:ids.octoberUcara,authorization:'User confirmed same event; post once in October',stockWrites:0});
      }
    });
    for(const {client,key} of locks.splice(0))await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
    if(reports.octoberUcara.status!=='posted') {
      const result=await withOperatorNetSuitePriority(()=>retryDamageReport(actor,ids.octoberUcara));
      assert.equal(result.status,'posted',result.last_error);stockWrites=1;
    }
    const final=await withOperatorNetSuitePriority(()=>damageNetSuite.get('1031838'));
    assert.equal(final.inventory.items.length,october.inventory.items.length+(stockWrites?1:0));
    for(const line of october.inventory.items)assert.deepEqual(damageLineSnapshot(final.inventory.items.find(row=>Number(row.line)===Number(line.line))),damageLineSnapshot(line));
    const ucara=final.inventory.items.filter(line=>damageLineMatches(line,reports.octoberUcara));assert.equal(ucara.length,1);
    const retained=await damageRow(ids.octoberUcara),duplicate=await damageRow(ids.septemberUcara);assert.equal(retained.photos.length,1);assert.equal(duplicate.photos.length,1);assert.equal(duplicate.status,'superseded');
    console.log(JSON.stringify({applied:true,stockWrites,plan,transfer:final.tranId,lines:final.inventory.items.map(damageLineSnapshot),
      reports:(await Promise.all(Object.values(ids).map(damageRow))).map(row=>({id:row.id,sku:row.item_name,status:row.status,transferLine:row.transfer_line,photoCount:row.photos.length}))},null,2));
  }
} finally {
  for(const {client,key} of locks)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});
  for(const client of clients)client.release();await pool.end();
}
function nameIsAdjusted(id) {return id===ids.septemberPisa;}
