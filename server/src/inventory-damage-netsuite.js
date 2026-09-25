import {activeNetSuiteLocationDirectory,fetchInventoryBalanceForItemFromNetSuite,inventoryTransferRest,suiteqlAll} from './netsuite.js';
import {upsertInventoryBalances} from './inventory-repository.js';
import {damageDestination,damageMemoMonth,inventoryError,inventoryId} from './inventory-workflow-domain.js';

export async function getDamageItem(itemId,locationId,{fetchItem=fetchInventoryBalanceForItemFromNetSuite,saveItems=upsertInventoryBalances}={}) {
  const rows=await fetchItem(itemId,locationId);
  if(!rows.length) {throw inventoryError('Inventory SKU not found at this yard.',404);}
  await saveItems(rows);
  return rows[0];
}
export function createDamageNetSuite({rest=inventoryTransferRest,directory=activeNetSuiteLocationDirectory,sql=suiteqlAll}={}) {
  async function get(id) {
    const record=(await rest(`/${inventoryId(id)}?expandSubResources=true`)).data;
    const inventory=record?.inventory;
    if(!Array.isArray(inventory?.items) || inventory.hasMore || Number(inventory.totalResults ?? inventory.items.length)!==inventory.items.length) {
      throw inventoryError('Could not read the complete transfer. Try refreshing before posting.',409);
    }
    return record;
  }
  async function findExternal(externalId) {
    if(!/^mbbs-damage-\d+-20\d{2}-\d{2}$/.test(externalId)) {throw inventoryError('Invalid monthly transfer identity.');}
    const rows=await sql(`SELECT id FROM transaction WHERE type='InvTrnfr' AND externalid='${externalId}'`);
    if(rows.length>1) {throw inventoryError('More than one transfer has this monthly identity.',409);}
    return rows.length ? get(rows[0].id) : null;
  }
  async function findMonthly({locationId,month}) {
    const destination=damageDestination(await directory(),locationId);
    const rows=await sql("SELECT id,memo FROM transaction WHERE type='InvTrnfr' AND LOWER(memo) LIKE '%damage%' ORDER BY id DESC");
    const result=[];
    for(const row of rows.filter(r=>damageMemoMonth(r.memo)===month)) {
      const record=await get(row.id);
      if(Number(record.location?.id)===Number(locationId) && Number(record.transferLocation?.id)===destination.destinationId) {result.push(record);}
    }
    return result;
  }
  async function units(record) {
    const rows=await sql(`SELECT DISTINCT tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit FROM transactionline tl WHERE tl.transaction=${inventoryId(record.id)} AND tl.units IS NOT NULL`);
    return Object.fromEntries(rows.map(row=>[String(row.unit_id),row.unit]));
  }
  return {directory,get,findExternal,findMonthly,units,
    async create(payload) {
      const result=await rest('',{method:'POST',body:payload});
      try {return await (result.id ? get(result.id) : findExternal(payload.externalId));}
      catch(error) {error.damageWriteAcknowledged=true;throw error;}
    },
    async append(id,line) {await rest(`/${inventoryId(id)}`,{method:'PATCH',body:{inventory:{items:[line]}}});}
  };
}
export const damageNetSuite=createDamageNetSuite();
