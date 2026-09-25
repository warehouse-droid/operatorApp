import {createHash} from 'node:crypto';
import {query,withTransaction} from './db.js';
import {assertInventoryYard,inventoryYards,inventoryDate,inventoryError,inventoryId,inventoryMonth,quantitySnapshot} from './inventory-workflow-domain.js';
import {CONFIRMED_RETURN_REASONS} from './return-netsuite.js';
import {normalizeR2Key,createPhotoReadToken,isOperatorReturnPhotoForActor} from './photo-upload.js';
import {readArchivedPhoto} from './photo-archive-repository.js';

export function damageRequestId(value) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))) {throw inventoryError('A valid report ID is required.');}
  return String(value).toLowerCase();
}
function canonical(value) {
  if(Array.isArray(value)) {return value.map(canonical);}
  if(value && typeof value==='object') {return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));}
  return value;
}
export function damagePhotoReference(value,actorId,locationId,requestId) {
  const key=normalizeR2Key(value),parts=key.split('/');
  if(!String(value).startsWith('r2://') || parts[1]!=='operator-damage-photo'
    || !isOperatorReturnPhotoForActor(key.replace('/operator-damage-photo/','/operator-return-photo/'),actorId)
    || parts[6]!==`yard-${locationId}` || parts[7]!==requestId || parts.length<9) {throw inventoryError('A fresh photo upload for this report and yard is required.');}
  return `r2://${key}`;
}
export async function verifyDamagePhotos(references,operatorId,{readPhoto=readArchivedPhoto,ticket=createPhotoReadToken,fetchPhoto=fetch}={}) {
  for(const reference of references) {
    const archived=await readPhoto(reference);
    if(archived?.available) {continue;}
    const readTicket=ticket({actor:{id:operatorId,role:'operator'},key:reference,ttlMinutes:2});
    const response=await fetchPhoto(readTicket.objectUrl,{headers:{Authorization:`Bearer ${readTicket.token}`,Range:'bytes=0-0'},signal:AbortSignal.timeout(15000)});
    const valid=response.ok && /^image\//i.test(response.headers.get('content-type') || '');
    await response.body?.cancel().catch(()=>{});
    if(!valid) {throw inventoryError('The damage photo upload could not be verified. Try again.',409);}
  }
}
const reportSql=`SELECT r.*,m.location_id,m.month,m.transfer_id,m.transfer_ref,m.external_id,
  o.display_name AS operator_name,COALESCE((SELECT jsonb_agg(p.photo_reference ORDER BY p.position)
    FROM inventory_damage_photos p WHERE p.report_id=r.id),'[]') AS photos
  FROM inventory_damage_reports r JOIN inventory_damage_months m ON m.id=r.month_id
  LEFT JOIN operators o ON o.id=r.operator_id`;
export async function damageRow(id) {
  return (await query(`${reportSql} WHERE r.id=$1`,[damageRequestId(id)])).rows[0] || null;
}
export async function getDamageReport(actor,id) {
  const row=await damageRow(id);
  if(!row) {throw inventoryError('Damage report not found.',404);}
  assertInventoryYard(actor,row.location_id);
  return row;
}
export async function recordDamage(actor,input,{getItem,verifyPhotos=verifyDamagePhotos,now=()=>new Date()}) {
  const locationId=assertInventoryYard(actor,input.locationId),id=damageRequestId(input.requestId),itemId=inventoryId(input.itemId,'SKU');
  const reason=CONFIRMED_RETURN_REASONS.find(r=>r.kind==='quality' && r.id===Number(input.reasonId));
  if(!reason) {throw inventoryError('Choose a damage reason.');}
  if(!Array.isArray(input.photos) || input.photos.length<1 || input.photos.length>5 || new Set(input.photos).size!==input.photos.length) {throw inventoryError('Take at least one photo (maximum five).');}
  const photos=input.photos.map(photo=>damagePhotoReference(photo,actor.id,locationId,id));
  const hash=createHash('sha256').update(JSON.stringify(canonical([actor.id,locationId,itemId,input.values,reason.id,photos]))).digest('hex');
  const retry=await damageRow(id);
  if(retry) {
    if(retry.payload_hash!==hash) {throw inventoryError('This report ID was already used for different details.',409,'INVENTORY_RETRY_CONFLICT');}
    return getDamageReport(actor,id);
  }
  const item=await getItem(itemId,locationId);
  if(!item || Number(item.item_id)!==itemId || Number(item.location_id)!==locationId || item.item_type!=='InvtPart') {throw inventoryError('Select an inventory SKU at this yard.');}
  const count=quantitySnapshot(item,input.values,{damage:true});
  await verifyPhotos(photos,actor.id);
  const date=inventoryDate(now()),month=date.slice(0,7);
  return withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`damage-report:${id}`]);
    const existing=await damageRow(id);
    if(existing) {
      if(existing.payload_hash!==hash) {throw inventoryError('This report ID was already used for different details.',409,'INVENTORY_RETRY_CONFLICT');}
      return getDamageReport(actor,id);
    }
    const monthly=(await query(`INSERT INTO inventory_damage_months(location_id,month,external_id) VALUES($1,$2,$3)
      ON CONFLICT(location_id,month) DO UPDATE SET location_id=EXCLUDED.location_id RETURNING id`,[locationId,month,`mbbs-damage-${locationId}-${month}`])).rows[0];
    await query(`INSERT INTO inventory_damage_reports(id,payload_hash,month_id,operator_id,item_id,item_name,quantity,unit,unit_id,values,conversions,reason_id,reason_label,accepted_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id,hash,monthly.id,actor.id,itemId,item.item_name,count.quantity,count.unit,count.unitId,JSON.stringify(count.values),JSON.stringify(count.conversions),reason.id,reason.label,date]);
    for(const [position,photo] of photos.entries()) {await query('INSERT INTO inventory_damage_photos(report_id,photo_reference,position) VALUES($1,$2,$3)',[id,photo,position]);}
    await damageEvent(id,'accepted',{actorId:actor.id,quantity:count.quantity,unit:count.unit,month});
    return getDamageReport(actor,id);
  });
}
export async function damageEvent(id,action,details={}) {
  await query('INSERT INTO inventory_damage_events(report_id,action,details) VALUES($1,$2,$3)',[id,action,JSON.stringify(details)]);
}
export async function listDamageReports(actor,locationId,month,{management=false}={}) {
  assertInventoryYard(actor,locationId,management);inventoryMonth(month);
  return (await query(`${reportSql} WHERE m.location_id=$1 AND m.month=$2 ORDER BY r.created_at DESC,r.id`,[locationId,month])).rows;
}
export async function assertDamagePhotoAccess(actor,reference) {
  const key=normalizeR2Key(reference),parts=key.split('/');
  if(parts[1]!=='operator-damage-photo') {return false;}
  const row=(await query(`SELECT m.location_id FROM inventory_damage_photos p JOIN inventory_damage_reports r ON r.id=p.report_id
    JOIN inventory_damage_months m ON m.id=r.month_id WHERE p.photo_reference=$1`,[`r2://${key}`])).rows[0];
  if(row) {
    if(!inventoryYards(actor).includes(Number(row.location_id))) {assertInventoryYard(actor,row.location_id,true);}
  }
  else {
    const locationId=Number(parts[6]?.replace('yard-',''));
    assertInventoryYard(actor,locationId);
    damagePhotoReference(`r2://${key}`,actor.id,locationId,parts[7]);
  }
  return true;
}
