import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOperatorLinkedQuantityProjection as project } from '../../../src/operator-linked-quantity-domain.js';

const eachLine = (patch = {}) => ({ item_id: 1784, sku: 'PALLET', quantity: 8, unit: 'EACH',
  pallet_qty: 0, layer_qty: 0, section_qty: 0, piece_qty: 0, to_pcs: 0, ...patch });

test('PCS1 EACH zero PCS annotation: one linked out of eight leaves seven unblocked', () => {
  for (const unit of ['EACH', 'ea', 'PC', 'PCS', 'piece', 'PIECES', ' EACH ']) {
    for (const piece_qty of [0, null, undefined]) {
      const source = eachLine({ unit, piece_qty });
      const linked = { linkedPo: { pieces: 1, sales: 1 } };
      const before = structuredClone({ source, linked });
      const line = project(source, linked);
      assert.equal(line.linked_quantity_blocked, false, unit);
      assert.deepEqual(line.linked_quantity_errors, []);
      assert.equal(line.quantity, 7);
      assert.equal(line.original_quantity, 8);
      assert.equal(line.linked_po_sales_qty, 1);
      assert.equal(line.no_yard_load_required, false);
      assert.deepEqual({ source, linked }, before);
    }
  }
});

test('PCS2 convert PCS into SQFT and compare against the sales target', () => {
  for (const piece_qty of [0, 1]) {
    const line = project(eachLine({ quantity: 10, unit: 'SQFT', piece_qty, to_pcs: 2.5 }),
      { linkedPo: { pieces: 2, sales: 5 } });
    assert.equal(line.linked_quantity_blocked, false);
    assert.equal(line.quantity, 5);
    assert.equal(line.linked_allocated_sales_qty, 5);
  }
});

test('PCS2 fully linked converted pieces leave no yard work', () => {
  const line = project(eachLine({ quantity: 10, unit: 'SQFT', to_pcs: 2.5 }),
    { linkedPo: { pieces: 4, sales: 10 } });
  assert.equal(line.linked_quantity_blocked, false);
  assert.equal(line.quantity, 0);
  assert.equal(line.no_yard_load_required, true);
});

test('PCS3 convert legacy PCS-only links from both PO and direct TO without double counting', () => {
  for (const salesRecorded of [true, false]) {
    const line = project(eachLine({ quantity: 20, unit: 'SQFT', to_pcs: 2.5 }), {
      linkedPo: { pieces: 2, sales: salesRecorded ? 5 : 0 },
      linkedDirectTo: { pieces: 3, sales: salesRecorded ? 7.5 : 0 }
    });
    assert.equal(line.linked_quantity_blocked, false);
    assert.equal(line.linked_po_sales_qty, 5);
    assert.equal(line.linked_direct_to_sales_qty, 7.5);
    assert.equal(line.po_allocated_sales_qty, 12.5);
    assert.equal(line.quantity, 7.5);
  }
});

test('PCS3 keep a larger stored sales total that includes other packaging', () => {
  const line = project(eachLine(), { linkedPo: { pieces: 1, sales: 6 } });
  assert.equal(line.linked_quantity_blocked, false);
  assert.equal(line.linked_po_sales_qty, 6);
  assert.equal(line.quantity, 2);
});

test('PCS1 explicit PCS conversion takes precedence over EACH identity', () => {
  const line = project(eachLine({ to_pcs: 2 }), { linkedPo: { pieces: 2, sales: 0 } });
  assert.equal(line.linked_quantity_blocked, false);
  assert.equal(line.linked_po_sales_qty, 4);
  assert.equal(line.quantity, 4);
});

test('PCS4 converted excess is blocked in sales units despite an understated stored total', () => {
  const line = project(eachLine({ quantity: 10, unit: 'SQFT', to_pcs: 2.5 }),
    { linkedPo: { pieces: 5, sales: 1 } });
  assert.equal(line.linked_quantity_blocked, true);
  assert.deepEqual(line.linked_quantity_errors, [
    { code: 'LINKED_QUANTITY_EXCEEDS_TARGET', unit: 'sales', required: 10, linked: 12.5 }
  ]);
});

test('PCS4 unknown conversions, physical-only targets and other package limits remain guarded', () => {
  const unknown = project(eachLine({ unit: 'SQFT' }), { linkedPo: { pieces: 1, sales: 1 } });
  assert.equal(unknown.linked_quantity_blocked, true);
  assert.equal(unknown.linked_quantity_errors[0].unit, 'pieces');
  const physical = project(eachLine({ quantity: 0, piece_qty: 4 }), { linkedPo: { pieces: 2 } });
  assert.equal(physical.linked_quantity_blocked, false);
  assert.equal(physical.piece_qty, 2);
  assert.equal(physical.quantity, 0);
  assert.equal(physical.no_yard_load_required, false);
  const other = project(eachLine({ pallet_qty: 1 }), { linkedPo: { pallets: 2, sales: 2 } });
  assert.equal(other.linked_quantity_blocked, true);
  assert.equal(other.linked_quantity_errors[0].unit, 'pallets');
});

test('PCS4 hostile conversions and overflow fail closed', () => {
  for (const to_pcs of [-1, NaN, Infinity, 'invalid']) {
    assert.throws(() => project(eachLine({ to_pcs }), { linkedPo: { pieces: 1, sales: 1 } }),
      { code: 'LINKED_QUANTITY_INVALID' });
  }
  assert.throws(() => project(eachLine({ unit: 'SQFT', to_pcs: 1e308 }), { linkedPo: { pieces: 2 } }),
    { code: 'LINKED_QUANTITY_INVALID' });
});
