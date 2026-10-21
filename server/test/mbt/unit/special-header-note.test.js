import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeSpecialHeaderNote, canEditSpecialHeader, specialFulfillmentEditor } from '../../../public/special-stock-fulfillment.js';

const active = { closeStatus: 'active', status: 'submitted', stage: 'new_enquiry', fulfillmentMethod: 'yard_pickup', revision: 2 };
const note = '44 Sherwood Ave, Scarborough, ON M1R 1N5\n\n全贴砖方案\n墙砖净面积估算： 约 5,200 sqft\n含 5% 损耗总面积： 5,200 × 1.05 = 5,460 sqft';
test('header Note preserves Chinese, symbols, newlines and whitespace, canonicalizes CRLF and permits clearing', () => {
  assert.equal(normalizeSpecialHeaderNote(note), note);
  assert.equal(normalizeSpecialHeaderNote(' \t' + note.replaceAll('\n', '\r\n') + '\r '), ' \t' + note + '\n ');
  assert.equal(normalizeSpecialHeaderNote(''), '');
  assert.equal(normalizeSpecialHeaderNote('字'.repeat(8000)).length, 8000);
});
test('header Note rejects invalid types, control characters and length overflow without truncation', () => {
  for (const value of [null, undefined, 1, true, {}, [], 'x'.repeat(8001), 'x\0y', 'x\u000by', 'x\u007fy']) {
    assert.throws(() => normalizeSpecialHeaderNote(value), { status: 400, code: 'SPECIAL_HEADER_NOTE_INVALID' });
  }
});
test('header editing uses before-order, closure, review and planning guards', () => {
  assert.equal(canEditSpecialHeader(active), true);
  for (const patch of [{ closeStatus: 'closed' }, { status: 'cancelled' }, { operationallyComplete: true },
    { salesOrderId: 42 }, { purchaseOrderId: 43 }, { salesOrderSkipped: true }, { purchaseOrderSkipped: true },
    { salesOrderOperationStatus: 'creating' }, { purchaseOrderOperationStatus: 'attention' }, { salesOrderSubmissionStartedAt: '2099-01-01' },
    { quantityReviewPending: true }, { fulfillmentChange: { status: 'applying' } }, { attention: true },
    { dispatchPlanning: { anyPlanned: true } }, { dispatchPlanned: true }, { handoff: { status: 'in_progress' } }]) {
    assert.equal(canEditSpecialHeader({ ...active, ...patch }), false, JSON.stringify(patch));
  }
});
test('header renders an always-visible escaped Note and one shared Save header without an Edit note button', () => {
  const html = specialFulfillmentEditor({ ...active, remarks: note + '\n</textarea><script>bad()</script>' });
  assert.match(html, /data-special-header-form/); assert.match(html, /name="expectedRevision"[^>]+value="2"/);
  assert.match(html, /name="remarks"/); assert.match(html, /Save header/); assert.doesNotMatch(html, /Edit note/);
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  const locked = specialFulfillmentEditor({ ...active, closeStatus: 'closed', remarks: note });
  assert.doesNotMatch(locked, /textarea|Save header/); assert.match(locked, /special-header-note-content/); assert.ok(locked.includes(note));
});
const text = fc.array(fc.constantFrom('字', '全', '墙', '×', '5', ' ', '\t', '\n', '&', '<', '>', '"', "'", 'é', '🧱'), { maxLength: 500 }).map(chars => chars.join(''));
test('property: supported Note text is preserved exactly across the full language and symbol alphabet', () => {
  fc.assert(fc.property(text, value => assert.equal(normalizeSpecialHeaderNote(value), value)), { seed: 2026100107, numRuns: 200 });
});
test('property: newline normalization is lossless and idempotent without concatenating lines', () => {
  fc.assert(fc.property(text, value => {
    const windows = value.replaceAll('\n', '\r\n'), normalized = normalizeSpecialHeaderNote(windows);
    assert.equal(normalized, value); assert.equal(normalizeSpecialHeaderNote(normalized), value);
  }), { seed: 2026100108, numRuns: 200 });
});
