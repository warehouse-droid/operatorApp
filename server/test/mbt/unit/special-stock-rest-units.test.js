/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildSpecialSalesOrderPayload, buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { synchronizeSpecialDescriptions } from '../../../src/special-stock-netsuite-adapter.js';
import { prepareSpecialQuantityPlan, applySpecialQuantityPlan } from '../../../src/special-stock-quantity-adapter.js';

const lines = [
  { itemId: 2055, unitId: 865, quantity: 500, rate: 17, unitPurchaseCost: 12, description: 'Special product' },
  { itemId: 1784, unitId: 246, quantity: 11, rate: 40, unitPurchaseCost: 35, description: 'PALLET' }
];
function payloads(items, netsuiteLocationId = 1) {
  return [buildSpecialSalesOrderPayload({ caseId: 62, netsuiteLocationId, pickupMethodId: 1,
    draft: { customerId: 8444, fulfillmentMethod: 'yard_pickup', materialLines: items } }),
  buildSpecialPurchaseOrderPayload({ caseId: 62, vendorId: 331, netsuiteLocationId, lines: items })];
}
test('SPREQ-000007 SO and PO units match the scalar REST contract without changing money or quantities', () => {
  const [so, po] = payloads(lines);
  for (const p of [so, po]) {
    assert.deepEqual(p.item.items.map(l => l.units), ['865', '246']);
    assert.deepEqual(p.item.items.map(l => [l.item.id, l.quantity, l.description]), [['2055', 500, 'Special product'], ['1784', 11, 'PALLET']]);
    assert.match(p.memo, /MBBS-SPECIAL-(?:SO|PO):62$/);
  }
  assert.deepEqual(so.item.items.map(l => l.rate), [17, 40]);
  assert.deepEqual(po.item.items.map(l => l.rate), [12, 35]);
  for (const p of payloads([{ ...lines[0], unitId: undefined }])) assert.equal(Object.hasOwn(p.item.items[0], 'units'), false);
});

function boundary(unitId, reference = false) {
  const unit = n => reference ? { id: String(n) } : String(n);
  const source = [
    { line: 3, item: { id: '2055' }, units: unit(unitId), quantity: 500, rate: 17, description: 'Special product' },
    { line: 8, item: { id: '1784' }, units: unit(246), quantity: 11, rate: 40, description: 'PALLET' }
  ];
  const writes = [];
  const deps = {
    queryAll: async () => [{ uniquekey: 90101, rest_line_id: 3, item: 2055,
      execution_quantity: 0, billed_quantity: 0, line_closed: 'F', status_text: 'Sales Order : Pending Fulfillment' }],
    rest: async (_path, options = {}) => {
      if (options.method === 'PATCH') {
        writes.push(structuredClone(options.body));
        for (const patch of options.body.item.items) Object.assign(source.find(l => l.line === patch.line), patch);
      }
      return { data: { item: { items: structuredClone(source) } } };
    }
  };
  const change = { itemId: 2055, unitId, uom: 'PC', quantity: 500, rate: 17, remoteLineId: 90101,
    caseLineId: 10, previousDescription: 'Special product', description: 'Revised product' };
  const order = { id: 901, kind: 'sales_order', lines: [{ ...change, description: 'Special product', toQuantity: 501 }] };
  return { source, writes, deps, change, order };
}

test('property: SO and PO serialization preserves resolved unit, quantity and rate for numeric and string IDs', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), fc.boolean(), (unitId, quantity, rate, text) => {
    for (const p of payloads([{ ...lines[0], unitId: text ? String(unitId) : unitId, quantity, rate, unitPurchaseCost: rate }])) {
      assert.equal(p.item.items[0].units, String(unitId));
      assert.equal(p.item.items[0].quantity, quantity);
      assert.equal(p.item.items[0].rate, rate);
    }
  }), { seed: 26092026, numRuns: 100 });
});

test('property: description sync accepts REST scalar and reference units and verifies every unit after PATCH', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1e6 }), fc.boolean(), async (unitId, reference) => {
    const f = boundary(unitId, reference);
    const before = structuredClone(f.source);
    await synchronizeSpecialDescriptions({ salesOrderId: 901, changes: [f.change] }, f.deps);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.source, before.map(l => l.line === 3 ? { ...l, description: 'Revised product' } : l));
    await synchronizeSpecialDescriptions({ salesOrderId: 901, changes: [f.change] }, f.deps);
    assert.equal(f.writes.length, 1);
    const corrupt = boundary(unitId, reference);
    const rest = corrupt.deps.rest;
    corrupt.deps.rest = async (path, options = {}) => {
      const result = await rest(path, options);
      if (options.method === 'PATCH') corrupt.source[1].units = reference ? { id: '247' } : '247';
      return result;
    };
    await assert.rejects(synchronizeSpecialDescriptions({ salesOrderId: 901, changes: [corrupt.change] }, corrupt.deps), /verification failed/);
    assert.equal(corrupt.writes.length, 1);
    const conflict = boundary(unitId, reference);
    await assert.rejects(synchronizeSpecialDescriptions({ salesOrderId: 901, changes: [{ ...conflict.change, unitId: unitId + 1 }] }, conflict.deps), /changed in NetSuite/);
    assert.deepEqual(conflict.writes, []);
  }), { seed: 26092027, numRuns: 50 });
});

test('property: quantity plans retain REST scalar and reference units and reject unit conflicts before PATCH', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1e6 }), fc.boolean(), async (unitId, reference) => {
    const f = boundary(unitId, reference);
    const before = structuredClone(f.source);
    const plan = await prepareSpecialQuantityPlan({ orders: [f.order] }, f.deps);
    assert.equal(plan.orders[0].baseline[0].unitId, unitId);
    await applySpecialQuantityPlan(plan, f.deps);
    assert.deepEqual(f.source, before.map(l => l.line === 3 ? { ...l, quantity: 501 } : l));
    await applySpecialQuantityPlan(plan, f.deps);
    assert.equal(f.writes.length, 1);
    const conflict = boundary(unitId, reference);
    conflict.order.lines[0].unitId += 1;
    await assert.rejects(prepareSpecialQuantityPlan({ orders: [conflict.order] }, conflict.deps), { code: 'SPECIAL_QUANTITY_REMOTE_CONFLICT' });
    assert.deepEqual(conflict.writes, []);
  }), { seed: 26092028, numRuns: 50 });
});

test('property: unrelated lines without optional units, rates or descriptions survive both updates', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1e6 }), async unitId => {
    const f = boundary(unitId);
    delete f.source[1].units;
    delete f.source[1].rate;
    delete f.source[1].description;
    const unrelated = structuredClone(f.source[1]);
    await synchronizeSpecialDescriptions({ salesOrderId: 901, changes: [f.change] }, f.deps);
    assert.deepEqual(f.source[1], unrelated);
    f.order.lines[0].description = f.change.description;
    const plan = await prepareSpecialQuantityPlan({ orders: [f.order] }, f.deps);
    assert.equal(plan.orders[0].baseline[1].unitId, null);
    await applySpecialQuantityPlan(plan, f.deps);
    assert.equal(f.source[0].quantity, 501);
    assert.deepEqual(f.source[1], unrelated);
  }), { seed: 26092029, numRuns: 25 });
});

test('property: every material and pallet line carries the resolved order location', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), locationId => {
    for (const payload of payloads(lines, locationId)) {
      assert.equal(payload.location.id, String(locationId));
      assert.deepEqual(payload.item.items.map(line => line.location), [{ id: String(locationId) }, { id: String(locationId) }]);
      assert.deepEqual(payload.item.items.map(line => [line.quantity, line.units]), [[500, '865'], [11, '246']]);
    }
  }), { seed: 26092030, numRuns: 100 });
});
