// Explicitly authorized production validation for SOB120598 only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pool, query } from './src/db.js';
import { writeAudit } from './src/auth-repository.js';
import { config } from './src/config.js';
import { ensureOutboundLocationDirectory } from './src/outbound-location-runtime.js';
import { outboundOrderYards } from './src/outbound-location-domain.js';
import { findCustomerPickupOrder, getDeliveryOrder } from './src/delivery-repository.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite, suiteqlAll } from './src/netsuite.js';
import { buildSalesOrderItemFulfillmentPayload } from './src/sales-order-auto-fulfillment-domain.js';
import { operatorNetSuitePostingAdapter as adapter } from './src/operator-netsuite-posting-netsuite-adapter.js';

const orderId = 996102, orderRef = 'SOB120598', locationId = 14;
const externalId = 'MBBS-SOIF-12059800-2026-4918-a014-000000996102';
const expectedQuantity = 51.26;
const save = (name, value, flag = 'w') => writeFileSync(`/evidence/${name}.json`, JSON.stringify(value, null, 2) + '\n', { flag, mode: 0o600 });
const lock = await pool.connect();
try {
  assert.equal(String(config.netsuite.accountId), '6518947', 'Unexpected NetSuite account');
  assert.equal((await lock.query("SELECT pg_try_advisory_lock(hashtext('child-location-live-SOB120598')) AS locked")).rows[0].locked, true);
  const manifest = JSON.parse(readFileSync('/release-manifest.json', 'utf8'));
  const sourceHashes = Object.fromEntries(Object.keys(manifest.after).map(file => [file, createHash('sha256').update(readFileSync(`/app/${file}`)).digest('hex')]));
  assert.deepEqual(sourceHashes, manifest.after);
  const hierarchy = await ensureOutboundLocationDirectory();
  assert.equal(hierarchy.yardFor(locationId), 1);
  // Recovery may occur after the fulfillment webhook removes the order from
  // the eligible pickup list. Its immutable external identity remains valid.
  if (!existsSync('/evidence/attempt.json')) {
    const localId = await findCustomerPickupOrder(orderRef, { locationId: 1 });
    assert.equal(Number(localId), orderId);
    const local = await getDeliveryOrder(localId);
    assert.equal(Number(local.outbound_location_id), locationId);
    assert.deepEqual(outboundOrderYards(local), [1]);
  }
  const live = await fetchSalesOrderFulfillmentStateFromNetSuite(orderId);
  assert.equal(live?.tranid, orderRef);
  const items = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('SO', orderId);
  assert.equal(items.length, 1, 'Review newly added Sales Order lines before testing');
  assert.equal(Number(items[0].item?.id), 8497);
  assert.equal(Number(items[0].location?.id), locationId);
  assert.equal(Number(items[0].orderLine ?? items[0].line), 1);
  assert.equal(live.lines.length, 1);
  assert.equal(live.lines[0].sourceLineKey, '4970885');
  assert.equal(live.lines[0].location, locationId);
  if (process.argv.includes('--read-only')) {
    const result = { readOnly: true, sourceOrderRef: live.tranid, sourceOrderId: orderId, inventoryLocationId: locationId,
      parentYardId: 1, restOrderLine: live.lines[0].orderLine, remainingQuantity: live.lines[0].remainingQuantity,
      fulfilledQuantity: live.lines[0].fulfilledQuantity };
    save('preflight', result);
    console.log(JSON.stringify(result));
  } else {
  const payload = buildSalesOrderItemFulfillmentPayload({ externalId,
    selectedLines: [{ orderLine: 1, quantity: expectedQuantity, location: locationId }], availableLines: live.lines });
  const step = { externalId, sourceOrderKind: 'SO', sourceNetSuiteId: orderId, sourceOrderRef: orderRef, transactionType: 'IF', payload };
  let record = await adapter.findByExternalId(step, true);
  let created = false;
  if (!record) {
    assert.equal(live.lines[0].remainingQuantity, expectedQuantity, 'Outstanding quantity changed; no POST submitted');
    assert.equal(live.lines[0].fulfilledQuantity, 0, 'Order already has fulfilled inventory; no POST submitted');
    assert.equal(live.lines[0].lineClosed, false);
    const linked = await suiteqlAll(`SELECT DISTINCT next_transaction.id FROM NextTransactionLineLink transaction_link
      JOIN transaction next_transaction ON next_transaction.id=transaction_link.nextdoc
      WHERE transaction_link.previousdoc=${orderId} AND next_transaction.type='ItemShip'`);
    assert.deepEqual(linked, [], 'An IF already exists for this source; no POST submitted');
    assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_order_claims WHERE local_order_key=$1 AND active=true", [String(orderId)])).rowCount, 0);
    assert.equal(existsSync('/evidence/attempt.json'), false, 'A previous attempt requires recovery; never submit another blind POST');
    save('intent', { at: new Date().toISOString(), source: live, hierarchy: { yard: 1, inventoryLocation: locationId }, step, sourceHashes });
    await writeAudit({ actorType: 'system', source: 'child-location-validation', action: 'netsuite.child_location_test.intent', orderId: String(orderId), details: { userAuthorized: true, sourceOrderRef: orderRef, externalId, payload } });
    save('attempt', { at: new Date().toISOString(), externalId, status: 'posting' }, 'wx');
    try {
      const result = await adapter.transform(step);
      record = result?.id ? await adapter.fetchById(step, Number(result.id)) : await adapter.findByExternalId(step, true);
      assert.ok(record, 'Posted IF is not yet readable; recover by external ID');
      created = true;
    } catch (error) {
      save('attempt-error', { at: new Date().toISOString(), message: error.message, status: error.status, ambiguous: error.ambiguous, netsuiteErrorDetails: error.netsuiteErrorDetails });
      record = await adapter.findByExternalId(step, true);
      if (!record) { throw error; }
    }
  }
  const verified = adapter.verify(step, record);
  assert.equal(Number(record.item.items.find(line => Number(line.quantity) > 0)?.item?.id), 8497);
  const after = await fetchSalesOrderFulfillmentStateFromNetSuite(orderId);
  assert.equal(after.lines[0].remainingQuantity, 0);
  assert.equal(after.lines[0].fulfilledQuantity, expectedQuantity);
  const replay = await adapter.findByExternalId(step, true);
  assert.equal(adapter.verify(step, replay).id, verified.id);
  const result = { passed: true, at: new Date().toISOString(), sourceOrderId: orderId, sourceOrderRef: orderRef,
    inventoryLocationId: locationId, inventoryLocationName: hierarchy.nameFor(locationId), parentYardId: 1,
    restOrderLine: 1, quantity: expectedQuantity, unit: 'SQFT', transactionId: verified.id, transactionRef: verified.transactionRef,
    externalId, created, duplicateRecoveryVerified: true, sourceHashes };
  save('result', result);
  await writeAudit({ actorType: 'system', source: 'child-location-validation', action: 'netsuite.child_location_test.verified', orderId: String(orderId), details: result });
  console.log(JSON.stringify({ ...result, sourceHashes: undefined }));
  }
} finally {
  await lock.query("SELECT pg_advisory_unlock(hashtext('child-location-live-SOB120598'))").catch(() => {});
  lock.release();
  await pool.end();
}
