// Read-only checks, evaluated inside the newly deployed application container.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from './src/config.js';
import { closeDb, query, withTransaction } from './src/db.js';
import { listSpecialStockCases } from './src/special-stock-request-repository.js';
import { buildSpecialSalesOrderPayload } from './src/special-stock-request-netsuite.js';
import { resolveSpecialOrderUnitsFromNetSuite, suiteqlAll } from './src/netsuite.js';
import { SPECIAL_STAGES } from './public/special-stock-workflow.js';

const assets = EXPECTED_ASSETS;
const result = { http: [], stageCount: Object.keys(SPECIAL_STAGES).length };
try {
  assert.equal(result.stageCount, 7);
  assert.equal(config.specialStock.pickupMethodId, '1');
  assert.equal(config.specialStock.deliveryMethodId, '2');
  result.salesOrderMethods = {};
  for (const method of ['vendor_pickup', 'yard_pickup', 'mbt_delivery']) {
    const payload = buildSpecialSalesOrderPayload({caseId: 1, netsuiteLocationId: 1,
      pickupMethodId: config.specialStock.pickupMethodId, deliveryMethodId: config.specialStock.deliveryMethodId,
      draft: {customerId: 1, fulfillmentMethod: method, deliveryAddress: 'Read-only payload check',
        materialLines: [{itemId: 2055, quantity: 1, uom: 'PC', rate: 1, description: 'Not submitted'}]}});
    assert.equal(payload.custbody3.id, method === 'mbt_delivery' ? '2' : '1');
    result.salesOrderMethods[method] = payload.custbody3.id;
  }
  for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
    for (const route of ['/health', '/sales/stock-requests', '/scm/stock-requests', '/dispatch/special-stock']) {
      const response = await fetch(base + route, {signal: AbortSignal.timeout(15000), headers: {'Cache-Control': 'no-cache'}});
      assert.equal(response.status, 200, route);
      if (route === '/health') assert.equal((await response.json()).ok, true);
      result.http.push({base, route, status: response.status});
    }
    for (const [file, expected] of Object.entries(assets)) {
      const response = await fetch(base + '/' + file.slice(7), {signal: AbortSignal.timeout(15000), headers: {'Cache-Control': 'no-cache'}});
      assert.equal(response.status, 200, file);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, file);
    }
    for (const route of ['/api/sales/special-stock-requests', '/api/scm/special-stock-requests', '/api/dispatch/special-stock-handoffs']) {
      const response = await fetch(base + route, {signal: AbortSignal.timeout(15000)});
      assert.equal(response.status, 401, route);
      result.http.push({base, route, status: 401});
    }
  }
  result.verifiedAssetsPerHost = Object.keys(assets).length;
  result.database = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='10s'");
    const rows = await listSpecialStockCases({stages: ['new_enquiry', 'wait_for_production'], limit: 10, audience: 'sales'});
    const migration = await query('SELECT filename FROM schema_migrations WHERE filename=$1', ['225_special_workflow_review.sql']);
    assert.equal(migration.rowCount, 1);
    const view = await query('SELECT count(*)::int AS cases FROM special_stock_workflow_stages');
    return {migrationApplied: true, filteredRows: rows.length, stageViewRows: view.rows[0].cases};
  });
  const items = await suiteqlAll("SELECT id,itemid,unitstype,BUILTIN.DF(saleunit) AS sales_unit FROM item WHERE id IN (2055,1784) AND isinactive='F'");
  assert.equal(items.length, 2);
  const native = await resolveSpecialOrderUnitsFromNetSuite([{itemId: 2055, uom: 'PC', quantity: 1}, {itemId: 1784, uom: 'EACH', quantity: 1}]);
  assert.ok(native.every(line => Number.isSafeInteger(line.unitId) && line.unitId > 0));
  result.netSuiteReadOnly = {items, resolvedUnits: native.map(({itemId, uom, unitId}) => ({itemId, uom, unitId})), ordersSubmitted: 0};
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
