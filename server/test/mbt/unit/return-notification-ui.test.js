import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';

function ui(request = async () => ({ status: 'sent', channel: 'email' })) {
  const context = vm.createContext({ window: {}, Map });
  vm.runInContext(fs.readFileSync('public/return-notifications.js', 'utf8'), context);
  const controller = context.window.MBBSReturnNotifications;
  controller.configure({ request, render: () => {}, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') });
  return controller;
}
const posted = { id: 8, batchId: 12, recordType: 'stock', status: 'accepted', netSuiteSyncStatus: 'succeeded',
  netSuiteTransactionId: 77, netSuiteTransactionRef: 'CMB0077', netSuiteStage: 'credit_memo' };

test('N1 UI shows exactly one recipient field for posted stock, pallet and combined returns', () => {
  const controller = ui();
  for (const records of [[posted], [{ ...posted, recordType: 'pallet' }], [posted, { ...posted, id: 9, recordType: 'pallet' }]]) {
    const html = controller.html(records);
    assert.equal((html.match(/<input\b/g) || []).length, 1);
    assert.match(html, /Email or mobile number/);
    assert.match(html, /Send/);
    assert.match(html, /CMB0077/);
  }
  assert.equal(controller.html([{ ...posted, netSuiteSyncStatus: 'pending' }]), '');
  assert.equal(controller.html([{ ...posted, netSuiteTransactionRef: '' }]), '');
  assert.equal(controller.html([{ ...posted, status: 'voided' }]), '');
});

test('N7 UI double clicks send once, keeps the recipient and confirms successful sending', async () => {
  const calls = [];
  let resolve;
  const controller = ui(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Promise(done => { resolve = done; });
  });
  controller.html([posted]);
  controller.input('12', 'customer@example.com');
  const sending = controller.send('12', '8');
  await controller.send('12', '8');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/returns/operator/history/8/notify');
  assert.deepEqual(calls[0].body, { recipient: 'customer@example.com' });
  assert.match(controller.html([posted]), /Sending/);
  resolve({ status: 'sent', channel: 'email' });
  await sending;
  assert.match(controller.html([posted]), /Email sent successfully/);
  assert.match(controller.html([posted]), /customer@example.com/);
});

test('N8 UI preserves failed recipient and escapes provider errors', async () => {
  const controller = ui(async () => { throw new Error('<unsafe>'); });
  controller.html([posted]);
  controller.input('12', 'customer@example.com');
  await controller.send('12', '8');
  const html = controller.html([posted]);
  assert.match(html, /&lt;unsafe>/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.match(html, /customer@example.com/);
});

test('N5 request auditing redacts Telnyx API keys', () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  const pattern = source.match(/const AUDIT_SENSITIVE_FIELD = (.+);/)[1];
  const sensitive = vm.runInNewContext(pattern);
  for (const key of ['apiKey', 'api_key', 'password', 'privateKey']) { assert.ok(sensitive.test(key), key); }
});
