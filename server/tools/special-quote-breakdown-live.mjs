import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSpecialQuote } from '../src/special-stock-documents.js';
import { quotePdf } from '../src/field-sales/pdf.js';

// Render the actual quote template in memory without creating any transaction.
const profile = { name: 'Mr Bin Building Supply LTD', taxNumber: '719366486',
  address: '3445 Kennedy Road\nToronto ON M1V 4Y3', phone: '(416) 912-9555',
  taxBps: 1300, validityDays: 30 };
const detail = { requestRef: 'SPREQ-USER-EXAMPLE', revision: 1, customerName: 'sadads',
  customerPhone: 'asdads', requestedByName: 'testAdmin', inquiryDate: '2026-09-30',
  storeName: '3445', fulfillmentMethod: 'vendor_pickup', salesOrderLines: [],
  lines: [[123, 12, 'sadasd'], [23, 22, 'sdas']].map(([quantity, discountPercent, productName], i) => ({
    id: i + 1, productName, quantity, packageQuantity: quantity, rate: 123, originalRate: 123,
    discountPercent, uom: 'PLT', rateUom: 'PLT', palletQty: 0, sectionQty: 0, layerQty: 0, pieceQty: 0 })) };
const quote = buildSpecialQuote(detail, profile, { draft: true, operatorName: 'testAdmin' });
assert.equal(quote.snapshot.grossSubtotalMinor, 1795800);
assert.equal(quote.snapshot.discountMinor, 243786);
assert.equal(quote.snapshot.discountPercent, 13.58);
assert.equal(quote.snapshot.subtotalMinor, 1552014);
assert.equal(quote.snapshot.taxMinor, 201762);
assert.equal(quote.snapshot.totalMinor, 1753776);
const pdf = await quotePdf(quote);
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
console.log(JSON.stringify({ bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
  grossSubtotalMinor: quote.snapshot.grossSubtotalMinor, subtotalMinor: quote.snapshot.subtotalMinor,
  taxMinor: quote.snapshot.taxMinor, totalMinor: quote.snapshot.totalMinor, discountMinor: quote.snapshot.discountMinor,
  discountPercent: quote.snapshot.discountPercent, pdf: pdf.toString('base64') }));
