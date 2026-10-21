// Read the user-reported SO through the deployed adapter; intercept only to
// record field shapes. Never permit a NetSuite record mutation in this probe.
const {readRegularStockSalesOrderFromNetSuite} = await import(process.cwd() + '/src/netsuite.js');
const {closeDb} = await import(process.cwd() + '/src/db.js');
const originalFetch = globalThis.fetch;
const evidence = {reference: process.argv[2] || 'SOB121631', readOnly: true, snapshots: []};
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  const method = String(options.method || 'GET').toUpperCase();
  if (path.includes('/record/v1/') && method !== 'GET') throw Error('Live probe refuses record writes');
  const response = await originalFetch(url, options);
  if (path.includes('/query/v1/suiteql') && String(options.body || '').includes('rest_line_id')) {
    const body = await response.clone().json();
    evidence.snapshots.push({source: 'suiteql', status: response.status, rows: body.items?.map(row => ({
      id: row.id, tranid: row.tranid, order_location_id: row.order_location_id, customer_id: row.customer_id,
      status: row.status, line_id: row.line_id, rest_line_id: row.rest_line_id, item_id: row.item_id,
      item_name: row.item_name, quantity: row.quantity, stock_unit: row.stock_unit, item_type: row.item_type,
      location_id: row.location_id, fulfilled_quantity: row.fulfilled_quantity,
      billed_quantity: row.billed_quantity, line_closed: row.line_closed
    }))});
  }
  if (path.includes('/record/v1/salesOrder/')) {
    const body = await response.clone().json();
    evidence.snapshots.push({source: 'rest', status: response.status, headerKeys: Object.keys(body),
      id: body.id, tranId: body.tranId, location: body.location?.id, entity: body.entity?.id,
      itemLines: body.item?.items?.map(line => ({line: line.line, item: line.item?.id,
        itemName: line.item?.refName, itemType: line.itemType, quantity: line.quantity, location: line.location?.id,
        units: line.units?.id, isClosed: line.isClosed}))});
  }
  return response;
};
try {
  const order = await readRegularStockSalesOrderFromNetSuite(evidence.reference);
  evidence.result = {ok: true, id: order.id, locationId: order.locationId, lines: order.lines.length,
    materialLines: order.lines.filter(line => !line.ancillary).length,
    subtotalLines: order.lines.filter(line => line.itemId === -2).length,
    nonStockLines: order.lines.filter(line => line.ancillary).length};
  evidence.routingOrder = {id:order.id,ref:order.ref,customerId:order.customerId,locationId:order.locationId,
    lines:order.lines.map(({remoteLineId,itemId,itemName,quantity,uom,locationId,ancillary,open})=>({remoteLineId,itemId,itemName,quantity,uom,locationId,ancillary,open}))};
} catch (error) {
  evidence.result = {ok: false, code: error.code, message: error.message};
} finally {
  globalThis.fetch = originalFetch;
  await closeDb();
}
console.log(JSON.stringify(evidence));
