/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canEditSpecialCaseLines, specialCaseEditDraft, planSpecialCaseEdits } from '../../../public/special-stock-case-edits.js';

const detail = () => ({ id: 1, revision: 3, closeStatus: 'active', stage: 'await_customer_confirmation', status: 'active',
  palletTotal: 3, palletRate: 40, salesOrderLines: [],
  lines: [{ id: 10, productName: 'Stone', quantity: 2, packageQuantity: 2, originalRate: 100, discountPercent: 10, uom: 'PLT',
    color: 'Grey', size: '80mm', detailSpec: 'Smooth', salesDecision: 'accepted', supplyStatus: 'in_stock' },
  { id: 11, productName: 'Step', quantity: 4, packageQuantity: 4, originalRate: 90, discountPercent: 0, uom: 'PCS' }] });
const line = patch => ({ lineId: 10, productName: 'Stone', quantity: 2, rate: 100, ...patch });

test('material name and effective quantity changes restart enquiry, while material rates and PALLET changes preserve progress', () => {
  for (const patch of [{ productName: 'Other stone' }, { quantity: 2.5 }]) {
    const plan = planSpecialCaseEdits(detail(), { lines: [line(patch)] });
    assert.equal(plan.restart, true); assert.equal(plan.lines.length, 1);
  }
  for (const input of [{ lines: [line({ rate: 125 })] }, { pallet: { quantity: 5, rate: 40 } }, { pallet: { quantity: 3, rate: 45 } }]) {
    assert.equal(planSpecialCaseEdits(detail(), input).restart, false);
  }
  assert.equal(planSpecialCaseEdits(detail(), { lines: [line({ productName: 'Other' })], pallet: { quantity: 5, rate: 45 } }).restart, true);
});
test('equivalent names and numeric strings are a no-op, and a reviewed package quantity is the editor quantity', () => {
  assert.deepEqual(planSpecialCaseEdits(detail(), { lines: [line({ productName: ' Stone ', quantity: '2.000', rate: '100.000000' })],
    pallet: { quantity: '3', rate: '40.000000' } }), { lines: [], pallet: null, restart: false });
  const record = detail(); record.lines[0].quantity = 1;
  assert.equal(specialCaseEditDraft(record).lines[0].quantity, 2);
  assert.equal(planSpecialCaseEdits(record, { lines: [line({ rate: 125 })] }).restart, false);
});
test('draft creation keeps PALLET 0 editable, retains a legacy draft PALLET and does not alias saved lines', () => {
  const record = detail(), before = structuredClone(record), draft = specialCaseEditDraft(record);
  assert.equal(draft.expectedRevision, 3); assert.equal(draft.pallet.quantity, 3); assert.equal(draft.pallet.rate, 40);
  draft.lines[0].productName = 'Changed'; assert.deepEqual(record, before);
  assert.equal(specialCaseEditDraft({ ...record, palletTotal: 0 }).pallet.quantity, 0);
  const legacy = specialCaseEditDraft({ ...record, palletTotal: null, palletRate: null,
    salesOrderLines: [{ ancillary: true, itemId: 1784, quantity: 5, rate: 40 }] });
  assert.deepEqual(legacy.pallet, { quantity: 5, rate: 40 });
});
test('PALLET may be removed or free without restarting, and positive PALLET requires a valid rate', () => {
  for (const pallet of [{ quantity: 0, rate: '' }, { quantity: 1, rate: 0 }]) {
    const plan = planSpecialCaseEdits(detail(), { pallet });
    assert.equal(plan.restart, false); assert.equal(plan.pallet.quantity, pallet.quantity);
  }
  for (const pallet of [{ quantity: 1, rate: '' }, { quantity: 1.5, rate: 40 }, { quantity: -1, rate: 40 }, { quantity: 1, rate: -1 }]) {
    assert.throws(() => planSpecialCaseEdits(detail(), { pallet }), error => error.status === 400);
  }
});
test('edits whitelist commercial fields and reject foreign or duplicate IDs, invalid values and monetary overflow', () => {
  const record = detail(), before = structuredClone(record);
  const plan = planSpecialCaseEdits(record, { lines: [line({ rate: 120, supplyStatus: 'no_stock', salesDecision: 'closed', vendorId: 999 })] });
  assert.equal(plan.lines[0].rate, 120); assert.equal(Object.hasOwn(plan.lines[0], 'supplyStatus'), false); assert.deepEqual(record, before);
  for (const lines of [null, [line({ lineId: 99 })], [line(), line()], [line({ productName: '' })], [line({ productName: 'x'.repeat(501) })],
    [line({ quantity: 0 })], [line({ quantity: true })], [line({ rate: -1 })], [line({ rate: 0.1234567 })],
    [line({ quantity: 1e9, rate: 1e9 })], Array.from({ length: 101 }, () => line())]) {
    assert.throws(() => planSpecialCaseEdits(record, { lines }), error => error.status === 400);
  }
});
test('editor is available only before orders and protects completed, closed, submitted or pending operations', () => {
  assert.equal(canEditSpecialCaseLines(detail()), true);
  for (const patch of [{ closeStatus: 'closed' }, { closeStatus: 'closure_pending' }, { salesOrderId: 42 }, { purchaseOrderId: 43 },
    { salesOrderSkipped: true }, { purchaseOrderSkipped: true }, { operationallyComplete: true },
    { salesOrderOperationStatus: 'creating' }, { purchaseOrderOperationStatus: 'attention' },
    { salesOrderSubmissionStartedAt: '2099-01-01' }, { quantityReviewPending: true }, { attention: true }]) {
    assert.equal(canEditSpecialCaseLines({ ...detail(), ...patch }), false);
  }
});
test('hostile ID containers cannot identify a case line through coercion', () => {
  for (const lineId of [[10], { valueOf: () => 10 }, { valueOf: true, toString: true }, true, null]) {
    assert.throws(() => planSpecialCaseEdits(detail(), { lines: [line({ lineId, rate: 120 })] }), error => error.status === 400);
  }
});
test('combined material and PALLET overflow cannot produce an edit plan', () => {
  const record = detail(); record.lines[0].quantity = record.lines[0].packageQuantity = 60000;
  record.lines[0].originalRate = 1e9;
  assert.throws(() => planSpecialCaseEdits(record, { pallet: { quantity: 60000, rate: 1e9 } }), error => error.status === 400);
  record.lines[0].quantity = record.lines[0].packageQuantity = 41000;
  record.lines[0].discountPercent = 0;
  assert.throws(() => planSpecialCaseEdits(record, { pallet: { quantity: 41000, rate: 1e9 } }, { taxBps: 1300 }), error => error.status === 400);
});
test('unchanged unpriced legacy materials do not prevent an independent PALLET edit', () => {
  const record = detail(); record.lines[1].originalRate = null;
  const draft = specialCaseEditDraft(record); draft.pallet.quantity = 5;
  const plan = planSpecialCaseEdits(record, draft);
  assert.deepEqual(plan, { lines: [], pallet: { quantity: 5, rate: 40 }, restart: false });
  assert.throws(() => planSpecialCaseEdits(record, { lines: [{ ...draft.lines[1], productName: 'Changed' }] }), error => error.status === 400);
});
test('property: restart classification depends exactly on normalized material name or quantity, with rates and PALLET independent', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 10000 }),
    fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 10000 }), fc.boolean(),
    (quantity, rate, palletQuantity, palletRate, rename) => {
      const record = detail(), before = JSON.stringify(record), productName = rename ? 'New stone' : 'Stone';
      const plan = planSpecialCaseEdits(record, { lines: [line({ quantity, rate, productName })], pallet: { quantity: palletQuantity, rate: palletRate } });
      assert.equal(plan.restart, rename || quantity !== 2); assert.equal(JSON.stringify(record), before);
      assert.equal(plan.lines.length, rename || quantity !== 2 || rate !== 100 ? 1 : 0);
      assert.equal(Boolean(plan.pallet), palletQuantity !== 3 || palletRate !== 40);
      if (plan.pallet) assert.deepEqual(plan.pallet, { quantity: palletQuantity, rate: palletRate });
    }), { seed: 2026100161, numRuns: 200 });
});
test('property: equal decimal inputs keep the stage and valid fractional case quantities retain the quoted amount', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 0, max: 1000000 }), (quantityMicros, rateMicros) => {
    const record = detail(), quantity = quantityMicros / 1e6, rate = rateMicros / 1e6;
    Object.assign(record.lines[0], { quantity, packageQuantity: quantity, originalRate: rate });
    const plan = planSpecialCaseEdits(record, { lines: [line({ quantity: String(quantity), rate: String(rate), productName: ' Stone ' })] });
    assert.deepEqual(plan, { lines: [], pallet: null, restart: false });
  }), { seed: 2026100162, numRuns: 200 });
});
