import { activeNetSuiteLocationDirectory, inventoryTransferRest, suiteqlAll } from './netsuite.js';
import { inventoryError, inventoryId } from './inventory-workflow-domain.js';
import { exchangeMemo, exchangeDestination } from './stock-exchange-domain.js';

export function completeExchangeLines(record) {
  const inventory = record?.inventory;
  if (!Array.isArray(inventory?.items) || inventory.hasMore
      || Number(inventory.totalResults ?? inventory.items.length) !== inventory.items.length)
    {throw inventoryError('Could not read the complete Inventory Transfer. Reconciliation is required.', 409);}
  return inventory.items;
}

export function createStockExchangeNetSuite({ rest = inventoryTransferRest, sql = suiteqlAll,
  directory = activeNetSuiteLocationDirectory } = {}) {
  async function get(id) {
    const record = (await rest(`/${inventoryId(id)}?expandSubResources=true`)).data;
    if (Number(record?.id) !== Number(id)) {throw inventoryError('Inventory Transfer readback has a different identity.', 409);}
    completeExchangeLines(record);
    return record;
  }
  async function findExternal(externalId) {
    if (!/^mbbs-exchange-(1|28|26)-20\d{2}-(0[1-9]|1[0-2])$/.test(externalId)) {throw inventoryError('Invalid exchange month identity.');}
    const rows = await sql(`SELECT id FROM transaction WHERE type='InvTrnfr' AND externalid='${externalId}'`);
    if (rows.length > 1) {throw inventoryError('Multiple Inventory Transfers have this exchange identity.', 409);}
    return rows.length ? get(rows[0].id) : null;
  }
  async function findMonthly({ locationId, month }) {
    const memo = exchangeMemo(locationId, month);
    const destination = exchangeDestination(await directory(), locationId);
    const rows = await sql(`SELECT id FROM transaction WHERE type='InvTrnfr' AND memo='${memo}' ORDER BY id`);
    const records = [];
    for (const row of rows) {records.push(await get(row.id));}
    return records.filter(record => Number(record.location?.id) === destination.sourceId
      && Number(record.transferLocation?.id) === destination.destinationId);
  }
  return { directory, get, findExternal, findMonthly,
    async create(body) {
      const result = await rest('', { method: 'POST', body });
      try { return result.id ? await get(result.id) : await findExternal(body.externalId); }
      catch (error) { error.exchangeWriteAcknowledged = true; throw error; }
    },
    async append(id, lines) {
      await rest(`/${inventoryId(id)}`, { method: 'PATCH', body: { inventory: { items: lines } } });
    }
  };
}
export const stockExchangeNetSuite = createStockExchangeNetSuite();
