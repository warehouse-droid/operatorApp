import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { projectSorOrder } from '../../../src/sor-rental-policy.js';

test('freshness: a normal SO group at 3445 keeps its linked PO and TO pickups', () => {
  const children = ['SO-ONE', 'SO-TWO'].map(id => ({ id, type: 'SO', sourceYard: '3445',
    pickupLocations: ['3445', 'Vendor'], items: [{ itemId: 10374, quantity: 3 }] }));
  const group = { id: 'GO-ONE-TWO', type: 'SO', sourceYard: '3445', sourceAddress: 'Existing yard address',
    pickupLocations: ['3445', 'Vendor', 'TO yard'], childOrderDetails: children,
    items: children.flatMap(child => child.items),
    poPickupManifest: [{ location: 'Vendor' }], directPickupManifest: [{ location: 'TO yard' }] };
  const actual = projectSorOrder(group);
  assert.deepEqual(actual.pickupLocations, group.pickupLocations);
  assert.equal(actual.sourceAddress, group.sourceAddress);
  assert.deepEqual(actual.poPickupManifest, group.poPickupManifest);
});

test('freshness: a rental group retains relationship pickups when its base moves to 3445', () => {
  const children = ['SOR00001', 'SOR00002'].map(id => ({ id, type: 'SO', sourceYard: '2967',
    pickupLocations: ['2967'], items: [{ itemId: 10374, itemName: 'Rental machine / Day', itemType: 'NonInvtPart', quantity: 3 }] }));
  const group = { id: 'GO-RENTAL', type: 'SO', sourceYard: '2967', childOrderDetails: children,
    items: children.flatMap(child => child.items),
    poPickupManifest: [{ location: 'Vendor' }], directPickupManifest: [{ location: 'TO yard' }] };
  const actual = projectSorOrder(group);
  assert.equal(actual.sourceYard, '3445');
  assert.deepEqual(actual.pickupLocations, ['3445', 'Vendor', 'TO yard']);
  assert.deepEqual(actual.childOrderDetails.map(child => child.pickupLocations), [['3445'], ['3445']]);
});

test('freshness: non-rental group pickup facts are preserved for generated linked quantities', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }), quantities => {
    const children = quantities.map((quantity, index) => ({ id: `SO-${index}`, type: 'SO', sourceYard: '3445',
      pickupLocations: ['3445', `Vendor ${index}`], items: [{ itemId: 10374, quantity, poAllocatedSalesQty: quantity / 2 }] }));
    const group = { id: 'GO-NORMAL', type: 'SO', sourceYard: '3445',
      pickupLocations: ['3445', ...quantities.map((_quantity, index) => `Vendor ${index}`)],
      childOrderDetails: children, items: children.flatMap(child => child.items) };
    const before = structuredClone(group), projected = projectSorOrder(group);
    assert.deepEqual(projected.pickupLocations, before.pickupLocations);
    assert.deepEqual(projected.items.map(item => [item.quantity, item.poAllocatedSalesQty]),
      before.items.map(item => [item.quantity, item.poAllocatedSalesQty]));
    assert.deepEqual(projectSorOrder(projected), projected);
    assert.deepEqual(group, before);
  }), { seed: 20261019, numRuns: 150 });
});
