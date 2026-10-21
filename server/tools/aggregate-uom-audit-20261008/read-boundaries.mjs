// Read-only boundary inspection; never writes NetSuite records.
import fs from 'node:fs';
import { suiteql, readRegularStockSalesOrderFromNetSuite } from '/app/src/netsuite.js';
import { fetchReturnSalesOrderFromNetSuite } from '/app/src/return-netsuite.js';
import { closeDb } from '/app/src/db.js';

const transport = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.pathname.includes('/record/v1/') && (options.method || 'GET') !== 'GET') {
    throw new Error('This audit forbids NetSuite record writes');
  }
  return transport(url, options);
};
try {
  let source = fs.readFileSync('/app/src/netsuite.js', 'utf8');
  source = source.replace(/(['"])\.\//gu, '$1file:///app/src/');
  source += '\nexport async function auditReadRecord(path) { return netsuiteRest(path, { method: "GET" }); }\n';
  const { auditReadRecord } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const item = (await auditReadRecord('/record/v1/inventoryItem/9912?expandSubResources=true')).data;
  const itemSummary = {};
  for (const [key, value] of Object.entries(item)) {
    if (/weight|unit|quantity|location/iu.test(key)) itemSummary[key] = value;
  }
  const inventory = (await suiteql(`SELECT location,BUILTIN.DF(location) AS location_name,quantityonhand,quantityavailable
    FROM AggregateItemLocation WHERE item=9912 ORDER BY location`)).items;
  const regular = await readRegularStockSalesOrderFromNetSuite('SOB121756');
  let returns;
  try {
    const order = await fetchReturnSalesOrderFromNetSuite('SOB121756', { includeRestLineMapping: false });
    returns = order.lines.filter(line => line.itemId === 9912).map(({itemId,lineId,salesQuantity,salesUom,fulfilledQuantity,rate,foreignAmount}) =>
      ({itemId,lineId,salesQuantity,salesUom,fulfilledQuantity,rate,foreignAmount}));
  } catch (error) {
    returns = { error: error.message };
  }
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),item:itemSummary,inventory,
    regular:regular.lines.filter(line=>line.itemId===9912),returns},null,2));
} finally {
  await closeDb();
}
