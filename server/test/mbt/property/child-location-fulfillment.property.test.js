import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildOutboundLocationHierarchy } from '../../../src/outbound-location-domain.js';
import { splitItemFulfillmentPayload, fulfillmentInventoryLocations, isMixedLocationRejection } from '../../../src/item-fulfillment-parts-domain.js';

test('Q1 arbitrary active descendants belong to exactly their root regardless of directory order', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 35 }), fc.constantFrom(1, 28, 15, 26), fc.boolean(), (length, root, reverse) => {
    const children = Array.from({ length }, (_, i) => ({ id: 100 + i, parent: i ? 99 + i : root }));
    const rows = [{ id: root }, ...children, { id: 900, parent: 900 }, { id: 901, parent: 999 }];
    const hierarchy = buildOutboundLocationHierarchy(reverse ? rows.reverse() : rows);
    assert.deepEqual(hierarchy.locationsFor(root), [root, ...children.map(row => row.id)].sort((a, b) => a - b));
    for (const child of children) { assert.equal(hierarchy.yardFor(child.id), root); }
    assert.equal(hierarchy.yardFor(900), null); assert.equal(hierarchy.yardFor(901), null);
    children[0].isinactive = 'T';
    const disabled = buildOutboundLocationHierarchy(rows);
    for (const child of children) { assert.equal(disabled.yardFor(child.id), null); }
  }), { seed: 120598, numRuns: 150 });
});

test('Q2 partition conserves every selected REST line exactly once with no location changes', () => {
  fc.assert(fc.property(fc.array(fc.record({ location: fc.constantFrom(1, 14, 140), quantity: fc.integer({ min: 1, max: 100000 }), itemReceive: fc.boolean() }), { minLength: 1, maxLength: 30 }), rows => {
    const payload = { externalId: 'MBBS-Q-120598', item: { items: rows.map((row, i) => ({ ...row, quantity: row.quantity / 100, orderLine: 1 + i * 2 })) } };
    const before = structuredClone(payload), parts = splitItemFulfillmentPayload(payload);
    const selected = payload.item.items.filter(row => row.itemReceive);
    assert.deepEqual(parts.flatMap(part => part.payload.item.items.filter(row => row.itemReceive)).sort((a, b) => a.orderLine - b.orderLine), selected);
    assert.deepEqual(parts.map(part => part.locationId), [...new Set(selected.map(row => row.location))].sort((a, b) => a - b));
    for (const part of parts) {
      assert.deepEqual(fulfillmentInventoryLocations(part.payload), [part.locationId]);
      assert.equal(part.externalId, `${payload.externalId}-L${part.locationId}`);
      assert.equal(part.payload.inventoryLocation.id, String(part.locationId));
      assert.equal(part.payload.item.items.length, rows.length);
      for (const row of part.payload.item.items.filter(row => !row.itemReceive)) { assert.equal(row.quantity, undefined); }
    }
    assert.deepEqual(payload, before);
    assert.deepEqual(splitItemFulfillmentPayload(payload), parts);
  }), { seed: 120598, numRuns: 200 });
});

test('Q3 ambiguous or unrelated errors never authorize a split', () => {
  fc.assert(fc.property(fc.string(), fc.integer({ min: 401, max: 599 }), (message, status) => {
    const error = { status: 400, netsuiteResponseReceived: true, netsuiteErrorDetails: [{ 'o:errorCode': 'USER_ERROR', detail: 'All fulfilled items must have the same location.' }] };
    assert.equal(isMixedLocationRejection(error), true);
    assert.equal(isMixedLocationRejection({ ...error, status }), false);
    assert.equal(isMixedLocationRejection({ ...error, ambiguous: true }), false);
    assert.equal(isMixedLocationRejection({ ...error, netsuiteErrorDetails: [{ 'o:errorCode': 'INSUFFICIENT_PERMISSION', detail: message }] }), false);
  }), { seed: 120598, numRuns: 150 });
});
