// Run through stdin in the live app for a read-only operational comparison.
import {readRegularStockSalesOrderFromNetSuite} from './src/netsuite.js';
import {regularStockKitComponentsMatch} from './src/regular-stock-netsuite-adapter.js';
import {pool, closeDb} from './src/db.js';

try {
  const {rows} = await pool.query(`SELECT r.request_ref,r.status AS request_status,h.status AS handoff_status,h.plan
    FROM sales_stock_requests r JOIN regular_stock_handoffs h ON h.request_id=r.id WHERE r.request_ref=$1`, ['STREQ-000105']);
  const saved = rows[0], original = saved.plan.order;
  const current = await readRegularStockSalesOrderFromNetSuite(original.ref);
  const differences = [];
  for (const field of ['id', 'customerId', 'locationId']) {
    if (current[field] !== original[field]) { differences.push({scope: 'header', field}); }
  }
  const selected = original.lines.filter(line => saved.plan.materialLineIds.includes(line.remoteLineId));
  for (const line of selected) {
    const fresh = current.lines.find(candidate => candidate.remoteLineId === line.remoteLineId);
    if (!fresh) { differences.push({line: line.remoteLineId, field: 'removed'}); continue; }
    for (const field of ['itemId', 'quantity', 'locationId', 'uom', 'restQuantity', 'backorderedQuantity']) {
      if (fresh[field] !== line[field]) { differences.push({line: line.remoteLineId, field, before: line[field], current: fresh[field]}); }
    }
    if (!regularStockKitComponentsMatch(line, fresh)) { differences.push({line: line.remoteLineId, field: 'kitComponents'}); }
    if (!fresh.ancillary && !fresh.open) { differences.push({line: line.remoteLineId, field: 'open'}); }
  }
  console.log(JSON.stringify({checkedAt: new Date().toISOString(), request: saved.request_ref, salesOrder: current.ref,
    requestStatus: saved.request_status, storedHandoffStatus: saved.handoff_status,
    selectedLines: selected.map(line => ({item: line.itemName, quantity: line.quantity, unit: line.uom})),
    originalLineCount: original.lines.length, currentLineCount: current.lines.length,
    relevantDifferences: differences, selectedLineValidationPasses: differences.length === 0, businessRecordsModified: false}, null, 2));
} finally {
  await closeDb();
}
