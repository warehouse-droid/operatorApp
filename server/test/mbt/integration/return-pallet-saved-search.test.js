import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import pg from 'pg';
import { config } from '../../../src/config.js';
import { query, closeDb } from '../../../src/db.js';
import { lookupReturnCustomerPalletBalance, submitReturnBatch, getReturnRecordDetail } from '../../../src/return-repository.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
import { palletSearchResult } from '../../support/pallet-saved-search-fixture.js';
import { readNetSuiteRestlet } from '../../../src/netsuite.js';
import { palletCreditIdentityQuery, fetchPalletBalanceFromNetSuite } from '../../../src/return-netsuite.js';

after(closeDb);
const customerId = 99091702;
const submit = (input, autoSync = false) => submitReturnBatch({ operatorId: actor, input, autoSync });
const historyQueries = remote => remote.requests.filter(request => request.body?.q?.includes("'ItemShip' AS transaction_type"));

function reportResponse(remote, address, options) {
  remote.events.push('report');
  remote.requests.push({ address, method: options.method, body: null });
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.ok(options.headers.Authorization.startsWith('Bearer '));
  assert.equal(new URL(address).searchParams.get('customerId'), String(customerId));
  const fault = remote.control.searchError;
  if (fault === 'transport') { throw new Error('Synthetic report connection failure'); }
  if (fault === 'json') { return new Response('not JSON', { status: 200 }); }
  if (fault) {
    return Response.json({ error: { code: 'INSUFFICIENT_PERMISSION', message: 'Fixture denied' } }, { status: fault });
  }
  const payload = palletSearchResult(customerId, typeof remote.control.searchBalance === 'function'
    ? remote.control.searchBalance() : remote.control.searchBalance);
  remote.control.searchEdit?.(payload);
  return Response.json(payload);
}

async function setup(t, { credits = false } = {}) {
  const remote = await fixture(t);
  const previous = { url: config.netsuite.palletBalanceRestletUrl, account: config.netsuite.accountId };
  config.netsuite.accountId = 'pallet-test';
  config.netsuite.palletBalanceRestletUrl = 'https://pallet-test.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=505&deploy=1';
  t.after(() => {
    config.netsuite.palletBalanceRestletUrl = previous.url;
    config.netsuite.accountId = previous.account;
  });
  const flags = (await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'")).rows;
  t.after(async () => {
    for (const row of flags) {
      await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [row.flag_key, row.enabled, row.revision]);
    }
  });
  await query("UPDATE mbt_feature_flags SET enabled=$1,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'", [credits]);
  const transport = globalThis.fetch;
  remote.events = [];
  remote.control.searchBalance = 13;
  remote.control.searchError = null;
  remote.control.searchEdit = null;
  remote.control.afterCreditRead = null;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const address = String(url);
    if (address.includes('/app/site/hosting/restlet.nl')) {
      return reportResponse(remote, address, options);
    }
    if (address.includes('/query/') && JSON.parse(options.body || '{}').q?.includes('return_pallet_credit_identity')) {
      remote.events.push('credits');
      remote.requests.push({ address, method: options.method, body: JSON.parse(options.body) });
      const items = remote.control.credits.map(credit => ({
        transaction_id: credit.transaction_id, externalid: credit.externalid || ''
      }));
      await remote.control.afterCreditRead?.();
      return Response.json({ items, hasMore: false });
    }
    const creditId = address.match(/\/creditMemo\/(\d+)/)?.[1];
    if (creditId && options.method === 'GET' && !remote.created.has(creditId)) {
      return Response.json({ 'o:errorDetails': [{ 'o:errorCode': 'NONEXISTENT_ID', detail: 'Deleted fixture credit' }] }, { status: 404 });
    }
    return transport(url, options);
  });
  return remote;
}

test('N2 no-local-return lookup uses one report and no historical aggregate or credit identity read', async t => {
  const remote = await setup(t);
  const result = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(result.available, 13);
  assert.equal(result.netBalance, 13);
  assert.equal(result.source, 'netsuite_saved_search');
  assert.equal(result.savedSearchId, 'customsearch503');
  assert.equal(result.fulfilled, null);
  assert.equal(result.netsuiteReturned, null);
  assert.deepEqual(remote.events, ['report']);
  assert.equal(historyQueries(remote).length, 0);
});

test('R1 enquiries and submit admission refresh the report instead of reusing stale success', async t => {
  const remote = await setup(t);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 13);
  remote.control.searchBalance = 2;
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 2);
  remote.control.searchBalance = 1;
  await assert.rejects(submit(await submitInput({ stock: false, pallet: true, quantity: 2 })), { code: 'PALLET_QUOTA_EXCEEDED' });
  assert.deepEqual(remote.events, ['report', 'report', 'report']);
  assert.equal((await query('SELECT count(*)::int AS n FROM return_records WHERE customer_id=$1', [customerId])).rows[0].n, 0);
});

test('N1/R1 report failures never fall back to the other balance calculation', async t => {
  const remote = await setup(t);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 13);
  for (const problem of [400, 401, 403, 500, 'transport', 'json']) {
    remote.control.searchError = problem;
    await assert.rejects(lookupReturnCustomerPalletBalance(customerId));
  }
  remote.control.searchError = null;
  remote.control.searchEdit = payload => { payload.rows[0][0] = '123'; };
  await assert.rejects(lookupReturnCustomerPalletBalance(customerId), { code: 'PALLET_SEARCH_INVALID' });
  assert.equal(historyQueries(remote).length, 0);
});

test('N1 foreign RESTlet hosts fail before any credential-bearing call to them', async t => {
  const remote = await setup(t);
  config.netsuite.palletBalanceRestletUrl = 'https://foreign.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=505&deploy=1';
  await assert.rejects(lookupReturnCustomerPalletBalance(customerId), { code: 'INVALID_NETSUITE_RESTLET_URL' });
  assert.equal(remote.requests.some(request => request.address.includes('foreign.')), false);
});

test('property: RESTlet authentication never leaves the configured account and HTTPS endpoint', async t => {
  const remote = await setup(t);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 9999 }),
    fc.constantFrom('account', 'protocol', 'credentials', 'fragment', 'port', 'path'), async (id, fault) => {
      const url = new URL(config.netsuite.palletBalanceRestletUrl);
      url.searchParams.set('customerId', String(customerId));
      if (fault === 'account') { url.hostname = `other-${id}.restlets.api.netsuite.com`; }
      if (fault === 'protocol') { url.protocol = 'http:'; }
      if (fault === 'credentials') { url.username = 'untrusted'; }
      if (fault === 'fragment') { url.hash = 'untrusted'; }
      if (fault === 'port') { url.port = '8443'; }
      if (fault === 'path') { url.pathname = '/other'; }
      await assert.rejects(readNetSuiteRestlet(url.toString()), { code: 'INVALID_NETSUITE_RESTLET_URL' });
      assert.equal(remote.requests.length, 0);
    }), { numRuns: 40, seed: 505 });
});

test('R1 an optional cached adapter read cannot make an operator enquiry or submission stale', async t => {
  const remote = await setup(t);
  const options = { force: false, includeCreditIdentity: false };
  const before = await fetchPalletBalanceFromNetSuite(customerId, { ...options, force: true });
  remote.control.searchBalance = 2;
  assert.equal((await fetchPalletBalanceFromNetSuite(customerId, options)).netBalance, before.netBalance);
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 2);
  remote.control.searchBalance = 1;
  await assert.rejects(submit(await submitInput({ stock: false, pallet: true, quantity: 2 })), { code: 'PALLET_QUOTA_EXCEEDED' });
});

test('S3 valid empty search disables pallet allowance without inventing totals', async t => {
  const remote = await setup(t);
  remote.control.searchEdit = payload => Object.assign(payload, { found: false, rowCount: 0, rows: [] });
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.available, 0);
  assert.equal(balance.balanceFound, false);
  assert.equal(balance.fulfilled, null);
  await assert.rejects(submit(await submitInput({ stock: false, pallet: true, quantity: 1 })), { code: 'PALLET_QUOTA_EXCEEDED' });
});

test('R2 local-only returns deduct the new net source under the customer lock', async t => {
  const remote = await setup(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_%'");
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }));
  const snapshot = (await getReturnRecordDetail(result.palletReturn.id)).balanceSnapshot;
  assert.equal(snapshot.netBalance, 13);
  assert.equal(snapshot.fulfilled, null);
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.netBalance, 13);
  assert.equal(balance.localReserved, 3);
  assert.equal(balance.available, 10);
  assert.deepEqual(remote.events, ['report', 'credits', 'report']);
});

test('R2 simultaneous return requests cannot consume the same saved-search allowance twice', async t => {
  const remote = await setup(t);
  remote.control.searchBalance = 5;
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_%'");
  const inputs = await Promise.all(Array.from({ length: 2 }, () => submitInput({ stock: false, pallet: true, quantity: 3 })));
  const results = await Promise.allSettled(inputs.map(submit));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(['PALLET_QUOTA_EXCEEDED', 'PALLET_QUOTA_CHANGED'].includes(rejected.reason.code));
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 2);
});

test('N3 completed direct credits are not deducted twice; unindexed credits stay reserved', async t => {
  const remote = await setup(t, { credits: true });
  remote.control.searchBalance = 20;
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }), true);
  const record = result.palletReturn;
  const pending = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(pending.available, 17);
  assert.equal(pending.localReserved, 3);
  remote.control.credits = [{ transaction_id: record.netSuiteTransactionId, quantity: 3 }];
  remote.control.searchBalance = 17;
  const counted = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(counted.localReserved, 0);
  assert.equal(counted.available, 17);
  assert.deepEqual(remote.events.slice(-2), ['credits', 'report']);
});

test('N3 deleted verified credits reconcile and restore the saved-search allowance', async t => {
  const remote = await setup(t, { credits: true });
  remote.control.searchBalance = 20;
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }), true);
  remote.created.delete(String(result.palletReturn.netSuiteTransactionId));
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.available, 20);
  assert.equal(balance.localReserved, 0);
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteSyncStatus, 'cancelled');
});

test('N3 a new credit after the identity read cannot release a reservation against an older report', async t => {
  const remote = await setup(t, { credits: true });
  remote.control.searchBalance = 20;
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }), true);
  remote.control.afterCreditRead = () => {
    remote.control.credits = [{ transaction_id: result.palletReturn.netSuiteTransactionId, quantity: 3 }];
    remote.control.searchBalance = 17;
  };
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.deepEqual(remote.events.slice(-2), ['credits', 'report']);
  assert.equal(balance.localReserved, 3, 'The later credit was not in the identity snapshot.');
  assert.equal(balance.available, 14, 'Conservative temporary double reservation cannot over-grant.');
  assert.equal((await lookupReturnCustomerPalletBalance(customerId)).available, 17);
});

test('N3 partial RA credits release only credited pallets and keep the uncredited remainder reserved', async t => {
  const remote = await setup(t);
  remote.control.searchBalance = 20;
  const result = await submit(await submitInput({ stock: false, pallet: true, quantity: 3 }), true);
  remote.control.credits = [{ return_authorization_id: result.palletReturn.netSuiteTransactionId,
    transaction_id: 8801, quantity: 2 }];
  remote.control.searchBalance = 18;
  const balance = await lookupReturnCustomerPalletBalance(customerId);
  assert.equal(balance.netBalance, 18);
  assert.equal(balance.localReserved, 1);
  assert.equal(balance.available, 17);
});

test('N3 credit identity SQL excludes other customers, items, accounting rows, headers, tax and inactive transactions', async t => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  t.after(() => client.end());
  await client.query(`
    CREATE TEMP TABLE transaction(id bigint,entity bigint,type text,status text,externalid text);
    CREATE TEMP TABLE transactionline(transaction bigint,item bigint,iscogs text,mainline text,taxline text);
    INSERT INTO transaction VALUES
      (11,5240,'CustCred','Open','credit-11'),(12,1959,'CustCred','Open','other-customer'),
      (13,5240,'CustCred','Voided','void'),(14,5240,'ItemShip','Shipped','fulfillment'),
      (15,5240,'CustCred','Open','other-item'),(16,5240,'CustCred','Open','tax'),
      (17,5240,'CustCred','Open','header'),(18,5240,'CustCred','Open','credit-18'),
      (19,5240,'CustCred','Cancelled','cancel'),(20,5240,'CustCred','Rejected','reject'),
      (21,5240,'CustCred','Open','accounting-only');
    INSERT INTO transactionline VALUES
      (11,1784,'F','F','F'),(11,1784,'T','F','F'),(11,1784,'F','F','F'),
      (12,1784,'F','F','F'),(13,1784,'F','F','F'),(14,1784,'F','F','F'),
      (15,9999,'F','F','F'),(16,1784,'F','F','T'),(17,1784,'F','T','F'),
      (18,1784,'F','F',NULL),(19,1784,'F','F','F'),(20,1784,'F','F','F'),
      (21,1784,'T','F','F');
  `);
  const sql = palletCreditIdentityQuery(5240, 1784)
    .replaceAll('NVL(', 'COALESCE(').replaceAll('BUILTIN.DF(t.status)', 't.status');
  const result = await client.query(sql);
  assert.deepEqual(result.rows, [
    { transaction_id: '11', externalid: 'credit-11' },
    { transaction_id: '18', externalid: 'credit-18' }
  ]);
  assert.throws(() => palletCreditIdentityQuery('5240 OR 1=1', 1784), { status: 400 });
});
