import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { projectSorOrder } from '../../../src/sor-rental-policy.js';
import { dispatchDependencyOrderRefs } from '../../../src/yard-dependency-structure.js';
import { browserFunctions, sampleCo } from '../../support/goa-co-browser.mjs';

test('GOA CO rental decoration retains its own 2967 to 3445 route and cargo', () => {
  const co = sampleCo();
  const before = structuredClone(co);
  assert.deepEqual(projectSorOrder(co), before);
  assert.deepEqual(co, before);
});

test('GOA CO identity excludes informational sales children and parents', () => {
  assert.deepEqual(dispatchDependencyOrderRefs(sampleCo({ originalOrderId: 'SOA09611' })), ['CO-GOA-9611-9612']);
  const group = { id: 'CO-GOA-1-2', type: 'CO', childOrders: ['CO-SOA00001', 'CO-SOA00002'],
    childOrderDetails: [{ id: 'CO-SOA00001', originalOrderId: 'SOA00001' }] };
  assert.deepEqual(dispatchDependencyOrderRefs(group), ['CO-GOA-1-2', 'CO-SOA00001', 'CO-SOA00002']);
});

test('GOA CO browser normalization retains route and removes source delivery prerequisites', () => {
  const ui = browserFunctions();
  const co = ui.normalizeOrder(sampleCo());
  assert.equal(co.sourceYard, '2967');
  assert.equal(co.destinationYard, '3445');
  assert.deepEqual([...co.pickupLocations], ['2967']);
  assert.deepEqual([...co.orderDependencies], []);
  assert.deepEqual([...co.dependencyLabels], []);
  assert.equal(co.dependencyWaitingForTransfer, false);
  assert.equal(co.dependencyAttention, false);
  assert.equal(ui.replenishmentPlacementBlockMessage(co, {}, { stops: [] }), '');
});

test('GOA CO placement tolerates stale inherited dependencies without weakening a delivery', () => {
  const ui = browserFunctions();
  const co = sampleCo({ orderDependencies: sampleCo().childOrderDetails[0].orderDependencies });
  assert.equal(ui.replenishmentPlacementBlockMessage(co, {}, { stops: [] }), '');
  assert.match(ui.replenishmentPlacementBlockMessage(co.childOrderDetails[0], {}, { stops: [] }), /requires TOB01180/u);
  assert.equal(ui.dispatchOrderMatchesRefs(co, new Set(['SOA09611'])), false);
  assert.equal(ui.dispatchOrderMatchesRefs(co, new Set([co.id])), true);
});

test('GOA CO normalization does not treat a stale transit marker as another prerequisite', () => {
  const ui = browserFunctions();
  const co = ui.normalizeOrder(sampleCo({ transitCo: { id: 'CO-GOA-9611-9612', fromYard: '2967', toYard: '3445' },
    orderDependencies: sampleCo().childOrderDetails[0].orderDependencies,
    dependencyWaitingForTransfer: true, dependencyAttention: true, dependencyUncovered: true,
    dependencyUncoveredQuantity: 10, directPickupManifest: [{ location: '150' }], dependencyDirectPickup: true }));
  assert.equal(co.sourceYard, '2967');
  assert.deepEqual([...co.pickupLocations], ['2967']);
  assert.equal(co.dependencyWaitingForTransfer, false);
  assert.equal(co.dependencyAttention, false);
  assert.equal(co.dependencyDirectPickup, false);
  assert.equal(co.dependencyUncovered, false);
  assert.equal(co.dependencyUncoveredQuantity, 0);
});

test('GOA CO properties: route and identity survive arbitrary source yards, quantities and refreshes', () => {
  const ui = browserFunctions();
  fc.assert(fc.property(fc.constantFrom('2967', '150', '12441'), fc.integer({ min: 1, max: 1000 }), (from, quantity) => {
    const co = sampleCo({ sourceYard: from, pickupLocations: [from], items: [{ itemId: 1244, quantity }], salesQty: quantity });
    const original = structuredClone(co);
    const projected = projectSorOrder(co);
    assert.deepEqual(projected, original);
    assert.deepEqual(dispatchDependencyOrderRefs(projected), [co.id]);
    const normalized = ui.normalizeOrder(projected);
    assert.equal(normalized.sourceYard, from);
    assert.deepEqual([...normalized.pickupLocations], [from]);
    assert.equal(normalized.items[0].quantity, quantity);
    assert.equal(ui.replenishmentPlacementBlockMessage(normalized, {}, { stops: [] }), '');
    const stale = { ...co, orderDependencies: co.childOrderDetails[0].orderDependencies };
    assert.equal(ui.replenishmentPlacementBlockMessage(stale, {}, { stops: [] }), '');
    assert.equal(ui.normalizeReplenishmentDependentInsertIndex(stale, { stops: [] }, 0), 0);
    assert.equal(ui.dispatchOrderMatchesRefs(stale, new Set(['SOA09611'])), false);
    assert.deepEqual([...ui.groupedOrderDependencies([stale])], []);
    assert.equal(ui.normalizeOrder(normalized).sourceYard, from);
  }), { seed: 96119612, numRuns: 100 });
});

test('GOA CO grouped COs retain only CO members, without source delivery requirements', () => {
  const ui = browserFunctions();
  const left = sampleCo({ id: 'CO-SOA00001', childOrders: ['SOA00001'] });
  const right = sampleCo({ id: 'CO-SOA00002', childOrders: ['SOA00002'] });
  const group = { ...sampleCo(), id: 'CO-GOA-1-2', childOrders: [left.id, right.id], childOrderDetails: [left, right] };
  const normalized = ui.normalizeOrder(group);
  assert.deepEqual([...normalized.childOrders], [left.id, right.id]);
  assert.deepEqual([...normalized.orderDependencies], []);
  assert.deepEqual([...ui.groupedOrderDependencies([group])], []);
  assert.equal(ui.dispatchOrderMatchesRefs(group, new Set(['SOA00001'])), false);
  assert.equal(ui.dispatchOrderMatchesRefs(group, new Set([left.id])), true);
  assert.deepEqual(dispatchDependencyOrderRefs(group), [group.id, left.id, right.id]);
});

test('GOA CO sparse and legacy inputs preserve delivery identity and fail closed for a real delivery', () => {
  assert.deepEqual(dispatchDependencyOrderRefs({}), []);
  assert.deepEqual(dispatchDependencyOrderRefs({ tranid: 'CO-SOA00001', childOrders: ['SOA00001'] }), ['CO-SOA00001']);
  assert.deepEqual(dispatchDependencyOrderRefs({ id: 'GOA-1-2', type: 'SO', childOrders: ['SOA00001', 'SOA00002'] }),
    ['GOA-1-2', 'SOA00001', 'SOA00002']);
  const ui = browserFunctions();
  const co = sampleCo({ type: undefined, orderDependencies: sampleCo().childOrderDetails[0].orderDependencies });
  assert.equal(ui.replenishmentPlacementBlockMessage(co, {}, { stops: [] }), '');
  assert.equal(ui.normalizeReplenishmentDependentInsertIndex(co, { stops: [] }, 1), 1);
  const so = { id: 'SOA09611', type: 'SO', orderDependencies: [{ mode: 'yard_replenishment',
    status: 'attention', transferOrderRef: 'TOB01180', attentionReason: 'Review quantities' }] };
  assert.match(ui.replenishmentPlacementBlockMessage(so, {}, { stops: [] }), /Review quantities/u);
  assert.equal(ui.normalizeReplenishmentDependentInsertIndex(so, null, 2), 2);
});
