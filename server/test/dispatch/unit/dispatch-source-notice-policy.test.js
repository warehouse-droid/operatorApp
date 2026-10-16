import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { dispatchSourceNoticeChanges } from '../../../src/dispatch-source-notice-policy.js';

const item = { lineId: 7, itemId: 12, quantity: 11, unit: 'PC' };
const beforeOrder = { type: 'SO', netsuiteId: 9979901, sourceYard: '3445', raw: { pickup_location: '3445' }, items: [{ ...item, quantity: 10 }] };
const source = { ...beforeOrder, items: [item] };
const quantity = { field: 'quantity', lineId: '7', before: 10, after: 11 };
const receipt = { status: 'succeeded', completed_at: '2026-10-12T10:00:00Z', payload: { id: 9979901, lines: [item] } };
const select = (extra = {}) => dispatchSourceNoticeChanges({ beforeOrder, source, changes: [quantity], receipt, ...extra });

test('a successful matching NetSuite receipt keeps a genuine quantity notice', () => {
  assert.deepEqual(select(), [quantity]);
});

test('local pickup changes are omitted from a mixed NetSuite quantity notice', () => {
  const pickup = { field: 'sourceYard', before: '3445', after: '12441' };
  assert.deepEqual(select({ source: { ...source, sourceYard: '12441', pickupLocations: ['12441'] }, changes: [quantity, pickup] }), [quantity]);
});

test('no receipt, failed receipt, another identity or stale cargo cannot prove a NetSuite edit', () => {
  for (const record of [null, { ...receipt, status: 'failed' }, { ...receipt, payload: { ...receipt.payload, id: 5 } },
    { ...receipt, payload: { ...receipt.payload, lines: [{ ...item, quantity: 12 }] } }]) {
    assert.deepEqual(select({ receipt: record }), []);
  }
});

test('CO changes never become NetSuite order notices', () => {
  assert.deepEqual(select({ source: { ...source, type: 'CO' } }), []);
});

test('a real native NetSuite sync audit proves the exact line edit without a webhook', () => {
  const audit = { actor_type: 'system', source: 'netsuite', action: 'netsuite.line.update', order_id: 9979901, line_id: 7,
    details: { changes: { quantity: { before: '10', after: '11' } } } };
  assert.deepEqual(select({ receipt: null, audits: [audit] }), [quantity]);
  for (const altered of [{ ...audit, source: 'dispatch' }, { ...audit, actor_type: 'operator' }, { ...audit, order_id: 999 },
    { ...audit, line_id: 8 }, { ...audit, details: { changes: { quantity: { before: 9, after: 11 } } } }]) {
    assert.deepEqual(select({ receipt: null, audits: [altered] }), []);
  }
});

test('consecutive native NetSuite sync edits remain visible against the older saved quantity', () => {
  const changes = [{ ...quantity, after: 12 }];
  const audits = [10, 11].map(q => ({ actor_type: 'system', source: 'netsuite', action: 'netsuite.line.update',
    order_id: source.netsuiteId, line_id: 7, details: { changes: { quantity: { before: q, after: q + 1 } } } }));
  assert.deepEqual(select({ source: { ...source, items: [{ ...item, quantity: 12 }] }, changes, audits, receipt: null }), changes);
  assert.deepEqual(select({ source: { ...source, items: [{ ...item, quantity: 12 }] }, changes, audits: [audits[1]], receipt: null }), []);
});

test('PostgreSQL decimal formatting does not hide an otherwise proven native quantity update', () => {
  const audit = { actor_type: 'system', source: 'netsuite', action: 'netsuite.line.update', order_id: source.netsuiteId,
    line_id: 7, details: { changes: { quantity: { before: '10.000000', after: '11.000000' } } } };
  assert.deepEqual(select({ receipt: null, audits: [audit] }), [quantity]);
});

test('dispatcher split quantities, units and assignment fields stay quiet despite an unrelated matching receipt', () => {
  const changes = [{ field: 'splitQty', lineId: '7', before: 0, after: 5 },
    { field: 'splitUnit', lineId: '7', before: '', after: 'PC' }, { field: 'driverLogin', before: 'old', after: 'new' }];
  assert.deepEqual(select({ changes }), []);
});

test('NetSuite native pickup changes stay visible while allocation, link and CO pickups are quiet', () => {
  const change = { field: 'sourceYard', before: '3445', after: '2967' };
  const moved = { ...source, sourceYard: '2967', raw: { pickup_location: '2967' } };
  assert.deepEqual(select({ source: moved, changes: [change], receipt: { ...receipt, payload: { ...receipt.payload, locationText: '2967' } } }), [change]);
  assert.deepEqual(select({ source: { ...moved, raw: { pickup_location: '3445' } }, changes: [change] }), []);
  assert.deepEqual(select({ source: { ...moved, transitCo: { toYard: '2967' } }, changes: [change] }), []);
});

test('a verified NetSuite destination edit keeps the corresponding yard and address notices', () => {
  const destination = { field: 'destinationLocationId', before: 26, after: 28 };
  const address = { field: 'address', before: 'Old yard address', after: 'New yard address' };
  const old = { ...beforeOrder, type: 'TO', destinationLocationId: 26 };
  const next = { ...source, type: 'TO', destinationLocationId: 28, address: address.after };
  assert.deepEqual(select({ beforeOrder: old, source: next, changes: [destination, address],
    receipt: { ...receipt, payload: { ...receipt.payload, destinationLocationId: 28 } } }), [destination, address]);
});

test('real webhook line keys and fulfilled quantities match the current delivery cargo', () => {
  assert.deepEqual(select({ receipt: { ...receipt, payload: { id: 9979901,
    lines: [{ lineId: 1, lineUniqueKey: 7, itemId: 12, quantity: 15, quantityFulfilled: 4, unit: 'PC' }] } } }), [quantity]);
});

test('property: source proof retains genuine cargo and omits any dispatcher pickup overlay without mutating inputs', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 50 }), fc.constantFrom('12441', '150', '2967'), (q, delta, yard) => {
    const before = { ...beforeOrder, items: [{ ...item, quantity: q }] };
    const next = { ...source, sourceYard: yard, pickupLocations: [yard], items: [{ ...item, quantity: q + delta }] };
    const real = { ...quantity, before: q, after: q + delta };
    const input = { beforeOrder: before, source: next, changes: [real, { field: 'sourceYard', before: '3445', after: yard }],
      receipt: { ...receipt, payload: { id: next.netsuiteId, lines: next.items } } };
    const original = structuredClone(input);
    assert.deepEqual(dispatchSourceNoticeChanges(input), [real]);
    assert.deepEqual(dispatchSourceNoticeChanges({ ...input, receipt: { ...input.receipt, payload: { id: next.netsuiteId, lines: before.items } } }), []);
    assert.deepEqual(input, original);
  }), { seed: 20261012, numRuns: 60 });
});
