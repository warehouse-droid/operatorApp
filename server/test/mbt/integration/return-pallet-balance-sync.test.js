import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import fc from 'fast-check';
import { query, closeDb } from '../../../src/db.js';
import { submitReturnBatch, syncReturnRecord, lookupReturnCustomerPalletBalance, lookupReturnSalesOrder,
  localPalletReserved, localStockReserved, getReturnRecordDetail, reconcileReturnRecords } from '../../../src/return-repository.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { app } from '../../../src/server.js';
after(closeDb);
const customerId = 99091702;
const submit = (input, autoSync = true) => submitReturnBatch({ operatorId: actor, input, autoSync });
const creates = remote => remote.requests.filter(r => r.method === 'POST' && /\/record\//.test(r.address));

async function setup(t, { cm = true } = {}) {
  const remote = await fixture(t);
  const flags = (await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'")).rows;
  t.after(async () => {
    for (const row of flags) await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [row.flag_key, row.enabled, row.revision]);
  });
  await query("UPDATE mbt_feature_flags SET enabled=$1,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'", [cm]);
  const transport = globalThis.fetch;
  remote.control.readError = null;
  remote.reads = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const match = String(url).match(/\/creditMemo\/(\d+)/i);
    if (match && options.method === 'GET') {
      remote.reads.push(Number(match[1]));
      const problem = remote.control.readError;
      if (problem?.transport) throw new Error('temporary connection failure');
      if (problem?.empty) return Response.json({});
      if (problem || !remote.created.has(match[1])) {
        return Response.json({ 'o:errorDetails': [{ 'o:errorCode': problem?.code || 'NONEXISTENT_ID', detail: 'Fixture record unavailable' }] },
          { status: problem?.status || 404 });
      }
    }
    return transport(url, options);
  });
  remote.observe = record => {
    remote.control.credits = [{ transaction_id: record.netSuiteTransactionId, quantity: record.palletQuantity }];
  };
  remote.remove = record => {
    remote.created.delete(String(record.netSuiteTransactionId));
    remote.control.credits = [];
  };
  return remote;
}

test('F1 consecutive customer and SO pallet enquiries use fresh remote activity', async t => {
  const remote = await setup(t);
  remote.control.credits = [{ transaction_id: 8801, quantity: 4 }];
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 16);
  remote.control.credits = [{ transaction_id: 8801, quantity: 1 }];
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 19);
  const order = await lookupReturnSalesOrder({ code: 'SOB99091700', receivingLocationId: 1, includeStockReturns: false });
  assert.equal(order.palletBalance.available, 19);
  remote.control.credits = [];
  assert.equal((await lookupReturnSalesOrder({ code: 'SOB99091700', receivingLocationId: 1, includeStockReturns: false })).palletBalance.available, 20);
});

test('D1 deleted verified CM refresh restores both components and preserves identity without reposting', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ pallet: true, quantity: 3 }));
  const record = result.palletReturn;
  remote.observe(record);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 17);
  const original = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=$1', [record.batchId])).rows[0];
  remote.remove(record);
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.available, 20);
  assert.equal(balance.localReserved, 0);
  assert.equal((await localStockReserved([99091703])).get('99091703') || 0, 0);
  const current = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=$1', [record.batchId])).rows[0];
  assert.equal(current.sync_status, 'cancelled');
  assert.equal(current.netsuite_transaction_status, 'Deleted');
  assert.equal(current.netsuite_transaction_id, original.netsuite_transaction_id);
  assert.deepEqual(current.intent_snapshot, original.intent_snapshot);
  assert.deepEqual(current.netsuite_snapshot, original.netsuite_snapshot);
  assert.match((await getReturnRecordDetail(record.id)).netSuiteSyncError, /deleted in NetSuite/i);
  await syncReturnRecord({ recordId: record.id });
  await reconcileReturnRecords();
  assert.equal(creates(remote).length, 1);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 20);
  const events = await query("SELECT * FROM return_sync_events WHERE return_record_id=$1 AND status='cancelled'", [record.id]);
  assert.equal(events.rowCount, 1);
});

test('D2 concurrent deleted-CM enquiries retire once and do not create another credit', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  remote.remove(result.palletReturn);
  const balances = await Promise.all(Array.from({ length: 6 }, () => lookupReturnCustomerPalletBalance(customerId)));
  assert.ok(balances.every(b => b.available === 20 && b.localReserved === 0));
  assert.equal(creates(remote).length, 1);
  assert.equal((await query("SELECT * FROM return_sync_events WHERE return_record_id=$1 AND status='cancelled'", [result.palletReturn.id])).rowCount, 1);
});

test('S1 generated non-deletion errors fail closed and keep the reservation', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  await fc.assert(fc.asyncProperty(fc.constantFrom(
    { status: 403, code: 'INSUFFICIENT_PERMISSION' }, { status: 404, code: 'NOT_FOUND' },
    { status: 500, code: 'NONEXISTENT_ID' }, { transport: true }, { empty: true }
  ), async problem => {
    remote.control.readError = problem;
    await assert.rejects(lookupReturnCustomerPalletBalance(customerId));
    assert.equal(await localPalletReserved(customerId), 3);
    assert.notEqual((await getReturnRecordDetail(result.palletReturn.id)).netSuiteSyncStatus, 'cancelled');
  }), { numRuns: 12, seed: 8444 });
  remote.control.readError = null;
  remote.remove(result.palletReturn);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 20, 'A previous temporary failure must not prevent later deletion reconciliation');
  assert.equal(creates(remote).length, 1);
});

test('S2 an unindexed CM that still exists remains reserved and uses only GET recovery', async t => {
  const remote = await setup(t);
  await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.available, 17);
  assert.equal(balance.localReserved, 3);
  assert.equal(creates(remote).length, 1);
});

test('S2 an identified but never verified CM cannot be treated as a deleted completed return', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }), false);
  remote.control.readError = { status: 403, code: 'INSUFFICIENT_PERMISSION' };
  await assert.rejects(syncReturnRecord({ recordId: result.palletReturn.id }));
  remote.control.readError = { status: 404, code: 'NONEXISTENT_ID' };
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.localReserved, 3);
  await assert.rejects(syncReturnRecord({ recordId: result.palletReturn.id }));
  assert.notEqual((await getReturnRecordDetail(result.palletReturn.id)).netSuiteSyncStatus, 'cancelled');
  assert.equal(creates(remote).length, 1);
});

test('C1 a voided CM is refreshed and no longer reserves pallets', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  remote.created.get(String(result.palletReturn.netSuiteTransactionId)).status = { refName: 'Voided' };
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 20);
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteSyncStatus, 'cancelled');
});

test('C1 confirmed cancelled RAs release their reservation while live RAs still reserve', async t => {
  const remote = await setup(t, { cm: false });
  const result = await submit(await submitInput({ pallet: true, quantity: 3 }));
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).localReserved, 3);
  remote.created.get(String(result.palletReturn.netSuiteTransactionId)).status = { refName: 'Cancelled' };
  await reconcileReturnRecords();
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).localReserved, 0);
  assert.equal((await localStockReserved([99091703])).get('99091703') || 0, 0);
});

test('S2 pending and local-only returns still reserve pallets', async t => {
  const remote = await setup(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_%'");
  await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.localReserved, 3);
  assert.equal(balance.available, 17);
  assert.equal(creates(remote).length, 0);
});

test('F1 submission rechecks remote quota immediately after an enquiry', async t => {
  const remote = await setup(t);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 20);
  remote.control.credits = [{ transaction_id: 8801, quantity: 19 }];
  await assert.rejects(submit(await submitInput({ stock: false, pallet: true, quantity: 3 })), { code: 'PALLET_QUOTA_EXCEEDED' });
  assert.equal(creates(remote).length, 0);
});

test('D1 scheduled reconciliation recognizes a confirmed deleted CM', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  remote.remove(result.palletReturn);
  assert.deepEqual(await reconcileReturnRecords(), { checked: 1, updated: 1, failed: 0, skipped: 0 });
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteTransactionStatus, 'Deleted');
  assert.equal(await localPalletReserved(customerId), 0);
  assert.equal(creates(remote).length, 1);
});

test('HTTP fresh Operator balance restores a deleted credit and keeps access checks', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  const username = `pallet-balance-http-${process.pid}`;
  const password = 'synthetic-pallet-balance-test-password';
  await createOperator({ username, password, displayName: 'Pallet balance test', role: 'operator',
    roles: ['operator'], operatorYardLocationIds: [1] });
  const { token } = await loginOperator(username, password);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (yard = 1, authenticated = true) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/returns/customers/${customerId}/pallet-balance?receivingLocationId=${yard}`,
      headers: authenticated ? { authorization: `Bearer ${token}` } : {} }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.end();
  });
  remote.observe(result.palletReturn);
  assert.equal((await call()).body.balance.available, 17);
  remote.remove(result.palletReturn);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.balance.available, 20);
  assert.equal(response.body.balance.localReserved, 0);
  assert.equal((await call(28)).status, 403);
  assert.equal((await call(1, false)).status, 401);
  assert.equal(creates(remote).length, 1);
});
