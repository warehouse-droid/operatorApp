import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSpecialQuote } from '../src/special-stock-documents.js';
import { quotePdf } from '../src/field-sales/pdf.js';

// Render the actual quote template in memory without creating any transaction.
const profile = { name: 'Mr Bin Building Supply LTD', address: '3445 Kennedy Road, Toronto',
  phone: '416-555-0100', taxBps: 1300, validityDays: 30 };
const detail = { requestRef: 'SPREQ-PACK-SAMPLE', revision: 2, customerName: 'Example Landscaping',
  requestedByName: 'Example Sales', inquiryDate: '2026-09-29', storeName: '3445',
  fulfillmentMethod: 'yard_pickup', salesOrderLines: [],
  lines: [{ id: 10, productName: 'Natural stone coping 建筑材料', color: 'Buff', size: '12 × 24 in',
    quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', rate: 520, originalRate: 520,
    discountPercent: 5, palletQty: 2, sectionQty: 4, layerQty: 3.5, pieceQty: 6 }] };
const quote = buildSpecialQuote(detail, profile);
assert.equal(quote.snapshot.totalMinor, 111644);
assert.equal(quote.snapshot.grossSubtotalMinor, 104000);
assert.equal(quote.snapshot.discountMinor, 5200);
assert.equal(quote.snapshot.discountPercent, 5);
const pdf = await quotePdf(quote);
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
console.log(JSON.stringify({ bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
  totalMinor: quote.snapshot.totalMinor, discountMinor: quote.snapshot.discountMinor,
  discountPercent: quote.snapshot.discountPercent, pdf: pdf.toString('base64') }));
