/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { verifySpecialRestSalesOrder } from '../../../src/special-stock-rest-orders.js';

function fixture(fee = 235) {
  const materialLines = [99.79, 95.94, 287.82].map((quantity, index) => ({
    itemId: 2055, quantity, rate: 5.98, unitId: 866, description: `Reviewed SQFT ${index}`,
    palletQty: index === 2 ? 3 : 1, layerQty: 0, sectionQty: 0, pieceQty: 0
  }));
  const payload = buildSpecialSalesOrderPayload({ caseId: 106, netsuiteLocationId: 1, deliveryMethodId: 1,
    draft: { customerId: 5409, fulfillmentMethod: 'mbt_delivery', materialLines,
      ancillaryLines: [{ itemId: 1784, quantity: 6, rate: 40, unitId: 246, description: 'PALLET' },
        { itemId: 1987, quantity: 1, rate: fee, description: 'Delivery Charge' }] } });
  const record = { entity: { id: '5409' }, location: { id: '1' }, item: { items: payload.item.items.map((line, index) => ({
    ...structuredClone(line), line: index + 1, lineUniqueKey: String(6000000 + index), isClosed: false
  })) } };
  const writes = [];
  const transport = {
    rest: async (_path, options = {}) => {
      if (options.method && options.method !== 'GET') { writes.push(options); throw Error('Verification must only read'); }
      return { data: structuredClone(record) };
    },
    queryAll: async () => record.item.items.map(line => ({ uniquekey: line.lineUniqueKey, rest_line_id: line.line,
      item: line.item.id, status: 'B', execution_quantity: 0, billed_quantity: 0, line_closed: 'F', ratepercent: null }))
  };
  return { payload, record, transport, writes };
}

test('SPREQ-000030 unitless delivery fee verifies with absent or null units and exact SQFT values', async () => {
  for (const units of [undefined, null]) {
    const f = fixture();
    if (units === undefined) delete f.record.item.items.at(-1).units;
    else f.record.item.items.at(-1).units = units;
    await verifySpecialRestSalesOrder(1041956, f.payload, f.transport);
    assert.deepEqual(f.writes, []);
  }
});

test('true SQFT, commercial, header and line differences still reject a unitless-fee SO', async () => {
  const changes = [
    f => { f.record.item.items[0].units = '865'; },
    f => { delete f.record.item.items[0].units; },
    f => { f.record.item.items[0].quantity = 99.78; },
    f => { f.record.item.items[0].rate = 5.97; },
    f => { f.record.item.items[0].item.id = '999'; },
    f => { f.record.item.items[0].description = 'Changed'; },
    f => { f.record.item.items[0].custcol_plt = 2; },
    f => { f.record.item.items.at(-1).rate = 234; },
    f => { f.record.item.items.at(-1).units = '246'; },
    f => { f.record.item.items.pop(); },
    f => { f.record.entity.id = '5408'; },
    f => { f.record.location.id = '28'; }
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(verifySpecialRestSalesOrder(1041956, f.payload, f.transport), { code: 'SPECIAL_SO_PRICE_CONFLICT' });
    assert.deepEqual(f.writes, []);
  }
});

test('property: unitless fees accept exact orders and still reject every mismatched material UOM or fee rate', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 10000000 }), fc.boolean(), async (cents, referenceUnits) => {
    const f = fixture(cents / 100);
    if (referenceUnits) for (const line of f.record.item.items.slice(0, -1)) line.units = { id: line.units };
    await verifySpecialRestSalesOrder(1041956, f.payload, f.transport);
    const baseline = structuredClone(f.record);
    f.record.item.items[0].units = '865';
    await assert.rejects(verifySpecialRestSalesOrder(1041956, f.payload, f.transport), { code: 'SPECIAL_SO_PRICE_CONFLICT' });
    Object.assign(f.record, baseline);
    f.record.item.items.at(-1).rate += 0.01;
    await assert.rejects(verifySpecialRestSalesOrder(1041956, f.payload, f.transport), { code: 'SPECIAL_SO_PRICE_CONFLICT' });
    assert.deepEqual(f.writes, []);
  }), { seed: 2026100630, numRuns: 100 });
});
