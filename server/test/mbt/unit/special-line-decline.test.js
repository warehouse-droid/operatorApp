/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import * as edits from '../../../public/special-stock-case-edits.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';

const detail = () => ({ revision: 3, requestRef: 'TEST-DECLINE', inquiryDate: '2026-10-03', stage: 'wait_for_production', status: 'active',
  lines: [{ id: 10, productName: 'TEST Stone', quantity: 2, packageQuantity: 2, originalRate: 100, discountPercent: 0,
    uom: 'PC', rateUom: 'PC', salesDecision: 'accepted', responseRevision: 4 },
  { id: 11, productName: 'TEST Step', quantity: 1, packageQuantity: 1, originalRate: 50, discountPercent: 0,
    uom: 'PC', rateUom: 'PC', salesDecision: 'pending', responseRevision: 2 }], palletTotal: 0, palletRate: null, salesOrderLines: [] });

test('case editor stages reversible declines separately from material edits without restarting or dropping a line', () => {
  const d = detail(), before = structuredClone(d), draft = edits.specialCaseEditDraft(d);
  assert.deepEqual(draft.decisions, [{ lineId: 10, declined: false }, { lineId: 11, declined: false }]);
  draft.decisions[0].declined = true;
  assert.deepEqual(edits.planSpecialCaseEdits(d, draft), { lines: [], pallet: null, restart: false, decisions: [{ lineId: 10, declined: true }] });
  assert.deepEqual(d, before); assert.equal(draft.lines.length, 2);
  draft.decisions[0].declined = false;
  assert.deepEqual(edits.planSpecialCaseEdits(d, draft), { lines: [], pallet: null, restart: false });
  assert.equal(edits.planSpecialCaseEdits(d, { decisions: [{ lineId: 10, declined: true }], pallet: { quantity: 2, rate: 40 } }).restart, false);
});

test('editing a declined material keeps its staged decline and requires fresh stock review on revoke', () => {
  const d = detail(); d.lines[0].salesDecision = 'declined';
  const draft = edits.specialCaseEditDraft(d); draft.lines[0].quantity = 3;
  const plan = edits.planSpecialCaseEdits(d, draft);
  assert.equal(plan.restart, true); assert.deepEqual(plan.decisions, [{ lineId: 10, declined: true }]);
});

test('decline plans reject foreign, duplicate, closed and hostile decisions while leaving the saved request intact', () => {
  const d = detail(), before = structuredClone(d);
  for (const decisions of [null, {}, [null], [{ lineId: 99, declined: true }], [{ lineId: 10, declined: true }, { lineId: 10, declined: false }],
    ...[true, [10], {}, null, -1, 1.1].map(lineId => [{ lineId, declined: true }]),
    ...['true', 1, null, {}].map(declined => [{ lineId: 10, declined }]), Array.from({ length: 101 }, () => ({ lineId: 10, declined: true }))]) {
    assert.throws(() => edits.planSpecialCaseEdits(d, { decisions }), { status: 400 });
  }
  d.lines[0].salesDecision = 'closed'; assert.throws(() => edits.planSpecialCaseEdits(d, { decisions: [{ lineId: 10, declined: true }] }), { status: 400 });
  d.lines[0].salesDecision = 'accepted'; assert.deepEqual(d, before);
});

test('revoke restores the known previous decision only for the same SCM response; historical declines return to pending', () => {
  assert.equal(typeof edits.revokeSpecialLineDecision, 'function');
  for (const decision of ['accepted', 'pending', 'request_update']) {
    const line = { salesDecision: 'declined', responseRevision: 4, declineRestore: { decision, responseRevision: 4 } };
    assert.equal(edits.revokeSpecialLineDecision(line), decision);
    assert.equal(edits.revokeSpecialLineDecision({ ...line, responseRevision: 5 }), 'pending');
  }
  assert.equal(edits.revokeSpecialLineDecision({ salesDecision: 'declined' }), 'pending');
  assert.equal(edits.revokeSpecialLineDecision({ responseRevision: 1, declineRestore: { decision: 'closed', responseRevision: 1 } }), 'pending');
});

test('stage preservation belongs to one saved revision and cannot override completed, closed, pending-update or issued requests', () => {
  assert.equal(typeof edits.specialCaseStageAfterEdits, 'function');
  const d = { ...detail(), lineEditState: { stage: 'wait_for_production', revision: 3 } };
  assert.equal(edits.specialCaseStageAfterEdits(d, 'await_customer_confirmation'), 'wait_for_production');
  for (const stage of ['closed', 'completed', 'pending_update']) assert.equal(edits.specialCaseStageAfterEdits(d, stage), stage);
  for (const patch of [{ revision: 4 }, { salesOrderId: 1 }, { purchaseOrderId: 2 }, { salesOrderSkipped: true }, { purchaseOrderSkipped: true }, { lineEditState: { stage: 'forged', revision: 3 } }]) {
    assert.equal(edits.specialCaseStageAfterEdits({ ...d, ...patch }, 'await_customer_confirmation'), 'await_customer_confirmation');
  }
});

test('revoked priced materials appear on the quote even if a saved SO draft omitted them', () => {
  const d = detail(); d.salesOrderLines = [{ caseLineId: 10, description: 'TEST Stone', quantity: 2, uom: 'PC', rate: 100 }];
  const q = buildSpecialQuote(d, { name: 'TEST Company', taxBps: 1300 });
  assert.equal(q.snapshot.lines.length, 2); assert.equal(q.snapshot.subtotalMinor, 25000);
  d.lines[1].salesDecision = 'declined'; assert.equal(buildSpecialQuote(d, { name: 'TEST', taxBps: 0 }).snapshot.lines.length, 1);
});

test('Property: decision-only plans preserve all lines, rates and quantities and never restart the enquiry', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 100 }), desired => {
    const d = detail(); d.lines = desired.map((_, i) => ({ ...d.lines[0], id: i + 1, salesDecision: i % 2 ? 'declined' : 'accepted' }));
    const before = structuredClone(d), decisions = desired.map((declined, i) => ({ lineId: i + 1, declined }));
    const plan = edits.planSpecialCaseEdits(d, { decisions });
    assert.deepEqual(plan.decisions || [], decisions.filter((value, i) => value.declined !== Boolean(i % 2)));
    assert.deepEqual(plan.lines, []); assert.equal(plan.restart, false); assert.equal(plan.pallet, null); assert.deepEqual(d, before);
  }), { seed: 26100321, numRuns: 150 });
});
