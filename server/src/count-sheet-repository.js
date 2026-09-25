import {createHash} from 'node:crypto';
import {query,withTransaction} from './db.js';
import {inventoryError,inventoryId,inventoryYards,assertInventoryYard,quantitySnapshot,countSheetCommand} from './inventory-workflow-domain.js';

const header=`SELECT s.*,o.display_name AS owner_name,
 (SELECT count(*)::int FROM inventory_count_sheet_items WHERE sheet_id=s.id) AS total,
 (SELECT count(*)::int FROM inventory_count_sheet_counts WHERE sheet_id=s.id AND attempt=s.attempt) AS counted
 FROM inventory_count_sheets s LEFT JOIN operators o ON o.id=s.owner_id`;
const title=input=>String(input.title || 'Count sheet').trim().slice(0,160) || 'Count sheet';
function revision(sheet,input) {
  if(Number(input.revision)!==sheet.revision) {throw inventoryError('This sheet changed. Reload before continuing.',409,'INVENTORY_STALE');}
}
async function load(actor,id,management=false,lock=false) {
  const row=(await query(`${header} WHERE s.id=$1 ${lock?'FOR UPDATE OF s':''}`,[inventoryId(id)])).rows[0];
  if(!row) {throw inventoryError('Count sheet not found.',404);}
  assertInventoryYard(actor,row.location_id,management);
  return {...row,id:Number(row.id),location_id:Number(row.location_id)};
}
async function itemIds(locationId,input) {
  if(!Array.isArray(input) || !input.length || input.length>1000) {throw inventoryError('Choose between 1 and 1000 distinct SKUs.');}
  const ids=input.map(value=>inventoryId(value,'SKU'));
  if(new Set(ids).size!==ids.length) {throw inventoryError('Each SKU can appear only once.');}
  const available=await query('SELECT item_id FROM inventory_balances WHERE location_id=$1 AND item_id=ANY($2::bigint[])',[locationId,ids]);
  if(available.rowCount!==ids.length) {throw inventoryError('One or more SKUs are unavailable at this yard.');}
  return ids;
}
async function replaceItems(sheetId,ids) {
  await query('DELETE FROM inventory_count_sheet_items WHERE sheet_id=$1',[sheetId]);
  await query('INSERT INTO inventory_count_sheet_items(sheet_id,item_id,position) SELECT $1,id,position FROM unnest($2::bigint[]) WITH ORDINALITY AS rows(id,position)',[sheetId,ids]);
}
async function event(sheet,actor,action,details={}) {
  await query('INSERT INTO inventory_count_sheet_events(sheet_id,actor_id,action,attempt,details) VALUES($1,$2,$3,$4,$5)',[sheet.id,actor.id,action,sheet.attempt,JSON.stringify(details)]);
}
export async function createCountSheet(actor,input) {
  const yard=assertInventoryYard(actor,input.locationId,true);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId || '')) {throw inventoryError('A valid request ID is required.');}
  return withTransaction(async()=>{
    const ids=await itemIds(yard,input.itemIds);
    const hash=createHash('sha256').update(JSON.stringify([actor.id,yard,title(input),ids])).digest('hex');
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`count-create:${input.requestId}`]);
    const existing=(await query('SELECT id,request_hash FROM inventory_count_sheets WHERE request_id=$1',[input.requestId])).rows[0];
    if(existing) {
      if(existing.request_hash!==hash) {throw inventoryError('This request ID was used for a different sheet.',409);}
      return getCountSheet(actor,existing.id,{management:true});
    }
    const sheet=(await query('INSERT INTO inventory_count_sheets(request_id,request_hash,location_id,title,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[input.requestId,hash,yard,title(input),actor.id])).rows[0];
    await replaceItems(sheet.id,ids); await event(sheet,actor,'create',{itemIds:ids});
    return getCountSheet(actor,sheet.id,{management:true});
  });
}
export async function listCountSheets(actor,{management=false,locationId=null}={}) {
  const yards=locationId ? [assertInventoryYard(actor,locationId,management)] : inventoryYards(actor,management);
  return (await query(`${header} WHERE s.location_id=ANY($1::bigint[]) ORDER BY CASE s.status WHEN 'available' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,s.updated_at DESC LIMIT 200`,[yards])).rows.map(row=>({...row,id:Number(row.id),location_id:Number(row.location_id)}));
}
export async function getCountSheet(actor,id,{management=false}={}) {
  return withTransaction(async()=>{
    const sheet=await load(actor,id,management,true);
    if(!management && sheet.status!=='available' && sheet.owner_id!==actor.id) {throw inventoryError('This sheet belongs to another operator.',403,'INVENTORY_FORBIDDEN');}
    const items=(await query(`SELECT i.item_id,i.item_name,i.item_description,i.stock_unit,i.to_plt,i.to_lyr,i.to_sec,i.to_pcs,
      to_jsonb(c) AS count FROM inventory_count_sheet_items si JOIN inventory_items i ON i.item_id=si.item_id
      LEFT JOIN inventory_count_sheet_counts c ON c.sheet_id=si.sheet_id AND c.item_id=si.item_id AND c.attempt=$2
      WHERE si.sheet_id=$1 ORDER BY si.position`,[sheet.id,sheet.attempt])).rows;
    if(!management) {for(const item of items) {
      if(item.count) {item.count={quantity:item.count.quantity,unit:item.count.unit,values:item.count.values,conversions:item.count.conversions,confirmed_at:item.count.confirmed_at};}
    }}
    const extra=management ? {
      history:(await query('SELECT e.*,o.display_name AS actor_name FROM inventory_count_sheet_events e LEFT JOIN operators o ON o.id=e.actor_id WHERE sheet_id=$1 ORDER BY e.id DESC',[sheet.id])).rows,
      attempts:(await query('SELECT c.*,i.item_name,o.display_name AS operator_name FROM inventory_count_sheet_counts c JOIN inventory_items i ON i.item_id=c.item_id JOIN operators o ON o.id=c.operator_id WHERE c.sheet_id=$1 AND c.attempt<>$2 ORDER BY c.attempt,c.item_id',[sheet.id,sheet.attempt])).rows
    } : {};
    return {...sheet,items,...extra};
  });
}
async function saveLine(sheet,actor,input) {
  const item=(await query(`SELECT i.*,b.quantity_on_hand,b.quantity_available,b.synced_at FROM inventory_count_sheet_items si
    JOIN inventory_items i ON i.item_id=si.item_id JOIN inventory_balances b ON b.item_id=i.item_id AND b.location_id=$3
    WHERE si.sheet_id=$1 AND si.item_id=$2`,[sheet.id,inventoryId(input.itemId),sheet.location_id])).rows[0];
  if(!item) {throw inventoryError('This SKU is not assigned to the sheet.');}
  const count=quantitySnapshot(item,input.values);
  await query(`INSERT INTO inventory_count_sheet_counts(sheet_id,attempt,item_id,operator_id,quantity,unit,values,conversions,system_on_hand,system_available,variance,inventory_synced_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$5::numeric-$9::numeric,$11)
    ON CONFLICT(sheet_id,attempt,item_id) DO UPDATE SET quantity=EXCLUDED.quantity,unit=EXCLUDED.unit,values=EXCLUDED.values,
    conversions=EXCLUDED.conversions,system_on_hand=EXCLUDED.system_on_hand,system_available=EXCLUDED.system_available,
    variance=EXCLUDED.variance,inventory_synced_at=EXCLUDED.inventory_synced_at,confirmed_at=now()`,
  [sheet.id,sheet.attempt,item.item_id,actor.id,count.quantity,count.unit,JSON.stringify(count.values),JSON.stringify(count.conversions),item.quantity_on_hand,item.quantity_available,item.synced_at]);
  await event(sheet,actor,'line',{itemId:Number(item.item_id),quantity:count.quantity});
}
async function managementCommand(sheet,actor,action,input) {
  revision(sheet,input);
  if(['submitted','cancelled'].includes(sheet.status)) {throw inventoryError('Completed sheets cannot be changed.',409);}
  if(action==='edit') {
    if(sheet.status!=='available') {throw inventoryError('Only available sheets can be edited.',409);}
    const ids=await itemIds(sheet.location_id,input.itemIds);
    await replaceItems(sheet.id,ids);
    await query('UPDATE inventory_count_sheets SET title=$2 WHERE id=$1',[sheet.id,title(input)]);
  } else if(action==='reset') {
    if(sheet.status!=='in_progress') {throw inventoryError('Only an in-progress sheet can be reset.',409);}
    await query("UPDATE inventory_count_sheets SET status='available',owner_id=NULL,attempt=attempt+1 WHERE id=$1",[sheet.id]);
  } else if(action==='cancel') {await query("UPDATE inventory_count_sheets SET status='cancelled' WHERE id=$1",[sheet.id]);}
  else {throw inventoryError('Invalid management action.');}
  await event(sheet,actor,action,{previousOwner:sheet.owner_id});
}
export async function changeCountSheet(actor,id,action,input,{management=false}={}) {
  return withTransaction(async()=>{
    const sheet=await load(actor,id,management,true);
    if(management) {await managementCommand(sheet,actor,action,input);}
    else if(action==='take') {
      if(sheet.status==='in_progress' && sheet.owner_id===actor.id) {return getCountSheet(actor,id);}
      if(sheet.status!=='available') {throw inventoryError('This sheet has already been taken or completed.',409,'INVENTORY_SHEET_OWNER');}
      await query("UPDATE inventory_count_sheets SET status='in_progress',owner_id=$2 WHERE id=$1",[sheet.id,actor.id]);
      await event(sheet,actor,'take');
    } else {
      if(action==='submit' && sheet.status==='submitted' && sheet.owner_id===actor.id && Number(input.attempt)===sheet.attempt) {return getCountSheet(actor,id);}
      countSheetCommand(sheet,actor,input,action);
      if(action==='line') {await saveLine(sheet,actor,input);}
      else {
        if(sheet.counted!==sheet.total || !sheet.total) {throw inventoryError('Confirm every assigned SKU before submitting.',409,'INVENTORY_INCOMPLETE');}
        await query("UPDATE inventory_count_sheets SET status='submitted',submitted_at=now() WHERE id=$1",[sheet.id]);
        await event(sheet,actor,'submit');
      }
    }
    await query('UPDATE inventory_count_sheets SET revision=revision+1,updated_at=now() WHERE id=$1',[sheet.id]);
    return getCountSheet(actor,id,{management});
  });
}
