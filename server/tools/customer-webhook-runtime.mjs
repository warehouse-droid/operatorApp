import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { query, closeDb } from '../src/db.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const artifact = 'test-artifacts/customer-webhook/final';
const secret = process.env.NETSUITE_WEBHOOK_SECRET;
const child = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: '3197', APP_BASE_URL: 'http://127.0.0.1:3197' }, stdio: ['ignore', 'pipe', 'pipe']
});
const ended = once(child, 'exit');
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) { break; }
    try { ready = (await fetch('http://127.0.0.1:3197/health')).ok; } catch { /* startup */ }
    if (ready) { break; }
    await delay(250);
  }
  assert.ok(ready, `Application did not start: ${output.slice(-3000)}`);
  const id = String(2000000000 + Number.parseInt(randomUUID().slice(0, 7), 16));
  const body = { schemaVersion: 'netsuite-customer/v1', recordType: 'customer', eventType: 'create',
    accountId: process.env.NETSUITE_ACCOUNT_ID,
    customer: { netsuiteId: id, entityNumber: `LIVE-FIXTURE-${id}`, legalName: 'Synthetic webhook customer',
      displayName: 'Synthetic webhook customer', currency: 'CAD', email: '', phone: '', terms: '', taxStatus: '',
      creditStatus: '', active: true, sourceModifiedAt: '2026-10-01T12:00:00.000Z', addresses: [], subsidiaries: [] } };
  const response = await fetch('http://127.0.0.1:3197/api/webhooks/netsuite/customer', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mbbs-webhook-secret': secret }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.action, 'created');
  assert.equal((await query('SELECT display_name FROM netsuite_customers WHERE netsuite_id=$1', [id])).rows[0].display_name, body.customer.displayName);
  const orderResponse = await fetch('http://127.0.0.1:3197/api/webhooks/netsuite/order', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(orderResponse.status, 401);
  await writeFile(`${artifact}/runtime.json`, JSON.stringify({ health: true, customerWebhook: result, existingOrderWebhookUnauthenticatedStatus: orderResponse.status }, null, 2) + '\n');
  console.log('Full application startup and customer webhook HTTP persistence passed.');
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  await ended;
  clearTimeout(force);
  await writeFile(`${artifact}/runtime-app.log`, output);
  await closeDb();
}
