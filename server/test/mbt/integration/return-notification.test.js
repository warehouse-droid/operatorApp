import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { query, closeDb } from '../../../src/db.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { createReturnNotificationService } from '../../../src/return-notification-service.js';
import { returnNotificationTransport } from '../../../src/return-notification-transport.js';
import { app } from '../../../src/server.js';
after(closeDb);

async function fixture(t, { yard = 1, role = 'operator' } = {}) {
  const name = `notify-${crypto.randomUUID()}`;
  const operator = await createOperator({ username: name, displayName: 'Notification test', password: 'synthetic-password',
    role, roles: [role], operatorYardLocationIds: [1] });
  const result = await query(`INSERT INTO return_batches(batch_reference,idempotency_key,operator_id,receiving_location_id,receiving_yard_code,vehicle_plate)
    VALUES($1,$1,$2,$3,'3445','TEST') RETURNING id`, [name, operator.id, yard]);
  const batch = result.rows[0].id;
  t.after(async () => {
    await query('DELETE FROM return_customer_notifications WHERE batch_id=$1', [batch]);
    await query('DELETE FROM return_records WHERE batch_id=$1', [batch]);
    await query('DELETE FROM return_batches WHERE id=$1', [batch]);
    await query('DELETE FROM operators WHERE id=$1', [operator.id]);
  });
  const inserted = await query(`INSERT INTO return_records(record_reference,batch_id,record_type,operator_id,customer_id,customer_name,
    receiving_location_id,vehicle_plate,pallet_quantity,external_id,netsuite_stage,netsuite_sync_status,netsuite_transaction_id,netsuite_transaction_ref,workflow_version)
    VALUES($1,$2,'pallet',$3,999999,'Synthetic customer',$4,'TEST',1,$1,'credit_memo','succeeded',$5,'CMB-TEST',2) RETURNING id`,
  [name, batch, operator.id, yard, Number(batch) + 90000000]);
  return { operator, batch, recordId: Number(inserted.rows[0].id), recipient: 'customer@example.com' };
}
const transport = send => ({ checkReady: async () => {}, send });

test('N3/N7 concurrent requests and a fresh service instance send the saved CMB number once', async t => {
  const calls = [];
  const service = createReturnNotificationService({ transport: transport(async message => { calls.push(message); return { providerId: 'test-message' }; }) });
  const input = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => service.send(input)));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Credit Memo: CMB-TEST/);
  assert.equal(calls[0].recipient, 'customer@example.com');
  assert.ok(results.some(result => result.status === 'sent'));
  const fresh = createReturnNotificationService({ transport: transport(async () => { assert.fail('duplicate message'); }) });
  const replay = await fresh.send(input);
  assert.equal(replay.status, 'sent');
  assert.equal(replay.replayed, true);
});

test('N4/N2 server rejects other owners, unassigned yards, unposted and missing reference before sending', async t => {
  const service = createReturnNotificationService({ transport: transport(async () => { assert.fail('unexpected delivery'); }) });
  const input = await fixture(t);
  await assert.rejects(service.send({ ...input, operator: { ...input.operator, id: 'another-operator' } }), error => error.status === 404);
  await assert.rejects(service.send({ ...input, operator: { ...input.operator, operatorYardLocationIds: [28] } }), error => error.status === 403);
  await query("UPDATE return_records SET netsuite_sync_status='pending' WHERE id=$1", [input.recordId]);
  await assert.rejects(service.send(input), error => error.status === 409);
  await query("UPDATE return_records SET netsuite_sync_status='succeeded',netsuite_transaction_ref=NULL WHERE id=$1", [input.recordId]);
  await assert.rejects(service.send(input), error => error.status === 409);
  assert.equal((await query('SELECT * FROM return_customer_notifications WHERE batch_id=$1', [input.batch])).rowCount, 0);
});

test('N7 uncertain sends stay blocked; definitive failures allow an explicit retry', async t => {
  const input = await fixture(t);
  let calls = 0;
  const service = createReturnNotificationService({ transport: transport(async () => {
    calls += 1;
    throw Object.assign(new Error('synthetic provider secret must not leak'), { deliveryStatus: 'uncertain' });
  }) });
  const result = await service.send(input);
  assert.equal(result.status, 'uncertain');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal((await service.send(input)).status, 'uncertain');
  assert.equal(calls, 1);
  await query("UPDATE return_customer_notifications SET status='sending',updated_at=now()-interval '10 minutes' WHERE batch_id=$1", [input.batch]);
  assert.equal((await service.send(input)).status, 'uncertain');
  assert.equal(calls, 1);
  await query("UPDATE return_customer_notifications SET status='failed' WHERE batch_id=$1", [input.batch]);
  const retry = createReturnNotificationService({ transport: transport(async () => { calls += 1; return { providerId: 'retry' }; }) });
  assert.equal((await retry.send(input)).status, 'sent');
  assert.equal(calls, 2);
});

test('N9 per-batch daily cap limits different recipients and failed retries', async t => {
  const input = await fixture(t);
  let calls = 0;
  const service = createReturnNotificationService({ transport: transport(async () => { calls += 1; return {}; }) });
  for (let i = 0; i < 10; i += 1) { await service.send({ ...input, recipient: `customer${i}@example.com` }); }
  await assert.rejects(service.send({ ...input, recipient: 'extra@example.com' }), error => error.status === 429);
  assert.equal(calls, 10);
});

test('N4/N5/N8 real HTTP authorizes settings and sends, returns sanitized settings, and redacts audit keys', async t => {
  const input = await fixture(t);
  const admin = await fixture(t, { role: 'admin' });
  const { token } = await loginOperator(input.operator.username, 'synthetic-password');
  const adminToken = (await loginOperator(admin.operator.username, 'synthetic-password')).token;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const call = async (route, method = 'GET', body, auth = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const route = '/api/admin/return-notifications';
  assert.equal((await call(route)).status, 403);
  assert.equal((await call(route, 'PUT', { apiKey: 'synthetic-key' })).status, 403);
  const saved = await call(route, 'PUT', { apiKey: 'synthetic-key', fromNumber: '+14165550123' }, adminToken);
  assert.equal(saved.status, 200);
  assert.equal(saved.cache, 'no-store');
  assert.equal(saved.body.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(saved.body), /synthetic-key/);
  assert.doesNotMatch(JSON.stringify((await call(route, 'GET', undefined, adminToken)).body), /synthetic-key/);
  assert.equal((await call(route, 'PUT', { fromNumber: 'not-a-phone' }, adminToken)).status, 400);
  const original = { send: returnNotificationTransport.send, checkReady: returnNotificationTransport.checkReady };
  t.after(() => Object.assign(returnNotificationTransport, original));
  const sent = [];
  returnNotificationTransport.checkReady = async () => {};
  returnNotificationTransport.send = async message => { sent.push(message); return { providerId: 'http-message' }; };
  const path = `/api/returns/operator/history/${input.recordId}/notify`;
  assert.equal((await call(path, 'POST', { recipient: 'customer@example.com' }, '')).status, 401);
  assert.equal((await call(path, 'POST', { recipient: 'one@example.com,two@example.com' })).status, 400);
  const sentResponse = await call(path, 'POST', { recipient: 'customer@example.com', text: 'forged RA999' });
  assert.equal(sentResponse.status, 200);
  assert.equal(sentResponse.body.status, 'sent');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CMB-TEST/);
  assert.doesNotMatch(sent[0].text, /forged/);
  const audit = await query("SELECT details FROM delivery_audit_log WHERE actor_operator_id=$1 AND details->>'route'='/api/admin/return-notifications'", [admin.operator.id]);
  assert.ok(audit.rowCount > 0);
  assert.doesNotMatch(JSON.stringify(audit.rows), /synthetic-key/);
});
