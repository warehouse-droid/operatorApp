import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { operatorProgressStatus } from '../../../src/operator-order-progress-repository.js';

const open = { operator_status: 'open', local_yard_order_status: 'Open' };
const accountingTypes = ['OthCharge', 'Discount', 'Markup', 'Subtotal', 'Description', 'Payment', 'Service'];
const accountingLines = accountingTypes.map(item_type => ({ item_type, sku: 'Accounting entry' }));
accountingLines.push({ item_type: 'NonInvtPart', sku: 'Delivery Charge - Local' },
  { item_type: 'NonInvtPart', item_name: 'Sales Credit - Hardscaping' });
const cargoTypes = ['InvtPart', 'NonInvtPart', 'Assembly', 'Kit', 'UnrecognizedType', '', null];
const packing = ['packed_pallet_qty', 'packed_layer_qty', 'packed_section_qty', 'packed_piece_qty', 'packed_sales_qty'];

for (const line of accountingLines) {
  test(`${line.sku || line.item_name} (${line.item_type}) cannot establish physical progress`, () => {
    for (const activity of [{ loaded_qty: '2' }, ...packing.map(field => ({ [field]: '3' })),
      { confirmed: true }, { confirmed_at: '2026-10-22T00:00:00Z' }]) {
      assert.equal(operatorProgressStatus(open, [{ item_type: 'InvtPart', loaded_qty: 0 }, { ...line, ...activity }]), 'open');
    }
  });
}

test('real cargo, unknown metadata and inactive historical cargo retain every progress signal', () => {
  for (const item_type of cargoTypes) {
    for (const netsuite_active of [true, false]) {
      const cargo = { item_type, sku: 'MATERIAL', netsuite_active };
      assert.equal(operatorProgressStatus(open, [{ ...cargo, loaded_qty: '0.001' }]), 'loaded');
      for (const field of packing) {
        assert.equal(operatorProgressStatus(open, [{ ...cargo, [field]: '1' }]), 'packed');
      }
      assert.equal(operatorProgressStatus(open, [{ ...cargo, confirmed: true }]), 'packed');
      assert.equal(operatorProgressStatus(open, [{ ...cargo, confirmed_at: '2026-10-22' }]), 'packed');
    }
  }
});

test('header evidence and preparation ownership remain authoritative', () => {
  for (const field of ['operator_status', 'outbound_operator_status', 'local_yard_order_status']) {
    assert.equal(operatorProgressStatus({ ...open, [field]: 'Loaded' }, accountingLines), 'loaded');
  }
  for (const status of ['packed', 'confirmed']) {
    assert.equal(operatorProgressStatus({ ...open, operator_status: status }, accountingLines), 'packed');
  }
  assert.equal(operatorProgressStatus({ ...open, loaded_at: '2026-10-22' }, accountingLines), 'loaded');
  assert.equal(operatorProgressStatus({ ...open, preparing_operator_id: 'operator' }, accountingLines), 'preparing');
  assert.equal(operatorProgressStatus({ ...open, preparing_started_at: '2026-10-22' }, accountingLines), 'preparing');
});

test('property: accounting progress is irrelevant while all cargo and header evidence is conserved', () => {
  fc.assert(fc.property(fc.constantFrom(...cargoTypes), fc.integer({ min: 0, max: 1000 }),
    fc.integer({ min: 0, max: 1000 }), fc.constantFrom('open', 'preparing', 'packed', 'loaded'),
    fc.array(fc.record({ index: fc.integer({ min: 0, max: accountingLines.length - 1 }),
      loaded: fc.integer({ min: 1, max: 1000 }), packed: fc.integer({ min: 1, max: 1000 }) }), { minLength: 1, maxLength: 15 }),
    (item_type, loaded, packed, status, accounting) => {
      const cargo = { item_type, sku: 'MATERIAL', loaded_qty: loaded, packed_sales_qty: packed };
      const header = { ...open, operator_status: status };
      const lines = accounting.map(row => ({ ...accountingLines[row.index], loaded_qty: row.loaded,
        packed_sales_qty: row.packed, confirmed: true }));
      const expected = loaded > 0 || status === 'loaded' ? 'loaded'
        : packed > 0 || status === 'packed' ? 'packed' : status;
      const before = structuredClone({ header, lines, cargo });
      assert.equal(operatorProgressStatus(header, [...lines, cargo]), expected);
      assert.equal(operatorProgressStatus(header, [cargo, ...lines.toReversed()]), expected);
      assert.deepEqual({ header, lines, cargo }, before);
      assert.equal(operatorProgressStatus(open, lines), 'open');
      assert.equal(operatorProgressStatus(open, [{ ...cargo, loaded_qty: 0, packed_sales_qty: 1 }, ...lines]), 'packed');
      assert.equal(operatorProgressStatus({ ...open, operator_status: 'loaded' }, lines), 'loaded');
    }), { seed: 20261022, numRuns: 250 });
});
