import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { normalizeReturnRecipient, buildReturnNotification } from '../../../src/return-notification-domain.js';
import { createReturnNotificationSettings } from '../../../src/return-notification-settings.js';
import { createReturnNotificationTransport } from '../../../src/return-notification-transport.js';

const record = (overrides = {}) => ({ id: 1, batchId: 2, recordType: 'stock', status: 'accepted',
  netSuiteSyncStatus: 'succeeded', netSuiteStage: 'credit_memo', netSuiteTransactionId: 123,
  netSuiteTransactionRef: 'CMB00123', ...overrides });

test('N1 one field detects and normalizes email, Canadian and international phones', () => {
  assert.deepEqual(normalizeReturnRecipient(' Customer@Example.com '), { channel: 'email', recipient: 'customer@example.com' });
  for (const input of ['4165550123', '(416) 555-0123', '1-416-555-0123', '+1 416 555 0123']) {
    assert.deepEqual(normalizeReturnRecipient(input), { channel: 'sms', recipient: '+14165550123' });
  }
  assert.equal(normalizeReturnRecipient('+44 7700 900123').recipient, '+447700900123');
});

test('N9 reject multiple recipients, hostile input and malformed numbers', () => {
  for (const input of ['', null, {}, ['a@b.com'], 'a@b.com,b@b.com', 'Name <a@b.com>',
    'a@b.com\r\nBcc:x@y.com', '4165550123 ext 5', '447700900123', '+01234567890',
    '+14165550123,+14165550124', 'a'.repeat(255), '416\n5550123']) {
    assert.throws(() => normalizeReturnRecipient(input), error => error.status === 400, String(input));
  }
});

test('N1 property: formatted North American numbers have stable normalization', () => {
  fc.assert(fc.property(fc.integer({ min: 2000000000, max: 9999999999 }), number => {
    const digits = String(number);
    const parsed = normalizeReturnRecipient(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`);
    assert.equal(parsed.recipient, `+1${digits}`);
    assert.deepEqual(normalizeReturnRecipient(parsed.recipient), parsed);
  }), { seed: 311, numRuns: 100 });
});

test('N2 block unposted, cancelled, voided and missing-reference records', () => {
  const cases = ['pending', 'failed', 'disabled', 'cancelled'].map(netSuiteSyncStatus => ({ netSuiteSyncStatus }));
  cases.push({ status: 'voided' }, { netSuiteTransactionRef: '' }, { netSuiteTransactionId: null }, { netSuiteStage: 'none' });
  for (const change of cases) {
    assert.throws(() => buildReturnNotification([record(change)]), error => error.status === 409);
  }
  assert.throws(() => buildReturnNotification([]), error => error.status === 409);
});

test('N3 exact CMB/RA numbers, shared transaction deduplication and no financial data', () => {
  const message = buildReturnNotification([record({ actualCredit: 987.65 }), record({ id: 2, recordType: 'pallet' })]);
  assert.match(message.text, /stock and pallet return/i);
  assert.equal(message.text.split('CMB00123').length - 1, 1);
  assert.doesNotMatch(message.text, /987|batch|12345/);
  const ra = buildReturnNotification([record({ recordType: 'pallet', netSuiteStage: 'return_authorization',
    netSuiteSyncStatus: 'manual_linked', netSuiteTransactionRef: 'RA12345' })]);
  assert.match(ra.text, /Return Authorization: RA12345/);
  assert.notEqual(ra.referenceKey, message.referenceKey);
});

test('N5 settings encrypt the key, never return it, preserve blank keys and allow explicit removal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'return-notification-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = createReturnNotificationSettings({ directory });
  const secret = 'synthetic-telnyx-credential';
  const saved = await settings.save({ apiKey: secret, fromNumber: '+14165550123' });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.configured, true);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  const files = await fs.readdir(directory);
  for (const file of files) {
    const fullPath = path.join(directory, file);
    assert.equal((await fs.readFile(fullPath, 'utf8')).includes(secret), false);
    assert.equal((await fs.stat(fullPath)).mode & 0o777, 0o600);
  }
  await settings.save({ apiKey: '', fromNumber: '+14165550124' });
  const reopened = createReturnNotificationSettings({ directory });
  assert.equal((await reopened.read()).apiKey, secret);
  assert.equal((await reopened.read()).fromNumber, '+14165550124');
  await assert.rejects(settings.save({ apiKey: 'synthetic-bad\nkey', fromNumber: '+14165550124' }), /API key/);
  assert.equal((await settings.save({ clearApiKey: true })).hasApiKey, false);
});

test('N5 invalid settings preserve credentials; missing or damaged credential storage fails closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'return-notification-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = createReturnNotificationSettings({ directory });
  await settings.save({ apiKey: 'synthetic-storage-key', fromNumber: '+14165550123' });
  for (const input of [{ apiKey: 7 }, { apiKey: 'x'.repeat(513) }, { fromNumber: '4165550123' }, { fromNumber: {} }, { clearApiKey: 'yes' }]) {
    await assert.rejects(settings.save(input), error => error.status === 400);
    assert.equal((await settings.read()).apiKey, 'synthetic-storage-key');
  }
  await fs.rm(path.join(directory, '.return-notification-key'));
  await assert.rejects(settings.read(), error => error.status === 503 && !error.message.includes('synthetic-storage-key'));
  await fs.writeFile(path.join(directory, 'return-notification-settings.json'), 'invalid JSON');
  await assert.rejects(settings.public(), /Unable to read return notification settings/);
});

const smsSettings = { read: async () => ({ apiKey: 'synthetic-telnyx-credential', fromNumber: '+14165550123' }) };
test('N6 SMS contract uses Telnyx v2, Bearer key, normalized recipient and saved message', async () => {
  const calls = [];
  const transport = createReturnNotificationTransport({ settings: smsSettings, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: { id: 'provider-123', to: [{ status: 'queued' }] } });
  } });
  const result = await transport.send({ channel: 'sms', recipient: '+14165550124', text: 'Credit Memo: CMB00123' });
  assert.equal(result.providerId, 'provider-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-telnyx-credential');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    from: '+14165550123', to: '+14165550124', text: 'Credit Memo: CMB00123', type: 'SMS'
  });
  assert.ok(calls[0].options.signal);
});

test('N6 real provider adapters handle refusal without exposing credentials or claiming delivery', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ data: { id: 'rejected', to: [{ status: 'sending_failed' }] } }); };
  const sms = createReturnNotificationTransport({ settings: smsSettings });
  await assert.rejects(sms.send({ channel: 'sms', recipient: '+14165550124', text: 'RA1' }), error => error.deliveryStatus === 'failed');
  assert.equal(calls, 1);
  // No SMTP service runs in the disposable container. Exercise the actual
  // nodemailer connection boundary; a refused connection cannot send an email.
  const mail = createReturnNotificationTransport({ env: { BOSS_SMTP_HOST: '127.0.0.1', BOSS_SMTP_PORT: '587',
    BOSS_SMTP_USER: 'synthetic-user', BOSS_SMTP_PASSWORD: 'synthetic-password' } });
  await assert.rejects(mail.send({ channel: 'email', recipient: 'customer@example.com', text: 'RA1' }), error => error.deliveryStatus === 'failed');
});

test('N7 provider refusal is safe to retry; network errors and missing acceptance are uncertain; secrets never escape', async () => {
  for (const [fetchImpl, expected] of [
    [async () => Response.json({ errors: [{ detail: 'synthetic-telnyx-credential' }] }, { status: 401 }), 'failed'],
    [async () => { throw new Error('synthetic-telnyx-credential'); }, 'uncertain'],
    [async () => Response.json({}), 'uncertain'],
    [async () => Response.json({ errors: [] }, { status: 503 }), 'uncertain'],
    [async () => Response.json({ errors: [] }, { status: 408 }), 'uncertain']
  ]) {
    const transport = createReturnNotificationTransport({ settings: smsSettings, fetchImpl });
    await assert.rejects(transport.send({ channel: 'sms', recipient: '+14165550124', text: 'CMB00123' }), error => {
      assert.equal(error.deliveryStatus, expected);
      assert.equal(String(error).includes('synthetic-telnyx-credential'), false);
      return true;
    });
  }
});

test('N7 explicit SMTP refusals can retry; a lost acknowledgement stays uncertain', async () => {
  for (const [failure, expected] of [
    [{ responseCode: 550 }, 'failed'], [{ code: 'ECONNREFUSED' }, 'failed'], [{ code: 'ETIMEDOUT', command: 'DATA' }, 'uncertain']
  ]) {
    let closed = false;
    const transport = createReturnNotificationTransport({ settings: smsSettings,
      env: { BOSS_SMTP_HOST: 'smtp.invalid', BOSS_SMTP_USER: 'synthetic-user', BOSS_SMTP_PASSWORD: 'synthetic-password' },
      loadTransport: async () => ({ sendMail: async () => { throw Object.assign(new Error('synthetic-secret'), failure); }, close: () => { closed = true; } })
    });
    await assert.rejects(transport.send({ channel: 'email', recipient: 'customer@example.com', text: 'RA1' }), error => {
      assert.equal(error.deliveryStatus, expected);
      assert.doesNotMatch(String(error), /synthetic-secret/);
      return true;
    });
    assert.equal(closed, true);
  }
});

test('N6 missing settings fail before delivery and SMTP uses TLS with the existing sender', async () => {
  const empty = createReturnNotificationTransport({ settings: { read: async () => ({}) }, env: {} });
  await assert.rejects(empty.checkReady('sms'), /Telnyx/);
  await assert.rejects(empty.checkReady('email'), /email|SMTP/i);
  let options; let sent;
  const transport = createReturnNotificationTransport({ settings: smsSettings,
    env: { BOSS_SMTP_HOST: 'smtp.invalid', BOSS_SMTP_USER: 'synthetic-user', BOSS_SMTP_PASSWORD: 'synthetic-password', BOSS_SMTP_FROM: 'returns@example.com' },
    loadTransport: async value => { options = value; return { sendMail: async message => {
      sent = message; return { accepted: ['customer@example.com'], messageId: 'mail-123' };
    } }; }
  });
  assert.equal((await transport.send({ channel: 'email', recipient: 'customer@example.com', subject: 'Return', text: 'RA12345' })).providerId, 'mail-123');
  assert.equal(options.requireTLS, true);
  assert.equal(options.disableFileAccess, true);
  assert.equal(sent.to, 'customer@example.com');
  assert.equal(sent.from.address, 'returns@example.com');
  assert.equal(sent.text, 'RA12345');
});
