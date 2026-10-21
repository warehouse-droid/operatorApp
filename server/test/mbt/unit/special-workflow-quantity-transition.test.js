/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { reviewedQuantityTransitions } from '../../../src/special-stock-quantity-reconciliation.js';
import { matchSpecialOrderCoverage } from '../../../src/special-stock-request-domain.js';

function fixture(from = 500, to = 50, kind = 'sales_order') {
  const expected = [{ id: 1, caseLineId: 9, remoteLineId: 91, itemId: 2055, quantity: from, uom: 'PC', description: 'Reviewed' }];
  const review = { mode: 'issued', status: 'applying', remoteStarted: true,
    lines: [{ caseLineId: 9, fromQuantity: from, toQuantity: to, fromPurchaseQuantity: from * 2, toPurchaseQuantity: to * 2, salesUom: 'PC', purchaseUom: 'PC' }],
    plan: { version: 1, orders: [{ kind, id: 101, baseline: [{ line: 1, itemId: 2055, quantity: from, description: 'Reviewed' }],
      changes: [{ caseLineId: 9, remoteLineId: 91, line: 1, toQuantity: to }] }] } };
  if (kind === 'purchase_order') { expected[0].quantity *= 2; review.plan.orders[0].baseline[0].quantity *= 2; review.plan.orders[0].changes[0].toQuantity *= 2; }
  return { expected, review, kind };
}
const transitions = f => reviewedQuantityTransitions(f.review, f.kind, 101, f.expected);

test('property: only the confirmed old or exact target quantity is accepted on each owned order line', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), fc.constantFrom('sales_order', 'purchase_order'), (from, to, kind) => {
    const f = fixture(from, to, kind), alternatives = transitions(f), target = kind === 'sales_order' ? to : to * 2;
    assert.equal(alternatives.length, 1); assert.equal(alternatives[0].quantity, target);
    const row = { id: 2, lineId: 91, itemId: 2055, description: 'Reviewed', uom: 'PC', quantity: target, active: true };
    const options = { reviewedDescriptionChanges: alternatives };
    assert.equal(matchSpecialOrderCoverage(f.expected, [row], options).length, 1);
    for (const changed of [{ ...row, quantity: target + from * 2 + 1 }, { ...row, uom: 'EACH' }, { ...row, description: 'Unreviewed' }, { ...row, itemId: 1784 }, { ...row, lineId: 92 }]) {
      assert.throws(() => matchSpecialOrderCoverage(f.expected, [changed], options), { code: 'SPECIAL_ORDER_COVERAGE_MISMATCH' });
    }
  }), { seed: 260926, numRuns: 100 });
});

test('unconfirmed, completed, malformed or unowned plans cannot relax webhook coverage', () => {
  const mutations = [
    f => { f.review = {}; }, f => { f.review.mode = 'draft'; }, f => { f.review.status = 'pending'; },
    f => { f.review.status = 'rejected'; }, f => { f.review.status = 'approved'; },
    f => { f.review.remoteStarted = false; }, f => { delete f.review.plan; }, f => { f.review.plan.version = 2; },
    f => { f.review.plan.orders[0].id++; }, f => { f.review.plan.orders[0].kind = 'purchase_order'; },
    f => { f.review.plan.orders.push(structuredClone(f.review.plan.orders[0])); },
    f => { f.expected[0].caseLineId++; }, f => { f.expected[0].remoteLineId++; }, f => { f.expected[0].remoteLineId = null; },
    f => { f.expected[0].itemId = 1784; }, f => { f.expected[0].quantity++; }, f => { f.expected[0].uom = 'EACH'; },
    f => { f.review.lines.push(structuredClone(f.review.lines[0])); }, f => { f.review.lines[0].fromQuantity++; },
    f => { f.review.plan.orders[0].changes.push(structuredClone(f.review.plan.orders[0].changes[0])); },
    f => { f.review.plan.orders[0].baseline = []; }, f => { f.review.plan.orders[0].baseline[0].itemId = 1784; },
    f => { f.review.plan.orders[0].baseline[0].description = 'Wrong'; }, f => { f.review.plan.orders[0].changes[0].toQuantity++; },
    ...[0, -1, NaN, 1e9 + 1].map(to => f => { f.review.lines[0].toQuantity = to; f.review.plan.orders[0].changes[0].toQuantity = to; })
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.deepEqual(transitions(f), []); }
  const f = fixture(); f.review.status = 'attention'; assert.equal(transitions(f).length, 1);
});
