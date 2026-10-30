import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { applyOperatorLinkedQuantityProjection as project, sumActiveLinkedQuantities } from '../../../src/operator-linked-quantity-domain.js';

test('PCS conservation: converted PO and TO links leave the exact sales residual without false blocks', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.boolean(),
    (ticks, po, direct, remaining, recorded) => {
      fc.pre(po + direct + remaining > 0);
      const conversion = ticks / 100;
      const quantity = (po + direct + remaining) * ticks / 100;
      const line = project({ quantity, unit: 'SQFT', to_pcs: conversion, piece_qty: 0 }, {
        linkedPo: { pieces: po, sales: recorded ? po * ticks / 100 : 0 },
        linkedDirectTo: { pieces: direct, sales: recorded ? direct * ticks / 100 : 0 }
      });
      assert.equal(line.linked_quantity_blocked, false);
      assert.equal(line.quantity, remaining * ticks / 100);
      assert.equal(Number((line.quantity + line.linked_allocated_sales_qty).toFixed(6)), Number(quantity.toFixed(6)));
      assert.equal(line.no_yard_load_required, remaining === 0);
    }), { seed: 1076010762, numRuns: 500 });
});

test('PCS excess: every positive converted excess remains blocked in sales units', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }),
    fc.integer({ min: 1, max: 100 }), (ticks, target, excess) => {
      const quantity = target * ticks / 100;
      const line = project({ quantity, unit: 'SQFT', to_pcs: ticks / 100, piece_qty: target + excess }, {
        linkedPo: { pieces: target, sales: 0 }, linkedDirectTo: { pieces: excess, sales: 0 }
      });
      assert.equal(line.linked_quantity_blocked, true);
      assert.equal(line.quantity, 0);
      assert.deepEqual(line.linked_quantity_errors, [{ code: 'LINKED_QUANTITY_EXCEEDS_TARGET',
        unit: 'sales', required: quantity, linked: (target + excess) * ticks / 100 }]);
    }), { seed: 1076210760, numRuns: 500 });
});

test('PCS lifecycle: cancelled links and yard replenishment never consume the sales balance', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 100 }),
    (target, ignored) => {
      const linked = sumActiveLinkedQuantities({ poAllocations: [
        { status: 'active', pieces: 1, sales: 1 }, { status: 'cancelled', pieces: ignored, sales: ignored }
      ], toAllocations: [
        { status: 'cancelled', dependencyMode: 'direct_to_customer', pieces: ignored, sales: ignored },
        { status: 'active', dependencyMode: 'yard_replenishment', pieces: ignored, sales: ignored }
      ] });
      const line = project({ quantity: target, unit: 'EACH', piece_qty: 0 }, linked);
      assert.equal(line.linked_quantity_blocked, false);
      assert.equal(line.quantity, target - 1);
      assert.equal(line.linked_allocated_sales_qty, 1);
    }), { seed: 20261026, numRuns: 300 });
});
