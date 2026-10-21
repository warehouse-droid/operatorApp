import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import express from 'express';
import fc from 'fast-check';
import { closeDb, pool, query } from '../../../src/db.js';
import { normalizeCustomerWebhook, acceptCustomerWebhook } from '../../../src/netsuite-customer-webhook.js';
import { createCustomerWebhookRouter } from '../../../src/netsuite-customer-webhook-router.js';
import { searchSpecialCustomerDirectory } from '../../../src/special-stock-customer-directory.js';
import { searchCustomers } from '../../../src/mbt/customer-operations-service.js';
import { getLocalReturnCustomerById } from '../../../src/return-customer-directory.js';

const accountId = 'CUSTOMER_WEBHOOK_TEST';
const secret = 'customer-webhook-fixture-secret';
let id = 810000000 + Number.parseInt(randomUUID().slice(0, 7), 16);
const payload = (changes = {}) => ({
  schemaVersion: 'netsuite-customer/v1', recordType: 'customer', eventType: 'create', accountId,
  customer: { netsuiteId: String(++id), entityNumber: `CW-${id}`, legalName: `Webhook ${id}`,
    displayName: `Webhook ${id}`, currency: 'CAD', email: 'fixture@example.invalid', phone: '5550101234',
    terms: 'Net 30', taxStatus: '', creditStatus: 'AUTO', active: true,
    sourceModifiedAt: '2026-10-01T12:00:00.000Z',
    addresses: [{ netsuiteAddressId: '11', shippingDefault: true, addressLine1: '1 Test Street', city: 'Testville', countryCode: 'CA' }],
    subsidiaries: [{ netsuiteId: '1', primary: true, relationshipName: 'Test subsidiary' }], ...changes }
});
let server, base;
let settings = { webhookSecret: secret, accountId };
let mirror = false;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const app = express();
  app.use('/api/webhooks/netsuite/customer', createCustomerWebhookRouter({
    settings: () => settings, isMirrorConsumer: () => mirror
  }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/webhooks/netsuite/customer`;
});
after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
async function send(body, credential = secret, raw = false) {
  const response = await fetch(base, { method: 'POST', headers: {
    'content-type': 'application/json', ...(credential === null ? {} : { 'x-mbbs-webhook-secret': credential })
  }, body: raw ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('authenticated create is committed and immediately visible in existing searches', async () => {
  const input = payload();
  const result = await send(input);
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'created');
  assert.equal(String(result.body.customerId), input.customer.netsuiteId);
  assert.equal(result.body.duplicate, false);
  assert.equal((await searchSpecialCustomerDirectory(input.customer.entityNumber))[0].displayName, input.customer.displayName);
  assert.equal((await searchCustomers({ query: input.customer.entityNumber })).items[0].email, input.customer.email);
  assert.match((await getLocalReturnCustomerById(input.customer.netsuiteId)).address, /1 Test Street/);
  const audit = await query("SELECT actor_type, details FROM delivery_audit_log WHERE action='netsuite.webhook.customer' AND details->>'customerId'=$1", [input.customer.netsuiteId]);
  assert.equal(audit.rows[0].actor_type, 'system');
  assert.equal(JSON.stringify(audit.rows).includes(secret), false);
});
test('retries and simultaneous requests create one customer and one event', async () => {
  const input = payload();
  const results = await Promise.all(Array.from({ length: 12 }, () => send(input)));
  assert.deepEqual(results.map(r => r.status), Array(12).fill(200));
  assert.equal(results.filter(r => r.body.action === 'created').length, 1);
  assert.equal(results.filter(r => r.body.duplicate).length, 11);
  assert.equal((await query('SELECT count(*)::int AS count FROM netsuite_customers WHERE netsuite_id=$1', [input.customer.netsuiteId])).rows[0].count, 1);
  assert.equal((await query('SELECT count(*)::int AS count FROM mbt_customer_master_events WHERE customer_netsuite_id=$1', [input.customer.netsuiteId])).rows[0].count, 1);
});
test('newer event wins; stale and same-time conflicting events cannot overwrite it', async () => {
  const input = payload();
  assert.equal((await send(input)).status, 200);
  const newer = structuredClone(input);
  Object.assign(newer.customer, { displayName: 'Newest customer', sourceModifiedAt: '2026-10-02T12:00:00.000Z' });
  assert.equal((await send(newer)).body.action, 'updated');
  assert.equal((await send(input)).body.action, 'ignored');
  newer.customer.displayName = 'Conflicting customer';
  assert.equal((await send(newer)).status, 409);
  assert.equal((await query('SELECT display_name FROM netsuite_customers WHERE netsuite_id=$1', [input.customer.netsuiteId])).rows[0].display_name, 'Newest customer');
});
test('inactivation removes active search and return projection without hard deletion', async () => {
  const input = payload();
  const unrelated = payload();
  await send(unrelated);
  await send(input);
  Object.assign(input.customer, { active: false, sourceModifiedAt: '2026-10-03T12:00:00.000Z' });
  assert.equal((await send(input)).body.action, 'updated');
  assert.deepEqual(await searchSpecialCustomerDirectory(input.customer.entityNumber), []);
  assert.equal(await getLocalReturnCustomerById(input.customer.netsuiteId), null);
  assert.equal((await query('SELECT active FROM netsuite_customers WHERE netsuite_id=$1', [input.customer.netsuiteId])).rows[0].active, false);
  assert.equal((await searchSpecialCustomerDirectory(unrelated.customer.entityNumber)).length, 1);
});
test('configuration, header authentication, account binding and mirror restrictions fail closed', async () => {
  const input = payload();
  for (const credential of [null, '', 'wrong', secret.slice(0, -1) + 'x']) {
    assert.equal((await send({ ...input, secret }, credential)).status, 401);
  }
  try {
    settings = { webhookSecret: '', accountId };
    assert.equal((await send(input)).status, 503);
    settings = { webhookSecret: secret, accountId: '' };
    assert.equal((await send(input)).status, 503);
    settings = { webhookSecret: secret, accountId };
    mirror = true;
    assert.equal((await send(input)).status, 403);
  } finally { settings = { webhookSecret: secret, accountId }; mirror = false; }
  assert.equal((await send({ ...input, accountId: 'WRONG_ACCOUNT' })).status, 403);
  assert.equal((await query('SELECT 1 FROM netsuite_customers WHERE netsuite_id=$1', [input.customer.netsuiteId])).rowCount, 0);
});
test('malformed, incomplete and oversized input is rejected with no writes', async () => {
  const input = payload();
  for (const invalid of [null, [], {}, { ...input, schemaVersion: 'v999' }, { ...input, recordType: 'vendor' },
    { ...input, eventType: 'delete' }, ...[
      { netsuiteId: '0' }, { netsuiteId: '9007199254740992' }, { netsuiteId: {} },
      { sourceModifiedAt: 'yesterday' }, { sourceModifiedAt: '2026-02-30T00:00:00.000Z' },
      { currency: 'Canadian Dollar' }, { active: 'F' }, { displayName: '' }, { email: undefined },
      { phone: '\u0000' }, { addresses: [{}] }, { subsidiaries: [{ netsuiteId: '-1' }] }
    ].map(change => ({ ...input, customer: { ...input.customer, ...change } }))]) {
    assert.equal((await send(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await send('{broken', secret, true)).status, 400);
  assert.equal((await send({ ...input, padding: 'x'.repeat(270000) })).status, 413);
  assert.equal((await query('SELECT 1 FROM netsuite_customers WHERE netsuite_id=$1', [input.customer.netsuiteId])).rowCount, 0);
});
test('real database rollback removes all writes if audit persistence fails', async () => {
  const input = payload();
  const database = { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => {
      if (sql.includes('INSERT INTO delivery_audit_log')) { throw new Error('injected audit failure'); }
      return client.query(sql, params);
    } };
  }, query: (...args) => pool.query(...args) };
  await assert.rejects(acceptCustomerWebhook(input, { accountId, database }), /injected audit failure/);
  for (const [table, column] of [['netsuite_customers', 'netsuite_id'], ['return_customer_directory', 'netsuite_customer_id'], ['mbt_customer_master_events', 'customer_netsuite_id']]) {
    assert.equal((await query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`, [input.customer.netsuiteId])).rows[0].count, 0);
  }
  assert.equal((await query("SELECT 1 FROM netsuite_customer_sync_runs WHERE metadata->>'customerId'=$1", [input.customer.netsuiteId])).rowCount, 0);
  assert.equal((await query("SELECT 1 FROM delivery_audit_log WHERE details->>'customerId'=$1", [input.customer.netsuiteId])).rowCount, 0);
});
test('property: normalized snapshot hashes are stable across event type and JSON key order', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000000 }), fc.stringMatching(/^[A-Za-z]{1,30}$/), fc.boolean(), (customerId, name, active) => {
    const input = payload({ netsuiteId: String(customerId), legalName: name, displayName: name, active });
    const first = normalizeCustomerWebhook(input, accountId);
    const shuffled = JSON.parse(JSON.stringify(input));
    shuffled.eventType = 'edit';
    shuffled.customer = Object.fromEntries(Object.entries(shuffled.customer).reverse());
    const second = normalizeCustomerWebhook(shuffled, accountId);
    assert.equal(first.payloadHash, second.payloadHash);
    assert.equal(first.netsuiteId, String(customerId));
    assert.equal(first.active, active);
    shuffled.customer.phone = '5559998888';
    assert.notEqual(first.payloadHash, normalizeCustomerWebhook(shuffled, accountId).payloadHash);
  }), { seed: 7109, numRuns: 100 });
});
test('HTTP persistence failures return a retryable response without exposing internals', async () => {
  const app = express();
  app.use(createCustomerWebhookRouter({ settings: () => ({ webhookSecret: secret, accountId }),
    isMirrorConsumer: () => false, accept: async () => { throw new Error('private database connection details'); } }));
  const failingServer = app.listen(0, '127.0.0.1');
  try {
    await once(failingServer, 'listening');
    const response = await fetch(`http://127.0.0.1:${failingServer.address().port}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mbbs-webhook-secret': secret }, body: JSON.stringify(payload()) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Customer webhook could not be saved. Retry this event.' });
  } finally { await new Promise(resolve => failingServer.close(resolve)); }
});
