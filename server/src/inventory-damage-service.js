import {pool,query,withTransaction} from './db.js';
import {damageDestination,damageMemo,inventoryError,inventoryMonth} from './inventory-workflow-domain.js';
import {damageRow,damageEvent,recordDamage,getDamageReport,listDamageReports} from './inventory-damage-repository.js';
import {damageNetSuite,getDamageItem} from './inventory-damage-netsuite.js';
import {recoverDamagePhotoLines} from './inventory-damage-photo-links.js';
import {damagePostingProof,damageReceiptMemo,confirmedDamageProofLine} from './inventory-damage-posting-proof.js';
export {getDamageReport};
export async function submitDamageReport(actor,input,dependencies={}) {return recordDamage(actor,input,{getItem:getDamageItem,...dependencies});}

function marker(report) {return `DMG:${report.id}`;}
function matchesReport(line,report) {
  const description=String(line.description || '');
  return description===marker(report) || description.includes(`[Damage report ${report.id}]`);
}
function lineFor(report) {
  return {item:{id:String(report.item_id)},adjustQtyBy:Number(report.quantity),units:String(report.unit_id),
    custcol_atlas_rc_so:{id:String(report.reason_id)},description:marker(report)};
}
function verifyRecord(record,report,destination) {
  if(!record || Number(record.location?.id)!==Number(report.location_id) || Number(record.transferLocation?.id)!==destination.destinationId) {throw inventoryError('The monthly transfer locations do not match this report.',409);}
}
function reportedLine(record,report,proof) {
  const lines=(record?.inventory?.items || []).filter(line=>matchesReport(line,report));
  if(lines.length>1) {throw inventoryError('More than one NetSuite line matches this report. Reconciliation is required.',409);}
  const line=lines[0];
  if(line && (Number(line.item?.id)!==Number(report.item_id) || Math.abs(Number(line.adjustQtyBy)-Number(report.quantity))>1e-6
      || String(line.units)!==String(report.unit_id) || String(line.custcol_atlas_rc_so?.id)!==String(report.reason_id))) {throw inventoryError('The posted line differs from this report. Reconciliation is required.',409);}
  return line || confirmedDamageProofLine(record,report,proof);
}
async function lastPostingProof(id) {
  return (await query("SELECT details FROM inventory_damage_events WHERE report_id=$1 AND action='posting_started' ORDER BY id DESC LIMIT 1",[id])).rows[0]?.details;
}
async function bindTransfer(report,record) {
  await query('UPDATE inventory_damage_months SET transfer_id=$2,transfer_ref=$3 WHERE id=$1',[report.month_id,record.id,record.tranId || String(record.id)]);
}
async function posted(report,record,line) {
  return withTransaction(async()=>{
    await bindTransfer(report,record);
    await query("UPDATE inventory_damage_reports SET status='posted',safe_to_retry=false,transfer_line=$2,last_error=NULL,posted_at=now(),updated_at=now() WHERE id=$1",[report.id,line.line]);
    await damageEvent(report.id,'posted',{transferId:record.id,transferRef:record.tranId,line:line.line});
  });
}
async function resolveTransfer(remote,report) {
  if(report.transfer_id) {return remote.get(report.transfer_id);}
  const identified=await remote.findExternal(report.external_id);
  if(identified) {return identified;}
  const records=await remote.findMonthly({locationId:Number(report.location_id),month:report.month});
  if(records.length>1) {throw inventoryError(`Multiple monthly transfers found: ${records.map(r=>r.tranId || r.id).join(', ')}. Resolve them before posting.`,409);}
  return records[0] || null;
}
async function postingAttempt(report,remote) {
  let wrote=false,acknowledged=false;
  const uncertain=report.status==='posting' || (report.status==='attention' && !report.safe_to_retry);
  try {
    let proof=await lastPostingProof(report.id);
    const destination=damageDestination(await remote.directory(),report.location_id);
    let record=await resolveTransfer(remote,report);
    if(record) {
      verifyRecord(record,report,destination);
      const line=reportedLine(record,report,proof);
      if(line) {return posted(report,record,line);}
      await bindTransfer(report,record);
    }
    if(uncertain) {throw inventoryError('The previous posting outcome is still unknown. No additional stock was transferred. Recheck after NetSuite reconciliation.',409);}
    const blocked=await query(`SELECT id FROM inventory_damage_reports r WHERE month_id=$1 AND id<>$2 AND (status='posting' OR (status='attention' AND safe_to_retry=false))
      AND NOT EXISTS(SELECT 1 FROM inventory_damage_events e WHERE e.report_id=r.id AND e.action='superseded')
      UNION ALL SELECT id FROM inventory_damage_adjustments WHERE month_id=$1 AND (status='posting' OR (status='attention' AND safe_to_retry=false)) LIMIT 1`,[report.month_id,report.id]);
    if(blocked.rowCount) {throw inventoryError('Another report in this month needs reconciliation before posting can continue.',409);}
    const memo=damageReceiptMemo(record?.memo || damageMemo(Number(report.location_id),report.month),report.id);
    proof=damagePostingProof(report,record,memo);
    await withTransaction(async()=>{
      await damageEvent(report.id,'posting_started',proof);
      await query("UPDATE inventory_damage_reports SET status='posting',safe_to_retry=false,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1",[report.id]);
    });
    wrote=true;
    if(record) {
      await remote.append(record.id,lineFor(report),{memo});acknowledged=true;record=await remote.get(record.id);
    } else {
      record=await remote.create({externalId:report.external_id,customForm:{id:'164'},custbody2:{id:'8721'},custbody3:{id:'1'},
        subsidiary:{id:String(destination.subsidiaryId)},location:{id:String(destination.sourceId)},transferLocation:{id:String(destination.destinationId)},
        memo,tranDate:typeof report.accepted_date==='string'?report.accepted_date.slice(0,10):report.accepted_date.toISOString().slice(0,10),inventory:{items:[lineFor(report)]}});
      acknowledged=true;
    }
    verifyRecord(record,report,destination);
    const line=reportedLine(record,report,proof);
    if(!line) {throw inventoryError('NetSuite has not confirmed the damage line. Reconciliation is required.',409);}
    await posted(report,record,line);
  } catch(error) {
    const definitive=!acknowledged && !error.damageWriteAcknowledged && error.netsuiteResponseReceived===true && error.status>=400 && error.status<500 && ![408,409,429].includes(error.status);
    const safe=!uncertain && (!wrote || definitive);
    await query("UPDATE inventory_damage_reports SET status='attention',safe_to_retry=$2,last_error=$3,updated_at=now() WHERE id=$1",[report.id,safe,String(error.message).slice(0,2000)]);
    await damageEvent(report.id,'attention',{safeToRetry:safe,error:String(error.message).slice(0,2000)});
  }
}
export async function processDamageReport(id,{remote=damageNetSuite}={}) {
  const report=await damageRow(id);
  if(!report || ['posted','superseded'].includes(report.status)) {return;}
  const client=await pool.connect(),key=`damage-month:${report.month_id}`;
  let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
    if(!locked) {return;}
    const latest=await damageRow(id);
    if(!['posted','superseded'].includes(latest.status)) {await postingAttempt(latest,remote);}
  } finally {
    let destroy=false;
    if(locked) {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{destroy=true;});}
    client.release(destroy);
  }
}
export async function retryDamageReport(actor,id,options={}) {
  const report=await getDamageReport(actor,id);
  if(report.status==='attention' && report.safe_to_retry) {await query("UPDATE inventory_damage_reports SET status='pending',last_error=NULL WHERE id=$1 AND status='attention' AND safe_to_retry=true",[id]);}
  await processDamageReport(id,options);
  return getDamageReport(actor,id);
}
function originalReport(report) {
  return {item_id:report.item_id,item_name:report.item_name,quantity:report.quantity,unit:report.unit,unit_id:report.unit_id,
    reason_id:report.reason_id,reason_label:report.reason_label,values:report.values};
}
function currentReport(report,line,units) {
  const original=originalReport(report);
  const adjusted=Number(line.item?.id)!==Number(report.item_id) || Math.abs(Number(line.adjustQtyBy)-Number(report.quantity))>1e-6
    || String(line.units)!==String(report.unit_id) || String(line.custcol_atlas_rc_so?.id)!==String(report.reason_id);
  Object.assign(report,{original,adjusted,item_id:line.item?.id,item_name:line.item?.refName || report.item_name,
    quantity:Number(line.adjustQtyBy),unit_id:line.units,unit:units[String(line.units)] || (String(line.units)===String(original.unit_id)?original.unit:`UOM ${line.units}`),
    reason_id:line.custcol_atlas_rc_so?.id,reason_label:line.custcol_atlas_rc_so?.refName || report.reason_label,
    transfer_line:line.line,values:adjusted?null:report.values});
}
export async function reviewDamageMonth(actor,locationId,month,{remote=damageNetSuite,management=false}={}) {
  inventoryMonth(month);
  const reports=await listDamageReports(actor,locationId,month,{management});
  let transfers=[],syncError=null;
  try {transfers=await remote.findMonthly({locationId:Number(locationId),month});} catch(error) {syncError=error.message;}
  const recovered=recoverDamagePhotoLines(transfers,reports);
  const seen=new Set();
  for(const transfer of transfers) {
    let units=Object.fromEntries(reports.filter(report=>!report.legacy && report.unit_id && report.unit).map(report=>[String(report.unit_id),report.unit]));
    if((transfer.inventory?.items || []).some(line=>!units[String(line.units)])) {
      try {units={...units,...(remote.units ? await remote.units(transfer) : {})};} catch { /* The transfer's unit ID remains available. */ }
    }
    for(const line of transfer.inventory?.items || []) {
      const local=reports.find(report=>!report.legacy && (matchesReport(line,report)
        || (recovered.get(report.id)?.transferId===String(transfer.id) && recovered.get(report.id)?.line===Number(line.line))
        || (!/^(?:DMG:|C:)|\[Damage report /.test(String(line.description || ''))
          && String(report.transfer_id)===String(transfer.id) && Number(report.transfer_line)===Number(line.line))));
      if(local) {
        seen.add(local.id);
        if(local.status==='posted') {currentReport(local,line,units);}
        else if(recovered.has(local.id)) {local.transfer_line=Number(line.line);}
        continue;
      }
      reports.push({id:`netsuite-${transfer.id}-${line.line}`,item_id:line.item?.id,item_name:line.item?.refName || line.description,
        quantity:line.adjustQtyBy,unit:units[String(line.units)] || line.unitLabel || `UOM ${line.units}`,reason_label:line.custcol_atlas_rc_so?.refName || '',
        unit_id:line.units,reason_id:line.custcol_atlas_rc_so?.id,transfer_line:line.line,
        photos:[],status:'posted',transfer_id:transfer.id,transfer_ref:transfer.tranId,created_at:transfer.tranDate,operator_name:null,legacy:true});
    }
  }
  if(!syncError) {for(const report of reports.filter(row=>!row.legacy && row.status==='posted' && !seen.has(row.id))) {
    report.original=originalReport(report);
    if(transfers.some(transfer=>String(transfer.id)===String(report.transfer_id))) {report.status='removed';report.quantity=0;report.adjusted=true;report.values=null;}
    else {report.status='missing';report.last_error='The linked Inventory Transfer was not found for this yard and month.';}
  }}
  return {month,locationId:Number(locationId),reports,transfers:transfers.map(t=>({id:t.id,ref:t.tranId})),syncError};
}
let ticking=false;
export async function damagePostingTick(options={}) {
  if(ticking) {return;}
  ticking=true;
  try {
    const rows=(await query("SELECT id FROM inventory_damage_reports WHERE status IN ('pending','posting') ORDER BY created_at LIMIT 20")).rows;
    for(const row of rows) {await processDamageReport(row.id,options);}
  } finally {ticking=false;}
}
