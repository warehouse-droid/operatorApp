/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { specialCaseEditDraft, planSpecialCaseEdits } from '../../../public/special-stock-case-edits.js';

const profile = { name: 'TEST Company', taxBps: 1300 };
const item = (id, salesDecision, quantity = 1, originalRate = 10) => ({ id, productName: 'TEST Material ' + id,
  quantity, packageQuantity: quantity, originalRate, rate: originalRate, uom: 'SQFT', rateUom: 'SQFT', discountPercent: 0, salesDecision });
const detail = () => ({ requestRef: 'TEST-SPREQ-000028', revision: 5, inquiryDate: '2026-10-01', customerName: 'TEST Customer',
  fulfillmentMethod: 'mbt_delivery', deliveryFeeRate: 235, palletTotal: 0, palletRate: null,
  lines: [item(45, 'pending', 120, 22.88), item(46, 'declined', 52, 27.45)], salesOrderLines: [] });

test('SPREQ-000028 quote excludes the declined line with or without a stale saved draft and never leaks notes', () => {
  for (const draft of [false, true]) for (const saved of [false, true]) {
    const d = { ...detail(), fulfillmentMethod: 'yard_pickup', deliveryFeeRate: null, salesInternalRemark: 'PRIVATE HEADER' };
    Object.assign(d.lines[0], { customerNote: 'PRIVATE LINE', salesCustomerNote: 'PRIVATE DECISION' });
    if (saved) d.salesOrderLines = d.lines.map(line => ({ caseLineId: line.id, description: line.productName, quantity: line.quantity, rate: line.originalRate, uom: 'SQFT' }));
    const q = buildSpecialQuote(d, profile, { draft });
    assert.equal(q.snapshot.lines.length, 1); assert.equal(q.snapshot.subtotalMinor, 274560);
    assert.equal(q.snapshot.taxMinor, 35693); assert.equal(q.snapshot.totalMinor, 310253);
    assert.doesNotMatch(JSON.stringify(q), /Material 46|PRIVATE/);
  }
});

test('all declined or closed materials cannot produce a quote containing only charges; undecided legacy lines remain quotable', () => {
  const d = detail(); d.lines = [item(1, 'declined'), item(2, 'closed')]; d.palletTotal = 2; d.palletRate = 40;
  assert.throws(() => buildSpecialQuote(d, profile), { status: 400, code: 'SPECIAL_QUOTE_INVALID' });
  for (const decision of ['accepted', 'pending', undefined]) {
    d.lines = [item(1, decision)]; assert.equal(buildSpecialQuote(d, profile).snapshot.lines.length, 3);
  }
  assert.throws(() => buildSpecialQuote({ ...d, salesOrderId: 1 }, profile), { status: 409 });
});

test('Property: quote eligibility changes only eligible material amounts and includes charges exactly once', () => {
  fc.assert(fc.property(fc.array(fc.record({ decision: fc.constantFrom('accepted', 'pending', 'declined', 'closed'),
    quantity: fc.integer({ min: 1, max: 1000 }), cents: fc.integer({ min: 0, max: 100000 }) }), { minLength: 1, maxLength: 20 }), values => {
    const d = detail(); d.lines = [item(1, 'accepted', 1, 0), ...values.map((v, i) => item(i + 2, v.decision, v.quantity, v.cents / 100))];
    d.palletTotal = 2; d.palletRate = 40;
    const expected = values.filter(v => ['accepted', 'pending'].includes(v.decision)).reduce((sum, v) => sum + v.quantity * v.cents, 31500);
    const q = buildSpecialQuote(d, profile);
    assert.equal(q.snapshot.subtotalMinor, expected); assert.equal(q.snapshot.totalMinor, expected + Math.round(expected * .13));
    assert.equal(q.snapshot.lines.length, 3 + values.filter(v => ['accepted', 'pending'].includes(v.decision)).length);
  }), { seed: 261003, numRuns: 150 });
});

test('one case edit draft includes PALLET and delivery fee, including legacy charges; fee changes do not restart', () => {
  const d = detail(), before = structuredClone(d), draft = specialCaseEditDraft(d);
  assert.equal(draft.deliveryFeeRate, 235); draft.pallet = { quantity: '3', rate: '40' }; draft.deliveryFeeRate = '0';
  assert.deepEqual(planSpecialCaseEdits(d, draft), { lines: [], pallet: { quantity: 3, rate: 40 }, deliveryFeeRate: 0, restart: false });
  assert.deepEqual(d, before);
  assert.deepEqual(planSpecialCaseEdits(d, { deliveryFeeRate: '235.000000' }), { lines: [], pallet: null, restart: false });
  const legacy = { ...d, deliveryFeeRate: null, salesOrderLines: [{ ancillary: true, itemId: 1987, quantity: 2, rate: 25 }] };
  assert.equal(specialCaseEditDraft(legacy).deliveryFeeRate, 50);
  assert.equal(planSpecialCaseEdits(legacy, { deliveryFeeRate: 45 }).deliveryFeeRate, 45);
  const missing = { ...d, deliveryFeeRate: null };
  assert.deepEqual(planSpecialCaseEdits(missing, specialCaseEditDraft(missing)), { lines: [], pallet: null, restart: false });
  assert.deepEqual(planSpecialCaseEdits(missing, { deliveryFeeRate: '' }), { lines: [], pallet: null, restart: false });
  const pickup = { ...d, fulfillmentMethod: 'yard_pickup' };
  assert.equal(Object.hasOwn(specialCaseEditDraft(pickup), 'deliveryFeeRate'), false);
  assert.throws(() => planSpecialCaseEdits(pickup, { fulfillmentMethod: 'mbt_delivery', deliveryFeeRate: 10 }), { status: 400 });
});

test('fee edits reject invalid values and unsafe combined totals but do not double count a replaced saved fee', () => {
  const d = detail();
  for (const deliveryFeeRate of ['', null, true, {}, -1, 1e9 + 1, .1234567, 'NaN']) {
    assert.throws(() => planSpecialCaseEdits(d, { deliveryFeeRate, pallet: { quantity: 2, rate: 40 } }), { status: 400 });
  }
  const huge = { ...d, lines: [item(1, 'accepted', 100000, 797090480)], deliveryFeeRate: 0 };
  assert.throws(() => planSpecialCaseEdits(huge, { deliveryFeeRate: 1e9 }, { taxBps: 1300 }), /too large/);
  const replaced = { ...huge, deliveryFeeRate: 1e9, salesOrderLines: [{ ancillary: true, itemId: 1987, quantity: 1, rate: 1e9 }] };
  assert.equal(planSpecialCaseEdits(replaced, { deliveryFeeRate: 0 }, { taxBps: 1300 }).deliveryFeeRate, 0);
});

test('Property: fee-only edits produce the exact normalized amount without material changes or a restart', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100000000 }), cents => {
    const d = detail(), result = planSpecialCaseEdits(d, { deliveryFeeRate: String(cents / 100) });
    assert.deepEqual(result.lines, []); assert.equal(result.pallet, null); assert.equal(result.restart, false);
    assert.equal(result.deliveryFeeRate, cents === 23500 ? undefined : cents / 100);
  }), { seed: 261004, numRuns: 100 });
});

test('saved note rendering retains all three notes, escapes markup, and omits empty notes and internal header remarks', async () => {
  const { specialLineNotes, specialRequestLineNotes } = await import('../../../public/special-stock-line-notes.js');
  const line = { ...item(1, 'declined'), customerNote: '<img src=x onerror=alert(1)>\nsecond line',
    salesCustomerNote: 'Customer & Sales', salesDecisionReason: 'need full skid' };
  const html = specialLineNotes(line);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/); assert.match(html, /\nsecond line/);
  for (const text of ['Line note', 'Customer note', 'Decision reason', 'need full skid', 'Customer &amp; Sales']) assert.ok(html.includes(text), text);
  assert.equal(specialLineNotes(item(2, 'accepted')), ''); assert.equal(specialRequestLineNotes({ lines: [item(2, 'accepted')] }), '');
  const section = specialRequestLineNotes({ lines: [line, item(2, 'accepted')], salesInternalRemark: 'PRIVATE HEADER' });
  assert.match(section, /TEST Material 1/); assert.doesNotMatch(section, /Material 2|PRIVATE HEADER/);
});
