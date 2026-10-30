import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { normalizeOperatorPopupEvent } from '../../../src/operator-popup-audit.js';
import { closeDb } from '../../../src/db.js';

after(closeDb);
const source = await readFile('public/operator-popup-audit.js', 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function logger(request) {
  let active = { actorId: 'test-operator', session: 'test-session', locationId: 1 };
  const timers = new Map();
  let sequence = 0;
  const window = { setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(source, { window, console: { warn() {} } }, { filename: path.resolve('public/operator-popup-audit.js') });
  const audit = window.MBBSOperatorPopupAudit.create({ request, context: () => active });
  const item = { popupId: crypto.randomUUID(), popupScope: audit.scope(), orderId: '1092133', notificationKey: 'test-key' };
  return { audit, item, timers, changeSession: () => { active = { ...active, session: 'another-session' }; },
    retry: async () => { const run = [...timers.values()][0]; timers.clear(); run?.(); await settle(); } };
}

test('L1 duplicate rendering sends one displayed receipt and preserves popup identity', async () => {
  const calls = [], h = logger(async body => calls.push(body));
  h.audit.record('displayed', [h.item], 'visible');
  h.audit.record('displayed', [h.item], 'visible');
  await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].popupId, h.item.popupId);
  assert.equal(calls[0].parkingSpot, ''); assert.equal(calls[0].notificationPermission, 'unsupported');
  assert.equal(h.timers.size, 0);
});

test('L2 transient failure retries the same event at most three times', async () => {
  const calls = [], h = logger(async body => { calls.push(body); throw new Error('offline'); });
  h.audit.record('queued', [h.item], 'hidden'); await settle();
  await h.retry(); await h.retry(); await h.retry();
  assert.equal(calls.length, 3); assert.equal(h.timers.size, 0);
  assert.ok(calls.every(body => JSON.stringify(body) === JSON.stringify(calls[0])));
});

test('L3 terminal permission failures do not retry and old-session retries are discarded', async () => {
  let calls = 0;
  const terminal = logger(async () => { calls += 1; throw Object.assign(new Error('forbidden'), { status: 403 }); });
  terminal.audit.record('queued', [terminal.item], 'visible'); await settle();
  assert.equal(terminal.timers.size, 0); assert.equal(calls, 1);
  const old = logger(async () => { calls += 1; throw new Error('offline'); });
  old.audit.record('queued', [old.item], 'visible'); await settle();
  old.changeSession(); await old.retry();
  old.audit.record('displayed', [old.item], 'visible'); await settle();
  assert.equal(calls, 2); assert.equal(old.timers.size, 0);
});

test('V1 optional assignment fields round-trip without discarding empty strings or accepting extra properties', () => {
  fc.assert(fc.property(fc.string({ maxLength: 100 }), fc.string({ maxLength: 100 }), (truck, parkingSpot) => {
    const input = { popupId: crypto.randomUUID(), action: 'displayed', visibility: 'visible', clientTime: '2026-10-26T18:00:00Z',
      notificationPermission: 'denied', orderId: '1092133', notificationKey: 'test', truck, parkingSpot, forgedActor: 'other' };
    const event = normalizeOperatorPopupEvent(input);
    assert.equal(event.truck, truck.trim()); assert.equal(event.parkingSpot, parkingSpot.trim());
    assert.equal(event.load, ''); assert.equal(event.forgedActor, undefined);
  }), { numRuns: 200, seed: 1263 });
});

test('V2 rejects malformed IDs, missing required strings, invalid permission and oversized optional metadata', () => {
  const valid = { popupId: crypto.randomUUID(), action: 'queued', visibility: 'hidden', clientTime: '2026-10-26', notificationPermission: 'default', orderId: '1092133', notificationKey: 'key' };
  for (const extra of [{ popupId: 'x'.repeat(36) }, { orderId: '' }, { notificationPermission: 'other' }, { truck: 'x'.repeat(101) }, { notificationKey: {} }]) {
    assert.throws(() => normalizeOperatorPopupEvent({ ...valid, ...extra }), error => error.status === 400);
  }
});
