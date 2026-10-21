/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { buildSpecialQuote, specialOrderSnapshot } from '../../../src/special-stock-documents.js';
import { quotePdf } from '../../../src/field-sales/pdf.js';
import { pdfText, pdfPages } from '../../field-sales/pdf-text.js';
import { specialDocumentActions } from '../../../public/special-stock-documents.js';

const profile = { name: 'Mr Bin Building Supply LTD', address: '3445 Kennedy Road, Toronto', phone: '416-555-0100', taxBps: 1300, validityDays: 30, terms: 'Prices in CAD.' };
const detail = () => ({ id: 62, requestRef: 'SPREQ-000007', revision: 35, requestedByName: 'TEST Sales', inquiryDate: '2026-09-26', customerName: 'TEST Customer 客户', customerPhone: '416-555-0101',
  vendorName: 'TEST Vendor', storeName: '3445', operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', remarks: 'Call before pickup',
  lines: [{ id: 10, productName: 'Endura Coping', color: 'Buff', size: '12 inch', quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', originalRate: 50, rate: 50, discountPercent: 10 }],
  salesOrderLines: [], purchaseOrderLines: [] });
const linked = () => ({ ...detail(), salesOrderId: 101, salesOrderRef: 'SOB121380', purchaseOrderId: 102, purchaseOrderRef: 'POB03934',
  salesOrderStatus: 'Pending Fulfillment', purchaseOrderStatus: 'Pending Receipt',
  salesOrderLines: [{ caseLineId: 10, itemId: 2055, itemName: 'MBBS-Special Order', description: 'Reviewed Coping 建筑材料', quantity: 50, uom: 'PC', rate: 17 }],
  purchaseOrderLines: [{ caseLineId: 10, itemId: 2055, itemName: 'MBBS-Special Order', description: 'Reviewed Coping 建筑材料', quantity: 50, uom: 'PC', rate: null, unitPurchaseCost: 5 }] });

test('property: local quote preserves Sales discounts and rounds tax once on the subtotal', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100 }), (quantity, cents, discount) => {
    const d = detail(); Object.assign(d.lines[0], { quantity, rate: cents / 100, discountPercent: discount });
    const q = buildSpecialQuote(d, profile, { draft: true });
    const gross = BigInt(quantity) * BigInt(cents);
    const amount = gross - (gross * BigInt(discount) + 50n) / 100n;
    const tax = (amount * 1300n + 5000n) / 10000n;
    assert.equal(q.snapshot.subtotalMinor, Number(amount)); assert.equal(q.snapshot.taxMinor, Number(tax));
    assert.equal(q.snapshot.totalMinor, Number(amount + tax));
  }), { seed: 260926, numRuns: 100 });
});

test('saved quote uses saved Sales packages, discounts, descriptions and ancillary charges without SCM costs', async () => {
  const d = detail(); d.salesOrderLines = [{ caseLineId: 10, description: 'Reviewed Coping', quantity: 20, uom: 'PC', rate: 4.5 },
    { ancillary: true, itemId: 1784, description: 'PALLET', quantity: 2, uom: 'EACH', rate: 40 }];
  d.purchaseOrderLines = [{ unitPurchaseCost: 999999, description: 'PRIVATE SCM' }];
  const q = buildSpecialQuote(d, profile, { operatorName: 'Other quote viewer' });
  assert.equal(q.number, 'Q-SPREQ-000007'); assert.equal(q.selected_revision, 35);
  assert.equal(q.snapshot.validUntil, '2026-10-26');
  assert.deepEqual(q.snapshot.lines.map(l => [l.quantity,l.unit,l.unitRate,l.amountMinor]), [['2','PLT','50',9000],['2','EACH','40',8000]]);
  const buffer = await quotePdf(q), text = pdfText(buffer);
  for (const expected of ['Mr Bin Building Supply LTD','Quote','TEST Customer 客户','Reviewed Coping','Discount: 10%','PALLET','170.00','22.10','192.10','TEST Sales']) { assert.ok(text.includes(expected), expected); }
  assert.doesNotMatch(text, /PRIVATE SCM|999999|published to NetSuite/);
  assert.equal(pdfPages(buffer).length, 1);
  if (process.env.SPECIAL_DOCUMENT_OUTPUT) { writeFileSync(`${process.env.SPECIAL_DOCUMENT_OUTPUT}/quote.pdf`, buffer); }
});

test('quotes stay local throughout the request lifecycle and reject missing prices, invalid profiles and unsafe totals', () => {
  const d = detail();
  assert.equal(buildSpecialQuote(d, profile, { draft: true }).number, 'MBBS-QUOTE-DRAFT');
  for (const fulfillmentMethod of ['vendor_pickup','mbt_delivery']) {
    const q = buildSpecialQuote({ ...d, fulfillmentMethod, deliveryAddress: '99 Example Road' }, profile);
    assert.equal(q.snapshot.shippingMethod, fulfillmentMethod === 'mbt_delivery' ? 'Delivery' : 'Pick-Up');
  }
  for (const stage of ['await_po', 'dispatch_arrangement', 'completed', 'closed']) {
    assert.deepEqual(buildSpecialQuote({ ...d, salesOrderId: 101, purchaseOrderId: 102, stage,
      operationallyComplete: stage === 'completed', closeStatus: stage === 'closed' ? 'closed' : 'active' }, profile), buildSpecialQuote(d, profile));
  }
  assert.throws(() => buildSpecialQuote({ ...d, lines: [] }, profile), /priced item/);
  for (const company of [{}, { ...profile, taxBps: -1 }, { ...profile, taxBps: 10001 }, { ...profile, taxBps: 1.1 }]) { assert.throws(() => buildSpecialQuote(d, company), /Configure/); }
  const legacy = detail(); legacy.lines[0].originalRate = null;
  assert.throws(() => buildSpecialQuote(legacy, profile), /required/);
  legacy.salesOrderLines = [{ caseLineId: 10, description: 'Legacy', quantity: 3, uom: 'PC', rate: 10 }];
  assert.equal(buildSpecialQuote(legacy, profile).snapshot.totalMinor, 3390);
  const huge = detail(); Object.assign(huge.lines[0], { packageQuantity: 1e9, originalRate: 1e9 });
  assert.throws(() => buildSpecialQuote(huge, profile), /too large/);
});

test('order snapshot keys change only with displayed local data and preserve audience boundaries', () => {
  const d = linked(), first = specialOrderSnapshot(d, 'sales_order', 'sales', profile);
  assert.deepEqual(specialOrderSnapshot({ ...d, revision: 900, events: [{ secret: 'TEST_PRIVATE' }], updatedAt: 'new' }, 'sales_order', 'sales', profile), first);
  for (const patch of [{ quantity: 51 }, { rate: 18 }, { uom: 'EACH' }, { description: 'Revised' }]) {
    const changed = structuredClone(d); Object.assign(changed.salesOrderLines[0], patch);
    assert.notDeepEqual(specialOrderSnapshot(changed, 'sales_order', 'sales', profile), first);
  }
  for (const patch of [{ customerName: 'New Customer' }, { salesOrderStatus: 'Closed' }, { deliveryAddress: 'New address' }, { quantityReviewPending: true }]) {
    assert.notDeepEqual(specialOrderSnapshot({ ...d, ...patch }, 'sales_order', 'sales', profile), first);
  }
  assert.deepEqual(specialOrderSnapshot(d, 'sales_order', 'sales', { ...profile, address: 'New address' }), first);
  assert.equal(first.source, 'netsuite-native');
  assert.throws(() => specialOrderSnapshot(d, 'purchase_order', 'sales', profile), { status: 403 });
  assert.equal(specialOrderSnapshot(d, 'purchase_order', 'scm', profile).lines[0].rate, 5);
  for (const [kind,audience] of [['bad','sales'],['sales_order','admin']]) { assert.throws(() => specialOrderSnapshot(d, kind, audience, profile)); }
  assert.throws(() => specialOrderSnapshot({ ...d, salesOrderSkipped: true }, 'sales_order', 'sales', profile), { status: 409 });
  assert.throws(() => specialOrderSnapshot({ ...d, purchaseOrderId: null }, 'purchase_order', 'scm', profile), { status: 409 });
});

// Local order-template tests superseded by the native-document correction spec.
test('saved quote stays available alongside linked order PDFs, including completed requests', () => {
  assert.match(specialDocumentActions(detail()), /Preview saved quote/);
  assert.doesNotMatch(specialDocumentActions(linked()), /Preview PO/);
  const html = specialDocumentActions(linked(), 'scm'); assert.match(html, /Preview SO/); assert.match(html, /Preview PO/); assert.match(html, /Preview saved quote/);
  for (const audience of ['sales', 'scm']) {
    const completed = { ...linked(), stage: 'completed', operationallyComplete: true };
    assert.match(specialDocumentActions(completed, audience), /data-special-document="quote" data-case-id="62">Preview saved quote/);
    const quoteOnly = specialDocumentActions(completed, audience, { showOrderPreviews: false });
    assert.match(quoteOnly, /Preview saved quote/); assert.doesNotMatch(quoteOnly, /Preview SO|Preview PO/);
  }
  assert.doesNotMatch(specialDocumentActions({ ...linked(), salesOrderSkipped: true, purchaseOrderSkipped: true }), /Preview SO|Preview PO/);
  assert.ok(specialDocumentActions({ id: '"><script>' }).includes('&lt;script&gt;'));
});
