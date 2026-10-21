/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { synchronizeSpecialDescriptions } from '../../../src/special-stock-netsuite-adapter.js';
import { matchSpecialOrderCoverage } from '../../../src/special-stock-request-domain.js';

test('property: SCM review changes SO quantity/UOM/description as one exact tuple, preserving sales price and other lines', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), async quantity => {
    const items = [{ line: 3, item: { id: 2055 }, quantity, units: '865', rate: 17, description: 'Old' },
      { line: 4, item: { id: 1784 }, quantity: 11, units: '246', rate: 40, description: 'PALLET' }];
    const change = { caseLineId: 1, remoteLineId: 99, itemId: 2055, previousQuantity: quantity, previousUnitId: 865,
      previousUom: 'PC', previousDescription: 'Old', quantity: quantity + 1, unitId: 873, uom: 'EACH', description: 'Reviewed', rate: 17 };
    const writes = [];
    const dependencies = { queryAll: async () => [{ uniquekey: 99, rest_line_id: 3, item: 2055, execution_quantity: 0, billed_quantity: 0, line_closed: 'F' }],
      rest: async (_path, options = {}) => {
        if (options.method === 'PATCH') { writes.push(options.body); for (const patch of options.body.item.items) Object.assign(items.find(l => l.line === patch.line), patch); }
        return { data: { item: { items: structuredClone(items) } } };
      } };
    await synchronizeSpecialDescriptions({ salesOrderId: 11, changes: [change] }, dependencies);
    assert.deepEqual(items[0], { line: 3, item: { id: 2055 }, quantity: quantity + 1, units: '873', rate: 17, description: 'Reviewed' });
    assert.deepEqual(items[1], { line: 4, item: { id: 1784 }, quantity: 11, units: '246', rate: 40, description: 'PALLET' });
    await synchronizeSpecialDescriptions({ salesOrderId: 11, changes: [change] }, dependencies);
    assert.equal(writes.length, 1);
    items[0].quantity = quantity; // A hybrid is neither the original nor the reviewed tuple.
    await assert.rejects(synchronizeSpecialDescriptions({ salesOrderId: 11, changes: [change] }, dependencies), { code: 'SPECIAL_SO_LINE_CONFLICT' });
  }), { seed: 26092033, numRuns: 40 });
});

test('a webhook recognizes the complete reviewed SO tuple but rejects mixed or unreviewed values', () => {
  const expected = [{ id: 1, remoteLineId: 99, itemId: 2055, quantity: 10, uom: 'PC', description: 'Old' }];
  const target = { expectedLineId: 1, remoteLineId: 99, quantity: 20, uom: 'EACH', description: 'Reviewed' };
  const actual = [{ id: 2, lineId: 99, itemId: 2055, quantity: 20, uom: 'EACH', description: 'Reviewed' }];
  assert.equal(matchSpecialOrderCoverage(expected, actual, { reviewedDescriptionChanges: [target] }).length, 1);
  for (const patch of [{ quantity: 10 }, { uom: 'PC' }, { description: 'Old' }, { quantity: 21 }]) {
    assert.throws(() => matchSpecialOrderCoverage(expected, [{ ...actual[0], ...patch }], { reviewedDescriptionChanges: [target] }), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
  }
});

test('an existing received or closed native PO blocks SO correction before either order is changed', async () => {
  for (const patch of [{ orderStatus: { id: 'H' } }, { received: 1 }, { billed: 1 }, { vendor: '332' }]) {
    const so = { item: { items: [{ line: 3, item: { id: '2055' }, createdPo: { id: '202' }, quantity: 500, units: '865', rate: 17, description: 'Old' }] } };
    let writes = 0;
    const boundary = { queryAll: async () => [{ uniquekey: 99, rest_line_id: 3, item: 2055, execution_quantity: 0, billed_quantity: 0, line_closed: 'F' }],
      rest: async (path, options = {}) => {
        if (options.method === 'PATCH') { writes++; Object.assign(so.item.items[0], options.body.item.items[0]); }
        return { data: path.includes('/salesOrder/') ? structuredClone(so) : {
          createdFrom: { id: '11' }, entity: { id: patch.vendor || '331' }, orderStatus: patch.orderStatus || { id: 'B' },
          item: { items: [{ line: 4, item: { id: '2055' }, quantity: 500, quantityReceived: patch.received || 0, quantityBilled: patch.billed || 0 }] }
        } };
      } };
    await assert.rejects(synchronizeSpecialDescriptions({ salesOrderId: 11, vendorId: 331, changes: [{ itemId: 2055, remoteLineId: 99,
      previousQuantity: 500, quantity: 501, previousUnitId: 865, unitId: 865, previousDescription: 'Old', description: 'Reviewed', rate: 17 }] }, boundary), { code: 'SPECIAL_SO_LINE_CONFLICT' });
    assert.equal(writes, 0); assert.equal(so.item.items[0].quantity, 500);
  }
});

test('SO review waits for an already-pending native PO before saving any SO change', async () => {
  let writes = 0;
  const items = [{ line: 3, item: { id: '2055' }, quantity: 500, units: '865', rate: 17, description: 'Old', createPo: { id: 'SpecOrd' } }];
  await assert.rejects(synchronizeSpecialDescriptions({ salesOrderId: 11, changes: [{ remoteLineId: 99, itemId: 2055,
    previousDescription: 'Old', description: 'Reviewed', quantity: 500, unitId: 865 }] }, {
    queryAll: async () => [{ uniquekey: 99, rest_line_id: 3, item: 2055 }],
    rest: async (_path, options = {}) => { if (options.method === 'PATCH') writes++; return { data: { item: { items: structuredClone(items) } } }; }
  }), { code: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' });
  assert.equal(writes, 0);
});
