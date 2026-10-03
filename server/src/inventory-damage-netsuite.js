import {activeNetSuiteLocationDirectory,fetchInventoryBalanceForItemFromNetSuite,inventoryTransferRest,suiteqlAll} from './netsuite.js';
import {upsertInventoryBalances} from './inventory-repository.js';
import {damageDestination,damageMemo,damageMemoMonth,inventoryError,inventoryId,inventoryMonth} from './inventory-workflow-domain.js';

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
    const yard=inventoryId(locationId),acceptedMonth=inventoryMonth(month),year=acceptedMonth.slice(0,4);
    const namedMonth=damageMemo(yard,acceptedMonth).split(' ')[2].toLowerCase();
    const rowsRead=sql(`SELECT id,memo FROM transaction WHERE type='InvTrnfr' AND LOWER(memo) LIKE '%damage%'
      AND (memo LIKE '%${acceptedMonth}%' OR LOWER(memo) LIKE '%${year}%${namedMonth}%') ORDER BY id DESC`);
    const locationsRead=Promise.allSettled([Promise.resolve().then(directory)]);
    const rows=await rowsRead,ids=[...new Set(rows.filter(row=>damageMemoMonth(row.memo)===acceptedMonth).map(row=>String(row.id)))];
    const result=[];
    for(let index=0;index<ids.length;index+=3) {
      const records=await Promise.all(ids.slice(index,index+3).map(get));
      result.push(...records);
    }
    const [locations]=await locationsRead;
    if(locations.status==='rejected') {throw locations.reason;}
    const destination=damageDestination(locations.value,yard);
    return result.filter(record=>Number(record.location?.id)===yard && Number(record.transferLocation?.id)===destination.destinationId);
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
    async append(id,line,{memo}={}) {await rest(`/${inventoryId(id)}`,{method:'PATCH',body:{...(memo===undefined?{}:{memo}),inventory:{items:[line]}}});}
  };
}
export const damageNetSuite=createDamageNetSuite();
