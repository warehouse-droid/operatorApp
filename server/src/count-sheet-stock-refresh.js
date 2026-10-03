import {withTransaction} from './db.js';
import {inventoryError,countSheetCommand} from './inventory-workflow-domain.js';
import {getCountSheet} from './count-sheet-repository.js';
import {fetchInventoryBalancesForItemsFromNetSuite} from './netsuite.js';
import {upsertInventoryBalancesBulk} from './inventory-repository.js';

const refreshError=()=>inventoryError('Could not refresh this count sheet\'s stock. Please retry.',503,'COUNT_SHEET_REFRESH_FAILED');

export function validateRows(rows,itemIds,locationId) {
  if(!Array.isArray(rows) || rows.length!==itemIds.length) {throw refreshError();}
  const pending=new Set(itemIds);
  for(const row of rows) {
    if(!row || Number(row.location_id)!==locationId || !pending.delete(Number(row.item_id))) {throw refreshError();}
    for(const field of ['quantity_on_hand','quantity_available']) {
      const value=row[field];
      if(!['number','string'].includes(typeof value) || String(value).trim()==='' || !Number.isFinite(Number(value))) {throw refreshError();}
    }
  }
}

export async function refreshCountSheetInventory(actor,id,{fetchBalances=fetchInventoryBalancesForItemsFromNetSuite}={}) {
  const sheet=await getCountSheet(actor,id);
  if(sheet.status!=='in_progress') {return sheet;}
  const itemIds=sheet.items.map(item=>Number(item.item_id)),rows=[];
  // Read NetSuite outside a transaction so a slow request cannot lock the sheet.
  try {
    for(let offset=0;offset<itemIds.length;offset+=180) {
      const batch=itemIds.slice(offset,offset+180);
      const result=await fetchBalances(batch,[sheet.location_id]);
      validateRows(result,batch,sheet.location_id);
      rows.push(...result);
    }
  } catch {throw refreshError();}
  return withTransaction(async()=>{
    const current=await getCountSheet(actor,id);
    countSheetCommand(current,actor,{attempt:sheet.attempt,revision:sheet.revision},'line');
    await upsertInventoryBalancesBulk(rows);
    return getCountSheet(actor,id);
  });
}
