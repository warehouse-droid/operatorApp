import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialCaseEditDraft, planSpecialCaseEdits } from '../../../public/special-stock-case-edits.js';

const record = () => ({ revision: 2, palletTotal: 0, palletRate: null, lines: [{ id: 10, productName: 'Stone',
  color: 'Grey', size: '80mm', detailSpec: 'Smooth', quantity: 2, packageQuantity: 2, originalRate: 100,
  uom: 'PLT', rateUom: 'PLT', discountPercent: 10, requiredDate: '2099-02-01', customerNote: 'Call first',
  palletQty: 1, layerQty: 2, sectionQty: 3, pieceQty: 4, salesDecision: 'accepted' }] });
const input = patch => ({ lineId: 10, productName: 'Stone', quantity: 2, rate: 100, ...patch });
const plan = (patch, detail = record()) => planSpecialCaseEdits(detail, { lines: [input(patch)] });
const fields = ['color','size','detailSpec','uom','discountPercent','requiredDate','customerNote','palletQty','layerQty','sectionQty','pieceQty'];

test('new line required dates add 14 calendar days across leap days and year boundaries', async () => {
  const { defaultSpecialLineRequiredDate } = await import('../../../public/special-stock-line-fields.js');
  assert.equal(typeof defaultSpecialLineRequiredDate, 'function');
  for (const [today, expected] of [['2026-10-03', '2026-10-17'], ['2026-12-30', '2027-01-13'], ['2028-02-20', '2028-03-05'], ['2026-03-01', '2026-03-15']]) {
    assert.equal(defaultSpecialLineRequiredDate(today), expected);
  }
  fc.assert(fc.property(fc.integer({ min: 0, max: 36524 }), days => {
    const date = new Date(Date.UTC(2000, 0, 1 + days)), today = date.toISOString().slice(0, 10);
    const next = defaultSpecialLineRequiredDate(today);
    assert.equal((Date.parse(next + 'T00:00:00Z') - date.getTime()) / 86400000, 14);
  }), { seed: 202610035, numRuns: 300 });
});
test('SCM required dates are editable and validated while Sales-only price and note fields stay protected', async () => {
  const { changedSpecialLineFields } = await import('../../../public/special-stock-line-fields.js');
  const line = record().lines[0], now = new Date('2026-10-03T16:00:00Z');
  assert.deepEqual(changedSpecialLineFields({ requiredDate: '2099-03-01', rate: 1, discountPercent: 99, customerNote: 'Injected' }, line, { now }), { requiredDate: '2099-03-01' });
  for (const value of ['', '2026-10-02', '2099-02-30', {}, null]) assert.throws(() => changedSpecialLineFields({ requiredDate: value }, line, { now }), error => error.status === 400);
  assert.deepEqual(changedSpecialLineFields({ requiredDate: '2020-01-01' }, { ...line, requiredDate: '2020-01-01' }, { now }), {});
});

test('Sales draft prefills every New Request field without aliasing saved data', () => {
  const detail = record(), draft = specialCaseEditDraft(detail);
  for (const key of fields) assert.equal(draft.lines[0][key], detail.lines[0][key], key);
  draft.lines[0].color = 'Black'; assert.equal(detail.lines[0].color, 'Grey');
});
for (const patch of [{ color: 'Black' }, { size: '90mm' }, { detailSpec: 'Rough' }, { uom: 'LYR' },
  { requiredDate: '2099-03-01' }, { palletQty: 2 }, { layerQty: 3 }, { sectionQty: 4 }, { pieceQty: 5 }]) {
  test(`Sales ${Object.keys(patch)[0]} correction restarts the changed material review`, () => {
    const result = plan(patch); assert.equal(result.restart, true); assert.equal(result.lines.length, 1);
  });
}
test('discount and line-note edits are saved without restarting; clearing fields is meaningful', () => {
  for (const patch of [{ discountPercent: 25 }, { customerNote: 'New note' }, { customerNote: '' }]) {
    const result = plan(patch); assert.equal(result.lines.length, 1); assert.equal(result.restart, false);
  }
  assert.equal(plan({ color: '', size: '', detailSpec: '', palletQty: '' }).restart, true);
});
test('legacy dates and units remain no-ops, while new dates and units are validated', () => {
  const detail = record(); Object.assign(detail.lines[0], { requiredDate: '2020-01-01', uom: 'PC', rateUom: 'PC' });
  assert.deepEqual(plan({ requiredDate: '2020-01-01', uom: 'PC' }, detail), { lines: [], pallet: null, restart: false });
  for (const patch of [{ requiredDate: '2020-01-02' }, { requiredDate: '2099-02-30' }, { requiredDate: '' }, { uom: 'BOX' }]) {
    assert.throws(() => plan(patch), error => error.status === 400);
  }
});
test('added fields reject hostile types, unsafe text, discounts and packing before any plan exists', () => {
  for (const patch of [{ color: {} }, { size: ['large'] }, { detailSpec: 'x'.repeat(2001) }, { customerNote: 'x\u0000y' },
    { discountPercent: 101 }, { discountPercent: -1 }, { discountPercent: 1.00001 }, { discountPercent: true },
    { palletQty: -1 }, { layerQty: Infinity }, { sectionQty: 1e9 + 1 }, { pieceQty: [] }, { uom: null }]) {
    assert.throws(() => plan(patch), error => error.status === 400, JSON.stringify(patch));
  }
});
test('property: field round trips are no-ops and changed discounts preserve the stage', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), fc.integer({ min: 0, max: 10000 }), (discountUnits, packs) => {
    const detail = record(); detail.lines[0].discountPercent = discountUnits / 10000; detail.lines[0].pieceQty = packs;
    const draft = specialCaseEditDraft(detail);
    assert.deepEqual(planSpecialCaseEdits(detail, draft), { lines: [], pallet: null, restart: false });
    const next = (discountUnits + 1) % 1000001 / 10000;
    draft.lines[0].discountPercent = String(next);
    const changed = planSpecialCaseEdits(detail, draft); assert.equal(changed.restart, false); assert.equal(changed.lines.length, 1);
  }), { seed: 20261003, numRuns: 150 });
});

test('property: every normalized material correction restarts exactly when its value changes', () => {
  fc.assert(fc.property(fc.constantFrom('color','size','detailSpec','uom','palletQty','layerQty','sectionQty','pieceQty'),
    fc.integer({ min: 0, max: 1000 }), (field, value) => {
      const detail = record(), before = JSON.stringify(detail);
      const next = field === 'uom' ? ['PLT','LYR','SEC','PCS','EACH','SQFT'][value % 6]
        : ['color','size','detailSpec'].includes(field) ? `Field ${value}` : value;
      const result = plan({ [field]: next }, detail);
      assert.equal(result.restart, next !== detail.lines[0][field]);
      assert.equal(result.lines.length, next !== detail.lines[0][field] ? 1 : 0);
      assert.equal(JSON.stringify(detail), before);
    }), { seed: 202610031, numRuns: 200 });
});


test('fixed unit conversion is absent from all shared line controls and review summaries', async () => {
  const { specialLineFields, specialAdjustmentFieldSummary } = await import('../../../public/special-stock-line-fields.js');
  const form = specialLineFields({ ...record().lines[0], conversionToPc: 4 }, { rateMode: 'fixed', conversion: true });
  assert.equal(form.includes('name="conversionToPc"'), false); assert.equal(form.includes('Pieces per sales UOM'), false);
  const review = specialAdjustmentFieldSummary({ fromConversion: 2, toConversion: 4, fromFields: { color: 'Grey' }, toFields: { color: 'Black' } });
  assert.equal(review.includes('Pieces per sales UOM'), false); assert.match(review, /Colour: Grey → Black/);
});
