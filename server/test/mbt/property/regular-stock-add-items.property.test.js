import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {canAddRegularItems, resetRegularItemReview, regularAddItemsButton} from '../../../public/regular-stock-request-actions.js';

const request = (regular = {}, lines = [{status: 'submitted'}]) => ({requestType: 'regular', status: 'active', regular, lines, transfers: []});
// fast-check also generates null-prototype JSON objects; structuredClone changes
// those prototypes, so preserve them when taking the immutability snapshot.
function copyJson(value) {
  if (Array.isArray(value)) return value.map(copyJson);
  if (!value || typeof value !== 'object') return value;
  return Object.create(Object.getPrototypeOf(value), Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, {...Object.getOwnPropertyDescriptor(value, key), value: copyJson(child)}])));
}
test('eligible requests stay editable until an order, terminal state or workflow lock exists', () => {
  fc.assert(fc.property(fc.constantFrom('pickup', 'stocking', 'delivery'), fc.constantFrom('submitted', 'approved', 'changes_requested'),
    fc.integer({min: 1, max: 100}), (method, status, size) => {
      const original = request({deliveryMethod: method}, Array.from({length: size}, () => ({status})));
      assert.equal(canAddRegularItems(original), true);
      for (const field of ['salesOrderId', 'salesOrderRef', 'handoffStatus', 'pickupTransfer', 'resolution']) {
        assert.equal(canAddRegularItems({...original, regular: {...original.regular, [field]: 'linked'}}), false, field);
      }
      for (const terminal of ['cancelled', 'completed', 'closed']) {
        assert.equal(canAddRegularItems({...original, status: terminal}), false);
      }
      for (const blocked of [{status: 'fulfilled'}, {status: 'converted'}, {status, transferId: 1}, {status, purchase: {demandId: 1}}, {status, resolution: {}}, {status, yardStock: {}}]) {
        assert.equal(canAddRegularItems({...original, lines: [...original.lines, blocked]}), false);
      }
      assert.equal(canAddRegularItems({...original, transfers: [{status: 'creating'}]}), false);
      assert.equal(regularAddItemsButton(original, true).includes('disabled'), size < 100);
    }), {numRuns: 200, seed: 20261027});
  for (const blocked of [null, {}, {...request(), requestType: 'special'}, request({deliveryMethod: 'backorder'}),
    request({deliveryMethod: 'waitlist'}), request({deliveryVersion: 1}), request({}, [])]) {
    assert.equal(canAddRegularItems(blocked), false);
    assert.equal(regularAddItemsButton(blocked, false), '');
  }
});
test('reset clears review markers without mutating details, item stock evidence or conversations', () => {
  fc.assert(fc.property(fc.string(), fc.jsonValue(), fc.array(fc.record({reply: fc.jsonValue(), replyStatus: fc.constantFrom('pending_update', 'pending_scm')}), {maxLength: 20}),
    (customerName, evidence, states) => {
      const original = {customerName, evidence, approvedAt: 'approved', approvalExpiresAt: 'expires', replyStatus: 'pending_update',
        approval: {automatic: true, lines: [evidence]}, stockingLines: Object.fromEntries(states.map((state, id) => [id, state]))};
      const before = copyJson(original), result = resetRegularItemReview(original);
      assert.deepEqual(original, before);
      assert.equal(result.approvedAt, null); assert.equal(result.approvalExpiresAt, null);
      assert.equal(result.replyStatus, null); assert.equal(result.approval.automatic, false);
      assert.deepEqual(result.approval.lines, original.approval.lines);
      assert.equal(result.customerName, customerName); assert.deepEqual(result.evidence, evidence);
      for (const [id, state] of Object.entries(result.stockingLines)) {
        assert.equal(state.replyStatus, null); assert.deepEqual(state.reply, original.stockingLines[id].reply);
      }
    }), {numRuns: 200, seed: 8612026});
  assert.equal(resetRegularItemReview({}).approvedAt, null);
});
