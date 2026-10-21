import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb } from '../../../src/db.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { verifyOperatorNetSuitePostingRecord } from '../../../src/operator-netsuite-posting-adapter.js';
import { splitItemFulfillmentPayload } from '../../../src/item-fulfillment-parts-domain.js';

after(closeDb);
const ZERO = { pallets: 0, layers: 0, sections: 0, pieces: 0 };
const fields = { pallets: 'custcol_plt', layers: 'custcol_lyr', sections: 'custcol_sec', pieces: 'custcol_pcs' };
const combinations = [['SO', 'IF', 'customer_pickup'], ['SO', 'IF', 'delivery_prep'],
  ['TO', 'IF', 'delivery_prep'], ['PO', 'IR', 'receiving'], ['TO', 'IR', 'receiving']];

function input(packs = { ...ZERO, layers: 3 }, quantity = 31.38, remaining = 73.22, kind = 'SO', type = 'IF') {
  const functionKey = type === 'IR' ? 'receiving' : kind === 'SO' ? 'customer_pickup' : 'delivery_prep';
  const orderType = { SO: 'sales_order', TO: 'transfer_order', PO: 'purchase_order' }[kind];
  const key = `${functionKey}:${orderType}:1053767`;
  return { requestId: '85d9ae6f-550e-40de-be39-0ac50b548bb0', actorOperatorId: 'test-pack-operator',
    functionKey, transactionType: type, photoRefs: [], localOrderKeys: [key],
    policy: { effective: true, functionKey, transactionType: type, locationId: 28, yardCode: '2967',
      gateKey: 'test-pack-gate', revision: 1 },
    localOperation: { kind: type === 'IR' ? 'receiving_receipt' : kind === 'SO' ? 'customer_pickup_load' : 'delivery_prep_load',
      orderType, orderId: '1053767' },
    targets: [{ sourceOrderKind: kind, sourceNetSuiteId: 1053767, sourceOrderRef: 'SOA10124',
      postingStrategy: 'stored_order_line_v1', selectedLines: [{ orderLine: 1, quantity, location: 28,
        itemId: 4756, sourceLineKey: '5115545', salesUom: 'SQFT', localOrderKey: key, localLineId: '531846',
        ...(packs === undefined ? {} : { packQuantities: packs }) }],
      availableLines: [{ orderLine: 1, sourceLineKey: '5115545', itemId: 4756, salesUom: 'SQFT', location: 28,
        orderedQuantity: remaining, completedQuantity: 0, remainingQuantity: remaining },
      { orderLine: 2, sourceLineKey: '5115546', itemId: 4757, salesUom: 'SQFT', location: 28,
        orderedQuantity: 10.46, completedQuantity: 0, remainingQuantity: 10.46 }] }] };
}

function record(step, custom = { custcol_lyr: 7 }, quantity = step.payload.item.items[0].quantity) {
  return { id: 1053555, tranId: 'IF157565', externalId: step.externalId,
    transactionType: step.transactionType, createdFrom: { id: String(step.sourceNetSuiteId) },
    item: { items: [{ orderLine: 1, itemReceive: true, quantity, unitsDisplay: 'SQFT',
      location: { id: '28' }, item: { id: '4756' }, ...custom }] } };
}

async function resolved(kind = 'SO', _type = 'IF', functionKey = 'customer_pickup', changes = {}, kit = false) {
  const line = { id: 531846, line_id: 5115545, netsuite_order_line: 1, item_id: 4756,
    item_type: 'InvtPart', netsuite_active: true, confirmed: true, unit: 'SQFT', quantity: 73.22,
    location_id: 28, packed_pallet_qty: 0, packed_layer_qty: 3, packed_section_qty: 0, packed_piece_qty: 0,
    packed_sales_qty: 0, fulfilled_layer_qty: 0, to_plt: 104.6, to_lyr: 10.46, to_sec: 0, to_pcs: 0,
    received_pallet_qty: 0, received_layer_qty: 3, received_section_qty: 0, received_piece_qty: 0,
    received_sales_qty: 0, netsuite_received_qty: 0, ...changes };
  const order = { netsuite_id: 1053767, tranid: 'SOA10124', order_type: { SO: 'sales_order', PO: 'purchase_order', TO: 'transfer_order' }[kind],
    delivery_method: functionKey === 'customer_pickup' ? 'Pick-Up' : 'Delivery', outbound_location_id: 28,
    destination_location_id: 28, source_location_id: 28, operator_status: 'packed', lines: [line], receivableLines: [line] };
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => order,
    getReceivableReceivingOrder: async () => order, resolveRealSource: async () => ({ sourceOrderKind: kind,
      sourceNetSuiteId: 1053767, sourceOrderRef: 'SOA10124', postingStrategy: 'stored_order_line_v1',
      ...(kit ? { kitGroups: [] } : {}),
      availableLines: [{ orderLine: 1, sourceLineKey: '5115545', itemId: 4756, salesUom: 'SQFT', location: 28,
        orderedQuantity: 73.22, completedQuantity: 0, remainingQuantity: 73.22 }] }) });
  return resolve({ functionKey, orderId: 1053767, clientLocationId: 28 });
}

test('E1 SOA10124 partial pickup sends 3 LYR and clears inherited unused pack columns', () => {
  const draft = buildOperatorNetSuitePostingDraft(input());
  assert.deepEqual(draft.steps[0].payload.item.items[0], { orderLine: 1, quantity: 31.38,
    itemReceive: true, location: 28, custcol_plt: 0, custcol_lyr: 3, custcol_sec: 0, custcol_pcs: 0 });
  assert.deepEqual(draft.steps[0].payload.item.items[1], { orderLine: 2, itemReceive: false, location: 28 });
  assert.deepEqual(draft.steps[0].lineSnapshot[0].packQuantities, { ...ZERO, layers: 3 });
});

for (const [kind, type, functionKey] of combinations) {
  test(`E2 ${kind} ${type} ${functionKey} captures current confirmed pack quantities`, async () => {
    const result = await resolved(kind, type, functionKey);
    assert.equal(result.targets[0].selectedLines[0].quantity, 31.38);
    assert.deepEqual(result.targets[0].selectedLines[0].packQuantities, { ...ZERO, layers: 3 });
  });
}

test('E2 subsequent fulfillment uses 7 packed minus 4 already fulfilled layers', async () => {
  const result = await resolved('SO', 'IF', 'delivery_prep', { packed_layer_qty: 7, fulfilled_layer_qty: 4 });
  assert.equal(result.targets[0].selectedLines[0].quantity, 31.38);
  assert.deepEqual(result.targets[0].selectedLines[0].packQuantities, { ...ZERO, layers: 3 });
});

test('E2 ordinary lines on a kit-containing source retain their own pack quantities', async () => {
  const result = await resolved('SO', 'IF', 'customer_pickup', {}, true);
  assert.deepEqual(result.targets[0].selectedLines[0].packQuantities, { ...ZERO, layers: 3 });
});

test('E6 invalid optional receipt pack metadata stays absent while accounting remains positive', async () => {
  for (const value of [true, 'invalid', -1, 0.5]) {
    const result = await resolved('PO', 'IR', 'receiving', { received_layer_qty: value, received_piece_qty: 1, to_pcs: 10.46 });
    assert.equal(Object.hasOwn(result.targets[0].selectedLines[0].packQuantities, 'layers'), false);
  }
});

test('E3 multiple local allocations sum pack counts for the same NetSuite line', () => {
  const value = input({ ...ZERO, layers: 1 }, 10.46);
  const first = value.targets[0].selectedLines[0];
  value.targets[0].selectedLines.push({ ...first, localLineId: '531849', quantity: 20.92,
    packQuantities: { ...ZERO, layers: 2 } });
  const draft = buildOperatorNetSuitePostingDraft(value);
  assert.equal(draft.steps[0].payload.item.items[0].custcol_lyr, 3);
  assert.equal(draft.steps[0].payload.item.items[0].quantity, 31.38);
  assert.equal(draft.steps[0].lineSnapshot.length, 2);
});

test('E4 SQFT rounding preserves physical layers and a genuine partial stays partial', () => {
  for (const [kind, type] of [['SO', 'IF'], ['TO', 'IF'], ['PO', 'IR'], ['TO', 'IR']]) {
    const rounded = buildOperatorNetSuitePostingDraft(input({ ...ZERO, layers: 3 }, 31.3802, 31.38, kind, type));
    assert.equal(rounded.steps[0].payload.item.items[0].quantity, 31.38);
    assert.equal(rounded.steps[0].payload.item.items[0].custcol_lyr, 3);
    assert.equal(rounded.steps[0].lineSnapshot[0].quantity, 31.3802);
    const partial = buildOperatorNetSuitePostingDraft(input({ ...ZERO, layers: 3 }, 31.38, 73.22, kind, type));
    assert.equal(partial.steps[0].payload.item.items[0].quantity, 31.38);
    assert.equal(partial.steps[0].payload.item.items[0].custcol_lyr, 3);
  }
});

test('E5 descriptive pack columns never gate an otherwise valid accounting quantity', () => {
  const step = buildOperatorNetSuitePostingDraft(input()).steps[0];
  for (const custom of [{ custcol_lyr: 7 }, {}, { custcol_lyr: null }, { custcol_lyr: 3, custcol_plt: 99 }]) {
    assert.equal(verifyOperatorNetSuitePostingRecord(step, record(step, custom)).id, 1053555);
  }
});

test('E5 a real accounting difference remains blocked even when all pack columns match', () => {
  const step = buildOperatorNetSuitePostingDraft(input()).steps[0];
  for (const actual of [31.39, 73.22]) {
    assert.throws(() => verifyOperatorNetSuitePostingRecord(step, record(step, { custcol_lyr: 3 }, actual)),
      { code: 'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH' });
  }
});

test('E5 legacy selections without pack evidence preserve their original payload', () => {
  const value = input();
  delete value.targets[0].selectedLines[0].packQuantities;
  const step = buildOperatorNetSuitePostingDraft(value).steps[0];
  assert.deepEqual(step.payload.item.items[0], { orderLine: 1, quantity: 31.38, itemReceive: true, location: 28 });
  assert.equal(verifyOperatorNetSuitePostingRecord(step, record(step)).id, 1053555);
});

test('E6 incompatible descriptive values are omitted without changing accounting quantities', () => {
  for (const value of [-1, 0.5, NaN, Infinity, 'invalid', true, Number.MAX_SAFE_INTEGER + 1]) {
    const step = buildOperatorNetSuitePostingDraft(input({ ...ZERO, layers: value })).steps[0];
    assert.equal(step.payload.item.items[0].quantity, 31.38);
    assert.equal(Object.hasOwn(step.payload.item.items[0], 'custcol_lyr'), false);
    assert.equal(step.payload.item.items[0].custcol_plt, 0);
  }
});

test('E6 absent descriptive evidence is tolerated without adding unsafe fields', () => {
  for (const value of [null, 'invalid', [], {}]) {
    const step = buildOperatorNetSuitePostingDraft(input(value)).steps[0];
    assert.equal(step.payload.item.items[0].quantity, 31.38);
    assert.equal(verifyOperatorNetSuitePostingRecord(step, record(step)).id, 1053555);
  }
});

test('E3 an overflow or incomplete allocation omits unprovable counts instead of blocking', () => {
  for (const second of [{ ...ZERO, layers: 1 }, undefined]) {
    const value = input({ ...ZERO, layers: Number.MAX_SAFE_INTEGER }, 10.46);
    const first = value.targets[0].selectedLines[0];
    value.targets[0].selectedLines.push({ ...first, localLineId: '531850', quantity: 20.92,
      ...(second === undefined ? { packQuantities: undefined } : { packQuantities: second }) });
    const step = buildOperatorNetSuitePostingDraft(value).steps[0];
    assert.equal(step.payload.item.items[0].quantity, 31.38);
    assert.equal(Object.hasOwn(step.payload.item.items[0], 'custcol_lyr'), false);
  }
});

test('E2 location splits retain the counts on each selected fulfillment line', () => {
  const step = buildOperatorNetSuitePostingDraft(input()).steps[0];
  step.payload.item.items.push({ orderLine: 3, location: 1, quantity: 10.46, itemReceive: true,
    custcol_plt: 0, custcol_lyr: 1, custcol_sec: 0, custcol_pcs: 0 });
  const parts = splitItemFulfillmentPayload(step.payload);
  assert.equal(parts.find(part => part.locationId === 28).payload.item.items[0].custcol_lyr, 3);
  assert.equal(parts.find(part => part.locationId === 1).payload.item.items[2].custcol_lyr, 1);
});

test('property E1/E3 physical counts are exact for every field and grouped allocation', () => {
  fc.assert(fc.property(fc.constantFrom(...Object.keys(fields)), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: 0, max: 100000 }), (name, left, right) => {
      const value = input({ ...ZERO, [name]: left }, 10.46);
      const first = value.targets[0].selectedLines[0];
      value.targets[0].selectedLines.push({ ...first, localLineId: '531849', quantity: 20.92,
        packQuantities: { ...ZERO, [name]: right } });
      const step = buildOperatorNetSuitePostingDraft(value).steps[0];
      for (const [key, field] of Object.entries(fields)) {
        assert.equal(step.payload.item.items[0][field], key === name ? left + right : 0);
      }
      assert.equal(step.payload.item.items[0].quantity, 31.38);
    }), { seed: 10124, numRuns: 250 });
});

test('property E5 pack discrepancies cannot alter accounting acceptance', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: -9999, max: 9999 }), (expected, actual, micros) => {
      const step = buildOperatorNetSuitePostingDraft(input({ ...ZERO, layers: expected })).steps[0];
      assert.equal(verifyOperatorNetSuitePostingRecord(step,
        record(step, { custcol_lyr: actual }, 31.38 + micros / 1000000)).id, 1053555);
    }), { seed: 10125, numRuns: 250 });
});

test('property E2 local pack fields map exactly for fulfillment deltas and current receipts', async () => {
  await fc.assert(fc.asyncProperty(fc.tuple(...Array.from({ length: 4 }, () => fc.integer({ min: 0, max: 20 }))).filter(counts => counts.some(count => count > 0)),
    async values => {
      const names = ['pallets', 'layers', 'sections', 'pieces'], columns = ['pallet', 'layer', 'section', 'piece'];
      const changes = { to_plt: 0.01, to_lyr: 0.01, to_sec: 0.01, to_pcs: 0.01, packed_sales_qty: 1, received_sales_qty: 1 };
      const expected = {};
      for (const [index, count] of values.entries()) {
        expected[names[index]] = count;
        changes[`packed_${columns[index]}_qty`] = count + 2;
        changes[`fulfilled_${columns[index]}_qty`] = 2;
        changes[`received_${columns[index]}_qty`] = count;
      }
      for (const [kind, type, functionKey] of combinations) {
        const result = await resolved(kind, type, functionKey, changes);
        assert.deepEqual(result.targets[0].selectedLines[0].packQuantities, expected);
      }
    }), { seed: 10126, numRuns: 80 });
});
