import {createHash} from 'node:crypto';
import {pool,query,withTransaction} from './db.js';
import {assertInventoryYard,damageDestination,damageMemoMonth,inventoryError,inventoryId,inventoryMonth} from './inventory-workflow-domain.js';
import {damageRequestId} from './inventory-damage-repository.js';
import {damageTransferRevision,planDamageAdjustment,damageAdjustmentApplied} from './control-damage-domain.js';
import {controlDamageNetSuite} from './control-damage-netsuite.js';

function canonical(value) {
  if(Array.isArray(value)) {return value.map(canonical);}
  if(value && typeof value==='object') {return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));}
  return value;
}
const rowSql=`SELECT a.*,m.location_id,m.month,m.transfer_ref,o.display_name AS actor_name
  FROM inventory_damage_adjustments a JOIN inventory_damage_months m ON m.id=a.month_id
  LEFT JOIN operators o ON o.id=a.actor_id`;
async function row(id) {return (await query(`${rowSql} WHERE a.id=$1`,[damageRequestId(id)])).rows[0] || null;}
export async function getDamageAdjustment(actor,id) {
  const result=await row(id);
  if(!result) {throw inventoryError('Damage adjustment not found.',404);}
  assertInventoryYard(actor,result.location_id,true);return result;
}
async function monthlyLock(monthId,action,{required=false}={}) {
  const client=await pool.connect(),key=`damage-month:${monthId}`;
  let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
    if(!locked) {if(required) {throw inventoryError('This monthly transfer is being updated. Try again shortly.',409);}return;}
    return await action();
  } finally {
    let destroy=false;
    if(locked) {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{destroy=true;});}
    client.release(destroy);
  }
}
async function verifyScope(record,locationId,month,transferId,remote) {
  const destination=damageDestination(await remote.directory(),Number(locationId));
  if(String(record?.id)!==String(transferId) || Number(record.location?.id)!==Number(locationId)
    || Number(record.transferLocation?.id)!==destination.destinationId || damageMemoMonth(record.memo)!==month) {
    throw inventoryError('This Inventory Transfer does not belong to the selected yard and damage month.',409);
  }
}
async function validateItems(plan,locationId,remote) {
  const wanted=[...plan.updated,...plan.added],items=new Map(),labels={items:{},units:{}};
  for(const line of wanted) {
    const id=line.item.id;
    if(!items.has(id)) {
      const item=await remote.item(id,locationId);
      if(!item || Number(item.item_id)!==Number(id) || Number(item.location_id)!==Number(locationId) || item.item_type!=='InvtPart') {throw inventoryError('Choose an active inventory SKU at this yard.');}
      items.set(id,await remote.itemUnits(id));labels.items[id]=item.item_name;
      for(const unit of items.get(id)) {labels.units[String(unit.id)]=unit.label;}
    }
    const prior=plan.before.find(entry=>Number(entry.line)===line.line);
    const retainsUnit=prior && String(prior.item?.id)===String(id) && String(prior.units)===String(line.units);
    if(!retainsUnit && !items.get(id).some(unit=>String(unit.id)===String(line.units))) {throw inventoryError('Choose a valid unit for this SKU.');}
    if(prior?.inventoryDetail?.inventoryAssignment?.items?.length &&
      (Number(prior.item?.id)!==Number(id) || String(prior.units)!==line.units || Number(prior.adjustQtyBy)!==line.adjustQtyBy)) {
      throw inventoryError('This line has bin or lot assignments. Its item, quantity and unit must be adjusted with those assignments in NetSuite.',409);
    }
  }
  return labels;
}
async function blocked(monthId,id,{pending=false}={}) {
  const result=await query(`SELECT id FROM inventory_damage_adjustments WHERE month_id=$1 AND id<>$2
    AND (status='posting' OR (status='attention' AND safe_to_retry=false) OR ($3::boolean AND status='pending'))
    UNION ALL SELECT id FROM inventory_damage_reports r WHERE month_id=$1 AND (status='posting' OR (status='attention' AND safe_to_retry=false))
    AND NOT EXISTS(SELECT 1 FROM inventory_damage_events e WHERE e.report_id=r.id AND e.action='superseded') LIMIT 1`,[monthId,id,pending]);
  if(result.rowCount) {throw inventoryError('Another change for this month is still posting or needs reconciliation.',409);}
}
function replay(existing,hash) {
  if(existing.request_hash!==hash) {throw inventoryError('This adjustment ID was already used for different changes.',409);}
  return existing;
}
export async function queueDamageAdjustment(actor,input,{remote=controlDamageNetSuite}={}) {
  const locationId=assertInventoryYard(actor,input.locationId,true),month=inventoryMonth(input.month),transferId=inventoryId(input.transferId,'Inventory Transfer');
  const id=damageRequestId(input.requestId),hash=createHash('sha256').update(JSON.stringify(canonical([actor.id,{...input,requestId:id}]))).digest('hex');
  const previous=await row(id);if(previous) {return replay(previous,hash);}
  const monthly=(await query(`INSERT INTO inventory_damage_months(location_id,month,external_id) VALUES($1,$2,$3)
    ON CONFLICT(location_id,month) DO UPDATE SET location_id=EXCLUDED.location_id RETURNING *`,[locationId,month,`mbbs-damage-${locationId}-${month}`])).rows[0];
  return monthlyLock(monthly.id,async()=>{
    const repeated=await row(id);if(repeated) {return replay(repeated,hash);}
    await blocked(monthly.id,id,{pending:true});
    if(monthly.transfer_id && Number(monthly.transfer_id)!==transferId) {throw inventoryError('This month is already linked to another Inventory Transfer.',409);}
    const record=await remote.get(transferId);await verifyScope(record,locationId,month,transferId,remote);
    const matches=await remote.findMonthly({locationId,month});
    if(matches.length!==1 || String(matches[0].id)!==String(transferId)) {throw inventoryError('Resolve the duplicate or missing monthly Inventory Transfer before editing.',409);}
    const plan=planDamageAdjustment(record,{...input,requestId:id});
    plan.labels=await validateItems(plan,locationId,remote);
    if(remote.units) {try {Object.assign(plan.labels.units,await remote.units(record));} catch { /* Unit IDs remain available in the audit. */ }}
    return withTransaction(async()=>{
      const inserted=await query(`INSERT INTO inventory_damage_adjustments(id,month_id,transfer_id,actor_id,request_hash,plan)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id`,[id,monthly.id,transferId,actor.id,hash,JSON.stringify(plan)]);
      if(inserted.rowCount) {await query('UPDATE inventory_damage_months SET transfer_id=$2,transfer_ref=$3 WHERE id=$1',[monthly.id,transferId,record.tranId || String(transferId)]);}
      return replay(await row(id),hash);
    });
  },{required:true});
}
async function confirmed(adjustment) {
  await query("UPDATE inventory_damage_adjustments SET status='posted',safe_to_retry=false,last_error=NULL,posted_at=COALESCE(posted_at,now()),updated_at=now() WHERE id=$1",[adjustment.id]);
}
async function attempt(adjustment,remote) {
  let wrote=false,acknowledged=false;
  const uncertain=adjustment.status==='posting' || (adjustment.status==='attention' && !adjustment.safe_to_retry);
  try {
    let record=await remote.get(adjustment.transfer_id);
    await verifyScope(record,adjustment.location_id,adjustment.month,adjustment.transfer_id,remote);
    if(damageAdjustmentApplied(record,adjustment.plan)) {return confirmed(adjustment);}
    if(uncertain) {throw inventoryError('The previous update outcome is still unknown. No changes were resent. Recheck after NetSuite reconciliation.',409);}
    if(damageTransferRevision(record)!==adjustment.plan.revision) {
      await query("UPDATE inventory_damage_adjustments SET status='conflict',safe_to_retry=false,last_error='The transfer changed before this adjustment could be saved. Refresh it and review your changes.',updated_at=now() WHERE id=$1",[adjustment.id]);return;
    }
    await blocked(adjustment.month_id,adjustment.id);
    await validateItems(adjustment.plan,adjustment.location_id,remote);
    record=await remote.get(adjustment.transfer_id);
    if(damageTransferRevision(record)!==adjustment.plan.revision) {
      await query("UPDATE inventory_damage_adjustments SET status='conflict',safe_to_retry=false,last_error='The transfer changed during validation. Refresh it and review your changes.',updated_at=now() WHERE id=$1",[adjustment.id]);return;
    }
    await query("UPDATE inventory_damage_adjustments SET status='posting',safe_to_retry=false,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1",[adjustment.id]);
    wrote=true;await remote.apply(adjustment.transfer_id,adjustment.plan);acknowledged=true;
    record=await remote.get(adjustment.transfer_id);
    if(!damageAdjustmentApplied(record,adjustment.plan)) {throw inventoryError('NetSuite has not confirmed all of these changes. Recheck posting before editing again.',409);}
    await confirmed(adjustment);
  } catch(error) {
    const definitive=!acknowledged && error.netsuiteResponseReceived===true && error.status>=400 && error.status<500 && ![408,409,429].includes(error.status);
    await query("UPDATE inventory_damage_adjustments SET status='attention',safe_to_retry=$2,last_error=$3,updated_at=now() WHERE id=$1",[adjustment.id,!uncertain && (!wrote || definitive),String(error.message).slice(0,2000)]);
  }
}
export async function processDamageAdjustment(id,{remote=controlDamageNetSuite}={}) {
  const adjustment=await row(id);
  if(!adjustment || ['posted','conflict'].includes(adjustment.status)) {return;}
  await monthlyLock(adjustment.month_id,async()=>{
    const latest=await row(id);if(!['posted','conflict'].includes(latest.status)) {await attempt(latest,remote);}
  });
}
export async function retryDamageAdjustment(actor,id,options={}) {
  const adjustment=await getDamageAdjustment(actor,id);
  if(adjustment.status==='conflict') {throw inventoryError('Refresh the transfer and review your changes before saving a new adjustment.',409);}
  if(adjustment.status==='attention' && adjustment.safe_to_retry) {await query("UPDATE inventory_damage_adjustments SET status='pending',last_error=NULL,updated_at=now() WHERE id=$1 AND status='attention' AND safe_to_retry=true",[id]);}
  await processDamageAdjustment(id,options);return getDamageAdjustment(actor,id);
}
let ticking=false;
export async function damageAdjustmentTick(options={}) {
  if(ticking) {return;}ticking=true;
  try {for(const adjustment of (await query("SELECT id FROM inventory_damage_adjustments WHERE status IN ('pending','posting') ORDER BY created_at LIMIT 20")).rows) {await processDamageAdjustment(adjustment.id,options);}}
  finally {ticking=false;}
}
