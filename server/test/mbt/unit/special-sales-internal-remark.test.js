import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeSpecialCaseDraft as normalizeDraft } from '../../../src/special-stock-request-domain.js';
import { specialFulfillmentEditor } from '../../../public/special-stock-fulfillment.js';
import { copySpecialRequestDraft } from '../../../public/special-stock-request-actions.js';
import { projectSpecialStockCase } from '../../../src/special-stock-request-policy.js';
import { buildSpecialQuote, specialOrderSnapshot } from '../../../src/special-stock-documents.js';

const normalizeSpecialCaseDraft = input => normalizeDraft(input, { authorizedStoreLocationIds: [1] });
const draft = { storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Customer', vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  remarks: 'Customer-facing note', lines: [{ productName: 'Stone', quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' }] };
const active = { ...draft, id: 1, closeStatus: 'active', status: 'submitted', stage: 'new_enquiry', revision: 2 };
const secret = 'Internal: call manager\n内部备注 <private> & pricing';
test('Optional internal remark preserves Unicode and whitespace, normalizes newlines and validates without truncation', () => {
  assert.equal(normalizeSpecialCaseDraft(draft).salesInternalRemark, '');
  assert.equal(normalizeSpecialCaseDraft({ ...draft, salesInternalRemark: ' \t' + secret.replaceAll('\n', '\r\n') }).salesInternalRemark, ' \t' + secret);
  assert.equal(normalizeSpecialCaseDraft({ ...draft, salesInternalRemark: '字'.repeat(8000) }).salesInternalRemark.length, 8000);
  for (const value of [null, true, 7, {}, [], 'x'.repeat(8001), '\0', '\u000b', '\u007f']) {
    assert.throws(() => normalizeSpecialCaseDraft({ ...draft, salesInternalRemark: value }), { code: 'SPECIAL_SALES_INTERNAL_REMARK_INVALID', status: 400 });
  }
});
test('Property: internal text is preserved exactly, including empty and multilingual values', () => {
  const text = fc.array(fc.constantFrom('字', ' ', '\t', '\n', '&', '<', '>', '"', "'", 'é', '🧱'), { maxLength: 500 }).map(chars => chars.join(''));
  fc.assert(fc.property(text, value => {
    assert.equal(normalizeSpecialCaseDraft({ ...draft, salesInternalRemark: value }).salesInternalRemark, value);
    assert.equal(normalizeSpecialCaseDraft({ ...draft, salesInternalRemark: value.replaceAll('\n', '\r\n') }).salesInternalRemark, value);
  }), { seed: 20261003, numRuns: 200 });
});
test('Sales remark shares Note row, stays editable after order/planning, and becomes read-only after closure/completion', () => {
  const html = specialFulfillmentEditor({ ...active, salesInternalRemark: secret });
  assert.match(html, /special-request-notes/); assert.match(html, /Sales internal remark/); assert.match(html, /name="salesInternalRemark"/);
  assert.match(html, /&lt;private&gt; &amp;/); assert.doesNotMatch(html, /<private>/);
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  for (const patch of [{ salesOrderId: 9 }, { purchaseOrderId: 10, dispatchPlanning: { anyPlanned: true } }, { stage: 'pending_update' }]) {
    assert.match(specialFulfillmentEditor({ ...active, ...patch, salesInternalRemark: secret }), /name="salesInternalRemark"/);
  }
  for (const patch of [{ closeStatus: 'closed' }, { operationallyComplete: true }, { stage: 'completed' }, { status: 'cancelled' }]) {
    const locked = specialFulfillmentEditor({ ...active, ...patch, salesInternalRemark: secret });
    assert.doesNotMatch(locked, /name="salesInternalRemark"/); assert.match(locked, /Internal: call manager/);
  }
});
test('Internal remark stays in copied request and Sales views but is absent from other audience projections and documents', () => {
  const detail = { ...active, salesInternalRemark: secret, events: [{ details: { before: { salesInternalRemark: secret }, after: { salesInternalRemark: secret } } }] };
  assert.equal(copySpecialRequestDraft(detail).salesInternalRemark, secret);
  assert.equal(projectSpecialStockCase(detail, 'sales').salesInternalRemark, secret);
  for (const audience of ['scm', 'dispatch', 'admin', 'unknown']) assert.doesNotMatch(JSON.stringify(projectSpecialStockCase(detail, audience)), /Internal: call manager/);
  const quote = buildSpecialQuote(detail, { name: 'TEST MBBS', taxBps: 1300 }, { draft: true });
  assert.ok(quote.snapshot.note.includes(draft.remarks)); assert.ok(!JSON.stringify(quote).includes('Internal: call manager'));
  const line = { itemId: 2055, description: 'Stone', quantity: 2, uom: 'PCS', rate: 10 };
  for (const kind of ['sales_order', 'purchase_order']) {
    const snapshot = specialOrderSnapshot({ ...detail, salesOrderId: 1, purchaseOrderId: 2, salesOrderLines: [line], purchaseOrderLines: [line] }, kind, 'scm');
    assert.ok(!JSON.stringify(snapshot).includes('Internal: call manager'));
  }
});
