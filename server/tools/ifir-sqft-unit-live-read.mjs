// Read-only verification of the production reader and deferred guards on affected orders.
import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from './src/netsuite.js';
import { prepareSalesOrderFulfillmentPayload, prepareDeferredSalesOrderNativePayload }
  from './src/operator-netsuite-posting-fulfillment-lines.js';

const results = [];
try {
  for (const [id, ref] of [[1080114, 'SOB123167'], [1079976, 'SOB123163']]) {
    const row = (await query(`SELECT s.payload,s.line_snapshot,s.external_id,s.netsuite_transaction_id
      FROM operator_netsuite_posting_steps s JOIN operator_netsuite_posting_commands c ON c.id=s.command_id
      WHERE s.source_order_kind='SO' AND s.source_netsuite_id=$1 AND s.status='failed'
      ORDER BY c.updated_at DESC LIMIT 1`, [id])).rows[0];
    assert.ok(row);
    assert.equal(row.netsuite_transaction_id, null);
    const step = { sourceNetSuiteId: id, sourceOrderKind: 'SO', transactionType: 'IF',
      externalId: row.external_id, payload: row.payload, lineSnapshot: row.line_snapshot };
    const original = JSON.stringify(step);
    const source = await fetchSalesOrderFulfillmentStateFromNetSuite(id, { includeAllSourceLines: true });
    assert.equal(source.tranid, ref);
    const payload = prepareSalesOrderFulfillmentPayload(step, source);
    const fallback = prepareDeferredSalesOrderNativePayload(step, payload, source);
    const selected = payload.item.items.filter(line => line.itemReceive);
    for (const line of selected) {
      const actual = source.lines.find(item => item.orderLine === line.orderLine);
      assert.equal(actual.unit, 'SQFT');
      assert.ok(actual.remainingQuantity > 0);
      assert.ok(fallback.item.items.find(item => item.orderLine === line.orderLine).quantity <= actual.remainingQuantity);
    }
    assert.equal(JSON.stringify(step), original);
    const result = { sourceId: id, sourceRef: ref, deferredGuardPassed: true,
      nativeFallbackGuardPassed: true, selectedLines: selected.map(line => ({ orderLine: line.orderLine,
        requested: line.quantity, unit: source.lines.find(item => item.orderLine === line.orderLine).unit,
        remaining: source.lines.find(item => item.orderLine === line.orderLine).remainingQuantity })) };
    results.push(result);
    console.log(JSON.stringify({ event: 'sqft-unit-reader-verified', ...result }));
  }
  console.log(JSON.stringify({ event: 'sqft-unit-reader-summary', at: new Date().toISOString(),
    passed: true, writesAttempted: false, cases: results }));
} catch (error) {
  console.log(JSON.stringify({ event: 'sqft-unit-reader-summary', at: new Date().toISOString(),
    passed: false, writesAttempted: false, cases: results, error: { code: error.code || null, message: error.message } }));
  process.exitCode = 1;
} finally { await closeDb(); }
